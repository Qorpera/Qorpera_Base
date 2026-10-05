-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3i part b (migration 20260930058000): a company machine's events reach the folder-v2 run that
-- started the work, through the shared folder drains. The three folder-v2 refusals no longer name the source kind; a
-- continuation needs admission. The step waits while the parent runs, delivers up to 8 events in one wake once it ended,
-- in at most 6 KiB, one continuation per parent at a time; a cancelled parent's events are suppressed, a gone parent's
-- undeliverable; a paused company is left alone. Beside a folder effect it never waits; behind a stop's second phase it
-- waits at the fence holding nothing; events another step holds are skipped; a lock timeout answers busy. 648's committed
-- fixture (Ada's run f1, its job f2 and conversation f7) with a machine of that run, removed at the end.

-- This connection calls the drain as the service role; 648 set the other connections' role.
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null

-- Committed rows: a task machine Ada's run started, and the company's login allowed to pay for autonomous work (a
-- continuation is paid as the work that started it: here the company account).
set session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connection_versions set allow_autonomous = true, authorization_state = 'active'
where connection_id = '64800000-0000-4000-8000-0000000000b3';
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('84800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-848',
	'Run the suite', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 2, 4294967296, 21474836480, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp());
set session_replication_role = origin;

-- p_n waiting events of a parent (Ada's run by default), each its own millisecond, oldest first; with p_long, each a
-- command's end whose head and output fill their bounds.
create function pg_temp.events(p_n integer, p_parent uuid default '64800000-0000-4000-8000-0000000000f1', p_long boolean default false)
returns uuid[] language plpgsql as $$
declare v_ids uuid[] := '{}'; v_id uuid; v_command uuid;
begin
	set local session_replication_role = replica;
	for i in 1 .. p_n loop
		v_id := extensions.gen_random_uuid(); v_command := null;
		if p_long then
			v_command := extensions.gen_random_uuid();
			insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, requested_by_user_id, placement_id,
				command_head, notify, ended_at, state, exit_code, output_tail)
			values (v_command, '84800000-0000-4000-8000-0000000000a1', p_parent, '64800000-0000-4000-8000-0000000000a1',
				'64800000-0000-4000-8000-000000000002', extensions.gen_random_uuid(), repeat('c', 300), true, clock_timestamp(), 'succeeded', 0,
				repeat('o', 4000));
		end if;
		insert into public.qorpera_company_machine_events(id, machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind,
			command_id, created_at)
		values (v_id, '84800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-0000000000a1', p_parent, case when p_long then 'command' else 'running' end, v_command,
			clock_timestamp() + make_interval(secs => i / 1000.0));
		v_ids := v_ids || v_id;
	end loop;
	set local session_replication_role = origin;
	return v_ids;
end $$;
-- Ada's job ends (completed) or is cancelled, with the columns each state requires.
create function pg_temp.job(p_status text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = p_status, lease_token_sha256 = null, lease_expires_at = null,
		result = case when p_status = 'completed' then '{}'::jsonb end,
		finished_at = case when p_status = 'completed' then clock_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then clock_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '64800000-0000-4000-8000-000000000001'::uuid end
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
end $$;
create function pg_temp.step(p_limit integer default 8) returns jsonb language sql as $$
	select public.qorpera_folder_machine_events_company('64800000-0000-4000-8000-000000000020', p_limit)
$$;
create function pg_temp.due() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_folder_machine_events_due(null, 100) -> 'items') item(value)
		where item.value ->> 'environment_id' = '64800000-0000-4000-8000-000000000020')
$$;
create function pg_temp.delivery(p_ids uuid[]) returns text language sql as $$
	select string_agg(delivery, ',' order by created_at, id) from public.qorpera_company_machine_events where id = any(p_ids)
$$;
-- The parent's machine-event wakes, newest first; forget() removes them, as if each had run and ended.
create function pg_temp.wakes() returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-event' order by created_at desc, id desc
$$;
create function pg_temp.forget() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1' and source_kind = 'machine-event';
	set local session_replication_role = origin;
end $$;
create function pg_temp.admitted() returns bigint language sql as $$
	select admitted from public.qorpera_folder_admissions where profile_id = '64800000-0000-4000-8000-000000000010'
