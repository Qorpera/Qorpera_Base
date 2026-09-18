-- Real ownership, privacy transitions and consent; physical drains are fixture acknowledgements.
-- The company browser (2026-09-17 amendment): agent 30 starts with a company-owned profile and an active
-- grant, and one agent drives one profile (qorpera_browser_one_profile). These cases prove a member's own
-- profile and consent, so the owner of record first retires the company grant through the real API.
select set_config('qorpera_test.company_browser_profile',(select g.profile_id::text
 from public.qorpera_runtime_browser_grants g join public.qorpera_runtime_browser_profiles p on p.id=g.profile_id
 where p.company_owned and g.state='active' and g.staff_agent_id='30000000-0000-4000-8000-000000000030'
  and g.office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid),true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,
 current_setting('qorpera_test.company_browser_profile')::uuid,'30000000-0000-4000-8000-000000000030',1,1,false)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001'); set local role authenticated;
select pg_temp.wake_assert(public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,
 current_setting('qorpera_test.company_browser_profile')::uuid,'30000000-0000-4000-8000-000000000030',1,1,false)
 @>'{"state":"revoked","drains":[]}'::jsonb,'owner of record retires the company browser grant; no screen is open yet');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
create function pg_temp.profile_catalog(p_after uuid default null) returns jsonb language sql as $$
 select public.qorpera_member_browser_profiles(current_setting('qorpera_test.office_scope')::jsonb,p_after)
$$;
create function pg_temp.profile_status() returns jsonb language sql as $$
 select public.qorpera_member_browser_grant_status(current_setting('qorpera_test.office_scope')::jsonb,
 '36000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000030')
$$;
create function pg_temp.profile_create(p_name text default 'Work browser') returns jsonb language sql as $$
 select public.qorpera_create_member_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,
 '36000000-0000-4000-8000-000000000001',p_name)
$$;
create function pg_temp.profile_privacy(p_private boolean,p_version bigint) returns jsonb language sql as $$
 select public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
 '36000000-0000-4000-8000-000000000001',(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,p_version,p_private)
$$;
create function pg_temp.profile_grant(p_enabled boolean,p_version bigint) returns jsonb language sql as $$
 select public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,
 '36000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000030',2,p_version,p_enabled)
$$;
create function pg_temp.profile_ack(p_drains jsonb) returns void language plpgsql as $$
declare d jsonb; begin for d in select value from jsonb_array_elements(p_drains) loop
 perform public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
 (d#>>'{binding,screenId}')::uuid,(d#>>'{binding,computerGeneration}')::bigint,(d#>>'{binding,screenGeneration}')::bigint,
 (d->>'epoch')::bigint,(d->>'drainId')::uuid); end loop; end
$$;

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_catalog()=jsonb_build_object('scope',current_setting('qorpera_test.office_scope')::jsonb,
 'memberId','30000000-0000-4000-8000-000000000003','canUse',true,'profiles','[]'::jsonb,'nextAfter',null),'empty owner catalog');
select pg_temp.wake_assert(pg_temp.profile_create()='{"profileId":"36000000-0000-4000-8000-000000000001","label":"Work browser","version":1,"prepared":false,"activeStaffAgentId":null}'::jsonb,'ordinary member owns a named browser profile');
select pg_temp.wake_assert(pg_temp.profile_create()->>'label'='Work browser','same identity and label replay');
select pg_temp.wake_error($q$select pg_temp.profile_create('Different browser')$q$,'23505');
select pg_temp.wake_error($q$select pg_temp.profile_create('')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.profile_create(E'line\nsecret')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.profile_create(repeat('a',81))$q$,'22023');
select pg_temp.wake_assert(pg_temp.profile_status()->'grant'='null'::jsonb,'no implicit consent');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.profile_catalog()->'profiles')=1,'profile discovered after reply loss');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001'); set local role authenticated;
-- The owner of record sees the company-owned agent profiles (2026-09-17 company browser); another member's own
-- profile is never among them.
select pg_temp.wake_assert(not exists(select 1 from jsonb_array_elements(pg_temp.profile_catalog()->'profiles') item
	where item->>'profileId'='36000000-0000-4000-8000-000000000001' or item->>'label'='Work browser'),'company owner cannot enumerate another browser owner');
-- The owner of record is listed for this office only through the company-owned profiles held in their name;
-- the entry carries the office scope alone and nothing of the other member or their profile.
select pg_temp.wake_assert(public.qorpera_member_browser_recovery()->'offices'=jsonb_build_array(jsonb_build_object(
	'scope',current_setting('qorpera_test.office_scope')::jsonb,'ownsPrivacy',false))
	and public.qorpera_member_browser_recovery()::text not like '%36000000-0000-4000-8000-000000000001%'
	and public.qorpera_member_browser_recovery()::text not like '%30000000-0000-4000-8000-000000000003%','account cleanup cannot enumerate another browser owner');
