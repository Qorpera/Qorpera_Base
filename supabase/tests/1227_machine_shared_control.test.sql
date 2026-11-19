-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930734000: a member and the agent share the agent's desktop computer. On 924's base (an owner, a contributor, a
-- viewer, an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1227, a stopped one,
-- a running machine too small for a desktop and another company's running one:
-- 1. the shared begin: an owner, admin or contributor acts at once, with no hold; a viewer, a stranger and another
--    company's machine refused (42501); a malformed action (22023); the service role may not call it; too small
--    (DESKTOP_MACHINE_TOO_SMALL); stopped (MACHINE_NOT_RUNNING);
-- 2. what it records: the action without its text (a `type` by its length), shared, no lease row, the lease generation
--    as its seat; the member and the time on the machine; the machine's last use (at most every 30 seconds); the disk's
--    mark for a member without the folder's root; a disk that has had a view, for such a member, refused
--    (MACHINE_NEEDS_COMPANY_VIEW) with nothing recorded;
-- 3. a private hold (take-over), another member's or the caller's own, refuses shared input (DESKTOP_MEMBER_IN_CONTROL)
--    and the agent, as before; a private action is begun and read exactly as before; after the hand-back shared input is
--    let in again;
-- 4. the executor's read of a shared action: served once by the placement's own executor, saying `shared`; refused
--    (DESKTOP_MEMBER_IN_CONTROL) when a private hold began after the begin, live or begun and given back since;
--    unavailable when its member was made a viewer;
-- 5. at most 25 of one member's shared actions on one machine in 5 seconds; another member's are their own;
-- 6. shared rows older than 30 days go at the machine's next shared begin; the private ones stay;
-- 7. the agent: its look, its action and a command go on while members share the desktop; its screen reads after a
--    member's shared action say who, how long ago and when (memberTouched; never what was done; "A member" for one who
--    left the company) until the executor's word that an answer carrying it is ready (review r1 F4 of #1701), which
--    moves forward only, never past the newest action, and is the service role's alone;
-- 8. the window's list names the other members of the company who acted in the last 60 seconds (`others`), never the
--    caller, never one who left the company since (review r1 F3 of #1701);
-- 9. the grants, the check of a shared row and the markers.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'sc-ack') is not null;

-- The machines, started by Alice's run, last used an hour ago; the running ones run on their placements (reserved on a
-- node, as an executor's custody leaves them).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12270000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12270000-0000-4000-8000-0000000007e5', '12270000-0000-4000-8000-000000000011', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at)
select machine.id, machine.profile_id, machine.environment_id, machine.name, 'Tests the shop.', run.staff_agent_id,
	run.id, machine.receipt_id, run.requested_by_user_id, machine.cpus, machine.memory, 21474836480, 'standard', 'task',
	machine.desired_state, clock_timestamp() - interval '1 hour'
