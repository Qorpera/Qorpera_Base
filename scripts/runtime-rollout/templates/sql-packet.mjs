import { FIXED as F, INPUT, MUTATIONS, need, stateAt, stepIndex, validateMigration } from './contract.mjs';

const q = value => `'${String(value).replaceAll("'", "''")}'`;
const list = values => `array[${values.map(q).join(',')}]::text[]`;
const company = q(F.company), environment = q(F.environment);
const policyWhere = "provider='openai' and authentication_mode='native_subscription' and native_harness='codex-cli'";
const headMatched = `(select count(*)=1 from public.qorpera_profiles where id=${company}) and
  (select count(*)=1 from public.qorpera_profile_members where profile_id=${company}) and
  exists(select 1 from public.qorpera_profile_members where profile_id=${company} and user_id=${q(F.owner)} and role='owner') and
  exists(select 1 from public.qorpera_company_files f join public.qorpera_company_snapshots s on s.id=f.head_snapshot_id
    where f.profile_id=${company} and f.environment_id=${environment} and f.state='ready' and f.path_gateway_version=1
      and f.path_index_snapshot_id=f.head_snapshot_id
      and f.head_snapshot_id=${q(F.head)} and s.tree_manifest_sha256=${q(F.tree)} and s.file_count=${F.fileCount} and s.total_bytes=${F.totalBytes})`;
const identityMatched = `exists(select 1 from public.qorpera_member_compute_identities where id=${q(F.identity)}
  and profile_id=${company} and client_identity_id=${q(F.clientIdentity)} and ownership_kind='company' and owner_user_id is null
  and status='active' and encrypted_profile_reference is null and encrypted_overlay_reference is null)`;
const lifecycleMatched = `encode(extensions.digest(convert_to(pg_get_functiondef(
  'public.qorpera_company_computer_lifecycle(uuid,text,text,jsonb)'::regprocedure),'UTF8'),'sha256'),'hex')=${q(F.lifecycleDefinition)}`;
const legacyRetired = `exists(select 1 from public.qorpera_company_computers r join public.qorpera_logical_computers l on l.id=r.logical_computer_id
  where r.id=${q(F.registry)} and r.profile_id=${company} and r.environment_id=${environment} and r.logical_computer_id=${q(F.logical)}
    and r.lifecycle_state='retired' and l.profile_id=${company} and l.status='retired' and l.computer_class='company_computer')`;
const work = Object.freeze({
  jobs: "select count(*) from public.qorpera_runner_jobs where status not in ('completed','failed','cancelled')",
  runs: "select count(*) from public.qorpera_execution_runs as run join public.qorpera_runner_jobs as job on job.id=run.job_id where job.status not in ('completed','failed','cancelled')",
  assignments: "select count(*) from public.qorpera_runner_assignments where status in ('offered','accepted')",
  requests: "select count(*) from public.qorpera_session_turn_requests where status in ('queued','pending_sponsorship')",
  leases: "select count(*) from public.qorpera_native_provider_connection_leases where status='active'",
  receipts: "select count(*) from public.qorpera_run_operation_receipts where status in ('executing','ambiguous')",
  logins: `select count(*) from public.qorpera_native_provider_login_sessions where profile_id=${company} and status='pending'`,
  runners: `select count(*) from public.qorpera_runners where profile_id=${company} and status in ('pending','active')`,
});
const zeroWork = Object.values(work).map(sql => `(${sql})=0`).join(' and ');
const ledger = '(select coalesce(array_agg(version order by version),array[]::text[]) from supabase_migrations.schema_migrations)';
const activeBundle = '(select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton)';
const policy = state => `exists(select 1 from public.qorpera_provider_execution_policies where ${policyWhere}
  and implementation_status='supported' and max_native_concurrency=${F.concurrency}
  and policy_version=${state.paused ? F.policyVersionPaused : F.policyVersionBefore}
  and enablement_status=${q(state.paused ? 'disabled' : F.initialEnablement)}
  and ${state.paused ? `disabled_reason=${q(F.pauseReason)}` : `disabled_reason is not distinct from ${F.initialReason === null ? 'null' : q(F.initialReason)}`})`;
