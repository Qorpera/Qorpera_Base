-- @fixture 805_folder_state_human_task_index_concurrency.test.sql until "-- A. The person's done holds the task's row"
-- Company state files, H2c = P31 under concurrency (migration 20260930065000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
-- §8 "Plan (P31)"): the human-task drain takes each task's index row FOR SHARE at rank 5, so a save of the task and the
-- drain meet there and the drain reads what the save wrote (a change the task moved on from is skipped, never woken);
-- two drains of one company meet at admission, and the second finds the mark woken: one wake. 805's committed company
-- (Nora a1, her task for the member, staged change sets), with the owner's login; removed at the end. Waits are detected
-- with pg_blocking_pids, never by wall-clock time.

-- The owner's login, which pays for unattended work (708's shape); committed.
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
values ('91600000-0000-4000-8000-0000000000c1', '80500000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'80500000-0000-4000-8000-000000000001', 'openai', '80500000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
	consent_version, consented_by_user_id, allow_autonomous, created_by_user_id, credential_capsule_id, max_native_concurrency,
	quota_policy)
values ('91600000-0000-4000-8000-0000000000c1', 1, 'native_subscription', 'codex-cli', 'personal-subscription', 'fixture',
	'80500000-0000-4000-8000-000000000001', true, '80500000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 1,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,'
		'"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('91600000-0000-4000-8000-0000000000b1', '80500000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'80500000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	allow_autonomous, created_by_user_id)
values ('91600000-0000-4000-8000-0000000000b1', 1, 'member_connection', '91600000-0000-4000-8000-0000000000c1', 1, true,
	'80500000-0000-4000-8000-000000000001');
set session_replication_role = origin;

select set_config('qorpera_test.drain', format('select public.qorpera_folder_human_tasks_company(%L, 32)::text',
	'80500000-0000-4000-8000-000000000020'), false) \g /dev/null
create function pg_temp.marks() returns text language sql as $$
	select coalesce(string_agg(reason || ':' || state || coalesce(':' || problem, ''), ' ' order by id), '')
	from public.qorpera_folder_human_task_wakes where environment_id = '80500000-0000-4000-8000-000000000020'
$$;
create function pg_temp.wakes() returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where environment_id = '80500000-0000-4000-8000-000000000020'
		and source_kind = 'human-task'
$$;
-- The listener hears every change set so far: the owner's new task for Nora is marked, and nothing is woken yet.
select public.qorpera_folder_listen_company('80500000-0000-4000-8000-000000000020', 256) \g /dev/null
do $$
begin
	if pg_temp.marks() <> 'assigned:pending' or pg_temp.wakes() <> 0 then
		raise exception 'Fixture: one pending mark: %', pg_temp.marks(); end if;
end $$;

-- A. The person's done holds the task's row; the drain waits for it there, then reads the task done: the mark for the new
-- task is skipped, never woken behind the person's back. The listener then marks the done, which the drain wakes.
do $$
declare a jsonb; b text;
begin
	perform dblink_exec('h2race_a', 'begin');
	select r into a from dblink('h2race_a', current_setting('qorpera_test.h2_done')) as t(r jsonb);
	if a -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The done saves: %', a; end if;
	perform dblink_send_query('h2race_b', current_setting('qorpera_test.drain'));
	if not pg_temp.waits_for('h2race_b', 'h2race_a') then raise exception 'The drain waits for the save at the task''s row'; end if;
	perform dblink_exec('h2race_a', 'commit');
	select r into b from dblink_get_result('h2race_b') as t(r text);
	perform * from dblink_get_result('h2race_b') as t(r text);
	if b like 'ERROR%' or b::jsonb - 'schema' is distinct from '{"state":"done","woken":0,"skipped":1,"unpaid":0,"held":0}'
		or pg_temp.marks() <> 'assigned:skipped:changed' or pg_temp.wakes() <> 0 then
		raise exception 'The drain behind the done skips the new task''s mark: %, %', b, pg_temp.marks(); end if;
end $$;
select public.qorpera_folder_listen_company('80500000-0000-4000-8000-000000000020', 256) \g /dev/null

-- B. Two drains of one company: the first holds admission, the second waits there, then finds the mark woken and makes
-- nothing: the done wakes Nora once.
do $$
declare a text; b text;
begin
	if pg_temp.marks() <> 'assigned:skipped:changed done:pending' then raise exception 'The done is marked: %', pg_temp.marks(); end if;
	perform dblink_exec('h2race_a', 'begin');
	select r into a from dblink('h2race_a', current_setting('qorpera_test.drain')) as t(r text);
	if a::jsonb ->> 'woken' is distinct from '1' then raise exception 'The first drain wakes Nora: %', a; end if;
	perform dblink_send_query('h2race_b', current_setting('qorpera_test.drain'));
	if not pg_temp.waits_for('h2race_b', 'h2race_a') then raise exception 'The second drain waits for the first'; end if;
	perform dblink_exec('h2race_a', 'commit');
	select r into b from dblink_get_result('h2race_b') as t(r text);
	perform * from dblink_get_result('h2race_b') as t(r text);
	if b like 'ERROR%' or b::jsonb - 'schema' is distinct from '{"state":"done","woken":0,"skipped":0,"unpaid":0,"held":0}'
		or pg_temp.marks() <> 'assigned:skipped:changed done:woken' or pg_temp.wakes() <> 1 then
		raise exception 'One wake for the done: %, %, %', b, pg_temp.marks(), pg_temp.wakes(); end if;
end $$;

-- C. The task's agent changes after the drain read who to wake: the member archives Nora while the drain waits for the
-- paying owner's row (another step holds it). The drain then holds Nora's rows, not the Co-Founder's, so it wakes nobody
-- and tries again after its wait; then it wakes the Co-Founder.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-accept-0001', jsonb_build_array(pg_temp.save('human-tasks/fit.md',
	pg_temp.task_parse('80500000-0000-4000-8000-0000000000e1', '{"status":"accepted"}')))), 1, 'saved') \g /dev/null
