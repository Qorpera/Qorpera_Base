-- Runtime contention hardening: per-function lock budgets, fence-free GC
-- candidate selection, and stale managed runner retirement.

-- 1. Authority-critical RPCs declare their own lock and statement budgets.
do $$
declare
	v_target regprocedure;
	v_config text[];
begin
	foreach v_target in array array[
		'public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure,
		'public.qorpera_renew_runner_job(uuid,text,uuid,text)'::regprocedure,
		'public.qorpera_assign_runner_job(uuid,uuid,uuid,uuid,text,integer)'::regprocedure,
		'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure,
		'public.qorpera_release_runtime_machine(uuid,text,text)'::regprocedure,
		'public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure
	] loop
		select proconfig into v_config from pg_catalog.pg_proc where oid = v_target;
		if v_config is null
			or not (v_config @> array['lock_timeout=25s', 'statement_timeout=25s'])
			or not ('search_path=""' = any (v_config)) then
			raise exception '% does not declare the 25 s lock/statement budget: %', v_target, v_config;
		end if;
	end loop;
	select proconfig into v_config from pg_catalog.pg_proc
	where oid = 'public.qorpera_claim_company_object_gc(integer,uuid)'::regprocedure;
	if not ('statement_timeout=8s' = any (v_config)) or not ('search_path=""' = any (v_config)) then
		raise exception 'company object GC does not declare its 8 s budget: %', v_config;
	end if;
end
$$;

-- A function-level statement_timeout does not re-arm the timer the calling
-- statement armed from the session (role) value: the role-level 8 s remains
-- the effective ceiling until it is raised. This is what the deployment
-- step must change; the per-function lock_timeout below is effective now.
create function pg_temp.slow_under_function_budget()
returns text language plpgsql set statement_timeout = '10s' as $$
begin
	perform pg_sleep(1);
	return 'completed';
end
$$;
set statement_timeout = '300ms';
do $$
declare
	v_cancelled boolean := false;
begin
	begin
		perform pg_temp.slow_under_function_budget();
	exception when query_canceled then
		v_cancelled := true;
	end;
	if not v_cancelled then
		raise exception 'function-level statement_timeout unexpectedly overrode the armed session timer';
	end if;
end
$$;
reset statement_timeout;

-- A function-level lock_timeout is honoured for each lock wait inside the
-- function, even when the session value is shorter.
create table public.lock_budget_probe_360 (id integer primary key);
insert into public.lock_budget_probe_360 values (1);
select dblink_connect('contention_locker', 'dbname=qorpera_test');
select dblink_exec('contention_locker', 'begin');
select * from dblink('contention_locker', 'select id from public.lock_budget_probe_360 where id = 1 for update') as locked(id integer);
create function pg_temp.wait_under_function_lock_budget_shared()
returns text language plpgsql set lock_timeout = '1s' as $$
begin
	perform 1 from public.lock_budget_probe_360 where id = 1 for update;
	return 'locked';
end
$$;
set lock_timeout = '100ms';
do $$
declare
	v_started timestamptz := clock_timestamp();
	v_waited interval;
	v_timed_out boolean := false;
begin
	begin
		perform pg_temp.wait_under_function_lock_budget_shared();
	exception when lock_not_available then
		v_timed_out := true;
	end;
	v_waited := clock_timestamp() - v_started;
	if not v_timed_out or v_waited < interval '800 milliseconds' then
		raise exception 'function-level lock_timeout was not honoured (timed out: %, waited: %)', v_timed_out, v_waited;
	end if;
end
$$;
reset lock_timeout;
select dblink_exec('contention_locker', 'rollback');
drop table public.lock_budget_probe_360;

-- 2. Company object GC fixture: three companies with aged objects.
insert into auth.users (id, email, raw_user_meta_data)
values ('36000000-0000-4000-8000-000000000001', 'contention-owner@example.test', '{"full_name":"Contention Owner"}');

