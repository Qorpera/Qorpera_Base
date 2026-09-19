-- Conversation choices do not change the agent document or autonomous work.
create table public.qorpera_session_models (
	session_id uuid primary key references public.qorpera_shared_sessions(id) on delete cascade,
	model_id text not null check (model_id in ('gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra')),
	version bigint not null check (version > 0),
	updated_by_user_id uuid not null references auth.users(id),
	updated_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_session_models enable row level security;
revoke all on public.qorpera_session_models from public,anon,authenticated,service_role;

create function public.qorpera_get_session_model(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_choice public.qorpera_session_models%rowtype;
	v_model text;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	select * into strict v_session from public.qorpera_shared_sessions where id = p_session_id;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if v_choice.session_id is not null then v_model := v_choice.model_id;
	else
		select mapping.model_id into v_model from public.qorpera_staff_provider_models mapping
		where mapping.profile_id = v_session.profile_id and mapping.staff_agent_id::text = v_session.staff_agent_id
			and mapping.provider = 'openai';
	end if;
	return jsonb_build_object('session_id',p_session_id,'model_id',coalesce(v_model,'gpt-6-astra'),
		'version',coalesce(v_choice.version,0));
end $$;

create function public.qorpera_set_session_model(p_session_id uuid,p_model_id text,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_choice public.qorpera_session_models%rowtype;
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Conversation model requires a member' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if not found or v_session.status <> 'open' or not public.qorpera_can_write_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_session.profile_id
		and user_id = v_user and role in ('owner','admin','contributor') for share;
	if not found then raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	if v_session.execution_scope ? 'roomId' then
		perform 1 from public.qorpera_company_rooms room
		join public.qorpera_company_room_members member on member.room_id = room.id
		where room.session_id = p_session_id and room.profile_id = v_session.profile_id and room.status = 'active'
			and member.principal_kind = 'member' and member.principal_id = v_user and member.status = 'active'
		for share of room,member;
		if not found then raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	end if;
	-- Membership/room locks precede the session lock, matching room post admission.
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id for update;
	if not found or v_session.status <> 'open' or not public.qorpera_can_write_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	if p_model_id is null or p_model_id not in ('gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra')
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version,0) <> p_expected_version then
		raise exception 'Conversation model changed; refresh before retrying' using errcode = '40001'; end if;
	insert into public.qorpera_session_models(session_id,model_id,version,updated_by_user_id)
	values(p_session_id,p_model_id,p_expected_version + 1,v_user)
	on conflict(session_id) do update set model_id = excluded.model_id,version = excluded.version,
		updated_by_user_id = excluded.updated_by_user_id,updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;
revoke all on function public.qorpera_get_session_model(uuid),public.qorpera_set_session_model(uuid,text,bigint)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_get_session_model(uuid),public.qorpera_set_session_model(uuid,text,bigint)
	to authenticated;

alter table public.qorpera_execution_runs drop constraint qorpera_execution_runs_model_selection_check;
alter table public.qorpera_execution_runs add constraint qorpera_execution_runs_model_selection_check
	check (model_selection in ('provider_mapping','provider_default','session_override'));

-- Room delivery runs retain the public room session ID, including bound agent
-- threads. Routine and coworker wakes may share a session but retain staff policy.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_execution_run_model_authority()'::regprocedure);
	v_old := E'\tselect mapping.* into v_mapping';
	v_new := $new$	if new.source_kind in ('session_turn','room_delivery') and v_connection.provider = 'openai'
		and v_connection_version.authentication_mode = 'native_subscription' then
		select choice.model_id into new.model_id from public.qorpera_session_models choice
		where choice.session_id = new.session_id;
		if found then
			new.model_provider := 'openai';
			new.model_selection := 'session_override';
			new.model_mapping_version := null;
			return new;
		end if;
	end if;
	select mapping.* into v_mapping$new$;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Run model authority definition changed'; end if;
	execute replace(v_definition,v_old,v_new);
end $$;
