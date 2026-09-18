begin;

insert into auth.users (id, email)
values
	('15000000-0000-4000-8000-000000000001', 'orchestrator-owner@example.test'),
	('15000000-0000-4000-8000-000000000002', 'orchestrator-member@example.test');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values (
	'15000000-0000-4000-8000-000000000010', 'Orchestrated company',
	'15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values
	(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000001',
		'orchestrator-owner@example.test', 'Orchestrator Owner', 'owner'
	),
	(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000002',
		'orchestrator-member@example.test', 'Orchestrator Member', 'contributor'
	);

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-000000000010',
	'Orchestrated environment', 1, '15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_workspaces (
	id, profile_id, environment_id, client_workspace_id, name, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000030',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-000000000031',
	'Orchestrator fixture', '15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000040',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-000000000030',
	'15000000-0000-4000-8000-000000000041', repeat('a', 64), 2, 3, 0, 0,
	'15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_substrate_versions (
	id, profile_id, environment_id, company_snapshot_id, client_version_id,
	contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000050',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-000000000040',
	'15000000-0000-4000-8000-000000000051', 1, 0, 0, repeat('b', 64),
	'15000000-0000-4000-8000-000000000001'
);

update public.qorpera_company_files
set canonical_workspace_id = '15000000-0000-4000-8000-000000000030',
	head_snapshot_id = '15000000-0000-4000-8000-000000000040',
	state = 'ready', logical_bytes = 0, updated_at = statement_timestamp()
where environment_id = '15000000-0000-4000-8000-000000000020';

insert into public.qorpera_profile_staff (
	profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state,
	model_provider, model_id,
	created_at, updated_at, updated_by_user_id
) values (
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000054',
	'Cloud operator', 'Operations', 'Execute durable company work.',
	'blue', 'round', 'active', 'active', 'openai', 'gpt-test',
	statement_timestamp(), statement_timestamp(),
	'15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_logical_computers (
	id, profile_id, client_computer_id, display_name, template_key, template_version,
	capabilities, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000080',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000081', 'Logical finance computer',
	'qorpera-linux', 'v1', '["agent_turn"]',
	'15000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_shared_sessions (
	id, client_session_id, profile_id, environment_id, title, status, created_by_user_id,
	company_snapshot_id, staff_agent_id, staff_version, execution_scope, created_at
) values (
	'15000000-0000-4000-8000-000000000055',
	'15000000-0000-4000-8000-000000000055',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'Orchestrated session', 'open', '15000000-0000-4000-8000-000000000001',
	'15000000-0000-4000-8000-000000000040',
	'15000000-0000-4000-8000-000000000054', 1, '{}',
	'2026-08-20T11:59:00.000Z'
);

set role authenticated;

select public.qorpera_append_account_event(
	'15000000-0000-4000-8000-000000000055',
	'15000000-0000-4000-8000-000000000056',
	'session_info',
	'{"schema":"qorpera.shared-session/v1","entry":{"type":"session_info","id":"cloud-session-info:15000000-0000-4000-8000-000000000055","parentId":null,"timestamp":"2026-08-20T11:59:00.000Z","name":"Orchestrated session"}}',
	0
);

select set_config(
	'qorpera_test.provider_connection',
	public.qorpera_register_provider_connection(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000060',
		null, 'openai', 'api_key', 'openai-responses',
		'vault://company/provider/openai', 'acct_test', 'company-api-budget',
		'qorpera-provider-consent/v1', null,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true -- Explicit connection consent for this fixture's autonomous runs.
	)::text,
	false
);

insert into storage.objects (bucket_id, name, metadata) values (
	'qorpera-profile-objects',
	'15000000-0000-4000-8000-000000000010/' || repeat('6', 64),
	'{"size":"11"}'
);

insert into storage.objects (bucket_id, name, metadata) values (
	'qorpera-profile-objects',
	'15000000-0000-4000-8000-000000000010/' || repeat('c', 64),
	'{"size":"12"}'
);

select set_config(
	'qorpera_test.sponsor',
	public.qorpera_create_execution_sponsor_binding(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000061',
		'company_api_billing',
		(current_setting('qorpera_test.provider_connection')::jsonb ->> 'connection_id')::uuid,
		1, true
	)::text,
	false
);

do $$
declare
	v_rejected boolean := false;
begin
	begin
		perform public.qorpera_register_provider_connection(
			'15000000-0000-4000-8000-000000000010',
			'15000000-0000-4000-8000-000000000063',
			'15000000-0000-4000-8000-000000000002',
			'openai', 'api_key', 'openai-responses',
			'vault://member/provider/openai', 'acct_member', 'member-api-budget',
			'qorpera-provider-consent/v1', null,
			'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
			false
		);
	exception when insufficient_privilege then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'an authorizer enrolled another member personal connection';
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000002","email":"orchestrator-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);
select set_config(
	'qorpera_test.member_provider_connection',
	public.qorpera_register_provider_connection(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000063',
		'15000000-0000-4000-8000-000000000002',
		'openai', 'api_key', 'openai-responses',
		'vault://member/provider/openai', 'acct_member', 'member-api-budget',
		'qorpera-provider-consent/v1', null,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		false
	)::text,
	false
);

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
do $$
declare
	v_rejected boolean := false;
begin
	begin
		perform public.qorpera_create_execution_sponsor_binding(
			'15000000-0000-4000-8000-000000000010',
			'15000000-0000-4000-8000-000000000064',
			'company_api_billing',
			(current_setting('qorpera_test.member_provider_connection')::jsonb ->> 'connection_id')::uuid,
			1, false
		);
	exception when invalid_parameter_value then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'a member-owned provider connection became a company sponsor';
	end if;

	perform public.qorpera_create_execution_sponsor_binding(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000065',
		'member_connection',
		(current_setting('qorpera_test.member_provider_connection')::jsonb ->> 'connection_id')::uuid,
		1, false
	);
	v_rejected := false;
	begin
		perform public.qorpera_create_execution_sponsor_binding(
			'15000000-0000-4000-8000-000000000010',
			'15000000-0000-4000-8000-000000000066',
			'member_connection',
			(current_setting('qorpera_test.member_provider_connection')::jsonb ->> 'connection_id')::uuid,
			1, true
		);
	exception when insufficient_privilege then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'a sponsor exceeded the member autonomous-execution consent';
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000002","email":"orchestrator-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);
select set_config(
	'qorpera_test.member_provider_connection_v2',
	public.qorpera_register_provider_connection(
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000063',
		'15000000-0000-4000-8000-000000000002',
		'openai', 'api_key', 'openai-responses',
		'vault://member/provider/openai-v2', 'acct_member', 'member-api-budget',
		'qorpera-provider-consent/v2', null,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true
	)::text,
	false
);
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
select public.qorpera_create_execution_sponsor_binding(
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000067',
	'member_connection',
	(current_setting('qorpera_test.member_provider_connection_v2')::jsonb ->> 'connection_id')::uuid,
	2, true
);

