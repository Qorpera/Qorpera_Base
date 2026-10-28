-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6): a member's post
-- meets a coworker message at the conversation, in both orders; a post waits for a company-row holder at rank 0 holding
-- no room, and never waits for a KEY SHARE holder; a room whose agents change while a post waits refuses as a
-- retryable conflict; two posts in one room queue at the conversation; a member's own rule and an agent's rule for that
-- member meet at the member's row; an email draft never waits for the company row; a stop waits for a post in flight; a
-- retry never waits for a company-row KEY SHARE holder; a save changing group chats waits for a post at the room (a
-- rename of two chats, an agent leaving, the poster leaving); a post waits at the operation clock holding no admission;
-- a save removing a retry's author from a group chat waits for the retry.
-- 648's committed fixture, removed at the end.

-- Ada's run acknowledges, so its tool calls may work; the company's login pays for unattended work (as 657's does).
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'ack', 'On it.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;
select set_config('qorpera_test.cf_room', id::text, false), set_config('qorpera_test.cf_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null
select dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);

-- The owner's post into the Co-Founder's thread (the company's login, which the owner set up).
create function pg_temp.sql_post(p_key text) returns text language sql as $$
	select format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text', current_setting('qorpera_test.cf_room'),
		extensions.gen_random_uuid(), jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Post ' || p_key),
		'64800000-0000-4000-8000-0000000000b1')
$$;
create function pg_temp.sql_cw(p_key text) returns text language sql as $$
	select format('select public.qorpera_send_coworker_message(%L, %L, %L, %L, true)::text', current_setting('qorpera_test.binding'),
		'64800000-0000-4000-8000-0000000000c0', p_key, 'A race message.')
$$;
create function pg_temp.room_locked(p_conn text) returns boolean language sql as $$
	select exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and relation = 'public.qorpera_company_rooms'::regclass and mode = 'RowShareLock')
$$;

-- A. A post and a coworker message into the same thread, in both orders: both take the company row and ranks at KEY
-- SHARE (the post's room FOR SHARE, which a message's KEY SHARE does not wait for), so they meet at the conversation FOR
-- UPDATE, and nothing waits in a circle.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_cw('post-race-1')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_post('after-message'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The post must wait for the message in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The post must wait at the conversation, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The post after the message: %', v_state; end if;

	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_post('before-message')) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('post-race-2'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the post in flight'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The message after the post: %', v_state; end if;
end $$;

-- B. A company-row holder (legacy member management still takes it FOR UPDATE until C1c-3c): the post waits at rank 0,
-- holding no room yet. A KEY SHARE holder (any folder effect) never makes it wait.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_post('behind-company-row'));
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'The post must wait for the company row'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The post must wait at the company row, not on %', pg_temp.queued_on('fence_two'); end if;
	if pg_temp.room_locked('fence_two') then raise exception 'The post holds no room while it waits at rank 0'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The post after the company row: %', v_state; end if;

	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_post('beside-key-share'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then raise exception 'The post must not wait for a KEY SHARE holder'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'rollback');
	if v_state <> 'ok' then raise exception 'The post beside a KEY SHARE holder: %', v_state; end if;
end $$;

-- C. The room's agents change while a post waits for the room: the post read them before its locks, reads them again
-- under the locks, and refuses as a retryable conflict. The retry lands.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_company_rooms where id = %L for update',
		current_setting('qorpera_test.cf_room'))) as t(x integer);
	perform dblink_exec('fence_three', format($q$update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
		where room_id = %L and principal_kind = 'staff_agent'$q$, current_setting('qorpera_test.cf_room')));
	perform dblink_send_query('fence_two', pg_temp.sql_post('room-changed'));
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'The post must wait for the room'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The post must wait at the room, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_three', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like 'PGRST %"QRC01"%Room changed while the message waited%' then
		raise exception 'A post whose room changed while it waited: %', v_state; end if;
	perform dblink_exec('fence_three', format($q$update public.qorpera_company_room_members set status = 'active', removed_at = null
		where room_id = %L and principal_kind = 'staff_agent'$q$, current_setting('qorpera_test.cf_room')));
	perform * from dblink('fence_two', pg_temp.sql_post('room-changed-retry')) as t(x text);
end $$;

