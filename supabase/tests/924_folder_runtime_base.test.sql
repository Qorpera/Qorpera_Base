-- The folder-v2 runtime base (legacy sweep B1): the shared fixture that replaces 300_runtime_wake_bus. A company on the
-- company folder with an owner, a contributor, a viewer, an admin and an outsider; the platform's creation commit, then
-- agents Alice, Bob and Carol hired through their agent.md in the owner's commit, each with its thread, converged by the
-- follow-up queue; the owner's native login (consented for unattended work) and member sponsor; the owner's post in Alice's
-- thread, turned into a run by the folder materializer, then claimed, provisioned, assigned and leased through the real
-- orchestrator and native lease contracts, with no hand-built run. Tests that run after this file's fixture part reuse
-- its rows and its helpers (`base_*`): a commit with the queue run after it, a hire, starting any queued run on a real
-- runner with a lease, a member's post in a thread, the materializer pass, the public send. Everything up to the marker
-- below is the fixture.
begin;

insert into auth.users(id, email) values
	('92400000-0000-4000-8000-000000000001', 'base-owner@example.test'),
	('92400000-0000-4000-8000-000000000002', 'base-member@example.test'),
	('92400000-0000-4000-8000-000000000003', 'base-viewer@example.test'),
	('92400000-0000-4000-8000-000000000004', 'base-admin@example.test'),
	('92400000-0000-4000-8000-000000000005', 'base-outsider@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('92400000-0000-4000-8000-000000000010', 'Folder runtime base', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test', 'Owner', 'owner'),
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000002', 'base-member@example.test', 'Member', 'contributor'),
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000003', 'base-viewer@example.test', 'Viewer', 'viewer'),
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000004', 'base-admin@example.test', 'Admin', 'admin');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000001');

create function pg_temp.base_claims(p_role text, p_user uuid default null) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text, true)::text::void
$$;

select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('92400000-0000-4000-8000-000000000020') \g /dev/null
-- Disposable policy fixture only; no hosted provider or deployment is used.
select public.qorpera_set_provider_execution_policy('openai', 'native_subscription', 'codex-cli', 'supported', 'enabled', 32, null,
	'folder-runtime-base') \g /dev/null

-- BEGIN BASE HELPERS
create function pg_temp.base_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Base assertion: %', p_message; end if; end
$$;
create function pg_temp.base_error(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % %, got %: %', p_state, coalesce('with message ' || p_message, ''), sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE %, call succeeded', p_state;
end
$$;
create function pg_temp.base_owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}'::jsonb
$$;
-- Verified version-2 bytes for a text, as the object gateway leaves them (as 700 makes them).
create function pg_temp.base_manifest(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an upload for a manifest as the actor, confirms each object the open did not report present, and seals it.
create function pg_temp.base_seal(p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload('92400000-0000-4000-8000-000000000020', p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object('92400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid,
				v_object ->> 'sha256', (v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload('92400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid);
end
$$;
-- The platform stages a text; answers the file reference a unit carries.
create function pg_temp.base_stage(p_text text) returns jsonb language plpgsql as $$
declare v_seal jsonb := pg_temp.base_seal('{"kind":"platform"}', pg_temp.base_manifest(p_text));
begin
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end
$$;
-- A structured write as the TS parser sends it, over the version read.
create function pg_temp.base_write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('op', 'write', 'path', p_path, 'file', pg_temp.base_stage(p_text), 'structured', jsonb_build_array(
		jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.base_version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '92400000-0000-4000-8000-000000000020' and key_text = p_path
$$;
create function pg_temp.base_agent_text(p_id uuid, p_name text, p_kind text default 'agent') returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Research\nkind: %s\nstatus: active\n---\nRead and change the company folder.\n',
		p_id, p_name, p_kind)
$$;
-- A new agent folder with its agent.md, as one unit.
create function pg_temp.base_hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op', 'new_folder', 'path', 'agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path', 'agent.md', 'kind', 'file', 'file', pg_temp.base_stage(pg_temp.base_agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path', 'memory', 'kind', 'folder'), jsonb_build_object('path', 'routines', 'kind', 'folder'),
			jsonb_build_object('path', 'todos', 'kind', 'folder')),
		'structured', jsonb_build_array(jsonb_build_object('path', 'agents/' || p_handle || '/agent.md', 'kind', 'agent',
			'text', pg_temp.base_agent_text(p_id, p_name, p_kind), 'parserVersion', 1,
			'parse', jsonb_build_object('kind', 'agent', 'id', p_id, 'name', p_name, 'role', 'Research', 'agentKind', p_kind,
				'status', 'active', 'colour', null, 'figure', null, 'model', null, 'effort', null,
				'instructions', 'Read and change the company folder.'))))
$$;
-- The follow-up queue's step as its job runs it (the database owner, no JWT), until it converges nothing.
create function pg_temp.base_follow_ups() returns void language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v jsonb; i integer;
begin
	perform set_config('request.jwt.claims', '', true);
	for i in 1..30 loop
		v := public.qorpera_folder_follow_up_step();
		exit when v -> 'converged' is null or v -> 'converged' = 'null'::jsonb;
		perform pg_temp.base_assert(v #>> '{converged,result}' = 'done', 'a follow-up converges: ' || v::text);
	end loop;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end
$$;
-- A commit as its actor, after the actor has taken possession of its files as its own upload would; then the
-- follow-up queue runs, as its step would. Every unit must save.
create function pg_temp.base_commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_manifest text; v_result jsonb;
begin
	if p_actor ->> 'kind' is distinct from 'platform' then
		for v_manifest in select distinct i.manifest_text from jsonb_array_elements(p_units) u
			cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
				case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
			join public.qorpera_folder_upload_intents i on i.environment_id = '92400000-0000-4000-8000-000000000020'
				and i.manifest_sha256 = refs.f ->> 'manifestSha256'
			where refs.f is not null loop
			perform pg_temp.base_seal(p_actor, v_manifest);
		end loop;
	end if;
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved'),
		'the commit saves: ' || v_result::text);
	perform pg_temp.base_follow_ups();
	return v_result;
end
$$;
-- An agent's thread room.
create function pg_temp.base_thread(p_staff uuid) returns uuid language sql as $$
	select id from public.qorpera_company_rooms where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- A member's post in an agent's thread, paid by the owner's sponsor unless another binding is named (a post can only
-- spend the poster's own sponsor); answers the post's wake ids.
create function pg_temp.base_post(p_user uuid, p_staff uuid, p_text text, p_binding uuid default null, p_version bigint default 1)
returns jsonb language plpgsql as $$
declare v_post jsonb; v_claims text := current_setting('request.jwt.claims', true); v_room uuid := pg_temp.base_thread(p_staff);
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_post := public.qorpera_post_company_room_message(v_room, extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		coalesce(p_binding, (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid), p_version);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_post -> 'occurrenceIds';
end
$$;
-- One materializer pass for the company, as its own transaction would start it.
create function pg_temp.base_materialize(p_limit integer default 16) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company('92400000-0000-4000-8000-000000000010', p_limit);
end
$$;
-- Starts a queued run on a real runner with a lease, through orchestrator …092; answers its native binding. NULL
-- accepts the queue's own choice.
create function pg_temp.base_start(p_run uuid) returns jsonb language plpgsql as $$
declare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
	p_run := coalesce(p_run, (v_claim #>> '{work,run_id}')::uuid);
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = p_run::text, 'Wrong base run selected: ' || coalesce(v_claim::text, 'none'));
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'base-fixture');
	v_assignment := public.qorpera_assign_runner_job('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid, extensions.gen_random_uuid(), repeat('3', 64), 120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, (v_claim #>> '{work,job_id}')::uuid, repeat('3', 64));
	v_lease := public.qorpera_acquire_native_provider_connection_lease(p_run, (v_runner ->> 'runner_id')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, repeat('3', 64), 120);
	-- The binding names the model the run pinned, as the runner reads it from its job.
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
	return jsonb_build_object('leaseId', v_lease ->> 'lease_id', 'runId', p_run, 'jobId', v_claim #>> '{work,job_id}',
		'runnerId', v_runner ->> 'runner_id', 'assignmentId', v_assignment ->> 'assignment_id',
		'credentialCapsuleId', v_lease ->> 'credential_capsule_id', 'computeIdentityId', v_lease ->> 'compute_identity_id',
		'provider', v_run.model_provider, 'nativeHarness', 'codex-cli', 'model', v_run.model_id);
end
$$;
-- The run's public message in its conversation (an acknowledgement or the final report).
create function pg_temp.base_public_send(p_binding jsonb, p_phase text, p_key text default null) returns jsonb language sql as $$
	select public.qorpera_send_native_agent_message((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli',
		coalesce(p_key, p_phase), 'A material result or acknowledgement.', p_phase)
$$;
-- END BASE HELPERS

-- The company's creation commit, as the platform seeds it, then the owner hires Alice, Bob and Carol. The queue
-- converges each hire before the owner has a login, so their first runs stay the owner's to start (877 §4).
select pg_temp.base_commit('{"kind":"platform"}', 'base-seed', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'vision'),
	pg_temp.base_write('vision/vision.md', 'vision', E'# Folder runtime base\n\n## What we build\n',
		'{"kind":"vision","name":"Folder runtime base"}', pg_temp.base_version('vision/vision.md')),
	jsonb_build_object('op', 'mkdir', 'path', 'agents'),
	pg_temp.base_write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.base_hire('co-founder', '92400000-0000-4000-8000-000000000033', 'Co-Founder', 'co-founder'))) \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'base-hire', jsonb_build_array(
	pg_temp.base_hire('alice', '92400000-0000-4000-8000-000000000030', 'Alice'),
	pg_temp.base_hire('bob', '92400000-0000-4000-8000-000000000031', 'Bob'),
	pg_temp.base_hire('carol', '92400000-0000-4000-8000-000000000032', 'Carol'))) \g /dev/null

-- The owner's native login, consented for unattended work, and their member sponsor (as 300 makes them).
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.base_identity', public.qorpera_upsert_member_compute_identity(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000050', 'Base identity', 'qorpera-member-linux', 'v1',
	'["agent_turn"]', '{"network":"provider-native-only","credentialExport":false}')::text, true) \g /dev/null
select set_config('qorpera_test.base_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000051', '92400000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('a', 64), 900)::text,
	true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.base_connection', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.base_login')::jsonb ->> 'login_id')::uuid, repeat('a', 64), '92400000-0000-4000-8000-000000000060',
	'object://native-capsules/92400000-0000-4000-8000-000000000060', repeat('b', 64), 'fixture-openai-account', 'personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,
	true) \g /dev/null
