do $$ begin
	if to_regprocedure('public.qorpera_choose_member_sessions_account(uuid,uuid,uuid)') is not null then
		raise exception '20260930785000 is already applied'; end if;
	if strpos((select prosrc from pg_catalog.pg_proc
			where oid = 'public.qorpera_choose_member_session_account(uuid,uuid,uuid)'::regprocedure), '20260930580000') = 0 then
		raise exception '20260930785000 needs the pick that takes waiting turns (20260930580000)'; end if;
	if to_regprocedure('public.qorpera_member_live_account_bindings(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_member_session_waiting_turns(uuid,uuid,uuid)') is null then
		raise exception '20260930785000 needs 20260930580000 and 20260930606000'; end if;
end $$;

set local lock_timeout = '3s';

create function public.qorpera_take_member_session_account(p_profile_id uuid, p_session_id uuid, p_user_id uuid,
	p_connection_id uuid, p_binding_id uuid, p_sponsor_version bigint, p_compute_identity_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	insert into public.qorpera_member_session_accounts(profile_id, session_id, user_id, connection_id, sponsor_binding_id)
		values (p_profile_id, p_session_id, p_user_id, p_connection_id, p_binding_id)
		on conflict (profile_id, session_id, user_id) do update set
			connection_id = excluded.connection_id, sponsor_binding_id = excluded.sponsor_binding_id,
			selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
				then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
	if not public.qorpera_connection_is_chatgpt_plan(p_connection_id) then
		update public.qorpera_session_turn_requests as request
			set sponsor_binding_id = p_binding_id, sponsor_version = p_sponsor_version
			where request.id in (select locked.id from public.qorpera_session_turn_requests as locked
					where locked.id in (select waiting.request_id
						from public.qorpera_member_session_waiting_turns(p_profile_id, p_session_id, p_user_id) as waiting
						where waiting.connection_id <> p_connection_id
							and not public.qorpera_connection_is_chatgpt_plan(waiting.connection_id)
							and (not waiting.allow_autonomous or coalesce((select sponsor.allow_autonomous
								from public.qorpera_execution_sponsor_versions as sponsor
								where sponsor.binding_id = p_binding_id and sponsor.version = p_sponsor_version), false)))
					for update skip locked)
				and request.compute_identity_id = p_compute_identity_id;
	end if;
end $$;
revoke all on function public.qorpera_take_member_session_account(uuid, uuid, uuid, uuid, uuid, bigint, uuid)
	from public, anon, authenticated, service_role;

create or replace function public.qorpera_choose_member_session_account(p_profile_id uuid, p_session_id uuid,
	p_connection_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_choice record;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
	if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
	select candidate.connection_id, candidate.binding_id, candidate.sponsor_version, candidate.compute_identity_id
		into v_choice
		from public.qorpera_member_live_account_bindings(p_profile_id, v_user) as candidate
		where candidate.connection_id = p_connection_id
		order by candidate.binding_id limit 1;
	if not found then raise exception 'This login cannot pay for your conversation' using errcode = '22023'; end if;
	perform public.qorpera_take_member_session_account(p_profile_id, p_session_id, v_user, v_choice.connection_id,
		v_choice.binding_id, v_choice.sponsor_version, v_choice.compute_identity_id);
	return v_choice.connection_id;
end $$;

create function public.qorpera_member_session_login(p_profile_id uuid, p_session_id uuid, p_user_id uuid, p_live uuid[])
returns uuid language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select waiting.connection_id
			from public.qorpera_member_session_waiting_turns(p_profile_id, p_session_id, p_user_id) as waiting
			where waiting.connection_id = any(p_live)
			order by waiting.created_at, waiting.request_id limit 1),
		(select connection.id
			from public.qorpera_member_session_accounts as saved
			join public.qorpera_provider_connections as connection
				on connection.id = coalesce(public.qorpera_sponsor_binding_connection(saved.sponsor_binding_id), saved.connection_id)
				and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id
				and connection.status <> 'revoked'
			where saved.profile_id = p_profile_id and saved.session_id = p_session_id and saved.user_id = p_user_id))
$$;
revoke all on function public.qorpera_member_session_login(uuid, uuid, uuid, uuid[])
	from public, anon, authenticated, service_role;

