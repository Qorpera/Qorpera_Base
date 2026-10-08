-- Context tree W5a-1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §12, §14 W5): a started run that is cut off, or
-- that hits its login's usage limit, goes on from its run log instead of ending in review.
-- * The gate: qorpera_run_resumes_from_log(run) says whether a run's log can carry it on. It is false here, so nothing
--   changes until W5a-2 turns it on (the run has a log, no step erase is open and no step is narrow, §4.5).
-- * A cut-off (the runner's lease ran out, the runner was revoked or reset, or it failed with a retryable error) after
--   the run started: the attempt's open receipts become 'outcome_unknown' (final: the agent checks before it repeats
--   the step, under a new key), its native lease moves to history, a run_cut_off event supersedes its start, and the
--   job is queued again, as a pristine retry is. The cut-off counts as an attempt (8 at most).
-- * A usage limit (the native adapter recorded a usage_limit signal for this attempt): the same, with a run_paused
--   event, and the job waits until the login's reset (6 hours when the provider gave no time or a time already past;
--   a minute at least). A pause is not an attempt, but the attempt's number still rises: it names the attempt's
--   machine and runner (runAttemptAcquisitionId), and the paused attempt's are spent. The run never moves to another
--   login (Jonas, 4 Oct: who pays never switches): the next attempt's launch is accepted only on the same sponsor
--   version and the same login.
-- * Usage signals are kept per attempt (assignment), so a second limit after a resume is a new signal.
-- * A failed run's recovery does not retry work whose outcome is unknown, as it does not retry completed work.
-- Every inserted text names this migration (20260930170000), for the deploy guard.

do $$ begin
	if to_regprocedure('public.qorpera_resume_run_from_log(uuid,text,boolean)') is not null then
		raise exception 'W5a-1 (20260930170000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.w5a_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W5a-1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The gate ------------------------------------------------------------------------------------------------------------

-- Whether a run's log can carry it past a cut-off or a pause. W5a-2 replaces it: a log exists, no step erase is open,
-- and no step is narrow (qorpera_run_log_narrow).
create function public.qorpera_run_resumes_from_log(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930170000 (W5a-1): off until W5a-2.
	select false
$$;

-- 2. Receipts and events -------------------------------------------------------------------------------------------------

-- An operation whose attempt was cut off while it ran: final, never completed later.
alter table public.qorpera_run_operation_receipts
	drop constraint qorpera_run_operation_receipts_status_check,
	add constraint qorpera_run_operation_receipts_status_check
		check (status in ('executing', 'completed', 'ambiguous', 'cancelled', 'outcome_unknown')) not valid;

alter table public.qorpera_execution_run_events
	drop constraint qorpera_execution_run_events_event_type_check,
	add constraint qorpera_execution_run_events_event_type_check check (event_type in (
		'queued', 'orchestrator_claimed', 'runner_assigned', 'runner_started',
		'lease_renewed', 'infrastructure_retry', 'completed', 'failed',
		'cancelled', 'review_pending', 'provider_session_bound',
		'recovery_released', 'recovery_discarded', 'sponsor_handoff', 'placement_deferred',
		'recovery_acknowledged', 'run_cut_off', 'run_paused'
	)) not valid;

-- A resume supersedes the run's start, as a sponsor handoff did: the next attempt may start once.
select pg_temp.w5a_replace('public.qorpera_run_native_start_superseded(uuid)'::regprocedure,
	$old$where run_id = p_run_id and event_type = 'sponsor_handoff'),0)$old$,
	$new$where run_id = p_run_id and event_type in ('sponsor_handoff','run_cut_off','run_paused')),0) -- 20260930170000 (W5a-1): a resume too$new$);
select pg_temp.w5a_replace('public.qorpera_guard_native_company_execution_start()'::regprocedure,
	$old$handoff.event_type = 'sponsor_handoff'),0)) then$old$,
	$new$handoff.event_type in ('sponsor_handoff','run_cut_off','run_paused')),0)) then -- 20260930170000 (W5a-1): one start after each resume$new$);

-- 3. Usage signals per attempt -------------------------------------------------------------------------------------------

alter table public.qorpera_provider_connection_usage_signals add column assignment_id uuid;
alter table public.qorpera_provider_connection_usage_signals
	drop constraint qorpera_usage_signal_sponsor_epoch,
	add constraint qorpera_usage_signal_attempt unique (run_id, sponsor_version, signal_kind, assignment_id);

