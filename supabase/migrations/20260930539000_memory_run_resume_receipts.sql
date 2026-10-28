-- 20260930539000: In Agent notebooks mode, a started run that is cut off resumes from its own receipts (WB-001 G1 b,
-- production 28 Oct 2026).
--
-- A run in Agent notebooks mode (qorpera_execution_runs.memory_mode, 20260930508000) keeps no run log, so the resume gate
-- (qorpera_run_resumes_from_log, 20260930270000) was off for it: cut off mid-task, it failed and waited for review. Now
-- it goes on in the same task, job and run, as a run with a log does (20260930170000), and the next attempt is told
-- what the earlier ones did from the run's own operation receipts:
-- 1. qorpera_run_resumes_from_receipts: the run is in Agent notebooks mode, has no log and is no coding session's turn
--    (that turn never reads a resume). Nobody may call it.
-- 2. The gate accepts such a run as it accepts a run with a live log. No step erase can be open on it (it has no log),
--    and a narrow run still takes today's path.
-- 3. The cut-off (qorpera_resume_run_from_log) resumes it; at its login's usage limit it ends as before, with no pause.
-- 4. qorpera_memory_run_resume_receipts (service_role, through the run's binding) returns the run's completed receipts
--    (the newest 64) and its outcome_unknown ones, each by its key and status; null for an original attempt or a run
--    that keeps a log. It returns no stored result: the run may never have seen one (the check of the call's authority
--    before its release refused it, or the run was cut off first), and only a replay, which checks that authority
--    again, returns it. A resumed attempt of a run that no longer resumes (its machine made it narrow) is refused
--    (55000), so it fails. Only the platform reads it, to build the resumed attempt's first message.
-- 5. The resume record (qorpera_memory_run_resume_record) accepts such a run with no steps read, and still needs every
--    unknown receipt listed (20260930340000).
-- 6. Until the resumed attempt has recorded that, its first receipt is refused (55000), a replay too.
-- Unchanged: the run, its job and its id; both caps of 8 (a cut-off is an attempt); a receipt key with the same inputs
-- replays its stored result, an outcome_unknown key never runs again, other inputs under a key are refused (23505);
-- refusals stay final; the receipts table, its grants and its lifecycle. Nothing new is stored: the record is the
-- existing qorpera_memory_run_resumes row (receipt ids and keys, no results), removed with the run. No company-folder
-- write, memory-mode, retention, erasure or approval change. A run in Agent tree mode is as before.
-- Deploy order: this migration before the runtime that reads it. Meanwhile a resumed run on an older runtime is
-- refused at its first receipt and never repeats an effect.
-- Every inserted text names this migration (20260930539000), for the deploy guard.

do $$ begin
	if to_regprocedure('public.qorpera_memory_run_resume_receipts(jsonb)') is not null then
		raise exception '20260930539000 (G1 b) is already applied'; end if;
	if strpos(coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.qorpera_run_resumes_from_log(uuid)')), ''),
		'20260930270000') = 0
		or to_regprocedure('public.qorpera_resume_run_from_log(uuid,text,boolean)') is null
		or to_regprocedure('public.qorpera_memory_run_resume_record(jsonb,jsonb)') is null
		or to_regprocedure('public.qorpera_memory_run_resume_of(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)') is null
		or not exists (select 1 from pg_attribute where attrelid = 'public.qorpera_execution_runs'::regclass
			and attname = 'memory_mode' and not attisdropped) then
		raise exception '20260930539000 (G1 b) needs W5a-2 (20260930270000), W5b-2 (20260930340000) and 20260930508000'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.g1b_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930539000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Which run resumes from its receipts --------------------------------------------------------------------------------

-- Plain reads. A coding session's turn is its worker's dispatch wake of the coding species (as
-- qorpera_authorize_coding_turn reads it).
create function public.qorpera_run_resumes_from_receipts(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930539000 (G1 b): an Agent notebooks run with no log, and no coding session's turn.
	select exists (select 1 from public.qorpera_execution_runs as run
		where run.id = p_run_id and run.memory_mode is distinct from 'tree'
			and not exists (select 1 from public.qorpera_memory_run_logs as log
				where log.environment_id = run.environment_id and log.run_id = run.id)
			and not exists (select 1 from public.qorpera_wake_occurrences as wake
				where wake.run_id = run.id and wake.source_kind = 'worker-dispatch' and wake.payload ->> 'species' = 'coding'))
$$;
revoke all on function public.qorpera_run_resumes_from_receipts(uuid) from public, anon, authenticated, service_role;

-- 2. The gate ------------------------------------------------------------------------------------------------------------

create or replace function public.qorpera_run_resumes_from_log(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930270000 (W5a-2): the run has a live log, no step erase is open on it, and it is not narrow.
	-- 20260930539000 (G1 b): or, with no log, it resumes from its receipts.
	select (exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_memory_run_logs as log on log.environment_id = run.environment_id and log.run_id = run.id
			where run.id = p_run_id and log.retired_at is null)
			or public.qorpera_run_resumes_from_receipts(p_run_id))
		and not exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_memory_run_generations as erase on erase.environment_id = run.environment_id
				and erase.run_id = run.id
			where run.id = p_run_id and erase.erase_open is not null)
		and not public.qorpera_run_log_narrow(p_run_id)
$$;
revoke all on function public.qorpera_run_resumes_from_log(uuid) from public, anon, authenticated, service_role;

-- 3. No pause --------------------------------------------------------------------------------------------------------------

-- The resume returns null before it changes anything, so the run takes today's path: it fails.
select pg_temp.g1b_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)'::regprocedure,
	E'\tif found then\n\t\tv_kind := ''paused'';\n',
	E'\tif found then\n\t\t-- 20260930539000 (G1 b): a run that resumes from its receipts never pauses; at its usage limit it ends as before.\n'
	|| E'\t\tif public.qorpera_run_resumes_from_receipts(v_run.id) then return null; end if;\n\t\tv_kind := ''paused'';\n');

