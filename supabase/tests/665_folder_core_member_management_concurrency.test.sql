-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3c under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.4): a removal takes
-- the job its connection revoke ends before the fence; two founders leaving at once meet at the fence, so the second
-- sees no founder left; a removal and a post meet at the agent's thread room; member changes never wait for a
-- company-row KEY SHARE holder; a join waits at the fence behind a removal in flight; a hire waits for a removal and a
-- demotion at the member rows, so neither member stays in the new agent's thread; a founder's step-down waits at its
-- member row holding no room; a join caught at the fence holds no invitation, so a deletion goes on. 648's committed
-- fixture, removed at the end.

-- More people (committed): 04 with its own login (connection c6, binding b7) and a queued run it pays for, 05, 07, 08
-- and 10; 06 and 09, who are invited.
insert into auth.users(id, email, email_confirmed_at) values
	('66500000-0000-4000-8000-000000000004', 'race-member-4@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000005', 'race-member-5@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000006', 'race-joiner@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000007', 'race-member-7@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000008', 'race-member-8@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-000000000009', 'race-joiner-9@example.test', clock_timestamp()),
	('66500000-0000-4000-8000-00000000000a', 'race-member-10@example.test', clock_timestamp());
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000004', 'race-member-4@example.test', 'Four', 'contributor'),
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000005', 'race-member-5@example.test', 'Five', 'contributor'),
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000007', 'race-member-7@example.test', 'Seven', 'contributor'),
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-000000000008', 'race-member-8@example.test', 'Eight', 'contributor'),
	('64800000-0000-4000-8000-000000000010', '66500000-0000-4000-8000-00000000000a', 'race-member-10@example.test', 'Ten', 'contributor');
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, expires_at) values
	('66500000-0000-4000-8000-0000000000e1', '64800000-0000-4000-8000-000000000010', 'race-joiner@example.test', 'contributor',
		'64800000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 day'),
	('66500000-0000-4000-8000-0000000000e2', '64800000-0000-4000-8000-000000000010', 'race-joiner-9@example.test', 'contributor',
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
-- Whether a row is free: a NOWAIT lock on another connection (fence_four unless named; it must be idle, outside a
-- transaction), released at once.
create function pg_temp.row_free(p_sql text, p_conn text default 'fence_four') returns boolean language plpgsql as $$
begin
	perform * from dblink(p_conn, p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- Whether a member is active in an agent's thread.
create function pg_temp.in_thread(p_agent uuid, p_user uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_company_room_members m join public.qorpera_company_rooms r on r.id = m.room_id
		where r.profile_id = '64800000-0000-4000-8000-000000000010' and r.bound_staff_agent_id = p_agent
			and m.principal_kind = 'member' and m.principal_id = p_user and m.status = 'active')
$$;

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

-- F. A save that creates an agent's thread room beside a member change in flight: a hire (a new agent's folder), or
-- the activation of an agent first saved archived (it has a staff row but no room). The save names every member row
-- KEY SHARE at rank 1, so it waits for a removal or a demotion (the member row FOR UPDATE) before the new room copies
-- the roster. Neither the removed member nor the new viewer is in the new thread. (Before, the save copied the roster
-- beside the change, and the viewer could then post in the new thread.) Bytes are staged first (staging takes the
-- company row), and the member who saves them takes possession of them first, committed too; Dan is saved archived
-- first, committed.
create function pg_temp.sql_member_save(p_key text, p_units jsonb) returns text language plpgsql as $$
begin
	perform pg_temp.possess('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"66500000-0000-4000-8000-000000000006"}',
		p_units);
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"66500000-0000-4000-8000-000000000006"}', p_key, p_units);
end $$;
select set_config('qorpera_test.hire_' || h, pg_temp.sql_member_save('member-change-hire-' || h,
	jsonb_build_array(pg_temp.hire(h, ('66500000-0000-4000-8000-0000000000' || id)::uuid, initcap(h)))), false)
from (values ('bea', 'a2'), ('cal', 'a3')) v(h, id) \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"member","userId":"66500000-0000-4000-8000-000000000006"}', 'member-change-dan-archived',
	jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', 'agents/dan',
		'contents', jsonb_build_array(
			jsonb_build_object('path', 'agent.md', 'kind', 'file', 'file', pg_temp.stage(replace(pg_temp.agent_text('66500000-0000-4000-8000-0000000000a4',
				'Dan'), 'status: active', 'status: archived'))),
			jsonb_build_object('path', 'memory', 'kind', 'folder'), jsonb_build_object('path', 'todos', 'kind', 'folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/dan/agent.md', 'agent',
			replace(pg_temp.agent_text('66500000-0000-4000-8000-0000000000a4', 'Dan'), 'status: active', 'status: archived'),
			pg_temp.agent_parse('66500000-0000-4000-8000-0000000000a4', 'Dan') || '{"status":"archived"}'))))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.hire_dan', pg_temp.sql_member_save('member-change-dan-active',
	jsonb_build_array(pg_temp.write('agents/dan/agent.md', 'agent', pg_temp.agent_text('66500000-0000-4000-8000-0000000000a4', 'Dan'),
		pg_temp.agent_parse('66500000-0000-4000-8000-0000000000a4', 'Dan'), pg_temp.version('agents/dan/agent.md')))), false) \g /dev/null
do $$
begin
	if exists (select 1 from public.qorpera_company_rooms where bound_staff_agent_id = '66500000-0000-4000-8000-0000000000a4') then
		raise exception 'F: an agent saved archived has no thread room yet'; end if;
