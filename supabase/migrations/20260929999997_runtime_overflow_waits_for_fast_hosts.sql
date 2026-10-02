-- With dispatch roles (identical nodes change 3, 20260928183000) and a fast host on each node, a run that one
-- fast host refuses for capacity could go to the fresh-VM overflow at once (about 17 s to start), racing the
-- other node's fast host, which takes it in about 2 s. The overflow now takes such a run at once only when no
-- fast host the run may use is left to try it: every fast host in the run's placement has refused it recently.
-- Otherwise the other fast host takes it (it may claim at once after the preferred node refused), and the
-- overflow keeps its 10 s fallback, so a fast host that stays silent never holds a run back for long.
-- Unchanged: work the fast hosts do not serve (NODE_NOT_PREFERRED from a fast host) goes to the overflow at once,
-- and NO_FAST_HOST lets it claim at once.
-- The claim turn stays `stable` and takes no lock: it reads the placement it already reads, and the claims of
-- this run (qorpera_runtime_refused_recently). SQL test 810; test 643 updated.

set local lock_timeout = '5s';

create function pg_temp.overflow_waits_patch(p_target regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $$
declare v_definition text := pg_catalog.pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor) <> 1 then
		raise exception 'Overflow wait: the anchor in % is not there exactly once', p_target; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$$;

select pg_temp.overflow_waits_patch('public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure,
$anchor$		if ((v_error in ('ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED', 'ADMISSION_REFUSED:SANDBOX_RETIRING')
				and p_job.dispatch_refused_by is distinct from p_orchestrator_id)
$anchor$,
$replacement$		-- 20260929999997: only once every fast host the run may use has refused it recently; until then the other
		-- fast host takes it.
		if ((v_error in ('ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED', 'ADMISSION_REFUSED:SANDBOX_RETIRING')
				and p_job.dispatch_refused_by is distinct from p_orchestrator_id
				and not exists (select 1 from jsonb_array_elements(public.qorpera_runtime_run_placement(p_job, p_run) -> 'fast') as fast_host
					where not public.qorpera_runtime_refused_recently(p_job.run_id, (fast_host ->> 'orchestratorId')::uuid)))
$replacement$);
