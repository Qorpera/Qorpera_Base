-- Native generation is an execution attempt even before its first tool or
-- public send. Keep its start in the existing run ledger, not private VM state.
-- A lost acknowledgement is uncertain: no automatic same-run restart.

create unique index qorpera_native_company_execution_start_once
	on public.qorpera_execution_run_events(run_id)
	where event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1';

create function public.qorpera_begin_native_company_execution(p_binding jsonb,p_binary_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_environment uuid; v_payload jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binary_sha256 is null
		or p_binary_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	select environment_id into strict v_environment from public.qorpera_execution_runs
	where id = (p_binding ->> 'runId')::uuid;
	v_actor := public.qorpera_company_path_actor(v_environment,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if exists(select 1 from public.qorpera_execution_run_events where run_id = (p_binding ->> 'runId')::uuid
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1') then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	v_payload := jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',p_binding ->> 'runId','jobId',p_binding ->> 'jobId','leaseId',p_binding ->> 'leaseId',
		'binarySha256',p_binary_sha256);
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values((p_binding ->> 'runId')::uuid,'runner_started',v_payload);
	return v_payload;
end
$$;
revoke all on function public.qorpera_begin_native_company_execution(jsonb,text) from public,anon,authenticated;
grant execute on function public.qorpera_begin_native_company_execution(jsonb,text) to service_role;

alter function public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)
	rename to qorpera_terminalize_runner_attempt_before_native_start;
revoke all on function public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)
	from public,anon,authenticated,service_role;

create function public.qorpera_terminalize_runner_attempt(p_job_id uuid,p_terminal_status text,p_reason text,
	p_allow_pristine_retry boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.qorpera_runner_jobs%rowtype; v_started boolean; v_result jsonb;
begin
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id for update;
	v_started := v_job.status in ('queued','leased') and exists(
		select 1 from public.qorpera_execution_run_events where run_id = v_job.run_id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1');
	-- Preserve the existing status/actor/lease/partial-effect bookkeeping. A
	-- started native turn is never a pristine infrastructure retry, even when
	-- it emitted no tool result, provider session id, or user-facing message.
	v_result := public.qorpera_terminalize_runner_attempt_before_native_start(p_job_id,p_terminal_status,
		p_reason,p_allow_pristine_retry and not v_started);
	if v_started then
		insert into public.qorpera_execution_run_events(run_id,event_type,payload)
		values(v_job.run_id,'review_pending',jsonb_build_object('reason','native_execution_uncertain',
			'assignment_id',v_job.client_lease_id));
		update public.qorpera_wake_occurrences set status = 'requires_review',
			blocked_reason = 'Native execution outcome requires review',finished_at = clock_timestamp()
		where run_id = v_job.run_id and status = 'failed';
	end if;
	return v_result;
end
$$;
revoke all on function public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean) to service_role;
