-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- G2-3a (20260930005000) on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): the guest's native host
-- makes its between-job calls with the publishable key through qorpera_native_identity_call and a credential the node
-- host bound to the holder's machine allocation. Test 924's fixture gives the owner's identity, the runner of Alice's
-- run (a thread post the folder materializer turned into a run) and a completed sign-in; this test adds a run
-- allocation (a job guest), a pending sign-in and an account refresh request with their login guest allocations (rows
-- only, as the node host's reservations leave them), and binds a credential to each.
reset role;
select set_config('qorpera_test.identity', current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId', false);
select set_config('qorpera_test.runner', current_setting('qorpera_test.base_binding')::jsonb ->> 'runnerId', false);
select set_config('qorpera_test.run', current_setting('qorpera_test.base_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.profile', '92400000-0000-4000-8000-000000000010', false);
select set_config('qorpera_test.job_credential', 'J' || repeat('j', 42), false);
select set_config('qorpera_test.login_credential', 'L' || repeat('l', 42), false);
select set_config('qorpera_test.refresh_credential', 'R' || repeat('r', 42), false);
create function pg_temp.ic_sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;

-- A pending sign-in of the identity, by its member.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '86000000-0000-4000-8000-000000000051', '86000000-0000-4000-8000-000000000052',
	current_setting('qorpera_test.identity')::uuid, 'openai', 'codex-cli', pg_temp.ic_sha('login-capability'), 900)::text, false);
reset role;
select set_config('qorpera_test.login_id', current_setting('qorpera_test.login')::jsonb ->> 'login_id', false);
-- An account refresh request of the identity (as qorpera_begin_native_account_refresh leaves it).
insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
	requested_by_user_id, capability_sha256, compute_recovery_epoch)
select '86000000-0000-4000-8000-000000000061', current_setting('qorpera_test.profile')::uuid, extensions.gen_random_uuid(),
	identity.id, '92400000-0000-4000-8000-000000000001', pg_temp.ic_sha('refresh-capability'), identity.recovery_epoch
from public.qorpera_member_compute_identities as identity where identity.id = current_setting('qorpera_test.identity')::uuid;
-- Another identity of the same company (a company identity), active at the same recovery epoch.
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
values ('86000000-0000-4000-8000-0000000000e1', current_setting('qorpera_test.profile')::uuid, 'company',
	'86000000-0000-4000-8000-0000000000e2', 'Other identity');
-- The holders' allocations, as their reservations leave them: the run's (a job guest) and the sign-in's (a login
-- guest). The refresh's comes once the sign-in's is released (one login or refresh machine per identity).
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
values ('86000000-0000-4000-8000-000000000071', current_setting('qorpera_test.profile')::uuid,
	current_setting('qorpera_test.run')::uuid, current_setting('qorpera_test.runner')::uuid, 'lxd', repeat('7', 64));
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('86000000-0000-4000-8000-000000000072', current_setting('qorpera_test.profile')::uuid,
	current_setting('qorpera_test.login_id')::uuid, current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('8', 64));

-- Bind as the node host does.
create function pg_temp.ic_bind(p_allocation uuid, p_adapter text, p_instance text, p_kind text, p_credential text)
returns text language plpgsql as $$
declare v_result jsonb; v_hash text := case when p_credential is null then null else pg_temp.ic_sha(p_credential) end;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	execute 'set local role service_role';
	begin
		v_result := public.qorpera_bind_native_identity_credential(p_allocation, p_adapter, p_instance, p_kind, v_hash);
	exception when others then
		execute 'reset role';
		return sqlstate;
	end;
	execute 'reset role';
	return 'ok:' || (v_result ->> 'holderKind');
end $$;
-- A call as the publishable key's role: 'ok:<result>', 'refused' (the entry point's own refusal) or '<sqlstate>'.
create function pg_temp.ic_call(p_credential text, p_name text, p_args jsonb, p_identity uuid default null) returns text
language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_identity_call', true);
	execute 'set local role anon';
	begin
		v_result := public.qorpera_native_identity_call(coalesce(p_identity, current_setting('qorpera_test.identity')::uuid),
			p_credential, p_name, p_args);
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native identity call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok:' || coalesce(v_result::text, 'null');
end $$;
create function pg_temp.ic_expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if p_expected is null or p_actual is null or (p_expected = 'not refused' and p_actual = 'refused')
		or (p_expected <> 'not refused' and p_actual is distinct from p_expected
			and not (p_expected = 'ok' and p_actual like 'ok:%')) then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.ic_identity_args() returns jsonb language sql as $$
	select jsonb_build_object('p_compute_identity_id', current_setting('qorpera_test.identity'))
