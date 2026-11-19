-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930747000 (agent-box B1): an agent's machine is ready and used again. On 924's base (Alice's live conversation
-- run, which acts as 628's agent does, and Bob's thread), with 1223's machine node and executor:
-- 1. A run that waited for its machine in place and sees it running is not woken to be told: the status look of a running
--    machine suppresses that run's own waiting 'running' events of that machine (its command events, another machine's,
--    another run's stay waiting); a look while it starts, or at a stopped machine, writes nothing; the run stays on the
--    machine's list until it runs, so a run whose wait ended first is told as before.
-- 2. A new task machine is the agent's own free machine of the same size, woken as a wake by name: the latest used of
--    them; its name and starter kept, the new purpose, the start's receipt; the answer says reused; a replay of the same
--    receipt answers the same machine; one taken by a live run is not taken again; with none free, a new machine as before.
-- 3. What fits: the same agent, member, size (at least the disk), task (an always-on ask makes a new machine); what is free:
--    not deleting, not starting for someone, no command running, no busy program, no member holding or sharing its
--    desktop, and no run that still goes started it, asked for it by machine_start (a wake by name too: the latest asker,
--    and every completed start that named it), ran a command on it or acted on its screen (a run that ended does not
--    count); the asked name first, a running one before an asleep one; a taken name of no free machine is refused as before.
-- 4. The helpers are internal (no API role), the columns are there, and every new or patched body carries the marker.
-- 5. Two connections: a command's authority that locks the machine and commits while a start that found it free waits
--    for its lock: the start looks again and takes the next machine (review r1 F1). What the test committed is removed.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'b1-ack') \g /dev/null

create function pg_temp.b1_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.b1_run() returns uuid language sql as $$ select (pg_temp.b1_binding() ->> 'runId')::uuid $$;
-- The member Alice's run works for.
create function pg_temp.b1_requester() returns uuid language sql as $$
	select (public.qorpera_describe_native_tool_authority(pg_temp.b1_binding()) #>> '{identity,requesterUserId}')::uuid
$$;
-- 628's machine_start: the exact envelope Alice's run hashes; authorize, begin the receipt, perform (twice when asked: a
-- replay inside the same operation), complete with the result as the runtime keeps it (cloud-native-tool-operations.ts:
-- the operation result, the answer its json content).
create function pg_temp.b1_start_envelope(p_key text, p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.b1_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
create function pg_temp.b1_start(p_key text, p_args jsonb, p_twice boolean default false,
	p_receipt uuid default extensions.gen_random_uuid()) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.b1_start_envelope(p_key, p_args);
	v_sha text := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'); v_result jsonb; v_again jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.b1_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.b1_binding(), p_receipt, 'machine_start:' || p_key, v_sha, repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.b1_binding(), v_envelope, 'begin', p_receipt, repeat('9', 64));
	if p_twice then
		v_again := public.qorpera_native_machine_start(pg_temp.b1_binding(), v_envelope, 'begin', p_receipt, repeat('9', 64));
		perform pg_temp.base_assert(v_again #>> '{machine,machineId}' = v_result #>> '{machine,machineId}'
			and v_again ->> 'reused' is not distinct from v_result ->> 'reused',
			'a replay of the same receipt answers the same machine: ' || v_result::text || ' then ' || v_again::text);
	end if;
	perform public.qorpera_complete_native_tool_operation(pg_temp.b1_binding(), p_receipt, v_sha,
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', v_sha,
			'content', jsonb_build_object('kind', 'json', 'value', v_result)));
	return v_result;
end
$$;
-- A new task machine as the runtime sends it (cloud-machine-tools.ts parseArguments): 2 cpus, 4 GiB, 40 GiB unless said.
create function pg_temp.b1_new(p_name text, p_cpus integer default 2, p_lifetime text default 'task', p_disk integer default 40)
returns jsonb language sql as $$
	select jsonb_build_object('name', p_name, 'purpose', 'Work for ' || p_name, 'cpus', p_cpus, 'memoryGiB', 2 * p_cpus,
		'diskGiB', p_disk, 'lifetime', p_lifetime)
$$;
create function pg_temp.b1_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.b1_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
create function pg_temp.b1_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12410000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12410000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
-- The node executor's pass, its custody to run, and the guest's mark of a boot: the machine runs.
create function pg_temp.b1_up(p_name text, p_boot uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.b1_observe();
	for attempt in 1..12 loop
		exit when (pg_temp.b1_placement(p_name)).id is not null;
		exit when public.qorpera_admit_executor_machines('mx-1241', repeat('c', 64), 16) = '[]'::jsonb;
	end loop;
	perform public.qorpera_authorize_executor_machine((pg_temp.b1_placement(p_name)).id, (pg_temp.b1_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.b1_placement(p_name)).binding), (pg_temp.b1_placement(p_name)).machine_id_sha256,
		'run');
	return public.qorpera_mark_company_machine_running((pg_temp.b1_placement(p_name)).id, (pg_temp.b1_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.b1_placement(p_name)).binding), (pg_temp.b1_placement(p_name)).machine_id_sha256,
		p_boot);
