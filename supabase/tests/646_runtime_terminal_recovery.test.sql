-- @fixture 640_runtime_computer_permits.test.sql until "do $$ declare b jsonb:="
-- Native source registration may move on while the original host still owns
-- physical stop and the final unused allowance from a lost renewal reply.
do $$ declare b jsonb:=current_setting('qorpera_test.runtime_paid_binding')::jsonb; request jsonb; initial jsonb;
    sample jsonb; terminal jsonb; receipt jsonb; recovered jsonb; allocation uuid; held bigint; t timestamptz;
    attempt uuid:='64600000-0000-4000-8000-000000000010'; next_window uuid:='64600000-0000-4000-8000-000000000020';
begin
    select client_runner_id into strict allocation from public.qorpera_runners where id=(b->>'runnerId')::uuid;
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.runtime-computer-prepare/v2',
        'requestId',attempt,'allocationId',allocation,'providerKind','native','providerId','process','policySha256',repeat('f',64),
        'instanceSha256',repeat('d',64),'machineIdSha256',repeat('c',64),'hostBootId','64600000-0000-4000-8000-000000000011',
        'bootstrapSha256',repeat('b',64),'runId',b->'runId','runnerId',b->'runnerId','officeId',null,'computerGeneration',null,
        'windowMs',300000,'stopReserveMs',30000));
    initial:=pg_temp.prepare_runtime(request,repeat('R',64));
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values(allocation,'30000000-0000-4000-8000-000000000310','64600000-0000-4000-8000-000000000012','{}');
    t:=clock_timestamp();
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
        'hostBootId',request->'hostBootId','hostUptimeMs',1000000,'physicalId','64600000-0000-4000-8000-000000000012',
        'guestBootId','64600000-0000-4000-8000-000000000013','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('R',64));
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1000100,'guestUptimeMs',100100,'observedAt',t+interval '100 milliseconds');
    perform public.qorpera_renew_runtime_computer_permit(jsonb_build_object('requestId',next_window,'permitId',attempt,'generation',1,
        'sample',sample,'windowMs',300000,'stopReserveMs',30000),repeat('R',64));
    select reserved_us into held from public.qorpera_computer_allowance_reservations where id=next_window;
    perform pg_temp.wake_assert((select generation=2 from public.qorpera_coding_computer_permits where id=attempt)
        and (select debited_us=50000 from public.qorpera_computer_allowance_settlements where reservation_id=attempt),
        'Runtime lost renewal did not settle N exactly once');
    update public.qorpera_runners set client_runner_id=extensions.gen_random_uuid() where id=(b->>'runnerId')::uuid;
    perform pg_temp.wake_error(format('select public.qorpera_describe_runtime_computer_permit(%L,%L)',request,repeat('R',64)),'42501');
    recovered:=public.qorpera_describe_runtime_computer_prestart(request,repeat('R',64));
    perform pg_temp.wake_assert(recovered->>'state'='bound' and recovered#>>'{permit,generation}'='2' and recovered->'lastSample'=sample,
        'Historical runtime recovery required current run/runner source');
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1000200,'guestUptimeMs',null,'observedAt',t+interval '200 milliseconds','state','stopped');
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',attempt,'generation',2,'sample',sample,'guardClosed',true);
    perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,%L)',terminal,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,null)',terminal),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,%L)',terminal||'{"generation":1}',repeat('R',64)),'PGRST');
    begin
        update public.qorpera_runtime_computer_host_keys set revoked_at=clock_timestamp() where provider_kind='native';
        perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,%L)',terminal,repeat('R',64)),'42501');
        raise exception using errcode='QT646';
    exception when sqlstate 'QT646' then null; end;
    receipt:=public.qorpera_finish_runtime_computer_permit(terminal,repeat('R',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and receipt->>'generation'='2' and receipt->>'validForMs'='0'
        and receipt->>'epoch'=initial->>'epoch' and receipt->>'reservationId'=next_window::text
        and public.qorpera_finish_runtime_computer_permit(terminal,repeat('R',64))=receipt,
        'Runtime N+1 finish failed after its runner registration advanced');
    perform pg_temp.wake_assert((select debited_us=0 and released_us=held from public.qorpera_computer_allowance_settlements where reservation_id=next_window)
        and (select reserved_us=0 and debited_us=50000 from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime')
        and (select closed and active_ms=100 from public.qorpera_computer_usage_streams where allocation_id=allocation and epoch=(initial->>'epoch')::uuid)
        and (select count(*)=2 from public.qorpera_computer_allowance_settlements where allocation_id=allocation and epoch=(initial->>'epoch')::uuid),
        'Terminal runtime recovery invented awake time or leaked the last hold');
    recovered:=public.qorpera_describe_runtime_computer_prestart(request,repeat('R',64));
    perform pg_temp.wake_assert(recovered->>'state'='closed' and recovered->'permit'=receipt and recovered->'lastSample'=sample,
        'Runtime closed historical receipt lost exact terminal state');
    perform pg_temp.wake_assert((select released_at is null from public.qorpera_runtime_machine_allocations where id=allocation),
        'Financial closure improperly released physical allocation custody');
end $$;
rollback;
