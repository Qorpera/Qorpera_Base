-- Routine effort (contract 17): an agent chooses the thinking depth of its
-- routine runs (low, medium or high; medium unless it says otherwise) when
-- it sets the routine up. Attended threads keep the bundle default. The
-- bundle's model policy now declares overrides = 'routine' with the allowed
-- set; the kernel resolves a routine wake's effort from its routine version
-- at run insert and pins it as before. Founder decision 2026-09-22.

create or replace function public.qorpera_manifest_allows_reasoning_effort(p_manifest jsonb, p_effort text)
returns boolean language sql immutable set search_path = '' as $$
	select p_effort is not null and (
		p_effort = p_manifest #>> '{modelPolicy,effort}'
		or (p_manifest #>> '{modelPolicy,overrides}' = 'routine'
			and jsonb_typeof(p_manifest #> '{modelPolicy,allowed}') = 'array'
			and (p_manifest #> '{modelPolicy,allowed}') ? p_effort))
$$;
revoke all on function public.qorpera_manifest_allows_reasoning_effort(jsonb, text) from public, anon, authenticated, service_role;

alter table public.qorpera_execution_runs
	drop constraint qorpera_execution_runs_reasoning_effort_check,
	add constraint qorpera_execution_runs_reasoning_effort_check check (reasoning_effort in ('low','medium','high'));
alter table public.qorpera_native_execution_launches
	drop constraint qorpera_native_execution_launches_reasoning_effort_check,
	add constraint qorpera_native_execution_launches_reasoning_effort_check check (reasoning_effort in ('low','medium','high'));

create or replace function public.qorpera_execution_runtime_manifest(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_manifest jsonb;
begin
	select manifest into v_manifest from public.qorpera_runtime_bundles
	where id = p_run.runtime_bundle_id and sha256 = p_run.runtime_bundle_sha256;
	if v_manifest ->> 'schema' is distinct from 'qorpera.runtime-bundle/v2'
		or v_manifest #>> '{modelPolicy,schema}' is distinct from 'qorpera.model-reasoning/v1'
		or v_manifest #>> '{modelPolicy,effort}' not in ('low','medium','high')
		or v_manifest #>> '{modelPolicy,overrides}' not in ('none','routine')
		or (v_manifest #>> '{modelPolicy,overrides}' = 'routine' and (
			jsonb_typeof(v_manifest #> '{modelPolicy,allowed}') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements_text(v_manifest #> '{modelPolicy,allowed}') allowed
				where allowed.value not in ('low','medium','high'))))
		or (v_manifest #>> '{modelPolicy,overrides}' = 'none' and v_manifest -> 'modelPolicy' ? 'allowed')
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

create or replace function public.qorpera_pin_execution_reasoning_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb; v_effort text; v_routine_effort text;
begin
	if tg_op = 'UPDATE' then
		if (new.reasoning_effort,new.reasoning_policy_sha256) is distinct from
			(old.reasoning_effort,old.reasoning_policy_sha256) then
			raise exception 'Execution reasoning policy is immutable' using errcode = '42501'; end if;
	else
		v_manifest := public.qorpera_execution_runtime_manifest(new);
		-- Caller hints and job flags cannot override the admitted bundle. A
		-- routine wake takes the effort its routine version declares when the
		-- bundle allows routine overrides (contract 17); anything else runs at
		-- the bundle default.
		v_effort := v_manifest #>> '{modelPolicy,effort}';
		if v_manifest #>> '{modelPolicy,overrides}' = 'routine' and new.source_kind = 'wake' then
			select version.effort into v_routine_effort
			from public.qorpera_wake_occurrences wake
			join public.qorpera_cloud_routine_versions version
				on version.routine_id = wake.routine_id and version.version = wake.routine_version
			where wake.id = new.source_id and wake.wake_kind = 'routine';
			if v_routine_effort is not null and public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_routine_effort) then
				v_effort := v_routine_effort; end if;
		end if;
		new.reasoning_effort := v_effort;
		new.reasoning_policy_sha256 := encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex');
	end if;
	return new;
end
$$;

create or replace function public.qorpera_describe_native_tool_authority(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_until timestamptz; v_remaining bigint; v_manifest jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if not public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)
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

create or replace function public.qorpera_begin_native_company_execution_v2(
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
		or not public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)
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
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		and not public.qorpera_run_native_start_superseded(v_run.id) then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	-- After a sponsor handoff the earlier launch is history; the read-provenance
	-- rows keep pointing at this run's launch identity.
	insert into public.qorpera_native_execution_launch_history(run_id,runtime_bundle_id,runtime_bundle_sha256,binary_sha256,
		reasoning_effort,reasoning_policy_sha256,tool_catalog_sha256,context_sha256,context_bytes,launched_at)
	select run_id,runtime_bundle_id,runtime_bundle_sha256,binary_sha256,reasoning_effort,reasoning_policy_sha256,
		tool_catalog_sha256,context_sha256,context_bytes,created_at
	from public.qorpera_native_execution_launches where run_id = v_run.id;
	insert into public.qorpera_native_execution_launches(run_id,runtime_bundle_id,runtime_bundle_sha256,
		binary_sha256,reasoning_effort,reasoning_policy_sha256,tool_catalog_text,context_sha256,context_bytes)
	values(v_run.id,v_run.runtime_bundle_id,v_run.runtime_bundle_sha256,p_binary_sha256,
		v_run.reasoning_effort,v_run.reasoning_policy_sha256,p_tool_catalog_text,p_context_sha256,p_context_bytes)
	on conflict (run_id) do update set runtime_bundle_id = excluded.runtime_bundle_id,
		runtime_bundle_sha256 = excluded.runtime_bundle_sha256,binary_sha256 = excluded.binary_sha256,
		reasoning_effort = excluded.reasoning_effort,reasoning_policy_sha256 = excluded.reasoning_policy_sha256,
		tool_catalog_text = excluded.tool_catalog_text,context_sha256 = excluded.context_sha256,
		context_bytes = excluded.context_bytes,created_at = clock_timestamp()
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

create or replace function public.qorpera_manage_agent_routine(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_effort text;
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb;
	v_action text := p_request ->> 'action'; v_key text := p_request ->> 'routineKey';
	v_routine public.qorpera_cloud_routines%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_trigger jsonb; v_triggers jsonb; v_sponsor_binding uuid; v_sponsor_version bigint; v_has_sponsor boolean; v_content jsonb; v_sha text;
	v_digest text; v_receipt uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_quiet jsonb := p_request -> 'quietHours'; v_expires timestamptz; v_max integer; v_next bigint;
	v_status text; v_reason text; v_allowed text[];
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null then
		raise exception 'Routine authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or v_action is null
		or v_action not in ('list','upsert','pause','resume','remove') then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;

	if v_action = 'list' then
		if (select count(*) from jsonb_object_keys(p_request)) <> 1 then
			raise exception 'Routine request is invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.agent-routines/v1','runId',v_run.id,'routines',coalesce((
			select jsonb_agg(public.qorpera_agent_routine_view(routine) order by routine.routine_key)
			from public.qorpera_cloud_routines routine
			where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
				and routine.origin = 'agent' and routine.owner_staff_agent_id = v_run.staff_agent_id
				and routine.status <> 'retired'), '[]'::jsonb));
	end if;

	-- An agent chooses the thinking depth of its routine runs; medium unless it says otherwise.
	v_effort := coalesce(p_request ->> 'effort', 'medium');
	if v_action = 'upsert' and ((p_request ? 'effort' and jsonb_typeof(p_request -> 'effort') <> 'string')
		or v_effort not in ('low','medium','high')) then
		raise exception 'Routine effort is invalid' using errcode = '22023'; end if;
	v_allowed := case when v_action = 'upsert'
		then array['action','operationKey','routineKey','title','intent','trigger','expiresAt','maxOccurrences','quietHours','effort']
		else array['action','operationKey','routineKey'] end;
	if exists (select 1 from jsonb_object_keys(p_request) key where key <> all(v_allowed))
		or coalesce(p_request ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(v_key,'') !~ '^[a-z0-9][a-z0-9._-]{0,95}$' then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;

	if v_action = 'upsert' then
		v_trigger := p_request -> 'trigger';
		if jsonb_typeof(v_trigger) is distinct from 'object' or v_trigger ? 'id' then
			raise exception 'Routine trigger is invalid' using errcode = '22023'; end if;
		v_trigger := v_trigger || jsonb_build_object('id', 'agent');
		v_triggers := jsonb_build_array(v_trigger);
		if not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or octet_length(convert_to(btrim(coalesce(p_request ->> 'title','')),'utf8')) not between 1 and 160
			or (p_request ->> 'title') ~ E'[\r\n]'
			or octet_length(convert_to(btrim(coalesce(p_request ->> 'intent','')),'utf8')) not between 1 and 32768 then
			raise exception 'Routine trigger or intent is invalid' using errcode = '22023'; end if;
		-- A file listener may only watch what this agent and its requester may read.
		if v_trigger ->> 'kind' = 'listener' and not public.qorpera_wake_path_authorized(
			v_run.environment_id, v_run.requested_by_user_id, v_run.staff_agent_id, v_trigger ->> 'path') then
			raise exception 'Routine listener path is unavailable' using errcode = '42501'; end if;
		if p_request ? 'expiresAt' and p_request -> 'expiresAt' <> 'null'::jsonb then
			begin v_expires := (p_request ->> 'expiresAt')::timestamptz;
			exception when others then raise exception 'Routine expiry is invalid' using errcode = '22023'; end;
			if v_expires <= statement_timestamp() or v_expires > statement_timestamp() + interval '5 years' then
				raise exception 'Routine expiry is invalid' using errcode = '22023'; end if;
		end if;
		if p_request ? 'maxOccurrences' and p_request -> 'maxOccurrences' <> 'null'::jsonb then
			if jsonb_typeof(p_request -> 'maxOccurrences') <> 'number'
				or (p_request ->> 'maxOccurrences') !~ '^[0-9]{1,6}$'
				or (p_request ->> 'maxOccurrences')::integer not between 1 and 100000 then
				raise exception 'Routine occurrence limit is invalid' using errcode = '22023'; end if;
			v_max := (p_request ->> 'maxOccurrences')::integer;
		end if;
		if v_quiet is not null and v_quiet <> 'null'::jsonb then
			if jsonb_typeof(v_quiet) <> 'object'
				or (select count(*) from jsonb_object_keys(v_quiet)) <> 3
				or coalesce(v_quiet ->> 'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
				or coalesce(v_quiet ->> 'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
				or v_quiet ->> 'start' = v_quiet ->> 'end'
				or not public.qorpera_runtime_time_zone_name_valid(v_quiet ->> 'timeZone') then
				raise exception 'Routine quiet hours are invalid' using errcode = '22023'; end if;
		else v_quiet := null; end if;
	end if;

	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding, v_receipt,
		'routine:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':routine:' || (p_request ->> 'operationKey'),'utf8'),'sha256'),'hex'),
		false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'state' <> 'executing' or (v_begun ->> 'receiptId')::uuid <> v_receipt then
		raise exception 'Routine operation needs reconciliation' using errcode = '55000'; end if;

	select * into v_routine from public.qorpera_cloud_routines routine
	where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
		and routine.origin = 'agent' and routine.owner_staff_agent_id = v_run.staff_agent_id
		and routine.routine_key = v_key for update;

	if v_action = 'upsert' then
		select sponsor.binding_id, sponsor.version into v_sponsor_binding, v_sponsor_version
		from public.qorpera_ensure_unattended_sponsor(v_run) sponsor;
		v_has_sponsor := v_sponsor_binding is not null;
		if not v_has_sponsor then
			-- The requester has no connected account of their own (the run is carried by
			-- someone else's). The version row must pin a sponsor, so pin the run's; the
			-- routine waits until the requester connects an account and saves it again.
			v_sponsor_binding := v_run.sponsor_binding_id; v_sponsor_version := v_run.sponsor_version;
		end if;
		v_content := jsonb_build_object('staff_agent_id', v_run.staff_agent_id, 'title', btrim(p_request ->> 'title'),
			'prompt', btrim(p_request ->> 'intent'), 'triggers', v_triggers, 'effort', v_effort,
			'sponsor_binding_id', v_sponsor_binding, 'sponsor_version', v_sponsor_version,
			'logical_computer_id', null, 'required_capability', 'agent_turn', 'job_type', 'agent_turn',
			'publication_mode', 'automatic', 'review_policy_key', null, 'reviewer_staff_ids', '[]'::jsonb);
		v_sha := encode(extensions.digest(convert_to(v_content::text,'utf8'),'sha256'),'hex');
		v_status := case when v_has_sponsor then 'active' else 'paused' end;
		v_reason := case when v_has_sponsor then null else 'needs_model_account' end;
		if v_routine.id is null then
			if (select count(*) from public.qorpera_cloud_routines routine
				where routine.profile_id = v_run.profile_id and routine.origin = 'agent'
					and routine.owner_staff_agent_id = v_run.staff_agent_id
					and routine.status in ('active','paused')) >= 32 then
				raise exception 'Agent routine limit reached' using errcode = '54000'; end if;
			insert into public.qorpera_cloud_routines(profile_id, environment_id, client_routine_id, status,
				created_by_user_id, origin, owner_staff_agent_id, routine_key)
			values (v_run.profile_id, v_run.environment_id, extensions.gen_random_uuid(), 'paused',
				v_run.requested_by_user_id, 'agent', v_run.staff_agent_id, v_key)
			returning * into v_routine;
		elsif v_routine.status = 'retired' then
			raise exception 'Routine key was removed; use a new key' using errcode = '55000';
		end if;
		select * into v_version from public.qorpera_cloud_routine_versions version
		where version.routine_id = v_routine.id and version.version = v_routine.current_version;
		if v_version.content_sha256 is distinct from v_sha then
			v_next := v_routine.current_version + 1;
			insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id,
				environment_id, staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version,
				logical_computer_id, required_capability, job_type, publication_mode, review_policy_key,
				reviewer_staff_ids, content_sha256, created_by_user_id)
			values (v_routine.id, v_next, extensions.gen_random_uuid(), v_run.profile_id, v_run.environment_id,
				v_run.staff_agent_id, btrim(p_request ->> 'title'), btrim(p_request ->> 'intent'), v_triggers, v_effort,
				v_sponsor_binding, v_sponsor_version, null, 'agent_turn', 'agent_turn', 'automatic', null, '{}',
				v_sha, v_run.requested_by_user_id);
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id)
			select v_routine.id, v_next, 'agent' where v_trigger ->> 'kind' = 'schedule';
		else v_next := v_routine.current_version; end if;
		update public.qorpera_cloud_routines set current_version = v_next, status = v_status, pause_reason = v_reason,
			expires_at = v_expires, max_occurrences = v_max, authorization_failures = 0,
			quiet_start = (v_quiet ->> 'start')::time, quiet_end = (v_quiet ->> 'end')::time,
			quiet_time_zone = v_quiet ->> 'timeZone', updated_at = statement_timestamp()
		where id = v_routine.id returning * into v_routine;
		if not v_has_sponsor then
			insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
			values (v_run.profile_id, v_run.requested_by_user_id, 'routine_needs_model_account',
				jsonb_build_object('staffAgentId', v_run.staff_agent_id, 'routineId', v_routine.id,
					'title', btrim(p_request ->> 'title')), 'agent:' || v_run.staff_agent_id::text)
			on conflict do nothing;
		end if;
	else
		if v_routine.id is null or v_routine.status = 'retired' then
			raise exception 'Routine is unavailable' using errcode = 'P0002'; end if;
		if v_action = 'pause' then
			update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'agent',
				updated_at = statement_timestamp()
			where id = v_routine.id and status = 'active' returning * into v_routine;
		elsif v_action = 'resume' then
			if v_routine.status = 'expired' then
				raise exception 'Routine has expired; save it again with a new expiry' using errcode = '55000'; end if;
			select * into v_version from public.qorpera_cloud_routine_versions version
			where version.routine_id = v_routine.id and version.version = v_routine.current_version;
			if not exists (select 1 from public.qorpera_ensure_unattended_sponsor(v_run) sponsor
				where sponsor.binding_id = v_version.sponsor_binding_id and sponsor.version = v_version.sponsor_version) then
				raise exception 'Routine model account is unavailable; save the routine again' using errcode = '55000'; end if;
			update public.qorpera_cloud_routines set status = 'active', pause_reason = null,
				authorization_failures = 0, updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;
		else
			update public.qorpera_cloud_routines set status = 'retired', pause_reason = null,
				updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;
		end if;
		if v_routine.id is null then
			select * into v_routine from public.qorpera_cloud_routines routine
			where routine.profile_id = v_run.profile_id and routine.origin = 'agent'
				and routine.owner_staff_agent_id = v_run.staff_agent_id and routine.routine_key = v_key;
		end if;
	end if;

	v_result := jsonb_build_object('schema','qorpera.agent-routine-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'action',v_action,'routine',case when v_routine.status = 'retired'
			then jsonb_build_object('routineKey',v_key,'status','retired')
			else public.qorpera_agent_routine_view(v_routine) end);
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;

create or replace function public.qorpera_agent_routine_view(p_routine public.qorpera_cloud_routines)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('routineKey', p_routine.routine_key, 'routineId', p_routine.id,
		'version', p_routine.current_version, 'status', p_routine.status, 'pauseReason', p_routine.pause_reason,
		'title', version.title, 'intent', version.prompt, 'trigger', version.triggers -> 0, 'effort', version.effort,
		'expiresAt', p_routine.expires_at, 'maxOccurrences', p_routine.max_occurrences,
		'quietHours', case when p_routine.quiet_start is null then null else jsonb_build_object(
			'start', to_char(p_routine.quiet_start, 'HH24:MI'), 'end', to_char(p_routine.quiet_end, 'HH24:MI'),
			'timeZone', p_routine.quiet_time_zone) end,
		'occurrences', (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine.id))
	from public.qorpera_cloud_routine_versions version
	where version.routine_id = p_routine.id and version.version = p_routine.current_version
$$;
