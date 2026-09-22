-- A failed run that left an operation of unknown outcome (an ambiguous receipt)
-- could never be dismissed: discard refuses while the outcome is unsettled, so
-- the failure stood in the agent's activity forever, the thread showed its card
-- on every reload and the red badge never cleared (production run 6264f1e7…,
-- 18 Sep 2026: lease expired after the agent had already answered).
--
-- "Acknowledge" is the member's dismissal: it records that the failure was seen
-- and stops it standing in for the agent's state. It discards nothing, changes no
-- receipt, replays nothing, and never hides an open proposal. Retry and discard
-- keep their rules; an acknowledged run may still be retried later.
begin;

alter table public.qorpera_execution_run_events
	drop constraint qorpera_execution_run_events_event_type_check,
	add constraint qorpera_execution_run_events_event_type_check check (event_type in (
		'queued', 'orchestrator_claimed', 'runner_assigned', 'runner_started',
		'lease_renewed', 'infrastructure_retry', 'completed', 'failed',
		'cancelled', 'review_pending', 'provider_session_bound',
		'recovery_released', 'recovery_discarded', 'recovery_acknowledged'
	));

create or replace function public.qorpera_resolve_failed_execution_run(p_run_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_changed integer;
begin
	perform 1 from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.id=job.run_id and run.job_id=job.id
	where run.id=p_run_id and auth.uid() is not null
	 and public.qorpera_can_write_profile(run.profile_id) for update of job;
	if not found then
		raise exception 'execution recovery requires company write access' using errcode = '42501';
	end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id for update;
	if auth.uid() is null or not found or not public.qorpera_can_write_profile(v_run.profile_id) then
		raise exception 'execution recovery requires company write access' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id for update;
	if v_job.status not in ('failed', 'cancelled')
		or p_action not in ('retry', 'discard', 'acknowledge')
		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
		or (p_action = 'discard' and v_run.source_kind = 'proposal_review') then
		raise exception 'execution recovery action is unavailable' using errcode = '55000';
	end if;
	if p_action = 'acknowledge' then
		-- Seen by a member: the run stops standing in for the agent. Nothing else
		-- changes, so acknowledging twice, or after another resolution, is a no-op.
		if not exists (
			select 1 from public.qorpera_execution_run_events as resolved
			where resolved.run_id = v_run.id
				and resolved.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged')
		) then
			insert into public.qorpera_execution_run_events (run_id, event_type, payload)
			values (v_run.id, 'recovery_acknowledged', jsonb_build_object(
				'action', p_action, 'resolved_by_user_id', auth.uid()
			));
		end if;
		return jsonb_build_object('run_id', v_run.id, 'action', p_action, 'resolved', true);
	end if;
	if exists (
		select 1 from public.qorpera_execution_run_events as resolved
		where resolved.run_id = v_run.id
			and resolved.event_type in ('recovery_released', 'recovery_discarded')
	) then
		raise exception 'execution recovery was already resolved' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
	) or exists (
		select 1 from public.qorpera_company_proposals as proposal
		where proposal.execution_kind = 'run' and proposal.execution_id = v_run.id
			and proposal.status = 'open'
	) then
		raise exception 'execution recovery still has an unresolved durable outcome' using errcode = '55000';
	end if;
	if p_action = 'retry' then
		if exists (
			select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status = 'completed'
		) then
			raise exception 'execution recovery cannot retry work with a durable operation outcome or open proposal' using errcode = '55000';
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null
		where id = any(v_run.input_ids) and execution_run_id = v_run.id
			and completed_at is null;
		get diagnostics v_changed = row_count;
		if v_changed <> cardinality(v_run.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'execution recovery input set changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp()
		where id = v_run.session_id;
	else
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_discarded', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
	end if;
	return jsonb_build_object('run_id', v_run.id, 'action', p_action, 'resolved', true);
end
$function$;

-- CREATE OR REPLACE retains the existing function ACL; state it explicitly.
revoke all on function public.qorpera_resolve_failed_execution_run(uuid, text) from public;
grant execute on function public.qorpera_resolve_failed_execution_run(uuid, text) to authenticated;

-- Staff activity: an acknowledged failure no longer outranks the agent's newer
-- work. A run that left an open proposal keeps asking for a decision whatever
-- its job status and whether or not its failure was acknowledged.
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
				or (job.status in ('completed', 'failed', 'cancelled') and exists (
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

revoke all on function public.qorpera_list_staff_execution_activity(uuid) from public;
grant execute on function public.qorpera_list_staff_execution_activity(uuid) to authenticated;

commit;
