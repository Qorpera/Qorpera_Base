-- Optional, metadata-only runtime diagnostics. These rows are NOT authority,
-- effect receipts, model billing, or a new source of execution-run status.
-- In particular, do not append diagnostic events to execution_run_events:
-- historical run readers derive state from that canonical event stream.
begin;

create table public.qorpera_runtime_observations (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	attempt_id uuid not null,
	phase text not null check (phase in ('start','finish')),
	assignment_id uuid,
	parent_attempt_id uuid,
	operation text not null,
	logical_operation_sha256 text,
	observed_at timestamptz not null check (isfinite(observed_at)),
	ingested_at timestamptz not null default clock_timestamp(),
	observation jsonb not null check (jsonb_typeof(observation) = 'object'
		and octet_length(observation::text) <= 8192),
	unique (run_id,attempt_id,phase)
);
alter table public.qorpera_runtime_observations enable row level security;
revoke all on public.qorpera_runtime_observations from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on sequence public.qorpera_runtime_observations_id_seq from public,anon,authenticated,service_role,qorpera_secret_broker;
create index qorpera_runtime_observations_run_sequence on public.qorpera_runtime_observations(run_id,id desc);
create index qorpera_runtime_observations_retention on public.qorpera_runtime_observations(ingested_at,id);
create index qorpera_runtime_observations_logical on public.qorpera_runtime_observations(run_id,logical_operation_sha256,attempt_id)
	where logical_operation_sha256 is not null;
-- Bounded operator projections use canonical IDs, not scans through payloads.
create index qorpera_operational_claims_run on public.qorpera_runner_job_claims(run_id,created_at desc,id desc);
create index qorpera_operational_assignments_run on public.qorpera_runner_assignments(run_id,created_at desc,id desc);
create index qorpera_operational_receipts_run on public.qorpera_run_operation_receipts(run_id,created_at desc,id desc);
create index qorpera_operational_revisions_run on public.qorpera_company_path_revisions(run_id,created_at desc,snapshot_id desc);
create index qorpera_operational_proposals_run on public.qorpera_company_path_proposals(run_id,created_at desc,id desc);
create index qorpera_operational_model_requests_job on public.qorpera_runner_model_requests(job_id,created_at desc,id desc);
create index qorpera_operational_member_commands on public.qorpera_member_company_path_commands(environment_id,created_at desc,id desc);

create function public.qorpera_runtime_observation_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
	raise exception 'Runtime diagnostic events are immutable' using errcode = '42501';
end
$$;
create trigger qorpera_runtime_observations_immutable before update on public.qorpera_runtime_observations
for each row execute function public.qorpera_runtime_observation_immutable();

