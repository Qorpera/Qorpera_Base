-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's Stop in an agent's thread reaches every run of the agent's there, on folder-v2 (ported from snapshot-v1 in
-- the legacy sweep; 20260926183100): a routine run (a wake run), a member's post (a room delivery) and the answer to a
-- coworker message (a wake run). The runs are real: Bob's routine file saved by the owner and its slot queued by the
-- scheduler, members' posts, and a coworker message from the base's run of Alice's, each turned into a run by the folder
-- materializer and started on a real runner with a native lease. Authority is a member turn's: the member may write the
-- conversation and created the run's job (posted the message, saved the routine, started the chain) or is an owner or
-- admin. The read offers a run the member may stop before one they may not, then the working one.

-- The contributor's own native login and member sponsor, as the base makes the owner's: a post spends only the
-- poster's own login. Answers the sponsor's binding.
create function pg_temp.ms_member_binding() returns uuid language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_identity jsonb; v_login jsonb; v_connection jsonb;
	v_sponsor jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity('92400000-0000-4000-8000-000000000010',
		'37800000-0000-4000-8000-000000000050', 'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login('92400000-0000-4000-8000-000000000010',
		'37800000-0000-4000-8000-000000000051', '37800000-0000-4000-8000-000000000052',
		(v_identity ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('c', 64), 900);
	reset role;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat('c', 64),
		'37800000-0000-4000-8000-000000000060', 'object://native-capsules/37800000-0000-4000-8000-000000000060', repeat('d', 64),
		'fixture-member-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_sponsor := public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
		'37800000-0000-4000-8000-000000000061', (v_connection ->> 'connection_id')::uuid, 1, false);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return (v_sponsor ->> 'binding_id')::uuid;
end $$;
-- An agent's thread conversation.
create function pg_temp.ms_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- What a member reads of a conversation's run control.
create function pg_temp.ms_read(p_session uuid) returns jsonb language sql as $$
	select public.qorpera_get_session_run_control(p_session) -> 'run'
$$;
create function pg_temp.ms_denied(p_session uuid, p_run uuid) returns void language sql as $$
	select pg_temp.base_error(format('select public.qorpera_cancel_session_run(%L, %L)', p_session, p_run), '42501',
		'cloud run cancellation is not allowed')
$$;
-- A routine's parse as the TS parser returns it (as 708 writes one).
create function pg_temp.ms_routine_parse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Tick', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 60, 'starts', null), 'timezone', null, 'ends', null, 'runs', null,
		'quiet', null, 'effort', 'low', 'reply', 'required', 'conclusion', null, 'instructions', 'Examine the authorized change.')
$$;

-- Bob's routine, saved by the owner in his folder; the scheduler queues its slot into Bob's thread, and the materializer
-- makes it a queued wake run, made for the member who saved the routine.
select pg_temp.base_commit(pg_temp.base_owner(), 'ms-routine-0001', jsonb_build_array(pg_temp.base_write('agents/bob/routines/tick.md',
	'routine', E'---\n' || pg_temp.ms_routine_parse('37800000-0000-4000-8000-0000000000e1')::text || E'\n---\n',
	pg_temp.ms_routine_parse('37800000-0000-4000-8000-0000000000e1')))) \g /dev/null
do $$
declare v_slot timestamptz := clock_timestamp(); v_enqueued jsonb; v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_claims('service_role');
	v_enqueued := public.qorpera_enqueue_routine_wake('37800000-0000-4000-8000-0000000000e1', 1, '37800000-0000-4000-8000-0000000000f1',
		'ms-1', 'file', v_slot, null, v_slot + interval '1 hour');
	perform pg_temp.base_assert(v_enqueued ->> 'status' = 'queued', 'Fixture: the routine''s slot is queued: ' || v_enqueued::text);
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = '37800000-0000-4000-8000-0000000000f1' and status = 'materialized'
		and session_id = pg_temp.ms_session('92400000-0000-4000-8000-000000000031');
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_run) and (select run.source_kind = 'wake'
		and job.created_by_user_id = '92400000-0000-4000-8000-000000000001' and job.status = 'queued'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_run),
		'Fixture: the routine run is a queued wake run, made for the member who saved the routine');
	perform set_config('qorpera_test.ms_run', v_run::text, true);
	perform set_config('qorpera_test.ms_thread', pg_temp.ms_session('92400000-0000-4000-8000-000000000031')::text, true);
