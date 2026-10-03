-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Machines agents start themselves (2026-09-28): a size per request on the
-- shared node ledger, a place in line when no node has room, a refusal when
-- no node could ever hold it, disposable placements that move to another node
-- when a machine wakes where there is no room, the executor's custody of every
-- effect, idle sleep and removal for task machines, commands whose end wakes
-- the run that started them, and members who see and stop every machine of
-- the company.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.parent_binding',current_setting('qorpera_test.wake_binding'),true);
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'progress','machine-ack');

create function pg_temp.binding() returns jsonb language sql as $$ select current_setting('qorpera_test.parent_binding')::jsonb $$;
-- The exact envelope the native tool operations hash for machine_start.
create function pg_temp.start_envelope(p_key text,p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
-- authorize, begin the receipt, perform (twice when asked: a retry inside the same operation), complete.
create function pg_temp.start(p_key text,p_args jsonb,p_receipt uuid default extensions.gen_random_uuid(),p_twice boolean default false)
returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.start_envelope(p_key,p_args);
	v_sha text := encode(extensions.digest(convert_to(v_envelope,'UTF8'),'sha256'),'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.binding(),v_envelope,'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.binding(),p_receipt,'machine_start:' || p_key,v_sha,repeat('9',64),false);
	begin
		v_result := public.qorpera_native_machine_start(pg_temp.binding(),v_envelope,'begin',p_receipt,repeat('9',64));
		if p_twice then
			v_result := jsonb_build_object('first',v_result,'again',
				public.qorpera_native_machine_start(pg_temp.binding(),v_envelope,'begin',p_receipt,repeat('9',64)));
		end if;
	exception when others then
		-- A refused start settles its receipt as failed so the run can go on.
		perform public.qorpera_complete_native_tool_operation(pg_temp.binding(),p_receipt,v_sha,jsonb_build_object('error',sqlerrm));
		raise;
	end;
	perform public.qorpera_complete_native_tool_operation(pg_temp.binding(),p_receipt,v_sha,v_result);
	return v_result;
end
$$;
-- A machine_run receipt, begun and completed around its authorization.
create function pg_temp.run(p_receipt uuid,p_key text,p_sha text,p_machine text,p_head text,p_notify boolean) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.binding(),p_receipt,'machine_run:' || p_key,p_sha,repeat('5',64),false);
	begin
		v_result := public.qorpera_authorize_machine_command(pg_temp.binding(),jsonb_build_object('machineId',(pg_temp.machine(p_machine)).id),
			'start',p_receipt,p_sha,jsonb_build_object('commandHead',p_head,'notify',p_notify));
	exception when others then
		perform public.qorpera_complete_native_tool_operation(pg_temp.binding(),p_receipt,p_sha,jsonb_build_object('error',sqlerrm));
		raise;
	end;
	perform public.qorpera_complete_native_tool_operation(pg_temp.binding(),p_receipt,p_sha,v_result);
	return v_result;
end
$$;
create function pg_temp.machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
-- Where the named machine runs now.
create function pg_temp.placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
create function pg_temp.listed_at(p_owner text,p_sha text,p_placement uuid) returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_executor_machines(p_owner,p_sha)) entry
	where entry ->> 'placementId' = p_placement::text
$$;
create function pg_temp.listed(p_owner text,p_sha text,p_name text) returns jsonb language sql as $$
	select pg_temp.listed_at(p_owner,p_sha,(pg_temp.placement(p_name)).id)
$$;
create function pg_temp.custody_at(p_placement public.qorpera_company_machine_placements,p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine(p_placement.id,p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding),p_placement.machine_id_sha256,p_intent)
$$;
create function pg_temp.custody(p_name text,p_intent text) returns jsonb language sql as $$
	select pg_temp.custody_at(pg_temp.placement(p_name),p_intent)
$$;
create function pg_temp.suspend(p_name text) returns jsonb language sql as $$
	select public.qorpera_suspend_company_machine((pg_temp.placement(p_name)).id,(pg_temp.placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.placement(p_name)).binding),(pg_temp.placement(p_name)).machine_id_sha256)
$$;
create function pg_temp.release_at(p_placement public.qorpera_company_machine_placements) returns jsonb language sql as $$
	select public.qorpera_release_company_machine(p_placement.id,p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding),p_placement.machine_id_sha256)
$$;
create function pg_temp.running(p_name text,p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running((pg_temp.placement(p_name)).id,(pg_temp.placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.placement(p_name)).binding),(pg_temp.placement(p_name)).machine_id_sha256,p_boot)
$$;
create function pg_temp.record(p_name text,p_boot uuid,p_ended jsonb,p_busy boolean) returns jsonb language sql as $$
	select public.qorpera_record_company_machine_commands((pg_temp.placement(p_name)).id,(pg_temp.placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.placement(p_name)).binding),(pg_temp.placement(p_name)).machine_id_sha256,
		p_boot,p_ended,p_busy)
$$;
create function pg_temp.node(p_id uuid,p_sha text,p_label text,p_cpu bigint,p_memory bigint) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId',p_id,'machineIdSha256',p_sha,'label',p_label,'cpuMillis',p_cpu,'memoryBytes',p_memory,
		'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_id,'host',jsonb_build_object('machineIdSha256',p_sha,
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe(p_id,p_sha,p_cpu,p_memory);
end
$$;
-- A fresh ready observation whose inventory reports exactly the node's reserved machines.
create function pg_temp.observe(p_id uuid,p_sha text,p_cpu bigint,p_memory bigint) returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context(p_id);
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_id,'machineIdSha256',p_sha,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',p_cpu,'memoryBytes',p_memory,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
create function pg_temp.observe_a() returns void language sql as $$
	select pg_temp.observe('30000000-0000-4000-8000-000000000410',repeat('c',64),16000,68719476736)
$$;

-- 1. Without a machine executor nothing is started, and no machine is left behind.
do $$
declare v_result jsonb;
begin
	v_result := pg_temp.start('m-none','{"name":"none","purpose":"Nothing yet","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_result #>> '{refused,reason}' = 'MACHINES_UNAVAILABLE' and not v_result ? 'machine'
		and not exists (select 1 from public.qorpera_company_machines),'Refused as unavailable, nothing kept: '||v_result::text);
end $$;

-- 2. One node makes machines up to 8 CPUs / 32 GiB and gives them 300 GiB of disk; its executor holds the policy.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','machine-net');
begin
	-- Agents are offered machine tools only once a node can serve them (20260928259350).
	perform pg_temp.wake_assert(not public.qorpera_company_machines_available()
		and has_function_privilege('service_role','public.qorpera_company_machines_available()','execute')
		and not has_function_privilege('authenticated','public.qorpera_company_machines_available()','execute')
		and not has_function_privilege('anon','public.qorpera_company_machines_available()','execute'),
		'No machine executor yet: no machine tools, and only the service role may ask');
	perform pg_temp.node('30000000-0000-4000-8000-000000000410',repeat('c',64),'machine-a',16000,68719476736);
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000410',repeat('c',64),'machine','machine-fixture',
		repeat('f',64),8000,34359738368);
	perform pg_temp.wake_error($sql$select public.qorpera_configure_machine_executor('mx-a',repeat('c',64),true,null,322122547200)$sql$,'22023');
	perform pg_temp.wake_error($sql$select public.qorpera_configure_machine_executor('mx-a',repeat('c',64),true,'{"providerId":"x"}',322122547200)$sql$,'22023');
	-- The disk the node's pool gives machines is part of enabling it.
	perform pg_temp.wake_error(format($sql$select public.qorpera_configure_machine_executor('mx-a',repeat('c',64),true,%L,null)$sql$,v_policy),'22023');
	perform public.qorpera_configure_machine_executor('mx-a',repeat('c',64),false,v_policy,322122547200);
	perform pg_temp.wake_assert(not public.qorpera_company_machines_available(), 'A disabled executor serves no machines');
	perform public.qorpera_configure_machine_executor('mx-a',repeat('c',64),true,v_policy,322122547200);
	perform pg_temp.wake_assert(public.qorpera_company_machines_available(), 'An enabled executor offers the machine tools');
	-- Its policy must be one an enrolled machine provider holds, as for any start.
	begin
		update public.qorpera_machine_executors set policy = jsonb_set(policy, '{providerId}', '"nobody"') where owner = 'mx-a';
		perform pg_temp.wake_assert(not public.qorpera_company_machines_available(), 'No enrolled provider, no machine tools');
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	perform pg_temp.wake_assert(public.qorpera_company_machines_available(), 'The sub-block left the executor as it was');
	perform pg_temp.wake_error($sql$select public.qorpera_configure_machine_executor('mx-a',repeat('d',64),true,null,322122547200)$sql$,'22023');
	perform pg_temp.wake_error(format($sql$select public.qorpera_configure_machine_executor('mx-a',repeat('d',64),true,%L,322122547200)$sql$,v_policy),'42501');
