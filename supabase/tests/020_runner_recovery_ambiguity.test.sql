begin;

insert into auth.users (id, email)
values ('50000000-0000-4000-8000-000000000001', 'runner-owner@example.test');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('50000000-0000-4000-8000-000000000010', 'Runner recovery profile', '50000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	'50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000001',
	'runner-owner@example.test', 'Runner owner', 'owner'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"50000000-0000-4000-8000-000000000001","email":"runner-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
)
values (
	'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000010',
	'Runner recovery', 1, '50000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_workspaces (
	id, profile_id, environment_id, client_workspace_id, name, created_by_user_id
)
values (
	'50000000-0000-4000-8000-000000000030', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000031',
	'Runner workspace', '50000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id
)
values (
	'50000000-0000-4000-8000-000000000040', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000030',
	'50000000-0000-4000-8000-000000000041', repeat('c', 64), 2, 1, 0, 0,
	'50000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_substrate_versions (
	id, profile_id, environment_id, company_snapshot_id, client_version_id,
	contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id
)
values (
	'50000000-0000-4000-8000-000000000050', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000040',
	'50000000-0000-4000-8000-000000000051', 1, 0, 0, repeat('d', 64),
	'50000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_runners (
	id, profile_id, client_runner_id, display_name, capabilities, max_concurrency,
	status, platform, runner_version, activation_token_sha256, activation_expires_at,
	session_token_sha256, session_expires_at, registered_by_user_id, activated_at, last_seen_at
)
values (
	'50000000-0000-4000-8000-000000000060', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000061', 'Recovery runner', '["agent_turn"]', 1,
	'active', 'linux-x64', '0.1.0', repeat('e', 64), statement_timestamp() + interval '1 hour',
	repeat('a', 64), statement_timestamp() + interval '15 minutes',
	'50000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()
);

insert into public.qorpera_runner_jobs (
	id, profile_id, environment_id, substrate_version_id, client_job_id,
	required_capability, job_type, payload, status, attempt_count, runner_id,
	client_lease_id, lease_token_sha256, lease_expires_at, created_by_user_id, started_at
)
values (
	'50000000-0000-4000-8000-000000000070', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000050',
	'50000000-0000-4000-8000-000000000071', 'agent_turn', 'agent_turn', '{"prompt":"recover"}',
	'leased', 1, '50000000-0000-4000-8000-000000000060',
	'50000000-0000-4000-8000-000000000072', repeat('b', 64),
	statement_timestamp() + interval '2 minutes', '50000000-0000-4000-8000-000000000001',
	statement_timestamp()
);

