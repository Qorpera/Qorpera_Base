-- 20260930247000: the legacy sweep, step F1d (a runner job's completion, its renewal and its run context). Four
-- functions keep only their folder-v2 path (folder-v2 only, the founder's decision of 3 October):
-- - qorpera_complete_runner_job_v6, the runner's completion, hands every job to qorpera_folder_complete_run_job, so
--   the snapshot-v1 completion qorpera_complete_runner_job_before_path_runtime has no caller left and goes;
-- - qorpera_complete_runner_job_v2 (under the folder completion, through v4 and v3) keeps the folder-v2 source check:
--   a job never has artifacts. Its artifact paths, which no folder-v2 job reaches, go with the artifacts (step E);
-- - qorpera_renew_runner_job takes the job FOR NO KEY UPDATE (P23) for every renewal;
-- - qorpera_describe_company_run_context names the company from the folder index and always adds the folder block.
-- Each folder-v2 path is the live text; create or replace keeps every grant, and the settings are restated.

set local lock_timeout = '3s';

create or replace function public.qorpera_complete_runner_job_v6(p_runner_id uuid, p_session_token_sha256 text,
	p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid,
	p_output_snapshot_id uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '25s'
set statement_timeout = '25s' as $function$
begin
	-- 20260930247000 (legacy sweep F1d): folder-v2 only, so the folder core completes every job.
	return public.qorpera_folder_complete_run_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_client_artifact_index_id, p_client_substrate_version_id, p_output_snapshot_id, p_result);
end
$function$;

drop function public.qorpera_complete_runner_job_before_path_runtime(uuid, text, uuid, text, uuid, uuid, uuid, jsonb);

create or replace function public.qorpera_complete_runner_job_v2(p_runner_id uuid, p_session_token_sha256 text,
	p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid,
	p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_source public.qorpera_company_substrate_versions%rowtype;
	v_existing_index public.qorpera_artifact_indexes%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
	v_existing_version public.qorpera_company_substrate_versions%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_artifact_ids uuid[];
	v_output_artifact_count integer;
	v_total_artifact_count integer;
	v_total_bytes bigint;
	v_index_sha256 text;
	v_version_sha256 text;
	v_result jsonb;
begin
	if auth.role() <> 'service_role'
		or p_client_artifact_index_id is null
		or p_client_substrate_version_id is null
		or p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or p_result ? 'output_substrate'
		or pg_column_size(p_result) > 64512
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
	for update;
	if found and v_job.status = 'completed' and v_job.terminal_lease_token_sha256 = p_lease_token_sha256 then
		if (v_job.result - 'output_substrate') <> p_result then
			raise exception 'runner completion replay differs from the stored result' using errcode = '23505';
		end if;
		if v_job.output_artifact_count > 0 and not exists (
			select 1
			from public.qorpera_artifact_indexes as artifact_index
			join public.qorpera_company_substrate_versions as version
				on version.id = v_job.output_substrate_version_id
			where artifact_index.id = v_job.output_artifact_index_id
				and artifact_index.client_index_id = p_client_artifact_index_id
				and version.client_version_id = p_client_substrate_version_id
				and version.artifact_index_id = artifact_index.id
		) then
			raise exception 'runner completion replay uses different publication ids' using errcode = '23505';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased'
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	-- 20260930247000 (legacy sweep F1d): folder-v2 only, so a job has no source substrate and no artifacts.
	if exists (select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then
		raise exception 'runner source substrate is inconsistent' using errcode = '55000'; end if;
	select count(*) into v_output_artifact_count
	from public.qorpera_runner_job_artifacts as job_artifact
	where job_artifact.job_id = v_job.id;
	if v_output_artifact_count = 0 then
		v_result := p_result || jsonb_build_object('output_substrate', null);
	else
		select coalesce(array_agg(source.artifact_id order by source.artifact_id), '{}'::uuid[])
		into v_artifact_ids
		from (
			select entry.artifact_id
			from public.qorpera_artifact_index_entries as entry
			where entry.index_id = v_source.artifact_index_id
			union
			select job_artifact.artifact_id
			from public.qorpera_runner_job_artifacts as job_artifact
			where job_artifact.job_id = v_job.id
		) as source;
		v_total_artifact_count := cardinality(v_artifact_ids);
		if v_total_artifact_count > 5000 then
			raise exception 'runner output substrate has too many artifacts' using errcode = '55000';
		end if;
		select coalesce(sum(artifact.bytes), 0) into v_total_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = any(v_artifact_ids)
			and artifact.profile_id = v_job.profile_id
			and artifact.environment_id = v_job.environment_id;
		if (
			select count(*)
			from public.qorpera_artifacts as artifact
			where artifact.id = any(v_artifact_ids)
				and artifact.profile_id = v_job.profile_id
				and artifact.environment_id = v_job.environment_id
		) <> v_total_artifact_count then
			raise exception 'runner output substrate contains unavailable artifacts' using errcode = '55000';
		end if;
		v_index_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', 1,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'artifact_ids', to_jsonb(v_artifact_ids)
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select artifact_index.* into v_existing_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.profile_id = v_job.profile_id
			and artifact_index.client_index_id = p_client_artifact_index_id;
		if found then
			if v_existing_index.environment_id <> v_job.environment_id
				or v_existing_index.content_sha256 <> v_index_sha256
				or v_existing_index.artifact_count <> v_total_artifact_count
				or v_existing_index.total_bytes <> v_total_bytes then
				raise exception 'runner output artifact index id is already bound to different content' using errcode = '23505';
			end if;
			v_index := v_existing_index;
		else
			insert into public.qorpera_artifact_indexes (
				profile_id, environment_id, client_index_id, contract_version,
				content_sha256, artifact_count, total_bytes, created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, p_client_artifact_index_id, 1,
				v_index_sha256, v_total_artifact_count, v_total_bytes, v_job.created_by_user_id
			) returning * into v_index;
			insert into public.qorpera_artifact_index_entries (index_id, ordinal, artifact_id)
			select v_index.id, (row_number() over (order by artifact_id))::integer, artifact_id
			from unnest(v_artifact_ids) as artifact_id;
		end if;
		v_version_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', v_source.contract_version,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'company_snapshot_id', v_source.company_snapshot_id,
						'operation_sequence', v_source.operation_sequence,
						'artifact_manifest_sha256', v_index.content_sha256
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select version.* into v_existing_version
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_job.profile_id
			and version.client_version_id = p_client_substrate_version_id;
		if found then
			if v_existing_version.environment_id <> v_job.environment_id
				or v_existing_version.company_snapshot_id <> v_source.company_snapshot_id
				or v_existing_version.contract_version <> v_source.contract_version
				or v_existing_version.operation_sequence <> v_source.operation_sequence
				or v_existing_version.operation_count <> v_source.operation_count
				or v_existing_version.artifact_index_id <> v_index.id
				or v_existing_version.content_sha256 <> v_version_sha256 then
				raise exception 'runner output substrate id is already bound to different content' using errcode = '23505';
			end if;
			v_version := v_existing_version;
		else
			insert into public.qorpera_company_substrate_versions (
				profile_id, environment_id, company_snapshot_id, client_version_id,
				contract_version, operation_sequence, operation_count,
				artifact_index_id, artifact_manifest_sha256, content_sha256,
				created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, v_source.company_snapshot_id,
				p_client_substrate_version_id, v_source.contract_version,
				v_source.operation_sequence, v_source.operation_count,
				v_index.id, v_index.content_sha256, v_version_sha256,
				v_job.created_by_user_id
			) returning * into v_version;
		end if;
		v_result := p_result || jsonb_build_object(
			'output_substrate', jsonb_build_object(
				'source_substrate_version_id', v_source.id,
				'artifact_index_id', v_index.id,
				'substrate_version_id', v_version.id,
				'output_artifact_count', v_output_artifact_count,
				'total_artifact_count', v_total_artifact_count
			)
		);
	end if;
	if pg_column_size(v_result) > 65536 then
		raise exception 'runner completion result is too large' using errcode = '22023';
	end if;
	update public.qorpera_runner_jobs
	set status = 'completed', terminal_lease_token_sha256 = lease_token_sha256,
		lease_token_sha256 = null, lease_expires_at = null,
		result = v_result, last_error = null, finished_at = statement_timestamp(),
		output_artifact_count = v_output_artifact_count,
		output_artifact_index_id = case when v_output_artifact_count > 0 then v_index.id else null end,
		output_substrate_version_id = case when v_output_artifact_count > 0 then v_version.id else null end
	where id = p_job_id
	returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_completed',
		jsonb_build_object(
			'attempt_count', v_job.attempt_count,
			'output_artifact_count', v_job.output_artifact_count,
			'output_artifact_index_id', v_job.output_artifact_index_id,
			'output_substrate_version_id', v_job.output_substrate_version_id
		),
		null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$;

create or replace function public.qorpera_renew_runner_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid,
	p_lease_token_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '25s'
set statement_timeout = '25s' as $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job renewal is invalid' using errcode = '42501';
	end if;
	-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run's tool calls (KEY SHARE).
	-- 20260930247000 (legacy sweep F1d): folder-v2 only, so every renewal.
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.status = 'leased' and job.runner_id = p_runner_id
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp() for no key update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() + interval '6 minutes'
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_lease_renewed',
		jsonb_build_object('lease_expires_at', v_job.lease_expires_at), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$;

create or replace function public.qorpera_describe_company_run_context(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_run public.qorpera_execution_runs%rowtype; v_authority jsonb; v_actor jsonb;
	v_staff public.qorpera_profile_staff%rowtype; v_company_name text; v_input_id uuid; v_event record;
	v_source jsonb; v_inputs jsonb := '[]'; v_history jsonb := '[]'; v_coworkers jsonb; v_job jsonb; v_spec jsonb;
	v_history_count bigint; v_coworker_count bigint; v_result jsonb; v_continuation jsonb; v_recorded jsonb; v_folder jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_run_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	if v_run.session_id is not null then
		perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
			and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
			and (session.staff_agent_id = v_run.staff_agent_id::text
				or (session.staff_agent_id is null and public.qorpera_company_room_session_staff(session.id,v_run.staff_agent_id)))
			and session.status = 'open'
			and session.audience_kind = v_run.audience_kind
			and session.audience_user_id is not distinct from v_run.audience_user_id for share;
		if not found then raise exception 'Cloud context audience is unavailable' using errcode = '42501'; end if;
	end if;
	select * into strict v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = v_run.staff_agent_id;
	-- An edit applies from the next run. A run describes its agent as of its own
	-- version, from the state recorded for that version.
	if v_staff.version <> v_run.staff_version then
		select operation.payload into v_recorded from public.qorpera_company_operations as operation
		where operation.profile_id = v_run.profile_id and operation.operation_type = 'staff_state'
			and operation.entity_id = v_run.staff_agent_id and operation.entity_version = v_run.staff_version
		order by operation.sequence desc limit 1;
		if v_recorded is null or v_staff.version < v_run.staff_version then
			raise exception 'Cloud context agent version is unavailable' using errcode = '42501'; end if;
		v_staff.version := v_run.staff_version;
		v_staff.display_name := v_recorded ->> 'display_name';
		v_staff.role := v_recorded ->> 'role';
	end if;
	-- 20260930247000 (legacy sweep F1d): folder-v2 only, so the company name always comes from the folder
	-- index, and the folder block below is always there.
	select name into v_company_name from public.qorpera_folder_company_index where environment_id = v_run.environment_id;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	foreach v_input_id in array v_run.input_ids loop
		v_source := public.qorpera_company_context_source(v_run,'input',v_input_id);
		v_inputs := v_inputs || jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,16384)));
	end loop;
	for v_event in select event_id,sequence from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type in ('message', 'interaction_request', 'interaction_answer', 'authorization_request', 'authorization_decision')
		and not (event_id = any(v_run.input_ids)) order by sequence desc limit 32 loop
		v_source := public.qorpera_company_context_source(v_run,'history',v_event.event_id);
		v_history := jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,2048))) || v_history;
	end loop;
	select count(*) into v_history_count from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type in ('message', 'interaction_request', 'interaction_answer', 'authorization_request', 'authorization_decision') and not (event_id = any(v_run.input_ids));
	v_source := public.qorpera_company_context_source(v_run,'job',v_run.id);
	v_job := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	v_source := public.qorpera_company_context_source(v_run,'job_spec',v_run.staff_agent_id);
	v_spec := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,16384));
	select coalesce(jsonb_agg(jsonb_build_object('id',staff_agent_id,'version',version,'name',display_name,'role',role)
		order by staff_agent_id),'[]') into v_coworkers from (select staff_agent_id,version,display_name,role
		from public.qorpera_profile_staff where profile_id = v_run.profile_id and employment_status = 'active'
			and staff_agent_id <> v_run.staff_agent_id order by staff_agent_id limit 50) coworker;
	execute 'select public.qorpera_company_state_run_folder($1, $2, $3)' into v_folder
	using v_run.environment_id, v_run.staff_agent_id,
		(select coalesce(array_agg((coworker ->> 'id')::uuid), '{}'::uuid[]) from jsonb_array_elements(v_coworkers) coworker);
	select count(*) into v_coworker_count from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and employment_status = 'active' and staff_agent_id <> v_run.staff_agent_id;
	if public.qorpera_run_continuation(v_run) is not null then
		v_source := public.qorpera_company_context_source(v_run,'continuation',v_run.id);
		v_continuation := (v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	end if;
	v_result := jsonb_build_object('schema','qorpera.native-company-context/v2','identity',v_authority -> 'identity',
		'observedAt',clock_timestamp(),'company',jsonb_build_object('id',v_run.profile_id,'name',v_company_name),
		'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),
		'agentKind',case when exists (select 1 from public.qorpera_company_cofounders cofounder
			where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = v_run.staff_agent_id)
			then 'cofounder' else 'employee' end,
		-- Match the canonical progress receipt used by the wake work gate,
		-- including its exact conversation. A sponsor change keeps the run
		-- and its sends; another assignment does not require another greeting.
		'initialAcknowledgementSatisfied',exists (
			select 1 from public.qorpera_agent_sends send
			join public.qorpera_session_events event on event.event_id = send.event_id
			where send.run_id = v_run.id and event.execution_id = v_run.id
				and send.session_id = v_run.session_id and event.session_id = v_run.session_id
				and send.phase = 'progress'),
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id),
		'runtimeBundle',jsonb_build_object('id',v_run.runtime_bundle_id,'sha256',v_run.runtime_bundle_sha256),
		'sourceKind',v_run.source_kind,'sourceId',v_run.source_id,'currentInputs',v_inputs,'history',v_history,
		'historyTruncated',v_history_count > jsonb_array_length(v_history),'coworkers',v_coworkers,
		'coworkersTruncated',v_coworker_count > jsonb_array_length(v_coworkers),'job',v_job,'jobSpecification',v_spec,'continuation',v_continuation)
		|| case when v_run.service_tier is null then '{}'::jsonb
			else jsonb_build_object('serviceTier',v_run.service_tier) end
		|| case when v_folder is null then '{}'::jsonb else jsonb_build_object('folder', v_folder) end;
	if octet_length(v_result::text) > 1048576 then raise exception 'Cloud context exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$function$;
