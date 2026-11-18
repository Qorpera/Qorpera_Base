-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930730000: a member starts a desktop computer for an agent that has none. On 924's base (an owner, a contributor, a
-- viewer, an admin and an outsider; agents Alice, Bob and Carol; Alice's live run, which acts as 628's agent does), with
-- agents of every state added by hand:
-- 1. who may: owners, admins and contributors; a viewer, an outsider and an unknown agent are refused; no machine without
--    a node (MACHINES_UNAVAILABLE), and nothing is kept;
-- 2. the row, column by column, is what Alice's own machine_start with desktop true and its defaults makes (2 cpus, 4 GiB,
--    40 GiB, task, through the same admission), except who asked and the run; it waits in line, as a member's wake does
--    (only the service role reserves room on a node), and the node executor's own pass places it at its size; a node too
--    small for it refuses (MACHINE_TOO_LARGE) and keeps nothing;
-- 3. the name: the agent's, made a machine name, with "-desktop", a number when taken, Danish letters spelt plain;
-- 4. the agent's states: archived or deleted (AGENT_UNAVAILABLE), nothing made; lifecycle_state is not read (every agent the
--    company folder hires stays 'setup');
-- 5. idempotence: an existing machine of the agent's big enough for a desktop (started by it, or its screen driven by it
--    last) is answered and nothing is made; a small one or one being deleted is not;
-- 6. the floor: one new computer per agent a minute;
-- 7. every reader of a machine no run started: the conversation trigger, the view, a session's machines, the operators'
--    compute requests, machine_start by name, machine_run, machine_screen, stop and delete by an agent, the folder view
--    and its live run, the busy and always-on check-ins, the stop record;
-- 8. the save check through such a machine's folder view: every run with a command or a screen action on its disk (its
--    placement), checked as a starter is, whether its command or its run still goes on or not; a disk no run acted on
--    checks nothing more; a look records nothing; an earlier placement's disk is not this one; the start's answer is
--    always a machine the window's list holds;
-- 9. the idle rule: busy moves such a machine's last use only while a command whose conversation is asked runs on it;
-- 10. the null-together check, the grants and the markers;
-- 11. two sessions at once make one computer (two connections; what the test committed is removed at the end).

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'nc-ack') \g /dev/null

