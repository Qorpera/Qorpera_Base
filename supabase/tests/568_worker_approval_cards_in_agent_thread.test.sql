-- @fixture 662_folder_core_member_answers.test.sql until "-- 2. An answer to an agent's card in its thread"
-- 20260930568000: an approval a worker asks for waits on a card in its agent's own thread (production, 4 November 2026:
-- three worker asks with no card that nobody could answer). The worker's repeat, another worker's and the thread's own
-- run hold on that card, a run for another member does not; the member it waits for sees it in the rail's read; their
-- answer wakes the agent in its thread, and that run uses the approval for the identical call. A Deny stands in the
-- thread until a member writes there. decide_routine, a closed thread, a run whose reads the thread may not show and a
-- member's private conversation raise no card elsewhere; a closed thread's card holds nothing. Runs are 647's
-- hand-built runs of agent A (and B), for the owner; the workers are 634's.

create function pg_temp.ask(p_binding jsonb, p_call text, p_tool text default 'machine_run', p_sha text default repeat('9', 64),
	p_decision text default 'ask', p_built_in text default 'none') returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', p_tool,
		'effect', 'external', 'argumentSha256', p_sha,
		'action', jsonb_build_object('title', 'Run a command on office', 'target', 'office',
			'arguments', '{"operationKey":"install","machine":"office","command":"npm install playwright"}'),
		'decision', p_decision, 'ruleIds', '[]'::jsonb, 'builtIn', p_built_in, 'reason', 'It installs a package from the internet.',
		'proposedRule', null, 'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.begin(p_binding jsonb, p_sha text default repeat('9', 64)) returns jsonb language sql as $$
	select public.qorpera_begin_action_review(p_binding, jsonb_build_object('tool', 'machine_run', 'argumentSha256', p_sha))
$$;
-- A member's private conversation with the agent (one open per member and agent).
create function pg_temp.private_session(p_staff uuid, p_user uuid) returns uuid language plpgsql as $$
declare v_id uuid := (select id from public.qorpera_shared_sessions where profile_id = '63400000-0000-4000-8000-000000000010'
	and staff_agent_id = p_staff::text and audience_kind = 'member_private' and audience_user_id = p_user and status = 'open');
begin
	if v_id is not null then return v_id; end if;
	v_id := extensions.gen_random_uuid();
	perform pg_temp.fx(format($q$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id,
			staff_agent_id, staff_version, audience_kind, audience_user_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Private', %L, %L, 1,
			'member_private', %L)$q$, v_id, p_user, p_staff::text, p_user));
	return v_id;
end $$;
-- Moves a hand-built human run (its input and wake too) into a member's private conversation.
create function pg_temp.make_private(p_run jsonb, p_user uuid) returns jsonb language plpgsql as $$
declare v_session uuid := pg_temp.private_session((select staff_agent_id from public.qorpera_execution_runs
	where id = (p_run ->> 'runId')::uuid), p_user);
begin
	perform pg_temp.fx(format($q$update public.qorpera_execution_runs set session_id = %1$L, audience_kind = 'member_private',
			audience_user_id = %2$L where id = %3$L;
		update public.qorpera_session_inputs set session_id = %1$L where execution_run_id = %3$L;
		update public.qorpera_wake_occurrences set session_id = %1$L where run_id = %3$L$q$, v_session, p_user, p_run ->> 'runId'));
	return p_run;
end $$;
-- A worker of the agent, dispatched by a run of the requester's in the agent's thread (or, p_private, in their private
-- conversation); its run has no conversation. Its binding.
create function pg_temp.worker_run(p_staff uuid default '63400000-0000-4000-8000-0000000000a1',
	p_requester uuid default '63400000-0000-4000-8000-000000000001', p_private boolean default false) returns jsonb
language plpgsql as $$
declare p jsonb := pg_temp.run(p_staff, 'human', p_requester);
begin
	if p_private then p := pg_temp.make_private(p, p_requester); end if;
	return pg_temp.native(pg_temp.run(p_staff, 'agent', p_requester, 'worker-dispatch', p,
		pg_temp.worker(p_staff, p, 'in-house', 'read')));
