-- @fixture 709_folder_state_routines_concurrency.test.sql until "-- A. The scheduler holds the routine"
-- Company folder core, E2a under concurrency (migration 20260930061000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md
-- §4.2, §4.3): an event routine's save takes its hook FOR SHARE at rank 5 and a hook's removal takes it FOR NO KEY UPDATE
-- there, so they serialize: a removal waits for an open save (which saved), and a save waits for an open removal and is
-- then refused by its rules. The event drain holds the hook FOR SHARE too, so a removal waits for a drain step. On 709's
-- committed fixture with three hooks added; removed at the end. Waits are detected with pg_blocking_pids.

create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- Reads a sent statement's error (state and message) or 'ok', and drains the connection.
create function pg_temp.outcome(p_conn text) returns text language plpgsql as $$
declare v_state text := 'ok';
begin
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then v_state := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_state;
end $$;
-- The table whose row a waiting connection queues on: a row waiter holds that row's tuple lock while it sleeps.
create function pg_temp.queued_on(p_conn text) returns regclass language sql as $$
	select relation::regclass from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and locktype = 'tuple' and granted limit 1
$$;
create function pg_temp.ev(p_hook text) returns jsonb language sql as $$
	select jsonb_build_object('when','event','hook',p_hook,'only',null)
$$;
create function pg_temp.remove_sql(p_hook text) returns text language sql as $$
	select format('select public.qorpera_set_event_hook_status(%L, %L)::text', p_hook, 'removed')
$$;
create function pg_temp.save_sql(p_key text, p_path text, p_id text, p_hook text) returns text language sql as $$
	select pg_temp.sql_commit('70900000-0000-4000-8000-000000000020', pg_temp.owner()::text, p_key,
		jsonb_build_array(pg_temp.routine(p_path, pg_temp.rparse(p_id::uuid, 'Events', pg_temp.ev(p_hook))))::text)
$$;

-- Committed: three hooks of the company.
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute,
	created_by_user_id)
select h.id, '70900000-0000-4000-8000-000000000010', '70900000-0000-4000-8000-000000000020', h.name, 'Race.', 'address',
	translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'), 65536, 60,
	'70900000-0000-4000-8000-000000000001'
from (values ('92300000-0000-4000-8000-0000000000b1'::uuid, 'race-one'), ('92300000-0000-4000-8000-0000000000b2'::uuid, 'race-two'),
	('92300000-0000-4000-8000-0000000000b3'::uuid, 'race-three')) h(id, name);
-- The removals run as the owner, on the scheduler's connection.
select dblink_exec('rrace_sched', $q$set request.jwt.claims = '{"role":"authenticated","sub":"70900000-0000-4000-8000-000000000001"}'$q$);

-- R1. A save holds its hook (an open transaction); the removal waits for it at the hook row, then removes it. The routine
-- saved before the removal, so its listener exists and never wakes.
select set_config('qorpera_test.save_one', pg_temp.save_sql('erace-0001', 'QorperaOS/agents/nora/routines/race-one.md',
	'92300000-0000-4000-8000-0000000000e1', '92300000-0000-4000-8000-0000000000b1'), false) \g /dev/null
