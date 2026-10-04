-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930029000: the Company Computer's long-running shells under one idle rule for every machine (the 2026-10-03
-- amendment), on a folder-v2 company's computer (folder-v2 only, the founder's decision of 3 October).
-- 1. The office's operation check takes exactly the computer_shell shapes the tool sends.
-- 2. A waiting dev server keeps nothing awake; a busy job keeps the computer awake and its agent's seat for 90 seconds
--    after its last busy report. A command counts only when its start is the screen's own recorded effect for that run;
--    anything else is left out, never refused.
-- 3. Sleep ends what still runs (slept), and the agent's next run in that conversation is told once. Other stops end
--    commands as closed (a screen gone, a seat that changed hands, any stop of the computer), paused, lost or unknown.
-- 4. A worker's command is told in the conversation that dispatched the worker.
-- 5. Two runs racing for the told list: one winner, and the other neither waits nor sees it.
-- 648's committed fixture; the company's computer is registered, started and activated as 894 does, and Ada's screen
-- opened by the owner. Effect records and reports are synthetic. Not a Linux test. Everything is removed at the end.

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

-- 1. The shapes the tool sends are exactly the valid ones. The lists between the markers are shared with
--    cloud-company-computer-tools.test.ts: the tool sends each valid one exactly as written, and never an invalid one.
create function pg_temp.shell_ok(p_arguments text) returns boolean language sql as $$
	select public.qorpera_valid_office_shell_action(p_arguments::jsonb)
$$;
select pg_temp.check(coalesce(pg_temp.shell_ok(shape),false),'valid shell arguments: '||shape) from unnest(array[
-- BEGIN VALID COMPUTER_SHELL SHAPES
	'{"kind":"shell","action":"start","command":"npm run build","waitMs":10000}',
	'{"kind":"shell","action":"start","command":"sleep 3600","waitMs":0}',
	'{"kind":"shell","action":"start","command":"x","waitMs":15000}',
	'{"kind":"shell","action":"start","command":"  printf \"a\\tb\\n\" | tr a c\n","waitMs":10000}',
	'{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000a1","waitMs":5000}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"y\n","endInput":false,"waitMs":1000}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":" ","endInput":false,"waitMs":1000}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"","endInput":true,"waitMs":1000}',
	'{"kind":"shell","action":"stop"}',
	'{"kind":"shell","action":"stop","sessionId":"00000000-0000-4000-8000-0000000000a1"}',
	'{"kind":"shell","action":"list"}',
	'{"kind":"shell","command":"ls","timeoutMs":15000}',
	'{"kind":"shell","command":"ls","timeoutMs":1}'
-- END VALID COMPUTER_SHELL SHAPES
]) as shape \g /dev/null
select pg_temp.check(not coalesce(pg_temp.shell_ok(shape),true),'invalid shell arguments: '||shape) from unnest(array[
-- BEGIN INVALID COMPUTER_SHELL SHAPES
	'{"kind":"shell","action":"start","command":"ls"}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":15001}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":1.5}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":"100"}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":-1}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":null}',
	'{"kind":"shell","action":"start","command":"   ","waitMs":0}',
	'{"kind":"shell","action":"start","command":"\n\t ","waitMs":0}',
	'{"kind":"shell","action":"start","command":null,"waitMs":0}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":0,"timeoutMs":1000}',
	'{"kind":"shell","action":"read","sessionId":"not-a-command","waitMs":0}',
	'{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000A1","waitMs":0}',
	'{"kind":"shell","action":"read","sessionId":null,"waitMs":0}',
	'{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000a1"}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"","endInput":false,"waitMs":0}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"y","endInput":"true","waitMs":0}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":null,"endInput":true,"waitMs":0}',
	'{"kind":"shell","action":"stop","sessionId":"00000000-0000-4000-8000-0000000000a1","waitMs":0}',
	'{"kind":"shell","action":"list","waitMs":0}',
	'{"kind":"shell","action":"kill"}',
	'{"kind":"shell","timeoutMs":1000}',
	'{"kind":"shell","command":"ls","timeoutMs":"1000"}',
	'{"kind":"shell","command":"ls","timeoutMs":0}',
	'{"kind":"shell","command":"ls","timeoutMs":16000}',
	'{"kind":"shell","command":"ls","timeoutMs":1000,"waitMs":0}',
	'{"kind":"browser","action":"list"}'
-- END INVALID COMPUTER_SHELL SHAPES
]) as shape \g /dev/null
select pg_temp.check(not coalesce(pg_temp.shell_ok(jsonb_build_object('kind','shell','action','start','command',repeat('x',16385),'waitMs',0)::text),true)
	and not coalesce(pg_temp.shell_ok(jsonb_build_object('kind','shell','action','write','sessionId','00000000-0000-4000-8000-0000000000a1',
		'text',repeat('x',16385),'endInput',false,'waitMs',0)::text),true)
	and coalesce(pg_temp.shell_ok(jsonb_build_object('kind','shell','action','start','command',repeat('é',8192),'waitMs',0)::text),false),
	'a command or input over 16 KiB is invalid, one of exactly 16 KiB is not');
