-- @fixture 290_company_file_path_gateway.test.sql until "create function pg_temp.path_plan("
-- Runtime v92: a native run starts with every tool its agent is granted. The
-- kernel used to refuse more than 32 (the guest more than 48), so an agent with
-- a computer and a few connected services could not start at all; a provider's
-- own limit is the provider's to enforce. The catalog's shape is still checked.
-- Real admission, assignment and native lease from the 290 fixture.

create function pg_temp.catalog_begin(p_tools jsonb)
returns jsonb language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_identity jsonb := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
begin
	return public.qorpera_begin_native_company_execution_v2(v_binding,current_setting('qorpera_test.runtime_native_sha'),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		jsonb_build_object('type','namespace','name','qorpera','description','Synthetic native fixture','tools',p_tools)::text,
		repeat('c',64),10);
end
$$;
create function pg_temp.catalog_tools(p_count integer)
returns jsonb language sql as $$
	select jsonb_agg(jsonb_build_object('type','function','name','tool_' || n,'description','Synthetic tool ' || n,
		'inputSchema',jsonb_build_object('type','object','additionalProperties',false)))
	from generate_series(1,p_count) n
$$;

do $$
declare v_bad jsonb;
begin
	set local role service_role;
	-- Malformed catalogs are still refused: none, a duplicate name, a non-function tool, an open schema.
	foreach v_bad in array array[
		'[]'::jsonb,
		pg_temp.catalog_tools(2) || jsonb_build_array(pg_temp.catalog_tools(1) -> 0),
		jsonb_build_array(jsonb_build_object('type','shell','name','tool_1','description','x',
			'inputSchema',jsonb_build_object('type','object','additionalProperties',false))),
		jsonb_build_array(jsonb_build_object('type','function','name','tool_1','description','x',
			'inputSchema',jsonb_build_object('type','object')))] loop
		begin
			perform pg_temp.catalog_begin(v_bad);
			raise exception 'A malformed native catalog was accepted: %', v_bad;
		exception when sqlstate '22023' then null; end;
	end loop;
	-- A catalog far beyond the old 32 (and beyond OpenAI's 128) starts: no count cap.
	if pg_temp.catalog_begin(pg_temp.catalog_tools(200)) ->> 'schema' is distinct from 'qorpera.native-company-execution-start/v1' then
		raise exception 'A native catalog of 200 tools was refused'; end if;
	reset role;
end
$$;

rollback;
