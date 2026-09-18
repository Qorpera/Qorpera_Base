-- Bounded client discovery. Infrastructure registration, image policy and
-- service endpoints remain outside this member response.
create function public.qorpera_member_office_catalog(p_environment_id uuid,p_after uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_company uuid; v_role text; v_office public.qorpera_runtime_offices%rowtype;
 v_staff jsonb; v_next uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Company member required' using errcode='42501'; end if;
 select profile_id into v_company from public.qorpera_company_environments where id=p_environment_id;
 if not found then raise exception 'Company unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_company);
 select role into v_role from public.qorpera_profile_members where profile_id=v_company and user_id=auth.uid() for share;
 if not found or public.qorpera_profile_gc_deletion_active(v_company) then
  raise exception 'Company unavailable' using errcode='42501'; end if;
 select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id and profile_id=v_company;
 select coalesce(jsonb_agg(jsonb_build_object('staffAgentId',staff_agent_id,'name',display_name) order by staff_agent_id),'[]'::jsonb)
 into v_staff from (select staff_agent_id,display_name from public.qorpera_profile_staff
  where profile_id=v_company and employment_status='active' and (p_after is null or staff_agent_id>p_after)
  order by staff_agent_id limit 50) s;
 if jsonb_array_length(v_staff)=50 and exists(select 1 from public.qorpera_profile_staff
  where profile_id=v_company and employment_status='active' and staff_agent_id>(v_staff->49->>'staffAgentId')::uuid) then
  v_next:=(v_staff->49->>'staffAgentId')::uuid;
 end if;
 return jsonb_build_object('companyId',v_company,'environmentId',p_environment_id,'canManage',v_role in ('owner','admin'),
  'scope',case when v_office.id is null then null else public.qorpera_runtime_office_scope(v_office) end,'staff',v_staff,'nextAfter',v_next);
end
$$;
revoke all on function public.qorpera_member_office_catalog(uuid,uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_member_office_catalog(uuid,uuid) to authenticated;
