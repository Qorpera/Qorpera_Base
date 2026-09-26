-- @fixture 641_paid_office_lifecycle.test.sql until "-- Close the initial guard"
-- Real funded prepare/bind; physical stop evidence and the already verified
-- guest activation are fixtures. No provider or payment network is contacted.
do $$ declare r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; sample jsonb; initial jsonb; begin
    initial:=pg_temp.prepare_runtime(r,repeat('O',64))-'runtimeContext'-'closure';
    perform pg_temp.wake_assert((initial->>'validForMs')::bigint>300000,'Fixture must retain the full stopping margin');
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values('64100000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000310','64700000-0000-4000-8000-000000000030','{}');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',r->'hostBootId',
        'hostUptimeMs',100000,'physicalId','64700000-0000-4000-8000-000000000030','guestBootId','64700000-0000-4000-8000-000000000031',
        'guestUptimeMs',10000,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('a',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',r->'requestId','generation',1,'sample',sample),repeat('O',64));
    perform set_config('qorpera_test.outage_initial',initial::text,true);
    perform set_config('qorpera_test.outage_sample',sample::text,true);
end $$;
insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
    provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,
    attestation,mappings,state,service_invocation_id,ready_at,activated_at)
values('64100000-0000-4000-8000-000000000002','64700000-0000-4000-8000-000000000020',(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1,
    '64100000-0000-4000-8000-000000000004','64100000-0000-4000-8000-000000000003',repeat('f',64),repeat('e',64),repeat('d',64),repeat('a',64),repeat('b',64),
    jsonb_build_object('schema','qorpera.office-activation-attestation/v1','activationId','64700000-0000-4000-8000-000000000020',
        'bootId','64700000-0000-4000-8000-000000000031','preparationObservationSha256',repeat('1',64),
        'configurationObservationSha256',repeat('2',64),'configurationSha256',repeat('3',64),'adoptionReceiptSha256',repeat('4',64),'nativePort',18000,'viewerPort',18001),
    '[]','active',repeat('1',32),clock_timestamp(),clock_timestamp());
update public.qorpera_runtime_offices set state='active',privacy_state='entering',privacy_version=4,
    privacy_challenge='{"challengeId":"64700000-0000-4000-8000-000000000041","state":"entering"}'
    where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
insert into public.qorpera_runtime_office_access(office_id,staff_agent_id,profile_id,state,capabilities,configured_by_user_id)
    select (current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,staff_agent_id,profile_id,'active','["shell"]',
        '30000000-0000-4000-8000-000000000001' from public.qorpera_profile_staff
    where profile_id='30000000-0000-4000-8000-000000000010' limit 2 on conflict do nothing;
insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id,power)
    select office_id,row_number() over(order by staff_agent_id),staff_agent_id,'open' from public.qorpera_runtime_office_access
    where office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
update public.qorpera_runtime_office_screens set epoch=7,drain_pending=true,drain_id='64700000-0000-4000-8000-000000000042'
    where office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid and ordinal=1;
insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id)
    values('64700000-0000-4000-8000-000000000043',(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
        '30000000-0000-4000-8000-000000000001');
insert into public.qorpera_runtime_office_viewers(office_id,screen_id,member_id,membership_version,binding,screen_epoch,privacy_version,
    mode,capability_sha256,state,expires_at,absolute_deadline)
    select office_id,id,'30000000-0000-4000-8000-000000000001',1,'{}',epoch,4,'watch',repeat('7',64),'active',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '2 minutes'
    from public.qorpera_runtime_office_screens where office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid and ordinal=1;
do $$ declare scope jsonb:=current_setting('qorpera_test.office_scope')::jsonb; p jsonb:=current_setting('qorpera_test.outage_initial')::jsonb; activation jsonb; begin
    activation:=public.qorpera_runtime_office_provider_activation(scope,1,'64100000-0000-4000-8000-000000000003',repeat('f',64))->'activation';
    perform set_config('qorpera_test.outage_request',jsonb_build_object('schema','qorpera.office-computer-outage-request/v1',
        'requestId','64700000-0000-4000-8000-000000000050','activation',activation,'guard',jsonb_build_object('permit',p,
        'hostMachineIdSha256',repeat('c',64),'physicalInstanceId','64700000-0000-4000-8000-000000000030',
        'startOperationId','64700000-0000-4000-8000-000000000051','startDispatched',true,'startSettled',true,'startSucceeded',true,
        'stopReceipt',jsonb_build_object('permitId',p->'permitId','generation',1,'allocationId',p->'allocationId','instanceSha256',p->'instanceSha256',
            'physicalInstanceId','64700000-0000-4000-8000-000000000030','hostBootId',p->'hostBootId','observedUptimeMs',400000,'closedAtUptimeMs',400100,
            'closedHostBootId',p->'hostBootId','state','stopped','operationId','64700000-0000-4000-8000-000000000052')))::text,true);
end $$;
savepoint outage_cases;
do $$ declare r jsonb:=current_setting('qorpera_test.outage_request')::jsonb; receipt jsonb; office uuid:=(r#>>'{activation,startup,scope,companyComputerId}')::uuid;
    v_revision bigint; privacy jsonb; balance jsonb; snapshot jsonb; profiles jsonb; stop_count bigint;
begin
    select o.revision,jsonb_build_array(privacy_state,privacy_version,privacy_challenge) into v_revision,privacy from public.qorpera_runtime_offices o where id=office;
    select jsonb_agg(to_jsonb(b) order by id) into balance from public.qorpera_computer_allowance_buckets b;
    select jsonb_agg(to_jsonb(b) order by id) into profiles from public.qorpera_runtime_browser_profiles b where office_id=office;
    select count(*) into stop_count from public.qorpera_runtime_office_stops;
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,null)',r),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',jsonb_set(r,'{guard,startSettled}','false'),repeat('O',64)),'22023');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',jsonb_set(r,'{activation,startup,bootId}',to_jsonb(extensions.gen_random_uuid())),repeat('O',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',jsonb_set(r,'{guard,permit,prestart,prepareSha256}',to_jsonb(repeat('9',64))),repeat('O',64)),'42501');
    begin
        update public.qorpera_runtime_computer_host_keys set revoked_at=clock_timestamp() where provider_kind='office';
        perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r,repeat('O',64)),'42501');
        raise exception using errcode='QT647';
    exception when sqlstate 'QT647' then null; end;
    begin
        update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=(r#>>'{activation,activationId}')::uuid;
        perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r,repeat('O',64)),'42501');
        raise exception using errcode='QT647';
    exception when sqlstate 'QT647' then null; end;
    perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r,repeat('O',64)),'42501');
    perform pg_temp.path_claims('service_role');
    receipt:=public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='held' and receipt->'request'=r and (receipt->>'officeRevision')::bigint=v_revision+1,'Outage receipt differs');
    perform pg_temp.wake_assert((select state='maintenance' and o.revision=v_revision+1 and jsonb_build_array(privacy_state,privacy_version,privacy_challenge)=privacy
        from public.qorpera_runtime_offices o where id=office),'Outage lost privacy state or failed to revoke');
    perform pg_temp.wake_assert((select count(*)>0 and bool_and(drain_pending and lease_id is null) from public.qorpera_runtime_office_screens where office_id=office)
        and (select epoch=7 and drain_id='64700000-0000-4000-8000-000000000042' from public.qorpera_runtime_office_screens where office_id=office and ordinal=1)
        and (select bool_and(state='draining') from public.qorpera_runtime_office_viewers where office_id=office),'Outage replaced drain challenge or retained viewer admission');
    perform pg_temp.wake_assert((select jsonb_agg(to_jsonb(b) order by id)=profiles from public.qorpera_runtime_browser_profiles b where office_id=office)
        and not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions where office_id=office)
        and (select count(*)=stop_count from public.qorpera_runtime_office_stops)
        and (select released_at is null from public.qorpera_runtime_machine_allocations where id=(r#>>'{activation,startup,allocationId}')::uuid)
        and (select jsonb_agg(to_jsonb(b) order by id)=balance from public.qorpera_computer_allowance_buckets b),'Outage fabricated cleanup or altered allowance/capacity');
    perform pg_temp.wake_assert(public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64))=receipt,'Lost report reply was not idempotent');
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=(r#>>'{activation,activationId}')::uuid;
    update public.qorpera_runtime_offices set state='active',revision=o.revision+5 from public.qorpera_runtime_offices o where public.qorpera_runtime_offices.id=office and o.id=office;
    select to_jsonb(o) into snapshot from public.qorpera_runtime_offices o where id=office;
    perform pg_temp.wake_assert(public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64))=receipt
        and (select to_jsonb(o)=snapshot from public.qorpera_runtime_offices o where id=office),'Historical replay mutated successor state');
