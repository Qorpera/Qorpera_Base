-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930181000: check-ins for agents' machines under one idle rule for every machine (the 2026-10-03 amendment, item
-- 5, its machine part), on a folder-v2 company (folder-v2 only, the founder's decision of 3 October). 648's committed
-- fixture with 873's machine node and executor: Ada's run started the task machine m-989, placed on the node and
-- running in boot b1, and started a crawl on it. Covered:
-- 1. A busy look keeps when it found the machine busy; nothing is asked under an hour.
-- 2. An hour after Ada last worked with it, Ada is asked once, in the conversation that started the crawl, with the
--    crawl's handle; the question waits while that run runs.
-- 3. At three hours Ada is asked again from the same start, and the hour-one question no longer stands.
-- 4. What restarts the count (a new command, a new boot) and who is not asked (a machine not found busy lately,
--    always-on, stopped, an archived agent, a company not on folder-v2).
-- 5. Who is asked: a worker's command in the conversation that dispatched it; each conversation about its own commands;
--    each agent counted from its own last command there; with no command running, the agent that started the machine.
-- 6. Delivery by the folder drain's step, once the parent ended; a question no longer standing is suppressed, a gone
--    parent's undeliverable.
-- 7. Bounds, the longest question, the most commands listed, privileges and markers. The fixture is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Machine check-in: %', p_message; end if; end
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

-- The machine node and its executor, as 873 makes them: the node, its inventory, and a fresh ready observation.
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('98900000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','98900000-0000-4000-8000-000000000410','machineIdSha256',repeat('9',64),'observationId',extensions.gen_random_uuid(),
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
		'nodeId','98900000-0000-4000-8000-000000000410','machineIdSha256',repeat('9',64),'label','machine-989','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','98900000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('9',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('98900000-0000-4000-8000-000000000410',repeat('9',64),'machine','machine-989',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-989',repeat('9',64),true,jsonb_build_object('providerId','machine-989',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;

-- Ada's task machine, started by Ada's leased run in the conversation with the member, and given room on the node.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('98900000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-989',
	'Crawl the docs', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp());
select pg_temp.observe();
select public.qorpera_admit_executor_machines('mx-989', repeat('9', 64)) \g /dev/null

create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = '98900000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.placement() returns public.qorpera_company_machine_placements language sql as $$
	select * from public.qorpera_company_machine_placements where machine_id = '98900000-0000-4000-8000-0000000000a1' and removed_at is null
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
-- The executor's record of what it saw in boot b1 (or another boot): the ended commands, and whether the machine was busy.
create function pg_temp.record(p_ended jsonb, p_busy boolean, p_boot uuid default '98900000-0000-4000-8000-0000000000b1')
returns jsonb language sql as $$
	select pg_temp.custody('qorpera_record_company_machine_commands', format(', %L, %L, %L', p_boot, p_ended, p_busy))
$$;
-- The executor finds the machine busy in boot b1 now.
create function pg_temp.busy() returns void language plpgsql as $$
begin
	if pg_temp.record('[]', true) ->> 'state' is distinct from 'recorded' then
		raise exception 'Machine check-in: the busy look is recorded'; end if;
end $$;
create function pg_temp.command(p_n integer) returns uuid language sql as $$
	select ('98900000-0000-4000-8000-000000000' || lpad(p_n::text, 3, '0'))::uuid
$$;
-- A command as qorpera_authorize_machine_command records its start (Ada's, by Ada's run unless another is named).
create function pg_temp.started(p_n integer, p_head text, p_run uuid default '64800000-0000-4000-8000-0000000000f1',
	p_agent uuid default '64800000-0000-4000-8000-0000000000a1') returns void
language sql as $$
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		requested_by_user_id)
	values (pg_temp.command(p_n), '98900000-0000-4000-8000-0000000000a1', p_run, p_agent,
		(pg_temp.placement()).id, p_head, false, '64800000-0000-4000-8000-000000000002')
$$;
create function pg_temp.command_row(p_n integer) returns public.qorpera_company_machine_commands language sql as $$
	select * from public.qorpera_company_machine_commands where id = pg_temp.command(p_n)
$$;
-- A command the guest saw end.
create function pg_temp.ended(p_n integer) returns void language sql as $$
	update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded', exit_code = 0
	where id = pg_temp.command(p_n)
$$;
-- As if p_by passed: the machine's boots, its commands' starts and its questions' starts move back by p_by.
create function pg_temp.age(p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_placements set running_at = running_at - p_by
	where machine_id = '98900000-0000-4000-8000-0000000000a1' and running_at is not null;
	update public.qorpera_company_machine_commands set started_at = started_at - p_by
	where machine_id = '98900000-0000-4000-8000-0000000000a1';
	update public.qorpera_machine_checkins set since = since - p_by
	where machine_kind = 'machine' and subject_id = '98900000-0000-4000-8000-0000000000a1';
	set local session_replication_role = origin;
end $$;
create function pg_temp.ask() returns integer language sql as $$
	select public.qorpera_ask_busy_company_machines('64800000-0000-4000-8000-000000000020', 32)
$$;
create function pg_temp.due() returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_due(null, 100)
$$;
create function pg_temp.asked_again() returns boolean language plpgsql as $$
begin
	delete from public.qorpera_machine_checkins;
	return pg_temp.ask() > 0;
end $$;
-- The machine's latest question for a mark.
create function pg_temp.question(p_mark integer) returns public.qorpera_machine_checkins language sql as $$
	select * from public.qorpera_machine_checkins where machine_kind = 'machine' and subject_id = '98900000-0000-4000-8000-0000000000a1'
		and mark_hours = p_mark
	order by created_at desc limit 1
$$;

select pg_temp.check((pg_temp.placement()).id is not null and public.qorpera_company_machine_placement_reserved((pg_temp.placement()).id),
	'the machine has room on the node');
select pg_temp.check(pg_temp.custody('qorpera_mark_company_machine_running', format(', %L', '98900000-0000-4000-8000-0000000000b1'))
	->> 'state' = 'running', 'the machine runs in boot b1');
select pg_temp.started(1, 'python crawl.py');

-- 1. A busy look keeps when it found the machine busy. Never found busy, the machine is not asked about, however long.
begin;
select pg_temp.age('2 hours');
select pg_temp.check((pg_temp.machine()).busy_at is null and pg_temp.ask() = 0 and pg_temp.due() -> 'items' = '[]'::jsonb,
	'a machine never found busy is not asked about');
rollback;
select pg_temp.check(pg_temp.record('[]', false) ->> 'state' = 'recorded' and (pg_temp.machine()).busy_at is null,
	'a look that found the machine idle keeps no busy time');
select pg_temp.check(pg_temp.record('[]', true) ->> 'state' = 'recorded'
	and (pg_temp.machine()).busy_at > clock_timestamp() - interval '10 seconds', 'a busy look keeps when it found the machine busy');
select pg_temp.check(pg_temp.ask() = 0 and pg_temp.due() -> 'items' = '[]'::jsonb,
	'busy for under an hour since Ada started the crawl: nothing is due or asked');

-- 2. An hour later the company is due, and Ada is asked once, in the conversation that started the crawl.
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.due() = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('environment_id',
	'64800000-0000-4000-8000-000000000020')), 'has_more', false, 'next_after_environment_id', null),
	'the company with a machine busy for an hour is due: ' || pg_temp.due()::text);
