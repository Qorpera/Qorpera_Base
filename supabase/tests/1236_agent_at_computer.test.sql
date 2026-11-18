-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930742000: the members see when an agent is using its desktop computer. On 924's base (an owner, a contributor, a
-- viewer, an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1236 and a stopped one:
-- 1. a member's start, look, private action (take-over, act, hand back) and shared input (20260930734000 and its
--    generation, 20260930738000), and the executor's reads of them, never write the agent's stamp, also on a screen whose
--    screen_used_at a member's start just stamped; the list shows nothing;
-- 2. the agent's look stamps it at once (even right after a member's start stamped screen_used_at), begins a stretch and
--    sends the `machines` hint to every member;
-- 3. the list: every member who reads the company (viewers too) sees the agent, the machine, the stretch's start, the last
--    call and the window's end (90 s after it) with the database's time; an outsider is refused, and only members may call
--    it;
-- 4. within 30 seconds nothing is written; later the last call moves, the stretch stays, no hint;
-- 5. the member paths again on a screen in use: the stamp stays exactly as it was;
-- 6. while a member holds the desktop the agent is refused and nothing is stamped, and the list leaves the machine out;
-- 7. past the window the list is empty, and the next look begins a new stretch with a hint;
-- 8. a stopped machine, or an agent no longer on the staff, is never listed;
-- 9. the window's one place (90 s), the grants, the hint trigger's columns and the markers.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'ac-ack') is not null;

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
	('12360000-0000-4000-8000-0000000007a1'::uuid, 'm-1236', '12360000-0000-4000-8000-0000000008a1'::uuid, 'running'),
	('12360000-0000-4000-8000-0000000007a2', 'm-1236-asleep', '12360000-0000-4000-8000-0000000008a2', 'stopped')
) as machine(id, name, receipt_id, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
values ('12360000-0000-4000-8000-0000000007b1', '12360000-0000-4000-8000-0000000007a1', '92400000-0000-4000-8000-000000000010',
	'mx-1236', repeat('8', 64), '{"providerId": "machine-1236"}', repeat('1', 64), clock_timestamp(),
	'12360000-0000-4000-8000-0000000007c1');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
values ('12360000-0000-4000-8000-0000000007b1', '92400000-0000-4000-8000-000000000010', '12360000-0000-4000-8000-0000000007b1',
	'lxd', repeat('1', 64), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
values ('12360000-0000-4000-8000-0000000007b1', '12360000-0000-4000-8000-0000000007d1', 'machine', 'machine-1236',
	repeat('4', 64), 2000, 4294967296, clock_timestamp());
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.ac_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.ac_try(text) to authenticated, service_role;
create function pg_temp.ac_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A call as one member (authenticated), as the service role, or signed out.
create function pg_temp.ac_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.ac_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.ac_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.ac_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.ac_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12360000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.ac_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.ac_machine(p_machine text default 'a1') returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.ac_id(p_machine)
$$;
-- The agent's stamp on m-1236 (or another machine): its last call and its stretch's start.
create function pg_temp.ac_stamp(p_machine text default 'a1') returns text language sql as $$
	select format('%s|%s', (pg_temp.ac_machine(p_machine)).screen_agent_used_at, (pg_temp.ac_machine(p_machine)).screen_agent_since)
$$;
-- Moves a machine's columns (as if time passed).
create function pg_temp.ac_shift(p_machine text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, pg_temp.ac_id(p_machine));
	set local session_replication_role = origin;
end $$;
-- The agent's look at m-1236 (the coding executor's read of Alice's machine_screen call), as the service role.
create function pg_temp.ac_look() returns text language sql as $$
	select pg_temp.ac_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.ac_id('a1'))))
$$;
-- The company's screens in use, as a member sees them.
create function pg_temp.ac_list(p_who text) returns text language sql as $$
	select pg_temp.ac_as(pg_temp.ac_user(p_who), format('select public.qorpera_list_company_screens_in_use(%L)',
		'92400000-0000-4000-8000-000000000010'))
$$;
create function pg_temp.ac_screens(p_who text) returns jsonb language sql as $$
	select pg_temp.ac_answer(pg_temp.ac_list(p_who)) -> 'screens'
