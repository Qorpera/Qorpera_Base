-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 3 (20260929090000_runtime_computer_hours_ledger): every usage row is
-- charged as it is inserted. Free hours first, then the founders' current plan periods evenly (one
-- share per founder), then credits (soonest to expire first), else owed. Owed time is paid as soon
-- as hours arrive, in the same order. A company with a founder on an internal account is
-- complimentary. A member who is not a founder never pays. Until the live switch everything is a
-- dry run, and live records start fresh. Usage rows are inserted here directly; the meter that
-- writes them is covered by test 710.

-- A second founder.
insert into auth.users(id,email) values
	('71100000-0000-4000-8000-000000000002','hours-founder-2@example.test'),
	('71100000-0000-4000-8000-000000000003','hours-founder-3@example.test'),
	('71100000-0000-4000-8000-000000000004','hours-founder-4@example.test');
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

create function pg_temp.hours_use(p_seconds bigint) returns bigint language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds) returning id
$$;
create function pg_temp.hours_paid(p_usage bigint, p_kind text, p_user uuid default null) returns bigint language sql as $$
	select coalesce(sum(draw.standard_seconds), 0)::bigint
	from public.qorpera_computer_hour_draws draw
	join public.qorpera_computer_hour_sources source on source.id = draw.source_id
	where draw.usage_id = p_usage and source.kind = p_kind and (p_user is null or source.user_id = p_user)
$$;
create function pg_temp.hours_owed() returns public.qorpera_computer_hour_sources language sql as $$
	select * from public.qorpera_computer_hour_sources
	where kind = 'owed' and profile_id = '30000000-0000-4000-8000-000000000010'
		and dry_run = (select live_since is null from public.qorpera_computer_hour_billing)
$$;
create function pg_temp.hours_plan_drawn(p_user uuid, p_granted bigint) returns bigint language sql as $$
	select drawn_seconds from public.qorpera_computer_hour_sources
	where kind = 'plan_period' and user_id = p_user and granted_seconds = p_granted
$$;
create function pg_temp.hours_left() returns bigint language sql as $$
	select public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010')
$$;
create function pg_temp.hours_plan(p_user uuid, p_granted bigint, p_from interval, p_to interval, p_dry boolean default true)
returns void language sql as $$
	insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, dry_run)
	values ('plan_period', p_user, p_granted, clock_timestamp() + p_from, clock_timestamp() + p_to, p_dry)
$$;
create function pg_temp.hours_credit(p_granted bigint, p_expires interval, p_dry boolean default true) returns void language sql as $$
	insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
	values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', p_granted,
		clock_timestamp() + p_expires, p_dry)
$$;

-- 1. Free hours first, as a dry run; past them nothing pays yet, so the rest is owed.
select set_config('qorpera_test.u1', pg_temp.hours_use(1000)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u1')::bigint, 'free') = 1000
	and source.dry_run and source.granted_seconds = 18000,
	'The first 1000 s come from the five free hours, as a dry run')
from public.qorpera_computer_hour_sources source
where source.kind = 'free' and source.profile_id = '30000000-0000-4000-8000-000000000010';
select set_config('qorpera_test.u2', pg_temp.hours_use(17500)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u2')::bigint, 'free') = 17000
	and pg_temp.hours_paid(current_setting('qorpera_test.u2')::bigint, 'owed') = 500,
	'The free hours run out and 500 s are owed');
select pg_temp.wake_assert(pg_temp.hours_left() = -500, 'Hours left are what the sources hold minus what is owed');

-- 2. Plans arrive. The creator's 3600 s arrive first and pay the owed 500 s at once. Founder 2's
-- 1000 s, a contributor's 9000 s and a past period of the creator's pay nothing now.
select pg_temp.hours_plan('30000000-0000-4000-8000-000000000001', 3600, '-1 day', '29 days');
select pg_temp.wake_assert((pg_temp.hours_owed()).repaid_seconds = 500
	and pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000001', 3600) = 500
	and (select usage_id from public.qorpera_computer_hour_repayments) is null,
	'Owed time is paid as soon as hours arrive');
