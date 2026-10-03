-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-3e (20260930011000): the shared execution host's own service calls the database with the publishable key and
-- one credential per execution host, through qorpera_execution_host_call (8 s) and _long (25 s). Test 300's fixture
-- gives a run whose job orchestrator 092 (provider adapter 'process') claimed and whose runner holds the lease. This
-- registers two more orchestrators (one of another adapter, one more of 'process') and binds an execution host to 092
-- and one to the other adapter's.
reset role;
select set_config('qorpera_test.run', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.runner', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runnerId', false);
select set_config('qorpera_test.identity', current_setting('qorpera_test.wake_binding')::jsonb ->> 'computeIdentityId', false);
select set_config('qorpera_test.host_credential', 'H' || repeat('h', 42), false);
select set_config('qorpera_test.other_credential', 'O' || repeat('o', 42), false);
select set_config('qorpera_test.sibling_credential', 'S' || repeat('i', 42), false);
create function pg_temp.sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;

-- Bind as the node host does: 'ok:<adapter>' or '<sqlstate>'.
create function pg_temp.bind_host(p_host text, p_adapter text, p_credential text,
	p_orchestrator uuid default '30000000-0000-4000-8000-000000000092') returns text language plpgsql as $$
declare v_result jsonb; v_hash text := case when p_credential is null then null else pg_temp.sha(p_credential) end;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	execute 'set local role service_role';
	begin
		v_result := public.qorpera_bind_execution_host_credential(p_host, p_adapter, p_orchestrator, v_hash);
	exception when others then
		execute 'reset role';
		return sqlstate;
	end;
	execute 'reset role';
	return 'ok:' || (v_result ->> 'providerAdapter');
end $$;
-- A call as the publishable key's role: 'ok:<result>', 'refused' (the entry points' own refusal) or '<sqlstate>'.
create function pg_temp.host_call(p_host text, p_credential text, p_name text, p_args jsonb,
	p_entry text default 'qorpera_execution_host_call') returns text language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/' || p_entry, true);
	execute 'set local role anon';
	begin
		execute format('select public.%I($1, $2, $3, $4)', p_entry) into v_result using p_host, p_credential, p_name, p_args;
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'execution host call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.own(p_name text, p_args jsonb, p_entry text default 'qorpera_execution_host_call') returns text
language sql as $$
	select pg_temp.host_call('qorpera-exec-test', current_setting('qorpera_test.host_credential'), p_name, p_args, p_entry)
$$;
create function pg_temp.expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if p_expected is null or p_actual is null or (p_expected = 'not refused' and p_actual = 'refused')
		or (p_expected <> 'not refused' and p_actual is distinct from p_expected
			and not (p_expected = 'ok' and p_actual like 'ok:%')) then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.identity_args() returns jsonb language sql as $$
	select jsonb_build_object('p_compute_identity_id', current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'))
$$;
create function pg_temp.reserve_args(p_allocation uuid) returns jsonb language sql as $$
	select jsonb_build_object('p_allocation_id', p_allocation, 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64),
		'p_run_id', current_setting('qorpera_test.run'), 'p_runner_id', current_setting('qorpera_test.runner'))
$$;

select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_register_runner_orchestrator('86200000-0000-4000-8000-0000000000b1', 'Another node', 'other-adapter',
	repeat('5', 64), 3600);
select public.qorpera_register_runner_orchestrator('86200000-0000-4000-8000-0000000000b2', 'Another fresh-VM path', 'process',
	repeat('6', 64), 3600);
reset role;
select pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', current_setting('qorpera_test.host_credential')),
	'ok:process', 'the execution host binds');
select pg_temp.expect(pg_temp.bind_host('qorpera-exec-other', 'other-adapter', current_setting('qorpera_test.other_credential'),
	'86200000-0000-4000-8000-0000000000b1'), 'ok:other-adapter', 'another adapter''s execution host binds');

