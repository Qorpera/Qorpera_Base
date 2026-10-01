-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3b under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.3): an answer to a
-- card, an email draft's completion, the broker's replayed claim of one, and an answer to an action-review card each
-- wait at the agent's thread room, behind a holder of it FOR UPDATE (an agent's rename), before they take the
-- conversation; both answers wait at the operation clock holding no admission, beside a member's post. Cards are
-- raised by hand in the agents' threads, for the owner. 648's committed fixture, removed at the end.

-- The company's login pays for unattended work (as 661's).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;
select set_config('qorpera_test.cf_room', id::text, false), set_config('qorpera_test.cf_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null
select dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);

select set_config('qorpera_test.ada_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000a1' \g /dev/null

-- A card in an agent's thread (the Co-Founder's unless named), raised for the owner (by hand, committed).
create function pg_temp.raise_card(p_event uuid, p_type text, p_data jsonb, p_session uuid default null) returns void language plpgsql as $$
declare v_session uuid := coalesce(p_session, current_setting('qorpera_test.cf_thread')::uuid);
begin
	insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at)
	select v_session, coalesce(max(sequence), 0) + 1, p_event, p_type,
		'64800000-0000-4000-8000-000000000001', jsonb_build_object('entry', jsonb_build_object('data', p_data)), repeat('c', 64),
		statement_timestamp()
	from public.qorpera_session_events where session_id = v_session;
end $$;
create function pg_temp.sql_answer(p_event uuid, p_value text, p_session uuid default null) returns text language sql as $$
	select format('select public.qorpera_answer_interaction(%L, %L, %L, %L, %L, %L, 1)::text',
		coalesce(p_session, current_setting('qorpera_test.cf_thread')::uuid), extensions.gen_random_uuid(), p_event, 'answered',
		jsonb_build_object('values', jsonb_build_array(p_value)), '64800000-0000-4000-8000-0000000000b1')
$$;
create function pg_temp.question() returns jsonb language sql as $$
	select '{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}'::jsonb
$$;
-- A holder of the Co-Founder's thread room FOR UPDATE, as an agent's rename takes it (or in another mode).
create function pg_temp.hold_room(p_mode text default 'update') returns void language plpgsql as $$
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_company_rooms where id = %L for ' || p_mode,
		current_setting('qorpera_test.cf_room'))) as t(x integer);
