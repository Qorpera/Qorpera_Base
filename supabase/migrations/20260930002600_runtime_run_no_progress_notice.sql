-- A run that makes no progress for 15 minutes is shown, and a member is told (session-buildup audit gap 4,
-- /Users/jonas/work/coordinator-live/SESSION-BUILDUP-AUDIT-20261003.md, 3 Oct 2026). No deadline: nothing here stops
-- or ends a run. The contract keeps "no stall detection: a run whose harness hangs without crashing keeps its machine
-- until Stop"; this only makes the hang visible, so a member can press Stop.
--
-- Progress is what the harness does, never the lease: the runner's maintenance loop renews the job while a harness
-- hangs. A run's last progress is the latest of
-- * its newest runtime observation (a tool call's start or finish, each model request's result fence, "writing" every
--   5 s; qorpera_runtime_observations, read through its (run_id, id desc) index);
-- * its newest context view (one per model request, recorded before the request is released;
--   qorpera_native_context_views, through unique (run_id, ordinal));
-- * its newest assignment (a new attempt starts afresh; through (run_id, created_at desc, id desc));
-- * its job's start.
-- A run whose newest observation is a tool call's start is waiting on that tool (a long build is work), not stalled.
-- Observations are best effort: an export outage, or one model request that thinks for more than 15 minutes, can show
-- a working run as stalled. The notice says what it saw and changes nothing.
--
-- * qorpera_run_no_progress_since(run, job start): the last progress, when it is at least 15 minutes old.
-- * qorpera_list_staff_execution_activity: a working run carries 'no_progress_since' (absent otherwise).
-- * Member notice 'run_no_progress' (subject qorpera.member-notification.run-no-progress/v1). It goes to the run's
--   member for a member-private run, to the member whose message started a turn, and otherwise (a worker, a routine, a
--   coworker's message) to the company's owners and admins. One per member and stall: the dedupe key names the run and
--   its last progress, so a dismissed notice is not sent again for the same stall, and a run that stalls again after
--   progress is told again. A notice closes itself (acknowledged) once its run made progress or ended.
-- * qorpera_notify_runs_without_progress(): one pass over leased jobs (a new partial index), run by pg_cron every
--   minute as 'qorpera-run-progress-notices'. It locks no run, job or company row; it only writes notices.
set local lock_timeout = '3s';

create index qorpera_runner_jobs_leased_started on public.qorpera_runner_jobs(started_at) where status = 'leased';

create function public.qorpera_run_no_progress_since(p_run_id uuid, p_started_at timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
	-- Gap 4 (20260930002600): the run's last progress when it is at least 15 minutes old, else null.
	with newest as (
		select observation.operation, observation.phase, observation.ingested_at
		from public.qorpera_runtime_observations as observation
		where observation.run_id = p_run_id order by observation.id desc limit 1
	), progress as (
		select greatest(p_started_at, (select newest.ingested_at from newest),
			(select view.created_at from public.qorpera_native_context_views as view
				where view.run_id = p_run_id order by view.ordinal desc limit 1),
			(select assignment.created_at from public.qorpera_runner_assignments as assignment
				where assignment.run_id = p_run_id order by assignment.created_at desc, assignment.id desc limit 1)) as at
	)
	select progress.at from progress
	where progress.at <= statement_timestamp() - interval '15 minutes'
		and not exists (select 1 from newest where newest.phase = 'start' and newest.operation not in ('model_turn',
			'model_request', 'message_composition', 'native_result_fence', 'company_context', 'run_authority',
			'context_authority', 'diagnostic_export', 'action_review'))
$$;
revoke all on function public.qorpera_run_no_progress_since(uuid, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The activity row of a working run names its stall.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_old text := $old$			select run.id as run_id, run.staff_agent_id, run.source_kind, job.status as job_status,
				job.client_lease_id as assignment_id, job.lease_expires_at,$old$;
	v_new text := $new$			select run.id as run_id, run.staff_agent_id, run.source_kind, job.status as job_status,
				job.client_lease_id as assignment_id, job.lease_expires_at, job.started_at, -- gap 4 (20260930002600)$new$;
	v_old_working text := $old$			) then 'writing' else 'working' end
		) else '{}'::jsonb end order by activity.staff_agent_id)$old$;
	v_new_working text := $new$			) then 'writing' else 'working' end
		) || jsonb_strip_nulls(jsonb_build_object('no_progress_since', -- gap 4 (20260930002600)
			public.qorpera_run_no_progress_since(activity.run_id, activity.started_at)))
		else '{}'::jsonb end order by activity.staff_agent_id)$new$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_old_working, ''))) / length(v_old_working) <> 1 then
		raise exception 'Staff execution activity differs from the gap 4 anchors'; end if;
	execute replace(replace(v_definition, v_old, v_new), v_old_working, v_new_working);