select pg_temp.hours_plan('71100000-0000-4000-8000-000000000002', 1000, '-1 day', '29 days');
select pg_temp.hours_plan('30000000-0000-4000-8000-000000000002', 9000, '-1 day', '29 days');
select pg_temp.hours_plan('30000000-0000-4000-8000-000000000001', 7777, '-40 days', '-10 days');
-- 2001 s evenly: the creator (3100 left) 1001, Founder 2 (1000 left) 1000.
select set_config('qorpera_test.u3', pg_temp.hours_use(2001)::text, true);
select pg_temp.wake_assert(
	pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'plan_period', '30000000-0000-4000-8000-000000000001') = 1001
	and pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'plan_period', '71100000-0000-4000-8000-000000000002') = 1000
	and pg_temp.hours_paid(current_setting('qorpera_test.u3')::bigint, 'free') = 0,
	'Split evenly between the founders; the most hours left gets the remainder second');
select pg_temp.wake_assert(pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000001', 3600) = 1501
	and pg_temp.hours_plan_drawn('71100000-0000-4000-8000-000000000002', 1000) = 1000
	and pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000002', 9000) = 0
	and pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000001', 7777) = 0,
	'A past period and a contributor''s plan pay nothing');

-- 3. Credits, the soonest to expire first; an expired one pays nothing.
select pg_temp.hours_credit(500, '1 year');
select pg_temp.hours_credit(100, '1 month');
select pg_temp.hours_credit(999, '-1 day');
-- 3000 s: the creator's plan has 2099 left, then 100 and 500 of credits, 301 owed.
select set_config('qorpera_test.u4', pg_temp.hours_use(3000)::text, true);
select pg_temp.wake_assert(
	pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'plan_period') = 2099
	and pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'credit') = 600
	and pg_temp.hours_paid(current_setting('qorpera_test.u4')::bigint, 'owed') = 301
	and (select array_agg(drawn_seconds order by expires_at) from public.qorpera_computer_hour_sources
		where kind = 'credit' and profile_id = '30000000-0000-4000-8000-000000000010') = array[0, 100, 500]::bigint[],
	'Plans, then credits soonest to expire first, then owed');
select pg_temp.wake_assert(pg_temp.hours_left() = -301, 'Out of hours: all spent and 301 s owed');
-- A frozen credit, a withdrawn plan and a live credit add nothing during the dry run.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, frozen_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 5000,
	clock_timestamp() + interval '1 year', clock_timestamp(), true);
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, withdrawn_at, dry_run)
values ('plan_period', '71100000-0000-4000-8000-000000000002', 5000, clock_timestamp() - interval '1 day',
	clock_timestamp() + interval '1 day', clock_timestamp(), true);
select pg_temp.hours_credit(4000, '1 year', false);
select pg_temp.wake_assert(pg_temp.hours_left() = -301 and (pg_temp.hours_owed()).repaid_seconds = 500,
	'Frozen, withdrawn and live sources pay nothing in the dry run');
-- 100 s of credit arrive: a part of what is owed is paid; then 1000 s pay the rest.
select pg_temp.hours_credit(100, '6 months');
select pg_temp.wake_assert((pg_temp.hours_owed()).repaid_seconds = 600 and pg_temp.hours_left() = -201,
	'A partial repayment');
select pg_temp.hours_credit(1000, '2 years');
select pg_temp.wake_assert((pg_temp.hours_owed()).repaid_seconds = (pg_temp.hours_owed()).drawn_seconds
	and pg_temp.hours_left() = 799, 'The rest is repaid when more hours arrive');
select set_config('qorpera_test.u5', pg_temp.hours_use(99)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u5')::bigint, 'credit') = 99
	and pg_temp.hours_left() = 700, 'New use is paid from what is left');

-- 4. A founder who steps down stops paying for the company, also for plans that arrive later.
update public.qorpera_profile_members set role = 'admin'
where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '71100000-0000-4000-8000-000000000002';
select pg_temp.hours_plan('71100000-0000-4000-8000-000000000002', 4000, '-1 hour', '30 days');
select set_config('qorpera_test.u6', pg_temp.hours_use(100)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u6')::bigint, 'plan_period') = 0
	and pg_temp.hours_plan_drawn('71100000-0000-4000-8000-000000000002', 4000) = 0 and pg_temp.hours_left() = 600,
	'A former founder''s plan pays nothing for the company');

-- 5. Complimentary: a company with a founder on an internal account.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select set_config('qorpera_test.u7', pg_temp.hours_use(50000)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u7')::bigint, 'complimentary', '30000000-0000-4000-8000-000000000001') = 50000
	and pg_temp.hours_left() is null,
	'An internal founder makes the company complimentary: recorded, never limited');
