-- Company folder core, C1b-2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, section C1b-2): resource and grant
-- mutators, read receipts and releases, the recheck, and agent-woken runs. Runs, jobs, wakes, sessions and workers are
-- built by hand, as in 632. Races are in 635.
begin;

insert into auth.users(id,email) values
	('63400000-0000-4000-8000-000000000001','authority-owner@example.test'),
	('63400000-0000-4000-8000-000000000002','authority-member@example.test'),
	('63400000-0000-4000-8000-000000000003','authority-viewer@example.test'),
	('63400000-0000-4000-8000-000000000004','authority-other@example.test'),
	('63400000-0000-4000-8000-000000000005','authority-admin@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('63400000-0000-4000-8000-000000000010','Folder authority fixture','63400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000001','authority-owner@example.test','Owner','owner'),
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000002','authority-member@example.test','Member','contributor'),
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000003','authority-viewer@example.test','Viewer','viewer'),
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000004','authority-other@example.test','Other','contributor'),
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000005','authority-admin@example.test','Admin','admin');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('63400000-0000-4000-8000-000000000020','63400000-0000-4000-8000-000000000010','Environment',1,'63400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '63400000-0000-4000-8000-000000000001'),
	('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-0000000000a2','Agent B','Ops','Test.','blue','round','active','active',
		statement_timestamp(), statement_timestamp(), '63400000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('63400000-0000-4000-8000-000000000020') \g /dev/null
-- Two logins: the company's (binding b1), which pays for any member's work, and the other member's own (binding b4),
-- which pays only for work that member started (20260928230000).
set local session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id) values
	('63400000-0000-4000-8000-0000000000b3', '63400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), null, 'openai',
		'63400000-0000-4000-8000-000000000001'),
	('63400000-0000-4000-8000-0000000000b5', '63400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'63400000-0000-4000-8000-000000000004', 'openai', '63400000-0000-4000-8000-000000000004');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
	('63400000-0000-4000-8000-0000000000b1', '63400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'63400000-0000-4000-8000-000000000001'),
	('63400000-0000-4000-8000-0000000000b4', '63400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'63400000-0000-4000-8000-000000000004');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id) values
	('63400000-0000-4000-8000-0000000000b1', 1, 'company_service_account', '63400000-0000-4000-8000-0000000000b3', 1,
		'63400000-0000-4000-8000-000000000001'),
	('63400000-0000-4000-8000-0000000000b4', 1, 'member_connection', '63400000-0000-4000-8000-0000000000b5', 1,
		'63400000-0000-4000-8000-000000000004');
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
	for v_env in select environment_id from public.qorpera_company_files where profile_id = '63400000-0000-4000-8000-000000000010'
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
-- for it already. A file a test stages any other way is left alone, so tests of possession itself (761) are not
-- touched. An actor that may not stage (42501) or a stopped company (55000) is left to the commit's own refusal; any
-- other error is a fixture defect and surfaces.
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

-- A hand-built leased run of an agent for a requester, and its wake. p_kind 'human' (a message in the agent's company
-- thread) or 'agent', woken by p_source ('coworker', 'worker-dispatch', 'worker-completion', 'office-activation') from
-- the parent run p_parent, with p_worker for worker wakes. Returns the run actor. Foreign keys and triggers are off
-- only while the rows go in.
create function pg_temp.run(p_staff uuid, p_kind text, p_requester uuid, p_source text default null, p_parent jsonb default null,
	p_worker uuid default null) returns jsonb
language plpgsql as $$
declare
	v_profile uuid := '63400000-0000-4000-8000-000000000010'; v_env uuid := '63400000-0000-4000-8000-000000000020';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid; v_input uuid := extensions.gen_random_uuid(); v_sponsor uuid := '63400000-0000-4000-8000-0000000000b1';
	v_bundle uuid := '63400000-0000-4000-8000-0000000000b2'; v_parent public.qorpera_wake_occurrences%rowtype;
begin
	set local session_replication_role = replica;
	if p_kind = 'human' then
		select id into v_session from public.qorpera_shared_sessions where profile_id = v_profile and staff_agent_id = p_staff::text
			and status = 'open' and audience_kind = 'company';
		if v_session is null then
			insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version,
				audience_kind)
			values (extensions.gen_random_uuid(), v_profile, v_env, 'Agent thread', p_requester, p_staff::text, 1, 'company')
			returning id into v_session;
		end if;
		insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
			runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
		values (v_input, v_session, extensions.gen_random_uuid(), p_requester, 'human', 'user_message', v_bundle, repeat('b', 64), v_run);
	else
		select * into v_parent from public.qorpera_wake_occurrences where run_id = (p_parent ->> 'runId')::uuid;
		-- A worker's completion returns to its parent's thread.
		if p_source = 'worker-completion' then v_session := v_parent.session_id; end if;
	end if;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		p_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, case when p_kind = 'human' then 'session_turn' else 'wake' end,
		case when p_kind = 'human' then v_input else v_wake end, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		p_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, p_requester, p_requester, 'openai', 'gpt-test',
		'provider_default', 'company', v_bundle, repeat('b', 64), v_session,
		case when p_kind = 'human' then array[v_input] else '{}'::uuid[] end);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
	values (v_wake, v_profile, v_env,
		case when p_kind = 'human' then 'input' when p_source in ('worker-dispatch','worker-completion') then p_source else 'agent' end,
		v_wake::text, clock_timestamp(), clock_timestamp(), p_kind, case when p_kind = 'human' then 'input' else p_source end,
		case when p_kind = 'human' then v_input when p_source in ('worker-dispatch','worker-completion') then p_worker else v_wake end,
		v_run, 'materialized', p_staff, 1, p_requester, v_sponsor, 1, v_session,
		case when p_kind = 'human' then v_wake else v_parent.causal_root_id end,
		case when p_kind = 'human' then array[p_staff]
			when p_source = 'coworker' then array_remove(v_parent.causal_agent_ids, p_staff) || p_staff
			else v_parent.causal_agent_ids end,
		case when p_source = 'coworker' then v_parent.causal_hop_count + 1 else 0 end,
		(p_parent ->> 'runId')::uuid,
		case when p_kind = 'human' then jsonb_build_object('inputIds', jsonb_build_array(v_input)) else '{}'::jsonb end);
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

-- A worker of an agent, dispatched by the parent run. A coding worker names its owner and the owner's login.
create function pg_temp.worker(p_staff uuid, p_parent jsonb, p_species text, p_access text, p_owner uuid default null,
	p_owner_sponsor uuid default '63400000-0000-4000-8000-0000000000b1') returns uuid
language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (v_id, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', p_staff, extensions.gen_random_uuid(),
		'w-' || left(v_id::text, 8), p_species, 'Work', p_access, 'each', '{}', '63400000-0000-4000-8000-000000000002',
		(p_parent ->> 'runId')::uuid, p_owner, case when p_owner is not null then p_owner_sponsor end,
		case when p_owner is not null then 1 end);
	set local session_replication_role = origin;
	return v_id;
end $$;

-- Changes a hand-built fixture row with foreign keys and triggers off.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;

-- P15: the follow-up queue, run at once after a commit that marked something, as its step would: each marked subject
-- taken, then each dirty one converged (the company first, then the agents).
create function pg_temp.follow_ups(p_env uuid) returns void language plpgsql as $$
declare v_subject record; v_work public.qorpera_folder_follow_ups%rowtype;
begin
	for v_subject in select distinct m.subject_kind, m.subject_id from public.qorpera_folder_follow_up_marks m
		where m.environment_id = p_env loop
		v_work := public.qorpera_folder_follow_up_take(p_env, v_subject.subject_kind, v_subject.subject_id);
	end loop;
	for v_work in select * from public.qorpera_folder_follow_ups w where w.environment_id = p_env and w.dirty
		order by w.subject_kind = 'agent', w.subject_id loop
		perform public.qorpera_folder_follow_up_converge(v_work);
	end loop;
end $$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb, p_review uuid default null) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.possess('63400000-0000-4000-8000-000000000020', p_actor, p_units);
	v_result := public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', p_actor, p_key, p_units, p_review);
	perform pg_temp.follow_ups('63400000-0000-4000-8000-000000000020');
	return v_result;