-- 1. Who may call what: the entry points are the publishable key's alone; their body and helpers no role's; the
--    binding and revocation the node host's; both tables are closed to every API role. Every listed function exists
--    once, is SECURITY DEFINER, has the entry points' shape, keeps the budget it has today (the release its own 25 s,
--    the others authenticator's 8 s) through the entry point of that budget, stays out of the publishable key's and
--    members' reach, and has the argument names the entry points' checks were written for.
do $$
declare v_bad text;
begin
	select string_agg(entry.signature || ':' || r.rolname, ', ') into v_bad
	from (values ('public.qorpera_execution_host_call(text,text,text,jsonb)', array['anon']),
		('public.qorpera_execution_host_call_long(text,text,text,jsonb)', array['anon']),
		('public.qorpera_execution_host_dispatch(text,text,text,jsonb,text)', array[]::text[]),
		('public.qorpera_execution_host_uuid(jsonb,text)', array[]::text[]),
		('public.qorpera_execution_host_claims_run(uuid,text,uuid)', array[]::text[]),
		('public.qorpera_execution_host_run_machine(uuid,text,uuid)', array[]::text[]),
		('public.qorpera_bind_execution_host_credential(text,text,uuid,text)', array['service_role']),
		('public.qorpera_revoke_execution_host_credential(text)', array['service_role'])) as entry(signature, roles),
		(values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname)
	where has_function_privilege(r.rolname, entry.signature, 'execute') is distinct from (r.rolname = any(entry.roles));
	if v_bad is not null then raise exception 'wrong callers: %', v_bad; end if;
	select string_agg(r.rolname || ':' || t.name || ':' || pr.privilege, ', ') into v_bad
	from (values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname),
		(values ('public.qorpera_execution_host_principals'), ('public.qorpera_execution_host_calls')) as t(name),
		(values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) as pr(privilege)
	where has_table_privilege(r.rolname, t.name, pr.privilege);
	if v_bad is not null then raise exception 'a table is open to an API role: %', v_bad; end if;
	select string_agg(entry.name, ', ') into v_bad
	from (values ('qorpera_execution_host_call', array['lock_timeout=8s', 'statement_timeout=8s']),
		('qorpera_execution_host_call_long', array['lock_timeout=25s', 'statement_timeout=25s'])) as entry(name, budgets)
	where (select array_agg(setting order by setting) from pg_proc as p, unnest(p.proconfig) as setting
		where p.pronamespace = 'public'::regnamespace and p.proname = entry.name and setting like '%timeout=%')
		is distinct from entry.budgets;
	if v_bad is not null then raise exception 'entry points without their budgets: %', v_bad; end if;
	select string_agg(calls.name, ', ') into v_bad from public.qorpera_execution_host_calls as calls
	where (select count(*) from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name) <> 1
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name
			and (not p.prosecdef or p.prokind <> 'f' or p.proretset or p.proargmodes is not null
				or (select setting from unnest(p.proconfig) as setting where setting like 'statement_timeout=%')
					is distinct from case calls.budget when 'long' then 'statement_timeout=25s' end
				or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')));
	if v_bad is not null then raise exception 'listed calls missing, misshapen, public or on another budget: %', v_bad; end if;
	select string_agg(expected.name, ', ') into v_bad
	from (values
		('qorpera_provision_execution_runner', array['p_run_id', 'p_client_runner_id', 'p_provider_adapter', 'p_activation_token_sha256']),
		('qorpera_reserve_runtime_machine', array['p_allocation_id', 'p_provider_adapter', 'p_instance_sha256', 'p_run_id',
			'p_runner_id', 'p_office_id', 'p_computer_generation']),
		('qorpera_release_runtime_machine', array['p_allocation_id', 'p_provider_adapter', 'p_instance_sha256']),
		('qorpera_runtime_ended_runners', array['p_runner_ids']),
		('qorpera_identity_recovery_runtime_state', array['p_compute_identity_id']),
		('qorpera_compute_identity_login_in_vault', array['p_compute_identity_id']),
		('qorpera_bind_native_identity_credential', array['p_allocation_id', 'p_provider_adapter', 'p_instance_sha256',
			'p_holder_kind', 'p_credential_sha256'])
	) as expected(name, arguments)
	where not exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name
		and p.proargnames[1:p.pronargs] = expected.arguments)
		or not exists (select 1 from public.qorpera_execution_host_calls as calls where calls.name = expected.name);
	if v_bad is not null or (select count(*) from public.qorpera_execution_host_calls) <> 7 then
		raise exception 'the call list differs: %', coalesce(v_bad, 'its size'); end if;
