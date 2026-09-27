-- Bundle v100: cards in the agent's own thread.
--
-- Since the 2026-09-17 amendment (contract 19) an agent's own thread is a room
-- bound to that agent, and every member message in it is a room post that
-- wakes the agent with a room wake. The runtime withheld ask_member on every
-- room wake, so an agent could raise a card only on a member turn or its first
-- run, never in reply to an ordinary message in its own thread. Worse, a card
-- answered there was queued as a plain session input that nothing admits (an
-- agent thread has no session execution binding and an answer no turn
-- request), so the answer never woke the agent.
--
--   1. Group chats never carry cards. The native card append refuses a run
--      whose conversation is a room not bound to the run's agent. The runtime
--      withholds the tool there too; this makes it a kernel fact on the native
--      card path for every wake kind (a worker completion revives its parent in
--      the parent's conversation, which may be a group chat).
--   2. Who answers in an agent's thread. The thread is shared by the company,
--      so "the thread's creator" is the wrong answerer. The card was raised by
--      a run serving one member's request (the post it answers, or the routine
--      or first run of the member behind it), and the card's event records that
--      member as its actor. Only that member answers, while still a member of
--      the room. Approvals still need full access. Member-private threads and
--      plain company conversations keep their rule.
--   3. An answer in an agent's thread is delivered like a post in it: the
--      input is complete at once, joins the transcript as the member's
--      interaction_answer event, and wakes the thread's agent with a room wake.
--      Like a post, the answer names the member's own model account (sponsor):
--      qorpera_answer_interaction gains p_sponsor_binding_id and
--      p_sponsor_version, required in an agent's thread and checked as the wake
--      materializer will check them (binding, connection and credential all
--      usable), so an answer that could not run is refused instead of being
--      recorded without waking anyone. The raising run's own sponsor is not
--      used: a card from a coworker message, a worker's report or a routine
--      runs on the agent's standing sponsor, often another member's. A room
--      wake in the agent's thread reports final required (20260918000000),
--      which is also how the runtime recognises the thread and offers
--      ask_member again.
--
-- Rollout: record this migration before activating bundle v100. Earlier
-- runtimes never raise a card on a room wake, so they are unaffected. The web
-- falls back to the five-argument call while this migration is not applied.

create function pg_temp.agent_thread_cards_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Agent thread cards integration differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;
create function pg_temp.agent_thread_cards_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
begin
	execute pg_temp.agent_thread_cards_replace(pg_get_functiondef(p_target), p_old, p_new);
end
$$;

-- 1. qorpera_append_native_interaction_request as of 20260924060000.
select pg_temp.agent_thread_cards_patch(
	'public.qorpera_append_native_interaction_request(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,jsonb)',
	$old$	if v_run.session_id is null then
		raise exception 'interaction requests need a conversation' using errcode = '55000';
	end if;
$old$,
	$new$	if v_run.session_id is null then
		raise exception 'interaction requests need a conversation' using errcode = '55000';
	end if;
	-- Cards belong to a member's own conversation or the agent's own thread,
	-- never a group chat: a room not bound to this run's agent.
	if exists (
		select 1 from public.qorpera_company_rooms as room
		where room.session_id = v_run.session_id
			and room.bound_staff_agent_id is distinct from v_run.staff_agent_id
	) then
		raise exception 'cards are not raised in a group chat' using errcode = '22023';
	end if;
$new$);

-- 2 and 3. qorpera_answer_interaction as of 20260923050000, patched as text and
-- recreated with the two sponsor arguments (a new signature, so the old one is
-- dropped first; an old client's five named arguments still resolve to it).
do $migration$
declare
	v_definition text := pg_get_functiondef('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$p_answer jsonb DEFAULT '{}'::jsonb)$old$,
		$new$p_answer jsonb DEFAULT '{}'::jsonb, p_sponsor_binding_id uuid DEFAULT NULL::uuid, p_sponsor_version bigint DEFAULT NULL::bigint)$new$);

	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$	v_pending_body_bytes bigint;
$old$,
		$new$	v_pending_body_bytes bigint;
	v_room public.qorpera_company_rooms%rowtype;
$new$);

	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$	-- Author only: the member the thread belongs to, or its creator when the
	-- whole company reads it.
	if (v_session.audience_kind = 'member_private' and v_session.audience_user_id is distinct from v_user_id)
		or (v_session.audience_kind is distinct from 'member_private'
			and v_session.created_by_user_id is distinct from v_user_id) then
		raise exception 'Only the member this conversation belongs to can answer' using errcode = '42501';
	end if;