-- 628's agent: the exact machine_start envelope Alice's run hashes, a start and a machine_run, its machines by name.
create function pg_temp.mc_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.mc_start_envelope(p_key text, p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.mc_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',p_args,'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text
$$;
create function pg_temp.mc_start(p_key text, p_args jsonb, p_receipt uuid default extensions.gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_envelope text := pg_temp.mc_start_envelope(p_key, p_args);
	v_sha text := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.mc_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.mc_binding(), p_receipt, 'machine_start:' || p_key, v_sha, repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.mc_binding(), v_envelope, 'begin', p_receipt, repeat('9', 64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.mc_binding(), p_receipt, v_sha, v_result);
	return v_result;
end
$$;
-- A machine_run, by Alice's run unless another run's binding is named.
create function pg_temp.mc_run(p_receipt uuid, p_key text, p_machine text, p_head text, p_binding jsonb default null)
returns jsonb language plpgsql as $$
declare v_result jsonb; v_binding jsonb := coalesce(p_binding, pg_temp.mc_binding());
begin
	perform public.qorpera_begin_native_tool_operation(v_binding, p_receipt, 'machine_run:' || p_key, repeat('a', 64), repeat('5', 64), false);
	v_result := public.qorpera_authorize_machine_command(v_binding, jsonb_build_object('machineId', (pg_temp.mc_machine(p_machine)).id),
		'start', p_receipt, repeat('a', 64), jsonb_build_object('commandHead', p_head, 'notify', false));
	perform public.qorpera_complete_native_tool_operation(v_binding, p_receipt, repeat('a', 64), v_result);
	return v_result;
end
$$;
-- A machine_screen action by Alice's run (1198's envelope): its receipt begun, the executor's read, the receipt completed.
create function pg_temp.mc_screen(p_receipt uuid, p_key text, p_machine text, p_action jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb; v_envelope text := jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
	'principals', (public.qorpera_describe_native_tool_authority(pg_temp.mc_binding()) -> 'identity')
		- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
	'operation', jsonb_build_object('tool', 'machine_screen', 'toolVersion', 'qorpera.machine-tools/v1', 'logicalOperationKey', p_key,
		'requiresCompanyRevision', false, 'arguments', jsonb_build_object('operationKey', p_key, 'machine', p_machine,
			'action', p_action, 'intent', 'Keep a note of it.'),
		'target', jsonb_build_object('realm', 'company_machine', 'machineId', (pg_temp.mc_machine(p_machine)).id)))::text;
begin
	perform public.qorpera_begin_native_tool_operation(pg_temp.mc_binding(), p_receipt, 'machine_screen:' || p_key,
		encode(extensions.digest(v_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	v_result := public.qorpera_authorize_machine_screen(pg_temp.mc_binding(), jsonb_build_object('machineId', (pg_temp.mc_machine(p_machine)).id),
		p_receipt, v_envelope);
	perform public.qorpera_complete_native_tool_operation(pg_temp.mc_binding(), p_receipt, encode(extensions.digest(v_envelope, 'sha256'), 'hex'),
		'{}'::jsonb);
	return v_result;
end
$$;
create function pg_temp.mc_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.mc_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
create function pg_temp.mc_custody(p_name text, p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine((pg_temp.mc_placement(p_name)).id, (pg_temp.mc_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.mc_placement(p_name)).binding), (pg_temp.mc_placement(p_name)).machine_id_sha256, p_intent)
$$;
create function pg_temp.mc_running(p_name text, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running((pg_temp.mc_placement(p_name)).id, (pg_temp.mc_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.mc_placement(p_name)).binding), (pg_temp.mc_placement(p_name)).machine_id_sha256, p_boot)
$$;
create function pg_temp.mc_record(p_name text, p_boot uuid, p_busy boolean) returns jsonb language sql as $$
	select public.qorpera_record_company_machine_commands((pg_temp.mc_placement(p_name)).id, (pg_temp.mc_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.mc_placement(p_name)).binding), (pg_temp.mc_placement(p_name)).machine_id_sha256,
		p_boot, '[]'::jsonb, p_busy)
$$;
-- 628's node: a machine provider of 8 cpus and 32 GiB on a node, its fresh observation, and an executor with 300 GiB of disk.
create function pg_temp.mc_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12230000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12230000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;

-- Every member call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.nc_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.nc_try(text) to authenticated;
create function pg_temp.nc_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
create function pg_temp.nc_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.nc_agent(p_name text) returns uuid language sql immutable as $$
	select case p_name when 'alice' then '92400000-0000-4000-8000-000000000030' when 'bob' then '92400000-0000-4000-8000-000000000031'
		when 'carol' then '92400000-0000-4000-8000-000000000032' when 'dora' then '12230000-0000-4000-8000-0000000000d1'
		when 'ezra' then '12230000-0000-4000-8000-0000000000d2' when 'finn' then '12230000-0000-4000-8000-0000000000d3'
		when 'soren' then '12230000-0000-4000-8000-0000000000d4' when 'gus' then '12230000-0000-4000-8000-0000000000d5'
		else '12230000-0000-4000-8000-0000000000ff' end::uuid
$$;
-- A member's start of a computer for an agent, as that member.
create function pg_temp.nc_start(p_who text, p_agent text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user(p_who));
	set local role authenticated;
	v := pg_temp.nc_try(format('select public.qorpera_member_start_agent_computer(%L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.nc_agent(p_agent)));
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.nc_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'refused', 'reason', p_reason)::text
$$;
-- The machines started for (or by) an agent.
create function pg_temp.nc_count(p_agent text) returns bigint language sql as $$
	select count(*) from public.qorpera_company_machines where started_by_staff_agent_id = pg_temp.nc_agent(p_agent)
$$;
-- The node executor's pass (qorpera_admit_executor_machines, as every executor runs it), until the named machine is placed.
create function pg_temp.nc_place(p_name text) returns jsonb language plpgsql as $$
declare v jsonb; v_all jsonb := '[]';
begin
	perform pg_temp.mc_observe();
	for attempt in 1..12 loop
		exit when (pg_temp.mc_placement(p_name)).id is not null;
		v := public.qorpera_admit_executor_machines('mx-1223', repeat('c', 64), 16);
		v_all := v_all || v;
		exit when v = '[]'::jsonb;
	end loop;
	return v_all;
end $$;
-- Moves a machine's columns (as if time passed), without triggers or hints.
create function pg_temp.nc_shift(p_name text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, (pg_temp.mc_machine(p_name)).id);
	set local session_replication_role = origin;
end $$;

-- Agents of every state, beside 924's three (hired by the company folder: lifecycle_state 'setup', as every such agent):
-- Dora active in both fields (the desktop registry's lifecycle_state 'active'), Ezra archived, Finn deleted, Søren and Gus.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color,
	appearance_shape, employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id, deleted_at,
	deleted_by_user_id)
select '92400000-0000-4000-8000-000000000010', agent.id, agent.name, 'Research', 'Test.', 'blue', 'round', agent.employment,
	agent.lifecycle, statement_timestamp(), statement_timestamp(), '92400000-0000-4000-8000-000000000001', agent.deleted,
	case when agent.deleted is not null then '92400000-0000-4000-8000-000000000001'::uuid end
from (values
	('12230000-0000-4000-8000-0000000000d1'::uuid, 'Dora', 'active', 'active', null::timestamptz),
	('12230000-0000-4000-8000-0000000000d2', 'Ezra', 'archived', 'active', null),
	('12230000-0000-4000-8000-0000000000d3', 'Finn', 'active', 'active', statement_timestamp()),
	('12230000-0000-4000-8000-0000000000d4', 'Søren Ærø (Å/QA)!', 'active', 'active', null),
	('12230000-0000-4000-8000-0000000000d5', 'Gus', 'active', 'active', null)
) as agent(id, name, employment, lifecycle, deleted);
select set_config('session_replication_role', 'origin', true);

-- 1. Who may, and nothing without a node ------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(pg_temp.nc_start('viewer', 'carol') = '42501:Company is unavailable', '1: a viewer');
	perform pg_temp.base_assert(pg_temp.nc_start('outsider', 'carol') = '42501:Company is unavailable', '1: an outsider');
	perform pg_temp.base_assert(pg_temp.nc_start('owner', 'nobody') = '42501:Agent is unavailable', '1: an unknown agent');
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('owner'));
	perform pg_temp.base_error($sql$select public.qorpera_member_start_agent_computer(null, '92400000-0000-4000-8000-000000000032')$sql$,
		'22023', 'Computer start is invalid');
	perform pg_temp.base_claims('service_role');
	-- No node runs machines yet: refused as machine_start is, and nothing kept.
	perform pg_temp.base_assert(pg_temp.nc_start('owner', 'carol') = pg_temp.nc_refused('MACHINES_UNAVAILABLE')
		and pg_temp.nc_count('carol') = 0, '1: no node: ' || pg_temp.nc_start('owner', 'carol'));
end $$;

-- 628's node and executor: 8 cpus, 32 GiB, 300 GiB of disk.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-1223','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12230000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'label','machine-a','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12230000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.mc_observe();
	perform public.qorpera_enroll_runtime_node_provider('12230000-0000-4000-8000-000000000410', repeat('c',64), 'machine', 'machine-1223',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1223', repeat('c',64), true, v_policy, 322122547200);
end $$;

-- 2. The row, as Alice's own machine_start with desktop true and its defaults makes it -------------------------------------
do $$
declare v_member jsonb; v_agent jsonb; v_answer jsonb; v_placed jsonb; v_too_large text; v_waiting boolean; v_pass jsonb;
	-- Who asked and the run: the only columns that differ, beside the id, name, purpose and times.
	c_differ constant text[] := array['id', 'name', 'purpose', 'started_by_run_id', 'started_by_receipt_id', 'requested_by_user_id',
		'desired_by', 'notify_run_ids', 'started_conversation_run_id', 'started_session_id', 'wanted_at', 'last_used_at', 'created_at',
		'updated_at'];
begin
	perform pg_temp.mc_observe();
	-- The contributor's press for Alice, kept only for the comparison.
	begin
		v_answer := pg_temp.nc_answer(pg_temp.nc_start('contributor', 'alice'));
		v_member := to_jsonb(pg_temp.mc_machine('alice-desktop'));
		v_waiting := (pg_temp.mc_placement('alice-desktop')).id is null;
		v_pass := pg_temp.nc_place('alice-desktop');
		v_placed := jsonb_build_object('state', public.qorpera_company_machine_state(pg_temp.mc_machine('alice-desktop')),
			'cpus', (pg_temp.mc_placement('alice-desktop')).binding -> 'cpus',
			'memory', (pg_temp.mc_placement('alice-desktop')).binding -> 'memoryBytes',
			'disk', (pg_temp.mc_placement('alice-desktop')).binding -> 'rootDiskBytes');
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	-- What the runtime sends for machine_start {desktop: true} with every default (cloud-machine-tools.ts parseArguments).
	begin
		perform pg_temp.mc_start('nc-own', '{"name":"alice-own","purpose":"A desktop.","cpus":2,"memoryGiB":4,"diskGiB":40,"lifetime":"task"}');
		v_agent := to_jsonb(pg_temp.mc_machine('alice-own'));
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	perform pg_temp.base_assert(v_answer ->> 'state' = 'started' and v_answer #>> '{machine,name}' = 'alice-desktop'
			and v_answer #>> '{machine,state}' = 'waiting' and v_answer #>> '{machine,machineId}' = v_member ->> 'id',
		'2: started: ' || coalesce(v_answer::text, 'null'));
	perform pg_temp.base_assert(v_member - c_differ = v_agent - c_differ,
		'2: column by column as the agent''s own start: ' || (v_member - c_differ)::text || ' vs ' || (v_agent - c_differ)::text);
	perform pg_temp.base_assert(v_member ->> 'cpus' = '2' and v_member ->> 'memory_bytes' = '4294967296'
			and v_member ->> 'disk_bytes' = '42949672960' and v_member ->> 'lifetime' = 'task' and v_member ->> 'image' = 'standard'
			and v_member ->> 'desired_state' = 'running' and v_member ->> 'started_by_staff_agent_id' = pg_temp.nc_agent('alice')::text,
		'2: the size of a desktop computer, the agent''s: ' || v_member::text);
	perform pg_temp.base_assert(v_member ->> 'started_by_run_id' is null and v_member ->> 'started_by_receipt_id' is null
			and v_member ->> 'requested_by_user_id' = pg_temp.nc_user('contributor')::text and v_member ->> 'desired_by' = 'member'
			and v_member -> 'notify_run_ids' = '[]'::jsonb
			and v_member ->> 'purpose' = 'Desktop computer started by Member from the computer window.'
			and v_agent ->> 'started_by_run_id' is not null and v_agent ->> 'desired_by' = 'agent',
		'2: who asked: the member, no run: ' || v_member::text);
	-- It waits in line, and the node executor's next pass places it at its own size, as any wanted machine.
	perform pg_temp.base_assert(v_waiting and v_pass = jsonb_build_array(v_member ->> 'id')
			and v_placed = jsonb_build_object('state', 'starting', 'cpus', 2, 'memory', 4294967296, 'disk', 42949672960),
		'2: placed by the node''s pass: ' || v_pass::text || ' ' || v_placed::text);
	-- A node too small for a desktop computer: refused as machine_start is, and nothing kept.
	begin
		update public.qorpera_runtime_node_providers set cpu_millis = 1000 where provider_id = 'machine-1223';
		v_too_large := pg_temp.nc_start('owner', 'alice');
		perform pg_temp.base_assert(v_too_large = pg_temp.nc_refused('MACHINE_TOO_LARGE') and pg_temp.nc_count('alice') = 0,
			'2: too large: ' || v_too_large);
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
end $$;

-- 3. The name, and the window's list -------------------------------------------------------------------------------------------
-- An agent's small machine named carol-desktop takes the name: Carol's computer is carol-desktop-2. Søren's name is spelt
-- plain. Bob's computer, by the owner, shows in the window's list as a desktop computer of his.
do $$
declare v text; v_list jsonb;
begin
	perform pg_temp.mc_observe();
	perform pg_temp.mc_start('nc-small', '{"name":"carol-desktop","purpose":"Checks pages.","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}');
	v := pg_temp.nc_start('contributor', 'carol');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) #>> '{machine,name}' = 'carol-desktop-2', '3: a number when taken: ' || v);
	v := pg_temp.nc_start('admin', 'soren');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) #>> '{machine,name}' = 'soeren-aeroe-aa-qa-desktop', '3: Danish letters: ' || v);
	v := pg_temp.nc_start('owner', 'bob');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) #>> '{machine,name}' = 'bob-desktop'
			and (pg_temp.mc_machine('bob-desktop')).requested_by_user_id = pg_temp.nc_user('owner')
			and (pg_temp.mc_machine('bob-desktop')).purpose = 'Desktop computer started by '
				|| public.qorpera_review_member_name('92400000-0000-4000-8000-000000000010', pg_temp.nc_user('owner'))
				|| ' from the computer window.',
		'3: Bob''s, the owner''s name in its purpose: ' || v || ' ' || to_jsonb(pg_temp.mc_machine('bob-desktop'))::text
			|| (select string_agg(display_name, ',') from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'));
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('viewer'));
	v_list := public.qorpera_list_agent_machines('92400000-0000-4000-8000-000000000010', pg_temp.nc_agent('bob'));
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(jsonb_array_length(v_list -> 'machines') = 1 and v_list #>> '{machines,0,name}' = 'bob-desktop'
			and (v_list #>> '{machines,0,desktopCapable}')::boolean and (v_list #>> '{machines,0,startedByAgent}')::boolean,
		'3: the window lists it, a desktop computer of Bob''s: ' || v_list::text);
end $$;

-- 4. The agent's states: nothing made ---------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(pg_temp.nc_start('owner', 'ezra') = pg_temp.nc_refused('AGENT_UNAVAILABLE'), '4: archived');
	perform pg_temp.base_assert(pg_temp.nc_start('owner', 'finn') = pg_temp.nc_refused('AGENT_UNAVAILABLE'), '4: deleted');
	perform pg_temp.base_assert(pg_temp.nc_count('ezra') + pg_temp.nc_count('finn') = 0, '4: nothing made');
	-- lifecycle_state tells nothing: Carol (the company folder's 'setup') and Dora ('active') both get one.
	perform pg_temp.base_assert((select lifecycle_state from public.qorpera_profile_staff where staff_agent_id = pg_temp.nc_agent('carol'))
		= 'setup', '4: a hired agent stays setup');
	perform pg_temp.mc_observe();
	perform pg_temp.base_assert(pg_temp.nc_answer(pg_temp.nc_start('owner', 'dora')) ->> 'state' = 'started', '4: Dora gets one');
end $$;

-- 5. Idempotence --------------------------------------------------------------------------------------------------------------
do $$
declare v text; v_bob uuid := (pg_temp.mc_machine('bob-desktop')).id; v_alice uuid;
begin
	-- Bob's again, by another member: his, nothing new.
	v := pg_temp.nc_start('admin', 'bob');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) ->> 'state' = 'existing' and pg_temp.nc_answer(v) #>> '{machine,machineId}' = v_bob::text
		and pg_temp.nc_count('bob') = 1, '5: Bob''s own: ' || v);
	-- An agent's desktop whose screen Gus drove last is his.
	perform pg_temp.mc_observe();
	perform pg_temp.mc_start('nc-gus', '{"name":"shared-desk","purpose":"Shared.","cpus":2,"memoryGiB":4,"diskGiB":40,"lifetime":"task"}');
	v_alice := (pg_temp.mc_machine('shared-desk')).id;
	perform pg_temp.nc_shift('shared-desk', format('screen_staff_agent_id = %L, screen_used_at = clock_timestamp()', pg_temp.nc_agent('gus')));
	v := pg_temp.nc_start('owner', 'gus');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) ->> 'state' = 'existing' and pg_temp.nc_answer(v) #>> '{machine,machineId}' = v_alice::text
		and pg_temp.nc_count('gus') = 0, '5: the desktop Gus drove: ' || v);
	-- One being deleted is not: a new one.
	perform pg_temp.nc_shift('shared-desk', 'desired_state = ''deleted''');
	v := pg_temp.nc_start('owner', 'gus');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) ->> 'state' = 'started' and pg_temp.nc_answer(v) #>> '{machine,name}' = 'gus-desktop',
		'5: not one being deleted: ' || v);
	-- Carol's small one (carol-desktop is Alice's) never counted: her desktop is carol-desktop-2.
	perform pg_temp.base_assert(pg_temp.nc_answer(pg_temp.nc_start('owner', 'carol')) #>> '{machine,name}' = 'carol-desktop-2',
		'5: Carol''s desktop, not a small machine');
