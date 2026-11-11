-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- Only the member the card was raised for answers it"
-- 20260930723000: what each agent's work waits on the calling member for, for the rail and the tab title. 596's fixture:
-- Bob's thread, where the owner's post was answered with question card 9a1, raised for the owner, and the run ended.
-- Covered:
-- 1. The owner's list names Bob with the card: its thread, kind, time and title; nobody else's has it (the member who
--    shares the thread, the viewer, the admin), and someone who is no member, anon and service_role are refused.
-- 2. A second run in the thread raises a takeover card and a card past its time, and asks for two approvals (the
--    owner's own, and the company's, which an owner or admin answers): every open item counts, the newest is Bob's
--    "what" (cut to 120 characters), and the admin sees the company's approval only.
-- 3. What the member may not read or no longer answers is not listed: a thread they left, an archived thread, a closed
--    conversation; another company's list has none of it; an email draft the member sent, also when its answer was
--    lost.
-- 4. Answers take the items off at once, the rest stay, and with all answered Bob is listed for nobody.
-- 5. Privileges and the marker.

create function pg_temp.wm_list(p_user uuid, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_list_member_waiting_work(p_profile);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.member-waiting-work/v1' and jsonb_typeof(v -> 'agents') = 'array',
		'The list''s shape: ' || v::text);
	return v -> 'agents';
end $$;
-- Bob's entry in a member's list, or null.
create function pg_temp.wm_bob(p_user uuid) returns jsonb language sql as $$
	select agent from jsonb_array_elements(pg_temp.wm_list(p_user)) as listed(agent)
	where agent ->> 'staffAgentId' = '92400000-0000-4000-8000-000000000031'
$$;
create function pg_temp.wm_card(p_binding jsonb, p_event uuid, p_data jsonb) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
-- An approval the run asks for; a built-in check makes it the company's (owners and admins answer it).
create function pg_temp.wm_ask(p_binding jsonb, p_call text, p_digest text, p_title text, p_built_in text default 'none')
returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'send_email',
		'effect', 'external', 'argumentSha256', p_digest,
		'action', jsonb_build_object('title', p_title, 'target', 'bob@acme.test'),
		'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', p_built_in,
		'reason', 'It writes to someone outside the company.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.wm_answer_review(p_user uuid, p_review uuid) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_answer_action_review(p_review, extensions.gen_random_uuid(), 'allow_once', null,
		v_base.sponsor_binding_id, v_base.sponsor_version);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;

