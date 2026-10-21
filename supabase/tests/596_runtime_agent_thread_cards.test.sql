-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Cards in the agent's own thread on folder-v2 (ported from snapshot-v1 in the legacy sweep). A member's post in Bob's
-- thread is a room wake, turned into a run by the folder materializer and started on a real runner; the agent answers it
-- with a card; only the member it was raised for answers, on their own model account; the answer joins the transcript
-- at once and wakes the thread's agent with a room wake, as a post does, which the next pass delivers to the agent in
-- its thread. An answer that could not run is refused, never recorded. Group chats carry no cards.
select pg_temp.base_claims('service_role');

create function pg_temp.cd_card(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event,
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel should the digest go to?",
			"payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
$$;
-- An answer as the web sends it in Bob's thread: with the member's own sponsor (the owner's, unless another is named).
create function pg_temp.cd_answer(p_client uuid, p_interaction uuid, p_outcome text, p_answer jsonb,
	p_sponsor uuid default null, p_version bigint default null) returns jsonb language sql as $$
	select public.qorpera_answer_interaction(current_setting('qorpera_test.card_thread')::uuid, p_client, p_interaction, p_outcome, p_answer,
		coalesce(p_sponsor, (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid), coalesce(p_version, 1))
$$;
-- The owner's post in a room on the owner's sponsor, run up to its runner: the post's one room wake is turned into a run
-- by the materializer and started with a lease; answers the run's binding.
create function pg_temp.cd_post(p_room uuid, p_text text) returns jsonb language plpgsql as $$
declare v_result jsonb; v_run uuid; v_pass jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message(p_room, extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	perform pg_temp.base_assert(jsonb_array_length(v_result -> 'occurrenceIds') = 1, 'The post wakes one agent: ' || v_result::text);
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run), 'The post is a run: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end $$;

-- Bob's thread and its conversation (session-wide settings: later savepoints roll back).
select set_config('qorpera_test.card_room', pg_temp.base_thread('92400000-0000-4000-8000-000000000031')::text, false) \g /dev/null
select set_config('qorpera_test.card_thread', (select session_id::text from public.qorpera_company_rooms
	where id = current_setting('qorpera_test.card_room')::uuid and status = 'active'), false) \g /dev/null

-- A group chat carries no card: the kernel refuses one from a run whose room is not bound to its agent, and such a room
-- wake, from a post that names nobody, may stay silent (the runtime's own reading of "not the agent's thread").
savepoint cd_group_chat;
do $$
declare v_text text := E'---\nid: 59600000-0000-4000-8000-0000000000c1\nname: Digest\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
		|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n---\nPlan the digest.\n';
	v_result jsonb; v_binding jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'cd-group-digest', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
		jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/digest',
			'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(v_text))),
			'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/digest/group.md', 'kind', 'group', 'text', v_text,
				'parse', jsonb_build_object('kind', 'group', 'id', '59600000-0000-4000-8000-0000000000c1', 'name', 'Digest', 'subtitle', null,
					'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
					'people', '["92400000-0000-4000-8000-000000000001"]'::jsonb, 'purpose', 'Plan the digest.'), 'parserVersion', 1)))));
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message('59600000-0000-4000-8000-0000000000c1', extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"Which channel should the digest go to?"}',
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.base_materialize() -> 'run_ids') = 2, 'Both agents of the chat have a run');
	v_binding := pg_temp.base_start(null);
	perform pg_temp.base_assert((select session_id from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid)
		= (select session_id from public.qorpera_company_rooms where id = '59600000-0000-4000-8000-0000000000c1'), 'The run is in the group chat');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'final' = 'optional',
		'A group chat wake may stay silent');
	perform pg_temp.base_error(format('select pg_temp.cd_card(%L,%L)', v_binding, '59600000-0000-4000-8000-0000000009a0'),
		'22023', 'cards are not raised in a group chat');
end
$$;
rollback to savepoint cd_group_chat;

-- The agent's own thread: a member's post, answered with a card.
do $$
declare v_binding jsonb; v_card jsonb;
begin
	v_binding := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, set up the Slack digest.');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'final' = 'required',
		'A post in the agent''s own thread requires an answer');
	v_card := pg_temp.cd_card(v_binding, '59600000-0000-4000-8000-0000000009a1');
	perform pg_temp.base_assert(v_card ->> 'event_type' = 'interaction_request'
		and v_card ->> 'actor_user_id' = '92400000-0000-4000-8000-000000000001'
		and v_card ->> 'session_id' = current_setting('qorpera_test.card_thread'),
		'The card is raised in the thread for the member whose post it answers: ' || v_card::text);
	perform pg_temp.base_public_send(v_binding, 'final', 'card-final');
	-- The run ends before the member answers.
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'card fixture run ended', false);
	perform set_config('qorpera_test.card_run', v_binding ->> 'runId', false);
end
$$;

-- Only the member the card was raised for answers it, even in a thread every member shares.
do $$
begin
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_room_members
		where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
			and principal_id = '92400000-0000-4000-8000-000000000002' and status = 'active'), 'The other member shares the thread');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L)', extensions.gen_random_uuid(),
		'59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}'),
		'42501', 'Only the member this card was raised for can answer it');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L)', extensions.gen_random_uuid(),
		'59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}'), '42501');
	perform pg_temp.base_claims('service_role');
end
$$;

