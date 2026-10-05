-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Computer hours, build step 6a (20260928249200_runtime_computer_hours_zero_wait), on the folder-v2 runtime base (ported
-- from snapshot-v1 in the legacy sweep): a member's message to an agent in a company at zero starts no run. The post is
-- taken and its wake waits in the queue: the due list leaves the company out and the folder materializer answers at_zero,
-- writing nothing; once hours arrive the company is due again and the waiting post becomes a run by itself.

create function pg_temp.zm_due() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_folder_materialize_due(null, 500) -> 'items') as item(value)
		where item.value ->> 'profile_id' = '92400000-0000-4000-8000-000000000010')
$$;
create function pg_temp.zm_runs() returns bigint language sql as $$
	select count(*) from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010'
$$;

-- Live payments; the company has used more than its free hours; the zero rule is on and the sweep has recorded it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'The sweep records the company');
select pg_temp.base_assert(public.qorpera_company_at_zero('92400000-0000-4000-8000-000000000010', clock_timestamp()),
	'The company is at zero');

-- 1. At zero, the owner's message to Bob is taken, and starts no run: it waits in the queue, neither started nor failed.
select set_config('qorpera_test.zero_wake', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000031', 'Please look at the plan.') ->> 0, true);
do $$
declare v_runs bigint := pg_temp.zm_runs(); v_pass jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.zero_wake', true) is not null, 'The post woke Bob');
	perform pg_temp.base_assert(not pg_temp.zm_due(), 'At zero the company is not due');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass = '{"state":"at_zero"}', 'At zero the materializer starts nothing: ' || v_pass::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.run_id is null and v_wake.finished_at is null
		and v_wake.blocked_reason is null and v_wake.staff_agent_id = '92400000-0000-4000-8000-000000000031',
		'The message waits in the queue, neither started nor failed: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(pg_temp.zm_runs() = v_runs, 'No run was created');
end
$$;

-- 2. Hours arrive: the company is due again, and the waiting message starts by itself.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
select 'credit', '92400000-0000-4000-8000-000000000010', founder.user_id, 72000, clock_timestamp() + interval '12 months', false
from public.qorpera_company_founders('92400000-0000-4000-8000-000000000010') founder
limit 1;
do $$
declare v_pass jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(not public.qorpera_company_at_zero('92400000-0000-4000-8000-000000000010', clock_timestamp()),
		'Hours arrived: not at zero');
	perform pg_temp.base_assert(pg_temp.zm_due(), 'Hours arrived: the company is due');
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.zero_wake')::uuid;
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and v_pass -> 'run_ids' = jsonb_build_array(v_wake.run_id)
		and v_wake.status = 'materialized' and v_wake.blocked_reason is null,
		'Once hours arrive the waiting message starts: ' || v_pass::text || ' ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert((select source_kind = 'room_delivery' and source_id = v_wake.id and staff_agent_id = v_wake.staff_agent_id
		from public.qorpera_execution_runs where id = v_wake.run_id), 'The waiting message is the one that started');
end
$$;
rollback;
