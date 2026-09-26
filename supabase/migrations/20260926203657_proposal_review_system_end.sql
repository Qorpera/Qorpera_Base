-- The system ends a proposal review's job as a failure, not as a cancellation.
--
-- Two triggers end a live review job when its review can no longer finish:
-- qorpera_seed_company_proposal_reviews when a newer proposal revision
-- supersedes the review, and qorpera_runner_proposal_wake_status when the
-- proposal is accepted or rejected. Both set the job 'cancelled' with
-- finished_at and no cancelled_at, which the job table refuses: status
-- 'cancelled' requires cancelled_at and cancelled_by_user_id (checks 4 and 5),
-- and finished_at belongs to 'completed' and 'failed' (check 3). So rebasing or
-- rejecting a proposal while its review job was queued or leased aborted with
-- 23514, and the member's action was lost.
--
-- 'cancelled' is a member's Stop (qorpera_cancel_runner_job is the only path
-- that sets it, and the activity list reads cancelled_by_user_id that way). No
-- member stopped these runs, so they end 'failed' with their reason through
-- qorpera_terminalize_runner_attempt, like the other system ends (a revoked
-- provider connection, an expired lease). Without a pristine retry, the job
-- never runs again. For a leased job, the helper also quarantines a gateway call
-- still in flight, which settles the review's budget reservation (the plain
-- update left it reserved), and marks executing operations ambiguous. The job
-- keeps the runner's lease token as its terminal token, so the runner is fenced.
-- The status trigger fails the accepted runner assignment and the review
-- assignment with the job's last error; the unchanged update after it fails the
-- reviews that had not started.
--
-- Nobody is asked to act on such a run: the activity list shows a failed review
-- only while its proposal is open at the reviewed revision, the recovery list
-- leaves proposal reviews out, and qorpera_retry_company_proposal_review
-- refuses an old revision or a decided proposal.
--
-- One exact-once text patch per function, so each keeps its ACL.

create function pg_temp.review_end_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Proposal review system end patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.review_end_patch('public.qorpera_seed_company_proposal_reviews()',
	$old$	update public.qorpera_runner_jobs as job
	set status = 'cancelled',
		terminal_lease_token_sha256 = case
			when job.status = 'leased' then job.lease_token_sha256
			else job.terminal_lease_token_sha256
		end,
		lease_token_sha256 = null, lease_expires_at = null,
		finished_at = statement_timestamp(),
		last_error = 'Proposal review was superseded by a newer revision'
	from public.qorpera_company_proposal_review_assignments as review
	where review.proposal_id = new.proposal_id and review.proposal_revision < new.revision
		and review.status = 'running' and job.run_id = review.run_id
		and job.status in ('queued', 'leased');$old$,
	$new$	-- No member stopped this run: the system ends it as a failure.
	perform public.qorpera_terminalize_runner_attempt(
		job.id, 'failed', 'Proposal review was superseded by a newer revision', false
	)
	from public.qorpera_company_proposal_review_assignments as review
	join public.qorpera_runner_jobs as job on job.run_id = review.run_id
	where review.proposal_id = new.proposal_id and review.proposal_revision < new.revision
		and review.status = 'running' and job.status in ('queued', 'leased');$new$);

select pg_temp.review_end_patch('public.qorpera_runner_proposal_wake_status()',
	$old$		update public.qorpera_runner_jobs as job
		set status = 'cancelled',
			terminal_lease_token_sha256 = case
				when job.status = 'leased' then job.lease_token_sha256
				else job.terminal_lease_token_sha256
			end,
			lease_token_sha256 = null, lease_expires_at = null,
			finished_at = statement_timestamp(),
			last_error = 'Proposal review was closed before this assignment completed'
		from public.qorpera_company_proposal_review_assignments as review
		where review.proposal_id = new.id and review.status = 'running'
			and job.run_id = review.run_id and job.status in ('queued', 'leased');$old$,
	$new$		-- No member stopped this run: the system ends it as a failure.
		perform public.qorpera_terminalize_runner_attempt(
			job.id, 'failed', 'Proposal review was closed before this assignment completed', false
		)
		from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_runner_jobs as job on job.run_id = review.run_id
		where review.proposal_id = new.id and review.status = 'running'
			and job.status in ('queued', 'leased');$new$);
