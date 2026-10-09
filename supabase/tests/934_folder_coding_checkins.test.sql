-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- C3c (migration 20260930107500, deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md §9): the quiet coding check-ins on
-- folder-v2, the shared drains' `coding_checkins`. After 1, 3 and 7 quiet days the agent that started a session is asked
-- once per mark, in 349850's words and report shape, as a worker-completion continuation of its run. Nothing is asked
-- while the parent runs; one question of a parent at a time, longest quiet first; a worker retired or erased (before the
-- step, or meanwhile under its locks) has its mark counted as asked; a new turn withdraws a queued question and fences the
-- question's run from cancelling or archiving the session; a member who stops a question's run stops only it, and is not
-- asked again in that quiet period; a stopped parent suppresses, a gone one is undeliverable; a paused, deleting or
-- out-of-hours company is left alone; a lock timeout answers busy. 928's helpers on 924's base: Alice's run, four of its
-- coding sessions (cancelled, so they stand quiet).

do $$
declare v_alice jsonb := pg_temp.c3_alice();
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-934', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	for i in 1 .. 4 loop
		perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'c3c-dispatch-' || i,
			'agents/alice/todos/fix-login/session-' || chr(96 + i), pg_temp.c3_brief(('93400000-0000-4000-8000-0000000000b' || i)::uuid))
			-> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch ' || i);
		perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder',
			'agents/alice/todos/fix-login/session-' || chr(96 + i), 'operationKey', 'c3c-cancel-' || i));
	end loop;
	-- Quiet for a day and more: b3 and b4 longest, then b1, then b2.
	update public.qorpera_coding_sessions set busy_at = null, updated_at = clock_timestamp() - case worker_id
			when '93400000-0000-4000-8000-0000000000b1' then interval '26 hours'
			when '93400000-0000-4000-8000-0000000000b2' then interval '25 hours' else interval '27 hours' end
	where worker_id in ('93400000-0000-4000-8000-0000000000b1', '93400000-0000-4000-8000-0000000000b2',
		'93400000-0000-4000-8000-0000000000b3', '93400000-0000-4000-8000-0000000000b4');
end $$;

-- The company's step and whether the page lists the company, as the drain calls them.
create function pg_temp.c3c_step(p_limit integer default 8) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_coding_checkins_company('92400000-0000-4000-8000-000000000020', p_limit);
end $$;
create function pg_temp.c3c_due() returns boolean language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_coding_checkins_due(null, 100) -> 'items' @> '[{"environment_id":"92400000-0000-4000-8000-000000000020"}]';
end $$;
-- A step's counts, as "asked/suppressed/undeliverable".
create function pg_temp.c3c_counts(p_step jsonb) returns text language sql as $$
	select case when p_step ->> 'state' = 'done' then concat_ws('/', p_step ->> 'asked', p_step ->> 'suppressed', p_step ->> 'undeliverable')
		else p_step ->> 'state' end
$$;
-- Whether a session's mark asked is p_days for its current quiet period (null: none asked).
create function pg_temp.c3c_marked(p_worker uuid, p_days integer) returns boolean language sql as $$
	select s.quiet_asked_days is not distinct from p_days::smallint and s.quiet_asked_for is not distinct from
		case when p_days is not null then greatest(s.updated_at, coalesce(s.busy_at, s.updated_at)) end
	from public.qorpera_coding_sessions s where s.worker_id = p_worker
$$;
-- The question about a session's mark in its current quiet period (349850's key), if any.
create function pg_temp.c3c_wake(p_worker uuid, p_mark integer) returns public.qorpera_wake_occurrences language plpgsql as $$
declare v_wake public.qorpera_wake_occurrences;
begin
	select w.* into v_wake from public.qorpera_wake_occurrences w join public.qorpera_coding_sessions s on s.worker_id = p_worker
	where w.occurrence_key = 'coding-quiet:' || p_worker::text || ':'
		|| (extract(epoch from greatest(s.updated_at, coalesce(s.busy_at, s.updated_at))) * 1000)::bigint::text || ':' || p_mark::text;
	return v_wake;
