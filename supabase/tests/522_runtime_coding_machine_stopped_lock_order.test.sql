-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930431000 (5g-1b, review r2): the record of a member's coding machine stopped from outside keeps the coding lock
-- order, session before machine. A plan or an admission holds its session, then takes the machine FOR UPDATE; the
-- record takes its stop row, then the machine's sessions, and the machine only at commit (the stop row's deferred key
-- check), so the two never wait for each other in a cycle. A second record of the same stop at once waits for the
-- first's stop row and answers what the first did. 648's committed fixture with two coding sessions of the folder-v2
-- company (10), both attached to the member's machine d1 on exec-522, removed at the end.

-- Coding rows (committed): two coding workers, their sessions and the member's machine, pinned to its binding text as the
-- first run authority pins it. Foreign keys and triggers are off only while they go in.
set session_replication_role = replica;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('52200000-0000-4000-8000-0000000000c' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), 'w-522', 'coding', 'Code', 'read', 'each', '{}',
	'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000b1', 1
from generate_series(1, 2) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase)
select ('52200000-0000-4000-8000-0000000000c' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'codex', '{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}', 'qorpera/coding/w-522-' || n, 'running'
from generate_series(1, 2) n;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
	instance_sha256)
values ('52200000-0000-4000-8000-0000000000d1', 'member', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-000000000002', 'exec-522', repeat('5', 64), '{}',
	encode(extensions.digest(convert_to('{}', 'utf8'), 'sha256'), 'hex'));
set session_replication_role = origin;

-- Both sessions attached to d1 for round p_round (c1 with a command running), each with its own attachment token.
create function pg_temp.ms_token(p_round integer, p_n integer) returns uuid language sql immutable as $$
	select ('52200000-0000-4000-8000-0000000000' || p_round || p_n)::uuid
$$;
create function pg_temp.ms_attach(p_round integer) returns void language sql as $$
	update public.qorpera_coding_sessions set attached_machine_id = '52200000-0000-4000-8000-0000000000d1',
		attachment_token = pg_temp.ms_token(p_round, right(worker_id::text, 1)::integer),
		attachment_until = clock_timestamp() + interval '10 minutes', attachment_turn = 1, attached_at = clock_timestamp(),
		observed_at = clock_timestamp(), running_commands = case when worker_id = '52200000-0000-4000-8000-0000000000c1'
			then '[{"commandId":"52200000-0000-4000-8000-0000000000e9","turn":1,"command":"npm run dev"}]'::jsonb else '[]'::jsonb end
	where worker_id in ('52200000-0000-4000-8000-0000000000c1', '52200000-0000-4000-8000-0000000000c2')
$$;
-- The executor's record of d1 stopped from outside after the start e<p_start>, as it sends it.
create function pg_temp.ms_record(p_start integer) returns text language sql as $$
	select format('select public.qorpera_record_coding_machine_stopped(%L, %L, %L, %L, %L)::text', '52200000-0000-4000-8000-0000000000d1',
		'52200000-0000-4000-8000-0000000000e' || p_start, 'exec-522', '{}', repeat('5', 64))
$$;
-- The first record's answer for round p_round: both attachments it ended.
create function pg_temp.ms_answer(p_round integer) returns text language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-machine-stopped/v1', 'machineId', '52200000-0000-4000-8000-0000000000d1',
		'detached', jsonb_build_array(
			jsonb_build_object('workerId', '52200000-0000-4000-8000-0000000000c1', 'attachmentToken', pg_temp.ms_token(p_round, 1)),
			jsonb_build_object('workerId', '52200000-0000-4000-8000-0000000000c2', 'attachmentToken', pg_temp.ms_token(p_round, 2))))::text
$$;
-- A sent statement's answer, or its error (state and message); drains the connection.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v_result text;
begin
	begin
		select r into v_result from dblink_get_result(p_conn) as t(r text);
	exception when others then v_result := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_result;
end $$;
-- Whether both sessions are attached nowhere and each has p_count MACHINE_STOPPED events.
create function pg_temp.ms_ended(p_count integer) returns boolean language sql as $$
	select bool_and(s.attached_machine_id is null and s.attachment_token is null and s.running_commands = '[]'::jsonb
		and (select count(*) from public.qorpera_coding_session_events e where e.worker_id = s.worker_id and e.kind = 'step'
			and e.actor = 'executor' and e.body ->> 'reason' = 'MACHINE_STOPPED') = p_count)
	from public.qorpera_coding_sessions s
	where s.worker_id in ('52200000-0000-4000-8000-0000000000c1', '52200000-0000-4000-8000-0000000000c2')
$$;
-- As in 826: a waiter at a row of a table holds its tuple lock; a row nobody holds takes FOR UPDATE NOWAIT on fence_four.
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
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for update nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;

