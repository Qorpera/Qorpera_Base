-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Agents' machines under one idle rule for every machine (20260930055000; the 2026-10-03 amendment, items 1, 3 and 7;
-- the busy measure decided 4 October 2026). 648's committed folder-v2 fixture with a machine node and executor: Ada's
-- run started the task machine m-873, placed on the node and running. Covered:
-- 1. Each command keeps the conversation it is told in (a worker's: the one that dispatched it, in 4).
-- 2. The executor's record: busy commands and busy outside work move the idle clock and are kept, nothing busy does
--    not; an end the guest saw keeps its own state; another boot's record changes nothing; shapes it never sends are
--    refused.
-- 3. A waiting dev server no longer keeps a task machine awake: the list says it is due to sleep; recent use or
--    always-on keeps it.
-- 4. Sleep ends what still runs as slept, and busy outside work with it; Ada's next run in that conversation is told
--    once (machineStopped), a worker's command in the dispatching one; what ended on its own is never told.
-- 5. Other ends say why: a member's stop (stopped), a restart (lost), the computer hours' finishing window (hours).
-- 6. Privileges and markers. The fixture is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Machine idle rule: %', p_message; end if; end
$$;
create function pg_temp.refused(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % (%), got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;

-- The machine node and its executor, as 824 makes them: the node, its inventory, and a fresh ready observation.
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('87300000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','87300000-0000-4000-8000-000000000410','machineIdSha256',repeat('8',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','87300000-0000-4000-8000-000000000410','machineIdSha256',repeat('8',64),'label','machine-873','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','87300000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('8',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('87300000-0000-4000-8000-000000000410',repeat('8',64),'machine','machine-873',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-873',repeat('8',64),true,jsonb_build_object('providerId','machine-873',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;

-- Ada's task machine, started by her leased run in her conversation with the member, and given room on the node.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('87300000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-873',
	'Build the site', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp());
select pg_temp.observe();
select public.qorpera_admit_executor_machines('mx-873', repeat('8', 64)) \g /dev/null

create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = '87300000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.placement() returns public.qorpera_company_machine_placements language sql as $$
	select * from public.qorpera_company_machine_placements where machine_id = '87300000-0000-4000-8000-0000000000a1' and removed_at is null
	order by created_at desc limit 1
$$;
-- A custody call for the machine's placement, as the executor sends it.
create function pg_temp.custody(p_fn text, p_extra text default '') returns jsonb language plpgsql as $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.placement(); v_result jsonb;
begin
	execute format('select public.%s(%L, %L, %L, %L%s)::jsonb', p_fn, v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256, p_extra) into v_result;
	return v_result;
end $$;
-- The executor's record of what it saw in boot b1 (or another boot).
create function pg_temp.record(p_ended jsonb, p_busy jsonb, p_outside boolean,
	p_boot uuid default '87300000-0000-4000-8000-0000000000b1') returns jsonb language sql as $$
	select pg_temp.custody('qorpera_record_company_machine_commands', format(', %L, %L, %L, %L', p_boot, p_ended, p_busy, p_outside))
$$;
create function pg_temp.command(p_n integer) returns uuid language sql as $$
	select ('87300000-0000-4000-8000-000000000' || lpad(p_n::text, 3, '0'))::uuid
$$;
-- A command as qorpera_authorize_machine_command records its start.
create function pg_temp.started(p_n integer, p_head text, p_run uuid default '64800000-0000-4000-8000-0000000000f1') returns void
language sql as $$
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify)
	values (pg_temp.command(p_n), '87300000-0000-4000-8000-0000000000a1', p_run, '64800000-0000-4000-8000-0000000000a1',
		(pg_temp.placement()).id, p_head, false)
$$;
create function pg_temp.command_row(p_n integer) returns public.qorpera_company_machine_commands language sql as $$
	select * from public.qorpera_company_machine_commands where id = pg_temp.command(p_n)
$$;
create function pg_temp.entry() returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_executor_machines('mx-873', repeat('8', 64))) entry
	where entry ->> 'machineId' = '87300000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.open_work() returns jsonb language sql as $$
	select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.binding')::jsonb)
$$;
-- The machine's idle clock: last used this long ago.
create function pg_temp.idle(p_ago interval default '2 hours') returns void language sql as $$
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - p_ago where id = '87300000-0000-4000-8000-0000000000a1'
$$;

select pg_temp.check((pg_temp.placement()).id is not null and public.qorpera_company_machine_placement_reserved((pg_temp.placement()).id),
	'the machine has room on the node');
select pg_temp.check(pg_temp.custody('qorpera_mark_company_machine_running', format(', %L', '87300000-0000-4000-8000-0000000000b1'))
	->> 'state' = 'running', 'the machine runs in boot b1');

-- 1. Commands keep the conversation they are told in.
select pg_temp.started(1, 'npm run dev');
select pg_temp.started(2, 'npm run build');
select pg_temp.check((select c.conversation_run_id = (pg_temp.run()).id and c.session_id = (pg_temp.run()).session_id
	and c.session_id is not null and c.busy_at is null and c.end_reason is null from pg_temp.command_row(1) c),
	'a command keeps the run that started it as its conversation');

-- 2. The executor's record.
select pg_temp.idle();
select pg_temp.check(pg_temp.record('[]', '[]', false) = '{"state":"recorded","ended":0,"busy":0}'::jsonb
	and (pg_temp.machine()).last_used_at < clock_timestamp() - interval '1 hour', 'nothing busy leaves the idle clock alone');
select pg_temp.check(pg_temp.record('[]', jsonb_build_array(pg_temp.command(2)), false) ->> 'busy' = '1'
	and (pg_temp.command_row(2)).busy_at > clock_timestamp() - interval '1 minute' and (pg_temp.command_row(1)).busy_at is null
	and (pg_temp.machine()).last_used_at > clock_timestamp() - interval '1 minute' and (pg_temp.machine()).outside_busy_at is null,
	'a busy command moves the idle clock and keeps when it was busy');
select pg_temp.idle();
select pg_temp.check(pg_temp.record('[]', jsonb_build_array(extensions.gen_random_uuid()), false) ->> 'busy' = '0'
	and (pg_temp.machine()).last_used_at < clock_timestamp() - interval '1 hour', 'a busy id that is no open command here counts nothing');
select pg_temp.check(pg_temp.record('[]', '[]', true) ->> 'busy' = '0'
	and (pg_temp.machine()).last_used_at > clock_timestamp() - interval '1 minute'
	and (pg_temp.machine()).outside_busy_at > clock_timestamp() - interval '1 minute',
	'busy work outside the commands moves the idle clock and is kept');
select pg_temp.check(pg_temp.record(jsonb_build_array(jsonb_build_object('commandId', pg_temp.command(2), 'state', 'succeeded',
		'exitCode', 0, 'outputTail', 'built')), '[]', false) ->> 'ended' = '1'
	and (select c.state = 'succeeded' and c.exit_code = 0 and c.end_reason is null from pg_temp.command_row(2) c),
	'an end the guest saw keeps its own state and no end reason');
select pg_temp.check(pg_temp.record('[]', jsonb_build_array(pg_temp.command(1)), true, extensions.gen_random_uuid()) = '{"state":"stale"}'
	and (pg_temp.command_row(1)).busy_at is null, 'another boot''s record changes nothing');
select pg_temp.refused(format('select pg_temp.record(%L, %L, %L)', '[]', shapes.busy, shapes.outside), '22023', 'Machine commands invalid')
from (values ('{}'::jsonb, false), ('[1]'::jsonb, false), ('["not-a-uuid"]'::jsonb, false),
	((select jsonb_agg(extensions.gen_random_uuid()) from generate_series(1, 65)), false), ('[]'::jsonb, null)) shapes(busy, outside);

-- 3. A waiting dev server no longer keeps the task machine awake: an hour with no use and nothing busy, and it is due.
select pg_temp.idle();
select pg_temp.check((pg_temp.command_row(1)).ended_at is null and (pg_temp.entry() ->> 'sleepDue')::boolean,
	'a task machine whose only command waits is due to sleep');
begin;
select pg_temp.idle('10 minutes');
select pg_temp.check(not (pg_temp.entry() ->> 'sleepDue')::boolean
	and pg_temp.custody('qorpera_authorize_executor_machine', ', ''stop''') = '{"state":"refused","reason":"MACHINE_IN_USE"}',
	'recent use keeps it awake');
rollback;
begin;
update public.qorpera_company_machines set lifetime = 'always-on' where id = '87300000-0000-4000-8000-0000000000a1';
select pg_temp.check(not (pg_temp.entry() ->> 'sleepDue')::boolean
	and pg_temp.custody('qorpera_authorize_executor_machine', ', ''stop''') = '{"state":"refused","reason":"MACHINE_IN_USE"}',
	'an always-on machine never sleeps on its own');
rollback;

-- 4. Sleep: the stop custody agrees, and suspending ends what still runs as slept, and the busy outside work with it.
--    Ada's next run in her conversation is told once; a worker's command in the conversation that dispatched it.
begin;
do $$
declare v_run public.qorpera_execution_runs := pg_temp.run(); v_worker uuid := '87300000-0000-4000-8000-0000000009a1';
	v_worker_run uuid := '87300000-0000-4000-8000-0000000009a2';
begin
	-- The worker run is synthetic, as in 870: a copy of Ada's run outside any conversation, with a dispatch wake naming
	-- a worker whose steering run is Ada's run.
	set local session_replication_role = replica;
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(v_run, jsonb_build_object('id', v_worker_run, 'session_id', null, 'job_id', extensions.gen_random_uuid(),
		'source_id', extensions.gen_random_uuid()))).*;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access, revival,
		dispatch, requested_by_user_id, steering_run_id)
	values (v_worker, v_run.profile_id, v_run.environment_id, v_run.staff_agent_id, extensions.gen_random_uuid(), 'machine-worker', 'Crawl',
		'write', 'each', '{}', v_run.requested_by_user_id, v_run.id);
	insert into public.qorpera_wake_occurrences
	select (jsonb_populate_record(wake, jsonb_build_object('id', extensions.gen_random_uuid(), 'run_id', v_worker_run, 'wake_kind', 'agent',
		'source_kind', 'worker-dispatch', 'source_id', v_worker, 'occurrence_key', 'worker-dispatch:' || v_worker))).*
	from public.qorpera_wake_occurrences wake where wake.run_id = v_run.id;
	set local session_replication_role = origin;
	perform pg_temp.started(3, 'python crawl.py', v_worker_run);
	perform pg_temp.check((select c.run_id = v_worker_run and c.conversation_run_id = v_run.id and c.session_id = v_run.session_id
		from pg_temp.command_row(3) c), 'a worker''s command belongs to the conversation that dispatched it');
end $$;
update public.qorpera_company_machines set outside_busy_at = clock_timestamp() - interval '90 minutes'
where id = '87300000-0000-4000-8000-0000000000a1';
select pg_temp.idle();
select pg_temp.check(pg_temp.custody('qorpera_authorize_executor_machine', ', ''stop''') ->> 'intent' = 'stop'
	and (pg_temp.machine()).desired_state = 'stopped' and (pg_temp.machine()).desired_by = 'kernel',
	'the stop custody agrees: the kernel wants the idle task machine stopped');
select pg_temp.check(pg_temp.custody('qorpera_suspend_company_machine') ->> 'state' = 'suspended', 'the machine sleeps');
select pg_temp.check((select c.state = 'lost' and c.end_reason = 'slept' from pg_temp.command_row(1) c)
	and (pg_temp.command_row(3)).end_reason = 'slept' and (pg_temp.command_row(2)).end_reason is null,
	'sleep ends what still runs as slept; what ended on its own keeps its own end');
select pg_temp.check((select count(*) = 1 and bool_and(stop.staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
		and stop.conversation_run_id = (pg_temp.run()).id and stop.session_id = (pg_temp.run()).session_id and stop.end_reason = 'slept'
		and stop.busy_at < clock_timestamp() - interval '80 minutes' and stop.told_at is null)
	from public.qorpera_company_machine_outside_stops stop where stop.machine_id = '87300000-0000-4000-8000-0000000000a1')
	and (pg_temp.machine()).outside_busy_at is null,
	'busy outside work ends with it, for the agent that started the machine in the conversation of the run that started it');
do $$
declare v_work jsonb := pg_temp.open_work();
begin
	perform pg_temp.check(jsonb_array_length(v_work -> 'machineStopped') = 3
		and v_work #>> '{machineStopped,0,machine}' = 'm-873' and v_work #>> '{machineStopped,0,work}' = 'command'
		and v_work #>> '{machineStopped,0,command}' = 'npm run dev' and v_work #>> '{machineStopped,0,reason}' = 'slept'
		and (v_work #>> '{machineStopped,0,startedAt}')::timestamptz = (pg_temp.command_row(1)).started_at
		and (v_work #>> '{machineStopped,0,endedAt}')::timestamptz = (pg_temp.command_row(1)).ended_at
		and v_work #>> '{machineStopped,1,command}' = 'python crawl.py'
		and v_work #>> '{machineStopped,2,work}' = 'outside' and v_work #>> '{machineStopped,2,reason}' = 'slept'
		and v_work -> 'machineStopped' -> 2 ? 'busyAt' and not v_work -> 'machineStopped' -> 2 ? 'command'
		and v_work -> 'todos' is not null and v_work ->> 'schema' = 'qorpera.agent-open-work/v1',
		'the next run is told what sleep stopped, its worker''s command and the outside work, and only that: ' || v_work::text);
	perform pg_temp.check((pg_temp.command_row(1)).told_run_id = (pg_temp.run()).id and (pg_temp.command_row(2)).told_at is null
		and (select bool_and(told_run_id = (pg_temp.run()).id) from public.qorpera_company_machine_outside_stops),
		'each is marked told by that run; what ended by itself is never told');
	perform pg_temp.check(jsonb_array_length(pg_temp.open_work() -> 'machineStopped') = 3, 'a restart of the same run is told again');
	update public.qorpera_company_machine_commands set told_run_id = extensions.gen_random_uuid() where id = pg_temp.command(1);
	update public.qorpera_company_machine_outside_stops set told_run_id = extensions.gen_random_uuid();
	v_work := pg_temp.open_work();
	perform pg_temp.check(v_work #>> '{machineStopped,0,command}' = 'python crawl.py'
		and jsonb_array_length(v_work -> 'machineStopped') = 1, 'what another run took is not told again');
	-- At most 32 a run, oldest first.
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		started_at, ended_at, state, end_reason)
	select extensions.gen_random_uuid(), '87300000-0000-4000-8000-0000000000a1', (pg_temp.run()).id, (pg_temp.run()).staff_agent_id,
		(pg_temp.placement()).id, 'job ' || n, clock_timestamp() - interval '2 hours',
		clock_timestamp() - interval '1 hour' + n * interval '1 second', 'lost', 'slept'
	from generate_series(1, 40) n;
	v_work := pg_temp.open_work();
	perform pg_temp.check(jsonb_array_length(v_work -> 'machineStopped') = 32 and v_work #>> '{machineStopped,0,command}' = 'job 1'
		and v_work #>> '{machineStopped,31,command}' = 'job 32', 'at most 32 a run, oldest first');
end $$;
rollback;

-- 5. Other ends say why: a member's stop, a restart under the commands, the computer hours running out.
begin;
update public.qorpera_company_machines set desired_state = 'stopped', desired_by = 'member' where id = '87300000-0000-4000-8000-0000000000a1';
select pg_temp.check(public.qorpera_end_company_machine_commands(pg_temp.machine(), 'lost') = 1
	and (pg_temp.command_row(1)).end_reason = 'stopped', 'a member''s stop ends it as stopped');
rollback;
begin;
select pg_temp.check(pg_temp.custody('qorpera_mark_company_machine_running', format(', %L', '87300000-0000-4000-8000-0000000000b2'))
	->> 'state' = 'running' and (pg_temp.command_row(1)).end_reason = 'lost', 'a restart ends what ran in the old boot as lost');
rollback;
begin;
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('64800000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select public.qorpera_computer_hour_zero_sweep(clock_timestamp()) \g /dev/null
update public.qorpera_computer_hour_zero_state set ran_out_at = ran_out_at - interval '61 minutes'
where profile_id = '64800000-0000-4000-8000-000000000010';
select pg_temp.check(public.qorpera_computer_hour_finish_window_over('64800000-0000-4000-8000-000000000010', clock_timestamp()),
	'the company is past its finishing window');
select pg_temp.check(public.qorpera_end_company_machine_commands(pg_temp.machine(), 'lost') = 1 and (pg_temp.command_row(1)).end_reason = 'hours',
	'an hour after the company ran out of computer hours, it ends as hours');
rollback;

-- 6. Only the platform: no API role reaches the outside stops or the new functions; the executor's record is the
--    service role's alone and takes busy commands, not one busy flag. Each patched function names this migration.
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	where has_table_privilege(r.role, 'public.qorpera_company_machine_outside_stops', 'select')
		or has_function_privilege(r.role, 'public.qorpera_take_agent_machine_stopped(public.qorpera_execution_runs)', 'execute')
		or has_function_privilege(r.role, 'public.qorpera_company_machine_command_conversation()', 'execute'))
	and not exists (select 1 from unnest(array['anon','authenticated']) r(role) where has_function_privilege(r.role,
		'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,jsonb,boolean)', 'execute'))
	and has_function_privilege('service_role',
		'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,jsonb,boolean)', 'execute')
	and to_regprocedure('public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)') is null,
	'the tables and functions are the platform''s; the record takes busy commands, not one busy flag');
select pg_temp.check(
	position('(20260930055000)' in pg_get_functiondef('public.qorpera_list_executor_machines(text,text)'::regprocedure)) > 0
	and position('(20260930055000)' in pg_get_functiondef('public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure)) > 0
	and position('(20260930055000)' in pg_get_functiondef('public.qorpera_describe_agent_open_work(jsonb)'::regprocedure)) > 0
	and position('(20260930055000)' in pg_get_functiondef(
		'public.qorpera_end_company_machine_commands(public.qorpera_company_machines,text,jsonb)'::regprocedure)) > 0,
	'each patched function names this migration');

-- Remove the fixture: the machine node and executor, the outside stops, then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_table record;
begin
	delete from public.qorpera_company_machine_outside_stops where machine_id = '87300000-0000-4000-8000-0000000000a1';
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '87300000-0000-4000-8000-000000000410'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '87300000-0000-4000-8000-000000000410';
	delete from public.qorpera_machine_executors where owner = 'mx-873';
end $$;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_machine_outside_stops)
		or exists (select 1 from public.qorpera_runtime_nodes where id = '87300000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-873')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
