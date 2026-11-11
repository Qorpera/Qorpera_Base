-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930713000: a member takes over an agent's desktop computer and hands it back. On 924's base (an owner, a
-- contributor, a viewer, an admin and an outsider; Alice's live run for the owner), with Alice's running desktop m-1203,
-- a running machine too small for a desktop, a stopped one, a second running desktop and another company's:
-- 1. taking over: an owner, admin or contributor; a viewer, a stranger, another company's machine refused (42501); too
--    small (DESKTOP_MACHINE_TOO_SMALL), stopped (MACHINE_NOT_RUNNING); one member at a time (DESKTOP_MEMBER_IN_CONTROL,
--    with the holder's name); taking again renews; the lease, its row and the machine's last use; the list says who
--    holds it and whether the member may take over;
-- 2. while a member holds it, the agent waits: its look and its action (DESKTOP_MEMBER_IN_CONTROL, nothing stamped), a
--    new command's start, and save_coding_value are refused; a start sent again of a command that started before, its
--    read and its cancel go on; a machine no one holds is the agent's as before;
-- 3. other members see who, not the screen: the holder looks on; another member's look is refused at the begin, and a
--    look begun before the take-over is refused at the executor's read;
-- 4. the member's actions: only the holder's (DESKTOP_MEMBER_IN_CONTROL, DESKTOP_CONTROL_ENDED, 42501 for a viewer);
--    each verb's shape as an agent's, never `open`, no xdotool command word as a key in any case, a typed text by its
--    length alone (a text is malformed, and no table ever holds one); recorded, counted, the lease renewed, the machine's
--    last use moved at most every 30 seconds; the disk's mark for a member who does not read the root;
-- 5. the executor's read of an action: served once and only by the placement's own executor, within 15 seconds; the
--    action as recorded; a lease handed back, a member made a viewer, a machine stopped meanwhile;
-- 6. the lease ends by time alone (the agent's refusals stop with it): the heartbeat renews it, never past 30 minutes
--    from the last input; lapsed and idle leases are closed as such by the next take-over; hand back ('handed_back',
--    'closed') only of the member's own;
-- 7. the `machines` hint when a lease begins or ends by a word, never on an action's renewal or a heartbeat;
-- 8. the grants, the closed tables and the marker;
-- 9. the fence after a capture (review r1 F1): the lease generation moves when a lease begins and when one is given back
--    (never on taking again, an action or a heartbeat); both look reads answer it; the picture check lets a picture out
--    only at the generation the read saw and with no live hold but the looker's own: a member's look authorized before
--    another member took over and typed, and an agent's look authorized before a take-over, typing and a hand-back,
--    both get none;
-- 10. a root read taken away between an action's begin and the executor's read (review r1 F2): the action runs, the
--    disk that never had a view is marked, and the platform's open then refuses it;
-- 11. hand-back epochs (review r5): a machine with no row is at 0; a take-over at the current epoch; a hand-back at it
--    ends the lease and moves the epoch (and the generation, as 9 needs); a repeated hand-back changes nothing; a
--    take-over at an older (or a later) epoch is refused and changes nothing; a late hand-back both ways (after the next
--    take-over: it keeps its lease; before it: it takes at the new epoch); the heartbeat rule; a take-over under an
--    epoch handed back stays refused after 50 more; two members are independent, and each list says its own epoch.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'dc-ack') is not null;

-- The machines, all started by Alice's run, last used an hour ago; the running ones run on their placements (reserved on a
-- node, as an executor's custody leaves them).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12030000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12030000-0000-4000-8000-0000000007e5', '12030000-0000-4000-8000-000000000011', 'Environment', 1,
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
	('12030000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1203', '12030000-0000-4000-8000-0000000008a1'::uuid, 2,
		4294967296::bigint, 'running'),
	-- Running, too small for a desktop.
	('12030000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1203-small', '12030000-0000-4000-8000-0000000008a2', 1, 2147483648, 'running'),
	-- Asleep.
	('12030000-0000-4000-8000-0000000007a3', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1203-asleep', '12030000-0000-4000-8000-0000000008a3', 2, 4294967296, 'stopped'),
	-- A second running desktop, which no one takes over.
	('12030000-0000-4000-8000-0000000007a4', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1203-other', '12030000-0000-4000-8000-0000000008a4', 4, 8589934592, 'running'),
	-- Another company's, running.
	('12030000-0000-4000-8000-0000000007a5', '12030000-0000-4000-8000-000000000011', '12030000-0000-4000-8000-0000000007e5',
		'm-1203', '12030000-0000-4000-8000-0000000008a5', 2, 4294967296, 'running')
) as machine(id, profile_id, environment_id, name, receipt_id, cpus, memory, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
select ('12030000-0000-4000-8000-0000000007b' || n)::uuid, ('12030000-0000-4000-8000-0000000007a' || n)::uuid,
	case when n = 5 then '12030000-0000-4000-8000-000000000011'::uuid else '92400000-0000-4000-8000-000000000010'::uuid end,
	'mx-1203', repeat('8', 64), '{"providerId": "machine-1203"}', repeat(n::text, 64), clock_timestamp(),
	('12030000-0000-4000-8000-0000000007c' || n)::uuid
from unnest(array[1, 2, 4, 5]) as n;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12030000-%';
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12030000-0000-4000-8000-0000000007d1', 'machine', 'machine-1203', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement where placement.machine_id::text like '12030000-%';
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
	select ('12030000-0000-4000-8000-0000000007' || p_suffix)::uuid
$$;
create function pg_temp.dc_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
create function pg_temp.dc_name(p_who text) returns text language sql as $$
	select public.qorpera_review_member_name('92400000-0000-4000-8000-000000000010', pg_temp.dc_user(p_who))
$$;
-- A member's hand-back epoch for a machine (0 while they have no row).
create function pg_temp.dc_epoch(p_who text, p_machine text) returns bigint language sql as $$
	select coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = pg_temp.dc_id(p_machine) and epochs.user_id = pg_temp.dc_user(p_who)), 0)
$$;
-- A take-over at the member's current epoch, as their page knows it, unless the test names another.
create function pg_temp.dc_take(p_who text, p_machine text, p_profile uuid default '92400000-0000-4000-8000-000000000010',
	p_epoch bigint default null)
returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_take_machine_desktop(%L, %L, %L)',
		p_profile, pg_temp.dc_id(p_machine), coalesce(p_epoch, pg_temp.dc_epoch(p_who, p_machine))))
$$;
-- A heartbeat at the epoch the lease was taken under (as the holder's window knows it) unless the test names one.
create function pg_temp.dc_keep(p_who text, p_machine text, p_epoch bigint default null) returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_keep_machine_desktop(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id(p_machine), coalesce(p_epoch,
			(select machine.desktop_member_epoch from public.qorpera_company_machines as machine
				where machine.id = pg_temp.dc_id(p_machine)), pg_temp.dc_epoch(p_who, p_machine))))
$$;
-- A hand-back at the member's current epoch unless the test names one.
create function pg_temp.dc_back(p_who text, p_machine text, p_reason text default 'handed_back', p_epoch bigint default null)
returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id(p_machine), p_reason,
		coalesce(p_epoch, pg_temp.dc_epoch(p_who, p_machine))))
$$;
-- Whether a hand-back answered ok, as expected: a lease given back or not, the member holding the machine now or not
-- (its epoch read apart).
create function pg_temp.dc_backed(p_result text, p_handed boolean, p_holding boolean default false) returns boolean
language sql as $$
	select coalesce(p_result like 'ok:%' and pg_temp.dc_answer(p_result) - 'epoch' = jsonb_build_object(
		'schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'handedBack', p_handed, 'holding', p_holding)
		and jsonb_typeof(pg_temp.dc_answer(p_result) -> 'epoch') = 'number', false)
$$;
create function pg_temp.dc_act(p_who text, p_machine text, p_action jsonb) returns text language sql as $$
	select pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_machine_desktop_act_begin(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id(p_machine), p_action))
$$;
-- An action begun as the member, its id (or an exception).
create function pg_temp.dc_act_id(p_who text, p_machine text, p_action jsonb) returns uuid language plpgsql as $$
declare v text := pg_temp.dc_act(p_who, p_machine, p_action);
begin
	if pg_temp.dc_answer(v) ->> 'state' is distinct from 'ok' then raise exception 'The action was not begun: %', v; end if;
	return (pg_temp.dc_answer(v) ->> 'actionId')::uuid;
end $$;
create function pg_temp.dc_auth(p_action uuid, p_owner text default 'mx-1203', p_provider text default 'machine-1203')
returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)', p_action, p_owner,
		p_provider))
$$;
create function pg_temp.dc_machine(p_machine text) returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = pg_temp.dc_id(p_machine)
$$;
-- A machine's leases, oldest first: whose, how they ended, how many actions.
create function pg_temp.dc_controls(p_machine text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_array(control.user_id, control.ended_by, control.actions) order by control.began_at),
		'[]') from public.qorpera_company_machine_desktop_controls as control where control.machine_id = pg_temp.dc_id(p_machine)
