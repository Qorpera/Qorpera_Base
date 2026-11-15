-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930712000: a member watches an agent's desktop computer in the web's computer window. On 924's base (an owner, a
-- contributor, a viewer, an admin and an outsider; agents Alice, Bob and Carol; Alice's live run), with machines of
-- Alice's and Bob's in several states and another company's machine:
-- 1. the list of an agent's machines: the agent's own and the ones it drove, at most 20, running first, then by its last
--    drive, then the newest; only the fields the window needs (no node, placement, boot or command); viewers read it and
--    may not wake; a stranger and another company's agent are refused;
-- 2. a look begun as the member: the use id and nothing else; a stopped or waiting machine (MACHINE_NOT_RUNNING); a
--    removed one, another company's, a stranger (42501); a malformed watch (22023); one look per 400 ms
--    (SCREEN_TOO_SOON); the machine's last use never moves;
-- 3. the executor's read: served once and only by the placement's own executor, within 15 seconds; a replaced, served or
--    old use, a member who left, refused; a machine stopped meanwhile answers MACHINE_NOT_RUNNING; keepDesktop from the
--    member's word within 30 minutes; the served read of a look the member confirmed in the last 30 minutes moves the
--    machine's last use (20260930714000), no other read does;
-- 4. the disk's rule for members: on a disk that has had a view, a member who does not read the root sees no screen;
-- 5. the member's read check after the boundary: nothing to check without a view; every read the newest view holds must
--    be the member's to read (detail qorpera.test-machine/member-unreadable), and a refusal marks neither the placement
--    nor its boot; a boot that is not current and a member who left are refused;
-- 6. the agent's screen read stamps who drives the screen, when the agent changes and at most every 30 seconds;
-- 7. the `machines` hint: on the listed changes, to every member, once per transaction; never on the last use alone, a
--    busy check-in or a screen use within 10 minutes; never for a company being deleted;
-- 8. the grants and the marker.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'mm-ack') is not null;

-- The machines (all made by Alice's run's rows; their starting agent set per machine), and where the running ones run.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12020000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12020000-0000-4000-8000-0000000007e8', '12020000-0000-4000-8000-000000000011', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at, removed_at, created_at, screen_staff_agent_id, screen_used_at)
select machine.id, machine.profile_id, machine.environment_id, machine.name, 'Tests the app.', machine.agent, run.id,
	machine.receipt_id, run.requested_by_user_id, machine.cpus, machine.memory, 21474836480, 'standard', 'task',
	machine.desired_state, clock_timestamp() - interval '1 hour', machine.removed_at,
	clock_timestamp() - machine.age, machine.screen_agent, clock_timestamp() - machine.screen_age
from public.qorpera_execution_runs as run
cross join (values
	-- Alice's desktop, running, which she drove 5 minutes ago.
	('12020000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1202', '92400000-0000-4000-8000-000000000030'::uuid,
		'12020000-0000-4000-8000-0000000008a1'::uuid, 2, 4294967296::bigint, 'running', null::timestamptz, interval '3 hours',
		'92400000-0000-4000-8000-000000000030'::uuid, interval '5 minutes'),
	-- Alice's, asleep.
	('12020000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-asleep', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a2', 2, 4294967296,
		'stopped', null, interval '2 hours', null, null),
	-- Alice's, running, too small for a desktop, her newest.
	('12020000-0000-4000-8000-0000000007a3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-small', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a3', 1, 2147483648,
		'running', null, interval '10 minutes', null, null),
	-- Bob's, running, whose screen Alice drove a minute ago.
	('12020000-0000-4000-8000-0000000007a4', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-bob', '92400000-0000-4000-8000-000000000031', '12020000-0000-4000-8000-0000000008a4', 4, 8589934592,
		'running', null, interval '4 hours', '92400000-0000-4000-8000-000000000030', interval '1 minute'),
	-- Bob's own, running.
	('12020000-0000-4000-8000-0000000007a5', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-bob-only', '92400000-0000-4000-8000-000000000031', '12020000-0000-4000-8000-0000000008a5', 2, 4294967296,
		'running', null, interval '5 hours', null, null),
	-- Alice's, removed, and Alice's, being deleted.
	('12020000-0000-4000-8000-0000000007a6', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-gone', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a6', 2, 4294967296,
		'deleted', clock_timestamp(), interval '6 hours', null, null),
	('12020000-0000-4000-8000-0000000007a7', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-deleting', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a7', 2, 4294967296,
		'deleted', null, interval '7 hours', null, null),
	-- Another company's, running, of the same name.
	('12020000-0000-4000-8000-0000000007a8', '12020000-0000-4000-8000-000000000011', '12020000-0000-4000-8000-0000000007e8',
		'm-1202', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a8', 2, 4294967296,
		'running', null, interval '1 hour', null, null),
	-- Alice's, wanting to run with no room yet (no placement).
	('12020000-0000-4000-8000-0000000007a9', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1202-waiting', '92400000-0000-4000-8000-000000000030', '12020000-0000-4000-8000-0000000008a9', 2, 4294967296,
		'running', null, interval '30 minutes', null, null)
) as machine(id, profile_id, environment_id, name, agent, receipt_id, cpus, memory, desired_state, removed_at, age,
	screen_agent, screen_age)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
-- Carol has 22 machines asleep: her list stops at 20.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state)
select ('12020000-0000-4000-8000-0000000009' || lpad(n::text, 2, '0'))::uuid, run.profile_id, run.environment_id,
	'm-1202-carol-' || n, 'Tests the app.', '92400000-0000-4000-8000-000000000032', run.id,
	('12020000-0000-4000-8000-0000000006' || lpad(n::text, 2, '0'))::uuid, run.requested_by_user_id, 2, 4294967296,
	21474836480, 'standard', 'task', 'stopped'