end $$;

-- 2. Binding: the node host only; a bind again (a rebuild) replaces the hash and the old credential fails at once,
--    never the host's adapter; a hash is bound once; a revoked host is refused.
do $$
begin
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', current_setting('qorpera_test.host_credential')),
		'ok:process', 'binding again is idempotent');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'other-adapter', 'X' || repeat('x', 42)), '42501',
		'another adapter for a bound host');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-new', 'process', current_setting('qorpera_test.other_credential'),
		'86200000-0000-4000-8000-0000000000b2'), '23505', 'a hash bound twice');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-new', 'process', 'X' || repeat('x', 42)), '23505',
		'an orchestrator bound to another host');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', 'X' || repeat('x', 42),
		'86200000-0000-4000-8000-0000000000b2'), '42501', 'another orchestrator for a bound host');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-new', 'process', 'X' || repeat('x', 42),
		'86200000-0000-4000-8000-0000000000b1'), '42501', 'an orchestrator of another adapter');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-new', 'process', 'X' || repeat('x', 42),
		'86200000-0000-4000-8000-0000000000ff'), '42501', 'an unknown orchestrator');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-new', 'process', 'X' || repeat('x', 42), null), '22023',
		'no orchestrator');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', null), '22023', 'no hash');
	perform pg_temp.expect(pg_temp.bind_host('Qorpera Exec', 'process', 'X' || repeat('x', 42)), '22023', 'a malformed host id');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'Process!', 'X' || repeat('x', 42)), '22023', 'a malformed adapter');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', 'N' || repeat('n', 42)), 'ok:process', 'a rebuild');
	perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', pg_temp.identity_args()), 'refused',
		'the credential before the rebuild');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-test', 'N' || repeat('n', 42), 'qorpera_identity_recovery_runtime_state',
		pg_temp.identity_args()), 'ok', 'the rebuilt credential');
	perform pg_temp.expect(pg_temp.bind_host('qorpera-exec-test', 'process', current_setting('qorpera_test.host_credential')),
		'ok:process', 'back to the first credential');
	-- The bodies' own checks: a caller with a member's claims is refused even where it may execute the function.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform public.qorpera_bind_execution_host_credential('qorpera-exec-test', 'process', '30000000-0000-4000-8000-000000000092',
			pg_temp.sha('X' || repeat('x', 42)));
		raise exception 'a bind with a member''s claims was accepted';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_revoke_execution_host_credential('qorpera-exec-test');
		raise exception 'a revocation with a member''s claims was accepted';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '', true);
end $$;
-- A sibling host of the same adapter, bound to its other orchestrator (b2).
select pg_temp.expect(pg_temp.bind_host('qorpera-exec-sibling', 'process', current_setting('qorpera_test.sibling_credential'),
	'86200000-0000-4000-8000-0000000000b2'), 'ok:process', 'a sibling host of the same adapter binds');
savepoint revoked_host;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.expect(public.qorpera_revoke_execution_host_credential('qorpera-exec-test')::text, 'true', 'the node host revokes');
select set_config('request.jwt.claims', '', true);
select pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', pg_temp.identity_args()), 'refused', 'a revoked host');
rollback to savepoint revoked_host;