end $$;

-- 6. The floor: one new computer per agent a minute ----------------------------------------------------------------------------
do $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('owner'));
	perform public.qorpera_member_manage_company_machine('92400000-0000-4000-8000-000000000010', (pg_temp.mc_machine('gus-desktop')).id, 'delete');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.nc_start('contributor', 'gus') = pg_temp.nc_refused('START_TOO_SOON'), '6: within a minute');
	update public.qorpera_company_machines set created_at = created_at - interval '61 seconds'
	where started_by_staff_agent_id = pg_temp.nc_agent('gus') and started_by_run_id is null;
	perform pg_temp.mc_observe();
	v := pg_temp.nc_start('contributor', 'gus');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) ->> 'state' = 'started' and pg_temp.nc_count('gus') = 2, '6: after a minute: ' || v);
end $$;

-- 7. Every reader of a machine no run started ----------------------------------------------------------------------------------
-- carol-desktop-2 runs (the executor's custody and boot); the conversation trigger left no conversation.
select set_config('qorpera_test.nc_boot', '12230000-0000-4000-8000-0000000000b7', true);
do $$
declare v jsonb; v_machine public.qorpera_company_machines := pg_temp.mc_machine('carol-desktop-2'); v_session uuid;
begin
	perform pg_temp.nc_place('carol-desktop-2');
	perform pg_temp.mc_custody('carol-desktop-2', 'run');
	v := pg_temp.mc_running('carol-desktop-2', current_setting('qorpera_test.nc_boot')::uuid);
	perform pg_temp.base_assert(v #>> '{machine,state}' = 'running', '7: it runs: ' || v::text);
	perform pg_temp.base_assert(v_machine.started_conversation_run_id is null and v_machine.started_session_id is null,
		'7: the trigger: no conversation');
	v := public.qorpera_company_machine_view(pg_temp.mc_machine('carol-desktop-2'));
	perform pg_temp.base_assert(v -> 'startedBy' = jsonb_build_object('staffAgentId', pg_temp.nc_agent('carol'), 'runId', null, 'name', 'Carol'),
		'7: the view: Carol''s, no run: ' || v::text);
	-- A session's machines: Alice's conversation shows her own, never this one.
	v_session := (select session_id from public.qorpera_execution_runs where id = (pg_temp.mc_binding() ->> 'runId')::uuid);
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('owner'));
	v := public.qorpera_list_session_machines(v_session);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.session-machines/v1'
		and not exists (select 1 from jsonb_array_elements(v -> 'machines') m where m::text like '%carol-desktop-2%'),
		'7: a session''s machines: ' || v::text);
	-- The operators' compute requests list it, without a run.
	v := public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v -> 'requests') r
			where r::text like '%' || v_machine.id::text || '%' and r::text like '%"startedByRunId": null%'),
		'7: compute requests: ' || left(v::text, 2000));
	-- The busy and always-on check-ins have no starting conversation to ask.
	perform pg_temp.nc_shift('carol-desktop-2', 'busy_at = clock_timestamp()');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_busy_since(pg_temp.mc_machine('carol-desktop-2'))),
		'7: busy check-in: no one to ask');
	begin
		perform pg_temp.nc_shift('carol-desktop-2', 'lifetime = ''always-on'', desired_by = ''agent''');
		perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_always_on_since(pg_temp.mc_machine('carol-desktop-2'))),
			'7: always-on check-in: no one to ask');
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	-- Alice uses it as one she started: machine_start by its name finds it by name, not by a receipt; a look; a command.
	v := pg_temp.mc_start('nc-wake-carol', '{"machine":"carol-desktop-2"}');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'carol-desktop-2' and v #>> '{machine,state}' = 'running',
		'7: machine_start by name: ' || v::text);
	v := public.qorpera_authorize_machine_screen(pg_temp.mc_binding(), jsonb_build_object('machineId', v_machine.id), null, null);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '7: machine_screen: ' || v::text);
