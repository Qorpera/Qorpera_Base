-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930714000: a member turns an agent's desktop computer's screen on. On 924's base (an owner, a contributor, a viewer,
-- an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1204, a running machine too
-- small for a desktop, a stopped one, a second running desktop and another company's:
-- 1. the begin: an owner, admin or contributor; a viewer, a stranger, another company's machine refused (42501); a
--    malformed call (22023); the service role may not; stopped (MACHINE_NOT_RUNNING), too small
--    (DESKTOP_MACHINE_TOO_SMALL); the start recorded (id, member, machine, time) and its id answered;
-- 2. what it marks is what an agent's first screen use marks: the machine's last use (at most every 30 seconds) and the
--    screen stamped as the agent the machine was started by, as the agent's own read stamps it; a disk that never had a
--    view marked for a caller without the folder's root (as an agent's action), never for one with it; on a disk that has
--    had a view, MACHINE_NEEDS_COMPANY_VIEW without the root, marking nothing;
-- 3. the floor: a second start of the machine within 5 seconds (any member's) is DESKTOP_START_TOO_SOON; after it, fine;
-- 4. a member's hold (take-over), another member's or the caller's own: `held`, nothing recorded or marked;
-- 5. the executor's read: served once and only by the placement's own executor, within 15 seconds; an old start, a member
--    made a viewer, a machine stopped meanwhile, a hold begun meanwhile (`held`), a root read taken away (it marks then);
-- 6. never refused for an agent's run: neither body reads a run, a receipt or a wake;
-- 7. the machine stays awake under a member: a look's read moves the last use when the member's word stands (an
--    unconfirmed or unserved look does not), and so does a hold's renewed heartbeat (one that renews nothing does not);
-- 8. the grants, the closed table and the marker.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'dc-ack') is not null;

-- The machines, all started by Alice's run, last used an hour ago; the running ones run on their placements (reserved on a
-- node, as an executor's custody leaves them).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12040000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12040000-0000-4000-8000-0000000007e5', '12040000-0000-4000-8000-000000000011', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at)
select machine.id, machine.profile_id, machine.environment_id, machine.name, 'Signs in to the bank.', run.staff_agent_id,
	run.id, machine.receipt_id, run.requested_by_user_id, machine.cpus, machine.memory, 21474836480, 'standard', 'task',
	machine.desired_state, clock_timestamp() - interval '1 hour'
