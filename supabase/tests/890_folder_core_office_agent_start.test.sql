-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3l part 1 (20260930030000): an agent starts the Company Computer of a folder-v2 company. Ada's
-- computer_start and its descriptor take no company row FOR UPDATE; the start shares its own agent and every agent or
-- member that a current start of the company's computers names before the seat lock and the computers, so an agent's
-- return never deadlocks with it; a start of the computer named after that read makes the start try again (55P03); the
-- descriptor's new computer shares the company's agents before the seat lock. Each "waits there holding no computer"
-- case holds the earlier lock in another session. Folder-v2 only (the founder's decision of 3 October). 648's committed
-- fixture; everything is removed at the end.

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

create function pg_temp.staff_hold(p_staff text, p_mode text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_staff where profile_id = %L and staff_agent_id = %L for %s',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_staff, p_mode)
$$;
create function pg_temp.no_advisory(p_conn text) returns boolean language sql as $$
	select not exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and locktype = 'advisory' and granted)
$$;
-- Ada's computer_start for an operation key: the envelope from the current descriptor, and its receipt begun.
create function pg_temp.start_operation(p_key text, p_receipt uuid) returns void language plpgsql as $$
declare v_descriptor jsonb := public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.binding')::jsonb, true);
	v_envelope text;
begin
	if v_descriptor ->> 'state' is distinct from 'available' then raise exception 'Setup: the descriptor is available: %', v_descriptor; end if;
	v_envelope := jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.binding')::jsonb) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_start', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'arguments', '{"kind":"start"}'::jsonb,
			'target', jsonb_build_object('realm', 'company_computer', 'scope', v_descriptor -> 'scope',
				'computerGeneration', v_descriptor -> 'computerGeneration', 'resources', v_descriptor -> 'resources'),
			'requiresCompanyRevision', false))::text;
	perform set_config('qorpera_test.envelope', v_envelope, false);
	perform public.qorpera_native_office_start(current_setting('qorpera_test.binding')::jsonb, v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt,
		'computer_start:' || p_key, encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'), repeat('9', 64), false);
end $$;
create function pg_temp.sql_begin(p_receipt uuid) returns text language sql as $$
	select format('select public.qorpera_native_office_start(%L, %L, %L, %L, %L)::text', current_setting('qorpera_test.binding'),
		current_setting('qorpera_test.envelope'), 'begin', p_receipt, repeat('9', 64))
$$;
-- A sent call's text answer, or its error as "<sqlstate> <message>"; drains the connection.
create function pg_temp.answer(p_conn text) returns text language plpgsql as $$
declare v text;
begin
	begin
		select r into v from dblink_get_result(p_conn) as t(r text);
	exception when others then v := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v, 'null');
end $$;
-- Ends Ada's computer_start operation, as the runtime does once it has the answer.
create function pg_temp.complete(p_receipt uuid, p_result jsonb) returns void language sql as $$
	select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt,
		encode(extensions.digest(convert_to(current_setting('qorpera_test.envelope'), 'UTF8'), 'sha256'), 'hex'), p_result)
$$;
create function pg_temp.clear_starts() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_runtime_office_start_waiters where intent_id in (select id from public.qorpera_runtime_office_start_intents
		where office_id = current_setting('qorpera_test.office_id')::uuid);
	delete from public.qorpera_runtime_office_start_intents where office_id = current_setting('qorpera_test.office_id')::uuid;
	delete from public.qorpera_runtime_machine_allocations where office_id = current_setting('qorpera_test.office_id')::uuid;
end $$;