$$;
-- A member's hand-back epoch for m-1236 (0 while they have no row).
create function pg_temp.ac_epoch(p_who text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.ac_id('a1') and epochs.user_id = pg_temp.ac_user(p_who)), 0)
$$;
-- A take-over of m-1236 at the member's current epoch (its answer), and a hand-back of their hold (EXACT, by its seat).
create function pg_temp.ac_take(p_who text) returns jsonb language plpgsql as $$
declare v text := pg_temp.ac_as(pg_temp.ac_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
	'92400000-0000-4000-8000-000000000010', pg_temp.ac_id('a1'), pg_temp.ac_epoch(p_who), pg_catalog.gen_random_uuid()));
begin
	if pg_temp.ac_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The take-over did not hold: %', v; end if;
	return pg_temp.ac_answer(v);
end $$;
create function pg_temp.ac_hand_back(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.ac_as(pg_temp.ac_user(p_who), format(
	'select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
	pg_temp.ac_id('a1'), 'handed_back', pg_temp.ac_epoch(p_who), (pg_temp.ac_machine('a1')).desktop_member_generation));
begin
	if pg_temp.ac_answer(v) is null then raise exception 'The hand-back failed: %', v; end if;
end $$;
-- Every member path that touches the desktop, each one taken (an answer 'ok' / 'authorized' where it begins and where the
-- executor reads it); a list of what was not.
create function pg_temp.ac_member_paths() returns text language plpgsql as $$
declare
	v_failed text[] := '{}';
	v jsonb;
	v_epoch bigint;
	v_hold jsonb;
begin
	-- A member's desktop start (20260930714000), past its 5-second floor, and the executor's read of it.
	set local session_replication_role = replica;
	update public.qorpera_company_machine_desktop_starts set begun_at = begun_at - interval '10 seconds'
	where machine_id = pg_temp.ac_id('a1');
	update public.qorpera_company_machine_screen_watches set last_look_at = last_look_at - interval '10 seconds'
	where machine_id = pg_temp.ac_id('a1');
	set local session_replication_role = origin;
	v := pg_temp.ac_answer(pg_temp.ac_as(pg_temp.ac_user('owner'), format(
		'select public.qorpera_member_machine_desktop_start_begin(%L, %L)', '92400000-0000-4000-8000-000000000010', pg_temp.ac_id('a1'))));
	if v ->> 'state' is distinct from 'ok' then v_failed := v_failed || ('start ' || coalesce(v::text, 'none')); end if;
	v := pg_temp.ac_answer(pg_temp.ac_service(format('select public.qorpera_member_machine_desktop_start_authority(%L, %L, %L)',
		v ->> 'startId', 'mx-1236', 'machine-1236')));
	if v ->> 'state' is distinct from 'authorized' then v_failed := v_failed || ('start read ' || coalesce(v::text, 'none')); end if;
	-- A member's look (a viewer's too), and the executor's read of it.
	foreach v_epoch in array array[1, 3] loop
		v := pg_temp.ac_answer(pg_temp.ac_as(pg_temp.ac_user(case v_epoch when 1 then 'owner' else 'viewer' end), format(
			'select public.qorpera_member_machine_screen_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			pg_temp.ac_id('a1'), '{"confirmed": true}')));
		if v ->> 'useId' is null then v_failed := v_failed || ('look ' || coalesce(v::text, 'none')); end if;
		v := pg_temp.ac_answer(pg_temp.ac_service(format('select public.qorpera_member_machine_screen_authority(%L, %L, %L)',
			v ->> 'useId', 'mx-1236', 'machine-1236')));
		if v ->> 'state' is distinct from 'authorized' then v_failed := v_failed || ('look read ' || coalesce(v::text, 'none')); end if;
	end loop;
	-- A private action: take-over, an action and its read, the hand-back.
	v_epoch := pg_temp.ac_epoch('admin');
	v_hold := pg_temp.ac_take('admin');
	v := pg_temp.ac_answer(pg_temp.ac_as(pg_temp.ac_user('admin'), format(
		'select public.qorpera_member_machine_desktop_act_begin(%L, %L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.ac_id('a1'), '{"type": "click", "x": 4, "y": 4}', v_epoch, v_hold -> 'seat')));
	if v ->> 'state' is distinct from 'ok' then v_failed := v_failed || ('private act ' || coalesce(v::text, 'none')); end if;
	v := pg_temp.ac_answer(pg_temp.ac_service(format('select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)',
		v ->> 'actionId', 'mx-1236', 'machine-1236')));
	if v ->> 'state' is distinct from 'authorized' then v_failed := v_failed || ('private act read ' || coalesce(v::text, 'none')); end if;
	perform pg_temp.ac_hand_back('admin');
	-- Shared input, without a generation (20260930734000) and with one (20260930738000), and the executor's reads.
	foreach v_epoch in array array[0, 1] loop
		v := pg_temp.ac_answer(pg_temp.ac_as(pg_temp.ac_user('contributor'), case v_epoch when 0 then format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			pg_temp.ac_id('a1'), '{"type": "click", "x": 4, "y": 4}') else format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L, %s)', '92400000-0000-4000-8000-000000000010',
			pg_temp.ac_id('a1'), '{"type": "click", "x": 4, "y": 4}', (pg_temp.ac_machine('a1')).desktop_member_generation) end));
		if v ->> 'state' is distinct from 'ok' then v_failed := v_failed || ('shared ' || v_epoch || ' ' || coalesce(v::text, 'none')); end if;
		v := pg_temp.ac_answer(pg_temp.ac_service(format('select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)',
			v ->> 'actionId', 'mx-1236', 'machine-1236')));
		if v ->> 'state' is distinct from 'authorized' then
			v_failed := v_failed || ('shared read ' || v_epoch || ' ' || coalesce(v::text, 'none')); end if;
	end loop;
	return array_to_string(v_failed, E'\n');
end $$;
-- The `machines` hints sent to the company's members, as event:member, sorted (as 1202 reads them).
create function pg_temp.ac_hints() returns text language sql as $$
	select coalesce(string_agg(label, ' ' order by label collate "C"), '')
	from (select message.event || ':' || substring(message.topic from 51) as label from realtime.messages as message
		where message.topic like 'qorpera-live-%' and message.event = 'machines') as hint
$$;
create function pg_temp.ac_clear() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;
-- What a commit would send now: the deferred hints fire.
create function pg_temp.ac_flush() returns void language plpgsql as $$
begin
	set constraints qorpera_machine_hint, qorpera_machine_hint_change immediate;
	set constraints qorpera_machine_hint, qorpera_machine_hint_change deferred;
end $$;
-- The agent's look, and the hints it sends at commit: '<look state>/<hints>'.
create function pg_temp.ac_look_hinted() returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.ac_flush();
	perform pg_temp.ac_clear();
	v := coalesce(pg_temp.ac_answer(pg_temp.ac_look()) ->> 'state', pg_temp.ac_look());
	perform pg_temp.ac_flush();
	v := v || '/' || pg_temp.ac_hints();
	perform pg_temp.ac_clear();
	return v;
end $$;
select set_config('qorpera_test.ac_all', 'machines:92400000-0000-4000-8000-000000000001 '
	|| 'machines:92400000-0000-4000-8000-000000000002 machines:92400000-0000-4000-8000-000000000003 '
	|| 'machines:92400000-0000-4000-8000-000000000004', true);

-- 1. A member's paths never write the agent's stamp ---------------------------------------------------------------------------
do $$
declare v_failed text := pg_temp.ac_member_paths();
begin
	perform pg_temp.base_assert(v_failed = '', E'1: every member path is taken:\n' || v_failed);
	perform pg_temp.base_assert((pg_temp.ac_machine('a1')).screen_used_at > clock_timestamp() - interval '1 minute'
			and (pg_temp.ac_machine('a1')).screen_staff_agent_id = '92400000-0000-4000-8000-000000000030',
		'1: the member''s start stamped screen_used_at as Alice''s (20260930714000)');
	perform pg_temp.base_assert(pg_temp.ac_stamp() = '|', '1: no member path wrote the agent''s stamp: ' || pg_temp.ac_stamp());
	perform pg_temp.base_assert(pg_temp.ac_screens('owner') = '[]'::jsonb, '1: nothing is listed: ' || pg_temp.ac_list('owner'));
end $$;

-- 2. The agent's look stamps it at once, begins a stretch and hints ------------------------------------------------------------
do $$
declare v text := pg_temp.ac_look_hinted();
begin
	perform pg_temp.base_assert(v = 'authorized/' || current_setting('qorpera_test.ac_all'),
		'2: the look is allowed and every member is hinted: ' || v);
	perform pg_temp.base_assert((pg_temp.ac_machine('a1')).screen_agent_used_at > clock_timestamp() - interval '1 minute'
			and (pg_temp.ac_machine('a1')).screen_agent_since = (pg_temp.ac_machine('a1')).screen_agent_used_at,
		'2: stamped at once though screen_used_at was fresh, its stretch begun: ' || pg_temp.ac_stamp());
end $$;

-- 3. The list ---------------------------------------------------------------------------------------------------------------
do $$
declare
	v_owner jsonb := pg_temp.ac_answer(pg_temp.ac_list('owner'));
	v_machine public.qorpera_company_machines := pg_temp.ac_machine('a1');
begin
	perform pg_temp.base_assert(v_owner ->> 'schema' = 'qorpera.company-screens-in-use/v1'
			and v_owner ->> 'profileId' = '92400000-0000-4000-8000-000000000010'
			and (v_owner ->> 'now')::timestamptz > clock_timestamp() - interval '1 minute'
			and v_owner -> 'screens' = jsonb_build_array(jsonb_build_object(
				'staffAgentId', '92400000-0000-4000-8000-000000000030', 'machineId', pg_temp.ac_id('a1'),
				'since', v_machine.screen_agent_since, 'usedAt', v_machine.screen_agent_used_at,
				'until', v_machine.screen_agent_used_at + interval '90 seconds')),
		'3: the owner sees Alice at m-1236 until 90 s after her call: ' || v_owner::text);
	perform pg_temp.base_assert(pg_temp.ac_screens('viewer') = v_owner -> 'screens'
			and pg_temp.ac_screens('contributor') = v_owner -> 'screens' and pg_temp.ac_screens('admin') = v_owner -> 'screens',
		'3: every member sees it, a viewer too');
	perform pg_temp.base_assert(pg_temp.ac_list('outsider') = '42501:Company is unavailable',
		'3: an outsider is refused: ' || pg_temp.ac_list('outsider'));
	perform pg_temp.base_assert(pg_temp.ac_service(format('select public.qorpera_list_company_screens_in_use(%L)',
			'92400000-0000-4000-8000-000000000010')) = '42501:permission denied for function qorpera_list_company_screens_in_use',
		'3: the service role may not call it');
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_list_company_screens_in_use(uuid)', 'execute')
			and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_list_company_screens_in_use(uuid)', 'execute')
			and has_function_privilege('authenticated', 'public.qorpera_list_company_screens_in_use(uuid)', 'execute'),
		'3: members alone call it');
end $$;

-- 4. Within 30 seconds nothing is written; later the last call moves and the stretch stays --------------------------------------
do $$
declare
	v_before text := pg_temp.ac_stamp();
	v_since timestamptz := (pg_temp.ac_machine('a1')).screen_agent_since;
	v text;
begin
	v := pg_temp.ac_look_hinted();
	perform pg_temp.base_assert(v = 'authorized/' and pg_temp.ac_stamp() = v_before,
		'4: a look within 30 s writes nothing and hints no one: ' || v || ' ' || pg_temp.ac_stamp());
	perform pg_temp.ac_shift('a1', 'screen_agent_used_at = screen_agent_used_at - interval ''40 seconds'', '
		|| 'screen_agent_since = screen_agent_since - interval ''40 seconds'', screen_used_at = screen_used_at - interval ''40 seconds''');
	v := pg_temp.ac_look_hinted();
	perform pg_temp.base_assert(v = 'authorized/'
			and (pg_temp.ac_machine('a1')).screen_agent_used_at > clock_timestamp() - interval '10 seconds'
			and (pg_temp.ac_machine('a1')).screen_agent_since = v_since - interval '40 seconds',
		'4: 40 s later the last call moves, the stretch stays, no hint: ' || v || ' ' || pg_temp.ac_stamp());
end $$;

-- 5. The member paths again, on a screen in use ----------------------------------------------------------------------------------
do $$
declare
	v_before text := pg_temp.ac_stamp();
	v_failed text := pg_temp.ac_member_paths();
begin
	perform pg_temp.base_assert(v_failed = '', E'5: every member path is taken:\n' || v_failed);
	perform pg_temp.base_assert(pg_temp.ac_stamp() = v_before,
		'5: the stamp is exactly as it was: ' || v_before || ' -> ' || pg_temp.ac_stamp());
end $$;

-- 6. While a member holds the desktop the agent is refused, nothing is stamped, and the machine is not listed ------------------
do $$
declare v_before text;
begin
	perform pg_temp.ac_shift('a1', 'screen_agent_used_at = screen_agent_used_at - interval ''40 seconds'', '
		|| 'screen_used_at = screen_used_at - interval ''40 seconds''');
	v_before := pg_temp.ac_stamp();
	perform pg_temp.ac_take('contributor');
	perform pg_temp.base_assert(pg_temp.ac_answer(pg_temp.ac_look()) ->> 'reason' = 'DESKTOP_MEMBER_IN_CONTROL'
			and pg_temp.ac_stamp() = v_before,
		'6: the agent is refused and nothing is stamped: ' || pg_temp.ac_look() || ' ' || pg_temp.ac_stamp());
	perform pg_temp.base_assert(pg_temp.ac_screens('owner') = '[]'::jsonb and pg_temp.ac_screens('contributor') = '[]'::jsonb,
		'6: the held machine is not listed: ' || pg_temp.ac_list('owner'));
	perform pg_temp.ac_hand_back('contributor');
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.ac_screens('owner')) = 1, '6: after the hand-back it is listed again');
end $$;

