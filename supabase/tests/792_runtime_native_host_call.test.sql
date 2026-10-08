-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- G2-1 (20260928409985) on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): the guest's native host
-- reaches the database with the publishable key through two entry points, qorpera_native_host_call (8 s) and
-- qorpera_native_host_call_long (25 s, the lease validator and the fence), and the runner job's lease token. Test 924's
-- fixture leases the job of Alice's run (a thread post the folder materializer turned into a run) on a runner; its lease
-- token's hash is set here to a known token's. The scope examples are folder-v2 calls; the profile scope, whose only
-- listed calls are the old Company File gateway's, is shown with a call listed for this test only.
reset role;
select set_config('qorpera_test.g2_token', 'g2-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.g2_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;

-- The outcome of a call as the publishable key's role, on the entry point's RPC path: 'ok:<result>', 'refused' (the
-- entry point's own refusal) or '<sqlstate>'.
create function pg_temp.g2_call(p_job uuid, p_token text, p_name text, p_args jsonb,
	p_entry text default 'qorpera_native_host_call') returns text language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/' || p_entry, true);
	execute 'set local role anon';
	begin
		execute format('select public.%I($1, $2, $3, $4)', p_entry) into v_result using p_job, p_token, p_name, p_args;
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native host call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.g2_job() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid
$$;
create function pg_temp.g2_run() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.g2_env() returns uuid language sql as $$
	select environment_id from public.qorpera_execution_runs where id = pg_temp.g2_run()
$$;
-- 'ok' is any result, 'not refused' anything but the entry point's refusal (the called function's own answer).
create function pg_temp.g2_expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if (p_expected = 'not refused' and p_actual = 'refused')
		or (p_expected <> 'not refused' and p_actual is distinct from p_expected
			and not (p_expected = 'ok' and p_actual like 'ok:%')) then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
-- A call with this job's token, through the 8 s entry point or the 25 s one.
create function pg_temp.g2_own(p_name text, p_args jsonb) returns text language sql as $$
	select pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'), p_name, p_args)
$$;
create function pg_temp.g2_own_long(p_name text, p_args jsonb) returns text language sql as $$
	select pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'), p_name, p_args,
		'qorpera_native_host_call_long')
$$;
-- A statement_timeout setting in milliseconds (a bare number is milliseconds).
create function pg_temp.g2_ms(p_value text) returns numeric language sql as $$
	select case when p_value ~ '^[0-9]+$' then p_value::numeric else extract(epoch from p_value::interval) * 1000 end
$$;
create function pg_temp.g2_statement_timeout(p_function oid) returns text language sql as $$
	select substr(setting, length('statement_timeout=') + 1) from pg_proc as p, unnest(p.proconfig) as setting
	where p.oid = p_function and setting like 'statement_timeout=%'
$$;

