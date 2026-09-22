-- @fixture 150_runner_orchestrator.test.sql until "-- END RECOVERY FIXTURE"
-- Thread interactions: an agent's run raises a typed card, the member answers
-- it once, the answer wakes the agent as an ordinary input and joins the
-- transcript as a member-authored typed event. Secrets never ride along.
select set_config(
	'qorpera_test.interaction_input',
	public.qorpera_append_session_input(
		'15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-000000000590',
		'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"Set up the Slack digest.","images":[]}'
	)::text,
	false
);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
declare
	v_runs jsonb := public.qorpera_materialize_session_execution_runs(32);
	v_run_id uuid;
	v_job_id uuid;
	v_claim jsonb;
	v_assignment jsonb;
	v_event jsonb;
	v_stored public.qorpera_session_events%rowtype;
begin
	if jsonb_array_length(v_runs) <> 1 then
		raise exception 'interaction fixture did not materialize exactly one run: %', v_runs;
	end if;
	v_run_id := (v_runs -> 0 ->> 'run_id')::uuid;
	v_job_id := (v_runs -> 0 ->> 'job_id')::uuid;
	perform set_config('qorpera_test.interaction_run', v_run_id::text, false);
	perform set_config('qorpera_test.interaction_job', v_job_id::text, false);
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000591', 120
	);
	v_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000592', repeat('e', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('e', 64)
	);

	-- A question card, raised by the run as a typed custom entry.
	v_event := public.qorpera_append_runner_transcript_event(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'15000000-0000-4000-8000-000000000593', 'interaction_request',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'custom', 'customType', 'interaction_request',
				'id', '15000000-0000-4000-8000-000000000593',
				'parentId', null,
				'timestamp', '2026-09-22T20:00:00.000Z',
				'data', jsonb_build_object(
					'schema', 'qorpera.interaction/v1',
					'surface', 'question',
					'title', 'Which channel should the digest go to?',
					'payload', jsonb_build_object(
						'options', jsonb_build_array(
							jsonb_build_object('label', '#general', 'value', 'general'),
							jsonb_build_object('label', '#finance', 'value', 'finance', 'style', 'primary')
						)
					)
				),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
				)
			)
		)
	);
	if v_event ->> 'event_type' is distinct from 'interaction_request' then
		raise exception 'interaction request was not appended as its own event type: %', v_event;
	end if;
	select event.* into v_stored from public.qorpera_session_events as event
	where event.event_id = '15000000-0000-4000-8000-000000000593';
	if v_stored.execution_kind is distinct from 'run' or v_stored.execution_id is distinct from v_run_id then
		raise exception 'interaction request lost its run provenance';
	end if;

	-- A secret card and a takeover card that has already expired.
	perform public.qorpera_append_runner_transcript_event(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'15000000-0000-4000-8000-000000000594', 'interaction_request',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'custom', 'customType', 'interaction_request',
				'id', '15000000-0000-4000-8000-000000000594',
				'parentId', '15000000-0000-4000-8000-000000000593',
				'timestamp', '2026-09-22T20:00:01.000Z',
				'data', jsonb_build_object(
					'schema', 'qorpera.interaction/v1',
					'surface', 'secret',
					'title', 'Connect Slack',
					'body', 'To post daily digests to your Slack workspace, provide a bot token.',
					'payload', jsonb_build_object(
						'name', 'slack-bot-token', 'label', 'Slack bot token',
						'purpose', 'Posting the daily digest.', 'kind', 'token'
					)
				),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
				)
			)
		)
	);
	perform public.qorpera_append_runner_transcript_event(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'15000000-0000-4000-8000-000000000595', 'interaction_request',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'custom', 'customType', 'interaction_request',
				'id', '15000000-0000-4000-8000-000000000595',
				'parentId', '15000000-0000-4000-8000-000000000594',
				'timestamp', '2026-09-22T20:00:02.000Z',
				'data', jsonb_build_object(
					'schema', 'qorpera.interaction/v1',
					'surface', 'takeover',
					'title', 'Computer',
					'expiresAt', '2026-09-21T00:00:00.000Z',
					'payload', jsonb_build_object('instruction', 'Sign in to Google Drive.', 'reason', 'sign_in')
				),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
				)
			)
		)
	);
	-- A secret card that names its connector (secrets step, bundle v77).
	perform public.qorpera_append_runner_transcript_event(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'15000000-0000-4000-8000-000000000597', 'interaction_request',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'custom', 'customType', 'interaction_request',
				'id', '15000000-0000-4000-8000-000000000597',
				'parentId', '15000000-0000-4000-8000-000000000595',
				'timestamp', '2026-09-22T20:00:02.500Z',
				'data', jsonb_build_object(
					'schema', 'qorpera.interaction/v1',
					'surface', 'secret',
					'title', 'Connect Linear',
					'payload', jsonb_build_object(
						'name', 'api-key', 'label', 'Linear API key', 'purpose', 'Filing issues.', 'connectorId', 'linear'
					)
				),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
				)
			)
		)
	);
	-- An approval keeps its own event type.
	perform public.qorpera_append_runner_transcript_event(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'15000000-0000-4000-8000-000000000596', 'authorization_request',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'custom', 'customType', 'authorization_request',
				'id', '15000000-0000-4000-8000-000000000596',
				'parentId', '15000000-0000-4000-8000-000000000595',
				'timestamp', '2026-09-22T20:00:03.000Z',
				'data', jsonb_build_object('operation', 'send_invoice', 'summary', 'Send invoice 42 to Acme.'),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
				)
			)
		)
	);

	-- What a run may not raise: a card with an unknown key, a secret request
	-- without a vault name, an approval through the interaction path, a form
	-- whose secret field has nowhere to go, and an answer of its own.
	declare
		v_bad jsonb;
		v_index integer := 0;
	begin
		for v_bad in select value from jsonb_array_elements(jsonb_build_array(
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'question', 'title', 'Q', 'html', '<form>',
				'payload', jsonb_build_object('options', jsonb_build_array(jsonb_build_object('label', 'A')))),
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
				'payload', jsonb_build_object('label', 'Token', 'purpose', 'Posting.')),
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'approval', 'title', 'A',
				'payload', jsonb_build_object('operation', 'send_invoice')),
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'form', 'title', 'Sign in',
				'payload', jsonb_build_object('domain', 'accounts.example.com', 'fields', jsonb_build_array(
					jsonb_build_object('id', 'password', 'label', 'Password', 'type', 'password')))),
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'question', 'title', 'Q',
				'payload', jsonb_build_object('options', '[]'::jsonb)),
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'secret', 'title', 'S',
				'payload', jsonb_build_object('name', '1bad', 'label', 'Token', 'purpose', 'Posting.', 'connectorId', 'Slack!'))
		)) loop
			v_index := v_index + 1;
			begin
				perform public.qorpera_append_runner_transcript_event(
					'15000000-0000-4000-8000-000000000090', repeat('d', 64),
					v_job_id, repeat('e', 64),
					'15000000-0000-4000-8000-000000000592',
					('15000000-0000-4000-8000-0000000005a' || v_index::text)::uuid, 'interaction_request',
					jsonb_build_object(
						'schema', 'qorpera.runner-transcript-entry/v1',
						'entry', jsonb_build_object(
							'type', 'custom', 'customType', 'interaction_request',
							'id', '15000000-0000-4000-8000-0000000005a' || v_index::text,
							'parentId', '15000000-0000-4000-8000-000000000596',
							'timestamp', '2026-09-22T20:00:04.000Z',
							'data', v_bad,
							'execution', jsonb_build_object(
								'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
								'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
							)
						)
					)
				);
				raise exception 'run raised an invalid interaction request (case %): %', v_index, v_bad;
			exception when insufficient_privilege then null;
			end;
		end loop;
	end;
	begin
		perform public.qorpera_append_runner_transcript_event(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('e', 64),
			'15000000-0000-4000-8000-000000000592',
			'15000000-0000-4000-8000-0000000005b0', 'interaction_answer',
			jsonb_build_object(
				'schema', 'qorpera.runner-transcript-entry/v1',
				'entry', jsonb_build_object(
					'type', 'custom', 'customType', 'interaction_answer',
					'id', '15000000-0000-4000-8000-0000000005b0',
					'parentId', '15000000-0000-4000-8000-000000000596',
					'timestamp', '2026-09-22T20:00:05.000Z',
					'data', jsonb_build_object('interactionId', '15000000-0000-4000-8000-000000000593', 'outcome', 'answered'),
					'execution', jsonb_build_object(
						'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
						'runnerAssignmentId', '15000000-0000-4000-8000-000000000592'
					)
				)
			)
		);
		raise exception 'a run answered its own card';
	exception when insufficient_privilege then null;
	end;
	-- The run tells the member what it is waiting for; that closes its turn.
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'cards-ack', 'Setting up the Slack digest.', 'progress'
	);
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64),
		'15000000-0000-4000-8000-000000000592',
		'cards-final', 'I need three things from you before I continue.', 'final'
	);