end $$;
rollback to savepoint outage_cases;
-- A renewal reply may be lost, and normal accounting may archive the guard
-- before the office loop reports its outage. Neither changes the stop proof.
do $$ declare r jsonb:=current_setting('qorpera_test.outage_request')::jsonb; sample jsonb:=current_setting('qorpera_test.outage_sample')::jsonb; receipt jsonb; begin
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100100,'guestUptimeMs',10100,'observedAt',(sample->>'observedAt')::timestamptz+interval '100 milliseconds');
    perform public.qorpera_renew_runtime_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
        'permitId',r#>'{guard,permit,permitId}','generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000),repeat('O',64));
    begin
        receipt:=public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64));
        perform pg_temp.wake_assert(receipt->>'state'='held','Lost renewal prevented outage registration');
        raise exception using errcode='QT647';
    exception when sqlstate 'QT647' then null; end;
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100200,'guestUptimeMs',null,'state','stopped','observedAt',(sample->>'observedAt')::timestamptz+interval '100 milliseconds');
    perform public.qorpera_finish_runtime_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
        'permitId',r#>'{guard,permit,permitId}','generation',2,'sample',sample,'guardClosed',true),repeat('O',64));
    receipt:=public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='held','Settled successor prevented original stop outage registration');
end $$;
rollback to savepoint outage_cases;
-- Graceful shutdown wins the race before outage submission. A pending drain
-- is insufficient; only the actual retained acknowledgement enables orderly.
do $$ declare r jsonb:=current_setting('qorpera_test.outage_request')::jsonb; transition jsonb; t uuid:=extensions.gen_random_uuid(); challenge uuid:=extensions.gen_random_uuid(); receipt jsonb; issued_at timestamptz:=clock_timestamp(); begin
    transition:=r->'activation'||jsonb_build_object('schema','qorpera.office-lifecycle-request/v1','transitionId',t,'action','power_off');
    perform public.qorpera_begin_runtime_office_lifecycle(transition);
    perform pg_temp.wake_error(format('select public.qorpera_register_runtime_office_computer_outage(%L,%L)',r,repeat('O',64)),'42501');
    insert into public.qorpera_runtime_office_stop_challenges(id,transition_id,command,start_completion_sha256,office_revision,privacy_version,drains,issued_at,expires_at)
        select challenge,t,'{}',repeat('5',64),revision,privacy_version,'[]',issued_at,issued_at+interval '5 seconds'
        from public.qorpera_runtime_offices where id=(r#>>'{activation,startup,scope,companyComputerId}')::uuid;
    insert into public.qorpera_runtime_office_stops(transition_id,challenge_id,inspection) values(t,challenge,'{}');
    -- An orderly reset may already have deleted the old physical binding.
    delete from public.qorpera_runtime_node_instance_bindings where allocation_id=(r#>>'{activation,startup,allocationId}')::uuid;
    receipt:=public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='orderly' and public.qorpera_register_runtime_office_computer_outage(r,repeat('O',64))=receipt,
        'Real orderly shutdown was converted into a forced-stop hold');
end $$;
do $$ declare role_name text; helper regprocedure; owner oid; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(role_name,'public.qorpera_runtime_office_computer_outages','SELECT,INSERT,UPDATE,DELETE'),'Outage table exposed');
        if role_name<>'service_role' then
            perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_register_runtime_office_computer_outage(jsonb,text)','EXECUTE'),'Outage RPC exposed');
        end if;
    end loop;
    select proowner into owner from pg_proc where oid='public.qorpera_register_runtime_office_computer_outage(jsonb,text)'::regprocedure;
    foreach helper in array array['public.qorpera_runtime_computer_permit_host(uuid,text)'::regprocedure,
        'public.qorpera_assert_runtime_office_lifecycle_request(jsonb)'::regprocedure,
        'public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)'::regprocedure,
        'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure] loop
        perform pg_temp.wake_assert(has_function_privilege(owner,helper,'EXECUTE'),'Outage definer lost private helper access');
    end loop;
end $$;
rollback;
