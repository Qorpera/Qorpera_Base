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
-- Lock order. Acceptance locks job -> claim -> runner -> assignment (20260913000200). The native
-- lease then locks the provider connection FOR UPDATE and lease rows, while acceptance's locks are
-- still held; the Company File actor takes connection -> assignment -> runner FOR SHARE
-- (qorpera_company_path_actor). So that holding acceptance's locks can never close a wait cycle,
-- step 2 runs with lock_timeout 50ms: a lock it cannot get at once defers step 2 to the separate
-- calls, which take those locks in their own transactions as before. Any other transaction waits on
-- this one for at most its own short run, far below deadlock_timeout.
--
-- A new runner facing a database without this function gets PGRST202 from PostgREST, which
-- runner-control reports as 501; the runner then uses the separate calls (the start did nothing).

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
