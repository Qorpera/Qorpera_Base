-- @fixture 1308_decision_votes.test.sql until "savepoint dv_other_company;"
create function pg_temp.sp_send(p_user uuid, p_answer jsonb, p_outcome text default 'answered',
	p_interaction uuid default '59600000-0000-4000-8000-0000000009a1')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := pg_temp.cd_answer(extensions.gen_random_uuid(), p_interaction, p_outcome, p_answer);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.sp_refused(p_user uuid, p_answer jsonb, p_state text, p_message text,
	p_outcome text default 'answered', p_interaction uuid default '59600000-0000-4000-8000-0000000009a1')
returns void language plpgsql as $$
declare v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_claims('authenticated', p_user);
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L)', v_client, p_interaction, p_outcome, p_answer),
		p_state, p_message);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_session_inputs where client_input_id = v_client)
		and not exists (select 1 from public.qorpera_session_events
			where session_id = current_setting('qorpera_test.card_thread')::uuid and event_type = 'interaction_answer'),
		'A refused answer records nothing');
end $$;

select pg_temp.base_assert(
	(select choice from public.qorpera_decision_votes where item_id = '59600000-0000-4000-8000-0000000009a1'
		and user_id = '92400000-0000-4000-8000-000000000001') = 'finance'
	and (select choice from public.qorpera_decision_votes where item_id = '59600000-0000-4000-8000-0000000009a1'
		and user_id = '92400000-0000-4000-8000-000000000002') = 'general',
	'Fixture: the owner, whom the card was raised for, voted finance; the contributor voted general');

select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["general"]}', '42501',
	'Only the member this card was raised for can answer it');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["finance","general"]}', '42501',
	'Only the member this card was raised for can answer it');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{}', '42501',
	'Only the member this card was raised for can answer it', 'declined');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["finance"],"more":true}', '42501',
	'Only the member this card was raised for can answer it');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["finance"]}', '42501',
	'Room sponsor is unavailable');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000004', '{"values":["finance"]}', '42501',
	'Room sponsor is unavailable');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000003', '{"values":["finance"]}', '42501',
	'session write access is required');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["Digest"]}', '42501',
	'Only the member this card was raised for can answer it', 'answered', '13070000-0000-4000-8000-0000000000d1');

savepoint sp_changed_vote;
select pg_temp.dv_cast('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1', 'general', null);
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["finance"]}', '42501',
	'Only the member this card was raised for can answer it');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["general"]}', '42501',
	'Room sponsor is unavailable');
select pg_temp.dv_cast('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1', null, 'Not sure yet.');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["general"]}', '42501',
	'Only the member this card was raised for can answer it');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["finance"]}', '42501',
	'Only the member this card was raised for can answer it');
rollback to savepoint sp_changed_vote;

savepoint sp_other_cards;
do $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_decision_votes(profile_id, item_id, user_id, choice)
	values ('92400000-0000-4000-8000-000000000010', '13070000-0000-4000-8000-0000000000d1',
			'92400000-0000-4000-8000-000000000001', 'Digest'),
		('92400000-0000-4000-8000-000000000010', '13070000-0000-4000-8000-0000000000b1',
			'92400000-0000-4000-8000-000000000001', 'Yes');
	set local session_replication_role = origin;
end
$$;
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["Digest"]}', '42501',
	'Only the member this card was raised for can answer it', 'answered', '13070000-0000-4000-8000-0000000000d1');
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["Yes"]}', '55000',
	'interaction request has expired', 'answered', '13070000-0000-4000-8000-0000000000b1');
rollback to savepoint sp_other_cards;

savepoint sp_left_thread;
create function pg_temp.sp_is_pick(p_answerer uuid, p_answer jsonb) returns boolean language sql as $$
	select public.qorpera_is_decision_pick('92400000-0000-4000-8000-000000000010',
		'59600000-0000-4000-8000-0000000009a1', p_answerer,
		(select body from public.qorpera_session_events where event_id = '59600000-0000-4000-8000-0000000009a1'),
		'answered', p_answer)
