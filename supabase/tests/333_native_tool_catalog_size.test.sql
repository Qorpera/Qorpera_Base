-- @fixture 290_company_file_path_gateway.test.sql until "create function pg_temp.path_plan("
-- Runtime v92: a native run starts with up to 120 tools (OpenAI accepts 128
-- functions per request; Codex's own tools are almost all disabled). The
-- kernel used to refuse more than 32 while the guest allowed 48, so an agent
-- with a computer and a few connected services could not start at all. Real
-- admission, assignment and native lease from the 290 fixture.

create function pg_temp.catalog_begin(p_tools integer)
returns jsonb language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_identity jsonb := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
begin
	return public.qorpera_begin_native_company_execution_v2(v_binding,current_setting('qorpera_test.runtime_native_sha'),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		jsonb_build_object('type','namespace','name','qorpera','description','Synthetic native fixture',
			'tools',(select jsonb_agg(jsonb_build_object('type','function','name','tool_' || n,
				'description','Synthetic tool ' || n,'inputSchema',jsonb_build_object('type','object','additionalProperties',false)))
				from generate_series(1,p_tools) n))::text,
		repeat('c',64),10);
end
$$;

do $$
begin
	set local role service_role;
	begin
		perform pg_temp.catalog_begin(121);
		raise exception 'A native catalog of 121 tools was accepted';
	exception when sqlstate '22023' then null; end;
	if pg_temp.catalog_begin(120) ->> 'schema' is distinct from 'qorpera.native-company-execution-start/v1' then
		raise exception 'A native catalog of 120 tools was refused'; end if;
	reset role;
end
$$;

rollback;