end $$;

-- 3. A start places the machine on the node with room, reserving its own size; a replay answers the same.
do $$
declare v_receipt uuid := extensions.gen_random_uuid(); v_first jsonb; v_again jsonb; v_row public.qorpera_company_machines;
	v_place public.qorpera_company_machine_placements;
	v_allocation public.qorpera_runtime_machine_allocations; v_demand public.qorpera_runtime_node_demands;
	v_args jsonb := '{"name":"build-a","purpose":"Run the SQL suite","cpus":2,"memoryGiB":4,"diskGiB":40,"lifetime":"task"}';
begin
	-- A fresh node observation: placement needs one younger than a minute.
	perform pg_temp.observe_a();
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_start(%L,%L,'authorize')$sql$,pg_temp.binding(),
		pg_temp.start_envelope('bad','{"name":"Bad Name","purpose":"x","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}')),'42501');
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_start(%L,%L,'authorize')$sql$,pg_temp.binding(),
		pg_temp.start_envelope('bad','{"name":"ok","purpose":"x","cpus":1,"memoryGiB":1,"diskGiB":5,"lifetime":"task"}')),'42501');
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_start(%L,%L,'authorize')$sql$,pg_temp.binding(),
		pg_temp.start_envelope('bad','{"name":"ok","purpose":"x","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"forever"}')),'42501');
	v_first := pg_temp.start('m-build-a',v_args,v_receipt,true);
	v_again := v_first -> 'again';
	v_first := v_first -> 'first';
	v_row := pg_temp.machine('build-a');
	v_place := pg_temp.placement('build-a');
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_place.id;
	select * into v_demand from public.qorpera_runtime_node_demands where allocation_id = v_place.id;
	perform pg_temp.wake_assert(v_first ->> 'schema' = 'qorpera.machine-start/v1' and v_first #>> '{machine,state}' = 'starting'
		and v_first #>> '{machine,name}' = 'build-a' and (v_first #>> '{machine,cpus}')::int = 2 and (v_first #>> '{machine,memoryGiB}')::int = 4
		and v_first #>> '{machine,node}' = 'machine-a' and v_again -> 'machine' ->> 'machineId' = v_row.id::text
		and (select count(*) from public.qorpera_company_machines) = 1
		and (select count(*) from public.qorpera_company_machine_placements) = 1,
		'Placed and starting, once: '||v_first::text);
	perform pg_temp.wake_assert(v_place.machine_id = v_row.id and v_place.id <> v_row.id and v_place.owner = 'mx-a'
		and v_place.machine_id_sha256 = repeat('c',64)
		and v_place.binding = jsonb_build_object('schema','qorpera.lxd-company-machine/v1','machineId',v_row.id,'placementId',v_place.id,
			'companyId',v_row.profile_id,
			'environmentId',v_row.environment_id,'providerId','machine-fixture','providerPolicySha256',repeat('f',64),'project','machines',
			'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','machine-net',
			'cpus',2,'memoryBytes',4294967296,'rootDiskBytes',42949672960,'repositoryWorkerId',null)
		and v_place.instance_sha256 = encode(extensions.digest(convert_to(public.qorpera_company_machine_binding_text(v_place.binding),'utf8'),'sha256'),'hex')
		and public.qorpera_company_machine_binding_text(v_place.binding) like '{"schema":"qorpera.lxd-company-machine/v1","machineId":%,"placementId":%,"repositoryWorkerId":null}'
		and v_allocation.company_machine_placement_id = v_place.id and v_allocation.coding_machine_id is null and v_allocation.run_id is null
		and v_allocation.provider_adapter = 'machine-fixture'
		and v_demand.provider_kind = 'machine' and v_demand.cpu_millis = 2000 and v_demand.memory_bytes = 4294967296
		and v_demand.reserved_at is not null and v_row.requested_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_row.started_by_staff_agent_id = '30000000-0000-4000-8000-000000000030'
		and v_row.notify_run_ids = array[(pg_temp.binding() ->> 'runId')::uuid],
		'The placement''s binding, allocation and demand carry the machine''s own size');
	v_again := pg_temp.start('m-build-a2',v_args);
	perform pg_temp.wake_assert(v_again #>> '{refused,reason}' = 'MACHINE_NAME_TAKEN'
		and (select count(*) from public.qorpera_company_machines) = 1,'Name taken: '||v_again::text);
	v_again := pg_temp.start('m-huge','{"name":"huge","purpose":"Too big","cpus":16,"memoryGiB":8,"diskGiB":40,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_again #>> '{refused,reason}' = 'MACHINE_TOO_LARGE'
		and v_again #>> '{refused,message}' = 'no server holds that size; the largest are 8 CPUs, 32 GiB memory and 300 GiB disk, not always on one server'
		and pg_temp.machine('huge') is null,'A machine that can never fit is refused and not kept: '||v_again::text);
	v_again := pg_temp.start('m-deep','{"name":"deep","purpose":"More disk than a node gives","cpus":1,"memoryGiB":1,"diskGiB":400,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_again #>> '{refused,reason}' = 'MACHINE_TOO_LARGE' and pg_temp.machine('deep') is null,
		'Disk counts too: '||v_again::text);
end $$;

