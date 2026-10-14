-- 20260930246000: the legacy sweep, step F1c (a runtime tool call's run check, its receipts and its provider
-- lease). Six functions keep only their folder-v2 path (folder-v2 only, the founder's decision of 3 October):
-- - qorpera_native_tool_locked_run, the run check under every runtime tool call, returns qorpera_folder_tool_run's run;
-- - qorpera_begin_native_tool_operation and qorpera_complete_native_tool_operation hand every receipt to the folder
--   core (the completion still refuses a snapshot or a proposal first);
-- - qorpera_validate_native_provider_execution_lease hands every check to qorpera_folder_validate_native_lease, so its
--   snapshot-v1 base check has no caller left and goes
--   (qorpera_validate_native_provider_execution_lease_before_recover, the name cut to 63 characters);
-- - qorpera_renew_native_provider_connection_lease takes the job through qorpera_folder_renewal_locked_job;
-- - qorpera_resolve_run_operation_receipt hands every recovery to qorpera_folder_resolve_run_receipt.
-- Each folder-v2 path is the live text; create or replace keeps every grant, default and setting.

set local lock_timeout = '3s';

create or replace function public.qorpera_native_tool_locked_run(p_binding jsonb)
returns public.qorpera_execution_runs language plpgsql security definer set search_path = '' as $function$
declare
	v_run public.qorpera_execution_runs%rowtype;
begin
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so the folder core checks every run.
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	return v_run;
end
$function$;

create or replace function public.qorpera_begin_native_tool_operation(p_binding jsonb, p_receipt_id uuid,
	p_logical_operation_key text, p_input_sha256 text, p_downstream_idempotency_sha256 text,
	p_requires_company_revision boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so the folder core begins every receipt.
	return public.qorpera_folder_begin_run_receipt(p_binding, p_receipt_id, p_logical_operation_key, p_input_sha256,
		p_downstream_idempotency_sha256, p_requires_company_revision);
end
$function$;

create or replace function public.qorpera_complete_native_tool_operation(p_binding jsonb, p_receipt_id uuid,
	p_input_sha256 text, p_result jsonb, p_output_snapshot_id uuid default null, p_proposal_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so the folder core completes every receipt.
	if p_output_snapshot_id is not null or p_proposal_id is not null then
		raise exception 'A folder-v2 operation completes with its folder commit' using errcode = '22023'; end if;
	return public.qorpera_folder_complete_run_receipt(p_binding, p_receipt_id, p_input_sha256, p_result, null);
end
$function$;

create or replace function public.qorpera_validate_native_provider_execution_lease(p_lease_id uuid, p_run_id uuid,
	p_job_id uuid, p_runner_id uuid, p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid,
	p_provider text, p_native_harness text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '25s'
set statement_timeout = '25s' as $function$
begin
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so the folder core checks every lease.
	return public.qorpera_folder_validate_native_lease(p_lease_id, p_run_id, p_job_id, p_runner_id, p_assignment_id,
		p_credential_capsule_id, p_compute_identity_id, p_provider, p_native_harness);
end
$function$;

drop function public.qorpera_validate_native_provider_execution_lease_before_recover(uuid, uuid, uuid, uuid, uuid, uuid,
	uuid, text, text);

create or replace function public.qorpera_renew_native_provider_connection_lease(p_lease_id uuid, p_runner_id uuid,
	p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_seconds not between 30 and 900 then
		raise exception 'native provider lease renewal is invalid' using errcode = '42501';
	end if;
	-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run's tool calls (KEY SHARE).
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so every renewal.
	v_job := public.qorpera_folder_renewal_locked_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);
	select lease.* into v_lease
	from public.qorpera_native_provider_connection_leases as lease
	where lease.id = p_lease_id and lease.job_id = v_job.id
		and lease.runner_id = p_runner_id
		and lease.lease_token_sha256 = p_lease_token_sha256
	for update;
	if not found or v_lease.status <> 'active'
		or v_lease.expires_at <= statement_timestamp() then
		raise exception 'native provider lease is unavailable' using errcode = '55000';
	end if;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = v_lease.run_id and run.job_id = v_job.id;
	if not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run)
		or not exists (
			select 1
			from public.qorpera_execution_sponsor_versions as sponsor
			join public.qorpera_provider_connections as connection
				on connection.id = sponsor.provider_connection_id
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = version.credential_capsule_id
			join public.qorpera_member_compute_identities as identity
				on identity.id = v_run.compute_identity_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = 'native_subscription'
				and policy.native_harness = version.native_harness
			where sponsor.binding_id = v_run.sponsor_binding_id
				and sponsor.version = v_run.sponsor_version
				and sponsor.provider_connection_id = v_lease.provider_connection_id
				and sponsor.provider_connection_version = v_lease.provider_connection_version
				and connection.status = 'active'
				and version.authentication_mode = 'native_subscription'
				and version.authorization_state = 'active'
				and capsule.id = v_lease.credential_capsule_id
				and capsule.compute_identity_id = v_lease.compute_identity_id
				and capsule.status = 'active'
				and identity.status = 'active'
				and policy.implementation_status = 'supported'
				and policy.enablement_status = 'enabled'
		) then
		raise exception 'native provider authority was revoked' using errcode = '42501';
	end if;
	update public.qorpera_native_provider_connection_leases
	set expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where id = v_lease.id
	returning * into v_lease;
	return jsonb_build_object(
		'lease_id', v_lease.id,
		'run_id', v_lease.run_id,
		'status', v_lease.status,
		'expires_at', v_lease.expires_at
	);
end
$function$;

create or replace function public.qorpera_resolve_run_operation_receipt(p_receipt_id uuid, p_resolution text,
	p_result jsonb default null, p_output_snapshot_id uuid default null, p_proposal_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930246000 (legacy sweep F1c): folder-v2 only, so the folder core resolves every receipt.
	return public.qorpera_folder_resolve_run_receipt(p_receipt_id, p_resolution, p_result, p_output_snapshot_id,
		p_proposal_id);
end
$function$;
