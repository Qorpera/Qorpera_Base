-- A renewed runner job lease now spans six minutes instead of two. The
-- 2026-08-25 acceptance evidence shows platform shedding waves lasting three
-- to four minutes during which every control-plane round trip fails; a
-- healthy runner mid-execution kept renewing until the wave outlasted its
-- two-minute lease and the reconciler expired a live attempt whose candidate
-- snapshot already existed. The initial lease granted at claim time remains
-- two minutes, so a genuinely dead runner is still detected quickly; only a
-- runner that has proven itself with at least one successful renewal earns
-- the incident-scale window.

create or replace function public.qorpera_renew_runner_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job renewal is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.status = 'leased' and job.runner_id = p_runner_id
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp() for update;
	if not found then raise exception 'runner job lease is unavailable' using errcode = '40001'; end if;
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() + interval '6 minutes'
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_lease_renewed',
		jsonb_build_object('lease_expires_at', v_job.lease_expires_at), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;
