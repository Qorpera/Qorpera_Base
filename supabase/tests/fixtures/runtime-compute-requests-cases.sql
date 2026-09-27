-- Two extra offered claim/assignment records are explicit metadata fixtures.
-- The existing release RPC performs both failure transitions, one on each side
-- of the migration. The original accepted native assignment remains untouched.
reset role;
insert into public.qorpera_runner_job_claims(id,orchestrator_id,client_claim_id,job_id,run_id,status,lease_expires_at)
select '39000000-0000-4000-8000-000000000001',orchestrator_id,'39000000-0000-4000-8000-000000000001',job_id,run_id,'assigned',clock_timestamp()+interval '2 minutes'
from public.qorpera_runner_job_claims where status='accepted';
insert into public.qorpera_runner_assignments(id,claim_id,job_id,run_id,runner_id,capability_sha256,expires_at)
select '39000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000001',job_id,run_id,runner_id,repeat('9',64),clock_timestamp()+interval '2 minutes'
from public.qorpera_runner_assignments where status='accepted';
set local role service_role;
select public.qorpera_release_runner_job_claim('30000000-0000-4000-8000-000000000092',
 '39000000-0000-4000-8000-000000000001','39000000-0000-4000-8000-000000000002','PRIVATE_BACKEND_ERROR');
reset role;
insert into public.qorpera_runner_job_claims(id,orchestrator_id,client_claim_id,job_id,run_id,status,lease_expires_at)
select '39000000-0000-4000-8000-000000000003',orchestrator_id,'39000000-0000-4000-8000-000000000003',job_id,run_id,'assigned',clock_timestamp()+interval '2 minutes'
from public.qorpera_runner_job_claims where status='accepted';
insert into public.qorpera_runner_assignments(id,claim_id,job_id,run_id,runner_id,capability_sha256,expires_at)
select '39000000-0000-4000-8000-000000000004','39000000-0000-4000-8000-000000000003',job_id,run_id,runner_id,repeat('9',64),clock_timestamp()+interval '2 minutes'
from public.qorpera_runner_assignments where status='accepted';

-- APPLY COMPUTE REQUEST MIGRATION

create function pg_temp.requests() returns jsonb language sql as $$
 select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010')
$$;
create function pg_temp.request(p_kind text) returns jsonb language sql as $$
 select r from jsonb_array_elements(pg_temp.requests()->'requests') r where r->>'kind'=p_kind
 and (p_kind<>'login' or r->>'requestId'=current_setting('qorpera_test.request_login',true)::jsonb->>'login_id')
 order by r->>'requestId' limit 1
$$;
set local role service_role;
select pg_temp.wake_assert(pg_temp.request('native')#>>'{dispatchAttempts,latestFailure,failureTimeSource}'='not_recorded'
 and pg_temp.request('native')#>'{dispatchAttempts,latestFailure,failedAt}'='null'::jsonb,'pre-migration failure retains unknown time');
reset role;
select pg_temp.wake_assert(pg_temp.request('native')#>>'{details,runtimeBundleId}'=(select runtime_bundle_id::text from public.qorpera_execution_runs
 where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid),'bundle identity comes from the linked execution run');
set local role service_role;
select set_config('qorpera_test.before_failure',clock_timestamp()::text,true);
select public.qorpera_release_runner_job_claim('30000000-0000-4000-8000-000000000092',
 '39000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000004','PRIVATE_BACKEND_ERROR');
