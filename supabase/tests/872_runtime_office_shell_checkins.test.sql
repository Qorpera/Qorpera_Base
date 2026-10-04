-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930066000: check-ins for the Company Computer's shells under one idle rule for every machine (the 2026-10-03
-- amendment, item 5), on a folder-v2 company's computer (folder-v2 only, the founder's decision of 3 October). Asking: a
-- shell that stays busy since its agent last worked with it has its agent asked after 1, 3 and 7 hours, then every 24,
-- once per mark, in the conversation of the run that worked with it last; a question still stands only while the shell
-- stays busy and nobody worked with it. Delivery: the folder drain's step continues the parent run with a
-- 'machine-checkin' wake once that run ended, one at a time, and suppresses what no longer stands.
-- 648's committed fixture; the company's computer is registered, started and activated as 894 does (870's setup), and
-- Ada's screen opened by the owner. Effect records and reports are synthetic. Everything is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Office shell: %', p_message; end if; end
$$;
create function pg_temp.refused(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % (%), got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
-- Sends a call and waits up to ten seconds for it to end; its text answer, or the error as "<sqlstate> <message>".
create function pg_temp.settled(p_conn text, p_sql text) returns text language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds'; v_answer text;
begin
	perform dblink_send_query(p_conn, p_sql);
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return 'WAITED'; end if;
		perform pg_sleep(0.02);
	end loop;
	begin
		select r into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v_answer, 'null');
end $$;

-- The company's computer, started by its owner and brought up by the provider (894's chain), and Ada's screen opened
-- by the owner.
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_office jsonb; v_scope text; v_generation text; v_answer text; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
		'64800000-0000-4000-8000-000000000020', '87200000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
	v_office := v_answer::jsonb;
	v_scope := (v_office - 'state')::text;
	v_generation := (select generation::text from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid);
	perform set_config('qorpera_test.scope', v_scope, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', v_generation, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '87200000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '87200000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87200000-0000-4000-8000-0000000000d4', '87200000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '87200000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87200000-0000-4000-8000-0000000000d4', '87200000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'87200000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '87200000-0000-4000-8000-0000000000f1', 'bootId', '87200000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '87200000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '87200000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '87200000-0000-4000-8000-0000000000f1'));
	if v_answer !~ '"state": "ready"' then raise exception 'Setup: the computer reports ready: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '87200000-0000-4000-8000-0000000000d4', '87200000-0000-4000-8000-0000000000f1',
		'87200000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_open_runtime_office_screen(%L, %L)::text',
		v_scope, '64800000-0000-4000-8000-0000000000a1'));
	if v_answer !~ '"state": "open"' then raise exception 'Setup: the owner opens Ada''s screen: %', v_answer; end if;
	select * into strict v_screen from public.qorpera_runtime_office_screens
	where office_id = (v_office ->> 'companyComputerId')::uuid and staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
	perform set_config('qorpera_test.screen', v_screen.id::text, false);
end $$;
-- Ada's computer access makes her leased run demand of its own; without it the computer starts with nothing to do.
update public.qorpera_runtime_office_access set state = 'revoked' where office_id = current_setting('qorpera_test.office_id')::uuid;
update public.qorpera_runtime_office_screens set touched_at = clock_timestamp() - interval '3 minutes'
where id = current_setting('qorpera_test.screen')::uuid;

create function pg_temp.office() returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices where id = current_setting('qorpera_test.office_id')::uuid
$$;
create function pg_temp.demand() returns boolean language sql as $$
	select public.qorpera_runtime_office_has_demand(pg_temp.office())
$$;
create function pg_temp.seat() returns boolean language sql as $$
	select public.qorpera_runtime_office_screen_in_use(s) from public.qorpera_runtime_office_screens s
	where s.id = current_setting('qorpera_test.screen')::uuid
$$;
create function pg_temp.idle_poll() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.scope')::jsonb,
		current_setting('qorpera_test.generation')::bigint, '87200000-0000-4000-8000-0000000000b0', repeat('f', 64), 60000)
