-- Company folder core, C1c-2a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.2, §5.5, §5.9):
-- a folder-v2 run's tool calls queue on the run mutex (the run's budget row, before the job); a second tool call and
-- a job lease renewal never starve behind each other; the stop's drain waits for a tool call in flight and the calls
-- behind it refuse; a save that rewrites the agent's agent.md runs beside the agent's tool call. The fixture is
-- committed so the connections can see it, and removed at the end. Waits are detected with pg_blocking_pids, never by
-- wall-clock time.

insert into auth.users(id,email) values ('64800000-0000-4000-8000-000000000001','fence-race-owner@example.test'),
	('64800000-0000-4000-8000-000000000002','fence-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('64800000-0000-4000-8000-000000000010','Run fence race','64800000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('64800000-0000-4000-8000-000000000010','64800000-0000-4000-8000-000000000001','fence-race-owner@example.test','Owner','owner'),
	('64800000-0000-4000-8000-000000000010','64800000-0000-4000-8000-000000000002','fence-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('64800000-0000-4000-8000-000000000020','64800000-0000-4000-8000-000000000010','Environment',1,'64800000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('64800000-0000-4000-8000-000000000020') \g /dev/null

-- Verified bytes for a text, and the agent file helpers, as in 701.
create function pg_temp.stage(p_text text) returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','64800000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','64800000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('64800000-0000-4000-8000-000000000010',v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/markdown','executable',false);
end $$;
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent')
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: active\n---\nSell.\n', p_id, p_name, p_kind)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent')
returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status','active',
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
create function pg_temp.hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('64800000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text) returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome then
		raise exception 'Unit % expected %, got %', p_unit, p_outcome, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020' and key_text = p_key
$$;

-- The creation commit and agent Ada's hire, committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'fence-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'),
	pg_temp.write('vision/vision.md', 'vision', E'# Run fence race\n\n## What we build\n', '{"kind":"vision","name":"Run fence race"}',
		pg_temp.version('vision/vision.md')),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '64800000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'))), 5, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'fence-hire-0001',
	jsonb_build_array(pg_temp.hire('ada', '64800000-0000-4000-8000-0000000000a1', 'Ada'))), 1, 'saved') \g /dev/null

-- The company's login (connection b3, binding b1, a native subscription on the company's compute identity d1), and a
-- hand-built leased human run of Ada for the member with its runner, assignment, native lease, reservation, model
-- policy and budget row, all committed. Foreign keys and triggers are off only while the rows go in.
set session_replication_role = replica;
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
values ('64800000-0000-4000-8000-0000000000d1', '64800000-0000-4000-8000-000000000010', 'company', extensions.gen_random_uuid(), 'Race identity');
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
	encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
values ('64800000-0000-4000-8000-0000000000d2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000d1', 'company',
	'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64), '64800000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('64800000-0000-4000-8000-0000000000b3', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai',
	'64800000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
	consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy)
values ('64800000-0000-4000-8000-0000000000b3', 1, 'native_subscription', 'codex-cli', 'subscription', 'fixture',
	'64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-0000000000d2', 8,
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('64800000-0000-4000-8000-0000000000b1', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('64800000-0000-4000-8000-0000000000b1', 1, 'company_service_account', '64800000-0000-4000-8000-0000000000b3', 1,
	'64800000-0000-4000-8000-000000000001');
do $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_run uuid := '64800000-0000-4000-8000-0000000000f1'; v_job uuid := '64800000-0000-4000-8000-0000000000f2';
	v_wake uuid := '64800000-0000-4000-8000-0000000000f3'; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_assignment uuid := '64800000-0000-4000-8000-0000000000f5'; v_lease uuid := '64800000-0000-4000-8000-0000000000f6';
	v_session uuid := '64800000-0000-4000-8000-0000000000f7'; v_input uuid := '64800000-0000-4000-8000-0000000000f8';
	v_bundle uuid := '64800000-0000-4000-8000-0000000000f9';
begin
	insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version,
		audience_kind)
	values (v_session, v_profile, v_env, 'Ada', v_requester, v_staff::text,
		(select version from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = v_staff), 'company');
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_bundle, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, compute_identity_id)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, '64800000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester,
		'openai', 'gpt-test', 'provider_default', 'company', v_bundle, repeat('b', 64), v_session, array[v_input],
		'64800000-0000-4000-8000-0000000000d1');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, '64800000-0000-4000-8000-0000000000b1', 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values (v_runner, v_profile, v_runner, 'Race runner', '["agent_turn"]', 'active', repeat('e', 64), clock_timestamp() + interval '1 hour',
		clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour', v_requester, '64800000-0000-4000-8000-0000000000d1');
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, extensions.gen_random_uuid(), v_job, v_run, v_runner, repeat('e', 64), 'accepted',
		clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run, v_job, '64800000-0000-4000-8000-0000000000b3', 1, '64800000-0000-4000-8000-0000000000d2',
		'64800000-0000-4000-8000-0000000000d1', v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run, v_job, v_profile, '64800000-0000-4000-8000-0000000000b1', 1, '64800000-0000-4000-8000-0000000000b3', 1,
		date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_job, v_profile, v_env, '["gpt-test"]', 32, 1000, 1000, v_requester);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run);