$$;
create function pg_temp.ic_epoch() returns bigint language sql as $$
	select recovery_epoch from public.qorpera_member_compute_identities where id = current_setting('qorpera_test.identity')::uuid
$$;

-- 1. Who may call what: the entry point is the publishable key's alone; its body, the shared call and the binding are
--    no API role's but the binding's node host; both tables are closed to every API role. Every listed function exists
--    once, is SECURITY DEFINER, has the entry point's shape, has no statement budget of its own and stays out of the
--    publishable key's and members' reach, with the argument names the entry point's checks were written for (a new
--    id argument needs a new check). The entry point carries authenticator's 8 s.
do $$
declare v_bad text;
begin
	select string_agg(entry.signature || ':' || r.rolname, ', ') into v_bad
	from (values ('public.qorpera_native_identity_call(uuid,text,text,jsonb)', array['anon']),
		('public.qorpera_native_identity_dispatch(uuid,text,text,jsonb)', array[]::text[]),
		('public.qorpera_native_host_invoke(text,jsonb,text)', array[]::text[]),
		('public.qorpera_bind_native_identity_credential(uuid,text,text,text,text)', array['service_role'])) as entry(signature, roles),
		(values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname)
	where has_function_privilege(r.rolname, entry.signature, 'execute') is distinct from (r.rolname = any(entry.roles));
	if v_bad is not null then raise exception 'wrong callers: %', v_bad; end if;
	select string_agg(r.rolname || ':' || t.name || ':' || pr.privilege, ', ') into v_bad
	from (values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as r(rolname),
		(values ('public.qorpera_native_identity_credentials'), ('public.qorpera_native_identity_calls')) as t(name),
		(values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) as pr(privilege)
	where has_table_privilege(r.rolname, t.name, pr.privilege);
	if v_bad is not null then raise exception 'a table is open to an API role: %', v_bad; end if;
	if (select array_agg(setting order by setting) from pg_proc as p, unnest(p.proconfig) as setting
		where p.oid = 'public.qorpera_native_identity_call(uuid,text,text,jsonb)'::regprocedure and setting like '%timeout=%')
		is distinct from array['lock_timeout=8s', 'statement_timeout=8s'] then
		raise exception 'the entry point lacks its budgets'; end if;
	select string_agg(calls.name, ', ') into v_bad from public.qorpera_native_identity_calls as calls
	where (select count(*) from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name) <> 1
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = calls.name
			and (not p.prosecdef or p.prokind <> 'f' or p.proretset or p.proargmodes is not null
				or exists (select 1 from unnest(p.proconfig) as setting where setting like 'statement_timeout=%')
				or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')));
	if v_bad is not null then raise exception 'listed calls missing, misshapen or public: %', v_bad; end if;
	if (select count(*) from public.qorpera_native_identity_calls) <> 8
		or exists (select 1 from public.qorpera_native_identity_calls
			where 'login_guest' = any(holder_kinds) and name in ('qorpera_identity_recovery_runtime_state',
				'qorpera_compute_identity_login_in_vault')) then
		raise exception 'the call list differs'; end if;
	select string_agg(expected.name, ', ') into v_bad
	from (values
		('qorpera_identity_recovery_runtime_state', array['p_compute_identity_id']),
		('qorpera_compute_identity_login_in_vault', array['p_compute_identity_id']),
		('qorpera_list_native_provider_account_refreshes', array['p_compute_identity_id', 'p_recovery_epoch']),
		('qorpera_record_native_provider_account_metadata', array['p_compute_identity_id', 'p_recovery_epoch', 'p_connection_id',
			'p_connection_version', 'p_credential_capsule_id', 'p_provider_account_email', 'p_provider_account_usage',
			'p_provider_account_identity']),
		('qorpera_describe_native_provider_login', array['p_login_id', 'p_capability_sha256']),
		('qorpera_complete_native_provider_login', array['p_login_id', 'p_capability_sha256', 'p_capsule_id',
			'p_encrypted_capsule_reference', 'p_attestation_policy_sha256', 'p_provider_account_reference', 'p_billing_source',
			'p_consent_version', 'p_quota_policy', 'p_provider_account_email']),
		('qorpera_describe_native_account_refresh_route', array['p_request_id', 'p_capability_sha256']),
		('qorpera_complete_native_account_refresh', array['p_request_id', 'p_capability_sha256', 'p_recovery_epoch'])
	) as expected(name, arguments)
	where not exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name
		and p.proargnames[1:p.pronargs] = expected.arguments)
		or not exists (select 1 from public.qorpera_native_identity_calls as calls where calls.name = expected.name);
	if v_bad is not null then raise exception 'listed calls with other arguments than the checks expect: %', v_bad; end if;
end $$;

-- 2. Binding: the node host only, for an unreleased run, sign-in or refresh allocation of its kind; a bind again
--    replaces the hash (the old credential fails at once), never the kind or identity; a hash is bound once.
do $$
begin
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
		current_setting('qorpera_test.job_credential')), 'ok:job_guest', 'a job guest binds');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
		current_setting('qorpera_test.job_credential')), 'ok:job_guest', 'binding again is idempotent');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000072', 'lxd-login', repeat('8', 64), 'login_guest',
		current_setting('qorpera_test.login_credential')), 'ok:login_guest', 'a login guest binds');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'login_guest',
		'X' || repeat('x', 42)), '42501', 'a run allocation as a login guest');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000072', 'lxd-login', repeat('8', 64), 'job_guest',
		'X' || repeat('x', 42)), '42501', 'a sign-in allocation as a job guest');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('6', 64), 'job_guest',
		'X' || repeat('x', 42)), '42501', 'another instance');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd-other', repeat('7', 64), 'job_guest',
		'X' || repeat('x', 42)), '42501', 'another adapter');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-0000000000ff', 'lxd', repeat('7', 64), 'job_guest',
		'X' || repeat('x', 42)), '42501', 'an unknown allocation');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'exec_slot',
		'X' || repeat('x', 42)), '42501', 'another kind for a bound allocation');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000072', 'lxd-login', repeat('8', 64), 'login_guest',
		current_setting('qorpera_test.job_credential')), '23505', 'a hash bound twice');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest', null),
		'22023', 'no hash');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'office', 'X' || repeat('x', 42)),
		'22023', 'an unknown kind');
	-- Rotation: a new credential for the same holder; the old one fails at once.
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
		'N' || repeat('n', 42)), 'ok:job_guest', 'a new credential for the job guest');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
		pg_temp.ic_identity_args()), 'refused', 'the replaced credential');
	perform pg_temp.ic_expect(pg_temp.ic_call('N' || repeat('n', 42), 'qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()),
		'ok', 'the new credential');
	perform pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
		current_setting('qorpera_test.job_credential')), 'ok:job_guest', 'back to the first credential');
	-- The body's own check: a caller with a member's claims is refused even where it may execute the function.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform public.qorpera_bind_native_identity_credential('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64),
			'job_guest', pg_temp.ic_sha('X' || repeat('x', 42)));
		raise exception 'a bind with a member''s claims was accepted';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '', true);
