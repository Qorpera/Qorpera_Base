-- Company folder core, C4 (E2a, Q1): event wakes on folder-v2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §4;
-- F2-6b, with F2 reviewing). A routine file with `when: event` listens to one of its company's hooks or mailboxes, and a
-- verified delivery to it wakes the routine's agent, as W2's event routines did on the old core (20260928269290).
-- * The routine file: `when: event` with `hook` (the hook's id, lowercase) and `only` (null, or 1 to 20 distinct event
--   types). It compiles to W2's trigger, {kind: listener, source: event, id: file, hookId, only?, timeZone, replyPolicy},
--   so W2's version trigger makes its cursor and the sync trigger (de)activates it, as for an old-core routine.
-- * The rules: the hook must be a live hook or mailbox of the routine's company and environment, and no ChatGPT plan may
--   pay (a plan pays only for work its member starts). Both are file problems, never W2's 42501 from the version
--   trigger, which on folder-v2 no longer raises: a move or a handover of a routine whose hook was removed since saves,
--   with a cursor that never wakes; the gate refuses a plan-paid listener's wakes.
-- * The lock: a unit that writes an event routine's file takes its hook FOR SHARE at rank 5, after the routine rows (E1
--   put qorpera_event_hooks last there). A hook's removal takes it FOR NO KEY UPDATE, so a save and a removal serialize:
--   the save's rules see the hook removed, or the removal waits for the save.
-- * The drain (`events` on the shared folder drains, scheduled in E2b): qorpera_folder_event_wakes_due lists the
--   folder-v2 environments with a live listener and a verified delivery waiting; qorpera_folder_event_wakes_company makes
--   one company's wakes in its own transaction, in core §3's order (the fence, requesters, agents and execution
--   authorities, each routine FOR NO KEY UPDATE and its hook FOR SHARE at rank 5, then the cursors, the conversations and
--   admission), with W2's bounds: one open wake per routine trigger, at most 20 deliveries a wake (taken at the read), and
--   retries after 1, 4, 16 and 64 minutes before a delivery is left behind. A paused company's events wait.
-- * The gate takes event wakes (the hook still live), and the run's wake read carries W2's batch.
-- Every inserted text names this migration (20260930061000), for the deploy guard.

do $$ begin
	if exists (select 1 from pg_proc where oid = 'public.qorpera_company_state_routine_trigger(jsonb)'::regprocedure
		and strpos(prosrc, '20260930061000') > 0) then
		raise exception 'E2a (20260930061000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e2_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E2a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The routine file's `when: event` ------------------------------------------------------------------------------------

select pg_temp.e2_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			or coalesce(v_when ->> 'when', '') not in ('every','weekly','window','once','file-change') then$old$,
	$new$			-- 20260930061000 (E2a): event, with the hook it listens to and the event types it takes.
			or coalesce(v_when ->> 'when', '') not in ('every','weekly','window','once','file-change','event') then$new$);
