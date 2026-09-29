-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-3b (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.3): a member's answers on the folder
-- fence. An answer to an agent's card in its thread; plain conversations and group chats refusing; an email draft's
-- completion reaching the agent; an answer to an action-review card, waking the agent or joining a held call.
-- Snapshot-v1 keeps its text. Runs are 647's hand-built runs of agent A in its thread, for the owner. Races are in 663.

create function pg_temp.send(p_binding jsonb, p_key text) returns jsonb language sql as $$
	select public.qorpera_send_native_agent_message((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_key, 'Checking.', 'progress')
$$;
create function pg_temp.card(p_binding jsonb, p_event uuid, p_data jsonb default '{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
create function pg_temp.review(p_binding jsonb, p_call text) returns uuid language plpgsql as $$
begin
	perform public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'send_email',
		'effect', 'external', 'argumentSha256', repeat('d', 64),
		'action', jsonb_build_object('title', 'Send an email', 'target', 'bob@acme.test', 'details', jsonb_build_object('subject', 'Moved')),
		'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'The reviewer is unsure.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna'));
	return (select id from public.qorpera_action_reviews where run_id = (p_binding ->> 'runId')::uuid and call_id = p_call);
end $$;
-- A leased human run of agent A for the owner, in A's thread, acknowledged so it may raise cards; returns its binding.
create function pg_temp.owner_run(p_key text) returns jsonb language plpgsql as $$
declare b jsonb := pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001'));
begin
	perform pg_temp.send(b, p_key);
	return b;
end $$;
create function pg_temp.session_of(p_binding jsonb) returns uuid language sql as $$
	select session_id from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid
$$;
create function pg_temp.admitted() returns bigint language sql as $$
	select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010'
$$;
create function pg_temp.answer(p_session uuid, p_client uuid, p_event uuid, p_outcome text, p_answer jsonb) returns jsonb language sql as $$
	select public.qorpera_answer_interaction(p_session, p_client, p_event, p_outcome, p_answer, '63400000-0000-4000-8000-0000000000b1', 1)
$$;
create function pg_temp.answer_review(p_review uuid, p_client uuid, p_answer text) returns jsonb language sql as $$
	select public.qorpera_answer_action_review(p_review, p_client, p_answer, null, '63400000-0000-4000-8000-0000000000b1', 1)
$$;
-- The room wakes of agent A sourced on an input.
create function pg_temp.wakes_on(p_input uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where wake_kind = 'room' and source_id = p_input
		and staff_agent_id = '63400000-0000-4000-8000-0000000000a1' and status = 'queued'
$$;
create function pg_temp.events_on(p_session uuid, p_input uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_session_events where session_id = p_session and session_input_id = p_input
$$;
create function pg_temp.pause(p_on boolean) returns void language sql as $$
	select pg_temp.fx(case when p_on then 'insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values
		(''63400000-0000-4000-8000-000000000010'', ''63400000-0000-4000-8000-000000000001'', ''test'')'
		else 'delete from public.qorpera_company_execution_pauses where profile_id = ''63400000-0000-4000-8000-000000000010''' end)
$$;
-- A plain conversation in the folder company, the owner's.
select set_config('qorpera_test.plain', extensions.gen_random_uuid()::text, true) \g /dev/null
select pg_temp.fx(format($f$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, audience_kind)
	values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Plain', '63400000-0000-4000-8000-000000000001',
	'company')$f$, current_setting('qorpera_test.plain'))) \g /dev/null

-- 1. Snapshot-v1 keeps its text: each body with its patches reversed is the definition before this migration.
do $$
declare v_def text; c_plain constant text := 'This conversation does not serve folder-v2 companies yet';
begin
	v_def := pg_get_functiondef('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)'::regprocedure);
	v_def := replace(v_def, E'\tif public.qorpera_company_is_folder_v2(v_profile_id) then\n'
		|| E'\t\tif not public.qorpera_folder_enter_agent_thread(p_session_id, v_user_id) then\n'
		|| E'\t\t\tif exists (select 1 from public.qorpera_company_rooms as room where room.session_id = p_session_id) then\n'
		|| E'\t\t\t\traise exception ''cards are not answered in a group chat'' using errcode = ''22023''; end if;\n'
		|| E'\t\t\traise exception ''' || c_plain || E''' using errcode = ''0A000''; end if;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile_id);\n'
		|| E'\tend if;\n', E'\tperform public.qorpera_lock_profile_gc_fence(v_profile_id);\n');
	v_def := replace(v_def, E'\t\tif public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\t-- The transcript events (the operation clock), then admission, the last lock before the folder clock.\n'
		|| E'\t\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n'
		|| E'\t\t\tperform public.qorpera_folder_admit_wakes(v_room.profile_id);\n'
		|| E'\t\tend if;\n', '');
	v_def := replace(v_def, E'\t\tif not public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n'
		|| E'\t\tend if;\n', E'\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n');
	if md5(v_def) <> '11202d08f6486b20f9b39293c66c6eab' then raise exception 'The answer''s snapshot-v1 text changed'; end if;

	v_def := pg_get_functiondef('public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)'::regprocedure);
	v_def := replace(v_def, E'\tif public.qorpera_company_is_folder_v2(v_review.profile_id) then\n'
		|| E'\t\tif not public.qorpera_folder_enter_agent_thread(v_review.card_session_id, v_user) then\n'
		|| E'\t\t\traise exception ''' || c_plain || E''' using errcode = ''0A000''; end if;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_review.profile_id);\n'
		|| E'\tend if;\n', E'\tperform public.qorpera_lock_profile_gc_fence(v_review.profile_id);\n');
	v_def := replace(v_def, E'\t\t\tif public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\t\t-- The transcript events (the operation clock), then admission, the last lock before the folder clock.\n'
		|| E'\t\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n'
		|| E'\t\t\t\tperform public.qorpera_folder_admit_wakes(v_room.profile_id);\n'
		|| E'\t\t\tend if;\n', '');
	v_def := replace(v_def, E'\t\t\tif not public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n'
		|| E'\t\t\tend if;\n', E'\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n');
	if md5(v_def) <> 'a32672812df12b7607f8769e5959d8bc' then raise exception 'The review answer''s snapshot-v1 text changed'; end if;

	v_def := pg_get_functiondef('public.qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb)'::regprocedure);
	v_def := replace(v_def, E' if public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'  perform public.qorpera_folder_enter_agent_thread(d.session_id, d.user_id) from public.qorpera_member_email_drafts d\n'
		|| E'  join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id\n'
		|| E'  join public.qorpera_shared_sessions s on s.id=d.session_id where a.id=p_action_id and s.profile_id=v_profile;\n'
		|| E' end if;\n', '');
	if md5(v_def) <> '981da163ef5d23768e4403d48e0bce35' then raise exception 'The email completion''s snapshot-v1 text changed'; end if;
end $$;

-- 2. An answer to an agent's card in its thread: the input, the transcript events, admission and the agent's room wake;
-- a replay adds nothing, and still returns its receipt while the company is paused; a new answer then refuses.
do $$
declare b jsonb := pg_temp.owner_run('ack-question'); v_session uuid := pg_temp.session_of(b);
	v_event uuid := extensions.gen_random_uuid(); v_event2 uuid := extensions.gen_random_uuid(); v_before bigint := pg_temp.admitted();
	r jsonb; r2 jsonb;
begin
	if v_session is distinct from (select session_id from public.qorpera_company_rooms
			where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1') then
		raise exception 'The run must be in agent A''s thread'; end if;
	perform pg_temp.card(b, v_event);
	perform pg_temp.card(b, v_event2);
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select pg_temp.answer(%L, %L, %L, %L, %L)', v_session, extensions.gen_random_uuid(), v_event,
		'answered', '{"values":["nowhere"]}'), '22023', 'question answer is invalid');
	r := pg_temp.answer(v_session, '66200000-0000-4000-8000-0000000000c1', v_event, 'answered', '{"values":["general"]}');
	if pg_temp.wakes_on((r ->> 'input_id')::uuid) <> 1 or pg_temp.events_on(v_session, (r ->> 'input_id')::uuid) = 0
		or pg_temp.admitted() <> v_before + 1 then
		raise exception 'An answer in the thread: % (wakes %, events %, admitted % from %)', r, pg_temp.wakes_on((r ->> 'input_id')::uuid),
			pg_temp.events_on(v_session, (r ->> 'input_id')::uuid), pg_temp.admitted(), v_before; end if;
	r2 := pg_temp.answer(v_session, '66200000-0000-4000-8000-0000000000c1', v_event, 'answered', '{"values":["general"]}');
	if r2 <> r or pg_temp.admitted() <> v_before + 1 then raise exception 'A replayed answer: %', r2; end if;
	perform pg_temp.pause(true);
	r2 := pg_temp.answer(v_session, '66200000-0000-4000-8000-0000000000c1', v_event, 'answered', '{"values":["general"]}');
	if r2 <> r then raise exception 'A replayed answer while paused: %', r2; end if;
	perform pg_temp.raises_like(format('select pg_temp.answer(%L, %L, %L, %L, %L)', v_session, extensions.gen_random_uuid(), v_event2,
		'answered', '{"values":["finance"]}'), '55000', 'Company execution is paused');
	perform pg_temp.pause(false);
	perform pg_temp.path_claims('service_role');
end $$;

-- 3. On folder-v2 a plain conversation refuses before any lock, and a group chat keeps its own refusal. The snapshot-v1
-- answer is not refused (it reaches its own check).
do $$
declare v_room uuid := extensions.gen_random_uuid(); v_session uuid := extensions.gen_random_uuid(); v_control uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id,
		audience_kind, execution_scope) values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Planning',
		'63400000-0000-4000-8000-000000000001', 'company', jsonb_build_object('roomId', %L))$f$, v_session, v_room));
	perform pg_temp.fx(format($f$insert into public.qorpera_company_rooms(id, profile_id, environment_id, room_key, name, purpose, status, version,
		source_path, source_path_version, source_snapshot_id, source_file_sha256, created_by_user_id, session_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'planning', 'Planning', 'Plans.', 'active', 1, 'organization/rooms/planning.json', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), repeat('e', 64), '63400000-0000-4000-8000-000000000001', %L)$f$, v_room, v_session));
	perform pg_temp.fx(format($f$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id,
		audience_kind) values (%L, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', 'Control',
		'63400000-0000-4000-8000-000000000001', 'company')$f$, v_control));
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select pg_temp.answer(%L, %L, %L, %L, %L)', current_setting('qorpera_test.plain'),
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'declined', '{}'), '0A000', 'This conversation does not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select pg_temp.answer(%L, %L, %L, %L, %L)', v_session, extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 'declined', '{}'), '22023', 'cards are not answered in a group chat');
	perform pg_temp.raises_like(format('select pg_temp.answer(%L, %L, %L, %L, %L)', v_control, extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 'declined', '{}'), '22023', 'interaction request is unavailable');
	perform pg_temp.path_claims('service_role');
end $$;

-- 4. An answer to an action-review card in the thread: allowing it wakes the agent (the events, admission, the wake);
-- "Always allow" saves a company rule too; a card a call still holds takes the input and the events, with no wake and
-- no admission; a card outside an agent's thread refuses; a replay returns its receipt.
do $$
declare b jsonb := pg_temp.owner_run('ack-review'); v_session uuid := pg_temp.session_of(b); v_before bigint;
	v_once uuid := pg_temp.review(b, 'call-once'); v_always uuid := pg_temp.review(b, 'call-always');
	v_held uuid := pg_temp.review(b, 'call-held'); v_plain uuid := pg_temp.review(b, 'call-plain');
	r jsonb; r2 jsonb; v_review public.qorpera_action_reviews%rowtype;
begin
	perform pg_temp.fx(format('update public.qorpera_action_reviews set held_until = null where id in (%L, %L)', v_once, v_always));
	perform pg_temp.fx(format('update public.qorpera_action_reviews set proposed_rule = ''Emails to bob are fine'' where id = %L', v_always));
	perform pg_temp.fx(format('update public.qorpera_action_reviews set held_until = clock_timestamp() + interval ''1 hour'' where id = %L', v_held));
	perform pg_temp.fx(format('update public.qorpera_action_reviews set card_session_id = %L, held_until = null where id = %L',
		current_setting('qorpera_test.plain'), v_plain));
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	v_before := pg_temp.admitted();
	r := pg_temp.answer_review(v_once, '66200000-0000-4000-8000-0000000000d1', 'allow_once');
	select * into v_review from public.qorpera_action_reviews where id = v_once;
	if (r ->> 'woke')::boolean is not true or pg_temp.wakes_on((r ->> 'inputId')::uuid) <> 1
		or pg_temp.events_on(v_session, (r ->> 'inputId')::uuid) = 0 or pg_temp.admitted() <> v_before + 1
		or v_review.answer is distinct from 'allow_once' or v_review.woken_at is null then
		raise exception 'Allowing a card in the thread: % %', r, to_jsonb(v_review); end if;
	r2 := pg_temp.answer_review(v_once, '66200000-0000-4000-8000-0000000000d1', 'allow_once');
	if r2 -> 'inputId' <> r -> 'inputId' or pg_temp.admitted() <> v_before + 1 then raise exception 'A replayed review answer: %', r2; end if;
	r := pg_temp.answer_review(v_always, '66200000-0000-4000-8000-0000000000d2', 'always_allow');
	if r ->> 'savedRuleId' is null or pg_temp.wakes_on((r ->> 'inputId')::uuid) <> 1 or pg_temp.admitted() <> v_before + 2
		or not exists (select 1 from public.qorpera_review_rules where id = (r ->> 'savedRuleId')::uuid and scope = 'company'
			and outcome = 'allow_automatically') then
		raise exception 'Always allow in the thread: %', r; end if;
	r := pg_temp.answer_review(v_held, '66200000-0000-4000-8000-0000000000d3', 'deny');
	if (r ->> 'woke')::boolean is not false or exists (select 1 from public.qorpera_wake_occurrences where source_id = (r ->> 'inputId')::uuid)
		or pg_temp.events_on(v_session, (r ->> 'inputId')::uuid) = 0 or pg_temp.admitted() <> v_before + 2 then
		raise exception 'Answering a held card: %', r; end if;
	perform pg_temp.raises_like(format('select pg_temp.answer_review(%L, %L, %L)', v_plain, extensions.gen_random_uuid(), 'deny'), '0A000',
		'This conversation does not serve folder-v2 companies yet');
	perform pg_temp.path_claims('service_role');
end $$;

-- 5. An email draft's completion in the thread: the broker records the sent email, and the answer reaches the agent
-- (before C1c-3b it refused at the wake, and the completion swallowed the refusal).
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('66200000-0000-4000-8000-0000000000b0', '63400000-0000-4000-8000-000000000010', 'https://broker.example.test', 'test', repeat('a', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id, secret_name, purpose,
	current_version, created_by_user_id, account_label)
values ('66200000-0000-4000-8000-0000000000b9', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
	'66200000-0000-4000-8000-0000000000b0', 'company', 'gmail', 'primary', 'Email', 1, '63400000-0000-4000-8000-000000000001',
	'sender@example.test');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
values ('66200000-0000-4000-8000-0000000000b9', 1, '66200000-0000-4000-8000-0000000000b0', 'test', decode('abcd', 'hex'), repeat('b', 64),
	'63400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(profile_id, environment_id, secret_id, staff_agent_id, connector_id, operation_id,
	operation_version, tool_name, issued_by_user_id)
select '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', '66200000-0000-4000-8000-0000000000b9',
	'63400000-0000-4000-8000-0000000000a1', 'gmail', operation_id, version, tool_name, '63400000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and status = 'active';
do $$
declare b jsonb := pg_temp.owner_run('ack-draft'); v_session uuid := pg_temp.session_of(b); v jsonb;
begin
	perform pg_temp.card(b, '66200000-0000-4000-8000-0000000000e1', ('{"schema":"qorpera.interaction/v1","surface":"draft","title":"New email",'
		|| '"payload":{"platform":"email","connectorId":"gmail","from":"sender@example.test","to":["bob@example.test"],"subject":"Moved","body":"We moved."}}')::jsonb);
	perform set_config('qorpera_test.draft_session', v_session::text, true);
	perform set_config('qorpera_test.draft_admitted', pg_temp.admitted()::text, true);
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	v := public.qorpera_get_email_draft(v_session, '66200000-0000-4000-8000-0000000000e1');
	if v ->> 'status' <> 'ready' then raise exception 'The draft: %', v; end if;
	v := public.qorpera_prepare_email_draft_action(v_session, '66200000-0000-4000-8000-0000000000e1', '66200000-0000-4000-8000-0000000000e2',
		'send', '{"to":["bob@example.test"],"cc":[],"subject":"Moved","body":"We moved."}', repeat('d', 64),
		'63400000-0000-4000-8000-0000000000b1', 1);
	if v ->> 'status' <> 'sending' then raise exception 'The send: %', v; end if;
	perform pg_temp.path_claims('service_role');
end $$;
set session authorization qorpera_secret_broker;
select public.qorpera_claim_email_draft_action('66200000-0000-4000-8000-0000000000b0', repeat('a', 64), '66200000-0000-4000-8000-0000000000e2',
	repeat('d', 64)) \g /dev/null
select set_config('qorpera_test.finished', public.qorpera_finish_email_draft_action('66200000-0000-4000-8000-0000000000b0', repeat('a', 64),
	'66200000-0000-4000-8000-0000000000e2', repeat('d', 64), '{"message_id":"gmail1"}')::text, true) \g /dev/null
reset session authorization;
do $$
declare v_input public.qorpera_session_inputs%rowtype;
begin
	select * into v_input from public.qorpera_session_inputs where session_id = current_setting('qorpera_test.draft_session')::uuid
		and body ->> 'interactionId' = '66200000-0000-4000-8000-0000000000e1';
	if current_setting('qorpera_test.finished')::jsonb ->> 'status' <> 'sent' or v_input.id is null
		or v_input.body #>> '{answer,messageId}' is distinct from 'gmail1' or pg_temp.wakes_on(v_input.id) <> 1
		or pg_temp.admitted() <> current_setting('qorpera_test.draft_admitted')::bigint + 1 then
		raise exception 'The sent email''s answer must reach the agent: % %', current_setting('qorpera_test.finished'), to_jsonb(v_input); end if;
end $$;

-- 6. Privileges: the new function is postgres-only.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_folder_enter_agent_thread(uuid,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_enter_agent_thread(uuid,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_enter_agent_thread(uuid,uuid)', 'execute') then
		raise exception 'qorpera_folder_enter_agent_thread must be postgres-only'; end if;
end $$;

rollback;
