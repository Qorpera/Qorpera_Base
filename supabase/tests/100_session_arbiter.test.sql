-- Session arbitration (20260818007000): one open session per staff agent,
-- kickoff exactly once, and turn claims that serialize execution. Exercised
-- as the real client roles; the separation users from 040 are order-coupled
-- fixtures.

-- Owner A creates the profile.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.sa_profile',
	public.qorpera_create_hosted_profile('Session Arbiter QA', 'main', 1) ->> 'profile_id', false);
reset role;
select set_config('request.jwt.claims', '', false);

select set_config('qorpera_test.sa_environment',
	(select environment.id::text from public.qorpera_company_environments as environment
	where environment.profile_id = current_setting('qorpera_test.sa_profile')::uuid limit 1), false);

-- The test uses one content-addressed object as both the tree manifest and a
-- queued image object. Storage's catalog mirror records the authoritative size.
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	current_setting('qorpera_test.sa_profile') || '/' || repeat('a', 64),
	'{"size":128}'
);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
-- The manifest must exist before a revision can be prepared. Publishing then
-- requires a complete reachability graph and an independently restored proof.
select set_config('qorpera_test.sa_snapshot',
	public.qorpera_prepare_company_file_revision(
		current_setting('qorpera_test.sa_environment')::uuid,
		'a9000000-0000-4000-8000-000000000010', null,
		repeat('a', 64), 128, 3, 1, 4
	) ->> 'snapshot_id', false);
select set_config('qorpera_test.sa_graph',
	public.qorpera_begin_object_reachability_graph(
		'company_snapshot', current_setting('qorpera_test.sa_snapshot')::uuid,
		'a9000000-0000-4000-8000-000000000011', repeat('a', 64), 1,
		encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
		1, 128
	) ->> 'graph_id', false);
select public.qorpera_append_object_reachability_entries(
	current_setting('qorpera_test.sa_graph')::uuid,
	jsonb_build_array(jsonb_build_object('sha256', repeat('a', 64), 'bytes', 128))
);
select public.qorpera_complete_object_reachability_graph(current_setting('qorpera_test.sa_graph')::uuid);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select public.qorpera_verify_company_snapshot_closure(
	current_setting('qorpera_test.sa_snapshot')::uuid,
	current_setting('qorpera_test.sa_graph')::uuid,
	'80000000-0000-4000-8000-00000000000a',
	encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
	1, 128, repeat('a', 64), 4,
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);
reset role;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_create_object_restore_proof(
	current_setting('qorpera_test.sa_graph')::uuid,
	'a9000000-0000-4000-8000-000000000012', repeat('a', 64), 4
);
select public.qorpera_publish_company_file_revision(
	current_setting('qorpera_test.sa_environment')::uuid,
	current_setting('qorpera_test.sa_snapshot')::uuid, null
);
reset role;
select set_config('request.jwt.claims', '', false);

insert into public.qorpera_profile_staff (
	profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state,
	created_at, updated_at, updated_by_user_id
) values (
	current_setting('qorpera_test.sa_profile')::uuid,
	'a9000000-0000-4000-8000-000000000001',
	'Agent under test', 'QA', 'Exercise session arbitration.',
	'green', 'round', 'active', 'active',
	statement_timestamp(), statement_timestamp(), '80000000-0000-4000-8000-00000000000a'
);

-- A non-member must not reach the session surface at all.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_ensure_staff_session(
			current_setting('qorpera_test.sa_environment')::uuid,
			'a9000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Agent thread');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'non-member created a staff session'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.sa_profile')::uuid,
	'80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', 'B', 'contributor');

