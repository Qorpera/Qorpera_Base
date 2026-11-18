-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930738000: a member's shared input carries the lease generation it was made under. On 924's base (an owner, a
-- contributor, a viewer, an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1232
-- and a stopped one:
-- 1. the window's list names each machine's lease generation to owners, admins and contributors, never to a viewer; it
--    moves at a seating and at a hand-back;
-- 2. the shared begin with a generation: taken at the current one, its row's seat that generation; refused
--    DESKTOP_HELD_SINCE at any other, with nothing recorded; a generation that is not a whole number malformed (22023);
--    every check before it first (a viewer, a stranger, a stopped machine, a live hold say what they said before, so the
--    generation tells no one else anything); the service role may not call it;
-- 3. another member's private hold, and the member's own in another window, taken and given back between two reads:
--    every input made before it is refused, whatever the window saw; after the list is read again the input goes, and the
--    executor's read serves it, saying `shared`;
-- 4. the begin without a generation (a window from before the web deploy) is served as today, after such a hold too;
-- 5. a hold taken and given back between the begin and the executor's read still stops it (DESKTOP_MEMBER_IN_CONTROL, as
--    before);
-- 6. the grants, PostgREST's two signatures told apart by their argument names, the new begin the old one's body but for
--    its two changes, and the markers.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'sg-ack') is not null;

-- The machines, started by Alice's run; the running one runs on its placement (reserved on a node).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at)
select machine.id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', machine.name,
	'Tests the shop.', run.staff_agent_id, run.id, machine.receipt_id, run.requested_by_user_id, 2, 4294967296, 21474836480,
	'standard', 'task', machine.desired_state, clock_timestamp() - interval '1 hour'
