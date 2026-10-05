-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- C3c (migration 20260930099000, RUNTIME-COMPANY-FOLDER-C1C.md §6.20 "No cycle, for the check-ins"): the quiet coding
-- check-ins step against other connections. Beside a folder effect it never waits; behind a stop's second phase it waits
-- at the fence holding no session, worker or member row; a lock timeout answers busy and marks nothing. One continuation
-- of a parent at a time across transactions: a check-in step and F2's worker drain, or two check-in steps holding
-- different sessions of one parent, meet at admission, and the second reads the parent again under it and leaves its work
-- waiting. 648's committed fixture (Ada's run f1, its job f2 and conversation f7) with two quiet coding sessions of that
-- run and one in-house report waiting for it, removed at the end.

-- This connection calls the steps as the service role; 648 set the other connections' role.
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null

-- Committed rows: the company's login allowed to pay for autonomous work (a continuation is paid as the work that started
-- it: here the company account), a coding executor, and three workers Ada's run started: coding sessions b1 and b2
-- (cancelled, quiet for 27 and 26 hours: b1 is the longest quiet) and an in-house worker b3 whose report waits for the run.
set session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connection_versions set allow_autonomous = true, authorization_state = 'active'
where connection_id = '64800000-0000-4000-8000-0000000000b3';
insert into public.qorpera_coding_executors(environment_id, owner, enabled)
values ('64800000-0000-4000-8000-000000000020', 'exec-936', true);
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, requested_by_user_id,
	created_by_run_id, updated_by_run_id)
select ('93600000-0000-4000-8000-0000000000c' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', 'race-' || n, 'Race ' || n, '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f1'
from generate_series(1, 3) n;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, state, sequence, requested_by_user_id, steering_run_id, result, reported_at, completion_state, owner_user_id,
	owner_sponsor_binding_id, owner_sponsor_version)
select ('93600000-0000-4000-8000-0000000000b' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', ('93600000-0000-4000-8000-0000000000c' || n)::uuid, 'session-' || n, 'coding',
	'Fix the login page', 'write', 'each', '{}', 'cancelled', 1, '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000f1', '{"outcome":"cancelled","summary":"Cancelled.","outputs":[]}', clock_timestamp(), 'none',
	'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000b1', 1
from generate_series(1, 2) n;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access, revival,
	dispatch, state, requested_by_user_id, steering_run_id, result, reported_at, completion_state)
