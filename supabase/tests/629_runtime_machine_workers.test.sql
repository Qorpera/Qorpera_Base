-- @fixture 385_runtime_workers_todos.test.sql until "-- 4b. A worker's access is kernel authority"
-- Workers use machines too (Jonas, 2026-09-28): a worker starts and uses the
-- company's machines like its agent, and its commands are its own; a worker has
-- no conversation to continue, so no machine ever wakes it: it is never on a
-- machine's list of runs to tell, and its commands never ask to be notified. It
-- waits by looking at the machine's status here, until its work is stopped.
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
	perform pg_temp.wake_assert((public.qorpera_run_worker(v_child_run)).id is not null
		and (public.qorpera_run_worker((current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid)).id is null,
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
declare v_scope jsonb := jsonb_build_object('machineId',(pg_temp.machine('shard-1')).id); v_auth jsonb; v_status jsonb;
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
		where id = '30000000-0000-4000-8000-000000000601' and run_id = v_child_run and not notify
			and requested_by_user_id = '30000000-0000-4000-8000-000000000001'),
		'The command is the worker''s, without notify, for the member its agent works for');
	-- The worker waits by looking at the status here: the command runs until the executor records its end.
	v_status := public.qorpera_native_machine_manage(pg_temp.child(),
		'{"action":"status","machine":"shard-1","commandId":"30000000-0000-4000-8000-000000000601"}');
	perform pg_temp.wake_assert(v_status ->> 'schema' = 'qorpera.machine-status/v1' and v_status #>> '{machine,state}' = 'running'
		and v_status #>> '{command,state}' = 'running' and v_status #> '{command,endedAt}' = 'null'::jsonb,
		'A waiting worker sees its command running: '||v_status::text);
	perform public.qorpera_record_company_machine_commands((pg_temp.placement('shard-1')).id,'mx-a',
		public.qorpera_company_machine_binding_text((pg_temp.placement('shard-1')).binding),repeat('c',64),
		(pg_temp.placement('shard-1')).boot_id,
		'[{"commandId":"30000000-0000-4000-8000-000000000601","state":"failed","exitCode":1,"outputTail":"1 failing"}]',false);
	v_status := public.qorpera_native_machine_manage(pg_temp.child(),
		'{"action":"status","machine":"shard-1","commandId":"30000000-0000-4000-8000-000000000601"}');
	perform pg_temp.wake_assert(v_status #>> '{command,state}' = 'failed' and v_status #>> '{command,endedAt}' is not null
		and not v_status ? 'workStopped',
		'Once recorded, the worker sees how it ended: '||v_status::text);
	perform pg_temp.wake_assert(public.qorpera_native_machine_manage(pg_temp.child(),
			'{"action":"status","machine":"shard-1","commandId":"30000000-0000-4000-8000-000000000999"}') -> 'command' = 'null'::jsonb
		and public.qorpera_native_machine_manage(pg_temp.child(),'{"action":"status","machine":"no-such"}') -> 'machine' = 'null'::jsonb
		and not public.qorpera_native_machine_manage(pg_temp.child(),'{"action":"status","machine":"shard-1"}') ? 'command',
		'Another machine''s command, or no such machine, is none');
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_manage(%L,
		'{"action":"stop","machine":"shard-1","commandId":"30000000-0000-4000-8000-000000000601"}')$sql$,pg_temp.child()),'22023',
		'Invalid machine request');
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_manage(%L,
		'{"action":"status","machine":"shard-1","commandId":"not-a-command"}')$sql$,pg_temp.child()),'22023',
		'Invalid machine request');
	perform pg_temp.wake_error(format($sql$select public.qorpera_native_machine_manage(%L,
		'{"action":"stop","machine":"shard-1","":1}')$sql$,pg_temp.child()),'22023',
		'Invalid machine request');
	-- A command is looked up on the machine named, and a machine in this company only.
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
		started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, desired_by)
	select extensions.gen_random_uuid(), profile_id, environment_id, 'other-1', 'Another machine', started_by_staff_agent_id,
		started_by_run_id, extensions.gen_random_uuid(), requested_by_user_id, 1, 1073741824, 10737418240, 'standard', 'task', 'stopped', 'agent'
	from public.qorpera_company_machines where name = 'shard-1' and removed_at is null;
	insert into public.qorpera_profiles(id,name,created_by_user_id)
	values ('30000000-0000-4000-8000-000000000611','Another company','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
	values ('30000000-0000-4000-8000-000000000612','30000000-0000-4000-8000-000000000611','Environment',1,'30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
		started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, desired_by)
	select extensions.gen_random_uuid(), '30000000-0000-4000-8000-000000000611', '30000000-0000-4000-8000-000000000612', 'elsewhere',
		'Another company''s machine', started_by_staff_agent_id, started_by_run_id, extensions.gen_random_uuid(), requested_by_user_id,
		1, 1073741824, 10737418240, 'standard', 'task', 'stopped', 'agent'
	from public.qorpera_company_machines where name = 'shard-1' and removed_at is null;
	perform pg_temp.wake_assert(public.qorpera_native_machine_manage(pg_temp.child(),
			'{"action":"status","machine":"other-1","commandId":"30000000-0000-4000-8000-000000000601"}') -> 'command' = 'null'::jsonb
		and public.qorpera_native_machine_manage(pg_temp.child(),'{"action":"status","machine":"elsewhere"}') -> 'machine' = 'null'::jsonb,
		'Another machine''s command, and another company''s machine, are none');
	-- The agent itself may still ask to be woken by a command on the worker's machine.
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		'30000000-0000-4000-8000-000000000602','machine_run:t2',repeat('6',64),repeat('5',64),false);
	v_auth := public.qorpera_authorize_machine_command(current_setting('qorpera_test.parent_binding')::jsonb,v_scope,'start',
		'30000000-0000-4000-8000-000000000602',repeat('6',64),'{"commandHead":"npm run lint","notify":true}');
	perform pg_temp.wake_assert(v_auth ->> 'state' = 'authorized','Any agent may use the worker''s machine, with notify');