select pg_temp.w5a_replace('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
	$old$	insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,
		sponsor_version,provider_connection_id,provider_connection_version,provider,signal_kind,source,resets_at)
	values (v_run.profile_id,v_run.id,v_run.job_id,v_run.sponsor_binding_id,v_run.sponsor_version,
		v_lease.provider_connection_id,v_lease.provider_connection_version,v_connection.provider,
		p_signal_kind,'native_adapter',p_resets_at)
	on conflict (run_id,sponsor_version,signal_kind) do nothing returning * into v_signal;$old$,
	$new$	-- 20260930170000 (W5a-1): one signal of a kind per attempt; a run resumed after its pause may reach the limit again.
	insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,
		sponsor_version,provider_connection_id,provider_connection_version,provider,signal_kind,source,resets_at,assignment_id)
	values (v_run.profile_id,v_run.id,v_run.job_id,v_run.sponsor_binding_id,v_run.sponsor_version,
		v_lease.provider_connection_id,v_lease.provider_connection_version,v_connection.provider,
		p_signal_kind,'native_adapter',p_resets_at,v_lease.assignment_id)
	on conflict (run_id,sponsor_version,signal_kind,assignment_id) do nothing returning * into v_signal;$new$);
select pg_temp.w5a_replace('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
	$old$where run_id = v_run.id and sponsor_version = v_run.sponsor_version and signal_kind = p_signal_kind;$old$,
	$new$where run_id = v_run.id and sponsor_version = v_run.sponsor_version and signal_kind = p_signal_kind
			and assignment_id = v_lease.assignment_id;$new$);

-- 4. The resume ----------------------------------------------------------------------------------------------------------

