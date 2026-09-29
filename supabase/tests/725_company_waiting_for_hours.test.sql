-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 6d part 2 (20260929280000_company_waiting_for_hours): any member reads
-- whether the company waits for computer hours; nobody else can.

insert into auth.users(id,email) values ('72500000-0000-4000-8000-000000000009','outsider@example.test');
create function pg_temp.waiting_as(p_user uuid) returns boolean language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_waiting boolean;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	execute 'set local role authenticated';
	v_waiting := public.qorpera_company_waiting_for_hours('30000000-0000-4000-8000-000000000010');
	execute 'reset role';
	perform set_config('request.jwt.claims', v_claims, true);
	return v_waiting;
end
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_company_waiting_for_hours(uuid)', 'EXECUTE'),
	'Not callable by ' || role_name)
from unnest(array['anon', 'service_role']) role_name;
select pg_temp.wake_assert(has_function_privilege('authenticated', 'public.qorpera_company_waiting_for_hours(uuid)', 'EXECUTE'),
	'Callable by signed-in members');
select pg_temp.wake_error($$select pg_temp.waiting_as('72500000-0000-4000-8000-000000000009')$$, '42501',
	'profile read access is required');

-- Switched off: nothing waits, however much is used.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
select pg_temp.wake_assert(not pg_temp.waiting_as('30000000-0000-4000-8000-000000000002'), 'Switched off: not waiting');

-- Switched on, at zero: every member, founder or not, sees it.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(pg_temp.waiting_as('30000000-0000-4000-8000-000000000002')
	and pg_temp.waiting_as('30000000-0000-4000-8000-000000000001'), 'At zero: waiting');

-- Hours arrive: no longer waiting.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(not pg_temp.waiting_as('30000000-0000-4000-8000-000000000002'), 'Hours arrived: not waiting');
rollback;
