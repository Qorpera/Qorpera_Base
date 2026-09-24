-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Cards in the agent's own thread (bundle v101). A member's post in the thread
-- is a room wake; the agent answers it with a card; only the member it was
-- raised for answers; the answer joins the transcript at once and wakes the
-- thread's agent with a room wake, as a post does. Group chats carry no cards.
select pg_temp.path_claims('service_role');

create function pg_temp.card_append(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid,(p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid,(p_binding ->> 'runnerId')::uuid,(p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid,(p_binding ->> 'computeIdentityId')::uuid,'openai','codex-cli',p_event,
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel should the digest go to?",
			"payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
$$;
-- A member's post in a room, run up to its runner: the room wake's binding.
create function pg_temp.card_post(p_room uuid, p_text text) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_result jsonb; v_run uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_post_company_room_message(p_room,extensions.gen_random_uuid(),
		jsonb_build_object('schema','qorpera.session-prompt/v1','text',p_text),v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	return pg_temp.wake_start(v_run);
end
$$;

do $$
declare v_thread uuid; v_room uuid;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	select id into strict v_room from public.qorpera_company_rooms where session_id = v_thread and status = 'active';
	perform set_config('qorpera_test.card_thread',v_thread::text,false);
	perform set_config('qorpera_test.card_room',v_room::text,false);
end
$$;

-- A group chat carries no card: the kernel refuses one from a run whose room is
-- not bound to its agent, and such a room wake may stay silent (the runtime's
-- own reading of "not the agent's thread").
savepoint group_chat;
do $$
declare v_binding jsonb;
begin
	update public.qorpera_company_rooms set bound_staff_agent_id = null, source_path_version = extensions.gen_random_uuid(),
		source_snapshot_id = extensions.gen_random_uuid(), source_file_sha256 = repeat('a',64)
	where id = current_setting('qorpera_test.card_room')::uuid;
	v_binding := pg_temp.card_post(current_setting('qorpera_test.card_room')::uuid,'Bob, which channel?');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'final' = 'optional',
		'A group chat wake may stay silent');
	perform pg_temp.wake_error(format('select pg_temp.card_append(%L,%L)',v_binding,'30000000-0000-4000-8000-0000000009a0'),
		'22023','cards are not raised in a group chat');
end
$$;
rollback to savepoint group_chat;

-- The agent's own thread: a member's post, answered with a card.
do $$
declare v_binding jsonb; v_card jsonb;
begin
	v_binding := pg_temp.card_post(current_setting('qorpera_test.card_room')::uuid,'Bob, set up the Slack digest.');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'final' = 'required',
		'A post in the agent''s own thread requires an answer');
	v_card := pg_temp.card_append(v_binding,'30000000-0000-4000-8000-0000000009a1');
	perform pg_temp.wake_assert(v_card ->> 'event_type' = 'interaction_request'
		and v_card ->> 'actor_user_id' = '30000000-0000-4000-8000-000000000001',
		'The card is raised for the member whose post it answers');
	perform pg_temp.wake_public_send(v_binding,'final','card-final');
	-- The run ends before the member answers.
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid,repeat('2',64),(v_binding ->> 'jobId')::uuid,
		repeat('3',64),'card fixture run ended',false);
	perform set_config('qorpera_test.card_run',v_binding ->> 'runId',false);
end
$$;

-- Only the member the card was raised for answers it, even in a thread every member shares.
do $$
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_room_members
		where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
			and principal_id = '30000000-0000-4000-8000-000000000002' and status = 'active'),'The other member shares the thread');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.card_thread'),extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a1',
		'answered','{"values":["finance"]}'),'42501','Only the member this card was raised for can answer it');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.card_thread'),extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a1',
		'answered','{"values":["finance"]}'),'42501');
	perform pg_temp.path_claims('service_role');
end
$$;

-- A model account that is gone refuses the answer instead of queuing it unread.
savepoint sponsor_gone;
do $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = current_setting('qorpera_test.card_run')::uuid;
	update public.qorpera_execution_sponsor_bindings set status = 'revoked' where id = v_run.sponsor_binding_id;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.card_thread'),extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a1',
		'answered','{"values":["finance"]}'),'42501','Room sponsor is unavailable');
	perform pg_temp.path_claims('service_role');