-- Queues a started run's job again after a cut-off or at its login's usage limit; answers 'cut_off', 'paused', or null
-- when the run takes today's path (it changes nothing then). The caller holds the job FOR UPDATE; the run is read
-- plainly (job before run, as everywhere). A usage limit recorded for this attempt makes it a pause, whatever ended it.
create function public.qorpera_resume_run_from_log(p_job_id uuid, p_reason text, p_cut_off boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_signal public.qorpera_provider_connection_usage_signals%rowtype;
	v_reason text := left(btrim(coalesce(p_reason, '')), 1000);
	v_kind text;
	v_until timestamptz;
begin
	-- 20260930170000 (W5a-1)
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	if not found or v_job.status <> 'leased' or v_job.run_id is null or v_reason = '' then return null; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id and run.job_id = v_job.id;
	-- Started at least once: this attempt, or one before a resume (an attempt cut off again before it started).
	if not found or not public.qorpera_run_resumes_from_log(v_run.id) or v_run.deadline_at <= statement_timestamp()
		or not exists (select 1 from public.qorpera_execution_run_events as started
			where started.run_id = v_run.id and started.event_type = 'runner_started'
				and started.payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		or exists (select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status = 'ambiguous')
		or exists (select 1 from public.qorpera_runner_model_requests as request
			where request.job_id = v_job.id and request.status = 'reserved') then
		return null;
	end if;
	select signal.* into v_signal from public.qorpera_provider_connection_usage_signals as signal
	where signal.run_id = v_run.id and signal.sponsor_version = v_run.sponsor_version
		and signal.signal_kind = 'usage_limit' and signal.assignment_id = v_job.client_lease_id;
	if found then
		v_kind := 'paused';
		-- A reset time already past is no reset time; and the run never comes back at once, to reach the limit again.
		v_until := greatest(case when v_signal.resets_at > statement_timestamp() then v_signal.resets_at
			else v_signal.observed_at + interval '6 hours' end, statement_timestamp() + interval '1 minute');
	elsif p_cut_off and v_job.attempt_count < 8 then
		v_kind := 'cut_off';
	else
		return null;
	end if;
	update public.qorpera_run_operation_receipts
	set status = 'outcome_unknown', completed_at = coalesce(completed_at, statement_timestamp())
	where run_id = v_run.id and status = 'executing';
	-- The attempt's lease ends: its process is fenced from the run's tools, and the next attempt takes a new one.
	with released as (
		delete from public.qorpera_native_provider_connection_leases as lease
		where lease.run_id = v_run.id
		returning lease.*
	)
	insert into public.qorpera_native_provider_connection_lease_history (
		lease_id, run_id, job_id, provider_connection_id, provider_connection_version, credential_capsule_id,
		compute_identity_id, runner_id, assignment_id, status, created_at, expires_at, released_at
	)
	select released.id, released.run_id, released.job_id, released.provider_connection_id,
		released.provider_connection_version, released.credential_capsule_id, released.compute_identity_id,
		released.runner_id, released.assignment_id,
		case when released.status = 'active' then 'revoked' else released.status end,
		released.created_at, released.expires_at, coalesce(released.released_at, statement_timestamp())
	from released;
	-- The login that pays for the run; the next attempt's launch must hold a lease on it (never another login).
	select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_run.id, case v_kind when 'paused' then 'run_paused' else 'run_cut_off' end, jsonb_strip_nulls(jsonb_build_object(
		'schema', 'qorpera.run-resume/v1', 'assignmentId', v_job.client_lease_id, 'reason', v_reason,
		'sponsorVersion', v_run.sponsor_version, 'providerConnectionId', v_sponsor.provider_connection_id,
		'providerConnectionVersion', v_sponsor.provider_connection_version, 'resetsAt', v_until)));
	-- As a pristine retry; a pause waits for the reset on every orchestrator, and its 24 hours in the queue count from
	-- the reset.
	update public.qorpera_runner_jobs
	set status = 'queued', runner_id = null, client_lease_id = null,
		terminal_lease_token_sha256 = lease_token_sha256, lease_token_sha256 = null,
		lease_expires_at = null, last_error = v_reason, queued_at = coalesce(v_until, statement_timestamp()),
		dispatch_deferred_until = case when v_kind = 'paused' then v_until else dispatch_deferred_until end,
		dispatch_refused_by = case when v_kind = 'paused' then null else dispatch_refused_by end,
		attempt_count = case when v_kind = 'paused' then greatest(attempt_count - 1, 0) else attempt_count end
	where id = v_job.id;
	return v_kind;
end
$$;

-- The number of a run's next attempt: its attempts so far, and its pauses (not attempts, but each spent its number).
-- The number names the attempt's machine and runner (runAttemptAcquisitionId), so it never repeats.
create function public.qorpera_run_attempt_number(p_run_id uuid, p_attempt_count integer)
returns integer language sql stable security definer set search_path = '' as $$
	-- 20260930170000 (W5a-1)
	select p_attempt_count + 1 + (select count(*)::integer from public.qorpera_execution_run_events as paused
		where paused.run_id = p_run_id and paused.event_type = 'run_paused')
$$;
select pg_temp.w5a_replace('public.qorpera_execution_work_json(public.qorpera_runner_job_claims)'::regprocedure,
	$old$'attempt', job.attempt_count + 1,$old$,
	$new$'attempt', public.qorpera_run_attempt_number(run.id, job.attempt_count), -- 20260930170000 (W5a-1): a pause spent one$new$);
select pg_temp.w5a_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$select job.attempt_count + 1 into v_attempt from public.qorpera_runner_jobs as job where job.id = v_claim.job_id for update;$old$,
	$new$-- 20260930170000 (W5a-1): the number the claim gave, which counts the run's pauses.
	select public.qorpera_run_attempt_number(job.run_id, job.attempt_count) into v_attempt
	from public.qorpera_runner_jobs as job where job.id = v_claim.job_id for update;$new$);

-- A cut-off: the lease ran out, or the runner was revoked or reset (each passes a pristine retry).
select pg_temp.w5a_replace('public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)'::regprocedure,
	$old$	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
$old$,
	$new$	-- 20260930170000 (W5a-1): a started run that was cut off (or hit its login's usage limit) resumes from its log.
	if p_terminal_status = 'failed' and p_allow_pristine_retry
		and public.qorpera_resume_run_from_log(p_job_id, p_reason, true) is not null then
		select * into v_job from public.qorpera_runner_jobs where id = p_job_id;
		return public.qorpera_runner_job_json(v_job);
	end if;
	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
$new$);

-- The runner's own failure: a retryable one is a cut-off; any failure after a usage limit is a pause.
select pg_temp.w5a_replace('public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)'::regprocedure,
	E'\tv_handoff jsonb;\n',
	E'\tv_handoff jsonb;\n\tv_resumed text;\n');
select pg_temp.w5a_replace('public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)'::regprocedure,
	$old$	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'failed', v_error, p_retryable
	);
$old$,
	$new$	-- 20260930170000 (W5a-1): a started run goes on from its log after a cut-off, or after its login's reset.
	if v_job.run_id is not null then
		v_resumed := public.qorpera_resume_run_from_log(v_job.id, v_error, p_retryable);
		if v_resumed is not null then
			select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
			perform public.qorpera_append_runner_audit(
				v_job.profile_id, p_runner_id, v_job.id, 'job_requeued',
				jsonb_build_object('attempt_count', v_job.attempt_count, 'resumed', v_resumed), null
			);
			return public.qorpera_runner_job_json(v_job);
		end if;
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'failed', v_error, p_retryable
	);
