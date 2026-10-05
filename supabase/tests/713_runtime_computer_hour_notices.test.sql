-- Computer hours, build step 5 (20260928249160_runtime_computer_hour_notices), on folder-v2 companies of their own (ported
-- from snapshot-v1 in the legacy sweep): hour notices to founders as an email outbox. Nothing before the live switch;
-- "running low" once a month to the payers (or every founder on free hours); "out of hours" once per time the company runs
-- out, to every founder; both sent ten minutes later unless hours arrived; a summary per used plan period; the worker's
-- claim, completion and failure.
begin;

create function pg_temp.notice_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Notice assertion: %', p_message; end if; end
$$;
create function pg_temp.notice_error(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected SQLSTATE %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE %, call succeeded', p_state;
end
$$;
-- Puts a company on the folder core: its environment, enabled as the service role.
create function pg_temp.notice_folder(p_profile uuid) returns void language plpgsql as $$
declare v_env uuid := md5('environment:' || p_profile::text)::uuid;
begin
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	select v_env, id, 'Environment', 1, created_by_user_id from public.qorpera_profiles where id = p_profile;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable(v_env);
	perform pg_temp.notice_assert(public.qorpera_company_is_folder_v2(p_profile), 'The company is folder-v2');
end
$$;

-- The company's creator, a second founder, and the founders of the other companies below.
insert into auth.users(id,email) values
	('71300000-0000-4000-8000-000000000001','notices-owner@example.test'),
	('71300000-0000-4000-8000-000000000002','notice-founder-2@example.test'),
	('71300000-0000-4000-8000-000000000005','notice-internal@example.test'),
	('71300000-0000-4000-8000-000000000006','notice-plan-holder@example.test'),
	('71300000-0000-4000-8000-000000000007','notice-founder-7@example.test'),
	('71300000-0000-4000-8000-000000000008','notice-soon-staff@example.test'),
	('71300000-0000-4000-8000-000000000009','');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('71300000-0000-4000-8000-000000000010','Hour notices','71300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('71300000-0000-4000-8000-000000000010','71300000-0000-4000-8000-000000000001','notices-owner@example.test','Owner','owner'),
	('71300000-0000-4000-8000-000000000010','71300000-0000-4000-8000-000000000002','notice-founder-2@example.test','Founder 2','owner');
select pg_temp.notice_folder('71300000-0000-4000-8000-000000000010');
-- A second company with the same two founders, and a complimentary company (an internal founder).
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('71300000-0000-4000-8000-000000000020','Second company','71300000-0000-4000-8000-000000000001'),
	('71300000-0000-4000-8000-000000000030','Staff company','71300000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('71300000-0000-4000-8000-000000000020','71300000-0000-4000-8000-000000000001','notices-owner@example.test','Owner','owner'),
	('71300000-0000-4000-8000-000000000020','71300000-0000-4000-8000-000000000002','notice-founder-2@example.test','Founder 2','owner'),
	('71300000-0000-4000-8000-000000000030','71300000-0000-4000-8000-000000000005','notice-internal@example.test','Staff','owner');
select pg_temp.notice_folder(id) from unnest(array['71300000-0000-4000-8000-000000000020',
	'71300000-0000-4000-8000-000000000030']::uuid[]) id;
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

select pg_temp.notice_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated']) role_name,
	unnest(array['public.qorpera_claim_computer_hour_notices(integer,uuid)',
		'public.qorpera_complete_computer_hour_notice(uuid,uuid,text)',
		'public.qorpera_fail_computer_hour_notice(uuid,uuid,text,boolean)']) function_name;
select pg_temp.notice_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera\_computer\_hour\_%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The notice helpers (notice_month, notice_hours, queue_notice, notice_usage, queue_summaries) are callable by no API role');
select pg_temp.notice_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_notices', 'INSERT'),
	'Notices are written only by the database, not by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;

-- 1. Before the live switch nothing is queued, however much is used.
select pg_temp.use('71300000-0000-4000-8000-000000000010', 30000);
select pg_temp.notice_assert(not exists (select 1 from public.qorpera_computer_hour_notices), 'No notices in the dry run');

-- 2. Live. On free hours (5 h), "running low" goes to every founder once a month, under one hour left.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.use('71300000-0000-4000-8000-000000000010', 14000);
select pg_temp.notice_assert(pg_temp.notices('running_low') = '{}', 'Still 4000 s of 18000 left: no notice');
select pg_temp.use('71300000-0000-4000-8000-000000000010', 500);
select pg_temp.notice_assert(pg_temp.notices('running_low') = array['71300000-0000-4000-8000-000000000001',
	'71300000-0000-4000-8000-000000000002']::uuid[], 'Running low on free hours: every founder');
select pg_temp.notice_assert(details = jsonb_build_object('companyName', 'Hour notices', 'leftSeconds', 3500,
	'month', public.qorpera_computer_hour_notice_month(clock_timestamp()), 'hoursSeconds', 18000)
	and occasion = '71300000-0000-4000-8000-000000000010:' || public.qorpera_computer_hour_notice_month(clock_timestamp())
	and status = 'pending' and next_attempt_at > clock_timestamp() + interval '9 minutes',
	'What the notice says, sent ten minutes later: ' || details::text)
from public.qorpera_computer_hour_notices where kind = 'running_low' and user_id = '71300000-0000-4000-8000-000000000001';
select pg_temp.use('71300000-0000-4000-8000-000000000010', 100);
select pg_temp.notice_assert(cardinality(pg_temp.notices('running_low')) = 2, 'Once a month');

-- 3. Out of hours: once per time the company runs out, to every founder.
select pg_temp.use('71300000-0000-4000-8000-000000000010', 4000);
select pg_temp.notice_assert(pg_temp.notices('out_of_hours') = array['71300000-0000-4000-8000-000000000001',
	'71300000-0000-4000-8000-000000000002']::uuid[], 'Out of hours: every founder');
select pg_temp.use('71300000-0000-4000-8000-000000000010', 100);
select pg_temp.notice_assert(cardinality(pg_temp.notices('out_of_hours')) = 2, 'Once while it owes');
-- Credits arrive and repay what is owed; running out again is a new time.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '71300000-0000-4000-8000-000000000010', '71300000-0000-4000-8000-000000000001', 36000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.use('71300000-0000-4000-8000-000000000010', 35000);
select pg_temp.notice_assert(cardinality(pg_temp.notices('running_low')) = 2, 'Running low again this month: no second notice');
select pg_temp.use('71300000-0000-4000-8000-000000000010', 1000);
select pg_temp.notice_assert(cardinality(pg_temp.notices('out_of_hours')) = 4
	and (select count(distinct occasion) from public.qorpera_computer_hour_notices where kind = 'out_of_hours') = 2,
	'Running out again after hours arrived is a new notice');
-- A used-up pack is not part of "what pays now".
select pg_temp.notice_assert((public.qorpera_computer_hour_notice_hours('71300000-0000-4000-8000-000000000010',
	clock_timestamp())).hours_seconds = 0, 'Used-up credits and free hours count for nothing');

-- 4. Running low goes to the payers: here the founder who bought the credits in use.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '71300000-0000-4000-8000-000000000020', '71300000-0000-4000-8000-000000000002', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.use('71300000-0000-4000-8000-000000000020', 18000);
select pg_temp.use('71300000-0000-4000-8000-000000000020', 50000);
select pg_temp.notice_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000020') = '{}',
	'22000 s of 72000 left: more than a fifth');
select pg_temp.use('71300000-0000-4000-8000-000000000020', 8000);
select pg_temp.notice_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000020')
	= array['71300000-0000-4000-8000-000000000002']::uuid[], 'A fifth left: the credit buyer only');

-- 5. A company low on free hours whose founder then buys plenty: the notice is dropped before it goes.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('71300000-0000-4000-8000-000000000040','Topped-up company','71300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('71300000-0000-4000-8000-000000000040','71300000-0000-4000-8000-000000000001','notices-owner@example.test','Owner','owner');
select pg_temp.notice_folder('71300000-0000-4000-8000-000000000040');
select pg_temp.use('71300000-0000-4000-8000-000000000040', 16000);
select pg_temp.notice_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000040')
	= array['71300000-0000-4000-8000-000000000001']::uuid[], 'Low on free hours');
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '71300000-0000-4000-8000-000000000040', '71300000-0000-4000-8000-000000000001', 360000,
	clock_timestamp() + interval '12 months', false);

