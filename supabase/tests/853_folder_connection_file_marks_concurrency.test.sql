-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C3, P22a (migration 20260930006000): the vault's due marks and the writers' claims, raced on 648's
-- committed folder-v2 company. R1: a mark that commits after a later one is never lost. R2: two writers never take one
-- connection, and their claims never wait in a cycle. R3: a vault change never waits for a writer.

-- The vault: a broker authority, three company connections, Ada's grant on the first. Then nothing is due.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('85300000-0000-4000-8000-0000000000b0', '64800000-0000-4000-8000-000000000010', 'https://broker.example.test', 'test',
	repeat('a', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values
	('85300000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85300000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'a', 'Mail A', 1, '64800000-0000-4000-8000-000000000001',
		'a@example.test'),
	('85300000-0000-4000-8000-0000000000a2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85300000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'b', 'Mail B', 1, '64800000-0000-4000-8000-000000000001',
		'b@example.test'),
	('85300000-0000-4000-8000-0000000000a3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85300000-0000-4000-8000-0000000000b0', 'company', null, 'google_drive', 'primary', 'Files', 1,
		'64800000-0000-4000-8000-000000000001', 'files@example.test');
insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
	operation_id, operation_version, tool_name, issued_by_user_id)
select '85300000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'85300000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000a1', operation.connector_id, operation.operation_id,
	operation.version, operation.tool_name, '64800000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations as operation where operation.connector_id = 'gmail' and operation.status = 'active'
order by operation.operation_id collate "C" limit 1;
do $$
begin
	if (select count(distinct secret_id) from public.qorpera_folder_connection_file_marks
		where profile_id = '64800000-0000-4000-8000-000000000010') <> 3 then
		raise exception 'The three new connections are due'; end if;
end $$;
delete from public.qorpera_folder_connection_file_marks where profile_id = '64800000-0000-4000-8000-000000000010';

create function pg_temp.sql_claim(p_worker text) returns text language sql as $$
	select format('select public.qorpera_claim_connection_file(%L, 60)', '85300000-0000-4000-8000-0000000000' || p_worker)
$$;
create function pg_temp.claim_on(p_conn text, p_worker text) returns jsonb language sql as $$
	select r from dblink(p_conn, pg_temp.sql_claim(p_worker)) as t(r jsonb)
$$;
create function pg_temp.finish_on(p_conn text, p_worker text, p_claim jsonb) returns boolean language sql as $$
	select (r ->> 'finished')::boolean from dblink(p_conn, format('select public.qorpera_finish_connection_file(%L, %L, %s, null)',
		'85300000-0000-4000-8000-0000000000' || p_worker, p_claim ->> 'secretId', p_claim ->> 'generation')) as t(r jsonb)
