-- Company folder core, C1b-1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md): run actors on the folder core. No
-- run can exist on a folder-v2 company yet (runs need a substrate and a snapshot), so runs, jobs, wakes, sessions,
-- routines and rooms are built by hand, with foreign keys and triggers off while they are inserted.
begin;

insert into auth.users(id,email) values
	('63200000-0000-4000-8000-000000000001','agents-owner@example.test'),
	('63200000-0000-4000-8000-000000000002','agents-member@example.test'),
	('63200000-0000-4000-8000-000000000003','agents-viewer@example.test'),
	('63200000-0000-4000-8000-000000000004','agents-other@example.test'),
	('63200000-0000-4000-8000-000000000005','agents-admin@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('63200000-0000-4000-8000-000000000010','Folder agents fixture','63200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-000000000001','agents-owner@example.test','Owner','owner'),
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-000000000002','agents-member@example.test','Member','contributor'),
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-000000000003','agents-viewer@example.test','Viewer','viewer'),
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-000000000004','agents-other@example.test','Other','contributor'),
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-000000000005','agents-admin@example.test','Admin','admin');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('63200000-0000-4000-8000-000000000020','63200000-0000-4000-8000-000000000010','Environment',1,'63200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('63200000-0000-4000-8000-000000000010','63200000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '63200000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('63200000-0000-4000-8000-000000000020') \g /dev/null
-- The runs' sponsor: a company login, which pays for any member's work (20260928230000).
set local session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('63200000-0000-4000-8000-0000000000b3', '63200000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai',
	'63200000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('63200000-0000-4000-8000-0000000000b1', '63200000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
	'63200000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('63200000-0000-4000-8000-0000000000b1', 1, 'company_service_account', '63200000-0000-4000-8000-0000000000b3', 1,
	'63200000-0000-4000-8000-000000000001');
set local session_replication_role = origin;

-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them (C1D §9.3).
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms each object the open did not report present (the manifest's
-- chunks and the manifest itself, by hash and size, as the gateway does once it has stored them), and seals it.
create function pg_temp.seal_v2(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
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
-- The files pg_temp.stage made, which were version 1 before C5 and so exempt from possession.
create temp table fixture_files(manifest_sha256 text primary key, manifest_text text not null);
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text) returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb; v_manifest text := pg_temp.manifest_v2(p_text);
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = '63200000-0000-4000-8000-000000000010'
		and core = 'folder-v2' order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', v_manifest);
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	insert into pg_temp.fixture_files values (v_seal -> 'file' ->> 'manifestSha256', v_manifest) on conflict do nothing;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files pg_temp.stage made itself, as its own upload would, unless it holds an unexpired sealed intent
-- for it already. A file a test stages any other way is left alone. An actor that may not stage (42501) or a stopped
-- company (55000) is left to the commit's own refusal; any other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct s.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join pg_temp.fixture_files s on s.manifest_sha256 = refs.f ->> 'manifestSha256'
		where not exists (select 1 from public.qorpera_folder_upload_intents i where i.environment_id = p_env
			and i.manifest_sha256 = s.manifest_sha256 and i.state = 'sealed' and i.expires_at > clock_timestamp()
			and i.actor_kind = p_actor ->> 'kind' and i.scope_id = public.qorpera_folder_upload_scope(p_actor)) loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;

-- A hand-built leased run of agent A for a requester, and its wake. p_kind: 'human', 'routine' or 'agent' (a
-- coworker wake). Returns the run actor. Foreign keys and triggers are off only while the rows go in.
create function pg_temp.run(p_kind text, p_requester uuid, p_audience text default 'company',
	p_routine uuid default null, p_routine_version bigint default null, p_source text default null) returns jsonb
language plpgsql as $$
declare
	v_profile uuid := '63200000-0000-4000-8000-000000000010'; v_env uuid := '63200000-0000-4000-8000-000000000020';
	v_staff uuid := '63200000-0000-4000-8000-0000000000a1';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid; v_input uuid := extensions.gen_random_uuid(); v_sponsor uuid := '63200000-0000-4000-8000-0000000000b1';
	v_bundle uuid := '63200000-0000-4000-8000-0000000000b2';
begin
	set local session_replication_role = replica;
	if p_kind in ('human','first-run') then
		-- One open session per agent and audience; reuse it.
		select id into v_session from public.qorpera_shared_sessions where profile_id = v_profile and staff_agent_id = v_staff::text
			and status = 'open' and audience_kind = p_audience
			and audience_user_id is not distinct from case when p_audience = 'member_private' then p_requester end;
		if v_session is null then
			insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version,
				audience_kind, audience_user_id)
			values (extensions.gen_random_uuid(), v_profile, v_env, 'Agent thread', p_requester, v_staff::text, 1,
				p_audience, case when p_audience = 'member_private' then p_requester end)
			returning id into v_session;
		end if;
		insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
			runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
		values (v_input, v_session, extensions.gen_random_uuid(), p_requester,
			case when p_kind = 'first-run' then 'control_plane' else 'human' end,
			case when p_kind = 'first-run' then 'kickoff' else 'user_message' end, v_bundle, repeat('b', 64), v_run);
	end if;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		p_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '5 minutes', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, audience_user_id, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, case when p_kind in ('human','first-run') then 'session_turn' else 'wake' end,
		case when p_kind in ('human','first-run') then v_input else v_wake end, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, p_requester, p_requester, 'openai', 'gpt-test',
		'provider_default', p_audience, case when p_audience = 'member_private' then p_requester end, v_bundle, repeat('b', 64),
		v_session, case when p_kind in ('human','first-run') then array[v_input] else '{}'::uuid[] end);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload, routine_id, routine_version)
	values (v_wake, v_profile, v_env, case when p_kind = 'routine' then 'every-5' else 'input' end, v_wake::text,
		clock_timestamp(), clock_timestamp(), p_kind,
		case when p_kind in ('human','first-run') then 'input' when p_kind = 'routine' then coalesce(p_source, 'schedule') else 'coworker' end,
		case when p_kind in ('human','first-run') then v_input when p_kind = 'routine' then p_routine else v_wake end,
		v_run, 'materialized', v_staff, 1, p_requester, v_sponsor, 1, v_session, v_wake, array[v_staff],
		case when p_kind in ('human','first-run') then jsonb_build_object('inputIds', jsonb_build_array(v_input)) else '{}'::jsonb end,
		p_routine, p_routine_version);
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