-- 5b. Running low goes to the founder whose plan pays, not to every founder.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('71300000-0000-4000-8000-000000000060','Plan company','71300000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('71300000-0000-4000-8000-000000000060','71300000-0000-4000-8000-000000000006','notice-plan-holder@example.test','Plan holder','owner'),
	('71300000-0000-4000-8000-000000000060','71300000-0000-4000-8000-000000000007','notice-founder-7@example.test','Founder 7','owner');
select pg_temp.notice_folder('71300000-0000-4000-8000-000000000060');
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '71300000-0000-4000-8000-000000000006', 36000, clock_timestamp() - interval '1 day',
	clock_timestamp() + interval '29 days', 'sub_T6:1', false);
select pg_temp.use('71300000-0000-4000-8000-000000000060', 18000);
select pg_temp.use('71300000-0000-4000-8000-000000000060', 28800);
select pg_temp.notice_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000060')
	= array['71300000-0000-4000-8000-000000000006']::uuid[], 'A fifth of the plan left: the plan holder only');

-- 5c. A company whose founder turns out to be on an internal account before the email goes.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('71300000-0000-4000-8000-000000000050','Soon staff company','71300000-0000-4000-8000-000000000008');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('71300000-0000-4000-8000-000000000050','71300000-0000-4000-8000-000000000008','notice-soon-staff@example.test','Soon staff','owner');
select pg_temp.notice_folder('71300000-0000-4000-8000-000000000050');
select pg_temp.use('71300000-0000-4000-8000-000000000050', 16000);
select pg_temp.notice_assert(pg_temp.notices('running_low', '71300000-0000-4000-8000-000000000050')
	= array['71300000-0000-4000-8000-000000000008']::uuid[], 'Low on free hours');

