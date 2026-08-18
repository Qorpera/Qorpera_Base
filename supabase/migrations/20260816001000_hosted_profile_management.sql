-- Qorpera hosted profile management v1

create function public.qorpera_profile_team_info(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_role public.qorpera_profile_role;
begin
	v_role := public.qorpera_member_role(p_profile_id);
	if v_role is null then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;

	return jsonb_build_object(
		'profile_id', p_profile_id,
		'role', v_role,
		'capabilities', jsonb_build_object(
			'read', true,
			'write', v_role in ('owner', 'admin', 'contributor'),
			'authorize', v_role in ('owner', 'admin'),
			'manage_members', v_role in ('owner', 'admin')
		),
		'members', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'user_id', member.user_id,
						'email', member.email,
						'display_name', member.display_name,
						'avatar_url', member.avatar_url,
						'role', member.role,
						'joined_at', member.joined_at
					)
					order by
						case member.role
							when 'owner' then 0
							when 'admin' then 1
							when 'contributor' then 2
							else 3
						end,
						member.joined_at
				)
				from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id
			),
			'[]'::jsonb
		),
		'invitations', case
			when v_role not in ('owner', 'admin') then '[]'::jsonb
			else coalesce(
				(
					select jsonb_agg(
						jsonb_build_object(
							'id', invitation.id,
							'profile_id', invitation.profile_id,
							'email', invitation.email,
							'role', invitation.role,
							'invited_by_user_id', invitation.invited_by_user_id,
							'created_at', invitation.created_at,
							'expires_at', invitation.expires_at
						)
						order by invitation.created_at
					)
					from public.qorpera_profile_invitations as invitation
					where invitation.profile_id = p_profile_id
						and invitation.expires_at > statement_timestamp()
				),
				'[]'::jsonb
			)
		end
	);
end
$$;

create function public.qorpera_cancel_profile_invitation(
	p_profile_id uuid,
	p_invitation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_role public.qorpera_profile_role;
	v_invitation_role public.qorpera_profile_role;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;

	select invitation.role into v_invitation_role
	from public.qorpera_profile_invitations as invitation
	where invitation.profile_id = p_profile_id and invitation.id = p_invitation_id
	for update;
	if not found then
		raise exception 'profile invitation was not found' using errcode = 'P0002';
	end if;
	if v_actor_role = 'admin' and v_invitation_role = 'admin' then
		raise exception 'only the owner can manage full access' using errcode = '42501';
	end if;

	delete from public.qorpera_profile_invitations
	where profile_id = p_profile_id and id = p_invitation_id;
	return 'true'::jsonb;
end
$$;

create function public.qorpera_update_profile_member_role(
	p_profile_id uuid,
	p_member_user_id uuid,
	p_role public.qorpera_profile_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_member public.qorpera_profile_members%rowtype;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_role is null or p_role = 'owner' then
		raise exception 'the owner role cannot be assigned' using errcode = '22023';
	end if;
	if p_member_user_id = v_actor_id then
		raise exception 'use the leave-profile action to change your own access' using errcode = '22023';
	end if;

	select member.* into v_member
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_member_user_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if v_member.role = 'owner' then
		raise exception 'the owner role cannot be changed' using errcode = '42501';
	end if;
	if v_actor_role = 'admin' and (v_member.role = 'admin' or p_role = 'admin') then
		raise exception 'only the owner can manage full access' using errcode = '42501';
	end if;

	update public.qorpera_profile_members
	set role = p_role
	where profile_id = p_profile_id and user_id = p_member_user_id
	returning * into v_member;

	return jsonb_build_object(
		'user_id', v_member.user_id,
		'email', v_member.email,
		'display_name', v_member.display_name,
		'avatar_url', v_member.avatar_url,
		'role', v_member.role,
		'joined_at', v_member.joined_at
	);
end
$$;

create function public.qorpera_remove_profile_member(
	p_profile_id uuid,
	p_member_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_member_role public.qorpera_profile_role;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_member_user_id = v_actor_id then
		raise exception 'use the leave-profile action to remove your own access' using errcode = '22023';
	end if;

	select member.role into v_member_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_member_user_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if v_member_role = 'owner' then
		raise exception 'the owner cannot be removed' using errcode = '42501';
	end if;
	if v_actor_role = 'admin' and v_member_role = 'admin' then
		raise exception 'only the owner can manage full access' using errcode = '42501';
	end if;

	delete from public.qorpera_profile_members
	where profile_id = p_profile_id and user_id = p_member_user_id;
	return 'true'::jsonb;
end
$$;

revoke all on function public.qorpera_profile_team_info(uuid) from public;
revoke all on function public.qorpera_cancel_profile_invitation(uuid, uuid) from public;
revoke all on function public.qorpera_update_profile_member_role(uuid, uuid, public.qorpera_profile_role) from public;
revoke all on function public.qorpera_remove_profile_member(uuid, uuid) from public;

grant execute on function public.qorpera_profile_team_info(uuid) to authenticated;
grant execute on function public.qorpera_cancel_profile_invitation(uuid, uuid) to authenticated;
grant execute on function public.qorpera_update_profile_member_role(uuid, uuid, public.qorpera_profile_role) to authenticated;
grant execute on function public.qorpera_remove_profile_member(uuid, uuid) to authenticated;
