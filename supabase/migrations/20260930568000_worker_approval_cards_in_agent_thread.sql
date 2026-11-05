-- 20260930568000: an approval a worker (or any run with no card of its own) asks for waits on a card in its agent's own
-- thread, where a member can answer it.
--
-- Production, 4 November 2026: three asks (Lærdom 14:17:53, machine_run `npm install playwright ...`; Armbånd.dk 15:05:04
-- and 15:07:14, machine_run fetching public competitor pages) came from workers. qorpera_record_action_review raises a
-- card only in the run's own conversation, and never for a worker or a run with none, so the reviews have no card
-- (session_id and card_session_id null). Nobody could answer them; the work stayed blocked and the runtime told the
-- worker APPROVAL_UNAVAILABLE_HERE.
--
-- 1. qorpera_record_action_review: an ask that gets no card in the run's own conversation (a worker's, a run with none,
--    a group chat's) puts its card in the agent's own thread: the active room bound to the agent, its session open,
--    company-wide and pinned as the run's own would be (the transcript append's check), and only when everything the
--    run read may be read there (as for a coworker's message into that thread). The card is the same transcript entry,
--    written into that session with the run's execution, and card_session_id names the thread. decide_routine still
--    raises no card. Folder-v2 only (the native tool path is folder-v2 only since 20260930246000).
--    A member's private conversation keeps its content (decided for this fix, conservatively; a product question for
--    later): a run there, a run whose audience is private, or a worker a private conversation's run started raises no
--    card anywhere else, as before, so an owners' and admins' card asked there is still refused.
--    A denial on a card in a conversation counts in it, wherever the call was asked from: the retry check (an earlier
--    denial of the same call makes a new try ask) reads card_session_id too, and for a run with no conversation, a
--    card a run with none raised.
-- 2. The answer needs no change: qorpera_answer_action_review wakes the thread's agent (the card's agent) in that thread
--    on the answering member's account, once no call holds the card. That run's identical call (tool and argument
--    digest) uses the approval through qorpera_begin_action_review's first check (20260930489000), and its review
--    reads the request of the card's run's chain (qorpera_wake_origin, 20260930518000). A call still holding the card
--    reads the answer as before.
-- 3. qorpera_begin_action_review: a card raised from this run's conversation (or by a run with none, for a run with
--    none) waits for the same call wherever the card is, while the card's conversation is open, so a repeat holds on
--    it instead of raising a second card. A denial stands where its card is: for a run in that conversation (the run
--    the answer woke included) until a member writes there again, and for a run with none when a run with none asked.
--    Its 'pending' answer says whether the card is elsewhere (cardElsewhere), and so does the record's receipt
--    (qorpera_action_review_receipt), so the runtime can say the card waits in the agent's thread.
-- 4. qorpera_list_member_waiting_approvals(p_profile_id), for the web rail: the cards that wait for the caller's answer
--    in their agent's own thread (where the rail's link goes), by agent. A partial index keeps the read on waiting cards.
--
-- The pre-check refuses unless each changed body is the one master's migrations give (by md5) and each anchor occurs
-- once. The catalog check refuses unless exactly these three functions changed, only in their bodies, and the one new
-- function came. Every inserted text names this migration, for the deploy guard.
-- Deploy order: this migration first, then the runtime that reads cardElsewhere (an older runtime holds and parks a
-- thread card as any other, and says the card is in "this conversation"), then the web that reads the waiting cards
-- (an older cloud answers that read as missing and the rail shows nothing new).

do $$
declare v record;
begin
	if to_regprocedure('public.qorpera_list_member_waiting_approvals(uuid)') is not null then
		raise exception '20260930568000 is already applied'; end if;
	for v in select * from (values
		('public.qorpera_record_action_review(jsonb,jsonb)', '72ee23281469ab70a3795cd3ec8c64f0'),
		('public.qorpera_begin_action_review(jsonb,jsonb)', '2f9f2a3e424efc2ec81e1eaa25c2cfc7'),
		('public.qorpera_action_review_receipt(public.qorpera_action_reviews)', '6d517aa9793f303cb4810c61ac398fe4'))
		as pinned(signature, source)
	loop
		if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(v.signature)), '')) <> v.source then
			raise exception '20260930568000: % differs from its pinned body', v.signature; end if;
	end loop;
	if to_regprocedure('public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)') is null
		or to_regprocedure('public.qorpera_folder_append_transcript_event(public.qorpera_execution_runs,uuid,uuid,text,jsonb)') is null then
		raise exception '20260930568000 needs the folder core''s reads check and transcript append'; end if;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table v199_cards_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source, null::text as expected
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.v199_cards_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930568000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	-- What the catalog check expects: the body with this replacement and the ones before it.
	update pg_temp.v199_cards_before as prior set expected = md5(replace(
		(select p.prosrc from pg_proc as p where p.oid = p_function), p_old, p_new)) where prior.oid = p_function;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Record: the card of an ask with no card of its own goes to the agent's thread ------------------------------------

