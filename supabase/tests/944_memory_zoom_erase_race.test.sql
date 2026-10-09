-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Summary trees M1b part 3 (migration 20260930202000) under concurrency: a zoom and an erase of the conversation it reads
-- (RUNTIME-AGENT-MEMORY-TREE.md §8, §10). The zoom stores its receipt, then takes the session FOR SHARE and reads in the
-- statements after; the erase takes the session FOR UPDATE and scans receipts in a later statement. So an erase first
-- makes the zoom wait and read what it left, and a zoom first makes the erase wait and find its receipt. A role change
-- of the run's payer meets a zoom before its receipt, in either order without a deadlock (§14). On 648's committed
-- company, in Ada's thread (the run's own conversation); the fixture goes at the end.

-- Four messages in Ada's thread, committed.
set session_replication_role = replica;
insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at)
select '64800000-0000-4000-8000-0000000000f7', n, ('94400000-0000-4000-8000-e' || lpad(n::text, 11, '0'))::uuid, 'message',
	'64800000-0000-4000-8000-000000000002', jsonb_build_object('entry', jsonb_build_object('message', jsonb_build_object(
		'role', case when n % 2 = 1 then 'user' else 'assistant' end, 'content', (array['one','two','three','four'])[n]))),
	lpad(to_hex(n), 64, '0'), timestamptz '2026-10-04 09:00:00+00' + n * interval '1 minute'
from generate_series(1, 4) n;
set session_replication_role = origin;

create function pg_temp.sql_zoom(p_request jsonb) returns text language sql as $$
	select format('select public.qorpera_memory_zoom(%L, %L)::text', current_setting('qorpera_test.binding'), p_request)
