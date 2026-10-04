-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3n (migration 20260930034000): a run's machine and the node updates on the folder core's
-- order, folder-v2 only. A run's machine reservation takes its job, then the folder fence and rank 0, the requester and
-- the identity's machine lock (a sign-in's machine of the identity waits on the same lock); the node reservation of a
-- run's machine and a release take the folder fence and rank 0. None waits for a folder effect; each waits at the fence
-- behind a stop's second phase. The three node-update steps take each company's fence KEY SHARE alone: an effect never
-- waits for them nor they for it, a resume and a deletion's finisher wait for them, and none deadlocks. 648's committed
-- fixture with a run's machine allocation and a node under update, removed at the end.

-- Committed rows: a machine allocation of Ada's run (runner f4) and a node whose update names the folder-v2 company.
set session_replication_role = replica;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
values ('84900000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000f1',
	'64800000-0000-4000-8000-0000000000f4', 'lxd', repeat('8', 64));
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('84900000-0000-4000-8000-0000000000e1', repeat('9', 64), 'update-node-849', 1, 8000, 17179869184, 1000,
	1073741824, 4000, 8589934592, true);
insert into public.qorpera_node_update_enrollments(node_id, capability_revision, capability_sha256, enabled,
	current_revision, current_release_sha256, current_artifact_sha256)
values ('84900000-0000-4000-8000-0000000000e1', 1, encode(extensions.digest(repeat('7', 64), 'sha256'), 'hex'), true, 0, repeat('b', 64),
	repeat('c', 64));
insert into public.qorpera_node_update_targets(node_id, revision, release_sha256, release_text, signature,
	publication_evidence_sha256, company_ids)
values ('84900000-0000-4000-8000-0000000000e1', 1, repeat('d', 64), '{}', 'fixture', repeat('e', 64),
	array['64800000-0000-4000-8000-000000000010'::uuid]);
set session_replication_role = origin;

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
	select format('select public.qorpera_request_company_deletion(%L, %L)::text', p_profile, '64800000-0000-4000-8000-000000000001')
$$;

-- The calls, as their callers send them. Each is refused or answers after its locks for its own reasons; what matters
-- here is where it waits.
create function pg_temp.sql_call(p_what text) returns text language sql as $$
	select case p_what
		when 'reserve' then format('select public.qorpera_reserve_runtime_machine(%L, %L, %L, %L, %L)::text',
			'64800000-0000-4000-8000-0000000000f4', 'lxd', repeat('6', 64), '64800000-0000-4000-8000-0000000000f1',
			'64800000-0000-4000-8000-0000000000f4')
		when 'node' then format('select public.qorpera_reserve_runtime_node_machine(%L, %L, %L, %L, %L, %L, 1, 1)::text',
			'84900000-0000-4000-8000-0000000000a1', 'native', 'lxd', repeat('5', 64), repeat('8', 64), repeat('9', 64))
		when 'release' then format('select public.qorpera_release_runtime_machine(%L, %L, %L)::text',
			'84900000-0000-4000-8000-0000000000a1', 'lxd', repeat('8', 64))
		when 'authorize' then format('select public.qorpera_authorize_node_update_drain(%L, %L, %L)::text',
			'84900000-0000-4000-8000-0000000000e1', repeat('d', 64), repeat('e', 64))
		when 'locked' then format('select (public.qorpera_node_update_locked(%L, 1, %L, %L)).node_id::text',
			'84900000-0000-4000-8000-0000000000e1', repeat('7', 64), repeat('d', 64))
		else format('select public.qorpera_release_node_update_admission(%L, %L, 1, %L)::text',
			'84900000-0000-4000-8000-0000000000e1', repeat('d', 64), repeat('e', 64)) end
$$;

-- A. Beside a folder effect (the fence and the company row KEY SHARE) none of the six waits.
do $$
declare v_what text; v_state text;
begin
	foreach v_what in array array['reserve', 'node', 'release', 'authorize', 'locked', 'admission'] loop
		perform pg_temp.hold('effect');
		perform dblink_send_query('fence_two', pg_temp.sql_call(v_what));
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
			perform pg_temp.release(); perform pg_temp.outcome('fence_two');
			raise exception 'A: % waited for a folder effect', v_what; end if;
		v_state := pg_temp.outcome('fence_two');
		perform pg_temp.release();
		if v_state like '40P01%' or v_state like '55P03%' then raise exception 'A: % ended with %', v_what, v_state; end if;
	end loop;
end $$;

