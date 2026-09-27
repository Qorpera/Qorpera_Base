-- @fixture 674_computer_work_admission_coverage.test.sql until "rollback;"
-- Actual SQL work boundary after activation; physical samples are synthetic.
do $$ declare a public.qorpera_runtime_office_activations%rowtype;
    p public.qorpera_coding_computer_permits%rowtype; sample jsonb; scope jsonb:=current_setting('qorpera_test.office_scope')::jsonb;
    command text; reply jsonb; role_name text; startup jsonb;
begin
    select * into strict a from public.qorpera_runtime_office_activations where activation_id='67400000-0000-4000-8000-000000000001';
    select * into strict p from public.qorpera_coding_computer_permits where allocation_id=a.allocation_id;
    startup:=jsonb_build_object('scope',scope,'computerGeneration',a.computer_generation,'allocationId',a.allocation_id,
        'instanceSha256',a.instance_sha256,'imageSha256',a.image_sha256,'bootstrapSha256',a.bootstrap_sha256,
        'bootId',a.attestation->'bootId','configurationSha256',a.attestation->'configurationSha256','serviceInvocationId',a.service_invocation_id);
    command:=format('select public.qorpera_check_runtime_office_work_binding(%L)',startup);
    execute command into reply;
    perform pg_temp.wake_assert(reply->>'state'='authorized' and (reply->>'validForMs')::integer between 1 and 5000,'Active exact work binding refused');
    sample:=p.last_sample||jsonb_build_object('previousObservationId',p.last_sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',101500,'observedAt',clock_timestamp());
    perform pg_temp.upload(public.qorpera_runtime_computer_receipt(p.id,p.generation),sample);
    perform pg_temp.wake_error(command,'55000');
    perform public.qorpera_check_runtime_office_guest_binding(scope,1,a.allocation_id,a.instance_sha256,a.image_sha256,a.bootstrap_sha256);
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',102000,'guestUptimeMs',2000,'observedAt',clock_timestamp());
    perform pg_temp.upload(public.qorpera_runtime_computer_receipt(p.id,p.generation),sample);
    execute command into reply;
    perform pg_temp.wake_assert(reply->>'state'='authorized','New confirmed pair did not restore active work');
    perform pg_temp.wake_error(replace(command,a.attestation->>'bootId','67500000-0000-4000-8000-000000000001'),'42501');
    foreach role_name in array array['anon','authenticated','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_check_runtime_office_work_binding(jsonb)','EXECUTE'),'Work boundary exposed to untrusted role');
    end loop;
    -- Explicit same-boot restart fixture: history remains but only the current
    -- invocation can receive effect authority. This does not claim a physical restart.
    update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=a.activation_id;
    a.predecessor_activation_id:=a.activation_id;
    a.activation_id:='67500000-0000-4000-8000-000000000002';
    a.attestation:=a.attestation||jsonb_build_object('activationId',a.activation_id);
    a.service_invocation_id:=repeat('2',32);
    insert into public.qorpera_runtime_office_activations select (a).*;
    perform pg_temp.wake_error(command,'42501');
    startup:=startup||jsonb_build_object('serviceInvocationId',a.service_invocation_id);
    reply:=public.qorpera_check_runtime_office_work_binding(startup);
    perform pg_temp.wake_assert(reply->>'state'='authorized','Current same-boot invocation was not selected');
    command:=format('select public.qorpera_check_runtime_office_work_binding(%L)',startup);
    perform pg_temp.path_claims('authenticated');
    perform pg_temp.wake_error(command,'42501');
end $$;
rollback;
