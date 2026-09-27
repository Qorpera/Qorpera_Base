-- The office desktop draws the screen agent's own avatar as its backdrop. The
-- guest service knows only the screen binding, so it asks for the two saved
-- appearance fields every client already resolves a figure from. This is a
-- read-only broker call behind the same authority that keeps the shared
-- desktop open; it grants no input, effect receipt or browser profile.
create function public.qorpera_runtime_office_screen_appearance(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_staff public.qorpera_profile_staff%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	perform public.qorpera_check_runtime_office_shared_surface(p_binding);
	select staff.* into v_staff from public.qorpera_runtime_offices office
		join public.qorpera_profile_staff staff on staff.profile_id=office.profile_id
			and staff.staff_agent_id=(p_binding->>'staffAgentId')::uuid
		where office.id=(p_binding->>'companyComputerId')::uuid;
	if not found then raise exception 'Shared screen unavailable' using errcode='42501'; end if;
	return jsonb_build_object('creature',v_staff.appearance_creature,'templateId',v_staff.template_id);
end
$$;
revoke all on function public.qorpera_runtime_office_screen_appearance(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_screen_appearance(jsonb) to service_role;