-- 4. Full: the next machine waits in line, unplaced, with its place and its reason.
do $$
declare v_big jsonb; v_wait jsonb; v_row public.qorpera_company_machines;
begin
	perform pg_temp.observe_a();
	v_big := pg_temp.start('m-big','{"name":"big","purpose":"Long data job","cpus":6,"memoryGiB":28,"diskGiB":100,"lifetime":"always-on"}');
	v_wait := pg_temp.start('m-wait','{"name":"wait","purpose":"Second data job","cpus":6,"memoryGiB":28,"diskGiB":100,"lifetime":"task"}');
	v_row := pg_temp.machine('wait');
	perform pg_temp.wake_assert(v_big #>> '{machine,state}' = 'starting' and v_wait #>> '{machine,state}' = 'waiting'
		and (v_wait #>> '{machine,queuePosition}')::int = 1 and v_wait #>> '{machine,waitingFor}' = 'NODE_CAPACITY_EXHAUSTED'
		and pg_temp.placement('wait') is null
		and not exists (select 1 from public.qorpera_company_machine_placements where machine_id = v_row.id),
		'The second big machine waits unplaced: '||v_wait::text);
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-a',repeat('c',64)) = '[]'::jsonb,'Still no room');
end $$;

-- 5. The executor sees its placements, starts one under a short receipt and reports it running.
--    The run that asked for it and has not used it gets a machine event.
do $$
declare v_entry jsonb; v_run jsonb; v_boot uuid := extensions.gen_random_uuid(); v_marked jsonb;
begin
	perform pg_temp.observe_a();
	v_entry := pg_temp.listed('mx-a',repeat('c',64),'build-a');
	perform pg_temp.wake_assert(v_entry ->> 'schema' = 'qorpera.company-machine-state/v2' and v_entry ->> 'desiredState' = 'running'
		and v_entry ->> 'machineId' = (pg_temp.machine('build-a')).id::text and not (v_entry ->> 'retired')::boolean
		and (v_entry ->> 'reserved')::boolean and not (v_entry ->> 'sleepDue')::boolean and not (v_entry ->> 'removeDue')::boolean
		and not (v_entry ->> 'stopDue')::boolean and v_entry ->> 'bindingText' = public.qorpera_company_machine_binding_text(v_entry -> 'binding')
		and jsonb_array_length(public.qorpera_list_executor_machines('mx-a',repeat('c',64))) = 2
		and public.qorpera_list_executor_machines('mx-b',repeat('c',64)) = '[]'::jsonb,
		'The executor lists only its placements: '||v_entry::text);
	v_run := pg_temp.custody('build-a','run');
	perform pg_temp.wake_assert(v_run ->> 'schema' = 'qorpera.coding-machine-admission/v1' and v_run ->> 'intent' = 'run'
		and v_run ->> 'machineId' = (pg_temp.placement('build-a')).id::text
		and v_run ->> 'workerId' is null and v_run ->> 'guestUid' is null and (v_run ->> 'validForMs')::int between 1 and 5000
		and v_run ->> 'instanceSha256' = (pg_temp.placement('build-a')).instance_sha256,'Run authority for the placement: '||v_run::text);
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_executor_machine(%L,'mx-a',%L,repeat('c',64),'run')$sql$,
		(pg_temp.placement('build-a')).id,((pg_temp.placement('build-a')).binding || '{"network":"drift"}')::text),'42501');
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_executor_machine(%L,'mx-other',%L,repeat('c',64),'run')$sql$,
		(pg_temp.placement('build-a')).id,public.qorpera_company_machine_binding_text((pg_temp.placement('build-a')).binding)),'42501');
	-- Commands wait until the machine is running.
	v_marked := pg_temp.run('30000000-0000-4000-8000-000000000501','early',repeat('a',64),'build-a','true',false);
	perform pg_temp.wake_assert(v_marked ->> 'state' = 'refused' and v_marked ->> 'reason' = 'MACHINE_NOT_RUNNING'
		and v_marked ->> 'machineState' = 'starting'
		and not exists (select 1 from public.qorpera_company_machine_commands where id = '30000000-0000-4000-8000-000000000501'),
		'A command waits until the machine runs: '||v_marked::text);
	v_marked := pg_temp.running('build-a',v_boot);
	perform pg_temp.wake_assert(v_marked #>> '{machine,state}' = 'running' and (pg_temp.placement('build-a')).boot_id = v_boot
		and cardinality((pg_temp.machine('build-a')).notify_run_ids) = 0
		and (select count(*) from public.qorpera_company_machine_events where kind = 'running' and machine_id = (pg_temp.machine('build-a')).id
			and parent_run_id = (pg_temp.binding() ->> 'runId')::uuid and delivery = 'waiting') = 1
		and pg_temp.running('build-a',v_boot) #>> '{machine,state}' = 'running'
		and (select count(*) from public.qorpera_company_machine_events where kind = 'running') = 1,
		'Running, once per boot, and the starting run will hear about it');
	perform set_config('qorpera_test.boot_a',v_boot::text,true);
end $$;

-- 6. A command: the run's own machine_run receipt authorizes it on a running machine of its company;
--    any run of the company reads it; its end is recorded and, with notify, becomes an event.
do $$
declare v_scope jsonb := jsonb_build_object('machineId',(pg_temp.machine('build-a')).id); v_auth jsonb; v_recorded jsonb;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.binding(),'30000000-0000-4000-8000-000000000502','machine_run:suite',repeat('4',64),repeat('5',64),false);
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'start','30000000-0000-4000-8000-000000000502',repeat('6',64),
		'{"commandHead":"npm test","notify":true}')$sql$,pg_temp.binding(),v_scope),'42501');
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'start','30000000-0000-4000-8000-000000000502',repeat('4',64),null)$sql$,
		pg_temp.binding(),v_scope),'22023');
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'read','30000000-0000-4000-8000-000000000502')$sql$,
		pg_temp.binding(),v_scope),'42501');
	v_auth := public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'start','30000000-0000-4000-8000-000000000502',repeat('4',64),
		'{"commandHead":"npm test","notify":true}');
	perform public.qorpera_complete_native_tool_operation(pg_temp.binding(),'30000000-0000-4000-8000-000000000502',repeat('4',64),v_auth);
	perform pg_temp.wake_assert(v_auth ->> 'schema' = 'qorpera.machine-command-authority/v1' and v_auth ->> 'state' = 'authorized' and v_auth ->> 'executorOwner' = 'mx-a'
		and v_auth ->> 'placementId' = (pg_temp.placement('build-a')).id::text
		and v_auth ->> 'providerId' = 'machine-fixture' and v_auth ->> 'operationKey' = 'suite' and v_auth ->> 'inputSha256' = repeat('4',64)
		and v_auth ->> 'bootId' = current_setting('qorpera_test.boot_a')
		and public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'start','30000000-0000-4000-8000-000000000502',repeat('4',64),
			'{"commandHead":"npm test","notify":true}') ->> 'commandId' = '30000000-0000-4000-8000-000000000502'
		and public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'read','30000000-0000-4000-8000-000000000502') ->> 'executorOwner' = 'mx-a'
		and public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'cancel','30000000-0000-4000-8000-000000000502') ->> 'executorOwner' = 'mx-a',
		'The command is authorized, again idempotently, and readable: '||v_auth::text);
	perform pg_temp.wake_assert((select requested_by_user_id from public.qorpera_company_machine_commands
		where id = '30000000-0000-4000-8000-000000000502') = '30000000-0000-4000-8000-000000000001',
		'The command records the member its run works for');
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'start','30000000-0000-4000-8000-000000000502',repeat('4',64),
		'{"commandHead":"npm test","notify":false}')$sql$,pg_temp.binding(),v_scope),'42501');
	-- The command on a machine of another company is refused (the scope names a machine, never a node).
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'read','30000000-0000-4000-8000-000000000502')$sql$,
		pg_temp.binding(),jsonb_build_object('machineId',extensions.gen_random_uuid())),'42501');
	perform pg_temp.wake_assert(pg_temp.listed('mx-a',repeat('c',64),'build-a') -> 'commands' = jsonb_build_array('30000000-0000-4000-8000-000000000502'),
		'The executor watches the open command');
	perform pg_temp.wake_error(format($sql$select public.qorpera_record_company_machine_commands(%L,'mx-a',%L,repeat('c',64),%L,
		'[{"commandId":"30000000-0000-4000-8000-000000000502","state":"succeeded"}]',false)$sql$,(pg_temp.placement('build-a')).id,
		public.qorpera_company_machine_binding_text((pg_temp.placement('build-a')).binding),current_setting('qorpera_test.boot_a')),'22023');
	perform pg_temp.wake_assert(pg_temp.record('build-a',extensions.gen_random_uuid(),
		'[{"commandId":"30000000-0000-4000-8000-000000000502","state":"succeeded","exitCode":0}]',false) ->> 'state' = 'stale',
		'Only the current boot''s view counts');
	v_recorded := pg_temp.record('build-a',current_setting('qorpera_test.boot_a')::uuid,
		'[{"commandId":"30000000-0000-4000-8000-000000000502","state":"failed","exitCode":2,"outputTail":"1 test failed"}]',true);
	perform pg_temp.wake_assert(v_recorded ->> 'state' = 'recorded' and (v_recorded ->> 'ended')::int = 1
		and exists (select 1 from public.qorpera_company_machine_commands where id = '30000000-0000-4000-8000-000000000502'
			and state = 'failed' and exit_code = 2 and output_tail = '1 test failed' and ended_at is not null)
		and (select count(*) from public.qorpera_company_machine_events where kind = 'command'
			and command_id = '30000000-0000-4000-8000-000000000502' and delivery = 'waiting') = 1,
		'The end is recorded and becomes a notification');
