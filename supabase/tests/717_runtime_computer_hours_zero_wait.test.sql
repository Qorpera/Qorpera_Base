-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Computer hours, build step 6a (20260928249200_runtime_computer_hours_zero_wait), on the folder-v2 runtime base (ported
-- from snapshot-v1 in the legacy sweep): at zero, new work waits. Switched off, or before live payments, it changes
-- nothing; switched on, a company with no hours left starts no new run (the due list leaves it out and the folder
-- materializer answers at_zero, so a queued routine wake waits; routine slots are deferred; a stray insert is stopped)
-- until hours arrive, and a founder's plan renewal in progress does not count as zero. (The legacy direct enqueue calls
-- need a snapshot-v1 substrate; they are not ported.)

create function pg_temp.zw_use(p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds)
$$;
create function pg_temp.zw_at_zero() returns boolean language sql as $$
	select public.qorpera_company_at_zero('92400000-0000-4000-8000-000000000010', clock_timestamp())
$$;
create function pg_temp.zw_due() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_folder_materialize_due(null, 500) -> 'items') as item(value)
		where item.value ->> 'profile_id' = '92400000-0000-4000-8000-000000000010')
$$;
create function pg_temp.zw_routine_listed() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null, 500) -> 'items') item
		where item ->> 'routine_id' = '71700000-0000-4000-8000-0000000000e1')
$$;
create function pg_temp.zw_waits() returns boolean language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_waits boolean;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	v_waits := (public.qorpera_read_company_computer_hours('92400000-0000-4000-8000-000000000010') ->> 'waitingForHours')::boolean;
	perform set_config('request.jwt.claims', v_claims, true);
	return v_waits;
end
$$;
-- The scheduler queues a slot of Carol's routine (its folder mode): the slot five minutes ago unless told otherwise, due
-- again at the slot's time plus five minutes.
create function pg_temp.zw_schedule(p_key text, p_at timestamptz default null) returns jsonb language plpgsql as $$
declare v_at timestamptz := coalesce(p_at, statement_timestamp() - interval '5 minutes');
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	select * into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = '71700000-0000-4000-8000-0000000000e1' and routine_version = 1;
	return public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(), p_key,
		v_cursor.trigger_id, v_at, v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
end
$$;

