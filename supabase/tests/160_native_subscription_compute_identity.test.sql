begin;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)', 'EXECUTE') then
		raise exception 'API clients can bypass member-authorized cancellation';
	end if;
end
$$;

insert into auth.users (id, email)
values
	('16000000-0000-4000-8000-000000000001', 'native-owner@example.test'),
	('16000000-0000-4000-8000-000000000002', 'native-member@example.test');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values (
	'16000000-0000-4000-8000-000000000010', 'Native subscription company',
	'16000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values
	(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001',
		'native-owner@example.test', 'Native Owner', 'owner'
	),
	(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000002',
		'native-member@example.test', 'Native Member', 'contributor'
	);

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
) values (
	'16000000-0000-4000-8000-000000000020',
	'16000000-0000-4000-8000-000000000010',
	'Native environment', 1, '16000000-0000-4000-8000-000000000001'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_company_workspaces (
	id, profile_id, environment_id, client_workspace_id, name, created_by_user_id
) values (
	'16000000-0000-4000-8000-000000000021',
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020',
	'16000000-0000-4000-8000-000000000022',
	'Native subscription fixture', '16000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id
) values (
	'16000000-0000-4000-8000-000000000023',
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020',
	'16000000-0000-4000-8000-000000000021',
	'16000000-0000-4000-8000-000000000024', repeat('c', 64), 2, 3, 0, 0,
	'16000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_substrate_versions (
	id, profile_id, environment_id, company_snapshot_id, client_version_id,
	contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id
) values (
	'16000000-0000-4000-8000-000000000025',
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020',
	'16000000-0000-4000-8000-000000000023',
	'16000000-0000-4000-8000-000000000026', 1, 0, 0, repeat('d', 64),
	'16000000-0000-4000-8000-000000000001'
);

update public.qorpera_company_files
set canonical_workspace_id = '16000000-0000-4000-8000-000000000021',
	head_snapshot_id = '16000000-0000-4000-8000-000000000023',
	state = 'ready', logical_bytes = 0, updated_at = statement_timestamp()
where environment_id = '16000000-0000-4000-8000-000000000020';

insert into public.qorpera_profile_staff (
	profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state,
	model_provider, model_id, created_at, updated_at, updated_by_user_id
) values (
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000030',
	'Native agent', 'Research', 'Use the provider-native harness.',
	'blue', 'round', 'active', 'active', 'openai', 'gpt-native',
	statement_timestamp(), statement_timestamp(),
	'16000000-0000-4000-8000-000000000001'
), (
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000031',
	'Company native agent', 'Research', 'Use the company provider-native harness.',
	'green', 'square', 'active', 'active', 'openai', 'gpt-native',
	statement_timestamp(), statement_timestamp(),
	'16000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_shared_sessions (
	id, client_session_id, profile_id, environment_id, title, status,
	created_by_user_id, staff_agent_id, staff_version, execution_scope, created_at
) values (
	'16000000-0000-4000-8000-000000000040',
	'16000000-0000-4000-8000-000000000041',
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020',
	'Native subscription session', 'open',
	'16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000030', 1, '{}',
	'2026-08-21T12:00:00.000Z'
), (
	'16000000-0000-4000-8000-000000000042',
	'16000000-0000-4000-8000-000000000043',
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020',
	'Company-native subscription session', 'open',
	'16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000031', 1, '{}',
	'2026-08-21T12:00:00.000Z'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.native_identity',
	public.qorpera_upsert_member_compute_identity(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000050',
		'Native Owner compute identity', 'qorpera-member-linux', 'v1',
		'["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}'
	)::text,
	false
);

do $$
begin
	if current_setting('qorpera_test.native_identity')::jsonb ->> 'ownership_kind' <> 'member'
		or current_setting('qorpera_test.native_identity')::jsonb ->> 'owner_user_id'
			<> '16000000-0000-4000-8000-000000000001'
		or current_setting('qorpera_test.native_identity')::jsonb -> 'owner_scope_key' <> 'null'::jsonb then
		raise exception 'personal compute identity did not preserve member ownership';
	end if;
end
$$;

select set_config(
	'qorpera_test.company_identity',
	public.qorpera_upsert_scoped_compute_identity(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000053',
		'company', null, 'Company compute identity', 'qorpera-company-linux', 'v1',
		'["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}'
	)::text,
	false
);

select public.qorpera_upsert_scoped_compute_identity(
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000054',
	'department', 'engineering', 'Engineering compute identity', 'qorpera-company-linux', 'v1',
	'["agent_turn","company_substrate"]', '{}'
);

select public.qorpera_upsert_scoped_compute_identity(
	'16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000055',
	'security_boundary', 'finance-prod', 'Finance boundary identity', 'qorpera-company-linux', 'v1',
	'["agent_turn","company_substrate"]', '{}'
);

do $$
declare
	v_identities jsonb := public.qorpera_list_compute_identities(
		'16000000-0000-4000-8000-000000000010'
	);
begin
	if jsonb_array_length(v_identities) <> 4
		or not exists (
			select 1 from jsonb_array_elements(v_identities) as item
			where item ->> 'ownership_kind' = 'company'
				and item -> 'owner_user_id' = 'null'::jsonb
				and item -> 'owner_scope_key' = 'null'::jsonb
		)
		or not exists (
			select 1 from jsonb_array_elements(v_identities) as item
			where item ->> 'ownership_kind' = 'department'
				and item ->> 'owner_scope_key' = 'engineering'
		)
		or not exists (
			select 1 from jsonb_array_elements(v_identities) as item
			where item ->> 'ownership_kind' = 'security_boundary'
				and item ->> 'owner_scope_key' = 'finance-prod'
		) then
		raise exception 'scoped compute ownership model is incomplete';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);

do $$
begin
	if (
		select count(*)
		from public.qorpera_provider_execution_policies as policy
		where policy.authentication_mode = 'native_subscription'
			and policy.implementation_status = 'supported'
			and policy.enablement_status = 'enabled'
			and (policy.provider, policy.native_harness) in (
				('openai', 'codex-cli'), ('anthropic', 'claude-code')
			)
	) <> 2 then
		raise exception 'supported personal native-subscription providers were not enabled by default';
	end if;
end
$$;

set role service_role;

