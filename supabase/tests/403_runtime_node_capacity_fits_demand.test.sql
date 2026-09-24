-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Bundle v96: a node admits a machine when the machine's OWN CPU and memory fit
-- in (configured - headroom - reserved), never "one whole free standard slot".
-- Node 2 on 2026-09-24: 8 vCPU / 16 GiB standard slot, 2 vCPU / 4 GiB coding
-- VMs. The capacity view reports the free CPU and memory admission uses.
-- The reservations below go through the real qorpera_reserve_runtime_node_machine;
-- only the coding workers and their company allocations are fixture rows (the
-- dispatch path allows one running coding session per owner and harness).
-- Two concurrent reservations of the last free share are serialised on the node
-- row: scripts/test-runtime-node-capacity.mjs proves that with real sessions.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','capacity-ack');
select public.qorpera_manage_agent_todo(current_setting('qorpera_test.wake_binding')::jsonb,
	'{"action":"upsert","operationKey":"capacity-todo","todoKey":"capacity","title":"Capacity fits demand"}');
reset role;

-- Five coding workers, each with an unreserved company allocation for one 2 vCPU / 4 GiB VM.
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select ('40300000-0000-4000-8000-00000000010' || n)::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'capacity-' || n,
	'coding','Capacity ' || n,'read','each','{}'::jsonb,'30000000-0000-4000-8000-000000000001',todo.created_by_run_id,
	'30000000-0000-4000-8000-000000000001',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo cross join generate_series(1,5) n where todo.todo_key = 'capacity';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select ('40300000-0000-4000-8000-00000000020' || n)::uuid,'30000000-0000-4000-8000-000000000010',
	('40300000-0000-4000-8000-00000000010' || n)::uuid,'coding-capacity',encode(extensions.digest('capacity-vm-' || n,'sha256'),'hex')
from generate_series(1,5) n;

create function pg_temp.cap_policy(p_cpu bigint,p_memory bigint,p_headroom_cpu bigint,p_headroom_memory bigint) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId','40300000-0000-4000-8000-000000000010',
		'machineIdSha256',repeat('4',64),'label','capacity-fixture','cpuMillis',p_cpu,'memoryBytes',p_memory,
		'headroomCpuMillis',p_headroom_cpu,'headroomMemoryBytes',p_headroom_memory,
		'standardCpuMillis',8000,'standardMemoryBytes',17179869184,'enabled',true)
$$;
-- A fresh hardware observation with a matching (empty) inventory report; a policy change needs a new one.
create function pg_temp.cap_observe() returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','40300000-0000-4000-8000-000000000010','machineIdSha256',repeat('4',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state','ready'),
		public.qorpera_runtime_node_inventory_context('40300000-0000-4000-8000-000000000010') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
create function pg_temp.cap_reserve(p_n integer) returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_node_machine(('40300000-0000-4000-8000-00000000020' || p_n)::uuid,'coding','coding-capacity',
		repeat('f',64),encode(extensions.digest('capacity-vm-' || p_n,'sha256'),'hex'),repeat('4',64),2000,4294967296)
$$;
create function pg_temp.cap() returns jsonb language sql as $$
	select public.qorpera_runtime_node_capacity('40300000-0000-4000-8000-000000000010')
$$;
create function pg_temp.cap_fits() returns boolean language sql as $$
	select (c ->> 'fits')::boolean from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('coding')) c
	where c ->> 'nodeId' = '40300000-0000-4000-8000-000000000010'
$$;

select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.cap() = '{"schema":"qorpera.runtime-node-capacity/v1","state":"unconfigured","admissibleSlots":0,
	"freeCpuMillis":0,"freeMemoryBytes":0,"overflow":"unavailable"}'::jsonb,'An unknown node reports nothing free');
-- 32 vCPU / 64 GiB, 24 vCPU / 32 GiB headroom: 8 vCPU / 32 GiB free, one 8 vCPU / 16 GiB standard slot.
select public.qorpera_configure_runtime_node(pg_temp.cap_policy(32000,68719476736,24000,34359738368),0);
select public.qorpera_enroll_runtime_node_provider('40300000-0000-4000-8000-000000000010',repeat('4',64),'coding','coding-capacity',repeat('f',64),2000,4294967296);
select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
	'nodeId','40300000-0000-4000-8000-000000000010','host',jsonb_build_object('machineIdSha256',repeat('4',64),
	'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
	'serverVersion','5.21','architecture','x86_64'),'operatingCpuMillis',2000,'operatingMemoryBytes',4294967296,'infrastructure','[]'::jsonb));
select pg_temp.wake_assert(pg_temp.cap() ->> 'state' = 'unavailable' and (pg_temp.cap() ->> 'freeCpuMillis')::bigint = 0
	and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 0 and (pg_temp.cap() ->> 'admissibleSlots')::bigint = 0,
	'Without a current observation nothing is free, as with admissibleSlots');
