-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours (20260929300000_runtime_computer_hours_bounded_checks): hours left for many
-- companies in one query, the same as for one; the zero check looks the company up in the zero
-- state first (running out counts from the next sweep, leaving zero at once); the sweep records and
-- clears companies from hours left, with the full check only where it can matter.

insert into auth.users(id,email) values
	('72600000-0000-4000-8000-000000000001','bounded-a@example.test'),
	('72600000-0000-4000-8000-000000000002','bounded-b@example.test'),
	('72600000-0000-4000-8000-000000000003','bounded-staff@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('72600000-0000-4000-8000-000000000010','Fresh','72600000-0000-4000-8000-000000000001'),
	('72600000-0000-4000-8000-000000000020','Credits','72600000-0000-4000-8000-000000000001'),
	('72600000-0000-4000-8000-000000000030','Plan','72600000-0000-4000-8000-000000000002'),
	('72600000-0000-4000-8000-000000000040','Owing','72600000-0000-4000-8000-000000000001'),
	('72600000-0000-4000-8000-000000000050','Staff','72600000-0000-4000-8000-000000000003');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('72600000-0000-4000-8000-000000000010','72600000-0000-4000-8000-000000000001','bounded-a@example.test','A','owner'),
	('72600000-0000-4000-8000-000000000020','72600000-0000-4000-8000-000000000001','bounded-a@example.test','A','owner'),
	('72600000-0000-4000-8000-000000000030','72600000-0000-4000-8000-000000000002','bounded-b@example.test','B','owner'),
	('72600000-0000-4000-8000-000000000040','72600000-0000-4000-8000-000000000001','bounded-a@example.test','A','owner'),
	('72600000-0000-4000-8000-000000000050','72600000-0000-4000-8000-000000000003','bounded-staff@example.test','S','owner');
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('72600000-0000-4000-8000-000000000003', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');

create function pg_temp.use(p_profile uuid, p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values (p_profile, clock_timestamp(), p_seconds, p_seconds)
$$;
create function pg_temp.left_many() returns jsonb language sql as $$
	select jsonb_object_agg(hours.profile_id::text, hours.left_seconds)
	from public.qorpera_computer_hour_left_many(array['72600000-0000-4000-8000-000000000010',
		'72600000-0000-4000-8000-000000000020', '72600000-0000-4000-8000-000000000030',
		'72600000-0000-4000-8000-000000000040', '72600000-0000-4000-8000-000000000050',
		'72600000-0000-4000-8000-000000000040', null]::uuid[]) hours
$$;
create function pg_temp.left_one() returns jsonb language sql as $$
	select jsonb_object_agg(company.id::text, public.qorpera_company_computer_hours_left(company.id))
	from unnest(array['72600000-0000-4000-8000-000000000010', '72600000-0000-4000-8000-000000000020',
		'72600000-0000-4000-8000-000000000030', '72600000-0000-4000-8000-000000000040',
		'72600000-0000-4000-8000-000000000050']::uuid[]) company(id)
$$;
create function pg_temp.at_zero(p_profile uuid) returns boolean language sql as $$
	select public.qorpera_company_at_zero(p_profile, clock_timestamp())
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_computer_hour_left_many(uuid[])',
		'public.qorpera_company_at_zero_now(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_renewal_grace(uuid,timestamp with time zone)',
		'public.qorpera_company_at_zero(uuid,timestamp with time zone)']) function_name;
select pg_temp.wake_assert(has_function_privilege('service_role', 'public.qorpera_company_computer_hours_left(uuid)', 'EXECUTE')
	and not has_function_privilege('authenticated', 'public.qorpera_company_computer_hours_left(uuid)', 'EXECUTE'),
	'Hours left keeps its grants');

-- Live: fresh (all five free hours), credits (free used, a pack left), plan (a founder's plan
-- period), owing (past zero), staff (complimentary: no limit). A company named twice, and a null,
-- are read once and left out.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '72600000-0000-4000-8000-000000000020', '72600000-0000-4000-8000-000000000001', 36000,
	clock_timestamp() + interval '12 months', false);
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '72600000-0000-4000-8000-000000000002', 7200, clock_timestamp() - interval '1 day',
	clock_timestamp() + interval '29 days', 'sub_Bounded1:1', false);
