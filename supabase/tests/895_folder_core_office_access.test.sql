-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3k part 2 (20260930019100): the Company Computer's access, screens and viewers in rank order
-- on a folder-v2 company. Changing an agent's access takes the agent, the seat lock and every computer by id before any
-- access row; access status is plain reads; an agent's return takes the seat lock before the computers, and a new
-- computer or a first registration shares the agents before it; opening a screen, a private heartbeat, the viewers and
-- the browser grant take their members before the computer. Each "waits there holding no computer" case holds the
-- earlier lock in another session. Folder-v2 only (the founder's decision of 3 October). 648's committed fixture;
-- everything is removed at the end.

-- A session holds a row and waits; the fences' helpers, as 850's.
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', p_sql) as t(x integer);
end $$;
create function pg_temp.release() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'commit');
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
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
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
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
-- The company row held FOR NO KEY UPDATE: a KEY SHARE goes through, FOR SHARE, NO KEY UPDATE and FOR UPDATE wait.
create function pg_temp.company_hold(p_company text) returns text language sql as $$
	select format('select 1 from public.qorpera_profiles where id = %L for no key update', '64800000-0000-4000-8000-0000000000' || p_company)
$$;
create function pg_temp.member_hold(p_user text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_members where profile_id = %L and user_id = %L for no key update',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_user)
$$;
create function pg_temp.office_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_offices where id = %L for update',
		current_setting('qorpera_test.office_id')))
$$;

create function pg_temp.staff_hold(p_mode text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_staff where profile_id = %L and staff_agent_id = %L for %s',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000a1', p_mode)
$$;
create function pg_temp.office_row_free(p_office text) returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_offices where id = %L for update', p_office))
$$;
create function pg_temp.no_advisory(p_conn text) returns boolean language sql as $$
	select not exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and locktype = 'advisory' and granted)
$$;
create function pg_temp.access_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_office_access where staff_agent_id = %L for update',
		'64800000-0000-4000-8000-0000000000a1'))
$$;
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');

-- Z. A first registration shares the company's agents (KEY SHARE) before the seat lock: with Ada's row held FOR UPDATE,
--    it waits at the staff row holding no seat lock, then registers the computer.
select pg_temp.hold(pg_temp.staff_hold('update'));
select dblink_send_query('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
	'64800000-0000-4000-8000-000000000020', '89500000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_staff') or not pg_temp.no_advisory('fence_two') then
		perform pg_temp.release(); raise exception 'Z: registration must wait at the agents before the seat lock'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_two'); v_office public.qorpera_runtime_offices%rowtype;
begin
	if v_outcome <> 'ok' then raise exception 'Z: the registration lands: %', v_outcome; end if;
	select * into strict v_office from public.qorpera_runtime_offices where environment_id = '64800000-0000-4000-8000-000000000020';
	perform set_config('qorpera_test.office_id', v_office.id::text, false);
	perform set_config('qorpera_test.scope', public.qorpera_runtime_office_scope(v_office)::text, false);
	perform set_config('qorpera_test.generation', v_office.generation::text, false);
end $$;

-- The company's computer brought up (893's chain, uncontended), and a second computer added beside it: Ada has access on
-- both. The two are named by id order, low and high.
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_answer text; v_second public.qorpera_runtime_offices%rowtype;
begin
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '89500000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '89500000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89500000-0000-4000-8000-0000000000d4', '89500000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89500000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89500000-0000-4000-8000-0000000000d4', '89500000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'89500000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '89500000-0000-4000-8000-0000000000f1', 'bootId', '89500000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '89500000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '89500000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89500000-0000-4000-8000-0000000000f1'));
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '89500000-0000-4000-8000-0000000000d4', '89500000-0000-4000-8000-0000000000f1',
		'89500000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = current_setting('qorpera_test.office_id')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
	v_second := public.qorpera_add_runtime_office_computer('64800000-0000-4000-8000-000000000020', 'member',
		'64800000-0000-4000-8000-0000000000a1', null, '64800000-0000-4000-8000-000000000001');
	perform set_config('qorpera_test.low', least(v_second.id, current_setting('qorpera_test.office_id')::uuid)::text, false);
	perform set_config('qorpera_test.high', greatest(v_second.id, current_setting('qorpera_test.office_id')::uuid)::text, false);
	perform set_config('qorpera_test.high_scope', public.qorpera_runtime_office_scope((select office from public.qorpera_runtime_offices
		as office where office.id = current_setting('qorpera_test.high')::uuid))::text, false);
	if (select count(*) from public.qorpera_runtime_office_access where staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
		and state = 'active') <> 2 then raise exception 'Setup: Ada has access on both computers'; end if;