end $$;

-- The folder view of carol-desktop-2's boot: Carol's and the contributor's, company-wide; no run to act through.
select set_config('qorpera_test.nc_view', public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020',
	'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', (pg_temp.mc_machine('carol-desktop-2')).id,
		'placementId', (pg_temp.mc_placement('carol-desktop-2')).id, 'bootId', current_setting('qorpera_test.nc_boot')))::text, true);
do $$
declare v_view public.qorpera_folder_views := (select view from public.qorpera_folder_views view
	where view.id = (current_setting('qorpera_test.nc_view')::jsonb ->> 'viewId')::uuid);
begin
	perform pg_temp.base_assert(v_view.kind = 'test_machine' and v_view.staff_agent_id = pg_temp.nc_agent('carol')
			and v_view.member_user_id = pg_temp.nc_user('contributor') and v_view.worker_access is null,
		'7: the view: Carol and the contributor: ' || to_jsonb(v_view)::text);
	perform pg_temp.base_assert(public.qorpera_folder_view_live_run(v_view) is null, '7: no run to act through');
end $$;

-- 8. A save through the view: every run with a command on the disk is checked as a starter is --------------------------------
-- secret/ is a part of the folder only Alice of the agents reads (her own grant). Alice's run reads secret/s.txt and runs a
-- command on carol-desktop-2: what she read may be on its disk.
-- The view of carol-desktop-2's boot unless another view's setting is named.
create function pg_temp.nc_view_actor(p_view text default 'qorpera_test.nc_view') returns jsonb language sql as $$
	select jsonb_build_object('kind', 'view', 'viewId', current_setting(p_view)::jsonb ->> 'viewId',
		'pass', current_setting(p_view)::jsonb ->> 'pass')