select pg_temp.e2_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$				else array['match','watch','when'] end)$old$,
	$new$				when 'file-change' then array['match','watch','when'] else array['hook','only','when'] end)
			-- 20260930061000 (E2a): a hook by its lowercase id; only null or 1 to 20 distinct printable event types.
			or (v_when ? 'hook' and coalesce(v_when ->> 'hook', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
			or (v_when ? 'only' and jsonb_typeof(v_when -> 'only') <> 'null' and (jsonb_typeof(v_when -> 'only') <> 'array'
				or jsonb_array_length(v_when -> 'only') not between 1 and 20
				or exists (select 1 from jsonb_array_elements(v_when -> 'only') t
					where jsonb_typeof(t) <> 'string' or (t #>> '{}') !~ '^[\x21-\x7e]{1,128}$')
				or (select count(distinct t) from jsonb_array_elements(v_when -> 'only') t) <> jsonb_array_length(v_when -> 'only')))$new$);

-- W2's trigger, so the version trigger, the sync trigger, the gate's policy and the read treat it as theirs.
select pg_temp.e2_replace('public.qorpera_company_state_routine_trigger(jsonb)'::regprocedure,
	$old$			'match', v_when -> 'match', 'timeZone', p_parse -> 'timezone') end;$old$,
	$new$			'match', v_when -> 'match', 'timeZone', p_parse -> 'timezone')
		-- 20260930061000 (E2a): W2's event listener.
		when 'event' then jsonb_build_object('kind', 'listener', 'source', 'event', 'hookId', v_when -> 'hook',
				'timeZone', p_parse -> 'timezone')
			|| case when jsonb_typeof(v_when -> 'only') = 'array' then jsonb_build_object('only', v_when -> 'only')
				else '{}'::jsonb end end;$new$);

-- The rules: a live hook of this company and environment, and no ChatGPT plan paying (as P29's file-change routines).
select pg_temp.e2_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
	$old$	elsif v_zone is not null then$old$,
	$new$	-- 20260930061000 (E2a): an event routine listens to a live hook or mailbox of its company. Checked in decide, under the
	-- hook's lock (the commit's rank-5 target), so a removal either waits for this save or is seen here.
	elsif v_when = 'event' and not exists (select 1 from public.qorpera_event_hooks hook
		where hook.id::text = p_parse -> 'trigger' ->> 'hook' and hook.profile_id = p_profile_id
			and hook.environment_id = p_environment_id and hook.status <> 'removed') then
		v_problem := 'hook ' || left(coalesce(p_parse -> 'trigger' ->> 'hook', ''), 36)
			|| ' is not a hook or mailbox of this company; list_hooks shows them';
	elsif v_when = 'event' and (exists (select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
			coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, v_version.sponsor_binding_id) payer
			where public.qorpera_sponsor_version_is_chatgpt_plan(payer.binding_id, payer.version))
		or exists (select 1 from public.qorpera_execution_runs run where p_actor ->> 'kind' = 'staff_agent'
			and run.id = (p_actor ->> 'runId')::uuid
			and public.qorpera_sponsor_version_is_chatgpt_plan(run.sponsor_binding_id, run.sponsor_version))) then
		v_problem := 'a ChatGPT plan pays only for work its member starts; an event routine needs another AI login';
	elsif v_zone is not null then$new$);

-- 2. The lock: the hook an event routine's file names, FOR SHARE at rank 5 ------------------------------------------------

select pg_temp.e2_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$old$,
	$new$		-- 20260930061000 (E2a): the hook an event routine's file listens to, FOR SHARE at rank 5. A removal takes it FOR NO
		-- KEY UPDATE, so it waits for the save, or the save's rules (in decide, under this lock) see the hook removed.
		for v_entry in select e.value from jsonb_array_elements(case when v_op in ('write','new_folder')
				and jsonb_typeof(v_unit -> 'structured') = 'array' then v_unit -> 'structured' else '[]'::jsonb end) e
			where e.value ->> 'kind' = 'routine' and e.value -> 'parse' -> 'trigger' ->> 'when' = 'event'
				and coalesce(e.value -> 'parse' -> 'trigger' ->> 'hook', '') ~ c_uuid loop
			rank := 5; tbl := 'qorpera_event_hooks'; key := v_entry -> 'parse' -> 'trigger' ->> 'hook'; mode := 'share';
			return next;
		end loop;
		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$new$);

-- 3. W2's version trigger on folder-v2 -----------------------------------------------------------------------------------

-- A folder-v2 routine's rules refuse a removed hook and a plan payer when its file is saved. A version made by a move or
-- a handover (no rules) still gets its cursor, which never wakes while the hook is removed (the drain and the gate check
-- it); raising here would refuse the whole change set. The gate refuses a plan-paid listener's wakes.
select pg_temp.e2_replace('public.qorpera_activate_company_file_listener()'::regprocedure,
	$old$	if public.qorpera_sponsor_version_is_chatgpt_plan(new.sponsor_binding_id, new.sponsor_version) then$old$,
	$new$	if public.qorpera_sponsor_version_is_chatgpt_plan(new.sponsor_binding_id, new.sponsor_version)
		-- 20260930061000 (E2a): on folder-v2 the routine rules refuse it at save, and the gate at the wake.
		and not public.qorpera_company_is_folder_v2(new.profile_id) then$new$);
select pg_temp.e2_replace('public.qorpera_activate_company_file_listener()'::regprocedure,
	$old$				and hook.status <> 'removed') then
			raise exception 'Event listener hook is unavailable' using errcode = '42501'; end if;$old$,
	$new$				-- 20260930061000 (E2a): a folder-v2 routine's hook was live when its file was saved.
				and (hook.status <> 'removed' or public.qorpera_company_is_folder_v2(new.profile_id))) then
			raise exception 'Event listener hook is unavailable' using errcode = '42501'; end if;$new$);

-- 4. The gate and the read -----------------------------------------------------------------------------------------------

