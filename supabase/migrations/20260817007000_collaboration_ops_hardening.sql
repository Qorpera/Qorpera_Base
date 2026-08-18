-- Collaboration identity and deletion hardening.
--
-- Invitation ownership must be proven from Supabase Auth, not only from a
-- caller-controlled JWT email claim. Membership projection must also avoid
-- recreating child rows while their profile or Auth user is being deleted.

create function public.qorpera_current_email_verified()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from auth.users as account
		where account.id = auth.uid()
			and account.email_confirmed_at is not null
			and lower(coalesce(account.email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
	)
$$;

revoke all on function public.qorpera_current_email_verified() from public;

create or replace function public.qorpera_list_profile_invitations()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'id', invitation.id,
				'profile_id', invitation.profile_id,
				'environment_id', environment.id,
				'profile_name', profile.name,
				'environment_name', environment.name,
				'email', invitation.email,
				'role', invitation.role,
				'invited_by_user_id', invitation.invited_by_user_id,
				'created_at', invitation.created_at,
				'expires_at', invitation.expires_at
			)
			order by invitation.created_at
		),
		'[]'::jsonb
	)
	from public.qorpera_profile_invitations as invitation
	join public.qorpera_profiles as profile on profile.id = invitation.profile_id
	join lateral (
		select candidate.*
		from public.qorpera_company_environments as candidate
		where candidate.profile_id = invitation.profile_id
		order by candidate.created_at, candidate.id
		limit 1
	) as environment on true
	where public.qorpera_current_email_verified()
		and invitation.email = lower(coalesce(auth.jwt() ->> 'email', ''))
		and invitation.expires_at > statement_timestamp()
$$;

create or replace function public.qorpera_accept_profile_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
	v_metadata jsonb := coalesce(auth.jwt() -> 'user_metadata', '{}'::jsonb);
	v_display_name text;
	v_avatar_url text;
	v_invitation public.qorpera_profile_invitations%rowtype;
begin
	if v_user_id is null or v_email = '' or not public.qorpera_current_email_verified() then
		raise exception 'a verified authenticated account email is required' using errcode = '42501';
	end if;
	select invitation.* into v_invitation
	from public.qorpera_profile_invitations as invitation
	where invitation.id = p_invitation_id
		and invitation.email = v_email
		and invitation.expires_at > statement_timestamp()
	for update;
	if not found then
		raise exception 'profile invitation was not found' using errcode = 'P0002';
	end if;
	v_display_name := coalesce(
		nullif(btrim(v_metadata ->> 'full_name'), ''),
		nullif(btrim(v_metadata ->> 'name'), ''),
		nullif(btrim(v_metadata ->> 'user_name'), ''),
		split_part(v_email, '@', 1)
	);
	v_avatar_url := nullif(coalesce(v_metadata ->> 'avatar_url', v_metadata ->> 'picture'), '');

	insert into public.qorpera_profile_members (
		profile_id,
		user_id,
		email,
		display_name,
		avatar_url,
		role
	)
	values (
		v_invitation.profile_id,
		v_user_id,
		v_email,
		left(v_display_name, 256),
		left(v_avatar_url, 2048),
		v_invitation.role
	)
	on conflict (profile_id, user_id) do update
	set email = excluded.email,
		display_name = excluded.display_name,
		avatar_url = excluded.avatar_url;

	delete from public.qorpera_profile_invitations where id = v_invitation.id;
	return 'true'::jsonb;
end
$$;

create or replace function public.qorpera_decline_profile_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
	if auth.uid() is null or v_email = '' or not public.qorpera_current_email_verified() then
		raise exception 'a verified authenticated account email is required' using errcode = '42501';
	end if;
	delete from public.qorpera_profile_invitations
	where id = p_invitation_id
		and email = v_email
		and expires_at > statement_timestamp();
	if not found then
		raise exception 'profile invitation was not found' using errcode = 'P0002';
	end if;
	return 'true'::jsonb;
end
$$;

create or replace function public.qorpera_project_profile_access_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_user_id uuid;
	v_status text;
	v_role public.qorpera_profile_role;
begin
	if tg_op = 'DELETE' then
		v_profile_id := old.profile_id;
		v_user_id := old.user_id;
		if not exists (select 1 from public.qorpera_profiles where id = v_profile_id)
			or not exists (select 1 from auth.users where id = v_user_id) then
			return old;
		end if;
		v_status := 'revoked';
		v_role := null;
	else
		v_profile_id := new.profile_id;
		v_user_id := new.user_id;
		v_status := 'active';
		v_role := new.role;
	end if;
	insert into public.qorpera_profile_access_state (profile_id, user_id, status, role)
	values (v_profile_id, v_user_id, v_status, v_role)
	on conflict (profile_id, user_id) do update
	set status = excluded.status,
		role = excluded.role,
		version = public.qorpera_profile_access_state.version + 1,
		updated_at = statement_timestamp();
	if tg_op = 'DELETE' then
		return old;
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_list_profile_invitations() from public;
revoke all on function public.qorpera_accept_profile_invitation(uuid) from public;
revoke all on function public.qorpera_decline_profile_invitation(uuid) from public;
revoke all on function public.qorpera_project_profile_access_state() from public;

grant execute on function public.qorpera_list_profile_invitations() to authenticated;
grant execute on function public.qorpera_accept_profile_invitation(uuid) to authenticated;
grant execute on function public.qorpera_decline_profile_invitation(uuid) to authenticated;
