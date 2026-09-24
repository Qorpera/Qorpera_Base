-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A card answered outside the agent's own thread (bundle v105). The fixture's
-- "Path session" is a plain company conversation with no execution binding: a
-- member's message there is a session turn request (qorpera_request_session_
-- turn_v2), as the web sends it, and its run is a human wake that may raise a
-- card. The answer is delivered the same way, as a turn request on the
-- answering member's own model account, and wakes the agent with the answer as
-- its current input. An answer that could not run is refused and records
-- nothing; one whose delivery failed may be given again. Group chats answer no
-- cards. The agent's own thread is test 596; a conversation with its own
-- execution binding is test 590.
select pg_temp.path_claims('service_role');

do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
begin
	perform set_config('qorpera_test.plain_session','30000000-0000-4000-8000-000000000040',false);
	perform set_config('qorpera_test.plain_sponsor',current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id',false);
	perform set_config('qorpera_test.plain_identity',current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id',false);
	perform set_config('qorpera_test.plain_connection',current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id',false);
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_session_execution_bindings
		where session_id = '30000000-0000-4000-8000-000000000040')
		and not exists (select 1 from public.qorpera_company_rooms where session_id = '30000000-0000-4000-8000-000000000040')
		and (select audience_kind = 'company' and created_by_user_id = '30000000-0000-4000-8000-000000000001'
			from public.qorpera_shared_sessions where id = '30000000-0000-4000-8000-000000000040'),
		'The fixture conversation is a plain company conversation with no binding, as production has');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'kind' = 'human'
		and public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) ->> 'final' = 'required',
		'A message there wakes the agent with a human wake that must answer');
end
$$;

-- The human wake's run raises two cards in the plain conversation, then ends.
create function pg_temp.plain_card(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid,(p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid,(p_binding ->> 'runnerId')::uuid,(p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid,(p_binding ->> 'computeIdentityId')::uuid,'openai','codex-cli',p_event,
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel should the digest go to?",
			"payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
$$;
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_card jsonb;
begin
	v_card := pg_temp.plain_card(v_binding,'30000000-0000-4000-8000-0000000009b1');
	perform pg_temp.wake_assert(v_card ->> 'event_type' = 'interaction_request'
		and v_card ->> 'session_id' = current_setting('qorpera_test.plain_session'),
		'A human wake in a plain conversation raises a card there');
	perform pg_temp.plain_card(v_binding,'30000000-0000-4000-8000-0000000009b2');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid,repeat('2',64),(v_binding ->> 'jobId')::uuid,
		repeat('3',64),'plain card fixture run ended',false);
end
$$;

-- An answer as the web sends it: with the member's selected model account.
create function pg_temp.plain_answer(p_client uuid, p_interaction uuid, p_answer jsonb default '{"values":["finance"]}',
	p_sponsor uuid default null, p_version bigint default 1) returns jsonb language sql as $$
	select public.qorpera_answer_interaction(current_setting('qorpera_test.plain_session')::uuid,p_client,p_interaction,
		'answered',p_answer,coalesce(p_sponsor,current_setting('qorpera_test.plain_sponsor')::uuid),p_version)
$$;
-- A refused answer records nothing: no input, no turn request, no transcript event.
create function pg_temp.plain_refused(p_sql text, p_client uuid, p_state text, p_message text) returns void
language plpgsql as $$
begin
	perform pg_temp.wake_error(p_sql,p_state,p_message);
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_session_inputs
			where session_id = current_setting('qorpera_test.plain_session')::uuid and client_input_id = p_client)
		and not exists (select 1 from public.qorpera_session_turn_requests
			where session_id = current_setting('qorpera_test.plain_session')::uuid and client_request_id = p_client)
		and not exists (select 1 from public.qorpera_session_events
			where session_id = current_setting('qorpera_test.plain_session')::uuid and event_type = 'interaction_answer'),
		'A refused answer records nothing');
end
$$;
create function pg_temp.plain_sponsor_refused() returns void language plpgsql as $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L)',v_client,'30000000-0000-4000-8000-0000000009b1'),
		v_client,'42501','Session sponsor is unavailable');
	perform pg_temp.path_claims('service_role');
end
$$;

-- Who answers is unchanged: the creator of a company conversation.
do $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L)',v_client,'30000000-0000-4000-8000-0000000009b1'),
		v_client,'42501','Only the member this conversation belongs to can answer');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L)',v_client,'30000000-0000-4000-8000-0000000009b1'),
		v_client,'42501',null);
	perform pg_temp.path_claims('service_role');
end
$$;