-- The folder gate stops refusing event wakes. 'event' leaves the refusal list by its own token, whatever other kinds the
-- list holds by then (C1c-3l and 3i-b drop theirs the same way). When nothing is left, the clause goes and a comment line
-- takes its place, so the rest of the statement (" then return false; end if;", and any note after it) stays on a line
-- of its own: the line before the clause may itself be another migration's comment (C1c-3l leaves one there).
do $$
declare
	v_function constant regprocedure := 'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure;
	v_definition text := pg_get_functiondef(v_function); v_clause text; v_list text; v_rest text;
begin
	v_clause := (regexp_match(v_definition, E'(\n\t\tor p_wake\\.source_kind in \\([^)]*\\) ?)'))[1];
	if v_clause is null or (length(v_definition) - length(replace(v_definition, v_clause, ''))) / length(v_clause) <> 1 then
		raise exception 'E2a: the folder gate''s refusal list differs'; end if;
	v_list := (regexp_match(v_clause, E'\\(([^)]*)\\)'))[1];
	if v_list !~ E'(^|,)\\s*''event''\\s*(,|$)' then raise exception 'E2a: the folder gate does not refuse event wakes'; end if;
	v_rest := regexp_replace(regexp_replace(v_list, E'\\s*,\\s*''event''\\s*(?=,|$)', ''), E'^\\s*''event''\\s*,?\\s*', '');
	execute replace(v_definition, v_clause, case when btrim(v_rest) = ''
		then E'\n\t\t-- 20260930061000 (E2a): event wakes serve folder-v2; their hook is checked below.\n\t\t'
		else replace(v_clause, '(' || v_list || ')', '(' || v_rest || ')') end);
end $$;
select pg_temp.e2_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$	-- A member's login pays only for work that member started (20260928230000).$old$,
	$new$	-- 20260930061000 (E2a): an event wake's hook still belongs to its company and was not removed.
	if p_wake.source_kind = 'event' and not exists (select 1 from public.qorpera_event_hooks hook where hook.id = p_wake.source_id
		and hook.profile_id = p_wake.profile_id and hook.environment_id = p_wake.environment_id and hook.status <> 'removed') then
		return false; end if;
	-- A member's login pays only for work that member started (20260928230000).$new$);

-- The batch the wake took, as W2's read gives it: the hook, up to 20 events (taken at the first read; a retried run reads
-- the same ones) and the count still waiting, in the room the rest of the wake leaves.
select pg_temp.e2_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;$old$,
	$new$	-- 20260930061000 (E2a): an event wake's batch.
	if v_wake.source_kind = 'event' then
		v_payload := jsonb_set(v_payload, '{payload}', (v_payload -> 'payload') || public.qorpera_event_wake_payload(v_wake,
			least(49152 - pg_column_size(v_payload), 49152 - octet_length((v_payload -> 'payload')::text)) - 4096));
	end if;
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;$new$);

-- 5. The drain ------------------------------------------------------------------------------------------------------------

