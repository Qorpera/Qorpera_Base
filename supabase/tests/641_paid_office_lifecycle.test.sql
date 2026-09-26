-- @fixture 638_paid_computer_admission_boundaries.test.sql until "-- A new owner-authenticated coding turn"
-- A real durable guard supplies this non-secret, byte-bound intent before prepare.
create function pg_temp.prestart_request(p_request jsonb) returns jsonb language plpgsql as $$
declare v_base jsonb; v_text text;
begin
    v_base:=(p_request-'prestart'-'prepareRequestText')||jsonb_build_object('schema',case when p_request ? 'usageProducer' then 'qorpera.runtime-computer-prepare/v3' else 'qorpera.runtime-computer-prepare/v2' end);
    v_text:=(v_base-'leaseToken')::text;
    return v_base||jsonb_build_object('prepareRequestText',v_text,'prestart',jsonb_build_object(
        'guardIncarnationId','64200000-0000-4000-8000-000000000001',
        'prepareSha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex')));
end $$;
-- Operator-only historical fixture: an unmarked intent was registered before
-- producer pinning shipped. This is not a fresh public admission path. Keep the
-- original raw-sample settlement regressions for these retained permits.
create function pg_temp.prepare_runtime(p_request jsonb,p_secret text) returns jsonb language plpgsql as $$
declare r jsonb:=pg_temp.prestart_request(p_request); identity jsonb;
begin
    if not (r ? 'usageProducer') and not exists(select 1 from public.qorpera_computer_prestart_attempts where permit_id=(r->>'requestId')::uuid) then
        identity:=public.qorpera_computer_prestart_identity(r,p_secret,'runtime');
        insert into public.qorpera_computer_prestart_attempts(permit_id,profile_id,kind,host_key_id,identity,prepare_request_text)
            values((r->>'requestId')::uuid,(identity->>'profileId')::uuid,'runtime',(identity->>'hostKeyId')::uuid,identity,r->>'prepareRequestText');
    end if;
    return public.qorpera_prepare_runtime_computer_permit(r,p_secret);
end $$;
-- Real founder demand/provider enrollment; no physical machine or live charge.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select set_config('qorpera_test.office_scope', (public.qorpera_register_runtime_office(
    '30000000-0000-4000-8000-000000000020','64100000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)-'state')::text,true);
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'64100000-0000-4000-8000-000000000002');
select pg_temp.path_claims('service_role');
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
    '64100000-0000-4000-8000-000000000003',repeat('f',64),0,true);
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'office',
    '64100000-0000-4000-8000-000000000003',repeat('f',64),2000,2147483648);
insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
values('30000000-0000-4000-8000-000000000310','office','64100000-0000-4000-8000-000000000003',repeat('f',64),repeat('c',64),repeat('b',64),2000,2147483648,'lxd',
    encode(extensions.digest(convert_to(repeat('O',64),'UTF8'),'sha256'),'hex'));
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
    'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
    public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310')->>'contextSha256',
    jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
