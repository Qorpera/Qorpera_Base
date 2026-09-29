-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 6a (20260928249200_runtime_computer_hours_zero_wait): at zero, new work
-- waits. Switched off, or before live payments, it changes nothing; switched on, a company with no
-- hours left starts no new run (wakes wait with a reason, routine slots are deferred, direct calls
-- are refused, a stray insert is stopped) until hours arrive, and a founder's plan renewal in
-- progress does not count as zero.

create function pg_temp.use(p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds)
$$;
create function pg_temp.at_zero() returns boolean language sql as $$
	select public.qorpera_company_at_zero('30000000-0000-4000-8000-000000000010', clock_timestamp())
$$;
create function pg_temp.routine_listed() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null, 500) -> 'items') item
		where item ->> 'routine_id' = current_setting('qorpera_test.routine')::jsonb ->> 'routine_id')
$$;
create function pg_temp.hours_read_waits() returns boolean language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_waits boolean;
begin
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
	v_waits := (public.qorpera_read_company_computer_hours('30000000-0000-4000-8000-000000000010') ->> 'waitingForHours')::boolean;
	perform set_config('request.jwt.claims', v_claims, true);
	return v_waits;
end
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_company_at_zero(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_zero_run_guard()']) function_name;
-- Every function that creates runs, lists or queues routine slots checks for zero; the three that pick
-- queued work check when picking and again before starting it, and the listing on both pages.
select pg_temp.wake_assert(count(*) = 9 and bool_and(checks.found = checks.expected),
	'Checks for zero: ' || string_agg(checks.fn || ' ' || checks.found || '/' || checks.expected, ', '))
from (
	select wanted.fn, wanted.expected,
		(length(pg_get_functiondef(wanted.fn::regprocedure))
			- length(replace(pg_get_functiondef(wanted.fn::regprocedure), 'qorpera_company_at_zero', '')))
			/ length('qorpera_company_at_zero') as found
	from (values
		('public.qorpera_materialize_wake_execution_runs(integer)', 1),
		('public.qorpera_materialize_session_execution_runs(integer)', 2),
		('public.qorpera_materialize_session_turn_requests(integer)', 2),
		('public.qorpera_materialize_company_proposal_review_runs(integer)', 2),
		('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)', 1),
		('public.qorpera_enqueue_runner_job(uuid,uuid,uuid,uuid,text,text,jsonb)', 1),
		('public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb)', 1),
		('public.qorpera_list_routine_schedule_heads(uuid,integer)', 2),
		('public.qorpera_read_company_computer_hours(uuid,date)', 1)
	) wanted(fn, expected)
) checks;

-- In the dry run (before live payments) nothing is ever at zero, even with the rule switched on.
select pg_temp.use(20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') < 0
	and not pg_temp.at_zero(), 'Dry-run balances never hold work');
update public.qorpera_computer_hour_billing set zero_rule_since = null;

-- Live payments: the company uses more than its free hours and has nothing left.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.use(20000);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') = -2000,
	'Live: the company has no hours left');

-- 1. Switched off: nothing waits. A routine wake is queued (not started yet).
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Switched off, no company is at zero');
select set_config('qorpera_test.routine', pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
	'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}')::text, true);
select set_config('qorpera_test.zero_wake',
	pg_temp.wake_schedule(current_setting('qorpera_test.routine')::jsonb, 'queued-before')::text, true);
select pg_temp.wake_assert(pg_temp.routine_listed(), 'Switched off, the due routine is listed');
select pg_temp.wake_assert(not pg_temp.hours_read_waits(), 'Switched off, members see no waiting');

-- 2. Switched on: the queued wake waits, with its reason, and no run starts.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(pg_temp.at_zero(), 'Switched on, the company is at zero');
do $$
declare v_runs bigint := (select count(*) from public.qorpera_execution_runs);
begin
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(8) = '[]'::jsonb, 'At zero, no run starts');
	perform pg_temp.wake_assert((select status = 'queued' and blocked_reason = 'Waiting for computer hours' and run_id is null
		from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid),
		'The wake waits and says why');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_execution_runs) = v_runs, 'No run was created');