-- A routine of agent A made by a member, with one schedule trigger that reports silently. Returns its id.
create function pg_temp.routine(p_creator uuid, p_status text default 'active') returns uuid language plpgsql as $$
declare v_routine uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, created_by_user_id, status, current_version)
	values (v_routine, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
		p_creator, p_status, 1);
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id, staff_agent_id,
		title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id, required_capability, job_type)
	values (v_routine, 1, extensions.gen_random_uuid(), '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-0000000000a1', 'Check', 'Check.',
		'[{"id":"every-5","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}]', 'medium',
		'63200000-0000-4000-8000-0000000000b1', 1, repeat('d', 64), p_creator, 'agent_turn', 'agent_turn');
	set local session_replication_role = origin;
	return v_routine;
end $$;

-- Changes a hand-built fixture row with foreign keys and triggers off (a row inserted in this transaction re-checks
-- its foreign keys on every update).
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;

-- A room wake: the room, its session, the poster and agent A as active members, the input in the room, and the run
-- as a room delivery (review probe r432impl/room.sql). Sets qorpera_test.room and qorpera_test.room_session.
create function pg_temp.room_run(p_poster uuid) returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63200000-0000-4000-8000-000000000010'; v_env uuid := '63200000-0000-4000-8000-000000000020';
	v_staff uuid := '63200000-0000-4000-8000-0000000000a1';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid := extensions.gen_random_uuid(); v_room uuid := extensions.gen_random_uuid(); v_input uuid := extensions.gen_random_uuid();
	v_sponsor uuid := '63200000-0000-4000-8000-0000000000b1'; v_bundle uuid := '63200000-0000-4000-8000-0000000000b2';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version,
		audience_kind, audience_user_id, execution_scope)
	values (v_session, v_profile, v_env, 'Room', p_poster, null, 1, 'company', null, jsonb_build_object('roomId', v_room));
	insert into public.qorpera_company_rooms(id, profile_id, environment_id, room_key, name, purpose, status, session_id, version,
		created_by_user_id, source_path, source_path_version, source_snapshot_id, source_file_sha256)
	values (v_room, v_profile, v_env, 'room-' || left(v_room::text, 8), 'Room', 'Talk', 'active', v_session, 1, p_poster,
		'agents/groups/room', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('f', 64));
	insert into public.qorpera_company_room_members(room_id, principal_kind, principal_id, status, source_path_version) values
		(v_room, 'member', p_poster, 'active', extensions.gen_random_uuid()),
		(v_room, 'staff_agent', v_staff, 'active', extensions.gen_random_uuid());
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256)
	values (v_input, v_session, extensions.gen_random_uuid(), p_poster, 'human', 'user_message', v_bundle, repeat('b', 64));
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		p_poster, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '5 minutes', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, audience_user_id, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'room_delivery', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, p_poster, p_poster, 'openai', 'gpt-test',
		'provider_default', 'company', null, v_bundle, repeat('b', 64), v_session, '{}'::uuid[]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'room', v_wake::text, clock_timestamp(), clock_timestamp(), 'room', 'room', v_input,
		v_run, 'materialized', v_staff, 1, p_poster, v_sponsor, 1, v_session, v_wake, array[v_staff], '{}'::jsonb);
	set local session_replication_role = origin;
	perform set_config('qorpera_test.room', v_room::text, true);
	perform set_config('qorpera_test.room_session', v_session::text, true);
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb, p_review uuid default null) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', p_actor, p_key, p_units, p_review);
end $$;
create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','63200000-0000-4000-8000-00000000000' || p_n)
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.raises(p_sql text, p_state text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected SQLSTATE % from %', p_state, p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' or sqlstate <> p_state then raise; end if;
end $$;
create function pg_temp.read(p_path text, p_actor jsonb default '{"kind":"platform"}') returns jsonb language sql as $$
	select public.qorpera_folder_read('63200000-0000-4000-8000-000000000020', p_actor, p_path)
$$;

-- A leased run of agent A saves as the agent, for its requester, with full attribution.
do $$
declare a jsonb := pg_temp.stage('alpha'); v_actor jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); r jsonb;
	c public.qorpera_folder_commits%rowtype;