end $$;

-- 7. A start the guest does not know yet may still be on its way: it is lost only after two
--    minutes, and a start given up is never started late. A tail is cut to 4000 bytes on a character.
do $$
declare v_scope jsonb := jsonb_build_object('machineId',(pg_temp.machine('build-a')).id); v_auth jsonb; v_recorded jsonb;
begin
	v_auth := pg_temp.run('30000000-0000-4000-8000-000000000504','flaky',repeat('8',64),'build-a','./flaky.sh',false);
	v_recorded := pg_temp.record('build-a',current_setting('qorpera_test.boot_a')::uuid,
		'[{"commandId":"30000000-0000-4000-8000-000000000504","state":"lost"}]',false);
	perform pg_temp.wake_assert(v_auth ->> 'state' = 'authorized' and (v_recorded ->> 'ended')::int = 0
		and exists (select 1 from public.qorpera_company_machine_commands where id = '30000000-0000-4000-8000-000000000504' and ended_at is null),
		'A new command the guest has not seen yet stays open');
	-- A retry sends the start again: the guest's two minutes start over.
	update public.qorpera_company_machine_commands set sent_at = clock_timestamp() - interval '3 minutes'
	where id = '30000000-0000-4000-8000-000000000504';
	perform public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'start','30000000-0000-4000-8000-000000000504',repeat('8',64),
		'{"commandHead":"./flaky.sh","notify":false}');
	v_recorded := pg_temp.record('build-a',current_setting('qorpera_test.boot_a')::uuid,
		'[{"commandId":"30000000-0000-4000-8000-000000000504","state":"lost"}]',false);
	perform pg_temp.wake_assert((v_recorded ->> 'ended')::int = 0,'A start sent again gets its two minutes again');
	update public.qorpera_company_machine_commands set sent_at = clock_timestamp() - interval '3 minutes'
	where id = '30000000-0000-4000-8000-000000000504';
	v_recorded := pg_temp.record('build-a',current_setting('qorpera_test.boot_a')::uuid,
		'[{"commandId":"30000000-0000-4000-8000-000000000504","state":"lost"}]',false);
	v_auth := public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'start','30000000-0000-4000-8000-000000000504',repeat('8',64),
		'{"commandHead":"./flaky.sh","notify":false}');
	perform pg_temp.wake_assert((v_recorded ->> 'ended')::int = 1 and v_auth ->> 'state' = 'refused' and v_auth ->> 'reason' = 'MACHINE_COMMAND_ENDED'
		and v_auth ->> 'commandState' = 'lost'
		and public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'read','30000000-0000-4000-8000-000000000504') ->> 'state' = 'authorized',
		'Lost after the grace, and its start is never retried: '||v_auth::text);
	-- A command that ran to its end is answered by the guest on a retry, never refused or run again.
	v_auth := public.qorpera_authorize_machine_command(pg_temp.binding(),v_scope,'start','30000000-0000-4000-8000-000000000502',repeat('4',64),
		'{"commandHead":"npm test","notify":true}');
	perform pg_temp.wake_assert(v_auth ->> 'state' = 'authorized'
		and (select state from public.qorpera_company_machine_commands where id = '30000000-0000-4000-8000-000000000502') = 'failed',
		'An ended start is answered, not refused: '||v_auth::text);
	perform pg_temp.wake_assert(public.qorpera_machine_text_tail(repeat('é',3000),4000) = repeat('é',2000)
		and public.qorpera_machine_text_tail('abc' || repeat('😀',10),9) = repeat('😀',2)
		and public.qorpera_machine_text_tail(null,10) is null,'Tails are cut on a character');
end $$;

-- 8. Stop: the agent's wish, carried out under custody; the room is given back and the next in line gets it.
do $$
declare v_stop jsonb; v_changed jsonb; v_admitted jsonb;
begin
	perform pg_temp.wake_assert(pg_temp.custody('big','stop') ->> 'reason' = 'MACHINE_IN_USE','An always-on machine never sleeps on its own');
	v_changed := public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"stop","machine":"big"}');
	perform pg_temp.wake_assert(v_changed #>> '{machine,state}' = 'stopping' and v_changed #>> '{machine,stoppedBy}' = 'agent'
		and (pg_temp.listed('mx-a',repeat('c',64),'big') ->> 'stopDue')::boolean,'Stopping: '||v_changed::text);
	v_stop := pg_temp.custody('big','stop');
	perform pg_temp.wake_assert(v_stop ->> 'intent' = 'stop' and (pg_temp.placement('big')).stop_authorized_at is not null,'Stop custody');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_company_machine_events where kind = 'stopped')
		and cardinality((pg_temp.machine('big')).notify_run_ids) = 0,'The run that stops its own waiting machine is not woken for it');
	v_stop := pg_temp.suspend('big');
	perform pg_temp.wake_assert(v_stop ->> 'state' = 'suspended'
		and public.qorpera_company_machine_state(pg_temp.machine('big')) = 'stopped'
		and exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = (pg_temp.placement('big')).id and suspended_at is not null),
		'Asleep, it holds no room: '||v_stop::text);
	perform pg_temp.observe_a();
	-- It waited longer than the idle delay: getting room restarts its idle clock.
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 hours' where name = 'wait';
	v_admitted := public.qorpera_admit_executor_machines('mx-a',repeat('c',64));
	perform pg_temp.wake_assert((pg_temp.machine('wait')).last_used_at > clock_timestamp() - interval '1 minute'
		and not (pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'sleepDue')::boolean,'Room given restarts the idle clock');
	perform pg_temp.wake_assert(v_admitted = jsonb_build_array((pg_temp.machine('wait')).id)
		and public.qorpera_company_machine_state(pg_temp.machine('wait')) = 'starting' and (pg_temp.placement('wait')).owner = 'mx-a'
		and public.qorpera_admit_executor_machines('mx-a',repeat('c',64)) = '[]'::jsonb,
		'The waiting machine is placed when room frees up, one per call: '||v_admitted::text);
	-- Waking the stopped one now finds its node full, and there is no other node: it waits for its own.
	perform pg_temp.start('m-wake-big','{"machine":"big"}');
	perform pg_temp.wake_assert(public.qorpera_company_machine_state(pg_temp.machine('big')) = 'waiting'
		and (pg_temp.placement('big')).owner = 'mx-a'
		and (public.qorpera_company_machine_view(pg_temp.machine('big')) ->> 'queuePosition')::int = 1
		and pg_temp.custody('big','run') ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED'
		and (pg_temp.machine('big')).notify_run_ids = array[(pg_temp.binding() ->> 'runId')::uuid],
		'A woken machine waits for room; the run that woke it is told once');
