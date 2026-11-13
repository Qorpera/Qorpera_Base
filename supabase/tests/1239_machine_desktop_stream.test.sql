-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930745000: the live picture's release cycle (qorpera_member_machine_stream_release). On 924's base (an owner, a
-- contributor, a viewer, an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1239, a
-- stopped one and a running small one:
-- 1. a shared stream: owners, admins and contributors at the generation that stands; a viewer, a stranger refused
--    (STREAM_NOT_ALLOWED); another boot, another placement (MACHINE_NOT_RUNNING); malformed forms; the members' own call
--    refused;
-- 2. a private hold: the holder's own stream under its epoch and seat; anyone else's shared stream refused meanwhile
--    (DESKTOP_MEMBER_IN_CONTROL); after the hand-back the private one is DESKTOP_CONTROL_ENDED and the shared one of the
--    generation before DESKTOP_HELD_SINCE, the one of the new generation released;
-- 3. a member made a viewer: STREAM_NOT_ALLOWED at the next cycle;
-- 4. the disk's rules: without the root a disk that has had a view shows nothing (MACHINE_NEEDS_COMPANY_VIEW); a read of
--    the machine's that the member may not read raises member-unreadable, and the owner who may is released;
-- 5. read only: stable, and a cycle changes no row;
-- 6. the grants and the marker.

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
	('12390000-0000-4000-8000-0000000007a1'::uuid, 'm-1239', '12390000-0000-4000-8000-0000000008a1'::uuid, 2, 4294967296::bigint, 'running'),
	('12390000-0000-4000-8000-0000000007a2', 'm-1239-asleep', '12390000-0000-4000-8000-0000000008a2', 2, 4294967296, 'stopped'),
	('12390000-0000-4000-8000-0000000007a3', 'm-1239-small', '12390000-0000-4000-8000-0000000008a3', 1, 2147483648, 'running')
) as machine(id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12390000-0000-4000-8000-0000000007b' || n)::uuid, ('12390000-0000-4000-8000-0000000007a' || n)::uuid,
	'92400000-0000-4000-8000-000000000010', 'mx-1239', repeat('8', 64), '{"providerId": "machine-1239"}', repeat(n::text, 64),
	clock_timestamp(), ('12390000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 3]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12390000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12390000-0000-4000-8000-0000000007d1', 'machine', 'machine-1239', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12390000-%';
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.st_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.st_try(text) to authenticated, service_role;
create function pg_temp.st_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
create function pg_temp.st_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.st_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.st_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.st_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.st_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12390000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.st_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.st_machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.st_id('a1')
$$;
create function pg_temp.st_generation() returns bigint language sql as $$
	select (pg_temp.st_machine()).desktop_member_generation
$$;
create function pg_temp.st_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused', 'reason', p_reason)::text
$$;
create function pg_temp.st_auth_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
		'reason', p_reason)::text
$$;
-- A pass: shared under `generation`, or private under (`epoch`, `seat`).
create function pg_temp.st_begin(p_who text, p_generation bigint, p_epoch bigint default null, p_seat bigint default null,
	p_machine text default 'a1') returns text language sql as $$
	select pg_temp.st_as(pg_temp.st_user(p_who), format(
		'select public.qorpera_member_machine_desktop_pointer_begin(%L, %L, %s, %s, %s)', '92400000-0000-4000-8000-000000000010',
		pg_temp.st_id(p_machine), coalesce(p_generation::text, 'null'), coalesce(p_epoch::text, 'null'),
		coalesce(p_seat::text, 'null')))
$$;
create function pg_temp.st_pass(p_who text) returns uuid language plpgsql as $$
declare v text := pg_temp.st_begin(p_who, pg_temp.st_generation());
begin
	if pg_temp.st_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'No pass: %', v; end if;
	return (pg_temp.st_answer(v) ->> 'passId')::uuid;
end $$;
create function pg_temp.st_auth(p_pass uuid, p_owner text default 'mx-1239', p_provider text default 'machine-1239')
returns text language sql as $$
	select pg_temp.st_service(format('select public.qorpera_member_machine_desktop_pointer_authority(%L, %L, %L)', p_pass, p_owner,
		p_provider))
$$;
create function pg_temp.st_epoch(p_who text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.st_id('a1') and epochs.user_id = pg_temp.st_user(p_who)), 0)
$$;
create function pg_temp.st_take(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.st_as(pg_temp.st_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
	'92400000-0000-4000-8000-000000000010', pg_temp.st_id('a1'), pg_temp.st_epoch(p_who), pg_catalog.gen_random_uuid()));
