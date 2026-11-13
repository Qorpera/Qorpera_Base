-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930744000: the member's pointer pass. On 924's base (an owner, a contributor, a viewer, an admin and an outsider;
-- Alice's live run for the owner), with Alice's running desktop m-1238, a stopped one and a running machine too small:
-- 1. the shared pass: owners, admins and contributors; a viewer, a stranger and the service role refused; malformed
--    forms; too small, asleep; a live private hold (another member's, the caller's own) and a generation that moved
--    refused; the newest pass replaces the member's last one (one row per member and machine);
-- 2. the private pass: only the holder's own live hold under its epoch and in its seat;
-- 3. the executor's read: served to the machine's own executor; refused once a private hold began (live: in control;
--    given back: held since), for a private pass after its hold ended, for a pass older than 10 seconds or replaced, for
--    a member made a viewer; it names the generation now and what is left of the pass, and moves the machine's last use
--    at most every 30 seconds;
-- 4. nothing per move or per pass of an action's: no action row, no lease renewed, no memberTouched, no disk mark;
-- 5. the window's list names at most 50 others, the most recent first (#1723 r1 F1);
-- 6. the grants and the markers.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'pt-ack') is not null;

select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at)
select machine.id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', machine.name,
	'Tests the shop.', run.staff_agent_id, run.id, machine.receipt_id, run.requested_by_user_id, machine.cpus, machine.memory,
	21474836480, 'standard', 'task', machine.desired_state, clock_timestamp() - interval '1 hour'
from public.qorpera_execution_runs as run
cross join (values
	('12380000-0000-4000-8000-0000000007a1'::uuid, 'm-1238', '12380000-0000-4000-8000-0000000008a1'::uuid, 2, 4294967296::bigint, 'running'),
	('12380000-0000-4000-8000-0000000007a2', 'm-1238-asleep', '12380000-0000-4000-8000-0000000008a2', 2, 4294967296, 'stopped'),
	('12380000-0000-4000-8000-0000000007a3', 'm-1238-small', '12380000-0000-4000-8000-0000000008a3', 1, 2147483648, 'running')
) as machine(id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12380000-0000-4000-8000-0000000007b' || n)::uuid, ('12380000-0000-4000-8000-0000000007a' || n)::uuid,
	'92400000-0000-4000-8000-000000000010', 'mx-1238', repeat('8', 64), '{"providerId": "machine-1238"}', repeat(n::text, 64),
	clock_timestamp(), ('12380000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 3]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12380000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12380000-0000-4000-8000-0000000007d1', 'machine', 'machine-1238', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12380000-%';
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.pt_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.pt_try(text) to authenticated, service_role;
create function pg_temp.pt_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
create function pg_temp.pt_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.pt_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.pt_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.pt_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.pt_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12380000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.pt_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.pt_machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.pt_id('a1')
$$;
create function pg_temp.pt_generation() returns bigint language sql as $$
	select (pg_temp.pt_machine()).desktop_member_generation
$$;
create function pg_temp.pt_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused', 'reason', p_reason)::text
$$;
create function pg_temp.pt_auth_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
		'reason', p_reason)::text
$$;
-- A pass: shared under `generation`, or private under (`epoch`, `seat`).
create function pg_temp.pt_begin(p_who text, p_generation bigint, p_epoch bigint default null, p_seat bigint default null,
	p_machine text default 'a1') returns text language sql as $$
	select pg_temp.pt_as(pg_temp.pt_user(p_who), format(
		'select public.qorpera_member_machine_desktop_pointer_begin(%L, %L, %s, %s, %s)', '92400000-0000-4000-8000-000000000010',
		pg_temp.pt_id(p_machine), coalesce(p_generation::text, 'null'), coalesce(p_epoch::text, 'null'),
		coalesce(p_seat::text, 'null')))
$$;
create function pg_temp.pt_pass(p_who text) returns uuid language plpgsql as $$
declare v text := pg_temp.pt_begin(p_who, pg_temp.pt_generation());
begin
	if pg_temp.pt_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'No pass: %', v; end if;
	return (pg_temp.pt_answer(v) ->> 'passId')::uuid;
end $$;
create function pg_temp.pt_auth(p_pass uuid, p_owner text default 'mx-1238', p_provider text default 'machine-1238')
returns text language sql as $$
	select pg_temp.pt_service(format('select public.qorpera_member_machine_desktop_pointer_authority(%L, %L, %L)', p_pass, p_owner,
		p_provider))
$$;
create function pg_temp.pt_epoch(p_who text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.pt_id('a1') and epochs.user_id = pg_temp.pt_user(p_who)), 0)
$$;
create function pg_temp.pt_take(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.pt_as(pg_temp.pt_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
	'92400000-0000-4000-8000-000000000010', pg_temp.pt_id('a1'), pg_temp.pt_epoch(p_who), pg_catalog.gen_random_uuid()));
