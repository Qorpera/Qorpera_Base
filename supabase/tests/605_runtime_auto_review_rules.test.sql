-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- A group chat carries no card"
-- Auto-review rules (bundle v130). Members write rules; company rules need an
-- owner or admin. The runtime asks the kernel for the rules that apply to one
-- acting call, records the reviewer's verdict (Ask first always wins; a
-- built-in check asks unless an allow rule covers it), and for an ask the
-- kernel raises the approval card in the run's conversation. A personal rule's
-- card waits for that member, a company rule's or built-in check's card for an
-- owner or admin. A held call reads the answer and uses the approval once; a
-- parked card wakes the agent when answered, and the repeated call runs
-- without a second review. Always allow saves a company allow rule.
-- Membership names come from the account (20260926000000): the fixture's owner is named Owner.
update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"full_name":"Owner"}'::jsonb
where id = '30000000-0000-4000-8000-000000000001';
select pg_temp.path_claims('service_role');

create function pg_temp.review_rule(p_user uuid, p_id uuid, p_scope text, p_when text, p_outcome text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	v_result := public.qorpera_save_review_rule('30000000-0000-4000-8000-000000000010', p_id, p_scope, p_when, p_outcome);
	perform pg_temp.path_claims('service_role');
	return v_result;
end
$$;
create function pg_temp.review_record(p_binding jsonb, p_call text, p_digest text, p_decision text, p_rules uuid[],
	p_built_in text default 'none', p_proposed text default null) returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'send_email',
		'effect', 'external', 'argumentSha256', p_digest,
		'action', jsonb_build_object('title', 'Send an email', 'target', 'bob@acme.test',
			'details', jsonb_build_object('subject', 'Meeting moved')),
		'decision', p_decision, 'ruleIds', to_jsonb(p_rules), 'builtIn', p_built_in,
		'reason', 'The company asks first before emailing outside the company.', 'proposedRule', p_proposed,
		'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.review_answer(p_user uuid, p_review uuid, p_answer text, p_rule text default null,
	p_client uuid default null) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_result jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated', p_user);
	v_result := public.qorpera_answer_action_review(p_review, coalesce(p_client, extensions.gen_random_uuid()), p_answer,
		p_rule, v_base.sponsor_binding_id, v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	return v_result;
end
$$;

-- Rules: members write their own; company rules need an owner or admin.
do $$
declare v_list jsonb;
begin
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000a01', 'company',
		'  sending any email to someone outside the company  ', 'ask_first');
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000a02', 'member',
		'Spørg mig først før du sender noget til en kunde', 'ask_first');
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000a03', 'company',
		'creating issues in our own GitHub repositories', 'allow_automatically');
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000a04', 'member',
		'posting on LinkedIn', 'ask_first');
	perform pg_temp.wake_assert((select when_text from public.qorpera_review_rules
		where id = '30000000-0000-4000-8000-000000000a01') = 'sending any email to someone outside the company',
		'A rule is saved trimmed');
	-- A retried save is the same rule.
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000a01', 'company',
		'sending any email to someone outside the company', 'ask_first');
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
	perform pg_temp.wake_error($sql$select public.qorpera_save_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a09','company','deleting files','ask_first')$sql$,
		'42501', 'Only owners and admins write company rules');
	perform pg_temp.wake_error($sql$select public.qorpera_save_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a02','member','changed','ask_first')$sql$,
		'42501', 'This rule cannot be changed here');
	perform pg_temp.wake_error($sql$select public.qorpera_archive_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a01')$sql$, '42501', 'This rule cannot be removed here');
	perform pg_temp.wake_error($sql$select public.qorpera_save_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a09','member','   ','ask_first')$sql$, '22023');
	perform pg_temp.wake_error(format('select public.qorpera_save_review_rule(%L,%L,%L,%L,%L)',
		'30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000a09', 'member', repeat('x', 281),
		'ask_first'), '22023');
	v_list := public.qorpera_list_review_rules('30000000-0000-4000-8000-000000000010');
	perform pg_temp.wake_assert(jsonb_array_length(v_list -> 'rules') = 3
		and (v_list ->> 'canManageCompanyRules')::boolean = false
		and not exists (select 1 from jsonb_array_elements(v_list -> 'rules') as rule(value)
			where rule.value ->> 'id' = '30000000-0000-4000-8000-000000000a02'),
		'A member sees the company''s rules and their own, not another member''s');
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000003');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_review_rules('30000000-0000-4000-8000-000000000010')
		-> 'rules') = 2, 'A viewer reads the company''s rules');
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
	perform public.qorpera_archive_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a04');
	perform public.qorpera_archive_review_rule('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000a04');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_review_rules('30000000-0000-4000-8000-000000000010')
		-> 'rules') = 2, 'A removed rule is gone, and removing it again changes nothing');
	perform pg_temp.path_claims('anon');
	perform pg_temp.wake_error($sql$select public.qorpera_list_review_rules('30000000-0000-4000-8000-000000000010')$sql$,
		'42501');
	perform pg_temp.path_claims('service_role');
