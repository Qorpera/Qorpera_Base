-- Company folder core, C1c-2a: a folder-v2 run's tool calls on the folder fence (RUNTIME-COMPANY-FOLDER-C1C.md §5).
--
-- Changes only folder-v2 behaviour: every dispatch below is false for snapshot-v1 companies, whose function text after
-- the inserted line stays byte-identical (test 647 pins a digest of each). No real folder-v2 run exists yet (C1C §7).
-- * The run check every runtime tool call makes (qorpera_native_tool_locked_run) sends folder-v2 to
--   qorpera_folder_tool_run: the run mutex (the run's budget row, before the job), then the folder run entry with the
--   company row KEY SHARE, and plain lease checks. No job FOR UPDATE, no gc fence, no NOWAIT (§5.1-§5.3).
-- * The lease check and the wake check the runtime also calls directly dispatch to their folder-v2 bodies (§5.4).
-- * qorpera_company_run_actor is the new actor entry point. It takes none of the run check's locks (for a wake run,
--   the lease check's sponsor test still takes the provider connection FOR SHARE); the legacy actor keeps refusing
--   folder-v2 (§2). Its callers that read are switched to it; the context assertion decides by the company's core.
-- * The office, the organization self-approval and machine start refuse folder-v2 until C1c-3; the legacy sends,
--   receipts, the interaction request and the transcript append refuse it until C1c-2b gives them folder bodies, so no
--   folder-v2 path takes the job and then the budget row (§5.9).
-- * Every folder function reads the stop through qorpera_company_execution_paused, which counts deletions (§5.5).

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

-- Inserts one statement at the start of a PL/pgSQL body, after its first line that is only "begin": before any lock the
-- function takes. The function must be PL/pgSQL, and the statement must not be there yet.
create function pg_temp.c1c2_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-2a guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-2a guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-2a guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
-- Replaces exact text of a definition, exactly p_count times.
create function pg_temp.c1c2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-2a patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The stop check (C1C §5.5) -----------------------------------------------------------------------------------

-- Deletion inserts the pause row too, except when the requester's account is gone; the helper reads both. The pause and
-- resume functions keep reading the pause row itself.
do $$
declare c_old constant text := 'exists (select 1 from public.qorpera_company_execution_pauses where profile_id = ';
begin
	perform pg_temp.c1c2_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid)',
		c_old || 'v_file.profile_id)', 'public.qorpera_company_execution_paused(v_file.profile_id)', 3);
	perform pg_temp.c1c2_replace('public.qorpera_folder_read_actor(uuid,jsonb)',
		c_old || 'v_profile)', 'public.qorpera_company_execution_paused(v_profile)', 1);
	perform pg_temp.c1c2_replace('public.qorpera_folder_record_release(uuid,jsonb,uuid,jsonb,text)',
		c_old || 'v_file.profile_id)', 'public.qorpera_company_execution_paused(v_file.profile_id)', 1);
	perform pg_temp.c1c2_replace('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)',
		c_old || 'v_file.profile_id)', 'public.qorpera_company_execution_paused(v_file.profile_id)', 1);
	perform pg_temp.c1c2_replace('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)',
		c_old || 'p_profile_id)', 'public.qorpera_company_execution_paused(p_profile_id)', 1);
end $$;

-- 3. The folder run entry with caller targets (C1C §5.3) ---------------------------------------------------------

