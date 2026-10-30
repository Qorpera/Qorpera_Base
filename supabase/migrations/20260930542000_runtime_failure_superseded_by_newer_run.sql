-- A failure no longer stands for its agent once the agent has newer work (stale failure card, 29 October 2026).
--
-- qorpera_list_staff_execution_activity reports one run per agent and ranks an undismissed failure (3) above the run
-- the agent works on (2), so the failure stands until a member dismisses it. In production a member sent the Co-Founder
-- a new message in a conversation whose earlier runs had failed; the new run was leased and did its work, but the
-- conversation kept the old failure card, the rail showed the agent as failed, and there was no Working indicator, on
-- reload too. The web dismisses the agent's newest failure when a member sends (#dismissFailureFor in the web's
-- company.ts), but only once it has read that failure's details and only if the dismissal reaches the cloud; an older
-- failure then stands in its place.
--
-- Now a failure is superseded once the same agent has a run created after it ended (any run of the agent's: a turn, a
-- post, a wake, a review, in any conversation). A superseded failure no longer competes for the agent's current row:
-- while the newer run is queued or leased the agent reads as waiting or working, and once that run is done no failure
-- comes back. It stays listed apart, as the agent's earlier failure, so it is still seen and can still be tried again
-- or dismissed: the agent's newest superseded failure is a second row, with 'superseded': true (an older one follows
-- once it is dismissed, as failures did before). A cloud before this migration never sends the key; a web before it
-- ranks the agent's rows by their time, so it shows the newer run as Working too, and the earlier failure again once
-- that run is done.
--
-- Unchanged:
--   - a failure with no run of the agent's created after it ended, among them a failure next to a run that was already
--     going when it failed (586 §3);
--   - a run whose own Company File proposal is open, failed or not, which still asks for the decision first, and an
--     acknowledged failure that left one;
--   - a run a member stopped, which only ever asks for its proposal's decision, below all work (20260926192436);
--   - what is listed at all, and the recovery actions: Try again, dismiss and discard keep their rules, and a dismissed
--     (acknowledged), retried or discarded failure drops out as before;
--   - the working row's phase and stall time (20260930002600), and the grants.
-- A failed proposal review is a failure of the reviewing agent's like any other: the proposal it reviewed waits in the
-- Company File either way.
--
-- One create or replace of the function as 20260922010000 wrote it with the patches of 20260926192436 and
-- 20260928459150, adding the 'superseded' column, the earlier failure and the key. The newer run is looked up among the
-- company's runs through the unique (profile_id, source_kind, source_id) index, only for an unresolved failure; no index
-- is added. Test 469.
set local lock_timeout = '3s';

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
				job.client_lease_id as assignment_id, job.lease_expires_at, job.started_at, -- gap 4 (20260930002600)
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
					when job.cancelled_by_user_id is not null then 0 -- a stop's decision waits below all work
					when job.status in ('failed', 'cancelled') then 3
					when job.status = 'leased' then 2
					else 1
				end as priority,
				coalesce(job.finished_at, job.started_at, job.created_at) as updated_at,
				-- 20260930542000: a failure the agent's newer work superseded, with no decision of its own.
				job.status in ('failed', 'cancelled') and job.cancelled_by_user_id is null and not exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				) and exists (
					select 1 from public.qorpera_execution_runs as newer
					where newer.profile_id = run.profile_id and newer.environment_id = run.environment_id
						and newer.staff_agent_id = run.staff_agent_id and newer.id <> run.id
						and newer.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
				) as superseded
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.environment_id = p_environment_id and (
				job.status in ('queued', 'leased')
				or (job.status in ('failed', 'cancelled') and job.cancelled_by_user_id is null and ( -- a member's Stop is no failure
					(run.source_kind = 'session_turn' and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged')
					))
					or (run.source_kind = 'wake' and exists (
						select 1 from public.qorpera_wake_occurrences as occurrence
						where occurrence.run_id = run.id and occurrence.status in ('failed', 'requires_review')
					) and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged')
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
							and resolved.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged')
					))
				))
				or ((job.status = 'completed' or job.cancelled_by_user_id is not null) and exists ( -- a decision, finished or stopped
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				))
				-- An acknowledged failure that left an open proposal still asks for that
				-- decision; a discarded one keeps its earlier behaviour.
				or (job.status in ('failed', 'cancelled') and exists (
					select 1 from public.qorpera_execution_run_events as acknowledged
					where acknowledged.run_id = run.id and acknowledged.event_type = 'recovery_acknowledged'
				) and exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				))
			)
		), current_activity as (
			select distinct on (staff_agent_id) *
			from candidates
			where not superseded
			order by staff_agent_id, priority desc, updated_at desc, run_id desc
		), earlier_failure as (
			-- 20260930542000: the agent's newest superseded failure, listed apart from what it does now.
			select distinct on (staff_agent_id) *
			from candidates
			where superseded
			order by staff_agent_id, updated_at desc, run_id desc
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
		) || coalesce((select jsonb_build_object('no_progress_since', stall.since, -- gap 4 (20260930002600)
				'no_progress_minutes', public.qorpera_run_stall_minutes())
			from (select public.qorpera_run_no_progress_since(activity.run_id, activity.started_at) as since) as stall
			where stall.since is not null), '{}'::jsonb)
		else '{}'::jsonb end
		|| case when activity.superseded then jsonb_build_object('superseded', true) else '{}'::jsonb end
		order by activity.staff_agent_id, activity.superseded)
		from (
			select * from current_activity
			union all
			select * from earlier_failure
		) as activity
	), '[]'::jsonb);
end
$$;

-- CREATE OR REPLACE keeps the function's ACL; state it as before (anon stays revoked, 20260928289610).
revoke all on function public.qorpera_list_staff_execution_activity(uuid) from public, anon;
grant execute on function public.qorpera_list_staff_execution_activity(uuid) to authenticated;