end
$$;

-- A member's post in the agent's thread; its run reviews acting calls.
do $$
declare v_binding jsonb; v_begin jsonb; v_record jsonb; v_event public.qorpera_session_events%rowtype;
begin
	v_binding := pg_temp.card_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, tell Acme the meeting moved.');
	perform set_config('qorpera_test.review_binding', v_binding::text, false);
	perform pg_temp.wake_error(format('select public.qorpera_begin_action_review(%L,%L)', v_binding,
		'{"tool":"send_email"}'), '22023', 'Action review request is invalid');
	v_begin := public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('1', 64)));
	perform pg_temp.wake_assert(v_begin ->> 'state' = 'review' and v_begin #>> '{requester,name}' = 'Owner'
		and v_begin #>> '{agent,id}' = '30000000-0000-4000-8000-000000000031'
		and jsonb_array_length(v_begin -> 'rules') = 3,
		'The reviewer gets the company''s rules and the requesting member''s own');
	-- An allow with no rule runs; no card.
	v_record := pg_temp.review_record(v_binding, 'call-1', repeat('1', 64), 'allow', '{}');
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'allow' and (v_record ->> 'card')::boolean = false,
		'An allowed call raises no card');
	-- A replay returns the first record; the same call with other content is refused.
	perform pg_temp.wake_assert(pg_temp.review_record(v_binding, 'call-1', repeat('1', 64), 'deny', '{}') ->> 'reviewId'
		= v_record ->> 'reviewId', 'A replayed review returns its first record');
	perform pg_temp.wake_error(format('select pg_temp.review_record(%L,%L,%L,%L,%L)', v_binding, 'call-1', repeat('2', 64),
		'allow', '{}'), '23505');
	-- An allow next to a matched Ask first rule is an ask; an invented rule id is dropped.
	v_record := pg_temp.review_record(v_binding, 'call-2', repeat('2', 64), 'allow',
		array['30000000-0000-4000-8000-000000000a01', '30000000-0000-4000-8000-00000000ffff']::uuid[]);
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins'
		and (v_record ->> 'card')::boolean and v_record -> 'ruleIds' = '["30000000-0000-4000-8000-000000000a01"]'::jsonb,
		'Ask first wins, and a company rule''s card waits for an owner or admin');
	select * into strict v_event from public.qorpera_session_events where event_id = (v_record ->> 'reviewId')::uuid;
	perform pg_temp.wake_assert(v_event.event_type = 'authorization_request'
		and v_event.session_id = current_setting('qorpera_test.card_thread')::uuid
		and v_event.body #>> '{entry,data,reviewId}' = v_record ->> 'reviewId'
		and v_event.body #>> '{entry,data,title}' = 'Send an email'
		and v_event.body #>> '{entry,data,rules,0,when}' = 'sending any email to someone outside the company'
		and (v_event.body #>> '{entry,data,alwaysAllow}')::boolean = false,
		'The approval card is raised in the thread with the record''s facts');
	perform set_config('qorpera_test.review_company', v_record ->> 'reviewId', false);
	-- A personal rule's card waits for that member.
	v_record := pg_temp.review_record(v_binding, 'call-3', repeat('3', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a02']::uuid[]);
	perform pg_temp.wake_assert(v_record ->> 'approverScope' = 'member' and v_record ->> 'approverName' = 'Owner',
		'A personal rule''s card waits for its member');
	perform set_config('qorpera_test.review_member', v_record ->> 'reviewId', false);
	-- A built-in check asks unless an allow rule covers it, and offers Always allow.
	v_record := pg_temp.review_record(v_binding, 'call-4', repeat('4', 64), 'allow', '{}', 'money',
		'paying for domain renewals up to $20');
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins'
		and (select proposed_rule from public.qorpera_action_reviews where id = (v_record ->> 'reviewId')::uuid)
			= 'paying for domain renewals up to $20',
		'A built-in check asks the owners and admins');
	perform set_config('qorpera_test.review_money', v_record ->> 'reviewId', false);
	v_record := pg_temp.review_record(v_binding, 'call-5', repeat('5', 64), 'allow',
		array['30000000-0000-4000-8000-000000000a03']::uuid[], 'money', 'paying for things');
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'allow', 'A company allow rule covering a built-in check lets it run');
	-- A member's own allow rule never lifts a built-in check: the owners and admins answer it.
	perform pg_temp.review_rule('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000a05', 'member',
		'buying software subscriptions', 'allow_automatically');
	v_record := pg_temp.review_record(v_binding, 'call-5m', repeat('5', 63) || 'a', 'allow',
		array['30000000-0000-4000-8000-000000000a05']::uuid[], 'money', 'buying software subscriptions');
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins',
		'A member''s own allow rule never lifts a built-in check');
	update public.qorpera_review_rules set archived_at = clock_timestamp() where id = '30000000-0000-4000-8000-000000000a05';
	-- A deny stands, with no card; an allow for an action nobody asked for is a deny.
	v_record := pg_temp.review_record(v_binding, 'call-6', repeat('6', 64), 'deny', '{}', 'not_requested');
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'deny' and (v_record ->> 'card')::boolean = false,
		'A denial raises no card');
	perform pg_temp.wake_assert(pg_temp.review_record(v_binding, 'call-6b', repeat('b', 64), 'allow', '{}',
		'not_requested') ->> 'decision' = 'deny', 'An action nobody asked for never runs on an allow');
	-- A denial stands for that exact call: no second opinion.
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('6', 64))) ->> 'state' = 'declined', 'The reviewer''s denial stands for the exact call');
end
$$;