$$;
-- A sent zoom's answer, and the connection drained.
create function pg_temp.answer(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select x::jsonb into v from dblink_get_result(p_conn) as t(x text);
	begin
		perform * from dblink_get_result(p_conn) as t(x text);
	exception when others then null;
	end;
	return v;
end $$;
-- The erase's steps on a connection in an open transaction: the session FOR UPDATE, then (in later statements) the
-- event's body and the conversation's generation, as M3's erase leaves them.
create function pg_temp.sql_erase(p_seq integer) returns text language sql as $$
	select format('set local session_replication_role = replica; '
		'update public.qorpera_session_events set body = %L where session_id = %L and sequence = %s; '
		'update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = %L',
		'{"erased":true}', '64800000-0000-4000-8000-0000000000f7', p_seq, '64800000-0000-4000-8000-0000000000f7')
$$;
create function pg_temp.receipt(p_call text) returns text language sql as $$
	select format('%s+%s', start, size) from public.qorpera_memory_read_receipts
	where run_id = '64800000-0000-4000-8000-0000000000f1' and call_id = p_call and tool = 'zoom'
		and target_session_id = '64800000-0000-4000-8000-0000000000f7'
$$;

-- Before any race the third message reads as written. The thread has no room here, so it is a plain conversation named
-- by its title.
do $$
declare r jsonb := public.qorpera_memory_zoom(current_setting('qorpera_test.binding')::jsonb, '{"callId":"before","line":"2+1"}');
begin
	if r -> 'event' ->> 'text' is distinct from 'three' or r -> 'event' ->> 'erased' <> 'false' or r ->> 'messages' <> '4'
		or r -> 'conversation' is distinct from jsonb_build_object('ref', '.', 'sessionId', '64800000-0000-4000-8000-0000000000f7',
			'kind', 'conversation', 'name', 'Ada') then
		raise exception 'Before the race the third message reads: %', r; end if;
end $$;

-- A. The erase first. fence_one holds the session FOR UPDATE and has erased the third message; fence_two's zoom of it
-- stores its receipt and waits at the session, and once the erase commits it reads the erased event, not the text.
select dblink_exec('fence_one', 'begin');
select * from dblink('fence_one', format('select 1 from public.qorpera_shared_sessions where id = %L for update',
	'64800000-0000-4000-8000-0000000000f7')) as t(x integer);
select dblink_exec('fence_one', pg_temp.sql_erase(3));
select dblink_send_query('fence_two', pg_temp.sql_zoom('{"callId":"race-a","line":"2+1"}'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the zoom does not wait for the erase'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'A: the zoom waits at %, not at the session', pg_temp.queued_on('fence_two'); end if;
	if not exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_two')::integer and granted
			and relation = 'public.qorpera_memory_read_receipts'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'A: the zoom waits at the session before it stored its receipt'; end if;
end $$;
select dblink_exec('fence_one', 'commit');
do $$
declare r jsonb;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'A: the zoom did not end'; end if;
	r := pg_temp.answer('fence_two');
	if r -> 'event' ->> 'erased' is distinct from 'true' or r -> 'event' ->> 'text' is not null or r -> 'event' ->> 'sequence' <> '3' then
		raise exception 'A: the zoom after the erase reads: %', r; end if;
	if pg_temp.receipt('race-a') is distinct from '2+1' then raise exception 'A: the receipt is %', pg_temp.receipt('race-a'); end if;
end $$;

-- B. The zoom first. fence_two's zoom of the first message is open (its receipt stored, the session FOR SHARE); the
-- erase's lock in fence_one waits for it, and the erase's next statement finds the receipt.
select dblink_exec('fence_two', 'begin');
do $$
declare r jsonb;
begin
	select x::jsonb into r from dblink('fence_two', pg_temp.sql_zoom('{"callId":"race-b","line":"0+1"}')) as t(x text);
	if r -> 'event' ->> 'text' is distinct from 'one' then raise exception 'B: the open zoom reads: %', r; end if;
end $$;
select dblink_exec('fence_one', 'begin');
select dblink_send_query('fence_one', format('select 1 from public.qorpera_shared_sessions where id = %L for update',
	'64800000-0000-4000-8000-0000000000f7'));
do $$
begin
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'B: the erase does not wait for the zoom'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'B: the erase waits at %, not at the session', pg_temp.queued_on('fence_one'); end if;
end $$;
select dblink_exec('fence_two', 'commit');
do $$
declare v_outcome text; v_found text;
begin
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'B: the erase''s lock did not end'; end if;
	v_outcome := pg_temp.outcome('fence_one');
	if v_outcome <> 'ok' then raise exception 'B: the erase''s lock: %', v_outcome; end if;
	select x into v_found from dblink('fence_one', format('select string_agg(format(''%%s+%%s'', start, size), '','')
		from public.qorpera_memory_read_receipts where target_session_id = %L and call_id = %L',
		'64800000-0000-4000-8000-0000000000f7', 'race-b')) as t(x text);
	if v_found is distinct from '0+1' then raise exception 'B: the erase''s scan finds %, not the zoom''s receipt', v_found; end if;
	perform dblink_exec('fence_one', pg_temp.sql_erase(1));
	perform dblink_exec('fence_one', 'commit');
end $$;
-- The same call again keeps its receipt and reads what the erase left.
do $$
declare r jsonb := public.qorpera_memory_zoom(current_setting('qorpera_test.binding')::jsonb, '{"callId":"race-b","line":"0+1"}');
begin
	if r -> 'event' ->> 'erased' is distinct from 'true' or r -> 'event' ->> 'text' is not null then
		raise exception 'B: the retry after the erase reads: %', r; end if;
	if (select count(*) from public.qorpera_memory_read_receipts where run_id = '64800000-0000-4000-8000-0000000000f1') <> 3
		or (select memory_generation from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7') <> 2 then
		raise exception 'B: the receipts and the generation after both erases'; end if;
end $$;

-- C. A role change of the run's payer (the requester) beside a zoom (§14). They meet at the payer's member row: the run
-- check's rank 1 (KEY SHARE) and the change's FOR UPDATE, before the zoom's receipt and session, so neither order
-- deadlocks. C1: the change first; the zoom waits at the member with no receipt yet, and reads once the change is gone.
select dblink_exec('fence_one', 'begin');
select * from dblink('fence_one', format('select public.qorpera_folder_member_change_enter(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002', 'role')) as t(x text);
select dblink_send_query('fence_two', pg_temp.sql_zoom('{"callId":"race-c1","line":"1+1"}'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C1: the zoom does not wait for the role change'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_profile_members'::regclass then
		raise exception 'C1: the zoom waits at %, not at the payer', pg_temp.queued_on('fence_two'); end if;
	if exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_two')::integer
			and relation = 'public.qorpera_memory_read_receipts'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'C1: the zoom stored its receipt before the payer''s row'; end if;
end $$;
select dblink_exec('fence_one', 'rollback');
do $$
declare r jsonb;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'C1: the zoom did not end'; end if;
	r := pg_temp.answer('fence_two');
	if r -> 'event' ->> 'text' is distinct from 'two' then raise exception 'C1: the zoom after the role change reads: %', r; end if;
	if pg_temp.receipt('race-c1') is distinct from '1+1' then raise exception 'C1: the receipt is %', pg_temp.receipt('race-c1'); end if;
end $$;

-- C2: the zoom first, open with its receipt and the session FOR SHARE; the role change waits for it at the payer, and
-- both end.
select dblink_exec('fence_two', 'begin');
do $$
declare r jsonb;
begin
	select x::jsonb into r from dblink('fence_two', pg_temp.sql_zoom('{"callId":"race-c2","line":"3+1"}')) as t(x text);
	if r -> 'event' ->> 'text' is distinct from 'four' then raise exception 'C2: the open zoom reads: %', r; end if;
end $$;
select dblink_exec('fence_one', 'begin');
select dblink_send_query('fence_one', format('select public.qorpera_folder_member_change_enter(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002', 'role'));
do $$
declare v_outcome text;
begin
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'C2: the role change does not wait for the zoom'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profile_members'::regclass then
		raise exception 'C2: the role change waits at %, not at the payer', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'C2: the role change did not end'; end if;
	v_outcome := pg_temp.outcome('fence_one');
	if v_outcome <> 'ok' then raise exception 'C2: the role change: %', v_outcome; end if;
	perform dblink_exec('fence_one', 'rollback');
	if pg_temp.receipt('race-c2') is distinct from '3+1' then raise exception 'C2: the receipt is %', pg_temp.receipt('race-c2'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 919 does).
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
		or exists (select 1 from public.qorpera_memory_read_receipts where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_session_events where session_id = '64800000-0000-4000-8000-0000000000f7') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