end $$;

-- 9. Stateless placements: a machine that wakes where there is no room starts fresh on another
--    node with room; its old placement is retired, deleted by its own node's executor and released.
--    A node that only looked away for a moment keeps its sleeping machine.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture-b','providerPolicySha256',repeat('e',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','machine-net');
	v_old public.qorpera_company_machine_placements; v_new public.qorpera_company_machine_placements; v_entry jsonb; v_admitted jsonb;
	v_released jsonb;
begin
	v_old := pg_temp.placement('big');
	perform pg_temp.node('30000000-0000-4000-8000-000000000420',repeat('d',64),'machine-b',16000,68719476736);
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000420',repeat('d',64),'machine','machine-fixture-b',
		repeat('e',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-b',repeat('d',64),true,v_policy,322122547200);
	update public.qorpera_runtime_node_observations set observed_at = clock_timestamp() - interval '2 minutes'
	where node_id = '30000000-0000-4000-8000-000000000410';
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-b',repeat('d',64)) = '[]'::jsonb
		and (pg_temp.placement('big')).id = v_old.id,'A short look-away never moves a machine');
	perform pg_temp.observe_a();
	v_admitted := public.qorpera_admit_executor_machines('mx-b',repeat('d',64));
	v_new := pg_temp.placement('big');
	select * into strict v_old from public.qorpera_company_machine_placements where id = v_old.id;
	perform pg_temp.wake_assert(v_admitted = jsonb_build_array((pg_temp.machine('big')).id) and v_new.id <> v_old.id
		and v_new.owner = 'mx-b' and v_new.machine_id_sha256 = repeat('d',64) and v_new.binding ->> 'placementId' = v_new.id::text
		and v_new.binding ->> 'providerId' = 'machine-fixture-b' and v_new.binding ->> 'machineId' = v_old.binding ->> 'machineId'
		and v_old.retired_at is not null and v_old.removed_at is null
		and public.qorpera_company_machine_state(pg_temp.machine('big')) = 'starting'
		and public.qorpera_company_machine_view(pg_temp.machine('big')) ->> 'node' = 'machine-b'
		and exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = v_new.id and reserved_at is not null
			and node_id = '30000000-0000-4000-8000-000000000420'),
		'Placed fresh on the node with room: '||v_admitted::text);
	v_entry := pg_temp.listed_at('mx-a',repeat('c',64),v_old.id);
	perform pg_temp.wake_assert((v_entry ->> 'retired')::boolean and v_entry ->> 'desiredState' = 'deleted' and (v_entry ->> 'removeDue')::boolean
		and not (v_entry ->> 'reserved')::boolean and not (v_entry ->> 'stopDue')::boolean and v_entry -> 'commands' = '[]'::jsonb
		and pg_temp.listed_at('mx-b',repeat('d',64),v_new.id) ->> 'desiredState' = 'running'
		and pg_temp.custody_at(v_old,'run') ->> 'reason' = 'MACHINE_NOT_WANTED_RUNNING',
		'The old node deletes the retired placement: '||v_entry::text);
	perform pg_temp.wake_assert(pg_temp.custody_at(v_old,'delete') ->> 'intent' = 'delete','Delete custody for the retired placement');
	v_released := pg_temp.release_at(v_old);
	perform pg_temp.wake_assert(v_released ->> 'state' = 'released' and v_released ->> 'machineRemovedAt' is null
		and exists (select 1 from public.qorpera_company_machine_placements where id = v_old.id and removed_at is not null)
		and exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_old.id and released_at is not null)
		and (pg_temp.placement('big')).id = v_new.id and pg_temp.listed_at('mx-a',repeat('c',64),v_old.id) is null,
		'Released; the machine lives on in its new placement: '||v_released::text);
end $$;

-- 10. A task machine sleeps when idle, unless a command runs; asleep past the removal delay it is deleted.
do $$
declare v_boot uuid := extensions.gen_random_uuid(); v_released jsonb; v_place public.qorpera_company_machine_placements;
begin
	perform pg_temp.observe_a();
	perform public.qorpera_configure_machine_lifecycle('mx-a',60,300);
	perform pg_temp.running('wait',v_boot);
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 minutes' where name = 'wait';
	perform pg_temp.run('30000000-0000-4000-8000-000000000503','server',repeat('7',64),'wait','npm run dev',false);
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 minutes' where name = 'wait';
	perform pg_temp.wake_assert(not (pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'sleepDue')::boolean
		and pg_temp.custody('wait','stop') ->> 'reason' = 'MACHINE_IN_USE','A running command keeps it awake');
	perform pg_temp.record('wait',v_boot,'[{"commandId":"30000000-0000-4000-8000-000000000503","state":"cancelled"}]',false);
	perform pg_temp.wake_assert((pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'sleepDue')::boolean,'Idle: sleep is due');
	perform pg_temp.record('wait',v_boot,'[]',true);
	perform pg_temp.wake_assert(not (pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'sleepDue')::boolean,'A busy machine is in use');
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 minutes' where name = 'wait';
	perform pg_temp.wake_assert(pg_temp.custody('wait','stop') ->> 'intent' = 'stop' and (pg_temp.machine('wait')).desired_state = 'stopped'
		and (pg_temp.machine('wait')).desired_by = 'kernel','The kernel puts it to sleep');
	perform pg_temp.wake_assert(pg_temp.suspend('wait') ->> 'state' = 'suspended' and (pg_temp.placement('wait')).running_at is null,'Asleep');
	perform pg_temp.wake_assert(pg_temp.custody('wait','delete') ->> 'reason' = 'MACHINE_NOT_DUE'
		and not (pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'removeDue')::boolean,'Not yet due for removal');
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() - interval '10 minutes' where allocation_id = (pg_temp.placement('wait')).id;
	v_place := pg_temp.placement('wait');
	perform pg_temp.wake_assert((pg_temp.listed('mx-a',repeat('c',64),'wait') ->> 'removeDue')::boolean
		and pg_temp.custody('wait','delete') ->> 'intent' = 'delete' and (pg_temp.machine('wait')).desired_state = 'deleted',
		'Removal is due and granted');
	select * into strict v_place from public.qorpera_company_machine_placements where id = v_place.id;
	v_released := pg_temp.release_at(v_place);
	perform pg_temp.wake_assert(v_released ->> 'state' = 'released' and v_place.removing_at is not null
		and exists (select 1 from public.qorpera_company_machines where name = 'wait' and removed_at is not null)
		and exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_place.id and released_at is not null)
		and exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = v_place.id and released_at is not null)
		and pg_temp.release_at(v_place) ->> 'state' = 'released',
		'The proven delete releases its allocation and its node demand, and the machine: '||v_released::text);
end $$;