-- The company's computer, registered by its owner and enrolled with its provider (893's chain); it stays provisioning,
-- so Ada's descriptor offers to start it. Ada's run gets an executable runtime bundle and acknowledges first, as a human
-- wake requires (824 B's recipe).
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_office jsonb := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
	'64800000-0000-4000-8000-000000000020', '89000000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)))::jsonb;
begin
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.scope', (v_office - 'state')::text, false);
	perform set_config('qorpera_test.generation', (select generation::text from public.qorpera_runtime_offices
		where id = (v_office ->> 'companyComputerId')::uuid), false);
	perform public.qorpera_set_runtime_office_provider(v_office - 'state', current_setting('qorpera_test.generation')::bigint,
		'89000000-0000-4000-8000-0000000000b0', repeat('f', 64), 0, true);
end $$;
set session_replication_role = replica;
update public.qorpera_execution_runs run set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256, reasoning_effort = 'low',
	reasoning_policy_sha256 = encode(extensions.digest(convert_to((bundle.manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'),
	service_tier = 'standard'
from public.qorpera_active_runtime_bundle active join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
where run.id = '64800000-0000-4000-8000-0000000000f1';
update public.qorpera_session_inputs input set runtime_bundle_id = run.runtime_bundle_id, runtime_bundle_sha256 = run.runtime_bundle_sha256
from public.qorpera_execution_runs run where run.id = '64800000-0000-4000-8000-0000000000f1' and input.execution_run_id = run.id;
set session_replication_role = origin;
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'office-ack', 'Starting the computer.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null

-- A. The descriptor and the start's authorize take no company row FOR UPDATE: each is sent while another session holds
--    the company row FOR NO KEY UPDATE and answers at once.
select pg_temp.start_operation('start-a', '89000000-0000-4000-8000-0000000000e1');
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_descriptor text := pg_temp.settled('fence_three', format('select public.qorpera_native_office_start_descriptor(%L, false)::text',
		current_setting('qorpera_test.binding')));
	v_authorize text := pg_temp.settled('fence_three', format('select public.qorpera_native_office_start(%L, %L, %L)::text',
		current_setting('qorpera_test.binding'), current_setting('qorpera_test.envelope'), 'authorize'));
begin
	perform pg_temp.release();
	if v_descriptor = 'WAITED' or v_authorize = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_descriptor !~ '"state": "available"' then raise exception 'A: the descriptor answers without a company lock: %', v_descriptor; end if;
	if v_authorize !~ '"state": "authorized"' then raise exception 'A: the authorize answers without a company lock: %', v_authorize; end if;
end $$;

-- B. Ada's start against Ada's return: the start shares Ada's row before the seat lock and the computer. With Ada's row
--    held (her return), the start waits there holding no seat lock and no computer; the return then bumps the
--    computer's revision (as its default access does) and commits; the start lands with Ada's start of the computer.
--    Before, the start took the computers first and shared Ada after them: a deadlock.
select pg_temp.hold(pg_temp.staff_hold('a1', 'no key update'));
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e1'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') or not pg_temp.office_free()
		or not pg_temp.no_advisory('fence_three') then
		perform pg_temp.release(); raise exception 'B: the start must wait at Ada''s row before the seat lock and the computer'; end if;
	perform dblink_exec('fence_one', format('update public.qorpera_runtime_offices set revision = revision + 1 where id = %L',
		current_setting('qorpera_test.office_id')));
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'B: the start lands: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e1', v_outcome::jsonb);
	if not exists (select 1 from public.qorpera_runtime_office_start_intents where office_id = current_setting('qorpera_test.office_id')::uuid
		and requested_by_staff_agent_id = '64800000-0000-4000-8000-0000000000a1' and state = 'requested') then
		raise exception 'B: Ada''s start of the computer is recorded'; end if;
end $$;

-- C. The other starts of the company's computers are shared first too. Each of the owner's and the provider's calls on
--    the computer whose current start is Ada's (3j's preludes, now with a real agent's start) is sent while Ada's row is
--    held: each waits there holding no computer, and never deadlocks once it goes on.
select set_config('qorpera_test.intent', (select id::text from public.qorpera_runtime_office_start_intents
	where office_id = current_setting('qorpera_test.office_id')::uuid), false);
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_intent text := current_setting('qorpera_test.intent'); v_call record; v_outcome text;
	v_offer jsonb := jsonb_build_object('schema', 'qorpera.office-fleet-offer/v1', 'scope', current_setting('qorpera_test.scope')::jsonb,
		'computerGeneration', current_setting('qorpera_test.generation')::bigint, 'intentId', current_setting('qorpera_test.intent'),
		'providerId', '89000000-0000-4000-8000-0000000000b0', 'nodeId', '89000000-0000-4000-8000-0000000000c1',
		'policySha256', repeat('f', 64), 'machineIdSha256', repeat('e', 64), 'allocationId', '89000000-0000-4000-8000-0000000000a8',
		'instanceSha256', repeat('c', 64), 'providerBindingSha256', repeat('d', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'cpuMillis', 2000, 'memoryBytes', 4294967296, 'serviceConfigSha256', repeat('9', 64));
begin
	for v_call in select * from (values
		('before-idle', 'fence_two', format('select public.qorpera_request_runtime_office_start_before_idle(%L, %s, %L)::text', v_scope,
			v_generation, '89000000-0000-4000-8000-0000000000d5')),
		('offer', 'fence_three', format('select public.qorpera_offer_runtime_office_fleet(%L)::text', v_offer)),
		('place', 'fence_three', format('select public.qorpera_place_runtime_office_fleet(%L, %s)::text', v_scope, v_generation)),
		('check unbound', 'fence_three', format('select public.qorpera_check_runtime_office_start_unbound(%L, %s, %L, %L, %L, %L)::text',
			v_scope, v_generation, v_intent, '89000000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64))),
		('reserve unbound', 'fence_three', format(
			'select public.qorpera_reserve_runtime_office_start_unbound(%L, %s, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
			v_intent, '89000000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64), repeat('d', 64))),
		('withdraw', 'fence_two', format('select public.qorpera_withdraw_runtime_office_wake(%L, %s, %L)::text', v_scope, v_generation,
			'89000000-0000-4000-8000-0000000000d6')),
		('cancel', 'fence_two', format('select public.qorpera_cancel_runtime_office_start(%L, %s, %L)::text', v_scope, v_generation,
			v_intent))) as c(name, conn, sql)
	loop
		perform pg_temp.hold(pg_temp.staff_hold('a1', 'no key update'));
		perform dblink_send_query(v_call.conn, v_call.sql);
		if not pg_temp.waits_at(v_call.conn, 'public.qorpera_profile_staff') or not pg_temp.office_free() then
			perform pg_temp.release(); raise exception 'C: % must wait at Ada''s row before the computer', v_call.name; end if;
		perform dblink_exec('fence_one', format('update public.qorpera_runtime_offices set revision = revision + 1 where id = %L',
			current_setting('qorpera_test.office_id')));
		perform pg_temp.release();
		v_outcome := pg_temp.outcome(v_call.conn);
		if v_outcome like '40P01%' then raise exception 'C: % deadlocked: %', v_call.name, v_outcome; end if;
	end loop;
	if (select state from public.qorpera_runtime_office_start_intents where id = current_setting('qorpera_test.intent')::uuid) <> 'cancelled' then
		raise exception 'C: the owner''s cancel landed'; end if;
end $$;

-- D. A start that joins another agent's start of the computer shares that agent too: with the Co-Founder's start of the
--    computer (a start of its own, recorded directly) and the Co-Founder's row held, Ada's start waits there holding no
--    computer, then joins it.
select pg_temp.clear_starts();
set session_replication_role = replica;
insert into public.qorpera_runtime_office_start_intents(id, office_id, computer_generation, state, requested_by_staff_agent_id,
	grant_id, grant_version, receipt_id)
select '89000000-0000-4000-8000-0000000000d1', office.id, office.generation, 'requested', access.staff_agent_id, access.grant_id,
	access.version, '89000000-0000-4000-8000-0000000000e9'
from public.qorpera_runtime_offices as office
join public.qorpera_runtime_office_access as access on access.office_id = office.id
	and access.staff_agent_id = '64800000-0000-4000-8000-0000000000c0'
where office.id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
select pg_temp.start_operation('start-d', '89000000-0000-4000-8000-0000000000e2');
select pg_temp.hold(pg_temp.staff_hold('c0', 'no key update'));
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e2'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'D: the start must wait at the Co-Founder''s row before the computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'D: Ada''s start joins the Co-Founder''s: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e2', v_outcome::jsonb);
	if not exists (select 1 from public.qorpera_runtime_office_start_waiters where intent_id = '89000000-0000-4000-8000-0000000000d1'
		and parent_run_id = '64800000-0000-4000-8000-0000000000f1') then raise exception 'D: Ada waits on the Co-Founder''s start'; end if;
end $$;

-- E. A start of the computer that appears after the prelude's read: Ada's start waits at the seat lock (another session
--    holds it) while the Co-Founder's start of the computer commits. Once the seat lock is free, Ada's start shares the
--    Co-Founder without waiting (the start-source check, NOWAIT on folder-v2) and joins that start.
select pg_temp.clear_starts();
create function pg_temp.cofounder_start(p_id uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_start_intents(id, office_id, computer_generation, state, requested_by_staff_agent_id,
		grant_id, grant_version, receipt_id)
	select p_id, office.id, office.generation, 'requested', access.staff_agent_id, access.grant_id, access.version, p_id
	from public.qorpera_runtime_offices as office
	join public.qorpera_runtime_office_access as access on access.office_id = office.id
		and access.staff_agent_id = '64800000-0000-4000-8000-0000000000c0'
	where office.id = current_setting('qorpera_test.office_id')::uuid;
end $$;
create function pg_temp.seat_hold() returns text language sql as $$
	select format('select 1 from (select public.qorpera_lock_runtime_office_seats(%L)) as seats', '64800000-0000-4000-8000-000000000020')
$$;
select pg_temp.start_operation('start-e', '89000000-0000-4000-8000-0000000000e3');
select pg_temp.hold(pg_temp.seat_hold());
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e3'));
do $$
begin
	if not pg_temp.waits_for('fence_three', 'fence_one') then
		perform pg_temp.release(); raise exception 'E: the start must wait at the seat lock'; end if;
end $$;
select pg_temp.cofounder_start('89000000-0000-4000-8000-0000000000d2');
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'E: Ada''s start joins a start that appeared meanwhile: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e3', v_outcome::jsonb);
	if not exists (select 1 from public.qorpera_runtime_office_start_waiters where intent_id = '89000000-0000-4000-8000-0000000000d2'
		and receipt_id = '89000000-0000-4000-8000-0000000000e3') then raise exception 'E: Ada waits on the Co-Founder''s start'; end if;
end $$;

-- E1. The same, with the Co-Founder's row being written when the seat lock frees (its return in flight): Ada's start
--     refuses at once (55P03) rather than wait behind a holder that wants the seat lock, and records nothing; its
--     receipt stays open, as the runtime leaves an unconfirmed start.
select pg_temp.clear_starts();
select pg_temp.start_operation('start-e1', '89000000-0000-4000-8000-0000000000e6');
-- A start that waited for the busy agent would sit behind an idle holder: the lock timeout turns that into a failure.
select dblink_exec('fence_three', 'set lock_timeout = ''10s''');
select pg_temp.hold(pg_temp.seat_hold());
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e6'));
do $$
begin
	if not pg_temp.waits_for('fence_three', 'fence_one') then
		perform pg_temp.release(); raise exception 'E1: the start must wait at the seat lock'; end if;
end $$;
select pg_temp.cofounder_start('89000000-0000-4000-8000-0000000000d4');
select dblink_exec('fence_two', 'begin');
select * from dblink('fence_two', pg_temp.staff_hold('c0', 'no key update')) as t(x integer);
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	perform dblink_exec('fence_two', 'commit');
	perform dblink_exec('fence_three', 'reset lock_timeout');
	if v_outcome not like '55P03 could not obtain lock%' then raise exception 'E1: a busy agent makes the start refuse at once: %', v_outcome; end if;
	if exists (select 1 from public.qorpera_runtime_office_start_waiters where receipt_id = '89000000-0000-4000-8000-0000000000e6')
		or (select status from public.qorpera_run_operation_receipts where id = '89000000-0000-4000-8000-0000000000e6') <> 'executing' then
		raise exception 'E1: the refused start recorded nothing and left its receipt open'; end if;
end $$;
-- The test settles the open receipt itself, so the run's later calls are not blocked.
set session_replication_role = replica;
update public.qorpera_run_operation_receipts set status = 'completed', completed_at = clock_timestamp(),
	result = '{"state":"refused"}' where id = '89000000-0000-4000-8000-0000000000e6';
set session_replication_role = origin;

-- E2. A start that joins a member's start of the computer shares that member first: the owner starts the computer,
--     and with the owner's row held (a role change or a removal in flight) Ada's start waits there holding no computer,
--     then joins it.
select pg_temp.clear_starts();
do $$
declare v_answer text := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89000000-0000-4000-8000-0000000000d3'));
begin
	if v_answer !~ '"state": "requested"' then raise exception 'E2: the owner starts the computer: %', v_answer; end if;
end $$;
select pg_temp.start_operation('start-e2', '89000000-0000-4000-8000-0000000000e4');
select pg_temp.hold(pg_temp.member_hold('01'));
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e4'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
		perform pg_temp.release(); raise exception 'E2: the start must wait at the owner''s row before the computer'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'E2: Ada''s start joins the owner''s: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e4', v_outcome::jsonb);
end $$;

-- E3. The start shares every active agent KEY SHARE in its prelude (a new computer's default access takes them after the
--     computers): with the Co-Founder's row held FOR UPDATE, Ada's start waits there holding no seat lock, then lands.
select pg_temp.clear_starts();
select pg_temp.start_operation('start-e3', '89000000-0000-4000-8000-0000000000e5');
select pg_temp.hold(pg_temp.staff_hold('c0', 'update'));
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e5'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') or not pg_temp.no_advisory('fence_three') then
		perform pg_temp.release(); raise exception 'E3: the start must wait at the agents before the seat lock'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'E3: the start lands: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e5', v_outcome::jsonb);
end $$;

-- E2b. The owner's start commits after Ada's read (Ada waits at the seat lock), and the owner's row is held: Ada's start
--      shares the owner after the computer, which is safe (a member's writers never take a seat lock or a computer), so it
--      waits there and then joins.
select pg_temp.clear_starts();
select pg_temp.start_operation('start-e2b', '89000000-0000-4000-8000-0000000000e7');
select pg_temp.hold(pg_temp.seat_hold());
select dblink_send_query('fence_three', pg_temp.sql_begin('89000000-0000-4000-8000-0000000000e7'));
do $$
begin
	if not pg_temp.waits_for('fence_three', 'fence_one') then
		perform pg_temp.release(); raise exception 'E2b: the start must wait at the seat lock'; end if;
end $$;
set session_replication_role = replica;
insert into public.qorpera_runtime_office_start_intents(id, office_id, computer_generation, state, requested_by_user_id)
select '89000000-0000-4000-8000-0000000000d5', office.id, office.generation, 'requested', '64800000-0000-4000-8000-000000000001'
from public.qorpera_runtime_offices as office where office.id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
select dblink_exec('fence_two', 'begin');
select * from dblink('fence_two', pg_temp.member_hold('01')) as t(x integer);
select pg_temp.release();
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') then
		perform dblink_exec('fence_two', 'commit'); raise exception 'E2b: the start must wait at the owner''s row'; end if;
end $$;
select dblink_exec('fence_two', 'commit');
do $$
declare v_outcome text := pg_temp.answer('fence_three');
begin
	if v_outcome !~ '"state": "requested"' then raise exception 'E2b: Ada''s start joins the owner''s: %', v_outcome; end if;
	perform pg_temp.complete('89000000-0000-4000-8000-0000000000e7', v_outcome::jsonb);
end $$;

-- E4. A member's start against an agent's start that appeared after the member's read (3j's start, now that agents
--     start too): the owner's start waits at the computer while Ada's start commits and Ada's row is being written; the
--     owner's start (its before-idle body runs 3j's prelude again, nested) then refuses at once (55P03) rather than wait
--     behind a holder that wants the seat lock.
select pg_temp.clear_starts();
select dblink_exec('fence_two', 'set lock_timeout = ''10s''');
select pg_temp.hold(format('select 1 from public.qorpera_runtime_offices where id = %L for update', current_setting('qorpera_test.office_id')));
select dblink_send_query('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text',
	current_setting('qorpera_test.scope'), current_setting('qorpera_test.generation'), '89000000-0000-4000-8000-0000000000d6'));
do $$
begin
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runtime_offices') then
		perform pg_temp.release(); raise exception 'E4: the owner''s start must wait at the computer'; end if;
end $$;
set session_replication_role = replica;
insert into public.qorpera_runtime_office_start_intents(id, office_id, computer_generation, state, requested_by_staff_agent_id,
	grant_id, grant_version, receipt_id)
select '89000000-0000-4000-8000-0000000000d7', office.id, office.generation, 'requested', access.staff_agent_id, access.grant_id,
	access.version, '89000000-0000-4000-8000-0000000000d7'
from public.qorpera_runtime_offices as office
join public.qorpera_runtime_office_access as access on access.office_id = office.id
	and access.staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
where office.id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
select dblink_exec('fence_three', 'begin');
select * from dblink('fence_three', pg_temp.staff_hold('a1', 'no key update')) as t(x integer);
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.answer('fence_two');
begin
	perform dblink_exec('fence_three', 'commit');
	perform dblink_exec('fence_two', 'reset lock_timeout');
	if v_outcome not like '55P03 could not obtain lock%' then
		raise exception 'E4: the owner''s start refuses at once beside a busy agent: %', v_outcome; end if;
end $$;

-- F. The descriptor's new computer shares the company's agents before the seat lock: with scale-out on and the only
--    computer in maintenance (no seat for Ada), and the Co-Founder's row held FOR UPDATE, the descriptor waits at the
--    agents holding no seat lock.
select pg_temp.clear_starts();
select set_config('qorpera_test.scale_out', (select enabled::text from public.qorpera_runtime_office_scale_out where singleton), false);
update public.qorpera_runtime_office_scale_out set enabled = true where singleton;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
select pg_temp.hold(pg_temp.staff_hold('c0', 'update'));
select dblink_send_query('fence_three', format('select public.qorpera_native_office_start_descriptor(%L, false)::text',
	current_setting('qorpera_test.binding')));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') or not pg_temp.no_advisory('fence_three') then
		perform pg_temp.release(); raise exception 'F: the new computer must wait at the agents before the seat lock'; end if;
end $$;
select pg_temp.release();
do $$
declare v_outcome text := pg_temp.outcome('fence_three');
begin
	if v_outcome <> 'ok' then raise exception 'F: the descriptor adds the computer: %', v_outcome; end if;
	if (select count(*) from public.qorpera_runtime_offices where environment_id = '64800000-0000-4000-8000-000000000020'
		and state <> 'retired') <> 2 then raise exception 'F: the company has its second computer'; end if;
end $$;
update public.qorpera_runtime_office_scale_out set enabled = current_setting('qorpera_test.scale_out')::boolean where singleton;

-- G. Exactly the patched functions and the prelude name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930030000') <> 5 then
		raise exception 'G: 4 patched functions and the prelude name 20260930030000 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930030000'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does), the starts' waiters first (they name only the run).
delete from public.qorpera_runtime_office_start_waiters where parent_run_id = '64800000-0000-4000-8000-0000000000f1';
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