from public.qorpera_execution_runs as run
cross join (values
	-- Alice's desktop, running.
	('12270000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1227', '12270000-0000-4000-8000-0000000008a1'::uuid, 2,
		4294967296::bigint, 'running'),
	-- Asleep.
	('12270000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1227-asleep', '12270000-0000-4000-8000-0000000008a2', 2, 4294967296, 'stopped'),
	-- Running, too small for a desktop.
	('12270000-0000-4000-8000-0000000007a3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1227-small', '12270000-0000-4000-8000-0000000008a3', 1, 2147483648, 'running'),
	-- Another company's, running.
	('12270000-0000-4000-8000-0000000007a5', '12270000-0000-4000-8000-000000000011', '12270000-0000-4000-8000-0000000007e5',
		'm-1227', '12270000-0000-4000-8000-0000000008a5', 2, 4294967296, 'running')
) as machine(id, profile_id, environment_id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12270000-0000-4000-8000-0000000007b' || n)::uuid, ('12270000-0000-4000-8000-0000000007a' || n)::uuid,
	case when n = 5 then '12270000-0000-4000-8000-000000000011'::uuid else '92400000-0000-4000-8000-000000000010'::uuid end,
	'mx-1227', repeat('8', 64), '{"providerId": "machine-1227"}', repeat(n::text, 64), clock_timestamp(),
	('12270000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 3, 5]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12270000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12270000-0000-4000-8000-0000000007d1', 'machine', 'machine-1227', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12270000-%';
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.sc_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.sc_try(text) to authenticated, service_role;
create function pg_temp.sc_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A call as one member (authenticated), or as the service role.
create function pg_temp.sc_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.sc_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.sc_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.sc_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.sc_id(p_suffix text) returns uuid language sql immutable as $$
	select ('12270000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.sc_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.sc_name(p_who text) returns text language sql as $$
	select public.qorpera_review_member_name('92400000-0000-4000-8000-000000000010', pg_temp.sc_user(p_who))
$$;
create function pg_temp.sc_machine(p_machine text) returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.sc_id(p_machine)
$$;
-- Moves a machine's columns (as if time passed).
create function pg_temp.sc_shift(p_machine text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, pg_temp.sc_id(p_machine));
	set local session_replication_role = origin;
end $$;
-- Moves m-1227's actions back in time.
create function pg_temp.sc_age(p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_desktop_actions set begun_at = begun_at - p_by where machine_id = pg_temp.sc_id('a1');
	set local session_replication_role = origin;
end $$;
create function pg_temp.sc_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused', 'reason', p_reason)::text
$$;
create function pg_temp.sc_auth_refused(p_reason text) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
		'reason', p_reason)::text
$$;
-- A member's shared action on a machine (m-1227 unless named), a click unless an action is given.
create function pg_temp.sc_share(p_who text, p_machine text default 'a1', p_action jsonb default '{"type": "click", "x": 4, "y": 4}',
	p_profile uuid default '92400000-0000-4000-8000-000000000010') returns text language sql as $$
	select pg_temp.sc_as(pg_temp.sc_user(p_who), format('select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)',
		p_profile, pg_temp.sc_id(p_machine), p_action))
$$;
-- A shared action begun on m-1227, its id (or an exception).
create function pg_temp.sc_share_id(p_who text, p_action jsonb default '{"type": "click", "x": 4, "y": 4}') returns uuid
language plpgsql as $$
declare v text := pg_temp.sc_share(p_who, 'a1', p_action);
begin
	if pg_temp.sc_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The shared action was not begun: %', v; end if;
	return (pg_temp.sc_answer(v) ->> 'actionId')::uuid;
end $$;
create function pg_temp.sc_auth(p_action uuid, p_owner text default 'mx-1227', p_provider text default 'machine-1227')
returns text language sql as $$
	select pg_temp.sc_service(format('select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)', p_action, p_owner,
		p_provider))
$$;
-- A member's hand-back epoch for m-1227 (0 while they have no row).
create function pg_temp.sc_epoch(p_who text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.sc_id('a1') and epochs.user_id = pg_temp.sc_user(p_who)), 0)
$$;
-- A take-over of m-1227 at the member's current epoch, by a press of its own; a hand-back of their hold (EXACT, by its
-- seat).
create function pg_temp.sc_take(p_who text) returns text language sql as $$
	select pg_temp.sc_as(pg_temp.sc_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.sc_id('a1'), pg_temp.sc_epoch(p_who), pg_catalog.gen_random_uuid()))
$$;
create function pg_temp.sc_hand_back(p_who text) returns text language sql as $$
	select pg_temp.sc_as(pg_temp.sc_user(p_who), format('select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.sc_id('a1'), 'handed_back', pg_temp.sc_epoch(p_who),
		(pg_temp.sc_machine('a1')).desktop_member_generation))
$$;
-- The agent's look at m-1227 (the coding executor's read), as the service role.
create function pg_temp.sc_look() returns text language sql as $$
	select pg_temp.sc_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.sc_id('a1'))))
$$;
-- The executor's word that an answer to the agent carries the shared actions up to `at` (review r1 F4 of #1701).
create function pg_temp.sc_told(p_at timestamptz) returns text language sql as $$
	select pg_temp.sc_service(format('select public.qorpera_machine_desktop_shared_told(%L, %L)', pg_temp.sc_id('a1'), p_at))