from public.qorpera_execution_runs as run
cross join (values
	-- Alice's desktop, running.
	('12040000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1204', '12040000-0000-4000-8000-0000000008a1'::uuid, 2,
		4294967296::bigint, 'running'),
	-- Running, too small for a desktop.
	('12040000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1204-small', '12040000-0000-4000-8000-0000000008a2', 1, 2147483648, 'running'),
	-- Asleep.
	('12040000-0000-4000-8000-0000000007a3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1204-asleep', '12040000-0000-4000-8000-0000000008a3', 2, 4294967296, 'stopped'),
	-- A second running desktop, which no one takes over.
	('12040000-0000-4000-8000-0000000007a4', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1204-other', '12040000-0000-4000-8000-0000000008a4', 4, 8589934592, 'running'),
	-- Another company's, running.
	('12040000-0000-4000-8000-0000000007a5', '12040000-0000-4000-8000-000000000011', '12040000-0000-4000-8000-0000000007e5',
		'm-1204', '12040000-0000-4000-8000-0000000008a5', 2, 4294967296, 'running')
) as machine(id, profile_id, environment_id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12040000-0000-4000-8000-0000000007b' || n)::uuid, ('12040000-0000-4000-8000-0000000007a' || n)::uuid,
	case when n = 5 then '12040000-0000-4000-8000-000000000011'::uuid else '92400000-0000-4000-8000-000000000010'::uuid end,
	'mx-1204', repeat('8', 64), '{"providerId": "machine-1204"}', repeat(n::text, 64), clock_timestamp(),
	('12040000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 2, 4, 5]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12040000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12040000-0000-4000-8000-0000000007d1', 'machine', 'machine-1204', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12040000-%';
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.dc_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.dc_try(text) to authenticated, service_role;
create function pg_temp.dc_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A call as one member (authenticated), or as the service role.
create function pg_temp.dc_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.dc_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.dc_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.dc_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.dc_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12040000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.dc_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.dc_machine(p_machine text) returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.dc_id(p_machine)
$$;
create function pg_temp.dc_placement(p_machine text) returns public.qorpera_company_machine_placements language sql as $$
	select * from public.qorpera_company_machine_placements where machine_id = pg_temp.dc_id(p_machine)
$$;
-- Moves a machine's columns (as if time passed), without hints.
create function pg_temp.dc_shift(p_machine text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, pg_temp.dc_id(p_machine));
	set local session_replication_role = origin;
end $$;
-- Moves every start of a machine back by that much (as if it passed).
create function pg_temp.dc_age(p_machine text, p_by interval) returns void language plpgsql as $$
begin
	update public.qorpera_company_machine_desktop_starts set begun_at = begun_at - p_by where machine_id = pg_temp.dc_id(p_machine);
end $$;
create function pg_temp.dc_refused(p_schema text, p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', p_schema, 'state', 'refused', 'reason', p_reason)::text
$$;
-- A start begun as a member, of their company's machine unless the test names another company.
create function pg_temp.dc_start(p_who text, p_machine text, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_machine_desktop_start_begin(%L, %L)',
		p_profile, pg_temp.dc_id(p_machine)))
$$;
-- A start's id, the floor stepped over first (each test's own start).
create function pg_temp.dc_start_id(p_who text, p_machine text) returns uuid language plpgsql as $$
declare v text;
begin
	perform pg_temp.dc_age(p_machine, interval '6 seconds');
	v := pg_temp.dc_start(p_who, p_machine);
	if pg_temp.dc_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The start was not begun: %', v; end if;
	return (pg_temp.dc_answer(v) ->> 'startId')::uuid;
end $$;
create function pg_temp.dc_auth(p_start uuid, p_owner text default 'mx-1204', p_provider text default 'machine-1204')
returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_desktop_start_authority(%L, %L, %L)', p_start,
		p_owner, p_provider))
$$;
create function pg_temp.dc_starts(p_machine text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_array(start.user_id, start.served_at is not null) order by start.begun_at), '[]')
	from public.qorpera_company_machine_desktop_starts as start where start.machine_id = pg_temp.dc_id(p_machine)
$$;
-- The agent's look at a machine (the coding executor's read), as the service role.
create function pg_temp.dc_look(p_machine text) returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.dc_id(p_machine))))
$$;
-- A take-over at the member's current epoch, by a press of its own.
create function pg_temp.dc_take(p_who text, p_machine text) returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id(p_machine),
		coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
			where epochs.machine_id = pg_temp.dc_id(p_machine) and epochs.user_id = pg_temp.dc_user(p_who)), 0),
		pg_catalog.gen_random_uuid()))
