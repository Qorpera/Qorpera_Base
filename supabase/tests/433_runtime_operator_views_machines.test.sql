-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The operator's compute requests and node capacity views show a folder-v2 company's machines (launch checklist L28.2
-- "the view shows allocations, pending starts and waiting demand"; the gap test 424 found, fixed by 20260930494000).
-- Alice's run from 924's base starts company machines through its own receipts until one node is full: mq-run,
-- mq-start, mq-stop, mq-fail and the big mq-big are placed on node A, mq-wait waits in line, and a coding machine of
-- the same company is refused for room. qorpera_runtime_compute_requests lists each of them as kind 'machine': the
-- waiting one with its place in line, its reason and no node, the refused coding machine with its reason, and each
-- placed one with its node allocation. qorpera_runtime_node_capacity counts the node's machines by state exactly as
-- the node's newest inventory reports them, never an older one. The existing kinds (login, native) read as before,
-- paging works across the new kind, and only the service role may read either view.

-- A coding worker of Alice's, on a real todo in her folder, with an unreserved company allocation for one
-- 2 CPU / 4 GiB machine (the dispatch path allows one coding session per owner and harness, so it is a fixture row).
select pg_temp.base_commit(pg_temp.base_owner(), 'machine-requests-todo', jsonb_build_array(pg_temp.base_write('agents/alice/todos/machine-requests.md',
	'todo', E'---\nid: 43300000-0000-4000-8000-0000000000d1\ntitle: Machine requests\nstatus: open\n---\n\n',
	'{"kind":"todo","id":"43300000-0000-4000-8000-0000000000d1","title":"Machine requests","status":"open","requestedBy":null,"detail":""}'))) \g /dev/null
reset role;
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select '43300000-0000-4000-8000-000000000101'::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'machine-requests-1',
	'coding','Machine requests','read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	'92400000-0000-4000-8000-000000000001',(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo
where todo.id = '43300000-0000-4000-8000-0000000000d1' and todo.staff_agent_id = '92400000-0000-4000-8000-000000000030';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select '43300000-0000-4000-8000-000000000201'::uuid,worker.profile_id,worker.id,'coding-mq',encode(extensions.digest('machine-requests-vm-1','sha256'),'hex')
from public.qorpera_runtime_workers worker where worker.id = '43300000-0000-4000-8000-000000000101';
select pg_temp.base_assert((select count(*) from public.qorpera_runtime_machine_allocations
	where id = '43300000-0000-4000-8000-000000000201' and profile_id = '92400000-0000-4000-8000-000000000010') = 1,
	'fixture: one coding allocation of the folder-v2 company');
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','machine-ack') \g /dev/null