-- 1. Whose list has the card.
do $$
declare v jsonb := pg_temp.wm_list('92400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.base_assert(jsonb_array_length(v) = 1
		and v #>> '{0,staffAgentId}' = '92400000-0000-4000-8000-000000000031'
		and v #>> '{0,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #> '{0,count}' = '1' and v #> '{0,questions}' = '1' and v #> '{0,approvals}' = '0'
		and v #>> '{0,kind}' = 'question' and v #>> '{0,what}' = 'Which channel should the digest go to?'
		and (v #>> '{0,latestAt}')::timestamptz is not null,
		'The owner''s list names Bob with the card raised for them: ' || v::text);
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000002') = '[]',
		'The member who shares the thread does not answer the owner''s card');
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000003') = '[]', 'A viewer answers nothing');
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000004') = '[]',
		'An admin does not answer the owner''s card');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error($q$select public.qorpera_list_member_waiting_work('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Waiting work unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_list_member_waiting_work('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Waiting work unavailable');
end
$$;
do $$
begin
	perform pg_temp.base_claims('anon');
	set local role anon;
	perform pg_temp.base_error($q$select public.qorpera_list_member_waiting_work('92400000-0000-4000-8000-000000000010')$q$,
		'42501');
	reset role;
	perform pg_temp.base_claims('service_role');
end
$$;

-- 2. A second run in Bob's thread: a takeover card and one past its time, then two approvals while it runs.
do $$
declare v_binding jsonb; v_own jsonb; v_company jsonb; v jsonb;
	v_long constant text := 'Pay   the supplier''s invoice for the spring order of oak tables, chairs and the matching benches for '
		|| 'the new showroom in Aarhus today';
begin
	v_binding := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, send the digest to Acme.');
	perform set_config('qorpera_test.wm_binding', v_binding::text, false);
	perform pg_temp.wm_card(v_binding, '12150000-0000-4000-8000-0000000000b1',
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Old question","expiresAt":"2020-01-01T00:00:00Z",
			"payload":{"options":[{"label":"Yes"}]}}');
	perform pg_temp.wm_card(v_binding, '12150000-0000-4000-8000-0000000000b2',
		'{"schema":"qorpera.interaction/v1","surface":"takeover","title":"Sign in to Slack",
			"payload":{"instruction":"Sign in, then hand back."}}');
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'count' = '2' and v -> 'questions' = '2' and v ->> 'kind' = 'takeover'
		and v ->> 'what' = 'Sign in to Slack', 'A takeover card waits too, and is the newest; one past its time does not: ' || v::text);
	v_own := pg_temp.wm_ask(v_binding, 'wm-own', repeat('a', 64), 'Send an email');
	v_company := pg_temp.wm_ask(v_binding, 'wm-company', repeat('b', 64), v_long, 'money');
	perform pg_temp.base_assert(v_own ->> 'decision' = 'ask' and (v_own ->> 'card')::boolean
		and v_company ->> 'decision' = 'ask' and (v_company ->> 'card')::boolean
		and (select approver_scope from public.qorpera_action_reviews where id = (v_own ->> 'reviewId')::uuid) = 'member'
		and (select approver_scope from public.qorpera_action_reviews where id = (v_company ->> 'reviewId')::uuid) = 'owners_admins',
		'Fixture: the owner''s own approval card and the company''s, in Bob''s thread: ' || v_own::text || v_company::text);
	perform set_config('qorpera_test.wm_own', v_own ->> 'reviewId', false);
	perform set_config('qorpera_test.wm_company', v_company ->> 'reviewId', false);
	v := pg_temp.wm_list('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v #> '{0,count}' = '4' and v #> '{0,questions}' = '2'
		and v #> '{0,approvals}' = '2' and v #>> '{0,kind}' = 'approval'
		and v #>> '{0,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #>> '{0,latestAt}' = (select to_jsonb(created_at) #>> '{}' from public.qorpera_action_reviews
			where id = (v_company ->> 'reviewId')::uuid)
		and char_length(v #>> '{0,what}') = 120 and v #>> '{0,what}' like 'Pay the supplier''s invoice for the spring order %…',
		'Every open item counts; the newest approval is the "what", in one line cut to 120 characters: ' || v::text);
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(v -> 'count' = '1' and v -> 'questions' = '0' and v -> 'approvals' = '1'
		and v ->> 'kind' = 'approval', 'The admin answers the company''s approval only: ' || coalesce(v::text, 'none'));
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000002') = '[]'
		and pg_temp.wm_list('92400000-0000-4000-8000-000000000003') = '[]',
		'A contributor and a viewer answer none of them');
end
$$;

-- 3. What the member may not read or no longer answers.
savepoint wm_left;
update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
	and principal_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_assert(coalesce((pg_temp.wm_bob('92400000-0000-4000-8000-000000000001') ->> 'questions')::integer, 0) = 0,
	'A member who left the thread answers none of its cards there');
rollback to savepoint wm_left;
savepoint wm_archived;
update public.qorpera_company_rooms set status = 'archived' where id = current_setting('qorpera_test.card_room')::uuid;
select pg_temp.base_assert(coalesce((pg_temp.wm_bob('92400000-0000-4000-8000-000000000001') ->> 'questions')::integer, 0) = 0,
	'An archived thread''s cards are not listed');
rollback to savepoint wm_archived;
savepoint wm_closed;
update public.qorpera_shared_sessions set status = 'closed' where id = current_setting('qorpera_test.card_thread')::uuid;
select pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000001') = '[]'
	and pg_temp.wm_list('92400000-0000-4000-8000-000000000004') = '[]', 'A closed conversation lists nothing');
