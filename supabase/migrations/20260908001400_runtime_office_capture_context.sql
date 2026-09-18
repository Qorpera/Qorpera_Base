-- Native image evidence extends the existing context lineage. Pixels stay in
-- the governed artifact store/native history; neither audit nor fence holds URLs.
create function public.qorpera_assert_native_office_captures(p_binding jsonb,p_assets jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_asset jsonb; v_current jsonb; v_bytes bigint:=0;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Native capture authority required' using errcode='42501'; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	if jsonb_typeof(p_assets) is distinct from 'array' or pg_column_size(p_assets)>65536 then
		raise exception 'Native capture set invalid' using errcode='22023'; end if;
	if jsonb_array_length(p_assets)>128 then raise exception 'Native capture set too large' using errcode='54000'; end if;
	for v_asset in select value from jsonb_array_elements(p_assets) loop
		if jsonb_typeof(v_asset) is distinct from 'object' or coalesce(v_asset->>'assetId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Native capture invalid' using errcode='22023'; end if;
		v_current:=public.qorpera_read_native_office_capture(p_binding,(v_asset->>'assetId')::uuid);
		if v_current is distinct from v_asset then raise exception 'Native capture evidence changed' using errcode='42501'; end if;
		v_bytes:=v_bytes+(v_current->>'bytes')::bigint;
		if v_bytes>134217728 then raise exception 'Native capture byte budget exceeded' using errcode='54000'; end if;
	end loop;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','authorized','assets',p_assets);
end
$$;
revoke all on function public.qorpera_assert_native_office_captures(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qorpera_assert_native_office_captures(jsonb,jsonb) to service_role;

create or replace function public.qorpera_record_native_context_view(p_environment_id uuid,p_binding jsonb,p_view jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_view public.qorpera_native_context_views%rowtype; v_parent uuid; v_ordinal integer;
	v_output jsonb; v_read public.qorpera_company_read_confirmations%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Context view requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if not exists(select 1 from public.qorpera_native_execution_launches where run_id = (v_actor ->> 'runId')::uuid) then
		raise exception 'Native launch provenance is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_view) is distinct from 'object' or pg_column_size(p_view) > 131072
		or p_view - array['schema','requestId','threadId','turnId','purpose','outputs'] <> '{}'::jsonb
		or p_view ->> 'schema' is distinct from 'qorpera.native-context-view/v1'
		or coalesce(p_view ->> 'requestId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or coalesce(p_view ->> 'threadId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or (p_view -> 'turnId' is distinct from 'null'::jsonb and
			coalesce(p_view ->> 'turnId','') !~ '^[A-Za-z0-9_:.-]{1,160}$')
		or coalesce(p_view ->> 'purpose','') not in ('prewarm','turn','compaction')
		or jsonb_typeof(p_view -> 'outputs') is distinct from 'array' then
		raise exception 'Context view is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(p_view -> 'outputs') > 128
		or (p_view ->> 'purpose' = 'prewarm' and p_view -> 'outputs' <> '[]'::jsonb) then
		raise exception 'Context view budget is invalid' using errcode = '22023'; end if;
	for v_output in select value from jsonb_array_elements(p_view -> 'outputs') loop
		if jsonb_typeof(v_output) is distinct from 'object'
			or v_output - array['callId','kind','sha256','bytes','readId','readSha256','includedBytes','includedSha256','capture'] <> '{}'::jsonb
			or coalesce(v_output ->> 'callId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
			or coalesce(v_output ->> 'kind','') not in ('function_call_output','custom_tool_call_output')
			or coalesce(v_output ->> 'sha256','') !~ '^[0-9a-f]{64}$'
			or coalesce(v_output ->> 'bytes','') !~ '^[1-9][0-9]{0,3}$'
			or (v_output ->> 'bytes')::integer > 8192 then
			raise exception 'Context output is invalid' using errcode = '22023'; end if;
		if v_output ? 'capture' then
			perform public.qorpera_assert_native_office_captures(p_binding,jsonb_build_array(v_output->'capture'));
		end if;
		if v_output -> 'readId' is distinct from 'null'::jsonb then
			select confirmation.* into v_read from public.qorpera_company_read_confirmations confirmation
			join public.qorpera_company_read_observations observation on observation.id = confirmation.read_id
			where observation.id = (v_output ->> 'readId')::uuid and observation.run_id = (v_actor ->> 'runId')::uuid
				and observation.environment_id = p_environment_id;
			if not found or v_read.result_sha256 is distinct from v_output ->> 'readSha256'
				or coalesce(v_output ->> 'includedBytes','') !~ '^(0|[1-9][0-9]{0,3})$'
				or (v_output ->> 'includedBytes')::integer > 8192
				or coalesce(v_output ->> 'includedSha256','') !~ '^[0-9a-f]{64}$' then
				raise exception 'Context read provenance differs' using errcode = '42501'; end if;
		elsif v_output -> 'readSha256' is distinct from 'null'::jsonb
			or v_output -> 'includedBytes' is distinct from 'null'::jsonb
			or v_output -> 'includedSha256' is distinct from 'null'::jsonb then
			raise exception 'Unexpected context read provenance' using errcode = '22023'; end if;
	end loop;
	if (select count(distinct output ->> 'callId') from jsonb_array_elements(p_view -> 'outputs') output)
		<> jsonb_array_length(p_view -> 'outputs') then
		raise exception 'Duplicate context output' using errcode = '22023'; end if;
	select * into v_view from public.qorpera_native_context_views where run_id = (v_actor ->> 'runId')::uuid
		and request_id = p_view ->> 'requestId';
	if found then
		if v_view.view <> p_view then raise exception 'Context request replay differs' using errcode = '23505'; end if;
	else
		select id,ordinal into v_parent,v_ordinal from public.qorpera_native_context_views
		where run_id = (v_actor ->> 'runId')::uuid order by ordinal desc limit 1;
		if coalesce(v_ordinal,0) >= 256 then raise exception 'Context view budget exceeded' using errcode = '54000'; end if;
		-- Parent lineage retains evidence used to derive a compacted summary even
		-- when that provider request no longer repeats an old tool output.
		insert into public.qorpera_native_context_views(run_id,ordinal,parent_id,request_id,view)
		values((v_actor ->> 'runId')::uuid,coalesce(v_ordinal,0)+1,v_parent,p_view ->> 'requestId',p_view)
		returning * into v_view;
	end if;
	return jsonb_build_object('schema','qorpera.native-context-view-receipt/v1',
		'viewId',v_view.id,'requestId',v_view.request_id,'sha256',v_view.sha256,'ordinal',v_view.ordinal);
end
$$;