-- 5d. A complimentary company gets no notices.
select pg_temp.use('71300000-0000-4000-8000-000000000030', 100000);
select pg_temp.notice_assert(not exists (select 1 from public.qorpera_computer_hour_notices
	where profile_id = '71300000-0000-4000-8000-000000000030'), 'Complimentary: nothing');

-- 6. A summary for each used plan period that ended, listing each company's use; none for an unused one.
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '71300000-0000-4000-8000-000000000002', 74 * 3600, clock_timestamp() - interval '30 days',
		clock_timestamp() - interval '1 hour', 'sub_T2:1000', false),
	('plan_period', '71300000-0000-4000-8000-000000000001', 74 * 3600, clock_timestamp() - interval '33 days',
		clock_timestamp() - interval '3 days', 'sub_T3:1000', false);
-- Use two hours ago, inside the period (the switch is moved back so that use is live too).
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '3 hours';
select pg_temp.use('71300000-0000-4000-8000-000000000020', 3600, clock_timestamp() - interval '2 hours');
select pg_temp.notice_assert(public.qorpera_computer_hour_queue_summaries(clock_timestamp()) = 1
	and public.qorpera_computer_hour_queue_summaries(clock_timestamp()) = 0, 'One summary, once');
select pg_temp.notice_assert(user_id = '71300000-0000-4000-8000-000000000002' and profile_id is null
	and details -> 'companies' = '[{"companyName":"Second company","seconds":3600}]'::jsonb
	and (details ->> 'grantedSeconds')::bigint = 74 * 3600, 'The summary: ' || details::text)
from public.qorpera_computer_hour_notices where kind = 'monthly_summary' and status = 'pending';
select pg_temp.notice_assert((select status || ':' || last_error from public.qorpera_computer_hour_notices
	where kind = 'monthly_summary' and occasion = 'sub_T3:1000') = 'cancelled:The plan was not used',
	'An unused plan period is marked done, without an email');
-- A period that ended moments ago waits for the last meter pass.
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '71300000-0000-4000-8000-000000000001', 74 * 3600, clock_timestamp() - interval '30 days',
	clock_timestamp() - interval '1 minute', 'sub_T4:1000', false);
