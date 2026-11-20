-- @fixture 1307_member_open_decisions.test.sql until "savepoint od_left;"
create function pg_temp.dv_list(p_user uuid, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_list_company_open_decisions(p_profile);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.company-open-decisions/v1'
		and jsonb_typeof(v -> 'decisions') = 'array', 'The list''s shape: ' || v::text);
	return v -> 'decisions';
end $$;
create function pg_temp.dv_kinds(p_user uuid) returns text language sql as $$
	select coalesce(string_agg((decision ->> 'kind') || case when (decision ->> 'canAnswer')::boolean then '!' else '' end,
		',' order by position), '')
	from jsonb_array_elements(pg_temp.dv_list(p_user)) with ordinality as listed(decision, position)
$$;
create function pg_temp.dv_votes(p_user uuid, p_item uuid) returns jsonb language sql as $$
	select decision -> 'votes'
	from jsonb_array_elements(pg_temp.dv_list(p_user)) as listed(decision)
	where decision ->> 'id' = p_item::text
$$;
create function pg_temp.dv_cast(p_user uuid, p_item uuid, p_choice text, p_note text,
	p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_cast_decision_vote(p_profile, p_item, p_choice, p_note);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.dv_refused(p_user uuid, p_item uuid, p_choice text, p_note text, p_state text, p_message text)
returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
	perform pg_temp.base_error(format('select public.qorpera_cast_decision_vote(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', p_item, p_choice, p_note), p_state, p_message);
	perform pg_temp.base_claims('service_role');
end $$;
create function pg_temp.dv_hints() returns bigint language plpgsql as $$
declare v bigint;
begin
	set constraints qorpera_decision_vote_hint immediate;
	set constraints qorpera_decision_vote_hint deferred;
	select count(*) into v from realtime.messages as message
	where message.event = 'sessions' and message.payload = '{"schema":"qorpera.live-hint/v1"}'::jsonb and message.private
		and message.topic in (
			select public.qorpera_live_hint_topic(member.profile_id, member.user_id)
			from public.qorpera_profile_members as member
			where member.profile_id = '92400000-0000-4000-8000-000000000010');
	return v;
end $$;

do $$
declare v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001') = 'approval!,approval!,draft!,question!',
		'The owner answers all four: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001'));
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval,approval,draft,question',
		'A contributor sees all four and answers none: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002'));
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000003') = 'approval,approval,draft,question',
		'A spectator sees all four and answers none: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000003'));
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000004') = 'approval!,approval,draft,question',
		'An admin answers the company''s approval, which comes first: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000004'));
	v := pg_temp.dv_list('92400000-0000-4000-8000-000000000002');
	perform pg_temp.base_assert(v #>> '{0,id}' = current_setting('qorpera_test.od_company')
		and v #>> '{0,review,title}' = 'Pay the invoice' and not (v #> '{0,review}' ? 'call')
		and v #> '{0,answererUserId}' = 'null' and v #> '{0,votes}' = '[]'
		and v #>> '{1,id}' = current_setting('qorpera_test.od_own')
		and v #>> '{1,answererUserId}' = '92400000-0000-4000-8000-000000000001'
		and v #>> '{2,id}' = '13070000-0000-4000-8000-0000000000d1'
		and v #>> '{2,body,entry,data,payload,subject}' = 'Digest'
		and v #>> '{3,id}' = '59600000-0000-4000-8000-0000000009a1'
		and v #>> '{3,body,entry,data,title}' = 'Which channel should the digest go to?'
		and v #>> '{3,answererUserId}' = '92400000-0000-4000-8000-000000000001'
		and v #>> '{3,sessionId}' = current_setting('qorpera_test.card_thread')
		and v #>> '{3,staffAgentId}' = '92400000-0000-4000-8000-000000000031'
		and (v #>> '{3,sequence}')::integer >= 1 and v #> '{3,votes}' = '[]',
		'Another member''s decisions come as the cards themselves, with who answers: ' || v::text);
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error($q$select public.qorpera_list_company_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Decisions unavailable');
	perform pg_temp.base_error($q$select public.qorpera_cast_decision_vote('92400000-0000-4000-8000-000000000010',
		'59600000-0000-4000-8000-0000000009a1', 'finance', null)$q$, '42501', 'Voting unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_list_company_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Decisions unavailable');
	perform pg_temp.base_error($q$select public.qorpera_cast_decision_vote('92400000-0000-4000-8000-000000000010',
		'59600000-0000-4000-8000-0000000009a1', 'finance', null)$q$, '42501', 'Voting unavailable');
end
$$;
do $$
begin
	perform pg_temp.base_claims('anon');
	set local role anon;
	perform pg_temp.base_error($q$select public.qorpera_list_company_open_decisions('92400000-0000-4000-8000-000000000010')$q$,
		'42501');
	perform pg_temp.base_error($q$select public.qorpera_cast_decision_vote('92400000-0000-4000-8000-000000000010',
		'59600000-0000-4000-8000-0000000009a1', 'finance', null)$q$, '42501');
	reset role;
	perform pg_temp.base_claims('service_role');
end
$$;

do $$
declare v jsonb; v_before bigint; v_inputs bigint; v_runs bigint;
begin
	select count(*) into v_inputs from public.qorpera_session_inputs;
	select count(*) into v_runs from public.qorpera_execution_runs;
	perform set_config('qorpera.live_hints_sent', '', true);
	perform set_config('qorpera.live_hints_failed', '', true);
	v_before := pg_temp.dv_hints();
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'finance',
		'  Finance reads it every morning.  ');
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.decision-vote/v1',
		'itemId', '59600000-0000-4000-8000-0000000009a1', 'choice', 'finance', 'note', 'Finance reads it every morning.'),
		'A contributor''s vote on the owner''s question, its note trimmed: ' || v::text);
	perform pg_temp.base_assert(pg_temp.dv_hints() - v_before = 4,
		'At commit the vote tells each of the company''s four members once: ' || (pg_temp.dv_hints() - v_before)::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_session_inputs) = v_inputs
		and (select count(*) from public.qorpera_execution_runs) = v_runs, 'A vote sends no answer and starts no run');
	v := pg_temp.dv_votes('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1');
	perform pg_temp.base_assert(jsonb_array_length(v) = 1
		and v #>> '{0,userId}' = '92400000-0000-4000-8000-000000000002' and v #>> '{0,choice}' = 'finance'
		and v #>> '{0,note}' = 'Finance reads it every morning.' and (v #>> '{0,updatedAt}')::timestamptz is not null,
		'The owner reads the vote on their question: ' || v::text);
	perform pg_temp.base_assert(pg_temp.dv_votes('92400000-0000-4000-8000-000000000003', '59600000-0000-4000-8000-0000000009a1') = v,
		'A spectator reads the same vote');
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001') = 'approval!,approval!,draft!,question!',
		'A vote answers nothing: the question still waits for the owner');

	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'general', null);
	perform pg_temp.base_assert(v ->> 'choice' = 'general' and v -> 'note' = 'null', 'A changed vote: ' || v::text);
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1', 'finance', '');
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000004', '59600000-0000-4000-8000-0000000009a1', '', 'Either works.');
	v := pg_temp.dv_votes('92400000-0000-4000-8000-000000000003', '59600000-0000-4000-8000-0000000009a1');
	perform pg_temp.base_assert((select count(*) from public.qorpera_decision_votes) = 3
		and jsonb_array_length(v) = 3
		and v @> '[{"userId":"92400000-0000-4000-8000-000000000002","choice":"general","note":null}]'
		and v @> '[{"userId":"92400000-0000-4000-8000-000000000001","choice":"finance","note":null}]'
		and v @> '[{"userId":"92400000-0000-4000-8000-000000000004","choice":null,"note":"Either works."}]',
		'One vote a member: the contributor''s changed, the owner''s own, the admin''s note alone: ' || v::text);

	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000002', current_setting('qorpera_test.od_company')::uuid, null,
		'Check the amount first.');
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000002', '13070000-0000-4000-8000-0000000000d1', null,
		'Say hello to Acme from me.');
	perform pg_temp.base_assert(
		pg_temp.dv_votes('92400000-0000-4000-8000-000000000001', current_setting('qorpera_test.od_company')::uuid)
			#>> '{0,note}' = 'Check the amount first.'
		and pg_temp.dv_votes('92400000-0000-4000-8000-000000000001', '13070000-0000-4000-8000-0000000000d1')
			#>> '{0,note}' = 'Say hello to Acme from me.',
		'An approval and an email draft take a note');
