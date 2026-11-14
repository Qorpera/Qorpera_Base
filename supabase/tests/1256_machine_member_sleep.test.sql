-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930759000: a machine that is awake only because a member woke it sleeps 10 minutes after that member is gone. On
-- 924's base (an owner, a contributor, a viewer, an admin and an outsider; agents Alice, Bob and Carol; Alice's live run,
-- which acts as 628's agent does) with 628's node: `carol-desktop`, a computer the owner made for Carol from the window
-- (no run started it); `m-1256`, a machine Alice's run started; `bob-desktop`, made for Bob and not come up yet.
-- 1. Awake only for a member: a member's computer is; an agent's machine is not; each agent's use since the member's
--    start ends it (a command that still runs, one started since, the screen, a going run that asked for it by
--    machine_start, took it again or started it), and the same use before that start does not; another start than a
--    member's, an always-on machine and one not wanted running are not.
-- 2. The member's last sign: each of the real member calls moves it (the wake, a confirmed look, a take-over, a shared
--    action, a pointer pass, turning the screen on); a look counts only for the window after the member's word, and a
--    watch that never said it is no sign; a take-over's heartbeat and a busy machine are no sign, though both move the
--    machine's last use.
-- 3. Due: not at 9 minutes 50 after the last sign, due at 10, by the executor's list and by the stop's custody, which
--    then stops it as the kernel (cause slept); not before the machine came up, and its 10 minutes start when it does; a
--    busy machine a run started, woken by a member who is gone, is due though its last use is now.
-- 4. Nothing else moved: an agent's machine keeps the hour (not due at 59 minutes, due at 61) whatever a member did
--    before; an always-on machine never sleeps on its own.
-- 5. The number: the node's setting moves it; who may set it and to what; the members' list of an agent's machines names
--    it for such a machine and null for every other.
-- 6. The grants, the markers, and every function that moves a machine's last use (a new one is looked at for this rule).

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'gm-ack') \g /dev/null

