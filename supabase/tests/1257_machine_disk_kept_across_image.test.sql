-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930760000 (agent-box, 14 Nov 2026): a sleeping machine keeps its disk when the machine image changes. On 924's base
-- (Alice's live conversation run) with a machine node and executor (as 1253's), Alice's task machine k (1 cpu, 2 GiB,
-- 40 GiB) ran and sleeps on its disk. Each case below changes the executor's policy and wakes k, then is taken back:
-- 1. A new image, bootstrap or provider policy (a new helper, a larger largest machine), each alone and all three: k wakes
--    on its OWN placement (same id, nothing retired, disk_freed_at not set, no diskFreed), through the old provider row,
--    by a start and by the executor's pass, also with no disk room left (paper or real); then it runs.
-- 2. Another project, storage pool, network or provider, each alone: stale as before: k moves to a new placement under
--    the new policy, the old one is retired, and k is told (disk_freed_at, diskFreed).
-- 3. An executor without a policy: stale as before (MACHINE_POLICY_CHANGED, its own node not asked); it moves to another
--    node when one takes it, and is told.
-- 4. When the ledger cannot wake the old placement (its provider row gone; k larger than that row's largest), k moves as
--    today and is told; when no node has room, k waits in line on its old disk, nothing retired, nothing told.
-- 5. A running machine is untouched by a new image and by a new project; asleep again, it keeps its disk on the image and
--    moves on the project.
-- 6. The take-again (#1749) gives k back with its disk, its `reused` saying nothing of an empty disk.
-- 7. The patched bodies name the migration, and the old rule is gone.
-- 8. The way out when the executor refuses a kept machine's guest helper (review r1 F2 of #1788): its record of
--    start:COMPANY_MACHINE_HELPER_DIFFERS for a placement of an earlier policy retires it, once: the machine's open
--    commands end lost, it is told (disk_freed_at, diskFreed), the executor stops and deletes the old one, and the next
--    admission places it fresh on the current policy, which that record never retires (no loop); one not wanted running
--    stays unplaced. A RUNNING machine, task or always-on, is never retired so (review r2 F1); a refusing company fence
--    retires nothing and the record goes through (r2 F2). Any other code, a placement on the current policy, another executor's or node's
--    record, or a removed placement change nothing but what the record always did.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'k-ack') \g /dev/null

create function pg_temp.g(p_gib bigint) returns bigint language sql immutable as $$ select p_gib * 1073741824 $$;
create function pg_temp.k_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.k_requester() returns uuid language sql as $$
	select (public.qorpera_describe_native_tool_authority(pg_temp.k_binding()) #>> '{identity,requesterUserId}')::uuid
$$;
-- The executor's first policy, each of its four place keys a value of its own; p_changes overrides keys.
create function pg_temp.k_policy(p_changes jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select jsonb_build_object('providerId','machine-1257','providerPolicySha256',repeat('f',64),'project','machines',
		'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','pool-1257','network','qagent0') || p_changes
$$;
-- The executor's policy changes as a roll changes it: its provider (and policy hash) enrolled on the node, then the
-- executor configured, p_gib of disk on paper.
create function pg_temp.k_switch(p_changes jsonb, p_gib bigint default 1000, p_cpu_millis bigint default 8000) returns void
language plpgsql as $$
declare v_policy jsonb := pg_temp.k_policy(p_changes);
begin
	if not exists (select 1 from public.qorpera_runtime_node_providers where provider_kind = 'machine'
		and provider_id = v_policy ->> 'providerId' and policy_sha256 = v_policy ->> 'providerPolicySha256') then
		perform public.qorpera_enroll_runtime_node_provider('12570000-0000-4000-8000-000000000410', repeat('c',64), 'machine',
			v_policy ->> 'providerId', v_policy ->> 'providerPolicySha256', p_cpu_millis, 34359738368);
	end if;
	perform public.qorpera_configure_machine_executor('mx-1257', repeat('c',64), true, v_policy, pg_temp.g(p_gib));
end
$$;
create function pg_temp.k_observe(p_node uuid default '12570000-0000-4000-8000-000000000410', p_sha text default repeat('c',64))
returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context(p_node);
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_sha,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
-- A second node with its machine provider and executor (mx-1257e), observed now.
create function pg_temp.k_node_b() returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12570000-0000-4000-8000-000000000411','machineIdSha256',repeat('e',64),'label','machine-e','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12570000-0000-4000-8000-000000000411','host',jsonb_build_object('machineIdSha256',repeat('e',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.k_observe('12570000-0000-4000-8000-000000000411', repeat('e',64));
	perform public.qorpera_enroll_runtime_node_provider('12570000-0000-4000-8000-000000000411', repeat('e',64), 'machine', 'machine-1257e',
		repeat('9',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1257e', repeat('e',64), true, pg_temp.k_policy('{"providerId":"machine-1257e",
		"providerPolicySha256":"9999999999999999999999999999999999999999999999999999999999999999"}'), pg_temp.g(300));
end
$$;
create function pg_temp.k_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.k_current(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select public.qorpera_company_machine_placement((pg_temp.k_machine(p_name)).id)
$$;
create function pg_temp.k_view(p_name text) returns jsonb language sql as $$
	select public.qorpera_company_machine_view(pg_temp.k_machine(p_name))
$$;
create function pg_temp.k_custody(p_placement public.qorpera_company_machine_placements, p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_intent)
$$;
-- The executor's admission passes, as its pass makes them: how many machines it placed or woke.
create function pg_temp.k_admit() returns integer language plpgsql as $$
declare v_count integer := 0;
begin
	perform pg_temp.k_observe();
	for attempt in 1..8 loop
		exit when public.qorpera_admit_executor_machines('mx-1257', repeat('c', 64), 16) = '[]'::jsonb;
		v_count := v_count + 1;
	end loop;
	return v_count;
end
$$;
-- A member asks for the machine again (desired running, in line now); p_admit: and its admission runs at once (as
-- machine_start's), whose answer is returned.
create function pg_temp.k_wake(p_name text) returns jsonb language plpgsql as $$
begin
	update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp()
	where name = p_name and removed_at is null;
	perform pg_temp.k_observe();
	return public.qorpera_admit_company_machine((pg_temp.k_machine(p_name)).id);
end
$$;
-- It runs: the executor's custody to run (which reserves through the placement's own provider row), the guest's mark.
create function pg_temp.k_run(p_name text) returns void language plpgsql as $$
declare v jsonb;
begin
	if (pg_temp.k_current(p_name)).id is null then perform pg_temp.k_admit(); end if;
	v := pg_temp.k_custody(pg_temp.k_current(p_name), 'run');
	perform pg_temp.base_assert(v ->> 'intent' = 'run', p_name || ' may run: ' || coalesce(v::text, 'null'));
	v := public.qorpera_mark_company_machine_running((pg_temp.k_current(p_name)).id, (pg_temp.k_current(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.k_current(p_name)).binding), repeat('c', 64), extensions.gen_random_uuid());
	perform pg_temp.base_assert(v #>> '{machine,state}' = 'running', p_name || ' runs: ' || v::text);
end
$$;
-- It sleeps on its disk (the kernel's idle stop, the executor's power-off), asleep and last used p_ago ago.
create function pg_temp.k_sleep(p_name text, p_ago interval) returns void language plpgsql as $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.k_current(p_name); v jsonb;
begin
	perform public.qorpera_set_company_machine_desired(pg_temp.k_machine(p_name), 'stopped', 'kernel');
	v := pg_temp.k_custody(v_placement, 'stop');
	perform pg_temp.base_assert(v ->> 'intent' = 'stop', p_name || ' may stop: ' || coalesce(v::text, 'null'));
	v := public.qorpera_suspend_company_machine(v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256);
	perform pg_temp.base_assert(v ->> 'state' = 'suspended', p_name || ' sleeps: ' || v::text);
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() - p_ago where allocation_id = v_placement.id;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - p_ago where id = v_placement.machine_id;
end
$$;
-- What came of a wake of k, whose placement was p_old: 'kept' (the same placement, not retired, its disk not freed, nothing
-- said) or 'moved:<owner>' (a new placement under that executor's policy now, the old one retired, and k told), each with
-- the admission's state; anything else spelled out.
create function pg_temp.k_outcome(p_old uuid, p_admission jsonb) returns text language plpgsql as $$
declare v_now public.qorpera_company_machine_placements := pg_temp.k_current('k');
	v_old public.qorpera_company_machine_placements; v_machine public.qorpera_company_machines := pg_temp.k_machine('k');
	v_policy jsonb;
begin
	select * into strict v_old from public.qorpera_company_machine_placements where id = p_old;
	if v_now.id = p_old and v_old.retired_at is null and v_machine.disk_freed_at is null
		and pg_temp.k_view('k') -> 'diskFreed' = 'null'::jsonb
		and (select count(*) from public.qorpera_company_machine_placements where machine_id = v_machine.id) = 1 then
		return 'kept ' || coalesce(p_admission ->> 'state', '') || coalesce(' ' || (p_admission ->> 'reason'), '');
	end if;
	select policy into v_policy from public.qorpera_machine_executors where owner = v_now.owner;
	if v_now.id is not null and v_now.id <> p_old and v_old.retired_at is not null and v_now.binding @> v_policy
		and v_machine.disk_freed_at is not null and pg_temp.k_view('k') ->> 'diskFreed' like 'its disk was freed while it slept%' then
		return 'moved:' || v_now.owner || ' ' || coalesce(p_admission ->> 'state', '');
	end if;
	return format('unexpected: now %s old %s retired %s freed %s view %s admission %s', v_now.id, p_old, v_old.retired_at,
		v_machine.disk_freed_at, pg_temp.k_view('k'), p_admission);
end
$$;
-- 628's machine_start of Alice's run (as 1253's d_start).
create function pg_temp.k_start(p_key text, p_name text) returns jsonb language plpgsql as $$
declare v_receipt uuid := extensions.gen_random_uuid();
	v_envelope text := jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.k_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',jsonb_build_object('name', p_name, 'purpose', 'Work for ' || p_name, 'cpus', 1, 'memoryGiB', 2, 'diskGiB', 40,
				'lifetime', 'task'),
			'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text;
	v_sha text := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.k_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.k_binding(), v_receipt, 'machine_start:' || p_key, v_sha, repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.k_binding(), v_envelope, 'begin', v_receipt, repeat('9', 64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.k_binding(), v_receipt, v_sha,
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', v_sha,
			'content', jsonb_build_object('kind', 'json', 'value', v_result)));
	return v_result;
end
$$;

-- The node, its machine provider and executor, and Alice's machine k asleep on its disk.
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12570000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'label','machine-k','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12570000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.k_observe();
	perform pg_temp.k_switch('{}'::jsonb);
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'k',
		'Work for k', '92400000-0000-4000-8000-000000000030', null, null, pg_temp.k_requester(), 1, 2147483648, 42949672960,
		'standard', 'task');
	perform pg_temp.k_run('k');
	perform pg_temp.k_sleep('k', interval '1 hour');
	perform pg_temp.base_assert(pg_temp.k_view('k') ->> 'state' = 'stopped' and (pg_temp.k_current('k')).binding @> pg_temp.k_policy(),
		'setup: k sleeps on a placement of the first policy');
end $$;

-- 1. A new image, bootstrap or provider policy: k wakes on its own disk ----------------------------------------------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v_case jsonb; v_out text; v_outs text[] := '{}'; v jsonb;
	v_room bigint;
begin
	foreach v_case in array array[
		jsonb_build_object('imageFingerprint', repeat('d', 64)),
		jsonb_build_object('bootstrapSha256', repeat('8', 64)),
		-- A new helper or a larger largest machine: only the provider policy's hash moves.
		jsonb_build_object('providerPolicySha256', repeat('e', 64)),
		jsonb_build_object('imageFingerprint', repeat('d', 64), 'bootstrapSha256', repeat('8', 64), 'providerPolicySha256', repeat('e', 64))] loop
		begin
			perform pg_temp.k_switch(v_case, 1000, 12000);
			v := pg_temp.k_wake('k');
			v_out := pg_temp.k_outcome(v_old, v);
			raise exception 'take back' using errcode = 'P0D01';
		exception when sqlstate 'P0D01' then null;
		end;
		v_outs := v_outs || v_out;
	end loop;
	perform pg_temp.base_assert(v_outs = array['kept reserved','kept reserved','kept reserved','kept reserved'],
		'1: a new image, bootstrap, provider policy, or all three: k wakes on its own disk: ' || v_outs::text);
	-- All three, and the executor's pass wakes it (as for any machine asleep on this node): still its own disk, through
	-- the old provider row; it then runs there, its first policy's image named in its binding.
	begin
		perform pg_temp.k_switch(v_case, 1000, 12000);
		update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp()
		where name = 'k' and removed_at is null;
		v := to_jsonb(pg_temp.k_admit());
		v_out := pg_temp.k_outcome(v_old, jsonb_build_object('state', v::text));
		v := v || jsonb_build_array(pg_temp.k_view('k') ->> 'state',
			(select policy_sha256 from public.qorpera_runtime_node_demands where allocation_id = v_old),
			(pg_temp.k_current('k')).binding ->> 'imageFingerprint');
		perform pg_temp.k_run('k');
		v := v || to_jsonb(pg_temp.k_view('k') ->> 'state') || to_jsonb((pg_temp.k_current('k')).id = v_old);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'kept 1' and v = jsonb_build_array(1, 'starting', repeat('f', 64), repeat('a', 64), 'running', true),
		'1: the executor''s pass wakes it on its own disk, through the old provider row, and it runs: ' || v_out || ' ' || v::text);
	-- A wake needs no new disk: with no room left on paper, and with the pool's real figures short, k still wakes on its own.
	begin
		perform pg_temp.k_switch(v_case, 40, 12000);
		v_room := public.qorpera_machine_executor_disk_room('mx-1257');
		v := pg_temp.k_wake('k');
		v_out := v_room || ' ' || pg_temp.k_outcome(v_old, v);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = '0 kept reserved', '1: no room on paper, it wakes on its own disk: ' || v_out);
	begin
		perform pg_temp.k_switch(v_case, 1000, 12000);
		perform public.qorpera_report_executor_disk('mx-1257', repeat('c', 64), jsonb_build_object('schema','qorpera.machine-executor-disk/v1',
			'pool','pool-1257','totalBytes',pg_temp.g(1000),'usedBytes',pg_temp.g(990),'placements',jsonb_build_object(v_old::text, pg_temp.g(3))));
		v_room := public.qorpera_machine_executor_disk_room('mx-1257');
		v := pg_temp.k_wake('k');
		v_out := (v_room < 0)::text || ' ' || pg_temp.k_outcome(v_old, v);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'true kept reserved', '1: real figures short, it wakes on its own disk: ' || v_out);
end $$;

-- 2. Another place: stale as before, moved and told ------------------------------------------------------------------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v_case jsonb; v_out text; v_outs text[] := '{}'; v jsonb;
begin
	foreach v_case in array array[
		'{"project":"machines-b"}'::jsonb, '{"storagePool":"pool-1257b"}'::jsonb, '{"network":"qagent1"}'::jsonb,
		jsonb_build_object('providerId', 'machine-1257b', 'providerPolicySha256', repeat('e', 64))] loop
		begin
			perform pg_temp.k_switch(v_case);
			v := pg_temp.k_wake('k');
			v_out := pg_temp.k_outcome(v_old, v);
			raise exception 'take back' using errcode = 'P0D01';
		exception when sqlstate 'P0D01' then null;
		end;
		v_outs := v_outs || v_out;
	end loop;
	perform pg_temp.base_assert(v_outs = array['moved:mx-1257 reserved','moved:mx-1257 reserved','moved:mx-1257 reserved','moved:mx-1257 reserved'],
		'2: another project, storage pool, network or provider: moved and told: ' || v_outs::text);
	-- By the executor's pass too.
	begin
		perform pg_temp.k_switch('{"project":"machines-b"}'::jsonb);
		update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp()
		where name = 'k' and removed_at is null;
		v := to_jsonb(pg_temp.k_admit());
		v_out := pg_temp.k_outcome(v_old, jsonb_build_object('state', v::text));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'moved:mx-1257 1', '2: the executor''s pass moves it too: ' || v_out);
end $$;

-- 3. An executor without a policy: stale as before ------------------------------------------------------------------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v jsonb; v_out text; v_moved text;
begin
	begin
		perform public.qorpera_configure_machine_executor('mx-1257', repeat('c',64), false, null, pg_temp.g(1000));
		v := pg_temp.k_wake('k');
		v_out := pg_temp.k_outcome(v_old, v);
		-- Another node takes it: it moves there, and is told.
		perform pg_temp.k_node_b();
		v_moved := pg_temp.k_outcome(v_old, pg_temp.k_wake('k'));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'kept refused MACHINE_POLICY_CHANGED' and v_moved = 'moved:mx-1257e reserved',
		'3: without a policy: refused as changed, its node not asked; moved where it fits: ' || v_out || ' / ' || v_moved);
end $$;

-- 4. The ledger cannot wake the old placement: moved as today and told; no room anywhere: it waits on its disk ---------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v jsonb; v_gone text; v_large text; v_full text; v_fk text;
begin
	select conname into strict v_fk from pg_catalog.pg_constraint
	where conrelid = 'public.qorpera_runtime_node_demands'::regclass and confrelid = 'public.qorpera_runtime_node_providers'::regclass
		and contype = 'f';
	-- Its provider row gone (it cannot be today: the demand's foreign key keeps it, and nothing deletes one).
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		execute format('alter table public.qorpera_runtime_node_demands drop constraint %I', v_fk);
		delete from public.qorpera_runtime_node_providers where provider_kind = 'machine' and provider_id = 'machine-1257'
			and policy_sha256 = repeat('f', 64);
		v := pg_temp.k_wake('k');
		v_gone := pg_temp.k_outcome(v_old, v);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	-- k larger than that row's largest machine (the ledger refuses: 42501).
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		update public.qorpera_runtime_node_providers set cpu_millis = 500 where provider_kind = 'machine' and provider_id = 'machine-1257'
			and policy_sha256 = repeat('f', 64);
		v := pg_temp.k_wake('k');
		v_large := pg_temp.k_outcome(v_old, v);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	-- No room on its node (and no other node): it waits in line on its own disk.
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		update public.qorpera_runtime_nodes set headroom_memory_bytes = memory_bytes - 1073741824, standard_memory_bytes = 1073741824
		where id = '12570000-0000-4000-8000-000000000410';
		v := pg_temp.k_wake('k');
		v_full := pg_temp.k_outcome(v_old, v) || ' ' || (pg_temp.k_view('k') ->> 'state');
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_gone = 'moved:mx-1257 reserved' and v_large = 'moved:mx-1257 reserved'
		and v_full = 'kept refused NODE_CAPACITY_EXHAUSTED waiting',
		'4: provider row gone: ' || v_gone || '; larger than its row: ' || v_large || '; no room: ' || v_full);
end $$;

-- 5. A running machine is untouched -----------------------------------------------------------------------------------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v jsonb; v_image text; v_project text;
begin
	begin
		v := pg_temp.k_wake('k');
		perform pg_temp.k_run('k');
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		v := pg_temp.k_wake('k');
		v_image := pg_temp.k_outcome(v_old, v) || ' ' || (pg_temp.k_view('k') ->> 'state');
		perform pg_temp.k_sleep('k', interval '1 minute');
		v_image := v_image || ' / ' || pg_temp.k_outcome(v_old, pg_temp.k_wake('k'));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	begin
		v := pg_temp.k_wake('k');
		perform pg_temp.k_run('k');
		perform pg_temp.k_switch('{"project":"machines-b"}'::jsonb);
		v := pg_temp.k_wake('k');
		v_project := pg_temp.k_outcome(v_old, v) || ' ' || (pg_temp.k_view('k') ->> 'state');
		perform pg_temp.k_sleep('k', interval '1 minute');
		v_project := v_project || ' / ' || pg_temp.k_outcome(v_old, pg_temp.k_wake('k'));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_image = 'kept reserved running / kept reserved'
		and v_project = 'kept reserved running / moved:mx-1257 reserved',
		'5: running, untouched; asleep again, kept on a new image, moved on a new project: ' || v_image || ' | ' || v_project);