select pg_temp.check(pg_get_functiondef('public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure)
	like '%if not coalesce(public.qorpera_valid_office_shell_action(v_operation->''arguments''),false) then%',
	'the office''s operation check takes the shell action through that validator');

-- The company's computer, started by its owner and brought up by the provider (894's chain), and Ada's screen opened
-- by the owner.
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_office jsonb; v_scope text; v_generation text; v_answer text; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
		'64800000-0000-4000-8000-000000000020', '87000000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
	v_office := v_answer::jsonb;
	v_scope := (v_office - 'state')::text;
	v_generation := (select generation::text from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid);
	perform set_config('qorpera_test.scope', v_scope, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', v_generation, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '87000000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '87000000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87000000-0000-4000-8000-0000000000d4', '87000000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '87000000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87000000-0000-4000-8000-0000000000d4', '87000000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'87000000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '87000000-0000-4000-8000-0000000000f1', 'bootId', '87000000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '87000000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '87000000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '87000000-0000-4000-8000-0000000000f1'));
	if v_answer !~ '"state": "ready"' then raise exception 'Setup: the computer reports ready: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '87000000-0000-4000-8000-0000000000d4', '87000000-0000-4000-8000-0000000000f1',
		'87000000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
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
		current_setting('qorpera_test.generation')::bigint, '87000000-0000-4000-8000-0000000000b0', repeat('f', 64), 60000)
$$;
-- Ada's leased run in her conversation with the member.
create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.command(p_n integer) returns uuid language sql as $$
	select ('87000000-0000-4000-8000-000000000' || lpad(p_n::text, 3, '0'))::uuid
$$;
create function pg_temp.receipt(p_n integer) returns uuid language sql as $$
	select ('87000000-0000-4000-8000-000000001' || lpad(p_n::text, 3, '0'))::uuid
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
			'screenId', current_setting('qorpera_test.screen'), 'busy', p_busy, 'open', p_open, 'ended', p_ended))))
$$;
create function pg_temp.open_work() returns jsonb language sql as $$
	select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.binding')::jsonb)
$$;
select pg_temp.started(n) from unnest(array[1, 2, 3, 4, 5, 6, 7]) n \g /dev/null

select pg_temp.check(not pg_temp.demand(), 'an active folder-v2 computer with nothing to do has no demand');
select pg_temp.check(not pg_temp.seat(), 'an idle screen is free');
select pg_temp.check(pg_temp.idle_poll() -> 'request' = 'null', 'the idle policy starts counting');

-- 2. A waiting dev server: on record with the run that started it, and no demand. Only the office's service role
--    reports, and only screens of that office.
select pg_temp.check(pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes')),
	jsonb_build_array(pg_temp.ended_item(3, 'npm test', 'exited'))) -> 'screens' = '[]'::jsonb, 'a waiting dev server is reported, not busy');
select pg_temp.check(not pg_temp.demand() and not pg_temp.seat(), 'a waiting dev server is no demand and holds no seat');
select pg_temp.check((select c.staff_agent_id = (pg_temp.run()).staff_agent_id and c.run_id = (pg_temp.run()).id
	and c.receipt_id = pg_temp.receipt(1) and c.conversation_run_id = (pg_temp.run()).id and c.session_id = (pg_temp.run()).session_id
	and c.command = 'npm run dev' and c.ended_at is null and c.computer_generation = (pg_temp.office()).generation and c.told_at is null
	from pg_temp.command_row(1) c), 'the command is on record with the run that started it and its conversation');
select pg_temp.check((select c.end_reason = 'exited' and c.ended_at is not null from pg_temp.command_row(3) c),
	'a command that exited is on record as exited');