begin
	if pg_temp.pt_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The take-over did not hold: %', v; end if;
end $$;
create function pg_temp.pt_hand_back(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.pt_as(pg_temp.pt_user(p_who), format(
	'select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
	pg_temp.pt_id('a1'), 'handed_back', pg_temp.pt_epoch(p_who), pg_temp.pt_generation()));
begin
	if pg_temp.pt_answer(v) is null then raise exception 'The hand-back failed: %', v; end if;
end $$;
-- Moves the newest pass of a member back in time.
create function pg_temp.pt_age(p_who text, p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_desktop_pointers set begun_at = begun_at - p_by
	where machine_id = pg_temp.pt_id('a1') and user_id = pg_temp.pt_user(p_who);
	set local session_replication_role = origin;
end $$;
create function pg_temp.pt_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;

-- 1. The shared pass ---------------------------------------------------------------------------------------------------------------
do $$
declare
	v_now bigint := pg_temp.pt_generation();
	v_differ text;
	v_first uuid;
	v_second uuid;
begin
	v_differ := pg_temp.pt_differ(jsonb_build_array(
		jsonb_build_array('a viewer', pg_temp.pt_begin('viewer', v_now), '42501:Machine desktop is unavailable'),
		jsonb_build_array('a stranger', pg_temp.pt_begin('outsider', v_now), '42501:Machine desktop is unavailable'),
		jsonb_build_array('none of the forms', pg_temp.pt_begin('owner', null), '22023:Machine desktop pointer is malformed'),
		jsonb_build_array('both forms', pg_temp.pt_begin('owner', v_now, 0, 1), '22023:Machine desktop pointer is malformed'),
		jsonb_build_array('half a hold', pg_temp.pt_begin('owner', null, 0, null), '22023:Machine desktop pointer is malformed'),
		jsonb_build_array('below 0', pg_temp.pt_begin('owner', -1), '22023:Machine desktop pointer is malformed'),
		jsonb_build_array('asleep', pg_temp.pt_begin('owner', v_now, null, null, 'a2'), pg_temp.pt_refused('MACHINE_NOT_RUNNING')),
		jsonb_build_array('too small', pg_temp.pt_begin('owner', v_now, null, null, 'a3'), pg_temp.pt_refused('DESKTOP_MACHINE_TOO_SMALL')),
		jsonb_build_array('another generation', pg_temp.pt_begin('owner', v_now + 1), pg_temp.pt_refused('DESKTOP_HELD_SINCE')),
		jsonb_build_array('the service role', pg_temp.pt_service(format(
			'select public.qorpera_member_machine_desktop_pointer_begin(%L, %L, %s, null, null)', '92400000-0000-4000-8000-000000000010',
			pg_temp.pt_id('a1'), v_now)), '42501:permission denied for function qorpera_member_machine_desktop_pointer_begin')));
	perform pg_temp.base_assert(v_differ = '', E'1: answers that differ:\n' || v_differ);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_desktop_pointers), '1: no pass kept for a refusal');
	-- Owners, admins and contributors get one.
	perform pg_temp.base_assert(pg_temp.pt_answer(pg_temp.pt_begin('owner', v_now))
			- 'passId' = '{"schema": "qorpera.member-machine-desktop-pointer/v1", "state": "ok", "seconds": 10}'::jsonb
			and pg_temp.pt_answer(pg_temp.pt_begin('admin', v_now)) ->> 'state' = 'ok'
			and pg_temp.pt_answer(pg_temp.pt_begin('contributor', v_now)) ->> 'state' = 'ok',
		'1: owners, admins and contributors get a pass');
	-- The newest pass replaces the member's last one: one row per member and machine.
	v_first := pg_temp.pt_pass('owner');
	v_second := pg_temp.pt_pass('owner');
	perform pg_temp.base_assert(v_first <> v_second
			and (select count(*) from public.qorpera_company_machine_desktop_pointers where machine_id = pg_temp.pt_id('a1')) = 3
			and pg_temp.pt_auth(v_first) like '42501:%',
		'1: one row per member and machine, the replaced pass gone');
	-- A live private hold, another member's or the caller's own, refuses a shared pass.
	perform pg_temp.pt_take('admin');
	perform pg_temp.base_assert(pg_temp.pt_begin('owner', pg_temp.pt_generation()) = pg_temp.pt_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.pt_begin('admin', pg_temp.pt_generation()) = pg_temp.pt_refused('DESKTOP_MEMBER_IN_CONTROL'),
		'1: a live private hold refuses a shared pass, the holder''s own too');
	perform pg_temp.pt_hand_back('admin');