end
$$;

select pg_temp.dv_refused('92400000-0000-4000-8000-000000000003', '59600000-0000-4000-8000-0000000009a1', 'finance', null,
	'42501', 'Voting unavailable');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'marketing', null,
	'22023', 'That is not one of this decision''s options');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', '#finance', null,
	'22023', 'That is not one of this decision''s options');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', current_setting('qorpera_test.od_own')::uuid, 'allow_once', null,
	'22023', 'That is not one of this decision''s options');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '13070000-0000-4000-8000-0000000000d1', 'send', null,
	'22023', 'That is not one of this decision''s options');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '13070000-0000-4000-8000-0000000000b1', 'Yes', null,
	'22023', 'This decision is not open');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '13070000-0000-4000-8000-0000000000b2', null, 'A note',
	'22023', 'This decision is not open');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '13080000-0000-4000-8000-0000000000ff', null, 'A note',
	'22023', 'This decision is not open');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'finance',
	repeat('n', 501), '22023', 'A vote is one option and at most 500 characters of note');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', repeat('c', 201),
	null, '22023', 'A vote is one option and at most 500 characters of note');

do $$
declare v jsonb; v_before bigint;
begin
	v_before := pg_temp.dv_hints();
	perform set_config('qorpera.live_hints_sent', '', true);
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000004', '59600000-0000-4000-8000-0000000009a1', null, '   ');
	perform pg_temp.base_assert(pg_temp.dv_hints() - v_before = 4,
		'A vote taken back tells the company''s members too: ' || (pg_temp.dv_hints() - v_before)::text);
	perform pg_temp.base_assert(v -> 'choice' = 'null' and v -> 'note' = 'null'
		and not exists (select 1 from public.qorpera_decision_votes
			where item_id = '59600000-0000-4000-8000-0000000009a1' and user_id = '92400000-0000-4000-8000-000000000004')
		and jsonb_array_length(pg_temp.dv_votes('92400000-0000-4000-8000-000000000001',
			'59600000-0000-4000-8000-0000000009a1')) = 2,
		'An empty vote takes the member''s vote back and leaves the others: ' || v::text);
	v := pg_temp.dv_cast('92400000-0000-4000-8000-000000000004', '59600000-0000-4000-8000-0000000009a1', null, null);
	perform pg_temp.base_assert(v -> 'note' = 'null', 'Taking back a vote that is not there is no error');