-- A command the screen has no record of starting is left out; the report goes on.
select pg_temp.shells(false, jsonb_build_array(
	pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'),
	pg_temp.open_item(10, 'not started here', '1 minute', '1 minute'),
	pg_temp.open_item(4, 'another run''s receipt', '1 minute', '1 minute', '64800000-0000-4000-8000-0000000000e3'),
	pg_temp.open_item(4, 'not a receipt', '1 minute', '1 minute') || '{"receiptId":"key-4"}')) \g /dev/null
select pg_temp.check(not exists (select 1 from public.qorpera_runtime_office_shell_commands
	where id in (pg_temp.command(4), pg_temp.command(10))) and (pg_temp.command_row(1)).ended_at is null,
	'commands the screen has no record of starting are left out, and the report still counts');
-- A shape the office never sends is refused, and so is any other office's screen, generation or caller.
select pg_temp.refused(format('select pg_temp.shells(false, %L::jsonb)', jsonb_build_array(pg_temp.open_item(4, repeat('x', 301), '1 minute', '1 minute'))),
	'22023', 'Invalid office shell activity');
select pg_temp.refused(format('select pg_temp.shells(false, %L::jsonb)', jsonb_build_array(pg_temp.open_item(4, 'ls', '1 minute', '1 minute') || '{"busy":true}')),
	'22023', 'Invalid office shell activity');
select pg_temp.refused(format('select pg_temp.shells(false, %L::jsonb)', jsonb_build_array(pg_temp.open_item(4, 'ls', '1 minute', '1 minute') || '{"receiptId":4}')),
	'22023', 'Invalid office shell activity');
select pg_temp.refused(format('select pg_temp.shells(false, ''[]'', %L::jsonb)', jsonb_build_array(pg_temp.ended_item(4, 'ls', 'slept'))),
	'22023', 'Invalid office shell activity');
select pg_temp.refused(format('select public.qorpera_report_runtime_office_shell_activity(%L::jsonb, %s, %L::jsonb)',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation')::bigint + 1,
	'{"schema":"qorpera.office-shell-report/v1","screens":[]}'), '42501', 'Office shell activity binding differs');
select pg_temp.refused(format('select public.qorpera_report_runtime_office_shell_activity(%L::jsonb, %s, %L::jsonb)',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'),
	'{"schema":"qorpera.office-shell-report/v1","screens":[{"screenId":"87000000-0000-4000-8000-000000000099","busy":true,"open":[],"ended":[]}]}'),
	'42501', 'Office shell activity screen differs');
select pg_temp.check(pg_temp.settled('fence_two', format('select public.qorpera_report_runtime_office_shell_activity(%L::jsonb, %s, %L::jsonb)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '{"schema":"qorpera.office-shell-report/v1","screens":[]}'))
	like '42501 %', 'a member cannot report');

-- A busy job keeps the computer awake and Ada's seat, for 90 seconds after its last busy report.
select pg_temp.check(pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'),
	pg_temp.open_item(2, 'npm run build', '5 minutes', '5 minutes'))) -> 'screens' = jsonb_build_array(current_setting('qorpera_test.screen')),
	'a busy job is reported busy');
select pg_temp.check(pg_temp.demand() and pg_temp.seat(), 'a busy job keeps the computer awake and the seat');
select pg_temp.check((select busy_until between clock_timestamp() + interval '80 seconds' and clock_timestamp() + interval '100 seconds'
	from public.qorpera_runtime_office_shell_activity where screen_id = current_setting('qorpera_test.screen')::uuid),
	'a busy report counts for 90 seconds');
select pg_temp.check(pg_temp.idle_poll() -> 'request' = 'null', 'the idle policy does not put a busy computer to sleep');
-- The job finishes; the dev server only waits. One quiet report does not cut the busy report's 90 seconds short.
select pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes')),
	jsonb_build_array(pg_temp.ended_item(2, 'npm run build', 'exited'))) \g /dev/null
select pg_temp.check(pg_temp.demand(), 'a quiet report keeps the last busy report''s 90 seconds');
update public.qorpera_runtime_office_shell_activity set busy_until = clock_timestamp() - interval '1 second'
where screen_id = current_setting('qorpera_test.screen')::uuid;
select pg_temp.check(not pg_temp.demand() and not pg_temp.seat(), 'once those pass, the waiting dev server keeps nothing awake');
select pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'))) \g /dev/null
select pg_temp.check(not exists (select 1 from public.qorpera_runtime_office_shell_activity
	where office_id = current_setting('qorpera_test.office_id')::uuid), 'a passed busy report is removed');
