-- @fixture 396_runtime_coding_executor.test.sql until "-- 4. Control plane only."
-- Real public admission, member identity and coding authority from 396. No VM
-- or model provider is called. Only physical stop/observation facts are synthetic.
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(not public.qorpera_company_paid_computer_mode('30000000-0000-4000-8000-000000000010'),
    'Existing and complimentary companies default to shadow');
do $$ declare v_role text;
begin
    foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_company_computer_billing_modes','SELECT,INSERT,UPDATE,DELETE'),
            'Only a database operator can select paid mode: '||v_role);
    end loop;
end $$;
select pg_temp.wake_error($q$insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid')$q$,'55000',
    'Stop and reconcile company computers before changing paid mode');

-- Retain the parent's run identity so its real final-send/completion protocol
-- can close all old jobs before the operator switches modes.
create temp table paid_fixture_jobs as select * from public.qorpera_runner_jobs
    where profile_id='30000000-0000-4000-8000-000000000010' and status in ('leased','running');
select public.qorpera_release_runtime_machine(id,provider_adapter,instance_sha256)
    from public.qorpera_runtime_machine_allocations
    where profile_id='30000000-0000-4000-8000-000000000010' and released_at is null
        and coding_machine_id is null and login_session_id is null and account_refresh_request_id is null;
select pg_temp.wake_assert(public.qorpera_authorize_coding_machine_custody(current_setting('qorpera_test.coding_vm')::uuid,
    'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64),'stop')->>'schema'='qorpera.coding-machine-admission/v1',
    'Unleased coding machines retain their stop authority');
select public.qorpera_suspend_coding_machine(current_setting('qorpera_test.coding_vm')::uuid,
    'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp()
    where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
select pg_temp.wake_error($q$insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid')$q$,'55000',
    'Stop and reconcile company computers before changing paid mode');
update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp()-interval '6 seconds'
    where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
select pg_temp.wake_error($q$insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid')$q$,'55000',
    'Stop and reconcile company computers before changing paid mode');
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','paid-boundary-parent-final');
select pg_temp.finish_job(run_id) from paid_fixture_jobs;
insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid');
select pg_temp.wake_assert(public.qorpera_company_paid_computer_mode('30000000-0000-4000-8000-000000000010'),
    'An operator can select paid mode only after prior physical authority is quiet');

-- A new owner-authenticated coding turn may reserve node capacity, but its
-- v2 receipt demands a separately protected funded permit before any VM effect.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,
    'Exercise the protected computer pilot.','63800000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.paid_coding_claim',public.qorpera_claim_coding_session('exec-test',60)::text,true);
create function pg_temp.paid_observe() returns jsonb language sql as $$
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
    'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
    public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310')->>'contextSha256',
    jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
select pg_temp.paid_observe();
select set_config('qorpera_test.paid_receipt',public.qorpera_authorize_coding_machine_run((pg_temp.worker_row('fix-send')).id,
    (current_setting('qorpera_test.paid_coding_claim')::jsonb->>'leaseToken')::uuid,
    current_setting('qorpera_test.coding_binding'),current_setting('qorpera_test.coding_storage')::jsonb,repeat('c',64))::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.paid_receipt')::jsonb->>'schema'='qorpera.coding-machine-admission/v2'
    and current_setting('qorpera_test.paid_receipt')::jsonb->'fundingRequired'='true'::jsonb
    and current_setting('qorpera_test.paid_receipt')::jsonb->>'intent'='run'
    and (current_setting('qorpera_test.paid_receipt')::jsonb->>'validForMs')::integer between 1 and 5000,
    'Paid coding requires v2; old clients cannot mistake node capacity for physical spending authority');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_computer_permits),
    'Public coding admission cannot create a protected paid permit');
select pg_temp.wake_error($q$delete from public.qorpera_company_computer_billing_modes
    where profile_id='30000000-0000-4000-8000-000000000010'$q$,'55000');