$$;
-- A member's confirmed or unconfirmed look begun, its use id.
create function pg_temp.dc_use(p_who text, p_machine text, p_confirmed boolean) returns uuid language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set last_look_at = last_look_at - interval '1 second'
	where machine_id = pg_temp.dc_id(p_machine) and user_id = pg_temp.dc_user(p_who);
	set local session_replication_role = origin;
	return (pg_temp.dc_answer(pg_temp.dc_as(pg_temp.dc_user(p_who), format(
		'select public.qorpera_member_machine_screen_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id(p_machine), jsonb_build_object('confirmed', p_confirmed)))) ->> 'useId')::uuid;
end $$;
create function pg_temp.dc_look_auth(p_use uuid, p_owner text default 'mx-1204') returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_screen_authority(%L, %L, %L)', p_use, p_owner,
		'machine-1204'))
$$;
-- The root of the company folder taken away (company_shared revoked): neither the members nor the agent read it.
create function pg_temp.dc_no_root() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
	where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
	set local session_replication_role = origin;
end $$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.dc_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;

-- 1. The begin ------------------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_1x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('a viewer', pg_temp.dc_start('viewer', 'a1'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('a stranger', pg_temp.dc_start('outsider', 'a1'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('another company''s machine', pg_temp.dc_start('owner', 'a5'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('another company', pg_temp.dc_start('owner', 'a5', '12040000-0000-4000-8000-000000000011'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('no machine', pg_temp.dc_as(pg_temp.dc_user('owner'), format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, null)', '92400000-0000-4000-8000-000000000010')),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('the service role', pg_temp.dc_service(format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a1'))), '42501:permission denied for function qorpera_member_machine_desktop_start_begin'),
	jsonb_build_array('asleep', pg_temp.dc_start('owner', 'a3'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'MACHINE_NOT_RUNNING')),
	jsonb_build_array('too small', pg_temp.dc_start('owner', 'a2'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_MACHINE_TOO_SMALL'))
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_1x') = '',
		E'1: starts that differ:\n' || current_setting('qorpera_test.dc_1x'));
	perform pg_temp.base_assert(pg_temp.dc_starts('a1') = '[]' and pg_temp.dc_starts('a2') = '[]'
			and pg_temp.dc_starts('a3') = '[]',
		'1: a refused start records nothing');
end $$;

-- 2. What it marks: what an agent's first screen use marks --------------------------------------------------------------------

-- The contributor starts m-1204's desktop (last used an hour ago, no screen stamped); the agent's own look stamps
-- m-1204-other the same way. The disk never had a view and everyone reads the folder's root: nothing marked.
select set_config('qorpera_test.dc_s21', pg_temp.dc_start('contributor', 'a1'), true);
select set_config('qorpera_test.dc_l21', pg_temp.dc_look('a4'), true);
do $$
declare
	v_start jsonb := pg_temp.dc_answer(current_setting('qorpera_test.dc_s21'));
	v_mine public.qorpera_company_machines := pg_temp.dc_machine('a1');
	v_agents public.qorpera_company_machines := pg_temp.dc_machine('a4');
begin
	perform pg_temp.base_assert(v_start - 'startId' = '{"schema": "qorpera.member-machine-desktop-start/v1", "state": "ok"}'::jsonb
			and pg_temp.dc_starts('a1') = jsonb_build_array(jsonb_build_array(pg_temp.dc_user('contributor'), false))
			and (select start.id from public.qorpera_company_machine_desktop_starts as start
				where start.machine_id = pg_temp.dc_id('a1')) = (v_start ->> 'startId')::uuid,
		'1: an owner, admin or contributor begins the start, recorded and answered by its id: '
			|| current_setting('qorpera_test.dc_s21'));
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_l21')) ->> 'state' = 'authorized',
		'2: the agent''s look: ' || current_setting('qorpera_test.dc_l21'));
	perform pg_temp.base_assert(v_mine.last_used_at > clock_timestamp() - interval '5 seconds'
			and v_agents.last_used_at > clock_timestamp() - interval '5 seconds'
			and v_mine.screen_staff_agent_id = v_mine.started_by_staff_agent_id
			and v_agents.screen_staff_agent_id = v_agents.started_by_staff_agent_id
			and v_mine.screen_used_at > clock_timestamp() - interval '5 seconds' and v_agents.screen_used_at is not null,
		'2: the last use moved and the screen stamped as the agent''s, as the agent''s own read does: '
			|| row_to_json(v_mine)::text);
	perform pg_temp.base_assert((pg_temp.dc_placement('a1')).folder_unchecked_at is null,
		'2: a caller with the folder''s root marks no disk');
end $$;
-- At most every 30 seconds, as the agent's read.
do $$
declare v_at timestamptz;
begin
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''10 seconds''');
	v_at := (pg_temp.dc_machine('a1')).last_used_at;
	perform pg_temp.dc_start_id('admin', 'a1');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).last_used_at = v_at, '2: within 30 seconds the last use stays');
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''31 seconds''');
	v_at := (pg_temp.dc_machine('a1')).last_used_at;
	perform pg_temp.dc_start_id('owner', 'a1');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).last_used_at > v_at + interval '30 seconds',
		'2: after 30 seconds it moves');
end $$;
-- Without the root: a disk that never had a view is marked (as an agent's action marks it); one that has had a view is
-- refused, and nothing is marked or recorded (undone after).
do $$
begin
	perform pg_temp.dc_no_root();
	perform pg_temp.dc_start_id('contributor', 'a4');
	perform pg_temp.base_assert((pg_temp.dc_placement('a4')).folder_unchecked_at is not null,
		'2: without the root, a disk that never had a view is marked');
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.dc_view', public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020',
	'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', pg_temp.dc_id('a4'),
		'placementId', pg_temp.dc_id('b4'), 'bootId', pg_temp.dc_id('c4')))::text, true);
do $$
declare v text; v_starts jsonb;
begin
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views where placement_id = pg_temp.dc_id('b4')),
		'2: a view is open on m-1204-other''s disk: ' || current_setting('qorpera_test.dc_view'));
	perform pg_temp.dc_age('a4', interval '6 seconds');
	begin
		perform pg_temp.dc_no_root();
		v_starts := pg_temp.dc_starts('a4');
		v := pg_temp.dc_start('contributor', 'a4');
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'MACHINE_NEEDS_COMPANY_VIEW')
				and pg_temp.dc_starts('a4') = v_starts and (pg_temp.dc_placement('a4')).folder_unchecked_at is null,
			'2: on a disk that has had a view, without the root: refused, nothing recorded or marked: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_start('contributor', 'a4')) ->> 'state' = 'ok',
		'2: with the root, a disk that has had a view starts');