-- Who answers: an owner or admin for a company rule, only its member for a personal rule.
do $$
declare v_wait jsonb; v_answer jsonb; v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb;
begin
	-- The general card answer refuses these cards: the held call would never read it.
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select pg_temp.card_answer(%L,%L,%L,%L)', extensions.gen_random_uuid(),
		current_setting('qorpera_test.review_company'), 'approved', '{}'), '22023',
		'this approval is answered with qorpera_answer_action_review');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000003',
		current_setting('qorpera_test.review_company'), 'allow_once'), '42501');
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000002',
		current_setting('qorpera_test.review_company'), 'allow_once'), '42501',
		'Only the member this approval waits for can answer it');
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_company'), 'always_allow'), '22023',
		'Always allow is not offered for this approval');
	v_wait := public.qorpera_await_action_review(v_binding, current_setting('qorpera_test.review_company')::uuid, false);
	perform pg_temp.wake_assert(v_wait ->> 'state' = 'pending', 'An unanswered card is pending');
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_company')::uuid, 'allow_once', null, '30000000-0000-4000-8000-000000000b01');
	perform pg_temp.wake_assert(v_answer ->> 'answer' = 'allow_once' and (v_answer ->> 'woke')::boolean = false,
		'An answer to a held card wakes nothing');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_session_events
		where session_id = current_setting('qorpera_test.card_thread')::uuid and event_type = 'authorization_decision'
			and body #>> '{entry,data,interactionId}' = current_setting('qorpera_test.review_company')
			and body #>> '{entry,data,decision}' = 'approved'), 'The answer joins the thread as the card''s decision');
	-- A retry of the same answer returns its receipt; another answer is refused.
	perform pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_company')::uuid, 'allow_once', null, '30000000-0000-4000-8000-000000000b01');
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_company'), 'deny'), '55000', 'This approval is already answered');
	v_wait := public.qorpera_await_action_review(v_binding, current_setting('qorpera_test.review_company')::uuid, false);
	perform pg_temp.wake_assert(v_wait ->> 'state' = 'approved' and v_wait ->> 'answeredBy' = 'Owner',
		'The held call reads the approval and uses it');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding,
		current_setting('qorpera_test.review_company')::uuid, false) ->> 'state' = 'approved',
		'Reading it again in the same run is the same approval');
	-- Used once: the same action again is reviewed again.
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('2', 64))) ->> 'state' = 'review', 'An approval is used by one call');
	-- A personal rule's card: only its member answers; a deny is read as declined.
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000002',
		current_setting('qorpera_test.review_member'), 'allow_once'), '42501');
	perform pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_member')::uuid, 'deny');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding,
		current_setting('qorpera_test.review_member')::uuid, false) ->> 'state' = 'declined', 'A denied card is declined');
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('3', 64))) ->> 'state' = 'declined', 'A member''s Deny stands for the exact call');
	-- Always allow: saves the proposed rule, as edited, as a company allow rule.
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.review_money')::uuid, 'always_allow', 'paying for domain renewals');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_review_rules
		where id = (v_answer ->> 'savedRuleId')::uuid and scope = 'company' and outcome = 'allow_automatically'
			and when_text = 'paying for domain renewals' and created_via = 'card'),
		'Always allow saves a company allow rule');
