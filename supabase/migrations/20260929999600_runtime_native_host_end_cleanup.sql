-- G2-2a: a run's presence device and screen leases end with its job (the coordinator's G2, 2026-10-02).
--
-- The guest's native host forgets its presence device (qorpera_native_presence_forget) and releases its screens
-- (qorpera_native_office_screen 'release') as a run closes. Both stay allowed after the job ended, by design, so a
-- run the server ended (a member's Stop, a company stop, a revoked runner) still cleans up. Once the host calls the
-- database through qorpera_native_host_call (G2-2), its lease token stops working the moment the job ends, and those
-- late calls are refused. So the end of the job does this cleanup itself, in the trigger that already ends the run's
-- connection lease, for the job's own binding only:
-- - its presence device is deleted. Subjects ignore it once the run ends and it expires after 30 s, but nothing else
--   deleted the row;
-- - its screen leases are expired past the office supervisor's 30 s grace, so the supervisor's next status poll
--   (about every second) releases them exactly as it releases a lease its run never released: unresolved agent work
--   is drained first, then the lease is cleared under a new epoch. Nothing outside SQL happens here.
--
-- Locks, in the one order (company fence -> ... -> the job row -> these rows): the trigger runs in the transaction that
-- ends the job, right after that job row's update, so its rows come last.
-- - Presence: the job's one device row (unique run_id). Its writers take the job row first (register, through
--   qorpera_native_tool_locked_run) or lock that one row alone (forget), so they wait for the ending or find it gone.
-- - Screens: the job's screen rows, by office and ordinal, without the office row. Office paths take the office row,
--   then screen rows, then resources (release, the supervisor's reap, a member's take-over, lifecycle). None of them
--   waits for a job row or the company fence while it holds a screen, and nothing that ends a job locks an office
--   row, so a wait here ends when that office path commits. A wait past the caller's lock_timeout ends with 55P03.
-- SQL tests 798 (behaviour) and 799 (against the presence heartbeat, the supervisor's reap and a member's take-over).

set local lock_timeout = '3s';

create or replace function public.qorpera_terminalize_native_provider_lease()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_native_provider_connection_leases
	set status = case when new.status = 'completed' then 'released' else 'revoked' end,
		released_at = statement_timestamp()
	where job_id = new.id and run_id = new.run_id and status = 'active';
	-- 20260929999600: the job's presence device and screen leases end with it.
	if new.run_id is not null then
		delete from public.qorpera_native_presence_devices
		where run_id = new.run_id and binding ->> 'jobId' = new.id::text;
		perform 1 from public.qorpera_runtime_office_screens
		where run_id = new.run_id and native_binding ->> 'jobId' = new.id::text and lease_id is not null
		order by office_id, ordinal for update;
		update public.qorpera_runtime_office_screens set lease_expires_at = clock_timestamp() - interval '30 seconds'
		where run_id = new.run_id and native_binding ->> 'jobId' = new.id::text and lease_id is not null
			and lease_expires_at > clock_timestamp() - interval '30 seconds';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_terminalize_native_provider_lease() from public, anon, authenticated, service_role;
