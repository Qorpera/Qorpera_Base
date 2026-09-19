-- Presentation-only live phase. The native tool boundary already emits closed,
-- metadata-only send_message start/finish observations. Those observations can
-- refine an active run's appearance; they never change its durable activity,
-- run selection, recovery state, or authority. Writing covers explicit public
-- send execution, not private provider text or reasoning. Missing/delayed
-- telemetry falls back to working, and a missing finish expires after 20s.
begin;

create index qorpera_runtime_observations_pending_send
	on public.qorpera_runtime_observations(run_id,assignment_id,ingested_at desc)
	where operation = 'send_message' and phase = 'start';

create or replace function public.qorpera_list_staff_execution_activity(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company execution activity is unavailable' using errcode = '42501';
	end if;
	return coalesce((
		with candidates as (
			select run.id as run_id, run.staff_agent_id, run.source_kind, job.status as job_status,
				job.client_lease_id as assignment_id, job.lease_expires_at,
				case
					when job.status in ('failed', 'cancelled') or exists (
						select 1 from public.qorpera_company_proposals as proposal
						where proposal.execution_kind = 'run' and proposal.execution_id = run.id
							and proposal.status = 'open'
					) then 'needs_attention'
					when job.status = 'leased' then 'working'
					else 'waiting'
				end as activity,
				case
					when job.status in ('failed', 'cancelled') then 3
					when job.status = 'leased' then 2
					else 1
				end as priority,
				coalesce(job.finished_at, job.started_at, job.created_at) as updated_at
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.environment_id = p_environment_id and (
				job.status in ('queued', 'leased')
				or (job.status in ('failed', 'cancelled') and (
					(run.source_kind = 'session_turn' and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
					or (run.source_kind = 'wake' and exists (
						select 1 from public.qorpera_wake_occurrences as occurrence
						where occurrence.run_id = run.id and occurrence.status in ('failed', 'requires_review')
					) and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
					or (run.source_kind = 'proposal_review' and exists (
						select 1
						from public.qorpera_company_proposal_review_assignments as review
						join public.qorpera_company_proposals as proposal on proposal.id = review.proposal_id
						where review.run_id = run.id and review.status = 'failed' and proposal.status = 'open'
							and review.proposal_revision = (
								select max(revision.revision)
								from public.qorpera_company_proposal_revisions as revision
								where revision.proposal_id = proposal.id
							)
					))
					or (run.source_kind in ('manual', 'room_delivery', 'system') and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
				))
				or (job.status = 'completed' and exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				))
			)
		), current_activity as (
			select distinct on (staff_agent_id) *
			from candidates
			order by staff_agent_id, priority desc, updated_at desc, run_id desc
		)
		select jsonb_agg(jsonb_build_object(
			'run_id', activity.run_id,
			'staff_agent_id', activity.staff_agent_id,
			'source_kind', activity.source_kind,
			'job_status', activity.job_status,
			'activity', activity.activity,
			'updated_at', activity.updated_at
		) || case when activity.activity = 'working' then jsonb_build_object(
			'phase', case when activity.lease_expires_at > statement_timestamp() and exists (
				select 1 from public.qorpera_runtime_observations as started
				where started.run_id = activity.run_id and started.assignment_id = activity.assignment_id
					and started.operation = 'send_message' and started.phase = 'start'
					-- Both clocks must be fresh: a delayed export cannot revive an old send.
					and started.ingested_at > statement_timestamp() - interval '20 seconds'
					and started.observed_at > statement_timestamp() - interval '20 seconds'
					and not exists (
						select 1 from public.qorpera_runtime_observations as finished
						where finished.run_id = started.run_id and finished.attempt_id = started.attempt_id
							and finished.phase = 'finish'
					)
			) then 'writing' else 'working' end
		) else '{}'::jsonb end order by activity.staff_agent_id)
		from current_activity as activity
	), '[]'::jsonb);
end
$$;

commit;