reset role;
-- The pinned baseline has no native autonomous-consent producer: a consented immutable version, in this fixture only.
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.base_sponsor', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 2, true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

-- The owner's post in Alice's thread becomes a run in one materializer pass; the real orchestrator claims it and the
-- native lease binds it.
select public.qorpera_register_runner_orchestrator('92400000-0000-4000-8000-000000000092', 'Base fixture', 'process', repeat('0', 64), 3600)
\g /dev/null
do $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030',
	'Update the company note.'); v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_wakes) = 1, 'the post wakes Alice once: ' || v_wakes::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'the post is materialized: ' || v_pass::text);
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform set_config('qorpera_test.base_binding', pg_temp.base_start(v_run)::text, true);
end
$$;
select pg_temp.base_claims('service_role');

-- The checks start here: a test that runs after this file's fixture part stops at this line.

-- 1. The base itself: a folder-v2 company, its agents' threads, and a run of Alice's that holds a real native lease, with
--    no substrate or snapshot (the folder clock's pin).
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_assert(public.qorpera_company_is_folder_v2('92400000-0000-4000-8000-000000000010'), 'the company is folder-v2');
	perform pg_temp.base_assert(pg_temp.base_thread('92400000-0000-4000-8000-000000000030') is not null
		and pg_temp.base_thread('92400000-0000-4000-8000-000000000031') is not null
		and pg_temp.base_thread('92400000-0000-4000-8000-000000000032') is not null, 'each agent has its thread');
	-- Each hire is the roster's index of its agent.md, and its kickoff waits for the owner, with no turn queued.
	perform pg_temp.base_assert((select count(*) from public.qorpera_profile_staff staff
		join public.qorpera_agent_first_runs first_run on first_run.profile_id = staff.profile_id and first_run.staff_agent_id = staff.staff_agent_id
		join public.qorpera_session_inputs kickoff on kickoff.id = first_run.input_id
		where staff.profile_id = '92400000-0000-4000-8000-000000000010' and staff.employment_status = 'active'
			and staff.staff_agent_id in ('92400000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000031',
				'92400000-0000-4000-8000-000000000032')
			and pg_temp.base_version('agents/' || lower(staff.display_name) || '/agent.md') is not null
			and kickoff.author_user_id = '92400000-0000-4000-8000-000000000001'
			and not exists (select 1 from public.qorpera_session_turn_requests turn where turn.input_id = kickoff.id)) = 3,
		'the hires are indexed, and their kickoffs wait');
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_runs
		where profile_id = '92400000-0000-4000-8000-000000000010') = 1, 'the post''s run is the company''s only run');
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.base_assert(v_run.staff_agent_id = '92400000-0000-4000-8000-000000000030' and v_run.substrate_version_id is null
		and v_run.company_snapshot_id is null and v_run.company_seq is not null, 'Alice''s run pins the folder clock: ' || to_jsonb(v_run)::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_native_provider_connection_leases
		where id = (v_binding ->> 'leaseId')::uuid and run_id = v_run.id), 'the run holds a native lease');
	perform pg_temp.base_assert((select status from public.qorpera_runner_jobs where id = v_run.job_id) = 'leased', 'the job is leased');
	-- The binding is the one the native tool host checks, as it is: any binding-based folder tool takes it.
	perform pg_temp.base_assert((public.qorpera_native_tool_locked_run(v_binding)).id = v_run.id,
		'the binding passes the native tool guard: ' || v_binding::text);