$$;
-- fence_one holds what a folder effect holds (the fence and the company row KEY SHARE), what a stop's second phase holds
-- (the fence FOR UPDATE), or the waiting events FOR UPDATE (another step); until pg_temp.release().
create function pg_temp.hold(p_what text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what = 'events' then
		perform * from dblink('fence_one', $q$select 1 from public.qorpera_company_machine_events where delivery = 'waiting'
			and environment_id = '64800000-0000-4000-8000-000000000020' for update$q$) as t(x integer);
		return;
	end if;
	perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s',
		'64800000-0000-4000-8000-000000000010', case p_what when 'effect' then 'key share' else 'update' end)) as t(x integer);
	if p_what = 'effect' then
		perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
			for key share$q$) as t(x integer);
	end if;
end $$;
create function pg_temp.release() returns void language sql as $$ select dblink_exec('fence_one', 'rollback') $$;
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
create function pg_temp.sql_step() returns text language sql as $$
	select $q$select public.qorpera_folder_machine_events_company('64800000-0000-4000-8000-000000000020', 8)::text$q$
$$;
-- A step sent on fence_two: its answer, once it finished.
create function pg_temp.answer() returns jsonb language plpgsql as $$
declare v_answer text;
begin
	select r into v_answer from dblink_get_result('fence_two') as t(r text);
	perform * from dblink_get_result('fence_two') as t(r text);
	return v_answer::jsonb;
end $$;

-- A. The source kind on folder-v2: no refusal names it, a continuation needs admission, and the wake check follows its
-- chain.
do $$
declare v_pin text := pg_get_functiondef('public.qorpera_pin_wake_occurrence()'::regprocedure);
	v_resolve text := pg_get_functiondef('public.qorpera_folder_run_resolve(uuid,uuid,jsonb)'::regprocedure);
	v_authorized text := pg_get_functiondef('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure);
	v_events uuid[];
begin
	if v_pin ~ $re$if new\.source_kind in \([^)]*'machine-event'[^)]*\) then\n\t*raise exception 'This wake source does not serve folder-v2 yet'$re$
		or v_resolve ~ $re$if v_wake\.source_kind in \([^)]*'machine-event'[^)]*\) then\n\t*raise exception 'Folder writes by this kind of run are not available yet'$re$
		or v_authorized ~ $re$or p_wake\.source_kind in \([^)]*'machine-event'[^)]*\) then return false;$re$
		or position('elsif p_wake.source_kind = ''machine-event'' then v_ancestry := public.qorpera_machine_wake_ancestry(p_wake);' in v_authorized) = 0
		or position('p_wake.source_kind in (''worker-completion'', ''machine-event'')' in v_authorized) = 0 then
		raise exception 'A: a folder-v2 refusal still names machine events'; end if;
	v_events := pg_temp.events(1);
	perform set_config('qorpera.folder_wake_admission', '', true);
	begin
		perform public.qorpera_folder_insert_continuation((select r from public.qorpera_execution_runs r
			where r.id = '64800000-0000-4000-8000-0000000000f1'), 'machine-event', v_events[1], '{}');
		raise exception 'A: a continuation without admission' using errcode = 'QTF01';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- Removed again: the drain's cases start from no event.
	set local session_replication_role = replica;
	delete from public.qorpera_company_machine_events where id = any(v_events);
	set local session_replication_role = origin;
end $$;

-- B. The drain. While Ada's run runs (its job leased), its events wait: the company is not due and its step is idle.
select set_config('qorpera_test.b', array_to_string(pg_temp.events(10), ','), false) \g /dev/null
do $$
begin
	if pg_temp.due() or pg_temp.step() ->> 'state' <> 'idle'
		or pg_temp.delivery(string_to_array(current_setting('qorpera_test.b'), ',')::uuid[]) <> 'waiting,waiting,waiting,waiting,waiting,waiting,waiting,waiting,waiting,waiting' then
		raise exception 'B: a running parent''s events must wait'; end if;
end $$;
-- Once its job ended: due, and one wake carries the oldest 8 events into its conversation, under one admission.
select pg_temp.job('completed') \g /dev/null
do $$
declare v_ids uuid[] := string_to_array(current_setting('qorpera_test.b'), ',')::uuid[]; v_admitted bigint := pg_temp.admitted();
	v_answer jsonb; v_wake public.qorpera_wake_occurrences;