end
$$;
create function pg_temp.b1_status(p_name text) returns jsonb language sql as $$
	select public.qorpera_native_machine_manage(pg_temp.b1_binding(), jsonb_build_object('action', 'status', 'machine', p_name))
$$;
-- The delivery of each 'running' or 'command' event of a machine for a run, oldest first.
create function pg_temp.b1_events(p_name text, p_run uuid, p_kind text default 'running') returns text[] language sql as $$
	select coalesce(array_agg(event.delivery order by event.created_at, event.id), '{}') from public.qorpera_company_machine_events event
	where event.machine_id = (pg_temp.b1_machine(p_name)).id and event.parent_run_id = p_run and event.kind = p_kind
$$;
-- Moves a machine's columns as if time passed or others acted, without triggers or hints (1223's nc_shift).
create function pg_temp.b1_shift(p_name text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where name = %L and removed_at is null', p_set, p_name);
	set local session_replication_role = origin;
end
$$;
-- An agent's machine as the rows say, stopped on no node unless moved: Alice's for her member, no starter run (as a
-- member's start makes it), 2 cpus, 4 GiB, 40 GiB, a task, last used p_used ago.
create function pg_temp.b1_add(p_name text, p_used interval, p_set text default null) returns void language plpgsql as $$
begin
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
		desired_state, desired_by, last_used_at)
	values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_name,
		'Earlier work', '92400000-0000-4000-8000-000000000030', null, null, pg_temp.b1_requester(), 2,
		4294967296, 42949672960, 'standard', 'task', 'stopped', 'kernel', clock_timestamp() - p_used);
	if p_set is not null then perform pg_temp.b1_shift(p_name, p_set); end if;
end
$$;
-- The free machines of Alice's for a new 2 cpu task machine, in the order taken, as qorpera_company_machine_reusable
-- picks them one at a time (each pick rolled back).
create function pg_temp.b1_pick(p_args jsonb) returns text language plpgsql as $$
declare v_machine public.qorpera_company_machines;
begin
	v_machine := public.qorpera_company_machine_reusable(public.qorpera_describe_native_tool_authority(pg_temp.b1_binding()) -> 'identity',
		pg_temp.b1_run(), p_args);
	return v_machine.name;
end
$$;