values ('93600000-0000-4000-8000-0000000000b3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', '93600000-0000-4000-8000-0000000000c3', 'report-3', 'Read the logs', 'read', 'each', '{}',
	'succeeded', '64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000f1',
	'{"outcome":"succeeded","summary":"Done.","outputs":[]}', clock_timestamp(), 'waiting');
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, repository, branch, phase, updated_at)
select ('93600000-0000-4000-8000-0000000000b' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000f7', 'codex',
	'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"main"}', 'qorpera/race-936-' || n, 'cancelled',
	clock_timestamp() - make_interval(hours => 28 - n)
from generate_series(1, 2) n;
set session_replication_role = origin;

-- Ada's job ends (completed), with the columns that state requires (848's): the run is ready for a continuation.
create function pg_temp.job(p_status text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = p_status, lease_token_sha256 = null, lease_expires_at = null,
		result = case when p_status = 'completed' then '{}'::jsonb end,
		finished_at = case when p_status = 'completed' then clock_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then clock_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '64800000-0000-4000-8000-000000000001'::uuid end
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
end $$;
select pg_temp.job('completed') \g /dev/null

create function pg_temp.step(p_limit integer default 8) returns jsonb language sql as $$
	select public.qorpera_folder_coding_checkins_company('64800000-0000-4000-8000-000000000020', p_limit)
$$;
-- The check-in step and F2's worker drain, as SQL for another connection.
create function pg_temp.sql_step(p_limit integer default 8) returns text language sql as $$
	select format('select public.qorpera_folder_coding_checkins_company(%L, %s)::text', '64800000-0000-4000-8000-000000000020', p_limit)
$$;
create function pg_temp.sql_workers() returns text language sql as $$
	select $q$select public.qorpera_folder_workers_company('64800000-0000-4000-8000-000000000020', 32)::text$q$
$$;
-- The run's worker-completion wakes (questions and revivals), newest first; forget() removes them, as if each had run and
-- ended, and puts every worker back as the fixture left it: b3's report waiting, no mark asked.
create function pg_temp.wakes() returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'worker-completion' order by created_at desc, id desc
$$;
create function pg_temp.forget() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set completion_state = 'waiting', completion_occurrence_id = null
	where id = '93600000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'worker-completion';
	update public.qorpera_coding_sessions set quiet_asked_days = null, quiet_asked_for = null
	where worker_id in ('93600000-0000-4000-8000-0000000000b1', '93600000-0000-4000-8000-0000000000b2');
	set local session_replication_role = origin;
end $$;
-- Whether a session's mark was asked (or counted as asked).
create function pg_temp.marked(p_worker uuid) returns boolean language sql as $$
	select quiet_asked_days is not null from public.qorpera_coding_sessions where worker_id = p_worker
$$;
create function pg_temp.completion(p_worker uuid) returns text language sql as $$
	select completion_state from public.qorpera_runtime_workers where id = p_worker
$$;
-- fence_one holds what a folder effect holds (the fence and the company row KEY SHARE), what a stop's second phase holds
-- (the fence FOR UPDATE), or the company's admission row FOR UPDATE (a wake inserter between its admission and its
-- commit); until pg_temp.release().
create function pg_temp.hold(p_what text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what = 'admission' then
		perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_admissions
			where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
		return;
	end if;
	perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s',
		'64800000-0000-4000-8000-000000000010', case p_what when 'effect' then 'key share' else 'update' end)) as t(x integer);
	if p_what = 'effect' then
		perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
			for key share$q$) as t(x integer);
	end if;
end $$;
create function pg_temp.release() returns void language sql as $$ select dblink_exec('fence_one', 'rollback') $$;
-- Whether a connection waits for a row of p_table (it holds or queues for that row's tuple lock).
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for update nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- A call sent on p_conn: its answer once it finished, or its error as {"error": "<state> <message>"}.
create function pg_temp.answer(p_conn text) returns jsonb language plpgsql as $$
declare v_answer jsonb;
begin
	begin
		select r::jsonb into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_answer;
end $$;
-- Two calls of the company meet at admission: fence_one holds its row; p_first is sent on fence_two and must wait there,
-- then p_between runs on fence_four (its own transaction), then p_second is sent on fence_three and must wait there too.
-- Once admission is let go, the two answers in that order.
create function pg_temp.race(p_case text, p_first text, p_second text, p_between text default null) returns jsonb language plpgsql as $$
declare v_two jsonb; v_three jsonb;
begin
	perform pg_temp.hold('admission');
	perform dblink_send_query('fence_two', p_first);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_admissions') then
		perform pg_temp.release(); perform pg_temp.answer('fence_two');
		raise exception '%: the first call must wait at admission', p_case; end if;
	if p_between is not null then perform dblink_exec('fence_four', p_between); end if;
	perform dblink_send_query('fence_three', p_second);
	if not pg_temp.waits_at('fence_three', 'public.qorpera_folder_admissions') then
		perform pg_temp.release(); perform pg_temp.answer('fence_two'); perform pg_temp.answer('fence_three');
		raise exception '%: the second call must wait at admission', p_case; end if;
	perform pg_temp.release();
	v_two := pg_temp.answer('fence_two'); v_three := pg_temp.answer('fence_three');
	return jsonb_build_array(v_two, v_three);
end $$;

-- A. Locks. Beside a folder effect (the fence and the company row KEY SHARE) the step never waits; it asks about b1, the
-- longest quiet, and b2 waits for that question to end (one continuation of a parent at a time).
do $$
declare v_answer jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release(); perform pg_temp.answer('fence_two');
		raise exception 'A: the step waited for a folder effect'; end if;
	v_answer := pg_temp.answer('fence_two');
	perform pg_temp.release();
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_answer ->> 'state' is distinct from 'done' or (v_answer ->> 'asked')::integer <> 1 or (select count(*) from pg_temp.wakes()) <> 1
		or v_wake.status <> 'queued' or v_wake.source_id <> '93600000-0000-4000-8000-0000000000b1'
		or v_wake.occurrence_key not like 'coding-quiet:93600000-0000-4000-8000-0000000000b1:%:1'
		or v_wake.session_id <> '64800000-0000-4000-8000-0000000000f7'
		or not pg_temp.marked('93600000-0000-4000-8000-0000000000b1') or pg_temp.marked('93600000-0000-4000-8000-0000000000b2') then
		raise exception 'A: the step beside an effect asks about b1 alone: % %', v_answer, to_jsonb(v_wake); end if;
	perform pg_temp.forget();
end $$;
-- Behind a stop's second phase (the fence FOR UPDATE) it waits at the fence holding no session, worker, todo or member
-- row; once the stop lets go, it asks.
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		perform pg_temp.release(); perform pg_temp.answer('fence_two');
		raise exception 'A: the step must wait at the fence behind a stop'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where environment_id = '64800000-0000-4000-8000-000000000020'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id in ('93600000-0000-4000-8000-0000000000b1',
			'93600000-0000-4000-8000-0000000000b2')$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_agent_todos where id in ('93600000-0000-4000-8000-0000000000c1',
			'93600000-0000-4000-8000-0000000000c2')$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '64800000-0000-4000-8000-000000000002'$q$) then
		perform pg_temp.release(); perform pg_temp.answer('fence_two');
		raise exception 'A: waiting at the fence, the step holds a session, worker, todo or member row'; end if;
	perform pg_temp.release();
	v_answer := pg_temp.answer('fence_two');
	if (v_answer ->> 'asked')::integer is distinct from 1 or not pg_temp.marked('93600000-0000-4000-8000-0000000000b1') then
		raise exception 'A: the step after the stop let go: %', v_answer; end if;
	perform pg_temp.forget();