-- A report from an older generation is no demand.
begin;
select pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'))) \g /dev/null
update public.qorpera_runtime_office_shell_activity set computer_generation = computer_generation - 1
where screen_id = current_setting('qorpera_test.screen')::uuid;
select pg_temp.check(not pg_temp.demand() and not pg_temp.seat(), 'a report from an older generation is no demand and holds no seat');
rollback;

-- 3. The computer sleeps: sleep ends the dev server, and Ada's next run in that conversation is told once.
begin;
update public.qorpera_runtime_office_idle_policies set idle_since = clock_timestamp() - interval '2 hours'
where office_id = current_setting('qorpera_test.office_id')::uuid;
select pg_temp.check(pg_temp.idle_poll() #>> '{request,action}' = 'power_off', 'a computer with only a waiting dev server goes to sleep');
select pg_temp.check((select c.end_reason = 'slept' and c.ended_at is not null and c.told_at is null from pg_temp.command_row(1) c)
	and (pg_temp.command_row(2)).end_reason = 'exited' and (pg_temp.command_row(3)).end_reason = 'exited',
	'sleep ends the dev server as slept; what had already ended keeps its own end');
do $$
declare v_work jsonb := pg_temp.open_work();
begin
	perform pg_temp.check(jsonb_array_length(v_work -> 'computerStopped') = 1
		and v_work #>> '{computerStopped,0,command}' = 'npm run dev' and v_work #>> '{computerStopped,0,reason}' = 'slept'
		and (v_work #>> '{computerStopped,0,startedAt}')::timestamptz = (pg_temp.command_row(1)).started_at
		and (v_work #>> '{computerStopped,0,endedAt}')::timestamptz = (pg_temp.command_row(1)).ended_at
		and v_work -> 'todos' is not null and v_work -> 'workers' is not null and v_work ->> 'schema' = 'qorpera.agent-open-work/v1',
		'the next run is told what sleep stopped, and only that: ' || v_work::text);
	perform pg_temp.check((pg_temp.command_row(1)).told_run_id = (pg_temp.run()).id and (pg_temp.command_row(1)).told_at is not null
		and (pg_temp.command_row(2)).told_at is null and (pg_temp.command_row(3)).told_at is null,
		'the command is marked told by that run; what ended by itself is never told');
	perform pg_temp.check(jsonb_array_length(pg_temp.open_work() -> 'computerStopped') = 1, 'a restart of the same run is told again');
	update public.qorpera_runtime_office_shell_commands set told_run_id = extensions.gen_random_uuid() where id = pg_temp.command(1);
	perform pg_temp.check(not pg_temp.open_work() ? 'computerStopped', 'a command told in another run is not told again');
	-- At most 32 a run, oldest first.
	insert into public.qorpera_runtime_office_shell_commands(id, office_id, computer_generation, screen_id, staff_agent_id, run_id,
		receipt_id, conversation_run_id, session_id, command, started_at, worked_at, ended_at, end_reason)
	select extensions.gen_random_uuid(), (pg_temp.office()).id, (pg_temp.office()).generation, current_setting('qorpera_test.screen')::uuid,
		(pg_temp.run()).staff_agent_id, (pg_temp.run()).id, extensions.gen_random_uuid(), (pg_temp.run()).id, (pg_temp.run()).session_id,
		'job ' || n, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour', clock_timestamp() + n * interval '1 second',
		'closed'
	from generate_series(1, 40) n;
	v_work := pg_temp.open_work();
	perform pg_temp.check(jsonb_array_length(v_work -> 'computerStopped') = 32 and v_work #>> '{computerStopped,0,command}' = 'job 1'
		and v_work #>> '{computerStopped,31,command}' = 'job 32', 'at most 32 a run, oldest first');
end $$;
rollback;

-- Other stops: a screen gone, a seat that changes hands, a pause, an earlier generation, an end the office let go of,
-- and any other stop of the computer.
begin;
select public.qorpera_report_runtime_office_shell_activity(current_setting('qorpera_test.scope')::jsonb,
	current_setting('qorpera_test.generation')::bigint, '{"schema":"qorpera.office-shell-report/v1","screens":[]}') \g /dev/null
select pg_temp.check((pg_temp.command_row(1)).end_reason = 'closed', 'a shell whose screen is gone ends as closed');
rollback;
-- The seat changes hands while Ada's shell holds a waiting server and a crawl: the office closes that shell and reports
-- its ends under the same screen, now the Co-Founder's. Nothing is refused, and the report goes on counting.
begin;
select pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'),
	pg_temp.open_item(7, 'python crawl.py', '10 minutes', '10 minutes'))) \g /dev/null
update public.qorpera_runtime_office_screens set staff_agent_id = '64800000-0000-4000-8000-0000000000c0'
where id = current_setting('qorpera_test.screen')::uuid;
select pg_temp.check(pg_temp.shells(true, '[]', jsonb_build_array(pg_temp.ended_item(1, 'npm run dev', 'closed'))) -> 'screens'
	= jsonb_build_array(current_setting('qorpera_test.screen')), 'a report naming the previous agent''s ends is taken');
select pg_temp.check((pg_temp.command_row(1)).end_reason = 'closed' and (pg_temp.command_row(7)).end_reason = 'closed'
	and (pg_temp.command_row(1)).staff_agent_id = '64800000-0000-4000-8000-0000000000a1',
	'the previous agent''s commands ended with the seat, and stay hers to be told');
rollback;
-- A pause ends what still runs, and what the paused report names for the first time, as paused.
begin;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
select pg_temp.check((pg_temp.shells(true, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'),
	pg_temp.open_item(6, 'just started', '5 seconds', '5 seconds'))) ->> 'paused')::boolean, 'a paused company is told so');
select pg_temp.check((pg_temp.command_row(1)).end_reason = 'paused' and (pg_temp.command_row(6)).end_reason = 'paused'
	and not exists (select 1 from public.qorpera_runtime_office_shell_activity where office_id = current_setting('qorpera_test.office_id')::uuid),
	'a pause ends what still runs as paused and keeps no busy report');
rollback;
begin;
update public.qorpera_runtime_office_shell_commands set computer_generation = computer_generation - 1 where id = pg_temp.command(1);
select pg_temp.shells(false) \g /dev/null
select pg_temp.check((pg_temp.command_row(1)).end_reason = 'lost', 'a command of an earlier generation nobody ended is lost');
rollback;
-- An end the office let go of: the screen's whole lists no longer name the command. It ends as unknown, never told.
begin;
select pg_temp.shells(false) \g /dev/null
select pg_temp.check((pg_temp.command_row(1)).end_reason = 'unknown' and not pg_temp.open_work() ? 'computerStopped',
	'a command the office no longer lists ends as unknown, and nobody is told it stopped');
rollback;
-- A list cut at 64 says nothing about what it leaves out.
begin;
select pg_temp.shells(false, (select jsonb_agg(pg_temp.open_item(100 + n, 'not started here', '1 minute', '1 minute'))
	from generate_series(1, 64) n)) \g /dev/null
select pg_temp.check((pg_temp.command_row(1)).ended_at is null, 'a full list ends nothing it leaves out');
rollback;
select pg_temp.check(pg_get_functiondef('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure)
	like '%update public.qorpera_runtime_office_shell_commands set ended_at=clock_timestamp(),end_reason=''closed''%'
	and pg_get_functiondef('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure)
	like '%end_reason=''slept''%perform public.qorpera_begin_runtime_office_lifecycle(v_request);%',
	'sleep ends commands as slept before the stop; any other stop of the computer ends them as closed');

-- 4. A worker's command is told in the conversation that dispatched the worker. The worker run is synthetic: a copy of
--    Ada's run outside any conversation, with a dispatch wake naming a worker whose steering run is Ada's run.
begin;
do $$
declare v_run public.qorpera_execution_runs := pg_temp.run(); v_worker uuid := '87000000-0000-4000-8000-0000000009a1';
	v_worker_run uuid := '87000000-0000-4000-8000-0000000009a2';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(v_run, jsonb_build_object('id', v_worker_run, 'session_id', null, 'job_id', extensions.gen_random_uuid(),
		'source_id', extensions.gen_random_uuid()))).*;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access, revival,
		dispatch, requested_by_user_id, steering_run_id)
	values (v_worker, v_run.profile_id, v_run.environment_id, v_run.staff_agent_id, extensions.gen_random_uuid(), 'shell-worker', 'Crawl',
		'write', 'each', '{}', v_run.requested_by_user_id, v_run.id);
	insert into public.qorpera_wake_occurrences
	select (jsonb_populate_record(wake, jsonb_build_object('id', extensions.gen_random_uuid(), 'run_id', v_worker_run, 'wake_kind', 'agent',
		'source_kind', 'worker-dispatch', 'source_id', v_worker, 'occurrence_key', 'worker-dispatch:' || v_worker))).*
	from public.qorpera_wake_occurrences wake where wake.run_id = v_run.id;
	set local session_replication_role = origin;
	perform pg_temp.started(9, v_worker_run);
	perform pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes'),
		pg_temp.open_item(9, 'npm run crawl', '1 minute', '1 minute', v_worker_run)));
	perform pg_temp.check((select c.run_id = v_worker_run and c.conversation_run_id = v_run.id and c.session_id = v_run.session_id
		from pg_temp.command_row(9) c), 'a worker''s command belongs to the conversation that dispatched it');
	perform pg_temp.shells(false, jsonb_build_array(pg_temp.open_item(1, 'npm run dev', '10 minutes', '10 minutes')),
		jsonb_build_array(pg_temp.ended_item(9, 'npm run crawl', 'pressure', v_worker_run)));
