-- Native tools and public sends already hold their job before validating the
-- company/recovery fence. Direct host monitoring must use the same order:
-- otherwise host profile -> job and tool job -> profile form a deadlock.
-- Office lifecycle and recovery RPCs retain their profile-first ordering;
-- neither calls this validator or takes the active native job lock afterward.
do $$
declare
 v_target regprocedure := 'public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure;
 v_definition text := pg_get_functiondef(v_target);
 v_old text := E'\tselect profile_id into v_profile from public.qorpera_member_compute_identities where id = p_compute_identity_id;';
 v_new text;
begin
 v_new := E'\t-- Match the complete stored execution tuple before locking a job. This\n'
  || E'\t-- is only a lock selector; all current authority checks below still run\n'
  || E'\t-- after the lock wait, including pause, recovery and lease validity.\n'
  || E'\tperform 1 from public.qorpera_runner_jobs job\n'
  || E'\tjoin public.qorpera_execution_runs run on run.id=job.run_id and run.job_id=job.id\n'
  || E'\tjoin public.qorpera_native_provider_connection_leases lease on lease.job_id=job.id and lease.run_id=run.id\n'
  || E'\tjoin public.qorpera_member_compute_identities identity on identity.id=run.compute_identity_id and identity.profile_id=run.profile_id\n'
  || E'\twhere job.id=p_job_id and run.id=p_run_id and job.runner_id=p_runner_id\n'
  || E'\t and job.client_lease_id=p_assignment_id and lease.id=p_lease_id\n'
  || E'\t and lease.runner_id=p_runner_id and lease.assignment_id=p_assignment_id\n'
  || E'\t and lease.credential_capsule_id=p_credential_capsule_id\n'
  || E'\t and lease.compute_identity_id=p_compute_identity_id and identity.id=p_compute_identity_id\n'
  || E'\tfor update of job;\n'
  || E'\tif not found then raise exception ''native execution binding is unavailable'' using errcode=''42501''; end if;\n'
  || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Native recovery validator lock selector differs';
 end if;
 -- CREATE OR REPLACE preserves the existing owner and grants, including the
 -- restricted secret-broker entry path. No authority predicate is replaced.
 execute replace(v_definition,v_old,v_new);
end $$;

-- These RPCs can be called directly, without the job lock normally held by
-- runner failure/settlement. Lock their exact run/job pair before the run so
-- they cannot invert the native validator's job -> run order.
do $$
declare
 v_target regprocedure := 'public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure;
 v_definition text := pg_get_functiondef(v_target);
 v_old text := E'\tselect * into v_run from public.qorpera_execution_runs where id = p_run_id for update;';
 v_new text;
begin
 v_new := E'\tperform 1 from public.qorpera_runner_jobs job\n'
  || E'\tjoin public.qorpera_execution_runs run on run.id=job.run_id and run.job_id=job.id\n'
  || E'\twhere run.id=p_run_id for update of job;\n' || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Sponsor handoff run lock selector differs';
 end if;
 execute replace(v_definition,v_old,v_new);
end $$;

do $$
declare
 v_target regprocedure := 'public.qorpera_resolve_failed_execution_run(uuid,text)'::regprocedure;
 v_definition text := pg_get_functiondef(v_target);
 v_old text := E'\tselect run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id for update;';
 v_new text;
begin
 -- Reject an unauthorized member before taking any job lock. The existing
 -- company access check remains in place after both locks as well.
 v_new := E'\tperform 1 from public.qorpera_runner_jobs job\n'
  || E'\tjoin public.qorpera_execution_runs run on run.id=job.run_id and run.job_id=job.id\n'
  || E'\twhere run.id=p_run_id and auth.uid() is not null\n'
  || E'\t and public.qorpera_can_write_profile(run.profile_id) for update of job;\n'
  || E'\tif not found then\n'
  || E'\t\traise exception ''execution recovery requires company write access'' using errcode = ''42501'';\n'
  || E'\tend if;\n' || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Failed execution recovery run lock selector differs';
 end if;
 execute replace(v_definition,v_old,v_new);
end $$;