$$;
-- Ada's leased run in her conversation with the member.
create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.command(p_n integer) returns uuid language sql as $$
	select ('87200000-0000-4000-8000-000000000' || lpad(p_n::text, 3, '0'))::uuid
$$;
create function pg_temp.receipt(p_n integer) returns uuid language sql as $$
	select ('87200000-0000-4000-8000-000000001' || lpad(p_n::text, 3, '0'))::uuid
$$;
create function pg_temp.command_row(p_n integer) returns public.qorpera_runtime_office_shell_commands language sql as $$
	select * from public.qorpera_runtime_office_shell_commands where id = pg_temp.command(p_n)
$$;
create function pg_temp.at(p_ago interval) returns text language sql as $$
	select to_char((clock_timestamp() - p_ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
-- The screen's own record of a run's start (its effect receipt), as admission writes it. The receipt rows themselves
-- are not needed here, so foreign keys are off while it goes in.
create function pg_temp.started(p_n integer, p_run uuid default null) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_resources(office_id, screen_id, receipt_id, run_id, native_binding, screen_lease,
		input_sha256, downstream_idempotency_sha256, state, expires_at, drained_at)
	values ((pg_temp.office()).id, current_setting('qorpera_test.screen')::uuid, pg_temp.receipt(p_n),
		coalesce(p_run, (pg_temp.run()).id), '{}', '{}', repeat('a', 64), repeat('b', 64), 'drained', clock_timestamp(), clock_timestamp());
	set local session_replication_role = origin;
end $$;
-- A command as the office reports it: still open, or ended since the last report.
create function pg_temp.open_item(p_n integer, p_command text, p_started interval, p_worked interval, p_run uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('id', pg_temp.command(p_n), 'runId', coalesce(p_run, (pg_temp.run()).id), 'receiptId', pg_temp.receipt(p_n),
		'command', p_command, 'startedAt', pg_temp.at(p_started), 'workedAt', pg_temp.at(p_worked))
$$;
create function pg_temp.ended_item(p_n integer, p_command text, p_reason text, p_run uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('id', pg_temp.command(p_n), 'runId', coalesce(p_run, (pg_temp.run()).id), 'receiptId', pg_temp.receipt(p_n),
		'command', p_command, 'startedAt', pg_temp.at('20 minutes'), 'reason', p_reason, 'endedAt', pg_temp.at('0 seconds'))
$$;
-- The office's report of Ada's screen.
create function pg_temp.shells(p_busy boolean, p_open jsonb default '[]', p_ended jsonb default '[]') returns jsonb language sql as $$
	select public.qorpera_report_runtime_office_shell_activity(current_setting('qorpera_test.scope')::jsonb,
		current_setting('qorpera_test.generation')::bigint,
		jsonb_build_object('schema', 'qorpera.office-shell-report/v1', 'screens', jsonb_build_array(jsonb_build_object(
			'screenId', current_setting('qorpera_test.screen'), 'busy', p_busy, 'whole', true, 'open', p_open, 'ended', p_ended))))
$$;
create function pg_temp.open_work() returns jsonb language sql as $$
	select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.binding')::jsonb)
$$;
select pg_temp.started(n) from unnest(array[1, 2, 3, 4, 5, 6, 7]) n \g /dev/null

create function pg_temp.ask() returns integer language sql as $$
	select public.qorpera_ask_busy_office_shells('64800000-0000-4000-8000-000000000020', 32)
$$;
create function pg_temp.due(p_after uuid default null, p_limit integer default 100) returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_due(p_after, p_limit)
$$;
create function pg_temp.asked_again() returns boolean language plpgsql as $$
begin
	delete from public.qorpera_machine_checkins;
	return pg_temp.ask() > 0;
end $$;

-- 1. The marks: 1, 3 and 7 hours, then every 24.
select pg_temp.check(public.qorpera_machine_checkin_mark(0.99) is null and public.qorpera_machine_checkin_mark(1) = 1
	and public.qorpera_machine_checkin_mark(2.99) = 1 and public.qorpera_machine_checkin_mark(3) = 3
	and public.qorpera_machine_checkin_mark(6.99) = 3 and public.qorpera_machine_checkin_mark(7) = 7
	and public.qorpera_machine_checkin_mark(30.99) = 7 and public.qorpera_machine_checkin_mark(31) = 31
	and public.qorpera_machine_checkin_mark(54.99) = 31 and public.qorpera_machine_checkin_mark(55) = 55
	and public.qorpera_machine_checkin_mark(null) is null, 'check-in marks: 1, 3, 7, then every 24 hours');

-- 2. Nothing busy, nothing due. Then a crawl Ada last worked with 90 minutes ago keeps the computer busy.
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb and pg_temp.ask() = 0, 'with nothing busy nothing is due or asked');
select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(5, 'python crawl.py', '2 hours', '90 minutes'))) \g /dev/null
select pg_temp.check(pg_temp.due() = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('environment_id',
	'64800000-0000-4000-8000-000000000020')), 'has_more', false, 'next_after_environment_id', null),
	'the company with a busy shell is due: ' || pg_temp.due()::text);