$new$);

-- The next attempt's launch replaces the run's launch row only on the same sponsor version and the same login, with
-- the same bundle and binary, after the old launch went to history (as after a sponsor handoff).
select pg_temp.w5a_replace('public.qorpera_guard_native_launch_replacement()'::regprocedure,
	E'\t\t\twhere run.id=old.run_id\n\t\t) then\n',
	$new$			where run.id=old.run_id
		) and not exists (
			-- 20260930170000 (W5a-1): a resume from the log, on the login the run's sponsor version pays with.
			select 1 from public.qorpera_execution_runs run
			join public.qorpera_runner_jobs job on job.id=run.job_id and job.status='leased'
			cross join lateral (select resumed.payload, resumed.created_at from public.qorpera_execution_run_events resumed
				where resumed.run_id=run.id and resumed.event_type in ('run_cut_off','run_paused')
				order by resumed.id desc limit 1) resumed
			join public.qorpera_native_provider_connection_leases lease on lease.run_id=run.id
				and lease.job_id=job.id and lease.runner_id=job.runner_id
				and lease.assignment_id=job.client_lease_id and lease.status='active'
				and lease.provider_connection_id=(resumed.payload->>'providerConnectionId')::uuid
				and lease.provider_connection_version=(resumed.payload->>'providerConnectionVersion')::bigint
				and lease.expires_at>statement_timestamp()
			join public.qorpera_native_execution_launch_history history on history.run_id=old.run_id
				and history.runtime_bundle_id=old.runtime_bundle_id
				and history.runtime_bundle_sha256=old.runtime_bundle_sha256
				and history.binary_sha256=old.binary_sha256
				and history.reasoning_effort=old.reasoning_effort
				and history.reasoning_policy_sha256=old.reasoning_policy_sha256
				and history.tool_catalog_sha256=old.tool_catalog_sha256
				and history.context_sha256=old.context_sha256
				and history.context_bytes=old.context_bytes and history.launched_at=old.created_at
				and history.superseded_at>=resumed.created_at
			where run.id=old.run_id and run.sponsor_version=(resumed.payload->>'sponsorVersion')::bigint
		) then
$new$);

-- 5. Recovery does not retry an unknown outcome --------------------------------------------------------------------------

select pg_temp.w5a_replace('public.qorpera_resolve_failed_execution_run(uuid,text)'::regprocedure,
	$old$where receipt.run_id = v_run.id and receipt.status = 'completed'$old$,
	$new$where receipt.run_id = v_run.id and receipt.status in ('completed','outcome_unknown') -- 20260930170000 (W5a-1)$new$);
select pg_temp.w5a_replace('public.qorpera_retry_room_delivery(uuid,uuid,bigint)'::regprocedure,
	$old$receipt.status in ('executing','ambiguous','completed'))$old$,
	$new$receipt.status in ('executing','ambiguous','completed','outcome_unknown')) -- 20260930170000 (W5a-1)$new$);

-- 6. Grants and the deploy guard -----------------------------------------------------------------------------------------

revoke all on function public.qorpera_run_resumes_from_log(uuid), public.qorpera_resume_run_from_log(uuid, text, boolean),
	public.qorpera_run_attempt_number(uuid, integer)
	from public, anon, authenticated, service_role;

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_run_resumes_from_log(uuid)', 'public.qorpera_resume_run_from_log(uuid,text,boolean)',
		'public.qorpera_run_attempt_number(uuid,integer)',
		'public.qorpera_execution_work_json(public.qorpera_runner_job_claims)',
		'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)',
		'public.qorpera_run_native_start_superseded(uuid)', 'public.qorpera_guard_native_company_execution_start()',
		'public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
		'public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)',
		'public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)',
		'public.qorpera_guard_native_launch_replacement()', 'public.qorpera_resolve_failed_execution_run(uuid,text)',
		'public.qorpera_retry_room_delivery(uuid,uuid,bigint)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930170000') = 0 then
			raise exception 'W5a-1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
