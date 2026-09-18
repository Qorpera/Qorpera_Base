-- Placement deferral instead of infrastructure failure (16 Sep 2026). On the two-node
-- acceptance a run of one member failed after eight dispatch attempts in twenty seconds:
-- the ceiling and the chooser refused the claimants (node not preferred, home node full)
-- and every refusal counted as an infrastructure failure. A typed admission refusal from
-- the provider (ADMISSION_REFUSED:<REASON>) now keeps the job queued: the refusing
-- orchestrator waits five seconds for a node-preference refusal, every orchestrator
-- waits fifteen seconds for a capacity refusal, and the run deadline bounds the wait.
-- Ordinary failures keep the eight-attempt budget.

alter table public.qorpera_runner_jobs
	add column dispatch_deferred_until timestamptz,
	add column dispatch_refused_by uuid;

alter table public.qorpera_execution_run_events drop constraint qorpera_execution_run_events_event_type_check;
alter table public.qorpera_execution_run_events add constraint qorpera_execution_run_events_event_type_check check (event_type in (
	'queued', 'orchestrator_claimed', 'runner_assigned', 'runner_started',
	'lease_renewed', 'infrastructure_retry', 'completed', 'failed',
	'cancelled', 'review_pending', 'provider_session_bound',
	'recovery_released', 'recovery_discarded', 'sponsor_handoff', 'placement_deferred'
));

do $patch$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure);
	v_old := '	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		last_error = btrim(p_error)
	where id = v_claim.job_id and status = ''queued'' and dispatch_failure_count < 8
	returning * into v_job;
	if v_job.id is not null and v_job.dispatch_failure_count >= 8 then
		update public.qorpera_runner_jobs
		set status = ''failed'', finished_at = statement_timestamp(),
			last_error = ''Runner dispatch failed after the final infrastructure attempt: '' || btrim(p_error)
		where id = v_job.id returning * into v_job;
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, ''infrastructure_retry'', jsonb_build_object(
		''assignment_id'', v_assignment.id, ''reason'', btrim(p_error),
		''dispatch_failure_count'', v_job.dispatch_failure_count,
		''terminal'', coalesce(v_job.status = ''failed'', false)
	));
	return jsonb_build_object(
		''released'', true,
		''dispatch_failure_count'', v_job.dispatch_failure_count,
		''terminal'', coalesce(v_job.status = ''failed'', false)
	);';
	v_new := '	if btrim(p_error) ~ ''^ADMISSION_REFUSED:[A-Z_]{3,64}$'' then
		-- The provider''s ceiling or the node chooser refused this claimant. That is placement, not an
		-- infrastructure failure: the job stays queued, this orchestrator (node preference) or every
		-- orchestrator (capacity) waits a short while, and the run deadline still bounds the wait.
		update public.qorpera_runner_jobs
		set dispatch_refused_by = case when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'')
				then p_orchestrator_id else null end,
			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'')
				then interval ''5 seconds'' else interval ''15 seconds'' end,
			last_error = btrim(p_error)
		where id = v_claim.job_id and status = ''queued''
		returning * into v_job;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_claim.run_id, ''placement_deferred'', jsonb_build_object(
			''assignment_id'', v_assignment.id, ''reason'', substr(btrim(p_error), 19),
			''refused_by'', v_job.dispatch_refused_by, ''deferred_until'', v_job.dispatch_deferred_until,
			''dispatch_failure_count'', v_job.dispatch_failure_count
		));
		return jsonb_build_object(
			''released'', true, ''deferred'', true,
			''dispatch_failure_count'', v_job.dispatch_failure_count,
			''terminal'', false
		);
	end if;
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		last_error = btrim(p_error)
	where id = v_claim.job_id and status = ''queued'' and dispatch_failure_count < 8
	returning * into v_job;
	if v_job.id is not null and v_job.dispatch_failure_count >= 8 then
		update public.qorpera_runner_jobs
		set status = ''failed'', finished_at = statement_timestamp(),
			last_error = ''Runner dispatch failed after the final infrastructure attempt: '' || btrim(p_error)
		where id = v_job.id returning * into v_job;
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, ''infrastructure_retry'', jsonb_build_object(
		''assignment_id'', v_assignment.id, ''reason'', btrim(p_error),
		''dispatch_failure_count'', v_job.dispatch_failure_count,
		''terminal'', coalesce(v_job.status = ''failed'', false)
	));
	return jsonb_build_object(
		''released'', true,
		''dispatch_failure_count'', v_job.dispatch_failure_count,
		''terminal'', coalesce(v_job.status = ''failed'', false)
	);';
	if position(v_old in v_def) = 0 then raise exception 'release_runner_job_claim body differs'; end if;
	execute replace(v_def, v_old, v_new);
end
$patch$;

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
		-- Placement deferral: after a refused admission the refusing orchestrator (node preference)
		-- or every orchestrator (capacity) leaves the job alone until the deferral passes.
		and (job.dispatch_deferred_until is null
			or job.dispatch_deferred_until <= statement_timestamp()
			or (job.dispatch_refused_by is not null and job.dispatch_refused_by <> p_orchestrator_id))
		-- Identity home: claim only where this orchestrator's adapter holds a completed login of the run's identity.
		and (run.compute_identity_id is null
			or not exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				join public.qorpera_native_provider_login_sessions as login on login.id = home.login_session_id and login.status = 'completed'
				where home.login_compute_identity_id = run.compute_identity_id
			)
			or exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				join public.qorpera_native_provider_login_sessions as login on login.id = home.login_session_id and login.status = 'completed'
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