end
$$;

savepoint dv_other_company;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13080000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13080000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test', 'Owner',
	'owner');
select pg_temp.base_assert(pg_temp.dv_list('92400000-0000-4000-8000-000000000001', '13080000-0000-4000-8000-000000000010') = '[]',
	'Another company of the same owner lists none of this company''s decisions');
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error($q$select public.qorpera_cast_decision_vote('13080000-0000-4000-8000-000000000010',
		'59600000-0000-4000-8000-0000000009a1', 'finance', null)$q$, '22023', 'This decision is not open');
	perform pg_temp.base_claims('service_role');
end
$$;
rollback to savepoint dv_other_company;

savepoint dv_private;
update public.qorpera_shared_sessions set audience_kind = 'member_private',
	audience_user_id = '92400000-0000-4000-8000-000000000001'
where id = current_setting('qorpera_test.card_thread')::uuid;
select pg_temp.base_assert(pg_temp.dv_list('92400000-0000-4000-8000-000000000002') = '[]'
	and pg_temp.dv_list('92400000-0000-4000-8000-000000000001') = '[]',
	'A conversation that is one member''s own lists nothing to the company');
rollback to savepoint dv_private;

savepoint dv_left_thread;
update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
where room_id = current_setting('qorpera_test.card_room')::uuid and principal_kind = 'member'
	and principal_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001') = 'approval!,approval!,draft,question',
	'An owner who left the thread still sees its cards and no longer answers them: '
		|| pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001'));
rollback to savepoint dv_left_thread;

savepoint dv_archived;
update public.qorpera_company_rooms set status = 'archived' where id = current_setting('qorpera_test.card_room')::uuid;
select pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval,approval',
	'An archived thread''s cards are not listed: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002'));
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'finance', null,
	'22023', 'This decision is not open');
rollback to savepoint dv_archived;

savepoint dv_member_leaves;
create function pg_temp.dv_told(p_users uuid[]) returns bigint language sql as $$
	select count(*) from realtime.messages as message
	where message.event = 'sessions' and message.topic in (
		select public.qorpera_live_hint_topic('92400000-0000-4000-8000-000000000010', told) from unnest(p_users) as told)
$$;
do $$
declare
	v_stay uuid[] := array['92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000004']::uuid[];
	v_leave uuid[] := array['92400000-0000-4000-8000-000000000002']::uuid[];
	v_stayers bigint; v_leaver bigint;
begin
	perform pg_temp.dv_hints();
	perform set_config('qorpera.live_hints_sent', '', true);
	v_stayers := pg_temp.dv_told(v_stay);
	v_leaver := pg_temp.dv_told(v_leave);
	delete from public.qorpera_profile_members
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_decision_votes
			where user_id = '92400000-0000-4000-8000-000000000002')
		and jsonb_array_length(pg_temp.dv_votes('92400000-0000-4000-8000-000000000001',
			'59600000-0000-4000-8000-0000000009a1')) = 1,
		'A member who leaves the company takes their votes and notes with them');
	perform pg_temp.dv_hints();
	perform pg_temp.base_assert(pg_temp.dv_told(v_stay) - v_stayers = 3 and pg_temp.dv_told(v_leave) = v_leaver,
		'Their votes going tells the three members who stay, and not the one who left: '
			|| (pg_temp.dv_told(v_stay) - v_stayers)::text || ' ' || (pg_temp.dv_told(v_leave) - v_leaver)::text);
