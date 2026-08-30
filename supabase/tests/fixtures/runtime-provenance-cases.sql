-- Inserted by test-runtime-provenance.mjs after SQL 290's real native admission
-- and first file commit. No authority helper is replaced. Subtransaction rollback
-- keeps the original transaction/approval/completion regression fixtures intact.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020'; v_run public.qorpera_execution_runs%rowtype;
	v_identity jsonb; v_role text; v_function text; v_old public.qorpera_execution_runs%rowtype;
	v_read jsonb; v_other jsonb; v_receipt jsonb; v_page jsonb; v_version uuid; v_parent uuid; v_output jsonb; v_view jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	if v_run.reasoning_effort is distinct from 'low' or v_run.reasoning_policy_sha256 is null
		or public.qorpera_execution_run_json(v_run) ->> 'reasoning_effort' is distinct from 'low'
		or public.qorpera_execution_runtime_manifest(v_run) ->> 'schema' <> 'qorpera.runtime-bundle/v2' then
		raise exception 'Native run did not pin the admitted effort and executable bundle'; end if;
	begin
		update public.qorpera_execution_runs set reasoning_policy_sha256 = repeat('f',64) where id = v_run.id;
		raise exception 'Run reasoning provenance was rewritten';
	exception when insufficient_privilege then null; end;
	v_old := v_run;
	select id,sha256 into v_old.runtime_bundle_id,v_old.runtime_bundle_sha256 from public.qorpera_runtime_bundles where version = 1;
	begin perform public.qorpera_execution_runtime_manifest(v_old);
		raise exception 'Protocol labels counted as executable compatibility';
	exception when insufficient_privilege then null; end;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_table_privilege(v_role,'public.qorpera_native_execution_launches','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_company_read_observations','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_company_read_confirmations','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_native_context_views','SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Runtime provenance table bypass exposed to %',v_role; end if;
		if has_function_privilege(v_role,'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)','EXECUTE') then
			raise exception 'Runtime manifest helper exposed to %',v_role; end if;
	end loop;
	set local role service_role;
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	if v_identity ->> 'reasoningEffort' <> 'low' or v_identity ->> 'reasoningPolicySha256' <> v_run.reasoning_policy_sha256 then
		raise exception 'Effort was omitted from live native identity'; end if;
	begin perform pg_temp.path_begin(v_binding,repeat('f',64));
		raise exception 'Mismatched native binary started'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_begin_native_company_execution_v2(v_binding,current_setting('qorpera_test.runtime_native_sha'),
		repeat('f',64),v_run.reasoning_policy_sha256,'{}',repeat('c',64),10);
		raise exception 'Different bundle started'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_begin_native_company_execution_v2(v_binding,current_setting('qorpera_test.runtime_native_sha'),
		v_run.runtime_bundle_sha256,repeat('f',64),'{}',repeat('c',64),10);
		raise exception 'Different effort policy started'; exception when insufficient_privilege then null; end;
	perform pg_temp.path_begin(v_binding);
	reset role;
	if not exists(select 1 from public.qorpera_native_execution_launches where run_id = v_run.id
		and runtime_bundle_sha256 = v_run.runtime_bundle_sha256 and reasoning_effort = 'low'
		and tool_catalog_sha256 = encode(extensions.digest(convert_to(tool_catalog_text,'utf8'),'sha256'),'hex')
		and context_sha256 = repeat('c',64) and context_bytes = 10) then
		raise exception 'Native launch did not preserve exact catalog and initial context digests'; end if;
	begin update public.qorpera_native_execution_launches set context_bytes = 11 where run_id = v_run.id;
		raise exception 'Launch provenance changed'; exception when insufficient_privilege then null; end;
	set local role service_role;
	v_read := public.qorpera_read_company_path_v2(v_environment,'note.md',2,8,v_binding);
	v_version := (v_read ->> 'version')::uuid;
	-- An unrelated live mutation is permitted; a run is not a company checkout.
	perform pg_temp.path_commit(pg_temp.path_plan('read-disjoint','read-disjoint',jsonb_build_object('kind','directory','path','read-disjoint')));
	perform public.qorpera_confirm_company_path_read(v_environment,v_binding,(v_read ->> 'readObservationId')::uuid,8,repeat('d',64));
	begin perform public.qorpera_confirm_company_path_read(v_environment,v_binding,(v_read ->> 'readObservationId')::uuid,7,repeat('d',64));
		raise exception 'Read receipt changed its delivered range'; exception when unique_violation then null; end;
	reset role;
	if not exists(select 1 from public.qorpera_company_read_observations observation
		join public.qorpera_company_read_confirmations confirmation on confirmation.read_id = observation.id
		where observation.id = (v_read ->> 'readObservationId')::uuid and observation.version = v_version
			and observation.snapshot_id = (v_read ->> 'snapshotId')::uuid and observation.requested_offset = 2
			and observation.requested_limit = 8 and confirmation.included_bytes = 8
			and observation.source #>> '{entry,file,fileSha256}' = v_read #>> '{entry,file,fileSha256}') then
		raise exception 'Read lost its version, range, snapshot or immutable content hash'; end if;
	set local role service_role;
	v_other := public.qorpera_read_company_path_v2(v_environment,'note.md',0,16,v_binding);
	perform pg_temp.path_commit(pg_temp.path_plan('read-replaced','note.md',pg_temp.path_stage_file('note.md','Changed file bytes'),v_version));
	begin perform public.qorpera_confirm_company_path_read(v_environment,v_binding,(v_other ->> 'readObservationId')::uuid,10,repeat('e',64));
		raise exception 'Changed read version was released'; exception when sqlstate 'PT412' then null; end;
	v_page := public.qorpera_list_company_paths_v2(v_environment,'',null,null,1,v_binding);
	perform public.qorpera_confirm_company_path_read(v_environment,v_binding,(v_page ->> 'readObservationId')::uuid,0,repeat('f',64));
	v_output := jsonb_build_object('callId','range-1','kind','function_call_output','sha256',repeat('a',64),'bytes',700,
		'readId',v_read ->> 'readObservationId','readSha256',repeat('d',64),'includedBytes',100,'includedSha256',repeat('b',64));
	v_view := jsonb_build_object('schema','qorpera.native-context-view/v1','requestId','request-1','threadId','thread-1',
		'turnId','turn-1','purpose','turn','outputs',jsonb_build_array(v_output));
	v_receipt := public.qorpera_record_native_context_view(v_environment,v_binding,v_view);
	if public.qorpera_record_native_context_view(v_environment,v_binding,v_view) <> v_receipt then
		raise exception 'Exact context replay changed its durable receipt'; end if;
	v_parent := (v_receipt ->> 'viewId')::uuid;
	begin perform public.qorpera_record_native_context_view(v_environment,v_binding,jsonb_set(v_view,'{outputs,0,sha256}',to_jsonb(repeat('b',64))));
		raise exception 'Request id accepted different context'; exception when unique_violation then null; end;
	begin perform public.qorpera_record_native_context_view(v_environment,v_binding,jsonb_set(
		jsonb_set(v_view,'{requestId}','"unconfirmed"'),'{outputs,0,readId}',v_other -> 'readObservationId'));
		raise exception 'Unconfirmed read entered a provider view'; exception when insufficient_privilege then null; end;
	v_receipt := public.qorpera_record_native_context_view(v_environment,v_binding,
		v_view || '{"requestId":"compaction-1","purpose":"compaction","outputs":[]}'::jsonb);
	reset role;
	if not exists(select 1 from public.qorpera_native_context_views where id = (v_receipt ->> 'viewId')::uuid
		and parent_id = v_parent and ordinal = 2) then
		raise exception 'Compaction dropped read ancestry'; end if;
	if not exists(select 1 from public.qorpera_company_retained_object_hashes(v_run.profile_id)
		where object_sha256 = v_read #>> '{entry,file,fileSha256}') then
		raise exception 'Read content was not retained with its evidence'; end if;
	begin update public.qorpera_company_read_observations set requested_offset = 3 where id = (v_read ->> 'readObservationId')::uuid;
		raise exception 'Observation was rewritten'; exception when insufficient_privilege then null; end;
	begin update public.qorpera_native_context_views set view = '{}' where id = v_parent;
		raise exception 'Context evidence was rewritten'; exception when insufficient_privilege then null; end;
	update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
	where id = current_setting('qorpera_test.path_grant')::uuid;
	set local role service_role;
	begin perform public.qorpera_record_native_context_view(v_environment,v_binding,
		v_view || '{"requestId":"after-revocation","outputs":[]}'::jsonb);
		raise exception 'Revoked read context survived an empty provider batch'; exception when insufficient_privilege then null; end;
	raise exception using errcode = 'QTPR1';
exception when sqlstate 'QTPR1' then null;
end
$$;