-- 11. Deleting an awake machine waits for its stop; a machine that never got a node is gone at once.
do $$
declare v_place public.qorpera_company_machine_placements;
begin
	perform pg_temp.observe_a();
	v_place := pg_temp.placement('build-a');
	perform public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"delete","machine":"build-a"}');
	select * into strict v_place from public.qorpera_company_machine_placements where id = v_place.id;
	perform pg_temp.wake_assert(pg_temp.placement('build-a') is null and v_place.retired_at is not null and v_place.removed_at is null
		and pg_temp.custody_at(v_place,'delete') ->> 'reason' = 'MACHINE_AWAKE'
		and (pg_temp.listed_at('mx-a',repeat('c',64),v_place.id) ->> 'stopDue')::boolean,
		'A deleted machine''s placement is retired, and stops before it is deleted');
	perform pg_temp.start('m-filler','{"name":"filler","purpose":"Takes the room","cpus":8,"memoryGiB":32,"diskGiB":40,"lifetime":"task"}');
	perform pg_temp.start('m-lonely','{"name":"lonely","purpose":"Never placed","cpus":8,"memoryGiB":32,"diskGiB":40,"lifetime":"task"}');
	perform pg_temp.start('m-wide','{"name":"wide","purpose":"Room for it, but not disk","cpus":1,"memoryGiB":1,"diskGiB":290,"lifetime":"task"}');
	perform pg_temp.wake_assert(public.qorpera_company_machine_state(pg_temp.machine('filler')) = 'starting'
		and public.qorpera_company_machine_state(pg_temp.machine('lonely')) = 'waiting'
		and public.qorpera_company_machine_state(pg_temp.machine('wide')) = 'waiting'
		and public.qorpera_admit_executor_machines('mx-a',repeat('c',64)) = '[]'::jsonb,
		'One fits; one waits for processors, one for disk (asleep and retired placements keep theirs)');
	perform public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"delete","machine":"lonely"}');
	perform pg_temp.wake_assert(pg_temp.machine('lonely') is null
		and not exists (select 1 from public.qorpera_company_machine_events where kind = 'stopped'),
		'An unplaced machine is deleted at once; the run that deleted it is not woken for it');
	perform pg_temp.wake_assert(public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"stop","machine":"nobody"}') #>> '{refused,reason}' = 'MACHINE_NOT_FOUND',
		'An unknown machine is a refusal the agent reads');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"list"}') -> 'machines') = 4,
		'The agent lists the company''s machines');
end $$;

-- 12. A task machine stopped with nothing left on any node is removed after the removal delay.
do $$
declare v_row public.qorpera_company_machines;
begin
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
		started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, desired_by, updated_at)
	select extensions.gen_random_uuid(), profile_id, environment_id, 'forgotten', 'Stopped before it got room', started_by_staff_agent_id,
		started_by_run_id, extensions.gen_random_uuid(), requested_by_user_id, 1, 1073741824, 10737418240, 'standard', 'task', 'stopped', 'agent',
		clock_timestamp() - interval '10 minutes'
	from public.qorpera_company_machines where name = 'big' and removed_at is null
	returning * into v_row;
	perform public.qorpera_admit_executor_machines('mx-a',repeat('c',64));
	perform pg_temp.wake_assert(pg_temp.machine('forgotten') is null
		and exists (select 1 from public.qorpera_company_machines where id = v_row.id and removed_at is not null and desired_by = 'kernel'),
		'Removed; its name is free again');
end $$;

-- 13. Members see every machine and may stop, wake or delete it; others see nothing. A member's
--     wake only puts the machine in line: the nodes' next pass gives it room.
do $$
declare v_list jsonb; v_view jsonb;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_list := public.qorpera_list_company_machines('30000000-0000-4000-8000-000000000010');
	perform pg_temp.wake_assert(v_list ->> 'schema' = 'qorpera.company-machines/v1'
		and (select count(*) from jsonb_array_elements(v_list -> 'machines')) = 7
		and exists (select 1 from jsonb_array_elements(v_list -> 'machines') m where m ->> 'name' = 'build-a'
			and m #>> '{startedBy,name}' = 'Agent' and exists (select 1 from jsonb_array_elements(m -> 'commands') c
				where c ->> 'command' = 'npm test' and c ->> 'state' = 'failed'))
		and not exists (select 1 from jsonb_array_elements(v_list -> 'machines') m where m ? 'binding' or m ? 'instanceSha256' or m ? 'placementId'),
		'Members see the machines, their commands and who started them: '||v_list::text);
	perform pg_temp.wake_assert(public.qorpera_list_session_machines('30000000-0000-4000-8000-000000000040') ->> 'schema' = 'qorpera.session-machines/v1'
		and jsonb_array_length(public.qorpera_list_session_machines('30000000-0000-4000-8000-000000000040') -> 'machines') = 7
		and jsonb_array_length(public.qorpera_list_session_machines('30000000-0000-4000-8000-000000000042') -> 'machines') = 0,
		'The conversation that started them shows its machines');
	v_view := public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',(pg_temp.machine('big')).id,'stop');
	perform pg_temp.wake_assert(v_view ->> 'state' = 'stopping' and v_view ->> 'stoppedBy' = 'member'
		and (select count(*) from public.qorpera_company_machine_events where kind = 'stopped' and machine_id = (pg_temp.machine('big')).id) = 1,
		'A member stops a machine; the run waiting for it hears it was stopped before it ran');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.custody('big','stop');
	perform pg_temp.suspend('big');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_view := public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',(pg_temp.machine('big')).id,'start');
	perform pg_temp.wake_assert(v_view ->> 'state' = 'waiting' and (v_view ->> 'queuePosition')::int = 2,
		'A member wakes an asleep machine: it takes its place in line: '||v_view::text);
	perform pg_temp.wake_error(format($sql$select public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',%L,'start')$sql$,
		(select id from public.qorpera_company_machines where name = 'build-a' and removed_at is null)),'55000');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000099');
	perform pg_temp.wake_error($sql$select public.qorpera_list_company_machines('30000000-0000-4000-8000-000000000010')$sql$,'42501');
	perform pg_temp.wake_error($sql$select public.qorpera_list_session_machines('30000000-0000-4000-8000-000000000040')$sql$,'42501');
	perform pg_temp.wake_error(format($sql$select public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',%L,'delete')$sql$,
		(pg_temp.machine('big')).id),'42501');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.observe('30000000-0000-4000-8000-000000000420',repeat('d',64),16000,68719476736);
	v_view := public.qorpera_admit_executor_machines('mx-b',repeat('d',64));
	perform pg_temp.wake_assert(v_view = jsonb_build_array((pg_temp.machine('big')).id)
		and public.qorpera_company_machine_state(pg_temp.machine('big')) = 'starting',
		'The next pass wakes it where it slept: '||v_view::text);
end $$;

-- 14. Disk given back: the first machine in line that lacks only disk that stopped machines hold on
--     a node gets it. Their scratch disks are given up, the longest asleep first, and it takes the disk
--     once their deletes are proven; disks already being deleted count as coming free.
do $$
declare v_build public.qorpera_company_machine_placements; v_filler public.qorpera_company_machine_placements; v_admitted jsonb;
begin
	perform pg_temp.observe_a();
	perform public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"stop","machine":"filler"}');
	perform pg_temp.custody('filler','stop');
	perform pg_temp.suspend('filler');
	v_filler := pg_temp.placement('filler');
	-- build-a's deleted placement is deleted and released: 40 GiB of A's 300 are then held by filler, asleep.
	select placement.* into strict v_build from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id where machine.name = 'build-a';
	perform pg_temp.custody_at(v_build,'stop');
	perform public.qorpera_suspend_company_machine(v_build.id,'mx-a',public.qorpera_company_machine_binding_text(v_build.binding),repeat('c',64));
	perform pg_temp.custody_at(v_build,'delete');
	select * into strict v_build from public.qorpera_company_machine_placements where id = v_build.id;
	perform pg_temp.release_at(v_build);
	perform pg_temp.observe_a();
	v_admitted := public.qorpera_admit_executor_machines('mx-a',repeat('c',64));
	perform pg_temp.wake_assert(v_admitted = '[]'::jsonb
		and (select retired_at is not null from public.qorpera_company_machine_placements where id = v_filler.id)
		and (pg_temp.machine('filler')).desired_state = 'stopped' and pg_temp.placement('filler') is null
		and public.qorpera_company_machine_state(pg_temp.machine('wide')) = 'waiting',
		'The stopped machine''s scratch disk is given up for the machine in line');
	v_admitted := public.qorpera_admit_executor_machines('mx-a',repeat('c',64));
	perform pg_temp.wake_assert(v_admitted = '[]'::jsonb
		and (select count(*) from public.qorpera_company_machine_placements where owner = 'mx-a' and retired_at is not null and removed_at is null) = 1,
		'Nothing more is given up while that disk is being deleted');
	select * into strict v_filler from public.qorpera_company_machine_placements where id = v_filler.id;
	perform pg_temp.custody_at(v_filler,'delete');
	select * into strict v_filler from public.qorpera_company_machine_placements where id = v_filler.id;
	perform pg_temp.release_at(v_filler);
	perform pg_temp.observe_a();
	v_admitted := public.qorpera_admit_executor_machines('mx-a',repeat('c',64));
	perform pg_temp.wake_assert(v_admitted = jsonb_build_array((pg_temp.machine('wide')).id)
		and (pg_temp.machine('filler')).id is not null,'Once it is deleted, the waiting machine gets the disk; the stopped one lives on without it');