end
$$;
rollback to savepoint sponsor_gone;

-- The member's answer: in the transcript at once, and a room wake for the thread's agent.
do $$
declare v_thread uuid := current_setting('qorpera_test.card_thread')::uuid;
	v_room uuid := current_setting('qorpera_test.card_room')::uuid;
	v_raising public.qorpera_execution_runs%rowtype; v_client uuid := extensions.gen_random_uuid();
	v_answer jsonb; v_retry jsonb; v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_binding jsonb; v_envelope jsonb; v_context jsonb;
begin
	select * into strict v_raising from public.qorpera_execution_runs where id = current_setting('qorpera_test.card_run')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_answer := public.qorpera_answer_interaction(v_thread,v_client,'30000000-0000-4000-8000-0000000009a1','answered',
		'{"values":["finance"]}');
	v_retry := public.qorpera_answer_interaction(v_thread,v_client,'30000000-0000-4000-8000-0000000009a1','answered',
		'{"values":["finance"]}');
	perform pg_temp.wake_assert(v_retry ->> 'input_id' = v_answer ->> 'input_id','A retried answer returns the original input');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',v_thread,
		extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a1','answered','{"values":["general"]}'),
		'55000','interaction request is already answered');
	perform pg_temp.path_claims('service_role');

	select * into strict v_input from public.qorpera_session_inputs where id = (v_answer ->> 'input_id')::uuid;
	perform pg_temp.wake_assert(v_input.completed_at is not null and v_input.author_user_id = '30000000-0000-4000-8000-000000000001'
		and v_input.body ->> 'schema' = 'qorpera.interaction-answer/v1','The answer is a completed member input, like a post');
	select * into strict v_event from public.qorpera_session_events where event_id = v_input.id;
	perform pg_temp.wake_assert(v_event.session_id = v_thread and v_event.event_type = 'interaction_answer'
		and v_event.session_input_id = v_input.id and v_event.actor_user_id = '30000000-0000-4000-8000-000000000001'
		and v_event.body #>> '{entry,data,interactionId}' = '30000000-0000-4000-8000-0000000009a1'
		and v_event.body #> '{entry,data,answer,values}' = '["finance"]'::jsonb,
		'The answer joins the transcript at once as the member''s typed event');

	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'room' and source_id = v_input.id;
	perform pg_temp.wake_assert(v_wake.wake_kind = 'room' and v_wake.session_id = v_thread
		and v_wake.staff_agent_id = '30000000-0000-4000-8000-000000000031'
		and v_wake.requested_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_wake.sponsor_binding_id = v_raising.sponsor_binding_id and v_wake.sponsor_version = v_raising.sponsor_version
		and v_wake.payload = jsonb_build_object('roomId',v_room,'inputIds',jsonb_build_array(v_input.id),
			'recipientStaffId','30000000-0000-4000-8000-000000000031'),
		'The answer wakes the thread''s agent as a post does, on the sponsor that raised the card');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences where source_id = v_input.id),
		'One answer, one wake');

	perform public.qorpera_materialize_wake_execution_runs(1);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.wake_assert((select source_kind = 'room_delivery' and session_id = v_thread
		from public.qorpera_execution_runs where id = v_wake.run_id),'The answer is delivered to the agent in its thread');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_wake.run_id) ->> 'final' = 'required',
		'The agent answers the answer');
	v_binding := pg_temp.wake_start(v_wake.run_id);
	v_envelope := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.wake_assert(v_envelope ->> 'kind' = 'room' and v_envelope #>> '{policy,final}' = 'required'
		and v_envelope #> '{payload,inputIds}' = jsonb_build_array(v_input.id),
		'The runtime reads a room wake in the agent''s own thread naming the answer');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.wake_assert(v_context #>> '{history,-1,id}' = v_input.id::text
		and v_context #>> '{history,-1,kind}' = 'historical_human_message'
		and v_context #>> '{history,-1,authorUserId}' = '30000000-0000-4000-8000-000000000001',
		'The answer is the newest entry of the thread the agent reads');
end
$$;
rollback;
