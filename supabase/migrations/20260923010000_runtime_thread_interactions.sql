-- Thread interactions (bundle v75): typed cards an agent raises in its thread
-- and typed answers a member gives back. One mechanism for every card:
--   * the agent's run appends an `interaction_request` transcript event (a
--     custom runner entry whose data is a `qorpera.interaction/v1` payload,
--     validated here per surface; agents never author HTML or free forms);
--   * the member answers through `qorpera_answer_interaction`, which enqueues
--     an ordinary session input (schema `qorpera.interaction-answer/v1`), so
--     the existing admission, wake and run machinery carries the answer to
--     the agent as a human wake in the same thread;
--   * when that run admits the input, the input materializes as an
--     `interaction_answer` event (or an `authorization_decision` for an
--     approval), authored by the member, in the hash-chained transcript.
-- Secrets never travel this path: a secret request is answered with an
-- outcome only, and a form answer may carry values for non-secret fields
-- only. The value itself goes to the company vault through the broker.
-- Design: THREAD-WIDGETS-DESIGN-20260922.md.

-- 1. Two new transcript event types. Two unnamed checks are replaced: the
-- type list, and the fence that lets only member messages carry a
-- session_input_id (member answers do too now).
do $$
declare
	v_constraint record;
	v_type_lists integer := 0;
	v_input_fences integer := 0;
begin
	for v_constraint in
		select conname, pg_get_constraintdef(oid) as definition
		from pg_constraint
		where conrelid = 'public.qorpera_session_events'::regclass and contype = 'c'
	loop
		if v_constraint.definition ~ '^CHECK \(\(event_type = ANY \(ARRAY\[' then
			execute format('alter table public.qorpera_session_events drop constraint %I', v_constraint.conname);
			v_type_lists := v_type_lists + 1;
		elsif v_constraint.definition like '%session_input_id IS NULL%' then
			execute format('alter table public.qorpera_session_events drop constraint %I', v_constraint.conname);
			v_input_fences := v_input_fences + 1;
		end if;
	end loop;
	if v_type_lists <> 1 or v_input_fences <> 1 then
		raise exception 'Session event constraints differ (% type lists, % input fences)', v_type_lists, v_input_fences;
	end if;
end
$$;
alter table public.qorpera_session_events
	add constraint qorpera_session_events_event_type_check check (
		event_type in (
			'message',
			'session_info',
			'run_receipt',
			'artifact_receipt',
			'authorization_request',
			'authorization_decision',
			'interaction_request',
			'interaction_answer'
		)
	),
	add constraint qorpera_session_events_input_event_check check (
		session_input_id is null
		or (event_type in ('message', 'interaction_answer', 'authorization_decision') and execution_kind is null)
	);

-- 2. What an agent may ask for. Closed objects per surface; the member's
-- client renders only these, so an unknown key is a refusal, not a mystery.
create function public.qorpera_interaction_host_valid(p_host text)
returns boolean language sql immutable set search_path = '' as $$
	select p_host is not null and octet_length(p_host) <= 253
		and p_host ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$'
$$;
revoke all on function public.qorpera_interaction_host_valid(text) from public;

