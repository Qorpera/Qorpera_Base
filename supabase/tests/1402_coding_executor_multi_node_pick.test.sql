begin;

insert into auth.users(id, email) values
	('14020000-0000-4000-8000-000000000001', 'owner-1402@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('14020000-0000-4000-8000-000000000010', 'Multi-Node Coding 1402', '14020000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('14020000-0000-4000-8000-000000000010', '14020000-0000-4000-8000-000000000001', 'owner-1402@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('14020000-0000-4000-8000-000000000020', '14020000-0000-4000-8000-000000000010', 'Production', 1, '14020000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('14020000-0000-4000-8000-000000000020') \g /dev/null

create function pg_temp.t1402_ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		raise exception 'Test 1402 failed: %', p_message;
	end if;
end $$;

create function pg_temp.t1402_sha(p_name text) returns text language sql as $$
	select encode(sha256(convert_to('t1402-' || p_name, 'UTF8')), 'hex')
$$;

create function pg_temp.t1402_make_session(p_id uuid, p_repo text, p_phase text default 'queued', p_owner text default null)
returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (p_id, '14020000-0000-4000-8000-000000000010', '14020000-0000-4000-8000-000000000020',
		'14020000-0000-4000-8000-000000000030', extensions.gen_random_uuid(), 'w-' || p_id::text, 'coding', 'Code', 'read', 'each', '{}',
		'14020000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), '14020000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid(), 1);
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase,
		lease_owner, lease_token, lease_until, started_at, updated_at)
	values (p_id, '14020000-0000-4000-8000-000000000010', '14020000-0000-4000-8000-000000000020', 'codex',
		jsonb_build_object('host', 'qorpera', 'owner', 'surfaces', 'name', p_repo, 'baseBranch', 'main'),
		'qorpera/coding/' || p_id::text, p_phase,
		p_owner,
		case when p_owner is not null then extensions.gen_random_uuid() end,
		case when p_owner is not null then clock_timestamp() + interval '5 minutes' end,
		case when p_owner is not null then clock_timestamp() end,
		clock_timestamp());
	set local session_replication_role = origin;
end $$;

do $$
declare
	v_env constant uuid := '14020000-0000-4000-8000-000000000020';
	v_n1 constant uuid := '14020000-0000-4000-8000-000000000101';
	v_n2 constant uuid := '14020000-0000-4000-8000-000000000102';
	v_n1_sha text := pg_temp.t1402_sha('node1');
	v_n2_sha text := pg_temp.t1402_sha('node2');
	v_p1_sha text := pg_temp.t1402_sha('prov1');
	v_p2_sha text := pg_temp.t1402_sha('prov2');
	v_digest text := repeat('7', 64);
	v_w1 constant uuid := '14020000-0000-4000-8000-000000000201';
	v_w2 constant uuid := '14020000-0000-4000-8000-000000000202';
	v_w3 constant uuid := '14020000-0000-4000-8000-000000000203';
	v_w4 constant uuid := '14020000-0000-4000-8000-000000000204';
	v_w5 constant uuid := '14020000-0000-4000-8000-000000000205';
	v_w_fill constant uuid := '14020000-0000-4000-8000-000000000209';
	v_plan1 jsonb;
	v_plan2 jsonb;
	v_plan4 jsonb;
	v_m1 uuid;
	v_m2 uuid;
	v_m4 uuid;
begin
	perform pg_temp.t1402_ok(
		not has_function_privilege('anon', 'public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines)', 'execute'),
		'qorpera_coding_machine_node_has_room stays revoked from API roles'
	);

	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
		headroom_cpu_millis, headroom_memory_bytes, cpu_allocation_ratio, standard_cpu_millis, standard_memory_bytes, enabled)
	values
		(v_n1, v_n1_sha, 'node-1402-1', 1, 8000, 34359738368, 4000, 8589934592, 1, 4000, 8589934592, true),
		(v_n2, v_n2_sha, 'node-1402-2', 1, 12000, 34359738368, 4000, 8589934592, 1, 4000, 8589934592, true);
	insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation) values
		(v_n1, '14020000-0000-4000-8000-000000000111', clock_timestamp(), '{"state":"ready","cpuMillis":8000,"memoryBytes":34359738368}'),
		(v_n2, '14020000-0000-4000-8000-000000000112', clock_timestamp(), '{"state":"ready","cpuMillis":12000,"memoryBytes":34359738368}');
	insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256) values
		(v_n1, '{}', repeat('a', 64)),
		(v_n2, '{}', repeat('a', 64));
	insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory) values
		(v_n1, '14020000-0000-4000-8000-000000000111', 1, repeat('a', 64), repeat('b', 64), '{}'),
		(v_n2, '14020000-0000-4000-8000-000000000112', 1, repeat('a', 64), repeat('b', 64), '{}');
	insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes) values
		('coding', 'coding-1402-1', v_n1, v_p1_sha, 4000, 8589934592),
		('coding', 'coding-1402-2', v_n2, v_p2_sha, 4000, 8589934592);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy) values
		(v_env, 'exec-1402-1', true, array['codex'], v_n1_sha,
			jsonb_build_object('providerId', 'coding-1402-1', 'providerPolicySha256', v_p1_sha, 'project', 'coding',
				'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'qorpera-vm',
				'network', 'qagent0', 'cpus', 4, 'memoryBytes', 8589934592, 'rootDiskBytes', 68719476736),
			'{"rootPath":"/srv/coding-1"}'),
		(v_env, 'exec-1402-2', true, array['codex'], v_n2_sha,
			jsonb_build_object('providerId', 'coding-1402-2', 'providerPolicySha256', v_p2_sha, 'project', 'coding',
				'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'qorpera-vm',
				'network', 'qagent0', 'cpus', 4, 'memoryBytes', 8589934592, 'rootDiskBytes', 68719476736),
			'{"rootPath":"/srv/coding-2"}');
	set local session_replication_role = origin;

	perform pg_temp.t1402_make_session(v_w1, 'repo-a', 'preparing', 'exec-1402-1');
	v_plan1 := public.qorpera_plan_coding_machine(
		v_w1, (select lease_token from public.qorpera_coding_sessions where worker_id = v_w1), v_n1_sha, v_digest
	);
	v_m1 := (v_plan1 ->> 'machineId')::uuid;
	perform pg_temp.t1402_ok(v_plan1 ->> 'state' = 'planned', format('repo-a planned on node 1: %s', v_plan1));
	set local session_replication_role = replica;
	insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding, member_user_id)
	values (v_w1, v_env, 'exec-1402-1', v_n1_sha, 1, '{}', '14020000-0000-4000-8000-000000000001');
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null
	where worker_id = v_w1;
	set local session_replication_role = origin;

	perform pg_temp.t1402_make_session(v_w2, 'repo-b', 'queued', null);
	perform pg_temp.t1402_ok(
		public.qorpera_coding_executor_pick(v_w2) = 'exec-1402-2',
		format('repo-b picks node 2 instead of full node 1: got %s', public.qorpera_coding_executor_pick(v_w2))
	);

	perform pg_temp.t1402_make_session(v_w3, 'repo-a', 'queued', null);
	perform pg_temp.t1402_ok(
		public.qorpera_coding_executor_pick(v_w3) = 'exec-1402-1',
		format('second repo-a session reuses awake non-full VM on node 1: got %s', public.qorpera_coding_executor_pick(v_w3))
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = 'exec-1402-2',
		lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp()
	where worker_id = v_w2;
	set local session_replication_role = origin;
	v_plan2 := public.qorpera_plan_coding_machine(
		v_w2, (select lease_token from public.qorpera_coding_sessions where worker_id = v_w2), v_n2_sha, v_digest
	);
	v_m2 := (v_plan2 ->> 'machineId')::uuid;
	perform pg_temp.t1402_ok(v_plan2 ->> 'state' = 'planned', format('repo-b planned on node 2: %s', v_plan2));
	set local session_replication_role = replica;
	insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding, member_user_id)
	values (v_w2, v_env, 'exec-1402-2', v_n2_sha, 1, '{}', '14020000-0000-4000-8000-000000000001');
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null
	where worker_id = v_w2;
	set local session_replication_role = origin;

	perform pg_temp.t1402_ok(
		public.qorpera_coding_executor_pick(v_w1) = 'exec-1402-1'
		and public.qorpera_coding_executor_pick(v_w2) = 'exec-1402-2',
		'existing sessions remain pinned to their own NAS volume node'
	);
	perform pg_temp.t1402_make_session(v_w5, 'repo-c', 'queued', null);
	perform pg_temp.t1402_ok(
		public.qorpera_coding_executor_pick(v_w5) = 'exec-1402-2',
		format('new repo-c session succeeds despite member volumes spanning two nodes: got %s', public.qorpera_coding_executor_pick(v_w5))
	);

	set local session_replication_role = replica;
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = v_m1;
	set local session_replication_role = origin;
	perform pg_temp.t1402_make_session(v_w_fill, 'repo-fill', 'preparing', 'exec-1402-1');
	perform pg_temp.t1402_ok(
		public.qorpera_plan_coding_machine(
			v_w_fill, (select lease_token from public.qorpera_coding_sessions where worker_id = v_w_fill), v_n1_sha, v_digest
		) ->> 'state' = 'planned',
		'filler VM fills node 1 capacity while repo-a VM #1 sleeps'
	);

	perform pg_temp.t1402_make_session(v_w4, 'repo-a', 'queued', null);
	perform pg_temp.t1402_ok(
		public.qorpera_coding_executor_pick(v_w4) = 'exec-1402-2',
		format('new repo-a session overflows to node 2 when repo-a VM #1 sleeps on full node 1: got %s', public.qorpera_coding_executor_pick(v_w4))
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = 'exec-1402-2',
		lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp()
	where worker_id = v_w4;
	set local session_replication_role = origin;
	v_plan4 := public.qorpera_plan_coding_machine(
		v_w4, (select lease_token from public.qorpera_coding_sessions where worker_id = v_w4), v_n2_sha, v_digest
	);
	v_m4 := (v_plan4 ->> 'machineId')::uuid;
	perform pg_temp.t1402_ok(
		v_plan4 ->> 'state' = 'planned' and v_m4 is distinct from v_m1
		and (select owner = 'exec-1402-2' and number = 2 from public.qorpera_coding_machines where id = v_m4),
		format('plan allocates repo-a overflow VM #2 on node 2 instead of NODE_NOT_PREFERRED: %s', v_plan4)
	);

	perform pg_temp.t1402_ok(
		position('20260930828000 (step 5k)' in obj_description('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, 'pg_proc')) > 0
		and position('20260930828000 (step 5k)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0
		and position('20260930394000 (step 5a)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0
		and position('20260930854000 (step 5h)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0,
		'qorpera_plan_coding_machine preserves 5a, 5h, and 5k markers'
	);
end $$;

rollback;