-- 628's agent, as 1223 drives it: the machine_start envelope Alice's run hashes, a start, a machine_run, a screen action.
create function pg_temp.gm_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.gm_start(p_key text, p_args jsonb, p_receipt uuid default extensions.gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_envelope text := jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.gm_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text;
	v_sha text := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.gm_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.gm_binding(), p_receipt, 'machine_start:' || p_key, v_sha, repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.gm_binding(), v_envelope, 'begin', p_receipt, repeat('9', 64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.gm_binding(), p_receipt, v_sha, v_result);
	return v_result;
end $$;
create function pg_temp.gm_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.gm_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
create function pg_temp.gm_run(p_receipt uuid, p_key text, p_machine text, p_head text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.gm_binding(), p_receipt, 'machine_run:' || p_key, repeat('a', 64),
		repeat('5', 64), false);
	v_result := public.qorpera_authorize_machine_command(pg_temp.gm_binding(),
		jsonb_build_object('machineId', (pg_temp.gm_machine(p_machine)).id), 'start', p_receipt, repeat('a', 64),
		jsonb_build_object('commandHead', p_head, 'notify', false));
	perform public.qorpera_complete_native_tool_operation(pg_temp.gm_binding(), p_receipt, repeat('a', 64), v_result);
	return v_result;
end $$;
create function pg_temp.gm_screen(p_receipt uuid, p_key text, p_machine text, p_action jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb; v_envelope text := jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
	'principals', (public.qorpera_describe_native_tool_authority(pg_temp.gm_binding()) -> 'identity')
		- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
	'operation', jsonb_build_object('tool', 'machine_screen', 'toolVersion', 'qorpera.machine-tools/v1', 'logicalOperationKey', p_key,
		'requiresCompanyRevision', false, 'arguments', jsonb_build_object('operationKey', p_key, 'machine', p_machine,
			'action', p_action, 'intent', 'Keep a note of it.'),
		'target', jsonb_build_object('realm', 'company_machine', 'machineId', (pg_temp.gm_machine(p_machine)).id)))::text;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.gm_binding(), p_receipt, 'machine_screen:' || p_key,
		encode(extensions.digest(v_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	v_result := public.qorpera_authorize_machine_screen(pg_temp.gm_binding(),
		jsonb_build_object('machineId', (pg_temp.gm_machine(p_machine)).id), p_receipt, v_envelope);
	perform public.qorpera_complete_native_tool_operation(pg_temp.gm_binding(), p_receipt,
		encode(extensions.digest(v_envelope, 'sha256'), 'hex'), '{}'::jsonb);
	return v_result;
end $$;
-- The executor's calls for a machine's placement: custody of a stop, the boot that came up, what a look saw.
create function pg_temp.gm_custody(p_name text, p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine((pg_temp.gm_placement(p_name)).id, (pg_temp.gm_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.gm_placement(p_name)).binding),
		(pg_temp.gm_placement(p_name)).machine_id_sha256, p_intent)
$$;
create function pg_temp.gm_running(p_name text, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running((pg_temp.gm_placement(p_name)).id, (pg_temp.gm_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.gm_placement(p_name)).binding),
		(pg_temp.gm_placement(p_name)).machine_id_sha256, p_boot)
$$;
create function pg_temp.gm_busy(p_name text, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_record_company_machine_commands((pg_temp.gm_placement(p_name)).id, (pg_temp.gm_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.gm_placement(p_name)).binding),
		(pg_temp.gm_placement(p_name)).machine_id_sha256, p_boot, '[]'::jsonb, true)
$$;
-- 628's node: a machine provider of 8 cpus and 32 GiB, its fresh observation, and an executor with 300 GiB of disk.
create function pg_temp.gm_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12560000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12560000-0000-4000-8000-000000000410','machineIdSha256',repeat('d',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
-- The node executor's pass, until the named machine is placed.
create function pg_temp.gm_place(p_name text) returns void language plpgsql as $$
begin
	perform pg_temp.gm_observe();
	for attempt in 1..12 loop
		exit when (pg_temp.gm_placement(p_name)).id is not null;
		exit when public.qorpera_admit_executor_machines('mx-1256', repeat('d', 64), 16) = '[]'::jsonb;
	end loop;
	if (pg_temp.gm_placement(p_name)).id is null then raise exception 'Machine member sleep: % was not placed', p_name; end if;
end $$;

-- A member's call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.gm_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.gm_try(text) to authenticated;
create function pg_temp.gm_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
-- A call as one member: its answer, or an exception when it did not answer.
create function pg_temp.gm_as(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.gm_user(p_who));
	set local role authenticated;
	v := pg_temp.gm_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	if v not like 'ok:%' then raise exception 'Machine member sleep: % as % answered %', p_sql, p_who, v; end if;
	return substring(v from 4)::jsonb;
end $$;
-- A member's call on a machine of the company: `p_call` is the function and what follows the machine's id.
create function pg_temp.gm_member(p_who text, p_function text, p_name text, p_rest text default '') returns jsonb language sql as $$
	select pg_temp.gm_as(p_who, format('select public.%s(%L, %L%s)', p_function, '92400000-0000-4000-8000-000000000010',
		(pg_temp.gm_machine(p_name)).id, p_rest))
$$;

-- Moves a machine's columns (as if time passed), without triggers or hints.
create function pg_temp.gm_shift(p_name text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, (pg_temp.gm_machine(p_name)).id);
	set local session_replication_role = origin;
end $$;
-- Everything a member did at a machine, its boot and its last use happened this long ago.
create function pg_temp.gm_quiet(p_name text, p_ago interval default '30 minutes') returns void language plpgsql as $$
declare v_id uuid := (pg_temp.gm_machine(p_name)).id; v_at timestamptz := clock_timestamp() - p_ago;
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machines set wanted_at = v_at, last_used_at = v_at,
		desktop_member_input_at = case when desktop_member_input_at is not null then v_at end,
		desktop_shared_at = case when desktop_shared_at is not null then v_at end
	where id = v_id;
	update public.qorpera_company_machine_placements set running_at = v_at where machine_id = v_id and running_at is not null;
	update public.qorpera_company_machine_screen_watches set last_look_at = v_at,
		confirmed_at = case when confirmed_at is not null then v_at end
	where machine_id = v_id;
	update public.qorpera_company_machine_desktop_pointers set begun_at = v_at where machine_id = v_id;
	update public.qorpera_company_machine_desktop_starts set begun_at = v_at where machine_id = v_id;
	set local session_replication_role = origin;
end $$;
-- Alice's run ended (only ever inside a block that is undone).
create function pg_temp.gm_alice_ended() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = (select run.job_id from public.qorpera_execution_runs run where run.id = (pg_temp.gm_binding() ->> 'runId')::uuid);
	set local session_replication_role = origin;
end $$;

-- What the rule says of a machine.
create function pg_temp.gm_only(p_name text) returns boolean language sql as $$
	select public.qorpera_company_machine_member_only(pg_temp.gm_machine(p_name))
$$;
create function pg_temp.gm_seen(p_name text) returns timestamptz language sql as $$
	select public.qorpera_company_machine_member_seen_at(pg_temp.gm_machine(p_name), interval '10 minutes')
$$;
-- Whether the executor's list says the machine is due to sleep.
create function pg_temp.gm_due(p_name text) returns boolean language sql as $$
	select (entry ->> 'sleepDue')::boolean
	from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1256', repeat('d', 64))) entry
	where entry ->> 'machineId' = (pg_temp.gm_machine(p_name)).id::text
$$;
-- What the stop's custody says, and nothing kept of it: its refusal, or 'agreed' with what the machine and its placement
-- then say.
create function pg_temp.gm_stop(p_name text) returns text language plpgsql as $$
declare v jsonb; v_said text;
begin
	begin
		v := pg_temp.gm_custody(p_name, 'stop');
		v_said := case when v ->> 'state' = 'refused' then v ->> 'reason'
			else format('agreed:%s:%s:%s', (pg_temp.gm_machine(p_name)).desired_state, (pg_temp.gm_machine(p_name)).desired_by,
				(pg_temp.gm_placement(p_name)).stop_cause) end;
		raise exception using errcode = 'P1256', message = v_said;
	exception when sqlstate 'P1256' then return sqlerrm;
	end;
end $$;
-- A moment within the last 5 seconds.
create function pg_temp.gm_now(p_at timestamptz) returns boolean language sql as $$
	select coalesce(p_at between clock_timestamp() - interval '5 seconds' and clock_timestamp(), false)
$$;
-- The members' list of an agent's machines, as one member: the named machine's entry.
create function pg_temp.gm_listed(p_who text, p_agent uuid, p_name text) returns jsonb language sql as $$
	select entry from jsonb_array_elements(pg_temp.gm_as(p_who, format('select public.qorpera_list_agent_machines(%L, %L)',
		'92400000-0000-4000-8000-000000000010', p_agent)) -> 'machines') entry where entry ->> 'name' = p_name
$$;

-- 628's node and executor: 8 cpus, 32 GiB, 300 GiB of disk.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-1256','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12560000-0000-4000-8000-000000000410','machineIdSha256',repeat('d',64),'label','machine-1256','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12560000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('d',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.gm_observe();
	perform public.qorpera_enroll_runtime_node_provider('12560000-0000-4000-8000-000000000410', repeat('d',64), 'machine', 'machine-1256',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1256', repeat('d',64), true, v_policy, 322122547200);
end $$;

-- The machines: a computer the owner made for Carol, come up in boot b1; Alice's own, come up in boot b2; a computer
-- the owner made for Bob, placed and not come up.
do $$
declare v jsonb;
begin
	v := pg_temp.gm_as('owner', format('select public.qorpera_member_start_agent_computer(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000032'));
	perform pg_temp.base_assert(v ->> 'state' = 'started' and v #>> '{machine,name}' = 'carol-desktop', '0: the owner made Carol''s computer: ' || v::text);
	perform pg_temp.gm_place('carol-desktop');
	perform pg_temp.base_assert(pg_temp.gm_running('carol-desktop', '12560000-0000-4000-8000-0000000000b1') ->> 'state' = 'running',
		'0: Carol''s computer came up');
	v := pg_temp.gm_start('gm-own', '{"name":"m-1256","purpose":"Builds the site.","cpus":2,"memoryGiB":4,"diskGiB":20,"lifetime":"task"}');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'm-1256', '0: Alice''s run started a machine: ' || v::text);
	perform pg_temp.gm_place('m-1256');
	perform pg_temp.base_assert(pg_temp.gm_running('m-1256', '12560000-0000-4000-8000-0000000000b2') ->> 'state' = 'running',
		'0: Alice''s machine came up');
	v := pg_temp.gm_as('owner', format('select public.qorpera_member_start_agent_computer(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000031'));
	perform pg_temp.base_assert(v ->> 'state' = 'started' and v #>> '{machine,name}' = 'bob-desktop', '0: the owner made Bob''s computer: ' || v::text);
	perform pg_temp.gm_place('bob-desktop');
	perform pg_temp.base_assert((pg_temp.gm_machine('carol-desktop')).desired_by = 'member'
		and (pg_temp.gm_machine('carol-desktop')).started_by_run_id is null and (pg_temp.gm_machine('m-1256')).desired_by = 'agent'
		and (pg_temp.gm_placement('bob-desktop')).running_at is null, '0: the three machines stand as told');
end $$;

-- 1. Awake only for a member -------------------------------------------------------------------------------------------------
do $$
declare v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop'), '1: a computer a member made is awake only for a member');
	perform pg_temp.base_assert(not pg_temp.gm_only('m-1256'), '1: a machine an agent started is not');
	perform pg_temp.base_assert(public.qorpera_company_machine_member_only(null) is false, '1: no machine is none');
	-- Another start than a member's, an always-on machine, one not wanted running, one removed.
	perform pg_temp.gm_quiet('carol-desktop');
	begin
		perform pg_temp.gm_shift('carol-desktop', $s$desired_by = 'agent'$s$);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'), '1: an agent''s start');
		perform pg_temp.gm_shift('carol-desktop', $s$desired_by = 'kernel'$s$);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'), '1: the kernel''s');
		perform pg_temp.gm_shift('carol-desktop', $s$desired_by = 'member', lifetime = 'always-on'$s$);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'), '1: an always-on machine');
		perform pg_temp.gm_shift('carol-desktop', $s$lifetime = 'task', desired_state = 'stopped'$s$);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop'), '1: one not wanted running');
		perform pg_temp.gm_shift('carol-desktop', $s$desired_state = 'running'$s$);
		perform pg_temp.base_assert(not public.qorpera_company_machine_member_only(jsonb_populate_record(
			pg_temp.gm_machine('carol-desktop'), jsonb_build_object('removed_at', clock_timestamp()))), '1: a removed one');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop') and pg_temp.gm_due('carol-desktop'),
		'1: put back, it is the member''s again, and due');

	-- An agent's command. One that still runs; one started since the member's start, ended; one started before it and
	-- ended does not count; one started before it that still runs does.
	begin
		v := pg_temp.gm_run('12560000-0000-4000-8000-0000000000c1', 'gm-cmd', 'carol-desktop', 'npm run dev');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized', '1: Alice''s run ran a command on it: ' || v::text);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'),
			'1: an agent''s command that runs');
		set local session_replication_role = replica;
		update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded', exit_code = 0
		where id = '12560000-0000-4000-8000-0000000000c1';
		set local session_replication_role = origin;
		perform pg_temp.gm_quiet('carol-desktop');
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'),
			'1: an agent''s command started since the member''s start, though it ended and the machine is quiet since');
		set local session_replication_role = replica;
		update public.qorpera_company_machine_commands set started_at = clock_timestamp() - interval '40 minutes',
			ended_at = clock_timestamp() - interval '35 minutes' where id = '12560000-0000-4000-8000-0000000000c1';
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop') and pg_temp.gm_due('carol-desktop'),
			'1: a command that started and ended before the member''s start is no use since');
		set local session_replication_role = replica;
		update public.qorpera_company_machine_commands set ended_at = null, state = null, exit_code = null
		where id = '12560000-0000-4000-8000-0000000000c1';
		set local session_replication_role = origin;
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'),
			'1: a command from before the member''s start that still runs');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;

	-- An agent at its screen: since the member's start it ends it; before, it does not.
	begin
		v := pg_temp.gm_screen('12560000-0000-4000-8000-0000000000f1', 'gm-key', 'carol-desktop', '{"type":"key","keys":["ctrl+s"]}');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and pg_temp.gm_now((pg_temp.gm_machine('carol-desktop')).screen_agent_used_at),
			'1: Alice''s run acted on its screen: ' || v::text);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'),
			'1: an agent at the screen since the member''s start');
		perform pg_temp.gm_quiet('carol-desktop');
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop'), '1: and still, half an hour on');
		perform pg_temp.gm_shift('carol-desktop', $s$screen_agent_used_at = wanted_at - interval '1 second'$s$);
		perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop') and pg_temp.gm_due('carol-desktop'),
			'1: an agent at the screen before the member''s start is no use since');
		perform pg_temp.gm_shift('carol-desktop', $s$screen_agent_used_at = wanted_at$s$);
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop'), '1: at the very start counts');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;

	-- A run that still goes asked for it by machine_start: the agent's until that run ends.
	begin
		v := pg_temp.gm_start('gm-wake', '{"machine":"carol-desktop"}');
		perform pg_temp.base_assert(v #>> '{machine,name}' = 'carol-desktop'
			and (pg_temp.gm_machine('carol-desktop')).taken_by_run_id = (pg_temp.gm_binding() ->> 'runId')::uuid
			and (pg_temp.gm_machine('carol-desktop')).desired_by = 'member', '1: Alice''s run asked for it by name: ' || v::text);
		perform pg_temp.gm_quiet('carol-desktop');
		perform pg_temp.base_assert(not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'),
			'1: a going run that asked for it');
		perform pg_temp.gm_alice_ended();
		perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop') and pg_temp.gm_due('carol-desktop'),
			'1: that run ended without using it: the member''s again');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- A run that still goes took it again (the receipt of a machine_start of its).
	begin
		perform pg_temp.gm_shift('carol-desktop', format('reused_by_receipt_id = %L', (select receipt.id
			from public.qorpera_run_operation_receipts receipt
			where receipt.run_id = (pg_temp.gm_binding() ->> 'runId')::uuid and receipt.logical_operation_key = 'machine_start:gm-own')));
		perform pg_temp.base_assert((pg_temp.gm_machine('carol-desktop')).reused_by_receipt_id is not null
			and not pg_temp.gm_only('carol-desktop') and not pg_temp.gm_due('carol-desktop'), '1: a going run that took it again');
		perform pg_temp.gm_alice_ended();
		perform pg_temp.base_assert(pg_temp.gm_only('carol-desktop'), '1: until that run ends');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- A run that still goes started it: Alice's machine, stopped and woken by a member, is hers while her run goes.
	perform pg_temp.gm_member('owner', 'qorpera_member_manage_company_machine', 'm-1256', $s$, 'stop'$s$);
	perform pg_temp.gm_member('owner', 'qorpera_member_manage_company_machine', 'm-1256', $s$, 'start'$s$);
	perform pg_temp.base_assert((pg_temp.gm_machine('m-1256')).desired_by = 'member' and (pg_temp.gm_machine('m-1256')).desired_state = 'running'
		and pg_temp.gm_now((pg_temp.gm_machine('m-1256')).wanted_at), '1: the owner woke Alice''s machine');
	perform pg_temp.gm_quiet('m-1256');
	perform pg_temp.base_assert(not pg_temp.gm_only('m-1256') and not pg_temp.gm_due('m-1256'), '1: a going run that started it');
	begin
		perform pg_temp.gm_alice_ended();
		perform pg_temp.base_assert(pg_temp.gm_only('m-1256') and pg_temp.gm_due('m-1256'), '1: once that run ended it is the member''s');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
