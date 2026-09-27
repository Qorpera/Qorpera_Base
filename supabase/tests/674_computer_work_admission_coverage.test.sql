-- @fixture 641_paid_office_lifecycle.test.sql until "do $$ declare t timestamptz:=clock_timestamp()-interval '1 day';"
-- Actual PostgreSQL authority/ledger with explicitly synthetic physical facts.
-- Fresh v3 guard producer binds while the guest is still closed to work.
do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
    perform public.qorpera_reconcile_computer_subscription('evt_officepaid',t,jsonb_build_object('subscriptionId','sub_officepaid','customerId','cus_officepaid',
        'userId','30000000-0000-4000-8000-000000000001','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_officepaid','subscriptionId','sub_officepaid','customerId','cus_officepaid',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
    perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
    perform public.qorpera_set_company_computer_pool('30000000-0000-4000-8000-000000000010',true);
    perform pg_temp.path_claims('service_role');
end $$;
create function pg_temp.upload(p_permit jsonb,p_sample jsonb) returns jsonb language plpgsql as $$
declare cursor public.qorpera_computer_guard_sample_cursors%rowtype; entry_text text;
begin
    select * into strict cursor from public.qorpera_computer_guard_sample_cursors where permit_id=(p_permit->>'permitId')::uuid;
    entry_text:=jsonb_build_object('schema','qorpera.computer-guard-usage-entry/v1','sequence',cursor.sequence+1,
        'previousSha256',cursor.sha256,'permit',p_permit-'runtimeContext'-'closure',
        'hostMachineIdSha256',repeat('c',64),'physicalInstanceId',p_sample->'physicalId',
        'deadlineUptimeMs',430000,'stopAtUptimeMs',400000,'sample',p_sample,'stopReceipt',null)::text||chr(10);
    return public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',p_permit->'permitId','generation',p_permit->'generation',
        'entries',jsonb_build_array(jsonb_build_object('sequence',cursor.sequence+1,
        'sha256',encode(extensions.digest(convert_to(entry_text,'UTF8'),'sha256'),'hex'),'entryText',entry_text))),repeat('O',64));
end $$;
do $$ declare request jsonb:=pg_temp.prestart_request(current_setting('qorpera_test.office_paid_request')::jsonb||'{"usageProducer":"guard-v1"}');
    permit jsonb; sample jsonb; activation public.qorpera_runtime_office_activations%rowtype; startup jsonb; reply jsonb;
    scope jsonb:=current_setting('qorpera_test.office_scope')::jsonb; role_name text;
begin
    permit:=public.qorpera_prepare_runtime_computer_permit(request,repeat('O',64));
    perform pg_temp.wake_assert(not public.qorpera_computer_work_ready((permit->>'permitId')::uuid),'Prepared funding admitted work');
    perform public.qorpera_prepare_runtime_office_activation(scope,1,'64100000-0000-4000-8000-000000000002',
        '64100000-0000-4000-8000-000000000004',repeat('d',64),repeat('e',64),'64100000-0000-4000-8000-000000000003',repeat('f',64),'[]',
        jsonb_build_object('schema','qorpera.office-activation-attestation/v1','activationId','67400000-0000-4000-8000-000000000001',
        'bootId','67400000-0000-4000-8000-000000000002','preparationObservationSha256',repeat('1',64),'configurationObservationSha256',repeat('2',64),
        'configurationSha256',repeat('3',64),'adoptionReceiptSha256',repeat('4',64),'nativePort',18000,'viewerPort',18001));
    select * into strict activation from public.qorpera_runtime_office_activations where activation_id='67400000-0000-4000-8000-000000000001';
    startup:=jsonb_build_object('scope',scope,'computerGeneration',1,'allocationId',activation.allocation_id,'instanceSha256',activation.instance_sha256,
        'imageSha256',activation.image_sha256,'bootstrapSha256',activation.bootstrap_sha256,'bootId',activation.attestation->'bootId',
        'configurationSha256',repeat('3',64),'serviceInvocationId',repeat('1',32));
    reply:=public.qorpera_report_runtime_office_ready(startup,activation.activation_id,18000,18001);
    perform pg_temp.wake_assert(reply->>'state'='ready','Closed-listener startup waited on metering');
    perform pg_temp.wake_error(format('select public.qorpera_activate_runtime_office(%L,1,%L,%L,%L,%L,%L)',scope,
        activation.intent_id,activation.activation_id,activation.provider_id,activation.provider_policy_sha256,repeat('1',32)),'55000');
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values(activation.allocation_id,'30000000-0000-4000-8000-000000000310','67400000-0000-4000-8000-000000000003','{}');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',request->'hostBootId',
        'hostUptimeMs',100000,'physicalId','67400000-0000-4000-8000-000000000003','guestBootId',activation.attestation->'bootId',
        'guestUptimeMs',1000,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('a',64));
    perform pg_temp.upload(permit,sample);
    reply:=public.qorpera_describe_runtime_computer_permit(request,repeat('O',64));
    perform pg_temp.wake_assert(reply->'workReady'='true' and reply->'lastSample'=sample,'Exact fresh initial sample not ready');
    perform pg_temp.wake_error(format('select public.qorpera_describe_runtime_computer_permit(%L,%L)',request,repeat('X',64)),'42501');
    perform public.qorpera_activate_runtime_office(scope,1,activation.intent_id,activation.activation_id,activation.provider_id,activation.provider_policy_sha256,repeat('1',32));
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_startup(startup)->>'state'='active','Metered office did not activate');
    -- Raw state remains running and the immutable chain is accepted, but a
    -- frozen guest clock gives SQL gap coverage: no new work admission.
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100500,'observedAt',clock_timestamp());
    perform pg_temp.upload(permit,sample);
    reply:=public.qorpera_describe_runtime_computer_permit(request,repeat('O',64));
    perform pg_temp.wake_assert(reply#>>'{lastSample,state}'='running' and reply->'workReady'='false','Running gap admitted work');
    perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_startup(%L)',startup),'55000');
    perform pg_temp.wake_error(format('select public.qorpera_activate_runtime_office(%L,1,%L,%L,%L,%L,%L)',scope,
        activation.intent_id,activation.activation_id,activation.provider_id,activation.provider_policy_sha256,repeat('1',32)),'55000');
    -- Custody remains available through the existing generic binding path.
    perform public.qorpera_check_runtime_office_guest_binding(scope,1,activation.allocation_id,activation.instance_sha256,activation.image_sha256,activation.bootstrap_sha256);
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',101000,'guestUptimeMs',1500,'observedAt',clock_timestamp());
    perform pg_temp.upload(permit,sample);
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_startup(startup)->>'state'='active','Confirmed recovery failed to restore work');
    activation.attestation:=activation.attestation||jsonb_build_object('bootId',extensions.gen_random_uuid());
    perform pg_temp.wake_error(format('select public.qorpera_assert_office_computer_work_ready(%L::public.qorpera_runtime_office_activations)',activation),'55000');
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_computer_work_ready(uuid)','EXECUTE')
            and not has_function_privilege(role_name,'public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)','EXECUTE'),'Private work admission exposed');
    end loop;
end $$;
rollback;