create function public.qorpera_record_runtime_observation(p_run_id uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_keys text[] := array['schema','attemptId','parentAttemptId','assignmentId','phase','operation',
		'logicalOperationSha256','observedAt','durationMs','status','errorCategory','receiptId','readId',
		'inputBytes','outputBytes','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens',
		'reasoningOutputTokens','totalTokens'];
	v_key text; v_number numeric; v_observed timestamptz;
	v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_runtime_observations%rowtype;
	v_other public.qorpera_runtime_observations%rowtype;
	v_replayed boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_run_id is null or jsonb_typeof(p_observation) is distinct from 'object'
		or octet_length(p_observation::text) > 8192 or not (p_observation ?& v_keys)
		or p_observation - v_keys <> '{}'::jsonb
		or p_observation ->> 'schema' is distinct from 'qorpera.runtime-observation/v1'
		or jsonb_typeof(p_observation -> 'attemptId') is distinct from 'string'
		or p_observation ->> 'attemptId' !~* v_uuid_pattern then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['parentAttemptId','assignmentId','receiptId','readId'] loop
		if p_observation -> v_key <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> v_key) <> 'string' or p_observation ->> v_key !~* v_uuid_pattern) then
			raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	end loop;
	if p_observation ->> 'operation' not in ('model_turn','model_request','company_read','company_list',
		'company_write','company_mkdir','company_delete','company_context','send_message','connector','unknown_tool',
		'run_authority','context_authority','native_result_fence','diagnostic_export')
		or jsonb_typeof(p_observation -> 'operation') <> 'string'
		or (p_observation -> 'logicalOperationSha256' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'logicalOperationSha256') <> 'string'
			or p_observation ->> 'logicalOperationSha256' !~ '^[0-9a-f]{64}$'))
		or (p_observation -> 'errorCategory' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'errorCategory') <> 'string' or p_observation ->> 'errorCategory' not in (
			'invalid_arguments','unavailable_tool','call_id_reused','budget_exhausted','authority_unavailable',
			'stale_version','protected_path','ambiguous_effect','cancelled','timeout','provider_failed',
			'transport_unavailable','invalid_response','unknown','export_unavailable')))
		or not coalesce((p_observation ->> 'phase' = 'start' and p_observation ->> 'status' = 'started'
			and p_observation -> 'durationMs' = 'null'::jsonb and p_observation -> 'errorCategory' = 'null'::jsonb)
			or (p_observation ->> 'phase' = 'finish' and p_observation ->> 'status' in
			('succeeded','failed','cancelled','denied','unconfirmed','proposed','replayed')),false) then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['durationMs','inputBytes','outputBytes','inputTokens','outputTokens',
		'cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] loop
		if p_observation -> v_key = 'null'::jsonb then continue; end if;
		if jsonb_typeof(p_observation -> v_key) <> 'number' then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
		v_number := (p_observation ->> v_key)::numeric;
		if v_number < 0 or v_number > 9007199254740991 or v_number <> trunc(v_number) then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
	end loop;
	-- Exactly the emitter's finite UTC-millisecond representation, not PostgreSQL
	-- special dates, local timezone guesses, calendar normalization, or year zero.
	if jsonb_typeof(p_observation -> 'observedAt') <> 'string'
		or p_observation ->> 'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
		or p_observation ->> 'observedAt' like '0000-%' then
		raise exception 'Runtime observation time is invalid' using errcode = '22023'; end if;
	begin
		v_observed := (p_observation ->> 'observedAt')::timestamptz;
		if not isfinite(v_observed) or to_char(v_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			<> p_observation ->> 'observedAt' then raise invalid_datetime_format; end if;
	exception when datetime_field_overflow or invalid_datetime_format then
		raise exception 'Runtime observation time is invalid' using errcode = '22023';
	end;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if not found then raise exception 'Runtime observation run is unavailable' using errcode = '42501'; end if;
	if (p_observation ->> 'assignmentId' is not null and not exists (
		select 1 from public.qorpera_runner_assignments a where a.id = (p_observation ->> 'assignmentId')::uuid
			and a.run_id = p_run_id and a.job_id = v_run.job_id))
		or (p_observation ->> 'receiptId' is not null and not exists (
			select 1 from public.qorpera_run_operation_receipts r where r.id = (p_observation ->> 'receiptId')::uuid
				and r.run_id = p_run_id and r.job_id = v_run.job_id))
		or (p_observation ->> 'readId' is not null and not exists (
			select 1 from public.qorpera_company_read_observations r where r.id = (p_observation ->> 'readId')::uuid
				and r.run_id = p_run_id and r.environment_id = v_run.environment_id)) then
		raise exception 'Runtime observation reference is unavailable' using errcode = '42501'; end if;
	-- Only the new diagnostic identity is locked; telemetry does not lock a
	-- job, lease, file, or live authorization. A finish may arrive before start.
	perform pg_advisory_xact_lock(hashtextextended('runtime-observation:' || p_run_id::text || ':' ||
		(p_observation ->> 'attemptId')::uuid::text,19970));
	select * into v_existing from public.qorpera_runtime_observations
	where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid and phase = p_observation ->> 'phase';
	if found then
		if v_existing.observation <> p_observation then
			raise exception 'Runtime observation identity already records different metadata' using errcode = '23505'; end if;
		v_replayed := true;
	else
		select * into v_other from public.qorpera_runtime_observations
		where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid;
		if found and (v_other.observation -> 'operation',v_other.observation -> 'assignmentId',
			v_other.observation -> 'parentAttemptId',v_other.observation -> 'logicalOperationSha256') is distinct from
			(p_observation -> 'operation',p_observation -> 'assignmentId',p_observation -> 'parentAttemptId',
			p_observation -> 'logicalOperationSha256') then
			raise exception 'Runtime observation attempt metadata changed' using errcode = '23505'; end if;
		insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
			operation,logical_operation_sha256,observed_at,observation)
		values (p_run_id,(p_observation ->> 'attemptId')::uuid,p_observation ->> 'phase',
			(p_observation ->> 'assignmentId')::uuid,(p_observation ->> 'parentAttemptId')::uuid,
			p_observation ->> 'operation',p_observation ->> 'logicalOperationSha256',v_observed,p_observation)
		returning * into v_existing;
	end if;
	return jsonb_build_object('schema','qorpera.runtime-observation-receipt/v1','runId',p_run_id,
		'attemptId',v_existing.attempt_id,'phase',v_existing.phase,'ingestedAt',v_existing.ingested_at,'replayed',v_replayed);
end
$$;

-- Input is already limited to limit+1 by each indexed projection below.
create function public.qorpera_operational_page(p_items jsonb,p_limit integer)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('items',coalesce((select jsonb_agg(value order by ordinal)
		from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) with ordinality entry(value,ordinal)
		where ordinal <= p_limit),'[]'::jsonb),'truncated',coalesce(jsonb_array_length(p_items),0) > p_limit)