end
$$;

-- 2. The run acts as itself: its acknowledgement, then its final report, land in Alice's thread.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_public_send(v_binding, 'progress', 'base-ack');
	perform pg_temp.base_public_send(v_binding, 'final', 'base-final');
	perform pg_temp.base_assert((select count(*) from public.qorpera_agent_sends where run_id = (v_binding ->> 'runId')::uuid) = 2,
		'both sends are recorded');
end
$$;

-- 3. A second post, in Bob's thread, is answered by the next pass, and the queue's next run (NULL: the queue's own choice) starts
--    on its own runner with its own lease.
do $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
	'Look at the numbers.'); v_pass jsonb; v_binding jsonb; v_first jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'Bob''s run: ' || v_pass::text);
	v_binding := pg_temp.base_start(null);
	perform pg_temp.base_assert(v_binding ->> 'runId' = v_pass -> 'run_ids' ->> 0
		and v_binding ->> 'runnerId' <> v_first ->> 'runnerId' and v_binding ->> 'leaseId' <> v_first ->> 'leaseId', 'Bob''s run starts');
end
$$;

-- 4. A post spends only the poster's own sponsor: the contributor can't post on the owner's.
select pg_temp.base_error($$select pg_temp.base_post('92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000032',
	'Hello.')$$, '42501', 'Room sponsor is unavailable');

-- Sections 5 to 16 are 300_runtime_wake_bus's checks on folder-v2 (ported from snapshot-v1 in the legacy sweep): wake
-- policies and silence; a room wake's and a first run's obligations; a first run its sponsor denies; a routine's reply
-- policy, reporting and audience, at admission and pinned; a coworker message and its chain; a recipient archived before
-- its run; a failed delivery tried again; and the agent-edit rules. Their helpers are wb_*. Runs come from posts, kickoffs,
-- routine files and coworker messages through the folder materializer, and start through base_start.

-- An agent's thread conversation.
create function pg_temp.wb_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;
create function pg_temp.wb_every(p_minutes integer default 5) returns jsonb language sql as $$
	select jsonb_build_object('when', 'every', 'minutes', p_minutes, 'starts', null)
$$;
-- A routine's parse as the TS parser returns it (as 708 makes it).
create function pg_temp.wb_rparse(p_id uuid, p_title text, p_trigger jsonb, p_reply text default 'optional') returns jsonb
language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', p_title, 'status', 'active', 'trigger', p_trigger,
		'timezone', case when p_trigger ->> 'when' = 'every' then null else 'Europe/Copenhagen' end, 'ends', null, 'runs', null,
		'quiet', null, 'effort', 'medium', 'reply', p_reply, 'conclusion', null, 'instructions', 'Examine the authorized change.')
$$;
create function pg_temp.wb_routine(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.base_write(p_path, 'routine', E'---\n' || p_parse::text || E'\n---\n', p_parse, pg_temp.base_version(p_path))
$$;
-- An agent.md saved over the version read: a rename, new instructions, another role or status is an agent edit.
create function pg_temp.wb_agent(p_handle text, p_id uuid, p_name text, p_instructions text, p_status text default 'active',
	p_role text default 'Research') returns jsonb language sql as $$
	select pg_temp.base_write('agents/' || p_handle || '/agent.md', 'agent',
		format(E'---\nid: %s\nname: %s\nrole: %s\nkind: agent\nstatus: %s\n---\n%s\n', p_id, p_name, p_role, p_status, p_instructions),
		jsonb_build_object('kind', 'agent', 'id', p_id, 'name', p_name, 'role', p_role, 'agentKind', 'agent', 'status', p_status,
			'colour', null, 'figure', null, 'model', null, 'effort', null, 'instructions', p_instructions),
		pg_temp.base_version('agents/' || p_handle || '/agent.md'))
$$;
-- A started run as the folder commit's actor.
create function pg_temp.wb_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding -> 'runId', 'jobId', p_binding -> 'jobId',
		'runnerId', p_binding -> 'runnerId', 'assignmentId', p_binding -> 'assignmentId')
$$;
-- The scheduler offers a routine's slot at its current version's position, as the orchestrator does; answers the occurrence.
create function pg_temp.wb_slot(p_routine uuid, p_key text, p_at timestamptz default null) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_at timestamptz := coalesce(p_at, statement_timestamp() - interval '5 minutes');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	select c.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version where r.id = p_routine;
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, v_id, p_key, v_cursor.trigger_id, v_at,
		v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
	return v_id;
end
$$;
create function pg_temp.wb_wake_run(p_wake uuid) returns uuid language sql as $$
	select run_id from public.qorpera_wake_occurrences where id = p_wake
$$;
-- The owner's post in an agent's thread, materialized and started: the delivery's binding.
create function pg_temp.wb_posted(p_staff uuid, p_text text) returns jsonb language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, p_text);
	v_pass jsonb := pg_temp.base_materialize(); v_run uuid := pg_temp.wb_wake_run((v_wakes ->> 0)::uuid);
begin
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'the post is delivered: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end
$$;
create function pg_temp.wb_counts() returns bigint[] language sql as $$
	select array[(select count(*) from public.qorpera_execution_runs), (select count(*) from public.qorpera_runner_jobs),
		(select count(*) from public.qorpera_execution_sponsor_reservations)]
$$;

