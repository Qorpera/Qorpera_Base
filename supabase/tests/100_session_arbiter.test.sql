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

-- A non-member must not reach the session surface at all.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_ensure_staff_session(
			current_setting('qorpera_test.sa_environment')::uuid,
			'agent-under-test', 'a1000000-0000-4000-8000-000000000001', 'Agent thread');
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
		'agent-under-test', 'a1000000-0000-4000-8000-000000000002', 'Agent thread')::text, false);
reset role;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.sa_ensure_b',
	public.qorpera_ensure_staff_session(
		current_setting('qorpera_test.sa_environment')::uuid,
		'agent-under-test', 'a1000000-0000-4000-8000-000000000003', 'Agent thread')::text, false);
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
			'a1000000-0000-4000-8000-000000000004', 'Duplicate', 'agent-under-test',
			'80000000-0000-4000-8000-00000000000a');
		raise exception 'a second open session for the agent was inserted';
	exception when unique_violation then null;
	end;
end
$$;

-- Turn discipline: both users enqueue; one claimant gets the whole batch in
-- order; a rival claimant is refused while the turn is in flight; completion
-- reopens the queue; an expired claim is a dead executor and is taken over.
select set_config('qorpera_test.sa_session',
	(current_setting('qorpera_test.sa_ensure_a')::jsonb ->> 'session_id'), false);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000010', 'user_message', '{"text":"from A"}');
reset role;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000011', 'user_message', '{"text":"from B"}');

do $$
declare
	v_session uuid := current_setting('qorpera_test.sa_session')::uuid;
	v_claim jsonb;
	v_rival jsonb;
	v_ok boolean := false;
begin
	-- Duplicate append with the same client id must be idempotent.
	perform public.qorpera_append_session_input(
		v_session, 'a1000000-0000-4000-8000-000000000011', 'user_message', '{"text":"from B"}');
	-- A client must not be able to mint a kickoff.
	begin
		perform public.qorpera_append_session_input(
			v_session, 'a1000000-0000-4000-8000-000000000012', 'kickoff', '{}');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'client enqueued a kickoff'; end if;

	select public.qorpera_claim_session_turn(v_session, 'c1000000-0000-4000-8000-000000000001', 120)
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

	select public.qorpera_claim_session_turn(v_session, 'c2000000-0000-4000-8000-000000000002', 120)
		into v_rival;
	if (v_rival ->> 'claimed')::boolean is distinct from false
		or v_rival ->> 'reason' is distinct from 'turn-in-flight' then
		raise exception 'rival claimant was not refused while the turn is in flight: %', v_rival;
	end if;

	perform public.qorpera_complete_session_turn(v_session, 'c1000000-0000-4000-8000-000000000001');
	select public.qorpera_claim_session_turn(v_session, 'c2000000-0000-4000-8000-000000000002', 120)
		into v_rival;
	if v_rival ->> 'reason' is distinct from 'queue-empty' then
		raise exception 'completed turn did not drain the queue: %', v_rival;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Dead-executor takeover: enqueue, claim, force the lease into the past, and
-- a second claimant must be able to take the turn.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_append_session_input(
	current_setting('qorpera_test.sa_session')::uuid,
	'a1000000-0000-4000-8000-000000000020', 'user_message', '{"text":"orphaned"}');
select public.qorpera_claim_session_turn(
	current_setting('qorpera_test.sa_session')::uuid, 'c1000000-0000-4000-8000-000000000001', 120);
reset role;
select set_config('request.jwt.claims', '', false);

update public.qorpera_session_inputs
set claim_expires_at = statement_timestamp() - interval '1 second'
where session_id = current_setting('qorpera_test.sa_session')::uuid and completed_at is null;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_claim jsonb;
begin
	select public.qorpera_claim_session_turn(
		current_setting('qorpera_test.sa_session')::uuid,
		'c2000000-0000-4000-8000-000000000002', 120) into v_claim;
	if (v_claim ->> 'claimed')::boolean is distinct from true then
		raise exception 'expired claim was not taken over: %', v_claim;
	end if;
	perform public.qorpera_complete_session_turn(
		current_setting('qorpera_test.sa_session')::uuid, 'c2000000-0000-4000-8000-000000000002');
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
			'c3000000-0000-4000-8000-000000000003', 120);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon can claim session turns'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