do $$ declare scope jsonb:=current_setting('qorpera_test.office_scope')::jsonb; start jsonb; request jsonb; result jsonb;
begin
    start:=jsonb_build_object('p_provider_id','64100000-0000-4000-8000-000000000003','p_provider_policy_sha256',repeat('f',64),
        'p_scope',scope,'p_computer_generation',1,'p_intent_id','64100000-0000-4000-8000-000000000002',
        'p_allocation_id','64100000-0000-4000-8000-000000000004','p_instance_sha256',repeat('d',64),'p_provider_binding_sha256',repeat('e',64),
        'p_image_sha256',repeat('a',64),'p_bootstrap_sha256',repeat('b',64));
    request:=jsonb_build_object('allocationId','64100000-0000-4000-8000-000000000004','providerKind','office',
        'providerId','64100000-0000-4000-8000-000000000003','policySha256',repeat('f',64),'machineIdSha256',repeat('c',64),
        'bootstrapSha256',repeat('b',64),'instanceSha256',repeat('d',64),'officeId',scope->'companyComputerId','computerGeneration',1,
        'runId',null,'runnerId',null,'action','reserve','start',start);
    perform pg_temp.wake_error(format('select public.qorpera_paid_office_admission(%L,%L)',request,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_paid_office_admission(%L,%L)',request-'action',repeat('O',64)),'42501');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_machine_allocations where id='64100000-0000-4000-8000-000000000004'),'Unprotected office preparation allocated capacity');
    result:=public.qorpera_paid_office_admission(request,repeat('O',64));
    perform pg_temp.wake_assert(result->>'mode'='paid' and result#>>'{result,state}'='reserved','Protected stopped-office reservation failed');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_computer_permits),'Stopped creation consumed a funded window');
    result:=public.qorpera_paid_office_admission(request||'{"action":"node"}',repeat('O',64));
    perform pg_temp.wake_assert(result#>>'{result,state}'='reserved','Protected initial node admission failed');
    request:=(request-'action'-'start')||jsonb_build_object('schema','qorpera.runtime-computer-prepare/v1',
        'requestId','64100000-0000-4000-8000-000000000005','hostBootId','64100000-0000-4000-8000-000000000006',
        'windowMs',300000,'stopReserveMs',30000,'officeIntent',jsonb_build_object('kind','initial',
            'intentId','64100000-0000-4000-8000-000000000002','providerBindingSha256',repeat('e',64),'mappings','[]'::jsonb));
    perform set_config('qorpera_test.office_paid_request',request::text,true);
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request-'officeIntent',repeat('O',64)),'42501');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request,repeat('O',64)),'P0001');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_usage_streams where allocation_id='64100000-0000-4000-8000-000000000004'),'Unfunded boot left partial accounting');
end $$;
select public.qorpera_map_computer_billing_customer('30000000-0000-4000-8000-000000000001','cus_officepaid');
do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; request jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; receipt jsonb;
begin
    perform public.qorpera_reconcile_computer_subscription('evt_officepaid',t,jsonb_build_object('subscriptionId','sub_officepaid','customerId','cus_officepaid',
        'userId','30000000-0000-4000-8000-000000000001','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_officepaid','subscriptionId','sub_officepaid','customerId','cus_officepaid',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
    -- Being the Computer Usage owner is not consent to spend a personal plan.
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request,repeat('O',64)),'P0001');
    perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
    perform public.qorpera_set_company_computer_pool('30000000-0000-4000-8000-000000000010',true);
    perform pg_temp.path_claims('service_role');
    receipt:=pg_temp.prepare_runtime(request,repeat('O',64));
    perform pg_temp.wake_assert(receipt#>>'{runtimeContext,resourceKind}'='company_computer' and receipt->>'state'='prepared','Office funded receipt differs');
    perform pg_temp.wake_assert((select requested_by_user_id is null from public.qorpera_computer_allowance_reservations where id='64100000-0000-4000-8000-000000000005'),'Shared office attributed to an arbitrary member');
    perform pg_temp.wake_assert((pg_temp.prepare_runtime(request,repeat('O',64))->>'deadline')=receipt->>'deadline','Replay extended funded office lifetime');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
end $$;
-- Close the initial guard without inventing a physical boot. The lifecycle
-- fixtures below seed already-verified guest activation/stop evidence, then
-- exercise real durable boot/reset authorization and paid admission functions.
do $$ declare r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; begin
    perform public.qorpera_finish_runtime_computer_permit(jsonb_build_object('permitId',r->'requestId','generation',1,
        'requestId',extensions.gen_random_uuid(),'guardClosed',true,'sample',jsonb_build_object(
        'observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',r->'hostBootId',
        'hostUptimeMs',1000,'physicalId',null,'guestBootId',null,'guestUptimeMs',null,'observedAt',clock_timestamp(),
        'state','absent','evidenceSha256',repeat('a',64))),repeat('O',64));
end $$;
insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
    provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,
    attestation,mappings,state,service_invocation_id,ready_at,activated_at)
