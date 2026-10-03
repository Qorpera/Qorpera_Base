-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C3 (P23 part 1, migration 20260930002200): a folder-v2 run's lease renewals take its job FOR NO KEY
-- UPDATE. Beside a tool call in flight (the job KEY SHARE) the job renewal and the native lease renewal run at once;
-- behind a change that ends the lease (the job FOR UPDATE) they wait. The snapshot-v1 company's renewal still takes the
-- job FOR UPDATE and waits for a KEY SHARE holder. Each snapshot-v1 body reversed is the definition before the migration,
-- and the folder copy of locked_job differs from it by its lock clause only. 648's committed fixture, removed at the end.

-- The run's native lease carries its job's lease token, as a real lease does (648's fixture gives it another), and the
-- snapshot-v1 company's leased job gets its runner, so both companies' renewals can run.
set session_replication_role = replica;
update public.qorpera_native_provider_connection_leases set lease_token_sha256 = repeat('a', 64)
where id = '64800000-0000-4000-8000-0000000000f6';
insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
	activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
values ('64800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-0000000000e4',
	'Snapshot runner', '["agent_turn"]', 'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64),
	clock_timestamp() + interval '1 hour', '64800000-0000-4000-8000-000000000003', '64800000-0000-4000-8000-0000000000e1');
set session_replication_role = origin;

create function pg_temp.sql_renew_job(p_runner uuid, p_job uuid) returns text language sql as $$
	select format('select public.qorpera_renew_runner_job(%L, %L, %L, %L)::text', p_runner, repeat('f', 64), p_job, repeat('a', 64))
$$;
create function pg_temp.sql_renew_native() returns text language sql as $$
	select format('select public.qorpera_renew_native_provider_connection_lease(%L, %L, %L, %L, %L, 120)::text',
		'64800000-0000-4000-8000-0000000000f6', '64800000-0000-4000-8000-0000000000f4', repeat('f', 64),
		'64800000-0000-4000-8000-0000000000f2', repeat('a', 64))
$$;
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

-- A. Beside a tool call in flight, which holds the job KEY SHARE: both renewals run at once and move their leases.
do $$
declare v_state text; v_job timestamptz; v_lease timestamptz;
begin
	select lease_expires_at into v_job from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2';
	select expires_at into v_lease from public.qorpera_native_provider_connection_leases where id = '64800000-0000-4000-8000-0000000000f6';
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	foreach v_state in array array[pg_temp.sql_renew_job('64800000-0000-4000-8000-0000000000f4', '64800000-0000-4000-8000-0000000000f2'),
		pg_temp.sql_renew_native()] loop
		perform dblink_send_query('fence_two', v_state);
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
			perform dblink_exec('fence_one', 'rollback');
			raise exception 'A: a renewal waited for the tool call in flight: %', v_state; end if;
		if pg_temp.outcome('fence_two') <> 'ok' then
			perform dblink_exec('fence_one', 'rollback');
			raise exception 'A: the renewal failed: %', v_state; end if;
	end loop;
	perform dblink_exec('fence_one', 'commit');
	-- Each renewal sets its lease to a fixed span from now (the job 6 minutes, the native lease 120 s), replacing the
	-- fixture's hour.
	if (select lease_expires_at from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2') = v_job
		or abs(extract(epoch from (select lease_expires_at - clock_timestamp() from public.qorpera_runner_jobs
			where id = '64800000-0000-4000-8000-0000000000f2')) - 360) > 60
		or (select expires_at from public.qorpera_native_provider_connection_leases where id = '64800000-0000-4000-8000-0000000000f6') = v_lease
		or abs(extract(epoch from (select expires_at - clock_timestamp() from public.qorpera_native_provider_connection_leases
			where id = '64800000-0000-4000-8000-0000000000f6')) - 120) > 60 then
		raise exception 'A: both leases must have been renewed'; end if;
end $$;

-- B. Behind a change that ends the lease (the job FOR UPDATE, as completion takes it), both renewals wait at the job, and
-- then renew.
do $$
declare v_sql text; v_state text;
begin
	foreach v_sql in array array[pg_temp.sql_renew_job('64800000-0000-4000-8000-0000000000f4', '64800000-0000-4000-8000-0000000000f2'),
		pg_temp.sql_renew_native()] loop
		perform dblink_exec('fence_one', 'begin');
		perform * from dblink('fence_one', $q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2'
			for update$q$) as t(x integer);
		perform dblink_send_query('fence_two', v_sql);
		if not pg_temp.waits_at('fence_two', 'public.qorpera_runner_jobs') then
			perform dblink_exec('fence_one', 'rollback');
			raise exception 'B: a renewal must wait for a lease-ending change: %', v_sql; end if;
		perform dblink_exec('fence_one', 'rollback');
		v_state := pg_temp.outcome('fence_two');
		if v_state <> 'ok' then raise exception 'B: the renewal after it: % (%)', v_state, v_sql; end if;
	end loop;
end $$;

-- C. The snapshot-v1 company's renewal still takes the job FOR UPDATE: it waits for a holder of the job KEY SHARE.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000e2'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_renew_job('64800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-0000000000e2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'C: the snapshot-v1 renewal must wait for a KEY SHARE holder'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'C: the snapshot-v1 renewal after it: %', v_state; end if;
end $$;

-- D. Snapshot-v1 keeps its text: each patched body with its folder-v2 branch reversed is byte for byte the definition
-- before the migration. The folder copy of locked_job is locked_job with its name, its marker line and its lock clause
-- changed, and nothing else; it is postgres-only.
do $$
declare v_text text;
begin
	v_text := replace(pg_get_functiondef('public.qorpera_renew_runner_job(uuid,text,uuid,text)'::regprocedure),
		E'\t-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run''s tool calls (KEY SHARE).\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\t\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\t\tand job.lease_expires_at > statement_timestamp() for no key update;\n'
		|| E'\telse\n'
		|| E'\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\tand job.lease_expires_at > statement_timestamp() for update;\n'
		|| E'\tend if;\n',
		E'\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\tand job.lease_expires_at > statement_timestamp() for update;\n');
	if md5(v_text) <> 'dc8ef1066f63642b528d8b26b421a82d' then raise exception 'D: qorpera_renew_runner_job''s snapshot-v1 text changed'; end if;
	v_text := replace(pg_get_functiondef('public.qorpera_renew_native_provider_connection_lease(uuid,uuid,text,uuid,text,integer)'::regprocedure),
		E'\t-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run''s tool calls (KEY SHARE).\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\tv_job := public.qorpera_folder_renewal_locked_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);\n'
		|| E'\telse\n'
		|| E'\tv_job := public.qorpera_runner_broker_locked_job(\n'
		|| E'\t\tp_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256\n'
		|| E'\t);\n'
		|| E'\tend if;\n',
		E'\tv_job := public.qorpera_runner_broker_locked_job(\n'
		|| E'\t\tp_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256\n'
		|| E'\t);\n');
	if md5(v_text) <> '2546503acb0072743faeee7ad9ca4945' then
		raise exception 'D: qorpera_renew_native_provider_connection_lease''s snapshot-v1 text changed'; end if;
	if md5(pg_get_functiondef('public.qorpera_runner_broker_locked_job(uuid,text,uuid,text)'::regprocedure)) <> '832db8b900e3b8119c5f56c4a1b8ec88' then
		raise exception 'D: qorpera_runner_broker_locked_job must not change'; end if;
	v_text := replace(replace(replace(pg_get_functiondef('public.qorpera_folder_renewal_locked_job(uuid,text,uuid,text)'::regprocedure),
		'FUNCTION public.qorpera_folder_renewal_locked_job(', 'FUNCTION public.qorpera_runner_broker_locked_job('),
		E'\t-- P23 (20260930002200): a folder-v2 renewal; tool calls hold the job KEY SHARE, which this mode does not block.\n', ''),
		E'\tfor no key update;\n', E'\tfor update;\n');
	if md5(v_text) <> '832db8b900e3b8119c5f56c4a1b8ec88' then raise exception 'D: the folder copy of locked_job differs beyond its lock'; end if;
	if has_function_privilege('public', 'public.qorpera_folder_renewal_locked_job(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_renewal_locked_job(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_renewal_locked_job(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_renewal_locked_job(uuid,text,uuid,text)', 'execute') then
		raise exception 'D: qorpera_folder_renewal_locked_job must be postgres-only'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture as 648 removes it, the snapshot-v1 runner included.
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
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_runners where id = '64800000-0000-4000-8000-0000000000e4')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
