-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930758000: a member opens one of the company's apps, or a file of its folder, on an agent's desktop computer. On
-- 924's base (an owner, a contributor, a viewer, an admin and an outsider; Alice's live run for the owner), with the
-- machines of 1204 under this test's own ids (Alice's running desktop m-1255, one too small, one asleep, a second
-- running desktop and another company's):
-- 1. who may: an owner, admin or contributor of the company; a viewer, a stranger, another company's machine refused
--    (42501); a malformed call (22023); the service role may not;
-- 2. the path: the company folder's own rule (an empty piece, `.`, `..`, a leading `/`, a trailing `/`, a piece ending in
--    a dot or a space, a backslash, a newline or a tab, `%` and `:` outside code/, a device name, a path not in NFC,
--    past 500 bytes) refused DESKTOP_OPEN_PATH_INVALID, recording nothing; Danish letters, spaces and
--    `; $( ) '` taken whole; 500 bytes taken;
-- 3. what the member reads: a path under secrets/, another member's private folder, anything once the folder's root is
--    taken away: DESKTOP_OPEN_NOT_FOUND, as a path that is not there, recording nothing;
-- 4. another member typing privately: DESKTOP_MEMBER_IN_CONTROL, recording nothing; the member's own private hold does
--    not stop it;
-- 5. the start as a plain one: the plain begin's refusals (asleep, too small, the 5 s floor), its marks; the row keeps the
--    path, and the agent is told a member used the desktop (who and when);
-- 6. the executor's read: served once, by the machine's own executor, the path in its answer; the path made unreadable
--    or another member's private hold since the begin refuse it; a plain start's answer exactly as before (no `open`)
--    and its row without a path;
-- 7. the grants, the column's check and the marker; the plain begin untouched;
-- 8. the host's check right before the open (review r1 F1 of #1781): only a served open start, once, within a minute,
--    on its placement and boot; refused DESKTOP_MEMBER_IN_CONTROL for another member's private hold begun during the
--    start (now, or one begun and ended since), not for the member's own; the path no longer theirs; a member no longer
--    allowed; the service role's alone.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'dc-ack') is not null;

-- The machines, all started by Alice's run, last used an hour ago; the running ones run on their placements (reserved on a
-- node, as an executor's custody leaves them).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12550000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12550000-0000-4000-8000-0000000007e5', '12550000-0000-4000-8000-000000000011', 'Environment', 1,
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
	('12550000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1255', '12550000-0000-4000-8000-0000000008a1'::uuid, 2,
		4294967296::bigint, 'running'),
	-- Running, too small for a desktop.
	('12550000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1255-small', '12550000-0000-4000-8000-0000000008a2', 1, 2147483648, 'running'),
	-- Asleep.
	('12550000-0000-4000-8000-0000000007a3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1255-asleep', '12550000-0000-4000-8000-0000000008a3', 2, 4294967296, 'stopped'),
	-- A second running desktop, which no one takes over.
	('12550000-0000-4000-8000-0000000007a4', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1255-other', '12550000-0000-4000-8000-0000000008a4', 4, 8589934592, 'running'),
	-- Another company's, running.
	('12550000-0000-4000-8000-0000000007a5', '12550000-0000-4000-8000-000000000011', '12550000-0000-4000-8000-0000000007e5',
		'm-1255', '12550000-0000-4000-8000-0000000008a5', 2, 4294967296, 'running')
) as machine(id, profile_id, environment_id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12550000-0000-4000-8000-0000000007b' || n)::uuid, ('12550000-0000-4000-8000-0000000007a' || n)::uuid,
	case when n = 5 then '12550000-0000-4000-8000-000000000011'::uuid else '92400000-0000-4000-8000-000000000010'::uuid end,
	'mx-1255', repeat('8', 64), '{"providerId": "machine-1255"}', repeat(n::text, 64), clock_timestamp(),
	('12550000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 2, 4, 5]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12550000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12550000-0000-4000-8000-0000000007d1', 'machine', 'machine-1255', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12550000-%';
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
	select ('12550000-0000-4000-8000-0000000007' || p_suffix)::uuid
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
create function pg_temp.dc_auth(p_start uuid, p_owner text default 'mx-1255', p_provider text default 'machine-1255')
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
create function pg_temp.dc_look_auth(p_use uuid, p_owner text default 'mx-1255') returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_screen_authority(%L, %L, %L)', p_use, p_owner,
		'machine-1255'))
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