select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	v_retry boolean; v_company_before boolean; v_restricted boolean := false;
$old$,
	$new$	v_retry boolean; v_company_before boolean; v_restricted boolean := false;
	-- 20260930568000: where the card goes (the run's own conversation or its agent's thread), and the run as it writes there.
	v_card_session uuid; v_card_run public.qorpera_execution_runs%rowtype; v_audience public.qorpera_wake_occurrences%rowtype;
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		and prior.requester_user_id = v_run.requested_by_user_id and prior.session_id = v_run.session_id;
$old$,
	$new$		and prior.requester_user_id = v_run.requested_by_user_id
		-- 20260930568000: a denial on a card in this conversation counts too, wherever its call was asked; for a run with
		-- none, one on a card a run with none raised.
		and (prior.session_id = v_run.session_id or prior.card_session_id = v_run.session_id
			or (v_run.session_id is null and prior.session_id is null and prior.card_session_id is not null));
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		and not (v_scope = 'owners_admins' and exists (select 1 from public.qorpera_shared_sessions as session
			where session.id = v_run.session_id and session.audience_kind = 'member_private'
				and session.audience_user_id is distinct from null));
$old$,
	$new$		and not (v_scope = 'owners_admins' and exists (select 1 from public.qorpera_shared_sessions as session
			where session.id = v_run.session_id and session.audience_kind = 'member_private'
				and session.audience_user_id is distinct from null));
	if v_card then v_card_session := v_run.session_id; end if;
	-- 20260930568000: an ask that gets no card here (a worker's, a run with no conversation, a group chat's) waits in the
	-- agent's own thread, where every member reads it and the answer wakes the agent. Only an open, company-wide thread
	-- pinned as the transcript append checks, and only when everything the run read may be read there, as for a
	-- coworker's message into it. A member's private conversation keeps its content: a run there, a run whose audience is
	-- private, or a worker such a run started raises no card elsewhere. Reads only, no lock.
	if not v_card and v_decision = 'ask' and p_review ->> 'tool' <> 'decide_routine'
		and public.qorpera_environment_is_folder_v2(v_run.environment_id)
		and v_run.audience_kind = 'company'
		and not exists (select 1 from public.qorpera_shared_sessions as session
			where session.id = v_run.session_id and session.audience_kind <> 'company')
		and not exists (select 1 from public.qorpera_wake_occurrences as wake
			join public.qorpera_execution_runs as parent on parent.id = wake.parent_run_id
			left join public.qorpera_shared_sessions as session on session.id = parent.session_id
			where wake.run_id = v_run.id
				and (parent.audience_kind is distinct from 'company' or session.audience_kind <> 'company')) then
		select session.id into v_card_session from public.qorpera_company_rooms as room
		join public.qorpera_shared_sessions as session on session.id = room.session_id
		where room.profile_id = v_run.profile_id and room.bound_staff_agent_id = v_run.staff_agent_id and room.status = 'active'
			and session.status = 'open' and session.audience_kind = 'company'
			and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
			and (session.staff_agent_id is not null and session.staff_version <> v_run.staff_version
				and not (v_run.source_kind in ('wake', 'room_delivery') and v_run.staff_version > session.staff_version)) is not true;
		if v_card_session is not null then
			v_audience.profile_id := v_run.profile_id; v_audience.environment_id := v_run.environment_id;
			v_audience.parent_run_id := v_run.id; v_audience.staff_agent_id := v_run.staff_agent_id;
			v_audience.requested_by_user_id := v_run.requested_by_user_id;
			if not public.qorpera_folder_parent_reads_allowed(v_audience) then v_card_session := null; end if;
		end if;
		v_card := v_card_session is not null;
	end if;
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;
$old$,
	$new$		perform 1 from public.qorpera_shared_sessions where id = v_card_session for update; -- 20260930568000: the card's conversation
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		v_scope, v_approver, case when v_card then v_run.session_id end,
$old$,
	$new$		v_scope, v_approver, case when v_card then v_card_session end, -- 20260930568000
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		where event.session_id = v_run.session_id order by event.sequence desc limit 1;
$old$,
	$new$		where event.session_id = v_card_session order by event.sequence desc limit 1; -- 20260930568000