$$;
-- Moves a machine's lease back in time (as if that much passed), or its last use.
create function pg_temp.dc_shift(p_machine text, p_set text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute format('update public.qorpera_company_machines set %s where id = %L', p_set, pg_temp.dc_id(p_machine));
	set local session_replication_role = origin;
end $$;
-- The agent's look at a machine (the coding executor's read), as the service role.
create function pg_temp.dc_look(p_machine text) returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.dc_id(p_machine))))
$$;
-- One machine tool call's operation envelope as the machine tools write it, of `tool` with its arguments, on m-1203.
create function pg_temp.dc_envelope(p_tool text, p_key text, p_args jsonb) returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', p_tool, 'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('operationKey', p_key, 'machine', 'm-1203') || p_args,
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', pg_temp.dc_id('a1'))))::text;
end $$;
-- Receipt n ('12030000-0000-4000-8000-000000000' || n) begins as the call of an envelope under `tool`'s key.
create function pg_temp.dc_receipt(p_n text, p_tool text, p_envelope text) returns uuid
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12030000-0000-4000-8000-000000000' || p_n)::uuid, p_tool || ':' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'),
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	return ('12030000-0000-4000-8000-000000000' || p_n)::uuid;
end $$;
-- Receipt n completes (a run holds one unresolved operation at a time).
create function pg_temp.dc_complete(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12030000-0000-4000-8000-000000000' || p_n)::uuid, encode(extensions.digest(p_envelope, 'sha256'), 'hex'), '{}'::jsonb);
end $$;
-- The agent's machine_screen action of receipt n, the coding executor's read; then the receipt completes.
create function pg_temp.dc_agent_act(p_n text) returns text language plpgsql as $$
declare v_envelope text := pg_temp.dc_envelope('machine_screen', 'dc-act-' || p_n, jsonb_build_object(
	'action', jsonb_build_object('type', 'click', 'x', 812, 'y', 443), 'intent', 'Open the sign-in form.'));
	v text;
begin
	perform pg_temp.dc_receipt(p_n, 'machine_screen', v_envelope);
	v := pg_temp.dc_service(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.dc_id('a1')),
		'12030000-0000-4000-8000-000000000' || p_n, v_envelope));
	perform pg_temp.dc_complete(p_n, v_envelope);
	return v;
end $$;
-- machine_run's command of receipt n on m-1203: begun (and completed) once, and authorized for `action`.
create function pg_temp.dc_command(p_n text, p_action text) returns text language plpgsql as $$
declare
	v_envelope text := pg_temp.dc_envelope('machine_run', 'dc-run-' || p_n, '{"command": "sleep 600", "notify": false}');
	v_id uuid := ('12030000-0000-4000-8000-000000000' || p_n)::uuid;
	v_new boolean := not exists (select 1 from public.qorpera_run_operation_receipts where id = v_id);
	v text;
begin
	if v_new then perform pg_temp.dc_receipt(p_n, 'machine_run', v_envelope); end if;
	v := pg_temp.dc_service(format('select public.qorpera_authorize_machine_command(%L::jsonb, %L::jsonb, %L, %L, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.dc_id('a1')), p_action, v_id,
		case when p_action = 'start' then encode(extensions.digest(v_envelope, 'sha256'), 'hex') end,
		case when p_action = 'start' then '{"commandHead": "sleep 600", "notify": false}' end));
	if v_new then perform pg_temp.dc_complete(p_n, v_envelope); end if;
	return v;
end $$;
-- save_coding_value off m-1203 for receipt n, the coding executor's read.
create function pg_temp.dc_coding_value(p_n text) returns text language plpgsql as $$
declare v_envelope text := pg_temp.dc_envelope('save_coding_value', 'dc-cv-' || p_n, jsonb_build_object('service', 'github',
	'variable', 'gh_release_token', 'repository', 'qorpera/qorpera_base', 'purpose', 'Publishes releases.'));
	v text;
begin
	perform pg_temp.dc_receipt(p_n, 'save_coding_value', v_envelope);
	v := pg_temp.dc_service(format('select public.qorpera_authorize_machine_coding_value(%L::jsonb, %L::jsonb, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', pg_temp.dc_id('a1')),
		'12030000-0000-4000-8000-000000000' || p_n, v_envelope));
	perform pg_temp.dc_complete(p_n, v_envelope);
	return v;
end $$;
-- A member's look begun (the 400 ms throttle put back a second first), and its use id or the refusal.
create function pg_temp.dc_begin_look(p_who text, p_machine text) returns text language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_screen_watches set last_look_at = last_look_at - interval '1 second'
	where machine_id = pg_temp.dc_id(p_machine) and user_id = pg_temp.dc_user(p_who);
	set local session_replication_role = origin;
	return pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_member_machine_screen_begin(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id(p_machine), '{"confirmed": true}'));
end $$;
create function pg_temp.dc_look_auth(p_begin text) returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_member_machine_screen_authority(%L, %L, %L)',
		pg_temp.dc_answer(p_begin) ->> 'useId', 'mx-1203', 'machine-1203'))
$$;
create function pg_temp.dc_list(p_who text) returns jsonb language sql as $$
	select pg_temp.dc_answer(pg_temp.dc_as(pg_temp.dc_user(p_who), format('select public.qorpera_list_agent_machines(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000030')))
$$;
create function pg_temp.dc_listed(p_who text, p_name text) returns jsonb language sql as $$
	select m from jsonb_array_elements(pg_temp.dc_list(p_who) -> 'machines') as m where m ->> 'name' = p_name
$$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.dc_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;
create function pg_temp.dc_refused(p_schema text, p_reason text, p_extra jsonb default '{}') returns text language sql as $$
	select 'ok:' || (jsonb_build_object('schema', p_schema, 'state', 'refused', 'reason', p_reason) || p_extra)::text
$$;

-- Before anyone takes over: Alice's run starts a command on m-1203 (receipt 101), and the owner begins a look.
select set_config('qorpera_test.dc_run101', pg_temp.dc_command('101', 'start'), true);
select set_config('qorpera_test.dc_owner_look', pg_temp.dc_begin_look('owner', 'a1'), true);
do $$
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_run101')) ->> 'state' = 'authorized'
			and exists (select 1 from public.qorpera_company_machine_commands where id = '12030000-0000-4000-8000-000000000101'),
		'0: a command starts on m-1203 before anyone takes over: ' || current_setting('qorpera_test.dc_run101'));
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_owner_look')) ->> 'state' = 'ok',
		'0: the owner begins a look: ' || current_setting('qorpera_test.dc_owner_look'));
end $$;

-- 1. Taking over -------------------------------------------------------------------------------------------------------------

