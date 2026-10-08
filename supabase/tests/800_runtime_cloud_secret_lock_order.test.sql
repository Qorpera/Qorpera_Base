-- The vault's member changes on a folder-v2 company under concurrency (20260928419980, 20260928459190), ported from
-- snapshot-v1 in the legacy sweep. A second connection holds a row while real calls run on others:
-- 1. Someone outside the company and a contributor are refused at once, before any lock, while another transaction
--    holds the company row FOR UPDATE, with the error they got before: the Disconnect, a grant of one operation, a
--    grant's withdrawal, the share with agents and a rotation's start. So are the viewer's Disconnect and share, a
--    contributor or an admin rotating the company's connection named as their own (757's §9), and another company's
--    broker sealing this company's capture ticket.
-- 2. An admin who passes the plain checks and is demoted (the owner's role change, committed) while the call waits for
--    the company row is still refused: the Disconnect, a grant, a grant's withdrawal and the share.
-- 3. An agent call holds its grant and waits for the held secret; the owner's withdrawal of that grant waits for the
--    call at the grant (not at the secret), and both land.
-- The fixture is a small committed folder-v2 company of its own, built as 648's (the creation commit, two hires, the
-- company's login and a hand-built leased run of Ada's), with its vault rows inserted as 850's; all removed at the end.
-- Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id, email) values
	('80000000-0000-4000-8000-000000000001', 'secret-order-owner@example.test'),
	('80000000-0000-4000-8000-000000000002', 'secret-order-contributor@example.test'),
	('80000000-0000-4000-8000-000000000003', 'secret-order-admin@example.test'),
	('80000000-0000-4000-8000-000000000004', 'secret-order-viewer@example.test'),
	('80000000-0000-4000-8000-000000000005', 'secret-order-outsider@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('80000000-0000-4000-8000-000000000010', 'Vault lock order', '80000000-0000-4000-8000-000000000001'),
	('80000000-0000-4000-8000-000000000011', 'Another company', '80000000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000001', 'secret-order-owner@example.test', 'Owner', 'owner'),
	('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000002', 'secret-order-contributor@example.test',
		'Contributor', 'contributor'),
	('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000003', 'secret-order-admin@example.test', 'Admin', 'admin'),
	('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000004', 'secret-order-viewer@example.test', 'Viewer', 'viewer');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('80000000-0000-4000-8000-000000000020', '80000000-0000-4000-8000-000000000010', 'Environment', 1,
	'80000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('80000000-0000-4000-8000-000000000020') \g /dev/null

-- The folder helpers, as 648's.
create function pg_temp.cs_manifest(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
create function pg_temp.cs_seal_upload(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload(p_env, p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
end $$;
create temp table cs_files(manifest_sha256 text primary key, manifest_text text not null);
create function pg_temp.cs_stage(p_text text) returns jsonb language plpgsql as $$
declare v_seal jsonb; v_manifest text := pg_temp.cs_manifest(p_text);
begin
	v_seal := pg_temp.cs_seal_upload('80000000-0000-4000-8000-000000000020', '{"kind":"platform"}', v_manifest);
	if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	insert into pg_temp.cs_files values (v_seal -> 'file' ->> 'manifestSha256', v_manifest) on conflict do nothing;
	return v_seal -> 'file';
end $$;
-- Before a member commits units, it stages each of their files pg_temp.cs_stage made, as its own upload would (C1D §3).
create function pg_temp.cs_possess(p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' then return; end if;
	for v_manifest in select distinct s.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join pg_temp.cs_files s on s.manifest_sha256 = refs.f ->> 'manifestSha256' loop
		perform pg_temp.cs_seal_upload('80000000-0000-4000-8000-000000000020', p_actor, v_manifest);
	end loop;
end $$;
create function pg_temp.cs_entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.cs_version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '80000000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.cs_write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb
language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.cs_stage(p_text),
		'structured', jsonb_build_array(pg_temp.cs_entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.cs_agent_text(p_id uuid, p_name text, p_kind text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: active\n---\nSell.\n', p_id, p_name, p_kind)
$$;
create function pg_temp.cs_hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.cs_stage(pg_temp.cs_agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.cs_entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.cs_agent_text(p_id, p_name, p_kind),
			jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status','active',
				'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.'))))
$$;
-- A commit, then its follow-ups (P15), as 648's.
create function pg_temp.cs_commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb; v_subject record; v_work public.qorpera_folder_follow_ups%rowtype;
begin
	perform pg_temp.cs_possess(p_actor, p_units);
	v_result := public.qorpera_folder_commit('80000000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
	for v_subject in select distinct m.subject_kind, m.subject_id from public.qorpera_folder_follow_up_marks m
		where m.environment_id = '80000000-0000-4000-8000-000000000020' loop
		v_work := public.qorpera_folder_follow_up_take('80000000-0000-4000-8000-000000000020', v_subject.subject_kind, v_subject.subject_id);
	end loop;
	for v_work in select * from public.qorpera_folder_follow_ups w where w.environment_id = '80000000-0000-4000-8000-000000000020'
		and w.dirty order by w.subject_kind = 'agent', w.subject_id loop
		perform public.qorpera_folder_follow_up_converge(v_work);
	end loop;
	return v_result;
end $$;
create function pg_temp.cs_expect(p_result jsonb, p_unit integer, p_outcome text) returns void language plpgsql as $$
begin
	if p_result -> 'units' -> (p_unit - 1) ->> 'outcome' is distinct from p_outcome then
		raise exception 'Fixture unit % expected %, got %', p_unit, p_outcome, p_result; end if;
end $$;
create function pg_temp.cs_check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception '%', p_message; end if;
end $$;

-- The creation commit, and the owner's hires of Ada (the run's agent) and Bea, committed.
select pg_temp.cs_expect(pg_temp.cs_commit('{"kind":"platform"}', 'secret-order-seed', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'),
	pg_temp.cs_write('vision/vision.md', 'vision', E'# Vault lock order\n\n## What we build\n', '{"kind":"vision","name":"Vault lock order"}',
		pg_temp.cs_version('vision/vision.md')),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.cs_write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.cs_hire('co-founder', '80000000-0000-4000-8000-000000000033', 'Co-Founder', 'co-founder'))), 5, 'saved') \g /dev/null
do $$
declare v_result jsonb := pg_temp.cs_commit('{"kind":"member","userId":"80000000-0000-4000-8000-000000000001"}', 'secret-order-hires',
	jsonb_build_array(pg_temp.cs_hire('ada', '80000000-0000-4000-8000-000000000030', 'Ada'),
		pg_temp.cs_hire('bea', '80000000-0000-4000-8000-000000000031', 'Bea')));
begin
	perform pg_temp.cs_expect(v_result, 1, 'saved');
	perform pg_temp.cs_expect(v_result, 2, 'saved');
end $$;

-- The company's login (connection b3, binding b1, a native subscription on the company's compute identity c1), and a
-- hand-built leased human run of Ada's for the contributor, with its runner, assignment, native lease, reservation,
-- model policy and budget row, as 648's (its session row included: a run's grant check needs one). Foreign keys and
-- triggers are off only while the rows go in.
set session_replication_role = replica;
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
values ('80000000-0000-4000-8000-0000000000c1', '80000000-0000-4000-8000-000000000010', 'company', extensions.gen_random_uuid(),
	'Vault order identity');
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
	encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
values ('80000000-0000-4000-8000-0000000000c2', '80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-0000000000c1', 'company',
	'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64), '80000000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('80000000-0000-4000-8000-0000000000b3', '80000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai',
	'80000000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
	consent_version, consented_by_user_id, allow_autonomous, created_by_user_id, credential_capsule_id, max_native_concurrency,
	quota_policy)
values ('80000000-0000-4000-8000-0000000000b3', 1, 'native_subscription', 'codex-cli', 'subscription', 'fixture',
	'80000000-0000-4000-8000-000000000001', true, '80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-0000000000c2', 8,
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('80000000-0000-4000-8000-0000000000b1', '80000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'80000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	allow_autonomous, created_by_user_id)
values ('80000000-0000-4000-8000-0000000000b1', 1, 'company_service_account', '80000000-0000-4000-8000-0000000000b3', 1, true,
	'80000000-0000-4000-8000-000000000001');
do $$
declare
	v_profile uuid := '80000000-0000-4000-8000-000000000010'; v_env uuid := '80000000-0000-4000-8000-000000000020';
	v_staff uuid := '80000000-0000-4000-8000-000000000030'; v_requester uuid := '80000000-0000-4000-8000-000000000002';
	v_run uuid := '80000000-0000-4000-8000-0000000000f1'; v_job uuid := '80000000-0000-4000-8000-0000000000f2';
	v_wake uuid := '80000000-0000-4000-8000-0000000000f3'; v_runner uuid := '80000000-0000-4000-8000-0000000000f4';
	v_assignment uuid := '80000000-0000-4000-8000-0000000000f5'; v_lease uuid := '80000000-0000-4000-8000-0000000000f6';
	v_session uuid := '80000000-0000-4000-8000-0000000000f7'; v_input uuid := '80000000-0000-4000-8000-0000000000f8';
	v_bundle uuid := '80000000-0000-4000-8000-0000000000f9';
	v_identity uuid := '80000000-0000-4000-8000-0000000000c1'; v_capsule uuid := '80000000-0000-4000-8000-0000000000c2';
	v_connection uuid := '80000000-0000-4000-8000-0000000000b3'; v_binding uuid := '80000000-0000-4000-8000-0000000000b1';
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
		v_staff, 1, v_binding, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester,
		'openai', 'gpt-test', 'provider_default', 'company', v_bundle, repeat('b', 64), v_session, array[v_input], v_identity);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, v_binding, 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values (v_runner, v_profile, v_runner, 'Vault order runner', '["agent_turn"]', 'active', repeat('e', 64),
		clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour', v_requester, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, extensions.gen_random_uuid(), v_job, v_run, v_runner, repeat('e', 64), 'accepted',
		clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run, v_job, v_connection, 1, v_capsule, v_identity, v_runner, v_assignment, repeat('d', 64),
		clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run, v_job, v_profile, v_binding, 1, v_connection, 1, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_job, v_profile, v_env, '["gpt-test"]', 32, 1000, 1000, v_requester);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run);
end $$;
set session_replication_role = origin;
select set_config('qorpera_test.cs_binding', jsonb_build_object('leaseId','80000000-0000-4000-8000-0000000000f6',
	'runId','80000000-0000-4000-8000-0000000000f1','jobId','80000000-0000-4000-8000-0000000000f2',
	'runnerId','80000000-0000-4000-8000-0000000000f4','assignmentId','80000000-0000-4000-8000-0000000000f5',
	'credentialCapsuleId','80000000-0000-4000-8000-0000000000c2','computeIdentityId','80000000-0000-4000-8000-0000000000c1',
	'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, false) \g /dev/null

-- The vault, as 850's: the company's broker (040) and another company's (041); two company Gmail connections, 052 for
-- the race and 054 for every single call; Ada's grant on 052 (062) and Bea's on 054 (065); and a pending capture
-- ticket of the company's broker (070, a first capture the owner started).
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('80000000-0000-4000-8000-000000000040', '80000000-0000-4000-8000-000000000010', 'https://broker.example.test', 'test', repeat('a', 64)),
	('80000000-0000-4000-8000-000000000041', '80000000-0000-4000-8000-000000000011', 'https://broker.example.test', 'other', repeat('e', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id, connector_id,
	secret_name, purpose, current_version, created_by_user_id)
select secret.id, '80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', '80000000-0000-4000-8000-000000000040',
	'company', null, 'gmail', secret.name, 'Gmail account', 1, '80000000-0000-4000-8000-000000000001'
from (values ('80000000-0000-4000-8000-000000000052'::uuid, 'primary'), ('80000000-0000-4000-8000-000000000054'::uuid, 'single-grants'))
	as secret(id, name);
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
select secret.id, 1, secret.broker_authority_id, 'test', decode('abcd', 'hex'), repeat('b', 64), secret.created_by_user_id
from public.qorpera_cloud_secrets as secret where secret.profile_id = '80000000-0000-4000-8000-000000000010';
insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
	operation_id, operation_version, tool_name, issued_by_user_id)
select grant_row.id, '80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', grant_row.secret_id,
	grant_row.agent, operation.connector_id, operation.operation_id, operation.version, operation.tool_name,
	'80000000-0000-4000-8000-000000000001'
from (values ('80000000-0000-4000-8000-000000000062'::uuid, '80000000-0000-4000-8000-000000000052'::uuid,
		'80000000-0000-4000-8000-000000000030'::uuid),
	('80000000-0000-4000-8000-000000000065'::uuid, '80000000-0000-4000-8000-000000000054'::uuid,
		'80000000-0000-4000-8000-000000000031'::uuid)) as grant_row(id, secret_id, agent)
join public.qorpera_cloud_connector_operations as operation on operation.connector_id = 'gmail'
	and operation.operation_id = 'search_messages' and operation.status = 'active';
insert into public.qorpera_cloud_secret_capture_tickets(id, profile_id, environment_id, broker_authority_id, key_id, secret_id,
	target_version, owner_kind, owner_user_id, connector_id, secret_name, purpose, capture_capability_sha256, created_by_user_id,
	expires_at)
values ('80000000-0000-4000-8000-000000000070', '80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020',
	'80000000-0000-4000-8000-000000000040', 'test', '80000000-0000-4000-8000-000000000058', 1, 'company', null, 'gmail', 'other-broker',
	'Gmail account', repeat('7', 64), '80000000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour');
-- The run's grant check works before any race.
select (public.qorpera_native_connector_locked_grant(current_setting('qorpera_test.cs_binding')::jsonb,
	'80000000-0000-4000-8000-000000000062')).id \g /dev/null

-- Three more connections: the holder (cs_hold, which acts for the owner when it changes a role) and two callers.
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['cs_hold','cs_one','cs_two']) name \g /dev/null
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['cs_one','cs_two']) name \g /dev/null
select dblink_exec('cs_hold', format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', '80000000-0000-4000-8000-000000000001')::text)) \g /dev/null
select set_config('qorpera_test.cs_pid_' || name, pid::text, false)
from unnest(array['cs_hold','cs_one','cs_two']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer) \g /dev/null

-- A connection acts as a member (PostgREST's role and claims), as the broker's own login, or as the native host
-- (service-role claims on the database owner's login, which alone may call the run's grant check).
create function pg_temp.cs_as(p_conn text, p_mode text, p_user uuid) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset session authorization');
	perform dblink_exec(p_conn, 'reset role');
	if p_mode = 'broker' then
		perform dblink_exec(p_conn, 'set session authorization qorpera_secret_broker');
	elsif p_mode = 'member' then
		perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
			jsonb_build_object('role', 'authenticated', 'sub', p_user)::text));
		perform dblink_exec(p_conn, 'set role authenticated');
	else
		perform dblink_exec(p_conn, $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	end if;
end $$;
-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.cs_collect(p_conn text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_conn) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_conn, false) as call(result jsonb);
	return v_outcome;
end $$;
create function pg_temp.cs_blocked_by(p_waiter text, p_holder text) returns boolean language sql as $$
	select current_setting('qorpera_test.cs_pid_' || p_holder)::integer
		= any (pg_blocking_pids(current_setting('qorpera_test.cs_pid_' || p_waiter)::integer))
$$;
-- Whether a connection comes to wait for another (60 s at most), and whether it waits at a row of a table: it holds or
-- queues for that row's tuple lock while blocked (665's).
create function pg_temp.cs_waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if pg_temp.cs_blocked_by(p_waiter, p_holder) then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.cs_waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.cs_pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- The holder keeps the company row FOR UPDATE while one call runs on cs_one: the call's result or error, and whether
-- it waited for the holder. With p_demote, the holder (for the owner) makes that
-- member a contributor through the real role change while the call waits, and commits.
create function pg_temp.cs_single(p_call text, p_mode text, p_user uuid, p_demote uuid default null) returns jsonb language plpgsql as $$
declare v_waited boolean := false; v_outcome jsonb;
begin
	perform dblink_exec('cs_hold', 'begin');
	perform * from dblink('cs_hold', $q$select 1 from public.qorpera_profiles where id = '80000000-0000-4000-8000-000000000010'
		for update$q$) as held(x integer);
	perform pg_temp.cs_as('cs_one', p_mode, p_user);
	perform dblink_send_query('cs_one', p_call);
	for attempt in 1..200 loop
		if pg_temp.cs_blocked_by('cs_one', 'cs_hold') then v_waited := true; exit; end if;
		exit when dblink_is_busy('cs_one') = 0;
		perform pg_sleep(0.025);
	end loop;
	-- A call still running that never waited proves nothing either way.
	if not v_waited and dblink_is_busy('cs_one') = 1 then
		perform dblink_exec('cs_hold', 'rollback');
		raise exception 'The call neither waited nor finished: %', pg_temp.cs_collect('cs_one');
	end if;
	if p_demote is not null and v_waited then
		begin
			perform * from dblink('cs_hold', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
				'80000000-0000-4000-8000-000000000010', p_demote, 'contributor')) as changed(member jsonb);
		exception when others then
			perform dblink_exec('cs_hold', 'rollback');
			raise exception 'The demotion: % %; the call: %', sqlstate, sqlerrm, pg_temp.cs_collect('cs_one');
		end;
		perform dblink_exec('cs_hold', 'commit');
	else
		perform dblink_exec('cs_hold', 'rollback');
	end if;
	v_outcome := pg_temp.cs_collect('cs_one') || jsonb_build_object('waited', v_waited);
	perform pg_temp.cs_as('cs_one', 'host', null);
	return v_outcome;