select pg_temp.wake_error($q$select pg_temp.profile_status()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.profile_create()$q$,'42501');
reset role;
-- A member who owns no profile here still gets nothing at all, whoever else has one.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_catalog()->'profiles'='[]'::jsonb,'another member cannot enumerate another browser owner');
select pg_temp.wake_assert(public.qorpera_member_browser_recovery()->'offices'='[]'::jsonb,'account cleanup of another member cannot enumerate another browser owner');
reset role;

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select set_config('qorpera_test.browser_privacy',pg_temp.profile_privacy(true,0)::text,true);
select pg_temp.wake_assert(pg_temp.profile_catalog()#>>'{profiles,0,version}'='2','sign-in advances profile incarnation');
select pg_temp.wake_assert(pg_temp.profile_catalog()#>>'{profiles,0,prepared}'='false','request alone does not prepare profile');
select pg_temp.wake_error($q$select pg_temp.profile_grant(true,0)$q$,'42501');
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.browser_privacy')::jsonb)$q$,'42501');
select pg_temp.profile_ack(current_setting('qorpera_test.browser_privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.browser_privacy')::jsonb);
reset role;
-- Preparation requires the owner's redeemed private viewer (20260913000300 preparation evidence), so the
-- owner really opens the private surface: actual ticket issuance and gateway redemption, as in the privacy cases.
do $$ declare challenge jsonb:=current_setting('qorpera_test.browser_privacy')::jsonb; binding jsonb; epoch bigint; ticket jsonb; begin
 select public.qorpera_runtime_office_scope(o)||jsonb_build_object('computerGeneration',o.generation,
  'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id),s.epoch
 into binding,epoch from public.qorpera_runtime_offices o join public.qorpera_runtime_office_screens s on s.office_id=o.id
 where s.id=(challenge->>'screenId')::uuid;
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
 ticket:=public.qorpera_create_runtime_office_viewer(binding,epoch,'control',challenge);
 perform pg_temp.path_claims('service_role');
 perform pg_temp.profile_ack(public.qorpera_runtime_office_supervisor_status(challenge->'scope',(challenge->>'computerGeneration')::bigint)->'drains');
 perform public.qorpera_redeem_runtime_office_viewer(challenge->'scope',encode(extensions.digest(ticket->>'capability','sha256'),'hex'));
end $$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.browser_privacy')::jsonb);
select set_config('qorpera_test.browser_privacy',pg_temp.profile_privacy(false,1)::text,true);
select pg_temp.wake_assert(pg_temp.profile_catalog()#>>'{profiles,0,prepared}'='false','exit intent is not preparation proof');
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.profile_ack(current_setting('qorpera_test.browser_privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.browser_privacy')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_catalog()#>>'{profiles,0,prepared}'='true','acknowledged private lifecycle prepares the exact profile');
select set_config('qorpera_test.browser_change',pg_temp.profile_grant(true,0)::text,true);
select pg_temp.wake_assert(pg_temp.profile_status()#>>'{grant,state}'='active' and pg_temp.profile_status()#>>'{grant,usable}'='false','configured consent waits for drain');
select pg_temp.wake_error($q$select pg_temp.profile_grant(true,0)$q$,'PGRST');
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.profile_ack(current_setting('qorpera_test.browser_change')::jsonb->'drains');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_status()#>>'{grant,usable}'='true','current acknowledged consent is usable');
select pg_temp.wake_assert(pg_temp.profile_catalog()#>>'{profiles,0,activeStaffAgentId}'='30000000-0000-4000-8000-000000000030','owner can discover an existing assignment for revocation');
reset role;

savepoint member_removed;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000003';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_catalog()->>'canUse'='false','removed owner can recover own cleanup metadata only');
select pg_temp.wake_assert(public.qorpera_member_browser_recovery()#>'{offices,0,scope}'=current_setting('qorpera_test.office_scope')::jsonb,
 'removed owner discovers own cleanup without company membership');
select pg_temp.wake_assert(public.qorpera_member_browser_recovery((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid)->'offices'='[]'::jsonb,'cleanup cursor excludes observed office');
select pg_temp.wake_assert(pg_temp.profile_status()#>>'{grant,usable}'='false','removal makes old consent unusable');
select pg_temp.wake_error($q$select pg_temp.profile_grant(true,1)$q$,'42501');
select pg_temp.profile_grant(false,1);
select pg_temp.wake_assert(pg_temp.profile_status()#>>'{grant,state}'='revoked','removed owner can revoke exact consent');
reset role; rollback to savepoint member_removed;

savepoint incarnation_changed;
insert into public.qorpera_runtime_browser_membership_revocations(profile_id,user_id,version)
 values('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000003',1)
 on conflict(profile_id,user_id) do update set version=qorpera_runtime_browser_membership_revocations.version+1;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(pg_temp.profile_status()#>>'{grant,state}'='active' and pg_temp.profile_status()#>>'{grant,usable}'='false','rejoined membership never silently revives consent');
reset role; rollback to savepoint incarnation_changed;

-- More than one bounded page, with no profile belonging to another member.
insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id,label)
 select ('36000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 (current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,'30000000-0000-4000-8000-000000000003','Additional browser'
 from generate_series(100,149) n;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.profile_catalog()->'profiles')=50 and pg_temp.profile_catalog()->>'nextAfter'='36000000-0000-4000-8000-000000000148','bounded ordered profile page');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.profile_catalog('36000000-0000-4000-8000-000000000148')->'profiles')=1
 and pg_temp.profile_catalog('36000000-0000-4000-8000-000000000148')->'nextAfter'='null'::jsonb,'profile continuation');
reset role;
do $$ declare f regprocedure; r text; begin
 foreach f in array array['public.qorpera_create_member_browser_profile(jsonb,uuid,text)'::regprocedure,
 'public.qorpera_member_browser_profiles(jsonb,uuid)'::regprocedure,'public.qorpera_member_browser_grant_status(jsonb,uuid,uuid)'::regprocedure,
 'public.qorpera_member_browser_recovery(uuid)'::regprocedure] loop
  perform pg_temp.wake_assert(has_function_privilege('authenticated',f,'EXECUTE'),'member RPC grant');
  foreach r in array array['anon','service_role','qorpera_secret_broker'] loop perform pg_temp.wake_assert(not has_function_privilege(r,f,'EXECUTE'),'private member RPC');end loop;
 end loop;
end $$;