-- A start that opens a path, begun as a member, of their company's machine unless the test names another company.
create function pg_temp.dc_open(p_who text, p_machine text, p_path text,
	p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, %L, %L)', p_profile, pg_temp.dc_id(p_machine), p_path))
$$;
-- An open's id, the floor stepped over first.
create function pg_temp.dc_open_id(p_who text, p_machine text, p_path text) returns uuid language plpgsql as $$
declare v text;
begin
	perform pg_temp.dc_age(p_machine, interval '6 seconds');
	v := pg_temp.dc_open(p_who, p_machine, p_path);
	if pg_temp.dc_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The open was not begun: %', v; end if;
	return (pg_temp.dc_answer(v) ->> 'startId')::uuid;
end $$;
create function pg_temp.dc_paths(p_machine text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(start.open_path order by start.begun_at), '[]')
	from public.qorpera_company_machine_desktop_starts as start where start.machine_id = pg_temp.dc_id(p_machine)
$$;
-- The admin holds the desktop privately (take-over) until the test ends it.
create function pg_temp.dc_hold(p_who text, p_machine text) returns void language plpgsql as $$
declare v text;
begin
	v := pg_temp.dc_take(p_who, p_machine);
	if pg_temp.dc_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'No hold: %', v; end if;
end $$;
create function pg_temp.dc_unhold(p_machine text) returns void language sql as $$
	select pg_temp.dc_shift(p_machine, 'desktop_member_until = null')
$$;
-- The host's check right before the open, on the machine's placement and boot unless the test names others.
create function pg_temp.dc_check(p_start uuid, p_machine text default 'a1', p_placement uuid default null,
	p_boot uuid default null) returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_desktop_open_check(%L, %L, %L)', p_start,
		coalesce(p_placement, (pg_temp.dc_placement(p_machine)).id), coalesce(p_boot, (pg_temp.dc_placement(p_machine)).boot_id)))
$$;
-- An open begun and served (the start ran), its id.
create function pg_temp.dc_served(p_who text, p_machine text, p_path text) returns uuid language plpgsql as $$
declare v_start uuid := pg_temp.dc_open_id(p_who, p_machine, p_path); v text;
begin
	v := pg_temp.dc_auth(v_start);
	if pg_temp.dc_answer(v) ->> 'served' is distinct from 'true' then raise exception 'Not served: %', v; end if;
	return v_start;
end $$;