$$;
select pg_temp.base_assert(pg_temp.sp_is_pick('92400000-0000-4000-8000-000000000002', '{"values":["general"]}')
	and not pg_temp.sp_is_pick('92400000-0000-4000-8000-000000000002', '{"values":["finance"]}')
	and not pg_temp.sp_is_pick('92400000-0000-4000-8000-000000000004', '{"values":["general"]}'),
	'A pick is the one option that member voted for; a member with no vote has none');
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
select pg_temp.base_assert(not pg_temp.sp_is_pick('92400000-0000-4000-8000-000000000002', '{"values":["general"]}'),
	'The vote of a member who is a spectator now is no pick to send');
rollback to savepoint sp_left_thread;

savepoint sp_own_login;
update public.qorpera_execution_sponsor_bindings set created_by_user_id = '92400000-0000-4000-8000-000000000002'
where id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
update public.qorpera_provider_connections set owner_user_id = '92400000-0000-4000-8000-000000000002'
where id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
select pg_temp.sp_refused('92400000-0000-4000-8000-000000000002', '{"values":["general"]}', '42501',
	'Only the member this card was raised for can answer it');
do $$
declare v_thread uuid := current_setting('qorpera_test.card_thread')::uuid; v_answer jsonb; v_retry jsonb;
	v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	v_answer := pg_temp.cd_answer(v_client, '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	v_retry := pg_temp.cd_answer(v_client, '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_retry ->> 'input_id' = v_answer ->> 'input_id'
		and (select count(*) = 1 from public.qorpera_session_inputs where client_input_id = v_client),
		'The sender''s retry of the same send returns the first receipt and records nothing more');
	select * into strict v_input from public.qorpera_session_inputs where id = (v_answer ->> 'input_id')::uuid;
	perform pg_temp.base_assert(v_input.author_user_id = '92400000-0000-4000-8000-000000000002'
		and v_input.completed_at is not null, 'The one who sends the pick is the answer''s author');
	select * into strict v_event from public.qorpera_session_events where event_id = v_input.id;
	perform pg_temp.base_assert(v_event.session_id = v_thread and v_event.event_type = 'interaction_answer'
		and v_event.actor_user_id = '92400000-0000-4000-8000-000000000002'
		and v_event.body #>> '{entry,data,interactionId}' = '59600000-0000-4000-8000-0000000009a1'
		and v_event.body #> '{entry,data,answer,values}' = '["finance"]'::jsonb,
		'The owner''s pick joins the transcript as the sender''s answer: ' || v_event.body::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'room' and source_id = v_input.id;
	perform pg_temp.base_assert(v_wake.requested_by_user_id = '92400000-0000-4000-8000-000000000002'
		and v_wake.sponsor_binding_id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,
		'The agent is woken for the sender, on the sender''s own login');
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.wake_kind = 'room'
		and v_wake.staff_agent_id = '92400000-0000-4000-8000-000000000031'
		and (select count(*) = 1 from public.qorpera_wake_occurrences where source_id = v_input.id),
		'One pick, one wake of the thread''s agent, queued behind the work it is in');
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001') not like '%question%'
		and pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') not like '%question%'
		and pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') not like '%question%',
		'A sent pick answers the question: it leaves the company''s list for the asked member and the sender, and the asked member''s own list');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select pg_temp.cd_answer(%L,%L,%L,%L)', extensions.gen_random_uuid(),
		'59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}'), '55000',
		'interaction request is already answered');
	perform pg_temp.base_claims('service_role');
end
$$;
rollback to savepoint sp_own_login;

do $$
declare v_answer jsonb;
begin
	v_answer := pg_temp.sp_send('92400000-0000-4000-8000-000000000001', '{"values":["general"]}');
	perform pg_temp.base_assert((select author_user_id = '92400000-0000-4000-8000-000000000001'
		from public.qorpera_session_inputs where id = (v_answer ->> 'input_id')::uuid),
		'The member the card was raised for still answers as they like, whatever they voted');
end
$$;

do $$
begin
	perform pg_temp.base_assert(
		not has_function_privilege('authenticated', 'public.qorpera_is_decision_pick(uuid, uuid, uuid, jsonb, text, jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_is_decision_pick(uuid, uuid, uuid, jsonb, text, jsonb)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_is_decision_pick(uuid, uuid, uuid, jsonb, text, jsonb)', 'execute'),
		'The pick check is internal');
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)'::regprocedure),
		'The patched answer function is still a definer function with an empty search path');
	perform pg_temp.base_assert(has_function_privilege('authenticated',
			'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)', 'execute'),
		'and keeps its grants');
end
$$;

rollback;