end $$;
-- A group chat with Bob and Carol, saved by the owner (as 777's chats are): another conversation with the same agent.
select pg_temp.base_commit(pg_temp.base_owner(), 'ms-chat-0001', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/groups'),
	jsonb_build_object('op', 'new_folder', 'path', 'agents/groups/launch', 'contents', jsonb_build_array(jsonb_build_object('path', 'group.md',
		'kind', 'file', 'file', pg_temp.base_stage(E'---\nid: 37800000-0000-4000-8000-0000000000c1\nname: Launch\nagents:\n  - 92400000-0000-4000-8000-000000000031\n  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n'))),
	'structured', jsonb_build_array(jsonb_build_object('path', 'agents/groups/launch/group.md', 'kind', 'group',
		'text', E'---\nid: 37800000-0000-4000-8000-0000000000c1\nname: Launch\nagents:\n  - 92400000-0000-4000-8000-000000000031\n  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n',
		'parse', jsonb_build_object('kind', 'group', 'id', '37800000-0000-4000-8000-0000000000c1', 'name', 'Launch', 'subtitle', null,
			'agents', jsonb_build_array('92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032'), 'people', jsonb_build_array('92400000-0000-4000-8000-000000000001'),
			'purpose', 'Plan the launch.'), 'parserVersion', 1))))) \g /dev/null
do $$
declare v_chat uuid;
begin
	select room.session_id into strict v_chat from public.qorpera_company_rooms room
	join public.qorpera_company_room_members agent on agent.room_id = room.id and agent.principal_kind = 'staff_agent'
		and agent.principal_id = '92400000-0000-4000-8000-000000000031' and agent.status = 'active'
	where room.profile_id = '92400000-0000-4000-8000-000000000010' and room.bound_staff_agent_id is null and room.status = 'active';
	perform set_config('qorpera_test.ms_chat', v_chat::text, true);
	perform set_config('qorpera_test.ms_carol', pg_temp.ms_session('92400000-0000-4000-8000-000000000032')::text, true);
end $$;

-- 1. The owner sees the queued routine run in Bob's thread and may stop it. Only that conversation: neither Bob's group
--    chat nor Carol's thread shows the run or stops it, and Bob's thread neither shows nor stops Bob's own run in the
--    group chat.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_run'), 'status', 'queued', 'can_cancel', true), 'The run control shows the routine run');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_chat')::uuid) = 'null'::jsonb,
	'Another conversation with the same agent does not show the run');
select pg_temp.ms_denied(current_setting('qorpera_test.ms_chat')::uuid, current_setting('qorpera_test.ms_run')::uuid);
select pg_temp.ms_denied(current_setting('qorpera_test.ms_carol')::uuid, current_setting('qorpera_test.ms_run')::uuid);
-- A run of Bob's in the group chat: the same agent in another conversation, so only the exact-conversation fence keeps
-- Bob's thread from it. The owner's post there names Bob, the materializer makes Bob's chat run, and Bob's thread neither
-- shows it nor stops it. Rolled back, so the sections below see no chat run.
do $$
declare v_result jsonb; v_chat_run uuid; v_room uuid;
begin
	begin
		reset role;
		select id into strict v_room from public.qorpera_company_rooms where session_id = current_setting('qorpera_test.ms_chat')::uuid;
		perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
		set local role authenticated;
		v_result := public.qorpera_post_company_room_message(v_room, extensions.gen_random_uuid(),
			jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', '@Bob, is the launch list ready?'),
			(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
		reset role;
		perform pg_temp.base_materialize();
		select occurrence.run_id into strict v_chat_run from public.qorpera_wake_occurrences occurrence
		join public.qorpera_execution_runs run on run.id = occurrence.run_id
		where occurrence.id in (select jsonb_array_elements_text(v_result -> 'occurrenceIds')::uuid)
			and occurrence.staff_agent_id = '92400000-0000-4000-8000-000000000031' and occurrence.status = 'materialized'
			and run.session_id = current_setting('qorpera_test.ms_chat')::uuid
			and run.staff_agent_id = '92400000-0000-4000-8000-000000000031';
		perform pg_temp.base_assert((select job.status = 'queued' from public.qorpera_execution_runs run
			join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_chat_run), 'Bob''s chat run is queued');
		-- The chat run's job made older than the routine run's: the read orders the agent's runs by when their jobs were
		-- made, so without the conversation fence it would show the chat run.
		update public.qorpera_runner_jobs set created_at = (select job.created_at - interval '1 minute'
			from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
			where run.id = current_setting('qorpera_test.ms_run')::uuid)
		where id = (select job_id from public.qorpera_execution_runs where id = v_chat_run);
		perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
		set local role authenticated;
		perform pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) ->> 'run_id'
			= current_setting('qorpera_test.ms_run'), 'Bob''s thread still shows its own run, not Bob''s chat run');
		perform pg_temp.ms_denied(current_setting('qorpera_test.ms_thread')::uuid, v_chat_run);
		raise exception using errcode = 'QTR78', message = 'the chat run is rolled back';
	exception when sqlstate 'QTR78' then null;
	end;