-- D. Two posts in one room: the second waits at the conversation; both land, each with its wake.
do $$
declare v_state text; v_before bigint;
begin
	select count(*) into v_before from public.qorpera_wake_occurrences where wake_kind = 'room'
		and session_id = current_setting('qorpera_test.cf_thread')::uuid;
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_post('first-of-two')) as t(x text);
	perform dblink_exec('fence_three', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_send_query('fence_three', pg_temp.sql_post('second-of-two'));
	if not pg_temp.waits_for('fence_three', 'fence_two') then raise exception 'The second post must wait for the first'; end if;
	-- It waits at the conversation before its first write (no input row yet), so it never holds the conversation KEY SHARE
	-- through the input's foreign key and then asks for it FOR UPDATE.
	if pg_temp.queued_on('fence_three') is distinct from 'public.qorpera_shared_sessions'::regclass
		or exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_three')::integer
			and relation = 'public.qorpera_session_inputs'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'The second post waits at the conversation before writing'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_three');
	perform dblink_exec('fence_three', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	if v_state <> 'ok' then raise exception 'The second post: %', v_state; end if;
	if (select count(*) from public.qorpera_wake_occurrences where wake_kind = 'room'
		and session_id = current_setting('qorpera_test.cf_thread')::uuid) <> v_before + 2 then
		raise exception 'Two posts, two wakes'; end if;
end $$;

-- E. A member's own rule and an agent's "Ask first" rule for that member meet at the member's row (rank 1, FOR NO KEY
-- UPDATE on both sides), not the company row.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000002"}'$q$);
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select public.qorpera_save_review_rule(%L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'member', 'Sending money', 'ask_first')) as t(x text);
	perform dblink_send_query('fence_one', format('select public.qorpera_add_agent_review_rule(%L, %L)::text',
		current_setting('qorpera_test.binding'), jsonb_build_object('operationKey', 'rule-race', 'when', 'Paying invoices')));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'The agent''s rule must wait for the member''s'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profile_members'::regclass then
		raise exception 'The agent''s rule must wait at the member''s row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_three', 'commit');
	v_state := pg_temp.outcome('fence_one');
	perform dblink_exec('fence_three', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	if v_state <> 'ok' then raise exception 'The agent''s rule after the member''s: %', v_state; end if;
end $$;

-- F. An email draft takes no company row: with the company row held FOR UPDATE elsewhere, it reaches its own checks.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', format('select public.qorpera_get_email_draft(%L, %L)::text', current_setting('qorpera_test.cf_thread'),
		extensions.gen_random_uuid()));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then raise exception 'The email draft must not wait for the company row'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'rollback');
	if v_state not like '22023 %' then raise exception 'The email draft reaches its own checks: %', v_state; end if;
end $$;

-- G. A post in flight holds the folder fence KEY SHARE: a stop's second phase (the fence FOR UPDATE) waits for it.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_post('before-stop')) as t(x text);
	perform dblink_exec('fence_three', 'begin');
	perform dblink_send_query('fence_three', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for update$q$);
	if not pg_temp.waits_for('fence_three', 'fence_two') then raise exception 'The stop must wait for the post in flight'; end if;
	if pg_temp.queued_on('fence_three') is distinct from 'public.qorpera_folder_fences'::regclass then
		raise exception 'The stop must wait at the fence, not on %', pg_temp.queued_on('fence_three'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_three');
	perform dblink_exec('fence_three', 'rollback');
	if v_state <> 'ok' then raise exception 'The stop after the post: %', v_state; end if;
end $$;

-- H. A room delivery's retry takes no company row FOR UPDATE: beside a company-row KEY SHARE holder it does not wait.
-- The run of one of the posts' wakes failed (hand-built, committed).
set session_replication_role = replica;
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run uuid := '66100000-0000-4000-8000-0000000000f1';
	v_job uuid := '66100000-0000-4000-8000-0000000000f2';
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where wake_kind = 'room'
		and session_id = current_setting('qorpera_test.cf_thread')::uuid order by created_at limit 1;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, finished_at, run_id)
	values (v_job, v_wake.profile_id, v_wake.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn',
		'agent_turn', '{}', v_wake.requested_by_user_id, 'failed', clock_timestamp(), v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_wake.profile_id, v_wake.environment_id, 'room_delivery', v_wake.id, v_job, extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), v_wake.staff_agent_id, 1, v_wake.sponsor_binding_id, v_wake.sponsor_version, 'agent_turn',
		'agent_turn', repeat('c', 64), 0, v_wake.requested_by_user_id, v_wake.requested_by_user_id, 'openai', 'gpt-test',
		'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), v_wake.session_id, '{}');
	update public.qorpera_wake_occurrences set run_id = v_run, status = 'materialized' where id = v_wake.id;
