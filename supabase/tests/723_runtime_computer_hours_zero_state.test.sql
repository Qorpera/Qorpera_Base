-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 6c part 1 (20260929250000_runtime_computer_hours_zero_state): the sweep
-- after each meter pass records when a company ran out and clears it once hours arrive; a company
-- that reaches zero without owing gets "out of hours" under its own occasion, held while it stays at
-- zero and dropped once hours arrive; no second "out of hours" while at zero; "running low" is
-- dropped at zero. Switched off, nothing is kept.

insert into auth.users(id,email) values ('72300000-0000-4000-8000-000000000002','zero-founder-2@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','72300000-0000-4000-8000-000000000002','zero-founder-2@example.test','Founder 2','owner');

create function pg_temp.use(p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds)
$$;
create function pg_temp.sweep() returns jsonb language sql as $$
	select public.qorpera_computer_hour_zero_sweep(clock_timestamp())
$$;
create function pg_temp.ran_out() returns timestamptz language sql as $$
	select ran_out_at from public.qorpera_computer_hour_zero_state where profile_id = '30000000-0000-4000-8000-000000000010'
$$;
create function pg_temp.out_of_hours(p_status text default null) returns bigint language sql as $$
	select count(*) from public.qorpera_computer_hour_notices
	where kind = 'out_of_hours' and profile_id = '30000000-0000-4000-8000-000000000010'
		and (p_status is null or status = p_status)
$$;
create function pg_temp.claim() returns jsonb language sql as $$
	select public.qorpera_claim_computer_hour_notices(50, extensions.gen_random_uuid())
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_computer_hour_zero_sweep(timestamp with time zone)',
		'public.qorpera_computer_hour_zero_occasion(uuid,timestamp with time zone)']) function_name;
select pg_temp.wake_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_zero_state', privilege),
	role_name || ' has no ' || privilege || ' on the zero state')
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['INSERT', 'UPDATE', 'DELETE']) privilege;
select pg_temp.wake_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_zero_state', 'SELECT'),
	role_name || ' cannot read the zero state')
from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.wake_assert(has_function_privilege('service_role', 'public.qorpera_meter_computer_hours()', 'EXECUTE'),
	'The meter pass is still callable by service_role');

-- 1. Live, the free hours used up exactly (at zero without owing), the rule switched off: nothing kept.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.use(18000);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = 0,
	'No hours left, nothing owed');
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 0, "ranOut": 0}' and pg_temp.ran_out() is null,
	'Switched off, no company is recorded at zero');
select pg_temp.wake_assert(pg_temp.out_of_hours() = 0, 'Not owing: the usage trigger sent no "out of hours"');
select pg_temp.wake_assert(exists (select 1 from public.qorpera_computer_hour_notices
	where kind = 'running_low' and profile_id = '30000000-0000-4000-8000-000000000010' and status = 'pending'),
	'"Running low" was queued on the way down');

-- 2. Switched on: the company ran out now; every founder gets "out of hours" ten minutes later.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 0, "ranOut": 1}'
	and pg_temp.ran_out() > clock_timestamp() - interval '1 minute', 'Newly at zero: recorded with when it ran out');
select set_config('qorpera_test.ran_out', pg_temp.ran_out()::text, true);
select pg_temp.wake_assert((select array_agg(user_id order by user_id) = array['30000000-0000-4000-8000-000000000001',
		'72300000-0000-4000-8000-000000000002']::uuid[]
		and bool_and(occasion = public.qorpera_computer_hour_zero_occasion('30000000-0000-4000-8000-000000000010',
			current_setting('qorpera_test.ran_out')::timestamptz))
		and bool_and(occasion like '30000000-0000-4000-8000-000000000010:zero:%')
		and bool_and(status = 'pending' and next_attempt_at > clock_timestamp() + interval '9 minutes')
		and bool_and(details = jsonb_build_object('companyName', 'Path gateway fixture', 'leftSeconds', 0,
			'month', public.qorpera_computer_hour_notice_month(clock_timestamp())))
	from public.qorpera_computer_hour_notices where kind = 'out_of_hours'), 'Out of hours at zero, to every founder');
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 0, "ranOut": 0}'
	and pg_temp.ran_out() = current_setting('qorpera_test.ran_out')::timestamptz and pg_temp.out_of_hours() = 2,
	'The next sweep changes nothing');

-- 3. The claim keeps the zero notice while the company stays at zero, and drops "running low".
select pg_temp.wake_assert(pg_temp.claim() = '[]', 'Nothing due yet');
select pg_temp.wake_assert(pg_temp.out_of_hours('pending') = 2, 'Still at zero: the notice holds');
select pg_temp.wake_assert((select bool_and(status = 'cancelled' and last_error = 'The company ran out before it was sent')
	from public.qorpera_computer_hour_notices where kind = 'running_low' and profile_id = '30000000-0000-4000-8000-000000000010'),
	'"Running low" is dropped at zero');

-- 4. Work still running out its hour starts owing: no second "out of hours".
select pg_temp.use(600);
select pg_temp.wake_assert(pg_temp.out_of_hours() = 2, 'At zero the founders were already told');

-- 5. Hours arrive: the company leaves zero and the notice not yet sent is dropped.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 36000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 1, "ranOut": 0}' and pg_temp.ran_out() is null,
	'Hours arrived: no longer at zero');
select pg_temp.wake_assert(pg_temp.claim() = '[]', 'Nothing to send');
select pg_temp.wake_assert(pg_temp.out_of_hours('cancelled') = 2 and (select bool_and(last_error = 'Hours arrived before it was sent')
	from public.qorpera_computer_hour_notices where kind = 'out_of_hours'), 'The zero notice is dropped once hours arrive');

-- 6. The credits expire: at zero again without owing, a new time with its own notice, sent when due.
update public.qorpera_computer_hour_sources set expires_at = clock_timestamp() - interval '1 second'
where kind = 'credit' and profile_id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 0, "ranOut": 1}'
	and pg_temp.ran_out() > current_setting('qorpera_test.ran_out')::timestamptz, 'At zero again: a new time');
select pg_temp.wake_assert(pg_temp.out_of_hours('pending') = 2 and pg_temp.out_of_hours() = 4, 'A new notice for the new time');
update public.qorpera_computer_hour_notices set next_attempt_at = clock_timestamp() - interval '1 second'
where status = 'pending';
select pg_temp.wake_assert((select count(*) from jsonb_array_elements(pg_temp.claim()) job
	where job ->> 'kind' = 'out_of_hours') = 2, 'Due and still at zero: both founders are sent it');

-- 7. A complimentary company is never at zero.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 1, "ranOut": 0}' and pg_temp.ran_out() is null,
	'Complimentary: cleared');
delete from public.qorpera_account_entitlements where user_id = '30000000-0000-4000-8000-000000000001';

-- 8. The meter pass runs the sweep.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_meter_computer_hours();
reset role;
select pg_temp.wake_assert(pg_temp.ran_out() is not null, 'The meter pass recorded the company at zero');

-- 9. Switched off again: nothing is kept.
update public.qorpera_computer_hour_billing set zero_rule_since = null;
select pg_temp.wake_assert(pg_temp.sweep() = '{"cleared": 1, "ranOut": 0}' and pg_temp.ran_out() is null,
	'Switched off: cleared');
rollback;