do $$
declare r jsonb; v_outcome text;
begin
	perform dblink_exec('rrace_save', 'begin');
	select x into r from dblink('rrace_save', current_setting('qorpera_test.save_one')) as t(x jsonb);
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'R1: the save: %', r; end if;
	perform dblink_send_query('rrace_sched', pg_temp.remove_sql('92300000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_save') then raise exception 'R1: the removal does not wait for the save'; end if;
	if pg_temp.queued_on('rrace_sched') is distinct from 'public.qorpera_event_hooks'::regclass then
		raise exception 'R1: the removal waits at %, not at the hook', pg_temp.queued_on('rrace_sched'); end if;
	perform dblink_exec('rrace_save', 'commit');
	v_outcome := pg_temp.outcome('rrace_sched');
	if v_outcome <> 'ok' then raise exception 'R1: the removal: %', v_outcome; end if;
	if not exists (select 1 from public.qorpera_event_listener_cursors where routine_id = '92300000-0000-4000-8000-0000000000e1')
		or (select status from public.qorpera_event_hooks where id = '92300000-0000-4000-8000-0000000000b1') <> 'removed' then
		raise exception 'R1: the routine saved and the hook removed'; end if;
end $$;

-- R2. The other order: a removal holds the hook; the save waits for it there, then its rules see the hook removed.
select set_config('qorpera_test.save_two', pg_temp.save_sql('erace-0002', 'QorperaOS/agents/nora/routines/race-two.md',
	'92300000-0000-4000-8000-0000000000e2', '92300000-0000-4000-8000-0000000000b2'), false) \g /dev/null
do $$
declare r jsonb;
begin
	perform dblink_exec('rrace_sched', 'begin');
	perform * from dblink('rrace_sched', pg_temp.remove_sql('92300000-0000-4000-8000-0000000000b2')) as t(x text);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.save_two'));
	if not pg_temp.waits_for('rrace_save', 'rrace_sched') then raise exception 'R2: the save does not wait for the removal'; end if;
	if pg_temp.queued_on('rrace_save') is distinct from 'public.qorpera_event_hooks'::regclass then
		raise exception 'R2: the save waits at %, not at the hook', pg_temp.queued_on('rrace_save'); end if;
	perform dblink_exec('rrace_sched', 'commit');
	r := pg_temp.result('rrace_save');
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'refused'
		or r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' not like 'hook % is not a hook or mailbox of this company%' then
		raise exception 'R2: the save after the removal: %', r; end if;
end $$;

-- R3. A drain step holds the hook (FOR SHARE) while it writes a wake; a removal waits for it. The wake it wrote is then
-- refused at the gate, and the next step wakes nothing.
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erace-0003', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/race-three.md',
	pg_temp.rparse('92300000-0000-4000-8000-0000000000e3', 'Events', pg_temp.ev('92300000-0000-4000-8000-0000000000b3'))))), 1, 'saved')
	\g /dev/null
insert into public.qorpera_event_deliveries(hook_id, profile_id, status, delivery_key, event_type, content_type, body, body_bytes,
	body_sha256, verified_at)
values ('92300000-0000-4000-8000-0000000000b3', '70900000-0000-4000-8000-000000000010', 'verified', 'race-1', 'form.posted',
	'application/json', '\x7b7d', 2, repeat('0', 64), clock_timestamp());
do $$
declare r jsonb; v_outcome text; w public.qorpera_wake_occurrences;
begin
	perform dblink_exec('rrace_hold', 'begin');
	select x into r from dblink('rrace_hold',
		$q$select public.qorpera_folder_event_wakes_company('70900000-0000-4000-8000-000000000020')$q$) as t(x jsonb);
	if r ->> 'wakes' is distinct from '1' then raise exception 'R3: the drain step: %', r; end if;
	perform dblink_send_query('rrace_sched', pg_temp.remove_sql('92300000-0000-4000-8000-0000000000b3'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_hold') then raise exception 'R3: the removal does not wait for the drain'; end if;
	if pg_temp.queued_on('rrace_sched') is distinct from 'public.qorpera_event_hooks'::regclass then
		raise exception 'R3: the removal waits at %, not at the hook', pg_temp.queued_on('rrace_sched'); end if;
	perform dblink_exec('rrace_hold', 'commit');
	v_outcome := pg_temp.outcome('rrace_sched');
	if v_outcome <> 'ok' then raise exception 'R3: the removal: %', v_outcome; end if;
	select * into strict w from public.qorpera_wake_occurrences where routine_id = '92300000-0000-4000-8000-0000000000e3'
		and source_kind = 'event';
	if public.qorpera_folder_wake_authorized(w) then raise exception 'R3: the gate takes a removed hook''s wake'; end if;
	if coalesce(public.qorpera_folder_event_wakes_company('70900000-0000-4000-8000-000000000020') ->> 'wakes', '0') <> '0' then
		raise exception 'R3: a removed hook still wakes'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;

-- The committed fixture leaves the shared suite database, as 709's does; the event rows first.
set session_replication_role = replica;
delete from public.qorpera_event_wake_deliveries where routine_id in (select id from public.qorpera_cloud_routines
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_event_listener_cursors where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_event_deliveries where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_connection_file_marks where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_connection_file_work where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_hook_index where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_event_hooks where profile_id = '70900000-0000-4000-8000-000000000010';
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
-- P15's follow-up queue rows (no foreign keys).
delete from public.qorpera_folder_follow_up_marks where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_follow_ups where environment_id = '70900000-0000-4000-8000-000000000020';
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
		or exists (select 1 from public.qorpera_event_hooks where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_event_listener_cursors where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '70900000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