end $$;
set session_replication_role = origin;
do $$
declare v_state text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', $q$select public.qorpera_retry_room_delivery('66100000-0000-4000-8000-0000000000f1',
		'64800000-0000-4000-8000-0000000000b1', 1)::text$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then raise exception 'The retry must not wait for a KEY SHARE holder'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'rollback');
	if v_state <> 'ok' then raise exception 'The retry beside a KEY SHARE holder: %', v_state; end if;
end $$;

-- Group chats for I to K (F2's files, committed): G1 and G2 with the Co-Founder and Ada, G3 with Bo too, the owner in each.
create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n%s---\nPlan.\n', p_id, p_name,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a))
$$;
create function pg_temp.group_parse(p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'group', 'id', p_id, 'name', p_name, 'subtitle', null, 'agents', to_jsonb(p_agents),
		'people', to_jsonb(p_people), 'purpose', 'Plan.')
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file',
			'file', pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents, p_people)))),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents, p_people), pg_temp.group_parse(p_id, p_name, p_agents, p_people))))
$$;
create function pg_temp.edit_group(p_handle text, p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group', pg_temp.group_text(p_id, p_name, p_agents, p_people),
		pg_temp.group_parse(p_id, p_name, p_agents, p_people), pg_temp.version('QorperaOS/agents/groups/' || p_handle || '/group.md'))
$$;
-- A save's statement, built before a race starts (staging a file takes the company row), after the owner takes
-- possession of its files in this session (648's pg_temp.possess), committed before the race too.
create function pg_temp.sql_save(p_key text, p_units jsonb) returns text language plpgsql as $$
begin
	perform pg_temp.possess('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}',
		p_units);
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', p_key, p_units);
end $$;
create function pg_temp.sql_group_post(p_room uuid, p_text text) returns text language sql as $$
	select format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text', p_room, extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text), '64800000-0000-4000-8000-0000000000b1')
$$;
create function pg_temp.hold_conversation(p_room uuid) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_shared_sessions where id = %L for update',
		(select session_id from public.qorpera_company_rooms where id = p_room))) as t(x integer);
end $$;
-- Whether a connection waits at a row of a table: it holds or queues for that row's tuple lock while blocked (the
-- second waiter on a row queues behind the first, not on the holder).
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
select pg_temp.expect(pg_temp.commit('{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'member-actions-hire-0001',
	jsonb_build_array(pg_temp.hire('bo', '66100000-0000-4000-8000-0000000000b0', 'Bo'))), 1, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'member-actions-groups-0001',
	jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
		pg_temp.new_group('g1', '66100000-0000-4000-8000-0000000000e1', 'G1',
			array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1']::uuid[],
			array['64800000-0000-4000-8000-000000000001']::uuid[]),
		pg_temp.new_group('g2', '66100000-0000-4000-8000-0000000000e2', 'G2',
			array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1']::uuid[],
			array['64800000-0000-4000-8000-000000000001']::uuid[]),
		pg_temp.new_group('g3', '66100000-0000-4000-8000-0000000000e3', 'G3',
			array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1', '66100000-0000-4000-8000-0000000000b0']::uuid[],
			array['64800000-0000-4000-8000-000000000001']::uuid[]))), 4, 'saved') \g /dev/null

-- I. A save renaming two group chats and a post in the second (C1C §6.2): the post holds that chat's room FOR SHARE and
-- waits at its conversation; the save waits at the room before it writes, so it holds no operation clock that the post
-- will want; both land. (With the room KEY SHARE the save took the clock at G1 and waited for G2's conversation: a
-- deadlock.)
select set_config('qorpera_test.rename_two', pg_temp.sql_save('member-actions-rename-0001', jsonb_build_array(
	pg_temp.edit_group('g1', '66100000-0000-4000-8000-0000000000e1', 'G1 renamed',
		array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1']::uuid[],
		array['64800000-0000-4000-8000-000000000001']::uuid[]),
	pg_temp.edit_group('g2', '66100000-0000-4000-8000-0000000000e2', 'G2 renamed',
		array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1']::uuid[],
		array['64800000-0000-4000-8000-000000000001']::uuid[]))), false) \g /dev/null
