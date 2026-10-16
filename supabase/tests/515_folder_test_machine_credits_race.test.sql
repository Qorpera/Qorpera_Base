-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Credits under concurrency (20260930421000; F3 step 6, slice 6a-2: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md).
-- A credited save holds the job of each credited command's run FOR KEY SHARE from step 2 on, with the starter's, in
-- one id order. So a completion of that run (its job FOR UPDATE) waits for the save and then sees it. A save that comes
-- while a completion holds the job waits for it, and then reads the lease as the completion left it. A run that moved
-- to a job the save does not hold makes the caller retry. On 648's committed fixture: Ada's leased run starts a machine
-- for the member, with its placement and node demand; a second run of Ada's for the member runs a command on it. All
-- rows are committed, so the connections see them, and are removed at the end. Waits are found with pg_blocking_pids,
-- never by wall-clock time.

-- The starter (Ada, for the member) reads the folder's root, as the open needs.
do $$
begin
	if not public.qorpera_folder_reads_root('64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010',
			'64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000002') then
		raise exception 'Ada and the member must read the root'; end if;
end $$;

-- cr/, where the saves make their folders.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'cr-race-setup', '[{"op":"mkdir","path":"cr"}]'), 1, 'saved') \g /dev/null

-- The machine Ada's run f1 started for the member, its placement on node ...410 running its first boot (513's rows).
-- Then run B: Ada's second run for the member, its job ...b2 leased for an hour, and its command on the machine. Foreign
-- keys and triggers are off only while the rows go in.
set session_replication_role = replica;
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state)
values ('51500000-0000-4000-8000-000000000101', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'credits',
	'Runs the tests.', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 2, 4294967296, 21474836480, 'standard', 'task', 'running');
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256,
	running_at, boot_id)
values ('51500000-0000-4000-8000-000000000102', '51500000-0000-4000-8000-000000000101', '64800000-0000-4000-8000-000000000010', 'node-a',
	repeat('8', 64), '{}', encode(extensions.digest('51500000-0000-4000-8000-000000000102', 'sha256'), 'hex'), clock_timestamp(),
	'51500000-0000-4000-8000-000000000103');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256,
	reserved_at)
values ('51500000-0000-4000-8000-000000000102', '64800000-0000-4000-8000-000000000010', '51500000-0000-4000-8000-000000000102', 'lxd',
	encode(extensions.digest('51500000-0000-4000-8000-000000000102', 'sha256'), 'hex'), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes,
	reserved_at)
values ('51500000-0000-4000-8000-000000000102', '51500000-0000-4000-8000-000000000410', 'machine', 'lxd', repeat('4', 64), 2000, 4294967296,
	clock_timestamp());
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
values ('51500000-0000-4000-8000-0000000000b2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64800000-0000-4000-8000-000000000002',
	'leased', '64800000-0000-4000-8000-0000000000f4', extensions.gen_random_uuid(), repeat('a', 64),
	clock_timestamp() + interval '1 hour', '51500000-0000-4000-8000-0000000000b1');
insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
	company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
	payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
	audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids, compute_identity_id)
values ('51500000-0000-4000-8000-0000000000b1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'wake', extensions.gen_random_uuid(), '51500000-0000-4000-8000-0000000000b2', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-0000000000a1', 1, '64800000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
	'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-000000000002', 'openai', 'gpt-test', 'provider_default', 'company',
	extensions.gen_random_uuid(), repeat('b', 64), '{}', '64800000-0000-4000-8000-0000000000d1');
insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
	started_at, sent_at, requested_by_user_id)
values ('51500000-0000-4000-8000-0000000000c1', '51500000-0000-4000-8000-000000000101', '51500000-0000-4000-8000-0000000000b1',
	'64800000-0000-4000-8000-0000000000a1', '51500000-0000-4000-8000-000000000102', 'npm test', false,
	clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '5 minutes', '64800000-0000-4000-8000-000000000002');
set session_replication_role = origin;

-- The platform's open for the machine's boot.
select set_config('qorpera_test.credit_view', public.qorpera_folder_view_open('64800000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'test_machine', '{"companyMachineId":"51500000-0000-4000-8000-000000000101","placementId":"51500000-0000-4000-8000-000000000102",'
		'"bootId":"51500000-0000-4000-8000-000000000103"}')::text, false) \g /dev/null

create function pg_temp.vactor() returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',v ->> 'viewId','pass',v ->> 'pass')
	from (select current_setting('qorpera_test.credit_view')::jsonb v) x
$$;
-- A save through the view: a mkdir that credits command ...c1.
create function pg_temp.units(p_path text) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','mkdir','path',p_path,'credits',jsonb_build_array('51500000-0000-4000-8000-0000000000c1')))
$$;
create function pg_temp.save_sql(p_key text, p_path text) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '64800000-0000-4000-8000-000000000020', pg_temp.vactor(), p_key,
		pg_temp.units(p_path))