const bundleMatched = state => `${activeBundle}=${q(state.activeBundle)}`;
function migrationRowsMatched(state, existingOnly = false) {
  const rows = INPUT.migrations.filter(row => state.versions.includes(row.version));
  return rows.length ? `not exists(select 1 from (values ${rows.map(row => `(${q(row.version)},${q(row.file.slice(15, -4))},${q(row.sha256)})`).join(',')}) expected(version,name,sha256)
    where ${existingOnly ? 'exists(select 1 from supabase_migrations.schema_migrations present where present.version=expected.version) and ' : ''}not exists(select 1 from supabase_migrations.schema_migrations m where m.version=expected.version and m.name=expected.name
      and cardinality(m.statements)=1 and encode(extensions.digest(convert_to(m.statements[1],'UTF8'),'sha256'),'hex')=expected.sha256))` : 'true';
}
const finalInterfaces = `${activeBundle}=${q(F.bundle)}
  and exists(select 1 from public.qorpera_runtime_bundles where bundle_key='qorpera.cloud-runtime' and version=${F.bundleVersion} and sha256=${q(F.bundle)})
  and exists(select 1 from public.qorpera_runtime_bundles where bundle_key='qorpera.cloud-runtime' and version=${F.previousBundleVersion} and sha256=${q(F.previousBundle)})
  and (select count(*)=1 from public.qorpera_active_runtime_bundle)
  and to_regclass('public.qorpera_wake_occurrences') is not null
  and to_regclass('public.qorpera_company_file_wake_cursors') is not null
  and to_regclass('public.qorpera_company_file_wake_claims') is not null
  and to_regclass('public.qorpera_company_rooms') is not null
  and to_regclass('public.qorpera_company_room_members') is not null
  and to_regclass('public.qorpera_company_execution_pauses') is not null
  and to_regclass('public.qorpera_execution_sponsor_handoffs') is not null
  and to_regclass('public.qorpera_company_responsibilities') is null
  and to_regclass('public.qorpera_responsibility_escalations') is null
  and to_regclass('public.qorpera_native_execution_launch_history') is not null
  and to_regclass('public.qorpera_native_provider_connection_lease_history') is not null
  and to_regprocedure('public.qorpera_read_native_wake(jsonb)') is not null
  and to_regprocedure('public.qorpera_send_coworker_message(jsonb,uuid,text,text)') is not null
  and to_regprocedure('public.qorpera_escalate_responsibility(jsonb,jsonb)') is null
  and to_regprocedure('public.qorpera_manage_agent_routine(jsonb,jsonb)') is not null
  and to_regprocedure('public.qorpera_manage_agent_sidebar(jsonb,jsonb)') is not null
  and to_regprocedure('public.qorpera_self_approve_organization_proposal(jsonb,uuid)') is not null
  and to_regprocedure('public.qorpera_runtime_wake_policy(uuid)') is not null
  and to_regprocedure('public.qorpera_assert_wake_work_allowed(uuid)') is not null
  and to_regprocedure('public.qorpera_assert_wake_completion(uuid)') is not null
  and to_regprocedure('public.qorpera_materialize_wake_execution_runs(integer)') is not null
  and to_regprocedure('public.qorpera_drain_company_file_wakes(integer)') is not null
  and to_regprocedure('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)') is not null
  and to_regprocedure('public.qorpera_list_company_rooms(uuid)') is not null
  and to_regprocedure('public.qorpera_set_company_execution_pause(uuid,boolean,text)') is null
  and to_regprocedure('public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint)') is null
  and to_regprocedure('public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint)') is null
  and to_regclass('public.qorpera_company_execution_ceilings') is null
  and to_regclass('public.qorpera_company_ceiling_trips') is null
  and to_regclass('public.qorpera_company_machine_limits') is null
  and to_regprocedure('public.qorpera_set_company_machine_limit(uuid,integer,bigint)') is null
  and to_regprocedure('public.qorpera_consent_provider_connection_autonomous(uuid,uuid,boolean)') is not null
  and to_regprocedure('public.qorpera_ensure_default_agent_read_grants(uuid,uuid)') is not null
  and exists(select 1 from information_schema.columns where table_schema='public' and table_name='qorpera_company_path_grants' and column_name='origin')
  and exists(select 1 from information_schema.columns where table_schema='public' and table_name='qorpera_wake_occurrences' and column_name='wake_kind')
  and not exists(select 1 from pg_indexes where schemaname='public' and indexname='qorpera_native_company_execution_start_once')
  and exists(select 1 from pg_trigger where tgname='qorpera_native_company_execution_start_once')
  and exists(select 1 from pg_trigger where tgname='qorpera_profile_staff_default_read')
  and exists(select 1 from pg_trigger where tgname='qorpera_company_path_resources_default_read')
  and not exists(select 1 from public.qorpera_company_bootstrap_jobs where state in ('queued','leased'))
  and exists(select 1 from pg_roles where rolname='qorpera_secret_broker' and not rolsuper and not rolinherit
    and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls)
  and (select count(*)=0 from information_schema.role_table_grants where grantee='qorpera_secret_broker')
  and (select count(*)=0 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='qorpera_secret_broker')
  and (select count(*)=3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl,'{}'::aclitem[])) a join pg_roles r on r.oid=a.grantee
    where n.nspname='public' and r.rolname='qorpera_secret_broker' and a.privilege_type='EXECUTE')`;