-- 1. Who may ------------------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_1x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('a viewer', pg_temp.dc_open('viewer', 'a1', 'apps/brooks'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('a stranger', pg_temp.dc_open('outsider', 'a1', 'apps/brooks'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('another company''s machine', pg_temp.dc_open('owner', 'a5', 'apps/brooks'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('another company', pg_temp.dc_open('owner', 'a5', 'apps/brooks', '12550000-0000-4000-8000-000000000011'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('no path', pg_temp.dc_as(pg_temp.dc_user('owner'), format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, %L, null)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a1'))), '22023:Machine desktop request is malformed'),
	jsonb_build_array('the service role', pg_temp.dc_service(format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a1'), 'apps/brooks')),
		'42501:permission denied for function qorpera_member_machine_desktop_start_begin')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_1x') = '',
		E'1: opens that differ:\n' || current_setting('qorpera_test.dc_1x'));
	perform pg_temp.base_assert(pg_temp.dc_starts('a1') = '[]' and pg_temp.dc_starts('a5') = '[]',
		'1: a refused open records nothing');
end $$;

-- 2. The path ------------------------------------------------------------------------------------------------------------------

do $$
declare v_path text; v text;
begin
	foreach v_path in array array['', '/apps/brooks', 'apps//brooks', 'apps/brooks/', './apps', 'apps/./brooks', 'apps/../x',
		'..', 'apps/brooks.', 'apps/brooks ', 'apps\brooks', 'apps/br' || chr(10) || 'ooks', 'apps/br' || chr(9) || 'ooks',
		'apps/100%', 'apps/a:b', 'apps/con', 'apps/nul.txt', 'apps/a' || chr(778) || 'b', repeat('x', 501)] loop
		v := pg_temp.dc_open('contributor', 'a1', v_path);
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_OPEN_PATH_INVALID'),
			format('2: %L is no path of the folder: %s', v_path, v));
	end loop;
	perform pg_temp.base_assert(pg_temp.dc_starts('a1') = '[]', '2: a refused path records nothing');
	-- Danish letters, spaces and what a shell would read: taken whole, as the folder names them.
	foreach v_path in array array['apps/brooks', 'strategy/solution.md', 'Møder/æble og grød ø.md',
		'apps/a;b $(x) ''q''.txt', 'code/repo%20x/a:b', repeat('å', 250)] loop
		perform pg_temp.dc_open_id('contributor', 'a1', v_path);
		perform pg_temp.base_assert((pg_temp.dc_paths('a1') ->> -1) = v_path, format('2: %L is kept whole', v_path));
	end loop;
	perform pg_temp.base_assert(octet_length(repeat('å', 250)) = 500, '2: 500 bytes');
end $$;

-- 3. What the member reads -------------------------------------------------------------------------------------------------------

do $$
declare v_path text; v text; v_before jsonb := pg_temp.dc_starts('a1');
begin
	perform pg_temp.dc_age('a1', interval '6 seconds');
	foreach v_path in array array['secrets/bank.txt', 'credentials/x', 'members/' || pg_temp.dc_user('owner') || '/private/x.md']
	loop
		v := pg_temp.dc_open('contributor', 'a1', v_path);
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_OPEN_NOT_FOUND'),
			format('3: %L is not the contributor''s to read: %s', v_path, v));
	end loop;
	perform pg_temp.dc_no_root();
	v := pg_temp.dc_open('owner', 'a1', 'apps/brooks');
	perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_OPEN_NOT_FOUND'),
		'3: without the folder''s root no one reads it: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_starts('a1') = v_before, '3: a path one may not read records nothing');
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;

-- 4. Another member typing privately ------------------------------------------------------------------------------------------

do $$
declare v text; v_before jsonb;
begin
	perform pg_temp.dc_hold('admin', 'a4');
	perform pg_temp.dc_age('a4', interval '6 seconds');
	v_before := pg_temp.dc_starts('a4');
	v := pg_temp.dc_open('contributor', 'a4', 'apps/brooks');
	perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_MEMBER_IN_CONTROL'),
		'4: the admin types privately: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_starts('a4') = v_before, '4: refused, nothing recorded');
	-- The admin's own private hold does not stop the admin's open.
	v := pg_temp.dc_open('admin', 'a4', 'apps/brooks');
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok', '4: the member''s own hold does not stop it: ' || v);
	perform pg_temp.dc_unhold('a4');
end $$;

-- 5. The start as a plain one -----------------------------------------------------------------------------------------------------

do $$
declare v text; v_start uuid; v_at timestamptz;
begin
	perform pg_temp.base_assert(pg_temp.dc_open('owner', 'a3', 'apps/brooks')
			= pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'MACHINE_NOT_RUNNING')
		and pg_temp.dc_open('owner', 'a2', 'apps/brooks')
			= pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_MACHINE_TOO_SMALL'),
		'5: asleep and too small, as a plain start');
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''1 hour'', desktop_shared_user_id = null, '
		|| 'desktop_shared_at = null');
	v_at := clock_timestamp();
	v_start := pg_temp.dc_open_id('admin', 'a1', 'strategy/solution.md');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).last_used_at >= v_at
			and (pg_temp.dc_machine('a1')).desktop_shared_user_id = pg_temp.dc_user('admin')
			and (pg_temp.dc_machine('a1')).desktop_shared_at >= v_at,
		'5: the machine used, and the agent told a member used its desktop');
	perform pg_temp.base_assert((select user_id = pg_temp.dc_user('admin') and open_path = 'strategy/solution.md'
			and served_at is null from public.qorpera_company_machine_desktop_starts where id = v_start),
		'5: the start keeps its member and its path');
	-- The floor: a plain start or an open within 5 s of it.
	perform pg_temp.base_assert(pg_temp.dc_open('owner', 'a1', 'apps/brooks')
			= pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_START_TOO_SOON')
		and pg_temp.dc_start('owner', 'a1') = pg_temp.dc_refused('qorpera.member-machine-desktop-start/v1', 'DESKTOP_START_TOO_SOON'),
		'5: 5 s between starts, opens among them');
end $$;

-- 6. The executor's read --------------------------------------------------------------------------------------------------------

do $$
declare v text; v_start uuid; v_plain uuid;
begin
	v_start := pg_temp.dc_open_id('contributor', 'a1', 'Møder/æble og grød ø.md');
	v := pg_temp.dc_auth(v_start, 'someone-else', 'machine-1255');
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'served' = 'false'
			and pg_temp.dc_answer(v) ->> 'open' = 'Møder/æble og grød ø.md',
		'6: another executor reads it, the path with it, without serving it: ' || v);
	v := pg_temp.dc_auth(v_start);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'authorized' and pg_temp.dc_answer(v) ->> 'served' = 'true'
			and pg_temp.dc_answer(v) ->> 'open' = 'Møder/æble og grød ø.md'
			and (select array_agg(key order by key) from jsonb_object_keys(pg_temp.dc_answer(v)) as key)
				= array['bootId', 'executorOwner', 'machineId', 'open', 'placementId', 'providerId', 'schema', 'served',
					'startId', 'state', 'userId'],
		'6: the machine''s own executor serves it, the path in the answer: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_auth(v_start) = '42501:Machine desktop start is unavailable',
		'6: once');
	-- A plain start: its answer as before, its row without a path.
	v_plain := pg_temp.dc_start_id('contributor', 'a1');
	v := pg_temp.dc_auth(v_plain);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'served' = 'true' and not (pg_temp.dc_answer(v) ? 'open')
			and (select open_path is null from public.qorpera_company_machine_desktop_starts where id = v_plain),
		'6: a plain start reads as before: ' || v);
	-- Another member's private hold since the begin: refused; the path made unreadable since: refused.
	v_start := pg_temp.dc_open_id('contributor', 'a1', 'apps/brooks');
	perform pg_temp.dc_hold('admin', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_auth(v_start)
			= pg_temp.dc_refused('qorpera.member-machine-desktop-start-authority/v1', 'DESKTOP_MEMBER_IN_CONTROL'),
		'6: the admin took it privately since the begin');
	v_start := pg_temp.dc_open_id('contributor', 'a4', 'apps/brooks');
	perform pg_temp.dc_no_root();
	perform pg_temp.base_assert(pg_temp.dc_auth(v_start)
			= pg_temp.dc_refused('qorpera.member-machine-desktop-start-authority/v1', 'DESKTOP_OPEN_NOT_FOUND'),
		'6: the folder''s root taken away since the begin');
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;