$$;

create function public.qorpera_get_runtime_operational_run(p_run_id uuid,p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_pages jsonb := '{}'::jsonb; v_items jsonb; v_now timestamptz := statement_timestamp();
	v_launch jsonb; v_lease jsonb; v_result jsonb; v_usage jsonb; v_request jsonb;
begin
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
			'physicalNodeId',null) as item
		from public.qorpera_runner_assignments a join public.qorpera_runners r on r.id=a.runner_id
		where a.run_id=p_run_id order by a.created_at desc,a.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('assignments',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.id,r.created_at,jsonb_build_object('receiptId',r.id,'assignmentId',r.assignment_id,'status',r.status,
			'requiresCompanyRevision',r.requires_company_revision,'outputSnapshotId',r.output_snapshot_id,
			'proposalId',r.proposal_id,'companyPathProposalId',r.company_path_proposal_id,
			'createdAt',r.created_at,'completedAt',r.completed_at,'recoveryResolution',r.recovery_resolution,
			'recoveryResolvedByUserId',r.recovery_resolved_by_user_id,'recoveryResolvedAt',r.recovery_resolved_at) as item
		from public.qorpera_run_operation_receipts r where r.run_id=p_run_id order by r.created_at desc,r.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('operationReceipts',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.snapshot_id as id,r.created_at,jsonb_build_object('snapshotId',r.snapshot_id,'parentSnapshotId',r.parent_snapshot_id,
			'receiptId',r.receipt_id,'proposalId',r.proposal_id,'createdAt',r.created_at,'actorUserId',r.actor_user_id,
			'actorStaffAgentId',r.actor_staff_id,'requesterUserId',r.requester_user_id,'approverUserId',r.approver_user_id,
			'sponsorBindingId',r.sponsor_binding_id,'sponsorVersion',r.sponsor_version,'audienceKind',r.audience_kind,
			'audienceUserId',r.audience_user_id,'runtimeBundleId',r.runtime_bundle_id,'runtimeBundleSha256',r.runtime_bundle_sha256,
			'resourceId',case when r.change ->> 'resourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (r.change ->> 'resourceId')::uuid else null end,
			'resourceVersion',case when r.change ->> 'resourceVersion' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (r.change ->> 'resourceVersion')::uuid else null end,
			'pathVersion',case when r.change ->> 'version' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (r.change ->> 'version')::uuid else null end) as item
		from public.qorpera_company_path_revisions r where r.run_id=p_run_id order by r.created_at desc,r.snapshot_id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('revisions',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select p.id,p.created_at,jsonb_build_object('proposalId',p.id,'receiptId',p.receipt_id,'resourceId',p.resource_id,
			'resourceVersion',p.resource_version,'status',p.status,'createdAt',p.created_at,
			'approvedByUserId',p.approved_by_user_id,'approvalExpiresAt',p.approval_expires_at,
			'resolvedByUserId',p.resolved_by_user_id,'resolvedAt',p.resolved_at,'outputSnapshotId',p.output_snapshot_id) as item
		from public.qorpera_company_path_proposals p where p.run_id=p_run_id order by p.created_at desc,p.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('proposals',public.qorpera_operational_page(v_items,p_limit));
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select r.id,r.created_at,jsonb_build_object('readId',r.id,'snapshotId',r.snapshot_id,'kind',r.kind,'pathVersion',r.version,
			'createdAt',r.created_at,'confirmed',c.read_id is not null,'confirmedAt',c.confirmed_at,'includedBytes',c.included_bytes,
			'byteSemantics','confirmed_logical_file_content_not_nas_io','resourceId',null) as item
		from public.qorpera_company_read_observations r left join public.qorpera_company_read_confirmations c on c.read_id=r.id
		where r.run_id=p_run_id order by r.created_at desc,r.id desc limit p_limit+1
	) page;
	v_pages := v_pages || jsonb_build_object('reads',public.qorpera_operational_page(v_items,p_limit));
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
		'outputSnapshotId',output_snapshot_id,'proposalId',proposal_id) into v_result
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
	return jsonb_build_object('schema','qorpera.runtime-operational-run/v1','queriedAt',v_now,'limitPerSection',p_limit,
		'identity',jsonb_build_object('companyId',v_run.profile_id,'environmentId',v_run.environment_id,
			'runId',v_run.id,'jobId',v_run.job_id,'sessionId',v_run.session_id,'sourceKind',v_run.source_kind,
			'sourceId',v_run.source_id,'inputIds',v_run.input_ids,'staffAgentId',v_run.staff_agent_id,'staffVersion',v_run.staff_version,
			'requesterUserId',v_run.requested_by_user_id,'sponsorUserId',v_run.sponsored_by_user_id,
			'sponsorBindingId',v_run.sponsor_binding_id,'sponsorVersion',v_run.sponsor_version,
			'audienceKind',v_run.audience_kind,'audienceUserId',v_run.audience_user_id,
			'runtimeBundleId',v_run.runtime_bundle_id,'runtimeBundleSha256',v_run.runtime_bundle_sha256,
			'computeIdentityId',v_run.compute_identity_id,'logicalComputerId',v_run.logical_computer_id,
			'workerClass',v_run.worker_class,'modelProvider',v_run.model_provider,'modelId',v_run.model_id,
			'reasoningEffort',v_run.reasoning_effort,'physicalNodeId',null),
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
			'providerRequestTiming','unavailable','physicalNodeTelemetry','not_recorded_in_this_query',
			'diagnosticExportGapReported',exists(select 1 from public.qorpera_runtime_observations where run_id=p_run_id
				and operation='diagnostic_export' and phase='finish' and observation ->> 'status'<>'succeeded'),
			'unreportedDiagnosticLoss','unknown','counterUpdatesMustNotBeSummed',true,'unknownCountersRemainNull',true,
			'diagnosticStatusIsCanonicalOutcome',false,'readResourceVersionHistory','unavailable_use_exact_snapshot_and_path_version'),
		'retention',jsonb_build_object('diagnosticDays',30,'clock','server_ingested_at','activeJobsPreserved',true,
			'purge','explicit_bounded_operator_invocation','authorityRecordsPruned',false));
