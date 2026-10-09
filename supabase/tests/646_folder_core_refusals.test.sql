-- Company folder core, C1c-1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md): every legacy path and old writer
-- refuses a folder-v2 company (0A000) before it locks anything, and a snapshot-v1 company is not affected. Legacy rows a
-- guard looks up (a run's job, proposals, member commands, a bootstrap job) are made by hand, with foreign keys and
-- triggers off.
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

-- The member whole-tree lane.
do $$
begin
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.refuses($q$select public.qorpera_prepare_company_file_revision('64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), null, repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.refuses($q$select public.qorpera_publish_company_file_revision('64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), null)$q$);
	perform pg_temp.refuses($q$select public.qorpera_prepare_company_file_proposal('64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.refuses($q$select public.qorpera_submit_company_proposal('64600000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'session_turn', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 0, 'Reason.', null, 'Title', '{}')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_prepare_company_file_revision('64600000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), null, repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_publish_company_file_revision('64600000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), null)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_prepare_company_file_proposal('64600000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_submit_company_proposal('64600000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'run', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 0, 'policy', null, 'Title', '{}')$q$);
	perform pg_temp.as_service();
	perform pg_temp.fx($q$insert into public.qorpera_company_proposals(id, profile_id, environment_id, client_proposal_id, proposal_snapshot_id,
		execution_kind, execution_id, execution_claimant_id, trail_end_sequence, reason, title, created_by_user_id)
		values ('64600000-0000-4000-8000-0000000000d1', '64600000-0000-4000-8000-000000000010', '64600000-0000-4000-8000-000000000020',
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'run', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			0, 'policy', 'Title', '64600000-0000-4000-8000-000000000001')$q$);
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.refuses($q$select public.qorpera_rebase_company_proposal('64600000-0000-4000-8000-0000000000d1',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.as_service();
	perform pg_temp.fx($q$update public.qorpera_company_proposals set profile_id = '64600000-0000-4000-8000-000000000011',
		environment_id = '64600000-0000-4000-8000-000000000021' where id = '64600000-0000-4000-8000-0000000000d1'$q$);
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.not_refused($q$select public.qorpera_rebase_company_proposal('64600000-0000-4000-8000-0000000000d1',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.as_service();
end $$;

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

-- The office's Company File transfers, the runner broker's whole-tree lane and completion's legacy lane (by the job).
do $$
declare b jsonb := '{"jobId":"64600000-0000-4000-8000-0000000000c1"}'; s jsonb := '{"jobId":"64600000-0000-4000-8000-0000000000c2"}';
begin
	perform pg_temp.refuses(format('select public.qorpera_native_office_company_file_source(%L, %L)', b, '{}'));
	perform pg_temp.refuses(format('select public.qorpera_confirm_office_company_file_import(%L, %L, %L, %L, %L, %L)', b, '{}', '{}', '{}',
		extensions.gen_random_uuid(), '{}'));
	-- Since C3's runner broker lane (P23, test 829) the broker describes a folder-v2 run: no longer refused as folder-v2.
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_describe('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64))$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_broker_authorize_input_object('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), repeat('b', 64))$q$);
	-- Since C1c-2c part 2, completion's folder-v2 lane replaces its refusal (test 658): no longer refused as folder-v2.
	perform pg_temp.not_refused($q$select public.qorpera_complete_runner_job_v6('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), null, null, null, '{}')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_describe('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64))$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_authorize_input_object('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), repeat('b', 64))$q$);
	perform pg_temp.not_refused($q$select public.qorpera_complete_runner_job_v6('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), null, null, null, '{}')$q$);
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', b, '{}'));
	perform pg_temp.not_refused(format('select public.qorpera_native_office_company_file_source(%L, %L)', s, '{}'));
	perform pg_temp.not_refused(format('select public.qorpera_confirm_office_company_file_import(%L, %L, %L, %L, %L, %L)', s, '{}', '{}', '{}',
		extensions.gen_random_uuid(), '{}'));
	perform pg_temp.not_refused(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', s, '{}'));
	-- A job id in capitals names the same job.
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)', jsonb_build_object('jobId', upper(b ->> 'jobId')), '{}'));
	-- The runner's revision lane.
	perform pg_temp.refuses($q$select public.qorpera_runner_prepare_company_revision('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_begin_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		repeat('d', 64), repeat('d', 64), 1, 1)$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_append_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), '[]')$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_complete_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_company_revision_snapshot('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_authorize_company_revision_verification('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid())$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_finalize_company_revision_verification('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c1', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid())$q$);
	perform pg_temp.refuses($q$select public.qorpera_runner_broker_authorize_company_file_object('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c1', repeat('a', 64), repeat('b', 64), 1, 'text/plain')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_prepare_company_revision('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('d', 64), 10, 3, 1, 1)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_broker_authorize_company_file_object('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c2', repeat('a', 64), repeat('b', 64), 1, 'text/plain')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_begin_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		repeat('d', 64), repeat('d', 64), 1, 1)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_append_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), '[]')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_complete_company_revision_graph('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_company_revision_snapshot('64600000-0000-4000-8000-0000000000c9', repeat('a', 64),
		'64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_authorize_company_revision_verification('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid())$q$);
	perform pg_temp.not_refused($q$select public.qorpera_runner_finalize_company_revision_verification('64600000-0000-4000-8000-0000000000c9',
		repeat('a', 64), '64600000-0000-4000-8000-0000000000c2', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid())$q$);
	-- A job id in any spelling uuid input accepts names the job; anything else names none.
	perform pg_temp.refuses(format('select public.qorpera_confirm_agent_todo_publication(%L, %L)',
		jsonb_build_object('jobId', '{' || replace(b ->> 'jobId', '-', '') || '}'), '{}'));
end $$;

-- The snapshot bootstrap: the worker skips a folder-v2 company's job, and finalizing it or seeding a Co-Founder refuses.
do $$
begin
	perform pg_temp.fx($q$update public.qorpera_company_bootstrap_jobs set state = 'blocked', lease_owner = null, lease_expires_at = null where state in ('queued','leased')$q$);
	perform pg_temp.fx($q$insert into public.qorpera_company_bootstrap_jobs(id, profile_id, environment_id, created_by_user_id,
		cofounder_staff_agent_id, formation_id, member_session_id, formation_document, cofounder_agent_document, hidden_until_ready,
		first_run_required, state) values ('64600000-0000-4000-8000-0000000000d4', '64600000-0000-4000-8000-000000000010',
		'64600000-0000-4000-8000-000000000020', '64600000-0000-4000-8000-000000000001', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), '{}', '{}', false, false, 'queued')$q$);
	if public.qorpera_claim_company_bootstrap(extensions.gen_random_uuid(), 60) is not null then
		raise exception 'The bootstrap worker claims no folder-v2 job'; end if;
	perform pg_temp.refuses($q$select public.qorpera_finalize_company_bootstrap('64600000-0000-4000-8000-0000000000d4',
		extensions.gen_random_uuid(), '{}', '{}', '{}', '{}', '{}')$q$);
	perform pg_temp.refuses($q$select public.qorpera_seed_company_cofounder('64600000-0000-4000-8000-000000000010',
		'64600000-0000-4000-8000-000000000001')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_seed_company_cofounder('64600000-0000-4000-8000-000000000011',
		'64600000-0000-4000-8000-000000000001')$q$);
	-- A snapshot-v1 company's queued job is still claimed.
	perform pg_temp.fx($q$insert into public.qorpera_company_bootstrap_jobs(id, profile_id, environment_id, created_by_user_id,
		cofounder_staff_agent_id, formation_id, member_session_id, formation_document, cofounder_agent_document, hidden_until_ready,
		first_run_required, state) values ('64600000-0000-4000-8000-0000000000d5', '64600000-0000-4000-8000-000000000011',
		'64600000-0000-4000-8000-000000000021', '64600000-0000-4000-8000-000000000001', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), '{}', '{}', false, false, 'queued')$q$);
	perform pg_temp.not_refused($q$select public.qorpera_finalize_company_bootstrap('64600000-0000-4000-8000-0000000000d5',
		extensions.gen_random_uuid(), '{}', '{}', '{}', '{}', '{}')$q$);
	set local session_replication_role = replica;
	if public.qorpera_claim_company_bootstrap(extensions.gen_random_uuid(), 60) ->> 'jobId' is distinct from '64600000-0000-4000-8000-0000000000d5' then
		raise exception 'The worker still claims a snapshot-v1 job'; end if;
	set local session_replication_role = origin;
end $$;

-- The legacy pause, and the old row writers (contract 5.6).
do $$
begin
	perform pg_temp.as_member('64600000-0000-4000-8000-000000000001');
	perform pg_temp.refuses($q$select public.qorpera_set_company_execution_pause('64600000-0000-4000-8000-000000000010', true, null)$q$);
	perform pg_temp.refuses($q$select public.qorpera_put_profile_staff('64600000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'Agent', 'Role', 'Charter.', null, null, 'green', 'round', null, null, null, 'active', 'active', statement_timestamp(), null)$q$);
	perform pg_temp.refuses($q$select public.qorpera_delete_profile_staff('64600000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 1)$q$);
	perform pg_temp.refuses($q$select public.qorpera_put_staff_provider_model('64600000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'openai', 'gpt-test', null)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_put_staff_provider_model('64600000-0000-4000-8000-000000000011',
		'64600000-0000-4000-8000-0000000000a1', 'openai', 'gpt-test', null)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_put_profile_staff('64600000-0000-4000-8000-000000000011', extensions.gen_random_uuid(),
		'Agent', 'Role', 'Charter.', null, null, 'green', 'round', null, null, null, 'active', 'active', statement_timestamp(), null)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_delete_profile_staff('64600000-0000-4000-8000-000000000011',
		'64600000-0000-4000-8000-0000000000a1', 1)$q$);
	perform pg_temp.not_refused($q$select public.qorpera_set_company_execution_pause('64600000-0000-4000-8000-000000000011', true, null)$q$);
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