select set_config(
	'request.jwt.claims',
	'{"sub":"36000000-0000-4000-8000-000000000001","email":"contention-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config('qorpera_test.contention_gc_active',
	public.qorpera_create_cloud_company('36000000-0000-4000-8000-000000000010', 'Deletion active company', 2)::text, false);
select set_config('qorpera_test.contention_gc_retained',
	public.qorpera_create_cloud_company('36000000-0000-4000-8000-000000000011', 'Fully retained company', 2)::text, false);
select set_config('qorpera_test.contention_gc_candidate',
	public.qorpera_create_cloud_company('36000000-0000-4000-8000-000000000012', 'Candidate company', 2)::text, false);
reset role;

-- Object graph ownership is enforced against the root creator's identity, so
-- the fixture keeps the owner's claims while it inserts artifacts and graphs.
do $$
declare
	v_active uuid := (current_setting('qorpera_test.contention_gc_active')::jsonb ->> 'profile_id')::uuid;
	v_retained uuid := (current_setting('qorpera_test.contention_gc_retained')::jsonb ->> 'profile_id')::uuid;
	v_retained_environment uuid := (current_setting('qorpera_test.contention_gc_retained')::jsonb ->> 'environment_id')::uuid;
	v_candidate uuid := (current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'profile_id')::uuid;
	v_candidate_environment uuid := (current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'environment_id')::uuid;
	v_owner uuid := '36000000-0000-4000-8000-000000000001';
begin
	-- Oldest aged object: this profile is visited first but is under an
	-- active deletion lease, so it must be skipped without its fence.
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend, created_at)
	values (v_active, repeat('a', 64), 11, 'nas-object-gateway', statement_timestamp() - interval '3 days');
	insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
	values (v_active, '36000000-0000-4000-8000-000000000080', statement_timestamp() + interval '10 minutes');
	-- Second: every aged object is retained by a live artifact root.
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend, created_at)
	values (v_retained, repeat('e', 64), 13, 'nas-object-gateway', statement_timestamp() - interval '60 hours');
	-- Third: one reclaimable aged object, one retained aged object, one fresh object.
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend, created_at)
	values
		(v_candidate, repeat('b', 64), 17, 'nas-object-gateway', statement_timestamp() - interval '2 days'),
		(v_candidate, repeat('c', 64), 19, 'nas-object-gateway', statement_timestamp() - interval '2 days'),
		(v_candidate, repeat('d', 64), 23, 'nas-object-gateway', statement_timestamp() - interval '1 hour');
	insert into public.qorpera_artifacts (
		id, profile_id, environment_id, client_artifact_id, artifact_type, name,
		root_object_sha256, content_sha256, bytes, media_type, created_by_user_id, root_contract
	) values
		('36000000-0000-4000-8000-000000000030', v_retained, v_retained_environment,
			'36000000-0000-4000-8000-000000000031', 'fixture', 'retained-e.bin',
			repeat('e', 64), repeat('e', 64), 13, 'application/octet-stream', v_owner, 'qorpera.object/v1'),
		('36000000-0000-4000-8000-000000000032', v_candidate, v_candidate_environment,
			'36000000-0000-4000-8000-000000000033', 'fixture', 'retained-c.bin',
			repeat('c', 64), repeat('c', 64), 19, 'application/octet-stream', v_owner, 'qorpera.object/v1');
	insert into public.qorpera_object_reachability_graphs (
		id, profile_id, environment_id, root_kind, root_id, client_graph_id,
		root_object_sha256, contract_version, content_sha256, object_count,
		storage_bytes, status, created_by_user_id, completed_at, closure_verified
	) values
		('36000000-0000-4000-8000-000000000040', v_retained, v_retained_environment,
			'artifact', '36000000-0000-4000-8000-000000000030', '36000000-0000-4000-8000-000000000041',
			repeat('e', 64), 1, encode(extensions.digest(convert_to(repeat('e', 64) || ':13', 'utf8'), 'sha256'), 'hex'),
			1, 13, 'complete', v_owner, statement_timestamp(), true),
		('36000000-0000-4000-8000-000000000042', v_candidate, v_candidate_environment,
			'artifact', '36000000-0000-4000-8000-000000000032', '36000000-0000-4000-8000-000000000043',
			repeat('c', 64), 1, encode(extensions.digest(convert_to(repeat('c', 64) || ':19', 'utf8'), 'sha256'), 'hex'),
			1, 19, 'complete', v_owner, statement_timestamp(), true);
	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	values
		('36000000-0000-4000-8000-000000000040', repeat('e', 64), 13),
		('36000000-0000-4000-8000-000000000042', repeat('c', 64), 19);
	if exists (
		select 1 from public.qorpera_company_retained_object_hashes(v_candidate) as retained
		where retained.object_sha256 in (repeat('b', 64), repeat('d', 64))
	) or not exists (
		select 1 from public.qorpera_company_retained_object_hashes(v_candidate) as retained
		where retained.object_sha256 = repeat('c', 64)
	) or not exists (
		select 1 from public.qorpera_company_retained_object_hashes(v_retained) as retained
		where retained.object_sha256 = repeat('e', 64)
	) then
		raise exception 'GC fixture retention does not isolate exactly the artifact roots';
	end if;
