-- Step 2 cloud context is assembled from admitted database state. A mounted
-- transcript, task payload, or string saying "system" cannot choose identity.
-- Text remains data; the native host supplies the versioned instruction prefix.

create function public.qorpera_company_context_excerpt(p_text text,p_offset integer,p_limit integer)
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
declare v_text text; v_size integer; v_characters integer;
begin
	if p_text is null or p_offset is null or p_offset < 0 or p_offset > char_length(p_text)
		or p_limit is null or p_limit not between 4 and 4096 then
		raise exception 'Cloud context range is invalid' using errcode = '22023'; end if;
	v_text := substr(p_text,p_offset + 1,p_limit);
	while octet_length(v_text) > p_limit loop
		v_text := left(v_text,char_length(v_text) - greatest(1,(octet_length(v_text) - p_limit + 3) / 4));
	end loop;
	v_size := octet_length(p_text); v_characters := char_length(v_text);
	return jsonb_build_object('text',v_text,'originalBytes',v_size,
		'sha256',encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'),
		'offset',p_offset,'nextOffset',case when p_offset + v_characters < char_length(p_text) then p_offset + v_characters else null end,
		'truncated',p_offset <> 0 or v_characters < char_length(p_text));
end
$$;

create function public.qorpera_company_context_source(p_run public.qorpera_execution_runs,p_kind text,p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_text text; v_author uuid; v_kind text; v_attachments integer := 0;
begin
	if p_kind = 'input' then
		select * into v_input from public.qorpera_session_inputs
		where id = p_id and id = any(p_run.input_ids) and session_id = p_run.session_id and execution_run_id = p_run.id;
		if not found or v_input.author_user_id <> p_run.requested_by_user_id then
			raise exception 'Cloud context input is unavailable' using errcode = '42501'; end if;
		v_kind := case when v_input.kind = 'kickoff' or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1'
			then 'private_startup' else 'current_human_request' end;
		v_author := v_input.author_user_id;
		v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;
		if jsonb_typeof(v_input.body -> 'images') = 'array' then v_attachments := jsonb_array_length(v_input.body -> 'images'); end if;
	elsif p_kind = 'history' then
		select * into v_event from public.qorpera_session_events
		where event_id = p_id and session_id = p_run.session_id and sequence <= p_run.transcript_start_sequence
			and event_type = 'message' and not (event_id = any(p_run.input_ids));
		if not found then raise exception 'Cloud context history is unavailable' using errcode = '42501'; end if;
		-- Provenance comes from source records, never a nested role field.
		select input.* into v_input from public.qorpera_session_inputs input
		where input.id = v_event.session_input_id and input.session_id = p_run.session_id
			and input.author_user_id = v_event.actor_user_id;
		if found then v_kind := 'historical_human_message'; v_author := v_input.author_user_id;
		elsif exists (select 1 from public.qorpera_agent_sends where event_id = v_event.event_id and session_id = p_run.session_id) then
			v_kind := 'historical_agent_send';
		else v_kind := 'historical_data'; end if;
		v_text := v_event.body::text;
	elsif p_kind = 'job' and p_id = p_run.id then
		select payload::text into strict v_text from public.qorpera_runner_jobs where id = p_run.job_id and run_id = p_run.id;
		v_kind := 'wake_data';
	elsif p_kind = 'job_spec' and p_id = p_run.staff_agent_id then
		select * into v_staff from public.qorpera_profile_staff
		where profile_id = p_run.profile_id and staff_agent_id = p_run.staff_agent_id
			and version = p_run.staff_version and employment_status = 'active';
		if not found then raise exception 'Cloud context job specification changed' using errcode = '42501'; end if;
		v_kind := 'job_specification'; v_text := v_staff.charter;
	else raise exception 'Cloud context source is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('kind',v_kind,'sourceKind',p_kind,'id',p_id,'authorUserId',v_author,
		'sequence',v_event.sequence,'attachmentCount',v_attachments,'text',coalesce(v_text,''));
end
$$;

