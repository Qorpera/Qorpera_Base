create table public.qorpera_decision_votes (
	profile_id uuid not null,
	item_id uuid not null,
	user_id uuid not null,
	choice text check (length(choice) between 1 and 200),
	note text check (length(note) between 1 and 500),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, item_id, user_id),
	foreign key (profile_id, user_id) references public.qorpera_profile_members(profile_id, user_id) on delete cascade,
	check (choice is not null or note is not null)
);
alter table public.qorpera_decision_votes enable row level security;
revoke all on table public.qorpera_decision_votes from public, anon, authenticated, service_role;
comment on table public.qorpera_decision_votes is
	'A member''s vote and note on an open decision of their company (20260930819000): item_id is the card''s event id '
	'or the approval''s review id, choice one of a question''s option values, note a few words. Advisory only: no row '
	'answers a card, starts a run or needs a model account. Written by qorpera_cast_decision_vote alone and read by '
	'qorpera_list_company_open_decisions; a member who leaves the company takes their rows with them.';

create function public.qorpera_company_open_decisions(p_profile_id uuid, p_first_user_id uuid, p_first_authorizes boolean)
returns table (
	item_id uuid,
	kind text,
	session_id uuid,
	room_id uuid,
	staff_agent_id uuid,
	answerer_user_id uuid,
	approver_scope text,
	sequence bigint,
	created_at timestamptz,
	card jsonb
)
language sql stable security definer set search_path = '' as $$
	select card.event_id, card.body #>> '{entry,data,surface}', card.session_id, room.id, room.bound_staff_agent_id,
		card.actor_user_id, null::text, card.sequence, card.created_at, card.body
	from public.qorpera_company_rooms as room
	join public.qorpera_shared_sessions as session
		on session.id = room.session_id and session.profile_id = p_profile_id and session.status = 'open'
			and session.audience_kind = 'company'
	cross join lateral (
		select request.session_id, request.event_id, request.sequence, request.actor_user_id, request.body,
			request.created_at
		from public.qorpera_session_events as request
		where request.session_id = room.session_id
			and request.event_type = 'interaction_request'
			and request.body #>> '{entry,data,schema}' = 'qorpera.interaction/v1'
			and request.body #>> '{entry,data,surface}' in ('question', 'draft')
			and case
				when not (request.body #> '{entry,data}' ? 'expiresAt') then true
				when pg_input_is_valid(request.body #>> '{entry,data,expiresAt}', 'timestamptz')
					then (request.body #>> '{entry,data,expiresAt}')::timestamptz > statement_timestamp()
				else false
			end
			and not exists (
				select 1 from public.qorpera_session_events as answer
				where answer.session_id = request.session_id
					and answer.event_type in ('interaction_answer', 'authorization_decision')
					and answer.body #>> '{entry,data,interactionId}' = request.event_id::text)
			and not exists (
				select 1 from public.qorpera_member_email_drafts as draft
				where draft.interaction_id = request.event_id
					and draft.status in ('sent', 'discarded', 'unconfirmed'))
			and not exists (
				select 1 from public.qorpera_session_inputs as input
				where input.session_id = request.session_id and input.kind = 'user_message'
					and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
					and input.body ->> 'interactionId' = request.event_id::text
					and input.failed_at is null)
		order by (request.actor_user_id is not distinct from p_first_user_id) desc, request.sequence desc
		limit 20
	) as card
	where room.profile_id = p_profile_id and room.bound_staff_agent_id is not null and room.status = 'active'
	union all
	select approval.id, 'approval', approval.card_session_id, approval.room_id, approval.staff_agent_id,
		approval.approver_user_id, approval.approver_scope, null::bigint, approval.created_at, approval.card
	from (
		select review.id, review.card_session_id, room.id as room_id, review.staff_agent_id, review.approver_user_id,
			review.approver_scope, review.created_at, (raised.body #> '{entry,data}') - 'call' as card
		from public.qorpera_action_reviews as review
		join public.qorpera_shared_sessions as session
			on session.id = review.card_session_id and session.profile_id = p_profile_id and session.status = 'open'
				and session.audience_kind = 'company'
		join public.qorpera_company_rooms as room on room.session_id = review.card_session_id
			and room.bound_staff_agent_id = review.staff_agent_id and room.profile_id = review.profile_id
		join public.qorpera_session_events as raised on raised.session_id = review.card_session_id
			and raised.event_type = 'authorization_request'
			and raised.body #>> '{entry,data,reviewId}' = review.id::text
		where review.profile_id = p_profile_id and review.decision = 'ask' and review.answer is null
			and review.card_session_id is not null
		order by ((review.approver_scope = 'member' and review.approver_user_id is not distinct from p_first_user_id)
			or (review.approver_scope = 'owners_admins' and p_first_authorizes)) desc, review.created_at desc
		limit 50
	) as approval
$$;
revoke all on function public.qorpera_company_open_decisions(uuid, uuid, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_company_open_decisions(uuid, uuid, boolean) is
	'Internal (20260930819000): every open decision in a company''s agent threads, whoever answers it. A question or '
	'email draft card that is not answered, not past its time and has no live answer on its way, in an active agent '
	'thread whose conversation is open and the company''s (at most 20 a thread, p_first_user_id''s own first), and an '
	'approval that still asks, as the card its authorization_request event holds, without the agent''s copy of the '
	'call (at most 50; first the ones p_first_user_id answers, the company''s too when p_first_authorizes). An '
	'approval whose card event was erased is not listed: the list gives a member only what the thread''s events give '
	'them. The same conditions on the card as qorpera_list_member_open_decisions, without the ones on the caller. '
	'Checks no caller: only qorpera_list_company_open_decisions and qorpera_cast_decision_vote reach it, after their '
	'own membership check.';

create function public.qorpera_list_company_open_decisions(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_authorize boolean;
begin
	v_role := public.qorpera_member_role(p_profile_id);
	if auth.role() is distinct from 'authenticated' or v_user is null or v_role is null then
		raise exception 'Decisions unavailable' using errcode = '42501';
	end if;
	v_authorize := public.qorpera_can_authorize_profile(p_profile_id);
	return jsonb_build_object('schema', 'qorpera.company-open-decisions/v1', 'decisions', coalesce((
		select jsonb_agg(listed.decision order by listed.can_answer desc, listed.created_at desc, listed.item_id)
		from (
			select item.can_answer, item.created_at, item.item_id,
				jsonb_build_object(
					'kind', item.kind,
					'id', item.item_id,
					'sessionId', item.session_id,
					'staffAgentId', item.staff_agent_id,
					'answererUserId', item.answerer_user_id,
					'canAnswer', item.can_answer,
					'createdAt', item.created_at,
					'votes', coalesce((
						select jsonb_agg(jsonb_build_object('userId', vote.user_id, 'choice', vote.choice, 'note', vote.note,
							'updatedAt', vote.updated_at) order by vote.updated_at, vote.user_id)
						from public.qorpera_decision_votes as vote
						join public.qorpera_profile_members as voter
							on voter.profile_id = vote.profile_id and voter.user_id = vote.user_id and voter.role <> 'viewer'
						where vote.profile_id = p_profile_id and vote.item_id = item.item_id), '[]'::jsonb))
				|| case when item.kind = 'approval' then jsonb_build_object('review', item.card)
					else jsonb_build_object('sequence', item.sequence, 'body', item.card) end as decision
			from (
				select waiting.*,
					case when waiting.kind = 'approval'
						then v_role <> 'viewer' and ((waiting.approver_scope = 'member' and waiting.answerer_user_id = v_user)
							or (waiting.approver_scope = 'owners_admins' and v_authorize))
						else v_role <> 'viewer' and waiting.answerer_user_id = v_user and exists (
							select 1 from public.qorpera_company_room_members as member
							where member.room_id = waiting.room_id and member.principal_kind = 'member'
								and member.principal_id = v_user and member.status = 'active')
					end as can_answer
				from public.qorpera_company_open_decisions(p_profile_id, v_user, v_authorize) as waiting
			) as item
			order by item.can_answer desc, item.created_at desc, item.item_id
			limit 100
		) as listed
	), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_list_company_open_decisions(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_company_open_decisions(uuid) to authenticated;
comment on function public.qorpera_list_company_open_decisions(uuid) is
	'Every open decision in the company''s agent threads, for any member of the company, spectators too '
	'(20260930819000): the ones the caller answers first, then newest first (at most 20 cards a thread, 50 approvals, '
	'100 in all), each as qorpera_list_member_open_decisions gives it (the card''s event body, or the approval card '
	'as its event holds it, without the agent''s copy of the call) plus votes: the vote and note of every member who '
	'is not a spectator now. answererUserId is the member who answers (null: any owner or admin) and canAnswer says '
	'whether the caller is one, by the rules the answer functions keep (never a spectator). It shows nothing a member '
	'could not already read: agent threads are the company''s, and their cards are events every member reads; a card '
	'whose event was erased is not listed. Read by the web''s decisions dock in the Co-Founder''s chat.';

create function public.qorpera_cast_decision_vote(p_profile_id uuid, p_item_id uuid, p_choice text, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_choice text := nullif(p_choice, '');
	v_note text := nullif(btrim(coalesce(p_note, '')), '');
	v_open record;
begin
	v_role := public.qorpera_member_role(p_profile_id);
	if auth.role() is distinct from 'authenticated' or v_user is null or v_role is null or v_role = 'viewer' then
		raise exception 'Voting unavailable' using errcode = '42501';
	end if;
	if p_item_id is null or length(v_choice) > 200 or length(v_note) > 500 then
		raise exception 'A vote is one option and at most 500 characters of note' using errcode = '22023';
	end if;
	select waiting.kind, waiting.card into v_open
	from public.qorpera_company_open_decisions(p_profile_id, v_user,
		public.qorpera_can_authorize_profile(p_profile_id)) as waiting
	where waiting.item_id = p_item_id;
	if not found then
		raise exception 'This decision is not open' using errcode = '22023';
	end if;
	if v_choice is not null and (v_open.kind <> 'question' or not exists (
		select 1
		from jsonb_array_elements(case
			when jsonb_typeof(v_open.card #> '{entry,data,payload,options}') = 'array'
				then v_open.card #> '{entry,data,payload,options}'
			else '[]'::jsonb end) as option
		where jsonb_typeof(option -> 'label') = 'string'
			and case when jsonb_typeof(option -> 'value') = 'string' then option ->> 'value' else option ->> 'label' end
				= v_choice)) then
		raise exception 'That is not one of this decision''s options' using errcode = '22023';
	end if;
	if v_choice is null and v_note is null then
		delete from public.qorpera_decision_votes
		where profile_id = p_profile_id and item_id = p_item_id and user_id = v_user;
	else
		insert into public.qorpera_decision_votes(profile_id, item_id, user_id, choice, note)
		values (p_profile_id, p_item_id, v_user, v_choice, v_note)
		on conflict (profile_id, item_id, user_id)
		do update set choice = excluded.choice, note = excluded.note, updated_at = clock_timestamp();
	end if;
	return jsonb_build_object('schema', 'qorpera.decision-vote/v1', 'itemId', p_item_id, 'choice', v_choice,
		'note', v_note);
end $$;
revoke all on function public.qorpera_cast_decision_vote(uuid, uuid, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_cast_decision_vote(uuid, uuid, text, text) to authenticated;
comment on function public.qorpera_cast_decision_vote(uuid, uuid, text, text) is
	'A member''s vote and note on an open decision of their company (20260930819000): p_choice one of a question''s '
	'option values (its value, else its label, as the web reads options; null on an email draft or an approval), '
	'p_note at most 500 characters; both empty takes the member''s vote back. Owners, admins and contributors vote, on '
	'any open decision, their own too; a spectator reads the votes and casts none. Advisory: it answers nothing, wakes '
	'no agent and needs no model account. Refuses a decision that is not open (22023) and a choice that is not one of '
	'its options (22023).';

create function public.qorpera_decision_vote_hint()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_profile uuid;
	v_class text;
begin
	if current_setting('qorpera.live_hints_failed', true) = 'on' then return null; end if;
	begin
		v_profile := case when tg_op = 'DELETE' then old.profile_id else new.profile_id end;
		v_class := v_profile || ' decision-votes';
		if strpos(coalesce(current_setting('qorpera.live_hints_sent', true), ''), '|' || v_class || '|') > 0 then
			return null;
		end if;
		perform set_config('lock_timeout', '20ms', true);
		perform public.qorpera_live_hint_send('sessions', public.qorpera_live_hint_profile_topics(v_profile), v_class);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception
		when query_canceled then
			perform set_config('qorpera.live_hints_failed', 'on', true);
		when others then
			perform set_config('qorpera.live_hints_failed', 'on', true);
	end;
	return null;
end $$;
revoke all on function public.qorpera_decision_vote_hint()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_decision_vote_hint() is
	'At commit, tells every member of the company that its decisions changed (20260930819000), built as '
	'qorpera_member_chat_hint is: one hint per company per transaction, a 20 ms lock budget, and every error caught, '
	'so a failing Realtime never fails or slows a vote. It sends the sessions hint the web''s decisions list already '
	'follows, and touches no conversation row, so no thread moves in anyone''s list.';
create constraint trigger qorpera_decision_vote_hint after insert or update or delete on public.qorpera_decision_votes
	deferrable initially deferred for each row execute function public.qorpera_decision_vote_hint();