from public.qorpera_execution_runs as run, generate_series(1, 22) as n
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12020000-0000-4000-8000-0000000007b' || n)::uuid, ('12020000-0000-4000-8000-0000000007a' || n)::uuid,
	case when n = 8 then '12020000-0000-4000-8000-000000000011'::uuid else '92400000-0000-4000-8000-000000000010'::uuid end,
	'mx-1202', repeat('8', 64), '{"providerId": "machine-1202"}', repeat(n::text, 64), clock_timestamp(),
	('12020000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 3, 4, 5, 8]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12020000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12020000-0000-4000-8000-0000000007d1', 'machine', 'machine-1202', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12020000-%';
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>', and with `p_detail` its detail too.
create function pg_temp.mm_try(p_sql text, p_detail boolean default false) returns text language plpgsql as $$
declare v jsonb; v_detail text;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	get stacked diagnostics v_detail = pg_exception_detail;
	return sqlstate || ':' || sqlerrm || case when p_detail then '|' || coalesce(v_detail, '') else '' end;
end $$;
grant execute on function pg_temp.mm_try(text, boolean) to authenticated, service_role;
create function pg_temp.mm_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A call as one member (authenticated), or as the service role.
create function pg_temp.mm_as(p_user uuid, p_sql text, p_detail boolean default false) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.mm_try(p_sql, p_detail);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.mm_service(p_sql text, p_detail boolean default false) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.mm_try(p_sql, p_detail);
	reset role;
	return v;
end $$;
create function pg_temp.mm_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12020000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
-- The members: owner, contributor, viewer, admin, outsider.
create function pg_temp.mm_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.mm_list(p_who text, p_agent uuid) returns text language sql as $$
	select pg_temp.mm_as(pg_temp.mm_user(p_who), format('select public.qorpera_list_agent_machines(%L, %L)',
		'92400000-0000-4000-8000-000000000010', p_agent))
$$;
create function pg_temp.mm_begin(p_who text, p_machine text, p_watch jsonb default '{"confirmed": true}',
	p_profile uuid default '92400000-0000-4000-8000-000000000010') returns text language sql as $$
	select pg_temp.mm_as(pg_temp.mm_user(p_who), format('select public.qorpera_member_machine_screen_begin(%L, %L, %L)',
		p_profile, pg_temp.mm_id(p_machine), p_watch))
$$;
-- A look begun as a member, its use id (or null), with the last look put back a second so the throttle lets it in.
create function pg_temp.mm_use(p_who text, p_machine text, p_watch jsonb default '{"confirmed": true}') returns uuid
language plpgsql as $$
declare v text;
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set last_look_at = last_look_at - interval '1 second'
	where machine_id = pg_temp.mm_id(p_machine) and user_id = pg_temp.mm_user(p_who);
	set local session_replication_role = origin;
	v := pg_temp.mm_begin(p_who, p_machine, p_watch);
	if pg_temp.mm_answer(v) ->> 'state' is distinct from 'ok' then
		raise exception 'The look was not begun: %', v; end if;
	return (pg_temp.mm_answer(v) ->> 'useId')::uuid;
end $$;
create function pg_temp.mm_auth(p_use uuid, p_owner text default 'mx-1202', p_provider text default 'machine-1202')
returns text language sql as $$
	select pg_temp.mm_service(format('select public.qorpera_member_machine_screen_authority(%L, %L, %L)', p_use, p_owner,
		p_provider))
$$;
create function pg_temp.mm_reads(p_placement text, p_boot text, p_user uuid) returns text language sql as $$
	select pg_temp.mm_service(format('select public.qorpera_folder_member_machine_reads(%L, %L, %L)',
		pg_temp.mm_id(p_placement), pg_temp.mm_id(p_boot), p_user), true)
$$;
create function pg_temp.mm_watch(p_who text, p_machine text) returns public.qorpera_company_machine_screen_watches
language sql as $$
	select * from public.qorpera_company_machine_screen_watches
	where machine_id = pg_temp.mm_id(p_machine) and user_id = pg_temp.mm_user(p_who)
$$;
create function pg_temp.mm_used(p_machine text) returns timestamptz language sql as $$
	select last_used_at from public.qorpera_company_machines where id = pg_temp.mm_id(p_machine)
$$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.mm_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;

-- 1. An agent's machines -----------------------------------------------------------------------------------------------------

do $$
declare
	v_alice jsonb := pg_temp.mm_answer(pg_temp.mm_list('viewer', '92400000-0000-4000-8000-000000000030'));
	v_bob jsonb := pg_temp.mm_answer(pg_temp.mm_list('contributor', '92400000-0000-4000-8000-000000000031'));
	v_carol jsonb := pg_temp.mm_answer(pg_temp.mm_list('owner', '92400000-0000-4000-8000-000000000032'));
	v_first jsonb;
begin
	perform pg_temp.base_assert(v_alice - 'machines' = jsonb_build_object('schema', 'qorpera.agent-machines/v1',
			'profileId', '92400000-0000-4000-8000-000000000010', 'staffAgentId', '92400000-0000-4000-8000-000000000030',
			'canWake', false, 'canTakeOver', false),
		'1: a viewer reads Alice''s machines and may not wake one (nor take one over, 20260930713000): ' || coalesce(v_alice::text, 'null'));
	-- Running first; among them the one she drove last, then the other she drove, then the newest; then the rest, newest
	-- first. Bob's own machine, the removed one and the one being deleted are not hers to show.
	perform pg_temp.base_assert((select array_agg(m ->> 'name' order by n) from jsonb_array_elements(v_alice -> 'machines')
			with ordinality as listed(m, n)) = array['m-1202-bob', 'm-1202', 'm-1202-small', 'm-1202-waiting', 'm-1202-asleep'],
		'1: Alice''s machines in order: ' || (v_alice -> 'machines')::text);
	v_first := v_alice -> 'machines' -> 0;
	perform pg_temp.base_assert(v_first - 'screenUsedAt' = jsonb_build_object('machineId', pg_temp.mm_id('a4'),
			'name', 'm-1202-bob', 'purpose', 'Tests the app.', 'state', 'running', 'lifetime', 'task', 'desktopCapable', true,
			'startedByAgent', false, 'screenAgentName', 'Alice', 'control', null, 'waitingFor', null,
			-- 20260930713000: the caller's own hand-back epoch for the machine (0: never handed back).
			'epoch', 0,
			-- 20260930759000: awake only for a member, its seconds; null for this one, which an agent started.
			'memberSleepSeconds', null)
			and (v_first ->> 'screenUsedAt')::timestamptz > clock_timestamp() - interval '2 minutes',
		'1: one machine, only what the window needs: ' || v_first::text);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_alice -> 'machines') m
			where m ?| array['node', 'placementId', 'bootId', 'executorOwner', 'providerId', 'commands', 'owner']),
		'1: no node, placement, boot, executor or command');
	perform pg_temp.base_assert((select jsonb_object_agg(m ->> 'name', jsonb_build_array(m -> 'state', m -> 'desktopCapable',
			m -> 'startedByAgent', m -> 'waitingFor')) from jsonb_array_elements(v_alice -> 'machines') m)
			= '{"m-1202": ["running", true, true, null], "m-1202-bob": ["running", true, false, null],
				"m-1202-small": ["running", false, true, null], "m-1202-asleep": ["stopped", true, true, null],
				"m-1202-waiting": ["waiting", true, true, "room"]}'::jsonb,
		'1: states, desktops, who started each, why one waits: ' || (v_alice -> 'machines')::text);
	perform pg_temp.base_assert((v_bob ->> 'canWake')::boolean and (select array_agg(m ->> 'name' order by n)
			from jsonb_array_elements(v_bob -> 'machines') with ordinality as listed(m, n)) = array['m-1202-bob', 'm-1202-bob-only'],
		'1: a contributor reads Bob''s, and may wake one: ' || coalesce(v_bob::text, 'null'));
	perform pg_temp.base_assert((v_carol ->> 'canWake')::boolean and jsonb_array_length(v_carol -> 'machines') = 20
			and v_carol -> 'machines' -> 0 ->> 'name' like 'm-1202-carol-%',
		'1: Carol''s list stops at 20: ' || jsonb_array_length(v_carol -> 'machines'));
