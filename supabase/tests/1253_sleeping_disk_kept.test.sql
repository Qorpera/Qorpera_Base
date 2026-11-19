-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930757000 (agent-box, slice 5): a sleeping machine keeps its disk unless its server is really short, and never
-- loses it silently. On 924's base (Alice's live conversation run) with a machine node and executor (as 1241's), three
-- machines asleep on it: b-old (another company's, asleep 5 days), a-old (Alice's, 3 days) and a-new (Alice's, 2 hours),
-- each 40 GiB, so the paper budget (120 GiB) is full:
-- 1. Full on paper, real room: with the executor's fresh report a new machine is placed and no disk goes; the room is the
--    pool's real free space less a fifth of the pool and what the awake machines could still grow into; without the
--    report (stale) the paper rule gives a disk away as before, now the asking company's own before the longest asleep.
-- 2. Real pressure: the right disk goes (the asking company's own old one, not another company's asleep longer, not a
--    recent one), only it, the machine's row says when; placement refuses NODE_DISK_EXHAUSTED; a disk deleted after the
--    report still counts as coming free, so the shortage takes no second disk; the next report places the machine.
-- 3. When giving away would not make the room, nothing goes; a disk whose use is unknown is never given for room; never a
--    machine used in the last 24 hours while an older one can go, even the asking company's own.
-- 4. Without a fresh report (older than 2 minutes, none, another pool) the room is the paper budget, never "no limit".
-- 5. What the agent sees: the view (status and list through machine_manage, and the start's answer) says diskFreed while
--    the machine has no disk and on its first new disk until it sleeps; the take-again prefers a machine that holds its
--    disk over the asked name, and `reused` says when the one given starts empty.
-- 6. A wake that moves a machine to a new disk after it slept on the old one (its executor in another project) says so too.
-- 7. The report is refused whole when malformed (22023) or not the executor's (42501); what is internal stays internal;
--    every new or patched body names the migration.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'd-ack') \g /dev/null

create function pg_temp.g(p_gib bigint) returns bigint language sql immutable as $$ select p_gib * 1073741824 $$;
create function pg_temp.d_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.d_run() returns uuid language sql as $$ select (pg_temp.d_binding() ->> 'runId')::uuid $$;
create function pg_temp.d_requester() returns uuid language sql as $$
	select (public.qorpera_describe_native_tool_authority(pg_temp.d_binding()) #>> '{identity,requesterUserId}')::uuid
$$;
create function pg_temp.d_policy(p_image text default repeat('a', 64)) returns jsonb language sql as $$
	select jsonb_build_object('providerId','machine-1253','providerPolicySha256',repeat('f',64),'project','machines',
		'imageFingerprint',p_image,'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0')
$$;
create function pg_temp.d_budget(p_gib bigint, p_image text default repeat('a', 64), p_enabled boolean default true)
returns void language sql as $$
	select public.qorpera_configure_machine_executor('mx-1253', repeat('c',64), p_enabled, pg_temp.d_policy(p_image), pg_temp.g(p_gib))
$$;
-- A second node with its machine provider and executor (mx-1253e), observed now, its report giving 700 GiB of room.
create function pg_temp.d_node_b() returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12530000-0000-4000-8000-000000000411','machineIdSha256',repeat('e',64),'label','machine-e','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12530000-0000-4000-8000-000000000411','host',jsonb_build_object('machineIdSha256',repeat('e',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.d_observe('12530000-0000-4000-8000-000000000411', repeat('e',64));
	perform public.qorpera_enroll_runtime_node_provider('12530000-0000-4000-8000-000000000411', repeat('e',64), 'machine', 'machine-1253e',
		repeat('9',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1253e', repeat('e',64), true, jsonb_build_object('providerId','machine-1253e',
		'providerPolicySha256',repeat('9',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','qagent0'), pg_temp.g(300));
	perform public.qorpera_report_executor_disk('mx-1253e', repeat('e',64), jsonb_build_object('schema','qorpera.machine-executor-disk/v1',
		'pool','machines','totalBytes',pg_temp.g(1000),'usedBytes',pg_temp.g(100),'placements','{}'::jsonb));
end
$$;
create function pg_temp.d_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
-- The machine's placement that holds its disk now (none once it is given away or moved).
create function pg_temp.d_current(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select public.qorpera_company_machine_placement((pg_temp.d_machine(p_name)).id)
$$;
-- Its latest placement, retired or not.
create function pg_temp.d_latest(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	where placement.machine_id = (pg_temp.d_machine(p_name)).id order by placement.created_at desc, placement.id limit 1
$$;
create function pg_temp.d_observe(p_node uuid default '12530000-0000-4000-8000-000000000410', p_sha text default repeat('c',64))
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
-- The executor's admission passes, as its pass makes them: how many machines it placed.
create function pg_temp.d_admit() returns integer language plpgsql as $$
declare v_count integer := 0;
begin
	perform pg_temp.d_observe();
	for attempt in 1..8 loop
		exit when public.qorpera_admit_executor_machines('mx-1253', repeat('c', 64), 16) = '[]'::jsonb;
		v_count := v_count + 1;
	end loop;
	return v_count;
end
$$;
create function pg_temp.d_custody(p_placement public.qorpera_company_machine_placements, p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_intent)
$$;
-- A task machine of 1 cpu, 2 GiB and 40 GiB in line for room: Alice's for her member (no starter run, as a member's start
-- makes it), of her company unless another is named.
create function pg_temp.d_add(p_name text, p_profile uuid default '92400000-0000-4000-8000-000000000010',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns uuid language sql as $$
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	values (extensions.gen_random_uuid(), p_profile, p_environment, p_name, 'Work for ' || p_name, '92400000-0000-4000-8000-000000000030',
		null, null, pg_temp.d_requester(), 1, 2147483648, 42949672960, 'standard', 'task')
	returning id
$$;
-- It runs: admitted, the executor's custody to run, the guest's mark of a boot.
create function pg_temp.d_run(p_name text) returns void language plpgsql as $$
declare v jsonb;
begin
	if (pg_temp.d_current(p_name)).id is null then perform pg_temp.d_admit(); end if;
	v := pg_temp.d_custody(pg_temp.d_current(p_name), 'run');
	perform pg_temp.base_assert(v ->> 'intent' = 'run', p_name || ' may run: ' || coalesce(v::text, 'null'));
	v := public.qorpera_mark_company_machine_running((pg_temp.d_current(p_name)).id, (pg_temp.d_current(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.d_current(p_name)).binding), repeat('c', 64), extensions.gen_random_uuid());
	perform pg_temp.base_assert(v #>> '{machine,state}' = 'running', p_name || ' runs: ' || v::text);
end
$$;
-- It sleeps on its disk (the kernel's idle stop, the executor's power-off), asleep and last used p_ago ago.
create function pg_temp.d_sleep(p_name text, p_ago interval) returns void language plpgsql as $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.d_current(p_name); v jsonb;
begin
	perform public.qorpera_set_company_machine_desired(pg_temp.d_machine(p_name), 'stopped', 'kernel');
	v := pg_temp.d_custody(v_placement, 'stop');
	perform pg_temp.base_assert(v ->> 'intent' = 'stop', p_name || ' may stop: ' || coalesce(v::text, 'null'));
	v := public.qorpera_suspend_company_machine(v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256);
	perform pg_temp.base_assert(v ->> 'state' = 'suspended', p_name || ' sleeps: ' || v::text);
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() - p_ago where allocation_id = v_placement.id;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - p_ago where id = v_placement.machine_id;
end
$$;
-- The executor deleted a retired placement's VM and disk: its custody to delete, then the release.
create function pg_temp.d_removed(p_name text) returns void language plpgsql as $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.d_latest(p_name); v jsonb;
begin
	perform pg_temp.base_assert(v_placement.retired_at is not null and v_placement.removed_at is null, p_name || ' is being deleted');
	perform pg_temp.d_custody(v_placement, 'delete');
	v := public.qorpera_release_company_machine(v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256);
	perform pg_temp.base_assert(v ->> 'state' = 'released', p_name || ' released: ' || v::text);
end
$$;
-- The executor's report of its pool: total and used GiB, and each named machine's latest disk's own GiB.
create function pg_temp.d_report(p_total bigint, p_used bigint, p_use jsonb) returns jsonb language sql as $$
	select public.qorpera_report_executor_disk('mx-1253', repeat('c', 64), jsonb_build_object(
		'schema','qorpera.machine-executor-disk/v1','pool','machines','totalBytes',pg_temp.g(p_total),'usedBytes',pg_temp.g(p_used),
		'placements',coalesce((select jsonb_object_agg((pg_temp.d_latest(entry.key)).id::text, pg_temp.g((entry.value::text)::bigint))
			from jsonb_each(p_use) entry), '{}'::jsonb)))
$$;
create function pg_temp.d_room() returns bigint language sql as $$ select public.qorpera_machine_executor_disk_room('mx-1253') $$;
-- Which of the named machines lost their disk (a retired placement), in name order.
create function pg_temp.d_freed(p_names text[]) returns text language sql as $$
	select coalesce(string_agg(name, ',' order by name), '') from unnest(p_names) name
	where (pg_temp.d_latest(name)).retired_at is not null
$$;
create function pg_temp.d_view(p_name text) returns jsonb language sql as $$
	select public.qorpera_company_machine_view(pg_temp.d_machine(p_name))
$$;
-- 628's machine_start of Alice's run (as 1241's b1_start).
create function pg_temp.d_start(p_key text, p_name text) returns jsonb language plpgsql as $$
declare v_receipt uuid := extensions.gen_random_uuid();
	v_envelope text := jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.d_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey',p_key,
			'arguments',jsonb_build_object('name', p_name, 'purpose', 'Work for ' || p_name, 'cpus', 1, 'memoryGiB', 2, 'diskGiB', 40,
				'lifetime', 'task'),
			'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text;
	v_sha text := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'); v_result jsonb;
begin
	perform public.qorpera_native_machine_start(pg_temp.d_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.d_binding(), v_receipt, 'machine_start:' || p_key, v_sha, repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.d_binding(), v_envelope, 'begin', v_receipt, repeat('9', 64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.d_binding(), v_receipt, v_sha,
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', v_sha,
			'content', jsonb_build_object('kind', 'json', 'value', v_result)));
	return v_result;
end
$$;

-- The node, its machine provider and executor (300 GiB on paper to begin), and another company.
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12530000-0000-4000-8000-000000000410','machineIdSha256',repeat('c',64),'label','machine-d','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12530000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.d_observe();
	perform public.qorpera_enroll_runtime_node_provider('12530000-0000-4000-8000-000000000410', repeat('c',64), 'machine', 'machine-1253',
		repeat('f',64), 8000, 34359738368);
	perform pg_temp.d_budget(300);
	-- Another company on the company folder (as 1234 makes one).
	insert into auth.users(id, email) values ('12530000-0000-4000-8000-000000000001', 'other-owner@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values ('12530000-0000-4000-8000-000000000010', 'Another company', '12530000-0000-4000-8000-000000000001');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values ('12530000-0000-4000-8000-000000000010', '12530000-0000-4000-8000-000000000001', 'other-owner@example.test', 'Other',
		'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('12530000-0000-4000-8000-000000000020', '12530000-0000-4000-8000-000000000010', 'Environment', 1,
		'12530000-0000-4000-8000-000000000001');
	perform public.qorpera_folder_enable('12530000-0000-4000-8000-000000000020');
	-- Three machines that ran and sleep on their disks.
	perform pg_temp.d_add('b-old', '12530000-0000-4000-8000-000000000010', '12530000-0000-4000-8000-000000000020');
	perform pg_temp.d_run('b-old');
	perform pg_temp.d_sleep('b-old', interval '5 days');
	perform pg_temp.d_add('a-old');
	perform pg_temp.d_run('a-old');
	perform pg_temp.d_sleep('a-old', interval '3 days');
	perform pg_temp.d_add('a-new');
	perform pg_temp.d_run('a-new');
	perform pg_temp.d_sleep('a-new', interval '2 hours');
	-- Full on paper: the budget is exactly what their placements claim.
	perform pg_temp.d_budget(120);
	perform pg_temp.base_assert(public.qorpera_machine_executor_disk_used('mx-1253') = pg_temp.g(120) and pg_temp.d_room() = 0,
		'setup: three sleeping disks fill the paper budget');
end $$;

-- 1. Full on paper, real room: nothing is deleted ----------------------------------------------------------------------------
do $$
declare v jsonb; v_paper text; v_paper_room bigint; v_count integer;
begin
	-- The executor's report: a 1000 GiB pool with 300 GiB used. Room: 1000 - 300 - 200 (a fifth) - 0 (nothing awake).
	v := pg_temp.d_report(1000, 300, '{"a-old":30,"a-new":1,"b-old":20}');
	perform pg_temp.base_assert(v ->> 'state' = 'recorded' and (v ->> 'roomBytes')::bigint = pg_temp.g(500) and pg_temp.d_room() = pg_temp.g(500),
		'1: the room on real figures: ' || v::text);
	-- The same without a fresh report (taken back after): the paper rule gives a disk away, as before, but Alice's own old
	-- one, not the other company's that slept longest.
	begin
		update public.qorpera_machine_executor_disks set reported_at = now() - interval '3 minutes' where owner = 'mx-1253';
		v_paper_room := pg_temp.d_room();
		perform pg_temp.d_add('n-paper');
		perform pg_temp.d_admit();
		v_paper := pg_temp.d_freed(array['a-new','a-old','b-old']) || '/' || ((pg_temp.d_machine('a-old')).disk_freed_at is not null)::text;
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_paper_room = 0 and v_paper = 'a-old/true', '1: on paper a disk goes: ' || v_paper_room || ' ' || v_paper);
	perform pg_temp.base_assert(pg_temp.d_freed(array['a-new','a-old','b-old']) = '' and (pg_temp.d_machine('n-paper')).id is null,
		'1: taken back');
	-- With the report: Alice's new machine is placed, and no sleeping disk goes.
	perform pg_temp.d_add('n1');
	perform pg_temp.d_observe();
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_machine_candidates(1000, 2147483648, pg_temp.g(40))
		where owner = 'mx-1253'), '1: the executor is a candidate for 40 GiB');
	v_count := pg_temp.d_admit();
	if v_count <> 1 or (pg_temp.d_current('n1')).id is null then
		raise exception '1: n1 is not placed: % % %', v_count, pg_temp.d_view('n1'),
			public.qorpera_admit_company_machine((pg_temp.d_machine('n1')).id, 'mx-1253'); end if;
	perform pg_temp.base_assert(pg_temp.d_freed(array['a-new','a-old','b-old']) = ''
		and (select count(*) from public.qorpera_company_machines where disk_freed_at is not null) = 0, '1: no disk was given away');
	-- n1 is awake: what it could grow into (its whole 40 GiB, not in the report yet) is held back.
	perform pg_temp.base_assert(pg_temp.d_room() = pg_temp.g(460), '1: n1''s growth is held: ' || pg_temp.d_room());
	-- n1 runs, writes and falls asleep after the report (taken back after): what it may have written is held until a
	-- report taken 30 s after it slept or later (review r1 F1 of #1773); then only what that report says it holds.
	begin
		perform pg_temp.d_run('n1');
		perform pg_temp.d_sleep('n1', interval '0 seconds');
		v_paper_room := pg_temp.d_room();
		update public.qorpera_runtime_node_demands set suspended_at = (select reported_at - interval '31 seconds'
			from public.qorpera_machine_executor_disks where owner = 'mx-1253')
		where allocation_id = (pg_temp.d_current('n1')).id;
		v := to_jsonb(pg_temp.d_room());
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_paper_room = pg_temp.g(460) and v = to_jsonb(pg_temp.g(500)),
		'1: asleep after the report, its growth stays held; asleep before it, not: ' || v_paper_room || ' ' || v::text);
	-- n1 deleted while awake (taken back after): until its disk is gone, what it may have written stays held.
	begin
		perform public.qorpera_set_company_machine_desired(pg_temp.d_machine('n1'), 'deleted', 'agent');
		v := to_jsonb(pg_temp.d_room());
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v = to_jsonb(pg_temp.g(460)), '1: an awake disk being deleted stays held: ' || v::text);
end $$;

-- 2. Real pressure: the right disk goes, only it, and the row says so ---------------------------------------------------------
do $$
declare v jsonb; v_count integer;
begin
	-- 1000 - 735 - 200 - 40 (n1) = 25 GiB: a 40 GiB machine does not fit.
	v := pg_temp.d_report(1000, 735, '{"a-old":30,"a-new":1,"b-old":20,"n1":0}');
	perform pg_temp.base_assert((v ->> 'roomBytes')::bigint = pg_temp.g(25), '2: 25 GiB of room: ' || v::text);
	perform pg_temp.d_observe();
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_candidates(1000, 2147483648, pg_temp.g(40))
		where owner = 'mx-1253')
		and exists (select 1 from public.qorpera_company_machine_candidates(1000, 2147483648, pg_temp.g(20)) where owner = 'mx-1253'),
		'2: a candidate for 20 GiB, not for 40');
	perform pg_temp.d_add('n2');
	v := public.qorpera_place_company_machine((pg_temp.d_machine('n2')).id, 'mx-1253');
	perform pg_temp.base_assert(v ->> 'reason' = 'NODE_DISK_EXHAUSTED', '2: placement refuses: ' || v::text);
	-- Were a-old's use unknown (taken back after): it is passed over, never given for room; b-old makes the room.
	begin
		perform pg_temp.d_report(1000, 735, '{"a-new":1,"b-old":20,"n1":0}');
		v_count := pg_temp.d_admit();
		v := to_jsonb(pg_temp.d_freed(array['a-new','a-old','b-old']));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v = '"b-old"'::jsonb, '2: a disk of unknown use is passed over: ' || v::text);
	-- Were another node able to take n2 now (taken back after): this node's pass gives no disk away (review r1 F3 of #1773).
	begin
		perform pg_temp.d_node_b();
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_machine_candidates(1000, 2147483648, pg_temp.g(40))
			where owner = 'mx-1253e'), '2: the other node takes 40 GiB now');
		v_count := pg_temp.d_admit();
		v := to_jsonb(pg_temp.d_freed(array['a-new','a-old','b-old']));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v = '""'::jsonb, '2: no disk goes while another node takes it: ' || v::text);
	-- Need 15 GiB: a-old (Alice's own, unused for 3 days, holds 30) goes; b-old (another company's, asleep longest) and
	-- a-new (used 2 hours ago) stay.
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 0 and (pg_temp.d_current('n2')).id is null, '2: n2 waits for the deletion');
	perform pg_temp.base_assert(pg_temp.d_freed(array['a-new','a-old','b-old']) = 'a-old', '2: only a-old''s disk goes: '
		|| pg_temp.d_freed(array['a-new','a-old','b-old']));
	perform pg_temp.base_assert((pg_temp.d_machine('a-old')).disk_freed_at between now() and clock_timestamp()
		and (pg_temp.d_machine('a-old')).desired_state = 'stopped'
		and (pg_temp.d_machine('b-old')).disk_freed_at is null and (pg_temp.d_machine('a-new')).disk_freed_at is null,
		'2: a-old''s row says when its disk was freed');
	-- The executor deletes it; until a report after that, it still counts as coming free: no second disk goes.
	perform pg_temp.d_removed('a-old');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 0 and pg_temp.d_freed(array['a-new','b-old']) = '',
		'2: the same shortage takes no second disk');
	-- The next report sees the room: 1000 - 705 - 200 - 40 = 55 GiB.
	v := pg_temp.d_report(1000, 705, '{"a-new":1,"b-old":20,"n1":0}');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 1 and (pg_temp.d_current('n2')).id is not null
		and pg_temp.d_freed(array['a-new','b-old']) = '', '2: n2 is placed, nothing more given away');
