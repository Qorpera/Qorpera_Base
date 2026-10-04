-- @fixture 709_folder_state_routines_concurrency.test.sql until "-- A. The scheduler holds the routine"
-- Company folder core, P29a under concurrency (migration 20260930020000; deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md
-- §3, §4): the drain takes the fence, rank 0 and its ranks before its lease (the cursor row, SKIP LOCKED), so two drains of
-- one company never both write, a company purge (the fence FOR UPDATE, then the cascade to the cursor) meets a drain at the
-- fence and never in a circle, a commit never waits on a drain, and a routine save meets a drain at the routine row. On
-- 709's committed fixture with a listener of Nora's added; removed at the end. Waits are detected with pg_blocking_pids.

create function pg_temp.put(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
		|| case when pg_temp.version(public.qorpera_folder_key(p_path)) is not null
			then jsonb_build_object('expectedVersion', pg_temp.version(public.qorpera_folder_key(p_path))) else '{}'::jsonb end
$$;
create function pg_temp.listen_sql() returns text language sql as $$
	select $q$select public.qorpera_folder_listen_company('70900000-0000-4000-8000-000000000020')$q$
$$;
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- True when the sent statement finishes without ever waiting on the holder.
create function pg_temp.finishes_unblocked(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_waiter) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer
				= any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then return false; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.file_wakes() returns integer language sql as $$
	select count(*)::integer from public.qorpera_wake_occurrences where routine_id = '88800000-0000-4000-8000-0000000000e3'
		and source_kind = 'company-file'
$$;

-- Committed: docs/ and a listener of Nora's on it; a first step brings the cursor up to now.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0001', jsonb_build_array(jsonb_build_object('op','mkdir','path','docs'),
	pg_temp.routine('agents/nora/routines/watch.md', pg_temp.rparse('88800000-0000-4000-8000-0000000000e3', 'Watch docs',
		jsonb_build_object('when','file-change','watch','docs','match','subtree'))))), 2, 'saved') \g /dev/null
select public.qorpera_folder_listen_company('70900000-0000-4000-8000-000000000020') \g /dev/null

-- L1. Two drains of one company. With a listener to wake, the second waits at the routine row, then finds the cursor moved
-- (busy) and writes nothing: one wake. With nothing to wake, it reaches the cursor at once and skips it (busy).
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0002', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha'))), 1, 'saved')
	\g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', pg_temp.listen_sql()) as t(x jsonb);
	perform dblink_send_query('rrace_sched', pg_temp.listen_sql());
	if not pg_temp.waits_for('rrace_sched', 'rrace_hold') then raise exception 'The second drain waits at the routine row'; end if;
	perform dblink_exec('rrace_hold', 'commit');
	r := pg_temp.result('rrace_sched');
	if r ->> 'state' <> 'busy' or pg_temp.file_wakes() <> 1 then raise exception 'One wake, the second drain busy: % %', r, pg_temp.file_wakes(); end if;
end $$;
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0003', jsonb_build_array(pg_temp.put('notes.md', 'outside'))), 1, 'saved')
	\g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', pg_temp.listen_sql()) as t(x jsonb);
	perform dblink_send_query('rrace_sched', pg_temp.listen_sql());
	if not pg_temp.finishes_unblocked('rrace_sched', 'rrace_hold') then raise exception 'With nothing to wake, the lease is skipped'; end if;
	r := pg_temp.result('rrace_sched');
	perform dblink_exec('rrace_hold', 'commit');
	if r ->> 'state' <> 'busy' then raise exception 'A held cursor answers busy: %', r; end if;
end $$;

-- L2. The company purge takes the fence FOR UPDATE, then its cascade reaches the cursor. A drain holding its lease holds the
-- fence first (KEY SHARE), so the purge waits there and never at the cursor; a purge holding the fence makes the drain wait
-- at the fence. Neither waits in a circle.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0004', jsonb_build_array(pg_temp.put('docs/b.md', 'beta'))), 1, 'saved')
	\g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', pg_temp.listen_sql()) as t(x jsonb);
	perform dblink_exec('rrace_save', 'begin');
	perform dblink_send_query('rrace_save', $q$select 1 from public.qorpera_folder_fences
		where profile_id = '70900000-0000-4000-8000-000000000010' for update$q$);
	if not pg_temp.waits_for('rrace_save', 'rrace_hold') then raise exception 'The purge waits for the drain at the fence'; end if;
	perform dblink_exec('rrace_hold', 'commit');
	perform * from dblink_get_result('rrace_save') as t(x integer);
	perform * from dblink_get_result('rrace_save') as t(x integer);
	-- The cascade's own step: the cursor row, now free.
	perform dblink_send_query('rrace_save', $q$delete from public.qorpera_folder_listener_cursors
		where environment_id = '70900000-0000-4000-8000-000000000020'$q$);
	if not pg_temp.finishes_unblocked('rrace_save', 'rrace_hold') then raise exception 'The cursor is free once the drain ended'; end if;
	perform * from dblink_get_result('rrace_save') as t(x text);
	perform * from dblink_get_result('rrace_save') as t(x text);
	perform dblink_exec('rrace_save', 'rollback');
