-- @fixture 641_paid_office_lifecycle.test.sql until "-- Close the initial guard"
do $$ declare request jsonb:=pg_temp.prestart_request(current_setting('qorpera_test.office_paid_request')::jsonb);
    cancellation jsonb; result jsonb; before_office jsonb; before_allocation jsonb;
begin
    select to_jsonb(o) into before_office from public.qorpera_runtime_offices o where id=(request->>'officeId')::uuid;
    select to_jsonb(a) into before_allocation from public.qorpera_runtime_machine_allocations a where id=(request->>'allocationId')::uuid;
    cancellation:=jsonb_build_object('schema','qorpera.computer-abandon/v1','requestId',extensions.gen_random_uuid(),
        'permitId',request->'requestId','generation',1,'prepareRequestText',request->'prepareRequestText','abandonment',jsonb_build_object(
        'schema','qorpera.computer-prestart-abandonment/v1','permitId',request->'requestId','allocationId',request->'allocationId',
        'instanceSha256',request->'instanceSha256','hostMachineIdSha256',request->'machineIdSha256','hostBootId',request->'hostBootId',
        'prepareSha256',request#>'{prestart,prepareSha256}','guardIncarnationId',request#>'{prestart,guardIncarnationId}'));
    result:=public.qorpera_abandon_runtime_computer_permit(cancellation,repeat('O',64));
    perform pg_temp.wake_assert(result->'reservationReleased'='true' and result->>'debitedUs'='0'
        and public.qorpera_abandon_runtime_computer_permit(cancellation,repeat('O',64))=result,'Office zero-use closure differs on retry');
    perform pg_temp.wake_assert((select reserved_us=0 and debited_us=0 from public.qorpera_computer_allowance_buckets where invoice_id='in_officepaid'),
        'Office cancellation consumed shared pool');
    perform pg_temp.wake_assert((select to_jsonb(o)=before_office from public.qorpera_runtime_offices o where id=(request->>'officeId')::uuid)
        and (select to_jsonb(a)=before_allocation from public.qorpera_runtime_machine_allocations a where id=(request->>'allocationId')::uuid)
        and (select released_at is null from public.qorpera_runtime_node_demands where allocation_id=(request->>'allocationId')::uuid),
        'Office cancellation completed a lifecycle operation or released physical custody');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_computer_permit(%L,%L)',request,repeat('O',64)),'55000');
    -- A different request ID cannot reuse the consumed initial start intent.
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',request||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
end $$;
rollback;