end
$$;

-- A parked card: the answer wakes the agent in its thread, and the repeated call runs without a second review.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb; v_begin jsonb;
	v_answer jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_record := pg_temp.review_record(v_binding, 'call-7', repeat('7', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a02']::uuid[]);
	-- While it waits, the same action from another call holds on the same card.
	v_begin := public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('7', 64)));
	perform pg_temp.wake_assert(v_begin ->> 'state' = 'pending' and v_begin ->> 'reviewId' = v_record ->> 'reviewId',
		'The same waiting action raises no second card');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true)
		->> 'state' = 'parked', 'A call that stops holding parks its card');
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, 'allow_once');
	perform pg_temp.wake_assert((v_answer ->> 'woke')::boolean, 'An answer to a parked card wakes the agent');
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_id = (v_answer ->> 'inputId')::uuid and wake_kind = 'room';
	perform pg_temp.wake_assert(v_wake.staff_agent_id = '30000000-0000-4000-8000-000000000031'
		and v_wake.requested_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_wake.payload -> 'inputIds' = jsonb_build_array(v_answer ->> 'inputId'),
		'The agent is woken in its thread on the answering member''s account');
	v_begin := public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('7', 64)));
	perform pg_temp.wake_assert(v_begin ->> 'state' = 'approved' and v_begin ->> 'reviewId' = v_record ->> 'reviewId',
		'The repeated call uses the approval and runs without a second review');
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('7', 64))) ->> 'state' = 'review', 'And only once');
end
$$;

-- A card no call holds any more (its run stopped without parking): the answer wakes the agent.
-- If the holder was only slow and runs the action itself, the woken repeat has nothing left to do.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb; v_answer jsonb;
begin
	v_record := pg_temp.review_record(v_binding, 'call-8', repeat('c', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a02']::uuid[]);
	perform pg_temp.wake_assert((select held_until > clock_timestamp() from public.qorpera_action_reviews
		where id = (v_record ->> 'reviewId')::uuid), 'A card starts held by the call that raised it');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, false)
		->> 'state' = 'pending', 'The holder renews its heartbeat');
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second'
	where id = (v_record ->> 'reviewId')::uuid;
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, 'allow_once');
	perform pg_temp.wake_assert((v_answer ->> 'woke')::boolean, 'An answer to a card no call holds wakes the agent');
	-- The slow holder reads the approval and runs the action ...
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, false)
		->> 'state' = 'approved', 'A slow holder still uses the approval');
	-- ... so the repeat the wake asks for, from another run, has nothing left to do.
	update public.qorpera_action_reviews set consumed_run_id = extensions.gen_random_uuid()
	where id = (v_record ->> 'reviewId')::uuid;
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('c', 64))) ->> 'state' = 'used', 'A redundant wake finds its action already done');
end
$$;

-- A parked card answered by someone other than the member it was raised for: the woken run
-- works for the answerer, and still finds the approval.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb;
begin
	v_record := pg_temp.review_record(v_binding, 'call-9', repeat('e', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a01']::uuid[]);
	perform public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true);
	perform pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, 'allow_once');
	-- As if the card had been raised for the contributor's run.
	update public.qorpera_action_reviews set requester_user_id = '30000000-0000-4000-8000-000000000002'
	where id = (v_record ->> 'reviewId')::uuid;
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('e', 64))) ->> 'state' = 'approved',
		'The run woken on the answerer''s account uses the approval');
end
$$;

-- A hold that ends early after an answer leaves the approval unused.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb;
begin
	v_record := pg_temp.review_record(v_binding, 'call-10', repeat('f', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a01']::uuid[]);
	perform pg_temp.wake_assert((pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		(v_record ->> 'reviewId')::uuid, 'allow_once') ->> 'woke')::boolean = false, 'The held card is answered');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true, true)
		->> 'state' = 'answered' and (select consumed_at is null from public.qorpera_action_reviews
			where id = (v_record ->> 'reviewId')::uuid), 'Leaving never uses an approval');
	perform pg_temp.wake_error(format('select public.qorpera_await_action_review(%L,%L,false,true)', v_binding,
		v_record ->> 'reviewId'), '22023', 'Action review wait is invalid');
	perform pg_temp.wake_assert(public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, false)
		->> 'state' = 'approved', 'The approval is still there to use');
end
$$;

