-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930618000 on 924's real native run of Alice's: qorpera_check_native_run makes both of the run's checks in one call
-- of the native host. Through the host's entry point, one check makes exactly the calls of the two it replaces, the
-- plain describe included (test 467 holds it to their 3 s wait for the run's row, and to the order of the run's row and a
-- wake run's connection); a refusal from either is the call's;
-- it is listed with the binding scope on the 8 s entry point; and only the platform's service caller reaches it. Timed
-- beside the two separate calls at the end (printed, not checked).
reset role;
select set_config('qorpera_test.nc_token', 'nc1103-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.nc_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;

select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_identity jsonb; v_actor jsonb; v_read jsonb;
	v_resource uuid;
begin
	v_actor := jsonb_build_object('kind','run','runId',v_binding ->> 'runId','jobId',v_binding ->> 'jobId',
		'runnerId',v_binding ->> 'runnerId','assignmentId',v_binding ->> 'assignmentId');
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.base_public_send(v_binding, 'progress', 'nc-ack');
	-- The run reads a shared file and releases the read, so its read set has something to re-check (as test 666 does).
	v_resource := public.qorpera_folder_set_resource('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'nc-shared',
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), v_resource, 'staff_agent',
		'92400000-0000-4000-8000-000000000030', array['read']);
	perform pg_temp.base_commit('{"kind":"platform"}', 'nc-shared', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','nc-shared'),
		jsonb_build_object('op','write','path','nc-shared/s.txt','file',pg_temp.base_stage('shared text'))));
	v_read := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', v_actor, 'nc-shared/s.txt') -> 'entry';
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', v_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version', 'authority', v_read -> 'authority')),
		repeat('0', 64));
end
$$;

-- The check as the native host makes it: the publishable key's role, on the entry point's RPC path, with the job's token.
-- 'ok:<result>', 'refused' (the entry point's own refusal) or '<sqlstate>'.
create function pg_temp.nc_host(p_entry text, p_args jsonb, p_name text default 'qorpera_check_native_run') returns text language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/' || p_entry, true);
	execute 'set local role anon';
	begin
		execute format('select public.%I($1, $2, $3, $4)', p_entry) into v_result
		using (v_binding ->> 'jobId')::uuid, current_setting('qorpera_test.nc_token'), p_name, p_args;
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native host call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.nc_args() returns jsonb language sql as $$
	select jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020'::uuid,
		'p_binding', current_setting('qorpera_test.base_binding')::jsonb)
$$;
-- 1. Listed with the binding scope on the 8 s entry point (it sets no statement budget of its own, as test 792 holds);
--    only the platform's service caller reaches it; it reads as its two calls do.
do $$
declare v_row public.qorpera_native_host_calls%rowtype;
begin
	select * into v_row from public.qorpera_native_host_calls where name = 'qorpera_check_native_run';
	if v_row.budget is distinct from 'standard' or v_row.scope is distinct from 'binding' then
		raise exception 'the run check is listed as % %', v_row.scope, v_row.budget; end if;
	if exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.qorpera_check_native_run(uuid,jsonb)'::regprocedure
			and (not p.prosecdef or p.proconfig is distinct from array['search_path=""'])) then
		raise exception 'the run check is not a definer function with only its search path set'; end if;
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'qorpera_secret_broker']) as r(name)
			where has_function_privilege(r.name, 'public.qorpera_check_native_run(uuid,jsonb)', 'execute'))
		or not has_function_privilege('service_role', 'public.qorpera_check_native_run(uuid,jsonb)', 'execute') then
		raise exception 'the run check has the wrong callers'; end if;
	perform set_config('request.path', '/rpc/qorpera_check_native_run', true);
	if not public.qorpera_company_fence_shared() then raise exception 'the run check is not a reader of the company fence'; end if;
	perform set_config('request.path', '', true);
end $$;