-- The command's start used the machine just now: put its last use back an hour, so the take-over's own shows.
select pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''1 hour''');
select set_config('qorpera_test.dc_used0', (pg_temp.dc_machine('a1')).last_used_at::text, true);
select set_config('qorpera_test.dc_t1', pg_temp.dc_take('contributor', 'a1'), true);
select set_config('qorpera_test.dc_t2', pg_temp.dc_take('admin', 'a1'), true);
select set_config('qorpera_test.dc_m1', row_to_json(pg_temp.dc_machine('a1'))::text, true);
select set_config('qorpera_test.dc_t3', pg_temp.dc_take('contributor', 'a1'), true);
do $$
declare
	v_machine jsonb := current_setting('qorpera_test.dc_m1')::jsonb;
	v_after public.qorpera_company_machines := pg_temp.dc_machine('a1');
	v_take jsonb := pg_temp.dc_answer(current_setting('qorpera_test.dc_t1'));
begin
	perform pg_temp.base_assert(v_take - 'until' = '{"schema": "qorpera.member-machine-desktop/v1", "state": "ok"}'::jsonb
			and (v_take ->> 'until')::timestamptz = (v_machine ->> 'desktop_member_until')::timestamptz,
		'1: a contributor takes over: ' || current_setting('qorpera_test.dc_t1'));
	perform pg_temp.base_assert((v_machine ->> 'desktop_member_user_id')::uuid = pg_temp.dc_user('contributor')
			and (v_machine ->> 'desktop_member_until')::timestamptz = (v_machine ->> 'desktop_member_since')::timestamptz + interval '5 minutes'
			and (v_machine ->> 'desktop_member_input_at')::timestamptz = (v_machine ->> 'desktop_member_since')::timestamptz
			and (v_machine ->> 'last_used_at')::timestamptz > current_setting('qorpera_test.dc_used0')::timestamptz,
		'1: the lease: 5 minutes from the take, the last input then, the machine''s last use moved: ' || v_machine::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_t2') = pg_temp.dc_refused('qorpera.member-machine-desktop/v1',
			'DESKTOP_MEMBER_IN_CONTROL', jsonb_build_object('memberName', pg_temp.dc_name('contributor')))
			and pg_temp.dc_name('contributor') is not null,
		'1: one member at a time; the other hears who: ' || current_setting('qorpera_test.dc_t2'));
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_t3')) ->> 'state' = 'ok'
			and v_after.desktop_member_since = (v_machine ->> 'desktop_member_since')::timestamptz
			and v_after.desktop_member_input_at > (v_machine ->> 'desktop_member_input_at')::timestamptz
			and v_after.desktop_member_until = v_after.desktop_member_input_at + interval '5 minutes'
			and pg_temp.dc_controls('a1') = jsonb_build_array(jsonb_build_array(pg_temp.dc_user('contributor'), null, 0)),
		'1: taking again renews the same lease: ' || current_setting('qorpera_test.dc_t3') || ' ' || pg_temp.dc_controls('a1')::text);
	-- The list: who holds it, by name, and until when; whether the member may take over.
	perform pg_temp.base_assert(pg_temp.dc_listed('viewer', 'm-1203') -> 'control' = jsonb_build_object('mine', false,
			'name', pg_temp.dc_name('contributor'), 'until', v_after.desktop_member_until)
			and not (pg_temp.dc_list('viewer') ->> 'canTakeOver')::boolean,
		'1: a viewer''s list: who holds it, and no take-over: ' || pg_temp.dc_list('viewer')::text);
	perform pg_temp.base_assert(pg_temp.dc_listed('contributor', 'm-1203') -> 'control' = jsonb_build_object('mine', true,
				'name', pg_temp.dc_name('contributor'), 'until', v_after.desktop_member_until,
				'epoch', v_after.desktop_member_epoch)
			and v_after.desktop_member_epoch = pg_temp.dc_epoch('contributor', 'a1')
			and (pg_temp.dc_listed('contributor', 'm-1203') ->> 'epoch')::bigint = pg_temp.dc_epoch('contributor', 'a1')
			and (pg_temp.dc_list('contributor') ->> 'canTakeOver')::boolean and (pg_temp.dc_list('owner') ->> 'canTakeOver')::boolean
			and (pg_temp.dc_list('admin') ->> 'canTakeOver')::boolean,
		'1: the holder''s list says it is theirs, the epoch it was taken under and their own epoch; owners, admins and contributors may '
			|| 'take over: ' || pg_temp.dc_list('contributor')::text);
	perform pg_temp.base_assert(pg_temp.dc_listed('viewer', 'm-1203-other') -> 'control' = 'null'::jsonb,
		'1: a machine no one holds: control null');
end $$;

select set_config('qorpera_test.dc_1x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('a viewer', pg_temp.dc_take('viewer', 'a4'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('a stranger', pg_temp.dc_take('outsider', 'a4'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('too small', pg_temp.dc_take('owner', 'a2'),
		pg_temp.dc_refused('qorpera.member-machine-desktop/v1', 'DESKTOP_MACHINE_TOO_SMALL')),
	jsonb_build_array('asleep', pg_temp.dc_take('owner', 'a3'),
		pg_temp.dc_refused('qorpera.member-machine-desktop/v1', 'MACHINE_NOT_RUNNING')),
	jsonb_build_array('another company''s machine', pg_temp.dc_take('owner', 'a5'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('another company', pg_temp.dc_take('owner', 'a5', '12030000-0000-4000-8000-000000000011'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('no machine', pg_temp.dc_as(pg_temp.dc_user('owner'), format(
		'select public.qorpera_member_take_machine_desktop(%L, null, 0)', '92400000-0000-4000-8000-000000000010')),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('no epoch', pg_temp.dc_as(pg_temp.dc_user('owner'), format(
		'select public.qorpera_member_take_machine_desktop(%L, %L, null)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a4'))), '22023:Machine desktop request is malformed'),
	jsonb_build_array('an epoch below 0', pg_temp.dc_take('owner', 'a4', p_epoch => -1),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('the service role', pg_temp.dc_service(format('select public.qorpera_member_take_machine_desktop(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', pg_temp.dc_id('a4'), 0)),
		'42501:permission denied for function qorpera_member_take_machine_desktop')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_1x') = '',
		E'1: take-overs that differ:\n' || current_setting('qorpera_test.dc_1x'));
	perform pg_temp.base_assert(pg_temp.dc_controls('a2') = '[]' and pg_temp.dc_controls('a3') = '[]'
			and pg_temp.dc_controls('a4') = '[]' and (pg_temp.dc_machine('a4')).desktop_member_user_id is null,
		'1: a refused take-over holds nothing');
end $$;

-- 2. While a member holds it, the agent waits -------------------------------------------------------------------------------

select set_config('qorpera_test.dc_screen2', row_to_json(pg_temp.dc_machine('a1'))::text, true);
select set_config('qorpera_test.dc_2x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('a look', pg_temp.dc_look('a1'), pg_temp.dc_refused('qorpera.machine-screen-authority/v1',
		'DESKTOP_MEMBER_IN_CONTROL', '{"machine": "m-1203"}')),
	jsonb_build_array('an action', pg_temp.dc_agent_act('201'), pg_temp.dc_refused('qorpera.machine-screen-authority/v1',
		'DESKTOP_MEMBER_IN_CONTROL', '{"machine": "m-1203"}')),
	jsonb_build_array('a new command', pg_temp.dc_command('102', 'start'), pg_temp.dc_refused(
		'qorpera.machine-command-authority/v1', 'DESKTOP_MEMBER_IN_CONTROL', '{"machine": "m-1203", "machineState": "running"}')),
	jsonb_build_array('a coding value', pg_temp.dc_coding_value('301'), pg_temp.dc_refused(
		'qorpera.machine-coding-value-authority/v1', 'DESKTOP_MEMBER_IN_CONTROL', '{"machine": "m-1203"}')),
	jsonb_build_array('the started command, sent again', pg_temp.dc_answer(pg_temp.dc_command('101', 'start')) ->> 'state',
		'authorized'),
	jsonb_build_array('its read', pg_temp.dc_answer(pg_temp.dc_command('101', 'read')) ->> 'state', 'authorized'),
	jsonb_build_array('its cancel', pg_temp.dc_answer(pg_temp.dc_command('101', 'cancel')) ->> 'state', 'authorized'),
	jsonb_build_array('a look at a machine no one holds', pg_temp.dc_answer(pg_temp.dc_look('a4')) ->> 'state', 'authorized')
)), true);
do $$
declare v_before jsonb := current_setting('qorpera_test.dc_screen2')::jsonb; v_now public.qorpera_company_machines := pg_temp.dc_machine('a1');
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_2x') = '',
		E'2: the agent''s reads that differ:\n' || current_setting('qorpera_test.dc_2x'));
	perform pg_temp.base_assert(v_now.screen_staff_agent_id is not distinct from (v_before ->> 'screen_staff_agent_id')::uuid
			and v_now.screen_used_at is not distinct from (v_before ->> 'screen_used_at')::timestamptz,
		'2: a refused look or action stamps no agent on the screen');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_commands
			where id = '12030000-0000-4000-8000-000000000102'),
		'2: the refused start made no command');
end $$;

-- 3. Other members see who, not the screen ------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_3x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('the holder''s look', pg_temp.dc_answer(pg_temp.dc_look_auth(pg_temp.dc_begin_look('contributor', 'a1')))
		->> 'state', 'authorized'),
	jsonb_build_array('a viewer''s look', pg_temp.dc_begin_look('viewer', 'a1'),
		pg_temp.dc_refused('qorpera.member-machine-screen/v1', 'DESKTOP_MEMBER_IN_CONTROL')),
	jsonb_build_array('an admin''s look', pg_temp.dc_begin_look('admin', 'a1'),
		pg_temp.dc_refused('qorpera.member-machine-screen/v1', 'DESKTOP_MEMBER_IN_CONTROL')),
	jsonb_build_array('a look begun before, read now', pg_temp.dc_look_auth(current_setting('qorpera_test.dc_owner_look')),
		pg_temp.dc_refused('qorpera.member-machine-screen-authority/v1', 'DESKTOP_MEMBER_IN_CONTROL')),
	jsonb_build_array('a look at a machine no one holds', pg_temp.dc_answer(pg_temp.dc_begin_look('viewer', 'a4')) ->> 'state',
		'ok')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_3x') = '',
		E'3: members'' looks that differ:\n' || current_setting('qorpera_test.dc_3x'));
end $$;

-- 4. The member's actions -----------------------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_m4', row_to_json(pg_temp.dc_machine('a1'))::text, true);
select set_config('qorpera_test.dc_a41', pg_temp.dc_act_id('contributor', 'a1', '{"type": "click", "x": 812, "y": 443}')::text, true);
select set_config('qorpera_test.dc_a42', pg_temp.dc_act_id('contributor', 'a1', '{"type": "type", "length": 7}')::text, true);
do $$
declare
	v_before jsonb := current_setting('qorpera_test.dc_m4')::jsonb;
	v_machine public.qorpera_company_machines := pg_temp.dc_machine('a1');
	v_click public.qorpera_company_machine_desktop_actions;
	v_type public.qorpera_company_machine_desktop_actions;
begin
	select * into v_click from public.qorpera_company_machine_desktop_actions where id = current_setting('qorpera_test.dc_a41')::uuid;
	select * into v_type from public.qorpera_company_machine_desktop_actions where id = current_setting('qorpera_test.dc_a42')::uuid;
	perform pg_temp.base_assert(v_click.action = '{"type": "click", "x": 812, "y": 443}'::jsonb
			and v_click.user_id = pg_temp.dc_user('contributor') and v_click.machine_id = pg_temp.dc_id('a1')
			and v_click.served_at is null and v_click.control_id = (select id from public.qorpera_company_machine_desktop_controls
				where machine_id = pg_temp.dc_id('a1') and ended_at is null),
		'4: a click is recorded as it was asked: ' || row_to_json(v_click)::text);
	perform pg_temp.base_assert(v_type.action = '{"type": "type", "length": 7}'::jsonb,
		'4: a typed text by its length alone: ' || row_to_json(v_type)::text);
	perform pg_temp.base_assert(v_machine.desktop_member_input_at >= v_type.begun_at
			and v_machine.desktop_member_input_at > (v_before ->> 'desktop_member_input_at')::timestamptz
			and v_machine.desktop_member_until = v_machine.desktop_member_input_at + interval '5 minutes'
			and pg_temp.dc_controls('a1') = jsonb_build_array(jsonb_build_array(pg_temp.dc_user('contributor'), null, 2)),
		'4: each action renews the lease and is counted: ' || row_to_json(v_machine)::text || pg_temp.dc_controls('a1')::text);
end $$;

-- Each verb as an agent's, but never open; a key never an xdotool command word; a text never.
select set_config('qorpera_test.dc_4x', pg_temp.dc_differ((
	select jsonb_agg(jsonb_build_array(shape.action, coalesce(pg_temp.dc_answer(pg_temp.dc_act('contributor', 'a1', shape.action::jsonb))
		->> 'state', pg_temp.dc_act('contributor', 'a1', shape.action::jsonb)), shape.expected))
	from (values
		('{"type": "click", "x": 0, "y": 0, "button": "right"}', 'ok'),
		('{"type": "click", "x": 3839, "y": 2159, "button": "middle"}', 'ok'),
		('{"type": "double", "x": 10, "y": 20}', 'ok'),
		('{"type": "move", "x": 10, "y": 20}', 'ok'),
		('{"type": "drag", "x": 10, "y": 20, "toX": 30, "toY": 40}', 'ok'),
		('{"type": "type", "length": 1}', 'ok'),
		('{"type": "type", "length": 500}', 'ok'),
		('{"type": "key", "keys": ["ctrl+l", "Return", "shift+Tab", "ctrl+exec"]}', 'ok'),
		('{"type": "scroll", "direction": "down"}', 'ok'),
		('{"type": "scroll", "direction": "up", "steps": 30, "x": 5, "y": 6}', 'ok'),
		('{"type": "type", "text": "hunter2"}', '22023:Machine desktop action is malformed'),
		('{"type": "type", "length": 7, "text": "hunter2"}', '22023:Machine desktop action is malformed'),
		('{"type": "type", "length": 0}', '22023:Machine desktop action is malformed'),
		('{"type": "type", "length": 501}', '22023:Machine desktop action is malformed'),
		('{"type": "type", "length": 1.5}', '22023:Machine desktop action is malformed'),
		('{"type": "type", "length": "7"}', '22023:Machine desktop action is malformed'),
		('{"type": "type"}', '22023:Machine desktop action is malformed'),
		('{"type": "open", "target": "https://bank.example.test"}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["exec", "id"]}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["Return", "EXEC"]}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["Type"]}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["windowKill"]}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["sleep"]}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": []}', '22023:Machine desktop action is malformed'),
		('{"type": "key", "keys": ["ctrl l"]}', '22023:Machine desktop action is malformed'),
		('{"type": "click", "x": 3840, "y": 0}', '22023:Machine desktop action is malformed'),
		('{"type": "click", "x": -1, "y": 0}', '22023:Machine desktop action is malformed'),
		('{"type": "click", "x": 1.5, "y": 0}', '22023:Machine desktop action is malformed'),
		('{"type": "click", "x": 1, "y": 2, "button": "back"}', '22023:Machine desktop action is malformed'),
		('{"type": "click", "x": 1, "y": 2, "intent": "x"}', '22023:Machine desktop action is malformed'),
		('{"type": "drag", "x": 1, "y": 2}', '22023:Machine desktop action is malformed'),
		('{"type": "scroll", "direction": "left"}', '22023:Machine desktop action is malformed'),
		('{"type": "scroll", "direction": "down", "x": 5}', '22023:Machine desktop action is malformed'),
		('{"type": "wiggle"}', '22023:Machine desktop action is malformed'),
		('[]', '22023:Machine desktop action is malformed'),
		('"click"', '22023:Machine desktop action is malformed')
	) as shape(action, expected))), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_4x') = '',
		E'4: action shapes that differ:\n' || current_setting('qorpera_test.dc_4x'));
	-- No row of the machine, its leases or its actions holds a text (the one refused above included).
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_desktop_actions as act
			where act::text like '%hunter2%')
		and not exists (select 1 from public.qorpera_company_machine_desktop_controls as control where control::text like '%hunter2%')
		and not exists (select 1 from public.qorpera_company_machines as machine where machine::text like '%hunter2%'),
		'4: no table holds a typed text');
end $$;
-- The action table refuses a text and an `open` even when written directly.
do $$
declare v text;
begin
	begin
		insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, begun_at)
		select pg_catalog.gen_random_uuid(), act.control_id, act.machine_id, act.user_id, '{"type": "type", "text": "hunter2"}',
			clock_timestamp()
		from public.qorpera_company_machine_desktop_actions as act where act.id = current_setting('qorpera_test.dc_a41')::uuid;
		v := 'inserted';
	exception when check_violation then v := 'refused';
	end;
	perform pg_temp.base_assert(v = 'refused', '4: the table refuses a text: ' || v);
	begin
		insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, begun_at)
		select pg_catalog.gen_random_uuid(), act.control_id, act.machine_id, act.user_id, '{"type": "open", "target": "/x"}',
			clock_timestamp()
		from public.qorpera_company_machine_desktop_actions as act where act.id = current_setting('qorpera_test.dc_a41')::uuid;
		v := 'inserted';
	exception when check_violation then v := 'refused';
	end;
	perform pg_temp.base_assert(v = 'refused', '4: the table refuses an open: ' || v);
end $$;

select set_config('qorpera_test.dc_4y', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('another member', pg_temp.dc_act('admin', 'a1', '{"type": "click", "x": 1, "y": 1}'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-act/v1', 'DESKTOP_MEMBER_IN_CONTROL')),
	jsonb_build_array('a viewer', pg_temp.dc_act('viewer', 'a1', '{"type": "click", "x": 1, "y": 1}'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('a stranger', pg_temp.dc_act('outsider', 'a1', '{"type": "click", "x": 1, "y": 1}'),
		'42501:Machine desktop is unavailable'),
	jsonb_build_array('a machine no one holds', pg_temp.dc_act('contributor', 'a4', '{"type": "click", "x": 1, "y": 1}'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-act/v1', 'DESKTOP_CONTROL_ENDED')),
	jsonb_build_array('a stopped machine', pg_temp.dc_act('contributor', 'a3', '{"type": "click", "x": 1, "y": 1}'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-act/v1', 'MACHINE_NOT_RUNNING')),
	jsonb_build_array('the service role', pg_temp.dc_service(format(
		'select public.qorpera_member_machine_desktop_act_begin(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a1'), '{"type": "click", "x": 1, "y": 1}')),
		'42501:permission denied for function qorpera_member_machine_desktop_act_begin')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_4y') = '',
		E'4: actions that differ:\n' || current_setting('qorpera_test.dc_4y'));
end $$;

-- The machine's last use: moved by a member's action at most every 30 seconds.
do $$
declare v_at timestamptz;
begin
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''10 seconds''');
	v_at := (pg_temp.dc_machine('a1')).last_used_at;
	perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "key", "keys": ["Return"]}');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).last_used_at = v_at, '4: within 30 seconds the last use stays');
	perform pg_temp.dc_shift('a1', 'last_used_at = clock_timestamp() - interval ''31 seconds''');
	v_at := (pg_temp.dc_machine('a1')).last_used_at;
	perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "key", "keys": ["Return"]}');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).last_used_at > v_at + interval '30 seconds',
		'4: after 30 seconds the last use moves');