end $$;
savepoint exec_slot_bind;
delete from public.qorpera_native_identity_credentials where allocation_id = '86000000-0000-4000-8000-000000000071';
select pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'exec_slot',
	'E' || repeat('e', 42)), 'ok:exec_slot', 'an exec slot binds');
rollback to savepoint exec_slot_bind;

-- 3. Each kind's calls: a job guest's identity calls answer as the service caller's; a sign-in's login guest gets its
--    own sign-in and nothing of its identity's; a job guest never a sign-in. An exec slot is a job guest's equal.
do $$
declare v_direct jsonb; v_job text := current_setting('qorpera_test.job_credential');
	v_login text := current_setting('qorpera_test.login_credential'); v_epoch bigint := pg_temp.ic_epoch();
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_identity_recovery_runtime_state(current_setting('qorpera_test.identity')::uuid);
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()),
		'ok:' || v_direct::text, 'a job guest''s recovery state');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_compute_identity_login_in_vault', pg_temp.ic_identity_args()), 'ok',
		'a job guest''s vault custody');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_list_native_provider_account_refreshes',
		pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', v_epoch)), 'ok', 'a job guest''s account list');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_record_native_provider_account_metadata',
		pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', v_epoch, 'p_connection_id', extensions.gen_random_uuid(),
			'p_connection_version', 1, 'p_credential_capsule_id', extensions.gen_random_uuid(), 'p_provider_account_email', null,
			'p_provider_account_usage', null)), 'not refused', 'a job guest''s account record');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_describe_native_provider_login', jsonb_build_object(
		'p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.ic_sha('login-capability'))),
		'refused', 'a job guest''s sign-in');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_direct := public.qorpera_describe_native_provider_login(current_setting('qorpera_test.login_id')::uuid,
		pg_temp.ic_sha('login-capability'));
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_describe_native_provider_login', jsonb_build_object(
		'p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.ic_sha('login-capability'))),
		'ok:' || v_direct::text, 'a login guest''s own sign-in');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_describe_native_provider_login', jsonb_build_object(
		'p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', repeat('0', 64))),
		'refused', 'a wrong sign-in capability');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_describe_native_provider_login', jsonb_build_object(
		'p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', null)),
		'refused', 'no sign-in capability');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_describe_native_provider_login', jsonb_build_object(
		'p_login_id', extensions.gen_random_uuid(), 'p_capability_sha256', pg_temp.ic_sha('login-capability'))),
		'refused', 'another sign-in');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()),
		'refused', 'a login guest''s recovery state');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_compute_identity_login_in_vault', pg_temp.ic_identity_args()),
		'refused', 'a login guest''s vault custody');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_list_native_provider_account_refreshes',
		pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', v_epoch)), 'refused', 'a sign-in guest''s account list');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_login, 'qorpera_describe_native_account_refresh_route', jsonb_build_object(
		'p_request_id', '86000000-0000-4000-8000-000000000061', 'p_capability_sha256', pg_temp.ic_sha('refresh-capability'))),
		'refused', 'a sign-in guest''s account refresh');