-- 7. Grants, the check, the marker; the plain begin untouched --------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_member_machine_desktop_start_begin(uuid,uuid,text)', 'execute') = (v_role = 'authenticated'),
			'7: the open''s begin is a member''s alone: ' || v_role);
	end loop;
	perform pg_temp.base_assert(pg_temp.dc_try(format(
			'insert into public.qorpera_company_machine_desktop_starts(id, machine_id, user_id, begun_at, open_path) '
			|| 'values (gen_random_uuid(), %L, %L, now(), %L) returning null::jsonb', pg_temp.dc_id('a1'), pg_temp.dc_user('owner'),
			'../etc/passwd')) like '23514:%',
		'7: the column takes a path of the folder only');
	perform pg_temp.base_assert((select array_agg(oid::regprocedure::text order by oid::regprocedure::text) from pg_proc
			where pronamespace = 'public'::regnamespace and strpos(prosrc, '20260930758000') > 0)
		= array['qorpera_member_machine_desktop_open_check(uuid,uuid,uuid)',
			'qorpera_member_machine_desktop_start_authority(uuid,text,text)',
			'qorpera_member_machine_desktop_start_begin(uuid,uuid,text)'],
		'7: the bodies that name 20260930758000');
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_start_begin(uuid,uuid)'::regprocedure), 'open_path') = 0,
		'7: the plain begin is as 20260930714000 left it');
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_member_machine_desktop_open_check(uuid,uuid,uuid)', 'execute') = (v_role = 'service_role'),
			'7: the open''s check is the service role''s alone: ' || v_role);
	end loop;
