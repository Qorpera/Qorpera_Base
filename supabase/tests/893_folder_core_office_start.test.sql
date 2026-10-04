-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3j (20260930012000): the Company Computer of a folder-v2 company is registered, listed, started,
-- watched, cancelled, provided for and reserved with the company row taken only KEY SHARE (each call is sent while another
-- session holds the row FOR NO KEY UPDATE, which only a stronger lock would wait for); a start and an activation take
-- their members and agent before the office, so an agent's return (its staff row, then the office's revision through
-- its default access) or a role change never deadlocks with them. Folder-v2 only (the founder's decision of 3 October:
-- no snapshot-v1 tests or old-text pins). 648's committed fixture (Ada's staff row); everything is removed at the end.

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

-- E. The provider's and the member's other calls on this computer: each is sent while another session holds the
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
	if cardinality(v_waited) > 0 then raise exception 'E: these waited for the company row: %', v_waited; end if;
	-- The office reservation passed its gate (a folder-v2 Company File) and holds allocation a9 (C's start reserved it);
	-- the node reservation then took the office kind's folder fence and reached its provider check.
	if v_answers ->> 'reserve_machine' !~ '"state": "reserved"' then
		raise exception 'E: the office reservation passes its gate: %', v_answers ->> 'reserve_machine'; end if;
	if v_answers ->> 'node_machine' not like '%NODE_PROVIDER_UNCONFIGURED%' then
		raise exception 'E: the node reservation reaches its provider check: %', v_answers ->> 'node_machine'; end if;
end $$;

-- E2. The guest binding's gate accepts a folder-v2 Company File: an active computer's binding gets past it to the allocation.
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
	if v_answer like '%Office guest authority unavailable%' then raise exception 'E2: the guest binding passes its gate: %', v_answer; end if;
end $$;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'provisioning' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;

-- F. Adopting a replaced computer's screens (only ever a legacy computer's) is refused on folder-v2, before any lock:
--    with the company row held, the refusal comes at once.
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_three', format(
	'select public.qorpera_check_runtime_office_adoption(%L, %s, %L, %L, %L, %L, %L, %L, %L)::text', current_setting('qorpera_test.scope'),
	current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d3', '89300000-0000-4000-8000-0000000000a9',
	repeat('c', 64), repeat('d', 64), '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), '[{"binding":{},"browserProfile":{}}]'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer not like '0A000 Adopting a legacy computer''s screens is not available%' then
		raise exception 'F: a folder-v2 adoption with screens refuses before any lock: %', v_answer; end if;
end $$;

-- G. A first start's preparation, startup check and activation share the start's members and agent before the office
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
	if v_answer !~ '"state": "requested"' then raise exception 'G: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89300000-0000-4000-8000-0000000000d4', '89300000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89300000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'G: the provider reserves the start: %', v_answer; end if;
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
		perform pg_temp.release(); raise exception 'G: the preparation must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_prepare text := pg_temp.outcome('fence_three');
begin
	if v_prepare <> 'ok' or not exists (select 1 from public.qorpera_runtime_office_activations
		where activation_id = '89300000-0000-4000-8000-0000000000f1' and state = 'prepared') then
		raise exception 'G: the preparation lands once the member row is free: %', v_prepare; end if;
end $$;
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format('select public.qorpera_check_runtime_office_startup(%L)::text',
	current_setting('qorpera_test.startup')));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'G: the startup check must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_startup text := pg_temp.outcome('fence_three'); v_ready text;
begin
	if v_startup <> 'ok' then raise exception 'G: the startup check lands once the member row is free: %', v_startup; end if;
	v_ready := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89300000-0000-4000-8000-0000000000f1'));
	if v_ready !~ '"state": "ready"' then raise exception 'G: the computer reports ready: %', v_ready; end if;
end $$;
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89300000-0000-4000-8000-0000000000d4',
	'89300000-0000-4000-8000-0000000000f1', '89300000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'G: the activation must wait at the member row before the office'; end if;
end $$;
select pg_temp.release();
do $$
declare v_activation text := pg_temp.outcome('fence_three');
begin
	-- Readiness lasts five seconds, so the activation may refuse as expired; it never deadlocks.
	if v_activation like '40P01%' then raise exception 'G: the activation deadlocked: %', v_activation; end if;
end $$;

-- H. The hire's office walk is ordered, and exactly the patched functions and the prelude name this migration.
do $$
begin
	if pg_get_functiondef('public.qorpera_runtime_office_default_access_for_staff()'::regprocedure) !~ 'order by id' then
		raise exception 'H: the default access walks offices by id'; end if;
	if (select count(*) from pg_proc where prosrc ~ '20260930012000') <> 25 then
		raise exception 'H: 24 patched functions and the prelude name 20260930012000 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930012000'); end if;
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
