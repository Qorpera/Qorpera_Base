-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3g (P08, migration 20260930002500): company deletion drains the folder fence. On folder-v2 the
-- request takes member management's lock (the fence FOR NO KEY UPDATE, then the company row KEY SHARE), never the row FOR
-- UPDATE; the finisher and the purge run the folder pause's second phase for deletion (the fence FOR UPDATE and its
-- revision bump), and the purge then takes the company row FOR UPDATE, after the fence. The snapshot-v1 company keeps
-- the gc fence, and each patched body reversed is the definition before this migration. 648's committed fixture,
-- removed at the end (whatever the purge left of the folder-v2 company).

-- fence_one holds what a folder effect holds (the fence and the company row KEY SHARE), what member management holds (the
-- fence FOR NO KEY UPDATE), what a stop's second phase holds (the fence FOR UPDATE), or a company row KEY SHARE alone;
-- until pg_temp.release().
create function pg_temp.hold(p_what text, p_profile uuid default '64800000-0000-4000-8000-000000000010') returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what in ('effect','members','stop') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s', p_profile,
			case p_what when 'effect' then 'key share' when 'members' then 'no key update' else 'update' end)) as t(x integer);
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
-- Whether nobody holds a row in a mode that conflicts with p_mode: probed with NOWAIT on fence_four (as in 824).
create function pg_temp.row_free(p_sql text, p_mode text default 'update') returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for ' || p_mode || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
create function pg_temp.sql_request(p_profile uuid default '64800000-0000-4000-8000-000000000010') returns text language sql as $$
	select format('select public.qorpera_request_company_deletion(%L, %L)::text', p_profile,
		case p_profile when '64800000-0000-4000-8000-000000000010' then '64800000-0000-4000-8000-000000000001'
			else '64800000-0000-4000-8000-000000000003' end)
$$;

-- A. The request beside a folder effect: it does not wait, and while it is open it holds the fence FOR NO KEY UPDATE and
-- the company row only KEY SHARE (a NO KEY UPDATE of the row is free). Rolled back: the company stays.
do $$
declare v_state text;
begin
	perform pg_temp.hold('effect');
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', pg_temp.sql_request());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release(); perform dblink_exec('fence_two', 'rollback');
		raise exception 'A: the request waited for a folder effect'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' then perform dblink_exec('fence_two', 'rollback'); raise exception 'A: the request failed: %', v_state; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$, 'no key update')
		or not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$, 'no key update') then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'A: the request must hold the fence FOR NO KEY UPDATE and the company row only KEY SHARE'; end if;
	perform dblink_exec('fence_two', 'rollback');
end $$;

-- B. The request waits at the fence behind member management (a removal, a leave or a join holds it FOR NO KEY UPDATE),
-- and behind a stop's second phase; holding no company row meanwhile. Rolled back each time.
do $$
declare v_what text; v_state text;
begin
	foreach v_what in array array['members', 'stop'] loop
		perform pg_temp.hold(v_what);
		perform dblink_exec('fence_two', 'begin');
		perform dblink_send_query('fence_two', pg_temp.sql_request());
		if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
			perform pg_temp.release();
			raise exception 'B: the request must wait at the fence behind %', v_what; end if;
		if not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$) then
			perform pg_temp.release();
			raise exception 'B: the request held the company row before the fence (%)', v_what; end if;
		perform pg_temp.release();
		v_state := pg_temp.outcome('fence_two');
		perform dblink_exec('fence_two', 'rollback');
		if v_state <> 'ok' then raise exception 'B: the request after % failed: %', v_what, v_state; end if;
	end loop;
end $$;

-- C. The snapshot-v1 company keeps the gc fence: its request waits for a holder of its company row KEY SHARE.
do $$
begin
	perform pg_temp.hold('row', '64800000-0000-4000-8000-000000000011');
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', pg_temp.sql_request('64800000-0000-4000-8000-000000000011'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		perform pg_temp.release();
		raise exception 'C: a snapshot-v1 request must keep the gc fence'; end if;
	perform pg_temp.release();
	perform pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
end $$;