$$;
-- One machine tool call's operation envelope as the machine tools write it, of `tool` with its arguments, on m-1227.
create function pg_temp.sc_envelope(p_tool text, p_key text, p_args jsonb) returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', p_tool, 'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('operationKey', p_key, 'machine', 'm-1227') || p_args,
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', pg_temp.sc_id('a1'))))::text;
end $$;
-- Receipt n ('12270000-0000-4000-8000-000000000' || n) begins as the call of an envelope under `tool`'s key; it completes.
create function pg_temp.sc_receipt(p_n text, p_tool text, p_envelope text) returns uuid
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12270000-0000-4000-8000-000000000' || p_n)::uuid, p_tool || ':' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'),
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	return ('12270000-0000-4000-8000-000000000' || p_n)::uuid;
end $$;
create function pg_temp.sc_complete(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12270000-0000-4000-8000-000000000' || p_n)::uuid, encode(extensions.digest(p_envelope, 'sha256'), 'hex'), '{}'::jsonb);
end $$;
-- The agent's machine_screen action of receipt n, the coding executor's read; then the receipt completes.
create function pg_temp.sc_agent_act(p_n text) returns text language plpgsql as $$
declare v_envelope text := pg_temp.sc_envelope('machine_screen', 'sc-act-' || p_n, jsonb_build_object(
	'action', jsonb_build_object('type', 'click', 'x', 812, 'y', 443), 'intent', 'Open the cart.'));
	v text;
begin
	perform pg_temp.sc_receipt(p_n, 'machine_screen', v_envelope);
	v := pg_temp.sc_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.sc_id('a1')),
		'12270000-0000-4000-8000-000000000' || p_n, v_envelope));
	perform pg_temp.sc_complete(p_n, v_envelope);
	return v;
end $$;
-- machine_run's command of receipt n on m-1227, started.
create function pg_temp.sc_command(p_n text) returns text language plpgsql as $$
declare
	v_envelope text := pg_temp.sc_envelope('machine_run', 'sc-run-' || p_n, '{"command": "sleep 600", "notify": false}');
	v_id uuid := ('12270000-0000-4000-8000-000000000' || p_n)::uuid;
	v text;
begin
	perform pg_temp.sc_receipt(p_n, 'machine_run', v_envelope);
	v := pg_temp.sc_service(format('select public.qorpera_authorize_machine_command(%L::jsonb, %L::jsonb, %L, %L, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.sc_id('a1')), 'start', v_id,
		encode(extensions.digest(v_envelope, 'sha256'), 'hex'), '{"commandHead": "sleep 600", "notify": false}'));
	perform pg_temp.sc_complete(p_n, v_envelope);
	return v;
end $$;
-- m-1227 in the window's list, as a member sees it.
create function pg_temp.sc_listed(p_who text) returns jsonb language sql as $$
	select m from jsonb_array_elements(pg_temp.sc_answer(pg_temp.sc_as(pg_temp.sc_user(p_who), format(
		'select public.qorpera_list_agent_machines(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000030'))) -> 'machines') as m
	where m ->> 'machineId' = pg_temp.sc_id('a1')::text
$$;
create function pg_temp.sc_rows(p_who text) returns bigint language sql as $$
	select count(*) from public.qorpera_company_machine_desktop_actions
	where machine_id = pg_temp.sc_id('a1') and user_id = pg_temp.sc_user(p_who) and shared
$$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.sc_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;

