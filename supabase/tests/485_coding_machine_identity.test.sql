-- The coding machine's identity (20260930394000; F3 step 5, slice 5a: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
-- "Views and machines"). One member's sessions share a machine only for the same coding agent, repository (GitHub's
-- names in any case) and setup digest; a session keeps its machine when the setup changes. A turn runs only on a machine
-- of its session's agent and repository, as the session's own uid; a machine stays while its own sessions are open.
-- A company on the folder, one member, one executor with its node and coding provider, and seven leased sessions:
--   s1 agent a1, acme/app; s2 agent a1, Acme/App; s3 agent a2, acme/app; s4 agent a1, acme/web; s5 to s7 agent a1, acme/app.
-- H adds the read set (20260930445000): a turn already leased moves onto a machine with its session and takes in the
-- machine's reads.
begin;

insert into auth.users(id, email) values ('48500000-0000-4000-8000-000000000001', 'coding-identity@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('48500000-0000-4000-8000-000000000010', 'Coding identity', '48500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('48500000-0000-4000-8000-000000000010', '48500000-0000-4000-8000-000000000001', 'coding-identity@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('48500000-0000-4000-8000-000000000020', '48500000-0000-4000-8000-000000000010', 'Environment', 1,
	'48500000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('48500000-0000-4000-8000-000000000020') \g /dev/null

-- The node (ready, with its inventory receipt) and a coding provider of 2 CPUs and 4 GiB on it; the executor, its
-- policies and the five workers and sessions. Foreign keys and triggers are off only while they go in.
set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('48500000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-485', 'UTF8')), 'hex'), 'node-485', 1, 16000,
	68719476736, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
