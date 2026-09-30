-- @fixture 640_runtime_node_serving_switch.test.sql until "select pg_temp.wake_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved','A coding machine is reserved on node C');"
-- Computer hours, build step 6b part 1 (20260929700000_runtime_computer_hours_node_refusal): at zero
-- no Company Computer, coding machine or agent's machine starts or wakes. The node reserve refuses a
-- new reservation or a wake with COMPUTER_HOURS_EXHAUSTED and keeps it on the demand; a machine
-- already awake passes; an emptying node says NODE_DISABLED first; run and sign-in machines are never
-- refused here. Switched off, or once hours are added, machines start as before.

reset role;
select pg_temp.wake_assert((select allocation.profile_id from public.qorpera_runtime_machine_allocations allocation
	where allocation.id = '64000000-0000-4000-8000-000000000401') = '30000000-0000-4000-8000-000000000010',
	'The coding machines are the fixture company''s');
select pg_temp.wake_assert(position($$elsif p_provider_kind in ('office','coding','machine') and (v_demand.reserved_at is null or v_demand.suspended_at is not null)$$
		in pg_get_functiondef('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0,
	'Only Company Computers, coding machines and agents'' machines are refused, and only a new reservation or a wake');

-- 1. Switched off: a coding machine is reserved as before.
set local role service_role;
select pg_temp.wake_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved', 'Switched off: reserved');
reset role;

-- The company uses more than its free hours, live, with the zero rule on; the sweep records it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');

-- 2. A machine already awake keeps its reservation: running work finishes its hour.
set local role service_role;
select pg_temp.wake_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved', 'A machine already awake passes');
-- 3. No new machine starts.
select pg_temp.wake_assert(pg_temp.sw_reserve(2) ->> 'reason' = 'COMPUTER_HOURS_EXHAUSTED',
	'No new machine at zero: ' || pg_temp.sw_reserve(2)::text);
reset role;
select pg_temp.wake_assert((select last_refusal = 'COMPUTER_HOURS_EXHAUSTED' and reserved_at is null
	from public.qorpera_runtime_node_demands where allocation_id = '64000000-0000-4000-8000-000000000402'),
	'The refusal is kept on the demand');
-- 4. A sleeping machine does not wake.
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
where allocation_id = '64000000-0000-4000-8000-000000000401';
set local role service_role;
select pg_temp.wake_assert(pg_temp.sw_reserve(1) ->> 'reason' = 'COMPUTER_HOURS_EXHAUSTED', 'A sleeping machine does not wake at zero');
reset role;
select pg_temp.wake_assert((select suspended_at is not null and reserved_at is not null
	from public.qorpera_runtime_node_demands where allocation_id = '64000000-0000-4000-8000-000000000401'),
	'It stays asleep, with its disk');
-- 5. An emptying node says so first.
set local role service_role;
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000003', false, 1, 'restart the host');
select pg_temp.wake_assert(pg_temp.sw_reserve(2) ->> 'reason' = 'NODE_DISABLED', 'NODE_DISABLED wins');
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000003', true, 1, 'serving again');
reset role;

-- 6. Hours are added: a new machine starts and a sleeping one wakes, before the next sweep.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
set local role service_role;
select pg_temp.sw_observe();
select pg_temp.wake_assert(pg_temp.sw_reserve(2) ->> 'state' = 'reserved', 'Hours added: a new machine starts');
select pg_temp.wake_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved', 'Hours added: a sleeping machine wakes');
reset role;
select pg_temp.wake_assert((select suspended_at is null from public.qorpera_runtime_node_demands
	where allocation_id = '64000000-0000-4000-8000-000000000401'), 'Awake again');
rollback;