-- 1. Who may call what: the two entry points are the publishable key's alone, their shared body nobody's, and the
--    call list is closed to every API role. Every listed function exists once in public, is SECURITY DEFINER, has
--    the dispatcher's shape (named plain inputs, one scalar or void result) and stays out of the publishable key's
--    reach; three also serve members (they check the member themselves), and no other is callable by a signed-in
--    member. Each listed call keeps the statement budget it has today (its own statement_timeout, or
--    authenticator's 8 s), through the entry point of that budget.
do $$
declare v_bad text;
begin
	select string_agg(entry.signature || ':' || r.rolname, ', ') into v_bad
	from (values ('public.qorpera_native_host_call(uuid,text,text,jsonb)', true),
		('public.qorpera_native_host_call_long(uuid,text,text,jsonb)', true),
		('public.qorpera_native_host_dispatch(uuid,text,text,jsonb,text)', false)) as entry(signature, anon),
		(values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname)
	where has_function_privilege(r.rolname, entry.signature, 'execute') is distinct from (entry.anon and r.rolname = 'anon');
	if v_bad is not null then raise exception 'the entry points have the wrong callers: %', v_bad; end if;
	if pg_temp.g2_statement_timeout('public.qorpera_native_host_call(uuid,text,text,jsonb)'::regprocedure) is distinct from '8s'
		or pg_temp.g2_statement_timeout('public.qorpera_native_host_call_long(uuid,text,text,jsonb)'::regprocedure)
			is distinct from '25s' then
		raise exception 'an entry point has the wrong statement budget'; end if;
	select string_agg(calls.name || ' ' || calls.budget || ' ' || coalesce(pg_temp.g2_statement_timeout(p.oid), '-'), ', ')
	into v_bad
	from public.qorpera_native_host_calls as calls
	join pg_proc as p on p.pronamespace = 'public'::regnamespace and p.proname = calls.name
	where coalesce(pg_temp.g2_ms(pg_temp.g2_statement_timeout(p.oid)), 8000)
		<> case calls.budget when 'long' then 25000 else 8000 end;
	if v_bad is not null then raise exception 'listed calls with another statement budget than today''s: %', v_bad; end if;
	select string_agg(r.rolname || ':' || pr.privilege, ', ') into v_bad
	from (values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname),
		(values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) as pr(privilege)
	where has_table_privilege(r.rolname, 'public.qorpera_native_host_calls', pr.privilege);
	if v_bad is not null then raise exception 'the call list is open to an API role: %', v_bad; end if;
	select string_agg(calls.name, ', ') into v_bad from public.qorpera_native_host_calls as calls
	where calls.name in ('qorpera_native_host_call', 'qorpera_native_host_call_long', 'qorpera_native_host_dispatch')
		or (select count(*) from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name) <> 1
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name
			and (not p.prosecdef or p.prokind <> 'f' or p.proretset or p.proargmodes is not null
				or p.pronargs > coalesce(cardinality(array_remove(p.proargnames, '')), 0)
				or not (p.prorettype = 'void'::regtype
					or (select t.typtype from pg_type as t where t.oid = p.prorettype) in ('b', 'd', 'e'))
				or has_function_privilege('anon', p.oid, 'execute')
				or (has_function_privilege('authenticated', p.oid, 'execute') and calls.name not in
					('qorpera_company_presence_scope', 'qorpera_list_company_paths', 'qorpera_read_company_path'))));
	if v_bad is not null then raise exception 'listed calls missing, overloaded, misshapen or public: %', v_bad; end if;
end $$;

-- 2. A listed call in the run's scope runs as the platform's service caller does today, its own errors come back as
--    they are, and the caller's claims and RPC path are back afterwards.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_direct jsonb; v_outcome text;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_describe_native_tool_authority(v_binding);
	v_outcome := pg_temp.g2_own('qorpera_describe_native_tool_authority', jsonb_build_object('p_binding', v_binding));
	if v_outcome <> 'ok:' || v_direct::text then
		raise exception 'a binding call differs from the service caller''s: % vs %', v_outcome, v_direct; end if;
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch',
		jsonb_build_object('p_run_id', pg_temp.g2_run(), 'p_observations', '[]'::jsonb)), '22023', 'a run call''s own refusal');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_machines_available', '{}'), 'ok', 'a call with no arguments');
	if current_setting('request.jwt.claims', true) <> '{"role":"anon"}'
		or coalesce(current_setting('request.jwt.claim.role', true), '') <> ''
		or current_setting('request.path', true) <> '/rpc/qorpera_native_host_call' then
		raise exception 'the service caller''s claims or RPC path outlived the call'; end if;
end $$;

-- 3. Everything else is the entry point's one refusal (42501 "native host call is refused"): no or a wrong token,
--    another job, an unlisted or unknown call, an argument out of the run's scope, an undeclared argument, a folder
--    actor that is not this run.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_token text := current_setting('qorpera_test.g2_token'); v_other uuid := '92400000-0000-4000-8000-0000000000ff';
	v_batch jsonb := jsonb_build_object('p_run_id', pg_temp.g2_run(), 'p_observations', '[]'::jsonb);
