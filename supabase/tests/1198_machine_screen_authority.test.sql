-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930708000: machine_screen, an agent's look at and action on a company machine's desktop in one tool call. The
-- coding executor reads qorpera_authorize_machine_screen before it runs the machine's screen helper. On 924's base
-- (Alice's live run for the owner, in a company conversation), with the company's running task machine m-1198, a stopped
-- one and another company's running machine of the same name:
-- 1. a look: authorized without a receipt; where the machine runs; the machine's last use moved, then throttled;
-- 2. a look refused: another company's machine, a stopped machine (MACHINE_NOT_RUNNING, answered), a removed one, a
--    malformed request, a run outside a company conversation;
-- 3. an action: this run's executing machine_screen:<key> receipt of exactly the envelope; the action, the settle time
--    (500 ms, 2500 for open, or as given) and the look as the receipt holds them;
-- 4. an action refused: the call (tool, version, key, target, arguments), the receipt (never begun, another call's,
--    another tool's key, completed), the machine (another name, another company's, stopped);
-- 5. a paused company: an action refused; a look too, by the run's own check (every tool of a paused company's run
--    is refused there), so the look's own rule (no wake check) never decides;
-- 6. the call check's shapes per verb, no key an xdotool command word (review r1 F2);
-- 7. the grants, the observations' list and the marker;
-- 8. the disk's company folder access, as a machine command's (review r1 F1; 20260930420000, 20260930424000): a caller
--    whose agent does not read the root looks and acts on a disk that never had a view, and its action (not its look)
--    marks the disk, which the platform's open then refuses; a root reader's actions leave it unmarked; once the disk has
--    a view, a caller whose agent or member does not read the root is refused a look and an action alike
--    (MACHINE_NEEDS_COMPANY_VIEW, answered), and a root reader is not.

-- Alice's run acknowledges first, as a member's wake requires before any work (924).
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'ms-ack') is not null;

-- The company's task machine m-1198, started by Alice's run and running a boot on its placement (reserved on a node, as an
-- executor's custody leaves it), last used an hour ago; a stopped one; a removed one; and another company's machine of
-- the same name, running.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('11980000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state, last_used_at, removed_at)
select machine.id, machine.profile_id, machine.environment_id, machine.name, 'Tests the app.', run.staff_agent_id, run.id,
	machine.receipt_id, run.requested_by_user_id, 2, 4294967296, 21474836480, 'standard', 'task', machine.desired_state,
	clock_timestamp() - interval '1 hour', machine.removed_at
from public.qorpera_execution_runs as run
cross join (values
	('11980000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1198', '11980000-0000-4000-8000-0000000007a9'::uuid, 'running',
		null::timestamptz),
	('11980000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1198-asleep', '11980000-0000-4000-8000-0000000007aa', 'stopped', null),
	('11980000-0000-4000-8000-0000000007a3', '11980000-0000-4000-8000-000000000011', '11980000-0000-4000-8000-0000000007e3',
		'm-1198', '11980000-0000-4000-8000-0000000007ab', 'running', null),
	('11980000-0000-4000-8000-0000000007a4', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1198-gone', '11980000-0000-4000-8000-0000000007ac', 'deleted', clock_timestamp())
) as machine(id, profile_id, environment_id, name, receipt_id, desired_state, removed_at)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
values ('11980000-0000-4000-8000-0000000007b1', '11980000-0000-4000-8000-0000000007a1', '92400000-0000-4000-8000-000000000010',
		'mx-1198', repeat('8', 64), '{"providerId": "machine-1198"}', repeat('7', 64), clock_timestamp(),
		'11980000-0000-4000-8000-0000000007c1'),
	('11980000-0000-4000-8000-0000000007b3', '11980000-0000-4000-8000-0000000007a3', '11980000-0000-4000-8000-000000000011',
		'mx-1198', repeat('8', 64), '{"providerId": "machine-1198"}', repeat('6', 64), clock_timestamp(),
		'11980000-0000-4000-8000-0000000007c3');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement
where placement.id in ('11980000-0000-4000-8000-0000000007b1', '11980000-0000-4000-8000-0000000007b3');
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '11980000-0000-4000-8000-0000000007d1', 'machine', 'machine-1198', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement
where placement.id in ('11980000-0000-4000-8000-0000000007b1', '11980000-0000-4000-8000-0000000007b3');
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.ms_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.ms_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
grant execute on function pg_temp.ms_try(text) to service_role;
-- One machine_screen action's operation envelope, as the machine tools write it: a click on m-1198, unless the arguments
-- (p_args, merged over the call's), the operation (p_operation) or the target (p_target) change.
create function pg_temp.ms_envelope(p_key text, p_args jsonb default '{}', p_operation jsonb default '{}',
	p_target jsonb default '{}') returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'machine_screen', 'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_strip_nulls(jsonb_build_object('operationKey', p_key, 'machine', 'm-1198',
				'action', jsonb_build_object('type', 'click', 'x', 812, 'y', 443), 'intent', 'Open the sign-in form.') || p_args),
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', '11980000-0000-4000-8000-0000000007a1')
				|| p_target) || p_operation)::text;