end $$;

select set_config('qorpera_test.mm_1x', pg_temp.mm_differ(jsonb_build_array(
	jsonb_build_array('a stranger', pg_temp.mm_list('outsider', '92400000-0000-4000-8000-000000000030'),
		'42501:Company is unavailable'),
	jsonb_build_array('another company''s agent', pg_temp.mm_list('owner', '12020000-0000-4000-8000-0000000000ff'),
		'42501:Agent is unavailable'),
	jsonb_build_array('no agent', pg_temp.mm_as(pg_temp.mm_user('owner'), format('select public.qorpera_list_agent_machines(%L, null)',
		'92400000-0000-4000-8000-000000000010')), '42501:Company is unavailable'),
	jsonb_build_array('another company', pg_temp.mm_as(pg_temp.mm_user('owner'), format(
		'select public.qorpera_list_agent_machines(%L, %L)', '12020000-0000-4000-8000-000000000011',
		'92400000-0000-4000-8000-000000000030')), '42501:Company is unavailable')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_1x') = '',
		E'1: lists that differ:\n' || current_setting('qorpera_test.mm_1x'));
end $$;

-- 2. A look, begun as the member ---------------------------------------------------------------------------------------------

select set_config('qorpera_test.mm_used0', pg_temp.mm_used('a1')::text, true);
select set_config('qorpera_test.mm_b1', pg_temp.mm_begin('viewer', 'a1'), true);
select set_config('qorpera_test.mm_b2', pg_temp.mm_begin('viewer', 'a1'), true);
do $$
declare v_watch public.qorpera_company_machine_screen_watches := pg_temp.mm_watch('viewer', 'a1');
begin
	perform pg_temp.base_assert(pg_temp.mm_answer(current_setting('qorpera_test.mm_b1')) - 'useId'
			= '{"schema": "qorpera.member-machine-screen/v1", "state": "ok"}'::jsonb
			and v_watch.use_id = (pg_temp.mm_answer(current_setting('qorpera_test.mm_b1')) ->> 'useId')::uuid,
		'2: a viewer''s look: its use id and nothing else: ' || current_setting('qorpera_test.mm_b1'));
	perform pg_temp.base_assert(v_watch.looks = 1 and v_watch.confirmed_at is not null and v_watch.use_served_at is null
			and v_watch.profile_id = '92400000-0000-4000-8000-000000000010',
		'2: the look is recorded: ' || row_to_json(v_watch)::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_b2') = 'ok:' || jsonb_build_object('schema',
			'qorpera.member-machine-screen/v1', 'state', 'refused', 'reason', 'SCREEN_TOO_SOON')::text
			and pg_temp.mm_watch('viewer', 'a1') = v_watch,
		'2: a second look within 400 ms is refused and counts nothing: ' || current_setting('qorpera_test.mm_b2'));
end $$;
-- After 400 ms it is let in: a new use id, the count up.
select set_config('qorpera_test.mm_u3', pg_temp.mm_use('viewer', 'a1', '{"confirmed": false}')::text, true);
do $$
declare v_watch public.qorpera_company_machine_screen_watches := pg_temp.mm_watch('viewer', 'a1');
begin
	perform pg_temp.base_assert(v_watch.looks = 2 and v_watch.use_id = current_setting('qorpera_test.mm_u3')::uuid
			and v_watch.use_id <> (pg_temp.mm_answer(current_setting('qorpera_test.mm_b1')) ->> 'useId')::uuid
			and v_watch.confirmed_at is not null,
		'2: a later look, unconfirmed, keeps the earlier word: ' || row_to_json(v_watch)::text);
	perform pg_temp.base_assert(pg_temp.mm_used('a1')::text = current_setting('qorpera_test.mm_used0'),
		'2: a member''s look never moves the machine''s last use');
end $$;

select set_config('qorpera_test.mm_2x', pg_temp.mm_differ(jsonb_build_array(
	jsonb_build_array('asleep', pg_temp.mm_begin('viewer', 'a2'),
		'ok:{"state": "refused", "reason": "MACHINE_NOT_RUNNING", "schema": "qorpera.member-machine-screen/v1"}'),
	jsonb_build_array('waiting', pg_temp.mm_begin('viewer', 'a9'),
		'ok:{"state": "refused", "reason": "MACHINE_NOT_RUNNING", "schema": "qorpera.member-machine-screen/v1"}'),
	jsonb_build_array('removed', pg_temp.mm_begin('viewer', 'a6'), '42501:Machine screen is unavailable'),
	jsonb_build_array('another company''s machine', pg_temp.mm_begin('viewer', 'a8'), '42501:Machine screen is unavailable'),
	jsonb_build_array('another company', pg_temp.mm_begin('owner', 'a8', '{"confirmed": true}',
		'12020000-0000-4000-8000-000000000011'), '42501:Machine screen is unavailable'),
	jsonb_build_array('a stranger', pg_temp.mm_begin('outsider', 'a1'), '42501:Machine screen is unavailable'),
	jsonb_build_array('watch: empty', pg_temp.mm_begin('viewer', 'a4', '{}'), '22023:Machine screen request is malformed'),
	jsonb_build_array('watch: a word', pg_temp.mm_begin('viewer', 'a4', '{"confirmed": "yes"}'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('watch: more', pg_temp.mm_begin('viewer', 'a4', '{"confirmed": true, "keep": true}'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('watch: an array', pg_temp.mm_begin('viewer', 'a4', '[]'), '22023:Machine screen request is malformed'),
	jsonb_build_array('watch: a number', pg_temp.mm_begin('viewer', 'a4', '1'), '22023:Machine screen request is malformed'),
	jsonb_build_array('watch: none', pg_temp.mm_begin('viewer', 'a4', null), '22023:Machine screen request is malformed'),
	jsonb_build_array('the service role', pg_temp.mm_service(format(
		'select public.qorpera_member_machine_screen_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.mm_id('a1'), '{"confirmed": true}')), '42501:permission denied for function qorpera_member_machine_screen_begin')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_2x') = '',
		E'2: looks that differ:\n' || current_setting('qorpera_test.mm_2x'));
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_screen_watches
			where machine_id in (pg_temp.mm_id('a2'), pg_temp.mm_id('a9'), pg_temp.mm_id('a6'), pg_temp.mm_id('a8'))
				or user_id = pg_temp.mm_user('outsider')),
		'2: a refused look records nothing');
end $$;

-- 3. The executor's read -----------------------------------------------------------------------------------------------------

select set_config('qorpera_test.mm_used3', pg_temp.mm_used('a1')::text, true);
select set_config('qorpera_test.mm_u31', pg_temp.mm_use('viewer', 'a1')::text, true);
-- The executor that forwards it (another owner) reads where it runs, without serving it; the machine's own serves it once.
select set_config('qorpera_test.mm_a31', pg_temp.mm_auth(current_setting('qorpera_test.mm_u31')::uuid, 'mx-node-1'), true);
select set_config('qorpera_test.mm_a32', pg_temp.mm_auth(current_setting('qorpera_test.mm_u31')::uuid,
	'mx-1202', 'machine-other'), true);
select set_config('qorpera_test.mm_w31', row_to_json(pg_temp.mm_watch('viewer', 'a1'))::text, true);
select set_config('qorpera_test.mm_a33', pg_temp.mm_auth(current_setting('qorpera_test.mm_u31')::uuid), true);
select set_config('qorpera_test.mm_w33', row_to_json(pg_temp.mm_watch('viewer', 'a1'))::text, true);
select set_config('qorpera_test.mm_a34', pg_temp.mm_auth(current_setting('qorpera_test.mm_u31')::uuid), true);
do $$
declare v_where jsonb := jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'authorized',
	'useId', current_setting('qorpera_test.mm_u31'), 'machineId', pg_temp.mm_id('a1'), 'placementId', pg_temp.mm_id('b1'),
	'bootId', pg_temp.mm_id('c1'), 'executorOwner', 'mx-1202', 'providerId', 'machine-1202',
	'userId', pg_temp.mm_user('viewer'), 'keepDesktop', true,
	-- The lease generation the read saw (20260930713000): no member ever took m-1202 over.
	'desktopGeneration', 0);
begin
	perform pg_temp.base_assert(pg_temp.mm_answer(current_setting('qorpera_test.mm_a31')) = v_where || '{"served": false}'
			and pg_temp.mm_answer(current_setting('qorpera_test.mm_a32')) = v_where || '{"served": false}'
			and current_setting('qorpera_test.mm_w31')::jsonb ->> 'use_served_at' is null,
		'3: another executor reads where it runs and serves nothing: ' || current_setting('qorpera_test.mm_a31')
			|| ' / ' || current_setting('qorpera_test.mm_a32'));
	perform pg_temp.base_assert(pg_temp.mm_answer(current_setting('qorpera_test.mm_a33')) = v_where || '{"served": true}'
			and current_setting('qorpera_test.mm_w33')::jsonb ->> 'use_served_at' is not null,
		'3: the machine''s own executor serves it: ' || current_setting('qorpera_test.mm_a33'));
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_a34') = '42501:Machine screen use is unavailable',
		'3: once: ' || current_setting('qorpera_test.mm_a34'));
	perform pg_temp.base_assert(pg_temp.mm_used('a1') > current_setting('qorpera_test.mm_used3')::timestamptz,
		'3: the served read of a look the member confirmed moves the machine''s last use (20260930714000)');
end $$;

-- A replaced use, an old one, a member who left, a machine stopped meanwhile; the member's word within 30 minutes.
do $$
declare v_old uuid; v_new uuid; v text;
begin
	v_old := pg_temp.mm_use('contributor', 'a4');
	v_new := pg_temp.mm_use('contributor', 'a4');
	perform pg_temp.base_assert(pg_temp.mm_auth(v_old) = '42501:Machine screen use is unavailable'
			and pg_temp.mm_answer(pg_temp.mm_auth(v_new)) ->> 'served' = 'true',
		'3: a use another look replaced is no use');
	v_old := pg_temp.mm_use('contributor', 'a4');
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set use_begun_at = clock_timestamp() - interval '16 seconds'
	where use_id = v_old;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.mm_auth(v_old) = '42501:Machine screen use is unavailable',
		'3: a use older than 15 seconds is no use');
	perform pg_temp.base_assert(pg_temp.mm_auth('12020000-0000-4000-8000-0000000000ee') = '42501:Machine screen use is unavailable',
		'3: an unknown use');
	-- The member's word: confirmed 31 minutes ago, a look that does not confirm keeps the desktop no longer.
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set confirmed_at = clock_timestamp() - interval '31 minutes'
	where machine_id = pg_temp.mm_id('a4') and user_id = pg_temp.mm_user('contributor');
	set local session_replication_role = origin;
	v := pg_temp.mm_auth(pg_temp.mm_use('contributor', 'a4', '{"confirmed": false}'));
	perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'keepDesktop' = 'false', '3: no word for 31 minutes: ' || v);
	v := pg_temp.mm_auth(pg_temp.mm_use('contributor', 'a4', '{"confirmed": true}'));
	perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'keepDesktop' = 'true', '3: the word given again: ' || v);
	v := pg_temp.mm_auth(pg_temp.mm_use('contributor', 'a4', '{"confirmed": false}'));
	perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'keepDesktop' = 'true', '3: the word stands 30 minutes: ' || v);
	-- A member who left between the look and the read; then a machine that stopped meanwhile.
	begin
		v_old := pg_temp.mm_use('contributor', 'a4');
		set local session_replication_role = replica;
		delete from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
			and user_id = pg_temp.mm_user('contributor');
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.mm_auth(v_old) = '42501:Machine screen use is unavailable',
			'3: a member who left: ' || pg_temp.mm_auth(v_old));
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		v_old := pg_temp.mm_use('contributor', 'a4');
		set local session_replication_role = replica;
		update public.qorpera_company_machines set desired_state = 'stopped' where id = pg_temp.mm_id('a4');
		set local session_replication_role = origin;
		v := pg_temp.mm_auth(v_old);
		perform pg_temp.base_assert(v = 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1',
				'state', 'refused', 'reason', 'MACHINE_NOT_RUNNING')::text,
			'3: a machine stopped meanwhile: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

