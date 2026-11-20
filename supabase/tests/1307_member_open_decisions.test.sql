-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- Only the member the card was raised for answers it"
create function pg_temp.od_list(p_user uuid, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_list_member_open_decisions(p_profile);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.member-open-decisions/v1'
		and jsonb_typeof(v -> 'decisions') = 'array', 'The list''s shape: ' || v::text);
	return v -> 'decisions';
end $$;
create function pg_temp.od_kinds(p_user uuid) returns text language sql as $$
	select coalesce(string_agg(decision ->> 'kind', ',' order by position), '')
	from jsonb_array_elements(pg_temp.od_list(p_user)) with ordinality as listed(decision, position)
$$;
create function pg_temp.od_card(p_binding jsonb, p_event uuid, p_data jsonb) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
create function pg_temp.od_ask(p_binding jsonb, p_call text, p_digest text, p_title text, p_built_in text default 'none')
returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'send_email',
		'effect', 'external', 'argumentSha256', p_digest,
		'action', jsonb_build_object('title', p_title, 'target', 'bob@acme.test', 'arguments', '{"to":"bob@acme.test"}'),
		'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', p_built_in,
		'reason', 'It writes to someone outside the company.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.od_answer_review(p_user uuid, p_review uuid) returns jsonb language plpgsql as $$
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

do $$
declare v jsonb := pg_temp.od_list('92400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.base_assert(jsonb_array_length(v) = 1
		and v #>> '{0,kind}' = 'question'
		and v #>> '{0,id}' = '59600000-0000-4000-8000-0000000009a1'
		and v #>> '{0,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #>> '{0,staffAgentId}' = '92400000-0000-4000-8000-000000000031'
		and v #>> '{0,answererUserId}' = '92400000-0000-4000-8000-000000000001'
		and v #> '{0,canAnswer}' = 'true'
		and (v #>> '{0,sequence}')::integer >= 1
		and v #>> '{0,body,entry,data,title}' = 'Which channel should the digest go to?'
		and v #>> '{0,body,entry,data,surface}' = 'question'
		and (v #>> '{0,createdAt}')::timestamptz is not null
		and not (v -> 0 ? 'review'),
		'The owner''s list has the question card raised for them, with the card itself: ' || v::text);
	perform pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000002') = '[]',
		'The member who shares the thread does not answer the owner''s card');
	perform pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000003') = '[]', 'A viewer answers nothing');
	perform pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000004') = '[]',
		'An admin does not answer the owner''s card');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Decisions unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Decisions unavailable');
end
$$;
do $$
begin
	perform pg_temp.base_claims('anon');
	set local role anon;
	perform pg_temp.base_error($q$select public.qorpera_list_member_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501');
	reset role;
	perform pg_temp.base_claims('service_role');
end
$$;

do $$
declare v_binding jsonb; v_own jsonb; v_company jsonb; v jsonb;
begin
	v_binding := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, send the digest to Acme.');
	perform set_config('qorpera_test.od_binding', v_binding::text, false);
	perform pg_temp.od_card(v_binding, '13070000-0000-4000-8000-0000000000b1',
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Old question","expiresAt":"2020-01-01T00:00:00Z",
			"payload":{"options":[{"label":"Yes"}]}}');
	perform pg_temp.od_card(v_binding, '13070000-0000-4000-8000-0000000000b2',
		'{"schema":"qorpera.interaction/v1","surface":"takeover","title":"Sign in to Slack",
			"payload":{"instruction":"Sign in, then hand back."}}');
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'question',
		'A card past its time and a takeover card are no decisions: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	perform pg_temp.od_card(v_binding, '13070000-0000-4000-8000-0000000000d1',
		'{"schema":"qorpera.interaction/v1","surface":"draft","title":"New email","payload":{"platform":"email",
			"connectorId":"gmail","from":"sender@example.test","to":["acme@example.test"],"subject":"Digest","body":"Hello"}}');
	v_own := pg_temp.od_ask(v_binding, 'od-own', repeat('a', 64), 'Send an email');
	v_company := pg_temp.od_ask(v_binding, 'od-company', repeat('b', 64), 'Pay the invoice', 'money');
	perform pg_temp.base_assert(v_own ->> 'decision' = 'ask' and (v_own ->> 'card')::boolean
		and v_company ->> 'decision' = 'ask' and (v_company ->> 'card')::boolean,
		'Fixture: the owner''s own approval card and the company''s: ' || v_own::text || v_company::text);
	perform set_config('qorpera_test.od_own', v_own ->> 'reviewId', false);
	perform set_config('qorpera_test.od_company', v_company ->> 'reviewId', false);
	v := pg_temp.od_list('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'approval,approval,draft,question',
		'Newest first: the two approvals, the email draft, the question: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	perform pg_temp.base_assert(v #>> '{0,id}' = v_company ->> 'reviewId'
		and v #>> '{0,review,schema}' = 'qorpera.action-review/v1'
		and v #>> '{0,review,reviewId}' = v_company ->> 'reviewId'
		and v #>> '{0,review,title}' = 'Pay the invoice'
		and v #>> '{0,review,approverScope}' = 'owners_admins'
		and v #>> '{0,review,arguments}' = '{"to":"bob@acme.test"}'
		and not (v #> '{0,review}' ? 'call')
		and v #> '{0,answererUserId}' = 'null'
		and v #>> '{0,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #>> '{0,staffAgentId}' = '92400000-0000-4000-8000-000000000031'
		and v #> '{0,canAnswer}' = 'true' and not (v -> 0 ? 'body'),
		'The company''s approval comes as its card, without the agent''s copy of the call: ' || (v -> 0)::text);
	perform pg_temp.base_assert(v #>> '{1,id}' = v_own ->> 'reviewId'
		and v #>> '{1,review,approverScope}' = 'member'
		and v #>> '{1,answererUserId}' = '92400000-0000-4000-8000-000000000001',
		'The owner''s own approval names them as the one who answers: ' || (v -> 1)::text);
	perform pg_temp.base_assert(v #>> '{2,id}' = '13070000-0000-4000-8000-0000000000d1'
		and v #>> '{2,body,entry,data,surface}' = 'draft' and v #>> '{2,body,entry,data,payload,subject}' = 'Digest',
		'The email draft comes as its card: ' || (v -> 2)::text);
	v := pg_temp.od_list('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v #>> '{0,kind}' = 'approval'
		and v #>> '{0,id}' = v_company ->> 'reviewId', 'The admin answers the company''s approval only: ' || v::text);
	perform pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000002') = '[]'
		and pg_temp.od_list('92400000-0000-4000-8000-000000000003') = '[]',
		'A contributor and a viewer answer none of them');
end
$$;

savepoint od_left;
update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
	and principal_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') not like '%question%'
	and pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') not like '%draft%',
	'A member who left the thread answers none of its cards there');