select public.qorpera_configure_staff_execution_authority(
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000054',
	(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
	'15000000-0000-4000-8000-000000000080'
);

select public.qorpera_configure_session_execution(
	'15000000-0000-4000-8000-000000000055',
	(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
	'15000000-0000-4000-8000-000000000080',
	'agent_turn', 'agent_turn', 'automatic', null, '{}'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000002","email":"orchestrator-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);

select set_config(
	'qorpera_test.session_input',
	public.qorpera_append_session_input(
		'15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-000000000057', 'user_message',
		jsonb_build_object(
			'schema', 'qorpera.session-prompt/v1',
			'text', 'Run from a pinned company revision',
			'images', jsonb_build_array(jsonb_build_object(
				'objectSha256', repeat('6', 64),
				'bytes', 11,
				'mediaType', 'image/png'
			))
		)
	)::text,
	false
);

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

select set_config(
	'qorpera_test.cloud_routine',
	public.qorpera_upsert_cloud_routine(
		'15000000-0000-4000-8000-000000000020',
		'15000000-0000-4000-8000-000000000074',
		'15000000-0000-4000-8000-000000000075',
		'15000000-0000-4000-8000-000000000054',
		'Hourly company review', 'Review durable company operations.',
		'[{"id":"schedule-main","kind":"schedule","intervalMinutes":60}]',
		'high',
		(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
		'15000000-0000-4000-8000-000000000080',
		'agent_turn', 'agent_turn', true,
		'review', 'operations.hourly-review',
		array['15000000-0000-4000-8000-000000000054'::uuid]
	)::text,
	false
);

reset role;
do $$
begin
	if not public.qorpera_cloud_routine_trigger_valid(
		'{"id":"weekday-anchor","kind":"schedule","intervalMinutes":1440,"startAt":"2026-08-24T09:00:00.000Z","weekdays":["monday","tuesday","wednesday","thursday","friday"],"localTime":"09:00","timeZone":"UTC"}'::jsonb
	) then
		raise exception 'cloud routine rejected an anchored weekday interval';
	end if;
	if public.qorpera_cloud_routine_trigger_valid(
		'{"id":"weekday-anchor","kind":"schedule","intervalMinutes":1440,"startAt":"now","weekdays":["monday","tuesday","wednesday","thursday","friday"],"localTime":"09:00","timeZone":"UTC"}'::jsonb
	) then
		raise exception 'cloud routine accepted a relative weekday anchor';
	end if;
	if not public.qorpera_cloud_routine_trigger_valid(
		'{"id":"office-hours","kind":"schedule","intervalMinutes":30,"months":[2,5],"weekdays":["monday","tuesday","wednesday","thursday","friday"],"windowStart":"09:00","windowEnd":"17:00","timeZone":"UTC"}'::jsonb
	) then
		raise exception 'cloud routine rejected an advanced interval window';
	end if;
	if public.qorpera_cloud_routine_trigger_valid(
		'{"id":"bad-office-hours","kind":"schedule","intervalMinutes":30,"months":[2,2],"windowStart":"09:00","windowEnd":"17:00","timeZone":"UTC"}'::jsonb
	) then
		raise exception 'cloud routine accepted duplicate advanced months';
	end if;
	if public.qorpera_cloud_routine_trigger_valid(
		'{"id":"bad-office-hours","kind":"schedule","intervalMinutes":30,"windowStart":"17:00","windowEnd":"09:00","timeZone":"UTC"}'::jsonb
	) then
		raise exception 'cloud routine accepted a reversed advanced window';
	end if;
	if public.qorpera_cloud_routine_trigger_valid(
		'{"id":"bad-office-hours","kind":"schedule","intervalMinutes":30,"windowStart":"09:00","windowEnd":"17:00","timeZone":"auto"}'::jsonb
	) then
		raise exception 'cloud routine accepted an unresolved advanced timezone';
	end if;
end
$$;
set role authenticated;

do $$
begin
	begin
		perform public.qorpera_upsert_cloud_routine(
			'15000000-0000-4000-8000-000000000020',
			'15000000-0000-4000-8000-000000000076',
			'15000000-0000-4000-8000-000000000077',
			'15000000-0000-4000-8000-000000000054',
			'Invalid cloud schedule', 'This must never be silently parked.',
			'[{"id":"bad-schedule","kind":"schedule","intervalMinutes":60,"unknown":true}]',
			'high',
			(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
			'15000000-0000-4000-8000-000000000080',
			'agent_turn', 'agent_turn', true, 'automatic', null, '{}'
		);
		raise exception 'cloud routine accepted an unknown schedule field';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_upsert_cloud_routine(
			'15000000-0000-4000-8000-000000000020',
			'15000000-0000-4000-8000-000000000078',
			'15000000-0000-4000-8000-000000000079',
			'15000000-0000-4000-8000-000000000054',
			'Unsupported cloud event', 'This must be rejected at admission.',
			'[{"id":"github-event","kind":"github_event","intervalMinutes":60}]',
			'high',
			(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
			'15000000-0000-4000-8000-000000000080',
			'agent_turn', 'agent_turn', true, 'automatic', null, '{}'
		);
		raise exception 'cloud routine accepted an unsupported trigger kind';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_upsert_cloud_routine(
			'15000000-0000-4000-8000-000000000020',
			'15000000-0000-4000-8000-000000000076',
			'15000000-0000-4000-8000-000000000077',
			'15000000-0000-4000-8000-000000000054',
			'Infinite cloud schedule', 'This must never remain permanently due.',
			'[{"id":"bad-start","kind":"schedule","intervalMinutes":60,"startAt":"infinity"}]',
			'high',
			(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
			'15000000-0000-4000-8000-000000000080',
			'agent_turn', 'agent_turn', true, 'automatic', null, '{}'
		);
		raise exception 'cloud routine accepted an infinite schedule start';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_upsert_cloud_routine(
			'15000000-0000-4000-8000-000000000020',
			'15000000-0000-4000-8000-000000000076',
			'15000000-0000-4000-8000-000000000077',
			'15000000-0000-4000-8000-000000000054',
			'Relative cloud schedule', 'This must not depend on database clock parsing.',
			'[{"id":"bad-start","kind":"schedule","intervalMinutes":60,"startAt":"now"}]',
			'high',
			(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
			'15000000-0000-4000-8000-000000000080',
			'agent_turn', 'agent_turn', true, 'automatic', null, '{}'
		);
		raise exception 'cloud routine accepted a relative schedule start';
	exception when invalid_parameter_value then null;
	end;
end
$$;

do $$
begin
	if jsonb_array_length(public.qorpera_list_cloud_routines(
		'15000000-0000-4000-8000-000000000020'
	)) <> 1 then
		raise exception 'authorized company member cannot inspect the durable routine definition';
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
declare v_runs jsonb; v_run uuid;
begin
	begin
		reset role;
		perform set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
		set local role authenticated;
		perform public.qorpera_append_session_input(
			'15000000-0000-4000-8000-000000000055', '15000000-0000-4000-8000-000000000160',
			'user_message', '{"schema":"qorpera.session-prompt/v1","text":"Owner follows member","images":[]}'
		);
		perform set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
		perform public.qorpera_append_session_input(
			'15000000-0000-4000-8000-000000000055', '15000000-0000-4000-8000-000000000161',
			'user_message', '{"schema":"qorpera.session-prompt/v1","text":"Member follows owner","images":[]}'
		);
		reset role;
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
		v_runs := public.qorpera_materialize_session_execution_runs(32);
		v_run := (v_runs -> 0 ->> 'run_id')::uuid;
		if jsonb_array_length(v_runs) <> 1 or not exists (
			select 1 from public.qorpera_execution_runs r
			join public.qorpera_runner_jobs j on j.id = r.job_id
			join public.qorpera_wake_occurrences w on w.run_id = r.id
			where r.id = v_run and r.requested_by_user_id = '15000000-0000-4000-8000-000000000002'
				and j.created_by_user_id = r.requested_by_user_id and w.requested_by_user_id = r.requested_by_user_id
				and r.input_ids = array[(current_setting('qorpera_test.session_input')::jsonb ->> 'input_id')::uuid]
		) or exists (
			select 1 from public.qorpera_session_inputs where client_input_id in (
				'15000000-0000-4000-8000-000000000160', '15000000-0000-4000-8000-000000000161'
			) and execution_run_id is not null
		) then raise exception 'configured-session batching crossed an author boundary or forged its requester'; end if;
		raise sqlstate 'QRP01' using message = 'rollback mixed-author probe';
	exception when sqlstate 'QRP01' then null;
	end;
end $$;
select set_config(
	'qorpera_test.materialized_runs',
	public.qorpera_materialize_session_execution_runs(32)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_inputs jsonb := public.qorpera_list_session_inputs(
		'15000000-0000-4000-8000-000000000055', 0, 100
	);
begin
	if v_inputs -> 'items' -> 0 ->> 'status' is distinct from 'processing' then
		raise exception 'hosted execution input was still displayed as queued';
	end if;
end
$$;
select public.qorpera_enqueue_execution_run(
	'15000000-0000-4000-8000-000000000072',
	'15000000-0000-4000-8000-000000000020', null,
	'manual', '15000000-0000-4000-8000-000000000073',
	'15000000-0000-4000-8000-000000000050',
	'15000000-0000-4000-8000-000000000054', 1,
	(current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
	'agent_turn', 'agent_turn', '{"prompt":"Exercise ambiguous operation recovery"}',
	'automatic', null, '{}', '15000000-0000-4000-8000-000000000080'
);

reset role;
do $$
begin
	if has_function_privilege(
		'service_role',
		'public.qorpera_claim_runner_job(uuid, text, uuid, text)',
		'execute'
	) then
		raise exception 'runner self-scheduling claim remains callable';
	end if;
	if has_table_privilege(
		'service_role', 'public.qorpera_runner_company_revision_intents', 'insert'
	) or has_table_privilege(
		'authenticated', 'public.qorpera_runner_company_revision_intents', 'insert'
	) then
		raise exception 'runner Company File intent table is directly writable';
	end if;
	if not has_function_privilege(
		'service_role',
		'public.qorpera_append_runner_transcript_event(uuid, text, uuid, text, uuid, uuid, text, jsonb, bigint)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_complete_runner_job_v6(uuid, text, uuid, text, uuid, uuid, uuid, jsonb)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_prepare_company_revision(uuid, text, uuid, text, uuid, uuid, text, integer, integer, integer, bigint)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_begin_company_revision_graph(uuid, text, uuid, text, uuid, uuid, uuid, text, text, integer, bigint)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_append_company_revision_graph(uuid, text, uuid, text, uuid, uuid, jsonb)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_complete_company_revision_graph(uuid, text, uuid, text, uuid, uuid)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_authorize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_finalize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_broker_list_transcript(uuid, text, uuid, text, bigint, integer)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_broker_list_inputs(uuid, text, uuid, text)',
		'execute'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_runner_broker_authorize_company_file_object(uuid, text, uuid, text, text, bigint, text)',
		'execute'
	) then
		raise exception 'runner input/transcript/completion boundaries are not callable by the broker';
	end if;
	if jsonb_array_length(current_setting('qorpera_test.materialized_runs')::jsonb) <> 1 then
		raise exception 'session queue did not materialize exactly one immutable run';
	end if;
	if (select count(*) from public.qorpera_execution_run_events
		where run_id = (current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')::uuid
			and event_type = 'queued') <> 1 then
		raise exception 'execution run was not recorded immutably before dispatch';
	end if;
	if (select execution_run_id from public.qorpera_session_inputs
		where id = (current_setting('qorpera_test.session_input')::jsonb ->> 'input_id')::uuid)
		is distinct from (current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')::uuid then
		raise exception 'exact queued input set was not atomically assigned to the run';
	end if;
	if not exists (
		select 1
		from public.qorpera_session_events as event
		where event.session_input_id = (current_setting('qorpera_test.session_input')::jsonb ->> 'input_id')::uuid
			and event.actor_user_id = '15000000-0000-4000-8000-000000000002'
			and event.body #>> '{entry,message,role}' = 'user'
			and event.body #>> '{entry,message,content,0,text}' = 'Run from a pinned company revision'
			and event.execution_kind is null
	) then
		raise exception 'control plane did not preserve the queued input author in the durable transcript';
	end if;
	if (select transcript_start_sequence from public.qorpera_execution_runs
		where id = (current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')::uuid) <> 2 then
		raise exception 'runner transcript pin did not include the canonical input event';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select public.qorpera_append_session_input(
	'15000000-0000-4000-8000-000000000055',
	'15000000-0000-4000-8000-000000000058', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"Do not cross the cloud execution lane","images":[]}'
);
do $$
begin
	begin
		perform public.qorpera_claim_session_turn(
			'15000000-0000-4000-8000-000000000055',
			'15000000-0000-4000-8000-000000000059', 120,
			'15000000-0000-4000-8000-000000000040', 1
		);
		raise exception 'legacy executor entered a cloud-bound session';
	exception when sqlstate 'PGRST' then null;
	end;
end
$$;
reset role;
do $$
begin
	if (select turn_id from public.qorpera_session_inputs
		where client_input_id = '15000000-0000-4000-8000-000000000058') is not null then
		raise exception 'legacy claim partially marked an input before the lane fence';
	end if;
end
$$;
delete from public.qorpera_session_inputs
where client_input_id = '15000000-0000-4000-8000-000000000058';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);

insert into public.qorpera_object_reachability_graphs (
	id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count,
	storage_bytes, status, created_by_user_id, completed_at, closure_verified
) values (
	'15000000-0000-4000-8000-000000000042',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'company_snapshot', '15000000-0000-4000-8000-000000000040',
	'15000000-0000-4000-8000-000000000043', repeat('a', 64), 1,
	repeat('b', 64), 1, 2, 'complete',
	'15000000-0000-4000-8000-000000000001', statement_timestamp(), true
);

insert into public.qorpera_runners (
	id, profile_id, client_runner_id, display_name, runner_kind, capabilities,
	max_concurrency, status, platform, runner_version,
	activation_token_sha256, activation_expires_at,
	session_token_sha256, session_expires_at,
	registered_by_user_id, activated_at, last_seen_at
) values (
	'15000000-0000-4000-8000-000000000090',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000091', 'Physical runner',
	'qorpera_computer', '["agent_turn"]', 1, 'active', 'linux-x64', '0.1.0',
	repeat('c', 64), statement_timestamp() + interval '1 hour',
	repeat('d', 64), statement_timestamp() + interval '15 minutes',
	'15000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()
);

set role service_role;
select public.qorpera_register_runner_orchestrator(
	'15000000-0000-4000-8000-000000000100', 'Fixture orchestrator', 'local', repeat('1', 64), 86400
);

do $$
begin
	if not public.qorpera_runner_orchestrator_control_valid(
		'15000000-0000-4000-8000-000000000100', repeat('1', 64)
	) or public.qorpera_runner_orchestrator_control_valid(
		'15000000-0000-4000-8000-000000000100', repeat('2', 64)
	) then
		raise exception 'orchestrator bearer hash was not enforced';
	end if;
end
$$;

select set_config(
	'qorpera_test.orchestrator_claim',
	public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000101', 120
	)::text,
	false
);

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.orchestrator_claim')::jsonb;
begin
	if v_claim -> 'work' ->> 'run_id' is distinct from
		(current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')
		or v_claim -> 'work' ->> 'company_snapshot_id' is distinct from '15000000-0000-4000-8000-000000000040'
		or v_claim -> 'work' ->> 'session_id' is distinct from '15000000-0000-4000-8000-000000000055'
		or v_claim -> 'work' ->> 'staff_agent_id' is distinct from '15000000-0000-4000-8000-000000000054'
		or v_claim -> 'work' -> 'input_ids' is distinct from jsonb_build_array(
			current_setting('qorpera_test.session_input')::jsonb ->> 'input_id'
		)
		or v_claim -> 'work' ->> 'publication_mode' is distinct from 'automatic'
		or v_claim -> 'work' ->> 'logical_computer_id' is distinct from '15000000-0000-4000-8000-000000000080'
		or (v_claim -> 'work' ->> 'transcript_start_sequence')::bigint <> 2
		or v_claim -> 'work' -> 'sponsor' ->> 'native_harness' is distinct from 'openai-responses'
		or v_claim -> 'work' -> 'model_policy' -> 'allowed_models' -> 0 ->> 'model' is distinct from 'gpt-test'
		or (v_claim -> 'work' -> 'model_policy' ->> 'max_cost_microusd')::bigint <> 100000 then
		raise exception 'orchestrator did not receive immutable work and sponsor pins: %', v_claim;
	end if;
end
$$;

select set_config(
	'qorpera_test.runner_assignment',
	public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000101',
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000102', repeat('e', 64), 120
	)::text,
	false
);

do $$
begin
	if (select logical_computer_id from public.qorpera_runners
		where id = '15000000-0000-4000-8000-000000000090')
		is distinct from '15000000-0000-4000-8000-000000000080'::uuid then
		raise exception 'trusted assignment did not bind the physical runner to its logical computer';
	end if;
end
$$;

do $$
begin
	begin
		perform public.qorpera_accept_runner_assignment(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			'15000000-0000-4000-8000-000000000102',
			(current_setting('qorpera_test.orchestrator_claim')::jsonb -> 'work' ->> 'job_id')::uuid,
			repeat('f', 64)
		);
		raise exception 'runner accepted a mismatched assignment capability';
	exception when insufficient_privilege then null;
	end;
end
$$;

select set_config(
	'qorpera_test.accepted_job',
	public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		'15000000-0000-4000-8000-000000000102',
		(current_setting('qorpera_test.orchestrator_claim')::jsonb -> 'work' ->> 'job_id')::uuid,
		repeat('e', 64)
	)::text,
	false
);

do $$
declare
	v_replay jsonb;
	v_job_id uuid := (current_setting('qorpera_test.accepted_job')::jsonb ->> 'job_id')::uuid;
	v_retry_claim jsonb;
	v_retry_assignment jsonb;
	v_receipt jsonb;
	v_second_claim jsonb;
	v_second_assignment jsonb;
	v_second_job_id uuid;
	v_provider_session jsonb;
	v_transcript_event jsonb;
	v_description jsonb;
	v_context jsonb;
	v_inputs jsonb;
	v_schedule_heads jsonb;
	v_occurrence jsonb;
	v_wake_runs jsonb;
	v_wake_claim jsonb;
	v_wake_assignment jsonb;
	v_wake_job_id uuid;
	v_wake_run_id uuid;
	v_candidate jsonb;
	v_graph jsonb;
	v_proof jsonb;
	v_model_reservation jsonb;
	v_run_id uuid := (current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')::uuid;
begin
	v_replay := public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		'15000000-0000-4000-8000-000000000102', v_job_id, repeat('e', 64)
	);
	if v_replay ->> 'status' is distinct from 'leased'
		or (select status from public.qorpera_runner_assignments
			where id = '15000000-0000-4000-8000-000000000102') <> 'accepted' then
		raise exception 'runner assignment acceptance is not idempotent';
	end if;
	perform public.qorpera_runner_broker_authorize_company_file_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64), repeat('9', 64), 128, 'application/octet-stream'
	);
	if (select purposes from public.qorpera_runner_job_output_objects
		where job_id = v_job_id and object_sha256 = repeat('9', 64))
		is distinct from array['company_file']::text[] then
		raise exception 'Company File object was charged to the ordinary artifact lane';
	end if;
	perform public.qorpera_runner_broker_authorize_output_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('e', 64), repeat('9', 64), 128, 'application/octet-stream'
	);
	if (select purposes from public.qorpera_runner_job_output_objects
		where job_id = v_job_id and object_sha256 = repeat('9', 64))
		is distinct from array['artifact', 'company_file']::text[] then
		raise exception 'content reuse did not preserve both runner output purposes';
	end if;
	delete from public.qorpera_runner_job_output_objects
	where job_id = v_job_id and object_sha256 = repeat('9', 64);
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() - interval '1 second'
	where id = v_job_id;
	perform public.qorpera_reconcile_runner_orchestrator(
		'15000000-0000-4000-8000-000000000100'
	);
	if (select status from public.qorpera_runner_jobs where id = v_job_id) <> 'queued'
		or (select status from public.qorpera_runner_assignments
			where id = '15000000-0000-4000-8000-000000000102') <> 'failed' then
		raise exception 'lost runner lease was not reconciled for infrastructure retry';
	end if;
	v_retry_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000103', 120
	);
	v_retry_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_retry_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000104', repeat('2', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_retry_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('2', 64)
	);
	v_description := public.qorpera_runner_broker_describe(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64)
	);
	if (v_description -> 'run' ->> 'run_id')::uuid is distinct from v_run_id
		or v_description -> 'job' ->> 'assignment_id' is distinct from '15000000-0000-4000-8000-000000000104'
		or v_description -> 'sponsor' ->> 'provider' is distinct from 'openai'
		or v_description -> 'sponsor' ? 'secret_reference' then
		raise exception 'runner broker did not return the safe immutable run authority: %', v_description;
	end if;
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		'input-ack', 'I am checking the requested work.', 'progress'
	);
	insert into storage.objects (bucket_id, name, metadata) values (
		'qorpera-profile-objects',
		'15000000-0000-4000-8000-000000000010/' || repeat('7', 64),
		'{"size":"10"}'
	);
	v_candidate := public.qorpera_runner_prepare_company_revision(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		'15000000-0000-4000-8000-000000000120', repeat('7', 64), 10, 3, 0, 0
	);
	begin
		perform public.qorpera_runner_prepare_company_revision(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
			'15000000-0000-4000-8000-000000000122', repeat('7', 64), 10, 3, 0, 0
		);
		raise exception 'one run prepared more than one Company File candidate';
	exception when unique_violation then null;
	end;
	v_graph := public.qorpera_runner_begin_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		(v_candidate ->> 'snapshot_id')::uuid,
		'15000000-0000-4000-8000-000000000121', repeat('7', 64),
		encode(extensions.digest(convert_to(repeat('7', 64) || ':10', 'utf8'), 'sha256'), 'hex'),
		1, 10
	);
	-- Runner graph authority is the backend-neutral object catalog, not the
	-- implementation-private Supabase Storage table. A self-owned backend can
	-- therefore register the same verified catalog row without mirroring bytes
	-- into storage.objects.
	delete from storage.objects
	where bucket_id = 'qorpera-profile-objects'
		and name = '15000000-0000-4000-8000-000000000010/' || repeat('7', 64);
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
	values ('15000000-0000-4000-8000-000000000010', repeat('7', 64), 10);
	perform public.qorpera_runner_append_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		(v_graph ->> 'graph_id')::uuid,
		jsonb_build_array(jsonb_build_object('sha256', repeat('7', 64), 'bytes', 10))
	);
	insert into storage.objects (bucket_id, name, metadata) values (
		'qorpera-profile-objects',
		'15000000-0000-4000-8000-000000000010/' || repeat('7', 64),
		'{"size":"10"}'
	);
	v_graph := public.qorpera_runner_complete_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		(v_graph ->> 'graph_id')::uuid
	);
	if v_graph ->> 'status' is distinct from 'complete'
		or public.qorpera_runner_authorize_company_revision_verification(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
			(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid
		) ->> 'verified_user_id' is distinct from '15000000-0000-4000-8000-000000000002' then
		raise exception 'runner candidate was not fenced to its exact graph and actor';
	end if;
	perform public.qorpera_verify_company_snapshot_closure(
		(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid,
		'15000000-0000-4000-8000-000000000002',
		encode(extensions.digest(convert_to(repeat('7', 64) || ':10', 'utf8'), 'sha256'), 'hex'),
		1, 10, repeat('7', 64), 0, repeat('8', 64)
	);
	v_proof := public.qorpera_runner_finalize_company_revision_verification(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), '15000000-0000-4000-8000-000000000104',
		(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid
	);
	if v_proof ->> 'graph_id' is distinct from v_graph ->> 'graph_id'
		or v_proof ->> 'restored_content_sha256' is distinct from repeat('7', 64)
		or (v_proof ->> 'restored_bytes')::bigint <> 0 then
		raise exception 'trusted runner candidate verification did not create a current durable proof';
	end if;
	perform set_config('qorpera_test.review_snapshot', v_candidate ->> 'snapshot_id', false);
	v_inputs := public.qorpera_runner_broker_list_inputs(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64)
	);
	if jsonb_array_length(v_inputs) <> 1
		or v_inputs -> 0 ->> 'input_id' is distinct from
			(current_setting('qorpera_test.session_input')::jsonb ->> 'input_id')
		or v_inputs -> 0 -> 'body' ->> 'text' is distinct from 'Run from a pinned company revision' then
		raise exception 'runner broker did not return the exact immutable input set: %', v_inputs;
	end if;
	if public.qorpera_runner_broker_authorize_input_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), repeat('6', 64)
	) ->> 'object_sha256' is distinct from repeat('6', 64) then
		raise exception 'runner could not read an image pinned by its immutable input set';
	end if;
	v_context := public.qorpera_runner_broker_list_transcript(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), 0, 100
	);
	if jsonb_array_length(v_context) <> 2
		or v_context -> 0 ->> 'event_id' is distinct from '15000000-0000-4000-8000-000000000056' then
		raise exception 'runner transcript did not stop at the immutable run cursor: %', v_context;
	end if;
	delete from storage.objects
	where bucket_id = 'qorpera-profile-objects'
		and name = '15000000-0000-4000-8000-000000000010/' || repeat('c', 64);
	perform public.qorpera_runner_broker_authorize_output_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), repeat('c', 64), 12, 'application/octet-stream'
	);
	insert into storage.objects (bucket_id, name, metadata) values (
		'qorpera-profile-objects',
		'15000000-0000-4000-8000-000000000010/' || repeat('c', 64),
		'{"size":"12"}'
	);
	perform public.qorpera_runner_broker_confirm_output_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), repeat('c', 64)
	);
	begin
		perform public.qorpera_bind_execution_provider_session(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64), 'native-provider-session-untrusted', repeat('a', 64)
		);
		raise exception 'provider checkpoint accepted a non-output Company File object';
	exception when object_not_in_prerequisite_state then null;
	end;
	v_provider_session := public.qorpera_bind_execution_provider_session(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), ' native-provider-session-150 ', repeat('c', 64)
	);
	v_provider_session := public.qorpera_bind_execution_provider_session(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64), ' native-provider-session-150 ', repeat('c', 64)
	);
	if (v_provider_session ->> 'run_id')::uuid is distinct from v_run_id
		or v_provider_session ->> 'provider_session_id' is distinct from 'native-provider-session-150' then
		raise exception 'provider-native session was not bound to the immutable run';
	end if;
	begin
		perform public.qorpera_bind_execution_provider_session(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64), 'native-provider-session-second', repeat('c', 64)
		);
		raise exception 'one run bound more than one provider-native session';
	exception when unique_violation then null;
	end;
	v_model_reservation := public.qorpera_runner_broker_reserve_model_request(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000118', 'openai', 'gpt-test',
		repeat('0', 64), 100, 100
	);
	if v_model_reservation ->> 'state' is distinct from 'reserved'
		or v_model_reservation -> 'authority' ->> 'run_id' is distinct from v_run_id::text
		or v_model_reservation -> 'authority' ->> 'provider_connection_id' is distinct from
			(current_setting('qorpera_test.provider_connection')::jsonb ->> 'connection_id')
		or v_model_reservation -> 'authority' ->> 'native_harness' is distinct from 'openai-responses'
		or (v_model_reservation -> 'authority' ->> 'max_cost_microusd')::bigint <> 100000
		or v_model_reservation -> 'authority' ? 'secret_reference' then
		raise exception 'model gateway did not receive the safe sponsor and cost authority: %', v_model_reservation;
	end if;
	perform public.qorpera_runner_broker_finalize_model_request(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000118', repeat('0', 64),
		'completed', 8, 2, 125, '{"text":"sponsor pinned"}', null
	);
	begin
		perform public.qorpera_append_runner_transcript_event(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64),
			'15000000-0000-4000-8000-000000000104',
			'15000000-0000-4000-8000-000000000106', 'message',
			jsonb_build_object(
				'schema', 'qorpera.runner-transcript-entry/v1',
				'entry', jsonb_build_object(
					'type', 'message',
					'id', '15000000-0000-4000-8000-000000000106',
					'parentId', 'missing-parent',
					'timestamp', '2026-08-20T12:00:00.000Z',
					'message', jsonb_build_object(
						'role', 'assistant',
						'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'invalid'))
					),
					'execution', jsonb_build_object(
						'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
						'runnerAssignmentId', '15000000-0000-4000-8000-000000000104'
					)
				)
			), 2
		);
		raise exception 'runner transcript accepted a missing parent entry';
	exception when insufficient_privilege then null;
	end;
	v_transcript_event := public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000104',
		'final-output', 'durable runner output', 'final'
	);
	select to_jsonb(event) into v_transcript_event from public.qorpera_session_events as event
	where event.event_id = (v_transcript_event ->> 'messageId')::uuid;
	if v_transcript_event ->> 'execution_kind' is distinct from 'run'
		or (v_transcript_event ->> 'execution_id')::uuid is distinct from v_run_id
		or v_transcript_event ->> 'runner_assignment_id' is distinct from '15000000-0000-4000-8000-000000000104' then
		raise exception 'runner transcript event lost immutable run provenance';
	end if;
	v_receipt := public.qorpera_begin_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000104',
		'15000000-0000-4000-8000-000000000105',
		'external:ticket:42', 'http_request', repeat('3', 64), repeat('4', 64), false
	);
	begin
		perform public.qorpera_begin_run_operation_receipt(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_job_id, repeat('2', 64),
			'15000000-0000-4000-8000-000000000104',
			'15000000-0000-4000-8000-000000000106',
			'external:ticket:43', 'http_request', repeat('5', 64), repeat('6', 64), false
		);
		raise exception 'a second operation bypassed an unresolved receipt';
	exception when object_not_in_prerequisite_state then null;
	end;
	perform public.qorpera_complete_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000104',
		'15000000-0000-4000-8000-000000000105', repeat('3', 64),
		'{"status":200}', null, null
	);
	v_receipt := public.qorpera_begin_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000104',
		'15000000-0000-4000-8000-000000000116',
		'external:ticket:42', 'http_request', repeat('3', 64), repeat('4', 64), false
	);
	if v_receipt ->> 'state' is distinct from 'completed'
		or v_receipt ->> 'receipt_id' is distinct from '15000000-0000-4000-8000-000000000105' then
		raise exception 'completed operation did not replay its durable receipt';
	end if;
	perform public.qorpera_complete_runner_job_v6(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('2', 64),
		'15000000-0000-4000-8000-000000000108',
		'15000000-0000-4000-8000-000000000109', null,
		'{
			"schema":"qorpera.runner-result/v1",
			"backend_result":{"status":"ok"},
			"output_count":0,
			"output_bytes":0,
			"publication":null,
			"usage":{
				"schema":"qorpera.runner-usage/v1",
				"execution_ms":10,
				"input_bytes":1024,
				"output_bytes":0,
				"result_bytes":16,
				"limits":{
					"wall_time_ms":60000,
					"memory_bytes":536870912,
					"cpu_millis":1000,
					"max_pids":64,
					"max_input_bytes":1048576,
					"max_output_bytes":1048576,
					"max_result_bytes":4096
				}
			}
		}'
	);
	if (select status from public.qorpera_runner_assignments
		where id = '15000000-0000-4000-8000-000000000104') <> 'completed'
		or (select event_type from public.qorpera_execution_run_events
			where run_id = v_run_id
			order by id desc limit 1) <> 'completed'
		or (select company_disposition from public.qorpera_execution_run_results
			where run_id = v_run_id) <> 'unchanged'
		or (select status from public.qorpera_execution_sponsor_reservations
			where run_id = v_run_id) <> 'settled'
		or (select actual_microusd from public.qorpera_execution_sponsor_reservations
			where run_id = v_run_id) <> 125
		or (select completed_at from public.qorpera_session_inputs
			where id = (current_setting('qorpera_test.session_input')::jsonb ->> 'input_id')::uuid) is null then
		raise exception 'runner completion did not atomically acknowledge its run and exact input set';
	end if;

	v_second_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000110', 120
	);
	v_second_job_id := (v_second_claim -> 'work' ->> 'job_id')::uuid;
	v_second_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_second_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000111', repeat('5', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_second_assignment ->> 'assignment_id')::uuid, v_second_job_id, repeat('5', 64)
	);
	begin
		perform public.qorpera_bind_execution_provider_session(
			'15000000-0000-4000-8000-000000000090', repeat('d', 64),
			v_second_job_id, repeat('5', 64), 'native-provider-session-150', null
		);
		raise exception 'provider-native session identity crossed Qorpera session ownership';
	exception when unique_violation then null;
	end;
	perform public.qorpera_begin_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_second_job_id, repeat('5', 64),
		'15000000-0000-4000-8000-000000000111',
		'15000000-0000-4000-8000-000000000112',
		'external:filing:42', 'company_operation', repeat('6', 64), repeat('7', 64), false
	);
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() - interval '1 second'
	where id = v_second_job_id;
	perform public.qorpera_reconcile_runner_orchestrator(
		'15000000-0000-4000-8000-000000000100'
	);
	if (select status from public.qorpera_run_operation_receipts
		where id = '15000000-0000-4000-8000-000000000112') <> 'ambiguous'
		or (select status from public.qorpera_runner_jobs where id = v_second_job_id) <> 'failed'
		or (select event_type from public.qorpera_execution_run_events
			where run_id = '15000000-0000-4000-8000-000000000072'
			order by id desc limit 1) <> 'review_pending' then
		raise exception 'ambiguous external effect was retried instead of entering review';
	end if;
	v_schedule_heads := public.qorpera_list_routine_schedule_heads(null, 100);
	if jsonb_array_length(v_schedule_heads -> 'items') <> 1
		or v_schedule_heads ->> 'has_more' is distinct from 'false' then
		raise exception 'orchestrator could not discover the durable routine schedule';
	end if;
	v_occurrence := public.qorpera_enqueue_routine_wake(
		(current_setting('qorpera_test.cloud_routine')::jsonb ->> 'routine_id')::uuid,
		(current_setting('qorpera_test.cloud_routine')::jsonb ->> 'version')::bigint,
		'15000000-0000-4000-8000-000000000117',
		'hourly:2026-08-20T12:00:00.000Z', 'schedule-main',
		statement_timestamp() - interval '1 minute',
		null,
		statement_timestamp() + interval '59 minutes',
		'{"source":"durable-scheduler"}'
	);
	v_schedule_heads := public.qorpera_list_routine_schedule_heads(null, 100);
	if jsonb_array_length(v_schedule_heads -> 'items') <> 0 then
		raise exception 'durable schedule cursor did not advance with wake admission';
	end if;
	v_wake_runs := public.qorpera_materialize_wake_execution_runs(32);
	if jsonb_array_length(v_wake_runs) <> 1
		or v_occurrence ->> 'status' is distinct from 'queued'
		or v_wake_runs -> 0 ->> 'source_kind' is distinct from 'wake'
		or v_wake_runs -> 0 ->> 'publication_mode' is distinct from 'review'
		or v_wake_runs -> 0 ->> 'review_policy_key' is distinct from 'operations.hourly-review' then
		raise exception 'durable wake did not materialize with its pinned execution policy';
	end if;
	v_wake_run_id := (v_wake_runs -> 0 ->> 'run_id')::uuid;
	v_wake_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000113', 120
	);
	v_wake_job_id := (v_wake_claim -> 'work' ->> 'job_id')::uuid;
	if (v_wake_claim -> 'work' ->> 'run_id')::uuid is distinct from v_wake_run_id then
		raise exception 'orchestrator claimed a different run than the durable wake';
	end if;
	v_wake_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_wake_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000114', repeat('8', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_wake_assignment ->> 'assignment_id')::uuid, v_wake_job_id, repeat('8', 64)
	);
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64), v_wake_job_id, repeat('8', 64),
		(v_wake_assignment ->> 'assignment_id')::uuid, 'routine-ack', 'I am checking the scheduled work.', 'progress'
	);
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64), v_wake_job_id, repeat('8', 64),
		(v_wake_assignment ->> 'assignment_id')::uuid, 'routine-final', 'The scheduled check is complete.', 'final'
	);
	perform public.qorpera_complete_runner_job_v6(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_wake_job_id, repeat('8', 64),
		'15000000-0000-4000-8000-000000000115',
		'15000000-0000-4000-8000-000000000116', null,
		'{
			"schema":"qorpera.runner-result/v1",
			"backend_result":{"status":"ok"},
			"output_count":0,
			"output_bytes":0,
			"publication":null,
			"usage":{
				"schema":"qorpera.runner-usage/v1",
				"execution_ms":10,
				"input_bytes":512,
				"output_bytes":0,
				"result_bytes":16,
				"limits":{
					"wall_time_ms":60000,
					"memory_bytes":536870912,
					"cpu_millis":1000,
					"max_pids":64,
					"max_input_bytes":1048576,
					"max_output_bytes":1048576,
					"max_result_bytes":4096
				}
			}
		}'
	);
	if (select status from public.qorpera_wake_occurrences
		where id = '15000000-0000-4000-8000-000000000117') <> 'completed'
		or (select company_disposition from public.qorpera_execution_run_results
			where run_id = v_wake_run_id) <> 'unchanged' then
		raise exception 'runner completion did not durably settle the wake occurrence';
	end if;