end $$;

-- 8. The host's check right before the open ----------------------------------------------------------------------------------

do $$
declare v_start uuid; v text;
begin
	-- Only once the start was served, and once.
	v_start := pg_temp.dc_open_id('contributor', 'a1', 'apps/brooks');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start) = '42501:Machine desktop open is unavailable',
		'8: an open not served yet is checked by no one');
	perform pg_temp.dc_auth(v_start);
	v := pg_temp.dc_check(v_start);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok'
			and pg_temp.dc_answer(v) ->> 'schema' = 'qorpera.member-machine-desktop-open-check/v1',
		'8: the served open passes: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_check(v_start) = '42501:Machine desktop open is unavailable', '8: once');
	-- A plain start has nothing to open.
	perform pg_temp.base_assert(pg_temp.dc_check((select pg_temp.dc_start_id('contributor', 'a1')))
			= '42501:Machine desktop open is unavailable',
		'8: a plain start is no open');
	-- Too old: a start's check comes within a minute of its serving.
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	update public.qorpera_company_machine_desktop_starts set served_at = served_at - interval '2 minutes' where id = v_start;
	perform pg_temp.base_assert(pg_temp.dc_check(v_start) = '42501:Machine desktop open is unavailable', '8: too old');
	-- Another placement, another boot.
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start, 'a1', pg_temp.dc_id('b4'))
			= pg_temp.dc_refused('qorpera.member-machine-desktop-open-check/v1', 'MACHINE_NOT_RUNNING'),
		'8: not on the placement the start ran on');
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start, 'a1', null, pg_catalog.gen_random_uuid())
			= pg_temp.dc_refused('qorpera.member-machine-desktop-open-check/v1', 'MACHINE_BOOT_CHANGED'),
		'8: another boot');
	-- The service role's alone.
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.base_assert(pg_temp.dc_as(pg_temp.dc_user('contributor'), format(
			'select public.qorpera_member_machine_desktop_open_check(%L, %L, %L)', v_start, (pg_temp.dc_placement('a1')).id,
			(pg_temp.dc_placement('a1')).boot_id)) like '42501:permission denied%',
		'8: no member calls it');
end $$;

-- A take-over begun while the start ran: the open does not run; begun and ended since: neither; the member's own: it runs.
do $$
declare v_start uuid;
begin
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.dc_hold('admin', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start)
			= pg_temp.dc_refused('qorpera.member-machine-desktop-open-check/v1', 'DESKTOP_MEMBER_IN_CONTROL'),
		'8: the admin typing privately since the begin stops the open');
	perform pg_temp.dc_unhold('a1');
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.dc_shift('a1', 'desktop_member_generation = desktop_member_generation + 1');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start)
			= pg_temp.dc_refused('qorpera.member-machine-desktop-open-check/v1', 'DESKTOP_MEMBER_IN_CONTROL'),
		'8: another member''s private typing begun and ended since the begin stops it too');
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;
do $$
declare v_start uuid; v text;
begin
	v_start := pg_temp.dc_served('admin', 'a1', 'apps/brooks');
	perform pg_temp.dc_hold('admin', 'a1');
	v := pg_temp.dc_check(v_start);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok', '8: the member''s own private hold: it runs: ' || v);
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;
-- The path no longer the member's to read; the member no longer allowed.
do $$
declare v_start uuid;
begin
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	perform pg_temp.dc_no_root();
	perform pg_temp.base_assert(pg_temp.dc_check(v_start)
			= pg_temp.dc_refused('qorpera.member-machine-desktop-open-check/v1', 'DESKTOP_OPEN_NOT_FOUND'),
		'8: the folder''s root taken away since');
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;
do $$
declare v_start uuid;
begin
	v_start := pg_temp.dc_served('contributor', 'a1', 'apps/brooks');
	update public.qorpera_profile_members set role = 'viewer'
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.dc_user('contributor');
	perform pg_temp.base_assert(pg_temp.dc_check(v_start) = '42501:Machine desktop open is unavailable',
		'8: a member made a viewer since');
	raise exception 'dc-rollback';
exception when raise_exception then
	if sqlerrm <> 'dc-rollback' then raise; end if;
end $$;