-- A. Review r2's cycle: a plan holds its session (c1, attached to d1) and next takes the machine FOR UPDATE. The record
-- waits at that session holding nothing of the machine, so the plan takes the machine at once; once the plan commits,
-- the record ends both attachments. Had the record checked the machine key at its insert, it would hold the machine's
-- KEY SHARE here, and the plan's FOR UPDATE would close a deadlock (40P01).
select pg_temp.ms_attach(1);
do $$
declare v_result text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_coding_sessions
		where worker_id = '52200000-0000-4000-8000-0000000000c1' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.ms_record(1));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_coding_sessions') or not pg_temp.waits_for('fence_two', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'A: the record must wait at the plan''s session'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_coding_machines where id = '52200000-0000-4000-8000-0000000000d1'$q$) then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'A: the record held the machine while it waited for a session'; end if;
	perform dblink_send_query('fence_one', $q$select 1 from public.qorpera_coding_machines
		where id = '52200000-0000-4000-8000-0000000000d1' for update$q$);
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then
		raise exception 'A: the plan waited for the record at the machine'; end if;
	v_result := pg_temp.outcome('fence_one');
	perform dblink_exec('fence_one', 'commit');
	if v_result <> 'ok' then raise exception 'A: the plan''s machine lock: %', v_result; end if;
	v_result := pg_temp.result('fence_two');
	if v_result is distinct from pg_temp.ms_answer(1) then raise exception 'A: the record after the plan: %', v_result; end if;
	if not pg_temp.ms_ended(1) then raise exception 'A: both attachments end, each with one event'; end if;
end $$;

-- B. A second record of the same stop at once (a retry while the first still runs) waits for the first's stop row,
-- holding no session and nothing of the machine, and answers what the first did; no session gets a second event.
select pg_temp.ms_attach(2);
do $$
declare v_first text; v_second text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_coding_sessions
		where worker_id = '52200000-0000-4000-8000-0000000000c1' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.ms_record(2));
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'B: the first record must wait at the session'; end if;
	perform dblink_send_query('fence_three', pg_temp.ms_record(2));
	if not pg_temp.waits_for('fence_three', 'fence_two') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'B: the second record must wait for the first'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '52200000-0000-4000-8000-0000000000c2'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_coding_machines where id = '52200000-0000-4000-8000-0000000000d1'$q$) then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'B: a record waiting for a session or a stop row holds another session or the machine'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_first := pg_temp.result('fence_two');
	v_second := pg_temp.result('fence_three');
	if v_first is distinct from pg_temp.ms_answer(2) or v_second is distinct from v_first then
		raise exception 'B: both records answer the first''s detach: % / %', v_first, v_second; end if;
	if not pg_temp.ms_ended(2) then raise exception 'B: one event per session for the stop'; end if;
end $$;

-- C. The machine comes last: beside a call that holds d1 FOR UPDATE (another session's plan), the record ends both
-- attachments and then waits for the machine at commit, holding their sessions; once that call commits, it finishes.
select pg_temp.ms_attach(3);
do $$
declare v_result text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_coding_machines
		where id = '52200000-0000-4000-8000-0000000000d1' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.ms_record(3));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_coding_machines') or not pg_temp.waits_for('fence_two', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'C: the record must wait for the machine'; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '52200000-0000-4000-8000-0000000000c1'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '52200000-0000-4000-8000-0000000000c2'$q$) then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'C: the record must hold both sessions before it waits for the machine'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_result := pg_temp.result('fence_two');
	if v_result is distinct from pg_temp.ms_answer(3) then raise exception 'C: the record after the machine: %', v_result; end if;
	if not pg_temp.ms_ended(3) then raise exception 'C: both attachments end, each with one more event'; end if;
end $$;

-- D. The stop row's machine key: checked at commit, and removed with the machine.
do $$
begin
	if not exists (select 1 from pg_constraint where conrelid = 'public.qorpera_coding_machine_outside_stops'::regclass and contype = 'f'
			and confrelid = 'public.qorpera_coding_machines'::regclass and condeferrable and condeferred and confdeltype = 'c') then
		raise exception 'D: the stop row''s machine key must be checked at commit and removed with the machine'; end if;
	if (select count(*) from public.qorpera_coding_machine_outside_stops where machine_id = '52200000-0000-4000-8000-0000000000d1') <> 3 then
		raise exception 'D: each stop kept once'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the stops and the sessions' events, then 648's company rows (and the coding rows above) as 826
-- removes them.
set session_replication_role = replica;
delete from public.qorpera_coding_machine_outside_stops where machine_id = '52200000-0000-4000-8000-0000000000d1';
delete from public.qorpera_coding_session_events
where worker_id in ('52200000-0000-4000-8000-0000000000c1', '52200000-0000-4000-8000-0000000000c2');
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
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_workers where id in ('52200000-0000-4000-8000-0000000000c1',
			'52200000-0000-4000-8000-0000000000c2'))
		or exists (select 1 from public.qorpera_coding_sessions where worker_id in ('52200000-0000-4000-8000-0000000000c1',
			'52200000-0000-4000-8000-0000000000c2'))
		or exists (select 1 from public.qorpera_coding_machines where id = '52200000-0000-4000-8000-0000000000d1')
		or exists (select 1 from public.qorpera_coding_machine_outside_stops where machine_id = '52200000-0000-4000-8000-0000000000d1') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