end $$;
create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','63400000-0000-4000-8000-00000000000' || p_n)
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
	select public.qorpera_folder_read('63400000-0000-4000-8000-000000000020', p_actor, p_path)
$$;
-- Releases entries a run read (their path, version and receipt).
create function pg_temp.release(p_actor jsonb, p_release uuid, p_entries jsonb, p_output text default repeat('0', 64)) returns jsonb
language sql as $$
	select public.qorpera_folder_record_release('63400000-0000-4000-8000-000000000020', p_actor, p_release,
		(select coalesce(jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), '[]')
			from jsonb_array_elements(p_entries) e), p_output)
$$;
create function pg_temp.resolved(p_actor jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_run_resolve('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', p_actor)
		- 'lockTargets' - 'attribution'
$$;
create function pg_temp.root() returns public.qorpera_company_path_resources language sql as $$
	select * from public.qorpera_company_path_resources where environment_id = '63400000-0000-4000-8000-000000000020' and path = ''
$$;
create function pg_temp.agent_grant(p_resource uuid, p_staff uuid) returns public.qorpera_company_path_grants language sql as $$
	select * from public.qorpera_company_path_grants where resource_id = p_resource and principal_kind = 'staff_agent'
		and principal_id = p_staff and revoked_at is null order by id limit 1
$$;
create function pg_temp.reads(p_actor jsonb) returns setof public.qorpera_folder_run_reads language sql as $$
	select * from public.qorpera_folder_run_reads where run_id = (p_actor ->> 'runId')::uuid
$$;


-- Mutators: owners and admins on shared resources; a member's private folder is theirs alone; a narrower resource
-- bumps its parent; one journal row per change, with its actor; version never changes.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_private constant text := 'members/63400000-0000-4000-8000-000000000002/private';
	v_root public.qorpera_company_path_resources%rowtype := pg_temp.root(); v_before public.qorpera_company_path_grants%rowtype;
	r jsonb; j public.qorpera_folder_journal%rowtype; v_res uuid; v_priv uuid; v_g1 uuid; v_g2 uuid;
begin
	v_before := pg_temp.agent_grant(v_root.id, c_a);
	r := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'teams/sales', 'subtree', 'company_shared', 'normal');
	v_res := (r ->> 'resourceId')::uuid;
	if (select authority_revision from public.qorpera_company_path_resources where id = v_root.id) <> v_root.authority_revision + 1
		or (select version from public.qorpera_company_path_resources where id = v_root.id) <> v_root.version then
		raise exception 'A narrower resource bumps its parent, never its version'; end if;
	select * into j from public.qorpera_folder_journal where environment_id = c_env and seq = (r ->> 'seq')::bigint;
	if j.kind <> 'authority' or (j.authority ->> 'narrowing')::boolean is not true or j.authority -> 'actor' <> pg_temp.member(1)
		or j.authority -> 'changes' <> jsonb_build_array(jsonb_build_object('resourceId', v_root.id,
			'revision', v_root.authority_revision + 1, 'prefix', 'teams/sales'))
		or not exists (select 1 from public.qorpera_folder_authority_changes where environment_id = c_env and seq = j.seq
			and resource_id = v_root.id and prefix = 'teams/sales' and narrowing) then
		raise exception 'Authority journal row: %', to_jsonb(j); end if;
	-- The same settings again change nothing and take no clock.
	r := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'teams/sales', 'subtree', 'company_shared', 'normal');
	if r ->> 'seq' is not null then raise exception 'An unchanged resource journals nothing: %', r; end if;
	-- An admin's match change narrows, bumps the resource and, since paths move between them, its parent. The
	-- resource keeps its spelling. The protected policy is refused until C2 enforces it.
	r := public.qorpera_folder_set_resource(c_env, pg_temp.member(5), 'Teams/Sales', 'exact', 'company_shared', 'normal');
	if (r ->> 'authorityRevision')::bigint <> 2 or (select (authority ->> 'narrowing')::boolean from public.qorpera_folder_journal
			where environment_id = c_env and seq = (r ->> 'seq')::bigint) is not true
		or (select authority_revision from public.qorpera_company_path_resources where id = v_root.id) <> v_root.authority_revision + 2
		or (select path from public.qorpera_company_path_resources where id = v_res) <> 'teams/sales' then
		raise exception 'A match change: %', r; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		'teams/sales', 'exact', 'company_shared', 'protected'), '0A000');
	-- A contributor makes no shared resource.
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(2),
		'teams/other', 'subtree', 'company_shared', 'normal'), '42501');

	-- A member's private folder: only they make it; an owner can neither make, change nor share there, and
	-- member_private exists nowhere else.
	r := public.qorpera_folder_set_resource(c_env, pg_temp.member(2), c_private, 'subtree', 'member_private', 'normal');
	v_priv := (r ->> 'resourceId')::uuid;
	if (select owner_user_id from public.qorpera_company_path_resources where id = v_priv) <> '63400000-0000-4000-8000-000000000002' then
		raise exception 'A private resource belongs to its member'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		c_private || '/x', 'subtree', 'member_private', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		c_private || '/x', 'subtree', 'company_shared', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		c_private, 'exact', 'member_private', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(5),
		c_private || '/y', 'subtree', 'member_private', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(2),
		'elsewhere', 'subtree', 'member_private', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(2),
		'members/63400000-0000-4000-8000-000000000004/private', 'subtree', 'member_private', 'normal'), '42501');

	-- Grants: a first grant widens; a narrower one replaces it (the old one revoked, its revision bumped) and narrows.
	r := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read','write']);
	v_g1 := (r ->> 'grantId')::uuid;
	if (select (authority ->> 'narrowing')::boolean from public.qorpera_folder_journal where environment_id = c_env
		and seq = (r ->> 'seq')::bigint) then raise exception 'A first grant widens'; end if;
	r := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read']);
	v_g2 := (r ->> 'grantId')::uuid;
	if (r ->> 'replaced')::uuid is distinct from v_g1
		or not exists (select 1 from public.qorpera_company_path_grants where id = v_g1 and revoked_at is not null and revision = 2)
		or (select (authority ->> 'narrowing')::boolean from public.qorpera_folder_journal where environment_id = c_env
			and seq = (r ->> 'seq')::bigint) is not true then raise exception 'A narrower grant replaces the old one: %', r; end if;
	-- A private folder is shared with its member's agents only, and only by that member.
	perform pg_temp.raises(format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(2), v_priv,
		'member', '63400000-0000-4000-8000-000000000004', array['read']), '42501');
	perform public.qorpera_folder_grant(c_env, pg_temp.member(2), v_priv, 'staff_agent', c_a, array['read']);
	perform pg_temp.raises(format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1), v_priv,
		'staff_agent', c_b, array['read']), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_revoke(%L, %L, %L)', c_env, pg_temp.member(1), v_priv), '42501');
	-- Contributors do not grant on shared resources.
	perform pg_temp.raises(format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(2), v_res,
		'staff_agent', c_b, array['read']), '42501');
	-- A revoke always narrows; the root is never revoked.
	r := public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_g2);
	if not exists (select 1 from public.qorpera_company_path_grants where id = v_g2 and revoked_at is not null and revision = 2)
		or (select (authority ->> 'narrowing')::boolean from public.qorpera_folder_journal where environment_id = c_env
			and seq = (r ->> 'seq')::bigint) is not true then raise exception 'A revoke: %', r; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_revoke(%L, %L, %L)', c_env, pg_temp.member(1), v_root.id), '42501');
	-- Explicit grants survive: the agent's root grant is untouched.
	if pg_temp.agent_grant(v_root.id, c_a) is distinct from v_before then raise exception 'The root grant survives'; end if;

	-- Two resources that share a folder key refuse any change on that key (23505), after the parent lock.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id) values
		(c_env, 'ties/Øst', 'subtree', 'company_shared', 'normal', '63400000-0000-4000-8000-000000000001'),
		(c_env, 'ties/øst', 'subtree', 'company_shared', 'normal', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		'ties/ØST', 'exact', 'company_shared', 'normal'), '23505');