end $$;

-- 6. The take-again gives k back with its disk ------------------------------------------------------------------------------
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v jsonb; v_out text;
begin
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_observe();
		v := pg_temp.k_start('take-k', 'next-task');
		v_out := pg_temp.k_outcome(v_old, jsonb_build_object('state', v #>> '{machine,state}'));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'kept starting' and v #>> '{machine,name}' = 'k'
		and v ->> 'reused' = 'your own free machine k of this size was given to you again instead of a new one: use the name k'
		and v #> '{machine,diskFreed}' = 'null'::jsonb, '6: k is given back with its disk: ' || v_out || ' ' || v::text);
end $$;

-- 7. The marker, and the old rule gone ----------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from unnest(array['anon','authenticated','service_role']) role
		where has_function_privilege(role, 'public.qorpera_company_machine_helper_refused(uuid,text,text)', 'execute')),
		'7: the way out is internal');
	perform pg_temp.base_assert(not exists (select 1 from unnest(array['anon','authenticated','service_role']) role
		where has_function_privilege(role, 'public.qorpera_admit_company_machine(uuid,text)', 'execute')),
		'7: admission stays internal');
end $$;

-- 8. A guest helper the executor refuses: the way out --------------------------------------------------------------------
-- The executor's record of a step's error for k's current placement (as #stepped makes it), from its own node unless named.
create function pg_temp.k_record(p_code text, p_owner text default 'mx-1257', p_sha text default repeat('c', 64)) returns void
language sql as $$
	select public.qorpera_record_company_machine_error((pg_temp.k_current('k')).id, p_owner, p_sha, 'start', p_code)
