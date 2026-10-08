-- 20260930109000: check-ins for coding sessions under one idle rule for every machine (the 2026-10-03 amendment, item 5,
-- its coding part). Folder-v2 only by the founder's decision of 3 October. A coding session that stays busy on its
-- machine since its last turn ended has its agent asked whether it still needs it, after 1, 3 and 7 hours, then every
-- 24, each time only while busy, in the conversation of the run that steers the session (the one that dispatched it or
-- followed it up last). A question is a notice, never a stop. It rides 20260930098000's check-ins: one
-- qorpera_machine_checkins row per question (kind 'coding', the session's worker as its subject, the end of its last
-- turn as its since), asked and delivered by the same folder drain (machine_checkins, LISTENER §9).
-- 1. Asking: qorpera_coding_busy_checkins_unasked lists the questions due and not asked yet; the drain's company step
--    asks them with the shells'. A session is busy while it is attached to its machine and the machine's last
--    observation, under a minute and a half old, found it busy (qorpera_keep_coding_attachments). C3c's question about
--    a quiet session goes first: none is asked while one is on its way to the agent, nor while the worker's report waits.
-- 2. Delivery: a question still stands only while the session is busy and still on the same turn; one that no longer
--    stands is suppressed. A run that carries a question about a session archives it only as it was when asked
--    (qorpera_coding_question_stale), as C3c's.
-- Every patched or new body names this migration (20260930109000).

set local lock_timeout = '3s';

-- 1. Asking ------------------------------------------------------------------------------------------------------------

-- When the busy count of a coding session started: the end of its current turn, while the session is busy now (attached,
-- busy within the last minute and a half) and its worker is not working a turn; null otherwise.
create function public.qorpera_coding_busy_since(p_session public.qorpera_coding_sessions, p_worker public.qorpera_runtime_workers)
returns timestamptz language sql stable security definer set search_path = '' as $$
	-- 20260930109000.
	select turn.settled_at from public.qorpera_coding_session_turns turn
	where p_session.worker_id = p_worker.id and p_worker.species = 'coding' and p_worker.state <> 'active'
		and p_session.archived_at is null and p_session.attached_machine_id is not null
		and p_session.attachment_until > clock_timestamp() and p_session.busy_at > clock_timestamp() - interval '90 seconds'
		and turn.worker_id = p_worker.id and turn.sequence = p_worker.sequence
$$;
revoke all on function public.qorpera_coding_busy_since(public.qorpera_coding_sessions, public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The questions due and not asked yet, in one folder-v2 environment (or all, for the due list): for each coding session
-- busy for at least an hour since its last turn ended, one question to the conversation of the run steering it, at the
-- mark reached. An archived agent, an erased or retired worker, or a worker whose report waits is not asked; nor is a
-- session with C3c's quiet question on its way (queued, or materialized and not run yet).
create function public.qorpera_coding_busy_checkins_unasked(p_environment_id uuid)
returns table (worker_id uuid, profile_id uuid, environment_id uuid, staff_agent_id uuid, conversation_run_id uuid,
	since timestamptz, mark integer)
language sql stable security definer set search_path = '' as $$
	-- 20260930109000.
	select asking.* from (
		select worker.id as worker_id, worker.profile_id, worker.environment_id, worker.staff_agent_id,
			worker.steering_run_id as conversation_run_id, busy.since,
			public.qorpera_machine_checkin_mark(extract(epoch from clock_timestamp() - busy.since) / 3600) as mark
		from public.qorpera_coding_sessions session
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id and worker.profile_id = session.profile_id
			and worker.environment_id = session.environment_id
		join public.qorpera_execution_runs parent on parent.id = worker.steering_run_id and parent.profile_id = worker.profile_id
			and parent.environment_id = worker.environment_id and parent.staff_agent_id = worker.staff_agent_id
		cross join lateral (select public.qorpera_coding_busy_since(session, worker) as since) busy
		where (p_environment_id is null or session.environment_id = p_environment_id)
			and session.archived_at is null and session.attached_machine_id is not null
			and busy.since <= clock_timestamp() - interval '1 hour'
			and worker.completion_state <> 'waiting' and worker.folder_erased_at is null
			and not public.qorpera_coding_worker_retired(worker)
			and public.qorpera_environment_is_folder_v2(session.environment_id)
			and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = worker.profile_id
				and staff.staff_agent_id = worker.staff_agent_id and staff.employment_status = 'active')
			and not exists (select 1 from public.qorpera_wake_occurrences quiet
				left join public.qorpera_execution_runs quiet_run on quiet_run.id = quiet.run_id
				left join public.qorpera_runner_jobs quiet_job on quiet_job.id = quiet_run.job_id
				where quiet.parent_run_id = worker.steering_run_id and quiet.source_kind = 'worker-completion'
					and quiet.occurrence_key like 'coding-quiet:' || worker.id::text || ':%'
					and (quiet.status = 'queued' or (quiet.status = 'materialized'
						and (quiet_job.id is null or quiet_job.status in ('queued', 'leased')))))) asking
	where not exists (select 1 from public.qorpera_machine_checkins asked where asked.machine_kind = 'coding'
		and asked.subject_id = asking.worker_id and asked.parent_run_id = asking.conversation_run_id
		and asked.since = asking.since and asked.mark_hours = asking.mark)
