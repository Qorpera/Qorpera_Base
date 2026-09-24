-- @fixture 290_company_file_path_gateway.test.sql until "-- Human content reads bind a current path/version"
-- Runtime v92: a run reads the Company File and asks its model without a count.
-- Runtime v102: one request's view holds any number of tool outputs.
-- It used to fail after 128 model reads or lists, 128 distinct files held in its
-- context, or 256 model requests (one context view is recorded per request).
-- Real admission, native start and first commit from the 290 fixture.
set local role service_role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020'; v_read jsonb; v_receipt jsonb; v_n integer;
begin
	for v_n in 1..130 loop
		v_read := public.qorpera_read_company_path_v2(v_environment,'note.md',0,16,v_binding);
		if v_read ->> 'readObservationId' is null then raise exception 'Read % was refused', v_n; end if;
	end loop;
	for v_n in 1..4 loop perform public.qorpera_list_company_paths_v2(v_environment,'',null,null,1,v_binding); end loop;
	reset role;
	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_binding ->> 'runId')::uuid) < 134 then
		raise exception 'Reads beyond the old bound were not recorded'; end if;
	set local role service_role;
	-- 130 distinct files in the run's context are still re-checked before a model request.
	perform public.qorpera_assert_company_path_reads(v_environment,v_binding,
		array(select 'notes/file-' || n || '.md' from generate_series(1,130) n) || array['note.md']);
	reset role;
	if (select count(*) from public.qorpera_company_run_read_paths where run_id = (v_binding ->> 'runId')::uuid) < 131 then
		raise exception 'The context read set did not hold 131 files'; end if;
	set local role service_role;
	perform pg_temp.path_begin(v_binding);
	for v_n in 1..300 loop
		v_receipt := public.qorpera_record_native_context_view(v_environment,v_binding,jsonb_build_object(
			'schema','qorpera.native-context-view/v1','requestId','request-' || v_n,'threadId','thread-1',
			'turnId','turn-1','purpose','turn','outputs','[]'::jsonb));
	end loop;
	if (v_receipt ->> 'ordinal')::integer <> 300 then raise exception 'Model request 300 was not recorded: %', v_receipt; end if;
	-- Runtime v102: one request's view holds any number of tool outputs (was 128, and 128 KiB).
	v_receipt := public.qorpera_record_native_context_view(v_environment,v_binding,jsonb_build_object(
		'schema','qorpera.native-context-view/v1','requestId','request-wide','threadId','thread-1','turnId','turn-1','purpose','turn',
		'outputs',(select jsonb_agg(jsonb_build_object('callId','call-' || n,'kind','function_call_output','sha256',repeat('a',64),
			'bytes',8000,'readId',null,'readSha256',null,'includedBytes',null,'includedSha256',null)) from generate_series(1,600) n)));
	if v_receipt ->> 'requestId' is distinct from 'request-wide' then raise exception 'A view of 600 outputs was not recorded'; end if;
	-- Access is still checked: a revoked read grant stops the next model request.
	reset role;
	update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
	where id = current_setting('qorpera_test.path_grant')::uuid;
	set local role service_role;
	begin
		perform public.qorpera_record_native_context_view(v_environment,v_binding,jsonb_build_object(
			'schema','qorpera.native-context-view/v1','requestId','after-revocation','threadId','thread-1',
			'turnId','turn-1','purpose','turn','outputs','[]'::jsonb));
		raise exception 'A revoked read context survived request 301';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

rollback;