-- W2's one pending occurrence a routine trigger: queued, or materialized with its job not yet running and nothing read.
create function public.qorpera_folder_event_wake_pending(p_routine_id uuid, p_trigger_id text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930061000 (E2a), as qorpera_drain_event_wakes (20260928269290).
	select exists (select 1 from public.qorpera_wake_occurrences as pending
		where pending.routine_id = p_routine_id and pending.trigger_id = p_trigger_id
			and pending.source_kind = 'event' and pending.status in ('queued','materialized')
			and (pending.status = 'queued' or (
				not exists (select 1 from public.qorpera_event_wake_deliveries where occurrence_id = pending.id)
				and exists (select 1 from public.qorpera_execution_runs as run
					join public.qorpera_runner_jobs as job on job.id = run.job_id
					where run.id = pending.run_id and job.status in ('queued','leased')))))
$$;

-- The wakes a listener already made for one first delivery (keys 1 to 5) and when the last was made.
create function public.qorpera_folder_event_wake_tries(p_cursor public.qorpera_event_listener_cursors, p_first uuid)
returns table (tries bigint, tried_at timestamptz) language sql stable security definer set search_path = '' as $$
	-- 20260930061000 (E2a), as qorpera_drain_event_wakes (20260928269290).
	select count(*), max(w.created_at) from public.qorpera_wake_occurrences w
	where w.routine_id = p_cursor.routine_id and w.occurrence_key = any (array(select 'event:' || p_cursor.routine_version::text
		|| ':' || p_cursor.trigger_id || ':' || p_first::text || ':' || n from generate_series(1, 5) as n))
$$;

-- An earlier wake for this first delivery ended without taking it, and its retry (after 1, 4, 16 or 64 minutes) is not due.
create function public.qorpera_folder_event_wake_retry_waits(p_cursor public.qorpera_event_listener_cursors, p_first uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930061000 (E2a).
	select coalesce(t.tries between 1 and 4 and clock_timestamp() < t.tried_at + interval '1 minute' * power(4, t.tries - 1),
		false)
	from public.qorpera_folder_event_wake_tries(p_cursor, p_first) t
$$;

-- The folder-v2 environments whose drain step would wake a listener now: a live listener (an active folder-v2 routine's
-- current version, its cursor active, its hook not removed, its agent active and its requester a member) with a delivery
-- of a type it takes waiting, and no wake pending or waiting for its retry. In environment order after
-- p_after_environment. Leaves out companies being deleted and paused ones: their events wait. A plain read.
create function public.qorpera_folder_event_wakes_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	-- 20260930061000 (E2a).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder event wake limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select distinct c.environment_id from public.qorpera_event_listener_cursors c
		join public.qorpera_company_files f on f.environment_id = c.environment_id and f.core = 'folder-v2'
		join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
			and r.status = 'active' and r.folder_path is not null
		join public.qorpera_cloud_routine_versions v on v.routine_id = c.routine_id and v.version = c.routine_version
		join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) where x.value ->> 'id' = c.trigger_id
			limit 1) t on public.qorpera_cloud_routine_trigger_valid(t.value)
		join public.qorpera_event_hooks h on h.id = c.hook_id and h.status <> 'removed'
		join public.qorpera_profile_staff s on s.profile_id = c.profile_id and s.staff_agent_id = v.staff_agent_id
			and s.employment_status = 'active'
		join public.qorpera_profile_members m on m.profile_id = c.profile_id and m.user_id = v.created_by_user_id
		cross join lateral public.qorpera_event_listener_waiting(c, t.value -> 'only', 1) first
		where c.active and (p_after_environment is null or c.environment_id > p_after_environment)
			and not public.qorpera_company_deleting(c.profile_id) and not public.qorpera_company_execution_paused(c.profile_id)
			and not public.qorpera_folder_event_wake_pending(c.routine_id, c.trigger_id)
			and not public.qorpera_folder_event_wake_retry_waits(c, first.id)
		order by c.environment_id limit p_limit) x;
	-- The shared folder drains' page (LISTENER.md §9).
	return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('environment_id', e) order by e)
			from unnest(v_environments) e), '[]'::jsonb),
		'has_more', cardinality(v_environments) = p_limit,
		'next_after_environment_id', case when cardinality(v_environments) = p_limit
			then v_environments[cardinality(v_environments)] end);
end $$;

-- One step of one company's event listeners, in its own transaction, never inside the materializer's. Answers
-- {state: done | idle | paused | busy | deleting | not_folder, wakes, skipped}.
create function public.qorpera_folder_event_wakes_company(p_environment_id uuid, p_limit integer default 16)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-event-wakes/v1';
	v_profile uuid; v_listeners jsonb; v_listener record; v_targets jsonb; v_kept jsonb := '[]'::jsonb; v_item record;
	v_cursor public.qorpera_event_listener_cursors%rowtype; v_routine public.qorpera_cloud_routines%rowtype;
	v_first public.qorpera_event_deliveries%rowtype; v_prefix text; v_attempts bigint; v_tried_at timestamptz;
	v_session uuid; v_sessions uuid[]; v_wake public.qorpera_wake_occurrences%rowtype; v_wakes integer := 0;
	v_skipped integer := 0; v_message text;