end
$$;

-- The member answers. Wrong shapes and wrong members are refused; the right
-- answer is queued once and idempotently.
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_session uuid := '15000000-0000-4000-8000-000000000055';
	v_result jsonb;
	v_again jsonb;
	v_inputs jsonb;
begin
	-- Outcome vocabulary is per surface.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c1',
			'15000000-0000-4000-8000-000000000593', 'provided', '{}');
		raise exception 'a question accepted a secret outcome';
	exception when invalid_parameter_value then null;
	end;
	-- A choice must be one of the options unless the card allows free text.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c2',
			'15000000-0000-4000-8000-000000000593', 'answered', '{"values":["#random"]}');
		raise exception 'a question accepted a value outside its options';
	exception when invalid_parameter_value then null;
	end;
	-- A secret answer never carries a value, under any key.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c3',
			'15000000-0000-4000-8000-000000000594', 'provided', '{"value":"xoxb-secret"}');
		raise exception 'a secret answer carried a value';
	exception when invalid_parameter_value then null;
	end;
	-- An expired card cannot be answered.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c4',
			'15000000-0000-4000-8000-000000000595', 'handed_back', '{}');
		raise exception 'an expired takeover was answered';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- An unknown card is refused, not invented.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c5',
			'15000000-0000-4000-8000-0000000005ff', 'answered', '{"values":["general"]}');
		raise exception 'an unknown interaction was answered';
	exception when invalid_parameter_value then null;
	end;

	v_result := public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c6',
		'15000000-0000-4000-8000-000000000593', 'answered', '{"values":["finance"]}');
	if v_result ->> 'outcome' is distinct from 'answered'
		or (v_result ->> 'interaction_id')::uuid is distinct from '15000000-0000-4000-8000-000000000593'::uuid
		or v_result ->> 'input_id' is null then
		raise exception 'the answer was not queued: %', v_result;
	end if;
	perform set_config('qorpera_test.interaction_answer_input', v_result ->> 'input_id', false);
	-- Retrying the same client input returns the same input.
	v_again := public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c6',
		'15000000-0000-4000-8000-000000000593', 'answered', '{"values":["finance"]}');
	if v_again ->> 'input_id' is distinct from v_result ->> 'input_id' then
		raise exception 'an idempotent retry queued a second answer';
	end if;
	-- The same client input with different content is a conflict.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c6',
			'15000000-0000-4000-8000-000000000593', 'declined', '{}');
		raise exception 'a client input id was rebound to a different answer';
	exception when unique_violation then null;
	end;
	-- A second answer to the same card is refused while the first is queued.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c7',
			'15000000-0000-4000-8000-000000000593', 'declined', '{}');
		raise exception 'a queued card was answered twice';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- The queued answer is visible to the thread as an input with its body.
	v_inputs := public.qorpera_list_session_inputs(v_session, 0, 100);
	if not exists (
		select 1 from jsonb_array_elements(v_inputs -> 'items') as input(value)
		where input.value ->> 'input_id' = v_result ->> 'input_id'
			and input.value -> 'body' ->> 'schema' = 'qorpera.interaction-answer/v1'
			and input.value -> 'body' ->> 'outcome' = 'answered'
	) then
		raise exception 'the queued answer was not listed with the thread inputs: %', v_inputs;
	end if;

	-- "Provided" is refused while the company vault has no such secret.
	begin
		perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c8',
			'15000000-0000-4000-8000-000000000594', 'provided', '{}');
		raise exception 'a secret was marked provided without a vault entry';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- Declining a secret needs no vault entry.
	perform public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c8',
		'15000000-0000-4000-8000-000000000594', 'declined', '{}');
	v_result := public.qorpera_answer_interaction(v_session, '15000000-0000-4000-8000-0000000005c9',
		'15000000-0000-4000-8000-000000000596', 'approved', '{"reason":"Invoice checked."}');
	if v_result ->> 'outcome' is distinct from 'approved' then
		raise exception 'the approval was not queued: %', v_result;
	end if;
