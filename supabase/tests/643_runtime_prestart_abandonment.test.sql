-- @fixture 640_runtime_computer_permits.test.sql until "do $$ declare b jsonb:="
create function pg_temp.runtime_abandon_request(p_request jsonb) returns jsonb language plpgsql as $$
declare r jsonb:=pg_temp.prestart_request(p_request); begin
    return jsonb_build_object('schema','qorpera.computer-abandon/v1','requestId',extensions.gen_random_uuid(),
        'permitId',r->'requestId','generation',1,'prepareRequestText',r->'prepareRequestText','abandonment',jsonb_build_object(
        'schema','qorpera.computer-prestart-abandonment/v1','permitId',r->'requestId','allocationId',r->'allocationId',
        'instanceSha256',r->'instanceSha256','hostMachineIdSha256',r->'machineIdSha256','hostBootId',r->'hostBootId',
        'prepareSha256',r#>'{prestart,prepareSha256}','guardIncarnationId',r#>'{prestart,guardIncarnationId}'));
end $$;
do $$ declare b jsonb:=current_setting('qorpera_test.runtime_paid_binding')::jsonb; request jsonb; receipt jsonb; cancellation jsonb; result jsonb;
    allocation uuid; baseline bigint;
begin
    select client_runner_id into strict allocation from public.qorpera_runners where id=(b->>'runnerId')::uuid;
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.runtime-computer-prepare/v2',
        'requestId','64300000-0000-4000-8000-000000000010','allocationId',allocation,
        'providerKind','native','providerId','process','policySha256',repeat('f',64),'instanceSha256',repeat('d',64),
        'machineIdSha256',repeat('c',64),'hostBootId','64300000-0000-4000-8000-000000000011','bootstrapSha256',repeat('b',64),
        'runId',b->'runId','runnerId',b->'runnerId','officeId',null,'computerGeneration',null,'windowMs',300000,'stopReserveMs',30000));
    cancellation:=pg_temp.runtime_abandon_request(request);
    result:=public.qorpera_abandon_runtime_computer_permit(cancellation,repeat('R',64));
    perform pg_temp.wake_assert(result->'reservationReleased'='false' and not exists(select 1 from public.qorpera_runtime_machine_allocations where id=allocation),
        'Absent native cancellation allocated physical capacity');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_computer_permit(%L,%L)',request,repeat('R',64)),'55000');
    request:=pg_temp.prestart_request(request||jsonb_build_object('requestId','64300000-0000-4000-8000-000000000020'));
    cancellation:=pg_temp.runtime_abandon_request(request);
    receipt:=public.qorpera_prepare_runtime_computer_permit(request,repeat('R',64));
    select reserved_us into baseline from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime';
    perform pg_temp.wake_error(format('select public.qorpera_abandon_runtime_computer_permit(%L,%L)',cancellation,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',cancellation,repeat('R',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_abandon_runtime_computer_permit(%L,%L)',
        jsonb_set(cancellation,'{abandonment,hostBootId}',to_jsonb(extensions.gen_random_uuid())),repeat('R',64)),'42501');
    begin
        update public.qorpera_runtime_computer_host_keys set revoked_at=clock_timestamp() where provider_kind='native';
        perform pg_temp.wake_error(format('select public.qorpera_abandon_runtime_computer_permit(%L,%L)',cancellation,repeat('R',64)),'42501');
        raise exception using errcode='QT643';
    exception when sqlstate 'QT643' then null; end;
    -- A zero-use gap is still observation history, not undispatched evidence.
    begin
        perform public.qorpera_checkpoint_runtime_computer_permit(jsonb_build_object('permitId',request->'requestId','generation',1,'sample',jsonb_build_object(
            'observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',request->'hostBootId','hostUptimeMs',1000,
            'physicalId',null,'guestBootId',null,'guestUptimeMs',null,'observedAt',clock_timestamp(),'state','gap','evidenceSha256',repeat('a',64))),repeat('R',64));
        perform pg_temp.wake_error(format('select public.qorpera_abandon_runtime_computer_permit(%L,%L)',cancellation,repeat('R',64)),'55000');
        raise exception using errcode='QT643';
    exception when sqlstate 'QT643' then null; end;
    perform pg_temp.wake_assert((select reserved_us=baseline from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime'), 'Rejected cancellation changed hold');
    result:=public.qorpera_abandon_runtime_computer_permit(cancellation,repeat('R',64));
    perform pg_temp.wake_assert(result->'reservationReleased'='true' and public.qorpera_abandon_runtime_computer_permit(cancellation,repeat('R',64))=result
        and (select reserved_us=0 and debited_us=0 from public.qorpera_computer_allowance_buckets where invoice_id='in_runtime'), 'Native cancellation failed zero-use conservation');
    perform pg_temp.wake_assert((select released_at is null from public.qorpera_runtime_machine_allocations where id=allocation)
        and (select released_at is null from public.qorpera_runtime_node_demands where allocation_id=allocation), 'Unknown create lost physical custody');
    receipt:=public.qorpera_describe_runtime_computer_permit(request||jsonb_build_object('permitId',request->'requestId'),repeat('R',64));
    perform pg_temp.wake_assert(receipt#>'{permit,closure}'=result,'Native describe omitted terminal decision');
    -- A different completed attempt proves closed history recovery is not
    -- coupled to its old runner's current allocation/provider registration.
    request:=pg_temp.prestart_request(request||jsonb_build_object('requestId','64300000-0000-4000-8000-000000000030'));
    receipt:=public.qorpera_prepare_runtime_computer_permit(request,repeat('R',64));
    perform public.qorpera_finish_runtime_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
        'permitId',request->'requestId','generation',1,'guardClosed',true,'sample',jsonb_build_object(
        'observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',request->'hostBootId','hostUptimeMs',1000,
        'physicalId',null,'guestBootId',null,'guestUptimeMs',null,'observedAt',clock_timestamp(),'state','absent','evidenceSha256',repeat('a',64))),repeat('R',64));
    update public.qorpera_runners set client_runner_id=extensions.gen_random_uuid() where id=(b->>'runnerId')::uuid;
    perform pg_temp.wake_error(format('select public.qorpera_describe_runtime_computer_permit(%L,%L)',request,repeat('R',64)),'42501');
    receipt:=public.qorpera_describe_runtime_computer_prestart(request,repeat('R',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and receipt#>>'{permit,state}'='closed', 'Closed intent required obsolete live source authority');
    perform pg_temp.wake_error(format('select public.qorpera_describe_runtime_computer_prestart(%L,%L)',
        jsonb_set(request,'{prestart,guardIncarnationId}',to_jsonb(extensions.gen_random_uuid())),repeat('R',64)),'23505');

end $$;
rollback;