-- 7. Past the window: nothing listed; the next look begins a new stretch, with a hint ------------------------------------------
do $$
declare v text;
begin
	perform pg_temp.ac_shift('a1', 'screen_agent_used_at = clock_timestamp() - interval ''91 seconds'', '
		|| 'screen_agent_since = clock_timestamp() - interval ''3 minutes'', screen_used_at = clock_timestamp() - interval ''91 seconds''');
	perform pg_temp.base_assert(pg_temp.ac_screens('owner') = '[]'::jsonb, '7: past the window nothing is listed');
	v := pg_temp.ac_look_hinted();
	perform pg_temp.base_assert(v = 'authorized/' || current_setting('qorpera_test.ac_all')
			and (pg_temp.ac_machine('a1')).screen_agent_since = (pg_temp.ac_machine('a1')).screen_agent_used_at
			and (pg_temp.ac_machine('a1')).screen_agent_since > clock_timestamp() - interval '10 seconds',
		'7: a new stretch begins, every member hinted: ' || v || ' ' || pg_temp.ac_stamp());
	-- 89 seconds after the last call it is still listed.
	perform pg_temp.ac_shift('a1', 'screen_agent_used_at = clock_timestamp() - interval ''89 seconds''');
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.ac_screens('owner')) = 1, '7: within the window it is listed');
end $$;