end $$;

-- 3. Nothing goes when it would not help; never a recent one while an older one can go -----------------------------------------
do $$
declare v jsonb; v_count integer;
begin
	-- a-old's deletion is long done (a minute before the reports below): it no longer counts as coming free.
	update public.qorpera_company_machine_placements set removed_at = removed_at - interval '1 minute',
		removing_at = removing_at - interval '1 minute', retired_at = retired_at - interval '1 minute'
	where id = (pg_temp.d_latest('a-old')).id;
	-- 1000 - 900 - 200 - 80 (n1, n2) = -180 GiB: all sleeping disks together (21 GiB) would not make the room.
	v := pg_temp.d_report(1000, 900, '{"a-new":1,"b-old":20,"n1":0,"n2":0}');
	perform pg_temp.base_assert((v ->> 'roomBytes')::bigint = pg_temp.g(-180), '3: -180 GiB: ' || v::text);
	perform pg_temp.d_add('n3');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 0 and pg_temp.d_freed(array['a-new','b-old']) = ''
		and pg_temp.d_view('n3') ->> 'state' = 'waiting', '3: n3 waits in line, nothing is given away: ' || pg_temp.d_view('n3')::text);
	-- A report that names no disk at all (its reads ran out of time; taken back after): the awake n1 and n2 count whole,
	-- and no sleeping disk of unknown use is given away, though 20 GiB are short.
	begin
		perform pg_temp.d_report(1000, 700, '{}');
		v := to_jsonb(pg_temp.d_room());
		v_count := pg_temp.d_admit();
		v := v || to_jsonb(pg_temp.d_freed(array['a-new','b-old']));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v = jsonb_build_array(pg_temp.g(20), ''), '3: a report that names nothing: ' || v::text);
	-- 20 GiB of room, need 20: b-old would make it, but its use is not in the report: it is never given for room.
	perform pg_temp.d_report(1000, 700, '{"a-new":1,"n1":0,"n2":0}');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 0 and pg_temp.d_freed(array['a-new','b-old']) = '',
		'3: a disk of unknown use is not given away');
	-- With its use known, but a-old's deletion only 10 s before the report (taken back after): ZFS may not have freed its
	-- space yet, so it still counts as coming free, and nothing more goes.
	begin
		update public.qorpera_company_machine_placements set removed_at = clock_timestamp()
		where id = (pg_temp.d_latest('a-old')).id;
		perform pg_temp.d_report(1000, 700, '{"a-new":1,"b-old":20,"n1":0,"n2":0}');
		update public.qorpera_machine_executor_disks set reported_at = reported_at + interval '10 seconds' where owner = 'mx-1253';
		v_count := pg_temp.d_admit();
		v := to_jsonb(pg_temp.d_freed(array['a-new','b-old']));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v = '""'::jsonb, '3: a deletion 10 s before the report still counts as coming free: ' || v::text);
	-- With its use known: b-old (another company's, unused for 5 days) goes before a-new (Alice's own, used 2 hours ago).
	perform pg_temp.d_report(1000, 700, '{"a-new":1,"b-old":20,"n1":0,"n2":0}');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 0 and pg_temp.d_freed(array['a-new','b-old']) = 'b-old'
		and (pg_temp.d_machine('b-old')).disk_freed_at is not null, '3: an old one before a recent one of the asking company''s own: '
		|| pg_temp.d_freed(array['a-new','b-old']));
	perform pg_temp.d_removed('b-old');
	perform pg_temp.d_report(1000, 680, '{"a-new":1,"n1":0,"n2":0}');
	v_count := pg_temp.d_admit();
	perform pg_temp.base_assert(v_count = 1 and (pg_temp.d_current('n3')).id is not null
		and pg_temp.d_freed(array['a-new']) = '', '3: n3 is placed; a-new keeps its disk');
