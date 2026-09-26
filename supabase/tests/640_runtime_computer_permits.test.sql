-- @fixture 638_paid_computer_admission_boundaries.test.sql until "-- A new owner-authenticated coding turn"
-- A real durable guard supplies this non-secret, byte-bound intent before prepare.
create function pg_temp.prestart_request(p_request jsonb) returns jsonb language plpgsql as $$
declare v_base jsonb; v_text text;
begin
    v_base:=(p_request-'prestart'-'prepareRequestText')||jsonb_build_object('schema','qorpera.runtime-computer-prepare/v2');
    v_text:=(v_base-'leaseToken')::text;
    return v_base||jsonb_build_object('prepareRequestText',v_text,'prestart',jsonb_build_object(
        'guardIncarnationId','64200000-0000-4000-8000-000000000001',
        'prepareSha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex')));
end $$;
create function pg_temp.prepare_runtime(p_request jsonb,p_secret text) returns jsonb language sql as $$
    select public.qorpera_prepare_runtime_computer_permit(pg_temp.prestart_request(p_request),p_secret)
$$;
-- Use real native run/runner authority and synthetic physical facts only.
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
values('64000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
    'kickoff','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}');
select set_config('qorpera_test.runtime_paid_run',pg_temp.wake_input_run(array['64000000-0000-4000-8000-000000000001'::uuid])::text,true);
-- The reused coding fixture can enqueue a continuity wake on completion. Give
-- this isolated test run deterministic queue order without altering authority.
update public.qorpera_runner_jobs set created_at=clock_timestamp()-interval '1 day' where run_id=current_setting('qorpera_test.runtime_paid_run')::uuid;
select set_config('qorpera_test.runtime_paid_binding',pg_temp.wake_start(current_setting('qorpera_test.runtime_paid_run')::uuid)::text,true);
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'native','process',repeat('f',64),2000,2147483648);
insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
values('30000000-0000-4000-8000-000000000310','native','process',repeat('f',64),repeat('c',64),repeat('b',64),2000,2147483648,'lxd',
    encode(extensions.digest(convert_to(repeat('R',64),'UTF8'),'sha256'),'hex'));
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
    'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
    public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310')->>'contextSha256',
    jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
