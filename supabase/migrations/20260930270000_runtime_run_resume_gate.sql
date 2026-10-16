-- Context tree W5a-2 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1, §12, §14 W5): the resume gate reads the
-- run's log, and no attempt of a run starts while a step erase is open on its log.
-- * The gate (W5a-1's qorpera_run_resumes_from_log, off until now): a run resumes or pauses from its log only when it has
--   a live log (W1b's qorpera_memory_run_logs), no step erase is open on it (erase_open on its generation row is clear)
--   and it is not narrow (qorpera_run_log_narrow). Otherwise it takes today's path: cut off, it ends in review; at its
--   usage limit, it fails.
-- * The fence: between a step erase's delete and its rewrite, the run's log lacks a block, so no attempt may start from
--   it. The accept takes the run's generation row FOR SHARE after the job and refuses while erase_open is set
--   (55006 memory_erase_open; runner-control answers 503, the runner's start fails, and the assignment runs out). A step
--   erase's first commit takes the row FOR UPDATE and only then reads the job plainly for a lease, so either the accept
--   lands first and the erase waits for the run to end, or the erase lands first and the accept is refused. The job comes
--   before the generation row on every path that takes both, and the erase never locks the job.
-- * The claim leaves such a job alone (a plain read, so a claim racing an erase's first commit is refused at the accept).
-- Every inserted text names this migration (20260930270000), for the deploy guard.

do $$ begin
	if strpos(coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.qorpera_run_resumes_from_log(uuid)')), ''),
		'20260930270000') > 0 then
		raise exception 'W5a-2 (20260930270000) is already applied'; end if;
	if to_regprocedure('public.qorpera_resume_run_from_log(uuid,text,boolean)') is null then
		raise exception 'W5a-2 (20260930270000) needs W5a-1 (20260930170000)'; end if;
	if to_regclass('public.qorpera_memory_run_generations') is null or to_regclass('public.qorpera_memory_run_logs') is null
		or to_regprocedure('public.qorpera_run_log_narrow(uuid)') is null then
		raise exception 'W5a-2 (20260930270000) needs W1b-1 (20260930231000)'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.w5a2_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W5a-2 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The gate ------------------------------------------------------------------------------------------------------------

-- Whether a run's log can carry it past a cut-off or a pause. Plain reads: the accept below is the fence.
create or replace function public.qorpera_run_resumes_from_log(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930270000 (W5a-2): the run has a live log, no step erase is open on it, and it is not narrow.
	select exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_memory_run_logs as log on log.environment_id = run.environment_id and log.run_id = run.id
			where run.id = p_run_id and log.retired_at is null)
		and not exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_memory_run_generations as erase on erase.environment_id = run.environment_id
				and erase.run_id = run.id
			where run.id = p_run_id and erase.erase_open is not null)
		and not public.qorpera_run_log_narrow(p_run_id)
$$;

-- 2. No attempt starts while a step erase is open ------------------------------------------------------------------------

-- The accept (and the start, which runs it): after the job, the claim, the runner and the assignment, the run's
-- generation row FOR SHARE. A run with no generation row has no log, so no erase can be open on it. A replayed accept of
-- an attempt that already started returns before this, as before.
select pg_temp.w5a2_replace('public.qorpera_accept_runner_assignment(uuid,text,uuid,uuid,text)'::regprocedure,
	E'\tv_run public.qorpera_execution_runs%rowtype;\nbegin\n',
	E'\tv_run public.qorpera_execution_runs%rowtype;\n\tv_erase_open uuid;\nbegin\n');
select pg_temp.w5a2_replace('public.qorpera_accept_runner_assignment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$		raise exception 'runner claim is unavailable' using errcode = '55000';
	end if;
$old$,
	$new$		raise exception 'runner claim is unavailable' using errcode = '55000';
	end if;
	-- 20260930270000 (W5a-2): not while a step erase is open on the run's log (the job first, then the run's row).
	select erase.erase_open into v_erase_open from public.qorpera_memory_run_generations as erase
	where erase.environment_id = v_run.environment_id and erase.run_id = v_run.id for share;
	if v_erase_open is not null then
		raise exception 'memory_erase_open' using errcode = '55006';
	end if;
$new$);

-- The claim leaves the job alone while the erase is open. The text the activation guards look for stays as it is.
select pg_temp.w5a2_replace('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure,
	E'\t\tand public.qorpera_runtime_claim_turn(p_orchestrator_id, job, run)\n',
	$new$		and public.qorpera_runtime_claim_turn(p_orchestrator_id, job, run)
		-- 20260930270000 (W5a-2): not while a step erase is open on the run's log.
		and not exists (select 1 from public.qorpera_memory_run_generations as erase
			where erase.environment_id = run.environment_id and erase.run_id = run.id and erase.erase_open is not null)
$new$);

-- 3. Grants and the deploy guard -----------------------------------------------------------------------------------------

revoke all on function public.qorpera_run_resumes_from_log(uuid) from public, anon, authenticated, service_role;

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_run_resumes_from_log(uuid)',
		'public.qorpera_accept_runner_assignment(uuid,text,uuid,uuid,text)',
		'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930270000') = 0 then
			raise exception 'W5a-2 marker is missing in %', v_function; end if;
	end loop;
	if position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in pg_get_functiondef(
		'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure)) = 0 then
		raise exception 'W5a-2 lost the claim turn'; end if;
end $guard$;
