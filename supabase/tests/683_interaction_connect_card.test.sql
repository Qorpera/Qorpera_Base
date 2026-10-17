-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The connect card (20260930503000; contract 16.2): a run asks its member to connect a catalog service the company has
-- not connected. The payload is closed ({connectorId, purpose}); a service outside the connector catalog is refused;
-- "connected" needs the company's own active connection of that service, a member's own connection or a disconnected
-- one does not count; "declined" always answers; neither carries an answer. And a card the payload check cannot call
-- valid (null, a required text missing) is refused like a false one.
create function pg_temp.cc_card(p_binding jsonb, p_event uuid, p_data jsonb) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
create function pg_temp.cc_connect(p_connector text, p_purpose text default 'Reading the invoices in the inbox.') returns jsonb
language sql as $$
	select jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'connect', 'title', 'Connect a service',
		'payload', jsonb_build_object('connectorId', p_connector, 'purpose', p_purpose))
$$;
-- The owner's answer in Bob's thread, on the owner's sponsor.
create function pg_temp.cc_answer(p_client uuid, p_interaction uuid, p_outcome text, p_answer jsonb default '{}') returns jsonb
language sql as $$
	select public.qorpera_answer_interaction(current_setting('qorpera_test.cc_thread')::uuid, p_client, p_interaction, p_outcome,
		p_answer, (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1)
$$;

select set_config('qorpera_test.cc_thread', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')), true) \g /dev/null

-- 1. The payload check alone: closed, a catalog-shaped id, a purpose of 1-300 bytes.
do $$
begin
	perform pg_temp.base_assert(public.qorpera_interaction_request_valid(pg_temp.cc_connect('gmail')), 'a connect card is valid');
	perform pg_temp.base_assert(public.qorpera_interaction_request_valid(pg_temp.cc_connect('google_drive', repeat('x', 300))),
		'a purpose of 300 bytes is valid');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(pg_temp.cc_connect('gmail', repeat('x', 301))),
		'a purpose over 300 bytes is refused');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(pg_temp.cc_connect('gmail', '')), 'an empty purpose is refused');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(pg_temp.cc_connect('Gmail!')), 'a bad id is refused');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(jsonb_set(pg_temp.cc_connect('gmail'),
		'{payload,connectorId}', 'true')), 'an id that is not a string is refused');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(jsonb_set(pg_temp.cc_connect('gmail'),
		'{payload,scopes}', '["mail"]')), 'an unknown key is refused');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(pg_temp.cc_connect('gmail') #- '{payload,purpose}'),
		'a card without a purpose is refused');
end
$$;