end $$;

-- 4. Without a fresh report: the paper budget, never "no limit" ----------------------------------------------------------------
do $$
declare v_real bigint := pg_temp.d_room(); v_paper bigint := pg_temp.g(120) - public.qorpera_machine_executor_disk_used('mx-1253');
begin
	perform pg_temp.base_assert(v_real = pg_temp.g(1000 - 680 - 200 - 120) and v_paper = pg_temp.g(-40), '4: real ' || v_real || ', paper ' || v_paper);
	begin
		update public.qorpera_machine_executor_disks set reported_at = now() - interval '121 seconds' where owner = 'mx-1253';
		perform pg_temp.base_assert(pg_temp.d_room() = v_paper, '4: a report older than 2 minutes: paper');
		update public.qorpera_machine_executor_disks set reported_at = now() - interval '119 seconds' where owner = 'mx-1253';
		perform pg_temp.base_assert(pg_temp.d_room() = v_real, '4: one younger than 2 minutes: real');
		update public.qorpera_machine_executor_disks set pool = 'other-pool' where owner = 'mx-1253';
		perform pg_temp.base_assert(pg_temp.d_room() = v_paper, '4: a report of another pool: paper');
		delete from public.qorpera_machine_executor_disks where owner = 'mx-1253';
		perform pg_temp.base_assert(pg_temp.d_room() = v_paper, '4: no report: paper');
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(pg_temp.d_room() = v_real, '4: taken back');
end $$;

