-- Runtime Step 3 (contract 17, acceptance 29, Order 3 placement): automatic
-- sponsor handoff on a usage limit. When a run's sponsoring connection reports
-- its usage limit and the attempt produced no governed effect, the control
-- plane records a new version of the run's own sponsor binding on another
-- eligible connection of the same principal, releases the exhausted attempt's
-- native authority, requeues the job as a fresh attempt whose context is
-- rebuilt from the canonical transcript, and notifies the member. Never
-- another member's credential; never silent. Rate limits and outages are not
-- handoffs. The earlier launch's provenance is kept in history.

alter table public.qorpera_execution_run_events drop constraint qorpera_execution_run_events_event_type_check;
alter table public.qorpera_execution_run_events add constraint qorpera_execution_run_events_event_type_check check (event_type in (
	'queued', 'orchestrator_claimed', 'runner_assigned', 'runner_started',
	'lease_renewed', 'infrastructure_retry', 'completed', 'failed',
	'cancelled', 'review_pending', 'provider_session_bound',
	'recovery_released', 'recovery_discarded', 'sponsor_handoff'
));
alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','company_ceiling_tripped','company_execution_paused','company_execution_resumed','sponsor_handoff'));

create table public.qorpera_execution_sponsor_handoffs (
	id uuid primary key default extensions.gen_random_uuid(),
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	binding_id uuid not null references public.qorpera_execution_sponsor_bindings(id) on delete restrict,
	from_version bigint not null,
	to_version bigint not null check (to_version > from_version),
	from_connection_id uuid not null references public.qorpera_provider_connections(id) on delete restrict,
	to_connection_id uuid not null references public.qorpera_provider_connections(id) on delete restrict,
	signal_id uuid not null references public.qorpera_provider_connection_usage_signals(id) on delete restrict,
	reason text not null check (reason in ('usage_limit')),
	actor text not null default 'control_plane' check (actor = 'control_plane'),
	attempt_count integer not null check (attempt_count >= 0),
	created_at timestamptz not null default clock_timestamp(),
	unique (run_id, from_version)
);
alter table public.qorpera_execution_sponsor_handoffs enable row level security;
revoke all on public.qorpera_execution_sponsor_handoffs from public, anon, authenticated, service_role;
grant select on public.qorpera_execution_sponsor_handoffs to service_role;