create function public.qorpera_interaction_text_valid(p_value jsonb, p_min integer, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_value) = 'string'
		and octet_length(p_value #>> '{}') between p_min and p_max
		and (p_value #>> '{}') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
$$;
revoke all on function public.qorpera_interaction_text_valid(jsonb, integer, integer) from public;

create function public.qorpera_interaction_request_valid(p_data jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_surface text;
	v_payload jsonb;
	v_item jsonb;
	v_option jsonb;
	v_ids text[] := '{}';
	v_targets integer := 0;
	v_secret boolean;
begin
	if jsonb_typeof(p_data) <> 'object'
		or p_data ->> 'schema' is distinct from 'qorpera.interaction/v1'
		or p_data - 'schema' - 'surface' - 'title' - 'body' - 'expiresAt' - 'payload' <> '{}'::jsonb
		or not public.qorpera_interaction_text_valid(p_data -> 'title', 1, 200)
		or (p_data ? 'body' and not public.qorpera_interaction_text_valid(p_data -> 'body', 0, 2000))
		or (p_data ? 'expiresAt' and (
			jsonb_typeof(p_data -> 'expiresAt') <> 'string'
			or (p_data ->> 'expiresAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$'
		))
		or jsonb_typeof(p_data -> 'payload') <> 'object' then
		return false;
	end if;
	v_surface := p_data ->> 'surface';
	v_payload := p_data -> 'payload';
	if v_surface = 'question' then
		if v_payload - 'options' - 'multiSelect' - 'allowCustom' - 'dismissOnMoveOn' <> '{}'::jsonb
			or jsonb_typeof(v_payload -> 'options') <> 'array'
			or jsonb_array_length(v_payload -> 'options') not between 1 and 6
			or (v_payload ? 'multiSelect' and jsonb_typeof(v_payload -> 'multiSelect') <> 'boolean')
			or (v_payload ? 'allowCustom' and jsonb_typeof(v_payload -> 'allowCustom') <> 'boolean')
			or (v_payload ? 'dismissOnMoveOn' and jsonb_typeof(v_payload -> 'dismissOnMoveOn') <> 'boolean') then
			return false;
		end if;
		for v_option in select value from jsonb_array_elements(v_payload -> 'options') loop
			if jsonb_typeof(v_option) <> 'object'
				or v_option - 'label' - 'value' - 'description' - 'style' <> '{}'::jsonb
				or not public.qorpera_interaction_text_valid(v_option -> 'label', 1, 80)
				or (v_option ? 'value' and not public.qorpera_interaction_text_valid(v_option -> 'value', 1, 200))
				or (v_option ? 'description' and not public.qorpera_interaction_text_valid(v_option -> 'description', 0, 200))
				or (v_option ? 'style' and coalesce(v_option ->> 'style', '') not in ('default', 'primary', 'danger')) then
				return false;
			end if;
		end loop;
		return true;
	elsif v_surface = 'secret' then
		return v_payload - 'name' - 'label' - 'purpose' - 'kind' = '{}'::jsonb
			and coalesce(v_payload ->> 'name', '') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
			and public.qorpera_interaction_text_valid(v_payload -> 'label', 1, 80)
			and public.qorpera_interaction_text_valid(v_payload -> 'purpose', 1, 300)
			and (not v_payload ? 'kind' or coalesce(v_payload ->> 'kind', '') in ('token', 'password', 'text'));
	elsif v_surface = 'form' then
		if v_payload - 'domain' - 'reason' - 'submitAfterFill' - 'fields' <> '{}'::jsonb
			or not public.qorpera_interaction_host_valid(v_payload ->> 'domain')
			or (v_payload ? 'reason' and coalesce(v_payload ->> 'reason', '') not in ('sign_in', 'checkout', 'profile', 'other'))
			or (v_payload ? 'submitAfterFill' and jsonb_typeof(v_payload -> 'submitAfterFill') <> 'boolean')
			or jsonb_typeof(v_payload -> 'fields') <> 'array'
			or jsonb_array_length(v_payload -> 'fields') not between 1 and 8 then
			return false;
		end if;
		for v_item in select value from jsonb_array_elements(v_payload -> 'fields') loop
			v_secret := coalesce((v_item -> 'secret')::text = 'true', false)
				or coalesce(v_item ->> 'type', '') in ('password', 'otp');
			if jsonb_typeof(v_item) <> 'object'
				or v_item - 'id' - 'label' - 'type' - 'required' - 'placeholder' - 'options' - 'secret' - 'target' - 'vaultName'
					<> '{}'::jsonb
				or coalesce(v_item ->> 'id', '') !~ '^[a-z][a-z0-9_]{0,31}$'
				or (v_item ->> 'id') = any(v_ids)
				or not public.qorpera_interaction_text_valid(v_item -> 'label', 1, 80)
				or coalesce(v_item ->> 'type', '') not in (
					'text', 'email', 'tel', 'password', 'otp', 'number', 'date', 'select', 'textarea', 'checkbox')
				or (v_item ? 'required' and jsonb_typeof(v_item -> 'required') <> 'boolean')
				or (v_item ? 'secret' and jsonb_typeof(v_item -> 'secret') <> 'boolean')
				or (v_item ? 'placeholder' and not public.qorpera_interaction_text_valid(v_item -> 'placeholder', 0, 80))
				or (v_item ? 'options') <> (v_item ->> 'type' = 'select')
				or (v_item ? 'options' and (
					jsonb_typeof(v_item -> 'options') <> 'array'
					or jsonb_array_length(v_item -> 'options') not between 1 and 32
					or exists (
						select 1 from jsonb_array_elements(v_item -> 'options') as choice(value)
						where jsonb_typeof(choice.value) <> 'object'
							or choice.value - 'label' - 'value' <> '{}'::jsonb
							or not public.qorpera_interaction_text_valid(choice.value -> 'label', 1, 80)
							or not public.qorpera_interaction_text_valid(choice.value -> 'value', 1, 200)
					)
				))
				or (v_item ? 'target' and (
					jsonb_typeof(v_item -> 'target') <> 'object'
					or (v_item -> 'target') - 'kind' - 'value' <> '{}'::jsonb
					or coalesce(v_item #>> '{target,kind}', '') not in ('ref', 'selector', 'label')
					or not public.qorpera_interaction_text_valid(v_item #> '{target,value}', 1, 512)
				))
				or (v_secret and not v_item ? 'target')
				or (v_item ? 'vaultName' and (
					not v_secret or coalesce(v_item ->> 'vaultName', '') !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
				)) then
				return false;
			end if;
			v_ids := v_ids || (v_item ->> 'id');
			if v_item ? 'target' then v_targets := v_targets + 1; end if;
		end loop;
		-- Pressing Enter for the member is only for a single one-time code.
		if coalesce((v_payload -> 'submitAfterFill')::text = 'true', false)
			and (jsonb_array_length(v_payload -> 'fields') <> 1 or v_targets <> 1) then
			return false;
		end if;
		return true;
	elsif v_surface = 'takeover' then
		return v_payload - 'instruction' - 'reason' - 'domain' - 'idpDomain' = '{}'::jsonb
			and public.qorpera_interaction_text_valid(v_payload -> 'instruction', 1, 300)
			and (not v_payload ? 'reason' or coalesce(v_payload ->> 'reason', '') in ('sign_in', 'captcha', 'payment', 'other'))
			and (not v_payload ? 'domain' or public.qorpera_interaction_host_valid(v_payload ->> 'domain'))
			and (not v_payload ? 'idpDomain' or public.qorpera_interaction_host_valid(v_payload ->> 'idpDomain'));
	elsif v_surface = 'draft' then
		return v_payload - 'platform' - 'connectorId' - 'from' - 'to' - 'cc' - 'subject' - 'body' - 'replyTo' - 'threadRef'
				= '{}'::jsonb
			and coalesce(v_payload ->> 'platform', '') in ('email', 'slack', 'message')
			and public.qorpera_interaction_text_valid(v_payload -> 'connectorId', 1, 128)
			and public.qorpera_interaction_text_valid(v_payload -> 'from', 1, 320)
			and jsonb_typeof(v_payload -> 'to') = 'array'
			and jsonb_array_length(v_payload -> 'to') between 1 and 32
			and not exists (
				select 1 from jsonb_array_elements(v_payload -> 'to') as recipient(value)
				where not public.qorpera_interaction_text_valid(recipient.value, 1, 320))
			and (not v_payload ? 'cc' or (
				jsonb_typeof(v_payload -> 'cc') = 'array'
				and jsonb_array_length(v_payload -> 'cc') <= 32
				and not exists (
					select 1 from jsonb_array_elements(v_payload -> 'cc') as recipient(value)
					where not public.qorpera_interaction_text_valid(recipient.value, 1, 320))))
			and (not v_payload ? 'subject' or public.qorpera_interaction_text_valid(v_payload -> 'subject', 0, 500))
			and public.qorpera_interaction_text_valid(v_payload -> 'body', 1, 65536)
			and (not v_payload ? 'replyTo' or public.qorpera_interaction_text_valid(v_payload -> 'replyTo', 1, 256))
			and (not v_payload ? 'threadRef' or public.qorpera_interaction_text_valid(v_payload -> 'threadRef', 1, 256));
	elsif v_surface = 'credential' then
		return v_payload - 'name' - 'domain' - 'purpose' = '{}'::jsonb
			and coalesce(v_payload ->> 'name', '') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
			and public.qorpera_interaction_host_valid(v_payload ->> 'domain')
			and (not v_payload ? 'purpose' or public.qorpera_interaction_text_valid(v_payload -> 'purpose', 0, 300));
	end if;
	-- Approvals keep their own event (`authorization_request`); routine
	-- confirmations are raised by the kernel, not by a run.
	return false;
end
$$;
revoke all on function public.qorpera_interaction_request_valid(jsonb) from public;

-- 3. The runner may append an interaction request as a custom entry. It may
-- never append an answer: answers are member inputs.
create or replace function public.qorpera_runner_transcript_entry_valid(
	p_event_type text,
	p_body jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_entry jsonb := p_body -> 'entry';
	v_message jsonb;
begin
	if coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or jsonb_typeof(v_entry) <> 'object'
		or coalesce(jsonb_typeof(v_entry -> 'parentId'), '') not in ('null', 'string')
		or (jsonb_typeof(v_entry -> 'parentId') = 'string'
			and octet_length(convert_to(v_entry ->> 'parentId', 'utf8')) not between 1 and 128)
		or coalesce(v_entry ->> 'timestamp', '') !~
			'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$' then
		return false;
	end if;
	if p_event_type = 'message' then
		v_message := v_entry -> 'message';
		if v_entry ->> 'type' <> 'message'
			or jsonb_typeof(v_message) <> 'object'
			or coalesce(v_message ->> 'role', '') not in ('assistant', 'tool')
			or jsonb_typeof(v_message -> 'content') <> 'array'
			or jsonb_array_length(v_message -> 'content') not between 1 and 256
			or exists (
				select 1 from jsonb_array_elements(v_message -> 'content') as part(value)
				where jsonb_typeof(part.value) <> 'object'
					or coalesce(part.value ->> 'type', '') not in ('text', 'thinking', 'toolCall', 'image')
					or (part.value ->> 'type' = 'text' and jsonb_typeof(part.value -> 'text') <> 'string')
					or (part.value ->> 'type' = 'thinking'
						and jsonb_typeof(part.value -> 'thinking') <> 'string')
					or (part.value ->> 'type' = 'toolCall' and (
						jsonb_typeof(part.value -> 'id') <> 'string'
						or jsonb_typeof(part.value -> 'name') <> 'string'
						or jsonb_typeof(part.value -> 'arguments') <> 'object'
					))
					or (part.value ->> 'type' = 'image' and (
						jsonb_typeof(part.value -> 'data') <> 'string'
						or jsonb_typeof(part.value -> 'mimeType') <> 'string'
					))
			) then
			return false;
		end if;
		return true;
	end if;
	if p_event_type = 'interaction_request' then
		return v_entry ->> 'type' = 'custom'
			and v_entry ->> 'customType' = 'interaction_request'
			and public.qorpera_interaction_request_valid(v_entry -> 'data');
	end if;
	return p_event_type in (
		'run_receipt', 'artifact_receipt', 'authorization_request', 'authorization_decision'
	) and v_entry ->> 'type' = 'custom'
		and v_entry ->> 'customType' = p_event_type
		and jsonb_typeof(v_entry -> 'data') = 'object'
		and (select count(*) from jsonb_object_keys(v_entry -> 'data')) between 1 and 64;
end
$$;

-- Admit the new type in the runner append path without restating the rest
-- of that function (every later hardening of it stays in place).
do $$
declare
	v_definition text;
	v_needle text := E'\t\t\t\'authorization_request\', \'authorization_decision\'\n\t\t) or p_body is null';
begin
	v_definition := pg_get_functiondef(
		'public.qorpera_append_runner_transcript_event(uuid,text,uuid,text,uuid,uuid,text,jsonb,bigint)'::regprocedure);
	if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 1 then
		raise exception 'Runner transcript append event type list differs';
	end if;
	execute replace(v_definition, v_needle,
		E'\t\t\t\'authorization_request\', \'authorization_decision\', \'interaction_request\'\n\t\t) or p_body is null');
end
$$;

-- 4. One answer per request, even while it is still queued.
create unique index qorpera_session_inputs_one_interaction_answer
	on public.qorpera_session_inputs (session_id, ((body ->> 'interactionId')))
	where kind = 'user_message' and body ->> 'schema' = 'qorpera.interaction-answer/v1';

-- 5. The member's answer. Enqueued like a message so the agent wakes in its
-- own thread; validated against the request so the transcript never carries
-- a value for a secret field, a second answer, or an answer to a card that
-- has expired.
create function public.qorpera_answer_interaction(
	p_session_id uuid,
	p_client_input_id uuid,
	p_interaction_id uuid,
	p_outcome text,
	p_answer jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype;
	v_request public.qorpera_session_events%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_data jsonb;
	v_payload jsonb;
	v_surface text;
	v_answer jsonb := coalesce(p_answer, '{}'::jsonb);
	v_body jsonb;
	v_value jsonb;
	v_key text;
	v_secret_ids text[];
	v_field_ids text[];
	v_option_values text[];
	v_pending_inputs integer;
	v_pending_body_bytes bigint;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	v_profile_id := public.qorpera_session_profile_for_write(p_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	if public.qorpera_profile_gc_deletion_active(v_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object cleanup is in progress', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if p_client_input_id is null or p_interaction_id is null then
		raise exception 'client input id and interaction id are required' using errcode = '22023';
	end if;
	if jsonb_typeof(v_answer) <> 'object' or pg_column_size(v_answer) > 65536 then
		raise exception 'interaction answer is invalid' using errcode = '22023';
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if v_session.status <> 'open' then
		raise exception 'conversation is closed' using errcode = '55000';
	end if;
	-- Author only: the member the thread belongs to, or its creator when the
	-- whole company reads it.
	if (v_session.audience_kind = 'member_private' and v_session.audience_user_id is distinct from v_user_id)
		or (v_session.audience_kind is distinct from 'member_private'
			and v_session.created_by_user_id is distinct from v_user_id) then
		raise exception 'Only the member this conversation belongs to can answer' using errcode = '42501';
	end if;

	select event.* into v_request
	from public.qorpera_session_events as event
	where event.session_id = p_session_id and event.event_id = p_interaction_id
		and event.event_type in ('interaction_request', 'authorization_request');
	if not found then
		raise exception 'interaction request is unavailable' using errcode = '22023';
	end if;
	v_data := v_request.body #> '{entry,data}';
	if v_request.event_type = 'authorization_request' then
		v_surface := 'approval';
		v_payload := coalesce(v_data, '{}'::jsonb);
		if not public.qorpera_can_authorize_profile(v_profile_id) then
			raise exception 'authorization requires full access' using errcode = '42501';
		end if;
	else
		v_surface := v_data ->> 'surface';
		v_payload := v_data -> 'payload';
		if v_data ? 'expiresAt' and (v_data ->> 'expiresAt')::timestamptz <= statement_timestamp() then
			raise exception 'interaction request has expired' using errcode = '55000';
		end if;
	end if;
	if exists (
		select 1 from public.qorpera_session_events as answer
		where answer.session_id = p_session_id
			and answer.event_type in ('interaction_answer', 'authorization_decision')
			and answer.body #>> '{entry,data,interactionId}' = p_interaction_id::text
	) or exists (
		select 1 from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.kind = 'user_message'
			and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
			and input.body ->> 'interactionId' = p_interaction_id::text
			and input.client_input_id <> p_client_input_id
	) then
		raise exception 'interaction request is already answered' using errcode = '55000';
	end if;

	-- Outcome and answer shape, per surface. Declining carries nothing.
	if v_surface = 'question' then
		if p_outcome not in ('answered', 'declined') then
			raise exception 'question outcome is invalid' using errcode = '22023';
		end if;
		if p_outcome = 'declined' then
			if v_answer <> '{}'::jsonb then
				raise exception 'a declined question carries no answer' using errcode = '22023';
			end if;
		else
			select array_agg(coalesce(option.value ->> 'value', option.value ->> 'label'))
			into v_option_values
			from jsonb_array_elements(v_payload -> 'options') as option(value);
			if v_answer - 'values' <> '{}'::jsonb
				or jsonb_typeof(v_answer -> 'values') <> 'array'
				or jsonb_array_length(v_answer -> 'values') not between 1 and
					(case when coalesce((v_payload -> 'multiSelect')::text = 'true', false) then 6 else 1 end)
				or exists (
					select 1 from jsonb_array_elements(v_answer -> 'values') as chosen(value)
					where not public.qorpera_interaction_text_valid(chosen.value, 1, 4096)
						or (not coalesce((v_payload -> 'allowCustom')::text = 'true', false)
							and not (chosen.value #>> '{}') = any(v_option_values))
				) then
				raise exception 'question answer is invalid' using errcode = '22023';
			end if;
		end if;
	elsif v_surface = 'secret' then
		if p_outcome not in ('provided', 'declined') then
			raise exception 'secret outcome is invalid' using errcode = '22023';
		end if;
		if v_answer <> '{}'::jsonb then
			raise exception 'a secret answer carries no value' using errcode = '22023';
		end if;
	elsif v_surface = 'form' then
		if p_outcome not in ('answered', 'declined') then
			raise exception 'form outcome is invalid' using errcode = '22023';
		end if;
		if p_outcome = 'declined' then
			if v_answer <> '{}'::jsonb then
				raise exception 'a declined form carries no answer' using errcode = '22023';
			end if;
		else
			select coalesce(array_agg(field.value ->> 'id'), '{}'),
				coalesce(array_agg(field.value ->> 'id') filter (where
					coalesce((field.value -> 'secret')::text = 'true', false)
					or field.value ->> 'type' in ('password', 'otp')), '{}')
			into v_field_ids, v_secret_ids
			from jsonb_array_elements(v_payload -> 'fields') as field(value);
			if v_answer - 'values' - 'fields' <> '{}'::jsonb
				or (v_answer ? 'values' and jsonb_typeof(v_answer -> 'values') <> 'object')
				or (v_answer ? 'fields' and jsonb_typeof(v_answer -> 'fields') <> 'object') then
				raise exception 'form answer is invalid' using errcode = '22023';
			end if;
			for v_key, v_value in select key, value from jsonb_each(coalesce(v_answer -> 'values', '{}'::jsonb)) loop
				if v_key = any(v_secret_ids) then
					raise exception 'a secret field never carries its value in the answer' using errcode = '22023';
				end if;
				if not v_key = any(v_field_ids)
					or not (public.qorpera_interaction_text_valid(v_value, 0, 4096) or jsonb_typeof(v_value) = 'boolean') then
					raise exception 'form answer value is invalid' using errcode = '22023';
				end if;
			end loop;
			for v_key, v_value in select key, value from jsonb_each(coalesce(v_answer -> 'fields', '{}'::jsonb)) loop
				if not v_key = any(v_field_ids) or coalesce(v_value #>> '{}', '') not in ('filled', 'failed', 'skipped') then
					raise exception 'form field status is invalid' using errcode = '22023';
				end if;
			end loop;
		end if;
	elsif v_surface = 'takeover' then
		if p_outcome not in ('handed_back', 'dismissed') or v_answer <> '{}'::jsonb then
			raise exception 'takeover answer is invalid' using errcode = '22023';
		end if;
	elsif v_surface = 'draft' then
		if p_outcome not in ('sent', 'discarded')
			or (p_outcome = 'discarded' and v_answer <> '{}'::jsonb)
			or (p_outcome = 'sent' and (
				v_answer - 'sentSummary' <> '{}'::jsonb
				or (v_answer ? 'sentSummary' and not public.qorpera_interaction_text_valid(v_answer -> 'sentSummary', 0, 2000))
			)) then
			raise exception 'draft answer is invalid' using errcode = '22023';
		end if;
	elsif v_surface = 'approval' then
		if p_outcome not in ('approved', 'declined')
			or v_answer - 'reason' <> '{}'::jsonb
			or (v_answer ? 'reason' and not public.qorpera_interaction_text_valid(v_answer -> 'reason', 0, 1000)) then
			raise exception 'approval answer is invalid' using errcode = '22023';
		end if;
	elsif v_surface = 'credential' then
		raise exception 'a credential request is answered by the computer, not the member' using errcode = '22023';
	else
		raise exception 'interaction surface is unavailable' using errcode = '22023';
	end if;

	v_body := jsonb_build_object(
		'schema', 'qorpera.interaction-answer/v1',
		'interactionId', p_interaction_id,
		'surface', v_surface,
		'outcome', p_outcome,
		'answer', v_answer
	);

	-- Same queue discipline as a message: idempotent retries return the
	-- original input; capacity is durable, not a client estimate.
	select input.* into v_input
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id and input.client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user_id or v_input.kind <> 'user_message' or v_input.body <> v_body then
			raise exception 'client input id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object('input_id', v_input.id, 'position', v_input.position,
			'interaction_id', p_interaction_id, 'outcome', p_outcome);
	end if;
	select count(*), coalesce(sum(pg_column_size(input.body)), 0)
	into v_pending_inputs, v_pending_body_bytes
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id and input.completed_at is null and input.failed_at is null;
	if v_pending_inputs >= 512 or v_pending_body_bytes + pg_column_size(v_body) > 16777216 then
		raise exception 'session queue capacity is reached' using errcode = '54000';
	end if;
	insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
	values (p_session_id, p_client_input_id, 'user_message', v_user_id, v_body)
	returning * into v_input;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return jsonb_build_object('input_id', v_input.id, 'position', v_input.position,
		'interaction_id', p_interaction_id, 'outcome', p_outcome);
end
$$;
revoke all on function public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb) to authenticated;

-- 6. When the run admits the input, the answer joins the transcript as a
-- member-authored typed event. Messages keep their exact prior shape.
create or replace function public.qorpera_append_admitted_input_events(
	p_session_id uuid,
	p_input_ids uuid[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint;
	v_previous_hash text;
	v_parent_entry_id text;
	v_body jsonb;
	v_text text;
	v_images jsonb;
	v_event_type text;
	v_event_hash text;
begin
	if p_session_id is null
		or coalesce(cardinality(p_input_ids), 0) not between 1 and 32
		or cardinality(p_input_ids) <> (select count(distinct input_id) from unnest(p_input_ids) as input_id) then
		raise exception 'execution input transcript authority is invalid' using errcode = '42501';
	end if;
	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if (
		select count(*)
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
	) <> cardinality(p_input_ids) then
		raise exception 'execution input transcript set changed' using errcode = '23505';
	end if;
	select event.sequence, event.event_hash, event.body #>> '{entry,id}'
	into v_sequence, v_previous_hash, v_parent_entry_id
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	for v_input in
		select input.*
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
		order by input.position
	loop
		if v_input.kind <> 'user_message'
			or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
			continue;
		end if;
		if v_input.body ->> 'schema' = 'qorpera.interaction-answer/v1' then
			v_event_type := case when v_input.body ->> 'surface' = 'approval'
				then 'authorization_decision' else 'interaction_answer' end;
			v_body := jsonb_build_object(
				'schema', 'qorpera.runner-transcript-entry/v1',
				'entry', jsonb_build_object(
					'type', 'custom',
					'customType', v_event_type,
					'id', v_input.id,
					'parentId', v_parent_entry_id,
					'timestamp', to_char(v_input.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
					'data', jsonb_build_object(
						'schema', 'qorpera.interaction-answer/v1',
						'interactionId', v_input.body -> 'interactionId',
						'requestEventId', v_input.body -> 'interactionId',
						'surface', v_input.body -> 'surface',
						'outcome', v_input.body -> 'outcome',
						'answer', coalesce(v_input.body -> 'answer', '{}'::jsonb),
						'answeredBy', v_input.author_user_id
					) || case when v_input.body ->> 'surface' = 'approval'
						then jsonb_build_object('decision', v_input.body -> 'outcome') else '{}'::jsonb end
				)
			);
		else
			v_event_type := 'message';
			v_text := coalesce(v_input.body ->> 'displayText', v_input.body ->> 'text', '');
			v_images := case when jsonb_typeof(v_input.body -> 'images') = 'array'
				then v_input.body -> 'images' else '[]'::jsonb end;
			if v_text = '' then
				v_text := case jsonb_array_length(v_images)
					when 1 then '[Attached image]'
					else '[' || jsonb_array_length(v_images)::text || ' attached images]'
				end;
			end if;
			v_body := jsonb_build_object(
				'schema', 'qorpera.runner-transcript-entry/v1',
				'entry', jsonb_build_object(
					'type', 'message',
					'id', v_input.id,
					'parentId', v_parent_entry_id,
					'timestamp', to_char(v_input.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
					'message', jsonb_build_object(
						'role', 'user',
						'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)),
						'timestamp', floor(extract(epoch from v_input.created_at) * 1000)::bigint
					),
					'qorperaAttachments', v_images
				)
			);
		end if;
		select event.* into v_existing
		from public.qorpera_session_events as event
		where event.event_id = v_input.id;
		if found then
			if v_existing.session_id <> p_session_id
				or v_existing.session_input_id is distinct from v_input.id
				or v_existing.actor_user_id <> v_input.author_user_id
				or v_existing.event_type <> v_event_type then
				raise exception 'session input event id is already bound to other content' using errcode = '23505';
			end if;
			continue;
		end if;
		v_sequence := v_sequence + 1;
		v_event_hash := encode(extensions.digest(convert_to(
			coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
				'session_id', p_session_id,
				'sequence', v_sequence,
				'event_id', v_input.id,
				'event_type', v_event_type,
				'actor_user_id', v_input.author_user_id,
				'body', v_body,
				'session_input_id', v_input.id,
				'created_at', v_input.created_at
			)::text,
			'utf8'
		), 'sha256'), 'hex');
		insert into public.qorpera_session_events (
			session_id, sequence, event_id, event_type, actor_user_id, body,
			previous_hash, event_hash, session_input_id, created_at
		) values (
			p_session_id, v_sequence, v_input.id, v_event_type, v_input.author_user_id, v_body,
			v_previous_hash, v_event_hash, v_input.id, v_input.created_at
		);
		v_previous_hash := v_event_hash;
		v_parent_entry_id := v_input.id::text;
	end loop;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return v_sequence;
end
$$;
