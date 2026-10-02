-- G2-2a: a run's presence device and screen leases end with its job (the coordinator's G2, 2026-10-02).
--
-- The guest's native host forgets its presence device (qorpera_native_presence_forget) and releases its screens
-- (qorpera_native_office_screen 'release') as a run closes. Both stay allowed after the job ended, by design, so a
-- run the server ended (a member's Stop, a company stop, a revoked runner) still cleans up. Once the host calls the
-- database through qorpera_native_host_call (G2-2), its lease token stops working the moment the job ends, and those
-- late calls are refused. So the end of the job does this cleanup itself, in the trigger that already ends the run's
-- connection lease, for the job's own binding only:
-- - its presence device is deleted. Subjects ignore it once the run ends and it would expire after 30 s;
-- - its screen leases are expired past the office supervisor's 30 s grace, so the supervisor's next status poll
--   (about every second) releases them exactly as it releases a lease its run never released: unresolved agent work
--   is drained first, then the lease is cleared under a new epoch. Nothing outside SQL happens here.
--
-- Locks: the ending never waits for a device or screen row. It runs in the transaction that ends the job, right
-- after that job row's update (company fence -> ... -> the job row), and that transaction may end several jobs (a
-- company stop, a revoked runner, the orchestrator's reconcile pass). Office paths lock several screens of one
-- office in their own order (the supervisor's reap, the privacy fence, lifecycle), so taking this job's screens in
-- job order could close a cycle with them. Instead it locks only the rows free right now (skip locked):
-- - presence: the job's one device row (unique run_id), FOR UPDATE, for the delete. Its other writers lock that row
--   alone (forget) or only after the job (register), so a skipped row is one forget is deleting anyway;
-- - screens: the job's screens whose lease is not yet past the grace, FOR NO KEY UPDATE, for the expiry. A skipped
--   screen is held by an office path that clears it (the reap, a take-over, the privacy fence, lifecycle, the host's
--   own release) or reads it for a moment; then its lease ends on its own expiry plus the grace, as without this.
-- SQL tests 798 (behaviour) and 799 (against the presence heartbeat, the supervisor's reap and a member's take-over,
-- and an ending of two jobs against the reap and the privacy fence).

set local lock_timeout = '3s';

create or replace function public.qorpera_terminalize_native_provider_lease()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_native_provider_connection_leases
	set status = case when new.status = 'completed' then 'released' else 'revoked' end,
		released_at = statement_timestamp()
	where job_id = new.id and run_id = new.run_id and status = 'active';
	-- 20260929999600: the job's presence device and screen leases end with it, never waiting for those rows.
	if new.run_id is not null then
		delete from public.qorpera_native_presence_devices as device
		where device.client_id in (select candidate.client_id from public.qorpera_native_presence_devices as candidate
			where candidate.run_id = new.run_id and candidate.binding ->> 'jobId' = new.id::text
			for update skip locked);
		with locked as (
			select candidate.id from public.qorpera_runtime_office_screens as candidate
			where candidate.run_id = new.run_id and candidate.native_binding ->> 'jobId' = new.id::text
				and candidate.lease_id is not null and candidate.lease_expires_at > clock_timestamp() - interval '30 seconds'
			order by candidate.office_id, candidate.ordinal
			for no key update skip locked)
		update public.qorpera_runtime_office_screens as screen
		set lease_expires_at = clock_timestamp() - interval '30 seconds'
		from locked where screen.id = locked.id;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_terminalize_native_provider_lease() from public, anon, authenticated, service_role;