end $$;
-- Receipt n ('11980000-0000-4000-8000-0000000001' || n) begins as the call of an envelope, under machine_screen's key
-- unless another tool is named; ms_end completes it.
create function pg_temp.ms_begin(p_n text, p_envelope text, p_tool text default 'machine_screen')
returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('11980000-0000-4000-8000-0000000001' || p_n)::uuid, p_tool || ':' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'),
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
end $$;
create function pg_temp.ms_end(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('11980000-0000-4000-8000-0000000001' || p_n)::uuid, encode(extensions.digest(p_envelope, 'sha256'), 'hex'), '{}'::jsonb);
end $$;
-- The coding executor's read, as the service role: a look (no receipt n, no envelope) or an action, for m-1198 unless
-- another machine (or scope) is named.
create function pg_temp.ms_auth(p_n text, p_envelope text, p_machine text default '11980000-0000-4000-8000-0000000007a1',
	p_scope jsonb default null)
returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.ms_try(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, %L::uuid, %L)',
		current_setting('qorpera_test.base_binding'), coalesce(p_scope, jsonb_build_object('machineId', p_machine)),
		case when p_n is not null then '11980000-0000-4000-8000-0000000001' || p_n end, p_envelope));
	reset role;
	return v;
end $$;
create function pg_temp.ms_used() returns timestamptz language sql as $$
	select last_used_at from public.qorpera_company_machines where id = '11980000-0000-4000-8000-0000000007a1'
$$;
-- The test's answers that differ from what they expect, one per line.
create function pg_temp.ms_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;
-- Where m-1198 runs, as every authorized answer says it, with the rest (p_rest) of one answer.
create function pg_temp.ms_where(p_rest jsonb) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'authorized',
		'machineId', '11980000-0000-4000-8000-0000000007a1', 'placementId', '11980000-0000-4000-8000-0000000007b1',
		'bootId', '11980000-0000-4000-8000-0000000007c1', 'executorOwner', 'mx-1198', 'providerId', 'machine-1198',
		'runId', run.id, 'staffAgentId', run.staff_agent_id, 'requesterUserId', run.requested_by_user_id,
		-- The lease generation the read saw (20260930713000): no member ever took m-1198 over, so no clear is owed (F35).
		'desktopGeneration', 0, 'clipboardClear', false) || p_rest
	from public.qorpera_execution_runs as run
	where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;

-- 1. A look --------------------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.ms_used0', pg_temp.ms_used()::text, true);
select set_config('qorpera_test.ms_look1', pg_temp.ms_auth(null, null), true);
select set_config('qorpera_test.ms_used1', pg_temp.ms_used()::text, true);
select set_config('qorpera_test.ms_look2', pg_temp.ms_auth(null, null), true);
select set_config('qorpera_test.ms_used2', pg_temp.ms_used()::text, true);

do $$
begin
	perform pg_temp.base_assert(pg_temp.ms_answer(current_setting('qorpera_test.ms_look1')) = pg_temp.ms_where(
			jsonb_build_object('receiptId', null, 'action', null, 'settleMs', null, 'look', null)),
		'1: a look: ' || current_setting('qorpera_test.ms_look1'));
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_look2') = current_setting('qorpera_test.ms_look1'),
		'1: a second look: ' || current_setting('qorpera_test.ms_look2'));
	-- The idle rule's clock: an hour old, moved by the first look, not by the second within 30 seconds.
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_used1')::timestamptz
			> current_setting('qorpera_test.ms_used0')::timestamptz + interval '59 minutes'
			and current_setting('qorpera_test.ms_used2') = current_setting('qorpera_test.ms_used1'),
		'1: the last use: ' || concat_ws(' / ', current_setting('qorpera_test.ms_used0'), current_setting('qorpera_test.ms_used1'),
			current_setting('qorpera_test.ms_used2')));