end $$;

-- 4. A worker waking a machine that is really asleep (powered off) is not put on its list either.
do $$
declare v_result jsonb; v_text text;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_member_manage_company_machine('30000000-0000-4000-8000-000000000010',(pg_temp.machine('shard-1')).id,'stop');
	perform pg_temp.path_claims('service_role');
	v_text := public.qorpera_company_machine_binding_text((pg_temp.placement('shard-1')).binding);
	perform public.qorpera_authorize_executor_machine((pg_temp.placement('shard-1')).id,'mx-a',v_text,repeat('c',64),'stop');
	perform public.qorpera_suspend_company_machine((pg_temp.placement('shard-1')).id,'mx-a',v_text,repeat('c',64));
	perform pg_temp.wake_assert((pg_temp.placement('shard-1')).running_at is null, 'The machine is asleep');
	v_result := pg_temp.machine_start(pg_temp.child(),'w-wake','{"machine":"shard-1"}');
	perform pg_temp.wake_assert((pg_temp.machine('shard-1')).desired_state = 'running'
		and v_result #>> '{machine,state}' in ('waiting','starting')
		and cardinality((pg_temp.machine('shard-1')).notify_run_ids) = 0,
		'A worker''s wake asks for room without asking to be told: '||v_result::text);
	perform pg_temp.wake_assert(public.qorpera_native_machine_manage(pg_temp.child(),'{"action":"status","machine":"shard-1"}')
		#>> '{machine,state}' = v_result #>> '{machine,state}', 'The worker can look while it starts');
end $$;

-- 5. The parent conversation's card shows the machine its agent's worker started.
do $$
declare v_session uuid := (select session_id from public.qorpera_execution_runs
		where id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid);
	v_list jsonb;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_list := public.qorpera_list_session_machines(v_session);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(v_session is not null and jsonb_path_exists(v_list, '$.machines[*] ? (@.name == "shard-1")'),
		'The worker''s machine is on its conversation''s card: '||v_list::text);
end $$;

-- 6. A cancelled worker stops waiting: its status look says its work stopped.
do $$
declare v_worker public.qorpera_runtime_workers%rowtype := public.qorpera_run_worker((pg_temp.child() ->> 'runId')::uuid); v_status jsonb;
begin
	perform public.qorpera_cancel_worker(v_worker,(current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid,'parent_cancelled');
	v_status := public.qorpera_native_machine_manage(pg_temp.child(),
		'{"action":"status","machine":"shard-1","commandId":"30000000-0000-4000-8000-000000000601"}');
	perform pg_temp.wake_assert(v_status = '{"schema":"qorpera.machine-status/v1","workStopped":true}'::jsonb,
		'A cancelled worker is told its work stopped: '||v_status::text);
end $$;
