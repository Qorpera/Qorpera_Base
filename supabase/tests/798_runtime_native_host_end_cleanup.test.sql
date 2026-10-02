-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-2a (20260929999600): when a job leaves 'leased' (it ends, or goes back to the queue), its presence device is deleted
-- as that transaction commits (a deferred constraint trigger), and the office supervisor's next poll releases its
-- screen leases at once, as it releases an abandoned lease. Only the ended job's own binding is touched. The office setup is 405's: a real office and screen lease for
-- test 300's run; only guest readiness is synthetic.
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
create function pg_temp.supervisor() returns jsonb language plpgsql as $$
declare v_status jsonb;
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	v_status:=public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint);
	perform set_config('request.jwt.claims','',true);
	return v_status;
end $$;
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

-- 1. While the job runs: the device is there, the screen is leased to the run, and the supervisor leaves a live
--    lease of a leased job alone.
select pg_temp.wake_assert(pg_temp.devices()=1,'the run has its presence device');
select set_config('qorpera_test.epoch',(pg_temp.screen()).epoch::text,true);
select pg_temp.supervisor();
select pg_temp.wake_assert((select lease_id is not null and run_id::text=current_setting('qorpera_test.wake_binding')::jsonb->>'runId'
	and epoch=current_setting('qorpera_test.epoch')::bigint from pg_temp.screen()),'a running job''s screen stays leased');

-- 2. The device's cleanup waits for the ending's commit: a deferrable trigger, deferred by default.
select pg_temp.wake_assert((select tgdeferrable and tginitdeferred from pg_trigger
	where tgname='qorpera_native_presence_end' and tgrelid='public.qorpera_runner_jobs'::regclass),
	'the device cleanup runs at commit');

-- 3. Another job's device of the same run is left alone.
savepoint other_job;
update public.qorpera_native_presence_devices set binding=binding||'{"jobId":"7e2a0000-0000-4000-8000-0000000000ff"}'
where run_id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
select pg_temp.end_job();
set constraints qorpera_native_presence_end immediate;
select pg_temp.wake_assert(pg_temp.devices()=1,'another job''s device stays');
rollback to savepoint other_job;

-- 4. A job that goes back to the queue for another attempt leaves 'leased' too: its device goes at commit, so the
--    next attempt can register its own.
savepoint requeued;
update public.qorpera_runner_jobs set status='queued', lease_token_sha256=null, lease_expires_at=null
where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'jobId')::uuid;
set constraints qorpera_native_presence_end immediate;
select pg_temp.wake_assert(pg_temp.devices()=0,'a requeued job''s presence device is deleted');
rollback to savepoint requeued;

-- 5. The job ends (a revoked runner): its device stays until the ending commits, then it is gone.
select pg_temp.end_job();
select pg_temp.wake_assert(pg_temp.devices()=1,'the device waits for the ending''s commit');
set constraints qorpera_native_presence_end immediate;
select pg_temp.wake_assert(pg_temp.devices()=0,'the ended job''s presence device is deleted');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_native_provider_connection_leases
	where job_id=(current_setting('qorpera_test.wake_binding')::jsonb->>'jobId')::uuid and status='active'),'the connection lease ends as before');

-- 6. The ending itself leaves the screen as it was; the supervisor's next poll releases the live lease of the ended
--    job at once, as an abandoned lease: cleared under a new epoch, free again.
select pg_temp.wake_assert((select lease_id is not null and lease_expires_at>clock_timestamp() from pg_temp.screen()),
	'the ending takes no screen');
select set_config('qorpera_test.reaped',pg_temp.supervisor()::text,true);
select pg_temp.wake_assert((select lease_id is null and run_id is null and lease_expires_at is null and native_binding is null
	and not drain_pending and epoch=current_setting('qorpera_test.epoch')::bigint+1 from pg_temp.screen()),
	'the supervisor releases the ended job''s screen under a new epoch');
select pg_temp.wake_assert(current_setting('qorpera_test.reaped')::jsonb->'drains'='[]'::jsonb,'no unresolved work, no drain');

-- 7. A live lease that names no job (or a malformed one) is not released early.
savepoint no_job;
set local session_replication_role = replica;
update public.qorpera_runtime_office_screens set lease_id=extensions.gen_random_uuid(),run_id=extensions.gen_random_uuid(),
	lease_expires_at=clock_timestamp()+interval '1 minute',grant_version=1,native_binding='{"jobId":"not-a-job"}'
where id=(pg_temp.screen()).id;
set local session_replication_role = origin;
select pg_temp.supervisor();
select pg_temp.wake_assert((select lease_id is not null from pg_temp.screen()),'a lease without a job id is left to its expiry');
rollback to savepoint no_job;

-- 8. Both bodies carry the marker (the release's deploy guards read it).
select pg_temp.wake_assert(count(*)=2,'both functions are this version')
from pg_proc where oid in ('public.qorpera_native_presence_end()'::regprocedure,
	'public.qorpera_runtime_office_supervisor_status(jsonb,bigint)'::regprocedure) and prosrc like '%20260929999600%';

rollback;
