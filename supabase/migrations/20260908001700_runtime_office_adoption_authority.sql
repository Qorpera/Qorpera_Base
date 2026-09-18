-- Preparation only. Copying a historical profile never creates its owner,
-- membership or grant. The provider must separately prove the stopped guest,
-- exclusive storage maintenance and reviewed physical mapping.
create function public.qorpera_check_runtime_office_adoption(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_provider_binding_sha256 text,p_provider_id uuid,p_provider_policy_sha256 text,
	p_mappings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_office public.qorpera_runtime_offices%rowtype;
	v_mapping jsonb; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_grant public.qorpera_runtime_browser_grants%rowtype;
	v_screens uuid[]:='{}'; v_profiles uuid[]:='{}';
begin
	v_result:=public.qorpera_check_runtime_office_start(p_scope,p_computer_generation,p_intent_id,p_allocation_id,
		p_instance_sha256,p_provider_binding_sha256,p_provider_id,p_provider_policy_sha256);
	if jsonb_typeof(p_mappings) is distinct from 'array' then
		raise exception 'Invalid office adoption mappings' using errcode='22023'; end if;
	if jsonb_array_length(p_mappings)>32 then
		raise exception 'Invalid office adoption mappings' using errcode='22023'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	-- Expired leases are not proof that processes or viewers drained.
	if v_office.privacy_state<>'shared'
		or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id
			and (power<>'closed' or lease_id is not null or drain_pending or takeover_user_id is not null))
		or exists(select 1 from public.qorpera_runtime_office_resources where office_id=v_office.id and state<>'drained')
		or exists(select 1 from public.qorpera_runtime_office_viewers where office_id=v_office.id and state<>'ended') then
		raise exception 'Office adoption surfaces not drained' using errcode='42501'; end if;
	for v_mapping in select value from jsonb_array_elements(p_mappings) loop
		if jsonb_typeof(v_mapping) is distinct from 'object'
			or v_mapping-array['binding','browserProfile']<>'{}'::jsonb
			or not (v_mapping ?& array['binding','browserProfile']) then
			raise exception 'Invalid office adoption mapping' using errcode='22023'; end if;
		select * into v_screen from public.qorpera_runtime_office_screens
			where office_id=v_office.id and id=(v_mapping#>>'{binding,screenId}')::uuid for share;
		if not found or v_screen.id=any(v_screens)
			or v_mapping->'binding' is distinct from public.qorpera_runtime_office_scope(v_office)||jsonb_build_object(
				'computerGeneration',v_office.generation,'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,
				'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id) then
			raise exception 'Office adoption screen differs' using errcode='42501'; end if;
		v_screens:=array_append(v_screens,v_screen.id);
		perform 1 from public.qorpera_runtime_office_access access
			join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
			where access.office_id=v_office.id and access.profile_id=v_office.profile_id and access.staff_agent_id=v_screen.staff_agent_id
			and access.state='active' and staff.employment_status='active' for share of access,staff;
		if not found then raise exception 'Office adoption staff access unavailable' using errcode='42501'; end if;
		if v_mapping->'browserProfile'<>'null'::jsonb then
			select g.* into v_grant from public.qorpera_runtime_browser_grants g
				join public.qorpera_runtime_browser_profiles p on p.id=g.profile_id and p.office_id=g.office_id
				join public.qorpera_profile_members m on m.profile_id=v_office.profile_id and m.user_id=p.owner_user_id
				where g.office_id=v_office.id and g.staff_agent_id=v_screen.staff_agent_id and g.state='active'
				and p.prepared and p.verified_version=p.version and g.profile_version=p.version
				and g.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations
					where profile_id=v_office.profile_id and user_id=p.owner_user_id),0) for share of g,p,m;
			if not found or v_grant.profile_id=any(v_profiles)
				or v_mapping->'browserProfile' is distinct from jsonb_build_object('profileId',v_grant.profile_id,
					'grantId',v_grant.id,'version',v_grant.version) then
				raise exception 'Office adoption browser grant unavailable' using errcode='42501'; end if;
			v_profiles:=array_append(v_profiles,v_grant.profile_id);
		end if;
	end loop;
	return v_result||jsonb_build_object('mappings',p_mappings);
end
$$;
revoke all on function public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb) to service_role;
