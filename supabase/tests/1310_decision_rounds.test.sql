-- @fixture 1308_decision_votes.test.sql until "savepoint dv_other_company;"
create function pg_temp.dr_data(p_title text, p_again text default null, p_surface text default 'question')
returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', p_surface, 'title', p_title,
		'payload', case when p_surface = 'question'
			then jsonb_build_object('options', '[{"label":"Warm","value":"warm"},{"label":"Cool","value":"cool"}]'::jsonb,
				'allowCustom', true)
			else '{"instruction":"Sign in, then hand back."}'::jsonb end
			|| case when p_again is null then '{}'::jsonb else jsonb_build_object('asksAgain', p_again) end)
$$;
create function pg_temp.dr_card(p_event uuid, p_title text, p_again uuid default null) returns jsonb language sql as $$
	select pg_temp.od_card(current_setting('qorpera_test.od_binding')::jsonb, p_event,
		pg_temp.dr_data(p_title, p_again::text))
$$;
create function pg_temp.dr_refused(p_event uuid, p_again uuid, p_why text) returns void language plpgsql as $$
begin
	perform pg_temp.base_error(format('select pg_temp.dr_card(%L,%L,%L)', p_event, 'Asked again', p_again), '22023',
		'asksAgain must name a question card of this thread that a member answered and that no other card asks again; leave it out otherwise');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_session_events where event_id = p_event),
		'A refused card is not written: ' || p_why);
end $$;
create function pg_temp.dr_answer(p_item uuid, p_values jsonb) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), p_item, 'answered', jsonb_build_object('values', p_values));
	perform pg_temp.base_claims('service_role');
end $$;
create function pg_temp.dr_round(p_user uuid, p_item uuid) returns jsonb language sql as $$
	select decision -> 'round'
	from jsonb_array_elements(pg_temp.dv_list(p_user)) as listed(decision)
	where decision ->> 'id' = p_item::text
$$;
create function pg_temp.dr_listed(p_user uuid, p_item uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(pg_temp.dv_list(p_user)) as listed(decision)
		where decision ->> 'id' = p_item::text)
$$;

do $$
begin
	perform pg_temp.base_assert(public.qorpera_interaction_request_valid(pg_temp.dr_data('Again', '13100000-0000-4000-8000-0000000000a1'))
		and public.qorpera_interaction_request_valid(pg_temp.dr_data('First')),
		'A question may name the card it asks again, and need not');
	perform pg_temp.base_assert(not public.qorpera_interaction_request_valid(pg_temp.dr_data('Again', 'the first one'))
		and not public.qorpera_interaction_request_valid(pg_temp.dr_data('Again', '13100000-0000-4000-8000-0000000000A1'))
		and not public.qorpera_interaction_request_valid(jsonb_set(pg_temp.dr_data('Again'), '{payload,asksAgain}', '7'))
		and not public.qorpera_interaction_request_valid(jsonb_set(pg_temp.dr_data('Again'), '{payload,asksAgain}', 'null'))
		and not public.qorpera_interaction_request_valid(
			pg_temp.dr_data('Sign in', '13100000-0000-4000-8000-0000000000a1', 'takeover')),
		'asksAgain is a lower-case uuid, on a question only');
end
$$;

