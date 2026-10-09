-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- G2-6a (20260930152000): the object gateway and the secret brokers ask qorpera_native_binding_proven whether a native
-- host's request holds its run's job lease token (the holder header `job.<job id>.<lease token>`) before they serve the
-- run binding it carries. 924's fixture leases Alice's run's job; this test gives the job a known lease token.
reset role;
select set_config('qorpera_test.job', current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', false);
select set_config('qorpera_test.run', current_setting('qorpera_test.base_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.token', 'P' || repeat('p', 42), false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.token'), 'utf8'), 'sha256'), 'hex')
where id = current_setting('qorpera_test.job')::uuid;
create function pg_temp.holder(p_token text default null) returns text language sql as $$
	select 'job.' || current_setting('qorpera_test.job') || '.' || coalesce(p_token, current_setting('qorpera_test.token'))
$$;
create function pg_temp.binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
-- A proof as the role: 'proven', 'refused' (its own 42501) or the sqlstate of anything else.
create function pg_temp.prove(p_role text, p_binding jsonb, p_holder text) returns text language plpgsql as $$
declare v_result boolean;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
	execute format('set local role %I', p_role);
	begin
		v_result := public.qorpera_native_binding_proven(p_binding, p_holder);
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native binding proof is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return case when v_result then 'proven' else 'false' end;
end $$;
create function pg_temp.expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

-- 1. Only the servers may ask: the object gateway (service_role) and the brokers (qorpera_secret_broker). The function
-- is stable, so it cannot take a row lock, and it names no lock.
do $$
declare v_role text; v_function text := 'public.qorpera_native_binding_proven(jsonb,text)';
begin
	foreach v_role in array array['anon', 'authenticated'] loop
		if has_function_privilege(v_role, v_function, 'execute') then raise exception '1: % may ask for a proof', v_role; end if;
	end loop;
	foreach v_role in array array['service_role', 'qorpera_secret_broker'] loop
		if not has_function_privilege(v_role, v_function, 'execute') then raise exception '1: % may not ask for a proof', v_role; end if;
	end loop;
	if (select provolatile from pg_proc where oid = v_function::regprocedure) <> 's'
		or (select prosrc from pg_proc where oid = v_function::regprocedure) ~* '\m(for update|for share|for no key|for key share|lock)\M' then
		raise exception '1: the proof must be stable and lock-free'; end if;
end $$;

-- 2. The run's own lease token proves its own binding, for both servers' roles; the binding's ids may come in either case.
select pg_temp.expect(pg_temp.prove('service_role', pg_temp.binding(), pg_temp.holder()), 'proven', '2: the object gateway''s proof');
select pg_temp.expect(pg_temp.prove('qorpera_secret_broker', pg_temp.binding(), pg_temp.holder()), 'proven', '2: a broker''s proof');
select pg_temp.expect(pg_temp.prove('service_role', jsonb_build_object('jobId', upper(current_setting('qorpera_test.job')),
	'runId', upper(current_setting('qorpera_test.run'))), pg_temp.holder()), 'proven', '2: upper-case binding ids');

-- 3. Anything else is the one refusal: another token, a holder or binding of another job or run, a malformed holder, a
-- binding that is not an object, and a job that is no longer leased or whose lease has expired.
do $$
declare v_holder text; v_binding jsonb;
begin
	foreach v_holder in array array[
		pg_temp.holder('W' || repeat('w', 42)),
		'job.90986000-0000-4000-8000-000000000001.' || current_setting('qorpera_test.token'),
		'job.' || upper(current_setting('qorpera_test.job')) || '.' || current_setting('qorpera_test.token'),
		'identity.' || current_setting('qorpera_test.token'),
		pg_temp.holder() || 'x', current_setting('qorpera_test.token'), ''] loop
		perform pg_temp.expect(pg_temp.prove('service_role', pg_temp.binding(), v_holder), 'refused', format('3: holder %s', left(v_holder, 14)));
	end loop;
	perform pg_temp.expect(pg_temp.prove('service_role', pg_temp.binding(), null), 'refused', '3: no holder');
	foreach v_binding in array array[
		pg_temp.binding() || jsonb_build_object('jobId', '90986000-0000-4000-8000-000000000001'),
		pg_temp.binding() || jsonb_build_object('runId', '90986000-0000-4000-8000-000000000002'),
		pg_temp.binding() - 'jobId', pg_temp.binding() - 'runId', '[]'::jsonb, '"x"'::jsonb] loop
		perform pg_temp.expect(pg_temp.prove('service_role', v_binding, pg_temp.holder()), 'refused', format('3: binding %s', left(v_binding::text, 40)));
	end loop;
	perform pg_temp.expect(pg_temp.prove('service_role', null, pg_temp.holder()), 'refused', '3: no binding');
end $$;
savepoint lease_over;
update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
where id = current_setting('qorpera_test.job')::uuid;
select pg_temp.expect(pg_temp.prove('service_role', pg_temp.binding(), pg_temp.holder()), 'refused', '3: an expired lease');
rollback to savepoint lease_over;
savepoint job_ended;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
	terminal_lease_token_sha256 = lease_token_sha256, lease_token_sha256 = null, lease_expires_at = null
where id = current_setting('qorpera_test.job')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.prove('service_role', pg_temp.binding(), pg_temp.holder()), 'refused', '3: a completed job');
rollback to savepoint job_ended;

rollback;