-- 5. Wake policies: the five kinds and their silence rule; an omitted reply never grants silence. The base run, the
--    owner's post in Alice's thread, owes its final report but no acknowledgement, and having reported (section 2) it does
--    no more work. A run with no wake keeps the initial and final obligations; repeated queued events are idempotent; a
--    room wake without its room, input, member and sponsor identity is refused.
do $$
declare v_kind text; v_policy jsonb; v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
begin
	foreach v_kind in array array['human', 'first-run', 'routine', 'agent', 'room'] loop
		v_policy := public.qorpera_wake_policy_value(v_kind, 'optional');
		perform pg_temp.base_assert(v_policy ->> 'kind' = v_kind, 'the policy''s kind: ' || v_policy::text);
		perform pg_temp.base_assert((v_policy ->> 'silenceAllowed')::boolean = (v_kind in ('routine', 'agent', 'room')),
			'the silence rule: ' || v_policy::text);
	end loop;
	perform pg_temp.base_assert(public.qorpera_wake_policy_value('routine') = public.qorpera_wake_policy_value('routine', 'required'),
		'an omitted reply never grants silence');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('room', 'required'),
		'the base run owes its final report: ' || public.qorpera_runtime_wake_policy(v_run)::text);
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_work_allowed(%L)', v_run), '55000');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(extensions.gen_random_uuid()) = public.qorpera_wake_policy_value(null),
		'a run with no wake keeps the initial and final obligations');
	insert into public.qorpera_execution_run_events(run_id, event_type) values (v_run, 'queued'), (v_run, 'queued');
	perform pg_temp.base_assert((select count(*) from public.qorpera_wake_occurrences where run_id = v_run) = 1,
		'repeated queued events are idempotent');
	perform pg_temp.base_error($q$insert into public.qorpera_wake_occurrences(profile_id, environment_id, wake_kind, source_kind,
		trigger_id, occurrence_key, scheduled_for, not_before) values ('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'room', 'room', 'room', 'room-test', now(), now())$q$, '42501', 'Wake admission is unsupported');
end
$$;

-- 6. A room wake's obligations, on a delivery of its own: it may work before any acknowledgement; an acknowledgement does
--    not end it, only its final report does; then it does no more work.
savepoint wb_room_wake;
do $$
declare v_binding jsonb := pg_temp.wb_posted('92400000-0000-4000-8000-000000000032', 'Check the numbers.');
	v_run uuid := (v_binding ->> 'runId')::uuid;
begin
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('room', 'required'),
		'a delivery in an agent''s thread owes its final report');
	perform public.qorpera_assert_wake_work_allowed(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
	perform pg_temp.base_public_send(v_binding, 'progress', 'room-ack');
	perform public.qorpera_assert_wake_work_allowed(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
	perform pg_temp.base_public_send(v_binding, 'final', 'room-final');
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_work_allowed(%L)', v_run), '55000');
end
$$;
rollback to wb_room_wake;

-- 7. A first run: a hire after the owner has a paying login has its kickoff queued by the follow-up queue and made a run;
--    the typed kickoff is a first-run wake, which owes an acknowledgement before any work (and before its final report)
--    and a final report before it completes, and does no more work once it has reported. A member turn keeps the exact
--    agent version of its conversation: a thread that claims a version its agent never had refuses its send.
savepoint wb_first_run;
select pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid; v_wake public.qorpera_wake_occurrences; v_binding jsonb;
begin
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'Dana''s first run: ' || v_pass::text);
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run;
	perform pg_temp.base_assert(v_wake.wake_kind = 'first-run' and v_wake.staff_agent_id = '92400000-0000-4000-8000-000000000034'
		and v_wake.source_id = (select input_id from public.qorpera_agent_first_runs
			where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000034')
		and (select kind from public.qorpera_session_inputs where id = v_wake.source_id) = 'kickoff',
		'the typed kickoff is a first-run wake: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('first-run'),
		'first-run obligations');
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_work_allowed(%L)', v_run), '55000',
		'Wake requires an acknowledgement before work');
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_binding, 'final', 'early-final'), '55000',
		'wake requires an acknowledgement before its final report');
	perform pg_temp.base_public_send(v_binding, 'progress', 'first-ack');
	perform public.qorpera_assert_wake_work_allowed(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
	update public.qorpera_shared_sessions set staff_version = staff_version + 1 where id = pg_temp.wb_session('92400000-0000-4000-8000-000000000034');
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_binding, 'progress', 'member-turn-pin'), 'PGRST');
	update public.qorpera_shared_sessions set staff_version = staff_version - 1 where id = pg_temp.wb_session('92400000-0000-4000-8000-000000000034');
	perform pg_temp.base_public_send(v_binding, 'final', 'first-final');
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_work_allowed(%L)', v_run), '55000');
end
$$;
rollback to wb_first_run;

-- 8. A first run its sponsor denies: with the owner's login at its limit of concurrent runs (the base runs of Alice and Bob
--    hold both slots), the kickoff's request fails with the quota's reason and leaves no run, job, reservation or wake.
savepoint wb_sponsor_denied;
update public.qorpera_provider_connection_versions set quota_policy = jsonb_set(quota_policy, '{max_concurrent_runs}', '2'::jsonb)
where connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid and version = 2;
select pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
do $$
declare v_counts bigint[] := pg_temp.wb_counts(); v_pass jsonb; v_request public.qorpera_session_turn_requests;
	v_input uuid := (select input_id from public.qorpera_agent_first_runs where profile_id = '92400000-0000-4000-8000-000000000010'
		and staff_agent_id = '92400000-0000-4000-8000-000000000034');
begin
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_sponsor_reservations
		where provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
			and status = 'reserved') = 2, 'fixture: the two base runs hold the login''s two slots');
	v_pass := pg_temp.base_materialize();
	select * into strict v_request from public.qorpera_session_turn_requests where input_id = v_input;
	perform pg_temp.base_assert(v_pass -> 'run_ids' = '[]'::jsonb and (v_pass ->> 'failed')::integer = 1 and v_request.status = 'failed'
		and v_request.failure_reason = 'The selected sponsor quota or model authority is unavailable',
		'the sponsor denies the first run: ' || v_pass::text || ' ' || to_jsonb(v_request)::text);
	perform pg_temp.base_assert((select failed_at is not null and execution_run_id is null from public.qorpera_session_inputs
		where id = v_input), 'the kickoff fails with it');
	perform pg_temp.base_assert(pg_temp.wb_counts() = v_counts, 'the denial cleans the provisional run, its job and reservation');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences
		where staff_agent_id = '92400000-0000-4000-8000-000000000034'), 'the denial leaves no occurrence');
end
$$;
rollback to wb_sponsor_denied;

-- 9. A routine's reply policy: a routine file of Bob's with `reply: optional` fires into his thread; its run may finish
--    silently, but once it speaks it owes its final report; the materializer admits the slot once; the run's wake names
--    the routine's immutable intent. The accessor fails closed (the initial and final obligations) on a run whose binding
--    no longer matches its wake: its source, agent version, conversation, sponsor version or binding, or a stored reply
--    policy it does not know. Another requester on the login is refused where runs change (20260928230000).
savepoint wb_routine_policy;
select pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-routine-tick', jsonb_build_array(pg_temp.wb_routine('agents/bob/routines/tick.md',
	pg_temp.wb_rparse('92400000-0000-4000-8000-0000000000e1', 'Tick', pg_temp.wb_every())))) \g /dev/null
do $$
declare v_wake uuid := pg_temp.wb_slot('92400000-0000-4000-8000-0000000000e1', 'tick-1'); v_pass jsonb := pg_temp.base_materialize();
	v_run uuid := pg_temp.wb_wake_run(v_wake); v_binding jsonb; v_original public.qorpera_execution_runs; v_patch jsonb; v_other uuid;