end $$;

-- After 30 seconds a look moves it again.
select set_config('session_replication_role', 'replica', true);
update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '31 seconds'
where id = '11980000-0000-4000-8000-0000000007a1';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.ms_used3', pg_temp.ms_used()::text, true);
select pg_temp.ms_auth(null, null) like 'ok:%';
do $$
begin
	perform pg_temp.base_assert(pg_temp.ms_used() > current_setting('qorpera_test.ms_used3')::timestamptz + interval '30 seconds',
		'1: a look after 30 seconds moves the last use: ' || pg_temp.ms_used()::text);
end $$;

-- 2. Looks refused -------------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.ms_2x', pg_temp.ms_differ(jsonb_build_array(
	jsonb_build_array('another company''s machine', pg_temp.ms_auth(null, null, '11980000-0000-4000-8000-0000000007a3'),
		'42501:Machine screen authority is unavailable'),
	jsonb_build_array('a machine that is not', pg_temp.ms_auth(null, null, '11980000-0000-4000-8000-0000000007ff'),
		'42501:Machine screen authority is unavailable'),
	jsonb_build_array('a removed machine', pg_temp.ms_auth(null, null, '11980000-0000-4000-8000-0000000007a4'),
		'42501:Machine screen authority is unavailable'),
	jsonb_build_array('a stopped machine', pg_temp.ms_auth(null, null, '11980000-0000-4000-8000-0000000007a2'),
		'ok:' || jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', 'm-1198-asleep')::text),
	jsonb_build_array('scope: another key', pg_temp.ms_auth(null, null, null,
		'{"machineId": "11980000-0000-4000-8000-0000000007a1", "boot": "x"}'), '22023:Machine screen request is malformed'),
	jsonb_build_array('scope: no uuid', pg_temp.ms_auth(null, null, null, '{"machineId": "m-1198"}'),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('scope: an array', pg_temp.ms_auth(null, null, null, '[]'), '22023:Machine screen request is malformed'),
	jsonb_build_array('a receipt without an envelope', pg_temp.ms_auth('99', null), '22023:Machine screen request is malformed'),
	jsonb_build_array('an envelope without a receipt', pg_temp.ms_auth(null, pg_temp.ms_envelope('ms-2')),
		'22023:Machine screen request is malformed')
)), true);
-- Outside the service role nothing is read.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.ms_2a', pg_temp.ms_try(format('select public.qorpera_authorize_machine_screen(%L::jsonb, %L::jsonb, null, null)',
	current_setting('qorpera_test.base_binding'), '{"machineId": "11980000-0000-4000-8000-0000000007a1"}')), true);
select pg_temp.base_claims('service_role');

-- A run outside a company conversation: refused (42501), by the run check or by the machines' own rule.
savepoint ms_private;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_execution_runs set audience_kind = 'member_private', audience_user_id = requested_by_user_id
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
update public.qorpera_shared_sessions set audience_kind = 'member_private', audience_user_id = '92400000-0000-4000-8000-000000000001'
where id = (select session_id from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.ms_2p', pg_temp.ms_auth(null, null), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_2p') like '42501:%',
		'2: a run outside a company conversation: ' || current_setting('qorpera_test.ms_2p'));
end $$;
rollback to savepoint ms_private;

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_2x') = '',
		E'2: looks that differ:\n' || current_setting('qorpera_test.ms_2x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_2a') = '22023:Machine screen request is malformed',
		'2: outside the service role: ' || current_setting('qorpera_test.ms_2a'));
end $$;

-- 3. Actions -------------------------------------------------------------------------------------------------------------------

-- A click (defaults), an open (its own settle time) and a typed text with a settle time and no look, each begun, read and
-- completed in turn: a run has one executing receipt at a time.
select set_config('qorpera_test.ms_env31', pg_temp.ms_envelope('ms-31'), true);
select pg_temp.ms_begin('31', current_setting('qorpera_test.ms_env31'));
select set_config('qorpera_test.ms_act31', pg_temp.ms_auth('31', current_setting('qorpera_test.ms_env31')), true);
select pg_temp.ms_end('31', current_setting('qorpera_test.ms_env31'));
select set_config('qorpera_test.ms_env32', pg_temp.ms_envelope('ms-32',
	'{"action": {"type": "open", "target": "https://example.test/sign-in?next=%2F"}}'), true);
