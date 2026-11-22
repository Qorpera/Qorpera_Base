-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"

create function pg_temp.t1323_ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Parallel coding scale 1323: %', p_message; end if; end $$;

create function pg_temp.t1323_error(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;

insert into auth.users(id, email) values
	('13230000-0000-4000-8000-000000000001', 'scale-owner-1323@example.test'),
	('13230000-0000-4000-8000-000000000002', 'scale-member-1323@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13230000-0000-4000-8000-000000000010', 'Parallel coding scale 1323', '13230000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('13230000-0000-4000-8000-000000000010', '13230000-0000-4000-8000-000000000001', 'scale-owner-1323@example.test', 'Owner', 'owner'),
	('13230000-0000-4000-8000-000000000010', '13230000-0000-4000-8000-000000000002', 'scale-member-1323@example.test', 'Member', 'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('13230000-0000-4000-8000-000000000020', '13230000-0000-4000-8000-000000000010', 'MultiNode', 1, '13230000-0000-4000-8000-000000000001'),
	('13230000-0000-4000-8000-000000000021', '13230000-0000-4000-8000-000000000010', 'Spread', 1, '13230000-0000-4000-8000-000000000001'),
	('13230000-0000-4000-8000-000000000022', '13230000-0000-4000-8000-000000000010', 'Enrolled', 1, '13230000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('13230000-0000-4000-8000-000000000020') \g /dev/null
select public.qorpera_folder_enable('13230000-0000-4000-8000-000000000021') \g /dev/null

do $$
declare
	v_user_a constant uuid := '13230000-0000-4000-8000-000000000001';
	v_user_b constant uuid := '13230000-0000-4000-8000-000000000002';
	v_profile constant uuid := '13230000-0000-4000-8000-000000000010';
	v_env constant uuid := '13230000-0000-4000-8000-000000000020';
	v_role text;
	v_res jsonb;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_wake uuid;
	v_run uuid;
	v_job uuid;
	v_i integer;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.t1323_ok(not has_table_privilege(v_role, 'public.qorpera_claude_member_parallel_caps', 'select,insert,update,delete'),
			'no direct table privilege on qorpera_claude_member_parallel_caps for ' || v_role);
		perform pg_temp.t1323_ok(not has_function_privilege(v_role, 'public.qorpera_claude_worker_run_cap(uuid)', 'execute'),
			'internal qorpera_claude_worker_run_cap(uuid) revoked from ' || v_role);
	end loop;
	perform pg_temp.t1323_ok(has_function_privilege('service_role', 'public.qorpera_set_claude_parallel_cap(smallint,uuid)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_get_claude_parallel_cap(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_set_claude_parallel_cap(smallint,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_set_claude_parallel_cap(smallint,uuid)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_set_claude_parallel_cap(smallint,uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_get_claude_parallel_cap(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_get_claude_parallel_cap(uuid)', 'execute'),
		'claude parallel cap RPC grants are service_role only');

	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.t1323_ok(pg_temp.t1323_error('select public.qorpera_set_claude_parallel_cap(24::smallint)') like '42501 %',
		'authenticated refused set cap');
	perform pg_temp.t1323_ok(pg_temp.t1323_error('select public.qorpera_get_claude_parallel_cap()') like '42501 %',
		'authenticated refused get cap');
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform pg_temp.t1323_ok(pg_temp.t1323_error('select public.qorpera_set_claude_parallel_cap(24::smallint)') like '42501 %',
		'anon refused set cap');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	perform pg_temp.t1323_ok(pg_temp.t1323_error('select public.qorpera_set_claude_parallel_cap(0::smallint)') like '22023 %'
		and pg_temp.t1323_error('select public.qorpera_set_claude_parallel_cap(65::smallint)') like '22023 %'
		and pg_temp.t1323_error('select public.qorpera_set_claude_parallel_cap(null::smallint)') like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_set_claude_parallel_cap(0::smallint, %L)', v_user_b)) like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_set_claude_parallel_cap(65::smallint, %L)', v_user_b)) like '22023 %',
		'invalid cap bounds refused with 22023');

	v_res := public.qorpera_set_claude_parallel_cap(24::smallint);
	perform pg_temp.t1323_ok(v_res = '{"schema":"qorpera.claude-parallel-cap/v1","scope":"global","cap":24}'::jsonb
		and public.qorpera_get_claude_parallel_cap() = 24
		and public.qorpera_get_claude_parallel_cap(v_user_a) = 24,
		'global cap raised to 24: ' || v_res::text);

	v_res := public.qorpera_set_claude_parallel_cap(64::smallint, v_user_b);
	perform pg_temp.t1323_ok((v_res ->> 'overrideCap')::integer = 64 and (v_res ->> 'effectiveCap')::integer = 64
		and public.qorpera_get_claude_parallel_cap(v_user_b) = 64
		and public.qorpera_get_claude_parallel_cap(v_user_a) = 24,
		'member B override set to 64 while member A stays at 24: ' || v_res::text);

	set local session_replication_role = replica;
	for v_i in 1..25 loop
		v_wake := extensions.gen_random_uuid();
		v_run := extensions.gen_random_uuid();
		v_job := extensions.gen_random_uuid();
		insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
			job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
		values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', v_user_a,
			'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
		insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
			company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
			payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
			audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
		values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			'13230000-0000-4000-8000-0000000000a1', 1, extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			v_user_a, v_user_a, 'anthropic', 'claude-test', 'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}');
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
			wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
			sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
		values (v_wake, v_profile, v_env, 'worker-dispatch', v_wake::text, clock_timestamp(), clock_timestamp(), 'agent', 'worker-dispatch',
			extensions.gen_random_uuid(), v_run, 'materialized', '13230000-0000-4000-8000-0000000000a1', 1, v_user_a,
			extensions.gen_random_uuid(), 1, extensions.gen_random_uuid(), array['13230000-0000-4000-8000-0000000000a1'::uuid], 0,
			extensions.gen_random_uuid(), '{}');
		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, harness, title,
			access, revival, dispatch, requested_by_user_id, steering_run_id)
		values (extensions.gen_random_uuid(), v_profile, v_env, '13230000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(),
			'ca-' || v_i, 'in-house', 'claude-code', 'Claude A ' || v_i, 'write', 'each', '{}', v_user_a, extensions.gen_random_uuid())
		returning * into v_worker;
		if v_i <= 24 then
			perform pg_temp.t1323_ok(not public.qorpera_claude_worker_waits(v_worker)
				and public.qorpera_claude_worker_lease_take(v_worker, v_wake),
				'member A takes lease slot ' || v_i);
		else
			perform pg_temp.t1323_ok(public.qorpera_claude_worker_waits(v_worker)
				and not public.qorpera_claude_worker_lease_take(v_worker, v_wake),
				'member A 25th run waits at cap 24');
		end if;
	end loop;

	for v_i in 1..65 loop
		v_wake := extensions.gen_random_uuid();
		v_run := extensions.gen_random_uuid();
		v_job := extensions.gen_random_uuid();
		insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
			job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
		values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', v_user_b,
			'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
		insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
			company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
			payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
			audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
		values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			'13230000-0000-4000-8000-0000000000a1', 1, extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			v_user_b, v_user_b, 'anthropic', 'claude-test', 'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}');
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
			wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
			sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
		values (v_wake, v_profile, v_env, 'worker-dispatch', v_wake::text, clock_timestamp(), clock_timestamp(), 'agent', 'worker-dispatch',
			extensions.gen_random_uuid(), v_run, 'materialized', '13230000-0000-4000-8000-0000000000a1', 1, v_user_b,
			extensions.gen_random_uuid(), 1, extensions.gen_random_uuid(), array['13230000-0000-4000-8000-0000000000a1'::uuid], 0,
			extensions.gen_random_uuid(), '{}');
		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, harness, title,
			access, revival, dispatch, requested_by_user_id, steering_run_id)
		values (extensions.gen_random_uuid(), v_profile, v_env, '13230000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(),
			'cb-' || v_i, 'in-house', 'claude-code', 'Claude B ' || v_i, 'write', 'each', '{}', v_user_b, extensions.gen_random_uuid())
		returning * into v_worker;
		if v_i <= 64 then
			perform pg_temp.t1323_ok(not public.qorpera_claude_worker_waits(v_worker)
				and public.qorpera_claude_worker_lease_take(v_worker, v_wake),
				'member B takes lease slot ' || v_i);
		else
			perform pg_temp.t1323_ok(public.qorpera_claude_worker_waits(v_worker)
				and not public.qorpera_claude_worker_lease_take(v_worker, v_wake),
				'member B 65th run waits at override cap 64');
		end if;
	end loop;
	set local session_replication_role = origin;

	perform pg_temp.t1323_ok((select max(slot) = 24 and count(*) = 24 from public.qorpera_claude_worker_leases where owner_user_id = v_user_a)
		and (select max(slot) = 64 and count(*) = 64 from public.qorpera_claude_worker_leases where owner_user_id = v_user_b),
		'member A holds 24 slots and member B holds 64 slots');

	v_res := public.qorpera_set_claude_parallel_cap(null::smallint, v_user_b);
	perform pg_temp.t1323_ok(v_res ->> 'overrideCap' is null and (v_res ->> 'effectiveCap')::integer = 24
		and public.qorpera_get_claude_parallel_cap(v_user_b) = 24
		and not exists (select 1 from public.qorpera_claude_member_parallel_caps where member_user_id = v_user_b),
		'clearing member B override restores fallback to global cap: ' || v_res::text);