$$;
-- 644's: a sent statement's row, which drains the connection.
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
create function pg_temp.commit_row(p_result jsonb) returns public.qorpera_folder_commits language sql as $$
	select * from public.qorpera_folder_commits where id = (p_result ->> 'commitId')::uuid
$$;
-- What a completion does to job ...b2 once it holds it: the job fails and its lease ends.
create function pg_temp.end_job_sql() returns text language sql as $$
	select $q$update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), lease_token_sha256 = null,
		lease_expires_at = null where id = '51500000-0000-4000-8000-0000000000b2'$q$
$$;

-- 648's four connections. Each gives up a lock wait after 90 s, so a wrong wait fails the test instead of hanging it.
select dblink_exec(name, $q$set lock_timeout = '90s'$q$) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- A. Run B completes while a save that credits its command waits at cr/ (the third connection holds cr/'s row). The
-- save holds B's job, so the completion waits for the save to commit; then it sees the save under B's run.
do $$
declare r jsonb; c public.qorpera_folder_commits; v_state text; v_seen integer;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_folder_entries where environment_id = %L and key_text = %L
		for update', '64800000-0000-4000-8000-000000000020', public.qorpera_folder_key('cr'))) as t(x integer);
	perform dblink_exec('fence_one', 'begin');
	perform dblink_send_query('fence_one', pg_temp.save_sql('cr-race-completion', 'cr/a'));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'The credited save did not stop at cr/'; end if;
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_runner_jobs where id = '51500000-0000-4000-8000-0000000000b2'
		for update$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The completion of run B did not wait for the credited save'; end if;
	perform dblink_exec('fence_three', 'rollback');
	r := pg_temp.result('fence_one');
	perform pg_temp.expect(r, 1, 'saved');
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The completion must wait until the save commits'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The completion after the save: %', v_state; end if;
	select n into v_seen from dblink('fence_two', $q$select count(*)::integer from public.qorpera_folder_commits
		where run_id = '51500000-0000-4000-8000-0000000000b1'$q$) as t(n integer);
	if v_seen <> 1 then raise exception 'The completion must see the save under run B, saw % commits', v_seen; end if;
	perform dblink_exec('fence_two', $q$set local session_replication_role = replica$q$);
	perform dblink_exec('fence_two', pg_temp.end_job_sql());
	perform dblink_exec('fence_two', 'commit');
	c := pg_temp.commit_row(r);
	if c.run_id is distinct from '51500000-0000-4000-8000-0000000000b1' or c.credits is distinct from array['51500000-0000-4000-8000-0000000000c1']::uuid[]
		or c.actor_id is distinct from '64800000-0000-4000-8000-0000000000a1' or c.requester_id is distinct from '64800000-0000-4000-8000-000000000002' then
		raise exception 'The save acts as run B, whose job it held: %', to_jsonb(c); end if;
end $$;

-- B's job is leased again.
set session_replication_role = replica;
update public.qorpera_runner_jobs set status = 'leased', finished_at = null, lease_token_sha256 = repeat('a', 64),
	lease_expires_at = clock_timestamp() + interval '1 hour' where id = '51500000-0000-4000-8000-0000000000b2';
set session_replication_role = origin;

-- B. A completion holds B's job and ends its lease; a credited save sent meanwhile waits for it at step 2, then reads
-- the lease as ended. It still saves, as Ada for the member, but under no run.
do $$
declare r jsonb; c public.qorpera_folder_commits;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_runner_jobs where id = '51500000-0000-4000-8000-0000000000b2'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', $q$set local session_replication_role = replica$q$);
	perform dblink_exec('fence_two', pg_temp.end_job_sql());
	perform dblink_send_query('fence_one', pg_temp.save_sql('cr-race-lapsed', 'cr/b'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The credited save did not wait for the completion'; end if;
	perform dblink_exec('fence_two', 'commit');
	r := pg_temp.result('fence_one');
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.commit_row(r);
	if c.run_id is not null or c.credits is distinct from array['51500000-0000-4000-8000-0000000000c1']::uuid[]
		or c.actor_id is distinct from '64800000-0000-4000-8000-0000000000a1' or c.requester_id is distinct from '64800000-0000-4000-8000-000000000002' then
		raise exception 'The save after the completion acts under no run: %', to_jsonb(c); end if;
end $$;

-- C. Run B moves to a new job ...b3 while a credited save waits at its old job. The save does not hold the new job, so
-- the caller retries (409); the retry takes the new job and saves under run B. No code moves a run's job today
-- (qorpera_execution_runs.job_id never changes), so the rows are forged here to reach the retry guard: the old job
-- gives up run B first, since a job's run_id is unique.
do $$
declare r jsonb; c public.qorpera_folder_commits; v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_runner_jobs where id = '51500000-0000-4000-8000-0000000000b2'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', $q$set local session_replication_role = replica$q$);
	perform dblink_exec('fence_two', $q$update public.qorpera_runner_jobs set run_id = null
		where id = '51500000-0000-4000-8000-0000000000b2'$q$);
	perform dblink_exec('fence_two', $q$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id,
		client_job_id, required_capability, job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256,
		lease_expires_at, run_id)
	values ('51500000-0000-4000-8000-0000000000b3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64800000-0000-4000-8000-000000000002',
		'leased', '64800000-0000-4000-8000-0000000000f4', extensions.gen_random_uuid(), repeat('a', 64),
		clock_timestamp() + interval '1 hour', '51500000-0000-4000-8000-0000000000b1')$q$);
	perform dblink_exec('fence_two', $q$update public.qorpera_execution_runs set job_id = '51500000-0000-4000-8000-0000000000b3'
		where id = '51500000-0000-4000-8000-0000000000b1'$q$);
	perform dblink_send_query('fence_one', pg_temp.save_sql('cr-race-moved', 'cr/c'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The credited save did not wait at the old job'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state not like 'PGRST %folder_view_changed%' then
		raise exception 'A save whose credited run moved to a job it does not hold must retry, got %', v_state; end if;
	r := public.qorpera_folder_commit('64800000-0000-4000-8000-000000000020', pg_temp.vactor(), 'cr-race-moved', pg_temp.units('cr/c'));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.commit_row(r);
	if c.run_id is distinct from '51500000-0000-4000-8000-0000000000b1' or c.credits is distinct from array['51500000-0000-4000-8000-0000000000c1']::uuid[] then
		raise exception 'The retry acts as run B on its new job: %', to_jsonb(c); end if;
end $$;
select public.qorpera_folder_view_close((v ->> 'viewId')::uuid, v ->> 'pass')
from (select current_setting('qorpera_test.credit_view')::jsonb v) x \g /dev/null

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the machine's views (their read sets, read records and releases first), its command, node
-- demand, allocation, placement and the machine; then 648's company rows as 648 removes them (run B and its jobs too).
set session_replication_role = replica;
do $$
declare v_views uuid[] := array(select id from public.qorpera_folder_views where company_machine_id = '51500000-0000-4000-8000-000000000101');
begin
	delete from public.qorpera_folder_view_reads where view_id = any (v_views);
	delete from public.qorpera_folder_view_read_records where view_id = any (v_views);
	delete from public.qorpera_folder_view_releases where view_id = any (v_views);
	delete from public.qorpera_folder_views where id = any (v_views);
	delete from public.qorpera_company_machine_commands where machine_id = '51500000-0000-4000-8000-000000000101';
	delete from public.qorpera_runtime_node_demands where node_id = '51500000-0000-4000-8000-000000000410';
	delete from public.qorpera_runtime_machine_allocations where id = '51500000-0000-4000-8000-000000000102';
	delete from public.qorpera_company_machine_placements where machine_id = '51500000-0000-4000-8000-000000000101';
	delete from public.qorpera_company_machines where id = '51500000-0000-4000-8000-000000000101';
end $$;
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
		or exists (select 1 from public.qorpera_folder_views where company_machine_id = '51500000-0000-4000-8000-000000000101'
			or environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_view_read_records where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_commits where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_company_machine_commands where machine_id = '51500000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_machine_placements where machine_id = '51500000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_runtime_machine_allocations where id = '51500000-0000-4000-8000-000000000102')
		or exists (select 1 from public.qorpera_runtime_node_demands where node_id = '51500000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runner_jobs where id in ('51500000-0000-4000-8000-0000000000b2',
			'51500000-0000-4000-8000-0000000000b3'))
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%') then
		raise exception 'The credits race fixture must be removed'; end if;
end $$;
