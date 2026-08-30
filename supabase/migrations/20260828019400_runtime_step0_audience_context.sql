-- Runtime Order 0 audience and provenance propagation. Session audience,
-- source actor and runtime bundle are derived from admitted rows, never from
-- model payloads or a caller-selectable binding field.

create or replace function public.qorpera_describe_native_tool_authority(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_until timestamptz; v_remaining bigint;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
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
			'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id));
end
$$;

create or replace function public.qorpera_company_path_actor(p_environment_id uuid,p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_user uuid; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if p_binding is not null then
		v_run := public.qorpera_native_tool_locked_run(p_binding);
		if v_run.environment_id <> p_environment_id or v_run.source_kind = 'proposal_review' then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		if v_run.session_id is not null then
			perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
				and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
				and session.staff_agent_id = v_run.staff_agent_id::text and session.status = 'open'
				and session.audience_kind = v_run.audience_kind
				and session.audience_user_id is not distinct from v_run.audience_user_id for share;
			if not found then raise exception 'Company File audience is unavailable' using errcode = '42501'; end if;
		end if;
		if exists (select 1 from unnest(v_run.input_ids) requested(id)
			left join public.qorpera_session_inputs input on input.id = requested.id
			where input.id is null or input.session_id is distinct from v_run.session_id
				or input.execution_run_id is distinct from v_run.id
				or input.author_user_id is distinct from v_run.requested_by_user_id
				or input.runtime_bundle_id <> v_run.runtime_bundle_id
				or input.runtime_bundle_sha256 <> v_run.runtime_bundle_sha256) then
			raise exception 'Company File requesting input changed' using errcode = '42501'; end if;
		v_user := v_run.requested_by_user_id;
	else
		v_user := auth.uid();
		if auth.role() is distinct from 'authenticated' or v_user is null then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if v_file.path_gateway_version is distinct from 1 or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_user for share;
	if not found then raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if p_binding is not null then
		perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
			and staff_agent_id = v_run.staff_agent_id and version = v_run.staff_version
			and employment_status = 'active' for share;
		if not found then raise exception 'Company File staff version changed' using errcode = '42501'; end if;
		perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
			and user_id = v_run.sponsored_by_user_id for share;
		perform 1 from public.qorpera_execution_sponsor_bindings where id = v_run.sponsor_binding_id for share;
		perform 1 from public.qorpera_provider_connections connection
		join public.qorpera_execution_sponsor_versions sponsor on sponsor.provider_connection_id = connection.id
		where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version for share of connection;
		perform 1 from public.qorpera_runner_assignments where id = (p_binding ->> 'assignmentId')::uuid for share;
		perform 1 from public.qorpera_runners where id = (p_binding ->> 'runnerId')::uuid for share;
		perform 1 from public.qorpera_member_compute_identities where id = v_run.compute_identity_id for share;
		perform 1 from public.qorpera_native_credential_capsules where id = (p_binding ->> 'credentialCapsuleId')::uuid for share;
		perform public.qorpera_native_tool_locked_run(p_binding);
	end if;
	if public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	return jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,'userId',v_user,
		'staffAgentId',v_run.staff_agent_id,'runId',v_run.id,'jobId',v_run.job_id,
		'assignmentId',p_binding ->> 'assignmentId','sponsorBindingId',v_run.sponsor_binding_id,
		'sponsorVersion',v_run.sponsor_version,
		'audience',case when p_binding is null then 'human' else v_run.audience_kind end,
		'audienceUserId',case when p_binding is null then v_user else v_run.audience_user_id end,
		'runtimeBundleId',coalesce(v_run.runtime_bundle_id,v_bundle.runtime_bundle_id),
		'runtimeBundleSha256',coalesce(v_run.runtime_bundle_sha256,v_bundle.runtime_bundle_sha256));
end
$$;

create or replace function public.qorpera_company_path_allowed(p_actor jsonb,p_path text,p_permission text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_profile uuid := (p_actor ->> 'companyId')::uuid;
begin
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid,p_path);
	if not public.qorpera_company_path_principal_allowed(v_profile,v_resource,'member',
		(p_actor ->> 'userId')::uuid,p_permission) then return false; end if;
	if p_actor ->> 'audience' = 'company' then
		return v_resource.scope <> 'member_private' and public.qorpera_company_path_principal_allowed(
			v_profile,v_resource,'staff_agent',(p_actor ->> 'staffAgentId')::uuid,p_permission);
	end if;
	if p_actor ->> 'audience' = 'member_private' then
		return v_resource.scope = 'member_private'
			and v_resource.owner_user_id = (p_actor ->> 'audienceUserId')::uuid
			and v_resource.owner_user_id = (p_actor ->> 'userId')::uuid
			and public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',
				(p_actor ->> 'staffAgentId')::uuid,p_permission);
	end if;
	return p_actor ->> 'audience' = 'human';
