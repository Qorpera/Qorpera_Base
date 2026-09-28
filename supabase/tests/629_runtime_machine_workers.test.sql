-- @fixture 385_runtime_workers_todos.test.sql until "-- 4b. A worker's access is kernel authority"
-- Workers use machines too (Jonas, 2026-09-28): a worker starts and uses the
-- company's machines like its agent, and its commands are its own; a worker has
-- no conversation to continue, so no machine ever wakes it: it is never on a
-- machine's list of runs to tell, and its commands never ask to be notified.
select pg_temp.path_claims('service_role');

create function pg_temp.child() returns jsonb language sql as $$ select current_setting('qorpera_test.child_binding')::jsonb $$;
create function pg_temp.machine_envelope(p_binding jsonb,p_key text,p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(p_binding) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
create function pg_temp.machine_start(p_binding jsonb,p_key text,p_args jsonb) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.machine_envelope(p_binding,p_key,p_args); v_receipt uuid := extensions.gen_random_uuid();
	v_sha text := encode(extensions.digest(convert_to(v_envelope,'UTF8'),'sha256'),'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(p_binding,v_envelope,'authorize');
	perform public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'machine_start:' || p_key,v_sha,repeat('9',64),false);
	v_result := public.qorpera_native_machine_start(p_binding,v_envelope,'begin',v_receipt,repeat('9',64));
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_sha,v_result);
	return v_result;
end
$$;
create function pg_temp.machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
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

-- 1. One node that makes machines, as in 628.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','machine-net');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','30000000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'label','machine-a','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','30000000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000410',repeat('c',64),'machine','machine-fixture',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-a',repeat('c',64),true,v_policy,322122547200);
	perform pg_temp.observe('30000000-0000-4000-8000-000000000410',repeat('c',64),16000,68719476736);
end $$;

-- 2. A worker starts a machine like its agent; the machine is the worker run's, and no one is to be told.
do $$
declare v_result jsonb; v_child_run uuid := (pg_temp.child() ->> 'runId')::uuid;
begin
	perform pg_temp.wake_assert(public.qorpera_machine_run_is_worker(v_child_run)
		and not public.qorpera_machine_run_is_worker((current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid),
		'The worker run is known as one');
	v_result := pg_temp.machine_start(pg_temp.child(),'w-shard',
		'{"name":"shard-1","purpose":"One test shard","cpus":2,"memoryGiB":4,"diskGiB":40,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_result #>> '{machine,state}' = 'starting' and (pg_temp.machine('shard-1')).started_by_run_id = v_child_run
		and cardinality((pg_temp.machine('shard-1')).notify_run_ids) = 0,
		'A worker starts a machine, and is not put on its list of runs to tell: '||v_result::text);
	perform public.qorpera_mark_company_machine_running((pg_temp.placement('shard-1')).id,'mx-a',
		public.qorpera_company_machine_binding_text((pg_temp.placement('shard-1')).binding),repeat('c',64),extensions.gen_random_uuid());
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_company_machine_events),'Running wakes nobody');
end $$;

-- 3. A worker's command is its own and never asks to be notified; an agent's may.
do $$
declare v_scope jsonb := jsonb_build_object('machineId',(pg_temp.machine('shard-1')).id); v_auth jsonb;
	v_child_run uuid := (pg_temp.child() ->> 'runId')::uuid;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.child(),'30000000-0000-4000-8000-000000000601','machine_run:t1',
		repeat('4',64),repeat('5',64),false);
	perform pg_temp.wake_error(format($sql$select public.qorpera_authorize_machine_command(%L,%L,'start','30000000-0000-4000-8000-000000000601',
		repeat('4',64),'{"commandHead":"npm test","notify":true}')$sql$,pg_temp.child(),v_scope),'42501',
		'A worker waits for its own commands; it is not woken');
	v_auth := public.qorpera_authorize_machine_command(pg_temp.child(),v_scope,'start','30000000-0000-4000-8000-000000000601',
		repeat('4',64),'{"commandHead":"npm test","notify":false}');
	perform public.qorpera_complete_native_tool_operation(pg_temp.child(),'30000000-0000-4000-8000-000000000601',repeat('4',64),v_auth);
	perform pg_temp.wake_assert(v_auth ->> 'state' = 'authorized' and exists (select 1 from public.qorpera_company_machine_commands
		where id = '30000000-0000-4000-8000-000000000601' and run_id = v_child_run and not notify),
		'The command is the worker''s, without notify');
	-- The agent itself may still ask to be woken by a command on the worker's machine.
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		'30000000-0000-4000-8000-000000000602','machine_run:t2',repeat('6',64),repeat('5',64),false);
	v_auth := public.qorpera_authorize_machine_command(current_setting('qorpera_test.parent_binding')::jsonb,v_scope,'start',
		'30000000-0000-4000-8000-000000000602',repeat('6',64),'{"commandHead":"npm run lint","notify":true}');
	perform pg_temp.wake_assert(v_auth ->> 'state' = 'authorized','Any agent may use the worker''s machine, with notify');
end $$;

-- 4. A worker waking a stopped machine by name is not put on its list either.
do $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',(pg_temp.machine('shard-1')).id,'stop');
	perform pg_temp.path_claims('service_role');
	v_result := pg_temp.machine_start(pg_temp.child(),'w-wake','{"machine":"shard-1"}');
	perform pg_temp.wake_assert((pg_temp.machine('shard-1')).desired_state = 'running'
		and cardinality((pg_temp.machine('shard-1')).notify_run_ids) = 0,
		'A worker''s wake asks for room without asking to be told: '||v_result::text);
end $$;
