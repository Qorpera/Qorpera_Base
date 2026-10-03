-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3j (20260930012000): the Company Computer of a folder-v2 company is registered, listed, started,
-- watched, cancelled, provided for and reserved with the company row taken only KEY SHARE (each call is sent while another
-- session holds the row FOR NO KEY UPDATE, which only a stronger lock would wait for); a start and an activation take
-- their members and agent before the office, so an agent's return (its staff row, then the office's revision through
-- its default access) or a role change never deadlocks with them; and every patched snapshot-v1 body is the one before
-- this migration once its patches are undone. A snapshot-v1 company keeps the gc fence. 648's committed fixture (Ada's
-- staff row); everything is removed at the end.

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

-- A. The owner registers the company's first computer while another session holds the company row.
select pg_temp.hold(pg_temp.company_hold('10'));
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
select set_config('qorpera_test.office', pg_temp.settled('fence_two', format(
	'select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text', '64800000-0000-4000-8000-000000000020',
	'89300000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64))), false);
select pg_temp.release();
do $$
declare v_office jsonb;
begin
	begin
		v_office := current_setting('qorpera_test.office')::jsonb;
	exception when others then raise exception 'A: registration must not wait or fail: %', current_setting('qorpera_test.office');
	end;
	if v_office ->> 'companyId' <> '64800000-0000-4000-8000-000000000010'
		or not exists (select 1 from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid) then
		raise exception 'A: the folder-v2 company has its computer: %', v_office; end if;
	-- Its default access went to the company's active agents (Ada among them).
	if not exists (select 1 from public.qorpera_runtime_office_access where office_id = (v_office ->> 'companyComputerId')::uuid
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1' and state = 'active') then
		raise exception 'A: Ada has access to the new computer'; end if;
	perform set_config('qorpera_test.scope', (v_office - 'state')::text, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', (select generation::text from public.qorpera_runtime_offices
		where id = (v_office ->> 'companyComputerId')::uuid), false);
end $$;

-- A2. Registration shares the owner's member row before any office row: with that row held (a role change), a second
--     registration waits at the member row holding no office, then finds the computer.
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
	'64800000-0000-4000-8000-000000000020', '89300000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'A2: registration must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_again text := pg_temp.outcome('fence_two');
begin
	if v_again <> 'ok' then raise exception 'A2: the second registration finds the computer: %', v_again; end if;
end $$;

-- A3. Registration takes the seat lock, so two first registrations meet there and the second returns the same computer
--     (instead of a unique violation on the computer number): with the seat lock held, a registration waits for it.
select pg_temp.hold(format('select 1 from (select public.qorpera_lock_runtime_office_seats(%L)) as seats',
	'64800000-0000-4000-8000-000000000020'));
select dblink_send_query('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
	'64800000-0000-4000-8000-000000000020', '89300000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'A3: registration must wait at the seat lock before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_again text := pg_temp.outcome('fence_two');
begin
	if v_again <> 'ok' then raise exception 'A3: the registration finds the computer: %', v_again; end if;
end $$;

-- B. The member's catalog, under the company row hold.
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_two', format('select public.qorpera_member_office_catalog(%L)::text',
	'64800000-0000-4000-8000-000000000020'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' or v_answer !~ current_setting('qorpera_test.office_id') then
		raise exception 'B: the catalog takes the company row only KEY SHARE and lists the computer: %', v_answer; end if;
end $$;

-- C. An agent's return against a start of that agent's computer: the start takes Ada's staff row before the office.
--    Ada's start (an intent of hers, as an agent's start leaves it) is reserved through the provider's own wrapper while
--    her staff row is held by an update (her return), which then bumps the office's revision (her default access's
--    browser grant): the start waits at the staff row holding no office, the return lands, and the start goes on. Before,
--    the start took the office first and waited for Ada's row while the return waited for the office.
set session_replication_role = replica;
insert into public.qorpera_runtime_office_start_intents(id, office_id, computer_generation, state, requested_by_staff_agent_id,
	grant_id, grant_version, receipt_id)
select '89300000-0000-4000-8000-0000000000d1', office.id, office.generation, 'requested', access.staff_agent_id, access.grant_id,
	access.version, '89300000-0000-4000-8000-0000000000e1'
from public.qorpera_runtime_offices as office
join public.qorpera_runtime_office_access as access on access.office_id = office.id
	and access.staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
where office.id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
-- The provider is enrolled for the computer (the provider's own call), so its reservation passes the assertion.
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.scope')::jsonb,
	current_setting('qorpera_test.generation')::bigint, '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), 0, true) is not null;
select pg_temp.hold($q$select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010'
	and staff_agent_id = '64800000-0000-4000-8000-0000000000a1' for no key update$q$);
select dblink_send_query('fence_three', format(
	'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d1',
	'89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64), repeat('d', 64),
	'89300000-0000-4000-8000-0000000000b0', repeat('f', 64)));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') then
		perform pg_temp.release(); raise exception 'C: the start must wait at Ada''s staff row'; end if;
	if not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'C: the start must not hold the office while it waits'; end if;
	-- Ada's return goes on to the office's revision, as her default access's browser grant does.
	perform dblink_exec('fence_one', format('update public.qorpera_runtime_offices set revision = revision + 1 where id = %L',
		current_setting('qorpera_test.office_id')));
end $$;
select pg_temp.release();
do $$
declare v_start text := pg_temp.outcome('fence_three');
begin
	-- The reservation then goes on (with these values it reserves allocation a9, kept until the cleanup); what matters
	-- is that both landed, never 40P01.
	if v_start like '40P01%' then raise exception 'C: the start deadlocked with the return: %', v_start; end if;
end $$;
delete from public.qorpera_runtime_office_start_intents where id = '89300000-0000-4000-8000-0000000000d1';

-- C2. A member's start shares the owner's member row before the office: with that row held (a role change or a removal
--     in flight), the start waits at the member row holding no office.
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d2'));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'C2: a member''s start must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_start text := pg_temp.outcome('fence_two');
begin
	if v_start <> 'ok' then raise exception 'C2: the start lands once the member row is free: %', v_start; end if;
end $$;

-- D. The owner watches and cancels the start, each under the company row hold.
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_status text; v_cancel text;
begin
	perform pg_temp.hold(pg_temp.company_hold('10'));
	v_status := pg_temp.settled('fence_two', format('select public.qorpera_runtime_office_start_status(%L)::text', v_scope));
	v_cancel := pg_temp.settled('fence_two', format('select public.qorpera_cancel_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '89300000-0000-4000-8000-0000000000d2'));
	perform pg_temp.release();
	if v_status = 'WAITED' or v_status ~ '^[0-9A-Z]{5} ' or v_cancel = 'WAITED' or v_cancel ~ '^[0-9A-Z]{5} ' then
		raise exception 'D: status %, cancel % (neither may wait or fail)', v_status, v_cancel; end if;
	if (select state from public.qorpera_runtime_office_start_intents where id = '89300000-0000-4000-8000-0000000000d2') <> 'cancelled' then
		raise exception 'D: the start was requested and cancelled'; end if;
end $$;

-- E. A snapshot-v1 company keeps the gc fence: its catalog waits for a holder of its company row.
select pg_temp.hold(pg_temp.company_hold('11'));
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000003');
select dblink_send_query('fence_two', format('select public.qorpera_member_office_catalog(%L)::text',
	'64800000-0000-4000-8000-000000000021'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		perform pg_temp.release(); raise exception 'E: a snapshot-v1 catalog still takes the gc fence'; end if;
end $$;
select pg_temp.release();
select pg_temp.outcome('fence_two');

-- F. The provider's and the member's other calls on this computer: each is sent while another session holds the
--    company row and must not wait; the office reservation and the node reservation must get past their gates.
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_call record; v_answers jsonb := '{}'; v_answer text; v_waited text[] := '{}';
	v_offer jsonb := jsonb_build_object('schema', 'qorpera.office-fleet-offer/v1', 'scope', current_setting('qorpera_test.scope')::jsonb,
		'computerGeneration', current_setting('qorpera_test.generation')::bigint, 'intentId', '89300000-0000-4000-8000-0000000000d3',
		'providerId', '89300000-0000-4000-8000-0000000000b0', 'nodeId', '89300000-0000-4000-8000-0000000000c1',
		'policySha256', repeat('f', 64), 'machineIdSha256', repeat('e', 64), 'allocationId', '89300000-0000-4000-8000-0000000000a8',
		'instanceSha256', repeat('c', 64), 'providerBindingSha256', repeat('d', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'cpuMillis', 2000, 'memoryBytes', 4294967296, 'serviceConfigSha256', repeat('9', 64));
begin
	perform pg_temp.hold(pg_temp.company_hold('10'));
	for v_call in select * from (values
		('assert', 'fence_three', format('select public.qorpera_assert_runtime_office_provider(%L, %s, %L, %L, false)::text', v_scope,
			v_generation, '89300000-0000-4000-8000-0000000000b0', repeat('f', 64))),
		('provider_status', 'fence_three', format('select public.qorpera_runtime_office_provider_status(%L, %s, %L, %L)::text', v_scope,
			v_generation, '89300000-0000-4000-8000-0000000000b0', repeat('f', 64))),
		('set_provider', 'fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 1, true)::text',
			v_scope, v_generation, '89300000-0000-4000-8000-0000000000b0', repeat('f', 64))),
		('check', 'fence_three', format('select public.qorpera_check_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L)::text', v_scope,
			v_generation, '89300000-0000-4000-8000-0000000000d3', '89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
			'89300000-0000-4000-8000-0000000000b0', repeat('f', 64))),
		('reserve_unbound', 'fence_three', format(
			'select public.qorpera_reserve_runtime_office_start_unbound(%L, %s, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
			'89300000-0000-4000-8000-0000000000d3', '89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64),
			repeat('b', 64), repeat('d', 64))),
		('place', 'fence_three', format('select public.qorpera_place_runtime_office_fleet(%L, %s)::text', v_scope, v_generation)),
		('offer', 'fence_three', format('select public.qorpera_offer_runtime_office_fleet(%L)::text', v_offer)),
		('reserve_machine', 'fence_three', format('select public.qorpera_reserve_runtime_machine(%L, %L, %L, null, null, %L, %s)::text',
			'89300000-0000-4000-8000-0000000000a9', 'lxd', repeat('c', 64), current_setting('qorpera_test.office_id'), v_generation)),
		('node_machine', 'fence_three', format('select public.qorpera_reserve_runtime_node_machine(%L, %L, %L, %L, %L, %L, null, null)::text',
			'89300000-0000-4000-8000-0000000000a9', 'office', 'office-provider', repeat('f', 64), repeat('c', 64), repeat('e', 64))),
		('withdraw', 'fence_two', format('select public.qorpera_withdraw_runtime_office_wake(%L, %s, %L)::text', v_scope, v_generation,
			'89300000-0000-4000-8000-0000000000d2')),
		('before_idle', 'fence_two', format('select public.qorpera_request_runtime_office_start_before_idle(%L, %s, %L)::text', v_scope,
			v_generation, '89300000-0000-4000-8000-0000000000d5'))) as c(name, conn, sql)
	loop
		v_answer := pg_temp.settled(v_call.conn, v_call.sql);
		v_answers := v_answers || jsonb_build_object(v_call.name, v_answer);
		if v_answer = 'WAITED' then
			v_waited := v_waited || v_call.name;
			perform pg_temp.release();
			perform pg_temp.outcome(v_call.conn);
			perform pg_temp.hold(pg_temp.company_hold('10'));
		end if;
	end loop;
	perform pg_temp.release();
	if cardinality(v_waited) > 0 then raise exception 'F: these waited for the company row: %', v_waited; end if;
	-- The office reservation passed its gate (a folder-v2 Company File) and holds allocation a9 (C's start reserved it);
	-- the node reservation then took the office kind's folder fence and reached its provider check.
	if v_answers ->> 'reserve_machine' !~ '"state": "reserved"' then
		raise exception 'F: the office reservation passes its gate: %', v_answers ->> 'reserve_machine'; end if;
	if v_answers ->> 'node_machine' not like '%NODE_PROVIDER_UNCONFIGURED%' then
		raise exception 'F: the node reservation reaches its provider check: %', v_answers ->> 'node_machine'; end if;
end $$;

-- F2. The guest binding's gate accepts a folder-v2 Company File: an active computer's binding gets past it to the allocation.
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'active' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
do $$
declare v_answer text;
begin
	begin
		perform public.qorpera_check_runtime_office_guest_binding(current_setting('qorpera_test.scope')::jsonb,
			current_setting('qorpera_test.generation')::bigint, '89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64),
			repeat('b', 64));
		v_answer := 'ok';
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	if v_answer like '%Office guest authority unavailable%' then raise exception 'F2: the guest binding passes its gate: %', v_answer; end if;
end $$;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'provisioning' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;

-- G. Adopting a replaced computer's screens is refused on folder-v2 until C1c-3k, before any lock: with the company row
--    held, the refusal comes at once.
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_three', format(
	'select public.qorpera_check_runtime_office_adoption(%L, %s, %L, %L, %L, %L, %L, %L, %L)::text', current_setting('qorpera_test.scope'),
	current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d3', '89300000-0000-4000-8000-0000000000a9',
	repeat('c', 64), repeat('d', 64), '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), '[{"binding":{},"browserProfile":{}}]'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer not like '0A000 Adopting a computer''s screens comes later%' then
		raise exception 'G: a folder-v2 adoption with screens refuses before any lock: %', v_answer; end if;
end $$;

-- H. A first start's preparation, startup check and activation share the start's members and agent before the office
--    (review r1): D's cancelled start is cleared (one start per computer generation); the owner starts the computer and
--    the provider reserves it; then the preparation, the startup check and the activation are each sent while the
--    owner's member row is held (a role change or removal in flight). Each waits at the member row holding no office,
--    and lands once it is free.
delete from public.qorpera_runtime_office_start_intents where id in ('89300000-0000-4000-8000-0000000000d2',
	'89300000-0000-4000-8000-0000000000d5');
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_answer text;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '89300000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'H: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89300000-0000-4000-8000-0000000000d4', '89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89300000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'H: the provider reserves the start: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '89300000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '89300000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
end $$;
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format(
	'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d4',
	'89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64), '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]',
	jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1', 'activationId', '89300000-0000-4000-8000-0000000000f1',
		'bootId', '89300000-0000-4000-8000-0000000000f2', 'preparationObservationSha256', repeat('1', 64),
		'configurationObservationSha256', repeat('2', 64), 'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64),
		'nativePort', 5900, 'viewerPort', 6080)));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'H: the preparation must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_prepare text := pg_temp.outcome('fence_three');
begin
	if v_prepare <> 'ok' or not exists (select 1 from public.qorpera_runtime_office_activations
		where activation_id = '89300000-0000-4000-8000-0000000000f1' and state = 'prepared') then
		raise exception 'H: the preparation lands once the member row is free: %', v_prepare; end if;
end $$;
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format('select public.qorpera_check_runtime_office_startup(%L)::text',
	current_setting('qorpera_test.startup')));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'H: the startup check must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_startup text := pg_temp.outcome('fence_three'); v_ready text;
begin
	if v_startup <> 'ok' then raise exception 'H: the startup check lands once the member row is free: %', v_startup; end if;
	v_ready := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89300000-0000-4000-8000-0000000000f1'));
	if v_ready !~ '"state": "ready"' then raise exception 'H: the computer reports ready: %', v_ready; end if;
end $$;
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d4',
	'89300000-0000-4000-8000-0000000000f1', '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'H: the activation must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_activation text := pg_temp.outcome('fence_three');
begin
	-- Readiness lasts five seconds, so the activation may refuse as expired; it never deadlocks.
	if v_activation like '40P01%' then raise exception 'H: the activation deadlocked: %', v_activation; end if;
end $$;

-- I. The hire's office walk is ordered, and exactly the patched functions and the prelude name this migration.
do $$
begin
	if pg_get_functiondef('public.qorpera_runtime_office_default_access_for_staff()'::regprocedure) !~ 'order by id' then
		raise exception 'I: the default access walks offices by id'; end if;
	if (select count(*) from pg_proc where prosrc ~ '20260930012000') <> 25 then
		raise exception 'I: 24 patched functions and the prelude name 20260930012000 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930012000'); end if;
end $$;

-- J. Snapshot-v1 keeps its text: each patched body with this migration's branches undone (last patch first) is byte for
--    byte the definition before it (digests from a database built up to 20260930011999).
create temporary table c1c3j_patches(n serial, fn text, digest text, patched text, original text) on commit preserve rows;
insert into c1c3j_patches(fn, digest, patched, original) values
	('public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)', 'a7db09c922a0e86e16f5a4bef0f7d69f',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean)', '8e82a24d3a0b4529e1e50522a4e2d2ff',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)', '3ea83c2a182b432281db7847f161e53a',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, the company row KEY SHARE, the member (rank 1) and the\n'
			|| E'\t-- seat lock, so a second first registration waits and finds the computer.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
			|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id=v_profile and user_id=auth.uid() for share;\n'
			|| E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'),
	('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)', '3ea83c2a182b432281db7847f161e53a',
		E'\t\t\tand profile_id=v_profile and state=''ready''\n'
			|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */)) then\n',
		E'\t\t\tand profile_id=v_profile and state=''ready'' and path_gateway_version=1) then\n'),
	('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)', '6674a2fa538cbe7ade605133fa5a563f',
		E'\t-- C1c-3j (20260930012000): a folder-v2 office takes the folder fence and the company row KEY SHARE.\n'
			|| E'\tif p_run_id is null and public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'),
	('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)', '6674a2fa538cbe7ade605133fa5a563f',
		E'profile_id=v_profile and state=''ready''\n'
			|| E'\t\t\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n',
		E'profile_id=v_profile and state=''ready'' and path_gateway_version=1)\n'),
	('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', 'fd61162fa752ec860a9b936499a6e523',
		E' -- C1c-3f (20260930002000) and C1c-3j (20260930012000): a folder-v2 machine or office takes the folder fence and\n'
			|| E' -- the company row KEY SHARE, held by every caller; coding (C1c-3h) still comes with the gc fence.\n'
			|| E' if p_provider_kind in (''machine'',''office'') and public.qorpera_company_is_folder_v2(v_profile) then\n',
		E' -- C1c-3f (20260930002000): a folder-v2 machine takes the folder fence and the company row KEY SHARE, held by\n'
			|| E' -- every caller; coding (C1c-3h) and office (C1c-3j) reservations still come with the gc fence.\n'
			|| E' if p_provider_kind=''machine'' and public.qorpera_company_is_folder_v2(v_profile) then\n'),
	('public.qorpera_request_runtime_office_start(jsonb,bigint,uuid)', '82050e4ef90b05627a204faf7a5cb8a0',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(o.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(o.id, auth.uid(), null);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'),
	('public.qorpera_request_runtime_office_start_before_idle(jsonb,bigint,uuid)', '09b61362fe54667f2255d107700b10fd',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid)', '2b9d1607985b676e4362d9725a1208b5',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_runtime_office_start_status(jsonb)', 'd805d32dcd61ebbab00f41301f6347a1',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)', 'e369f75eddc736e5e4b38038219093f9',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(o.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(o.id, auth.uid(), null);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'),
	('public.qorpera_reserve_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text,text,text)', '40915b7ebe41fa27170086be7a33c0c0',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_check_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text)', '7cce8e4ecbd0cf983c30ff4f1bcaa78e',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
			|| E'\t-- start-source check shares, before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
			|| E'\tend if;\n',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'),
	('public.qorpera_offer_runtime_office_fleet(jsonb)', '21e3753c1af8ed2ea1e0857973b8d419',
		E' -- C1c-3j (20260930012000): on folder-v2 the prelude (the start\'s agent before the office).\n'
			|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
			|| E'  perform public.qorpera_folder_office_enter(o.id, null, (p_offer->>''intentId'')::uuid);\n'
			|| E' else\n'
			|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
			|| E' end if;\n',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'),
	('public.qorpera_place_runtime_office_fleet(jsonb,bigint)', 'e29ff7e1980f9fa6ed44e19d7521e8fe',
		E' -- C1c-3j (20260930012000): on folder-v2 the prelude (the start\'s agent before the office).\n'
			|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
			|| E'  perform public.qorpera_folder_office_enter(o.id, null, null);\n'
			|| E' else\n'
			|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
			|| E' end if;\n',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'),
	('public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text)', '46272c381f40d2ba8bd3c2ebd22ddfa5',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
			|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
			|| E'\tend if;\n'
			|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n'),
	('public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,uuid,text)', '6b452f0c35a97b7a5452b78adef1b0c2',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
			|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
			|| E'\tend if;\n'
			|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n'),
	('public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)', '5e2560e7978ccedee82b15ee77b5ffaa',
		E'\t\t\tand profile_id=p_office.profile_id and state=''ready''\n'
			|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n',
		E'\t\t\tand profile_id=p_office.profile_id and state=''ready'' and path_gateway_version=1)\n'),
	('public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)', '648d6ea1652468232dcfc8ad4245856f',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
			|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n'),
	('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)', 'c885f718ffc400b7a421ef5935f21695',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
			|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
			|| E'\tend if;\n'
			|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);\n',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);\n'),
	('public.qorpera_lock_runtime_office_startup(jsonb)', '6e2ed767fae4be1b494f697169ad12af',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the activation\'s start members and agent before the office.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
			|| E'\t\twhere office.id=(p_startup#>>''{scope,companyComputerId}'')::uuid)) then\n'
			|| E'\t\tperform public.qorpera_folder_office_enter((p_startup#>>''{scope,companyComputerId}'')::uuid, null, v_activation.intent_id);\n'
			|| E'\tend if;\n'
			|| E'\tperform public.qorpera_assert_runtime_office_provider(p_startup->''scope'',(p_startup->>''computerGeneration'')::bigint,\n',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_startup->''scope'',(p_startup->>''computerGeneration'')::bigint,\n'),
	('public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)', '222807548edaada89f477f1681f37a26',
		E'\t-- C1c-3j (20260930012000): adopting screens on folder-v2 comes with C1c-3k (its agents and members first); it\n'
			|| E'\t-- refuses before any lock.\n'
			|| E'\tif jsonb_typeof(p_mappings)=''array'' and jsonb_array_length(p_mappings)>0\n'
			|| E'\t\tand public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
			|| E'\t\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
			|| E'\t\traise exception ''Adopting a computer''''s screens comes later on this company'' using errcode=''0A000''; end if;\n'
			|| E'\tv_result:=public.qorpera_check_runtime_office_start(p_scope,p_computer_generation,p_intent_id,p_allocation_id,\n',
		E'\tv_result:=public.qorpera_check_runtime_office_start(p_scope,p_computer_generation,p_intent_id,p_allocation_id,\n'),
	('public.qorpera_member_office_catalog(uuid,uuid)', '0f16f5545ff5aaa2c984309ba89573a7',
		E' -- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE, never the gc fence.\n'
			|| E' if public.qorpera_company_is_folder_v2(v_company) then\n'
			|| E'  perform public.qorpera_folder_machine_fence(v_company);\n'
			|| E' else\n'
			|| E' perform public.qorpera_lock_profile_gc_fence(v_company);\n'
			|| E' end if;\n',
		E' perform public.qorpera_lock_profile_gc_fence(v_company);\n'),
	('public.qorpera_runtime_office_default_access_for_staff()', '4155ed4a9cd7967e2bb4b30f2c74edbc',
		E'where profile_id = new.profile_id and state <> ''retired''\n'
			|| E'\t\t\torder by id /* C1c-3j 20260930012000: offices in id order, as every office path takes them */ loop\n',
		E'where profile_id = new.profile_id and state <> ''retired'' loop\n'),
	('public.qorpera_enforce_company_path_computer_interlock()', '73f0084d9ef04ef95ca01114428235d2',
		E'\t\tif new.computer_class <> ''company_computer'' then return new; end if;\n'
			|| E'\t\t-- C1c-3j (20260930012000): a folder-v2 company has no version-1 cutover to serialize.\n'
			|| E'\t\tif public.qorpera_company_is_folder_v2(new.profile_id) then return new; end if;\n'
			|| E'\t\tperform public.qorpera_lock_profile_gc_fence(new.profile_id);\n',
		E'\t\tif new.computer_class <> ''company_computer'' then return new; end if;\n'
			|| E'\t\tperform public.qorpera_lock_profile_gc_fence(new.profile_id);\n');
do $$
declare v record; p record; v_text text; v_bad text[] := '{}';
begin
	for v in select fn, min(digest) as digest from c1c3j_patches group by fn loop
		v_text := pg_get_functiondef(v.fn::regprocedure);
		for p in select * from c1c3j_patches where fn = v.fn order by n desc loop
			if position(p.patched in v_text) = 0 then v_bad := v_bad || (v.fn || ' (a patch is missing)'); end if;
			v_text := replace(v_text, p.patched, p.original);
		end loop;
		if md5(v_text) <> v.digest then v_bad := v_bad || v.fn; end if;
	end loop;
	if cardinality(v_bad) > 0 then raise exception 'J: snapshot-v1 text changed in: %', v_bad; end if;
	if (select count(distinct fn) from c1c3j_patches) <> 24 then raise exception 'J: 24 patched functions'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does).
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
