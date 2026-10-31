-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- F8 (migration 20260930544000): a new version of an existing sponsor binding keeps who pays. 924's base: the owner Y
-- (…001) pays with binding …0061 on their login A. The admin X (…004) has a login of their own; K1 and K2 are company
-- accounts. Another member's login never replaces Y's (even a login or company account the caller may bind), and a
-- binding never changes between a member's login and a company account; Y's own refresh or move to another login of
-- theirs, company-to-company versions by an owner or admin who did not create the binding (also between the company
-- kinds), a first create, and the incoming-login check stay as they are. A binding whose stored newest version the API
-- can't make fails closed: no version, a missing login, a member version on a company account, an unknown kind, a
-- company version on a member's login. Each case is checked apart (a refused call that succeeds is rolled back), and
-- the test fails once at the end with every case's outcome.

-- The test's logins and bindings: a (Y's login A), b (Y's login B), x (X's login), k1 and k2 (company accounts), 0061
-- (Y's binding) and c (the company binding).
create function pg_temp.p506(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'
		when '0061' then current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id'
		else nullif(current_setting('qorpera_test.p506_' || p_key, true), '') end::uuid
$$;
create function pg_temp.p506_name(p_id uuid) returns text language sql as $$
	select case when p_id is null then 'none'
		when p_id = pg_temp.p506('a') then 'login A (Y)'
		when p_id = pg_temp.p506('b') then 'login B (Y)'
		when p_id = pg_temp.p506('x') then 'login X'
		when p_id = pg_temp.p506('k1') then 'company K1'
		when p_id = pg_temp.p506('k2') then 'company K2'
		when p_id = pg_temp.p506('0061') then 'binding …0061'
		when p_id = pg_temp.p506('c') then 'binding C'
		else 'another id' end
$$;
-- Who pays for work that follows a run of Bob's paid by the binding, for Y (905's check).
create function pg_temp.p506_payer(p_binding uuid) returns uuid language sql as $$
	select binding_id from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', p_binding)
$$;
create function pg_temp.p506_state(p_binding uuid) returns text language sql as $$
	select format('%s bindings, %s versions, newest on %s, follow-up payer %s',
		(select count(*) from public.qorpera_execution_sponsor_bindings where profile_id = '92400000-0000-4000-8000-000000000010'),
		(select count(*) from public.qorpera_execution_sponsor_versions where binding_id = p_binding),
		pg_temp.p506_name(public.qorpera_sponsor_binding_connection(p_binding)), pg_temp.p506_name(pg_temp.p506_payer(p_binding)))
$$;
-- A member's call that adds a version with a login (key and version) to the binding named by its client id.
create function pg_temp.p506_call(p_client text, p_kind text, p_connection text, p_version bigint) returns text language sql as $$
	select format('select public.qorpera_create_execution_sponsor_binding(%L, %L, %L, %L, %s, true)',
		'92400000-0000-4000-8000-000000000010', p_client, p_kind, pg_temp.p506(p_connection), p_version)
$$;
create temp table p506_cases (seq serial, label text not null, ok boolean not null, detail text not null);
create function pg_temp.p506_note(p_label text, p_result jsonb) returns void language sql as $$
	insert into pg_temp.p506_cases (label, ok, detail) values (p_label, (p_result ->> 'ok')::boolean, p_result ->> 'detail')
$$;
-- Runs a call that must be refused, as a member; answers {ok, detail}. A call that succeeds is described, then rolled
-- back, so each case starts from the state the test built, whatever the source does.
create function pg_temp.p506_check(p_user uuid, p_sql text, p_binding uuid, p_state text, p_message text) returns jsonb
language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_before text := pg_temp.p506_state(p_binding);
	v_after text; v_got text;
begin
	begin
		perform pg_temp.base_claims('authenticated', p_user);
		set local role authenticated;
		execute p_sql;
		reset role;
		v_got := 'the call succeeded';
		v_after := pg_temp.p506_state(p_binding);
		raise exception using errcode = 'QT506';
	exception when sqlstate 'QT506' then null;
		when others then
			v_got := format('%s ''%s''', sqlstate, sqlerrm);
			v_after := pg_temp.p506_state(p_binding);
	end;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return jsonb_build_object('ok', v_got = format('%s ''%s''', p_state, p_message) and v_after = v_before,
		'detail', format('expected %s ''%s'', got %s; %s', p_state, p_message, v_got,
			case when v_after = v_before then 'unchanged: ' || v_before else v_before || ' became ' || v_after end));
end
$$;
create function pg_temp.p506_refuse(p_label text, p_user uuid, p_sql text, p_binding uuid, p_state text, p_message text)
returns void language sql as $$
	select pg_temp.p506_note(p_label, pg_temp.p506_check(p_user, p_sql, p_binding, p_state, p_message))
$$;
-- Runs a call that must add the version given, as a member, and keeps it; answers its result.
create function pg_temp.p506_allow(p_label text, p_user uuid, p_sql text, p_version bigint) returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_result jsonb; v_got text;
begin
	begin
		perform pg_temp.base_claims('authenticated', p_user);
		set local role authenticated;
		execute p_sql into v_result;
		reset role;
		v_got := 'version ' || coalesce(v_result ->> 'version', 'none');
	exception when others then
		v_got := format('%s ''%s''', sqlstate, sqlerrm);
	end;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform pg_temp.p506_note(p_label, jsonb_build_object('ok', v_got = 'version ' || p_version,
		'detail', format('expected version %s, got %s', p_version, v_got)));
	return v_result;
end
$$;
-- A binding whose stored newest version the API can't make, written directly as the fixture owner (a null kind leaves
-- the binding with no version): Y's call to add their login A must fail closed. Everything the case writes is rolled back.
create function pg_temp.p506_stored(p_label text, p_client uuid, p_kind text, p_connection uuid, p_version bigint,
	p_message text) returns void language plpgsql as $$
