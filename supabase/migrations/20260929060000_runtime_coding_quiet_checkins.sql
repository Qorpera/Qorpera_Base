-- Coding sessions: the agent is asked before a quiet session is archived
-- (Jonas, 2026-09-28: "auto-archive after 30 quiet days, and after 1, 3, 7
-- days the agent is asked if it can be archived").
--
-- After 1, 3 and 7 days without a turn and without a command using the
-- processor, the agent that started a coding session is asked once per mark
-- whether the session can be archived. It answers with manage_worker action
-- archive, or leaves it. A session archived, reopened or busy meanwhile is not
-- asked; a new turn starts a new quiet period with its own questions. The
-- automatic archive after the environment's quiet period stays the backstop.
--
-- The question is the agent's worker-completion continuation, in its exact
-- shape (qorpera.worker-completion/v1, one completion whose summary is the
-- question), so the runtime and the web need no change. It is admitted like
-- any other report: the steering run's requester pays under the starter rule,
-- one revival of a parent runs at a time, a stopped revival or a paused company
-- holds it back. The executor's quiet-session scan asks, a few per call.

-- A busy sessions table fails the migration fast instead of holding every coding call behind it.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. State: which mark of which quiet period has been asked
-- ---------------------------------------------------------------------------
alter table public.qorpera_coding_sessions
	add column quiet_asked_days smallint check (quiet_asked_days in (1,3,7)),
	add column quiet_asked_for timestamptz,
	add constraint qorpera_coding_sessions_quiet_asked_check check (num_nulls(quiet_asked_days, quiet_asked_for) in (0,2));

create function pg_temp.checkin_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding quiet check-in integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The question
-- ---------------------------------------------------------------------------
-- Internal: the mark a quiet period has reached (7, 3 or 1 days), or null.
create function public.qorpera_coding_quiet_mark(p_quiet_since timestamptz)
returns smallint language sql volatile set search_path = '' as $$
	select case when p_quiet_since <= clock_timestamp() - interval '7 days' then 7
		when p_quiet_since <= clock_timestamp() - interval '3 days' then 3
		when p_quiet_since <= clock_timestamp() - interval '1 day' then 1 end::smallint
$$;

-- The executor asks the agents of its environments' quiet sessions, a few per
-- call. Only the latest mark reached is asked (an executor that was away does
-- not ask three times at once). Never waits for a lock: a session held by
-- anyone is asked at a later scan.
create function public.qorpera_ask_quiet_coding_sessions(p_owner text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_candidate record; v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_parent public.qorpera_execution_runs%rowtype; v_status text; v_since timestamptz; v_mark smallint; v_id uuid;
	v_inserted public.qorpera_wake_occurrences%rowtype; v_last text; v_question text; v_payload jsonb; v_count integer := 0;
	v_archive_days integer;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	for v_candidate in
		select session.worker_id, worker.todo_id from public.qorpera_coding_sessions session
		join public.qorpera_coding_executors executor on executor.environment_id = session.environment_id and executor.owner = p_owner
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where session.archived_at is null and worker.state <> 'active' and worker.completion_state <> 'waiting'
			and worker.steering_run_id is not null
			and public.qorpera_coding_quiet_mark(greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))) is not null
			and (session.quiet_asked_for is distinct from greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
				or session.quiet_asked_days < public.qorpera_coding_quiet_mark(session.quiet_asked_for))
			-- What would only be held back is left out here, so it never crowds out the sessions that can be asked:
			-- a paused company, a parent still running, a revival of the parent on its way.
			and not public.qorpera_company_execution_paused(worker.profile_id)
			and exists (select 1 from public.qorpera_execution_runs parent join public.qorpera_runner_jobs job on job.id = parent.job_id
				where parent.id = worker.steering_run_id and job.status not in ('queued','leased'))
			and not exists (select 1 from public.qorpera_wake_occurrences pending
				left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
				left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
				where pending.parent_run_id = worker.steering_run_id and pending.source_kind = 'worker-completion'
					and (pending.status = 'queued' or (pending.status = 'materialized'
						and (pending_job.id is null or pending_job.status in ('queued','leased')))))
		-- In todo order, as the archive scan, so executors lock todos the same way round.
		order by worker.todo_id, worker.id limit 8
	loop
		begin
			-- Todo, worker, session, as every writer of a coding worker; never waiting.
			perform 1 from public.qorpera_runtime_agent_todos where id = v_candidate.todo_id for update nowait;
			select * into strict v_worker from public.qorpera_runtime_workers where id = v_candidate.worker_id for update nowait;
			select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker.id for update nowait;
			v_since := greatest(v_session.updated_at, coalesce(v_session.busy_at, v_session.updated_at));
			v_mark := public.qorpera_coding_quiet_mark(v_since);
			-- Still quiet, still open, not asked this mark, and no report of it on its way to the agent.
			if v_session.archived_at is not null or v_worker.state = 'active' or v_worker.completion_state = 'waiting'
				or v_worker.todo_id is distinct from v_candidate.todo_id or v_mark is null
				or (v_session.quiet_asked_for = v_since and v_session.quiet_asked_days >= v_mark) then continue; end if;
			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
			select * into v_parent from public.qorpera_execution_runs where id = v_worker.steering_run_id;
			select status into v_status from public.qorpera_runner_jobs where id = v_parent.job_id;
			-- A parent still running is asked after it ends; one stopped by a person, or with a stopped revival, is not asked.
			if v_status is null or v_status in ('queued','leased') then continue; end if;
			if v_status = 'cancelled' or public.qorpera_worker_revival_stopped(v_worker.steering_run_id) then
				update public.qorpera_coding_sessions set quiet_asked_days = v_mark, quiet_asked_for = v_since where worker_id = v_worker.id;
				continue;
			end if;
			-- One revival of a parent at a time, as the report drain.
			perform public.qorpera_serialize_wake_admission(v_worker.profile_id);
			if exists (select 1 from public.qorpera_wake_occurrences pending
				left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
				left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
				where pending.parent_run_id = v_worker.steering_run_id and pending.source_kind = 'worker-completion'
					and (pending.status = 'queued' or (pending.status = 'materialized'
						and (pending_job.id is null or pending_job.status in ('queued','leased'))))) then continue; end if;
			v_last := case v_worker.state when 'succeeded' then case when v_session.pull_request is not null
					then 'finished with a draft pull request' else 'finished' end
				when 'blocked' then 'asked its owner a question that is still unanswered'
				when 'failed' then 'failed' else 'was cancelled' end;
			select ceil(min(executor.session_archive_after_seconds) / 86400.0)::integer into v_archive_days
			from public.qorpera_coding_executors executor where executor.environment_id = v_session.environment_id and executor.owner = p_owner;
			v_question := left(format('This is not a new report. The coding session %s (repository %s/%s, branch %s) has had no turn for %s %s%s. '
				'Its last turn %s. If the session is no longer needed, archive it now with manage_worker action archive '
				'(todoKey and workerKey as below): its programs stop, its files are kept, and a later followup reopens it. '
				'If it is still needed, or its state is active again, leave it: do not decide, follow up or post anything, and end this turn. '
				'Left alone, it is archived automatically after %s quiet days.',
				to_json(left(v_worker.title, 160))::text, v_session.repository ->> 'owner', v_session.repository ->> 'name', left(v_session.branch, 120),
				v_mark, case when v_mark = 1 then 'day' else 'days' end,
				case when v_session.attachment_until > clock_timestamp() and jsonb_array_length(v_session.running_commands) > 0
					then format(', with %s command%s still running on its machine', jsonb_array_length(v_session.running_commands),
						case when jsonb_array_length(v_session.running_commands) = 1 then '' else 's' end)
					else '' end,
				v_last, v_archive_days), 1200);
			-- The report shape the agent already reads, its summary the question.
			v_payload := public.qorpera_worker_completion_payload(v_worker.steering_run_id, array[v_worker.id]);
			v_payload := jsonb_set(v_payload, '{completions,0}', (v_payload #> '{completions,0}') || jsonb_build_object(
				'outcome', case when v_worker.result ->> 'outcome' in ('succeeded','blocked','failed') then v_worker.result ->> 'outcome' else 'failed' end,
				'summary', v_question, 'summaryTruncated', false, 'needs', null, 'outputs', '[]'::jsonb));
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (v_id, v_worker.profile_id, v_worker.environment_id, 'agent', 'worker-completion', v_worker.id, v_worker.staff_agent_id,
				v_worker.steering_run_id, 'worker-completion',
				'coding-quiet:' || v_worker.id::text || ':' || (extract(epoch from v_since) * 1000)::bigint::text || ':' || v_mark::text,
				clock_timestamp(), clock_timestamp(), v_payload)
			returning * into v_inserted;
			update public.qorpera_coding_sessions set quiet_asked_days = v_mark, quiet_asked_for = v_since where worker_id = v_worker.id;
			-- Admission may cancel it (the company paused meanwhile): the mark counts as asked all the same.
			if v_inserted.status = 'queued' then
				perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'kernel',
					jsonb_build_object('text', format('Quiet for %s %s; asked the agent whether it can be archived', v_mark,
						case when v_mark = 1 then 'day' else 'days' end), 'quietDays', v_mark));
				v_count := v_count + 1;
			end if;
		exception when lock_not_available or deadlock_detected then continue;
			when insufficient_privilege or no_data_found or object_not_in_prerequisite_state or unique_violation then
				-- No one to ask or pay (the agent, the requester or the conversation is gone), or already asked: this
				-- mark is not asked again. The automatic archive remains.
				perform 1 from public.qorpera_coding_sessions where worker_id = v_candidate.worker_id for update skip locked;
				if found then
					update public.qorpera_coding_sessions
					set quiet_asked_for = greatest(updated_at, coalesce(busy_at, updated_at)),
						quiet_asked_days = public.qorpera_coding_quiet_mark(greatest(updated_at, coalesce(busy_at, updated_at)))
					where worker_id = v_candidate.worker_id
						and public.qorpera_coding_quiet_mark(greatest(updated_at, coalesce(busy_at, updated_at))) is not null;
				end if;
		end;
	end loop;
	return v_count;
