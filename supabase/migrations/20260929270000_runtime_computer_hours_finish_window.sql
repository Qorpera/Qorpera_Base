-- Computer hours, build step 6c part 3b: the finishing window for runs (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero").
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
--
-- Running work may finish for at most one hour at zero. One hour after a company ran out
-- (`qorpera_computer_hour_zero_state.ran_out_at`, build step 6c part 1), while it is still at zero:
-- * the orchestrator heartbeat (`qorpera_reconcile_runner_orchestrator_without_sponsored_turns`)
--   ends the company's leased jobs through the system path that ends a runner attempt, as failed,
--   with no automatic retry, and fails its queued jobs, with the reason "Out of computer hours
--   [code=COMPUTER_HOURS_EXHAUSTED]". It is not a member's Stop: no routine is paused and no worker
--   cancelled;
-- * an in-house worker whose run was ended so reports "out of computer hours" to its parent,
--   instead of "ended without reporting a result".
-- Machines stopping after the hour, and a coding turn's machine, are build step 6b; the web's
-- failed-run card is 6d. With the rule off there is no zero state, so nothing here acts.

set local lock_timeout = '3s';

-- Past the finishing window: ran out an hour ago or more and still at zero (a record up to one
-- sweep old is checked again).
create function public.qorpera_computer_hour_finish_window_over(p_profile_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_computer_hour_zero_state zero
		where zero.profile_id = p_profile_id and zero.ran_out_at <= p_at - interval '1 hour'
	) and public.qorpera_company_at_zero(p_profile_id, p_at)
$$;
revoke all on function public.qorpera_computer_hour_finish_window_over(uuid, timestamptz)
	from public, anon, authenticated, service_role;

-- Did this wake's run end out of computer hours?
create function public.qorpera_computer_hour_wake_ended_out_of_hours(p_occurrence_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_wake_occurrences wake
		join public.qorpera_execution_runs run on run.id = wake.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where wake.id = p_occurrence_id and job.last_error like '%[code=COMPUTER_HOURS_EXHAUSTED]%'
	)
$$;
revoke all on function public.qorpera_computer_hour_wake_ended_out_of_hours(uuid)
	from public, anon, authenticated, service_role;

create function pg_temp.finish_window_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Finishing window: % anchor is not present exactly once', p_what;
	end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $patch$
declare v_definition text := pg_get_functiondef(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure);
begin
	-- Queued jobs, beside the other queued-job failures.
	v_definition := pg_temp.finish_window_replace(v_definition, $old$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'No computer could start the run within a day'$old$, $new$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and candidate_run.profile_id in (
				select zero.profile_id from public.qorpera_computer_hour_zero_state as zero
				where public.qorpera_computer_hour_finish_window_over(zero.profile_id, statement_timestamp()))
			order by candidate.id for update of candidate skip locked);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'No computer could start the run within a day'$new$, 'queued jobs');
	-- Leased jobs: picked, then ended with the reason, after the deadline, sponsor and computer checks.
	v_definition := pg_temp.finish_window_replace(v_definition, $old$			or not public.qorpera_execution_compute_available(run)
		)
		for update skip locked$old$, $new$			or not public.qorpera_execution_compute_available(run)
			or run.profile_id in (
				select zero.profile_id from public.qorpera_computer_hour_zero_state as zero
				where public.qorpera_computer_hour_finish_window_over(zero.profile_id, statement_timestamp()))
		)
		for update skip locked$new$, 'leased jobs pick');
	v_definition := pg_temp.finish_window_replace(v_definition, $old$		else
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner lease expired before durable completion', true
			);$old$, $new$		elsif public.qorpera_computer_hour_finish_window_over(v_run.profile_id, statement_timestamp()) then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]', false
			);
		else
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner lease expired before durable completion', true
			);$new$, 'leased jobs end');
	execute v_definition;
end
$patch$;

do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_drain_worker_wakes(integer)'::regprocedure);
begin
	v_definition := pg_temp.finish_window_replace(v_definition,
		$old$							'reason', case when v_wake_status = 'cancelled' then 'not_started' else 'ended_without_report' end,
							'summary', case when v_wake_status = 'cancelled' then 'The background work could not start.'
								else 'The background work ended without reporting a result.' end)$old$,
		$new$							'reason', case when v_wake_status = 'cancelled' then 'not_started'
								when public.qorpera_computer_hour_wake_ended_out_of_hours(v_worker.occurrence_id)
									then 'out_of_computer_hours'
								else 'ended_without_report' end,
							'summary', case when v_wake_status = 'cancelled' then 'The background work could not start.'
								when public.qorpera_computer_hour_wake_ended_out_of_hours(v_worker.occurrence_id)
									then 'The background work was stopped because the company is out of computer hours.'
								else 'The background work ended without reporting a result.' end)$new$,
		'worker ended');
	execute v_definition;
end
$patch$;