select pg_temp.ms_begin('32', current_setting('qorpera_test.ms_env32'));
select set_config('qorpera_test.ms_act32', pg_temp.ms_auth('32', current_setting('qorpera_test.ms_env32')), true);
select pg_temp.ms_end('32', current_setting('qorpera_test.ms_env32'));
select set_config('qorpera_test.ms_env33', pg_temp.ms_envelope('ms-33',
	'{"action": {"type": "type", "text": "Ærø\nline two"}, "settleMs": 0, "look": false}'), true);
select pg_temp.ms_begin('33', current_setting('qorpera_test.ms_env33'));
select set_config('qorpera_test.ms_act33', pg_temp.ms_auth('33', current_setting('qorpera_test.ms_env33')), true);
-- The same receipt read again (the executor's peer reads it again) answers the same.
select set_config('qorpera_test.ms_act33b', pg_temp.ms_auth('33', current_setting('qorpera_test.ms_env33')), true);
select pg_temp.ms_end('33', current_setting('qorpera_test.ms_env33'));
-- A move and a scroll take no intent.
select set_config('qorpera_test.ms_env34', pg_temp.ms_envelope('ms-34',
	'{"action": {"type": "scroll", "direction": "down", "steps": 5, "x": 800, "y": 500}, "intent": null}'), true);
select pg_temp.ms_begin('34', current_setting('qorpera_test.ms_env34'));
select set_config('qorpera_test.ms_act34', pg_temp.ms_auth('34', current_setting('qorpera_test.ms_env34')), true);
select pg_temp.ms_end('34', current_setting('qorpera_test.ms_env34'));

do $$
begin
	perform pg_temp.base_assert(pg_temp.ms_answer(current_setting('qorpera_test.ms_act31')) = pg_temp.ms_where(jsonb_build_object(
			'receiptId', '11980000-0000-4000-8000-000000000131', 'action', '{"type": "click", "x": 812, "y": 443}'::jsonb,
			'settleMs', 500, 'look', true)),
		'3: a click: ' || current_setting('qorpera_test.ms_act31'));
	perform pg_temp.base_assert(pg_temp.ms_answer(current_setting('qorpera_test.ms_act32')) = pg_temp.ms_where(jsonb_build_object(
			'receiptId', '11980000-0000-4000-8000-000000000132',
			'action', '{"type": "open", "target": "https://example.test/sign-in?next=%2F"}'::jsonb, 'settleMs', 2500, 'look', true)),
		'3: an open: ' || current_setting('qorpera_test.ms_act32'));
	perform pg_temp.base_assert(pg_temp.ms_answer(current_setting('qorpera_test.ms_act33')) = pg_temp.ms_where(jsonb_build_object(
			'receiptId', '11980000-0000-4000-8000-000000000133',
			'action', jsonb_build_object('type', 'type', 'text', E'Ærø\nline two'), 'settleMs', 0, 'look', false))
			and current_setting('qorpera_test.ms_act33b') = current_setting('qorpera_test.ms_act33'),
		'3: typed text: ' || current_setting('qorpera_test.ms_act33') || ' / ' || current_setting('qorpera_test.ms_act33b'));
	perform pg_temp.base_assert(pg_temp.ms_answer(current_setting('qorpera_test.ms_act34')) #> '{action}'
			= '{"type": "scroll", "direction": "down", "steps": 5, "x": 800, "y": 500}'::jsonb,
		'3: a scroll without an intent: ' || current_setting('qorpera_test.ms_act34'));
end $$;

-- 4. Actions refused -----------------------------------------------------------------------------------------------------------

select set_config('qorpera_test.ms_env41', pg_temp.ms_envelope('ms-41'), true);
select pg_temp.ms_begin('41', current_setting('qorpera_test.ms_env41'));
-- The call with one field set.
create function pg_temp.ms_env41(p_path text[], p_value jsonb) returns text language sql as $$
	select jsonb_set(current_setting('qorpera_test.ms_env41')::jsonb, p_path, p_value)::text
$$;
select set_config('qorpera_test.ms_4x', pg_temp.ms_differ(jsonb_build_array(
	jsonb_build_array('the call', pg_temp.ms_auth('41', current_setting('qorpera_test.ms_env41')),
		'ok:' || pg_temp.ms_where(jsonb_build_object('receiptId', '11980000-0000-4000-8000-000000000141',
			'action', '{"type": "click", "x": 812, "y": 443}'::jsonb, 'settleMs', 500, 'look', true))::text),
	jsonb_build_array('receipt: never begun', pg_temp.ms_auth('49', current_setting('qorpera_test.ms_env41')),
		'42501:Machine screen receipt is unavailable'),
	jsonb_build_array('receipt: another call''s (completed)', pg_temp.ms_auth('31', current_setting('qorpera_test.ms_env41')),
		'42501:Machine screen receipt is unavailable'),
	jsonb_build_array('receipt: its own call, completed', pg_temp.ms_auth('31', current_setting('qorpera_test.ms_env31')),
		'42501:Machine screen receipt is unavailable'),
	jsonb_build_array('receipt: the digest of another call', pg_temp.ms_auth('41',
		pg_temp.ms_env41('{operation,arguments,action,x}', '813')), '42501:Machine screen receipt is unavailable'),
	jsonb_build_array('call: not json', pg_temp.ms_auth('41', 'not json'), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: machine_run', pg_temp.ms_auth('41', pg_temp.ms_env41('{operation,tool}', '"machine_run"')),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('call: another version', pg_temp.ms_auth('41',
		pg_temp.ms_env41('{operation,toolVersion}', '"qorpera.machine-tools/v2"')), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: another schema', pg_temp.ms_auth('41',
		pg_temp.ms_env41('{schema}', '"qorpera.cloud-tool-operation/v1"')), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: another key', pg_temp.ms_auth('41',
		pg_temp.ms_env41('{operation,arguments,operationKey}', '"ms-4x"')), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: another machine than the scope''s', pg_temp.ms_auth('41', current_setting('qorpera_test.ms_env41'),
		'11980000-0000-4000-8000-0000000007a2'), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: a computer''s realm', pg_temp.ms_auth('41',
		pg_temp.ms_env41('{operation,target,realm}', '"company_computer"')), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: no action', pg_temp.ms_auth('41', (current_setting('qorpera_test.ms_env41')::jsonb
		#- '{operation,arguments,action}')::text), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: a click without an intent', pg_temp.ms_auth('41', (current_setting('qorpera_test.ms_env41')::jsonb
		#- '{operation,arguments,intent}')::text), '22023:Machine screen request is malformed'),
	jsonb_build_array('call: a window', pg_temp.ms_auth('41', pg_temp.ms_env41('{operation,arguments,window}', '"Inbox"')),
		'22023:Machine screen request is malformed'),
	jsonb_build_array('call: off the screen', pg_temp.ms_auth('41', pg_temp.ms_env41('{operation,arguments,action,x}', '3840')),
		'22023:Machine screen request is malformed')
)), true);
select pg_temp.ms_end('41', current_setting('qorpera_test.ms_env41'));
-- The same call under another tool's receipt key; another company's machine of the same name; the company's stopped
-- machine; a machine of another name than the call's: each with its own receipt, refused, then completed.
create function pg_temp.ms_refused(p_n text, p_envelope text, p_tool text, p_machine text, p_expected text)
returns text language plpgsql as $$
declare v_found text;
begin
	perform pg_temp.ms_begin(p_n, p_envelope, p_tool);
	v_found := pg_temp.ms_differ(jsonb_build_array(jsonb_build_array('action ' || p_n,
		pg_temp.ms_auth(p_n, p_envelope, p_machine), p_expected)));
	perform pg_temp.ms_end(p_n, p_envelope);
	return v_found;