end
$$;
select set_config('request.jwt.claims', '', false);

-- The function body selects candidates and evaluates retention before the
-- single fence call, which sits directly ahead of the lease insert.
do $$
declare
	v_body text := pg_get_functiondef('public.qorpera_claim_company_object_gc(integer,uuid)'::regprocedure);
	v_fence integer := position('qorpera_lock_profile_gc_fence(' in v_body);
	v_candidates integer := position('order by min(object.created_at), object.profile_id' in v_body);
	v_retention integer := position('qorpera_company_retained_object_hashes(' in v_body);
	v_lease integer := position('insert into public.qorpera_company_object_gc_leases' in v_body);
begin
	if v_fence = 0 or v_candidates = 0 or v_retention = 0 or v_lease = 0 then
		raise exception 'company object GC body markers are missing';
	end if;
	if (length(v_body) - length(replace(v_body, 'qorpera_lock_profile_gc_fence(', ''))) / length('qorpera_lock_profile_gc_fence(') <> 1 then
		raise exception 'company object GC takes the profile GC fence more than once';
	end if;
	if v_fence < v_candidates or v_fence < v_retention or v_fence > v_lease then
		raise exception 'company object GC takes the profile GC fence before selecting candidates';
	end if;
end
$$;

-- Skipped profiles are never fenced: with both skipped profiles' rows locked
-- by another session, the claim proceeds to the eligible profile.
select dblink_exec('contention_locker', 'begin');
select * from dblink('contention_locker', format(
	$$select id from public.qorpera_profiles where id in (%L, %L) for update$$,
	current_setting('qorpera_test.contention_gc_active')::jsonb ->> 'profile_id',
	current_setting('qorpera_test.contention_gc_retained')::jsonb ->> 'profile_id'
)) as locked(id uuid);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
set lock_timeout = '2s';
do $$
declare
	v_candidate uuid := (current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'profile_id')::uuid;
	v_lease uuid := '36000000-0000-4000-8000-000000000081';
	v_claim jsonb;
begin
	v_claim := public.qorpera_claim_company_object_gc(10, v_lease);
	if v_claim ->> 'profile_id' is distinct from v_candidate::text
		or v_claim ->> 'lease_id' is distinct from v_lease::text
		or jsonb_array_length(v_claim -> 'objects') <> 1
		or v_claim -> 'objects' -> 0 ->> 'sha256' is distinct from repeat('b', 64)
		or (v_claim -> 'objects' -> 0 ->> 'bytes')::bigint <> 17
		or v_claim -> 'objects' -> 0 ->> 'backend' <> 'nas-object-gateway' then
		raise exception 'company object GC did not isolate the reclaimable aged object: %', v_claim;
	end if;
	if public.qorpera_claim_company_object_gc(10, '36000000-0000-4000-8000-000000000082') is not null then
		raise exception 'company object GC leased a profile twice or leased a fully retained profile';
	end if;
