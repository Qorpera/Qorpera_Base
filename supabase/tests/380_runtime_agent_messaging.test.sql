-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Contract 14.6 (amended 2026-09-22): a coworker message is one event in the
-- pair's transcript, a chip in both agents' own threads, and a wake of the
-- recipient in its own thread under the pair policy; the reply is the same
-- thing the other way. Since runtime v92 nothing ends an exchange but a member's
-- Stop (or the company pause): no hop budget and no hourly limit per pair.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.alice_binding',current_setting('qorpera_test.wake_binding'),true);

-- Materialize the one queued wake, start its run and return its binding.
create function pg_temp.wake_run_binding(p_occurrence uuid) returns jsonb language plpgsql as $$
declare v_run uuid;
begin
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = p_occurrence;
	perform pg_temp.wake_assert(v_run is not null,'Coworker wake materialized');
	return pg_temp.wake_start(v_run);
end
$$;
create function pg_temp.thread_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '30000000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
create function pg_temp.pair_session() returns uuid language sql as $$
	select id from public.qorpera_shared_sessions where profile_id = '30000000-0000-4000-8000-000000000010'
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key('30000000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000031')
$$;

savepoint messaging_shape;
do $$
declare v_alice jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_bob jsonb; v_send jsonb; v_wake jsonb;
	v_pair uuid; v_bob_thread uuid; v_alice_thread uuid; v_event jsonb; v_policy jsonb; v_occurrence public.qorpera_wake_occurrences%rowtype;
