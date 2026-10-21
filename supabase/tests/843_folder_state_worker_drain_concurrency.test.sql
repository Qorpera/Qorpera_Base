-- @fixture 841_folder_state_worker_files_concurrency.test.sql until "-- A. A done holds the todo"
-- Company state files, F2-5b-3 under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)" §6):
-- the worker drain holds its workers FOR UPDATE at rank 5, so two drains of one company start a worker once, and a
-- cancel and a drain meet at the worker's row (the second reads what the first wrote); a queued wake the materializer
-- holds is never waited on (the drain passes over that worker and comes back). 841's committed fixture (648's company,
-- Ada and her run f1), removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

select set_config('qorpera_test.drain', format('select public.qorpera_folder_workers_company(%L, 32)::text',
	'64800000-0000-4000-8000-000000000020'), false) \g /dev/null
create function pg_temp.w(p_id uuid) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = p_id
$$;
create function pg_temp.dispatch_wakes(p_id uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where source_kind = 'worker-dispatch' and source_id = p_id
$$;

-- The three dispatches, committed (each worker active with no wake).
select public.qorpera_folder_worker_commit('64800000-0000-4000-8000-000000000020', pg_temp.ada(), k.key, k.units::jsonb,
	jsonb_build_object('action','dispatch','folder',k.folder,'title','Race worker','goal','Race.','doneWhen','Raced.','context',null,
		'sources','[]'::jsonb,'access','write','revival','each'), k.review::uuid) ->> 'seq'
from (values ('f2b3-race-1', current_setting('qorpera_test.u1'), 'QorperaOS/agents/ada/todos/race-one/worker', current_setting('qorpera_test.r1')),
	('f2b3-race-2', current_setting('qorpera_test.u2'), 'QorperaOS/agents/ada/todos/race-two/worker', current_setting('qorpera_test.r2')),
	('f2b3-race-3', current_setting('qorpera_test.u3'), 'QorperaOS/agents/ada/todos/race-three/worker', current_setting('qorpera_test.r3')))
	as k(key, units, folder, review) \g /dev/null
do $$
begin
	if (select count(*) from public.qorpera_runtime_workers where profile_id = '64800000-0000-4000-8000-000000000010'
			and state = 'active' and occurrence_id is null) <> 3 then
		raise exception 'Fixture: three dispatched workers with no wake'; end if;
end $$;

-- A. A cancel holds a worker; the drain waits at its row, then reads it cancelled and starts only the others; a second
-- drain beside the first waits at the workers too, then finds nothing left to start: every worker starts once.
do $$
declare one constant uuid := '84100000-0000-4000-8000-000000000101'; v_first text; v_second text;
begin
	perform dblink_exec('fence_one', 'begin');
	-- The cancel's write on the worker row, as manage_worker's cancel makes it (qorpera_cancel_worker), held open.
	perform * from dblink('fence_one', format($q$select public.qorpera_cancel_worker(w, null, 'parent_cancelled')::text
		from public.qorpera_runtime_workers w where w.id = %L$q$, one)) as t(r text);
	perform dblink_send_query('fence_two', current_setting('qorpera_test.drain'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The drain must wait for the cancel at the worker'; end if;
	perform dblink_send_query('fence_three', current_setting('qorpera_test.drain'));
	perform dblink_exec('fence_one', 'commit');
	v_first := pg_temp.result('fence_two');
	v_second := pg_temp.result('fence_three');
	if v_first like 'ERROR%' or v_second like 'ERROR%'
		or coalesce((v_first::jsonb ->> 'started')::integer, 0) + coalesce((v_second::jsonb ->> 'started')::integer, 0) <> 2
		or (pg_temp.w(one)).state is distinct from 'cancelled' or pg_temp.dispatch_wakes(one) <> 0
		or pg_temp.dispatch_wakes('84100000-0000-4000-8000-000000000102') <> 1
		or pg_temp.dispatch_wakes('84100000-0000-4000-8000-000000000103') <> 1 then
		raise exception 'Every worker starts once, a cancelled one never: % / %', v_first, v_second; end if;
end $$;

-- B. The materializer holds a worker's queued wake while its todo is cancelled: the drain never waits on that row (NOWAIT),
-- passes over the worker, and cancels it on its next pass.
select pg_temp.expect(pg_temp.commit(pg_temp.member(), 'f2b3-cancel-two', jsonb_build_array(
	pg_temp.todo('QorperaOS/agents/ada/todos/race-two.md', 'cancelled'))), 1, 'saved') \g /dev/null
do $$
declare two constant uuid := '84100000-0000-4000-8000-000000000102'; v_text text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format($q$select id::text from public.qorpera_wake_occurrences where id = %L for update$q$,
		(pg_temp.w(two)).occurrence_id)) as t(r text);
	select r into v_text from dblink('fence_two', current_setting('qorpera_test.drain')) as t(r text);
	if (v_text::jsonb ->> 'skipped')::integer <> 1 or (pg_temp.w(two)).state is distinct from 'active' then
		raise exception 'The drain passes over a held wake: %', v_text; end if;
	perform dblink_exec('fence_one', 'rollback');
	select r into v_text from dblink('fence_two', current_setting('qorpera_test.drain')) as t(r text);
	if (v_text::jsonb ->> 'cancelled')::integer <> 1 or (pg_temp.w(two)).state is distinct from 'cancelled'
		or (pg_temp.w(two)).result ->> 'reason' is distinct from 'todo_cancelled'
		or (select status from public.qorpera_wake_occurrences where id = (pg_temp.w(two)).occurrence_id) is distinct from 'cancelled' then
		raise exception 'The next pass cancels it: %', v_text; end if;
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
	-- The drain's own worker events carry no run.
	delete from public.qorpera_runtime_worker_events where worker_id in (select id from public.qorpera_runtime_workers
		where profile_id = any (v_profiles));
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
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