end $$;

-- 15. A new image: a placement made under a machine policy its node no longer uses is never woken;
--     the machine starts fresh from the current image, on the same node too.
do $$
declare v_old public.qorpera_company_machine_placements; v_new public.qorpera_company_machine_placements;
	v_policy jsonb := jsonb_build_object('providerId','machine-fixture-b','providerPolicySha256',repeat('9',64),'project','machines',
		'imageFingerprint',repeat('8',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','machine-net');
begin
	perform public.qorpera_native_machine_manage(pg_temp.binding(),'{"action":"stop","machine":"big"}');
	perform pg_temp.custody('big','stop');
	perform pg_temp.suspend('big');
	v_old := pg_temp.placement('big');
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000420',repeat('d',64),'machine','machine-fixture-b',
		repeat('9',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-b',repeat('d',64),true,v_policy,322122547200);
	perform pg_temp.observe('30000000-0000-4000-8000-000000000420',repeat('d',64),16000,68719476736);
	perform pg_temp.start('m-wake-big-2','{"machine":"big"}');
	v_new := pg_temp.placement('big');
	select * into strict v_old from public.qorpera_company_machine_placements where id = v_old.id;
	perform pg_temp.wake_assert(v_new.id <> v_old.id and v_new.owner = 'mx-b' and v_new.binding @> v_policy
		and v_old.retired_at is not null and v_old.binding ->> 'imageFingerprint' = repeat('a',64)
		and public.qorpera_company_machine_state(pg_temp.machine('big')) = 'starting',
		'Woken fresh from the new image: '||v_new.binding::text);
end $$;

-- 16. The observation ledger names the new tools; the binding text is the executor's exactly
--     (packages/runner-orchestrator/test/company-machine.test.ts asserts the same string).
do $$
begin
	perform pg_temp.wake_assert(public.qorpera_company_machine_binding_text(jsonb_build_object('schema','qorpera.lxd-company-machine/v1',
		'machineId','00000000-0000-4000-8000-000000000002','placementId','00000000-0000-4000-8000-000000000005',
		'companyId','00000000-0000-4000-8000-000000000003',
		'environmentId','00000000-0000-4000-8000-000000000004','providerId','machine-node','providerPolicySha256',repeat('a',64),
		'project','machines','imageFingerprint',repeat('b',64),'bootstrapSha256',repeat('c',64),'storagePool','machines',
		'network','machine-net','cpus',8,'memoryBytes',34359738368,'rootDiskBytes',107374182400,'repositoryWorkerId',null))
		= '{"schema":"qorpera.lxd-company-machine/v1","machineId":"00000000-0000-4000-8000-000000000002",'
			|| '"placementId":"00000000-0000-4000-8000-000000000005","companyId":"00000000-0000-4000-8000-000000000003",'
			|| '"environmentId":"00000000-0000-4000-8000-000000000004","providerId":"machine-node","providerPolicySha256":"' || repeat('a',64)
			|| '","project":"machines","imageFingerprint":"' || repeat('b',64) || '","bootstrapSha256":"' || repeat('c',64)
			|| '","storagePool":"machines","network":"machine-net","cpus":8,"memoryBytes":34359738368,"rootDiskBytes":107374182400,"repositoryWorkerId":null}',
		'The binding text matches the executor''s');
	perform pg_temp.wake_assert(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)
		like '%''machine_start'',''machine_run'',''machine_read'',''machine_cancel'',''machine_stop'',''machine_delete'',''machine_list''%',
		'Machine tools are known operations');
end $$;

-- 17. The events wait for the parent run to end, then wake it as a continuation in its conversation.
--     A wake holds 8 KiB: it carries as many events as fit (never more than eight, each with the
--     end of its output), and the rest follow. Four events are waiting: build-a running, its failed
--     command, wait running, and big stopped by a member before it ran.
do $$
declare v_wake public.qorpera_wake_occurrences; v_parent public.qorpera_execution_runs; v_count integer;
begin
	select * into strict v_parent from public.qorpera_execution_runs where id = (pg_temp.binding() ->> 'runId')::uuid;
	perform pg_temp.wake_assert((select count(*) from public.qorpera_company_machine_events where delivery = 'waiting') = 4,
		'Four events wait for the parent');
	-- Eight test shards that ended together, each with 4000 bytes of output and a long command.
	with shards as (
		insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify, ended_at,
			state, exit_code, output_tail, requested_by_user_id)
		select extensions.gen_random_uuid(), (pg_temp.machine('wide')).id, v_parent.id, v_parent.staff_agent_id,
			(pg_temp.placement('wide')).id, 'shard ' || n || ' ' || repeat('é', 280), true, clock_timestamp(), 'succeeded', 0, repeat('é', 2000),
			v_parent.requested_by_user_id
		from generate_series(1, 8) n returning id)
	insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind, command_id)
	select (pg_temp.machine('wide')).id, v_parent.profile_id, v_parent.environment_id, v_parent.staff_agent_id, v_parent.id, 'command', id
	from shards;
	perform public.qorpera_drain_machine_wakes(32);
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'machine-event'),
		'Nothing races the run that is still working');
	perform pg_temp.wake_public_send(pg_temp.binding(),'final','machine-final');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where run_id = v_parent.id;
	perform public.qorpera_materialize_wake_execution_runs(32);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'machine-event';
	v_count := jsonb_array_length(v_wake.payload -> 'events');
	perform pg_temp.wake_assert(v_wake.status = 'materialized' and v_wake.wake_kind = 'agent' and v_wake.parent_run_id = v_parent.id
		and v_wake.staff_agent_id = v_parent.staff_agent_id and v_wake.session_id = v_parent.session_id
		and v_wake.occurrence_key = 'machine-event:' || v_wake.id::text
		and v_wake.payload ->> 'schema' = 'qorpera.machine-event/v1' and v_count between 5 and 7
		and pg_column_size(v_wake.payload) <= 6144
		and v_wake.payload #>> '{events,0,kind}' = 'running' and v_wake.payload #>> '{events,0,machine}' = 'build-a'
		and v_wake.payload #>> '{events,1,commandState}' = 'failed' and v_wake.payload #>> '{events,1,command}' = 'npm test'
		and v_wake.payload #>> '{events,1,outputTail}' = '1 test failed' and (v_wake.payload #>> '{events,1,exitCode}')::int = 2
		and v_wake.payload #>> '{events,2,kind}' = 'running' and v_wake.payload #>> '{events,2,machine}' = 'wait'
		and v_wake.payload #>> '{events,3,kind}' = 'stopped' and v_wake.payload #>> '{events,3,machine}' = 'big'
		and v_wake.payload #>> '{events,4,outputTail}' = repeat('é', 300)
		and (v_wake.payload ->> 'stillWaiting')::int = 12 - v_count
		and (select count(*) from public.qorpera_company_machine_events where delivery = 'waiting') = 12 - v_count
		and public.qorpera_wake_authorized(v_wake),
		'One continuation carries what fits: '||v_count||' events, '||pg_column_size(v_wake.payload)||' bytes');
	perform set_config('qorpera_test.first_count',v_count::text,true);