$old$,
		$new$	-- Author only: the member the thread belongs to, or its creator when the
	-- whole company reads it. An agent's shared thread (a room bound to its
	-- agent) is answered by the member the card was raised for, checked below.
	select room.* into v_room
	from public.qorpera_company_rooms as room
	where room.session_id = p_session_id and room.bound_staff_agent_id is not null;
	if v_room.id is null and (
		(v_session.audience_kind = 'member_private' and v_session.audience_user_id is distinct from v_user_id)
		or (v_session.audience_kind is distinct from 'member_private'
			and v_session.created_by_user_id is distinct from v_user_id)) then
		raise exception 'Only the member this conversation belongs to can answer' using errcode = '42501';
	end if;
$new$);

	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$		raise exception 'interaction request is unavailable' using errcode = '22023';
	end if;
$old$,
		$new$		raise exception 'interaction request is unavailable' using errcode = '22023';
	end if;
	if v_room.id is not null and (
		v_request.actor_user_id is distinct from v_user_id
		or v_room.status <> 'active'
		or not exists (
			select 1 from public.qorpera_company_room_members as member
			where member.room_id = v_room.id and member.principal_kind = 'member'
				and member.principal_id = v_user_id and member.status = 'active'
		)) then
		raise exception 'Only the member this card was raised for can answer it' using errcode = '42501';
	end if;
$new$);

	-- An answer in an agent's thread is in the transcript at once, so a retry of
	-- the same answer is recognised by its client input id, as a queued one is.
	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$			and answer.body #>> '{entry,data,interactionId}' = p_interaction_id::text
	) or exists (
$old$,
		$new$			and answer.body #>> '{entry,data,interactionId}' = p_interaction_id::text
			and not exists (
				select 1 from public.qorpera_session_inputs as retried
				where retried.id = answer.session_input_id and retried.client_input_id = p_client_input_id
			)
	) or exists (
$new$);

	v_definition := pg_temp.agent_thread_cards_replace(v_definition,
		$old$	insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
	values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
	returning * into v_input;
$old$,
		$new$	if v_room.id is null then
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
		values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
		returning * into v_input;
	else
		-- An agent's shared thread: delivered like a post in it (20260828022000),
		-- on the member's own model account. Checked as the wake materializer
		-- checks it, so an answer that could not run is refused, not recorded.
		if p_sponsor_binding_id is null or p_sponsor_version is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings as binding
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = binding.id and sponsor.version = p_sponsor_version
			join public.qorpera_provider_connections as connection
				on connection.id = sponsor.provider_connection_id
			join public.qorpera_provider_connection_versions as connection_version
				on connection_version.connection_id = sponsor.provider_connection_id
					and connection_version.version = sponsor.provider_connection_version
			left join public.qorpera_native_credential_capsules as capsule
				on capsule.id = connection_version.credential_capsule_id and capsule.status = 'active'
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id
				and binding.status = 'active' and binding.created_by_user_id = v_user_id
				and connection.profile_id = v_room.profile_id and connection.status = 'active'
				and (connection_version.authentication_mode is distinct from 'native_subscription'
					or capsule.compute_identity_id is not null)
		) then
			raise exception 'Room sponsor is unavailable' using errcode = '42501';
		end if;
		if public.qorpera_company_execution_paused(v_room.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000';
		end if;
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body, completed_at)
		values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body, clock_timestamp())
		returning * into v_input;
		insert into public.qorpera_wake_occurrences (id, profile_id, environment_id, wake_kind, source_kind, source_id,
			staff_agent_id, requested_by_user_id, sponsor_binding_id, sponsor_version, session_id, trigger_id,
			occurrence_key, scheduled_for, not_before, payload)
		values (extensions.gen_random_uuid(), v_room.profile_id, v_room.environment_id, 'room', 'room', v_input.id,
			v_room.bound_staff_agent_id, v_user_id, p_sponsor_binding_id, p_sponsor_version, p_session_id, 'room',
			'room:' || v_room.id::text || ':' || v_input.id::text || ':' || v_room.bound_staff_agent_id::text,
			clock_timestamp(), clock_timestamp(),
			jsonb_build_object('roomId', v_room.id, 'inputIds', jsonb_build_array(v_input.id),
				'recipientStaffId', v_room.bound_staff_agent_id));
		perform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);
	end if;
$new$);

	drop function public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb);
	execute v_definition;
end
$migration$;
revoke all on function public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint) from public,anon,service_role;
grant execute on function public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint) to authenticated;