-- 1. The shared begin: who may, with no hold -------------------------------------------------------------------------------
do $$
declare v_differ text;
begin
	v_differ := pg_temp.sc_differ(jsonb_build_array(
		jsonb_build_array('a viewer', pg_temp.sc_share('viewer'), '42501:Machine desktop is unavailable'),
		jsonb_build_array('a stranger', pg_temp.sc_share('outsider'), '42501:Machine desktop is unavailable'),
		jsonb_build_array('another company''s machine', pg_temp.sc_share('owner', 'a5'), '42501:Machine desktop is unavailable'),
		jsonb_build_array('another company''s machine under its id', pg_temp.sc_share('owner', 'a5', '{"type": "click", "x": 4, "y": 4}',
			'12270000-0000-4000-8000-000000000011'), '42501:Machine desktop is unavailable'),
		jsonb_build_array('asleep', pg_temp.sc_share('owner', 'a2'), pg_temp.sc_refused('MACHINE_NOT_RUNNING')),
		jsonb_build_array('too small', pg_temp.sc_share('owner', 'a3'), pg_temp.sc_refused('DESKTOP_MACHINE_TOO_SMALL')),
		jsonb_build_array('open', pg_temp.sc_share('owner', 'a1', '{"type": "open", "target": "https://example.com"}'),
			'22023:Machine desktop action is malformed'),
		jsonb_build_array('a text', pg_temp.sc_share('owner', 'a1', '{"type": "type", "text": "hunter2"}'),
			'22023:Machine desktop action is malformed'),
		jsonb_build_array('a text by its length too', pg_temp.sc_share('owner', 'a1', '{"type": "type", "length": 7, "text": "hunter2"}'),
			'22023:Machine desktop action is malformed'),
		jsonb_build_array('no action', pg_temp.sc_share('owner', 'a1', null), '22023:Machine desktop action is malformed'),
		jsonb_build_array('the service role', pg_temp.sc_service(format(
			'select public.qorpera_member_machine_desktop_share_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			pg_temp.sc_id('a1'), '{"type": "click", "x": 4, "y": 4}')),
			'42501:permission denied for function qorpera_member_machine_desktop_share_begin')));
	perform pg_temp.base_assert(v_differ = '', E'1: answers that differ:\n' || v_differ);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_desktop_actions), '1: nothing recorded');
	-- An owner, an admin and a contributor act at once, with no hold.
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).desktop_member_until is null
			and pg_temp.sc_answer(pg_temp.sc_share('owner')) ->> 'state' = 'ok'
			and pg_temp.sc_answer(pg_temp.sc_share('admin')) ->> 'state' = 'ok'
			and pg_temp.sc_answer(pg_temp.sc_share('contributor')) ->> 'state' = 'ok'
			and (pg_temp.sc_machine('a1')).desktop_member_until is null
			and not exists (select 1 from public.qorpera_company_machine_desktop_controls where machine_id = pg_temp.sc_id('a1')),
		'1: owners, admins and contributors act without a hold, and none is taken');
end $$;

-- 2. What a shared action records -------------------------------------------------------------------------------------------
do $$
declare v_id uuid; v_row public.qorpera_company_machine_desktop_actions; v_before timestamptz;
begin
	perform pg_temp.sc_shift('a1', 'last_used_at = clock_timestamp() - interval ''1 hour''');
	v_id := pg_temp.sc_share_id('contributor', '{"type": "type", "length": 9}');
	select * into v_row from public.qorpera_company_machine_desktop_actions where id = v_id;
	perform pg_temp.base_assert(v_row.shared and v_row.control_id is null and v_row.seat = 0
			and v_row.seat = (pg_temp.sc_machine('a1')).desktop_member_generation
			and v_row.user_id = pg_temp.sc_user('contributor') and v_row.action = '{"type": "type", "length": 9}'::jsonb
			and v_row.served_at is null,
		'2: the row: shared, no lease, the generation, a text by its length: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).desktop_shared_user_id = pg_temp.sc_user('contributor')
			and (pg_temp.sc_machine('a1')).desktop_shared_at = v_row.begun_at
			and (pg_temp.sc_machine('a1')).last_used_at > clock_timestamp() - interval '5 seconds',
		'2: the member, the time and the last use on the machine');
	-- At most every 30 seconds.
	perform pg_temp.sc_shift('a1', 'last_used_at = clock_timestamp() - interval ''10 seconds''');
	v_before := (pg_temp.sc_machine('a1')).last_used_at;
	perform pg_temp.sc_share_id('contributor');
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).last_used_at = v_before, '2: within 30 seconds the last use stays');
	-- A root reader's action marks nothing; without the root (revoked; undone after) a disk that never had a view is marked.
	perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
		where id = pg_temp.sc_id('b1')) is null, '2: a root reader''s action marks nothing');
	begin
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		perform pg_temp.sc_share_id('contributor');
		perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
			where id = pg_temp.sc_id('b1')) is not null, '2: without the root, the action marks the disk');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- On a disk that has had a view (the platform's, undone after), a member without the root is refused, and nothing is
	-- recorded or marked; a root reader acts.
	begin
		perform pg_temp.base_claims('service_role');
		perform public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'test_machine',
			jsonb_build_object('companyMachineId', pg_temp.sc_id('a1'), 'placementId', pg_temp.sc_id('b1'), 'bootId', pg_temp.sc_id('c1')));
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views where placement_id = pg_temp.sc_id('b1')),
			'2: a view is open on m-1227''s disk');
		perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_share('contributor')) ->> 'state' = 'ok', '2: a root reader acts');
		v_before := (pg_temp.sc_machine('a1')).desktop_shared_at;
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.sc_share('contributor') = pg_temp.sc_refused('MACHINE_NEEDS_COMPANY_VIEW')
				and pg_temp.sc_rows('contributor') = 4 and (pg_temp.sc_machine('a1')).desktop_shared_at = v_before
				and (select folder_unchecked_at from public.qorpera_company_machine_placements where id = pg_temp.sc_id('b1')) is null,
			'2: a disk that has had a view, without the root: refused, nothing recorded or marked');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(pg_temp.sc_rows('contributor') = 3, '2: the contributor''s three');