values('64100000-0000-4000-8000-000000000002','64100000-0000-4000-8000-000000000020',(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1,
    '64100000-0000-4000-8000-000000000004','64100000-0000-4000-8000-000000000003',repeat('f',64),repeat('e',64),repeat('d',64),repeat('a',64),repeat('b',64),
    jsonb_build_object('schema','qorpera.office-activation-attestation/v1','activationId','64100000-0000-4000-8000-000000000020',
    'bootId','64100000-0000-4000-8000-000000000021','preparationObservationSha256',repeat('1',64),
    'configurationObservationSha256',repeat('2',64),'configurationSha256',repeat('3',64),'adoptionReceiptSha256',repeat('4',64),'nativePort',18000,'viewerPort',18001),
    '[]','active',repeat('1',32),clock_timestamp(),clock_timestamp());
update public.qorpera_runtime_offices set state='maintenance' where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
create function pg_temp.office_stop_fixture(p_action text) returns jsonb language plpgsql as $$
declare r jsonb; t uuid:=extensions.gen_random_uuid(); challenge uuid:=extensions.gen_random_uuid(); n timestamptz:=clock_timestamp(); begin
    r:=jsonb_build_object('schema','qorpera.office-lifecycle-request/v1','transitionId',t,'action',p_action,
        'activationId','64100000-0000-4000-8000-000000000020','providerId','64100000-0000-4000-8000-000000000003','providerPolicySha256',repeat('f',64),
        'startup',jsonb_build_object('scope',current_setting('qorpera_test.office_scope')::jsonb,'computerGeneration',1,
        'allocationId','64100000-0000-4000-8000-000000000004','instanceSha256',repeat('d',64),'imageSha256',repeat('a',64),'bootstrapSha256',repeat('b',64),
        'bootId','64100000-0000-4000-8000-000000000021','configurationSha256',repeat('3',64),'serviceInvocationId',repeat('1',32)));
    insert into public.qorpera_runtime_office_lifecycle_transitions(id,activation_id,office_id,computer_generation,allocation_id,request,revocation_revision,drains)
    select t,'64100000-0000-4000-8000-000000000020',id,generation,'64100000-0000-4000-8000-000000000004',r,revision,'[]'
    from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    insert into public.qorpera_runtime_office_stop_challenges(id,transition_id,command,start_completion_sha256,office_revision,privacy_version,drains,issued_at,expires_at)
    select challenge,t,'{}',repeat('5',64),revision,privacy_version,'[]',n,n+interval '5 seconds'
    from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    insert into public.qorpera_runtime_office_stops(transition_id,challenge_id,inspection) values(t,challenge,'{}');
    return r;
end $$;
savepoint resume_case;
do $$ declare sample jsonb; renewal jsonb; boot jsonb; r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; receipt jsonb; before_count bigint; begin
    boot:=jsonb_build_object('schema','qorpera.office-boot-intent-request/v1','bootIntentId',extensions.gen_random_uuid(),
        'activationId',extensions.gen_random_uuid(),'predecessor',pg_temp.office_stop_fixture('power_off'),
        'stopHistorySha256',repeat('6',64),'powerOffCompletionSha256',repeat('7',64));
    perform public.qorpera_prepare_runtime_office_boot_intent(boot);
    r:=r||jsonb_build_object('requestId',extensions.gen_random_uuid(),'officeIntent',jsonb_build_object('kind','resume','request',boot));
    select count(*) into before_count from public.qorpera_coding_computer_permits;
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',
        jsonb_set(r,'{officeIntent,request,stopHistorySha256}',to_jsonb(repeat('8',64))),repeat('O',64)),'42501');
    update public.qorpera_runtime_offices set revision=revision+1 where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r,repeat('O',64)),'42501');
    update public.qorpera_runtime_offices set revision=revision-1 where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.wake_assert((select count(*)=before_count from public.qorpera_coding_computer_permits),'Refused resume created a funded window');
    receipt:=pg_temp.prepare_runtime(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared','Valid maintenance resume failed paid admission');
    perform pg_temp.wake_assert(pg_temp.prepare_runtime(r,repeat('O',64))->>'deadline'=receipt->>'deadline','Resume replay extended window');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values('64100000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000310','64100000-0000-4000-8000-000000000030','{}');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',r->'hostBootId',
        'hostUptimeMs',100000,'physicalId','64100000-0000-4000-8000-000000000030','guestBootId','64100000-0000-4000-8000-000000000031',
        'guestUptimeMs',10000,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('a',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',r->'requestId','generation',1,'sample',sample),repeat('O',64));
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100100,'guestUptimeMs',10100,'observedAt',clock_timestamp());
    renewal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',r->'requestId','generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000);
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',renewal,repeat('O',64)),'42501');
    -- Seed the observed successful successor activation. Its exact boot may
    -- renew; the revoked predecessor's still-active historical row may not.
    update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id='64100000-0000-4000-8000-000000000020';
    insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
        provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,
        attestation,mappings,state,service_invocation_id,ready_at,activated_at,predecessor_activation_id)
    select intent_id,(boot->>'activationId')::uuid,office_id,computer_generation,allocation_id,provider_id,provider_policy_sha256,
        provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,
        attestation||jsonb_build_object('activationId',boot->'activationId','bootId',sample->'guestBootId'),mappings,state,repeat('2',32),
        ready_at,activated_at,activation_id from public.qorpera_runtime_office_activations where activation_id='64100000-0000-4000-8000-000000000020';
    update public.qorpera_runtime_offices set state='active' where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    update public.qorpera_runtime_office_providers set preparation_enabled=false where office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',renewal,repeat('O',64)),'42501');
    update public.qorpera_runtime_office_providers set preparation_enabled=true where office_id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
    perform public.qorpera_set_company_computer_pool('30000000-0000-4000-8000-000000000010',false);
    perform pg_temp.path_claims('service_role');
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',renewal,repeat('O',64)),'P0001');
    perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
    perform public.qorpera_set_company_computer_pool('30000000-0000-4000-8000-000000000010',true);
    perform pg_temp.path_claims('service_role');
    receipt:=public.qorpera_renew_runtime_computer_permit(renewal,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'generation'='2','Exact active successor could not renew');