begin
	-- The sender is a human wake: it acknowledges the member before any other work.
	perform pg_temp.wake_public_send(v_alice,'progress');
	v_send := public.qorpera_send_coworker_message(v_alice,'30000000-0000-4000-8000-000000000031','ask-1','Could you check the note?');
	perform pg_temp.wake_assert(v_send ->> 'status' = 'queued','First message is queued');
	v_pair := pg_temp.pair_session();
	v_bob_thread := pg_temp.thread_session('30000000-0000-4000-8000-000000000031');
	v_alice_thread := pg_temp.thread_session('30000000-0000-4000-8000-000000000030');
	perform pg_temp.wake_assert(v_pair is not null and v_bob_thread is not null and v_alice_thread is not null,'Pair transcript and both threads exist');
	perform pg_temp.wake_assert((select audience_kind = 'company' and staff_agent_id is null and status = 'open'
		and execution_scope -> 'agentPair' = jsonb_build_array('30000000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000031')
		from public.qorpera_shared_sessions where id = v_pair),'Pair transcript is a company-audience session bound to the pair');
	-- The transcript event: spoken by the sender, no run execution identity, no agent_sends row.
	select to_jsonb(event) into v_event from public.qorpera_session_events event where event.session_id = v_pair and event.event_type = 'message';
	perform pg_temp.wake_assert(v_event #>> '{body,entry,delivery,schema}' = 'qorpera.peer-message/v1'
		and v_event #>> '{body,entry,delivery,from}' = '30000000-0000-4000-8000-000000000030'
		and v_event #>> '{body,entry,delivery,to}' = '30000000-0000-4000-8000-000000000031'
		and v_event #>> '{body,entry,message,content,0,text}' = 'Could you check the note?'
		and v_event ->> 'execution_kind' is null and v_event ->> 'event_hash' ~ '^[0-9a-f]{64}$','Peer message is one transcript event by the sender');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_agent_sends where session_id = v_pair),'A peer message is not a public send');
	-- The chips: one in each agent's own thread, without the text.
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events where session_id = v_alice_thread
		and event_type = 'session_info' and body ->> 'schema' = 'qorpera.peer-link/v1' and body ->> 'direction' = 'out'
		and body ->> 'counterpartStaffId' = '30000000-0000-4000-8000-000000000031' and body ->> 'pairSessionId' = v_pair::text
		and not (body ? 'text')),'Sender thread gets a Messaged chip');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events where session_id = v_bob_thread
		and event_type = 'session_info' and body ->> 'schema' = 'qorpera.peer-link/v1' and body ->> 'direction' = 'in'
		and body ->> 'counterpartStaffId' = '30000000-0000-4000-8000-000000000030'),'Recipient thread gets a Message-from chip');
	-- The wake: in the recipient's own thread, first hop, pair policy.
	select * into strict v_occurrence from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	perform pg_temp.wake_assert(v_occurrence.session_id = v_bob_thread and v_occurrence.causal_hop_count = 1
		and v_occurrence.payload ->> 'pairSessionId' = v_pair::text and v_occurrence.payload ->> 'pairEventId' = v_event ->> 'event_id','Wake carries the recipient thread and the transcript identity');
	v_bob := pg_temp.wake_run_binding(v_occurrence.id);
	v_wake := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.wake_assert(v_wake #>> '{audience,sessionId}' = v_bob_thread::text and v_wake #>> '{policy,initial}' = 'forbidden'
		and v_wake #>> '{policy,final}' = 'optional' and v_wake -> 'policy' -> 'maxPublicSends' = 'null'::jsonb and (v_wake #>> '{policy,silenceAllowed}')::boolean
		and v_wake #>> '{actorStaffId}' = '30000000-0000-4000-8000-000000000030','Recipient wakes in its own thread under the pair policy');
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,transcript}') = 1
		and v_wake #>> '{payload,transcript,0,text}' = 'Could you check the note?'
		and v_wake #>> '{payload,transcript,0,staffAgentId}' = '30000000-0000-4000-8000-000000000030','Recipient reads the exchange so far');
	-- The recipient may tell its own thread one thing, and silence is fine.
	perform pg_temp.wake_public_send(v_bob,'final');
	perform public.qorpera_assert_wake_completion((v_bob ->> 'runId')::uuid);
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_agent_sends where session_id = v_bob_thread),'Recipient spoke once in its own thread');
	-- Members read the transcript; the RPC hands back the peer message body.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_assert((select count(*) = 1 from jsonb_array_elements(public.qorpera_read_session_events(v_pair)) item
		where item.value #>> '{body,entry,delivery,schema}' = 'qorpera.peer-message/v1'),'A member reads the pair transcript');
	perform pg_temp.wake_error(format('select public.qorpera_post_company_room_message(%L,%L,%L,null,null)',v_pair,extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"hi"}'),'42501');
	perform pg_temp.path_claims('service_role');
end
$$;
rollback to messaging_shape;

savepoint messaging_budget;
do $$
declare v_binding jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_send jsonb; v_hop integer; v_to uuid; v_pair uuid;
	v_alice uuid := '30000000-0000-4000-8000-000000000030'; v_bob uuid := '30000000-0000-4000-8000-000000000031';
begin
	perform pg_temp.wake_public_send(v_binding,'progress');
	-- No hop budget (runtime v92): eight hops back and forth all go through (the old stop was after six).
	for v_hop in 1..8 loop
		v_to := case when v_hop % 2 = 1 then v_bob else v_alice end;
		v_send := public.qorpera_send_coworker_message(v_binding,v_to,'hop-' || v_hop::text,'Hop ' || v_hop::text);
		perform pg_temp.wake_assert(v_send ->> 'status' = 'queued','Hop ' || v_hop::text || ' is queued');
		perform pg_temp.wake_assert((select causal_hop_count = v_hop and causal_agent_ids[cardinality(causal_agent_ids)] = v_to
			from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid),'Hop ' || v_hop::text || ' counts and ends with the recipient');
		v_binding := pg_temp.wake_run_binding((v_send ->> 'occurrenceId')::uuid);
		perform public.qorpera_assert_wake_completion((v_binding ->> 'runId')::uuid);
	end loop;
	v_pair := pg_temp.pair_session();
	perform pg_temp.wake_assert((select count(*) = 8 from public.qorpera_session_events where session_id = v_pair and event_type = 'message'),'Eight messages in the transcript');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_session_events where session_id = v_pair and event_type = 'session_info'
		and body ->> 'schema' = 'qorpera.peer-budget/v1'),'No budget line stops the exchange');
	-- An agent cannot message itself, and a departed agent closes the transcript.
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L)',v_binding,v_alice,'self','Hello me'),'42501');
end
$$;
rollback to messaging_budget;