end $$;

-- 2. A contributor who did not save the routine and a viewer see the run and cannot stop it; an outsider reads nothing
--    and cannot stop it by a remembered id.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) ->> 'can_cancel' = 'false',
	'A contributor cannot stop a routine run another member set up');
select pg_temp.ms_denied(current_setting('qorpera_test.ms_thread')::uuid, current_setting('qorpera_test.ms_run')::uuid);
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) ->> 'can_cancel' = 'false',
	'A viewer cannot stop a routine run');
select pg_temp.ms_denied(current_setting('qorpera_test.ms_thread')::uuid, current_setting('qorpera_test.ms_run')::uuid);
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error(format('select public.qorpera_get_session_run_control(%L)', current_setting('qorpera_test.ms_thread')), '42501',
	'cloud conversation is unavailable');
select pg_temp.ms_denied(current_setting('qorpera_test.ms_thread')::uuid, current_setting('qorpera_test.ms_run')::uuid);
reset role;
select pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.ms_run')::uuid),
	'Refused Stops leave the run queued');

-- The routine run starts: it holds a runner lease and a native provider lease.
select set_config('qorpera_test.ms_binding', pg_temp.base_start(current_setting('qorpera_test.ms_run')::uuid)::text, true) \g /dev/null

-- 3. Members' own messages in the thread are room posts, and their runs are stoppable too. While the routine run works,
--    the owner is offered the working run; a contributor is offered their own queued message and may not stop another's.
savepoint ms_member_messages;
select set_config('qorpera_test.ms_member_binding', pg_temp.ms_member_binding()::text, true) \g /dev/null
do $$
declare v_pass jsonb; v_owner uuid; v_own uuid;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Bob, also check the invoices.');
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000031', 'And the receipts.',
		current_setting('qorpera_test.ms_member_binding')::uuid);
	v_pass := pg_temp.base_materialize();
	select run.id into strict v_owner from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
	where run.id in (select (jsonb_array_elements_text(v_pass -> 'run_ids'))::uuid) and job.created_by_user_id = '92400000-0000-4000-8000-000000000001';
	select run.id into strict v_own from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
	where run.id in (select (jsonb_array_elements_text(v_pass -> 'run_ids'))::uuid) and job.created_by_user_id = '92400000-0000-4000-8000-000000000002';
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 2 and (select bool_and(run.source_kind = 'room_delivery'
		and run.session_id = current_setting('qorpera_test.ms_thread')::uuid and job.status = 'queued')
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id in (v_owner, v_own)),
		'Fixture: both messages in Bob''s thread are queued room deliveries: ' || v_pass::text);
	perform set_config('qorpera_test.ms_post_run', v_owner::text, true);
	perform set_config('qorpera_test.ms_own_run', v_own::text, true);
end $$;
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_run'), 'status', 'leased', 'can_cancel', true),
	'An owner is offered the run the agent is working on');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.ms_denied(current_setting('qorpera_test.ms_thread')::uuid, current_setting('qorpera_test.ms_post_run')::uuid);
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_own_run'), 'status', 'queued', 'can_cancel', true),
	'A contributor is offered their own queued message, not the routine run they may not stop');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ms_thread')::uuid,
	current_setting('qorpera_test.ms_own_run')::uuid) ->> 'status' = 'cancelled', 'The contributor stops their own message');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_run'), 'status', 'leased', 'can_cancel', false),
	'Then the contributor sees the routine run, without a Stop');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ms_thread')::uuid,
	current_setting('qorpera_test.ms_post_run')::uuid) ->> 'status' = 'cancelled', 'The owner stops the reply to their own message');
