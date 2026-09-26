-- @fixture 640_runtime_computer_permits.test.sql until "do $$ declare b jsonb:="
-- Synthetic physical facts, actual native PostgreSQL authorization and ledger.
create function pg_temp.guard_entry(p_permit jsonb,p_sequence bigint,p_previous text,p_sample jsonb,p_stop jsonb default null)
returns jsonb language plpgsql as $$
declare v_text text;
begin
    v_text:=jsonb_build_object('schema','qorpera.computer-guard-usage-entry/v1','sequence',p_sequence,
        'previousSha256',p_previous,'permit',p_permit-'runtimeContext'-'closure',
        'hostMachineIdSha256',repeat('c',64),'physicalInstanceId',p_sample->'physicalId',
        'deadlineUptimeMs',1330000,'stopAtUptimeMs',1300000,'sample',p_sample,'stopReceipt',p_stop)::text||chr(10);
    return jsonb_build_object('sequence',p_sequence,'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'),'entryText',v_text);
end $$;
do $$ declare b jsonb:=current_setting('qorpera_test.runtime_paid_binding')::jsonb; request jsonb; initial jsonb;
    sample jsonb; next_sample jsonb; receipt jsonb; captured jsonb; entry jsonb; previous jsonb; terminal jsonb; stop jsonb;
    batch jsonb; upload jsonb; again jsonb; stale_sample jsonb; allocation uuid; t timestamptz:=clock_timestamp()-interval '91 seconds';
    attempt uuid:='66900000-0000-4000-8000-000000000010'; renewal uuid:='66900000-0000-4000-8000-000000000020';
    i integer;