-- 3. Each listed call through the host's entry point answers as the service caller's (a direct call first, rolled
--    back), for the run its adapter claimed. A run machine's allocation id is its runner's client id (the fixture's
--    runner was provisioned as 30000000-...-094).
do $$
declare v_direct jsonb; v_allocation uuid := '30000000-0000-4000-8000-000000000094';
	v_identity_args jsonb := jsonb_build_object('p_compute_identity_id', current_setting('qorpera_test.identity'));
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_identity_recovery_runtime_state(current_setting('qorpera_test.identity')::uuid);
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state',
		v_identity_args || jsonb_build_object('p_run_id', current_setting('qorpera_test.run'))), 'ok:' || v_direct::text,
		'the run''s identity recovery state');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := to_jsonb(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.identity')::uuid));
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.expect(pg_temp.own('qorpera_compute_identity_login_in_vault',
		v_identity_args || jsonb_build_object('p_run_id', current_setting('qorpera_test.run'))), 'ok:' || v_direct::text,
		'the run''s identity vault custody');
	-- The fixture's job is leased, so a runner row for its run is the function's own refusal, past the entry point.
	perform pg_temp.expect(pg_temp.own('qorpera_provision_execution_runner', jsonb_build_object('p_run_id', current_setting('qorpera_test.run'),
		'p_client_runner_id', extensions.gen_random_uuid(), 'p_provider_adapter', 'process', 'p_activation_token_sha256', repeat('1', 64))),
		'not refused', 'a runner row for the claimed run');
	-- The reservation and the release, each compared with a direct call rolled back.
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		v_direct := public.qorpera_reserve_runtime_machine(v_allocation, 'process', repeat('7', 64),
			current_setting('qorpera_test.run')::uuid, current_setting('qorpera_test.runner')::uuid);
		raise exception using errcode = 'QG23E', message = 'roll the direct reservation back';
	exception when sqlstate 'QG23E' then null;
	end;
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine', pg_temp.reserve_args(v_allocation)), 'ok:' || v_direct::text,
		'the run''s machine reservation');
	if not exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_allocation and released_at is null) then
		raise exception 'the reservation left no allocation: %', v_direct; end if;
	-- Ended runners, once the runner has its run machine.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_runtime_ended_runners(array[current_setting('qorpera_test.runner')::uuid]);
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners',
		jsonb_build_object('p_runner_ids', jsonb_build_array(current_setting('qorpera_test.runner')))), 'ok:' || v_direct::text,
		'the adapter''s ended runners');
	perform pg_temp.expect(pg_temp.own('qorpera_bind_native_identity_credential', jsonb_build_object('p_allocation_id', v_allocation,
		'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64), 'p_holder_kind', 'exec_slot',
		'p_credential_sha256', pg_temp.sha('S' || repeat('s', 42)))), 'ok', 'an exec slot''s credential bind');
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		v_direct := public.qorpera_release_runtime_machine(v_allocation, 'process', repeat('7', 64));
		raise exception using errcode = 'QG23E', message = 'roll the direct release back';
	exception when sqlstate 'QG23E' then null;
	end;
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.expect(pg_temp.own('qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id', v_allocation,
		'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64)), 'qorpera_execution_host_call_long'),
		'ok:' || v_direct::text, 'the run machine''s release');
end $$;

-- 4. Everything else is the entry points' one refusal (42501 "execution host call is refused").
do $$
declare v_host text := current_setting('qorpera_test.host_credential'); v_other text := current_setting('qorpera_test.other_credential');
	v_run text := current_setting('qorpera_test.run'); v_runner text := current_setting('qorpera_test.runner');
	v_identity jsonb := jsonb_build_object('p_compute_identity_id', current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'));
	v_ended jsonb := jsonb_build_object('p_runner_ids', jsonb_build_array(current_setting('qorpera_test.runner')));
begin
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-test', null, 'qorpera_runtime_ended_runners', v_ended), 'refused', 'no credential');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-test', 'W' || repeat('w', 42), 'qorpera_runtime_ended_runners', v_ended),
		'refused', 'a wrong credential');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-other', v_host, 'qorpera_runtime_ended_runners', v_ended),
		'refused', 'another host''s name');
	perform pg_temp.expect(pg_temp.host_call(null, v_host, 'qorpera_runtime_ended_runners', v_ended), 'refused', 'no host');
	-- The other adapter's host: none of this run, runner or allocation is its.
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-other', v_other, 'qorpera_runtime_ended_runners', v_ended),
		'refused', 'another adapter''s runner');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-other', v_other, 'qorpera_identity_recovery_runtime_state', v_identity),
		'refused', 'another adapter''s claimed run''s identity');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-other', v_other, 'qorpera_provision_execution_runner',
		jsonb_build_object('p_run_id', v_run, 'p_client_runner_id', extensions.gen_random_uuid(), 'p_provider_adapter', 'other-adapter',
			'p_activation_token_sha256', repeat('1', 64))), 'refused', 'another adapter''s claimed run''s runner row');
	-- The host's own credential with another adapter, office or computer.
	perform pg_temp.expect(pg_temp.own('qorpera_provision_execution_runner', jsonb_build_object('p_run_id', v_run,
		'p_client_runner_id', extensions.gen_random_uuid(), 'p_provider_adapter', 'other-adapter', 'p_activation_token_sha256', repeat('1', 64))),
		'refused', 'a runner row for another adapter');
	perform pg_temp.expect(pg_temp.own('qorpera_provision_execution_runner', jsonb_build_object('p_run_id', v_run,
		'p_client_runner_id', extensions.gen_random_uuid(), 'p_activation_token_sha256', repeat('1', 64))),
		'refused', 'a runner row naming no adapter');
	perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine',
		pg_temp.reserve_args('86200000-0000-4000-8000-000000000072') || '{"p_office_id":"86200000-0000-4000-8000-0000000000aa"}'),
		'refused', 'an office machine');
	perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine',
		pg_temp.reserve_args('86200000-0000-4000-8000-000000000072') || '{"p_computer_generation":1}'), 'refused', 'a computer machine');
	perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine',
		pg_temp.reserve_args('86200000-0000-4000-8000-000000000072') || jsonb_build_object('p_runner_id', extensions.gen_random_uuid())),
		'refused', 'an unknown runner');
	perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine',
		pg_temp.reserve_args('86200000-0000-4000-8000-000000000072') - 'p_runner_id'), 'refused', 'a machine without a runner');
	perform pg_temp.expect(pg_temp.own('qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id', extensions.gen_random_uuid(),
		'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64)), 'qorpera_execution_host_call_long'),
		'refused', 'an unknown allocation''s release');
	-- Ended runners: well formed, of its adapter, 1 to 512.
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids', jsonb_build_array(v_runner,
		extensions.gen_random_uuid()))), 'refused', 'an unknown runner among the ended');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids', jsonb_build_array(upper(v_runner)))),
		'refused', 'an upper-case runner id');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids', jsonb_build_array('not-a-uuid'))),
		'refused', 'a malformed runner id');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids', jsonb_build_array(1))),
		'refused', 'a number for a runner id');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', '{"p_runner_ids":[]}'), 'refused', 'no runners');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids',
		(select jsonb_agg(v_runner) from generate_series(1, 513)))), 'refused', 'more than 512 runners');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', jsonb_build_object('p_runner_ids', v_runner)),
		'refused', 'runners not in an array');
	-- An identity only with the claimed run it is read for.
	perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', v_identity - 'p_run_id'), 'refused', 'an identity without a run');
	perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state',
		v_identity || jsonb_build_object('p_compute_identity_id', extensions.gen_random_uuid())), 'refused', 'another identity than the run''s');
	perform pg_temp.expect(pg_temp.own('qorpera_compute_identity_login_in_vault',
		v_identity || jsonb_build_object('p_run_id', extensions.gen_random_uuid())), 'refused', 'an identity with another run');
	-- A slot credential only as an exec slot, for its adapter's run machine.
	perform pg_temp.expect(pg_temp.own('qorpera_bind_native_identity_credential', jsonb_build_object('p_allocation_id',
		'30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64),
		'p_holder_kind', 'login_guest', 'p_credential_sha256', pg_temp.sha('T' || repeat('t', 42)))), 'refused', 'a login guest''s bind');
	perform pg_temp.expect(pg_temp.own('qorpera_bind_native_identity_credential', jsonb_build_object('p_allocation_id',
		extensions.gen_random_uuid(), 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64),
		'p_holder_kind', 'exec_slot', 'p_credential_sha256', pg_temp.sha('T' || repeat('t', 42)))), 'refused', 'an unknown allocation''s bind');
	-- Names, arguments and budgets.
	perform pg_temp.expect(pg_temp.own('qorpera_native_host_call', '{}'), 'refused', 'an unlisted call');
	perform pg_temp.expect(pg_temp.own('public.qorpera_runtime_ended_runners', v_ended), 'refused', 'a schema-qualified name');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', v_ended || '{"p_extra":1}'), 'refused', 'an undeclared argument');
	perform pg_temp.expect(pg_temp.own('qorpera_runtime_ended_runners', v_ended, 'qorpera_execution_host_call_long'), 'refused',
		'a standard call through the long entry point');
	perform pg_temp.expect(pg_temp.own('qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id',
		'30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64))),
		'refused', 'the release through the standard entry point');
end $$;
-- The sibling host (the same adapter, another orchestrator): none of this run, its runner or its machine is its.
do $$
declare v_sibling text := current_setting('qorpera_test.sibling_credential');
begin
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-sibling', v_sibling, 'qorpera_runtime_ended_runners',
		jsonb_build_object('p_runner_ids', jsonb_build_array(current_setting('qorpera_test.runner')))), 'refused',
		'a sibling host''s ended runners');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-sibling', v_sibling, 'qorpera_release_runtime_machine',
		jsonb_build_object('p_allocation_id', '30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process',
			'p_instance_sha256', repeat('7', 64)), 'qorpera_execution_host_call_long'), 'refused', 'a sibling host''s release');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-sibling', v_sibling, 'qorpera_identity_recovery_runtime_state',
		pg_temp.identity_args()), 'refused', 'a sibling host''s identity');
	perform pg_temp.expect(pg_temp.host_call('qorpera-exec-sibling', v_sibling, 'qorpera_bind_native_identity_credential',
		jsonb_build_object('p_allocation_id', '30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process',
			'p_instance_sha256', repeat('7', 64), 'p_holder_kind', 'exec_slot', 'p_credential_sha256', pg_temp.sha('U' || repeat('u', 42)))),
		'refused', 'a sibling host''s bind');