-- An answer that could not run is refused: no account named (an older client),
-- an unknown account or version, another member's account, a disconnected
-- account, a disabled binding, credential or computer identity, or a paused company.
do $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.plain_refused(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L)',
		current_setting('qorpera_test.plain_session'),v_client,'30000000-0000-4000-8000-0000000009b1','answered',
		'{"values":["finance"]}'),v_client,'42501','Session sponsor is unavailable');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L,%L,%L)',v_client,
		'30000000-0000-4000-8000-0000000009b1','{"values":["finance"]}',extensions.gen_random_uuid()),
		v_client,'42501','Session sponsor is unavailable');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L,%L,null,%s)',v_client,
		'30000000-0000-4000-8000-0000000009b1','{"values":["finance"]}',2),v_client,'42501','Session sponsor is unavailable');
	perform pg_temp.path_claims('service_role');
end
$$;
savepoint sponsor_other_member;
update public.qorpera_provider_connections set owner_user_id = '30000000-0000-4000-8000-000000000002'
where id = current_setting('qorpera_test.plain_connection')::uuid;
select pg_temp.plain_sponsor_refused();
rollback to savepoint sponsor_other_member;
savepoint sponsor_disconnected;
update public.qorpera_provider_connections set status = 'disabled'
where id = current_setting('qorpera_test.plain_connection')::uuid;
select pg_temp.plain_sponsor_refused();
rollback to savepoint sponsor_disconnected;
savepoint binding_disabled;
update public.qorpera_execution_sponsor_bindings set status = 'disabled'
where id = current_setting('qorpera_test.plain_sponsor')::uuid;
select pg_temp.plain_sponsor_refused();
rollback to savepoint binding_disabled;
savepoint credential_gone;
update public.qorpera_native_credential_capsules set status = 'disabled'
where id = (select version.credential_capsule_id from public.qorpera_provider_connection_versions as version
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = version.connection_id
		and sponsor.provider_connection_version = version.version
	where sponsor.binding_id = current_setting('qorpera_test.plain_sponsor')::uuid and sponsor.version = 1);
select pg_temp.plain_sponsor_refused();
rollback to savepoint credential_gone;
savepoint identity_retired;
update public.qorpera_member_compute_identities set status = 'retired'
where id = current_setting('qorpera_test.plain_identity')::uuid;
select pg_temp.plain_sponsor_refused();
rollback to savepoint identity_retired;
savepoint paused;
insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id,reason)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','Runtime update');
do $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.plain_refused(format('select pg_temp.plain_answer(%L,%L)',v_client,'30000000-0000-4000-8000-0000000009b1'),
		v_client,'55000','Company execution is paused');
	perform pg_temp.path_claims('service_role');
end
$$;
rollback to savepoint paused;