select pg_temp.base_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_company_at_zero(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_zero_run_guard()']) function_name;
-- The routine listing reads the zero state (on both pages), with no full check.
select pg_temp.base_assert((length(pg_get_functiondef('public.qorpera_list_routine_schedule_heads(uuid,integer)'::regprocedure))
	- length(replace(pg_get_functiondef('public.qorpera_list_routine_schedule_heads(uuid,integer)'::regprocedure),
		'qorpera_computer_hour_zero_state', ''))) / length('qorpera_computer_hour_zero_state') = 2,
	'The routine listing reads the zero state on both pages');
-- Every folder-v2 function that creates runs or queues routine slots checks for zero (the listing reads the zero state
-- instead, above): the due list and the company's materializer, which checks before it locks anything, and the routine
-- slot's folder mode.
select pg_temp.base_assert(count(*) = 5 and bool_and(checks.found = checks.expected),
	'Checks for zero: ' || string_agg(checks.fn || ' ' || checks.found || '/' || checks.expected, ', '))
from (
	select wanted.fn, wanted.expected,
		(length(pg_get_functiondef(wanted.fn::regprocedure))
			- length(replace(pg_get_functiondef(wanted.fn::regprocedure), 'qorpera_company_at_zero', '')))
			/ length('qorpera_company_at_zero') as found
	from (values
		('public.qorpera_folder_materialize_due(uuid,integer)', 1),
		('public.qorpera_folder_materialize_company(uuid,integer)', 1),
		('public.qorpera_folder_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb)', 1),
		('public.qorpera_list_routine_schedule_heads(uuid,integer)', 0),
		('public.qorpera_read_company_computer_hours(uuid,date)', 1)
	) wanted(fn, expected)
) checks;

-- The owner gives Carol a routine (a routine file, paid by the owner's login); the scheduler has not fired it yet.
select pg_temp.base_commit(pg_temp.base_owner(), 'zero-routine', jsonb_build_array(pg_temp.base_write(
	'agents/carol/routines/tick.md', 'routine',
	E'---\n' || '{"kind":"routine","id":"71700000-0000-4000-8000-0000000000e1","title":"Tick","status":"active","trigger":{"when":"every","minutes":60,"starts":null},"timezone":null,"ends":null,"runs":null,"quiet":null,"effort":"medium","reply":"optional","conclusion":null,"instructions":"Look at the numbers."}' || E'\n---\n',
	'{"kind":"routine","id":"71700000-0000-4000-8000-0000000000e1","title":"Tick","status":"active","trigger":{"when":"every","minutes":60,"starts":null},"timezone":null,"ends":null,"runs":null,"quiet":null,"effort":"medium","reply":"optional","conclusion":null,"instructions":"Look at the numbers."}'))) \g /dev/null
select pg_temp.base_assert(routine.status = 'active' and version.staff_agent_id = '92400000-0000-4000-8000-000000000032'
	and version.sponsor_binding_id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,
	'Carol''s routine, paid by the owner: ' || to_jsonb(routine)::text)
from public.qorpera_cloud_routines routine
join public.qorpera_cloud_routine_versions version on version.routine_id = routine.id and version.version = routine.current_version
where routine.id = '71700000-0000-4000-8000-0000000000e1';

-- In the dry run (before live payments) nothing is ever at zero, even with the rule switched on.
select pg_temp.zw_use(20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.base_assert(public.qorpera_company_computer_hours_left('92400000-0000-4000-8000-000000000010') < 0
	and not pg_temp.zw_at_zero(), 'Dry-run balances never hold work');
update public.qorpera_computer_hour_billing set zero_rule_since = null;

-- Live payments: the company uses more than its free hours and has nothing left.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.zw_use(20000);
select pg_temp.base_assert(public.qorpera_company_computer_hours_left('92400000-0000-4000-8000-000000000010') = -2000,
	'Live: the company has no hours left');

-- 1. Switched off: nothing waits. A routine wake is queued (not started yet), and the company is due.
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(not pg_temp.zw_at_zero(), 'Switched off, no company is at zero');
select set_config('qorpera_test.zero_wake', pg_temp.zw_schedule('queued-before') ->> 'occurrence_id', true);
select pg_temp.base_assert((select status = 'queued' and staff_agent_id = '92400000-0000-4000-8000-000000000032'
	from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid), 'The routine wake is queued');
select pg_temp.base_assert(pg_temp.zw_due(), 'Switched off, the company with the queued wake is due');
select pg_temp.base_assert(pg_temp.zw_routine_listed(), 'Switched off, the due routine is listed');
select pg_temp.base_assert(not pg_temp.zw_waits(), 'Switched off, members see no waiting');

-- 2. Switched on: the queued wake waits and no run starts.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
-- Recorded at zero by the next sweep (after each meter pass): until then work still starts.
select pg_temp.base_assert(not pg_temp.zw_at_zero(), 'Not recorded yet: not at zero');
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'Recorded');
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'Switched on, the company is at zero');
do $$
declare v_runs bigint := (select count(*) from public.qorpera_execution_runs); v_pass jsonb;
begin
	perform pg_temp.base_assert(not pg_temp.zw_due(), 'At zero, the company is not due');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass = '{"state":"at_zero"}', 'At zero, no run starts: ' || v_pass::text);
	perform pg_temp.base_assert((select status = 'queued' and run_id is null and blocked_reason is null
		from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid),
		'The wake waits, untouched');
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_runs) = v_runs, 'No run was created');
end
$$;
-- The due routine is left out of the listing, so the orchestrator does not ask about it on every pass,
select pg_temp.base_assert(not pg_temp.zw_routine_listed(), 'At zero, the due routine is not listed');
-- and a slot asked for anyway is deferred, not queued: waiting work does not pile up.
do $$
declare v_last timestamptz := (select cursor.last_scheduled_for from public.qorpera_cloud_routine_schedule_cursors cursor
	where cursor.routine_id = '71700000-0000-4000-8000-0000000000e1');
	v_slot jsonb;
begin
	perform set_config('qorpera_test.at_zero_slot', clock_timestamp()::text, true);
	v_slot := pg_temp.zw_schedule('at-zero', current_setting('qorpera_test.at_zero_slot')::timestamptz);
	perform pg_temp.base_assert(v_slot ->> 'status' = 'deferred' and v_slot ->> 'reason' = 'Waiting for computer hours'
		and v_slot -> 'occurrence_id' = 'null'::jsonb, 'At zero, a routine slot is deferred: ' || v_slot::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences
		where routine_id = '71700000-0000-4000-8000-0000000000e1' and occurrence_key = 'at-zero'),
		'At zero, a routine slot queues no wake');
	perform pg_temp.base_assert((select cursor.last_scheduled_for is not distinct from v_last
		from public.qorpera_cloud_routine_schedule_cursors cursor
		where cursor.routine_id = '71700000-0000-4000-8000-0000000000e1'),
		'The routine cursor stays, so the slot is offered again');
end
$$;

-- Members see why their work waits.
select pg_temp.base_assert(pg_temp.zw_waits(), 'A member sees that the company waits for computer hours');

-- A path that creates a run without checking is stopped (the backstop): a second folder-v2 run like Alice's (the folder
-- clock's pin, no substrate), with its own job, built by hand.
create function pg_temp.zw_stray_run() returns void language plpgsql as $$
declare v_base public.qorpera_execution_runs; v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, session_id, client_job_id, required_capability, job_type,
		payload, created_by_user_id)
	values (v_job, v_base.profile_id, v_base.environment_id, v_base.session_id, v_job, 'agent_turn', 'agent_turn', '{}',
		v_base.requested_by_user_id);
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(null::public.qorpera_execution_runs, to_jsonb(v_base)
		|| jsonb_build_object('id', v_run, 'job_id', v_job, 'source_id', v_run, 'created_at', clock_timestamp()))).*;