-- 5. What the agent sees ---------------------------------------------------------------------------------------------------
do $$
declare v jsonb;
begin
	-- a-old and b-old sleep without a disk: their view says so; a-new and n1 keep theirs and say nothing.
	perform pg_temp.base_assert(pg_temp.d_view('a-old') ->> 'state' = 'stopped'
		and pg_temp.d_view('a-old') ->> 'diskFreed' like 'its disk was freed while it slept (____-__-__ __:__ UTC): it comes back with an empty disk, so what was on it before is gone; the company''s files are kept'
		and pg_temp.d_view('b-old') ->> 'diskFreed' like 'its disk was freed while it slept%',
		'5: the view of a machine without its disk: ' || pg_temp.d_view('a-old')::text);
	perform pg_temp.base_assert(pg_temp.d_view('a-new') ? 'diskFreed' and pg_temp.d_view('a-new') -> 'diskFreed' = 'null'::jsonb
		and pg_temp.d_view('n1') -> 'diskFreed' = 'null'::jsonb, '5: one that keeps its disk says nothing');
	-- Through machine_manage: status and list.
	v := public.qorpera_native_machine_manage(pg_temp.d_binding(), '{"action":"status","machine":"a-old"}');
	perform pg_temp.base_assert(v #>> '{machine,diskFreed}' like 'its disk was freed while it slept%', '5: status: ' || v::text);
	v := public.qorpera_native_machine_manage(pg_temp.d_binding(), '{"action":"list"}');
	perform pg_temp.base_assert((select count(*) from jsonb_array_elements(v -> 'machines') m
		where m ->> 'name' = 'a-old' and m ->> 'diskFreed' like 'its disk was freed%') = 1, '5: list: ' || v::text);
	-- Alice asks for a new task machine named a-old: her own free machine that still holds its disk (a-new) comes first,
	-- before the one of the asked name whose disk was freed.
	v := pg_temp.d_start('take-1', 'a-old');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'a-new' and v ->> 'reused' like 'your own free machine a-new %'
		and v ->> 'reused' not like '%freed%' and v #> '{machine,diskFreed}' = 'null'::jsonb, '5: a-new is given: ' || v::text);
	-- Again: a-new is her run's now; a-old is given, and the answer says it starts empty.
	v := pg_temp.d_start('take-2', 'next-task');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'a-old'
		and v ->> 'reused' = 'your own free machine a-old of this size was given to you again instead of a new one: use the name a-old. '
			|| 'Its disk was freed while it slept, so it starts with an empty disk: what you left on it is gone'
		and v #>> '{machine,diskFreed}' like 'its disk was freed while it slept%', '5: a-old is given, said empty: ' || v::text);
	-- Room for it: on its first new disk the view still says so, running too; once it slept there, no more.
	perform pg_temp.d_report(1000, 400, '{"a-new":1,"n1":0,"n2":0,"n3":0}');
	perform pg_temp.d_admit();
	perform pg_temp.base_assert((pg_temp.d_current('a-old')).id is not null
		and pg_temp.d_view('a-old') ->> 'diskFreed' like 'its disk was freed%', '5: on its new disk: ' || pg_temp.d_view('a-old')::text);
	perform pg_temp.d_run('a-old');
	perform pg_temp.base_assert(pg_temp.d_view('a-old') ->> 'state' = 'running'
		and pg_temp.d_view('a-old') ->> 'diskFreed' like 'its disk was freed%', '5: running on it: ' || pg_temp.d_view('a-old')::text);
	perform pg_temp.d_sleep('a-old', interval '1 minute');
	perform pg_temp.base_assert(pg_temp.d_view('a-old') -> 'diskFreed' = 'null'::jsonb
		and (pg_temp.d_machine('a-old')).disk_freed_at is not null, '5: asleep on its new disk: nothing to say; the row keeps when');
	update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp()
	where name = 'a-old' and removed_at is null;
	perform pg_temp.base_assert(pg_temp.d_view('a-old') -> 'diskFreed' = 'null'::jsonb, '5: woken on it again: nothing to say');
end $$;

-- 5b. An executor given up and an operator's release: a sleeping machine's agent is told (review r1 F4 of #1773) ----------
do $$
declare v jsonb; v_lost text; v_released text;
begin
	-- n3 runs and sleeps; its server is given up (taken back after): n3 says its disk was freed, n2 (awake: its commands
	-- are told lost) does not; taken again (on another node), the answer says it starts empty.
	begin
		perform pg_temp.d_run('n3');
		perform pg_temp.d_sleep('n3', interval '1 hour');
		perform pg_temp.d_budget(120, repeat('a', 64), false);
		perform public.qorpera_abandon_machine_executor('mx-1253', repeat('c', 64));
		v_lost := concat_ws(' | ', ((pg_temp.d_machine('n3')).disk_freed_at is not null)::text,
			((pg_temp.d_machine('n2')).disk_freed_at is null)::text, pg_temp.d_view('n3') ->> 'state',
			left(pg_temp.d_view('n3') ->> 'diskFreed', 33));
		-- Another node runs machines meanwhile: the one taken again starts there, on a new disk.
		perform pg_temp.d_node_b();
		v := pg_temp.d_start('take-3', 'after-loss');
		v_lost := concat_ws(' | ', v_lost, v #>> '{machine,name}', v #>> '{machine,state}', left(v #>> '{machine,diskFreed}', 33),
			v ->> 'reused');
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_lost = 'true | true | stopped | its disk was freed while it slept | n3 | starting | '
		|| 'its disk was freed while it slept | your own free machine n3 of this size was given to you again instead of a new one: use the name n3. '
		|| 'Its disk was freed while it slept, so it starts with an empty disk: what you left on it is gone',
		'5b: an executor given up: ' || v_lost);
	-- An operator releases n3's placement while it sleeps (its allocation released first; taken back after).
	begin
		perform pg_temp.d_run('n3');
		perform pg_temp.d_sleep('n3', interval '1 hour');
		update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = (pg_temp.d_current('n3')).id;
		v := public.qorpera_release_company_machine((pg_temp.d_current('n3')).id, 'mx-1253',
			public.qorpera_company_machine_binding_text((pg_temp.d_current('n3')).binding), repeat('c', 64));
		v_released := concat_ws(' | ', v ->> 'state', ((pg_temp.d_machine('n3')).disk_freed_at is not null)::text,
			left(pg_temp.d_view('n3') ->> 'diskFreed', 33));
		raise exception 'take back' using errcode = 'P0D01';
	exception when sqlstate 'P0D01' then null;
	end;
	perform pg_temp.base_assert(v_released = 'released | true | its disk was freed while it slept', '5b: an operator''s release: '
		|| v_released);
	perform pg_temp.base_assert((pg_temp.d_machine('n3')).disk_freed_at is null, '5b: taken back');
end $$;

-- 6. A wake that moves a sleeping machine to a new disk says so too ---------------------------------------------------------
do $$
declare v jsonb; v_old uuid;
begin
	perform pg_temp.d_run('n1');
	perform pg_temp.d_sleep('n1', interval '1 hour');
	v_old := (pg_temp.d_current('n1')).id;
	-- Its executor in another project (a new image alone keeps the disk since 20260930760000, test 1257): a machine asleep
	-- in the old one wakes on a new disk.
	perform public.qorpera_configure_machine_executor('mx-1253', repeat('c',64), true, pg_temp.d_policy() || '{"project":"machines-b"}',
		pg_temp.g(120));
	perform pg_temp.d_report(1000, 400, '{"a-new":1,"n1":0,"n2":0,"n3":0,"a-old":0}');
	update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp()
	where name = 'n1' and removed_at is null;
	perform pg_temp.d_observe();
	v := public.qorpera_admit_company_machine((pg_temp.d_machine('n1')).id);
	perform pg_temp.base_assert(v ->> 'state' = 'reserved' and (pg_temp.d_current('n1')).id <> v_old
		and (select retired_at is not null from public.qorpera_company_machine_placements where id = v_old), '6: n1 moved: ' || v::text);
	perform pg_temp.base_assert((pg_temp.d_machine('n1')).disk_freed_at is not null
		and pg_temp.d_view('n1') ->> 'diskFreed' like 'its disk was freed while it slept%', '6: and is told: ' || pg_temp.d_view('n1')::text);
end $$;

-- 7. The report's checks, what is internal, the markers ----------------------------------------------------------------------
do $$
declare v_at timestamptz := (select reported_at from public.qorpera_machine_executor_disks where owner = 'mx-1253');
	v_good jsonb := jsonb_build_object('schema','qorpera.machine-executor-disk/v1','pool','machines','totalBytes',pg_temp.g(1000),
		'usedBytes',pg_temp.g(400),'placements',jsonb_build_object((pg_temp.d_latest('n2')).id::text, 1024));
	v_bad jsonb; v_many jsonb;
begin
	select jsonb_object_agg(extensions.gen_random_uuid()::text, 1) into v_many from generate_series(1, 1025);
	foreach v_bad in array array[
		'[]'::jsonb, '"x"'::jsonb, v_good - 'placements', v_good || '{"extra":1}', v_good || '{"schema":"qorpera.machine-executor-disk/v2"}',
		v_good || '{"pool":"other-pool"}', v_good || '{"totalBytes":"1000"}', v_good || '{"totalBytes":0}',
		v_good || jsonb_build_object('usedBytes', pg_temp.g(1001)), v_good || '{"usedBytes":1.5}', v_good || '{"usedBytes":-1}',
		v_good || '{"totalBytes":90071992547409920}', v_good || '{"placements":[]}', v_good || '{"placements":{"not-a-uuid":1}}',
		v_good || jsonb_build_object('placements', jsonb_build_object(extensions.gen_random_uuid()::text, pg_temp.g(1001))),
		v_good || jsonb_build_object('placements', jsonb_build_object(extensions.gen_random_uuid()::text, -1)),
		v_good || jsonb_build_object('placements', jsonb_build_object(extensions.gen_random_uuid()::text, '1')),
		v_good || jsonb_build_object('placements', v_many)] loop
		perform pg_temp.base_error(format('select public.qorpera_report_executor_disk(%L, %L, %L::jsonb)', 'mx-1253', repeat('c', 64),
			v_bad), '22023');
	end loop;
	perform pg_temp.base_error(format('select public.qorpera_report_executor_disk(%L, %L, %L::jsonb)', 'mx-1253', repeat('d', 64), v_good),
		'42501');
	perform pg_temp.base_error(format('select public.qorpera_report_executor_disk(%L, %L, %L::jsonb)', 'mx-none', repeat('c', 64), v_good),
		'42501');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_report_executor_disk(%L, %L, %L::jsonb)', 'mx-1253', repeat('c', 64), v_good),
		'42501');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert((select reported_at from public.qorpera_machine_executor_disks where owner = 'mx-1253') = v_at,
		'7: a refused report writes nothing');
	v_bad := public.qorpera_report_executor_disk('mx-1253', repeat('c', 64), v_good);
	perform pg_temp.base_assert(v_bad ->> 'state' = 'recorded'
		and (select placement_used = v_good -> 'placements' and total_bytes = pg_temp.g(1000) and used_bytes = pg_temp.g(400)
			and pool = 'machines' and reported_at > v_at from public.qorpera_machine_executor_disks where owner = 'mx-1253'),
		'7: a good one is kept whole: ' || v_bad::text);
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_report_executor_disk(text,text,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_report_executor_disk(text,text,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_report_executor_disk(text,text,jsonb)', 'execute'),
		'7: the report is the executor''s (service role) alone');
	perform pg_temp.base_assert(not exists (select 1 from unnest(array[
			'public.qorpera_machine_executor_disk_report(text)',
			'public.qorpera_machine_executor_disk_frees(public.qorpera_machine_executor_disks,uuid,bigint)',
			'public.qorpera_machine_executor_disk_room(text,uuid)',
			'public.qorpera_company_machine_disk_freed(public.qorpera_company_machines)']) fn, unnest(array['anon','authenticated','service_role']) role
		where has_function_privilege(role, fn, 'execute')), '7: the helpers are internal');
	perform pg_temp.base_assert(not has_table_privilege('service_role', 'public.qorpera_machine_executor_disks', 'select')
		and not has_table_privilege('authenticated', 'public.qorpera_machine_executor_disks', 'select'), '7: the table is internal');
end $$;

rollback;