-- An answer whose delivery failed never reached the agent: the member may answer again.
savepoint delivery_failed;
do $$
declare v_first jsonb; v_second jsonb; v_request public.qorpera_session_turn_requests%rowtype;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_first := pg_temp.plain_answer(extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009b2');
	perform pg_temp.path_claims('service_role');
	-- The account is disconnected before the answer's turn is admitted.
	update public.qorpera_provider_connections set status = 'disabled'
	where id = current_setting('qorpera_test.plain_connection')::uuid;
	perform public.qorpera_materialize_session_turn_requests(32);
	select * into strict v_request from public.qorpera_session_turn_requests where input_id = (v_first ->> 'input_id')::uuid;
	perform pg_temp.wake_assert(v_request.status = 'failed' and (select failed_at is not null
		from public.qorpera_session_inputs where id = (v_first ->> 'input_id')::uuid),'The answer''s delivery failed');
	update public.qorpera_provider_connections set status = 'active'
	where id = current_setting('qorpera_test.plain_connection')::uuid;
	update public.qorpera_execution_sponsor_bindings set status = 'active'
	where id = current_setting('qorpera_test.plain_sponsor')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_second := pg_temp.plain_answer(extensions.gen_random_uuid(),'30000000-0000-4000-8000-0000000009b2',
		'{"values":["general"]}');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(v_second ->> 'input_id' <> v_first ->> 'input_id'
		and exists (select 1 from public.qorpera_session_turn_requests
			where input_id = (v_second ->> 'input_id')::uuid and status = 'queued'),
		'A failed answer does not settle the card; the new answer is delivered');
end
$$;
rollback to savepoint delivery_failed;

-- The member's answer: a turn request on their own account, admitted as a human
-- wake whose current input is the answer.
do $$
declare v_session uuid := current_setting('qorpera_test.plain_session')::uuid; v_client uuid := extensions.gen_random_uuid();
	v_answer jsonb; v_retry jsonb; v_input public.qorpera_session_inputs%rowtype;
	v_request public.qorpera_session_turn_requests%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_event public.qorpera_session_events%rowtype; v_binding jsonb; v_envelope jsonb; v_context jsonb;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_answer := pg_temp.plain_answer(v_client,'30000000-0000-4000-8000-0000000009b1');
	v_retry := pg_temp.plain_answer(v_client,'30000000-0000-4000-8000-0000000009b1');
	perform pg_temp.wake_assert(v_retry ->> 'input_id' = v_answer ->> 'input_id','A retried answer returns the original input');
	perform pg_temp.wake_error(format('select pg_temp.plain_answer(%L,%L,%L)',extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-0000000009b1','{"values":["general"]}'),'55000','interaction request is already answered');
	perform pg_temp.path_claims('service_role');

	select * into strict v_input from public.qorpera_session_inputs where id = (v_answer ->> 'input_id')::uuid;
	perform pg_temp.wake_assert(v_input.session_id = v_session and v_input.completed_at is null
		and v_input.author_user_id = '30000000-0000-4000-8000-000000000001'
		and v_input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
		and v_input.body ->> 'interactionId' = '30000000-0000-4000-8000-0000000009b1',
		'The answer is queued as the member''s input, as a message is');
	select * into strict v_request from public.qorpera_session_turn_requests where input_id = v_input.id;
	perform pg_temp.wake_assert(v_request.session_id = v_session and v_request.status = 'queued'
		and v_request.client_request_id = v_client
		and v_request.requested_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_request.sponsored_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_request.sponsor_mode = 'member_connection'
		and v_request.sponsor_binding_id = current_setting('qorpera_test.plain_sponsor')::uuid
		and v_request.sponsor_version = 1
		and v_request.compute_identity_id = current_setting('qorpera_test.plain_identity')::uuid
		and v_request.worker_class = 'managed_sandbox' and v_request.logical_computer_id is null
		and v_request.required_capability = 'agent_turn' and v_request.job_type = 'agent_turn',
		'The answer asks for a turn on the member''s own account, as a message there does');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_turn_requests
		where session_id = v_session and client_request_id = v_client),'One answer, one turn request');

	perform public.qorpera_materialize_session_turn_requests(32);
	select * into strict v_request from public.qorpera_session_turn_requests where id = v_request.id;
	select * into strict v_run from public.qorpera_execution_runs where id = v_request.run_id;
	perform pg_temp.wake_assert(v_request.status = 'materialized' and v_run.source_kind = 'session_turn'
		and v_run.session_id = v_session and v_run.input_ids = array[v_input.id]
		and v_run.staff_agent_id = '30000000-0000-4000-8000-000000000030',
		'The answer is admitted as a turn of the conversation''s agent');
	select * into strict v_event from public.qorpera_session_events where session_id = v_session and event_id = v_input.id;
	perform pg_temp.wake_assert(v_event.event_type = 'interaction_answer' and v_event.session_input_id = v_input.id
		and v_event.actor_user_id = '30000000-0000-4000-8000-000000000001'
		and v_event.body #>> '{entry,data,interactionId}' = '30000000-0000-4000-8000-0000000009b1'
		and v_event.body #> '{entry,data,answer,values}' = '["finance"]'::jsonb,
		'The answer joins the transcript as the member''s typed event');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run.id) ->> 'kind' = 'human'
		and public.qorpera_runtime_wake_policy(v_run.id) ->> 'final' = 'required','The agent answers the answer');

	v_binding := pg_temp.wake_start(v_run.id);
	v_envelope := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.wake_assert(v_envelope ->> 'kind' = 'human'
		and v_envelope #> '{payload,inputIds}' = jsonb_build_array(v_input.id),
		'The runtime reads a human wake naming the answer');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.wake_assert(v_context #>> '{currentInputs,0,id}' = v_input.id::text
		and v_context #>> '{currentInputs,0,kind}' = 'current_human_request'
		and v_context #>> '{currentInputs,0,authorUserId}' = '30000000-0000-4000-8000-000000000001'
		and (v_context #>> '{currentInputs,0,content,text}')::jsonb ->> 'interactionId' = '30000000-0000-4000-8000-0000000009b1'
		and (v_context #>> '{currentInputs,0,content,text}')::jsonb -> 'answer' = '{"values":["finance"]}'::jsonb,
		'The agent reads the answer as its current input');
end
$$;

-- A group chat (a room bound to no agent) answers no cards.
savepoint group_chat;
do $$
declare v_thread uuid; v_client uuid := extensions.gen_random_uuid();
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	update public.qorpera_company_rooms set bound_staff_agent_id = null, source_path_version = extensions.gen_random_uuid(),
		source_snapshot_id = extensions.gen_random_uuid(), source_file_sha256 = repeat('a',64)
	where session_id = v_thread;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_answer_interaction(%L,%L,%L,%L,%L,%L,%s)',v_thread,v_client,
		'30000000-0000-4000-8000-0000000009b1','answered','{"values":["finance"]}',
		current_setting('qorpera_test.plain_sponsor'),1),'22023','cards are not answered in a group chat');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_session_inputs where client_input_id = v_client),
		'A refused answer in a group chat records nothing');
end
$$;
rollback to savepoint group_chat;
rollback;