begin
	if pg_temp.st_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The take-over did not hold: %', v; end if;
end $$;
create function pg_temp.st_hand_back(p_who text) returns void language plpgsql as $$
declare v text := pg_temp.st_as(pg_temp.st_user(p_who), format(
	'select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
	pg_temp.st_id('a1'), 'handed_back', pg_temp.st_epoch(p_who), pg_temp.st_generation()));
begin
	if pg_temp.st_answer(v) is null then raise exception 'The hand-back failed: %', v; end if;
end $$;
-- Moves the newest pass of a member back in time.
create function pg_temp.st_age(p_who text, p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_desktop_pointers set begun_at = begun_at - p_by
	where machine_id = pg_temp.st_id('a1') and user_id = pg_temp.st_user(p_who);
	set local session_replication_role = origin;
end $$;
create function pg_temp.st_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;


create function pg_temp.st_release(p_who text, p_generation bigint, p_epoch bigint default null, p_placement text default 'b1',
	p_boot text default 'c1') returns text language sql as $$
	select pg_temp.st_service(format('select public.qorpera_member_machine_stream_release(%L, %L, %L, %s, %s)',
		pg_temp.st_id(p_placement), pg_temp.st_id(p_boot), pg_temp.st_user(p_who), coalesce(p_generation::text, 'null'),
		coalesce(p_epoch::text, 'null')))
$$;
create function pg_temp.st_ok() returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'ok')::text
$$;
create function pg_temp.st_no(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
		'reason', p_reason)::text
$$;
-- With its detail, for the read check's refusal.
create function pg_temp.st_try_detail(p_sql text) returns text language plpgsql as $$
declare v jsonb; v_detail text;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	get stacked diagnostics v_detail = pg_exception_detail;
	return sqlstate || ':' || sqlerrm || '|' || coalesce(v_detail, '');
end $$;
grant execute on function pg_temp.st_try_detail(text) to service_role;
create function pg_temp.st_release_detail(p_who text, p_generation bigint) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.st_try_detail(format('select public.qorpera_member_machine_stream_release(%L, %L, %L, %s, null)',
		pg_temp.st_id('b1'), pg_temp.st_id('c1'), pg_temp.st_user(p_who), p_generation));
	reset role;
	return v;
end $$;

-- The checks start here