begin
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_run), 'the slot is materialized through the queue: ' || v_pass::text);
	perform pg_temp.base_assert((select session_id from public.qorpera_wake_occurrences where id = v_wake)
		= pg_temp.wb_session('92400000-0000-4000-8000-000000000031'), 'the routine fires into Bob''s thread');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('routine', 'optional'),
		'an explicit optional reply permits silence');
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.base_assert(pg_temp.base_materialize() ->> 'state' = 'idle', 'the materializer does not admit the run twice');
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.base_assert(public.qorpera_read_native_wake(v_binding) #>> '{routine,intent}' = 'Examine the authorized change.',
		'the routine context is its immutable intent');
	perform pg_temp.base_public_send(v_binding, 'progress', 'tick-ack');
	perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
	perform pg_temp.base_public_send(v_binding, 'final', 'tick-final');
	perform public.qorpera_assert_wake_completion(v_run);
	-- Deliberately corrupt bindings as the fixture owner, so the accessor is checked apart from the occurrence writer.
	select * into strict v_original from public.qorpera_execution_runs where id = v_run;
	for v_patch in select value from jsonb_array_elements(jsonb_build_array(
		jsonb_build_object('source_kind', 'session_turn'), jsonb_build_object('source_id', extensions.gen_random_uuid()),
		jsonb_build_object('staff_version', v_original.staff_version + 1),
		jsonb_build_object('session_id', pg_temp.wb_session('92400000-0000-4000-8000-000000000032')),
		jsonb_build_object('requested_by_user_id', '92400000-0000-4000-8000-000000000002'))) loop
		begin
			update public.qorpera_execution_runs set
				source_kind = coalesce(v_patch ->> 'source_kind', v_original.source_kind),
				input_ids = case when v_patch ->> 'source_kind' = 'session_turn' then array[(select source_id from public.qorpera_wake_occurrences
					where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)] else v_original.input_ids end,
				source_id = coalesce((v_patch ->> 'source_id')::uuid, v_original.source_id),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint, v_original.staff_version),
				session_id = coalesce((v_patch ->> 'session_id')::uuid, v_original.session_id),
				requested_by_user_id = coalesce((v_patch ->> 'requested_by_user_id')::uuid, v_original.requested_by_user_id)
			where id = v_run;
			perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),
				'a wrongly attached occurrence keeps the initial and final obligations: ' || v_patch::text);
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null;
			when insufficient_privilege then
				if not v_patch ? 'requested_by_user_id' then raise; end if;
		end;
	end loop;
	insert into public.qorpera_execution_sponsor_versions
	select (jsonb_populate_record(null::public.qorpera_execution_sponsor_versions, to_jsonb(s) || '{"version":2}'::jsonb)).*
	from public.qorpera_execution_sponsor_versions s where binding_id = v_original.sponsor_binding_id and version = v_original.sponsor_version;
	update public.qorpera_execution_runs set sponsor_version = 2 where id = v_run;
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),
		'a sponsor version mismatch fails closed');
	update public.qorpera_execution_runs set sponsor_version = v_original.sponsor_version where id = v_run;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_other := (public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		(current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 2, true) ->> 'binding_id')::uuid;
	perform pg_temp.base_claims('service_role');
	update public.qorpera_execution_runs set sponsor_binding_id = v_other where id = v_run;
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),
		'a sponsor binding mismatch fails closed');
	update public.qorpera_execution_runs set sponsor_binding_id = v_original.sponsor_binding_id where id = v_run;
	update public.qorpera_cloud_routine_versions set triggers = '[{"id":"file","kind":"schedule","intervalMinutes":5,"replyPolicy":"unknown"}]'
	where routine_id = '92400000-0000-4000-8000-0000000000e1' and version = 1;
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),
		'a malformed stored policy keeps the initial and final obligations');
end
$$;
rollback to wb_routine_policy;

-- 10. A routine's reporting: `reply: required` owes a final report but no acknowledgement, and does no more work after
--     it; `reply: silent` completes without a word, and a send of either phase is refused or fails completion. (The file
--     always names its reply, so the omitted reply of 300 is not a file's; section 5 checks the value.) A run has no
--     limit on its public sends (runtime v92): past the old 64, sending and completing still work.
savepoint wb_routine_reporting;
do $$
declare v_reply text; v_id uuid; v_wake uuid; v_run uuid; v_binding jsonb; v_phase text; v_count integer;
begin
	foreach v_reply in array array['required', 'silent', 'optional'] loop
		v_id := md5('wake-bus-report-' || v_reply)::uuid;
		perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-report-' || v_reply, jsonb_build_array(pg_temp.wb_routine(
			'agents/alice/routines/report-' || v_reply || '.md', pg_temp.wb_rparse(v_id, 'Report', pg_temp.wb_every(), v_reply))));
		v_wake := pg_temp.wb_slot(v_id, 'report-' || v_reply);
		perform pg_temp.base_materialize();
		v_run := pg_temp.wb_wake_run(v_wake);
		v_binding := pg_temp.base_start(v_run);
		perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('routine', v_reply),
			'the admitted reporting policy: ' || v_reply);
		perform public.qorpera_assert_wake_work_allowed(v_run);
		if v_reply = 'required' then
			perform pg_temp.base_error(format('select public.qorpera_assert_wake_completion(%L)', v_run), '55000');
			-- A required report does not require an acknowledgement first.
			perform pg_temp.base_public_send(v_binding, 'final');
			perform public.qorpera_assert_wake_completion(v_run);
			perform pg_temp.base_error(format('select public.qorpera_assert_wake_work_allowed(%L)', v_run), '55000');
		elsif v_reply = 'silent' then
			perform public.qorpera_assert_wake_completion(v_run);
			foreach v_phase in array array['progress', 'final'] loop
				-- The completion backstop: either the send is refused, or completion refuses what it sent.
				perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L); select public.qorpera_assert_wake_completion(%L)',
					v_binding, v_phase, v_run), '55000');
			end loop;
			perform public.qorpera_assert_wake_completion(v_run);
		else
			for v_count in 1..70 loop
				perform pg_temp.base_public_send(v_binding, 'progress', 'budget-' || v_count);
			end loop;
			perform pg_temp.base_public_send(v_binding, 'final');
			perform public.qorpera_assert_wake_completion(v_run);
		end if;
	end loop;
end
$$;
rollback to wb_routine_reporting;

-- 11. A reporting routine's audience at admission: while Bob's thread is closed, scoped to something else, or pinned to a
--     version Bob never had, a `reply: required` slot is refused at the schedule, leaves no occurrence, does not consume
--     its schedule position and admits no compute or sponsor reservation. A routine that may finish privately (optional,
--     silent) still fires without a thread; this check makes no conversation for it.
savepoint wb_routine_audience;
do $$
declare v_patch jsonb; v_n integer := 0; v_id uuid; v_counts bigint[]; v_reply text; v_wake uuid; v_run uuid; v_pass jsonb;
begin
	for v_patch in select value from jsonb_array_elements('[{"status":"closed"},
		{"execution_scope":{"roomId":"not-cloud-room-authority"}},{"staff_version":2}]') loop
		v_n := v_n + 1;
		begin
			update public.qorpera_shared_sessions set status = coalesce((v_patch ->> 'status')::public.qorpera_session_status, status),
				execution_scope = coalesce(v_patch -> 'execution_scope', execution_scope),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint, staff_version)
			where id = pg_temp.wb_session('92400000-0000-4000-8000-000000000031');
			v_id := md5('wake-bus-audience-' || v_n)::uuid;
			perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-audience-' || v_n, jsonb_build_array(pg_temp.wb_routine(
				'agents/bob/routines/audience-' || v_n || '.md', pg_temp.wb_rparse(v_id, 'Audience', pg_temp.wb_every(), 'required'))));
			v_counts := pg_temp.wb_counts();
			perform pg_temp.base_error(format('select pg_temp.wb_slot(%L, %L)', v_id, 'no-audience-' || v_n), '42501',
				'Wake public audience is unavailable');
			perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_id),
				'a missing audience leaves no occurrence: ' || v_patch::text);
			perform pg_temp.base_assert((select last_scheduled_for is null and next_due_at = '-infinity'::timestamptz
				from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_id), 'a refused slot does not consume its position');
			perform pg_temp.base_assert(pg_temp.wb_counts() = v_counts, 'a missing audience admits no compute or sponsor reservation');
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null; end;
	end loop;
	update public.qorpera_shared_sessions set status = 'closed' where id = pg_temp.wb_session('92400000-0000-4000-8000-000000000031');
	foreach v_reply in array array['optional', 'silent'] loop
		v_id := md5('wake-bus-private-' || v_reply)::uuid;
		perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-private-' || v_reply, jsonb_build_array(pg_temp.wb_routine(
			'agents/bob/routines/private-' || v_reply || '.md', pg_temp.wb_rparse(v_id, 'Private', pg_temp.wb_every(), v_reply))));
		v_wake := pg_temp.wb_slot(v_id, 'private-' || v_reply);
		v_pass := pg_temp.base_materialize();
		select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake and session_id is null;
		perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_run),
			'a private finish needs no invented audience: ' || v_pass::text);
		perform pg_temp.base_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('routine', v_reply),
			'a routine without a thread keeps its explicit reporting policy');
		perform public.qorpera_assert_wake_completion(v_run);
	end loop;
