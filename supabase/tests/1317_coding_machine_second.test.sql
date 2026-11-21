begin;

insert into auth.users(id, email) values ('13170000-0000-4000-8000-000000000001', 'coding-second-1317@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13170000-0000-4000-8000-000000000010', 'Coding second machine', '13170000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13170000-0000-4000-8000-000000000010', '13170000-0000-4000-8000-000000000001', 'coding-second-1317@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('13170000-0000-4000-8000-000000000020', '13170000-0000-4000-8000-000000000010', 'Environment', 1,
	'13170000-0000-4000-8000-000000000001'),
	('13170000-0000-4000-8000-000000000021', '13170000-0000-4000-8000-000000000010', 'Enrolled', 1,
	'13170000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('13170000-0000-4000-8000-000000000020') \g /dev/null

set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('13170000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-1317', 'UTF8')), 'hex'), 'node-1317', 1, 16000,
	68719476736, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
values ('13170000-0000-4000-8000-0000000000e1', '13170000-0000-4000-8000-0000000000e2', clock_timestamp(),
	'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('13170000-0000-4000-8000-0000000000e1', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
values ('13170000-0000-4000-8000-0000000000e1', '13170000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('coding', 'coding-1317', '13170000-0000-4000-8000-0000000000e1', repeat('d', 64), 2000, 4294967296);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy)
values ('13170000-0000-4000-8000-000000000020', 'exec-1317', true, array['codex'], encode(sha256(convert_to('node-1317', 'UTF8')), 'hex'),
	jsonb_build_object('providerId', 'coding-1317', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
		'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
		'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
	'{"rootPath":"/nas/coding"}');
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('13170000-0000-4000-8000-0000000000c' || n)::uuid, '13170000-0000-4000-8000-000000000010', '13170000-0000-4000-8000-000000000020',
	'13170000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), 'w-1317-' || n, 'coding', 'Code', 'read', 'each', '{}',
	'13170000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), '13170000-0000-4000-8000-000000000001',
	extensions.gen_random_uuid(), 1
from generate_series(1, 7) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at)
select ('13170000-0000-4000-8000-0000000000c' || n)::uuid, '13170000-0000-4000-8000-000000000010', '13170000-0000-4000-8000-000000000020',
	'codex', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/coding/1317-' || n, 'preparing', 'exec-1317',
	extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes', clock_timestamp()
from generate_series(1, 7) n;
set local session_replication_role = origin;

create function pg_temp.ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Coding machine second: %', p_message; end if; end $$;
create function pg_temp.node() returns text language sql as $$ select encode(sha256(convert_to('node-1317', 'UTF8')), 'hex') $$;
create function pg_temp.worker(p_n integer) returns uuid language sql as $$ select ('13170000-0000-4000-8000-0000000000c' || p_n)::uuid $$;
create function pg_temp.plan(p_n integer) returns jsonb language sql as $$
	select public.qorpera_plan_coding_machine(pg_temp.worker(p_n),
		(select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)), pg_temp.node(), repeat('1', 64))
$$;
create function pg_temp.storage(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-storage/v1', 'volumeId', worker.id, 'workerId', worker.id,
		'companyId', worker.profile_id, 'environmentId', worker.environment_id, 'writerGeneration', 1, 'machineIdSha256', pg_temp.node(),
		'policy', '{"rootPath":"/nas/coding"}'::jsonb, 'dataSource', root || '/data', 'custodySource', root || '/guest-state',
		'dataTarget', '/workspace', 'custodyTarget', '/var/lib/qorpera-coding')
	from public.qorpera_runtime_workers worker,
		lateral (select '/nas/coding/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) folder
	where worker.id = pg_temp.worker(p_n)
$$;
create function pg_temp.run(p_n integer, p_plan jsonb) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_run(pg_temp.worker(p_n),
		(select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)), p_plan ->> 'bindingText',
		pg_temp.storage(p_n), pg_temp.node())
$$;
create function pg_temp.load(p_plan jsonb, p_load jsonb) returns jsonb language sql as $$
	select public.qorpera_record_coding_machine_load((p_plan ->> 'machineId')::uuid, 'exec-1317', p_plan ->> 'bindingText', pg_temp.node(), p_load)
$$;
create function pg_temp.report(p_full boolean, variadic p_sessions jsonb[] default '{}') returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', p_full, 'sessions', to_jsonb(p_sessions))
$$;
create function pg_temp.line(p_n integer, p_cpu_millis bigint, p_memory_bytes bigint) returns jsonb language sql as $$
	select jsonb_build_object('workerId', pg_temp.worker(p_n), 'cpuMillis', p_cpu_millis, 'memoryBytes', p_memory_bytes)
$$;
create function pg_temp.full(p_plan jsonb, p_n integer) returns boolean language sql as $$
	select public.qorpera_coding_machine_full(machine, pg_temp.worker(p_n), executor.session_cpu_millis, executor.session_memory_bytes)
	from public.qorpera_coding_machines machine, public.qorpera_coding_executors executor
	where machine.id = (p_plan ->> 'machineId')::uuid and executor.environment_id = '13170000-0000-4000-8000-000000000020'
		and executor.owner = 'exec-1317'
$$;
create function pg_temp.number(p_plan jsonb) returns integer language sql as $$
	select number from public.qorpera_coding_machines where id = (p_plan ->> 'machineId')::uuid
$$;
create function pg_temp.home(p_n integer) returns uuid language sql as $$
	select vm_allocation_id from public.qorpera_coding_sessions where worker_id = pg_temp.worker(p_n)
$$;
create function pg_temp.error(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;

do $$
declare v_p1 jsonb; v_p2 jsonb; v_p3 jsonb; v_p4 jsonb; v_p5 jsonb; v_p6 jsonb; v_p7 jsonb; v_again jsonb; v_recorded jsonb;
	v_first public.qorpera_coding_machines%rowtype; v_second public.qorpera_coding_machines%rowtype; v_bad jsonb;
	v_environment constant uuid := '13170000-0000-4000-8000-000000000020';
	v_enrolled constant uuid := '13170000-0000-4000-8000-000000000021';
begin
	perform pg_temp.ok((select session_cpu_millis = 0 and session_memory_bytes = 0 from public.qorpera_coding_executors
		where environment_id = v_environment and owner = 'exec-1317'), 'no session size until the operator sets one');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.ok(pg_temp.error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, 2147483648)',
		v_environment, 'exec-1317')) = '42501 Coding machine operator authority required', 'only the operator sets the size');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.ok(pg_temp.error(format('select public.qorpera_configure_coding_session_size(%L, %L, 1000, 2147483648)',
		v_environment, 'exec-other')) = '42501 Coding executor unavailable', 'another executor''s size is refused');
	perform pg_temp.ok(pg_temp.error(format('select public.qorpera_configure_coding_session_size(%L, %L, -1, 0)',
		v_environment, 'exec-1317')) like '23514 %', 'a negative size is refused');
	perform public.qorpera_configure_coding_session_size(v_environment, 'exec-1317', 1000, 2147483648);

	perform public.qorpera_coding_executor_enroll(v_enrolled, 'codex');
	perform pg_temp.ok(exists (select 1 from public.qorpera_coding_executors
		where environment_id = v_enrolled and owner = 'exec-1317'
			and session_cpu_millis = 1000 and session_memory_bytes = 2147483648),
		'auto-enrolled executor inherits session_cpu_millis and session_memory_bytes');
	delete from public.qorpera_coding_executors where environment_id = v_enrolled;

	v_p1 := pg_temp.plan(1);
	v_p2 := pg_temp.plan(2);
	v_p3 := pg_temp.plan(3);
	perform pg_temp.ok(v_p1 ->> 'state' = 'planned' and v_p1 ? 'bindingText' and pg_temp.number(v_p1) = 1, format('s1 opens machine 1: %s', v_p1));
	perform pg_temp.ok(v_p2 ->> 'machineId' = v_p1 ->> 'machineId', 's2 fits machine 1');
	perform pg_temp.ok(v_p3 ->> 'state' = 'planned' and v_p3 ->> 'machineId' <> v_p1 ->> 'machineId' and pg_temp.number(v_p3) = 2,
		format('s3 opens machine 2: %s', v_p3));
	select * into v_first from public.qorpera_coding_machines where id = (v_p1 ->> 'machineId')::uuid;
	select * into v_second from public.qorpera_coding_machines where id = (v_p3 ->> 'machineId')::uuid;
	perform pg_temp.ok(v_second.staff_agent_id = v_first.staff_agent_id and v_second.repository = v_first.repository
		and v_second.setup_digest = v_first.setup_digest and v_second.owner = v_first.owner
		and v_second.machine_id_sha256 = v_first.machine_id_sha256 and v_second.member_user_id = v_first.member_user_id,
		'machine 2 is the same member, agent, repository and digest on the same node');
	perform pg_temp.ok(pg_temp.home(2) is null and (select machine_id from public.qorpera_coding_session_loads where worker_id = pg_temp.worker(2))
		= v_first.id, 's2 has its place on machine 1 before its run authority');

	perform pg_temp.ok(pg_temp.run(1, v_p1) ->> 'intent' = 'run' and pg_temp.run(2, v_p2) ->> 'intent' = 'run'
		and pg_temp.run(3, v_p3) ->> 'intent' = 'run', 'the three turns run');
	perform pg_temp.ok(pg_temp.home(1) = v_first.id and pg_temp.home(2) = v_first.id and pg_temp.home(3) = v_second.id,
		'each session has its machine');

	v_recorded := pg_temp.load(v_p1, pg_temp.report(true, pg_temp.line(1, 500, 1073741824), pg_temp.line(2, 500, 1073741824)));
	perform pg_temp.ok((v_recorded ->> 'sessions')::integer = 2, format('the guest''s load is recorded: %s', v_recorded));
	perform pg_temp.ok((select full_until > clock_timestamp() from public.qorpera_coding_machines where id = v_first.id),
		'the guest''s hint marks machine 1 full');
	v_again := pg_temp.plan(1);
	perform pg_temp.ok(v_again ->> 'state' = 'planned' and v_again ->> 'machineId' = v_first.id::text, 's1 plans on its full machine');
	v_again := pg_temp.plan(2);
	perform pg_temp.ok(v_again ->> 'state' = 'planned' and v_again ->> 'machineId' = v_first.id::text, 's2 plans on its full machine');
	perform pg_temp.ok((select count(*) from public.qorpera_coding_machines where profile_id = v_first.profile_id) = 2, 'no machine opens');

	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member' where worker_id = pg_temp.worker(2);
	set local session_replication_role = origin;
	v_p4 := pg_temp.plan(4);
	perform pg_temp.ok(v_p4 ->> 'machineId' = v_second.id::text, format('the hint sends s4 to machine 2: %s', v_p4));
	update public.qorpera_coding_machines set full_until = clock_timestamp() - interval '1 second' where id = v_first.id;
	perform pg_temp.ok(not pg_temp.full(v_p1, 5), 'a lapsed hint no longer counts');
	v_recorded := pg_temp.load(v_p1, pg_temp.report(false, pg_temp.line(1, 500, 1073741824)));
	perform pg_temp.ok((select full_until is null from public.qorpera_coding_machines where id = v_first.id), 'the guest clears its hint');
	v_p5 := pg_temp.plan(5);
	perform pg_temp.ok(v_p5 ->> 'machineId' = v_first.id::text, format('s5 takes the archived session''s room: %s', v_p5));

	v_p6 := pg_temp.plan(6);
	perform pg_temp.ok(v_p6 ->> 'state' = 'planned' and pg_temp.number(v_p6) = 3, format('s6 opens machine 3: %s', v_p6));
	perform pg_temp.ok(not pg_temp.full(v_p6, 7), 'machine 3 has room for one more');
	perform pg_temp.ok(pg_temp.run(6, v_p6) ->> 'intent' = 'run', 's6 runs on machine 3');
	perform pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 1500, 1073741824)));
	perform pg_temp.ok(pg_temp.full(v_p6, 7), 'a load above the session size counts');
	perform pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 10, 10)));
	perform pg_temp.ok(not pg_temp.full(v_p6, 7), 'a load below the session size counts as the session size');
	perform pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 10, 3221225472)));
	perform pg_temp.ok(pg_temp.full(v_p6, 7), 'memory counts as processor does');
	perform public.qorpera_configure_coding_session_size(v_environment, 'exec-1317', 3000, 8589934592);
	perform pg_temp.ok(not pg_temp.full(v_p6, 6) and pg_temp.full(v_p6, 7),
		'a session alone fits even when the session size is larger than the machine');
	perform public.qorpera_configure_coding_session_size(v_environment, 'exec-1317', 1000, 2147483648);
	perform pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 1500, 10)));

	v_recorded := pg_temp.load(v_p3, pg_temp.report(false, pg_temp.line(3, 1200, 10), pg_temp.line(4, 1, 1)));
	perform pg_temp.ok((v_recorded ->> 'sessions')::integer = 1, format('only machine 2''s own session is recorded: %s', v_recorded));
	set local session_replication_role = replica;
	update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = v_second.id;
	set local session_replication_role = origin;
	v_again := pg_temp.plan(3);
	perform pg_temp.ok(v_again ->> 'state' = 'planned' and v_again ->> 'machineId' not in (v_first.id::text, v_second.id::text, v_p6 ->> 'machineId')
		and pg_temp.number(v_again) = 2, format('s3 opens a new machine 2: %s', v_again));
	perform pg_temp.ok((select removed_at is not null from public.qorpera_coding_machines where id = v_second.id), 'the old machine 2 is removed');
	perform pg_temp.ok((select machine_id = (v_again ->> 'machineId')::uuid and cpu_millis = 1200 from public.qorpera_coding_session_loads
		where worker_id = pg_temp.worker(3)), 's3 keeps its last measured load in its new place');
	perform pg_temp.ok(pg_temp.full(v_again, 7), 's3 counts at its measured 1200 on the new machine');
	v_p3 := v_again;

	update public.qorpera_coding_machines set retire_requested_at = clock_timestamp() where id = v_first.id;
	v_again := pg_temp.plan(1);
	perform pg_temp.ok(v_again ->> 'state' = 'refused' and v_again ->> 'reason' = 'MACHINE_RETIRING' and v_again ->> 'machineId' = v_first.id::text,
		format('s1''s retiring machine refuses: %s', v_again));
	v_p7 := pg_temp.plan(7);
	perform pg_temp.ok(v_p7 ->> 'state' = 'planned' and pg_temp.number(v_p7) = 4, format('s7 opens machine 4: %s', v_p7));

	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.load(%L::jsonb, pg_temp.report(false))', v_p6))
		= '42501 Coding machine custody required', 'only the executor reports a load');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.load(%L::jsonb, pg_temp.report(false))',
		jsonb_set(v_p6, '{bindingText}', to_jsonb(v_p3 ->> 'bindingText')))) = '42501 Coding machine custody differs',
		'another machine''s binding is refused');
	perform pg_temp.ok(pg_temp.error(format('select pg_temp.load(%L::jsonb, null)', v_p6)) = '22023 Coding machine load invalid',
		'a missing report is refused');
	foreach v_bad in array array[
		'null', '[]', '{"schema":"other","full":false,"sessions":[]}',
		'{"schema":"qorpera.coding-machine-load/v1","full":false,"sessions":[],"more":1}',
		'{"schema":"qorpera.coding-machine-load/v1","full":"no","sessions":[]}',
		'{"schema":"qorpera.coding-machine-load/v1","full":false}',
		'{"schema":"qorpera.coding-machine-load/v1","full":false,"sessions":{}}',
		'{"schema":"qorpera.coding-machine-load/v1","full":false,"sessions":[1]}',
		'{"schema":"qorpera.coding-machine-load/v1","full":false,"sessions":[{"workerId":"w6","cpuMillis":1,"memoryBytes":1}]}',
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,cpuMillis}', '-1'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,cpuMillis}', '1.5'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,cpuMillis}', '"1"'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,cpuMillis}', '1000000000'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,memoryBytes}', '-1'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,memoryBytes}', '1.5'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,memoryBytes}', '"abc"'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,memoryBytes}', '"100"'),
		jsonb_set(pg_temp.report(false, pg_temp.line(6, 1, 1)), '{sessions,0,memoryBytes}', '1099511627777'),
		pg_temp.report(false, pg_temp.line(6, 1, 1) - 'memoryBytes'),
		pg_temp.report(false, pg_temp.line(6, 1, 1) || '{"pid":3}'),
		pg_temp.report(false, pg_temp.line(6, 1, 1), pg_temp.line(6, 2, 2))]::jsonb[]
	loop
		perform pg_temp.ok(pg_temp.error(format('select pg_temp.load(%L::jsonb, %L::jsonb)', v_p6, v_bad)) = '22023 Coding machine load invalid',
			format('a bad report is refused: %s', v_bad));
	end loop;
	v_recorded := pg_temp.load(v_p6, jsonb_set(pg_temp.report(false, pg_temp.line(6, 1500, 10), pg_temp.line(2, 1, 1), pg_temp.line(4, 1, 1)),
		'{sessions,3}', jsonb_build_object('workerId', extensions.gen_random_uuid(), 'cpuMillis', 1, 'memoryBytes', 1), true));
	perform pg_temp.ok((v_recorded ->> 'sessions')::integer = 1, format('an archived, another machine''s or an unknown session is left out: %s', v_recorded));
	perform pg_temp.ok(not exists (select 1 from public.qorpera_coding_session_loads where worker_id = pg_temp.worker(2) and cpu_millis = 1),
		'the archived session''s load stays as it was');

	delete from public.qorpera_coding_session_loads where worker_id = pg_temp.worker(6);
	v_recorded := pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 900, 2048)));
	perform pg_temp.ok((v_recorded ->> 'sessions')::integer = 0
		and not exists (select 1 from public.qorpera_coding_session_loads where worker_id = pg_temp.worker(6)),
		format('load record is update-only and never inserts missing place rows: %s', v_recorded));
	v_again := pg_temp.plan(6);
	perform pg_temp.ok(v_again ->> 'machineId' = v_p6 ->> 'machineId', 're-planning restores the place row');
	v_recorded := pg_temp.load(v_p6, pg_temp.report(false, pg_temp.line(6, 900, 2048)));
	perform pg_temp.ok((v_recorded ->> 'sessions')::integer = 1, format('load updates once place row exists: %s', v_recorded));

	perform pg_temp.ok(has_function_privilege('service_role', 'public.qorpera_record_coding_machine_load(uuid,text,text,text,jsonb)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_configure_coding_session_size(uuid,text,bigint,bigint)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_record_coding_machine_load(uuid,text,text,text,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_configure_coding_session_size(uuid,text,bigint,bigint)', 'execute')
		and not has_function_privilege('service_role',
			'public.qorpera_coding_machine_full(public.qorpera_coding_machines,uuid,bigint,bigint)', 'execute')
		and not has_table_privilege('service_role', 'public.qorpera_coding_session_loads', 'select'), 'grants');
	perform pg_temp.ok(
		position('20260930828000 (step 5k)' in obj_description('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, 'pg_proc')) > 0
		and position('20260930828000 (step 5k)' in obj_description('public.qorpera_coding_session_loads'::regclass, 'pg_class')) > 0
		and position('20260930394000 (step 5a)' in pg_get_functiondef('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure)) > 0,
		'the plan names step 5k and keeps step 5a''s markers');
end $$;

rollback;