-- The race: A and B "open the agent" with their own client ids. Exactly one
-- session may exist, exactly one creation, exactly one kickoff row.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.sa_ensure_a',
	public.qorpera_ensure_staff_session(
		current_setting('qorpera_test.sa_environment')::uuid,
		'a9000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'Agent thread')::text, false);
reset role;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.sa_ensure_b',
	public.qorpera_ensure_staff_session(
		current_setting('qorpera_test.sa_environment')::uuid,
		'a9000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'Agent thread')::text, false);
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_a jsonb := current_setting('qorpera_test.sa_ensure_a')::jsonb;
	v_b jsonb := current_setting('qorpera_test.sa_ensure_b')::jsonb;
	v_session uuid := (current_setting('qorpera_test.sa_ensure_a')::jsonb ->> 'session_id')::uuid;
	v_seen integer;
begin
	if (v_a ->> 'created')::boolean is distinct from true then
		raise exception 'first ensure did not create';
	end if;
	if (v_b ->> 'created')::boolean is distinct from false then
		raise exception 'second ensure created instead of adopting';
	end if;
	if v_a ->> 'session_id' is distinct from v_b ->> 'session_id' then
		raise exception 'the two machines got different sessions: fork not prevented';
	end if;
	select count(*) into v_seen from public.qorpera_session_inputs
	where session_id = v_session and kind = 'kickoff';
	if v_seen <> 1 then raise exception 'expected exactly one kickoff row, got %', v_seen; end if;

	-- The invariant is structural, not conventional: even a superuser insert
	-- of a second open session for the agent must fail.
	begin
		insert into public.qorpera_shared_sessions
			(profile_id, environment_id, client_session_id, title, staff_agent_id, created_by_user_id)
		values (current_setting('qorpera_test.sa_profile')::uuid,
			current_setting('qorpera_test.sa_environment')::uuid,
			'a1000000-0000-4000-8000-000000000004', 'Duplicate', 'a9000000-0000-4000-8000-000000000001',
			'80000000-0000-4000-8000-00000000000a');
		raise exception 'a second open session for the agent was inserted';
	exception when unique_violation then null;
	end;
end
$$;

-- Turn discipline: both users enqueue; one claimant gets the whole batch in
-- order; a rival claimant is refused while the turn is in flight; completion
-- reopens the queue; an expired claim is quarantined instead of re-executed.
select set_config('qorpera_test.sa_session',
	(current_setting('qorpera_test.sa_ensure_a')::jsonb ->> 'session_id'), false);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000010', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"from A","images":[]}');
reset role;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000011', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"from B","images":[]}');

do $$
declare
	v_session uuid := current_setting('qorpera_test.sa_session')::uuid;
	v_claim jsonb;
	v_rival jsonb;
	v_pending jsonb;
	v_stale jsonb;
	v_receipt jsonb;
	v_receipt_result jsonb;
	v_trail_body jsonb;
	v_ok boolean := false;
