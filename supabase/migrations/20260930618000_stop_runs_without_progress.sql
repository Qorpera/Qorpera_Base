-- A run that goes silent is ended by itself (Jonas, 7 November 2026: "Yes, start there", making coding reliable; the
-- 2026-11-07 amendment in QORPERA-RUNTIME-CONTRACT.md). That morning one worker's run sat 75 minutes with a live lease,
-- an idle harness and no observation. Workers revive their parent only once all have reported, so it held up the
-- Co-Founder and a founder's three design workers until a member pressed Stop.
--
-- A run with no progress for 30 minutes (qorpera_run_last_progress_at's clock, so the notice at 15 minutes comes first)
-- ends as a worker's Stop ends it: qorpera_terminalize_runner_attempt to 'cancelled', with its reason in the job's
-- last_error. What follows a member's Stop follows this, its parent's revival included. It never stops the run's chain:
-- that is a member's word, and it would refuse the parent's next work.
--
-- A run is left alone while it has a reason to be quiet, each bounded so a lost record can't keep it for ever
-- (qorpera_run_quiet_for_a_reason):
-- * its own machine command is running, started in the last 6 hours;
-- * a machine it started is still waiting for its place, wanted in the last 6 hours;
-- * an action review of its call is parked, waiting for a member's answer, in the last 6 hours;
-- * its login reached a usage limit, in the last 6 hours.
-- The parent is told the difference (seen live: the Co-Founder took a member's Stop as the member's wish, paused all the
-- work and waited to be asked to resume). A member's Stop stays 'member_stopped'. A worker this pass ended is 'went_silent',
-- and its summary tells the parent that no member asked for this and to carry on without asking one.
--
-- A company paused or being deleted is left alone too, and so is every run when more than p_most look silent at once:
-- observations are best effort, so that many together more likely means their export stopped than that they hung. The
-- notices still tell the members.
--
-- qorpera_stop_runs_without_progress(): one pass, every minute as 'qorpera-run-stops', through the existing partial index
-- qorpera_runner_jobs_queue. Each job is taken with SKIP LOCKED in its own subtransaction, so a busy or failing one holds
-- up nothing. The clock is read only for jobs that started at least 30 minutes ago.

set local lock_timeout = '3s';

create function public.qorpera_run_stop_minutes()
returns integer
language sql
immutable
set search_path = ''
as $$
	select 30 -- 20260930618000
$$;

create function public.qorpera_run_quiet_for_a_reason(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	-- 20260930618000
	select exists (select 1 from public.qorpera_company_machine_commands as command
			where command.run_id = p_run_id and command.ended_at is null
				and command.started_at > statement_timestamp() - interval '6 hours')
		or exists (select 1 from public.qorpera_company_machines as machine
			where machine.started_by_run_id = p_run_id and machine.desired_state = 'running' and machine.removed_at is null
				and machine.wanted_at > statement_timestamp() - interval '6 hours'
				and not exists (select 1 from public.qorpera_company_machine_placements as placement
					where placement.machine_id = machine.id and placement.running_at is not null
						and placement.retired_at is null and placement.removed_at is null))
		or exists (select 1 from public.qorpera_action_reviews as review
			where review.run_id = p_run_id and review.parked_at is not null and review.answered_at is null
				and review.parked_at > statement_timestamp() - interval '6 hours')
		or exists (select 1 from public.qorpera_provider_connection_usage_signals as signal
			where signal.run_id = p_run_id and signal.signal_kind = 'usage_limit'
				and signal.observed_at > statement_timestamp() - interval '6 hours')
$$;

-- The worker's run was ended by the pass below: no member asked for this.
create function public.qorpera_worker_run_went_silent(p_occurrence_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	-- 20260930618000: cancelled, by nobody, with the pass's reason.
	select exists (select 1 from public.qorpera_wake_occurrences as wake
		join public.qorpera_runner_jobs as job on job.run_id = wake.run_id
		where wake.id = p_occurrence_id and job.status = 'cancelled' and job.cancelled_by_user_id is null
			and job.last_error like 'Runner job made no progress for % minutes and was stopped%')
$$;

create or replace function public.qorpera_folder_worker_ended(p_worker public.qorpera_runtime_workers, p_occurrence_id uuid,
	p_occurrence_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_reason text;
begin
	-- 20260930003100 (F2-5b-3).
	v_reason := case when p_occurrence_id is not null and public.qorpera_worker_run_member_stopped(p_occurrence_id) then 'member_stopped'
		-- 20260930618000: the platform ended it for going silent.
		when p_occurrence_id is not null and public.qorpera_worker_run_went_silent(p_occurrence_id) then 'went_silent'
		when p_occurrence_status is distinct from 'completed' and p_occurrence_status is distinct from 'failed'
			and p_occurrence_status is distinct from 'requires_review' then 'not_started'
		when public.qorpera_computer_hour_wake_ended_out_of_hours(p_occurrence_id) then 'out_of_computer_hours'
		-- 20260930549300: its run stopped at its login's usage limit.
		when public.qorpera_worker_usage_limit_text(p_occurrence_id) is not null then 'usage_limit'
		else 'ended_without_report' end;
	update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(), completion_state = 'waiting',
		occurrence_id = coalesce(p_occurrence_id, occurrence_id), updated_at = clock_timestamp(),
		result = jsonb_build_object('outcome', 'failed', 'outputs', '[]'::jsonb, 'sequence', p_worker.sequence, 'reason', v_reason,
			'summary', case v_reason when 'member_stopped' then 'A member stopped the background work.'
				when 'went_silent' then 'This worker went silent and the platform ended it; no member asked for this. Dispatch it again or carry on with what it saved, without asking a member.'
				when 'not_started' then 'The background work could not start.'
				when 'out_of_computer_hours' then 'The background work was stopped because the company is out of computer hours.'
				when 'usage_limit' then public.qorpera_worker_usage_limit_text(p_occurrence_id)
				else 'The background work ended without reporting a result.' end)
	where id = p_worker.id and state = 'active';
	if not found then return; end if;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
	values (p_worker.id, p_worker.sequence, 'ended', jsonb_build_object('occurrenceStatus', coalesce(p_occurrence_status, 'refused')));
end $$;

create function public.qorpera_stop_runs_without_progress(p_most integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_limit constant integer := public.qorpera_run_stop_minutes();
	v_silent uuid[];
	v_job public.qorpera_runner_jobs%rowtype;
	v_job_id uuid;
	v_stopped integer := 0;
	v_skipped integer := 0;
begin
	-- 20260930618000
	select coalesce(array_agg(job.id order by job.started_at), '{}') into v_silent
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.job_id = job.id and run.id = job.run_id
	where job.status = 'leased' and job.job_type = 'agent_turn'
		and job.started_at <= statement_timestamp() - make_interval(mins => v_limit)
		and public.qorpera_run_last_progress_at(run.id, job.started_at) <= statement_timestamp() - make_interval(mins => v_limit)
		and not public.qorpera_company_execution_paused(run.profile_id)
		and not public.qorpera_company_deleting(run.profile_id)
		and not public.qorpera_run_quiet_for_a_reason(run.id);
	if cardinality(v_silent) > p_most then
		raise warning 'Stopped no run: % look silent at once, more than %', cardinality(v_silent), p_most;
		return jsonb_build_object('schema', 'qorpera.run-stops/v1', 'silent', cardinality(v_silent), 'stopped', 0, 'held', true);
	end if;
	foreach v_job_id in array v_silent loop
		begin
			select job.* into v_job from public.qorpera_runner_jobs as job
			where job.id = v_job_id and job.status = 'leased' for update skip locked;
			if not found then v_skipped := v_skipped + 1; continue; end if;
			perform public.qorpera_terminalize_runner_attempt(v_job.id, 'cancelled',
				format('Runner job made no progress for %s minutes and was stopped', v_limit), false);
			perform public.qorpera_append_runner_audit(v_job.profile_id, v_job.runner_id, v_job.id, 'job_cancelled',
				jsonb_build_object('reason', 'no_progress', 'minutes', v_limit), null);
			v_stopped := v_stopped + 1;
		exception when others then
			v_skipped := v_skipped + 1;
			raise warning 'Run stop of job % failed: %', v_job_id, sqlstate;
		end;
	end loop;
	return jsonb_build_object('schema', 'qorpera.run-stops/v1', 'silent', cardinality(v_silent), 'stopped', v_stopped,
		'skipped', v_skipped, 'held', false);
end
$$;

revoke all on function public.qorpera_worker_run_went_silent(uuid),
	public.qorpera_folder_worker_ended(public.qorpera_runtime_workers, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_run_stop_minutes(), public.qorpera_run_quiet_for_a_reason(uuid),
	public.qorpera_stop_runs_without_progress(integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Where pg_cron is not installed, or the applying role may not use it, nothing is scheduled and the migration still
-- applies; after enabling it, run select public.qorpera_schedule_run_stops() as the role that should own the job.
create function public.qorpera_schedule_run_stops()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.run-stops-schedule/v1', 'scheduled', false);
	end if;
	begin
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.run-stops-schedule/v1', 'scheduled', false);
		end if;
		v_job := cron.schedule('qorpera-run-stops', '* * * * *', 'select public.qorpera_stop_runs_without_progress()');
	exception when insufficient_privilege then
		raise warning 'Run stops were not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.run-stops-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.run-stops-schedule/v1', 'scheduled', true, 'jobId', v_job);
end
$$;
revoke all on function public.qorpera_schedule_run_stops() from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_schedule_run_stops();