export function readbackSQL(step, state = stateAt(step)) {
  stepIndex(step);
  return `select jsonb_build_object(
  'schema','qorpera.production-rollout-database-readback/v1','step',${q(step)},
  'projectRef',${q(F.project)},'companyId',${company},'environmentId',${environment},'sourceCommit',${q(F.commit)},'runtimeBundleSha256',${q(F.bundle)},
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'database',current_database(),'executorRole',current_user,'ledgerVersions',to_jsonb(${ledger}),
  'policy',(select jsonb_build_object('provider',provider,'authenticationMode',authentication_mode,'nativeHarness',native_harness,
    'implementation',implementation_status,'enablement',enablement_status,'maxConcurrency',max_native_concurrency,'version',policy_version,
    'pauseReasonMatched',coalesce(disabled_reason=${q(F.pauseReason)},false),
    'initialReasonMatched',disabled_reason is not distinct from ${F.initialReason === null ? 'null' : q(F.initialReason)}) from public.qorpera_provider_execution_policies where ${policyWhere}),
  'headAndOwnerMatched',(${headMatched}),'identityMatched',(${identityMatched}),
  'legacyState',case when (${legacyRetired}) then 'retired' else null end,
  'activeBundle',${activeBundle},
  'globalWork',jsonb_build_object(${Object.entries(work).map(([name, sql]) => `${q(name)},(${sql})`).join(',')}),
  'historicalLedgerVersionsRetained',${ledger} @> ${list(INPUT.productionOnly)},
  'migrationRowsMatched',(${migrationRowsMatched(stateAt('final-readback'), true)}),
  'lifecycleDefinitionMatched',(${lifecycleMatched}),
  'finalInterfacesMatched',${step === 'final-readback' ? `(${finalInterfaces})` : 'false'},
  'admissionReopened',false,'productionReady',false
) as readback;\n`;
}
const settings = `set local statement_timeout='40s';
set local lock_timeout='2s';
set local idle_in_transaction_session_timeout='12s';
set local transaction_timeout='50s';
set local client_min_messages='error';\n`;
function guardedState(state) {
  return `do $rollout_guard$
begin
  if current_database()<>'postgres' or current_user not in ('postgres','supabase_admin')
    or current_setting('server_version_num')::integer not between 170000 and 179999 then
    raise exception 'DEPLOYMENT_IDENTITY_REJECTED' using errcode='42501'; end if;
  if ${ledger} is distinct from ${list(state.versions)} or not (${migrationRowsMatched(state)}) then
    raise exception 'LEDGER_PRESTATE_REJECTED' using errcode='55000'; end if;
  if not (${headMatched}) or not (${identityMatched}) or not (${legacyRetired}) then
    raise exception 'TARGET_PRESTATE_REJECTED' using errcode='55000'; end if;
  if not (${policy(state)}) then raise exception 'POLICY_PRESTATE_REJECTED' using errcode='55000'; end if;
  if not (${bundleMatched(state)}) then raise exception 'BUNDLE_PRESTATE_REJECTED' using errcode='55000'; end if;
  if not (${zeroWork}) then raise exception 'DRAIN_PRESTATE_REJECTED' using errcode='55000'; end if;
  if not (${lifecycleMatched}) then raise exception 'LIFECYCLE_DEFINITION_REJECTED' using errcode='55000'; end if;
end $rollout_guard$;\n`;
}
const locks = `lock table supabase_migrations.schema_migrations in exclusive mode;
lock table public.qorpera_profiles,public.qorpera_profile_members,public.qorpera_company_files,public.qorpera_company_snapshots,
  public.qorpera_company_computers,public.qorpera_logical_computers,public.qorpera_member_compute_identities,
  public.qorpera_provider_execution_policies,public.qorpera_runner_jobs,public.qorpera_execution_runs,
  public.qorpera_runner_assignments,public.qorpera_session_turn_requests,public.qorpera_native_provider_connection_leases,
  public.qorpera_run_operation_receipts,public.qorpera_native_provider_login_sessions,public.qorpera_runners,
  public.qorpera_active_runtime_bundle in share row exclusive mode;\n`;

