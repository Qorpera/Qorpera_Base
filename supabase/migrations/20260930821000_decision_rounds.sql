create function public.qorpera_assert_asks_again(p_session_id uuid, p_event_id uuid, p_previous uuid)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
	if p_previous is not distinct from p_event_id
		or not exists (
			select 1 from public.qorpera_session_events as previous
			where previous.session_id = p_session_id and previous.event_id = p_previous
				and previous.event_type = 'interaction_request'
				and previous.body #>> '{entry,data,schema}' = 'qorpera.interaction/v1'
				and previous.body #>> '{entry,data,surface}' = 'question'
				and (exists (
						select 1 from public.qorpera_session_events as answer
						where answer.session_id = p_session_id and answer.event_type = 'interaction_answer'
							and answer.body #>> '{entry,data,interactionId}' = p_previous::text
							and answer.body #>> '{entry,data,outcome}' = 'answered')
					or exists (
						select 1 from public.qorpera_session_inputs as input
						where input.session_id = p_session_id and input.kind = 'user_message'
							and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
							and input.body ->> 'interactionId' = p_previous::text
							and input.body ->> 'outcome' = 'answered'
							and input.failed_at is null)))
		or exists (
			select 1 from public.qorpera_session_events as other
			where other.session_id = p_session_id and other.event_type = 'interaction_request'
				and other.event_id <> p_event_id
				and other.body #>> '{entry,data,payload,asksAgain}' = p_previous::text) then
		raise exception 'asksAgain must name a question card of this thread that a member answered and that no other card asks again; leave it out otherwise'
			using errcode = '22023';
	end if;
end $$;
revoke all on function public.qorpera_assert_asks_again(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_assert_asks_again(uuid, uuid, uuid) is
	'Internal (20260930821000): refuses (22023) a question card whose payload.asksAgain does not name another question '
	'card of the same thread that a member answered (its answer written, or queued and not failed), or names one that '
	'another card already asks again: a decision''s rounds are one chain. Only qorpera_folder_append_interaction_request '
	'asks, under the thread''s lock.';

create function public.qorpera_decision_round(p_session_id uuid, p_item_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	with recursive chain as (
		select request.event_id, request.body #>> '{entry,data,payload,asksAgain}' as asks_again, 1 as round
		from public.qorpera_session_events as request
		where request.session_id = p_session_id and request.event_id = p_item_id
			and request.event_type = 'interaction_request'
		union all
		select previous.event_id, previous.body #>> '{entry,data,payload,asksAgain}', chain.round + 1
		from chain
		join public.qorpera_session_events as previous
			on previous.session_id = p_session_id and previous.event_type = 'interaction_request'
				and previous.event_id = case when pg_input_is_valid(chain.asks_again, 'uuid')
					then chain.asks_again::uuid end
		where chain.round < 20
	)
	select jsonb_build_object('number', (select max(chain.round) from chain),
		'previous', jsonb_strip_nulls(jsonb_build_object('interactionId', earlier.event_id,
			'answeredBy', coalesce(written.actor_user_id, queued.author_user_id),
			'answeredAt', coalesce(written.created_at, queued.created_at),
			'values', coalesce(written.body #> '{entry,data,answer,values}', queued.body #> '{answer,values}'))))
	from chain as earlier
	left join lateral (
		select answer.actor_user_id, answer.created_at, answer.body
		from public.qorpera_session_events as answer
		where answer.session_id = p_session_id and answer.event_type = 'interaction_answer'
			and answer.body #>> '{entry,data,interactionId}' = earlier.event_id::text
		order by answer.sequence desc
		limit 1
	) as written on true
	left join lateral (
		select input.author_user_id, input.created_at, input.body
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.kind = 'user_message'
			and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
			and input.body ->> 'interactionId' = earlier.event_id::text
			and input.failed_at is null
		order by input.created_at desc
		limit 1
	) as queued on written.actor_user_id is null
	where earlier.round = 2
$$;
revoke all on function public.qorpera_decision_round(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_decision_round(uuid, uuid) is
	'Internal (20260930821000): the round of a question card that asks another again (payload.asksAgain), as '
	'{number, previous: {interactionId, answeredBy, answeredAt, values}}: number counts the cards of the chain up to '
	'this one (at most 20 are followed), previous is the card it asks again with the answer that led here. Null for a '
	'card that asks nothing again. Read by qorpera_list_company_open_decisions.';

create function pg_temp.rounds_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Decision rounds patch anchor not found once in %', p_target;
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.rounds_replace('public.qorpera_interaction_request_valid(jsonb)',
	E'\t\tif v_payload - ''options'' - ''multiSelect'' - ''allowCustom'' - ''dismissOnMoveOn'' - ''input'' <> ''{}''::jsonb\n',
	E'\t\tif v_payload - ''options'' - ''multiSelect'' - ''allowCustom'' - ''dismissOnMoveOn'' - ''input'' - ''asksAgain'' <> ''{}''::jsonb\n'
	|| E'\t\t\tor (v_payload ? ''asksAgain'' and (jsonb_typeof(v_payload -> ''asksAgain'') <> ''string''\n'
	|| E'\t\t\t\tor (v_payload ->> ''asksAgain'') !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''))\n');

select pg_temp.rounds_replace('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
	E'\tperform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;\n',
	E'\tperform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;\n'
	|| E'\tif p_data -> ''payload'' ? ''asksAgain'' then\n'
	|| E'\t\tperform public.qorpera_assert_asks_again(v_run.session_id, p_event_id, (p_data #>> ''{payload,asksAgain}'')::uuid);\n'
	|| E'\tend if;\n');

select pg_temp.rounds_replace('public.qorpera_list_company_open_decisions(uuid)',
	E'\t\t\t\t\telse jsonb_build_object(''sequence'', item.sequence, ''body'', item.card) end as decision\n',
	E'\t\t\t\t\telse jsonb_build_object(''sequence'', item.sequence, ''body'', item.card)\n'
	|| E'\t\t\t\t\t\t|| jsonb_strip_nulls(jsonb_build_object(''round'',\n'
	|| E'\t\t\t\t\t\t\tpublic.qorpera_decision_round(item.session_id, item.item_id))) end as decision\n');

drop function pg_temp.rounds_replace(regprocedure, text, text);

comment on function public.qorpera_list_company_open_decisions(uuid) is
	'Every open decision in the company''s agent threads, for any member of the company, spectators too '
	'(20260930819000): the ones the caller answers first, then newest first (at most 20 cards a thread, 50 approvals, '
	'100 in all), each as qorpera_list_member_open_decisions gives it (the card''s event body, or the approval card '
	'as its event holds it, without the agent''s copy of the call) plus votes: the vote and note of every member who '
	'is not a spectator now. answererUserId is the member who answers (null: any owner or admin) and canAnswer says '
	'whether the caller is one, by the rules the answer functions keep (never a spectator). It shows nothing a member '
	'could not already read: agent threads are the company''s, and their cards are events every member reads; a card '
	'whose event was erased is not listed. Since 20260930821000 a question that asks another again '
	'(payload.asksAgain) also carries round: its number, and the card it asks again with the answer that led to it, '
	'which is an event of the same thread. Read by the web''s decisions dock in the Co-Founder''s chat.';

comment on function public.qorpera_interaction_request_valid(jsonb) is
	'Whether a card''s data follows the closed schema of its surface (qorpera.interaction/v1). Since 20260930821000 a '
	'question''s payload may carry asksAgain, the event id of the question card it asks again; which card that may be '
	'is checked where the card is appended (qorpera_assert_asks_again).';
