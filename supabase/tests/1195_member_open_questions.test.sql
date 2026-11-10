-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- Only the member the card was raised for answers it"
-- 20260930706000: the open question cards a member answers, across the company's agent threads, for the interface app
-- page and the Concepts viewer. 596's fixture: Bob's thread, where the owner's post was answered with question card
-- 9a1, raised for the owner, and the run ended. Covered:
-- 1. The owner's list: the card, its thread, its agent and its card body; nobody else's list has it (the member who
--    shares the thread, the viewer), and someone who is no member, anon, and service_role are refused.
-- 2. Only open question cards: a card past its time, and a card of another surface, are not listed; the newest first.
-- 3. An answer takes the card off the list at once, while the others stay.
-- 4. An archived thread, or a member who left it, lists nothing.
-- 5. The two partial indexes, the privileges and the marker.

create function pg_temp.oq_list(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_list_member_open_questions('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.open-questions/v1' and jsonb_typeof(v -> 'questions') = 'array',
		'The list''s shape: ' || v::text);
	return v -> 'questions';
end $$;
create function pg_temp.oq_ids(p_user uuid) returns text[] language sql as $$
	select coalesce(array_agg(question ->> 'interactionId' order by ordinality), '{}')
	from jsonb_array_elements(pg_temp.oq_list(p_user)) with ordinality as listed(question, ordinality)
$$;
create function pg_temp.oq_card(p_binding jsonb, p_event uuid, p_data jsonb) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;

-- 1. Whose list has the card.
do $$
declare v jsonb := pg_temp.oq_list('92400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.base_assert(jsonb_array_length(v) = 1
		and v #>> '{0,interactionId}' = '59600000-0000-4000-8000-0000000009a1'
		and v #>> '{0,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #>> '{0,staffAgentId}' = '92400000-0000-4000-8000-000000000031'
		and v #>> '{0,actorUserId}' = '92400000-0000-4000-8000-000000000001'
		and v #>> '{0,body,entry,data,title}' = 'Which channel should the digest go to?'
		and v #> '{0,body,entry,data,payload,options,1,value}' = '"finance"'::jsonb
		and (v #>> '{0,sequence}')::bigint > 0 and (v #>> '{0,createdAt}')::timestamptz is not null,
		'The owner''s list has the card raised for them, with its thread, agent and body: ' || v::text);
	perform pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000002') = '{}',
		'The member who shares the thread does not answer the owner''s card');
	perform pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000003') = '{}', 'A viewer answers nothing');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_questions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Questions unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_questions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Questions unavailable');
end
$$;
do $$
begin
	perform pg_temp.base_claims('anon');
	set local role anon;
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_questions('92400000-0000-4000-8000-000000000010')$q$,
		'42501');
	reset role;
	perform pg_temp.base_claims('service_role');
end
$$;

-- 2. Only open question cards, newest first: a second run in the thread raises a question past its time, a takeover
-- card, and a newer question.
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, show me the digest designs.');
	perform pg_temp.oq_card(v_binding, '59600000-0000-4000-8000-0000000009b1',
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Old question","expiresAt":"2020-01-01T00:00:00Z",
			"payload":{"options":[{"label":"Yes"}]}}');
	perform pg_temp.oq_card(v_binding, '59600000-0000-4000-8000-0000000009b2',
		'{"schema":"qorpera.interaction/v1","surface":"takeover","title":"Sign in to Slack",
			"payload":{"instruction":"Sign in, then hand back."}}');
	perform pg_temp.oq_card(v_binding, '59600000-0000-4000-8000-0000000009b3',
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which digest design?",
			"payload":{"options":[{"label":"Calm","preview":"app:digest-calm"},{"label":"Bold","preview":"app:digest-bold"}]}}');
	perform pg_temp.base_public_send(v_binding, 'final', 'oq-final');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'open questions fixture run ended', false);
	perform pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001')
		= array['59600000-0000-4000-8000-0000000009b3', '59600000-0000-4000-8000-0000000009a1'],
		'Open questions only, newest first: ' || pg_temp.oq_list('92400000-0000-4000-8000-000000000001')::text);
end
$$;

-- 4. An archived thread, or a member who left it, lists nothing.
savepoint oq_archived;
update public.qorpera_company_rooms set status = 'archived' where id = current_setting('qorpera_test.card_room')::uuid;
select pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001') = '{}', 'An archived thread lists nothing');
rollback to savepoint oq_archived;
savepoint oq_left;
update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
	and principal_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001') = '{}', 'A member who left the thread sees none');
rollback to savepoint oq_left;
savepoint oq_closed;
update public.qorpera_shared_sessions set status = 'closed' where id = current_setting('qorpera_test.card_thread')::uuid;
select pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001') = '{}', 'A closed conversation lists nothing');
rollback to savepoint oq_closed;

-- 3. The owner answers the newer question as the app page does (qorpera_answer_interaction): it leaves the list at once.
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009b3', 'answered', '{"values":["Bold"]}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001') = array['59600000-0000-4000-8000-0000000009a1'],
		'An answered card leaves the list; the other stays');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1', 'declined', '{}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.oq_ids('92400000-0000-4000-8000-000000000001') = '{}', 'A skipped card leaves the list too');
end
$$;

-- 5. Indexes, privileges, marker.
do $$
begin
	perform pg_temp.base_assert((select indexdef from pg_indexes where indexname = 'qorpera_session_events_interaction_requests')
		like '%(session_id, sequence) WHERE (event_type = ''interaction_request''::text)', 'The requests index is partial');
	perform pg_temp.base_assert((select indexdef from pg_indexes where indexname = 'qorpera_session_events_interaction_answers')
		like '%WHERE (event_type = ANY (ARRAY[''interaction_answer''::text, ''authorization_decision''::text]))',
		'The answers index is partial');
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_member_open_questions(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_member_open_questions(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_list_member_open_questions(uuid)', 'execute'),
		'Members execute it; anon and service_role do not');
	perform pg_temp.base_assert((select prosecdef and provolatile = 's' and proconfig = array['search_path=""']
		and prosrc like '%20260930706000%' from pg_proc
		where oid = 'public.qorpera_list_member_open_questions(uuid)'::regprocedure), 'A stable definer read with the marker');
end
$$;

-- The fixture's rows go with the test.
rollback;