-- The due list's paging and bounds.
select pg_temp.check(pg_temp.due(null, 1) = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('environment_id',
	'64800000-0000-4000-8000-000000000020')), 'has_more', true, 'next_after_environment_id', '64800000-0000-4000-8000-000000000020')
	and pg_temp.due('64800000-0000-4000-8000-000000000020', 1) -> 'items' = '[]'::jsonb, 'the due list pages by environment');
select pg_temp.refused('select pg_temp.due(null, 0)', '22023');
select pg_temp.refused('select pg_temp.due(null, 501)', '22023');
select pg_temp.refused('select public.qorpera_ask_busy_office_shells(''64800000-0000-4000-8000-000000000020'', 257)', '22023');
select pg_temp.check(pg_temp.settled('fence_two', 'select public.qorpera_folder_machine_checkins_due()::text') like '42501 %',
	'a member cannot read the due list');
-- A paused company, or one being deleted, is not due.
begin;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb, 'a paused company is not due');
rollback;
begin;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb, 'a company being deleted is not due');
rollback;
select pg_temp.check(pg_temp.ask() = 1, 'after an hour busy with no turn, the agent is asked');
select pg_temp.check(pg_temp.ask() = 0, 'and only once per mark');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb,
	'asked, and while the run it goes to still runs, the company is not due: the question waits');
select pg_temp.check((select count(*) = 1 and bool_and(q.machine_kind = 'computer' and q.subject_id = current_setting('qorpera_test.screen')::uuid
	and q.parent_run_id = (pg_temp.run()).id and q.staff_agent_id = (pg_temp.run()).staff_agent_id
	and q.environment_id = '64800000-0000-4000-8000-000000000020' and q.mark_hours = 1
	and q.since = (pg_temp.command_row(5)).worked_at and q.delivery = 'waiting'
	and q.body -> 'running' = jsonb_build_array(jsonb_build_object('command', 'python crawl.py', 'startedAt', (pg_temp.command_row(5)).started_at))
	and (q.body ->> 'busyHours')::integer = 1 and (q.body ->> 'more')::integer = 0)
	from public.qorpera_machine_checkins q), 'the question names the screen, the run that worked with it last and what runs');
select pg_temp.check(public.qorpera_machine_checkin_current(q), 'the question stands while the crawl stays busy')
from public.qorpera_machine_checkins q;
-- A snapshot-v1 environment asks nothing.
select pg_temp.check(public.qorpera_ask_busy_office_shells('64800000-0000-4000-8000-000000000021', 32) = 0,
	'a snapshot-v1 environment asks nothing');

-- 3. At three busy hours it is asked again, and the hour-one question no longer stands.
update public.qorpera_runtime_office_shell_commands set worked_at = worked_at - interval '2 hours' where id = pg_temp.command(5);
select pg_temp.check(pg_temp.ask() = 1, 'at three busy hours it is asked again');
select pg_temp.check((select count(*) from public.qorpera_machine_checkins where mark_hours = 3) = 1, 'for the three-hour mark');
select pg_temp.check(not public.qorpera_machine_checkin_current(q), 'a question a later mark replaced no longer stands')
from public.qorpera_machine_checkins q where q.mark_hours = 1;
select pg_temp.check(public.qorpera_machine_checkin_current(q), 'the latest question stands') from public.qorpera_machine_checkins q
where q.mark_hours = 3;