end
$$;
reset lock_timeout;
reset role;
select set_config('request.jwt.claims', '', false);
select dblink_exec('contention_locker', 'rollback');

do $$
declare
	v_active uuid := (current_setting('qorpera_test.contention_gc_active')::jsonb ->> 'profile_id')::uuid;
	v_retained uuid := (current_setting('qorpera_test.contention_gc_retained')::jsonb ->> 'profile_id')::uuid;
	v_candidate uuid := (current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'profile_id')::uuid;
begin
	if (select lease_id from public.qorpera_company_object_gc_leases where profile_id = v_active)
		is distinct from '36000000-0000-4000-8000-000000000080'::uuid then
		raise exception 'deletion-active profile lease was disturbed';
	end if;
	if exists (select 1 from public.qorpera_company_object_gc_leases where profile_id = v_retained) then
		raise exception 'fully retained profile received a cleanup lease';
	end if;
	if (select count(*) from public.qorpera_company_object_gc_entries
		where profile_id = v_candidate and lease_id = '36000000-0000-4000-8000-000000000081') <> 1
		or not exists (select 1 from public.qorpera_company_object_gc_entries
			where profile_id = v_candidate and object_sha256 = repeat('b', 64)) then
		raise exception 'cleanup entries do not match the claimed object';
	end if;
	-- Release the lease so the fence check below can lease the profile again.
	delete from public.qorpera_company_object_gc_leases where profile_id = v_candidate;
end
$$;

-- The chosen profile is still fenced: a claim waits behind a held profile
-- row until it is released, then leases that profile.
select dblink_connect('contention_worker', 'dbname=qorpera_test');
select dblink_exec('contention_locker', 'begin');
select * from dblink('contention_locker', format(
	$$select id from public.qorpera_profiles where id = %L for update$$,
	current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'profile_id'
)) as locked(id uuid);
select dblink_exec('contention_worker', $$set request.jwt.claims = '{"role":"service_role"}'$$);
select dblink_send_query('contention_worker',
	$$select public.qorpera_claim_company_object_gc(10, '36000000-0000-4000-8000-000000000083')$$);
select pg_sleep(0.2);
do $$
begin
	if dblink_is_busy('contention_worker') <> 1 then
		raise exception 'company object GC leased a profile without waiting for its GC fence';
	end if;
end
$$;
select dblink_exec('contention_locker', 'rollback');
do $$
declare
	v_claim jsonb;
	v_candidate uuid := (current_setting('qorpera_test.contention_gc_candidate')::jsonb ->> 'profile_id')::uuid;
begin
	select result into v_claim from dblink_get_result('contention_worker') as claimed(result jsonb);
	if v_claim ->> 'profile_id' is distinct from v_candidate::text
		or jsonb_array_length(v_claim -> 'objects') <> 1
		or v_claim -> 'objects' -> 0 ->> 'sha256' is distinct from repeat('b', 64) then
		raise exception 'fenced company object GC claim is invalid: %', v_claim;
	end if;
end
$$;
select dblink_disconnect('contention_worker');
select dblink_disconnect('contention_locker');