do $$
declare v_post text; v_save text;
begin
	perform pg_temp.hold_conversation('66100000-0000-4000-8000-0000000000e2');
	perform dblink_send_query('fence_two', pg_temp.sql_group_post('66100000-0000-4000-8000-0000000000e2', 'Rename race'));
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'I: the post must wait at the conversation'; end if;
	perform dblink_send_query('fence_one', current_setting('qorpera_test.rename_two'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'I: the save must wait for the post'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'I: the save must wait at the room, not on %', pg_temp.queued_on('fence_one'); end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_profile_operation_clocks
			where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) then
		raise exception 'I: the waiting save must hold no operation clock'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	v_save := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_save <> 'ok' then raise exception 'I: the post % and the save %', v_post, v_save; end if;
	if (select name from public.qorpera_company_rooms where id = '66100000-0000-4000-8000-0000000000e2') <> 'G2 renamed'
		or not exists (select 1 from public.qorpera_session_inputs i join public.qorpera_company_rooms r on r.session_id = i.session_id
			where r.id = '66100000-0000-4000-8000-0000000000e2' and i.body ->> 'text' = 'Rename race') then
		raise exception 'I: both must have landed'; end if;
end $$;

-- J. A save changing a group chat's members while a post waits at its conversation, past its recheck: the save waits
-- for the post at the room, so the post lands with the members it read, then the save lands. An agent leaving, then the
-- poster leaving. (With the room KEY SHARE the save landed first and the post refused at its wake with 42501.)
select set_config('qorpera_test.drop_agent', pg_temp.sql_save('member-actions-drop-agent-0001', jsonb_build_array(
	pg_temp.edit_group('g3', '66100000-0000-4000-8000-0000000000e3', 'G3',
		array['64800000-0000-4000-8000-0000000000c0', '66100000-0000-4000-8000-0000000000b0']::uuid[],
		array['64800000-0000-4000-8000-000000000001']::uuid[]))), false) \g /dev/null
do $$
declare v_post text; v_save text; v_wakes integer;
begin
	perform pg_temp.hold_conversation('66100000-0000-4000-8000-0000000000e3');
	perform dblink_send_query('fence_two', pg_temp.sql_group_post('66100000-0000-4000-8000-0000000000e3', 'Agent leaves'));
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'J: the post must wait at the conversation'; end if;
	perform dblink_send_query('fence_one', current_setting('qorpera_test.drop_agent'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'J: the agent''s removal must wait for the post'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	v_save := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_save <> 'ok' then raise exception 'J: the post % and the agent''s removal %', v_post, v_save; end if;
	select count(*) into v_wakes from public.qorpera_wake_occurrences w join public.qorpera_session_inputs i on i.id = w.source_id
	where w.wake_kind = 'room' and i.body ->> 'text' = 'Agent leaves';
	if v_wakes <> 3 or (select status from public.qorpera_company_room_members where room_id = '66100000-0000-4000-8000-0000000000e3'
			and principal_kind = 'staff_agent' and principal_id = '64800000-0000-4000-8000-0000000000a1') <> 'removed' then
		raise exception 'J: the post must wake the three agents it read, then Ada leaves (% wakes)', v_wakes; end if;
end $$;
select set_config('qorpera_test.drop_poster', pg_temp.sql_save('member-actions-drop-poster-0001', jsonb_build_array(
	pg_temp.edit_group('g1', '66100000-0000-4000-8000-0000000000e1', 'G1 renamed',
		array['64800000-0000-4000-8000-0000000000c0', '64800000-0000-4000-8000-0000000000a1']::uuid[],
		array['64800000-0000-4000-8000-000000000002']::uuid[]))), false) \g /dev/null
do $$
declare v_post text; v_save text;
begin
	perform pg_temp.hold_conversation('66100000-0000-4000-8000-0000000000e1');
	perform dblink_send_query('fence_two', pg_temp.sql_group_post('66100000-0000-4000-8000-0000000000e1', 'Poster leaves'));
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'J: the post must wait at the conversation'; end if;
	perform dblink_send_query('fence_one', current_setting('qorpera_test.drop_poster'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'J: the poster''s removal must wait for the post'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	v_save := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_save <> 'ok' then raise exception 'J: the post % and the poster''s removal %', v_post, v_save; end if;
	if (select status from public.qorpera_company_room_members where room_id = '66100000-0000-4000-8000-0000000000e1'
			and principal_kind = 'member' and principal_id = '64800000-0000-4000-8000-000000000001') <> 'removed' then
		raise exception 'J: the poster must leave after the post'; end if;
end $$;

-- K. The operation clock before admission: a coworker message holds its conversations and waits at the clock; a post
-- in G2 waits at the clock too, holding no admission; both land once the clock is free. (A post taking admission first
-- would wait for the clock the message then holds, while the message waits for its admission: a deadlock.)
do $$
declare v_post text; v_message text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('clock-order-1'));
	if not pg_temp.waits_for('fence_one', 'fence_three')
		or not pg_temp.waits_at('fence_one', 'public.qorpera_profile_operation_clocks') then
		raise exception 'K: the message must wait at the clock'; end if;
	perform dblink_send_query('fence_two', pg_temp.sql_group_post('66100000-0000-4000-8000-0000000000e2', 'Clock order'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then
		raise exception 'K: the post must wait at the clock'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_folder_admissions
			where profile_id = '64800000-0000-4000-8000-000000000010' for no key update$q$) then
		raise exception 'K: the post must hold no admission while it waits at the clock'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_message := pg_temp.outcome('fence_one');
	v_post := pg_temp.outcome('fence_two');
	if v_message <> 'ok' or v_post <> 'ok' then raise exception 'K: the message % and the post %', v_message, v_post; end if;
end $$;

-- L. A room delivery's retry in a group chat while a save removes its author from the chat: the retry holds the room FOR
-- SHARE, as a post does, so the save waits for it; the retry lands with its wake, then the save. The failed run of the
-- Co-Founder's wake from J's post in G3 (hand-built, committed, as H's).
set session_replication_role = replica;
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run uuid := '66100000-0000-4000-8000-0000000000f3';
	v_job uuid := '66100000-0000-4000-8000-0000000000f4';
begin
	select w.* into strict v_wake from public.qorpera_wake_occurrences w join public.qorpera_session_inputs i on i.id = w.source_id
	where w.wake_kind = 'room' and i.body ->> 'text' = 'Agent leaves' and w.staff_agent_id = '64800000-0000-4000-8000-0000000000c0';
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, finished_at, run_id)
	values (v_job, v_wake.profile_id, v_wake.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn',
		'agent_turn', '{}', v_wake.requested_by_user_id, 'failed', clock_timestamp(), v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_wake.profile_id, v_wake.environment_id, 'room_delivery', v_wake.id, v_job, extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), v_wake.staff_agent_id, 1, v_wake.sponsor_binding_id, v_wake.sponsor_version, 'agent_turn',
		'agent_turn', repeat('c', 64), 0, v_wake.requested_by_user_id, v_wake.requested_by_user_id, 'openai', 'gpt-test',
		'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), v_wake.session_id, '{}');
	update public.qorpera_wake_occurrences set run_id = v_run, status = 'materialized' where id = v_wake.id;
end $$;
set session_replication_role = origin;
select set_config('qorpera_test.drop_author', pg_temp.sql_save('member-actions-drop-author-0001', jsonb_build_array(
	pg_temp.edit_group('g3', '66100000-0000-4000-8000-0000000000e3', 'G3',
		array['64800000-0000-4000-8000-0000000000c0', '66100000-0000-4000-8000-0000000000b0']::uuid[],
		array['64800000-0000-4000-8000-000000000002']::uuid[]))), false) \g /dev/null
do $$
declare v_retry text; v_save text;
begin
	perform pg_temp.hold_conversation('66100000-0000-4000-8000-0000000000e3');
	perform dblink_send_query('fence_two', $q$select public.qorpera_retry_room_delivery('66100000-0000-4000-8000-0000000000f3',
		'64800000-0000-4000-8000-0000000000b1', 1)::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'L: the retry must wait at the conversation'; end if;
	perform dblink_send_query('fence_one', current_setting('qorpera_test.drop_author'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'L: the author''s removal must wait for the retry'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_retry := pg_temp.outcome('fence_two');
	v_save := pg_temp.outcome('fence_one');
	if v_retry <> 'ok' or v_save <> 'ok' then raise exception 'L: the retry % and the author''s removal %', v_retry, v_save; end if;
	if not exists (select 1 from public.qorpera_wake_occurrences where occurrence_key like 'room:66100000-0000-4000-8000-0000000000e3:%:retry:%') then
		raise exception 'L: the retry''s wake must exist'; end if;
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
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