end $$;
-- The calls.
create function pg_temp.cs_disconnect(p_secret uuid) returns text language sql as $$
	select format('select public.qorpera_revoke_cloud_secret(%L, %L)', '80000000-0000-4000-8000-000000000010', p_secret)
$$;
create function pg_temp.cs_grant(p_secret uuid, p_agent uuid, p_operation text) returns text language sql as $$
	select format('select public.qorpera_grant_cloud_secret_operation(%L, %L, %L, %L, %L, %L, 1, null)',
		'80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', p_secret, p_agent, 'gmail', p_operation)
$$;
create function pg_temp.cs_withdraw(p_grant uuid) returns text language sql as $$
	select format('select public.qorpera_revoke_cloud_secret_grant(%L, %L)', '80000000-0000-4000-8000-000000000010', p_grant)
$$;
create function pg_temp.cs_share(p_secret uuid, p_agent uuid) returns text language sql as $$
	select format('select public.qorpera_grant_cloud_connector(%L, %L, %L, array[%L]::uuid[])',
		'80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', p_secret, p_agent)
$$;
create function pg_temp.cs_rotate(p_secret uuid, p_name text) returns text language sql as $$
	select format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, null, %L, %L, %L, %L)',
		'80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', 'company', 'gmail', p_name, 'Gmail account', p_secret)