end $$;
-- A claim still marked assigned while the job is leased is not current: only the accepted claim of the leasing runner is.
savepoint stale_assigned;
set local session_replication_role = replica;
update public.qorpera_runner_job_claims set status = 'assigned' where run_id = current_setting('qorpera_test.run')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', pg_temp.identity_args()), 'refused',
	'an assigned claim of a leased job');
rollback to savepoint stale_assigned;
-- A run machine without a runner (a sign-in's machine of the same adapter) is never the host's to release or bind.
savepoint login_machine;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('86200000-0000-4000-8000-000000000075', '30000000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.wake_login')::jsonb ->> 'login_id')::uuid, current_setting('qorpera_test.identity')::uuid,
	'process', repeat('5', 64));
select pg_temp.expect(pg_temp.own('qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id',
	'86200000-0000-4000-8000-000000000075', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('5', 64)),
	'qorpera_execution_host_call_long'), 'refused', 'a sign-in machine''s release');
select pg_temp.expect(pg_temp.own('qorpera_bind_native_identity_credential', jsonb_build_object('p_allocation_id',
	'86200000-0000-4000-8000-000000000075', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('5', 64),
	'p_holder_kind', 'exec_slot', 'p_credential_sha256', pg_temp.sha('T' || repeat('t', 42)))), 'refused', 'a sign-in machine''s bind');