-- 3. Stale managed runner retirement during orchestrator reconciliation.
-- Workspace and snapshot writers are enforced against the caller's identity.
select set_config(
	'request.jwt.claims',
	'{"sub":"36000000-0000-4000-8000-000000000001","email":"contention-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('36000000-0000-4000-8000-000000000110', 'Runner retirement profile', '36000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values ('36000000-0000-4000-8000-000000000110', '36000000-0000-4000-8000-000000000001',
	'contention-owner@example.test', 'Contention Owner', 'owner');
insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
values ('36000000-0000-4000-8000-000000000120', '36000000-0000-4000-8000-000000000110',
	'Retirement', 1, '36000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_workspaces (id, profile_id, environment_id, client_workspace_id, name, created_by_user_id)
values ('36000000-0000-4000-8000-000000000130', '36000000-0000-4000-8000-000000000110',
	'36000000-0000-4000-8000-000000000120', '36000000-0000-4000-8000-000000000131',
	'Retirement workspace', '36000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count, total_bytes, created_by_user_id
) values ('36000000-0000-4000-8000-000000000140', '36000000-0000-4000-8000-000000000110',
	'36000000-0000-4000-8000-000000000120', '36000000-0000-4000-8000-000000000130',
	'36000000-0000-4000-8000-000000000141', repeat('f', 64), 2, 1, 0, 0, '36000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_substrate_versions (
	id, profile_id, environment_id, company_snapshot_id, client_version_id,
	contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id
) values ('36000000-0000-4000-8000-000000000150', '36000000-0000-4000-8000-000000000110',
	'36000000-0000-4000-8000-000000000120', '36000000-0000-4000-8000-000000000140',
	'36000000-0000-4000-8000-000000000151', 1, 0, 0, repeat('f', 64), '36000000-0000-4000-8000-000000000001');

-- Runner rows: only 161 qualifies for retirement.
insert into public.qorpera_runners (
	id, profile_id, client_runner_id, display_name, runner_kind, capabilities, max_concurrency,
	status, platform, runner_version, activation_token_sha256, activation_expires_at,
	session_token_sha256, session_expires_at, previous_session_token_sha256, previous_session_expires_at,
	registered_by_user_id, activated_at, last_seen_at, worker_class, provider_adapter
) values
	-- 161: stale managed sandbox runner, no jobs -> retired.
	('36000000-0000-4000-8000-000000000161', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000171', 'Stale managed runner', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('1', 64), statement_timestamp() + interval '1 hour',
		repeat('a', 64), statement_timestamp() - interval '2 hours', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '2 hours', 'managed_sandbox', 'managed'),
	-- 162: live session -> untouched.
	('36000000-0000-4000-8000-000000000162', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000172', 'Live managed runner', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('2', 64), statement_timestamp() + interval '1 hour',
		repeat('b', 64), statement_timestamp() + interval '1 hour', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp(),
		'managed_sandbox', 'managed'),
	-- 163: stale session but a leased job -> untouched.
	('36000000-0000-4000-8000-000000000163', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000173', 'Stale runner with job', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('3', 64), statement_timestamp() + interval '1 hour',
		repeat('c', 64), statement_timestamp() - interval '2 hours', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '2 hours', 'managed_sandbox', 'managed'),
	-- 164: stale, but not a managed sandbox worker -> untouched.
	('36000000-0000-4000-8000-000000000164', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000174', 'Stale unmanaged runner', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('4', 64), statement_timestamp() + interval '1 hour',
		repeat('d', 64), statement_timestamp() - interval '2 hours', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '2 hours', null, 'lxd'),
	-- 165: stale managed sandbox without a provider adapter -> untouched.
	('36000000-0000-4000-8000-000000000165', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000175', 'Stale runner without adapter', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('5', 64), statement_timestamp() + interval '1 hour',
		repeat('e', 64), statement_timestamp() - interval '2 hours', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '2 hours', 'managed_sandbox', null),
	-- 166: session expired only 10 minutes ago -> untouched.
	('36000000-0000-4000-8000-000000000166', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000176', 'Recently expired runner', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('6', 64), statement_timestamp() + interval '1 hour',
		repeat('f', 64), statement_timestamp() - interval '10 minutes', null, null,
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '10 minutes', 'managed_sandbox', 'managed'),
	-- 167: current session stale, previous-session grace still live -> untouched.
	('36000000-0000-4000-8000-000000000167', '36000000-0000-4000-8000-000000000110',
		'36000000-0000-4000-8000-000000000177', 'Runner in rotation grace', 'qorpera_computer', '["agent_turn"]', 1,
		'active', 'linux-x64', '0.1.0', repeat('7', 64), statement_timestamp() + interval '1 hour',
		repeat('a', 64), statement_timestamp() - interval '2 hours', repeat('b', 64), statement_timestamp() + interval '5 minutes',
		'36000000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 hours',
		statement_timestamp() - interval '2 hours', 'managed_sandbox', 'managed');

insert into public.qorpera_runner_jobs (
	id, profile_id, environment_id, substrate_version_id, client_job_id,
	required_capability, job_type, payload, status, attempt_count, runner_id,
	client_lease_id, lease_token_sha256, lease_expires_at, created_by_user_id, started_at
) values (
	'36000000-0000-4000-8000-000000000180', '36000000-0000-4000-8000-000000000110',
	'36000000-0000-4000-8000-000000000120', '36000000-0000-4000-8000-000000000150',
	'36000000-0000-4000-8000-000000000181', 'agent_turn', 'agent_turn', '{"prompt":"still running"}',
	'leased', 1, '36000000-0000-4000-8000-000000000163',
	'36000000-0000-4000-8000-000000000182', repeat('9', 64),
	statement_timestamp() + interval '5 minutes', '36000000-0000-4000-8000-000000000001', statement_timestamp()
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select public.qorpera_register_runner_orchestrator(
	'36000000-0000-4000-8000-000000000190', 'Contention fixture', 'managed', repeat('8', 64), 300
);
do $$
declare
	v_denied boolean := false;
begin
	-- The helper is internal to the reconciler.
	begin
		perform public.qorpera_retire_stale_managed_runners();
	exception when insufficient_privilege then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'stale runner retirement is directly executable by service_role';
	end if;
	perform public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns('36000000-0000-4000-8000-000000000190');
	perform public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns('36000000-0000-4000-8000-000000000190');
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_runner public.qorpera_runners%rowtype;
begin
	select * into strict v_runner from public.qorpera_runners where id = '36000000-0000-4000-8000-000000000161';
	if v_runner.status <> 'revoked' or v_runner.revoked_at is null
		or v_runner.revoked_by_user_id is distinct from v_runner.registered_by_user_id
		or v_runner.session_token_sha256 is not null or v_runner.session_expires_at is not null
		or v_runner.previous_session_token_sha256 is not null or v_runner.last_renewal_id is not null then
		raise exception 'stale managed runner was not retired: %', public.qorpera_runner_json(v_runner);
	end if;
	if (select count(*) from public.qorpera_runner_audit_receipts
		where runner_id = '36000000-0000-4000-8000-000000000161' and event_type = 'runner_revoked'
			and job_id is null and actor_user_id is null
			and payload ->> 'reason' = 'stale_managed_session'
			and payload ->> 'provider_adapter' = 'managed') <> 1 then
		raise exception 'stale managed runner retirement did not append exactly one runner_revoked receipt';
	end if;
	for v_runner in
		select * from public.qorpera_runners
		where id in (
			'36000000-0000-4000-8000-000000000162', '36000000-0000-4000-8000-000000000163',
			'36000000-0000-4000-8000-000000000164', '36000000-0000-4000-8000-000000000165',
			'36000000-0000-4000-8000-000000000166', '36000000-0000-4000-8000-000000000167'
		)
	loop
		if v_runner.status <> 'active' or v_runner.session_token_sha256 is null or v_runner.revoked_at is not null then
			raise exception 'runner % was retired although it has a live session, an unfinished job, or is out of scope',
				v_runner.display_name;
		end if;
	end loop;
	if (select status from public.qorpera_runner_jobs where id = '36000000-0000-4000-8000-000000000180') <> 'leased' then
		raise exception 'reconciliation disturbed the unfinished job of a stale runner';
	end if;
	if (select count(*) from public.qorpera_runner_audit_receipts
		where profile_id = '36000000-0000-4000-8000-000000000110' and event_type = 'runner_revoked') <> 1 then
		raise exception 'reconciliation revoked more than the stale managed runner';
	end if;
	if position('perform public.qorpera_retire_stale_managed_runners();' in pg_get_functiondef(
		'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure)) = 0 then
		raise exception 'orchestrator reconciliation does not retire stale managed runners';
	end if;
end
$$;