end $$;
select pg_temp.check(pg_temp.open_work() #>> '{computerStopped,0,command}' = 'npm run crawl',
	'the dispatching conversation is told what stopped the worker''s command');
rollback;

-- Only the platform: no API role reaches the tables or the functions.
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	cross join unnest(array['public.qorpera_runtime_office_shell_activity','public.qorpera_runtime_office_shell_commands']) t(name)
	where has_table_privilege(r.role, t.name, 'select') or has_table_privilege(r.role, t.name, 'update'))
	and not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	cross join unnest(array['public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs)',
		'public.qorpera_valid_office_shell_action(jsonb)','public.qorpera_valid_office_shell_command(jsonb,boolean)',
		'public.qorpera_office_shell_conversation_run(public.qorpera_execution_runs)',
		'public.qorpera_office_shell_command_run(public.qorpera_runtime_offices,public.qorpera_runtime_office_screens,jsonb)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute'))
	and not has_function_privilege('anon', 'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)', 'execute'),
	'only the platform reads, writes and runs these');

-- 5. Two runs of Ada in the conversation race to read what stopped: one wins, the other is told nothing and does not
--    wait. The stopped commands are committed so the connections see them.
insert into public.qorpera_runtime_office_shell_commands(id, office_id, computer_generation, screen_id, staff_agent_id, run_id,
	receipt_id, conversation_run_id, session_id, command, started_at, worked_at, ended_at, end_reason)