end
$patch$;

alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','sponsor_handoff','routine_needs_model_account','routine_suspended',
		'run_no_progress'));

create function public.qorpera_notify_runs_without_progress()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_closed integer;
	v_opened integer;
begin
	-- Gap 4 (20260930002600). A notice whose run made progress or ended closes itself.
	update public.qorpera_member_notifications as notice set acknowledged_at = clock_timestamp()
	where notice.kind = 'run_no_progress' and notice.acknowledged_at is null and not exists (
		select 1 from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where run.id = (notice.subject ->> 'runId')::uuid and job.status = 'leased'
			and public.qorpera_run_no_progress_since(run.id, job.started_at) = (notice.subject ->> 'since')::timestamptz);
	get diagnostics v_closed = row_count;
	with stalled as (
		select run.id as run_id, run.profile_id, run.staff_agent_id, run.session_id, run.source_kind,
			run.audience_kind, run.audience_user_id, run.created_by_user_id,
			public.qorpera_run_no_progress_since(run.id, job.started_at) as since
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.job_id = job.id
		where job.status = 'leased' and job.started_at <= statement_timestamp() - interval '15 minutes'
	), told as (
		select stalled.*, member.user_id,
			stalled.run_id::text || ':' || extract(epoch from stalled.since)::text as dedupe_key
		from stalled
		join public.qorpera_profile_members as member on member.profile_id = stalled.profile_id
		where stalled.since is not null and case
			when stalled.audience_kind = 'member_private' then member.user_id = stalled.audience_user_id
			when stalled.source_kind = 'session_turn' and exists (select 1 from public.qorpera_profile_members as sender
				where sender.profile_id = stalled.profile_id and sender.user_id = stalled.created_by_user_id)
				then member.user_id = stalled.created_by_user_id
			else member.role in ('owner', 'admin') end
	)
	insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
	select told.profile_id, told.user_id, 'run_no_progress', jsonb_build_object(
			'schema', 'qorpera.member-notification.run-no-progress/v1', 'runId', told.run_id,
			'staffAgentId', told.staff_agent_id, 'sessionId', told.session_id, 'since', told.since),
		told.dedupe_key
	from told
	-- Once per member and stall, a dismissed notice included.
	where not exists (select 1 from public.qorpera_member_notifications as earlier
		where earlier.user_id = told.user_id and earlier.profile_id = told.profile_id
			and earlier.kind = 'run_no_progress' and earlier.dedupe_key = told.dedupe_key)
	on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	get diagnostics v_opened = row_count;
	return jsonb_build_object('schema', 'qorpera.run-progress-notices/v1', 'opened', v_opened, 'closed', v_closed);
end
$$;
revoke all on function public.qorpera_notify_runs_without_progress()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Where pg_cron is not installed (a database built only by replaying migrations), or the applying role may not use
-- it, nothing is scheduled and the migration still applies; after enabling it, run, as the role that should own the
-- job, select public.qorpera_schedule_run_progress_notices(). Scheduling by the same name replaces that one job.
create function public.qorpera_schedule_run_progress_notices()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.run-progress-notices-schedule/v1', 'scheduled', false);
	end if;
	begin
		-- Looking up a function in schema cron already needs USAGE on it.
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.run-progress-notices-schedule/v1', 'scheduled', false);
		end if;
		v_job := cron.schedule('qorpera-run-progress-notices', '* * * * *',
			'select public.qorpera_notify_runs_without_progress()');
	exception when insufficient_privilege then
		raise warning 'Run progress notices were not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.run-progress-notices-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.run-progress-notices-schedule/v1', 'scheduled', true, 'jobId', v_job);
end
$$;
revoke all on function public.qorpera_schedule_run_progress_notices()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_schedule_run_progress_notices();
