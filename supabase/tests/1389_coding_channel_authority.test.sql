-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"

do $$
declare
	v_role text;
	v_fn text := 'public.qorpera_authorize_coding_channel(jsonb,jsonb,text)';
begin
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
end $$;

create function pg_temp.c1389_refused(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
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
	v_node_id uuid := '13890000-0000-4000-8000-0000000000e1';
	v_machine_id uuid := '13890000-0000-4000-8000-0000000000d1';
	v_worker_id uuid := '13890000-0000-4000-8000-0000000000b1';
	v_node_sha text := encode(extensions.digest(convert_to('node-1389', 'UTF8'), 'sha256'), 'hex');
	v_nas_policy jsonb := '{"schema":"qorpera.coding-nas/v1","rootPath":"/srv/qorpera-coding-1389","mountDevice":"nas-1389"}'::jsonb;
	v_binding_obj jsonb;
	v_binding_text text;
	v_instance_sha text;
	v_claim jsonb;
	v_begin jsonb;
	v_pass jsonb;
	v_run_id uuid;
	v_bind jsonb;
	v_lease_token uuid;
	v_root text;
	v_storage jsonb;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_scope jsonb;
	v_answer jsonb;
begin
	perform pg_temp.base_claims('service_role');

	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(
		id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
		headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled
	)
	values (
		v_node_id, v_node_sha, 'node-1389', 1, 16000, 68719476736,
		1000, 4294967296, 4000, 8589934592, true
	);
	insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
	values (
		v_node_id, '13890000-0000-4000-8000-0000000000e2', clock_timestamp(),
		'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}'::jsonb
	);
	insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
	values (v_node_id, '{}'::jsonb, repeat('a', 64));
	insert into public.qorpera_runtime_node_inventory_receipts(
		node_id, observation_id, node_version, policy_sha256, context_sha256, inventory
	)
	values (v_node_id, '13890000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}'::jsonb);
	insert into public.qorpera_runtime_node_providers(
		provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes
	)
	values ('coding', 'lxd', v_node_id, repeat('d', 64), 2000, 4294967296);
	set local session_replication_role = origin;

	perform public.qorpera_configure_coding_executor(
		'92400000-0000-4000-8000-000000000020', 'exec-1389', true, array['codex', 'claude-code']
	);
	set local session_replication_role = replica;
	update public.qorpera_coding_executors
	set nas_policy = v_nas_policy, nas_machine_id_sha256 = v_node_sha
	where environment_id = '92400000-0000-4000-8000-000000000020' and owner = 'exec-1389';
	set local session_replication_role = origin;

	perform public.qorpera_set_coding_repository_grant(
		'92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030',
		pg_temp.c3_repo(),
		true
	);

	perform pg_temp.base_assert(
		pg_temp.c3_dispatch(
			pg_temp.c3_alice(), 'dispatch-1389-a', 'QorperaOS/agents/alice/todos/fix-login/session-1389-a',
			pg_temp.c3_brief(v_worker_id)
		) -> 'units' -> 0 ->> 'outcome' = 'saved',
		'2: dispatch coding worker'
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
		'92400000-0000-4000-8000-000000000001', 'exec-1389', v_node_sha, v_binding_obj, v_instance_sha,
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
	v_claim := public.qorpera_claim_coding_session('exec-1389', 300);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = v_worker_id::text, '2: claimed worker');
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
		attachment_token = '13890000-0000-4000-8000-0000000000a1',
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = v_worker_id;
	insert into public.qorpera_coding_storage_volumes(
		worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding, member_user_id, guest_uid
	)
	values (
		v_worker_id, '92400000-0000-4000-8000-000000000020', 'exec-1389', v_node_sha, 1, v_storage,
		'92400000-0000-4000-8000-000000000001', 200001
	);
	update public.qorpera_coding_sessions set storage_volume_id = v_worker_id where worker_id = v_worker_id;
	set local session_replication_role = origin;

	v_begin := public.qorpera_begin_coding_turn(v_worker_id, v_lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	select o.run_id into strict v_run_id
	from public.qorpera_wake_occurrences o
	where o.id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' ? v_run_id::text, '2: turn run materialized');
	v_bind := pg_temp.base_start(v_run_id);

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	v_scope := jsonb_build_object(
		'workerId', v_worker_id,
		'vmId', v_machine_id,
		'requestId', public.qorpera_coding_turn_id(v_worker_id, v_worker.sequence),
		'turn', v_worker.sequence
	);

	perform pg_temp.base_claims('authenticated');
	perform pg_temp.c1389_refused(
		format('select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''exec'')', v_bind::text, v_scope::text),
		'42501',
		'Coding channel authority required'
	);

	perform pg_temp.base_claims('service_role');
	perform pg_temp.c1389_refused(
		format('select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''ssh'')', v_bind::text, v_scope::text),
		'22023',
		'Coding channel scope invalid'
	);
	perform pg_temp.c1389_refused(
		format(
			'select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''exec'')',
			v_bind::text,
			(v_scope || '{"extra":true}'::jsonb)::text
		),
		'22023',
		'Coding channel scope invalid'
	);
	perform pg_temp.c1389_refused(
		format('select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''exec'')', v_bind::text, v_scope::text),
		'42501',
		'Coding channel authority unavailable'
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set harness = 'claude-code' where worker_id = v_worker_id;
	set local session_replication_role = origin;

	perform pg_temp.c1389_refused(
		format(
			'select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''exec'')',
			v_bind::text,
			(v_scope || jsonb_build_object('turn', v_worker.sequence + 1))::text
		),
		'42501',
		'Coding channel scope differs'
	);

	v_answer := public.qorpera_authorize_coding_channel(v_bind, v_scope, 'exec');
	perform pg_temp.base_assert(
		v_answer ->> 'schema' = 'qorpera.coding-channel-authority/v1'
			and v_answer ->> 'state' = 'authorized'
			and v_answer ->> 'workerId' = v_worker_id::text
			and v_answer ->> 'vmId' = v_machine_id::text
			and v_answer ->> 'requestId' = (v_scope ->> 'requestId')
			and (v_answer ->> 'turn')::integer = v_worker.sequence
			and v_answer ->> 'executorOwner' = 'exec-1389'
			and v_answer ->> 'providerId' = 'lxd',
		'3: authorized exec channel: ' || v_answer::text
	);

	v_answer := public.qorpera_authorize_coding_channel(v_bind, v_scope, 'sftp');
	perform pg_temp.base_assert(
		v_answer ->> 'state' = 'authorized' and v_answer ->> 'executorOwner' = 'exec-1389',
		'3: authorized sftp channel: ' || v_answer::text
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_machines
	set new_disk_at = clock_timestamp(), folder_restart_at = clock_timestamp()
	where id = v_machine_id;
	set local session_replication_role = origin;

	v_answer := public.qorpera_authorize_coding_channel(v_bind, v_scope, 'exec');
	perform pg_temp.base_assert(
		v_answer = jsonb_build_object(
			'schema', 'qorpera.coding-channel-authority/v1',
			'state', 'refused',
			'reason', 'MACHINE_NEW_DISK'
		),
		'4: new_disk_at refuses channel: ' || v_answer::text
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_machines set new_disk_at = null, folder_restart_at = null where id = v_machine_id;
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = v_machine_id;
	set local session_replication_role = origin;

	v_answer := public.qorpera_authorize_coding_channel(v_bind, v_scope, 'exec');
	perform pg_temp.base_assert(
		v_answer = jsonb_build_object(
			'schema', 'qorpera.coding-channel-authority/v1',
			'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'
		),
		'5: suspended demand refuses channel: ' || v_answer::text
	);

	set local session_replication_role = replica;
	update public.qorpera_runtime_node_demands set suspended_at = null where allocation_id = v_machine_id;
	update public.qorpera_coding_sessions
	set attached_machine_id = null,
		attachment_token = null,
		attachment_until = null,
		attachment_turn = null,
		attached_at = null
	where worker_id = v_worker_id;
	set local session_replication_role = origin;

	v_answer := public.qorpera_authorize_coding_channel(v_bind, v_scope, 'exec');
	perform pg_temp.base_assert(
		v_answer ->> 'state' = 'refused' and v_answer ->> 'reason' = 'MACHINE_NOT_RUNNING',
		'6: detached session refuses channel: ' || v_answer::text
	);

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine_id,
		attachment_token = '13890000-0000-4000-8000-0000000000a1',
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = v_worker_id;
	set local session_replication_role = origin;

	perform public.qorpera_submit_coding_turn(
		v_bind,
		jsonb_build_object(
			'kind', 'ask',
			'operationKey', 'ask-1389',
			'summary', 'Need clarification.',
			'question', 'Which branch should we target?'
		)
	);

	perform pg_temp.c1389_refused(
		format('select public.qorpera_authorize_coding_channel(%L::jsonb, %L::jsonb, ''exec'')', v_bind::text, v_scope::text),
		'42501',
		'Coding channel authority unavailable'
	);
end $$;
