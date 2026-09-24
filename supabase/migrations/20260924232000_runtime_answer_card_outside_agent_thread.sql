-- Bundle v105: a card answered outside the agent's own thread wakes the agent.
--
-- Bundle v100 (20260924210000) delivered an answer in an agent's shared thread
-- like a post there. Everywhere else qorpera_answer_interaction still queued
-- the answer as a plain session input with no turn request. Two things admit
-- such an input: a session execution binding (qorpera_configure_session_
-- execution, which production clients never call) and a session turn request
-- (which a message gets from qorpera_request_session_turn_v2, and an answer
-- never did). So in a plain company conversation the answer sat pending
-- forever, the card stayed "answered", and a second answer was refused.
--
-- Cards still reach plain conversations: the web sends a message there as a
-- turn request (a human wake), a worker's report continues its parent run in
-- the parent's conversation, and a first run queued before the 2026-09-17
-- amendment still starts in the conversation it was queued in. The runtime
-- offers ask_member on all three, and cannot tell those conversations from the
-- agent's thread, so the answer path is what changes:
--
--   1. In a plain conversation an answer is delivered the way a message there
--      is: as a session turn request on the answering member's own model
--      account (sponsor), checked as qorpera_request_session_turn checks a
--      member_connection request, so an answer that could not run is refused
--      instead of recorded. The member's compute identity is the one the
--      native credential belongs to (the only kind the web offers). The turn
--      materializer admits it as a human wake, and the agent reads the answer
--      as its current input.
--   2. A conversation with its own execution binding keeps its queue: an
--      answer there that names no sponsor is queued as before.
--   3. A group chat (a room bound to no agent) carries no cards since v100; an
--      older one there reaches no single agent, so it is refused.
--   4. An answer whose delivery failed (its turn request refused at admission)
--      never reached the agent, so it no longer counts as the card's answer:
--      the member may answer again.
--
-- An agent's shared thread is unchanged. Rollout: any time before or with the
-- v105 activation; earlier runtimes raise the same cards.

-- 4. One answer per request (20260923010000), counting only answers still on their way.
drop index public.qorpera_session_inputs_one_interaction_answer;
create unique index qorpera_session_inputs_one_interaction_answer
	on public.qorpera_session_inputs (session_id, ((body ->> 'interactionId')))
	where kind = 'user_message' and body ->> 'schema' = 'qorpera.interaction-answer/v1' and failed_at is null;

create function pg_temp.answer_outside_thread_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Answer outside the agent thread integration differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;

-- qorpera_answer_interaction as of 20260924210000.
do $migration$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)'::regprocedure);
begin
	v_definition := pg_temp.answer_outside_thread_replace(v_definition,
		$old$	v_room public.qorpera_company_rooms%rowtype;
begin
$old$,
		$new$	v_room public.qorpera_company_rooms%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
$new$);

	v_definition := pg_temp.answer_outside_thread_replace(v_definition,
		$old$	where room.session_id = p_session_id and room.bound_staff_agent_id is not null;
$old$,
		$new$	where room.session_id = p_session_id and room.bound_staff_agent_id is not null;
	-- A group chat carries no cards (20260924210000); an older one there reaches no single agent.
	if v_room.id is null and exists (
		select 1 from public.qorpera_company_rooms as room where room.session_id = p_session_id
	) then
		raise exception 'cards are not answered in a group chat' using errcode = '22023';
	end if;
$new$);

	-- An answer whose delivery failed never reached the agent: the member may answer again.
	v_definition := pg_temp.answer_outside_thread_replace(v_definition,
		$old$			and input.client_input_id <> p_client_input_id
$old$,
		$new$			and input.client_input_id <> p_client_input_id
			and input.failed_at is null
$new$);

	v_definition := pg_temp.answer_outside_thread_replace(v_definition,
		$old$	if v_room.id is null then
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
		values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
		returning * into v_input;
	else
$old$,
		$new$	if v_room.id is null and p_sponsor_binding_id is null and p_sponsor_version is null and exists (
		select 1 from public.qorpera_session_execution_bindings as binding where binding.session_id = p_session_id
	) then
		-- A conversation with its own execution binding: its queue admits the answer.
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
		values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
		returning * into v_input;
	elsif v_room.id is null then
		-- A plain conversation: delivered the way a message in it is, as a turn request
		-- on the member's own model account, checked as qorpera_request_session_turn
		-- checks a member_connection request (the compute identity is the native
		-- credential's own). An answer that could not run is refused, not recorded.
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
		select connection.* into v_connection
		from public.qorpera_provider_connections as connection
		where connection.id = v_sponsor.provider_connection_id
			and connection.profile_id = v_session.profile_id and connection.status = 'active';
		select version.* into v_connection_version
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_sponsor.provider_connection_id
			and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active';
		select capsule.* into v_capsule
		from public.qorpera_native_credential_capsules as capsule
		where capsule.id = v_connection_version.credential_capsule_id and capsule.status = 'active';
		select identity.* into v_identity
		from public.qorpera_member_compute_identities as identity
		where identity.id = v_capsule.compute_identity_id
			and identity.profile_id = v_session.profile_id and identity.status = 'active';
		if v_sponsor.binding_id is null or v_connection.id is null or v_connection_version.connection_id is null
			or not exists (
				select 1 from public.qorpera_execution_sponsor_bindings as binding
				where binding.id = p_sponsor_binding_id and binding.profile_id = v_session.profile_id
					and binding.status = 'active'
			)
			or v_sponsor.sponsor_kind <> 'member_connection'
			or v_connection.owner_user_id is distinct from v_user_id
			or v_connection_version.authentication_mode is distinct from 'native_subscription'
			or v_identity.id is null
			or v_identity.ownership_kind is distinct from 'member'
			or v_identity.owner_user_id is distinct from v_user_id
			or v_capsule.ownership_kind is distinct from v_identity.ownership_kind
			or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
			or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key then
			raise exception 'Session sponsor is unavailable' using errcode = '42501';
		end if;
		if public.qorpera_company_execution_paused(v_session.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000';
		end if;
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
		values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
		returning * into v_input;
		insert into public.qorpera_session_turn_requests (
			profile_id, session_id, client_request_id, input_id, requested_by_user_id,
			sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id,
			requested_sponsor_user_id, compute_identity_id, logical_computer_id, worker_class,
			required_capability, job_type, publication_mode, review_policy_key,
			reviewer_staff_ids, status, sponsored_at, initial_execution_selection
		) values (
			v_session.profile_id, p_session_id, p_client_input_id, v_input.id, v_user_id,
			'member_connection', p_sponsor_binding_id, p_sponsor_version, v_user_id,
			null, v_identity.id, null, 'managed_sandbox',
			'agent_turn', 'agent_turn', 'automatic', null,
			'{}'::uuid[], 'queued', statement_timestamp(),
			jsonb_build_object('sponsor_binding_id', p_sponsor_binding_id, 'sponsor_version', p_sponsor_version,
				'compute_identity_id', v_identity.id, 'logical_computer_id', null, 'worker_class', 'managed_sandbox')
		);
	else
$new$);

	execute v_definition;
end
$migration$;