-- 4. What restarts the count, and who is not asked.
begin;
select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(5, 'python crawl.py', '4 hours', '0 seconds'))) \g /dev/null
select pg_temp.check(not public.qorpera_machine_checkin_current(q), 'typing into the crawl leaves the question standing no more')
from public.qorpera_machine_checkins q where q.mark_hours = 3;
select pg_temp.check(not pg_temp.asked_again(), 'typing into the command restarts the count');
rollback;
begin;
select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(5, 'python crawl.py', '4 hours', '4 hours')),
	jsonb_build_array(pg_temp.ended_item(4, 'git status', 'exited'))) \g /dev/null
select pg_temp.check(not pg_temp.asked_again(), 'starting a short command restarts the count');
rollback;
begin;
update public.qorpera_runtime_office_shell_activity set busy_until = clock_timestamp() - interval '1 second';
select pg_temp.check(not pg_temp.asked_again(), 'a shell that only waits is not asked about');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb, 'and with no question waiting, its company is not due');
rollback;
begin;
update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = (pg_temp.run()).staff_agent_id;
select pg_temp.check(not pg_temp.asked_again(), 'an archived agent is not asked');
rollback;
begin;
update public.qorpera_runtime_office_screens set staff_agent_id = '64800000-0000-4000-8000-0000000000c0'
where id = current_setting('qorpera_test.screen')::uuid;
select pg_temp.check(not pg_temp.asked_again(), 'nobody is asked about a shell whose seat changed hands');
-- The new holder's own busy command counts from the new holder's own work, whatever the previous one did there.
update public.qorpera_runtime_office_shell_commands set ended_at = clock_timestamp(), end_reason = 'closed',
	worked_at = clock_timestamp() - interval '10 minutes' where id = pg_temp.command(5);
insert into public.qorpera_runtime_office_shell_commands(id, office_id, computer_generation, screen_id, staff_agent_id, run_id,
	receipt_id, conversation_run_id, session_id, command, started_at, worked_at)
values ('87200000-0000-4000-8000-0000000000c5', (pg_temp.office()).id, (pg_temp.office()).generation,
	current_setting('qorpera_test.screen')::uuid, '64800000-0000-4000-8000-0000000000c0', (pg_temp.run()).id,
	'87200000-0000-4000-8000-0000000000d5', (pg_temp.run()).id, (pg_temp.run()).session_id, 'make all',
	clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours');
select pg_temp.check(pg_temp.asked_again(), 'the new holder is asked about its own busy command');
select pg_temp.check((select staff_agent_id = '64800000-0000-4000-8000-0000000000c0' and mark_hours = 1
	and body #>> '{running,0,command}' = 'make all' from public.qorpera_machine_checkins),
	'counted from the new holder''s own work, about its own command');
rollback;
-- However many long commands run, the question stays within its bound.
begin;
select pg_temp.started(n) from generate_series(11, 18) n \g /dev/null
select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(5, 'python crawl.py', '4 hours', '5 hours'))
	|| (select jsonb_agg(pg_temp.open_item(n, repeat('漢', 300), '5 hours', '5 hours')) from generate_series(11, 18) n)) \g /dev/null