begin
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), null, 'qorpera_record_runtime_observation_batch', v_batch),
		'refused', 'no token');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), v_token || 'x', 'qorpera_record_runtime_observation_batch',
		v_batch), 'refused', 'a wrong token');
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), 'short', 'qorpera_record_runtime_observation_batch',
		v_batch), 'refused', 'a token too short');
	-- Too short even when it is the job's own: a token is 16 to 512 bytes.
	update public.qorpera_runner_jobs set lease_token_sha256 = encode(extensions.digest(convert_to('short-tok1', 'utf8'), 'sha256'), 'hex')
	where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), 'short-tok1', 'qorpera_company_machines_available', '{}'),
		'refused', 'the job''s own token, too short');
	update public.qorpera_runner_jobs set lease_token_sha256 = encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex')
	where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_call(v_other, v_token, 'qorpera_record_runtime_observation_batch', v_batch),
		'refused', 'another job');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_claim_coding_session', jsonb_build_object('p_owner', 'guest')),
		'refused', 'an unlisted call');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_host_call', '{}'), 'refused', 'the entry point itself');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_host_call_long', '{}'), 'refused', 'the long entry point');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_host_dispatch', '{}'), 'refused', 'the entry points'' body');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_runtime_wake_policy', jsonb_build_object('p_run_id', pg_temp.g2_run())),
		'refused', 'a call the native host never makes');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch', v_batch || '{"p_extra":1}'),
		'refused', 'an undeclared argument');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_presence_scope',
		jsonb_build_object('p_environment_id', v_other, 'p_binding', v_binding, 'p_paths', '["vision/vision.md"]'::jsonb)),
		'refused', 'another environment beside the run''s own binding');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', v_binding, 'p_run_id', v_other)), 'refused', 'another run beside the run''s own binding');
	perform pg_temp.g2_expect(pg_temp.g2_own('public.qorpera_record_runtime_observation_batch', v_batch), 'refused',
		'a schema-qualified name');
	perform pg_temp.g2_expect(pg_temp.g2_own('set_config', '{"setting_name":"role","new_value":"postgres","is_local":true}'),
		'refused', 'a function outside the list');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch',
		v_batch || jsonb_build_object('p_run_id") from pg_sleep(5) --', 1)), 'refused', 'a crafted argument name');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch', '[]'), 'refused',
		'arguments that are not an object');
	-- A job that is not an agent turn's.
	update public.qorpera_runner_jobs set job_type = 'g2_other_turn' where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_machines_available', '{}'), 'refused', 'another job type');
	update public.qorpera_runner_jobs set job_type = 'agent_turn' where id = pg_temp.g2_job();
	-- A job that asks for another capability.
	update public.qorpera_runner_jobs set required_capability = 'git_worktree' where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_machines_available', '{}'), 'refused', 'another capability');
	update public.qorpera_runner_jobs set required_capability = 'agent_turn' where id = pg_temp.g2_job();
end $$;