create function public.qorpera_describe_company_run_context(p_binding jsonb)
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
		perform 1 from public.qorpera_shared_sessions where id = v_run.session_id and profile_id = v_run.profile_id
			and environment_id = v_run.environment_id and staff_agent_id = v_run.staff_agent_id::text and status = 'open' for share;
		if not found then raise exception 'Cloud context audience is unavailable' using errcode = '42501'; end if;
	end if;
	select * into strict v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id and staff_agent_id = v_run.staff_agent_id;
	select name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;
	foreach v_input_id in array v_run.input_ids loop
		v_source := public.qorpera_company_context_source(v_run,'input',v_input_id);
		v_inputs := v_inputs || jsonb_build_array((v_source - 'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024)));
	end loop;
	for v_event in select event_id,sequence from public.qorpera_session_events
		where session_id = v_run.session_id and sequence <= v_run.transcript_start_sequence and event_type = 'message'
			and not (event_id = any(v_run.input_ids)) order by sequence desc limit 32
	loop
		v_source := public.qorpera_company_context_source(v_run,'history',v_event.event_id);
		v_history := jsonb_build_array((v_source - 'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,512))) || v_history;
	end loop;
	select count(*) into v_history_count from public.qorpera_session_events
	where session_id = v_run.session_id and sequence <= v_run.transcript_start_sequence and event_type = 'message'
		and not (event_id = any(v_run.input_ids));
	v_source := public.qorpera_company_context_source(v_run,'job',v_run.id);
	v_job := (v_source - 'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024));
	v_source := public.qorpera_company_context_source(v_run,'job_spec',v_run.staff_agent_id::uuid);
	v_spec := (v_source - 'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	select coalesce(jsonb_agg(jsonb_build_object('id',staff_agent_id,'version',version,'name',display_name,'role',role)
		order by staff_agent_id),'[]') into v_coworkers from (
		select staff_agent_id,version,display_name,role from public.qorpera_profile_staff
		where profile_id = v_run.profile_id and employment_status = 'active' and staff_agent_id <> v_run.staff_agent_id
		order by staff_agent_id limit 50
	) coworker;
	select count(*) into v_coworker_count from public.qorpera_profile_staff
	where profile_id = v_run.profile_id and employment_status = 'active' and staff_agent_id <> v_run.staff_agent_id;
	v_result := jsonb_build_object('schema','qorpera.native-company-context/v1',
		'identity',v_authority -> 'identity','observedAt',clock_timestamp(),
		'company',jsonb_build_object('id',v_run.profile_id,'name',v_company_name),
		'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),
		'sourceKind',v_run.source_kind,'sourceId',v_run.source_id,
		'currentInputs',v_inputs,'history',v_history,'historyTruncated',v_history_count > jsonb_array_length(v_history),
		'coworkers',v_coworkers,'coworkersTruncated',v_coworker_count > jsonb_array_length(v_coworkers),
		'job',v_job,'jobSpecification',v_spec);
	if octet_length(v_result::text) > 1048576 then
		raise exception 'Cloud context exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;

create function public.qorpera_read_company_run_context(p_binding jsonb,p_source_kind text,p_source_id uuid,
	p_expected_sha256 text,p_offset integer,p_limit integer default 1024)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_source jsonb; v_content jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	v_source := public.qorpera_company_context_source(v_run,p_source_kind,p_source_id);
	v_content := public.qorpera_company_context_excerpt(v_source ->> 'text',p_offset,p_limit);
	if p_expected_sha256 is null or p_expected_sha256 is distinct from v_content ->> 'sha256' then
		raise exception 'Cloud context source changed' using errcode = '40001'; end if;
	return (v_source - 'text') || jsonb_build_object('content',v_content);
end
$$;

-- A raw hash capability cannot replace path or audience authorization after
-- cutover. Keep the old isolated substrate route only for unenrolled companies.
alter function public.qorpera_runner_broker_authorize_input_object(uuid,text,uuid,text,text)
	rename to qorpera_runner_broker_authorize_legacy_input_object;
revoke all on function public.qorpera_runner_broker_authorize_legacy_input_object(uuid,text,uuid,text,text)
	from public,anon,authenticated,service_role;
create function public.qorpera_runner_broker_authorize_input_object(p_runner_id uuid,p_session_token_sha256 text,
	p_job_id uuid,p_lease_token_sha256 text,p_object_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_job public.qorpera_runner_jobs%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	if exists (select 1 from public.qorpera_company_files where environment_id = v_job.environment_id and path_gateway_version = 1) then
		raise exception 'Company File objects require the authorized path gateway' using errcode = '42501'; end if;
	return public.qorpera_runner_broker_authorize_legacy_input_object(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256,p_object_sha256);
end
$$;

revoke all on function public.qorpera_company_context_excerpt(text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_describe_company_run_context(jsonb) from public,anon,authenticated;
revoke all on function public.qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer) from public,anon,authenticated;
revoke all on function public.qorpera_runner_broker_authorize_input_object(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.qorpera_describe_company_run_context(jsonb) to service_role;
grant execute on function public.qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer) to service_role;
grant execute on function public.qorpera_runner_broker_authorize_input_object(uuid,text,uuid,text,text) to service_role;