update public.qorpera_runtime_office_shell_commands set worked_at = clock_timestamp() - interval '5 hours'
where screen_id = current_setting('qorpera_test.screen')::uuid;
select pg_temp.check(pg_temp.asked_again(), 'long commands are still asked about');
select pg_temp.check((select octet_length(body::text) <= 4096 and jsonb_array_length(body -> 'running') between 1 and 4
	and (body ->> 'more')::integer >= 5 and char_length(body #>> '{running,0,command}') = 200 and left(body #>> '{running,0,command}', 1) = '漢'
	from public.qorpera_machine_checkins), 'long commands are cut to fit the question, and the rest counted');
rollback;
-- A worker's command is asked about in the conversation that dispatched it: its row's conversation run is the parent,
-- not the worker run that started it.
begin;
update public.qorpera_runtime_office_shell_commands set run_id = '87200000-0000-4000-8000-0000000009a2',
	conversation_run_id = '64800000-0000-4000-8000-0000000000f1'
where id = pg_temp.command(5);
select pg_temp.check(pg_temp.asked_again(), 'a worker''s busy command is asked about');
select pg_temp.check((select parent_run_id = '64800000-0000-4000-8000-0000000000f1' from public.qorpera_machine_checkins),
	'the question goes to the run whose conversation is asked');
rollback;

-- 5. Delivery, by the drain's step (C1c-3i-b's helpers). The company's login may pay for autonomous work: a check-in
--    is paid as the work that started it.
set session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connection_versions set allow_autonomous = true, authorization_state = 'active'
where connection_id = '64800000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
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
create function pg_temp.step() returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_company('64800000-0000-4000-8000-000000000020', 8)
$$;
create function pg_temp.question(p_mark integer) returns public.qorpera_machine_checkins language sql as $$
	select * from public.qorpera_machine_checkins where subject_id = current_setting('qorpera_test.screen')::uuid and mark_hours = p_mark
	order by created_at desc limit 1
$$;
-- The parent's check-in wakes, newest first; forget() removes them, as if each had run and ended.
create function pg_temp.wakes() returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin' order by created_at desc, id desc
$$;
create function pg_temp.forget() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin';
	set local session_replication_role = origin;
end $$;

-- The crawl is still busy (a fresh report; an older workedAt never moves the count).
create function pg_temp.still_busy() returns void language sql as $$
	select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(5, 'python crawl.py', '100 hours', '99 hours')))
$$;
select pg_temp.still_busy();
-- While Ada's run still runs, its questions wait: the company is not due and its step is idle.
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb and pg_temp.step() ->> 'state' = 'idle'
	and (pg_temp.question(1)).delivery = 'waiting' and (pg_temp.question(3)).delivery = 'waiting',
	'a running parent''s questions wait');
