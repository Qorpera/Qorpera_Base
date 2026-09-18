-- Source review corrections for Steps 0--2. No wake-bus/Step 3 behavior.
-- v1 labels remain historical provenance, never proof of executable compatibility.

alter table public.qorpera_execution_runs
	add column reasoning_effort text check (reasoning_effort = 'low'),
	add column reasoning_policy_sha256 text check (reasoning_policy_sha256 ~ '^[0-9a-f]{64}$'),
	add check ((reasoning_effort is null) = (reasoning_policy_sha256 is null));
-- Do not invent the effort of an already executed historical run.

create function public.qorpera_execution_runtime_manifest(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_manifest jsonb;
begin
	select manifest into v_manifest from public.qorpera_runtime_bundles
	where id = p_run.runtime_bundle_id and sha256 = p_run.runtime_bundle_sha256;
	if v_manifest ->> 'schema' is distinct from 'qorpera.runtime-bundle/v2'
		or v_manifest -> 'modelPolicy' is distinct from
			'{"schema":"qorpera.model-reasoning/v1","effort":"low","overrides":"none"}'::jsonb
		or coalesce(v_manifest ->> 'nativeBinarySha256','') !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(v_manifest -> 'implementation') is distinct from 'object'
		or v_manifest -> 'implementation' = '{}'::jsonb
		or jsonb_typeof(v_manifest -> 'components') is distinct from 'object' then
		raise exception 'Run requires an executable runtime bundle' using errcode = '42501'; end if;
	if not (v_manifest -> 'components' ?& array['kernel','constitution','toolCatalog','wakeAndSilence',
		'contextComposer','providerBootstrap','authorization','inboundSafety','outboundSafety',
		'interactionSurfaces','workerLifecycle','memoryAndSkills'])
		or exists(select 1 from jsonb_each_text(v_manifest -> 'components') component where component.value !~ '^[0-9a-f]{64}$')
		or exists(select 1 from jsonb_each_text(v_manifest -> 'implementation') source where source.value !~ '^[0-9a-f]{64}$') then
		raise exception 'Run runtime components are unavailable' using errcode = '42501'; end if;
	return v_manifest;
end
$$;

create function public.qorpera_pin_execution_reasoning_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb;
begin
	if tg_op = 'UPDATE' then
		if (new.reasoning_effort,new.reasoning_policy_sha256) is distinct from
			(old.reasoning_effort,old.reasoning_policy_sha256) then
			raise exception 'Execution reasoning policy is immutable' using errcode = '42501'; end if;
	else
		v_manifest := public.qorpera_execution_runtime_manifest(new);
		-- Caller hints and job flags cannot override the admitted bundle.
		new.reasoning_effort := v_manifest #>> '{modelPolicy,effort}';
		new.reasoning_policy_sha256 := encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex');
	end if;
	return new;
end
$$;
-- Alphabetically after qorpera_execution_run_audience, which pins the input bundle.
create trigger qorpera_execution_run_reasoning_policy
before insert or update of reasoning_effort,reasoning_policy_sha256 on public.qorpera_execution_runs
for each row execute function public.qorpera_pin_execution_reasoning_policy();

create or replace function public.qorpera_describe_native_tool_authority(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_until timestamptz; v_remaining bigint; v_manifest jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if v_run.reasoning_effort is distinct from v_manifest #>> '{modelPolicy,effort}'
		or v_run.reasoning_policy_sha256 is distinct from
			encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex') then
		raise exception 'Run reasoning policy is unavailable' using errcode = '42501'; end if;
	select * into strict v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_binding ->> 'leaseId')::uuid;
	select least(v_lease.expires_at,job.lease_expires_at,assignment.expires_at,runner.session_expires_at,v_run.deadline_at)
	into strict v_until from public.qorpera_runner_jobs job
	join public.qorpera_runner_assignments assignment on assignment.id = (p_binding ->> 'assignmentId')::uuid
	join public.qorpera_runners runner on runner.id = v_lease.runner_id where job.id = v_run.job_id;
	v_remaining := least(30000,floor(extract(epoch from (v_until-clock_timestamp()))*1000)::bigint);
	if v_remaining is null or v_remaining <= 0 then
		raise exception 'native tool authority expired' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.native-tool-authority/v1','validForMs',v_remaining,
		'identity',jsonb_build_object(
			'companyId',v_run.profile_id,'environmentId',v_run.environment_id,'runId',v_run.id,'jobId',v_run.job_id,
			'runnerId',v_lease.runner_id,'assignmentId',v_lease.assignment_id,'leaseId',v_lease.id,
			'computeIdentityId',v_run.compute_identity_id,'staffAgentId',v_run.staff_agent_id,
			'staffVersion',v_run.staff_version,'sessionId',v_run.session_id,
			'requesterUserId',v_run.requested_by_user_id,'sponsorUserId',v_run.sponsored_by_user_id,
			'sponsorBindingId',v_run.sponsor_binding_id,'sponsorVersion',v_run.sponsor_version,
			'providerConnectionId',v_lease.provider_connection_id,
			'providerConnectionVersion',v_lease.provider_connection_version,
			'audienceKind',v_run.audience_kind,'audienceUserId',v_run.audience_user_id,
			'runtimeBundleId',v_run.runtime_bundle_id,'runtimeBundleSha256',v_run.runtime_bundle_sha256,
			'reasoningEffort',v_run.reasoning_effort,'reasoningPolicySha256',v_run.reasoning_policy_sha256,
			'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id));
end
$$;

create table public.qorpera_native_execution_launches (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete restrict,
	runtime_bundle_id uuid not null,
	runtime_bundle_sha256 text not null,
	binary_sha256 text not null check (binary_sha256 ~ '^[0-9a-f]{64}$'),
	reasoning_effort text not null check (reasoning_effort = 'low'),
	reasoning_policy_sha256 text not null check (reasoning_policy_sha256 ~ '^[0-9a-f]{64}$'),
	-- Exact offered schema/description bytes. Values contain no credentials or context content.
	tool_catalog_text text not null check (octet_length(tool_catalog_text) between 1 and 262144),
	tool_catalog_sha256 text generated always as (encode(extensions.digest(tool_catalog_text,'sha256'),'hex')) stored,
	context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
	context_bytes integer not null check (context_bytes between 1 and 1048576),
	created_at timestamptz not null default clock_timestamp(),
	foreign key (runtime_bundle_id,runtime_bundle_sha256) references public.qorpera_runtime_bundles(id,sha256) on delete restrict
);
alter table public.qorpera_native_execution_launches enable row level security;
revoke all on public.qorpera_native_execution_launches from public,anon,authenticated,service_role;
create trigger qorpera_native_execution_launches_immutable
before update or delete on public.qorpera_native_execution_launches
for each row execute function public.qorpera_reject_runtime_bundle_mutation();

-- The old entrypoint cannot bypass compatibility/effort/catalog admission.
revoke all on function public.qorpera_begin_native_company_execution(jsonb,text) from public,anon,authenticated,service_role;
create function public.qorpera_begin_native_company_execution_v2(
	p_binding jsonb,p_binary_sha256 text,p_runtime_bundle_sha256 text,p_reasoning_policy_sha256 text,
	p_tool_catalog_text text,p_context_sha256 text,p_context_bytes integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb;
	v_payload jsonb; v_catalog jsonb; v_catalog_sha text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if p_runtime_bundle_sha256 is distinct from v_run.runtime_bundle_sha256
		or p_binary_sha256 is distinct from v_manifest ->> 'nativeBinarySha256'
		or v_run.reasoning_effort is distinct from v_manifest #>> '{modelPolicy,effort}'
		or p_reasoning_policy_sha256 is distinct from v_run.reasoning_policy_sha256
		or p_reasoning_policy_sha256 is distinct from
			encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex') then
		raise exception 'Native executable policy differs from the admitted run' using errcode = '42501'; end if;
	if p_tool_catalog_text is null or octet_length(p_tool_catalog_text) not between 1 and 262144
		or coalesce(p_context_sha256,'') !~ '^[0-9a-f]{64}$' or p_context_bytes is null
		or p_context_bytes not between 1 and 1048576 then
		raise exception 'Native launch provenance is invalid' using errcode = '22023'; end if;
	v_catalog := p_tool_catalog_text::jsonb;
	if jsonb_typeof(v_catalog) is distinct from 'object'
		or v_catalog - array['type','name','description','tools'] <> '{}'::jsonb
		or v_catalog ->> 'type' is distinct from 'namespace' or v_catalog ->> 'name' is distinct from 'qorpera'
		or jsonb_typeof(v_catalog -> 'description') is distinct from 'string'
		or jsonb_typeof(v_catalog -> 'tools') is distinct from 'array' then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_catalog -> 'tools') not between 1 and 32
		or exists(select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'type' is distinct from 'function'
				or coalesce(tool ->> 'name','') !~ '^[a-z][a-z0-9_]{0,63}$'
				or jsonb_typeof(tool -> 'description') is distinct from 'string'
				or tool #>> '{inputSchema,type}' is distinct from 'object'
				or tool #> '{inputSchema,additionalProperties}' is distinct from 'false'::jsonb
				or tool - array['type','name','description','inputSchema'] <> '{}'::jsonb)
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool)
			<> jsonb_array_length(v_catalog -> 'tools') then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if exists(select 1 from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1') then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	insert into public.qorpera_native_execution_launches(run_id,runtime_bundle_id,runtime_bundle_sha256,
		binary_sha256,reasoning_effort,reasoning_policy_sha256,tool_catalog_text,context_sha256,context_bytes)
	values(v_run.id,v_run.runtime_bundle_id,v_run.runtime_bundle_sha256,p_binary_sha256,
		v_run.reasoning_effort,v_run.reasoning_policy_sha256,p_tool_catalog_text,p_context_sha256,p_context_bytes)
	returning tool_catalog_sha256 into v_catalog_sha;
	-- Preserve the existing uncertain-execution/completion event protocol.
	v_payload := jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',v_run.id,'jobId',v_run.job_id,'leaseId',p_binding ->> 'leaseId','binarySha256',p_binary_sha256,
		'runtimeBundleSha256',v_run.runtime_bundle_sha256,'reasoningEffort',v_run.reasoning_effort,
		'reasoningPolicySha256',v_run.reasoning_policy_sha256,'toolCatalogSha256',v_catalog_sha,
		'contextSha256',p_context_sha256,'contextBytes',p_context_bytes);
	insert into public.qorpera_execution_run_events(run_id,event_type,payload) values(v_run.id,'runner_started',v_payload);
	return v_payload;
