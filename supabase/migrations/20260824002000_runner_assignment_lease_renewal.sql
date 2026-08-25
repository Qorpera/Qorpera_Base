-- Keep the accepted assignment capability live for exactly as long as the
-- runner job lease it authorizes. Native provider hosts validate both rows;
-- allowing the assignment's original offer deadline to lapse would revoke an
-- otherwise healthy, actively renewed execution.

create function public.qorpera_sync_runner_assignment_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.status = 'leased' and new.client_lease_id is not null
		and new.lease_expires_at is not null then
		update public.qorpera_runner_assignments as assignment
		set expires_at = new.lease_expires_at
		where assignment.id = new.client_lease_id
			and assignment.job_id = new.id
			and assignment.run_id = new.run_id
			and assignment.runner_id = new.runner_id
			and assignment.status in ('offered', 'accepted');
	end if;
	return new;
end
$$;

create trigger qorpera_sync_runner_assignment_lease
after update of status, client_lease_id, lease_expires_at
on public.qorpera_runner_jobs
for each row execute function public.qorpera_sync_runner_assignment_lease();

-- Repair an execution that was already active while this migration landed.
update public.qorpera_runner_assignments as assignment
set expires_at = job.lease_expires_at
from public.qorpera_runner_jobs as job
where assignment.id = job.client_lease_id
	and assignment.job_id = job.id
	and assignment.run_id = job.run_id
	and assignment.runner_id = job.runner_id
	and assignment.status = 'accepted'
	and job.status = 'leased'
	and job.lease_expires_at > statement_timestamp();

revoke all on function public.qorpera_sync_runner_assignment_lease() from public;