end $$;

-- 3. A private hold refuses shared input; the private path is as before -----------------------------------------------------
do $$
declare v text; v_private text; v_seat bigint;
begin
	v := pg_temp.sc_take('admin');
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'ok', '3: the admin takes it privately: ' || v);
	-- Everyone else's shared input waits, the admin's own too (that is their private window's input).
	perform pg_temp.base_assert(pg_temp.sc_share('contributor') = pg_temp.sc_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.sc_share('owner') = pg_temp.sc_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.sc_share('admin') = pg_temp.sc_refused('DESKTOP_MEMBER_IN_CONTROL')
			and pg_temp.sc_rows('admin') = 1,
		'3: shared input refused while someone types privately, nothing recorded');
	-- The agent waits too, as before.
	perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_look()) ->> 'reason' = 'DESKTOP_MEMBER_IN_CONTROL',
		'3: the agent waits while a member holds it');
	-- The private path: begun under the hold and read with its seat, the answer as before (no `shared`).
	v_seat := (pg_temp.sc_machine('a1')).desktop_member_generation;
	v_private := pg_temp.sc_as(pg_temp.sc_user('admin'), format('select public.qorpera_member_machine_desktop_act_begin(%L, %L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.sc_id('a1'), '{"type": "click", "x": 9, "y": 9}',
		(pg_temp.sc_machine('a1')).desktop_member_epoch, v_seat));
	perform pg_temp.base_assert(pg_temp.sc_answer(v_private) ->> 'state' = 'ok'
			and not (select shared from public.qorpera_company_machine_desktop_actions
				where id = (pg_temp.sc_answer(v_private) ->> 'actionId')::uuid),
		'3: the private action: ' || v_private);
	v := pg_temp.sc_auth((pg_temp.sc_answer(v_private) ->> 'actionId')::uuid);
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'authorized' and not pg_temp.sc_answer(v) ? 'shared'
			and (pg_temp.sc_answer(v) ->> 'seat')::bigint = v_seat and (pg_temp.sc_answer(v) ->> 'served')::boolean,
		'3: the private read, as before: ' || v);
	-- Handed back: shared input goes again.
	v := pg_temp.sc_hand_back('admin');
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'handedBack' = 'true', '3: handed back: ' || v);
	perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_share('contributor')) ->> 'state' = 'ok'
			and pg_temp.sc_answer(pg_temp.sc_share('admin')) ->> 'state' = 'ok',
		'3: shared again after the hand-back');
end $$;