end $$;
-- A session quiet for p_by longer: its quiet period, its asked mark and its questions' keys move back together.
create function pg_temp.c3c_age(p_worker uuid, p_by interval) returns void language plpgsql as $$
begin
	update public.qorpera_coding_sessions set updated_at = updated_at - p_by, busy_at = busy_at - p_by,
		quiet_asked_for = quiet_asked_for - p_by where worker_id = p_worker;
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set occurrence_key = 'coding-quiet:' || p_worker::text || ':'
		|| (split_part(occurrence_key, ':', 3)::bigint - (extract(epoch from p_by) * 1000)::bigint)::text || ':' || split_part(occurrence_key, ':', 4)
	where source_id = p_worker and occurrence_key like 'coding-quiet:%';
	set local session_replication_role = origin;
end $$;
-- A question's run: the materializer makes it, a runner leases it; answers its binding.
create function pg_temp.c3c_run(p_wake uuid) returns jsonb language plpgsql as $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid;
begin
	select run_id into v_run from public.qorpera_wake_occurrences where id = p_wake and status = 'materialized';
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run), 'the question''s run: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end $$;
-- A run's job ends (completed) or is stopped by the owner (cancelled), with the columns each state requires (848's).
create function pg_temp.c3c_end(p_binding jsonb, p_status text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = p_status, lease_token_sha256 = null, lease_expires_at = null,
		result = case when p_status = 'completed' then '{}'::jsonb end,
		finished_at = case when p_status = 'completed' then clock_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then clock_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '92400000-0000-4000-8000-000000000001'::uuid end
	where id = (p_binding ->> 'jobId')::uuid;
	set local session_replication_role = origin;
end $$;
-- A worker's folder retired, or erased as P18b erases it.
create function pg_temp.c3c_retire(p_worker uuid, p_erase boolean) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set folder_retired_at = coalesce(folder_retired_at, clock_timestamp()) where id = p_worker;
	if p_erase then
		update public.qorpera_runtime_workers set title = 'Erased', worker_key = 'erased.' || replace(id::text, '-', ''),
			folder_path = null, folder_key = null, folder_environment_id = null, folder_erased_at = clock_timestamp()
		where id = p_worker;
	end if;
	set local session_replication_role = origin;
end $$;
-- p_sql runs inside the step, after its plain reads and before its locks (the fence's entry); null restores the entry.
create function pg_temp.c3c_meanwhile(p_sql text) returns void language plpgsql as $fn$
begin
	if p_sql is null then
		drop function public.qorpera_folder_company_enter(uuid, uuid, jsonb, boolean);
		alter function public.qorpera_folder_company_enter_kept(uuid, uuid, jsonb, boolean) rename to qorpera_folder_company_enter;
		return;
	end if;
	alter function public.qorpera_folder_company_enter(uuid, uuid, jsonb, boolean) rename to qorpera_folder_company_enter_kept;
	execute format($f$create function public.qorpera_folder_company_enter(p_environment_id uuid, p_profile_id uuid,
		p_targets jsonb, p_refuse_paused boolean) returns void language plpgsql security definer set search_path = '' as $b$
	begin
		execute %L;
		perform public.qorpera_folder_company_enter_kept(p_environment_id, p_profile_id, p_targets, p_refuse_paused);
	end $b$$f$, p_sql);
end $fn$;
-- A question's run cancelling or archiving a session, as manage_worker calls them.
create function pg_temp.c3c_cancel(p_binding jsonb, p_folder text, p_key text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_cancel_agent_worker(p_binding, jsonb_build_object('folder', p_folder, 'operationKey', p_key));
end $$;
create function pg_temp.c3c_archive(p_binding jsonb, p_folder text, p_key text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_archive_coding_worker(p_binding, jsonb_build_object('folder', p_folder, 'operationKey', p_key));
end $$;

-- 1. While the parent runs, nothing is asked --------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(public.qorpera_folder_parent_continuation((pg_temp.c3_alice() ->> 'runId')::uuid, 'worker-completion')
		= 'running' and public.qorpera_folder_coding_checkin_due(pg_temp.c3_session('93400000-0000-4000-8000-0000000000b1'),
			pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')), 'a due session of a running parent');
	perform pg_temp.base_assert(not pg_temp.c3c_due() and pg_temp.c3c_step() ->> 'state' = 'idle', 'nothing asked while it runs');
	perform pg_temp.c3c_end(pg_temp.c3_alice(), 'completed');
end $$;

-- 2. Its turn ended: the longest quiet first, one question of the parent at a time; a worker retired or erased meanwhile
--    has its mark counted as asked -------------------------------------------------------------------------------------
select pg_temp.c3c_meanwhile($$select pg_temp.c3c_retire('93400000-0000-4000-8000-0000000000b3', false),
	pg_temp.c3c_retire('93400000-0000-4000-8000-0000000000b4', true)$$);
do $$
declare v_step jsonb; v_wake public.qorpera_wake_occurrences; w public.qorpera_runtime_workers; v_completion jsonb;
begin
	perform pg_temp.base_assert(pg_temp.c3c_due(), 'due once the parent ended');
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(v_step ->> 'schema' = 'qorpera.folder-coding-checkins/v1' and pg_temp.c3c_counts(v_step) = '1/2/0'
		and not v_step ? 'lastError', 'one asked, two retired meanwhile: ' || v_step::text);
	perform pg_temp.base_assert(pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b3', 1)
		and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b4', 1)
		and (pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b4')).folder_erased_at is not null, 'their marks counted as asked');
	perform pg_temp.base_assert(pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b3', 1) is null
		and pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b4', 1) is null, 'no question about them');
	-- b1 is asked; b2 waits for the parent's next continuation.
	w := pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1');
	v_wake := pg_temp.c3c_wake(w.id, 1);
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.wake_kind = 'agent' and v_wake.source_kind = 'worker-completion'
		and v_wake.trigger_id = 'worker-completion' and v_wake.source_id = w.id and v_wake.staff_agent_id = w.staff_agent_id
		and v_wake.parent_run_id = (pg_temp.c3_alice() ->> 'runId')::uuid, 'the question: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(pg_temp.c3c_marked(w.id, 1) and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', null)
		and pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 1) is null, 'b2 waits');
	-- 349850's question, in the report shape the agent reads.
	v_completion := v_wake.payload -> 'completions' -> 0;
	perform pg_temp.base_assert(v_wake.payload ->> 'schema' = 'qorpera.worker-completion/v1'
		and v_wake.payload ->> 'parentRunId' = pg_temp.c3_alice() ->> 'runId' and jsonb_array_length(v_wake.payload -> 'completions') = 1
		and v_completion ->> 'workerKey' = w.worker_key and v_completion ->> 'title' = 'Fix the login page'
		and (v_completion ->> 'sequence')::integer = 1 and v_completion ->> 'outcome' = 'failed'
		and not (v_completion ->> 'summaryTruncated')::boolean and v_completion -> 'needs' = 'null'::jsonb
		and v_completion -> 'outputs' = '[]'::jsonb, 'the payload: ' || v_wake.payload::text);
	perform pg_temp.base_assert(v_completion ->> 'summary' = format('This is not a new report. The coding session "Fix the login page" '
		'(repository Qorpera/Qorpera_Base, branch qorpera/coding/%s) has had no turn for 1 day. Its last turn was cancelled. If the '
		'session is no longer needed, archive it now with manage_worker action archive (todoKey and workerKey as below): its programs '
		'stop, its files are kept, and a later followup reopens it. If it is still needed, or its state is active again, leave it: do '
		'not decide, follow up or post anything, and end this turn. Left alone, it is archived automatically after 30 quiet days.', w.id),
		'the question''s words: ' || (v_completion ->> 'summary'));
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_session_events e where e.worker_id = w.id and e.kind = 'step'
		and e.body = '{"text":"Quiet for 1 day; asked the agent whether it can be archived","quietDays":1}'::jsonb) = 1, 'its event');
end $$;
select pg_temp.c3c_meanwhile(null);
-- b2's continuation waits for the question's.
select pg_temp.base_assert(pg_temp.c3c_step() ->> 'state' = 'idle' and not pg_temp.c3c_due(), 'one question of the parent at a time');

-- 3. A new turn since the question: its run may neither cancel nor archive the session --------------------------------
do $$
declare v_folder text := 'agents/alice/todos/fix-login/session-a';
	v_q1 jsonb := pg_temp.c3c_run((pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b1', 1)).id);
begin
	perform pg_temp.c3_answer('93400000-0000-4000-8000-0000000000b1', 'Keep going.');
	perform pg_temp.base_assert((pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')).state = 'active'
		and (pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')).sequence = 2, 'the owner''s new turn');
	perform pg_temp.base_error(format('select pg_temp.c3c_cancel(%L, %L, %L)', v_q1, v_folder, 'c3c-q1-cancel'), '55000',
		'The session has a new turn since you were asked; leave it');
	perform pg_temp.base_error(format('select pg_temp.c3c_archive(%L, %L, %L)', v_q1, v_folder, 'c3c-q1-archive'), '55000',
		'The session has a new turn since you were asked; leave it');
	perform pg_temp.base_assert((pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')).state = 'active'
		and (pg_temp.c3_session('93400000-0000-4000-8000-0000000000b1')).archived_at is null, 'the session works on');
	perform pg_temp.c3c_end(v_q1, 'completed');
end $$;

-- 4. The parent's next session once the question's run ended; retired and erased workers are no candidates; a mark asked
--    already is not asked twice ---------------------------------------------------------------------------------------
do $$
declare v_step jsonb; v_q2 jsonb;
begin
	perform pg_temp.c3c_age('93400000-0000-4000-8000-0000000000b3', interval '48 hours');
	perform pg_temp.c3c_age('93400000-0000-4000-8000-0000000000b4', interval '48 hours');
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '1/0/0' and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 1)
		and (pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 1)).status = 'queued', 'b2 asked: ' || v_step::text);
	perform pg_temp.base_assert((pg_temp.c3_session('93400000-0000-4000-8000-0000000000b3')).quiet_asked_days = 1
		and (pg_temp.c3_session('93400000-0000-4000-8000-0000000000b4')).quiet_asked_days = 1, 'b3 and b4 not asked at 3 days');
	-- The question's run may cancel another session: its question is b2's.
	v_q2 := pg_temp.c3c_run((pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 1)).id);
	perform pg_temp.c3c_cancel(v_q2, 'agents/alice/todos/fix-login/session-a', 'c3c-q2-cancel');
	perform pg_temp.base_assert((pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')).state = 'cancelled', 'b1 cancelled by Q2');
	perform pg_temp.c3c_end(v_q2, 'completed');
	-- A mark asked already (its marks lost): the same key is refused, and the mark counts as asked.
	update public.qorpera_coding_sessions set quiet_asked_days = null, quiet_asked_for = null
	where worker_id = '93400000-0000-4000-8000-0000000000b2';
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '0/0/1' and v_step ->> 'lastError' like '23505: %qorpera_wake_nonroutine_source%'
		and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 1), 'asked already: ' || v_step::text);
end $$;

-- 5. A worker retired or erased is not listed, though its next mark is due ----------------------------------------------
select pg_temp.base_assert(public.qorpera_folder_coding_checkin_due(pg_temp.c3_session(id), pg_temp.c3_worker(id))
	and not pg_temp.c3c_due() and pg_temp.c3c_step() ->> 'state' = 'idle', 'retired and erased workers are no candidates')
from (values ('93400000-0000-4000-8000-0000000000b3'::uuid), ('93400000-0000-4000-8000-0000000000b4'::uuid)) v(id);

-- 6. Mark 3, whose question a member stops: that stops only the question --------------------------------------------
do $$
declare v_step jsonb; v_wake public.qorpera_wake_occurrences; v_q3 jsonb; v_alice uuid := (pg_temp.c3_alice() ->> 'runId')::uuid;
	v_key text;
begin
	perform pg_temp.c3c_age('93400000-0000-4000-8000-0000000000b2', interval '48 hours');
	v_step := pg_temp.c3c_step();
	v_wake := pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 3);
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '1/0/0' and v_wake.status = 'queued'
		and v_wake.payload #>> '{completions,0,summary}' like '% has had no turn for 3 days. %'
		and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 3), 'mark 3: ' || v_step::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_coding_session_events e
		where e.worker_id = '93400000-0000-4000-8000-0000000000b2' and e.kind = 'step'
			and e.body = '{"text":"Quiet for 3 days; asked the agent whether it can be archived","quietDays":3}'::jsonb), 'its event');
	v_q3 := pg_temp.c3c_run(v_wake.id);
	perform pg_temp.c3c_end(v_q3, 'cancelled');
	-- The parent's other work goes on; a revival stopped the same way would stop it (the machine events' rule is apart).
	perform pg_temp.base_assert(public.qorpera_folder_parent_continuation(v_alice, 'worker-completion') = 'ready', 'only the question stopped');
	v_key := v_wake.occurrence_key;
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set occurrence_key = 'worker-completion:' || source_id::text || ':1' where id = v_wake.id;
	perform pg_temp.base_assert(public.qorpera_folder_parent_continuation(v_alice, 'worker-completion') = 'stopped'
		and public.qorpera_folder_parent_continuation(v_alice, 'machine-event') = 'ready', 'a stopped revival stops the parent');
	update public.qorpera_wake_occurrences set occurrence_key = v_key where id = v_wake.id;
	set local session_replication_role = origin;
end $$;

-- 7. Mark 7 of the stopped question's quiet period counts as asked; another session's mark 7 is asked, and a new turn
--    withdraws it ------------------------------------------------------------------------------------------------------
do $$
declare v_step jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.c3c_age('93400000-0000-4000-8000-0000000000b2', interval '96 hours');
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '0/1/0' and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 7)
		and pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 7) is null, 'not asked again: ' || v_step::text);
	perform pg_temp.c3c_age('93400000-0000-4000-8000-0000000000b1', interval '192 hours');
	v_step := pg_temp.c3c_step();
	v_wake := pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b1', 7);
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '1/0/0' and v_wake.status = 'queued'
		and v_wake.payload #>> '{completions,0,summary}' like '% has had no turn for 7 days. Its last turn was cancelled. %'
		and (v_wake.payload #>> '{completions,0,sequence}')::integer = 2, 'b1 at 7 days: ' || v_step::text);
	perform pg_temp.c3_answer('93400000-0000-4000-8000-0000000000b1', 'One more thing.');
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences where id = v_wake.id) = 'cancelled'
		and (pg_temp.c3_worker('93400000-0000-4000-8000-0000000000b1')).state = 'active', 'the new turn withdraws it');