do $$
declare v jsonb;
begin
	perform pg_temp.dr_card('13100000-0000-4000-8000-0000000000a1', 'Which look?');
	perform pg_temp.base_assert(pg_temp.dr_listed('92400000-0000-4000-8000-000000000001', '13100000-0000-4000-8000-0000000000a1')
		and pg_temp.dr_round('92400000-0000-4000-8000-000000000001', '13100000-0000-4000-8000-0000000000a1') is null,
		'A first question is listed with no round');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a2', '13100000-0000-4000-8000-0000000000a1',
		'the card it names is not answered');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a2', '13100000-0000-4000-8000-0000000000a2',
		'it names itself');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a2', '13100000-0000-4000-8000-0000000000ff',
		'no such card');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a2', '13070000-0000-4000-8000-0000000000d1',
		'an email draft is no question');

	perform pg_temp.dr_answer('13100000-0000-4000-8000-0000000000a1', '["Warmer, with more motion"]');
	perform pg_temp.base_assert(not pg_temp.dr_listed('92400000-0000-4000-8000-000000000001', '13100000-0000-4000-8000-0000000000a1'),
		'The answered first round leaves the list');
	perform pg_temp.base_error(format('select public.qorpera_assert_asks_again(%L,%L,%L)',
		(select session.id from public.qorpera_shared_sessions as session
			where session.id <> current_setting('qorpera_test.card_thread')::uuid limit 1),
		'13100000-0000-4000-8000-0000000000a2', '13100000-0000-4000-8000-0000000000a1'), '22023',
		'asksAgain must name a question card of this thread that a member answered and that no other card asks again; leave it out otherwise');
	perform pg_temp.base_assert((select count(*) > 1 from public.qorpera_shared_sessions),
		'Fixture: there is another thread to ask from');
	perform pg_temp.dr_card('13100000-0000-4000-8000-0000000000a2', 'Which of the warmer looks?',
		'13100000-0000-4000-8000-0000000000a1');
	v := pg_temp.dr_round('92400000-0000-4000-8000-000000000002', '13100000-0000-4000-8000-0000000000a2');
	perform pg_temp.base_assert((v ->> 'number')::int = 2
		and v #>> '{previous,interactionId}' = '13100000-0000-4000-8000-0000000000a1'
		and v #>> '{previous,answeredBy}' = '92400000-0000-4000-8000-000000000001'
		and v #> '{previous,values}' = '["Warmer, with more motion"]'
		and v #>> '{previous,answeredAt}' is not null,
		'Round 2 names the card it asks again and the words that led to it, to another member too: ' || coalesce(v::text, 'null'));
	perform pg_temp.base_assert(pg_temp.dr_round('92400000-0000-4000-8000-000000000001', '13100000-0000-4000-8000-0000000000a2') = v
		and pg_temp.dr_round('92400000-0000-4000-8000-000000000003', '13100000-0000-4000-8000-0000000000a2') = v,
		'The asked member and a spectator read the same round');
	perform pg_temp.base_assert(pg_temp.dr_round('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1') is null,
		'Another open question of the thread has no round');

	perform pg_temp.dr_card('13100000-0000-4000-8000-0000000000a2', 'Which of the warmer looks?',
		'13100000-0000-4000-8000-0000000000a1');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_session_events
		where event_id = '13100000-0000-4000-8000-0000000000a2'), 'A retry of the same card is the same card');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a3', '13100000-0000-4000-8000-0000000000a1',
		'another card already asks it again');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000a3', '13100000-0000-4000-8000-0000000000a2',
		'round 2 is not answered yet');

	perform pg_temp.dr_answer('13100000-0000-4000-8000-0000000000a2', '["Still too dark"]');
	perform pg_temp.dr_card('13100000-0000-4000-8000-0000000000a3', 'Which of the lighter looks?',
		'13100000-0000-4000-8000-0000000000a2');
	v := pg_temp.dr_round('92400000-0000-4000-8000-000000000001', '13100000-0000-4000-8000-0000000000a3');
	perform pg_temp.base_assert((v ->> 'number')::int = 3
		and v #>> '{previous,interactionId}' = '13100000-0000-4000-8000-0000000000a2'
		and v #> '{previous,values}' = '["Still too dark"]',
		'Round 3 counts the whole chain and names round 2: ' || coalesce(v::text, 'null'));
end
$$;

savepoint dr_declined;
do $$
begin
	perform pg_temp.dr_card('13100000-0000-4000-8000-0000000000b1', 'Which font?');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '13100000-0000-4000-8000-0000000000b1', 'declined', '{}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.dr_refused('13100000-0000-4000-8000-0000000000b2', '13100000-0000-4000-8000-0000000000b1',
		'a declined card was not answered');
end
$$;
rollback to savepoint dr_declined;

do $$
declare v_signature text;
begin
	foreach v_signature in array array['public.qorpera_assert_asks_again(uuid, uuid, uuid)',
		'public.qorpera_decision_round(uuid, uuid)']
	loop
		perform pg_temp.base_assert(not has_function_privilege('authenticated', v_signature, 'execute')
			and not has_function_privilege('anon', v_signature, 'execute')
			and not has_function_privilege('service_role', v_signature, 'execute'), v_signature || ' is internal');
	end loop;
	foreach v_signature in array array['public.qorpera_interaction_request_valid(jsonb)',
		'public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
		'public.qorpera_list_company_open_decisions(uuid)']
	loop
		perform pg_temp.base_assert((select proconfig = array['search_path=""'] from pg_proc
			where oid = v_signature::regprocedure), v_signature || ' keeps its empty search path');
	end loop;
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_company_open_decisions(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_company_open_decisions(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)', 'execute'),
		'The patched functions keep their grants');
end
$$;

rollback;