-- Once its job ended: due, and one wake carries the question that still stands into its conversation; the one a later
-- mark replaced is suppressed.
select pg_temp.job('completed') \g /dev/null
do $$
declare v_answer jsonb; v_wake public.qorpera_wake_occurrences;
begin
	if pg_temp.due() -> 'items' = '[]'::jsonb then raise exception 'Delivery: an ended parent''s company is due'; end if;
	v_answer := pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_answer ->> 'state' <> 'done' or (v_answer ->> 'delivered')::integer <> 1 or (v_answer ->> 'suppressed')::integer <> 1
		or (v_answer ->> 'asked')::integer <> 0
		or v_wake.status <> 'queued' or v_wake.wake_kind <> 'agent' or v_wake.trigger_id <> 'machine-checkin'
		or v_wake.source_id <> (pg_temp.question(3)).id or v_wake.session_id <> (pg_temp.run()).session_id
		or v_wake.staff_agent_id <> (pg_temp.run()).staff_agent_id or v_wake.requested_by_user_id <> (pg_temp.run()).requested_by_user_id
		or v_wake.payload ->> 'schema' <> 'qorpera.machine-checkin/v1' or jsonb_array_length(v_wake.payload -> 'checkins') <> 1
		or v_wake.payload #>> '{checkins,0,checkinId}' <> (pg_temp.question(3)).id::text
		or (v_wake.payload #>> '{checkins,0,busyHours}')::integer <> 3
		or v_wake.payload #>> '{checkins,0,machineKind}' <> 'computer'
		or v_wake.payload #>> '{checkins,0,running,0,command}' <> 'python crawl.py'
		or (v_wake.payload ->> 'stillWaiting')::integer <> 0 or not public.qorpera_folder_wake_authorized(v_wake) then
		raise exception 'Delivery: one authorized wake with the standing question: % %', v_answer, to_jsonb(v_wake); end if;
	if (pg_temp.question(3)).delivery <> 'delivered' or (pg_temp.question(3)).occurrence_id <> v_wake.id
		or (pg_temp.question(1)).delivery <> 'suppressed' then
		raise exception 'Delivery: delivered by that wake, the replaced one suppressed'; end if;
	-- One continuation at a time: while it is queued, the parent is not asked through another.
	if pg_temp.step() ->> 'state' <> 'idle' then raise exception 'Delivery: one continuation per parent at a time'; end if;
end $$;
-- The run that continues reads its continuation: the question it carries, and what the parent run did.
begin;
do $$
declare v_wake public.qorpera_wake_occurrences; v_run public.qorpera_execution_runs := pg_temp.run(); v_continuation jsonb;
begin
	select * into v_wake from pg_temp.wakes() limit 1;
	set local session_replication_role = replica;
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(v_run, jsonb_build_object('id', '87200000-0000-4000-8000-0000000009c1', 'job_id', extensions.gen_random_uuid(),
		'source_id', v_wake.id))).*;
	update public.qorpera_wake_occurrences set run_id = '87200000-0000-4000-8000-0000000009c1' where id = v_wake.id;
	set local session_replication_role = origin;
	v_continuation := public.qorpera_run_continuation((select r from public.qorpera_execution_runs r
		where r.id = '87200000-0000-4000-8000-0000000009c1'));
	perform pg_temp.check(v_continuation ->> 'schema' = 'qorpera.machine-checkin-continuation/v1'
		and v_continuation ->> 'parentRunId' = v_run.id::text and jsonb_array_length(v_continuation -> 'checkins') = 1
		and (v_continuation #>> '{checkins,0,busyHours}')::integer = 3 and v_continuation ? 'receipts'
		and v_continuation -> 'parentWake' ->> 'kind' is not null,
		'the continuation carries the question and the parent''s history: ' || left(v_continuation::text, 300));
end $$;
rollback;
-- At seven busy hours it is asked again: the step asks, and the question waits for the next step, here behind the
-- queued continuation; once that ran, it is delivered.
select pg_temp.still_busy();
update public.qorpera_runtime_office_shell_commands set worked_at = worked_at - interval '4 hours' where id = pg_temp.command(5);
do $$
declare v_answer jsonb := pg_temp.step();
begin
	if (v_answer ->> 'asked')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0 or (pg_temp.question(7)).delivery <> 'waiting' then
		raise exception 'Delivery: the step asks, and the new question waits: %', v_answer; end if;
	perform pg_temp.forget();
	v_answer := pg_temp.step();
	if (v_answer ->> 'delivered')::integer <> 1 or (pg_temp.question(7)).delivery <> 'delivered'
		or (select (payload #>> '{checkins,0,busyHours}')::integer from pg_temp.wakes() limit 1) <> 7 then
		raise exception 'Delivery: the seven-hour question once the last continuation ran: %', v_answer; end if;
	perform pg_temp.forget();
end $$;
-- A question no longer standing when its parent is ready is suppressed: the shell stopped being busy. (The count is
-- moved to 31 hours, a new mark.)
select pg_temp.still_busy();
update public.qorpera_runtime_office_shell_commands set worked_at = clock_timestamp() - interval '31 hours' where id = pg_temp.command(5);
do $$
declare v_answer jsonb;
begin
	v_answer := pg_temp.step();
	if (v_answer ->> 'asked')::integer <> 1 then raise exception 'Delivery: the 31-hour mark is asked: %', v_answer; end if;
	update public.qorpera_runtime_office_shell_activity set busy_until = clock_timestamp() - interval '1 second'
	where screen_id = current_setting('qorpera_test.screen')::uuid;
	v_answer := pg_temp.step();
	if (v_answer ->> 'suppressed')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0 or (pg_temp.question(31)).delivery <> 'suppressed'
		or exists (select 1 from pg_temp.wakes()) then
		raise exception 'Delivery: a question for a shell no longer busy is suppressed: %', v_answer; end if;
end $$;
-- A cancelled parent's questions are suppressed; a gone parent's undeliverable; nothing is admitted for either.
select pg_temp.still_busy();
update public.qorpera_runtime_office_shell_commands set worked_at = clock_timestamp() - interval '55 hours' where id = pg_temp.command(5);
select pg_temp.job('cancelled') \g /dev/null
do $$
declare v_answer jsonb;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind, subject_id, since,
		mark_hours, body)
	values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', (pg_temp.run()).staff_agent_id,
		extensions.gen_random_uuid(), 'machine', extensions.gen_random_uuid(), clock_timestamp() - interval '1 hour', 1, '{}');
	set local session_replication_role = origin;
	v_answer := pg_temp.step();
	-- The 55-hour question is asked now and waits a step; then it is suppressed with its cancelled parent.
	if (v_answer ->> 'undeliverable')::integer <> 1 then raise exception 'Delivery: a gone parent''s question: %', v_answer; end if;
	v_answer := pg_temp.step();
	if (v_answer ->> 'suppressed')::integer <> 1 or (pg_temp.question(55)).delivery <> 'suppressed' or exists (select 1 from pg_temp.wakes()) then
		raise exception 'Delivery: a cancelled parent''s question is suppressed: %', v_answer; end if;
	perform pg_temp.job('completed');
end $$;
-- A paused company is left alone: its step answers paused, and its questions wait.
begin;
select pg_temp.still_busy();
update public.qorpera_runtime_office_shell_commands set worked_at = clock_timestamp() - interval '79 hours' where id = pg_temp.command(5);
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.step() ->> 'state' = 'paused' and pg_temp.due() -> 'items' = '[]'::jsonb
	and pg_temp.question(79) is null, 'a paused company is left alone: nothing is asked');