end $$;

-- 3. The floor ------------------------------------------------------------------------------------------------------------------

do $$
declare v text;
begin
	perform pg_temp.dc_start_id('contributor', 'a1');
	v := pg_temp.dc_start('owner', 'a1');
	perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_START_TOO_SOON'),
		'3: a second start within 5 seconds, any member''s: ' || v);
	perform pg_temp.dc_age('a1', interval '6 seconds');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_start('owner', 'a1')) ->> 'state' = 'ok', '3: after 5 seconds');
end $$;

-- 4. A member's hold ------------------------------------------------------------------------------------------------------------

do $$
declare v text; v_starts jsonb; v_before public.qorpera_company_machines;
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('admin', 'a1')) ->> 'state' = 'ok', '4: the admin takes over');
	perform pg_temp.dc_age('a1', interval '6 seconds');
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''1 hour'', screen_used_at = null');
	v_starts := pg_temp.dc_starts('a1');
	v_before := pg_temp.dc_machine('a1');
	v := pg_temp.dc_start('contributor', 'a1');
	perform pg_temp.base_assert(v = 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1',
				'state', 'held')::text
			and pg_temp.dc_starts('a1') = v_starts and (pg_temp.dc_machine('a1')).last_used_at = v_before.last_used_at
			and (pg_temp.dc_machine('a1')).screen_used_at is null,
		'4: another member holds it: it runs; held, nothing recorded or marked: ' || v);
	v := pg_temp.dc_start('admin', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'held' and pg_temp.dc_starts('a1') = v_starts,
		'4: so for the holder: ' || v);
	perform pg_temp.dc_shift('a1', 'desktop_member_until = clock_timestamp() - interval ''1 second''');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_start('contributor', 'a1')) ->> 'state' = 'ok',
		'4: once the lease ran out, the start goes');
end $$;

-- 5. The executor's read --------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_s51', pg_temp.dc_start_id('contributor', 'a1')::text, true);
select set_config('qorpera_test.dc_r51', pg_temp.dc_auth(current_setting('qorpera_test.dc_s51')::uuid, 'mx-node-1'), true);
select set_config('qorpera_test.dc_r52', pg_temp.dc_auth(current_setting('qorpera_test.dc_s51')::uuid), true);
select set_config('qorpera_test.dc_r53', pg_temp.dc_auth(current_setting('qorpera_test.dc_s51')::uuid), true);
do $$
declare v_where jsonb := jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1',
	'state', 'authorized', 'startId', current_setting('qorpera_test.dc_s51'), 'machineId', pg_temp.dc_id('a1'),
	'placementId', pg_temp.dc_id('b1'), 'bootId', pg_temp.dc_id('c1'), 'executorOwner', 'mx-1204',
	'providerId', 'machine-1204', 'userId', pg_temp.dc_user('contributor'), 'held', false);
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_r51')) = v_where || '{"served": false}',
		'5: another executor reads where it runs and serves nothing: ' || current_setting('qorpera_test.dc_r51'));
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_r52')) = v_where || '{"served": true}',
		'5: the machine''s own executor serves it: ' || current_setting('qorpera_test.dc_r52'));
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_r53') = '42501:Machine desktop start is unavailable',
		'5: once: ' || current_setting('qorpera_test.dc_r53'));
