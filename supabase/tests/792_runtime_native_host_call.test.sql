-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-1 (20260929999500): the guest's native host reaches the database with the publishable key through one entry
-- point, qorpera_native_host_call, and the runner job's lease token. Test 300's fixture leases a run's job on a
-- runner; its lease token's hash is set here to a known token's.
reset role;
select set_config('qorpera_test.g2_token', 'g2-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.g2_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid;

-- The outcome of a call as the publishable key's role: 'ok:<result>' or '<sqlstate>'.
create function pg_temp.g2_call(p_job uuid, p_token text, p_name text, p_args jsonb) returns text language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	execute 'set local role anon';
	begin
		v_result := public.qorpera_native_host_call(p_job, p_token, p_name, p_args);
	exception when others then
		execute 'reset role';
		return sqlstate;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.g2_job() returns uuid language sql as $$
	select (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid
$$;
create function pg_temp.g2_run() returns uuid language sql as $$
	select (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.g2_expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected and not (p_expected = 'ok' and p_actual like 'ok:%') then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

-- 1. Who may call what: the entry point is the publishable key's alone; every listed function exists once and
--    stays out of the publishable key's reach (three serve members too: they check the member themselves).
do $$
declare v_missing text;
begin
	if not has_function_privilege('anon', 'public.qorpera_native_host_call(uuid,text,text,jsonb)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_native_host_call(uuid,text,text,jsonb)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_native_host_call(uuid,text,text,jsonb)', 'execute')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_native_host_call(uuid,text,text,jsonb)', 'execute') then
		raise exception 'the entry point has the wrong callers'; end if;
	if has_table_privilege('anon', 'public.qorpera_native_host_calls', 'select')
		or has_table_privilege('service_role', 'public.qorpera_native_host_calls', 'select') then
		raise exception 'the call list is readable by an API role'; end if;
	select string_agg(calls.name, ', ') into v_missing from public.qorpera_native_host_calls as calls
	where (select count(*) from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
			where n.nspname = 'public' and p.proname = calls.name) <> 1
		or exists (select 1 from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
			where n.nspname = 'public' and p.proname = calls.name
				and (has_function_privilege('anon', p.oid, 'execute') or not p.prosecdef));
	if v_missing is not null then raise exception 'listed calls missing, overloaded or public: %', v_missing; end if;
end $$;

-- 2. A listed call in the run's scope runs as the platform's service caller does today, and the caller's claims
--    and the job mark are back afterwards.
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_direct jsonb; v_outcome text;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_describe_native_tool_authority(v_binding);
	v_outcome := pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
		'qorpera_describe_native_tool_authority', jsonb_build_object('p_binding', v_binding));
	if v_outcome <> 'ok:' || v_direct::text then
		raise exception 'a binding call differs from the service caller''s: % vs %', v_outcome, v_direct; end if;
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
		'qorpera_runtime_wake_policy', jsonb_build_object('p_run_id', pg_temp.g2_run())), 'ok', 'a run call');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
		'qorpera_company_machines_available', '{}'), 'ok', 'a call with no arguments');
	if current_setting('request.jwt.claims', true) <> '{"role":"anon"}' or current_setting('qorpera.native_host_job', true) <> '' then
		raise exception 'the caller''s claims or the job mark outlived the call'; end if;
end $$;

-- 3. Everything else is one refusal (42501): no or a wrong token, another job, an unlisted or unknown call, an
--    argument out of the run's scope, an undeclared argument, a folder actor that is not this run.
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_token text := current_setting('qorpera_test.g2_token'); v_other uuid := '30000000-0000-4000-8000-0000000000ff';
begin
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), null, 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', pg_temp.g2_run())), '42501', 'no token');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token || 'x', 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', pg_temp.g2_run())), '42501', 'a wrong token');
	perform pg_temp.g2_expect(pg_temp.g2_call(v_other, v_token, 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', pg_temp.g2_run())), '42501', 'another job');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_claim_coding_session',
		jsonb_build_object('p_owner', 'guest')), '42501', 'an unlisted call');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_native_host_call',
		'{}'), '42501', 'the entry point itself');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', v_other)), '42501', 'another run');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', v_binding || jsonb_build_object('runId', v_other))), '42501', 'a binding of another run');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', v_binding || jsonb_build_object('jobId', v_other))), '42501', 'a binding of another job');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', pg_temp.g2_run(), 'p_extra', 1)), '42501', 'an undeclared argument');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_company_machines_available',
		'{"p_x":1}'), '42501', 'arguments to a call that takes none');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_folder_read',
		jsonb_build_object('p_environment_id', (select environment_id from public.qorpera_execution_runs where id = pg_temp.g2_run()),
			'p_actor', '{"kind":"platform"}'::jsonb, 'p_path', 'notes.md')), '42501', 'a platform folder actor');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_verify_company_path_tree',
		jsonb_build_object('p_profile_id', v_other, 'p_manifest_text', '')), '42501', 'another company');
end $$;

-- 4. The token counts only while the job is leased and its lease is current.
do $$
declare v_token text := current_setting('qorpera_test.g2_token');
begin
	update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token, 'qorpera_runtime_wake_policy',
		jsonb_build_object('p_run_id', pg_temp.g2_run())), '42501', 'an expired lease');
end $$;

-- 5. A listed function itself stays out of the publishable key's reach.
do $$
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	set local role anon;
	begin
		perform public.qorpera_runtime_wake_policy(pg_temp.g2_run());
		raise exception 'a listed function is callable with the publishable key';
	exception when insufficient_privilege then null;
	end;
	reset role;
end $$;

rollback;