end
$$;

create or replace function public.qorpera_company_path_approved_actor(p_proposal_id uuid,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_company_path_proposals%rowtype; v_file public.qorpera_company_files%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_actor jsonb; v_source_actor jsonb; v_role public.qorpera_profile_role; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File publisher authority is required' using errcode = '42501'; end if;
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	select * into v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id for update;
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	select role into v_role from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = v_proposal.approved_by_user_id for share;
	if not found or v_proposal.plan_sha256 is distinct from p_plan_sha256
		or v_proposal.status not in ('approved','applied') or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id
		or public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise exception 'Company File approval authority is unavailable' using errcode = '42501'; end if;
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'userId',v_proposal.approved_by_user_id,'staffAgentId',null,'runId',v_proposal.run_id,'audience','human',
		'audienceUserId',v_proposal.approved_by_user_id,'runtimeBundleId',v_bundle.runtime_bundle_id,
		'runtimeBundleSha256',v_bundle.runtime_bundle_sha256);
	v_resource := public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','write');
	if (v_resource.scope <> 'member_private' and v_role not in ('owner','admin'))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> v_proposal.approved_by_user_id)
		or v_resource.id <> v_proposal.resource_id or v_resource.version <> v_proposal.resource_version then
		raise exception 'Company File approval policy changed' using errcode = '42501'; end if;
	if v_proposal.status = 'applied' then return v_actor; end if;
	if v_proposal.approval_expires_at <= clock_timestamp() then
		raise exception 'Company File approval expired' using errcode = '42501'; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = v_proposal.run_id;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = v_run.requested_by_user_id for share;
	perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
		and staff_agent_id = v_run.staff_agent_id for share;
	if not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'member',v_run.requested_by_user_id,'write')
		or not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',v_run.staff_agent_id,'write') then
		raise exception 'Company File proposal source authority was revoked' using errcode = '42501'; end if;
	v_source_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'runId',v_run.id,'userId',v_run.requested_by_user_id,'staffAgentId',v_run.staff_agent_id,
		'audience',v_run.audience_kind,'audienceUserId',v_run.audience_user_id,
		'runtimeBundleId',v_run.runtime_bundle_id,'runtimeBundleSha256',v_run.runtime_bundle_sha256);
	perform public.qorpera_company_path_assert_context(v_source_actor);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_company_path_plan(v_actor,v_proposal.plan,true);
	return v_actor;
end
$$;

create or replace function public.qorpera_company_context_source(p_run public.qorpera_execution_runs,p_kind text,p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_text text; v_author uuid; v_kind text; v_actor_kind text;
	v_attachments integer := 0;
begin
	if p_kind = 'input' then
		select * into v_input from public.qorpera_session_inputs where id = p_id and id = any(p_run.input_ids)
			and session_id = p_run.session_id and execution_run_id = p_run.id;
		if not found or v_input.author_user_id <> p_run.requested_by_user_id
			or v_input.runtime_bundle_id <> p_run.runtime_bundle_id
			or v_input.runtime_bundle_sha256 <> p_run.runtime_bundle_sha256 then
			raise exception 'Cloud context input is unavailable' using errcode = '42501'; end if;
		v_kind := case when v_input.kind = 'kickoff' or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1'
			then 'private_startup' else 'current_human_request' end;
		v_actor_kind := v_input.actor_kind; v_author := v_input.author_user_id;
		v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;
		if jsonb_typeof(v_input.body -> 'images') = 'array' then v_attachments := jsonb_array_length(v_input.body -> 'images'); end if;
	elsif p_kind = 'history' then
		select * into v_event from public.qorpera_session_events where event_id = p_id and session_id = p_run.session_id
			and sequence <= p_run.transcript_start_sequence and event_type = 'message' and not (event_id = any(p_run.input_ids));
		if not found then raise exception 'Cloud context history is unavailable' using errcode = '42501'; end if;
		select input.* into v_input from public.qorpera_session_inputs input where input.id = v_event.session_input_id
			and input.session_id = p_run.session_id and input.author_user_id = v_event.actor_user_id;
		if found then v_kind := 'historical_human_message'; v_actor_kind := 'human'; v_author := v_input.author_user_id;
		elsif exists (select 1 from public.qorpera_agent_sends where event_id = v_event.event_id and session_id = p_run.session_id) then
			v_kind := 'historical_agent_send'; v_actor_kind := 'staff_agent';
		else v_kind := 'historical_data'; v_actor_kind := 'company_service'; end if;
		v_text := v_event.body::text;
	elsif p_kind = 'job' and p_id = p_run.id then
		select payload::text into strict v_text from public.qorpera_runner_jobs where id = p_run.job_id and run_id = p_run.id;
		v_kind := 'wake_data'; v_actor_kind := 'control_plane';
	elsif p_kind = 'job_spec' and p_id = p_run.staff_agent_id then
		select * into v_staff from public.qorpera_profile_staff where profile_id = p_run.profile_id
			and staff_agent_id = p_run.staff_agent_id and version = p_run.staff_version and employment_status = 'active';
		if not found then raise exception 'Cloud context job specification changed' using errcode = '42501'; end if;
		v_kind := 'job_specification'; v_actor_kind := 'company_service'; v_text := v_staff.charter;
	else raise exception 'Cloud context source is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('kind',v_kind,'sourceKind',p_kind,'id',p_id,'actorKind',v_actor_kind,
		'authorUserId',v_author,'sequence',v_event.sequence,'attachmentCount',v_attachments,'text',coalesce(v_text,''));