end
$$;

-- The executor's quiet-session scan asks as well; it still returns how many it archived.
select pg_temp.checkin_patch('public.qorpera_archive_quiet_coding_sessions(text)',
	$old$	end loop;
	return v_count;$old$,
	$new$	end loop;
	-- An unexpected failure of the questions never undoes the archive; it is reported and tried at the next scan.
	begin
		perform public.qorpera_ask_quiet_coding_sessions(p_owner);
	exception when others then
		raise warning 'Coding quiet check-ins failed: % (%)', sqlerrm, sqlstate;
	end;
	return v_count;$new$);

-- A member who stops a question run stops only that run: it is no revival of
-- the parent's work, so the parent's other workers and reports go on.
select pg_temp.checkin_patch('public.qorpera_worker_revival_stopped(uuid)',
	$old$		where revival.parent_run_id = p_steering_run_id and revival.source_kind = 'worker-completion'$old$,
	$new$		where revival.parent_run_id = p_steering_run_id and revival.source_kind = 'worker-completion'
			and revival.occurrence_key not like 'coding-quiet:%'$new$);

-- A new turn (the owner's answer, the agent's followup or dispatch) withdraws
-- a question about the session that no run has taken yet.
select pg_temp.checkin_patch('public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)',
	$old$		perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, 'step', 'kernel', jsonb_build_object('text', 'Reopened', 'reopened', true));
	end if;$old$,
	$new$		perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, 'step', 'kernel', jsonb_build_object('text', 'Reopened', 'reopened', true));
	end if;
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where parent_run_id = p_worker.steering_run_id and status = 'queued' and occurrence_key like 'coding-quiet:' || p_worker.id::text || ':%';$new$);

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_quiet_mark(timestamptz),
	public.qorpera_ask_quiet_coding_sessions(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_ask_quiet_coding_sessions(text) to service_role;