end
$$;
rollback to wb_routine_audience;

-- 12. A routine wake's audience is pinned at admission: an occurrence that names Carol's thread is pinned to Bob's, the
--     current authorized conversation of the routine's agent; a supplied audience must match the agent and the
--     environment. The pin is checked against the thread as it is now: once it is closed, rescoped or pinned to a version
--     Bob never had, the admitted slot is not authorized, and the materializer cancels it for good, with no run and no
--     reservation.
savepoint wb_routine_pin;
select pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-routine-pin', jsonb_build_array(pg_temp.wb_routine('agents/bob/routines/pin.md',
	pg_temp.wb_rparse('92400000-0000-4000-8000-0000000000e5', 'Pin', pg_temp.wb_every(), 'required')))) \g /dev/null
do $$
declare v_id uuid := extensions.gen_random_uuid(); v_wake public.qorpera_wake_occurrences; v_candidate public.qorpera_wake_occurrences;
	v_patch jsonb; v_counts bigint[]; v_pass jsonb;
begin
	-- The fixture owner's insert, under the folder admission mark, checks the pin trigger itself.
	perform public.qorpera_folder_admit_wakes('92400000-0000-4000-8000-000000000010');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, trigger_id, occurrence_key,
		scheduled_for, not_before, session_id)
	values (v_id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-0000000000e5',
		1, 'file', 'supplied-audience', now(), now(), pg_temp.wb_session('92400000-0000-4000-8000-000000000032')) returning * into v_wake;
	perform pg_temp.base_assert(v_wake.session_id = pg_temp.wb_session('92400000-0000-4000-8000-000000000031')
		and public.qorpera_wake_authorized(v_wake), 'the routine uses the current authorized conversation of its agent');
	for v_patch in select value from jsonb_array_elements(jsonb_build_array(
		jsonb_build_object('session_id', pg_temp.wb_session('92400000-0000-4000-8000-000000000032')),
		jsonb_build_object('environment_id', '92400000-0000-4000-8000-000000000999'))) loop
		v_candidate := jsonb_populate_record(v_wake, v_patch);
		perform pg_temp.base_assert(not public.qorpera_wake_authorized(v_candidate), 'a supplied audience must match the agent and environment');
	end loop;
	v_counts := pg_temp.wb_counts();
	for v_patch in select value from jsonb_array_elements('[{"status":"closed"},
		{"execution_scope":{"roomId":"not-cloud-room-authority"}},{"staff_version":2}]') loop
		begin
			update public.qorpera_shared_sessions set status = coalesce((v_patch ->> 'status')::public.qorpera_session_status, status),
				execution_scope = coalesce(v_patch -> 'execution_scope', execution_scope),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint, staff_version)
			where id = v_wake.session_id;
			perform pg_temp.base_assert(not public.qorpera_wake_authorized(v_wake), 'the pinned audience is checked as it is now: ' || v_patch::text);
			v_pass := pg_temp.base_materialize();
			perform pg_temp.base_assert(coalesce(v_pass -> 'run_ids', '[]'::jsonb) = '[]'::jsonb,
				'an unusable audience starts no run: ' || v_pass::text);
			perform pg_temp.base_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences where id = v_id),
				'an unusable audience cancels the slot for good');
			perform pg_temp.base_assert(pg_temp.wb_counts() = v_counts, 'a cancelled audience makes no run and no sponsor reservation');
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null; end;
	end loop;
end
$$;
rollback to wb_routine_pin;

-- 13. A coworker message: Alice's run hands Bob a note; a replay returns the one durable receipt, and the same key with
--     other text is refused. Bob's wake is admitted afresh: his run reads the message in his own thread under the
--     coworker policy (no acknowledgement, an optional final, no send limit), with the pair transcript and the chain
--     [Alice, Bob], and may finish silently. His reply is one more hop, which moves him to the end of the chain. A file his
--     run then writes wakes Alice's file-change routine: an agent earlier in the chain is woken again and moves to its
--     end. (An agent's own write never wakes its own routine: 887 §4.)
savepoint wb_coworker;
select pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-listener', jsonb_build_array(pg_temp.wb_routine('agents/alice/routines/note.md',
	pg_temp.wb_rparse('92400000-0000-4000-8000-0000000000e6', 'Note', '{"when":"file-change","watch":"note.md","match":"exact"}')))) \g /dev/null
