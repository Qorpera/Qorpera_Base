-- Context tree W4a-2 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §12, §14 W4): the parent step a dispatch or
-- a follow-up names is that call's own step in the sending run's log.
-- * manage_worker's dispatch and follow-up requests to qorpera_folder_worker_commit that name `parentStep` also name
--   `parentCall`: the tool call id the step line records as `call` (1 to 256 characters, no control characters, as W1b's
--   line rule). Each comes only with the other.
-- * Before the commit, the step must be in the sending run's live log (qorpera_memory_run_logs, not retired) as a
--   pending `manage_worker` step with that call id: not finished and not erased. Otherwise 22023, and nothing changes.
--   A dispatch and a follow-up are effectful, so their step line is committed before the call runs (§4.5), and it
--   stays pending until the call returns. So the check is a plain read of the step's row, with no lock.
-- * A request that names no parent step is checked as before: the runtime names one only for a run that writes its log.
-- The worker's run.toml takes its parent and step from the dispatch's row (W1b's qorpera_memory_run_origin), so a
-- worker's log nests under a step that made the call.
-- Every patched body carries the marker 20260930271000 for the deploy guard.

-- A second run stops here, before anything changes.
do $$ begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure),
			'20260930271000') > 0 then
		raise exception 'W4a-2 (20260930271000) is already applied'; end if;
	if to_regclass('public.qorpera_memory_run_steps') is null then
		raise exception 'W4a-2 (20260930271000) needs W1b (20260930231000)'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.w4a2_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W4a-2 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The request's keys and shape ----------------------------------------------------------------------------------------

select pg_temp.w4a2_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$					and (v_action not in ('dispatch','followup') or k not in ('parentStep','view')))$old$,
	$new$					-- 20260930271000 (W4a-2): and the tool call at that step.
					and (v_action not in ('dispatch','followup') or k not in ('parentCall','parentStep','view')))$new$);

select pg_temp.w4a2_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$			or (p_request ->> 'parentStep') !~ '^(0|[1-9][0-9]{0,8})$'))
$old$,
	$new$			or (p_request ->> 'parentStep') !~ '^(0|[1-9][0-9]{0,8})$'))
		-- 20260930271000 (W4a-2): the step's call id comes with the step, and only with it, as a step line's `call` is.
		or (v_action in ('dispatch','followup') and (p_request ? 'parentCall') <> (p_request ? 'parentStep'))
		or (v_action in ('dispatch','followup') and p_request ? 'parentCall' and (jsonb_typeof(p_request -> 'parentCall') <> 'string'
			or char_length(p_request ->> 'parentCall') not between 1 and 256 or (p_request ->> 'parentCall') ~ '[\x01-\x1f\x7f-\x9f]'))
$new$);

-- 2. The step is this call's, pending in the sending run's log ------------------------------------------------------------

select pg_temp.w4a2_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- 20260930171000 (W4a-1): a view is checked against the folder, then carried in its own setting for the index.
$old$,
	$new$	-- 20260930271000 (W4a-2): the parent step is this call's: a pending manage_worker step with its call id in the
	-- sending run's live log. Its line was committed before the call ran and stays pending until the call returns.
	if v_action in ('dispatch','followup') and p_request ? 'parentStep' and not exists (
		select 1 from public.qorpera_memory_run_logs l
		join public.qorpera_memory_run_steps s on s.environment_id = l.environment_id and s.run_id = l.run_id
		where l.environment_id = p_environment_id and l.retired_at is null
			and l.run_id = case when (p_actor ->> 'runId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				then (p_actor ->> 'runId')::uuid end
			and s.j = (p_request ->> 'parentStep')::integer and s.tool = 'manage_worker' and s.call_id = p_request ->> 'parentCall'
			and not s.finished and not s.erased) then
		raise exception 'The parent step is not this call''s pending step in the run''s log' using errcode = '22023'; end if;
	-- 20260930171000 (W4a-1): a view is checked against the folder, then carried in its own setting for the index.
$new$);

-- 3. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure),
			'20260930271000') = 0 then
		raise exception 'W4a-2 marker is missing in qorpera_folder_worker_commit'; end if;
end $guard$;