end $$;

set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled) values
	('13230000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-1323-1', 'UTF8')), 'hex'), 'node-1323-1', 1, 64000,
		274877906944, 1000, 4294967296, 4000, 8589934592, true),
	('13230000-0000-4000-8000-0000000000e2', encode(sha256(convert_to('node-1323-2', 'UTF8')), 'hex'), 'node-1323-2', 1, 64000,
		274877906944, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation) values
	('13230000-0000-4000-8000-0000000000e1', '13230000-0000-4000-8000-0000000000f1', clock_timestamp(),
		'{"state":"ready","cpuMillis":64000,"memoryBytes":274877906944}'),
	('13230000-0000-4000-8000-0000000000e2', '13230000-0000-4000-8000-0000000000f2', clock_timestamp(),
		'{"state":"ready","cpuMillis":64000,"memoryBytes":274877906944}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256) values
	('13230000-0000-4000-8000-0000000000e1', '{}', repeat('a', 64)),
	('13230000-0000-4000-8000-0000000000e2', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory) values
	('13230000-0000-4000-8000-0000000000e1', '13230000-0000-4000-8000-0000000000f1', 1, repeat('a', 64), repeat('b', 64), '{}'),
	('13230000-0000-4000-8000-0000000000e2', '13230000-0000-4000-8000-0000000000f2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes) values
	('coding', 'coding-1323-1', '13230000-0000-4000-8000-0000000000e1', repeat('d', 64), 2000, 4294967296),
	('coding', 'coding-1323-2', '13230000-0000-4000-8000-0000000000e2', repeat('d', 64), 2000, 4294967296),
	('coding', 'coding-1323-big', '13230000-0000-4000-8000-0000000000e1', repeat('e', 64), 16000, 34359738368);

insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy) values
	('13230000-0000-4000-8000-000000000020', 'exec-1323-1', true, array['codex'], encode(sha256(convert_to('node-1323-1', 'UTF8')), 'hex'),
		jsonb_build_object('providerId', 'coding-1323-1', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
			'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
			'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
		'{"rootPath":"/nas/coding-1"}'),
	('13230000-0000-4000-8000-000000000020', 'exec-1323-2', true, array['codex'], encode(sha256(convert_to('node-1323-2', 'UTF8')), 'hex'),
		jsonb_build_object('providerId', 'coding-1323-2', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
			'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
			'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
		'{"rootPath":"/nas/coding-2"}'),
	('13230000-0000-4000-8000-000000000021', 'exec-1323-big', true, array['codex'], encode(sha256(convert_to('node-1323-1', 'UTF8')), 'hex'),
		jsonb_build_object('providerId', 'coding-1323-big', 'providerPolicySha256', repeat('e', 64), 'project', 'qorpera-coding',
			'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
			'cpus', 16, 'memoryBytes', 34359738368, 'rootDiskBytes', 21474836480),
		'{"rootPath":"/nas/coding-big"}');

insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled) values
	('13230000-0000-4000-8000-000000000020', '13230000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true),
	('13230000-0000-4000-8000-000000000021', '13230000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
set local session_replication_role = origin;

create function pg_temp.t1323_node(p_n integer) returns text language sql as $$
	select encode(sha256(convert_to('node-1323-' || p_n, 'UTF8')), 'hex')
$$;

create function pg_temp.t1323_storage(p_worker uuid, p_node text, p_root text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-storage/v1', 'volumeId', worker.id, 'workerId', worker.id,
		'companyId', worker.profile_id, 'environmentId', worker.environment_id, 'writerGeneration', 1, 'machineIdSha256', p_node,
		'policy', jsonb_build_object('rootPath', p_root), 'dataSource', root || '/data', 'custodySource', root || '/guest-state',
		'dataTarget', '/workspace', 'custodyTarget', '/var/lib/qorpera-coding')
	from public.qorpera_runtime_workers worker,
		lateral (select p_root || '/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) folder
	where worker.id = p_worker
$$;

create function pg_temp.t1323_make_session(p_env uuid, p_owner text, p_phase text default 'preparing',
	p_lease_until timestamptz default clock_timestamp() + interval '5 minutes')
returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (v_id, '13230000-0000-4000-8000-000000000010', p_env, '13230000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(),
		'w-' || left(v_id::text, 8), 'coding', 'Scale coding', 'read', 'each', '{}', '13230000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid(), '13230000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 1);
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
		lease_token, lease_until, started_at)
	values (v_id, '13230000-0000-4000-8000-000000000010', p_env, 'codex',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/coding/' || left(v_id::text, 8),
		p_phase, p_owner, case when p_owner is null then null else extensions.gen_random_uuid() end, p_lease_until, clock_timestamp());
	set local session_replication_role = origin;
	return v_id;
end $$;

create function pg_temp.t1323_turn(p_env uuid, p_worker uuid, p_until timestamptz) returns uuid language plpgsql as $$
declare v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_profile constant uuid := '13230000-0000-4000-8000-000000000010';
	v_user constant uuid := '13230000-0000-4000-8000-000000000001';
	v_staff constant uuid := '13230000-0000-4000-8000-0000000000a1';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, p_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', v_user,
		'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('a', 64), p_until, v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
	values (v_run, v_profile, p_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(), v_staff, 1,
		extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_user, v_user, 'openai', 'gpt-test',
		'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
	values (v_wake, v_profile, p_env, 'worker-dispatch', v_wake::text, clock_timestamp(), clock_timestamp(), 'agent', 'worker-dispatch',
		p_worker, v_run, 'materialized', v_staff, 1, v_user, extensions.gen_random_uuid(), 1, extensions.gen_random_uuid(),
		array[v_staff], 0, extensions.gen_random_uuid(), '{}');
	set local session_replication_role = origin;
	return v_run;
end $$;

do $$
declare
	v_env_spread constant uuid := '13230000-0000-4000-8000-000000000021';
	v_env_enroll constant uuid := '13230000-0000-4000-8000-000000000022';
	v_node1 text := pg_temp.t1323_node(1);
	v_digest text := repeat('1', 64);
	v_w uuid;
	v_plan jsonb;
	v_m1 uuid;
	v_i integer;
	v_machines uuid[] := '{}';
	v_machine_counts integer[];
begin
	perform pg_temp.t1323_ok((select session_cpu_millis = 1000 and session_memory_bytes = 2147483648 and max_attached_sessions = 6
		from public.qorpera_coding_executors where environment_id = v_env_spread and owner = 'exec-1323-big'),
		'sane non-zero defaults and max_attached_sessions=6 applied to new executors');
	perform pg_temp.t1323_ok(pg_temp.t1323_error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, 2147483648, 0)',
		v_env_spread, 'exec-1323-big')) like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, 2147483648, 65)',
		v_env_spread, 'exec-1323-big')) like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, 2147483648, null::integer)',
		v_env_spread, 'exec-1323-big')) like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_configure_coding_session_size(%L, %L, -1, 2147483648, 6)',
		v_env_spread, 'exec-1323-big')) like '22023 %'
		and pg_temp.t1323_error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, null::bigint, 6)',
		v_env_spread, 'exec-1323-big')) like '22023 %',
		'5-arg qorpera_configure_coding_session_size validates inputs with 22023');
	perform pg_temp.t1323_ok(not has_function_privilege('service_role',
			'public.qorpera_coding_machine_full(public.qorpera_coding_machines,uuid,bigint,bigint,integer,boolean)', 'execute')
		and not has_function_privilege('service_role',
			'public.qorpera_coding_machine_full(public.qorpera_coding_machines,uuid,bigint,bigint,integer)', 'execute'),
		'internal qorpera_coding_machine_full overloads stay revoked from API roles');
	perform public.qorpera_configure_coding_session_size(v_env_spread, 'exec-1323-big', 1000, 2147483648, 5);
	perform public.qorpera_coding_executor_enroll(v_env_enroll, 'codex');
	perform pg_temp.t1323_ok(exists (select 1 from public.qorpera_coding_executors
		where environment_id = v_env_enroll and max_attached_sessions in (5, 6)),
		'auto-enrolled executor inherits max_attached_sessions');
	delete from public.qorpera_coding_executors where environment_id = v_env_enroll;
	perform public.qorpera_configure_coding_session_size(v_env_spread, 'exec-1323-big', 1000, 2147483648, 6);

	v_w := pg_temp.t1323_make_session(v_env_spread, 'exec-1323-big');
	v_plan := public.qorpera_plan_coding_machine(v_w,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_w), v_node1, v_digest);
	v_m1 := (v_plan ->> 'machineId')::uuid;
	perform pg_temp.t1323_ok(v_plan ->> 'state' = 'planned', 'first session opens big VM #1');

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null
	where worker_id = v_w;
	for v_i in 1..20 loop
		v_w := pg_temp.t1323_make_session(v_env_spread, null, 'completed', null);
		update public.qorpera_coding_sessions set vm_allocation_id = v_m1 where worker_id = v_w;
		insert into public.qorpera_coding_session_loads(worker_id, machine_id, cpu_millis, memory_bytes)
		values (v_w, v_m1, 8000, 17179869184);
	end loop;
	v_w := pg_temp.t1323_make_session(v_env_spread, null, 'completed', null);
	update public.qorpera_coding_sessions set vm_allocation_id = v_m1, attached_machine_id = v_m1,
		attachment_token = extensions.gen_random_uuid(), attachment_turn = 1,
		attached_at = clock_timestamp() - interval '10 minutes', attachment_until = clock_timestamp() - interval '1 second'
	where worker_id = v_w;
	v_w := pg_temp.t1323_make_session(v_env_spread, 'exec-1323-big', 'preparing', clock_timestamp() - interval '1 second');
	update public.qorpera_coding_sessions set vm_allocation_id = v_m1 where worker_id = v_w;
	set local session_replication_role = origin;

	for v_i in 1..18 loop
		v_w := pg_temp.t1323_make_session(v_env_spread, 'exec-1323-big');
		v_plan := public.qorpera_plan_coding_machine(v_w,
			(select lease_token from public.qorpera_coding_sessions where worker_id = v_w), v_node1, v_digest);
		perform pg_temp.t1323_ok(v_plan ->> 'state' = 'planned', format('spread arrival %s planned: %s', v_i, v_plan));
		v_machines := v_machines || (v_plan ->> 'machineId')::uuid;
	end loop;

	select array_agg(cnt order by num) into v_machine_counts
	from (
		select m.number as num, count(*) as cnt
		from unnest(v_machines) placed_id
		join public.qorpera_coding_machines m on m.id = placed_id
		group by m.number
	) grouped;
	perform pg_temp.t1323_ok(v_machine_counts = array[6, 6, 6] and v_machines[1] = v_m1,
		format('20 detached idle sessions ignored and 18 concurrent arrivals spread 6/6/6 across VMs 1..3: %s', v_machine_counts));