-- 4. Each scope, in and out of the run's reach. 'not refused' is the called function's own answer, whatever it is.
--    The profile scope's listed calls are the old Company File gateway's: a call that answers its company is listed with
--    that scope for this test only (rolled back).
create function public.qorpera_g2t_company(p_profile_id uuid) returns uuid language sql security definer
	set search_path = '' as $f$ select p_profile_id $f$;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_g2t_company', 'profile');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_other uuid := '92400000-0000-4000-8000-0000000000ff';
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_lease jsonb;
begin
	select * into v_run from public.qorpera_execution_runs where id = pg_temp.g2_run();
	-- binding: the in-scope call is section 2's; a binding call that also names the run's own environment is in scope.
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_presence_scope', jsonb_build_object('p_environment_id',
		v_run.environment_id, 'p_binding', v_binding, 'p_paths', '["vision/vision.md"]'::jsonb)), 'ok',
		'a binding call in the run''s environment');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', v_binding || jsonb_build_object('runId', v_other))), 'refused', 'a binding of another run');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', v_binding || jsonb_build_object('jobId', v_other))), 'refused', 'a binding of another job');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_describe_native_tool_authority', jsonb_build_object('p_binding', 'null'::jsonb)),
		'refused', 'no binding');
	-- lease
	v_lease := jsonb_build_object('p_lease_id', v_binding ->> 'leaseId', 'p_run_id', v_binding ->> 'runId',
		'p_job_id', v_binding ->> 'jobId', 'p_runner_id', v_binding ->> 'runnerId', 'p_assignment_id', v_binding ->> 'assignmentId',
		'p_credential_capsule_id', v_binding ->> 'credentialCapsuleId', 'p_compute_identity_id', v_binding ->> 'computeIdentityId',
		'p_provider', v_binding ->> 'provider', 'p_native_harness', v_binding ->> 'nativeHarness');
	perform pg_temp.g2_expect(pg_temp.g2_own_long('qorpera_validate_native_provider_execution_lease', v_lease), 'not refused',
		'a lease call');
	perform pg_temp.g2_expect(pg_temp.g2_own_long('qorpera_validate_native_provider_execution_lease',
		v_lease || jsonb_build_object('p_job_id', v_other)), 'refused', 'a lease call for another job');
	perform pg_temp.g2_expect(pg_temp.g2_own_long('qorpera_validate_native_provider_execution_lease', v_lease - 'p_run_id'),
		'refused', 'a lease call without its run');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_send_native_agent_message', v_lease || '{"p_idempotency_key":"g2",
		"p_text":"hi","p_phase":"final"}'), 'not refused', 'a lease call of the 8 s budget');
	-- Each call through its own budget's entry point only.
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_validate_native_provider_execution_lease', v_lease), 'refused',
		'the lease validator through the 8 s entry point');
	perform pg_temp.g2_expect(pg_temp.g2_own_long('qorpera_company_machines_available', '{}'), 'refused',
		'an 8 s call through the 25 s entry point');
	-- run: the in-scope call is section 2's.
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch',
		jsonb_build_object('p_run_id', v_other, 'p_observations', '[]'::jsonb)), 'refused', 'another run');
	-- identity
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_list_native_provider_account_refreshes',
		jsonb_build_object('p_compute_identity_id', v_run.compute_identity_id, 'p_recovery_epoch', 0)), 'not refused', 'an identity call');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_list_native_provider_account_refreshes',
		jsonb_build_object('p_compute_identity_id', v_other, 'p_recovery_epoch', 0)), 'refused', 'another compute identity');
	-- profile
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_g2t_company', jsonb_build_object('p_profile_id', v_run.profile_id)),
		'ok:' || to_jsonb(v_run.profile_id)::text, 'a company call');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_g2t_company', jsonb_build_object('p_profile_id', v_other)), 'refused',
		'another company');
	-- folder
	v_actor := jsonb_build_object('kind', 'run', 'runId', v_binding ->> 'runId', 'jobId', v_binding ->> 'jobId',
		'runnerId', v_binding ->> 'runnerId', 'assignmentId', v_binding ->> 'assignmentId');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_actor', v_actor, 'p_path', 'vision/vision.md')), 'ok',
		'a folder call');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_other, 'p_actor', v_actor, 'p_path', 'vision/vision.md')), 'refused',
		'a folder call in another environment');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_actor', '{"kind":"platform"}'::jsonb,
			'p_path', 'vision/vision.md')), 'refused', 'a platform folder actor');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_actor', v_actor || jsonb_build_object('kind', 'member',
			'userId', v_other), 'p_path', 'vision/vision.md')), 'refused', 'a member folder actor');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_actor', v_actor || jsonb_build_object('runId', v_other),
			'p_path', 'vision/vision.md')), 'refused', 'a folder actor of another run');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_actor', v_actor || jsonb_build_object('jobId', v_other),
			'p_path', 'vision/vision.md')), 'refused', 'a folder actor of another job');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_folder_read',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_path', 'vision/vision.md')), 'refused',
		'a folder call without its actor');
	-- environment
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_presence_subject',
		jsonb_build_object('p_environment_id', v_run.environment_id, 'p_client_id', v_other, 'p_paths', '[]'::jsonb)), 'not refused',
		'an environment call');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_presence_subject',
		jsonb_build_object('p_environment_id', v_other, 'p_client_id', v_other, 'p_paths', '[]'::jsonb)), 'refused',
		'another environment');
	-- A call without the argument its scope ties to the run.
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_describe_native_tool_authority', '{}'), 'refused', 'a binding call without its binding');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch', '{"p_observations":[]}'), 'refused',
		'a run call without its run');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_list_native_provider_account_refreshes', '{"p_recovery_epoch":0}'),
		'refused', 'an identity call without its identity');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_g2t_company', '{}'), 'refused', 'a company call without its company');
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_native_presence_subject',
		jsonb_build_object('p_client_id', v_other, 'p_paths', '[]'::jsonb)), 'refused', 'an environment call without its environment');
	-- none: the in-scope call is section 2's.
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_company_machines_available', '{"p_x":1}'), 'refused',
		'arguments to a call that takes none');
