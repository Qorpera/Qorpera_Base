-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"

do $$
declare
	v_role text;
	v_fn text;
begin
	foreach v_fn in array array[
		'public.qorpera_record_coding_worktree_created(uuid,uuid)',
		'public.qorpera_authorize_coding_command_v2(jsonb,text,jsonb,text,uuid,text,uuid,text,jsonb,text)'
	] loop
		perform pg_temp.base_assert(
			has_function_privilege('service_role', v_fn, 'execute'),
			'1: service_role must execute ' || v_fn
		);
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			perform pg_temp.base_assert(
				not has_function_privilege(v_role, v_fn, 'execute'),
				format('1: %s must not execute %s', v_role, v_fn)
			);
		end loop;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(
				v_role,
				'public.qorpera_coding_environment_version(uuid,uuid,uuid,text,uuid)',
				'execute'
			),
			format('1: %s must not execute internal qorpera_coding_environment_version', v_role)
		);
	end loop;
end $$;

do $$
declare
	v_node_id uuid := '13350000-0000-4000-8000-0000000000e1';
	v_machine_id uuid := '13350000-0000-4000-8000-0000000000d1';
	v_worker_id uuid := '13350000-0000-4000-8000-0000000000b1';
	v_sibling_worker uuid := '13350000-0000-4000-8000-0000000000b2';
	v_command_id uuid := '13350000-0000-4000-8000-0000000000c1';
	v_authority_id uuid := '13350000-0000-4000-8000-000000000040';
	v_node_sha text := encode(extensions.digest(convert_to('node-1335', 'UTF8'), 'sha256'), 'hex');
	v_nas_policy jsonb := '{"schema":"qorpera.coding-nas/v1","rootPath":"/srv/qorpera-coding-1335","mountDevice":"nas-1335"}'::jsonb;
	v_binding_obj jsonb;
	v_binding_text text;
	v_instance_sha text;
	v_claim jsonb;
	v_begin jsonb;
	v_pass jsonb;
	v_run_id uuid;
	v_bind jsonb;
	v_job_id uuid;
	v_lease_token uuid;
	v_job_token text := 'T' || repeat('t', 42);
	v_input_sha text := repeat('a', 64);
	v_root text;
	v_storage jsonb;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
	values (v_authority_id, '92400000-0000-4000-8000-000000000010', 'https://broker-1335.example.test', 'kek-1335', repeat('9', 64));

	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(
		id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
		headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled
	)
	values (
		v_node_id, v_node_sha, 'node-1335', 1, 16000, 68719476736,
		1000, 4294967296, 4000, 8589934592, true
	);
	insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
	values (
		v_node_id, '13350000-0000-4000-8000-0000000000e2', clock_timestamp(),
		'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}'::jsonb
	);
	insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
	values (v_node_id, '{}'::jsonb, repeat('a', 64));
	insert into public.qorpera_runtime_node_inventory_receipts(
		node_id, observation_id, node_version, policy_sha256, context_sha256, inventory
	)
	values (v_node_id, '13350000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}'::jsonb);
	insert into public.qorpera_runtime_node_providers(
		provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes
	)
	values ('coding', 'lxd', v_node_id, repeat('d', 64), 2000, 4294967296);
	set local session_replication_role = origin;

	perform public.qorpera_configure_coding_executor(
		'92400000-0000-4000-8000-000000000020', 'exec-1335', true, array['codex']
	);
	set local session_replication_role = replica;
	update public.qorpera_coding_executors
	set nas_policy = v_nas_policy, nas_machine_id_sha256 = v_node_sha
	where environment_id = '92400000-0000-4000-8000-000000000020' and owner = 'exec-1335';
	set local session_replication_role = origin;

	perform public.qorpera_set_coding_repository_grant(
		'92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030',
		pg_temp.c3_repo(),
		true
	);

	perform pg_temp.base_assert(
		pg_temp.c3_dispatch(
			pg_temp.c3_alice(), 'dispatch-1335-a', 'QorperaOS/agents/alice/todos/fix-login/session-1335-a',
			pg_temp.c3_brief(v_worker_id)
		) -> 'units' -> 0 ->> 'outcome' = 'saved',
		'2: dispatch worker'
	);
	perform pg_temp.base_assert(
		pg_temp.c3_dispatch(
			pg_temp.c3_alice(), 'dispatch-1335-b', 'QorperaOS/agents/alice/todos/fix-login/session-1335-b',
			pg_temp.c3_brief(v_sibling_worker, p_title => 'Sibling session')
		) -> 'units' -> 0 ->> 'outcome' = 'saved',
		'2: dispatch sibling worker'
	);

	v_binding_obj := jsonb_build_object(
		'machineId', v_machine_id,
		'providerId', 'lxd',
		'providerPolicySha256', repeat('d', 64),
		'cpus', 2,
		'memoryBytes', 4294967296
	);
	v_binding_text := v_binding_obj::text;
	v_instance_sha := encode(extensions.digest(convert_to(v_binding_text, 'utf8'), 'sha256'), 'hex');

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding, instance_sha256,
		staff_agent_id, repository
	)
	values (
		v_machine_id, 'member', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000001', 'exec-1335', v_node_sha, v_binding_obj, v_instance_sha,
		'92400000-0000-4000-8000-000000000030', 'qorpera/qorpera_base'
	);
	insert into public.qorpera_runtime_machine_allocations(
		id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at
	)
	values (
		v_machine_id, '92400000-0000-4000-8000-000000000010', 'lxd', v_instance_sha, v_machine_id, clock_timestamp()
	);
	insert into public.qorpera_runtime_node_demands(
		allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, reserved_at
	)
	values (
		v_machine_id, v_node_id, 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp()
	);
	set local session_replication_role = origin;

	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1335', 300);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = v_worker_id::text, '2: claimed worker: ' || coalesce(v_claim::text, 'null'));
	perform pg_temp.base_assert((v_claim -> 'worktreeCreatedAt') = 'null'::jsonb, '2: initial worktreeCreatedAt is null');
	v_lease_token := (v_claim ->> 'leaseToken')::uuid;

	v_root := (v_nas_policy ->> 'rootPath') || '/workers/92400000-0000-4000-8000-000000000010/92400000-0000-4000-8000-000000000020/' || v_worker_id::text;
	v_storage := jsonb_build_object(
		'schema', 'qorpera.coding-storage/v1',
		'volumeId', v_worker_id,
		'workerId', v_worker_id,
		'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020',
		'writerGeneration', 1,
		'machineIdSha256', v_node_sha,
		'policy', v_nas_policy,
		'dataSource', v_root || '/data',
		'custodySource', v_root || '/guest-state',
		'dataTarget', '/workspace',
		'custodyTarget', '/var/lib/qorpera-coding'
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions
	set vm_allocation_id = v_machine_id,
		attached_machine_id = v_machine_id,
		attachment_token = '13350000-0000-4000-8000-0000000000a1',
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = v_worker_id;
	insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding, member_user_id, guest_uid)
	values (v_worker_id, '92400000-0000-4000-8000-000000000020', 'exec-1335', v_node_sha, 1, v_storage, '92400000-0000-4000-8000-000000000001', 200001);
	update public.qorpera_coding_sessions set storage_volume_id = v_worker_id where worker_id = v_worker_id;
	set local session_replication_role = origin;

	v_begin := public.qorpera_begin_coding_turn(v_worker_id, v_lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	select o.run_id into strict v_run_id
	from public.qorpera_wake_occurrences o
	where o.id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' ? v_run_id::text, '2: turn run materialized');
	v_bind := pg_temp.base_start(v_run_id);
	v_job_id := (v_bind ->> 'jobId')::uuid;

	update public.qorpera_runner_jobs
	set lease_token_sha256 = encode(extensions.digest(convert_to(v_job_token, 'utf8'), 'sha256'), 'hex')
	where id = v_job_id;

	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(
		v_bind,
		v_command_id,
		'coding_run_command:op-1335',
		v_input_sha,
		repeat('b', 64),
		false
	);

	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.base_assert(
		(public.qorpera_coding_session_claim_json(v_session, v_worker) -> 'worktreeCreatedAt') = 'null'::jsonb,
		'2: claim json worktreeCreatedAt null before record'
	);

	perform set_config('qorpera_test.w5b_worker', v_worker_id::text, true);
	perform set_config('qorpera_test.w5b_sibling', v_sibling_worker::text, true);
	perform set_config('qorpera_test.w5b_machine', v_machine_id::text, true);
	perform set_config('qorpera_test.w5b_node_sha', v_node_sha, true);
	perform set_config('qorpera_test.w5b_lease', v_lease_token::text, true);
	perform set_config('qorpera_test.w5b_bind', v_bind::text, true);
	perform set_config('qorpera_test.w5b_holder', 'job.' || v_job_id::text || '.' || v_job_token, true);
	perform set_config('qorpera_test.w5b_command', v_command_id::text, true);
	perform set_config('qorpera_test.w5b_input_sha', v_input_sha, true);
	perform set_config('qorpera_test.w5b_binding_text', v_binding_text, true);
	perform set_config('qorpera_test.w5b_storage', v_storage::text, true);
	perform set_config('qorpera_test.w5b_scope', jsonb_build_object(
		'workerId', v_worker_id,
		'vmId', v_machine_id,
		'requestId', public.qorpera_coding_turn_id(v_worker_id, v_worker.sequence),
		'turn', v_worker.sequence
	)::text, true);
end $$;

create function pg_temp.w5b_v2(
	p_action text default 'start',
	p_holder text default null,
	p_with_local boolean default true,
	p_scope jsonb default null,
	p_input_sha text default null
) returns jsonb language plpgsql as $$
declare
	v_scope jsonb := coalesce(p_scope, current_setting('qorpera_test.w5b_scope')::jsonb);
	v_sha text := case when p_action = 'start' then coalesce(p_input_sha, current_setting('qorpera_test.w5b_input_sha')) else null end;
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_authorize_coding_command_v2(
		current_setting('qorpera_test.w5b_bind')::jsonb,
		p_holder,
		v_scope,
		p_action,
		current_setting('qorpera_test.w5b_command')::uuid,
		v_sha,
		case when p_with_local then current_setting('qorpera_test.w5b_lease')::uuid else null end,
		case when p_with_local then current_setting('qorpera_test.w5b_binding_text') else null end,
		case when p_with_local then current_setting('qorpera_test.w5b_storage')::jsonb else null end,
		case when p_with_local then current_setting('qorpera_test.w5b_node_sha') else null end
	);
end $$;

create function pg_temp.w5b_refused(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
declare
	v_state text;
	v_message text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from p_state or v_message is distinct from p_message then
		raise exception 'Expected % (%) from %, got % (%)', p_state, p_message, p_sql, v_state, v_message;
	end if;
end $$;

do $$
declare
	v_worker_id uuid := current_setting('qorpera_test.w5b_worker')::uuid;
	v_lease uuid := current_setting('qorpera_test.w5b_lease')::uuid;
	v_first jsonb;
	v_second jsonb;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.w5b_refused(
		format('select public.qorpera_record_coding_worktree_created(%L, %L)', v_worker_id, '13350000-0000-4000-8000-00000000ffff'),
		'42501',
		'Coding session lease unavailable'
	);
	v_first := public.qorpera_record_coding_worktree_created(v_worker_id, v_lease);
	perform pg_temp.base_assert(
		v_first ->> 'schema' = 'qorpera.coding-worktree-created/v1'
			and v_first ->> 'workerId' = v_worker_id::text
			and v_first ->> 'worktreeCreatedAt' is not null,
		'3: first record response: ' || v_first::text
	);
	v_second := public.qorpera_record_coding_worktree_created(v_worker_id, v_lease);
	perform pg_temp.base_assert(
		v_second ->> 'worktreeCreatedAt' = v_first ->> 'worktreeCreatedAt',
		'3: idempotent worktree_created_at'
	);
	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.base_assert(
		(public.qorpera_coding_session_claim_json(v_session, v_worker) ->> 'worktreeCreatedAt') = (v_first ->> 'worktreeCreatedAt'),
		'3: claim json includes worktreeCreatedAt'
	);
end $$;

do $$
declare
	v_holder text := current_setting('qorpera_test.w5b_holder');
	v_bind jsonb := current_setting('qorpera_test.w5b_bind')::jsonb;
	v_scope jsonb := current_setting('qorpera_test.w5b_scope')::jsonb;
	v_cmd uuid := current_setting('qorpera_test.w5b_command')::uuid;
	v_sha text := current_setting('qorpera_test.w5b_input_sha');
	v_legacy_auth jsonb;
	v_legacy_route jsonb;
	v_remote jsonb;
	v_peer jsonb;
	v_local jsonb;
	v_read jsonb;
	v_cancel jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_legacy_auth := public.qorpera_authorize_coding_command(v_bind, v_scope, 'start', v_cmd, v_sha);
	v_legacy_route := public.qorpera_route_coding_command(v_bind, v_scope, 'start', v_cmd, v_sha);

	v_remote := pg_temp.w5b_v2('start', v_holder, false);
	perform pg_temp.base_assert(v_remote ->> 'schema' = 'qorpera.coding-command-authority/v2', '4: schema');
	perform pg_temp.base_assert(
		(v_remote -> 'binding') - 'authority' = v_legacy_auth - 'authority'
			and (v_remote #>> '{binding,authority,coding,workerId}') = (v_legacy_auth #>> '{authority,coding,workerId}')
			and (v_remote -> 'route') = v_legacy_route
			and (v_remote -> 'runAuthority') = 'null'::jsonb
			and (v_remote -> 'rebuildDue') = 'false'::jsonb
			and (v_remote -> 'diskEpoch') = 'null'::jsonb
			and (v_remote ->> 'vaultEnvVersion') ~ '^[0-9a-f]{64}$',
		'4: remote parity: ' || v_remote::text
	);

	v_peer := pg_temp.w5b_v2('start', null, true);
	perform pg_temp.base_assert(
		(v_peer -> 'route') = v_legacy_route
			and (v_peer #>> '{runAuthority,schema}') = 'qorpera.coding-machine-admission/v1'
			and (v_peer #>> '{runAuthority,intent}') = 'run'
			and (v_peer #>> '{runAuthority,machineId}') = current_setting('qorpera_test.w5b_machine')
			and (v_peer #>> '{runAuthority,workerId}') = current_setting('qorpera_test.w5b_worker')
			and (v_peer ->> 'vaultEnvVersion') = (v_remote ->> 'vaultEnvVersion'),
		'4: peer local parity: ' || v_peer::text
	);

	v_local := pg_temp.w5b_v2('start', v_holder, true);
	perform pg_temp.base_assert(
		(v_local #>> '{runAuthority,schema}') = 'qorpera.coding-machine-admission/v1'
			and (v_local ->> 'vaultEnvVersion') = (v_remote ->> 'vaultEnvVersion'),
		'4: ingress local parity'
	);

	v_read := pg_temp.w5b_v2('read', v_holder, true);
	v_cancel := pg_temp.w5b_v2('cancel', v_holder, true);
	perform pg_temp.base_assert(
		(v_read #>> '{binding,inputSha256}') = v_sha
			and (v_cancel #>> '{binding,inputSha256}') = v_sha,
		'4: read and cancel succeed'
	);
end $$;

do $$
declare
	v_holder text := current_setting('qorpera_test.w5b_holder');
	v_scope jsonb := current_setting('qorpera_test.w5b_scope')::jsonb;
	v_machine uuid := current_setting('qorpera_test.w5b_machine')::uuid;
	v_worker uuid := current_setting('qorpera_test.w5b_worker')::uuid;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.w5b_refused(
		format(
			'select public.qorpera_authorize_coding_command_v2(%L::jsonb, %L, %L::jsonb, ''start'', %L::uuid, %L)',
			current_setting('qorpera_test.w5b_bind'),
			v_holder,
			v_scope::text,
			current_setting('qorpera_test.w5b_command'),
			current_setting('qorpera_test.w5b_input_sha')
		),
		'42501',
		'Coding command authority required'
	);
	perform pg_temp.base_claims('service_role');

	perform pg_temp.w5b_refused(
		format('select pg_temp.w5b_v2(''start'', %L, true)', 'job.13350000-0000-4000-8000-000000009999.' || repeat('z', 43)),
		'42501',
		'native binding proof is refused'
	);

	perform pg_temp.w5b_refused(
		format(
			'select public.qorpera_authorize_coding_command_v2(%L::jsonb, %L, %L::jsonb, ''start'', %L::uuid, %L, %L::uuid, null, null, null)',
			current_setting('qorpera_test.w5b_bind'),
			v_holder,
			v_scope::text,
			current_setting('qorpera_test.w5b_command'),
			current_setting('qorpera_test.w5b_input_sha'),
			current_setting('qorpera_test.w5b_lease')
		),
		'22023',
		'Coding command input invalid'
	);

	perform pg_temp.w5b_refused(
		format('select pg_temp.w5b_v2(''bogus'', %L, false)', v_holder),
		'22023',
		'Coding command scope invalid'
	);

	perform pg_temp.w5b_refused(
		format(
			'select pg_temp.w5b_v2(''start'', %L, false, %L::jsonb)',
			v_holder,
			(v_scope || jsonb_build_object('vmId', '13350000-0000-4000-8000-000000009999'))::text
		),
		'42501',
		'Coding command scope differs'
	);

	perform pg_temp.w5b_refused(
		format('select pg_temp.w5b_v2(''start'', %L, false, null, %L)', v_holder, repeat('f', 64)),
		'42501',
		'Coding command authority unavailable'
	);

	begin
		set local session_replication_role = replica;
		update public.qorpera_coding_session_turns
		set submission = '{"kind":"finish","summary":"done"}'::jsonb,
			submission_receipt_id = current_setting('qorpera_test.w5b_command')::uuid,
			submitted_at = clock_timestamp()
		where worker_id = v_worker and sequence = 1;
		set local session_replication_role = origin;

		perform pg_temp.w5b_refused(
			format('select pg_temp.w5b_v2(''start'', %L, false)', v_holder),
			'42501',
			'Coding command authority unavailable'
		);
		perform pg_temp.base_assert(
			(pg_temp.w5b_v2('read', v_holder, false) #>> '{binding,inputSha256}') = current_setting('qorpera_test.w5b_input_sha'),
			'5: read still allowed after submission'
		);
		perform pg_temp.base_assert(
			(pg_temp.w5b_v2('cancel', v_holder, false) #>> '{binding,inputSha256}') = current_setting('qorpera_test.w5b_input_sha'),
			'5: cancel still allowed after submission'
		);
		raise exception using errcode = 'QE133';
	exception when sqlstate 'QE133' then null;
	end;

	begin
		set local session_replication_role = replica;
		update public.qorpera_coding_machines set removing_at = clock_timestamp() where id = v_machine;
		set local session_replication_role = origin;
		perform pg_temp.w5b_refused(
			format('select pg_temp.w5b_v2(''read'', %L, false)', v_holder),
			'42501',
			'Coding command placement unavailable'
		);
		raise exception using errcode = 'QE133';
	exception when sqlstate 'QE133' then null;
	end;

	begin
		set local session_replication_role = replica;
		update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = v_machine;
		set local session_replication_role = origin;
		perform pg_temp.w5b_refused(
			format('select pg_temp.w5b_v2(''read'', %L, false)', v_holder),
			'42501',
			'Coding command placement unavailable'
		);
		raise exception using errcode = 'QE133';
	exception when sqlstate 'QE133' then null;
	end;
end $$;

do $$
declare
	v_machine uuid := current_setting('qorpera_test.w5b_machine')::uuid;
	v_binding_text text := current_setting('qorpera_test.w5b_binding_text');
	v_node_sha text := current_setting('qorpera_test.w5b_node_sha');
	v_holder text := current_setting('qorpera_test.w5b_holder');
	v_op_id uuid := '13350000-0000-4000-8000-0000000000f1';
	v_ans jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_mark_coding_machine_new_disk(v_machine, 'exec-1335', v_binding_text, v_node_sha);
	v_ans := pg_temp.w5b_v2('read', v_holder, true);
	perform pg_temp.base_assert((v_ans -> 'rebuildDue') = 'true'::jsonb, '6: rebuildDue flips true when marked');
	perform pg_temp.base_assert((v_ans -> 'diskEpoch') = 'null'::jsonb, '6: diskEpoch null before rebuild record');

	perform public.qorpera_record_coding_machine_new_disk(v_machine, v_op_id, 'exec-1335', v_binding_text, v_node_sha);
	v_ans := pg_temp.w5b_v2('read', v_holder, true);
	perform pg_temp.base_assert((v_ans -> 'rebuildDue') = 'false'::jsonb, '6: rebuildDue clears after rebuild record');
	perform pg_temp.base_assert((v_ans ->> 'diskEpoch') = v_op_id::text, '6: diskEpoch reports replaced op id: ' || v_ans::text);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine,
		attachment_token = '13350000-0000-4000-8000-0000000000a2',
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = current_setting('qorpera_test.w5b_worker')::uuid;
	set local session_replication_role = origin;
end $$;

do $$
declare
	v_holder text := current_setting('qorpera_test.w5b_holder');
	v_worker uuid := current_setting('qorpera_test.w5b_worker')::uuid;
	v_sibling uuid := current_setting('qorpera_test.w5b_sibling')::uuid;
	v_machine uuid := current_setting('qorpera_test.w5b_machine')::uuid;
	v_authority uuid := '13350000-0000-4000-8000-000000000040';
	v_company_secret uuid := '13350000-0000-4000-8000-000000000071';
	v_member_secret uuid := '13350000-0000-4000-8000-000000000072';
	v_sibling_secret uuid := '13350000-0000-4000-8000-000000000073';
	v_grant_id uuid;
	v_v0 text;
	v_v0_again text;
	v_v1 text;
	v_v1_after_self_audit text;
	v_v2 text;
	v_v3 text;
	v_v4 text;
	v_v5 text;
	v_v6 text;
begin
	perform pg_temp.base_claims('service_role');
	v_v0 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	v_v0_again := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v0 = v_v0_again, '7: vaultEnvVersion deterministic across calls');

	insert into public.qorpera_cloud_secrets(
		id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id
	)
	values (
		v_company_secret, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_authority, 'company', null, 'environment', 'api_token', 'API token', 1, '92400000-0000-4000-8000-000000000001'
	);
	insert into public.qorpera_cloud_secret_versions(
		secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id
	)
	values (
		v_company_secret, 1, v_authority, 'kek-1335', convert_to('env-v1', 'UTF8'),
		encode(extensions.digest(convert_to('env-v1', 'UTF8'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001'
	);
	perform pg_temp.base_assert(
		(pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion') = v_v0,
		'7: ungranted company secret does not churn version'
	);

	insert into public.qorpera_coding_environment_grants(
		profile_id, environment_id, secret_id, repository, issued_by_user_id
	)
	values (
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_company_secret, 'qorpera/qorpera_base', '92400000-0000-4000-8000-000000000001'
	)
	returning id into v_grant_id;
	v_v1 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v1 <> v_v0, '7: grant bumps vaultEnvVersion');

	insert into public.qorpera_cloud_secret_audit_events(
		profile_id, environment_id, secret_id, secret_version, event_type, connector_id, coding_worker_id, coding_machine_id
	)
	values (
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_company_secret, 1, 'environment_secret_used', 'environment', v_worker, v_machine
	);
	v_v1_after_self_audit := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v1_after_self_audit = v_v1, '7: own current version audit does not bust cache');

	insert into public.qorpera_cloud_secret_versions(
		secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id
	)
	values (
		v_company_secret, 2, v_authority, 'kek-1335', convert_to('env-v2', 'UTF8'),
		encode(extensions.digest(convert_to('env-v2', 'UTF8'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001'
	);
	update public.qorpera_cloud_secrets set current_version = 2 where id = v_company_secret;
	v_v2 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v2 <> v_v1, '7: secret rotation bumps vaultEnvVersion');

	update public.qorpera_coding_environment_grants set status = 'revoked', revoked_at = clock_timestamp() where id = v_grant_id;
	v_v3 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v3 <> v_v2, '7: grant revocation bumps vaultEnvVersion');

	insert into public.qorpera_cloud_secrets(
		id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id
	)
	values (
		v_member_secret, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_authority, 'member', '92400000-0000-4000-8000-000000000001', 'environment', 'personal_token',
		'Personal token', 1, '92400000-0000-4000-8000-000000000001'
	);
	insert into public.qorpera_cloud_secret_versions(
		secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id
	)
	values (
		v_member_secret, 1, v_authority, 'kek-1335', convert_to('personal-v1', 'UTF8'),
		encode(extensions.digest(convert_to('personal-v1', 'UTF8'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001'
	);
	v_v4 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v4 <> v_v3, '7: adding member secret bumps vaultEnvVersion');

	insert into public.qorpera_cloud_secrets(
		id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id
	)
	values (
		v_sibling_secret, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_authority, 'company', null, 'environment', 'other_repo_token', 'Other repo token', 1, '92400000-0000-4000-8000-000000000001'
	);
	insert into public.qorpera_cloud_secret_versions(
		secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id
	)
	values (
		v_sibling_secret, 1, v_authority, 'kek-1335', convert_to('other-v1', 'UTF8'),
		encode(extensions.digest(convert_to('other-v1', 'UTF8'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001'
	);
	insert into public.qorpera_cloud_secret_audit_events(
		profile_id, environment_id, secret_id, secret_version, event_type, connector_id, coding_worker_id, coding_machine_id
	)
	values (
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		v_sibling_secret, 1, 'environment_secret_used', 'environment', v_sibling, v_machine
	);
	v_v5 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v5 <> v_v4, '7: sibling machine secret use bumps mask history version');

	set local session_replication_role = replica;
	update public.qorpera_profile_members
	set role = 'contributor'
	where profile_id = '92400000-0000-4000-8000-000000000010'
		and user_id = '92400000-0000-4000-8000-000000000001';
	set local session_replication_role = origin;
	v_v6 := pg_temp.w5b_v2('read', v_holder, false) ->> 'vaultEnvVersion';
	perform pg_temp.base_assert(v_v6 <> v_v5, '7: member role change bumps vaultEnvVersion');
end $$;

rollback;