end $$;
do $$
declare v_start uuid; v text;
begin
	-- Older than 15 seconds.
	v_start := pg_temp.dc_start_id('contributor', 'a1');
	update public.qorpera_company_machine_desktop_starts set begun_at = begun_at - interval '16 seconds' where id = v_start;
	perform pg_temp.base_assert(pg_temp.dc_auth(v_start) = '42501:Machine desktop start is unavailable', '5: an old start');
	v_start := pg_temp.dc_start_id('contributor', 'a1');
	-- Its member made a viewer meanwhile (each case undone after).
	begin
		update public.qorpera_profile_members set role = 'viewer'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.dc_user('contributor');
		perform pg_temp.base_assert(pg_temp.dc_auth(v_start) = '42501:Machine desktop start is unavailable',
			'5: a member made a viewer');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The machine stopped meanwhile.
	begin
		perform pg_temp.dc_shift('a1', 'desired_state = ''stopped''');
		perform pg_temp.base_assert(pg_temp.dc_auth(v_start)
				= pg_temp.dc_refused('qorpera.member-machine-desktop-start-authority/v1', 'MACHINE_NOT_RUNNING'),
			'5: a machine stopped meanwhile');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- A hold begun meanwhile: held, served, and nothing to run.
	begin
		perform pg_temp.dc_take('owner', 'a1');
		v := pg_temp.dc_auth(v_start);
		perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'authorized'
				and (pg_temp.dc_answer(v) ->> 'held')::boolean and (pg_temp.dc_answer(v) ->> 'served')::boolean,
			'5: a hold begun meanwhile: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- A root read taken away since the begin: the disk that never had a view is marked as the start runs.
	begin
		perform pg_temp.dc_no_root();
		perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_auth(v_start)) ->> 'state' = 'authorized'
				and (pg_temp.dc_placement('a1')).folder_unchecked_at is not null,
			'5: the root taken away since the begin: the start runs and marks the disk');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- Malformed, unknown, and the member's own call.
	perform pg_temp.base_assert(pg_temp.dc_auth(v_start, 'mx 1204') = '22023:Machine desktop request is malformed'
			and pg_temp.dc_auth(null) = '22023:Machine desktop request is malformed'
			and pg_temp.dc_auth(pg_catalog.gen_random_uuid()) = '42501:Machine desktop start is unavailable'
			and pg_temp.dc_as(pg_temp.dc_user('owner'), format(
				'select public.qorpera_member_machine_desktop_start_authority(%L, %L, %L)', v_start, 'mx-1204', 'machine-1204'))
				= '42501:permission denied for function qorpera_member_machine_desktop_start_authority',
		'5: malformed, unknown, and the member''s own call');
end $$;

-- 6. Never refused for an agent's run ---------------------------------------------------------------------------------------

-- The start reads no run at all: neither body names a run, a run's receipt or the agent's wake; the starts above went with
-- Alice's run live, and nothing in them could change without one.
do $$
begin
	perform pg_temp.base_assert(strpos(prosrc, 'qorpera_execution_runs') = 0 and strpos(prosrc, 'receipt') = 0
			and strpos(prosrc, 'wake') = 0, '6: ' || proname || ' reads no run')
	from pg_proc where oid in ('public.qorpera_member_machine_desktop_start_begin(uuid,uuid)'::regprocedure,
		'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)'::regprocedure);
end $$;

-- 7. The machine stays awake under a member who watches or holds it -------------------------------------------------------------

