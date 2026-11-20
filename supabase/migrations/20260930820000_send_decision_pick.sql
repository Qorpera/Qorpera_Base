create function public.qorpera_is_decision_pick(
	p_profile_id uuid,
	p_item_id uuid,
	p_answerer_user_id uuid,
	p_card jsonb,
	p_outcome text,
	p_answer jsonb
)
returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce(p_card #>> '{entry,data,surface}' = 'question' and p_outcome = 'answered' and exists (
		select 1
		from public.qorpera_decision_votes as vote
		join public.qorpera_profile_members as voter
			on voter.profile_id = vote.profile_id and voter.user_id = vote.user_id and voter.role <> 'viewer'
		where vote.profile_id = p_profile_id and vote.item_id = p_item_id and vote.user_id = p_answerer_user_id
			and vote.choice is not null
			and p_answer = jsonb_build_object('values', jsonb_build_array(vote.choice))), false)
$$;
revoke all on function public.qorpera_is_decision_pick(uuid, uuid, uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_is_decision_pick(uuid, uuid, uuid, jsonb, text, jsonb) is
	'Internal (20260930820000): whether an answer is exactly the pick of the member a question card was raised for: '
	'the card is a question, the outcome is answered, and the answer is the one option that member, not a spectator '
	'now, has voted for in qorpera_decision_votes. Only qorpera_answer_interaction asks, to let another member of the '
	'thread send that pick.';

create function pg_temp.send_pick_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Send-the-pick patch anchor not found once in %', p_target;
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.send_pick_replace('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)',
	E'\tif v_room.id is not null and (\n'
	|| E'\t\tv_request.actor_user_id is distinct from v_user_id\n'
	|| E'\t\tor v_room.status <> ''active''\n',
	E'\tif v_room.id is not null and (\n'
	|| E'\t\t(v_request.actor_user_id is distinct from v_user_id\n'
	|| E'\t\t\tand not public.qorpera_is_decision_pick(v_profile_id, p_interaction_id, v_request.actor_user_id,\n'
	|| E'\t\t\t\tv_request.body, p_outcome, p_answer))\n'
	|| E'\t\tor v_room.status <> ''active''\n');

drop function pg_temp.send_pick_replace(regprocedure, text, text);

comment on function public.qorpera_answer_interaction(uuid, uuid, uuid, text, jsonb, uuid, bigint) is
	'A member''s answer to a card an agent raised. In an agent''s thread the member the card was raised for answers '
	'it; since 20260930820000 another member of the thread may send that member''s pick of a question, the one option '
	'they voted for (qorpera_decision_votes), and nothing else. Whoever sends is the answer''s author and the one the '
	'woken run is for, and must name a sponsor of their own: one member''s model account never pays for another''s '
	'call.';