$$;
-- The answer of a query sent with dblink_send_query.
create function pg_temp.answer(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- Waits up to ten seconds for a connection's query to end.
create function pg_temp.settles(p_conn text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds';
begin
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
	return true;
end $$;
create function pg_temp.label(p_secret text, p_label text) returns text language sql as $$
	select format('update public.qorpera_cloud_secrets set account_label = %L where id = %L', p_label,
		'85300000-0000-4000-8000-0000000000' || p_secret)
$$;

-- R1. Out-of-order marks: fence_one withdraws Ada's grant on a1 and stays open, so its mark has the lower id but is not
--     committed; a later change of a1 commits. A writer then sees only the committed mark and the vault without the
--     withdrawal; once the withdrawal commits, a1 is due again and the next claim shows it.
select dblink_exec('fence_one', 'begin');
select * from dblink('fence_one', $q$update public.qorpera_cloud_secret_operation_grants set status = 'revoked',
	revoked_at = clock_timestamp(), revoked_by_user_id = '64800000-0000-4000-8000-000000000001'
	where id = '85300000-0000-4000-8000-0000000000c1' returning 1$q$) as t(x integer);
select dblink_exec('fence_two', pg_temp.label('a1', 'a-team@example.test'));
do $$
declare c jsonb := pg_temp.claim_on('fence_three', 'aa');
begin
	if c ->> 'secretId' <> '85300000-0000-4000-8000-0000000000a1' or (c ->> 'marks')::integer <> 1
		or c -> 'settings' ->> 'account' <> 'a-team@example.test' or jsonb_array_length(c -> 'settings' -> 'actions') <> 1 then
		raise exception 'R1: the claim covers the committed mark only: %', c; end if;
	perform dblink_exec('fence_one', 'commit');
	if not pg_temp.finish_on('fence_three', 'aa', c) then raise exception 'R1: the writer finishes'; end if;
	c := pg_temp.claim_on('fence_three', 'aa');
	if c ->> 'secretId' <> '85300000-0000-4000-8000-0000000000a1' or (c ->> 'marks')::integer <> 1
		or c -> 'settings' -> 'actions' <> '[]'::jsonb then
		raise exception 'R1: the late mark keeps a1 due, and the next claim shows the withdrawal: %', c; end if;
	if not pg_temp.finish_on('fence_three', 'aa', c) or pg_temp.claim_on('fence_three', 'aa') is not null then
		raise exception 'R1: then nothing is due'; end if;
end $$;

-- R2. Two writers: a2 and a3 are due and have no work rows yet. Writer A claims in an open transaction, so its new work
--     rows and its lease are not committed; writer B's claim waits only for A's new rows (both create them in secret
--     order, never in a cycle), then takes the other connection. A third claim finds nothing.
select dblink_exec('fence_two', pg_temp.label('a2', 'b-team@example.test'));
select dblink_exec('fence_two', pg_temp.label('a3', 'files-team@example.test'));
select dblink_exec('fence_two', 'begin');
select set_config('qorpera_test.claim_a', pg_temp.claim_on('fence_two', 'aa')::text, false);
select dblink_send_query('fence_three', pg_temp.sql_claim('bb'));
do $$ begin if not pg_temp.waits_for('fence_three', 'fence_two') then raise exception 'R2: B waits for A''s new work rows'; end if; end $$;
select dblink_exec('fence_two', 'commit');
do $$
declare a jsonb := current_setting('qorpera_test.claim_a')::jsonb; b jsonb;
begin
	if not pg_temp.settles('fence_three') then raise exception 'R2: B''s claim ends once A commits'; end if;
	b := pg_temp.answer('fence_three');
	if a ->> 'secretId' is null or b ->> 'secretId' is null or a ->> 'secretId' = b ->> 'secretId'
		or not (array[a ->> 'secretId', b ->> 'secretId'] <@ array['85300000-0000-4000-8000-0000000000a2', '85300000-0000-4000-8000-0000000000a3'])
		or pg_temp.claim_on('fence_four', 'cc') is not null then
		raise exception 'R2: two writers take two connections: % and %', a, b; end if;
	if not pg_temp.finish_on('fence_two', 'aa', a) or not pg_temp.finish_on('fence_three', 'bb', b) then
		raise exception 'R2: each finishes its own'; end if;
	-- A finish of a claim another writer holds is refused.
	if pg_temp.finish_on('fence_three', 'bb', a) then raise exception 'R2: B cannot finish A''s claim'; end if;
end $$;
-- With work rows in place, a claim never waits: writer A holds a2's claim open, and B finds nothing at once.
select dblink_exec('fence_two', pg_temp.label('a2', 'b@example.test'));
select dblink_exec('fence_two', 'begin');
select set_config('qorpera_test.claim_a', pg_temp.claim_on('fence_two', 'aa')::text, false);
select dblink_send_query('fence_three', pg_temp.sql_claim('bb'));
do $$
begin
	if not pg_temp.settles('fence_three') then
		perform dblink_exec('fence_two', 'rollback'); raise exception 'R2: a claim skips a held work row'; end if;
	if pg_temp.answer('fence_three') is not null then raise exception 'R2: nothing else is due'; end if;
end $$;

-- R3. A vault change never waits for a writer: while A's claim of a2 is open (its work row locked, the marks it
--     consumed deleted but not committed), a change of a2 inserts its mark at once; after A's finish a2 is due again.
select dblink_send_query('fence_three', pg_temp.label('a2', 'b-new@example.test'));
do $$
begin
	if not pg_temp.settles('fence_three') then
		perform dblink_exec('fence_two', 'rollback'); raise exception 'R3: the vault change must not wait for the writer'; end if;
	perform pg_temp.outcome('fence_three');
end $$;
do $$
declare a jsonb := current_setting('qorpera_test.claim_a')::jsonb; c jsonb;
begin
	if not pg_temp.finish_on('fence_two', 'aa', a) then raise exception 'R3: A finishes'; end if;
	perform dblink_exec('fence_two', 'commit');
	c := pg_temp.claim_on('fence_three', 'bb');
	if c ->> 'secretId' <> '85300000-0000-4000-8000-0000000000a2' or c -> 'settings' ->> 'account' <> 'b-new@example.test' then
		raise exception 'R3: the change during A''s claim is due: %', c; end if;
	if not pg_temp.finish_on('fence_three', 'bb', c) then raise exception 'R3: B finishes'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does).
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
	delete from public.qorpera_cloud_secret_audit_events where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_operation_grants where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_capture_tickets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_versions where secret_id in
		(select id from public.qorpera_cloud_secrets where profile_id = any (v_profiles));
	delete from public.qorpera_cloud_secrets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_broker_authorities where id = '85300000-0000-4000-8000-0000000000b0';
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
		or exists (select 1 from public.qorpera_cloud_secrets where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_connection_file_marks where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_connection_file_work where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secret_broker_authorities where id = '85300000-0000-4000-8000-0000000000b0') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