$$;
-- A member rotating the company's connection named as their own.
create function pg_temp.cs_rotate_own(p_secret uuid, p_name text, p_user uuid) returns text language sql as $$
	select format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, %L, %L, %L, %L, %L)',
		'80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000020', 'member', p_user, 'gmail', p_name, 'Gmail account',
		p_secret)
$$;

-- 1. Refused at once while the company row is held: someone outside the company and a contributor, for each function;
--    the viewer's Disconnect and share; and a contributor or an admin rotating the company's connection named as their
--    own (757's §9).
do $$
declare
	v_outsider uuid := '80000000-0000-4000-8000-000000000005'; v_contributor uuid := '80000000-0000-4000-8000-000000000002';
	v_viewer uuid := '80000000-0000-4000-8000-000000000004'; v_admin uuid := '80000000-0000-4000-8000-000000000003';
	v_who text; v_call text; v_user uuid; v_state text; v_error text; v_outcome jsonb;
begin
	for v_who, v_call, v_user, v_state, v_error in values
		('outsider Disconnect', pg_temp.cs_disconnect('80000000-0000-4000-8000-000000000054'), v_outsider,
			'42501', 'secret revocation is unavailable'),
		('contributor Disconnect', pg_temp.cs_disconnect('80000000-0000-4000-8000-000000000054'), v_contributor,
			'42501', 'secret revocation is unavailable'),
		('viewer Disconnect', pg_temp.cs_disconnect('80000000-0000-4000-8000-000000000054'), v_viewer,
			'42501', 'secret revocation is unavailable'),
		('viewer share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031'), v_viewer,
			'42501', 'secret grant authority is unavailable'),
		('contributor rotation as their own', pg_temp.cs_rotate_own('80000000-0000-4000-8000-000000000054', 'single-grants', v_contributor),
			v_contributor, '42501', 'secret rotation authority is unavailable'),
		('admin rotation as their own', pg_temp.cs_rotate_own('80000000-0000-4000-8000-000000000054', 'single-grants', v_admin),
			v_admin, '42501', 'secret rotation authority is unavailable'),
		('outsider grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031', 'read_message'),
			v_outsider, '42501', 'secret grant authority is unavailable'),
		('contributor grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031', 'read_message'),
			v_contributor, '42501', 'secret grant authority is unavailable'),
		('outsider grant withdrawal', pg_temp.cs_withdraw('80000000-0000-4000-8000-000000000065'), v_outsider,
			'42501', 'secret grant revocation is unavailable'),
		('contributor grant withdrawal', pg_temp.cs_withdraw('80000000-0000-4000-8000-000000000065'), v_contributor,
			'42501', 'secret grant revocation is unavailable'),
		('outsider share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031'), v_outsider,
			'42501', 'secret grant authority is unavailable'),
		('contributor share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031'), v_contributor,
			'42501', 'secret grant authority is unavailable'),
		('outsider rotation', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000054', 'single-grants'), v_outsider,
			'42501', 'secret capture requires company write access'),
		('contributor rotation', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000054', 'single-grants'), v_contributor,
			'22023', 'secret capture scope is invalid')
	loop
		v_outcome := pg_temp.cs_single(v_call, 'member', v_user);
		perform pg_temp.cs_check(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = v_state and v_outcome ->> 'error' = v_error,
			format('1: %s waited for the company row or was not refused as before: %s', v_who, v_outcome));
	end loop;
