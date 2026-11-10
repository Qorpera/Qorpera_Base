-- Open questions a member can answer, across the company's agent threads (10 November 2026).
--
-- Jonas: agents show their work in interface apps and engage the founder in its decisions there. An agent raises a
-- decision as a question card (ask_member, surface question) whose options preview its app (`app:<name>`); until now
-- the card showed only in the agent's thread. The web draws the open cards that point at an app on the app's page and
-- in the Concepts viewer, outside the app's frame, and answers them with qorpera_answer_interaction as the thread does.
-- That page needs the member's open cards without reading every thread: this read lists them.
--
-- What it lists: question cards in the agents' own threads (rooms bound to an agent) that this member answers, as
-- qorpera_answer_interaction checks it there: the card was raised for them (its actor), the room is active, they are an
-- active member of it, the conversation is open and company-wide, and the card is not past its time (nor has a time
-- that is no date) and not answered.
-- An answer counts while it is on its way (a live answer input) or in the transcript (an interaction_answer event); an
-- answer whose delivery failed does not, so its card is listed again, as the thread opens it again. Plain
-- conversations are not listed: on folder-v2 they answer no cards (20260928319670), and they are the agent's thread's
-- leftovers on snapshot-v1. Viewers answer nothing and get an empty list; someone who is no member is refused.
--
-- What it costs: the member's agent threads (the room index by company and agent, the members' key), then per thread
-- its newest question cards through a partial index of interaction requests only, each checked against the two answer
-- indexes. At most 20 cards a thread and 50 in all, newest first. Both new indexes are partial and small (cards and
-- answers are a sliver of the transcript); on production they are built concurrently before this migration (the ship
-- lane), so `if not exists` finds them here.
--
-- Nothing is written, and the cards' answers still go through qorpera_answer_interaction alone: an app never answers.

create index if not exists qorpera_session_events_interaction_requests
	on public.qorpera_session_events (session_id, sequence)
	where event_type = 'interaction_request';

-- Also serves qorpera_answer_interaction's own "already answered" check.
create index if not exists qorpera_session_events_interaction_answers
	on public.qorpera_session_events (session_id, (body #>> '{entry,data,interactionId}'))
	where event_type in ('interaction_answer', 'authorization_decision');

create function public.qorpera_list_member_open_questions(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_role public.qorpera_profile_role;
begin
	-- 20260930706000
	v_role := public.qorpera_member_role(p_profile_id);
	if auth.role() is distinct from 'authenticated' or v_user is null or v_role is null then
		raise exception 'Questions unavailable' using errcode = '42501';
	end if;
	if v_role = 'viewer' then
		return jsonb_build_object('schema', 'qorpera.open-questions/v1', 'questions', '[]'::jsonb);
	end if;
	return jsonb_build_object('schema', 'qorpera.open-questions/v1', 'questions', coalesce((
		select jsonb_agg(jsonb_build_object(
				'sessionId', card.session_id,
				'interactionId', card.event_id,
				'sequence', card.sequence,
				'actorUserId', card.actor_user_id,
				'staffAgentId', card.staff_agent_id,
				'body', card.body,
				'createdAt', card.created_at)
			order by card.created_at desc, card.event_id)
		from (
			select event.session_id, event.event_id, event.sequence, event.actor_user_id, event.body, event.created_at,
				room.bound_staff_agent_id as staff_agent_id
			from public.qorpera_company_rooms as room
			join public.qorpera_company_room_members as member
				on member.room_id = room.id and member.principal_kind = 'member' and member.principal_id = v_user
					and member.status = 'active'
			join public.qorpera_shared_sessions as session
				on session.id = room.session_id and session.profile_id = p_profile_id and session.status = 'open'
					and session.audience_kind = 'company'
			cross join lateral (
				select request.*
				from public.qorpera_session_events as request
				where request.session_id = room.session_id
					and request.event_type = 'interaction_request'
					and request.actor_user_id = v_user
					and request.body #>> '{entry,data,schema}' = 'qorpera.interaction/v1'
					and request.body #>> '{entry,data,surface}' = 'question'
					-- Past its time, or a time that is no date (the card's validator checks the shape only, so
					-- 2026-11-31 passes it): not answerable, and never a cast that would fail the whole list.
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
			) as event
			where room.profile_id = p_profile_id and room.bound_staff_agent_id is not null and room.status = 'active'
			order by event.created_at desc, event.event_id
			limit 50
		) as card), '[]'::jsonb));
end $$;

revoke all on function public.qorpera_list_member_open_questions(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_member_open_questions(uuid) to authenticated;
comment on function public.qorpera_list_member_open_questions(uuid) is
	'The open question cards a member answers in the company''s agent threads, newest first (at most 20 a thread, 50 '
	'in all): read by the web to show them on the interface app they point at (20260930706000). Viewers get none.';
