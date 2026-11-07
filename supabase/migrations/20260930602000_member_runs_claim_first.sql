-- A run a member is waiting for is claimed before older wakes, and a full fast host looks at it again sooner (perf
-- sprint, 7 November 2026).
--
-- The claim took the oldest job. A wake burst (work released at once when a login's usage limit resets, 26 wakes on
-- 6 Nov 2026) therefore stood in front of a member's message: every older wake went first on the fresh-VM path, one each
-- 19 s, and a slot that came free on the execution host went to whichever job's wait had just ended. On 4 Nov 2026 a room
-- post waited up to 1430 s for its run to start, against 0.8 s when nothing was queued.
--
-- qorpera_run_member_waits(run) says who that is: a room delivery (only a member's own message makes one, 20260928539230),
-- or a session turn with a member's message. A hire's kickoff is not: a session turn whose only input is a kickoff is one
-- of the runs no member waits on, by the same test as qorpera_resolve_run_reasoning_effort (20260930532000).
--
-- 1. The claim takes those runs first, each class oldest first as before. A wake waits only while such a run is claimable,
--    and members post far more slowly than runs end. The claim's filters are unchanged, so every run still needs its
--    sponsor, compute, bundle and placement turn. The sort sits on top of the rows those filters leave: the queue index
--    never gave this query its order (profile_id comes first).
-- 2. When a fast host refuses such a run because it is full or retiring, the run comes back after 2 seconds instead of
--    15, so a slot that comes free goes to it rather than to a wake whose wait happens to end first. Each try is one claim
--    and one release: the execution host refuses before it provisions anything.
--    * That 2 s never shortens a wait already running. Another orchestrator's wait stands, whatever made it.
--    * A node's refusal of a fresh VM (NODE_CAPACITY_EXHAUSTED) keeps 15 s, also for such a run. Each of those tries is a
--      whole LXD acquire and leaves the attempt bound to that provider (20260930563000): no other provider can start
--      the attempt while it holds the machine row, so a fast host's next try would fail. It also stays equal to the 15 s
--      in qorpera_runtime_refused_recently, as 20260928183000 asks: the overflow's own refusal spaces its own tries.
--    * The other direction is deliberate. A fast host's refusal still counts as recent for 15 s, after its 2 s wait has
--      ended. So the overflow may take the run in that time as it did before, and the fast host's next try usually
--      comes first: it asks every 250 ms, the overflow every 2 s (test 810).
--    Every other refusal keeps its wait, and every wake keeps 15 s.
--
-- Who pays, the login a run uses, authority, leases and caps are unchanged. No lock is added: the claim keeps its FOR
-- UPDATE SKIP LOCKED, and the release reads the run it already names. Both functions are patched in place from
-- pg_get_functiondef, so their settings, grants and earlier patches stay. DB only: running orchestrators call both as
-- before. Every inserted text names this migration (20260930602000), for the deploy guard.
set local lock_timeout = '3s';

create function public.qorpera_run_member_waits(p_run public.qorpera_execution_runs)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930602000
	select case p_run.source_kind
		when 'room_delivery' then true
		when 'session_turn' then not (
			exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind = 'kickoff')
			and not exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind is distinct from 'kickoff'))
		else false end
$$;
revoke all on function public.qorpera_run_member_waits(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role;

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
	|| E'\torder by public.qorpera_run_member_waits(run) desc, job.created_at, job.id\n'
);

select pg_temp.mf_replace(
	'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)',
	$old$			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')
				then interval '5 seconds' else interval '15 seconds' end,
$old$,
	$new$			dispatch_deferred_until = case
				-- 20260930602000: a member is waiting for this run, so a full fast host looks at it again soon. A wait
				-- already running stands.
				when substr(btrim(p_error), 19) in ('SANDBOX_CAPACITY_EXHAUSTED','SANDBOX_RETIRING')
					and (select public.qorpera_run_member_waits(run) from public.qorpera_execution_runs as run
						where run.id = v_claim.run_id)
				then greatest(statement_timestamp() + interval '2 seconds', dispatch_deferred_until)
				else statement_timestamp() + case when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')
					then interval '5 seconds' else interval '15 seconds' end end,
$new$
);

do $guard$ begin
	if strpos(pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure),
			'20260930602000') = 0
		or strpos(pg_get_functiondef('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure),
			'20260930602000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_run_member_waits(public.qorpera_execution_runs)'::regprocedure), '20260930602000') = 0 then
		raise exception '20260930602000 marker is missing'; end if;
end $guard$;