select pg_temp.check(pg_temp.ask() = 1, 'an hour busy since Ada last worked with it, Ada is asked');
select pg_temp.check(pg_temp.ask() = 0, 'and only once per mark');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb,
	'asked, and while the run it goes to still runs, the company is not due: the question waits');
select pg_temp.check((select count(*) = 1 and bool_and(q.machine_kind = 'machine' and q.subject_id = (pg_temp.machine()).id
		and q.parent_run_id = (pg_temp.run()).id and q.staff_agent_id = (pg_temp.run()).staff_agent_id
		and q.profile_id = '64800000-0000-4000-8000-000000000010' and q.environment_id = '64800000-0000-4000-8000-000000000020'
		and q.mark_hours = 1 and q.since = (pg_temp.command_row(1)).started_at and q.delivery = 'waiting'
		and q.body = jsonb_build_object('machine', 'm-989', 'busyHours', 1, 'running', jsonb_build_array(jsonb_build_object(
			'command', 'python crawl.py', 'startedAt', (pg_temp.command_row(1)).started_at, 'commandId', pg_temp.command(1))), 'more', 0))
	from public.qorpera_machine_checkins q),
	'the question names the machine, the run that started the crawl, and the crawl with its handle: '
		|| (select jsonb_agg(to_jsonb(q)) from public.qorpera_machine_checkins q)::text);