end
$$;

-- The vault gets the secret (the broker's work, stood in for here), and "provided"
-- then answers with the secret's reference, never a value.
reset role;
insert into public.qorpera_cloud_secret_broker_authorities (id, profile_id, service_origin, key_id, capability_sha256)
values ('15000000-0000-4000-8000-0000000005f5', '15000000-0000-4000-8000-000000000010', 'https://secrets.example.test', 'key-1', repeat('f', 64));
insert into public.qorpera_cloud_secrets (id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, status, current_version, created_by_user_id)
values ('15000000-0000-4000-8000-0000000005f6', '15000000-0000-4000-8000-000000000010', '15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-0000000005f5', 'company', null, 'linear', 'api-key', 'Filing issues.', 'active', 2,
	'15000000-0000-4000-8000-000000000001');
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_result jsonb;
	v_input public.qorpera_session_inputs%rowtype;
begin
	v_result := public.qorpera_answer_interaction('15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-0000000005ca', '15000000-0000-4000-8000-000000000597', 'provided', '{}');
	if v_result ->> 'outcome' is distinct from 'provided' then
		raise exception 'the vault-backed secret was not accepted: %', v_result;
	end if;
	perform set_config('qorpera_test.secret_answer_input', v_result ->> 'input_id', false);
end
$$;

-- Another member with write access is not the thread's member.
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000002","email":"orchestrator-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
begin
	begin
		perform public.qorpera_answer_interaction('15000000-0000-4000-8000-000000000055',
			'15000000-0000-4000-8000-0000000005d1', '15000000-0000-4000-8000-000000000593', 'declined', '{}');
		raise exception 'a member who does not own the thread answered its card';
	exception when insufficient_privilege then null;
	end;
end
$$;

-- The answers reach the agent as inputs of a new run and join the transcript
-- as member-authored typed events on the same hash chain.
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
declare
	v_session uuid := '15000000-0000-4000-8000-000000000055';
	v_run public.qorpera_execution_runs%rowtype;
	v_runs jsonb;
	v_answer_input uuid := current_setting('qorpera_test.interaction_answer_input')::uuid;
	v_event public.qorpera_session_events%rowtype;
	v_previous public.qorpera_session_events%rowtype;
	v_expected_hash text;
begin
	-- The first run is still with its runner; finish it so the queue moves on.
	perform public.qorpera_complete_runner_job_v6(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		current_setting('qorpera_test.interaction_job')::uuid, repeat('e', 64),
		'15000000-0000-4000-8000-0000000005f1',
		'15000000-0000-4000-8000-0000000005f2', null,
		'{
			"schema":"qorpera.runner-result/v1",
			"backend_result":{"status":"ok"},
			"output_count":0,
			"output_bytes":0,
			"publication":null,
			"usage":{
				"schema":"qorpera.runner-usage/v1",
				"execution_ms":10,
				"input_bytes":1024,
				"output_bytes":0,
				"result_bytes":16,
				"limits":{
					"wall_time_ms":60000,
					"memory_bytes":536870912,
					"cpu_millis":1000,
					"max_pids":64,
					"max_input_bytes":1048576,
					"max_output_bytes":1048576,
					"max_result_bytes":4096
				}
			}
		}'
	);
	v_runs := public.qorpera_materialize_session_execution_runs(32);
	if jsonb_array_length(v_runs) <> 1 then
		raise exception 'the answers did not materialize as one run: %', v_runs;
	end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (v_runs -> 0 ->> 'run_id')::uuid;
	if v_run.source_kind is distinct from 'session_turn' or not (v_answer_input = any(v_run.input_ids)) then
		raise exception 'the answer run did not carry the answer input: %', to_jsonb(v_run);
	end if;
	if not exists (
		select 1 from public.qorpera_wake_occurrences as wake
		where wake.run_id = v_run.id and wake.wake_kind = 'human'
	) then
		raise exception 'the answer did not wake the agent as a human wake';
	end if;

	-- Materializing the run already wrote the admitted inputs to the transcript.
	perform set_config('qorpera_test.answer_run_inputs', array_to_string(v_run.input_ids, ','), false);
	select event.* into v_event from public.qorpera_session_events as event where event.event_id = v_answer_input;
	if v_event.event_type is distinct from 'interaction_answer'
		or v_event.actor_user_id is distinct from '15000000-0000-4000-8000-000000000001'::uuid
		or v_event.session_input_id is distinct from v_answer_input
		or v_event.body #>> '{entry,customType}' is distinct from 'interaction_answer'
		or v_event.body #>> '{entry,data,interactionId}' is distinct from '15000000-0000-4000-8000-000000000593'
		or v_event.body #>> '{entry,data,outcome}' is distinct from 'answered'
		or v_event.body #> '{entry,data,answer,values}' is distinct from '["finance"]'::jsonb then
		raise exception 'the answer did not join the transcript as a typed member event: %', to_jsonb(v_event);
	end if;
	select event.* into v_previous from public.qorpera_session_events as event
	where event.session_id = v_session and event.sequence = v_event.sequence - 1;
	v_expected_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous.event_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session, 'sequence', v_event.sequence, 'event_id', v_event.event_id,
			'event_type', 'interaction_answer', 'actor_user_id', v_event.actor_user_id, 'body', v_event.body,
			'session_input_id', v_event.session_input_id, 'created_at', v_event.created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	if v_event.previous_hash is distinct from v_previous.event_hash or v_event.event_hash <> v_expected_hash then
		raise exception 'the answer event broke the hash chain';
	end if;
	-- The approval materialized as a decision the inbox already understands.
	if not exists (
		select 1 from public.qorpera_session_events as event
		where event.session_id = v_session and event.event_type = 'authorization_decision'
			and event.body #>> '{entry,data,requestEventId}' = '15000000-0000-4000-8000-000000000596'
			and event.body #>> '{entry,data,decision}' = 'approved'
	) then
		raise exception 'the approval did not materialize as an authorization decision';
	end if;
	-- A declined secret carries its outcome and nothing else.
	if (select event.body #> '{entry,data,answer}' from public.qorpera_session_events as event
		where event.session_id = v_session and event.event_type = 'interaction_answer'
			and event.body #>> '{entry,data,interactionId}' = '15000000-0000-4000-8000-000000000594') <> '{}'::jsonb then
		raise exception 'the declined secret carried more than its outcome';
	end if;
	-- A provided secret carries the vault reference the kernel found, never a value.
	if (select event.body #> '{entry,data,answer}' from public.qorpera_session_events as event
		where event.session_id = v_session and event.event_type = 'interaction_answer'
			and event.body #>> '{entry,data,interactionId}' = '15000000-0000-4000-8000-000000000597')
		<> '{"secretId": "15000000-0000-4000-8000-0000000005f6", "version": 2}'::jsonb then
		raise exception 'the provided secret did not carry its vault reference';
	end if;
end
$$;

-- Appending the same inputs again changes nothing (the kernel's own path).
reset role;
do $$
declare
	v_session uuid := '15000000-0000-4000-8000-000000000055';
begin
	perform public.qorpera_append_admitted_input_events(
		v_session, string_to_array(current_setting('qorpera_test.answer_run_inputs'), ',')::uuid[]);
	if (select count(*) from public.qorpera_session_events as event
		where event.session_id = v_session and event.event_type in ('interaction_answer', 'authorization_decision')) <> 4 then
		raise exception 'answers were materialized more than once';
	end if;
end
$$;

-- Once materialized, the card stays answered.
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
begin
	begin
		perform public.qorpera_answer_interaction('15000000-0000-4000-8000-000000000055',
			'15000000-0000-4000-8000-0000000005e1', '15000000-0000-4000-8000-000000000593', 'declined', '{}');
		raise exception 'an answered card was answered again';
	exception when object_not_in_prerequisite_state then null;
	end;
end
$$;

rollback;
