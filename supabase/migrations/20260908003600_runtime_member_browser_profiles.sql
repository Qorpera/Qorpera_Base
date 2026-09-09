-- Member-owned profile metadata and exact consent discovery. No cookies,
-- browser URLs, disk paths or another owner's profile are returned.
alter table public.qorpera_runtime_browser_profiles add column label text not null default 'Browser profile'
 check(char_length(label) between 1 and 80 and label=btrim(label) and label !~ '[[:cntrl:]]');

create function public.qorpera_create_member_browser_profile(p_scope jsonb,p_profile_id uuid,p_label text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile public.qorpera_runtime_browser_profiles%rowtype; v_existed boolean;
begin
 if p_label is null or char_length(p_label) not between 1 and 80 or p_label<>btrim(p_label) or p_label ~ '[[:cntrl:]]' then
  raise exception 'Invalid browser profile label' using errcode='22023'; end if;
 -- Serialize registration and label assignment with the existing office lock.
 perform 1 from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
 v_existed:=exists(select 1 from public.qorpera_runtime_browser_profiles where id=p_profile_id);
 perform public.qorpera_register_runtime_browser_profile(p_scope,p_profile_id);
 select * into strict v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id for update;
 if v_existed and v_profile.label<>p_label then raise exception 'Browser profile already named' using errcode='23505'; end if;
 if not v_existed then update public.qorpera_runtime_browser_profiles set label=p_label where id=p_profile_id returning * into v_profile; end if;
 return jsonb_build_object('profileId',v_profile.id,'version',v_profile.version,'prepared',v_profile.prepared,'label',v_profile.label,
  'activeStaffAgentId',(select staff_agent_id from public.qorpera_runtime_browser_grants where profile_id=v_profile.id and state='active'));
end
$$;

create function public.qorpera_member_browser_profiles(p_scope jsonb,p_after uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_member boolean; v_profiles jsonb; v_next uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Browser owner required' using errcode='42501'; end if;
 select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for share;
 if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
  raise exception 'Browser office differs' using errcode='42501'; end if;
 perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
 v_member:=found;
 -- Former owners retain their own metadata for explicit cleanup/revocation.
 if not v_member and not exists(select 1 from public.qorpera_runtime_browser_profiles where office_id=v_office.id and owner_user_id=auth.uid()) then
  raise exception 'Browser owner unavailable' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('profileId',id,'version',version,'prepared',prepared,'label',label,
  'activeStaffAgentId',(select staff_agent_id from public.qorpera_runtime_browser_grants where profile_id=p.id and state='active')) order by id),'[]'::jsonb)
 into v_profiles from (select id,version,prepared,label from public.qorpera_runtime_browser_profiles
  where office_id=v_office.id and owner_user_id=auth.uid() and (p_after is null or id>p_after) order by id limit 50) p;
 if jsonb_array_length(v_profiles)=50 and exists(select 1 from public.qorpera_runtime_browser_profiles
  where office_id=v_office.id and owner_user_id=auth.uid() and id>(v_profiles->49->>'profileId')::uuid) then
  v_next:=(v_profiles->49->>'profileId')::uuid; end if;
 return jsonb_build_object('scope',p_scope,'memberId',auth.uid(),'canUse',v_member and v_office.state='active'
  and not public.qorpera_profile_gc_deletion_active(v_office.profile_id),'profiles',v_profiles,'nextAfter',v_next);
end
$$;

create function public.qorpera_member_browser_grant_status(p_scope jsonb,p_profile_id uuid,p_staff_agent_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
 v_grant public.qorpera_runtime_browser_grants%rowtype; v_member boolean; v_usable boolean;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_staff_agent_id is null then
  raise exception 'Browser owner required' using errcode='42501'; end if;
 select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for share;
 if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
  raise exception 'Browser office differs' using errcode='42501'; end if;
 select * into v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id and office_id=v_office.id for share;
 if not found or v_profile.owner_user_id<>auth.uid() then raise exception 'Browser owner required' using errcode='42501'; end if;
 perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
 v_member:=found;
 select * into v_grant from public.qorpera_runtime_browser_grants where profile_id=p_profile_id and staff_agent_id=p_staff_agent_id for share;
 v_usable:=found and v_member and v_grant.state='active' and v_profile.prepared and v_grant.profile_version=v_profile.version
  and v_office.state='active' and v_office.privacy_state='shared'
  and not public.qorpera_profile_gc_deletion_active(v_office.profile_id)
  and v_grant.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations
   where profile_id=v_office.profile_id and user_id=auth.uid()),0)
  and exists(select 1 from public.qorpera_runtime_office_access where office_id=v_office.id and staff_agent_id=p_staff_agent_id and state='active')
  and exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id and employment_status='active')
  and not exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or takeover_user_id is not null));
 return jsonb_build_object('scope',p_scope,'memberId',auth.uid(),'staffAgentId',p_staff_agent_id,
  'profile',jsonb_build_object('profileId',v_profile.id,'version',v_profile.version,'prepared',v_profile.prepared,'label',v_profile.label,
   'activeStaffAgentId',(select staff_agent_id from public.qorpera_runtime_browser_grants where profile_id=v_profile.id and state='active')),
  'grant',case when v_grant.id is null then null else jsonb_build_object('grantId',v_grant.id,'version',v_grant.version,
   'profileVersion',v_grant.profile_version,'state',v_grant.state,'usable',coalesce(v_usable,false)) end);
end
$$;

revoke all on function public.qorpera_create_member_browser_profile(jsonb,uuid,text),
 public.qorpera_member_browser_profiles(jsonb,uuid), public.qorpera_member_browser_grant_status(jsonb,uuid,uuid)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_create_member_browser_profile(jsonb,uuid,text),
 public.qorpera_member_browser_profiles(jsonb,uuid), public.qorpera_member_browser_grant_status(jsonb,uuid,uuid) to authenticated;

-- Account-level cleanup discovery survives company membership removal. Only
-- offices containing this account's own profile are disclosed; no company
-- roster, current company name, screen contents or private challenge is listed.
create index qorpera_runtime_browser_profiles_owner_office on public.qorpera_runtime_browser_profiles(owner_user_id,office_id);
create function public.qorpera_member_browser_recovery(p_after uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_offices jsonb; v_next uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Browser owner required' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('scope',public.qorpera_runtime_office_scope(o),
  'ownsPrivacy',coalesce(o.privacy_challenge->>'memberId'=auth.uid()::text,false)) order by o.id),'[]'::jsonb)
 into v_offices from (select office.* from public.qorpera_runtime_offices office
  where (p_after is null or office.id>p_after) and exists(select 1 from public.qorpera_runtime_browser_profiles p
   where p.office_id=office.id and p.owner_user_id=auth.uid()) order by office.id limit 50) o;
 if jsonb_array_length(v_offices)=50 and exists(select 1 from public.qorpera_runtime_offices o
  where o.id>(v_offices#>>'{49,scope,companyComputerId}')::uuid and exists(select 1 from public.qorpera_runtime_browser_profiles p
   where p.office_id=o.id and p.owner_user_id=auth.uid())) then
  v_next:=(v_offices#>>'{49,scope,companyComputerId}')::uuid; end if;
 return jsonb_build_object('memberId',auth.uid(),'offices',v_offices,'nextAfter',v_next);
end
$$;
revoke all on function public.qorpera_member_browser_recovery(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_member_browser_recovery(uuid) to authenticated;
