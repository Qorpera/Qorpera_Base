-- 16 October 2026, launch checklist L18.2/L26.2: the operator's run query names the run's physical node.
--
-- qorpera_get_runtime_operational_run (20260928479210) returned physicalNodeId as null, both on every assignment and in
-- the run's identity, so an operator could not see which node a run ran on. The node is recorded when the run's machine
-- is reserved at claim time (20260928183000): the reserve inserts the run's allocation with id = the runner's
-- client_runner_id and runner_id = the runner (unique), and records the claim's placement in
-- qorpera_runtime_node_placements under that allocation id (one row per allocation).
-- * An assignment's physicalNodeId is the node of its runner's allocation for this run, when that placement's decision is
--   'placed'. A refused, deferred or unbound placement, or no allocation at all, gives null: a refused or deferred row
--   carries the asking provider's node, not a node the run was placed on.
-- * identity.physicalNodeId is the physicalNodeId of the run's newest accepted assignment (accepted_at set), or null.
-- * coverage.physicalNodeTelemetry says what this is: the node placed at claim time, not measured utilization.
-- Everything else is 20260928479210's text unchanged. create or replace keeps the function's grants (the service role's
-- alone) and its comment. The inserted text names this migration (20260930492000).

set local lock_timeout = '3s';

create or replace function public.qorpera_get_runtime_operational_run(p_run_id uuid,p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_pages jsonb := '{}'::jsonb; v_items jsonb; v_now timestamptz := statement_timestamp();
	v_launch jsonb; v_lease jsonb; v_result jsonb; v_usage jsonb; v_request jsonb;
	v_node public.qorpera_runtime_node_placements.node_id%type;
begin
	-- 20260930032000 (P32): a folder-v2 run's commits, reviews and read sets, its result's commit and its company_seq.
	-- 20260930492000 (L18.2/L26.2): physicalNodeId is the node the claim placed the run on.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 200 then
		raise exception 'Operational page limit is invalid' using errcode = '22023'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if not found then raise exception 'Operational run is unavailable' using errcode = '42501'; end if;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	select jsonb_agg(item order by id desc) into v_items from (
		select o.id,jsonb_build_object('event',o.observation,'ingestedAt',o.ingested_at,
			'assignmentRunnerId',a.runner_id,'assignmentClaimId',a.claim_id,
			'counterSemantics',case o.operation when 'model_turn' then 'latest_native_thread_totals_may_include_estimates_do_not_sum_or_bill'
				else 'reported_boundary_counts_not_billing' end,
			'timingSemantics',case o.operation when 'model_turn' then 'logical_turn_including_tools_and_retries'
				when 'native_result_fence' then 'pre_request_authorization_not_confirmed_delivery'
				else 'reported_logical_boundary_not_provider_http_timing_or_compute_utilization' end,
			'byteSemantics',case when o.operation in ('company_read','company_list','company_write') then 'logical_file_bytes_not_nas_io'
				else 'logical_boundary_payload_bytes_not_transport_io' end,
			'observedToIngestedMs',floor(extract(epoch from (o.ingested_at-o.observed_at))*1000),
			'senderClockAhead',o.observed_at > o.ingested_at,
			'startMissing',not exists(select 1 from public.qorpera_runtime_observations x where x.run_id=o.run_id and x.attempt_id=o.attempt_id and x.phase='start'),
			'finishMissing',not exists(select 1 from public.qorpera_runtime_observations x where x.run_id=o.run_id and x.attempt_id=o.attempt_id and x.phase='finish'),
			'parentMissing',case when o.parent_attempt_id is null then null else not exists(
				select 1 from public.qorpera_runtime_observations x where x.run_id=o.run_id and x.attempt_id=o.parent_attempt_id) end,
			'boundaryClockOrderConflict',exists(select 1 from public.qorpera_runtime_observations s
				join public.qorpera_runtime_observations f on f.run_id=s.run_id and f.attempt_id=s.attempt_id and f.phase='finish'
				where s.run_id=o.run_id and s.attempt_id=o.attempt_id and s.phase='start' and f.observed_at<s.observed_at),
			'anotherAttemptWithSameLogicalKey',case when o.logical_operation_sha256 is null then null else exists(
				select 1 from public.qorpera_runtime_observations x where x.run_id=o.run_id
				and x.logical_operation_sha256=o.logical_operation_sha256 and x.attempt_id<>o.attempt_id) end) as item
		from public.qorpera_runtime_observations o
		left join public.qorpera_runner_assignments a on a.id=o.assignment_id and a.run_id=o.run_id
		where o.run_id=p_run_id order by o.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('diagnostics',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by id desc) into v_items from (
		select id,jsonb_build_object('eventId',id,'kind',event_type,'createdAt',created_at) as item
		from public.qorpera_execution_run_events where run_id=p_run_id order by id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('runEvents',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select c.id,c.created_at,jsonb_build_object('claimId',c.id,'orchestratorId',c.orchestrator_id,
			'status',c.status,'createdAt',c.created_at,'leaseExpiresAt',c.lease_expires_at,'releasedAt',c.released_at) as item
		from public.qorpera_runner_job_claims c where c.run_id=p_run_id order by c.created_at desc,c.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('claims',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select a.id,a.created_at,jsonb_build_object('assignmentId',a.id,'claimId',a.claim_id,'runnerId',a.runner_id,
			'status',a.status,'createdAt',a.created_at,'acceptedAt',a.accepted_at,'finishedAt',a.finished_at,'expiresAt',a.expires_at,
			'runnerVersion',case when r.runner_version ~ '^([0-9a-f]{40}|[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[a-z0-9.-]{1,32})?)$'
				then r.runner_version else null end,
			-- 20260930492000: the node placed for the machine allocated to this runner for this run, when the claim's
			-- placement decision was 'placed'; null otherwise (a refused or deferred row carries the asker's node).
			'physicalNodeId',(select p.node_id from public.qorpera_runtime_machine_allocations m
				join public.qorpera_runtime_node_placements p on p.allocation_id=m.id and p.decision='placed'
				where m.runner_id=a.runner_id and m.run_id=a.run_id)) as item
		from public.qorpera_runner_assignments a join public.qorpera_runners r on r.id=a.runner_id
		where a.run_id=p_run_id order by a.created_at desc,a.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('assignments',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.id,r.created_at,jsonb_build_object('receiptId',r.id,'assignmentId',r.assignment_id,'status',r.status,
			'requiresCompanyRevision',r.requires_company_revision,'outputSnapshotId',r.output_snapshot_id,
			'folderCommitId',r.folder_commit_id,
			'proposalId',r.proposal_id,'companyPathProposalId',r.company_path_proposal_id,
			'createdAt',r.created_at,'completedAt',r.completed_at,'recoveryResolution',r.recovery_resolution,
			'recoveryResolvedByUserId',r.recovery_resolved_by_user_id,'recoveryResolvedAt',r.recovery_resolved_at) as item
		from public.qorpera_run_operation_receipts r where r.run_id=p_run_id order by r.created_at desc,r.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('operationReceipts',public.qorpera_operational_page(v_items,p_limit));
	-- The run's folder commits, newest first, each with its path versions (at most 32; versionsTruncated says when more).
	-- A commit made through a view names its viewKind; one made during the run's leased turn names the run in turnRunId
	-- (the run's own commits carry a null turnRunId).
	-- Closed metadata, as everywhere here: version ids, operations and sizes, never a path or an operation key.
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select c.id,c.created_at,jsonb_build_object('commitId',c.id,'seq',c.seq,
			'actorKind',c.actor_kind,'actorId',c.actor_id,'requesterKind',c.requester_kind,'requesterId',c.requester_id,
			'approverUserId',c.approver_user_id,'receiptId',c.receipt_id,'proposalId',c.proposal_id,
			'causalWakeId',c.causal_wake_id,'providerConnectionId',c.provider_connection_id,'audience',c.audience,
			'runtimeBundleId',c.runtime_bundle_id,'turnRunId',c.turn_run_id,'viewKind',c.view_kind,
			'createdAt',c.created_at,'unitCount',jsonb_array_length(c.units),
			'versions',coalesce((select jsonb_agg(jsonb_build_object('unit',v.unit_no,'op',v.op,'kind',v.kind,
					'version',v.version,'priorVersion',v.prior_version,'bytes',v.bytes) order by v.unit_no,v.version)
				from (select * from public.qorpera_folder_path_versions pv where pv.commit_id=c.id
					order by pv.unit_no,pv.version limit 32) v),'[]'::jsonb),
			'versionsTruncated',(select count(*) > 32 from (select 1 from public.qorpera_folder_path_versions pv
				where pv.commit_id=c.id limit 33) n)) as item
		from public.qorpera_folder_commits c where c.run_id=p_run_id or c.turn_run_id=p_run_id
		order by c.created_at desc,c.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('commits',public.qorpera_operational_page(v_items,p_limit));
	-- The run's change sets that were reviewed: the class SQL decided, and a member's answer to an 'ask'.
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.id,r.created_at,jsonb_build_object('reviewId',r.id,'changeSetSha256',r.change_set_sha256,
			'unitCount',cardinality(r.units),'units',to_jsonb(r.units[1:32]),'unitsTruncated',cardinality(r.units) > 32,
			'decision',r.decision,'answer',r.answer,'answeredByUserId',r.answered_by_user_id,
			'answeredAt',r.answered_at,'createdAt',r.created_at) as item
		from public.qorpera_folder_reviews r where r.run_id=p_run_id order by r.created_at desc,r.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('reviews',public.qorpera_operational_page(v_items,p_limit));
	-- What the run read, as its releases recorded it: per release and covering resource, the path versions read (at most
	-- 32), never the paths.
	select jsonb_agg(item order by created_at desc,release_id desc,resource_id desc) into v_items from (
		select r.release_id,r.resource_id,r.created_at,jsonb_build_object('releaseId',r.release_id,'resourceId',r.resource_id,
			'readCount',jsonb_array_length(r.reads),
			-- The runner reports each version; only a well-formed id is shown (anything else as null), never its text.
			'versions',coalesce((select jsonb_agg(case when jsonb_typeof(r.reads -> (n - 1) -> 'version') = 'string'
					and (r.reads -> (n - 1) ->> 'version') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
					then to_jsonb((r.reads -> (n - 1) ->> 'version')::uuid) end order by n)
				from generate_series(1, least(jsonb_array_length(r.reads), 32)) n),'[]'::jsonb),
			'versionsTruncated',jsonb_array_length(r.reads) > 32,
			'outputSha256',r.output_sha256,'createdAt',r.created_at,'semantics','released_read_set_not_nas_io') as item
		from public.qorpera_folder_run_read_records r where r.run_id=p_run_id
		order by r.created_at desc,r.release_id desc,r.resource_id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('readSets',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select s.event_id as id,s.created_at,jsonb_build_object('eventId',s.event_id,'sessionId',s.session_id,
			'assignmentId',s.assignment_id,'phase',s.phase,'createdAt',s.created_at,'eventSequence',e.sequence,
			'canonicalEventMatched',e.event_id is not null and e.session_id=s.session_id and e.execution_id=s.run_id
				and e.runner_assignment_id=s.assignment_id) as item
		from public.qorpera_agent_sends s left join public.qorpera_session_events e on e.event_id=s.event_id
		where s.run_id=p_run_id order by s.created_at desc,s.event_id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('publicSends',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by ordinal desc) into v_items from (
		select ordinal,jsonb_build_object('viewId',id,'ordinal',ordinal,'parentId',parent_id,'createdAt',created_at,
			'semantics','context_admission_fence_not_provider_request_completion') as item
		from public.qorpera_native_context_views where run_id=p_run_id order by ordinal desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('nativeContextViews',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.id,r.created_at,jsonb_build_object('requestId',r.id,'runnerId',r.runner_id,'status',r.status,
			'createdAt',r.created_at,'finalizedAt',r.finalized_at,'reservationExpiresAt',r.reservation_expires_at,
			'usageReported',u.request_id is not null,'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,
			'usageOutcome',u.outcome,'usageObservedAt',u.created_at,'semantics','api_gateway_reservation_and_report_not_native_http_timing') as item
		from public.qorpera_runner_model_requests r left join public.qorpera_runner_model_usage_observations u on u.request_id=r.id
		where r.job_id=v_run.job_id order by r.created_at desc,r.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('gatewayModelRequests',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_build_object('createdAt',created_at,'binarySha256',binary_sha256,'runtimeBundleId',runtime_bundle_id,
		'runtimeBundleSha256',runtime_bundle_sha256,'reasoningEffort',reasoning_effort,
		'reasoningPolicySha256',reasoning_policy_sha256,'contextBytes',context_bytes,
		'contextByteSemantics','initial_logical_context_not_model_billing') into v_launch
	from public.qorpera_native_execution_launches where run_id=p_run_id;
	select jsonb_build_object('leaseId',id,'assignmentId',assignment_id,'runnerId',runner_id,'status',status,
		'createdAt',created_at,'expiresAt',expires_at,'releasedAt',released_at,
		'providerConnectionId',provider_connection_id,'providerConnectionVersion',provider_connection_version) into v_lease
	from public.qorpera_native_provider_connection_leases where run_id=p_run_id;
	select jsonb_build_object('assignmentId',assignment_id,'runnerId',runner_id,'completedAt',completed_at,
		'transcriptEndSequence',transcript_end_sequence,'companyDisposition',company_disposition,
		'outputCommitId',folder_commit_id) into v_result
	from public.qorpera_execution_run_results where run_id=p_run_id;
	select jsonb_build_object('observationId',id,'runnerId',runner_id,'actorUserId',actor_user_id,'createdAt',created_at,
		'executionMs',execution_ms,'inputBytes',input_bytes,'outputBytes',output_bytes,'resultBytes',result_bytes,
		'semantics','runner_reported_wall_time_and_logical_bytes_not_cpu_memory_or_nas_utilization',
		'configuredLimits',jsonb_build_object('wallTimeMs',wall_time_limit_ms,'memoryBytes',memory_limit_bytes,
			'cpuMillis',cpu_limit_millis,'pidLimit',pid_limit,'inputBytes',input_limit_bytes,
			'outputBytes',output_limit_bytes,'resultBytes',result_limit_bytes),
		'limitSemantics','configured_capacity_not_measured_consumption') into v_usage
	from public.qorpera_runner_usage_observations where job_id=v_run.job_id;
	select jsonb_build_object('requestId',id,'inputId',input_id,'sessionId',session_id,'status',status,
		'requesterUserId',requested_by_user_id,'createdAt',created_at,'sponsoredAt',sponsored_at,'materializedAt',materialized_at,
		'requestToMaterializationMs',case when materialized_at>=created_at
			then floor(extract(epoch from (materialized_at-created_at))*1000) else null end,
		'semantics','canonical_admission_wait_not_model_or_cpu_time') into v_request
	from public.qorpera_session_turn_requests where run_id=p_run_id and profile_id=v_run.profile_id;
	-- 20260930492000: the run's node is its newest accepted assignment's placed node (null when that one has none).
	select (select p.node_id from public.qorpera_runtime_machine_allocations m
			join public.qorpera_runtime_node_placements p on p.allocation_id=m.id and p.decision='placed'
			where m.runner_id=a.runner_id and m.run_id=a.run_id) into v_node
	from public.qorpera_runner_assignments a where a.run_id=p_run_id and a.accepted_at is not null
	order by a.created_at desc,a.id desc limit 1;
	return jsonb_build_object('schema','qorpera.runtime-operational-run/v2','queriedAt',v_now,'limitPerSection',p_limit,
		'identity',jsonb_build_object('companyId',v_run.profile_id,'environmentId',v_run.environment_id,
			'runId',v_run.id,'jobId',v_run.job_id,'sessionId',v_run.session_id,'sourceKind',v_run.source_kind,
			'sourceId',v_run.source_id,'inputIds',v_run.input_ids,'staffAgentId',v_run.staff_agent_id,'staffVersion',v_run.staff_version,
			'requesterUserId',v_run.requested_by_user_id,'sponsorUserId',v_run.sponsored_by_user_id,
			'sponsorBindingId',v_run.sponsor_binding_id,'sponsorVersion',v_run.sponsor_version,
			'audienceKind',v_run.audience_kind,'audienceUserId',v_run.audience_user_id,
			'runtimeBundleId',v_run.runtime_bundle_id,'runtimeBundleSha256',v_run.runtime_bundle_sha256,
			'computeIdentityId',v_run.compute_identity_id,'logicalComputerId',v_run.logical_computer_id,
			'workerClass',v_run.worker_class,'modelProvider',v_run.model_provider,'modelId',v_run.model_id,
			'reasoningEffort',v_run.reasoning_effort,'companySeq',v_run.company_seq,'physicalNodeId',v_node),
		'canonicalJob',jsonb_build_object('status',v_job.status,'createdAt',v_job.created_at,'startedAt',v_job.started_at,
			'finishedAt',v_job.finished_at,'cancelledAt',v_job.cancelled_at,'deadlineAt',v_run.deadline_at,
			'attemptCount',v_job.attempt_count,'dispatchFailureCount',v_job.dispatch_failure_count,
			'queueToFirstStartMs',case when v_job.started_at >= v_job.created_at
				then floor(extract(epoch from (v_job.started_at-v_job.created_at))*1000) else null end,
			'queueToFirstStartSemantics','admission_and_dispatch_wait_not_cpu_execution'),
		'admissionRequest',v_request,'nativeLaunch',v_launch,'nativeLease',v_lease,'canonicalResult',v_result,
		'runnerUsage',v_usage,'sections',v_pages,
		'coverage',jsonb_build_object('diagnosticsMissing',not exists(select 1 from public.qorpera_runtime_observations where run_id=p_run_id),
			'ledgerCompleteness','not_claimed_optional_delivery','emptyDoesNotMeanHealthy',true,
			'gapFlagsScope','returned_events_with_same_attempt_lookup',
			'providerRequestTiming','unavailable','physicalNodeTelemetry','placement_node_at_claim_not_measured_utilization',
			'diagnosticExportGapReported',exists(select 1 from public.qorpera_runtime_observations where run_id=p_run_id
				and operation='diagnostic_export' and phase='finish' and observation ->> 'status'<>'succeeded'),
			'unreportedDiagnosticLoss','unknown','counterUpdatesMustNotBeSummed',true,'unknownCountersRemainNull',true,
			'diagnosticStatusIsCanonicalOutcome',false,'readResourceVersionHistory','read_set_versions_as_the_runner_reported_them'),
		'retention',jsonb_build_object('diagnosticDays',30,'clock','server_ingested_at','activeJobsPreserved',true,
			'purge','explicit_bounded_operator_invocation','authorityRecordsPruned',false));
end
$$;