end $$;
do $$
declare v_change text; v_hire text; v_case record;
begin
	perform dblink_exec('fence_one', $q$set request.jwt.claims = '{"role":"authenticated","sub":"66500000-0000-4000-8000-000000000006"}'$q$);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	for v_case in select * from (values
		('bea', '66500000-0000-4000-8000-0000000000a2'::uuid, '66500000-0000-4000-8000-000000000007'::uuid,
			format('select public.qorpera_remove_profile_member(%L, %L)::text', '64800000-0000-4000-8000-000000000010',
				'66500000-0000-4000-8000-000000000007')),
		('cal', '66500000-0000-4000-8000-0000000000a3'::uuid, '66500000-0000-4000-8000-000000000008'::uuid,
			format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text', '64800000-0000-4000-8000-000000000010',
				'66500000-0000-4000-8000-000000000008', 'viewer')),
		('dan', '66500000-0000-4000-8000-0000000000a4'::uuid, '66500000-0000-4000-8000-00000000000a'::uuid,
			format('select public.qorpera_remove_profile_member(%L, %L)::text', '64800000-0000-4000-8000-000000000010',
				'66500000-0000-4000-8000-00000000000a'))) c(handle, agent, member, change) loop
		perform dblink_exec('fence_one', 'begin');
		perform * from dblink('fence_one', v_case.change) as t(x text);
		perform dblink_send_query('fence_two', current_setting('qorpera_test.hire_' || v_case.handle));
		if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then
			raise exception 'F: the hire of % must wait at the member rows for the member change', v_case.handle; end if;
		perform dblink_exec('fence_one', 'commit');
		v_hire := pg_temp.outcome('fence_two');
		if v_hire <> 'ok' then raise exception 'F: the hire of % after the change: %', v_case.handle, v_hire; end if;
		if pg_temp.in_thread(v_case.agent, v_case.member) then
			raise exception 'F: the changed member must not be active in %''s new thread', v_case.handle; end if;
		if not pg_temp.in_thread(v_case.agent, '66500000-0000-4000-8000-000000000006') then
			raise exception 'F: the hirer must be in %''s new thread', v_case.handle; end if;
	end loop;
end $$;

-- G. A founder's step-down stops at its member row behind a KEY SHARE holder (any run, save or post past rank 1)
-- holding no thread room, so the same member's post goes on beside it and lands. (With the member row taken FOR NO KEY
-- UPDATE first, the change would hold the rooms and then wait to strengthen the row: the post would deadlock.)
update public.qorpera_profile_members set role = 'owner' where profile_id = '64800000-0000-4000-8000-000000000010'
	and user_id = '64800000-0000-4000-8000-000000000001';
do $$
declare v_role text; v_post text;
begin
	perform dblink_exec('fence_one', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
		and user_id = '64800000-0000-4000-8000-000000000001' for key share$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'admin'));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'G: the step-down must wait at its member row'; end if;
	if not pg_temp.row_free(format('select 1 from public.qorpera_company_rooms where id = %L for key share', current_setting('qorpera_test.cf_room'))) then
		raise exception 'G: the step-down must hold no thread room while it waits at its member row'; end if;
	perform dblink_send_query('fence_two', format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text',
		current_setting('qorpera_test.cf_room'), extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Beside the step-down'), '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'G: the post must not wait for the step-down'; end if;
	v_post := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'commit');
	v_role := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_role <> 'ok' then raise exception 'G: the post % and the step-down %', v_post, v_role; end if;
end $$;

-- H. A join caught at the fence (held FOR UPDATE, as stop's second phase holds it) holds no invitation while it waits.
-- Since C1c-3g (20260930015000) the last member's deletion takes member management's lock too (the fence FOR NO KEY
-- UPDATE), so it waits at the fence behind the join; the join, queued first, joins once the fence is free, and the
-- deletion then sees another member and refuses. 01 is made the last member first (the others removed by hand,
-- triggers off).
set session_replication_role = replica;
delete from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
	and user_id <> '64800000-0000-4000-8000-000000000001';
set session_replication_role = origin;
do $$
declare v_join text; v_delete text;
begin
	perform dblink_exec('fence_four', 'begin');
	perform * from dblink('fence_four', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"66500000-0000-4000-8000-000000000009","email":"race-joiner-9@example.test"}'$q$);
	perform dblink_send_query('fence_two', $q$select public.qorpera_accept_profile_invitation('66500000-0000-4000-8000-0000000000e2')::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_four') then raise exception 'H: the join must wait at the fence'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_profile_invitations where id = '66500000-0000-4000-8000-0000000000e2'
			for update$q$, 'fence_one') then
		raise exception 'H: the join must hold no invitation while it waits at the fence'; end if;
	perform dblink_exec('fence_three', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_send_query('fence_three', $q$select public.qorpera_delete_hosted_profile('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_at('fence_three', 'public.qorpera_folder_fences') then
		perform dblink_exec('fence_four', 'rollback');
		raise exception 'H: the deletion must wait at the fence'; end if;
	perform dblink_exec('fence_four', 'rollback');
	v_join := pg_temp.outcome('fence_two');
	v_delete := pg_temp.outcome('fence_three');
	if v_join <> 'ok' or v_delete not like '42501 Only the last member can delete the company%' then
		raise exception 'H: the join % and the deletion %', v_join, v_delete; end if;
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
	'66500000-0000-4000-8000-000000000006', '66500000-0000-4000-8000-000000000007', '66500000-0000-4000-8000-000000000008',
	'66500000-0000-4000-8000-000000000009', '66500000-0000-4000-8000-00000000000a');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
