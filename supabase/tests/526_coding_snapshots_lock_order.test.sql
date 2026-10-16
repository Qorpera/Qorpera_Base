-- Coding snapshots' lock order, 5h-2 (migration 20260930435000): a build's begin takes the company's profile row before
-- the session, as every coding machine call (20260925123000). A machine plan or an agent tool call holds the company's
-- fence while it locks the session; a begin that held the session and then waited for the profile row (its snapshot
-- insert's key check) would deadlock with it. A second connection holds the real fence while begin runs on a third:
-- begin waits for the fence holding nothing of the session, which the holder locks at once (NOWAIT). Once the fence is
-- let go, begin starts its build. The fixture is a small committed company of its own (525's, with one session), all
-- removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id, email) values ('52600000-0000-4000-8000-000000000001', 'snapshot-order@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('52600000-0000-4000-8000-000000000010', 'Coding snapshot lock order', '52600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('52600000-0000-4000-8000-000000000010', '52600000-0000-4000-8000-000000000001', 'snapshot-order@example.test', 'M', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('52600000-0000-4000-8000-000000000020', '52600000-0000-4000-8000-000000000010', 'Environment', 1,
	'52600000-0000-4000-8000-000000000001');

-- Foreign keys and triggers are off only while the worker, its session and the executor go in, as 525's.
set session_replication_role = replica;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values ('52600000-0000-4000-8000-0000000000c1', '52600000-0000-4000-8000-000000000010', '52600000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'w-526-1', 'coding', 'Code 1', 'read', 'each', '{}',
	'52600000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), '52600000-0000-4000-8000-000000000001',
	extensions.gen_random_uuid(), 1);
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at, updated_at)
values ('52600000-0000-4000-8000-0000000000c1', '52600000-0000-4000-8000-000000000010', '52600000-0000-4000-8000-000000000020',
	'codex', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'w-526-1', 'preparing', 'exec-526',
	'52600000-0000-4000-8000-0000000000e1', clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp());
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
values ('52600000-0000-4000-8000-000000000020', 'exec-526', true, array['codex'], repeat('6', 64));
set session_replication_role = origin;

create function pg_temp.snap_order_ok(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'coding snapshot lock order: %', p_what; end if; end
$$;

-- Two more connections: the fence's holder and the executor's call (service-role claims).
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['snap_order_hold','snap_order_call']) name \g /dev/null
select dblink_exec('snap_order_call', $q$set request.jwt.claims = '{"role":"service_role"}'$q$) \g /dev/null
select set_config('qorpera_test.snap_order_pid_' || name, pid::text, false)
from unnest(array['snap_order_hold','snap_order_call']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer) \g /dev/null

-- Whether the call waits for the holder.
create function pg_temp.snap_order_blocked() returns boolean language sql as $$
	select current_setting('qorpera_test.snap_order_pid_snap_order_hold')::integer
		= any (pg_blocking_pids(current_setting('qorpera_test.snap_order_pid_snap_order_call')::integer))
$$;
-- The call's result, or its error; the connection is ready again afterwards (800's).
create function pg_temp.snap_order_collect() returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result('snap_order_call') as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result('snap_order_call', false) as call(result jsonb);
	return v_outcome;
end $$;

do $$
declare v_waited boolean := false; v_until timestamptz := clock_timestamp() + interval '60 seconds'; v_session text; v_plan jsonb;
begin
	-- The holder takes the company's fence, as a machine plan or an agent tool call does first.
	perform dblink_exec('snap_order_hold', 'begin');
	perform * from dblink('snap_order_hold',
		$q$select public.qorpera_lock_profile_gc_fence('52600000-0000-4000-8000-000000000010')::text$q$) as held(x text);
	perform dblink_send_query('snap_order_call', $q$select public.qorpera_begin_coding_snapshot_build(
		'52600000-0000-4000-8000-0000000000c1', '52600000-0000-4000-8000-0000000000e1', repeat('6', 64), repeat('1', 64),
		repeat('1', 40))$q$);
	loop
		if pg_temp.snap_order_blocked() then v_waited := true; exit; end if;
		exit when dblink_is_busy('snap_order_call') = 0 or clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	-- A begin that never waited proves nothing either way.
	if not v_waited then
		perform dblink_exec('snap_order_hold', 'rollback');
		raise exception 'coding snapshot lock order: begin did not wait for the fence: %', pg_temp.snap_order_collect();
	end if;
	-- Then the session, as the fence's holder goes on to lock it.
	begin
		select x into v_session from dblink('snap_order_hold', $q$select worker_id::text from public.qorpera_coding_sessions
			where worker_id = '52600000-0000-4000-8000-0000000000c1' for update nowait$q$) as locked(x text);
	exception when others then
		v_session := sqlstate || ' ' || sqlerrm;
	end;
	perform dblink_exec('snap_order_hold', 'rollback');
	v_plan := pg_temp.snap_order_collect();
	perform pg_temp.snap_order_ok(v_session = '52600000-0000-4000-8000-0000000000c1',
		format('begin held the session while it waited for the fence: %s', v_session));
	perform pg_temp.snap_order_ok(v_plan -> 'result' ->> 'state' = 'started', format('begin did not start its build: %s', v_plan));
end $$;
-- Read in a statement of its own, after the call committed.
select pg_temp.snap_order_ok((select count(*) from public.qorpera_coding_snapshots
	where profile_id = '52600000-0000-4000-8000-000000000010' and state = 'building') = 1, 'the started build is not recorded') \g /dev/null

select dblink_disconnect(name) from unnest(array['snap_order_hold','snap_order_call']) name \g /dev/null

-- Remove the fixture (800's way): every row of the company and its environment, then the company and the member.
set session_replication_role = replica;
do $$
declare v_table record;
begin
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id') and c.data_type = 'uuid'
			and c.table_name <> 'qorpera_profiles' loop
		execute format('delete from public.%I where %I = $1', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then '52600000-0000-4000-8000-000000000010'::uuid
			else '52600000-0000-4000-8000-000000000020'::uuid end;
	end loop;
end $$;
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '52600000-0000-4000-8000-000000000010';
delete from auth.users where id = '52600000-0000-4000-8000-000000000001';
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '52600000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_environments where id = '52600000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_runtime_workers where id = '52600000-0000-4000-8000-0000000000c1')
		or exists (select 1 from public.qorpera_coding_sessions where worker_id = '52600000-0000-4000-8000-0000000000c1')
		or exists (select 1 from public.qorpera_coding_executors where environment_id = '52600000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_coding_snapshots where profile_id = '52600000-0000-4000-8000-000000000010')
		or exists (select 1 from auth.users where id = '52600000-0000-4000-8000-000000000001') then
		raise exception 'coding snapshot lock order: the fixture must be removed'; end if;
end $$;