-- 1223's node and executor: 8 cpus, 32 GiB, 300 GiB of disk.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-1241','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12410000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'label','machine-a','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12410000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.b1_observe();
	perform public.qorpera_enroll_runtime_node_provider('12410000-0000-4000-8000-000000000410', repeat('c',64), 'machine', 'machine-1241',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1241', repeat('c',64), true, v_policy, 322122547200);
end $$;

-- Bob's thread gets a post: his run is queued (a run that still goes), for another run's events and starts.
select set_config('qorpera_test.b1_bob', (select (pg_temp.base_materialize() -> 'run_ids' ->> 0)
	from (select pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Look at it.')) post),
	true) \g /dev/null

-- 1. A run that saw its machine running is not woken to be told -------------------------------------------------------------
do $$
declare v jsonb; v_bob uuid := current_setting('qorpera_test.b1_bob')::uuid; v_command uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_assert(v_bob is not null, '1: Bob''s run is there');
	-- Alice's new machine: nothing of hers to take again, so a new one, as before; she is on its list of runs to tell.
	v := pg_temp.b1_start('ready-1', pg_temp.b1_new('build-1'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'build-1' and not v ? 'reused'
		and (pg_temp.b1_machine('build-1')).notify_run_ids = array[pg_temp.b1_run()], '1: a new machine, Alice to tell: ' || v::text);
	-- A look while it starts writes nothing (there is no word yet), and she stays on the list.
	v := pg_temp.b1_status('build-1');
	perform pg_temp.base_assert(v #>> '{machine,state}' in ('waiting', 'starting')
		and (pg_temp.b1_machine('build-1')).notify_run_ids = array[pg_temp.b1_run()]
		and pg_temp.b1_events('build-1', pg_temp.b1_run()) = '{}', '1: a look while it starts: ' || v::text);
	-- Bob woke it too (as a wake by name puts him on the list).
	update public.qorpera_company_machines set notify_run_ids = notify_run_ids || v_bob where name = 'build-1' and removed_at is null;
	-- It runs: the kernel leaves a 'running' word for each run on the list.
	v := pg_temp.b1_up('build-1', '12410000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(v #>> '{machine,state}' = 'running' and pg_temp.b1_events('build-1', pg_temp.b1_run()) = '{waiting}'
		and pg_temp.b1_events('build-1', v_bob) = '{waiting}' and (pg_temp.b1_machine('build-1')).notify_run_ids = '{}',
		'1: running leaves a word for Alice and Bob: ' || v::text);
	-- Alice's command event on it (a command she started with notify that ended) waits as before.
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		requested_by_user_id, ended_at, state)
	values (v_command, (pg_temp.b1_machine('build-1')).id, pg_temp.b1_run(), '92400000-0000-4000-8000-000000000030',
		(pg_temp.b1_placement('build-1')).id, 'echo done', true, pg_temp.b1_requester(), clock_timestamp(), 'succeeded');
	insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind, command_id)
	values ((pg_temp.b1_machine('build-1')).id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.b1_run(), 'command', v_command);
	-- Her look in her wait sees it running: her 'running' word goes; Bob's and her command's stay.
	v := pg_temp.b1_status('build-1');
	perform pg_temp.base_assert(v #>> '{machine,state}' = 'running', '1: she sees it running: ' || v::text);
	perform pg_temp.base_assert(pg_temp.b1_events('build-1', pg_temp.b1_run()) = '{suppressed}'
		and pg_temp.b1_events('build-1', v_bob) = '{waiting}'
		and pg_temp.b1_events('build-1', pg_temp.b1_run(), 'command') = '{waiting}',
		'1: only her own running word is suppressed: ' || pg_temp.b1_events('build-1', pg_temp.b1_run())::text);
	-- Looking again changes nothing more.
	perform pg_temp.b1_status('build-1');
	perform pg_temp.base_assert(pg_temp.b1_events('build-1', pg_temp.b1_run()) = '{suppressed}'
		and pg_temp.b1_events('build-1', v_bob) = '{waiting}', '1: a second look');
end $$;

-- A word for her of another machine, and a look at a machine that does not run, stay as they were.
do $$
begin
	perform pg_temp.b1_add('asleep-1', interval '1 day', 'started_by_staff_agent_id = ''92400000-0000-4000-8000-000000000031''');
	insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind)
	values ((pg_temp.b1_machine('asleep-1')).id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.b1_run(), 'running');
	perform pg_temp.base_assert(pg_temp.b1_status('asleep-1') #>> '{machine,state}' = 'stopped'
		and pg_temp.b1_events('asleep-1', pg_temp.b1_run()) = '{waiting}', '1: a look at a stopped machine writes nothing');
	perform pg_temp.b1_status('build-1');
	perform pg_temp.base_assert(pg_temp.b1_events('asleep-1', pg_temp.b1_run()) = '{waiting}', '1: another machine''s word stays');
	delete from public.qorpera_company_machine_events where machine_id = (pg_temp.b1_machine('asleep-1')).id;
	delete from public.qorpera_company_machines where name = 'asleep-1';
end $$;

-- 2 and 3. Alice's own machines, as the rows say: which fit, which are free, in which order -----------------------------------
do $$
declare v_bob uuid := current_setting('qorpera_test.b1_bob')::uuid;
begin
	-- Free and fitting, asleep: the latest used comes first.
	perform pg_temp.b1_add('free-old', interval '3 days');
	perform pg_temp.b1_add('free-new', interval '2 hours');
	-- Not hers, not her member's, not the size, not a task, too small a disk, or being deleted.
	perform pg_temp.b1_add('bob-own', interval '1 minute', 'started_by_staff_agent_id = ''92400000-0000-4000-8000-000000000031''');
	perform pg_temp.b1_add('other-member', interval '1 minute', 'requested_by_user_id = ''92400000-0000-4000-8000-000000000002''');
	perform pg_temp.b1_add('bigger', interval '1 minute', 'cpus = 4, memory_bytes = 8589934592');
	perform pg_temp.b1_add('more-memory', interval '1 minute', 'memory_bytes = 8589934592');
	perform pg_temp.b1_add('always', interval '1 minute', 'lifetime = ''always-on''');
	perform pg_temp.b1_add('small-disk', interval '1 minute', 'disk_bytes = 21474836480');
	perform pg_temp.b1_add('deleting', interval '1 minute', 'desired_state = ''deleted''');
	-- Fitting but not free: a busy program, a member holding or sharing its desktop, a run to tell, a command running,
	-- a starter run that still goes (Bob's queued run).
	perform pg_temp.b1_add('busy', interval '1 minute', 'busy_at = clock_timestamp()');
	perform pg_temp.b1_add('held', interval '1 minute', format('desktop_member_user_id = %L, desktop_member_since = clock_timestamp(), '
		'desktop_member_until = clock_timestamp() + interval ''5 minutes''', '92400000-0000-4000-8000-000000000001'));
	perform pg_temp.b1_add('shared', interval '1 minute', format('desktop_shared_user_id = %L, desktop_shared_at = clock_timestamp() - interval ''1 minute''',
		'92400000-0000-4000-8000-000000000001'));
	perform pg_temp.b1_add('told', interval '1 minute', format('notify_run_ids = array[%L::uuid]', v_bob));
	perform pg_temp.b1_add('bob-started', interval '1 minute',
		format('started_by_run_id = %L, started_by_receipt_id = extensions.gen_random_uuid()', v_bob));
	-- A desktop shared 20 minutes ago, and a busy look 2 minutes ago, no longer count.
	perform pg_temp.b1_add('shared-long-ago', interval '4 days', format('desktop_shared_user_id = %L, desktop_shared_at = clock_timestamp() - interval ''20 minutes''',
		'92400000-0000-4000-8000-000000000001'));
	perform pg_temp.b1_add('busy-long-ago', interval '5 days', 'busy_at = clock_timestamp() - interval ''2 minutes''');
	-- The order: free-new, free-old, then the two that no longer count; nothing else.
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'free-new', '3: the latest used first: ' || coalesce(pg_temp.b1_pick(pg_temp.b1_new('x')), 'none'));
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '10 days' where name = 'free-new';
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'free-old', '3: then free-old');
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '11 days' where name = 'free-old';
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'shared-long-ago', '3: a desktop shared long ago is free');
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '12 days' where name = 'shared-long-ago';
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'busy-long-ago', '3: a busy look long ago is free');
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '13 days' where name = 'busy-long-ago';
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'free-new', '3: only those four: '
		|| coalesce(pg_temp.b1_pick(pg_temp.b1_new('x')), 'none'));
	-- The asked name first, among the free.
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('free-old')) = 'free-old', '3: the asked name first');
	-- The size: at least the disk asked, the same cpus and memory (4 cpus and 8 GiB is bigger, never more-memory's 2 and 8);
	-- an always-on ask takes none.
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x', 2, 'task', 30)) = 'free-new'
		and pg_temp.b1_pick(pg_temp.b1_new('x', 2, 'task', 41)) is null
		and pg_temp.b1_pick(pg_temp.b1_new('x', 4)) = 'bigger' and pg_temp.b1_pick(pg_temp.b1_new('x', 2, 'always-on')) is null,
		'3: the size and the lifetime');
	-- The kind of run: a worker's access must be the starter run's (none for a conversation's run and a member's start).
	perform pg_temp.base_assert(public.qorpera_company_machine_takeable(pg_temp.b1_machine('free-new'),
			public.qorpera_describe_native_tool_authority(pg_temp.b1_binding()) -> 'identity', pg_temp.b1_new('x'), null)
		and not public.qorpera_company_machine_takeable(pg_temp.b1_machine('free-new'),
			public.qorpera_describe_native_tool_authority(pg_temp.b1_binding()) -> 'identity', pg_temp.b1_new('x'), 'read'),
		'3: a worker''s run takes no machine a conversation''s run started');
	-- A starter run that ended does not count; one that still goes does.
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp()
	where id = (select job_id from public.qorpera_execution_runs where id = v_bob);
	set local session_replication_role = origin;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() where name = 'bob-started';
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: a starter run that ended does not count');
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'queued', result = null, finished_at = null
	where id = (select job_id from public.qorpera_execution_runs where id = v_bob);
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'free-new', '3: a queued starter run counts again');
end $$;