begin
	-- 20260930061000 (E2a).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder event wakes run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Folder event wake limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;

	-- 1. Plain reads: the live listeners, least recently scanned first, with their agent, requester and trigger. Only live
	-- ones are ordered and counted against the limit: a cursor that is active but no listener (its hook removed, its
	-- routine moved on) is never scanned, so it must never take a live listener's place (review r1 F1).
	select coalesce(jsonb_agg(l.listener order by l.scanned, l.routine_id, l.trigger_id), '[]'::jsonb)
	into v_listeners
	from (select jsonb_build_object('routineId', c.routine_id, 'version', c.routine_version, 'triggerId', c.trigger_id,
				'hookId', c.hook_id, 'staff', v.staff_agent_id, 'requester', v.created_by_user_id, 'trigger', t.value) as listener,
			c.last_scanned_at as scanned, c.routine_id, c.trigger_id
		from public.qorpera_event_listener_cursors c
		join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
			and r.status = 'active' and r.folder_path is not null and r.profile_id = v_profile
		join public.qorpera_cloud_routine_versions v on v.routine_id = c.routine_id and v.version = c.routine_version
		join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) where x.value ->> 'id' = c.trigger_id
			limit 1) t on public.qorpera_cloud_routine_trigger_valid(t.value)
		join public.qorpera_event_hooks h on h.id = c.hook_id and h.status <> 'removed'
		where c.environment_id = p_environment_id and c.active
		order by c.last_scanned_at, c.routine_id, c.trigger_id limit p_limit) l;
	if jsonb_array_length(v_listeners) = 0 then return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	-- Ranks 1 to 3 KEY SHARE, and at rank 5 each routine FOR NO KEY UPDATE (as routine firing and saves take it) and its
	-- hook FOR SHARE (a removal waits for this step, or this step sees the hook removed).
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_array_elements(v_listeners) l, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || (l.value ->> 'requester'),
				'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || (l.value ->> 'staff'),
				'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', l.value ->> 'routineId', 'mode', 'nokeyupdate')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', l.value ->> 'hookId', 'mode', 'share'))) x(t)) y;

	begin
		-- 2. The fence KEY SHARE, rank 0, ranks 1 to 5. A paused company's events wait: nothing is written or moved.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;

		-- 3. Each listener's cursor (run-owned rows, after the ranks) FOR UPDATE SKIP LOCKED, and W2's checks under the locks.
		for v_listener in select x.value as l from jsonb_array_elements(v_listeners) x loop
			select * into v_cursor from public.qorpera_event_listener_cursors
			where routine_id = (v_listener.l ->> 'routineId')::uuid and routine_version = (v_listener.l ->> 'version')::bigint
				and trigger_id = v_listener.l ->> 'triggerId' and active
			for update skip locked;
			if not found then continue; end if;
			update public.qorpera_event_listener_cursors set last_scanned_at = clock_timestamp()
			where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
			select * into v_routine from public.qorpera_cloud_routines where id = v_cursor.routine_id;
			-- No longer this listener, its hook removed, or its agent no longer active.
			if v_routine.status is distinct from 'active' or v_routine.current_version is distinct from v_cursor.routine_version
				or v_routine.folder_path is null
				or not exists (select 1 from public.qorpera_event_hooks where id = v_cursor.hook_id and status <> 'removed')
				or not exists (select 1 from public.qorpera_profile_staff where profile_id = v_profile
					and staff_agent_id = (v_listener.l ->> 'staff')::uuid and employment_status = 'active')
				or public.qorpera_folder_event_wake_pending(v_cursor.routine_id, v_cursor.trigger_id) then
				continue; end if;
			select * into v_first from public.qorpera_event_listener_waiting(v_cursor, v_listener.l -> 'trigger' -> 'only', 1);
			if v_first.id is null then
				-- Nothing matching waits: what this listener skips (other types) is behind it now.
				update public.qorpera_event_listener_cursors
				set taken_before = greatest(taken_before, clock_timestamp() - interval '1 minute')
				where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version
					and trigger_id = v_cursor.trigger_id;
				continue;
			end if;
			-- Earlier wakes for the same first delivery that ended without taking it: tried again after 1, 4, 16 and 64
			-- minutes, then the delivery is left behind with the last of them.
			v_prefix := 'event:' || v_cursor.routine_version::text || ':' || v_cursor.trigger_id || ':' || v_first.id::text;
			select t.tries, t.tried_at into v_attempts, v_tried_at from public.qorpera_folder_event_wake_tries(v_cursor, v_first.id) t;
			if v_attempts >= 5 then
				insert into public.qorpera_event_wake_deliveries(routine_id, trigger_id, delivery_id, occurrence_id)
				select v_cursor.routine_id, v_cursor.trigger_id, v_first.id, id from public.qorpera_wake_occurrences
				where routine_id = v_cursor.routine_id and occurrence_key = v_prefix || ':5'
				on conflict do nothing;
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if public.qorpera_folder_event_wake_retry_waits(v_cursor, v_first.id) then continue; end if;
			-- A routine that must report needs its agent's public conversation; its requester must still be a member.
			v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id, (v_listener.l ->> 'staff')::uuid,
				(v_listener.l ->> 'requester')::uuid);
			if (coalesce(v_listener.l -> 'trigger' ->> 'replyPolicy', 'required') = 'required' and v_session is null)
				or not exists (select 1 from public.qorpera_profile_members where profile_id = v_profile
					and user_id = (v_listener.l ->> 'requester')::uuid) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_kept := v_kept || jsonb_build_array(v_listener.l || jsonb_build_object('session', v_session,
				'key', v_prefix || ':' || (v_attempts + 1)::text, 'firstDeliveryId', v_first.id, 'receivedAt', v_first.received_at));
		end loop;

		-- 4. The conversations the wakes answer in, KEY SHARE in id order, then admission only when a wake will be written.
		select coalesce(array_agg(distinct (x.value ->> 'session')::uuid), '{}') into v_sessions
		from jsonb_array_elements(v_kept) x where x.value ->> 'session' is not null;
		perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) and profile_id = v_profile order by id for key share;
		if jsonb_array_length(v_kept) > 0 then perform public.qorpera_folder_admit_wakes(v_profile); end if;

		-- 5. The wakes, each in its own subtransaction; a known refusal (an expired routine, one at its limit, a requester or
		-- audience gone) is passed over without stopping the others.
		for v_item in select x.value as w from jsonb_array_elements(v_kept) x loop
			begin
				insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, wake_kind,
					source_kind, trigger_id, occurrence_key, scheduled_for, not_before, payload)
				values (extensions.gen_random_uuid(), v_profile, p_environment_id, (v_item.w ->> 'routineId')::uuid,
					(v_item.w ->> 'version')::bigint, 'routine', 'event', v_item.w ->> 'triggerId', v_item.w ->> 'key',
					(v_item.w ->> 'receivedAt')::timestamptz, clock_timestamp(),
					jsonb_build_object('hookId', (v_item.w ->> 'hookId')::uuid, 'firstDeliveryId', (v_item.w ->> 'firstDeliveryId')::uuid))
				returning * into v_wake;
				-- The pin trigger chose the conversation without a lock: it must be the one this step locked.
				if v_wake.session_id is distinct from (v_item.w ->> 'session')::uuid then
					raise exception 'Wake routine audience changed' using errcode = 'QE2S0'; end if;
				v_wakes := v_wakes + 1;
			exception
				when sqlstate '55000' or sqlstate '42501' then
					get stacked diagnostics v_message = message_text;
					if v_message not in ('Routine has expired', 'Routine occurrence limit reached', 'Wake causal ancestry is fenced',
						'Wake recipient authority is unavailable', 'Wake public audience is unavailable') then raise; end if;
					v_skipped := v_skipped + 1;
			end;
		end loop;
	exception
		-- A row someone holds, or the conversation chosen at insert moved: nothing of this step stays; the next tick goes on.
		when lock_not_available or deadlock_detected or sqlstate 'QE2S0' then
			return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'wakes', v_wakes, 'skipped', v_skipped);