select public.qorpera_folder_listen_company('92400000-0000-4000-8000-000000000020') \g /dev/null
do $$
declare v_alice jsonb := pg_temp.wb_posted('92400000-0000-4000-8000-000000000030', 'Hand Bob the note.'); v_first jsonb; v_again jsonb;
	v_bob_run uuid; v_bob jsonb; v_read jsonb; v_reply jsonb; v_file public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_public_send(v_alice, 'progress', 'handoff-ack');
	v_first := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'handoff-1', 'Examine the note.');
	v_again := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'handoff-1', 'Examine the note.');
	perform pg_temp.base_assert(v_first = v_again and v_first ->> 'status' = 'queued', 'a duplicate delivery returns one durable receipt');
	perform pg_temp.base_error(format('select public.qorpera_send_coworker_message(%L, %L, %L, %L)', v_alice,
		'92400000-0000-4000-8000-000000000031', 'handoff-1', 'Different text'), '23505');
	perform pg_temp.base_materialize();
	v_bob_run := pg_temp.wb_wake_run((v_first ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert(v_bob_run is not null, 'the coworker wake gets fresh admission');
	v_bob := pg_temp.base_start(v_bob_run);
	v_read := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = 'Examine the note.' and v_read #>> '{policy,final}' = 'optional'
		and v_read #>> '{policy,initial}' = 'forbidden' and v_read -> 'policy' -> 'maxPublicSends' = 'null'::jsonb
		and v_read #>> '{audience,sessionId}' = pg_temp.wb_session('92400000-0000-4000-8000-000000000031')::text
		and v_read #>> '{payload,pairSessionId}' is not null and jsonb_array_length(v_read #> '{payload,transcript}') = 1,
		'the message reaches the recipient in its own thread: ' || v_read::text);
	perform pg_temp.base_assert(v_read #> '{causal,agentIds}'
		= '["92400000-0000-4000-8000-000000000030","92400000-0000-4000-8000-000000000031"]'::jsonb, 'the coworker keeps its ancestry');
	perform public.qorpera_assert_wake_completion(v_bob_run);
	v_reply := public.qorpera_send_coworker_message(v_bob, '92400000-0000-4000-8000-000000000030', 'thanks', 'Thanks.');
	perform pg_temp.base_assert(v_reply ->> 'status' = 'queued' and v_reply ->> 'occurrenceId' is not null, 'a reply to the sender is one more hop');
	perform pg_temp.base_assert((select causal_hop_count = 2 and causal_agent_ids = array['92400000-0000-4000-8000-000000000031',
			'92400000-0000-4000-8000-000000000030']::uuid[] from public.qorpera_wake_occurrences where id = (v_reply ->> 'occurrenceId')::uuid),
		'the reply moves the sender to the end of the chain');
	perform pg_temp.base_commit(pg_temp.wb_actor(v_bob), 'wake-bus-bob-note', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'note.md', 'file', pg_temp.base_stage('From Bob'))));
	perform public.qorpera_folder_listen_company('92400000-0000-4000-8000-000000000020');
	select * into strict v_file from public.qorpera_wake_occurrences where routine_id = '92400000-0000-4000-8000-0000000000e6';
	perform pg_temp.base_assert(v_file.parent_run_id = v_bob_run and v_file.staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and v_file.causal_agent_ids = array['92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000030']::uuid[]
		and public.qorpera_wake_authorized(v_file), 'a message, then a file, wakes the ancestor again at the end of the chain: '
		|| to_jsonb(v_file)::text);
end
$$;
rollback to wb_coworker;

-- 14. A coworker message whose recipient is archived before its run: the archive leaves the queued delivery with no run,
--     cancelled for good.
savepoint wb_archived_recipient;
do $$
declare v_alice jsonb := pg_temp.wb_posted('92400000-0000-4000-8000-000000000030', 'Ask Carol.'); v_message jsonb; v_pass jsonb;
begin
	perform pg_temp.base_public_send(v_alice, 'progress', 'archived-ack');
	v_message := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000032', 'archived-recipient', 'Please examine.');
	perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-archive-carol', jsonb_build_array(pg_temp.wb_agent('carol',
		'92400000-0000-4000-8000-000000000032', 'Carol', 'Read and change the company folder.', 'archived')));
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(coalesce(v_pass -> 'run_ids', '[]'::jsonb) = '[]'::jsonb, 'an archived recipient does not run: ' || v_pass::text);
	perform pg_temp.base_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences
		where id = (v_message ->> 'occurrenceId')::uuid), 'the queued delivery is cancelled for good');
end
$$;
rollback to wb_archived_recipient;

-- 15. A failed delivery of a member's post is tried again: only a failed delivery, and only by the post's author on their
--     own sponsor; the retry is bound to the failed run and the same post, once. The member's message stays once, the
--     failed run leaves recovery, and the same agent is woken again for the same post, with exactly the first delivery's
--     payload (the runner parses it as a closed object), and answers in the thread.
savepoint wb_room_retry;
do $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Bob, are you there?');
	v_pass jsonb := pg_temp.base_materialize(); v_first uuid := (v_wakes ->> 0)::uuid; v_run uuid := pg_temp.wb_wake_run(v_first);
	v_thread uuid := pg_temp.wb_session('92400000-0000-4000-8000-000000000031'); v_binding jsonb; v_base public.qorpera_execution_runs;
	v_retry jsonb; v_retry_run uuid; v_inputs bigint;
begin
	v_binding := pg_temp.base_start(v_run);
	select * into strict v_base from public.qorpera_execution_runs where id = v_run;
	select count(*) into v_inputs from public.qorpera_session_inputs where session_id = v_thread;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run, v_base.sponsor_binding_id,
		v_base.sponsor_version), '55000', 'execution recovery action is unavailable');
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'Native provider bridge request failed (422)', false);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		'the delivery failed the way a runner reports it');
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run, v_base.sponsor_binding_id,
		v_base.sponsor_version), '42501', 'Room retry requires a member');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run, v_base.sponsor_binding_id,
		v_base.sponsor_version), '42501');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run, extensions.gen_random_uuid(), 1),
		'42501', 'Room sponsor is unavailable');
	v_retry := public.qorpera_retry_room_delivery(v_run, v_base.sponsor_binding_id, v_base.sponsor_version);
	perform pg_temp.base_assert(v_retry ->> 'inputId' = (select source_id::text from public.qorpera_wake_occurrences where id = v_first)
		and v_retry ->> 'runId' = v_run::text, 'the retry is bound to the failed run and the same post: ' || v_retry::text);
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run, v_base.sponsor_binding_id,
		v_base.sponsor_version), '55000', 'execution recovery was already resolved');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert((select count(*) from public.qorpera_session_inputs where session_id = v_thread) = v_inputs,
		'the member''s message stays once');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_execution_run_events
		where run_id = v_run and event_type = 'recovery_released'), 'the failed run leaves recovery');
	perform pg_temp.base_assert((select w.payload = first.payload from public.qorpera_wake_occurrences w, public.qorpera_wake_occurrences first
		where w.id = (v_retry ->> 'occurrenceId')::uuid and first.id = v_first), 'a retried wake carries exactly a first delivery''s payload');
	perform pg_temp.base_materialize();
	v_retry_run := pg_temp.wb_wake_run((v_retry ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert((select r.source_kind = 'room_delivery' and r.session_id = v_thread and r.id <> v_run
		and r.staff_agent_id = '92400000-0000-4000-8000-000000000031' from public.qorpera_execution_runs r where r.id = v_retry_run),
		'the same agent is woken again for the same post');
	v_binding := pg_temp.base_start(v_retry_run);
	perform pg_temp.base_public_send(v_binding, 'final', 'answer-after-retry');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_agent_sends where run_id = v_retry_run),
		'the retried delivery answers in the thread');
end
$$;
rollback to wb_room_retry;