create table public.qorpera_native_execution_launch_history (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	runtime_bundle_id uuid not null,
	runtime_bundle_sha256 text not null,
	binary_sha256 text not null,
	reasoning_effort text not null,
	reasoning_policy_sha256 text not null,
	tool_catalog_sha256 text not null,
	context_sha256 text not null,
	context_bytes integer not null,
	launched_at timestamptz not null,
	superseded_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_native_execution_launch_history enable row level security;
revoke all on public.qorpera_native_execution_launch_history from public, anon, authenticated, service_role;

-- True when the run's latest native start precedes its latest sponsor handoff:
-- the next attempt may launch again.
create function public.qorpera_run_native_start_superseded(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select max(id) from public.qorpera_execution_run_events where run_id = p_run_id and event_type = 'sponsor_handoff'),0)
		> coalesce((select max(id) from public.qorpera_execution_run_events where run_id = p_run_id and event_type = 'runner_started'
			and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'),0)
$$;
revoke all on function public.qorpera_run_native_start_superseded(uuid) from public, anon, authenticated, service_role;

create function public.qorpera_handoff_run_sponsor(p_run_id uuid, p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype; v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_current public.qorpera_provider_connections%rowtype; v_mode text; v_signal public.qorpera_provider_connection_usage_signals%rowtype;
	v_candidate record; v_new_version bigint; v_handoff public.qorpera_execution_sponsor_handoffs%rowtype; v_recipient uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Sponsor handoff requires control-plane authority' using errcode = '42501'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id for update;
	if not found then return null; end if;
	select * into v_job from public.qorpera_runner_jobs where id = v_run.job_id for update;
	if not found or v_job.status <> 'leased' or v_job.attempt_count >= 8 or v_run.deadline_at <= clock_timestamp() then return null; end if;
	select * into v_signal from public.qorpera_provider_connection_usage_signals
	where run_id = v_run.id and job_id = v_job.id and signal_kind = 'usage_limit'
		and sponsor_binding_id = v_run.sponsor_binding_id and sponsor_version = v_run.sponsor_version
	order by observed_at desc limit 1;
	if not found then return null; end if;
	-- Continuation must not duplicate an effect: no governed operation, artifact or output exists for this run.
	if exists (select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id)
		or exists (select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id)
		or exists (select 1 from public.qorpera_runner_job_output_objects where job_id = v_job.id)
		or exists (select 1 from public.qorpera_runner_company_revision_outputs where job_id = v_job.id) then return null; end if;
	select * into strict v_binding from public.qorpera_execution_sponsor_bindings where id = v_run.sponsor_binding_id for update;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_binding.id and version = v_run.sponsor_version;
	select * into strict v_current from public.qorpera_provider_connections where id = v_sponsor.provider_connection_id;
	select authentication_mode into strict v_mode from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	-- The next eligible connection of the same principal: same company, provider and
	-- authentication mode; the run's compute identity for native subscriptions;
	-- autonomous consent when the run is autonomous; no standing usage limit.
	select connection.id as connection_id, version.version as connection_version, version.allow_autonomous into v_candidate
	from public.qorpera_provider_connections connection
	join lateral (select * from public.qorpera_provider_connection_versions v where v.connection_id = connection.id
		order by v.version desc limit 1) version on true
	left join public.qorpera_native_credential_capsules capsule on capsule.id = version.credential_capsule_id
	where connection.profile_id = v_run.profile_id and connection.id <> v_current.id and connection.status = 'active'
		and connection.provider = v_current.provider
		and connection.owner_user_id is not distinct from v_current.owner_user_id
		and version.authentication_mode = v_mode
		and (v_mode <> 'native_subscription' or (capsule.id is not null and capsule.status = 'active'
			and capsule.compute_identity_id = v_run.compute_identity_id))
		and (v_run.source_kind in ('session_turn','room_delivery') or version.allow_autonomous)
		and not exists (select 1 from public.qorpera_provider_connection_usage_signals blocked
			where blocked.provider_connection_id = connection.id and blocked.signal_kind = 'usage_limit'
				and coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours') > clock_timestamp())
	order by connection.created_at, connection.id limit 1;
	if not found then return null; end if;
	select coalesce(max(version),0) + 1 into v_new_version from public.qorpera_execution_sponsor_versions where binding_id = v_binding.id;
	insert into public.qorpera_execution_sponsor_versions(binding_id,version,sponsor_kind,provider_connection_id,
		provider_connection_version,allow_autonomous,created_by_user_id)
	values (v_binding.id,v_new_version,v_sponsor.sponsor_kind,v_candidate.connection_id,v_candidate.connection_version,
		v_candidate.allow_autonomous,v_binding.created_by_user_id);
	update public.qorpera_execution_runs set sponsor_version = v_new_version where id = v_run.id;
	-- The exhausted attempt's native authority ends here; the job returns to the queue as a fresh attempt.
	update public.qorpera_native_provider_connection_leases set status = 'revoked',released_at = clock_timestamp()
	where run_id = v_run.id and job_id = v_job.id and status = 'active';
	update public.qorpera_runner_jobs set status = 'queued',runner_id = null,client_lease_id = null,
		terminal_lease_token_sha256 = lease_token_sha256,lease_token_sha256 = null,lease_expires_at = null,
		last_error = left(coalesce(nullif(btrim(p_error),''),'Provider usage limit'),1000)
	where id = v_job.id returning * into v_job;
	insert into public.qorpera_execution_sponsor_handoffs(run_id,job_id,binding_id,from_version,to_version,from_connection_id,
		to_connection_id,signal_id,reason,attempt_count)
	values (v_run.id,v_job.id,v_binding.id,v_sponsor.version,v_new_version,v_current.id,v_candidate.connection_id,v_signal.id,
		'usage_limit',v_job.attempt_count) returning * into v_handoff;
	-- The admitted wake follows its run to the new sponsor version; the identity guard admits exactly this recorded move.
	update public.qorpera_wake_occurrences set sponsor_version = v_new_version
	where run_id = v_run.id and sponsor_binding_id = v_binding.id and sponsor_version = v_sponsor.version;
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values (v_run.id,'sponsor_handoff',jsonb_build_object('schema','qorpera.sponsor-handoff/v1','handoffId',v_handoff.id,
		'jobId',v_job.id,'fromVersion',v_sponsor.version,'toVersion',v_new_version,'fromConnectionId',v_current.id,
		'toConnectionId',v_candidate.connection_id,'signalId',v_signal.id,'reason','usage_limit','actor','control_plane'));
	for v_recipient in
		select recipient.user_id from (
			select v_current.owner_user_id user_id where v_current.owner_user_id is not null
			union
			select member.user_id from public.qorpera_profile_members member
			where v_current.owner_user_id is null and member.profile_id = v_run.profile_id and member.role in ('owner','admin')
		) recipient order by recipient.user_id loop
		insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
		values (v_run.profile_id,v_recipient,'sponsor_handoff',jsonb_build_object(
			'schema','qorpera.member-notification.sponsor-handoff/v1','handoffId',v_handoff.id,'runId',v_run.id,
			'fromConnectionId',v_current.id,'toConnectionId',v_candidate.connection_id,'signalId',v_signal.id,
			'reason','usage_limit','at',v_handoff.created_at),v_handoff.id::text)
		on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
	end loop;
	return jsonb_build_object('schema','qorpera.sponsor-handoff/v1','handoffId',v_handoff.id,'runId',v_run.id,'jobId',v_job.id,
		'fromVersion',v_sponsor.version,'toVersion',v_new_version,'fromConnectionId',v_current.id,
		'toConnectionId',v_candidate.connection_id,'signalId',v_signal.id);
end
$$;
revoke all on function public.qorpera_handoff_run_sponsor(uuid, text) from public, anon, authenticated;
grant execute on function public.qorpera_handoff_run_sponsor(uuid, text) to service_role;

-- Job failure tries the handoff first (was 20260820002000_runner_orchestrator_contracts.sql).
create or replace function public.qorpera_fail_runner_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_error text,
	p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_error text := left(coalesce(nullif(btrim(p_error), ''), 'Runner job failed'), 1000);
	v_handoff jsonb;
begin
	if auth.role() <> 'service_role' or p_retryable is null
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job failure is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if found and v_job.terminal_lease_token_sha256 = p_lease_token_sha256
		and v_job.last_error like v_error || '%'
		and v_job.status in ('queued', 'failed', 'cancelled') then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	-- Contract 17: a usage limit on the sponsoring connection continues the run
	-- on the next eligible connection of the same principal instead of failing it.
	if v_job.run_id is not null then
		v_handoff := public.qorpera_handoff_run_sponsor(v_job.run_id, v_error);
		if v_handoff is not null then
			select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
			perform public.qorpera_append_runner_audit(
				v_job.profile_id, p_runner_id, v_job.id, 'job_requeued',
				jsonb_build_object('attempt_count', v_job.attempt_count, 'sponsor_handoff', v_handoff), null
			);
			return public.qorpera_runner_job_json(v_job);
		end if;
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'failed', v_error, p_retryable
	);
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id,
		case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
		jsonb_build_object('attempt_count', v_job.attempt_count), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

-- A fresh attempt after a handoff may start again (was 20260828010000_native_company_execution_admission.sql).
create or replace function public.qorpera_begin_native_company_execution(p_binding jsonb,p_binary_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_environment uuid; v_payload jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binary_sha256 is null
		or p_binary_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	select environment_id into strict v_environment from public.qorpera_execution_runs
	where id = (p_binding ->> 'runId')::uuid;
	v_actor := public.qorpera_company_path_actor(v_environment,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if exists(select 1 from public.qorpera_execution_run_events where run_id = (p_binding ->> 'runId')::uuid
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		and not public.qorpera_run_native_start_superseded((p_binding ->> 'runId')::uuid) then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	v_payload := jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',p_binding ->> 'runId','jobId',p_binding ->> 'jobId','leaseId',p_binding ->> 'leaseId',
		'binarySha256',p_binary_sha256);
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values((p_binding ->> 'runId')::uuid,'runner_started',v_payload);
	return v_payload;
end
$$;

-- Native launch admission after a handoff (was 20260828019700_runtime_executable_provenance.sql).
create or replace function public.qorpera_begin_native_company_execution_v2(
	p_binding jsonb,p_binary_sha256 text,p_runtime_bundle_sha256 text,p_reasoning_policy_sha256 text,
	p_tool_catalog_text text,p_context_sha256 text,p_context_bytes integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb;
	v_payload jsonb; v_catalog jsonb; v_catalog_sha text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if p_runtime_bundle_sha256 is distinct from v_run.runtime_bundle_sha256
		or p_binary_sha256 is distinct from v_manifest ->> 'nativeBinarySha256'
		or v_run.reasoning_effort is distinct from v_manifest #>> '{modelPolicy,effort}'
		or p_reasoning_policy_sha256 is distinct from v_run.reasoning_policy_sha256
		or p_reasoning_policy_sha256 is distinct from
			encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex') then
		raise exception 'Native executable policy differs from the admitted run' using errcode = '42501'; end if;
	if p_tool_catalog_text is null or octet_length(p_tool_catalog_text) not between 1 and 262144
		or coalesce(p_context_sha256,'') !~ '^[0-9a-f]{64}$' or p_context_bytes is null
		or p_context_bytes not between 1 and 1048576 then
		raise exception 'Native launch provenance is invalid' using errcode = '22023'; end if;
	v_catalog := p_tool_catalog_text::jsonb;
	if jsonb_typeof(v_catalog) is distinct from 'object'
		or v_catalog - array['type','name','description','tools'] <> '{}'::jsonb
		or v_catalog ->> 'type' is distinct from 'namespace' or v_catalog ->> 'name' is distinct from 'qorpera'
		or jsonb_typeof(v_catalog -> 'description') is distinct from 'string'
		or jsonb_typeof(v_catalog -> 'tools') is distinct from 'array' then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_catalog -> 'tools') not between 1 and 32
		or exists(select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'type' is distinct from 'function'
				or coalesce(tool ->> 'name','') !~ '^[a-z][a-z0-9_]{0,63}$'
				or jsonb_typeof(tool -> 'description') is distinct from 'string'
				or tool #>> '{inputSchema,type}' is distinct from 'object'
				or tool #> '{inputSchema,additionalProperties}' is distinct from 'false'::jsonb
				or tool - array['type','name','description','inputSchema'] <> '{}'::jsonb)
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool)
			<> jsonb_array_length(v_catalog -> 'tools') then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if exists(select 1 from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		and not public.qorpera_run_native_start_superseded(v_run.id) then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	-- After a sponsor handoff the earlier launch is history; the read-provenance
	-- rows keep pointing at this run's launch identity.
	insert into public.qorpera_native_execution_launch_history(run_id,runtime_bundle_id,runtime_bundle_sha256,binary_sha256,
		reasoning_effort,reasoning_policy_sha256,tool_catalog_sha256,context_sha256,context_bytes,launched_at)
	select run_id,runtime_bundle_id,runtime_bundle_sha256,binary_sha256,reasoning_effort,reasoning_policy_sha256,
		tool_catalog_sha256,context_sha256,context_bytes,created_at
	from public.qorpera_native_execution_launches where run_id = v_run.id;
	insert into public.qorpera_native_execution_launches(run_id,runtime_bundle_id,runtime_bundle_sha256,
		binary_sha256,reasoning_effort,reasoning_policy_sha256,tool_catalog_text,context_sha256,context_bytes)
	values(v_run.id,v_run.runtime_bundle_id,v_run.runtime_bundle_sha256,p_binary_sha256,
		v_run.reasoning_effort,v_run.reasoning_policy_sha256,p_tool_catalog_text,p_context_sha256,p_context_bytes)
	on conflict (run_id) do update set runtime_bundle_id = excluded.runtime_bundle_id,
		runtime_bundle_sha256 = excluded.runtime_bundle_sha256,binary_sha256 = excluded.binary_sha256,
		reasoning_effort = excluded.reasoning_effort,reasoning_policy_sha256 = excluded.reasoning_policy_sha256,
		tool_catalog_text = excluded.tool_catalog_text,context_sha256 = excluded.context_sha256,
		context_bytes = excluded.context_bytes,created_at = clock_timestamp()
	returning tool_catalog_sha256 into v_catalog_sha;
	-- Preserve the existing uncertain-execution/completion event protocol.
	v_payload := jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',v_run.id,'jobId',v_run.job_id,'leaseId',p_binding ->> 'leaseId','binarySha256',p_binary_sha256,
		'runtimeBundleSha256',v_run.runtime_bundle_sha256,'reasoningEffort',v_run.reasoning_effort,
		'reasoningPolicySha256',v_run.reasoning_policy_sha256,'toolCatalogSha256',v_catalog_sha,
		'contextSha256',p_context_sha256,'contextBytes',p_context_bytes);
	insert into public.qorpera_execution_run_events(run_id,event_type,payload) values(v_run.id,'runner_started',v_payload);
	return v_payload;
end
$$;

-- A superseded start is not the current attempt (was 20260828010000_native_company_execution_admission.sql).
create or replace function public.qorpera_terminalize_runner_attempt(p_job_id uuid,p_terminal_status text,p_reason text,
	p_allow_pristine_retry boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.qorpera_runner_jobs%rowtype; v_started boolean; v_result jsonb;
begin
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id for update;
	v_started := v_job.status in ('queued','leased') and exists(
		select 1 from public.qorpera_execution_run_events where run_id = v_job.run_id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		and not public.qorpera_run_native_start_superseded(v_job.run_id);
	-- Preserve the existing status/actor/lease/partial-effect bookkeeping. A
	-- started native turn is never a pristine infrastructure retry, even when
	-- it emitted no tool result, provider session id, or user-facing message.
	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
	if v_started then
		insert into public.qorpera_execution_run_events(run_id,event_type,payload)
		values(v_job.run_id,'review_pending',jsonb_build_object('reason','native_execution_uncertain',
			'assignment_id',v_job.client_lease_id));
		update public.qorpera_wake_occurrences set status = 'requires_review',
			blocked_reason = 'Native execution outcome requires review',finished_at = clock_timestamp()
		where run_id = v_job.run_id and status = 'failed';
	end if;
	return v_result;
end
$$;

-- Completion matches the latest launch (was 20260828021000_runtime_wake_enforcement.sql).
create or replace function public.qorpera_complete_runner_job_v6(
	p_runner_id uuid,p_session_token_sha256 text,p_job_id uuid,p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,p_client_substrate_version_id uuid,p_output_snapshot_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_binding jsonb; v_actor jsonb; v_receipt jsonb; v_hash text; v_mode integer; v_started jsonb;
	v_last_snapshot uuid; v_applied jsonb; v_proposed jsonb; v_count integer; v_final uuid;
	v_transcript_end bigint := 0; v_disposition text := 'unchanged'; v_completed_inputs integer;
begin
	if auth.role() is distinct from 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id,p_session_token_sha256) then
		raise exception 'Runner completion authority is unavailable' using errcode = '42501'; end if;
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id and runner_id = p_runner_id for update;
	if not found then raise exception 'Runner job lease is unavailable' using errcode = '40001'; end if;
	select path_gateway_version into v_mode from public.qorpera_company_files where environment_id = v_job.environment_id;
	if v_mode is distinct from 1 then
		if p_result ->> 'runtime' = 'company-path-v1' then
			raise exception 'Company runtime selection changed' using errcode = '42501'; end if;
		return public.qorpera_complete_runner_job_before_path_runtime(p_runner_id,p_session_token_sha256,
			p_job_id,p_lease_token_sha256,p_client_artifact_index_id,p_client_substrate_version_id,p_output_snapshot_id,p_result);
	end if;
	if p_output_snapshot_id is not null or p_client_artifact_index_id is null or p_client_substrate_version_id is null
		or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 49152
		or p_result ->> 'schema' is distinct from 'qorpera.runner-result/v1'
		or p_result ->> 'runtime' is distinct from 'company-path-v1'
		or p_result ->> 'backend' is distinct from 'native-company-runtime'
		or p_result - array['schema','runtime','backend','native_lease_id','substrate_version_id',
			'backend_result','output_count','output_bytes','publication','usage'] <> '{}'::jsonb
		or p_result -> 'publication' is distinct from 'null'::jsonb
		or p_result -> 'output_count' is distinct from '0'::jsonb
		or p_result -> 'output_bytes' is distinct from '0'::jsonb
		or p_result ->> 'substrate_version_id' is distinct from v_job.substrate_version_id::text then
		raise exception 'Governed completion cannot publish a whole Company File or artifacts' using errcode = '22023'; end if;
	v_hash := encode(extensions.digest(convert_to(p_result::text,'utf8'),'sha256'),'hex');
	select * into v_existing from public.qorpera_execution_run_results where job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 is distinct from p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id or v_existing.result_sha256 <> v_hash
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id then
			raise exception 'Runner completion replay differs from its receipt' using errcode = '23505'; end if;
		-- Receipt replay conveys no new read, write, model call or public send.
		return public.qorpera_runner_job_json(v_job);
	end if;
	v_job := public.qorpera_runner_broker_locked_job(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	select * into strict v_run from public.qorpera_execution_runs where id = v_job.run_id;
	select * into v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_result ->> 'native_lease_id')::uuid and run_id = v_run.id and job_id = v_job.id;
	if not found then raise exception 'Native completion authority is unavailable' using errcode = '42501'; end if;
	v_binding := jsonb_build_object('leaseId',v_lease.id,'runId',v_run.id,'jobId',v_job.id,'runnerId',p_runner_id,
		'assignmentId',v_job.client_lease_id,'credentialCapsuleId',v_lease.credential_capsule_id,
		'computeIdentityId',v_run.compute_identity_id,'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,v_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	select payload into v_started from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
	order by id desc limit 1;
	if not found or v_started ->> 'runId' is distinct from v_run.id::text
		or v_started ->> 'jobId' is distinct from v_job.id::text
		or v_started ->> 'leaseId' is distinct from v_lease.id::text
		or coalesce(v_started ->> 'binarySha256','') !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution has no matching durable admission' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_runner_model_requests where job_id = v_job.id and status = 'reserved')
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous'))
		or exists(select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then
		raise exception 'Governed execution has unresolved or ungoverned work' using errcode = '55000'; end if;
	-- Every required effect already has its exact, atomic path revision or
	-- proposal. Different operations need not (and usually will not) share a head.
	if exists(select 1 from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id
		and receipt.status = 'completed' and (receipt.requires_company_revision or receipt.output_snapshot_id is not null
			or receipt.company_path_proposal_id is not null or receipt.proposal_id is not null) and not (
			exists(select 1 from public.qorpera_company_path_revisions revision
				where revision.receipt_id = receipt.id and revision.run_id = v_run.id
					and revision.environment_id = v_run.environment_id and revision.snapshot_id = receipt.output_snapshot_id)
			or exists(select 1 from public.qorpera_company_path_proposals proposal
				where proposal.receipt_id = receipt.id and proposal.run_id = v_run.id
					and proposal.environment_id = v_run.environment_id and proposal.id = receipt.company_path_proposal_id)
		)) then raise exception 'Governed completion omitted a path effect receipt' using errcode = '55000'; end if;
	v_receipt := p_result -> 'backend_result';
	select count(*),max(delivery.event_id::text) filter(where delivery.phase = 'final'),coalesce(max(event.sequence),0)
	into v_count,v_final,v_transcript_end from public.qorpera_agent_sends delivery
	join public.qorpera_session_events event on event.event_id = delivery.event_id
	where delivery.run_id = v_run.id and delivery.assignment_id = v_job.client_lease_id;
	-- Server-owned wake policy decides whether silence is a valid terminal result
	-- (contract 6.3, 7.2); a silent completion invents no transcript event.
	perform public.qorpera_assert_wake_completion(v_run.id);
	if v_count = 0 then v_transcript_end := v_run.transcript_start_sequence; end if;
	if jsonb_typeof(v_receipt) is distinct from 'object'
		or v_receipt - array['schema','run_id','message_count','final_message_id','provider_session_id'] <> '{}'::jsonb
		or v_receipt ->> 'schema' is distinct from 'qorpera.native-harness-result/v2'
		or v_receipt ->> 'run_id' is distinct from v_run.id::text
		or v_receipt -> 'message_count' is distinct from to_jsonb(v_count)
		or v_receipt -> 'final_message_id' is distinct from coalesce(to_jsonb(v_final),'null'::jsonb)
		or (v_run.session_id is null and v_count <> 0)
		or (v_count > 0 and (v_final is null or v_transcript_end <= v_run.transcript_start_sequence))
		or jsonb_typeof(v_receipt -> 'provider_session_id') is distinct from 'string'
		or char_length(btrim(v_receipt ->> 'provider_session_id')) not between 1 and 1024 then
		raise exception 'Native completion does not match durable public delivery' using errcode = '55000'; end if;
	perform public.qorpera_bind_execution_provider_session(p_runner_id,p_session_token_sha256,p_job_id,
		p_lease_token_sha256,v_receipt ->> 'provider_session_id',null);
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_applied
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null;
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_proposed
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.company_path_proposal_id is not null;
	select receipt.output_snapshot_id into v_last_snapshot from public.qorpera_run_operation_receipts receipt
	where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null order by receipt.completed_at desc,receipt.id desc limit 1;
	if v_last_snapshot is not null then v_disposition := 'published'; end if;
	-- Uses the existing job/usage bookkeeping and final-send trigger. Terminal
	-- job cleanup releases native authority in this same database transaction.
	perform public.qorpera_complete_runner_job_v4(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256,
		p_client_artifact_index_id,p_client_substrate_version_id,p_result);
	update public.qorpera_runner_jobs set result = result || jsonb_build_object('company_file',jsonb_build_object(
		'runtime','company-path-v1','disposition',v_disposition,'output_snapshot_id',v_last_snapshot,'proposal_id',null,
		'native_binary_sha256',v_started ->> 'binarySha256',
		'applied_receipt_ids',v_applied,'proposal_receipt_ids',v_proposed)) where id = v_job.id returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then raise exception 'Runner completion receipt is too large' using errcode = '54000'; end if;
	insert into public.qorpera_execution_run_results(run_id,job_id,assignment_id,runner_id,transcript_end_sequence,
		company_disposition,output_snapshot_id,proposal_id,client_artifact_index_id,client_substrate_version_id,result_sha256)
	values(v_run.id,v_job.id,v_job.client_lease_id,p_runner_id,v_transcript_end,v_disposition,v_last_snapshot,null,
		p_client_artifact_index_id,p_client_substrate_version_id,v_hash);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs set completed_at = clock_timestamp()
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise exception 'Runner session inputs changed before completion' using errcode = '40001'; end if;
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$$;

create table public.qorpera_native_provider_connection_lease_history (
	id bigint generated always as identity primary key,
	lease_id uuid not null,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	credential_capsule_id uuid not null,
	compute_identity_id uuid not null,
	runner_id uuid not null,
	assignment_id uuid not null,
	status text not null,
	created_at timestamptz not null,
	expires_at timestamptz not null,
	released_at timestamptz,
	superseded_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_native_provider_connection_lease_history enable row level security;
revoke all on public.qorpera_native_provider_connection_lease_history from public, anon, authenticated, service_role;

-- The fresh attempt leases the other connection on the run's lease row (was 20260821001000_native_subscription_compute_identity.sql).
create or replace function public.qorpera_acquire_native_provider_connection_lease(
	p_run_id uuid,
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_assignment_id uuid,
	p_lease_token_sha256 text,
	p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_active integer;
begin
	if auth.role() <> 'service_role' or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_seconds not between 30 and 900 then
		raise exception 'native provider lease request is invalid' using errcode = '42501';
	end if;
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256,
		(select run.job_id from public.qorpera_execution_runs as run where run.id = p_run_id),
		p_lease_token_sha256
	);
	if v_job.run_id is distinct from p_run_id then
		raise exception 'native provider lease names another execution run' using errcode = '42501';
	end if;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run where run.id = p_run_id;
	select sponsor.* into strict v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into strict v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.status = 'active'
	for update;
	select version.* into strict v_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_connection.id
		and version.version = v_sponsor.provider_connection_version
		and version.authentication_mode = 'native_subscription'
		and version.authorization_state = 'active';
	select capsule.* into strict v_capsule
	from public.qorpera_native_credential_capsules as capsule
	where capsule.id = v_version.credential_capsule_id and capsule.status = 'active';
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_run.compute_identity_id and identity.status = 'active';
	select policy.* into strict v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_connection.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_version.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled';
	if v_run.compute_identity_id is null or v_run.compute_identity_id <> v_capsule.compute_identity_id
		or v_capsule.ownership_kind <> v_identity.ownership_kind
		or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
		or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key
		or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.client_lease_id <> p_assignment_id
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.run_id = v_run.id
				and assignment.job_id = v_job.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted' and assignment.expires_at > statement_timestamp()
		) then
		raise exception 'native provider lease is outside the accepted assignment' using errcode = '42501';
	end if;
	select lease.* into v_lease
	from public.qorpera_native_provider_connection_leases as lease
	where lease.run_id = v_run.id
	for update;
	if found then
		-- After a sponsor handoff the run's lease row is rebound to the fresh
		-- attempt on the other connection; the exhausted binding is kept in history.
		if v_lease.status <> 'active' and v_lease.job_id = v_job.id
			and public.qorpera_run_native_start_superseded(v_run.id) then
			insert into public.qorpera_native_provider_connection_lease_history(lease_id,run_id,job_id,provider_connection_id,
				provider_connection_version,credential_capsule_id,compute_identity_id,runner_id,assignment_id,status,created_at,
				expires_at,released_at)
			values (v_lease.id,v_lease.run_id,v_lease.job_id,v_lease.provider_connection_id,v_lease.provider_connection_version,
				v_lease.credential_capsule_id,v_lease.compute_identity_id,v_lease.runner_id,v_lease.assignment_id,v_lease.status,
				v_lease.created_at,v_lease.expires_at,v_lease.released_at);
			update public.qorpera_native_provider_connection_leases
			set provider_connection_id = v_connection.id, provider_connection_version = v_version.version,
				credential_capsule_id = v_capsule.id, runner_id = p_runner_id, assignment_id = p_assignment_id,
				lease_token_sha256 = p_lease_token_sha256, created_at = statement_timestamp(),
				expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
			where id = v_lease.id returning * into v_lease;
		end if;
		if v_lease.job_id <> v_job.id
			or v_lease.provider_connection_id <> v_connection.id
			or v_lease.provider_connection_version <> v_version.version
			or v_lease.credential_capsule_id <> v_capsule.id
			or v_lease.compute_identity_id <> v_run.compute_identity_id
			or v_lease.runner_id <> p_runner_id
			or v_lease.assignment_id <> p_assignment_id
			or v_lease.lease_token_sha256 <> p_lease_token_sha256 then
			raise exception 'native provider lease is already bound to another assignment' using errcode = '23505';
		end if;
		update public.qorpera_native_provider_connection_leases
		set status = 'active',
			expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
			released_at = null
		where id = v_lease.id
		returning * into v_lease;
		return jsonb_build_object(
			'lease_id', v_lease.id,
			'run_id', v_lease.run_id,
			'provider_connection_id', v_lease.provider_connection_id,
			'provider_connection_version', v_lease.provider_connection_version,
			'credential_capsule_id', v_lease.credential_capsule_id,
			'encrypted_capsule_reference', v_capsule.encrypted_capsule_reference,
			'attestation_policy_sha256', v_capsule.attestation_policy_sha256,
			'compute_identity_id', v_lease.compute_identity_id,
			'compute_identity_ownership_kind', v_identity.ownership_kind,
			'compute_identity_owner_user_id', v_identity.owner_user_id,
			'compute_identity_owner_scope_key', v_identity.owner_scope_key,
			'credential_ownership_kind', v_capsule.ownership_kind,
			'credential_owner_user_id', v_capsule.owner_user_id,
			'credential_owner_scope_key', v_capsule.owner_scope_key,
			'provider', v_connection.provider,
			'authentication_mode', 'native_subscription',
			'native_harness', v_version.native_harness,
			'runner_id', v_lease.runner_id,
			'assignment_id', v_lease.assignment_id,
			'expires_at', v_lease.expires_at
		);
	end if;
	update public.qorpera_native_provider_connection_leases
	set status = 'expired', released_at = statement_timestamp()
	where provider_connection_id = v_connection.id and status = 'active'
		and expires_at <= statement_timestamp();
	select count(*) into v_active
	from public.qorpera_native_provider_connection_leases as lease
	where lease.provider_connection_id = v_connection.id and lease.status = 'active';
	if v_active >= least(v_version.max_native_concurrency, v_policy.max_native_concurrency) then
		raise exception 'native provider connection already has its allowed execution lease' using errcode = '55000';
	end if;
	insert into public.qorpera_native_provider_connection_leases (
		run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id,
		lease_token_sha256, expires_at
	) values (
		v_run.id, v_job.id, v_connection.id, v_version.version, v_capsule.id,
		v_run.compute_identity_id, p_runner_id, p_assignment_id, p_lease_token_sha256,
		statement_timestamp() + make_interval(secs => p_lease_seconds)
	) returning * into v_lease;
	return jsonb_build_object(
		'lease_id', v_lease.id,
		'run_id', v_lease.run_id,
		'provider_connection_id', v_lease.provider_connection_id,
		'provider_connection_version', v_lease.provider_connection_version,
		'credential_capsule_id', v_lease.credential_capsule_id,
		'encrypted_capsule_reference', v_capsule.encrypted_capsule_reference,
		'attestation_policy_sha256', v_capsule.attestation_policy_sha256,
		'compute_identity_id', v_lease.compute_identity_id,
		'compute_identity_ownership_kind', v_identity.ownership_kind,
		'compute_identity_owner_user_id', v_identity.owner_user_id,
		'compute_identity_owner_scope_key', v_identity.owner_scope_key,
		'credential_ownership_kind', v_capsule.ownership_kind,
		'credential_owner_user_id', v_capsule.owner_user_id,
		'credential_owner_scope_key', v_capsule.owner_scope_key,
		'provider', v_connection.provider,
		'authentication_mode', 'native_subscription',
		'native_harness', v_version.native_harness,
		'runner_id', v_lease.runner_id,
		'assignment_id', v_lease.assignment_id,
		'expires_at', v_lease.expires_at
	);
end
$$;

-- The wake identity guard admits a recorded sponsor handoff (was 20260828020000_runtime_wake_bus.sql).
create or replace function public.qorpera_guard_wake_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
	-- A recorded sponsor handoff on the wake's run is the only admitted identity move (contract 17).
	if new.sponsor_version is distinct from old.sponsor_version and not (new.run_id is not null
		and new.run_id = old.run_id and exists (select 1 from public.qorpera_execution_sponsor_handoffs handoff
			where handoff.run_id = new.run_id and handoff.binding_id = new.sponsor_binding_id
				and handoff.from_version = old.sponsor_version and handoff.to_version = new.sponsor_version)) then
		raise exception 'Admitted wake identity is immutable' using errcode = '42501'; end if;
	if (to_jsonb(new) - array['status','blocked_reason','run_id','finished_at','sponsor_version'])
		is distinct from (to_jsonb(old) - array['status','blocked_reason','run_id','finished_at','sponsor_version'])
		or (old.run_id is not null and new.run_id is distinct from old.run_id) then
		raise exception 'Admitted wake identity is immutable' using errcode = '42501'; end if;
	return new;
end
$$;

-- One native start per run and per sponsor-handoff epoch. The former unique
-- index allowed exactly one start per run for its whole life; the guard keeps
-- that rule between handoffs and admits one fresh start after each recorded
-- handoff. Same SQLSTATE as the index it replaces.
drop index public.qorpera_native_company_execution_start_once;
create index qorpera_native_company_execution_starts
	on public.qorpera_execution_run_events(run_id, id)
	where event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1';
create function public.qorpera_guard_native_company_execution_start()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.event_type = 'runner_started' and new.payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
		and exists (select 1 from public.qorpera_execution_run_events started
			where started.run_id = new.run_id and started.event_type = 'runner_started'
				and started.payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
				and started.id > coalesce((select max(handoff.id) from public.qorpera_execution_run_events handoff
					where handoff.run_id = new.run_id and handoff.event_type = 'sponsor_handoff'),0)) then
		raise exception 'duplicate key value violates unique constraint "qorpera_native_company_execution_start_once"'
			using errcode = '23505'; end if;
	return new;
end
$$;
revoke all on function public.qorpera_guard_native_company_execution_start() from public, anon, authenticated, service_role;
create trigger qorpera_native_company_execution_start_once before insert on public.qorpera_execution_run_events
	for each row execute function public.qorpera_guard_native_company_execution_start();