end $$;
savepoint exec_slot;
update public.qorpera_native_identity_credentials set holder_kind = 'exec_slot'
where allocation_id = '86000000-0000-4000-8000-000000000071';
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'ok', 'an exec slot''s recovery state');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_describe_native_provider_login',
	jsonb_build_object('p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.ic_sha('login-capability'))),
	'refused', 'an exec slot''s sign-in');
rollback to savepoint exec_slot;

-- The sign-in guest completes its sign-in through the entry point as the service caller would (compared with a direct
-- completion, rolled back), and only with the native host's own capsule reference.
do $$
declare v_direct jsonb; v_outcome text; v_args jsonb := jsonb_build_object(
	'p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.ic_sha('login-capability'),
	'p_capsule_id', '86000000-0000-4000-8000-000000000081',
	'p_encrypted_capsule_reference', 'native-capsule/86000000-0000-4000-8000-000000000081',
	'p_attestation_policy_sha256', repeat('b', 64), 'p_provider_account_reference', 'fixture-openai-account',
	'p_billing_source', 'personal-subscription', 'p_consent_version', 'qorpera-native-provider-consent/v1',
	'p_quota_policy', '{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}'::jsonb,
	'p_provider_account_email', 'member@example.com');
begin
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		v_direct := public.qorpera_complete_native_provider_login((v_args ->> 'p_login_id')::uuid, v_args ->> 'p_capability_sha256',
			(v_args ->> 'p_capsule_id')::uuid, v_args ->> 'p_encrypted_capsule_reference', v_args ->> 'p_attestation_policy_sha256',
			v_args ->> 'p_provider_account_reference', v_args ->> 'p_billing_source', v_args ->> 'p_consent_version',
			v_args -> 'p_quota_policy', v_args ->> 'p_provider_account_email');
		raise exception using errcode = 'QG23A', message = 'roll the direct completion back';
	exception when sqlstate 'QG23A' then null;
	end;
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login',
		v_args || jsonb_build_object('p_encrypted_capsule_reference', 'model-login/86000000-0000-4000-8000-000000000081')),
		'refused', 'a sign-in completed with a vault capsule reference');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login',
		v_args || jsonb_build_object('p_encrypted_capsule_reference', 'native-capsule/86000000-0000-4000-8000-000000000082')),
		'refused', 'a sign-in completed with another capsule''s reference');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login',
		v_args - 'p_encrypted_capsule_reference'), 'refused', 'a sign-in completed with no capsule reference');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login',
		v_args || jsonb_build_object('p_capsule_id', '86000000-0000-4000-8000-0000000000AB',
			'p_encrypted_capsule_reference', 'native-capsule/86000000-0000-4000-8000-0000000000AB')),
		'refused', 'a sign-in completed with an upper-case capsule id');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login',
		v_args || jsonb_build_object('p_capsule_id', '00000000-0000-0000-0000-000000000000',
			'p_encrypted_capsule_reference', 'native-capsule/00000000-0000-0000-0000-000000000000')),
		'refused', 'a sign-in completed with the nil capsule id');
	v_outcome := pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_complete_native_provider_login', v_args);
	if v_direct is null or v_outcome not like 'ok:%' or (substr(v_outcome, 4)::jsonb - 'connection_id') <> (v_direct - 'connection_id') then
		raise exception 'a sign-in completed through the entry point differs: % vs %', v_outcome, v_direct; end if;
	if (select status from public.qorpera_native_provider_login_sessions
		where id = current_setting('qorpera_test.login_id')::uuid) is distinct from 'completed' then
		raise exception 'the sign-in is not completed'; end if;