end $$;
rollback to savepoint resume_case;
savepoint reset_case;
do $$ declare v_plan jsonb; r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; receipt jsonb; before_count bigint; begin
    v_plan:=jsonb_build_object('schema','qorpera.lxd-office-reset-plan/v1','resetId',extensions.gen_random_uuid(),
        'intentId','64100000-0000-4000-8000-000000000002','predecessor',pg_temp.office_stop_fixture('replace'),
        'preparationObservationSha256',repeat('1',64),'providerBindingSha256',repeat('e',64),
        'nodeId','30000000-0000-4000-8000-000000000310','predecessorRootIncarnationId',null,'rootIncarnationId',extensions.gen_random_uuid(),
        'successorActivationId',extensions.gen_random_uuid(),'commands',jsonb_build_object('stopCommandId',extensions.gen_random_uuid(),
        'deleteCommandId',extensions.gen_random_uuid(),'createCommandId',extensions.gen_random_uuid(),'startCommandId',extensions.gen_random_uuid()),
        'custody',jsonb_build_object('archiveRoot','/var/lib/qorpera-office-provider/reset-custody'));
    -- Canonical operator-enrolled package facts are another independent reset
    -- prerequisite. Keep that authority enabled rather than bypassing its gate.
    insert into public.qorpera_office_package_capabilities values('64100000-0000-4000-8000-000000000004',
        '64100000-0000-4000-8000-000000000003',repeat('f',64),repeat('a',64),1,true);
    insert into public.qorpera_office_package_baselines(allocation_id,base,compatibility)
        values('64100000-0000-4000-8000-000000000004','{}','{}');
    insert into public.qorpera_office_package_provisions(id,allocation_id,predecessor_activation_id,reset_id,root_incarnation_id,
        successor_activation_id,install_command_id,reset_plan,plan,statement,plan_sha256,expected_software_revision,target_revision,
        office_revision,privacy_version,privacy_state,privacy_challenge,stop_was_acknowledged)
    select extensions.gen_random_uuid(),'64100000-0000-4000-8000-000000000004','64100000-0000-4000-8000-000000000020',
        (v_plan->>'resetId')::uuid,(v_plan->>'rootIncarnationId')::uuid,(v_plan->>'successorActivationId')::uuid,extensions.gen_random_uuid(),v_plan,
        jsonb_build_object('resetPlanSha256',encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex')),
        jsonb_build_object('target',jsonb_build_object('runtimeBundle',(select jsonb_build_object('id',bundle.bundle_key,'version',bundle.version,'sha256',bundle.sha256)
        from public.qorpera_active_runtime_bundle active join public.qorpera_runtime_bundles bundle on bundle.id=active.runtime_bundle_id where active.singleton))),
        repeat('b',64),null,1,revision,privacy_version,privacy_state,privacy_challenge,true
    from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform public.qorpera_begin_runtime_office_reset(v_plan,encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex'));
    r:=r||jsonb_build_object('requestId',v_plan#>'{commands,startCommandId}','officeIntent',jsonb_build_object('kind','reset','plan',v_plan));
    select count(*) into before_count from public.qorpera_coding_computer_permits;
    -- A fenced reset has no authority to power on its replacement root.
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r,repeat('O',64)),'42501');
    -- Seed verified prior physical stop/archive/delete/create outcomes; this
    -- test exercises paid start authorization, not the external archive reader.
    update public.qorpera_runtime_office_resets set phase='root_created',custody='{}',custody_sha256=repeat('9',64) where reset_id=(v_plan->>'resetId')::uuid;
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    update public.qorpera_runtime_offices set privacy_version=privacy_version+1 where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r,repeat('O',64)),'42501');
    update public.qorpera_runtime_offices set privacy_version=privacy_version-1 where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    perform pg_temp.wake_assert((select count(*)=before_count from public.qorpera_coding_computer_permits),'Refused reset created a funded window');
    receipt:=pg_temp.prepare_runtime(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared','Valid reset start phase failed paid admission');
    perform pg_temp.wake_assert(pg_temp.prepare_runtime(r,repeat('O',64))->>'deadline'=receipt->>'deadline','Reset replay extended window');
end $$;
rollback to savepoint reset_case;

do $$ declare role_name text; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_authorize_paid_office_start(jsonb)','EXECUTE'),'Office lifecycle hook exposed');
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_reserve_paid_office_start_internal(jsonb,bigint,uuid,uuid,text,text,text,text)','EXECUTE'),'Office capacity clone exposed');
    end loop;
end $$;
rollback;
