-- @fixture 993_memory_worker_view_reference.test.sql until "-- 1. The check's answers:"
-- W4b: exercise the native entry point, including its own-job binding checks, against a dispatched worker.

-- The company chose Shared context, the beta its place on the test list offers, so the worker's run is recorded in the
-- beta (C5, 20260930508000).
insert into public.qorpera_memory_tree_companies(profile_id) values ('63400000-0000-4000-8000-000000000010');
insert into public.qorpera_company_memory_modes(profile_id, mode) values ('63400000-0000-4000-8000-000000000010', 'tree');

do $$
declare ada jsonb := current_setting('qorpera_test.ada')::jsonb;
	f text := 'agents/ada/todos/plan-the-trip/binding-worker';
	b jsonb := pg_temp.brief('99700000-0000-4000-8000-000000000001'); u jsonb; x jsonb; v jsonb;
begin
	v := pg_temp.w4_view(current_setting('qorpera_test.w4_seq')::bigint, 0, jsonb_build_array(pg_temp.w4_block(1)));
	perform pg_temp.w4_step(ada, 7, 'w4b-dispatch-call');
	u := pg_temp.dispatch_units(ada -> 'actor', f, b);
	perform pg_temp.expect(pg_temp.wc(ada -> 'actor', 'w4b-dispatch-0001', u,
		pg_temp.dispatch_request(f, b) || jsonb_build_object('parentStep', 7, 'parentCall', 'w4b-dispatch-call', 'view', v),
		pg_temp.reviewed(ada, 'w4b-dispatch-call', u)), 2, 'saved');
	x := pg_temp.worker_run(ada, '99700000-0000-4000-8000-000000000001');
	perform pg_temp.w4_wake_sequence(x, 1);
	perform set_config('qorpera_test.w4b_worker', x::text, false);
	perform set_config('qorpera_test.w4b_view', v::text, false);
	-- A fixture token, held by this worker's job only, as the native entry point requires.
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_token_sha256 = %L where id = %L',
		encode(extensions.digest(convert_to(repeat('W', 43), 'utf8'), 'sha256'), 'hex'), x -> 'binding' ->> 'jobId'));
end $$;

create function pg_temp.w4b_host(p_name text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_native_host_call(
		(current_setting('qorpera_test.w4b_worker')::jsonb -> 'binding' ->> 'jobId')::uuid, repeat('W', 43), p_name, p_args)
$$;

-- Exactly the new wrappers are exposed, once per name, with no caller-supplied environment or actor.
do $$
declare v_role text; v_name text; x jsonb := current_setting('qorpera_test.w4b_worker')::jsonb;
	b jsonb := x -> 'binding'; ada jsonb := current_setting('qorpera_test.ada')::jsonb; got jsonb;
begin
	foreach v_name in array array['qorpera_folder_worker_parent_run', 'qorpera_memory_view_reference_check_run'] loop
		if (select count(*) from public.qorpera_native_host_calls where name = v_name and scope = 'binding') <> 1
			or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = v_name) <> 1 then
			raise exception 'Worker binding call missing or overloaded: %', v_name; end if;
	end loop;
	foreach v_name in array array['public.qorpera_folder_worker_parent_run(jsonb)',
		'public.qorpera_memory_view_reference_check_run(jsonb,jsonb)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			if has_function_privilege(v_role, v_name, 'EXECUTE') <> (v_role = 'service_role') then
				raise exception 'Worker binding call privilege: % %', v_name, v_role; end if;
		end loop;
	end loop;
	got := pg_temp.w4b_host('qorpera_folder_worker_parent_run', jsonb_build_object('p_binding', b));
	if got is distinct from pg_temp.w4_parent(x -> 'actor') or got ->> 'parentStep' is distinct from '7'
		or got ->> 'parentRunId' is distinct from ada -> 'binding' ->> 'runId'
		or got -> 'view' is distinct from current_setting('qorpera_test.w4b_view')::jsonb then
		raise exception 'Worker binding lost its actual parent: %', got; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_worker_parent_run(%L)', ada -> 'binding'), '42501');
	-- The host cannot read another run's parent or inject an environment/actor through either service API.
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_folder_worker_parent_run',
		jsonb_build_object('p_binding', ada -> 'binding')), '42501');
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_folder_worker_parent_run',
		jsonb_build_object('p_binding', b, 'p_environment_id', extensions.gen_random_uuid())), '42501');
	perform pg_temp.raises('select pg_temp.w4b_host(''qorpera_folder_worker_parent_run'',''{}'')', '42501');
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_folder_worker_parent',
		jsonb_build_object('p_environment_id', '63400000-0000-4000-8000-000000000020', 'p_actor', x -> 'actor')), '42501');
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_memory_view_reference_check',
		jsonb_build_object('p_environment_id', '63400000-0000-4000-8000-000000000020', 'p_view', got -> 'view')), '42501');
end $$;

-- The four results retain their meaning through the native host; malformed and foreign-company references refuse.
do $$
declare b jsonb := current_setting('qorpera_test.w4b_worker')::jsonb -> 'binding';
	v jsonb := current_setting('qorpera_test.w4b_view')::jsonb;
	s uuid := current_setting('qorpera_test.w4_session')::uuid; e uuid; bad jsonb;
begin
	perform pg_temp.w4_same(pg_temp.w4b_host('qorpera_memory_view_reference_check_run',
		jsonb_build_object('p_binding', b, 'p_view', v)) #>> '{}', 'ok', 'Binding reference');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set memory_generation = 1 where id = %L', s));
	perform pg_temp.w4_same(pg_temp.w4b_host('qorpera_memory_view_reference_check_run',
		jsonb_build_object('p_binding', b, 'p_view', v)) #>> '{}', 'generation_moved', 'Erased since composition');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set memory_generation = 0 where id = %L', s));
	perform pg_temp.w4_same(pg_temp.w4b_host('qorpera_memory_view_reference_check_run', jsonb_build_object('p_binding', b,
		'p_view', jsonb_set(v, '{conversations,0,blocks,0,version}', to_jsonb(extensions.gen_random_uuid())))) #>> '{}',
		'block_gone', 'Pruned reference');
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada/memory/thread', 2)));
	perform pg_temp.w4_same(pg_temp.w4b_host('qorpera_memory_view_reference_check_run',
		jsonb_build_object('p_binding', b, 'p_view', v)) #>> '{}', 'erasure_covers', 'Open folder erasure');
	delete from public.qorpera_folder_erasures where id = e;
	foreach bad in array array['{}'::jsonb, 'null'::jsonb,
		jsonb_set(v, '{conversations,0,sessionId}', to_jsonb(extensions.gen_random_uuid()))] loop
		perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_memory_view_reference_check_run',
			jsonb_build_object('p_binding', b, 'p_view', bad)), '22023');
	end loop;
	-- The run check precedes even malformed view validation, including a native lease that expired while the job lives.
	perform pg_temp.fx(format('update public.qorpera_native_provider_connection_leases
		set created_at = clock_timestamp() - interval ''1 hour'', expires_at = clock_timestamp() - interval ''1 minute'' where id = %L',
		b ->> 'leaseId'));
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_memory_view_reference_check_run',
		jsonb_build_object('p_binding', b, 'p_view', '{}'::jsonb)), '42501');
	perform pg_temp.raises(format('select pg_temp.w4b_host(%L,%L)', 'qorpera_folder_worker_parent_run',
		jsonb_build_object('p_binding', b)), '42501');
end $$;