rollback to savepoint login_machine;
-- A run whose job ended keeps its accepted claim, but is no longer the host's; its machine's release still is.
savepoint ended_run;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid,
	'failed', 'Runner lease expired before durable completion', false);
reset role;
select pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', jsonb_build_object('p_compute_identity_id',
	current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'))), 'refused', 'an ended run''s identity');
select pg_temp.expect(pg_temp.own('qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id',
	'30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64)),
	'qorpera_execution_host_call_long'), 'ok', 'an ended run machine''s release');
select pg_temp.expect(pg_temp.own('qorpera_bind_native_identity_credential', jsonb_build_object('p_allocation_id',
	'30000000-0000-4000-8000-000000000094', 'p_provider_adapter', 'process', 'p_instance_sha256', repeat('7', 64),
	'p_holder_kind', 'exec_slot', 'p_credential_sha256', pg_temp.sha('V' || repeat('v', 42)))), 'refused', 'an ended run''s bind');
rollback to savepoint ended_run;
-- A run retried and claimed again by the host's own orchestrator is the host's while its claim is current (claimed and
-- the job queued): its identity, a runner row for the new attempt and that runner's run machine.
do $$
declare v_runner jsonb; v_client uuid := '86200000-0000-4000-8000-000000000077';
begin
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		perform public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid,
			'failed', 'Runner lease expired before durable completion', true);
		if public.qorpera_claim_runner_job_for_orchestrator('30000000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120)
			#>> '{work,run_id}' is distinct from current_setting('qorpera_test.run') then
			raise exception 'the retried run was not claimed by the host''s orchestrator'; end if;
		perform set_config('request.jwt.claims', '', true);
		perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', pg_temp.identity_args()), 'ok',
			'the identity of a run the host claimed again');
		v_runner := substr(pg_temp.own('qorpera_provision_execution_runner', jsonb_build_object('p_run_id',
			current_setting('qorpera_test.run'), 'p_client_runner_id', v_client, 'p_provider_adapter', 'process',
			'p_activation_token_sha256', repeat('2', 64))), 4)::jsonb;
		if v_runner ->> 'runner_id' is null then raise exception 'no runner row for the new attempt: %', v_runner; end if;
		perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine', jsonb_build_object('p_allocation_id', v_client,
			'p_provider_adapter', 'process', 'p_instance_sha256', repeat('8', 64), 'p_run_id', current_setting('qorpera_test.run'),
			'p_runner_id', v_runner ->> 'runner_id')), 'ok', 'the run machine of a run the host claimed again');
		if not exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_client and released_at is null) then
			raise exception 'the new attempt''s reservation left no allocation'; end if;
		raise exception using errcode = 'QG23E', message = 'roll the retry back';
	exception when sqlstate 'QG23E' then null;
	end;