end
$$;

create or replace function public.qorpera_describe_company_run_context(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_authority jsonb; v_actor jsonb;
	v_staff public.qorpera_profile_staff%rowtype; v_company_name text; v_input_id uuid; v_event record;
	v_source jsonb; v_inputs jsonb := '[]'; v_history jsonb := '[]'; v_coworkers jsonb; v_job jsonb; v_spec jsonb;
	v_history_count bigint; v_coworker_count bigint; v_result jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	if v_run.session_id is not null then
		perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
			and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
			and session.staff_agent_id = v_run.staff_agent_id::text and session.status = 'open'
			and session.audience_kind = v_run.audience_kind
			and session.audience_user_id is not distinct from v_run.audience_user_id for share;
		if not found then raise exception 'Cloud context audience is unavailable' using errcode = '42501'; end if;
	end if;
	select * into strict v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = v_run.staff_agent_id;
	select name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;
	foreach v_input_id in array v_run.input_ids loop
		v_source := public.qorpera_company_context_source(v_run,'input',v_input_id);
		v_inputs := v_inputs || jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024)));
	end loop;
	for v_event in select event_id,sequence from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type = 'message'
		and not (event_id = any(v_run.input_ids)) order by sequence desc limit 32 loop
		v_source := public.qorpera_company_context_source(v_run,'history',v_event.event_id);
		v_history := jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,512))) || v_history;
	end loop;
	select count(*) into v_history_count from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type = 'message' and not (event_id = any(v_run.input_ids));
	v_source := public.qorpera_company_context_source(v_run,'job',v_run.id);
	v_job := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024));
	v_source := public.qorpera_company_context_source(v_run,'job_spec',v_run.staff_agent_id);
	v_spec := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	select coalesce(jsonb_agg(jsonb_build_object('id',staff_agent_id,'version',version,'name',display_name,'role',role)
		order by staff_agent_id),'[]') into v_coworkers from (select staff_agent_id,version,display_name,role
		from public.qorpera_profile_staff where profile_id = v_run.profile_id and employment_status = 'active'
			and staff_agent_id <> v_run.staff_agent_id order by staff_agent_id limit 50) coworker;
	select count(*) into v_coworker_count from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and employment_status = 'active' and staff_agent_id <> v_run.staff_agent_id;
	v_result := jsonb_build_object('schema','qorpera.native-company-context/v1','identity',v_authority -> 'identity',
		'observedAt',clock_timestamp(),'company',jsonb_build_object('id',v_run.profile_id,'name',v_company_name),
		'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id),
		'runtimeBundle',jsonb_build_object('id',v_run.runtime_bundle_id,'sha256',v_run.runtime_bundle_sha256),
		'sourceKind',v_run.source_kind,'sourceId',v_run.source_id,'currentInputs',v_inputs,'history',v_history,
		'historyTruncated',v_history_count > jsonb_array_length(v_history),'coworkers',v_coworkers,
		'coworkersTruncated',v_coworker_count > jsonb_array_length(v_coworkers),'job',v_job,'jobSpecification',v_spec);
	if octet_length(v_result::text) > 1048576 then raise exception 'Cloud context exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;
