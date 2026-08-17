-- Stable client trail identity for cross-machine materialization.

alter table public.qorpera_shared_sessions
	add column client_session_id uuid;

update public.qorpera_shared_sessions
set client_session_id = id
where client_session_id is null;

alter table public.qorpera_shared_sessions
	alter column client_session_id set not null;

create unique index qorpera_shared_sessions_profile_client_identity
	on public.qorpera_shared_sessions (profile_id, client_session_id);

create function public.qorpera_create_shared_session_v2(
	p_environment_id uuid,
	p_client_session_id uuid,
	p_title text,
	p_staff_agent_id text default null,
	p_parent_session_id uuid default null
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
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_session_id is null then
		raise exception 'client session id is required' using errcode = '22023';
	end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023';
	end if;
	if p_staff_agent_id is not null and char_length(p_staff_agent_id) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023';
	end if;
	if p_parent_session_id is not null and not exists (
		select 1 from public.qorpera_shared_sessions as parent
		where parent.id = p_parent_session_id and parent.environment_id = p_environment_id
	) then
		raise exception 'parent session is outside the environment' using errcode = '22023';
	end if;

	insert into public.qorpera_shared_sessions (
		profile_id,
		environment_id,
		client_session_id,
		title,
		staff_agent_id,
		parent_session_id,
		created_by_user_id
	)
	values (
		v_profile_id,
		p_environment_id,
		p_client_session_id,
		btrim(p_title),
		nullif(btrim(p_staff_agent_id), ''),
		p_parent_session_id,
		v_user_id
	)
	on conflict (profile_id, client_session_id) do nothing
	returning * into v_session;

	if not found then
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.profile_id = v_profile_id
			and session.client_session_id = p_client_session_id;
		if v_session.environment_id <> p_environment_id
			or v_session.title <> btrim(p_title)
			or v_session.staff_agent_id is distinct from nullif(btrim(p_staff_agent_id), '')
			or v_session.parent_session_id is distinct from p_parent_session_id then
			raise exception 'client session id is already bound to different content' using errcode = '23505';
		end if;
	end if;

	return jsonb_build_object(
		'session_id', v_session.id,
		'client_session_id', v_session.client_session_id,
		'profile_id', v_session.profile_id,
		'environment_id', v_session.environment_id,
		'title', v_session.title,
		'staff_agent_id', v_session.staff_agent_id,
		'parent_session_id', v_session.parent_session_id,
		'status', v_session.status,
		'created_by_user_id', v_session.created_by_user_id,
		'created_at', v_session.created_at,
		'updated_at', v_session.updated_at
	);
end
$$;

create or replace function public.qorpera_list_shared_sessions(p_environment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		(
			select case
				when not public.qorpera_can_read_profile(environment.profile_id) then '[]'::jsonb
				else coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'session_id', session.id,
								'client_session_id', session.client_session_id,
								'profile_id', session.profile_id,
								'environment_id', session.environment_id,
								'title', session.title,
								'staff_agent_id', session.staff_agent_id,
								'parent_session_id', session.parent_session_id,
								'status', session.status,
								'created_by_user_id', session.created_by_user_id,
								'created_at', session.created_at,
								'updated_at', session.updated_at
							)
							order by session.updated_at desc
						)
						from public.qorpera_shared_sessions as session
						where session.environment_id = p_environment_id
					),
					'[]'::jsonb
				)
			end
			from public.qorpera_company_environments as environment
			where environment.id = p_environment_id
		),
		'[]'::jsonb
	)
$$;

revoke all on function public.qorpera_create_shared_session_v2(uuid, uuid, text, text, uuid) from public;
grant execute on function public.qorpera_create_shared_session_v2(uuid, uuid, text, text, uuid) to authenticated;
