-- @fixture 697_runtime_member_who_started_pays.test.sql until "-- A coworker message in the owner's chain"
-- Work handed to an agent runs on the login of the member it works for (20260930701000), on 697's company: the base
-- owner (…001) has a login and Alice's live run on it; the contributor (…002) has connected a login of their own
-- (qorpera_test.pays_sponsor); the viewer (…003) has none. Bob (…031) receives coworker messages from Alice's run, which
-- the owner started.

-- Moves Bob, as the Members page's yes does (the database owner here; 1190 covers the asks).
create function pg_temp.bob_works_for(p_user uuid) returns void language sql as $$
	select public.qorpera_works_for_move((select profile_id from public.qorpera_profile_staff
		where staff_agent_id = '92400000-0000-4000-8000-000000000031'), '92400000-0000-4000-8000-000000000031', p_user)
$$;
-- A coworker message from Alice's run to Bob, and the wake it queued.
create function pg_temp.hand_to_bob(p_key text) returns public.qorpera_wake_occurrences language plpgsql as $$
declare v_send jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.base_binding')::jsonb,
		'92400000-0000-4000-8000-000000000031', p_key, 'Can you check the numbers?');
	if v_send ->> 'status' <> 'queued' then raise exception 'coworker message was not queued: %', v_send; end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	return v_wake;
end $$;

select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','works-ack') \g /dev/null

do $$
declare v_wake public.qorpera_wake_occurrences%rowtype;
	v_owner_binding uuid := (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_member_binding uuid := (current_setting('qorpera_test.pays_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
begin
	-- 1. Bob works for the owner, who started the chain: the chain starter pays, as before.
	perform pg_temp.bob_works_for('92400000-0000-4000-8000-000000000001');
	v_wake := pg_temp.hand_to_bob('works-1');
	if v_wake.requested_by_user_id <> '92400000-0000-4000-8000-000000000001' or v_wake.sponsor_binding_id <> v_owner_binding then
		raise exception 'a hand-off to the owner''s agent left the owner: %', row_to_json(v_wake); end if;

	-- 2. Bob works for the contributor: the hand-off is theirs and runs on their own login, a new run of the same chain.
	perform pg_temp.bob_works_for('92400000-0000-4000-8000-000000000002');
	v_wake := pg_temp.hand_to_bob('works-2');
	if v_wake.requested_by_user_id <> '92400000-0000-4000-8000-000000000002' or v_wake.sponsor_binding_id <> v_member_binding
		or v_wake.parent_run_id <> v_run or v_wake.status <> 'queued' then
		raise exception 'the hand-off did not go to the member Bob works for: %', row_to_json(v_wake); end if;
	if not public.qorpera_wake_authorized(v_wake) then
		raise exception 'the hand-off on the member Bob works for is not authorized'; end if;
	-- The sender's run keeps its payer.
	if (select sponsor_binding_id from public.qorpera_execution_runs where id = v_run) <> v_owner_binding then
		raise exception 'the sending run changed payer'; end if;

	-- 3. Bob works for the viewer, who has no login that may pay: the hand-off stays the chain starter's.
	perform pg_temp.bob_works_for('92400000-0000-4000-8000-000000000003');
	v_wake := pg_temp.hand_to_bob('works-3');
	if v_wake.requested_by_user_id <> '92400000-0000-4000-8000-000000000001' or v_wake.sponsor_binding_id <> v_owner_binding then
		raise exception 'a hand-off moved to a member with no login: %', row_to_json(v_wake); end if;

	-- 4. Bob works for nobody: the same.
	perform pg_temp.bob_works_for(null);
	v_wake := pg_temp.hand_to_bob('works-4');
	if v_wake.requested_by_user_id <> '92400000-0000-4000-8000-000000000001' or v_wake.sponsor_binding_id <> v_owner_binding then
		raise exception 'a hand-off to an agent of nobody left the chain starter: %', row_to_json(v_wake); end if;
end
$$;