begin
	if not pg_temp.due() then raise exception 'B: an ended parent''s company is due'; end if;
	v_answer := pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_answer ->> 'state' <> 'done' or (v_answer ->> 'delivered')::integer <> 1 or pg_temp.admitted() <> v_admitted + 1
		or v_wake.status <> 'queued' or v_wake.wake_kind <> 'agent' or v_wake.trigger_id <> 'machine-event'
		or v_wake.source_id <> v_ids[1] or v_wake.session_id <> '64800000-0000-4000-8000-0000000000f7'
		or v_wake.staff_agent_id <> '64800000-0000-4000-8000-0000000000a1'
		or v_wake.requested_by_user_id <> '64800000-0000-4000-8000-000000000002'
		or v_wake.causal_root_id <> '64800000-0000-4000-8000-0000000000f3'
		or v_wake.causal_agent_ids <> array['64800000-0000-4000-8000-0000000000a1'::uuid]
		or v_wake.payload ->> 'schema' <> 'qorpera.machine-event/v1' or jsonb_array_length(v_wake.payload -> 'events') <> 8
		or (v_wake.payload ->> 'stillWaiting')::integer <> 2 or not public.qorpera_folder_wake_authorized(v_wake) then
		raise exception 'B: one authorized wake with the oldest 8 events: % %', v_answer, to_jsonb(v_wake); end if;
	if pg_temp.delivery(v_ids) <> 'delivered,delivered,delivered,delivered,delivered,delivered,delivered,delivered,waiting,waiting'
		or exists (select 1 from public.qorpera_company_machine_events where id = any(v_ids[1:8]) and occurrence_id <> v_wake.id) then
		raise exception 'B: the 8 events are delivered by that wake, 2 wait: %', pg_temp.delivery(v_ids); end if;
	-- One continuation at a time: while it is queued, the parent asks nothing more.
	if pg_temp.due() or pg_temp.step() ->> 'state' <> 'idle' then raise exception 'B: one continuation per parent at a time'; end if;
	-- Once it ran: the 2 left, in a second wake.
	perform pg_temp.forget();
	v_answer := pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	if (v_answer ->> 'delivered')::integer <> 1 or jsonb_array_length(v_wake.payload -> 'events') <> 2
		or (v_wake.payload ->> 'stillWaiting')::integer <> 0 or pg_temp.delivery(v_ids[9:10]) <> 'delivered,delivered' then
		raise exception 'B: the rest in the next wake: % %', v_answer, v_wake.payload; end if;
	perform pg_temp.forget();
end $$;
-- A wake holds at most 6 KiB: 8 long command ends go as many as fit, the rest next time.
do $$
declare v_ids uuid[] := pg_temp.events(8, p_long => true); v_wake public.qorpera_wake_occurrences; v_first integer;
begin
	perform pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	v_first := jsonb_array_length(v_wake.payload -> 'events');
	if v_first >= 8 or v_first < 1 or pg_column_size(v_wake.payload) > 6144
		or (select count(*) from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'waiting') <> 8 - v_first then
		raise exception 'B: a long batch is cut to 6 KiB: % events, % bytes', v_first, pg_column_size(v_wake.payload); end if;
	while exists (select 1 from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'waiting') loop
		perform pg_temp.forget();
		if (pg_temp.step() ->> 'delivered')::integer <> 1 then raise exception 'B: the rest of a long batch'; end if;
	end loop;
	perform pg_temp.forget();
end $$;
-- A cancelled parent's events are suppressed; a gone parent's undeliverable; nothing is admitted for either. (The rows go
-- in by their own statements: an update of a row inserted earlier in its transaction checks its foreign keys again.)
select pg_temp.job('cancelled') \g /dev/null
select set_config('qorpera_test.cancelled', array_to_string(pg_temp.events(3), ','), false) \g /dev/null
select set_config('qorpera_test.gone', array_to_string(pg_temp.events(2, extensions.gen_random_uuid()), ','), false) \g /dev/null
do $$
declare v_admitted bigint := pg_temp.admitted(); v_answer jsonb;
	v_cancelled uuid[] := string_to_array(current_setting('qorpera_test.cancelled'), ',')::uuid[];
	v_gone uuid[] := string_to_array(current_setting('qorpera_test.gone'), ',')::uuid[];
begin
	v_answer := pg_temp.step();
	if (v_answer ->> 'suppressed')::integer <> 3 or (v_answer ->> 'undeliverable')::integer <> 2 or (v_answer ->> 'delivered')::integer <> 0
		or pg_temp.delivery(v_cancelled) <> 'suppressed,suppressed,suppressed' or pg_temp.delivery(v_gone) <> 'undeliverable,undeliverable'
		or pg_temp.admitted() <> v_admitted or exists (select 1 from pg_temp.wakes()) then
		raise exception 'B: cancelled and gone parents: %', v_answer; end if;
	perform pg_temp.job('completed');