end $$;


-- A commit records the clock value it decided under. A hook target on a resource or grant is key share only.
do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.member(2), 'as-of-one', '[{"op":"mkdir","path":"as-of"}]');
	if (select as_of_seq from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid) <> (r ->> 'seq')::bigint - 1 then
		raise exception 'A quiet commit decided under the clock just before its own'; end if;
	begin
		create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
		returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
			select 6::smallint, 'qorpera_company_path_resources'::text, r.id::text, 'share'::text from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id and r.path = ''
		$f$;
		perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'hook-share', '[{"op":"mkdir","path":"hooked"}]'),
			'XX000');
		create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
		returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
			select 6::smallint, 'qorpera_company_path_resources'::text, r.id::text, 'keyshare'::text from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id and r.path = ''
		$f$;
		perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'hook-keyshare', '[{"op":"mkdir","path":"hooked"}]'), 1, 'saved');
		raise exception 'Undo the hook' using errcode = 'QTF09';
	exception when sqlstate 'QTF09' then null;
	end;
end $$;


-- Receipts and releases: a run's read and listing carry receipts; a release records them; a release id replays or
-- refuses; releases refuse while paused, after a revoke and after an expiry.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v_root public.qorpera_company_path_resources%rowtype := pg_temp.root();
	v_grant public.qorpera_company_path_grants%rowtype := pg_temp.agent_grant((pg_temp.root()).id, c_a);
	v jsonb := pg_temp.run(c_a, 'human', '63400000-0000-4000-8000-000000000002');
	v_rel uuid := extensions.gen_random_uuid(); e jsonb; l jsonb; r jsonb; v_new uuid;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'release-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','shared'),
		jsonb_build_object('op','write','path','shared/a.txt','file',pg_temp.stage('alpha')),
		jsonb_build_object('op','write','path','shared/b.txt','file',pg_temp.stage('beta'))));
	perform pg_temp.expect(r, 3, 'saved');
	e := pg_temp.read('shared/a.txt', v) -> 'entry';
	if e -> 'authority' is distinct from jsonb_build_object('resourceId', v_root.id, 'resourceRevision', v_root.authority_revision,
		'grantId', v_grant.id, 'grantRevision', v_grant.revision) then raise exception 'Read receipt: %', e; end if;
	if pg_temp.read('shared/a.txt', pg_temp.member(2)) -> 'entry' ? 'authority' then raise exception 'A member read has no receipt'; end if;
	l := public.qorpera_folder_list(c_env, v, 'shared', null, 10);
	if (select count(*) from jsonb_array_elements(l -> 'entries') x where x -> 'authority' ->> 'grantId' = v_grant.id::text) <> 2 then
		raise exception 'Listing receipts: %', l; end if;

	r := pg_temp.release(v, v_rel, l -> 'entries', repeat('1', 64));
	if (r ->> 'replay')::boolean or (r ->> 'reads')::integer <> 2 then raise exception 'Release: %', r; end if;
	if (select count(*) from pg_temp.reads(v)) <> 1 or not exists (select 1 from pg_temp.reads(v) x where x.resource_id = v_root.id
			and x.grant_id = v_grant.id and x.resource_revision = v_root.authority_revision and x.grant_revision = v_grant.revision)
		or (select jsonb_array_length(reads) from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
			and release_id = v_rel and resource_id = v_root.id) <> 2 then
		raise exception 'Read set and records'; end if;
	if (pg_temp.release(v, v_rel, l -> 'entries', repeat('1', 64)) ->> 'replay')::boolean is not true then
		raise exception 'A release id replays'; end if;
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L, %L)', v, v_rel, l -> 'entries', repeat('2', 64)), '22023');

	perform public.qorpera_folder_pause(c_profile, '63400000-0000-4000-8000-000000000001', 'test');
	perform public.qorpera_folder_pause_drain(c_profile);
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), l -> 'entries'), '55000');
	perform public.qorpera_folder_resume(c_profile);

	-- After a revoke, the old receipt re-resolves and refuses. Granted again, it re-resolves to the new grant.
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_root.id, v_grant.id);
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), l -> 'entries'), '42501');
	v_new := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_root.id, 'staff_agent', c_a, v_grant.permissions) ->> 'grantId';
	perform pg_temp.release(v, extensions.gen_random_uuid(), l -> 'entries');
	if not exists (select 1 from pg_temp.reads(v) x where x.grant_id = v_new) then
		raise exception 'A re-resolved release records the grant it found'; end if;
	-- A grant that expired since the read refuses.
	e := pg_temp.read('shared/a.txt', v) -> 'entry';
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set created_at = clock_timestamp() - interval ''2 seconds'',
		expires_at = clock_timestamp() - interval ''1 second'' where id = %L', v_new));
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), jsonb_build_array(e)), '42501');
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set expires_at = null where id = %L', v_new));
end $$;


