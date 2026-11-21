begin;

insert into auth.users(id, email) values ('13180000-0000-4000-8000-000000000001', 'coding-second-races-1318@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13180000-0000-4000-8000-000000000010', 'Coding second machine races', '13180000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13180000-0000-4000-8000-000000000010', '13180000-0000-4000-8000-000000000001', 'coding-second-races-1318@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('13180000-0000-4000-8000-000000000020', '13180000-0000-4000-8000-000000000010', 'Environment', 1,
	'13180000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('13180000-0000-4000-8000-000000000020') \g /dev/null

set local session_replication_role = replica;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
	headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('13180000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-1318', 'UTF8')), 'hex'), 'node-1318', 1, 16000,
	68719476736, 1000, 4294967296, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
values ('13180000-0000-4000-8000-0000000000e1', '13180000-0000-4000-8000-0000000000e2', clock_timestamp(),
	'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('13180000-0000-4000-8000-0000000000e1', '{}', repeat('a', 64));
insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
values ('13180000-0000-4000-8000-0000000000e1', '13180000-0000-4000-8000-0000000000e2', 1, repeat('a', 64), repeat('b', 64), '{}');
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('coding', 'coding-1318', '13180000-0000-4000-8000-0000000000e1', repeat('d', 64), 2000, 4294967296);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256, vm_policy, nas_policy)
values ('13180000-0000-4000-8000-000000000020', 'exec-1318', true, array['codex'], encode(sha256(convert_to('node-1318', 'UTF8')), 'hex'),
	jsonb_build_object('providerId', 'coding-1318', 'providerPolicySha256', repeat('d', 64), 'project', 'qorpera-coding',
		'imageFingerprint', repeat('f', 64), 'bootstrapSha256', repeat('e', 64), 'storagePool', 'default', 'network', 'qorpera-coding',
		'cpus', 2, 'memoryBytes', 4294967296, 'rootDiskBytes', 21474836480),
	'{"rootPath":"/nas/coding"}');
insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
values ('13180000-0000-4000-8000-000000000020', '13180000-0000-4000-8000-0000000000a1',
	'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('13180000-0000-4000-8000-0000000000c' || n)::uuid, '13180000-0000-4000-8000-000000000010', '13180000-0000-4000-8000-000000000020',
	'13180000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), 'w-1318-' || n, 'coding', 'Code', 'read', 'each', '{}',
	'13180000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), '13180000-0000-4000-8000-000000000001',
	extensions.gen_random_uuid(), 1
from generate_series(1, 5) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at)
select ('13180000-0000-4000-8000-0000000000c' || n)::uuid, '13180000-0000-4000-8000-000000000010', '13180000-0000-4000-8000-000000000020',
	'codex', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/coding/1318-' || n, 'preparing', 'exec-1318',
	extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes', clock_timestamp()
from generate_series(1, 5) n;
set local session_replication_role = origin;

select public.qorpera_configure_coding_session_size('13180000-0000-4000-8000-000000000020', 'exec-1318', 1000, 2147483648) \g /dev/null

create function pg_temp.r1318_ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Coding machine second races: %', p_message; end if; end $$;
create function pg_temp.r1318_node() returns text language sql as $$ select encode(sha256(convert_to('node-1318', 'UTF8')), 'hex') $$;
create function pg_temp.r1318_worker(p_n integer) returns uuid language sql as $$ select ('13180000-0000-4000-8000-0000000000c' || p_n)::uuid $$;
create function pg_temp.r1318_lease(p_n integer) returns uuid language sql as $$
	select lease_token from public.qorpera_coding_sessions where worker_id = pg_temp.r1318_worker(p_n)
