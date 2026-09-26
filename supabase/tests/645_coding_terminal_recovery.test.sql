-- @fixture 637_coding_computer_permits.test.sql until "do $$ declare request jsonb; receipt jsonb;"
-- SQL commits renewal N+1 while the host still retains its stopped N guard.
-- The synthetic physical samples exercise the actual settlement transaction.
do $$ declare request jsonb; initial jsonb; sample jsonb; renewal jsonb; recovered jsonb; terminal jsonb; receipt jsonb;
    attempt uuid:='64500000-0000-4000-8000-000000000010'; next_window uuid:='64500000-0000-4000-8000-000000000020';
    machine uuid:=current_setting('qorpera_test.coding_vm')::uuid; t timestamptz; held bigint; balance jsonb;
begin
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.coding-computer-prepare/v2','requestId',attempt,
        'workerId',(pg_temp.worker_row('fix-send')).id,'leaseToken','63700000-0000-4000-8000-000000000001',
        'machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
        'machineIdSha256',repeat('c',64),'hostBootId','64500000-0000-4000-8000-000000000011','windowMs',300000,'stopReserveMs',30000));
    initial:=pg_temp.prepare_coding(request,repeat('K',64));
    t:=clock_timestamp();
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
        'hostBootId',request->'hostBootId','hostUptimeMs',1000000,'physicalId','63700000-0000-4000-8000-000000000002',
        'guestBootId','64500000-0000-4000-8000-000000000012','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    perform public.qorpera_bind_coding_computer_permit(jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('K',64));
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1000100,'guestUptimeMs',100100,'observedAt',t+interval '100 milliseconds');
    renewal:=jsonb_build_object('requestId',next_window,'permitId',attempt,'generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000);
    -- Deliberately discard the committed receipt: the guard never armed N+1.
    perform public.qorpera_renew_coding_computer_permit(renewal,repeat('K',64));
    select reserved_us into held from public.qorpera_computer_allowance_reservations where id=next_window;
    perform pg_temp.wake_assert((select generation=2 from public.qorpera_coding_computer_permits where id=attempt)
        and (select settled_at is not null from public.qorpera_computer_allowance_reservations where id=attempt)
        and (select debited_us=50000 from public.qorpera_computer_allowance_settlements where reservation_id=attempt)
        and (select settled_at is null from public.qorpera_computer_allowance_reservations where id=next_window),
        'Lost renewal failed to settle N and retain the distinct N+1 hold');
    -- The live executor registration changes before terminal recovery. The old
    -- enrollment may close its own permit, but may not fund or observe new work.
    update public.qorpera_coding_machines set owner='exec-successor' where id=machine;
    insert into public.qorpera_computer_executor_keys(environment_id,owner,machine_id_sha256,key_sha256)
        values('30000000-0000-4000-8000-000000000020','exec-successor',repeat('c',64),encode(extensions.digest(convert_to(repeat('S',64),'UTF8'),'sha256'),'hex'));
    perform pg_temp.wake_error(format('select public.qorpera_describe_coding_computer_permit(%L,%L)',request,repeat('K',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_renew_coding_computer_permit(%L,%L)',renewal,repeat('K',64)),'42501');
    recovered:=public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64));
    perform pg_temp.wake_assert(recovered->>'state'='bound' and recovered#>>'{permit,generation}'='2'
        and recovered#>>'{permit,epoch}'=initial->>'epoch' and recovered#>>'{permit,reservationId}'=next_window::text
        and recovered->'lastSample'=sample, 'Immutable recovery lost committed renewal or observation predecessor');
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1000200,'guestUptimeMs',null,'observedAt',t+interval '200 milliseconds','state','stopped');
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',attempt,'generation',2,'sample',sample,'guardClosed',true);
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal,repeat('S',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,null)',terminal),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal||'{"guardClosed":false}',repeat('K',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal||'{"generation":1}',repeat('K',64)),'PGRST');
    begin
        update public.qorpera_computer_executor_keys set revoked_at=clock_timestamp() where owner='exec-test';
        perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal,repeat('K',64)),'42501');
        raise exception using errcode='QT645';
    exception when sqlstate 'QT645' then null; end;
    perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal,repeat('K',64)),'42501');
    perform pg_temp.path_claims('service_role');
    perform pg_temp.wake_assert(public.qorpera_observe_computer_usage(jsonb_build_object('allocationId',machine,'observationId',extensions.gen_random_uuid()))->>'reason'='paid_meter_owned',
        'Observer obtained terminal accounting authority');
    receipt:=public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and receipt->>'generation'='2' and receipt->>'validForMs'='0'
        and receipt->>'epoch'=initial->>'epoch' and receipt->>'reservationId'=next_window::text
        and public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64))=receipt,
        'Original host could not finish committed N+1 idempotently after live owner changed');
    perform pg_temp.wake_assert((select debited_us=0 and released_us=held from public.qorpera_computer_allowance_settlements where reservation_id=next_window)
        and (select reserved_us=0 and debited_us=50000 from public.qorpera_computer_allowance_buckets where invoice_id='in_permits')
        and (select closed and active_ms=100 from public.qorpera_computer_usage_streams where allocation_id=machine and epoch=(initial->>'epoch')::uuid)
        and (select count(*)=2 from public.qorpera_computer_allowance_settlements where allocation_id=machine and epoch=(initial->>'epoch')::uuid),
        'Terminal recovery double-debited N, invented stopped time, or leaked the N+1 hold');
    recovered:=public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64));
    perform pg_temp.wake_assert(recovered->>'state'='closed' and recovered->'permit'=receipt and recovered->'lastSample'=sample,
        'Closed historical receipt lost exact terminal identity');
    select jsonb_build_array(reserved_us,debited_us) into balance from public.qorpera_computer_allowance_buckets where invoice_id='in_permits';
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',
        terminal||jsonb_build_object('sample',sample||'{"hostUptimeMs":1000201}'),repeat('K',64)),'23505');
    perform pg_temp.wake_assert((select jsonb_build_array(reserved_us,debited_us)=balance from public.qorpera_computer_allowance_buckets where invoice_id='in_permits'),
        'Conflicting finish replay changed funded balance');
end $$;
do $$ declare role_name text; v_owner oid; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_coding_computer_terminal_host(uuid,text)','EXECUTE'),
            'Private terminal host authority exposed');
    end loop;
    select proowner into strict v_owner from pg_proc where oid='public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure;
    perform pg_temp.wake_assert(has_function_privilege(v_owner,'public.qorpera_coding_computer_terminal_host(uuid,text)','EXECUTE'),
        'Finish definer lost private terminal host authority');
    select proowner into strict v_owner from pg_proc where oid='public.qorpera_coding_computer_terminal_host(uuid,text)'::regprocedure;
    perform pg_temp.wake_assert(has_function_privilege(v_owner,'public.qorpera_computer_prestart_identity(jsonb,text,text)','EXECUTE')
        and has_function_privilege(v_owner,'public.qorpera_computer_executor_machine(uuid,text)','EXECUTE'),
        'Terminal helper lost reviewed private call edges');
end $$;
rollback;