-- 2. The owner's post in Bob's thread becomes a run; the run raises a Gmail and a Google Drive card, and may not raise a
-- malformed one or one for a service outside the catalog.
do $$
declare v_post jsonb; v_pass jsonb; v_run uuid; v_binding jsonb;
begin
	v_post := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Bob, file the invoices from the inbox.');
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_post ->> 0)::uuid;
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run), 'The post is a run: ' || v_pass::text);
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.cc_card(v_binding, '68300000-0000-4000-8000-000000000001', pg_temp.cc_connect('gmail'));
	perform pg_temp.cc_card(v_binding, '68300000-0000-4000-8000-000000000002', pg_temp.cc_connect('google_drive', 'Filing the invoices.'));
	perform pg_temp.base_error(format('select pg_temp.cc_card(%L, %L, %L)', v_binding, '68300000-0000-4000-8000-000000000003',
		pg_temp.cc_connect('slack')), '22023', 'a connect card names a service from the connector catalog');
	perform pg_temp.base_error(format('select pg_temp.cc_card(%L, %L, %L)', v_binding, '68300000-0000-4000-8000-000000000004',
		jsonb_set(pg_temp.cc_connect('gmail'), '{payload,token}', '"x"')), '22023', 'interaction request is invalid');
	-- The payload check gives null, not false, for a takeover without its instruction; the append refuses it all the same.
	perform pg_temp.base_error(format('select pg_temp.cc_card(%L, %L, %L)', v_binding, '68300000-0000-4000-8000-000000000005',
		'{"schema":"qorpera.interaction/v1","surface":"takeover","title":"Sign in","payload":{}}'), '22023', 'interaction request is invalid');
	perform pg_temp.base_assert((select count(*) from public.qorpera_session_events as event
		where event.session_id = current_setting('qorpera_test.cc_thread')::uuid and event.event_type = 'interaction_request'
			and event.body #>> '{entry,data,surface}' = 'connect') = 2, 'the thread holds the two connect cards');
	perform pg_temp.base_public_send(v_binding, 'final', 'cc-final');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'card fixture run ended', false);
end
$$;

-- 3. A connect answer carries nothing and takes only "connected" or "declined"; "connected" is refused while the company
-- has no active Gmail connection of its own (a member's own Gmail and a disconnected company Gmail stand in the vault).
insert into public.qorpera_cloud_secret_broker_authorities (id, profile_id, service_origin, key_id, capability_sha256)
values ('68300000-0000-4000-8000-0000000000b0', '92400000-0000-4000-8000-000000000010', 'https://secrets.example.test', 'key-1',
	repeat('f', 64));
insert into public.qorpera_cloud_secrets (id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, status, current_version, created_by_user_id, revoked_at, revoked_by_user_id)
values
	('68300000-0000-4000-8000-0000000000b1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'68300000-0000-4000-8000-0000000000b0', 'member', '92400000-0000-4000-8000-000000000001', 'gmail', 'primary', 'Email',
		'active', 1, '92400000-0000-4000-8000-000000000001', null, null),
	('68300000-0000-4000-8000-0000000000b2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'68300000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'primary', 'Email',
		'revoked', 1, '92400000-0000-4000-8000-000000000001', statement_timestamp(), '92400000-0000-4000-8000-000000000001');
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select pg_temp.cc_answer(%L, %L, %L)', '68300000-0000-4000-8000-0000000000c1',
		'68300000-0000-4000-8000-000000000001', 'answered'), '22023', 'connect answer is invalid');
	perform pg_temp.base_error(format('select pg_temp.cc_answer(%L, %L, %L, %L)', '68300000-0000-4000-8000-0000000000c2',
		'68300000-0000-4000-8000-000000000001', 'connected', '{"secretId":"68300000-0000-4000-8000-0000000000b1"}'), '22023',
		'connect answer is invalid');
	perform pg_temp.base_error(format('select pg_temp.cc_answer(%L, %L, %L, %L)', '68300000-0000-4000-8000-0000000000c3',
		'68300000-0000-4000-8000-000000000002', 'declined', '{"reason":"later"}'), '22023', 'connect answer is invalid');
	perform pg_temp.base_error(format('select pg_temp.cc_answer(%L, %L, %L)', '68300000-0000-4000-8000-0000000000c4',
		'68300000-0000-4000-8000-000000000001', 'connected'), '55000', 'the company has not connected this service yet');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 4. The company connects Gmail (the broker's work, stood in for here): "connected" now answers, with no answer; Google
-- Drive is skipped. Both join the transcript as the agent reads them.
insert into public.qorpera_cloud_secrets (id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, status, current_version, created_by_user_id)
values ('68300000-0000-4000-8000-0000000000b3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'68300000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'primary', 'Email', 'active', 1,
	'92400000-0000-4000-8000-000000000001');
do $$
declare v_connected jsonb; v_declined jsonb; v_replay jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_connected := pg_temp.cc_answer('68300000-0000-4000-8000-0000000000c5', '68300000-0000-4000-8000-000000000001', 'connected');
	v_replay := pg_temp.cc_answer('68300000-0000-4000-8000-0000000000c5', '68300000-0000-4000-8000-000000000001', 'connected');
	v_declined := pg_temp.cc_answer('68300000-0000-4000-8000-0000000000c6', '68300000-0000-4000-8000-000000000002', 'declined');
	perform pg_temp.base_error(format('select pg_temp.cc_answer(%L, %L, %L)', '68300000-0000-4000-8000-0000000000c7',
		'68300000-0000-4000-8000-000000000001', 'declined'), '55000', 'interaction request is already answered');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_connected ->> 'outcome' = 'connected' and v_replay = v_connected,
		'"connected" answers once the company has Gmail, and a replay returns its receipt: ' || v_connected::text || v_replay::text);
	perform pg_temp.base_assert(v_declined ->> 'outcome' = 'declined', 'a skipped connect card answers: ' || v_declined::text);
	perform pg_temp.base_assert((select jsonb_object_agg(event.body #>> '{entry,data,interactionId}',
			jsonb_build_object('surface', event.body #> '{entry,data,surface}', 'outcome', event.body #> '{entry,data,outcome}',
				'answer', event.body #> '{entry,data,answer}'))
		from public.qorpera_session_events as event
		where event.session_id = current_setting('qorpera_test.cc_thread')::uuid and event.event_type = 'interaction_answer'
			and event.body #>> '{entry,data,interactionId}' like '68300000-%')
		= '{"68300000-0000-4000-8000-000000000001": {"surface": "connect", "outcome": "connected", "answer": {}},
			"68300000-0000-4000-8000-000000000002": {"surface": "connect", "outcome": "declined", "answer": {}}}'::jsonb,
		'both answers joined the transcript as outcomes only');
end
$$;

rollback;