begin
	-- Duplicate append with the same client id must be idempotent.
	perform public.qorpera_append_session_input(
		v_session, 'a1000000-0000-4000-8000-000000000011', 'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"from B","images":[]}');
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000011', 'user_message',
			'{"schema":"qorpera.session-prompt/v1","text":"different retry","images":[]}');
		raise exception 'client input id was rebound to different content';
	exception when unique_violation then null;
	end;
	-- A client must not be able to mint a kickoff.
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000012', 'kickoff', '{}');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'client enqueued a kickoff'; end if;
	v_ok := false;
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000013', 'user_message',
			'{"schema":"qorpera.session-prompt/v1","text":"too many","images":[{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"}]}');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'oversized image batch entered the queue'; end if;
	v_ok := false;
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000014', 'user_message',
			'{"schema":"qorpera.session-prompt/v1","text":"bad reference","images":[{}]}');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'malformed image reference entered the queue'; end if;
	v_ok := false;
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000015', 'user_message',
			'{"schema":"qorpera.session-prompt/v1","text":"missing object","images":[{"objectSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","bytes":1,"mediaType":"image/png"}]}');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'unavailable image manifest entered the queue'; end if;
	select public.qorpera_list_session_inputs(v_session) into v_pending;
	if jsonb_array_length(v_pending -> 'items') <> 3
		or v_pending -> 'items' -> 2 ->> 'author_display_name' is distinct from 'B'
		or v_pending -> 'items' -> 2 ->> 'status' is distinct from 'queued'
		or (v_pending ->> 'has_more')::boolean is distinct from false then
		raise exception 'pending queue did not preserve author/status: %', v_pending;
	end if;
	select public.qorpera_claim_session_turn(
		v_session, 'c1000000-0000-4000-8000-000000000001', 120,
		'a9000000-0000-4000-8000-000000000099', 1) into v_stale;
	if v_stale ->> 'reason' is distinct from 'stale-revision' then
		raise exception 'stale Company File revision was allowed to execute: %', v_stale;
	end if;

	select public.qorpera_claim_session_turn(
		v_session, 'c1000000-0000-4000-8000-000000000001', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1)
		into v_claim;
	if (v_claim ->> 'claimed')::boolean is distinct from true then
		raise exception 'claimant one could not claim the turn: %', v_claim;
	end if;
	-- kickoff + A + B, exactly once each, in queue order.
	if jsonb_array_length(v_claim -> 'inputs') <> 3 then
		raise exception 'expected 3 inputs in the turn, got %', jsonb_array_length(v_claim -> 'inputs');
	end if;
	if v_claim -> 'inputs' -> 0 ->> 'kind' is distinct from 'kickoff' then
		raise exception 'kickoff was not first in the turn';
	end if;
	v_trail_body := jsonb_build_object(
		'schema', 'qorpera.shared-trail-entry-part/v1',
		'entryId', 'claimed-output',
		'entryType', 'message',
		'partIndex', 0,
		'partCount', 1,
		'payloadBase64', replace(encode(convert_to(jsonb_build_object(
			'type', 'message',
			'id', 'claimed-output',
			'parentId', null,
			'timestamp', '2026-08-20T00:00:00.000Z',
			'execution', jsonb_build_object(
				'kind', 'turn',
				'id', v_claim ->> 'turn_id',
				'claimantId', 'c1000000-0000-4000-8000-000000000001'
			),
			'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array())
		)::text, 'utf8'), 'base64'), E'\n', '')
	);
	-- Execution provenance is optional, but the closed trail envelope is not.
	v_ok := false;
	begin
		perform public.qorpera_append_account_event(
			v_session, 'a1000000-0000-4000-8000-000000000070',
			'message', '{"role":"assistant","content":"unbound"}'::jsonb, 0
		);
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'malformed trail event entered an active turn'; end if;
	perform public.qorpera_append_account_event(
		v_session, 'a1000000-0000-4000-8000-000000000071',
		'message', v_trail_body, 0,
		'turn', (v_claim ->> 'turn_id')::uuid, 'c1000000-0000-4000-8000-000000000001'
	);
	v_ok := false;
	begin
		perform public.qorpera_append_account_event(
			v_session, 'a1000000-0000-4000-8000-000000000072',
			'message', v_trail_body, 1,
			'turn', (v_claim ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002'
		);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'another claimant appended output to the active turn'; end if;

	select public.qorpera_claim_session_turn(
		v_session, 'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1)
		into v_rival;
	if (v_rival ->> 'claimed')::boolean is distinct from false
		or v_rival ->> 'reason' is distinct from 'turn-in-flight' then
		raise exception 'rival claimant was not refused while the turn is in flight: %', v_rival;
	end if;

	select public.qorpera_begin_operation_receipt(
		'turn', (v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000060',
		'http_request', repeat('f', 64)
	) into v_receipt;
	if (v_receipt ->> 'started')::boolean is distinct from true
		or v_receipt ->> 'status' is distinct from 'executing' then
		raise exception 'durable operation receipt did not start: %', v_receipt;
	end if;
	perform public.qorpera_stage_operation_receipt_objects(
		(v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000060',
		jsonb_build_array(jsonb_build_object('sha256', repeat('a', 64), 'bytes', 128))
	);
	select public.qorpera_complete_operation_receipt(
		(v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000060',
		jsonb_build_object(
			'message', 'sent',
			'cloudManifestSha256', repeat('a', 64),
			'cloudObjects', jsonb_build_array(jsonb_build_object('sha256', repeat('a', 64), 'bytes', 128))
		)
	) into v_receipt_result;
	if v_receipt_result ->> 'message' is distinct from 'sent' then
		raise exception 'durable operation receipt did not complete: %', v_receipt_result;
	end if;
	select public.qorpera_begin_operation_receipt(
		'turn', (v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000060',
		'http_request', repeat('f', 64)
	) into v_receipt;
	if (v_receipt ->> 'started')::boolean is distinct from false
		or v_receipt ->> 'status' is distinct from 'completed'
		or v_receipt -> 'result' ->> 'message' is distinct from 'sent' then
		raise exception 'completed operation receipt was not replayed: %', v_receipt;
	end if;
	begin
		perform public.qorpera_begin_operation_receipt(
			'turn', (v_claim ->> 'turn_id')::uuid,
			'c1000000-0000-4000-8000-000000000001',
			'a1000000-0000-4000-8000-000000000060',
			'http_request', repeat('e', 64)
		);
		raise exception 'operation id was rebound to different input';
	exception when unique_violation then null;
	end;
	perform public.qorpera_begin_operation_receipt(
		'turn', (v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000061',
		'http_request', repeat('d', 64)
	);
	v_ok := false;
	begin
		perform public.qorpera_begin_operation_receipt(
			'turn', (v_claim ->> 'turn_id')::uuid,
			'c1000000-0000-4000-8000-000000000001',
			'a1000000-0000-4000-8000-000000000062',
			'http_request', repeat('c', 64)
		);
	exception when sqlstate '55000' then v_ok := true;
	end;
	if not v_ok then raise exception 'an unresolved receipt did not fence a retry ordinal'; end if;
	v_ok := false;
	begin
		perform public.qorpera_complete_session_turn_v2(
			v_session, (v_claim ->> 'turn_id')::uuid,
			'c1000000-0000-4000-8000-000000000001', 1
		);
	exception when sqlstate '55000' then v_ok := true;
	end;
	if not v_ok then raise exception 'turn completed with an unresolved operation receipt'; end if;
	perform public.qorpera_complete_operation_receipt(
		(v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000061',
		'{"message":"reviewed"}'::jsonb
	);

	perform public.qorpera_complete_session_turn_v2(
		v_session, (v_claim ->> 'turn_id')::uuid,
		'c1000000-0000-4000-8000-000000000001', 1);
	select public.qorpera_claim_session_turn(
		v_session, 'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1)
		into v_rival;
	if v_rival ->> 'reason' is distinct from 'queue-empty' then
		raise exception 'completed turn did not drain the queue: %', v_rival;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- An expired executor is ambiguous: quarantine it for review and never run
-- the same operational input a second time.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000020', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"orphaned","images":[]}');
select set_config('qorpera_test.sa_expired_turn',
	public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c1000000-0000-4000-8000-000000000001', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) ->> 'turn_id', false);
select public.qorpera_begin_operation_receipt(
	'turn', current_setting('qorpera_test.sa_expired_turn')::uuid,
	'c1000000-0000-4000-8000-000000000001',
	'a1000000-0000-4000-8000-000000000063',
	'http_request', repeat('b', 64)
);
reset role;
select set_config('request.jwt.claims', '', false);

update public.qorpera_session_inputs
set claim_expires_at = statement_timestamp() - interval '1 second'
where session_id = current_setting('qorpera_test.sa_session')::uuid and completed_at is null;
update public.qorpera_session_turns
set lease_expires_at = statement_timestamp() - interval '1 second'
where id = current_setting('qorpera_test.sa_expired_turn')::uuid;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_claim jsonb;
	v_expired_completion jsonb;
	v_failed_list jsonb;
	v_recoveries jsonb;
	v_second_batch jsonb;
	v_index integer;
	v_trail_end bigint;
begin
	select coalesce(max(event.sequence), 0) into v_trail_end
	from public.qorpera_session_events as event
	where event.session_id = current_setting('qorpera_test.sa_session')::uuid;
	select public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		current_setting('qorpera_test.sa_expired_turn')::uuid,
		'c1000000-0000-4000-8000-000000000001', v_trail_end) into v_expired_completion;
	if (v_expired_completion ->> 'completed')::integer <> 0 then
		raise exception 'expired claimant completed a turn: %', v_expired_completion;
	end if;
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_claim;
	if (v_claim ->> 'claimed')::boolean is distinct from false
		or v_claim ->> 'reason' is distinct from 'queue-empty' then
		raise exception 'expired ambiguous input was offered for re-execution: %', v_claim;
	end if;
	select public.qorpera_list_session_inputs(
		current_setting('qorpera_test.sa_session')::uuid, 0, 100
	) into v_failed_list;
	if jsonb_array_length(v_failed_list -> 'items') <> 0 then
		raise exception 'terminal failed inputs crowded the active queue: %', v_failed_list;
	end if;
	select public.qorpera_list_session_recoveries(
		current_setting('qorpera_test.sa_session')::uuid, null, null, 10
	) into v_recoveries;
	if jsonb_array_length(v_recoveries -> 'items') <> 1
		or v_recoveries -> 'items' -> 0 ->> 'turn_id' is distinct from current_setting('qorpera_test.sa_expired_turn')
		or v_recoveries -> 'items' -> 0 -> 'inputs' -> 0 -> 'body' ->> 'text' is distinct from 'orphaned'
		or v_recoveries -> 'items' -> 0 -> 'operation_receipts' -> 0 ->> 'status' is distinct from 'ambiguous' then
		raise exception 'expired turn was not exposed for recovery: %', v_recoveries;
	end if;
	perform public.qorpera_append_session_input(
		current_setting('qorpera_test.sa_session')::uuid,
		'a1000000-0000-4000-8000-000000000030', 'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"first images","images":[{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"}]}');
	perform public.qorpera_append_session_input(
		current_setting('qorpera_test.sa_session')::uuid,
		'a1000000-0000-4000-8000-000000000031', 'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"second images","images":[{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"},{"objectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":128,"mediaType":"image/png"}]}');
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_claim;
	if jsonb_array_length(v_claim -> 'inputs') <> 1
		or v_claim -> 'inputs' -> 0 -> 'body' ->> 'text' is distinct from 'first images' then
		raise exception 'image-bounded claim did not preserve row boundaries: %', v_claim;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_claim ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_second_batch;
	if jsonb_array_length(v_second_batch -> 'inputs') <> 1
		or v_second_batch -> 'inputs' -> 0 -> 'body' ->> 'text' is distinct from 'second images' then
		raise exception 'second image batch was lost: %', v_second_batch;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_second_batch ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
	perform public.qorpera_append_session_input(
		current_setting('qorpera_test.sa_session')::uuid,
		'a1000000-0000-4000-8000-000000000040', 'user_message',
		'{"schema":"qorpera.staff-intro-retry/v1"}');
	perform public.qorpera_append_session_input(
		current_setting('qorpera_test.sa_session')::uuid,
		'a1000000-0000-4000-8000-000000000041', 'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"after retry","images":[]}');
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_claim;
	if jsonb_array_length(v_claim -> 'inputs') <> 1
		or v_claim -> 'inputs' -> 0 -> 'body' ->> 'schema' is distinct from 'qorpera.staff-intro-retry/v1' then
		raise exception 'introduction retry consumed a following message: %', v_claim;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_claim ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_second_batch;
	if jsonb_array_length(v_second_batch -> 'inputs') <> 1
		or v_second_batch -> 'inputs' -> 0 -> 'body' ->> 'text' is distinct from 'after retry' then
		raise exception 'message following introduction retry was lost: %', v_second_batch;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_second_batch ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
	for v_index in 1..40 loop
		perform public.qorpera_append_session_input(
			current_setting('qorpera_test.sa_session')::uuid,
			extensions.gen_random_uuid(), 'user_message',
			jsonb_build_object(
				'schema', 'qorpera.session-prompt/v1',
				'text', 'bounded text input ' || v_index,
				'images', '[]'::jsonb
			)
		);
	end loop;
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_claim;
	if jsonb_array_length(v_claim -> 'inputs') <> 32 then
		raise exception 'text-only claim exceeded or missed its 32-row bound: %', v_claim;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_claim ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120,
		current_setting('qorpera_test.sa_snapshot')::uuid, 1) into v_second_batch;
	if jsonb_array_length(v_second_batch -> 'inputs') <> 8 then
		raise exception 'text-only queue remainder was lost: %', v_second_batch;
	end if;
	perform public.qorpera_complete_session_turn_v2(
		current_setting('qorpera_test.sa_session')::uuid,
		(v_second_batch ->> 'turn_id')::uuid, 'c2000000-0000-4000-8000-000000000002', v_trail_end);
end
$$;

-- Enqueue is durably capped per session, while a retry of an existing client
-- input remains idempotent even when the queue is full.
reset role;
insert into public.qorpera_session_inputs (
	session_id, client_input_id, kind, author_user_id, body
)
select
	current_setting('qorpera_test.sa_session')::uuid,
	case when fixture.index = 1
		then 'a1000000-0000-4000-8000-000000000048'::uuid
		else extensions.gen_random_uuid()
	end,
	'user_message',
	'80000000-0000-4000-8000-00000000000a',
	jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'queue-cap-fixture', 'images', '[]'::jsonb)
from generate_series(1, 512) as fixture(index);
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000048', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"queue-cap-fixture","images":[]}');
do $$
declare
	v_rejected boolean := false;
begin
	begin
		perform public.qorpera_append_session_input(
			current_setting('qorpera_test.sa_session')::uuid,
			'a1000000-0000-4000-8000-000000000049', 'user_message',
			'{"schema":"qorpera.session-prompt/v1","text":"beyond durable cap","images":[]}');
	exception when sqlstate '54000' then
		v_rejected := true;
	end;
	if not v_rejected then raise exception 'session queue exceeded its durable cap'; end if;
end
$$;
reset role;
delete from public.qorpera_session_inputs
where session_id = current_setting('qorpera_test.sa_session')::uuid
	and body ->> 'text' = 'queue-cap-fixture';
select set_config('request.jwt.claims', '', false);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_session jsonb;
	v_closed boolean := false;
	v_forgery_rejected boolean := false;
begin
	v_session := public.qorpera_create_shared_session_v4(
		current_setting('qorpera_test.sa_environment')::uuid,
		'a1000000-0000-4000-8000-000000000050',
		'Pinned operational wake',
		'a9000000-0000-4000-8000-000000000001',
		null,
		jsonb_build_object(
			'attended', false,
			'staffAgentId', 'a9000000-0000-4000-8000-000000000001',
			'group', 'job:pinned-wake',
			'companySnapshotId', current_setting('qorpera_test.sa_snapshot'),
			'staffVersion', 1
		),
		current_setting('qorpera_test.sa_snapshot')::uuid,
		1
	);
	if v_session ->> 'company_snapshot_id' is distinct from current_setting('qorpera_test.sa_snapshot')
		or (v_session ->> 'staff_version')::bigint <> 1 then
		raise exception 'operational session lost its execution revisions: %', v_session;
	end if;
	begin
		perform public.qorpera_append_account_event(
			(v_session ->> 'session_id')::uuid,
			'a1000000-0000-4000-8000-000000000053',
			'session_info',
			jsonb_build_object(
				'schema', 'qorpera.shared-trail-entry-part/v1',
				'entryId', 'forged-message',
				'entryType', 'message',
				'partIndex', 0,
				'partCount', 1,
				'payloadBase64', 'e30='
			),
			0
		);
	exception when sqlstate '22023' then
		v_forgery_rejected := true;
	end;
	if not v_forgery_rejected then
		raise exception 'session metadata accepted a message-type envelope';
	end if;
	perform set_config(
		'request.jwt.claims',
		'{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}',
		true
	);
	-- A second member can finish the exact row-derived metadata upload if the
	-- session creator disappears before its desktop submits the redundant event.
	perform public.qorpera_append_account_event(
		(v_session ->> 'session_id')::uuid,
		'a1000000-0000-4000-8000-000000000051',
		'session_info', jsonb_build_object(
			'schema', 'qorpera.shared-session/v1',
			'entry', jsonb_build_object(
				'type', 'session_info',
				'id', 'cloud-session-info:a1000000-0000-4000-8000-000000000050',
				'parentId', null,
				'timestamp', v_session ->> 'created_at',
				'name', 'Pinned operational wake'
			)
		), 0
	);
	perform set_config(
		'request.jwt.claims',
		'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
		true
	);
	perform public.qorpera_close_shared_session((v_session ->> 'session_id')::uuid);
	begin
		perform public.qorpera_append_account_event(
			(v_session ->> 'session_id')::uuid,
			'a1000000-0000-4000-8000-000000000052',
			'session_info', jsonb_build_object(
				'schema', 'qorpera.shared-session/v1',
				'entry', jsonb_build_object(
					'type', 'session_info',
					'id', 'cloud-session-info:a1000000-0000-4000-8000-000000000050',
					'parentId', null,
					'timestamp', v_session ->> 'created_at',
					'name', 'Pinned operational wake'
				)
			), 1
		);
	exception when sqlstate '55000' then v_closed := true;
	end;
	if not v_closed then
		raise exception 'operational trail accepted events after finalization';
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- An authorized member can explicitly discard the quarantined execution;
-- it then leaves the recovery lane without crowding the active FIFO.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_resolved jsonb;
	v_recoveries jsonb;
begin
	perform public.qorpera_resolve_operation_receipt(
		'a1000000-0000-4000-8000-000000000063',
		'confirmed_not_run', null
	);
	v_resolved := public.qorpera_resolve_session_recovery(
		current_setting('qorpera_test.sa_session')::uuid,
		current_setting('qorpera_test.sa_expired_turn')::uuid,
		'discard'
	);
	if v_resolved ->> 'resolution' is distinct from 'discard'
		or (v_resolved ->> 'input_count')::integer <> 1 then
		raise exception 'quarantined turn was not discarded: %', v_resolved;
	end if;
	v_recoveries := public.qorpera_list_session_recoveries(
		current_setting('qorpera_test.sa_session')::uuid, null, null, 10
	);
	if jsonb_array_length(v_recoveries -> 'items') <> 0 then
		raise exception 'resolved turn remained in recovery lane: %', v_recoveries;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Anon holds no grant on any of it.
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_claim_session_turn(
			current_setting('qorpera_test.sa_session')::uuid,
			'c3000000-0000-4000-8000-000000000003', 120,
			current_setting('qorpera_test.sa_snapshot')::uuid, 1);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon can claim session turns'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