end $$;
-- The agent's own thread.
create function pg_temp.thread(p_staff uuid default '63400000-0000-4000-8000-0000000000a1') returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- The rail's read of the cards waiting for a member.
create function pg_temp.waiting(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	v := public.qorpera_list_member_waiting_approvals('63400000-0000-4000-8000-000000000010') -> 'approvals';
	perform pg_temp.path_claims('service_role');
	return v;
end $$;

-- 1. A worker's ask waits on a card in its agent's thread; repeats hold on it; the member it waits for sees it -----------
do $$
declare w jsonb := pg_temp.worker_run(); r jsonb; r2 jsonb; v_review public.qorpera_action_reviews%rowtype;
	v_event public.qorpera_session_events%rowtype; c_owner constant uuid := '63400000-0000-4000-8000-000000000001';
begin
	if pg_temp.thread() is null or (select session_id from public.qorpera_execution_runs where id = (w ->> 'runId')::uuid) is not null
		or (public.qorpera_run_worker((w ->> 'runId')::uuid)).id is null then
		raise exception 'Fixture: agent A has a thread, and its worker''s run no conversation'; end if;
	r := pg_temp.ask(w, 'worker-call-1');
	select * into strict v_review from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid;
	if r ->> 'decision' <> 'ask' or (r ->> 'card')::boolean is not true or (r ->> 'cardElsewhere')::boolean is not true
		or v_review.session_id is not null or v_review.card_session_id is distinct from pg_temp.thread()
		or v_review.approver_scope <> 'member' or v_review.approver_user_id is distinct from c_owner
		or v_review.held_until is null then
		raise exception 'A worker''s ask waits on a card in its agent''s thread: % %', r, to_jsonb(v_review); end if;
	select * into strict v_event from public.qorpera_session_events where event_id = v_review.id;
	if v_event.session_id <> pg_temp.thread() or v_event.event_type <> 'authorization_request'
		or v_event.execution_id is distinct from (w ->> 'runId')::uuid
		or v_event.body #>> '{entry,data,reviewId}' is distinct from v_review.id::text
		or v_event.body #>> '{entry,data,operation}' is distinct from 'machine_run'
		or v_event.body #>> '{entry,data,approverScope}' is distinct from 'member' then
		raise exception 'The card is the thread''s transcript entry, under the worker''s run: %', to_jsonb(v_event); end if;
	-- A replay answers the same receipt and writes nothing more.
	r2 := pg_temp.ask(w, 'worker-call-1');
	if r2 <> r or (select count(*) from public.qorpera_session_events where event_id = v_review.id) <> 1 then
		raise exception 'A replay of the ask: %', r2; end if;
	-- The worker's own repeat and another worker's hold on that card (it is elsewhere for them); the thread's own run holds
	-- on it there. None raises a second card.
	foreach r2 in array array[pg_temp.begin(w), pg_temp.begin(pg_temp.worker_run())] loop
		if r2 ->> 'state' is distinct from 'pending' or r2 ->> 'reviewId' is distinct from v_review.id::text
			or (r2 ->> 'cardElsewhere')::boolean is not true then
			raise exception 'A worker''s repeat holds on the card in the thread: %', r2; end if;
	end loop;
	r2 := pg_temp.begin(pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', c_owner)));
	if r2 ->> 'state' is distinct from 'pending' or r2 ->> 'reviewId' is distinct from v_review.id::text
		or (r2 ->> 'cardElsewhere')::boolean is not false then
		raise exception 'The thread''s own run holds on the card there: %', r2; end if;
	-- A worker for another member makes the same call for them: the owner's card is not theirs to wait on.
	r2 := pg_temp.begin(pg_temp.worker_run(p_requester => '63400000-0000-4000-8000-000000000002'));
	if r2 ->> 'state' is distinct from 'review' then
		raise exception 'Another member''s run does not hold on the owner''s card: %', r2; end if;
	if (select count(*) from public.qorpera_action_reviews where profile_id = '63400000-0000-4000-8000-000000000010'
			and tool_name = 'machine_run') <> 1 then
		raise exception 'No second card is raised'; end if;
	-- The rail: the owner (the member the worker works for) sees the card by agent and thread; another member does not.
	if pg_temp.waiting(c_owner) is distinct from jsonb_build_array(jsonb_build_object('staffAgentId',
			'63400000-0000-4000-8000-0000000000a1', 'sessionId', pg_temp.thread(), 'count', 1, 'latestAt', v_review.created_at))
		or pg_temp.waiting('63400000-0000-4000-8000-000000000002') <> '[]'::jsonb then
		raise exception 'The waiting card shows for the owner only: % %', pg_temp.waiting(c_owner),
			pg_temp.waiting('63400000-0000-4000-8000-000000000002'); end if;
	perform set_config('qorpera_test.worker', w::text, true);
	perform set_config('qorpera_test.card', v_review.id::text, true);
end $$;

-- 2. No card where none may wait: decide_routine, an agent whose thread is closed, a run whose reads the thread may not
-- show, and a member's private conversation (a worker its run started, or an owners' and admins' card asked there) ----
do $$
declare w jsonb := pg_temp.worker_run(); b jsonb := pg_temp.worker_run('63400000-0000-4000-8000-0000000000a2'); r jsonb;
	v_private uuid; x jsonb;
begin
	-- A worker that read a member's private folder: its card would show that in the company-wide thread.
	x := pg_temp.worker_run();
	v_private := (public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(2),
		'members/63400000-0000-4000-8000-000000000002/private', 'subtree', 'member_private', 'normal') ->> 'resourceId')::uuid;
	perform pg_temp.fx(format($q$insert into public.qorpera_folder_run_reads(run_id, environment_id, resource_id, resource_revision)
		select %L, environment_id, id, authority_revision from public.qorpera_company_path_resources where id = %L$q$,
		x ->> 'runId', v_private));
	r := pg_temp.ask(x, 'worker-private-read');
	if (r ->> 'card')::boolean is not false
		or (select card_session_id from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid) is not null then
		raise exception 'A run whose reads the thread may not show raises no card there: %', r; end if;
	-- A worker a member's private conversation started.
	r := pg_temp.ask(pg_temp.worker_run(p_private => true), 'worker-private-parent');
	if (r ->> 'card')::boolean is not false
		or (select card_session_id from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid) is not null then
		raise exception 'A private conversation''s worker raises no card in the thread: %', r; end if;
	-- An owners' and admins' card asked in a member's private conversation is refused there, as before.
	r := pg_temp.ask(pg_temp.native(pg_temp.make_private(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human',
		'63400000-0000-4000-8000-000000000001'), '63400000-0000-4000-8000-000000000001')), 'private-money', p_built_in => 'money');
	if r ->> 'approverScope' is distinct from 'owners_admins' or (r ->> 'card')::boolean is not false
		or (select card_session_id from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid) is not null then
		raise exception 'An owners'' and admins'' card from a private conversation stays refused: %', r; end if;
	r := pg_temp.ask(w, 'worker-routine', 'decide_routine');
	if r ->> 'decision' <> 'ask' or (r ->> 'card')::boolean is not false or (r ->> 'cardElsewhere')::boolean is not false
		or (select card_session_id from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid) is not null then
		raise exception 'decide_routine raises no card: %', r; end if;
	if pg_temp.thread('63400000-0000-4000-8000-0000000000a2') is null then raise exception 'Fixture: agent B has a thread'; end if;
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = ''closed'' where id = %L',
		pg_temp.thread('63400000-0000-4000-8000-0000000000a2')));
	r := pg_temp.ask(b, 'worker-closed');
	if (r ->> 'card')::boolean is not false
		or (select card_session_id from public.qorpera_action_reviews where id = (r ->> 'reviewId')::uuid) is not null then
		raise exception 'A closed thread takes no card: %', r; end if;
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = ''open'' where id = %L',
		pg_temp.thread('63400000-0000-4000-8000-0000000000a2')));
