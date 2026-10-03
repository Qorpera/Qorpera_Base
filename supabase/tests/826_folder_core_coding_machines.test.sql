-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3h (P07 part 1, migration 20260930002300): a coding machine's calls on folder-v2 take the folder
-- fence and the company row KEY SHARE (qorpera_folder_machine_fence), never the gc fence's row FOR UPDATE. A folder effect
-- (the fence and the row KEY SHARE) never makes them wait; a stop's second phase (the fence FOR UPDATE) does, before any
-- coding row. Each call here is refused after its locks for its own reasons (no lease, no custody), which is enough to
-- see where it waits. The snapshot-v1 company keeps the gc fence, and each patched body reversed is the definition before
-- this migration. 648's committed fixture with a coding worker and machine in each company, removed at the end.

-- Coding rows (committed): a coding worker and a member's coding machine in the folder-v2 company (10) and in the
-- snapshot-v1 company (11). Foreign keys and triggers are off only while they go in.
set session_replication_role = replica;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values
	('82600000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'64800000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), 'w-826', 'coding', 'Code', 'read', 'each', '{}',
		'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000002',
		'64800000-0000-4000-8000-0000000000b1', 1),
	('82600000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'w-826', 'coding', 'Code', 'read', 'each', '{}',
		'64800000-0000-4000-8000-000000000003', '64800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-000000000003',
		extensions.gen_random_uuid(), 1);
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values
	('82600000-0000-4000-8000-0000000000d1', 'member', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'64800000-0000-4000-8000-000000000002', 'exec-826', repeat('8', 64), '{}'),
	('82600000-0000-4000-8000-0000000000d2', 'member', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
		'64800000-0000-4000-8000-000000000003', 'exec-826', repeat('8', 64), '{}');
set session_replication_role = origin;

-- fence_one holds what a folder effect holds (the company row and the fence KEY SHARE), what a stop's second phase holds
-- (the fence FOR UPDATE), or a company row KEY SHARE alone (as 824); until pg_temp.release().
create function pg_temp.hold(p_what text, p_profile uuid default '64800000-0000-4000-8000-000000000010') returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what in ('effect','stop') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s', p_profile,
			case p_what when 'effect' then 'key share' else 'update' end)) as t(x integer);
	end if;
	if p_what in ('effect','row') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_profiles where id = %L for key share', p_profile)) as t(x integer);
	end if;
end $$;
create function pg_temp.release() returns void language sql as $$ select dblink_exec('fence_one', 'rollback') $$;
-- Whether a connection waits at a row of a table (as in 665): it holds that row's tuple lock while blocked.
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- Whether nobody holds a row in a mode that blocks FOR UPDATE: probed with NOWAIT on fence_four (as in 824).
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for update nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- The four calls, as the coding executor sends them, for the company's worker or machine (c1: folder-v2, c2: snapshot-v1).
-- None carries a lease or custody that holds (the binding is not the machine's), so each is refused once it has its locks.
create function pg_temp.sql_call(p_fn text, p_n integer) returns text language sql as $$
	select case p_fn
		when 'authorize' then format('select public.qorpera_authorize_coding_machine_run(%L, %L, %L, %L, %L)::text',
			'82600000-0000-4000-8000-0000000000c' || p_n, extensions.gen_random_uuid(), '{}', '{}', repeat('8', 64))
		when 'plan' then format('select public.qorpera_plan_coding_machine(%L, %L, %L)::text',
			'82600000-0000-4000-8000-0000000000c' || p_n, extensions.gen_random_uuid(), repeat('8', 64))
		when 'suspend' then format('select public.qorpera_suspend_coding_machine(%L, %L, %L, %L)::text',
			'82600000-0000-4000-8000-0000000000d' || p_n, 'exec-826', '{"other":true}', repeat('8', 64))
		else format('select public.qorpera_release_coding_machine(%L, %L, %L, %L)::text',
			'82600000-0000-4000-8000-0000000000d' || p_n, 'exec-826', '{"other":true}', repeat('8', 64)) end
$$;

-- A. Beside a folder effect, none of the four waits on folder-v2; each is refused for its own reasons (never a lock).
do $$
declare v_fn text; v_state text;
begin
	foreach v_fn in array array['authorize', 'plan', 'suspend', 'release'] loop
		perform pg_temp.hold('effect');
		perform dblink_send_query('fence_two', pg_temp.sql_call(v_fn, 1));
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
			perform pg_temp.release();
			raise exception 'A: % waited for a folder effect', v_fn; end if;
		v_state := pg_temp.outcome('fence_two');
		perform pg_temp.release();
		if v_state = 'ok' or v_state like '40P01%' or v_state like '55P03%' then
			raise exception 'A: % must be refused for its own reasons, got %', v_fn, v_state; end if;
	end loop;
end $$;

-- B. Behind a stop's second phase each waits at the fence, holding no coding row; once the stop lets go, it is refused as in A.
do $$
declare v_fn text; v_state text;
begin
	foreach v_fn in array array['authorize', 'plan', 'suspend', 'release'] loop
		perform pg_temp.hold('stop');
		perform dblink_send_query('fence_two', pg_temp.sql_call(v_fn, 1));
		if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
			perform pg_temp.release();
			raise exception 'B: % must wait at the folder fence', v_fn; end if;
		if not pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82600000-0000-4000-8000-0000000000c1'$q$)
			or not pg_temp.row_free($q$select 1 from public.qorpera_coding_machines where id = '82600000-0000-4000-8000-0000000000d1'$q$)
			or not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$) then
			perform pg_temp.release();
			raise exception 'B: % held a coding row or the company row before the fence', v_fn; end if;
		perform pg_temp.release();
		v_state := pg_temp.outcome('fence_two');
		if v_state = 'ok' or v_state like '40P01%' or v_state like '55P03%' then
			raise exception 'B: % must be refused for its own reasons after the stop, got %', v_fn, v_state; end if;
	end loop;
