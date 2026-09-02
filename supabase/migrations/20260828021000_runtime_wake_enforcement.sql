-- Runtime Step 3 (contract Order 3): shared wake-bus enforcement.
-- The reply and silence policy of the admitted wake (qorpera_runtime_wake_policy,
-- immutable occurrence + routine version, never job payloads or prompt text) is
-- now enforced by the kernel at four seams (contract 6.3, 7.1, 7.2, 8):
--   1. canonical public send admission: forbidden phases, required
--      acknowledgement before the final report, and the public-send budget;
--   2. every governed native operation start and every model-requested
--      Company File read or list: no hidden work before a required
--      acknowledgement, and no work after the final report;
--   3. governed completion: silence is a valid terminal result only when the
--      wake policy permits it, without inventing a transcript event;
--   4. wake materialization: a session bound to a wake run follows the head
--      and staff version the run pins, exactly as session turns already do,
--      so canonical delivery after an authorized File advance is admitted.
-- Trusted context assembly, the native execution admission and the explicit
-- public send itself are not work and stay unguarded. Existing privileges are
-- preserved by CREATE OR REPLACE.

-- 1. Canonical send admission (was 20260827004000_cloud_agent_public_mouth.sql).
create or replace function public.qorpera_send_runner_agent_message(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_idempotency_key text,
	p_text text,
	p_phase text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_delivery public.qorpera_agent_sends%rowtype;
	v_event public.qorpera_session_events%rowtype;
	v_event_id uuid := extensions.gen_random_uuid();
	v_text_sha256 text;
	v_parent_id text;
	v_body jsonb;
	v_result jsonb;
	v_policy jsonb;
	v_sent integer;
	v_progress integer;
begin
	-- This locks the job and rechecks sponsor, company membership, deadline,
	-- compute identity and the current lease at the effect boundary.
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.session_id is null or v_job.job_type <> 'agent_turn'
		or p_assignment_id is distinct from v_job.client_lease_id
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.run_id = v_run.id
				and assignment.job_id = v_job.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted' and assignment.expires_at > statement_timestamp()
		) then
		raise exception 'agent send audience or assignment is unavailable' using errcode = '42501';
	end if;
	if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or p_text is null or p_text !~ '[^[:space:]]'
		or octet_length(convert_to(p_text, 'utf8')) > 65536
		or p_phase is null or p_phase not in ('progress', 'final') then
		raise exception 'agent send arguments are invalid' using errcode = '22023';
	end if;
	v_text_sha256 := encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
	select delivery.* into v_delivery from public.qorpera_agent_sends as delivery
	where delivery.run_id = v_run.id and delivery.idempotency_key = p_idempotency_key;
	if found then
		if v_delivery.text_sha256 <> v_text_sha256 or v_delivery.phase <> p_phase then
			raise exception 'agent send key is bound to different content' using errcode = '23505';
		end if;
		select event.* into strict v_event from public.qorpera_session_events as event where event.event_id = v_delivery.event_id;
		return jsonb_build_object(
			'schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_delivery.session_id,
			'messageId', v_delivery.event_id, 'phase', v_delivery.phase, 'sequence', v_event.sequence
		);
	end if;
	if exists (select 1 from public.qorpera_agent_sends as delivery where delivery.run_id = v_run.id and delivery.phase = 'final') then
		raise exception 'agent public output is already final' using errcode = '55000';
	end if;
	-- Wake policy at admission (contract 7.2): phase legality, required
	-- acknowledgement before the final report, and the public-send budget.
	v_policy := public.qorpera_runtime_wake_policy(v_run.id);
	select count(*), count(*) filter (where delivery.phase = 'progress') into v_sent, v_progress
	from public.qorpera_agent_sends as delivery where delivery.run_id = v_run.id;
	if (p_phase = 'progress' and v_policy ->> 'initial' = 'forbidden')
		or (p_phase = 'final' and v_policy ->> 'final' = 'forbidden') then
		raise exception 'wake policy forbids public output' using errcode = '55000';
	end if;
	if v_sent >= (v_policy ->> 'maxPublicSends')::integer then
		raise exception 'wake public send budget is exhausted' using errcode = '55000';
	end if;
	if p_phase = 'final' and v_policy ->> 'initial' = 'required' and v_progress = 0 then
		raise exception 'wake requires an acknowledgement before its final report' using errcode = '55000';
	end if;
	-- Serialize against all other session writers before selecting the parent.
	perform 1 from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	select coalesce(event.body #>> '{entry,id}', event.body ->> 'entryId') into v_parent_id
	from public.qorpera_session_events as event
	where event.session_id = v_run.session_id and (
		(event.body #>> '{entry,id}') is not null or
		(event.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
			and (event.body ->> 'partIndex')::integer = (event.body ->> 'partCount')::integer - 1)
	) order by event.sequence desc limit 1;
	v_body := jsonb_build_object(
		'schema', 'qorpera.runner-transcript-entry/v1',
		'entry', jsonb_build_object(
			'type', 'message', 'id', v_event_id, 'parentId', v_parent_id,
			'timestamp', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))),
			'delivery', jsonb_build_object('schema', 'qorpera.agent-send/v1', 'phase', p_phase),
			'execution', jsonb_build_object('kind', 'run', 'id', v_run.id, 'claimantId', v_run.id, 'runnerAssignmentId', p_assignment_id)
		)
	);
	insert into public.qorpera_agent_sends (event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
	values (v_event_id, v_run.id, v_run.session_id, p_assignment_id, p_idempotency_key, p_phase, v_text_sha256,
		encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'));
	v_result := public.qorpera_append_runner_transcript_event(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_event_id, 'message', v_body, null
	);
	return jsonb_build_object(
		'schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_run.session_id,
		'messageId', v_event_id, 'phase', p_phase, 'sequence', (v_result ->> 'sequence')::bigint
	);
end
$$;

-- 2a. Governed native operation start (was 20260828004000_native_cloud_tool_authority.sql).
create or replace function public.qorpera_begin_native_tool_operation(
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
	-- No governed effect before a required acknowledgement or after the final report (contract 7.1).
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
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

-- 2b. Model-requested Company File read (was 20260828019800_runtime_read_observations.sql).
create or replace function public.qorpera_read_company_path_v2(
	p_environment_id uuid,p_path text,p_offset integer,p_limit integer,p_binding jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_read jsonb; v_snapshot uuid; v_id uuid; v_kind text;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Native read provenance requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	-- A model-requested read is hidden work (contract 7.1); trusted context assembly does not use this entry.
	perform public.qorpera_assert_wake_work_allowed((v_actor ->> 'runId')::uuid);
	if p_offset is null or p_offset not between 0 and 268435456 or p_limit is null or p_limit not between 4 and 4096 then
		raise exception 'Read range is invalid' using errcode = '22023'; end if;
	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
	v_read := public.qorpera_read_company_path(p_environment_id,p_path,p_binding);
	select head_snapshot_id into strict v_snapshot from public.qorpera_company_files where environment_id = p_environment_id;
	v_kind := coalesce(v_read #>> '{entry,kind}','absent');
	if v_kind = 'file' and p_offset > (v_read #>> '{entry,file,bytes}')::bigint then
		raise exception 'Read range exceeds the file' using errcode = '22023'; end if;
	insert into public.qorpera_company_read_observations(run_id,environment_id,snapshot_id,path,kind,version,source,requested_offset,requested_limit)
	values ((v_actor ->> 'runId')::uuid,p_environment_id,v_snapshot,p_path,v_kind,(v_read ->> 'version')::uuid,
		v_read,p_offset,p_limit) returning id into v_id;
	return v_read || jsonb_build_object('snapshotId',v_snapshot,'readObservationId',v_id);
end
$$;

-- 2b. Model-requested Company File read (was 20260828019800_runtime_read_observations.sql).
create or replace function public.qorpera_list_company_paths_v2(
	p_environment_id uuid,p_path text,p_after text,p_snapshot_id uuid,p_limit integer,p_binding jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_page jsonb; v_id uuid;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Native read provenance requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	-- A model-requested read is hidden work (contract 7.1); trusted context assembly does not use this entry.
	perform public.qorpera_assert_wake_work_allowed((v_actor ->> 'runId')::uuid);
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Native page size is invalid' using errcode = '22023'; end if;
	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
	v_page := public.qorpera_list_company_paths(p_environment_id,p_path,p_after,p_snapshot_id,p_limit,p_binding);
	insert into public.qorpera_company_read_observations(run_id,environment_id,snapshot_id,path,kind,source,requested_offset,requested_limit)
	values((v_actor ->> 'runId')::uuid,p_environment_id,(v_page ->> 'snapshotId')::uuid,p_path,'list',
		jsonb_build_object('page',v_page,'after',p_after,'limit',p_limit),0,0) returning id into v_id;
	return v_page || jsonb_build_object('readObservationId',v_id);
end
$$;

-- 3a. Governed completion (was 20260828009000_company_path_runner_completion.sql).
create or replace function public.qorpera_complete_runner_job_v6(
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
	-- Server-owned wake policy decides whether silence is a valid terminal result
	-- (contract 6.3, 7.2); a silent completion invents no transcript event.
	perform public.qorpera_assert_wake_completion(v_run.id);
	if v_count = 0 then v_transcript_end := v_run.transcript_start_sequence; end if;
	if jsonb_typeof(v_receipt) is distinct from 'object'
		or v_receipt - array['schema','run_id','message_count','final_message_id','provider_session_id'] <> '{}'::jsonb
		or v_receipt ->> 'schema' is distinct from 'qorpera.native-harness-result/v2'
		or v_receipt ->> 'run_id' is distinct from v_run.id::text
		or v_receipt -> 'message_count' is distinct from to_jsonb(v_count)
		or v_receipt -> 'final_message_id' is distinct from coalesce(to_jsonb(v_final),'null'::jsonb)
		or (v_run.session_id is null and v_count <> 0)
		or (v_count > 0 and (v_final is null or v_transcript_end <= v_run.transcript_start_sequence))
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

-- 3b. The job-terminal trigger consults the same policy instead of assuming
-- every conversation turn owes a final send.
create or replace function public.qorpera_require_final_agent_send()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_policy jsonb;
begin
	if new.status = 'completed' and old.status is distinct from 'completed'
		and new.job_type = 'agent_turn' and exists (
			select 1 from public.qorpera_execution_runs as run
			where run.id = new.run_id and run.session_id is not null
		) then
		-- Only the service role holds wake-policy authority; any other writer keeps the strict rule.
		v_policy := case when auth.role() = 'service_role' then public.qorpera_runtime_wake_policy(new.run_id)
			else public.qorpera_wake_policy_value(null) end;
		if v_policy ->> 'final' = 'required' and not exists (
			select 1 from public.qorpera_agent_sends as delivery
			join public.qorpera_session_events as event on event.event_id = delivery.event_id
			where delivery.run_id = new.run_id and delivery.phase = 'final'
				and event.execution_id = new.run_id
		) then
			raise exception 'agent conversation turn requires a final send' using errcode = '55000';
		end if;
	end if;
	return new;
end
$$;

-- 4. A conversation keeps the head it pinned; a wake run admitted later pins
-- the current head. Canonical delivery from that run is admitted when the run's
-- head follows the conversation's pin through the linear successor chain of
-- the same environment. Identity, audience, staff version, authority and the
-- event hash chain are unchanged.
create function public.qorpera_run_head_follows_session_pin(p_run public.qorpera_execution_runs, p_session_snapshot_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_session_snapshot_id = p_run.company_snapshot_id
		or (p_run.source_kind = 'wake' and exists (
			with recursive successor(snapshot_id, depth) as (
				select p_session_snapshot_id, 0
				union all
				select revision.snapshot_id, successor.depth + 1
				from public.qorpera_company_path_revisions as revision
				join successor on successor.snapshot_id = revision.parent_snapshot_id
				where revision.environment_id = p_run.environment_id and successor.depth < 4096
			)
			select 1 from successor where successor.snapshot_id = p_run.company_snapshot_id and successor.depth > 0))
$$;
revoke all on function public.qorpera_run_head_follows_session_pin(public.qorpera_execution_runs, uuid) from public, anon, authenticated, service_role;

-- 4b. Canonical transcript append (was 20260820002000_runner_orchestrator_contracts.sql).
create or replace function public.qorpera_append_runner_transcript_event(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.id is null or v_run.session_id is null or p_event_id is null
		or p_event_type not in (
			'message', 'run_receipt', 'artifact_receipt',
			'authorization_request', 'authorization_decision'
		) or p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144
		or coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or coalesce(jsonb_typeof(p_body -> 'entry'), '') <> 'object'
		or coalesce(p_body #>> '{entry,id}', '') <> p_event_id::text
		or not public.qorpera_runner_transcript_entry_valid(p_event_type, p_body)
		or coalesce(p_body #>> '{entry,execution,kind}', '') <> 'run'
		or coalesce(p_body #>> '{entry,execution,id}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,claimantId}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,runnerAssignmentId}', '') <> p_assignment_id::text
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'runner transcript authority is invalid' using errcode = '42501';
	end if;
	select event.* into v_existing
	from public.qorpera_session_events as event where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> v_run.session_id or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body or v_existing.execution_kind <> 'run'
			or v_existing.execution_id <> v_run.id
			or v_existing.execution_claimant_id <> v_run.id then
			raise exception 'runner event id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id, 'sequence', v_existing.sequence,
			'event_id', v_existing.event_id, 'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id, 'body', v_existing.body,
			'previous_hash', v_existing.previous_hash, 'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind, 'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'runner_assignment_id', v_existing.runner_assignment_id,
			'created_at', v_existing.created_at
		);
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	if not found or v_session.status <> 'open'
		or v_session.profile_id <> v_run.profile_id or v_session.environment_id <> v_run.environment_id
		or not public.qorpera_run_head_follows_session_pin(v_run, v_session.company_snapshot_id)
		or v_session.staff_version <> v_run.staff_version then
		raise exception 'runner transcript session pins changed' using errcode = '40001';
	end if;
	if jsonb_typeof(p_body #> '{entry,parentId}') = 'string'
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body #>> '{entry,id}' = p_body #>> '{entry,parentId}'
		)
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
				and parent.body ->> 'entryId' = p_body #>> '{entry,parentId}'
				and jsonb_typeof(parent.body -> 'partIndex') = 'number'
				and jsonb_typeof(parent.body -> 'partCount') = 'number'
			group by parent.body ->> 'entryId', parent.body ->> 'partCount',
				parent.execution_kind, parent.execution_id, parent.execution_claimant_id
			having count(distinct (parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer
				and min((parent.body ->> 'partIndex')::integer) = 0
				and max((parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer - 1
		) then
		raise exception 'runner transcript parent is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_execution_run_budgets
	set transcript_event_count = transcript_event_count + 1,
		transcript_bytes = transcript_bytes + octet_length(convert_to(p_body::text, 'utf8'))
	where run_id = v_run.id and transcript_event_count < 2000
		and transcript_bytes + octet_length(convert_to(p_body::text, 'utf8')) <= 67108864;
	if not found then
		raise exception 'runner transcript budget is exhausted' using errcode = '55000';
	end if;
	select event.sequence, event.event_hash into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = v_session.id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session.id,
			'sequence', v_sequence,
			'event_id', p_event_id,
			'event_type', p_event_type,
			'actor_user_id', v_run.created_by_user_id,
			'body', p_body,
			'execution_kind', 'run',
			'execution_id', v_run.id,
			'execution_claimant_id', v_run.id,
			'runner_assignment_id', p_assignment_id,
			'created_at', v_created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, runner_assignment_id, created_at
	) values (
		v_session.id, v_sequence, p_event_id, p_event_type, v_run.created_by_user_id, p_body,
		v_previous_hash, v_event_hash, 'run', v_run.id, v_run.id, p_assignment_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;
	return jsonb_build_object(
		'session_id', v_session.id, 'sequence', v_sequence,
		'event_id', p_event_id, 'event_type', p_event_type,
		'actor_user_id', v_run.created_by_user_id, 'body', p_body,
		'previous_hash', v_previous_hash, 'event_hash', v_event_hash,
		'execution_kind', 'run', 'execution_id', v_run.id,
		'execution_claimant_id', v_run.id, 'runner_assignment_id', p_assignment_id,
		'created_at', v_created_at
	);
end
$$;

-- 5. Audiences. Production conversations are member-private (a member and the
-- Co-Founder) as often as company-wide. The envelope reports the run's real
-- audience, and a routine that must report may use the open member-private
-- conversation of the member who created it when no company conversation
-- exists. Company conversations still take precedence; room, autonomous,
-- group and child-session labels stay excluded; the lock never waits.
create function public.qorpera_wake_public_session(p_profile uuid,p_environment uuid,p_staff uuid,p_requester uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
	select s.id into v_session from public.qorpera_shared_sessions s
	join public.qorpera_profile_staff a on a.profile_id = s.profile_id
		and a.staff_agent_id = p_staff and a.version = s.staff_version and a.employment_status = 'active'
	where s.profile_id = p_profile and s.environment_id = p_environment
		and s.staff_agent_id = p_staff::text and s.status = 'open'
		and (s.audience_kind = 'company' or (p_requester is not null and s.audience_kind = 'member_private'
			and s.audience_user_id = p_requester))
		and not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	order by case when s.audience_kind = 'company' then 0 else 1 end, s.created_at, s.id
	limit 1 for share of s,a nowait;
	return v_session;
end
$$;
revoke all on function public.qorpera_wake_public_session(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.qorpera_wake_public_session(p_profile uuid,p_environment uuid,p_staff uuid)
returns uuid language sql security definer set search_path = '' as $$
	select public.qorpera_wake_public_session(p_profile,p_environment,p_staff,null)
$$;

-- 5b. Occurrence pin selects the audience with the requester (was 20260828020500_runtime_wake_policy_admission.sql).
create or replace function public.qorpera_pin_wake_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_trigger jsonb; v_ancestry jsonb; v_actor uuid;
begin
	if new.wake_schema <> 'qorpera.wake-envelope/v1' or new.wake_kind = 'room' then
		raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
	if new.wake_kind = 'routine' then
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = new.routine_id and version = new.routine_version
			and profile_id = new.profile_id and environment_id = new.environment_id;
		select value into v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = new.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or (new.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (new.source_kind = 'company-file' and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))
			or new.source_kind not in ('schedule','company-file') then
			raise exception 'Wake source does not match its routine' using errcode = '22023'; end if;
		new.staff_agent_id := v_version.staff_agent_id; new.requested_by_user_id := v_version.created_by_user_id;
		new.sponsor_binding_id := v_version.sponsor_binding_id; new.sponsor_version := v_version.sponsor_version;
		new.logical_computer_id := v_version.logical_computer_id;
		new.time_zone := coalesce(v_trigger ->> 'timeZone','UTC');
		new.source_id := coalesce(new.file_event_id,new.routine_id);
		if new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions
			where snapshot_id = new.file_event_id and environment_id = new.environment_id;
			if not found then raise exception 'Wake event is unavailable' using errcode = '42501'; end if;
		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;
	elsif new.wake_kind in ('human','first-run') then
		select * into strict v_run from public.qorpera_execution_runs where id = new.run_id and source_kind = 'session_turn';
		if new.source_kind <> 'input' or new.profile_id <> v_run.profile_id or new.environment_id <> v_run.environment_id
			or not exists(select 1 from public.qorpera_session_inputs where id = new.source_id and id = any(v_run.input_ids)
				and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
				and kind = case when new.wake_kind = 'first-run' then 'kickoff' else 'user_message' end) then
			raise exception 'Wake input identity is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_run.staff_agent_id; new.requested_by_user_id := v_run.requested_by_user_id;
		new.sponsor_binding_id := v_run.sponsor_binding_id; new.sponsor_version := v_run.sponsor_version;
		new.logical_computer_id := v_run.logical_computer_id;
		new.session_id := v_run.session_id;
		if new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Input wake cannot replace causal identity' using errcode = '42501'; end if;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id
			and profile_id = new.profile_id and environment_id = new.environment_id;
		if new.source_kind <> 'coworker' then raise exception 'Coworker source is invalid' using errcode = '22023'; end if;
		v_actor := v_run.staff_agent_id; new.source_id := new.id; new.requested_by_user_id := v_run.requested_by_user_id;
		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;
		if new.file_event_id is not null then raise exception 'Coworker event identity is invalid' using errcode = '42501'; end if;
	else raise exception 'Wake admission is unsupported' using errcode = '42501';
	end if;
	if new.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
		where id = new.parent_run_id and profile_id = new.profile_id and environment_id = new.environment_id) then
		raise exception 'Wake parent belongs to another company' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id
		and staff_agent_id = new.staff_agent_id and employment_status = 'active' for share;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = new.profile_id and user_id = new.requested_by_user_id) then
		raise exception 'Wake recipient authority is unavailable' using errcode = '42501'; end if;
	new.staff_version := coalesce(v_run.staff_version,v_staff.version);
	if new.wake_kind = 'agent' then new.staff_version := v_staff.version; end if;
	if new.wake_kind = 'routine' then
		new.session_id := public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id);
		if coalesce(v_trigger ->> 'replyPolicy','required') = 'required' and new.session_id is null then
			raise exception 'Wake public audience is unavailable' using errcode = '42501';
		end if;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	return new;
end
$$;

-- 5c. File-event drain checks the audience with the listener's creator (was 20260828020500_runtime_wake_policy_admission.sql).
create or replace function public.qorpera_drain_company_file_wakes(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_cursor public.qorpera_company_file_wake_cursors%rowtype; v_revision public.qorpera_company_path_revisions%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype; v_file public.qorpera_company_files%rowtype;
	v_trigger jsonb; v_path text; v_key text; v_selector text; v_ancestry jsonb; v_occurrence uuid; v_outcome text;
	v_scanned integer := 0; v_examined integer := 0; v_admitted integer := 0;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'File wake drain authority or bound is invalid' using errcode = '42501'; end if;
	-- LIMIT is on cursor selection BEFORE any revision lookup. Each selected
	-- cursor examines at most one indexed successor, including denied and
	-- unmatched candidates. There is no revision x subscription history scan.
	for v_cursor in
		select c.* from public.qorpera_company_file_wake_cursors c where c.active
		order by c.last_scanned_at,c.routine_id,c.routine_version,c.trigger_id
		for update of c skip locked limit p_limit
	loop
		v_scanned := v_scanned + 1;
		update public.qorpera_company_file_wake_cursors set last_scanned_at = clock_timestamp()
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
		if not exists(select 1 from public.qorpera_cloud_routines where id = v_cursor.routine_id
			and current_version = v_cursor.routine_version and status = 'active') then continue; end if;
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = v_cursor.routine_id and version = v_cursor.routine_version;
		select value into strict v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = v_cursor.trigger_id;
		select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id;
		perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
		select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id for update;
		select * into v_revision from public.qorpera_company_path_revisions
		where environment_id = v_cursor.environment_id and parent_snapshot_id = v_cursor.processed_head;
		if not found then
			if v_file.head_snapshot_id is distinct from v_cursor.processed_head then
				raise exception 'Company File listener history is unavailable' using errcode = '55000'; end if;
			continue;
		end if;
		v_examined := v_examined + 1; v_occurrence := null;
		v_path := v_revision.change #>> '{plan,path}';
		if v_revision.change #>> '{plan,schema}' is distinct from 'qorpera.company-path-mutation/v1'
			or not coalesce(public.qorpera_company_path_valid(v_path),false) then
			raise exception 'Company File listener event is invalid' using errcode = '55000'; end if;
		v_key := public.qorpera_company_path_key(v_path); v_selector := public.qorpera_company_path_key(v_trigger ->> 'path');
		if (v_key = v_selector or (v_trigger ->> 'match' = 'subtree'
			and (v_selector = '' or left(v_key,length(v_selector) + 1) = v_selector || '/')))
			and not exists(select 1 from public.qorpera_company_file_wake_claims
				where event_id = v_revision.snapshot_id and routine_id = v_cursor.routine_id
					and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id) then
			v_outcome := 'denied';
			if coalesce(public.qorpera_wake_path_authorized(v_cursor.environment_id,v_version.created_by_user_id,
				v_version.staff_agent_id,v_path),false)
				and (coalesce(v_trigger ->> 'replyPolicy','required') in ('optional','silent')
					or public.qorpera_wake_public_session(v_version.profile_id,v_cursor.environment_id,
						v_version.staff_agent_id,v_version.created_by_user_id) is not null) then
				v_ancestry := public.qorpera_wake_ancestry(v_revision.run_id,v_revision.actor_staff_id,
					v_version.staff_agent_id,v_revision.snapshot_id);
				v_outcome := 'causal-fence';
				if v_ancestry is not null then
					v_occurrence := extensions.gen_random_uuid(); v_outcome := 'admitted';
					insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,routine_id,routine_version,
						wake_kind,source_kind,file_event_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
					values(v_occurrence,v_version.profile_id,v_cursor.environment_id,v_cursor.routine_id,v_cursor.routine_version,
						'routine','company-file',v_revision.snapshot_id,v_cursor.trigger_id,
						'file:' || v_cursor.routine_version::text || ':' || v_cursor.trigger_id || ':' || v_revision.snapshot_id::text,
						v_revision.created_at,clock_timestamp(),jsonb_build_object(
							'eventId',v_revision.snapshot_id,'path',v_path,
							'previousVersion',v_revision.change #> '{plan,expectedVersion}',
							'version',v_revision.change -> 'version',
							'operation',case when v_revision.change #> '{plan,entry}' = 'null'::jsonb then 'delete' else 'upsert' end,
							'receiptId',v_revision.receipt_id,'proposalId',v_revision.proposal_id));
					v_admitted := v_admitted + 1;
				end if;
			end if;
			insert into public.qorpera_company_file_wake_claims(event_id,routine_id,routine_version,trigger_id,outcome,occurrence_id)
			values(v_revision.snapshot_id,v_cursor.routine_id,v_cursor.routine_version,v_cursor.trigger_id,v_outcome,v_occurrence);
		end if;
		-- Terminal denied/cycle claims stay private. An unmatched revision also
		-- advances the cursor in this transaction; a crash loses none of these
		-- decisions and cannot leave an orphan occurrence.
		update public.qorpera_company_file_wake_cursors set processed_head = v_revision.snapshot_id
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
	end loop;
	return jsonb_build_object('schema','qorpera.file-wake-drain/v1','scanned',v_scanned,'examined',v_examined,'admitted',v_admitted);
end
$$;

-- 5d. Envelope reports the run's audience (was 20260828020000_runtime_wake_bus.sql).
create or replace function public.qorpera_read_native_wake(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_actor jsonb; v_path text; v_payload jsonb; v_routine jsonb := null; v_sender uuid; v_actor_user uuid;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if not found or not public.qorpera_wake_authorized(v_wake)
		or public.qorpera_runtime_wake_policy(v_run.id) ->> 'kind' is distinct from v_wake.wake_kind then
		raise exception 'Admitted wake is unavailable' using errcode = '42501'; end if;
	if v_wake.source_kind = 'company-file' then
		select change #>> '{plan,path}' into strict v_path from public.qorpera_company_path_revisions
		where snapshot_id = v_wake.file_event_id;
		perform public.qorpera_company_path_remember_read(v_actor,v_path);
	elsif v_wake.wake_kind = 'agent' then
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = v_wake.parent_run_id loop
			perform public.qorpera_company_path_remember_read(v_actor,v_path);
		end loop;
	end if;
	perform public.qorpera_company_path_assert_context(v_actor);
	if v_wake.wake_kind = 'routine' then
		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt) into v_routine
		from public.qorpera_cloud_routine_versions where routine_id = v_wake.routine_id and version = v_wake.routine_version;
	end if;
	if v_wake.parent_run_id is not null then
		select staff_agent_id,requested_by_user_id into v_sender,v_actor_user
		from public.qorpera_execution_runs where id = v_wake.parent_run_id;
	elsif v_wake.source_kind = 'input' then v_actor_user := v_run.requested_by_user_id;
	end if;
	if v_wake.source_kind = 'company-file' then
		select actor_staff_id,actor_user_id into v_sender,v_actor_user
		from public.qorpera_company_path_revisions where snapshot_id = v_wake.file_event_id;
	end if;
	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1','id',v_wake.id,'runId',v_run.id,
		'kind',v_wake.wake_kind,'companyId',v_run.profile_id,'environmentId',v_run.environment_id,
		'staffAgentId',v_run.staff_agent_id,'requesterUserId',v_run.requested_by_user_id,
		'actorStaffId',v_sender,'actorUserId',v_actor_user,
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id,'sessionId',v_run.session_id),
		'source',jsonb_build_object('kind',v_wake.source_kind,'id',v_wake.source_id,'occurrenceKey',v_wake.occurrence_key),
		'policy',public.qorpera_runtime_wake_policy(v_run.id),
		'time',jsonb_build_object('utc',to_char(v_wake.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'local',to_char(v_wake.scheduled_for at time zone v_wake.time_zone,'YYYY-MM-DD"T"HH24:MI:SS.US'),'timeZone',v_wake.time_zone),
		'pins',jsonb_build_object('companySnapshotId',v_run.company_snapshot_id,'staffVersion',v_run.staff_version,
			'wakeSchema','qorpera.wake-envelope/v1','runtimeBundleVersion',null),
		'routine',v_routine,'payload',v_wake.payload,'parentRunId',v_wake.parent_run_id,
		'causal',jsonb_build_object('rootId',v_wake.causal_root_id,'agentIds',to_jsonb(v_wake.causal_agent_ids)));
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;
	return v_payload;
end
$$;