end $$;

-- 8. A paused, deleting or out-of-hours company is left alone; a lock timeout answers busy -------------------------------
update public.qorpera_coding_sessions set quiet_asked_days = null, quiet_asked_for = null
where worker_id = '93400000-0000-4000-8000-0000000000b2';
do $$
declare v_page jsonb;
begin
	perform pg_temp.base_assert(pg_temp.c3c_due(), 'b2 due again');
	v_page := public.qorpera_folder_coding_checkins_due(null, 1);
	perform pg_temp.base_assert(v_page = '{"items":[{"environment_id":"92400000-0000-4000-8000-000000000020"}],"has_more":true,
		"next_after_environment_id":"92400000-0000-4000-8000-000000000020"}'::jsonb
		and public.qorpera_folder_coding_checkins_due('92400000-0000-4000-8000-000000000020', 100)
			= '{"items":[],"has_more":false,"next_after_environment_id":null}'::jsonb, 'the page: ' || v_page::text);
	perform public.qorpera_folder_pause('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'c3c');
	perform pg_temp.base_assert(not pg_temp.c3c_due() and pg_temp.c3c_step() ->> 'state' = 'paused', 'paused');
	perform public.qorpera_folder_resume('92400000-0000-4000-8000-000000000010');
end $$;
alter function public.qorpera_company_deleting(uuid) rename to qorpera_company_deleting_kept;
create function public.qorpera_company_deleting(p_profile_id uuid) returns boolean language sql stable set search_path = '' as $$
	select true
$$;
select pg_temp.base_assert(not pg_temp.c3c_due() and pg_temp.c3c_step() ->> 'state' = 'deleting', 'deleting');
drop function public.qorpera_company_deleting(uuid);
alter function public.qorpera_company_deleting_kept(uuid) rename to qorpera_company_deleting;
alter function public.qorpera_company_at_zero(uuid, timestamptz) rename to qorpera_company_at_zero_kept;
create function public.qorpera_company_at_zero(p_profile_id uuid, p_at timestamptz) returns boolean language sql stable
set search_path = '' as $$
	select true
$$;
select pg_temp.base_assert(not pg_temp.c3c_due() and pg_temp.c3c_step() ->> 'state' = 'at_zero', 'out of computer hours');
drop function public.qorpera_company_at_zero(uuid, timestamptz);
alter function public.qorpera_company_at_zero_kept(uuid, timestamptz) rename to qorpera_company_at_zero;
select pg_temp.c3c_meanwhile($m$do $x$ begin raise exception 'A lock is held' using errcode = '55P03'; end $x$$m$);
select pg_temp.base_assert(pg_temp.c3c_step() ->> 'state' = 'busy', 'busy');
select pg_temp.c3c_meanwhile(null);
select pg_temp.base_assert(pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', null) and pg_temp.c3c_due(), 'nothing asked');

-- 9. A stopped parent's mark counts as asked; a gone parent's is undeliverable -----------------------------------------
do $$
declare v_step jsonb;
begin
	perform pg_temp.c3c_end(pg_temp.c3_alice(), 'cancelled');
	perform pg_temp.base_assert(pg_temp.c3c_due(), 'a stopped parent''s session is due');
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '0/1/0' and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 7)
		and pg_temp.c3c_wake('93400000-0000-4000-8000-0000000000b2', 7) is null, 'stopped: ' || v_step::text);
	update public.qorpera_coding_sessions set quiet_asked_days = null, quiet_asked_for = null
	where worker_id = '93400000-0000-4000-8000-0000000000b2';
	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set steering_run_id = extensions.gen_random_uuid()
	where id = '93400000-0000-4000-8000-0000000000b2';
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.c3c_due(), 'a gone parent''s session is due');
	v_step := pg_temp.c3c_step();
	perform pg_temp.base_assert(pg_temp.c3c_counts(v_step) = '0/0/1' and pg_temp.c3c_marked('93400000-0000-4000-8000-0000000000b2', 7)
		and not pg_temp.c3c_due(), 'gone: ' || v_step::text);
