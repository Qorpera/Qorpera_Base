-- A worker cannot release its native lease after its job authority is revoked:
-- release_native_provider_connection_lease deliberately requires a live job.
-- The cloud transaction that terminalizes the job therefore owns this cleanup.
create function public.qorpera_terminalize_native_provider_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_native_provider_connection_leases
	set status = case when new.status = 'completed' then 'released' else 'revoked' end,
		released_at = statement_timestamp()
	where job_id = new.id and run_id = new.run_id and status = 'active';
	return new;
end
$$;

revoke all on function public.qorpera_terminalize_native_provider_lease() from public, anon, authenticated, service_role;

create trigger qorpera_terminalize_native_provider_lease
after update of status on public.qorpera_runner_jobs
for each row
when (new.status in ('completed', 'failed', 'cancelled') and old.status is distinct from new.status)
execute function public.qorpera_terminalize_native_provider_lease();

-- Repair only already-terminal jobs. No live job, capsule, account connection,
-- saved credential, or public message is changed by this reconciliation.
update public.qorpera_native_provider_connection_leases as lease
set status = case when job.status = 'completed' then 'released' else 'revoked' end,
	released_at = statement_timestamp()
from public.qorpera_runner_jobs as job
where job.id = lease.job_id and job.run_id = lease.run_id
	and job.status in ('completed', 'failed', 'cancelled') and lease.status = 'active';
