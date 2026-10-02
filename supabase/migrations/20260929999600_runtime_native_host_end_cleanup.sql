-- G2-2a: a run's presence device and screen leases end with its job (the coordinator's G2, 2026-10-02).
--
-- The guest's native host forgets its presence device (qorpera_native_presence_forget) and releases its screens
-- (qorpera_native_office_screen 'release') as a run closes. Both stay allowed after the job ended, by design, so a
-- run the server ended (a member's Stop, a company stop, a revoked runner) still cleans up. Once the host calls the
-- database through qorpera_native_host_call (G2-2), its lease token stops working the moment the job ends, and those
-- late calls are refused. So the database does this cleanup itself, for the ended job's own binding only (a job ends
-- for this when it leaves 'leased': it finished, or it went back to the queue for another attempt):
-- - its presence device is deleted when the transaction that ended the job commits (a deferred constraint trigger).
--   Subjects ignore it once the run ends and it would expire after 30 s, but nothing else would delete the row;
-- - its screen leases are released by the office supervisor's next status poll (about every second), which already
--   releases a lease its run never released: unresolved agent work is drained first, then the lease is cleared under
--   a new epoch. It now also releases, at once, a lease whose job is no longer leased.
--
-- Locks. A job's ending takes no screen lock, and its device lock only at commit:
-- - The transaction that ends a job may go on to end other jobs or write audit rows (taking the company row), and
--   office paths hold the company fence or the office row while they lock screens. So the ending never touches a
--   screen: the supervisor's reap, which already holds the office row and locks screens by ordinal, reads the job's
--   status without locking it, and neither waits for the other.
-- - The device is deleted at commit, after the ending's statements, and only if its row is free right now
--   (skip locked; a skipped row is one forget or a member's removal is deleting anyway). The ending never waits
--   for it and holds it only for the commit, so no cycle runs through it.
-- SQL tests 798 (behaviour) and 799 (against the presence heartbeat, a device held by another, the supervisor, the
-- privacy fence and a fence-first lifecycle, and an ending of two jobs).

set local lock_timeout = '3s';

create function public.qorpera_native_presence_end()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260929999600: the presence device of a job that left 'leased', at commit, never waiting for it.
	delete from public.qorpera_native_presence_devices as device
	where device.client_id in (select candidate.client_id from public.qorpera_native_presence_devices as candidate
		where candidate.run_id = new.run_id and candidate.binding ->> 'jobId' = new.id::text
		for update skip locked);
	return null;
end
$$;
revoke all on function public.qorpera_native_presence_end() from public, anon, authenticated, service_role;

create constraint trigger qorpera_native_presence_end
	after update of status on public.qorpera_runner_jobs
	deferrable initially deferred
	for each row
	when (old.status = 'leased' and new.status <> 'leased' and new.run_id is not null)
	execute function public.qorpera_native_presence_end();

-- The supervisor's reap, patched at its exact text so other changes to its live body are kept.
create function pg_temp.g22a_end_cleanup_patch(p_target regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $$
declare v_definition text := pg_catalog.pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor) <> 1 then
		raise exception 'G2-2a: the anchor in % is not there exactly once', p_target; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$$;
select pg_temp.g22a_end_cleanup_patch('public.qorpera_runtime_office_supervisor_status(jsonb,bigint)'::regprocedure,
$anchor$	-- under a new epoch. Office row, then screen rows, then resources, as there.
	for v_screen in select * from public.qorpera_runtime_office_screens where office_id=v_office.id
		and lease_id is not null and lease_expires_at<=clock_timestamp()-interval '30 seconds'
		order by ordinal for update loop
$anchor$,
$replacement$	-- under a new epoch. Office row, then screen rows, then resources, as there.
	-- 20260929999600: so is a lease whose job is no longer leased (it ended, or went back to the queue), at once: its
	-- run's late release is refused once the native host calls through qorpera_native_host_call (G2-2). The job is
	-- read, never locked, so a job's ending never waits for this, nor this for it.
	for v_screen in select * from public.qorpera_runtime_office_screens where office_id=v_office.id
		and lease_id is not null and (lease_expires_at<=clock_timestamp()-interval '30 seconds'
			or case when native_binding->>'jobId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				then not exists(select 1 from public.qorpera_runner_jobs as job
					where job.id=(qorpera_runtime_office_screens.native_binding->>'jobId')::uuid and job.status='leased')
				else false end)
		order by ordinal for update loop
$replacement$);