$$;
revoke all on function public.qorpera_coding_busy_checkins_unasked(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One folder-v2 company's busy coding sessions, as questions (at most p_limit, longest busy first). One session's
-- trouble never stops the others. Returns how many it asked. Its caller holds the folder fence KEY SHARE; a question's
-- parent run is locked only KEY SHARE, by its foreign key; the session is only read.
create function public.qorpera_ask_busy_coding_sessions(p_environment_id uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_busy record; v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_todo_key text; v_running jsonb; v_more bigint; v_body jsonb; v_asked integer := 0; v_count integer;
begin
	-- 20260930109000.
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Coding session check-in bound is invalid' using errcode = '22023'; end if;
	for v_busy in select * from public.qorpera_coding_busy_checkins_unasked(p_environment_id) unasked
		order by unasked.since, unasked.worker_id limit p_limit loop
		begin
			select * into v_worker from public.qorpera_runtime_workers where id = v_busy.worker_id;
			select * into v_session from public.qorpera_coding_sessions where worker_id = v_busy.worker_id;
			select todo_key into v_todo_key from public.qorpera_runtime_agent_todos where id = v_worker.todo_id;
			-- What still runs on its machine, as the machine last saw it, as many as fit: 8 at most and 2400 bytes of
			-- commands, oldest turn first, the rest counted.
			select coalesce(jsonb_agg(ordered.item order by ordered.n) filter (where ordered.n <= 8 and ordered.bytes <= 2400), '[]'::jsonb),
				count(*) filter (where ordered.n > 8 or ordered.bytes > 2400)
			into v_running, v_more
			from (select listed.item, row_number() over (order by listed.turn, listed.at) as n,
					sum(octet_length(listed.item::text)) over (order by listed.turn, listed.at) as bytes
				from (select running.at, (running.value ->> 'turn')::integer as turn,
						jsonb_build_object('command', left(running.value ->> 'command', 200), 'turn', (running.value ->> 'turn')::integer) as item
					from jsonb_array_elements(v_session.running_commands) with ordinality running(value, at)
					where jsonb_typeof(running.value) = 'object' and jsonb_typeof(running.value -> 'command') = 'string'
						and coalesce(running.value ->> 'turn', '') ~ '^[1-9][0-9]{0,8}$') listed) ordered;
			v_body := jsonb_build_object('machine', format('the coding session %s (repository %s/%s, branch %s)',
					to_json(left(regexp_replace(v_worker.title, '[[:cntrl:]]+', ' ', 'g'), 100))::text,
					v_session.repository ->> 'owner', v_session.repository ->> 'name',
					left(regexp_replace(v_session.branch, '[[:cntrl:]]+', ' ', 'g'), 100)),
				'busyHours', v_busy.mark, 'running', v_running, 'more', v_more,
				-- What manage_worker names the session by.
				'todoKey', v_todo_key, 'workerKey', v_worker.worker_key);
			insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind,
				subject_id, since, mark_hours, body)
			values (v_busy.profile_id, v_busy.environment_id, v_busy.staff_agent_id, v_busy.conversation_run_id, 'coding',
				v_busy.worker_id, v_busy.since, v_busy.mark, v_body)
			on conflict (machine_kind, subject_id, parent_run_id, since, mark_hours) do nothing;
			get diagnostics v_count = row_count;
			v_asked := v_asked + v_count;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
	return v_asked;
end $$;
revoke all on function public.qorpera_ask_busy_coding_sessions(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.coding_busy_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding busy check-in anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. Delivery ----------------------------------------------------------------------------------------------------------

-- A coding session's question still stands while the session is busy now, on the turn it was asked about, its worker
-- still the same agent's, steered from the conversation asked, and neither erased nor retired.
select pg_temp.coding_busy_patch('public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)'::regprocedure,
	$old$			-- Other machines judge their questions when they ask them.
			else true end$old$,
	$new$			when 'coding' then exists (select 1 from public.qorpera_coding_sessions session
				join public.qorpera_runtime_workers worker on worker.id = session.worker_id
				where session.worker_id = p_checkin.subject_id and worker.staff_agent_id = p_checkin.staff_agent_id
					and worker.steering_run_id = p_checkin.parent_run_id
					and worker.folder_erased_at is null and not public.qorpera_coding_worker_retired(worker)
					and public.qorpera_coding_busy_since(session, worker) = p_checkin.since) -- 20260930109000
			-- Other machines judge their questions when they ask them.
			else true end$new$);

-- A question's run archives or cancels the session only as it was when asked: never after a new turn started (the
-- owner answered, or someone followed up). C3c's quiet question carries the turn it asked about; a busy check-in, the
-- end of that turn.
create or replace function public.qorpera_coding_question_stale(p_run_id uuid, p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930109000.
	select exists (select 1 from public.qorpera_wake_occurrences asked where asked.run_id = p_run_id
		and asked.occurrence_key like 'coding-quiet:%' and asked.source_id = p_worker.id
		and (p_worker.state = 'active' or p_worker.sequence is distinct from (asked.payload #>> '{completions,0,sequence}')::integer))
	or exists (select 1 from public.qorpera_wake_occurrences asked
		join public.qorpera_machine_checkins checkin on checkin.occurrence_id = asked.id
		where asked.run_id = p_run_id and asked.source_kind = 'machine-checkin'
			and checkin.machine_kind = 'coding' and checkin.subject_id = p_worker.id
			and (p_worker.state = 'active'
				or checkin.since is distinct from (select turn.settled_at from public.qorpera_coding_session_turns turn
					where turn.worker_id = p_worker.id and turn.sequence = p_worker.sequence)))
$$;
revoke all on function public.qorpera_coding_question_stale(uuid, public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The drain ---------------------------------------------------------------------------------------------------------

-- The shared drains' page: a company with a coding session's question to ask is due as one with a shell's.
select pg_temp.coding_busy_patch('public.qorpera_folder_machine_checkins_due(uuid,integer)'::regprocedure,
	$old$		select unasked.environment_id, unasked.profile_id from public.qorpera_office_shell_checkins_unasked(null) unasked
		union$old$,
	$new$		select unasked.environment_id, unasked.profile_id from public.qorpera_office_shell_checkins_unasked(null) unasked
		union
		select unasked.environment_id, unasked.profile_id from public.qorpera_coding_busy_checkins_unasked(null) unasked -- 20260930109000
		union$new$);
-- The company's step asks the coding sessions' questions with the shells'.
select pg_temp.coding_busy_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$	if jsonb_array_length(v_parents) = 0 and not exists (select 1 from public.qorpera_office_shell_checkins_unasked(p_environment_id)) then$old$,
	$new$	if jsonb_array_length(v_parents) = 0 and not exists (select 1 from public.qorpera_office_shell_checkins_unasked(p_environment_id))
		and not exists (select 1 from public.qorpera_coding_busy_checkins_unasked(p_environment_id)) then -- 20260930109000$new$);
select pg_temp.coding_busy_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$		v_asked := public.qorpera_ask_busy_office_shells(p_environment_id, 64);$old$,
	$new$		v_asked := public.qorpera_ask_busy_office_shells(p_environment_id, 64)
			+ public.qorpera_ask_busy_coding_sessions(p_environment_id, 64); -- 20260930109000$new$);