end $$;
select set_config('qorpera_test.ms_4y', concat(
	pg_temp.ms_refused('42', pg_temp.ms_envelope('ms-42'), 'machine_run', '11980000-0000-4000-8000-0000000007a1',
		'42501:Machine screen receipt is unavailable'),
	pg_temp.ms_refused('43', pg_temp.ms_envelope('ms-43', '{}', '{}', '{"machineId": "11980000-0000-4000-8000-0000000007a3"}'),
		'machine_screen', '11980000-0000-4000-8000-0000000007a3', '42501:Machine screen authority is unavailable'),
	pg_temp.ms_refused('44', pg_temp.ms_envelope('ms-44', '{"machine": "m-1198-asleep"}', '{}',
		'{"machineId": "11980000-0000-4000-8000-0000000007a2"}'), 'machine_screen', '11980000-0000-4000-8000-0000000007a2',
		'ok:' || jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', 'm-1198-asleep')::text),
	pg_temp.ms_refused('45', pg_temp.ms_envelope('ms-45', '{"machine": "m-1198-asleep"}'), 'machine_screen',
		'11980000-0000-4000-8000-0000000007a1', '42501:Machine screen authority is unavailable')), true);

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_4x') = '',
		E'4: actions that differ:\n' || current_setting('qorpera_test.ms_4x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_4y') = '',
		E'4: other calls that differ:\n' || current_setting('qorpera_test.ms_4y'));