end
$$;
select pg_temp.base_error('select pg_temp.zw_stray_run()', '55000',
	'Waiting for computer hours: no new run while the company has none left');

-- 3. A founder's plan renewal in progress (the period just ended, the next not recorded) is not zero.
insert into public.qorpera_computer_hour_subscriptions (stripe_subscription_id, user_id, livemode, item_key, status,
	period_start, period_end, event_created)
values ('sub_Renewing1', '92400000-0000-4000-8000-000000000001', true, 'basis', 'active',
	clock_timestamp() + interval '1 minute', clock_timestamp() + interval '30 days', clock_timestamp());
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, drawn_seconds, period_start, period_end,
	reference, dry_run)
values ('plan_period', '92400000-0000-4000-8000-000000000001', 3600, 3600, clock_timestamp() - interval '30 days',
	clock_timestamp() - interval '5 minutes', 'sub_Renewing1:1000', false);
select pg_temp.base_assert(not pg_temp.zw_at_zero(),
	'Renewal in progress: not at zero (the subscription already shows the new period, the hours are not recorded yet)');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '31 minutes'
where reference = 'sub_Renewing1:1000';
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'Half an hour on without the renewal: at zero');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '5 minutes',
	withdrawn_at = clock_timestamp() where reference = 'sub_Renewing1:1000';
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'A withdrawn plan period gives no grace');
update public.qorpera_computer_hour_sources set user_id = '92400000-0000-4000-8000-000000000002', withdrawn_at = null
where reference = 'sub_Renewing1:1000';
update public.qorpera_computer_hour_subscriptions set user_id = '92400000-0000-4000-8000-000000000002'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.base_assert(not exists (select 1 from public.qorpera_company_founders('92400000-0000-4000-8000-000000000010') founder
		where founder.user_id = '92400000-0000-4000-8000-000000000002')
	and pg_temp.zw_at_zero(), 'A contributor''s plan renewal gives no grace');
update public.qorpera_computer_hour_sources set user_id = '92400000-0000-4000-8000-000000000001'
where reference = 'sub_Renewing1:1000';
update public.qorpera_computer_hour_subscriptions set user_id = '92400000-0000-4000-8000-000000000001'
where stripe_subscription_id = 'sub_Renewing1';
select pg_temp.base_assert(not pg_temp.zw_at_zero(), 'Back with the founder: grace again');
update public.qorpera_computer_hour_sources set period_end = clock_timestamp() - interval '5 minutes'
where reference = 'sub_Renewing1:1000';
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, drawn_seconds, period_start, period_end,
	reference, dry_run)
values ('plan_period', '92400000-0000-4000-8000-000000000001', 3600, 3600, clock_timestamp() - interval '5 minutes',
	clock_timestamp() + interval '30 days', 'sub_Renewing1:2000', false);
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'The next period is recorded (and used up): no grace');
update public.qorpera_computer_hour_subscriptions set status = 'canceled' where stripe_subscription_id = 'sub_Renewing1';
delete from public.qorpera_computer_hour_sources where reference = 'sub_Renewing1:2000';
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'A cancelled plan gives no grace');

-- 4. Hours arrive: the company is due again and the waiting wake starts by itself.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.base_assert(not pg_temp.zw_at_zero(), 'Hours arrived: not at zero');
do $$
declare v_pass jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(pg_temp.zw_due(), 'Hours arrived: the company is due');
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid;
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and v_pass -> 'run_ids' = jsonb_build_array(v_wake.run_id),
		'The waiting wake starts once hours arrive: ' || v_pass::text);
	perform pg_temp.base_assert(v_wake.status = 'materialized' and v_wake.blocked_reason is null,
		'The wake is no longer waiting: ' || to_jsonb(v_wake)::text);
end
$$;
-- The listing reads the zero state only: the routine comes back with the next sweep.
select pg_temp.base_assert(not pg_temp.zw_routine_listed(), 'Until the next sweep, the routine stays out of the listing');
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'cleared' = '1', 'The sweep clears it');
select pg_temp.base_assert(pg_temp.zw_routine_listed(), 'Hours arrived: the due routine is listed again');
do $$
declare v_slot jsonb := pg_temp.zw_schedule('at-zero', current_setting('qorpera_test.at_zero_slot')::timestamptz);
begin
	-- The same slot as at zero: accepted only because the cursor did not move past it.
	perform pg_temp.base_assert(v_slot ->> 'status' = 'queued' and exists (select 1 from public.qorpera_wake_occurrences
		where id = (v_slot ->> 'occurrence_id')::uuid and occurrence_key = 'at-zero'),
		'Hours arrived: the deferred slot is offered again and queued: ' || v_slot::text);
end
$$;
select pg_temp.base_assert(not pg_temp.zw_waits(), 'Hours arrived: members see no waiting');

-- 5. A complimentary company is never at zero, even while still recorded there.
select pg_temp.zw_use(1000000);
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero again');
select pg_temp.base_assert(pg_temp.zw_at_zero(), 'Recorded: at zero');
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('92400000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.base_assert(not pg_temp.zw_at_zero(), 'Complimentary: never at zero');
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'cleared' = '1',
	'And the sweep clears it');
rollback;
