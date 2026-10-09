-- @fixture 627_runtime_company_computer_seats.test.sql until "select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2))='setup','no host offers computer 2 yet');"
-- Computer hours, build step 6b part 2 (20260928309720), on a folder-v2 company (ported from snapshot-v1 in the legacy
-- sweep): a started computer that no host has taken yet waits for computer hours while the company is at zero. The
-- agent's panel says so, operators see it in the setup queue, it is never counted as stuck, and the fleet does not try
-- to place it. Switched off, or once hours are added (before the next sweep), it waits for its host as before. 627's
-- fixture on 924's folder-v2 company: computer 2 was added for Carol and its start requested, with no host yet.

reset role;
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2)) = 'setup', 'Switched off: it waits for its host');
-- The fleet returns at zero before it locks or tries any node (the behaviour is checked at zero below).
select pg_temp.base_assert(position('if public.qorpera_company_at_zero(o.profile_id,clock_timestamp()) then' in d)
		between 1 and position(' -- Deterministic node locks serialize' in d),
	'The fleet places nothing at zero, before any node lock')
from pg_get_functiondef('public.qorpera_place_runtime_office_fleet(jsonb,bigint)'::regprocedure) d;

-- The company uses more than its free hours, live, with the zero rule on; the sweep records it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');

select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2)) = 'hours', 'At zero it waits for hours');

-- The fleet places it nowhere at zero, though a node has room and has offered it, and reserves nothing; once hours are
-- added it is placed (from the office fleet cases, in the legacy sweep). The node, its measured inventory and the
-- offer's digests are synthetic; the calls are real.
savepoint hz_fleet;
select set_config('qorpera_test.hz_scope', pg_temp.cs_scope(2)::text, true);
select set_config('qorpera_test.hz_intent', (select id::text from public.qorpera_runtime_office_start_intents
	where office_id = (pg_temp.cs_office(2)).id), true);
select pg_temp.base_claims('service_role');
select public.qorpera_configure_runtime_node(jsonb_build_object('schema', 'qorpera.runtime-node-policy/v1',
	'nodeId', '73500000-0000-4000-8000-000000000010', 'machineIdSha256', repeat('c', 64), 'label', 'hours', 'cpuMillis', 6000,
	'memoryBytes', 8589934592, 'headroomCpuMillis', 2000, 'headroomMemoryBytes', 1073741824, 'standardCpuMillis', 2000,
	'standardMemoryBytes', 2147483648, 'enabled', true), 0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('73500000-0000-4000-8000-000000000010', repeat('c', 64), 'office',
	'73500000-0000-4000-8000-000000000011', repeat('f', 64), 2000, 2147483648) \g /dev/null
select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema', 'qorpera.runtime-node-inventory-policy/v1',
	'nodeId', '73500000-0000-4000-8000-000000000010', 'host', jsonb_build_object('machineIdSha256', repeat('c', 64),
	'socketPath', '/var/snap/lxd/common/lxd/unix.socket', 'socketGid', 0, 'certificateSha256', repeat('e', 64), 'serverName', 'lxd',
	'serverVersion', '5.21', 'architecture', 'x86_64'), 'operatingCpuMillis', 500, 'operatingMemoryBytes', 536870912,
	'infrastructure', '[]'::jsonb)) \g /dev/null
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema', 'qorpera.runtime-node-observation/v1',
	'nodeId', '73500000-0000-4000-8000-000000000010', 'machineIdSha256', repeat('c', 64), 'observationId', extensions.gen_random_uuid(),
	'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'cpuMillis', 6000,
	'memoryBytes', 8589934592, 'state', 'ready'),
	public.qorpera_runtime_node_inventory_context('73500000-0000-4000-8000-000000000010') ->> 'contextSha256',
	jsonb_build_object('schema', 'qorpera.runtime-node-inventory/v1', 'bootId', extensions.gen_random_uuid(), 'entries', '[]'::jsonb)) \g /dev/null