-- A command running (of a run that ended: a command keeps running after its turn), and a command or a screen action of a run
-- that still goes, on a running machine.
select set_config('qorpera_test.b1_cmd', extensions.gen_random_uuid()::text, true) \g /dev/null
do $$
declare v_command uuid := current_setting('qorpera_test.b1_cmd')::uuid; v_bob uuid := current_setting('qorpera_test.b1_bob')::uuid;
	v jsonb;
begin
	perform pg_temp.b1_add('run-free', interval '30 days');
	update public.qorpera_company_machines set desired_state = 'running', desired_by = 'agent', wanted_at = clock_timestamp()
	where name = 'run-free' and removed_at is null;
	perform pg_temp.base_assert(pg_temp.b1_up('run-free', '12410000-0000-4000-8000-0000000000b2') #>> '{machine,state}' = 'running',
		'3: run-free runs');
	-- Its boot moved its last use: back to 30 days, older than every asleep one.
	perform pg_temp.b1_shift('run-free', 'last_used_at = clock_timestamp() - interval ''30 days''');
	perform pg_temp.base_assert((pg_temp.b1_machine('run-free')).last_used_at < clock_timestamp() - interval '29 days', '3: run-free used long ago');
	-- A running one comes before an asleep one, however long ago it was used.
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'run-free', '3: running first');
	-- Bob's run ends (bob-started, used last, is free from now on); his command on run-free still runs: not free.
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp()
	where id = (select job_id from public.qorpera_execution_runs where id = v_bob);
	set local session_replication_role = origin;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		requested_by_user_id)
	values (v_command, (pg_temp.b1_machine('run-free')).id, v_bob, '92400000-0000-4000-8000-000000000031',
		(pg_temp.b1_placement('run-free')).id, 'sleep 60', false, pg_temp.b1_requester());
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: a command running');
	-- It ended, and his run ended: free.
	update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded' where id = v_command;
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'run-free', '3: a command of a run that ended');
	-- The same ended command as Alice's, whose run still goes: not free.
	update public.qorpera_company_machine_commands set run_id = pg_temp.b1_run(), staff_agent_id = '92400000-0000-4000-8000-000000000030'
	where id = v_command;
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: a command of a run that still goes');
	update public.qorpera_company_machine_commands set run_id = v_bob, staff_agent_id = '92400000-0000-4000-8000-000000000031'
	where id = v_command;
	-- Her screen action on it: not free.
	insert into public.qorpera_company_machine_screen_runs(placement_id, run_id, first_action_at)
	values ((pg_temp.b1_placement('run-free')).id, pg_temp.b1_run(), clock_timestamp());
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: a screen action of a run that still goes');
	delete from public.qorpera_company_machine_screen_runs where run_id = pg_temp.b1_run();
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'run-free', '3: and without it');
	-- She asks for it by name (a wake of a running machine: no word to tell, as a worker's wake never has one): it is her
	-- run's while her run goes, before any command (review r1 F2).
	v := pg_temp.b1_start('wake-run-free', jsonb_build_object('machine', 'run-free'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'run-free' and not v ? 'reused'
		and (pg_temp.b1_machine('run-free')).taken_by_run_id = pg_temp.b1_run()
		and (pg_temp.b1_machine('run-free')).notify_run_ids = '{}', '3: her wake by name: ' || v::text);
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: a wake by name of a run that still goes');
	-- A later wake by Bob's run (which ended): her completed wake still names it.
	perform pg_temp.b1_shift('run-free', format('taken_by_run_id = %L', v_bob));
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: an earlier wake of a run that still goes');
	-- Her wake as if its answer were not kept yet (its receipt names no machine): taken_by_run_id alone.
	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts set result = result #- '{content,value,machine}'
	where run_id = pg_temp.b1_run() and logical_operation_key = 'machine_start:wake-run-free';
	set local session_replication_role = origin;
	perform pg_temp.b1_shift('run-free', 'taken_by_run_id = ' || quote_literal(pg_temp.b1_run()));
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'bob-started', '3: taken by a run that still goes');
	perform pg_temp.b1_shift('run-free', 'taken_by_run_id = null');
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('x')) = 'run-free', '3: free again');
end $$;