end $$;

-- 2. The member's last sign --------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_seat bigint;
begin
	-- The wake is one: Carol's computer, quiet for half an hour, was last seen then.
	perform pg_temp.gm_quiet('carol-desktop');
	perform pg_temp.base_assert(pg_temp.gm_seen('carol-desktop') = (pg_temp.gm_machine('carol-desktop')).wanted_at
		and pg_temp.gm_due('carol-desktop'), '2: the wake is the first sign');
	perform pg_temp.base_assert(pg_temp.gm_now(pg_temp.gm_seen('m-1256')) is false
		and pg_temp.gm_seen('m-1256') = (pg_temp.gm_machine('m-1256')).wanted_at, '2: a member''s wake of Alice''s machine too');

	-- A look, with the member's word that they watch (a viewer watches too).
	begin
		v := pg_temp.gm_member('viewer', 'qorpera_member_machine_screen_begin', 'carol-desktop', $s$, '{"confirmed": true}'$s$);
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now(pg_temp.gm_seen('carol-desktop'))
			and not pg_temp.gm_due('carol-desktop') and pg_temp.gm_stop('carol-desktop') = 'MACHINE_IN_USE', '2: a confirmed look: ' || v::text);
		-- The looks go on in a tab nobody touches: they count for the window after the member's word, no longer.
		set local session_replication_role = replica;
		update public.qorpera_company_machine_screen_watches set confirmed_at = clock_timestamp() - interval '19 minutes 50 seconds'
		where machine_id = (pg_temp.gm_machine('carol-desktop')).id;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.gm_seen('carol-desktop') between clock_timestamp() - interval '10 minutes'
				and clock_timestamp() - interval '9 minutes 45 seconds' and not pg_temp.gm_due('carol-desktop'),
			'2: a look counts until the window after the member''s word, though it was made now');
		set local session_replication_role = replica;
		update public.qorpera_company_machine_screen_watches set confirmed_at = clock_timestamp() - interval '20 minutes'
		where machine_id = (pg_temp.gm_machine('carol-desktop')).id;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.gm_now((select max(last_look_at) from public.qorpera_company_machine_screen_watches
				where machine_id = (pg_temp.gm_machine('carol-desktop')).id)) and pg_temp.gm_due('carol-desktop'),
			'2: a tab nobody touched for 10 minutes no longer counts, and 10 minutes on the machine is due under its looks');
		-- A watch that never said it is no sign.
		set local session_replication_role = replica;
		update public.qorpera_company_machine_screen_watches set confirmed_at = null
		where machine_id = (pg_temp.gm_machine('carol-desktop')).id;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.gm_seen('carol-desktop') = (pg_temp.gm_machine('carol-desktop')).wanted_at
			and pg_temp.gm_due('carol-desktop'), '2: a watch that never said it watches is no sign');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- A look whose word is false leaves the last sign where it was.
	begin
		v := pg_temp.gm_member('admin', 'qorpera_member_machine_screen_begin', 'carol-desktop', $s$, '{"confirmed": false}'$s$);
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_due('carol-desktop'), '2: an unconfirmed look: ' || v::text);
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;

	-- An action on the desktop shared with the agent.
	begin
		v := pg_temp.gm_member('contributor', 'qorpera_member_machine_desktop_share_begin', 'carol-desktop',
			format($s$, '{"type": "click", "x": 4, "y": 4}', %s$s$, (pg_temp.gm_machine('carol-desktop')).desktop_member_generation));
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now(pg_temp.gm_seen('carol-desktop'))
			and not pg_temp.gm_due('carol-desktop'), '2: a shared action: ' || v::text);
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- The pointer over the desktop.
	begin
		v := pg_temp.gm_member('owner', 'qorpera_member_machine_desktop_pointer_begin', 'carol-desktop',
			format(', %s, null, null', (pg_temp.gm_machine('carol-desktop')).desktop_member_generation));
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now(pg_temp.gm_seen('carol-desktop'))
			and not pg_temp.gm_due('carol-desktop'), '2: a pointer pass: ' || v::text);
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- The screen turned on.
	begin
		v := pg_temp.gm_member('admin', 'qorpera_member_machine_desktop_start_begin', 'carol-desktop');
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now(pg_temp.gm_seen('carol-desktop'))
			and not pg_temp.gm_due('carol-desktop'), '2: the screen turned on: ' || v::text);
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- Private typing: the take-over is a sign; its heartbeat is none, though it moves the machine's last use.
	begin
		v := pg_temp.gm_member('owner', 'qorpera_member_take_machine_desktop', 'carol-desktop',
			format(', 0, %L', '12560000-0000-4000-8000-0000000000e1'));
		v_seat := (v ->> 'seat')::bigint;
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now(pg_temp.gm_seen('carol-desktop'))
			and not pg_temp.gm_due('carol-desktop'), '2: a take-over: ' || v::text);
		perform pg_temp.gm_quiet('carol-desktop', '20 minutes');
		perform pg_temp.base_assert(pg_temp.gm_due('carol-desktop'), '2: 20 minutes after the take-over''s last input it is due');
		v := pg_temp.gm_member('owner', 'qorpera_member_keep_machine_desktop', 'carol-desktop', format(', 0, %s', v_seat));
		perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.gm_now((pg_temp.gm_machine('carol-desktop')).last_used_at)
			and not pg_temp.gm_now(pg_temp.gm_seen('carol-desktop')) and pg_temp.gm_due('carol-desktop')
			and pg_temp.gm_stop('carol-desktop') = 'agreed:stopped:kernel:slept',
			'2: a heartbeat moves the last use and is no sign: ' || v::text);
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- A busy machine: no sign either (a machine no run started keeps its last use too, 20260930730000).
	begin
		perform pg_temp.base_assert(pg_temp.gm_busy('carol-desktop', '12560000-0000-4000-8000-0000000000b1') ->> 'state' = 'recorded'
			and pg_temp.gm_now((pg_temp.gm_machine('carol-desktop')).busy_at) and pg_temp.gm_due('carol-desktop'),
			'2: a busy desktop is no sign');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
