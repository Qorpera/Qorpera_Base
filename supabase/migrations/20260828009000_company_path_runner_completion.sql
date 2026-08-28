-- A governed run commits individual path effects while it works. Completion
-- records those existing receipts; it never republishes a whole-company tree.
-- Selection is cloud-owned and explicit, with no fallback for an enrolled firm.

alter function public.qorpera_runner_broker_describe(uuid,text,uuid,text)
	rename to qorpera_runner_broker_describe_before_path_runtime;
revoke all on function public.qorpera_runner_broker_describe_before_path_runtime(uuid,text,uuid,text)
	from public,anon,authenticated,service_role;

create function public.qorpera_runner_broker_describe(p_runner_id uuid,p_session_token_sha256 text,
	p_job_id uuid,p_lease_token_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_description jsonb; v_mode text;
begin
	v_description := public.qorpera_runner_broker_describe_before_path_runtime(
		p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	select case when file.path_gateway_version = 1 then 'company-path-v1' else 'whole-tree-v1' end into strict v_mode
	from public.qorpera_company_files file join public.qorpera_runner_jobs job on job.environment_id = file.environment_id
	where job.id = p_job_id;
	return v_description || jsonb_build_object('company_runtime',v_mode);
end
$$;
revoke all on function public.qorpera_runner_broker_describe(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.qorpera_runner_broker_describe(uuid,text,uuid,text) to service_role;

alter function public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)
	rename to qorpera_complete_runner_job_before_path_runtime;
revoke all on function public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)
	from public,anon,authenticated,service_role;
-- Older RPC generations remain implementation helpers, not alternative public
-- completion routes that can omit the current run/result/authority contract.
revoke all on function public.qorpera_complete_runner_job_v2(uuid,text,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_complete_runner_job_v4(uuid,text,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_complete_runner_job_v5(uuid,text,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.qorpera_complete_runner_job_v6(
	p_runner_id uuid,p_session_token_sha256 text,p_job_id uuid,p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,p_client_substrate_version_id uuid,p_output_snapshot_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_binding jsonb; v_actor jsonb; v_receipt jsonb; v_hash text; v_mode integer; v_started jsonb;
	v_last_snapshot uuid; v_applied jsonb; v_proposed jsonb; v_count integer; v_final uuid;
	v_transcript_end bigint := 0; v_disposition text := 'unchanged'; v_completed_inputs integer;
begin
	if auth.role() is distinct from 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id,p_session_token_sha256) then
		raise exception 'Runner completion authority is unavailable' using errcode = '42501'; end if;
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id and runner_id = p_runner_id for update;
	if not found then raise exception 'Runner job lease is unavailable' using errcode = '40001'; end if;
	select path_gateway_version into v_mode from public.qorpera_company_files where environment_id = v_job.environment_id;
	if v_mode is distinct from 1 then
		if p_result ->> 'runtime' = 'company-path-v1' then
			raise exception 'Company runtime selection changed' using errcode = '42501'; end if;
		return public.qorpera_complete_runner_job_before_path_runtime(p_runner_id,p_session_token_sha256,
			p_job_id,p_lease_token_sha256,p_client_artifact_index_id,p_client_substrate_version_id,p_output_snapshot_id,p_result);
	end if;
	if p_output_snapshot_id is not null or p_client_artifact_index_id is null or p_client_substrate_version_id is null
		or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 49152
		or p_result ->> 'schema' is distinct from 'qorpera.runner-result/v1'
		or p_result ->> 'runtime' is distinct from 'company-path-v1'
		or p_result ->> 'backend' is distinct from 'native-company-runtime'
		or p_result - array['schema','runtime','backend','native_lease_id','substrate_version_id',
			'backend_result','output_count','output_bytes','publication','usage'] <> '{}'::jsonb
		or p_result -> 'publication' is distinct from 'null'::jsonb
		or p_result -> 'output_count' is distinct from '0'::jsonb
		or p_result -> 'output_bytes' is distinct from '0'::jsonb
		or p_result ->> 'substrate_version_id' is distinct from v_job.substrate_version_id::text then
		raise exception 'Governed completion cannot publish a whole Company File or artifacts' using errcode = '22023'; end if;
	v_hash := encode(extensions.digest(convert_to(p_result::text,'utf8'),'sha256'),'hex');
	select * into v_existing from public.qorpera_execution_run_results where job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 is distinct from p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id or v_existing.result_sha256 <> v_hash
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id then
			raise exception 'Runner completion replay differs from its receipt' using errcode = '23505'; end if;
		-- Receipt replay conveys no new read, write, model call or public send.
		return public.qorpera_runner_job_json(v_job);
	end if;
	v_job := public.qorpera_runner_broker_locked_job(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	select * into strict v_run from public.qorpera_execution_runs where id = v_job.run_id;
	select * into v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_result ->> 'native_lease_id')::uuid and run_id = v_run.id and job_id = v_job.id;
	if not found then raise exception 'Native completion authority is unavailable' using errcode = '42501'; end if;
	v_binding := jsonb_build_object('leaseId',v_lease.id,'runId',v_run.id,'jobId',v_job.id,'runnerId',p_runner_id,
		'assignmentId',v_job.client_lease_id,'credentialCapsuleId',v_lease.credential_capsule_id,
		'computeIdentityId',v_run.compute_identity_id,'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,v_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	select payload into v_started from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1';
	if not found or v_started ->> 'runId' is distinct from v_run.id::text
		or v_started ->> 'jobId' is distinct from v_job.id::text
		or v_started ->> 'leaseId' is distinct from v_lease.id::text
		or coalesce(v_started ->> 'binarySha256','') !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution has no matching durable admission' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_runner_model_requests where job_id = v_job.id and status = 'reserved')
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous'))
		or exists(select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then
		raise exception 'Governed execution has unresolved or ungoverned work' using errcode = '55000'; end if;
	-- Every required effect already has its exact, atomic path revision or
	-- proposal. Different operations need not (and usually will not) share a head.
	if exists(select 1 from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id
		and receipt.status = 'completed' and (receipt.requires_company_revision or receipt.output_snapshot_id is not null
			or receipt.company_path_proposal_id is not null or receipt.proposal_id is not null) and not (
			exists(select 1 from public.qorpera_company_path_revisions revision
				where revision.receipt_id = receipt.id and revision.run_id = v_run.id
					and revision.environment_id = v_run.environment_id and revision.snapshot_id = receipt.output_snapshot_id)
			or exists(select 1 from public.qorpera_company_path_proposals proposal
				where proposal.receipt_id = receipt.id and proposal.run_id = v_run.id
					and proposal.environment_id = v_run.environment_id and proposal.id = receipt.company_path_proposal_id)
		)) then raise exception 'Governed completion omitted a path effect receipt' using errcode = '55000'; end if;
	v_receipt := p_result -> 'backend_result';
	select count(*),max(delivery.event_id::text) filter(where delivery.phase = 'final'),coalesce(max(event.sequence),0)
	into v_count,v_final,v_transcript_end from public.qorpera_agent_sends delivery
	join public.qorpera_session_events event on event.event_id = delivery.event_id
	where delivery.run_id = v_run.id and delivery.assignment_id = v_job.client_lease_id;
	if jsonb_typeof(v_receipt) is distinct from 'object'
		or v_receipt - array['schema','run_id','message_count','final_message_id','provider_session_id'] <> '{}'::jsonb
		or v_receipt ->> 'schema' is distinct from 'qorpera.native-harness-result/v2'
		or v_receipt ->> 'run_id' is distinct from v_run.id::text
		or v_receipt -> 'message_count' is distinct from to_jsonb(v_count)
		or v_receipt -> 'final_message_id' is distinct from coalesce(to_jsonb(v_final),'null'::jsonb)
		or (v_run.session_id is not null and (v_final is null or v_transcript_end <= v_run.transcript_start_sequence))
		or (v_run.session_id is null and v_count <> 0)
		or jsonb_typeof(v_receipt -> 'provider_session_id') is distinct from 'string'
		or char_length(btrim(v_receipt ->> 'provider_session_id')) not between 1 and 1024 then
		raise exception 'Native completion does not match durable public delivery' using errcode = '55000'; end if;
	perform public.qorpera_bind_execution_provider_session(p_runner_id,p_session_token_sha256,p_job_id,
		p_lease_token_sha256,v_receipt ->> 'provider_session_id',null);
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_applied
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null;
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_proposed
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.company_path_proposal_id is not null;
	select receipt.output_snapshot_id into v_last_snapshot from public.qorpera_run_operation_receipts receipt
	where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null order by receipt.completed_at desc,receipt.id desc limit 1;
	if v_last_snapshot is not null then v_disposition := 'published'; end if;
	-- Uses the existing job/usage bookkeeping and final-send trigger. Terminal
	-- job cleanup releases native authority in this same database transaction.
	perform public.qorpera_complete_runner_job_v4(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256,
		p_client_artifact_index_id,p_client_substrate_version_id,p_result);
	update public.qorpera_runner_jobs set result = result || jsonb_build_object('company_file',jsonb_build_object(
		'runtime','company-path-v1','disposition',v_disposition,'output_snapshot_id',v_last_snapshot,'proposal_id',null,
		'native_binary_sha256',v_started ->> 'binarySha256',
		'applied_receipt_ids',v_applied,'proposal_receipt_ids',v_proposed)) where id = v_job.id returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then raise exception 'Runner completion receipt is too large' using errcode = '54000'; end if;
	insert into public.qorpera_execution_run_results(run_id,job_id,assignment_id,runner_id,transcript_end_sequence,
		company_disposition,output_snapshot_id,proposal_id,client_artifact_index_id,client_substrate_version_id,result_sha256)
	values(v_run.id,v_job.id,v_job.client_lease_id,p_runner_id,v_transcript_end,v_disposition,v_last_snapshot,null,
		p_client_artifact_index_id,p_client_substrate_version_id,v_hash);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs set completed_at = clock_timestamp()
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise exception 'Runner session inputs changed before completion' using errcode = '40001'; end if;
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$$;
revoke all on function public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb) to service_role;
