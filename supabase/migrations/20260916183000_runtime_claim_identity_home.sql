-- Claim-time placement check (16 Sep 2026). Native runs are placed on the
-- member identity's home nodes (20260916170000), but orchestrators claimed the
-- oldest queued job regardless of node: on the first two-node acceptance run
-- node 2's orchestrator claimed a job of an identity homed on node 1, was
-- refused NODE_IDENTITY_ELSEWHERE on every reservation attempt and finally
-- failed the job instead of leaving it for node 1. The claim now skips queued
-- jobs whose identity has a home unless the claiming orchestrator's provider
-- adapter is one of those homes; runs without an identity, or identities
-- without any home yet, stay claimable by every orchestrator (their placement
-- then defers as before). Body otherwise unchanged from
-- 20260820002000 / 20260913000100 (timeouts kept).

create or replace function public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator_id uuid, p_client_claim_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '25s'
set statement_timeout = '25s'
as $$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_adapter text;
begin
	if auth.role() <> 'service_role' or p_client_claim_id is null
		or p_lease_seconds not between 30 and 900 then
		raise exception 'orchestrator claim is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id);
	select claim.* into v_claim
	from public.qorpera_runner_job_claims as claim
	where claim.orchestrator_id = p_orchestrator_id and claim.client_claim_id = p_client_claim_id;
	if found then
		if v_claim.status not in ('claimed', 'assigned')
			or v_claim.lease_expires_at <= statement_timestamp() then
			raise exception 'orchestrator claim replay is unavailable' using errcode = '55000';
		end if;
		return public.qorpera_execution_work_json(v_claim);
	end if;
	select orchestrator.provider_adapter into v_adapter
	from public.qorpera_runner_orchestrators as orchestrator
	where orchestrator.id = p_orchestrator_id;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.id = job.run_id
	where job.status = 'queued' and job.attempt_count < 8 and job.dispatch_failure_count < 8
		and run.deadline_at > statement_timestamp()
		and public.qorpera_execution_sponsor_available(run)
		and public.qorpera_execution_compute_available(run)
		and not exists (
			select 1 from public.qorpera_runner_job_claims as active_claim
			where active_claim.job_id = job.id and active_claim.status in ('claimed', 'assigned')
		)
		-- Identity home: claim only where this orchestrator's adapter holds a login of the run's identity.
		and (run.compute_identity_id is null
			or not exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				where home.login_compute_identity_id = run.compute_identity_id
			)
			or exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				where home.login_compute_identity_id = run.compute_identity_id
					and home.provider_adapter = v_adapter
			))
	order by job.created_at, job.id
	for update of job skip locked limit 1;
	if not found then return 'null'::jsonb; end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	insert into public.qorpera_runner_job_claims (
		id, orchestrator_id, client_claim_id, job_id, run_id, lease_expires_at
	) values (
		p_client_claim_id, p_orchestrator_id, p_client_claim_id, v_job.id, v_run.id,
		least(v_run.deadline_at, statement_timestamp() + make_interval(secs => p_lease_seconds))
	) returning * into v_claim;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_run.id, 'orchestrator_claimed', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id, 'claim_id', v_claim.id
	));
	return public.qorpera_execution_work_json(v_claim);
end
$$;