end $$;

-- 3. Due ---------------------------------------------------------------------------------------------------------------------
do $$
begin
	-- 10 minutes, by the list and by the stop's custody, which stops it as the kernel does an idle machine.
	perform pg_temp.gm_quiet('carol-desktop', '9 minutes 50 seconds');
	perform pg_temp.base_assert(not pg_temp.gm_due('carol-desktop') and pg_temp.gm_stop('carol-desktop') = 'MACHINE_IN_USE',
		'3: not due 9 minutes 50 after the last sign');
	perform pg_temp.gm_quiet('carol-desktop', '10 minutes');
	perform pg_temp.base_assert(pg_temp.gm_due('carol-desktop') and pg_temp.gm_stop('carol-desktop') = 'agreed:stopped:kernel:slept',
		'3: due at 10 minutes, and its stop is the kernel''s: ' || pg_temp.gm_stop('carol-desktop'));
	perform pg_temp.base_assert((pg_temp.gm_machine('carol-desktop')).last_used_at > clock_timestamp() - interval '1 hour',
		'3: while the hour alone would keep it');
	perform pg_temp.base_assert(public.qorpera_company_machine_member_sleep_due(pg_temp.gm_machine('carol-desktop'),
			(pg_temp.gm_placement('carol-desktop')).running_at, 600)
		and not public.qorpera_company_machine_member_sleep_due(pg_temp.gm_machine('carol-desktop'),
			(pg_temp.gm_placement('carol-desktop')).running_at, 660)
		and not public.qorpera_company_machine_member_sleep_due(pg_temp.gm_machine('carol-desktop'), null, 600)
		and not public.qorpera_company_machine_member_sleep_due(pg_temp.gm_machine('carol-desktop'),
			(pg_temp.gm_placement('carol-desktop')).running_at, null), '3: the seconds decide, and a machine that has not come up is never due by it');

	-- Bob's computer has not come up: the member rule waits; its 10 minutes start when it does.
	perform pg_temp.gm_quiet('bob-desktop');
	perform pg_temp.base_assert(pg_temp.gm_only('bob-desktop') and not pg_temp.gm_due('bob-desktop'), '3: not before it came up');
	perform pg_temp.base_assert(pg_temp.gm_running('bob-desktop', '12560000-0000-4000-8000-0000000000b3') ->> 'state' = 'running'
		and not pg_temp.gm_due('bob-desktop'), '3: come up now, half an hour after its wake, it has its 10 minutes');
	set local session_replication_role = replica;
	update public.qorpera_company_machine_placements set running_at = clock_timestamp() - interval '10 minutes'
	where id = (pg_temp.gm_placement('bob-desktop')).id;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '10 minutes'
	where id = (pg_temp.gm_machine('bob-desktop')).id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.gm_due('bob-desktop'), '3: and is due 10 minutes after it came up with nobody there');

	-- A busy page on a machine a run started, woken by a member who is gone: its last use is now, and it is due.
	begin
		perform pg_temp.gm_alice_ended();
		perform pg_temp.gm_quiet('m-1256');
		perform pg_temp.base_assert(pg_temp.gm_busy('m-1256', '12560000-0000-4000-8000-0000000000b2') ->> 'state' = 'recorded'
			and pg_temp.gm_now((pg_temp.gm_machine('m-1256')).last_used_at) and pg_temp.gm_now((pg_temp.gm_machine('m-1256')).busy_at),
			'3: the executor saw Alice''s machine busy, and its last use moved');
		perform pg_temp.base_assert(pg_temp.gm_due('m-1256') and pg_temp.gm_stop('m-1256') = 'agreed:stopped:kernel:slept',
			'3: busy with the member gone, it is due all the same: ' || pg_temp.gm_stop('m-1256'));
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
end $$;

