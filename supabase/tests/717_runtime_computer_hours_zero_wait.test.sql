-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 6a (20260929200000_runtime_computer_hours_zero_wait): at zero, new work
-- waits. Switched off it changes nothing; switched on, a company with no hours left starts no new
-- run (wakes wait with a reason, direct calls are refused, a stray insert is stopped) until hours
-- arrive, and a founder's plan renewal in progress does not count as zero.

create function pg_temp.use(p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds)
$$;
create function pg_temp.at_zero() returns boolean language sql as $$
	select public.qorpera_company_at_zero('30000000-0000-4000-8000-000000000010', clock_timestamp())
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_company_at_zero(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_zero_run_guard()']) function_name;

-- Every function that creates runs checks for zero (a stray path is caught by the backstop below).
select pg_temp.wake_assert(position('qorpera_company_at_zero' in pg_get_functiondef(p.oid)) > 0,
	p.proname || ' checks for zero')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('qorpera_materialize_wake_execution_runs',
	'qorpera_materialize_session_execution_runs', 'qorpera_materialize_session_turn_requests',
	'qorpera_materialize_company_proposal_review_runs', 'qorpera_enqueue_execution_run', 'qorpera_enqueue_runner_job',
	'qorpera_read_company_computer_hours');
select pg_temp.wake_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.proname in ('qorpera_materialize_session_execution_runs',
		'qorpera_materialize_session_turn_requests', 'qorpera_materialize_company_proposal_review_runs')
		and (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'qorpera_company_at_zero', '')))
			/ length('qorpera_company_at_zero') = 2) = 3,
	'Messages, turn requests and reviews check both when picking and again before starting');

-- The company has used more than its free hours: nothing left.
select pg_temp.use(20000);
select pg_temp.wake_assert(public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010') < 0,
	'The company has no hours left');

-- 1. Switched off: nothing waits. (The wake materializer answers the control plane.)
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Switched off, no company is at zero');
savepoint switched_off;
do $$
declare v_routine jsonb; v_wake uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}');
	v_wake := pg_temp.wake_schedule(v_routine, 'off-1');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1)) = 1,
		'Switched off, the wake starts');
end
$$;
rollback to switched_off;

-- 2. Switched on: the wake waits, with its reason, and no run starts.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(pg_temp.at_zero(), 'Switched on, the company is at zero');
do $$
declare v_routine jsonb; v_wake uuid; v_runs bigint := (select count(*) from public.qorpera_execution_runs);
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}');
	v_wake := pg_temp.wake_schedule(v_routine, 'on-1');
	perform set_config('qorpera_test.zero_wake', v_wake::text, true);
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(8) = '[]'::jsonb, 'At zero, no run starts');
	perform pg_temp.wake_assert((select status = 'queued' and blocked_reason = 'Waiting for computer hours' and run_id is null
		from public.qorpera_wake_occurrences where id = v_wake), 'The wake waits, and says why');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_execution_runs) = v_runs, 'No run was created');
end
$$;

-- Members see why their work waits.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert((public.qorpera_read_company_computer_hours('30000000-0000-4000-8000-000000000010') ->> 'waitingForHours')::boolean,
	'A member sees that the company waits for computer hours');
-- A direct call cannot wait: refused with the reason.
select pg_temp.wake_error($$select public.qorpera_enqueue_runner_job('30000000-0000-4000-8000-000000000020', null, null,
	extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}')$$, '55000',
	'Waiting for computer hours: the company has none left');
reset role;
select pg_temp.path_claims('service_role');

-- A path that creates a run without checking is stopped (the backstop).
select pg_temp.wake_error($$select pg_temp.wake_input_run(array[]::uuid[])$$, '55000',
	'Waiting for computer hours: no new run while the company has none left');

-- 3. A founder's plan renewal in progress (its recorded period just ended) is not zero.
insert into public.qorpera_computer_hour_subscriptions (stripe_subscription_id, user_id, livemode, item_key, status,
	period_start, period_end, event_created)
values ('sub_Renewing1', '30000000-0000-4000-8000-000000000001', true, 'basis', 'active',
	clock_timestamp() - interval '30 days', clock_timestamp() - interval '5 minutes', clock_timestamp());
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Renewal in progress: not at zero');
update public.qorpera_computer_hour_subscriptions set period_end = clock_timestamp() - interval '31 minutes'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.wake_assert(pg_temp.at_zero(), 'Half an hour on without the renewal: at zero');
update public.qorpera_computer_hour_subscriptions set status = 'canceled', period_end = clock_timestamp() - interval '5 minutes'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.wake_assert(pg_temp.at_zero(), 'A cancelled plan gives no grace');

-- 4. Hours arrive: the waiting wake starts by itself.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', true);
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

-- 5. A complimentary company is never at zero.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.use(1000000);
select pg_temp.wake_assert(not pg_temp.at_zero(), 'Complimentary: never at zero');
rollback;
