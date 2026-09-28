-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 3 (20260929090000_runtime_computer_hours_ledger): every usage row is
-- charged as it is inserted. Free hours first, then the founders' current plan periods evenly,
-- then credits (soonest to expire first), else owed; owed time is paid first from later hours. A
-- company with a founder on an internal account is complimentary. A member who is not a founder
-- never pays. Until the live switch everything is a dry run, and live records start fresh.
-- Usage rows are inserted here directly; the meter that writes them is covered by test 710.

-- A second founder and a contributor with a plan of their own.
insert into auth.users(id,email) values
	('71100000-0000-4000-8000-000000000002','hours-founder-2@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','71100000-0000-4000-8000-000000000002','hours-founder-2@example.test','Founder 2','owner');
select pg_temp.wake_assert(array_agg(user_id) = array['30000000-0000-4000-8000-000000000001',
	'71100000-0000-4000-8000-000000000002']::uuid[], 'Two founders, the creator first')
from public.qorpera_company_founders('30000000-0000-4000-8000-000000000010');

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated']) role_name,
	unnest(array['public.qorpera_company_computer_hours_left(uuid)', 'public.qorpera_read_company_computer_hour_sources(uuid)']) function_name;
select pg_temp.wake_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera_computer_hour%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The charging helpers and triggers are callable by no API role');

create function pg_temp.hours_use(p_profile uuid, p_seconds bigint) returns bigint language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values (p_profile, clock_timestamp(), p_seconds, p_seconds) returning id
$$;
create function pg_temp.hours_paid(p_usage bigint, p_kind text, p_user uuid default null) returns bigint language sql as $$
	select coalesce(sum(draw.standard_seconds), 0)::bigint
	from public.qorpera_computer_hour_draws draw
	join public.qorpera_computer_hour_sources source on source.id = draw.source_id
	where draw.usage_id = p_usage and source.kind = p_kind and (p_user is null or source.user_id = p_user)
$$;
create function pg_temp.hours_source(p_kind text, p_user uuid default null) returns public.qorpera_computer_hour_sources language sql as $$
	select * from public.qorpera_computer_hour_sources
	where kind = p_kind and dry_run = (select live_since is null from public.qorpera_computer_hour_billing)
		and (p_kind = 'plan_period' or profile_id = '30000000-0000-4000-8000-000000000010')
		and (p_user is null or user_id = p_user)
	order by created_at desc limit 1
$$;

-- 1. Free hours first, as a dry run; past them nothing pays yet, so the rest is owed.
select set_config('qorpera_test.u1', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 1000)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u1')::bigint, 'free') = 1000
	and (pg_temp.hours_source('free')).dry_run and (pg_temp.hours_source('free')).granted_seconds = 18000,
	'The first 1000 s come from the five free hours, as a dry run');
select set_config('qorpera_test.u2', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 17500)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u2')::bigint, 'free') = 17000
	and pg_temp.hours_paid(current_setting('qorpera_test.u2')::bigint, 'owed') = 500,
	'The free hours run out and 500 s are owed');
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = -500,
	'Hours left are what the sources hold minus what is owed');

-- 2. Plans: both founders (3600 s and 1000 s) and the contributor (never used).
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, dry_run) values
	('plan_period', '30000000-0000-4000-8000-000000000001', 3600, clock_timestamp() - interval '1 day', clock_timestamp() + interval '29 days', true),
	('plan_period', '71100000-0000-4000-8000-000000000002', 1000, clock_timestamp() - interval '1 day', clock_timestamp() + interval '29 days', true),
	('plan_period', '30000000-0000-4000-8000-000000000002', 9000, clock_timestamp() - interval '1 day', clock_timestamp() + interval '29 days', true),
	('plan_period', '30000000-0000-4000-8000-000000000001', 7777, clock_timestamp() - interval '40 days', clock_timestamp() - interval '10 days', true);
-- The owed 500 s are paid first, evenly (250 each); then 2001 s: 1001 and 750 (Founder 2 runs out),
-- and the creator carries the other 250.
select set_config('qorpera_test.u3', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 2001)::text, true);
select pg_temp.wake_assert(
	(select sum(standard_seconds) from public.qorpera_computer_hour_repayments where owed_source_id = (pg_temp.hours_source('owed')).id) = 500
	and (pg_temp.hours_source('owed')).repaid_seconds = 500,
	'The owed time is paid first');
select pg_temp.wake_assert(
	pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'plan_period', '30000000-0000-4000-8000-000000000001') = 1251
	and pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'plan_period', '71100000-0000-4000-8000-000000000002') = 750
	and pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'free') = 0,
	'Split evenly between the founders with hours left; the other carries the rest');
