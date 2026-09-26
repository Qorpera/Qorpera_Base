-- @fixture 670_coding_guard_usage_recovery.test.sql until "do $$ declare machine uuid:="
-- Actual SQL prepare pins the producer before any physical observation. No VM
-- is started here; clock values below are explicit deterministic test data.
do $$ declare machine uuid:=current_setting('qorpera_test.coding_vm')::uuid;
    request jsonb; legacy jsonb; permit jsonb; sample jsonb; frame jsonb; result jsonb; again jsonb; stop jsonb; first_frame jsonb;
    attempt uuid:='67200000-0000-4000-8000-000000000010'; t timestamptz:=clock_timestamp()-interval '2 seconds';
begin
    legacy:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.coding-computer-prepare/v2','requestId',attempt,
        'workerId',(pg_temp.worker_row('fix-send')).id,'leaseToken','63700000-0000-4000-8000-000000000001',
        'machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
        'machineIdSha256',repeat('c',64),'hostBootId','67200000-0000-4000-8000-000000000011','windowMs',300000,'stopReserveMs',30000));
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',legacy,repeat('K',64)),'55000');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_prestart_attempts where permit_id=attempt)
        and not exists(select 1 from public.qorpera_coding_computer_permits where id=attempt),
        'Fresh unmarked request left authority or a financial hold');
    begin
        -- A retained legacy attempt still prepares/settles under its original
        -- producer. It cannot be silently converted into a guard-owned stream.
        permit:=pg_temp.prepare_coding(legacy,repeat('K',64));
        perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_guard_sample_cursors where permit_id=attempt),
            'Retained legacy attempt acquired a different producer');
        perform pg_temp.wake_error(format('select public.qorpera_record_computer_guard_samples(%L,%L)',
            jsonb_build_object('permitId',attempt,'generation',1,'entries','[{}]'::jsonb),repeat('K',64)),'55000');
        -- Reconstruct a committed pre-128 first guard upload using operator-only
        -- table access. The old immutable request remains v2/unmarked. Every
        -- subsequent upload and settlement below uses the current public RPCs.
        update public.qorpera_coding_computer_windows set issued_at=t-interval '1 second',deadline=t+interval '329 seconds' where permit_id=attempt;
        update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=machine;
        update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=machine and sequence=0;
        permit:=public.qorpera_computer_permit_receipt(attempt,1);
        sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
            'hostBootId',legacy->'hostBootId','hostUptimeMs',1000000,'physicalId','63700000-0000-4000-8000-000000000002',
            'guestBootId','67200000-0000-4000-8000-000000000012','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
        perform public.qorpera_bind_coding_computer_permit(jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('K',64));
        first_frame:=pg_temp.guard_entry(permit,1,null,sample);
        insert into public.qorpera_computer_guard_sample_entries(permit_id,sequence,sha256,entry_text,entry,applied_generation,observation_id)
            values(attempt,1,first_frame->>'sha256',first_frame->>'entryText',(first_frame->>'entryText')::jsonb,1,(sample->>'observationId')::uuid);
        insert into public.qorpera_computer_guard_sample_cursors(permit_id,sequence,sha256,observation_id)
            values(attempt,1,first_frame->>'sha256',(sample->>'observationId')::uuid);
        sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
            'hostUptimeMs',1001000,'guestUptimeMs',101000,'observedAt',t+interval '1 second');
        frame:=pg_temp.guard_entry(permit,2,first_frame->>'sha256',sample);
        perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(frame)),repeat('K',64));
        sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
            'hostUptimeMs',1002000,'guestUptimeMs',null,'observedAt',t+interval '2 seconds','state','stopped');
        stop:=jsonb_build_object('permitId',attempt,'generation',1,'allocationId',machine,'instanceSha256',permit->'instanceSha256',
            'physicalInstanceId',sample->'physicalId','hostBootId',legacy->'hostBootId','observedUptimeMs',1001500,'closedAtUptimeMs',1002000,
            'closedHostBootId',sample->'hostBootId','state','stopped','operationId',extensions.gen_random_uuid());
        frame:=pg_temp.guard_entry(permit,3,frame->>'sha256',sample,stop);
        perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(frame)),repeat('K',64));
        result:=public.qorpera_finish_coding_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
            'permitId',attempt,'generation',1,'sample',sample,'guardClosed',true),repeat('K',64));
        perform pg_temp.wake_assert(result->>'state'='closed' and (select reserved_us=0 and debited_us=500000 from public.qorpera_computer_allowance_buckets where invoice_id='in_permits'),
            'Retained pre-128 guard producer could not settle its confirmed interval');
        result:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(first_frame)),repeat('K',64));
        perform pg_temp.wake_assert(result#>>'{permit,state}'='closed' and result#>>'{cursor,sequence}'='3',
            'Retained old producer exact replay lost canonical terminal authority');
        raise exception 'rollback retained fixture' using errcode='P0002';
    exception when no_data_found then null; end;
    request:=pg_temp.prestart_request(legacy||'{"usageProducer":"guard-v1"}');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',
        request||'{"usageProducer":"other"}',repeat('K',64)),'22023');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',
        request||'{"schema":"qorpera.coding-computer-prepare/v2"}',repeat('K',64)),'22023');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',
        request||jsonb_build_object('prepareRequestText',legacy->'prepareRequestText'),repeat('K',64)),'23505');
    permit:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    perform pg_temp.wake_assert(exists(select 1 from public.qorpera_computer_guard_sample_cursors
        where permit_id=attempt and sequence=0 and sha256 is null and observation_id is null and not sealed),
        'Prepare returned without the one-producer fence');
    again:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    perform pg_temp.wake_assert(again->'reservationId'=permit->'reservationId'
        and (select count(*)=1 from public.qorpera_computer_guard_sample_cursors where permit_id=attempt),'Prepare replay changed producer or hold');
    update public.qorpera_coding_computer_windows set issued_at=t-interval '1 second',deadline=t+interval '329 seconds' where permit_id=attempt;
    update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=machine;
    update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=machine and sequence=0;
    permit:=public.qorpera_computer_permit_receipt(attempt,1);
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
        'hostBootId',request->'hostBootId','hostUptimeMs',1000000,'physicalId','63700000-0000-4000-8000-000000000002',
        'guestBootId','67200000-0000-4000-8000-000000000012','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    perform pg_temp.wake_error(format('select public.qorpera_bind_coding_computer_permit(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('K',64)),'42501');
    perform pg_temp.wake_assert((select last_sample is null and state='prepared' from public.qorpera_coding_computer_permits where id=attempt),
        'Stale raw writer won before first guard upload');
    frame:=pg_temp.guard_entry(permit,1,null,sample);
    result:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(frame)),repeat('K',64));
    -- Replay returns current authority with a decreasing deadline budget, not
    -- an identical wall-clock-dependent validForMs value.
    perform pg_sleep(0.02);
    again:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(frame)),repeat('K',64));
    perform pg_temp.wake_assert((result #- '{permit,validForMs}')=(again #- '{permit,validForMs}')
        and (again#>>'{permit,validForMs}')::bigint<(result#>>'{permit,validForMs}')::bigint
        and (again#>>'{permit,validForMs}')::bigint>0
        and result#>>'{permit,state}'='bound' and result#>>'{cursor,sequence}'='1',
        'Guard first bind or exact upload replay failed after stale raw writer');
    perform pg_temp.wake_error(format('select public.qorpera_checkpoint_coding_computer_permit(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',1,'sample',sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),
            'previousObservationId',sample->'observationId')),repeat('K',64)),'42501');
    perform pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_pin_computer_guard_producer()','execute')
        and not has_function_privilege('authenticated','public.qorpera_pin_computer_guard_producer()','execute'),
        'Producer pin trigger leaked to an API role');
end $$;
rollback;