export function buildSQL(step, migrationBytes = null) {
  stepIndex(step);
  if (!MUTATIONS.includes(step)) return `begin transaction isolation level repeatable read read only;\n${settings}${readbackSQL(step)}rollback;\n`;
  let body;
  if (step === 'pause') body = `do $pause$
declare before_policy public.qorpera_provider_execution_policies%rowtype; after_policy public.qorpera_provider_execution_policies%rowtype;
begin
  select * into strict before_policy from public.qorpera_provider_execution_policies where ${policyWhere} for update;
  perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli','supported','disabled',${F.concurrency},${q(F.pauseReason)},before_policy.commercial_reference);
  select * into strict after_policy from public.qorpera_provider_execution_policies where ${policyWhere};
  if after_policy.commercial_reference is distinct from before_policy.commercial_reference
    or after_policy.updated_by_user_id is distinct from before_policy.updated_by_user_id then
    raise exception 'UNRELATED_POLICY_FIELD_CHANGED' using errcode='55000'; end if;
end $pause$;\n`;
  else {
    const row = INPUT.migrations.find(value => value.version === step); validateMigration(row, migrationBytes);
    const statements = migrationBytes.toString('utf8');
    need(!/^\s*(?:begin|commit|rollback|start\s+transaction)\s*;/im.test(statements), 'SOURCE_TRANSACTION_ESCAPE_REJECTED');
    body = `${statements}\ninsert into supabase_migrations.schema_migrations(version,name,statements)
values(${q(row.version)},${q(row.file.slice(15, -4))},array[convert_from(decode(${q(migrationBytes.toString('hex'))},'hex'),'UTF8')]);\n`;
  }
  return `begin transaction isolation level serializable;\n${settings}${locks}${guardedState(stateAt(step, false))}
-- The surrounding executor must be the existing deployment administrator, never a human member or broker.
set local request.jwt.claims='{"role":"service_role"}';
${body}${guardedState(stateAt(step))}commit;
begin transaction isolation level repeatable read read only;
${settings}${readbackSQL(step)}rollback;\n`;
}
export function reconciliationSQL(step) {
  need(MUTATIONS.includes(step), 'RECONCILIATION_STEP_REJECTED');
  return `begin transaction isolation level repeatable read read only;\n${settings}${readbackSQL(step)}rollback;\n`;
}