select public.qorpera_map_computer_billing_customer('30000000-0000-4000-8000-000000000001','cus_runtime');
do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
    perform public.qorpera_reconcile_computer_subscription('evt_runtime',t,jsonb_build_object('subscriptionId','sub_runtime','customerId','cus_runtime',
        'userId','30000000-0000-4000-8000-000000000001','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_runtime','subscriptionId','sub_runtime','customerId','cus_runtime',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
end $$;

do $$ declare b jsonb:=current_setting('qorpera_test.runtime_paid_binding')::jsonb; request jsonb; receipt jsonb; again jsonb; sample jsonb; renewal jsonb; terminal jsonb;
    v_allocation uuid; v_permit uuid:='64000000-0000-4000-8000-000000000010'; v_epoch uuid; t timestamptz; v_issued bigint;
begin
    select client_runner_id into strict v_allocation from public.qorpera_runners where id=(b->>'runnerId')::uuid;
    request:=jsonb_build_object('schema','qorpera.runtime-computer-prepare/v1','requestId',v_permit,'allocationId',v_allocation,
        'providerKind','native','providerId','process','policySha256',repeat('f',64),'instanceSha256',repeat('d',64),
        'machineIdSha256',repeat('c',64),'hostBootId','64000000-0000-4000-8000-000000000011','bootstrapSha256',repeat('b',64),
        'runId',b->'runId','runnerId',b->'runnerId','officeId',null,'computerGeneration',null,'windowMs',300000,'stopReserveMs',30000);
    again:=public.qorpera_describe_runtime_computer_permit(request,repeat('R',64));
    perform pg_temp.wake_assert(again->>'mode'='paid' and again->'permit'='null','Missing permit cannot fall back to free execution');
    perform pg_temp.wake_assert(not public.qorpera_native_computer_permit_ready((b->>'runnerId')::uuid,(b->>'runId')::uuid),'Unfunded native launch admitted');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request||jsonb_build_object('bootstrapSha256',repeat('a',64)),repeat('R',64)),'42501');
    -- Native generated bootstrap contains per-run credentials; its exact
    -- identity remains immutable even when enrollment delegates composition.
    update public.qorpera_runtime_computer_host_keys set bootstrap_sha256=null where provider_kind='native';
    update public.qorpera_runtime_node_providers set cpu_millis=1000 where provider_kind='native' and provider_id='process';
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request,repeat('R',64)),'42501');
    update public.qorpera_runtime_node_providers set cpu_millis=2000 where provider_kind='native' and provider_id='process';
    select issued_us into v_issued from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime';
    -- Operator-only synthetic balance setup; production custody resumes below.
    alter table public.qorpera_computer_allowance_buckets disable trigger qorpera_computer_bucket_payment_guard;
    update public.qorpera_computer_allowance_buckets set issued_us=1,funded_us=1 where invoice_id='in_runtime';
    alter table public.qorpera_computer_allowance_buckets enable trigger qorpera_computer_bucket_payment_guard;
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request,repeat('R',64)),'P0001');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_machine_allocations where id=v_allocation),
        'Insufficient funding left a partially admitted allocation');
    -- Operator-only synthetic balance setup; production custody resumes below.
    alter table public.qorpera_computer_allowance_buckets disable trigger qorpera_computer_bucket_payment_guard;
    update public.qorpera_computer_allowance_buckets set issued_us=v_issued,funded_us=v_issued where invoice_id='in_runtime';
    alter table public.qorpera_computer_allowance_buckets enable trigger qorpera_computer_bucket_payment_guard;
    receipt:=pg_temp.prepare_runtime(request,repeat('R',64)); v_epoch:=(receipt->>'epoch')::uuid;
    again:=pg_temp.prepare_runtime(request,repeat('R',64));
    perform pg_temp.wake_error(format('select public.qorpera_describe_runtime_computer_permit(%L,%L)',request||jsonb_build_object('bootstrapSha256',repeat('a',64)),repeat('R',64)),'42501');
    perform pg_temp.wake_assert(receipt->>'schema'='qorpera.computer-usage-permit/v2' and receipt#>>'{runtimeContext,resourceKind}'='agent_sandbox'
        and receipt#>>'{runtimeContext,runId}'=b->>'runId' and receipt->>'deadline'=again->>'deadline'
        and (again->>'validForMs')::bigint<=(receipt->>'validForMs')::bigint,'Runtime prestart authority or replay differs');
    perform pg_temp.wake_assert(not public.qorpera_native_computer_permit_ready((b->>'runnerId')::uuid,(b->>'runId')::uuid),'Prepared VM admitted a model before bind');
    perform pg_temp.wake_assert((select requested_by_user_id=(select requested_by_user_id from public.qorpera_execution_runs where id=(b->>'runId')::uuid)
        from public.qorpera_computer_allowance_reservations where id=v_permit),'Requester changed to model sponsor');
    perform pg_temp.wake_assert(public.qorpera_observe_computer_usage(jsonb_build_object('allocationId',v_allocation,'observationId',extensions.gen_random_uuid()))->>'reason'='paid_meter_owned',
        'Shadow observer touched a protected native epoch');
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values(v_allocation,'30000000-0000-4000-8000-000000000310','64000000-0000-4000-8000-000000000012','{}');
    t:=clock_timestamp()-interval '2 seconds';
    update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=v_allocation and epoch=v_epoch;
    update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=v_allocation and epoch=v_epoch and sequence=0;
    sample:=jsonb_build_object('observationId','64000000-0000-4000-8000-000000000013','previousObservationId',null,
        'hostBootId','64000000-0000-4000-8000-000000000011','hostUptimeMs',1000000,'physicalId','64000000-0000-4000-8000-000000000012',
        'guestBootId','64000000-0000-4000-8000-000000000014','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',v_permit,'generation',1,'sample',sample),repeat('R',64));
    perform pg_temp.wake_assert(public.qorpera_native_computer_permit_ready((b->>'runnerId')::uuid,(b->>'runId')::uuid)
        and not public.qorpera_native_computer_permit_ready((b->>'runnerId')::uuid,extensions.gen_random_uuid()),'Bound permit crossed run identity');
    -- The remaining executable provenance guard still runs; a paid computer
    -- does not itself admit arbitrary binaries, model accounts, or tool grants.
    perform pg_temp.wake_error(format('select public.qorpera_begin_native_company_execution_v2(%L,%L,%L,%L,%L,%L,10)',b,repeat('0',64),repeat('0',64),repeat('0',64),'{}',repeat('0',64)),
        '42501','Native executable policy differs from the admitted run');
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',1000100,'guestUptimeMs',100100,'observedAt',t+interval '100 milliseconds');
    renewal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',v_permit,'generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000);
    receipt:=public.qorpera_renew_runtime_computer_permit(renewal,repeat('R',64));
    perform pg_temp.wake_assert(receipt->>'generation'='2' and (select debited_us=50000 from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime'),
        'Runtime renewal did not debit exact half-size observed interval');
    again:=public.qorpera_renew_runtime_computer_permit(renewal,repeat('R',64));
    perform pg_temp.wake_assert(again->>'deadline'=receipt->>'deadline','Renewal replay extended custody');
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',1000200,'guestUptimeMs',null,'observedAt',t+interval '200 milliseconds','state','stopped');
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',v_permit,'generation',2,'sample',sample,'guardClosed',true);
    perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,%L)',terminal||'{"generation":999}',repeat('R',64)),'PGRST');
    receipt:=public.qorpera_finish_runtime_computer_permit(terminal,repeat('R',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and receipt->>'validForMs'='0'
        and not public.qorpera_native_computer_permit_ready((b->>'runnerId')::uuid,(b->>'runId')::uuid)
        and (select reserved_us=0 and debited_us=50000 from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime'),'Terminal runtime settlement violated conservation');
end $$;
do $$ declare f regprocedure; role_name text; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(role_name,'public.qorpera_runtime_computer_host_keys','SELECT,INSERT,UPDATE,DELETE'), 'Host enrollment is operator only');
        foreach f in array array['public.qorpera_reserve_paid_runtime_machine_internal(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
            'public.qorpera_reserve_paid_runtime_node_internal(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
            'public.qorpera_runtime_computer_host(jsonb,text)'::regprocedure,'public.qorpera_authorize_paid_office_start(jsonb)'::regprocedure] loop
            perform pg_temp.wake_assert(not has_function_privilege(role_name,f,'EXECUTE'),'Private capacity boundary exposed');
        end loop;
    end loop;
end $$;
rollback;