create function pg_temp.mq_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
-- The exact envelope the native tool operations hash for machine_start (as in 628).
create function pg_temp.mq_start_envelope(p_key text,p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.mq_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
-- The run starts a machine under its own receipt: authorize, begin the receipt, start, complete.
create function pg_temp.mq_start(p_key text,p_args jsonb) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.mq_start_envelope(p_key,p_args);
	v_sha text := encode(extensions.digest(convert_to(v_envelope,'UTF8'),'sha256'),'hex');
	v_receipt uuid := extensions.gen_random_uuid(); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.mq_binding(),v_envelope,'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.mq_binding(),v_receipt,'machine_start:' || p_key,v_sha,repeat('9',64),false);
	v_result := public.qorpera_native_machine_start(pg_temp.mq_binding(),v_envelope,'begin',v_receipt,repeat('9',64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.mq_binding(),v_receipt,v_sha,v_result);
	return v_result;
end
$$;
create function pg_temp.mq_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
-- A machine's node allocation has its current placement's id.
create function pg_temp.mq_alloc(p_name text) returns uuid language sql as $$
	select placement.id from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
-- A fresh observation of node A whose inventory reports exactly its reserved machines, each in the state p_states
-- names for its allocation (running when not named).
create function pg_temp.mq_observe(p_state text default 'ready',p_states jsonb default '{}') returns jsonb language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('43300000-0000-4000-8000-000000000410');
begin
	return public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','43300000-0000-4000-8000-000000000410','machineIdSha256',repeat('3',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state',p_state),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId','43300000-0000-4000-8000-0000000004b0','entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state',coalesce(p_states ->> (a ->> 'allocationId'),'running'),
				'configurationSha256',repeat('7',64),'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,
				'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
-- One placed machine in each state the node can report for it: mq-run running (not named), mq-start starting,
-- mq-stop stopping, mq-fail failed and mq-big suspended.
create function pg_temp.mq_states() returns jsonb language sql as $$
	select jsonb_build_object(pg_temp.mq_alloc('mq-start'),'starting',pg_temp.mq_alloc('mq-stop'),'stopping',
		pg_temp.mq_alloc('mq-fail'),'failed',pg_temp.mq_alloc('mq-big'),'suspended')
$$;
create function pg_temp.mq_cap(p_node uuid default '43300000-0000-4000-8000-000000000410') returns jsonb language sql as $$
	select public.qorpera_runtime_node_capacity(p_node)
$$;
-- The node's newest observation (its one row in the observations table).
create function pg_temp.mq_newest() returns public.qorpera_runtime_node_observations language sql as $$
	select newest from public.qorpera_runtime_node_observations newest
	where newest.node_id = '43300000-0000-4000-8000-000000000410'
$$;
-- The counts a node's newest inventory gives when it reports the named numbers of machines in each state.
create function pg_temp.mq_counts(p_running int,p_starting int,p_stopping int,p_suspended int,p_failed int) returns jsonb language sql as $$
	select jsonb_build_object('source','newest_node_inventory','observationId',(pg_temp.mq_newest()).observation_id,
		'observedAt',(pg_temp.mq_newest()).observed_at,'allocations',p_running + p_starting + p_stopping + p_suspended + p_failed,
		'starting',p_starting,'running',p_running,'stopping',p_stopping,'suspended',p_suspended,'failedOrUnavailable',p_failed)
$$;
create function pg_temp.mq_requests(p_after_kind text default null,p_after_id uuid default null,p_limit integer default 1000)
returns jsonb language sql as $$
	select public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010',p_after_kind,p_after_id,p_limit)
$$;
create function pg_temp.mq_request(p_requests jsonb,p_id uuid) returns jsonb language sql as $$
	select r from jsonb_array_elements(p_requests -> 'requests') r where r ->> 'kind' = 'machine' and r ->> 'requestId' = p_id::text
$$;
-- The coding machine asks node A for its 2 CPU / 4 GiB.
create function pg_temp.mq_reserve_vm() returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_node_machine('43300000-0000-4000-8000-000000000201','coding','coding-mq',repeat('f',64),
		encode(extensions.digest('machine-requests-vm-1','sha256'),'hex'),repeat('3',64),2000,4294967296)
$$;

-- Node A: 16 CPUs / 64 GiB with 2 CPUs / 8 GiB headroom, so 14 CPUs / 56 GiB to give; it serves company machines up
-- to 8 CPUs / 32 GiB and coding machines of 2 CPUs / 4 GiB.
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','43300000-0000-4000-8000-000000000410','machineIdSha256',repeat('3',64),'label','machines-a','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','43300000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('3',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_enroll_runtime_node_provider('43300000-0000-4000-8000-000000000410',repeat('3',64),'machine','machine-fixture',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_enroll_runtime_node_provider('43300000-0000-4000-8000-000000000410',repeat('3',64),'coding','coding-mq',
		repeat('f',64),2000,4294967296);
end $$;

-- 1. The node reports and gets an executor; the run fills it. Four 2 CPU / 4 GiB machines and one 6 CPU / 24 GiB machine
--    take all 14 CPUs it gives; the next machine waits in line, and the coding machine is refused for room. The node
--    then reports one placed machine in each state.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture','providerPolicySha256',repeat('f',64),'project','machines',
		'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
	v_name text; v_started jsonb; v_wait jsonb; v_vm jsonb; v_cap jsonb;
begin
	perform pg_temp.mq_observe();
	perform public.qorpera_configure_machine_executor('mx-mq',repeat('3',64),true,v_policy,322122547200);
	foreach v_name in array array['mq-run','mq-start','mq-stop','mq-fail','mq-big'] loop
		v_started := pg_temp.mq_start('m-' || v_name,jsonb_build_object('name',v_name,'purpose','Machine requests fixture',
			'cpus',case when v_name = 'mq-big' then 6 else 2 end,'memoryGiB',case when v_name = 'mq-big' then 24 else 4 end,
			'diskGiB',case when v_name = 'mq-big' then 40 else 10 end,'lifetime','task'));
		perform pg_temp.base_assert(v_started #>> '{machine,state}' = 'starting' and pg_temp.mq_alloc(v_name) is not null,
			v_name || ' is placed on node A: ' || v_started::text);
	end loop;
	v_wait := pg_temp.mq_start('m-mq-wait','{"name":"mq-wait","purpose":"Machine requests fixture","cpus":2,"memoryGiB":4,"diskGiB":10,"lifetime":"task"}');
	perform pg_temp.base_assert(v_wait #>> '{machine,state}' = 'waiting' and (v_wait #>> '{machine,queuePosition}')::int = 1
		and v_wait #>> '{machine,waitingFor}' = 'NODE_CAPACITY_EXHAUSTED' and (pg_temp.mq_machine('mq-wait')).id is not null
		and pg_temp.mq_alloc('mq-wait') is null,
		'mq-wait waits in line, unplaced: ' || v_wait::text);
	v_vm := pg_temp.mq_reserve_vm();
	perform pg_temp.base_assert(v_vm ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED','The coding machine is refused for room: ' || v_vm::text);
	perform pg_temp.mq_observe();
	perform pg_temp.mq_observe('ready',pg_temp.mq_states());
	v_cap := pg_temp.mq_cap();
	perform pg_temp.base_assert(v_cap ->> 'state' = 'eligible' and (v_cap ->> 'allocatedComputers')::bigint = 5
		and (v_cap ->> 'allocatedCpuMillis')::bigint = 14000 and (v_cap ->> 'pendingRequests')::bigint = 1
		and (v_cap ->> 'freeCpuMillis')::bigint = 0,
		'Capacity counts five reservations and one pending start: ' || v_cap::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_company_machines
		where profile_id = '92400000-0000-4000-8000-000000000010' and removed_at is null) = 6,
		'fixture: the company has exactly the six machines this test started');
end $$;

-- 2. What L28.2 asks: compute requests lists the waiting machine and the refused coding machine with their reasons and
--    each placed machine with its node, and capacity counts the node's machines by state. (On master, before
--    20260930494000, the views show none of these; this check names each one missing.)
do $$
declare v_requests jsonb := pg_temp.mq_requests(); v_states jsonb := pg_temp.mq_cap() -> 'physicalComputerStates';
	v_gaps text[] := '{}'; v_name text;
begin
	if not exists (select 1 from jsonb_array_elements(v_requests -> 'requests') r where r ->> 'kind' = 'machine'
			and r ->> 'requestId' = (pg_temp.mq_machine('mq-wait')).id::text and r #>> '{details,reason}' = 'NODE_CAPACITY_EXHAUSTED') then
		v_gaps := array_append(v_gaps,'the waiting machine mq-wait with NODE_CAPACITY_EXHAUSTED'); end if;
	if not exists (select 1 from jsonb_array_elements(v_requests -> 'requests') r where r ->> 'kind' = 'machine'
			and r ->> 'requestId' = '43300000-0000-4000-8000-000000000201' and r #>> '{details,reason}' = 'NODE_CAPACITY_EXHAUSTED') then
		v_gaps := array_append(v_gaps,'the refused coding machine with NODE_CAPACITY_EXHAUSTED'); end if;
	foreach v_name in array array['mq-run','mq-start','mq-stop','mq-fail','mq-big'] loop
		if not exists (select 1 from jsonb_array_elements(v_requests -> 'requests') r where r ->> 'kind' = 'machine'
				and r ->> 'requestId' = (pg_temp.mq_machine(v_name)).id::text
				and r #>> '{placements,0,nodeId}' = '43300000-0000-4000-8000-000000000410') then
			v_gaps := array_append(v_gaps,'the placed machine ' || v_name || ' on node A'); end if;
	end loop;
	if jsonb_typeof(v_states) is distinct from 'object' or not v_states ?& array['starting','running','stopping','failedOrUnavailable'] then
		v_gaps := array_append(v_gaps,'capacity counts by state (it says ' || coalesce(v_states::text,'nothing') || ')'); end if;
	perform pg_temp.base_assert(cardinality(v_gaps) = 0,'The operator views do not show: ' || array_to_string(v_gaps,'; '));
end $$;

-- 3. Each machine in compute requests: the waiting one with its place in line, its reason and no node; the refused
--    coding machine with its reason and the node it asked; each placed one in its company state with its node
--    allocation. Exactly the company's machines are listed, once each.
do $$
declare v_requests jsonb := pg_temp.mq_requests(); v_record jsonb; v_placement jsonb; v_name text;
	v_machine public.qorpera_company_machines;
begin
	perform pg_temp.base_assert((select array_agg(r ->> 'requestId' order by r ->> 'requestId') from jsonb_array_elements(v_requests -> 'requests') r
			where r ->> 'kind' = 'machine')
		= (select array_agg(id order by id) from (select machine.id::text id from public.qorpera_company_machines machine
			where machine.profile_id = '92400000-0000-4000-8000-000000000010' and machine.removed_at is null
			union all select '43300000-0000-4000-8000-000000000201') ids),
		'Compute requests lists each machine of the company once: ' || v_requests::text);
	v_machine := pg_temp.mq_machine('mq-wait');
	v_record := pg_temp.mq_request(v_requests,v_machine.id);
	perform pg_temp.base_assert(v_record ->> 'recordedState' = 'waiting' and v_record ->> 'companyId' = '92400000-0000-4000-8000-000000000010'
		and (v_record ->> 'requestedAt')::timestamptz = v_machine.created_at
		and v_record #>> '{details,machineSource}' = 'company_machine' and v_record #>> '{details,name}' = 'mq-wait'
		and v_record #>> '{details,machineId}' = v_machine.id::text
		and (v_record #>> '{details,queuePosition}')::int = 1 and v_record #>> '{details,reason}' = 'NODE_CAPACITY_EXHAUSTED'
		and v_record #> '{details,allocationId}' = 'null'::jsonb and v_record -> 'placements' = '[]'::jsonb
		and (v_record #>> '{details,cpuMillis}')::bigint = 2000 and (v_record #>> '{details,memoryBytes}')::bigint = 4294967296
		and v_record #>> '{details,desiredState}' = 'running' and v_record -> 'dispatchAttempts' = 'null'::jsonb,
		'The waiting machine shows its place in line and its reason, on no node: ' || coalesce(v_record::text,'missing'));
	v_record := pg_temp.mq_request(v_requests,'43300000-0000-4000-8000-000000000201');
	v_placement := v_record -> 'placements' -> 0;
	perform pg_temp.base_assert(v_record ->> 'recordedState' = 'refused' and v_record #>> '{details,machineSource}' = 'coding_machine'
		and v_record #>> '{details,codingWorkerId}' = '43300000-0000-4000-8000-000000000101'
		and v_record #>> '{details,allocationId}' = '43300000-0000-4000-8000-000000000201'
		and v_record #>> '{details,reason}' = 'NODE_CAPACITY_EXHAUSTED' and (v_record #>> '{details,cpuMillis}')::bigint = 2000
		and v_record #> '{details,queuePosition}' = 'null'::jsonb and jsonb_array_length(v_record -> 'placements') = 1
		and v_placement ->> 'nodeId' = '43300000-0000-4000-8000-000000000410' and v_placement ->> 'providerKind' = 'coding'
		and v_placement ->> 'nodePlacementState' = 'requested' and v_placement ->> 'lastAdmissionRefusal' = 'NODE_CAPACITY_EXHAUSTED'
		and v_placement -> 'nodeReservedAt' = 'null'::jsonb,
		'The refused coding machine shows its reason and the node it asked: ' || coalesce(v_record::text,'missing'));
	foreach v_name in array array['mq-run','mq-start','mq-stop','mq-fail','mq-big'] loop
		v_machine := pg_temp.mq_machine(v_name);
		v_record := pg_temp.mq_request(v_requests,v_machine.id);
		v_placement := v_record -> 'placements' -> 0;
		perform pg_temp.base_assert(v_record ->> 'recordedState' = public.qorpera_company_machine_view(v_machine) ->> 'state'
			and v_record ->> 'recordedState' in ('starting','running')
			and v_record #>> '{details,allocationId}' = pg_temp.mq_alloc(v_name)::text
			and v_record #> '{details,queuePosition}' = 'null'::jsonb and v_record #> '{details,reason}' = 'null'::jsonb
			and (v_record #>> '{details,cpuMillis}')::bigint = case when v_name = 'mq-big' then 6000 else 2000 end
			and jsonb_array_length(v_record -> 'placements') = 1 and v_placement ->> 'allocationId' = pg_temp.mq_alloc(v_name)::text
			and v_placement ->> 'nodeId' = '43300000-0000-4000-8000-000000000410' and v_placement ->> 'providerKind' = 'machine'
			and v_placement ->> 'nodePlacementState' = 'reserved' and v_placement -> 'nodeReservedAt' <> 'null'::jsonb,
			'Compute requests shows ' || v_name || ' placed on node A: ' || coalesce(v_record::text,'missing'));
	end loop;
end $$;

-- 4. Capacity counts the node's machines by state exactly as its newest inventory reports them: one in each state.
--    A newer observation that reports mq-run failed changes the counts, and the older inventory, which still reports
--    mq-run running, is not read. A node that reports itself unavailable is counted from what it reported. A node
--    with no inventory has no counts.
do $$
declare v_cap jsonb := pg_temp.mq_cap(); v_older uuid := (pg_temp.mq_newest()).observation_id;
begin
	perform pg_temp.base_assert(v_cap -> 'physicalComputerStates' = pg_temp.mq_counts(1,1,1,1,1),
		'Capacity counts one machine in each state from the newest inventory: ' || v_cap::text);
	perform pg_temp.mq_observe('ready',pg_temp.mq_states() || jsonb_build_object(pg_temp.mq_alloc('mq-run'),'failed'));
	v_cap := pg_temp.mq_cap();
	perform pg_temp.base_assert((pg_temp.mq_newest()).observation_id <> v_older
		and (select count(*) from public.qorpera_runtime_node_inventory_receipts r cross join jsonb_array_elements(r.inventory -> 'entries') e
			where r.node_id = '43300000-0000-4000-8000-000000000410' and r.observation_id = v_older and e ->> 'state' = 'running') = 1
		and (select count(*) from public.qorpera_runtime_node_inventory_receipts r
			where r.node_id = '43300000-0000-4000-8000-000000000410') >= 4,
		'fixture: older inventories of node A remain, the last one with mq-run running');
	perform pg_temp.base_assert(v_cap -> 'physicalComputerStates' = pg_temp.mq_counts(0,1,1,1,2)
		and (v_cap ->> 'allocatedComputers')::bigint = 5 and (v_cap ->> 'pendingRequests')::bigint = 1,
		'A newer inventory with mq-run failed changes the counts; the older one is not read: ' || v_cap::text);
	perform pg_temp.mq_observe('unavailable',pg_temp.mq_states() || jsonb_build_object(pg_temp.mq_alloc('mq-fail'),'unavailable'));
	v_cap := pg_temp.mq_cap();
	perform pg_temp.base_assert(v_cap ->> 'state' = 'unavailable' and v_cap -> 'physicalComputerStates' = pg_temp.mq_counts(1,1,1,1,1)
		and (v_cap ->> 'freeCpuMillis')::bigint = 0 and (v_cap ->> 'admissibleSlots')::bigint = 0,
		'An unavailable node counts mq-fail unavailable and gives nothing: ' || v_cap::text);
	perform pg_temp.mq_observe('ready',pg_temp.mq_states());
	-- Node B: configured, then observed without an inventory.
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','43300000-0000-4000-8000-000000000420','machineIdSha256',repeat('5',64),'label','machines-b','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	v_cap := pg_temp.mq_cap('43300000-0000-4000-8000-000000000420');
	perform pg_temp.base_assert(v_cap ? 'physicalComputerStates' and v_cap -> 'physicalComputerStates' = 'null'::jsonb
		and v_cap -> 'observedAt' = 'null'::jsonb,
		'A node never observed has no counts: ' || v_cap::text);
	perform public.qorpera_observe_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','43300000-0000-4000-8000-000000000420','machineIdSha256',repeat('5',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'));
	v_cap := pg_temp.mq_cap('43300000-0000-4000-8000-000000000420');
	perform pg_temp.base_assert(v_cap -> 'observedAt' <> 'null'::jsonb and v_cap -> 'physicalComputerStates' = 'null'::jsonb,
		'A node observed without an inventory has no counts: ' || v_cap::text);
end $$;

-- 5. The existing kinds read as before: the company's login and its run's job, with the same fields. Paging walks
--    across the new kind, one record at a time or from a cursor before or after it.
do $$
declare v_all jsonb := pg_temp.mq_requests(); v_login jsonb; v_native jsonb; v_page jsonb; v_seen jsonb := '[]';
	v_kind text; v_id uuid; v_steps int := 0; v_last_login uuid; v_last_machine uuid;
begin
	v_login := (select r from jsonb_array_elements(v_all -> 'requests') r where r ->> 'kind' = 'login'
		and r ->> 'requestId' = current_setting('qorpera_test.base_login')::jsonb ->> 'login_id');
	v_native := (select r from jsonb_array_elements(v_all -> 'requests') r where r ->> 'kind' = 'native'
		and r ->> 'requestId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId');
	perform pg_temp.base_assert(v_all ->> 'schema' = 'qorpera.runtime-compute-requests/v1'
		and v_all ->> 'coverage' = 'retained_office_intents_login_sessions_native_jobs_and_unallocated_company_refusals'
		and v_all ->> 'machineCoverage' = 'current_company_machines_and_unreleased_coding_machines'
		and v_all ->> 'capacityQuery' = 'qorpera_runtime_node_capacity' and not (v_all ->> 'hasMore')::boolean
		and (select count(*) from jsonb_object_keys(v_all)) = 13,
		'Compute requests keeps its fields and names what the machine kind covers: ' || (v_all - 'requests')::text);
	perform pg_temp.base_assert(v_login ?& array['kind','requestId','companyId','requestedAt','recordedState','details','placements',
			'dispatchAttempts','admissionRechecked','resourceReleaseInferred'] and (select count(*) from jsonb_object_keys(v_login)) = 10
		and v_login -> 'details' ?& array['loginSessionId','expiresAt','completedAt','machineRequestId','machineRequestedAt',
			'lastAdmissionCheckAt','lastAdmissionRefusal','machineRequestReleasedAt','providerDiagnosticSource','provisioningFailure']
		and (select count(*) from jsonb_object_keys(v_login -> 'details')) = 10
		and v_login ->> 'recordedState' = (select status from public.qorpera_native_provider_login_sessions
			where id = (v_login ->> 'requestId')::uuid)
		and jsonb_typeof(v_login -> 'placements') = 'array' and v_login -> 'dispatchAttempts' = 'null'::jsonb,
		'The company''s login reads as before: ' || coalesce(v_login::text,'missing'));
	perform pg_temp.base_assert((select count(*) from jsonb_object_keys(v_native)) = 10
		and v_native -> 'details' ?& array['jobId','startedAt','finishedAt','cancelledAt','runtimeBundleId','jobOutcome',
			'provisioningFailure','providerDiagnosticSource'] and (select count(*) from jsonb_object_keys(v_native -> 'details')) = 8
		and v_native ->> 'recordedState' = (select status from public.qorpera_runner_jobs where id = (v_native ->> 'requestId')::uuid)
		and jsonb_typeof(v_native -> 'placements') = 'array' and jsonb_typeof(v_native -> 'dispatchAttempts') = 'object',
		'The run''s job reads as before: ' || coalesce(v_native::text,'missing'));
	loop
		v_page := pg_temp.mq_requests(v_kind,v_id,1);
		v_seen := v_seen || (v_page -> 'requests');
		v_steps := v_steps + 1;
		exit when not (v_page ->> 'hasMore')::boolean or v_steps > 200;
		v_kind := v_page ->> 'nextKind'; v_id := (v_page ->> 'nextId')::uuid;
	end loop;
	perform pg_temp.base_assert((select jsonb_agg(jsonb_build_array(r -> 'kind',r -> 'requestId') order by n) from jsonb_array_elements(v_seen)
			with ordinality x(r,n))
		= (select jsonb_agg(jsonb_build_array(r -> 'kind',r -> 'requestId') order by n) from jsonb_array_elements(v_all -> 'requests')
			with ordinality x(r,n)) and v_steps = jsonb_array_length(v_all -> 'requests'),
		'One record at a time pages through the same requests: ' || v_seen::text);
	v_last_login := (select (r ->> 'requestId')::uuid from jsonb_array_elements(v_all -> 'requests') with ordinality x(r,n)
		where r ->> 'kind' = 'login' order by n desc limit 1);
	v_last_machine := (select (r ->> 'requestId')::uuid from jsonb_array_elements(v_all -> 'requests') with ordinality x(r,n)
		where r ->> 'kind' = 'machine' order by n desc limit 1);
	v_page := pg_temp.mq_requests('login',v_last_login);
	perform pg_temp.base_assert(v_page -> 'requests' -> 0 ->> 'kind' = 'machine'
		and (select count(*) from jsonb_array_elements(v_page -> 'requests') r where r ->> 'kind' = 'machine') = 7
		and not exists (select 1 from jsonb_array_elements(v_page -> 'requests') r where r ->> 'kind' = 'login'),
		'After the last login the page starts with the machines: ' || v_page::text);
	v_page := pg_temp.mq_requests('machine',v_last_machine);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_page -> 'requests') r where r ->> 'kind' in ('login','machine'))
		and exists (select 1 from jsonb_array_elements(v_page -> 'requests') r where r ->> 'kind' = 'native'),
		'After the last machine the page goes on with the jobs: ' || v_page::text);
	perform pg_temp.base_error($q$select pg_temp.mq_requests('machine',null)$q$,'22023','Invalid compute request page');
	perform pg_temp.base_error($q$select pg_temp.mq_requests('vm','43300000-0000-4000-8000-000000000201')$q$,'22023',
		'Invalid compute request page');
end $$;

-- 6. Only the service role reads either view. A member's (the owner's), an anonymous or an empty claim is refused with
--    42501, and the authenticated and anon database roles may not call them at all. Both stay security definer with an
--    empty search path; compute requests stays stable (it writes nothing).
create function pg_temp.mq_views() returns table(p_sql text) language sql as $$
	select * from (values
		($q$select public.qorpera_runtime_node_capacity('43300000-0000-4000-8000-000000000410')$q$),
		($q$select public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010')$q$)) v
$$;
do $$
declare v_claims text; v_sql text;
begin
	foreach v_claims in array array[jsonb_build_object('role','authenticated','sub','92400000-0000-4000-8000-000000000001')::text,
		'{"role":"anon"}','']
	loop
		perform set_config('request.jwt.claims',v_claims,true);
		for v_sql in select p_sql from pg_temp.mq_views() loop
			perform pg_temp.base_error(v_sql,'42501','Operator authority required');
		end loop;
	end loop;
	perform pg_temp.base_claims('service_role');
end $$;
set local role authenticated;
select pg_temp.base_error(p_sql,'42501') from pg_temp.mq_views() \g /dev/null
reset role;
set local role anon;
select pg_temp.base_error(p_sql,'42501') from pg_temp.mq_views() \g /dev/null
reset role;
select pg_temp.base_assert((select bool_and(not has_function_privilege('anon',f,'execute') and not has_function_privilege('authenticated',f,'execute')
		and not has_function_privilege('public',f,'execute') and has_function_privilege('service_role',f,'execute'))
	from unnest(array['public.qorpera_runtime_node_capacity(uuid)','public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)']) f),
	'Only the service role may execute the two views');
select pg_temp.base_assert((select bool_and(p.prosecdef and p.proconfig = array['search_path=""']
		and p.provolatile = case when p.oid = 'public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)'::regprocedure then 's' else 'v' end)
	from pg_proc p where p.oid in ('public.qorpera_runtime_node_capacity(uuid)'::regprocedure,
		'public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)'::regprocedure)),
	'Both views stay security definer with an empty search path, compute requests stable');

rollback;
