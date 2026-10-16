-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The operator's views of a node read back what the node holds, for a folder-v2 company (launch checklist L26.3 "a
-- stale node observation shows as stale" and L28.2 "the view shows allocations, pending starts and waiting demand").
-- Alice's run from 924's base starts company machines through its own receipts until one node is full: ov-run running,
-- ov-start starting, ov-stop stopping, ov-fail failed and the big ov-big running. A sixth, ov-wait, waits in line, and
-- a coding machine of the same company is refused for room and stays pending on the node. Each operator view then
-- reads that back: qorpera_runtime_node_capacity (reservations, pending starts, what still fits),
-- qorpera_runtime_node_computers (every allocation on the node with its physical state), qorpera_runtime_host_inventory
-- (what the host reports), qorpera_runtime_compute_users (computers, companies and members on the node),
-- qorpera_runtime_computer_history (each machine's states over time), qorpera_runtime_node_health (the last measurement
-- and its time) and qorpera_runtime_compute_requests (the company's requests). A node that reports itself unavailable,
-- and a node whose observer has stopped (its last observation and health record moved two minutes back, older than the
-- 60-second window), read as unavailable, stale or unknown in every view, never as healthy or eligible. Only the
-- service role may read any of them. What L28.2 asks that the views do not show yet (allocations by state in the
-- capacity view, the waiting machine and the refused coding machine with their reasons, the placed machines among the
-- company's requests) is checked by test 433 with its fix (slot 20260930494000).

-- A coding worker of Alice's, on a real todo in her folder, with an unreserved company allocation for one
-- 2 CPU / 4 GiB machine (the dispatch path allows one coding session per owner and harness, so it is a fixture row).
select pg_temp.base_commit(pg_temp.base_owner(), 'operator-views-todo', jsonb_build_array(pg_temp.base_write('agents/alice/todos/operator-views.md',
	'todo', E'---\nid: 42400000-0000-4000-8000-0000000000d1\ntitle: Operator views\nstatus: open\n---\n\n',
	'{"kind":"todo","id":"42400000-0000-4000-8000-0000000000d1","title":"Operator views","status":"open","requestedBy":null,"detail":""}'))) \g /dev/null
reset role;
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select '42400000-0000-4000-8000-000000000101'::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'operator-views-1',
	'coding','Operator views','read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	'92400000-0000-4000-8000-000000000001',(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo
where todo.id = '42400000-0000-4000-8000-0000000000d1' and todo.staff_agent_id = '92400000-0000-4000-8000-000000000030';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select '42400000-0000-4000-8000-000000000201'::uuid,worker.profile_id,worker.id,'coding-ov',encode(extensions.digest('operator-vm-1','sha256'),'hex')
from public.qorpera_runtime_workers worker where worker.id = '42400000-0000-4000-8000-000000000101';
select pg_temp.base_assert((select count(*) from public.qorpera_runtime_machine_allocations
	where id = '42400000-0000-4000-8000-000000000201' and profile_id = '92400000-0000-4000-8000-000000000010') = 1,
	'fixture: one coding allocation of the folder-v2 company');
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','machine-ack') \g /dev/null

create function pg_temp.ov_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
-- The exact envelope the native tool operations hash for machine_start (as in 628).
create function pg_temp.ov_start_envelope(p_key text,p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.ov_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
-- The run starts a machine under its own receipt: authorize, begin the receipt, start, complete.
create function pg_temp.ov_start(p_key text,p_args jsonb) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.ov_start_envelope(p_key,p_args);
	v_sha text := encode(extensions.digest(convert_to(v_envelope,'UTF8'),'sha256'),'hex');
	v_receipt uuid := extensions.gen_random_uuid(); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.ov_binding(),v_envelope,'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.ov_binding(),v_receipt,'machine_start:' || p_key,v_sha,repeat('9',64),false);
	v_result := public.qorpera_native_machine_start(pg_temp.ov_binding(),v_envelope,'begin',v_receipt,repeat('9',64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.ov_binding(),v_receipt,v_sha,v_result);
	return v_result;
end
$$;
create function pg_temp.ov_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.ov_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
-- A machine's node allocation has its placement's id.
create function pg_temp.ov_alloc(p_name text) returns uuid language sql as $$ select (pg_temp.ov_placement(p_name)).id $$;
-- A fresh observation of node A whose inventory reports exactly its reserved machines, each in the state p_states
-- names for its allocation (running when not named).
create function pg_temp.ov_observe(p_state text default 'ready',p_states jsonb default '{}') returns jsonb language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('42400000-0000-4000-8000-000000000410');
begin
	return public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','42400000-0000-4000-8000-000000000410','machineIdSha256',repeat('4',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state',p_state),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId','42400000-0000-4000-8000-0000000004b0','entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state',coalesce(p_states ->> (a ->> 'allocationId'),'running'),
				'configurationSha256',repeat('7',64),'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,
				'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
create function pg_temp.ov_states() returns jsonb language sql as $$
	select jsonb_build_object(pg_temp.ov_alloc('ov-start'),'starting',pg_temp.ov_alloc('ov-stop'),'stopping',pg_temp.ov_alloc('ov-fail'),'failed')
$$;
create function pg_temp.ov_expected() returns jsonb language sql as $$
	select '{"ov-run":"running","ov-start":"starting","ov-stop":"stopping","ov-fail":"failed","ov-big":"running"}'::jsonb
$$;
create function pg_temp.ov_cap(p_node uuid default '42400000-0000-4000-8000-000000000410') returns jsonb language sql as $$
	select public.qorpera_runtime_node_capacity(p_node)
$$;
create function pg_temp.ov_computers() returns jsonb language sql as $$
	select public.qorpera_runtime_node_computers('42400000-0000-4000-8000-000000000410')
$$;
create function pg_temp.ov_host() returns jsonb language sql as $$
	select public.qorpera_runtime_host_inventory('42400000-0000-4000-8000-000000000410')
$$;
create function pg_temp.ov_health(p_node uuid default '42400000-0000-4000-8000-000000000410') returns jsonb language sql as $$
	select public.qorpera_runtime_node_health(p_node)
$$;
create function pg_temp.ov_users() returns jsonb language sql as $$
	select public.qorpera_runtime_compute_users('42400000-0000-4000-8000-000000000410',statement_timestamp() - interval '1 hour',statement_timestamp())
$$;
create function pg_temp.ov_history(p_allocation uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_computer_history(p_allocation,statement_timestamp() - interval '1 hour',statement_timestamp())
$$;
create function pg_temp.ov_computer(p_view jsonb,p_allocation uuid) returns jsonb language sql as $$
	select c from jsonb_array_elements(p_view -> 'computers') c where c ->> 'allocationId' = p_allocation::text
$$;
create function pg_temp.ov_entry(p_view jsonb,p_allocation uuid) returns jsonb language sql as $$
	select e from jsonb_array_elements(p_view -> 'entries') e where e #>> '{recordedAllocation,allocationId}' = p_allocation::text
$$;
create function pg_temp.ov_observed() returns timestamptz language sql as $$
	select observed_at from public.qorpera_runtime_node_observations where node_id = '42400000-0000-4000-8000-000000000410'
$$;
-- The coding machine asks node A for its 2 CPU / 4 GiB.
create function pg_temp.ov_reserve_vm() returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_node_machine('42400000-0000-4000-8000-000000000201','coding','coding-ov',repeat('f',64),
		encode(extensions.digest('operator-vm-1','sha256'),'hex'),repeat('4',64),2000,4294967296)
$$;
-- A health record of node A, current and newer than the last one: complete, or with its collection unconfirmed.
create function pg_temp.ov_health_record(p_complete boolean) returns jsonb language plpgsql as $$
declare v_at timestamptz := greatest(date_trunc('milliseconds',clock_timestamp()),coalesce((select observed_at + interval '1 millisecond'
		from public.qorpera_runtime_node_health_latest where node_id = '42400000-0000-4000-8000-000000000410'),'-infinity'));
	v_format text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
begin
	return jsonb_build_object('schema','qorpera.runtime-node-health/v1','nodeId','42400000-0000-4000-8000-000000000410',
		'machineIdSha256',repeat('4',64),
		'policySha256',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies where node_id = '42400000-0000-4000-8000-000000000410'),
		'observerPackageSha256',case when p_complete then repeat('6',64) end,
		'bootId',case when p_complete then '42400000-0000-4000-8000-0000000004b0' end,
		'observationId',extensions.gen_random_uuid(),'observedAt',to_char(v_at at time zone 'UTC',v_format),
		'cpu',case when p_complete then jsonb_build_object('usedBasisPoints',2500,
			'from',to_char((v_at - interval '2 seconds') at time zone 'UTC',v_format),
			'until',to_char((v_at - interval '1 second') at time zone 'UTC',v_format)) end,
		'memory',case when p_complete then jsonb_build_object('totalBytes',68719476736,'availableBytes',34359738368) end,
		'rootFilesystem',case when p_complete then jsonb_build_object('totalBytes',1000000000000,'freeBytes',600000000000,
			'availableBytes',500000000000) end,
		'network',case when p_complete then jsonb_build_object('receivedBytes',123456,'sentBytes',654321,'receiveErrors',0,'sendErrors',0,
			'receiveDrops',0,'sendDrops',0) end,
		'errors',case when p_complete then '[]'::jsonb else '["COLLECTION_UNCONFIRMED"]'::jsonb end);
end
$$;

-- Node A: 16 CPUs / 64 GiB with 2 CPUs / 8 GiB headroom, so 14 CPUs / 56 GiB to give; it serves company machines up
-- to 8 CPUs / 32 GiB and coding machines of 2 CPUs / 4 GiB. It has not reported yet.
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','42400000-0000-4000-8000-000000000410','machineIdSha256',repeat('4',64),'label','operator-a','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','42400000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('4',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_enroll_runtime_node_provider('42400000-0000-4000-8000-000000000410',repeat('4',64),'machine','machine-fixture',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_enroll_runtime_node_provider('42400000-0000-4000-8000-000000000410',repeat('4',64),'coding','coding-ov',
		repeat('f',64),2000,4294967296);
end $$;

-- 1. Before the node's first observation no view calls it eligible, healthy or holding anything; an unknown node is
--    not configured.
do $$
declare v_cap jsonb := pg_temp.ov_cap(); v_computers jsonb := pg_temp.ov_computers(); v_host jsonb := pg_temp.ov_host();
	v_health jsonb := pg_temp.ov_health(); v_users jsonb := pg_temp.ov_users();
begin
	perform pg_temp.base_assert(v_cap ->> 'schema' = 'qorpera.runtime-node-capacity/v1' and v_cap ->> 'state' = 'unavailable'
		and (v_cap ->> 'freeCpuMillis')::bigint = 0 and (v_cap ->> 'freeMemoryBytes')::bigint = 0 and (v_cap ->> 'admissibleSlots')::bigint = 0
		and (v_cap ->> 'allocatedComputers')::bigint = 0 and v_cap -> 'observedAt' = 'null'::jsonb,
		'Capacity before any observation is unavailable with nothing free: ' || v_cap::text);
	perform pg_temp.base_assert(pg_temp.ov_cap('42400000-0000-4000-8000-000000000499')
		= '{"schema":"qorpera.runtime-node-capacity/v1","state":"unconfigured","admissibleSlots":0,"freeCpuMillis":0,"freeMemoryBytes":0,"overflow":"unavailable"}'::jsonb,
		'An unknown node''s capacity is unconfigured');
	perform pg_temp.base_assert(v_computers ->> 'schema' = 'qorpera.runtime-node-computers/v1'
		and v_computers ->> 'observationUnavailableReason' = 'OBSERVATION_MISSING'
		and v_computers -> 'computers' = '[]'::jsonb and v_computers -> 'observedAt' = 'null'::jsonb,
		'Node computers says the observation is missing: ' || v_computers::text);
	perform pg_temp.base_assert(v_host ->> 'schema' = 'qorpera.runtime-host-inventory/v1' and v_host ->> 'currentStateReason' = 'OBSERVATION_MISSING'
		and not (v_host ->> 'currentStateAvailable')::boolean and v_host -> 'entries' = '[]'::jsonb,
		'Host inventory says the observation is missing: ' || v_host::text);
	perform pg_temp.base_assert(v_health ->> 'schema' = 'qorpera.runtime-node-health-view/v1' and v_health ->> 'state' = 'unknown'
		and v_health ->> 'reason' = 'OBSERVATION_MISSING' and v_health -> 'observedAt' = 'null'::jsonb
		and v_health -> 'currentMeasurement' = 'null'::jsonb,
		'Health without any observation is unknown, not healthy: ' || v_health::text);
	perform pg_temp.base_assert(pg_temp.ov_health('42400000-0000-4000-8000-000000000499') ->> 'state' = 'unknown'
		and pg_temp.ov_health('42400000-0000-4000-8000-000000000499') ->> 'reason' = 'NODE_UNCONFIGURED',
		'An unknown node''s health is unknown');
	perform pg_temp.base_assert(v_users ->> 'schema' = 'qorpera.runtime-compute-users/v1'
		and (v_users #>> '{currentAllocation,allocatedComputers}')::bigint = 0 and (v_users #>> '{currentAllocation,companies}')::bigint = 0,
		'No computers on the node yet: ' || v_users::text);
	perform pg_temp.base_error($sql$select public.qorpera_runtime_node_health(null::uuid)$sql$,'22023','Node identity required');
	perform pg_temp.base_error($sql$select public.qorpera_runtime_node_computers('42400000-0000-4000-8000-000000000499')$sql$,
		'22023','Node is not configured');
	perform pg_temp.base_error($sql$select public.qorpera_runtime_host_inventory('42400000-0000-4000-8000-000000000499')$sql$,
		'22023','Node is not configured');
	perform pg_temp.base_error($sql$select public.qorpera_runtime_compute_users('42400000-0000-4000-8000-000000000499',
		statement_timestamp() - interval '1 hour',statement_timestamp())$sql$,'22023','Invalid computer user window');
	perform pg_temp.base_error($sql$select public.qorpera_runtime_computer_history('42400000-0000-4000-8000-000000000499',
		statement_timestamp() - interval '1 hour',statement_timestamp())$sql$,'22023','Computer placement history is unavailable');
end $$;

-- 2. The node reports and gets an executor; the run fills it. Four 2 CPU / 4 GiB machines and one 6 CPU / 24 GiB machine
--    take all 14 CPUs it gives; the next machine waits in line, and the coding machine is refused for room and stays
--    pending. The capacity view counts the five reservations, the pending start, and what still fits.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture','providerPolicySha256',repeat('f',64),'project','machines',
		'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
	v_name text; v_started jsonb; v_wait jsonb; v_vm jsonb; v_cap jsonb;
begin
	perform pg_temp.ov_observe();
	perform public.qorpera_configure_machine_executor('mx-ov',repeat('4',64),true,v_policy,322122547200);
	foreach v_name in array array['ov-run','ov-start','ov-stop','ov-fail','ov-big'] loop
		v_started := pg_temp.ov_start('m-' || v_name,jsonb_build_object('name',v_name,'purpose','Operator view fixture',
			'cpus',case when v_name = 'ov-big' then 6 else 2 end,'memoryGiB',case when v_name = 'ov-big' then 24 else 4 end,
			'diskGiB',case when v_name = 'ov-big' then 40 else 10 end,'lifetime','task'));
		perform pg_temp.base_assert(v_started #>> '{machine,state}' = 'starting' and pg_temp.ov_alloc(v_name) is not null,
			v_name || ' is placed on node A: ' || v_started::text);
	end loop;
	v_wait := pg_temp.ov_start('m-ov-wait','{"name":"ov-wait","purpose":"Operator view fixture","cpus":2,"memoryGiB":4,"diskGiB":10,"lifetime":"task"}');
	perform pg_temp.base_assert(v_wait #>> '{machine,state}' = 'waiting' and (v_wait #>> '{machine,queuePosition}')::int = 1
		and v_wait #>> '{machine,waitingFor}' = 'NODE_CAPACITY_EXHAUSTED' and (pg_temp.ov_machine('ov-wait')).id is not null
		and pg_temp.ov_alloc('ov-wait') is null,
		'ov-wait waits in line, unplaced: ' || v_wait::text);
	v_vm := pg_temp.ov_reserve_vm();
	perform pg_temp.base_assert(v_vm ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED','The coding machine is refused for room: ' || v_vm::text);
	perform pg_temp.ov_observe();
	v_cap := pg_temp.ov_cap();
	perform pg_temp.base_assert(v_cap ->> 'state' = 'eligible' and (v_cap ->> 'allocatedComputers')::bigint = 5
		and (v_cap ->> 'allocatedCpuMillis')::bigint = 14000 and (v_cap ->> 'allocatedMemoryBytes')::bigint = 42949672960
		and (v_cap ->> 'allocatedCompanies')::bigint = 1 and (v_cap ->> 'pendingRequests')::bigint = 1
		and (v_cap ->> 'freeCpuMillis')::bigint = 0 and (v_cap ->> 'freeMemoryBytes')::bigint = 17179869184
		and (v_cap ->> 'admissibleSlots')::bigint = 0 and (v_cap ->> 'observedAt')::timestamptz = pg_temp.ov_observed(),
		'Capacity counts five reservations, one pending start, no CPU and 16 GiB left: ' || v_cap::text);
end $$;

-- 3. The node reports each machine's state. Node computers, host inventory and history read the same machines back in
--    those states, the pending coding machine with its refusal; compute users counts the five computers of one company.
select pg_temp.ov_observe('ready',pg_temp.ov_states()) \g /dev/null
do $$
declare v_computers jsonb := pg_temp.ov_computers(); v_host jsonb := pg_temp.ov_host(); v_users jsonb := pg_temp.ov_users();
	v_name text; v_state text; v_row jsonb; v_entry jsonb; v_history jsonb; v_last jsonb; v_vm jsonb;
begin
	perform pg_temp.base_assert(v_computers -> 'observationUnavailableReason' = 'null'::jsonb
		and jsonb_array_length(v_computers -> 'computers') = 6 and (v_computers ->> 'observedAt')::timestamptz = pg_temp.ov_observed(),
		'Node computers lists the five machines and the coding machine, with the observation time: ' || v_computers::text);
	perform pg_temp.base_assert(v_host -> 'currentStateReason' = 'null'::jsonb and (v_host ->> 'currentStateAvailable')::boolean
		and v_host ->> 'coverage' = 'complete_host_observation' and jsonb_array_length(v_host -> 'entries') = 5
		and (v_host ->> 'observedAt')::timestamptz = pg_temp.ov_observed(),
		'Host inventory reports the five machines: ' || v_host::text);
	for v_name,v_state in select key,value #>> '{}' from jsonb_each(pg_temp.ov_expected()) loop
		v_row := pg_temp.ov_computer(v_computers,pg_temp.ov_alloc(v_name));
		perform pg_temp.base_assert(v_row ->> 'companyId' = '92400000-0000-4000-8000-000000000010' and v_row ->> 'providerKind' = 'machine'
			and v_row ->> 'nodeAllocationState' = 'reserved' and v_row ->> 'physicalState' = v_state
			and v_row ->> 'physicalStateReason' = 'PHYSICAL_INVENTORY_OBSERVATION' and v_row -> 'physicalBinding' <> 'null'::jsonb
			and (v_row ->> 'cpuMillis')::bigint = case when v_name = 'ov-big' then 6000 else 2000 end
			and v_row ->> 'runningWorkState' = case when v_state = 'running' then 'without_recorded_active_jobs' else 'not_classified' end,
			'Node computers shows ' || v_name || ' ' || v_state || ': ' || coalesce(v_row::text,'missing'));
		v_entry := pg_temp.ov_entry(v_host,pg_temp.ov_alloc(v_name));
		perform pg_temp.base_assert(v_entry ->> 'companyId' = '92400000-0000-4000-8000-000000000010' and v_entry ->> 'currentState' = v_state
			and v_entry ->> 'currentStateReason' = 'PHYSICAL_INVENTORY_OBSERVATION' and v_entry ->> 'category' = 'managed',
			'Host inventory shows ' || v_name || ' ' || v_state || ': ' || coalesce(v_entry::text,'missing'));
		v_history := pg_temp.ov_history(pg_temp.ov_alloc(v_name));
		v_last := v_history -> 'intervals' -> -1;
		perform pg_temp.base_assert(v_history ->> 'schema' = 'qorpera.runtime-computer-history/v1'
			and v_history ->> 'profileId' = '92400000-0000-4000-8000-000000000010' and v_history #>> '{placement,providerKind}' = 'machine'
			and v_history #> '{placement,physical}' <> 'null'::jsonb and v_history -> 'nodeReservedAt' <> 'null'::jsonb
			and v_last ->> 'state' = v_state and v_last ->> 'reason' = 'PHYSICAL_INVENTORY_OBSERVATION'
			and (v_history #>> array['usage',case v_state when 'running' then 'estimatedRunningComputerHours'
				when 'starting' then 'estimatedStartingHours' when 'stopping' then 'estimatedStoppingHours'
				else 'failedOrUnavailableHours' end])::numeric > 0,
			'History ends with ' || v_name || ' ' || v_state || ' and counts its hours: ' || coalesce(v_history::text,'missing'));
	end loop;
	v_vm := pg_temp.ov_computer(v_computers,'42400000-0000-4000-8000-000000000201');
	perform pg_temp.base_assert(v_vm ->> 'companyId' = '92400000-0000-4000-8000-000000000010' and v_vm ->> 'providerKind' = 'coding'
		and v_vm ->> 'nodeAllocationState' = 'pending' and v_vm ->> 'physicalState' = 'unknown'
		and v_vm ->> 'physicalStateReason' = 'NODE_CAPACITY_PENDING' and v_vm ->> 'lastAdmissionRefusal' = 'NODE_CAPACITY_EXHAUSTED'
		and v_vm -> 'nodeReservedAt' = 'null'::jsonb,
		'Node computers shows the coding machine pending with its refusal: ' || coalesce(v_vm::text,'missing'));
	v_history := pg_temp.ov_history('42400000-0000-4000-8000-000000000201');
	perform pg_temp.base_assert(v_history -> 'nodeReservedAt' = 'null'::jsonb and v_history -> 'intervals' = '[]'::jsonb
		and v_history #>> '{placement,providerKind}' = 'coding',
		'A pending machine has no placed history: ' || v_history::text);
	perform pg_temp.base_error(format($sql$select public.qorpera_runtime_computer_history(%L,statement_timestamp() - interval '1 hour',
		statement_timestamp())$sql$,(pg_temp.ov_machine('ov-wait')).id),'22023','Computer placement history is unavailable');
	perform pg_temp.base_assert((v_users #>> '{currentAllocation,allocatedComputers}')::bigint = 5
		and (v_users #>> '{currentAllocation,companies}')::bigint = 1
		and (v_users #>> '{currentAllocation,associatedMembers}')::bigint = (select count(distinct user_id) from public.qorpera_profile_members
			where profile_id = '92400000-0000-4000-8000-000000000010')
		and v_users #>> '{activity,state}' = 'unknown' and v_users #>> '{activity,reason}' = 'NO_ACTIVITY_OBSERVATIONS'
		and v_users #> '{activity,observedActiveUsers}' = 'null'::jsonb,
		'Compute users counts five computers of one company and observes no activity: ' || v_users::text);
end $$;

-- 4. The node reports itself unavailable (ov-fail with it): capacity has nothing to give, and node computers, host
--    inventory and history call every machine unknown, never running.
select pg_temp.ov_observe('unavailable',pg_temp.ov_states() || jsonb_build_object(pg_temp.ov_alloc('ov-fail'),'unavailable')) \g /dev/null
do $$
declare v_cap jsonb := pg_temp.ov_cap(); v_computers jsonb := pg_temp.ov_computers(); v_host jsonb := pg_temp.ov_host();
	v_history jsonb := pg_temp.ov_history(pg_temp.ov_alloc('ov-fail'));
begin
	perform pg_temp.base_assert(v_cap ->> 'state' = 'unavailable' and (v_cap ->> 'freeCpuMillis')::bigint = 0
		and (v_cap ->> 'freeMemoryBytes')::bigint = 0 and (v_cap ->> 'admissibleSlots')::bigint = 0,
		'An unavailable node has nothing to give: ' || v_cap::text);
	perform pg_temp.base_assert(v_computers ->> 'observationUnavailableReason' = 'NODE_UNAVAILABLE'
		and jsonb_array_length(v_computers -> 'computers') = 6
		and not exists (select 1 from jsonb_array_elements(v_computers -> 'computers') c
			where c ->> 'physicalState' <> 'unknown' or c ->> 'physicalStateReason' <> 'NODE_UNAVAILABLE'),
		'Node computers calls every machine unknown on an unavailable node: ' || v_computers::text);
	perform pg_temp.base_assert(v_host ->> 'currentStateReason' = 'NODE_UNAVAILABLE' and not (v_host ->> 'currentStateAvailable')::boolean
		and v_host ->> 'coverage' = 'unconfirmed_observation_entries' and jsonb_array_length(v_host -> 'entries') = 5
		and not exists (select 1 from jsonb_array_elements(v_host -> 'entries') e where e ->> 'currentState' <> 'unknown')
		and pg_temp.ov_entry(v_host,pg_temp.ov_alloc('ov-fail')) -> 'reportedState' = '"unavailable"'::jsonb,
		'Host inventory keeps what was reported but calls nothing current: ' || v_host::text);
	perform pg_temp.base_assert(v_history -> 'intervals' -> -1 ->> 'state' = 'unknown'
		and v_history -> 'intervals' -> -1 ->> 'reason' = 'NODE_UNAVAILABLE',
		'History marks the unavailable time unknown: ' || v_history::text);
end $$;
select pg_temp.ov_observe('ready',pg_temp.ov_states()) \g /dev/null

-- 5. Health: a record whose collection is unconfirmed reads unknown, never healthy; a complete one reads complete with
--    its observation time and measurement.
select set_config('qorpera_test.ov_unconfirmed',pg_temp.ov_health_record(false)::text,true) \g /dev/null
select public.qorpera_observe_runtime_node_health(current_setting('qorpera_test.ov_unconfirmed')::jsonb) \g /dev/null
do $$
declare v_record jsonb := current_setting('qorpera_test.ov_unconfirmed')::jsonb; v_health jsonb := pg_temp.ov_health();
begin
	perform pg_temp.base_assert(v_health ->> 'state' = 'unknown' and v_health ->> 'reason' = 'COLLECTION_UNCONFIRMED'
		and v_health -> 'currentMeasurement' = 'null'::jsonb and v_health -> 'lastObservation' = v_record
		and (v_health ->> 'observedAt')::timestamptz = (v_record ->> 'observedAt')::timestamptz,
		'An unconfirmed collection is unknown, not healthy: ' || v_health::text);
end $$;
select set_config('qorpera_test.ov_complete',pg_temp.ov_health_record(true)::text,true) \g /dev/null
select public.qorpera_observe_runtime_node_health(current_setting('qorpera_test.ov_complete')::jsonb) \g /dev/null
do $$
declare v_record jsonb := current_setting('qorpera_test.ov_complete')::jsonb; v_health jsonb := pg_temp.ov_health();
begin
	perform pg_temp.base_assert(v_health ->> 'state' = 'complete' and v_health -> 'reason' = 'null'::jsonb
		and v_health -> 'currentMeasurement' = v_record and (v_health ->> 'observedAt')::timestamptz = (v_record ->> 'observedAt')::timestamptz,
		'A complete record shows with its time: ' || v_health::text);
end $$;

-- 6. The observer stops: node A's last observation and health record are two minutes old (everything the node recorded
--    moves back with them), past the 60-second window. No view calls the node or its machines current: capacity is
--    unavailable and admits nothing, node computers, host inventory and health say stale, and history ends unknown.
--    A fresh observation makes the node eligible again.
update public.qorpera_runtime_node_observations set observed_at = observed_at - interval '2 minutes',
	received_at = received_at - interval '2 minutes' where node_id = '42400000-0000-4000-8000-000000000410';
update public.qorpera_runtime_node_observation_receipts set observed_at = observed_at - interval '2 minutes',
	received_at = received_at - interval '2 minutes' where node_id = '42400000-0000-4000-8000-000000000410';
update public.qorpera_runtime_node_health_receipts set observed_at = observed_at - interval '2 minutes',
	received_at = received_at - interval '2 minutes' where node_id = '42400000-0000-4000-8000-000000000410';
update public.qorpera_runtime_node_health_latest set observed_at = observed_at - interval '2 minutes'
	where node_id = '42400000-0000-4000-8000-000000000410';
update public.qorpera_runtime_node_demands set requested_at = requested_at - interval '2 minutes',
	last_checked_at = last_checked_at - interval '2 minutes', reserved_at = reserved_at - interval '2 minutes'
	where node_id = '42400000-0000-4000-8000-000000000410';
do $$
declare v_cap jsonb := pg_temp.ov_cap(); v_computers jsonb := pg_temp.ov_computers(); v_host jsonb := pg_temp.ov_host();
	v_health jsonb := pg_temp.ov_health(); v_history jsonb := pg_temp.ov_history(pg_temp.ov_alloc('ov-run')); v_vm jsonb;
begin
	perform pg_temp.base_assert(pg_temp.ov_observed() <= statement_timestamp() - interval '60 seconds',
		'fixture: the last observation is older than its window');
	perform pg_temp.base_assert(v_cap ->> 'state' = 'unavailable' and (v_cap ->> 'freeCpuMillis')::bigint = 0
		and (v_cap ->> 'freeMemoryBytes')::bigint = 0 and (v_cap ->> 'admissibleSlots')::bigint = 0
		and (v_cap ->> 'observedAt')::timestamptz = pg_temp.ov_observed(),
		'A stale node is not eligible and shows its last observation time: ' || v_cap::text);
	perform pg_temp.base_assert(v_computers ->> 'observationUnavailableReason' = 'OBSERVATION_STALE'
		and (v_computers ->> 'observedAt')::timestamptz = pg_temp.ov_observed() and jsonb_array_length(v_computers -> 'computers') = 6
		and not exists (select 1 from jsonb_array_elements(v_computers -> 'computers') c
			where c ->> 'physicalState' <> 'unknown' or c ->> 'physicalStateReason' <> 'OBSERVATION_STALE'),
		'Node computers says stale and calls no machine running: ' || v_computers::text);
	perform pg_temp.base_assert(v_host ->> 'currentStateReason' = 'OBSERVATION_STALE' and not (v_host ->> 'currentStateAvailable')::boolean
		and (v_host ->> 'observedAt')::timestamptz = pg_temp.ov_observed()
		and not exists (select 1 from jsonb_array_elements(v_host -> 'entries') e where e ->> 'currentState' <> 'unknown'),
		'Host inventory says stale: ' || v_host::text);
	perform pg_temp.base_assert(v_health ->> 'state' = 'unknown' and v_health ->> 'reason' = 'OBSERVATION_STALE'
		and v_health -> 'currentMeasurement' = 'null'::jsonb
		and v_health -> 'lastObservation' = current_setting('qorpera_test.ov_complete')::jsonb
		and (v_health ->> 'observedAt')::timestamptz <= statement_timestamp() - interval '60 seconds',
		'Health of a stopped observer is stale, not healthy, and keeps its last record and time: ' || v_health::text);
	perform pg_temp.base_assert(v_history -> 'intervals' -> -1 ->> 'state' = 'unknown'
		and v_history -> 'intervals' -> -1 ->> 'reason' = 'OBSERVATION_STALE'
		and exists (select 1 from jsonb_array_elements(v_history -> 'intervals') i where i ->> 'state' = 'running'),
		'History holds a sample 60 seconds, then calls the machine unknown: ' || v_history::text);
	v_vm := pg_temp.ov_reserve_vm();
	perform pg_temp.base_assert(v_vm ->> 'reason' = 'NODE_OBSERVATION_UNAVAILABLE','A stale node admits nothing: ' || v_vm::text);
end $$;
select pg_temp.ov_observe('ready',pg_temp.ov_states()) \g /dev/null
do $$
declare v_cap jsonb := pg_temp.ov_cap(); v_vm jsonb := pg_temp.ov_reserve_vm();
begin
	perform pg_temp.base_assert(v_cap ->> 'state' = 'eligible' and (v_cap ->> 'freeMemoryBytes')::bigint = 17179869184
		and v_vm ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED',
		'A fresh observation makes the node eligible again, still full: ' || v_cap::text || ' ' || v_vm::text);
end $$;

-- 7. Only the service role reads these views. A member's (the owner's), an anonymous or an empty claim is refused with
--    42501, and the authenticated and anon database roles may not call them at all.
select set_config('qorpera_test.ov_run',pg_temp.ov_alloc('ov-run')::text,true) \g /dev/null
create function pg_temp.ov_views() returns table(p_sql text,p_message text) language sql as $$
	select * from (values
		($q$select public.qorpera_runtime_node_capacity('42400000-0000-4000-8000-000000000410')$q$,'Operator authority required'),
		($q$select public.qorpera_runtime_node_computers('42400000-0000-4000-8000-000000000410')$q$,'Operator authority required'),
		($q$select public.qorpera_runtime_host_inventory('42400000-0000-4000-8000-000000000410')$q$,'Operator authority required'),
		($q$select public.qorpera_runtime_node_health('42400000-0000-4000-8000-000000000410')$q$,'Operator authority required'),
		($q$select public.qorpera_runtime_compute_users('42400000-0000-4000-8000-000000000410',statement_timestamp() - interval '1 hour',
			statement_timestamp())$q$,'Operator authority required'),
		($q$select public.qorpera_runtime_computer_history(current_setting('qorpera_test.ov_run')::uuid,statement_timestamp() - interval '1 hour',
			statement_timestamp())$q$,'Computer history requires operator authority'),
		($q$select public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010')$q$,'Operator authority required')) v
$$;
do $$
declare v_sql text; v_result jsonb; v_claims text; v_view record;
begin
	for v_sql in select p_sql from pg_temp.ov_views() loop
		execute v_sql into v_result;
		perform pg_temp.base_assert(v_result ->> 'schema' like 'qorpera.runtime-%','The service role reads: ' || v_sql);
	end loop;
	foreach v_claims in array array[jsonb_build_object('role','authenticated','sub','92400000-0000-4000-8000-000000000001')::text,
		'{"role":"anon"}','']
	loop
		perform set_config('request.jwt.claims',v_claims,true);
		for v_view in select * from pg_temp.ov_views() loop
			perform pg_temp.base_error(v_view.p_sql,'42501',v_view.p_message);
		end loop;
	end loop;
	perform pg_temp.base_claims('service_role');
end $$;
set local role authenticated;
select pg_temp.base_error(p_sql,'42501') from pg_temp.ov_views() \g /dev/null
reset role;
set local role anon;
select pg_temp.base_error(p_sql,'42501') from pg_temp.ov_views() \g /dev/null
reset role;
select pg_temp.base_assert((select bool_and(not has_function_privilege('anon',f,'execute') and not has_function_privilege('authenticated',f,'execute')
		and has_function_privilege('service_role',f,'execute'))
	from unnest(array['public.qorpera_runtime_node_capacity(uuid)','public.qorpera_runtime_node_computers(uuid,uuid,integer)',
		'public.qorpera_runtime_host_inventory(uuid,uuid,text,text,integer)','public.qorpera_runtime_node_health(uuid)',
		'public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz)','public.qorpera_runtime_computer_history(uuid,timestamptz,timestamptz)',
		'public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)']) f),
	'Only the service role may execute the operator views');
select pg_temp.base_claims('service_role');

-- 8. Compute requests lists the company's login and its run's job.
do $$
declare v_requests jsonb := public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010');
begin
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v_requests -> 'requests') r where r ->> 'kind' = 'login'
			and r ->> 'requestId' = current_setting('qorpera_test.base_login')::jsonb ->> 'login_id')
		and exists (select 1 from jsonb_array_elements(v_requests -> 'requests') r where r ->> 'kind' = 'native'
			and r ->> 'requestId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId'),
		'Compute requests lists the company''s login and its run''s job: ' || v_requests::text);
end $$;

rollback;