-- B. Behind a stop's second phase (the fence FOR UPDATE) each waits at the fence: the run's reservation holding only its
-- job (838's lease rule: the job first), the others holding nothing of the company and no node row.
do $$
declare v_what text; v_state text;
begin
	foreach v_what in array array['reserve', 'node', 'release', 'authorize', 'locked', 'admission'] loop
		perform pg_temp.hold('stop');
		perform dblink_exec('fence_two', 'begin');
		perform dblink_send_query('fence_two', pg_temp.sql_call(v_what));
		if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
			perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
			raise exception 'B: % must wait at the folder fence', v_what; end if;
		if not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$, 'no key update')
			or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_machine_allocations where id = '84900000-0000-4000-8000-0000000000a1'$q$)
			or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_nodes where id = '84900000-0000-4000-8000-0000000000e1'$q$)
			or (v_what = 'reserve') = pg_temp.row_free($q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2'$q$) then
			perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
			raise exception 'B: % held the wrong rows while it waited at the fence', v_what; end if;
		perform pg_temp.release();
		v_state := pg_temp.outcome('fence_two');
		perform dblink_exec('fence_two', 'rollback');
		if v_state like '40P01%' or v_state like '55P03%' then raise exception 'B: % ended with %', v_what, v_state; end if;
	end loop;
end $$;

-- C. A run's machine and a sign-in's machine of one identity serialize on the identity's machine lock: the run's
-- reservation waits for a holder of that lock, after the fence, rank 0 and its requester.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' ||
		'64800000-0000-4000-8000-0000000000d1', 0))::text$q$) as t(r text);
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', pg_temp.sql_call('reserve'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
		raise exception 'C: the run''s reservation must wait on the identity''s machine lock'; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '64800000-0000-4000-8000-000000000002'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$, 'no key update') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
		raise exception 'C: the identity''s lock comes after the fence, rank 0 KEY SHARE and the requester'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	if v_state like '40P01%' or v_state like '55P03%' then raise exception 'C: the reservation ended with %', v_state; end if;
end $$;

-- D. A resume waits for a node-update step that holds the companies' fences, so the node's pause proof holds.
select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'test 849') \g /dev/null
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_call('locked')) as t(r text);
	perform dblink_send_query('fence_three', $q$select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('fence_three', 'fence_two') then
		perform dblink_exec('fence_two', 'rollback'); perform pg_temp.outcome('fence_three');
		raise exception 'D: a resume must wait for the node update'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'D: the resume after the node update, got %', v_state; end if;
end $$;

-- E. A deletion's finisher waits at the fence for a node-update step holding it, then finishes: no deadlock. (The node's
-- update names the company, so the pass keeps it for now rather than purging it.)
select * from dblink('fence_three', pg_temp.sql_request()) as t(r text);
do $$
declare v_state text;
begin
	if not public.qorpera_company_deleting('64800000-0000-4000-8000-000000000010') then raise exception 'E: the deletion did not commit'; end if;
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_call('locked')) as t(r text);
	perform dblink_send_query('fence_three', $q$select public.qorpera_finish_company_deletion('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_at('fence_three', 'public.qorpera_folder_fences') then
		perform dblink_exec('fence_two', 'rollback'); perform pg_temp.outcome('fence_three');
		raise exception 'E: the finisher must wait at the fence for the node update'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'E: the finisher after the node update, got %', v_state; end if;
end $$;

-- F. Every patched body carries the marker.
do $$
begin
	if exists (select 1 from unnest(array['public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
			'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
			'public.qorpera_release_runtime_machine(uuid,text,text)', 'public.qorpera_authorize_node_update_drain(uuid,text,text)',
			'public.qorpera_node_update_locked(uuid,bigint,text,text)',
			'public.qorpera_release_node_update_admission(uuid,text,bigint,text)']) f
		where position('20260930034000' in pg_get_functiondef(f::regprocedure)) = 0) then
		raise exception 'F: a patched body lacks its marker'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows as 824 removes them (its allocation and node with it).
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
	delete from public.qorpera_node_update_targets where node_id = '84900000-0000-4000-8000-0000000000e1';
	delete from public.qorpera_node_update_enrollments where node_id = '84900000-0000-4000-8000-0000000000e1';
	delete from public.qorpera_runtime_nodes where id = '84900000-0000-4000-8000-0000000000e1';
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
		or exists (select 1 from public.qorpera_runtime_nodes where id in ('82400000-0000-4000-8000-000000000410',
			'84900000-0000-4000-8000-0000000000e1'))
		or exists (select 1 from public.qorpera_runtime_machine_allocations where id = '84900000-0000-4000-8000-0000000000a1')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-824')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