-- D. The deletion, committed. The purge (rolled back, so the company stays for E): the drain first, then the company row
-- FOR UPDATE, so behind a holder of the row KEY SHARE alone it waits at the row while it holds the fence.
select * from dblink('fence_three', pg_temp.sql_request()) as t(r text);
do $$
declare v_state text;
begin
	if not public.qorpera_company_deleting('64800000-0000-4000-8000-000000000010') then raise exception 'D: the deletion did not commit'; end if;
	perform pg_temp.hold('row');
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', $q$select public.qorpera_purge_company('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profiles') then
		perform pg_temp.release();
		raise exception 'D: the purge must wait at the company row'; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$, 'key share') then
		perform pg_temp.release();
		raise exception 'D: the purge must hold the fence FOR UPDATE before the company row'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	if v_state <> 'ok' and v_state not like '55000 %' then raise exception 'D: the purge ended with %', v_state; end if;
	if not exists (select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'D: the purge was rolled back'; end if;
end $$;

-- E. The finisher's drain waits out a folder effect in flight at the fence, holding no company
-- row; then the pass stops the work and, since the nodes hold nothing of the company, purges it.
do $$
declare v_state text;
begin
	if not public.qorpera_company_deleting('64800000-0000-4000-8000-000000000010') then raise exception 'E: the deletion did not commit'; end if;
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', $q$select public.qorpera_finish_company_deletion('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		perform pg_temp.release();
		raise exception 'E: the finisher must wait for the effect at the fence'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$, 'no key update') then
		perform pg_temp.release();
		raise exception 'E: the finisher held the company row before the fence'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'E: the finisher pass failed: %', v_state; end if;
	-- The nodes hold nothing of the company, so the pass purges it (its fence row with it).
	if exists (select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010')
		or (select purged_at from public.qorpera_company_deletions where profile_id = '64800000-0000-4000-8000-000000000010') is null then
		raise exception 'E: the pass must purge the company: %', v_state; end if;
end $$;

-- F. The drain refuses a company that is not being deleted, and the two helpers are postgres-only.
do $$
begin
	begin
		perform public.qorpera_folder_deletion_drain('64800000-0000-4000-8000-000000000011');
		raise exception 'F: the drain must refuse a company not being deleted' using errcode = 'QTF01';
	exception when sqlstate '55000' then
		if sqlerrm <> 'The company is not being deleted' then raise; end if;
	end;
	if has_function_privilege('service_role', 'public.qorpera_folder_deletion_drain(uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_deletion_drain(uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_deletion_enter(uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_deletion_enter(uuid)', 'execute') then
		raise exception 'F: the deletion helpers must be postgres-only'; end if;
end $$;

-- G. Snapshot-v1 keeps its text: each patched body with its folder-v2 branches reversed is byte for byte the definition
-- before this migration (master digests from a test VM run of the reversal).
create temporary table c1c3g_patches(n serial, fn text, digest text, patched text, original text) on commit preserve rows;
insert into c1c3g_patches(fn, digest, patched, original) values
	('qorpera_delete_hosted_profile(uuid)', 'd188e9c028cfd4cf9184d816eee2896a',
		E'\t-- C1c-3g (20260930002500): on folder-v2 the fence FOR NO KEY UPDATE (a leave, removal or join waits) and rank 0.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_enter(p_profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'),
	('qorpera_request_company_deletion(uuid,uuid)', 'ad8fa4b2297dc20950e8e17389f6a951',
		E'\t-- C1c-3g (20260930002500): on folder-v2 the fence FOR NO KEY UPDATE and rank 0; the finisher drains the fence.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_enter(p_profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'),
	('qorpera_request_company_deletion(uuid,uuid)', 'ad8fa4b2297dc20950e8e17389f6a951',
		E'\tif found and not public.qorpera_company_is_folder_v2(p_profile_id) then -- C1c-3g (20260930002500)\n',
		E'\tif found then\n'),
	('qorpera_stop_company_work(uuid)', '9485f077055b7b316ced0c28ef47d0fb',
		E'\tif found and not public.qorpera_company_is_folder_v2(p_profile_id) then -- C1c-3g (20260930002500)\n',
		E'\tif found then\n'),
	('qorpera_finish_company_deletion(uuid)', 'fda2fcdc37c906ef5da78a48de7db15b',
		E'\t\t\t-- C1c-3g (20260930002500): on folder-v2 the folder pause''s second phase, for deletion, then the company row\n'
		|| E'\t\t\t-- FOR UPDATE as the purge takes it, before the stop''s and the revocations'' rows (jobs, secrets, grants).\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\t\t\tperform public.qorpera_folder_deletion_drain(p_profile_id);\n'
		|| E'\t\t\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\t\t\tend if;\n',
		E'\t\t\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'),
	('qorpera_purge_company(uuid)', '39f2ce9270860ed6ae60c12e44a61f11',
		E'\t-- C1c-3g (20260930002500): on folder-v2 the drain, then the company row FOR UPDATE (the one folder-v2 path that\n'
		|| E'\t-- may: it deletes the row), after the fence and before the cascade''s children.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_drain(p_profile_id);\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'),
	('qorpera_finish_company_deletions(integer)', 'ec4dc838385b2873aee4a315056f7976',
		E'\t\t-- C1c-3g (20260930002500): finished in company id order, as the node update drains and the executor give-up\n'
		|| E'\t\t-- take their companies, so two batches of locks never cross.\n'
		|| E'\t\tselect sample.profile_id from (select deletion.profile_id from public.qorpera_company_deletions as deletion\n'
		|| E'\t\twhere deletion.purged_at is null\n'
		|| E'\t\torder by random()\n'
		|| E'\t\tlimit p_limit) as sample order by sample.profile_id\n',
		E'\t\tselect deletion.profile_id from public.qorpera_company_deletions as deletion\n'
		|| E'\t\twhere deletion.purged_at is null\n'
		|| E'\t\torder by random()\n'
		|| E'\t\tlimit p_limit\n');
do $$
declare v record; p record; v_text text; v_bad text[] := '{}';
begin
	for v in select fn, min(digest) as digest from c1c3g_patches group by fn loop
		v_text := pg_get_functiondef(('public.' || v.fn)::regprocedure);
		for p in select * from c1c3g_patches where fn = v.fn order by n loop
			if position(p.patched in v_text) = 0 then v_bad := v_bad || (v.fn || ' (a patch is missing)'); end if;
			v_text := replace(v_text, p.patched, p.original);
		end loop;
		if md5(v_text) <> v.digest then v_bad := v_bad || (v.fn || ' ' || md5(v_text)); end if;
	end loop;
	if cardinality(v_bad) > 0 then raise exception 'G: snapshot-v1 text changed in: %', v_bad; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows as 824 removes them (the purge may have removed the folder-v2 company already).
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