end $$;

-- 5. A paused company: its run's own check refuses every tool, so a look too ----------------------------------------------------

savepoint ms_paused;
select set_config('qorpera_test.ms_env51', pg_temp.ms_envelope('ms-51'), true);
select pg_temp.ms_begin('51', current_setting('qorpera_test.ms_env51'));
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'Stop for now.');
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.ms_act51', pg_temp.ms_auth('51', current_setting('qorpera_test.ms_env51')), true);
select set_config('qorpera_test.ms_look51', pg_temp.ms_auth(null, null), true);
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_act51') = '55000:Company execution is paused',
		'5: a paused company''s action: ' || current_setting('qorpera_test.ms_act51'));
	perform pg_temp.base_assert(current_setting('qorpera_test.ms_look51') = '55000:Company execution is paused',
		'5: a paused company''s look: ' || current_setting('qorpera_test.ms_look51'));
end $$;
rollback to savepoint ms_paused;

-- 6. The call check -----------------------------------------------------------------------------------------------------------

do $$
declare
	v_call jsonb := jsonb_build_object('operationKey', 'k-1', 'machine', 'm-1198',
		'action', jsonb_build_object('type', 'click', 'x', 0, 'y', 2159, 'button', 'right'), 'intent', 'Open the menu.');
	v_valid jsonb := jsonb_build_array(
		v_call,
		v_call || '{"settleMs": 5000, "look": false}',
		v_call || '{"action": {"type": "double", "x": 3839, "y": 0}}',
		(v_call || '{"action": {"type": "move", "x": 10, "y": 10}}') - 'intent',
		v_call || '{"action": {"type": "drag", "x": 1, "y": 2, "toX": 3, "toY": 4}}',
		v_call || '{"action": {"type": "type", "text": "hello\tworld\n"}}',
		v_call || '{"action": {"type": "key", "keys": ["ctrl+l", "Return", "F5", "shift+Insert"]}}',
		(v_call || '{"action": {"type": "scroll", "direction": "up"}}') - 'intent',
		v_call || '{"action": {"type": "scroll", "direction": "down", "steps": 30, "x": 5, "y": 6}}',
		v_call || '{"action": {"type": "open", "target": "file:///home/desktop/a%20b.pdf"}}',
		v_call || '{"action": {"type": "open", "target": "/company/site/index.html"}}',
		v_call || '{"action": {"type": "open", "target": "/home/desktop/Mit dokument.pdf"}}');
	v_invalid jsonb := jsonb_build_array(
		'[]'::jsonb,
		v_call - 'operationKey',
		v_call - 'machine',
		v_call - 'action',
		v_call - 'intent',
		v_call || '{"window": "Inbox"}',
		v_call || '{"machine": "M-1198"}',
		v_call || '{"operationKey": ""}',
		v_call || '{"settleMs": 5001}',
		v_call || '{"settleMs": 1.5}',
		v_call || '{"settleMs": "500"}',
		v_call || '{"look": "yes"}',
		v_call || '{"intent": " padded"}',
		v_call || '{"intent": ""}',
		v_call || jsonb_build_object('intent', repeat('i', 201)),
		v_call || jsonb_build_object('intent', E'a\tb'),
		v_call || '{"action": {"type": "click", "x": 3840, "y": 0}}',
		v_call || '{"action": {"type": "click", "x": 0, "y": 2160}}',
		v_call || '{"action": {"type": "click", "x": -1, "y": 0}}',
		v_call || '{"action": {"type": "click", "x": 1.5, "y": 0}}',
		v_call || '{"action": {"type": "click", "x": "1", "y": 0}}',
		v_call || '{"action": {"type": "click", "x": 1}}',
		v_call || '{"action": {"type": "click", "x": 1, "y": 1, "button": "back"}}',
		v_call || '{"action": {"type": "click", "x": 1, "y": 1, "text": "a"}}',
		v_call || '{"action": {"type": "double", "x": 1, "y": 1, "button": "left"}}',
		v_call || '{"action": {"type": "drag", "x": 1, "y": 2, "toX": 3}}',
		v_call || '{"action": {"type": "type", "text": ""}}',
		v_call || jsonb_build_object('action', jsonb_build_object('type', 'type', 'text', repeat('a', 501))),
		v_call || jsonb_build_object('action', jsonb_build_object('type', 'type', 'text', E'a\u0007b')),
		v_call || '{"action": {"type": "key", "keys": []}}',
		v_call || '{"action": {"type": "key", "keys": "Return"}}',
		v_call || '{"action": {"type": "key", "keys": ["-x"]}}',
		v_call || '{"action": {"type": "key", "keys": ["ctrl l"]}}',
		-- `xdotool key` runs a command word that follows its keys: exec runs a program (review r1 F2), in any case.
		v_call || '{"action": {"type": "key", "keys": ["exec", "id"]}}',
		v_call || '{"action": {"type": "key", "keys": ["EXEC", "id"]}}',
		v_call || '{"action": {"type": "key", "keys": ["Return", "Sleep", "1"]}}',
		v_call || '{"action": {"type": "key", "keys": ["windowKill"]}}',
		v_call || '{"action": {"type": "key", "keys": ["type"]}}',
		v_call || '{"action": {"type": "key", "keys": ["a","a","a","a","a","a","a","a","a","a","a","a","a","a","a","a","a"]}}',
		v_call || '{"action": {"type": "scroll", "direction": "left"}}',
		v_call || '{"action": {"type": "scroll", "direction": "up", "steps": 0}}',
		v_call || '{"action": {"type": "scroll", "direction": "up", "steps": 31}}',
		v_call || '{"action": {"type": "scroll", "direction": "up", "x": 4}}',
		v_call || '{"action": {"type": "open", "target": "-x"}}',
		v_call || '{"action": {"type": "open", "target": "javascript:alert(1)"}}',
		v_call || '{"action": {"type": "open", "target": "https://example.test/a b"}}',
		v_call || '{"action": {"type": "open", "target": "relative/path"}}',
		v_call || jsonb_build_object('action', jsonb_build_object('type', 'open', 'target', '/' || repeat('a', 2000))),
		v_call || '{"action": {"type": "fly", "x": 1, "y": 1}}',
		v_call || '{"action": {"x": 1, "y": 1}}',
		v_call || '{"action": "click"}');
	v_case jsonb;
