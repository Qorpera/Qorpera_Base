-- @fixture 718_company_delete_office_power_off.test.sql until "-- The company lives: its held screen keeps the computer awake, and so does a pause without any screen."
-- Computer hours, build step 6b part 2 (20260928309720): Company Computers at zero, on a folder-v2 company (ported from
-- snapshot-v1 in the legacy sweep).
--   * Within the hour after the company ran out, a held screen keeps its computer awake; once the
--     finishing window is over the computer powers off at once, held screen notwithstanding.
--   * A sleeping computer's wake is kept but not handed to the provider while the company is at
--     zero, and the computer says it waits for hours.
--   * Once hours are added the wake is handed over, before the next sweep, and it stays handed over
--     if the company runs out again (the provider may have begun the resume).
-- 718's fixture on 924's folder-v2 company: the office, its start and activation (as in the deleted
-- fixtures/runtime-office-idle-cases.sql), with Alice's live run holding a screen lease. The pause is the folder-v2
-- operator pause (qorpera_folder_pause, lifted by qorpera_folder_resume).

create function pg_temp.hz_office() returns public.qorpera_runtime_offices language sql as $$
	select o.* from public.qorpera_runtime_offices o
	where o.id = (current_setting('qorpera_test.office')::jsonb ->> 'companyComputerId')::uuid
$$;
create function pg_temp.hz_cycle() returns public.qorpera_runtime_office_idle_cycles language sql as $$
	select c.* from public.qorpera_runtime_office_idle_cycles c
	where c.office_id = (pg_temp.hz_office()).id and c.superseded_at is null
	order by c.requested_at desc limit 1
$$;

-- 1. Switched off: the held screen keeps the computer awake.
select pg_temp.base_assert(pg_temp.po_idle_poll() -> 'request' = 'null', 'Switched off: a held screen keeps it awake');

-- 2. The company uses more than its free hours, live, with the zero rule on; the sweep records it.
-- Within the hour the held screen still keeps the computer awake: running work may finish.
reset role;
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.po_idle_poll() -> 'request' = 'null', 'Within the hour a held screen keeps it awake');
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.hz_office()) is null, 'A running computer waits for nothing');

-- 3. The hour is over: the computer powers off at once, held screen and a pause notwithstanding.
reset role;
select public.qorpera_folder_pause('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'Operator pause');
update public.qorpera_computer_hour_zero_state set ran_out_at = ran_out_at - interval '61 minutes'
where profile_id = '92400000-0000-4000-8000-000000000010';
select pg_temp.base_claims('service_role');
do $$
declare v_first jsonb := pg_temp.po_idle_poll(); v_again jsonb;
begin
	perform pg_temp.base_assert(v_first #>> '{request,action}' = 'power_off'
		and v_first #>> '{request,activationId}' = '39000000-0000-4000-8000-000000000004'
		and not (v_first ->> 'wakeRequested')::boolean,
		'After the hour the computer is asked to power off, held screen and pause notwithstanding: ' || v_first::text);
	perform pg_temp.base_assert((pg_temp.hz_office()).state = 'maintenance', 'The computer is going down');
	v_again := pg_temp.po_idle_poll();
	perform pg_temp.base_assert(v_again -> 'request' = v_first -> 'request', 'The provider keeps getting the same power_off');
end
$$;

-- The pause is lifted: a paused company's computer takes no wake request at all.
reset role;
select public.qorpera_folder_resume('92400000-0000-4000-8000-000000000010');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_company_execution_pauses
	where profile_id = '92400000-0000-4000-8000-000000000010'), 'The company is no longer paused');

-- 4. A member asks for it at zero: the wake is kept, not handed to the provider, and the computer
-- says it waits for hours.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb, 1,
	'39000000-0000-4000-8000-0000000000a1');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert((pg_temp.hz_cycle()).wake_requested_at is not null, 'The wake is kept');
select pg_temp.base_assert(not (pg_temp.po_idle_poll() ->> 'wakeRequested')::boolean
	and pg_temp.po_idle_poll() -> 'request' <> 'null' and (pg_temp.hz_cycle()).wake_reported_at is null,
	'At zero it is not handed to the provider');
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.hz_office()) = 'hours', 'It waits for hours');

-- 5. Hours are added: the next check hands the wake over, before the next sweep.
reset role;
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.hz_office()) is null, 'Hours added: nothing to wait for');
select pg_temp.base_assert((pg_temp.po_idle_poll() ->> 'wakeRequested')::boolean, 'Hours added: the wake is handed over');
select pg_temp.base_assert((pg_temp.hz_cycle()).wake_reported_at is not null, 'and recorded as handed over');

-- 6. Out of hours again before the computer is up: a wake handed over stays handed over.
reset role;
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), 75000, 75000);
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(public.qorpera_company_at_zero('92400000-0000-4000-8000-000000000010', clock_timestamp()), 'At zero again');
select pg_temp.base_assert((pg_temp.po_idle_poll() ->> 'wakeRequested')::boolean, 'A wake handed over stays handed over');
rollback;
