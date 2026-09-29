-- Company delete, step D2 (29 Sep 2026; deploy/first-node/RUNTIME-COMPANY-DELETE.md). A one-run guest or
-- an execution-host sandbox serves exactly one run. When assigning or delivering its assignment ends with
-- an unknown outcome, the orchestrator leaves it up for a replay. A job that ended (cancelled, failed, or
-- ended because its company is being deleted) is never replayed, so the runner waited on its inbox for
-- ever and kept its machine allocation, which also keeps a deleted company from being purged.
-- The LXD provider and the shared execution backend now ask, for runners that have waited two minutes
-- or more, which of them belong to a job that ended at least two minutes ago, and retire those.

create function public.qorpera_runtime_ended_runners(p_runner_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runner provider authority required' using errcode = '42501';
	end if;
	if p_runner_ids is null or cardinality(p_runner_ids) > 512 then
		raise exception 'Ended runner query is invalid' using errcode = '22023';
	end if;
	-- A runner's machine allocation names its run (one allocation per runner, one runner per attempt);
	-- the run names its job. A job still queued or leased, or ended less than two minutes ago, has not
	-- ended for this purpose. An ended job never becomes queued or leased again.
	return (
		select coalesce(jsonb_agg(ended.runner_id order by ended.runner_id), '[]'::jsonb)
		from (
			select distinct asked.runner_id
			from unnest(p_runner_ids) as asked(runner_id)
			join public.qorpera_runtime_machine_allocations as allocation on allocation.runner_id = asked.runner_id
			join public.qorpera_execution_runs as run on run.id = allocation.run_id
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where job.status in ('completed', 'failed', 'cancelled')
				and coalesce(job.finished_at, job.cancelled_at) <= statement_timestamp() - interval '2 minutes'
		) as ended
	);
end
$$;
revoke all on function public.qorpera_runtime_ended_runners(uuid[]) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_ended_runners(uuid[]) to service_role;
