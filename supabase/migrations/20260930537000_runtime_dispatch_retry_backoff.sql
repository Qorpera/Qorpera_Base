-- A counted dispatch failure, and a fresh retry, make the job wait longer each time (WB-002 G3, production
-- 2026-10-28).
--
-- On 28 Oct WB-002 spent its eight dispatch attempts in about 23 seconds. qorpera_release_runner_job_claim
-- (20260928249240) made the job wait (15 s) only while the attempt's machine was still reserved, and a fresh retry
-- after a lapsed lease was queued again at once. A stall of a minute or two could so fail a run that would have
-- started a little later.
--
-- Now every orchestrator leaves the job alone for qorpera_runner_dispatch_wait(n) = min(15 s × 2^(n-1), 5 min):
-- * after its n-th counted dispatch failure (any claim release that is not a typed admission refusal): 15 s, 30 s,
--   1, 2, 4, then 5 min. The seven waits before the eighth failure add up to 17 min 45 s, so eight failures span
--   about 20 minutes. This takes in the old wait for a reserved machine (its provider releases it meanwhile).
-- * after a fresh (pristine) retry of the job's n-th attempt: its lease lapsed, its runner was revoked or reset
--   for re-pairing, or the runner reported a retryable failure before the start (qorpera_fail_runner_job). A
--   pristine retry follows an accepted attempt, so n >= 1.
-- When the job is queued again (an abandoned attempt, a pristine retry), its queued_at is the end of the wait: the
-- claim turn's head start (20260928183000) goes to the node the placement names once the job can be claimed, and
-- its day in the queue counts from there, as for a pause (20260928519120).
-- * Both caps of 8 are unchanged: the job still fails at its eighth dispatch failure or its eighth attempt.
-- * Typed admission refusals are unchanged (5 s or 15 s, for this orchestrator or for every one).
-- * The claim (qorpera_claim_runner_job_for_orchestrator, 20260916210000) leaves a job alone on every
--   orchestrator while dispatch_deferred_until is in the future and dispatch_refused_by is null. It is the only
--   claim of run work: the runners' own claim was revoked (20260820002000).
-- * The resume of a cut-off started run from its log (20260928519120) is unchanged: it is queued again at once.
-- * Authorization, leases, receipts and locks are unchanged. No new lock is taken.
-- Every inserted text names this migration (20260930537000), for the deploy guard.
set local lock_timeout = '3s';

-- The wait after a job's n-th counted dispatch failure, or after a pristine retry of its n-th attempt. The
-- exponent stops at 5, which is past the 5-minute cap, so a large n cannot overflow the interval.
create function public.qorpera_runner_dispatch_wait(p_count integer)
returns interval
language sql
immutable
set search_path = ''
as $$
	-- 20260930537000 (G3)
	select least(interval '15 seconds' * power(2, least(greatest(coalesce(p_count, 1), 1), 6) - 1),
		interval '5 minutes')
$$;
revoke all on function public.qorpera_runner_dispatch_wait(integer) from public, anon, authenticated, service_role;

create function pg_temp.g3_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930537000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The claim release: every counted failure waits; the reserved-machine case needs no flag of its own (its
-- declaration goes after its last use).
select pg_temp.g3_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$	elsif found and v_allocation.run_id = v_claim.run_id and v_allocation.released_at is null
		and exists (select 1 from public.qorpera_runners as runner where runner.id = v_allocation.runner_id and runner.status = 'pending') then
		-- The attempt's machine is still reserved: its provider releases it (the LXD provider on its next
		-- reconcile). Every orchestrator waits a moment instead of spending the retries on refusals.
		v_machine_pending := true;
	end if;
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		attempt_count = attempt_count + case when v_abandoned then 1 else 0 end,
		-- The next attempt is queued again: the claim turn's head start goes to the node the placement names.
		queued_at = case when v_abandoned then statement_timestamp() else queued_at end,
		dispatch_refused_by = case when v_machine_pending then null else dispatch_refused_by end,
		dispatch_deferred_until = case when v_machine_pending then statement_timestamp() + interval '15 seconds'
			else dispatch_deferred_until end,
		last_error = btrim(p_error)$old$,
	$new$	end if;
	-- 20260930537000 (G3): every orchestrator waits, longer after each counted failure (dispatch_failure_count is
	-- the count before this one), instead of spending the retries within seconds. A machine still reserved for
	-- the attempt is released by its provider meanwhile (the LXD provider on its next reconcile).
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		attempt_count = attempt_count + case when v_abandoned then 1 else 0 end,
		-- The next attempt is queued again when the wait ends: the claim turn's head start goes to the node the
		-- placement names, and its day in the queue counts from there.
		queued_at = case when v_abandoned
			then statement_timestamp() + public.qorpera_runner_dispatch_wait(dispatch_failure_count + 1)
			else queued_at end,
		dispatch_refused_by = null,
		dispatch_deferred_until = statement_timestamp() + public.qorpera_runner_dispatch_wait(dispatch_failure_count + 1),
		last_error = btrim(p_error)$new$);
select pg_temp.g3_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	E'\tv_machine_pending boolean := false;\n',
	'');
select pg_temp.g3_replace('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure,
	$old$		'start_failed_node_id', v_failed_node
	));$old$,
	$new$		'start_failed_node_id', v_failed_node,
		-- 20260930537000 (G3): the end of the wait, while the job waits for another attempt.
		'deferred_until', case when v_job.status = 'queued' then v_job.dispatch_deferred_until end
	));$new$);

-- The pristine retry: it waits as long, keyed by the attempt it retries, and is queued from the end of the wait.
select pg_temp.g3_replace('public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)'::regprocedure,
	$old$lease_expires_at = null, last_error = v_reason, queued_at = statement_timestamp()$old$,
	$new$lease_expires_at = null, last_error = v_reason,
			-- 20260930537000 (G3): every orchestrator waits after the job's n-th attempt, as after its n-th
			-- counted dispatch failure, and the job is queued from the end of the wait.
			queued_at = statement_timestamp() + public.qorpera_runner_dispatch_wait(attempt_count),
			dispatch_refused_by = null,
			dispatch_deferred_until = statement_timestamp() + public.qorpera_runner_dispatch_wait(attempt_count)$new$);

do $guard$ begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure), '20260930537000') = 0
		or strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)'::regprocedure),
			'20260930537000') = 0
		or strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_runner_dispatch_wait(integer)'::regprocedure), '20260930537000') = 0 then
		raise exception '20260930537000 marker is missing'; end if;
end $guard$;