select set_config('qorpera_test.mm_3x', pg_temp.mm_differ(jsonb_build_array(
	jsonb_build_array('no use', pg_temp.mm_service('select public.qorpera_member_machine_screen_authority(null, ''mx-1202'', ''machine-1202'')'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('an owner with a space', pg_temp.mm_auth('12020000-0000-4000-8000-0000000000ee', 'mx 1202'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('a provider in capitals', pg_temp.mm_auth('12020000-0000-4000-8000-0000000000ee', 'mx-1202', 'Machine'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('a member', pg_temp.mm_as(pg_temp.mm_user('owner'), format(
		'select public.qorpera_member_machine_screen_authority(%L, %L, %L)', current_setting('qorpera_test.mm_u31'), 'mx-1202',
		'machine-1202')), '42501:permission denied for function qorpera_member_machine_screen_authority')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_3x') = '',
		E'3: reads that differ:\n' || current_setting('qorpera_test.mm_3x'));
end $$;

-- 4. The disk's rule for members ---------------------------------------------------------------------------------------------

-- The platform opens a view on m-1202's disk (as the machine executor asks it). A member who reads the folder's root still
-- looks there. One who does not (the root revoked; undone after) sees the screen of no disk that has had a view, and does of
-- one that has not (Bob's). The folder's root is company_shared, which every member reads while it stands.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mm_view', public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020',
	'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', pg_temp.mm_id('a1'),
		'placementId', pg_temp.mm_id('b1'), 'bootId', pg_temp.mm_id('c1')))::text, true);
do $$
declare v_use uuid; v text;
	v_refused constant text := 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
		'reason', 'MACHINE_NEEDS_COMPANY_VIEW')::text;
begin
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views
			where id = (current_setting('qorpera_test.mm_view')::jsonb ->> 'viewId')::uuid and placement_id = pg_temp.mm_id('b1')),
		'4: the view is open on m-1202''s disk: ' || current_setting('qorpera_test.mm_view'));
	v_use := pg_temp.mm_use('viewer', 'a1');
	perform pg_temp.base_assert(pg_temp.mm_answer(pg_temp.mm_auth(v_use)) ->> 'state' = 'authorized',
		'4: a root reader looks at a disk that has had a view');
	begin
		v_use := pg_temp.mm_use('viewer', 'a1');
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		update public.qorpera_company_machine_screen_watches set last_look_at = last_look_at - interval '1 second'
		where user_id = pg_temp.mm_user('viewer');
		v := pg_temp.mm_begin('viewer', 'a1');
		perform pg_temp.base_assert(v = v_refused, '4: without the root, no look at a disk that has had a view: ' || v);
		v := pg_temp.mm_auth(v_use);
		perform pg_temp.base_assert(v = replace(v_refused, 'member-machine-screen/v1', 'member-machine-screen-authority/v1'),
			'4: nor the read of a look begun before: ' || v);
		v := pg_temp.mm_begin('viewer', 'a4');
		perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'state' = 'ok', '4: a disk that never had a view: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_path_resources
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '' and revoked_at is null), '4: undone');
end $$;

-- 5. What the machine read, against the watching member ----------------------------------------------------------------------

-- The owner's private folder, which only she reads; m-1202's view read a shared file, then one of hers.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
	created_by_user_id)