end $$;

-- 3. The owner's answer wakes the agent in its thread, carrying on the worker's work; that run's identical call uses
-- the approval, and the card waits for no one any more.
do $$
declare w jsonb := current_setting('qorpera_test.worker')::jsonb; v_card uuid := current_setting('qorpera_test.card')::uuid;
	c_owner constant uuid := '63400000-0000-4000-8000-000000000001'; r jsonb; b jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype; v_review public.qorpera_action_reviews%rowtype;
begin
	-- The worker holds for no one: it parks the card at once and finishes its work.
	r := public.qorpera_await_action_review(w, v_card, true);
	if r ->> 'state' is distinct from 'parked' then raise exception 'The worker parks its card: %', r; end if;
	perform pg_temp.path_claims('authenticated', c_owner);
	r := pg_temp.answer_review(v_card, '56800000-0000-4000-8000-0000000000a1', 'allow_once');
	perform pg_temp.path_claims('service_role');
	select * into strict v_wake from public.qorpera_wake_occurrences where source_id = (r ->> 'inputId')::uuid;
	if (r ->> 'woke')::boolean is not true or v_wake.wake_kind <> 'room' or v_wake.source_kind <> 'room'
		or v_wake.staff_agent_id <> '63400000-0000-4000-8000-0000000000a1' or v_wake.session_id <> pg_temp.thread()
		or v_wake.requested_by_user_id <> c_owner then
		raise exception 'The answer wakes the agent in its thread: % %', r, to_jsonb(v_wake); end if;
	-- Its run carries on the worker's: the origin is the worker's run (the fixture's worker wake has none of its own), so
	-- the review reads the request of the work the worker did.
	if v_wake.origin_run_id is distinct from (w ->> 'runId')::uuid then
		raise exception 'The woken run carries on the worker''s work: %', to_jsonb(v_wake); end if;
	-- The run that wake becomes (a hand-built run in the thread, made that wake's room delivery) repeats the identical
	-- call: it is approved once, by that card.
	b := pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', c_owner));
	perform pg_temp.fx(format($q$delete from public.qorpera_wake_occurrences where run_id = %1$L;
		update public.qorpera_wake_occurrences set run_id = %1$L, status = 'materialized' where id = %2$L;
		update public.qorpera_execution_runs set source_kind = 'room_delivery', source_id = %2$L, input_ids = '{}'
		where id = %1$L$q$, b ->> 'runId', v_wake.id));
	r := pg_temp.begin(b);
	select * into strict v_review from public.qorpera_action_reviews where id = v_card;
	if r ->> 'state' is distinct from 'approved' or r ->> 'reviewId' is distinct from v_card::text
		or v_review.consumed_run_id is distinct from (b ->> 'runId')::uuid then
		raise exception 'The woken run''s identical call uses the approval: % %', r, to_jsonb(v_review); end if;
	if pg_temp.waiting(c_owner) <> '[]'::jsonb then
		raise exception 'An answered card waits for no one: %', pg_temp.waiting(c_owner); end if;
end $$;

-- 4. The rail's read: an owners' and admins' card shows for an owner or admin only; the API roles -------------------------
do $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($q$insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id,
			session_id, requester_user_id, tool_name, effect, argument_sha256, action, decision, built_in, reason, reviewer_model,
			approver_scope, card_session_id)
		values (%L, '63400000-0000-4000-8000-000000000010', %L, 'company-call', '63400000-0000-4000-8000-0000000000a2', null,
			'63400000-0000-4000-8000-000000000002', 'send_email', 'external', repeat('d', 64), '{}', 'ask', 'money', 'It pays.',
			'gpt-test', 'owners_admins', %L)$q$,
		v_id, current_setting('qorpera_test.worker')::jsonb ->> 'runId', pg_temp.thread('63400000-0000-4000-8000-0000000000a2')));
	if pg_temp.waiting('63400000-0000-4000-8000-000000000005') -> 0 ->> 'staffAgentId' is distinct from '63400000-0000-4000-8000-0000000000a2'
		or jsonb_array_length(pg_temp.waiting('63400000-0000-4000-8000-000000000001')) <> 1
		or pg_temp.waiting('63400000-0000-4000-8000-000000000002') <> '[]'::jsonb then
		raise exception 'A company card shows for owners and admins only: % %', pg_temp.waiting('63400000-0000-4000-8000-000000000005'),
			pg_temp.waiting('63400000-0000-4000-8000-000000000002'); end if;
	perform pg_temp.raises_like($q$select public.qorpera_list_member_waiting_approvals('63400000-0000-4000-8000-000000000010')$q$,
		'42501', 'profile read access is required');
	if has_function_privilege('anon', 'public.qorpera_list_member_waiting_approvals(uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_list_member_waiting_approvals(uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_list_member_waiting_approvals(uuid)', 'execute') then
		raise exception 'Only members read their waiting cards'; end if;