begin
    select client_runner_id into strict allocation from public.qorpera_runners where id=(b->>'runnerId')::uuid;
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.runtime-computer-prepare/v2',
        'requestId',attempt,'allocationId',allocation,'providerKind','native','providerId','process','policySha256',repeat('f',64),
        'instanceSha256',repeat('d',64),'machineIdSha256',repeat('c',64),'hostBootId','66900000-0000-4000-8000-000000000011',
        'bootstrapSha256',repeat('b',64),'runId',b->'runId','runnerId',b->'runnerId','officeId',null,'computerGeneration',null,
        'windowMs',300000,'stopReserveMs',30000));
    initial:=public.qorpera_prepare_runtime_computer_permit(request,repeat('R',64));
    -- Move only the fixture's initial clock origin; every upload below uses the
    -- canonical production receipt and verifies historical capture boundaries.
    update public.qorpera_coding_computer_windows set issued_at=t-interval '1 second',deadline=t+interval '329 seconds' where permit_id=attempt;
    update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=allocation;
    update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=allocation and sequence=0;
    initial:=public.qorpera_runtime_computer_receipt(attempt,1);
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
        values(allocation,'30000000-0000-4000-8000-000000000310','66900000-0000-4000-8000-000000000012','{}');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
        'hostBootId',request->'hostBootId','hostUptimeMs',1000000,'physicalId','66900000-0000-4000-8000-000000000012',
        'guestBootId','66900000-0000-4000-8000-000000000013','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    entry:=pg_temp.guard_entry(initial,1,null,sample);
    upload:=jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry));
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',upload,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
        jsonb_set(upload,'{entries,0,sha256}',to_jsonb(repeat('0',64))),repeat('R',64)),'23505');
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',upload||'{"generation":2}',repeat('R',64)),'PGRST');
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(pg_temp.guard_entry(initial||'{"generation":3}',1,null,sample))),repeat('R',64)),'PGRST');
    receipt:=public.qorpera_record_computer_guard_samples(upload,repeat('R',64));
    perform pg_temp.wake_assert(receipt#>>'{cursor,sequence}'='1' and receipt#>>'{permit,state}'='bound'
        and (select active_ms=0 from public.qorpera_computer_usage_streams where allocation_id=allocation),
        'Durable initial sample did not bind without inventing startup usage');
    again:=public.qorpera_record_computer_guard_samples(upload,repeat('R',64));
    perform pg_temp.wake_assert(again->'cursor'=receipt->'cursor','Lost upload response appended duplicate checkpoint');
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(pg_temp.guard_entry(initial,1,null,sample||'{"guestUptimeMs":100001}'))),repeat('R',64)),'23505');
    -- Independent guard observes at five-second intervals while uploader is
    -- unavailable for ninety seconds. Two batches catch up exact awake time.
    batch:='[]'; previous:=entry;
    for i in 2..19 loop
        sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
            'hostUptimeMs',1000000+(i-1)*5000,'guestUptimeMs',100000+(i-1)*5000,'observedAt',t+make_interval(secs=>(i-1)*5));
        entry:=pg_temp.guard_entry(initial,i,previous->>'sha256',sample);
        if i=2 then
            perform pg_temp.wake_error(format('select public.qorpera_checkpoint_runtime_computer_permit(%L,%L)',
                jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('R',64)),'42501');
            perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
                jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(pg_temp.guard_entry(initial,3,previous->>'sha256',sample))),repeat('R',64)),'23505');
            perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
                jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(pg_temp.guard_entry(initial||'{"cpuMillis":4000}',2,previous->>'sha256',sample))),repeat('R',64)),'42501');
            perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
                jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(pg_temp.guard_entry(initial,2,previous->>'sha256',sample||'{"hostUptimeMs":1330001}'))),repeat('R',64)),'42501');
            -- A bad later entry rolls back the earlier valid one in its batch.
            perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
                jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry,pg_temp.guard_entry(initial,4,entry->>'sha256',sample))),repeat('R',64)),'23505');
            perform pg_temp.wake_assert((select sequence=1 from public.qorpera_computer_guard_sample_cursors where permit_id=attempt)
                and (select count(*)=1 from public.qorpera_computer_guard_sample_entries where permit_id=attempt),'Malformed batch partially advanced financial cursor');
        end if;
        batch:=batch||jsonb_build_array(entry); previous:=entry;
        if i in (17,19) then
            receipt:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',batch),repeat('R',64));
            batch:='[]';
        end if;
    end loop;
    perform pg_temp.wake_assert((select active_ms=90000 and last_sequence=19 from public.qorpera_computer_usage_streams where allocation_id=allocation),
        'Delayed durable samples lost outage usage or charged duplicate time');
    -- A concurrently delayed renew must not settle an older running checkpoint
    -- merely because a newer sample makes the stream fresh enough to renew.
    select stored.entry->'sample' into strict stale_sample from public.qorpera_computer_guard_sample_entries stored where permit_id=attempt and sequence=18;
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',
        jsonb_build_object('requestId',renewal,'permitId',attempt,'generation',1,'sample',stale_sample,'windowMs',300000,'stopReserveMs',30000),repeat('R',64)),'55000');
    stale_sample:=sample;
    next_sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId','state','gap','guestUptimeMs',null);
    entry:=pg_temp.guard_entry(initial,20,previous->>'sha256',next_sample);
    perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('R',64));
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',
        jsonb_build_object('requestId',renewal,'permitId',attempt,'generation',1,'sample',stale_sample,'windowMs',300000,'stopReserveMs',30000),repeat('R',64)),'55000');
    -- Historical exact checkpoint replay is still harmless and supported.
    perform public.qorpera_checkpoint_runtime_computer_permit(jsonb_build_object('permitId',attempt,'generation',1,'sample',stale_sample),repeat('R',64));
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',next_sample->'observationId');
    previous:=entry; entry:=pg_temp.guard_entry(initial,21,previous->>'sha256',sample);
    perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('R',64));
    previous:=entry;
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',
        jsonb_build_object('requestId',renewal,'permitId',attempt,'generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000),repeat('R',64)),'55000');
    -- The first running endpoint after a gap cannot prove the missing interval.
    -- A subsequent positive paired interval restores renewal authority.
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1090100,'guestUptimeMs',190100,'observedAt',t+interval '90.1 seconds');
    entry:=pg_temp.guard_entry(initial,22,previous->>'sha256',sample);
    perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('R',64));
    previous:=entry;
    perform pg_temp.wake_assert((select generation=1 from public.qorpera_coding_computer_permits where id=attempt)
        and (select count(*)=1 from public.qorpera_coding_computer_windows where permit_id=attempt), 'Rejected stale renewal allocated another hold');
    captured:=initial;
    initial:=public.qorpera_renew_runtime_computer_permit(jsonb_build_object('requestId',renewal,'permitId',attempt,'generation',1,
        'sample',sample,'windowMs',300000,'stopReserveMs',30000),repeat('R',64));
    perform pg_temp.wake_assert((select debited_us=45050000 from public.qorpera_computer_allowance_settlements where reservation_id=attempt),
        'Ninety seconds plus the confirmed recovery pair must debit exactly45.05 standard seconds');
    -- One sample captured under N races the SQL N+1 response. Its exact prefix
    -- belongs to the current hold, never the already settled reservation.
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1090600,'guestUptimeMs',190600,'observedAt',t+interval '90.6 seconds');
    entry:=pg_temp.guard_entry(captured,23,previous->>'sha256',sample);
    upload:=jsonb_build_object('permitId',attempt,'generation',2,'entries',jsonb_build_array(entry));
    receipt:=public.qorpera_record_computer_guard_samples(upload,repeat('R',64));
    perform pg_temp.wake_assert(receipt#>>'{cursor,sequence}'='23' and (select applied_generation=2 from public.qorpera_computer_guard_sample_entries where permit_id=attempt and sequence=23),
        'Adjacent captured generation did not continue into unsettled hold');
    previous:=entry;
    -- A source registration change must not strand already captured usage.
    update public.qorpera_runners set client_runner_id=extensions.gen_random_uuid() where id=(b->>'runnerId')::uuid;
    next_sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1090700,'guestUptimeMs',null,'observedAt',t+interval '90.7 seconds','state','stopped');
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',attempt,'generation',2,'sample',next_sample,'guardClosed',true);
    perform pg_temp.wake_error(format('select public.qorpera_finish_runtime_computer_permit(%L,%L)',terminal,repeat('R',64)),'55000');
    stop:=jsonb_build_object('permitId',attempt,'generation',1,'allocationId',allocation,'instanceSha256',repeat('d',64),
        'physicalInstanceId',sample->'physicalId','hostBootId',request->'hostBootId','observedUptimeMs',1090650,'closedAtUptimeMs',1090700,
        'closedHostBootId',request->'hostBootId','state','stopped','operationId',extensions.gen_random_uuid());
    entry:=pg_temp.guard_entry(captured,24,previous->>'sha256',next_sample,stop);
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',2,'entries',jsonb_build_array(pg_temp.guard_entry(captured,24,previous->>'sha256',next_sample,stop||'{"closedAtUptimeMs":1090701}'))),repeat('R',64)),'42501');
    upload:=jsonb_build_object('permitId',attempt,'generation',2,'entries',jsonb_build_array(entry));
    receipt:=public.qorpera_record_computer_guard_samples(upload,repeat('R',64));
    perform pg_temp.wake_assert(receipt->'sealed'='true' and receipt#>>'{cursor,sequence}'='24','Terminal prefix was not sealed');
    receipt:=public.qorpera_finish_runtime_computer_permit(terminal,repeat('R',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and (select debited_us=250000 from public.qorpera_computer_allowance_settlements where reservation_id=renewal)
        and (select reserved_us=0 and debited_us=45300000 from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime')
        and (select closed and active_ms=90600 from public.qorpera_computer_usage_streams where allocation_id=allocation),
        'Sealed settlement double charged, invented terminal time or leaked a hold');
    again:=public.qorpera_record_computer_guard_samples(upload||'{"generation":1}',repeat('R',64));
    perform pg_temp.wake_assert(again#>>'{cursor,sequence}'='24' and again#>>'{permit,state}'='closed',
        'Exact terminal upload replay required stale generation or current source');
    perform pg_temp.wake_assert(public.qorpera_finish_runtime_computer_permit(terminal,repeat('R',64))=receipt,'Finish replay changed final receipt');
    perform pg_temp.wake_error(format('update public.qorpera_computer_guard_sample_entries set sha256=%L where permit_id=%L',repeat('f',64),attempt),'42501');
end $$;
do $$ declare role_name text; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(role_name,'public.qorpera_computer_guard_sample_entries','SELECT,INSERT,UPDATE,DELETE')
            and not has_table_privilege(role_name,'public.qorpera_computer_guard_sample_cursors','SELECT,INSERT,UPDATE,DELETE'), 'Guard usage storage exposed');
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean)','EXECUTE'), 'Legacy writer bypass exposed');
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_assert_computer_guard_renew(uuid,jsonb)','EXECUTE'), 'Private renewal fence exposed');
    end loop;
end $$;
rollback;
