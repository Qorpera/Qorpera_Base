-- C3c: the quiet coding check-ins on folder-v2, as the drain `coding_checkins` of the shared folder drains
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9, RUNTIME-COMPANY-FOLDER-C1C.md §6.20,
-- RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)").
--
-- After 1, 3 and 7 quiet days the agent that started a coding session is asked once per mark whether it can be archived
-- (349850's rules, question and payload). The legacy ask (qorpera_ask_quiet_coding_sessions, a wake inserter without
-- the fence) skips folder-v2 since C1c-3i (026000); it stays for the executor's scan, and this drain asks folder-v2.
-- * qorpera_folder_parent_continuation answers 'stopped' for a worker-completion continuation by
--   qorpera_worker_revival_stopped (a member who stops a question's run stops only that question), as the legacy ask did.
-- * qorpera_folder_coding_checkins_due / _company: the shared drains' pair. A company's step takes the folder fence KEY
--   SHARE, rank 0, each session's coding worker rows (its owner, the agent and its authority, the todo and the worker,
--   none required) and the ready parents' requesters, agents and authorities KEY SHARE; then the ready parents'
--   conversations KEY SHARE in id order (rank 10), the sessions FOR NO KEY UPDATE in worker order, and admission, last,
--   only when a question is to be asked. Each session is read again under the locks. An erased or retired worker, or a
--   stopped parent, has its mark counted as asked (suppressed); a gone parent's is undeliverable; a parent still running,
--   or with a continuation pending, asks nothing yet. One continuation of a parent at a time, as F2's revivals.
-- * F2's cancel refuses a question's run once the session has a new turn since it was asked (55000), as archive does
--   (C3b) and the legacy cancel did.
-- Every patched or new body carries the marker 20260930107500.

set local lock_timeout = '3s';

create function pg_temp.c3c_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C3c anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A stopped parent of a worker-completion continuation ----------------------------------------------------------------

select pg_temp.c3c_replace('public.qorpera_folder_parent_continuation(uuid,text)',
	$old$	if v_status = 'cancelled' or public.qorpera_machine_revival_stopped(v_run.id) then return 'stopped'; end if;$old$,
	$new$	if v_status = 'cancelled' or (case when p_source_kind = 'worker-completion' then public.qorpera_worker_revival_stopped(v_run.id)
		else public.qorpera_machine_revival_stopped(v_run.id) end) then return 'stopped'; end if; -- 20260930107500 (C3c)$new$);

-- 2. The check-ins drain -------------------------------------------------------------------------------------------------

-- Whether a session's next quiet mark is unasked (349850's rule): open, its worker not active and with no report on its
-- way, a parent to ask, a mark reached and not asked in this quiet period, and an executor to archive it. Its worker's
-- erasure and retirement are read beside it.
create function public.qorpera_folder_coding_checkin_due(p_session public.qorpera_coding_sessions,
	p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930107500 (C3c).
	select coalesce(p_session.archived_at is null and p_worker.id = p_session.worker_id and p_worker.state <> 'active'
		and p_worker.completion_state <> 'waiting' and p_worker.steering_run_id is not null
		and public.qorpera_coding_quiet_mark(greatest(p_session.updated_at, coalesce(p_session.busy_at, p_session.updated_at))) is not null
		and (p_session.quiet_asked_for is distinct from greatest(p_session.updated_at, coalesce(p_session.busy_at, p_session.updated_at))
			or p_session.quiet_asked_days < public.qorpera_coding_quiet_mark(p_session.quiet_asked_for))
		and exists (select 1 from public.qorpera_coding_executors executor where executor.environment_id = p_session.environment_id),
		false)
$$;

-- The shared drains' page (LISTENER §9): folder-v2 companies, not deleting, not paused and not out of computer hours,
-- with a due session of a worker neither erased nor retired whose parent is ready, stopped or gone.
create function public.qorpera_folder_coding_checkins_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	-- 20260930107500 (C3c).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder coding check-ins limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select f.environment_id from public.qorpera_company_files f
		where f.core = 'folder-v2' and (p_after_environment is null or f.environment_id > p_after_environment)
			and exists (select 1 from public.qorpera_coding_sessions session
				join public.qorpera_runtime_workers worker on worker.id = session.worker_id
				where session.environment_id = f.environment_id and session.archived_at is null
					and public.qorpera_folder_coding_checkin_due(session, worker)
					and worker.folder_erased_at is null and not public.qorpera_coding_worker_retired(worker)
					and public.qorpera_folder_parent_continuation(worker.steering_run_id, 'worker-completion') in ('ready', 'stopped', 'gone'))
			and not public.qorpera_company_deleting(f.profile_id)
			and not public.qorpera_company_execution_paused(f.profile_id)
			and not public.qorpera_company_at_zero(f.profile_id, clock_timestamp())
		order by f.environment_id limit p_limit) x;
	return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('environment_id', e) order by e)
			from unnest(v_environments) e), '[]'::jsonb),
		'has_more', cardinality(v_environments) = p_limit,
		'next_after_environment_id', case when cardinality(v_environments) = p_limit
			then v_environments[cardinality(v_environments)] end);
