-- @fixture 670_coding_guard_usage_recovery.test.sql until "do $$ declare machine uuid:="
-- Synthetic paired-clock arithmetic only; real Linux observations are proved by
-- workload-usage-case. Fixture window timestamps move together into the past.
do $$ <<meter>>
declare
    scenario jsonb; offsets jsonb; guests jsonb; states jsonb; coverages jsonb;
    machine uuid:=current_setting('qorpera_test.coding_vm')::uuid; id uuid; request jsonb; permit jsonb;
    sample jsonb; frame jsonb; previous jsonb; receipt jsonb; stop jsonb; renew jsonb;
    t timestamptz; sample_index integer; elapsed bigint; charged bigint; prior_debit bigint; anchor_id uuid;
begin
    for scenario in select value from jsonb_array_elements('[
        {"name":"jitter-renew","host":[0,5000,10000],"guest":[0,4000,10000],"state":["running","running","running"],"coverage":["initial","continuous","continuous"],"active":10000},
        {"name":"reverse-jitter","host":[0,5000,10000],"guest":[0,6000,10000],"state":["running","running","running"],"coverage":["initial","continuous","continuous"],"active":10000},
        {"name":"cumulative-drift","host":[0,5000,10000,15000,20000],"guest":[0,4500,9000,13500,18500],"state":["running","running","running","running","running"],"coverage":["initial","continuous","continuous","gap","continuous"],"active":15000},
        {"name":"explicit-gap","host":[0,5000,10000,15000,20000],"guest":[0,4000,null,15000,20000],"state":["running","running","gap","running","running"],"coverage":["initial","continuous","gap","gap","continuous"],"active":10000},
        {"name":"frozen-clock","host":[0,500,1000,6000],"guest":[0,0,500,5500],"state":["running","running","running","running"],"coverage":["initial","gap","continuous","continuous"],"active":5500},
        {"name":"backward-clock","host":[0,500,1000,6000],"guest":[1000,500,1000,6000],"state":["running","running","running","running"],"coverage":["initial","gap","continuous","continuous"],"active":5500},
        {"name":"long-gap","host":[0,5000,25000,30000],"guest":[0,5000,25000,30000],"state":["running","running","running","running"],"coverage":["initial","continuous","gap","continuous"],"active":10000}
    ]'::jsonb) loop
        offsets:=scenario->'host'; guests:=scenario->'guest'; states:=scenario->'state'; coverages:=scenario->'coverage';
        elapsed:=(offsets->>-1)::bigint; t:=clock_timestamp()-make_interval(secs=>(elapsed+1000)::double precision/1000);
        id:=extensions.gen_random_uuid(); previous:=null; sample:=null;
        select debited_us into prior_debit from public.qorpera_computer_allowance_buckets where invoice_id='in_permits';
        request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.coding-computer-prepare/v3','usageProducer','guard-v1','requestId',id,
            'workerId',(pg_temp.worker_row('fix-send')).id,'leaseToken','63700000-0000-4000-8000-000000000001',
            'machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
            'machineIdSha256',repeat('c',64),'hostBootId',extensions.gen_random_uuid(),'windowMs',300000,'stopReserveMs',30000));
        update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp() where allocation_id=machine;
        permit:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
        update public.qorpera_coding_computer_windows set issued_at=t-interval '1 second',deadline=t+interval '329 seconds' where permit_id=id;
        update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=machine and epoch=(permit->>'epoch')::uuid;
        update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=machine and epoch=(permit->>'epoch')::uuid and sequence=0;
        permit:=public.qorpera_computer_permit_receipt(id,1);
        for sample_index in 1..jsonb_array_length(offsets) loop
            sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
                'hostBootId',request->'hostBootId','hostUptimeMs',1000000+(offsets->>(sample_index-1))::bigint,
                'physicalId','63700000-0000-4000-8000-000000000002','guestBootId','67100000-0000-4000-8000-000000000012',
                'guestUptimeMs',guests->(sample_index-1),'state',states->(sample_index-1),'evidenceSha256',repeat('a',64),
                'observedAt',t+make_interval(secs=>(offsets->>(sample_index-1))::double precision/1000));
            frame:=pg_temp.guard_entry(permit,sample_index,previous->>'sha256',sample);
            receipt:=public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',id,'generation',permit->'generation','entries',jsonb_build_array(frame)),repeat('K',64));
            perform pg_temp.wake_assert((select coverage=coverages->>(sample_index-1) from public.qorpera_coding_computer_samples
                where permit_id=id and observation_id=(meter.sample->>'observationId')::uuid),'Coverage differs for '||(scenario->>'name'));
            perform pg_temp.wake_assert(public.qorpera_computer_sample_ready(id,sample)=((coverages->>(sample_index-1)) in ('initial','continuous')),
                'Unconfirmed clock admitted new work for '||(scenario->>'name'));
            renew:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',id,'generation',permit->'generation',
                'sample',sample,'windowMs',300000,'stopReserveMs',30000);
            if coverages->>(sample_index-1)='gap' then
                perform pg_temp.wake_error(format('select public.qorpera_renew_coding_computer_permit(%L,%L)',renew,repeat('K',64)),'55000');
            end if;
            if scenario->>'name'='jitter-renew' and sample_index=2 then
                select observation_id into anchor_id from public.qorpera_computer_clock_segments where permit_id=id;
                permit:=public.qorpera_renew_coding_computer_permit(renew,repeat('K',64));
                update public.qorpera_coding_computer_windows set issued_at=(sample->>'observedAt')::timestamptz where permit_id=id and generation=2;
                permit:=public.qorpera_computer_permit_receipt(id,2);
                perform pg_temp.wake_assert((select observation_id=anchor_id from public.qorpera_computer_clock_segments where permit_id=id),
                    'Renewal reset the corroboration segment');
                perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',id,'generation',2,'entries',jsonb_build_array(frame)),repeat('K',64));
                perform pg_temp.wake_assert((select observation_id=anchor_id from public.qorpera_computer_clock_segments where permit_id=id)
                    and (select debited_us=prior_debit+2500000 from public.qorpera_computer_allowance_buckets where invoice_id='in_permits'),
                    'Lost reply/replay changed anchor or historical settlement');
            end if;
            previous:=frame;
        end loop;
        charged:=(scenario->>'active')::bigint;
        perform pg_temp.wake_assert((select active_ms=charged and elapsed_ms=elapsed from public.qorpera_computer_usage_streams
            where allocation_id=machine and epoch=(permit->>'epoch')::uuid),'Host elapsed charge differs for '||(scenario->>'name'));
        sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',sample->'observationId',
            'hostUptimeMs',1000000+elapsed+500,'guestUptimeMs',null,'state','stopped','observedAt',t+make_interval(secs=>(elapsed+500)::double precision/1000));
        stop:=jsonb_build_object('permitId',id,'generation',permit->'generation','allocationId',machine,'instanceSha256',permit->'instanceSha256',
            'physicalInstanceId',sample->'physicalId','hostBootId',request->'hostBootId','observedUptimeMs',1000000+elapsed,
            'closedAtUptimeMs',sample->'hostUptimeMs','closedHostBootId',request->'hostBootId','state','stopped','operationId',extensions.gen_random_uuid());
        frame:=pg_temp.guard_entry(permit,jsonb_array_length(offsets)+1,previous->>'sha256',sample,stop);
        perform public.qorpera_record_computer_guard_samples(jsonb_build_object('permitId',id,'generation',permit->'generation','entries',jsonb_build_array(frame)),repeat('K',64));
        perform public.qorpera_finish_coding_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',id,
            'generation',permit->'generation','sample',sample,'guardClosed',true),repeat('K',64));
        perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_clock_segments where permit_id=id)
            and (select reserved_us=0 and debited_us=prior_debit+charged*500 from public.qorpera_computer_allowance_buckets where invoice_id='in_permits'),
            'Terminal billed uncertainty or changed prior debit for '||(scenario->>'name'));
    end loop;
end $$;
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_computer_clock_segments','SELECT,INSERT,UPDATE,DELETE')
    and not has_function_privilege('service_role','public.qorpera_computer_clock_segment(uuid,jsonb,jsonb,boolean)','EXECUTE')
    and not has_function_privilege('authenticated','public.qorpera_computer_sample_ready(uuid,jsonb)','EXECUTE'),
    'Untrusted caller can change corroboration anchors or bypass paid sample validation');
rollback;