select '92400000-0000-4000-8000-000000000020', 'members/92400000-0000-4000-8000-000000000001/private', 'subtree',
	'member_private', '92400000-0000-4000-8000-000000000001', 'normal', '92400000-0000-4000-8000-000000000001'
where not exists (select 1 from public.qorpera_company_path_resources where environment_id = '92400000-0000-4000-8000-000000000020'
	and path = 'members/92400000-0000-4000-8000-000000000001/private');
insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
values ((current_setting('qorpera_test.mm_view')::jsonb ->> 'viewId')::uuid, '12020000-0000-4000-8000-000000000501',
	'92400000-0000-4000-8000-000000000020', '12020000-0000-4000-8000-000000000502',
	'[{"path": "notes/plan.md"}, {"path": "Notes/Plan.md"}]', repeat('0', 64));
select set_config('session_replication_role', 'origin', true);

do $$
declare v text; v_none text := pg_temp.mm_reads('b4', 'c4', pg_temp.mm_user('viewer'));
begin
	perform pg_temp.base_assert(v_none = 'ok:' || jsonb_build_object('schema', 'qorpera.folder-member-reads/v1', 'viewId', null,
			'reads', 0)::text,
		'5: a disk that never had a view has nothing to check: ' || v_none);
	v := pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('viewer'));
	perform pg_temp.base_assert(v = 'ok:' || jsonb_build_object('schema', 'qorpera.folder-member-reads/v1',
			'viewId', current_setting('qorpera_test.mm_view')::jsonb ->> 'viewId', 'reads', 2)::text,
		'5: a viewer reads what the machine read: ' || v);