$$;
-- An open command of Alice's run on k's current placement, its start last sent 3 minutes ago.
create function pg_temp.k_command() returns uuid language sql as $$
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		requested_by_user_id, sent_at)
	values (extensions.gen_random_uuid(), (pg_temp.k_machine('k')).id, (pg_temp.k_binding() ->> 'runId')::uuid,
		'92400000-0000-4000-8000-000000000030', (pg_temp.k_current('k')).id, 'apt-get install -y something', false, pg_temp.k_requester(),
		clock_timestamp() - interval '3 minutes')
	returning id
$$;
-- What a refused helper did to k, whose placement was p_old: 'retired' (the old placement retired, k without one and told,
-- or on a new one under the current policy), else 'kept', with k's last error.
create function pg_temp.k_refused(p_old uuid) returns text language sql as $$
	select case when (select retired_at is not null from public.qorpera_company_machine_placements where id = p_old)
			and (pg_temp.k_machine('k')).disk_freed_at is not null
			and pg_temp.k_view('k') ->> 'diskFreed' like 'its disk was freed while it slept%'
			and ((pg_temp.k_current('k')).id is null
				or (pg_temp.k_current('k')).binding @> (select policy from public.qorpera_machine_executors where owner = 'mx-1257'))
		then 'retired' else 'kept' end || ' ' || coalesce((pg_temp.k_machine('k')).last_error, '-')
