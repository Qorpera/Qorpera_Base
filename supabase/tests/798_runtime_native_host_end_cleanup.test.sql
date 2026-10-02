-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-2a (20260929999600): when a job ends, its presence device is deleted and its screen leases are expired past the
-- office supervisor's 30 s grace, so the supervisor's next poll releases them as it releases an abandoned lease. Only
-- the ending job's own binding is touched. The office setup is 405's: a real office and screen lease for test 300's
-- run; only guest readiness is synthetic.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'30000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
reset role;
create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
-- Synthetic guest readiness only. This is not a provider or Linux test.
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select set_config('qorpera_test.binding',(current_setting('qorpera_test.office_lease')::jsonb->'binding')::text,true);
reset role;


create function pg_temp.screen() returns public.qorpera_runtime_office_screens language sql as $$
	select * from public.qorpera_runtime_office_screens where id=(current_setting('qorpera_test.binding')::jsonb->>'screenId')::uuid
$$;
create function pg_temp.supervisor() returns jsonb language sql as $$
	select public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint)
$$;
create function pg_temp.devices() returns bigint language sql as $$
	select count(*) from public.qorpera_native_presence_devices
	where run_id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid
$$;
create function pg_temp.end_job() returns void language sql as $$
	select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.wake_binding')::jsonb->>'jobId')::uuid,
		'failed','G2-2a: the runner was revoked',false)::text::void
$$;
-- The run's presence device, as the host registers it.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_native_presence_register(current_setting('qorpera_test.wake_binding')::jsonb,
	'7e2a0000-0000-4000-8000-000000000001','MCowBQYDK2VwAyEA'||repeat('A',43)||'=');
reset role;

-- 1. While the job runs: the device is there, and the screen is leased to the run.
select pg_temp.wake_assert(pg_temp.devices()=1,'the run has its presence device');
select pg_temp.wake_assert((select lease_id is not null and run_id::text=current_setting('qorpera_test.wake_binding')::jsonb->>'runId'
	and lease_expires_at>clock_timestamp() from pg_temp.screen()),'the screen is leased to the run');
select set_config('qorpera_test.epoch',(pg_temp.screen()).epoch::text,true);

-- 2. Another job's binding of the same run is left alone (the trigger matches the ending job's own).
savepoint other_job;
update public.qorpera_native_presence_devices set binding=binding||'{"jobId":"7e2a0000-0000-4000-8000-0000000000ff"}'
where run_id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
update public.qorpera_runtime_office_screens set native_binding=native_binding||'{"jobId":"7e2a0000-0000-4000-8000-0000000000ff"}'
where id=(pg_temp.screen()).id;
select pg_temp.end_job();
select pg_temp.wake_assert(pg_temp.devices()=1,'another job''s device stays');
select pg_temp.wake_assert((select lease_expires_at>clock_timestamp() from pg_temp.screen()),'another job''s screen lease stays');
rollback to savepoint other_job;

-- 3. The job ends (a revoked runner): its device is gone at once, and its screen lease is past the supervisor's
--    grace but not yet cleared; the connection lease ends as before.
select pg_temp.end_job();
select pg_temp.wake_assert(pg_temp.devices()=0,'the ended job''s presence device is deleted');
select pg_temp.wake_assert((select lease_id is not null and lease_expires_at<=clock_timestamp()-interval '30 seconds'
	and epoch=current_setting('qorpera_test.epoch')::bigint from pg_temp.screen()),'the ended job''s screen lease is expired past the grace');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_native_provider_connection_leases
	where job_id=(current_setting('qorpera_test.wake_binding')::jsonb->>'jobId')::uuid and status='active'),'the connection lease ends as before');

-- 4. The supervisor's next poll releases the screen as an abandoned lease: cleared under a new epoch, free again.
set local role service_role;
select set_config('qorpera_test.reaped',pg_temp.supervisor()::text,true);
reset role;
select pg_temp.wake_assert((select lease_id is null and run_id is null and lease_expires_at is null and native_binding is null
	and not drain_pending and epoch=current_setting('qorpera_test.epoch')::bigint+1 from pg_temp.screen()),
	'the supervisor releases the ended job''s screen under a new epoch');
select pg_temp.wake_assert(current_setting('qorpera_test.reaped')::jsonb->'drains'='[]'::jsonb,'no unresolved work, no drain');

-- 5. The trigger's body carries its marker (the release's deploy guard reads it).
select pg_temp.wake_assert(prosrc like '%20260929999600%','the end-of-job trigger is this version')
from pg_proc where oid='public.qorpera_terminalize_native_provider_lease()'::regprocedure;

rollback;