end
$$;

reset role;
do $$
begin
	if not exists (
		select 1 from public.qorpera_company_retained_object_hashes(
			'15000000-0000-4000-8000-000000000010'
		) as retained
		where retained.object_sha256 = repeat('6', 64)
	) then
		raise exception 'completed session input image lost its durable transcript retention root';
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config(
	'qorpera_test.recovery_input',
	public.qorpera_append_session_input(
		'15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-000000000118',
		'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"Submit the exact filing once.","images":[]}'
	)::text,
	false
);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select set_config(
	'qorpera_test.recovery_run',
	(public.qorpera_materialize_session_execution_runs(32) -> 0)::text,
	false
);
update public.qorpera_runner_jobs
set status = 'failed', last_error = 'provider outcome confirmed after disconnect',
	finished_at = statement_timestamp()
where id = (current_setting('qorpera_test.recovery_run')::jsonb ->> 'job_id')::uuid;
insert into public.qorpera_run_operation_receipts (
	id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
	input_sha256, downstream_idempotency_sha256, status, result, completed_at,
	recovery_resolution, recovery_resolved_by_user_id, recovery_resolved_at
) values (
	'15000000-0000-4000-8000-000000000119',
	(current_setting('qorpera_test.recovery_run')::jsonb ->> 'run_id')::uuid,
	(current_setting('qorpera_test.recovery_run')::jsonb ->> 'job_id')::uuid,
	'15000000-0000-4000-8000-000000000102',
	'external:filing:recovery', 'company_operation', repeat('9', 64), repeat('a', 64),
	'completed', '{"confirmed_by":"operator"}', statement_timestamp(),
	'confirmed_completed', '15000000-0000-4000-8000-000000000001', statement_timestamp()
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_recovery jsonb;
	v_recoveries jsonb;
begin
	if public.qorpera_list_staff_execution_activity(
		'15000000-0000-4000-8000-000000000020'
	) -> 0 ->> 'activity' is distinct from 'needs_attention' then
		raise exception 'hosted runner failure was absent from authoritative staff activity';
	end if;
	v_recoveries := public.qorpera_list_session_execution_run_recoveries(
		'15000000-0000-4000-8000-000000000055', 20
	);
	if jsonb_array_length(v_recoveries) <> 1
		or v_recoveries -> 0 -> 'inputs' -> 0 ->> 'author_display_name'
			is distinct from 'Orchestrator Owner' then
		raise exception 'failed hosted run was not visible in the durable conversation recovery lane';
	end if;
	begin
		perform public.qorpera_resolve_failed_execution_run(
			(current_setting('qorpera_test.recovery_run')::jsonb ->> 'run_id')::uuid,
			'retry'
		);
		raise exception 'confirmed external effect was released into a new run';
	exception when object_not_in_prerequisite_state then null;
	end;
	v_recovery := public.qorpera_get_execution_run_recovery(
		(current_setting('qorpera_test.recovery_run')::jsonb ->> 'run_id')::uuid
	);
	if jsonb_array_length(v_recovery -> 'inputs') <> 1
		or v_recovery -> 'inputs' -> 0 ->> 'input_id' is distinct from
			current_setting('qorpera_test.recovery_input')::jsonb ->> 'input_id'
		or v_recovery -> 'inputs' -> 0 ->> 'failed_at' is null then
		raise exception 'blocked recovery retry released its exact attended input';
	end if;
	perform public.qorpera_resolve_failed_execution_run(
		(current_setting('qorpera_test.recovery_run')::jsonb ->> 'run_id')::uuid,
		'discard'
	);
	if jsonb_array_length(public.qorpera_list_session_execution_run_recoveries(
		'15000000-0000-4000-8000-000000000055', 20
	)) <> 0 then
		raise exception 'resolved hosted run remained in the conversation recovery lane';
	end if;
	if public.qorpera_list_execution_run_recoveries(
		'15000000-0000-4000-8000-000000000010', 100
	) -> 0 ->> 'source_kind' is distinct from 'manual' then
		raise exception 'failed non-session run was absent from the company recovery lane';
	end if;
	perform public.qorpera_resolve_run_operation_receipt(
		'15000000-0000-4000-8000-000000000112', 'confirmed_not_run', null, null, null
	);
	perform public.qorpera_resolve_failed_execution_run(
		'15000000-0000-4000-8000-000000000072', 'discard'
	);
	if jsonb_array_length(public.qorpera_list_execution_run_recoveries(
		'15000000-0000-4000-8000-000000000010', 100
	)) <> 0 then
		raise exception 'dismissed non-session run remained in the company recovery lane';
	end if;
end
$$;

select set_config(
	'qorpera_test.partial_attempt_input',
	public.qorpera_append_session_input(
		'15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-000000000140',
		'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"Preserve partial runner output for recovery.","images":[]}'
	)::text,
	false
);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
declare
	v_runs jsonb := public.qorpera_materialize_session_execution_runs(32);
	v_run_id uuid;
	v_job_id uuid;
	v_claim jsonb;
	v_assignment jsonb;
	v_candidate jsonb;
	v_graph jsonb;
	v_proof jsonb;
	v_receipt jsonb;
begin
	if jsonb_array_length(v_runs) <> 1 then
		raise exception 'partial-attempt fixture did not materialize exactly one run: %', v_runs;
	end if;
	v_run_id := (v_runs -> 0 ->> 'run_id')::uuid;
	v_job_id := (v_runs -> 0 ->> 'job_id')::uuid;
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000142', 120
	);
	v_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000143', repeat('c', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('c', 64)
	);
	perform public.qorpera_send_runner_agent_message(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64),
		'15000000-0000-4000-8000-000000000143',
		'partial-output', 'partial durable attempt output', 'progress'
	);
	insert into storage.objects (bucket_id, name, metadata) values (
		'qorpera-profile-objects',
		'15000000-0000-4000-8000-000000000010/' || repeat('4', 64),
		'{"size":"10"}'
	);
	perform public.qorpera_runner_broker_authorize_company_file_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), repeat('4', 64), 10, 'application/octet-stream'
	);
	v_candidate := public.qorpera_runner_prepare_company_revision(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		'15000000-0000-4000-8000-000000000151', repeat('4', 64), 10, 3, 0, 0
	);
	v_graph := public.qorpera_runner_begin_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_candidate ->> 'snapshot_id')::uuid,
		'15000000-0000-4000-8000-000000000152', repeat('4', 64),
		encode(extensions.digest(convert_to(repeat('4', 64) || ':10', 'utf8'), 'sha256'), 'hex'),
		1, 10
	);
	perform public.qorpera_runner_append_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_graph ->> 'graph_id')::uuid,
		jsonb_build_array(jsonb_build_object('sha256', repeat('4', 64), 'bytes', 10))
	);
	v_graph := public.qorpera_runner_complete_company_revision_graph(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_graph ->> 'graph_id')::uuid
	);
	perform public.qorpera_runner_authorize_company_revision_verification(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid
	);
	perform public.qorpera_verify_company_snapshot_closure(
		(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid,
		'15000000-0000-4000-8000-000000000001',
		encode(extensions.digest(convert_to(repeat('4', 64) || ':10', 'utf8'), 'sha256'), 'hex'),
		1, 10, repeat('4', 64), 0, repeat('8', 64)
	);
	v_proof := public.qorpera_runner_finalize_company_revision_verification(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_candidate ->> 'snapshot_id')::uuid, (v_graph ->> 'graph_id')::uuid
	);
	v_receipt := public.qorpera_begin_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		'15000000-0000-4000-8000-000000000154',
		'external:company-file-recovery', 'company_operation', repeat('9', 64), repeat('a', 64), true
	);
	perform public.qorpera_complete_run_operation_receipt(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('c', 64), '15000000-0000-4000-8000-000000000143',
		(v_receipt ->> 'receipt_id')::uuid, repeat('9', 64),
		'{"status":"completed"}', (v_candidate ->> 'snapshot_id')::uuid, null
	);
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() - interval '1 second'
	where id = v_job_id;
	perform public.qorpera_reconcile_runner_orchestrator(
		'15000000-0000-4000-8000-000000000100'
	);
	if (select status from public.qorpera_runner_jobs where id = v_job_id) <> 'failed'
		or (select last_error from public.qorpera_runner_jobs where id = v_job_id)
			not like '%durable attempt output%'
		or not exists (
			select 1 from public.qorpera_execution_run_events as event
			where event.run_id = v_run_id and event.event_type = 'review_pending'
				and event.payload ->> 'reason' = 'partial_attempt_output'
		) or not exists (
			select 1
			from public.qorpera_run_operation_receipts as receipt
			join public.qorpera_company_proposals as proposal on proposal.id = receipt.proposal_id
			where receipt.id = (v_receipt ->> 'receipt_id')::uuid
				and receipt.status = 'completed' and receipt.output_snapshot_id is null
				and proposal.proposal_snapshot_id = (v_candidate ->> 'snapshot_id')::uuid
				and proposal.status = 'open' and proposal.reason = 'recovery'
		) or (select failed_at from public.qorpera_session_inputs
			where id = (current_setting('qorpera_test.partial_attempt_input')::jsonb ->> 'input_id')::uuid) is null then
		raise exception 'lease loss after durable attempt output was retried or lost';
	end if;
	perform set_config('qorpera_test.partial_attempt_run', v_run_id::text, false);
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_recovery jsonb := public.qorpera_get_execution_run_recovery(
		current_setting('qorpera_test.partial_attempt_run')::uuid
	);