begin
	r := pg_temp.commit(v_actor, 'run-mkdir-1', jsonb_build_array(jsonb_build_object('op','mkdir','path','docs'),
		jsonb_build_object('op','write','path','docs/a.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	select * into c from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid;
	if c.actor_kind <> 'staff_agent' or c.actor_id <> '63200000-0000-4000-8000-0000000000a1' or c.requester_kind <> 'member'
		or c.requester_id <> '63200000-0000-4000-8000-000000000002' or c.run_id <> (v_actor ->> 'runId')::uuid
		or c.causal_wake_id is null or c.session_kind <> 'in_house' or c.audience ->> 'kind' <> 'company'
		or c.sponsor_binding_id <> '63200000-0000-4000-8000-0000000000b1' or c.sponsor_version <> 1
		or c.runtime_bundle_id <> '63200000-0000-4000-8000-0000000000b2' or c.routine_id is not null
		or c.provider_connection_id is distinct from '63200000-0000-4000-8000-0000000000b3' then
		raise exception 'Run attribution: %', to_jsonb(c); end if;
	if (pg_temp.read('docs/a.txt', v_actor) ->> 'found')::boolean is not true then raise exception 'A run reads what it may read'; end if;
end $$;


-- The run check refuses, with nothing applied: a job not leased, expired or re-claimed; staff archived; the
-- requester gone; compute under recovery. A routine run saves while active or expired while active, and not once
-- paused or concluded by another run. An agent wake with no execution authority and no parent run refuses (634 covers
-- agent wakes); file-change routine wakes wait for C4 (0A000).
do $$
declare v jsonb; v_seq bigint; v_routine uuid; r jsonb;
	c_member constant uuid := '63200000-0000-4000-8000-000000000002';
	c_mkdir constant jsonb := '[{"op":"mkdir","path":"refused"}]';
begin
	select last_seq into v_seq from public.qorpera_folder_clocks where environment_id = '63200000-0000-4000-8000-000000000020';
	v := pg_temp.run('human', c_member);
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L', v ->> 'jobId'));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'refuse-expired', c_mkdir), '42501');
	v := pg_temp.run('human', c_member);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v || jsonb_build_object('assignmentId', extensions.gen_random_uuid()),
		'refuse-reclaimed', c_mkdir), '42501');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v || jsonb_build_object('runnerId', extensions.gen_random_uuid()),
		'refuse-other-runner', c_mkdir), '42501');
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set status = ''queued'', runner_id = null, client_lease_id = null,
		lease_token_sha256 = null, lease_expires_at = null where id = %L', v ->> 'jobId'));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'refuse-not-leased', c_mkdir), '42501');

	v := pg_temp.run('human', c_member);
	perform pg_temp.fx('update public.qorpera_profile_staff set employment_status = ''archived'' where staff_agent_id = ''63200000-0000-4000-8000-0000000000a1''');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'refuse-archived', c_mkdir), '42501');
	perform pg_temp.fx('update public.qorpera_profile_staff set employment_status = ''active'' where staff_agent_id = ''63200000-0000-4000-8000-0000000000a1''');
	v := pg_temp.run('human', '63200000-0000-4000-8000-000000000004');
	perform pg_temp.fx('delete from public.qorpera_profile_members where user_id = ''63200000-0000-4000-8000-000000000004''');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'refuse-requester-gone', c_mkdir), '42501');
	perform pg_temp.fx('insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
		(''63200000-0000-4000-8000-000000000010'',''63200000-0000-4000-8000-000000000004'',''agents-other@example.test'',''Other'',''contributor'')');

	v := pg_temp.run('human', c_member);
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, client_identity_id, display_name, ownership_kind, owner_user_id,
		status, recovery_pending_id, recovery_epoch)
	values ('63200000-0000-4000-8000-0000000000c1', '63200000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'Linux',
		'member', '63200000-0000-4000-8000-000000000002', 'active', extensions.gen_random_uuid(), 0);
	update public.qorpera_execution_runs set compute_identity_id = '63200000-0000-4000-8000-0000000000c1', compute_recovery_epoch = 0
	where id = (v ->> 'runId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'refuse-recovering', c_mkdir), '42501');

	v_routine := pg_temp.routine(c_member);
	r := pg_temp.commit(pg_temp.run('routine', c_member, 'company', v_routine, 1), 'routine-active', '[{"op":"mkdir","path":"by-routine"}]');
	perform pg_temp.expect(r, 1, 'saved');
	if (select routine_id from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid) is distinct from v_routine then
		raise exception 'A routine run records its routine'; end if;
	v := pg_temp.run('routine', c_member, 'company', v_routine, 1);
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = ''expired'', expired_while_active = true where id = %L', v_routine));
	perform pg_temp.expect(pg_temp.commit(v, 'routine-expired-active', '[{"op":"mkdir","path":"by-last-occurrence"}]'), 1, 'saved');
	v := pg_temp.run('routine', c_member, 'company', v_routine, 1);
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = ''paused'', expired_while_active = false where id = %L', v_routine));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'routine-paused', c_mkdir), '42501');
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = ''concluded'', concluded_by_run_id = %L,
		concluded_at = clock_timestamp(), conclusion = ''Done.'' where id = %L', extensions.gen_random_uuid(), v_routine));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'routine-concluded-other', c_mkdir), '42501');

	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.run('agent', c_member), 'agent-wake', c_mkdir), '42501');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)',
		pg_temp.run('routine', c_member, 'company', pg_temp.routine(c_member), 1, 'company-file'), 'file-routine-wake', c_mkdir), '0A000');

	if exists (select 1 from public.qorpera_folder_entries where environment_id = '63200000-0000-4000-8000-000000000020' and key_text = 'refused') then
		raise exception 'A refused run applied a unit'; end if;