reset role;
select pg_temp.base_assert((select array_agg(cancelled_by_user_id::text order by cancelled_by_user_id) from public.qorpera_runner_jobs
	where run_id in (current_setting('qorpera_test.ms_post_run')::uuid, current_setting('qorpera_test.ms_own_run')::uuid)
		and status = 'cancelled') = array['92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002']
	and (select status = 'leased' from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.ms_run')::uuid),
	'Each Stop cancelled exactly its own run');
rollback to savepoint ms_member_messages;

-- 4. The member who saved the routine, now a contributor, stops it while it works. (The last founder cannot step down
--    while others remain: a new founder joins first.)
insert into auth.users(id, email) values ('37800000-0000-4000-8000-000000000008', 'ms-owner@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('92400000-0000-4000-8000-000000000010', '37800000-0000-4000-8000-000000000008', 'ms-owner@example.test', 'New owner', 'owner');
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_run'), 'status', 'leased', 'can_cancel', true),
	'The working routine run is stoppable by the contributor who saved the routine');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ms_thread')::uuid,
	current_setting('qorpera_test.ms_run')::uuid) = jsonb_build_object('session_id', current_setting('qorpera_test.ms_thread'),
	'run_id', current_setting('qorpera_test.ms_run'), 'status', 'cancelled'), 'Stop confirms the cancelled routine run');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = 'null'::jsonb,
	'The conversation has no run after Stop');
-- A lost receipt's retry reads back; it never repeats the cancellation.
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ms_thread')::uuid,
	current_setting('qorpera_test.ms_run')::uuid) ->> 'status' = 'cancelled', 'A retried Stop reads back the cancelled run');
reset role;

-- 5. The kernel's cancellation: the member is recorded (a dynamic routine pauses on exactly this), the runner and native
--    leases lose their authority, the routine's occurrence ends cancelled while the routine keeps its schedule, and the
--    agent reads as idle, not failed.
select pg_temp.base_assert((select status = 'cancelled' and cancelled_by_user_id = '92400000-0000-4000-8000-000000000001'
	and lease_token_sha256 is null and lease_expires_at is null
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.ms_run')::uuid),
	'Stop cancels the job, records the member and drops the runner lease');
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_runner_audit_receipts receipt
	join public.qorpera_runner_jobs job on job.id = receipt.job_id
	where job.run_id = current_setting('qorpera_test.ms_run')::uuid and receipt.event_type = 'job_cancelled'),
	'The retry did not repeat the cancellation');
select pg_temp.base_assert((select status = 'revoked' and released_at is not null from public.qorpera_native_provider_connection_leases
	where id = (current_setting('qorpera_test.ms_binding')::jsonb ->> 'leaseId')::uuid), 'Stop releases the run''s native provider lease');
select pg_temp.base_assert((select status = 'cancelled' from public.qorpera_wake_occurrences where id = '37800000-0000-4000-8000-0000000000f1'),
	'The routine occurrence ends cancelled');
select pg_temp.base_assert((select status = 'active' from public.qorpera_cloud_routines where id = '37800000-0000-4000-8000-0000000000e1'),
	'A scheduled routine keeps its schedule after one run is stopped');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(
	public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020')) activity
	where activity ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031'),
	'A stopped routine run is not shown as a failure to dismiss');

-- 6. The same Stop ends an agent's answer to a coworker message, the member brake on a loop between two agents
--    (contract 14.6): Alice's run messages Bob, which wakes him in his own thread, and the new owner, who did not start
--    that chain, stops the run there.
select pg_temp.base_claims('service_role');
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_send jsonb; v_run uuid; v_thread uuid;
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	v_send := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'ms-ask', 'Could you check the note?');
	perform pg_temp.base_materialize();
	select run_id, session_id into strict v_run, v_thread from public.qorpera_wake_occurrences
	where id = (v_send ->> 'occurrenceId')::uuid and status = 'materialized';
	perform pg_temp.base_assert(v_thread = current_setting('qorpera_test.ms_thread')::uuid and (select staff_agent_id
		from public.qorpera_execution_runs where id = v_run) = '92400000-0000-4000-8000-000000000031',
		'Fixture: Bob answers in his own thread');
	perform set_config('qorpera_test.ms_peer_run', v_run::text, true);
end $$;
set local role authenticated;
select pg_temp.base_claims('authenticated', '37800000-0000-4000-8000-000000000008');
select pg_temp.base_assert(pg_temp.ms_read(current_setting('qorpera_test.ms_thread')::uuid) = jsonb_build_object(
	'run_id', current_setting('qorpera_test.ms_peer_run'), 'status', 'queued', 'can_cancel', true),
	'The owner sees the coworker wake in Bob''s thread and may stop it');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ms_thread')::uuid,
	current_setting('qorpera_test.ms_peer_run')::uuid) ->> 'status' = 'cancelled', 'The owner stops the coworker wake');
reset role;
select pg_temp.base_assert((select status = 'cancelled' and cancelled_by_user_id = '37800000-0000-4000-8000-000000000008'
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.ms_peer_run')::uuid),
	'The coworker wake is cancelled by the owner');

rollback;