end $$;
-- The other order: the purge holds the fence; a drain with work waits there (and answers busy at its lock budget).
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0004b', jsonb_build_array(pg_temp.put('docs/b2.md', 'beta two'))), 1, 'saved')
	\g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_save', 'begin');
	perform * from dblink('rrace_save', $q$select 1 from public.qorpera_folder_fences
		where profile_id = '70900000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('rrace_hold', pg_temp.listen_sql());
	if not pg_temp.waits_for('rrace_hold', 'rrace_save') then raise exception 'The drain waits for the purge at the fence'; end if;
	perform dblink_exec('rrace_save', 'rollback');
	r := pg_temp.result('rrace_hold');
	if r ->> 'state' not in ('done', 'busy') then raise exception 'The drain ends cleanly: %', r; end if;
end $$;

-- L3. A commit never waits on a drain: the drain's locks (fence and company KEY SHARE, the agent, the routine, the cursor,
-- admission) are none a commit of a plain file takes.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0005', jsonb_build_array(pg_temp.put('docs/c.md', 'gamma'))), 1, 'saved')
	\g /dev/null
select set_config('qorpera_test.write_d', pg_temp.sql_commit('70900000-0000-4000-8000-000000000020', pg_temp.owner()::text,
	'lrace-0006', jsonb_build_array(pg_temp.put('docs/d.md', 'delta'))::text), false) \g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', pg_temp.listen_sql()) as t(x jsonb);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.write_d'));
	if not pg_temp.finishes_unblocked('rrace_save', 'rrace_hold') then raise exception 'A commit never waits on a drain'; end if;
	r := pg_temp.result('rrace_save');
	perform dblink_exec('rrace_hold', 'commit');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The commit saved: %', r; end if;
end $$;

-- L4. A save of the listener meets a drain at the routine row (rank 5, both NO KEY UPDATE), before any path.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'lrace-0007', jsonb_build_array(pg_temp.put('docs/e.md', 'epsilon'))), 1, 'saved')
	\g /dev/null
select set_config('qorpera_test.retitle_watch', pg_temp.sql_commit('70900000-0000-4000-8000-000000000020', pg_temp.owner()::text,
	'lrace-0008', jsonb_build_array(pg_temp.routine('agents/nora/routines/watch.md', pg_temp.rparse('88800000-0000-4000-8000-0000000000e3',
		'Watch docs closely', jsonb_build_object('when','file-change','watch','docs','match','subtree'))))::text), false) \g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', pg_temp.listen_sql()) as t(x jsonb);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.retitle_watch'));
	if not pg_temp.waits_for('rrace_save', 'rrace_hold') then raise exception 'The save waits for the drain at the routine row'; end if;
	perform dblink_exec('rrace_hold', 'commit');
	r := pg_temp.result('rrace_save');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The save went on: %', r; end if;
end $$;

select dblink_disconnect(name) from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;

-- The committed fixture leaves the shared suite database, as 709's does.
set session_replication_role = replica;
delete from public.qorpera_folder_listener_hook_failures where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_listener_cursors where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routine_schedule_cursors where routine_id in (select id from public.qorpera_cloud_routines
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_cloud_routine_versions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id in (select id from public.qorpera_execution_sponsor_bindings
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_execution_sponsor_bindings where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_provider_connection_versions where connection_id in (select id from public.qorpera_provider_connections
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_provider_connections where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_company_index where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '70900000-0000-4000-8000-000000000020';
-- P17's conflict copies hold their commits (RESTRICT): gone first, once the table exists.
do $$
begin
	if to_regclass('public.qorpera_folder_conflict_copies') is not null then
		execute 'delete from public.qorpera_folder_conflict_copies where environment_id = ''70900000-0000-4000-8000-000000000020''';
	end if;
end $$;
delete from public.qorpera_folder_commits where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010';
-- A hire's kickoff input, first run and turn request (P15 makes them; none before it), before their conversations.
delete from public.qorpera_session_turn_requests where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_agent_first_runs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010';
set session_replication_role = origin;
delete from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '70900000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010';
delete from auth.users where id in ('70900000-0000-4000-8000-000000000001','70900000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '70900000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_listener_cursors where environment_id = '70900000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '70900000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
