-- 20260930518000: the run a member's Allow once (or Always allow) wakes is reviewed against the request that started the
-- agent's work, not only against "a member approved a card" (C6-8b, 20 October 2026).
--
-- On production a Co-Founder routine's run asked to send a mail; its review asked, so the card parked. The member's
-- Allow once woke the agent in its thread (qorpera_answer_action_review's room wake of the answer's input), and that
-- run sent the mail through the card's own approval (20260930489000). Its next call, a routine change (manage_routine,
-- a delegation), was reviewed against the run's request alone, the card answer, and denied as not requested: the
-- routine's intent, which the agent was carrying on, was not in it.
--
-- qorpera_wake_origin (20260930497000) gets one more branch, a room wake whose source is a member's approval of the
-- agent's card, and its agent branch one more case (4). Its origin is the card's run, or that run's own origin when it has one (a card a worker's report or a
-- machine event led to). The review then reads that run's request as 497000 gives it (its member inputs, the room posts
-- its wake named, its routine's intent), after the card answer.
-- 1. The answer is the wake's source input, a member message in the wake's conversation by the wake's requester, with
--    the body qorpera_answer_action_review writes: schema qorpera.interaction-answer/v1, surface approval, outcome
--    approved, answer allow_once or always_allow. The outcome is read from that body: the review's own answer is
--    written after the wake. A member's post cannot carry that body (a post is qorpera.session-prompt/v1 only), and
--    qorpera_answer_interaction refuses an action review's card.
-- 2. The card is the action review the answer names: decision ask, of the same company and agent, its card in that
--    conversation.
-- 3. The card's run must be of the same company, environment, agent and requester as the wake (as 497000 requires of a
--    parent): an answer by another member (an owner or admin answering for the company) gives none. A Deny, a card
--    answered with ask_member, a plain post and every other kind give none, as before.
-- 4. A run that run starts in turn (its worker, its worker's report, a machine event or check-in, an office start) carries
--    the same origin, so the request is not lost one step later: the agent branch's room parent passes on its origin when
--    it has one. A room run without one (a plain post's) is still the origin of its own chain, as 497000 has it.
-- Set once by the BEFORE INSERT trigger, as 497000 sets it; qorpera_guard_wake_identity refuses any later change. The
-- review still decides every call: the origin only adds the request the run carries on (contract, "2026-09-25
-- amendment: auto-review rules and approvals", item 3, amended 2026-10-20).
--
-- Deploy order: either. On a runtime without the matching change the room run's origin is never read (the runtime
-- reads an origin only for the agent's own chain); a runtime with it finds no origin on room runs until this applies.

set local lock_timeout = '3s';

create temporary table approval_origin_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid = 'public.qorpera_wake_origin(public.qorpera_wake_occurrences)'::regprocedure;

create or replace function public.qorpera_wake_origin(p_wake public.qorpera_wake_occurrences)
returns uuid language sql stable security definer set search_path = '' as $$
	select case when parent_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event',
			'machine-checkin') then parent_wake.origin_run_id
		-- 20260930518000: a run an approval woke passes on the run it carries on; any other room run, itself, as before.
		when parent_wake.source_kind = 'room' and parent_wake.origin_run_id is not null then parent_wake.origin_run_id
		else parent.id end
	from public.qorpera_execution_runs parent
	left join public.qorpera_wake_occurrences parent_wake on parent_wake.run_id = parent.id
	where p_wake.wake_kind = 'agent'
		and p_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin')
		and parent.id = p_wake.parent_run_id and parent.profile_id = p_wake.profile_id
		and parent.environment_id = p_wake.environment_id and parent.staff_agent_id = p_wake.staff_agent_id
		and parent.requested_by_user_id = p_wake.requested_by_user_id
	union all
	-- 20260930518000: a member's approval of the agent's card, delivered in its thread. The outcome is the answer's own
	-- (the review's answer is written after the wake); the card's run is the requester's, or none.
	select coalesce(card_wake.origin_run_id, card.id)
	from public.qorpera_session_inputs input
	join public.qorpera_action_reviews review on review.id = case
		when input.body ->> 'interactionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then (input.body ->> 'interactionId')::uuid end
	join public.qorpera_execution_runs card on card.id = review.run_id
	left join public.qorpera_wake_occurrences card_wake on card_wake.run_id = card.id
	where p_wake.wake_kind = 'room' and p_wake.source_kind = 'room'
		and input.id = p_wake.source_id and input.session_id = p_wake.session_id and input.kind = 'user_message'
		and input.author_user_id = p_wake.requested_by_user_id
		and input.body ->> 'schema' = 'qorpera.interaction-answer/v1' and input.body ->> 'surface' = 'approval'
		and input.body ->> 'outcome' = 'approved' and input.body -> 'answer' ->> 'answer' in ('allow_once','always_allow')
		and review.decision = 'ask' and review.card_session_id = input.session_id
		and review.profile_id = p_wake.profile_id and review.staff_agent_id = p_wake.staff_agent_id
		and card.profile_id = p_wake.profile_id and card.environment_id = p_wake.environment_id
		and card.staff_agent_id = p_wake.staff_agent_id and card.requested_by_user_id = p_wake.requested_by_user_id
$$;
revoke all on function public.qorpera_wake_origin(public.qorpera_wake_occurrences)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare v_origin text := (select prosrc from pg_proc
	where oid = 'public.qorpera_wake_origin(public.qorpera_wake_occurrences)'::regprocedure);
begin
	if position('20260930518000' in v_origin) = 0
		or exists (
			select 1 from pg_temp.approval_origin_before as prior join pg_proc as patched on patched.oid = prior.oid
			where patched.prosecdef is distinct from prior.prosecdef or patched.proconfig is distinct from prior.proconfig
				or patched.provolatile is distinct from prior.provolatile
				or patched.proacl::text is distinct from prior.proacl::text)
		or (select count(*) from pg_proc where proname = 'qorpera_wake_origin') <> 1
		or (select count(*) from pg_trigger where tgname = 'qorpera_wake_origin'
			and tgrelid = 'public.qorpera_wake_occurrences'::regclass and not tgisinternal) <> 1 then
		raise exception '20260930518000: qorpera_wake_origin did not change as expected'; end if;
end $$;