begin
	for v_case in select value from jsonb_array_elements(v_valid) loop
		perform pg_temp.base_assert(public.qorpera_valid_machine_screen_call(v_case), '6: valid: ' || v_case::text);
	end loop;
	for v_case in select value from jsonb_array_elements(v_invalid) loop
		perform pg_temp.base_assert(not public.qorpera_valid_machine_screen_call(v_case), '6: invalid: ' || v_case::text);
	end loop;
end $$;

-- 7. Grants, the observations' list and the marker ----------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)', 'execute') = (v_role = 'service_role')
				and not has_function_privilege(v_role, 'public.qorpera_valid_machine_screen_call(jsonb)', 'execute'),
			format('7: the grants for %s', v_role));
	end loop;
end $$;


-- 8. The disk's company folder access (review r1 F1) -----------------------------------------------------------------------

-- Whether the run's agent and member read the folder's root now; m-1198's disk's mark; the platform's open of a view
-- on m-1198's current placement and boot (as the machine executor asks it); and the run's agent's path grants revoked
-- (its block undoes it).
create function pg_temp.ms_reads_root() returns boolean language sql as $$
	select public.qorpera_folder_reads_root(run.environment_id, run.profile_id, run.staff_agent_id, run.requested_by_user_id)
	from public.qorpera_execution_runs as run where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.ms_unchecked() returns timestamptz language sql as $$
	select folder_unchecked_at from public.qorpera_company_machine_placements where id = '11980000-0000-4000-8000-0000000007b1'
$$;
create function pg_temp.ms_open() returns jsonb language sql as $$
	select public.qorpera_folder_view_open('92400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'test_machine',
		'{"companyMachineId": "11980000-0000-4000-8000-0000000007a1", "placementId": "11980000-0000-4000-8000-0000000007b1",
			"bootId": "11980000-0000-4000-8000-0000000007c1"}')