select pg_temp.check(public.qorpera_machine_checkin_current(pg_temp.question(1)), 'the question stands while the machine stays busy');

-- 3. At three busy hours Ada is asked again, from the same start; the hour-one question no longer stands.
select pg_temp.age('2 hours');
select pg_temp.busy();
select pg_temp.check(pg_temp.ask() = 1, 'at three busy hours Ada is asked again');
select pg_temp.check((pg_temp.question(3)).since = (pg_temp.question(1)).since and (pg_temp.question(3)).body ->> 'busyHours' = '3',
	'from the same start, for the three-hour mark');
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(1))
	and public.qorpera_machine_checkin_current(pg_temp.question(3)), 'the hour-one question no longer stands; the latest does');

-- 4. What restarts the count, and who is not asked.
-- A new command of Ada's there is work with the machine, even once it ended.
begin;
select pg_temp.started(2, 'git status');
select pg_temp.ended(2);
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)),
	'a new command of the agent leaves the question standing no more');
select pg_temp.check(not pg_temp.asked_again(), 'and restarts the count');
rollback;
-- A new boot: the restart ends the crawl, the machine stays busy, and the count starts at the boot.
begin;
select pg_temp.check(pg_temp.custody('qorpera_mark_company_machine_running', format(', %L', '98900000-0000-4000-8000-0000000000b2'))
	->> 'state' = 'running', 'the machine restarted in boot b2');
select pg_temp.check(pg_temp.record('[]', true, '98900000-0000-4000-8000-0000000000b2') ->> 'state' = 'recorded'
	and (pg_temp.command_row(1)).ended_at is not null, 'busy in the new boot, with the crawl ended by the restart');
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)), 'a new boot leaves the question standing no more');
select pg_temp.check(not pg_temp.asked_again(), 'and restarts the count');
rollback;
begin;
update public.qorpera_company_machines set busy_at = clock_timestamp() - interval '2 minutes'
where id = '98900000-0000-4000-8000-0000000000a1';
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)),
	'a machine not found busy in the last 90 seconds leaves the question standing no more');
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb,
	'it is not asked about, and with no question waiting its company is not due');
rollback;
begin;
update public.qorpera_company_machines set lifetime = 'always-on' where id = '98900000-0000-4000-8000-0000000000a1';
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)) and not pg_temp.asked_again(),
	'an always-on machine is left to its weekly check-in');
rollback;
begin;
update public.qorpera_company_machines set desired_state = 'stopped', desired_by = 'member' where id = '98900000-0000-4000-8000-0000000000a1';
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)) and not pg_temp.asked_again(),
	'a machine wanted stopped is not asked about');
rollback;
begin;
update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
select pg_temp.check(not pg_temp.asked_again(), 'an archived agent is not asked');
rollback;
begin;
set local session_replication_role = replica;
delete from public.qorpera_company_files where environment_id = '64800000-0000-4000-8000-000000000020';
set local session_replication_role = origin;
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb,
	'a company not on the folder-v2 core is not asked about, nor due');
rollback;

-- 5. Who is asked.
-- A worker's command is asked about in the conversation that dispatched it. Ada's worker runs a deep crawl, and Ada's
-- own crawl ended.
begin;
do $$
declare v_run public.qorpera_execution_runs := pg_temp.run(); v_worker uuid := '98900000-0000-4000-8000-0000000009a1';
	v_worker_run uuid := '98900000-0000-4000-8000-0000000009a2';
begin
	-- The worker run is synthetic, as in 873: a copy of Ada's run outside any conversation, with a dispatch wake naming
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
	perform pg_temp.ended(1);
	perform pg_temp.started(3, 'python crawl.py --deep', v_worker_run);
	perform pg_temp.check((select c.run_id = v_worker_run and c.conversation_run_id = v_run.id from pg_temp.command_row(3) c),
		'a worker''s command belongs to the conversation that dispatched it');