end $$;
-- A snapshot-v1 company whose run, job, native lease and compute identity match, for the direct lease check's control.
-- The company itself goes in with triggers on, so it has its Company File row as every real company does.
set session_replication_role = origin;
insert into auth.users(id,email) values ('64800000-0000-4000-8000-000000000003','fence-race-snapshot@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('64800000-0000-4000-8000-000000000011','Run fence snapshot control','64800000-0000-4000-8000-000000000003');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('64800000-0000-4000-8000-000000000011','64800000-0000-4000-8000-000000000003','fence-race-snapshot@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('64800000-0000-4000-8000-000000000021','64800000-0000-4000-8000-000000000011','Environment',1,'64800000-0000-4000-8000-000000000003');
do $$
begin
	if not exists (select 1 from public.qorpera_company_files where environment_id = '64800000-0000-4000-8000-000000000021'
		and core is distinct from 'folder-v2') then raise exception 'The control company must be snapshot-v1 with its Company File row'; end if;
end $$;
set session_replication_role = replica;
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
values ('64800000-0000-4000-8000-0000000000e1', '64800000-0000-4000-8000-000000000011', 'company', extensions.gen_random_uuid(), 'Snapshot identity');
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
values ('64800000-0000-4000-8000-0000000000e2', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64800000-0000-4000-8000-000000000003',
	'leased', '64800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-0000000000e5', repeat('a', 64),
	clock_timestamp() + interval '1 hour', '64800000-0000-4000-8000-0000000000e3');
insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
	company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
	payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
	audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids, compute_identity_id)
values ('64800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
	'wake', extensions.gen_random_uuid(), '64800000-0000-4000-8000-0000000000e2', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
	extensions.gen_random_uuid(), 1, extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
	'64800000-0000-4000-8000-000000000003', '64800000-0000-4000-8000-000000000003', 'openai', 'gpt-test', 'provider_default', 'company',
	extensions.gen_random_uuid(), repeat('b', 64), '{}', '64800000-0000-4000-8000-0000000000e1');
insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
	credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
values ('64800000-0000-4000-8000-0000000000e6', '64800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-0000000000e2',
	extensions.gen_random_uuid(), 1, '64800000-0000-4000-8000-0000000000e7', '64800000-0000-4000-8000-0000000000e1',
	'64800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-0000000000e5', repeat('d', 64), clock_timestamp() + interval '1 hour');
