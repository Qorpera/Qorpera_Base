-- A run a member is waiting for is claimed before older wakes, and a full host looks at it again sooner (perf sprint,
-- 7 November 2026).
--
-- The claim took the oldest job. A wake burst (work released at once when a login's usage limit resets, 26 wakes on
-- 6 Nov 2026) therefore stood in front of a member's message: every older wake went first on the fresh-VM path, one each
-- 19 s, and a slot that came free on the execution host went to whichever job's wait had just ended. On 4 Nov 2026 a
-- member's message waited up to 783 s and a room post 1430 s for a run to start, against 0.8 s when nothing was queued.
--
-- 1. The claim takes runs of a member's message (session_turn, room_delivery) first, each kind of work oldest first as
--    before. A wake waits only while such a run is claimable, and members post far more slowly than runs end. Its
--    filters are unchanged, so every run still needs its sponsor, compute, bundle and placement turn. The sort sits on
--    top of the rows those filters leave: the queue index never gave this query its order (profile_id comes first).
-- 2. When a host or node refuses such a run for capacity, it is tried again after 2 seconds instead of 15, so a slot that
--    comes free goes to it rather than to a wake whose wait happens to end first. Each try is one claim and one release.
--    Every other refusal keeps its wait, and a wake keeps 15 seconds.
--
-- Who pays, the login a run uses, authority, leases and caps are unchanged. No lock is added: the claim keeps its FOR UPDATE
-- SKIP LOCKED, and the release reads the run it already names. Both functions are patched in place from
-- pg_get_functiondef, so their settings, grants and earlier patches stay. DB only: running orchestrators call both as
-- before. Every inserted text names this migration (20260930602000), for the deploy guard.
set local lock_timeout = '3s';

create function pg_temp.mf_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930602000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.mf_replace(
	'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)',
	E'\torder by job.created_at, job.id\n',
	E'\t-- 20260930602000: a run a member is waiting for goes before older wakes.\n'
	|| E'\torder by run.source_kind in (''session_turn'', ''room_delivery'') desc, job.created_at, job.id\n'
);

select pg_temp.mf_replace(
	'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)',
	$old$			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')
				then interval '5 seconds' else interval '15 seconds' end,
$old$,
	$new$			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')
				then interval '5 seconds'
				-- 20260930602000: a member is waiting for this run, so a full host looks at it again soon.
				when substr(btrim(p_error), 19) in ('SANDBOX_CAPACITY_EXHAUSTED','SANDBOX_RETIRING','NODE_CAPACITY_EXHAUSTED')
					and (select run.source_kind in ('session_turn', 'room_delivery') from public.qorpera_execution_runs as run
						where run.id = v_claim.run_id)
				then interval '2 seconds'
				else interval '15 seconds' end,
$new$
);

do $guard$ begin
	if strpos(pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure),
			'20260930602000') = 0
		or strpos(pg_get_functiondef('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure),
			'20260930602000') = 0 then
		raise exception '20260930602000 marker is missing'; end if;
end $guard$;