end
$$;
-- The due routine is left out of the listing, so the orchestrator does not ask about it on every pass,
select pg_temp.wake_assert(not pg_temp.routine_listed(), 'At zero, the due routine is not listed');
-- and a slot asked for anyway is deferred, not queued: waiting work does not pile up.
do $$
declare v_last timestamptz := (select cursor.last_scheduled_for from public.qorpera_cloud_routine_schedule_cursors cursor
	where cursor.routine_id = (current_setting('qorpera_test.routine')::jsonb ->> 'routine_id')::uuid);
	v_wake uuid;
begin
	perform set_config('qorpera_test.at_zero_slot', clock_timestamp()::text, true);
	v_wake := pg_temp.wake_schedule(current_setting('qorpera_test.routine')::jsonb, 'at-zero',
		current_setting('qorpera_test.at_zero_slot')::timestamptz);
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_wake_occurrences where id = v_wake),
		'At zero, a routine slot queues no wake');
	perform pg_temp.wake_assert((select cursor.last_scheduled_for is not distinct from v_last
		from public.qorpera_cloud_routine_schedule_cursors cursor
		where cursor.routine_id = (current_setting('qorpera_test.routine')::jsonb ->> 'routine_id')::uuid),
		'The routine cursor stays, so the slot is offered again');
end
$$;

-- Members see why their work waits.
select pg_temp.wake_assert(pg_temp.hours_read_waits(), 'A member sees that the company waits for computer hours');
-- The direct calls cannot wait: refused with the reason.
select set_config('qorpera_test.substrate', (select version.id::text from public.qorpera_company_substrate_versions version
	join public.qorpera_company_files file on file.profile_id = version.profile_id and file.environment_id = version.environment_id
		and file.head_snapshot_id = version.company_snapshot_id
	where version.profile_id = '30000000-0000-4000-8000-000000000010'
		and version.environment_id = '30000000-0000-4000-8000-000000000020' limit 1), true);
select pg_temp.wake_assert(current_setting('qorpera_test.substrate', true) is not null, 'The fixture has a current substrate version');
select set_config('qorpera_test.base_run', (select to_jsonb(run) from public.qorpera_execution_runs run
	where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid)::text, true);
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error(format($$select public.qorpera_enqueue_runner_job('30000000-0000-4000-8000-000000000020', null, %L,
	extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}')$$, current_setting('qorpera_test.substrate')), '55000',
	'Waiting for computer hours: the company has none left');
select pg_temp.wake_error(format($$select public.qorpera_enqueue_execution_run(extensions.gen_random_uuid(),
	'30000000-0000-4000-8000-000000000020', null, 'manual', extensions.gen_random_uuid(), %L, %L, %s, %L, %s,
	'agent_turn', 'agent_turn', '{}')$$, current_setting('qorpera_test.substrate'),
	current_setting('qorpera_test.base_run')::jsonb ->> 'staff_agent_id', current_setting('qorpera_test.base_run')::jsonb ->> 'staff_version',
	current_setting('qorpera_test.base_run')::jsonb ->> 'sponsor_binding_id', current_setting('qorpera_test.base_run')::jsonb ->> 'sponsor_version'),
	'55000', 'Waiting for computer hours: the company has none left');
reset role;
select pg_temp.path_claims('service_role');

-- A path that creates a run without checking is stopped (the backstop).
select pg_temp.wake_error($$select pg_temp.wake_input_run(array[]::uuid[])$$, '55000',
	'Waiting for computer hours: no new run while the company has none left');

-- 3. A founder's plan renewal in progress (the period just ended, the next not recorded) is not zero.
insert into public.qorpera_computer_hour_subscriptions (stripe_subscription_id, user_id, livemode, item_key, status,
	period_start, period_end, event_created)
values ('sub_Renewing1', '30000000-0000-4000-8000-000000000001', true, 'basis', 'active',
	clock_timestamp() + interval '1 minute', clock_timestamp() + interval '30 days', clock_timestamp());
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, drawn_seconds, period_start, period_end,
	reference, dry_run)