end $$;

-- B. One continuation of a parent at a time, across transactions. F2's worker drain reaches admission first with b3's
-- report: it revives the run; the check-in step behind it reads the parent again under admission and asks nothing, its
-- sessions left unasked for the next step.
do $$
declare v_answers jsonb := pg_temp.race('B', pg_temp.sql_workers(), pg_temp.sql_step()); v_wake public.qorpera_wake_occurrences;
begin
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_answers -> 0 ->> 'state' is distinct from 'done' or (v_answers -> 0 ->> 'revivals')::integer <> 1
		or v_answers -> 1 ->> 'state' is distinct from 'done' or (v_answers -> 1 ->> 'asked')::integer <> 0
		or (select count(*) from pg_temp.wakes()) <> 1 or v_wake.status <> 'queued'
		or v_wake.source_id <> '93600000-0000-4000-8000-0000000000b3'
		or v_wake.occurrence_key <> 'worker-completion:93600000-0000-4000-8000-0000000000b3:1'
		or pg_temp.completion('93600000-0000-4000-8000-0000000000b3') <> 'delivered'
		or pg_temp.marked('93600000-0000-4000-8000-0000000000b1') or pg_temp.marked('93600000-0000-4000-8000-0000000000b2') then
		raise exception 'B: F2 first, one continuation: % % wakes, %', v_answers, (select count(*) from pg_temp.wakes()), to_jsonb(v_wake); end if;
	-- Once the revival ran, the question follows. (The step in a statement of its own.)
	perform pg_temp.forget();
	v_answers := pg_temp.step();
	if (v_answers ->> 'asked')::integer is distinct from 1 then raise exception 'B: the question after the revival: %', v_answers; end if;
	perform pg_temp.forget();
