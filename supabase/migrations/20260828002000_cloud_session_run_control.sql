-- Stop is a member-authorized command for an exact run in the displayed
-- conversation. Historical recovery attention is not an active-run selector.
create function public.qorpera_get_session_run_control(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_run jsonb;
begin
	select session.* into v_session from public.qorpera_shared_sessions as session
	where session.id = p_session_id;
	if auth.uid() is null or not found or not public.qorpera_can_read_profile(v_session.profile_id) then
		raise exception 'cloud conversation is unavailable' using errcode = '42501';
	end if;
	select jsonb_build_object(
		'run_id', run.id, 'status', job.status,
		'can_cancel', public.qorpera_can_write_profile(v_session.profile_id) and (
			job.created_by_user_id = auth.uid() or public.qorpera_can_authorize_profile(v_session.profile_id)
		)
	) into v_run
	from public.qorpera_execution_runs as run
	join public.qorpera_runner_jobs as job on job.id = run.job_id and job.run_id = run.id
	where run.session_id = v_session.id and job.session_id = v_session.id
		and run.profile_id = v_session.profile_id and job.profile_id = v_session.profile_id
		and run.environment_id = v_session.environment_id and job.environment_id = v_session.environment_id
		and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind = 'session_turn'
		and job.status in ('queued', 'leased')
	order by (job.status = 'leased') desc, job.created_at, run.id
	limit 1;
	return jsonb_build_object(
		'session_id', v_session.id, 'staff_agent_id', v_session.staff_agent_id, 'run', v_run
	);
end
$$;

-- Keep the existing job-id API under the same membership fence. A former
-- member must not bypass the conversation control with a remembered job id.
create or replace function public.qorpera_cancel_runner_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
	v_user_id uuid := auth.uid();
	v_job public.qorpera_runner_jobs%rowtype;
	v_role public.qorpera_profile_role;
begin
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if v_user_id is null or not found then
		raise exception 'runner job cancellation is not allowed' using errcode = '42501';
	end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = v_job.profile_id and member.user_id = v_user_id
	for share;
	if not found or v_role not in ('owner', 'admin', 'contributor') or not (
		v_job.created_by_user_id = v_user_id or v_role in ('owner', 'admin')
	) then
		raise exception 'runner job cancellation is not allowed' using errcode = '42501';
	end if;
	if v_job.status = 'cancelled' then return public.qorpera_runner_job_json(v_job); end if;
	if v_job.status in ('completed', 'failed') then
		raise exception 'runner job is already finished' using errcode = '55000';
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'cancelled', 'Runner job was cancelled by a company member', false
	);
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, v_job.runner_id, v_job.id, 'job_cancelled', '{}'::jsonb, v_user_id
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

create function public.qorpera_cancel_session_run(p_session_id uuid, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_role public.qorpera_profile_role;
begin
	select session.* into v_session from public.qorpera_shared_sessions as session
	where session.id = p_session_id;
	if auth.uid() is null or not found or not public.qorpera_can_read_profile(v_session.profile_id) then
		raise exception 'cloud run cancellation is not allowed' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.job_id = job.id and run.id = job.run_id
	where run.id = p_run_id and run.session_id = v_session.id and job.session_id = v_session.id
		and run.profile_id = v_session.profile_id and job.profile_id = v_session.profile_id
		and run.environment_id = v_session.environment_id and job.environment_id = v_session.environment_id
		and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind = 'session_turn'
	for update of job;
	if not found then
		raise exception 'cloud run cancellation is not allowed' using errcode = '42501';
	end if;
	-- Membership cannot be revoked/downgraded between this live check and the
	-- cancellation transaction. Being the original sponsor alone is insufficient.
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = v_session.profile_id and member.user_id = auth.uid()
	for share;
	if not found or v_role not in ('owner', 'admin', 'contributor') or not (
		v_job.created_by_user_id = auth.uid() or v_role in ('owner', 'admin')
	) then
		raise exception 'cloud run cancellation is not allowed' using errcode = '42501';
	end if;
	-- A late click or a lost receipt never redirects to another run. Terminal
	-- retries are readbacks; the underlying transition owns all lease/effect fences.
	if v_job.status in ('queued', 'leased') then
		perform public.qorpera_cancel_runner_job(v_job.id);
		select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_job.id;
	end if;
	return jsonb_build_object('session_id', p_session_id, 'run_id', p_run_id, 'status', v_job.status);
end
$$;

revoke all on function public.qorpera_get_session_run_control(uuid) from public, anon, authenticated;
revoke all on function public.qorpera_cancel_session_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_get_session_run_control(uuid) to authenticated;
grant execute on function public.qorpera_cancel_session_run(uuid, uuid) to authenticated;