select public.qorpera_set_provider_execution_policy(
	'openai', 'native_subscription', 'codex-cli',
	'supported', 'enabled', 1, null, 'native-subscription-launch-test'
);
select public.qorpera_set_provider_execution_policy(
	'anthropic', 'native_subscription', 'claude-code',
	'supported', 'enabled', 1, null, 'native-subscription-launch-test'
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.native_login',
	public.qorpera_begin_native_provider_login(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000051',
		'16000000-0000-4000-8000-000000000052',
		(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli', repeat('a', 64), 900
	)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select set_config(
	'qorpera_test.native_connection',
	public.qorpera_complete_native_provider_login(
		(current_setting('qorpera_test.native_login')::jsonb ->> 'login_id')::uuid,
		repeat('a', 64),
		'16000000-0000-4000-8000-000000000060',
		'object://native-capsules/16000000-0000-4000-8000-000000000060',
		repeat('b', 64), 'opaque-openai-account', 'personal-subscription',
		'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}'
	)::text,
	false
);

reset role;

do $$
declare
	v_connection_id uuid := (current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid;
begin
	if exists (
		select 1
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_connection_id
			and (
				version.authentication_mode <> 'native_subscription'
				or version.native_harness <> 'codex-cli'
				or version.secret_reference is not null
				or version.credential_capsule_id <> '16000000-0000-4000-8000-000000000060'
				or version.max_native_concurrency <> 1
			)
	) or not exists (
		select 1
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_connection_id and version.version = 1
	) then
		raise exception 'native provider version did not preserve the plaintext-free capsule boundary';
	end if;
	if not exists (
		select 1 from public.qorpera_native_credential_capsules as capsule
		where capsule.id = '16000000-0000-4000-8000-000000000060'
			and capsule.ownership_kind = 'member'
			and capsule.owner_user_id = '16000000-0000-4000-8000-000000000001'
			and capsule.owner_scope_key is null
	) or exists (
		select 1 from public.qorpera_provider_connections as connection
		where connection.id = v_connection_id
			and connection.owner_user_id is distinct from '16000000-0000-4000-8000-000000000001'
	) then
		raise exception 'personal provider capsule did not remain member-owned';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_native_provider_login_sessions'
			and column_name ~ '(token|secret|credential)'
	) then
		raise exception 'native login control-plane table exposes a credential-bearing column';
	end if;
	if not public.qorpera_provider_execution_enabled('anthropic', 'native_subscription', 'claude-code') then
		raise exception 'supported Anthropic native subscription policy was not enabled';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.anthropic_login',
	public.qorpera_begin_native_provider_login(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-0000000000a1',
		'16000000-0000-4000-8000-0000000000a2',
		(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
		'anthropic', 'claude-code', repeat('7', 64), 900
	)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select set_config(
	'qorpera_test.anthropic_connection',
	public.qorpera_complete_native_provider_login(
		(current_setting('qorpera_test.anthropic_login')::jsonb ->> 'login_id')::uuid,
		repeat('7', 64),
		'16000000-0000-4000-8000-0000000000a3',
		'object://native-capsules/16000000-0000-4000-8000-0000000000a3',
		repeat('8', 64), 'opaque-anthropic-account', 'personal-subscription',
		'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}'
	)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.anthropic_sponsor',
	public.qorpera_create_member_execution_sponsor(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-0000000000a4',
		(current_setting('qorpera_test.anthropic_connection')::jsonb ->> 'connection_id')::uuid,
		1, false
	)::text,
	false
);

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.company_login',
	public.qorpera_begin_native_provider_login(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000081',
		'16000000-0000-4000-8000-000000000082',
		(current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli', repeat('e', 64), 900
	)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select set_config(
	'qorpera_test.company_connection',
	public.qorpera_complete_native_provider_login(
		(current_setting('qorpera_test.company_login')::jsonb ->> 'login_id')::uuid,
		repeat('e', 64),
		'16000000-0000-4000-8000-000000000083',
		'object://native-capsules/16000000-0000-4000-8000-000000000083',
		repeat('f', 64), 'opaque-company-openai-account', 'company-subscription',
		'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":2000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}'
	)::text,
	false
);

reset role;

do $$
declare
	v_connection_id uuid := (current_setting('qorpera_test.company_connection')::jsonb ->> 'connection_id')::uuid;
begin
	if not exists (
		select 1 from public.qorpera_native_credential_capsules as capsule
		where capsule.id = '16000000-0000-4000-8000-000000000083'
			and capsule.ownership_kind = 'company'
			and capsule.owner_user_id is null and capsule.owner_scope_key is null
	) or not exists (
		select 1 from public.qorpera_provider_connections as connection
		where connection.id = v_connection_id and connection.owner_user_id is null
	) then
		raise exception 'company compute identity did not produce company-owned native credentials';
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.company_sponsor',
	public.qorpera_create_execution_sponsor_binding(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000084',
		'company_service_account',
		(current_setting('qorpera_test.company_connection')::jsonb ->> 'connection_id')::uuid,
		1, true
	)::text,
	false
);

select set_config(
	'qorpera_test.native_sponsor',
	public.qorpera_create_member_execution_sponsor(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000061',
		(current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid,
		1, false
	)::text,
	false
);

do $$
declare
	v_replay jsonb;
begin
	v_replay := public.qorpera_create_member_execution_sponsor(
		'16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000061',
		(current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid,
		1, false
	);
	if v_replay <> current_setting('qorpera_test.native_sponsor')::jsonb then
		raise exception 'member sponsor creation was not exact-replay idempotent';
	end if;
end
$$;

select set_config(
	'qorpera_test.own_turn',
	public.qorpera_request_session_turn_v2(
		'16000000-0000-4000-8000-000000000040',
		'16000000-0000-4000-8000-000000000070',
		'16000000-0000-4000-8000-000000000071',
		'{"schema":"qorpera.session-prompt/v1","text":"Run with my native subscription.","images":[]}',
		'member_connection',
		(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
		1, null,
		(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
	)::text,
	false
);

do $$
declare
	v_replay jsonb;
	v_rejected boolean := false;
begin
	if has_function_privilege(
		'authenticated',
		'public.qorpera_request_session_turn(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'EXECUTE'
	) then
		raise exception 'authenticated role can bypass exact sponsor-request replay fencing';
	end if;
	if not has_function_privilege(
		'authenticated',
		'public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'EXECUTE'
	) then
		raise exception 'authenticated role cannot call the fenced sponsor-request RPC';
	end if;
	v_replay := public.qorpera_request_session_turn_v2(
		'16000000-0000-4000-8000-000000000040',
		'16000000-0000-4000-8000-000000000070',
		'16000000-0000-4000-8000-000000000071',
		'{"schema":"qorpera.session-prompt/v1","text":"Run with my native subscription.","images":[]}',
		'member_connection',
		(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
		1, null,
		(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
	);
	if v_replay <> current_setting('qorpera_test.own_turn')::jsonb then
		raise exception 'session turn exact replay returned another request';
	end if;
	begin
		perform public.qorpera_request_session_turn_v2(
			'16000000-0000-4000-8000-000000000040',
			'16000000-0000-4000-8000-000000000070',
			'16000000-0000-4000-8000-000000000071',
			'{"schema":"qorpera.session-prompt/v1","text":"Different request under the same id.","images":[]}',
			'member_connection',
			(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
			1, null,
			(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
			null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
		);
	exception when unique_violation then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'session turn replay silently accepted divergent sponsor input';
	end if;
end
$$;

select set_config(
	'qorpera_test.company_turn',
	public.qorpera_request_session_turn_v2(
		'16000000-0000-4000-8000-000000000042',
		'16000000-0000-4000-8000-000000000085',
		'16000000-0000-4000-8000-000000000086',
		'{"schema":"qorpera.session-prompt/v1","text":"Run with the company native credential.","images":[]}',
		'company_connection',
		(current_setting('qorpera_test.company_sponsor')::jsonb ->> 'binding_id')::uuid,
		1, null,
		(current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
	)::text,
	false
);

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","email":"native-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);

do $$
declare
	v_rejected boolean := false;
begin
	begin
		perform public.qorpera_upsert_scoped_compute_identity(
			'16000000-0000-4000-8000-000000000010',
			'16000000-0000-4000-8000-000000000056',
			'company', null, 'Unauthorized company identity', 'qorpera-company-linux', 'v1',
			'["agent_turn"]', '{}'
		);
	exception when invalid_parameter_value then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'profile contributor created a scoped compute identity';
	end if;
end
$$;

select set_config(
	'qorpera_test.sponsored_turn',
	public.qorpera_request_session_turn_v2(
		'16000000-0000-4000-8000-000000000040',
		'16000000-0000-4000-8000-000000000072',
		'16000000-0000-4000-8000-000000000073',
		'{"schema":"qorpera.session-prompt/v1","text":"Ask the owner to sponsor this turn.","images":[]}',
		'sponsorship_request', null, null,
		'16000000-0000-4000-8000-000000000001', null, null,
		'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
	)::text,
	false
);

select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

select public.qorpera_approve_session_turn_sponsorship(
	(current_setting('qorpera_test.sponsored_turn')::jsonb ->> 'turn_request_id')::uuid,
	(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
	1,
	(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null, 'managed_sandbox'
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select public.qorpera_materialize_session_turn_requests(32);

reset role;

do $$
declare
	v_owner uuid := '16000000-0000-4000-8000-000000000001';
	v_member uuid := '16000000-0000-4000-8000-000000000002';
	v_identity uuid := (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid;
	v_sponsor uuid := (current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_company_identity uuid := (current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid;
	v_company_sponsor uuid := (current_setting('qorpera_test.company_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	if (
		select count(*) from public.qorpera_execution_sponsor_versions
		where binding_id = v_sponsor
	) <> 1 then
		raise exception 'member sponsor exact replay created another authority version';
	end if;
	if not exists (
		select 1 from public.qorpera_session_turn_requests as request
		where request.id = (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid
			and request.requested_by_user_id = v_owner
			and request.sponsored_by_user_id = v_owner
			and request.sponsor_binding_id = v_sponsor and request.sponsor_version = 1
			and request.compute_identity_id = v_identity
			and request.worker_class = 'managed_sandbox' and request.status = 'materialized'
			and request.run_id = request.id
	) then
		raise exception 'self-sponsored turn did not preserve exact per-turn authority';
	end if;
	if not exists (
		select 1
		from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		join public.qorpera_runner_model_policies as model_policy on model_policy.job_id = job.id
		where run.id = (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid
			and run.source_kind = 'session_turn' and run.source_id = run.id
			and run.requested_by_user_id = v_owner and run.sponsored_by_user_id = v_owner
			and run.compute_identity_id = v_identity and run.worker_class = 'managed_sandbox'
			and run.sponsor_binding_id = v_sponsor and run.sponsor_version = 1
			and run.model_provider = 'openai' and run.model_id = 'gpt-native'
			and run.model_selection = 'provider_mapping' and run.model_mapping_version = 1
			and run.input_ids = array[(current_setting('qorpera_test.own_turn')::jsonb ->> 'input_id')::uuid]
			and job.status = 'queued' and job.created_by_user_id = v_owner
			and model_policy.allowed_models = '[{"provider":"openai","model":"gpt-native"}]'
	) then
		raise exception 'sponsored session turn was not materialized into one immutable native run';
	end if;
	if not exists (
		select 1
		from public.qorpera_session_turn_requests as request
		join public.qorpera_execution_runs as run on run.id = request.run_id
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where request.id = (current_setting('qorpera_test.company_turn')::jsonb ->> 'turn_request_id')::uuid
			and request.status = 'materialized'
			and request.sponsor_mode = 'company_connection'
			and request.sponsored_by_user_id is null
			and run.compute_identity_id = v_company_identity
			and run.sponsor_binding_id = v_company_sponsor and run.sponsor_version = 1
			and run.requested_by_user_id = v_owner and run.sponsored_by_user_id is null
			and public.qorpera_execution_run_json(run) ->> 'compute_identity_ownership_kind' = 'company'
			and public.qorpera_execution_run_json(run) -> 'compute_identity_owner_user_id' = 'null'::jsonb
			and job.status = 'queued'
	) then
		raise exception 'company-owned native credential was not preserved through run materialization';
	end if;
	if not exists (
		select 1 from public.qorpera_session_turn_requests as request
		where request.id = (current_setting('qorpera_test.sponsored_turn')::jsonb ->> 'turn_request_id')::uuid
			and request.requested_by_user_id = v_member
			and request.requested_sponsor_user_id = v_owner
			and request.sponsored_by_user_id = v_owner
			and request.sponsor_binding_id = v_sponsor and request.sponsor_version = 1
			and request.compute_identity_id = v_identity
			and request.status = 'queued'
	) then
		raise exception 'approved sponsored turn did not preserve requester and sponsor provenance';
	end if;
	if (
		select count(*) from public.qorpera_provider_execution_policies
		where authentication_mode = 'native_subscription'
			and (provider, native_harness) in (
				('openai', 'codex-cli'), ('anthropic', 'claude-code')
			)
	) <> 2 then
		raise exception 'personal native-subscription provider contract was removed by enablement policy';
	end if;
	update public.qorpera_runner_jobs
	set created_at = created_at - interval '1 minute'
	where run_id = (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
end
$$;

-- Exercise the complete cloud-only personal-subscription path. The fixture
-- substitutes deterministic native output for a paid provider call, but uses
-- the same durable orchestrator, provisioned runner, exclusive provider lease,
-- transcript, completion, and provenance contracts as the deployed harness.
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select public.qorpera_register_runner_orchestrator(
	'16000000-0000-4000-8000-000000000092',
	'Native subscription acceptance orchestrator', 'process', repeat('0', 64), 3600
);

create function pg_temp.send_native(p_key text, p_text text, p_phase text, p_override jsonb default '{}')
returns jsonb language plpgsql as $$
declare
	v_original jsonb := current_setting('qorpera_test.native_execution_lease')::jsonb;
	v_authority jsonb := v_original || p_override;
	v_job_id uuid;
begin
	select job_id into strict v_job_id from public.qorpera_execution_runs where id = (v_original ->> 'run_id')::uuid;
	return public.qorpera_send_native_agent_message(
		(v_authority ->> 'lease_id')::uuid, (v_authority ->> 'run_id')::uuid, v_job_id,
		(v_authority ->> 'runner_id')::uuid, (v_authority ->> 'assignment_id')::uuid,
		(v_authority ->> 'credential_capsule_id')::uuid, (v_authority ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli', p_key, p_text, p_phase
	);
end
$$;

-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run.
-- Each destructive probe is rolled back inside a subtransaction.
create function pg_temp.check_native_tools(p_binding jsonb)
returns void language plpgsql as $$
declare
	v_authority jsonb;
	v_identity jsonb;
	v_begin jsonb;
	v_replay jsonb;
	v_complete jsonb;
	v_patch jsonb;
	v_probe text;
	v_function text;
	v_role text;
	v_receipt uuid := '16000000-0000-4000-8000-0000000000b1';
	v_other_receipt uuid := '16000000-0000-4000-8000-0000000000b2';
begin
	foreach v_function in array array[
		'public.qorpera_describe_native_tool_authority(jsonb)',
		'public.qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean)',
		'public.qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid)'
	] loop
		foreach v_role in array array['anon', 'authenticated'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception 'client role % can invoke native tool authority: %', v_role, v_function;
			end if;
		end loop;
		if not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception 'cloud service cannot invoke native tool authority: %', v_function;
		end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_function_privilege(v_role, 'public.qorpera_native_tool_locked_run(jsonb)', 'EXECUTE') then
			raise exception 'API role can directly call the private native tool helper';
		end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', ''] loop
		begin
			perform set_config('request.jwt.claims', case when v_role = '' then '{}' else jsonb_build_object('role', v_role)::text end, true);
			begin
				perform public.qorpera_describe_native_tool_authority(p_binding);
				raise exception 'non-service JWT acquired native tool authority';
			exception when insufficient_privilege then null;
			end;
			raise exception using errcode = 'QTP01';
		exception when sqlstate 'QTP01' then null;
		end;
	end loop;
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	v_identity := v_authority -> 'identity';
	if v_authority ->> 'schema' <> 'qorpera.native-tool-authority/v1'
		or (v_authority ->> 'validForMs')::integer not between 1 and 30000
		or v_identity ->> 'companyId' <> '16000000-0000-4000-8000-000000000010'
		or v_identity ->> 'environmentId' <> '16000000-0000-4000-8000-000000000020'
		or v_identity ->> 'staffAgentId' <> '16000000-0000-4000-8000-000000000030'
		or v_identity ->> 'sessionId' <> '16000000-0000-4000-8000-000000000040'
		or v_identity ->> 'requesterUserId' <> '16000000-0000-4000-8000-000000000001'
		or v_identity ->> 'sponsorUserId' <> '16000000-0000-4000-8000-000000000001'
		or v_identity ->> 'runId' is distinct from p_binding ->> 'runId'
		or v_identity ->> 'jobId' is distinct from p_binding ->> 'jobId'
		or v_identity ->> 'runnerId' is distinct from p_binding ->> 'runnerId'
		or v_identity ->> 'assignmentId' is distinct from p_binding ->> 'assignmentId'
		or v_identity ->> 'leaseId' is distinct from p_binding ->> 'leaseId'
		or v_identity ->> 'computeIdentityId' is distinct from p_binding ->> 'computeIdentityId'
		or v_identity ->> 'model' <> 'gpt-native'
		or v_authority::text ~* '(token|secret|capsule|credential)' then
		raise exception 'native tool identity is not the closed cloud projection';
	end if;
	for v_patch in select value from jsonb_array_elements('[
		{"runId":"16000000-0000-4000-8000-000000000010"},
		{"jobId":"16000000-0000-4000-8000-000000000010"},
		{"assignmentId":"16000000-0000-4000-8000-000000000010"},
		{"runnerId":"16000000-0000-4000-8000-000000000010"},
		{"leaseId":"16000000-0000-4000-8000-000000000010"},
		{"credentialCapsuleId":"16000000-0000-4000-8000-000000000010"},
		{"computeIdentityId":"16000000-0000-4000-8000-000000000010"},
		{"model":"not-the-pinned-model"}
	]'::jsonb) loop
		begin
			perform public.qorpera_describe_native_tool_authority(p_binding || v_patch);
			raise exception 'native tools accepted another run binding: %', v_patch;
		exception when insufficient_privilege then null;
		end;
	end loop;
	for v_patch in select value from jsonb_array_elements('[
		{"companyId":"16000000-0000-4000-8000-000000000010"},
		{"approved":true}, {"model":null}, {"provider":"anthropic"}, {"nativeHarness":"other"}
	]'::jsonb) loop
		begin
			perform public.qorpera_describe_native_tool_authority(p_binding || v_patch);
			raise exception 'native tools accepted malformed or forged authority: %', v_patch;
		exception when invalid_parameter_value then null;
		end;
	end loop;
	begin
		perform public.qorpera_describe_native_tool_authority(p_binding - 'leaseId');
		raise exception 'native tools accepted missing lease authority';
	exception when invalid_parameter_value then null;
	end;
	-- Test fresh state independently of native credentials and cached descriptions.
	foreach v_probe in array array['lease-expired', 'lease-revoked', 'assignment-expired', 'runner-expired', 'staff-inactive'] loop
		begin
			-- Fixture setup needs its owner for CHECK functions; the actual RPC
			-- below still executes as the production service role.
			reset role;
			if v_probe = 'lease-expired' then
				update public.qorpera_native_provider_connection_leases
				set created_at = statement_timestamp() - interval '2 seconds', expires_at = statement_timestamp() - interval '1 second'
				where id = (p_binding ->> 'leaseId')::uuid;
			elsif v_probe = 'lease-revoked' then
				update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = statement_timestamp()
				where id = (p_binding ->> 'leaseId')::uuid;
			elsif v_probe = 'assignment-expired' then
				update public.qorpera_runner_assignments set expires_at = statement_timestamp() - interval '1 second'
				where id = (p_binding ->> 'assignmentId')::uuid;
			elsif v_probe = 'runner-expired' then
				update public.qorpera_runners set session_expires_at = statement_timestamp() - interval '1 second'
				where id = (p_binding ->> 'runnerId')::uuid;
			else
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = '16000000-0000-4000-8000-000000000010' and staff_agent_id = '16000000-0000-4000-8000-000000000030';
			end if;
			set local role service_role;
			begin
				perform public.qorpera_describe_native_tool_authority(p_binding);
				raise exception 'native tools ignored %', v_probe;
			exception when insufficient_privilege then null;
			end;
			raise exception using errcode = 'QTP01';
		exception when sqlstate 'QTP01' then null;
		end;
	end loop;
	-- Clock time, not statement start, must reject a lease expiring during a wait.
	begin
		update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval '20 milliseconds'
		where id = (p_binding ->> 'leaseId')::uuid;
		perform pg_sleep(0.03);
		begin
			perform public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'expired-at-effect', repeat('a',64), repeat('b',64), false);
			raise exception 'operation used statement time after authority expired';
		exception when insufficient_privilege then null;
		end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
	v_begin := public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'step2:exact-operation', repeat('a',64), repeat('b',64), false);
	if v_begin ->> 'state' <> 'executing' or (v_begin ->> 'receipt_id')::uuid <> v_receipt
		or v_begin ->> 'run_id' is distinct from p_binding ->> 'runId' then
		raise exception 'new native tool operation was not admitted durably';
	end if;
	v_replay := public.qorpera_begin_native_tool_operation(p_binding, v_other_receipt, 'step2:exact-operation', repeat('a',64), repeat('b',64), false);
	if v_replay ->> 'state' <> 'executing' or (v_replay ->> 'receipt_id')::uuid <> v_receipt then
		raise exception 'retry with a different call id created a new operation';
	end if;
	begin
		perform public.qorpera_begin_native_tool_operation(p_binding, v_other_receipt, 'step2:exact-operation', repeat('c',64), repeat('b',64), false);
		raise exception 'receipt key was reused for changed arguments';
	exception when unique_violation then null;
	end;
	begin
		perform public.qorpera_begin_native_tool_operation(p_binding, v_other_receipt, 'step2:different-key', repeat('a',64), repeat('b',64), false);
		raise exception 'changing the logical key bypassed an uncertain operation';
	exception when object_not_in_prerequisite_state then null;
	end;
	v_complete := public.qorpera_complete_native_tool_operation(p_binding, v_receipt, repeat('a',64), '{"synthetic":"completed"}');
	if v_complete ->> 'state' <> 'completed' or v_complete -> 'result' <> '{"synthetic":"completed"}'::jsonb then
		raise exception 'native tool completion was not retained';
	end if;
	v_replay := public.qorpera_begin_native_tool_operation(p_binding, v_other_receipt, 'step2:exact-operation', repeat('a',64), repeat('b',64), false);
	if v_replay ->> 'state' <> 'completed' or v_replay -> 'result' <> v_complete -> 'result' then
		raise exception 'native tool restart cannot replay its recorded completion';
	end if;
	begin
		perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, repeat('a',64), '{"synthetic":"changed"}');
		raise exception 'completion replay accepted different content';
	exception when unique_violation then null;
	end;
	begin
		perform public.qorpera_begin_native_tool_operation(p_binding, v_other_receipt, 'step2:requires-revision', repeat('d',64), repeat('e',64), true);
		begin
			perform public.qorpera_complete_native_tool_operation(p_binding, v_other_receipt, repeat('d',64), '{"synthetic":"completed"}');
			raise exception 'Company operation completed without a durable revision';
		exception when object_not_in_prerequisite_state then null;
		end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
end
$$;

do $$
declare
	v_run_id uuid := (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
	v_native_authority jsonb;
	v_model_authority jsonb;
	v_transcript jsonb;
	v_progress jsonb;
	v_private_part jsonb;
	v_completion jsonb;
	v_job_id uuid;
	v_runner_id uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092',
		'16000000-0000-4000-8000-000000000093', 120
	);
	v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id
		or v_claim -> 'work' -> 'sponsor' ->> 'authentication_mode' <> 'native_subscription'
		or v_claim -> 'work' -> 'sponsor' ->> 'native_harness' <> 'codex-cli'
		or v_claim -> 'work' ->> 'compute_identity_ownership_kind' <> 'member' then
		raise exception 'orchestrator did not claim the exact member-native turn';
	end if;

	v_runner := public.qorpera_provision_execution_runner(
		v_run_id, '16000000-0000-4000-8000-000000000094', 'process', repeat('1', 64)
	);
	v_runner_id := (v_runner ->> 'runner_id')::uuid;
	perform public.qorpera_activate_runner(
		v_runner_id, repeat('1', 64), repeat('2', 64), 'linux', 'native-acceptance-v1'
	);
	v_assignment := public.qorpera_assign_runner_job(
		'16000000-0000-4000-8000-000000000092',
		(v_claim ->> 'claim_id')::uuid, v_runner_id,
		'16000000-0000-4000-8000-000000000095', repeat('3', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		v_runner_id, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('3', 64)
	);

	v_native_authority := public.qorpera_acquire_native_provider_connection_lease(
		v_run_id, v_runner_id, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, repeat('3', 64), 120
	);
	perform set_config('qorpera_test.native_execution_lease', v_native_authority::text, false);
	v_model_authority := public.qorpera_native_run_model_authority(
		v_run_id, v_runner_id, repeat('2', 64), v_job_id, repeat('3', 64)
	);
	if v_native_authority ->> 'encrypted_capsule_reference'
			<> 'object://native-capsules/16000000-0000-4000-8000-000000000060'
		or v_native_authority ->> 'provider' <> 'openai'
		or v_native_authority ->> 'native_harness' <> 'codex-cli'
		or v_native_authority ->> 'credential_ownership_kind' <> 'member'
		or v_native_authority ->> 'credential_owner_user_id'
			<> '16000000-0000-4000-8000-000000000001'
		or v_model_authority ->> 'provider' <> 'openai'
		or v_model_authority ->> 'model' <> 'gpt-native' then
		raise exception 'native harness authority lost its exact sponsor, capsule, or model pin';
	end if;
	perform public.qorpera_validate_native_provider_execution_lease(
		(v_native_authority ->> 'lease_id')::uuid, v_run_id, v_job_id, v_runner_id,
		(v_assignment ->> 'assignment_id')::uuid,
		(v_native_authority ->> 'credential_capsule_id')::uuid,
		(v_native_authority ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli'
	);
	update public.qorpera_runner_assignments
	set expires_at = statement_timestamp() - interval '1 second'
	where id = (v_assignment ->> 'assignment_id')::uuid;
	perform public.qorpera_renew_runner_job(v_runner_id, repeat('2', 64), v_job_id, repeat('3', 64));
	if not exists (
		select 1
		from public.qorpera_runner_assignments as assignment
		join public.qorpera_runner_jobs as job on job.id = assignment.job_id
		where assignment.id = (v_assignment ->> 'assignment_id')::uuid
			and assignment.status = 'accepted'
			and assignment.expires_at = job.lease_expires_at
			and assignment.expires_at > statement_timestamp()
	) then
		raise exception 'runner renewal did not extend its accepted assignment capability';
	end if;
	perform public.qorpera_validate_native_provider_execution_lease(
		(v_native_authority ->> 'lease_id')::uuid, v_run_id, v_job_id, v_runner_id,
		(v_assignment ->> 'assignment_id')::uuid,
		(v_native_authority ->> 'credential_capsule_id')::uuid,
		(v_native_authority ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli'
	);

	perform pg_temp.check_native_tools(jsonb_build_object(
		'leaseId', v_native_authority ->> 'lease_id', 'runId', v_run_id, 'jobId', v_job_id,
		'runnerId', v_runner_id, 'assignmentId', v_assignment ->> 'assignment_id',
		'credentialCapsuleId', v_native_authority ->> 'credential_capsule_id',
		'computeIdentityId', v_native_authority ->> 'compute_identity_id',
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-native'
	));

	for v_private_part in select value from jsonb_array_elements('[
		{"type":"text","text":"private final answer must not become a message"},
		{"type":"thinking","thinking":"private reasoning must never appear"},
		{"type":"toolCall","id":"private-call","name":"shell","arguments":{}}
	]'::jsonb) loop
	begin
	perform public.qorpera_append_runner_transcript_event(
		v_runner_id, repeat('2', 64), v_job_id, repeat('3', 64),
		(v_assignment ->> 'assignment_id')::uuid,
		'16000000-0000-4000-8000-000000000096', 'message',
		jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'message',
				'id', '16000000-0000-4000-8000-000000000096',
				'parentId', null,
				'timestamp', '2026-08-21T12:00:01.000Z',
				'message', jsonb_build_object(
					'role', 'assistant',
					'content', jsonb_build_array(v_private_part)
				),
				'execution', jsonb_build_object(
					'kind', 'run', 'id', v_run_id, 'claimantId', v_run_id,
					'runnerAssignmentId', (v_assignment ->> 'assignment_id')::uuid
				)
			)
		), null
	);
	raise exception 'raw provider output was admitted to the public transcript';
	exception when insufficient_privilege then null;
	end;
	end loop;

	begin
		insert into public.qorpera_agent_sends (event_id) values (extensions.gen_random_uuid());
		raise exception 'service role could forge a send receipt outside the authorized function';
	exception when insufficient_privilege then null;
	end;
	begin
		perform pg_temp.send_native('blank', E' \n\t ', 'progress');
		raise exception 'blank message passed the database send boundary';
	exception when invalid_parameter_value then null;
	end;
	v_progress := pg_temp.send_native('progress-1', 'I am checking the Company File.', 'progress');
	if v_progress is distinct from pg_temp.send_native('progress-1', 'I am checking the Company File.', 'progress') then
		raise exception 'send retry did not return the original durable receipt';
	end if;
	if (select count(*) from public.qorpera_session_events where execution_id = v_run_id) <> 1
		or (select status from public.qorpera_runner_jobs where id = v_job_id) <> 'leased' then
		raise exception 'progress send was duplicated or waited for run completion';
	end if;
	begin
		perform pg_temp.send_native('progress-1', 'Changed under the same key', 'progress');
		raise exception 'send replay accepted changed content';
	exception when unique_violation then null;
	end;
	begin
		perform pg_temp.send_native('wrong-audience', 'Do not deliver', 'progress', '{"run_id":"16000000-0000-4000-8000-000000000010"}');
		raise exception 'send accepted another run audience';
	exception when insufficient_privilege then null;
	end;
	begin
		perform pg_temp.send_native('wrong-assignment', 'Do not deliver', 'progress', '{"assignment_id":"16000000-0000-4000-8000-000000000010"}');
		raise exception 'send accepted another assignment';
	exception when insufficient_privilege then null;
	end;
	update public.qorpera_native_provider_connection_leases
	set created_at = statement_timestamp() - interval '2 seconds', expires_at = statement_timestamp() - interval '1 second'
	where id = (v_native_authority ->> 'lease_id')::uuid;
	begin
		perform pg_temp.send_native('progress-1', 'I am checking the Company File.', 'progress');
		raise exception 'expired native authority could replay a send';
	exception when insufficient_privilege then null;
	end;
	update public.qorpera_native_provider_connection_leases set expires_at = statement_timestamp() + interval '120 seconds'
	where id = (v_native_authority ->> 'lease_id')::uuid;
	begin
		update public.qorpera_runner_jobs set status = 'completed' where id = v_job_id;
		raise exception 'acknowledgement satisfied final delivery';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- Exercise the real member cancellation RPC while a native lease is live.
	-- Roll back only this probe so the same fixture can still test completion.
	begin
		perform set_config('request.jwt.claims',
			'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
		set local role authenticated;
		v_completion := public.qorpera_cancel_runner_job(v_job_id);
		if v_completion ->> 'status' <> 'cancelled'
			or v_completion -> 'finished_at' <> 'null'::jsonb
			or v_completion -> 'cancelled_at' = 'null'::jsonb
			or v_completion ->> 'cancelled_by_user_id' <> '16000000-0000-4000-8000-000000000001'
			or v_completion -> 'lease_expires_at' <> 'null'::jsonb
			or v_completion is distinct from public.qorpera_cancel_runner_job(v_job_id) then
			raise exception 'native cancellation was not atomic and idempotent';
		end if;
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
		begin
			perform pg_temp.send_native('progress-1', 'I am checking the Company File.', 'progress');
			raise exception 'cancelled native authority replayed an earlier send';
		exception when insufficient_privilege then null;
		end;
		begin
			perform pg_temp.send_native('cancelled-final', 'Do not deliver', 'final');
			raise exception 'cancelled native authority delivered a new final send';
		exception when insufficient_privilege then null;
		end;
		if (select count(*) from public.qorpera_session_events where execution_id = v_run_id) <> 1 then
			raise exception 'cancellation mutated the already delivered conversation';
		end if;
		raise exception 'rollback cancellation probe' using errcode = 'QCP01';
	exception when sqlstate 'QCP01' then null;
	end;
	v_transcript := pg_temp.send_native('final-1', 'native subscription acceptance response', 'final');
	if v_transcript is distinct from pg_temp.send_native('final-1', 'native subscription acceptance response', 'final') then
		raise exception 'final retry duplicated or changed delivery';
	end if;
	begin
		perform pg_temp.send_native('after-final', 'Do not deliver', 'progress');
		raise exception 'public output remained open after final delivery';
	exception when object_not_in_prerequisite_state then null;
	end;
	if v_transcript ->> 'runId' <> v_run_id::text or not exists (
		select 1 from public.qorpera_session_events as event
		where event.event_id = (v_transcript ->> 'messageId')::uuid
			and event.execution_id = v_run_id
			and event.runner_assignment_id = (v_assignment ->> 'assignment_id')::uuid
			and event.body #>> '{entry,parentId}' = v_progress ->> 'messageId'
			and event.body #>> '{entry,delivery,phase}' = 'final'
	) then
		raise exception 'native response lost immutable runner provenance';
	end if;

	perform public.qorpera_release_native_provider_connection_lease(
		(v_native_authority ->> 'lease_id')::uuid,
		v_runner_id, repeat('2', 64), v_job_id, repeat('3', 64), 'released'
	);
	v_completion := public.qorpera_complete_runner_job_v6(
		v_runner_id, repeat('2', 64), v_job_id, repeat('3', 64),
		'16000000-0000-4000-8000-000000000097',
		'16000000-0000-4000-8000-000000000098', null,
		'{
			"schema":"qorpera.runner-result/v1",
			"backend_result":{"status":"ok","provider":"openai","native_harness":"codex-cli"},
			"output_count":0,
			"output_bytes":0,
			"publication":null,
			"usage":{
				"schema":"qorpera.runner-usage/v1",
				"execution_ms":10,
				"input_bytes":256,
				"output_bytes":0,
				"result_bytes":32,
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
		}'::jsonb
	);
	if v_completion ->> 'status' <> 'completed' then
		raise exception 'native subscription turn did not complete its exact durable input';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","email":"native-member@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

do $$
declare
	v_provenance jsonb := public.qorpera_list_session_turn_requests(
		'16000000-0000-4000-8000-000000000040', 100
	);
begin
	if not exists (
		select 1 from jsonb_array_elements(v_provenance) as item
		where item ->> 'turn_request_id'
			= (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')
			and item ->> 'provider' = 'openai'
			and item ->> 'native_harness' = 'codex-cli'
			and item ->> 'authentication_mode' = 'native_subscription'
			and item ->> 'sponsored_by_name' = 'Native Owner'
			and item ->> 'compute_identity_ownership_kind' = 'member'
			and item ->> 'run_status' = 'completed'
	) then
		raise exception 'another member could not synchronize completed native sponsor provenance';
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

-- Once the first turn is terminal, the previously approved shared turn can be
-- materialized. Revocation below must fence this subsequent native execution.
select public.qorpera_materialize_session_turn_requests(32);

reset role;

-- A real sponsored turn must retain the requesting friend, not silently
-- substitute the subscription owner. Roll the probe back before the existing
-- revocation tests so this does not change their queued-run fixture.
do $$
declare
	v_run_id uuid := (current_setting('qorpera_test.sponsored_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
	v_native jsonb;
	v_binding jsonb;
	v_identity jsonb;
	v_runner_id uuid;
	v_job_id uuid;
begin
	begin
		update public.qorpera_runner_jobs set created_at = created_at - interval '1 hour' where run_id = v_run_id;
		set local role service_role;
		v_claim := public.qorpera_claim_runner_job_for_orchestrator('16000000-0000-4000-8000-000000000092', '16000000-0000-4000-8000-0000000000d1', 120);
		if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id then
			raise exception 'fixture did not claim the friend-sponsored run';
		end if;
		v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
		v_runner := public.qorpera_provision_execution_runner(v_run_id, '16000000-0000-4000-8000-0000000000d2', 'process', repeat('4',64));
		v_runner_id := (v_runner ->> 'runner_id')::uuid;
		perform public.qorpera_activate_runner(v_runner_id, repeat('4',64), repeat('5',64), 'linux', 'native-tool-authority-test');
		v_assignment := public.qorpera_assign_runner_job('16000000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
			v_runner_id, '16000000-0000-4000-8000-0000000000d3', repeat('6',64), 120);
		perform public.qorpera_accept_runner_assignment(v_runner_id, repeat('5',64), (v_assignment ->> 'assignment_id')::uuid, v_job_id, repeat('6',64));
		v_native := public.qorpera_acquire_native_provider_connection_lease(v_run_id, v_runner_id, repeat('5',64),
			(v_assignment ->> 'assignment_id')::uuid, repeat('6',64), 120);
		v_binding := jsonb_build_object('runId', v_run_id, 'jobId', v_job_id, 'runnerId', v_runner_id,
			'assignmentId', v_assignment ->> 'assignment_id', 'leaseId', v_native ->> 'lease_id',
			'credentialCapsuleId', v_native ->> 'credential_capsule_id', 'computeIdentityId', v_native ->> 'compute_identity_id',
			'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-native');
		v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
		if v_identity ->> 'requesterUserId' <> '16000000-0000-4000-8000-000000000002'
			or v_identity ->> 'sponsorUserId' <> '16000000-0000-4000-8000-000000000001' then
			raise exception 'tool identity replaced the requester with its sponsor';
		end if;
		reset role;
		delete from public.qorpera_profile_members where profile_id = '16000000-0000-4000-8000-000000000010'
			and user_id = '16000000-0000-4000-8000-000000000002';
		if not exists (select 1 from public.qorpera_provider_connections
			where id = (v_identity ->> 'providerConnectionId')::uuid and status = 'active') then
			raise exception 'requester-removal fixture also revoked the sponsor';
		end if;
		set local role service_role;
		begin
			perform public.qorpera_describe_native_tool_authority(v_binding);
			raise exception 'departed requester retained authority through another member subscription';
		exception when insufficient_privilege then null;
		end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
end
$$;


select set_config(
	'request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","email":"native-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.native_revocation',
	public.qorpera_revoke_native_provider_connection(
		'16000000-0000-4000-8000-000000000010',
		(current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid
	)::text,
	false
);

reset role;

do $$
declare
	v_connection_id uuid := (current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid;
begin
	if not public.qorpera_runner_transcript_entry_valid(
		'message',
		'{"schema":"qorpera.runner-transcript-entry/v1","entry":{"type":"message","id":"16000000-0000-4000-8000-000000000090","parentId":null,"timestamp":"2026-08-21T12:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"native response"}]}}}'::jsonb
	) or public.qorpera_runner_transcript_entry_valid(
		'message',
		'{"schema":"qorpera.runner-transcript-entry/v1","entry":{"type":"message","id":"16000000-0000-4000-8000-000000000091","parentId":null,"timestamp":"2026-08-21T12:00:00.000Z","role":"assistant","content":[{"type":"text","text":"flattened response"}]}}'::jsonb
	) then
		raise exception 'native harness assistant output does not match the canonical transcript schema';
	end if;
	if current_setting('qorpera_test.native_revocation')::jsonb ->> 'status' <> 'revoked'
		or exists (
			select 1 from public.qorpera_provider_connection_versions as version
			where version.connection_id = v_connection_id
				and version.authorization_state <> 'revoked'
		) or exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_provider_connection_versions as version
				on version.credential_capsule_id = capsule.id
			where version.connection_id = v_connection_id
				and (capsule.status <> 'revoked' or capsule.revoked_at is null)
		) or exists (
			select 1 from public.qorpera_native_provider_connection_leases as lease
			where lease.provider_connection_id = v_connection_id and lease.status = 'active'
		) then
		raise exception 'member revocation did not fence every native execution authority';
	end if;
	if not exists (
		select 1
		from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where run.id = (current_setting('qorpera_test.sponsored_turn')::jsonb ->> 'turn_request_id')::uuid
			and job.status = 'failed'
	) then
		raise exception 'member revocation did not terminate subsequent queued native execution';
	end if;
end
$$;

set role authenticated;

do $$
declare
	v_rejected boolean := false;
begin
	begin
		perform public.qorpera_request_session_turn_v2(
			'16000000-0000-4000-8000-000000000040',
			'16000000-0000-4000-8000-000000000074',
			'16000000-0000-4000-8000-000000000075',
			'{"schema":"qorpera.session-prompt/v1","text":"This must be denied after revocation.","images":[]}',
			'member_connection',
			(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
			1, null,
			(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
			null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
		);
	exception when insufficient_privilege then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'revoked member subscription admitted a subsequent turn';
	end if;
end
$$;

-- The same durable Qorpera session and logical staff agent can attach a
-- different member-owned native provider for a later turn. The run pins the
-- selected provider/model without rewriting the staff identity or transcript.
select set_config(
	'qorpera_test.anthropic_turn',
	public.qorpera_request_session_turn_v2(
		'16000000-0000-4000-8000-000000000040',
		'16000000-0000-4000-8000-0000000000a5',
		'16000000-0000-4000-8000-0000000000a6',
		'{"schema":"qorpera.session-prompt/v1","text":"Continue this logical agent through Claude.","images":[]}',
		'member_connection',
		(current_setting('qorpera_test.anthropic_sponsor')::jsonb ->> 'binding_id')::uuid,
		1, null,
		(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
	)::text,
	false
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select public.qorpera_materialize_session_turn_requests(32);

reset role;

do $$
begin
	if not exists (
		select 1
		from public.qorpera_session_turn_requests as request
		join public.qorpera_execution_runs as run on run.id = request.run_id
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		join public.qorpera_runner_model_policies as model_policy on model_policy.job_id = job.id
		where request.id = (current_setting('qorpera_test.anthropic_turn')::jsonb ->> 'turn_request_id')::uuid
			and request.status = 'materialized'
			and run.session_id = '16000000-0000-4000-8000-000000000040'
			and run.staff_agent_id = '16000000-0000-4000-8000-000000000030'
			and run.staff_version = 1
			and run.model_provider = 'anthropic' and run.model_id = 'provider-default'
			and run.model_selection = 'provider_default' and run.model_mapping_version is null
			and run.sponsor_binding_id = (
				current_setting('qorpera_test.anthropic_sponsor')::jsonb ->> 'binding_id'
			)::uuid
			and model_policy.allowed_models = '[{"provider":"anthropic","model":"provider-default"}]'
			and job.status = 'queued'
	) then
		raise exception 'one logical agent could not switch to its Anthropic subscription default';
	end if;
end
$$;

-- Member cancellation must also work before a runner is assigned, without
-- granting a coworker permission to cancel somebody else's queued job.
select set_config('qorpera_test.cancel_job_id', (
	select job_id::text from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.anthropic_turn')::jsonb ->> 'turn_request_id')::uuid
), false);
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}', false);
set role authenticated;

do $$
declare
	v_job_id uuid := current_setting('qorpera_test.cancel_job_id')::uuid;
begin
	begin
		perform public.qorpera_cancel_runner_job(v_job_id);
		raise exception 'coworker cancelled another member''s queued job';
	exception when insufficient_privilege then null;
	end;
end
$$;

select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}', false);

do $$
declare
	v_job_id uuid := current_setting('qorpera_test.cancel_job_id')::uuid;
	v_cancelled jsonb;
begin
	v_cancelled := public.qorpera_cancel_runner_job(v_job_id);
	if v_cancelled ->> 'status' <> 'cancelled'
		or v_cancelled -> 'finished_at' <> 'null'::jsonb
		or v_cancelled -> 'cancelled_at' = 'null'::jsonb
		or v_cancelled ->> 'cancelled_by_user_id' <> '16000000-0000-4000-8000-000000000001'
		or v_cancelled is distinct from public.qorpera_cancel_runner_job(v_job_id) then
		raise exception 'queued cancellation did not preserve its member and timestamp';
	end if;
end
$$;

rollback;