values ('48500000-0000-4000-8000-0000000000e1', '48500000-0000-4000-8000-0000000000e2', clock_timestamp(),
	'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('48500000-0000-4000-8000-0000000000e1', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
values ('48500000-0000-4000-8000-0000000000e1', '48500000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('coding', 'coding-485', '48500000-0000-4000-8000-0000000000e1', repeat('d', 64), 2000, 4294967296);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy)
values ('48500000-0000-4000-8000-000000000020', 'exec-485', true, array['codex'], encode(sha256(convert_to('node-485', 'UTF8')), 'hex'),
	jsonb_build_object('providerId', 'coding-485', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
		'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
		'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
	'{"rootPath":"/nas/coding"}');
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('48500000-0000-4000-8000-0000000000c' || n)::uuid, '48500000-0000-4000-8000-000000000010', '48500000-0000-4000-8000-000000000020',
	('48500000-0000-4000-8000-0000000000a' || case n when 3 then 2 else 1 end)::uuid, extensions.gen_random_uuid(), 'w-485-' || n, 'coding',
	'Code', 'read', 'each', '{}', '48500000-0000-4000-8000-000000000001', extensions.gen_random_uuid(),
	'48500000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 1
from generate_series(1, 7) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at)
select ('48500000-0000-4000-8000-0000000000c' || n)::uuid, '48500000-0000-4000-8000-000000000010', '48500000-0000-4000-8000-000000000020',
	'codex', jsonb_build_object('host', 'github.com', 'owner', case n when 2 then 'Acme' else 'acme' end,
		'name', case n when 2 then 'App' when 4 then 'web' else 'app' end, 'baseBranch', 'main'),
	'qorpera/coding/485-' || n, 'preparing', 'exec-485', extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes', clock_timestamp()
from generate_series(1, 7) n;
set local session_replication_role = origin;

create function pg_temp.ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Coding machine identity: %', p_message; end if; end $$;
create function pg_temp.node() returns text language sql as $$ select encode(sha256(convert_to('node-485', 'UTF8')), 'hex') $$;
create function pg_temp.worker(p_n integer) returns uuid language sql as $$ select ('48500000-0000-4000-8000-0000000000c' || p_n)::uuid $$;
create function pg_temp.digest(p_n integer) returns text language sql as $$ select repeat(p_n::text, 64) $$;
-- The plan as the executor sends it, with a setup digest.
create function pg_temp.plan(p_n integer, p_digest text) returns jsonb language sql as $$
	select public.qorpera_plan_coding_machine(pg_temp.worker(p_n),
		(select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)), pg_temp.node(), p_digest)
$$;
-- The session's exact NAS folders, as the executor binds them.
create function pg_temp.storage(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-storage/v1', 'volumeId', worker.id, 'workerId', worker.id,
		'companyId', worker.profile_id, 'environmentId', worker.environment_id, 'writerGeneration', 1, 'machineIdSha256', pg_temp.node(),
		'policy', '{"rootPath":"/nas/coding"}'::jsonb, 'dataSource', root || '/data', 'custodySource', root || '/guest-state',
		'dataTarget', '/workspace', 'custodyTarget', '/var/lib/qorpera-coding')
	from public.qorpera_runtime_workers worker,
		lateral (select '/nas/coding/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) folder
	where worker.id = pg_temp.worker(p_n)
$$;
-- A turn's run authority on the machine of a plan's binding.
create function pg_temp.run(p_n integer, p_binding text) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_run(pg_temp.worker(p_n),
		(select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)), p_binding, pg_temp.storage(p_n),
		pg_temp.node())
$$;
-- The SQLSTATE and message a statement raises, or 'ok'.
create function pg_temp.error(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
-- A turn dispatched to the session's worker, its job leased until p_until: the job, run and wake by hand, as in 634.
create function pg_temp.turn(p_n integer, p_until timestamptz) returns uuid language plpgsql as $$
declare v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_profile uuid := '48500000-0000-4000-8000-000000000010'; v_env uuid := '48500000-0000-4000-8000-000000000020';
	v_user uuid := '48500000-0000-4000-8000-000000000001'; v_staff uuid := '48500000-0000-4000-8000-0000000000a1';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', v_user,
		'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('a', 64), p_until, v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
	values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(), v_staff, 1,
		extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_user, v_user, 'openai', 'gpt-test',
		'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
	values (v_wake, v_profile, v_env, 'worker-dispatch', v_wake::text, clock_timestamp(), clock_timestamp(), 'agent', 'worker-dispatch',
		pg_temp.worker(p_n), v_run, 'materialized', v_staff, 1, v_user, extensions.gen_random_uuid(), 1, extensions.gen_random_uuid(),
		array[v_staff], 0, extensions.gen_random_uuid(), '{}');
	set local session_replication_role = origin;
	return v_run;
end $$;

do $$
declare v_m1 jsonb; v_m2 jsonb; v_m3 jsonb; v_m4 jsonb; v_m5 jsonb; v_again jsonb; v_run1 jsonb; v_run2 jsonb; v_machine public.qorpera_coding_machines%rowtype;
	v_turn6 uuid; v_turn7 uuid; v_read jsonb; v_take uuid;
begin
	-- A. The three-argument plan is gone; the executor's named three still reach the new one. A digest must be one.
	perform pg_temp.ok(to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text)') is null, 'the three-argument plan went');
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.plan(1, %L)', 'not-a-digest')) = '22023 Coding machine input invalid',
		'a setup digest that is not one is refused');

	-- B. Same agent, repository and digest: the same machine, whatever the repository's case. Another agent, another
	-- repository or another digest: another machine each.
	v_m1 := pg_temp.plan(1, pg_temp.digest(1));
	v_m2 := pg_temp.plan(2, pg_temp.digest(1));
	v_m3 := pg_temp.plan(3, pg_temp.digest(1));
	v_m4 := pg_temp.plan(4, pg_temp.digest(1));
	v_m5 := pg_temp.plan(5, pg_temp.digest(2));
	perform pg_temp.ok(v_m1 ->> 'state' = 'planned' and v_m1 ? 'bindingText', format('s1 plans a new machine: %s', v_m1));
	perform pg_temp.ok(v_m2 ->> 'machineId' = v_m1 ->> 'machineId', 'the same agent, repository and digest share the machine');
	perform pg_temp.ok(v_m3 ->> 'state' = 'planned' and v_m3 ->> 'machineId' <> v_m1 ->> 'machineId', 'another agent has another machine');
	perform pg_temp.ok(v_m4 ->> 'state' = 'planned' and v_m4 ->> 'machineId' not in (v_m1 ->> 'machineId', v_m3 ->> 'machineId'),
		'another repository has another machine');
	perform pg_temp.ok(v_m5 ->> 'state' = 'planned'
		and v_m5 ->> 'machineId' not in (v_m1 ->> 'machineId', v_m3 ->> 'machineId', v_m4 ->> 'machineId'),
		'another setup digest has another machine');
	select * into v_machine from public.qorpera_coding_machines where id = (v_m1 ->> 'machineId')::uuid;
	perform pg_temp.ok(v_machine.staff_agent_id = '48500000-0000-4000-8000-0000000000a1' and v_machine.repository = 'acme/app'
		and v_machine.setup_digest = pg_temp.digest(1) and v_machine.number = 1, 'the machine records its agent, repository, digest and place');
	perform pg_temp.ok((select count(*) from public.qorpera_coding_machines where profile_id = '48500000-0000-4000-8000-000000000010') = 4,
		'four machines for four identities');

	-- C. A changed setup moves only a new session: s1, planned onto its machine, keeps it; s2, never on it, goes to
	-- the new digest's machine.
	v_again := pg_temp.plan(1, pg_temp.digest(2));
	perform pg_temp.ok(v_again ->> 'machineId' = v_m1 ->> 'machineId', 'a session keeps its machine when the setup changes');
	v_again := pg_temp.plan(2, pg_temp.digest(2));
	perform pg_temp.ok(v_again ->> 'machineId' = v_m5 ->> 'machineId', 'a session not yet on a machine takes the new setup''s');

	-- D. A turn runs only on a machine of its session's agent and repository.
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.run(3, %L)', v_m1 ->> 'bindingText')) = '42501 Coding machine scope differs',
		'another agent''s turn is refused on the machine');
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.run(4, %L)', v_m1 ->> 'bindingText')) = '42501 Coding machine scope differs',
		'another repository''s turn is refused on the machine');

	-- E. Each session has its own uid from 200000, kept across turns, and none on its NAS volume.
	v_run1 := pg_temp.run(1, v_m1 ->> 'bindingText');
	v_run2 := pg_temp.run(2, v_m1 ->> 'bindingText');
	perform pg_temp.ok(v_run1 ->> 'intent' = 'run' and v_run2 ->> 'intent' = 'run', format('both turns run: %s %s', v_run1, v_run2));
	perform pg_temp.ok((v_run1 ->> 'guestUid')::integer >= 200000 and (v_run2 ->> 'guestUid')::integer >= 200000
		and v_run1 ->> 'guestUid' <> v_run2 ->> 'guestUid', 'two sessions on a machine have two uids from 200000');
	perform pg_temp.ok(pg_temp.run(1, v_m1 ->> 'bindingText') ->> 'guestUid' = v_run1 ->> 'guestUid', 'a session keeps its uid');
	perform pg_temp.ok((select count(*) from public.qorpera_coding_session_uids
		where worker_id in (pg_temp.worker(1), pg_temp.worker(2))) = 2, 'one uid row per session');
	perform pg_temp.ok(not exists (select 1 from public.qorpera_coding_storage_volumes
		where worker_id in (pg_temp.worker(1), pg_temp.worker(2)) and guest_uid is not null), 'a NAS volume holds no uid');

	-- F. A machine stays while its own sessions are open: another of the member's sessions, elsewhere, does not keep it.
	select * into v_machine from public.qorpera_coding_machines where id = (v_m3 ->> 'machineId')::uuid;
	perform pg_temp.ok(public.qorpera_coding_member_has_open_session(v_machine), 's3 keeps its machine while open');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member' where worker_id = pg_temp.worker(3);
	set local session_replication_role = origin;
	perform pg_temp.ok(not public.qorpera_coding_member_has_open_session(v_machine), 'an archived session no longer keeps its machine');
	select * into v_machine from public.qorpera_coding_machines where id = (v_m1 ->> 'machineId')::uuid;
	perform pg_temp.ok(public.qorpera_coding_member_has_open_session(v_machine), 's1 and s2 keep theirs');

	-- G. The current-machine index is unique over the member, agent, repository, digest and place.
	perform pg_temp.ok((select index.indisunique and index.indnatts = 7 from pg_index index
		where index.indexrelid = 'public.qorpera_coding_machines_current'::regclass), 'the current-machine index has seven columns');

	-- H. A session moving onto m1 brings its leased turn, which takes in m1's read set under m1's release for that run,
	-- with an all-zero output. m1 holds a released read of rules/coding.md (every agent may read rules/), its receipt as
	-- the turn's own reader gets it. s7's turn is no longer leased: it takes in nothing.
	v_turn6 := pg_temp.turn(6, clock_timestamp() + interval '1 hour');
	v_turn7 := pg_temp.turn(7, clock_timestamp() - interval '1 second');
	v_read := jsonb_build_object('path', 'rules/coding.md', 'version', '1', 'authority', public.qorpera_folder_read_receipt(
		'48500000-0000-4000-8000-000000000020', '48500000-0000-4000-8000-000000000010',
		public.qorpera_folder_run_reader('48500000-0000-4000-8000-000000000010', v_turn6), 'rules/coding.md'));
	insert into public.qorpera_coding_machine_read_records(coding_machine_id, release_id, environment_id, resource_id, reads, output_sha256)
	values ((v_m1 ->> 'machineId')::uuid, extensions.gen_random_uuid(), '48500000-0000-4000-8000-000000000020',
		(v_read -> 'authority' ->> 'resourceId')::uuid, jsonb_build_array(v_read), repeat('3', 64));
	perform pg_temp.ok(v_read -> 'authority' ->> 'grantId' is null and not exists (select 1 from public.qorpera_folder_run_read_records
		where run_id = v_turn6), format('rules/ needs no grant, and s6''s turn has no records before it moves: %s', v_read));
	perform pg_temp.ok(pg_temp.run(6, v_m1 ->> 'bindingText') ->> 'intent' = 'run'
		and pg_temp.run(7, v_m1 ->> 'bindingText') ->> 'intent' = 'run', 's6 and s7 move onto m1');
	v_take := md5('coding-machine:' || v_turn6 || ':' || (v_m1 ->> 'machineId'))::uuid;
	perform pg_temp.ok(exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn6 and release_id = v_take
		and resource_id = (v_read -> 'authority' ->> 'resourceId')::uuid and output_sha256 = repeat('0', 64)
		and reads = jsonb_build_array(v_read)), 'the moved turn''s records hold m1''s read under m1''s release for the run');
	perform pg_temp.ok(exists (select 1 from public.qorpera_folder_run_reads where run_id = v_turn6 and grant_id is null
		and resource_id = (v_read -> 'authority' ->> 'resourceId')::uuid
		and resource_revision = (v_read -> 'authority' ->> 'resourceRevision')::bigint), 'the moved turn has the read''s pair');
	perform pg_temp.ok(not exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn7)
		and not exists (select 1 from public.qorpera_folder_run_reads where run_id = v_turn7), 'a turn no longer leased takes in nothing');
end $$;

rollback;