end $$;
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
create function pg_temp.thread_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_shared_sessions where id = %L for update', current_setting('qorpera_test.cf_thread')))
$$;
create function pg_temp.wakes_on_answer(p_event uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences w join public.qorpera_session_inputs i on i.id = w.source_id
	where w.wake_kind = 'room' and i.body ->> 'interactionId' = p_event::text
$$;

-- A. An answer to a card waits at the thread room behind its holder, holding no conversation, then lands with its wake.
-- It takes the room FOR SHARE, as a post does, so a FOR NO KEY UPDATE holder (a change of the room's members) makes it
-- wait too.
select pg_temp.raise_card('66300000-0000-4000-8000-0000000000a1', 'interaction_request', pg_temp.question()) \g /dev/null
select pg_temp.raise_card('66300000-0000-4000-8000-0000000000a2', 'interaction_request', pg_temp.question()) \g /dev/null
do $$
declare v_state text;
begin
	perform pg_temp.hold_room('no key update');
	perform dblink_send_query('fence_two', pg_temp.sql_answer('66300000-0000-4000-8000-0000000000a2', 'finance'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_rooms') then
		raise exception 'A: the answer must wait for a FOR NO KEY UPDATE holder of the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'A: the answer after a FOR NO KEY UPDATE holder: %', v_state; end if;
	perform pg_temp.hold_room();
	perform dblink_send_query('fence_two', pg_temp.sql_answer('66300000-0000-4000-8000-0000000000a1', 'general'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_rooms') then raise exception 'A: the answer must wait at the room'; end if;
	if not pg_temp.thread_free() then raise exception 'A: the answer must hold no conversation while it waits at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.wakes_on_answer('66300000-0000-4000-8000-0000000000a1') <> 1 then
		raise exception 'A: the answer after the room: %', v_state; end if;
end $$;

-- B. An email draft's completion (the secret broker) waits at the thread room before its own conversation lock, then
-- records the sent email, and its answer reaches the agent.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('66300000-0000-4000-8000-0000000000b0', '64800000-0000-4000-8000-000000000010', 'https://broker.example.test', 'test', repeat('a', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id, secret_name, purpose,
	current_version, created_by_user_id, account_label)
values ('66300000-0000-4000-8000-0000000000b9', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'66300000-0000-4000-8000-0000000000b0', 'company', 'gmail', 'primary', 'Email', 1, '64800000-0000-4000-8000-000000000001',
	'sender@example.test');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
values ('66300000-0000-4000-8000-0000000000b9', 1, '66300000-0000-4000-8000-0000000000b0', 'test', decode('abcd', 'hex'), repeat('b', 64),
	'64800000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(profile_id, environment_id, secret_id, staff_agent_id, connector_id, operation_id,
	operation_version, tool_name, issued_by_user_id)
select '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '66300000-0000-4000-8000-0000000000b9',
	'64800000-0000-4000-8000-0000000000c0', 'gmail', operation_id, version, tool_name, '64800000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and status = 'active';
select pg_temp.raise_card('66300000-0000-4000-8000-0000000000b1', 'interaction_request', '{"schema":"qorpera.interaction/v1","surface":"draft",'
	'"title":"New email","payload":{"platform":"email","connectorId":"gmail","from":"sender@example.test","to":["bob@example.test"],'
	'"subject":"Moved","body":"We moved."}}') \g /dev/null
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}', false) \g /dev/null
select public.qorpera_get_email_draft(current_setting('qorpera_test.cf_thread')::uuid, '66300000-0000-4000-8000-0000000000b1') \g /dev/null
select public.qorpera_prepare_email_draft_action(current_setting('qorpera_test.cf_thread')::uuid, '66300000-0000-4000-8000-0000000000b1',
	'66300000-0000-4000-8000-0000000000b2', 'send', '{"to":["bob@example.test"],"cc":[],"subject":"Moved","body":"We moved."}', repeat('d', 64),
	'64800000-0000-4000-8000-0000000000b1', 1) \g /dev/null
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
set session authorization qorpera_secret_broker;
select public.qorpera_claim_email_draft_action('66300000-0000-4000-8000-0000000000b0', repeat('a', 64), '66300000-0000-4000-8000-0000000000b2',
	repeat('d', 64)) \g /dev/null
reset session authorization;
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'set session authorization qorpera_secret_broker');
	perform pg_temp.hold_room();
	perform dblink_send_query('fence_one', $q$select public.qorpera_finish_email_draft_action('66300000-0000-4000-8000-0000000000b0',
		repeat('a', 64), '66300000-0000-4000-8000-0000000000b2', repeat('d', 64), '{"message_id":"gmail1"}')::text$q$);
	if not pg_temp.waits_at('fence_one', 'public.qorpera_company_rooms') then raise exception 'B: the completion must wait at the room'; end if;
	if not pg_temp.thread_free() then raise exception 'B: the completion must hold no conversation while it waits at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	perform dblink_exec('fence_one', 'reset session authorization');
	if v_state <> 'ok' or (select status from public.qorpera_member_email_drafts where interaction_id = '66300000-0000-4000-8000-0000000000b1') <> 'sent'
		or pg_temp.wakes_on_answer('66300000-0000-4000-8000-0000000000b1') <> 1 then
		raise exception 'B: the completion after the room: %', v_state; end if;
end $$;

-- E. The broker's claim of B's action, already completed, replays the completion: it too waits at the thread room
-- before its conversation lock (a replay after the lock met an agent's rename in a cycle). The replay adds no answer.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'set session authorization qorpera_secret_broker');
	perform pg_temp.hold_room();
	perform dblink_send_query('fence_one', $q$select public.qorpera_claim_email_draft_action('66300000-0000-4000-8000-0000000000b0',
		repeat('a', 64), '66300000-0000-4000-8000-0000000000b2', repeat('d', 64))::text$q$);
	if not pg_temp.waits_at('fence_one', 'public.qorpera_company_rooms') then raise exception 'E: the replayed claim must wait at the room'; end if;
	if not pg_temp.thread_free() then raise exception 'E: the replayed claim must hold no conversation while it waits at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	perform dblink_exec('fence_one', 'reset session authorization');
	if v_state <> 'ok' or pg_temp.wakes_on_answer('66300000-0000-4000-8000-0000000000b1') <> 1 then
		raise exception 'E: the replayed claim after the room: %', v_state; end if;
end $$;

-- C. An answer to an action-review card waits at the thread room before the conversation and the review, then wakes
-- the agent. The review is hand-built on Ada's run, waiting for the owner.
set session_replication_role = replica;
insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id, session_id, requester_user_id, tool_name, effect,
	argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, approver_user_id, card_session_id)
values ('66300000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000f1', 'call-race',
	'64800000-0000-4000-8000-0000000000c0', current_setting('qorpera_test.cf_thread')::uuid, '64800000-0000-4000-8000-000000000001',
	'send_email', 'external', repeat('d', 64), '{"title":"Send an email"}', 'ask', 'none', 'The reviewer is unsure.', 'gpt-6-luna', 'member',
	'64800000-0000-4000-8000-000000000001', current_setting('qorpera_test.cf_thread')::uuid);
set session_replication_role = origin;
do $$
declare v_state text;
begin
	perform pg_temp.hold_room();
	perform dblink_send_query('fence_two', format('select public.qorpera_answer_action_review(%L, %L, %L, null, %L, 1)::text',
		'66300000-0000-4000-8000-0000000000c1', extensions.gen_random_uuid(), 'allow_once', '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_rooms') then raise exception 'C: the review answer must wait at the room'; end if;
	if not pg_temp.thread_free() then raise exception 'C: the review answer must hold no conversation while it waits at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.wakes_on_answer('66300000-0000-4000-8000-0000000000c1') <> 1 then
		raise exception 'C: the review answer after the room: %', v_state; end if;
end $$;

-- D. The operation clock before admission: a member's post into the Co-Founder's thread holds that conversation and
-- waits at the clock; an answer in Ada's thread waits behind it at the clock, holding no admission; both land.
-- (Admission first would wait for the clock the post then holds, while the post waits for its admission: a deadlock.)
-- The two write different conversations, so they meet only at the clock.
select pg_temp.raise_card('66300000-0000-4000-8000-0000000000d1', 'interaction_request', pg_temp.question(),
	current_setting('qorpera_test.ada_thread')::uuid) \g /dev/null
do $$
declare v_post text; v_answer text;
begin
	perform dblink_exec('fence_one', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text',
		current_setting('qorpera_test.cf_room'), extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Clock order'), '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_for('fence_one', 'fence_three') or not pg_temp.waits_at('fence_one', 'public.qorpera_profile_operation_clocks') then
		raise exception 'D: the post must wait at the clock'; end if;
	perform dblink_send_query('fence_two', pg_temp.sql_answer('66300000-0000-4000-8000-0000000000d1', 'finance',
		current_setting('qorpera_test.ada_thread')::uuid));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then raise exception 'D: the answer must wait at the clock'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_folder_admissions
			where profile_id = '64800000-0000-4000-8000-000000000010' for no key update$q$) then
		raise exception 'D: the answer must hold no admission while it waits at the clock'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_one');
	v_answer := pg_temp.outcome('fence_two');
	if v_post <> 'ok' or v_answer <> 'ok' then raise exception 'D: the post % and the answer %', v_post, v_answer; end if;
end $$;

-- D2. The same order for an answer to an action-review card in Ada's thread (hand-built, as C's).
set session_replication_role = replica;
insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id, session_id, requester_user_id, tool_name, effect,
	argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, approver_user_id, card_session_id)
values ('66300000-0000-4000-8000-0000000000d2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000f1', 'call-clock',
	'64800000-0000-4000-8000-0000000000a1', current_setting('qorpera_test.ada_thread')::uuid, '64800000-0000-4000-8000-000000000001',
	'send_email', 'external', repeat('d', 64), '{"title":"Send an email"}', 'ask', 'none', 'The reviewer is unsure.', 'gpt-6-luna', 'member',
	'64800000-0000-4000-8000-000000000001', current_setting('qorpera_test.ada_thread')::uuid);
set session_replication_role = origin;
do $$
declare v_post text; v_answer text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text',
		current_setting('qorpera_test.cf_room'), extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Clock order 2'), '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_for('fence_one', 'fence_three') or not pg_temp.waits_at('fence_one', 'public.qorpera_profile_operation_clocks') then
		raise exception 'D2: the post must wait at the clock'; end if;
	perform dblink_send_query('fence_two', format('select public.qorpera_answer_action_review(%L, %L, %L, null, %L, 1)::text',
		'66300000-0000-4000-8000-0000000000d2', extensions.gen_random_uuid(), 'allow_once', '64800000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then
		raise exception 'D2: the review answer must wait at the clock'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_folder_admissions
			where profile_id = '64800000-0000-4000-8000-000000000010' for no key update$q$) then
		raise exception 'D2: the review answer must hold no admission while it waits at the clock'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_one');
	v_answer := pg_temp.outcome('fence_two');
	if v_post <> 'ok' or v_answer <> 'ok' or pg_temp.wakes_on_answer('66300000-0000-4000-8000-0000000000d2') <> 1 then
		raise exception 'D2: the post % and the review answer %', v_post, v_answer; end if;
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
	delete from public.qorpera_member_email_actions where interaction_id = '66300000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_member_email_drafts where interaction_id = '66300000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_cloud_secret_operation_grants where secret_id = '66300000-0000-4000-8000-0000000000b9';
	delete from public.qorpera_cloud_secret_versions where secret_id = '66300000-0000-4000-8000-0000000000b9';
	delete from public.qorpera_cloud_secrets where id = '66300000-0000-4000-8000-0000000000b9';
	delete from public.qorpera_cloud_secret_broker_authorities where id = '66300000-0000-4000-8000-0000000000b0';
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
		or exists (select 1 from public.qorpera_cloud_secret_broker_authorities where id = '66300000-0000-4000-8000-0000000000b0') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
