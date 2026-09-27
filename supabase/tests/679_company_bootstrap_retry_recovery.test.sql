-- @fixture 310_company_organization_kernel.test.sql until "select set_config('qorpera_test.bootstrap_result'"
-- The fixture uses real creation, claim, staging and verification RPCs. Storage
-- metadata represents exact immutable bytes; no external filesystem is tested.
-- Only the retry count and lease clock below are accelerated test fixtures.
reset role;

create function pg_temp.retry_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
    if p_ok is distinct from true then raise exception '%',p_message; end if;
end $$;

create function pg_temp.retry_finalize(p_worker uuid)
returns jsonb language sql as $$
    select public.qorpera_finalize_company_bootstrap(
        (current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId')::uuid,p_worker,
        current_setting('qorpera_test.bootstrap_document'),current_setting('qorpera_test.bootstrap_file_manifest'),
        current_setting('qorpera_test.bootstrap_agent_manifest'),current_setting('qorpera_test.bootstrap_tree'),
        jsonb_build_object('organization/formation.json',current_setting('qorpera_test.bootstrap_document'),
            'organization/agents/'||(current_setting('qorpera_test.bootstrap_claim')::jsonb->>'cofounderStaffAgentId')||'.json',
            current_setting('qorpera_test.bootstrap_agent_document')))
$$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.later_company',public.qorpera_create_cloud_company(
    '67900000-0000-4000-8000-000000000010','Later bootstrap retry fixture',2)::text,true);
reset role;