savepoint messaging_departure;
do $$
declare v_binding jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_pair uuid;
begin
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','bye-1','One last thing.');
	v_pair := pg_temp.pair_session();
	update public.qorpera_profile_staff set employment_status = 'archived', updated_by_user_id = '30000000-0000-4000-8000-000000000001'
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	perform pg_temp.wake_assert((select status = 'closed' from public.qorpera_shared_sessions where id = v_pair),'A departed agent closes its pair transcripts');
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L)',v_binding,'30000000-0000-4000-8000-000000000031','bye-2','Still there?'),'42501');
end
$$;
rollback to messaging_departure;

savepoint messaging_hourly;
do $$
declare v_binding jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_send jsonb; v_n integer; v_pair uuid;
	v_bob uuid := '30000000-0000-4000-8000-000000000031';
begin
	perform pg_temp.wake_public_send(v_binding,'progress');
	-- No limit per pair per hour (runtime v92): twenty-five messages in an hour all go through (was twenty).
	for v_n in 1..25 loop
		v_send := public.qorpera_send_coworker_message(v_binding,v_bob,'burst-' || v_n::text,'Burst ' || v_n::text);
		perform pg_temp.wake_assert(v_send ->> 'status' = 'queued','Burst ' || v_n::text || ' is queued');
	end loop;
	v_pair := pg_temp.pair_session();
	perform pg_temp.wake_assert((select count(*) = 25 from public.qorpera_session_events where session_id = v_pair and event_type = 'message'),'Twenty-five messages in the transcript');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_session_events where session_id = v_pair and event_type = 'session_info'
		and body ->> 'schema' = 'qorpera.peer-budget/v1'),'No hourly pause line');
end
$$;
rollback to messaging_hourly;

savepoint messaging_legacy;
do $$
declare v_binding jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_send jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_legacy public.qorpera_wake_occurrences%rowtype; v_ancestry jsonb;
begin
	perform pg_temp.wake_public_send(v_binding,'progress');
	v_send := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','first-1','Hello.');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	-- An occurrence admitted before v70 carries hop 0: it keeps the old chain rule and is still authorized.
	v_legacy := jsonb_populate_record(v_wake,'{"causal_hop_count":0}'::jsonb);
	v_ancestry := public.qorpera_coworker_wake_ancestry(v_legacy);
	perform pg_temp.wake_assert(v_ancestry -> 'agentIds' = to_jsonb(v_wake.causal_agent_ids) and (v_ancestry ->> 'rootId')::uuid = v_wake.causal_root_id,
		'A pre-v70 coworker occurrence keeps its ancestry');
	perform pg_temp.wake_assert(public.qorpera_wake_authorized(v_legacy),'A pre-v70 coworker occurrence stays authorized');
	-- Under the old rule a reply to a visited agent was fenced; a hop-0 row addressed to one still is.
	v_legacy := jsonb_populate_record(v_wake,jsonb_build_object('causal_hop_count',0,'staff_agent_id','30000000-0000-4000-8000-000000000030'));
	perform pg_temp.wake_assert(public.qorpera_coworker_wake_ancestry(v_legacy) is null,'A pre-v70 revisit stays fenced');
	-- A wake naming a session that is not the receiver's own thread is refused at admission.
	perform pg_temp.wake_error(format($sql$insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
		parent_run_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
		values(extensions.gen_random_uuid(),%L,%L,'agent','coworker',%L,%L,%L,%L,%L,'coworker','coworker:test:'||extensions.gen_random_uuid()::text,
		clock_timestamp(),clock_timestamp(),%L)$sql$,v_wake.profile_id,v_wake.environment_id,v_wake.staff_agent_id,v_wake.parent_run_id,
		v_wake.sponsor_binding_id,v_wake.sponsor_version,'30000000-0000-4000-8000-000000000040',v_wake.payload),'42501','Coworker thread is unavailable');