-- The recheck: the A1 sequence (a read under the root, a narrower resource and grant, a recheck, the narrower grant
-- revoked, a recheck again: refused); a replaced grant retired once; compare-and-set re-stamps; least() upserts.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v jsonb := pg_temp.run(c_a, 'human', '63400000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run(c_a, 'human', '63400000-0000-4000-8000-000000000002');
	v_root public.qorpera_company_path_resources%rowtype; v_res uuid; v_g uuid; v_g3 uuid; v_g4 uuid; e jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'a1-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','depts'),
		jsonb_build_object('op','mkdir','path','depts/ops'),
		jsonb_build_object('op','write','path','depts/ops/q.txt','file',pg_temp.stage('ops')))), 3, 'saved');
	perform pg_temp.release(v, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('depts/ops/q.txt', v) -> 'entry'));
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'depts/ops', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_g := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read','write']) ->> 'grantId';
	-- The run's next commit rechecks: the path re-resolves under the narrower resource, whose pair is watched from
	-- now on, and the root row is re-stamped.
	perform pg_temp.expect(pg_temp.commit(v, 'a1-commit-1', '[{"op":"mkdir","path":"a1-one"}]'), 1, 'saved');
	v_root := pg_temp.root();
	if not exists (select 1 from pg_temp.reads(v) x where x.resource_id = v_res and x.grant_id = v_g and x.resource_revision = 1
			and x.grant_revision = 1)
		or not exists (select 1 from pg_temp.reads(v) x where x.resource_id = v_root.id and x.resource_revision = v_root.authority_revision) then
		raise exception 'The recheck watches the narrower pair and re-stamps the root: %',
			(select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v) x); end if;
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v)) <> 0 then
		raise exception 'A clean recheck changes nothing'; end if;
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_g);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'a1-commit-2', '[{"op":"mkdir","path":"a1-two"}]'), '42501');

	-- A replaced grant: its row is retired once and the new pair recorded; the next check finds nothing.
	v_g := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read','write']) ->> 'grantId';
	e := pg_temp.read('depts/ops/q.txt', v2) -> 'entry';
	perform pg_temp.release(v2, extensions.gen_random_uuid(), jsonb_build_array(e));
	v_g3 := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read']) ->> 'grantId';
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v2)) <> 1
		or exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g)
		or not exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g3) then
		raise exception 'A replaced grant is retired once: %', (select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v2) x); end if;
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v2)) <> 0 then
		raise exception 'After the retirement nothing changed'; end if;
	-- A stale receipt for the dead pair does not bring its row back: the release re-resolves to the live grant.
	perform pg_temp.release(v2, extensions.gen_random_uuid(), jsonb_build_array(e));
	if exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g) then raise exception 'A stale receipt recreated a dead pair'; end if;
	-- A re-stamp is compare-and-set: a row whose recorded values moved meanwhile is left as it is. An upsert keeps the
	-- oldest revisions.
	perform public.qorpera_folder_write_read_set(c_env, (v2 ->> 'runId')::uuid, null, jsonb_build_array(jsonb_build_object(
		'resourceId', v_res, 'grantId', v_g3, 'resourceRevision', 99, 'grantRevision', 99,
		'recordedResourceRevision', 0, 'recordedGrantRevision', 0)), null);
	perform public.qorpera_folder_write_read_set(c_env, (v2 ->> 'runId')::uuid, jsonb_build_array(jsonb_build_object(
		'resourceId', v_res, 'grantId', v_g3, 'resourceRevision', 5, 'grantRevision', 5)), null, null);
	if not exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g3 and x.resource_revision = 1 and x.grant_revision = 1) then
		raise exception 'Compare-and-set and least(): %', (select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v2) x); end if;
	-- An expired grant that is replaced: its row is retired once too.
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set created_at = clock_timestamp() - interval ''2 seconds'',
		expires_at = clock_timestamp() - interval ''1 second'' where id = %L', v_g3));
	v_g4 := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read','write']) ->> 'grantId';
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v2)) <> 1
		or exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g3)
		or not exists (select 1 from pg_temp.reads(v2) x where x.grant_id = v_g4)
		or public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v2)) <> 0 then
		raise exception 'An expired grant, replaced, is retired once: %', (select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v2) x); end if;