end $$;

-- 2. The private pass --------------------------------------------------------------------------------------------------------------
do $$
declare v_epoch bigint; v_seat bigint;
begin
	perform pg_temp.base_assert(pg_temp.pt_begin('owner', null, pg_temp.pt_epoch('owner'), pg_temp.pt_generation())
			= pg_temp.pt_refused('DESKTOP_CONTROL_ENDED'), '2: no hold, no private pass');
	perform pg_temp.pt_take('contributor');
	v_epoch := pg_temp.pt_epoch('contributor');
	v_seat := pg_temp.pt_generation();
	perform pg_temp.base_assert(pg_temp.pt_answer(pg_temp.pt_begin('contributor', null, v_epoch, v_seat)) ->> 'state' = 'ok'
			and pg_temp.pt_begin('owner', null, v_epoch, v_seat) = pg_temp.pt_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.pt_begin('contributor', null, v_epoch, v_seat - 1) = pg_temp.pt_refused('DESKTOP_CONTROL_ENDED')
			and pg_temp.pt_begin('contributor', null, v_epoch + 1, v_seat) = pg_temp.pt_refused('DESKTOP_CONTROL_ENDED'),
		'2: the holder''s own hold alone, under its epoch and in its seat');
	perform pg_temp.pt_hand_back('contributor');
end $$;

-- 3. The executor's read ---------------------------------------------------------------------------------------------------------
do $$
declare
	v_pass uuid;
	v jsonb;
	v_epoch bigint;
	v_seat bigint;
	v_used timestamptz;
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '1 hour' where id = pg_temp.pt_id('a1');
	set local session_replication_role = origin;
	v_pass := pg_temp.pt_pass('owner');
	v := pg_temp.pt_answer(pg_temp.pt_auth(v_pass));
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and (v ->> 'served')::boolean
			and v ->> 'placementId' = pg_temp.pt_id('b1')::text and v ->> 'bootId' = pg_temp.pt_id('c1')::text
			and v ->> 'userId' = pg_temp.pt_user('owner')::text and (v ->> 'generation')::bigint = pg_temp.pt_generation()
			and not (v ->> 'private')::boolean and (v ->> 'milliseconds')::integer between 9000 and 10000
			and v ->> 'executorOwner' = 'mx-1238' and v ->> 'providerId' = 'machine-1238',
		'3: served to the machine''s own executor: ' || coalesce(v::text, 'none'));
	v_used := (pg_temp.pt_machine()).last_used_at;
	perform pg_temp.base_assert(v_used > clock_timestamp() - interval '5 seconds', '3: the machine''s last use moved');
	-- Another executor reads it, not served; the last use is not moved again within 30 seconds.
	v := pg_temp.pt_answer(pg_temp.pt_auth(v_pass, 'mx-other', 'machine-other'));
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and not (v ->> 'served')::boolean
			and (pg_temp.pt_machine()).last_used_at = v_used,
		'3: another executor is not served, and the last use moves at most every 30 seconds');
	-- A private hold began: in control while it lasts, held since once given back.
	perform pg_temp.pt_take('admin');
	perform pg_temp.base_assert(pg_temp.pt_auth(v_pass) = pg_temp.pt_auth_refused('DESKTOP_MEMBER_IN_CONTROL'),
		'3: refused while someone types privately');
	perform pg_temp.pt_hand_back('admin');
	perform pg_temp.base_assert(pg_temp.pt_auth(v_pass) = pg_temp.pt_auth_refused('DESKTOP_HELD_SINCE'),
		'3: refused once a private hold began since, given back or not');
	-- A private pass, after its hold ended.
	perform pg_temp.pt_take('contributor');
	v_epoch := pg_temp.pt_epoch('contributor');
	v_seat := pg_temp.pt_generation();
	v_pass := (pg_temp.pt_answer(pg_temp.pt_begin('contributor', null, v_epoch, v_seat)) ->> 'passId')::uuid;
	v := pg_temp.pt_answer(pg_temp.pt_auth(v_pass));
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and (v ->> 'private')::boolean and (v ->> 'generation')::bigint = v_seat,
		'3: the holder''s private pass: ' || coalesce(v::text, 'none'));
	perform pg_temp.pt_hand_back('contributor');
	perform pg_temp.base_assert(pg_temp.pt_auth(v_pass) = pg_temp.pt_auth_refused('DESKTOP_CONTROL_ENDED'),
		'3: a private pass after its hold ended');
	-- Older than 10 seconds.
	v_pass := pg_temp.pt_pass('owner');
	perform pg_temp.pt_age('owner', interval '11 seconds');
	perform pg_temp.base_assert(pg_temp.pt_auth(v_pass) like '42501:%', '3: a pass older than 10 seconds');
	-- A member made a viewer.
	v_pass := pg_temp.pt_pass('admin');
	begin
		set local session_replication_role = replica;
		update public.qorpera_profile_members set role = 'viewer'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.pt_user('admin');
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.pt_auth(v_pass) like '42501:%', '3: a member made a viewer');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The service role alone reads it.
	perform pg_temp.base_assert(pg_temp.pt_as(pg_temp.pt_user('owner'), format(
			'select public.qorpera_member_machine_desktop_pointer_authority(%L, %L, %L)', v_pass, 'mx-1238', 'machine-1238'))
		like '42501:permission denied%', '3: a member may not read it');