select pg_temp.use('72600000-0000-4000-8000-000000000020', 20000);
select pg_temp.use('72600000-0000-4000-8000-000000000030', 19000);
select pg_temp.use('72600000-0000-4000-8000-000000000040', 20000);
select pg_temp.use('72600000-0000-4000-8000-000000000050', 50000);
select pg_temp.wake_assert(pg_temp.left_many() = jsonb_build_object(
		'72600000-0000-4000-8000-000000000010', 18000, '72600000-0000-4000-8000-000000000020', 34000,
		'72600000-0000-4000-8000-000000000030', 6200, '72600000-0000-4000-8000-000000000040', -2000,
		'72600000-0000-4000-8000-000000000050', null),
	'Hours left for many companies at once: ' || pg_temp.left_many()::text);
select pg_temp.wake_assert(pg_temp.left_one() = pg_temp.left_many(), 'One company at a time gives the same');
-- Before live payments the dry-run ledger counts, as before.
update public.qorpera_computer_hour_billing set live_since = null;
select pg_temp.wake_assert(pg_temp.left_many() ->> '72600000-0000-4000-8000-000000000040' = '18000'
	and pg_temp.left_one() = pg_temp.left_many(), 'Dry run: its own ledger, which has no use here yet');
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 hour';

-- The zero check: not recorded, not at zero; recorded by the sweep, at zero; hours arriving count at once.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(not pg_temp.at_zero('72600000-0000-4000-8000-000000000040')
	and public.qorpera_company_at_zero_now('72600000-0000-4000-8000-000000000040', clock_timestamp()),
	'At zero, but not recorded yet: work still starts until the next sweep');
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) = '{"cleared": 0, "ranOut": 1}',
	'The sweep records only the company with no hours left (not the complimentary one)');
select pg_temp.wake_assert(pg_temp.at_zero('72600000-0000-4000-8000-000000000040')
	and not pg_temp.at_zero('72600000-0000-4000-8000-000000000020')
	and not pg_temp.at_zero('72600000-0000-4000-8000-000000000050'), 'Recorded: at zero; the others not');
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '72600000-0000-4000-8000-000000000040', '72600000-0000-4000-8000-000000000001', 3600,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(not pg_temp.at_zero('72600000-0000-4000-8000-000000000040'),
	'Hours arrived: not at zero at once, though still recorded');
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) = '{"cleared": 1, "ranOut": 0}',
	'The sweep clears it (hours left, no full check needed)');

-- A recorded company whose founder's plan period just ended, renewal pending: the grace clears it.
update public.qorpera_computer_hour_sources set withdrawn_at = clock_timestamp()
where kind = 'credit' and profile_id = '72600000-0000-4000-8000-000000000040';
select pg_temp.use('72600000-0000-4000-8000-000000000030', 20000);
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) = '{"cleared": 0, "ranOut": 2}',
	'Owing and plan companies recorded');
insert into public.qorpera_computer_hour_subscriptions (stripe_subscription_id, user_id, livemode, item_key, status,
	period_start, period_end, event_created)
values ('sub_Bounded1', '72600000-0000-4000-8000-000000000002', true, 'basis', 'active',
	clock_timestamp(), clock_timestamp() + interval '30 days', clock_timestamp());
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '5 minutes'
where reference = 'sub_Bounded1:1';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) = '{"cleared": 1, "ranOut": 0}',
	'Renewal in progress: the plan company is cleared, the owing one stays');
select pg_temp.wake_assert(pg_temp.at_zero('72600000-0000-4000-8000-000000000040')
	and not pg_temp.at_zero('72600000-0000-4000-8000-000000000030'), 'Which one');
-- Half an hour on with no renewal: recorded again.
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '31 minutes'
where reference = 'sub_Bounded1:1';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) = '{"cleared": 0, "ranOut": 1}',
	'No renewal: at zero again');
rollback;