select ('87000000-0000-4000-8000-00000000080' || n)::uuid, (pg_temp.office()).id, (pg_temp.office()).generation,
	current_setting('qorpera_test.screen')::uuid, (pg_temp.run()).staff_agent_id, (pg_temp.run()).id,
	('87000000-0000-4000-8000-00000000081' || n)::uuid, (pg_temp.run()).id, (pg_temp.run()).session_id, 'race ' || n,
	clock_timestamp(), clock_timestamp(), clock_timestamp() + n * interval '1 minute', 'slept'
from generate_series(1, 3) n;
create function pg_temp.take(p_run uuid) returns text language sql as $$
	select format('select public.qorpera_take_agent_computer_stopped(jsonb_populate_record(null::public.qorpera_execution_runs, %L::jsonb))::text',
		jsonb_build_object('id', p_run, 'staff_agent_id', '64800000-0000-4000-8000-0000000000a1',
			'session_id', (pg_temp.run()).session_id))
$$;
do $$
declare v_first text; v_second text; v_started timestamptz;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v_first from dblink('fence_one', pg_temp.take('87000000-0000-4000-8000-0000000008b1')) as t(r text);
	v_started := clock_timestamp();
	v_second := pg_temp.settled('fence_four', pg_temp.take('87000000-0000-4000-8000-0000000008b2'));
	perform pg_temp.check(jsonb_array_length(v_first::jsonb) = 3 and v_second = 'null' and clock_timestamp() - v_started < interval '2 seconds',
		'while one run takes what stopped, another is told nothing and does not wait: ' || v_second);
	perform dblink_exec('fence_one', 'commit');
	v_second := pg_temp.settled('fence_four', pg_temp.take('87000000-0000-4000-8000-0000000008b2'));
	select r into v_first from dblink('fence_one', pg_temp.take('87000000-0000-4000-8000-0000000008b1')) as t(r text);
	perform pg_temp.check(v_second = 'null' and jsonb_array_length(v_first::jsonb) = 3
		and (select count(*) from public.qorpera_runtime_office_shell_commands
			where command like 'race %' and told_run_id = '87000000-0000-4000-8000-0000000008b1') = 3,
		'once told, only the winning run (restarted) is told again');
end $$;

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
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