declare v_binding uuid; v_result jsonb;
begin
	begin
		insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
		values ('92400000-0000-4000-8000-000000000010', p_client, '92400000-0000-4000-8000-000000000001')
		returning id into v_binding;
		if p_kind is not null then
			if p_kind not in ('member_connection', 'company_service_account', 'company_api_billing') then
				execute (select format('alter table public.qorpera_execution_sponsor_versions drop constraint %I', conname)
					from pg_constraint where conrelid = 'public.qorpera_execution_sponsor_versions'::regclass and contype = 'c'
						and pg_get_constraintdef(oid) like '%sponsor_kind%');
			end if;
			-- A version on a login that does not exist passes no foreign key (as 280 and 380 write such rows).
			if not exists (select 1 from public.qorpera_provider_connections where id = p_connection) then
				set local session_replication_role = replica;
			end if;
			insert into public.qorpera_execution_sponsor_versions (binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id)
			values (v_binding, 1, p_kind, p_connection, p_version, false, '92400000-0000-4000-8000-000000000001');
			set local session_replication_role = origin;
		end if;
		v_result := pg_temp.p506_check('92400000-0000-4000-8000-000000000001',
			pg_temp.p506_call(p_client::text, 'member_connection', 'a', 2), v_binding, '55000', p_message);
		raise exception using errcode = 'QT507';
	exception when sqlstate 'QT507' then null;
	end;
	perform pg_temp.p506_note(p_label, v_result);
end
$$;

