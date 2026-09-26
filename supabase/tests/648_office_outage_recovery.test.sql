-- @fixture 647_office_computer_outages.test.sql until "savepoint outage_cases;"
-- Real paid permit settlement, fresh funding/bind, termination acknowledgement,
-- shared guest readiness, and activation. Physical root observations are fixtures.
do $$ declare outage jsonb:=current_setting('qorpera_test.outage_request')::jsonb;
    sample jsonb:=current_setting('qorpera_test.outage_sample')::jsonb; r jsonb; receipt jsonb;
begin
    perform public.qorpera_register_runtime_office_computer_outage(outage,repeat('O',64));
    r:=jsonb_build_object('schema','qorpera.office-outage-recovery-request/v1',
        'recoveryId','64800000-0000-4000-8000-000000000001','outageRequestId',outage->'requestId',
        'activationId','64800000-0000-4000-8000-000000000002','startCommandId','64800000-0000-4000-8000-000000000003');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_recovery(%L,%L)',r,repeat('O',64)),'42501');
    -- The successor epoch starts from the database clock. Keep this terminal
    -- observation in the past rather than adding simulated uptime to wall
    -- time: fast CI can reach the next prepare within that artificial 100 ms.
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',100100,'guestUptimeMs',null,'state','stopped','observedAt',clock_timestamp());
    perform public.qorpera_finish_runtime_computer_permit(jsonb_build_object('requestId',extensions.gen_random_uuid(),
        'permitId',outage#>'{guard,permit,permitId}','generation',1,'sample',sample,'guardClosed',true),repeat('O',64));
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_recovery(%L,%L)',r,repeat('X',64)),'42501');
    perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_recovery(%L,%L)',r,repeat('O',64)),'42501');
    perform pg_temp.path_claims('service_role');
    receipt:=public.qorpera_prepare_runtime_office_outage_recovery(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->'request'=r and not receipt?'validForMs'
        and receipt->'predecessor'=outage->'activation' and receipt->>'privacyState'='entering' and receipt->>'privacyVersion'='4',
        'Recovery metadata lost predecessor or privacy snapshot');
    perform pg_temp.wake_assert(public.qorpera_prepare_runtime_office_outage_recovery(r,repeat('O',64))=receipt
        and public.qorpera_runtime_office_outage_recovery_status(r,repeat('O',64))=receipt,'Recovery intent retry differs');
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_outage_recovery(r,repeat('O',64))=
        jsonb_build_object('schema','qorpera.office-outage-recovery-authority/v1','recovery',receipt,'validForMs',5000),'Recovery authority differs');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_recovery(%L,%L)',
        r||jsonb_build_object('recoveryId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    begin
        update public.qorpera_runtime_offices set privacy_version=privacy_version+1 where id=(outage#>>'{activation,startup,scope,companyComputerId}')::uuid;
        perform pg_temp.wake_assert(public.qorpera_runtime_office_outage_recovery_status(r,repeat('O',64))=receipt,'Metadata replay unexpectedly needs live authority');
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_recovery(%L,%L)',r,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    perform set_config('qorpera_test.outage_recovery',r::text,true);
    perform set_config('qorpera_test.outage_recovery_receipt',receipt::text,true);
end $$;
do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    r jsonb:=current_setting('qorpera_test.office_paid_request')::jsonb; receipt jsonb; sample jsonb; observation jsonb; renewal jsonb;
begin
    r:=r||jsonb_build_object('requestId',base->'startCommandId','officeIntent',jsonb_build_object('kind','outage_recovery','request',base));
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r||jsonb_build_object('hostBootId',extensions.gen_random_uuid()),repeat('O',64)),'42501');
    begin
        insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,
            bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
            select node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,
                encode(extensions.digest(convert_to(repeat('Q',64),'UTF8'),'sha256'),'hex')
            from public.qorpera_runtime_computer_host_keys where provider_kind='office';
        perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r,repeat('Q',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_runtime_office_screens set epoch=epoch+1 where office_id=(r->>'officeId')::uuid and ordinal=1;
        perform pg_temp.wake_error(format('select pg_temp.prepare_runtime(%L,%L)',r,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    receipt:=pg_temp.prepare_runtime(r,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->'permitId'=base->'startCommandId'
        and (select count(*)=2 from public.qorpera_coding_computer_permits),'Recovery did not obtain a separate paid permit');
    perform pg_temp.wake_assert(pg_temp.prepare_runtime(r,repeat('O',64))->'deadline'=receipt->'deadline','Paid recovery replay extended deadline');
    sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',r->'hostBootId',
        'hostUptimeMs',200000,'physicalId','64700000-0000-4000-8000-000000000030','guestBootId','64800000-0000-4000-8000-000000000004',
        'guestUptimeMs',1000,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('b',64));
    perform public.qorpera_bind_runtime_computer_permit(jsonb_build_object('permitId',r->'requestId','generation',1,'sample',sample),repeat('O',64));
    renewal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',r->'requestId','generation',1,'windowMs',300000,'stopReserveMs',30000,
        'sample',sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),'observedAt',clock_timestamp()));
    perform pg_temp.wake_error(format('select public.qorpera_renew_runtime_computer_permit(%L,%L)',renewal,repeat('O',64)),'42501');
    observation:=jsonb_build_object('schema','qorpera.lxd-office-outage-resume-observation/v1','intentId','64100000-0000-4000-8000-000000000002',
        'allocationId',r->'allocationId','recoveryId',base->'recoveryId','activationId',base->'activationId','startCommandId',base->'startCommandId',
        'requestSha256',repeat('5',64),'hostBootId',r->'hostBootId','bootId',sample->'guestBootId','instanceSha256',r->'instanceSha256',
        'physicalInstanceId',sample->'physicalId','operationId','64800000-0000-4000-8000-000000000005');
    perform set_config('qorpera_test.outage_observation',observation::text,true);
    perform set_config('qorpera_test.outage_recovery_renewal',renewal::text,true);
