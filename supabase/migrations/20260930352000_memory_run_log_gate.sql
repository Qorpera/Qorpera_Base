-- Context tree W1c-3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §14 W1): run logs turn on only for the
-- companies in qorpera_memory_tree_companies (M1's list), until W1d (erasure of work) is live.
-- * One gate, in SQL: qorpera_memory_run_log_place answers {off: true} for a run of a company not on the list, where it
--   would have placed a new log. The runtime then makes no log and the run takes today's path, so the runtime needs no
--   flag of its own.
-- * A log already made goes on (place answers it as before, listed or not), and a log made once and no longer there
--   still answers gone.
-- * Gone is only that: a run with no conversation tree (or one the place does not know) keeps no log, so it answers
--   off too. A resumed attempt that finds its log gone then ends, as a run does when its log goes mid-run, and never
--   goes on unlogged past its earlier steps.
-- * When W1d (erasure of work) is live, every folder-v2 company gets run logs: W1d drops the list gate (1), in this one
--   place. The home-less answer (2) stays.
-- Every inserted text names this migration (20260930352000), for the deploy guard.

do $$ begin
	if strpos(coalesce((select prosrc from pg_proc
			where oid = to_regprocedure('public.qorpera_memory_run_log_place(uuid,uuid)')), ''), '20260930352000') > 0 then
		raise exception 'W1c-3 (20260930352000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_run_log_place(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_memory_run_log_home(uuid,uuid)') is null then
		raise exception 'W1c-3 (20260930352000) needs W1b-1 (20260930231000)'; end if;
	if to_regclass('public.qorpera_memory_tree_companies') is null then
		raise exception 'W1c-3 (20260930352000) needs the memory tree company list (20260930204000)'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.w1c3_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W1c-3 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The gate ------------------------------------------------------------------------------------------------------------

-- After the live log and the gone answers, before the new log's home: a known run of a company not on the list is off.
select pg_temp.w1c3_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	E'\tv_home := public.qorpera_memory_run_log_home(p_environment_id, p_run_id);\n',
	$new$	-- 20260930352000 (W1c-3): run logs only for listed companies, until W1d (erasure of work) is live: then this gate
	-- drops here, in one place. A log already made goes on.
	if exists (select 1 from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id
		and not exists (select 1 from public.qorpera_memory_tree_companies c where c.profile_id = r.profile_id)) then
		return jsonb_build_object('off', true); end if;
	v_home := public.qorpera_memory_run_log_home(p_environment_id, p_run_id);
$new$);

-- 2. No conversation tree, no log ----------------------------------------------------------------------------------------

select pg_temp.w1c3_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	E'\tif v_home is null then return jsonb_build_object(''gone'', true); end if;\n',
	$new$	-- 20260930352000 (W1c-3): a run with no conversation tree keeps no log (off); gone is only a log made once and
	-- no longer there.
	if v_home is null then return jsonb_build_object('off', true); end if;
$new$);

-- 3. The deploy guard (create or replace keeps the function's grants) ----------------------------------------------------

do $guard$
declare v_source text := (select prosrc from pg_proc
	where oid = 'public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure);
begin
	if strpos(v_source, '20260930352000') = 0 then
		raise exception 'W1c-3 marker is missing in qorpera_memory_run_log_place'; end if;
	if strpos(v_source, '20260930231000') = 0
		or strpos(v_source, 'v_home := public.qorpera_memory_run_log_home(p_environment_id, p_run_id);') = 0 then
		raise exception 'W1c-3 lost the place'; end if;
	if strpos(v_source, 'return jsonb_build_object(''off'', true)') not between 1 and strpos(v_source, 'v_home := ') then
		raise exception 'W1c-3 gate is not before the home'; end if;
	if strpos(v_source, 'if v_home is null then return jsonb_build_object(''off'', true); end if;') = 0
		or strpos(v_source, 'if v_home is null then return jsonb_build_object(''gone'', true)') > 0 then
		raise exception 'W1c-3 left a home-less run gone'; end if;
end $guard$;