update public.qorpera_company_bootstrap_jobs set attempt=1000,
    lease_expires_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '1 day'
    where id=(current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId')::uuid;
select set_config('qorpera_test.exhausted_job',(select to_jsonb(job)::text
    from public.qorpera_company_bootstrap_jobs job
    where id=(current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId')::uuid),true);

-- The original cap makes both claims fail with 23514, leaving the same oldest
-- job and the later company stuck. The fixed schema must reclaim that job.
select pg_temp.org_claims('service_role');
set local role service_role;
do $$ declare claim jsonb; n integer;
begin
    for n in 1..2 loop
        begin
            claim:=public.qorpera_claim_company_bootstrap('67900000-0000-4000-8000-000000000001',300);
            exit;
        exception when check_violation then
            if n=2 then raise; end if;
        end;
    end loop;
    perform pg_temp.retry_assert(claim->>'jobId'=current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId',
        'Exhausted setup was replaced or skipped instead of resumed');
    perform pg_temp.retry_assert(claim-array['leaseOwner','leaseExpiresAt'] =
        current_setting('qorpera_test.bootstrap_claim')::jsonb-array['leaseOwner','leaseExpiresAt'],
        'Recovery changed frozen company, founder, document or base identities');
    begin
        perform pg_temp.retry_finalize(current_setting('qorpera_test.bootstrap_worker')::uuid);
        raise exception 'Expired worker finalized a reclaimed bootstrap';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_stage_company_bootstrap_object((claim->>'jobId')::uuid,
            current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_content',
            current_setting('qorpera_test.bootstrap_content_sha'),octet_length(current_setting('qorpera_test.bootstrap_document')),true);
        raise exception 'Expired worker staged a reclaimed bootstrap';
    exception when insufficient_privilege then null; end;
    perform set_config('qorpera_test.recovered_claim',claim::text,true);
end $$;
reset role;
do $$ declare original jsonb:=current_setting('qorpera_test.exhausted_job')::jsonb; recovered jsonb;
begin
    select to_jsonb(job) into strict recovered from public.qorpera_company_bootstrap_jobs job where id=(original->>'id')::uuid;
    perform pg_temp.retry_assert(recovered->>'attempt'='1001' and recovered->>'state'='leased'
        and recovered-array['attempt','lease_owner','lease_expires_at','updated_at'] =
            original-array['attempt','lease_owner','lease_expires_at','updated_at'],
        'Recovery reset the attempt, staged object pins or frozen job identity');
end $$;

-- A later company remains claimable while the recovered setup holds its lease.
select pg_temp.org_claims('service_role');
set local role service_role;
select pg_temp.retry_assert(public.qorpera_claim_company_bootstrap('67900000-0000-4000-8000-000000000002',300)->>'profileId'
    =current_setting('qorpera_test.later_company')::jsonb->>'profile_id','Old job starved the later company');
reset role;

-- Queued upgrades use the same monotonic attempt sequence; never reset or
-- saturate it because governed publication operation keys include this value.
update public.qorpera_company_bootstrap_jobs set state='queued',lease_owner=null,lease_expires_at=null
    where id=(current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId')::uuid;
select pg_temp.org_claims('service_role');
set local role service_role;
select pg_temp.retry_assert(public.qorpera_claim_company_bootstrap('67900000-0000-4000-8000-000000000003',300)->>'jobId'
    =current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId','Queued setup could not continue after recovery');
select set_config('qorpera_test.bootstrap_result',pg_temp.retry_finalize('67900000-0000-4000-8000-000000000003')::text,true);
-- Losing the committed finalization reply must replay the same receipt even
-- after its lease has been cleared, without another snapshot or kickoff.
select pg_temp.retry_assert(pg_temp.retry_finalize('67900000-0000-4000-8000-000000000003')
    =current_setting('qorpera_test.bootstrap_result')::jsonb,'Committed bootstrap finalization did not replay');
reset role;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare replay jsonb; original jsonb:=current_setting('qorpera_test.org_company')::jsonb;
    claim jsonb:=current_setting('qorpera_test.bootstrap_claim')::jsonb;
begin
    replay:=public.qorpera_create_cloud_company('31000000-0000-4000-8000-000000000010','Organization kernel fixture',2);
    perform pg_temp.retry_assert(replay->>'profile_id'=original->>'profile_id' and replay->>'environment_id'=original->>'environment_id'
        and replay#>>'{organization,cofounder,staff_agent_id}'=claim->>'cofounderStaffAgentId'
        and replay#>>'{organization,cofounder,formation_id}'=claim->>'formationId'
        and replay#>>'{organization,cofounder,member_session_id}'=claim->>'memberSessionId'
        and replay->>'bootstrap_state'='completed',
        'Founders could not resume the same creation after exhausted-job recovery');
end $$;
reset role;

do $$ declare job public.qorpera_company_bootstrap_jobs%rowtype;
begin
    select * into strict job from public.qorpera_company_bootstrap_jobs
        where id=(current_setting('qorpera_test.bootstrap_claim')::jsonb->>'jobId')::uuid;
    perform pg_temp.retry_assert(job.attempt=1002 and job.state='completed' and job.lease_owner is null
        and job.output_snapshot_id=(current_setting('qorpera_test.bootstrap_result')::jsonb->>'snapshotId')::uuid
        and (select count(*)=1 from public.qorpera_company_snapshots where profile_id=job.profile_id)
        and (select count(*)=1 from public.qorpera_company_first_runs where profile_id=job.profile_id)
        and (select count(*)=1 from public.qorpera_agent_first_runs where profile_id=job.profile_id)
        and (select count(*)=1 from public.qorpera_session_inputs where session_id=job.member_session_id and kind='kickoff')
        and (select count(*)=1 from public.qorpera_company_cofounders where profile_id=job.profile_id),
        'Recovered bootstrap duplicated or orphaned its canonical objects or first run');
    begin
        update public.qorpera_company_bootstrap_jobs set attempt=-1 where id=job.id;
        raise exception 'Negative bootstrap attempt was accepted';
    exception when check_violation then null; end;
end $$;

-- The internal counter is not exposed in claims. Crossing the former integer
-- boundary must still obtain a new lease without recycling operation identity.
update public.qorpera_company_bootstrap_jobs set attempt=2147483647,
    lease_expires_at=clock_timestamp()-interval '1 second'
    where profile_id=(current_setting('qorpera_test.later_company')::jsonb->>'profile_id')::uuid;
select pg_temp.org_claims('service_role');
set local role service_role;
select pg_temp.retry_assert(public.qorpera_claim_company_bootstrap('67900000-0000-4000-8000-000000000004',300)->>'profileId'
    =current_setting('qorpera_test.later_company')::jsonb->>'profile_id','Claim overflowed the former integer boundary');
reset role;
select pg_temp.retry_assert((select attempt=2147483648 and lease_owner='67900000-0000-4000-8000-000000000004'
    from public.qorpera_company_bootstrap_jobs
    where profile_id=(current_setting('qorpera_test.later_company')::jsonb->>'profile_id')::uuid),
    'Claim recycled the operation sequence at the former integer boundary');

do $$ declare signature text; role_name text;
begin
    foreach signature in array array['public.qorpera_claim_company_bootstrap(uuid,integer)',
        'public.qorpera_stage_company_bootstrap_object(uuid,uuid,text,text,bigint,boolean,text)',
        'public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb)'] loop
        perform pg_temp.retry_assert(has_function_privilege('service_role',signature,'EXECUTE'),
            'Bootstrap worker lost its RPC authority');
        foreach role_name in array array['anon','authenticated'] loop
            perform pg_temp.retry_assert(not has_function_privilege(role_name,signature,'EXECUTE'),
                'Bootstrap worker RPC was exposed to a member');
        end loop;
    end loop;
    foreach role_name in array array['anon','authenticated','service_role'] loop
        perform pg_temp.retry_assert(not has_table_privilege(role_name,'public.qorpera_company_bootstrap_jobs','SELECT,INSERT,UPDATE,DELETE'),
            'Bootstrap jobs were exposed for direct access');
    end loop;
end $$;
set constraints all immediate;
rollback;