end $$;

-- 4. An account refresh's login guest: its own refresh and its identity's account list and record, never a sign-in.
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = '86000000-0000-4000-8000-000000000072';
insert into public.qorpera_runtime_machine_allocations(id, profile_id, account_refresh_request_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('86000000-0000-4000-8000-000000000073', current_setting('qorpera_test.profile')::uuid,
	'86000000-0000-4000-8000-000000000061', current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('9', 64));
select pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000073', 'lxd-login', repeat('9', 64), 'login_guest',
	current_setting('qorpera_test.refresh_credential')), 'ok:login_guest', 'a refresh guest binds');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.login_credential'), 'qorpera_list_native_provider_account_refreshes',
	pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', pg_temp.ic_epoch())), 'refused', 'a released sign-in''s guest');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_describe_native_account_refresh_route',
	jsonb_build_object('p_request_id', '86000000-0000-4000-8000-000000000061', 'p_capability_sha256', pg_temp.ic_sha('refresh-capability'))),
	'ok', 'a refresh guest''s own refresh');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_describe_native_account_refresh_route',
	jsonb_build_object('p_request_id', extensions.gen_random_uuid(), 'p_capability_sha256', pg_temp.ic_sha('refresh-capability'))),
	'refused', 'another refresh');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_complete_native_account_refresh',
	jsonb_build_object('p_request_id', '86000000-0000-4000-8000-000000000061', 'p_capability_sha256', repeat('0', 64),
		'p_recovery_epoch', pg_temp.ic_epoch())), 'refused', 'a wrong refresh capability');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_describe_native_provider_login',
	jsonb_build_object('p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.ic_sha('login-capability'))),
	'refused', 'a refresh guest''s sign-in');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'a refresh guest''s recovery state');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_compute_identity_login_in_vault',
	pg_temp.ic_identity_args()), 'refused', 'a refresh guest''s vault custody');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_list_native_provider_account_refreshes',
	pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', pg_temp.ic_epoch())), 'ok', 'a refresh guest''s account list');
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_record_native_provider_account_metadata',
	pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', pg_temp.ic_epoch(), 'p_connection_id', extensions.gen_random_uuid(),
		'p_connection_version', 1, 'p_credential_capsule_id', extensions.gen_random_uuid(), 'p_provider_account_email', null,
		'p_provider_account_usage', null)), 'not refused', 'a refresh guest''s account record');