end $$;

-- A. Two changes of one agent's access on two computers never deadlock: the setter takes every live computer by id
--    before any access row. With the low computer held (another change of Ada's access there, or a hire's walk), a
--    capability change on the high computer waits at the low one holding neither the high computer nor any access row.
select pg_temp.hold(format('select 1 from public.qorpera_runtime_offices where id = %L for no key update', current_setting('qorpera_test.low')));
select dblink_send_query('fence_two', format('select public.qorpera_configure_runtime_office_access(%L, %L, %s, true, %L)::text',
	current_setting('qorpera_test.high_scope'), '64800000-0000-4000-8000-0000000000a1',
	(select version from public.qorpera_runtime_office_access where office_id = current_setting('qorpera_test.high')::uuid
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1'), '["desktop","shell"]'));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runtime_offices') or not pg_temp.office_row_free(current_setting('qorpera_test.high'))
		or not pg_temp.access_free() then
		perform pg_temp.release(); raise exception 'A: the access change must wait at the low computer before the high one and any access row'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_two');
begin
	if v_outcome <> 'ok' then raise exception 'A: the access change lands: %', v_outcome; end if;
	if (select capabilities from public.qorpera_runtime_office_access where office_id = current_setting('qorpera_test.high')::uuid
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1') <> '["desktop","shell"]' then
		raise exception 'A: the capabilities changed'; end if;
end $$;

-- B. The agent before the computers: with Ada's row held (a return or a hire in flight), a change of her access waits at
--    her row holding no computer.
select pg_temp.hold(pg_temp.staff_hold('no key update'));
select dblink_send_query('fence_two', format('select public.qorpera_set_runtime_office_access(%L, %L, %s, true)::text',
	current_setting('qorpera_test.low'), '64800000-0000-4000-8000-0000000000a1',
	(select version from public.qorpera_runtime_office_access where office_id = current_setting('qorpera_test.low')::uuid
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1')));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_staff') or not pg_temp.office_row_free(current_setting('qorpera_test.low'))
		or not pg_temp.office_row_free(current_setting('qorpera_test.high')) then
		perform pg_temp.release(); raise exception 'B: the access change must wait at the agent before any computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_two');
begin
	if v_outcome <> 'ok' then raise exception 'B: the access change lands: %', v_outcome; end if;
end $$;

-- C. The seat lock before the computers: with the company's seat lock held (a computer being added), a change of Ada's
--    access waits for it holding no computer.
select pg_temp.hold(format('select 1 from (select public.qorpera_lock_runtime_office_seats(%L)) as seats', '64800000-0000-4000-8000-000000000020'));
select dblink_send_query('fence_two', format('select public.qorpera_set_runtime_office_access(%L, %L, %s, true)::text',
	current_setting('qorpera_test.low'), '64800000-0000-4000-8000-0000000000a1',
	(select version from public.qorpera_runtime_office_access where office_id = current_setting('qorpera_test.low')::uuid
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1')));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.office_row_free(current_setting('qorpera_test.low'))
		or not pg_temp.office_row_free(current_setting('qorpera_test.high')) then
		perform pg_temp.release(); raise exception 'C: the access change must wait at the seat lock before any computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_two');
begin
	if v_outcome <> 'ok' then raise exception 'C: the access change lands: %', v_outcome; end if;
end $$;

-- D. Access status is plain reads: with the company row held, it answers at once.
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_two', format('select public.qorpera_runtime_office_access_status(%L, %L)::text',
	current_setting('qorpera_test.scope'), '64800000-0000-4000-8000-0000000000a1'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_two'); end if;
	if v_answer !~ '"state": "active"' then raise exception 'D: access status answers without a lock: %', v_answer; end if;
end $$;

-- E. An agent's return takes the company's seat lock before the computers: with the seat lock held (a computer being
--    added), Ada's return (her row's employment written again) waits for it holding no computer, so the added computer
--    is either seen by her walk or sees her active.
select pg_temp.hold(format('select 1 from (select public.qorpera_lock_runtime_office_seats(%L)) as seats', '64800000-0000-4000-8000-000000000020'));
select dblink_send_query('fence_three', format('update public.qorpera_profile_staff set employment_status = employment_status
	where profile_id = %L and staff_agent_id = %L', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000a1'));
do $$
begin
	if not pg_temp.waits_for('fence_three', 'fence_one') or not pg_temp.office_row_free(current_setting('qorpera_test.low'))
		or not pg_temp.office_row_free(current_setting('qorpera_test.high')) then
		perform pg_temp.release(); raise exception 'E: an agent''s return must wait at the seat lock before the computers'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_three');
begin
	if v_outcome <> 'ok' then raise exception 'E: the return lands: %', v_outcome; end if;
end $$;

-- F. A new computer for an agent shares the company's agents before the seat lock: with scale-out on, both computers
--    with no seat for Ada (the high one is not started; the low one goes to maintenance) and Ada's row held FOR UPDATE,
--    the owner's ask waits at the agents holding no seat lock.
select set_config('qorpera_test.scale_out', (select enabled::text from public.qorpera_runtime_office_scale_out where singleton), false);
update public.qorpera_runtime_office_scale_out set enabled = true where singleton;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
update public.qorpera_runtime_offices set state = 'retired' where environment_id = '64800000-0000-4000-8000-000000000020'
	and id <> current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
select pg_temp.hold(pg_temp.staff_hold('update'));
select dblink_send_query('fence_two', format('select public.qorpera_member_agent_office(%L, %L)::text',
	'64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-0000000000a1'));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_staff') or not pg_temp.no_advisory('fence_two') then
		perform pg_temp.release(); raise exception 'F: a new computer must wait at the agents before the seat lock'; end if;
end $$;
select pg_temp.release();
select pg_temp.outcome('fence_two');
update public.qorpera_runtime_office_scale_out set enabled = current_setting('qorpera_test.scale_out')::boolean where singleton;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'active' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;

-- G. Opening a screen takes the member's row before the seat lock and the computer: with the owner's row held (a role
--    change or a removal in flight), the open waits there holding no seat lock and no computer.
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_two', format('select public.qorpera_open_runtime_office_screen(%L, %L)::text',
	current_setting('qorpera_test.scope'), '64800000-0000-4000-8000-0000000000a1'));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') or not pg_temp.no_advisory('fence_two')
		or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'G: opening a screen must wait at the member before the seat lock and the computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_answer text; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	v_answer := pg_temp.outcome('fence_two');
	if v_answer <> 'ok' then raise exception 'G: the screen opens: %', v_answer; end if;
	select * into strict v_screen from public.qorpera_runtime_office_screens
	where office_id = current_setting('qorpera_test.office_id')::uuid and staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
	perform set_config('qorpera_test.binding', (current_setting('qorpera_test.scope')::jsonb || jsonb_build_object(
		'computerGeneration', current_setting('qorpera_test.generation')::bigint, 'screenId', v_screen.id,
		'screenOrdinal', v_screen.ordinal, 'screenGeneration', v_screen.generation, 'staffAgentId', v_screen.staff_agent_id))::text, false);
	perform set_config('qorpera_test.epoch', v_screen.epoch::text, false);
end $$;

-- H. A private heartbeat takes the privacy owner (with the start's members) before the computer: with the owner's row
--    held, it waits there holding no computer, and then goes on (its made-up challenge is refused; never 40P01).
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format('select public.qorpera_record_runtime_screen_event(%L, %L, %L, %L)::text',
	current_setting('qorpera_test.startup'), current_setting('qorpera_test.binding'),
	jsonb_build_object('memberId', '64800000-0000-4000-8000-000000000001', 'screenId', current_setting('qorpera_test.binding')::jsonb -> 'screenId'),
	jsonb_build_object('lifetimeId', '89500000-0000-4000-8000-0000000000c1', 'eventId', '89500000-0000-4000-8000-0000000000e1', 'sequence', 1,
		'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'state', 'requested',
		'reason', 'SCREEN_REQUESTED')));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'H: a private heartbeat must wait at the privacy owner before the computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_three');
begin
	if v_outcome like '40P01%' then raise exception 'H: the private heartbeat deadlocked: %', v_outcome; end if;
end $$;

-- I. The viewers and the screen's browser grant take the viewer's member row before the computer. With the owner's row
--    held, each of creating a viewer, redeeming it, checking it and the screen's browser grant waits there holding no
--    computer, then lands.
do $$
declare v_call record; v_outcome text; v_token text; v_grant jsonb;
begin
	-- A shared viewer of Ada's screen, issued and redeemed uncontended (its grant is what the input check sends).
	v_outcome := pg_temp.settled('fence_two', format('select public.qorpera_create_runtime_office_viewer(%L, %s, %L, null)::text',
		current_setting('qorpera_test.binding'), current_setting('qorpera_test.epoch'), 'shared'));
	if v_outcome !~ '"state": "issued"' then raise exception 'I: the owner issues a viewer: %', v_outcome; end if;
	v_token := v_outcome::jsonb ->> 'capability';
	v_outcome := pg_temp.settled('fence_three', format('select public.qorpera_redeem_runtime_office_viewer(%L, %L)::text',
		current_setting('qorpera_test.scope'), encode(extensions.digest(v_token, 'sha256'), 'hex')));
	v_grant := v_outcome::jsonb;
	for v_call in select * from (values
		('create', 'fence_two', format('select public.qorpera_create_runtime_office_viewer(%L, %s, %L, null)::text',
			current_setting('qorpera_test.binding'), current_setting('qorpera_test.epoch'), 'watch')),
		('check', 'fence_three', format('select public.qorpera_check_runtime_office_viewer(%L)::text', v_grant)),
		('browser grant', 'fence_three', format('select public.qorpera_office_screen_browser_grant(%L, null)::text',
			current_setting('qorpera_test.binding')))) as c(name, conn, sql)
	loop
		perform pg_temp.hold(pg_temp.member_hold('01'));
		perform dblink_send_query(v_call.conn, v_call.sql);
		if not pg_temp.waits_at(v_call.conn, 'public.qorpera_profile_members') or not pg_temp.office_free() then
			perform pg_temp.release(); raise exception 'I: % must wait at the member before the computer', v_call.name; end if;
		perform pg_temp.release();
		v_outcome := pg_temp.outcome(v_call.conn);
		if v_outcome like '40P01%' then raise exception 'I: % deadlocked: %', v_call.name, v_outcome; end if;
	end loop;
	-- Redeeming: a second viewer issued, then redeemed while the owner's row is held.
	v_outcome := pg_temp.settled('fence_two', format('select public.qorpera_create_runtime_office_viewer(%L, %s, %L, null)::text',
		current_setting('qorpera_test.binding'), current_setting('qorpera_test.epoch'), 'watch'));
	v_token := v_outcome::jsonb ->> 'capability';
	perform pg_temp.hold(pg_temp.member_hold('01'));
	perform dblink_send_query('fence_three', format('select public.qorpera_redeem_runtime_office_viewer(%L, %L)::text',
		current_setting('qorpera_test.scope'), encode(extensions.digest(v_token, 'sha256'), 'hex')));
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'I: redeeming must wait at the member before the computer'; end if;
	perform pg_temp.release();
	v_outcome := pg_temp.outcome('fence_three');
	if v_outcome <> 'ok' then raise exception 'I: the viewer is redeemed: %', v_outcome; end if;
end $$;

-- J. Exactly the patched functions and the two helpers name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930019100') <> 13 then
		raise exception 'J: 11 patched functions and 2 helpers name 20260930019100 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930019100'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does), the screen's events first (they name only its lifetime).
delete from public.qorpera_runtime_screen_events where lifetime_id = '89500000-0000-4000-8000-0000000000c1';
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
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
