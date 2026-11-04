-- Listener routines, L1 (deploy/first-node/RUNTIME-LISTENER-ROUTINES.md; Jonas, 4 November 2026: "we can put out
-- listeners for a task and activate it 'when x is done'"). Folder-v2 only.
--
-- A dynamic routine's file (`when: once`) may name a todo or a human task with `after: <path>`. Its next run then waits
-- until nothing open is left at that path (the todo done or cancelled, the task done, accepted, declined or cancelled,
-- or the file deleted), or until `at`, whichever comes first: `at` is the fallback, so nothing waits forever. The run is
-- an ordinary dynamic routine run; it decides next (with or without a new `after`) or concludes.
--
-- * The file: `after` is checked by its shape (qorpera_company_state_parse_problems: a one-line path whose folder key is
--   a todo or a human task file) and by the rules (qorpera_company_state_routine_rules: a live todo or human task of
--   this company at that key). The version's trigger (qorpera_company_state_routine_trigger) carries the folded key as
--   `after`, and qorpera_cloud_routine_trigger_valid takes it, so a new `after` is a new version like a new `at`.
--   A decision may change or drop `after` like `at` (the review class and the decision rule already let a decision
--   change the whole trigger).
-- * The firing: nothing new is written when a todo or a task closes. The folder tick that starts a dynamic routine's
--   next run (qorpera_folder_dynamic_routines_due, then qorpera_folder_restore_dynamic_routine_run, every 30 s) leaves a
--   listening version alone: one whose trigger has `after`, whose `at` is still ahead, that has had no run yet, and
--   whose todo or task is still open (qorpera_routine_listener_state). Once that stops holding, the tick inserts the run
--   at once (not at `at`). A member's Stop of the routine's latest run is still seen at once: the tick lists such a
--   routine, and the restore pauses it. The run's payload says what it waited for, `after` (the key), and `state`: done,
--   cancelled, gone, or open when the latest time came first. A listener's `at` is at most 31 days ahead.
-- * Reads only: the open check reads the todo index and the human-task index by the environment and the folder key, no
--   lock. The tick's locks and order are unchanged.
-- Every patched body carries the marker 20260930565000; the guard at the end checks them.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_routine_listener_state(uuid,text)') is not null then
		raise exception 'Listener routines (20260930565000) are already applied'; end if;
end $$;

create function pg_temp.l1_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'L1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. What a listener waits for ----------------------------------------------------------------------------------------

-- What is at a todo's or a human task's folder key: open (an open or blocked todo, an open or returned task), done (a
-- done todo, a done or accepted task), cancelled (a cancelled todo, a declined or cancelled task) or gone (nothing live
-- there: deleted, moved or never made; a deleted todo's row is retired, and its key a tombstone). By the folder key in
-- collation "C", so the todo lookup takes qorpera_runtime_agent_todos_folder_key and the task lookup its key index.
create function public.qorpera_routine_listener_state(p_environment_id uuid, p_key text)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930565000 (L1).
	select coalesce(
		(select case when t.state in ('open','blocked') then 'open' when t.state = 'done' then 'done' else 'cancelled' end
			from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_path is not null and t.folder_retired_at is null
				and (public.qorpera_folder_key(t.folder_path)) collate "C" = p_key collate "C"
			order by t.state in ('open','blocked') desc limit 1),
		(select case when h.status in ('open','returned') then 'open' when h.status in ('done','accepted') then 'done'
				else 'cancelled' end
			from public.qorpera_folder_human_task_index h
			where h.environment_id = p_environment_id and h.folder_key = p_key collate "C" and h.retired_at is null
			order by h.status in ('open','returned') desc limit 1),
		'gone')
$$;
revoke all on function public.qorpera_routine_listener_state(uuid, text) from public, anon, authenticated, service_role;

-- Whether the routine's latest run was stopped by a member and the routine has not paused for it yet: the restore pauses
-- it then (its own check), so the tick must list a listening routine in that case instead of holding it back.
create function public.qorpera_routine_stop_unseen(p_routine_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930565000 (L1): the restore's own test (qorpera_folder_restore_dynamic_routine_run), read only.
	select coalesce((select w.run_id is not null
			and w.blocked_reason is distinct from 'A member stopped this run; the routine paused'
			and exists (select 1 from public.qorpera_execution_runs run
				join public.qorpera_runner_jobs job on job.id = run.job_id
				where run.id = w.run_id and job.status = 'cancelled' and job.cancelled_by_user_id is not null)
		from public.qorpera_wake_occurrences w where w.routine_id = p_routine_id
		order by w.created_at desc, w.id desc limit 1), false)
$$;
revoke all on function public.qorpera_routine_stop_unseen(uuid) from public, anon, authenticated, service_role;

-- Whether a routine's current version still listens: its trigger has `after`, its `at` is ahead, it has had no run, and
-- something open is still at `after`. The tick holds such a version's run back.
create function public.qorpera_routine_listening(p_routine public.qorpera_cloud_routines, p_trigger jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930565000 (L1).
	select coalesce(p_trigger ? 'after' and (p_trigger ->> 'at')::timestamptz > statement_timestamp()
		and not exists (select 1 from public.qorpera_wake_occurrences w
			where w.routine_id = p_routine.id and w.routine_version = p_routine.current_version)
		and public.qorpera_routine_listener_state(p_routine.environment_id, p_trigger ->> 'after') = 'open', false)
$$;
revoke all on function public.qorpera_routine_listening(public.qorpera_cloud_routines, jsonb)
	from public, anon, authenticated, service_role;

-- 2. The file: `after` beside `at` ------------------------------------------------------------------------------------

select pg_temp.l1_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$ when 'once' then array['at','when']$old$,
	$new$ when 'once' then case when v_when ? 'after' then array['after','at','when'] else array['at','when'] end$new$);
select pg_temp.l1_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			-- 20260930061000 (E2a): a hook by its lowercase id; only null or 1 to 20 distinct printable event types.$old$,
	$new$			-- 20260930565000 (L1): a listener's after is the path of a todo or a human task file.
			or (v_when ? 'after' and (not public.qorpera_company_state_one_line(v_when -> 'after', 1, 4096)
				or coalesce(public.qorpera_structured_path_kind(public.qorpera_folder_key(v_when ->> 'after')), '')
					not in ('todo','human-task')))
			-- 20260930061000 (E2a): a hook by its lowercase id; only null or 1 to 20 distinct printable event types.$new$);

-- The version's trigger: the folded key, as a file-change watch is kept.
select pg_temp.l1_replace('public.qorpera_company_state_routine_trigger(jsonb)'::regprocedure,
	$old$		when 'once' then jsonb_build_object('kind', 'once', 'at', v_when -> 'at', 'timeZone', p_parse -> 'timezone')$old$,
	$new$		when 'once' then jsonb_build_object('kind', 'once', 'at', v_when -> 'at', 'timeZone', p_parse -> 'timezone')
			-- 20260930565000 (L1): a listener's todo or human task.
			|| case when jsonb_typeof(v_when -> 'after') = 'string'
				then jsonb_build_object('after', public.qorpera_folder_key(v_when ->> 'after')) else '{}'::jsonb end$new$);

select pg_temp.l1_replace('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
	$old$			and p_trigger - array['id','kind','at','timeZone','replyPolicy'] = '{}'::jsonb$old$,
	$new$			and p_trigger - array['id','kind','at','timeZone','replyPolicy','after'] = '{}'::jsonb
			-- 20260930565000 (L1): a listener's after is a folded key of a todo or a human task file.
			and (not p_trigger ? 'after' or (jsonb_typeof(p_trigger -> 'after') = 'string'
				and p_trigger ->> 'after' = public.qorpera_folder_key(p_trigger ->> 'after')
				and coalesce(public.qorpera_structured_path_kind(p_trigger ->> 'after'), '') in ('todo','human-task')))$new$);

-- The rules: `after` names a live todo or human task of this company (a closed one is fine: the run comes at once), and
-- a listener's latest time is at most 31 days ahead, so a todo nobody closes is not looked up for months. The tool
-- refuses a latest time in the past or more than 30 days ahead; a later save of the same file (a conclusion) keeps it.
select pg_temp.l1_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
	$old$	-- 20260930061000 (E2a): an event routine listens to a live hook or mailbox of its company. Checked in decide, under the$old$,
	$new$	-- 20260930565000 (L1): a listener waits for a todo or a human task this company has.
	elsif v_when = 'once' and jsonb_typeof(p_parse -> 'trigger' -> 'after') = 'string'
		and not exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_path is not null and t.folder_retired_at is null
				and (public.qorpera_folder_key(t.folder_path)) collate "C"
					= public.qorpera_folder_key(p_parse -> 'trigger' ->> 'after') collate "C")
		and not exists (select 1 from public.qorpera_folder_human_task_index h
			where h.environment_id = p_environment_id and h.retired_at is null
				and h.folder_key = public.qorpera_folder_key(p_parse -> 'trigger' ->> 'after') collate "C") then
		v_problem := 'after names no todo or human task of this company: ' || left(p_parse -> 'trigger' ->> 'after', 100)
			|| '; give the path of one, as manage_todo or the human task lists show it';
	elsif v_when = 'once' and jsonb_typeof(p_parse -> 'trigger' -> 'after') = 'string'
		and public.qorpera_company_state_instant(p_parse -> 'trigger' -> 'at')
		and (p_parse -> 'trigger' ->> 'at')::timestamptz > statement_timestamp() + interval '31 days' then
		v_problem := 'a listener waits at most 31 days: choose an at within that, and decide again then if it is still open';
	-- 20260930061000 (E2a): an event routine listens to a live hook or mailbox of its company. Checked in decide, under the$new$);