$new$);
select pg_temp.v199_cards_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$			perform public.qorpera_folder_append_transcript_event(v_run, (p_binding ->> 'assignmentId')::uuid, v_review.id,
$old$,
	$new$			-- 20260930568000: into the card's conversation, under the run's own execution.
			v_card_run := v_run; v_card_run.session_id := v_card_session;
			perform public.qorpera_folder_append_transcript_event(v_card_run, (p_binding ->> 'assignmentId')::uuid, v_review.id,
$new$);

-- 2. The receipt says whether the card is elsewhere than the run's own conversation ----------------------------------

select pg_temp.v199_cards_replace('public.qorpera_action_review_receipt(public.qorpera_action_reviews)'::regprocedure,
	$old$		'reason', p_review.reason, 'card', p_review.card_session_id is not null,
$old$,
	$new$		'reason', p_review.reason, 'card', p_review.card_session_id is not null,
		-- 20260930568000: the card waits in the agent's thread, not in the run's own conversation.
		'cardElsewhere', p_review.card_session_id is not null and p_review.card_session_id is distinct from p_review.session_id,
$new$);

-- 3. Begin: a denial stands where its card is; a card raised from this conversation waits for the same call ----------

select pg_temp.v199_cards_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$				or (review.session_id = v_run.session_id and not exists (
					select 1 from public.qorpera_session_inputs as input
					where input.session_id = v_run.session_id and input.kind = 'user_message'
$old$,
	$new$				-- 20260930568000: a denial on a card in this conversation stands here too, wherever its call was asked (a
				-- worker's card in the agent's thread), and for a run with none, one on a card a run with none raised, until
				-- a member writes where the card is.
				or ((review.session_id = v_run.session_id or review.card_session_id = v_run.session_id
						or (v_run.session_id is null and review.session_id is null and review.card_session_id is not null))
					and not exists (
					select 1 from public.qorpera_session_inputs as input
					where input.session_id = coalesce(v_run.session_id, review.card_session_id) and input.kind = 'user_message'
$new$);

select pg_temp.v199_cards_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$		or (review.decision = 'ask' and review.answer is null and review.card_session_id = v_run.session_id))
$old$,
	$new$		or (review.decision = 'ask' and review.answer is null and review.card_session_id = v_run.session_id)
			-- 20260930568000: a card a run of this conversation (or, for a run with none, a run with none) raised in the
			-- agent's thread, while that thread is open: a repeat holds on it rather than raising a second card there.
			or (review.decision = 'ask' and review.answer is null and review.card_session_id is not null
				and review.session_id is not distinct from v_run.session_id
				and exists (select 1 from public.qorpera_shared_sessions as card_session
					where card_session.id = review.card_session_id and card_session.status = 'open')))
$new$);
select pg_temp.v199_cards_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$			'approverScope', v_review.approver_scope,
$old$,
	$new$			'approverScope', v_review.approver_scope,
			'cardElsewhere', v_review.card_session_id is distinct from v_run.session_id, -- 20260930568000
$new$);

-- 4. The cards that wait for a member, for the rail ------------------------------------------------------------------

create index qorpera_action_reviews_waiting_cards on public.qorpera_action_reviews(profile_id, created_at desc)
	where decision = 'ask' and answer is null and card_session_id is not null;

