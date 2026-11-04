-- A claim release by an orchestrator whose provider cannot serve the attempt, because another provider holds the
-- attempt's machine reservation, defers that orchestrator instead of counting a dispatch failure (production
-- 2026-11-04, run dfa2fd28).
--
-- Each attempt of a run has one runner and one machine allocation, both named by the attempt's acquisition id. The
-- LXD provider provisions the runner and reserves the company allocation before the node check; when the node then
-- refuses (NODE_CAPACITY_EXHAUSTED) it keeps the allocation for its next try and the release defers the job, as it
-- should. But the runner now has an allocation, so provisioning never gives it to another provider (20260928235000):
-- the shared execution host's acquire of the same attempt fails with a plain 422 ("Runner provider request failed
-- (422) [code=PROVIDER_ACQUIRE]") whenever it has a free sandbox slot. Each such release counted a dispatch failure.
-- On 4 Nov the job failed after eight (seven from native26-phql-b1, one from native25-phql-a1 after its allocation
-- was released), between deferrals of the node that held the reservation.
--
-- Now, when a release would count and the attempt's allocation is still reserved (released_at null) by a provider
-- adapter other than the releasing orchestrator's, reserved less than 15 minutes ago, with its runner still pending,
-- the release defers the job for 15 seconds and counts nothing. The holder starts the attempt when its node has room,
-- or releases the allocation (its reconcile retires a refused journal); the next counted failure then moves the job
-- to its next attempt (20260928249240), which any node can take.
-- * Who waits follows the node-local typed refusals (20260928180700): this orchestrator only, unless another
--   orchestrator's refuser-only wait is still running; then every orchestrator waits. Two non-holders so never hand
--   the job back and forth with no wait.
-- * The bound: the allocation's reserved_at is set once, at the first reservation (a re-reservation by the holder
--   leaves the row as it is), so 15 minutes after it the release counts again, holder alive or not. A live LXD holder
--   retires a refused reserving journal after 10 idle minutes (RESERVING_RETIREMENT_MS) and releases the allocation;
--   one that is gone never does, and without the bound the run would wait for its deadline. The holder is a provider
--   adapter, which several orchestrators can share, and an orchestrator's heartbeat says nothing about whether its
--   provider will release the allocation, so the bound is not taken from a heartbeat.
-- * A released allocation, an older reservation, an active runner, or a release by the holder's own adapter is
--   counted as before.
-- * Typed admission refusals, the caps of 8 and the backoff (20260930537000) are unchanged.
-- * Locks: none new. The allocation is the row the release already reads; the orchestrator row is read by its key.
-- Every inserted text names this migration (20260930563000), for the deploy guard.
set local lock_timeout = '3s';

create function pg_temp.h1_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930563000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.h1_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$	-- 20260930537000 (G3): every orchestrator waits, longer after each counted failure$old$,
	$new$	-- 20260930563000: another provider has held this attempt's machine reservation for under 15 minutes and its
	-- runner is pending, so this orchestrator's provider cannot provision the attempt. Defer; count nothing.
	if not v_abandoned and v_allocation.id is not null and v_allocation.run_id = v_claim.run_id
		and v_allocation.released_at is null
		and v_allocation.reserved_at > statement_timestamp() - interval '15 minutes'
		and v_allocation.provider_adapter is distinct from (select orchestrator.provider_adapter
			from public.qorpera_runner_orchestrators as orchestrator where orchestrator.id = p_orchestrator_id)
		and exists (select 1 from public.qorpera_runners as runner
			where runner.id = v_allocation.runner_id and runner.status = 'pending') then
		update public.qorpera_runner_jobs
		-- As a node-local typed refusal (20260928180700): another orchestrator's running wait makes every one wait.
		set dispatch_refused_by = case when not (dispatch_refused_by is not null and dispatch_refused_by <> p_orchestrator_id
				and dispatch_deferred_until > statement_timestamp()) then p_orchestrator_id else null end,
			dispatch_deferred_until = statement_timestamp() + interval '15 seconds',
			last_error = btrim(p_error)
		where id = v_claim.job_id and status = 'queued'
		returning * into v_job;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_claim.run_id, 'placement_deferred', jsonb_build_object(
			'assignment_id', v_assignment.id, 'reason', 'ATTEMPT_RESERVED_ELSEWHERE', -- 20260930563000
			'error', btrim(p_error), 'reserved_by', v_allocation.provider_adapter,
			'refused_by', v_job.dispatch_refused_by, 'deferred_until', v_job.dispatch_deferred_until,
			'dispatch_failure_count', v_job.dispatch_failure_count
		));
		return jsonb_build_object(
			'released', true, 'deferred', true,
			'dispatch_failure_count', v_job.dispatch_failure_count,
			'terminal', false
		);
	end if;
	-- 20260930537000 (G3): every orchestrator waits, longer after each counted failure$new$);

do $guard$ begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure), '20260930563000') = 0 then
		raise exception '20260930563000 marker is missing in qorpera_release_runner_job_claim'; end if;
end $guard$;