begin
	if v_recovery ->> 'proposal_id' is null
		or v_recovery -> 'operations' -> 0 ->> 'proposal_id' is distinct from v_recovery ->> 'proposal_id'
		or v_recovery -> 'operations' -> 0 ->> 'output_snapshot_id' is not null
		or v_recovery -> 'operations' -> 0 ->> 'requires_company_revision' is distinct from 'true' then
		raise exception 'completed operation candidate was absent from durable recovery: %', v_recovery;
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
reset role;
do $$
declare
	v_sponsor_id uuid := (current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid;
	v_claim jsonb;
begin
	insert into public.qorpera_runner_jobs (
		id, profile_id, environment_id, substrate_version_id, client_job_id,
		required_capability, job_type, payload, created_by_user_id, created_at
	) values
	(
		'15000000-0000-4000-8000-000000000145',
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000020',
		'15000000-0000-4000-8000-000000000050',
		'15000000-0000-4000-8000-000000000145',
		'agent_turn', 'agent_turn', '{"fixture":"unavailable-computer"}',
		'15000000-0000-4000-8000-000000000001', statement_timestamp() - interval '2 seconds'
	),
	(
		'15000000-0000-4000-8000-000000000147',
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000020',
		'15000000-0000-4000-8000-000000000050',
		'15000000-0000-4000-8000-000000000147',
		'agent_turn', 'agent_turn', '{"fixture":"eligible-unpinned"}',
		'15000000-0000-4000-8000-000000000001', statement_timestamp() - interval '1 second'
	);
	insert into public.qorpera_execution_runs (
		id, profile_id, environment_id, source_kind, source_id, job_id,
		substrate_version_id, company_snapshot_id, staff_agent_id, staff_version,
		sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, logical_computer_id, transcript_start_sequence,
		created_by_user_id
	) values
	(
		'15000000-0000-4000-8000-000000000146',
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000020',
		'system', '15000000-0000-4000-8000-000000000146',
		'15000000-0000-4000-8000-000000000145',
		'15000000-0000-4000-8000-000000000050',
		'15000000-0000-4000-8000-000000000040',
		'15000000-0000-4000-8000-000000000054', 1,
		v_sponsor_id, 1, 'agent_turn', 'agent_turn', repeat('1', 64),
		'15000000-0000-4000-8000-000000000080', 0,
		'15000000-0000-4000-8000-000000000001'
	),
	(
		'15000000-0000-4000-8000-000000000148',
		'15000000-0000-4000-8000-000000000010',
		'15000000-0000-4000-8000-000000000020',
		'system', '15000000-0000-4000-8000-000000000148',
		'15000000-0000-4000-8000-000000000147',
		'15000000-0000-4000-8000-000000000050',
		'15000000-0000-4000-8000-000000000040',
		'15000000-0000-4000-8000-000000000054', 1,
		v_sponsor_id, 1, 'agent_turn', 'agent_turn', repeat('2', 64),
		null, 0, '15000000-0000-4000-8000-000000000001'
	);
	update public.qorpera_runner_jobs as job
	set run_id = case job.id
		when '15000000-0000-4000-8000-000000000145'::uuid
			then '15000000-0000-4000-8000-000000000146'::uuid
		else '15000000-0000-4000-8000-000000000148'::uuid
	end
	where job.id in (
		'15000000-0000-4000-8000-000000000145',
		'15000000-0000-4000-8000-000000000147'
	);
	if not public.qorpera_reserve_execution_sponsor_authority(
		'15000000-0000-4000-8000-000000000146'
	) or not public.qorpera_reserve_execution_sponsor_authority(
		'15000000-0000-4000-8000-000000000148'
	) then
		raise exception 'head-of-line fixture could not reserve sponsor authority';
	end if;
	update public.qorpera_logical_computers
	set status = 'disabled' where id = '15000000-0000-4000-8000-000000000080';
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000149', 120
	);
	if v_claim -> 'work' ->> 'run_id' is distinct from '15000000-0000-4000-8000-000000000148'
		or (select status from public.qorpera_runner_jobs
			where id = '15000000-0000-4000-8000-000000000145') <> 'failed' then
		raise exception 'an unavailable pinned computer head-of-line blocked eligible work: %', v_claim;
	end if;
	perform public.qorpera_release_runner_job_claim(
		'15000000-0000-4000-8000-000000000100',
		(v_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000150',
		'Head-of-line fixture cleanup'
	);
	update public.qorpera_runner_jobs
	set status = 'cancelled', cancelled_at = statement_timestamp(),
		cancelled_by_user_id = '15000000-0000-4000-8000-000000000001'
	where id = '15000000-0000-4000-8000-000000000147';
	update public.qorpera_logical_computers
	set status = 'active' where id = '15000000-0000-4000-8000-000000000080';
end
$$;

insert into public.qorpera_company_proposals (
	id, profile_id, environment_id, client_proposal_id, base_snapshot_id,
	proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
	session_id, trail_end_sequence, reason, policy_key, title,
	reviewer_staff_ids, created_by_user_id
) values (
	'15000000-0000-4000-8000-000000000130',
	'15000000-0000-4000-8000-000000000010',
	'15000000-0000-4000-8000-000000000020',
	'15000000-0000-4000-8000-000000000131',
	'15000000-0000-4000-8000-000000000040',
	current_setting('qorpera_test.review_snapshot')::uuid,
	'run',
	(current_setting('qorpera_test.materialized_runs')::jsonb -> 0 ->> 'run_id')::uuid,
	'15000000-0000-4000-8000-000000000104',
	'15000000-0000-4000-8000-000000000055', 1,
	'policy', 'operations.named-agent-review', 'Review the durable Company File result',
	array['15000000-0000-4000-8000-000000000054'::uuid],
	'15000000-0000-4000-8000-000000000001'
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
begin
	begin
		perform public.qorpera_accept_company_proposal(
			'15000000-0000-4000-8000-000000000130',
			current_setting('qorpera_test.review_snapshot')::uuid
		);
		raise exception 'configured agent review was bypassed before approval';
	exception when object_not_in_prerequisite_state then null;
	end;
end
$$;

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
declare
	v_runs jsonb := public.qorpera_materialize_company_proposal_review_runs(32);
	v_claim jsonb;
	v_assignment jsonb;
	v_job_id uuid;
	v_description jsonb;
begin
	if jsonb_array_length(v_runs) <> 1
		or v_runs -> 0 ->> 'source_kind' is distinct from 'proposal_review'
		or v_runs -> 0 ->> 'staff_agent_id' is distinct from '15000000-0000-4000-8000-000000000054'
		or (select payload -> 'proposal_snapshot' ->> 'snapshot_id'
			from public.qorpera_runner_jobs where id = (v_runs -> 0 ->> 'job_id')::uuid)
			is distinct from current_setting('qorpera_test.review_snapshot') then
		raise exception 'named reviewer was not materialized against the immutable proposal: %', v_runs;
	end if;
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'15000000-0000-4000-8000-000000000100',
		'15000000-0000-4000-8000-000000000132', 120
	);
	v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
	v_assignment := public.qorpera_assign_runner_job(
		'15000000-0000-4000-8000-000000000100',
		(v_claim ->> 'claim_id')::uuid,
		'15000000-0000-4000-8000-000000000090',
		'15000000-0000-4000-8000-000000000133', repeat('b', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		(v_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('b', 64)
	);
	v_description := public.qorpera_runner_broker_describe(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('b', 64)
	);
	if v_description -> 'proposal_snapshot' ->> 'snapshot_id'
		is distinct from current_setting('qorpera_test.review_snapshot')
		or v_description -> 'snapshot' ->> 'snapshot_id'
			is not distinct from current_setting('qorpera_test.review_snapshot') then
		raise exception 'reviewer broker did not expose the proposed tree separately from the current Company File';
	end if;
	if public.qorpera_runner_broker_authorize_input_object(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('b', 64), repeat('7', 64)
	) ->> 'object_sha256' is distinct from repeat('7', 64) then
		raise exception 'reviewer could not read the immutable proposal closure';
	end if;
	perform public.qorpera_complete_runner_job_v6(
		'15000000-0000-4000-8000-000000000090', repeat('d', 64),
		v_job_id, repeat('b', 64),
		'15000000-0000-4000-8000-000000000133',
		'15000000-0000-4000-8000-000000000134', null,
		'{
			"schema":"qorpera.runner-result/v1",
			"backend_result":{"status":"ok"},
			"review":{"decision":"approve","comment":"The proposed Company File revision is consistent with the operating policy."},
			"output_count":0,
			"output_bytes":0,
			"publication":null,
			"usage":{
				"schema":"qorpera.runner-usage/v1",
				"execution_ms":10,
				"input_bytes":512,
				"output_bytes":0,
				"result_bytes":128,
				"limits":{
					"wall_time_ms":60000,
					"memory_bytes":536870912,
					"cpu_millis":1000,
					"max_pids":64,
					"max_input_bytes":1048576,
					"max_output_bytes":1048576,
					"max_result_bytes":4096
				}
			}
		}'
	);
	if (select review.status
		from public.qorpera_company_proposal_review_assignments as review
		where review.proposal_id = '15000000-0000-4000-8000-000000000130')
			is distinct from 'approved'
		or (select staff.display_name
			from public.qorpera_company_proposal_review_assignments as review
			join public.qorpera_profile_staff as staff
				on staff.profile_id = review.profile_id
				and staff.staff_agent_id = review.reviewer_staff_agent_id
			where review.proposal_id = '15000000-0000-4000-8000-000000000130')
			is distinct from 'Cloud operator'
		or (select author_staff_agent_id from public.qorpera_company_proposal_comments
			where proposal_id = '15000000-0000-4000-8000-000000000130')
			is distinct from '15000000-0000-4000-8000-000000000054'::uuid then
		raise exception 'review decision was not bound to the named staff reviewer';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_proposal jsonb := public.qorpera_accept_company_proposal(
		'15000000-0000-4000-8000-000000000130',
		current_setting('qorpera_test.review_snapshot')::uuid
	);
	v_file jsonb := public.qorpera_get_company_file(
		'15000000-0000-4000-8000-000000000020'
	);
begin
	if v_proposal ->> 'status' is distinct from 'accepted'
		or v_file ->> 'head_snapshot_id'
			is distinct from current_setting('qorpera_test.review_snapshot') then
		raise exception 'approved named-agent review did not publish its exact proposal';
	end if;
end
$$;

reset role;
do $$
begin
	if not exists (
			select 1
			from public.qorpera_company_substrate_versions as substrate
			join public.qorpera_profile_operation_clocks as clock
				on clock.profile_id = substrate.profile_id
			where substrate.profile_id = '15000000-0000-4000-8000-000000000010'
				and substrate.environment_id = '15000000-0000-4000-8000-000000000020'
				and substrate.company_snapshot_id = current_setting('qorpera_test.review_snapshot')::uuid
				and substrate.operation_sequence = clock.last_sequence
		) then
		raise exception 'approved named-agent review did not capture its exact head substrate';
	end if;
end
$$;

do $$
begin
	update public.qorpera_execution_provider_sessions
	set created_at = statement_timestamp() - interval '31 days'
	where provider_session_id = 'native-provider-session-150';
	if not exists (
		select 1 from public.qorpera_company_additional_retained_object_hashes(
			'15000000-0000-4000-8000-000000000010'
		) as retained
		where retained.object_sha256 = repeat('c', 64)
	) then
		raise exception 'latest checkpoint of an open session lost its recovery retention root';
	end if;
	update public.qorpera_shared_sessions set status = 'closed'
	where id = '15000000-0000-4000-8000-000000000055';
	if exists (
		select 1 from public.qorpera_company_additional_retained_object_hashes(
			'15000000-0000-4000-8000-000000000010'
		) as retained
		where retained.object_sha256 = repeat('c', 64)
	) then
		raise exception 'closed historical session checkpoint was retained forever';
	end if;
end
$$;

rollback;