do $$
declare v_use uuid; v_at timestamptz; v text;
begin
	-- A look the member confirmed: another executor's read moves nothing; the machine's own executor's read moves it.
	perform pg_temp.dc_shift('a4', 'last_used_at = clock_timestamp() - interval ''1 hour''');
	v_at := (pg_temp.dc_machine('a4')).last_used_at;
	v_use := pg_temp.dc_use('viewer', 'a4', true);
	perform pg_temp.dc_look_auth(v_use, 'mx-node-1');
	perform pg_temp.base_assert((pg_temp.dc_machine('a4')).last_used_at = v_at, '7: another executor''s read moves nothing');
	v_use := pg_temp.dc_use('viewer', 'a4', false);
	v := pg_temp.dc_look_auth(v_use);
	perform pg_temp.base_assert((pg_temp.dc_answer(v) ->> 'keepDesktop')::boolean
			and (pg_temp.dc_machine('a4')).last_used_at > v_at + interval '30 seconds',
		'7: a served look while the member''s word of the last 30 minutes stands moves the last use: ' || v);
	-- Without the member's word in the last 30 minutes (the window paused): nothing moves.
	perform pg_temp.dc_shift('a4', 'last_used_at = clock_timestamp() - interval ''1 hour''');
	update public.qorpera_company_machine_screen_watches set confirmed_at = clock_timestamp() - interval '31 minutes'
	where machine_id = pg_temp.dc_id('a4') and user_id = pg_temp.dc_user('viewer');
	v_at := (pg_temp.dc_machine('a4')).last_used_at;
	v := pg_temp.dc_look_auth(pg_temp.dc_use('viewer', 'a4', false));
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'authorized'
			and not (pg_temp.dc_answer(v) ->> 'keepDesktop')::boolean and (pg_temp.dc_machine('a4')).last_used_at = v_at,
		'7: a look without the member''s word moves nothing: ' || v);
	-- A hold's renewed heartbeat moves it (the take-over itself moves it too, 20260930713000).
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a4')) ->> 'state' = 'ok', '7: taken over');
	perform pg_temp.dc_shift('a4', 'last_used_at = clock_timestamp() - interval ''1 hour''');
	v_at := (pg_temp.dc_machine('a4')).last_used_at;
	v := pg_temp.dc_as(pg_temp.dc_user('contributor'), format(
		'select public.qorpera_member_keep_machine_desktop(%L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a4'), (pg_temp.dc_machine('a4')).desktop_member_epoch,
		(pg_temp.dc_machine('a4')).desktop_member_generation));
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok'
			and (pg_temp.dc_machine('a4')).last_used_at > v_at + interval '30 seconds',
		'7: a hold''s renewed heartbeat moves the last use: ' || v);
	-- One that renews nothing moves nothing.
	perform pg_temp.dc_shift('a4', 'last_used_at = clock_timestamp() - interval ''1 hour''');
	v_at := (pg_temp.dc_machine('a4')).last_used_at;
	v := pg_temp.dc_as(pg_temp.dc_user('contributor'), format(
		'select public.qorpera_member_keep_machine_desktop(%L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a4'), (pg_temp.dc_machine('a4')).desktop_member_epoch, 0));
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ended' and (pg_temp.dc_machine('a4')).last_used_at = v_at,
		'7: a heartbeat of another seat moves nothing: ' || v);
end $$;

-- 8. Grants, the closed table and the marker ----------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_member_machine_desktop_start_begin(uuid,uuid)',
				'execute') = (v_role = 'authenticated')
			and has_function_privilege(v_role, 'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)', 'execute')
				= (v_role = 'service_role'),
			'8: the begin is a member''s, the read the service role''s: ' || v_role);
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_machine_desktop_starts',
				'select, insert, update, delete'),
			'8: the starts are closed to ' || v_role);
	end loop;
	perform pg_temp.base_assert((select relrowsecurity from pg_class
			where oid = 'public.qorpera_company_machine_desktop_starts'::regclass),
		'8: row level security on the starts');
	perform pg_temp.base_assert((select array_agg(proname::text order by proname) from pg_proc
			where pronamespace = 'public'::regnamespace and strpos(prosrc, '20260930714000') > 0)
		= array['qorpera_member_keep_machine_desktop', 'qorpera_member_machine_desktop_start_authority',
			'qorpera_member_machine_desktop_start_begin', 'qorpera_member_machine_screen_authority'],
		'8: the bodies that name 20260930714000: ' || (select array_agg(proname::text order by proname)::text from pg_proc
			where pronamespace = 'public'::regnamespace and strpos(prosrc, '20260930714000') > 0));
end $$;
