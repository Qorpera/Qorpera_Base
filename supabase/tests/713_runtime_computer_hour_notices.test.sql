-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 5 (20260929160000_runtime_computer_hour_notices): hour notices to
-- founders as an email outbox. Nothing before the live switch; "running low" once a month to the
-- payers (or every founder on free hours); "out of hours" once per time the company runs out, to
-- every founder; a summary per used plan period; the worker's claim, completion and failure.

-- A second founder of the fixture company.
insert into auth.users(id,email) values
	('71300000-0000-4000-8000-000000000002','notice-founder-2@example.test'),
	('71300000-0000-4000-8000-000000000005','notice-internal@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','71300000-0000-4000-8000-000000000002','notice-founder-2@example.test','Founder 2','owner');
-- A second company with the same two founders, and a complimentary company (an internal founder).
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('71300000-0000-4000-8000-000000000020','Second company','30000000-0000-4000-8000-000000000001'),
	('71300000-0000-4000-8000-000000000030','Staff company','71300000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('71300000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('71300000-0000-4000-8000-000000000020','71300000-0000-4000-8000-000000000002','notice-founder-2@example.test','Founder 2','owner'),
	('71300000-0000-4000-8000-000000000030','71300000-0000-4000-8000-000000000005','notice-internal@example.test','Staff','owner');
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('71300000-0000-4000-8000-000000000005', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');

create function pg_temp.use(p_profile uuid, p_seconds bigint, p_at timestamptz default clock_timestamp()) returns bigint language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values (p_profile, p_at, p_seconds, p_seconds) returning id
$$;
create function pg_temp.notices(p_kind text, p_profile uuid default null) returns uuid[] language sql as $$
	select coalesce(array_agg(user_id order by user_id), '{}') from public.qorpera_computer_hour_notices
	where kind = p_kind and (p_profile is null or profile_id = p_profile)
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated']) role_name,
	unnest(array['public.qorpera_claim_computer_hour_notices(integer,uuid)',
		'public.qorpera_complete_computer_hour_notice(uuid,uuid,text)',
		'public.qorpera_fail_computer_hour_notice(uuid,uuid,text,boolean)']) function_name;
select pg_temp.wake_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera_computer_hour_%notice%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The notice helpers are callable by no API role');
select pg_temp.wake_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_notices', 'INSERT'),
	'Notices are written only by the database, not by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;

-- 1. Before the live switch nothing is queued, however much is used.
select pg_temp.use('30000000-0000-4000-8000-000000000010', 30000);
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_notices), 'No notices in the dry run');

-- 2. Live. On free hours (5 h), "running low" goes to every founder once a month, under one hour left.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.use('30000000-0000-4000-8000-000000000010', 14000);
select pg_temp.wake_assert(pg_temp.notices('running_low') = '{}', 'Still 4000 s of 18000 left: no notice');
select pg_temp.use('30000000-0000-4000-8000-000000000010', 500);
select pg_temp.wake_assert(pg_temp.notices('running_low') = array['30000000-0000-4000-8000-000000000001',
	'71300000-0000-4000-8000-000000000002']::uuid[], 'Running low on free hours: every founder');
select pg_temp.wake_assert(details = jsonb_build_object('companyName', 'Path gateway fixture', 'leftSeconds', 3500,
	'month', public.qorpera_computer_hour_notice_month(clock_timestamp()), 'hoursSeconds', 18000)
	and occasion = '30000000-0000-4000-8000-000000000010:' || public.qorpera_computer_hour_notice_month(clock_timestamp())
	and status = 'pending', 'What the notice says: ' || details::text)
from public.qorpera_computer_hour_notices where kind = 'running_low' and user_id = '30000000-0000-4000-8000-000000000001';
select pg_temp.use('30000000-0000-4000-8000-000000000010', 100);
select pg_temp.wake_assert(cardinality(pg_temp.notices('running_low')) = 2, 'Once a month');

-- 3. Out of hours: once per time the company runs out, to every founder.
select pg_temp.use('30000000-0000-4000-8000-000000000010', 4000);
select pg_temp.wake_assert(pg_temp.notices('out_of_hours') = array['30000000-0000-4000-8000-000000000001',
	'71300000-0000-4000-8000-000000000002']::uuid[], 'Out of hours: every founder');
select pg_temp.use('30000000-0000-4000-8000-000000000010', 100);
select pg_temp.wake_assert(cardinality(pg_temp.notices('out_of_hours')) = 2, 'Once while it owes');
-- Credits arrive and repay what is owed; running out again is a new time.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 36000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.use('30000000-0000-4000-8000-000000000010', 35000);
select pg_temp.wake_assert(cardinality(pg_temp.notices('running_low')) = 2, 'Running low again this month: no second notice');
select pg_temp.use('30000000-0000-4000-8000-000000000010', 1000);
select pg_temp.wake_assert(cardinality(pg_temp.notices('out_of_hours')) = 4
	and (select count(distinct occasion) from public.qorpera_computer_hour_notices where kind = 'out_of_hours') = 2,
	'Running out again after hours arrived is a new notice');