-- X connects a login of their own, Y a second login B (as 905 does, allowed to work while they are away), and the owner
-- two company accounts.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
set local role authenticated;
select set_config('qorpera_test.p506_x', public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010',
	'50600000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000004', 'openai', 'api_key', 'openai-responses',
	'vault://member/provider/openai', 'acct_member', 'member-api-budget', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true) ->> 'connection_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p506_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '50600000-0000-4000-8000-000000000051', '50600000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('e', 64), 900)::text,
	true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p506_b', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.p506_login')::jsonb ->> 'login_id')::uuid, repeat('e', 64), '50600000-0000-4000-8000-000000000060',
	'object://native-capsules/50600000-0000-4000-8000-000000000060', repeat('f', 64), 'fixture-openai-account-b', 'personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')
	->> 'connection_id', true) \g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v where connection_id = pg_temp.p506('b') and version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p506_k1', public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010',
	'50600000-0000-4000-8000-000000000070', null, 'openai', 'api_key', 'codex-cli', 'vault://company/openai', 'org-fixture',
	'company-api-billing', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true) ->> 'connection_id', true) \g /dev/null
select set_config('qorpera_test.p506_k2', public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010',
	'50600000-0000-4000-8000-000000000072', null, 'openai', 'api_key', 'codex-cli', 'vault://company/openai-k2', 'org-fixture-k2',
	'company-api-billing', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true) ->> 'connection_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

-- Whether binding …0061 has the versions given, the newest on the login given, and work that follows its runs stays on it.
create function pg_temp.p506_pays(p_label text, p_versions bigint, p_connection text) returns void language sql as $$
	select pg_temp.p506_note(p_label, jsonb_build_object('ok',
		(select count(*) from public.qorpera_execution_sponsor_versions where binding_id = pg_temp.p506('0061')) = p_versions
			and public.qorpera_sponsor_binding_connection(pg_temp.p506('0061')) = pg_temp.p506(p_connection)
			and pg_temp.p506_payer(pg_temp.p506('0061')) = pg_temp.p506('0061'),
		'detail', format('expected %s versions, newest on %s, follow-up payer binding …0061; got %s', p_versions,
			pg_temp.p506_name(pg_temp.p506(p_connection)), pg_temp.p506_state(pg_temp.p506('0061')))))
$$;

-- 0. The start: binding …0061 has one version, on Y's login A, and work that follows its runs stays on it.
select pg_temp.p506_pays('B0: the start', 1, 'a');

-- 1. Another member's login, or a company account, never replaces Y's: X (an admin) adds their own login, then K1; Y
--    cannot turn their binding into a company account; and nobody binds another member's login as the new version
--    (20260928230000).
select pg_temp.p506_refuse('T1: X adds login X to …0061', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'member_connection', 'x', 1), pg_temp.p506('0061'),
	'42501', 'execution sponsor binding pays with another member''s login');
select pg_temp.p506_refuse('T2: X adds company K1 to …0061', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'company_api_billing', 'k1', 1), pg_temp.p506('0061'),
	'42501', 'execution sponsor binding pays with another member''s login');
select pg_temp.p506_refuse('T3: Y adds company K1 to …0061', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'company_api_billing', 'k1', 1), pg_temp.p506('0061'),
	'22023', 'execution sponsor binding cannot change kind');
select pg_temp.p506_refuse('T10: Y adds login X to …0061', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'member_connection', 'x', 1), pg_temp.p506('0061'),
	'42501', 'member execution sponsor requires its owner');

-- 2. Y refreshes their login A, then moves the binding to their login B, which then pays, also for work that follows
--    its runs. X still cannot add their login.
select pg_temp.p506_allow('T4: Y adds login A to …0061 again', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'member_connection', 'a', 2), 2) \g /dev/null
select pg_temp.p506_allow('T5: Y adds login B to …0061', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'member_connection', 'b', 2), 3) \g /dev/null
select pg_temp.p506_pays('T5b: …0061 pays with login B', 3, 'b');
select pg_temp.p506_refuse('T6: X adds login X to …0061 on login B', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('92400000-0000-4000-8000-000000000061', 'member_connection', 'x', 1), pg_temp.p506('0061'),
	'42501', 'execution sponsor binding pays with another member''s login');