select pg_temp.wake_assert((pg_temp.hours_source('plan_period', '30000000-0000-4000-8000-000000000001')).drawn_seconds = 0
	and (select drawn_seconds from public.qorpera_computer_hour_sources where kind = 'plan_period'
		and user_id = '30000000-0000-4000-8000-000000000001' and granted_seconds = 3600) = 1501
	and (select drawn_seconds from public.qorpera_computer_hour_sources where kind = 'plan_period'
		and user_id = '71100000-0000-4000-8000-000000000002') = 1000
	and (select drawn_seconds from public.qorpera_computer_hour_sources where kind = 'plan_period'
		and user_id = '30000000-0000-4000-8000-000000000002') = 0,
	'A past period and a contributor''s plan pay nothing');

-- 3. Credits, the soonest to expire first; an expired one pays nothing.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run) values
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 500, clock_timestamp() + interval '1 year', true),
	('credit', '30000000-0000-4000-8000-000000000010', '71100000-0000-4000-8000-000000000002', 100, clock_timestamp() + interval '1 month', true),
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 999, clock_timestamp() - interval '1 day', true);
-- 3000 s: the creator's plan has 2099 left, then 100 and 500 of credits, 301 owed.
select set_config('qorpera_test.u4', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 3000)::text, true);
select pg_temp.wake_assert(
	pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'plan_period') = 2099
	and pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'credit') = 600
	and pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'owed') = 301
	and (select array_agg(drawn_seconds order by expires_at) from public.qorpera_computer_hour_sources
		where kind = 'credit' and profile_id = '30000000-0000-4000-8000-000000000010') = array[0, 100, 500]::bigint[],
	'Plans, then credits soonest to expire first, then owed');
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = -301,
	'Out of hours: all spent and 301 s owed');
-- A frozen credit and a withdrawn plan pay nothing.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, frozen_at, dry_run) values
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 5000, clock_timestamp() + interval '1 year', clock_timestamp(), true);
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, withdrawn_at, dry_run) values
	('plan_period', '71100000-0000-4000-8000-000000000002', 5000, clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', clock_timestamp(), true);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = -301,
	'Frozen and withdrawn sources add nothing');
-- New credits: the owed 301 s are paid first from them.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run) values
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 1000, clock_timestamp() + interval '1 year', true);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = 699,
	'Hours arrive: 1000 s of credit minus 301 s owed');
select set_config('qorpera_test.u5', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 99)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u5')::bigint, 'credit') = 99
	and (pg_temp.hours_source('owed')).repaid_seconds = (pg_temp.hours_source('owed')).drawn_seconds
	and public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = 600,
	'The owed time was paid first, then the new use');

-- 4. A founder who leaves stops paying for the company.
update public.qorpera_profile_members set role = 'admin'
where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '71100000-0000-4000-8000-000000000002';
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, dry_run) values
	('plan_period', '71100000-0000-4000-8000-000000000002', 4000, clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', true);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = 600,
	'A former founder''s plan does not count for the company');

-- 5. Complimentary: a company with a founder on an internal account.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select set_config('qorpera_test.u6', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 50000)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u6')::bigint, 'complimentary', '30000000-0000-4000-8000-000000000001') = 50000
	and public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') is null,
	'An internal founder makes the company complimentary: recorded, never limited');
delete from public.qorpera_account_entitlements where user_id = '30000000-0000-4000-8000-000000000001';

-- 6. Live: records start fresh, with new free hours; the dry run is not counted.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp();
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = 18000,
	'Live: only the five free hours, nothing of the dry run');
select set_config('qorpera_test.u7', pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 60)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u7')::bigint, 'free') = 60
	and not (pg_temp.hours_source('free')).dry_run and (pg_temp.hours_source('free')).drawn_seconds = 60,
	'Live use is paid by a live free source');
select pg_temp.wake_assert(source ->> 'kind' = 'free' and (source ->> 'drawnSeconds')::bigint = 60
	and read ->> 'mode' = 'live' and (read ->> 'hoursLeftSeconds')::bigint = 17940,
	'The operator read shows the live sources: ' || read::text)
from (select public.qorpera_read_company_computer_hour_sources('30000000-0000-4000-8000-000000000010') read) r,
	jsonb_array_elements(read -> 'sources') source;

-- 7. A zero-second row charges nothing, and the records are append-only.
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_draws
	where usage_id = pg_temp.hours_use('30000000-0000-4000-8000-000000000010', 0)), 'Nothing to pay for zero seconds');
select pg_temp.wake_error('update public.qorpera_computer_hour_draws set standard_seconds = 1', '42501');
select pg_temp.wake_error('delete from public.qorpera_computer_hour_repayments', '42501');
rollback;