-- The refresh guest completes its refresh through the entry point as the service caller would.
do $$
declare v_direct boolean; v_args jsonb := jsonb_build_object('p_request_id', '86000000-0000-4000-8000-000000000061',
	'p_capability_sha256', pg_temp.ic_sha('refresh-capability'), 'p_recovery_epoch', pg_temp.ic_epoch());
begin
	begin
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		v_direct := public.qorpera_complete_native_account_refresh((v_args ->> 'p_request_id')::uuid, v_args ->> 'p_capability_sha256',
			(v_args ->> 'p_recovery_epoch')::bigint);
		raise exception using errcode = 'QG23A', message = 'roll the direct completion back';
	exception when sqlstate 'QG23A' then null;
	end;
	perform set_config('request.jwt.claims', '', true);
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_complete_native_account_refresh',
		v_args), 'ok:' || to_jsonb(v_direct)::text, 'a refresh guest''s own refresh completion');
	if (select status from public.qorpera_native_account_refresh_requests
		where id = '86000000-0000-4000-8000-000000000061') is distinct from 'completed' then
		raise exception 'the refresh is not completed'; end if;
end $$;

-- 5. Everything else is the entry point's one refusal: no or a wrong credential, another identity, an unlisted or
--    schema-qualified name, an undeclared argument, another recovery epoch, a released allocation, an identity that is
--    disabled or in recovery, a runner that is revoked or whose recovery epoch is behind, an allocation of another
--    company.
do $$
declare v_job text := current_setting('qorpera_test.job_credential'); v_epoch bigint := pg_temp.ic_epoch();
begin
	perform pg_temp.ic_expect(pg_temp.ic_call(null, 'qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()), 'refused', 'no credential');
	perform pg_temp.ic_expect(pg_temp.ic_call('W' || repeat('w', 42), 'qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()),
		'refused', 'a wrong credential');
	-- Another identity of the same company, named by a job guest or a login guest, or only in the arguments.
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state',
		jsonb_build_object('p_compute_identity_id', '86000000-0000-4000-8000-0000000000e1'), '86000000-0000-4000-8000-0000000000e1'),
		'refused', 'a job guest naming another identity');
	perform pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.refresh_credential'), 'qorpera_list_native_provider_account_refreshes',
		jsonb_build_object('p_compute_identity_id', '86000000-0000-4000-8000-0000000000e1', 'p_recovery_epoch', v_epoch),
		'86000000-0000-4000-8000-0000000000e1'), 'refused', 'a login guest naming another identity');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state',
		jsonb_build_object('p_compute_identity_id', '86000000-0000-4000-8000-0000000000e1')), 'refused', 'another identity''s argument');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state',
		jsonb_build_object('p_compute_identity_id', '86000000-0000-4000-8000-0000000000ee'), '86000000-0000-4000-8000-0000000000ee'),
		'refused', 'an unknown identity');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_native_host_call', '{}'), 'refused', 'an unlisted call');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'public.qorpera_identity_recovery_runtime_state', pg_temp.ic_identity_args()),
		'refused', 'a schema-qualified name');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state',
		pg_temp.ic_identity_args() || '{"p_extra":1}'), 'refused', 'an undeclared argument');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_identity_recovery_runtime_state', '{}'), 'refused', 'no identity argument');
	perform pg_temp.ic_expect(pg_temp.ic_call(v_job, 'qorpera_list_native_provider_account_refreshes',
		pg_temp.ic_identity_args() || jsonb_build_object('p_recovery_epoch', v_epoch + 1)), 'refused', 'another recovery epoch');
end $$;
savepoint disabled;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set status = 'disabled' where id = current_setting('qorpera_test.identity')::uuid;
set local session_replication_role = origin;
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'a disabled identity');
rollback to savepoint disabled;
savepoint stale_runner;
update public.qorpera_member_compute_identities set recovery_epoch = recovery_epoch + 1
where id = current_setting('qorpera_test.identity')::uuid;
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'a runner behind the identity''s recovery epoch');
rollback to savepoint stale_runner;
savepoint other_company;
set local session_replication_role = replica;
update public.qorpera_runtime_machine_allocations set profile_id = '86000000-0000-4000-8000-0000000000aa'
where id = '86000000-0000-4000-8000-000000000071';
set local session_replication_role = origin;
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'an allocation of another company');
rollback to savepoint other_company;
savepoint revoked_runner;
set local session_replication_role = replica;
update public.qorpera_runners set status = 'revoked', revoked_at = clock_timestamp(),
	revoked_by_user_id = '92400000-0000-4000-8000-000000000001', session_token_sha256 = null, session_expires_at = null