-- A plain company conversation: the card lives there, and an answer to a parked card is a
-- turn request on the answering member's own account. Viewers and contributors cannot answer it.
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_record jsonb; v_answer jsonb;
begin
	v_record := pg_temp.review_record(v_binding, 'plain-1', repeat('d', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a01']::uuid[]);
	perform pg_temp.wake_assert((v_record ->> 'card')::boolean and exists (select 1 from public.qorpera_session_events
		where event_id = (v_record ->> 'reviewId')::uuid and event_type = 'authorization_request'
			and session_id = '30000000-0000-4000-8000-000000000040'), 'A plain conversation carries the card');
	perform public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true);
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000003',
		v_record ->> 'reviewId', 'allow_once'), '42501');
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L)', '30000000-0000-4000-8000-000000000002',
		v_record ->> 'reviewId', 'allow_once'), '42501');
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, 'allow_once');
	perform pg_temp.wake_assert((v_answer ->> 'woke')::boolean and exists (
		select 1 from public.qorpera_session_turn_requests as request
		where request.input_id = (v_answer ->> 'inputId')::uuid and request.status = 'queued'
			and request.requested_by_user_id = '30000000-0000-4000-8000-000000000001'),
		'The answer is a turn request on the member''s own account');
end
$$;

-- An Always allow whose delivery failed (its turn request refused at admission) never reached the
-- agent: the card may be answered again, the rule it saved goes with it, and its retry is no success.
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_record jsonb; v_answer jsonb;
	v_client uuid := extensions.gen_random_uuid();
begin
	v_record := pg_temp.review_record(v_binding, 'plain-2', repeat('9', 64), 'allow', '{}', 'money',
		'paying for things from the plain conversation');
	perform public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true);
	v_answer := pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid,
		'always_allow', null, v_client);
	perform pg_temp.wake_assert((v_answer ->> 'savedRuleId') is not null, 'Always allow saved a rule');
	update public.qorpera_session_inputs set failed_at = clock_timestamp(), failure_reason = 'test: admission refused'
	where id = (v_answer ->> 'inputId')::uuid;
	perform pg_temp.wake_error(format('select pg_temp.review_answer(%L,%L,%L,null,%L)',
		'30000000-0000-4000-8000-000000000001', v_record ->> 'reviewId', 'always_allow', v_client), '55000',
		'That answer did not reach the agent; answer the card again');
	perform pg_temp.wake_assert(pg_temp.review_answer('30000000-0000-4000-8000-000000000001',
		(v_record ->> 'reviewId')::uuid, 'deny') ->> 'answer' = 'deny', 'The card is answered again');
	perform pg_temp.wake_assert((select archived_at is not null from public.qorpera_review_rules
		where id = (v_answer ->> 'savedRuleId')::uuid), 'The failed Always allow''s rule is removed');
end
$$;

-- An answer serves the answering member's own runs only in the card's conversation, where its
-- wake lands: an owner's Allow once or Deny on a contributor's card in another conversation
-- neither runs nor blocks the owner's own identical call here.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb; v_begin jsonb;
	v_answer text; v_digest text;
begin
	foreach v_answer in array array['allow_once', 'deny'] loop
		v_digest := repeat('0', 63) || case v_answer when 'deny' then '2' else '1' end;
		v_record := pg_temp.review_record(v_binding, 'elsewhere-' || v_answer, v_digest, 'ask',
			array['30000000-0000-4000-8000-000000000a01']::uuid[]);
		update public.qorpera_action_reviews set requester_user_id = '30000000-0000-4000-8000-000000000002'
		where id = (v_record ->> 'reviewId')::uuid;
		perform public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, true);
		perform pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, v_answer);
		update public.qorpera_action_reviews set session_id = '30000000-0000-4000-8000-000000000040',
			card_session_id = '30000000-0000-4000-8000-000000000040' where id = (v_record ->> 'reviewId')::uuid;
		v_begin := public.qorpera_begin_action_review(v_binding,
			jsonb_build_object('tool', 'send_email', 'argumentSha256', v_digest));
		perform pg_temp.wake_assert(v_begin ->> 'state' = 'review' and (select consumed_at is null
			from public.qorpera_action_reviews where id = (v_record ->> 'reviewId')::uuid),
			format('An owner''s %s on a card elsewhere is not the owner''s answer here', v_answer));
	end loop;
end
$$;

-- A denial stands in its run, and in its conversation until a member writes there again: the
-- agent gets no second opinion by retrying, but a member who asks again is heard and the
-- action is reviewed afresh. A member's Deny on a card reads the same way. (An earlier run is
-- stood in for by moving the review to another run of the fixture.)
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb;
	v_other uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	v_record jsonb; v_digest text; v_answer text;