end $$;
-- A run retried and claimed by another orchestrator, of another adapter or of the same one, is no longer the host's.
do $$
declare v_orchestrator uuid; v_state text;
begin
	foreach v_orchestrator in array array['86200000-0000-4000-8000-0000000000b1', '86200000-0000-4000-8000-0000000000b2']::uuid[] loop
		begin
			perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
			perform public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid,
				'failed', 'Runner lease expired before durable completion', true);
			if public.qorpera_claim_runner_job_for_orchestrator(v_orchestrator, extensions.gen_random_uuid(), 120) #>> '{work,run_id}'
				is distinct from current_setting('qorpera_test.run') then
				raise exception 'the retried run was not claimed by %', v_orchestrator; end if;
			perform set_config('request.jwt.claims', '', true);
			perform pg_temp.expect(pg_temp.own('qorpera_provision_execution_runner', jsonb_build_object('p_run_id',
				current_setting('qorpera_test.run'), 'p_client_runner_id', extensions.gen_random_uuid(), 'p_provider_adapter', 'process',
				'p_activation_token_sha256', repeat('1', 64))), 'refused', 'a runner row for a run another orchestrator claimed');
			perform pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine',
				pg_temp.reserve_args('86200000-0000-4000-8000-000000000076')), 'refused', 'a machine for a run another orchestrator claimed');
			perform pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', jsonb_build_object('p_compute_identity_id',
				current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'))), 'refused',
				'the identity of a run another orchestrator claimed');
			raise exception using errcode = 'QG23E', message = 'roll the retry back';
		exception when sqlstate 'QG23E' then null;
		end;
	end loop;
end $$;
-- A run whose claim was released is no longer the adapter's.
savepoint released_claim;
set local session_replication_role = replica;
update public.qorpera_runner_job_claims set status = 'released', released_at = clock_timestamp()
where run_id = current_setting('qorpera_test.run')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', jsonb_build_object('p_compute_identity_id',
	current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'))), 'refused', 'a released claim''s run');
select pg_temp.expect(pg_temp.own('qorpera_reserve_runtime_machine', pg_temp.reserve_args('86200000-0000-4000-8000-000000000073')),
	'refused', 'a released claim''s machine');
rollback to savepoint released_claim;
savepoint revoked_orchestrator;
set local session_replication_role = replica;
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '30000000-0000-4000-8000-000000000092';
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.own('qorpera_identity_recovery_runtime_state', jsonb_build_object('p_compute_identity_id',
	current_setting('qorpera_test.identity'), 'p_run_id', current_setting('qorpera_test.run'))), 'refused', 'a revoked orchestrator''s run');
rollback to savepoint revoked_orchestrator;

rollback;