$$;
create function pg_temp.ms_revoke_agent() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
	where principal_kind = 'staff_agent' and revoked_at is null and principal_id = (select run.staff_agent_id
		from public.qorpera_execution_runs as run where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
	set local session_replication_role = origin;
end $$;
-- One action's authorization under receipt n, begun and completed around it.
create function pg_temp.ms_act(p_n text) returns text language plpgsql as $$
declare v_envelope text := pg_temp.ms_envelope('ms-' || p_n); v text;
begin
	perform pg_temp.ms_begin(p_n, v_envelope);
	v := pg_temp.ms_auth(p_n, v_envelope);
	perform pg_temp.ms_end(p_n, v_envelope);
	return v;
end $$;

-- 8.1 m-1198's disk never had a view, and the root reader's actions above left it unmarked. A caller without the root
--     read (Alice's agent, its grants revoked; undone after) still looks and acts there; its look marks nothing, its
--     action marks the disk, and the platform's open then refuses it.
do $$
declare v_look text; v_act text;
begin
	perform pg_temp.base_assert(pg_temp.ms_reads_root() and pg_temp.ms_unchecked() is null
		and not exists (select 1 from public.qorpera_folder_views where placement_id = '11980000-0000-4000-8000-0000000007b1'),
		'8: Alice and her member read the root, her actions left the disk unmarked, and it never had a view');
	begin
		perform pg_temp.ms_revoke_agent();
		perform pg_temp.base_assert(not pg_temp.ms_reads_root(), '8: without its grants the agent does not read the root');
		v_look := pg_temp.ms_auth(null, null);
		perform pg_temp.base_assert(pg_temp.ms_answer(v_look) ->> 'state' = 'authorized' and pg_temp.ms_unchecked() is null,
			'8: a look without the root on a viewless disk is served and marks nothing: ' || v_look);
		v_act := pg_temp.ms_act('81');
		perform pg_temp.base_assert(pg_temp.ms_answer(v_act) ->> 'state' = 'authorized' and pg_temp.ms_unchecked() is not null,
			'8: an action without the root on a viewless disk is served and marks it: ' || v_act);
		perform pg_temp.base_claims('service_role');
		perform pg_temp.base_error('select pg_temp.ms_open()', '42501', 'Test machine disk was used without the folder check');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(pg_temp.ms_reads_root() and pg_temp.ms_unchecked() is null, '8: undone');
end $$;

-- 8.2 The platform opens a view on the clean disk. A root reader still looks and acts there, and the disk stays
--     unmarked. A caller whose agent does not read the root (its grants revoked; undone after) is refused a look and an
--     action alike, as an answer the agent hears that carries nothing of the machine. The member's side is the same
--     check with the run's requester (as machine commands make it), but cannot fail while the run stands: the folder's
--     root is always company_shared (a constraint), which every member reads, and a run's requester must be a member.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.ms_view', pg_temp.ms_open()::text, true);
do $$
declare v_case text; v_look text; v_act text;
	v_refused constant jsonb := jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
		'reason', 'MACHINE_NEEDS_COMPANY_VIEW', 'machine', 'm-1198');
begin
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views
			where id = (current_setting('qorpera_test.ms_view')::jsonb ->> 'viewId')::uuid and kind = 'test_machine'
				and placement_id = '11980000-0000-4000-8000-0000000007b1'),
		'8: the view is open on m-1198''s disk: ' || current_setting('qorpera_test.ms_view'));
	v_look := pg_temp.ms_auth(null, null);
	v_act := pg_temp.ms_act('82');
	perform pg_temp.base_assert(pg_temp.ms_answer(v_look) ->> 'state' = 'authorized'
			and pg_temp.ms_answer(v_act) ->> 'state' = 'authorized' and pg_temp.ms_unchecked() is null,
		'8: with the root, a disk that has a view is seen and driven: ' || v_look || ' / ' || v_act);
	foreach v_case in array array['agent'] loop
		begin
			perform pg_temp.ms_revoke_agent();
			perform pg_temp.base_assert(not pg_temp.ms_reads_root(), '8: ' || v_case || ' does not read the root');
			v_look := pg_temp.ms_auth(null, null);
			v_act := pg_temp.ms_act('83');
			perform pg_temp.base_assert(v_look = 'ok:' || v_refused::text and v_act = 'ok:' || v_refused::text
					and pg_temp.ms_unchecked() is null,
				'8: without the ' || v_case || '''s root read, no look and no action: ' || v_look || ' / ' || v_act);
			raise exception 'Undo' using errcode = 'QTF80';
		exception when sqlstate 'QTF80' then null;
		end;
	end loop;
	perform pg_temp.base_assert(pg_temp.ms_reads_root(), '8: undone');
end $$;

rollback;
