-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930109500 on a folder-v2 company: the one call before each model request (qorpera_fence_native_context) goes
-- through the native host's long entry point (qorpera_native_host_call_long: 25 s statement, 8 s lock), as the lease
-- validator does, and only through it. Control calls, part 2 (#839) asks a fence attempt the database cancels again at
-- the same length, so the entry point's statement budget is the longest a fence can take in the database. On 924's
-- real native run of Alice's, whose job's lease token hash is set here to a known token's (as test 792 does).
reset role;
select set_config('qorpera_test.fl_token', 'fl-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.fl_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;

-- The fence as the native host makes it before a model request: the publishable key's role, on the entry point's RPC
-- path, with the job's token, for the run's own environment and binding. 'ok:<result>', 'refused' (the entry point's
-- own refusal) or '<sqlstate>'.
create function pg_temp.fl_fence(p_entry text, p_request text) returns text language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_args jsonb; v_result jsonb;
begin
	select jsonb_build_object('p_environment_id', run.environment_id, 'p_binding', v_binding, 'p_paths', '[]'::jsonb,
		'p_view', jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', p_request,
			'threadId', 'thread-1', 'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb))
	into v_args from public.qorpera_execution_runs as run where run.id = (v_binding ->> 'runId')::uuid;
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/' || p_entry, true);
	execute 'set local role anon';
	begin
		execute format('select public.%I($1, $2, $3, $4)', p_entry) into v_result
		using (v_binding ->> 'jobId')::uuid, current_setting('qorpera_test.fl_token'), 'qorpera_fence_native_context', v_args;
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native host call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.fl_viewed(p_request text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_native_context_views
		where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid and request_id = p_request)
$$;

-- 1. The fence is listed with the long budget and keeps its binding scope. It sets statement_timeout 25s for itself (a
--    direct call gets the same budget; test 792 holds every listed call to that) and lock_timeout 3s (20260930540000,
--    test 467), so it waits at most 3 s for a lock, not the entry point's 8 s.
do $$
declare v_row public.qorpera_native_host_calls%rowtype; v_config text[];
begin
	select * into v_row from public.qorpera_native_host_calls where name = 'qorpera_fence_native_context';
	if v_row.budget is distinct from 'long' or v_row.scope is distinct from 'binding' then
		raise exception 'the fence is listed as % %', v_row.scope, v_row.budget; end if;
	select p.proconfig into v_config from pg_catalog.pg_proc as p
	where p.oid = 'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)'::regprocedure;
	if not coalesce(v_config @> array['statement_timeout=25s', 'lock_timeout=3s'], false)
		or (select count(*) from unnest(v_config) as setting where setting like 'lock_timeout=%') <> 1 then
		raise exception 'the fence sets %', v_config; end if;
end $$;

-- 2. Alice's run records its native start and acknowledges its wake (as test 746 does). Through the long entry point
--    the fence answers and records the view; through the 8 s one it is refused and records nothing.
select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_identity jsonb;
begin
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.base_public_send(v_binding, 'progress', 'fl-ack');
end
$$;
do $$
declare v_outcome text;
begin
	v_outcome := pg_temp.fl_fence('qorpera_native_host_call', 'fl-standard');
	if v_outcome is distinct from 'refused' or pg_temp.fl_viewed('fl-standard') then
		raise exception 'the fence through the 8 s entry point: %', v_outcome; end if;
	v_outcome := pg_temp.fl_fence('qorpera_native_host_call_long', 'fl-long');
	if v_outcome not like 'ok:%' then raise exception 'the fence through the 25 s entry point: %', v_outcome; end if;
	if (substr(v_outcome, 4)::jsonb ->> 'schema') is distinct from 'qorpera.native-context-fence/v1'
		or not pg_temp.fl_viewed('fl-long') then
		raise exception 'the fence through the 25 s entry point answered %', v_outcome; end if;
end $$;

rollback;