-- The real office registration still works; starting its unmetered physical VM
-- must fail before an allocation exists. No model account or paid pool is used.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select set_config('qorpera_test.paid_office',public.qorpera_register_runtime_office(
    '30000000-0000-4000-8000-000000000020','63800000-0000-4000-8000-000000000010',repeat('a',64),repeat('b',64),2)::text,true);
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine('63800000-0000-4000-8000-000000000011','lxd',repeat('b',64),
    null,null,(current_setting('qorpera_test.paid_office')::jsonb->>'companyComputerId')::uuid,1)
    ='{"state":"refused","reason":"PAID_COMPUTER_PATH_UNSUPPORTED"}'::jsonb,
    'Paid company offices cannot reserve an unmetered physical lifetime');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_machine_allocations
    where id='63800000-0000-4000-8000-000000000011'),'Office refusal creates no allocation');

-- Imported native/office and legacy per-worker coding allocations cannot
-- bypass the separate node capacity boundary by avoiding the public reserver.
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.paid_office')::jsonb-'state',1,
    '63800000-0000-4000-8000-000000000013',repeat('f',64),0,true);
insert into public.qorpera_runtime_machine_allocations(id,profile_id,office_id,computer_generation,provider_adapter,instance_sha256)
    values('63800000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000010',
    (current_setting('qorpera_test.paid_office')::jsonb->>'companyComputerId')::uuid,1,'lxd',repeat('b',64));
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
    values('63800000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000010',
    (pg_temp.worker_row('fix-send')).id,'coding-fixture',repeat('d',64));
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'office','63800000-0000-4000-8000-000000000013',repeat('f',64),2000,2147483648);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('63800000-0000-4000-8000-000000000011','office','63800000-0000-4000-8000-000000000013',
    repeat('f',64),repeat('b',64),repeat('c',64),2000,2147483648)->>'reason'='PAID_COMPUTER_PATH_UNSUPPORTED',
    'Imported offices cannot bypass node admission');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('63800000-0000-4000-8000-000000000012','coding','coding-fixture',
    repeat('f',64),repeat('d',64),repeat('c',64),2000,2147483648)->>'reason'='PAID_COMPUTER_PATH_UNSUPPORTED',
    'Legacy per-worker coding VMs have no funded host protocol');
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_node_machine('63800000-0000-4000-8000-000000000011','coding','coding-fixture',
    repeat('f',64),repeat('b',64),repeat('c',64),2000,2147483648)$q$,'42501','Node provider allocation differs');
select public.qorpera_release_runtime_machine(id,provider_adapter,instance_sha256)
    from public.qorpera_runtime_machine_allocations where id in
    ('63800000-0000-4000-8000-000000000011','63800000-0000-4000-8000-000000000012');

-- A freshly assigned native lease still cannot launch a model process in paid
-- mode. Logical assignment is not physical execution authority. Both shared
-- systemd and per-run backends use this launch boundary and the reserver above.
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
values('63800000-0000-4000-8000-000000000015','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
    'kickoff','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}');
select set_config('qorpera_test.paid_native_binding',pg_temp.wake_start(pg_temp.wake_input_run(
    array['63800000-0000-4000-8000-000000000015'::uuid]))::text,true);
select pg_temp.wake_error($q$select public.qorpera_begin_native_company_execution_v2(current_setting('qorpera_test.paid_native_binding')::jsonb,
    repeat('0',64),repeat('0',64),repeat('0',64),'{}',repeat('0',64),10)$q$,'42501',
    'Paid native agent sandbox admission is not supported');