end $$;


-- Agent wakes: coworker runs, who pays, the parent's reads, worker dispatch and completion, coding sessions, and
-- what still waits (office activation).
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	c_refused constant jsonb := '[{"op":"mkdir","path":"refused"}]';
	p jsonb; v jsonb; r jsonb; w uuid; v_secret uuid; v_gb uuid; v_ga uuid; c public.qorpera_folder_commits%rowtype; n bigint;
begin
	-- Agent B's run messages agent A; A's run saves as A for the same requester.
	p := pg_temp.run(c_b, 'human', c_member);
	v := pg_temp.run(c_a, 'agent', c_member, 'coworker', p);
	r := pg_temp.commit(v, 'coworker-1', '[{"op":"mkdir","path":"by-coworker"}]');
	perform pg_temp.expect(r, 1, 'saved');
	select * into c from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid;
	if c.actor_id <> c_a or c.requester_id <> c_member or c.session_kind <> 'in_house' then raise exception 'Coworker commit: %', to_jsonb(c); end if;
	-- No standing authority is needed: with none, the same kind of wake saves. One paid by another member's login refuses.
	perform pg_temp.fx('delete from public.qorpera_staff_execution_authorities where profile_id = ''63400000-0000-4000-8000-000000000010''');
	perform pg_temp.expect(pg_temp.commit(pg_temp.run(c_a, 'agent', c_member, 'coworker', p), 'coworker-no-authority',
		'[{"op":"mkdir","path":"by-coworker-2"}]'), 1, 'saved');
	v := pg_temp.run(c_a, 'agent', c_member, 'coworker', p);
	perform pg_temp.fx(format('update public.qorpera_execution_runs set sponsor_binding_id = %L where id = %L',
		'63400000-0000-4000-8000-0000000000b4', v ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set sponsor_binding_id = %L where run_id = %L',
		'63400000-0000-4000-8000-0000000000b4', v ->> 'runId'));
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'coworker-other-login', c_refused), '42501');

	-- The parent read what the recipient cannot: refused. Once the recipient may read it, the same wake saves. A
	-- changed parent row re-resolves the parent's paths for the recipient.
	v_secret := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'secret', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_gb := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_secret, 'staff_agent', c_b, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'secret-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','secret'),
		jsonb_build_object('op','write','path','secret/s.txt','file',pg_temp.stage('secret')))), 2, 'saved');
	p := pg_temp.run(c_b, 'human', c_member);
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('secret/s.txt', p) -> 'entry'));
	v := pg_temp.run(c_a, 'agent', c_member, 'coworker', p);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'coworker-secret-1', c_refused), '42501');
	v_ga := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_secret, 'staff_agent', c_a, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit(v, 'coworker-secret-2', '[{"op":"mkdir","path":"cw-secret-2"}]'), 1, 'saved');
	-- While the parent's rows are unchanged the check reads resources and re-resolves no path; once one changed, it does
	-- (since P24b, 20260930019500, every path at once through qorpera_folder_paths_authority, a SQL function).
	set local track_functions = 'all';
	n := coalesce((select calls from pg_stat_xact_user_functions where schemaname = 'public' and funcname = 'qorpera_folder_paths_authority'), 0);
	if not public.qorpera_folder_parent_reads_allowed((select o from public.qorpera_wake_occurrences o where o.run_id = (v ->> 'runId')::uuid))
		or coalesce((select calls from pg_stat_xact_user_functions where schemaname = 'public'
			and funcname = 'qorpera_folder_paths_authority'), 0) <> n then
		raise exception 'An unchanged parent row re-resolves no path'; end if;
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_secret, v_gb);
	if not public.qorpera_folder_parent_reads_allowed((select o from public.qorpera_wake_occurrences o where o.run_id = (v ->> 'runId')::uuid))
		or coalesce((select calls from pg_stat_xact_user_functions where schemaname = 'public'
			and funcname = 'qorpera_folder_paths_authority'), 0) = n then
		raise exception 'A changed parent row re-resolves its paths for the recipient'; end if;
	perform pg_temp.expect(pg_temp.commit(v, 'coworker-secret-3', '[{"op":"mkdir","path":"cw-secret-3"}]'), 1, 'saved');
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_secret, v_ga);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', v, 'coworker-secret-4', c_refused), '42501');

	-- A worker of agent A, dispatched by A's run: its run and its completion save; a read-access worker writes nothing.
	p := pg_temp.run(c_a, 'human', c_member);
	w := pg_temp.worker(c_a, p, 'in-house', 'write');
	perform pg_temp.expect(pg_temp.commit(pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, w), 'worker-1',
		'[{"op":"mkdir","path":"by-worker"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.run(c_a, 'agent', c_member, 'worker-completion', p, w), 'completion-1',
		'[{"op":"mkdir","path":"by-completion"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p,
		pg_temp.worker(c_a, p, 'in-house', 'read')), 'worker-reader', '[{"op":"mkdir","path":"by-reader"}]'), 1, 'denied', 'denied');

	-- A coding session is paid by its owner's login, writes code/ but not agents/, and is never reviewed. One not paid
	-- by its owner's login, or whose owner is not its requester, does not act.
	r := pg_temp.commit(pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, pg_temp.worker(c_a, p, 'coding', 'read', c_member)),
		'coding-1', '[{"op":"mkdir","path":"code"},{"op":"mkdir","path":"agents"}]');
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	select * into c from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid;
	if c.session_kind <> 'coding' or c.review_id is not null then raise exception 'Coding commit: %', to_jsonb(c); end if;
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p,
		pg_temp.worker(c_a, p, 'coding', 'read', c_member, '63400000-0000-4000-8000-0000000000b4')), 'coding-other-login', c_refused),
		'42501');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p,
		pg_temp.worker(c_a, p, 'coding', 'read', '63400000-0000-4000-8000-000000000004')), 'coding-other-owner', c_refused), '42501');

	-- A machine event still waits for C1c-3i part b. An office activation serves folder-v2 since C1c-3l part 2
	-- (20260930030100, 892); this hand-built one has no waiter behind it, so its ancestry refuses it.
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.run(c_a, 'agent', c_member, 'machine-event', p),
		'machine-1', c_refused), '0A000');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.run(c_a, 'agent', c_member, 'office-activation', p),
		'office-1', c_refused), '42501');
	if exists (select 1 from public.qorpera_folder_entries where environment_id = c_env and key_text = 'refused') then
		raise exception 'A refused run applied a unit'; end if;
