-- Company folder core, C1c-1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md): every legacy path and old writer
-- refuses a folder-v2 company (0A000) before it locks anything, and a snapshot-v1 company is not affected. Legacy rows a
-- guard looks up (a run's job, proposals, member commands) are made by hand, with foreign keys and triggers off.
begin;

insert into auth.users(id,email) values
	('64600000-0000-4000-8000-000000000001','refusals-owner@example.test'),
	('64600000-0000-4000-8000-000000000002','refusals-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('64600000-0000-4000-8000-000000000010','Folder refusals fixture','64600000-0000-4000-8000-000000000001'),
	('64600000-0000-4000-8000-000000000011','Snapshot fixture','64600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('64600000-0000-4000-8000-000000000010','64600000-0000-4000-8000-000000000001','refusals-owner@example.test','Owner','owner'),
	('64600000-0000-4000-8000-000000000010','64600000-0000-4000-8000-000000000002','refusals-member@example.test','Member','contributor'),
	('64600000-0000-4000-8000-000000000011','64600000-0000-4000-8000-000000000001','refusals-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('64600000-0000-4000-8000-000000000020','64600000-0000-4000-8000-000000000010','Environment',1,'64600000-0000-4000-8000-000000000001'),
	('64600000-0000-4000-8000-000000000021','64600000-0000-4000-8000-000000000011','Environment',1,'64600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('64600000-0000-4000-8000-000000000011','64600000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '64600000-0000-4000-8000-000000000001');

create function pg_temp.as_member(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',p_user,
		'session_id','64600000-0000-4000-8000-0000000000f1','exp',extract(epoch from now() + interval '1 hour')::bigint)::text, true)::text::void
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)::text::void
$$;
create function pg_temp.refuses(p_sql text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected 0A000 from %', p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' then raise; end if;
	if sqlstate <> '0A000' then raise exception 'Expected 0A000 from %, got % %', p_sql, sqlstate, sqlerrm; end if;
end $$;
-- The same call on a snapshot-v1 company must not be refused as folder-v2 (it may fail for its own reasons).
create function pg_temp.not_refused(p_sql text) returns void language plpgsql as $$
begin
	execute p_sql;
exception when others then
	if sqlstate = '0A000' then raise exception 'A snapshot-v1 company was refused as folder-v2 by %', p_sql; end if;
end $$;
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;

select pg_temp.as_service();
select public.qorpera_folder_enable('64600000-0000-4000-8000-000000000020');

-- A leased job on each company, as a runtime binding names it; the object both companies store.
select pg_temp.fx($q$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id,
	required_capability, job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at)
	values ('64600000-0000-4000-8000-0000000000c1', '64600000-0000-4000-8000-000000000010', '64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64600000-0000-4000-8000-000000000001',
		'leased', '64600000-0000-4000-8000-0000000000c9', extensions.gen_random_uuid(), repeat('a', 64), clock_timestamp() + interval '1 hour'),
	('64600000-0000-4000-8000-0000000000c2', '64600000-0000-4000-8000-000000000011', '64600000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64600000-0000-4000-8000-000000000001',
		'leased', '64600000-0000-4000-8000-0000000000c9', extensions.gen_random_uuid(), repeat('a', 64), clock_timestamp() + interval '1 hour')$q$);
select pg_temp.fx($q$insert into storage.objects(bucket_id, name, metadata) values
	('qorpera-profile-objects', '64600000-0000-4000-8000-000000000010/' || repeat('b', 64), '{"size":1}'),
	('qorpera-profile-objects', '64600000-0000-4000-8000-000000000011/' || repeat('b', 64), '{"size":1}')$q$);
select pg_temp.fx($q$insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values
	('64600000-0000-4000-8000-000000000010', repeat('b', 64), 1, 'supabase-storage'),
	('64600000-0000-4000-8000-000000000011', repeat('b', 64), 1, 'supabase-storage') on conflict do nothing$q$);

-- Raw object reads and uploads: a member is refused for folder-v2 (the read lease too); a trusted service is not; a
-- snapshot-v1 company is unchanged.
do $$
begin
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000002');
	perform pg_temp.refuses($q$select public.qorpera_authorize_profile_object_download('64600000-0000-4000-8000-000000000010', repeat('b', 64))$q$);
	perform pg_temp.refuses($q$select public.qorpera_issue_profile_object_read_lease('64600000-0000-4000-8000-000000000010', repeat('b', 64), 30)$q$);
	perform pg_temp.refuses($q$select public.qorpera_authorize_profile_object_upload('64600000-0000-4000-8000-000000000010', repeat('c', 64), 1)$q$);
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.not_refused($q$select public.qorpera_authorize_profile_object_download('64600000-0000-4000-8000-000000000011', repeat('b', 64))$q$);
	perform pg_temp.not_refused($q$select public.qorpera_authorize_profile_object_upload('64600000-0000-4000-8000-000000000011', repeat('c', 64), 1)$q$);
	perform pg_temp.as_service();
	perform pg_temp.not_refused($q$select public.qorpera_authorize_profile_object_download('64600000-0000-4000-8000-000000000010', repeat('b', 64))$q$);
end $$;

-- The Storage read policy: a member never reads a folder-v2 object from Storage directly.
select pg_temp.as_member('64600000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	if exists (select 1 from storage.objects where name = '64600000-0000-4000-8000-000000000010/' || repeat('b', 64)) then
		raise exception 'A member reads a folder-v2 object from Storage'; end if;
	begin
		insert into storage.objects(bucket_id, name, metadata)
		values ('qorpera-profile-objects', '64600000-0000-4000-8000-000000000010/' || repeat('f', 64), '{"size":1}');
		raise exception 'A member writes a folder-v2 object into Storage' using errcode = 'QTF02';
	exception when others then
		if sqlstate = 'QTF02' or sqlstate <> '42501' then raise; end if;
	end;
end $$;
reset role;
-- The snapshot-v1 company's member reads its object and may write one, as before.
select pg_temp.as_member('64600000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
	if not exists (select 1 from storage.objects where name = '64600000-0000-4000-8000-000000000011/' || repeat('b', 64)) then
		raise exception 'A snapshot-v1 member still reads its object from Storage'; end if;
	begin
		insert into storage.objects(bucket_id, name, metadata)
		values ('qorpera-profile-objects', '64600000-0000-4000-8000-000000000011/' || repeat('f', 64), '{"size":1}');
	exception when others then
		if sqlstate = '42501' then raise exception 'A snapshot-v1 member may still write into Storage: %', sqlerrm; end if;
	end;
end $$;
reset role;
select pg_temp.as_service();

-- The approval and member-command actors, before their company fence.
do $$
begin
	perform pg_temp.fx($q$insert into public.qorpera_company_path_proposals(id, environment_id, run_id, receipt_id, plan, plan_sha256,
		resource_id, resource_version) values ('64600000-0000-4000-8000-0000000000d2', '64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), '{}', repeat('e', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.fx($q$insert into public.qorpera_member_company_path_commands(id, environment_id, user_id, operation_key, plan, plan_sha256,
		resource_id, resource_version, protected, status) values ('64600000-0000-4000-8000-0000000000d3', '64600000-0000-4000-8000-000000000020',
		'64600000-0000-4000-8000-000000000001', 'refusals-command', '{}', repeat('e', 64), extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), false, 'ready')$q$);
	perform pg_temp.refuses($q$select public.qorpera_company_path_approved_actor('64600000-0000-4000-8000-0000000000d2', repeat('e', 64))$q$);
	perform pg_temp.refuses($q$select public.qorpera_member_company_path_command_actor('64600000-0000-4000-8000-0000000000d3', repeat('e', 64), true)$q$);
	perform pg_temp.fx($q$update public.qorpera_company_path_proposals set environment_id = '64600000-0000-4000-8000-000000000021'
		where id = '64600000-0000-4000-8000-0000000000d2'$q$);
	perform pg_temp.fx($q$update public.qorpera_member_company_path_commands set environment_id = '64600000-0000-4000-8000-000000000021'
		where id = '64600000-0000-4000-8000-0000000000d3'$q$);
	perform pg_temp.not_refused($q$select public.qorpera_company_path_approved_actor('64600000-0000-4000-8000-0000000000d2', repeat('e', 64))$q$);
	perform pg_temp.not_refused($q$select public.qorpera_member_company_path_command_actor('64600000-0000-4000-8000-0000000000d3', repeat('e', 64), true)$q$);
end $$;

-- The office's Company File source, the runner broker's whole-tree lane and completion's legacy lane (by the job).
do $$
declare b jsonb := '{"jobId":"64600000-0000-4000-8000-0000000000c1"}'; s jsonb := '{"jobId":"64600000-0000-4000-8000-0000000000c2"}';
begin
	perform pg_temp.refuses(format('select public.qorpera_native_office_company_file_source(%L, %L)', b, '{}'));
	-- Since C3's runner broker lane (P23, test 829) the broker describes a folder-v2 run: no longer refused as folder-v2.
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_describe('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64))$q$);
	-- Since C1c-2c part 2, completion's folder-v2 lane replaces its refusal (test 658): no longer refused as folder-v2.
	perform pg_temp.not_refused($q$select public.qorpera_complete_runner_job_v6('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), null, null, null, '{}')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_describe('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64))$q$);
	perform pg_temp.not_refused($q$select public.qorpera_complete_runner_job_v6('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), null, null, null, '{}')$q$);
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', b, '{}'));
	perform pg_temp.not_refused(format('select public.qorpera_native_office_company_file_source(%L, %L)', s, '{}'));
	perform pg_temp.not_refused(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', s, '{}'));
	-- A job id in capitals names the same job.
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', jsonb_build_object('jobId', upper(b ->> 'jobId')), '{}'));
	-- A job id in any spelling uuid input accepts names the job; anything else names none.
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)',
		jsonb_build_object('jobId', '{' || replace(b ->> 'jobId', '-', '') || '}'), '{}'));
end $$;

-- The old row writer (contract 5.6); the old roster writers went with legacy sweep D1 (20260930330000).
do $$
begin
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.refuses($q$select public.qorpera_put_staff_provider_model('64600000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'openai', 'gpt-test', null)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_put_staff_provider_model('64600000-0000-4000-8000-000000000011',
		'64600000-0000-4000-8000-0000000000a1', 'openai', 'gpt-test', null)$q$);
	perform pg_temp.as_service();
end $$;

-- The legacy actor still refuses folder-v2 for a member (55000), as before C1c-1.
do $$
begin
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform public.qorpera_read_company_path('64600000-0000-4000-8000-000000000020', 'readme.md', null);
	raise exception 'The legacy actor must refuse folder-v2' using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' or sqlstate <> '55000' then raise; end if;
end $$;

rollback;