end $$;

do $$
declare
	v_env constant uuid := '13230000-0000-4000-8000-000000000020';
	v_node1 text := pg_temp.t1323_node(1);
	v_node2 text := pg_temp.t1323_node(2);
	v_digest text := repeat('2', 64);
	v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid; v_s5 uuid; v_s_rehome uuid; v_s_rehome2 uuid; v_s_retire uuid;
	v_p1 jsonb; v_p2 jsonb; v_p3 jsonb; v_p4 jsonb; v_p5 jsonb; v_pr jsonb; v_run jsonb; v_att jsonb; v_keep jsonb;
	v_m1 uuid; v_m2 uuid; v_m3 uuid; v_m4 uuid;
	v_turn uuid; v_read jsonb; v_uid integer;
begin
	v_s1 := pg_temp.t1323_make_session(v_env, 'exec-1323-1');
	v_p1 := public.qorpera_plan_coding_machine(v_s1,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s1), v_node1, v_digest);
	v_m1 := (v_p1 ->> 'machineId')::uuid;
	v_run := public.qorpera_authorize_coding_machine_run(v_s1,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s1),
		v_p1 ->> 'bindingText', pg_temp.t1323_storage(v_s1, v_node1, '/nas/coding-1'), v_node1);
	v_uid := (v_run ->> 'guestUid')::integer;
	v_att := public.qorpera_attach_coding_session(v_s1,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s1),
		v_p1 ->> 'bindingText', pg_temp.t1323_storage(v_s1, v_node1, '/nas/coding-1'), v_node1, null);
	perform pg_temp.t1323_ok(v_att ->> 'state' = 'attached', 's1 attached on node 1 VM #1');

	v_keep := public.qorpera_keep_coding_attachments(v_m1, 'exec-1323-1', v_p1 ->> 'bindingText', v_node1, null);
	perform pg_temp.t1323_ok((v_keep #>> '{sessions,0,state}') = 'kept'
		and (v_keep #>> '{sessions,0,guestUid}')::integer = v_uid,
		format('keep returns guestUid %s on kept entry: %s', v_uid, v_keep));

	v_s2 := pg_temp.t1323_make_session(v_env, 'exec-1323-2');
	v_p2 := public.qorpera_plan_coding_machine(v_s2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s2), v_node2, v_digest);
	perform pg_temp.t1323_ok(v_p2 ->> 'state' = 'refused' and v_p2 ->> 'reason' = 'NODE_NOT_PREFERRED',
		format('node 2 still gets NODE_NOT_PREFERRED when node 1 VM #1 is NOT full: %s', v_p2));

	update public.qorpera_coding_sessions set lease_owner = 'exec-1323-1' where worker_id = v_s2;
	v_p2 := public.qorpera_plan_coding_machine(v_s2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s2), v_node1, v_digest);
	perform pg_temp.t1323_ok(v_p2 ->> 'machineId' = v_m1::text, 'node 1 fits s2 on VM #1 (now 2/2 full)');
	perform public.qorpera_attach_coding_session(v_s2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s2),
		v_p2 ->> 'bindingText', pg_temp.t1323_storage(v_s2, v_node1, '/nas/coding-1'), v_node1, null);

	v_s3 := pg_temp.t1323_make_session(v_env, 'exec-1323-2');
	v_p3 := public.qorpera_plan_coding_machine(v_s3,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s3), v_node2, v_digest);
	v_m2 := (v_p3 ->> 'machineId')::uuid;
	perform pg_temp.t1323_ok(v_p3 ->> 'state' = 'planned' and v_m2 <> v_m1
		and (select number = 2 and owner = 'exec-1323-2' and machine_id_sha256 = v_node2
			from public.qorpera_coding_machines where id = v_m2),
		format('node 2 cleanly spawns overflow VM #2 when node 1 VM #1 is full (not NODE_NOT_PREFERRED): %s', v_p3));
	v_att := public.qorpera_attach_coding_session(v_s3,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s3),
		v_p3 ->> 'bindingText', pg_temp.t1323_storage(v_s3, v_node2, '/nas/coding-2'), v_node2, null);
	perform pg_temp.t1323_ok(v_att ->> 'state' = 'attached', 's3 attaches cleanly on node 2 VM #2');

	v_s_rehome := pg_temp.t1323_make_session(v_env, 'exec-1323-2');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set vm_allocation_id = v_m1, attached_machine_id = null, attached_at = null,
		attachment_token = null, attachment_until = null, attachment_turn = null
	where worker_id = v_s_rehome;
	set local session_replication_role = origin;
	v_turn := pg_temp.t1323_turn(v_env, v_s_rehome, clock_timestamp() + interval '1 hour');
	v_read := jsonb_build_object('path', 'QorperaOS/rules/coding.md', 'version', '1', 'authority', public.qorpera_folder_read_receipt(
		v_env, '13230000-0000-4000-8000-000000000010',
		public.qorpera_folder_run_reader('13230000-0000-4000-8000-000000000010', v_turn), 'QorperaOS/rules/coding.md'));
	insert into public.qorpera_coding_machine_read_records(coding_machine_id, release_id, environment_id, resource_id, reads, output_sha256)
	values (v_m2, extensions.gen_random_uuid(), v_env, (v_read -> 'authority' ->> 'resourceId')::uuid, jsonb_build_array(v_read), repeat('3', 64));

	v_pr := public.qorpera_plan_coding_machine(v_s_rehome,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_rehome), v_node2, v_digest);
	perform pg_temp.t1323_ok(v_pr ->> 'state' = 'planned' and (v_pr ->> 'machineId')::uuid = v_m2
		and (select vm_allocation_id = v_m2 from public.qorpera_coding_sessions where worker_id = v_s_rehome)
		and (select machine_id = v_m2 from public.qorpera_coding_session_loads where worker_id = v_s_rehome)
		and exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn
			and resource_id = (v_read -> 'authority' ->> 'resourceId')::uuid)
		and exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_s_rehome
			and event.kind = 'step' and event.actor = 'executor' and event.body ->> 'reason' = 'MACHINE_NEW_DISK'
			and (event.body ->> 'rehomedFrom')::uuid = v_m1 and (event.body ->> 'rehomedTo')::uuid = v_m2),
		format('detached session re-homed off structurally full VM #1 onto VM #2, took in read set, and emitted MACHINE_NEW_DISK: %s', v_pr));
	v_att := public.qorpera_attach_coding_session(v_s_rehome,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_rehome),
		v_pr ->> 'bindingText', pg_temp.t1323_storage(v_s_rehome, v_node2, '/nas/coding-2'), v_node2, null);
	perform pg_temp.t1323_ok(v_att ->> 'state' = 'attached', 're-homed session authorizes and attaches on VM #2 while VM #1 is awake');

	v_s_rehome2 := pg_temp.t1323_make_session(v_env, 'exec-1323-1');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set vm_allocation_id = v_m1 where worker_id = v_s_rehome2;
	set local session_replication_role = origin;
	v_p4 := public.qorpera_plan_coding_machine(v_s_rehome2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_rehome2), v_node1, v_digest);
	v_m3 := (v_p4 ->> 'machineId')::uuid;
	perform pg_temp.t1323_ok(v_p4 ->> 'state' = 'planned' and v_m3 not in (v_m1, v_m2)
		and (select number = 3 from public.qorpera_coding_machines where id = v_m3)
		and (select vm_allocation_id = v_m3 from public.qorpera_coding_sessions where worker_id = v_s_rehome2)
		and exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_s_rehome2
			and event.kind = 'step' and event.actor = 'executor' and event.body ->> 'reason' = 'MACHINE_NEW_DISK'
			and (event.body ->> 'rehomedFrom')::uuid = v_m1 and (event.body ->> 'rehomedTo')::uuid = v_m3),
		format('detached session re-homed off structurally full VM #1 by spawning overflow VM #3 with MACHINE_NEW_DISK: %s', v_p4));
	v_att := public.qorpera_attach_coding_session(v_s_rehome2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_rehome2),
		v_p4 ->> 'bindingText', pg_temp.t1323_storage(v_s_rehome2, v_node1, '/nas/coding-1'), v_node1, null);
	perform pg_temp.t1323_ok(v_att ->> 'state' = 'attached', 'overflow re-homed session attaches on VM #3');

	v_pr := public.qorpera_record_coding_machine_load(v_m3, 'exec-1323-1', v_p4 ->> 'bindingText', v_node1,
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', true,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', v_s_rehome2, 'cpuMillis', 1800, 'memoryBytes', 1048576))));
	perform pg_temp.t1323_ok((v_pr ->> 'sessions')::integer = 1
		and (select full_until > clock_timestamp() from public.qorpera_coding_machines where id = v_m3)
		and (select cpu_millis = 1800 and memory_bytes = 1048576 from public.qorpera_coding_session_loads where worker_id = v_s_rehome2),
		'load records cpu_millis=1800 and full_until');
	v_pr := public.qorpera_record_coding_machine_load(v_m3, 'exec-1323-1', v_p4 ->> 'bindingText', v_node1,
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', null,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', v_s_rehome2, 'cpuMillis', null, 'memoryBytes', 2097152))));
	perform pg_temp.t1323_ok((v_pr ->> 'sessions')::integer = 1
		and (select full_until > clock_timestamp() from public.qorpera_coding_machines where id = v_m3)
		and (select cpu_millis = 1800 and memory_bytes = 2097152 from public.qorpera_coding_session_loads where worker_id = v_s_rehome2),
		'memory-only load with full=null and cpuMillis=null preserves existing full_until and cpu_millis');
	update public.qorpera_coding_machines set full_until = null where id = v_m3;
	v_pr := public.qorpera_record_coding_machine_load(v_m3, 'exec-1323-1', v_p4 ->> 'bindingText', v_node1,
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', true,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', v_s_rehome2, 'cpuMillis', null, 'memoryBytes', 3145728))));
	perform pg_temp.t1323_ok((v_pr ->> 'sessions')::integer = 1
		and (select full_until > clock_timestamp() from public.qorpera_coding_machines where id = v_m3)
		and (select cpu_millis = 1800 and memory_bytes = 3145728 from public.qorpera_coding_session_loads where worker_id = v_s_rehome2),
		'memory-only load with full=true and cpuMillis=null latches full_until while preserving cpu_millis');
	perform pg_temp.t1323_ok(pg_temp.t1323_error(format(
		'select public.qorpera_record_coding_machine_load(%L, %L, %L, %L, %L::jsonb)',
		v_m3, 'exec-1323-1', v_p4 ->> 'bindingText', v_node1,
		'{"schema":"qorpera.coding-machine-load/v1","sessions":[]}')) = '22023 Coding machine load invalid'
		and pg_temp.t1323_error(format(
		'select public.qorpera_record_coding_machine_load(%L, %L, %L, %L, %L::jsonb)',
		v_m3, 'exec-1323-1', v_p4 ->> 'bindingText', v_node1,
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', false,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', v_s_rehome2, 'memoryBytes', 1024)))::text))
		= '22023 Coding machine load invalid',
		'missing full or cpuMillis keys are still rejected with 22023');

	v_s4 := pg_temp.t1323_make_session(v_env, 'exec-1323-1');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set vm_allocation_id = v_m3, attached_machine_id = null, attached_at = null,
		attachment_token = null, attachment_until = null, attachment_turn = null
	where worker_id = v_s4;
	update public.qorpera_coding_session_loads set cpu_millis = 500, memory_bytes = 524288 where worker_id = v_s_rehome2;
	set local session_replication_role = origin;
	v_pr := public.qorpera_plan_coding_machine(v_s4,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s4), v_node1, v_digest);
	perform pg_temp.t1323_ok(v_pr ->> 'state' = 'planned' and (v_pr ->> 'machineId')::uuid = v_m3
		and not exists (select 1 from public.qorpera_coding_session_events where worker_id = v_s4),
		format('transient full_until hint alone never moves an already-homed detached session: %s', v_pr));

	v_s_retire := pg_temp.t1323_make_session(v_env, 'exec-1323-1');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set vm_allocation_id = v_m3, attached_machine_id = v_m3,
		attachment_token = extensions.gen_random_uuid(), attachment_turn = 1,
		attached_at = clock_timestamp() - interval '10 minutes', attachment_until = clock_timestamp() - interval '1 second'
	where worker_id = v_s_retire;
	set local session_replication_role = origin;
	update public.qorpera_coding_machines set retire_requested_at = clock_timestamp() where id = v_m3;
	v_p5 := public.qorpera_plan_coding_machine(v_s_retire,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_retire), v_node1, v_digest);
	v_m4 := (v_p5 ->> 'machineId')::uuid;
	perform pg_temp.t1323_ok(v_p5 ->> 'state' = 'planned' and v_m4 not in (v_m1, v_m2, v_m3)
		and (select number = 4 from public.qorpera_coding_machines where id = v_m4)
		and (select vm_allocation_id = v_m4 from public.qorpera_coding_sessions where worker_id = v_s_retire)
		and exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_s_retire
			and event.kind = 'step' and event.actor = 'executor' and event.body ->> 'reason' = 'MACHINE_NEW_DISK'
			and (event.body ->> 'rehomedFrom')::uuid = v_m3 and (event.body ->> 'rehomedTo')::uuid = v_m4),
		format('expired-attachment session re-homed off retiring VM #3 onto VM #4 with MACHINE_NEW_DISK: %s', v_p5));
	v_att := public.qorpera_attach_coding_session(v_s_retire,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_retire),
		v_p5 ->> 'bindingText', pg_temp.t1323_storage(v_s_retire, v_node1, '/nas/coding-1'), v_node1, null);
	perform pg_temp.t1323_ok(v_att ->> 'state' = 'attached', 're-homed expired-attachment session attaches cleanly on VM #4');

	v_pr := public.qorpera_plan_coding_machine(v_s_rehome2,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s_rehome2), v_node1, v_digest);
	perform pg_temp.t1323_ok(v_pr ->> 'state' = 'refused' and v_pr ->> 'reason' = 'MACHINE_RETIRING'
		and v_pr ->> 'machineId' = v_m3::text,
		format('actively attached session on retiring VM #3 still gets MACHINE_RETIRING: %s', v_pr));

	update public.qorpera_coding_machines set retire_requested_at = clock_timestamp() where id = v_m4;
	v_s5 := pg_temp.t1323_make_session(v_env, 'exec-1323-2');
	v_pr := public.qorpera_plan_coding_machine(v_s5,
		(select lease_token from public.qorpera_coding_sessions where worker_id = v_s5), v_node2, v_digest);
	perform pg_temp.t1323_ok(v_pr ->> 'state' = 'planned' and (v_pr ->> 'machineId')::uuid not in (v_m1, v_m2, v_m3, v_m4),
		format('node 2 skips full/retiring VMs across nodes and allocates number 5: %s', v_pr));

	perform pg_temp.t1323_ok(
		position('rehomedFrom' in pg_get_functiondef('public.qorpera_read_coding_turn_context(jsonb)'::regprocedure)) > 0
		and position('20260930515000' in pg_get_functiondef('public.qorpera_read_coding_turn_context(jsonb)'::regprocedure)) > 0,
		'qorpera_read_coding_turn_context surfaces rehomedFrom events as machine.newDisk while preserving 20260930515000');