end $$;

-- One company's step, in its own transaction (read committed): up to p_limit sessions, longest quiet first. Answers
-- {schema, state: done | idle | paused | at_zero | busy | deleting | not_folder, asked, suppressed, undeliverable}.
create function public.qorpera_folder_coding_checkins_company(p_environment_id uuid, p_limit integer default 8)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-coding-checkins/v1';
	v_profile uuid; v_candidates jsonb; v_targets jsonb; v_sessions uuid[]; v_item jsonb; v_ready jsonb := '[]'::jsonb;
	v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype; v_state text;
	v_since timestamptz; v_mark smallint; v_last text; v_archive_days integer; v_question text; v_payload jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_asked integer := 0; v_suppressed integer := 0; v_undeliverable integer := 0; v_error text;
begin
	-- 20260930107500 (C3c).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder coding check-ins run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 32 then
		raise exception 'Folder coding check-ins limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;
	-- 1. Plain reads: the due sessions whose parent is ready, stopped or gone, longest quiet first.
	select coalesce(jsonb_agg(jsonb_build_object('worker', c.worker_id, 'parent', c.parent, 'state', c.state)
			order by c.since, c.worker_id), '[]'::jsonb) into v_candidates
	from (select q.worker_id, q.parent, q.since, q.state from (
			select session.worker_id, worker.steering_run_id as parent,
				greatest(session.updated_at, coalesce(session.busy_at, session.updated_at)) as since,
				public.qorpera_folder_parent_continuation(worker.steering_run_id, 'worker-completion') as state
			from public.qorpera_coding_sessions session join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			where session.environment_id = p_environment_id and session.profile_id = v_profile and session.archived_at is null
				and public.qorpera_folder_coding_checkin_due(session, worker)
				and worker.folder_erased_at is null and not public.qorpera_coding_worker_retired(worker)) q
		where q.state in ('ready', 'stopped', 'gone') order by q.since, q.worker_id limit p_limit) c;
	if jsonb_array_length(v_candidates) = 0 then return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	select coalesce(jsonb_agg(distinct t.t), '[]'::jsonb) into v_targets from (
		-- Each session's coding worker rows (ranks 1 to 5, as every writer of a coding worker), none required: a worker
		-- gone meanwhile is seen under the locks.
		select jsonb_set(target.value, '{required}', 'false'::jsonb) as t
		from jsonb_array_elements(v_candidates) x join public.qorpera_runtime_workers w on w.id = (x.value ->> 'worker')::uuid
		cross join lateral jsonb_array_elements(public.qorpera_coding_worker_targets(w)) target
		union all
		-- The ready parents' requesters, agents and authorities KEY SHARE (ranks 1 to 3), as the question's wake.
		select p.t from jsonb_array_elements(v_candidates) x join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid
		cross join lateral (values
			(case when r.requested_by_user_id is not null then jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', v_profile::text || ':' || r.requested_by_user_id::text, 'mode', 'keyshare', 'required', false) end),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || r.staff_agent_id::text,
				'mode', 'keyshare', 'required', false)),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || r.staff_agent_id::text, 'mode', 'keyshare', 'required', false))) p(t)
		where x.value ->> 'state' = 'ready' and r.profile_id = v_profile and p.t is not null) t;
	begin
		-- 2. The fence KEY SHARE, rank 0, ranks 1 to 5.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;
		-- Out of computer hours a question would only wait with the company's other wakes: it is asked once hours arrive.
		if public.qorpera_company_at_zero(v_profile, clock_timestamp()) then
			return jsonb_build_object('schema', c_schema, 'state', 'at_zero'); end if;
		-- 3. The ready parents' conversations KEY SHARE in id order (rank 10), then the sessions in worker order.
		select array_agg(distinct r.session_id) into v_sessions from jsonb_array_elements(v_candidates) x
		join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid
		where x.value ->> 'state' = 'ready' and r.session_id is not null;
		perform 1 from public.qorpera_shared_sessions where id = any(coalesce(v_sessions, '{}')) and profile_id = v_profile
		order by id for key share;
		perform 1 from public.qorpera_coding_sessions
		where worker_id = any(array(select (x.value ->> 'worker')::uuid from jsonb_array_elements(v_candidates) x))
		order by worker_id for no key update;
		-- 4. Each session again under the locks. One no longer due is left. An erased or retired worker, or a stopped parent,
		-- has the mark counted as asked (suppressed); a gone parent's is undeliverable. A parent ready now but not at the
		-- plain read (its rows not taken above) is asked at the next step. A person who stopped a question of this quiet
		-- period is not asked again in it.
		for v_item in select x.value from jsonb_array_elements(v_candidates) x loop
			select * into v_worker from public.qorpera_runtime_workers where id = (v_item ->> 'worker')::uuid;
			select * into v_session from public.qorpera_coding_sessions where worker_id = (v_item ->> 'worker')::uuid;
			continue when v_worker.id is null or v_session.worker_id is null
				or not public.qorpera_folder_coding_checkin_due(v_session, v_worker)
				or v_worker.steering_run_id is distinct from (v_item ->> 'parent')::uuid;
			v_since := greatest(v_session.updated_at, coalesce(v_session.busy_at, v_session.updated_at));
			v_mark := public.qorpera_coding_quiet_mark(v_since);
			v_state := case when v_worker.folder_erased_at is not null or public.qorpera_coding_worker_retired(v_worker) then 'retired'
				else public.qorpera_folder_parent_continuation(v_worker.steering_run_id, 'worker-completion') end;
			if v_state in ('retired', 'stopped', 'gone') then
				update public.qorpera_coding_sessions set quiet_asked_days = v_mark, quiet_asked_for = v_since where worker_id = v_worker.id;
				if v_state = 'gone' then v_undeliverable := v_undeliverable + 1; else v_suppressed := v_suppressed + 1; end if;
			elsif v_state = 'ready' and v_item ->> 'state' = 'ready' then
				if exists (select 1 from public.qorpera_wake_occurrences asked
					join public.qorpera_execution_runs asked_run on asked_run.id = asked.run_id
					join public.qorpera_runner_jobs asked_job on asked_job.id = asked_run.job_id
					where asked.parent_run_id = v_worker.steering_run_id and asked_job.status = 'cancelled'
						and asked.occurrence_key like 'coding-quiet:' || v_worker.id::text || ':' || (extract(epoch from v_since) * 1000)::bigint::text || ':%') then
					update public.qorpera_coding_sessions set quiet_asked_days = 7, quiet_asked_for = v_since where worker_id = v_worker.id;
					v_suppressed := v_suppressed + 1;
				else
					v_ready := v_ready || jsonb_build_array(v_item);
				end if;
			end if;
		end loop;
		if jsonb_array_length(v_ready) > 0 then
			-- 5. Admission, last; then each question, its parent read again under it, which serializes the company's wake
			-- inserts: one continuation of a parent at a time (a second session of the parent, or F2's revival, waits).
			perform public.qorpera_folder_admit_wakes(v_profile);
			for v_item in select x.value from jsonb_array_elements(v_ready) x loop
				select * into v_worker from public.qorpera_runtime_workers where id = (v_item ->> 'worker')::uuid;
				select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
				continue when public.qorpera_folder_parent_continuation(v_worker.steering_run_id, 'worker-completion') <> 'ready';
				v_since := greatest(v_session.updated_at, coalesce(v_session.busy_at, v_session.updated_at));
				v_mark := public.qorpera_coding_quiet_mark(v_since);
				begin
					-- 349850's question, in the report shape the agent already reads (its summary the question).
					v_last := case v_worker.state when 'succeeded' then case when v_session.pull_request is not null
							then 'finished with a draft pull request' else 'finished' end
						when 'blocked' then 'asked its owner a question that is still unanswered'
						when 'failed' then 'failed' else 'was cancelled' end;
					select ceil(min(executor.session_archive_after_seconds) / 86400.0)::integer into v_archive_days
					from public.qorpera_coding_executors executor where executor.environment_id = v_session.environment_id;
					v_question := left(format('This is not a new report. The coding session %s (repository %s/%s, branch %s) has had no turn for %s %s%s. '
						'Its last turn %s. If the session is no longer needed, archive it now with manage_worker action archive '
						'(todoKey and workerKey as below): its programs stop, its files are kept, and a later followup reopens it. '
						'If it is still needed, or its state is active again, leave it: do not decide, follow up or post anything, and end this turn. '
						'Left alone, it is archived automatically after %s quiet days.',
						to_json(left(regexp_replace(v_worker.title, '[[:cntrl:]]+', ' ', 'g'), 160))::text,
						v_session.repository ->> 'owner', v_session.repository ->> 'name', left(regexp_replace(v_session.branch, '[[:cntrl:]]+', ' ', 'g'), 120),
						v_mark, case when v_mark = 1 then 'day' else 'days' end,
						case when v_session.attachment_until > clock_timestamp() and jsonb_array_length(v_session.running_commands) > 0
							then format(', with %s command%s still running on its machine', jsonb_array_length(v_session.running_commands),
								case when jsonb_array_length(v_session.running_commands) = 1 then '' else 's' end)
							else '' end,
						v_last, v_archive_days), 1200);
					v_payload := public.qorpera_worker_completion_payload(v_worker.steering_run_id, array[v_worker.id]);
					v_payload := jsonb_set(v_payload, '{completions,0}', (v_payload #> '{completions,0}') || jsonb_build_object(
						'outcome', case when v_worker.result ->> 'outcome' in ('succeeded','blocked','failed') then v_worker.result ->> 'outcome' else 'failed' end,
						'summary', v_question, 'summaryTruncated', false, 'needs', null, 'outputs', '[]'::jsonb));
					-- The legacy key: a new turn withdraws the queued question (qorpera_open_coding_turn), and a member who stops
					-- its run stops only it (qorpera_worker_revival_stopped).
					insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id,
						staff_agent_id, parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
					values (extensions.gen_random_uuid(), v_worker.profile_id, v_worker.environment_id, 'agent', 'worker-completion',
						v_worker.id, v_worker.staff_agent_id, v_worker.steering_run_id, 'worker-completion',
						'coding-quiet:' || v_worker.id::text || ':' || (extract(epoch from v_since) * 1000)::bigint::text || ':' || v_mark::text,
						clock_timestamp(), clock_timestamp(), v_payload)
					returning * into v_wake;
					update public.qorpera_coding_sessions set quiet_asked_days = v_mark, quiet_asked_for = v_since where worker_id = v_worker.id;
					-- Admission may cancel it at insert: the mark counts as asked all the same.
					if v_wake.status = 'queued' then
						perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'kernel',
							jsonb_build_object('text', format('Quiet for %s %s; asked the agent whether it can be archived', v_mark,
								case when v_mark = 1 then 'day' else 'days' end), 'quietDays', v_mark));
						v_asked := v_asked + 1;
					else
						v_undeliverable := v_undeliverable + 1;
					end if;
				exception when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
					or check_violation or unique_violation or program_limit_exceeded then
					-- No one to ask or pay (the agent, the requester or the conversation is gone), or asked already: this mark is
					-- not asked again, and the automatic archive remains. The step's answer names the last such refusal.
					v_error := left(sqlstate || ': ' || sqlerrm, 300);
					update public.qorpera_coding_sessions set quiet_asked_days = v_mark, quiet_asked_for = v_since where worker_id = v_worker.id;
					v_undeliverable := v_undeliverable + 1;
				end;
			end loop;
		end if;
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'asked', v_asked, 'suppressed', v_suppressed,
		'undeliverable', v_undeliverable) || case when v_error is null then '{}'::jsonb else jsonb_build_object('lastError', v_error) end;
end $$;

revoke all on function public.qorpera_folder_coding_checkin_due(public.qorpera_coding_sessions, public.qorpera_runtime_workers),
	public.qorpera_folder_coding_checkins_due(uuid, integer), public.qorpera_folder_coding_checkins_company(uuid, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_coding_checkins_due(uuid, integer),
	public.qorpera_folder_coding_checkins_company(uuid, integer) to service_role;

-- 3. F2's cancel leaves a session with a new turn since its question -----------------------------------------------------

select pg_temp.c3c_replace('public.qorpera_folder_cancel_agent_worker(jsonb,jsonb)',
	$old$	perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');$old$,
	$new$	if public.qorpera_coding_question_stale(v_run.id, v_worker) then -- 20260930107500 (C3c)
		raise exception 'The session has a new turn since you were asked; leave it' using errcode = '55000'; end if;
	perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');$new$);