end $$;
-- Another company's broker sealing this company's ticket takes no lock on this company's row.
select pg_temp.cs_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '42501'
		and outcome ->> 'error' = 'cloud secret capture is unavailable',
	'1: another company''s broker waited for the company row or was not refused: ' || outcome::text)
from (select pg_temp.cs_single(format('select public.qorpera_complete_cloud_secret_capture(%L, %L, %L, %L, %L, %L, null)',
	'80000000-0000-4000-8000-000000000041', repeat('e', 64), '80000000-0000-4000-8000-000000000070', repeat('0', 64),
	encode('\x0506'::bytea, 'base64'), encode(extensions.digest('\x0506'::bytea, 'sha256'), 'hex')), 'broker', null) as outcome) as single;

-- 2. An admin who loses the role while the call waits for the company row is refused after it (the holder, for the
--    owner, makes them a contributor and commits); the owner makes them an admin again before the next call.
do $$
declare v_admin uuid := '80000000-0000-4000-8000-000000000003'; v_who text; v_call text; v_error text; v_outcome jsonb;
begin
	for v_who, v_call, v_error in values
		('Disconnect', pg_temp.cs_disconnect('80000000-0000-4000-8000-000000000054'), 'secret revocation is unavailable'),
		('grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031', 'read_message'),
			'secret grant authority is unavailable'),
		('grant withdrawal', pg_temp.cs_withdraw('80000000-0000-4000-8000-000000000065'), 'secret grant revocation is unavailable'),
		('share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054', '80000000-0000-4000-8000-000000000031'),
			'secret grant authority is unavailable')
	loop
		v_outcome := pg_temp.cs_single(v_call, 'member', v_admin, v_admin);
		perform pg_temp.cs_check(v_outcome ->> 'waited' = 'true' and v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = v_error,
			format('2: %s: an admin who lost the role while waiting was not refused: %s', v_who, v_outcome));
		perform * from dblink('cs_hold', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
			'80000000-0000-4000-8000-000000000010', v_admin, 'admin')) as changed(member jsonb);
	end loop;