end $$;

-- 10. Bounds, authority, grants and markers ----------------------------------------------------------------------------
select pg_temp.base_claims('service_role');
select pg_temp.base_error($$select public.qorpera_folder_coding_checkins_due(null, 0)$$, '22023', 'Folder coding check-ins limit is invalid');
select pg_temp.base_error($$select public.qorpera_folder_coding_checkins_due(null, 501)$$, '22023', 'Folder coding check-ins limit is invalid');
select pg_temp.base_error($$select pg_temp.c3c_step(0)$$, '22023', 'Folder coding check-ins limit is invalid');
select pg_temp.base_error($$select pg_temp.c3c_step(33)$$, '22023', 'Folder coding check-ins limit is invalid');
select pg_temp.base_assert(public.qorpera_folder_coding_checkins_company('93400000-0000-4000-8000-0000000000ee') ->> 'state' = 'not_folder',
	'no folder-v2 company');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($$select public.qorpera_folder_coding_checkins_due()$$, '42501', 'Folder core authority is required');
select pg_temp.base_error($$select public.qorpera_folder_coding_checkins_company('92400000-0000-4000-8000-000000000020')$$, '42501',
	'Folder core authority is required');
select pg_temp.base_claims('service_role');
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_folder_coding_checkins_due(uuid,integer)', 'execute')
			= (v_role = 'service_role') and has_function_privilege(v_role, 'public.qorpera_folder_coding_checkins_company(uuid,integer)',
				'execute') = (v_role = 'service_role')
			and not has_function_privilege(v_role,
				'public.qorpera_folder_coding_checkin_due(public.qorpera_coding_sessions,public.qorpera_runtime_workers)', 'execute'),
			'grants for ' || v_role);
	end loop;
	perform pg_temp.base_assert(pg_get_functiondef(p) like '%20260930107500%', 'the marker in ' || p::text)
	from unnest(array['public.qorpera_folder_parent_continuation(uuid,text)',
		'public.qorpera_folder_coding_checkin_due(public.qorpera_coding_sessions,public.qorpera_runtime_workers)',
		'public.qorpera_folder_coding_checkins_due(uuid,integer)', 'public.qorpera_folder_coding_checkins_company(uuid,integer)',
		'public.qorpera_folder_cancel_agent_worker(jsonb,jsonb)']::regprocedure[]) p;
end $$;

rollback;
