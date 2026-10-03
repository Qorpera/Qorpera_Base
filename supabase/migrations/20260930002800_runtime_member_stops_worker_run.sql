-- Members can stop a worker's run (session-buildup audit gap 4b, 3 Oct 2026; the coordinator's decision after gap 4's
-- "no progress for 15 minutes" notice, migration 20260930002600). A worker's own run has no conversation, so the
-- conversation's Stop never reached it (contract 7.3). Who may stop it is the thread run's rule: owners, admins, and
-- the member whose work dispatched the worker (the job's creator, a contributor). The stop is the same path
-- (qorpera_cancel_runner_job, which records cancelled_by_user_id). No caps.
--
-- * qorpera_is_member_worker_run(run): an in-house worker's own run (dispatched through the wake bus, no
--   conversation). Coding workers stop through their coding session, as before.
-- * qorpera_get_worker_run_control(run) and qorpera_cancel_worker_run(run): the member read (status, can_cancel) and
--   the Stop, by run id (members never see job ids). Granted to authenticated; both check the caller.
-- * qorpera_drain_worker_wakes: a worker whose run a member stopped ends with reason 'member_stopped' ("A member
--   stopped the background work."), so its parent hears that instead of "could not start".
-- * qorpera_notify_runs_without_progress (gap 4): a worker run's stall is also told to the member who dispatched it,
--   and its notice says it is a worker's (subject 'worker'), so the notice line can offer Stop.
-- Lock order is the cancel's own: the job, then the member row. The worker is settled later by the drain (todo, then
-- worker, NOWAIT), as for any child that ended.

create function pg_temp.g4b_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Gap 4b anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

create function public.qorpera_is_member_worker_run(p_run public.qorpera_execution_runs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	-- Gap 4b (20260930002800).
	select p_run.session_id is null and p_run.source_kind = 'wake'
		and coalesce((public.qorpera_run_worker(p_run.id)).species = 'in-house', false)
$$;

create function public.qorpera_worker_run_member_stopped(p_occurrence_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	-- Gap 4b (20260930002800): the worker's run was stopped by a member (the cancel records who).
	select exists (select 1 from public.qorpera_wake_occurrences as wake
		join public.qorpera_runner_jobs as job on job.run_id = wake.run_id
		where wake.id = p_occurrence_id and job.status = 'cancelled' and job.cancelled_by_user_id is not null)
$$;
revoke all on function public.qorpera_is_member_worker_run(public.qorpera_execution_runs),
	public.qorpera_worker_run_member_stopped(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_get_worker_run_control(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_role public.qorpera_profile_role;
begin
	-- Gap 4b (20260930002800). Any member who can read the company sees the run's state; can_cancel is the
	-- thread run's rule.
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	if auth.uid() is null or v_run.id is null or not public.qorpera_can_read_profile(v_run.profile_id)
		or not public.qorpera_is_member_worker_run(v_run) then
		raise exception 'worker run is unavailable' using errcode = '42501'; end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = v_run.profile_id and member.user_id = auth.uid();
	return jsonb_build_object('run_id', v_run.id, 'status', v_job.status,
		'can_cancel', v_job.status in ('queued', 'leased') and coalesce(v_role in ('owner', 'admin')
			or (v_role = 'contributor' and v_job.created_by_user_id = auth.uid()), false));
end
$$;

create function public.qorpera_cancel_worker_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
begin
	-- Gap 4b (20260930002800): the thread run's stop path, by run id. The caller is checked before anything is
	-- locked, with one answer for a run that is not there, not a worker's, or not theirs to stop (so a caller can
	-- neither hold the job's lock nor learn which runs exist); the cancel checks again under its lock.
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id;
	if auth.uid() is null or v_run.id is null or not public.qorpera_is_member_worker_run(v_run)
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_run.profile_id and member.user_id = auth.uid()
				and (member.role in ('owner', 'admin')
					or (member.role = 'contributor' and member.user_id = v_job.created_by_user_id))) then
		raise exception 'worker run is unavailable' using errcode = '42501'; end if;
	-- A run that already ended answers its state, as a second Stop does.
	if v_job.status in ('queued', 'leased') then
		begin
			perform public.qorpera_cancel_runner_job(v_run.job_id);
		exception when sqlstate '55000' then
			null; -- it ended meanwhile (the cancel's "already finished")
		end;
	end if;
	return public.qorpera_get_worker_run_control(p_run_id);
end
$$;
revoke all on function public.qorpera_get_worker_run_control(uuid), public.qorpera_cancel_worker_run(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_get_worker_run_control(uuid), public.qorpera_cancel_worker_run(uuid)
	to authenticated;

-- The parent hears that a member stopped its worker.
select pg_temp.g4b_replace('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$							'reason', case when v_wake_status = 'cancelled' then 'not_started'$old$,
	$new$							'reason', case when public.qorpera_worker_run_member_stopped(v_worker.occurrence_id)
									then 'member_stopped' -- gap 4b (20260930002800)
								when v_wake_status = 'cancelled' then 'not_started'$new$);
select pg_temp.g4b_replace('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$							'summary', case when v_wake_status = 'cancelled' then 'The background work could not start.'$old$,
	$new$							'summary', case when public.qorpera_worker_run_member_stopped(v_worker.occurrence_id)
									then 'A member stopped the background work.' -- gap 4b (20260930002800)
								when v_wake_status = 'cancelled' then 'The background work could not start.'$new$);

-- A stalled worker run is told to its dispatching member too, and says it is a worker's.
select pg_temp.g4b_replace('public.qorpera_notify_runs_without_progress()'::regprocedure,
	$old$			run.audience_kind, run.audience_user_id, run.created_by_user_id,$old$,
	$new$			run.audience_kind, run.audience_user_id, run.created_by_user_id,
			public.qorpera_is_member_worker_run(run) as worker, -- gap 4b (20260930002800)$new$);
select pg_temp.g4b_replace('public.qorpera_notify_runs_without_progress()'::regprocedure,
	$old$			else member.role in ('owner', 'admin') end$old$,
	$new$			else member.role in ('owner', 'admin')
				or (stalled.worker and member.role = 'contributor' and member.user_id = stalled.created_by_user_id) end$new$);
select pg_temp.g4b_replace('public.qorpera_notify_runs_without_progress()'::regprocedure,
	$old$			'minutes', public.qorpera_run_stall_minutes()),$old$,
	$new$			'minutes', public.qorpera_run_stall_minutes(), 'worker', told.worker),$new$);