end $$;

-- C. The snapshot-v1 company keeps the gc fence: each call waits for a holder of its company row KEY SHARE.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['authorize', 'plan', 'suspend', 'release'] loop
		perform pg_temp.hold('row', '64800000-0000-4000-8000-000000000011');
		perform dblink_send_query('fence_two', pg_temp.sql_call(v_fn, 2));
		if not pg_temp.waits_for('fence_two', 'fence_one') then
			perform pg_temp.release();
			raise exception 'C: snapshot-v1 % must keep the gc fence', v_fn; end if;
		perform pg_temp.release();
		perform pg_temp.outcome('fence_two');
	end loop;
end $$;

-- D. Snapshot-v1 keeps its text: each patched body with its folder-v2 branches reversed is byte for byte the definition
-- before this migration (master digests from a node 2 probe). The reservation's widened branch is reversed in 824 H.
create temporary table c1c3h_patches(n serial, fn text, digest text, patched text, original text) on commit preserve rows;
insert into c1c3h_patches(fn, digest, patched, original)
select fn, digest,
	E'\t-- C1c-3h (20260930002300): on folder-v2 the folder fence and the company row KEY SHARE.\n'
	|| E'\tif public.qorpera_company_is_folder_v2((select ' || alias || '.profile_id from public.' || tbl || ' ' || alias || ' where ' || alias || '.id = ' || arg || E')) then\n'
	|| E'\t\tperform public.qorpera_folder_machine_fence(' || alias || '.profile_id) from public.' || tbl || ' ' || alias || ' where ' || alias || '.id = ' || arg || E';\n'
	|| E'\telse\n'
	|| E'\tperform public.qorpera_lock_profile_gc_fence(' || alias || '.profile_id) from public.' || tbl || ' ' || alias || ' where ' || alias || '.id = ' || arg || E';\n'
	|| E'\tend if;\n',
	E'\tperform public.qorpera_lock_profile_gc_fence(' || alias || '.profile_id) from public.' || tbl || ' ' || alias || ' where ' || alias || '.id = ' || arg || E';\n'
from (values
	('qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', 'd28bfed0aafa0709b6aa8f9ea5530b54', 'qorpera_runtime_workers', 'worker', 'p_worker_id'),
	('qorpera_plan_coding_machine(uuid,uuid,text)', '57c7240563593e4e4fece0c232c90e7b', 'qorpera_runtime_workers', 'worker', 'p_worker_id'),
	('qorpera_suspend_coding_machine(uuid,text,text,text)', 'e194cac1233db67c1e9dec1f9ed4074e', 'qorpera_coding_machines', 'machine', 'p_machine_id'),
	('qorpera_release_coding_machine(uuid,text,text,text)', '036105eb7b1633e4c11bc84fec395d6f', 'qorpera_coding_machines', 'machine', 'p_machine_id'))
	as site(fn, digest, tbl, alias, arg);
insert into c1c3h_patches(fn, digest, patched, original) values
	('qorpera_plan_coding_machine(uuid,uuid,text)', '57c7240563593e4e4fece0c232c90e7b',
		E'\t\t\t-- C1c-3h (20260930002300): on folder-v2 the same KEY SHARE locks again; nothing upgrades them.\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(v_worker.profile_id) then\n'
		|| E'\t\t\t\tperform public.qorpera_folder_machine_fence(v_worker.profile_id);\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);\n'
		|| E'\t\t\tend if;\n',
		E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);\n');
do $$
declare v record; p record; v_text text; v_bad text[] := '{}';
begin
	for v in select fn, min(digest) as digest from c1c3h_patches group by fn loop
		v_text := pg_get_functiondef(('public.' || v.fn)::regprocedure);
		for p in select * from c1c3h_patches where fn = v.fn order by n loop
			if position(p.patched in v_text) = 0 then v_bad := v_bad || (v.fn || ' (a patch is missing)'); end if;
			v_text := replace(v_text, p.patched, p.original);
		end loop;
		if md5(v_text) <> v.digest then v_bad := v_bad || (v.fn || ' ' || md5(v_text)); end if;
	end loop;
	if cardinality(v_bad) > 0 then raise exception 'D: snapshot-v1 text changed in: %', v_bad; end if;
	-- The activation markers of 20260925123000 stay in each body.
	if position('qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id'
			in pg_get_functiondef('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure)) = 0
		or position('qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id'
			in pg_get_functiondef('public.qorpera_release_coding_machine(uuid,text,text,text)'::regprocedure)) = 0 then
		raise exception 'D: an activation marker went missing'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows (and the coding rows above) as 824 removes them.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '82400000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-824')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