$$;
create function pg_temp.r1318_storage(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-storage/v1', 'volumeId', worker.id, 'workerId', worker.id,
		'companyId', worker.profile_id, 'environmentId', worker.environment_id, 'writerGeneration', 1, 'machineIdSha256', pg_temp.r1318_node(),
		'policy', '{"rootPath":"/nas/coding"}'::jsonb, 'dataSource', root || '/data', 'custodySource', root || '/guest-state',
		'dataTarget', '/workspace', 'custodyTarget', '/var/lib/qorpera-coding')
	from public.qorpera_runtime_workers worker,
		lateral (select '/nas/coding/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) folder
	where worker.id = pg_temp.r1318_worker(p_n)
$$;

do $$
declare v_p1 jsonb; v_run jsonb; v_attach jsonb;
begin
	v_p1 := public.qorpera_plan_coding_machine(pg_temp.r1318_worker(1), pg_temp.r1318_lease(1), pg_temp.r1318_node(), repeat('1', 64));
	perform pg_temp.r1318_ok(v_p1 ->> 'state' = 'planned' and v_p1 ? 'bindingText', format('setup plan s1: %s', v_p1));
	v_run := public.qorpera_authorize_coding_machine_run(pg_temp.r1318_worker(1), pg_temp.r1318_lease(1),
		v_p1 ->> 'bindingText', pg_temp.r1318_storage(1), pg_temp.r1318_node());
	perform pg_temp.r1318_ok(v_run ->> 'intent' = 'run', format('setup run s1: %s', v_run));
	v_attach := public.qorpera_attach_coding_session(pg_temp.r1318_worker(1), pg_temp.r1318_lease(1),
		v_p1 ->> 'bindingText', pg_temp.r1318_storage(1), pg_temp.r1318_node(), null);
	perform pg_temp.r1318_ok(v_attach ->> 'state' = 'attached', format('setup attach s1: %s', v_attach));
	perform set_config('qorpera_test.r1318_m1_id', v_p1 ->> 'machineId', false);
	perform set_config('qorpera_test.r1318_m1_binding', v_p1 ->> 'bindingText', false);
end $$;

reset role;
select set_config('qorpera_test.r1318_first_xid', xid(pg_current_xact_id())::text, false) \g /dev/null
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['r1318_hold', 'r1318_act']) name \g /dev/null
select set_config('qorpera_test.r1318_' || name || '_pid', pid::text, false)
from unnest(array['hold', 'act']) name, lateral dblink('r1318_' || name, 'select pg_backend_pid()') as backend(pid integer) \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['r1318_hold', 'r1318_act']) name \g /dev/null

create function pg_temp.r1318_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r1318_hold_pid'),
			current_setting('qorpera_test.r1318_act_pid'))) then
		raise exception 'Coding second race test needs the database to itself: another connection is open'; end if;
end $$;
select pg_temp.r1318_alone_in_database();