end $$;

-- The disk's mark: an action of a member who does not read the folder's root (the root revoked; undone after) marks a
-- disk that never had a view, as an agent's action does; a root reader's does not.
do $$
begin
	perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "key", "keys": ["Tab"]}');
	perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
			where id = pg_temp.dc_id('b1')) is null, '4: a root reader''s action marks nothing');
	begin
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "key", "keys": ["Tab"]}');
		perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
				where id = pg_temp.dc_id('b1')) is not null, '4: without the root, the action marks the disk');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 5. The executor's read of an action -----------------------------------------------------------------------------------------

select set_config('qorpera_test.dc_a51', pg_temp.dc_act_id('contributor', 'a1', '{"type": "type", "length": 12}')::text, true);
select set_config('qorpera_test.dc_r51', pg_temp.dc_auth(current_setting('qorpera_test.dc_a51')::uuid, 'mx-node-1'), true);
select set_config('qorpera_test.dc_s51', coalesce(
	(select served_at::text from public.qorpera_company_machine_desktop_actions where id = current_setting('qorpera_test.dc_a51')::uuid),
	'unserved'), true);
select set_config('qorpera_test.dc_r52', pg_temp.dc_auth(current_setting('qorpera_test.dc_a51')::uuid), true);
select set_config('qorpera_test.dc_r53', pg_temp.dc_auth(current_setting('qorpera_test.dc_a51')::uuid), true);
do $$
declare v_where jsonb := jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'authorized',
	'actionId', current_setting('qorpera_test.dc_a51'), 'machineId', pg_temp.dc_id('a1'), 'placementId', pg_temp.dc_id('b1'),
	'bootId', pg_temp.dc_id('c1'), 'executorOwner', 'mx-1203', 'providerId', 'machine-1203',
	'userId', pg_temp.dc_user('contributor'), 'action', '{"type": "type", "length": 12}'::jsonb);
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_r51')) = v_where || '{"served": false}'
			and current_setting('qorpera_test.dc_s51') = 'unserved',
		'5: the executor that forwards it reads where it runs, without serving it: ' || current_setting('qorpera_test.dc_r51'));
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_r52')) = v_where || '{"served": true}'
			and (select served_at is not null from public.qorpera_company_machine_desktop_actions
				where id = current_setting('qorpera_test.dc_a51')::uuid),
		'5: the machine''s own executor is served the action as recorded: ' || current_setting('qorpera_test.dc_r52'));
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_r53') = '42501:Machine desktop action is unavailable',
		'5: served once: ' || current_setting('qorpera_test.dc_r53'));
