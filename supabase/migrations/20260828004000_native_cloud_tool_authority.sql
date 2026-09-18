-- Step 2: cloud-owned tool identity and the existing durable operation ledger.
-- These service-only RPCs do not grant Company File paths or external effects.
-- An effect adapter must still authorize its exact target at its commit point.
-- No provider credential, runner token, or lease token leaves these functions.

create function public.qorpera_native_tool_locked_run(p_binding jsonb)
returns public.qorpera_execution_runs
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_session_token_sha256 text;
	v_lease_token_sha256 text;
begin
	-- The broker may reach this validator only through its three granted
	-- SECURITY DEFINER custody functions; direct EXECUTE remains revoked.
	if auth.role() is distinct from 'service_role' and session_user <> 'qorpera_secret_broker' then
		raise exception 'native tool host authority is required' using errcode = '42501';
	end if;
	if jsonb_typeof(p_binding) is distinct from 'object'
		or p_binding - array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId',
			'computeIdentityId','provider','nativeHarness','model'] <> '{}'::jsonb
		or not (p_binding ?& array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId',
			'computeIdentityId','provider','nativeHarness','model'])
		or exists (select 1 from jsonb_each(p_binding) as field where jsonb_typeof(field.value) <> 'string')
		or p_binding ->> 'provider' is distinct from 'openai'
		or p_binding ->> 'nativeHarness' is distinct from 'codex-cli' then
		raise exception 'native tool binding is invalid' using errcode = '22023';
	end if;
	-- Match the job-first lock order of public sends, receipts, and completion.
	perform 1 from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid for update;
	perform public.qorpera_validate_native_provider_execution_lease(
		(p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid, (p_binding ->> 'jobId')::uuid,
		(p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid,
		p_binding ->> 'provider', p_binding ->> 'nativeHarness'
	);
	select runner.session_token_sha256 into strict v_session_token_sha256
	from public.qorpera_runners as runner where runner.id = (p_binding ->> 'runnerId')::uuid;
	select job.lease_token_sha256 into strict v_lease_token_sha256
	from public.qorpera_runner_jobs as job where job.id = (p_binding ->> 'jobId')::uuid;
	v_job := public.qorpera_runner_broker_locked_job(
		(p_binding ->> 'runnerId')::uuid, v_session_token_sha256,
		(p_binding ->> 'jobId')::uuid, v_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run
	where run.id = v_job.run_id and run.id = (p_binding ->> 'runId')::uuid for share;
	if v_job.status <> 'leased'
		or v_run.model_provider is distinct from p_binding ->> 'provider'
		or v_run.model_id is distinct from p_binding ->> 'model'
		or v_run.job_type <> 'agent_turn' or v_run.required_capability <> 'agent_turn'
		or v_run.deadline_at <= clock_timestamp() or v_job.lease_expires_at <= clock_timestamp()
		or not exists (
			select 1 from public.qorpera_native_provider_connection_leases as lease
			join public.qorpera_runner_assignments as assignment on assignment.id = lease.assignment_id
			join public.qorpera_runners as runner on runner.id = lease.runner_id
			where lease.id = (p_binding ->> 'leaseId')::uuid
				and lease.status = 'active' and lease.expires_at > clock_timestamp()
				and assignment.status = 'accepted' and assignment.expires_at > clock_timestamp()
				and runner.status = 'active' and runner.session_expires_at > clock_timestamp()
		)
		or not exists (
			select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
		)
		or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id
				and staff.employment_status = 'active'
		) then
		raise exception 'native tool run is unavailable' using errcode = '42501';
	end if;
	return v_run;
end
$$;

create function public.qorpera_describe_native_tool_authority(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_until timestamptz;
	v_remaining bigint;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select lease.* into strict v_lease from public.qorpera_native_provider_connection_leases as lease
	where lease.id = (p_binding ->> 'leaseId')::uuid;
	select least(v_lease.expires_at, job.lease_expires_at, assignment.expires_at, runner.session_expires_at, v_run.deadline_at)
	into strict v_until
	from public.qorpera_runner_jobs as job join public.qorpera_runner_assignments as assignment
		on assignment.id = (p_binding ->> 'assignmentId')::uuid
	join public.qorpera_runners as runner on runner.id = v_lease.runner_id
	where job.id = v_run.job_id;
	-- Use the clock after lock waits, not the start of the SQL statement.
	v_remaining := least(30000, floor(extract(epoch from (v_until - clock_timestamp())) * 1000)::bigint);
	if v_remaining is null or v_remaining <= 0 then
		raise exception 'native tool authority expired' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.native-tool-authority/v1', 'validForMs', v_remaining,
		'identity', jsonb_build_object(
			'companyId', v_run.profile_id, 'environmentId', v_run.environment_id,
			'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', v_lease.runner_id,
			'assignmentId', v_lease.assignment_id, 'leaseId', v_lease.id,
			'computeIdentityId', v_run.compute_identity_id,
			'staffAgentId', v_run.staff_agent_id, 'staffVersion', v_run.staff_version,
			'sessionId', v_run.session_id, 'requesterUserId', v_run.requested_by_user_id,
			'sponsorUserId', v_run.sponsored_by_user_id,
			'sponsorBindingId', v_run.sponsor_binding_id, 'sponsorVersion', v_run.sponsor_version,
			'providerConnectionId', v_lease.provider_connection_id,
			'providerConnectionVersion', v_lease.provider_connection_version,
			'provider', v_run.model_provider, 'nativeHarness', 'codex-cli', 'model', v_run.model_id
		)
	);
end
$$;

create function public.qorpera_begin_native_tool_operation(
	p_binding jsonb, p_receipt_id uuid, p_logical_operation_key text,
	p_input_sha256 text, p_downstream_idempotency_sha256 text,
	p_requires_company_revision boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_session_token_sha256 text;
	v_lease_token_sha256 text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_input_sha256 is null or p_downstream_idempotency_sha256 is null
		or p_requires_company_revision is null then
		raise exception 'native tool operation is invalid' using errcode = '22023';
	end if;
	select session_token_sha256 into strict v_session_token_sha256 from public.qorpera_runners
	where id = (p_binding ->> 'runnerId')::uuid;
	select lease_token_sha256 into strict v_lease_token_sha256 from public.qorpera_runner_jobs
	where id = v_run.job_id;
	return public.qorpera_begin_run_operation_receipt(
		(p_binding ->> 'runnerId')::uuid, v_session_token_sha256, v_run.job_id, v_lease_token_sha256,
		(p_binding ->> 'assignmentId')::uuid, p_receipt_id, p_logical_operation_key, 'cloud_tool',
		p_input_sha256, p_downstream_idempotency_sha256, p_requires_company_revision
	) || jsonb_build_object('run_id', v_run.id);
end
$$;

create function public.qorpera_complete_native_tool_operation(
	p_binding jsonb, p_receipt_id uuid, p_input_sha256 text, p_result jsonb,
	p_output_snapshot_id uuid default null, p_proposal_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_session_token_sha256 text;
	v_lease_token_sha256 text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_input_sha256 is null or p_result is null then
		raise exception 'native tool completion is invalid' using errcode = '22023';
	end if;
	select session_token_sha256 into strict v_session_token_sha256 from public.qorpera_runners
	where id = (p_binding ->> 'runnerId')::uuid;
	select lease_token_sha256 into strict v_lease_token_sha256 from public.qorpera_runner_jobs
	where id = v_run.job_id;
	return public.qorpera_complete_run_operation_receipt(
		(p_binding ->> 'runnerId')::uuid, v_session_token_sha256, v_run.job_id, v_lease_token_sha256,
		(p_binding ->> 'assignmentId')::uuid, p_receipt_id, p_input_sha256, p_result,
		p_output_snapshot_id, p_proposal_id
	) || jsonb_build_object('run_id', v_run.id);
end
$$;

-- Supabase defaults can grant API roles directly; revoke each role explicitly.
revoke all on function public.qorpera_native_tool_locked_run(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_describe_native_tool_authority(jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.qorpera_describe_native_tool_authority(jsonb) to service_role;
grant execute on function public.qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean) to service_role;
grant execute on function public.qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid) to service_role;
