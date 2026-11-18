do $$ begin
	if to_regprocedure('public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)') is null
		or to_regprocedure('public.qorpera_run_worker(uuid)') is null
		or to_regclass('public.qorpera_execution_host_principals') is null
		or to_regclass('public.qorpera_claude_worker_leases') is null then
		raise exception '20260930786000 needs runs that follow the placement (20260928183000), execution host principals (20260928469230) and Claude Code workers (20260930770000)';
	end if;
	if position('qorpera_execution_host_principals' in pg_get_functiondef(
		'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure)) > 0 then
		raise exception '20260930786000 is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.cs_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930786000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.cs_replace(
	'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)',
	E'\tselect dispatch_role, provider_adapter into v_role, v_adapter from public.qorpera_runner_orchestrators where id = p_orchestrator_id;\n',
	E'\tif not exists (select 1 from public.qorpera_execution_host_principals as host where host.orchestrator_id = p_orchestrator_id)\n'
	|| E'\t\tand (public.qorpera_run_worker(p_run.id)).harness is not distinct from \'claude-code\' then\n'
	|| E'\t\treturn false;\n'
	|| E'\tend if;\n'
	|| E'\tselect dispatch_role, provider_adapter into v_role, v_adapter from public.qorpera_runner_orchestrators where id = p_orchestrator_id;\n'
);

do $$
declare
	v_turn text := pg_get_functiondef(
		'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure);
	v_proc pg_proc;
begin
	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure;
	if position('qorpera_execution_host_principals' in v_turn) = 0 or position('qorpera_run_worker(p_run.id)' in v_turn) = 0
		or position('20260929999997' in v_turn) = 0 or v_proc.provolatile <> 's' or not v_proc.prosecdef
		or not v_proc.proconfig @> array['search_path=""'] then
		raise exception '20260930786000: the claim turn did not change as expected'; end if;
	if position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in pg_get_functiondef(
		'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure)) = 0 then
		raise exception '20260930786000: the claim no longer asks the claim turn'; end if;
end $$;
