-- @fixture 513_folder_test_machine_open_race.test.sql until "-- A. The disk's first two opens overlap"
-- A home window's open under concurrency (20260930754000; the agent's home slice 3). A window's open takes the SAME
-- turn as the company-wide view's open for that machine (one advisory lock per machine) and holds the machine and its
-- placement FOR SHARE, so neither kind can land between the other's checks and its insert: a company-wide open that
-- commits first makes the disk one no window may open on, and a window that commits first is closed by the
-- company-wide open that follows. On 513's committed fixture (Ada's leased run, its machine, the placement running its
-- first boot, tm/ with two files, five connections). Waits are detected with pg_blocking_pids, never by wall-clock
-- time.

-- Ada's run actor, as 648's fixture leases it, and the window's open and ask on 513's machine.
create function pg_temp.hwr_run() returns jsonb language sql as $$
	select '{"kind":"run","runId":"64800000-0000-4000-8000-0000000000f1","jobId":"64800000-0000-4000-8000-0000000000f2",
		"runnerId":"64800000-0000-4000-8000-0000000000f4","assignmentId":"64800000-0000-4000-8000-0000000000f5"}'::jsonb
$$;
create function pg_temp.hwr_open_sql() returns text language sql as $$
	select format('select public.qorpera_folder_view_open(%L, %L, %L, %L)', '64800000-0000-4000-8000-000000000020',
		pg_temp.hwr_run(), 'home_window',
		'{"companyMachineId":"51300000-0000-4000-8000-000000000101","placementId":"51300000-0000-4000-8000-000000000102",'
			'"bootId":"51300000-0000-4000-8000-000000000103"}')
$$;
create function pg_temp.hwr_ask_sql() returns text language sql as $$
	select format('select public.qorpera_folder_home_window_open(%L, %L, %L)', '64800000-0000-4000-8000-000000000020',
		pg_temp.hwr_run(), '{"machineId":"51300000-0000-4000-8000-000000000101"}')
$$;


-- A. A window's open and the company-wide view's open take one turn: the second waits for the first, whichever starts.
do $$
declare v_window jsonb; v_wide jsonb; v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v_window from dblink('fence_one', pg_temp.hwr_open_sql()) as t(r jsonb);
	-- The row is this connection's until it commits, so its kind is checked below.
	-- The company-wide open of the same machine waits for the window's open, although it is another kind.
	perform dblink_send_query('fence_two', pg_temp.open_sql());
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		raise exception 'The company-wide open did not wait for the window''s open'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_wide := pg_temp.result('fence_two');
	-- It closed the window: the home is a company-wide machine again from this boot on.
	if (pg_temp.view_row(v_window)).kind is distinct from 'home_window'
		or (pg_temp.view_row(v_window)).close_reason is distinct from 'superseded'
		or (pg_temp.view_row(v_wide)).kind is distinct from 'test_machine' then
		raise exception 'The company-wide open did not close the window: %', v_wide; end if;
	-- And no window opens on that disk again: the ask says so instead of raising.
	select r into v_state from dblink('fence_two', pg_temp.hwr_ask_sql()) as t(r jsonb);
	if (v_state::jsonb) ->> 'reason' is distinct from 'MACHINE_HELD_COMPANY_FOLDER' then
		raise exception 'The ask after a company-wide view: %', v_state; end if;
	perform public.qorpera_folder_view_close((v_wide ->> 'viewId')::uuid, v_wide ->> 'pass');
end $$;


-- B. The other way round, on a disk of its own: a window's open waits for a company-wide open in flight, and then
-- refuses the disk that open made company-wide. The machine and the placement it holds FOR SHARE are the same rows a
-- machine command takes FOR UPDATE, so an unchecked command cannot race the disk check either.
-- A second disk for the same machine, as a new boot leaves it: the earlier placement retires. Committed before the
-- connections run, so each of them sees it.
set session_replication_role = replica;
update public.qorpera_company_machine_placements set retired_at = clock_timestamp()
where id = '51300000-0000-4000-8000-000000000102';
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
values ('51300000-0000-4000-8000-000000000112', '51300000-0000-4000-8000-000000000101',
	'64800000-0000-4000-8000-000000000010', 'node-a', repeat('8', 64), '{}',
	encode(extensions.digest('51300000-0000-4000-8000-000000000112', 'sha256'), 'hex'), clock_timestamp(),
	'51300000-0000-4000-8000-000000000113');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
values ('51300000-0000-4000-8000-000000000112', '64800000-0000-4000-8000-000000000010',
	'51300000-0000-4000-8000-000000000112', 'lxd',
	encode(extensions.digest('51300000-0000-4000-8000-000000000112', 'sha256'), 'hex'), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256,
	cpu_millis, memory_bytes, reserved_at)
select '51300000-0000-4000-8000-000000000112', node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, clock_timestamp()
from public.qorpera_runtime_node_demands where allocation_id = '51300000-0000-4000-8000-000000000102';
set session_replication_role = origin;

do $$
declare v_wide jsonb; v_state text; v_blocked boolean;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v_wide from dblink('fence_one', format('select public.qorpera_folder_view_open(%L, %L, %L, %L)',
		'64800000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'test_machine',
		'{"companyMachineId":"51300000-0000-4000-8000-000000000101","placementId":"51300000-0000-4000-8000-000000000112",'
			'"bootId":"51300000-0000-4000-8000-000000000113"}')) as t(r jsonb);
	perform dblink_send_query('fence_two', format('select public.qorpera_folder_view_open(%L, %L, %L, %L)',
		'64800000-0000-4000-8000-000000000020', pg_temp.hwr_run(), 'home_window',
		'{"companyMachineId":"51300000-0000-4000-8000-000000000101","placementId":"51300000-0000-4000-8000-000000000112",'
			'"bootId":"51300000-0000-4000-8000-000000000113"}'));
	v_blocked := pg_temp.waits_for('fence_two', 'fence_one');
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if not v_blocked then raise exception 'The window''s open did not wait for the company-wide open'; end if;
	if v_state not like '%held the company-wide folder%' then
		raise exception 'The window''s open after a company-wide open: %', v_state; end if;
	perform public.qorpera_folder_view_close((v_wide ->> 'viewId')::uuid, v_wide ->> 'pass');
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four','fence_five']) name;

-- Remove the fixture, exactly as 513 removes it: this test runs 513's fixture part, whose node demand would
-- otherwise hold the node's room for every machine test after it in this database.
-- The machine's views (their read sets, read records and releases first), its node demand,
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