end $$;
do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    obs jsonb:=current_setting('qorpera_test.outage_observation')::jsonb; challenge_request jsonb; challenge jsonb; inspection jsonb; ack_request jsonb; ack jsonb;
    office uuid:=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid; privacy jsonb; profiles jsonb;
begin
    select jsonb_build_array(privacy_state,privacy_version,privacy_challenge) into privacy from public.qorpera_runtime_offices where id=office;
    select jsonb_agg(to_jsonb(p) order by id) into profiles from public.qorpera_runtime_browser_profiles p where office_id=office;
    challenge_request:=jsonb_build_object('recovery',base,'inspectionId','64800000-0000-4000-8000-000000000006','observation',obs,'bootObservationSha256',repeat('6',64));
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_termination(%L,%L)',
        jsonb_set(challenge_request,'{observation,bootId}',to_jsonb('64700000-0000-4000-8000-000000000031'::text)),repeat('O',64)),'42501');
    challenge:=public.qorpera_prepare_runtime_office_outage_termination(challenge_request,repeat('O',64));
    perform pg_temp.wake_assert(challenge->'request'=challenge_request and (challenge->>'validForMs')::bigint between 1 and 5000,'Termination challenge differs');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_termination(%L,%L)',
        challenge_request||jsonb_build_object('bootObservationSha256',repeat('7',64)),repeat('O',64)),'42501');
    inspection:=jsonb_build_object('schema','qorpera.office-outage-termination-inspection/v1','inspectionId',challenge_request->'inspectionId',
        'recoveryId',base->'recoveryId','startCommandId',base->'startCommandId','bootId',obs->'bootId','hostBootId',obs->'hostBootId',
        'physicalInstanceId',obs->'physicalInstanceId','bootObservationSha256',repeat('6',64),'predecessorConfigurationSha256',repeat('3',64),
        'predecessorAdoptionReceiptSha256',repeat('4',64),'cgroupState','empty','preparationState','unstarted','serviceState','unstarted',
        'command',jsonb_build_object('commandId','64800000-0000-4000-8000-000000000007','requestSha256',repeat('8',64),'bootId',obs->'bootId'),
        'originPreparationSha256',repeat('9',64),'originAdoptionReceiptSha256',repeat('a',64));
    ack_request:=jsonb_build_object('recovery',base,'inspection',inspection);
    perform pg_temp.wake_error(format('select public.qorpera_ack_runtime_office_outage_termination(%L,%L)',
        jsonb_set(ack_request,'{inspection,predecessorConfigurationSha256}',to_jsonb(repeat('f',64))),repeat('O',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_ack_runtime_office_outage_termination(%L,%L)',
        jsonb_set(ack_request,'{inspection,cgroupState}',to_jsonb('populated'::text)),repeat('O',64)),'22023');
    begin
        update public.qorpera_runtime_office_outage_termination_challenges set expires_at=clock_timestamp()-interval '1 second';
        perform pg_temp.wake_error(format('select public.qorpera_ack_runtime_office_outage_termination(%L,%L)',ack_request,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_runtime_offices set revision=revision+1 where id=office;
        perform pg_temp.wake_error(format('select public.qorpera_ack_runtime_office_outage_termination(%L,%L)',ack_request,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    ack:=public.qorpera_ack_runtime_office_outage_termination(ack_request,repeat('O',64));
    perform pg_temp.wake_assert(ack->'request'=ack_request and public.qorpera_ack_runtime_office_outage_termination(ack_request,repeat('O',64))=ack,'Lost termination acknowledgement cannot replay');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_stops)
        and not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions)
        and (select state='maintenance' and jsonb_build_array(privacy_state,privacy_version,privacy_challenge)=privacy from public.qorpera_runtime_offices where id=office)
        and (select bool_and(not drain_pending) from public.qorpera_runtime_office_screens where office_id=office)
        and (select drain_id='64700000-0000-4000-8000-000000000042' and epoch=7 from public.qorpera_runtime_office_screens where office_id=office and ordinal=1)
        and (select bool_and(state='ended') from public.qorpera_runtime_office_viewers where office_id=office)
        and (select jsonb_agg(to_jsonb(p) order by id)=profiles from public.qorpera_runtime_browser_profiles p where office_id=office),
        'Termination fabricated graceful stop, lost challenge, privacy, or retained private browser state');
    perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_recovery(%L,%L)',base,repeat('O',64)),'42501');
    perform set_config('qorpera_test.outage_termination_ack',ack::text,true);
end $$;
do $$ declare request jsonb:=jsonb_build_object('recovery',current_setting('qorpera_test.outage_recovery')::jsonb,
    'termination',current_setting('qorpera_test.outage_termination_ack')::jsonb); authority jsonb;
begin
    authority:=public.qorpera_check_runtime_office_outage_configuration(request,repeat('O',64));
    perform pg_temp.wake_assert(authority->>'schema'='qorpera.office-outage-configuration-authority/v1'
        and authority->'recovery'=current_setting('qorpera_test.outage_recovery_receipt')::jsonb
        and authority->'termination'=request->'termination' and authority->>'validForMs'='5000','Post-termination configuration authority differs');
    begin
        update public.qorpera_runtime_offices set privacy_version=privacy_version+1;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_configuration(%L,%L)',request,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_runtime_office_providers set preparation_enabled=false;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_configuration(%L,%L)',request,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_coding_computer_windows set issued_at=issued_at-interval '1 hour',deadline=deadline-interval '1 hour'
            where permit_id=(request#>>'{recovery,startCommandId}')::uuid;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_configuration(%L,%L)',request,repeat('O',64)),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
end $$;
do $$ declare base jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb;
    obs jsonb:=current_setting('qorpera_test.outage_observation')::jsonb; successor jsonb; receipt jsonb; startup jsonb; attestation jsonb; authority jsonb;
    office uuid:=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
begin
    select a.attestation into attestation from public.qorpera_runtime_office_activations a where activation_id='64700000-0000-4000-8000-000000000020';
    attestation:=attestation||jsonb_build_object('activationId',base->'activationId','bootId',obs->'bootId',
        'preparationObservationSha256',repeat('6',64),
        'configurationObservationSha256',repeat('5',64),'configurationSha256',repeat('6',64),'adoptionReceiptSha256',repeat('7',64));
    successor:=jsonb_build_object('schema','qorpera.office-outage-successor-request/v1','recovery',base,'attestation',attestation,
        'termination',current_setting('qorpera_test.outage_termination_ack')::jsonb);
    perform pg_temp.wake_error(format('select public.qorpera_prepare_runtime_office_outage_successor(%L,%L)',
        jsonb_set(successor,'{attestation,bootId}',to_jsonb('64700000-0000-4000-8000-000000000031'::text)),repeat('O',64)),'42501');
    receipt:=public.qorpera_prepare_runtime_office_outage_successor(successor,repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->'request'=successor and not receipt?'validForMs'
        and public.qorpera_prepare_runtime_office_outage_successor(successor,repeat('O',64))=receipt,'Outage successor prepare differs');
    authority:=public.qorpera_check_runtime_office_outage_successor(successor,repeat('O',64));
    perform pg_temp.wake_assert(authority->'successor'=receipt and authority->>'validForMs'='5000','Successor authority differs');
    startup:=(current_setting('qorpera_test.outage_request')::jsonb#>'{activation,startup}')||jsonb_build_object(
        'bootId',obs->'bootId','configurationSha256',repeat('6',64),'serviceInvocationId',repeat('2',32));
    perform pg_temp.wake_assert(public.qorpera_check_runtime_office_startup(startup)->'activationId'=base->'activationId','Shared startup rejected outage predecessor');
    begin
        -- Configuration may take longer than a sample freshness interval.
        -- The immutable bound boot and original paid deadline remain the
        -- authority; maintenance cannot renew merely to refresh this sample.
        update public.qorpera_coding_computer_permits set last_sample=jsonb_set(last_sample,'{observedAt}',to_jsonb(clock_timestamp()-interval '20 seconds'))
            where id=(base->>'startCommandId')::uuid;
        perform pg_temp.wake_assert(public.qorpera_check_runtime_office_startup(startup)->'activationId'=base->'activationId',
            'In-window startup incorrectly depends on a recent paid bind sample');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_coding_computer_windows set issued_at=issued_at-interval '1 hour',deadline=deadline-interval '1 hour'
            where permit_id=(base->>'startCommandId')::uuid;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_startup(%L)',startup),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_runtime_office_providers set preparation_enabled=false where office_id=office;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_startup(%L)',startup),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    begin
        update public.qorpera_runtime_offices set privacy_version=privacy_version+1 where id=office;
        perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_startup(%L)',startup),'42501');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    perform pg_temp.wake_error(format('select public.qorpera_activate_runtime_office_outage_successor(%L,%L)',
        jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64)),'42501');
    perform public.qorpera_report_runtime_office_ready(startup,(base->>'activationId')::uuid,18000,18001);
    begin
        -- Retained historical idle wake: its ordinary successor became active,
        -- but the provider lost power before closing the idle-cycle suffix.
        insert into public.qorpera_runtime_office_activations select (jsonb_populate_record(null::public.qorpera_runtime_office_activations,
            to_jsonb(a)||jsonb_build_object('activation_id','64800000-0000-4000-8000-000000000080',
                'predecessor_activation_id',null,'superseded_at',clock_timestamp(),'service_invocation_id',repeat('8',32)))).*
            from public.qorpera_runtime_office_activations a where activation_id='64700000-0000-4000-8000-000000000020';
        update public.qorpera_runtime_office_activations set predecessor_activation_id='64800000-0000-4000-8000-000000000080'
            where activation_id='64700000-0000-4000-8000-000000000020';
        insert into public.qorpera_runtime_office_lifecycle_transitions(id,activation_id,office_id,computer_generation,allocation_id,request,revocation_revision,drains)
            select '64800000-0000-4000-8000-000000000081',activation_id,office_id,computer_generation,allocation_id,'{}',1,'[]'
            from public.qorpera_runtime_office_activations where activation_id='64800000-0000-4000-8000-000000000080';
        insert into public.qorpera_runtime_office_stop_challenges(id,transition_id,command,start_completion_sha256,office_revision,privacy_version,drains,issued_at,expires_at)
            values('64800000-0000-4000-8000-000000000082','64800000-0000-4000-8000-000000000081','{}',repeat('8',64),1,0,'[]',transaction_timestamp(),transaction_timestamp()+interval '5 seconds');
        insert into public.qorpera_runtime_office_stops(transition_id,challenge_id,inspection)
            values('64800000-0000-4000-8000-000000000081','64800000-0000-4000-8000-000000000082','{}');
        insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version)
            values('64700000-0000-4000-8000-000000000020','64800000-0000-4000-8000-000000000081','{}',1,'shared',0);
        insert into public.qorpera_runtime_office_idle_cycles(transition_id,office_id,computer_generation,request,wake_requested_at)
            select id,office_id,computer_generation,request,clock_timestamp() from public.qorpera_runtime_office_lifecycle_transitions
            where id='64800000-0000-4000-8000-000000000081';
        perform public.qorpera_activate_runtime_office_outage_successor(jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64));
        perform pg_temp.wake_assert((select superseded_at is not null and activated_at is null from public.qorpera_runtime_office_idle_cycles
            where transition_id='64800000-0000-4000-8000-000000000081'),'Outage admission left stale idle wake pending');
        perform pg_temp.wake_assert(public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.office_scope')::jsonb,1,
            '64100000-0000-4000-8000-000000000003',repeat('f',64),300000)->'request'='null'::jsonb,'Idle reconciliation replayed pre-outage cycle');
        raise exception using errcode='QT648';
    exception when sqlstate 'QT648' then null; end;
    receipt:=public.qorpera_activate_runtime_office_outage_successor(jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64));
    perform pg_temp.wake_assert(receipt->>'state'='active' and receipt->>'serviceInvocationId'=repeat('2',32)
        and (select state='active' and privacy_state='entering' and privacy_version=4 from public.qorpera_runtime_offices where id=office)
        and (select superseded_at is not null from public.qorpera_runtime_office_activations where activation_id='64700000-0000-4000-8000-000000000020')
        and not exists(select 1 from public.qorpera_runtime_office_successors),'Outage admission lost its distinct predecessor chain');
    perform pg_temp.wake_assert(public.qorpera_activate_runtime_office_outage_successor(jsonb_build_object('successor',successor,'serviceInvocationId',repeat('2',32)),repeat('O',64))=receipt,'Lost activation reply cannot recover');
    perform pg_temp.wake_assert(public.qorpera_renew_runtime_computer_permit(current_setting('qorpera_test.outage_recovery_renewal')::jsonb,repeat('O',64))->>'generation'='2',
        'Activated exact outage boot could not renew');
    -- Subsequent normal lifecycle needs real guest stop evidence; it can begin
    -- from the recovered activation without pretending the outage was orderly.
    perform public.qorpera_begin_runtime_office_lifecycle(jsonb_build_object('schema','qorpera.office-lifecycle-request/v1',
        'transitionId','64800000-0000-4000-8000-000000000008','action','power_off','activationId',base->'activationId',
        'providerId','64100000-0000-4000-8000-000000000003','providerPolicySha256',repeat('f',64),'startup',startup));
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_stops),'Beginning normal stop fabricated acknowledgement');
    perform set_config('qorpera_test.outage_successor',successor::text,true);
