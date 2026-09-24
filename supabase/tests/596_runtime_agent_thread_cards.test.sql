-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Cards in the agent's own thread (bundle v100). A member's post in the thread
-- is a room wake; the agent answers it with a card; only the member it was
-- raised for answers, on their own model account; the answer joins the
-- transcript at once and wakes the thread's agent with a room wake, as a post
-- does. An answer that could not run is refused, never recorded. Group chats
-- carry no cards.
select pg_temp.path_claims('service_role');

create function pg_temp.card_append(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid,(p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid,(p_binding ->> 'runnerId')::uuid,(p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid,(p_binding ->> 'computeIdentityId')::uuid,'openai','codex-cli',p_event,
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel should the digest go to?",
			"payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
$$;
-- An answer as the web sends it in an agent's thread: with the member's own sponsor.
create function pg_temp.card_answer(p_client uuid, p_interaction uuid, p_outcome text, p_answer jsonb,
	p_sponsor uuid default null, p_version bigint default null) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	return public.qorpera_answer_interaction(current_setting('qorpera_test.card_thread')::uuid,p_client,p_interaction,
		p_outcome,p_answer,coalesce(p_sponsor,v_base.sponsor_binding_id),coalesce(p_version,v_base.sponsor_version));
end
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
	-- An approval through the runner transcript path, in the same thread.
	perform public.qorpera_append_runner_transcript_event((v_binding ->> 'runnerId')::uuid,
		(select session_token_sha256 from public.qorpera_runners where id = (v_binding ->> 'runnerId')::uuid),
		(v_binding ->> 'jobId')::uuid,
		(select lease_token_sha256 from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		(v_binding ->> 'assignmentId')::uuid,'30000000-0000-4000-8000-0000000009a2','authorization_request',
		jsonb_build_object('schema','qorpera.runner-transcript-entry/v1','entry',jsonb_build_object(
			'type','custom','customType','authorization_request','id','30000000-0000-4000-8000-0000000009a2',
			'parentId','30000000-0000-4000-8000-0000000009a1','timestamp','2026-09-24T20:00:00.000Z',
			'data',jsonb_build_object('operation','send_invoice','summary','Send invoice 42 to Acme.'),
			'execution',jsonb_build_object('kind','run','id',v_binding ->> 'runId','claimantId',v_binding ->> 'runId',
				'runnerAssignmentId',v_binding ->> 'assignmentId'))));
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
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L)',extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-0000000009a1','answered','{"values":["finance"]}'),
		'42501','Only the member this card was raised for can answer it');
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L)',extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-0000000009a2','approved','{}'),
		'42501','Only the member this card was raised for can answer it');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L)',extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-0000000009a1','answered','{"values":["finance"]}'),'42501');
	perform pg_temp.path_claims('service_role');
end
$$;

-- An answer that could not run is refused and records nothing: no account named,
-- another member's account, a disconnected account, a disabled credential, or a
-- paused company.
create function pg_temp.card_refused(p_state text, p_message text, p_sponsor uuid default null) returns void
language plpgsql as $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L,%L)',v_client,
		'30000000-0000-4000-8000-0000000009a1','answered','{"values":["finance"]}',p_sponsor),p_state,p_message);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_session_inputs where client_input_id = v_client)
		and not exists (select 1 from public.qorpera_session_events
			where session_id = current_setting('qorpera_test.card_thread')::uuid and event_type = 'interaction_answer'),
		'A refused answer records nothing');
end
$$;
do $$
declare v_base public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.card_thread'),extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a1',
		'answered','{"values":["finance"]}'),'42501','Room sponsor is unavailable');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.card_refused('42501','Room sponsor is unavailable',extensions.gen_random_uuid());
	perform set_config('qorpera_test.card_sponsor_connection',(select provider_connection_id::text
		from public.qorpera_execution_sponsor_versions
		where binding_id = v_base.sponsor_binding_id and version = v_base.sponsor_version),false);
end
$$;
savepoint sponsor_other;
update public.qorpera_execution_sponsor_bindings set created_by_user_id = '30000000-0000-4000-8000-000000000002'
where id = (select sponsor_binding_id from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid);
select pg_temp.card_refused('42501','Room sponsor is unavailable');
rollback to savepoint sponsor_other;
savepoint sponsor_disconnected;
update public.qorpera_provider_connections set status = 'disabled'
where id = current_setting('qorpera_test.card_sponsor_connection')::uuid;
select pg_temp.card_refused('42501','Room sponsor is unavailable');
rollback to savepoint sponsor_disconnected;
savepoint credential_gone;
update public.qorpera_native_credential_capsules set status = 'disabled'
where id = (select version.credential_capsule_id from public.qorpera_provider_connection_versions as version
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = version.connection_id
		and sponsor.provider_connection_version = version.version
	join public.qorpera_execution_runs as run on run.sponsor_binding_id = sponsor.binding_id
		and run.sponsor_version = sponsor.version
	where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid);
select pg_temp.card_refused('42501','Room sponsor is unavailable');
rollback to savepoint credential_gone;
savepoint paused;
insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id,reason)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','Runtime update');
select pg_temp.card_refused('55000','Company execution is paused');
rollback to savepoint paused;

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
	v_answer := pg_temp.card_answer(v_client,'30000000-0000-4000-8000-0000000009a1','answered','{"values":["finance"]}');
	v_retry := pg_temp.card_answer(v_client,'30000000-0000-4000-8000-0000000009a1','answered','{"values":["finance"]}');
	perform pg_temp.wake_assert(v_retry ->> 'input_id' = v_answer ->> 'input_id','A retried answer returns the original input');
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L)',extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-0000000009a1','answered','{"values":["general"]}'),
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
		'The answer wakes the thread''s agent as a post does, on the member''s own sponsor');
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
-- An approval in the agent's thread: the member it was raised for, with full access, decides it.
do $$
declare v_answer jsonb; v_event public.qorpera_session_events%rowtype;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_answer := pg_temp.card_answer(extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009a2','approved','{}');
	perform pg_temp.path_claims('service_role');
	select * into strict v_event from public.qorpera_session_events where event_id = (v_answer ->> 'input_id')::uuid;
	perform pg_temp.wake_assert(v_event.event_type = 'authorization_decision'
		and v_event.body #>> '{entry,data,decision}' = 'approved'
		and v_event.actor_user_id = '30000000-0000-4000-8000-000000000001','The decision is in the transcript at once');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences
		where source_kind = 'room' and source_id = (v_answer ->> 'input_id')::uuid
			and staff_agent_id = '30000000-0000-4000-8000-000000000031'),'The decision wakes the thread''s agent');
end
$$;
rollback;