select public.qorpera_folder_listen_company('80500000-0000-4000-8000-000000000020', 256) \g /dev/null
select set_config('qorpera_test.h2_archive', pg_temp.sql_commit('80500000-0000-4000-8000-000000000020', pg_temp.mem()::text,
	'race-archive-0001', jsonb_build_array(pg_temp.write('agents/nora/agent.md', 'agent',
		pg_temp.agent_text('80500000-0000-4000-8000-0000000000a1', 'Nora', 'agent', 'archived'),
		pg_temp.agent_parse('80500000-0000-4000-8000-0000000000a1', 'Nora', 'agent', 'archived'),
		pg_temp.version('agents/nora/agent.md')))::text), false) \g /dev/null
select dblink_connect('h2race_c', 'dbname=' || current_database()) \g /dev/null
select dblink_exec('h2race_c', $q$set request.jwt.claims = '{"role":"service_role"}'$q$) \g /dev/null
select dblink_exec('h2race_c', 'set lock_timeout = ''5s''') \g /dev/null
do $$
declare b text; v_archive jsonb;
begin
	if pg_temp.marks() <> 'assigned:skipped:changed done:woken accepted:pending' then
		raise exception 'The acceptance is marked: %', pg_temp.marks(); end if;
	perform dblink_exec('h2race_a', 'begin');
	perform * from dblink('h2race_a', $q$select user_id::text from public.qorpera_profile_members
		where profile_id = '80500000-0000-4000-8000-000000000010' and user_id = '80500000-0000-4000-8000-000000000001' for update$q$)
		as t(r text);
	perform dblink_send_query('h2race_b', current_setting('qorpera_test.drain'));
	if not pg_temp.waits_for('h2race_b', 'h2race_a') then raise exception 'The drain waits for the owner''s row'; end if;
	-- The member's archive commits in its own connection, without the owner's row (were it to wait, this fails rather than
	-- hangs).
	select x into v_archive from dblink('h2race_c', current_setting('qorpera_test.h2_archive')) as t(x jsonb);
	perform pg_temp.expect(v_archive, 1, 'saved');
	perform dblink_exec('h2race_a', 'rollback');
	select r into b from dblink_get_result('h2race_b') as t(r text);
	perform * from dblink_get_result('h2race_b') as t(r text);
	if b like 'ERROR%' or b::jsonb - 'schema' is distinct from '{"state":"done","woken":0,"skipped":0,"unpaid":0,"held":1}'
		or pg_temp.marks() <> 'assigned:skipped:changed done:woken accepted:pending' or pg_temp.wakes() <> 1
		or (select attempts from public.qorpera_folder_human_task_wakes where environment_id = '80500000-0000-4000-8000-000000000020'
			and reason = 'accepted') is distinct from 1 then
		raise exception 'A drain that read another agent wakes nobody: %, %', b, pg_temp.marks(); end if;
	-- After its wait, the next pass wakes the Co-Founder.
	update public.qorpera_folder_human_task_wakes set last_attempt_at = last_attempt_at - interval '5 seconds'
	where environment_id = '80500000-0000-4000-8000-000000000020' and reason = 'accepted';
end $$;
do $$
declare b text;
begin
	select r into b from dblink('h2race_b', current_setting('qorpera_test.drain')) as t(r text);
	if b::jsonb ->> 'woken' is distinct from '1' or pg_temp.marks() <> 'assigned:skipped:changed done:woken accepted:woken'
		or (select staff_agent_id from public.qorpera_wake_occurrences where id = (select wake_id from public.qorpera_folder_human_task_wakes
			where environment_id = '80500000-0000-4000-8000-000000000020' and reason = 'accepted'))
			is distinct from '80500000-0000-4000-8000-0000000000c0' then
		raise exception 'The Co-Founder is woken in Nora''s place: %, %', b, pg_temp.marks(); end if;
end $$;

select dblink_disconnect(name) from unnest(array['h2race_a','h2race_b','h2race_c']) name;

-- The committed fixture leaves the shared suite database: every row of the company and its environment, its runs, jobs and
-- sessions, its login, its objects and its users.
set session_replication_role = replica;
do $$
declare v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = '80500000-0000-4000-8000-000000000010';
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = '80500000-0000-4000-8000-000000000010';
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = '80500000-0000-4000-8000-000000000010';
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = '80500000-0000-4000-8000-000000000020');
	delete from public.qorpera_company_room_members where room_id in
		(select id from public.qorpera_company_rooms where profile_id = '80500000-0000-4000-8000-000000000010');
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id')
			and c.data_type = 'uuid' and c.table_name not in ('qorpera_profiles', 'qorpera_profile_objects') loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then array['80500000-0000-4000-8000-000000000010']::uuid[]
			when 'environment_id' then array['80500000-0000-4000-8000-000000000020']::uuid[]
			when 'run_id' then v_runs when 'job_id' then v_jobs else v_sessions end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '91600000-0000-4000-8000-0000000000c1';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '91600000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
end $$;
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by hand, with
-- their proofs and chunk rows (805's).
delete from public.qorpera_profile_objects where profile_id = '80500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '80500000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '80500000-0000-4000-8000-000000000010';
delete from auth.users where id in ('80500000-0000-4000-8000-000000000001','80500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '80500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_human_task_wakes where environment_id = '80500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_provider_connections where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '80500000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '80500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