end $$;


-- A match change from exact to subtree moves paths from the parent to the resource: a run that read one under the
-- parent is re-checked by its next recheck and its next release, and refused where it may no longer read.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	v jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002'); e jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'finance-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','finance'),
		jsonb_build_object('op','write','path','finance/q.txt','file',pg_temp.stage('ledger')))), 2, 'saved');
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'finance', 'exact', 'company_shared', 'normal');
	e := pg_temp.read('finance/q.txt', v) -> 'entry';
	if e -> 'authority' ->> 'resourceId' <> (pg_temp.root()).id::text then raise exception 'An exact resource covers only itself: %', e; end if;
	perform pg_temp.release(v, extensions.gen_random_uuid(), jsonb_build_array(e));
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'finance', 'subtree', 'company_shared', 'normal');
	if (pg_temp.read('finance/q.txt', v) ->> 'found')::boolean then raise exception 'The agent has no grant on finance/'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', c_env, c_profile, pg_temp.resolved(v)),
		'42501');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), jsonb_build_array(e)), '42501');
end $$;


-- The seeded root and rules/ are fixed: no resource at or under rules/, no change to it or the root, no revoke of
-- either, no grant on rules/.
do $$
declare c_env constant uuid := '63400000-0000-4000-8000-000000000020'; v_rules uuid;
begin
	select id into v_rules from public.qorpera_company_path_resources where environment_id = c_env and path = 'rules';
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		'rules', 'subtree', 'company_shared', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(5),
		'rules/tone.md', 'exact', 'company_shared', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		'Rules/Team', 'subtree', 'company_shared', 'normal'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1),
		'', 'subtree', 'company_shared', 'normal'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_revoke(%L, %L, %L)', c_env, pg_temp.member(1), v_rules), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', c_env, pg_temp.member(1), v_rules,
		'staff_agent', '63400000-0000-4000-8000-0000000000a1', array['read','write']), '42501');
	if (select scope from public.qorpera_company_path_resources where id = v_rules) <> 'company_rules' then
		raise exception 'rules/ keeps its scope'; end if;