end $$;

select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
values ((current_setting('qorpera_test.mm_view')::jsonb ->> 'viewId')::uuid, '12020000-0000-4000-8000-000000000503',
	'92400000-0000-4000-8000-000000000020', '12020000-0000-4000-8000-000000000504',
	'[{"path": "members/92400000-0000-4000-8000-000000000001/private/salary.md"}]', repeat('0', 64));
select set_config('session_replication_role', 'origin', true);

select set_config('qorpera_test.mm_5x', pg_temp.mm_differ(jsonb_build_array(
	jsonb_build_array('the owner', pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('owner')),
		'ok:' || jsonb_build_object('schema', 'qorpera.folder-member-reads/v1',
			'viewId', current_setting('qorpera_test.mm_view')::jsonb ->> 'viewId', 'reads', 3)::text),
	jsonb_build_array('a contributor', pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('contributor')),
		'42501:A read is not readable to the member|qorpera.test-machine/member-unreadable'),
	jsonb_build_array('a viewer', pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('viewer')),
		'42501:A read is not readable to the member|qorpera.test-machine/member-unreadable'),
	jsonb_build_array('the admin', pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('admin')),
		'42501:A read is not readable to the member|qorpera.test-machine/member-unreadable'),
	jsonb_build_array('another boot', pg_temp.mm_reads('b1', 'c4', pg_temp.mm_user('owner')),
		'42501:Folder member read is not current|'),
	jsonb_build_array('another company''s placement', pg_temp.mm_reads('b8', 'c8', pg_temp.mm_user('owner')),
		'42501:Member is unavailable|'),
	jsonb_build_array('a stranger', pg_temp.mm_reads('b1', 'c1', pg_temp.mm_user('outsider')), '42501:Member is unavailable|'),
	jsonb_build_array('a member''s call', pg_temp.mm_as(pg_temp.mm_user('owner'), format(
		'select public.qorpera_folder_member_machine_reads(%L, %L, %L)', pg_temp.mm_id('b1'), pg_temp.mm_id('c1'),
		pg_temp.mm_user('owner'))), '42501:permission denied for function qorpera_folder_member_machine_reads')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_5x') = '',
		E'5: read checks that differ:\n' || current_setting('qorpera_test.mm_5x'));
	-- The refusal is the member's alone: the placement and its boot go on.
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_machine_placements where id = pg_temp.mm_id('b1')
			and retired_at is null and removed_at is null and folder_unchecked_at is null and folder_retire_reason is null
			and boot_id = pg_temp.mm_id('c1')),
		'5: a member''s refusal marks neither the placement nor its boot');
	-- The executor's read still serves the member, whose picture the executor then holds back.
	perform pg_temp.base_assert(pg_temp.mm_answer(pg_temp.mm_auth(pg_temp.mm_use('contributor', 'a1'))) ->> 'served' = 'true',
		'5: the read check is the executor''s, after its boundary');