end $$;

-- 5. A Deny stands where its card is: for the thread's run, the run it woke and a later worker, until a member writes
-- there; then a new try asks again (record's retry check) ------------------------------------------------------------
do $$
declare w jsonb := pg_temp.worker_run(); later jsonb := pg_temp.worker_run(); c_owner constant uuid := '63400000-0000-4000-8000-000000000001';
	t jsonb := pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', c_owner)); r jsonb; v_card uuid;
begin
	r := pg_temp.ask(w, 'deny-call', p_sha => repeat('7', 64));
	v_card := (r ->> 'reviewId')::uuid;
	if (r ->> 'cardElsewhere')::boolean is not true then raise exception 'Fixture: the card is in the thread: %', r; end if;
	perform public.qorpera_await_action_review(w, v_card, true);
	perform pg_temp.path_claims('authenticated', c_owner);
	r := pg_temp.answer_review(v_card, '56800000-0000-4000-8000-0000000000a2', 'deny');
	perform pg_temp.path_claims('service_role');
	if (r ->> 'woke')::boolean is not true then raise exception 'The Deny wakes the agent in its thread: %', r; end if;
	foreach r in array array[pg_temp.begin(t, repeat('7', 64)), pg_temp.begin(w, repeat('7', 64)),
		pg_temp.begin(later, repeat('7', 64))] loop
		if r ->> 'state' is distinct from 'declined' or r ->> 'reviewId' is distinct from v_card::text then
			raise exception 'The Deny stands for the thread''s run, the worker and a later worker: %', r; end if;
	end loop;
	perform set_config('qorpera_test.denied', v_card::text, true);
end $$;
do $$
declare b jsonb := pg_temp.owner_run('ack-after-deny'); r jsonb;
begin
	-- A member wrote in the thread since (this run's own post, dated after the Deny: the file's statements may share
	-- one statement time): the call is reviewed again, and an allow asks on a card.
	perform pg_temp.fx(format('update public.qorpera_session_inputs set created_at = clock_timestamp() where execution_run_id = %L',
		b ->> 'runId'));
	r := pg_temp.begin(b, repeat('7', 64));
	if r ->> 'state' is distinct from 'review' then raise exception 'After a member writes, the call is reviewed again: %', r; end if;
	r := pg_temp.ask(b, 'after-deny', p_sha => repeat('7', 64), p_decision => 'allow');
	if r ->> 'decision' is distinct from 'ask' or (r ->> 'card')::boolean is not true
		or (r ->> 'cardElsewhere')::boolean is not false then
		raise exception 'A call denied on a card in the thread asks again there: %', r; end if;
end $$;

-- 6. A card in a thread that closed holds nothing: a repeat is reviewed again -----------------------------------------
do $$
declare w jsonb := pg_temp.worker_run('63400000-0000-4000-8000-0000000000a2'); r jsonb;
begin
	r := pg_temp.ask(w, 'closed-later', p_sha => repeat('6', 64));
	if (r ->> 'cardElsewhere')::boolean is not true then raise exception 'Fixture: B''s card is in its thread: %', r; end if;
	if pg_temp.begin(pg_temp.worker_run('63400000-0000-4000-8000-0000000000a2'), repeat('6', 64)) ->> 'state'
			is distinct from 'pending' then
		raise exception 'While B''s thread is open, a repeat holds on its card'; end if;
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = ''closed'' where id = %L',
		pg_temp.thread('63400000-0000-4000-8000-0000000000a2')));
	r := pg_temp.begin(pg_temp.worker_run('63400000-0000-4000-8000-0000000000a2'), repeat('6', 64));
	if r ->> 'state' is distinct from 'review' then raise exception 'A closed thread''s card holds nothing: %', r; end if;
end $$;

rollback;