insert into public.qorpera_runner_model_policies (
	job_id, profile_id, environment_id, allowed_models, max_calls,
	max_input_tokens, max_output_tokens, authorized_by_user_id
)
values (
	'50000000-0000-4000-8000-000000000070', '50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000020', '[{"provider":"openai","model":"gpt-test"}]',
	4, 1000, 1000, '50000000-0000-4000-8000-000000000001'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', false);

select public.qorpera_runner_broker_reserve_model_request(
	'50000000-0000-4000-8000-000000000060', repeat('a', 64),
	'50000000-0000-4000-8000-000000000070', repeat('b', 64),
	'50000000-0000-4000-8000-000000000080', 'openai', 'gpt-test', repeat('f', 64), 100, 10
);

update public.qorpera_runner_model_requests
set reservation_expires_at = statement_timestamp() - interval '1 minute'
where client_request_id = '50000000-0000-4000-8000-000000000080';

select public.qorpera_runner_broker_reserve_model_request(
	'50000000-0000-4000-8000-000000000060', repeat('a', 64),
	'50000000-0000-4000-8000-000000000070', repeat('b', 64),
	'50000000-0000-4000-8000-000000000080', 'openai', 'gpt-test', repeat('f', 64), 100, 10
);

do $$
begin
	if (
		select status <> 'reserved' or reservation_expires_at < statement_timestamp() + interval '4 minutes'
		from public.qorpera_runner_model_requests
		where client_request_id = '50000000-0000-4000-8000-000000000080'
	) then
		raise exception 'ambiguous model reservation was not renewed for recovery';
	end if;
	if exists (
		select 1 from public.qorpera_runner_model_usage_observations
		where request_id = (
			select id from public.qorpera_runner_model_requests
			where client_request_id = '50000000-0000-4000-8000-000000000080'
		)
	) then
		raise exception 'ambiguous model request invented a zero-usage observation';
	end if;
end
$$;

select public.qorpera_runner_broker_finalize_model_request(
	'50000000-0000-4000-8000-000000000060', repeat('a', 64),
	'50000000-0000-4000-8000-000000000070', repeat('b', 64),
	'50000000-0000-4000-8000-000000000080', repeat('f', 64),
	'failed', 200, 11, 75, null, 'gateway_usage_exceeded'
);

do $$
begin
	if not exists (
		select 1 from public.qorpera_runner_model_usage_observations
		where job_id = '50000000-0000-4000-8000-000000000070'
			and outcome = 'failed' and input_tokens = 200 and output_tokens = 11 and cost_microusd = 75
	) then
		raise exception 'provider usage beyond the reservation was not retained';
	end if;
end
$$;

select public.qorpera_runner_broker_reserve_model_request(
	'50000000-0000-4000-8000-000000000060', repeat('a', 64),
	'50000000-0000-4000-8000-000000000070', repeat('b', 64),
	'50000000-0000-4000-8000-000000000081', 'openai', 'gpt-test', repeat('1', 64), 100, 10
);

update public.qorpera_runner_model_requests
set reservation_expires_at = statement_timestamp() - interval '1 minute'
where client_request_id = '50000000-0000-4000-8000-000000000081';

do $$
begin
	begin
		perform public.qorpera_complete_runner_job_v4(
			'50000000-0000-4000-8000-000000000060', repeat('a', 64),
			'50000000-0000-4000-8000-000000000070', repeat('b', 64),
			'50000000-0000-4000-8000-000000000090', '50000000-0000-4000-8000-000000000091', '{}'
		);
		raise exception 'job completion accepted an ambiguous model reservation';
	exception when object_not_in_prerequisite_state then
		null;
	end;
end
$$;

insert into public.qorpera_runner_usage_observations (
	profile_id, environment_id, job_id, runner_id, actor_user_id,
	execution_ms, input_bytes, output_bytes, result_bytes,
	wall_time_limit_ms, memory_limit_bytes, cpu_limit_millis, pid_limit,
	input_limit_bytes, output_limit_bytes, result_limit_bytes,
	reserved_cpu_milliseconds, reserved_memory_mib_milliseconds
)
values (
	'50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000020',
	'50000000-0000-4000-8000-000000000070', '50000000-0000-4000-8000-000000000060',
	'50000000-0000-4000-8000-000000000001', 10, 1, 1, 2,
	1000, 67108864, 1000, 16, 1024, 1024, 1024, 10, 640
);

do $$
begin
	begin
		update public.qorpera_runner_usage_observations set execution_ms = 11
		where job_id = '50000000-0000-4000-8000-000000000070';
		raise exception 'runner usage fact was mutable';
	exception when object_not_in_prerequisite_state then
		null;
	end;
	begin
		delete from public.qorpera_runner_model_usage_observations
		where job_id = '50000000-0000-4000-8000-000000000070';
		raise exception 'model usage fact was deletable';
	exception when object_not_in_prerequisite_state then
		null;
	end;
	begin
		delete from public.qorpera_runner_jobs
		where id = '50000000-0000-4000-8000-000000000070';
		raise exception 'usage-bearing job cascade-deleted billing facts';
	exception when foreign_key_violation or object_not_in_prerequisite_state then
		null;
	end;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"50000000-0000-4000-8000-000000000001","email":"runner-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

select public.qorpera_reissue_runner_activation(
	'50000000-0000-4000-8000-000000000060', repeat('9', 64)
);

do $$
begin
	if (select status from public.qorpera_runners where id = '50000000-0000-4000-8000-000000000060') <> 'pending' then
		raise exception 'active runner could not be returned to pairing state';
	end if;
	if public.qorpera_runner_session_valid('50000000-0000-4000-8000-000000000060', repeat('a', 64)) then
		raise exception 'active runner re-pair retained old session authority';
	end if;
	if (select status from public.qorpera_runner_jobs where id = '50000000-0000-4000-8000-000000000070') <> 'queued' then
		raise exception 'active runner re-pair did not recover its leased job';
	end if;
end
$$;

rollback;