end $$;

-- 6. Grants and the deploy guard -----------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_event_wake_pending(uuid, text),
	public.qorpera_folder_event_wake_tries(public.qorpera_event_listener_cursors, uuid),
	public.qorpera_folder_event_wake_retry_waits(public.qorpera_event_listener_cursors, uuid)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_event_wakes_due(uuid, integer), public.qorpera_folder_event_wakes_company(uuid, integer)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_event_wakes_due(uuid, integer), public.qorpera_folder_event_wakes_company(uuid, integer)
	to service_role;

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_company_state_parse_problems(text,jsonb)', 'public.qorpera_company_state_routine_trigger(jsonb)',
		'public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)',
		'public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)', 'public.qorpera_activate_company_file_listener()',
		'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)', 'public.qorpera_folder_read_wake(jsonb)',
		'public.qorpera_folder_event_wakes_due(uuid,integer)', 'public.qorpera_folder_event_wakes_company(uuid,integer)',
		'public.qorpera_folder_event_wake_tries(public.qorpera_event_listener_cursors,uuid)',
		'public.qorpera_folder_event_wake_retry_waits(public.qorpera_event_listener_cursors,uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930061000') = 0 then
			raise exception 'E2a marker is missing in %', v_function; end if;
	end loop;
	-- The gate's refusal list, if it still has one, no longer names event wakes.
	if (select (regexp_match(prosrc, 'or p_wake\.source_kind in \(([^)]*)\)'))[1] from pg_proc
			where oid = 'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure)
		~ '(^|,)\s*''event''\s*(,|$)' then
		raise exception 'E2a: the folder gate still refuses event wakes'; end if;
end $guard$;