end $$;

-- 18. The continuation becomes a run of the same agent in the same conversation; its context
--     carries its events with all of their kept output, and what the parent run already did.
do $$
declare v_wake public.qorpera_wake_occurrences; v_run public.qorpera_execution_runs; v_continuation jsonb;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'machine-event';
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	v_continuation := public.qorpera_run_continuation(v_run);
	perform pg_temp.wake_assert(v_run.staff_agent_id = v_wake.staff_agent_id
		and v_run.session_id = v_wake.session_id and v_continuation ->> 'schema' = 'qorpera.machine-event-continuation/v1'
		and v_continuation ->> 'parentRunId' = v_wake.parent_run_id::text
		and jsonb_array_length(v_continuation -> 'events') = current_setting('qorpera_test.first_count')::int
		and v_continuation #>> '{events,4,outputTail}' = repeat('é', 2000)
		and exists (select 1 from jsonb_array_elements(v_continuation -> 'receipts') r where r ->> 'logicalOperationKey' = 'machine_start:m-build-a')
		and (public.qorpera_runtime_wake_policy(v_run.id) ->> 'final') is not null,
		'The continuation run: '||left(v_continuation::text, 2000));
end $$;

-- 19. The rest follow once that continuation has ended, one continuation at a time and never more
--     than a wake holds; a person who stops a continuation hears nothing more from that run's machines.
do $$
declare v_first public.qorpera_wake_occurrences; v_second public.qorpera_wake_occurrences; v_event uuid; v_count integer;
	v_left integer;
begin
	select * into strict v_first from public.qorpera_wake_occurrences where source_kind = 'machine-event';
	perform public.qorpera_drain_machine_wakes(32);
	perform pg_temp.wake_assert((select count(*) from public.qorpera_wake_occurrences where source_kind = 'machine-event') = 1,
		'The next events wait while the continuation runs');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where run_id = v_first.run_id;
	perform public.qorpera_materialize_wake_execution_runs(32);
	select * into strict v_second from public.qorpera_wake_occurrences where source_kind = 'machine-event' and id <> v_first.id;
	v_count := jsonb_array_length(v_second.payload -> 'events');
	v_left := 12 - current_setting('qorpera_test.first_count')::int - v_count;
	perform pg_temp.wake_assert(v_second.status = 'materialized' and v_second.parent_run_id = v_first.parent_run_id
		and v_count between 2 and 5 and v_left > 0 and pg_column_size(v_second.payload) <= 6144
		and (v_second.payload ->> 'stillWaiting')::int = v_left
		and (select count(*) from public.qorpera_company_machine_events where delivery = 'waiting') = v_left,
		'Six long reports do not fit one wake: '||v_count||' events, '||pg_column_size(v_second.payload)||' bytes');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_assert(public.qorpera_cancel_session_run('30000000-0000-4000-8000-000000000040',v_second.run_id) ->> 'status' = 'cancelled',
		'A person stops the continuation');
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind)
	select (pg_temp.machine('wide')).id, profile_id, environment_id, staff_agent_id, id, 'running'
	from public.qorpera_execution_runs where id = v_first.parent_run_id
	returning id into v_event;
	perform public.qorpera_drain_machine_wakes(32);
	perform pg_temp.wake_assert(public.qorpera_machine_revival_stopped(v_first.parent_run_id)
		and exists (select 1 from public.qorpera_company_machine_events where id = v_event and delivery = 'suppressed')
		and not exists (select 1 from public.qorpera_company_machine_events where delivery = 'waiting')
		and (select count(*) from public.qorpera_company_machine_events where delivery = 'suppressed') = v_left + 1
		and (select count(*) from public.qorpera_wake_occurrences where source_kind = 'machine-event') = 2,
		'That run''s later events are held back');
end $$;

-- 20. A node gone for good: once its executor is disabled, an operator gives up its placements.
--     Every allocation is released (its node's demand with it) after every placement is closed.
do $$
declare v_ids uuid[]; v_policy jsonb := (select policy from public.qorpera_machine_executors where owner = 'mx-b'); v_given integer;
begin
	select array_agg(id order by id) into v_ids from public.qorpera_company_machine_placements
	where owner = 'mx-b' and removed_at is null;
	perform pg_temp.wake_assert(cardinality(v_ids) >= 2 and exists (select 1 from public.qorpera_runtime_machine_allocations
		where id = any(v_ids) and released_at is null), 'Node b still holds placements to give up together');
	perform pg_temp.wake_error($sql$select public.qorpera_abandon_machine_executor('mx-b',repeat('d',64))$sql$,'55000',
		'Disable the machine executor first');
	perform public.qorpera_configure_machine_executor('mx-b',repeat('d',64),false,v_policy,322122547200);
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error($sql$select public.qorpera_abandon_machine_executor('mx-b',repeat('d',64))$sql$,'42501',
		'Machine operator authority required');
	perform pg_temp.path_claims('service_role');
	v_given := public.qorpera_abandon_machine_executor('mx-b',repeat('d',64));
	perform pg_temp.wake_assert(v_given = cardinality(v_ids)
		and not exists (select 1 from public.qorpera_company_machine_placements where id = any(v_ids) and removed_at is null)
		and not exists (select 1 from public.qorpera_runtime_machine_allocations where id = any(v_ids) and released_at is null)
		and not exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = any(v_ids)
			and reserved_at is not null and released_at is null)
		and public.qorpera_abandon_machine_executor('mx-b',repeat('d',64)) = 0,
		'Every placement is given up and every allocation released, once: '||v_given||' of '||cardinality(v_ids));
end $$;

-- 21. A deleted company's machines are deleted too (20260928269360): under its fence, once, waking no run.
do $$
declare v_profile uuid := '30000000-0000-4000-8000-000000000010'; v_open integer; v_events integer; v_result jsonb; v_again jsonb;
begin
	select count(*) into v_open from public.qorpera_company_machines
	where profile_id = v_profile and removed_at is null and desired_state <> 'deleted';
	select count(*) into v_events from public.qorpera_company_machine_events where profile_id = v_profile and kind = 'stopped';
	perform pg_temp.wake_assert(v_open >= 1, 'The company still has machines to delete');
	update public.qorpera_company_machines set notify_run_ids = array[started_by_run_id]
	where profile_id = v_profile and removed_at is null and desired_state <> 'deleted';
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	v_result := public.qorpera_stop_company_work(v_profile);
	v_again := public.qorpera_stop_company_work(v_profile);
	perform pg_temp.wake_assert((v_result ->> 'agentMachinesDeleted')::integer = v_open
		and (v_again ->> 'agentMachinesDeleted')::integer = 0
		and not exists (select 1 from public.qorpera_company_machines
			where profile_id = v_profile and removed_at is null and desired_state <> 'deleted')
		and not exists (select 1 from public.qorpera_company_machines where profile_id = v_profile and cardinality(notify_run_ids) > 0)
		and (select count(*) from public.qorpera_company_machine_events where profile_id = v_profile and kind = 'stopped') = v_events,
		'Every machine is deleted, once, and no run is woken about it: '||v_result::text||' then '||v_again::text);
end $$;