values ('plan_period', '30000000-0000-4000-8000-000000000001', 3600, 3600, clock_timestamp() - interval '30 days',
	clock_timestamp() - interval '5 minutes', 'sub_Renewing1:1000', false);
select pg_temp.wake_assert(not pg_temp.at_zero(),
	'Renewal in progress: not at zero (the subscription already shows the new period, the hours are not recorded yet)');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '31 minutes'
where reference = 'sub_Renewing1:1000';
select pg_temp.wake_assert(pg_temp.at_zero(), 'Half an hour on without the renewal: at zero');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '5 minutes',
	withdrawn_at = clock_timestamp() where reference = 'sub_Renewing1:1000';
select pg_temp.wake_assert(pg_temp.at_zero(), 'A withdrawn plan period gives no grace');
update public.qorpera_computer_hour_sources set user_id = '30000000-0000-4000-8000-000000000002', withdrawn_at = null
where reference = 'sub_Renewing1:1000';
update public.qorpera_computer_hour_subscriptions set user_id = '30000000-0000-4000-8000-000000000002'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_company_founders('30000000-0000-4000-8000-000000000010') founder
		where founder.user_id = '30000000-0000-4000-8000-000000000002')
	and pg_temp.at_zero(), 'A contributor''s plan renewal gives no grace');
update public.qorpera_computer_hour_sources set user_id = '30000000-0000-4000-8000-000000000001'
where reference = 'sub_Renewing1:1000';
update public.qorpera_computer_hour_subscriptions set user_id = '30000000-0000-4000-8000-000000000001'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Back with the founder: grace again');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '5 minutes'
where reference = 'sub_Renewing1:1000';
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, drawn_seconds, period_start, period_end,
	reference, dry_run)
values ('plan_period', '30000000-0000-4000-8000-000000000001', 3600, 3600, clock_timestamp() - interval '5 minutes',
	clock_timestamp() + interval '30 days', 'sub_Renewing1:2000', false);
select pg_temp.wake_assert(pg_temp.at_zero(), 'The next period is recorded (and used up): no grace');
update public.qorpera_computer_hour_subscriptions set status = 'canceled' where stripe_subscription_id = 'sub_Renewing1';
delete from public.qorpera_computer_hour_sources where reference = 'sub_Renewing1:2000';
select pg_temp.wake_assert(pg_temp.at_zero(), 'A cancelled plan gives no grace');

-- 4. Hours arrive: the waiting wake starts by itself.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Hours arrived: not at zero');
do $$
begin
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(8)) = 1,
		'The waiting wake starts once hours arrive');
	perform pg_temp.wake_assert((select status = 'materialized' and blocked_reason is null
		from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid),
		'The wake is no longer waiting');
end
$$;
select pg_temp.wake_assert(pg_temp.routine_listed(), 'Hours arrived: the due routine is listed again');
do $$
declare v_wake uuid := pg_temp.wake_schedule(current_setting('qorpera_test.routine')::jsonb, 'at-zero',
	current_setting('qorpera_test.at_zero_slot')::timestamptz);
begin
	-- The same slot as at zero: accepted only because the cursor did not move past it.
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_wake_occurrences where id = v_wake),
		'Hours arrived: the deferred slot is offered again and queued');
end
$$;
select pg_temp.wake_assert(not pg_temp.hours_read_waits(), 'Hours arrived: members see no waiting');

-- 5. A complimentary company is never at zero.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.use(1000000);
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Complimentary: never at zero');
rollback;