end $$;

do $$
declare v_action uuid; v text;
begin
	-- An action begun more than 15 seconds ago.
	v_action := pg_temp.dc_act_id('contributor', 'a1', '{"type": "click", "x": 2, "y": 2}');
	set local session_replication_role = replica;
	update public.qorpera_company_machine_desktop_actions set begun_at = begun_at - interval '16 seconds' where id = v_action;
	set local session_replication_role = origin;
	v := pg_temp.dc_auth(v_action);
	perform pg_temp.base_assert(v = '42501:Machine desktop action is unavailable', '5: an old action: ' || v);
	-- The lease handed back meanwhile (undone after).
	v_action := pg_temp.dc_act_id('contributor', 'a1', '{"type": "click", "x": 2, "y": 2}');
	begin
		perform pg_temp.dc_back('contributor', 'a1');
		v := pg_temp.dc_auth(v_action);
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-act-authority/v1', 'DESKTOP_CONTROL_ENDED'),
			'5: a lease handed back meanwhile: ' || v);
		-- And taken again: a new lease, which the earlier action was not begun in.
		perform pg_temp.dc_take('contributor', 'a1');
		v := pg_temp.dc_auth(v_action);
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-act-authority/v1', 'DESKTOP_CONTROL_ENDED'),
			'5: nor in a lease taken again since: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The member made a viewer meanwhile.
	begin
		set local session_replication_role = replica;
		update public.qorpera_profile_members set role = 'viewer'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.dc_user('contributor');
		set local session_replication_role = origin;
		v := pg_temp.dc_auth(v_action);
		perform pg_temp.base_assert(v = '42501:Machine desktop action is unavailable', '5: a member made a viewer: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The machine stopped meanwhile.
	begin
		update public.qorpera_company_machines set desired_state = 'stopped' where id = pg_temp.dc_id('a1');
		v := pg_temp.dc_auth(v_action);
		perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop-act-authority/v1', 'MACHINE_NOT_RUNNING'),
			'5: a machine stopped meanwhile: ' || v);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	v := pg_temp.dc_auth(v_action);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'authorized', '5: undone, the action is served: ' || v);
end $$;

select set_config('qorpera_test.dc_5x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('no action', pg_temp.dc_service('select public.qorpera_member_machine_desktop_act_authority(null, ''mx-1203'', ''machine-1203'')'),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('an owner of another shape', pg_temp.dc_auth(current_setting('qorpera_test.dc_a41')::uuid, 'mx 1203'),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('an unknown action', pg_temp.dc_auth('12030000-0000-4000-8000-0000000009ff'),
		'42501:Machine desktop action is unavailable'),
	jsonb_build_array('a member', pg_temp.dc_as(pg_temp.dc_user('contributor'), format(
		'select public.qorpera_member_machine_desktop_act_authority(%L, %L, %L)', current_setting('qorpera_test.dc_a41'), 'mx-1203',
		'machine-1203')), '42501:permission denied for function qorpera_member_machine_desktop_act_authority')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_5x') = '',
		E'5: reads that differ:\n' || current_setting('qorpera_test.dc_5x'));
end $$;

-- 6. The lease ends by time alone ---------------------------------------------------------------------------------------------

-- The heartbeat renews the holder's lease; another member's is told it ended.
select set_config('qorpera_test.dc_k1', pg_temp.dc_keep('contributor', 'a1'), true);
select set_config('qorpera_test.dc_k2', pg_temp.dc_keep('admin', 'a1'), true);
do $$
declare v_machine public.qorpera_company_machines := pg_temp.dc_machine('a1');
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_k1')) ->> 'state' = 'ok'
			and (pg_temp.dc_answer(current_setting('qorpera_test.dc_k1')) ->> 'until')::timestamptz = v_machine.desktop_member_until
			and v_machine.desktop_member_until > v_machine.desktop_member_input_at + interval '5 minutes' - interval '1 second',
		'6: the heartbeat renews the holder''s lease: ' || current_setting('qorpera_test.dc_k1'));
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_k2') = 'ok:{"state": "ended", "schema": "qorpera.member-machine-desktop/v1"}',
		'6: another member''s heartbeat: ended: ' || current_setting('qorpera_test.dc_k2'));
end $$;

-- 30 minutes from the last input at most: a heartbeat 29 minutes after it renews only to the 30th.
do $$
declare v text; v_machine public.qorpera_company_machines;
begin
	perform pg_temp.dc_shift('a1', 'desktop_member_input_at = clock_timestamp() - interval ''29 minutes''');
	v := pg_temp.dc_keep('contributor', 'a1');
	v_machine := pg_temp.dc_machine('a1');
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok'
			and v_machine.desktop_member_until = v_machine.desktop_member_input_at + interval '30 minutes',
		'6: a heartbeat never renews past 30 minutes from the last input: ' || v);
end $$;
-- Time passes to the end of that lease: the agent's refusals stop by themselves, and so does the holder's hold.
select pg_temp.dc_shift('a1', 'desktop_member_input_at = clock_timestamp() - interval ''40 minutes'', '
	|| 'desktop_member_until = clock_timestamp() - interval ''1 minute''');
select set_config('qorpera_test.dc_6x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('the agent''s look', pg_temp.dc_answer(pg_temp.dc_look('a1')) ->> 'state', 'authorized'),
	jsonb_build_array('the agent''s coding value', pg_temp.dc_coding_value('302'),
		'55000:The coding value''s capture key must be made again'),
	jsonb_build_array('a viewer''s look', pg_temp.dc_answer(pg_temp.dc_begin_look('viewer', 'a1')) ->> 'state', 'ok'),
	jsonb_build_array('the list', pg_temp.dc_listed('viewer', 'm-1203') -> 'control', 'null'::jsonb),
	jsonb_build_array('the holder''s action', pg_temp.dc_act('contributor', 'a1', '{"type": "click", "x": 1, "y": 1}'),
		pg_temp.dc_refused('qorpera.member-machine-desktop-act/v1', 'DESKTOP_CONTROL_ENDED')),
	jsonb_build_array('the holder''s heartbeat', pg_temp.dc_keep('contributor', 'a1'),
		'ok:{"state": "ended", "schema": "qorpera.member-machine-desktop/v1"}')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_6x') = '',
		E'6: after the lease''s end, reads that differ:\n' || current_setting('qorpera_test.dc_6x'));
end $$;
-- The admin takes over: the idle lease is closed as such. The contributor gives back nothing of the admin's.
select set_config('qorpera_test.dc_t61', pg_temp.dc_take('admin', 'a1'), true);
select set_config('qorpera_test.dc_b61', pg_temp.dc_back('contributor', 'a1'), true);
select set_config('qorpera_test.dc_c61', pg_temp.dc_controls('a1')::text, true);
select set_config('qorpera_test.dc_b62', pg_temp.dc_back('admin', 'a1', 'closed'), true);
do $$
declare v_machine public.qorpera_company_machines := pg_temp.dc_machine('a1');
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_t61')) ->> 'state' = 'ok'
			and current_setting('qorpera_test.dc_c61')::jsonb -> 0 -> 1 = '"idle"'
			and current_setting('qorpera_test.dc_c61')::jsonb -> 1 = jsonb_build_array(pg_temp.dc_user('admin'), null, 0),
		'6: a take-over after an idle lease closes it as idle: ' || current_setting('qorpera_test.dc_c61'));
	perform pg_temp.base_assert(pg_temp.dc_backed(current_setting('qorpera_test.dc_b61'), false),
		'6: a member gives back only their own: ' || current_setting('qorpera_test.dc_b61'));
	perform pg_temp.base_assert(pg_temp.dc_backed(current_setting('qorpera_test.dc_b62'), true)
			and pg_temp.dc_controls('a1') -> 1 -> 1 = '"closed"'
			and v_machine.desktop_member_user_id is null and v_machine.desktop_member_since is null
			and v_machine.desktop_member_until is null and v_machine.desktop_member_input_at is null,
		'6: the admin''s window closed: the lease is given back: ' || current_setting('qorpera_test.dc_b62'));