set session_replication_role = origin;
select set_config('qorpera_test.binding', jsonb_build_object('leaseId','64800000-0000-4000-8000-0000000000f6',
	'runId','64800000-0000-4000-8000-0000000000f1','jobId','64800000-0000-4000-8000-0000000000f2',
	'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','64800000-0000-4000-8000-0000000000f5',
	'credentialCapsuleId','64800000-0000-4000-8000-0000000000d2','computeIdentityId','64800000-0000-4000-8000-0000000000d1',
	'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, false) \g /dev/null
-- The run check works before any race.
select (public.qorpera_native_tool_locked_run(current_setting('qorpera_test.binding')::jsonb)).id \g /dev/null

-- Two agent.md rewrites. Their bytes are staged now: staging inside a save's own transaction would lock the company
-- row. Each save names the file's version current when it is sent.
select set_config('qorpera_test.file_' || n, pg_temp.stage(pg_temp.agent_text('64800000-0000-4000-8000-0000000000a1', 'Ada ' || n))::text,
	false) from generate_series(1, 2) n \g /dev/null
create function pg_temp.sql_rename(p_n integer) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'fence-rename-000' || p_n,
		jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'agents/ada/agent.md',
			'file', current_setting('qorpera_test.file_' || p_n)::jsonb, 'expectedVersion', pg_temp.version('agents/ada/agent.md'),
			'structured', jsonb_build_array(pg_temp.entry('agents/ada/agent.md', 'agent',
				pg_temp.agent_text('64800000-0000-4000-8000-0000000000a1', 'Ada ' || p_n),
				pg_temp.agent_parse('64800000-0000-4000-8000-0000000000a1', 'Ada ' || p_n)))))::text)
$$;

create function pg_temp.sql_tool() returns text language sql as $$
	select format('select (public.qorpera_native_tool_locked_run(%L)).id::text', current_setting('qorpera_test.binding'))
$$;
create function pg_temp.sql_renew() returns text language sql as $$
	select format('select public.qorpera_renew_runner_job(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-0000000000f4', repeat('f', 64),
		'64800000-0000-4000-8000-0000000000f2', repeat('a', 64))
$$;
-- Reads a sent statement's error (state and message) or 'ok', and drains the connection.
create function pg_temp.outcome(p_conn text) returns text language plpgsql as $$
declare v_state text := 'ok';
begin
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then v_state := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_state;
end $$;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['fence_one','fence_two','fence_three','fence_four']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;
-- The table whose row a waiting connection queues on: a row waiter holds that row's tuple lock while it sleeps.
create function pg_temp.queued_on(p_conn text) returns regclass language sql as $$
	select relation::regclass from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and locktype = 'tuple' and granted limit 1
$$;

-- A. Two tool calls of one run: the second waits at the run mutex (the budget row), not at the job, and runs once the
-- first commits. Nothing deadlocks.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second tool call of the run must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'The second tool call must queue on the run mutex, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The second tool call after the first: %', v_state; end if;
end $$;

-- B. A tool call that arrives while completion holds the job takes the mutex, then waits at the job; a third waits at
-- the mutex, never beside the waiting completion at the job. Once completion ends the job, both refuse.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A tool call must wait for completion at the job'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runner_jobs'::regclass then
		raise exception 'The first tool call must hold the mutex and queue on the job, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_send_query('fence_three', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_three', 'fence_two') then raise exception 'A later tool call must wait at the mutex'; end if;
	if pg_temp.queued_on('fence_three') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'A later tool call must queue on the run mutex, not on %', pg_temp.queued_on('fence_three'); end if;
	perform dblink_exec('fence_one', $q$set local session_replication_role = replica$q$);
	perform dblink_exec('fence_one', $q$update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = '64800000-0000-4000-8000-0000000000f2'$q$);
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '42501 %' then raise exception 'A tool call after its run ended must refuse, got %', v_state; end if;
	v_state := pg_temp.outcome('fence_three');
	if v_state not like '42501 %' then raise exception 'A queued tool call after its run ended must refuse, got %', v_state; end if;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'leased', finished_at = null, lease_token_sha256 = repeat('a', 64),
		lease_expires_at = clock_timestamp() + interval '1 hour' where id = '64800000-0000-4000-8000-0000000000f2';
end $$;