-- 2. machine_start takes them, one start at a time ---------------------------------------------------------------------------
do $$
declare v jsonb; v_before public.qorpera_company_machines := pg_temp.b1_machine('run-free'); v_after public.qorpera_company_machines;
	v_count bigint := (select count(*) from public.qorpera_company_machines);
begin
	-- The running one, again: no boot, no word to tell (it runs); its name and starter kept; the new purpose; the receipt.
	v := pg_temp.b1_start('reuse-1', pg_temp.b1_new('market-research'), true);
	v_after := pg_temp.b1_machine('run-free');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'run-free' and v #>> '{machine,state}' = 'running'
		and v ->> 'reused' = 'your own free machine run-free of this size was given to you again instead of a new one: use the name run-free',
		'2: the running one again: ' || v::text);
	perform pg_temp.base_assert(v_after.purpose = 'Work for market-research' and v_after.started_by_run_id is null
		and v_after.started_by_receipt_id is null and v_after.reused_by_receipt_id is not null
		and v_after.notify_run_ids = '{}' and v_after.last_used_at > v_before.last_used_at
		and (select count(*) from public.qorpera_company_machines) = v_count, '2: kept, the new purpose, nothing made: ' || to_jsonb(v_after)::text);
	-- Taken by her live run: the next start takes the next, asleep (bob-started, used last; Bob's run ended above): woken
	-- as a wake by name, her on its list.
	v := pg_temp.b1_start('reuse-2', pg_temp.b1_new('report'), true);
	v_after := pg_temp.b1_machine('bob-started');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'bob-started' and v #>> '{machine,state}' in ('waiting', 'starting')
		and v ->> 'reused' like '%bob-started%' and v_after.desired_state = 'running' and v_after.desired_by = 'agent'
		and v_after.notify_run_ids = array[pg_temp.b1_run()], '2: an asleep one, woken: ' || v::text);
	-- Then the next, each taken once.
	v := pg_temp.b1_start('reuse-3', pg_temp.b1_new('notes'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'free-new', '2: then free-new: ' || v::text);
	v := pg_temp.b1_start('reuse-4', pg_temp.b1_new('notes-2'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'free-old', '2: then free-old: ' || v::text);
	v := pg_temp.b1_start('reuse-5', pg_temp.b1_new('notes-3'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'shared-long-ago', '2: then shared-long-ago: ' || v::text);
	v := pg_temp.b1_start('reuse-6', pg_temp.b1_new('notes-4'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'busy-long-ago', '2: then busy-long-ago: ' || v::text);
	-- None left free: a taken name of no free machine is refused as before, and a new name makes a new machine.
	v := pg_temp.b1_start('reuse-7', pg_temp.b1_new('bigger'));
	perform pg_temp.base_assert(v #>> '{refused,reason}' = 'MACHINE_NAME_TAKEN', '2: a taken name: ' || v::text);
	v := pg_temp.b1_start('reuse-8', pg_temp.b1_new('brand-new'), true);
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'brand-new' and not v ? 'reused'
		and (pg_temp.b1_machine('brand-new')).reused_by_receipt_id is null
		and (select count(*) from public.qorpera_company_machines) = v_count + 1, '2: a new machine: ' || v::text);
	-- An always-on ask makes a new machine (section 3: it takes none even when one is free).
	v := pg_temp.b1_start('reuse-9', pg_temp.b1_new('server', 2, 'always-on'));
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'server' and not v ? 'reused', '2: always-on is new: ' || v::text);
end $$;

-- 4. Internal helper, the column, the markers ------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_company_machine_reusable(jsonb,uuid,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_company_machine_reusable(jsonb,uuid,jsonb)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_company_machine_reusable(jsonb,uuid,jsonb)', 'execute'),
		'4: the helper is internal');
	perform pg_temp.base_assert(not has_function_privilege('anon',
			'public.qorpera_company_machine_takeable(public.qorpera_company_machines,jsonb,jsonb,text)', 'execute')
		and not has_function_privilege('authenticated',
			'public.qorpera_company_machine_takeable(public.qorpera_company_machines,jsonb,jsonb,text)', 'execute')
		and not has_function_privilege('service_role',
			'public.qorpera_company_machine_takeable(public.qorpera_company_machines,jsonb,jsonb,text)', 'execute'),
		'4: the predicate is internal');
	perform pg_temp.base_assert((select count(*) from pg_attribute where attrelid = 'public.qorpera_company_machines'::regclass
		and attname in ('reused_by_receipt_id', 'taken_by_run_id') and not attisdropped) = 2, '4: the columns');
end $$;

-- 5. A command authorized while a start looks (two connections; review r1 F1) -----------------------------------------------

-- A command's authority locks the machine, not the company's machines, so it can commit while a start that found the
-- machine free waits for the machine's lock: the start looks at it again once it holds it. Row and lock waits show only
-- across connections, so what this test made is committed here and removed again at the end, with 1223's harness (1203's,
-- 1106's, 467's and 674's): the test refuses to run beside other connections to this database. First Alice's run ends and
-- a new run of hers starts (her post, materialized and leased as 924's), so the earlier run's uses count no more: run-free
-- (running, Bob's ended command on it) is free and comes first, then build-1 (running too, used longer ago).
do $$
declare v_bob uuid := current_setting('qorpera_test.b1_bob')::uuid; v_wakes jsonb; v_pass jsonb;
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.b1_run());
	set local session_replication_role = origin;
	v_wakes := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', 'Another task.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, '5: her next run: ' || v_pass::text);
	perform set_config('qorpera_test.base_binding', pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid)::text, true);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(pg_temp.b1_binding(), 'progress', 'b1-ack-2');
	perform pg_temp.b1_shift('run-free', 'taken_by_run_id = null, reused_by_receipt_id = null');
	perform pg_temp.b1_shift('build-1', 'last_used_at = clock_timestamp() - interval ''40 days''');
	perform pg_temp.base_assert(pg_temp.b1_pick(pg_temp.b1_new('race')) = 'run-free', '5: run-free first for her new run');
	-- The start the second connection sends: its receipt begun here (committed with the rest).
	perform set_config('qorpera_test.b1_race_receipt', extensions.gen_random_uuid()::text, false);
	perform set_config('qorpera_test.b1_race_envelope', pg_temp.b1_start_envelope('race', pg_temp.b1_new('race')), false);
	perform public.qorpera_begin_native_tool_operation(pg_temp.b1_binding(), current_setting('qorpera_test.b1_race_receipt')::uuid,
		'machine_start:race', encode(extensions.digest(convert_to(current_setting('qorpera_test.b1_race_envelope'), 'UTF8'), 'sha256'), 'hex'),
		repeat('9', 64), false);
	perform set_config('qorpera_test.b1_race_binding', pg_temp.b1_binding()::text, false);
	perform set_config('qorpera_test.b1_race_placement', (pg_temp.b1_placement('run-free')).id::text, false);
	perform set_config('qorpera_test.b1_race_machine', (pg_temp.b1_machine('run-free')).id::text, false);
	perform set_config('qorpera_test.b1_race_bob', v_bob::text, false);
end $$;

select set_config('qorpera_test.b1_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('b1_holder', 'dbname=' || current_database());
select dblink_connect('b1_poll', 'dbname=' || current_database());
select set_config('qorpera_test.b1_' || name || '_pid', pid::text, false)
from unnest(array['holder','poll']) name, lateral dblink('b1_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.b1_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.b1_holder_pid'), current_setting('qorpera_test.b1_poll_pid'))) then
		raise exception 'The machine race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.b1_alone_in_database();
create temporary table b1_counts as select * from dblink('b1_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
create temporary table b1_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.b1_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.b1_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.b1_rows select v_table, kept.row_value
			from dblink('b1_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- The holder authorizes a command on run-free as qorpera_authorize_machine_command does (the machine's row locked, then the
-- command's row), Bob's ended run's, and keeps its transaction open; the other connection's start (her new run's, as the
-- service role) waits for the machine's lock; then the holder commits.
select dblink_exec('b1_poll', format('set request.jwt.claims = %L', '{"role":"service_role"}'));
create function pg_temp.b1_race() returns jsonb language plpgsql as $$
declare v_holder integer := current_setting('qorpera_test.b1_holder_pid')::integer;
	v_poll integer := current_setting('qorpera_test.b1_poll_pid')::integer; v_waited boolean := false; v_answer text;
	v_call text := format('select public.qorpera_native_machine_start(%L::jsonb, %L, %L, %L::uuid, %L)::text',
		current_setting('qorpera_test.b1_race_binding'), current_setting('qorpera_test.b1_race_envelope'), 'begin',
		current_setting('qorpera_test.b1_race_receipt'), repeat('9', 64));
begin
	perform dblink_exec('b1_holder', 'begin');
	perform 1 from dblink('b1_holder', format('select 1 from public.qorpera_company_machines where id = %L for update',
		current_setting('qorpera_test.b1_race_machine'))) as locked(one integer);
	perform dblink_exec('b1_holder', format('insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id,
		placement_id, command_head, notify, requested_by_user_id) values (extensions.gen_random_uuid(), %L, %L,
		%L, %L, %L, false, %L)', current_setting('qorpera_test.b1_race_machine'), current_setting('qorpera_test.b1_race_bob'),
		'92400000-0000-4000-8000-000000000031', current_setting('qorpera_test.b1_race_placement'), 'npm test',
		'92400000-0000-4000-8000-000000000001'));
	perform dblink_send_query('b1_poll', v_call);
	for attempt in 1..400 loop
		v_waited := v_holder = any(pg_blocking_pids(v_poll));
		exit when v_waited or dblink_is_busy('b1_poll') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('b1_holder', 'commit');
	select answer into v_answer from dblink_get_result('b1_poll') as call(answer text);
	perform * from dblink_get_result('b1_poll', false) as call(answer text);
	return jsonb_build_object('waited', v_waited, 'answer', v_answer::jsonb);
end $$;
do $$
declare v_race jsonb;
begin
	v_race := pg_temp.b1_race();
	perform pg_temp.base_assert((v_race ->> 'waited')::boolean and v_race #>> '{answer,machine,name}' = 'build-1'
			and v_race #>> '{answer,reused}' like '%build-1%',
		'5: the start waited for the command''s authority and took build-1, not run-free with its command running: ' || v_race::text);
end $$;

-- At the end: remove what the test committed, as 1223, 1203, 1106, 467 and 674 do.
do $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.b1_first_xid')::xid;
begin
	perform pg_temp.b1_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['b1_holder','b1_poll']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.b1_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.b1_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.b1_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.b1_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Machine race test cleanup left other row counts: %', v_wrong; end if;
end $$;