-- An answer that could not run is refused and records nothing: no account named, an account that is no sponsor,
-- another member's account, a disconnected account, or a disabled credential.
create function pg_temp.cd_refused(p_state text, p_message text, p_sponsor uuid default null) returns void language plpgsql as $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L,%L)', v_client,
		'59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}', p_sponsor), p_state, p_message);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_session_inputs where client_input_id = v_client)
		and not exists (select 1 from public.qorpera_session_events
			where session_id = current_setting('qorpera_test.card_thread')::uuid and event_type = 'interaction_answer'),
		'A refused answer records nothing');
end
$$;
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.card_thread'), extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1',
		'answered', '{"values":["finance"]}'), '42501', 'Room sponsor is unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.cd_refused('42501', 'Room sponsor is unavailable', extensions.gen_random_uuid());
end
$$;
savepoint cd_sponsor_other;
update public.qorpera_execution_sponsor_bindings set created_by_user_id = '92400000-0000-4000-8000-000000000002'
where id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
select pg_temp.cd_refused('42501', 'Room sponsor is unavailable');
rollback to savepoint cd_sponsor_other;
savepoint cd_sponsor_disconnected;
update public.qorpera_provider_connections set status = 'disabled'
where id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
select pg_temp.cd_refused('42501', 'Room sponsor is unavailable');
rollback to savepoint cd_sponsor_disconnected;
savepoint cd_credential_gone;
update public.qorpera_native_credential_capsules set status = 'disabled'
where id = (select version.credential_capsule_id from public.qorpera_provider_connection_versions as version
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = version.connection_id
		and sponsor.provider_connection_version = version.version
	where sponsor.binding_id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid and sponsor.version = 1);
select pg_temp.cd_refused('42501', 'Room sponsor is unavailable');
rollback to savepoint cd_credential_gone;

-- The member's answer: in the transcript at once, and a room wake for the thread's agent, which the next pass delivers
-- to the agent in its thread.
do $$
declare v_thread uuid := current_setting('qorpera_test.card_thread')::uuid; v_room uuid := current_setting('qorpera_test.card_room')::uuid;
	v_raising public.qorpera_execution_runs%rowtype; v_client uuid := extensions.gen_random_uuid();
	v_answer jsonb; v_retry jsonb; v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_binding jsonb; v_envelope jsonb; v_context jsonb;
begin
	select * into strict v_raising from public.qorpera_execution_runs where id = current_setting('qorpera_test.card_run')::uuid;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_answer := pg_temp.cd_answer(v_client, '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	v_retry := pg_temp.cd_answer(v_client, '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_assert(v_retry ->> 'input_id' = v_answer ->> 'input_id', 'A retried answer returns the original input');
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L)', extensions.gen_random_uuid(),
		'59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["general"]}'), '55000', 'interaction request is already answered');
	perform pg_temp.base_claims('service_role');

	select * into strict v_input from public.qorpera_session_inputs where id = (v_answer ->> 'input_id')::uuid;
	perform pg_temp.base_assert(v_input.completed_at is not null and v_input.author_user_id = '92400000-0000-4000-8000-000000000001'
		and v_input.body ->> 'schema' = 'qorpera.interaction-answer/v1', 'The answer is a completed member input, like a post');
	select * into strict v_event from public.qorpera_session_events where event_id = v_input.id;
	perform pg_temp.base_assert(v_event.session_id = v_thread and v_event.event_type = 'interaction_answer'
		and v_event.session_input_id = v_input.id and v_event.actor_user_id = '92400000-0000-4000-8000-000000000001'
		and v_event.body #>> '{entry,data,interactionId}' = '59600000-0000-4000-8000-0000000009a1'
		and v_event.body #> '{entry,data,answer,values}' = '["finance"]'::jsonb,
		'The answer joins the transcript at once as the member''s typed event');

	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'room' and source_id = v_input.id;
	perform pg_temp.base_assert(v_wake.wake_kind = 'room' and v_wake.session_id = v_thread
		and v_wake.staff_agent_id = '92400000-0000-4000-8000-000000000031'
		and v_wake.requested_by_user_id = '92400000-0000-4000-8000-000000000001'
		and v_wake.sponsor_binding_id = v_raising.sponsor_binding_id and v_wake.sponsor_version = v_raising.sponsor_version
		and v_wake.payload = jsonb_build_object('roomId', v_room, 'inputIds', jsonb_build_array(v_input.id),
			'recipientStaffId', '92400000-0000-4000-8000-000000000031'),
		'The answer wakes the thread''s agent as a post does, on the member''s own sponsor');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_wake_occurrences where source_id = v_input.id), 'One answer, one wake');

	perform pg_temp.base_assert(pg_temp.base_materialize() ->> 'state' = 'done', 'The next pass runs');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.base_assert((select source_kind = 'room_delivery' and session_id = v_thread
		from public.qorpera_execution_runs where id = v_wake.run_id), 'The answer is delivered to the agent in its thread');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_wake.run_id) ->> 'final' = 'required', 'The agent answers the answer');
	v_binding := pg_temp.base_start(v_wake.run_id);
	v_envelope := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.base_assert(v_envelope ->> 'kind' = 'room' and v_envelope #>> '{policy,final}' = 'required'
		and v_envelope #> '{payload,inputIds}' = jsonb_build_array(v_input.id),
		'The runtime reads a room wake in the agent''s own thread naming the answer');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.base_assert(v_context #>> '{history,-1,id}' = v_input.id::text
		and v_context #>> '{history,-1,kind}' = 'historical_human_message'
		and v_context #>> '{history,-1,authorUserId}' = '92400000-0000-4000-8000-000000000001',
		'The answer is the newest entry of the thread the agent reads: ' || (v_context -> 'history')::text);
end
$$;
rollback;
