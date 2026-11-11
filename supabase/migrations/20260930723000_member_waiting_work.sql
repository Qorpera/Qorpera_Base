-- What each agent's work waits on the member for (11 November 2026).
--
-- Jonas: "I would like the agents to be better at indicating when they need the users input and it's really stopped at
-- you. it's hard to tell right now." An agent that asks a member with a card (ask_member: a question, a secret, a
-- takeover or an email draft) ends its run, and until now the rail never showed it: it counted approval cards only
-- (qorpera_list_member_waiting_approvals, 20260930568000), and the open question cards were read only on an app's page
-- (qorpera_list_member_open_questions, 20260930706000). The web needs both, by agent, with a few words on what waits, so
-- the rail can say "Stopped: Which channel should the digest go to?" and the tab can count the agents that wait.
--
-- What it lists, by agent (the agent whose thread holds the card), for the calling member only:
-- - the ask_member cards they answer in the agents' own threads, by qorpera_list_member_open_questions' rules: raised
--   for them, in an active room bound to the agent that they are an active member of, its conversation open and
--   company-wide, not past its time (nor a time that is no date), and not answered (an answer in the transcript, or one
--   on its way whose delivery did not fail). Its surfaces: question, secret, takeover and draft (the ones ask_member
--   raises; a form or sign-in card from before is no card a member can answer here). Viewers answer none;
-- - the approval cards that wait for their answer, by qorpera_list_member_waiting_approvals' rules: their own
--   (approverScope member) and, for an owner or admin, the company's, in the agent's own open thread they may read.
-- For each agent: the newest item's conversation, kind (the card's surface, or approval) and time, a short "what" (the
-- card's title, or the approval's action title, in one line of at most 120 characters, with "…" where it was cut;
-- null when it has none), and how many items wait (questions: the cards; approvals: the approval cards). Newest agent
-- first. Someone who is no member is refused.
--
-- What it costs: the two reads it follows, through their own indexes (the cards' partial indexes from 20260930706000,
-- the waiting approval cards' from 20260930568000), at most 20 cards a thread and 200 approval cards. No table, index or
-- data change: nothing is written.

create function public.qorpera_list_member_waiting_work(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_authorize boolean;
begin
	-- 20260930723000
	v_role := public.qorpera_member_role(p_profile_id);
	if auth.role() is distinct from 'authenticated' or v_user is null or v_role is null then
		raise exception 'Waiting work unavailable' using errcode = '42501';
	end if;
	v_authorize := public.qorpera_can_authorize_profile(p_profile_id);
	return jsonb_build_object('schema', 'qorpera.member-waiting-work/v1', 'agents', coalesce((
		select jsonb_agg(jsonb_build_object(
				'staffAgentId', agent.staff_agent_id,
				'sessionId', agent.session_id,
				'count', agent.questions + agent.approvals,
				'questions', agent.questions,
				'approvals', agent.approvals,
				'latestAt', agent.created_at,
				'kind', agent.kind,
				'what', case when char_length(agent.what) > 120 then left(agent.what, 119) || '…' else agent.what end)
			order by agent.created_at desc, agent.staff_agent_id)
		from (
			select distinct on (item.staff_agent_id) item.staff_agent_id, item.session_id, item.created_at, item.kind,
				nullif(btrim(regexp_replace(coalesce(item.title, ''), '\s+', ' ', 'g')), '') as what,
				(count(*) filter (where item.kind <> 'approval') over (partition by item.staff_agent_id))::integer
					as questions,
				(count(*) filter (where item.kind = 'approval') over (partition by item.staff_agent_id))::integer
					as approvals
			from (
				-- The cards, as qorpera_list_member_open_questions finds them (none for a viewer).
				select room.bound_staff_agent_id as staff_agent_id, card.session_id, card.created_at,
					card.body #>> '{entry,data,surface}' as kind, card.body #>> '{entry,data,title}' as title,
					card.event_id::text as item_id
				from public.qorpera_company_rooms as room
				join public.qorpera_company_room_members as member
					on member.room_id = room.id and member.principal_kind = 'member' and member.principal_id = v_user
						and member.status = 'active'
				join public.qorpera_shared_sessions as session
					on session.id = room.session_id and session.profile_id = p_profile_id and session.status = 'open'
						and session.audience_kind = 'company'
				cross join lateral (
					select request.session_id, request.event_id, request.body, request.created_at
					from public.qorpera_session_events as request
					where request.session_id = room.session_id
						and request.event_type = 'interaction_request'
						and request.actor_user_id = v_user
						and request.body #>> '{entry,data,schema}' = 'qorpera.interaction/v1'
						and request.body #>> '{entry,data,surface}' in ('question', 'secret', 'takeover', 'draft')
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
							select 1 from public.qorpera_session_inputs as input
							where input.session_id = request.session_id and input.kind = 'user_message'
								and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
								and input.body ->> 'interactionId' = request.event_id::text
								and input.failed_at is null)
					order by request.sequence desc
					limit 20
				) as card
				where v_role <> 'viewer' and room.profile_id = p_profile_id and room.bound_staff_agent_id is not null
					and room.status = 'active'
				union all
				-- The approval cards, as qorpera_list_member_waiting_approvals finds them.
				select * from (
					select review.staff_agent_id, review.card_session_id as session_id, review.created_at,
						'approval' as kind, review.action ->> 'title' as title, review.id::text as item_id
					from public.qorpera_action_reviews as review
					join public.qorpera_shared_sessions as session
						on session.id = review.card_session_id and session.status = 'open'
					join public.qorpera_company_rooms as room on room.session_id = review.card_session_id
						and room.bound_staff_agent_id = review.staff_agent_id and room.profile_id = review.profile_id
					where review.profile_id = p_profile_id and review.decision = 'ask' and review.answer is null
						and review.card_session_id is not null
						and ((review.approver_scope = 'member' and review.approver_user_id = v_user)
							or (review.approver_scope = 'owners_admins' and v_authorize))
						and public.qorpera_can_read_session(review.card_session_id)
					order by review.created_at desc
					limit 200
				) as approval
			) as item
			order by item.staff_agent_id, item.created_at desc, item.item_id
		) as agent
	), '[]'::jsonb));
end $$;

revoke all on function public.qorpera_list_member_waiting_work(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_member_waiting_work(uuid) to authenticated;
comment on function public.qorpera_list_member_waiting_work(uuid) is
	'What each agent''s work waits on the calling member for, newest agent first: the ask_member cards raised for them '
	'and the approval cards that wait for their answer in the agents'' own threads, each agent with its newest item''s '
	'conversation, kind, time and a short "what", and the counts. Read by the web''s rail and tab title (20260930723000).';