$$;
do $$
declare v_old uuid := (pg_temp.k_current('k')).id; v_command uuid; v_freed timestamptz; v jsonb; v_out text; v_again text;
	v_fresh text; v_listed text; v_other text; v_current text; v_running text; v_stopped text; v_foreign text; v_fence text;
	v_lifetime text;
begin
	-- Woken on its own disk after a new image; the executor refuses its helper (the old one was dropped from its list).
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		v_command := pg_temp.k_command();
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
		v_out := pg_temp.k_refused(v_old) || ' ' || coalesce((select state from public.qorpera_company_machine_commands where id = v_command), '-')
			|| ' ' || coalesce((pg_temp.k_current('k')).id::text, 'none');
		v_freed := (pg_temp.k_machine('k')).disk_freed_at;
		-- The same record again (the pass before its stop): nothing more.
		perform public.qorpera_record_company_machine_error(v_old, 'mx-1257', repeat('c', 64), 'start', 'COMPANY_MACHINE_HELPER_DIFFERS');
		v_again := ((pg_temp.k_machine('k')).disk_freed_at = v_freed)::text || ' '
			|| (select count(*) from public.qorpera_company_machine_placements where machine_id = (pg_temp.k_machine('k')).id);
		-- The executor stops the old one (it holds room) and deletes it, as any retired placement.
		select concat_ws(',', e ->> 'stopDue', e ->> 'removeDue', e ->> 'desiredState') into v_listed
		from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1257', repeat('c', 64))) e where e ->> 'placementId' = v_old::text;
		-- The next admission places it fresh on the current policy, and its view still tells; that placement's own refused
		-- helper (were the executor configured wrong) retires nothing: no loop.
		v := to_jsonb(pg_temp.k_admit());
		v_fresh := v::text || ' ' || pg_temp.k_refused(v_old) || ' ' || ((pg_temp.k_current('k')).id <> v_old)::text;
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
		v_fresh := v_fresh || ' / ' || ((pg_temp.k_current('k')).retired_at is null)::text || ' ' || (pg_temp.k_machine('k')).last_error;
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_out = 'retired - lost none' and v_again = 'true 1' and v_listed = 'true,true,deleted'
		and v_fresh = '1 retired - true / true start:COMPANY_MACHINE_HELPER_DIFFERS',
		'8: a refused helper retires once, tells, the old placement goes, a fresh one is never retired so: ' || concat_ws(' | ',
			v_out, v_again, v_listed, v_fresh));
	-- Any other error on the same placement changes nothing but the machine's last error.
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		perform pg_temp.k_record('COMPANY_MACHINE_DRIFTED');
		v_other := pg_temp.k_refused(v_old) || ' ' || ((pg_temp.k_current('k')).id = v_old)::text;
		perform pg_temp.k_record('COMPANY_MACHINE_GUEST_REPLY_INVALID');
		v_other := v_other || ' / ' || pg_temp.k_refused(v_old);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	-- On the current policy (no switch): kept, the error recorded as before.
	begin
		perform pg_temp.k_wake('k');
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
		v_current := pg_temp.k_refused(v_old) || ' ' || ((pg_temp.k_current('k')).id = v_old)::text;
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_other = 'kept start:COMPANY_MACHINE_DRIFTED true / kept start:COMPANY_MACHINE_GUEST_REPLY_INVALID'
		and v_current = 'kept start:COMPANY_MACHINE_HELPER_DIFFERS true',
		'8: another error, or the current policy''s placement: kept, recorded as before: ' || v_other || ' | ' || v_current);
	-- Running on an earlier policy, a task machine and an always-on one (review r2 F1): never taken by one refusal. The error
	-- is recorded as before each pass; its commands, its placement and its disk stay; the executor keeps it (no stop due).
	foreach v_lifetime in array array['task', 'always-on'] loop
		begin
			update public.qorpera_company_machines set lifetime = v_lifetime where id = (pg_temp.k_machine('k')).id;
			perform pg_temp.k_wake('k');
			perform pg_temp.k_run('k');
			v_command := pg_temp.k_command();
			perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
			perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
			perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
			select pg_temp.k_refused(v_old) || ' ' || concat_ws(',', e ->> 'stopDue', e ->> 'removeDue', e ->> 'reserved') into v_out
			from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1257', repeat('c', 64))) e where e ->> 'placementId' = v_old::text;
			v_out := v_out || ' ' || coalesce((select state from public.qorpera_company_machine_commands where id = v_command), 'open')
				|| ' ' || ((pg_temp.k_machine('k')).disk_freed_at is null)::text || ' ' || (pg_temp.k_view('k') ->> 'state');
			raise exception 'take back' using errcode = 'P0D01';
		exception when sqlstate 'P0D01' then null;
		end;
		v_running := concat_ws(' | ', v_running, v_out);
	end loop;
	-- Being woken (reserved, its guest not ready yet) is no usable boot: retired, and told, as above.
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
		v_out := pg_temp.k_refused(v_old) || ' ' || ((select reserved_at is not null from public.qorpera_runtime_node_demands where allocation_id = v_old))::text;
		v_out := v_out || ' ' || pg_temp.k_admit();
		v_out := v_out || ' ' || (pg_temp.k_view('k') ->> 'state');
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	v_running := concat_ws(' | ', v_running, v_out);
	-- The company's machine fence refuses (a company being deleted: its folder fence is gone): nothing is retired, and the
	-- record itself goes through (review r2 F2).
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		delete from public.qorpera_folder_fences where profile_id = '92400000-0000-4000-8000-000000000010';
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS');
		v_fence := pg_temp.k_refused(v_old);
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	-- Not wanted running any more when the record comes: retired, and no new placement until it is asked for.
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		perform public.qorpera_set_company_machine_desired(pg_temp.k_machine('k'), 'stopped', 'member');
		perform public.qorpera_record_company_machine_error(v_old, 'mx-1257', repeat('c', 64), 'start', 'COMPANY_MACHINE_HELPER_DIFFERS');
		v_stopped := pg_temp.k_refused(v_old) || ' ' || pg_temp.k_admit();
		v_stopped := v_stopped || ' ' || coalesce((pg_temp.k_current('k')).id::text, 'none') || ' ' || (pg_temp.k_view('k') ->> 'state');
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_running = 'kept start:COMPANY_MACHINE_HELPER_DIFFERS false,false,true open true running'
			|| ' | kept start:COMPANY_MACHINE_HELPER_DIFFERS false,false,true open true running | retired - true 1 starting'
		and v_stopped = 'retired - 0 none stopped' and v_fence = 'kept start:COMPANY_MACHINE_HELPER_DIFFERS',
		'8: running (task, always-on): kept, recorded; being woken: retired, placed fresh; not wanted: retired, unplaced; a refusing '
		|| 'fence: kept, recorded: ' || v_running || ' | ' || v_stopped || ' | ' || coalesce(v_fence, 'null'));
	-- Another executor's record, another node's, or one for a removed placement: nothing.
	begin
		perform pg_temp.k_switch(jsonb_build_object('imageFingerprint', repeat('d', 64), 'providerPolicySha256', repeat('e', 64)));
		perform pg_temp.k_wake('k');
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS', 'mx-other');
		v_foreign := pg_temp.k_refused(v_old);
		perform pg_temp.k_record('COMPANY_MACHINE_HELPER_DIFFERS', 'mx-1257', repeat('d', 64));
		v_foreign := v_foreign || ' / ' || pg_temp.k_refused(v_old);
		update public.qorpera_company_machine_placements set removing_at = clock_timestamp(), removed_at = clock_timestamp() where id = v_old;
		perform public.qorpera_record_company_machine_error(v_old, 'mx-1257', repeat('c', 64), 'start', 'COMPANY_MACHINE_HELPER_DIFFERS');
		v_foreign := v_foreign || ' / ' || ((pg_temp.k_machine('k')).disk_freed_at is null)::text;
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_foreign = 'kept - / kept - / true', '8: another executor''s, another node''s, a removed one''s: ' || v_foreign);
end $$;

rollback;