-- 4. The executor's read of a shared action -----------------------------------------------------------------------------------
do $$
declare v_id uuid; v text;
begin
	v_id := pg_temp.sc_share_id('contributor');
	v := pg_temp.sc_auth(v_id, 'mx-node-1');
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'authorized' and not (pg_temp.sc_answer(v) ->> 'served')::boolean
			and (select served_at is null from public.qorpera_company_machine_desktop_actions where id = v_id),
		'4: the executor that forwards it reads where it runs, without serving it: ' || v);
	v := pg_temp.sc_auth(v_id);
	perform pg_temp.base_assert(pg_temp.sc_answer(v) = jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1',
			'state', 'authorized', 'actionId', v_id, 'machineId', pg_temp.sc_id('a1'), 'placementId', pg_temp.sc_id('b1'),
			'bootId', pg_temp.sc_id('c1'), 'executorOwner', 'mx-1227', 'providerId', 'machine-1227',
			'userId', pg_temp.sc_user('contributor'), 'action', '{"type": "click", "x": 4, "y": 4}'::jsonb,
			'seat', (pg_temp.sc_machine('a1')).desktop_member_generation, 'served', true, 'shared', true),
		'4: served by its own executor, shared: ' || v);
	perform pg_temp.base_assert(pg_temp.sc_auth(v_id) = '42501:Machine desktop action is unavailable', '4: once');
	-- A private hold begun after the begin: refused while it lives, and after it was given back (the generation moved).
	v_id := pg_temp.sc_share_id('contributor');
	perform pg_temp.sc_take('owner');
	v := pg_temp.sc_auth(v_id);
	perform pg_temp.base_assert(v = pg_temp.sc_auth_refused('DESKTOP_MEMBER_IN_CONTROL'), '4: a hold begun since: ' || v);
	perform pg_temp.sc_hand_back('owner');
	v_id := pg_temp.sc_share_id('contributor');
	perform pg_temp.sc_take('owner');
	perform pg_temp.sc_hand_back('owner');
	v := pg_temp.sc_auth(v_id);
	perform pg_temp.base_assert(v = pg_temp.sc_auth_refused('DESKTOP_MEMBER_IN_CONTROL')
			and (select served_at is null from public.qorpera_company_machine_desktop_actions where id = v_id),
		'4: a hold begun and given back since (the generation moved): ' || v);
	-- A shared action read after its member became a viewer is unavailable, as a private one (undone after).
	v_id := pg_temp.sc_share_id('contributor');
	begin
		set local session_replication_role = replica;
		update public.qorpera_profile_members set role = 'viewer'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.sc_user('contributor');
		set local session_replication_role = origin;
		v := pg_temp.sc_auth(v_id);
		perform pg_temp.base_assert(v = '42501:Machine desktop action is unavailable', '4: a member made a viewer: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 5. At most 25 of one member's shared actions on one machine in 5 seconds ----------------------------------------------------
do $$
declare v text;
begin
	perform pg_temp.sc_age(interval '1 minute');
	for i in 1..25 loop
		v := pg_temp.sc_share('contributor');
		if pg_temp.sc_answer(v) ->> 'state' is distinct from 'ok' then raise exception '5: action % refused: %', i, v; end if;
	end loop;
	perform pg_temp.base_assert(pg_temp.sc_share('contributor') = pg_temp.sc_refused('DESKTOP_ACTIONS_TOO_FAST'), '5: the 26th');
	perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_share('owner')) ->> 'state' = 'ok', '5: another member''s are their own');
	perform pg_temp.sc_age(interval '6 seconds');
	perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_share('contributor')) ->> 'state' = 'ok', '5: after 5 seconds');
end $$;

-- 6. Shared rows older than 30 days go at the machine's next shared begin; the private ones stay -----------------------------
do $$
declare v_private bigint := (select count(*) from public.qorpera_company_machine_desktop_actions
	where machine_id = pg_temp.sc_id('a1') and not shared);
begin
	perform pg_temp.sc_age(interval '31 days');
	perform pg_temp.sc_share_id('owner');
	perform pg_temp.base_assert(pg_temp.sc_rows('owner') = 1 and pg_temp.sc_rows('contributor') = 0 and pg_temp.sc_rows('admin') = 0
			and v_private = 1 and (select count(*) from public.qorpera_company_machine_desktop_actions
				where machine_id = pg_temp.sc_id('a1') and not shared) = v_private,
		'6: the old shared rows went, the private one stayed');
end $$;