-- 3. A company binding C, created by Y on K1: X, who did not create it, moves it to K2, then to K1 as the other company
--    kind. Neither X's nor Y's login replaces the company account.
select set_config('qorpera_test.p506_c', pg_temp.p506_allow('T7a: Y creates C on company K1', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000071', 'company_api_billing', 'k1', 1), 1) ->> 'binding_id', true) \g /dev/null
select pg_temp.p506_allow('T7b: X adds company K2 to C', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000071', 'company_api_billing', 'k2', 1), 2) \g /dev/null
select pg_temp.p506_allow('T7c: X adds company K1 to C as a service account', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000071', 'company_service_account', 'k1', 1), 3) \g /dev/null
select pg_temp.p506_refuse('T8: X adds login X to C', '92400000-0000-4000-8000-000000000004',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000071', 'member_connection', 'x', 1), pg_temp.p506('c'),
	'22023', 'execution sponsor binding cannot change kind');
select pg_temp.p506_refuse('T8b: Y adds login B to C', '92400000-0000-4000-8000-000000000001',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000071', 'member_connection', 'b', 2), pg_temp.p506('c'),
	'22023', 'execution sponsor binding cannot change kind');

-- 4. A viewer still cannot create a binding.
select pg_temp.p506_refuse('T9: the viewer creates a binding', '92400000-0000-4000-8000-000000000003',
	pg_temp.p506_call('50600000-0000-4000-8000-000000000079', 'company_api_billing', 'k1', 1), null,
	'42501', 'execution sponsor requires authorize access');

-- 5. A stored newest version the API can't make fails closed. Two versions at the newest number can't exist: the
--    primary key (binding_id, version) of 20260820002000.
select pg_temp.p506_stored('N1: a binding with no version', '50600000-0000-4000-8000-000000000081', null, null, null,
	'execution sponsor binding has no version');
select pg_temp.p506_stored('N2: a version on a missing login', '50600000-0000-4000-8000-000000000082', 'member_connection',
	'50600000-0000-4000-8000-0000000000ff', 1, 'execution sponsor binding''s login is missing');
select pg_temp.p506_stored('N3: a member version on company K1', '50600000-0000-4000-8000-000000000083', 'member_connection',
	pg_temp.p506('k1'), 1, 'execution sponsor binding''s member login has no owner');
select pg_temp.p506_stored('N4: an unknown kind', '50600000-0000-4000-8000-000000000084', 'company_mystery',
	pg_temp.p506('k1'), 1, 'execution sponsor binding''s kind is unknown');
select pg_temp.p506_note('N5: one version per number', jsonb_build_object('ok', exists (select 1 from pg_constraint
	where conrelid = 'public.qorpera_execution_sponsor_versions'::regclass and contype = 'p'
		and pg_get_constraintdef(oid) = 'PRIMARY KEY (binding_id, version)'), 'detail', 'the primary key (binding_id, version)'));
select pg_temp.p506_stored('N6: a company version on login A', '50600000-0000-4000-8000-000000000086', 'company_api_billing',
	pg_temp.p506('a'), 2, 'execution sponsor binding''s company account has a member owner');

-- 6. The function carries this fix, and members may still call it.
select pg_temp.p506_note('M1: the body and grant', jsonb_build_object('ok',
	position('20260930544000' in pg_get_functiondef('public.qorpera_create_execution_sponsor_binding(uuid,uuid,text,uuid,bigint,boolean)'::regprocedure)) > 0
	and has_function_privilege('authenticated', 'public.qorpera_create_execution_sponsor_binding(uuid,uuid,text,uuid,bigint,boolean)', 'EXECUTE'),
	'detail', 'the 20260930544000 body, executable by authenticated'));

-- Every case, as one result.
select pg_temp.base_assert((select count(*) = 22 and bool_and(ok) from pg_temp.p506_cases),
	E'F8 cases (' || (select count(*) from pg_temp.p506_cases) || E' of 22):\n'
	|| (select string_agg(format('%s %s: %s', case when ok then 'PASS' else 'FAIL' end, label, detail), E'\n' order by seq)
		from pg_temp.p506_cases));

rollback;