select pg_temp.cap_observe();
select pg_temp.wake_assert(pg_temp.cap() ->> 'state' = 'eligible' and (pg_temp.cap() ->> 'freeCpuMillis')::bigint = 8000
	and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 34359738368 and (pg_temp.cap() ->> 'admissibleSlots')::bigint = 1,
	'8 vCPU / 32 GiB free, one whole standard slot: '||pg_temp.cap()::text);

-- Four 2 vCPU coding VMs fit in 8 free vCPU although the first already leaves no whole standard slot.
select pg_temp.wake_assert(pg_temp.cap_reserve(1) ->> 'state' = 'reserved','First coding VM reserved');
select pg_temp.wake_assert((pg_temp.cap() ->> 'admissibleSlots')::bigint = 0 and (pg_temp.cap() ->> 'freeCpuMillis')::bigint = 6000
	and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 30064771072 and pg_temp.cap_fits(),
	'After one VM: no whole standard slot, but 6 vCPU / 28 GiB free and a coding VM still fits');
select pg_temp.wake_assert(pg_temp.cap_reserve(2) ->> 'state' = 'reserved','Second coding VM is admitted by its own size');
select pg_temp.wake_assert(pg_temp.cap_reserve(3) ->> 'state' = 'reserved','Third coding VM is admitted by its own size');
select pg_temp.wake_assert(pg_temp.cap_reserve(4) ->> 'state' = 'reserved','Fourth coding VM takes the last 2 vCPU');
select pg_temp.wake_assert(pg_temp.cap_reserve(2) ->> 'state' = 'reserved','A retry of a reserved VM is idempotent, not a second demand');
select pg_temp.wake_assert((pg_temp.cap() ->> 'freeCpuMillis')::bigint = 0 and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 17179869184
	and (pg_temp.cap() ->> 'allocatedCpuMillis')::bigint = 8000 and (pg_temp.cap() ->> 'allocatedComputers')::bigint = 4
	and not pg_temp.cap_fits(),'Four VMs hold all 8 free vCPU; 16 GiB memory stays free');
select pg_temp.wake_assert(pg_temp.cap_reserve(5) ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED','The fifth VM is refused on CPU');
select pg_temp.wake_assert((pg_temp.cap() ->> 'pendingRequests')::bigint = 1 and (pg_temp.cap() ->> 'allocatedComputers')::bigint = 4,
	'The refused VM waits; nothing was reserved for it');

-- Memory is checked on its own: 16 vCPU / 18 GiB free leaves CPU for the fifth VM but not 4 GiB of memory.
select public.qorpera_configure_runtime_node(pg_temp.cap_policy(32000,68719476736,16000,49392123904),1);
select pg_temp.wake_assert(pg_temp.cap_reserve(5) ->> 'reason' = 'NODE_OBSERVATION_UNAVAILABLE','A policy change needs a new observation');
select pg_temp.cap_observe();
select pg_temp.wake_assert((pg_temp.cap() ->> 'freeCpuMillis')::bigint = 8000 and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 2147483648
	and (pg_temp.cap() ->> 'admissibleSlots')::bigint = 0 and not pg_temp.cap_fits(),'8 vCPU but only 2 GiB free: '||pg_temp.cap()::text);
select pg_temp.wake_assert(pg_temp.cap_reserve(5) ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED','The fifth VM is refused on memory');

-- A released VM gives its exact share back; the waiting VM then fits.
reset role;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '40300000-0000-4000-8000-000000000201';
set local role service_role;
select pg_temp.wake_assert((pg_temp.cap() ->> 'freeCpuMillis')::bigint = 10000 and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 6442450944
	and pg_temp.cap_fits(),'The release frees exactly 2 vCPU / 4 GiB');
select pg_temp.wake_assert(pg_temp.cap_reserve(5) ->> 'state' = 'reserved','The waiting VM is admitted once its own size fits');
select pg_temp.wake_assert((pg_temp.cap() ->> 'freeCpuMillis')::bigint = 8000 and (pg_temp.cap() ->> 'freeMemoryBytes')::bigint = 2147483648
	and (pg_temp.cap() ->> 'pendingRequests')::bigint = 0 and (pg_temp.cap() ->> 'allocatedComputers')::bigint = 4,
	'Four VMs reserved again, none waiting');
-- Headroom cannot grow so far that the reserved machines no longer fit.
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.cap_policy(32000,68719476736,26000,49392123904),2)$q$,'55000');
reset role;

-- The view stays operator-only.
select pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_runtime_node_capacity(uuid)','EXECUTE'),
	'Capacity view is not public: ' || role_name) from unnest(array['anon','authenticated']) role_name;
rollback;