end $$;

-- 4. Nothing of an action's ------------------------------------------------------------------------------------------------------
do $$
declare v_before public.qorpera_company_machines%rowtype; v_epoch bigint; v_seat bigint; v_pass uuid;
begin
	perform pg_temp.pt_take('contributor');
	v_before := pg_temp.pt_machine();
	v_epoch := pg_temp.pt_epoch('contributor');
	v_seat := pg_temp.pt_generation();
	v_pass := (pg_temp.pt_answer(pg_temp.pt_begin('contributor', null, v_epoch, v_seat)) ->> 'passId')::uuid;
	perform pg_temp.pt_auth(v_pass);
	perform pg_temp.base_assert((pg_temp.pt_machine()).desktop_member_until = v_before.desktop_member_until
			and (pg_temp.pt_machine()).desktop_member_input_at is not distinct from v_before.desktop_member_input_at
			and (pg_temp.pt_machine()).desktop_shared_at is not distinct from v_before.desktop_shared_at
			and not exists (select 1 from public.qorpera_company_machine_desktop_actions where machine_id = pg_temp.pt_id('a1'))
			and (select folder_unchecked_at from public.qorpera_company_machine_placements where id = pg_temp.pt_id('b1')) is null,
		'4: no action row, no lease renewed, no memberTouched, no disk mark');
	perform pg_temp.pt_hand_back('contributor');
end $$;

-- 5. The window's list: at most 50 others, the most recent first -----------------------------------------------------------------
do $$
declare v jsonb; v_names jsonb;
begin
	set local session_replication_role = replica;
	insert into auth.users(id, email)
	select ('12380000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, format('pt-%s@example.test', n) from generate_series(1, 51) as n;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select '92400000-0000-4000-8000-000000000010', ('12380000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
		format('pt-%s@example.test', n), format('Member %s', n), 'contributor' from generate_series(1, 51) as n;
	-- Member n acted n seconds ago: Member 1 is the most recent, Member 51 the oldest.
	insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, shared, begun_at)
	select pg_catalog.gen_random_uuid(), null, pg_temp.pt_id('a1'), ('12380000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
		'{"type": "click", "x": 1, "y": 1}', 0, true, clock_timestamp() - make_interval(secs => n)
	from generate_series(1, 51) as n;
	set local session_replication_role = origin;
	v := (select m from jsonb_array_elements(pg_temp.pt_answer(pg_temp.pt_as(pg_temp.pt_user('owner'), format(
		'select public.qorpera_list_agent_machines(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000030'))) -> 'machines') as m where m ->> 'machineId' = pg_temp.pt_id('a1')::text);
	v_names := (select jsonb_agg(format('Member %s', n) order by n) from generate_series(1, 50) as n);
	perform pg_temp.base_assert(jsonb_array_length(v -> 'others') = 50 and v -> 'others' = v_names,
		'5: at most 50, the most recent first: ' || coalesce(v -> 'others' ->> 0, 'none') || ' .. '
			|| coalesce(v -> 'others' ->> 49, 'none') || ' of ' || coalesce(jsonb_array_length(v -> 'others')::text, 'none'));
	perform pg_temp.base_assert(v ? 'generation', '5: the list still names the generation (20260930738000)');
end $$;

-- 6. The grants and the markers -----------------------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)', 'execute'),
		'6: members begin a pass, no one else');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)', 'execute'),
		'6: the executor alone reads it');
	perform pg_temp.base_assert(not has_table_privilege('authenticated', 'public.qorpera_company_machine_desktop_pointers', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_machine_desktop_pointers', 'select')
		and not has_table_privilege('anon', 'public.qorpera_company_machine_desktop_pointers', 'select'),
		'6: the passes stay closed');
	perform pg_temp.base_assert(not exists (select 1 from unnest(array[
			'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)',
			'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)',
			'public.qorpera_list_agent_machines(uuid,uuid)']) f(sig)
		where strpos(pg_get_functiondef(f.sig::regprocedure), '20260930744000') = 0), '6: the markers');
end $$;
