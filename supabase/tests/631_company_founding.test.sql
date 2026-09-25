-- @fixture 310_company_organization_kernel.test.sql until "-- A coworker is created, archived"
-- Canonical bootstrap above uses the real gateway staging/finalization RPCs.
-- Provider credentials below are sealed-object fixtures; no provider is called.
reset role;
update auth.users set email_confirmed_at = now() where id in
    ('31000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000003');
create function pg_temp.founding_profile() returns uuid language sql as $$
    select (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
$$;
create function pg_temp.founding_revision() returns bigint language sql as $$
    select (public.qorpera_read_company_founding(pg_temp.founding_profile()) ->> 'revision')::bigint
$$;
create function pg_temp.founding_denied(p_sql text,p_code text) returns void language plpgsql as $$
begin
    begin execute p_sql; exception when others then
        if sqlstate = p_code then return; end if; raise;
    end;
    raise exception 'Expected rejection % for %',p_code,p_sql;
end $$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
-- The older canonical creation RPC cannot bypass verified Ready/Start.
update auth.users set email_confirmed_at = null where id = '31000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.founding_denied(format('select public.qorpera_set_founder_ready(%L,%s,true,'''')',
    pg_temp.founding_profile(),pg_temp.founding_revision()),'42501');
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'42501');
reset role;
update auth.users set email_confirmed_at = now() where id = '31000000-0000-4000-8000-000000000001';
set local role authenticated;
-- A stale/unrelated creation API cannot create an unheld "legacy" company.
select pg_temp.founding_denied('select public.qorpera_create_hosted_profile(''Bypass'',''main'',2)','42501');
select set_config('qorpera_test.founding_retry',public.qorpera_begin_company_founding(
    '63100000-0000-4000-8000-000000000010','Idempotent founding',2)::text,true);
do $$ declare v_retry jsonb; begin
    v_retry := public.qorpera_begin_company_founding('63100000-0000-4000-8000-000000000010','Idempotent founding',2);
    if v_retry ->> 'profile_id' is distinct from current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id' then
        raise exception 'Creation retry produced another company'; end if;
    if public.qorpera_read_company_founding((v_retry ->> 'profile_id')::uuid) ->> 'phase' <> 'open' then
        raise exception 'Creation bypassed founding'; end if;
end $$;
select pg_temp.founding_denied('select public.qorpera_begin_company_founding(''63100000-0000-4000-8000-000000000010'',''Different'',2)','23505');
select pg_temp.founding_denied(format('select public.qorpera_invite_company_founder(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),'31000000-0000-4000-8000-000000000002'),'42501');
reset role;
insert into public.qorpera_friendships(user_low,user_high,requested_by,status) values
    ('31000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000001','accepted');
set local role authenticated;
select public.qorpera_invite_company_founder(pg_temp.founding_profile(),pg_temp.founding_revision(),'31000000-0000-4000-8000-000000000002');
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
    if jsonb_array_length(public.qorpera_list_company_founding_invitations()) <> 1 then
        raise exception 'Founder invitation not discoverable'; end if;
end $$;
select public.qorpera_respond_company_founding(pg_temp.founding_profile(),true);
select public.qorpera_respond_company_founding(pg_temp.founding_profile(),true);
select pg_temp.founding_denied(format('select public.qorpera_set_founder_ready(%L,%s,true,'''')',
    pg_temp.founding_profile(),pg_temp.founding_revision()),'55000');
reset role;
do $$ begin
    if (select role from public.qorpera_profile_members where profile_id = pg_temp.founding_profile()
        and user_id = '31000000-0000-4000-8000-000000000002') <> 'contributor' then
        raise exception 'Invited founder became owner before launch'; end if;
end $$;