end $$;

do $$
declare
	v_alice jsonb := pg_temp.c3_alice();
	v_env constant uuid := '92400000-0000-4000-8000-000000000020';
	v_node_id constant uuid := '13230000-0000-4000-8000-0000000002e1';
	v_node_sha text := encode(sha256(convert_to('node-1323-ctx', 'UTF8')), 'hex');
	v_b1 constant uuid := '13230000-0000-4000-8000-0000000002b1';
	v_b2 constant uuid := '13230000-0000-4000-8000-0000000002b2';
	v_b3 constant uuid := '13230000-0000-4000-8000-0000000002b3';
	v_digest text := repeat('7', 64);
	v_claim jsonb; v_p1 jsonb; v_p2 jsonb; v_p3 jsonb; v_pf1 jsonb; v_pf2 jsonb;
	v_att jsonb; v_pass jsonb; v_turn jsonb; v_ctx jsonb; v_m1 uuid; v_m2 uuid;
	v_tok uuid;
begin
	perform pg_temp.base_claims('service_role');
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
		headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
	values (v_node_id, v_node_sha, 'node-1323-ctx', 1, 16000, 68719476736, 1000, 4294967296, 4000, 8589934592, true);
	insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
	values (v_node_id, '13230000-0000-4000-8000-0000000002e2', clock_timestamp(),
		'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
	insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
	values (v_node_id, '{}', repeat('a', 64));
	insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
	values (v_node_id, '13230000-0000-4000-8000-0000000002e2', 1, repeat('a', 64), repeat('b', 64), '{}');
	insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
	values ('coding', 'coding-1323-ctx', v_node_id, repeat('d', 64), 2000, 4294967296);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy)
	values (v_env, 'exec-1323-ctx', true, array['codex'], v_node_sha,
		jsonb_build_object('providerId', 'coding-1323-ctx', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
			'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
			'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
		'{"rootPath":"/nas/coding-ctx"}');
	set local session_replication_role = origin;
	perform public.qorpera_set_coding_repository_grant(v_env, '92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);

	perform pg_temp.t1323_ok(pg_temp.c3_dispatch(v_alice, 'ctx-1323-d1', 'QorperaOS/agents/alice/todos/fix-login/ctx-1',
		pg_temp.c3_brief(v_b1)) -> 'units' -> 0 ->> 'outcome' = 'saved', 'ctx dispatch b1');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1323-ctx', 120);
	perform pg_temp.t1323_ok((v_claim ->> 'workerId')::uuid = v_b1, 'claim b1 turn 1');
	v_p1 := public.qorpera_plan_coding_machine(v_b1, (pg_temp.c3_session(v_b1)).lease_token, v_node_sha, v_digest);
	v_m1 := (v_p1 ->> 'machineId')::uuid;
	v_att := public.qorpera_attach_coding_session(v_b1, (pg_temp.c3_session(v_b1)).lease_token, v_p1 ->> 'bindingText',
		pg_temp.t1323_storage(v_b1, v_node_sha, '/nas/coding-ctx'), v_node_sha, null);
	v_tok := (v_att ->> 'attachmentToken')::uuid;
	perform public.qorpera_begin_coding_turn(v_b1, (pg_temp.c3_session(v_b1)).lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_claims('service_role');
	v_ctx := public.qorpera_read_coding_turn_context(v_turn);
	perform pg_temp.t1323_ok(v_ctx ->> 'sequence' = '1' and v_ctx -> 'machine' = '{"newDisk":false}'::jsonb,
		format('turn 1 before re-home reports newDisk=false: %s', v_ctx));
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (v_turn ->> 'jobId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(v_b1, (pg_temp.c3_session(v_b1)).lease_token, 'succeeded', 'Turn 1 done.');
	perform public.qorpera_record_coding_session_detached(v_m1, 'exec-1323-ctx', v_p1 ->> 'bindingText', v_node_sha, v_b1, v_tok, 'SLEEP', '[]');

	perform pg_temp.t1323_ok(pg_temp.c3_dispatch(v_alice, 'ctx-1323-d2', 'QorperaOS/agents/alice/todos/fix-login/ctx-2',
		pg_temp.c3_brief(v_b2)) -> 'units' -> 0 ->> 'outcome' = 'saved'
		and pg_temp.c3_dispatch(v_alice, 'ctx-1323-d3', 'QorperaOS/agents/alice/todos/fix-login/ctx-3',
		pg_temp.c3_brief(v_b3)) -> 'units' -> 0 ->> 'outcome' = 'saved', 'ctx dispatch filler sessions');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1323-ctx', 120);
	v_pf1 := public.qorpera_plan_coding_machine((v_claim ->> 'workerId')::uuid,
		(pg_temp.c3_session((v_claim ->> 'workerId')::uuid)).lease_token, v_node_sha, v_digest);
	perform public.qorpera_attach_coding_session((v_claim ->> 'workerId')::uuid,
		(pg_temp.c3_session((v_claim ->> 'workerId')::uuid)).lease_token, v_pf1 ->> 'bindingText',
		pg_temp.t1323_storage((v_claim ->> 'workerId')::uuid, v_node_sha, '/nas/coding-ctx'), v_node_sha, null);
	v_claim := public.qorpera_claim_coding_session('exec-1323-ctx', 120);
	v_pf2 := public.qorpera_plan_coding_machine((v_claim ->> 'workerId')::uuid,
		(pg_temp.c3_session((v_claim ->> 'workerId')::uuid)).lease_token, v_node_sha, v_digest);
	perform public.qorpera_attach_coding_session((v_claim ->> 'workerId')::uuid,
		(pg_temp.c3_session((v_claim ->> 'workerId')::uuid)).lease_token, v_pf2 ->> 'bindingText',
		pg_temp.t1323_storage((v_claim ->> 'workerId')::uuid, v_node_sha, '/nas/coding-ctx'), v_node_sha, null);
	perform pg_temp.t1323_ok((v_pf1 ->> 'machineId')::uuid = v_m1 and (v_pf2 ->> 'machineId')::uuid = v_m1,
		'filler sessions structurally fill m1 (2/2 active)');

	perform pg_temp.c3_answer(v_b1, 'Continue on turn 2.');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1323-ctx', 120);
	perform pg_temp.t1323_ok((v_claim ->> 'workerId')::uuid = v_b1, 'claim b1 turn 2');
	v_p2 := public.qorpera_plan_coding_machine(v_b1, (pg_temp.c3_session(v_b1)).lease_token, v_node_sha, v_digest);
	v_m2 := (v_p2 ->> 'machineId')::uuid;
	perform pg_temp.t1323_ok(v_p2 ->> 'state' = 'planned' and v_m2 <> v_m1, format('b1 turn 2 re-homed off full m1 onto m2: %s', v_p2));
	perform public.qorpera_attach_coding_session(v_b1, (pg_temp.c3_session(v_b1)).lease_token, v_p2 ->> 'bindingText',
		pg_temp.t1323_storage(v_b1, v_node_sha, '/nas/coding-ctx'), v_node_sha, null);
	perform public.qorpera_begin_coding_turn(v_b1, (pg_temp.c3_session(v_b1)).lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_claims('service_role');
	v_ctx := public.qorpera_read_coding_turn_context(v_turn);
	perform pg_temp.t1323_ok(v_ctx ->> 'sequence' = '2' and v_ctx -> 'machine' = '{"newDisk":true}'::jsonb,
		format('turn 2 after re-home reports machine.newDisk=true: %s', v_ctx));
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (v_turn ->> 'jobId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(v_b1, (pg_temp.c3_session(v_b1)).lease_token, 'succeeded', 'Turn 2 done.');

	perform pg_temp.c3_answer(v_b1, 'Continue on turn 3.');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1323-ctx', 120);
	perform pg_temp.t1323_ok((v_claim ->> 'workerId')::uuid = v_b1, 'claim b1 turn 3');
	v_p3 := public.qorpera_plan_coding_machine(v_b1, (pg_temp.c3_session(v_b1)).lease_token, v_node_sha, v_digest);
	perform pg_temp.t1323_ok((v_p3 ->> 'machineId')::uuid = v_m2, 'b1 turn 3 stays on m2');
	perform public.qorpera_begin_coding_turn(v_b1, (pg_temp.c3_session(v_b1)).lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_claims('service_role');
	v_ctx := public.qorpera_read_coding_turn_context(v_turn);
	perform pg_temp.t1323_ok(v_ctx ->> 'sequence' = '3' and v_ctx -> 'machine' = '{"newDisk":false}'::jsonb,
		format('turn 3 after re-home reports machine.newDisk=false: %s', v_ctx));
end $$;

rollback;

begin;

insert into auth.users(id, email) values ('13230000-0000-4000-8000-000000000101', 'race-1323@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13230000-0000-4000-8000-000000000110', 'Rehome race 1323', '13230000-0000-4000-8000-000000000101');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13230000-0000-4000-8000-000000000110', '13230000-0000-4000-8000-000000000101', 'race-1323@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('13230000-0000-4000-8000-000000000120', '13230000-0000-4000-8000-000000000110', 'RaceEnv', 1, '13230000-0000-4000-8000-000000000101');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('13230000-0000-4000-8000-000000000120') \g /dev/null

set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('13230000-0000-4000-8000-0000000001e1', encode(sha256(convert_to('node-1323-race', 'UTF8')), 'hex'), 'node-1323-race', 1, 16000,
	68719476736, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
values ('13230000-0000-4000-8000-0000000001e1', '13230000-0000-4000-8000-0000000001e2', clock_timestamp(),
	'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('13230000-0000-4000-8000-0000000001e1', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
values ('13230000-0000-4000-8000-0000000001e1', '13230000-0000-4000-8000-0000000001e2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('coding', 'coding-1323-race', '13230000-0000-4000-8000-0000000001e1', repeat('d', 64), 2000, 4294967296);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy)
values ('13230000-0000-4000-8000-000000000120', 'exec-1323-race', true, array['codex'],
	encode(sha256(convert_to('node-1323-race', 'UTF8')), 'hex'),
	jsonb_build_object('providerId', 'coding-1323-race', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
		'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
		'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
	'{"rootPath":"/nas/coding-race"}');
insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
values ('13230000-0000-4000-8000-000000000120', '13230000-0000-4000-8000-0000000001a1',
	'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('13230000-0000-4000-8000-0000000001c' || n)::uuid, '13230000-0000-4000-8000-000000000110', '13230000-0000-4000-8000-000000000120',
	'13230000-0000-4000-8000-0000000001a1', extensions.gen_random_uuid(), 'wr-1323-' || n, 'coding', 'Race', 'read', 'each', '{}',
	'13230000-0000-4000-8000-000000000101', extensions.gen_random_uuid(), '13230000-0000-4000-8000-000000000101',
	extensions.gen_random_uuid(), 1
from generate_series(1, 4) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at)
select ('13230000-0000-4000-8000-0000000001c' || n)::uuid, '13230000-0000-4000-8000-000000000110', '13230000-0000-4000-8000-000000000120',
	'codex', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/coding/race-' || n, 'preparing',
	'exec-1323-race', extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes', clock_timestamp()
from generate_series(1, 4) n;
set local session_replication_role = origin;

create function pg_temp.r1323_ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Rehome race 1323: %', p_message; end if; end $$;
create function pg_temp.r1323_node() returns text language sql as $$ select encode(sha256(convert_to('node-1323-race', 'UTF8')), 'hex') $$;
create function pg_temp.r1323_worker(p_n integer) returns uuid language sql as $$ select ('13230000-0000-4000-8000-0000000001c' || p_n)::uuid $$;
create function pg_temp.r1323_lease(p_n integer) returns uuid language sql as $$
	select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.r1323_worker(p_n)
$$;
create function pg_temp.r1323_storage(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-storage/v1', 'volumeId', worker.id, 'workerId', worker.id,
		'companyId', worker.profile_id, 'environmentId', worker.environment_id, 'writerGeneration', 1, 'machineIdSha256', pg_temp.r1323_node(),
		'policy', '{"rootPath":"/nas/coding-race"}'::jsonb, 'dataSource', root || '/data', 'custodySource', root || '/guest-state',
		'dataTarget', '/workspace', 'custodyTarget', '/var/lib/qorpera-coding')
	from public.qorpera_runtime_workers worker,
		lateral (select '/nas/coding-race/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) folder
	where worker.id = pg_temp.r1323_worker(p_n)
$$;

do $$
declare v_p1 jsonb; v_p2 jsonb; v_p3 jsonb;
begin
	v_p1 := public.qorpera_plan_coding_machine(pg_temp.r1323_worker(1), pg_temp.r1323_lease(1), pg_temp.r1323_node(), repeat('9', 64));
	v_p2 := public.qorpera_plan_coding_machine(pg_temp.r1323_worker(2), pg_temp.r1323_lease(2), pg_temp.r1323_node(), repeat('9', 64));
	v_p3 := public.qorpera_plan_coding_machine(pg_temp.r1323_worker(3), pg_temp.r1323_lease(3), pg_temp.r1323_node(), repeat('9', 64));
	perform public.qorpera_attach_coding_session(pg_temp.r1323_worker(1), pg_temp.r1323_lease(1),
		v_p1 ->> 'bindingText', pg_temp.r1323_storage(1), pg_temp.r1323_node(), null);
	perform public.qorpera_attach_coding_session(pg_temp.r1323_worker(2), pg_temp.r1323_lease(2),
		v_p2 ->> 'bindingText', pg_temp.r1323_storage(2), pg_temp.r1323_node(), null);
	perform public.qorpera_attach_coding_session(pg_temp.r1323_worker(3), pg_temp.r1323_lease(3),
		v_p3 ->> 'bindingText', pg_temp.r1323_storage(3), pg_temp.r1323_node(), null);
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set vm_allocation_id = (v_p1 ->> 'machineId')::uuid
	where worker_id = pg_temp.r1323_worker(4);
	set local session_replication_role = origin;
	perform set_config('qorpera_test.r1323_m1_id', v_p1 ->> 'machineId', false);
	perform set_config('qorpera_test.r1323_m2_id', v_p3 ->> 'machineId', false);
	perform set_config('qorpera_test.r1323_m2_binding', v_p3 ->> 'bindingText', false);
end $$;

reset role;
select set_config('qorpera_test.r1323_first_xid', xid(pg_current_xact_id())::text, false) \g /dev/null
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['r1323_hold', 'r1323_act']) name \g /dev/null
select set_config('qorpera_test.r1323_' || name || '_pid', pid::text, false)
from unnest(array['hold', 'act']) name, lateral dblink('r1323_' || name, 'select pg_backend_pid()') as backend(pid integer) \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['r1323_hold', 'r1323_act']) name \g /dev/null

create function pg_temp.r1323_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r1323_hold_pid'),
			current_setting('qorpera_test.r1323_act_pid'))) then
		raise exception 'Rehome race test needs the database to itself: another connection is open'; end if;
end $$;
select pg_temp.r1323_alone_in_database();

create temporary table r1323_counts as select * from dblink('r1323_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
create temporary table r1323_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r1323_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r1323_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r1323_rows select v_table, kept.row_value
			from dblink('r1323_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

create function pg_temp.r1323_waits() returns boolean language plpgsql as $$
declare v_hold integer := current_setting('qorpera_test.r1323_hold_pid')::integer;
	v_act integer := current_setting('qorpera_test.r1323_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_hold = any(pg_blocking_pids(v_act)) then return true; end if;
		exit when dblink_is_busy('r1323_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
create function pg_temp.r1323_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('r1323_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('r1323_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('r1323_act') as call(answer text);
	return v::jsonb;
end $$;
create function pg_temp.r1323_as(p_conn text, p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset role');
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		case when p_role is null then '{}' else jsonb_build_object('role', p_role)::text end));
	if p_role is not null then perform dblink_exec(p_conn, format('set role %I', p_role)); end if;
end $$;
create function pg_temp.r1323_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}';
	v_first xid := current_setting('qorpera_test.r1323_first_xid')::xid;
begin
	perform pg_temp.r1323_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r1323_hold', 'r1323_act']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r1323_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r1323_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r1323_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r1323_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Rehome race cleanup left other row counts: %', v_wrong; end if;
end $$;

do $$
declare
	v_held text;
	v_act jsonb;
	v_m1 uuid := current_setting('qorpera_test.r1323_m1_id')::uuid;
	v_m2 uuid := current_setting('qorpera_test.r1323_m2_id')::uuid;
	v_m2_binding text := current_setting('qorpera_test.r1323_m2_binding');
	v_plan_sql text := format('select public.qorpera_plan_coding_machine(%L::uuid, %L::uuid, %L, %L)::text',
		pg_temp.r1323_worker(4), pg_temp.r1323_lease(4), pg_temp.r1323_node(), repeat('9', 64));
	v_keep_m2_sql text := format('select public.qorpera_keep_coding_attachments(%L::uuid, %L, %L, %L, %L::jsonb)::text',
		v_m2, 'exec-1323-race', v_m2_binding, pg_temp.r1323_node(),
		jsonb_build_object('schema', 'qorpera.coding-machine-observation/v1', 'busy', true,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1323_worker(3), 'busy', true, 'running', '[]'::jsonb))));
	v_load_m2_sql text := format('select public.qorpera_record_coding_machine_load(%L::uuid, %L, %L, %L, %L::jsonb)::text',
		v_m2, 'exec-1323-race', v_m2_binding, pg_temp.r1323_node(),
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', true,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1323_worker(3), 'cpuMillis', 400, 'memoryBytes', 4096))));
begin
	perform pg_temp.r1323_as('r1323_hold', 'service_role');
	perform pg_temp.r1323_as('r1323_act', 'service_role');

	perform dblink_exec('r1323_hold', 'begin');
	select answer into v_held from dblink('r1323_hold', v_keep_m2_sql) as held(answer text);
	perform pg_temp.r1323_ok(v_held::jsonb #>> '{sessions,0,state}' = 'kept', 'hold keep(m2) succeeded');
	perform dblink_send_query('r1323_act', v_plan_sql);
	if not pg_temp.r1323_waits() then
		perform dblink_exec('r1323_hold', 'rollback');
		raise exception 'rehome plan(s4) did not wait for keep(m2): %', pg_temp.r1323_answer(); end if;
	perform dblink_exec('r1323_hold', 'commit');
	v_act := pg_temp.r1323_answer();
	perform pg_temp.r1323_ok(v_act ->> 'state' = 'planned' and (v_act ->> 'machineId')::uuid = v_m2
		and (select vm_allocation_id = v_m2 from public.qorpera_coding_sessions where worker_id = pg_temp.r1323_worker(4)),
		format('rehome plan(s4) alongside keep(m2) completed with zero deadlock: %s', v_act));
end $$;

update public.qorpera_coding_sessions set vm_allocation_id = current_setting('qorpera_test.r1323_m1_id')::uuid
where worker_id = pg_temp.r1323_worker(4);

do $$
declare
	v_held text;
	v_act jsonb;
	v_m1 uuid := current_setting('qorpera_test.r1323_m1_id')::uuid;
	v_m2 uuid := current_setting('qorpera_test.r1323_m2_id')::uuid;
	v_m2_binding text := current_setting('qorpera_test.r1323_m2_binding');
	v_plan_sql text := format('select public.qorpera_plan_coding_machine(%L::uuid, %L::uuid, %L, %L)::text',
		pg_temp.r1323_worker(4), pg_temp.r1323_lease(4), pg_temp.r1323_node(), repeat('9', 64));
	v_load_m2_sql text := format('select public.qorpera_record_coding_machine_load(%L::uuid, %L, %L, %L, %L::jsonb)::text',
		v_m2, 'exec-1323-race', v_m2_binding, pg_temp.r1323_node(),
		jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', true,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1323_worker(3), 'cpuMillis', 400, 'memoryBytes', 4096))));
begin
	perform pg_temp.r1323_as('r1323_hold', 'service_role');
	perform pg_temp.r1323_as('r1323_act', 'service_role');

	perform dblink_exec('r1323_hold', 'begin');
	select answer into v_held from dblink('r1323_hold', v_load_m2_sql) as held(answer text);
	perform pg_temp.r1323_ok((v_held::jsonb ->> 'sessions')::integer = 1, 'hold load(m2, full=true) succeeded');
	perform dblink_send_query('r1323_act', v_plan_sql);
	if not pg_temp.r1323_waits() then
		perform dblink_exec('r1323_hold', 'rollback');
		raise exception 'rehome plan(s4) did not wait for load(m2): %', pg_temp.r1323_answer(); end if;
	perform dblink_exec('r1323_hold', 'commit');
	v_act := pg_temp.r1323_answer();
	perform pg_temp.r1323_ok(v_act ->> 'state' = 'planned' and (v_act ->> 'machineId')::uuid not in (v_m1, v_m2)
		and (select number = 3 from public.qorpera_coding_machines where id = (v_act ->> 'machineId')::uuid)
		and (select vm_allocation_id = (v_act ->> 'machineId')::uuid from public.qorpera_coding_sessions where worker_id = pg_temp.r1323_worker(4)),
		format('rehome plan(s4) alongside load(m2, full=true) overflowed to m3 with zero deadlock: %s', v_act));
end $$;

select pg_temp.r1323_cleanup();