-- 4. Nothing else moved ------------------------------------------------------------------------------------------------------
do $$
begin
	-- An agent's machine keeps the hour: Alice's, as her run started it (the member's wake undone), whatever a member did.
	begin
		perform pg_temp.gm_shift('m-1256', $s$desired_by = 'agent'$s$);
		perform pg_temp.gm_member('viewer', 'qorpera_member_machine_screen_begin', 'm-1256', $s$, '{"confirmed": true}'$s$);
		perform pg_temp.gm_quiet('m-1256', '59 minutes');
		perform pg_temp.base_assert(not pg_temp.gm_due('m-1256') and pg_temp.gm_stop('m-1256') = 'MACHINE_IN_USE',
			'4: an agent''s machine is not due at 59 minutes, with every member sign as old');
		perform pg_temp.gm_quiet('m-1256', '61 minutes');
		perform pg_temp.base_assert(pg_temp.gm_due('m-1256') and pg_temp.gm_stop('m-1256') = 'agreed:stopped:kernel:slept',
			'4: and due at 61, as before');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- A member's machine an agent used keeps the hour too.
	begin
		perform pg_temp.gm_screen('12560000-0000-4000-8000-0000000000f2', 'gm-key-2', 'carol-desktop', '{"type":"key","keys":["ctrl+s"]}');
		perform pg_temp.gm_quiet('carol-desktop', '59 minutes');
		perform pg_temp.base_assert(not pg_temp.gm_due('carol-desktop'), '4: a member''s machine an agent used is not due at 59 minutes');
		perform pg_temp.gm_quiet('carol-desktop', '61 minutes');
		perform pg_temp.base_assert(pg_temp.gm_due('carol-desktop'), '4: and due at 61');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
	-- An always-on machine never sleeps on its own, a member's start or not.
	begin
		perform pg_temp.gm_shift('carol-desktop', $s$lifetime = 'always-on'$s$);
		perform pg_temp.gm_quiet('carol-desktop', '3 hours');
		perform pg_temp.base_assert(not pg_temp.gm_due('carol-desktop') and pg_temp.gm_stop('carol-desktop') = 'MACHINE_IN_USE',
			'4: an always-on machine is untouched');
		raise sqlstate 'P1256';
	exception when sqlstate 'P1256' then null;
	end;
end $$;

-- 5. The number --------------------------------------------------------------------------------------------------------------
do $$
declare v_carol jsonb; v_alice jsonb;
begin
	perform pg_temp.base_assert((select member_sleep_after_seconds = 600 and sleep_after_seconds = 3600
		from public.qorpera_machine_executors where owner = 'mx-1256'), '5: 600 seconds by default, beside the hour');
	-- The members' list names it for a machine that is awake only for a member, to every member who reads the company.
	v_carol := pg_temp.gm_listed('viewer', '92400000-0000-4000-8000-000000000032', 'carol-desktop');
	v_alice := pg_temp.gm_listed('owner', '92400000-0000-4000-8000-000000000030', 'm-1256');
	perform pg_temp.base_assert(v_carol -> 'memberSleepSeconds' = '600'::jsonb and v_carol ->> 'state' = 'running',
		'5: the list names the seconds for Carol''s computer: ' || v_carol::text);
	perform pg_temp.base_assert(v_alice ? 'memberSleepSeconds' and v_alice -> 'memberSleepSeconds' = 'null'::jsonb,
		'5: and null for Alice''s machine, hers while her run goes: ' || v_alice::text);
	perform pg_temp.base_assert(public.qorpera_company_machine_member_sleep_seconds(extensions.gen_random_uuid()) is null,
		'5: no machine has none');
	-- The node's setting moves it.
	perform pg_temp.gm_quiet('carol-desktop', '6 minutes');
	perform pg_temp.base_assert(not pg_temp.gm_due('carol-desktop'), '5: 6 minutes is not 10');
	perform public.qorpera_configure_machine_member_sleep('mx-1256', 300);
	perform pg_temp.base_assert(pg_temp.gm_due('carol-desktop') and pg_temp.gm_stop('carol-desktop') = 'agreed:stopped:kernel:slept'
		and pg_temp.gm_listed('owner', '92400000-0000-4000-8000-000000000032', 'carol-desktop') -> 'memberSleepSeconds' = '300'::jsonb,
		'5: set to 300 seconds, 6 minutes is due, and the list says 300');
	-- A look counts for the window of that setting after the member's word.
	perform pg_temp.gm_member('viewer', 'qorpera_member_machine_screen_begin', 'carol-desktop', $s$, '{"confirmed": true}'$s$);
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set confirmed_at = clock_timestamp() - interval '10 minutes'
	where machine_id = (pg_temp.gm_machine('carol-desktop')).id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.gm_due('carol-desktop'), '5: the look''s window follows the setting');
	perform public.qorpera_configure_machine_member_sleep('mx-1256', 600);
	perform pg_temp.base_assert(not pg_temp.gm_due('carol-desktop'), '5: set back, the same look counts');
	-- Who may set it, and to what.
	perform pg_temp.base_error($sql$select public.qorpera_configure_machine_member_sleep('mx-1256', 59)$sql$, '22023',
		'Machine member sleep is invalid');
	perform pg_temp.base_error($sql$select public.qorpera_configure_machine_member_sleep('mx-1256', 604801)$sql$, '22023',
		'Machine member sleep is invalid');
	perform pg_temp.base_error($sql$select public.qorpera_configure_machine_member_sleep('mx-1256', null)$sql$, '22023',
		'Machine member sleep is invalid');
	perform pg_temp.base_error($sql$select public.qorpera_configure_machine_member_sleep('mx-none', 600)$sql$, '42501',
		'Machine executor unavailable');
	perform pg_temp.base_error($sql$update public.qorpera_machine_executors set member_sleep_after_seconds = 30 where owner = 'mx-1256'$sql$,
		'23514');
	perform pg_temp.base_claims('authenticated', pg_temp.gm_user('owner'));
	perform pg_temp.base_error($sql$select public.qorpera_configure_machine_member_sleep('mx-1256', 600)$sql$, '42501',
		'Machine operator authority required');
	perform pg_temp.base_claims('service_role');
