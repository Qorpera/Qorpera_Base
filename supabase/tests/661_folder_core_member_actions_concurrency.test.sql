-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6): a member's post
-- meets a coworker message at the conversation, in both orders; a post waits for a company-row holder at rank 0 holding
-- no room, and never waits for a KEY SHARE holder; a room whose agents change while a post waits refuses as a
-- retryable conflict; two posts in one room queue at the conversation; a member's own rule and an agent's rule for that
-- member meet at the member's row; an email draft never waits for the company row; a stop waits for a post in flight; a
-- retry never waits for a company-row KEY SHARE holder. 648's committed fixture, removed at the end.

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
-- SHARE, so they meet at the conversation FOR UPDATE, and nothing waits in a circle.
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
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
