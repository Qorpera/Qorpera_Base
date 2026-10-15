-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Test machine views under concurrency (20260930420000; F3 step 6, slice 6a: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md).
-- A machine's opens take turns (an advisory lock per machine, right after the anchor check), so each picks the view it
-- carries from after the earlier one commits, and holds it through the copy: two overlapping first opens keep one open
-- view per machine, and a release in flight through the older view is carried. On 648's committed fixture: Ada's leased
-- run starts a machine for the member, with its placement, node demand and two files, all committed so the connections
-- can see them, and removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

-- The starter (Ada, for the member) reads the folder's root, as the open needs.
do $$
begin
	if not public.qorpera_folder_reads_root('64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010',
			'64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000002') then
		raise exception 'Ada and the member must read the root'; end if;
end $$;

-- tm/ with two files, which the machine reads.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tm-race-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','tm'),
	jsonb_build_object('op','write','path','tm/k.txt','file',s.a), jsonb_build_object('op','write','path','tm/r.txt','file',s.a))), 3, 'saved')
from (select pg_temp.stage('test machine race') a) s \g /dev/null

-- The machine Ada's run started for the member, meant to run; its current placement, reserved on node ...410 and
-- running its first boot, as the executor's custody leaves them (510's builders). Foreign keys and triggers are off
-- only while the rows go in.
set session_replication_role = replica;
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state)
values ('51300000-0000-4000-8000-000000000101', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'race',
	'Runs the tests.', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 2, 4294967296, 21474836480, 'standard', 'task', 'running');
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256,
	running_at, boot_id)
values ('51300000-0000-4000-8000-000000000102', '51300000-0000-4000-8000-000000000101', '64800000-0000-4000-8000-000000000010', 'node-a',
	repeat('8', 64), '{}', encode(extensions.digest('51300000-0000-4000-8000-000000000102', 'sha256'), 'hex'), clock_timestamp(),
	'51300000-0000-4000-8000-000000000103');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256,
	reserved_at)
values ('51300000-0000-4000-8000-000000000102', '64800000-0000-4000-8000-000000000010', '51300000-0000-4000-8000-000000000102', 'lxd',
	encode(extensions.digest('51300000-0000-4000-8000-000000000102', 'sha256'), 'hex'), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes,
	reserved_at)
values ('51300000-0000-4000-8000-000000000102', '51300000-0000-4000-8000-000000000410', 'machine', 'lxd', repeat('4', 64), 2000, 4294967296,
	clock_timestamp());
set session_replication_role = origin;

create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
create function pg_temp.view_row(p_view jsonb) returns public.qorpera_folder_views language sql as $$
	select * from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;
-- 644's: a sent statement's row, which drains the connection.
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- The platform's open for the machine's boot.
create function pg_temp.open_sql() returns text language sql as $$
	select format('select public.qorpera_folder_view_open(%L, %L, %L, %L)', '64800000-0000-4000-8000-000000000020', '{"kind":"platform"}',
		'test_machine', '{"companyMachineId":"51300000-0000-4000-8000-000000000101","placementId":"51300000-0000-4000-8000-000000000102",'
			'"bootId":"51300000-0000-4000-8000-000000000103"}')
$$;
create function pg_temp.read_sql(p_view jsonb, p_path text) returns text language sql as $$
	select format('select public.qorpera_folder_read(%L, %L, %L)', '64800000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path)
$$;
-- A release through the view of what it read (the read's entry).
create function pg_temp.release_sql(p_view jsonb, p_entry jsonb, p_output text) returns text language sql as $$
	select format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)', '64800000-0000-4000-8000-000000000020',
		pg_temp.vactor(p_view), extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', p_entry ->> 'path',
			'version', p_entry ->> 'version', 'authority', p_entry -> 'authority')), p_output)
$$;
-- Whether the view's read records hold the path.
create function pg_temp.carries(p_view jsonb, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.view_id = (p_view ->> 'viewId')::uuid and x ->> 'path' = p_path)
$$;

