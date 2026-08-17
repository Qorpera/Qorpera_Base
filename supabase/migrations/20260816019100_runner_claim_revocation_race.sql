-- Fail closed when revocation wins the runner-row lock after the initial
-- session check but before a job claim is assigned.

create or replace function public.qorpera_claim_runner_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_client_lease_id uuid,
	p_lease_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_recovered boolean;
begin
	if auth.role() <> 'service_role' or p_client_lease_id is null
		or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job claim is invalid' using errcode = '42501';
	end if;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;
	if not found then raise exception 'runner session is unavailable' using errcode = '42501'; end if;

	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.runner_id = p_runner_id and job.client_lease_id = p_client_lease_id;
	if found then
		if v_job.status <> 'leased' or v_job.lease_expires_at <= statement_timestamp()
			or v_job.lease_token_sha256 <> p_lease_token_sha256 then
			raise exception 'runner lease replay is unavailable' using errcode = '40001';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;

	if (
		select count(*) from public.qorpera_runner_jobs as active_job
		where active_job.runner_id = p_runner_id and active_job.status = 'leased'
			and active_job.lease_expires_at > statement_timestamp()
	) >= v_runner.max_concurrency then
		return 'null'::jsonb;
	end if;

	for v_job in
		select exhausted.* from public.qorpera_runner_jobs as exhausted
		where exhausted.profile_id = v_runner.profile_id and exhausted.status = 'leased'
			and exhausted.lease_expires_at <= statement_timestamp()
			and exhausted.attempt_count >= 8 for update skip locked
	loop
		update public.qorpera_runner_jobs
		set status = 'failed', terminal_lease_token_sha256 = lease_token_sha256,
			lease_token_sha256 = null, lease_expires_at = null,
			finished_at = statement_timestamp(), last_error = 'Runner lease expired after the final attempt'
		where id = v_job.id returning * into v_job;
		perform public.qorpera_append_runner_audit(
			v_job.profile_id, v_job.runner_id, v_job.id, 'job_failed',
			jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'lease_expired'), null
		);
	end loop;

	select candidate.* into v_job
	from public.qorpera_runner_jobs as candidate
	where candidate.profile_id = v_runner.profile_id
		and candidate.required_capability in (
			select capability.value from jsonb_array_elements_text(v_runner.capabilities) as capability(value)
		)
		and candidate.attempt_count < 8
		and (
			candidate.status = 'queued'
			or (candidate.status = 'leased' and candidate.lease_expires_at <= statement_timestamp())
		)
	order by candidate.created_at, candidate.id
	for update skip locked
	limit 1;
	if not found then return 'null'::jsonb; end if;
	v_recovered := v_job.status = 'leased';

	update public.qorpera_runner_jobs
	set status = 'leased', runner_id = p_runner_id, client_lease_id = p_client_lease_id,
		lease_token_sha256 = p_lease_token_sha256,
		lease_expires_at = statement_timestamp() + interval '2 minutes',
		attempt_count = attempt_count + 1,
		started_at = coalesce(started_at, statement_timestamp()), last_error = null
	where id = v_job.id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_leased',
		jsonb_build_object(
			'attempt_count', v_job.attempt_count,
			'lease_expires_at', v_job.lease_expires_at,
			'recovered', coalesce(v_recovered, false)
		), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;
