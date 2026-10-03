-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company state files, F2-5b-2 under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)" §5):
-- a worker change holds its todo FOR SHARE and a todo save holds it FOR NO KEY UPDATE, so a dispatch and a todo's done
-- wait for each other and the second reads what the first wrote. A dispatch behind a done meets a closed todo; a done
-- behind a dispatch meets a worker at work; a move of the agent's whole folder behind a dispatch meets the worker too.
-- Without the rank-5 locks both would read the old rows and save, leaving a done todo with a worker at work. 648's committed fixture (Ada, her run f1 and its binding), removed at the end. Waits
-- are detected with pg_blocking_pids, never by wall-clock time.

create function pg_temp.member() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.ada() returns jsonb language sql as $$
	select jsonb_build_object('kind','run','runId','64800000-0000-4000-8000-0000000000f1','jobId','64800000-0000-4000-8000-0000000000f2',
		'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','64800000-0000-4000-8000-0000000000f5')
$$;
create function pg_temp.todo(p_path text, p_status text) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'todo', p_status || ' ' || p_path, jsonb_build_object('kind','todo','id',md5(p_path)::uuid,
		'title','Race todo','status',p_status,'requestedBy',null,'detail',''), pg_temp.version(p_path))
$$;
create function pg_temp.brief(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind','worker-brief','id',p_id,'title','Race worker','species','in-house','access','write','revival','each',
		'dispatchedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'followUps',0,'followedUpAt',null,
		'goal','Race.','doneWhen','Raced.','context',null,'sources','[]'::jsonb,'followUp',null)
		|| public.qorpera_company_state_worker_standing('in-house', 'write', 'each')
$$;
-- A dispatch's units (the todo's folder, then the worker's with its brief), staged now.
create function pg_temp.dispatch(p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','mkdir','path',regexp_replace(p_folder, '/[^/]+$', '')),
		jsonb_build_object('op','new_folder','path',p_folder,
			'contents', jsonb_build_array(jsonb_build_object('path','brief.md','kind','file','file',pg_temp.stage(p_brief::text))),
			'structured', jsonb_build_array(pg_temp.entry(p_folder || '/brief.md', 'worker-brief', p_brief::text, p_brief))))
$$;
-- Run f1's reviewed manage_worker call for these units: its own allow, recorded now (committed).
create function pg_temp.reviewed(p_call text, p_units jsonb) returns uuid language plpgsql as $$
declare v_action uuid;
begin
	v_action := (public.qorpera_record_action_review(current_setting('qorpera_test.binding')::jsonb, jsonb_build_object('callId', p_call,
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Dispatch a worker', 'target', 'race', 'details', '{}'::jsonb), 'decision', 'allow',
		'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'))
		->> 'reviewId')::uuid;
	return (public.qorpera_folder_record_review(current_setting('qorpera_test.binding')::jsonb, jsonb_build_object('actionReviewId', v_action,
		'tool', 'manage_worker', 'argumentSha256', md5(p_call) || md5(p_call), 'units', p_units)) ->> 'reviewId')::uuid;
end $$;
create function pg_temp.sql_dispatch(p_key text, p_folder text, p_brief jsonb, p_units jsonb, p_review uuid) returns text language sql as $$
	select format('select public.qorpera_folder_worker_commit(%L, %L, %L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.ada(), p_key, p_units, jsonb_build_object('action','dispatch','folder',p_folder,'title',p_brief ->> 'title',
			'goal',p_brief ->> 'goal','doneWhen',p_brief ->> 'doneWhen','context',null,'sources','[]'::jsonb,'access','write',
			'revival','each'), p_review)
$$;
create function pg_temp.sql_done(p_key text, p_units jsonb) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.member(), p_key, p_units)
$$;
-- A sent statement's one text row, or its error as 'ERROR <state> <message>'; the connection is drained.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v_text text;
begin
	begin
		select r into v_text from dblink_get_result(p_conn) as t(r text);
	exception when others then v_text := 'ERROR ' || sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_text;
end $$;

-- The company's login pays for unattended work (as 818's fixture sets it), so a dispatch finds its payer.
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;

-- Three open todos of Ada's, committed.
select pg_temp.expect(pg_temp.commit(pg_temp.member(), 'f2b-race-todos', jsonb_build_array(
	pg_temp.todo('agents/ada/todos/race-one.md', 'open'), pg_temp.todo('agents/ada/todos/race-two.md', 'open'),
	pg_temp.todo('agents/ada/todos/race-three.md', 'open'))), 3, 'saved') \g /dev/null

-- Each race's staged files, its done and its recorded review, committed before the block that drives the fences: a
-- row this session wrote and has not committed would make the other sessions wait on it while it waits on them.
select set_config('qorpera_test.b1', pg_temp.brief('84100000-0000-4000-8000-000000000101')::text, false) \g /dev/null
select set_config('qorpera_test.u1', pg_temp.dispatch('agents/ada/todos/race-one/worker', current_setting('qorpera_test.b1')::jsonb)::text,
	false) \g /dev/null