-- 648's four connections, and a fifth. Each gives up a lock wait after 90 s, so a wrong wait fails the test instead of
-- hanging it.
select dblink_connect('fence_five', 'dbname=' || current_database());
select dblink_exec('fence_five', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
select set_config('qorpera_test.pid_fence_five', pid::text, false) from dblink('fence_five', 'select pg_backend_pid()') as t(pid integer);
select dblink_exec(name, $q$set lock_timeout = '90s'$q$) from unnest(array['fence_one','fence_two','fence_three','fence_four','fence_five']) name;

-- A. The disk's first two opens overlap: the second waits for the first, then supersedes the view it made.
do $$
declare v1 jsonb; v2 jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v1 from dblink('fence_one', pg_temp.open_sql()) as t(r jsonb);
	perform dblink_send_query('fence_two', pg_temp.open_sql());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The second open did not wait for the first'; end if;
	perform dblink_exec('fence_one', 'commit');
	v2 := pg_temp.result('fence_two');
	if (pg_temp.view_row(v1)).close_reason is distinct from 'superseded' or (pg_temp.view_row(v2)).state is distinct from 'open' then
		raise exception 'The second open supersedes the first one''s view: %', v2; end if;
	perform set_config('qorpera_test.race_view', v2::text, false);
end $$;
-- The view reads tm/k.txt and releases it.
select public.qorpera_folder_record_release('64800000-0000-4000-8000-000000000020', pg_temp.vactor(current_setting('qorpera_test.race_view')::jsonb),
	extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')),
	repeat('7', 64))
from (select public.qorpera_folder_read('64800000-0000-4000-8000-000000000020', pg_temp.vactor(current_setting('qorpera_test.race_view')::jsonb),
	'tm/k.txt') -> 'entry' as e) x \g /dev/null

-- B. Two opens overlap again, and a release through the first one's new view is in flight when the second may go on
-- (the third connection holds the machine's turn in between; the fourth holds the release at the view's read set).
-- The second waits out that release and carries what it read.
do $$
declare v3 jsonb; v4 jsonb; e jsonb; v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v3 from dblink('fence_one', pg_temp.open_sql()) as t(r jsonb);
	perform dblink_exec('fence_three', 'begin');
	perform dblink_send_query('fence_three', format('select pg_advisory_xact_lock(hashtextextended(%L, 0))',
		'qorpera.test-machine-view:51300000-0000-4000-8000-000000000101'));
	if not pg_temp.waits_for('fence_three', 'fence_one') then raise exception 'The machine''s turn did not wait for the open'; end if;
	perform dblink_send_query('fence_two', pg_temp.open_sql());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The second open did not wait for the first'; end if;
	perform dblink_exec('fence_one', 'commit');
	perform * from dblink_get_result('fence_three') as t(r text);
	perform * from dblink_get_result('fence_three') as t(r text);
	if not pg_temp.carries(v3, 'tm/k.txt') then raise exception 'The first open carries the disk''s read set'; end if;
	-- Read on another connection, so this transaction holds nothing the opens wait for.
	select r -> 'entry' into e from dblink('fence_four', pg_temp.read_sql(v3, 'tm/r.txt')) as t(r jsonb);
	perform dblink_exec('fence_four', 'begin');
	perform * from dblink('fence_four', format('select 1 from public.qorpera_folder_view_reads where view_id = %L for update',
		v3 ->> 'viewId')) as t(x integer);
	perform dblink_send_query('fence_five', pg_temp.release_sql(v3, e, repeat('8', 64)));
	if not pg_temp.waits_for('fence_five', 'fence_four') then raise exception 'The release did not stop at the view''s read set'; end if;
	perform dblink_exec('fence_three', 'commit');
	if not pg_temp.waits_for('fence_two', 'fence_five') then raise exception 'The second open did not wait for the release in flight'; end if;
	perform dblink_exec('fence_four', 'rollback');
	v_state := pg_temp.outcome('fence_five');
	if v_state <> 'ok' then raise exception 'The release in flight: %', v_state; end if;
	v4 := pg_temp.result('fence_two');
	if (pg_temp.view_row(v3)).close_reason is distinct from 'superseded' or (pg_temp.view_row(v4)).state is distinct from 'open'
		or not pg_temp.carries(v4, 'tm/k.txt') or not pg_temp.carries(v4, 'tm/r.txt') then
		raise exception 'The second open carries the release that was in flight: %', v4; end if;
	perform set_config('qorpera_test.race_view', v4::text, false);
end $$;
select public.qorpera_folder_view_close((v ->> 'viewId')::uuid, v ->> 'pass')
from (select current_setting('qorpera_test.race_view')::jsonb v) x \g /dev/null

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four','fence_five']) name;

-- Remove the fixture: the machine's views (their read sets, read records and releases first), its node demand,
-- allocation, placement and the machine; then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_views uuid[] := array(select id from public.qorpera_folder_views where company_machine_id = '51300000-0000-4000-8000-000000000101');
begin
	delete from public.qorpera_folder_view_reads where view_id = any (v_views);
	delete from public.qorpera_folder_view_read_records where view_id = any (v_views);
	delete from public.qorpera_folder_view_releases where view_id = any (v_views);
	delete from public.qorpera_folder_views where id = any (v_views);
	delete from public.qorpera_runtime_node_demands where node_id = '51300000-0000-4000-8000-000000000410';
	delete from public.qorpera_runtime_machine_allocations where id = '51300000-0000-4000-8000-000000000102';
	delete from public.qorpera_company_machine_placements where machine_id = '51300000-0000-4000-8000-000000000101';
	delete from public.qorpera_company_machines where id = '51300000-0000-4000-8000-000000000101';
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
		or exists (select 1 from public.qorpera_folder_views where company_machine_id = '51300000-0000-4000-8000-000000000101'
			or environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_view_read_records where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_machine_placements where machine_id = '51300000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_runtime_machine_allocations where id = '51300000-0000-4000-8000-000000000102')
		or exists (select 1 from public.qorpera_runtime_node_demands where node_id = '51300000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
