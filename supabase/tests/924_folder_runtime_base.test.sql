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
declare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb;
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
	return jsonb_build_object('leaseId', v_lease ->> 'lease_id', 'runId', p_run, 'jobId', v_claim #>> '{work,job_id}',
		'runnerId', v_runner ->> 'runner_id', 'assignmentId', v_assignment ->> 'assignment_id',
		'credentialCapsuleId', v_lease ->> 'credential_capsule_id', 'computeIdentityId', v_lease ->> 'compute_identity_id',
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-native');
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

rollback;