end $$;

-- A paused company refuses runs before any lock (55000), members still write, and a replay is answered even while
-- paused. The folder pause is two phases; resume clears it.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); r1 jsonb; r2 jsonb;
begin
	r1 := pg_temp.commit(v, 'paused-replay-1', '[{"op":"mkdir","path":"before-pause"}]');
	perform pg_temp.expect(r1, 1, 'saved');
	perform public.qorpera_folder_pause('63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000001', 'test');
	perform public.qorpera_folder_pause_drain('63200000-0000-4000-8000-000000000010');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'paused-new', '[{"op":"mkdir","path":"during-pause"}]'), '55000');
	perform pg_temp.raises(format('select pg_temp.read(%L, %L)', 'before-pause', v), '55000');
	r2 := pg_temp.commit(v, 'paused-replay-1', '[{"op":"mkdir","path":"before-pause"}]');
	if (r2 ->> 'replay')::boolean is not true or r2 ->> 'commitId' <> r1 ->> 'commitId' then
		raise exception 'A replay must be answered while paused: %', r2; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'paused-member', '[{"op":"mkdir","path":"member-during-pause"}]'), 1, 'saved');
	perform public.qorpera_folder_resume('63200000-0000-4000-8000-000000000010');
	perform pg_temp.expect(pg_temp.commit(v, 'resumed-run-1', '[{"op":"mkdir","path":"after-resume"}]'), 1, 'saved');
end $$;


