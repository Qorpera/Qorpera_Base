-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930603000 on 924's real native run of Alice's: qorpera_check_native_run makes both of the run's checks in one call
-- of the native host. Each check makes exactly the calls of the two it replaces, in their order; a refusal from either is
-- the call's; it is listed with the binding scope on the 8 s entry point; and only the platform's service caller reaches
-- it. Timed beside the two separate calls at the end (printed, not checked).
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
create function pg_temp.nc_host(p_entry text, p_args jsonb) returns text language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/' || p_entry, true);
	execute 'set local role anon';
	begin
		execute format('select public.%I($1, $2, $3, $4)', p_entry) into v_result
		using (v_binding ->> 'jobId')::uuid, current_setting('qorpera_test.nc_token'), 'qorpera_check_native_run', p_args;
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
-- This transaction's calls of the checks the two separate calls make.
create function pg_temp.nc_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_describe_native_tool_authority', 'qorpera_assert_company_path_reads',
		'qorpera_folder_tool_run', 'qorpera_folder_run_reads_current']) with ordinality as n(name, ordinal)
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

-- 2. One check through the native host makes the separate calls' checks, no fewer and no more, and answers what describe
--    answers (the authority the host keeps).
set local track_functions = 'all';
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_at bigint[]; v_separate bigint[]; v_one bigint[];
	v_outcome text; v_authority jsonb; v_described jsonb;
begin
	v_at := pg_temp.nc_calls();
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_described := public.qorpera_describe_native_tool_authority(v_binding);
	perform public.qorpera_assert_company_path_reads('92400000-0000-4000-8000-000000000020', v_binding, '{}');
	v_separate := pg_temp.nc_calls();
	v_outcome := pg_temp.nc_host('qorpera_native_host_call', pg_temp.nc_args());
	v_one := pg_temp.nc_calls();
	if v_outcome not like 'ok:%' then raise exception 'the run check through the entry point: %', v_outcome; end if;
	v_authority := substr(v_outcome, 4)::jsonb;
	if v_authority ->> 'schema' is distinct from 'qorpera.native-tool-authority/v1'
		or v_authority -> 'identity' is distinct from v_described -> 'identity' then
		raise exception 'the run check answered %', v_authority; end if;
	if array[v_one[1] - v_separate[1], v_one[2] - v_separate[2], v_one[3] - v_separate[3], v_one[4] - v_separate[4]]
		is distinct from array[v_separate[1] - v_at[1], v_separate[2] - v_at[2], v_separate[3] - v_at[3], v_separate[4] - v_at[4]]
		or v_one[1] - v_separate[1] <> 1 or v_one[2] - v_separate[2] <> 1 or v_one[4] - v_separate[4] <> 1 then
		raise exception 'one check made % where the two calls made %',
			array[v_one[1] - v_separate[1], v_one[2] - v_separate[2], v_one[3] - v_separate[3], v_one[4] - v_separate[4]],
			array[v_separate[1] - v_at[1], v_separate[2] - v_at[2], v_separate[3] - v_at[3], v_separate[4] - v_at[4]]; end if;
end $$;

-- 3. A refusal of either check is the call's. The read-set check: another environment than the run's, called as the
--    service caller (the entry point refuses that first, also tested). The authority: a lapsed lease.
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
	-- A lease that lapsed: both the entry point and describe refuse it; the direct call shows describe's refusal.
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

-- 4. Timed beside the two separate calls: printed, not checked.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_at timestamptz; v_two interval; v_one interval;
	v_outcome text;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_at := clock_timestamp();
	for i in 1..50 loop
		perform public.qorpera_describe_native_tool_authority(v_binding);
		perform public.qorpera_assert_company_path_reads('92400000-0000-4000-8000-000000000020', v_binding, '{}');
	end loop;
	v_two := clock_timestamp() - v_at;
	v_at := clock_timestamp();
	for i in 1..50 loop perform public.qorpera_check_native_run('92400000-0000-4000-8000-000000000020', v_binding); end loop;
	v_one := clock_timestamp() - v_at;
	perform set_config('qorpera_test.nc_times', format('50 checks in the database: two calls %s, one call %s', v_two, v_one), true);
end $$;
select current_setting('qorpera_test.nc_times') as nc_times \gset
\echo 1103 :nc_times

rollback;