end $$;
-- A paused company is left alone: not due, its step answers paused, the events wait.
select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'test 848') \g /dev/null
do $$
declare v_ids uuid[] := pg_temp.events(1);
begin
	if pg_temp.due() or pg_temp.step() ->> 'state' <> 'paused' or pg_temp.delivery(v_ids) <> 'waiting' then
		raise exception 'B: a paused company is left alone'; end if;
	perform set_config('qorpera_test.paused', v_ids[1]::text, false);
end $$;
select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010') \g /dev/null
do $$
begin
	if (pg_temp.step() ->> 'delivered')::integer <> 1 or pg_temp.delivery(array[current_setting('qorpera_test.paused')::uuid]) <> 'delivered' then
		raise exception 'B: after the resume the event is delivered'; end if;
	perform pg_temp.forget();
end $$;

-- C. Locks. Beside a folder effect (the fence and the company row KEY SHARE) the step never waits.
select pg_temp.events(1) \g /dev/null
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'C: the step waited for a folder effect'; end if;
	v_answer := pg_temp.answer();
	perform pg_temp.release();
	if (v_answer ->> 'delivered')::integer <> 1 then raise exception 'C: the step beside an effect: %', v_answer; end if;
	perform pg_temp.forget();
end $$;
-- Behind a stop's second phase (the fence FOR UPDATE) it waits at the fence holding no event and no company row; once the
-- stop lets go, it delivers.
select pg_temp.events(1) \g /dev/null
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'C: the step must wait at the fence behind a stop'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_company_machine_events where delivery = 'waiting'
			and environment_id = '64800000-0000-4000-8000-000000000020'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '64800000-0000-4000-8000-000000000002'$q$) then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'C: waiting at the fence, the step holds an event or a member row'; end if;
	perform pg_temp.release();
	v_answer := pg_temp.answer();
	if (v_answer ->> 'delivered')::integer <> 1 then raise exception 'C: the step after the stop let go: %', v_answer; end if;
	perform pg_temp.forget();
end $$;
-- Events another step holds are its own: skipped, without waiting.
select pg_temp.events(1) \g /dev/null
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('events');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'C: the step waited for events another step holds'; end if;
	v_answer := pg_temp.answer();
	perform pg_temp.release();
	if v_answer ->> 'state' <> 'done' or (v_answer ->> 'delivered')::integer <> 0 then
		raise exception 'C: held events are skipped: %', v_answer; end if;
end $$;
-- Two steps of one company that hold different events of one parent (16 waiting: each locks 8) and meet at admission
-- continue it once: the second checks the parent again under admission and leaves its events waiting. (The event the
-- held-events case left is set aside first.)
select pg_temp.forget() \g /dev/null
update public.qorpera_company_machine_events set delivery = 'suppressed'
where profile_id = '64800000-0000-4000-8000-000000000010' and delivery = 'waiting' \g /dev/null
select set_config('qorpera_test.race', array_to_string(pg_temp.events(16), ','), false) \g /dev/null
create function pg_temp.blocked(p_conn text) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
do $$
declare v_ids uuid[] := string_to_array(current_setting('qorpera_test.race'), ',')::uuid[]; v_two text; v_three text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_admissions
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	if not pg_temp.blocked('fence_two') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'C: the first step must wait at admission'; end if;
	perform dblink_send_query('fence_three', pg_temp.sql_step());
	if not pg_temp.blocked('fence_three') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform pg_temp.outcome('fence_three');
		raise exception 'C: the second step must wait at admission'; end if;
	-- Each holds its own 8 events while it waits.
	if (select count(*) from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'waiting') <> 16
		or pg_temp.row_free($q$select 1 from public.qorpera_company_machine_events where delivery = 'waiting'
			and environment_id = '64800000-0000-4000-8000-000000000020' order by created_at, id limit 1$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_company_machine_events where delivery = 'waiting'
			and environment_id = '64800000-0000-4000-8000-000000000020' order by created_at desc, id desc limit 1$q$) then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform pg_temp.outcome('fence_three');
		raise exception 'C: the two steps hold the two batches'; end if;
	perform pg_temp.release();
	v_two := pg_temp.outcome('fence_two'); v_three := pg_temp.outcome('fence_three');
	if v_two <> 'ok' or v_three <> 'ok' then raise exception 'C: the steps ended with % and %', v_two, v_three; end if;
	if (select count(*) from pg_temp.wakes()) <> 1
		or (select count(*) from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'delivered') <> 8
		or (select count(*) from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'waiting') <> 8 then
		raise exception 'C: one continuation for two steps: % wakes, %', (select count(*) from pg_temp.wakes()), pg_temp.delivery(v_ids); end if;
	-- Once it ran, the other 8 follow. (The step in a statement of its own: a subquery in the same statement would read
	-- the events as they were before it.)
	perform pg_temp.forget();
	v_two := pg_temp.step()::text;
	if (v_two::jsonb ->> 'delivered')::integer is distinct from 1
		or (select count(*) from public.qorpera_company_machine_events where id = any(v_ids) and delivery = 'delivered') <> 16 then
		raise exception 'C: the rest after the continuation ran: % %', v_two, pg_temp.delivery(v_ids); end if;
	perform pg_temp.forget();
	-- The next case's event (committed with this block).
	perform pg_temp.events(1);