rollback to savepoint wm_closed;
savepoint wm_other_company;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12150000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('12150000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test', 'Owner',
	'owner');
select pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000001', '12150000-0000-4000-8000-000000000010') = '[]',
	'Another company of the same owner lists none of this company''s items');
rollback to savepoint wm_other_company;
savepoint wm_draft;
-- An email draft card waits until it is answered, and no longer once the member sent it, also when its answer was lost
-- after the email went out (qorpera_finish_email_draft_action swallows a refused answer).
do $$
declare v jsonb;
begin
	perform pg_temp.wm_card(current_setting('qorpera_test.wm_binding')::jsonb, '12150000-0000-4000-8000-0000000000d1',
		'{"schema":"qorpera.interaction/v1","surface":"draft","title":"New email","payload":{"platform":"email",
			"connectorId":"gmail","from":"sender@example.test","to":["acme@example.test"],"subject":"Digest","body":"Hello"}}');
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'questions' = '3' and v ->> 'kind' = 'draft' and v ->> 'what' = 'New email',
		'An email draft card waits: ' || v::text);
	-- The draft's row as the email action leaves it once the email went out (its secret is not part of this fixture).
	set local session_replication_role = replica;
	insert into public.qorpera_member_email_drafts(interaction_id, session_id, user_id, secret_id, from_address, content,
		status)
	values ('12150000-0000-4000-8000-0000000000d1', current_setting('qorpera_test.card_thread')::uuid,
		'92400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 'sender@example.test', '{}', 'sent');
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'questions' = '2' and v ->> 'kind' = 'approval',
		'A sent draft waits no more, though no answer was recorded: ' || v::text);
	-- Nor one whose send ended unconfirmed: no Send, Save, Discard or answer can settle it.
	update public.qorpera_member_email_drafts set status = 'unconfirmed'
	where interaction_id = '12150000-0000-4000-8000-0000000000d1';
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'questions' = '2', 'An unconfirmed send waits no more: ' || v::text);
	update public.qorpera_member_email_drafts set status = 'saved'
	where interaction_id = '12150000-0000-4000-8000-0000000000d1';
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'questions' = '3' and v ->> 'kind' = 'draft',
		'A draft the member only saved still waits: ' || v::text);
	set local session_replication_role = origin;
end
$$;
rollback to savepoint wm_draft;

-- 4. Answers take the items off at once.
do $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'count' = '3' and v -> 'questions' = '1' and v -> 'approvals' = '2',
		'An answered card leaves the count; the others stay: ' || v::text);
	perform pg_temp.wm_answer_review('92400000-0000-4000-8000-000000000004', current_setting('qorpera_test.wm_company')::uuid);
	v := pg_temp.wm_bob('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v -> 'count' = '2' and v -> 'approvals' = '1' and v ->> 'kind' = 'approval'
		and v ->> 'what' = 'Send an email', 'The admin''s answer takes the company''s approval off; the owner''s own is newest now: '
		|| v::text);
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000004') = '[]',
		'Nothing waits on the admin any more');
	perform pg_temp.wm_answer_review('92400000-0000-4000-8000-000000000001', current_setting('qorpera_test.wm_own')::uuid);
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '12150000-0000-4000-8000-0000000000b2', 'handed_back', '{}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.wm_list('92400000-0000-4000-8000-000000000001') = '[]',
		'With everything answered, Bob waits on nobody: ' || pg_temp.wm_list('92400000-0000-4000-8000-000000000001')::text);
end
$$;

-- 5. Privileges, marker.
do $$
begin
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_member_waiting_work(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_member_waiting_work(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_list_member_waiting_work(uuid)', 'execute'),
		'Members execute it; anon and service_role do not');
	perform pg_temp.base_assert((select prosecdef and provolatile = 's' and proconfig = array['search_path=""']
		and prosrc like '%20260930723000%' from pg_proc
		where oid = 'public.qorpera_list_member_waiting_work(uuid)'::regprocedure), 'A stable definer read with the marker');
end
$$;

-- The fixture's rows go with the test.
rollback;
