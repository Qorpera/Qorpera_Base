-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3c under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.4): a removal takes
-- the job its connection revoke ends before the fence; two founders leaving at once meet at the fence, so the second
-- sees no founder left; a removal and a post meet at the agent's thread room; member changes never wait for a
-- company-row KEY SHARE holder; a join waits at the fence behind a removal in flight. 648's committed fixture, removed
-- at the end.

-- Three more people (committed): 04 with its own login (connection c6, binding b7) and a queued run it pays for, 05, and
-- 06, who is invited.
insert into auth.users(id, email, email_confirmed_at) values
	('66500000-0000-4000-8000-000000000004', 'race-member-4@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000005', 'race-member-5@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000006', 'race-joiner@example.test', clock_timestamp());
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000004', 'race-member-4@example.test', 'Four', 'contributor'),
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000005', 'race-member-5@example.test', 'Five', 'contributor');
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, expires_at)
values ('66500000-0000-4000-8000-0000000000e1', '64800000-0000-4000-8000-000000000010', 'race-joiner@example.test', 'contributor',
	'64800000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 day');
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
values ('66500000-0000-4000-8000-0000000000c6', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'66500000-0000-4000-8000-000000000004', 'openai', '66500000-0000-4000-8000-000000000004');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('66500000-0000-4000-8000-0000000000b7', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'66500000-0000-4000-8000-000000000004');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('66500000-0000-4000-8000-0000000000b7', 1, 'member_connection', '66500000-0000-4000-8000-0000000000c6', 1,
	'66500000-0000-4000-8000-000000000004');
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability, job_type,
	payload, created_by_user_id, status, run_id)
values ('66500000-0000-4000-8000-0000000000f2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '66500000-0000-4000-8000-000000000004',
	'queued', '66500000-0000-4000-8000-0000000000f1');
insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
	company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
	transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection, audience_kind,
	runtime_bundle_id, runtime_bundle_sha256, input_ids)
values ('66500000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'wake',
	extensions.gen_random_uuid(), '66500000-0000-4000-8000-0000000000f2', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-0000000000a1', 1, '66500000-0000-4000-8000-0000000000b7', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
	'66500000-0000-4000-8000-000000000004', '66500000-0000-4000-8000-000000000004', 'openai', 'gpt-test', 'provider_default', 'company',
	extensions.gen_random_uuid(), repeat('b', 64), '{}');
set session_replication_role = origin;
select set_config('qorpera_test.cf_room', id::text, false), set_config('qorpera_test.cf_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$)
from unnest(array['fence_one','fence_two']) name;

create function pg_temp.sql_remove(p_user uuid) returns text language sql as $$
	select format('select public.qorpera_remove_profile_member(%L, %L)::text', '64800000-0000-4000-8000-000000000010', p_user)
$$;
-- Whether a connection waits at a row of a table: it holds or queues for that row's tuple lock while blocked.
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
-- Whether a row is free: a NOWAIT lock on another connection, released at once.
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;

-- A. The job a removal's connection revoke ends is taken first: behind a holder of it (a tool call of that run), the
-- removal waits at the job, holding neither the fence nor the member's row; then it lands and the run ends.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_runner_jobs where id = '66500000-0000-4000-8000-0000000000f2'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_remove('66500000-0000-4000-8000-000000000004'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runner_jobs') then raise exception 'A: the removal must wait at the job'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
			for no key update$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '66500000-0000-4000-8000-000000000004' for update$q$) then
		raise exception 'A: the removal must hold neither the fence nor the member while it waits at the job'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or (select status from public.qorpera_runner_jobs where id = '66500000-0000-4000-8000-0000000000f2') not in ('failed','cancelled')
		or exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '66500000-0000-4000-8000-000000000004') then
		raise exception 'A: the removal after the job: % (job %)', v_state,
			(select status from public.qorpera_runner_jobs where id = '66500000-0000-4000-8000-0000000000f2'); end if;
end $$;

-- C. A removal meets a post in the Co-Founder's thread at the room: the post holds the room (FOR SHARE) and its
-- conversation and waits at the clock; the removal waits at the room before it writes anything; both land.
do $$
declare v_post text; v_removal text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text',
		current_setting('qorpera_test.cf_room'), extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Before the removal'), '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then raise exception 'C: the post must wait at the clock'; end if;
	perform dblink_send_query('fence_one', pg_temp.sql_remove('66500000-0000-4000-8000-000000000005'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_company_rooms') then raise exception 'C: the removal must wait at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	v_removal := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_removal <> 'ok' then raise exception 'C: the post % and the removal %', v_post, v_removal; end if;
end $$;

-- D. Member changes take the company row KEY SHARE only: beside a holder of it (any folder effect), a role change does
-- not wait, and neither does a founder stepping down (the founder guard's own company-row lock is KEY SHARE too).
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002', 'owner'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then raise exception 'D: a role change must not wait for a KEY SHARE holder'; end if;
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'D: the role change beside a KEY SHARE holder: %', v_state; end if;
	perform dblink_send_query('fence_two', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'admin'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then
		raise exception 'D: a founder stepping down must not wait for a KEY SHARE holder'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'rollback');
	if v_state <> 'ok' then raise exception 'D: the step-down beside a KEY SHARE holder: %', v_state; end if;
end $$;

-- E. A join waits at the fence behind a member change in flight (02, now a founder, changes 01's role; committed
-- after), then lands.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000002"}'$q$);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'contributor')) as t(x text);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"66500000-0000-4000-8000-000000000006","email":"race-joiner@example.test"}'$q$);
	perform dblink_send_query('fence_two', $q$select public.qorpera_accept_profile_invitation('66500000-0000-4000-8000-0000000000e1')::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		raise exception 'E: the join must wait at the fence'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000002"}'$q$);
	if v_state <> 'ok' or not exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '66500000-0000-4000-8000-000000000006') then
		raise exception 'E: the join after the step-down: %', v_state; end if;
end $$;

-- B. Two founders leave at once (02, made a founder in D, and 06, made one here; 01 stepped down in D and stays): they
-- meet at the fence, so the second sees no other founder and refuses while others remain.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', $q$update public.qorpera_profile_members set role = 'owner'
		where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '66500000-0000-4000-8000-000000000006'$q$);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select public.qorpera_leave_hosted_profile('64800000-0000-4000-8000-000000000010')::text$q$) as t(x text);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"66500000-0000-4000-8000-000000000006"}'$q$);
	perform dblink_send_query('fence_two', $q$select public.qorpera_leave_hosted_profile('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		raise exception 'B: the second founder''s leave must wait at the fence'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '42501 The last founder cannot leave while others remain%' then
		raise exception 'B: the second founder leaving: %', v_state; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 648 does).
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
	delete from public.qorpera_execution_sponsor_versions where binding_id in ('64800000-0000-4000-8000-0000000000b1',
		'66500000-0000-4000-8000-0000000000b7');
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003', '66500000-0000-4000-8000-000000000004', '66500000-0000-4000-8000-000000000005',
	'66500000-0000-4000-8000-000000000006');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