-- 7. The agent goes on while members share; it is told who touched the screen until an answer that says so is ready ----
do $$
declare v text; v_at timestamptz; v_touched jsonb;
begin
	-- A member acted (the owner, in 6): the agent's next read says who, how long ago and when (the executor's word).
	perform pg_temp.sc_shift('a1', 'desktop_shared_at = clock_timestamp() - interval ''12 seconds'', desktop_shared_told_at = null');
	v := pg_temp.sc_look();
	v_touched := pg_temp.sc_answer(v) -> 'memberTouched';
	v_at := (v_touched ->> 'at')::timestamptz;
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'authorized'
			and v_touched - array['name', 'secondsAgo', 'at'] = '{}'::jsonb
			and v_touched ->> 'name' = pg_temp.sc_name('owner')
			and (v_touched ->> 'secondsAgo')::integer between 12 and 30
			and v_at = (pg_temp.sc_machine('a1')).desktop_shared_at,
		'7: the agent is told who, how long ago and when: ' || v);
	-- The read marks nothing (review r1 F4 of #1701): a call refused after it (the desktop busy) tells it at the next.
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).desktop_shared_told_at is null
			and pg_temp.sc_answer(pg_temp.sc_look()) -> 'memberTouched' ->> 'at' = v_touched ->> 'at',
		'7: not told until the executor says an answer carries it');
	-- The executor's word: told up to that action; then nothing new. A word for a time after the newest action, or an
	-- older one, moves nothing.
	perform pg_temp.base_assert(pg_temp.sc_told(v_at + interval '1 second') = 'ok:{"state": "ok", "schema": "qorpera.machine-desktop-shared-told/v1"}'
			and (pg_temp.sc_machine('a1')).desktop_shared_told_at is null,
		'7: never past the newest action');
	perform pg_temp.sc_told(v_at);
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).desktop_shared_told_at = v_at
			and not pg_temp.sc_answer(pg_temp.sc_look()) ? 'memberTouched',
		'7: told: nothing new after');
	perform pg_temp.sc_told(v_at - interval '1 second');
	perform pg_temp.base_assert((pg_temp.sc_machine('a1')).desktop_shared_told_at = v_at, '7: never back');
	-- Another member's shared action: the agent's action goes on and its answer tells it; the read before the word and a
	-- newer action after the word are both told.
	perform pg_temp.sc_share_id('contributor', '{"type": "type", "length": 4}');
	v := pg_temp.sc_agent_act('701');
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'authorized'
			and pg_temp.sc_answer(v) #>> '{memberTouched,name}' = pg_temp.sc_name('contributor')
			and pg_temp.sc_answer(v) -> 'action' = '{"type": "click", "x": 812, "y": 443}'::jsonb,
		'7: the agent''s action goes on, and it is told again: ' || v);
	v_at := (pg_temp.sc_answer(v) #>> '{memberTouched,at}')::timestamptz;
	perform pg_temp.sc_share_id('admin');
	perform pg_temp.sc_told(v_at);
	-- A command goes on beside the members.
	v := pg_temp.sc_command('702');
	perform pg_temp.base_assert(pg_temp.sc_answer(v) ->> 'state' = 'authorized', '7: a command starts beside the members: ' || v);
	-- The admin's action came after the word for the contributor's: told of it.
	v := pg_temp.sc_look();
	perform pg_temp.base_assert(pg_temp.sc_answer(v) #>> '{memberTouched,name}' = pg_temp.sc_name('admin'),
		'7: an action after the word is told: ' || v);
	perform pg_temp.sc_told((pg_temp.sc_answer(v) #>> '{memberTouched,at}')::timestamptz);
	perform pg_temp.base_assert(not pg_temp.sc_answer(pg_temp.sc_look()) ? 'memberTouched', '7: then nothing new');
	-- A member who left the company since their action (review r1 F3 of #1701): named "A member" (undone after).
	begin
		perform pg_temp.sc_share_id('contributor');
		set local session_replication_role = replica;
		delete from public.qorpera_profile_members
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.sc_user('contributor');
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.sc_answer(pg_temp.sc_look()) #>> '{memberTouched,name}' = 'A member',
			'7: a member who left is "A member"');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The word: the service role alone, a whole request.
	perform pg_temp.base_assert(pg_temp.sc_service(format('select public.qorpera_machine_desktop_shared_told(%L, null)', pg_temp.sc_id('a1')))
			= '22023:Machine desktop request is malformed'
		and pg_temp.sc_as(pg_temp.sc_user('owner'), format('select public.qorpera_machine_desktop_shared_told(%L, %L)', pg_temp.sc_id('a1'),
			clock_timestamp())) = '42501:permission denied for function qorpera_machine_desktop_shared_told',
		'7: the word is the executor''s alone');
end $$;

-- 8. The window's list names the others of the company who acted in the last 60 seconds ------------------------------------
do $$
declare v jsonb;
begin
	perform pg_temp.sc_age(interval '2 minutes');
	perform pg_temp.sc_share_id('contributor');
	perform pg_temp.sc_share_id('contributor');
	perform pg_temp.sc_share_id('admin');
	v := pg_temp.sc_listed('owner');
	perform pg_temp.base_assert(v -> 'others' = (select jsonb_agg(pg_temp.sc_name(who) order by pg_temp.sc_user(who))
			from unnest(array['contributor', 'admin']) as who),
		'8: the owner sees the contributor and the admin, once each: ' || coalesce(v::text, 'none'));
	v := pg_temp.sc_listed('contributor');
	perform pg_temp.base_assert(v -> 'others' = jsonb_build_array(pg_temp.sc_name('admin')), '8: never the caller: ' || coalesce(v::text, 'none'));
	v := pg_temp.sc_listed('viewer');
	perform pg_temp.base_assert(jsonb_array_length(v -> 'others') = 2, '8: a viewer sees who uses it: ' || coalesce(v::text, 'none'));
	-- One who left the company since (review r1 F3 of #1701): not named, never a null (undone after); none left: no key.
	begin
		set local session_replication_role = replica;
		delete from public.qorpera_profile_members
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.sc_user('contributor');
		set local session_replication_role = origin;
		v := pg_temp.sc_listed('owner');
		perform pg_temp.base_assert(v -> 'others' = jsonb_build_array(pg_temp.sc_name('admin')),
			'8: a member who left is not named: ' || coalesce(v::text, 'none'));
		v := pg_temp.sc_listed('admin');
		perform pg_temp.base_assert(v is not null and not v ? 'others', '8: only one who left: no one named: ' || coalesce(v::text, 'none'));
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.sc_age(interval '61 seconds');
	v := pg_temp.sc_listed('owner');
	perform pg_temp.base_assert(v is not null and not v ? 'others', '8: after 60 seconds, no one: ' || coalesce(v::text, 'none'));
end $$;

-- 9. The grants, the check of a shared row and the markers --------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)', 'execute'),
		'9: members call it, no one else');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_machine_desktop_shared_told(uuid,timestamptz)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_machine_desktop_shared_told(uuid,timestamptz)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_machine_desktop_shared_told(uuid,timestamptz)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_machine_desktop_shared_told(uuid,timestamptz)', 'execute'),
		'9: the executor alone says the agent was told');
	perform pg_temp.base_assert(not has_table_privilege('authenticated', 'public.qorpera_company_machine_desktop_actions', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_machine_desktop_actions', 'select'),
		'9: the actions stay closed');
	begin
		insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, shared, begun_at)
		values (pg_catalog.gen_random_uuid(), (select id from public.qorpera_company_machine_desktop_controls limit 1), pg_temp.sc_id('a1'),
			pg_temp.sc_user('owner'), '{"type": "click", "x": 1, "y": 1}', 1, true, clock_timestamp());
		raise exception '9: a shared row with a lease row was let in';
	exception when check_violation then null;
	end;
	begin
		insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, shared, begun_at)
		values (pg_catalog.gen_random_uuid(), null, pg_temp.sc_id('a1'), pg_temp.sc_user('owner'), '{"type": "click", "x": 1, "y": 1}', 1,
			false, clock_timestamp());
		raise exception '9: a private row without a lease row was let in';
	exception when check_violation then null;
	end;
	begin
		insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, shared, begun_at)
		values (pg_catalog.gen_random_uuid(), null, pg_temp.sc_id('a1'), pg_temp.sc_user('owner'), '{"type": "type", "text": "x"}', 0,
			true, clock_timestamp());
		raise exception '9: a shared row with a text was let in';
	exception when check_violation then null;
	end;
end $$;
