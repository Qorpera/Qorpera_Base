begin;

insert into auth.users(id, email) values
	('13360000-0000-4000-8000-000000000001', 'snapshots-1336-a@example.test'),
	('13360000-0000-4000-8000-000000000002', 'snapshots-1336-b@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13360000-0000-4000-8000-000000000010', 'Coding snapshots 5h', '13360000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('13360000-0000-4000-8000-000000000010', '13360000-0000-4000-8000-000000000001', 'snapshots-1336-a@example.test', 'Owner', 'owner'),
	('13360000-0000-4000-8000-000000000010', '13360000-0000-4000-8000-000000000002', 'snapshots-1336-b@example.test', 'Member B', 'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('13360000-0000-4000-8000-000000000020', '13360000-0000-4000-8000-000000000010', 'Environment', 1,
	'13360000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('13360000-0000-4000-8000-000000000020') \g /dev/null

set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('13360000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-1336', 'UTF8')), 'hex'), 'node-1336', 1, 32000,
	137438953472, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
values ('13360000-0000-4000-8000-0000000000e1', '13360000-0000-4000-8000-0000000000e2', clock_timestamp(),
	'{"state":"ready","cpuMillis":32000,"memoryBytes":137438953472}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('13360000-0000-4000-8000-0000000000e1', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
values ('13360000-0000-4000-8000-0000000000e1', '13360000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('coding', 'coding-1336', '13360000-0000-4000-8000-0000000000e1', repeat('d', 64), 2000, 4294967296);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy,
	session_cpu_millis, session_memory_bytes, max_attached_sessions)
values ('13360000-0000-4000-8000-000000000020', 'exec-1336', true, array['codex'], encode(sha256(convert_to('node-1336', 'UTF8')), 'hex'),
	jsonb_build_object('providerId', 'coding-1336', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
		'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
		'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
	'{"rootPath":"/nas/coding"}', 1000, 2147483648, 2);
insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled) values
	('13360000-0000-4000-8000-000000000020', '13360000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true),
	('13360000-0000-4000-8000-000000000020', '13360000-0000-4000-8000-0000000000a2',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true),
	('13360000-0000-4000-8000-000000000020', '13360000-0000-4000-8000-0000000000a3',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('13360000-0000-4000-8000-0000000000c' || n)::uuid, '13360000-0000-4000-8000-000000000010', '13360000-0000-4000-8000-000000000020',
	case when n in (1, 2, 3) then '13360000-0000-4000-8000-0000000000a1'::uuid
		when n in (4, 5, 6) then '13360000-0000-4000-8000-0000000000a2'::uuid
		else '13360000-0000-4000-8000-0000000000a3'::uuid end,
	extensions.gen_random_uuid(), 'w-1336-' || n, 'coding', 'Code ' || n, 'read', 'each', '{}',
	case when n = 9 then '13360000-0000-4000-8000-000000000002'::uuid else '13360000-0000-4000-8000-000000000001'::uuid end,
	extensions.gen_random_uuid(),
	case when n = 9 then '13360000-0000-4000-8000-000000000002'::uuid else '13360000-0000-4000-8000-000000000001'::uuid end,
	extensions.gen_random_uuid(), 1
from generate_series(1, 9) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at)
select ('13360000-0000-4000-8000-0000000000c' || n)::uuid, '13360000-0000-4000-8000-000000000010', '13360000-0000-4000-8000-000000000020',
	'codex', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/coding/1336-' || n, 'preparing', 'exec-1336',
	extensions.gen_random_uuid(), clock_timestamp() + interval '30 minutes', clock_timestamp()
from generate_series(1, 9) n;
set local session_replication_role = origin;

create function pg_temp.ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '1336 coding snapshots 5h: %', p_message; end if; end $$;
create function pg_temp.node() returns text language sql as $$ select encode(sha256(convert_to('node-1336', 'UTF8')), 'hex') $$;
create function pg_temp.worker(p_n integer) returns uuid language sql as $$ select ('13360000-0000-4000-8000-0000000000c' || p_n)::uuid $$;
create function pg_temp.lease(p_n integer) returns uuid language sql as $$
	select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)
$$;
create function pg_temp.plan(p_n integer, p_digest text) returns jsonb language sql as $$
	select public.qorpera_plan_coding_machine(pg_temp.worker(p_n), pg_temp.lease(p_n), pg_temp.node(), p_digest)
$$;

select pg_temp.ok(
	bool_and(has_function_privilege('service_role', fn, 'execute'))
		and not bool_or(has_function_privilege('anon', fn, 'execute'))
		and not bool_or(has_function_privilege('authenticated', fn, 'execute')),
	'new 5h RPCs are service_role-only'
)
from unnest(array[
	'public.qorpera_claim_coding_snapshot_build(uuid,uuid,text,text,text,integer,integer)',
	'public.qorpera_complete_coding_snapshot_build(uuid,uuid,text,bigint,text,integer)',
	'public.qorpera_fail_coding_snapshot_build(uuid,uuid,text,text,boolean)',
	'public.qorpera_sweep_coding_snapshots(text,text,text)',
	'public.qorpera_fallback_coding_machine_base_image(uuid,uuid,uuid,text)'
]) fn;

select pg_temp.ok(
	not bool_or(has_function_privilege(role_name, 'public.qorpera_coding_machine_policy_matches(public.qorpera_coding_machines,jsonb)', 'execute')),
	'policy matcher helper is revoked from all roles'
)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;

select pg_temp.ok(
	position('20260930828000 (step 5k)' in obj_description('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, 'pg_proc')) > 0
		and position('20260930828000 (step 5k)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0
		and position('20260930394000 (step 5a)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0
		and position('20260930854000 (step 5h)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0
		and position('qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id'
			in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0,
	'qorpera_plan_coding_machine preserves 5a, 5k, 5h, and fence markers'
);

do $$
declare
	v_base_fp text := repeat('f', 64);
	v_base_fp_v2 text := repeat('9', 64);
	v_digest_1 text := repeat('1', 64);
	v_digest_2 text := repeat('2', 64);
	v_commit_1 text := repeat('a', 40);
	v_commit_2 text := repeat('b', 40);
	v_snap_fp_1 text := repeat('7', 64);
	v_snap_fp_2 text := repeat('8', 64);
	v_plan jsonb;
	v_claim jsonb;
	v_claim_wait jsonb;
	v_done jsonb;
	v_done_retry jsonb;
	v_fail jsonb;
	v_sweep jsonb;
	v_fallback jsonb;
	v_build_id uuid;
	v_build_lease uuid;
	v_machine_1 uuid;
	v_machine_snap uuid;
	v_machine_overflow uuid;
	v_alloc_sha text;
	v_mach_sha text;
begin
	v_plan := pg_temp.plan(1, null);
	perform pg_temp.ok(v_plan ->> 'state' = 'planned', 'empty setup plans cleanly');
	perform pg_temp.ok((v_plan -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'empty setup uses base image');
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = false, 'empty setup does not trigger snapshot build');
	perform pg_temp.ok(not (v_plan ? 'snapshotImageFingerprint'), 'empty setup omits snapshotImageFingerprint');

	v_plan := pg_temp.plan(2, v_digest_1);
	perform pg_temp.ok(v_plan ->> 'state' = 'planned', 'non-empty setup without snapshot plans on base image');
	perform pg_temp.ok((v_plan -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'missing snapshot falls back to base image');
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = true, 'missing snapshot sets snapshotBuildNeeded=true');
	perform pg_temp.ok(not (v_plan ? 'snapshotImageFingerprint'), 'missing snapshot omits snapshotImageFingerprint');
	v_machine_1 := (v_plan ->> 'machineId')::uuid;

	v_claim := public.qorpera_claim_coding_snapshot_build(
		pg_temp.worker(2), pg_temp.lease(2), pg_temp.node(), v_digest_1, v_commit_1, 120, 3600
	);
	perform pg_temp.ok(v_claim ->> 'state' = 'claimed', 'first claim starts build');
	perform pg_temp.ok((v_claim -> 'build' ->> 'baseImageFingerprint') = v_base_fp, 'claim binds executor base image fingerprint');
	v_build_id := (v_claim -> 'build' ->> 'buildId')::uuid;
	v_build_lease := (v_claim -> 'build' ->> 'leaseToken')::uuid;

	v_claim_wait := public.qorpera_claim_coding_snapshot_build(
		pg_temp.worker(3), pg_temp.lease(3), pg_temp.node(), v_digest_1, v_commit_1, 120, 3600
	);
	perform pg_temp.ok(v_claim_wait ->> 'state' = 'waiting', 'concurrent claim waits on in-flight build');

	v_plan := pg_temp.plan(3, v_digest_1);
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = false, 'in-flight build suppresses duplicate snapshotBuildNeeded');

	v_done := public.qorpera_complete_coding_snapshot_build(
		v_build_id, v_build_lease, v_snap_fp_1, 524288000, 'install ok', 3600
	);
	perform pg_temp.ok(v_done ->> 'state' = 'ready', 'complete transitions build to ready');
	perform pg_temp.ok((v_done ->> 'imageBytes')::bigint = 524288000, 'complete records image_bytes');
	perform pg_temp.ok(v_done ->> 'expiresAt' is not null, 'complete records expiresAt');

	v_done_retry := public.qorpera_complete_coding_snapshot_build(
		v_build_id, v_build_lease, v_snap_fp_1, 524288000, 'install ok', 3600
	);
	perform pg_temp.ok(v_done_retry ->> 'state' = 'ready', 'complete is idempotent');

	v_plan := pg_temp.plan(4, v_digest_1);
	perform pg_temp.ok(v_plan ->> 'state' = 'planned', 'new agent machine plans with ready snapshot');
	perform pg_temp.ok((v_plan -> 'binding' ->> 'imageFingerprint') = v_snap_fp_1, 'binding uses snapshot imageFingerprint');
	perform pg_temp.ok(v_plan ->> 'snapshotImageFingerprint' = v_snap_fp_1, 'plan returns snapshotImageFingerprint');
	perform pg_temp.ok(v_plan ->> 'snapshotId' = v_build_id::text, 'plan returns snapshotId');
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = false, 'ready snapshot sets snapshotBuildNeeded=false');
	v_machine_snap := (v_plan ->> 'machineId')::uuid;

	v_plan := pg_temp.plan(4, v_digest_1);
	perform pg_temp.ok((v_plan ->> 'machineId')::uuid = v_machine_snap, 're-planning snapshot machine keeps same machine without spurious retirement');
	perform pg_temp.ok(
		(select retire_requested_at is null from public.qorpera_coding_machines where id = v_machine_snap),
		'snapshot-backed machine does not retire when base policy matches'
	);

	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine_snap, attachment_token = extensions.gen_random_uuid(),
		attachment_turn = 1, attached_at = clock_timestamp(), attachment_until = clock_timestamp() + interval '5 minutes'
	where worker_id = pg_temp.worker(4);
	v_plan := pg_temp.plan(5, v_digest_1);
	perform pg_temp.ok((v_plan ->> 'machineId')::uuid = v_machine_snap, 'second session shares non-full snapshot machine');
	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine_snap, attachment_token = extensions.gen_random_uuid(),
		attachment_turn = 1, attached_at = clock_timestamp(), attachment_until = clock_timestamp() + interval '5 minutes'
	where worker_id = pg_temp.worker(5);
	v_plan := pg_temp.plan(6, v_digest_1);
	v_machine_overflow := (v_plan ->> 'machineId')::uuid;
	perform pg_temp.ok(v_machine_overflow <> v_machine_snap, '5k max_attached_sessions=2 overflows to second machine');
	perform pg_temp.ok((v_plan ->> 'snapshotImageFingerprint') = v_snap_fp_1, 'overflow machine also boots from ready snapshot');

	v_fallback := public.qorpera_fallback_coding_machine_base_image(
		pg_temp.worker(6), pg_temp.lease(6), v_machine_overflow, pg_temp.node()
	);
	perform pg_temp.ok((v_fallback -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'fallback rebinds unattached overflow machine to base image');
	perform pg_temp.ok(not (v_fallback ? 'snapshotImageFingerprint'), 'fallback plan omits snapshotImageFingerprint');
	select instance_sha256 into v_mach_sha from public.qorpera_coding_machines where id = v_machine_overflow;
	select instance_sha256 into v_alloc_sha from public.qorpera_runtime_machine_allocations where id = v_machine_overflow;
	perform pg_temp.ok(v_mach_sha = v_alloc_sha, 'fallback keeps machine and allocation instance_sha256 aligned');
	perform pg_temp.ok(
		(select state = 'retired' from public.qorpera_coding_snapshots where id = v_build_id),
		'fallback retires missing local snapshot'
	);

	v_fallback := public.qorpera_fallback_coding_machine_base_image(
		pg_temp.worker(6), pg_temp.lease(6), v_machine_overflow, pg_temp.node()
	);
	perform pg_temp.ok((v_fallback -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'fallback is idempotent on retry');

	v_claim := public.qorpera_claim_coding_snapshot_build(
		pg_temp.worker(7), pg_temp.lease(7), pg_temp.node(), v_digest_2, v_commit_1, 120, 3600
	);
	v_fail := public.qorpera_fail_coding_snapshot_build(
		(v_claim -> 'build' ->> 'buildId')::uuid, (v_claim -> 'build' ->> 'leaseToken')::uuid, 'SETUP_STEP_FAILED', 'boom', false
	);
	perform pg_temp.ok(v_fail ->> 'state' = 'failed', 'fail RPC marks snapshot build failed');
	v_plan := pg_temp.plan(7, v_digest_2);
	perform pg_temp.ok((v_plan -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'failed snapshot falls back cleanly to base image');
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = true, 'failed snapshot still signals snapshotBuildNeeded on base plan');

	v_claim := public.qorpera_claim_coding_snapshot_build(
		pg_temp.worker(7), pg_temp.lease(7), pg_temp.node(), v_digest_2, v_commit_2, 120, 3600
	);
	perform pg_temp.ok(v_claim ->> 'state' = 'claimed', 'new commit claims fresh build after prior commit failed');
	v_fail := public.qorpera_fail_coding_snapshot_build(
		(v_claim -> 'build' ->> 'buildId')::uuid, (v_claim -> 'build' ->> 'leaseToken')::uuid, 'BUILD_ABORTED', 'cancelled', true
	);
	perform pg_temp.ok(v_fail ->> 'state' = 'abandoned', 'abandoned flag transitions build to abandoned');
	v_claim := public.qorpera_claim_coding_snapshot_build(
		pg_temp.worker(7), pg_temp.lease(7), pg_temp.node(), v_digest_2, v_commit_2, 120, 3600
	);
	perform pg_temp.ok(v_claim ->> 'state' = 'claimed', 'abandoned build can be claimed again on same commit');
	v_done := public.qorpera_complete_coding_snapshot_build(
		(v_claim -> 'build' ->> 'buildId')::uuid, (v_claim -> 'build' ->> 'leaseToken')::uuid, v_snap_fp_2, 256000000, 'ok', 3600
	);
	update public.qorpera_coding_snapshots set expires_at = clock_timestamp() - interval '1 minute' where id = (v_claim -> 'build' ->> 'buildId')::uuid;

	v_plan := pg_temp.plan(8, v_digest_2);
	perform pg_temp.ok((v_plan -> 'binding' ->> 'imageFingerprint') = v_base_fp, 'expired snapshot is ignored in plan');
	perform pg_temp.ok((v_plan ->> 'snapshotBuildNeeded')::boolean = true, 'expired snapshot triggers rebuild');

	v_sweep := public.qorpera_sweep_coding_snapshots('exec-1336', pg_temp.node(), v_base_fp);
	perform pg_temp.ok((v_sweep ->> 'retiredSnapshots')::integer = 1, 'sweep retires expired snapshot');
	perform pg_temp.ok(
		exists (
			select 1 from jsonb_array_elements(v_sweep -> 'pruneImages') item
			where item ->> 'imageFingerprint' = v_snap_fp_2
		),
		'sweep lists unreferenced expired snapshot for LXD deletion'
	);
	perform pg_temp.ok(
		not exists (
			select 1 from jsonb_array_elements(v_sweep -> 'pruneImages') item
			where item ->> 'imageFingerprint' = v_snap_fp_1
		) and exists (
			select 1 from jsonb_array_elements_text(v_sweep -> 'keepImageFingerprints') fp
			where fp = v_snap_fp_1
		),
		'sweep protects retired snapshot still referenced by live machine'
	);

	update public.qorpera_coding_executors
	set vm_policy = vm_policy || jsonb_build_object('imageFingerprint', v_base_fp_v2)
	where environment_id = '13360000-0000-4000-8000-000000000020' and owner = 'exec-1336';
	v_plan := pg_temp.plan(4, v_digest_1);
	perform pg_temp.ok(v_plan ->> 'state' = 'refused' and v_plan ->> 'reason' = 'MACHINE_RETIRING', 'base image rollout retires attached snapshot machine');
end $$;

do $$
declare
	v_aux_node_id uuid := '13360000-0000-4000-8000-000000000099';
	v_aux_machine text := repeat('9', 64);
	v_ctx jsonb;
	v_obs jsonb;
	v_policy jsonb;
	v_builder jsonb;
	v_standby jsonb;
	v_ready boolean;
	v_failed boolean := false;
begin
	perform public.qorpera_configure_runtime_node(
		jsonb_build_object(
			'schema', 'qorpera.runtime-node-policy/v1',
			'nodeId', v_aux_node_id,
			'machineIdSha256', v_aux_machine,
			'label', 'node-aux-1336',
			'cpuMillis', 32000,
			'memoryBytes', 68719476736,
			'headroomCpuMillis', 10000,
			'headroomMemoryBytes', 17179869184,
			'standardCpuMillis', 4000,
			'standardMemoryBytes', 8589934592,
			'enabled', true
		),
		0
	);
	v_policy := jsonb_build_object(
		'schema', 'qorpera.runtime-node-inventory-policy/v1',
		'nodeId', v_aux_node_id,
		'host', jsonb_build_object(
			'machineIdSha256', v_aux_machine,
			'socketPath', '/var/snap/lxd/common/lxd/unix.socket',
			'socketGid', 101,
			'certificateSha256', repeat('e', 64),
			'serverName', 'node-aux-1336',
			'serverVersion', '6.9',
			'architecture', 'x86_64'
		),
		'operatingCpuMillis', 4000,
		'operatingMemoryBytes', 4294967296,
		'infrastructure', '[]'::jsonb,
		'codingAuxiliary', jsonb_build_object(
			'project', 'coding',
			'storagePool', 'coding-disks',
			'cpus', 4,
			'memoryBytes', 8589934592,
			'rootDiskBytes', 68719476736,
			'maxBuilders', 1,
			'maxStandby', 2
		)
	);
	perform public.qorpera_enroll_runtime_node_inventory(v_policy);

	begin
		perform public.qorpera_enroll_runtime_node_inventory(
			v_policy || jsonb_build_object(
				'codingAuxiliary', (v_policy -> 'codingAuxiliary') || jsonb_build_object('maxBuilders', 2)
			)
		);
	exception when others then
		v_failed := true;
	end;
	perform pg_temp.ok(v_failed, 'codingAuxiliary maxBuilders headroom check refuses over-subscribed node');

	v_ctx := public.qorpera_runtime_node_inventory_context(v_aux_node_id);
	v_builder := jsonb_build_object(
		'project', 'coding',
		'name', 'qorpera-coding-snap-' || repeat('a', 24),
		'physicalId', extensions.gen_random_uuid(),
		'type', 'virtual-machine',
		'state', 'running',
		'configurationSha256', repeat('b', 64),
		'cpuMillis', 4000,
		'memoryBytes', 8589934592,
		'allocation', null,
		'category', 'coding-snapshot-builder',
		'reason', null
	);
	v_standby := jsonb_build_object(
		'project', 'coding',
		'name', 'qorpera-coding-standby-' || repeat('c', 24),
		'physicalId', extensions.gen_random_uuid(),
		'type', 'virtual-machine',
		'state', 'suspended',
		'configurationSha256', repeat('d', 64),
		'cpuMillis', 4000,
		'memoryBytes', 8589934592,
		'allocation', null,
		'category', 'coding-standby',
		'reason', null
	);
	v_obs := public.qorpera_observe_runtime_node_inventory(
		jsonb_build_object(
			'schema', 'qorpera.runtime-node-observation/v1',
			'nodeId', v_aux_node_id,
			'machineIdSha256', v_aux_machine,
			'observationId', extensions.gen_random_uuid(),
			'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'cpuMillis', 32000,
			'memoryBytes', 68719476736,
			'state', 'ready'
		),
		v_ctx ->> 'contextSha256',
		jsonb_build_object(
			'schema', 'qorpera.runtime-node-inventory/v1',
			'bootId', extensions.gen_random_uuid(),
			'entries', jsonb_build_array(v_builder, v_standby)
		)
	);
	select observation ->> 'state' = 'ready' into v_ready
	from public.qorpera_runtime_node_observations where node_id = v_aux_node_id;
	perform pg_temp.ok(v_ready, 'node stays ready when registered snapshot builder and stopped standby VM are present');

	v_failed := false;
	begin
		perform public.qorpera_observe_runtime_node_inventory(
			jsonb_build_object(
				'schema', 'qorpera.runtime-node-observation/v1',
				'nodeId', v_aux_node_id,
				'machineIdSha256', v_aux_machine,
				'observationId', extensions.gen_random_uuid(),
				'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'cpuMillis', 32000,
				'memoryBytes', 68719476736,
				'state', 'ready'
			),
			v_ctx ->> 'contextSha256',
			jsonb_build_object(
				'schema', 'qorpera.runtime-node-inventory/v1',
				'bootId', extensions.gen_random_uuid(),
				'entries', jsonb_build_array(v_standby || jsonb_build_object('state', 'running'))
			)
		);
	exception when others then
		v_failed := true;
	end;
	perform pg_temp.ok(v_failed, 'running standby VM refuses ready SQL inventory observation');

	perform public.qorpera_observe_runtime_node_inventory(
		jsonb_build_object(
			'schema', 'qorpera.runtime-node-observation/v1',
			'nodeId', v_aux_node_id,
			'machineIdSha256', v_aux_machine,
			'observationId', extensions.gen_random_uuid(),
			'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'cpuMillis', 32000,
			'memoryBytes', 68719476736,
			'state', 'unavailable'
		),
		v_ctx ->> 'contextSha256',
		jsonb_build_object(
			'schema', 'qorpera.runtime-node-inventory/v1',
			'bootId', extensions.gen_random_uuid(),
			'entries', jsonb_build_array(v_standby || jsonb_build_object('state', 'running', 'reason', 'INSTANCE_AUTHORITY_DIFFERS'))
		)
	);
	select observation ->> 'state' = 'unavailable' into v_ready
	from public.qorpera_runtime_node_observations where node_id = v_aux_node_id;
	perform pg_temp.ok(v_ready, 'running standby VM records unavailable SQL inventory observation');
end $$;

rollback;