-- 3. The tick holds a listening version's run back, then starts it at once ---------------------------------------------

select pg_temp.l1_replace('public.qorpera_folder_dynamic_routines_due(uuid,integer)'::regprocedure,
	$old$			and public.qorpera_dynamic_routine_pending_occurrence(routine.id, routine.current_version) is null$old$,
	$new$			and public.qorpera_dynamic_routine_pending_occurrence(routine.id, routine.current_version) is null
			-- 20260930565000 (L1): not while it listens, unless a member stopped its latest run (the restore pauses it).
			and not (version.triggers -> 0 ? 'after' and public.qorpera_routine_listening(routine, version.triggers -> 0)
				and not public.qorpera_routine_stop_unseen(routine.id))$new$);

select pg_temp.l1_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$	v_at := case when v_ended = 0 then greatest((v_trigger ->> 'at')::timestamptz, statement_timestamp())$old$,
	$new$	-- 20260930565000 (L1): a listening version has no run yet (busy: the orchestrator's word for "the next pass comes
	-- back"; the list leaves it out until it stops listening); once it stops, its first run is now.
	if v_ended = 0 and public.qorpera_routine_listening(v_routine, v_trigger) then
		return jsonb_build_object('status', 'busy', 'listening', true); end if;
	v_at := case when v_ended = 0 and v_trigger ? 'after' then statement_timestamp()
		when v_ended = 0 then greatest((v_trigger ->> 'at')::timestamptz, statement_timestamp())$new$);
select pg_temp.l1_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$			jsonb_build_object('schema', 'qorpera.routine-once-occurrence/v1', 'attempt', v_ended + 1))$old$,
	$new$			jsonb_build_object('schema', 'qorpera.routine-once-occurrence/v1', 'attempt', v_ended + 1)
			-- 20260930565000 (L1): what the run waited for, and what became of it (open: the latest time came first).
			|| case when v_trigger ? 'after' then jsonb_build_object('after', v_trigger -> 'after',
				'state', public.qorpera_routine_listener_state(v_routine.environment_id, v_trigger ->> 'after'))
				else '{}'::jsonb end)$new$);

drop function pg_temp.l1_replace(regprocedure, text, text);

-- 4. The guard ---------------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_company_state_parse_problems(text,jsonb)', 'public.qorpera_company_state_routine_trigger(jsonb)',
		'public.qorpera_cloud_routine_trigger_valid(jsonb)',
		'public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)',
		'public.qorpera_folder_dynamic_routines_due(uuid,integer)',
		'public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930565000') = 0 then
			raise exception 'L1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