create function public.qorpera_member_sessions_on_login(p_profile_id uuid, p_user_id uuid, p_connection_id uuid)
returns table(session_id uuid) language sql stable security definer set search_path = '' as $$
	with own as materialized (
		select mine.session_id
		from (select saved.session_id from public.qorpera_member_session_accounts as saved
				where saved.profile_id = p_profile_id and saved.user_id = p_user_id
			union
			select request.session_id from public.qorpera_session_turn_requests as request
				where request.profile_id = p_profile_id and request.status = 'queued'
					and request.sponsor_mode = 'member_connection' and request.sponsored_by_user_id = p_user_id) as mine
		join public.qorpera_shared_sessions as session on session.id = mine.session_id
			and session.profile_id = p_profile_id and session.status = 'open'
		where exists (select 1 from public.qorpera_provider_connections as connection
				where connection.id = p_connection_id and connection.profile_id = p_profile_id
					and connection.owner_user_id = p_user_id)
	), live as materialized (
		select array(select live.connection_id
			from public.qorpera_member_live_account_bindings(p_profile_id, p_user_id) as live) as connections
	)
	select own.session_id from own cross join live
	where public.qorpera_member_session_login(p_profile_id, own.session_id, p_user_id, live.connections) = p_connection_id
$$;
revoke all on function public.qorpera_member_sessions_on_login(uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_count_member_sessions_on_account(p_profile_id uuid, p_connection_id uuid)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
	return (select count(*) from public.qorpera_member_sessions_on_login(p_profile_id, v_user, p_connection_id) as on_login
		where public.qorpera_can_read_session(on_login.session_id));
end $$;
revoke all on function public.qorpera_count_member_sessions_on_account(uuid, uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_count_member_sessions_on_account(uuid, uuid) to authenticated;

create function public.qorpera_choose_member_sessions_account(p_profile_id uuid, p_from_connection_id uuid,
	p_connection_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_choice record; v_sessions uuid[]; v_live uuid[]; v_session uuid;
	v_moved integer := 0;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
	select candidate.connection_id, candidate.binding_id, candidate.sponsor_version, candidate.compute_identity_id
		into v_choice
		from public.qorpera_member_live_account_bindings(p_profile_id, v_user) as candidate
		where candidate.connection_id = p_connection_id
		order by candidate.binding_id limit 1;
	if not found then raise exception 'This login cannot pay for your conversation' using errcode = '22023'; end if;
	if p_from_connection_id is not distinct from p_connection_id then return 0; end if;
	select coalesce(array_agg(on_login.session_id order by on_login.session_id), '{}') into v_sessions
	from public.qorpera_member_sessions_on_login(p_profile_id, v_user, p_from_connection_id) as on_login
	where public.qorpera_can_read_session(on_login.session_id);
	perform 1 from public.qorpera_shared_sessions as session where session.id = any(v_sessions) order by session.id for update;
	select candidate.connection_id, candidate.binding_id, candidate.sponsor_version, candidate.compute_identity_id
		into v_choice
		from public.qorpera_member_live_account_bindings(p_profile_id, v_user) as candidate
		where candidate.connection_id = p_connection_id
		order by candidate.binding_id limit 1;
	if not found then raise exception 'This login cannot pay for your conversation' using errcode = '22023'; end if;
	v_live := array(select live.connection_id from public.qorpera_member_live_account_bindings(p_profile_id, v_user) as live);
	foreach v_session in array v_sessions loop
		if exists (select 1 from public.qorpera_shared_sessions as session
				where session.id = v_session and session.profile_id = p_profile_id and session.status = 'open')
			and public.qorpera_member_session_login(p_profile_id, v_session, v_user, v_live) = p_from_connection_id then
			perform public.qorpera_take_member_session_account(p_profile_id, v_session, v_user, v_choice.connection_id,
				v_choice.binding_id, v_choice.sponsor_version, v_choice.compute_identity_id);
			if public.qorpera_member_session_login(p_profile_id, v_session, v_user, v_live)
				is distinct from p_from_connection_id then
				v_moved := v_moved + 1;
			end if;
		end if;
	end loop;
	return v_moved;
end $$;
revoke all on function public.qorpera_choose_member_sessions_account(uuid, uuid, uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_choose_member_sessions_account(uuid, uuid, uuid) to authenticated;