select set_config('qorpera_test.failure', (pg_temp.request('native')->'dispatchAttempts')::text,true);
select pg_temp.wake_assert((current_setting('qorpera_test.failure')::jsonb#>>'{latestFailure,failedAt}')::timestamptz
 between current_setting('qorpera_test.before_failure')::timestamptz and clock_timestamp(),'failure transition uses original database time');
select pg_temp.wake_assert(current_setting('qorpera_test.failure')::jsonb#>>'{latestFailure,assignmentId}'='39000000-0000-4000-8000-000000000004'
 and current_setting('qorpera_test.failure')::jsonb->>'deliveryFailedAttempts'='2','latest known failure and full count');
select public.qorpera_release_runner_job_claim('30000000-0000-4000-8000-000000000092',
 '39000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000004','CHANGED_PRIVATE_ERROR');
select pg_temp.wake_assert(pg_temp.request('native')->'dispatchAttempts'=current_setting('qorpera_test.failure')::jsonb,'release replay cannot restamp');
reset role;
update public.qorpera_runner_assignments set last_error='CHANGED_PRIVATE_ERROR',delivery_failed_at=clock_timestamp()
 where id='39000000-0000-4000-8000-000000000004';
select pg_temp.wake_assert((select delivery_failed_at is null from public.qorpera_runner_assignments where id='39000000-0000-4000-8000-000000000002'),'migration did not backfill');
set local role service_role;
select pg_temp.wake_assert(pg_temp.request('native')->'dispatchAttempts'=current_setting('qorpera_test.failure')::jsonb,'unrelated updates cannot restamp');
reset role;

-- Actual member start and login intents, before any machine reservation.
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.start_id',public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
 '39000000-0000-4000-8000-000000000010')->>'intentId',true);