-- Each member separately connects their own model account; no pool candidates.
do $$ declare v_user uuid; v_identity uuid; v_login jsonb; v_connection jsonb; begin
    foreach v_user in array array['31000000-0000-4000-8000-000000000001'::uuid,'31000000-0000-4000-8000-000000000002'::uuid] loop
        perform pg_temp.org_claims('authenticated',v_user);
        v_identity := (public.qorpera_upsert_member_compute_identity(pg_temp.founding_profile(),extensions.gen_random_uuid(),
            'Own model','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
        v_login := public.qorpera_begin_native_provider_login(pg_temp.founding_profile(),extensions.gen_random_uuid(),
            extensions.gen_random_uuid(),v_identity,'openai','codex-cli',repeat('a',64),900);
        perform pg_temp.org_claims('service_role');
        v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat('a',64),
            extensions.gen_random_uuid(),'object://founding/' || v_user,repeat('b',64),'fixture-account',
            'personal-subscription','qorpera-native-provider-consent/v1',
            '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
        perform pg_temp.org_claims('authenticated',v_user);
        perform public.qorpera_create_member_execution_sponsor(pg_temp.founding_profile(),extensions.gen_random_uuid(),
            (v_connection ->> 'connection_id')::uuid,1,false);
    end loop;
end $$;

-- Automatic first-run release is held, and a direct queued-turn insertion is
-- refused at the same database boundary even with valid account identities.
do $$ declare v_first public.qorpera_company_first_runs%rowtype; v_sponsor jsonb; begin
    select * into strict v_first from public.qorpera_company_first_runs where profile_id = pg_temp.founding_profile();
    v_sponsor := public.qorpera_member_first_run_sponsor(pg_temp.founding_profile(),'31000000-0000-4000-8000-000000000001');
    if public.qorpera_queue_agent_first_run(v_first.profile_id,v_first.cofounder_staff_agent_id,v_sponsor) is not null then
        raise exception 'Bootstrap escaped founding hold'; end if;
    perform pg_temp.founding_denied(format($q$insert into public.qorpera_session_turn_requests
        (profile_id,session_id,client_request_id,input_id,requested_by_user_id,sponsor_mode,sponsor_binding_id,sponsor_version,
        sponsored_by_user_id,compute_identity_id,worker_class,required_capability,job_type,publication_mode,status,sponsored_at)
        values(%L,%L,%L,%L,%L,'member_connection',%L,%s,%L,%L,'managed_sandbox','agent_turn','agent_turn','automatic','queued',now())$q$,
        v_first.profile_id,v_first.session_id,extensions.gen_random_uuid(),v_first.input_id,'31000000-0000-4000-8000-000000000001',
        v_sponsor ->> 'sponsorBindingId',v_sponsor ->> 'sponsorVersion','31000000-0000-4000-8000-000000000001',
        v_sponsor ->> 'computeIdentityId'),'55000');
end $$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_founder_ready(pg_temp.founding_profile(),pg_temp.founding_revision(),true,'Product');
select set_config('qorpera_test.founding_old_revision',pg_temp.founding_revision()::text,true);
select public.qorpera_update_company_founding(pg_temp.founding_profile(),pg_temp.founding_revision(),'Shared company','Build useful company software');
select pg_temp.founding_denied(format('select public.qorpera_set_founder_ready(%L,%s,true,'''')',
    pg_temp.founding_profile(),current_setting('qorpera_test.founding_old_revision')),'PT412');
select public.qorpera_set_founder_ready(pg_temp.founding_profile(),pg_temp.founding_revision(),true,'Product');
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'55000');
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_set_founder_ready(pg_temp.founding_profile(),pg_temp.founding_revision(),true,'Engineering');
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'55000');
reset role;
-- Computer capacity supplied by A; model execution belongs to launcher B.
insert into public.qorpera_account_entitlements(user_id,plan_key,billing_mode,feature_set,storage_allocation,operator_reference,reason)
    values('31000000-0000-4000-8000-000000000001','internal','complimentary','all','unlimited','fixture','test computer capacity');
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),true);
reset role;
-- Ready is consent, not a permanently valid model credential. Revocation of
-- the other founder's identity blocks launch without switching its sponsor.
update public.qorpera_member_compute_identities set status = 'disabled'
    where profile_id = pg_temp.founding_profile() and owner_user_id = '31000000-0000-4000-8000-000000000001';
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'55000');
reset role;
update public.qorpera_member_compute_identities set status = 'active'
    where profile_id = pg_temp.founding_profile() and owner_user_id = '31000000-0000-4000-8000-000000000001';
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.founding_launch',public.qorpera_launch_company_founding(
    pg_temp.founding_profile(),pg_temp.founding_revision(),'63100000-0000-4000-8000-000000000099')::text,true);
do $$ declare v_retry jsonb; begin
    v_retry := public.qorpera_launch_company_founding(pg_temp.founding_profile(),0,extensions.gen_random_uuid());
    if v_retry -> 'launch' is distinct from current_setting('qorpera_test.founding_launch')::jsonb -> 'launch' then
        raise exception 'Another tab produced a second launch receipt'; end if;
end $$;
reset role;
do $$ declare v_request public.qorpera_session_turn_requests%rowtype; begin
    select * into strict v_request from public.qorpera_session_turn_requests
        where id = (current_setting('qorpera_test.founding_launch')::jsonb #>> '{launch,turnRequestId}')::uuid;
    if v_request.requested_by_user_id <> '31000000-0000-4000-8000-000000000002'::uuid
        or v_request.sponsored_by_user_id <> v_request.requested_by_user_id
        or (select author_user_id from public.qorpera_session_inputs where id = v_request.input_id)
            <> '31000000-0000-4000-8000-000000000001'::uuid then
        raise exception 'Computer contribution changed model account or historical authorship'; end if;
    if (select count(*) from public.qorpera_profile_members where profile_id = pg_temp.founding_profile() and role = 'owner') <> 2 then
        raise exception 'Launch did not establish both owners'; end if;
    perform pg_temp.founding_denied(format('update public.qorpera_company_founding set launch_receipt=''{}'' where profile_id=%L',
        pg_temp.founding_profile()),'42501');
end $$;
-- Noncreator launch queued; provenance/materialization tests extend this fixture.
set constraints all immediate;
rollback;
