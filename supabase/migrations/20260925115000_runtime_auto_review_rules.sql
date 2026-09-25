-- Bundle v115: auto-review rules (founder decisions 2026-09-24/25).
--
-- Members write plain-language rules for what agents may do: "When an agent
-- wants to <text>, it should: Ask first | Allow automatically". A rule applies
-- to one member ("only me") or to the whole company. Before an agent's acting
-- tool call runs (outside effects, deletions, delegation), the runtime asks a
-- separate reviewer model, on the run's own model account, whether the action
-- may go ahead, needs a member's approval first, or must not run at all. This
-- migration is the kernel half:
--
--   * qorpera_review_rules: the rules. Company rules are written by owners and
--     admins and read by every member; a member's own rules only by that member.
--   * qorpera_action_reviews: one row per reviewed tool call, the audit trail,
--     and the durable state of an approval (answer, parked, consumed).
--   * Member RPCs to list, save and archive rules, and to answer an approval
--     card (qorpera_answer_action_review).
--   * Runtime RPCs under the run's lease (p_binding), through the Company File
--     control lane: qorpera_begin_action_review (rules and names for the
--     reviewer, or an approval already given for this exact action),
--     qorpera_record_action_review (the verdict, and for an ask the approval
--     card in the run's conversation), qorpera_await_action_review (the held
--     call reads the answer; a call held too long parks).
--
-- Layering (decided 2026-09-24): built-in checks, then company rules, then the
-- personal rules of the member the run works for (requested_by_user_id, which
-- follows routines and coworker chains). Ask first wins everywhere. Only a
-- company Allow automatically rule that covers the action lifts a built-in
-- check's ask: those checks are the company's to answer, so a member's own
-- Allow rule never does (as in Grok, a member's rules only add care). The
-- kernel records whatever the reviewer decided but never lets an "allow" stand
-- next to a matched Ask first rule, or next to a built-in check no company
-- Allow rule covers.
--
-- Who answers a card: a personal rule's card only that member; a company
-- rule's or a built-in check's card any owner or admin. A card waits until
-- someone answers (no expiry). The runtime holds an attended call open for a
-- while (the member is likely around), renewing a short heartbeat, and then
-- parks it. An answer to a card no call is holding (parked, stopped, or its run
-- ended) wakes the agent in the card's conversation, on the answering member's
-- own model account; the agent repeats the exact call (the card shows its
-- exact arguments), which then runs without a second review (the approval is
-- consumed by that call). A member's Deny, or the reviewer's, stands for that
-- exact call in its run and conversation until a member writes there again.
-- The answer is refused by qorpera_answer_interaction: these cards are answered
-- only here.
--
-- Cards are raised only where cards live (the agent's own thread or a plain
-- conversation; never a group chat or a worker). Elsewhere an ask is recorded
-- without a card and the call is refused; the agent can repeat it from its
-- own thread.
--
-- Rollout: with the v115 activation. Nothing here changes what earlier
-- runtimes do; they never call these functions.
begin;

create table public.qorpera_review_rules (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	scope text not null check (scope in ('company', 'member')),
	member_user_id uuid references auth.users(id) on delete cascade,
	when_text text not null check (char_length(when_text) between 1 and 280 and when_text = btrim(when_text)
		and when_text !~ '[[:cntrl:]]'),
	outcome text not null check (outcome in ('ask_first', 'allow_automatically')),
	created_via text not null check (created_via in ('settings', 'card', 'agent')),
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_by_staff_agent_id uuid,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	archived_at timestamptz,
	check ((scope = 'member') = (member_user_id is not null))
);
create index qorpera_review_rules_active
	on public.qorpera_review_rules(profile_id, scope, member_user_id) where archived_at is null;

create table public.qorpera_action_reviews (
	id uuid primary key default pg_catalog.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	call_id text not null check (call_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
	staff_agent_id uuid not null,
	session_id uuid references public.qorpera_shared_sessions(id) on delete set null,
	requester_user_id uuid references auth.users(id) on delete set null,
	tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
	effect text not null check (effect in ('external', 'destructive', 'delegation')),
	argument_sha256 text not null check (argument_sha256 ~ '^[0-9a-f]{64}$'),
	action jsonb not null check (jsonb_typeof(action) = 'object' and octet_length(action::text) <= 196608),
	decision text not null check (decision in ('allow', 'ask', 'deny')),
	rule_ids uuid[] not null default '{}',
	built_in text not null check (built_in in
		('none', 'money', 'legal_terms', 'delete_outside', 'access_change', 'not_requested', 'unavailable')),
	reason text not null check (char_length(reason) between 1 and 500 and reason !~ '[[:cntrl:]]'),
	proposed_rule text check (proposed_rule is null
		or (char_length(proposed_rule) between 1 and 280 and proposed_rule !~ '[[:cntrl:]]')),
	reviewer_model text not null check (char_length(reviewer_model) between 1 and 160),
	approver_scope text check (approver_scope in ('member', 'owners_admins')),
	approver_user_id uuid references auth.users(id) on delete set null,
	card_session_id uuid references public.qorpera_shared_sessions(id) on delete set null,
	answer text check (answer in ('allow_once', 'always_allow', 'deny')),
	answered_by_user_id uuid references auth.users(id) on delete set null,
	answered_at timestamptz,
	saved_rule_id uuid references public.qorpera_review_rules(id) on delete set null,
	parked_at timestamptz,
	-- A holding call's heartbeat: while it lies ahead, a run is still polling this card
	-- and reads its answer; once it has passed (the call parked, stopped or its run
	-- ended), an answer wakes the agent instead.
	held_until timestamptz,
	woken_at timestamptz,
	consumed_at timestamptz,
	consumed_run_id uuid,
	created_at timestamptz not null default clock_timestamp(),
	unique (run_id, call_id),
	check ((decision = 'ask') = (approver_scope is not null)),
	check (approver_scope is distinct from 'member' or approver_user_id is not null),
	check ((answer is null) = (answered_at is null)),
	check (answer is null or decision = 'ask'),
	check (consumed_at is null or answer in ('allow_once', 'always_allow'))
);
-- The reviews of one exact action of one agent, latest first: every acting call
-- looks up the latest (qorpera_begin_action_review), denials included.
create index qorpera_action_reviews_action
	on public.qorpera_action_reviews(profile_id, staff_agent_id, tool_name, argument_sha256, created_at desc, id desc);

alter table public.qorpera_review_rules enable row level security;
alter table public.qorpera_action_reviews enable row level security;
revoke all on public.qorpera_review_rules, public.qorpera_action_reviews
	from public, anon, authenticated, service_role;

-- A rule as members and the runtime see it.
create function public.qorpera_review_rule_view(p_rule public.qorpera_review_rules)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('id', p_rule.id, 'scope', p_rule.scope, 'memberUserId', p_rule.member_user_id,
		'when', p_rule.when_text, 'outcome', p_rule.outcome, 'createdVia', p_rule.created_via,
		'createdByUserId', p_rule.created_by_user_id, 'createdByStaffAgentId', p_rule.created_by_staff_agent_id,
		'createdAt', p_rule.created_at, 'updatedAt', p_rule.updated_at)
$$;

-- The rules that apply to an action of an agent working for p_member_user_id:
-- every active company rule plus that member's own active rules.
create function public.qorpera_review_rules_for(p_profile_id uuid, p_member_user_id uuid)
returns setof public.qorpera_review_rules language sql stable security definer set search_path = '' as $$
	select rule.* from public.qorpera_review_rules as rule
	where rule.profile_id = p_profile_id and rule.archived_at is null
		and (rule.scope = 'company' or (rule.scope = 'member' and rule.member_user_id = p_member_user_id))
	order by rule.scope = 'company' desc, rule.created_at, rule.id
$$;

-- A rule's text as typed: trimmed, 1-280 characters, no control characters.
create function public.qorpera_review_rule_text(p_text text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_text text := btrim(coalesce(p_text, ''));
begin
	if char_length(v_text) not between 1 and 280 or v_text ~ '[[:cntrl:]]' then
		raise exception 'A rule is one short sentence (1 to 280 characters)' using errcode = '22023'; end if;
	return v_text;
end
$$;

-- Storage and review-prompt bound (not a cap on agents' work): the reviewer
-- reads every rule that applies to one action, so the company's rules and one
-- member's own rules are each kept within a fixed number of bytes.
create function public.qorpera_review_rules_assert_room(p_profile_id uuid, p_scope text, p_member_user_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if (select coalesce(sum(octet_length(rule.when_text)), 0) from public.qorpera_review_rules as rule
		where rule.profile_id = p_profile_id and rule.archived_at is null and rule.scope = p_scope
			and rule.member_user_id is not distinct from p_member_user_id)
		> (case when p_scope = 'company' then 49152 else 16384 end) then
		raise exception 'There are too many rules to review an action; remove some first' using errcode = '54000'; end if;
end
$$;

-- Settings: the company's rules and the caller's own, and whether the caller may edit company rules.
create function public.qorpera_list_review_rules(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
	if v_user is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only members of this company can read its rules' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.review-rules/v1', 'profileId', p_profile_id,
		'canManageCompanyRules', public.qorpera_can_authorize_profile(p_profile_id),
		'rules', coalesce((select jsonb_agg(public.qorpera_review_rule_view(rule))
			from public.qorpera_review_rules_for(p_profile_id, v_user) as rule), '[]'::jsonb));
end
$$;

-- Settings: create a rule (the client picks its id, so a retry is the same rule)
-- or change the text or outcome of an existing one. A company rule needs an
-- owner or admin; a personal rule belongs to the member who writes it.
create function public.qorpera_save_review_rule(p_profile_id uuid, p_rule_id uuid, p_scope text,
	p_when text, p_outcome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid(); v_text text; v_rule public.qorpera_review_rules%rowtype;
begin
	if v_user is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_rule_id is null or p_scope not in ('company', 'member') or p_outcome not in ('ask_first', 'allow_automatically') then
		raise exception 'Rule is invalid' using errcode = '22023'; end if;
	v_text := public.qorpera_review_rule_text(p_when);
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only members of this company can write rules' using errcode = '42501'; end if;
	if p_scope = 'company' and not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'Only owners and admins write company rules' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	select rule.* into v_rule from public.qorpera_review_rules as rule where rule.id = p_rule_id for update;
	if found then
		if v_rule.profile_id <> p_profile_id or v_rule.scope <> p_scope or v_rule.archived_at is not null
			or (v_rule.scope = 'member' and v_rule.member_user_id is distinct from v_user) then
			raise exception 'This rule cannot be changed here' using errcode = '42501'; end if;
		if (v_rule.when_text, v_rule.outcome) is distinct from (v_text, p_outcome) then
			update public.qorpera_review_rules set when_text = v_text, outcome = p_outcome, updated_at = clock_timestamp()
			where id = p_rule_id returning * into v_rule;
		end if;
	else
		insert into public.qorpera_review_rules (id, profile_id, scope, member_user_id, when_text, outcome,
			created_via, created_by_user_id)
		values (p_rule_id, p_profile_id, p_scope, case when p_scope = 'member' then v_user end, v_text, p_outcome,
			'settings', v_user)
		returning * into v_rule;
	end if;
	perform public.qorpera_review_rules_assert_room(p_profile_id, p_scope, v_rule.member_user_id);
	return public.qorpera_review_rule_view(v_rule);
end
$$;

-- Settings: remove a rule. Removing one that is already gone changes nothing.
create function public.qorpera_archive_review_rule(p_profile_id uuid, p_rule_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_rule public.qorpera_review_rules%rowtype;
begin
	if v_user is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only members of this company can remove rules' using errcode = '42501'; end if;
	select rule.* into v_rule from public.qorpera_review_rules as rule
	where rule.id = p_rule_id and rule.profile_id = p_profile_id for update;
	if not found then return jsonb_build_object('id', p_rule_id, 'archived', true); end if;
	if (v_rule.scope = 'company' and not public.qorpera_can_authorize_profile(p_profile_id))
		or (v_rule.scope = 'member' and v_rule.member_user_id is distinct from v_user) then
		raise exception 'This rule cannot be removed here' using errcode = '42501'; end if;
	update public.qorpera_review_rules set archived_at = coalesce(archived_at, clock_timestamp()), updated_at = clock_timestamp()
	where id = p_rule_id;
	return jsonb_build_object('id', p_rule_id, 'archived', true);
end
$$;

-- A member's display name for a card ("Waiting for Jonas").
create function public.qorpera_review_member_name(p_profile_id uuid, p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(nullif(btrim(member.display_name), ''), split_part(member.email, '@', 1))
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_user_id
$$;

-- Runtime: before reviewing one acting call. Returns an approval already given
-- for exactly this action and not yet used (consumed now, so it runs once), an
-- approval still waiting (the call holds on it instead of raising a second
-- card), or what the reviewer needs: the rules and the names.
create function public.qorpera_begin_action_review(p_binding jsonb, p_call jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_review public.qorpera_action_reviews%rowtype;
	v_agent public.qorpera_profile_staff%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_run.staff_agent_id is null then
		raise exception 'Only a company agent''s actions are reviewed' using errcode = '42501'; end if;
	if jsonb_typeof(p_call) is distinct from 'object' or p_call - array['tool','argumentSha256'] <> '{}'::jsonb
		or coalesce(p_call ->> 'tool', '') !~ '^[a-z][a-z0-9_]{0,63}$'
		or coalesce(p_call ->> 'argumentSha256', '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Action review request is invalid' using errcode = '22023'; end if;
	-- The latest review of exactly this action, by this agent, for the same member
	-- (an approval or a denial given for one member's work never serves another's).
	-- An answer to a parked card wakes the agent on the answering member's account
	-- in the card's conversation, so a run for the member who answered finds that
	-- card there, and only there. What counts:
	--   * a denial (the reviewer's, or a member's on the card) in the run it was
	--     given in, and in its conversation until a member writes there again: the
	--     agent gets no second opinion by retrying, but a member who asks again is
	--     heard, and the action is reviewed afresh;
	--   * an approval given, in any conversation of that member (used once);
	--   * a card still waiting, in this conversation only: elsewhere the member
	--     could not see it, so a new card is raised here.
	select review.* into v_review from public.qorpera_action_reviews as review
	where review.profile_id = v_run.profile_id and review.staff_agent_id = v_run.staff_agent_id
		and review.tool_name = p_call ->> 'tool' and review.argument_sha256 = p_call ->> 'argumentSha256'
		and (review.requester_user_id is not distinct from v_run.requested_by_user_id
			or (review.answered_by_user_id = v_run.requested_by_user_id and review.card_session_id = v_run.session_id))
		and (
			((review.decision = 'deny' or review.answer = 'deny') and (review.run_id = v_run.id
				or (review.session_id = v_run.session_id and not exists (
					select 1 from public.qorpera_session_inputs as input
					where input.session_id = v_run.session_id and input.kind = 'user_message'
						and coalesce(input.body ->> 'schema', '')
							not in ('qorpera.interaction-answer/v1', 'qorpera.staff-intro-retry/v1')
						and input.created_at > coalesce(review.answered_at, review.created_at)))))
			or (review.decision = 'ask' and review.answer in ('allow_once', 'always_allow'))
			or (review.decision = 'ask' and review.answer is null and review.card_session_id = v_run.session_id))
	order by review.created_at desc, review.id desc limit 1 for update;
	if found and (v_review.decision = 'deny' or v_review.answer = 'deny') then
		-- A denial stands for this exact call: a second opinion is not asked for.
		return jsonb_build_object('schema', 'qorpera.action-review-begin/v1', 'state', 'declined', 'reviewId', v_review.id,
			'answeredBy', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));
	elsif found and v_review.answer is not null and v_review.consumed_at is null then
		update public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = v_run.id
		where id = v_review.id;
		return jsonb_build_object('schema', 'qorpera.action-review-begin/v1', 'state', 'approved', 'reviewId', v_review.id,
			'answeredBy', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));
	elsif found and v_review.answer is null then
		return jsonb_build_object('schema', 'qorpera.action-review-begin/v1', 'state', 'pending', 'reviewId', v_review.id,
			'approverScope', v_review.approver_scope,
			'approverName', public.qorpera_review_member_name(v_run.profile_id, v_review.approver_user_id));
	elsif found and v_review.woken_at is not null and v_review.consumed_run_id is distinct from v_run.id
		and v_review.consumed_at < v_review.woken_at + interval '30 seconds'
		and clock_timestamp() < v_review.woken_at + interval '1 hour' then
		-- The answer woke the agent, but the call that was still holding ran it: the
		-- repeat the wake asks for has nothing left to do.
		return jsonb_build_object('schema', 'qorpera.action-review-begin/v1', 'state', 'used', 'reviewId', v_review.id,
			'answeredBy', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));
	end if;
	select staff.* into v_agent from public.qorpera_profile_staff as staff
	where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id;
	return jsonb_build_object('schema', 'qorpera.action-review-begin/v1', 'state', 'review',
		'agent', jsonb_build_object('id', v_run.staff_agent_id, 'name', coalesce(v_agent.display_name, 'Agent'),
			'role', coalesce(v_agent.role, '')),
		'company', jsonb_build_object('id', v_run.profile_id,
			'name', (select profile.name from public.qorpera_profiles as profile where profile.id = v_run.profile_id)),
		'requester', case when v_run.requested_by_user_id is null then null else jsonb_build_object(
			'userId', v_run.requested_by_user_id,
			'name', public.qorpera_review_member_name(v_run.profile_id, v_run.requested_by_user_id)) end,
		'rules', coalesce((select jsonb_agg(jsonb_build_object('id', rule.id, 'scope', rule.scope, 'when', rule.when_text,
				'outcome', rule.outcome))
			from public.qorpera_review_rules_for(v_run.profile_id, v_run.requested_by_user_id) as rule), '[]'::jsonb));
end
$$;

-- Runtime: record the reviewer's verdict on one call. For an ask, the kernel
-- decides who answers and raises the approval card in the run's conversation
-- where cards live. A replay of the same call returns the first record.
create function public.qorpera_record_action_review(p_binding jsonb, p_review jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_existing public.qorpera_action_reviews%rowtype;
	v_review public.qorpera_action_reviews%rowtype; v_rules public.qorpera_review_rules[];
	v_rule_ids uuid[]; v_decision text; v_built_in text; v_scope text; v_approver uuid; v_card boolean;
	v_parent text; v_body jsonb; v_session_token text; v_lease_token text; v_always boolean; v_id uuid;
	v_retry boolean;
	v_keys text[] := array['callId','tool','effect','argumentSha256','action','decision','ruleIds','builtIn',
		'reason','proposedRule','reviewerModel'];
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_run.staff_agent_id is null then
		raise exception 'Only a company agent''s actions are reviewed' using errcode = '42501'; end if;
	if jsonb_typeof(p_review) is distinct from 'object' or not (p_review ?& v_keys) or p_review - v_keys <> '{}'::jsonb
		or jsonb_typeof(p_review -> 'callId') is distinct from 'string'
		or jsonb_typeof(p_review -> 'tool') is distinct from 'string'
		or jsonb_typeof(p_review -> 'effect') is distinct from 'string'
		or jsonb_typeof(p_review -> 'argumentSha256') is distinct from 'string'
		or jsonb_typeof(p_review -> 'action') is distinct from 'object'
		or jsonb_typeof(p_review -> 'decision') is distinct from 'string'
		or jsonb_typeof(p_review -> 'ruleIds') is distinct from 'array'
		or jsonb_array_length(p_review -> 'ruleIds') > 1000
		or exists (select 1 from jsonb_array_elements(p_review -> 'ruleIds') as item(value)
			where jsonb_typeof(item.value) <> 'string'
				or item.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
		or jsonb_typeof(p_review -> 'builtIn') is distinct from 'string'
		or jsonb_typeof(p_review -> 'reason') is distinct from 'string'
		or jsonb_typeof(p_review -> 'proposedRule') not in ('string', 'null')
		or jsonb_typeof(p_review -> 'reviewerModel') is distinct from 'string' then
		raise exception 'Action review record is invalid' using errcode = '22023'; end if;
	select review.* into v_existing from public.qorpera_action_reviews as review
	where review.run_id = v_run.id and review.call_id = p_review ->> 'callId';
	if found then
		if v_existing.tool_name <> p_review ->> 'tool' or v_existing.argument_sha256 <> p_review ->> 'argumentSha256' then
			raise exception 'This call was already reviewed with other content' using errcode = '23505'; end if;
		return public.qorpera_action_review_receipt(v_existing);
	end if;
	-- Only rules that apply to this run count; an id the reviewer invented is dropped.
	select coalesce(array_agg(rule order by rule.id), '{}') into v_rules
	from public.qorpera_review_rules_for(v_run.profile_id, v_run.requested_by_user_id) as rule
	where rule.id in (select (item.value #>> '{}')::uuid from jsonb_array_elements(p_review -> 'ruleIds') as item(value));
	select coalesce(array_agg((rule).id), '{}') into v_rule_ids from unnest(v_rules) as rule;
	v_built_in := p_review ->> 'builtIn';
	if v_built_in not in ('none', 'money', 'legal_terms', 'delete_outside', 'access_change', 'not_requested', 'unavailable')
		or p_review ->> 'decision' not in ('allow', 'ask', 'deny')
		or p_review ->> 'effect' not in ('external', 'destructive', 'delegation') then
		raise exception 'Action review record is invalid' using errcode = '22023'; end if;
	v_decision := p_review ->> 'decision';
	-- An action the reviewer says was not asked for never runs on an allow.
	if v_decision = 'allow' and v_built_in = 'not_requested' then v_decision := 'deny'; end if;
	-- Ask first always wins over an allow; a built-in check asks unless a company allow rule
	-- covers it (a member's own Allow rule never lifts a check the owners and admins answer).
	if v_decision = 'allow' and (
		exists (select 1 from unnest(v_rules) as rule where (rule).outcome = 'ask_first')
		or (v_built_in not in ('none', 'not_requested') and not exists (
			select 1 from unnest(v_rules) as rule
			where (rule).outcome = 'allow_automatically' and (rule).scope = 'company'))) then
		v_decision := 'ask';
	end if;
	-- The same call denied earlier in this conversation, tried again after a member wrote
	-- there (qorpera_begin_action_review reviews it afresh only then), runs only on a click,
	-- as in Grok: a "yes" in chat is not enough by itself, and a second denial is not final
	-- either. Its card waits for that member, unless a company rule or a money, terms,
	-- deletion or access check makes it the owners' and admins' to answer.
	v_retry := v_run.requested_by_user_id is not null and exists (
		select 1 from public.qorpera_action_reviews as prior
		where prior.profile_id = v_run.profile_id and prior.staff_agent_id = v_run.staff_agent_id
			and prior.tool_name = p_review ->> 'tool' and prior.argument_sha256 = p_review ->> 'argumentSha256'
			and prior.requester_user_id = v_run.requested_by_user_id and prior.session_id = v_run.session_id
			and (prior.decision = 'deny' or prior.answer = 'deny'));
	if v_retry then v_decision := 'ask'; end if;
	if v_decision = 'ask' then
		-- A company rule or a built-in check is the company's to answer; a personal rule
		-- (or a reviewer's own doubt, or a retry after a denial) is the member's the agent
		-- works for.
		if (v_built_in not in ('none', 'unavailable') and not (v_retry and v_built_in = 'not_requested'))
			or exists (select 1 from unnest(v_rules) as rule where (rule).scope = 'company' and (rule).outcome = 'ask_first')
			or v_run.requested_by_user_id is null then
			v_scope := 'owners_admins';
		else
			v_scope := 'member'; v_approver := v_run.requested_by_user_id;
		end if;
	end if;
	-- Always allow saves a company rule, so it is offered only for a built-in check
	-- no Ask first rule matched (an allow never undoes an Ask first rule).
	v_always := v_decision = 'ask' and v_built_in in ('money', 'legal_terms', 'delete_outside', 'access_change')
		and not exists (select 1 from unnest(v_rules) as rule where (rule).outcome = 'ask_first')
		and nullif(btrim(coalesce(p_review ->> 'proposedRule', '')), '') is not null;
	-- Cards live in the agent's own thread or a plain conversation, never a group chat or a worker,
	-- and only where the member it waits for can read it: a card for the owners and admins is never
	-- raised in one member's private conversation (they could not see it there).
	v_card := v_decision = 'ask' and v_run.session_id is not null
		and (public.qorpera_run_worker(v_run.id)).id is null
		and not exists (select 1 from public.qorpera_company_rooms as room
			where room.session_id = v_run.session_id and room.bound_staff_agent_id is distinct from v_run.staff_agent_id)
		and not (v_scope = 'owners_admins' and exists (select 1 from public.qorpera_shared_sessions as session
			where session.id = v_run.session_id and session.audience_kind = 'member_private'
				and session.audience_user_id is distinct from null));
	v_id := pg_catalog.gen_random_uuid();
	insert into public.qorpera_action_reviews (id, profile_id, run_id, call_id, staff_agent_id, session_id,
		requester_user_id, tool_name, effect, argument_sha256, action, decision, rule_ids, built_in, reason,
		proposed_rule, reviewer_model, approver_scope, approver_user_id, card_session_id, held_until)
	values (v_id, v_run.profile_id, v_run.id, p_review ->> 'callId', v_run.staff_agent_id, v_run.session_id,
		v_run.requested_by_user_id, p_review ->> 'tool', p_review ->> 'effect', p_review ->> 'argumentSha256',
		p_review -> 'action', v_decision, v_rule_ids, v_built_in, left(btrim(p_review ->> 'reason'), 500),
		case when v_always then left(btrim(p_review ->> 'proposedRule'), 280) end, p_review ->> 'reviewerModel',
		v_scope, v_approver, case when v_card then v_run.session_id end,
		case when v_card then clock_timestamp() + interval '10 seconds' end)
	returning * into v_review;
	if v_card then
		select event.body #>> '{entry,id}' into v_parent from public.qorpera_session_events as event
		where event.session_id = v_run.session_id order by event.sequence desc limit 1;
		v_body := jsonb_build_object('schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object('type', 'custom', 'customType', 'authorization_request', 'id', v_review.id,
				'parentId', v_parent,
				'timestamp', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'data', public.qorpera_action_review_card(v_review),
				'execution', jsonb_build_object('kind', 'run', 'id', v_run.id, 'claimantId', v_run.id,
					'runnerAssignmentId', p_binding ->> 'assignmentId')));
		select runner.session_token_sha256 into strict v_session_token from public.qorpera_runners as runner
		where runner.id = (p_binding ->> 'runnerId')::uuid;
		select job.lease_token_sha256 into strict v_lease_token from public.qorpera_runner_jobs as job
		where job.id = (p_binding ->> 'jobId')::uuid;
		perform public.qorpera_append_runner_transcript_event((p_binding ->> 'runnerId')::uuid, v_session_token,
			(p_binding ->> 'jobId')::uuid, v_lease_token, (p_binding ->> 'assignmentId')::uuid, v_review.id,
			'authorization_request', v_body);
	end if;
	return public.qorpera_action_review_receipt(v_review);
end
$$;

-- The approval card's facts, from the record (the runtime cannot write a card of its own).
create function public.qorpera_action_review_card(p_review public.qorpera_action_reviews)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_strip_nulls(jsonb_build_object(
		'schema', 'qorpera.action-review/v1',
		'reviewId', p_review.id,
		'title', left(coalesce(nullif(p_review.action ->> 'title', ''), replace(p_review.tool_name, '_', ' ')), 200),
		'summary', p_review.reason,
		'operation', p_review.tool_name,
		'effect', p_review.effect,
		'target', left(p_review.action ->> 'target', 500),
		'details', case when jsonb_typeof(p_review.action -> 'details') = 'object' then p_review.action -> 'details' end,
		-- The exact call, so the agent woken by a parked approval can repeat it identically.
		'tool', p_review.tool_name,
		'arguments', case when jsonb_typeof(p_review.action -> 'arguments') = 'string'
			then p_review.action ->> 'arguments' end,
		'builtIn', p_review.built_in,
		'rules', (select jsonb_agg(jsonb_build_object('id', rule.id, 'scope', rule.scope, 'when', rule.when_text,
				'outcome', rule.outcome) order by rule.scope = 'company' desc, rule.created_at)
			from public.qorpera_review_rules as rule where rule.id = any(p_review.rule_ids)),
		'approverScope', p_review.approver_scope,
		'approverUserId', p_review.approver_user_id,
		'approverName', public.qorpera_review_member_name(p_review.profile_id, p_review.approver_user_id),
		'requesterUserId', p_review.requester_user_id,
		'alwaysAllow', p_review.proposed_rule is not null,
		'proposedRule', p_review.proposed_rule))
$$;

create function public.qorpera_action_review_receipt(p_review public.qorpera_action_reviews)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.action-review-record/v1', 'reviewId', p_review.id,
		'decision', p_review.decision, 'builtIn', p_review.built_in, 'ruleIds', to_jsonb(p_review.rule_ids),
		'reason', p_review.reason, 'card', p_review.card_session_id is not null,
		'approverScope', p_review.approver_scope,
		'approverName', case when p_review.approver_scope = 'member'
			then public.qorpera_review_member_name(p_review.profile_id, p_review.approver_user_id) end)
$$;

-- Runtime: a held call reads its card's answer. An approval is used by this call
-- (so it runs once). With p_park, a call that stops holding leaves the card to
-- wake the agent when it is answered; a call that holds (again) takes it back.
-- With p_leaving (a hold that ends early: the run stopped), an unanswered card is
-- parked and an answered one is left as it is: nothing is used by a call that
-- will not run.
create function public.qorpera_await_action_review(p_binding jsonb, p_review_id uuid, p_park boolean,
	p_leaving boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_review public.qorpera_action_reviews%rowtype; v_state text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_park is null or p_leaving is null or (p_leaving and not p_park) then
		raise exception 'Action review wait is invalid' using errcode = '22023'; end if;
	select review.* into v_review from public.qorpera_action_reviews as review
	where review.id = p_review_id and review.profile_id = v_run.profile_id
		and review.staff_agent_id is not distinct from v_run.staff_agent_id and review.decision = 'ask'
	for update;
	if not found then raise exception 'Action review is unavailable' using errcode = '22023'; end if;
	if v_review.answer = 'deny' then
		v_state := 'declined';
	elsif p_leaving and v_review.answer is not null then
		v_state := 'answered';
	elsif v_review.answer is not null and v_review.consumed_at is null then
		update public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = v_run.id
		where id = v_review.id;
		v_state := 'approved';
	elsif v_review.answer is not null then
		v_state := case when v_review.consumed_run_id = v_run.id then 'approved' else 'used' end;
	elsif p_park then
		update public.qorpera_action_reviews set parked_at = coalesce(parked_at, clock_timestamp()), held_until = null
		where id = v_review.id;
		v_state := 'parked';
	else
		-- Still holding: renew the heartbeat, a few polls long.
		update public.qorpera_action_reviews set parked_at = null, held_until = clock_timestamp() + interval '10 seconds'
		where id = v_review.id;
		v_state := 'pending';
	end if;
	return jsonb_build_object('schema', 'qorpera.action-review-wait/v1', 'reviewId', v_review.id, 'state', v_state,
		'answeredBy', public.qorpera_review_member_name(v_review.profile_id, v_review.answered_by_user_id),
		'approverName', public.qorpera_review_member_name(v_review.profile_id, v_review.approver_user_id));
end
$$;

-- A member answers an approval card: Allow once, Always allow (a built-in check's
-- card only; saves the proposed rule, as edited, as a company rule) or Deny. The
-- answerer needs write access to the card's conversation. The answer joins the
-- conversation as the card's decision. If no call is holding the card any more
-- (it parked, was stopped, or its run ended), the answer also wakes the agent
-- there, on the answering member's own model account, checked as a post or a
-- message there is: an answer that could not wake the agent is refused and
-- records nothing. An answer whose delivery failed may be given again.
create function public.qorpera_answer_action_review(p_review_id uuid, p_client_input_id uuid, p_answer text,
	p_rule_text text default null, p_sponsor_binding_id uuid default null, p_sponsor_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid(); v_review public.qorpera_action_reviews%rowtype;
	v_session public.qorpera_shared_sessions%rowtype; v_room public.qorpera_company_rooms%rowtype;
	v_input public.qorpera_session_inputs%rowtype; v_body jsonb; v_rule_id uuid; v_wake boolean;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_pending_inputs integer; v_pending_body_bytes bigint;
begin
	if v_user is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_review_id is null or p_client_input_id is null or p_answer not in ('allow_once', 'always_allow', 'deny') then
		raise exception 'Approval answer is invalid' using errcode = '22023'; end if;
	select review.* into v_review from public.qorpera_action_reviews as review where review.id = p_review_id;
	if not found or v_review.decision <> 'ask' or v_review.card_session_id is null
		or public.qorpera_member_role(v_review.profile_id) is null then
		raise exception 'Approval is unavailable' using errcode = '42501'; end if;
	-- As any write into the conversation: write access, and not while the company's objects are cleaned up.
	perform public.qorpera_session_profile_for_write(v_review.card_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_review.profile_id);
	if public.qorpera_profile_gc_deletion_active(v_review.profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message',
			'profile object cleanup is in progress', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}';
	end if;
	-- Lock order: the conversation, then the review.
	select session.* into v_session from public.qorpera_shared_sessions as session
	where session.id = v_review.card_session_id for update;
	select review.* into strict v_review from public.qorpera_action_reviews as review where review.id = p_review_id for update;
	if (v_review.approver_scope = 'member' and v_review.approver_user_id is distinct from v_user)
		or (v_review.approver_scope = 'owners_admins' and not public.qorpera_can_authorize_profile(v_review.profile_id)) then
		raise exception 'Only the member this approval waits for can answer it' using errcode = '42501'; end if;
	-- A retry of the same answer returns its receipt.
	select input.* into v_input from public.qorpera_session_inputs as input
	where input.session_id = v_session.id and input.client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user or v_input.body ->> 'interactionId' <> p_review_id::text
			or v_review.answer is distinct from p_answer then
			raise exception 'client input id is already bound to different content' using errcode = '23505'; end if;
		if v_input.failed_at is not null then
			raise exception 'That answer did not reach the agent; answer the card again' using errcode = '55000'; end if;
		return jsonb_build_object('reviewId', p_review_id, 'answer', v_review.answer, 'inputId', v_input.id,
			'savedRuleId', v_review.saved_rule_id, 'woke', v_review.woken_at is not null);
	end if;
	-- An earlier answer whose delivery failed (its turn request refused at admission)
	-- never reached the agent: the card may be answered again.
	if v_review.answer is not null and v_review.consumed_at is null and exists (
		select 1 from public.qorpera_session_inputs as input
		where input.session_id = v_session.id and input.kind = 'user_message'
			and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
			and input.body ->> 'interactionId' = p_review_id::text and input.failed_at is not null
	) and not exists (
		select 1 from public.qorpera_session_inputs as input
		where input.session_id = v_session.id and input.kind = 'user_message'
			and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
			and input.body ->> 'interactionId' = p_review_id::text and input.failed_at is null
	) then
		-- A rule the failed Always allow saved goes with it; the new answer decides again.
		update public.qorpera_review_rules set archived_at = coalesce(archived_at, clock_timestamp()),
			updated_at = clock_timestamp()
		where id = v_review.saved_rule_id;
		update public.qorpera_action_reviews set answer = null, answered_by_user_id = null, answered_at = null,
			saved_rule_id = null, woken_at = null
		where id = p_review_id returning * into v_review;
	end if;
	if v_review.answer is not null then
		raise exception 'This approval is already answered' using errcode = '55000'; end if;
	if v_session.status <> 'open' then raise exception 'conversation is closed' using errcode = '55000'; end if;
	if p_answer = 'always_allow' then
		if v_review.proposed_rule is null then
			raise exception 'Always allow is not offered for this approval' using errcode = '22023'; end if;
		v_rule_id := pg_catalog.gen_random_uuid();
		insert into public.qorpera_review_rules (id, profile_id, scope, member_user_id, when_text, outcome,
			created_via, created_by_user_id)
		values (v_rule_id, v_review.profile_id, 'company', null,
			public.qorpera_review_rule_text(coalesce(p_rule_text, v_review.proposed_rule)), 'allow_automatically',
			'card', v_user);
		perform public.qorpera_review_rules_assert_room(v_review.profile_id, 'company', null);
	elsif p_rule_text is not null then
		raise exception 'Only Always allow saves a rule' using errcode = '22023';
	end if;
	-- Wake the agent unless a call is still holding the card (its heartbeat lies ahead).
	v_wake := v_review.held_until is null or v_review.held_until < clock_timestamp();
	select room.* into v_room from public.qorpera_company_rooms as room
	where room.session_id = v_session.id and room.bound_staff_agent_id is not null;
	v_body := jsonb_build_object('schema', 'qorpera.interaction-answer/v1', 'interactionId', p_review_id,
		'surface', 'approval', 'outcome', case when p_answer = 'deny' then 'declined' else 'approved' end,
		'answer', jsonb_build_object('answer', p_answer));
	if v_wake then
		if public.qorpera_company_execution_paused(v_review.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000'; end if;
		select count(*), coalesce(sum(pg_column_size(input.body)), 0) into v_pending_inputs, v_pending_body_bytes
		from public.qorpera_session_inputs as input
		where input.session_id = v_session.id and input.completed_at is null and input.failed_at is null;
		if v_pending_inputs >= 512 or v_pending_body_bytes + pg_column_size(v_body) > 16777216 then
			raise exception 'session queue capacity is reached' using errcode = '54000'; end if;
		if v_room.id is not null then
			-- The agent's own thread: woken like a post there, by an active member of the
			-- thread, on the member's own account.
			if not exists (
				select 1 from public.qorpera_company_room_members as member
				where member.room_id = v_room.id and member.principal_kind = 'member'
					and member.principal_id = v_user and member.status = 'active'
			) then
				raise exception 'Only a member of this thread can wake its agent' using errcode = '42501'; end if;
			if p_sponsor_binding_id is null or p_sponsor_version is null or v_room.status <> 'active' or not exists (
				select 1 from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor
					on sponsor.binding_id = binding.id and sponsor.version = p_sponsor_version
				join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
				join public.qorpera_provider_connection_versions as connection_version
					on connection_version.connection_id = sponsor.provider_connection_id
						and connection_version.version = sponsor.provider_connection_version
				left join public.qorpera_native_credential_capsules as capsule
					on capsule.id = connection_version.credential_capsule_id and capsule.status = 'active'
				where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id
					and binding.status = 'active' and binding.created_by_user_id = v_user
					and connection.profile_id = v_room.profile_id and connection.status = 'active'
					and (connection_version.authentication_mode is distinct from 'native_subscription'
						or capsule.compute_identity_id is not null)
			) then
				raise exception 'Room sponsor is unavailable' using errcode = '42501'; end if;
			insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body, completed_at)
			values (v_session.id, p_client_input_id, 'user_message', v_user, v_body, clock_timestamp())
			returning * into v_input;
			insert into public.qorpera_wake_occurrences (id, profile_id, environment_id, wake_kind, source_kind, source_id,
				staff_agent_id, requested_by_user_id, sponsor_binding_id, sponsor_version, session_id, trigger_id,
				occurrence_key, scheduled_for, not_before, payload)
			values (extensions.gen_random_uuid(), v_room.profile_id, v_room.environment_id, 'room', 'room', v_input.id,
				v_room.bound_staff_agent_id, v_user, p_sponsor_binding_id, p_sponsor_version, v_session.id, 'room',
				'room:' || v_room.id::text || ':' || v_input.id::text || ':' || v_room.bound_staff_agent_id::text,
				clock_timestamp(), clock_timestamp(),
				jsonb_build_object('roomId', v_room.id, 'inputIds', jsonb_build_array(v_input.id),
					'recipientStaffId', v_room.bound_staff_agent_id));
			perform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);
		else
			-- A plain conversation: a turn request on the member's own account, checked as
			-- qorpera_request_session_turn checks a member_connection request.
			select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
			where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
			select connection.* into v_connection from public.qorpera_provider_connections as connection
			where connection.id = v_sponsor.provider_connection_id
				and connection.profile_id = v_session.profile_id and connection.status = 'active';
			select version.* into v_connection_version from public.qorpera_provider_connection_versions as version
			where version.connection_id = v_sponsor.provider_connection_id
				and version.version = v_sponsor.provider_connection_version and version.authorization_state = 'active';
			select capsule.* into v_capsule from public.qorpera_native_credential_capsules as capsule
			where capsule.id = v_connection_version.credential_capsule_id and capsule.status = 'active';
			select identity.* into v_identity from public.qorpera_member_compute_identities as identity
			where identity.id = v_capsule.compute_identity_id
				and identity.profile_id = v_session.profile_id and identity.status = 'active';
			if v_sponsor.binding_id is null or v_connection.id is null or v_connection_version.connection_id is null
				or not exists (
					select 1 from public.qorpera_execution_sponsor_bindings as binding
					where binding.id = p_sponsor_binding_id and binding.profile_id = v_session.profile_id
						and binding.status = 'active'
				)
				or v_sponsor.sponsor_kind <> 'member_connection'
				or v_connection.owner_user_id is distinct from v_user
				or v_connection_version.authentication_mode is distinct from 'native_subscription'
				or v_identity.id is null
				or v_identity.ownership_kind is distinct from 'member'
				or v_identity.owner_user_id is distinct from v_user
				or v_capsule.ownership_kind is distinct from v_identity.ownership_kind
				or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
				or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key then
				raise exception 'Session sponsor is unavailable' using errcode = '42501'; end if;
			insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
			values (v_session.id, p_client_input_id, 'user_message', v_user, v_body)
			returning * into v_input;
			insert into public.qorpera_session_turn_requests (
				profile_id, session_id, client_request_id, input_id, requested_by_user_id,
				sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id,
				requested_sponsor_user_id, compute_identity_id, logical_computer_id, worker_class,
				required_capability, job_type, publication_mode, review_policy_key,
				reviewer_staff_ids, status, sponsored_at, initial_execution_selection
			) values (
				v_session.profile_id, v_session.id, p_client_input_id, v_input.id, v_user,
				'member_connection', p_sponsor_binding_id, p_sponsor_version, v_user,
				null, v_identity.id, null, 'managed_sandbox',
				'agent_turn', 'agent_turn', 'automatic', null,
				'{}'::uuid[], 'queued', statement_timestamp(),
				jsonb_build_object('sponsor_binding_id', p_sponsor_binding_id, 'sponsor_version', p_sponsor_version,
					'compute_identity_id', v_identity.id, 'logical_computer_id', null, 'worker_class', 'managed_sandbox')
			);
		end if;
	else
		-- The agent is still holding the call: the answer joins the conversation now and
		-- the held call reads it. Nothing wakes the agent a second time.
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body, completed_at)
		values (v_session.id, p_client_input_id, 'user_message', v_user, v_body, clock_timestamp())
		returning * into v_input;
		perform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);
	end if;
	update public.qorpera_action_reviews set answer = p_answer, answered_by_user_id = v_user,
		answered_at = clock_timestamp(), saved_rule_id = v_rule_id,
		woken_at = case when v_wake then clock_timestamp() end
	where id = p_review_id returning * into v_review;
	update public.qorpera_shared_sessions set updated_at = statement_timestamp() where id = v_session.id;
	return jsonb_build_object('reviewId', p_review_id, 'answer', p_answer, 'inputId', v_input.id,
		'savedRuleId', v_rule_id, 'woke', v_wake);
end
$$;

-- Runtime: the agent tool add_review_rule (founder decision D4, 2026-09-24). An
-- agent adds an Ask first rule for the member its run works for: agents may only
-- make themselves more careful, and an Allow rule stays the member's own choice
-- (Settings, Rules). The rule is that member's own, listed and removable there,
-- and attributed to the agent. The same operation key in the same run is the same
-- rule; the same sentence already among the member's Ask first rules is that
-- rule. A full rule list comes back as a refusal with nothing added.
create function public.qorpera_add_agent_review_rule(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_text text; v_id uuid;
	v_rule public.qorpera_review_rules%rowtype; v_added boolean := false;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent can add a rule' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or p_request - array['operationKey','when'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'when') is distinct from 'string'
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9_:.-]{1,128}$' then
		raise exception 'Rule request is invalid' using errcode = '22023'; end if;
	v_text := public.qorpera_review_rule_text(p_request ->> 'when');
	if not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id) then
		raise exception 'The member this run works for is not in the company' using errcode = '42501'; end if;
	v_id := md5('qorpera.agent-review-rule:' || v_run.id::text || ':' || (p_request ->> 'operationKey'))::uuid;
	perform 1 from public.qorpera_profiles where id = v_run.profile_id for update;
	select rule.* into v_rule from public.qorpera_review_rules as rule where rule.id = v_id;
	if found then
		if v_rule.when_text <> v_text then
			raise exception 'This operation key already added another rule' using errcode = '23505'; end if;
	else
		select rule.* into v_rule from public.qorpera_review_rules as rule
		where rule.profile_id = v_run.profile_id and rule.scope = 'member'
			and rule.member_user_id = v_run.requested_by_user_id and rule.archived_at is null
			and rule.outcome = 'ask_first' and lower(rule.when_text) = lower(v_text)
		order by rule.created_at limit 1;
		if not found then
			begin
				insert into public.qorpera_review_rules (id, profile_id, scope, member_user_id, when_text, outcome,
					created_via, created_by_user_id, created_by_staff_agent_id)
				values (v_id, v_run.profile_id, 'member', v_run.requested_by_user_id, v_text, 'ask_first',
					'agent', null, v_run.staff_agent_id)
				returning * into v_rule;
				perform public.qorpera_review_rules_assert_room(v_run.profile_id, 'member', v_run.requested_by_user_id);
				v_added := true;
			exception when sqlstate '54000' then
				return jsonb_build_object('schema', 'qorpera.agent-review-rule/v1', 'runId', v_run.id, 'added', false,
					'rule', null,
					'refused', 'The member has too many rules to add another; they can remove some in Settings, Rules.');
			end;
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.agent-review-rule/v1', 'runId', v_run.id, 'added', v_added,
		'rule', public.qorpera_review_rule_view(v_rule));
end
$$;

revoke all on function public.qorpera_review_rule_view(public.qorpera_review_rules),
	public.qorpera_review_rules_for(uuid, uuid),
	public.qorpera_review_rule_text(text),
	public.qorpera_review_rules_assert_room(uuid, text, uuid),
	public.qorpera_list_review_rules(uuid),
	public.qorpera_save_review_rule(uuid, uuid, text, text, text),
	public.qorpera_archive_review_rule(uuid, uuid),
	public.qorpera_review_member_name(uuid, uuid),
	public.qorpera_begin_action_review(jsonb, jsonb),
	public.qorpera_record_action_review(jsonb, jsonb),
	public.qorpera_action_review_card(public.qorpera_action_reviews),
	public.qorpera_action_review_receipt(public.qorpera_action_reviews),
	public.qorpera_await_action_review(jsonb, uuid, boolean, boolean),
	public.qorpera_answer_action_review(uuid, uuid, text, text, uuid, bigint),
	public.qorpera_add_agent_review_rule(jsonb, jsonb)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_list_review_rules(uuid),
	public.qorpera_save_review_rule(uuid, uuid, text, text, text),
	public.qorpera_archive_review_rule(uuid, uuid),
	public.qorpera_answer_action_review(uuid, uuid, text, text, uuid, bigint)
	to authenticated;
grant execute on function public.qorpera_begin_action_review(jsonb, jsonb),
	public.qorpera_record_action_review(jsonb, jsonb),
	public.qorpera_await_action_review(jsonb, uuid, boolean, boolean),
	public.qorpera_add_agent_review_rule(jsonb, jsonb)
	to service_role;


-- These approval cards are answered only by qorpera_answer_action_review, which
-- knows who they wait for and whether a call still holds them. The general card
-- answer (qorpera_answer_interaction as of 20260924232000) accepted any
-- authorization_request from an owner or admin; answering one of these there
-- would record a decision the held call never reads and take the card's one
-- answer slot, so it refuses them. Earlier web clients show their Approve and
-- Decline on these cards; those now report the refusal and change nothing.
create function pg_temp.auto_review_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Auto-review integration differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;
do $migration$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)'::regprocedure);
begin
	v_definition := pg_temp.auto_review_replace(v_definition,
		$old$	if not found then
		raise exception 'interaction request is unavailable' using errcode = '22023';
	end if;
$old$,
		$new$	if not found then
		raise exception 'interaction request is unavailable' using errcode = '22023';
	end if;
	if v_request.body #>> '{entry,data,schema}' = 'qorpera.action-review/v1'
		or exists (select 1 from public.qorpera_action_reviews as review where review.id = p_interaction_id) then
		raise exception 'this approval is answered with qorpera_answer_action_review' using errcode = '22023';
	end if;
$new$);
	execute v_definition;
end
$migration$;

-- Runtime observation vocabulary: the agent tool add_review_rule is observed under
-- its own name, the reviewer's model turn as action_review, and a call that did
-- not run because of a review carries its
-- reason (approval_pending, approval_declined, review_denied,
-- review_unavailable). Patched into the live definition, not re-stated, so
-- names another migration added before this one (v114's decide_routine) stay.
-- CREATE OR REPLACE keeps the ACL. Record this migration BEFORE activating the
-- bundle that observes them, or their observations are rejected (22023) and
-- dropped.
do $migration$
declare
	v_definition text := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.auto_review_replace(v_definition,
		$old$'update_memory','recall_memory','organize_sidebar',$old$,
		$new$'update_memory','recall_memory','organize_sidebar','add_review_rule',$new$);
	v_definition := pg_temp.auto_review_replace(v_definition,
		$old$'native_result_fence','diagnostic_export')$old$,
		$new$'native_result_fence','diagnostic_export','action_review')$new$);
	v_definition := pg_temp.auto_review_replace(v_definition,
		$old$'transport_unavailable','invalid_response','unknown','export_unavailable')$old$,
		$new$'transport_unavailable','invalid_response','unknown','export_unavailable',
			'approval_pending','approval_declined','review_denied','review_unavailable')$new$);
	execute v_definition;
end
$migration$;

commit;