-- 4. Running low goes to the payers: here the founder who bought the credits in use.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '71300000-0000-4000-8000-000000000020', '71300000-0000-4000-8000-000000000002', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.use('71300000-0000-4000-8000-000000000020', 18000);
select pg_temp.use('71300000-0000-4000-8000-000000000020', 50000);
select pg_temp.wake_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000020') = '{}',
	'22000 s of 72000 left: more than a fifth');
select pg_temp.use('71300000-0000-4000-8000-000000000020', 8000);
select pg_temp.wake_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000020')
	= array['71300000-0000-4000-8000-000000000002']::uuid[], 'A fifth left: the credit buyer only');

-- 5. A complimentary company gets no notices.
select pg_temp.use('71300000-0000-4000-8000-000000000030', 100000);
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_notices
	where profile_id = '71300000-0000-4000-8000-000000000030'), 'Complimentary: nothing');

-- 6. A summary for each used plan period that ended, listing each company's use; none for an unused one.
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '71300000-0000-4000-8000-000000000002', 74 * 3600, clock_timestamp() - interval '30 days',
		clock_timestamp() - interval '1 hour', 'sub_T2:1000', false),
	('plan_period', '30000000-0000-4000-8000-000000000001', 74 * 3600, clock_timestamp() - interval '33 days',
		clock_timestamp() - interval '3 days', 'sub_T3:1000', false);
-- Use two hours ago, inside the period (the switch is moved back so that use is live too).
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '3 hours';
select pg_temp.use('71300000-0000-4000-8000-000000000020', 3600, clock_timestamp() - interval '2 hours');
select pg_temp.wake_assert(public.qorpera_computer_hour_queue_summaries(clock_timestamp()) = 1
	and public.qorpera_computer_hour_queue_summaries(clock_timestamp()) = 0, 'One summary, once');
select pg_temp.wake_assert(user_id = '71300000-0000-4000-8000-000000000002' and profile_id is null
	and details -> 'companies' = '[{"companyName":"Second company","seconds":3600}]'::jsonb
	and (details ->> 'grantedSeconds')::bigint = 74 * 3600, 'The summary: ' || details::text)
from public.qorpera_computer_hour_notices where kind = 'monthly_summary';

-- 7. The worker: a recipient no longer a founder is dropped; the rest are leased once, with addresses.
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '71300000-0000-4000-8000-000000000020' and user_id = '71300000-0000-4000-8000-000000000002';
select set_config('qorpera_test.claim', public.qorpera_claim_computer_hour_notices(50,
	'71300000-0000-4000-8000-0000000000a1')::text, true);
select pg_temp.wake_assert(status = 'failed' and last_error = 'The recipient is no longer a founder of the company',
	'A former founder gets no running-low email')
from public.qorpera_computer_hour_notices
where kind = 'running_low' and profile_id = '71300000-0000-4000-8000-000000000020';
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.claim')::jsonb) = 7
	and exists (select 1 from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) job
		where job ->> 'kind' = 'monthly_summary' and job ->> 'recipientEmail' = 'notice-founder-2@example.test'),
	'Seven notices claimed, each with its address: ' || current_setting('qorpera_test.claim'));
select pg_temp.wake_assert(public.qorpera_claim_computer_hour_notices(50, '71300000-0000-4000-8000-0000000000a2') = '[]',
	'Leased notices are not claimed twice');
select set_config('qorpera_test.first', current_setting('qorpera_test.claim')::jsonb -> 0 ->> 'noticeId', true);
select set_config('qorpera_test.second', current_setting('qorpera_test.claim')::jsonb -> 1 ->> 'noticeId', true);
select set_config('qorpera_test.third', current_setting('qorpera_test.claim')::jsonb -> 2 ->> 'noticeId', true);
select pg_temp.wake_assert(public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.first')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 're_1')
	and not public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.first')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 're_1'), 'Sent once');
select pg_temp.wake_assert(not public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.second')::uuid,
	'71300000-0000-4000-8000-0000000000a2', 're_2'), 'Another lease cannot complete it');
select pg_temp.wake_assert(public.qorpera_fail_computer_hour_notice(current_setting('qorpera_test.second')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 'Resend 503', true)
	and public.qorpera_fail_computer_hour_notice(current_setting('qorpera_test.third')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 'Invalid recipient', false), 'Failures recorded');
select pg_temp.wake_assert(
	(select status = 'sent' and sent_at is not null and provider_message_id = 're_1' from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.first')::uuid)
	and (select status = 'retrying' and next_attempt_at > clock_timestamp() from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.second')::uuid)
	and (select status = 'failed' and last_error = 'Invalid recipient' from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.third')::uuid), 'Sent, retrying later, failed');
select pg_temp.wake_error($$select public.qorpera_claim_computer_hour_notices(0, '71300000-0000-4000-8000-0000000000a3')$$, '22023');
rollback;