-- 16. An agent edit (a commit of its agent.md) never ends a run, and applies from the agent's next run. A wake admitted
--     at the agent's later version answers in the thread opened at the earlier one, a post's delivery too; a thread that
--     claims a version its agent never had stays unusable. A run in flight through an edit keeps sending, under the name
--     of its own version, writing the company folder and reading the instructions and description of its own version; a
--     wake queued through an edit is admitted at the current version and reads the edited agent. Archiving is not an edit:
--     it ends the agent's runs.
do $$
declare c_bob constant uuid := '92400000-0000-4000-8000-000000000031'; v_thread uuid := pg_temp.wb_session(c_bob);
	v_wake uuid; v_run uuid; v_binding jsonb; v_delivery jsonb; v_charter text; v_row public.qorpera_execution_runs;
	v_queued uuid; v_queued_run uuid; v_queued_binding jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-edit-bob-1', jsonb_build_array(pg_temp.wb_agent('bob', c_bob, 'Bob',
		'Read and change the company folder.', 'active', 'Analysis')));
	perform pg_temp.base_assert((select version from public.qorpera_profile_staff
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = c_bob) = 2, 'fixture: the edit is Bob''s version 2');
	perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-after-edit', jsonb_build_array(
		pg_temp.wb_routine('agents/bob/routines/after-edit.md', pg_temp.wb_rparse('92400000-0000-4000-8000-0000000000e7', 'After edit',
			pg_temp.wb_every(), 'required')),
		pg_temp.wb_routine('agents/bob/routines/queued.md', pg_temp.wb_rparse('92400000-0000-4000-8000-0000000000e8', 'Queued',
			pg_temp.wb_every(), 'required'))));
	v_wake := pg_temp.wb_slot('92400000-0000-4000-8000-0000000000e7', 'thread-after-edit');
	perform pg_temp.base_assert((select session_id from public.qorpera_wake_occurrences where id = v_wake) = v_thread,
		'an edited agent keeps its thread as its public audience');
	perform pg_temp.base_materialize();
	v_run := pg_temp.wb_wake_run(v_wake);
	perform pg_temp.base_assert((select r.session_id = v_thread and r.staff_version > s.staff_version
		from public.qorpera_execution_runs r join public.qorpera_shared_sessions s on s.id = r.session_id where r.id = v_run),
		'the wake runs at the edited version inside the thread opened at the earlier one');
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.base_public_send(v_binding, 'progress', 'thread-after-edit');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_session_events
		where session_id = v_thread and execution_kind = 'run' and execution_id = v_run),
		'the transcript accepts the wake run although the thread records an earlier agent version');

	-- A member's post into the thread is a room delivery, at the agent's current version.
	v_delivery := pg_temp.wb_posted(c_bob, 'Bob, are you there?');
	perform pg_temp.base_assert((select r.source_kind = 'room_delivery' and r.session_id = v_thread and r.staff_version > s.staff_version
		from public.qorpera_execution_runs r join public.qorpera_shared_sessions s on s.id = r.session_id
		where r.id = (v_delivery ->> 'runId')::uuid), 'a post into the thread of an edited agent is delivered at its current version');
	perform pg_temp.base_public_send(v_delivery, 'progress', 'delivery-after-edit');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_session_events where session_id = v_thread
		and execution_kind = 'run' and execution_id = (v_delivery ->> 'runId')::uuid), 'an edited agent answers a member in its thread');
	update public.qorpera_shared_sessions set staff_version = staff_version + 2 where id = v_thread;
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_delivery, 'progress', 'thread-ahead-delivery'), 'PGRST');
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_binding, 'progress', 'thread-ahead-routine'),
		'42501', 'Admitted wake authority is unavailable');
	update public.qorpera_shared_sessions set staff_version = staff_version - 2 where id = v_thread;

	-- A wake queued through the edit, then the edit: a new name and new instructions.
	select charter into strict v_charter from public.qorpera_profile_staff
	where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = c_bob;
	v_queued := pg_temp.wb_slot('92400000-0000-4000-8000-0000000000e8', 'queued-through-edit');
	perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-edit-bob-2', jsonb_build_array(pg_temp.wb_agent('bob', c_bob, 'Robert',
		'An edited charter that applies from the next run.', 'active', 'Analysis')));

	-- The run in flight: its send, its folder write and its own instructions and description all survive the edit.
	perform pg_temp.base_public_send(v_binding, 'progress', 'edited-in-flight');
	perform pg_temp.base_assert((select count(*) from public.qorpera_agent_sends where run_id = v_run
		and idempotency_key = 'edited-in-flight') = 1, 'an edit does not end the run in flight');
	perform pg_temp.base_assert((select speaker.display_name = 'Bob' and speaker.staff_version = send_run.staff_version
		from public.qorpera_agent_sends send join public.qorpera_session_event_speakers speaker on speaker.event_id = send.event_id
		join public.qorpera_execution_runs send_run on send_run.id = send.run_id
		where send.run_id = v_run and send.idempotency_key = 'edited-in-flight'),
		'a run whose agent was renamed meanwhile speaks under the name of its own version');
	perform pg_temp.base_commit(pg_temp.wb_actor(v_binding), 'wake-bus-edited-in-flight', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'edited-note.md', 'file', pg_temp.base_stage('Written by a run whose agent was edited meanwhile.'))));
	select * into strict v_row from public.qorpera_execution_runs where id = v_run;
	perform pg_temp.base_assert(public.qorpera_company_context_source(v_row, 'job_spec', v_row.staff_agent_id) ->> 'text' = v_charter,
		'a run in flight keeps the instructions of its own version');
	perform pg_temp.base_assert((select (c #>> '{agent,version}')::bigint = v_row.staff_version and c #>> '{agent,name}' = 'Bob'
		from public.qorpera_describe_company_run_context(v_binding) c), 'a run in flight describes its agent as of its own version');

	-- The wake that waited through the edit is the agent's next run.
	perform pg_temp.base_materialize();
	v_queued_run := pg_temp.wb_wake_run(v_queued);
	perform pg_temp.base_assert((select r.staff_version = a.version and r.staff_version > w.staff_version
		from public.qorpera_execution_runs r join public.qorpera_wake_occurrences w on w.run_id = r.id
		join public.qorpera_profile_staff a on a.profile_id = r.profile_id and a.staff_agent_id = r.staff_agent_id
		where r.id = v_queued_run), 'a wake queued through an edit is admitted at the current version');
	v_queued_binding := pg_temp.base_start(v_queued_run);
	perform pg_temp.base_public_send(v_queued_binding, 'progress', 'queued-through-edit');
	select * into strict v_row from public.qorpera_execution_runs where id = v_queued_run;
	perform pg_temp.base_assert(public.qorpera_company_context_source(v_row, 'job_spec', v_row.staff_agent_id) ->> 'text'
		= 'An edited charter that applies from the next run.', 'the next run reads the edited instructions');
	perform pg_temp.base_assert((select c #>> '{agent,name}' = 'Robert' from public.qorpera_describe_company_run_context(v_queued_binding) c),
		'the next run describes the edited agent');

	-- Archiving is not an edit: it ends the agent's runs.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'wake-bus-archive-bob', jsonb_build_array(pg_temp.wb_agent('bob', c_bob, 'Robert',
		'An edited charter that applies from the next run.', 'archived', 'Analysis')));
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_queued_binding, 'progress', 'after-archive'), '42501');
end
$$;

rollback;
