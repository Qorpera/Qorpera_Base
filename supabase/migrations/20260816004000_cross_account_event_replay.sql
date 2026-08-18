-- Deterministic sync event ids may be retried by another profile member after
-- materialization. Identical replay is harmless and returns the first actor's
-- original event; only different content remains a conflict.

create or replace function public.qorpera_append_account_event(
	p_session_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null
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
	if p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'session event body is invalid or too large' using errcode = '22023';
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_session_id
			or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body then
			raise exception 'event id is already bound to different content' using errcode = '23505';
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
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id,
		sequence,
		event_id,
		event_type,
		actor_user_id,
		body,
		previous_hash,
		event_hash,
		created_at
	)
	values (
		p_session_id,
		v_sequence,
		p_event_id,
		p_event_type,
		v_user_id,
		p_body,
		v_previous_hash,
		v_event_hash,
		v_created_at
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
		'created_at', v_created_at
	);
end
$$;