-- A four-argument overload with no default, so the three-argument calls stay unambiguous. The caller's targets are
-- validated as the commit validates its own (20260929230000 step 4): rank 0 is only this company's row, KEY SHARE;
-- ranks 6 and 7 are KEY SHARE only. A run entry locks ranks 0 to 7; vault rows and unique-key claims (8, 9) are the
-- commit's. They merge with the run's own targets (the stronger mode wins) and are locked in rank order.
create function public.qorpera_folder_run_enter(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_targets jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resolved jsonb; v_fence bigint; v_targets jsonb;
begin
	if p_actor ->> 'kind' is distinct from 'run' or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_targets) is distinct from 'array' or exists (select 1 from jsonb_array_elements(p_targets) t
		where jsonb_typeof(t) <> 'object' or coalesce(t ->> 'rank', '') !~ '^[0-7]$' or t ->> 'tbl' is null or t ->> 'key' is null
			or coalesce(t ->> 'mode', '') not in ('keyshare','share','nokeyupdate','update')
			or (t ->> 'rank' = '0') <> (t ->> 'tbl' = 'qorpera_profiles')
			or (t ->> 'tbl' = 'qorpera_profiles' and (t ->> 'mode' <> 'keyshare' or t ->> 'key' <> p_profile_id::text))
			or (t ->> 'rank' in ('6','7') and t ->> 'mode' <> 'keyshare')) then
		raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	if public.qorpera_company_execution_paused(p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_runner_jobs where id = (p_actor ->> 'jobId')::uuid and run_id = (p_actor ->> 'runId')::uuid
	for key share;
	if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	select revision into v_fence from public.qorpera_folder_fences where profile_id = p_profile_id for key share;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_resolved := public.qorpera_folder_run_resolve(p_environment_id, p_profile_id, p_actor);
	v_targets := coalesce(v_resolved -> 'lockTargets', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('rank', 1,
		'tbl', 'qorpera_profile_members', 'key', p_profile_id::text || ':' || (v_resolved ->> 'requesterUserId'),
		'mode', 'keyshare', 'required', true)) || p_targets;
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 0::smallint, 0::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 1::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 6::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 7::smallint);
	return (v_resolved - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', v_fence);
end $$;
-- The three-argument entry (releases, views) is the same with no caller targets.
create or replace function public.qorpera_folder_run_enter(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_folder_run_enter(p_environment_id, p_profile_id, p_actor, '[]'::jsonb);
end $$;

-- 4. The native lease, checked without locks (C1C §5.3 step 5) ---------------------------------------------------

-- The legacy lease check without its three FOR SHARE: the same tuple, expiry, connection, capsule, policy, sponsor and
-- compute checks, built from the live definition so the two cannot drift apart.
do $$
declare v_definition text := pg_get_functiondef(
	'public.qorpera_validate_native_provider_execution_lease_before_recover(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure);
	c_name constant text := 'FUNCTION public.qorpera_validate_native_provider_execution_lease_before_recover(';
begin
	if (length(v_definition) - length(replace(v_definition, c_name, ''))) / length(c_name) <> 1
		or (length(v_definition) - length(replace(v_definition, E'\n\tfor share;', ''))) / length(E'\n\tfor share;') <> 3 then
		raise exception 'C1c-2a lease check anchor changed'; end if;
	v_definition := replace(replace(v_definition, c_name, 'FUNCTION public.qorpera_folder_native_lease_current('),
		E'\n\tfor share;', ';');
	if v_definition ~* 'for (update|share|no key update|key share)' then
		raise exception 'C1c-2a lease check still locks'; end if;
	execute v_definition;
end $$;

-- The folder-v2 body of qorpera_validate_native_provider_execution_lease: the stored tuple matched as a plain read (the
-- legacy lock selector), the stop, the compute identity's recovery generation, then the lease itself.
create function public.qorpera_folder_validate_native_lease(p_lease_id uuid, p_run_id uuid, p_job_id uuid, p_runner_id uuid,
	p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid, p_provider text, p_native_harness text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() is distinct from 'service_role' and session_user <> 'qorpera_secret_broker' then
		raise exception 'native host authority is required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_runner_jobs job
		join public.qorpera_execution_runs run on run.id = job.run_id and run.job_id = job.id
		join public.qorpera_native_provider_connection_leases lease on lease.job_id = job.id and lease.run_id = run.id
		join public.qorpera_member_compute_identities identity on identity.id = run.compute_identity_id and identity.profile_id = run.profile_id
		where job.id = p_job_id and run.id = p_run_id and job.runner_id = p_runner_id
			and job.client_lease_id = p_assignment_id and lease.id = p_lease_id
			and lease.runner_id = p_runner_id and lease.assignment_id = p_assignment_id
			and lease.credential_capsule_id = p_credential_capsule_id
			and lease.compute_identity_id = p_compute_identity_id and identity.id = p_compute_identity_id) then
		raise exception 'native execution binding is unavailable' using errcode = '42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id;
	if not found then raise exception 'native identity is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_identity.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	if v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or not exists (select 1 from public.qorpera_execution_runs where id = p_run_id and compute_identity_id = v_identity.id
			and compute_recovery_epoch = v_identity.recovery_epoch)
		or not exists (select 1 from public.qorpera_runners where id = p_runner_id and compute_identity_id = v_identity.id
			and compute_recovery_epoch = v_identity.recovery_epoch) then
		raise exception 'native execution generation is fenced for recovery' using errcode = '42501'; end if;
	return public.qorpera_folder_native_lease_current(p_lease_id, p_run_id, p_job_id, p_runner_id, p_assignment_id,
		p_credential_capsule_id, p_compute_identity_id, p_provider, p_native_harness)
		|| jsonb_build_object('compute_identity_epoch', v_identity.recovery_epoch);
end $$;

-- 5. The folder-v2 run check (C1C §5.2, §5.3) --------------------------------------------------------------------

-- The binding's shape, as the legacy run check reads it. Raises 42501 without host authority and 22023 for a malformed
-- binding; returns the folder run actor with normalized ids.
create function public.qorpera_folder_native_actor(p_binding jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' and session_user <> 'qorpera_secret_broker' then
		raise exception 'native tool host authority is required' using errcode = '42501';
	end if;
	if jsonb_typeof(p_binding) is distinct from 'object'
		or p_binding - array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId',
			'computeIdentityId','provider','nativeHarness','model'] <> '{}'::jsonb
		or not (p_binding ?& array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId',
			'computeIdentityId','provider','nativeHarness','model'])
		or exists (select 1 from jsonb_each(p_binding) as field where jsonb_typeof(field.value) <> 'string')
		or p_binding ->> 'provider' is distinct from 'openai'
		or p_binding ->> 'nativeHarness' is distinct from 'codex-cli' then
		raise exception 'native tool binding is invalid' using errcode = '22023';
	end if;
	return jsonb_build_object('kind', 'run', 'runId', (p_binding ->> 'runId')::uuid::text,
		'jobId', (p_binding ->> 'jobId')::uuid::text, 'runnerId', (p_binding ->> 'runnerId')::uuid::text,
		'assignmentId', (p_binding ->> 'assignmentId')::uuid::text);
end $$;

-- The checks the legacy run check makes after its locks, without locks: the lease, the runner's job lease, and the
-- run's model and kind. Returns the run row.
create function public.qorpera_folder_native_run_current(p_binding jsonb)
returns public.qorpera_execution_runs language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_session_token_sha256 text; v_lease_token_sha256 text;
begin
	perform public.qorpera_folder_validate_native_lease(
		(p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid, (p_binding ->> 'jobId')::uuid,
		(p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid,
		p_binding ->> 'provider', p_binding ->> 'nativeHarness');
	select runner.session_token_sha256 into strict v_session_token_sha256
	from public.qorpera_runners as runner where runner.id = (p_binding ->> 'runnerId')::uuid;
	select job.lease_token_sha256 into strict v_lease_token_sha256
	from public.qorpera_runner_jobs as job where job.id = (p_binding ->> 'jobId')::uuid;
	v_job := public.qorpera_runner_broker_job((p_binding ->> 'runnerId')::uuid, v_session_token_sha256,
		(p_binding ->> 'jobId')::uuid, v_lease_token_sha256);
	select run.* into strict v_run from public.qorpera_execution_runs as run
	where run.id = v_job.run_id and run.id = (p_binding ->> 'runId')::uuid;
	if v_job.status <> 'leased'
		or v_run.model_provider is distinct from p_binding ->> 'provider'
		or v_run.model_id is distinct from p_binding ->> 'model'
		or v_run.job_type <> 'agent_turn' or v_run.required_capability <> 'agent_turn'
		or v_run.deadline_at <= clock_timestamp() or v_job.lease_expires_at <= clock_timestamp()
		or not exists (
			select 1 from public.qorpera_native_provider_connection_leases as lease
			join public.qorpera_runner_assignments as assignment on assignment.id = lease.assignment_id
			join public.qorpera_runners as runner on runner.id = lease.runner_id
			where lease.id = (p_binding ->> 'leaseId')::uuid
				and lease.status = 'active' and lease.expires_at > clock_timestamp()
				and assignment.status = 'accepted' and assignment.expires_at > clock_timestamp()
				and runner.status = 'active' and runner.session_expires_at > clock_timestamp()
		) then
		raise exception 'native tool run is unavailable' using errcode = '42501';
	end if;
	return v_run;
end $$;

-- The folder-v2 run check under every runtime tool call. In order: the binding (host authority, keys, provider); the
-- stop as a plain read; the run mutex (the budget row FOR UPDATE, before the job, so a second tool call of the run
-- waits here and never queues a KEY SHARE on the job beside a waiting completion); the folder run entry with the
-- caller's targets and this company's row at rank 0 (the job and fence KEY SHARE, the stop re-read, the run resolve
-- with its wake authority, ranks 0 to 7); then the lease, the job lease and the run's model, as plain reads after
-- every wait. Returns the run actor, the resolved actor and the run row.
create function public.qorpera_folder_tool_run(p_binding jsonb, p_targets jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_folder_native_actor(p_binding); v_file public.qorpera_company_files%rowtype;
	v_targets jsonb := coalesce(p_targets, '[]'::jsonb); v_resolved jsonb; v_run public.qorpera_execution_runs%rowtype;
begin
	if jsonb_typeof(v_targets) <> 'array' then raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	select file.* into v_file from public.qorpera_runner_jobs job
	join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
	where job.id = (v_actor ->> 'jobId')::uuid and job.run_id = (v_actor ->> 'runId')::uuid;
	if not found then raise exception 'native tool run is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_file.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_execution_run_budgets where run_id = (v_actor ->> 'runId')::uuid for update;
	if not found then raise exception 'native tool run is unavailable' using errcode = '42501'; end if;
	v_resolved := public.qorpera_folder_run_enter(v_file.environment_id, v_file.profile_id, v_actor,
		v_targets || jsonb_build_array(jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles',
			'key', v_file.profile_id::text, 'mode', 'keyshare', 'required', true)));
	v_run := public.qorpera_folder_native_run_current(p_binding);
	return jsonb_build_object('actor', v_actor, 'resolved', v_resolved, 'run', to_jsonb(v_run));
end $$;

-- 6. The actor entry point, without the run check's locks (C1C §2, §5.3) -----------------------------------------

-- snapshot-v1: the legacy actor, unchanged. folder-v2, a run: the plain folder resolve and the plain lease checks (whose
-- only lock, for a wake run, is the provider connection FOR SHARE of the sponsor test, as in the run check); the
-- callers that lock run the run check first (every caller with a binding but presence). folder-v2, a member: a plain
-- membership read. Both return the legacy field names callers read, plus core and the folder actor.
create function public.qorpera_company_run_actor(p_environment_id uuid, p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_actor jsonb; v_resolved jsonb;
	v_run public.qorpera_execution_runs%rowtype; v_user uuid; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core is distinct from 'folder-v2' then
		return public.qorpera_company_path_actor(p_environment_id, p_binding);
	end if;
	if p_binding is null then
		v_user := auth.uid();
		if auth.role() is distinct from 'authenticated' or v_user is null then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
		if not exists (select 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_user) then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		v_actor := jsonb_build_object('kind', 'member', 'userId', v_user);
		return jsonb_build_object('companyId', v_file.profile_id, 'environmentId', p_environment_id, 'userId', v_user,
			'staffAgentId', null, 'runId', null, 'jobId', null, 'assignmentId', null, 'sponsorBindingId', null,
			'sponsorVersion', null, 'audience', 'human', 'audienceUserId', v_user,
			'runtimeBundleId', v_bundle.runtime_bundle_id, 'runtimeBundleSha256', v_bundle.runtime_bundle_sha256,
			'core', 'folder-v2', 'folder', jsonb_build_object('actor', v_actor, 'resolved', v_actor));
	end if;
	v_actor := public.qorpera_folder_native_actor(p_binding);
	if public.qorpera_company_execution_paused(v_file.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_resolved := public.qorpera_folder_run_resolve(p_environment_id, v_file.profile_id, v_actor) - 'lockTargets' - 'attribution';
	v_run := public.qorpera_folder_native_run_current(p_binding);
	if v_run.environment_id <> p_environment_id then
		raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('companyId', v_file.profile_id, 'environmentId', p_environment_id,
		'userId', v_run.requested_by_user_id, 'staffAgentId', v_run.staff_agent_id, 'runId', v_run.id, 'jobId', v_run.job_id,
		'assignmentId', p_binding ->> 'assignmentId', 'sponsorBindingId', v_run.sponsor_binding_id,
		'sponsorVersion', v_run.sponsor_version, 'audience', v_run.audience_kind, 'audienceUserId', v_run.audience_user_id,
		'runtimeBundleId', v_run.runtime_bundle_id, 'runtimeBundleSha256', v_run.runtime_bundle_sha256,
		'core', 'folder-v2', 'folder', jsonb_build_object('actor', v_actor, 'resolved', v_resolved));
end $$;

-- Presence routes for folder-v2 (C1C §5.4): the legacy token shape (prefix, resource, its version, the membership
-- fingerprint and the live grants), with the folder resolver deciding what the actor reads. A retained token must not
-- identify new activity after access narrows: legacy gives the resource a new version on every change, the folder core
-- bumps its authority revision instead, so the token hashes that too. A refusal is 42501, which
-- qorpera_native_presence_subject reads as absent.
create function public.qorpera_folder_presence_routes(p_actor jsonb, p_paths text[], p_require_target boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_secret bytea; v_path text; v_prefix text; v_parts text[]; v_index integer;
	v_routes jsonb; v_result jsonb := '[]'::jsonb; v_env uuid := (p_actor ->> 'environmentId')::uuid;
	v_profile uuid := (p_actor ->> 'companyId')::uuid; v_resolved jsonb := p_actor -> 'folder' -> 'resolved';
	v_resource public.qorpera_company_path_resources%rowtype; v_grants jsonb; v_members jsonb;
begin
	if jsonb_typeof(v_resolved) is distinct from 'object' or v_profile is distinct from
		(select profile_id from public.qorpera_company_files where environment_id = v_env and core = 'folder-v2') then
		raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if not public.qorpera_presence_paths_valid(p_paths) then raise exception 'Invalid presence paths' using errcode = '22023'; end if;
	insert into public.qorpera_company_presence_secrets(environment_id) values (v_env) on conflict do nothing;
	select secret into strict v_secret from public.qorpera_company_presence_secrets where environment_id = v_env;
	select coalesce(jsonb_agg(jsonb_build_array(m.user_id, m.role, m.joined_at, coalesce(r.version, 0)) order by m.user_id), '[]')
	into v_members from public.qorpera_profile_members m
	left join public.qorpera_runtime_browser_membership_revocations r on r.profile_id = m.profile_id and r.user_id = m.user_id
	where m.profile_id = v_profile;
	foreach v_path in array p_paths loop
		if p_require_target and not public.qorpera_folder_actor_allowed(v_env, v_profile, v_resolved, v_path, 'read') then
			raise exception 'Company File path is unavailable' using errcode = '42501'; end if;
		v_parts := string_to_array(v_path, '/'); v_routes := '[]'::jsonb;
		for v_index in 0..cardinality(v_parts) loop
			v_prefix := case when v_index = 0 then '' else array_to_string(v_parts[1:v_index], '/') end;
			if public.qorpera_folder_actor_allowed(v_env, v_profile, v_resolved, v_prefix, 'read') then
				v_resource := public.qorpera_folder_path_resource(v_env, v_prefix);
				select coalesce(jsonb_agg(jsonb_build_array(g.id, g.permissions, g.expires_at) order by g.id), '[]') into v_grants
				from public.qorpera_company_path_grants g where g.resource_id = v_resource.id and g.resource_version = v_resource.version
					and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp());
				v_routes := v_routes || jsonb_build_array(jsonb_build_object('path', v_prefix, 'token', encode(
					extensions.hmac(convert_to(jsonb_build_array(v_prefix, v_resource.id, v_resource.version,
						v_resource.authority_revision, v_members, v_grants)::text, 'utf8'),
						v_secret, 'sha256'), 'hex')));
			end if;
		end loop;
		v_result := v_result || jsonb_build_array(jsonb_build_object('path', v_path, 'routes', v_routes));
	end loop;
	return v_result;
end $$;

revoke all on function public.qorpera_folder_run_enter(uuid,uuid,jsonb,jsonb),
	public.qorpera_folder_native_lease_current(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text),
	public.qorpera_folder_validate_native_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text),
	public.qorpera_folder_native_actor(jsonb), public.qorpera_folder_native_run_current(jsonb),
	public.qorpera_folder_tool_run(jsonb,jsonb), public.qorpera_company_run_actor(uuid,jsonb),
	public.qorpera_folder_presence_routes(jsonb,text[],boolean)
	from public, anon, authenticated, service_role;

-- 7. Dispatch on core (C1C §5.4) ---------------------------------------------------------------------------------

do $$
declare
	c_refuse constant text := 'then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;';
	c_actor_old constant text := 'public.qorpera_company_path_actor(';
	c_actor_new constant text := 'public.qorpera_company_run_actor(';
begin
	-- The run check under every runtime tool call. It returns the run row the folder run check read.
	perform pg_temp.c1c2_guard('public.qorpera_native_tool_locked_run(jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) then v_run := jsonb_populate_record(null::public.qorpera_execution_runs, '
		|| 'public.qorpera_folder_tool_run(p_binding, ''[]''::jsonb) -> ''run''); return v_run; end if;');
	-- The lease check the runtime also calls directly.
	perform pg_temp.c1c2_guard('public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)',
		'if public.qorpera_job_is_folder_v2(p_job_id) then return public.qorpera_folder_validate_native_lease(p_lease_id, p_run_id, '
		|| 'p_job_id, p_runner_id, p_assignment_id, p_credential_capsule_id, p_compute_identity_id, p_provider, p_native_harness); end if;');
	-- The wake check: the materializer calls it directly, and qorpera_run_wake_authorized calls it with the run's wake
	-- before comparing the policy kind. Its agent branch would pass vacuously on folder-v2 (no legacy read paths).
	perform pg_temp.c1c2_guard('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)',
		'if public.qorpera_environment_is_folder_v2(p_wake.environment_id) then return public.qorpera_folder_wake_authorized(p_wake); end if;');
	-- The context assertion decides by the company's core, never by a field of the actor. A folder-v2 run has no legacy
	-- read paths, so the legacy loop would pass vacuously: folder-v2 rechecks the run's folder reads (rank 10).
	perform pg_temp.c1c2_guard('public.qorpera_company_path_assert_context(jsonb)',
		'if public.qorpera_environment_is_folder_v2((p_actor ->> ''environmentId'')::uuid) then if p_actor ->> ''runId'' is null then return; end if; '
		|| 'if p_actor -> ''folder'' -> ''resolved'' ->> ''kind'' is distinct from ''staff_agent'' '
		|| 'or p_actor -> ''folder'' -> ''resolved'' ->> ''runId'' is distinct from p_actor ->> ''runId'' then '
		|| 'raise exception ''Company File authority is unavailable'' using errcode = ''42501''; end if; '
		|| 'perform public.qorpera_folder_run_reads_current((p_actor ->> ''environmentId'')::uuid, (p_actor ->> ''companyId'')::uuid, '
		|| 'p_actor -> ''folder'' -> ''resolved''); return; end if;');
	-- Presence: the folder resolver for folder-v2.
	perform pg_temp.c1c2_guard('public.qorpera_presence_path_routes(jsonb,text[],boolean)',
		'if public.qorpera_environment_is_folder_v2((p_actor ->> ''environmentId'')::uuid) then '
		|| 'return public.qorpera_folder_presence_routes(p_actor, p_paths, p_require_target); end if;');

	-- The callers that read switch to the new entry point (C1C §3's "unchanged" five and the read-type branches).
	perform pg_temp.c1c2_replace(p.oid::regprocedure, c_actor_old, c_actor_new, 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_begin_native_company_execution_v2',
		'qorpera_read_company_run_context',
		'qorpera_native_presence_register', 'qorpera_describe_agent_open_work', 'qorpera_native_company_object_actor',
		'qorpera_company_presence_scope', 'qorpera_native_presence_subject', 'qorpera_describe_company_run_context',
		'qorpera_member_file_export_source');
	perform pg_temp.c1c2_replace(p.oid::regprocedure, c_actor_old, c_actor_new, 2)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_list_member_file_exports';

	-- A member's export source: no company fence for folder-v2.
	perform pg_temp.c1c2_replace(p.oid::regprocedure,
		E' perform public.qorpera_lock_profile_gc_fence((v_actor->>''companyId'')::uuid);\n',
		E' if not public.qorpera_environment_is_folder_v2(p_environment_id) then\n'
		|| E'  perform public.qorpera_lock_profile_gc_fence((v_actor->>''companyId'')::uuid);\n end if;\n', 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_member_file_export_source';

	-- The run context: the company name from the folder index, and F2's agent folders (F2-1b, 20260929440000) for the
	-- agent and the coworkers the context lists. The helper is called by name at run time, so snapshot-v1 never needs
	-- it; it names only the ids it is given, so the folders never name a coworker the context does not list.
	perform pg_temp.c1c2_replace(p.oid::regprocedure,
		E'v_continuation jsonb; v_recorded jsonb;\n', E'v_continuation jsonb; v_recorded jsonb; v_folder jsonb;\n', 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_describe_company_run_context';
	perform pg_temp.c1c2_replace(p.oid::regprocedure,
		E'\tselect name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;\n',
		E'\tif public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
		|| E'\t\tselect name into v_company_name from public.qorpera_folder_company_index where environment_id = v_run.environment_id;\n'
		|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\telse\n'
		|| E'\t\tselect name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;\n'
		|| E'\tend if;\n', 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_describe_company_run_context';
	perform pg_temp.c1c2_replace(p.oid::regprocedure,
		E'\tselect count(*) into v_coworker_count from public.qorpera_profile_staff',
		E'\tif public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
		|| E'\t\texecute ''select public.qorpera_company_state_run_folder($1, $2, $3)'' into v_folder\n'
		|| E'\t\tusing v_run.environment_id, v_run.staff_agent_id,\n'
		|| E'\t\t\t(select coalesce(array_agg((coworker ->> ''id'')::uuid), ''{}''::uuid[]) from jsonb_array_elements(v_coworkers) coworker);\n'
		|| E'\tend if;\n'
		|| E'\tselect count(*) into v_coworker_count from public.qorpera_profile_staff', 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_describe_company_run_context';
	perform pg_temp.c1c2_replace(p.oid::regprocedure,
		E'\t\t\telse jsonb_build_object(''serviceTier'',v_run.service_tier) end;\n',
		E'\t\t\telse jsonb_build_object(''serviceTier'',v_run.service_tier) end\n'
		|| E'\t\t|| case when v_folder is null then ''{}''::jsonb else jsonb_build_object(''folder'', v_folder) end;\n', 1)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_describe_company_run_context';

	-- Until C1c-3: after the run check these take the gc fence or a legacy proposal lock; machine start holds the
	-- machine row, then asks for the company row FOR UPDATE.
	perform pg_temp.c1c2_guard(p.oid::regprocedure, 'if public.qorpera_binding_is_folder_v2(p_binding) ' || c_refuse)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_native_office_start',
		'qorpera_native_office_start_descriptor', 'qorpera_native_office_capture', 'qorpera_native_office_file_export',
		'qorpera_native_shared_file_export_source', 'qorpera_self_approve_organization_proposal', 'qorpera_native_machine_start');

	-- Until C1c-2b: the legacy effects take the job FOR UPDATE, and the receipts and the transcript append then the budget
	-- row, the reverse of the run mutex.
	perform pg_temp.c1c2_guard(p.oid::regprocedure, 'if public.qorpera_binding_is_folder_v2(p_binding) ' || c_refuse)
	from pg_proc p where p.pronamespace = 'public'::regnamespace
		and p.proname in ('qorpera_begin_native_tool_operation', 'qorpera_complete_native_tool_operation');
	perform pg_temp.c1c2_guard(p.oid::regprocedure, 'if public.qorpera_job_is_folder_v2(p_job_id) ' || c_refuse)
	from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_begin_run_operation_receipt',
		'qorpera_complete_run_operation_receipt', 'qorpera_send_native_agent_message', 'qorpera_send_runner_agent_message',
		'qorpera_append_native_interaction_request', 'qorpera_append_runner_transcript_event');
end $$;

-- Every dispatch and refusal above landed once per function (an overload added later would need its own).
do $$
begin
	if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
			'qorpera_native_office_start', 'qorpera_native_office_start_descriptor', 'qorpera_native_office_capture',
			'qorpera_native_office_file_export', 'qorpera_native_shared_file_export_source',
			'qorpera_self_approve_organization_proposal', 'qorpera_native_machine_start', 'qorpera_begin_native_tool_operation',
			'qorpera_complete_native_tool_operation', 'qorpera_begin_run_operation_receipt', 'qorpera_complete_run_operation_receipt',
			'qorpera_send_native_agent_message', 'qorpera_send_runner_agent_message', 'qorpera_append_native_interaction_request',
			'qorpera_append_runner_transcript_event')
			and p.prosrc like '%This Company File path does not serve folder-v2 companies%') <> 15 then
		raise exception 'C1c-2a refusals did not land on all 15 functions'; end if;
	if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
			and p.prosrc like '%public.qorpera_company_path_actor(%' and p.proname in ('qorpera_read_company_run_context',
			'qorpera_native_presence_register', 'qorpera_describe_agent_open_work', 'qorpera_native_company_object_actor',
			'qorpera_company_presence_scope', 'qorpera_native_presence_subject', 'qorpera_describe_company_run_context',
			'qorpera_member_file_export_source', 'qorpera_list_member_file_exports', 'qorpera_begin_native_company_execution_v2')) then
		raise exception 'C1c-2a left a reading caller on the legacy actor'; end if;
end $$;