end $$;
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.asked_again(), 'a worker''s busy command is asked about');
select pg_temp.check((select count(*) = 1 and bool_and(q.parent_run_id = (pg_temp.run()).id and q.mark_hours = 1
		and q.since = (pg_temp.command_row(3)).started_at
		and q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'python crawl.py --deep',
			'startedAt', (pg_temp.command_row(3)).started_at, 'commandId', pg_temp.command(3))))
	from public.qorpera_machine_checkins q), 'in the conversation that dispatched the worker, about the worker''s command');
rollback;
-- Each conversation is asked about its own commands. Another conversation's run (9b1) starts a build: that restarts the
-- count for both. An hour on, each conversation is asked about its own command; when the build ends, 9b1's question no
-- longer stands and the crawl's still does.
begin;
set local session_replication_role = replica;
insert into public.qorpera_execution_runs
select (jsonb_populate_record(pg_temp.run(), jsonb_build_object('id', '98900000-0000-4000-8000-0000000009b1',
	'job_id', extensions.gen_random_uuid(), 'source_id', extensions.gen_random_uuid(), 'session_id', '98900000-0000-4000-8000-0000000009b2'))).*;
set local session_replication_role = origin;
select pg_temp.started(4, 'npm run build', '98900000-0000-4000-8000-0000000009b1');
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(3)),
	'another conversation''s command is Ada''s work there too');
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.asked_again(), 'with a command of each conversation running, the machine is asked about');
select pg_temp.check((select count(*) = 2 and bool_and(q.mark_hours = 1 and q.since = (pg_temp.command_row(4)).started_at)
	from public.qorpera_machine_checkins q), 'each conversation is asked, counted from Ada''s last command');
select pg_temp.check((select q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'python crawl.py',
		'startedAt', (pg_temp.command_row(1)).started_at, 'commandId', pg_temp.command(1))) and (q.body ->> 'more')::integer = 0
	from public.qorpera_machine_checkins q where q.parent_run_id = (pg_temp.run()).id)
	and (select q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'npm run build',
		'startedAt', (pg_temp.command_row(4)).started_at, 'commandId', pg_temp.command(4))) and (q.body ->> 'more')::integer = 0
	from public.qorpera_machine_checkins q where q.parent_run_id = '98900000-0000-4000-8000-0000000009b1'),
	'each conversation is asked about its own command only');
select pg_temp.ended(4);
select pg_temp.check((select bool_and(public.qorpera_machine_checkin_current(q) = (q.parent_run_id = (pg_temp.run()).id))
	from public.qorpera_machine_checkins q), 'when the build ends, its question no longer stands; the crawl''s still does');
rollback;
-- Another agent on the same machine (any agent of the company may use it): Bea, a second agent with her own
-- conversation (9d1), starts the tests there while Ada's crawl runs. Each agent's count is its own: Bea's command leaves
-- Ada's question standing, and Bea is asked in her own conversation, counted from her own command. Once both commands
-- ended and the machine stays busy, the agent that started the machine is asked, counted from her own last command.
begin;
set local session_replication_role = replica;
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id)
values ('64800000-0000-4000-8000-000000000010', '98900000-0000-4000-8000-0000000009d0', 'Bea', 'Tests', 'Help.', 'native', 'round',
	'active', 'active', statement_timestamp(), statement_timestamp(), '64800000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_runs
select (jsonb_populate_record(pg_temp.run(), jsonb_build_object('id', '98900000-0000-4000-8000-0000000009d1',
	'job_id', extensions.gen_random_uuid(), 'source_id', extensions.gen_random_uuid(), 'session_id', '98900000-0000-4000-8000-0000000009d2',
	'staff_agent_id', '98900000-0000-4000-8000-0000000009d0'))).*;
set local session_replication_role = origin;
select pg_temp.started(6, 'npm test', '98900000-0000-4000-8000-0000000009d1', '98900000-0000-4000-8000-0000000009d0');
select pg_temp.check((pg_temp.command_row(6)).conversation_run_id = '98900000-0000-4000-8000-0000000009d1'
	and public.qorpera_machine_checkin_current(pg_temp.question(3)), 'another agent''s command leaves Ada''s question standing');
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.asked_again(), 'with both agents'' commands running, the machine is asked about');
select pg_temp.check((select count(*) = 2 from public.qorpera_machine_checkins q)
	and (select q.staff_agent_id = '64800000-0000-4000-8000-0000000000a1' and q.since = (pg_temp.command_row(1)).started_at
		and q.mark_hours = 3 and q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'python crawl.py',
			'startedAt', (pg_temp.command_row(1)).started_at, 'commandId', pg_temp.command(1)))
		from public.qorpera_machine_checkins q where q.parent_run_id = (pg_temp.run()).id)
	and (select q.staff_agent_id = '98900000-0000-4000-8000-0000000009d0' and q.since = (pg_temp.command_row(6)).started_at
		and q.mark_hours = 1 and q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'npm test',
			'startedAt', (pg_temp.command_row(6)).started_at, 'commandId', pg_temp.command(6)))
		from public.qorpera_machine_checkins q where q.parent_run_id = '98900000-0000-4000-8000-0000000009d1'),
	'Ada from her crawl, Bea in her own conversation from her own command: '
		|| (select jsonb_agg(to_jsonb(q)) from public.qorpera_machine_checkins q)::text);