end $$;
-- Nothing of 054 changed: the refused calls left its grant and the connection as they were.
select pg_temp.cs_check((select status from public.qorpera_cloud_secrets where id = '80000000-0000-4000-8000-000000000054') = 'active'
	and (select status from public.qorpera_cloud_secret_operation_grants where id = '80000000-0000-4000-8000-000000000065') = 'active'
	and (select count(*) from public.qorpera_cloud_secret_operation_grants where secret_id = '80000000-0000-4000-8000-000000000054') = 1
	and (select role::text from public.qorpera_profile_members where profile_id = '80000000-0000-4000-8000-000000000010'
		and user_id = '80000000-0000-4000-8000-000000000003') = 'admin',
	'1, 2: a refused call changed the connection or its grants, or the admin was not restored');

-- 3. A withdrawal against an agent call on its grant (800's old §4): the holder keeps the secret; the run's grant check
--    takes the grant FOR SHARE and waits for the secret; the owner's withdrawal of that grant waits for the call at the
--    grant, holding nothing the call needs. The holder lets go: the call returns its grant, then the withdrawal lands.
do $$
declare v_call jsonb; v_withdrawal jsonb;
begin
	perform dblink_exec('cs_hold', 'begin');
	perform * from dblink('cs_hold', $q$select 1 from public.qorpera_cloud_secrets where id = '80000000-0000-4000-8000-000000000052'
		for update$q$) as held(x integer);
	perform dblink_send_query('cs_one', format('select to_jsonb((public.qorpera_native_connector_locked_grant(%L, %L)).id)',
		current_setting('qorpera_test.cs_binding'), '80000000-0000-4000-8000-000000000062'));
	if not pg_temp.cs_waits_for('cs_one', 'cs_hold') or not pg_temp.cs_waits_at('cs_one', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('cs_hold', 'rollback');
		raise exception '3: the agent call must wait for the held secret: %', pg_temp.cs_collect('cs_one'); end if;
	perform pg_temp.cs_as('cs_two', 'member', '80000000-0000-4000-8000-000000000001');
	perform dblink_send_query('cs_two', pg_temp.cs_withdraw('80000000-0000-4000-8000-000000000062'));
	if not pg_temp.cs_waits_for('cs_two', 'cs_one') or not pg_temp.cs_waits_at('cs_two', 'public.qorpera_cloud_secret_operation_grants') then
		perform dblink_exec('cs_hold', 'rollback');
		raise exception '3: the withdrawal must wait for the agent call at its grant: %, %', pg_temp.cs_collect('cs_one'),
			pg_temp.cs_collect('cs_two'); end if;
	perform dblink_exec('cs_hold', 'rollback');
	v_call := pg_temp.cs_collect('cs_one');
	v_withdrawal := pg_temp.cs_collect('cs_two');
	perform pg_temp.cs_as('cs_two', 'host', null);
	perform pg_temp.cs_check(v_call ->> 'result' = '80000000-0000-4000-8000-000000000062' and v_withdrawal #>> '{result,status}' = 'revoked',
		format('3: an agent call and the withdrawal of its grant did not both land: %s, %s', v_call, v_withdrawal));
end $$;
-- Read in a statement of its own, after the calls (a subquery in the same statement would read the old row).
select pg_temp.cs_check((select status from public.qorpera_cloud_secret_operation_grants where id = '80000000-0000-4000-8000-000000000062')
	= 'revoked', '3: the withdrawn grant is not revoked');

select dblink_disconnect(name) from unnest(array['cs_hold','cs_one','cs_two']) name \g /dev/null

-- Remove the fixture (916's way): every row of the two companies and the environment, their runs, jobs, sessions and
-- rooms, the login, the vault, the objects and the users.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['80000000-0000-4000-8000-000000000020']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	delete from public.qorpera_cloud_secret_audit_events where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_operation_grants where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_capture_tickets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_versions where secret_id in
		(select id from public.qorpera_cloud_secrets where profile_id = any (v_profiles));
	delete from public.qorpera_cloud_secrets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_broker_authorities where id in
		('80000000-0000-4000-8000-000000000040', '80000000-0000-4000-8000-000000000041');
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' and c.table_name not in ('qorpera_profiles', 'qorpera_profile_objects') loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '80000000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '80000000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
end $$;
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway, so they go by hand (805's).
delete from public.qorpera_profile_objects where profile_id = '80000000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '80000000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id in ('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000011');
delete from auth.users where id in ('80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002',
	'80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000005');
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id in ('80000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000011'))
		or exists (select 1 from public.qorpera_company_files where environment_id = '80000000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secrets where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secret_broker_authorities where id in ('80000000-0000-4000-8000-000000000040',
			'80000000-0000-4000-8000-000000000041'))
		or exists (select 1 from storage.objects where name like '80000000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '80000000-0000-4000-8000-000000000010')
		or exists (select 1 from auth.users where id in ('80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002',
			'80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000005')) then
		raise exception 'The race fixture must be removed'; end if;
end $$;
