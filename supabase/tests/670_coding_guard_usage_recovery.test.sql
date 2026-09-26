-- @fixture 637_coding_computer_permits.test.sql until "do $$ declare request jsonb; receipt jsonb;"
create function pg_temp.guard_entry(p_permit jsonb,p_sequence bigint,p_previous text,p_sample jsonb,p_stop jsonb default null)
returns jsonb language plpgsql as $$
declare v_text text;
begin
    v_text:=jsonb_build_object('schema','qorpera.computer-guard-usage-entry/v1','sequence',p_sequence,
        'previousSha256',p_previous,'permit',p_permit-'closure','hostMachineIdSha256',repeat('c',64),
        'physicalInstanceId',p_sample->'physicalId','deadlineUptimeMs',1330000,'stopAtUptimeMs',1300000,
        'sample',p_sample,'stopReceipt',p_stop)::text||chr(10);
    return jsonb_build_object('sequence',p_sequence,'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'),'entryText',v_text);
end $$;
do $$ declare machine uuid:=current_setting('qorpera_test.coding_vm')::uuid; attempt uuid:='67000000-0000-4000-8000-000000000010';
    request jsonb; permit jsonb; sample jsonb; entry jsonb; receipt jsonb; previous jsonb; terminal jsonb; stop jsonb; stale_sample jsonb;
    t timestamptz:=clock_timestamp()-interval '30 seconds';
begin
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.coding-computer-prepare/v2','requestId',attempt,
        'workerId',(pg_temp.worker_row('fix-send')).id,'leaseToken','63700000-0000-4000-8000-000000000001',
        'machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
        'machineIdSha256',repeat('c',64),'hostBootId','67000000-0000-4000-8000-000000000011','windowMs',300000,'stopReserveMs',30000));
    permit:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    update public.qorpera_coding_computer_windows set issued_at=t-interval '1 second',deadline=t+interval '329 seconds' where permit_id=attempt;
    update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=machine;
    update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=machine and sequence=0;
    permit:=public.qorpera_computer_permit_receipt(attempt,1);
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
        'hostBootId',request->'hostBootId','hostUptimeMs',1000000,'physicalId','63700000-0000-4000-8000-000000000002',
        'guestBootId',null,'guestUptimeMs',null,'observedAt',t,'state','gap','evidenceSha256',repeat('a',64));
    entry:=pg_temp.guard_entry(permit,1,null,sample);
    receipt:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('K',64));
    perform pg_temp.wake_assert(receipt#>>'{permit,state}'='prepared','Unconfirmed clock incorrectly admitted paid work');
    previous:=entry;
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1005000,'guestUptimeMs',5000,'guestBootId','67000000-0000-4000-8000-000000000012','observedAt',t+interval '5 seconds','state','running');
    entry:=pg_temp.guard_entry(permit,2,previous->>'sha256',sample);
    receipt:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('K',64));
    perform pg_temp.wake_assert(receipt#>>'{permit,state}'='bound' and (select active_ms=0 from public.qorpera_computer_usage_streams where allocation_id=machine),
        'First confirmed running clock backfilled unknown boot time');
    previous:=entry;
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1010000,'guestUptimeMs',10000,'observedAt',t+interval '10 seconds');
    entry:=pg_temp.guard_entry(permit,3,previous->>'sha256',sample);
    perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('K',64));
    previous:=entry;
    -- Guard replacement cannot bridge its unobserved interval by VM uptime.
    stale_sample:=sample;
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostUptimeMs',1020000,'guestUptimeMs',null,'observedAt',t+interval '20 seconds','state','gap');
    entry:=pg_temp.guard_entry(permit,4,previous->>'sha256',sample);
    perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('K',64));
    perform pg_temp.wake_error(format('select public.qorpera_renew_coding_computer_permit(%L,%L)',
        jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',attempt,'generation',1,'sample',stale_sample,
            'windowMs',300000,'stopReserveMs',30000),repeat('K',64)),'55000');
    previous:=entry;
    -- Lost current worker/machine state is not a loss of original stop custody.
    update public.qorpera_coding_machines set removing_at=clock_timestamp(),removed_at=clock_timestamp() where id=machine;
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
        'hostBootId','67000000-0000-4000-8000-000000000014','hostUptimeMs',1000,'observedAt',t+interval '25 seconds','state','stopped');
    stop:=jsonb_build_object('permitId',attempt,'generation',1,'allocationId',machine,'instanceSha256',permit->'instanceSha256',
        'physicalInstanceId',sample->'physicalId','hostBootId',request->'hostBootId','observedUptimeMs',900,'closedAtUptimeMs',1000,
        'closedHostBootId',sample->'hostBootId','state','stopped','operationId',extensions.gen_random_uuid());
    entry:=pg_temp.guard_entry(permit,5,previous->>'sha256',sample,stop);
    receipt:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',attempt,'generation',1,'entries',jsonb_build_array(entry)),repeat('K',64));
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',attempt,'generation',1,'sample',sample,'guardClosed',true);
    receipt:=public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and (select active_ms=5000 and closed from public.qorpera_computer_usage_streams where allocation_id=machine)
        and (select reserved_us=0 and debited_us=2500000 from public.qorpera_computer_allowance_buckets where invoice_id='in_permits'),
        'Host reboot/guard gap invented usage or lost exact confirmed interval');
end $$;
rollback;