$$;
create function pg_temp.nc_save(p_key text, p_view text default 'qorpera_test.nc_view') returns jsonb language plpgsql as $$
declare v_text text := 'Saved from the machine: ' || p_key;
begin
	perform pg_temp.base_seal(pg_temp.nc_view_actor(p_view), pg_temp.base_manifest(v_text));
	return public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', pg_temp.nc_view_actor(p_view), p_key,
		jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_key || '.md', 'file', pg_temp.base_stage(v_text))));
end $$;
create function pg_temp.nc_saved(p_result jsonb) returns boolean language sql as $$
	select not exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved')
		and jsonb_array_length(p_result -> 'units') = 1
$$;
create function pg_temp.nc_grant(p_live boolean) returns void language plpgsql as $$
begin
	update public.qorpera_company_path_grants set revoked_at = case when p_live then null else clock_timestamp() end
	where id = current_setting('qorpera_test.nc_grant')::uuid;
end $$;
do $$
declare v_resource uuid; v_actor jsonb := jsonb_build_object('kind', 'run', 'runId', pg_temp.mc_binding() ->> 'runId',
	'jobId', pg_temp.mc_binding() ->> 'jobId', 'runnerId', pg_temp.mc_binding() ->> 'runnerId',
	'assignmentId', pg_temp.mc_binding() ->> 'assignmentId'); v_read jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'nc-secret', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'secret'),
		jsonb_build_object('op', 'write', 'path', 'secret/s.txt', 'file', pg_temp.base_stage('Only Alice reads this.'))));
	v_resource := public.qorpera_folder_set_resource('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'secret', 'subtree',
		'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), v_resource, 'staff_agent',
		pg_temp.nc_agent('alice'), array['read']);
	perform set_config('qorpera_test.nc_grant', (select id from public.qorpera_company_path_grants where resource_id = v_resource
		and principal_kind = 'staff_agent' and principal_id = pg_temp.nc_agent('alice') and revoked_at is null)::text, true);
	v_read := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', v_actor, 'secret/s.txt') -> 'entry';
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', v_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version', 'authority', v_read -> 'authority')),
		repeat('0', 64));
	-- Before any command: the disk holds nothing of a run's, so Alice losing her grant changes no save.
	perform pg_temp.nc_grant(false);
	perform pg_temp.base_assert(pg_temp.nc_saved(pg_temp.nc_save('nc-before-command')), '8: no command, no run to check');
	perform pg_temp.nc_grant(true);