from public.qorpera_execution_runs as run
cross join (values
	('12320000-0000-4000-8000-0000000007a1'::uuid, 'm-1232', '12320000-0000-4000-8000-0000000008a1'::uuid, 'running'),
	('12320000-0000-4000-8000-0000000007a2', 'm-1232-asleep', '12320000-0000-4000-8000-0000000008a2', 'stopped')
) as machine(id, name, receipt_id, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
values ('12320000-0000-4000-8000-0000000007b1', '12320000-0000-4000-8000-0000000007a1', '92400000-0000-4000-8000-000000000010',
	'mx-1232', repeat('8', 64), '{"providerId": "machine-1232"}', repeat('1', 64), clock_timestamp(),
	'12320000-0000-4000-8000-0000000007c1');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
values ('12320000-0000-4000-8000-0000000007b1', '92400000-0000-4000-8000-000000000010', '12320000-0000-4000-8000-0000000007b1',
	'lxd', repeat('1', 64), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
values ('12320000-0000-4000-8000-0000000007b1', '12320000-0000-4000-8000-0000000007d1', 'machine', 'machine-1232',
	repeat('4', 64), 2000, 4294967296, clock_timestamp());
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.sg_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.sg_try(text) to authenticated, service_role;
create function pg_temp.sg_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A call as one member (authenticated), or as the service role.
create function pg_temp.sg_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.sg_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.sg_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.sg_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.sg_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12320000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.sg_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.sg_machine(p_machine text default 'a1') returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.sg_id(p_machine)
$$;
create function pg_temp.sg_generation() returns bigint language sql as $$
	select (pg_temp.sg_machine('a1')).desktop_member_generation
$$;
create function pg_temp.sg_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused', 'reason', p_reason)::text
$$;
-- A member's shared click on a machine (m-1232 unless named), made under `generation`.
create function pg_temp.sg_share(p_who text, p_generation bigint, p_machine text default 'a1') returns text language sql as $$
	select pg_temp.sg_as(pg_temp.sg_user(p_who), format(
		'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L, %s)', '92400000-0000-4000-8000-000000000010',
		pg_temp.sg_id(p_machine), '{"type": "click", "x": 4, "y": 4}', coalesce(p_generation::text, 'null')))
$$;
-- The same without a generation (a window before 20260930738000).
create function pg_temp.sg_share_old(p_who text) returns text language sql as $$
	select pg_temp.sg_as(pg_temp.sg_user(p_who), format('select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.sg_id('a1'), '{"type": "click", "x": 4, "y": 4}'))
$$;
create function pg_temp.sg_auth(p_action uuid) returns text language sql as $$
	select pg_temp.sg_service(format('select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)', p_action, 'mx-1232',
		'machine-1232'))
$$;
-- A member's hand-back epoch for m-1232 (0 while they have no row).
create function pg_temp.sg_epoch(p_who text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.sg_id('a1') and epochs.user_id = pg_temp.sg_user(p_who)), 0)
$$;
-- A take-over of m-1232 at the member's current epoch, and a hand-back of their hold (EXACT, by its seat); each must hold.
create function pg_temp.sg_take(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.sg_as(pg_temp.sg_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
	'92400000-0000-4000-8000-000000000010', pg_temp.sg_id('a1'), pg_temp.sg_epoch(p_who), pg_catalog.gen_random_uuid()));
begin
	if pg_temp.sg_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The take-over did not hold: %', v; end if;
end $$;
create function pg_temp.sg_hand_back(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.sg_as(pg_temp.sg_user(p_who), format(
	'select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
	pg_temp.sg_id('a1'), 'handed_back', pg_temp.sg_epoch(p_who), pg_temp.sg_generation()));
begin
	if pg_temp.sg_answer(v) is null then raise exception 'The hand-back failed: %', v; end if;
end $$;
-- m-1232 in the window's list, as a member sees it.
create function pg_temp.sg_listed(p_who text) returns jsonb language sql as $$
	select m from jsonb_array_elements(pg_temp.sg_answer(pg_temp.sg_as(pg_temp.sg_user(p_who), format(
		'select public.qorpera_list_agent_machines(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000030'))) -> 'machines') as m
	where m ->> 'machineId' = pg_temp.sg_id('a1')::text
$$;
create function pg_temp.sg_rows() returns bigint language sql as $$
	select count(*) from public.qorpera_company_machine_desktop_actions where machine_id = pg_temp.sg_id('a1') and shared
$$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.sg_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;

-- 1. The list names the generation to those who may act ---------------------------------------------------------------------
do $$
declare v_start bigint := pg_temp.sg_generation();
begin
	perform pg_temp.base_assert(pg_temp.sg_listed('owner') -> 'generation' = to_jsonb(v_start)
			and pg_temp.sg_listed('admin') -> 'generation' = to_jsonb(v_start)
			and pg_temp.sg_listed('contributor') -> 'generation' = to_jsonb(v_start),
		'1: owners, admins and contributors are told the generation: ' || coalesce(pg_temp.sg_listed('owner')::text, 'none'));
	perform pg_temp.base_assert(pg_temp.sg_listed('viewer') is not null and not pg_temp.sg_listed('viewer') ? 'generation',
		'1: a viewer is not: ' || coalesce(pg_temp.sg_listed('viewer')::text, 'none'));
	perform pg_temp.sg_take('admin');
	perform pg_temp.base_assert(pg_temp.sg_listed('owner') -> 'generation' = to_jsonb(v_start + 1)
			and pg_temp.sg_listed('admin') #> '{control,seat}' = to_jsonb(v_start + 1),
		'1: a seating moves it (the holder''s seat is the same number)');
	perform pg_temp.sg_hand_back('admin');
	perform pg_temp.base_assert(pg_temp.sg_listed('owner') -> 'generation' = to_jsonb(v_start + 2)
			and pg_temp.sg_listed('owner') -> 'control' = 'null'::jsonb,
		'1: a hand-back moves it again: ' || coalesce(pg_temp.sg_listed('owner')::text, 'none'));
end $$;

-- 2. The shared begin with a generation ---------------------------------------------------------------------------------------
do $$
declare
	v_now bigint := pg_temp.sg_generation();
	v_differ text;
	v jsonb;
begin
	v_differ := pg_temp.sg_differ(jsonb_build_array(
		jsonb_build_array('an older generation', pg_temp.sg_share('owner', v_now - 1), pg_temp.sg_refused('DESKTOP_HELD_SINCE')),
		jsonb_build_array('a newer one', pg_temp.sg_share('owner', v_now + 1), pg_temp.sg_refused('DESKTOP_HELD_SINCE')),
		jsonb_build_array('none', pg_temp.sg_share('owner', null), '22023:Machine desktop action is malformed'),
		jsonb_build_array('below 0', pg_temp.sg_share('owner', -1), '22023:Machine desktop action is malformed'),
		-- Every check before it says what it said before, whatever the generation.
		jsonb_build_array('a viewer at an older one', pg_temp.sg_share('viewer', v_now - 1), '42501:Machine desktop is unavailable'),
		jsonb_build_array('a stranger at an older one', pg_temp.sg_share('outsider', v_now - 1), '42501:Machine desktop is unavailable'),
		jsonb_build_array('asleep at an older one', pg_temp.sg_share('owner', v_now - 1, 'a2'), pg_temp.sg_refused('MACHINE_NOT_RUNNING')),
		jsonb_build_array('the service role', pg_temp.sg_service(format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L, %s)', '92400000-0000-4000-8000-000000000010',
			pg_temp.sg_id('a1'), '{"type": "click", "x": 4, "y": 4}', v_now)),
			'42501:permission denied for function qorpera_member_machine_desktop_share_begin')));
	perform pg_temp.base_assert(v_differ = '', E'2: answers that differ:\n' || v_differ);
	perform pg_temp.base_assert(pg_temp.sg_rows() = 0, '2: nothing recorded for a refused one');
	-- A live hold says so first, at any generation.
	perform pg_temp.sg_take('contributor');
	perform pg_temp.base_assert(pg_temp.sg_share('owner', v_now) = pg_temp.sg_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.sg_share('owner', pg_temp.sg_generation()) = pg_temp.sg_refused('DESKTOP_MEMBER_IN_CONTROL'),
		'2: a live hold is told as before');
	perform pg_temp.sg_hand_back('contributor');
	-- At the current generation it is taken, and its row holds that generation as its seat.
	v := pg_temp.sg_answer(pg_temp.sg_share('owner', pg_temp.sg_generation()));
	perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.sg_rows() = 1
			and (select seat from public.qorpera_company_machine_desktop_actions where id = (v ->> 'actionId')::uuid)
				= pg_temp.sg_generation(),
		'2: taken at the current generation: ' || coalesce(v::text, 'none'));
end $$;

-- 3. A private hold taken and given back between two reads refuses every input made before it ------------------------------
do $$
declare
	v_made bigint;
	v jsonb;
	v_auth jsonb;
begin
	-- The owner's window read the list: the input is made under this generation.
	v_made := (pg_temp.sg_listed('owner') ->> 'generation')::bigint;
	-- Another member types privately and gives it back before the owner's window reads again.
	perform pg_temp.sg_take('admin');
	perform pg_temp.sg_hand_back('admin');
	perform pg_temp.base_assert(pg_temp.sg_listed('owner') -> 'control' = 'null'::jsonb
			and pg_temp.sg_share('owner', v_made) = pg_temp.sg_refused('DESKTOP_HELD_SINCE'),
		'3: another member''s hold since the input was made refuses it');
	-- The owner's own hold in another window of theirs, taken and given back.
	v_made := (pg_temp.sg_listed('owner') ->> 'generation')::bigint;
	perform pg_temp.sg_take('owner');
	perform pg_temp.sg_hand_back('owner');
	perform pg_temp.base_assert(pg_temp.sg_share('owner', v_made) = pg_temp.sg_refused('DESKTOP_HELD_SINCE'),
		'3: the member''s own hold elsewhere refuses it too');
	-- The window reads again and goes on under the new generation; the executor's read serves it.
	v := pg_temp.sg_answer(pg_temp.sg_share('owner', (pg_temp.sg_listed('owner') ->> 'generation')::bigint));
	v_auth := pg_temp.sg_answer(pg_temp.sg_auth((v ->> 'actionId')::uuid));
	perform pg_temp.base_assert(v ->> 'state' = 'ok' and v_auth ->> 'state' = 'authorized' and v_auth -> 'shared' = 'true'::jsonb,
		'3: under the new generation it goes: ' || coalesce(v_auth::text, 'none'));
end $$;

-- 4. Without a generation (a window from before the web deploy): served as today --------------------------------------------
do $$
declare v jsonb;
begin
	perform pg_temp.sg_take('admin');
	perform pg_temp.base_assert(pg_temp.sg_share_old('owner') = pg_temp.sg_refused('DESKTOP_MEMBER_IN_CONTROL'),
		'4: a live hold refuses it, as today');
	perform pg_temp.sg_hand_back('admin');
	v := pg_temp.sg_answer(pg_temp.sg_share_old('owner'));
	perform pg_temp.base_assert(v ->> 'state' = 'ok'
			and pg_temp.sg_answer(pg_temp.sg_auth((v ->> 'actionId')::uuid)) ->> 'state' = 'authorized',
		'4: after the hold it is taken and served, as today: ' || coalesce(v::text, 'none'));
end $$;

-- 5. A hold between the begin and the executor's read still stops it --------------------------------------------------------
do $$
declare v jsonb := pg_temp.sg_answer(pg_temp.sg_share('owner', pg_temp.sg_generation()));
begin
	perform pg_temp.sg_take('contributor');
	perform pg_temp.sg_hand_back('contributor');
	perform pg_temp.base_assert(v ->> 'state' = 'ok' and pg_temp.sg_auth((v ->> 'actionId')::uuid)
			= 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL')::text,
		'5: a hold given back between the begin and the read refuses it, as before');
end $$;

-- 6. The grants, the two signatures, one body, the markers --------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)', 'execute'),
		'6: members call it, no one else');
	-- Called by their argument names, as PostgREST calls them: three names reach the old begin, four the new; never both.
	perform pg_temp.base_assert(pg_temp.sg_as(pg_temp.sg_user('owner'), format(
			'select public.qorpera_member_machine_desktop_share_begin(p_profile_id => %L, p_machine_id => %L, p_action => %L)',
			'92400000-0000-4000-8000-000000000010', pg_temp.sg_id('a1'), '{"type": "click", "x": 4, "y": 4}')) like 'ok:%"state": "ok"%'
		and pg_temp.sg_as(pg_temp.sg_user('owner'), format(
			'select public.qorpera_member_machine_desktop_share_begin(p_profile_id => %L, p_machine_id => %L, p_action => %L, p_generation => %s)',
			'92400000-0000-4000-8000-000000000010', pg_temp.sg_id('a1'), '{"type": "click", "x": 4, "y": 4}', pg_temp.sg_generation() + 5))
			= pg_temp.sg_refused('DESKTOP_HELD_SINCE'),
		'6: told apart by their argument names');
	perform pg_temp.base_assert(pg_temp.sg_differ(jsonb_build_array(
		jsonb_build_array('three names: an open', pg_temp.sg_as(pg_temp.sg_user('owner'), format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			pg_temp.sg_id('a1'), '{"type": "open", "target": "https://example.com"}')), '22023:Machine desktop action is malformed'),
		jsonb_build_array('four names: an open', pg_temp.sg_as(pg_temp.sg_user('owner'), format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L, %s)', '92400000-0000-4000-8000-000000000010',
			pg_temp.sg_id('a1'), '{"type": "open", "target": "https://example.com"}', pg_temp.sg_generation())),
			'22023:Machine desktop action is malformed'),
		jsonb_build_array('three names: asleep', pg_temp.sg_as(pg_temp.sg_user('owner'), format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			pg_temp.sg_id('a2'), '{"type": "click", "x": 4, "y": 4}')), pg_temp.sg_refused('MACHINE_NOT_RUNNING')),
		jsonb_build_array('four names: asleep', pg_temp.sg_share('owner', pg_temp.sg_generation(), 'a2'),
			pg_temp.sg_refused('MACHINE_NOT_RUNNING')),
		jsonb_build_array('three names: a viewer', pg_temp.sg_share_old('viewer'), '42501:Machine desktop is unavailable'),
		jsonb_build_array('four names: a viewer', pg_temp.sg_share('viewer', pg_temp.sg_generation()),
			'42501:Machine desktop is unavailable'))) = '',
		'6: both signatures make the same checks');
end $$;
