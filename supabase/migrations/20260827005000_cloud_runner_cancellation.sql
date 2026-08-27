-- Cancellation must change status and its actor/timestamp atomically. The
-- existing table contract keeps finished_at for completed/failed jobs and
-- cancelled_at for cancellation. Preserve all partial-output and lease fences.

create or replace function public.qorpera_terminalize_runner_attempt(
	p_job_id uuid,
	p_terminal_status text,
	p_reason text,
	p_allow_pristine_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_output public.qorpera_runner_company_revision_outputs%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_trail_end_sequence bigint := 0;
	v_has_partial boolean := false;
	v_has_unresolved_operation boolean := false;
	v_model_quarantined boolean := false;
	v_changed integer := 0;
	v_reason text := left(btrim(coalesce(p_reason, '')), 1000);
begin
	if p_terminal_status not in ('failed', 'cancelled')
		or p_allow_pristine_retry is null or char_length(v_reason) < 1 then
		raise exception 'runner attempt termination is invalid' using errcode = '22023';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if not found then
		raise exception 'runner attempt is unavailable' using errcode = '55000';
	end if;
	if v_job.status in ('completed', 'failed', 'cancelled') then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_job.status not in ('queued', 'leased') then
		raise exception 'runner attempt cannot be terminated' using errcode = '55000';
	end if;
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.job_id = v_job.id;
		if v_job.status = 'leased' then
			v_model_quarantined := public.qorpera_quarantine_runner_model_requests(v_job.id, v_reason);
			update public.qorpera_run_operation_receipts
			set status = 'ambiguous', completed_at = coalesce(completed_at, statement_timestamp())
			where run_id = v_run.id and status = 'executing';
			get diagnostics v_changed = row_count;
			v_has_unresolved_operation := v_changed > 0 or exists (
				select 1 from public.qorpera_run_operation_receipts as receipt
				where receipt.run_id = v_run.id and receipt.status = 'ambiguous'
			);
			v_has_partial := v_model_quarantined or v_has_unresolved_operation
				or exists (
					select 1 from public.qorpera_session_events as event
					where event.execution_kind = 'run' and event.execution_id = v_run.id
						and event.runner_assignment_id = v_job.client_lease_id
				) or exists (
					select 1 from public.qorpera_runner_model_requests as request
					where request.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_run_operation_receipts as receipt
					where receipt.run_id = v_run.id
				) or exists (
					select 1 from public.qorpera_runner_job_artifacts as artifact
					where artifact.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_runner_job_output_objects as object
					where object.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_runner_company_revision_outputs as output
					where output.job_id = v_job.id
				);
			if v_has_partial then
				select output.* into v_output
				from public.qorpera_runner_company_revision_outputs as output
				join public.qorpera_run_operation_receipts as receipt
					on receipt.run_id = output.run_id
					and receipt.status = 'completed'
					and receipt.requires_company_revision
					and receipt.output_snapshot_id = output.snapshot_id
				where output.run_id = v_run.id and output.job_id = v_job.id
					and output.assignment_id = v_job.client_lease_id
					and public.qorpera_object_root_has_current_proof('company_snapshot', output.snapshot_id)
				order by output.created_at desc limit 1;
				if found then
					if v_run.session_id is not null then
						select coalesce(max(event.sequence), v_run.transcript_start_sequence)
						into v_trail_end_sequence
						from public.qorpera_session_events as event
						where event.session_id = v_run.session_id;
					end if;
					insert into public.qorpera_company_proposals (
						profile_id, environment_id, client_proposal_id, base_snapshot_id,
						proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
						session_id, trail_end_sequence, reason, policy_key, title,
						reviewer_staff_ids, created_by_user_id
					) values (
						v_run.profile_id, v_run.environment_id, v_run.id, v_run.company_snapshot_id,
						v_output.snapshot_id, 'run', v_run.id, v_run.id,
						v_run.session_id, v_trail_end_sequence, 'recovery', null,
						'Recover completed operation Company File output',
						'{}'::uuid[], v_run.created_by_user_id
					)
					on conflict (profile_id, client_proposal_id) do update
					set title = excluded.title
					where public.qorpera_company_proposals.proposal_snapshot_id = excluded.proposal_snapshot_id
					returning * into v_proposal;
					if v_proposal.id is null then
						raise exception 'recovery proposal id is already bound to another candidate'
							using errcode = '23505';
					end if;
					update public.qorpera_run_operation_receipts
					set proposal_id = v_proposal.id, output_snapshot_id = null
					where run_id = v_run.id and status = 'completed'
						and requires_company_revision and output_snapshot_id = v_output.snapshot_id;
				end if;
			end if;
		end if;
	end if;
	if p_allow_pristine_retry and v_job.status = 'leased' and not v_has_partial
		and v_job.attempt_count < 8 and (
			v_job.run_id is null or v_run.deadline_at > statement_timestamp()
		) then
		update public.qorpera_runner_jobs
		set status = 'queued', runner_id = null, client_lease_id = null,
			terminal_lease_token_sha256 = lease_token_sha256, lease_token_sha256 = null,
			lease_expires_at = null, last_error = v_reason
		where id = v_job.id returning * into v_job;
		return public.qorpera_runner_job_json(v_job);
	end if;
	update public.qorpera_runner_jobs
	set status = p_terminal_status,
		terminal_lease_token_sha256 = case
			when status = 'leased' then lease_token_sha256
			else terminal_lease_token_sha256
		end,
		lease_token_sha256 = null, lease_expires_at = null,
		finished_at = case when p_terminal_status = 'cancelled' then null else statement_timestamp() end,
		cancelled_at = case when p_terminal_status = 'cancelled' then statement_timestamp() else null end,
		cancelled_by_user_id = case when p_terminal_status = 'cancelled' then auth.uid() else null end,
		last_error = case
			when v_has_partial then v_reason || '; durable attempt output requires review'
			else v_reason
		end
	where id = v_job.id returning * into v_job;
	if v_job.run_id is not null and v_has_partial then
		if not v_model_quarantined then
			insert into public.qorpera_execution_run_events (run_id, event_type, payload)
			values (v_run.id, 'review_pending', jsonb_build_object(
				'reason', case when v_has_unresolved_operation then 'ambiguous_operation' else 'partial_attempt_output' end,
				'assignment_id', v_job.client_lease_id,
				'proposal_id', v_proposal.id
			));
		end if;
		update public.qorpera_wake_occurrences
		set status = 'requires_review', blocked_reason = v_job.last_error,
			finished_at = statement_timestamp()
		where run_id = v_run.id and status = 'failed';
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$$;

-- Clients enter through the member-authorized cancellation RPC, never the
-- internal transition helper. Revoke inherited direct API-role grants too.
revoke all on function public.qorpera_terminalize_runner_attempt(uuid, text, text, boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_terminalize_runner_attempt(uuid, text, text, boolean)
	to service_role;