end
$$;

create function public.qorpera_get_company_operational_commands(p_company_id uuid,p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_environment uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 200 then
		raise exception 'Operational page limit is invalid' using errcode = '22023'; end if;
	select environment_id into v_environment from public.qorpera_company_files where profile_id=p_company_id;
	if not found then raise exception 'Operational company is unavailable' using errcode = '42501'; end if;
	select jsonb_agg(item order by created_at desc,id desc) into v_items from (
		select c.id,c.created_at,jsonb_build_object('commandId',c.id,'companyId',p_company_id,'environmentId',c.environment_id,
			'runId',null,'actorUserId',c.user_id,'requesterUserId',c.user_id,'sponsorUserId',null,
			'resourceId',c.resource_id,'resourceVersion',c.resource_version,'protected',c.protected,'status',c.status,
			'createdAt',c.created_at,'reviewedAt',c.reviewed_at,'expiresAt',c.expires_at,
			'revisionMatched',r.snapshot_id is not null,'appliedAt',r.created_at,'snapshotId',r.snapshot_id,
			'actorStaffAgentId',r.actor_staff_id,'approverUserId',r.approver_user_id,
			'audienceKind',r.audience_kind,'audienceUserId',r.audience_user_id,
			'runtimeBundleId',r.runtime_bundle_id,'runtimeBundleSha256',r.runtime_bundle_sha256,
			'applyDurationMs',null) as item
		from public.qorpera_member_company_path_commands c
		left join public.qorpera_company_path_revisions r on r.environment_id=c.environment_id and r.run_id is null
			and r.actor_user_id=c.user_id and c.status='applied' and r.snapshot_id=case when c.result ->> 'snapshotId'
				~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (c.result ->> 'snapshotId')::uuid else null end
		where c.environment_id=v_environment order by c.created_at desc,c.id desc limit p_limit+1
	) page;
	return jsonb_build_object('schema','qorpera.company-operational-commands/v1','companyId',p_company_id,
		'environmentId',v_environment,'queriedAt',statement_timestamp(),'limit',p_limit,
		'commands',public.qorpera_operational_page(v_items,p_limit),
		'coverage',jsonb_build_object('source','canonical_member_command_and_exact_applied_revision',
			'deniedAttempts','not_recorded','applyDuration','not_recorded','memberReadAttempts','not_recorded',
			'noRunIsInvented',true,'noModelOrSponsorIsInferred',true),
		'retention','canonical_authority_history_not_subject_to_diagnostic_purge');
end
$$;

create function public.qorpera_purge_runtime_observations(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cutoff timestamptz := clock_timestamp()-interval '30 days'; v_deleted integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Diagnostic retention requires operator service authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 200 then
		raise exception 'Diagnostic purge limit is invalid' using errcode = '22023'; end if;
	with candidates as (
		select o.id from public.qorpera_runtime_observations o
		join public.qorpera_execution_runs r on r.id=o.run_id join public.qorpera_runner_jobs j on j.id=r.job_id
		where o.ingested_at<v_cutoff and j.status in ('completed','failed','cancelled')
		order by o.ingested_at,o.id limit p_limit for update of o skip locked
	), removed as (delete from public.qorpera_runtime_observations where id in (select id from candidates) returning id)
	select count(*) into v_deleted from removed;
	return jsonb_build_object('schema','qorpera.runtime-diagnostic-purge/v1','deleted',v_deleted,'limit',p_limit,
		'cutoff',v_cutoff,'diagnosticDays',30,'activeJobsPreserved',true,'authorityRecordsPruned',false,
		'moreEligible',exists(select 1 from public.qorpera_runtime_observations o
			join public.qorpera_execution_runs r on r.id=o.run_id join public.qorpera_runner_jobs j on j.id=r.job_id
			where o.ingested_at<v_cutoff and j.status in ('completed','failed','cancelled')));
end
$$;

revoke all on function public.qorpera_runtime_observation_immutable(),public.qorpera_operational_page(jsonb,integer),
	public.qorpera_record_runtime_observation(uuid,jsonb),public.qorpera_get_runtime_operational_run(uuid,integer),
	public.qorpera_get_company_operational_commands(uuid,integer),public.qorpera_purge_runtime_observations(integer)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_record_runtime_observation(uuid,jsonb),
	public.qorpera_get_runtime_operational_run(uuid,integer),public.qorpera_get_company_operational_commands(uuid,integer),
	public.qorpera_purge_runtime_observations(integer) to service_role;

comment on table public.qorpera_runtime_observations is
	'Optional closed metadata. Operator-service RPC access only; no transcript, paths, bodies, arguments, raw errors or secrets. Explicit bounded purge after 30 server-ingest days for terminal jobs only; authority history is separate.';
comment on function public.qorpera_record_runtime_observation(uuid,jsonb) is
	'Best-effort diagnostics, not authorization or billing. Late/out-of-order records allowed; immutable phase replay. Callers must bound exports and must not fail product work when diagnostics fail.';
comment on function public.qorpera_get_runtime_operational_run(uuid,integer) is
	'Operator-only bounded metadata projection of exact canonical identities, assignments and outcomes. Missing telemetry is unknown, never success or zero. Model-turn counters are latest reported thread totals, possibly estimated, not HTTP timings or billing.';
commit;