create temporary table r1318_counts as select * from dblink('r1318_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
create temporary table r1318_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r1318_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r1318_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r1318_rows select v_table, kept.row_value
			from dblink('r1318_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

create function pg_temp.r1318_waits() returns boolean language plpgsql as $$
declare v_hold integer := current_setting('qorpera_test.r1318_hold_pid')::integer;
	v_act integer := current_setting('qorpera_test.r1318_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_hold = any(pg_blocking_pids(v_act)) then return true; end if;
		exit when dblink_is_busy('r1318_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
create function pg_temp.r1318_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('r1318_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('r1318_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('r1318_act') as call(answer text);
	return v::jsonb;
end $$;
create function pg_temp.r1318_as(p_conn text, p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset role');
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		case when p_role is null then '{}' else jsonb_build_object('role', p_role)::text end));
	if p_role is not null then perform dblink_exec(p_conn, format('set role %I', p_role)); end if;
end $$;
create function pg_temp.r1318_plan_sql(p_n integer) returns text language sql as $$
	select format('select public.qorpera_plan_coding_machine(%L::uuid, %L::uuid, %L, %L)::text',
		pg_temp.r1318_worker(p_n), pg_temp.r1318_lease(p_n), pg_temp.r1318_node(), repeat('1', 64))
$$;
create function pg_temp.r1318_load_sql(p_full boolean, p_sessions jsonb) returns text language sql as $$
	select format('select public.qorpera_record_coding_machine_load(%L::uuid, %L, %L, %L, %L::jsonb)::text',
		current_setting('qorpera_test.r1318_m1_id'), 'exec-1318', current_setting('qorpera_test.r1318_m1_binding'),
		pg_temp.r1318_node(), jsonb_build_object('schema', 'qorpera.coding-machine-load/v1', 'full', p_full, 'sessions', p_sessions))
$$;
create function pg_temp.r1318_keep_sql(p_busy boolean, p_worker uuid) returns text language sql as $$
	select format('select public.qorpera_keep_coding_attachments(%L::uuid, %L, %L, %L, %L::jsonb)::text',
		current_setting('qorpera_test.r1318_m1_id'), 'exec-1318', current_setting('qorpera_test.r1318_m1_binding'),
		pg_temp.r1318_node(), jsonb_build_object('schema', 'qorpera.coding-machine-observation/v1', 'busy', p_busy,
			'sessions', jsonb_build_array(jsonb_build_object('workerId', p_worker, 'busy', p_busy, 'running', '[]'::jsonb))))
$$;
create function pg_temp.r1318_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}';
	v_first xid := current_setting('qorpera_test.r1318_first_xid')::xid;
begin
	perform pg_temp.r1318_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r1318_hold', 'r1318_act']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r1318_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r1318_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r1318_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r1318_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Coding second race cleanup left other row counts: %', v_wrong; end if;
end $$;

do $$
declare v_held text; v_act jsonb; v_m1 uuid := current_setting('qorpera_test.r1318_m1_id')::uuid; v_m2 uuid;
begin
	perform pg_temp.r1318_as('r1318_hold', 'service_role');
	perform pg_temp.r1318_as('r1318_act', 'service_role');

	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_plan_sql(2)) as held(answer text);
	perform pg_temp.r1318_ok(v_held::jsonb ->> 'machineId' = v_m1::text, format('race 1 hold s2 on m1: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_plan_sql(3));
	if not pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 1: concurrent plan(s3) did not wait for plan(s2): %', pg_temp.r1318_answer(); end if;
	perform dblink_exec('r1318_hold', 'commit');
	v_act := pg_temp.r1318_answer();
	perform pg_temp.r1318_ok(v_act ->> 'state' = 'planned' and v_act ->> 'machineId' <> v_m1::text,
		format('race 1: s3 opens machine 2 after s2 fills machine 1 by place row: %s', v_act));
	v_m2 := (v_act ->> 'machineId')::uuid;
	perform pg_temp.r1318_ok((select number = 2 from public.qorpera_coding_machines where id = v_m2),
		'race 1: new overflow machine has number 2');
	perform set_config('qorpera_test.r1318_m2_id', v_m2::text, false);

	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_keep_sql(true, pg_temp.r1318_worker(1))) as held(answer text);
	perform pg_temp.r1318_ok(v_held::jsonb #>> '{sessions,0,state}' = 'kept', format('race 2 hold keep: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_load_sql(true,
		jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 1400, 'memoryBytes', 1048576))));
	if not pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 2: load(full=true) did not wait for keep(busy=true) on machine row: %', pg_temp.r1318_answer(); end if;
	perform dblink_exec('r1318_hold', 'commit');
	v_act := pg_temp.r1318_answer();
	perform pg_temp.r1318_ok(v_act ->> 'schema' = 'qorpera.coding-machine-load-recorded/v1' and (v_act ->> 'sessions')::integer = 1,
		format('race 2: load succeeded cleanly after keep: %s', v_act));
	perform pg_temp.r1318_ok((select full_until > clock_timestamp() from public.qorpera_coding_machines where id = v_m1)
		and (select cpu_millis = 1400 from public.qorpera_coding_session_loads where worker_id = pg_temp.r1318_worker(1)),
		'race 2: load updated full_until and cpu_millis');

	perform pg_temp.r1318_as('r1318_hold', null);
	perform dblink_exec('r1318_hold', 'begin');
	perform * from dblink('r1318_hold', format('select worker_id::text from public.qorpera_coding_sessions where worker_id = %L::uuid for update',
		pg_temp.r1318_worker(1))) as held(worker_id text);
	perform dblink_send_query('r1318_act', pg_temp.r1318_load_sql(true,
		jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 1500, 'memoryBytes', 2097152))));
	if pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 3a: load blocked on qorpera_coding_sessions FOR UPDATE lock (lock-order violation!)'; end if;
	v_act := pg_temp.r1318_answer();
	perform dblink_exec('r1318_hold', 'rollback');
	perform pg_temp.r1318_ok(v_act ->> 'schema' = 'qorpera.coding-machine-load-recorded/v1' and (v_act ->> 'sessions')::integer = 1,
		format('race 3a: load completed without locking qorpera_coding_sessions: %s', v_act));

	perform pg_temp.r1318_as('r1318_hold', 'service_role');
	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_load_sql(true,
		jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 1600, 'memoryBytes', 3145728)))) as held(answer text);
	perform pg_temp.r1318_ok((v_held::jsonb ->> 'sessions')::integer = 1, format('race 3b hold load: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_keep_sql(true, pg_temp.r1318_worker(1)));
	if not pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 3b: keep(busy=true) did not wait for load(full=true) on machine row: %', pg_temp.r1318_answer(); end if;
	perform dblink_exec('r1318_hold', 'commit');
	v_act := pg_temp.r1318_answer();
	perform pg_temp.r1318_ok(v_act #>> '{sessions,0,state}' = 'kept',
		format('race 3b: keep completed with zero deadlock after load held machine+load: %s', v_act));
end $$;

do $$
declare v_m1 uuid := current_setting('qorpera_test.r1318_m1_id')::uuid;
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member' where worker_id = pg_temp.r1318_worker(2);
	perform set_config('session_replication_role', 'origin', true);
	update public.qorpera_coding_machines set full_until = null where id = v_m1;
end $$;

do $$
declare v_held text; v_act jsonb; v_m1 uuid := current_setting('qorpera_test.r1318_m1_id')::uuid;
	v_m2 uuid := current_setting('qorpera_test.r1318_m2_id')::uuid;
begin
	perform pg_temp.r1318_as('r1318_hold', 'service_role');
	perform pg_temp.r1318_as('r1318_act', 'service_role');

	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_load_sql(true,
		jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 100, 'memoryBytes', 1024)))) as held(answer text);
	perform pg_temp.r1318_ok((v_held::jsonb ->> 'sessions')::integer = 1, format('race 4 hold load full: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_plan_sql(4));
	if not pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 4: plan(s4) did not wait for load(full=true) holding m1: %', pg_temp.r1318_answer(); end if;
	perform dblink_exec('r1318_hold', 'commit');
	v_act := pg_temp.r1318_answer();
	perform pg_temp.r1318_ok(v_act ->> 'state' = 'planned' and v_act ->> 'machineId' = v_m2::text,
		format('race 4: plan(s4) re-read m1.full_until after wait and overflowed to m2: %s', v_act));
end $$;

do $$
declare v_act jsonb; v_m1 uuid := current_setting('qorpera_test.r1318_m1_id')::uuid; v_run jsonb;
begin
	update public.qorpera_coding_machines set full_until = null where id = v_m1;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_act := public.qorpera_plan_coding_machine(pg_temp.r1318_worker(5), pg_temp.r1318_lease(5), pg_temp.r1318_node(), repeat('1', 64));
	perform pg_temp.r1318_ok(v_act ->> 'machineId' = v_m1::text, format('race 5 setup plan s5 on m1: %s', v_act));
	v_run := public.qorpera_authorize_coding_machine_run(pg_temp.r1318_worker(5), pg_temp.r1318_lease(5),
		current_setting('qorpera_test.r1318_m1_binding'), pg_temp.r1318_storage(5), pg_temp.r1318_node());
	perform pg_temp.r1318_ok(v_run ->> 'intent' = 'run', format('race 5 setup run s5 on m1: %s', v_run));
end $$;

do $$
declare v_held text; v_act jsonb; v_m1 uuid := current_setting('qorpera_test.r1318_m1_id')::uuid;
begin
	perform pg_temp.r1318_as('r1318_hold', 'service_role');
	perform pg_temp.r1318_as('r1318_act', 'service_role');

	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_load_sql(false, jsonb_build_array(
		jsonb_build_object('workerId', pg_temp.r1318_worker(5), 'cpuMillis', 400, 'memoryBytes', 4096),
		jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 300, 'memoryBytes', 2048)))) as held(answer text);
	perform pg_temp.r1318_ok((v_held::jsonb ->> 'sessions')::integer = 2, format('race 5 hold opposite order load: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_load_sql(false, jsonb_build_array(
		jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 700, 'memoryBytes', 8192),
		jsonb_build_object('workerId', pg_temp.r1318_worker(5), 'cpuMillis', 800, 'memoryBytes', 16384))));
	if not pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'rollback');
		raise exception 'race 5: concurrent opposite-order load did not wait on ordered load locks: %', pg_temp.r1318_answer(); end if;
	perform dblink_exec('r1318_hold', 'commit');
	v_act := pg_temp.r1318_answer();
	perform pg_temp.r1318_ok((v_act ->> 'sessions')::integer = 2
		and (select cpu_millis = 700 from public.qorpera_coding_session_loads where worker_id = pg_temp.r1318_worker(1))
		and (select cpu_millis = 800 from public.qorpera_coding_session_loads where worker_id = pg_temp.r1318_worker(5)),
		format('race 5: opposite-order concurrent load reports serialized with zero deadlock: %s', v_act));

	perform dblink_exec('r1318_hold', 'begin');
	select answer into v_held from dblink('r1318_hold', pg_temp.r1318_load_sql(false,
		jsonb_build_array(jsonb_build_object('workerId', pg_temp.r1318_worker(1), 'cpuMillis', 1700, 'memoryBytes', 65536)))) as held(answer text);
	perform pg_temp.r1318_ok((v_held::jsonb ->> 'sessions')::integer = 1, format('race 6 hold load on s1: %s', v_held));
	perform dblink_send_query('r1318_act', pg_temp.r1318_plan_sql(1));
	if pg_temp.r1318_waits() then
		perform dblink_exec('r1318_hold', 'commit');
		v_act := pg_temp.r1318_answer();
	else
		v_act := pg_temp.r1318_answer();
		perform dblink_exec('r1318_hold', 'commit');
	end if;
	perform pg_temp.r1318_ok(v_act ->> 'state' = 'planned' and v_act ->> 'machineId' = v_m1::text,
		format('race 6: pinned plan(s1) alongside load(full=false) succeeded with zero deadlock: %s', v_act));
end $$;

select pg_temp.r1318_cleanup();