end $$;
-- A lease whose heartbeat stopped (5 minutes passed, the last input recent) lapses; the next take-over closes it as such.
-- A member who hands back a lapsed lease closes it as it ended.
select pg_temp.dc_take('contributor', 'a1');
select pg_temp.dc_shift('a1', 'desktop_member_input_at = clock_timestamp() - interval ''6 minutes'', '
	|| 'desktop_member_until = clock_timestamp() - interval ''1 minute''');
select set_config('qorpera_test.dc_t63', pg_temp.dc_take('owner', 'a1'), true);
select set_config('qorpera_test.dc_c63', pg_temp.dc_controls('a1')::text, true);
select pg_temp.dc_shift('a1', 'desktop_member_until = clock_timestamp() - interval ''1 second''');
select set_config('qorpera_test.dc_b63', pg_temp.dc_back('owner', 'a1'), true);
do $$
begin
	perform pg_temp.base_assert(pg_temp.dc_answer(current_setting('qorpera_test.dc_t63')) ->> 'state' = 'ok'
			and current_setting('qorpera_test.dc_c63')::jsonb -> 2 -> 1 = '"lapsed"',
		'6: a lease whose heartbeat stopped lapses: ' || current_setting('qorpera_test.dc_c63'));
	perform pg_temp.base_assert(pg_temp.dc_backed(current_setting('qorpera_test.dc_b63'), false)
			and pg_temp.dc_controls('a1') -> 3 -> 1 = '"lapsed"' and (pg_temp.dc_machine('a1')).desktop_member_user_id is null,
		'6: handing back a lapsed lease closes it as it ended: ' || current_setting('qorpera_test.dc_b63') || pg_temp.dc_controls('a1')::text);
end $$;
-- Handed back by the member's word.
select pg_temp.dc_take('contributor', 'a1');
select set_config('qorpera_test.dc_b64', pg_temp.dc_back('contributor', 'a1'), true);
select set_config('qorpera_test.dc_6y', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('handed back', pg_temp.dc_backed(current_setting('qorpera_test.dc_b64'), true)::text, 'true'),
	jsonb_build_array('its row', pg_temp.dc_controls('a1') -> 4 ->> 1, 'handed_back'),
	jsonb_build_array('the agent looks again', pg_temp.dc_answer(pg_temp.dc_look('a1')) ->> 'state', 'authorized'),
	jsonb_build_array('the agent starts a command again', pg_temp.dc_answer(pg_temp.dc_command('103', 'start')) ->> 'state',
		'authorized'),
	jsonb_build_array('another reason', pg_temp.dc_back('contributor', 'a1', 'idle'), '22023:Machine desktop request is malformed'),
	jsonb_build_array('no epoch', pg_temp.dc_as(pg_temp.dc_user('contributor'), format(
		'select public.qorpera_member_hand_back_machine_desktop(%L, %L, %L, null)', '92400000-0000-4000-8000-000000000010',
		pg_temp.dc_id('a1'), 'handed_back')), '22023:Machine desktop request is malformed'),
	jsonb_build_array('an epoch below 0', pg_temp.dc_back('contributor', 'a1', 'handed_back', -1),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('a stranger', pg_temp.dc_back('outsider', 'a1'), '42501:Machine desktop is unavailable')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_6y') = '',
		E'6: hand-backs that differ:\n' || current_setting('qorpera_test.dc_6y'));
end $$;

-- 7. The `machines` hint ------------------------------------------------------------------------------------------------------

-- The hints sent so far to the company's members, as event:member, sorted.
create function pg_temp.dc_hints() returns text language sql as $$
	select coalesce(string_agg(label, ' ' order by label collate "C"), '')
	from (select message.event || ':' || substring(message.topic from 51) as label from realtime.messages as message
		where message.topic like 'qorpera-live-%' and message.event = 'machines') as hint
$$;
create function pg_temp.dc_clear() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;
create function pg_temp.dc_flush() returns void language plpgsql as $$
begin
	set constraints qorpera_machine_hint, qorpera_machine_hint_change immediate;
	set constraints qorpera_machine_hint, qorpera_machine_hint_change deferred;
end $$;
create function pg_temp.dc_hinted(p_call text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.dc_flush();
	perform pg_temp.dc_clear();
	execute 'select ' || p_call;
	perform pg_temp.dc_flush();
	v := pg_temp.dc_hints();
	perform pg_temp.dc_clear();
	return v;
end $$;
select set_config('qorpera_test.dc_all', 'machines:92400000-0000-4000-8000-000000000001 '
	|| 'machines:92400000-0000-4000-8000-000000000002 machines:92400000-0000-4000-8000-000000000003 '
	|| 'machines:92400000-0000-4000-8000-000000000004', true);
savepoint dc_hints;
select set_config('qorpera_test.dc_7x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('1 a take-over', pg_temp.dc_hinted('pg_temp.dc_take(''contributor'', ''a1'')'),
		current_setting('qorpera_test.dc_all')),
	jsonb_build_array('2 taking again', pg_temp.dc_hinted('pg_temp.dc_take(''contributor'', ''a1'')'), ''),
	jsonb_build_array('3 an action', pg_temp.dc_hinted('pg_temp.dc_act(''contributor'', ''a1'', ''{"type": "click", "x": 1, "y": 1}'')'),
		''),
	jsonb_build_array('4 a heartbeat', pg_temp.dc_hinted('pg_temp.dc_keep(''contributor'', ''a1'')'), ''),
	jsonb_build_array('5 handed back', pg_temp.dc_hinted('pg_temp.dc_back(''contributor'', ''a1'')'),
		current_setting('qorpera_test.dc_all'))
)), true);
-- Read before the rollback below, which undoes these transaction-local settings with the rest.
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_7x', true) = '',
		E'7: hints that differ:\n' || coalesce(current_setting('qorpera_test.dc_7x', true), 'unset'));
end $$;
rollback to savepoint dc_hints;

-- 9. The fence after a capture (review r1 F1) -----------------------------------------------------------------------------

create function pg_temp.dc_generation(p_machine text) returns bigint language sql as $$
	select desktop_member_generation from public.qorpera_company_machines where id = pg_temp.dc_id(p_machine)
$$;
create function pg_temp.dc_check(p_generation bigint, p_who text default null, p_placement text default 'b1')
returns text language sql as $$
	select pg_temp.dc_service(format('select public.qorpera_machine_desktop_picture_check(%L, %L, %L)',
		pg_temp.dc_id(p_placement), p_generation, case when p_who is not null then pg_temp.dc_user(p_who) end))
$$;
select set_config('qorpera_test.dc_ok', 'ok:{"state": "ok", "schema": "qorpera.machine-desktop-picture/v1"}', true);
select set_config('qorpera_test.dc_held', pg_temp.dc_refused('qorpera.machine-desktop-picture/v1',
	'DESKTOP_MEMBER_IN_CONTROL'), true);