end $$;

-- 5. The token counts only while the job is leased and its lease is current, and a listed function itself stays out
--    of the publishable key's reach.
do $$
begin
	update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.g2_job();
	perform pg_temp.g2_expect(pg_temp.g2_own('qorpera_record_runtime_observation_batch',
		jsonb_build_object('p_run_id', pg_temp.g2_run(), 'p_observations', '[]'::jsonb)), 'refused', 'an expired lease');
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	set local role anon;
	begin
		perform public.qorpera_record_runtime_observation_batch(pg_temp.g2_run(), '[]');
		raise exception 'a listed function is callable with the publishable key';
	exception when insufficient_privilege then null;
	end;
	reset role;
end $$;

-- 6. What comes back, and how: functions of each kind are listed for this test only (rolled back). Each answer equals
--    what PostgREST returns for the same call today (its scalar body, coalesce((json_agg(result) -> 0)::text,
--    'null'), with its arguments read by json_to_record), the called function sees the platform's service caller,
--    left-out arguments take their defaults, values are data, and errors arrive unchanged. The lease section 5 ended
--    is current again.
reset role;
update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() + interval '1 hour' where id = pg_temp.g2_job();
create function public.qorpera_g2t_echo(p_run_id uuid, p_text text default null, p_list text[] default null,
	p_at timestamptz default null, p_n integer default null, p_flag boolean default null, p_doc jsonb default null,
	p_big bigint default 7) returns jsonb language sql security definer set search_path = '' as $f$
	select jsonb_build_object('text', p_text, 'list', p_list, 'at', p_at, 'n', p_n, 'flag', p_flag, 'doc', p_doc,
		'big', p_big, 'role', auth.role(), 'uid', auth.uid(), 'claim_role', current_setting('request.jwt.claim.role', true),
		'path', current_setting('request.path', true))
$f$;
create function public.qorpera_g2t_text(p_run_id uuid, p_value text) returns text language sql security definer
	set search_path = '' as $f$ select p_value $f$;
create function public.qorpera_g2t_flag(p_run_id uuid) returns boolean language sql security definer
	set search_path = '' as $f$ select true $f$;
create function public.qorpera_g2t_nothing(p_run_id uuid, p_json boolean) returns jsonb language sql security definer
	set search_path = '' as $f$ select case when p_json then 'null'::jsonb end $f$;
create function public.qorpera_g2t_void(p_run_id uuid) returns void language plpgsql security definer
	set search_path = '' as $f$ begin perform set_config('qorpera_test.g2_void_ran', auth.role(), true); end $f$;