end $$;


-- A receipt is the caller's word: an ancestor resource, a missing grant, or another agent's grant does not pass. Where
-- the agent cannot read the path, the release refuses; where it can, the real pair is recorded. A forged row with
-- no grant is re-resolved and retired by the recheck.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	v jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	v_root public.qorpera_company_path_resources%rowtype := pg_temp.root(); v_vault uuid; v_gb uuid; v_ga uuid;
begin
	v_vault := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'vault2', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_gb := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_vault, 'staff_agent', c_b, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'vault2-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','vault2'),
		jsonb_build_object('op','write','path','vault2/x.txt','file',pg_temp.stage('vault')))), 2, 'saved');
	v_root := pg_temp.root();
	v_ga := (pg_temp.agent_grant(v_root.id, c_a)).id;
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object(
		'path', 'vault2/x.txt', 'authority', jsonb_build_object('resourceId', v_root.id, 'resourceRevision', v_root.authority_revision)))), '42501');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object(
		'path', 'vault2/x.txt', 'authority', jsonb_build_object('resourceId', v_vault, 'resourceRevision', 1, 'grantId', v_gb,
			'grantRevision', 1)))), '42501');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object(
		'path', 'vault2/x.txt', 'authority', jsonb_build_object('resourceId', v_root.id, 'resourceRevision', v_root.authority_revision,
			'grantId', v_ga, 'grantRevision', 1)))), '42501');
	perform pg_temp.release(v, extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', 'shared/a.txt',
		'authority', jsonb_build_object('resourceId', v_root.id, 'resourceRevision', v_root.authority_revision))));
	if exists (select 1 from pg_temp.reads(v) x where x.grant_id is null)
		or not exists (select 1 from pg_temp.reads(v) x where x.resource_id = v_root.id and x.grant_id = v_ga) then
		raise exception 'A forged receipt for a readable path records the real pair: %', (select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v) x); end if;
	perform public.qorpera_folder_write_read_set(c_env, (v ->> 'runId')::uuid, jsonb_build_array(jsonb_build_object('resourceId', v_root.id,
		'grantId', null, 'resourceRevision', v_root.authority_revision, 'grantRevision', null)), null, null);
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(v)) < 1
		or exists (select 1 from pg_temp.reads(v) x where x.grant_id is null) then
		raise exception 'A row with no grant outside rules/ is retired: %', (select jsonb_agg(to_jsonb(x)) from pg_temp.reads(v) x); end if;