set local role service_role;
select public.qorpera_offer_runtime_office_fleet(jsonb_build_object('schema', 'qorpera.office-fleet-offer/v1',
	'scope', current_setting('qorpera_test.hz_scope')::jsonb, 'computerGeneration', 1, 'intentId', current_setting('qorpera_test.hz_intent'),
	'providerId', '73500000-0000-4000-8000-000000000011', 'nodeId', '73500000-0000-4000-8000-000000000010', 'policySha256', repeat('f', 64),
	'machineIdSha256', repeat('c', 64), 'allocationId', '73500000-0000-4000-8000-000000000012', 'instanceSha256', repeat('1', 64),
	'providerBindingSha256', repeat('2', 64), 'imageSha256', repeat('a', 64), 'bootstrapSha256', repeat('b', 64), 'cpuMillis', 2000,
	'memoryBytes', 2147483648, 'serviceConfigSha256', repeat('3', 64))) \g /dev/null
select set_config('qorpera_test.hz_place', public.qorpera_place_runtime_office_fleet(current_setting('qorpera_test.hz_scope')::jsonb, 1)::text, true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.hz_place')::jsonb ->> 'state' = 'unplaced'
	and not exists(select 1 from public.qorpera_runtime_office_providers where office_id = (pg_temp.cs_office(2)).id)
	and not exists(select 1 from public.qorpera_runtime_machine_allocations where office_id = (pg_temp.cs_office(2)).id)
	and not exists(select 1 from public.qorpera_runtime_node_demands where node_id = '73500000-0000-4000-8000-000000000010'),
	'At zero the fleet places and reserves nothing: ' || current_setting('qorpera_test.hz_place'));
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
set local role service_role;
select set_config('qorpera_test.hz_place', public.qorpera_place_runtime_office_fleet(current_setting('qorpera_test.hz_scope')::jsonb, 1)::text, true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.hz_place')::jsonb #>> '{offer,nodeId}' = '73500000-0000-4000-8000-000000000010',
	'With hours it is placed on the node: ' || current_setting('qorpera_test.hz_place'));
rollback to hz_fleet;
select set_config('qorpera_test.hz_panel', pg_temp.cs_agent_office('92400000-0000-4000-8000-000000000032')::text, true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.hz_panel')::jsonb #>> '{computer,waiting}' = 'hours'
	and current_setting('qorpera_test.hz_panel')::jsonb #>> '{computer,number}' = '2',
	'Carol''s panel says computer 2 waits for hours: ' || current_setting('qorpera_test.hz_panel'));
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(1)) is null, 'A running computer waits for nothing');

select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.hz_queue', public.qorpera_runtime_office_setup_queue()::text, true);
reset role;
select pg_temp.base_assert(exists(select 1 from jsonb_array_elements(current_setting('qorpera_test.hz_queue')::jsonb) q
	where q ->> 'companyComputerId' = (pg_temp.cs_office(2)).id::text and q ->> 'waiting' = 'hours'),
	'Operators see it waiting for hours: ' || current_setting('qorpera_test.hz_queue'));

-- Waiting for hours is not stuck, however long it takes.
select set_config('session_replication_role', 'replica', true);
update public.qorpera_runtime_office_start_intents set created_at = clock_timestamp() - interval '31 minutes'
where office_id = (pg_temp.cs_office(2)).id;
select set_config('session_replication_role', 'origin', true);
select pg_temp.base_assert(not public.qorpera_runtime_office_start_stuck(pg_temp.cs_office(2)), 'Waiting for hours is not stuck');

-- Hours are added: it waits for its host again, and after 30 minutes that counts as stuck, as before.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2)) = 'setup', 'Hours added: it waits for its host');
select pg_temp.base_assert(public.qorpera_runtime_office_start_stuck(pg_temp.cs_office(2)), 'and is stuck after 30 minutes, as before');
rollback;