do $$
declare v_g bigint; v_look jsonb; v_begin text; v_member jsonb; v text;
begin
	-- No one holds m-1203 now (6 ended with a hand-back): an agent's look answers the generation, and its picture leaves.
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).desktop_member_user_id is null, '9: no one holds m-1203');
	v_g := pg_temp.dc_generation('a1');
	v_look := pg_temp.dc_answer(pg_temp.dc_look('a1'));
	perform pg_temp.base_assert((v_look ->> 'desktopGeneration')::bigint = v_g and v_g > 0,
		'9: the agent''s look answers the lease generation it saw: ' || v_look::text);
	perform pg_temp.base_assert(pg_temp.dc_check(v_g) = current_setting('qorpera_test.dc_ok'),
		'9: no hold, the same generation: the agent''s picture leaves');
	-- A take-over moves it; taking again, an action and a heartbeat do not; a hand-back does.
	perform pg_temp.dc_take('contributor', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_generation('a1') = v_g + 1, '9: a take-over moves the generation');
	perform pg_temp.dc_take('contributor', 'a1');
	perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "type", "length": 3}');
	perform pg_temp.dc_keep('contributor', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_generation('a1') = v_g + 1, '9: taking again, an action and a heartbeat do not');
	-- The holder sees their own screen; nobody else does, no agent either, and no picture of before the take-over.
	perform pg_temp.base_assert(pg_temp.dc_check(v_g + 1, 'contributor') = current_setting('qorpera_test.dc_ok'),
		'9: the holder''s own picture leaves');
	perform pg_temp.base_assert(pg_temp.dc_check(v_g + 1, 'admin') = current_setting('qorpera_test.dc_held')
			and pg_temp.dc_check(v_g + 1) = current_setting('qorpera_test.dc_held')
			and pg_temp.dc_check(v_g, 'contributor') = current_setting('qorpera_test.dc_held'),
		'9: another member''s, an agent''s and a picture from before the take-over do not');
	perform pg_temp.dc_back('contributor', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_generation('a1') = v_g + 2, '9: a hand-back moves the generation');
	-- Taken over and handed back while a look was on its way: no hold now, but that picture never leaves.
	perform pg_temp.base_assert(pg_temp.dc_check(v_g) = current_setting('qorpera_test.dc_held')
			and pg_temp.dc_check(v_g + 1) = current_setting('qorpera_test.dc_held')
			and pg_temp.dc_check(v_g + 2) = current_setting('qorpera_test.dc_ok'),
		'9: only the generation of now lets a picture out');

	-- (i) Member B (the viewer) begins a look and the executor reads it; then A (the contributor) takes over and types;
	--     then B's capture returns: B's picture does not leave.
	v_begin := pg_temp.dc_begin_look('viewer', 'a1');
	v_member := pg_temp.dc_answer(pg_temp.dc_look_auth(v_begin));
	perform pg_temp.base_assert(v_member ->> 'state' = 'authorized' and (v_member ->> 'desktopGeneration')::bigint = v_g + 2,
		'9: a member''s look read answers the generation: ' || coalesce(v_member::text, v_begin));
	perform pg_temp.dc_take('contributor', 'a1');
	perform pg_temp.dc_act_id('contributor', 'a1', '{"type": "type", "length": 8}');
	v := pg_temp.dc_check((v_member ->> 'desktopGeneration')::bigint, 'viewer');
	perform pg_temp.base_assert(v = current_setting('qorpera_test.dc_held'), '9 (i): B''s picture stays: ' || v);
	perform pg_temp.dc_back('contributor', 'a1');

	-- (ii) An agent's look is read; the take-over, the input and even the hand-back all finish before its capture comes
	--      back: the agent's picture does not leave either.
	v_look := pg_temp.dc_answer(pg_temp.dc_look('a1'));
	perform pg_temp.dc_take('admin', 'a1');
	perform pg_temp.dc_act_id('admin', 'a1', '{"type": "key", "keys": ["Return"]}');
	perform pg_temp.dc_back('admin', 'a1');
	v := pg_temp.dc_check((v_look ->> 'desktopGeneration')::bigint);
	perform pg_temp.base_assert(v = current_setting('qorpera_test.dc_held'), '9 (ii): the agent''s picture stays: ' || v);
end $$;

select set_config('qorpera_test.dc_9x', pg_temp.dc_differ(jsonb_build_array(
	jsonb_build_array('no placement', pg_temp.dc_service('select public.qorpera_machine_desktop_picture_check(null, 0, null)'),
		'22023:Machine desktop request is malformed'),
	jsonb_build_array('a generation below 0', pg_temp.dc_check(-1), '22023:Machine desktop request is malformed'),
	jsonb_build_array('another placement', pg_temp.dc_check(0, null, 'ff'), '42501:Machine desktop is unavailable'),
	jsonb_build_array('a member', pg_temp.dc_as(pg_temp.dc_user('owner'), format(
		'select public.qorpera_machine_desktop_picture_check(%L, 0, null)', pg_temp.dc_id('b1'))),
		'42501:permission denied for function qorpera_machine_desktop_picture_check')
)), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.dc_9x') = '',
		E'9: checks that differ:\n' || current_setting('qorpera_test.dc_9x'));
end $$;

-- 10. A root read taken away between an action's begin and the executor's read (review r1 F2) ------------------------------

do $$
declare v_action uuid; v text;
begin
	perform pg_temp.dc_take('contributor', 'a1');
	perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
			where id = pg_temp.dc_id('b1')) is null
		and not exists (select 1 from public.qorpera_folder_views where placement_id = pg_temp.dc_id('b1')),
		'10: m-1203''s disk never had a view and is unmarked');
	begin
		-- Begun while the member reads the root: nothing marked.
		v_action := pg_temp.dc_act_id('contributor', 'a1', '{"type": "type", "length": 4}');
		perform pg_temp.base_assert((select folder_unchecked_at from public.qorpera_company_machine_placements
			where id = pg_temp.dc_id('b1')) is null, '10: the begin of a root reader marks nothing');
		-- The root read goes before the executor reads the action.
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		v := pg_temp.dc_auth(v_action);
		perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'authorized'
				and (select folder_unchecked_at from public.qorpera_company_machine_placements
					where id = pg_temp.dc_id('b1')) is not null,
			'10: the action runs, and its read marks the disk: ' || v);
		-- The root read back: the disk stays marked, and the platform's open refuses it.
		set local session_replication_role = replica;
		update public.qorpera_company_path_resources set revoked_at = null
		where environment_id = '92400000-0000-4000-8000-000000000020' and path = '';
		set local session_replication_role = origin;
		perform pg_temp.base_claims('service_role');
		perform pg_temp.base_error(format(
			'select public.qorpera_folder_view_open(%L, %L, %L, %L)', '92400000-0000-4000-8000-000000000020',
			'{"kind":"platform"}', 'test_machine', jsonb_build_object('companyMachineId', pg_temp.dc_id('a1'),
				'placementId', pg_temp.dc_id('b1'), 'bootId', pg_temp.dc_id('c1'))),
			'42501', 'Test machine disk was used without the folder check');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.dc_back('contributor', 'a1');
end $$;