end $$;
-- The check-in step first: it asks about b1; F2's drain behind it finds a continuation pending and leaves b3's report
-- waiting.
do $$
declare v_answers jsonb := pg_temp.race('B', pg_temp.sql_step(), pg_temp.sql_workers()); v_wake public.qorpera_wake_occurrences;
begin
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_answers -> 0 ->> 'state' is distinct from 'done' or (v_answers -> 0 ->> 'asked')::integer <> 1
		or v_answers -> 1 ->> 'state' is distinct from 'done' or (v_answers -> 1 ->> 'revivals')::integer <> 0
		or (select count(*) from pg_temp.wakes()) <> 1 or v_wake.status <> 'queued'
		or v_wake.source_id <> '93600000-0000-4000-8000-0000000000b1'
		or v_wake.occurrence_key not like 'coding-quiet:93600000-0000-4000-8000-0000000000b1:%'
		or pg_temp.completion('93600000-0000-4000-8000-0000000000b3') <> 'waiting'
		or not pg_temp.marked('93600000-0000-4000-8000-0000000000b1') or pg_temp.marked('93600000-0000-4000-8000-0000000000b2') then
		raise exception 'B: the step first, one continuation: % % wakes, %', v_answers, (select count(*) from pg_temp.wakes()), to_jsonb(v_wake); end if;
	perform pg_temp.forget();
end $$;
-- Two steps of the company holding different sessions of the parent: the first (limit 1) takes b1, the longest quiet;
-- then b2 is made the longest quiet, and the second (limit 1) takes it. Both pass their checks before admission; the
-- second reads the parent again under it and asks nothing, b2 left unasked.
do $$
declare v_answers jsonb := pg_temp.race('B', pg_temp.sql_step(1), pg_temp.sql_step(1),
		$q$update public.qorpera_coding_sessions set updated_at = updated_at - interval '2 hours'
		where worker_id = '93600000-0000-4000-8000-0000000000b2'$q$);
begin
	if v_answers -> 0 ->> 'state' is distinct from 'done' or (v_answers -> 0 ->> 'asked')::integer <> 1
		or v_answers -> 1 ->> 'state' is distinct from 'done' or (v_answers -> 1 ->> 'asked')::integer <> 0
		or (select count(*) from pg_temp.wakes()) <> 1
		or (select source_id from pg_temp.wakes() limit 1) <> '93600000-0000-4000-8000-0000000000b1'
		or not pg_temp.marked('93600000-0000-4000-8000-0000000000b1') or pg_temp.marked('93600000-0000-4000-8000-0000000000b2') then
		raise exception 'B: two steps, one continuation: % % wakes', v_answers, (select count(*) from pg_temp.wakes()); end if;
	perform pg_temp.forget();
	update public.qorpera_coding_sessions set updated_at = updated_at + interval '2 hours'
	where worker_id = '93600000-0000-4000-8000-0000000000b2';
end $$;

-- C. A stop that holds the fence past the step's lock timeout (2 s): the step answers busy and marks nothing.
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	perform pg_sleep(2.5);
	v_answer := pg_temp.answer('fence_two');
	perform pg_temp.release();
	if v_answer ->> 'state' is distinct from 'busy' or exists (select 1 from pg_temp.wakes())
		or pg_temp.marked('93600000-0000-4000-8000-0000000000b1') or pg_temp.marked('93600000-0000-4000-8000-0000000000b2') then
		raise exception 'C: a lock timeout answers busy and marks nothing: %', v_answer; end if;
	if (pg_temp.step() ->> 'asked')::integer is distinct from 1 then raise exception 'C: the next step asks'; end if;
	perform pg_temp.forget();
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows as 848 removes them, with the workers' event streams.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	delete from public.qorpera_coding_session_events where worker_id in (select id from public.qorpera_runtime_workers
		where profile_id = any (v_profiles));
	delete from public.qorpera_runtime_worker_events where worker_id in (select id from public.qorpera_runtime_workers
		where profile_id = any (v_profiles));
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_runtime_workers where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_agent_todos where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_coding_sessions where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_coding_session_events where worker_id in ('93600000-0000-4000-8000-0000000000b1',
			'93600000-0000-4000-8000-0000000000b2'))
		or exists (select 1 from public.qorpera_coding_executors where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
