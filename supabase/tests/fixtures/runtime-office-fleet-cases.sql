-- Two independently staged providers. All start, placement and admission RPCs
-- are real; the measured host inventory and offer digests are synthetic.
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.fleet_intent',public.qorpera_request_runtime_office_start(
 current_setting('qorpera_test.office_scope')::jsonb,1,extensions.gen_random_uuid())->>'intentId',true);
reset role;
select pg_temp.path_claims('service_role');

create function pg_temp.office_fleet_node(p_node uuid,p_host text,p_provider uuid) returns void language plpgsql as $$
begin
 perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
  'nodeId',p_node,'machineIdSha256',p_host,'label','office-'||p_provider::text,'cpuMillis',6000,'memoryBytes',8589934592,
  'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
 perform public.qorpera_enroll_runtime_node_provider(p_node,p_host,'office',p_provider::text,repeat('f',64),2000,2147483648);
 perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
  'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_host,'socketPath','/var/snap/lxd/common/lxd/unix.socket',
  'socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd','serverVersion','5.21','architecture','x86_64'),
  'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
 perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
  'nodeId',p_node,'machineIdSha256',p_host,'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
  public.qorpera_runtime_node_inventory_context(p_node)->>'contextSha256',
  jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end $$;
create function pg_temp.office_fleet_offer(p_node uuid,p_host text,p_provider uuid,p_allocation uuid) returns jsonb language sql as $$
 select jsonb_build_object('schema','qorpera.office-fleet-offer/v1','scope',current_setting('qorpera_test.office_scope')::jsonb,
  'computerGeneration',1,'intentId',current_setting('qorpera_test.fleet_intent'),'providerId',p_provider,'nodeId',p_node,
  'policySha256',repeat('f',64),'machineIdSha256',p_host,'allocationId',p_allocation,'instanceSha256',repeat('1',64),
  'providerBindingSha256',repeat('2',64),'imageSha256',repeat('a',64),'bootstrapSha256',repeat('b',64),
  'cpuMillis',2000,'memoryBytes',2147483648,'serviceConfigSha256',repeat('3',64))
$$;
create function pg_temp.office_fleet_place() returns jsonb language sql as $$
 select public.qorpera_place_runtime_office_fleet(current_setting('qorpera_test.office_scope')::jsonb,1)
$$;
select pg_temp.office_fleet_node('60300000-0000-4000-8000-000000000010',repeat('c',64),'60300000-0000-4000-8000-000000000011');
select pg_temp.office_fleet_node('60300000-0000-4000-8000-000000000020',repeat('d',64),'60300000-0000-4000-8000-000000000021');
select set_config('qorpera_test.fleet_offer_a',pg_temp.office_fleet_offer('60300000-0000-4000-8000-000000000010',repeat('c',64),
 '60300000-0000-4000-8000-000000000011','60300000-0000-4000-8000-000000000012')::text,true);
select set_config('qorpera_test.fleet_offer_b',pg_temp.office_fleet_offer('60300000-0000-4000-8000-000000000020',repeat('d',64),
 '60300000-0000-4000-8000-000000000021','60300000-0000-4000-8000-000000000022')::text,true);
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','No offer cannot pin a provider');
select public.qorpera_offer_runtime_office_fleet(current_setting('qorpera_test.fleet_offer_a')::jsonb);
select public.qorpera_offer_runtime_office_fleet(current_setting('qorpera_test.fleet_offer_b')::jsonb);
select pg_temp.wake_error($q$select public.qorpera_offer_runtime_office_fleet(
 jsonb_set(current_setting('qorpera_test.fleet_offer_a')::jsonb,'{serviceConfigSha256}',to_jsonb(repeat('4',64))))$q$,'42501');
reset role;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_providers)
 and not exists(select 1 from public.qorpera_runtime_node_demands),'Staging cannot assign provider or capacity');
savepoint fleet_staged;

set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,nodeId}'='60300000-0000-4000-8000-000000000010','Equal capacity chooses first node deterministically');
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,allocationId}'='60300000-0000-4000-8000-000000000012','Lost reply replay retains one winner');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations)
 and (select count(*)=1 from public.qorpera_runtime_node_demands where reserved_at is not null)
 and (select state='provisioning' from public.qorpera_runtime_offices),'Placement reserves both ledgers without activating physical VM');
update public.qorpera_runtime_nodes set enabled=false;
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,nodeId}'='60300000-0000-4000-8000-000000000010','Existing placement survives candidate disable without rebind');
rollback to fleet_staged;

-- A full node is excluded and the second node accepts the new office.
update public.qorpera_runtime_nodes set headroom_cpu_millis=5000,standard_cpu_millis=1000 where id='60300000-0000-4000-8000-000000000010';
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,nodeId}'='60300000-0000-4000-8000-000000000020','Full first node places on second');
rollback to fleet_staged;

-- No usable capacity leaves no provider/start/allocation side effects.
update public.qorpera_runtime_nodes set headroom_cpu_millis=5000,standard_cpu_millis=1000;
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','No capacity waits');
reset role;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_providers)
 and not exists(select 1 from public.qorpera_runtime_machine_allocations)
 and (select allocation_id is null from public.qorpera_runtime_office_start_intents),'No ghost reservation or provider');
rollback to fleet_staged;

update public.qorpera_runtime_office_fleet_offers set ready_at=clock_timestamp()-interval '61 seconds';
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','Expired host offers cannot place');
rollback to fleet_staged;
update public.qorpera_runtime_nodes set version=version+1;
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','Stale inventory cannot place');
rollback to fleet_staged;

-- An older larger policy must not exclude this exact smaller installation.
update public.qorpera_runtime_nodes set headroom_cpu_millis=1000 where id='60300000-0000-4000-8000-000000000010';
set local role service_role;
select public.qorpera_enroll_runtime_node_provider('60300000-0000-4000-8000-000000000010',repeat('c',64),'office',
 '60300000-0000-4000-8000-000000000011',repeat('9',64),5000,2147483648);
reset role;
update public.qorpera_runtime_nodes set headroom_cpu_millis=2000 where id='60300000-0000-4000-8000-000000000010';
update public.qorpera_runtime_nodes set enabled=false where id='60300000-0000-4000-8000-000000000020';
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,nodeId}'='60300000-0000-4000-8000-000000000010','Exact offer size fits despite larger history');
rollback to fleet_staged;

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_cancel_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.fleet_intent')::uuid);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='held','Cancelled demand cannot place');
rollback to fleet_staged;

set local role service_role;
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
 '60300000-0000-4000-8000-000000000099',repeat('f',64),0,true);
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='retained','Legacy provider is never enrolled or moved by fleet');
reset role;
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_place_runtime_office_fleet(jsonb,bigint)','EXECUTE')
 and not has_table_privilege('service_role','public.qorpera_runtime_office_fleet_offers','SELECT,INSERT,UPDATE,DELETE'),'Fleet state stays broker-only');