-- 11. Hand-back epochs (review r5 of #1661) -------------------------------------------------------------------------------

do $$
declare
	v_e bigint;
	v_g bigint;
	v_before public.qorpera_company_machines;
	v_after public.qorpera_company_machines;
	v_controls jsonb;
	v text;
	v_ended text := 'ok:{"state": "ended", "schema": "qorpera.member-machine-desktop/v1"}';
	v_admin bigint;
	n integer;
begin
	-- A machine never handed back has no row: its epoch is 0 for every member, in the list too.
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_desktop_epochs
			where machine_id = pg_temp.dc_id('a4'))
			and pg_temp.dc_epoch('contributor', 'a4') = 0
			and (pg_temp.dc_listed('contributor', 'm-1203-other') ->> 'epoch')::bigint = 0,
		'11: a machine with no row yet: epoch 0');
	perform pg_temp.base_assert((pg_temp.dc_machine('a1')).desktop_member_user_id is null, '11: no one holds m-1203');
	-- A take-over at the current epoch: the lease is taken under it.
	v_e := pg_temp.dc_epoch('contributor', 'a1');
	v_g := pg_temp.dc_generation('a1');
	v := pg_temp.dc_take('contributor', 'a1', p_epoch => v_e);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok' and (pg_temp.dc_machine('a1')).desktop_member_epoch = v_e
			and pg_temp.dc_generation('a1') = v_g + 1,
		'11: a take-over at the current epoch: ' || v);
	-- The hand-back at the current epoch ends the lease and moves the epoch on by one (and the generation, as 9 needs).
	v := pg_temp.dc_back('contributor', 'a1', 'handed_back', v_e);
	v_after := pg_temp.dc_machine('a1');
	perform pg_temp.base_assert(pg_temp.dc_backed(v, true) and (pg_temp.dc_answer(v) ->> 'epoch')::bigint = v_e + 1
			and pg_temp.dc_epoch('contributor', 'a1') = v_e + 1 and v_after.desktop_member_user_id is null
			and v_after.desktop_member_epoch is null and v_after.desktop_member_generation = v_g + 2
			and pg_temp.dc_controls('a1') -> -1 ->> 1 = 'handed_back',
		'11: a hand-back at the current epoch ends the lease and moves the epoch: ' || v);
	-- Again at the same epoch: nothing changes, and it answers the same epoch.
	v := pg_temp.dc_back('contributor', 'a1', 'handed_back', v_e);
	perform pg_temp.base_assert(pg_temp.dc_backed(v, false) and (pg_temp.dc_answer(v) ->> 'epoch')::bigint = v_e + 1
			and pg_temp.dc_epoch('contributor', 'a1') = v_e + 1 and pg_temp.dc_generation('a1') = v_g + 2,
		'11: a repeated hand-back changes nothing: ' || v);
	-- A take-over at the older epoch (sent before that hand-back was answered, arriving now) is refused, with the current
	-- epoch, and holds, moves and records nothing; so is one at an epoch not reached yet.
	v_before := pg_temp.dc_machine('a1');
	v_controls := pg_temp.dc_controls('a1');
	v := pg_temp.dc_take('contributor', 'a1', p_epoch => v_e);
	v_after := pg_temp.dc_machine('a1');
	perform pg_temp.base_assert(v = pg_temp.dc_refused('qorpera.member-machine-desktop/v1', 'TAKE_CALLED_OFF',
				jsonb_build_object('epoch', v_e + 1))
			and v_after.desktop_member_user_id is null and v_after.desktop_member_until is null
			and v_after.desktop_member_generation = v_before.desktop_member_generation
			and v_after.last_used_at is not distinct from v_before.last_used_at and pg_temp.dc_controls('a1') = v_controls,
		'11: a take-over at an older epoch is refused, nothing changed: ' || v);
	v := pg_temp.dc_take('contributor', 'a1', p_epoch => v_e + 5);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'reason' = 'TAKE_CALLED_OFF'
			and (pg_temp.dc_machine('a1')).desktop_member_user_id is null,
		'11: and one at an epoch not reached yet: ' || v);

	-- (i) R1, the hand-back of A's epoch, is late: its retry R2 gave A's lease back, B took the desktop at the new epoch,
	--     then R1 arrives: B keeps its lease, and R1 says the member holds the machine now.
	v_e := pg_temp.dc_epoch('contributor', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e)) ->> 'state' = 'ok',
		'11 (i): A takes over');
	perform pg_temp.base_assert(pg_temp.dc_backed(pg_temp.dc_back('contributor', 'a1', 'closed', v_e), true),
		'11 (i): R2 gives A''s lease back');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e + 1)) ->> 'state' = 'ok',
		'11 (i): B takes over at the new epoch');
	v := pg_temp.dc_back('contributor', 'a1', 'closed', v_e);
	v_after := pg_temp.dc_machine('a1');
	perform pg_temp.base_assert(pg_temp.dc_backed(v, false, true) and (pg_temp.dc_answer(v) ->> 'epoch')::bigint = v_e + 1
			and v_after.desktop_member_user_id = pg_temp.dc_user('contributor') and v_after.desktop_member_epoch = v_e + 1
			and v_after.desktop_member_until > clock_timestamp(),
		'11 (i): R1 arrives late and ends nothing of B''s: ' || v);
	-- The heartbeat renews only a lease taken under the epoch it names.
	perform pg_temp.base_assert(pg_temp.dc_keep('contributor', 'a1', v_e) = v_ended
			and pg_temp.dc_answer(pg_temp.dc_keep('contributor', 'a1', v_e + 1)) ->> 'state' = 'ok'
			and pg_temp.dc_keep('admin', 'a1', v_e + 1) = v_ended,
		'11: the heartbeat renews only the lease taken under its epoch, and only the holder''s');
	-- Taking again at the same epoch renews, as ever.
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e + 1)) ->> 'state' = 'ok'
			and (pg_temp.dc_machine('a1')).desktop_member_epoch = v_e + 1,
		'11: the holder taking again at the same epoch renews');
	perform pg_temp.base_assert(pg_temp.dc_backed(pg_temp.dc_back('contributor', 'a1', 'handed_back', v_e + 1), true),
		'11 (i): B gives it back');
	-- (ii) R1 arrives before B takes: nothing to give back; B takes at the new epoch.
	v_e := pg_temp.dc_epoch('contributor', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e)) ->> 'state' = 'ok',
		'11 (ii): A takes over');
	perform pg_temp.base_assert(pg_temp.dc_backed(pg_temp.dc_back('contributor', 'a1', 'closed', v_e), true),
		'11 (ii): R2 gives it back');
	v := pg_temp.dc_back('contributor', 'a1', 'closed', v_e);
	perform pg_temp.base_assert(pg_temp.dc_backed(v, false) and (pg_temp.dc_answer(v) ->> 'epoch')::bigint = v_e + 1,
		'11 (ii): R1 arrives before B: nothing to give back: ' || v);
	v := pg_temp.dc_take('contributor', 'a1', p_epoch => v_e + 1);
	perform pg_temp.base_assert(pg_temp.dc_answer(v) ->> 'state' = 'ok'
			and (pg_temp.dc_machine('a1')).desktop_member_epoch = v_e + 1, '11 (ii): B takes over at the new epoch: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_backed(pg_temp.dc_back('contributor', 'a1', 'handed_back', v_e + 1), true),
		'11 (ii): B gives it back');
	-- A take-over sent under an epoch whose hand-back was answered is refused whenever it arrives, also after many
	-- further epochs.
	for n in 1 .. 50 loop
		perform pg_temp.dc_back('contributor', 'a1');
	end loop;
	perform pg_temp.base_assert(pg_temp.dc_epoch('contributor', 'a1') = v_e + 52
			and pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e)) ->> 'reason' = 'TAKE_CALLED_OFF'
			and pg_temp.dc_answer(pg_temp.dc_take('contributor', 'a1', p_epoch => v_e + 1)) ->> 'reason' = 'TAKE_CALLED_OFF'
			and (pg_temp.dc_machine('a1')).desktop_member_user_id is null,
		'11: a take-over under an epoch handed back is refused after 50 more epochs');

	-- Two members are independent: the contributor's hand-backs never move the admin's epoch nor end the admin's lease.
	v_admin := pg_temp.dc_epoch('admin', 'a1');
	perform pg_temp.base_assert(pg_temp.dc_answer(pg_temp.dc_take('admin', 'a1', p_epoch => v_admin)) ->> 'state' = 'ok',
		'11: the admin takes over at their own epoch');
	v_e := pg_temp.dc_epoch('contributor', 'a1');
	v := pg_temp.dc_back('contributor', 'a1', 'handed_back', v_e);
	perform pg_temp.base_assert(pg_temp.dc_backed(v, false) and pg_temp.dc_epoch('contributor', 'a1') = v_e + 1
			and pg_temp.dc_epoch('admin', 'a1') = v_admin
			and (pg_temp.dc_machine('a1')).desktop_member_user_id = pg_temp.dc_user('admin')
			and (pg_temp.dc_listed('admin', 'm-1203') ->> 'epoch')::bigint = v_admin
			and (pg_temp.dc_listed('admin', 'm-1203') -> 'control' ->> 'epoch')::bigint = v_admin
			and (pg_temp.dc_listed('contributor', 'm-1203') ->> 'epoch')::bigint = v_e + 1
			and not (pg_temp.dc_listed('contributor', 'm-1203') -> 'control' ? 'epoch'),
		'11: the contributor''s hand-back leaves the admin''s epoch and lease; each list says its own: ' || v);
	perform pg_temp.base_assert(pg_temp.dc_backed(pg_temp.dc_back('admin', 'a1', 'handed_back', v_admin), true)
			and pg_temp.dc_epoch('admin', 'a1') = v_admin + 1
			and (pg_temp.dc_machine('a1')).desktop_member_user_id is null,
		'11: the admin gives it back at their epoch');
end $$;

-- 8. Grants, the closed tables and the marker ---------------------------------------------------------------------------------

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		foreach v_function in array array['public.qorpera_member_take_machine_desktop(uuid,uuid,bigint)',
			'public.qorpera_member_keep_machine_desktop(uuid,uuid,bigint)',
			'public.qorpera_member_hand_back_machine_desktop(uuid,uuid,text,bigint)',
			'public.qorpera_member_machine_desktop_act_begin(uuid,uuid,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'execute') = (v_role = 'authenticated'),
				format('8: %s may%s call %s', v_role, case when v_role = 'authenticated' then '' else ' not' end, v_function));
		end loop;
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_member_machine_desktop_act_authority(uuid,text,text)', 'execute') = (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_machine_desktop_picture_check(uuid,bigint,uuid)', 'execute')
				= (v_role = 'service_role'),
			'8: the executor''s reads are the service role''s alone: ' || v_role);
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_valid_member_desktop_action(jsonb)', 'execute'),
			'8: the action check is no role''s: ' || v_role);
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_machine_desktop_controls',
				'select, insert, update, delete')
			and not has_table_privilege(v_role, 'public.qorpera_company_machine_desktop_actions', 'select, insert, update, delete')
			and not has_table_privilege(v_role, 'public.qorpera_company_machine_desktop_epochs', 'select, insert, update, delete'),
			'8: the leases, the actions and the hand-back epochs are closed to ' || v_role);
	end loop;
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_machine_desktop_controls'::regclass)
			and (select relrowsecurity from pg_class where oid = 'public.qorpera_company_machine_desktop_actions'::regclass)
			and (select relrowsecurity from pg_class where oid = 'public.qorpera_company_machine_desktop_epochs'::regclass),
		'8: row level security on the three tables');
	-- The action check is the agent's (one xdotool list, which cloud-machine-screen.test.ts pins to the helper's), never open.
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_valid_member_desktop_action(jsonb)'::regprocedure), 'public.qorpera_valid_machine_screen_call(') > 0,
		'8: the member''s action check is the agent''s call check');
	perform pg_temp.base_assert((select array_agg(proname::text order by proname) from pg_proc
			where pronamespace = 'public'::regnamespace and strpos(prosrc, '20260930713000') > 0)
		= array['qorpera_authorize_machine_coding_value', 'qorpera_authorize_machine_command', 'qorpera_authorize_machine_screen',
			'qorpera_list_agent_machines', 'qorpera_machine_desktop_picture_check', 'qorpera_member_hand_back_machine_desktop',
			'qorpera_member_keep_machine_desktop', 'qorpera_member_machine_desktop_act_authority',
			'qorpera_member_machine_desktop_act_begin',
			'qorpera_member_machine_screen_authority', 'qorpera_member_machine_screen_begin',
			'qorpera_member_take_machine_desktop', 'qorpera_valid_member_desktop_action'],
		'8: the bodies that name 20260930713000: ' || (select array_agg(proname::text order by proname)::text from pg_proc
			where pronamespace = 'public'::regnamespace and strpos(prosrc, '20260930713000') > 0));
end $$;