create function public.qorpera_g2t_raise(p_run_id uuid, p_code text) returns jsonb language plpgsql security definer
	set search_path = '' as $f$
begin
	raise exception using errcode = p_code, message = 'g2 says ' || p_code, detail = 'detail ' || p_code, hint = 'hint ' || p_code;
end $f$;
create function public.qorpera_g2t_rows(p_run_id uuid) returns setof integer language sql security definer
	set search_path = '' as $f$ select 1 $f$;
create function public.qorpera_g2t_row(p_run_id uuid) returns public.qorpera_native_host_calls language sql
	security definer set search_path = '' as $f$ select 'qorpera_x', 'none', 'standard' $f$;
create function public.qorpera_g2t_out(p_run_id uuid, out p_value integer) language sql security definer
	set search_path = '' as $f$ select 1 $f$;
create function public.qorpera_g2t_many(p_run_id uuid) returns integer language sql security definer
	set search_path = '' as $f$ select 1 $f$;
create function public.qorpera_g2t_many(p_run_id uuid, p_more integer) returns integer language sql security definer
	set search_path = '' as $f$ select 2 $f$;
create procedure public.qorpera_g2t_proc(p_run_id uuid) language sql security definer set search_path = ''
	as $f$ select 1 $f$;
create function public.qorpera_g2t_bare(p_value integer default 1) returns integer language sql security definer
	set search_path = '' as $f$ select p_value $f$;
create function public.qorpera_g2t_slow(p_run_id uuid) returns jsonb language plpgsql security definer
	set search_path = '' as $f$
begin
	perform pg_sleep(1.2);
	return jsonb_build_object('statement_timeout', current_setting('statement_timeout'), 'lock_timeout', current_setting('lock_timeout'));
end $f$;
create function public.qorpera_g2t_slow_long(p_run_id uuid) returns jsonb language plpgsql security definer
	set search_path = '' as $f$
begin
	perform pg_sleep(1.2);
	return jsonb_build_object('statement_timeout', current_setting('statement_timeout'), 'lock_timeout', current_setting('lock_timeout'));
end $f$;
insert into public.qorpera_native_host_calls(name, scope, budget)
select 'qorpera_g2t_' || kind, 'run', 'standard' from unnest(array['echo', 'text', 'flag', 'nothing', 'void', 'raise', 'rows',
	'row', 'out', 'many', 'proc', 'slow']) as kind
union all select 'qorpera_g2t_bare', 'none', 'standard'
union all select 'qorpera_g2t_slow_long', 'run', 'long';

-- What PostgREST answers for a scalar call (it runs on the function's RPC path), and what it answers for the same
-- call through the entry point.
create function pg_temp.g2_postgrest(p_sql text, p_args jsonb) returns jsonb language plpgsql as $$
declare v_body text;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '/rpc/' || substring(p_sql from 'public\.(qorpera_[a-z0-9_]+)\('), true);
	execute format('select coalesce((json_agg(pgrst.v) -> 0)::text, ''null'') from (%s) as pgrst(v)', p_sql)
		into v_body using p_args::json;
	perform set_config('request.jwt.claims', '', true);
	return v_body::jsonb;
end $$;
create function pg_temp.g2_through(p_name text, p_args jsonb) returns jsonb language plpgsql as $$
declare v_outcome text := pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'), p_name, p_args);
begin
	if v_outcome not like 'ok:%' then raise exception '% was refused: %', p_name, v_outcome; end if;
	return substr(v_outcome, 4)::jsonb;
end $$;

do $$
declare v_run uuid := pg_temp.g2_run(); v_args jsonb; v_direct jsonb; v_through jsonb;
	v_state text; v_message text; v_detail text; v_hint text; v_code text;
