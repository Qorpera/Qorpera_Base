-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Secret cards in an agent's own thread on folder-v2: a run cannot raise a secret card with no vault name, a bad name or
-- connector, a repository that is not a coding value's or a coding value's name the capture refuses (20260930693000), or a form whose password field has nowhere to go; a "provided" answer never carries a value, needs the
-- secret in the company vault, and joins the transcript with the vault reference only (ported from snapshot-v1 in the
-- legacy sweep).
create function pg_temp.ti_card(p_binding jsonb, p_event uuid, p_data jsonb) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
-- The owner's answer in Bob's thread, on the owner's sponsor.
create function pg_temp.ti_answer(p_client uuid, p_interaction uuid, p_outcome text, p_answer jsonb) returns jsonb language sql as $$
	select public.qorpera_answer_interaction(current_setting('qorpera_test.ti_thread')::uuid, p_client, p_interaction, p_outcome,
		p_answer, (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1)
$$;

select set_config('qorpera_test.ti_thread', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')), true) \g /dev/null

-- The owner's post in Bob's thread becomes a run; the run raises two secret cards, and may not raise malformed ones.
do $$
declare v_post jsonb; v_pass jsonb; v_run uuid; v_binding jsonb; v_bad jsonb; v_index integer := 0;
begin
	v_post := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Bob, set up the Slack digest.');
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_post ->> 0)::uuid;
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run), 'The post is a run: ' || v_pass::text);
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.ti_card(v_binding, '59000000-0000-4000-8000-000000000594',
		'{"schema":"qorpera.interaction/v1","surface":"secret","title":"Connect Slack",
			"body":"To post daily digests to your Slack workspace, provide a bot token.",
			"payload":{"name":"slack-bot-token","label":"Slack bot token","purpose":"Posting the daily digest.","kind":"token"}}');
	perform pg_temp.ti_card(v_binding, '59000000-0000-4000-8000-000000000597',
		'{"schema":"qorpera.interaction/v1","surface":"secret","title":"Connect Linear",
			"payload":{"name":"api-key","label":"Linear API key","purpose":"Filing issues.","connectorId":"linear"}}');
	-- A coding value (20260930693000): the connector environment, a name a coding value may have, and the repository
	-- whose coding sessions need it.
	perform pg_temp.ti_card(v_binding, '59000000-0000-4000-8000-000000000598',
		'{"schema":"qorpera.interaction/v1","surface":"secret","title":"Token for private packages",
			"payload":{"name":"npm_token","label":"NPM_TOKEN","purpose":"Installs the private packages.","kind":"token",
				"connectorId":"environment","repository":"acme/web"}}');
	for v_bad in select value from jsonb_array_elements(jsonb_build_array(
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('label', 'Token', 'purpose', 'Posting.')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'form', 'title', 'Sign in',
			'payload', jsonb_build_object('domain', 'accounts.example.com', 'fields', jsonb_build_array(
				jsonb_build_object('id', 'password', 'label', 'Password', 'type', 'password')))),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', '1bad', 'label', 'Token', 'purpose', 'Posting.', 'connectorId', 'Slack!')),
		-- A repository only for a coding value, and only owner/name in lower case; a coding value's name as the capture
		-- takes it (no PATH, no git_*, no hyphen).
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'api-key', 'label', 'Key', 'purpose', 'Filing.', 'connectorId', 'linear',
				'repository', 'acme/web')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'api-key', 'label', 'Key', 'purpose', 'Filing.', 'repository', 'acme/web')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'npm_token', 'label', 'Token', 'purpose', 'Packages.',
				'connectorId', 'environment', 'repository', 'Acme/Web')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'npm_token', 'label', 'Token', 'purpose', 'Packages.',
				'connectorId', 'environment', 'repository', 'acme')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'path', 'label', 'Path', 'purpose', 'Packages.',
				'connectorId', 'environment')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'git_token', 'label', 'Token', 'purpose', 'Packages.',
				'connectorId', 'environment')),
		jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
			'payload', jsonb_build_object('name', 'npm-token', 'label', 'Token', 'purpose', 'Packages.',
				'connectorId', 'environment'))
	)) loop
		v_index := v_index + 1;
		perform pg_temp.base_error(format('select pg_temp.ti_card(%L, %L, %L)', v_binding,
			'59000000-0000-4000-8000-000000000' || (600 + v_index)::text, v_bad), '22023', 'interaction request is invalid');
	end loop;
	perform pg_temp.base_public_send(v_binding, 'final', 'ti-final');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'card fixture run ended', false);
end
$$;

-- A secret answer never carries a value, and "provided" is refused while the company vault has no such secret.
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select pg_temp.ti_answer(%L, %L, %L, %L)', '59000000-0000-4000-8000-0000000005c3',
		'59000000-0000-4000-8000-000000000594', 'provided', '{"value":"xoxb-secret"}'), '22023');
	perform pg_temp.base_error(format('select pg_temp.ti_answer(%L, %L, %L, %L)', '59000000-0000-4000-8000-0000000005c8',
		'59000000-0000-4000-8000-000000000594', 'provided', '{}'), '55000');
end
$$;

-- The vault gets the secret (the broker's work, stood in for here); "provided" then answers with its reference only.
insert into public.qorpera_cloud_secret_broker_authorities (id, profile_id, service_origin, key_id, capability_sha256)
values ('59000000-0000-4000-8000-0000000005f5', '92400000-0000-4000-8000-000000000010', 'https://secrets.example.test', 'key-1',
	repeat('f', 64));
insert into public.qorpera_cloud_secrets (id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, status, current_version, created_by_user_id)
values ('59000000-0000-4000-8000-0000000005f6', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'59000000-0000-4000-8000-0000000005f5', 'company', null, 'linear', 'api-key', 'Filing issues.', 'active', 2,
	'92400000-0000-4000-8000-000000000001');
do $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_result := pg_temp.ti_answer('59000000-0000-4000-8000-0000000005ca', '59000000-0000-4000-8000-000000000597', 'provided', '{}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_result ->> 'outcome' = 'provided', 'the vault-backed secret was not accepted: ' || v_result::text);
	perform pg_temp.base_assert((select event.body #> '{entry,data,answer}' from public.qorpera_session_events as event
		where event.session_id = current_setting('qorpera_test.ti_thread')::uuid and event.event_type = 'interaction_answer'
			and event.body #>> '{entry,data,interactionId}' = '59000000-0000-4000-8000-000000000597')
		= '{"secretId": "59000000-0000-4000-8000-0000000005f6", "version": 2}'::jsonb,
		'the provided secret did not carry its vault reference');
end
$$;

rollback;