-- 1. A shared stream -----------------------------------------------------------------------------------------------------------
select set_config('qorpera_test.st_1', pg_temp.st_differ(jsonb_build_array(
	jsonb_build_array('the owner', pg_temp.st_release('owner', pg_temp.st_generation()), pg_temp.st_ok()),
	jsonb_build_array('a contributor', pg_temp.st_release('contributor', pg_temp.st_generation()), pg_temp.st_ok()),
	jsonb_build_array('the admin', pg_temp.st_release('admin', pg_temp.st_generation()), pg_temp.st_ok()),
	jsonb_build_array('a viewer', pg_temp.st_release('viewer', pg_temp.st_generation()), pg_temp.st_no('STREAM_NOT_ALLOWED')),
	jsonb_build_array('a stranger', pg_temp.st_release('outsider', pg_temp.st_generation()), pg_temp.st_no('STREAM_NOT_ALLOWED')),
	jsonb_build_array('another boot', pg_temp.st_release('owner', pg_temp.st_generation(), null, 'b1', 'c3'),
		pg_temp.st_no('MACHINE_NOT_RUNNING')),
	jsonb_build_array('a generation that is not the one now', pg_temp.st_release('owner', pg_temp.st_generation() + 1),
		pg_temp.st_no('DESKTOP_HELD_SINCE')),
	jsonb_build_array('no placement at all', pg_temp.st_service(format(
		'select public.qorpera_member_machine_stream_release(%L, %L, %L, 0, null)', pg_temp.st_id('b9'), pg_temp.st_id('c1'),
		pg_temp.st_user('owner'))), '42501:Machine desktop stream is unavailable'),
	jsonb_build_array('a negative generation', pg_temp.st_release('owner', -1), '22023:Machine desktop stream request is malformed'),
	jsonb_build_array('a negative epoch', pg_temp.st_release('owner', 0, -1), '22023:Machine desktop stream request is malformed'),
	jsonb_build_array('no generation', pg_temp.st_release('owner', null), '22023:Machine desktop stream request is malformed'),
	jsonb_build_array('a member''s own call', pg_temp.st_as(pg_temp.st_user('owner'), format(
		'select public.qorpera_member_machine_stream_release(%L, %L, %L, 0, null)', pg_temp.st_id('b1'), pg_temp.st_id('c1'),
		pg_temp.st_user('owner'))), '42501:permission denied for function qorpera_member_machine_stream_release')
)), true);
do $$ begin
	perform pg_temp.base_assert(current_setting('qorpera_test.st_1') = '', E'1: answers that differ:\n' || current_setting('qorpera_test.st_1'));
end $$;

-- 2. A private hold ---------------------------------------------------------------------------------------------------------------
do $$
declare v_before bigint := pg_temp.st_generation(); v_seat bigint; v_epoch bigint;
begin
	perform pg_temp.st_take('contributor');
	v_seat := pg_temp.st_generation();
	v_epoch := pg_temp.st_epoch('contributor');
	perform pg_temp.base_assert(pg_temp.st_release('contributor', v_seat, v_epoch) = pg_temp.st_ok(),
		'2: the holder''s own stream under its epoch and seat');
	perform pg_temp.base_assert(pg_temp.st_release('owner', v_seat, v_epoch) = pg_temp.st_no('DESKTOP_CONTROL_ENDED'),
		'2: another member''s stream at the holder''s epoch and seat');
	perform pg_temp.base_assert(pg_temp.st_release('contributor', v_seat, v_epoch + 1) = pg_temp.st_no('DESKTOP_CONTROL_ENDED'),
		'2: the holder at another epoch');
	perform pg_temp.base_assert(pg_temp.st_release('contributor', v_seat + 1, v_epoch) = pg_temp.st_no('DESKTOP_CONTROL_ENDED'),
		'2: the holder in another seat');
	perform pg_temp.base_assert(pg_temp.st_release('owner', v_seat) = pg_temp.st_no('DESKTOP_MEMBER_IN_CONTROL'),
		'2: a shared stream while someone holds the desktop privately');
	perform pg_temp.base_assert(pg_temp.st_release('contributor', v_seat) = pg_temp.st_no('DESKTOP_MEMBER_IN_CONTROL'),
		'2: the holder''s own shared stream from another window');
	perform pg_temp.st_hand_back('contributor');
	perform pg_temp.base_assert(pg_temp.st_release('contributor', v_seat, v_epoch) = pg_temp.st_no('DESKTOP_CONTROL_ENDED'),
		'2: the private stream after the hand-back');
	perform pg_temp.base_assert(pg_temp.st_release('owner', v_before) = pg_temp.st_no('DESKTOP_HELD_SINCE'),
		'2: a shared stream of the generation before the hold');
	perform pg_temp.base_assert(pg_temp.st_release('owner', pg_temp.st_generation()) = pg_temp.st_ok(),
		'2: one of the generation that stands');
end $$;