end
$$;
rollback to messaging_legacy;

savepoint messaging_chain_rule;
do $$
declare v_sixteen uuid[] := array(select ('30000000-0000-4000-8000-0000000001' || lpad(n::text,2,'0'))::uuid from generate_series(1,16) n);
	v_new uuid := '30000000-0000-4000-8000-000000000199'; v_chain uuid[];
begin
	-- One rule for the send's receipt and admission's fence (runtime v92: no hop or agent count ends a
	-- chain): a seventeenth agent joins, an agent already in it moves to the end, and hops go on.
	perform pg_temp.wake_assert(public.qorpera_coworker_chain(v_sixteen,v_new,2) = v_sixteen || v_new,'A seventeenth agent joins a chain');
	v_chain := public.qorpera_coworker_chain(v_sixteen,v_sixteen[3],2);
	perform pg_temp.wake_assert(cardinality(v_chain) = 16 and v_chain[16] = v_sixteen[3] and v_chain[3] = v_sixteen[4],'A revisit moves the agent to the end of a chain');
	perform pg_temp.wake_assert(public.qorpera_coworker_chain(v_sixteen[1:2],v_new,70) = v_sixteen[1:2] || v_new,'The seventieth hop still continues a chain');
	perform pg_temp.wake_assert(public.qorpera_coworker_chain(v_sixteen[1:2],v_new,0) is null
		and public.qorpera_coworker_chain(v_sixteen[1:2],null,1) is null,'A chain still needs a recipient and a hop');
	perform pg_temp.wake_assert(public.qorpera_coworker_chain(null,v_new,1) = array[v_new],'A chain without a parent starts with the recipient');
end
$$;
rollback to messaging_chain_rule;

savepoint messaging_cross_pair;
do $$
declare v_binding jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_send jsonb; v_hop integer;
	v_alice uuid := '30000000-0000-4000-8000-000000000030'; v_bob uuid := '30000000-0000-4000-8000-000000000031';
	v_carol uuid := '30000000-0000-4000-8000-000000000032'; v_sender_thread uuid; v_sender uuid;
begin
	perform pg_temp.wake_public_send(v_binding,'progress');
	-- Six hops between Alice and Bob, then the run at hop six writes to Carol: with no hop budget
	-- (runtime v92) the chain goes on, a new pair transcript opens and Carol wakes at hop seven.
	for v_hop in 1..6 loop
		v_send := public.qorpera_send_coworker_message(v_binding,case when v_hop % 2 = 1 then v_bob else v_alice end,'relay-' || v_hop::text,'Relay ' || v_hop::text);
		v_binding := pg_temp.wake_run_binding((v_send ->> 'occurrenceId')::uuid);
		perform public.qorpera_assert_wake_completion((v_binding ->> 'runId')::uuid);
	end loop;
	select staff_agent_id into strict v_sender from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	v_send := public.qorpera_send_coworker_message(v_binding,v_carol,'relay-7','Relay 7');
	perform pg_temp.wake_assert(v_send ->> 'status' = 'queued','A long chain can start a new pair');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_shared_sessions where profile_id = '30000000-0000-4000-8000-000000000010'
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key(v_sender,v_carol)),'The new pair has a transcript');
	perform pg_temp.wake_assert((select causal_hop_count = 7 from public.qorpera_wake_occurrences
		where id = (v_send ->> 'occurrenceId')::uuid and staff_agent_id = v_carol),'Carol wakes at hop seven');
end
$$;
rollback to messaging_cross_pair;