end $$;

-- 6. The agent's screen read stamps who drives the screen ---------------------------------------------------------------------

create function pg_temp.mm_look(p_machine text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.mm_try(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.mm_id(p_machine))));
	reset role;
	return v;
end $$;
create function pg_temp.mm_screen(p_machine text) returns jsonb language sql as $$
	select jsonb_build_object('agent', screen_staff_agent_id, 'at', screen_used_at) from public.qorpera_company_machines
	where id = pg_temp.mm_id(p_machine)
$$;
do $$
declare v_before jsonb := pg_temp.mm_screen('a5'); v_first jsonb; v text;
begin
	-- Bob's own machine, never driven: Alice's look stamps her.
	v := pg_temp.mm_look('a5');
	v_first := pg_temp.mm_screen('a5');
	perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'state' = 'authorized' and v_before ->> 'agent' is null
			and v_first ->> 'agent' = '92400000-0000-4000-8000-000000000030' and v_first ->> 'at' is not null,
		'6: a look stamps the agent: ' || v || ' / ' || v_first::text);
	-- Within 30 seconds, the same agent: unchanged.
	perform pg_temp.mm_look('a5');
	perform pg_temp.base_assert(pg_temp.mm_screen('a5') = v_first, '6: within 30 seconds nothing moves');
	-- Another agent drove it meanwhile: Alice's look stamps her at once.
	set local session_replication_role = replica;
	update public.qorpera_company_machines set screen_staff_agent_id = '92400000-0000-4000-8000-000000000031'
	where id = pg_temp.mm_id('a5');
	set local session_replication_role = origin;
	perform pg_temp.mm_look('a5');
	perform pg_temp.base_assert(pg_temp.mm_screen('a5') ->> 'agent' = '92400000-0000-4000-8000-000000000030',
		'6: another agent''s stamp is replaced at once');
	-- After 30 seconds, the time moves.
	set local session_replication_role = replica;
	update public.qorpera_company_machines set screen_used_at = clock_timestamp() - interval '31 seconds'
	where id = pg_temp.mm_id('a5');
	set local session_replication_role = origin;
	perform pg_temp.mm_look('a5');
	perform pg_temp.base_assert((pg_temp.mm_screen('a5') ->> 'at')::timestamptz > clock_timestamp() - interval '5 seconds',
		'6: after 30 seconds the time moves');
	-- Now Alice's list shows Bob's machine she drove.
	perform pg_temp.base_assert(pg_temp.mm_answer(pg_temp.mm_list('viewer', '92400000-0000-4000-8000-000000000030'))
			-> 'machines' -> 0 ->> 'name' = 'm-1202-bob-only',
		'6: the machine she drove last comes first in her list');
	-- A refused look stamps nothing: a stopped machine.
	v_first := pg_temp.mm_screen('a2');
	v := pg_temp.mm_look('a2');
	perform pg_temp.base_assert(pg_temp.mm_answer(v) ->> 'reason' = 'MACHINE_NOT_RUNNING' and pg_temp.mm_screen('a2') = v_first,
		'6: a refused look stamps nothing: ' || v);
end $$;

-- 7. The `machines` hint -------------------------------------------------------------------------------------------------------

-- The hints sent so far to the company's members, as event:member, sorted.
create function pg_temp.mm_hints() returns text language sql as $$
	select coalesce(string_agg(label, ' ' order by label collate "C"), '')
	from (select message.event || ':' || substring(message.topic from 51) as label from realtime.messages as message
		where message.topic like 'qorpera-live-%' and message.event = 'machines') as hint
$$;
create function pg_temp.mm_clear() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;
-- What a commit would send now: the deferred hints fire.
create function pg_temp.mm_flush() returns void language plpgsql as $$
begin
	set constraints qorpera_machine_hint, qorpera_machine_hint_change immediate;
	set constraints qorpera_machine_hint, qorpera_machine_hint_change deferred;