end $$;


-- A re-resolution takes its check and its receipt in one statement. That keeps the receipt no newer than the check
-- only while the receipt's helpers read the statement's snapshot, so none of them may become volatile.
do $$
begin
	if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and provolatile = 'v'
		and proname in ('qorpera_folder_read_receipt', 'qorpera_folder_path_resource', 'qorpera_folder_agent_grant',
			'qorpera_folder_paths_resources', 'qorpera_folder_paths_authority')) then
		raise exception 'The read receipt helpers must stay stable'; end if;
	-- P24b (20260930019500): the set-based twins give the receipts of a re-resolution now.
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
		and proname in ('qorpera_folder_read_receipt', 'qorpera_folder_path_resource', 'qorpera_folder_agent_grant',
			'qorpera_folder_paths_resources', 'qorpera_folder_paths_authority')) <> 5 then
		raise exception 'The read receipt helpers are missing'; end if;
end $$;


-- Journal order is authority order: every clock value is used by exactly one journal row, change set or authority.
do $$
begin
	if (select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020')
		<> (select count(*) from public.qorpera_folder_journal where environment_id = '63400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_journal j where j.environment_id = '63400000-0000-4000-8000-000000000020'
			and j.kind = 'authority' and not exists (select 1 from public.qorpera_folder_authority_changes c
				where c.environment_id = j.environment_id and c.seq = j.seq)) then
		raise exception 'Journal and clock'; end if;
end $$;

rollback;
