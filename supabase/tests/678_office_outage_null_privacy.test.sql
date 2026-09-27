-- @fixture 647_office_computer_outages.test.sql until "savepoint outage_cases;"
-- A fresh shared office has a SQL NULL challenge. Obtain the recovery snapshot
-- through the real APIs; do not replace it with a synthetic JSON object.
-- Paid settlement, funding, binding, termination ACK and admission are real SQL;
-- physical observations and the predecessor activation remain fixture evidence.
update public.qorpera_runtime_offices set privacy_state='shared',privacy_version=0,privacy_challenge=null
    where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
update public.qorpera_runtime_office_viewers set privacy_version=0;

create function pg_temp.null_privacy_refusals(p_sql text) returns void language plpgsql as $$
declare office uuid:=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
    recovery uuid:=(current_setting('qorpera_test.outage_recovery')::jsonb->>'recoveryId')::uuid; fault text;
begin
    foreach fault in array array['revision','state','version','challenge','missing_key'] loop
        begin
            case fault
                when 'revision' then update public.qorpera_runtime_offices set revision=revision+1 where id=office;
                when 'state' then update public.qorpera_runtime_offices set privacy_state='entering' where id=office;
                when 'version' then update public.qorpera_runtime_offices set privacy_version=privacy_version+1 where id=office;
                when 'challenge' then update public.qorpera_runtime_offices set privacy_challenge='{"state":"entering"}' where id=office;
                when 'missing_key' then update public.qorpera_runtime_office_outage_recoveries set snapshot=snapshot-'privacyChallenge' where recovery_id=recovery;
            end case;
            perform pg_temp.wake_error(p_sql,'42501');
            raise exception using errcode='QT678';
        exception when sqlstate 'QT678' then null; end;
    end loop;
end $$;

do $$ declare outage jsonb:=current_setting('qorpera_test.outage_request')::jsonb;
    sample jsonb:=current_setting('qorpera_test.outage_sample')::jsonb; r jsonb; receipt jsonb;