select set_config('qorpera_test.r1', pg_temp.reviewed('f2b-race-call-1', current_setting('qorpera_test.u1')::jsonb)::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.u1')::jsonb) \g /dev/null
select set_config('qorpera_test.d1', jsonb_build_array(pg_temp.todo('agents/ada/todos/race-one.md', 'done'))::text, false) \g /dev/null
-- Each committer holds the files it commits (Ada's run its brief, the member its done), as its own upload would leave
-- them (C1D §3), before its commit runs on another session.
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.member(), current_setting('qorpera_test.d1')::jsonb) \g /dev/null
select set_config('qorpera_test.b2', pg_temp.brief('84100000-0000-4000-8000-000000000102')::text, false) \g /dev/null
select set_config('qorpera_test.u2', pg_temp.dispatch('agents/ada/todos/race-two/worker', current_setting('qorpera_test.b2')::jsonb)::text,
	false) \g /dev/null
select set_config('qorpera_test.r2', pg_temp.reviewed('f2b-race-call-2', current_setting('qorpera_test.u2')::jsonb)::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.u2')::jsonb) \g /dev/null
select set_config('qorpera_test.d2', jsonb_build_array(pg_temp.todo('agents/ada/todos/race-two.md', 'done'))::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.member(), current_setting('qorpera_test.d2')::jsonb) \g /dev/null
select set_config('qorpera_test.b3', pg_temp.brief('84100000-0000-4000-8000-000000000103')::text, false) \g /dev/null
select set_config('qorpera_test.u3', pg_temp.dispatch('agents/ada/todos/race-three/worker', current_setting('qorpera_test.b3')::jsonb)::text,
	false) \g /dev/null
select set_config('qorpera_test.r3', pg_temp.reviewed('f2b-race-call-3', current_setting('qorpera_test.u3')::jsonb)::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.u3')::jsonb) \g /dev/null

-- A. A done holds the todo; a dispatch on it waits at the todo's row, then meets a closed todo -------------------------
do $$
declare
	f text := 'agents/ada/todos/race-one/worker'; b jsonb := current_setting('qorpera_test.b1')::jsonb;
	u jsonb := current_setting('qorpera_test.u1')::jsonb; v_review uuid := current_setting('qorpera_test.r1')::uuid;
	d jsonb := current_setting('qorpera_test.d1')::jsonb; r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_done('f2b-race-done-1', d)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_dispatch('f2b-race-dispatch-1', f, b, u, v_review));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A dispatch must wait for a done of its todo'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runtime_agent_todos'::regclass then
		raise exception 'The dispatch must queue on the todo, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 1 ->> 'outcome' is distinct from 'refused' or r -> 'units' -> 1 -> 'problems' -> 0 ->> 'message' not like 'the todo is closed%' then
		raise exception 'A dispatch behind a done: %', r; end if;
	if exists (select 1 from public.qorpera_runtime_workers where id = '84100000-0000-4000-8000-000000000101') then
		raise exception 'A done todo has a worker'; end if;
end $$;

-- C. A dispatch holds its todo; a member's move of the agent's whole folder waits at the todo, then meets the new worker at
-- work and is refused (it never carries a worker it did not see) --------------------------------------------------------
select set_config('qorpera_test.mv', jsonb_build_array(jsonb_build_object('op','move','from','agents/ada','to','agents/adele',
	'expectedVersion',(select version from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020'
		and key_text = 'agents/ada'),
	'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '64800000-0000-4000-8000-000000000020')))::text,
	false) \g /dev/null
do $$
declare
	f text := 'agents/ada/todos/race-three/worker'; b jsonb := current_setting('qorpera_test.b3')::jsonb;
	u jsonb := current_setting('qorpera_test.u3')::jsonb; v_review uuid := current_setting('qorpera_test.r3')::uuid;
	mv jsonb := current_setting('qorpera_test.mv')::jsonb; r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_dispatch('f2b-race-dispatch-3', f, b, u, v_review)) as t(x text));
	perform pg_temp.expect(r, 2, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_done('f2b-race-move-3', mv));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'An agent''s folder move must wait for a dispatch in it'; end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	-- Refused by the guard (a worker at work), or by the core first (a change under the folder after the move's asOfSeq).
	if not ((r -> 'units' -> 0 ->> 'outcome' = 'refused'
			and coalesce(r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') like 'a worker here is still at work%')
		or (r -> 'units' -> 0 ->> 'outcome' = 'conflict' and r -> 'units' -> 0 ->> 'reason' = 'unseen_change')) then
		raise exception 'A move behind a dispatch: %', r; end if;
	if (select folder_key from public.qorpera_runtime_workers where id = '84100000-0000-4000-8000-000000000103')
			is distinct from 'agents/ada/todos/race-three/worker'
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020'
			and key_text = 'agents/adele') then
		raise exception 'The agent''s folder moved with a worker it did not see'; end if;
end $$;

-- B. A dispatch holds the todo; a done of it waits, then meets the worker at work ----------------------------------------
do $$
declare
	f text := 'agents/ada/todos/race-two/worker'; b jsonb := current_setting('qorpera_test.b2')::jsonb;
	u jsonb := current_setting('qorpera_test.u2')::jsonb; v_review uuid := current_setting('qorpera_test.r2')::uuid;
	d jsonb := current_setting('qorpera_test.d2')::jsonb; r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_dispatch('f2b-race-dispatch-2', f, b, u, v_review)) as t(x text));
	perform pg_temp.expect(r, 2, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_done('f2b-race-done-2', d));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A done must wait for a dispatch on its todo'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runtime_agent_todos'::regclass then
		raise exception 'The done must queue on the todo, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'refused' or r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' not like 'a worker is still at work%' then
		raise exception 'A done behind a dispatch: %', r; end if;
	if (select state from public.qorpera_runtime_agent_todos where id = md5('agents/ada/todos/race-two.md')::uuid) is distinct from 'open'
		or (select state from public.qorpera_runtime_workers where id = '84100000-0000-4000-8000-000000000102') is distinct from 'active' then
		raise exception 'The todo stays open with its worker at work'; end if;
end $$;

-- Remove the fixture: every row of the company, its environment, its runs, jobs, sessions, rooms and login.
select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
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
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