end $$;
create function pg_temp.mm_hinted(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.mm_flush();
	perform pg_temp.mm_clear();
	execute p_sql;
	perform pg_temp.mm_flush();
	v := pg_temp.mm_hints();
	perform pg_temp.mm_clear();
	return v;
end $$;
select set_config('qorpera_test.mm_all', 'machines:92400000-0000-4000-8000-000000000001 '
	|| 'machines:92400000-0000-4000-8000-000000000002 machines:92400000-0000-4000-8000-000000000003 '
	|| 'machines:92400000-0000-4000-8000-000000000004', true);
savepoint mm_hints;
select set_config('qorpera_test.mm_7x', pg_temp.mm_differ(jsonb_build_array(
	jsonb_build_array('the last use alone', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = %L', pg_temp.mm_id('a1'))), ''),
	jsonb_build_array('a busy check-in, the notify list, the place in line', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set busy_at = clock_timestamp(), notify_run_ids = ''{}'', wanted_at = clock_timestamp(), updated_at = clock_timestamp() where id = %L',
		pg_temp.mm_id('a1'))), ''),
	jsonb_build_array('a screen use within 10 minutes', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set screen_used_at = screen_used_at + interval ''9 minutes'' where id = %L',
		pg_temp.mm_id('a4'))), ''),
	jsonb_build_array('a screen used again after 10 minutes', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set screen_used_at = screen_used_at + interval ''11 minutes'' where id = %L',
		pg_temp.mm_id('a4'))), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('another agent drives it', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set screen_staff_agent_id = %L where id = %L',
		'92400000-0000-4000-8000-000000000031', pg_temp.mm_id('a4'))), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('wanted off', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set desired_state = ''stopped'' where id = %L', pg_temp.mm_id('a1'))),
		current_setting('qorpera_test.mm_all')),
	jsonb_build_array('an error', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set last_error = ''guest:X'', last_error_at = clock_timestamp() where id = %L',
		pg_temp.mm_id('a1'))), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('two machines in one transaction, once', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set removed_at = clock_timestamp() where id in (%L, %L)', pg_temp.mm_id('a2'),
		pg_temp.mm_id('a3'))), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('a placement starts', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machine_placements set running_at = clock_timestamp() where id = %L', pg_temp.mm_id('b4'))),
		current_setting('qorpera_test.mm_all')),
	jsonb_build_array('a placement''s new boot', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machine_placements set boot_id = %L where id = %L', '12020000-0000-4000-8000-0000000007cc',
		pg_temp.mm_id('b4'))), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('a placement''s folder mark', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp() where id = %L',
		pg_temp.mm_id('b4'))), ''),
	jsonb_build_array('a new machine', pg_temp.mm_hinted(format(
		'insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime) '
		|| 'select %L, run.profile_id, run.environment_id, ''m-1202-new'', ''Tests the app.'', run.staff_agent_id, run.id, %L, run.requested_by_user_id, 2, 4294967296, 21474836480, ''standard'', ''task'' from public.qorpera_execution_runs as run where run.id = %L',
		'12020000-0000-4000-8000-0000000007f1', '12020000-0000-4000-8000-0000000008f1',
		current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')), current_setting('qorpera_test.mm_all')),
	jsonb_build_array('another company''s machine, to its members only', pg_temp.mm_hinted(format(
		'update public.qorpera_company_machines set desired_state = ''stopped'' where id = %L', pg_temp.mm_id('a8'))), '')
)), true);
-- A company being deleted: its members get no hint.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.mm_7d', pg_temp.mm_hinted(format(
	'update public.qorpera_company_machines set desired_state = ''running'' where id = %L', pg_temp.mm_id('a2'))), true);
-- Read before the rollback below, which undoes these transaction-local settings with the rest (review r1 F4).
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_7x', true) = '',
		E'7: hints that differ:\n' || coalesce(current_setting('qorpera_test.mm_7x', true), 'unset'));
	perform pg_temp.base_assert(current_setting('qorpera_test.mm_7d', true) = '',
		'7: a company being deleted: ' || coalesce(current_setting('qorpera_test.mm_7d', true), 'unset'));
end $$;
rollback to savepoint mm_hints;

-- 8. Grants and the marker -----------------------------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(
			has_function_privilege(v_role, 'public.qorpera_list_agent_machines(uuid,uuid)', 'execute') = (v_role = 'authenticated')
			and has_function_privilege(v_role, 'public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)', 'execute')
				= (v_role = 'authenticated')
			and has_function_privilege(v_role, 'public.qorpera_member_machine_screen_authority(uuid,text,text)', 'execute')
				= (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_folder_member_machine_reads(uuid,uuid,uuid)', 'execute')
				= (v_role = 'service_role')
			and not has_function_privilege(v_role, 'public.qorpera_machine_hint()', 'execute')
			and not has_table_privilege(v_role, 'public.qorpera_company_machine_screen_watches', 'select, insert, update, delete'),
			format('8: the grants for %s', v_role));
	end loop;
	perform pg_temp.base_assert((select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930712000') > 0) = array[
			'qorpera_authorize_machine_screen', 'qorpera_folder_member_machine_reads', 'qorpera_list_agent_machines',
			'qorpera_machine_hint', 'qorpera_member_machine_screen_authority', 'qorpera_member_machine_screen_begin'],
		'8: the marker''s bodies');
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure), '20260930708000') > 0,
		'8: the screen read keeps its own marker');
	-- The disk's rule names the member, as the agent's names its run's agent and requester.
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)'::regprocedure),
			'public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, ''member'', v_user, ''read'')') > 0
			and strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_screen_authority(uuid,text,text)'::regprocedure),
			'public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, ''member'', v_watch.user_id, ''read'')') > 0,
		'8: the disk''s rule names the member');
	perform pg_temp.base_assert((select array_agg(format('%s.%s', tgrelid::regclass, tgname) order by tgrelid::regclass::text, tgname)
			from pg_trigger where tgfoid = 'public.qorpera_machine_hint()'::regprocedure and tgdeferrable and tginitdeferred)
			= array['qorpera_company_machine_placements.qorpera_machine_hint',
				'qorpera_company_machine_placements.qorpera_machine_hint_change',
				'qorpera_company_machines.qorpera_machine_hint', 'qorpera_company_machines.qorpera_machine_hint_change'],
		'8: the hint''s deferred triggers');
end $$;

rollback;