begin
	foreach v_answer in array array['reviewer', 'member'] loop
		v_digest := repeat(case v_answer when 'reviewer' then '9a' else '9b' end, 32);
		if v_answer = 'reviewer' then
			v_record := pg_temp.review_record(v_binding, 'deny-' || v_answer, v_digest, 'deny', '{}', 'not_requested');
		else
			v_record := pg_temp.review_record(v_binding, 'deny-' || v_answer, v_digest, 'ask',
				array['30000000-0000-4000-8000-000000000a01']::uuid[]);
			perform public.qorpera_await_action_review(v_binding, (v_record ->> 'reviewId')::uuid, false);
			perform pg_temp.review_answer('30000000-0000-4000-8000-000000000001', (v_record ->> 'reviewId')::uuid, 'deny');
		end if;
		perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
			'argumentSha256', v_digest)) ->> 'state' = 'declined', format('A %s denial stands in its run', v_answer));
		update public.qorpera_action_reviews set run_id = v_other where id = (v_record ->> 'reviewId')::uuid;
		perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
			'argumentSha256', v_digest)) ->> 'state' = 'declined',
			format('A %s denial stands in its conversation for a later run', v_answer));
		-- (Its own statement in real use; here the whole block is one statement, so its time is set.)
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body, completed_at,
			created_at)
		values (current_setting('qorpera_test.card_thread')::uuid, extensions.gen_random_uuid(), 'user_message',
			'30000000-0000-4000-8000-000000000001', jsonb_build_object('text', 'Yes, send it to Acme anyway.'),
			clock_timestamp(), clock_timestamp());
		perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
			'argumentSha256', v_digest)) ->> 'state' = 'review',
			format('After a %s denial, a member who writes again gets the action reviewed afresh', v_answer));
		-- As in Grok, the retried call runs only on a click, whatever the fresh review says. Who
		-- clicks never goes down: the member when the review now lets it through, the owners and
		-- admins when it is still not asked for, or when they answered this call before.
		if v_answer = 'reviewer' then
			v_record := pg_temp.review_record(v_binding, 'retry-allow', v_digest, 'allow', '{}');
			perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'member'
				and (v_record ->> 'card')::boolean, 'A retry the review now lets through waits for the member''s click');
			v_record := pg_temp.review_record(v_binding, 'retry-deny', v_digest, 'deny', '{}', 'not_requested');
			perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins',
				'A retry still not asked for waits for an owner or admin, never the member alone');
		else
			v_record := pg_temp.review_record(v_binding, 'retry-member', v_digest, 'allow', '{}');
			perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins',
				'A call the owners and admins answered before stays theirs');
		end if;
	end loop;
end
$$;

-- A card still waiting counts only in its own conversation: the same call in another
-- conversation is reviewed there, where its own card can be seen. (The other conversation is
-- stood in for by moving the card.)
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb; v_begin jsonb;
	v_call jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('9c', 32));
begin
	v_record := pg_temp.review_record(v_binding, 'wait-here', repeat('9c', 32), 'ask',
		array['30000000-0000-4000-8000-000000000a01']::uuid[]);
	v_begin := public.qorpera_begin_action_review(v_binding, v_call);
	perform pg_temp.wake_assert(v_begin ->> 'state' = 'pending' and v_begin ->> 'reviewId' = v_record ->> 'reviewId',
		'In its own conversation the call waits on its card');
	update public.qorpera_action_reviews set session_id = '30000000-0000-4000-8000-000000000040',
		card_session_id = '30000000-0000-4000-8000-000000000040' where id = (v_record ->> 'reviewId')::uuid;
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, v_call) ->> 'state' = 'review',
		'A card waiting in another conversation is not waited on here');
end
$$;