-- 8. A stopped machine, or an agent no longer on the staff, is never listed ------------------------------------------------------
do $$
begin
	perform pg_temp.ac_shift('a2', format('screen_staff_agent_id = %L, screen_agent_used_at = clock_timestamp(), '
		|| 'screen_agent_since = clock_timestamp()', '92400000-0000-4000-8000-000000000030'));
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(pg_temp.ac_screens('owner')) as s
			where s ->> 'machineId' = pg_temp.ac_id('a2')::text),
		'8: a stopped machine is not listed: ' || pg_temp.ac_list('owner'));
	perform pg_temp.ac_shift('a1', format('screen_staff_agent_id = %L', '12360000-0000-4000-8000-0000000009ff'));
	perform pg_temp.base_assert(pg_temp.ac_screens('owner') = '[]'::jsonb, '8: an agent not on the staff is not listed');
	perform pg_temp.ac_shift('a1', format('screen_staff_agent_id = %L', '92400000-0000-4000-8000-000000000030'));
	perform pg_temp.ac_shift('a1', 'desired_state = ''stopped''');
	perform pg_temp.base_assert(pg_temp.ac_screens('owner') = '[]'::jsonb, '8: a machine wanted off is not listed');
	perform pg_temp.ac_shift('a1', 'desired_state = ''running''');
end $$;

-- 9. The window, the trigger and the markers --------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(public.qorpera_machine_screen_in_use() = interval '90 seconds', '9: the window is 90 s');
	perform pg_temp.base_assert(not has_function_privilege('authenticated', 'public.qorpera_machine_screen_in_use()', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_machine_screen_in_use()', 'execute'),
		'9: the window is no one''s to call');
	-- Nothing but the agent's screen read writes the columns.
	perform pg_temp.base_assert(not exists (select 1 from pg_proc
			where pronamespace = 'public'::regnamespace and prosrc like '%screen_agent_used_at =%'
				and oid <> 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure),
		'9: only the agent''s screen read writes the stamp');
end $$;