end $$;
-- A stop that holds the fence past the step's lock timeout (2 s): the step answers busy and changes nothing.
do $$
declare v_answer jsonb;
begin
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_step());
	perform pg_sleep(2.5);
	v_answer := pg_temp.answer();
	perform pg_temp.release();
	if v_answer ->> 'state' <> 'busy' or exists (select 1 from pg_temp.wakes()) then
		raise exception 'C: a lock timeout answers busy: %', v_answer; end if;
	if (pg_temp.step() ->> 'delivered')::integer <> 1 then raise exception 'C: the next step delivers'; end if;
	perform pg_temp.forget();
end $$;

-- D. The two functions: the service role's alone, their bounds, and the page's shape.
do $$
declare v_page jsonb;
begin
	perform pg_temp.events(1);
	v_page := public.qorpera_folder_machine_events_due(null, 1);
	if jsonb_array_length(v_page -> 'items') <> 1 or v_page ->> 'has_more' <> 'true'
		or v_page ->> 'next_after_environment_id' <> '64800000-0000-4000-8000-000000000020'
		or jsonb_array_length(public.qorpera_folder_machine_events_due('64800000-0000-4000-8000-000000000020', 100) -> 'items') <> 0 then
		raise exception 'D: the page: %', v_page; end if;
	begin perform public.qorpera_folder_machine_events_due(null, 501); raise exception 'D' using errcode = 'QTF01';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.step(65); raise exception 'D' using errcode = 'QTF01';
	exception when invalid_parameter_value then null; end;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin perform public.qorpera_folder_machine_events_due(null, 1); raise exception 'D' using errcode = 'QTF01';
	exception when insufficient_privilege then null; end;
	begin perform pg_temp.step(); raise exception 'D' using errcode = 'QTF01';
	exception when insufficient_privilege then null; end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if has_function_privilege('authenticated', 'public.qorpera_folder_machine_events_due(uuid,integer)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_machine_events_company(uuid,integer)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_machine_events_company(uuid,integer)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_parent_continuation(uuid,text)', 'execute')
		or has_function_privilege('service_role',
			'public.qorpera_folder_insert_continuation(public.qorpera_execution_runs,text,uuid,jsonb)', 'execute') then
		raise exception 'D: the grants'; end if;
end $$;

-- E. Every patched or new body carries the marker.
do $$
begin
	if exists (select 1 from unnest(array['public.qorpera_pin_wake_occurrence()', 'public.qorpera_folder_run_resolve(uuid,uuid,jsonb)',
			'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)', 'public.qorpera_folder_parent_continuation(uuid,text)',
			'public.qorpera_folder_insert_continuation(public.qorpera_execution_runs,text,uuid,jsonb)',
			'public.qorpera_folder_machine_events_due(uuid,integer)', 'public.qorpera_folder_machine_events_company(uuid,integer)']) f
		where position('20260930058000' in pg_get_functiondef(f::regprocedure)) = 0) then
		raise exception 'E: a body lacks its marker'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows as 849 removes them, with the machine, its commands and events.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	delete from public.qorpera_company_machine_commands where machine_id = '84800000-0000-4000-8000-0000000000a1';
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
		or exists (select 1 from public.qorpera_company_machines where id = '84800000-0000-4000-8000-0000000000a1')
		or exists (select 1 from public.qorpera_company_machine_events where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