-- 3. A member made a viewer -------------------------------------------------------------------------------------------------------
do $$
begin
	set local session_replication_role = replica;
	update public.qorpera_profile_members set role = 'viewer'
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.st_user('admin');
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.st_release('admin', pg_temp.st_generation()) = pg_temp.st_no('STREAM_NOT_ALLOWED'),
		'3: a member made a viewer is shown nothing more');
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;

-- 4. The disk's rules ------------------------------------------------------------------------------------------------------------
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.st_view', public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020',
	'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', pg_temp.st_id('a1'),
		'placementId', pg_temp.st_id('b1'), 'bootId', pg_temp.st_id('c1')))::text, true);
do $$
begin
	perform pg_temp.base_assert(pg_temp.st_release('contributor', pg_temp.st_generation()) = pg_temp.st_ok(),
		'4: a disk with a view, read by no one yet');
	begin
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.st_release('contributor', pg_temp.st_generation())
				= pg_temp.st_no('MACHINE_NEEDS_COMPANY_VIEW'),
			'4: without the root, nothing of a disk that has had a view');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;
-- The owner's private folder, which only she reads; the machine's view read a file of it.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
	created_by_user_id)
select '92400000-0000-4000-8000-000000000020', 'members/92400000-0000-4000-8000-000000000001/private', 'subtree',
	'member_private', '92400000-0000-4000-8000-000000000001', 'normal', '92400000-0000-4000-8000-000000000001'
where not exists (select 1 from public.qorpera_company_path_resources where environment_id = '92400000-0000-4000-8000-000000000020'
	and path = 'members/92400000-0000-4000-8000-000000000001/private');
insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
values ((current_setting('qorpera_test.st_view')::jsonb ->> 'viewId')::uuid, '12390000-0000-4000-8000-000000000501',
	'92400000-0000-4000-8000-000000000020', '12390000-0000-4000-8000-000000000502',
	'[{"path": "notes/plan.md"}, {"path": "members/92400000-0000-4000-8000-000000000001/private/salary.md"}]', repeat('0', 64));
select set_config('session_replication_role', 'origin', true);
do $$
declare v text;
begin
	v := pg_temp.st_release_detail('contributor', pg_temp.st_generation());
	perform pg_temp.base_assert(v = '42501:A read is not readable to the member|qorpera.test-machine/member-unreadable',
		'4: a read the member may not read stops the stream: ' || v);
	v := pg_temp.st_release_detail('owner', pg_temp.st_generation());
	perform pg_temp.base_assert(v = pg_temp.st_ok() || '', '4: the owner, who reads it, is released: ' || v);
end $$;

-- 5. Read only -------------------------------------------------------------------------------------------------------------------
do $$
declare v_machine jsonb := to_jsonb(pg_temp.st_machine()); v_rows bigint;
begin
	perform pg_temp.base_assert((select provolatile from pg_proc
			where oid = 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)'::regprocedure) = 's',
		'5: stable');
	v_rows := (select count(*) from public.qorpera_company_machine_desktop_actions) +
		(select count(*) from public.qorpera_company_machine_desktop_pointers) +
		(select count(*) from public.qorpera_company_machine_screen_watches);
	perform pg_temp.st_release('owner', pg_temp.st_generation());
	perform pg_temp.st_release('viewer', pg_temp.st_generation());
	perform pg_temp.base_assert(to_jsonb(pg_temp.st_machine()) = v_machine, '5: the machine''s row is as it was');
	perform pg_temp.base_assert((select count(*) from public.qorpera_company_machine_desktop_actions) +
			(select count(*) from public.qorpera_company_machine_desktop_pointers) +
			(select count(*) from public.qorpera_company_machine_screen_watches) = v_rows,
		'5: no action, pass or watch was recorded');
end $$;

-- 6. The grants and the marker ---------------------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)', 'execute'),
		'6: the machine''s node alone reads it');
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)'::regprocedure),
		'20260930745000') > 0, '6: the marker');
end $$;
