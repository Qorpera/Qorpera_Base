-- Desktop lifetime belongs to the office, not the last native run or viewer.
-- This read-only broker check permits an already-open shared screen to remain
-- running while idle. It grants no input, effect receipt or browser profile.
create function public.qorpera_check_runtime_office_shared_surface(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_binding->>'companyComputerId')::uuid for share;
	if not found or v_office.state<>'active' or v_office.privacy_state<>'shared'
		or not exists(select 1 from public.qorpera_logical_computers c where c.id=v_office.logical_computer_id
			and c.status='active' and public.qorpera_runtime_office_matches(c))
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1) then
		raise exception 'Shared surface unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id
		and id=(p_binding->>'screenId')::uuid for share;
	if not found or v_screen.power<>'open' or v_screen.drain_pending
		or p_binding is distinct from public.qorpera_runtime_office_scope(v_office)||jsonb_build_object(
			'computerGeneration',v_office.generation,'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,
			'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id)
		or not exists(select 1 from public.qorpera_runtime_office_access where office_id=v_office.id
			and profile_id=v_office.profile_id and staff_agent_id=v_screen.staff_agent_id and state='active')
		or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id
			and staff_agent_id=v_screen.staff_agent_id and employment_status='active') then
		raise exception 'Shared screen unavailable' using errcode='42501'; end if;
	return jsonb_build_object('state','authorized','privacyVersion',v_office.privacy_version,'epoch',v_screen.epoch,'validForMs',5000);
end
$$;
revoke all on function public.qorpera_check_runtime_office_shared_surface(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_check_runtime_office_shared_surface(jsonb) to service_role;