end $$;
do $$
declare v jsonb;
begin
	v := pg_temp.mc_run('12230000-0000-4000-8000-0000000000c1', 'nc-cmd', 'carol-desktop-2', 'cat secret/s.txt > /root/s.txt');
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and (select run_id from public.qorpera_company_machine_commands
			where id = '12230000-0000-4000-8000-0000000000c1') = (pg_temp.mc_binding() ->> 'runId')::uuid,
		'8: Alice runs a command on it: ' || v::text);
	-- While Alice still reads what she read, the machine saves.
	perform pg_temp.base_assert(pg_temp.nc_saved(pg_temp.nc_save('nc-while-readable')), '8: her reads still hold');
	-- Her grant goes: what she read may be on this disk, so the machine saves nothing more.
	perform pg_temp.nc_grant(false);
	perform pg_temp.base_error($sql$select pg_temp.nc_save('nc-after-narrowing')$sql$, '42501', 'A read is no longer readable');
	-- Her command ended: its output stays on the disk, so it stays checked.
	update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded', exit_code = 0
	where id = '12230000-0000-4000-8000-0000000000c1';
	perform pg_temp.base_error($sql$select pg_temp.nc_save('nc-after-command')$sql$, '42501', 'A read is no longer readable');
	-- Her run ended too (its job's lease ran out: no live run): the same.
	begin
		set local session_replication_role = replica;
		update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
		where id = (pg_temp.mc_binding() ->> 'jobId')::uuid;
		set local session_replication_role = origin;
		perform pg_temp.base_error($sql$select pg_temp.nc_save('nc-after-run')$sql$, '42501', 'A read is no longer readable');
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	-- Her grant back: the machine saves again.
	perform pg_temp.nc_grant(true);
	perform pg_temp.base_assert(pg_temp.nc_saved(pg_temp.nc_save('nc-readable-again')), '8: readable again');
end $$;

-- 8b. Screen actions (review r1 F1 of #1690): Alice only acts on bob-desktop's screen (she types what she read into a
-- file under /home/desktop); Bob's run, which reads no secret, copies that file into /company with a command. The save
-- checks Alice's reads too: her screen action is recorded on the disk. A look records nothing. The disk is the view's
-- placement: what a run did on an earlier placement's disk is not checked.
do $$
declare v_pass jsonb; v_run uuid;
begin
	-- Bob's run: the owner's post in his thread, materialized and started as 924 starts Alice's.
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', pg_temp.nc_agent('bob'), 'Copy the note into the company folder.');
	v_pass := pg_temp.base_materialize();
	v_run := (select run.id from public.qorpera_execution_runs run where run.id::text in (select jsonb_array_elements_text(v_pass -> 'run_ids'))
		and run.staff_agent_id = pg_temp.nc_agent('bob'));
	perform pg_temp.base_assert(v_run is not null, '8b: Bob''s run: ' || v_pass::text);
	perform set_config('qorpera_test.nc_bob', pg_temp.base_start(v_run)::text, true);
	perform pg_temp.base_public_send(current_setting('qorpera_test.nc_bob')::jsonb, 'progress', 'nc-bob-ack');
	-- bob-desktop runs, and its boot's view opens (Bob's and the owner's: the owner pressed for him).
	perform pg_temp.nc_shift('bob-desktop', 'wanted_at = clock_timestamp() - interval ''1 hour''');
	perform pg_temp.nc_place('bob-desktop');
	perform pg_temp.mc_custody('bob-desktop', 'run');
	perform pg_temp.base_assert(pg_temp.mc_running('bob-desktop', '12230000-0000-4000-8000-0000000000b8') #>> '{machine,state}' = 'running',
		'8b: bob-desktop runs');
	perform set_config('qorpera_test.nc_view_bob', public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', (pg_temp.mc_machine('bob-desktop')).id,
			'placementId', (pg_temp.mc_placement('bob-desktop')).id, 'bootId', '12230000-0000-4000-8000-0000000000b8'))::text, true);
end $$;
do $$
declare v jsonb; v_disk uuid := (pg_temp.mc_placement('bob-desktop')).id;
begin
	-- An earlier placement's disk (retired, removed): a command of Alice's there is not this disk's.
	begin
		set local session_replication_role = replica;
		insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
			instance_sha256, running_at, boot_id, retired_at, removing_at, removed_at)
		values ('12230000-0000-4000-8000-0000000000e9', (pg_temp.mc_machine('bob-desktop')).id, '92400000-0000-4000-8000-000000000010',
			'mx-1223', repeat('c', 64), '{"providerId": "machine-1223"}', repeat('9', 64), clock_timestamp() - interval '2 days',
			'12230000-0000-4000-8000-0000000000ea', clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day',
			clock_timestamp() - interval '1 day');
		insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
			started_at, sent_at, ended_at, state, exit_code, requested_by_user_id)
		values ('12230000-0000-4000-8000-0000000000c9', (pg_temp.mc_machine('bob-desktop')).id, (pg_temp.mc_binding() ->> 'runId')::uuid,
			pg_temp.nc_agent('alice'), '12230000-0000-4000-8000-0000000000e9', 'cat secret/s.txt', false, clock_timestamp() - interval '2 days',
			clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days', 'succeeded', 0, pg_temp.nc_user('owner'));
		set local session_replication_role = origin;
		perform pg_temp.nc_grant(false);
		perform pg_temp.base_assert(pg_temp.nc_saved(pg_temp.nc_save('nc-bob-desk-earlier-disk', 'qorpera_test.nc_view_bob')),
			'8b: an earlier placement''s disk is not this one''s');
		raise sqlstate 'P0F99';
	exception when sqlstate 'P0F99' then null;
	end;
	-- Alice looks at the screen: a look records nothing.
	v := public.qorpera_authorize_machine_screen(pg_temp.mc_binding(), jsonb_build_object('machineId', (pg_temp.mc_machine('bob-desktop')).id),
		null, null);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and not exists (select 1 from public.qorpera_company_machine_screen_runs
		where placement_id = v_disk), '8b: a look records nothing: ' || v::text);
	-- She types what she read into a file on the desktop and saves it: her action is recorded on the disk, once.
	v := pg_temp.mc_screen('12230000-0000-4000-8000-0000000000f1', 'nc-type-1', 'bob-desktop',
		'{"type":"type","text":"Only Alice reads this."}');
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '8b: her action: ' || v::text);
	v := pg_temp.mc_screen('12230000-0000-4000-8000-0000000000f2', 'nc-type-2', 'bob-desktop', '{"type":"key","keys":["ctrl+s"]}');
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '8b: her second action: ' || v::text);
	perform pg_temp.base_assert((select array_agg(run_id) from public.qorpera_company_machine_screen_runs where placement_id = v_disk)
		= array[(pg_temp.mc_binding() ->> 'runId')::uuid], '8b: one row for her run on this disk');
	-- Bob copies the file into /company with a command; Alice ran none here.
	v := pg_temp.mc_run('12230000-0000-4000-8000-0000000000c3', 'nc-bob-copy', 'bob-desktop',
		'cp /home/desktop/note.txt /company/note.txt', current_setting('qorpera_test.nc_bob')::jsonb);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and not exists (select 1 from public.qorpera_company_machine_commands
		where placement_id = v_disk and run_id = (pg_temp.mc_binding() ->> 'runId')::uuid), '8b: Bob''s command, none of Alice''s: ' || v::text);
	-- Alice still reads what she read: the save goes.
	perform pg_temp.base_assert(pg_temp.nc_saved(pg_temp.nc_save('nc-bob-desk-readable', 'qorpera_test.nc_view_bob')),
		'8b: her reads still hold');
	-- Her access narrowed: the save is refused, though she ran no command there.
	perform pg_temp.nc_grant(false);
	perform pg_temp.base_error($sql$select pg_temp.nc_save('nc-bob-desk-narrowed', 'qorpera_test.nc_view_bob')$sql$, '42501',
		'A read is no longer readable');
	perform pg_temp.nc_grant(true);
