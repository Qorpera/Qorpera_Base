-- @fixture 627_runtime_company_computer_seats.test.sql until "select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(2))='setup','no host offers computer 2 yet');"
-- Computer hours, build step 6b part 2 (20260929720000): a started computer that no host has taken
-- yet waits for computer hours while the company is at zero. The agent's panel says so, operators
-- see it in the setup queue, it is never counted as stuck, and the fleet does not try to place it.
-- Switched off, or once hours are added (before the next sweep), it waits for its host as before.

reset role;
select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(2)) = 'setup', 'Switched off: it waits for its host');
-- The fleet returns at zero before it locks or tries any node (behaviour: fixtures/runtime-office-fleet-cases.sql).
select pg_temp.wake_assert(position('if public.qorpera_company_at_zero(o.profile_id,clock_timestamp()) then' in d)
		between 1 and position(' -- Deterministic node locks serialize' in d),
	'The fleet places nothing at zero, before any node lock')
from pg_get_functiondef('public.qorpera_place_runtime_office_fleet(jsonb,bigint)'::regprocedure) d;

-- The company uses more than its free hours, live, with the zero rule on; the sweep records it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');

select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(2)) = 'hours', 'At zero it waits for hours');
select set_config('qorpera_test.hz_panel', pg_temp.agent_office('30000000-0000-4000-8000-000000000032')::text, true);
reset role;
select pg_temp.wake_assert(current_setting('qorpera_test.hz_panel')::jsonb #>> '{computer,waiting}' = 'hours'
	and current_setting('qorpera_test.hz_panel')::jsonb #>> '{computer,number}' = '2',
	'Carol''s panel says computer 2 waits for hours: ' || current_setting('qorpera_test.hz_panel'));
select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(1)) is null, 'A running computer waits for nothing');

select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.hz_queue', public.qorpera_runtime_office_setup_queue()::text, true);
reset role;
select pg_temp.wake_assert(exists(select 1 from jsonb_array_elements(current_setting('qorpera_test.hz_queue')::jsonb) q
	where q ->> 'companyComputerId' = (pg_temp.office(2)).id::text and q ->> 'waiting' = 'hours'),
	'Operators see it waiting for hours: ' || current_setting('qorpera_test.hz_queue'));

-- Waiting for hours is not stuck, however long it takes.
select set_config('session_replication_role', 'replica', true);
update public.qorpera_runtime_office_start_intents set created_at = clock_timestamp() - interval '31 minutes'
where office_id = (pg_temp.office(2)).id;
select set_config('session_replication_role', 'origin', true);
select pg_temp.wake_assert(not public.qorpera_runtime_office_start_stuck(pg_temp.office(2)), 'Waiting for hours is not stuck');

-- Hours are added: it waits for its host again, and after 30 minutes that counts as stuck, as before.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(2)) = 'setup', 'Hours added: it waits for its host');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_stuck(pg_temp.office(2)), 'and is stuck after 30 minutes, as before');
rollback;