begin
    perform public.qorpera_register_runtime_office_computer_outage(outage,repeat('O',64));
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100100,'guestUptimeMs',null,'state','stopped','observedAt',clock_timestamp());
    perform public.qorpera_finish_runtime_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
        'permitId',outage#>'{guard,permit,permitId}','generation',1,'sample',sample,'guardClosed',true),repeat('O',64));
    r:=jsonb_build_object('schema','qorpera.office-outage-recovery-request/v1',
        'recoveryId','67800000-0000-4000-8000-000000000001','outageRequestId',outage->'requestId',
        'activationId','67800000-0000-4000-8000-000000000002','startCommandId','67800000-0000-4000-8000-000000000003');
    receipt:=public.qorpera_prepare_runtime_office_outage_recovery(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->>'privacyState'='shared'
        and receipt->>'privacyVersion'='0' and receipt?'privacyChallenge' and receipt->'privacyChallenge'='null'::jsonb
        and (select privacy_challenge is null from public.qorpera_runtime_offices where id=(outage#>>'{activation,startup,scope,companyComputerId}')::uuid)
        and (select snapshot?'privacyChallenge' and snapshot->'privacyChallenge'='null'::jsonb
            from public.qorpera_runtime_office_outage_recoveries where recovery_id=(r->>'recoveryId')::uuid),
        'Fresh shared office did not retain SQL NULL as an explicit JSON null snapshot');
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_outage_recovery(r,repeat('O',64))->>'validForMs'='5000',
        'Null challenge changed the recovery authority deadline');
    perform set_config('qorpera_test.outage_recovery',r::text,true);
    perform set_config('qorpera_test.outage_recovery_receipt',receipt::text,true);
end $$;

do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; receipt jsonb; sample jsonb; observation jsonb;
begin
    r:=r||jsonb_build_object('requestId',base->'startCommandId','officeIntent',jsonb_build_object('kind','outage_recovery','request',base));
    receipt:=pg_temp.prepare_runtime(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->'permitId'=base->'startCommandId'
        and (select count(*)=2 from public.qorpera_coding_computer_permits),'Recovery did not obtain a separate paid permit');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',r->'hostBootId',
        'hostUptimeMs',200000,'physicalId','64700000-0000-4000-8000-000000000030','guestBootId','67800000-0000-4000-8000-000000000004',
        'guestUptimeMs',1000,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('b',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',r->'requestId','generation',1,'sample',sample),repeat('O',64));
    observation:=jsonb_build_object('schema','qorpera.lxd-office-outage-resume-observation/v1','intentId','64100000-0000-4000-8000-000000000002',
        'allocationId',r->'allocationId','recoveryId',base->'recoveryId','activationId',base->'activationId','startCommandId',base->'startCommandId',
        'requestSha256',repeat('5',64),'hostBootId',r->'hostBootId','bootId',sample->'guestBootId','instanceSha256',r->'instanceSha256',
        'physicalInstanceId',sample->'physicalId','operationId','67800000-0000-4000-8000-000000000005');
    perform set_config('qorpera_test.outage_observation',observation::text,true);
end $$;

do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    obs jsonb:=current_setting('qorpera_test.outage_observation')::jsonb; challenge_request jsonb; challenge jsonb; inspection jsonb; ack_request jsonb; ack jsonb;
begin
    challenge_request:=jsonb_build_object('recovery',base,'inspectionId','67800000-0000-4000-8000-000000000006','observation',obs,'bootObservationSha256',repeat('6',64));
    challenge:=public.qorpera_prepare_runtime_office_outage_termination(challenge_request,repeat('O',64));
    perform pg_temp.wake_assert(challenge->'request'=challenge_request and (challenge->>'validForMs')::bigint between 1 and 5000,
        'Termination challenge lost its bounded authority');
    inspection:=jsonb_build_object('schema','qorpera.office-outage-termination-inspection/v1','inspectionId',challenge_request->'inspectionId',
        'recoveryId',base->'recoveryId','startCommandId',base->'startCommandId','bootId',obs->'bootId','hostBootId',obs->'hostBootId',
        'physicalInstanceId',obs->'physicalInstanceId','bootObservationSha256',repeat('6',64),'predecessorConfigurationSha256',repeat('3',64),
        'predecessorAdoptionReceiptSha256',repeat('4',64),'cgroupState','empty','preparationState','unstarted','serviceState','unstarted',
        'command',jsonb_build_object('commandId','67800000-0000-4000-8000-000000000007','requestSha256',repeat('8',64),'bootId',obs->'bootId'),
        'originPreparationSha256',repeat('9',64),'originAdoptionReceiptSha256',repeat('a',64));
    ack_request:=jsonb_build_object('recovery',base,'inspection',inspection);
    ack:=public.qorpera_ack_runtime_office_outage_termination(ack_request,repeat('O',64));
    perform pg_temp.wake_assert(ack->'request'=ack_request and public.qorpera_ack_runtime_office_outage_termination(ack_request,repeat('O',64))=ack,
        'Null challenge termination acknowledgement cannot replay');
    perform set_config('qorpera_test.outage_termination_ack',ack::text,true);
end $$;

-- First null fence: post-termination configuration admission.
do $$ declare request jsonb:=jsonb_build_object('recovery',current_setting('qorpera_test.outage_recovery')::jsonb,
    'termination',current_setting('qorpera_test.outage_termination_ack')::jsonb); authority jsonb;
begin
    authority:=public.qorpera_check_runtime_office_outage_configuration(request,repeat('O',64));
    perform pg_temp.wake_assert(authority->>'schema'='qorpera.office-outage-configuration-authority/v1'
        and authority->'recovery'=current_setting('qorpera_test.outage_recovery_receipt')::jsonb
        and authority->'termination'=request->'termination' and authority->>'validForMs'='5000',
        'SQL NULL challenge blocked configuration authority or changed its deadline');
    perform pg_temp.null_privacy_refusals(format('select public.qorpera_check_runtime_office_outage_configuration(%L,%L)',request,repeat('O',64)));
end $$;

do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    obs jsonb:=current_setting('qorpera_test.outage_observation')::jsonb; successor jsonb; receipt jsonb; startup jsonb; attestation jsonb; authority jsonb;
    office uuid:=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
begin
    select a.attestation into attestation from public.qorpera_runtime_office_activations a where activation_id='64700000-0000-4000-8000-000000000020';
    attestation:=attestation||jsonb_build_object('activationId',base->'activationId','bootId',obs->'bootId',
        'preparationObservationSha256',repeat('6',64),'configurationObservationSha256',repeat('5',64),
        'configurationSha256',repeat('6',64),'adoptionReceiptSha256',repeat('7',64));
    successor:=jsonb_build_object('schema','qorpera.office-outage-successor-request/v1','recovery',base,'attestation',attestation,
        'termination',current_setting('qorpera_test.outage_termination_ack')::jsonb);
    -- Second null fence: prepare must reject altered privacy before admission.
    perform pg_temp.null_privacy_refusals(format('select public.qorpera_prepare_runtime_office_outage_successor(%L,%L)',successor,repeat('O',64)));
    receipt:=public.qorpera_prepare_runtime_office_outage_successor(successor,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->'request'=successor
        and public.qorpera_prepare_runtime_office_outage_successor(successor,repeat('O',64))=receipt,
        'SQL NULL challenge blocked successor preparation or replay');
    authority:=public.qorpera_check_runtime_office_outage_successor(successor,repeat('O',64));
    perform pg_temp.wake_assert(authority->'successor'=receipt and authority->>'validForMs'='5000','Successor authority differs');
    startup:=(current_setting('qorpera_test.outage_request')::jsonb#>'{activation,startup}')||jsonb_build_object(
        'bootId',obs->'bootId','configurationSha256',repeat('6',64),'serviceInvocationId',repeat('2',32));
    -- Third null fence: shared startup rechecks privacy after preparation.
    perform pg_temp.null_privacy_refusals(format('select public.qorpera_check_runtime_office_startup(%L)',startup));
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_startup(startup)->'activationId'=base->'activationId',
        'SQL NULL challenge blocked shared startup');
    perform public.qorpera_report_runtime_office_ready(startup,(base->>'activationId')::uuid,18000,18001);
    receipt:=public.qorpera_activate_runtime_office_outage_successor(jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='active' and receipt->>'serviceInvocationId'=repeat('2',32)
        and (select state='active' and privacy_state='shared' and privacy_version=0 and privacy_challenge is null
            from public.qorpera_runtime_offices where id=office)
        and (select superseded_at is not null from public.qorpera_runtime_office_activations where activation_id='64700000-0000-4000-8000-000000000020')
        and not exists(select 1 from public.qorpera_runtime_office_successors),
        'Null challenge admission changed privacy or lost its distinct predecessor chain');
    perform pg_temp.wake_assert(public.qorpera_activate_runtime_office_outage_successor(
        jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64))=receipt,
        'Lost null challenge activation reply cannot replay');
end $$;
rollback;