end $$;

-- 9. The idle rule: busy moves the last use only while a command whose conversation is asked runs on it ----------------------
do $$
declare v_before timestamptz;
begin
	-- carol-desktop-2: no command runs (Alice's ended). Busy asks no one: the last use stays, busy_at moves.
	perform pg_temp.nc_shift('carol-desktop-2', 'last_used_at = clock_timestamp() - interval ''2 hours'', busy_at = null');
	v_before := (pg_temp.mc_machine('carol-desktop-2')).last_used_at;
	perform pg_temp.base_assert(pg_temp.mc_record('carol-desktop-2', current_setting('qorpera_test.nc_boot')::uuid, true) ->> 'state' = 'recorded',
		'9: recorded');
	perform pg_temp.base_assert((pg_temp.mc_machine('carol-desktop-2')).last_used_at = v_before
			and (pg_temp.mc_machine('carol-desktop-2')).busy_at > clock_timestamp() - interval '5 seconds',
		'9: busy with no one asked: the last use stays');
	-- A command of Alice's runs on it, asked in her conversation: busy moves the last use.
	perform pg_temp.mc_run('12230000-0000-4000-8000-0000000000c2', 'nc-cmd-2', 'carol-desktop-2', 'npm test');
	perform pg_temp.nc_shift('carol-desktop-2', 'last_used_at = clock_timestamp() - interval ''2 hours''');
	perform pg_temp.base_assert((select conversation_run_id from public.qorpera_company_machine_commands
		where id = '12230000-0000-4000-8000-0000000000c2') is not null, '9: the command has its conversation');
	perform pg_temp.mc_record('carol-desktop-2', current_setting('qorpera_test.nc_boot')::uuid, true);
	perform pg_temp.base_assert((pg_temp.mc_machine('carol-desktop-2')).last_used_at > clock_timestamp() - interval '5 seconds',
		'9: busy with a command whose conversation is asked: the last use moves');
end $$;

-- An agent stops and deletes it, as one it started.
do $$
declare v jsonb;
begin
	v := public.qorpera_native_machine_manage(pg_temp.mc_binding(), '{"action":"stop","machine":"carol-desktop-2"}');
	perform pg_temp.base_assert(v::text like '%carol-desktop-2%' and (pg_temp.mc_machine('carol-desktop-2')).desired_state = 'stopped',
		'7: an agent stops it: ' || v::text);
	-- The stop's record: no conversation, so no container stop is kept.
	perform pg_temp.base_assert(public.qorpera_record_company_machine_stop((pg_temp.mc_placement('carol-desktop-2')).id,
			(pg_temp.mc_placement('carol-desktop-2')).owner,
			public.qorpera_company_machine_binding_text((pg_temp.mc_placement('carol-desktop-2')).binding),
			(pg_temp.mc_placement('carol-desktop-2')).machine_id_sha256, current_setting('qorpera_test.nc_boot')::uuid, '[]'::jsonb, true)
			is not null
		and not exists (select 1 from public.qorpera_company_machine_container_stops
			where machine_id = (pg_temp.mc_machine('carol-desktop-2')).id), '7: the stop record keeps no container stop');
	v := public.qorpera_native_machine_manage(pg_temp.mc_binding(), '{"action":"delete","machine":"carol-desktop-2"}');
	perform pg_temp.base_assert((select desired_state from public.qorpera_company_machines where name = 'carol-desktop-2') = 'deleted',
		'7: an agent deletes it: ' || v::text);
end $$;

-- 8c. The machine a start answers is always one the window lists (review r1 F2 of #1690): Hank has 20 newer machines
-- without a screen and an older desktop computer, asleep; the list's 20 hold the desktop, and the start answers it.
do $$
declare v_list jsonb; v text;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color,
		appearance_shape, employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '12230000-0000-4000-8000-0000000000d6', 'Hank', 'Research', 'Test.', 'blue', 'round',
		'active', 'setup', statement_timestamp(), statement_timestamp(), '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, desired_by, created_at)
	select extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		case when n = 0 then 'hank-old-desk' else 'hank-box-' || n end, 'Hank''s.', '12230000-0000-4000-8000-0000000000d6',
		'92400000-0000-4000-8000-000000000001', case when n = 0 then 2 else 1 end, case when n = 0 then 4294967296 else 1073741824 end,
		10737418240, 'standard', 'task', case when n = 0 then 'stopped' else 'running' end, 'member',
		case when n = 0 then clock_timestamp() - interval '1 day' else clock_timestamp() - make_interval(secs => 21 - n) end
	from generate_series(0, 20) n;
	set local session_replication_role = origin;
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('viewer'));
	v_list := public.qorpera_list_agent_machines('92400000-0000-4000-8000-000000000010', '12230000-0000-4000-8000-0000000000d6');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(jsonb_array_length(v_list -> 'machines') = 20
			and exists (select 1 from jsonb_array_elements(v_list -> 'machines') m where m ->> 'name' = 'hank-old-desk'),
		'8c: the list''s 20 hold the desktop: ' || v_list::text);
	perform pg_temp.base_claims('authenticated', pg_temp.nc_user('owner'));
	set local role authenticated;
	v := pg_temp.nc_try(format('select public.qorpera_member_start_agent_computer(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'12230000-0000-4000-8000-0000000000d6'));
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.nc_answer(v) ->> 'state' = 'existing' and pg_temp.nc_answer(v) #>> '{machine,name}' = 'hank-old-desk'
			and exists (select 1 from jsonb_array_elements(v_list -> 'machines') m
				where m ->> 'machineId' = pg_temp.nc_answer(v) #>> '{machine,machineId}'),
		'8c: the start answers the listed desktop: ' || v);
end $$;

-- 10. The null-together check, the grants and the markers ----------------------------------------------------------------------
do $$
declare v_role text;
begin
	begin
		update public.qorpera_company_machines set started_by_receipt_id = extensions.gen_random_uuid()
		where id = (pg_temp.mc_machine('bob-desktop')).id;
		raise exception 'A machine with a receipt and no run was allowed';
	exception when check_violation then
		perform pg_temp.base_assert(sqlerrm like '%qorpera_company_machines_started_by_run%', '10: ' || sqlerrm);
	end;
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_member_start_agent_computer(uuid,uuid)', 'execute'),
		'10: members call it');
	foreach v_role in array array['anon', 'service_role', 'public'] loop
		if v_role <> 'public' then
			perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_member_start_agent_computer(uuid,uuid)', 'execute'),
				'10: no ' || v_role);
		end if;
	end loop;
	-- The screen runs are no role's, as the commands are.
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_machine_screen_runs'::regclass)
		and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role)
			cross join unnest(array['select', 'insert', 'update', 'delete']) priv(name)
			where has_table_privilege(r.role, 'public.qorpera_company_machine_screen_runs', priv.name)),
		'10: the screen runs are no role''s');