-- 20260930568000: the approval cards that wait for the caller's answer, by agent: their own (approverScope member)
-- and, for an owner or admin, the company's. Only cards in their agent's own open thread (where every card of a
-- folder-v2 company is, and where the rail's link goes) that the caller may read.
create function public.qorpera_list_member_waiting_approvals(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.member-waiting-approvals/v1', 'approvals', coalesce((
		select jsonb_agg(jsonb_build_object('staffAgentId', waiting.staff_agent_id, 'sessionId', waiting.card_session_id,
				'count', waiting.count, 'latestAt', waiting.latest) order by waiting.latest desc)
		from (
			select review.staff_agent_id, review.card_session_id, count(*)::integer as count, max(review.created_at) as latest
			from public.qorpera_action_reviews as review
			join public.qorpera_shared_sessions as session on session.id = review.card_session_id and session.status = 'open'
			join public.qorpera_company_rooms as room on room.session_id = review.card_session_id
				and room.bound_staff_agent_id = review.staff_agent_id and room.profile_id = review.profile_id
			where review.profile_id = p_profile_id and review.decision = 'ask' and review.answer is null
				and review.card_session_id is not null
				and ((review.approver_scope = 'member' and review.approver_user_id = auth.uid())
					or (review.approver_scope = 'owners_admins' and public.qorpera_can_authorize_profile(p_profile_id)))
				and public.qorpera_can_read_session(review.card_session_id)
			group by review.staff_agent_id, review.card_session_id
			order by max(review.created_at) desc
			limit 200
		) as waiting
	), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_list_member_waiting_approvals(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_member_waiting_approvals(uuid) to authenticated;

-- The markers, in order ----------------------------------------------------------------------------------------------

do $guard$
declare v record; v_source text; v_at integer; v_next integer;
begin
	for v in select * from (values
		('public.qorpera_record_action_review(jsonb,jsonb)', 7, array['v_card_session uuid', '20260930568000',
			'prior.card_session_id = v_run.session_id', 'v_card := v_decision = ''ask''', '20260930568000',
			'v_run.audience_kind = ''company''', 'qorpera_folder_parent_reads_allowed(v_audience)', '20260930546000',
			'where id = v_card_session for update', 'case when v_card then v_card_session end',
			'where event.session_id = v_card_session', 'v_card_run.session_id := v_card_session',
			'qorpera_folder_append_transcript_event(v_card_run']),
		('public.qorpera_action_review_receipt(public.qorpera_action_reviews)', 1, array['''card'', p_review.card_session_id',
			'20260930568000', '''cardElsewhere''']),
		('public.qorpera_begin_action_review(jsonb,jsonb)', 3, array['20260930568000', 'review.card_session_id = v_run.session_id',
			'coalesce(v_run.session_id, review.card_session_id)',
			'review.answer is null and review.card_session_id = v_run.session_id)', '20260930568000',
			'review.session_id is not distinct from v_run.session_id', 'card_session.status = ''open''',
			'''state'', ''pending''', '''cardElsewhere''', '20260930568000'])) as guard(signature, markers, texts)
	loop
		v_source := (select prosrc from pg_proc where oid = v.signature::regprocedure);
		if (length(v_source) - length(replace(v_source, '20260930568000', ''))) / length('20260930568000') <> v.markers then
			raise exception '20260930568000 marker is not % times in %', v.markers, v.signature; end if;
		v_at := 0;
		for i in 1 .. cardinality(v.texts) loop
			v_next := strpos(substr(v_source, v_at + 1), v.texts[i]);
			if v_next = 0 then
				raise exception '20260930568000 change is out of place in %: %', v.signature, v.texts[i]; end if;
			v_at := v_at + v_next;
		end loop;
	end loop;
end $guard$;

-- The catalog check ---------------------------------------------------------------------------------------------------

-- Exactly the three functions changed, each only in its body and by its replacements; every other public function is
-- as it was, and only the waiting-cards read came.
do $$ begin
	if (select count(*) from pg_temp.v199_cards_before where expected is not null) <> 3
		or exists (select 1 from pg_temp.v199_cards_before as prior where prior.expected is not null and prior.oid not in (
			'public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
			'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
			'public.qorpera_action_review_receipt(public.qorpera_action_reviews)'::regprocedure))
		or exists (select 1 from pg_temp.v199_cards_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or md5(patched.prosrc) is distinct from coalesce(prior.expected, prior.source)
				or prior.expected = prior.source)
		or (select array_agg(p.proname::text) from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.v199_cards_before as prior))
			is distinct from array['qorpera_list_member_waiting_approvals'] then
		raise exception '20260930568000: the catalog did not change as expected'; end if;
end $$;

drop function pg_temp.v199_cards_replace(regprocedure, text, text);
drop table pg_temp.v199_cards_before;