select pg_temp.wake_error($q$select public.qorpera_claim_runner_job(
    (current_setting('qorpera_test.paid_native_binding')::jsonb->>'runnerId')::uuid,repeat('2',64),extensions.gen_random_uuid(),repeat('4',64))$q$,
    '42501','Paid native agent sandbox admission is not supported');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine(
    (select client_runner_id from public.qorpera_runners where id=(current_setting('qorpera_test.paid_native_binding')::jsonb->>'runnerId')::uuid),
    'process',repeat('e',64),(current_setting('qorpera_test.paid_native_binding')::jsonb->>'runId')::uuid,
    (current_setting('qorpera_test.paid_native_binding')::jsonb->>'runnerId')::uuid)->>'reason'='PAID_COMPUTER_PATH_UNSUPPORTED',
    'Native physical reservations fail closed before placement, including shared process backends');
insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,provider_adapter,instance_sha256)
    values('63800000-0000-4000-8000-000000000014','30000000-0000-4000-8000-000000000010',
    (current_setting('qorpera_test.paid_native_binding')::jsonb->>'runId')::uuid,
    (current_setting('qorpera_test.paid_native_binding')::jsonb->>'runnerId')::uuid,'process',repeat('5',64));
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'native','process',repeat('f',64),2000,2147483648);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('63800000-0000-4000-8000-000000000014','native','process',
    repeat('f',64),repeat('5',64),repeat('c',64),2000,2147483648)->>'reason'='PAID_COMPUTER_PATH_UNSUPPORTED',
    'Imported native allocations cannot bypass node admission');
select public.qorpera_release_runtime_machine('63800000-0000-4000-8000-000000000014','process',repeat('5',64));
select pg_temp.wake_public_send(current_setting('qorpera_test.paid_native_binding')::jsonb,'progress','paid-native-progress');
select pg_temp.wake_public_send(current_setting('qorpera_test.paid_native_binding')::jsonb,'final','paid-native-final');
select pg_temp.finish_job((current_setting('qorpera_test.paid_native_binding')::jsonb->>'runId')::uuid);

-- Model sign-in helpers remain free of paid admission. They still reserve
-- ordinary host capacity and prove exact source binding; no cross-member model
-- subscription or paid pool is consulted to set up this member's own account.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select set_config('qorpera_test.paid_login',public.qorpera_begin_native_provider_login(
    '30000000-0000-4000-8000-000000000010','63800000-0000-4000-8000-000000000020','63800000-0000-4000-8000-000000000021',
    (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,'openai','codex-cli',repeat('8',64),900)::text,true);
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_login_machine('63800000-0000-4000-8000-000000000022','lxd',repeat('7',64),
    (current_setting('qorpera_test.paid_login')::jsonb->>'login_id')::uuid,repeat('8',64))->>'state'='reserved',
    'Paid mode does not prevent model sign-in');
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'login','lxd',repeat('9',64),1000,1073741824);
select pg_temp.paid_observe();
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('63800000-0000-4000-8000-000000000022','login','lxd',
    repeat('9',64),repeat('7',64),repeat('c',64),1000,1073741824)->>'state'='reserved','Login helpers retain node capacity admission');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_computer_permits),
    'Login capacity never manufactures computer billing permits');
select public.qorpera_complete_coding_turn((pg_temp.worker_row('fix-send')).id,
    (current_setting('qorpera_test.paid_coding_claim')::jsonb->>'leaseToken')::uuid,'blocked',
    'Physical admission tested; no paid model harness was started.','Continue after native metering is implemented?',null,null,null,null,null,null);
select pg_temp.wake_assert(public.qorpera_authorize_coding_machine_custody(current_setting('qorpera_test.coding_vm')::uuid,
    'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64),'stop')->>'schema'='qorpera.coding-machine-admission/v1',
    'Paid mode retains v1 cleanup after the coding lease ends');
select public.qorpera_suspend_coding_machine(current_setting('qorpera_test.coding_vm')::uuid,
    'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp()-interval '6 seconds'
    where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
delete from public.qorpera_company_computer_billing_modes where profile_id='30000000-0000-4000-8000-000000000010';
select pg_temp.wake_assert(not public.qorpera_company_paid_computer_mode('30000000-0000-4000-8000-000000000010'),
    'A quiet operator rollback is possible while exempt login helpers remain allocated');
rollback;