do $$
declare v_outcome text; v_authority jsonb; v_described jsonb;
begin
	v_outcome := pg_temp.nc_host('qorpera_native_host_call',
		jsonb_build_object('p_binding', current_setting('qorpera_test.base_binding')::jsonb), 'qorpera_describe_native_tool_authority');
	if v_outcome not like 'ok:%' then raise exception 'describe through the entry point: %', v_outcome; end if;
	v_described := substr(v_outcome, 4)::jsonb;
	v_outcome := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args() || '{"p_paths": []}'::jsonb, 'qorpera_assert_company_path_reads');
	if v_outcome not like 'ok:%' then raise exception 'the read-set check through the entry point: %', v_outcome; end if;
	v_outcome := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args());
	if v_outcome not like 'ok:%' then raise exception 'the run check through the entry point: %', v_outcome; end if;
	v_authority := substr(v_outcome, 4)::jsonb;
	if v_authority ->> 'schema' is distinct from 'qorpera.native-tool-authority/v1'
		or v_authority -> 'identity' is distinct from v_described -> 'identity' then
		raise exception 'the run check answered %', v_authority; end if;
end $$;

-- 3. A refusal of either check is the call's. The read-set check: another environment than the run's, called as the
--    service caller (the entry point refuses that first, also tested). Describe alone: a run whose reasoning policy
--    changed, which only describe checks (3b). A lapsed lease, which both refuse.
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error(format('select public.qorpera_check_native_run(%L::uuid, %L::jsonb)',
	extensions.gen_random_uuid(), current_setting('qorpera_test.base_binding')), '42501');
select pg_temp.base_error('select public.qorpera_check_native_run(null::uuid, null::jsonb)', '42501', 'Run check requires cloud authority');
reset role;
do $$
declare v_outcome text;
begin
	v_outcome := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args() || jsonb_build_object('p_environment_id', extensions.gen_random_uuid()));
	if v_outcome is distinct from 'refused' then raise exception 'another environment through the entry point: %', v_outcome; end if;
	-- The 25 s entry point is not this call's.
	v_outcome := pg_temp.nc_host('qorpera_native_host_call_long', pg_temp.nc_args());
	if v_outcome is distinct from 'refused' then raise exception 'the run check through the 25 s entry point: %', v_outcome; end if;
end $$;
select pg_temp.base_claims('anon');
select pg_temp.base_error(format('select public.qorpera_check_native_run(%L::uuid, %L::jsonb)',
	'92400000-0000-4000-8000-000000000020', current_setting('qorpera_test.base_binding')), '42501');
select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_outcome text; v_job uuid := (v_binding ->> 'jobId')::uuid;
begin
	-- A lease that lapsed: the entry point refuses it, and the direct call is refused too, by the read-set check, which
	-- comes first.
	update public.qorpera_runner_jobs set lease_expires_at = now() - interval '1 minute' where id = v_job;
	v_outcome := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args());
	if v_outcome is distinct from 'refused' then raise exception 'a lapsed lease through the entry point: %', v_outcome; end if;
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		perform public.qorpera_check_native_run('92400000-0000-4000-8000-000000000020', v_binding);
		raise exception 'a lapsed lease passed the run check' using errcode = 'P0002';
	exception when others then
		if sqlstate = 'P0002' then raise; end if;
	end;
	update public.qorpera_runner_jobs set lease_expires_at = now() + interval '5 minutes' where id = v_job;
end $$;

-- 3b. A state only describe refuses: the run's reasoning policy no longer the one its bundle pins. The read-set check
--     answers; describe refuses; the one call refuses as describe does. The change is undone before the next section.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_describe text; v_reads text; v_one text;
begin
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set reasoning_policy_sha256 = repeat('d', 64) where id = (v_binding ->> 'runId')::uuid;
		perform set_config('session_replication_role', 'origin', true);
		v_describe := pg_temp.nc_host('qorpera_native_host_call', jsonb_build_object('p_binding', v_binding),
			'qorpera_describe_native_tool_authority');
		v_reads := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args() || '{"p_paths": []}'::jsonb,
			'qorpera_assert_company_path_reads');
		v_one := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args());
		raise exception 'nc1103-undo' using errcode = 'P0003';
	exception when sqlstate 'P0003' then
		null;
	end;
	if v_reads not like 'ok:%' or v_describe like 'ok:%' or v_one is distinct from v_describe then
		raise exception 'a refusal of describe alone: describe %, read-set check %, one call %', v_describe, v_reads, v_one; end if;
	perform set_config('qorpera_test.nc_describe_only', v_describe, true);
end $$;
select current_setting('qorpera_test.nc_describe_only') as nc_describe_only \gset
\echo 1103 a changed reasoning policy: describe and the one call refused with :nc_describe_only, the read-set check answered

rollback;