-- An agent adds an Ask first rule for the member its run works for (founder decision D4): the
-- member's own rule, attributed to the agent. The same key is the same rule, the same sentence
-- is that rule, and a key reused for another sentence is refused. A full rule list is a refusal.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_added jsonb; v_again jsonb;
begin
	perform pg_temp.wake_error(format('select public.qorpera_add_agent_review_rule(%L,%L)', v_binding,
		'{"when":"emailing a customer"}'), '22023', 'Rule request is invalid');
	perform pg_temp.wake_error(format('select public.qorpera_add_agent_review_rule(%L,%L)', v_binding,
		'{"operationKey":"rule-0","when":"   "}'), '22023');
	v_added := public.qorpera_add_agent_review_rule(v_binding,
		'{"operationKey":"rule-1","when":"  emailing a customer  "}');
	perform pg_temp.wake_assert((v_added ->> 'added')::boolean and v_added ->> 'schema' = 'qorpera.agent-review-rule/v1'
		and v_added ->> 'runId' = v_binding ->> 'runId'
		and v_added #>> '{rule,scope}' = 'member' and v_added #>> '{rule,outcome}' = 'ask_first'
		and v_added #>> '{rule,when}' = 'emailing a customer'
		and v_added #>> '{rule,memberUserId}' = '30000000-0000-4000-8000-000000000001'
		and v_added #>> '{rule,createdVia}' = 'agent'
		and v_added #>> '{rule,createdByStaffAgentId}' = '30000000-0000-4000-8000-000000000031'
		and v_added #>> '{rule,createdByUserId}' is null,
		'An agent adds an Ask first rule for its member');
	v_again := public.qorpera_add_agent_review_rule(v_binding, '{"operationKey":"rule-1","when":"emailing a customer"}');
	perform pg_temp.wake_assert(not (v_again ->> 'added')::boolean and v_again #>> '{rule,id}' = v_added #>> '{rule,id}',
		'A retry with the same key is the same rule');
	v_again := public.qorpera_add_agent_review_rule(v_binding, '{"operationKey":"rule-2","when":"Emailing a customer"}');
	perform pg_temp.wake_assert(not (v_again ->> 'added')::boolean and v_again #>> '{rule,id}' = v_added #>> '{rule,id}',
		'The same sentence is the rule the member already has');
	perform pg_temp.wake_error(format('select public.qorpera_add_agent_review_rule(%L,%L)', v_binding,
		'{"operationKey":"rule-1","when":"posting on LinkedIn"}'), '23505');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_review_rules_for(
			'30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001') as rule
		where rule.id = (v_added #>> '{rule,id}')::uuid)
		and not exists (select 1 from public.qorpera_review_rules_for(
			'30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000002') as rule
		where rule.id = (v_added #>> '{rule,id}')::uuid),
		'The rule applies to its member''s runs only');
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('9e', 32))) -> 'rules' @> jsonb_build_array(jsonb_build_object('id', v_added #>> '{rule,id}',
		'when', 'emailing a customer', 'outcome', 'ask_first')), 'The reviewer reads the rule the agent added');
	-- The member's rules are full: nothing is added, and the refusal says so.
	insert into public.qorpera_review_rules (id, profile_id, scope, member_user_id, when_text, outcome, created_via,
		created_by_user_id)
	select extensions.gen_random_uuid(), '30000000-0000-4000-8000-000000000010', 'member',
		'30000000-0000-4000-8000-000000000001', 'filler rule ' || n || ' ' || repeat('x', 260), 'ask_first', 'settings',
		'30000000-0000-4000-8000-000000000001'
	from generate_series(1, 60) as n;
	v_again := public.qorpera_add_agent_review_rule(v_binding, '{"operationKey":"rule-3","when":"posting on Instagram"}');
	perform pg_temp.wake_assert(not (v_again ->> 'added')::boolean and v_again -> 'rule' = 'null'::jsonb
		and v_again ->> 'refused' like 'The member has too many rules%'
		and not exists (select 1 from public.qorpera_review_rules where when_text = 'posting on Instagram'),
		'A full rule list is refused with nothing added');
end
$$;

-- A dynamic routine's rewrite of its instructions raises no card: decide_routine exists only in
-- that routine's run, so an approval given later could never be applied.
do $$
declare v_record jsonb;
begin
	v_record := public.qorpera_record_action_review(current_setting('qorpera_test.review_binding')::jsonb,
		jsonb_build_object('callId', 'decide-1', 'tool', 'decide_routine', 'effect', 'delegation',
			'argumentSha256', repeat('9f', 32), 'action', jsonb_build_object('title', 'Change what a routine does'),
			'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', 'none',
			'reason', 'Unsure the member wants these new instructions.', 'proposedRule', null,
			'reviewerModel', 'gpt-6-luna'));
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and not (v_record ->> 'card')::boolean,
		'A routine rewrite waits on no card');
end
$$;

-- Delegating to the company's own agents is never a built-in check (20260926210000): an allow
-- the reviewer tagged "access change" on a coding job runs, and a card carries the call as an
-- object the woken agent copies (quotation marks included) next to the text the member reads.
do $$
declare v_binding jsonb := current_setting('qorpera_test.review_binding')::jsonb; v_record jsonb;
	v_arguments text := '{"action":"dispatch","expectedVersion":null,"goal":"Add a line \"Coding check\" to CHECK.md","operationKey":"k1"}';
	v_event public.qorpera_session_events%rowtype;
