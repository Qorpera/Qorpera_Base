-- Runner start in one call (2026-09-29 stack audit, runtime finding "merge the runner prologue").
--
-- Before a run could reach its model, the runner made three serial round trips through two Edge
-- Functions: accept (runner-control), describe and native authority (runner-broker; the latter two
-- RPCs). qorpera_start_runner_assignment composes the same four existing functions in one
-- transaction, with the same arguments the separate calls use, and adds no check of its own:
--
-- 1. qorpera_accept_runner_assignment. Its refusals fail the whole call, exactly as the accept action
--    does (same SQLSTATE, message and HTTP status through runner-control).
-- 2. qorpera_runner_broker_describe, then, only when the caller asks for it (p_native_lease_seconds
--    is not null) and the run's sponsor is a native subscription,
--    qorpera_acquire_native_provider_connection_lease and qorpera_native_run_model_authority, merged
--    the way runner-broker merges them (`model` added to the lease). The lease token is the
--    assignment capability and the run is the accepted job's run, as on the separate path.
--
-- Step 2 runs in a subtransaction. If any of it is refused, it is rolled back, the acceptance stays
-- committed, and `description` and `native_authority` come back null: the runner then makes the
-- separate describe and native authority calls, which produce today's refusal, status and retry
-- behaviour themselves. The combined call never reports a step-2 outcome of its own.
--
-- Lock order. Acceptance locks job -> claim -> runner -> assignment (20260913000200); for a run that
-- is not a member's turn its sponsor check also holds the provider connection FOR SHARE until commit
-- (qorpera_run_autonomous_authority, 20260906000700). The native lease then locks the provider
-- connection FOR UPDATE and lease rows while acceptance's locks are still held; the Company File
-- actor takes connection -> assignment -> runner FOR SHARE (qorpera_company_path_actor). So that
-- holding acceptance's locks can never close a wait cycle, step 2 runs with lock_timeout 50ms: a lock
-- it cannot get at once defers step 2 to the separate calls, which take those locks in their own
-- transactions as before. Any other transaction waits on this one for at most its own short run, far
-- below deadlock_timeout. Autonomous runs on a busy connection therefore often take the separate
-- calls (their FOR UPDATE must wait for the other share holders); member turns mostly do not.
--
-- A new runner facing a database without this function gets PGRST202 from PostgREST, which
-- runner-control reports as 501; the runner then uses the separate calls (the start did nothing).
--
-- A re-queued run's native lease. A run has one native lease row, bound to one assignment (run_id,
-- job_id and assignment_id are unique, 20260821001000). With the start the lease exists from
-- acceptance on, so a start response lost after commit, or a runner lost before it replays, leaves a
-- lease bound to an assignment the lease sweep later retires: the pristine retry gets a new assignment
-- and its acquisition was refused (terminal or expired; bound to another assignment). The same trap
-- already existed between the separate acquisition and the native start. qorpera_terminalize_runner_
-- attempt now releases such a lease when it re-queues the job as a pristine retry: only when no native
-- execution of the run ever started (no qorpera.native-company-execution-start/v1 event, not even one
-- a sponsor handoff superseded), so no model request or tool effect can exist under it. The lease is
-- kept in the lease history (as a sponsor handoff keeps an exhausted binding) and removed; the next
-- attempt acquires its own. The superseded assignment's runner is refused afterwards: its job lease,
-- its assignment and its native lease row are all gone. A lease whose execution started is untouched
-- and follows today's recovery path. It runs after the job row is locked, in the job -> lease order
-- that acquisition, renewal, release and the terminal lease cleanup trigger use.

set local lock_timeout = '3s';

create function public.qorpera_start_runner_assignment(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_assignment_id uuid,
	p_job_id uuid,
	p_assignment_capability_sha256 text,
	p_native_lease_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job jsonb;
	v_description jsonb;
	v_authority jsonb;
	v_lock_timeout text := current_setting('lock_timeout');
begin
	v_job := public.qorpera_accept_runner_assignment(
		p_runner_id, p_session_token_sha256, p_assignment_id, p_job_id, p_assignment_capability_sha256
	);
	begin
		perform set_config('lock_timeout', '50ms', true);
		v_description := public.qorpera_runner_broker_describe(
			p_runner_id, p_session_token_sha256, p_job_id, p_assignment_capability_sha256
		);
		if p_native_lease_seconds is not null
			and v_description #>> '{sponsor,authentication_mode}' = 'native_subscription' then
			v_authority := public.qorpera_acquire_native_provider_connection_lease(
				(v_job ->> 'run_id')::uuid, p_runner_id, p_session_token_sha256, p_assignment_id,
				p_assignment_capability_sha256, p_native_lease_seconds
			) || jsonb_build_object('model', public.qorpera_native_run_model_authority(
				(v_job ->> 'run_id')::uuid, p_runner_id, p_session_token_sha256, p_job_id,
				p_assignment_capability_sha256
			));
		end if;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		-- Rolled back with the subtransaction: the lease, its locks and the lock_timeout.
		v_description := null;
		v_authority := null;
	end;
	return jsonb_build_object('job', v_job, 'description', v_description, 'native_authority', v_authority);
end
$$;

revoke all on function public.qorpera_start_runner_assignment(uuid, text, uuid, uuid, text, integer)
	from public, anon, authenticated;
grant execute on function public.qorpera_start_runner_assignment(uuid, text, uuid, uuid, text, integer)
	to service_role;

create function public.qorpera_release_requeued_native_lease(p_run_id uuid, p_job_id uuid, p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if p_run_id is null or p_job_id is null or p_assignment_id is null or exists (
		select 1 from public.qorpera_execution_run_events as event
		where event.run_id = p_run_id and event.event_type = 'runner_started'
			and event.payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
	) then
		return;
	end if;
	with released as (
		delete from public.qorpera_native_provider_connection_leases as lease
		where lease.run_id = p_run_id and lease.job_id = p_job_id and lease.assignment_id = p_assignment_id
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
end
$$;

revoke all on function public.qorpera_release_requeued_native_lease(uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

-- The pristine retry releases the superseded assignment's unstarted native lease. Patched by exact
-- text so a changed live definition fails here instead of being reverted.
do $patch$
declare
	v_target regprocedure := 'public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old constant text := $old$	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
$old$;
	v_new constant text := $new$	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
	-- A pristine retry takes a new assignment; the run's unstarted native lease was bound to the old one.
	if not v_started and v_job.status = 'leased' and v_result ->> 'status' = 'queued' then
		perform public.qorpera_release_requeued_native_lease(v_job.run_id, v_job.id, v_job.client_lease_id);
	end if;
$new$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Runner start: the pristine retry anchor is not present exactly once';
	end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;
