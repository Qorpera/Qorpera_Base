-- Version-checked permanent deletion for authoritative hosted staff.

create function public.qorpera_delete_profile_staff(
	p_profile_id uuid,
	p_staff_agent_id uuid,
	p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_current_version bigint;
begin
	if v_actor_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select member.role
	into v_actor_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id;
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'deleting staff requires full profile access' using errcode = '42501';
	end if;
	if p_staff_agent_id is null or p_expected_version is null or p_expected_version < 1 then
		raise exception 'staff deletion input is invalid' using errcode = '22023';
	end if;

	select staff.version
	into v_current_version
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
	for update;
	if not found then
		-- A retry after the first deletion committed is already converged.
		return 'true'::jsonb;
	end if;
	if v_current_version <> p_expected_version then
		raise exception 'staff version conflict' using errcode = '40001';
	end if;

	delete from public.qorpera_profile_staff
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	return 'true'::jsonb;
end
$$;

revoke all on function public.qorpera_delete_profile_staff(uuid, uuid, bigint) from public, anon;
grant execute on function public.qorpera_delete_profile_staff(uuid, uuid, bigint) to authenticated;
