-- A run's attempt whose runner activated but never started, and whose machine was released, moves on (WB-002 F2,
-- production 2026-10-28).
--
-- Each attempt of a run has one runner and one machine allocation, both named by the attempt's acquisition id
-- (runAttemptAcquisitionId; a runner holds one allocation ever). 20260928249240 moves a run past an attempt whose
-- machine was released while its runner was still pending. On 28 Oct the attempt's runner had activated: the machine
-- came up (16:04:37Z), the orchestrator offered it the assignment (16:04:43Z), the runner never accepted it, and node
-- inventory released the machine (16:05:18Z). The reconcile let the orchestrator's claim expire, which moves nothing.
-- Every later claim was the same attempt, so the providers asked for the same runner: the shared execution host is
-- given back an active runner it cannot replay ("runner already active"), and the other node's provider is refused it
-- (23505, other compute authority). Each release counted one dispatch failure and left the attempt as it was, so the
-- run failed after eight.
--
-- Now the claim release (when it counts an infrastructure failure) also revokes an active runner of the attempt whose
-- allocation is released, if that runner never started an attempt: it accepted no assignment of the run and holds no
-- leased job. The revocation clears its sessions. The job then moves to its next attempt, as for a pending runner: the
-- next claim gets a new acquisition id, so a new runner, allocation and placement row. Provisioning and the providers
-- are unchanged.
-- * A runner with a live allocation (released_at null) is never touched: the branch needs the allocation released.
-- * The old runner can never start the run: revoked, it has no valid session (qorpera_runner_session_valid), so
--   its acceptance (and so its start, which accepts first) and its heartbeat are refused; activation needs a pending
--   runner; provisioning refuses a revoked one (55000). An acceptance in flight serializes with the release on the
--   job row (both lock it first) and then finds the claim released or the runner revoked.
-- * At most one runner executes an attempt: the old runner never accepted, and the new attempt has its own runner.
-- * The caps: an abandoned attempt adds one to the attempt count and one to the dispatch failure count, as for a
--   pending runner. The dispatch failure count already counts every release and never resets, and the job fails when
--   either count reaches 8. Without this change every retry of such an attempt fails (no provider can start its
--   runner again), so the job only fails later, after the same eight releases. With it, the job gets a fresh attempt
--   instead, or fails with "Runner failed to start on its final attempt" when the attempt count reaches 8.
-- Locks: as before (the job row, the claim and the assignment, then the runner row). The assignment check reads the
-- run's assignments by their run index, and the job check reads the jobs by their runner index, after the runner lock.
-- Every inserted text names this migration (20260930535000), for the deploy guard.
set local lock_timeout = '3s';

create function pg_temp.f2_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930535000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.f2_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$	-- The attempt's machine was reserved, then released, and its runner never activated (20260929240000):
	-- a runner holds one allocation ever, so this attempt can start nowhere. Revoke the runner, record the
	-- node that failed and move the job to its next attempt.
	select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
	where allocation.id = public.qorpera_run_attempt_acquisition_id(v_claim.run_id, v_attempt);
	if found and v_allocation.run_id = v_claim.run_id and v_allocation.released_at is not null then
		select runner.* into v_runner from public.qorpera_runners as runner
		where runner.id = v_allocation.runner_id and runner.status = 'pending' for update;
		if found then
			update public.qorpera_runners
			set status = 'revoked', revoked_by_user_id = v_runner.registered_by_user_id, revoked_at = statement_timestamp()
			where id = v_runner.id;$old$,
	$new$	-- The attempt's machine was reserved, then released, and its runner never started the attempt: it never
	-- activated (20260929240000), or it activated and never accepted (20260930535000, WB-002). A runner holds
	-- one allocation ever, so this attempt can start nowhere. Revoke the runner (with its sessions), record
	-- the node that failed and move the job to its next attempt.
	select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
	where allocation.id = public.qorpera_run_attempt_acquisition_id(v_claim.run_id, v_attempt);
	if found and v_allocation.run_id = v_claim.run_id and v_allocation.released_at is not null then
		select runner.* into v_runner from public.qorpera_runners as runner
		where runner.id = v_allocation.runner_id and runner.status in ('pending', 'active') for update;
		-- 20260930535000: an active runner only if it never started an attempt, read under its lock: no
		-- assignment of the run it accepted, no job it holds.
		if found and (v_runner.status = 'pending' or not (
			exists (select 1 from public.qorpera_runner_assignments as assignment
				where assignment.run_id = v_claim.run_id and assignment.runner_id = v_runner.id
					and (assignment.accepted_at is not null or assignment.status in ('accepted', 'completed', 'failed')))
			or exists (select 1 from public.qorpera_runner_jobs as job
				where job.runner_id = v_runner.id and job.status = 'leased'))) then
			update public.qorpera_runners
			set status = 'revoked', session_token_sha256 = null, session_expires_at = null,
				previous_session_token_sha256 = null, previous_session_expires_at = null,
				last_renewal_id = null, revoked_by_user_id = v_runner.registered_by_user_id,
				revoked_at = statement_timestamp()
			where id = v_runner.id;$new$);
select pg_temp.f2_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$					'allocation_id', v_allocation.id,
					'provider_adapter', v_runner.provider_adapter
				),$old$,
	$new$					'allocation_id', v_allocation.id,
					'provider_adapter', v_runner.provider_adapter,
					'runner_status', v_runner.status -- 20260930535000: pending, or active and never started
				),$new$);

do $guard$ begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure), '20260930535000') = 0 then
		raise exception '20260930535000 marker is missing in qorpera_release_runner_job_claim'; end if;
end $guard$;