begin
	-- Every kind of argument, and values a string-built call would trip on.
	foreach v_args in array array[
		jsonb_build_object('p_run_id', v_run, 'p_text', $t$it's "quoted"'); drop table public.qorpera_runner_jobs; --$t$,
			'p_list', jsonb_build_array('a,b', '{c}', 'd"e', null), 'p_at', '2026-10-02T01:02:03.456+02:00', 'p_n', 42,
			'p_flag', false, 'p_doc', jsonb_build_object('nested', jsonb_build_array(1, null, 'x'), 'none', null), 'p_big', 9007199254740993),
		jsonb_build_object('p_run_id', v_run, 'p_text', null, 'p_list', '[]'::jsonb, 'p_doc', 'null'::jsonb, 'p_flag', null),
		jsonb_build_object('p_run_id', v_run, 'p_doc', '"a string"'::jsonb, 'p_n', '17'),
		jsonb_build_object('p_run_id', v_run, 'p_list', null, 'p_at', null, 'p_n', null, 'p_big', null)]
	loop
		v_direct := pg_temp.g2_postgrest($q$select public.qorpera_g2t_echo(p_run_id => r.p_run_id, p_text => r.p_text,
			p_list => r.p_list, p_at => r.p_at, p_n => r.p_n, p_flag => r.p_flag, p_doc => r.p_doc)
			from json_to_record($1) as r(p_run_id uuid, p_text text, p_list text[], p_at timestamptz, p_n integer,
				p_flag boolean, p_doc jsonb)$q$, v_args - 'p_big');
		if v_args ? 'p_big' then
			v_direct := v_direct || jsonb_build_object('big', (v_args ->> 'p_big')::bigint); end if;
		v_through := pg_temp.g2_through('qorpera_g2t_echo', v_args);
		if v_through - 'claim_role' is distinct from v_direct - 'claim_role' then
			raise exception 'the echo differs from PostgREST''s: % vs %', v_through, v_direct; end if;
		if v_through ->> 'role' <> 'service_role' or v_through -> 'uid' <> 'null'::jsonb
			or v_through ->> 'claim_role' <> 'service_role' or v_through ->> 'path' <> '/rpc/qorpera_g2t_echo'
			or (not v_args ? 'p_big' and v_through -> 'big' <> '7'::jsonb) then
			raise exception 'the called function saw the wrong caller or no default: %', v_through; end if;
	end loop;
	if (select count(*) from public.qorpera_runner_jobs) = 0 then raise exception 'a value ran as SQL'; end if;

	-- Scalars of each type, a null and a JSON null, and a call with no result.
	if pg_temp.g2_through('qorpera_g2t_text', jsonb_build_object('p_run_id', v_run, 'p_value', 'x'))
			is distinct from pg_temp.g2_postgrest('select public.qorpera_g2t_text(r.p_run_id, r.p_value) from json_to_record($1) as r(p_run_id uuid, p_value text)',
				jsonb_build_object('p_run_id', v_run, 'p_value', 'x'))
		or pg_temp.g2_through('qorpera_g2t_text', jsonb_build_object('p_run_id', v_run, 'p_value', null)) <> 'null'::jsonb
		or pg_temp.g2_through('qorpera_g2t_flag', jsonb_build_object('p_run_id', v_run)) <> 'true'::jsonb
		or pg_temp.g2_through('qorpera_g2t_nothing', jsonb_build_object('p_run_id', v_run, 'p_json', false)) <> 'null'::jsonb
		or pg_temp.g2_through('qorpera_g2t_nothing', jsonb_build_object('p_run_id', v_run, 'p_json', true)) <> 'null'::jsonb
		or pg_temp.g2_postgrest('select public.qorpera_g2t_nothing(r.p_run_id, r.p_json) from json_to_record($1) as r(p_run_id uuid, p_json boolean)',
				jsonb_build_object('p_run_id', v_run, 'p_json', false)) <> 'null'::jsonb then
		raise exception 'a scalar answer differs from PostgREST''s'; end if;
	-- A call scoped to nothing takes no arguments, even ones it declares.
	if pg_temp.g2_through('qorpera_g2t_bare', '{}') <> '1'::jsonb then raise exception 'a bare call did not run'; end if;
	perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
		'qorpera_g2t_bare', '{"p_value":2}'), 'refused', 'an argument to a call scoped to nothing');
	if pg_temp.g2_through('qorpera_g2t_void', jsonb_build_object('p_run_id', v_run)) <> 'null'::jsonb
		or current_setting('qorpera_test.g2_void_ran', true) is distinct from 'service_role' then
		raise exception 'a call with no result did not run as the service caller, or answered something'; end if;

	-- Errors arrive with their own code, message, detail and hint, and the caller's claims are back after them.
	foreach v_code in array array['55P03', 'P0002', '42501', '23505', 'P0001', '22023', '55000'] loop
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		set local role anon;
		begin
			perform public.qorpera_native_host_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
				'qorpera_g2t_raise', jsonb_build_object('p_run_id', v_run, 'p_code', v_code));
			raise exception 'the error % did not arrive', v_code;
		exception when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail,
				v_hint = pg_exception_hint;
		end;
		reset role;
		if v_state <> v_code or v_message <> 'g2 says ' || v_code or v_detail <> 'detail ' || v_code
			or v_hint <> 'hint ' || v_code then
			raise exception 'the error % arrived changed: % % % %', v_code, v_state, v_message, v_detail, v_hint; end if;
		if current_setting('request.jwt.claims', true) <> '{"role":"anon"}'
			or coalesce(current_setting('request.jwt.claim.role', true), '') <> '' then
			raise exception 'the service caller''s claims outlived the error %', v_code; end if;
	end loop;

	-- Rows, a composite, OUT arguments, an overloaded name and a procedure are not the dispatcher's shape.
	foreach v_code in array array['rows', 'row', 'out', 'many', 'proc'] loop
		perform pg_temp.g2_expect(pg_temp.g2_call(pg_temp.g2_job(), current_setting('qorpera_test.g2_token'),
			'qorpera_g2t_' || v_code, jsonb_build_object('p_run_id', v_run)), 'refused', 'the shape ' || v_code);
	end loop;
