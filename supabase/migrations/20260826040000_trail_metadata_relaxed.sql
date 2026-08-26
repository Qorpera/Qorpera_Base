-- Session metadata equality relaxed: the hosted session row is authoritative
-- for title and creation time, and requiring the uploaded session_info entry
-- to byte-match them jammed a session's entire trail synchronization after
-- any local rename or timestamp precision drift. Entry identity checks
-- remain. Founder trail-simplification ruling, 2026-08-26.

create or replace function public.qorpera_append_account_event(
	p_session_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null,
	p_execution_kind text default null,
	p_execution_id uuid default null,
	p_execution_claimant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
	v_execution_valid boolean := false;
	v_body_schema text;
	v_entry jsonb;
	v_entry_type text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_event_type not in (
		'message',
		'session_info',
		'run_receipt',
		'artifact_receipt',
		'authorization_request',
		'authorization_decision'
	) then
		raise exception 'session event type is invalid' using errcode = '22023';
	end if;
	if p_body is null
		or jsonb_typeof(p_body) <> 'object'
		or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'session event body is invalid or too large' using errcode = '22023';
	end if;
	if (p_execution_kind is null) is distinct from (p_execution_id is null)
		or (p_execution_kind is null) is distinct from (p_execution_claimant_id is null)
		or (p_execution_kind is not null and p_execution_kind not in ('turn', 'wake')) then
		raise exception 'session event execution identity is invalid' using errcode = '22023';
	end if;
	-- Account-authored trail events use one of two closed envelopes. The
	-- execution identity is optional provenance: transcripts are synced
	-- conversations, and the audit record of what actually executed lives in
	-- the run, receipt, and publication tables, not in chat content
	-- (founder decision, 2026-08-26).
	v_body_schema := p_body ->> 'schema';
	if v_body_schema = 'qorpera.shared-session/v1' then
		v_entry := p_body -> 'entry';
		if jsonb_typeof(v_entry) <> 'object' then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
		if p_event_type <> 'session_info'
			or not (p_body ?& array['schema', 'entry'])
			or (p_body - 'schema' - 'entry') <> '{}'::jsonb
			or not (v_entry ?& array['type', 'id', 'parentId', 'timestamp', 'name'])
			or (v_entry - 'type' - 'id' - 'parentId' - 'timestamp' - 'name') <> '{}'::jsonb
			or v_entry ->> 'type' <> 'session_info'
			or jsonb_typeof(v_entry -> 'id') <> 'string'
			or char_length(v_entry ->> 'id') not between 1 and 512
			or jsonb_typeof(v_entry -> 'parentId') not in ('null', 'string')
			or jsonb_typeof(v_entry -> 'timestamp') <> 'string'
			or char_length(v_entry ->> 'timestamp') not between 1 and 64
			or jsonb_typeof(v_entry -> 'name') <> 'string'
			or char_length(v_entry ->> 'name') not between 1 and 256 then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
	elsif v_body_schema = 'qorpera.shared-trail-entry-part/v1' then
		v_entry_type := p_body ->> 'entryType';
		if not (p_body ?& array['schema', 'entryId', 'entryType', 'partIndex', 'partCount', 'payloadBase64'])
			or (p_body - 'schema' - 'entryId' - 'entryType' - 'partIndex' - 'partCount' - 'payloadBase64') <> '{}'::jsonb
			or jsonb_typeof(p_body -> 'entryId') <> 'string'
			or char_length(p_body ->> 'entryId') not between 1 and 512
			or jsonb_typeof(p_body -> 'entryType') <> 'string'
			or char_length(v_entry_type) not between 1 and 128
			or jsonb_typeof(p_body -> 'partIndex') <> 'number'
			or (p_body ->> 'partIndex') !~ '^(0|[1-9][0-9]*)$'
			or jsonb_typeof(p_body -> 'partCount') <> 'number'
			or (p_body ->> 'partCount') !~ '^[1-9][0-9]*$'
			or jsonb_typeof(p_body -> 'payloadBase64') <> 'string'
			or char_length(p_body ->> 'payloadBase64') not between 4 and 240000
			or char_length(p_body ->> 'payloadBase64') % 4 <> 0
			or (p_body ->> 'payloadBase64') !~ '^[A-Za-z0-9+/]*={0,2}$'
			or (p_event_type = 'message' and v_entry_type <> 'message')
			or (p_event_type = 'session_info' and v_entry_type = 'message')
			or (p_event_type not in ('message', 'session_info') and v_entry_type <> 'custom') then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
		if (p_body ->> 'partIndex')::numeric < 0
			or (p_body ->> 'partCount')::numeric > 128
			or (p_body ->> 'partIndex')::numeric >= (p_body ->> 'partCount')::numeric then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
	else
		raise exception 'session event schema is invalid' using errcode = '22023';
	end if;
	if p_execution_kind is null then
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = p_session_id;
		if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		-- Metadata is display data; the hosted session row stays authoritative
		-- for title and creation time. Requiring byte-equality here jammed a
		-- session's entire synchronization after any local rename or
		-- timestamp precision drift (founder trail-simplification ruling,
		-- 2026-08-26). Only the entry identity must line up.
		if p_body #>> '{entry,id}' <> 'cloud-session-info:' || v_session.client_session_id::text
			or jsonb_typeof(p_body #> '{entry,parentId}') <> 'null' then
			raise exception 'session metadata does not match the hosted session' using errcode = '22023';
		end if;
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_session_id
			or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body
			or v_existing.execution_kind is distinct from p_execution_kind
			or v_existing.execution_id is distinct from p_execution_id
			or v_existing.execution_claimant_id is distinct from p_execution_claimant_id then
			raise exception 'event id is already bound to different content' using errcode = '23505';
		end if;
		if v_existing.actor_user_id <> v_user_id and p_execution_kind is not null then
			raise exception 'session event belongs to another member' using errcode = '42501';
		end if;
		if not public.qorpera_can_write_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		if p_event_type = 'authorization_decision'
			and not public.qorpera_can_authorize_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'authorization requires full access' using errcode = '42501';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id,
			'sequence', v_existing.sequence,
			'event_id', v_existing.event_id,
			'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id,
			'body', v_existing.body,
			'previous_hash', v_existing.previous_hash,
			'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind,
			'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'created_at', v_existing.created_at
		);
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if v_session.status <> 'open' then
		raise exception 'session is closed' using errcode = '55000';
	end if;
	if p_event_type = 'authorization_decision' and not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'authorization requires full access' using errcode = '42501';
	end if;

	if p_execution_kind = 'turn' then
		select exists (
			select 1
			from public.qorpera_session_turns as turn
			where turn.id = p_execution_id
				and turn.session_id = p_session_id
				and turn.claimant_id = p_execution_claimant_id
				and turn.claimed_by_user_id = v_user_id
				and turn.status = 'active'
				and turn.lease_expires_at > statement_timestamp()
				and turn.company_snapshot_id = v_session.company_snapshot_id
				and turn.staff_version = v_session.staff_version
		) into v_execution_valid;
	elsif p_execution_kind = 'wake' then
		select exists (
			select 1
			from public.qorpera_wake_claims as claim
			where claim.execution_id = p_execution_id
				and claim.profile_id = v_session.profile_id
				and claim.claimant_id = p_execution_claimant_id
				and claim.claimed_by_user_id = v_user_id
				and claim.completed_at is null
				and claim.claim_expires_at > statement_timestamp()
				and claim.company_snapshot_id = v_session.company_snapshot_id
				and claim.staff_version = v_session.staff_version
				and (
					v_session.staff_agent_id is null
					or v_session.staff_agent_id = claim.staff_agent_id::text
				)
		) into v_execution_valid;
	else
		-- No execution asserted: plain account-authored content. Membership
		-- and write access were already enforced above; an execution identity
		-- is optional provenance, but one that IS asserted must match a live
		-- claim (validated in the branch above).
		v_execution_valid := true;
	end if;
	if not v_execution_valid then
		raise exception 'live trail execution claim is required' using errcode = '42501';
	end if;

	select event.sequence, event.event_hash
	into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc
	limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(
		extensions.digest(
			convert_to(
				coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
					'session_id', p_session_id,
					'sequence', v_sequence,
					'event_id', p_event_id,
					'event_type', p_event_type,
					'actor_user_id', v_user_id,
					'body', p_body,
					'execution_kind', p_execution_kind,
					'execution_id', p_execution_id,
					'execution_claimant_id', p_execution_claimant_id,
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, created_at
	) values (
		p_session_id, v_sequence, p_event_id, p_event_type, v_user_id, p_body,
		v_previous_hash, v_event_hash, p_execution_kind, p_execution_id,
		p_execution_claimant_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = p_session_id;

	return jsonb_build_object(
		'session_id', p_session_id,
		'sequence', v_sequence,
		'event_id', p_event_id,
		'event_type', p_event_type,
		'actor_user_id', v_user_id,
		'body', p_body,
		'previous_hash', v_previous_hash,
		'event_hash', v_event_hash,
		'execution_kind', p_execution_kind,
		'execution_id', p_execution_id,
		'execution_claimant_id', p_execution_claimant_id,
		'created_at', v_created_at
	);
end
$$;