end
$$;
rollback to savepoint dv_member_leaves;

savepoint dv_spectator_now;
update public.qorpera_action_reviews set approver_user_id = '92400000-0000-4000-8000-000000000002'
where id = current_setting('qorpera_test.od_own')::uuid;
select pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval!,approval,draft,question',
	'A contributor answers the approval that names them: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002'));
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
select pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval,approval,draft,question',
	'Made a spectator, they answer nothing, the approval that names them included: '
		|| pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002'));
select pg_temp.base_assert(
	not (pg_temp.dv_votes('92400000-0000-4000-8000-000000000001', '59600000-0000-4000-8000-0000000009a1')
		@> '[{"userId":"92400000-0000-4000-8000-000000000002"}]')
	and exists (select 1 from public.qorpera_decision_votes where user_id = '92400000-0000-4000-8000-000000000002'),
	'A spectator''s earlier votes are kept but no longer shown');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', null, null,
	'42501', 'Voting unavailable');
rollback to savepoint dv_spectator_now;

savepoint dv_erased;
do $$
begin
	set local session_replication_role = replica;
	update public.qorpera_session_events set body = '{"erased":true}'
	where session_id = current_setting('qorpera_test.card_thread')::uuid and event_type = 'authorization_request'
		and body #>> '{entry,data,reviewId}' = current_setting('qorpera_test.od_company');
	set local session_replication_role = origin;
	perform pg_temp.base_assert(found, 'Fixture: the company approval''s card event is erased');
end
$$;
select pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval,draft,question'
	and pg_temp.dv_kinds('92400000-0000-4000-8000-000000000003') = 'approval,draft,question'
	and pg_temp.dv_kinds('92400000-0000-4000-8000-000000000004') = 'approval,draft,question'
	and pg_temp.dv_kinds('92400000-0000-4000-8000-000000000001') = 'approval!,draft!,question!',
	'An approval whose card was erased from the thread is on nobody''s list: '
		|| pg_temp.dv_kinds('92400000-0000-4000-8000-000000000003'));
select pg_temp.base_assert(not exists (
		select 1 from jsonb_array_elements(pg_temp.dv_list('92400000-0000-4000-8000-000000000003')) as listed(decision)
		where decision ->> 'id' = current_setting('qorpera_test.od_company')),
	'A spectator reads nothing of the erased approval');
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', current_setting('qorpera_test.od_company')::uuid, null,
	'A note', '22023', 'This decision is not open');
rollback to savepoint dv_erased;

do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002') = 'approval,approval,draft',
		'An answered question leaves every member''s list: ' || pg_temp.dv_kinds('92400000-0000-4000-8000-000000000002'));
	perform pg_temp.base_assert((select count(*) from public.qorpera_decision_votes
		where item_id = '59600000-0000-4000-8000-0000000009a1') = 2,
		'Its votes are kept: a failed answer opens the card again with them');
end
$$;
select pg_temp.dv_refused('92400000-0000-4000-8000-000000000002', '59600000-0000-4000-8000-0000000009a1', 'general', null,
	'22023', 'This decision is not open');

do $$
begin
	perform pg_temp.base_assert(
		has_function_privilege('authenticated', 'public.qorpera_list_company_open_decisions(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_cast_decision_vote(uuid, uuid, text, text)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_company_open_decisions(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_cast_decision_vote(uuid, uuid, text, text)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_list_company_open_decisions(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_cast_decision_vote(uuid, uuid, text, text)', 'execute'),
		'Members execute the two; anon and service_role do not');
	perform pg_temp.base_assert(
		not has_function_privilege('authenticated', 'public.qorpera_company_open_decisions(uuid, uuid, boolean)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_company_open_decisions(uuid, uuid, boolean)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_decision_vote_hint()', 'execute'),
		'The list behind them, which checks no caller, and the hint are internal');
	perform pg_temp.base_assert(
		not has_table_privilege('authenticated', 'public.qorpera_decision_votes', 'select')
		and not has_table_privilege('authenticated', 'public.qorpera_decision_votes', 'insert')
		and not has_table_privilege('anon', 'public.qorpera_decision_votes', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_decision_votes', 'select')
		and (select relrowsecurity from pg_class where oid = 'public.qorpera_decision_votes'::regclass)
		and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'qorpera_decision_votes'),
		'The votes table is reached through the two functions alone');
	perform pg_temp.base_assert((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc
		where oid in ('public.qorpera_list_company_open_decisions(uuid)'::regprocedure,
			'public.qorpera_cast_decision_vote(uuid, uuid, text, text)'::regprocedure,
			'public.qorpera_company_open_decisions(uuid, uuid, boolean)'::regprocedure,
			'public.qorpera_decision_vote_hint()'::regprocedure)), 'Definer functions with an empty search path');
end
$$;

rollback;