rollback to savepoint od_left;
savepoint od_archived;
update public.qorpera_company_rooms set status = 'archived' where id = current_setting('qorpera_test.card_room')::uuid;
select pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') not like '%question%'
	and pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') not like '%draft%',
	'An archived thread''s cards are not listed');
rollback to savepoint od_archived;
savepoint od_closed;
update public.qorpera_shared_sessions set status = 'closed' where id = current_setting('qorpera_test.card_thread')::uuid;
select pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000001') = '[]'
	and pg_temp.od_list('92400000-0000-4000-8000-000000000004') = '[]', 'A closed conversation lists nothing');
rollback to savepoint od_closed;
savepoint od_other_company;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13070000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13070000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test', 'Owner',
	'owner');
select pg_temp.base_assert(pg_temp.od_list('92400000-0000-4000-8000-000000000001', '13070000-0000-4000-8000-000000000010') = '[]',
	'Another company of the same owner lists none of this company''s decisions');
rollback to savepoint od_other_company;
savepoint od_draft;
do $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_member_email_drafts(interaction_id, session_id, user_id, secret_id, from_address, content,
		status)
	values ('13070000-0000-4000-8000-0000000000d1', current_setting('qorpera_test.card_thread')::uuid,
		'92400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 'sender@example.test', '{}', 'sent');
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'approval,approval,question',
		'A sent draft is no open decision: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	update public.qorpera_member_email_drafts set status = 'saved'
	where interaction_id = '13070000-0000-4000-8000-0000000000d1';
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'approval,approval,draft,question',
		'A draft the member only saved is still open: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	set local session_replication_role = origin;
end
$$;
rollback to savepoint od_draft;

do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'approval,approval,draft',
		'An answered question leaves the list; the others stay: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	perform pg_temp.od_answer_review('92400000-0000-4000-8000-000000000004', current_setting('qorpera_test.od_company')::uuid);
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'approval,draft'
		and pg_temp.od_list('92400000-0000-4000-8000-000000000004') = '[]',
		'The admin''s answer takes the company''s approval off both lists: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
	perform pg_temp.od_answer_review('92400000-0000-4000-8000-000000000001', current_setting('qorpera_test.od_own')::uuid);
	perform pg_temp.base_assert(pg_temp.od_kinds('92400000-0000-4000-8000-000000000001') = 'draft',
		'With the approvals answered only the email draft is left: ' || pg_temp.od_kinds('92400000-0000-4000-8000-000000000001'));
end
$$;

do $$
begin
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_member_open_decisions(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_member_open_decisions(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_list_member_open_decisions(uuid)', 'execute'),
		'Members execute it; anon and service_role do not');
	perform pg_temp.base_assert((select prosecdef and provolatile = 's' and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_list_member_open_decisions(uuid)'::regprocedure), 'A stable definer read');
end
$$;

rollback;