-- Agent authority: the requester and, by audience, the agent. The rules/ base: members read it, owners and admins
-- write it, agents only read it, even after their root grant is revoked.
do $$
declare a jsonb := pg_temp.stage('alpha'); v jsonb; r jsonb;
	c_member constant uuid := '63200000-0000-4000-8000-000000000002';
	c_private constant text := 'members/63200000-0000-4000-8000-000000000002/private';
begin
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63200000-0000-4000-8000-000000000020', c_private, 'subtree', 'member_private', c_member, 'normal', c_member);
	r := pg_temp.commit('{"kind":"platform"}', 'auth-setup-1', jsonb_build_array(jsonb_build_object('op','mkdir','path','members'),
		jsonb_build_object('op','mkdir','path','members/63200000-0000-4000-8000-000000000002'),
		jsonb_build_object('op','mkdir','path',c_private), jsonb_build_object('op','mkdir','path','shared')));
	perform pg_temp.expect(r, 4, 'saved');
	-- A company conversation's agent never writes a member's private folder, not even its requester's.
	r := pg_temp.commit(pg_temp.run('human', c_member), 'auth-company-private', jsonb_build_array(jsonb_build_object('op','write',
		'path',c_private || '/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	-- A private conversation's agent writes a shared path; for another member's audience, nothing.
	r := pg_temp.commit(pg_temp.run('human', c_member, 'member_private'), 'auth-private-shared', jsonb_build_array(jsonb_build_object('op','write',
		'path','shared/p.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	v := pg_temp.run('human', c_member, 'member_private');
	perform pg_temp.fx(format('update public.qorpera_execution_runs set audience_user_id = %L where id = %L',
		'63200000-0000-4000-8000-000000000004', v ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set audience_user_id = %L where id = (select session_id from public.qorpera_execution_runs where id = %L)',
		'63200000-0000-4000-8000-000000000004', v ->> 'runId'));
	r := pg_temp.commit(v, 'auth-private-other', jsonb_build_array(jsonb_build_object('op','write','path','shared/q.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');

	-- rules/. Ordinary files there (a rule file, rules/*.md, needs its parse since F2-1): the authority is the same.
	r := pg_temp.commit(pg_temp.member(1), 'rules-owner-1', jsonb_build_array(jsonb_build_object('op','mkdir','path','rules'),
		jsonb_build_object('op','write','path','rules/tone.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if (pg_temp.read('rules/tone.txt', pg_temp.member(3)) ->> 'found')::boolean is not true then raise exception 'A viewer reads rules/'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(5), 'rules-admin-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','rules/admin.txt','file',a))), 1, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'rules-contrib-1', jsonb_build_array(jsonb_build_object('op','write','path','rules/mine.txt','file',a),
		jsonb_build_object('op','move','from','shared/p.txt','to','rules/p.txt',
			'expectedVersion',pg_temp.read('shared/p.txt') -> 'entry' ->> 'version')));
	perform pg_temp.expect(r, 1, 'denied', 'denied'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	v := pg_temp.run('human', c_member);
	r := pg_temp.commit(v, 'rules-agent-1', jsonb_build_array(jsonb_build_object('op','write','path','rules/agent.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	if (pg_temp.read('rules/tone.txt', v) ->> 'found')::boolean is not true then raise exception 'An agent reads rules/'; end if;
	perform pg_temp.fx('update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
		where principal_kind = ''staff_agent'' and principal_id = ''63200000-0000-4000-8000-0000000000a1''');
	if (pg_temp.read('rules/tone.txt', v) ->> 'found')::boolean is not true or (pg_temp.read('shared/p.txt', v) ->> 'found')::boolean then
		raise exception 'Without its root grant an agent still reads rules/ and nothing shared'; end if;
	perform pg_temp.fx('update public.qorpera_company_path_grants set revoked_at = null
		where principal_kind = ''staff_agent'' and principal_id = ''63200000-0000-4000-8000-0000000000a1''');
end $$;

-- Worker and coding rules, through the authority functions with resolved actors (coding and worker runs reach the
-- commit with C1b-2). A read-access in-house worker writes nothing; a coding session (whose worker access is always
-- 'read') writes as its agent and member, except agents/ and rules/, and can still copy out of agents/.
do $$
declare
	c_env constant uuid := '63200000-0000-4000-8000-000000000020'; c_profile constant uuid := '63200000-0000-4000-8000-000000000010';
	v_base jsonb := '{"kind":"staff_agent","staffAgentId":"63200000-0000-4000-8000-0000000000a1",
		"requesterUserId":"63200000-0000-4000-8000-000000000002","audience":{"kind":"company"}}';
	v_reader jsonb; v_writer jsonb; v_coding jsonb; r jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'coding-setup-1', '[{"op":"mkdir","path":"agents"},{"op":"mkdir","path":"agents/a"},
		{"op":"mkdir","path":"code"},{"op":"mkdir","path":"code/repo"}]');
	perform pg_temp.expect(r, 4, 'saved');
	v_reader := v_base || '{"sessionKind":"in_house","workerAccess":"read"}';
	v_writer := v_base || '{"sessionKind":"in_house","workerAccess":"write"}';
	v_coding := v_base || '{"sessionKind":"coding","workerAccess":"read"}';
	if public.qorpera_folder_actor_allowed(c_env, c_profile, v_reader, 'shared/w.txt', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_reader, 'shared/w.txt', 'read')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_writer, 'shared/w.txt', 'write') then
		raise exception 'In-house worker access'; end if;
	if not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'code/repo/main.py', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'shared/w.txt', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'agents', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'agents/a/agent.md', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'rules', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'Rules/x.md', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'agents/a', 'read') then
		raise exception 'The coding rule'; end if;
	-- As a subtree: a move into agents/ or rules/ is refused as a target, a copy out of agents/ is allowed.
	if public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'code/repo', 'rules/repo', 'write')
		or public.qorpera_folder_actor_keys_allowed(c_env, c_profile, v_coding, 'misc', array['misc/x', 'agents/b'], 'write')
		or not (public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'agents/a', 'agents/a', 'read')
			and public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'agents/a', 'misc/a', 'write')) then
		raise exception 'The coding rule on subtrees'; end if;
end $$;

-- Operation keys per run: a replay after a lease re-claim returns the stored outcomes; two runs, and a member, use
-- one key and each save; the same key with another review id is another change set (22023).
do $$
declare v1 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	r1 jsonb; r2 jsonb; v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
begin
	r1 := pg_temp.commit(v1, 'key-reclaim-1', '[{"op":"mkdir","path":"k-reclaim"}]');
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set runner_id = %L, client_lease_id = %L where id = %L',
		v_runner, v_assignment, v1 ->> 'jobId'));
	r2 := pg_temp.commit(v1 || jsonb_build_object('runnerId', v_runner, 'assignmentId', v_assignment), 'key-reclaim-1',
		'[{"op":"mkdir","path":"k-reclaim"}]');
	if (r2 ->> 'replay')::boolean is not true or r2 ->> 'commitId' <> r1 ->> 'commitId' then
		raise exception 'A replay after a re-claim returns the stored outcomes: % %', r1, r2; end if;
	perform pg_temp.expect(pg_temp.commit(v1 || jsonb_build_object('runnerId', v_runner, 'assignmentId', v_assignment), 'key-shared-1',
		'[{"op":"mkdir","path":"k-one"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(v2, 'key-shared-1', '[{"op":"mkdir","path":"k-two"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'key-shared-1', '[{"op":"mkdir","path":"k-three"}]'), 1, 'saved');
	perform pg_temp.commit(v2, 'key-review-1', '[{"op":"mkdir","path":"k-review"}]');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L, %L)', v2, 'key-review-1', '[{"op":"mkdir","path":"k-review"}]',
		extensions.gen_random_uuid()), '22023');
end $$;

-- Review: an in-house run's delete or move needs a review record bound to its run, its change set and the unit.
do $$
declare a jsonb := pg_temp.stage('alpha'); v jsonb; u jsonb; r jsonb; v_review uuid; i integer;
	c_member constant uuid := '63200000-0000-4000-8000-000000000002';
begin
	r := pg_temp.commit(pg_temp.member(2), 'review-setup-1', (select jsonb_agg(jsonb_build_object('op','write','path','rv' || n || '.txt','file',a))
		from generate_series(1, 6) n));
	perform pg_temp.expect(r, 6, 'saved');
	-- No record: denied. A record that allows: saved.
	v := pg_temp.run('human', c_member);
	u := jsonb_build_array(jsonb_build_object('op','delete','path','rv1.txt','expectedVersion',pg_temp.read('rv1.txt') -> 'entry' ->> 'version'));
	perform pg_temp.expect(pg_temp.commit(v, 'review-none-1', u), 1, 'denied', 'review_required');
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63200000-0000-4000-8000-000000000020', (v ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(u), '{1}', 'allow')
	returning id into v_review;
	r := pg_temp.commit(v, 'review-allow-1', u, v_review);
	perform pg_temp.expect(r, 1, 'saved');
	if (select review_id from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid) is distinct from v_review then
		raise exception 'The commit records the review it used'; end if;
	-- An answered ask: saved, with its approver.
	v := pg_temp.run('human', c_member);
	u := jsonb_build_array(jsonb_build_object('op','move','from','rv2.txt','to','rv2-moved.txt','expectedVersion',pg_temp.read('rv2.txt') -> 'entry' ->> 'version'));
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision, answer, answered_by_user_id, answered_at)
	values ('63200000-0000-4000-8000-000000000020', (v ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(u), '{1}', 'ask',
		'allow', '63200000-0000-4000-8000-000000000001', clock_timestamp())
	returning id into v_review;
	r := pg_temp.commit(v, 'review-answered-1', u, v_review);
	perform pg_temp.expect(r, 1, 'saved');
	if (select approver_user_id from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid)
		is distinct from '63200000-0000-4000-8000-000000000001' then raise exception 'An answered allow records its approver'; end if;
	-- An open ask waits; a deny, another run's record, another digest and a unit outside the set are denied.
	v := pg_temp.run('human', c_member);
	u := jsonb_build_array(jsonb_build_object('op','delete','path','rv3.txt','expectedVersion',pg_temp.read('rv3.txt') -> 'entry' ->> 'version'),
		jsonb_build_object('op','delete','path','rv4.txt','expectedVersion',pg_temp.read('rv4.txt') -> 'entry' ->> 'version'),
		jsonb_build_object('op','mkdir','path','rv-plain'));
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63200000-0000-4000-8000-000000000020', (v ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(u), '{1}', 'ask')
	returning id into v_review;
	r := pg_temp.commit(v, 'review-ask-1', u, v_review);
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'waiting_for_review');
	perform pg_temp.expect(r, 2, 'denied', 'review_required');
	perform pg_temp.expect(r, 3, 'saved');
	if (pg_temp.read('rv3.txt') ->> 'found')::boolean is not true then raise exception 'A waiting unit is not applied'; end if;
	v := pg_temp.run('human', c_member);
	u := jsonb_build_array(jsonb_build_object('op','delete','path','rv5.txt','expectedVersion',pg_temp.read('rv5.txt') -> 'entry' ->> 'version'));
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63200000-0000-4000-8000-000000000020', (v ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(u), '{1}', 'deny')
	returning id into v_review;
	perform pg_temp.expect(pg_temp.commit(v, 'review-deny-1', u, v_review), 1, 'denied', 'review_denied');
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63200000-0000-4000-8000-000000000020', (v ->> 'runId')::uuid, repeat('e', 64), '{1}', 'allow') returning id into v_review;
	perform pg_temp.expect(pg_temp.commit(v, 'review-digest-1', u, v_review), 1, 'denied', 'review_required');
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), public.qorpera_folder_change_set_sha256(u), '{1}', 'allow')
	returning id into v_review;
	perform pg_temp.expect(pg_temp.commit(v, 'review-other-run-1', u, v_review), 1, 'denied', 'review_required');
	-- A member's delete is never reviewed.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'review-member-1', jsonb_build_array(jsonb_build_object('op','delete',
		'path','rv6.txt','expectedVersion',pg_temp.read('rv6.txt') -> 'entry' ->> 'version'))), 1, 'saved');
end $$;

-- The indexed resolver keeps C1a's rules: an exact resource covers only its own key, a tie covers nothing, and a
-- private path has no covering resource but its owner's own.
do $$
declare v_exact uuid; c_env constant uuid := '63200000-0000-4000-8000-000000000020';
begin
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values (c_env, 'Exakt', 'exact', 'company_shared', null, 'normal', '63200000-0000-4000-8000-000000000001') returning id into v_exact;
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id) values
		(c_env, 'Øst', 'subtree', 'company_shared', null, 'normal', '63200000-0000-4000-8000-000000000001'),
		(c_env, 'øst', 'subtree', 'company_shared', null, 'normal', '63200000-0000-4000-8000-000000000001');
	if (public.qorpera_folder_path_resource(c_env, 'EXAKT')).id is distinct from v_exact
		or (public.qorpera_folder_path_resource(c_env, 'exakt/inner')).path is distinct from ''
		or (public.qorpera_folder_path_resource(c_env, 'ØST/x')).id is not null
		or (public.qorpera_folder_path_resource(c_env, 'members/63200000-0000-4000-8000-000000000003/private/x')).id is not null
		or (public.qorpera_folder_path_resource(c_env, 'members/63200000-0000-4000-8000-000000000002/private/x')).scope
			is distinct from 'member_private'
		or (public.qorpera_folder_path_resource(c_env, 'rules/x.md')).scope is distinct from 'company_rules' then
		raise exception 'The indexed resolver'; end if;
end $$;

-- First-run and room wakes: a kickoff run saves; a room delivery saves, and is refused once its poster leaves the
-- room or its session closes.
do $$
declare v jsonb; r jsonb; c_member constant uuid := '63200000-0000-4000-8000-000000000002';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.run('first-run', c_member), 'first-run-1', '[{"op":"mkdir","path":"from-kickoff"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.room_run(c_member), 'room-save-1', '[{"op":"mkdir","path":"from-room"}]'), 1, 'saved');
	v := pg_temp.room_run(c_member);
	perform pg_temp.fx(format('update public.qorpera_company_room_members set status = ''removed'', removed_at = clock_timestamp()
		where room_id = %L and principal_kind = ''member''', current_setting('qorpera_test.room')));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'room-left-1', '[{"op":"mkdir","path":"room-left"}]'), '42501');
	v := pg_temp.room_run(c_member);
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = ''closed'' where id = %L', current_setting('qorpera_test.room_session')));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'room-closed-1', '[{"op":"mkdir","path":"room-closed"}]'), '42501');
	-- A review id is a run's: a member's commit refuses one.
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L, %L)', pg_temp.member(2), 'member-review-1',
		'[{"op":"mkdir","path":"member-review"}]', extensions.gen_random_uuid()), '22023');
end $$;

-- Run reads take no locks: none of the read path's functions locks a row.
do $$
begin
	if exists (select 1 from pg_proc where proname in ('qorpera_folder_read','qorpera_folder_list','qorpera_folder_read_actor',
			'qorpera_folder_run_resolve','qorpera_folder_wake_authorized','qorpera_folder_actor_allowed','qorpera_folder_actor_resource_allowed',
			'qorpera_folder_path_resource','qorpera_folder_principal_allowed')
		and prosrc ~* '\mfor\s+(update|share|key\s+share|no\s+key\s+update)\M') then
		raise exception 'A read-path function takes a lock'; end if;
end $$;

-- The hook's targets at the commit's own ranks go into the commit's passes, never dropped: a member row at rank 1 is
-- locked with the commit's own (633 H shows the commit waiting for it); a table the commit does not own at its
-- ranks, and a malformed target, are defects (XX000). The hook's current definition (F2's since 20260928249020) comes
-- back at the end of the block.
do $$
declare v_saved text := pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure);
begin
	create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
	returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
		select (t ->> 'rank')::smallint, t ->> 'tbl', t ->> 'key', t ->> 'mode'
		from jsonb_array_elements(coalesce(current_setting('qorpera_test.targets', true), '[]')::jsonb) t
	$f$;
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
		'key', '63200000-0000-4000-8000-000000000010:63200000-0000-4000-8000-000000000003', 'mode', 'update'))::text, true);
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'targets-member-1', '[{"op":"mkdir","path":"targets-one"}]'), 1, 'saved');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 6, 'tbl', 'qorpera_profile_members',
		'key', 'x', 'mode', 'keyshare'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'targets-bad-1', '[{"op":"mkdir","path":"targets-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 10, 'tbl', 'qorpera_profile_members',
		'key', 'x', 'mode', 'keyshare'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'targets-bad-2', '[{"op":"mkdir","path":"targets-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
		'key', '63200000-0000-4000-8000-000000000010:63200000-0000-4000-8000-000000000003', 'mode', 'exclusive'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'targets-bad-3', '[{"op":"mkdir","path":"targets-bad"}]'), 'XX000');
	-- (A hook's targets carry no 'required' flag in F2's signature; the hook checks the rows it relies on in decide.)
	execute v_saved;
end $$;

-- Folder invariants, and no claim outlives its transaction.
do $$
begin
	if exists (select 1 from public.qorpera_folder_entries where kind = 'claim')
		or exists (select 1 from public.qorpera_folder_entries e where e.environment_id = '63200000-0000-4000-8000-000000000020'
			and strpos(e.path, '/') > 0 and not exists (select 1 from public.qorpera_folder_entries p
				where p.environment_id = e.environment_id and p.key_sha256 = e.parent_key_sha256 and p.kind = 'folder')) then
		raise exception 'Folder invariants'; end if;
end $$;

rollback;