begin
	v_record := public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'fix-delegation',
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', repeat('8a', 32),
		'action', jsonb_build_object('title', 'Start a coding job', 'arguments', v_arguments),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'access_change',
		'reason', 'Starting a coding job.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'));
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'allow' and v_record ->> 'builtIn' = 'none',
		'A delegation call is never held by a built-in check');
	-- An ask based on such a check alone runs too; an Ask first rule still asks, and so does the
	-- reviewer's own doubt.
	v_record := public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'fix-delegation-ask',
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', repeat('8c', 32),
		'action', jsonb_build_object('title', 'Start a coding job'), 'decision', 'ask', 'ruleIds', '[]'::jsonb,
		'builtIn', 'access_change', 'reason', 'Starting a coding job.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'));
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'allow' and v_record ->> 'builtIn' = 'none',
		'An ask resting only on a built-in check lets a delegation run');
	v_record := public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'fix-delegation-rule',
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', repeat('8d', 32),
		'action', jsonb_build_object('title', 'Start a coding job'), 'decision', 'ask',
		'ruleIds', '["30000000-0000-4000-8000-000000000a01"]'::jsonb, 'builtIn', 'access_change',
		'reason', 'Starting a coding job.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'));
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'owners_admins',
		'An Ask first rule still asks for a delegation');
	v_record := public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'fix-delegation-doubt',
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', repeat('8e', 32),
		'action', jsonb_build_object('title', 'Start a coding job'), 'decision', 'ask', 'ruleIds', '[]'::jsonb,
		'builtIn', 'none', 'reason', 'Unsure this job is wanted.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'));
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and v_record ->> 'approverScope' = 'member',
		'The reviewer''s own doubt still asks the member');
	v_record := public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'fix-card-call',
		'tool', 'send_email', 'effect', 'external', 'argumentSha256', repeat('8b', 32),
		'action', jsonb_build_object('title', 'Send an email', 'arguments', v_arguments),
		'decision', 'ask', 'ruleIds', '["30000000-0000-4000-8000-000000000a01"]'::jsonb, 'builtIn', 'none',
		'reason', 'The company asks first.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'));
	select * into strict v_event from public.qorpera_session_events where event_id = (v_record ->> 'reviewId')::uuid;
	perform pg_temp.wake_assert(v_event.body #>> '{entry,data,arguments}' = v_arguments
		and v_event.body #> '{entry,data,call}' = v_arguments::jsonb
		and v_event.body #>> '{entry,data,call,goal}' = 'Add a line "Coding check" to CHECK.md'
		and v_event.body #> '{entry,data,call}' ? 'expectedVersion',
		'The card carries the exact text and the same call as an object, nulls included');
	perform pg_temp.wake_assert(public.qorpera_action_review_call('not json') is null
		and public.qorpera_action_review_call('[1]') is null, 'Only an object becomes the card''s call');
end
$$;

-- A group chat carries no card: the ask is recorded and the call is refused.
savepoint review_group_chat;
do $$
declare v_binding jsonb; v_record jsonb;
begin
	update public.qorpera_company_rooms set bound_staff_agent_id = null, source_path_version = extensions.gen_random_uuid(),
		source_snapshot_id = extensions.gen_random_uuid(), source_file_sha256 = repeat('a', 64)
	where id = current_setting('qorpera_test.card_room')::uuid;
	v_binding := pg_temp.card_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, email Acme.');
	v_record := pg_temp.review_record(v_binding, 'call-g', repeat('8', 64), 'ask',
		array['30000000-0000-4000-8000-000000000a01']::uuid[]);
	perform pg_temp.wake_assert(v_record ->> 'decision' = 'ask' and (v_record ->> 'card')::boolean = false,
		'A group chat carries no approval card');
	perform pg_temp.wake_assert(public.qorpera_begin_action_review(v_binding, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('8', 64))) ->> 'state' = 'review', 'A cardless ask is never waited on');
end
$$;
rollback to savepoint review_group_chat;

-- Member-facing rules are not callable by the runtime role, runtime RPCs not by members.
do $$
begin
	perform pg_temp.wake_assert(not has_function_privilege('authenticated',
		'public.qorpera_record_action_review(jsonb,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)',
			'execute')
		and has_function_privilege('service_role', 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_add_agent_review_rule(jsonb,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_add_agent_review_rule(jsonb,jsonb)', 'execute'),
		'Execute grants follow the caller');
end
$$;

rollback;