-- C. A job lease renewal is never starved by the run's tool calls (P23, migration 20260930002200): it takes the job FOR NO
-- KEY UPDATE, which a tool call's KEY SHARE does not block, so it runs beside the call in flight. A second tool call
-- waits at the mutex, never beside the first at the job.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_renew());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'The renewal must not wait for the tool call in flight'; end if;
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The renewal: %', v_state; end if;
	perform dblink_exec('fence_three', 'begin');
	perform dblink_send_query('fence_three', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_three', 'fence_one') then raise exception 'The second tool call must wait for the first'; end if;
	if pg_temp.queued_on('fence_three') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'The second tool call must wait at the mutex, not beside the first at the job'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'The second tool call: %', v_state; end if;
	perform dblink_exec('fence_three', 'commit');
end $$;

-- D. The stop: a tool call waiting at the mutex when the stop comes refuses; the drain waits for the tool call in
-- flight; a tool call after the stop refuses at once.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_four', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_four', 'fence_one') then raise exception 'A second tool call must wait for the first'; end if;
	-- The pause row, committed on its own connection (this block is one transaction).
	perform * from dblink('fence_three', $q$select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010',
		'64800000-0000-4000-8000-000000000001', 'race')::text$q$) as t(x text);
	perform dblink_send_query('fence_two', $q$select public.qorpera_folder_pause_drain('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The drain must wait for the tool call in flight'; end if;
	perform dblink_send_query('fence_three', pg_temp.sql_tool());
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then raise exception 'A tool call after the stop must not wait'; end if;
	v_state := pg_temp.outcome('fence_three');
	if v_state not like '55000 %' then raise exception 'A tool call after the stop must refuse, got %', v_state; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The drain: %', v_state; end if;
	v_state := pg_temp.outcome('fence_four');
	if v_state not like '55000 %' then raise exception 'A tool call that waited behind the stop must refuse, got %', v_state; end if;
	perform * from dblink('fence_three', $q$select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
end $$;

-- E. A save that rewrites Ada's agent.md (her roster row FOR NO KEY UPDATE) runs beside Ada's tool call (her row KEY
-- SHARE), in either order: no wait, no 55P03, no deadlock.
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_rename(1));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'The agent.md save must not wait for the tool call'; end if;
	select r::jsonb into v from dblink_get_result('fence_two') as t(r text);
	perform * from dblink_get_result('fence_two') as t(r text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The agent.md save beside a tool call: %', v; end if;
	perform dblink_exec('fence_one', 'commit');

	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_rename(2)) as t(r text);
	perform dblink_send_query('fence_one', pg_temp.sql_tool());
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'The tool call must not wait for the agent.md save'; end if;
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The tool call beside an agent.md save: %', v_state; end if;
	perform dblink_exec('fence_two', 'commit');
	if (select display_name from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010'
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1') is distinct from 'Ada 2' then
		raise exception 'Both saves must reach the roster'; end if;
end $$;

-- F. What a tool call holds: this company's row KEY SHARE (a company-row FOR UPDATE waits, FOR NO KEY UPDATE does not),
-- and a caller's rank 6 target KEY SHARE. The lease check the runtime calls directly and a member's export source take
-- no company lock, so neither waits for the tool call.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform * from dblink('fence_one', format('select public.qorpera_folder_run_enter(%L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010',
		'{"kind":"run","runId":"64800000-0000-4000-8000-0000000000f1","jobId":"64800000-0000-4000-8000-0000000000f2","runnerId":"64800000-0000-4000-8000-0000000000f4","assignmentId":"64800000-0000-4000-8000-0000000000f5"}',
		jsonb_build_array(jsonb_build_object('rank', 6, 'tbl', 'qorpera_company_path_resources', 'mode', 'keyshare', 'required', true,
			'key', (select id from public.qorpera_company_path_resources where environment_id = '64800000-0000-4000-8000-000000000020'
				and path = ''))))) as t(x text);
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for no key update$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'The company row must be held KEY SHARE only'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A tool call must hold this company''s row'; end if;
	-- The job and the fence are held KEY SHARE, not more: a FOR NO KEY UPDATE of either does not wait.
	perform dblink_send_query('fence_four', $q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2'
		for no key update$q$);
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'The job must be held KEY SHARE only'; end if;
	v_state := pg_temp.outcome('fence_four');
	perform dblink_send_query('fence_four', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for no key update$q$);
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'The fence must be held KEY SHARE only'; end if;
	v_state := pg_temp.outcome('fence_four');
	-- The actor entry point and presence take none of the run check's locks: they pass a tool call holding the mutex.
	perform dblink_send_query('fence_four', format('select public.qorpera_company_run_actor(%L, %L)::text',
		'64800000-0000-4000-8000-000000000020', current_setting('qorpera_test.binding')));
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'The actor entry point must not wait for a tool call'; end if;
	v_state := pg_temp.outcome('fence_four');
	if v_state <> 'ok' then raise exception 'The actor entry point beside a tool call: %', v_state; end if;
	perform dblink_send_query('fence_four', format('select public.qorpera_company_presence_scope(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', current_setting('qorpera_test.binding'), array['vision/vision.md']));
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'Presence must not wait for a tool call'; end if;
	v_state := pg_temp.outcome('fence_four');
	if v_state <> 'ok' then raise exception 'Presence beside a tool call: %', v_state; end if;
	perform dblink_send_query('fence_three', $q$select 1 from public.qorpera_company_path_resources
		where environment_id = '64800000-0000-4000-8000-000000000020' and path = '' for update$q$);
	if not pg_temp.waits_for('fence_three', 'fence_one') then raise exception 'A caller''s rank 6 target must be held'; end if;
	perform dblink_send_query('fence_four', format('select public.qorpera_validate_native_provider_execution_lease(%L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-0000000000f6', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f2',
		'64800000-0000-4000-8000-0000000000f4', '64800000-0000-4000-8000-0000000000f5', '64800000-0000-4000-8000-0000000000d2',
		'64800000-0000-4000-8000-0000000000d1', 'openai', 'codex-cli'));
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'The direct lease check must take no lock'; end if;
	v_state := pg_temp.outcome('fence_four');
	if v_state <> 'ok' then raise exception 'The direct lease check beside a tool call: %', v_state; end if;
	perform dblink_exec('fence_four', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000002"}'$q$);
	perform dblink_send_query('fence_four', format('select public.qorpera_member_file_export_source(%L, %L)::text',
		'64800000-0000-4000-8000-000000000020', jsonb_build_object('realm','object_storage','assetId',extensions.gen_random_uuid(),
			'sha256',repeat('a',64))));
	if not pg_temp.finishes_unblocked('fence_four', 'fence_one') then raise exception 'A member''s export source must not lock the company row'; end if;
	v_state := pg_temp.outcome('fence_four');
	if v_state not like '42501 %Completed shared export required%' then raise exception 'The export source: %', v_state; end if;
	perform dblink_exec('fence_four', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The company row after the tool call: %', v_state; end if;
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'The resource after the tool call: %', v_state; end if;
end $$;

-- G. This company's row comes before the members (rank 0 before rank 1): a tool call waiting for the company row holds no
-- member lock, so member removal (company row, then member) cannot deadlock with it.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'A tool call must wait for a company-row holder'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The tool call must queue on the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_send_query('fence_three', $q$select 1 from public.qorpera_profile_members
		where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '64800000-0000-4000-8000-000000000002' for update$q$);
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then
		raise exception 'A tool call waiting for the company row must hold no member lock'; end if;
	v_state := pg_temp.outcome('fence_three');
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The tool call after the company row: %', v_state; end if;
end $$;

-- H. Snapshot-v1 control for the direct lease check: its legacy body takes the company row FOR UPDATE (the gc fence), so
-- it waits for a holder of a snapshot-v1 company's row; the folder body never would.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000011'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_validate_native_provider_execution_lease(%L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-0000000000e6', '64800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-0000000000e2',
		'64800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-0000000000e5', '64800000-0000-4000-8000-0000000000e7',
		'64800000-0000-4000-8000-0000000000e1', 'openai', 'codex-cli'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then
		raise exception 'The snapshot-v1 lease check must take its company row (the legacy body)'; end if;
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	-- The fixture has no runner row, so the legacy body then refuses the runner's generation.
	if v_state not like '42501 %' then raise exception 'The snapshot-v1 lease check after the company row: %', v_state; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: every row of the company, its environment, its runs, jobs, sessions, rooms and login.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000011')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runners where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