end
$$;

create or replace function public.qorpera_execution_run_json(p_run public.qorpera_execution_runs)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'run_id',p_run.id,'profile_id',p_run.profile_id,'environment_id',p_run.environment_id,
		'source_kind',p_run.source_kind,'source_id',p_run.source_id,'session_id',p_run.session_id,'job_id',p_run.job_id,
		'substrate_version_id',p_run.substrate_version_id,'company_snapshot_id',p_run.company_snapshot_id,
		'staff_agent_id',p_run.staff_agent_id,'staff_version',p_run.staff_version,
		'model_provider',p_run.model_provider,'model_id',p_run.model_id,'model_selection',p_run.model_selection,
		'model_mapping_version',p_run.model_mapping_version,'input_ids',to_jsonb(p_run.input_ids),
		'sponsor_binding_id',p_run.sponsor_binding_id,'sponsor_version',p_run.sponsor_version,
		'required_capability',p_run.required_capability,'job_type',p_run.job_type,'payload_sha256',p_run.payload_sha256,
		'publication_mode',p_run.publication_mode,'review_policy_key',p_run.review_policy_key,
		'reviewer_staff_ids',to_jsonb(p_run.reviewer_staff_ids),'logical_computer_id',p_run.logical_computer_id,
		'compute_identity_id',p_run.compute_identity_id,
		'compute_identity_ownership_kind',(select identity.ownership_kind from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'compute_identity_owner_user_id',(select identity.owner_user_id from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'compute_identity_owner_scope_key',(select identity.owner_scope_key from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'worker_class',p_run.worker_class,'requested_by_user_id',p_run.requested_by_user_id,
		'sponsored_by_user_id',p_run.sponsored_by_user_id,'audience_kind',p_run.audience_kind,
		'audience_user_id',p_run.audience_user_id,'runtime_bundle_id',p_run.runtime_bundle_id,
		'runtime_bundle_sha256',p_run.runtime_bundle_sha256,'transcript_start_sequence',p_run.transcript_start_sequence,
		'reasoning_effort',p_run.reasoning_effort,'reasoning_policy_sha256',p_run.reasoning_policy_sha256,
		'status',coalesce((select event.event_type from public.qorpera_execution_run_events event
			where event.run_id=p_run.id order by event.id desc limit 1),'queued'),
		'created_by_user_id',p_run.created_by_user_id,'created_at',p_run.created_at,'deadline_at',p_run.deadline_at)
$$;

revoke all on function public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs),
	public.qorpera_pin_execution_reasoning_policy(),
	public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer) to service_role;