select pg_temp.ended(1);
select pg_temp.ended(6);
select pg_temp.check(pg_temp.asked_again(), 'busy after both commands ended, the machine is asked about');
select pg_temp.check((select count(*) = 1 and bool_and(q.parent_run_id = (pg_temp.machine()).started_conversation_run_id
		and q.staff_agent_id = (pg_temp.machine()).started_by_staff_agent_id and q.since = (pg_temp.command_row(1)).started_at
		and q.body -> 'running' = '[]'::jsonb)
	from public.qorpera_machine_checkins q), 'the agent that started it is asked, counted from her own last command, not Bea''s: '
		|| (select jsonb_agg(to_jsonb(q)) from public.qorpera_machine_checkins q)::text);
rollback;
-- Busy outside its commands: the crawl ended and the machine stays busy (containers, a program left behind). Ada's
-- question still stands, from the same start; asked anew, the agent that started the machine is asked in the
-- conversation that started it, with nothing running.
begin;
select pg_temp.ended(1);
select pg_temp.check(public.qorpera_machine_checkin_current(pg_temp.question(3)),
	'the machine stays busy after the crawl ended: the question still stands');
select pg_temp.check(pg_temp.asked_again(), 'a machine busy outside its commands is asked about');
select pg_temp.check((select count(*) = 1 and bool_and(q.parent_run_id = (pg_temp.machine()).started_conversation_run_id
		and q.staff_agent_id = (pg_temp.machine()).started_by_staff_agent_id and q.since = (pg_temp.command_row(1)).started_at
		and q.body = jsonb_build_object('machine', 'm-989', 'busyHours', 3, 'running', '[]'::jsonb, 'more', 0))
	from public.qorpera_machine_checkins q), 'the agent that started it, in the conversation that started it, with nothing running');
rollback;

-- 6. Delivery, by the drain's step (as in 872). The company's login may pay for autonomous work: a check-in is paid as
--    the work that started it.
set session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connection_versions set allow_autonomous = true, authorization_state = 'active'
where connection_id = '64800000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
-- Ada's job ends, with the columns its state requires.
create function pg_temp.job_completed() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', lease_token_sha256 = null, lease_expires_at = null, result = '{}'::jsonb,
		finished_at = clock_timestamp()
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
end $$;
create function pg_temp.step() returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_company('64800000-0000-4000-8000-000000000020', 8)
$$;
-- The parent's check-in wakes, newest first; forget() removes them, as if each had run and ended.
create function pg_temp.wakes() returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin' order by created_at desc, id desc
$$;
create function pg_temp.forget() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin';
	set local session_replication_role = origin;
end $$;

-- While Ada's run still runs, its questions wait: the company is not due and its step is idle.
select pg_temp.busy();
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb and pg_temp.step() ->> 'state' = 'idle'
	and (pg_temp.question(1)).delivery = 'waiting' and (pg_temp.question(3)).delivery = 'waiting',
	'a running parent''s questions wait');