end $$;
do $$ declare r jsonb:=current_setting('qorpera_test.outage_recovery')::jsonb; receipt jsonb:=current_setting('qorpera_test.outage_recovery_receipt')::jsonb;
begin
    update public.qorpera_runtime_machine_allocations set released_at=clock_timestamp() where id='64100000-0000-4000-8000-000000000004';
    update public.qorpera_runtime_office_providers set preparation_enabled=false;
    perform pg_temp.wake_assert(public.qorpera_runtime_office_outage_recovery_status(r,repeat('O',64))=receipt
        and public.qorpera_prepare_runtime_office_outage_recovery(r,repeat('O',64))=receipt,'Historical intent replay depends on current allocation');
    perform pg_temp.wake_assert(public.qorpera_ack_runtime_office_outage_termination(current_setting('qorpera_test.outage_termination_ack')::jsonb->'request',repeat('O',64))=
        current_setting('qorpera_test.outage_termination_ack')::jsonb,'Historical termination replay needs live allocation');
    perform public.qorpera_runtime_office_outage_successor_status(current_setting('qorpera_test.outage_successor')::jsonb,repeat('O',64));
    perform pg_temp.wake_error(format('select public.qorpera_check_runtime_office_outage_recovery(%L,%L)',r,repeat('O',64)),'42501');
    update public.qorpera_runtime_computer_host_keys set revoked_at=clock_timestamp() where provider_kind='office';
    perform pg_temp.wake_error(format('select public.qorpera_runtime_office_outage_recovery_status(%L,%L)',r,repeat('O',64)),'42501');
end $$;
do $$ declare role_name text; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(role_name,'public.qorpera_runtime_office_outage_recoveries','SELECT,INSERT,UPDATE,DELETE')
            and not has_table_privilege(role_name,'public.qorpera_runtime_office_outage_termination_challenges','SELECT,INSERT,UPDATE,DELETE'),'Recovery state exposed');
        perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_lock_office_outage_recovery(jsonb,boolean)','EXECUTE')
            and not has_function_privilege(role_name,'public.qorpera_authorize_paid_office_start_before_outage(jsonb)','EXECUTE'),'Private outage authority exposed');
        if role_name<>'service_role' then
            perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_prepare_runtime_office_outage_recovery(jsonb,text)','EXECUTE')
                and not has_function_privilege(role_name,'public.qorpera_activate_runtime_office_outage_successor(jsonb,text)','EXECUTE'),'Outage recovery RPC exposed');
        end if;
    end loop;
end $$;
rollback;