delete from public.qorpera_account_entitlements where user_id = '30000000-0000-4000-8000-000000000001';

-- Every dry-run source's totals match its records.
select pg_temp.wake_assert(bool_and(
	source.drawn_seconds = coalesce((select sum(draw.standard_seconds) from public.qorpera_computer_hour_draws draw where draw.source_id = source.id), 0)
		+ coalesce((select sum(repayment.standard_seconds) from public.qorpera_computer_hour_repayments repayment where repayment.source_id = source.id), 0)
	and source.repaid_seconds = coalesce((select sum(repayment.standard_seconds) from public.qorpera_computer_hour_repayments repayment
		where repayment.owed_source_id = source.id), 0)), 'Totals match the draws and repayments')
from public.qorpera_computer_hour_sources source where source.dry_run;

-- 6. Live: records start fresh, with new free hours; the dry run is not counted, and the live
-- credit that arrived during the dry run counts now.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp();
select pg_temp.wake_assert(pg_temp.hours_left() = 18000 + 4000, 'Live: five free hours and the live credit, nothing of the dry run');
select set_config('qorpera_test.u8', pg_temp.hours_use(60)::text, true);
select pg_temp.wake_assert(pg_temp.hours_paid(current_setting('qorpera_test.u8')::bigint, 'free') = 60
	and exists (select 1 from public.qorpera_computer_hour_sources where kind = 'free' and not dry_run and drawn_seconds = 60),
	'Live use is paid by a live free source');
select pg_temp.wake_assert((read ->> 'mode') = 'live' and (read ->> 'hoursLeftSeconds')::bigint = 21940
	and jsonb_array_length(read -> 'sources') = 2
	and (select count(*) from jsonb_array_elements(read -> 'sources') s where s ->> 'kind' = 'free' and (s ->> 'drawnSeconds')::bigint = 60) = 1,
	'The operator read shows the live sources: ' || read::text)
from (select public.qorpera_read_company_computer_hour_sources('30000000-0000-4000-8000-000000000010') read) r;

-- 7. One share per founder, and a remainder between three. Three founders with live plans; the
-- creator's is two rows. The free hours and the credit are spent first.
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','71100000-0000-4000-8000-000000000003','hours-founder-3@example.test','Founder 3','owner'),
	('30000000-0000-4000-8000-000000000010','71100000-0000-4000-8000-000000000004','hours-founder-4@example.test','Founder 4','owner');
select pg_temp.hours_use(17940 + 4000);
select pg_temp.wake_assert(pg_temp.hours_left() = 0, 'Free hours and the live credit are spent');
select pg_temp.hours_plan('30000000-0000-4000-8000-000000000001', 60, '-1 day', '10 days', false);
select pg_temp.hours_plan('30000000-0000-4000-8000-000000000001', 40, '-1 day', '5 days', false);
select pg_temp.hours_plan('71100000-0000-4000-8000-000000000003', 100, '-1 day', '10 days', false);
select pg_temp.hours_plan('71100000-0000-4000-8000-000000000004', 100, '-1 day', '10 days', false);
-- 8 s between three founders with 100 s each: 3, 3 and 2, in founder id order.
select set_config('qorpera_test.u9', pg_temp.hours_use(8)::text, true);
select pg_temp.wake_assert(
	pg_temp.hours_paid(current_setting('qorpera_test.u9')::bigint, 'plan_period', '30000000-0000-4000-8000-000000000001') = 3
	and pg_temp.hours_paid(current_setting('qorpera_test.u9')::bigint, 'plan_period', '71100000-0000-4000-8000-000000000003') = 3
	and pg_temp.hours_paid(current_setting('qorpera_test.u9')::bigint, 'plan_period', '71100000-0000-4000-8000-000000000004') = 2
	and pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000001', 40) = 3
	and pg_temp.hours_plan_drawn('30000000-0000-4000-8000-000000000001', 60) = 0,
	'One share per founder; a founder''s period that ends soonest pays first');

-- 8. A zero-second row charges nothing, and the records are append-only.
select set_config('qorpera_test.u0', pg_temp.hours_use(0)::text, true);
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_draws
	where usage_id = current_setting('qorpera_test.u0')::bigint), 'Nothing to pay for zero seconds');
select pg_temp.wake_error('update public.qorpera_computer_hour_draws set standard_seconds = 1', '42501');
select pg_temp.wake_error('delete from public.qorpera_computer_hour_repayments', '42501');
rollback;
