create function public.qorpera_list_member_open_decisions(p_profile_id uuid)
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
	return jsonb_build_object('schema', 'qorpera.member-open-decisions/v1', 'decisions', coalesce((
		select jsonb_agg(listed.decision order by listed.created_at desc, listed.item_id)
		from (
			select item.created_at, item.item_id, item.decision
			from (
				select card.created_at, card.event_id::text as item_id,
					jsonb_build_object(
						'kind', card.body #>> '{entry,data,surface}',
						'id', card.event_id,
						'sessionId', card.session_id,
						'staffAgentId', room.bound_staff_agent_id,
						'answererUserId', card.actor_user_id,
						'canAnswer', true,
						'sequence', card.sequence,
						'body', card.body,
						'createdAt', card.created_at) as decision
				from public.qorpera_company_rooms as room
				join public.qorpera_company_room_members as member
					on member.room_id = room.id and member.principal_kind = 'member' and member.principal_id = v_user
						and member.status = 'active'
				join public.qorpera_shared_sessions as session
					on session.id = room.session_id and session.profile_id = p_profile_id and session.status = 'open'
						and session.audience_kind = 'company'
				cross join lateral (
					select request.session_id, request.event_id, request.sequence, request.actor_user_id, request.body,
						request.created_at
					from public.qorpera_session_events as request
					where request.session_id = room.session_id
						and request.event_type = 'interaction_request'
						and request.actor_user_id = v_user
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
					order by request.sequence desc
					limit 20
				) as card
				where v_role <> 'viewer' and room.profile_id = p_profile_id and room.bound_staff_agent_id is not null
					and room.status = 'active'
				union all
				select approval.created_at, approval.item_id, approval.decision
				from (
					select review.created_at, review.id::text as item_id,
						jsonb_build_object(
							'kind', 'approval',
							'id', review.id,
							'sessionId', review.card_session_id,
							'staffAgentId', review.staff_agent_id,
							'answererUserId', review.approver_user_id,
							'canAnswer', true,
							'review', public.qorpera_action_review_card(review) - 'call',
							'createdAt', review.created_at) as decision
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
					limit 50
				) as approval
			) as item
			order by item.created_at desc, item.item_id
			limit 100
		) as listed
	), '[]'::jsonb));
end $$;

revoke all on function public.qorpera_list_member_open_decisions(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_member_open_decisions(uuid) to authenticated;
comment on function public.qorpera_list_member_open_decisions(uuid) is
	'The decisions that wait for the calling member in the company''s agent threads, newest first (at most 20 cards a '
	'thread, 50 approvals, 100 in all), each with what the web needs to draw it: the question and email draft cards '
	'raised for them (the card''s event body) and the approval cards they answer (the approval card, without the '
	'agent''s copy of the call), found as qorpera_list_member_waiting_work finds them; a secret or a takeover card is '
	'no decision and is not listed. Read by the web''s decisions dock in the Co-Founder''s chat (20260930818000). '
	'answererUserId is the member who answers (null: any owner or admin); canAnswer is true for every row, since only '
	'the caller''s own are listed.';
