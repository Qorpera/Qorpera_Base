-- A member seeing an error is not an operational recovery decision.
-- Keep receipts, run/job outcomes, retries and review authority unchanged.
begin;

create table public.qorpera_execution_run_failure_acknowledgments (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	acknowledged_at timestamptz not null default now(),
	primary key (run_id, user_id)
);
alter table public.qorpera_execution_run_failure_acknowledgments enable row level security;
revoke all on public.qorpera_execution_run_failure_acknowledgments
	from public, anon, authenticated, service_role;

create function public.qorpera_acknowledge_execution_run_failure(p_run_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid; v_status text; v_user_id uuid := auth.uid();
begin
	select run.profile_id, job.status into v_profile_id, v_status
	from public.qorpera_execution_runs run
	join public.qorpera_runner_jobs job on job.id = run.job_id
	where run.id = p_run_id;
	if v_user_id is null or v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company execution failure is unavailable' using errcode = '42501';
	end if;
	if v_status not in ('failed', 'cancelled') then
		raise exception 'only terminal failures can be acknowledged' using errcode = '55000';
	end if;
	insert into public.qorpera_execution_run_failure_acknowledgments(run_id,user_id)
	values (p_run_id,v_user_id) on conflict do nothing;
	return p_run_id;
end
$$;
revoke all on function public.qorpera_acknowledge_execution_run_failure(uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_acknowledge_execution_run_failure(uuid) to authenticated;

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
			where run.environment_id = p_environment_id
				-- A read receipt hides only the terminal notification for this member.
				-- Open proposals and failed current reviews still need a decision.
				and not (job.status in ('failed', 'cancelled')
					and run.source_kind <> 'proposal_review'
					and exists (select 1 from public.qorpera_execution_run_failure_acknowledgments seen
						where seen.run_id = run.id and seen.user_id = auth.uid())
					and not exists (select 1 from public.qorpera_company_proposals proposal
						where proposal.execution_kind = 'run' and proposal.execution_id = run.id
							and proposal.status = 'open'))
				and (
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
					and started.operation = 'message_composition' and started.phase = 'start'
					-- Both clocks must be fresh: delayed export cannot revive old composition.
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

revoke all on function public.qorpera_list_staff_execution_activity(uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_list_staff_execution_activity(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