-- 4. The resumed attempt's earlier receipts -------------------------------------------------------------------------------

-- Null for an original attempt, or for a run that does not resume from its receipts. Otherwise {schema, why, receipts,
-- completedOmitted}: each receipt is {receiptId, logicalOperationKey, status}, oldest first, never with its result.
-- Every outcome_unknown receipt is listed, and the newest 64 completed ones; completedOmitted counts the older completed
-- ones left out.
create function public.qorpera_memory_run_resume_receipts(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930539000 (G1 b)
declare v_tool jsonb; v_run uuid; v_resume jsonb; v_receipts jsonb; v_omitted integer;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := (v_tool #>> '{run,id}')::uuid;
	if not public.qorpera_run_resumes_from_receipts(v_run) then return null; end if;
	v_resume := public.qorpera_memory_run_resume_of(v_run, (v_tool #>> '{actor,assignmentId}')::uuid,
		(p_binding ->> 'leaseId')::uuid);
	if v_resume is null then return null; end if;
	if not public.qorpera_run_resumes_from_log(v_run) then
		raise exception 'Run resume is unavailable' using errcode = '55000'; end if;
	with shown as (
		select c.id, c.logical_operation_key, 'completed' as status, c.created_at
		from (select r.id, r.logical_operation_key, r.created_at from public.qorpera_run_operation_receipts as r
			where r.run_id = v_run and r.status = 'completed' order by r.created_at desc, r.id desc limit 64) as c
		union all
		select r.id, r.logical_operation_key, 'outcome_unknown', r.created_at
		from public.qorpera_run_operation_receipts as r
		where r.run_id = v_run and r.status = 'outcome_unknown'
	)
	select coalesce(jsonb_agg(jsonb_build_object('receiptId', s.id, 'logicalOperationKey', s.logical_operation_key,
		'status', s.status) order by s.created_at, s.id), '[]'::jsonb) into v_receipts
	from shown as s;
	select greatest(count(*) - 64, 0)::integer into v_omitted from public.qorpera_run_operation_receipts as r
	where r.run_id = v_run and r.status = 'completed';
	return jsonb_build_object('schema', 'qorpera.memory-run-resume-receipts/v1', 'why', v_resume ->> 'why',
		'receipts', v_receipts, 'completedOmitted', v_omitted);
end $$;
revoke all on function public.qorpera_memory_run_resume_receipts(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_run_resume_receipts(jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_run_resume_receipts', 'binding');

-- 5. The record ------------------------------------------------------------------------------------------------------------

select pg_temp.g1b_replace('public.qorpera_memory_run_resume_record(jsonb,jsonb)'::regprocedure,
	$old$		if not public.qorpera_run_resumes_from_log(v_run.id) or not exists (
			select 1 from public.qorpera_memory_run_logs l where l.environment_id = v_run.environment_id
				and l.run_id = v_run.id and l.retired_at is null and l.step_count = v_steps) then
			raise exception 'Run resume log is unavailable or changed' using errcode = '55000'; end if;
$old$,
	$new$		if not public.qorpera_run_resumes_from_log(v_run.id) or not (exists (
			select 1 from public.qorpera_memory_run_logs l where l.environment_id = v_run.environment_id
				and l.run_id = v_run.id and l.retired_at is null and l.step_count = v_steps)
			-- 20260930539000 (G1 b): a run with no log resumes from its receipts, having read no steps.
			or (v_steps = 0 and public.qorpera_run_resumes_from_receipts(v_run.id))) then
			raise exception 'Run resume log is unavailable or changed' using errcode = '55000'; end if;
$new$);

-- 6. No effect before the record -------------------------------------------------------------------------------------------

-- Nested, so the resume is read only for a run with no log that has not recorded it.
select pg_temp.g1b_replace('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure,
	E'\tperform public.qorpera_assert_wake_work_allowed(v_run.id);\n',
	$new$	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- 20260930539000 (G1 b): a resumed attempt of a run with no log records the earlier receipts it was told first.
	if public.qorpera_run_resumes_from_receipts(v_run.id) and not exists (select 1 from public.qorpera_memory_run_resumes as resume
		where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
		if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
			(p_binding ->> 'leaseId')::uuid) is not null then
			raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
	end if;
$new$);

-- The deploy guard ---------------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_run_resumes_from_receipts(uuid)',
		'public.qorpera_run_resumes_from_log(uuid)',
		'public.qorpera_resume_run_from_log(uuid,text,boolean)',
		'public.qorpera_memory_run_resume_receipts(jsonb)',
		'public.qorpera_memory_run_resume_record(jsonb,jsonb)',
		'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930539000') = 0 then
			raise exception '20260930539000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_run_resumes_from_log(uuid)'::regprocedure),
		'20260930270000') = 0 then
		raise exception '20260930539000 lost the W5a-2 gate'; end if;
end $guard$;
