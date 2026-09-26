-- Auto-review fixes from the first live days of v130 (2026-09-26 acceptance in
-- A1 and the coordinator's coding check in the Qorpera company).
--
-- 1. The approval card carries the call as a JSON object (`call`) next to the
--    exact text (`arguments`, which the web shows). A woken agent repeats a
--    parked call by copying `call`: the text form is JSON inside the card's own
--    JSON, and an agent that copied it kept one escaping level too many around
--    quotation marks (review 3b014c43 → 29d7a476), so the approval never matched
--    and the repeat was reviewed afresh. The boundary's digest covers canonical
--    arguments (sorted keys), so the same values in any order match.
-- 2. Delegating to the company's own agents (hiring, group chats, routines,
--    workers, coding jobs) moves no money, accepts no terms, deletes nothing
--    outside and changes nobody's access: the kernel ignores those built-in
--    checks on a delegation call. The reviewer had tagged starting a group chat
--    and starting a coding job as access changes, which sent every such card to
--    the owners and admins and made every coding job wait for an owner. An ask
--    based on such a check alone becomes an allow. Rules, "not asked for" and the
--    reviewer's own doubt still apply.
begin;

-- The call as an object, from the exact canonical text; null for anything else.
create function public.qorpera_action_review_call(p_arguments text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_call jsonb;
begin
	if p_arguments is null then return null; end if;
	v_call := p_arguments::jsonb;
	return case when jsonb_typeof(v_call) = 'object' then v_call end;
exception when others then
	return null;
end
$$;
revoke all on function public.qorpera_action_review_call(text) from public, anon, authenticated, service_role;

create or replace function public.qorpera_action_review_card(p_review public.qorpera_action_reviews)
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
		-- The exact call, so the agent woken by a parked approval can repeat it identically:
		-- the text as the member reads it; the same call as an object is added below.
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
	-- Added after the strip: a null inside the call (an absent path's expectedVersion) is part of it.
	|| coalesce((select jsonb_build_object('call', call.value)
		from (select public.qorpera_action_review_call(p_review.action ->> 'arguments') as value) as call
		where jsonb_typeof(p_review.action -> 'arguments') = 'string' and call.value is not null), '{}'::jsonb)
$$;

create function pg_temp.auto_review_fix_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Auto-review fix anchor differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;
do $migration$
declare
	v_definition text := pg_get_functiondef('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.auto_review_fix_replace(v_definition,
		$old$	v_decision := p_review ->> 'decision';
$old$,
		$new$	v_decision := p_review ->> 'decision';
	-- Delegating to the company's own agents moves no money, accepts no terms, deletes
	-- nothing outside and changes nobody's access: those built-in checks never apply to it.
	-- An ask the reviewer based on such a check alone lets the call run; an Ask first
	-- rule still asks, and the reviewer's own doubt (built-in "none") is untouched.
	if p_review ->> 'effect' = 'delegation'
		and v_built_in in ('money', 'legal_terms', 'delete_outside', 'access_change') then
		v_built_in := 'none';
		if v_decision = 'ask' and not exists (select 1 from unnest(v_rules) as rule where (rule).outcome = 'ask_first') then
			v_decision := 'allow';
		end if;
	end if;
$new$);
	execute v_definition;
end
$migration$;

commit;
