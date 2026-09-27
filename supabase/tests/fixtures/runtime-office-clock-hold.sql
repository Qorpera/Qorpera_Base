-- Used by test-runtime-office-registry.mjs right after the registry setup part.
-- Wall-clock time is not under test in these cases. The fixture run's native
-- lease, job and assignment last two minutes, its runner session 15 minutes and
-- a screen lease at most 30 seconds, and a loaded machine can spend that long
-- inside one case. Cases that test expiry move a deadline into the past
-- explicitly; none waits for one to pass. So the fixture run's deadlines are
-- held an hour out, and every screen lease that office_call admits is held too.
-- The leases callers see are unchanged: validForMs stays capped at 30 seconds.
with held as (update public.qorpera_native_provider_connection_leases set expires_at=clock_timestamp()+interval '1 hour'
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'leaseId')::uuid returning 1)
select pg_temp.wake_assert(count(*)=1,'clock hold: native lease') from held;
with held as (update public.qorpera_runner_jobs set lease_expires_at=clock_timestamp()+interval '1 hour'
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'jobId')::uuid returning 1)
select pg_temp.wake_assert(count(*)=1,'clock hold: job lease') from held;
with held as (update public.qorpera_runner_assignments set expires_at=clock_timestamp()+interval '1 hour'
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'assignmentId')::uuid returning 1)
select pg_temp.wake_assert(count(*)=1,'clock hold: assignment') from held;
with held as (update public.qorpera_runners set session_expires_at=clock_timestamp()+interval '1 hour'
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid returning 1)
select pg_temp.wake_assert(count(*)=1,'clock hold: runner session') from held;
-- The screen row is private to its owner, so the hold runs as the fixture
-- owner, while office_call itself still calls the office as the gateway role.
-- Only a live lease is held; an expired one is never revived.
create function pg_temp.office_hold(p_result jsonb) returns jsonb language sql security definer as $$
	update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()+interval '1 hour'
	where lease_id=(p_result#>>'{lease,leaseId}')::uuid and lease_expires_at>clock_timestamp();
	select p_result
$$;
create or replace function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select pg_temp.office_hold(public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease))
$$;