end $$;

-- 6. The grants, the markers, and what moves a machine's last use ------------------------------------------------------------
do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_company_machine_member_only(public.qorpera_company_machines)',
		'public.qorpera_company_machine_member_seen_at(public.qorpera_company_machines,interval)',
		'public.qorpera_company_machine_member_sleep_due(public.qorpera_company_machines,timestamptz,integer)',
		'public.qorpera_company_machine_member_sleep_seconds(uuid)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_function, 'execute')
			and not has_function_privilege('authenticated', v_function, 'execute')
			and not has_function_privilege('service_role', v_function, 'execute')
			and not has_function_privilege('qorpera_secret_broker', v_function, 'execute'), '6: no role calls ' || v_function);
	end loop;
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_configure_machine_member_sleep(text,integer)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_configure_machine_member_sleep(text,integer)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_configure_machine_member_sleep(text,integer)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_configure_machine_member_sleep(text,integer)', 'execute'),
		'6: the service role alone sets the number');
	perform pg_temp.base_assert((select array_agg(distinct proc.proname::text order by proc.proname::text)
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930759000') > 0) = array[
			'qorpera_authorize_executor_machine', 'qorpera_company_machine_member_only', 'qorpera_company_machine_member_seen_at',
			'qorpera_company_machine_member_sleep_due', 'qorpera_company_machine_member_sleep_seconds',
			'qorpera_configure_machine_member_sleep', 'qorpera_list_agent_machines', 'qorpera_list_executor_machines'],
		'6: the marker''s bodies');
	-- The patched bodies keep their own markers and their old test.
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure),
			'(machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds)') > 0
		and strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure), '20260930739000') > 0
		and strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure),
			'(v_machine.last_used_at > clock_timestamp() - make_interval(secs => v_executor.sleep_after_seconds)') > 0
		and strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure), '20260930744000') > 0,
		'6: the patched bodies keep what they had');
	-- Every function that moves a machine's last use. The member rule reads the member's signs from the rows these write,
	-- not from the last use: a NEW function here that is a member's sign must write a row that
	-- qorpera_company_machine_member_seen_at reads (or be added to it), or a member who is there is taken for gone. Look at
	-- it for that, then list it here.
	perform pg_temp.base_assert((select array_agg(distinct proc.proname::text order by proc.proname::text)
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and proc.prosrc ~ 'qorpera_company_machines' and proc.prosrc ~ 'last_used_at\s*=') = array[
			'qorpera_admit_company_machine', 'qorpera_authorize_machine_command', 'qorpera_authorize_machine_screen',
			'qorpera_mark_company_machine_running', 'qorpera_member_keep_machine_desktop', 'qorpera_member_machine_desktop_act_begin',
			'qorpera_member_machine_desktop_pointer_authority', 'qorpera_member_machine_desktop_share_begin',
			'qorpera_member_machine_desktop_start_begin', 'qorpera_member_machine_screen_authority',
			'qorpera_member_manage_company_machine', 'qorpera_member_take_machine_desktop', 'qorpera_native_machine_start',
			'qorpera_record_company_machine_commands'],
		'6: a function that moves a machine''s last use is new or gone: see the note above this check (20260930759000): '
			|| (select string_agg(distinct proc.proname::text, ', ' order by proc.proname::text)
				from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
				where namespace.nspname = 'public' and proc.prosrc ~ 'qorpera_company_machines' and proc.prosrc ~ 'last_used_at\s*='));
end $$;

rollback;