rollback;
select pg_temp.check(pg_temp.settled('fence_two', format('select public.qorpera_folder_machine_checkins_company(%L, 8)::text',
	'64800000-0000-4000-8000-000000000020')) like '42501 %', 'a member cannot run the step');

-- 6. Only the platform: no API role reaches the table or the functions; the service role reads only the due list.
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	where has_table_privilege(r.role, 'public.qorpera_machine_checkins', 'select')
		or has_table_privilege(r.role, 'public.qorpera_machine_checkins', 'insert'))
	and not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_machine_checkin_mark(double precision)',
		'public.qorpera_ask_busy_office_shells(uuid,integer)',
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)',
		'public.qorpera_office_shell_checkins_unasked(uuid)',
		'public.qorpera_machine_checkin_ancestry(public.qorpera_wake_occurrences)',
		'public.qorpera_machine_checkin_payload(uuid,uuid[])',
		'public.qorpera_machine_checkin_continuation(public.qorpera_execution_runs,integer)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute'))
	and has_function_privilege('service_role', 'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'execute')
	and has_function_privilege('service_role', 'public.qorpera_folder_machine_checkins_company(uuid,integer)', 'execute')
	and not exists (select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'execute')
			or has_function_privilege(r.role, 'public.qorpera_folder_machine_checkins_company(uuid,integer)', 'execute')),
	'only the platform reads, writes and runs these');
-- Each patched function names this migration.
select pg_temp.check(not exists (select 1 from unnest(array['public.qorpera_pin_wake_occurrence()',
	'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)', 'public.qorpera_folder_materialize_company(uuid,integer)',
	'public.qorpera_folder_read_wake(jsonb)', 'public.qorpera_runtime_wake_policy_internal(uuid)',
	'public.qorpera_run_continuation(public.qorpera_execution_runs)']) f(name)
	where position('20260930066000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each patched function names this migration');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 894 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_offices uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	select array_agg(id) into v_offices from public.qorpera_runtime_offices where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('office_id','profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' and c.table_name <> 'qorpera_runtime_offices'
		order by c.column_name = 'office_id' desc loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'office_id' then v_offices when 'profile_id' then v_profiles
			when 'environment_id' then v_envs when 'run_id' then v_runs when 'job_id' then v_jobs
			when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_runtime_offices where id = any (v_offices);
	delete from public.qorpera_logical_computers where profile_id = any (v_profiles);
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
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_office_shell_commands where office_id = current_setting('qorpera_test.office_id')::uuid)
		or exists (select 1 from public.qorpera_machine_checkins where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