where id = current_setting('qorpera_test.runner')::uuid;
set local session_replication_role = origin;
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'a revoked runner');
select pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
	current_setting('qorpera_test.job_credential')), '42501', 'binding a revoked runner''s allocation');
rollback to savepoint revoked_runner;
savepoint pending;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = extensions.gen_random_uuid()
where id = current_setting('qorpera_test.identity')::uuid;
set local session_replication_role = origin;
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'an identity in recovery');
rollback to savepoint pending;
savepoint released;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '86000000-0000-4000-8000-000000000071';
select pg_temp.ic_expect(pg_temp.ic_call(current_setting('qorpera_test.job_credential'), 'qorpera_identity_recovery_runtime_state',
	pg_temp.ic_identity_args()), 'refused', 'a released allocation');
select pg_temp.ic_expect(pg_temp.ic_bind('86000000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64), 'job_guest',
	current_setting('qorpera_test.job_credential')), '42501', 'binding a released allocation');
rollback to savepoint released;

-- A second pending sign-in of the identity, by its member, for 6.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.pending_login_id', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '86000000-0000-4000-8000-000000000053', '86000000-0000-4000-8000-000000000054',
	current_setting('qorpera_test.identity')::uuid, 'openai', 'codex-cli', pg_temp.ic_sha('pending-login-capability'), 900)
	->> 'login_id', false);
reset role;

-- 6. A sign-in's completion checks the caller and the capability before it locks the sign-in, NULL-safe: with every
--    other input valid (as test 924's fixture completes its sign-in), a wrong or no capability is 55000.
do $$
declare v_capability text; v_state text;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	foreach v_capability in array array[repeat('0', 64), null] loop
		v_state := 'completed';
		begin
			perform public.qorpera_complete_native_provider_login(current_setting('qorpera_test.pending_login_id')::uuid, v_capability,
				'86000000-0000-4000-8000-000000000083', 'object://native-capsules/86000000-0000-4000-8000-000000000083',
				repeat('b', 64), 'fixture-openai-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
				'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
				null);
		exception when others then v_state := sqlstate;
		end;
		if v_state <> '55000' then
			raise exception 'a sign-in completion with capability % answered %', coalesce(v_capability, 'null'), v_state; end if;
	end loop;
	perform set_config('request.jwt.claims', '', true);
	if position('20260930005000' in pg_get_functiondef(
		'public.qorpera_complete_native_provider_login(uuid,text,uuid,text,text,text,text,text,jsonb,text)'::regprocedure)) = 0 then
		raise exception 'the sign-in completion is not this version'; end if;
end $$;

-- 7. The sign-in and identity family lose the execute rights the default privileges left them.
do $$
declare v_bad text;
begin
	select string_agg(f.signature || ':' || r.rolname, ', ') into v_bad
	from (values ('public.qorpera_describe_native_provider_login(uuid,text)', false),
		('public.qorpera_describe_native_provider_login_route(uuid,text)', false),
		('public.qorpera_begin_native_provider_login(uuid,uuid,uuid,uuid,text,text,text,integer)', true),
		('public.qorpera_revoke_native_provider_connection(uuid,uuid)', true),
		('public.qorpera_upsert_member_compute_identity(uuid,uuid,text,text,text,jsonb,jsonb)', true),
		('public.qorpera_upsert_scoped_compute_identity(uuid,uuid,text,text,text,text,text,jsonb,jsonb)', true)) as f(signature, member),
		(values ('anon'), ('authenticated')) as r(rolname)
	where has_function_privilege(r.rolname, f.signature, 'execute') is distinct from (f.member and r.rolname = 'authenticated');
	if v_bad is not null then raise exception 'execute rights left open: %', v_bad; end if;
end $$;

rollback;