select pg_temp.notice_assert(public.qorpera_computer_hour_queue_summaries(clock_timestamp()) = 0
	and not exists (select 1 from public.qorpera_computer_hour_notices where occasion = 'sub_T4:1000'),
	'Not before ten minutes after the period ends');

-- 7. The worker. Notices that no longer hold are dropped at each claim, whether due or not: hours
-- arrived, an older time of owing, running low overtaken by running out, a company now
-- complimentary, a recipient no longer a founder or without an address, eight attempts made.
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '71300000-0000-4000-8000-000000000020' and user_id = '71300000-0000-4000-8000-000000000002';
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('71300000-0000-4000-8000-000000000008', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
insert into public.qorpera_computer_hour_notices (kind, user_id, occasion, details, status, attempt_count,
	lease_id, lease_expires_at) values
	('monthly_summary', '71300000-0000-4000-8000-000000000001', 'tried-8-times',
		'{}', 'delivering', 8, '71300000-0000-4000-8000-0000000000a9', clock_timestamp() - interval '1 second');
insert into public.qorpera_computer_hour_notices (kind, user_id, occasion, details) values
	('monthly_summary', '71300000-0000-4000-8000-0000000000ff', 'sub_T9:1000', '{}'),
	('monthly_summary', '71300000-0000-4000-8000-000000000009', 'sub_T8:1000', '{}');
create function pg_temp.notice(p_kind text, p_profile uuid, p_user uuid) returns text language sql as $$
	select string_agg(status || ':' || coalesce(last_error, ''), ',' order by created_at)
	from public.qorpera_computer_hour_notices where kind = p_kind and profile_id = p_profile and user_id = p_user
$$;
-- Nothing is sent before its ten minutes: the first claim leases only the summary, due at once.
select set_config('qorpera_test.early', public.qorpera_claim_computer_hour_notices(50,
	'71300000-0000-4000-8000-0000000000a0')::text, true);
select pg_temp.notice_assert(jsonb_array_length(current_setting('qorpera_test.early')::jsonb) = 1
	and current_setting('qorpera_test.early')::jsonb -> 0 ->> 'kind' = 'monthly_summary'
	and current_setting('qorpera_test.early')::jsonb -> 0 ->> 'recipientEmail' = 'notice-founder-2@example.test',
	'Only the summary is due now: ' || current_setting('qorpera_test.early'));
select pg_temp.notice_assert(
	(select count(*) from public.qorpera_computer_hour_notices where kind = 'out_of_hours' and status = 'cancelled'
		and last_error = 'Hours arrived before it was sent' and occasion = '71300000-0000-4000-8000-000000000010:0') = 2,
	'The first time of owing, repaid before it was sent, is dropped for both founders');
select pg_temp.notice_assert(pg_temp.notice('running_low', '71300000-0000-4000-8000-000000000010',
	'71300000-0000-4000-8000-000000000002') = 'cancelled:The company ran out before it was sent',
	'Running low overtaken by running out: dropped');
select pg_temp.notice_assert(pg_temp.notice('running_low', '71300000-0000-4000-8000-000000000040',
	'71300000-0000-4000-8000-000000000001') = 'cancelled:Hours arrived before it was sent', 'Low no more: dropped');
select pg_temp.notice_assert(pg_temp.notice('running_low', '71300000-0000-4000-8000-000000000050',
	'71300000-0000-4000-8000-000000000008') = 'cancelled:The company no longer pays for its hours',
	'Complimentary now: dropped');
-- One notice per calendar month the use fell in: the use two hours back (step 6) can be in the
-- month before, when the test runs just after a month begins in Danish time.
select pg_temp.notice_assert((select count(*) between 1 and 2
		and bool_and(status = 'failed' and last_error = 'The recipient is no longer a founder of the company')
	from public.qorpera_computer_hour_notices where kind = 'running_low'
		and profile_id = '71300000-0000-4000-8000-000000000020' and user_id = '71300000-0000-4000-8000-000000000002'),
	'A former founder gets no running-low email: ' || coalesce(pg_temp.notice('running_low',
		'71300000-0000-4000-8000-000000000020', '71300000-0000-4000-8000-000000000002'), 'none'));
select pg_temp.notice_assert((select status || ':' || last_error from public.qorpera_computer_hour_notices
	where occasion = 'tried-8-times') = 'failed:Gave up after eight attempts', 'Eight attempts, then no more');
select pg_temp.notice_assert((select string_agg(status || ':' || last_error, ',' order by occasion)
	from public.qorpera_computer_hour_notices where occasion in ('sub_T8:1000', 'sub_T9:1000'))
	= 'failed:The recipient has no email address,failed:The recipient has no email address', 'No address, blank or missing: failed');
-- A dropped "running low" frees its month: running low again is told.
select pg_temp.use('71300000-0000-4000-8000-000000000040', 290000);
select pg_temp.notice_assert(pg_temp.notice('running_low', '71300000-0000-4000-8000-000000000040',
	'71300000-0000-4000-8000-000000000001') = 'cancelled:Hours arrived before it was sent,pending:',
	'Running low again the same month, after a dropped notice, is told');

-- Ten minutes on (moved back here): the rest are leased once, with addresses.
update public.qorpera_computer_hour_notices set next_attempt_at = clock_timestamp() - interval '1 second'
where status = 'pending';
select set_config('qorpera_test.claim', public.qorpera_claim_computer_hour_notices(50,
	'71300000-0000-4000-8000-0000000000a1')::text, true);
select pg_temp.notice_assert((select array_agg(job ->> 'kind' || ':' || (job ->> 'recipientEmail') order by job ->> 'kind', job ->> 'recipientEmail')
	from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) job)
	= array['out_of_hours:notice-founder-2@example.test', 'out_of_hours:notices-owner@example.test',
		'running_low:notice-plan-holder@example.test', 'running_low:notices-owner@example.test'],
	'The current out of hours for both founders, and two running low: ' || current_setting('qorpera_test.claim'));