end $$;

-- 7. Budgets: PostgREST (12 and later; production runs 14.5) applies a called function's statement_timeout to its
--    request (db-hoisted-tx-settings), so a call through an entry point gets that entry point's budget, not the
--    publishable key's 3 s: 8 s (authenticator's), or 25 s for the lease validator and the fence. lock_timeout is the
--    entry point's own setting for the length of the call. Here the caller's own budgets are 1 s, the entry point's
--    statement_timeout is applied as PostgREST applies it, and a call of 1.2 s completes and sees its entry point's
--    budgets. Without the setting the statement would be cancelled after 1 s (57014), which no handler here catches.
set local statement_timeout = '1s';
set local lock_timeout = '1s';
select set_config('statement_timeout', pg_temp.g2_statement_timeout('public.qorpera_native_host_call(uuid,text,text,jsonb)'::regprocedure), true);
select pg_temp.g2_expect(pg_temp.g2_own('qorpera_g2t_slow', jsonb_build_object('p_run_id', pg_temp.g2_run())),
	'ok:{"lock_timeout": "8s", "statement_timeout": "8s"}', 'an 8 s call past the caller''s own budget');
set local statement_timeout = '1s';
select set_config('statement_timeout',
	pg_temp.g2_statement_timeout('public.qorpera_native_host_call_long(uuid,text,text,jsonb)'::regprocedure), true);
select pg_temp.g2_expect(pg_temp.g2_own_long('qorpera_g2t_slow_long', jsonb_build_object('p_run_id', pg_temp.g2_run())),
	'ok:{"lock_timeout": "8s", "statement_timeout": "25s"}', 'a 25 s call past the caller''s own budget');
set local statement_timeout = 0;
set local lock_timeout = 0;

rollback;