end $$;

-- 11. Two sessions at once make one computer ------------------------------------------------------------------------------------

-- Row and lock waits show only across connections, so what this test made is committed here and removed again at the end,
-- with 1203's harness (1106's, 467's and 674's): the test refuses to run beside other connections to this database, whose
-- rows the cleanup could not tell from its own. The holder connection, as the contributor, makes a computer for Carol (hers
-- was deleted) in an open transaction; the owner's press for Carol, from the second connection, waits for it, then finds it:
-- one computer.
select set_config('qorpera_test.nc_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('nc_holder', 'dbname=' || current_database());
select dblink_connect('nc_poll', 'dbname=' || current_database());
select set_config('qorpera_test.nc_' || name || '_pid', pid::text, false)
from unnest(array['holder','poll']) name, lateral dblink('nc_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.nc_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.nc_holder_pid'), current_setting('qorpera_test.nc_poll_pid'))) then
		raise exception 'The computer race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.nc_alone_in_database();
create temporary table nc_counts as select * from dblink('nc_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
create temporary table nc_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.nc_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.nc_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.nc_rows select v_table, kept.row_value
			from dblink('nc_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- Each connection acts as a member, in the role a member's request has: the holder as the contributor, the other as the owner.
select dblink_exec('nc_holder', 'set role authenticated');
select dblink_exec('nc_holder', format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', pg_temp.nc_user('contributor'))::text));
select dblink_exec('nc_poll', 'set role authenticated');
select dblink_exec('nc_poll', format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', pg_temp.nc_user('owner'))::text));
create function pg_temp.nc_race() returns jsonb language plpgsql as $$
declare v_holder integer := current_setting('qorpera_test.nc_holder_pid')::integer;
	v_poll integer := current_setting('qorpera_test.nc_poll_pid')::integer;
	v_waited boolean := false; v_first text; v_second text;
	v_call text := format('select public.qorpera_member_start_agent_computer(%L, %L)::text', '92400000-0000-4000-8000-000000000010',
		pg_temp.nc_agent('carol'));
begin
	perform dblink_exec('nc_holder', 'begin');
	select answer into v_first from dblink('nc_holder', v_call) as call(answer text);
	perform dblink_send_query('nc_poll', v_call);
	for attempt in 1..400 loop
		v_waited := v_holder = any(pg_blocking_pids(v_poll));
		exit when v_waited or dblink_is_busy('nc_poll') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('nc_holder', 'commit');
	select answer into v_second from dblink_get_result('nc_poll') as call(answer text);
	perform * from dblink_get_result('nc_poll', false) as call(answer text);
	return jsonb_build_object('first', v_first::jsonb, 'second', v_second::jsonb, 'waited', v_waited,
		'carols', (select count(*) from public.qorpera_company_machines where started_by_staff_agent_id = pg_temp.nc_agent('carol')
			and desired_state <> 'deleted'));
end $$;
-- Carol's last computer was made more than a minute ago (committed, so the other connections see it).
update public.qorpera_company_machines set created_at = created_at - interval '61 seconds'
where started_by_staff_agent_id = pg_temp.nc_agent('carol') and started_by_run_id is null;
do $$
declare v_race jsonb;
begin
	v_race := pg_temp.nc_race();
	perform pg_temp.base_assert((v_race ->> 'waited')::boolean and v_race #>> '{first,state}' = 'started'
			and v_race #>> '{second,state}' = 'existing' and v_race #>> '{second,machine,machineId}' = v_race #>> '{first,machine,machineId}'
			and (v_race ->> 'carols')::integer = 1,
		'11: the second press waits for the first and finds its computer: ' || v_race::text);
end $$;

-- At the end: remove what the test committed, as 1203, 1106, 467 and 674 do.
do $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.nc_first_xid')::xid;
begin
	perform pg_temp.nc_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['nc_holder','nc_poll']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.nc_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.nc_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.nc_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.nc_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Computer race test cleanup left other row counts: %', v_wrong; end if;
end $$;