-- Once its job ended: due, and one wake carries the question that still stands into its conversation, with the crawl's
-- handle; the one a later mark replaced is suppressed.
select pg_temp.job_completed();
do $$
declare v_answer jsonb; v_wake public.qorpera_wake_occurrences;
begin
	if pg_temp.due() -> 'items' = '[]'::jsonb then raise exception 'Delivery: an ended parent''s company is due'; end if;
	v_answer := pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_wake.id is null or v_answer ->> 'state' <> 'done' or (v_answer ->> 'delivered')::integer <> 1
		or (v_answer ->> 'suppressed')::integer <> 1 or (v_answer ->> 'asked')::integer <> 0
		or v_wake.status <> 'queued' or v_wake.wake_kind <> 'agent' or v_wake.trigger_id <> 'machine-checkin'
		or v_wake.source_id <> (pg_temp.question(3)).id or v_wake.session_id <> (pg_temp.run()).session_id
		or v_wake.staff_agent_id <> (pg_temp.run()).staff_agent_id or v_wake.requested_by_user_id <> (pg_temp.run()).requested_by_user_id
		or v_wake.payload ->> 'schema' <> 'qorpera.machine-checkin/v1' or jsonb_array_length(v_wake.payload -> 'checkins') <> 1
		or v_wake.payload #>> '{checkins,0,checkinId}' <> (pg_temp.question(3)).id::text
		or v_wake.payload #>> '{checkins,0,machineKind}' <> 'machine'
		or ((v_wake.payload #> '{checkins,0}') - array['checkinId', 'machineKind', 'since', 'askedAt']) <> (pg_temp.question(3)).body
		or v_wake.payload #>> '{checkins,0,machine}' <> 'm-989'
		or v_wake.payload #>> '{checkins,0,running,0,commandId}' <> pg_temp.command(1)::text
		or (v_wake.payload ->> 'stillWaiting')::integer <> 0 or not public.qorpera_folder_wake_authorized(v_wake) then
		raise exception 'Delivery: one authorized wake with the standing question: % %', v_answer, to_jsonb(v_wake); end if;
	if (pg_temp.question(3)).delivery <> 'delivered' or (pg_temp.question(3)).occurrence_id <> v_wake.id
		or (pg_temp.question(1)).delivery <> 'suppressed' then
		raise exception 'Delivery: delivered by that wake, the replaced one suppressed'; end if;
	-- One continuation at a time: while it is queued, the parent is not asked through another.
	if pg_temp.step() ->> 'state' <> 'idle' then raise exception 'Delivery: one continuation per parent at a time'; end if;
end $$;
-- At seven busy hours the step asks, and the question waits behind the queued continuation. Once that ran, the machine
-- is no longer found busy: the question no longer stands and is suppressed.
select pg_temp.age('4 hours');
select pg_temp.busy();
do $$
declare v_answer jsonb := pg_temp.step();
begin
	if (v_answer ->> 'asked')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0
		or (pg_temp.question(7)).delivery is distinct from 'waiting' then
		raise exception 'Delivery: the step asks, and the new question waits: %', v_answer; end if;
	perform pg_temp.forget();
	update public.qorpera_company_machines set busy_at = clock_timestamp() - interval '2 minutes'
	where id = '98900000-0000-4000-8000-0000000000a1';
	v_answer := pg_temp.step();
	if (v_answer ->> 'suppressed')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0
		or (pg_temp.question(7)).delivery is distinct from 'suppressed' or exists (select 1 from pg_temp.wakes()) then
		raise exception 'Delivery: a question for a machine no longer busy is suppressed: %', v_answer; end if;
end $$;
-- A gone parent's question that still stands is undeliverable. Another run of Ada's (9c1), whose job is gone, started
-- the tests there; an hour on, both conversations are asked. The next step continues Ada's conversation, and the gone
-- one's question is undeliverable.
begin;
set local session_replication_role = replica;
insert into public.qorpera_execution_runs
select (jsonb_populate_record(pg_temp.run(), jsonb_build_object('id', '98900000-0000-4000-8000-0000000009c1',
	'job_id', extensions.gen_random_uuid(), 'source_id', extensions.gen_random_uuid()))).*;
set local session_replication_role = origin;
select pg_temp.started(5, 'make test', '98900000-0000-4000-8000-0000000009c1');
select pg_temp.age('61 minutes');
select pg_temp.busy();
do $$
declare v_answer jsonb := pg_temp.step();
begin
	if (v_answer ->> 'asked')::integer <> 2 or (v_answer ->> 'delivered')::integer <> 0 then
		raise exception 'Delivery: both conversations are asked: %', v_answer; end if;
	v_answer := pg_temp.step();
	if (v_answer ->> 'delivered')::integer <> 1 or (v_answer ->> 'undeliverable')::integer <> 1
		or (v_answer ->> 'suppressed')::integer <> 0 or (select q.delivery from public.qorpera_machine_checkins q
			where q.parent_run_id = '98900000-0000-4000-8000-0000000009c1') is distinct from 'undeliverable' then
		raise exception 'Delivery: a gone parent''s standing question is undeliverable: %', v_answer; end if;
end $$;
rollback;

-- 7. Bounds, the longest question, the most commands listed, privileges and markers.
select pg_temp.refused(format('select public.qorpera_ask_busy_company_machines(%L, %s)', bad.environment_id, bad.bound), '22023',
	'Machine check-in bound is invalid')
from (values ('64800000-0000-4000-8000-000000000020', '0'), ('64800000-0000-4000-8000-000000000020', '257'),
	('64800000-0000-4000-8000-000000000020', 'null'), (null, '32')) bad(environment_id, bound);
-- The longest question: a 40-character name, and ten commands of 300 control characters, each 6 bytes as JSON writes
-- it. Each is cut to 200 characters, as many listed as fit in 3000 bytes, the rest counted: well within 4096 bytes.
begin;
set local session_replication_role = replica;
update public.qorpera_company_machines set name = rpad('m-989-', 40, 'x') where id = '98900000-0000-4000-8000-0000000000a1';
set local session_replication_role = origin;
select pg_temp.ended(1);
select pg_temp.started(n, repeat(E'\x01', 300)) from generate_series(11, 20) n \g /dev/null
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.asked_again(), 'ten of the longest commands are asked about');
select pg_temp.check((select count(*) = 1 and bool_and(octet_length(q.body::text) <= 4096 and q.body ->> 'machine' = rpad('m-989-', 40, 'x')
		and jsonb_array_length(q.body -> 'running') = 2 and (q.body ->> 'more')::integer = 8
		and q.body #>> '{running,0,command}' = repeat(E'\x01', 200) and q.body #>> '{running,0,commandId}' = pg_temp.command(11)::text
		and q.body #>> '{running,1,commandId}' = pg_temp.command(12)::text)
	from public.qorpera_machine_checkins q),
	'the longest question fits, its commands cut and the rest counted: '
		|| (select string_agg(octet_length(q.body::text)::text || ' bytes, ' || (q.body ->> 'more') || ' more', '; ')
			from public.qorpera_machine_checkins q));
rollback;
-- Nine short commands: eight are listed, the ninth counted.
begin;
select pg_temp.ended(1);
select pg_temp.started(n, 'echo ' || n) from generate_series(21, 29) n \g /dev/null
select pg_temp.age('61 minutes');
select pg_temp.busy();
select pg_temp.check(pg_temp.asked_again(), 'nine short commands are asked about');
select pg_temp.check((select count(*) = 1 and bool_and(jsonb_array_length(q.body -> 'running') = 8 and (q.body ->> 'more')::integer = 1
		and q.body #>> '{running,0,commandId}' = pg_temp.command(21)::text and q.body #>> '{running,7,commandId}' = pg_temp.command(28)::text)
	from public.qorpera_machine_checkins q), 'eight are listed, the ninth counted: '
		|| (select jsonb_agg(q.body) from public.qorpera_machine_checkins q)::text);
rollback;
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_company_machine_busy_since(public.qorpera_company_machines)',
		'public.qorpera_company_machine_busy_checkins_unasked(uuid)', 'public.qorpera_ask_busy_company_machines(uuid,integer)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute')), 'only the platform runs the new functions');
select pg_temp.check(not exists (select 1 from unnest(array[
		'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)',
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)',
		'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'public.qorpera_folder_machine_checkins_company(uuid,integer)',
		'public.qorpera_company_machine_busy_since(public.qorpera_company_machines)',
		'public.qorpera_company_machine_busy_checkins_unasked(uuid)', 'public.qorpera_ask_busy_company_machines(uuid,integer)']) f(name)
	where position('20260930181000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or patched function names this migration');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the machine node and executor, then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_table record;
begin
	delete from public.qorpera_company_machine_container_stops where machine_id = '98900000-0000-4000-8000-0000000000a1';
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '98900000-0000-4000-8000-000000000410'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '98900000-0000-4000-8000-000000000410';
	delete from public.qorpera_machine_executors where owner = 'mx-989';
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
		or exists (select 1 from public.qorpera_machine_checkins where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '98900000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-989')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