select pg_temp.notice_assert(public.qorpera_claim_computer_hour_notices(50, '71300000-0000-4000-8000-0000000000a2') = '[]',
	'Leased notices are not claimed twice');
select set_config('qorpera_test.first', current_setting('qorpera_test.claim')::jsonb -> 0 ->> 'noticeId', true);
select set_config('qorpera_test.second', current_setting('qorpera_test.claim')::jsonb -> 1 ->> 'noticeId', true);
select set_config('qorpera_test.third', current_setting('qorpera_test.claim')::jsonb -> 2 ->> 'noticeId', true);
select set_config('qorpera_test.fourth', current_setting('qorpera_test.claim')::jsonb -> 3 ->> 'noticeId', true);
select pg_temp.notice_assert(public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.first')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 're_1')
	and not public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.first')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 're_1'), 'Sent once');
select pg_temp.notice_assert(not public.qorpera_complete_computer_hour_notice(current_setting('qorpera_test.second')::uuid,
	'71300000-0000-4000-8000-0000000000a2', 're_2'), 'Another lease cannot complete it');
update public.qorpera_computer_hour_notices set attempt_count = 8 where id = current_setting('qorpera_test.fourth')::uuid;
select pg_temp.notice_assert(public.qorpera_fail_computer_hour_notice(current_setting('qorpera_test.second')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 'Resend 503', true)
	and public.qorpera_fail_computer_hour_notice(current_setting('qorpera_test.third')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 'Invalid recipient', false)
	and public.qorpera_fail_computer_hour_notice(current_setting('qorpera_test.fourth')::uuid,
	'71300000-0000-4000-8000-0000000000a1', 'Resend 503', true), 'Failures recorded');
select pg_temp.notice_assert(
	(select status = 'sent' and sent_at is not null and provider_message_id = 're_1' from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.first')::uuid)
	and (select status = 'retrying' and next_attempt_at > clock_timestamp() from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.second')::uuid)
	and (select status = 'failed' and last_error = 'Invalid recipient' from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.third')::uuid)
	and (select status = 'failed' from public.qorpera_computer_hour_notices
		where id = current_setting('qorpera_test.fourth')::uuid),
	'Sent; retrying later; failed for good; and failed on the eighth attempt even if retryable');
select pg_temp.notice_error($$select public.qorpera_claim_computer_hour_notices(0, '71300000-0000-4000-8000-0000000000a3')$$, '22023');
rollback;