select set_config('qorpera_test.request_login',public.qorpera_begin_native_provider_login(
 '30000000-0000-4000-8000-000000000010','39000000-0000-4000-8000-000000000011','39000000-0000-4000-8000-000000000012',
 (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,'openai','codex-cli',repeat('8',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
 '39000000-0000-4000-8000-000000000070',repeat('f',64),0,true);
select pg_temp.wake_assert(pg_temp.request('office')->>'recordedState'='requested' and pg_temp.request('office')->'placements'='[]'::jsonb
 and pg_temp.request('office')#>>'{details,configuredProviderId}'='39000000-0000-4000-8000-000000000070','configured target does not invent allocation');
select pg_temp.wake_assert(pg_temp.request('login')#>'{details,machineRequestId}'='null'::jsonb and pg_temp.request('login')->'placements'='[]'::jsonb,'login intent visible before provisioning');
reset role;
select set_config('qorpera_test.native_allocation',(select client_runner_id::text from public.qorpera_runners
 where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
select set_config('qorpera_test.native_adapter',(select provider_adapter from public.qorpera_runners
 where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
set local role service_role;
select public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.native_allocation')::uuid,current_setting('qorpera_test.native_adapter'),repeat('e',64),
 (current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid,(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_login_machine('39000000-0000-4000-8000-000000000013','lxd',repeat('7',64),
 (current_setting('qorpera_test.request_login')::jsonb->>'login_id')::uuid,repeat('8',64))->>'reason'='COMPUTE_IDENTITY_OCCUPIED','real login admission refusal');
select pg_temp.wake_assert(pg_temp.request('login')#>>'{details,lastAdmissionRefusal}'='COMPUTE_IDENTITY_OCCUPIED'
 and pg_temp.request('login')->'placements'='[]'::jsonb,'refused login has request but no placement');
reset role;
-- There is no company machine limit (runtime v92), so an office demand is never refused for capacity.
select pg_temp.path_claims('service_role');
set local role service_role;
create function pg_temp.reserve_request_office() returns jsonb language sql as $$
 select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.start_id')::uuid,
 '39000000-0000-4000-8000-000000000020',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
 '39000000-0000-4000-8000-000000000070',repeat('f',64))
$$;
select pg_temp.wake_assert(pg_temp.reserve_request_office()->>'state'='reserved','office demand receives company allocation');
select pg_temp.wake_assert(pg_temp.request('capacity_refusal') is null,'allocated refusal leaves unallocated list');
select pg_temp.wake_assert(pg_temp.request('office')#>>'{placements,0,nodePlacementState}'='unassigned','company reservation does not invent node placement');

-- Synthetic host measurements, actual node configuration/admission.
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId','39000000-0000-4000-8000-000000000030',
 'machineIdSha256',repeat('a',64),'label','request-fixture','cpuMillis',6000,'memoryBytes',8589934592,
 'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
select public.qorpera_enroll_runtime_node_provider('39000000-0000-4000-8000-000000000030',repeat('a',64),'native',current_setting('qorpera_test.native_adapter'),repeat('f',64),3000,2147483648);
select public.qorpera_enroll_runtime_node_provider('39000000-0000-4000-8000-000000000030',repeat('a',64),'office','39000000-0000-4000-8000-000000000070',repeat('f',64),2000,2147483648);
select public.qorpera_test_observe_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-observation/v1','nodeId','39000000-0000-4000-8000-000000000030',
 'machineIdSha256',repeat('a',64),'observationId',extensions.gen_random_uuid(),'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'));
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine(current_setting('qorpera_test.native_allocation')::uuid,'native',current_setting('qorpera_test.native_adapter'),
 repeat('f',64),repeat('e',64),repeat('a',64),3000,2147483648)->>'state'='reserved','native node allocation');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('39000000-0000-4000-8000-000000000020','office','39000000-0000-4000-8000-000000000070',
 repeat('f',64),repeat('c',64),repeat('a',64),2000,2147483648)->>'reason'='NODE_CAPACITY_EXHAUSTED','real node refusal');
select pg_temp.wake_assert(pg_temp.request('native')#>>'{placements,0,nodePlacementState}'='reserved'
 and pg_temp.request('office')#>>'{placements,0,nodePlacementState}'='requested'
 and pg_temp.request('office')#>>'{placements,0,lastAdmissionRefusal}'='NODE_CAPACITY_EXHAUSTED','placement and demand are distinct');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_cancel_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.start_id')::uuid);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.request('office')->>'recordedState'='cancelled'
 and pg_temp.request('office')#>'{placements,0,companyReleasedAt}'='null'::jsonb,'cancellation retains charged allocation');
select pg_temp.wake_assert(public.qorpera_runtime_compute_requests('39000000-0000-4000-8000-000000000099')->'requests'='[]'::jsonb,'company isolation');
do $$ declare page jsonb; all_records jsonb:='[]'; after_kind text; after_id uuid; n integer:=0;
begin
 loop
  page:=public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010',after_kind,after_id,1);
  all_records:=all_records||(page->'requests');n:=n+1;
  perform pg_temp.wake_assert(n<=10,'pagination terminates');
  exit when not (page->>'hasMore')::boolean;
  after_kind:=page->>'nextKind';after_id:=(page->>'nextId')::uuid;
 end loop;
 perform pg_temp.wake_assert(all_records=pg_temp.requests()->'requests','tuple pages equal complete response');
 perform pg_temp.wake_assert(pg_temp.requests()::text !~ 'PRIVATE|capability|credential|last_error|release_reason','closed query omits raw errors and credentials');
end $$;
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests(null)$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010','office',null)$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010','bad','39000000-0000-4000-8000-000000000099')$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010',null,null,1001)$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010',null,null,0)$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010',null,null,null)$q$,'22023');
select pg_temp.path_claims('anon');
select pg_temp.wake_error('select pg_temp.requests()','42501');
select pg_temp.path_claims('service_role');
reset role;
-- Capture authority/admission state around repeated reads; no re-admission or
-- release is allowed as a side effect of optional operator diagnostics.
select set_config('qorpera_test.before_reads',(select jsonb_agg(to_jsonb(d) order by allocation_id)::text from public.qorpera_runtime_node_demands d),true);
select set_config('qorpera_test.before_allocations',(select jsonb_agg(to_jsonb(a) order by id)::text from public.qorpera_runtime_machine_allocations a),true);
set local role service_role;
select pg_temp.requests();select pg_temp.requests();
reset role;
select pg_temp.wake_assert((select jsonb_agg(to_jsonb(d) order by allocation_id) from public.qorpera_runtime_node_demands d)=current_setting('qorpera_test.before_reads')::jsonb,'reads do not retry node admission');
select pg_temp.wake_assert((select jsonb_agg(to_jsonb(a) order by id) from public.qorpera_runtime_machine_allocations a)=current_setting('qorpera_test.before_allocations')::jsonb,'reads do not release allocation');
do $$ declare role_name text; helper text;
begin
 foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  foreach helper in array array['qorpera_runtime_request_placements(text,uuid)','qorpera_record_dispatch_failure_time()'] loop
   perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.'||helper,'EXECUTE'),'private helper');
  end loop;
  if role_name<>'service_role' then
   perform pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)','EXECUTE'),'operator only');
  end if;
 end loop;
end $$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error('select pg_temp.requests()','42501');
reset role;
select pg_temp.path_claims('service_role');
