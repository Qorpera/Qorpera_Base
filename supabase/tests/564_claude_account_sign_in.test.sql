-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Claude sign-in through the shared vault (20260930564000). Company A is 924's company, served by the shared vault.
-- Checked: only the members on the list begin a Claude sign-in, and only in a company the shared vault serves; it is an
-- account sign-in of kind 'claude' that the chooser sends to the vault and the vault reads; it never gets a login
-- machine and never completes as a Codex login; the vault completes it into the member's Claude login (a repeat after a
-- lost answer answers the same); a newer sign-in replaces the older login and wipes its sealed files; the member lists
-- and signs out their own Claude login only; no API role reads the rows or completes a sign-in; a sign-in keeps its kind.

insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('56400000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64),
	'2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('56400000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://vault.qorpera.test',
	'vault-root-1', repeat('c', 64), '56400000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
update public.qorpera_account_model_login_settings set enabled = true;
select public.qorpera_set_provider_execution_policy('anthropic', 'native_subscription', 'claude-code', 'supported',
	'enabled', 32, null, 'claude-account-sign-in') \g /dev/null
-- The member's own identity in A (another member's identity for the cross-member checks).
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, owner_user_id, client_identity_id,
	display_name)
values ('56400000-0000-4000-8000-000000000022', '92400000-0000-4000-8000-000000000010', 'member',
	'92400000-0000-4000-8000-000000000002', extensions.gen_random_uuid(), 'Member identity');
select set_config('qorpera_test.cl_identity',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId', true) \g /dev/null

create function pg_temp.cl_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.cl_try(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	perform set_config('qorpera_test.cl_last', coalesce(v_result, ''), true);
	return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.cl_last() returns jsonb language sql as $$
	select nullif(current_setting('qorpera_test.cl_last', true), '')::jsonb
$$;
-- Begins a sign-in as the given member, for the given identity, with the given capability digest.
create function pg_temp.cl_begin(p_user uuid, p_identity uuid, p_capability text, p_provider text default 'anthropic',
	p_harness text default 'claude-code', p_connection uuid default extensions.gen_random_uuid())
returns text language sql as $$
	select pg_temp.cl_try(format('select public.qorpera_begin_native_provider_login(%L, %L, %L, %L, %L, %L, %L, 900)::text',
		'92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), p_connection, p_identity, p_provider,
		p_harness, p_capability))
$$;
create function pg_temp.cl_complete(p_login text, p_capability text, p_claude_login uuid, p_envelope text)
returns text language sql as $$
	select pg_temp.cl_try(format($q$select public.qorpera_complete_claude_login_sign_in(
		'56400000-0000-4000-8000-000000000040', repeat('c', 64), %L, %L, %L, 'vault-root-1',
		encode(%L::bytea, 'base64'), encode(sha256(%L::bytea), 'hex'), null, 'base-owner@example.test')::text$q$,
		p_login, p_capability, p_claude_login, p_envelope, p_envelope))
$$;
grant execute on function pg_temp.cl_expect(text,text,text), pg_temp.cl_try(text), pg_temp.cl_last(),
	pg_temp.cl_begin(uuid,uuid,text,text,text,uuid), pg_temp.cl_complete(text,text,uuid,text)
	to qorpera_secret_broker, service_role, authenticated;

-- 1. Only the vault completes a Claude sign-in; only members list and sign out their own; nobody reads the rows.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_function_privilege(v_role,
			'public.qorpera_complete_claude_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,text,text)', 'execute') then
			raise exception '% may complete a Claude sign-in', v_role; end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_claude_logins', 'select,insert,update,delete')
			or has_table_privilege(v_role, 'public.qorpera_claude_sign_in_members', 'select,insert,update,delete')
			or has_function_privilege(v_role, 'public.qorpera_claude_sign_in_open(uuid,uuid)', 'execute') then
			raise exception '% reads Claude logins or the list directly', v_role; end if;
	end loop;
	foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_list_claude_logins(uuid)', 'execute')
			or has_function_privilege(v_role, 'public.qorpera_sign_out_claude_login(uuid)', 'execute') then
			raise exception '% may list or sign out a member''s Claude login', v_role; end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker',
			'public.qorpera_complete_claude_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,text,text)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_list_claude_logins(uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_sign_out_claude_login(uuid)', 'execute') then
		raise exception 'the Claude grants are wrong'; end if;
end $$;

-- 2. Not on the list: no Claude sign-in begins, and the member's list says so. A ChatGPT sign-in is unchanged.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('1', 64)),
	'42501:Claude sign-in is not available here', 'a member not on the list begins no Claude sign-in');
select pg_temp.cl_expect((public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') ->> 'signInOpen'),
	'false', 'the list says Claude sign-in is not open');
savepoint cl_codex;
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('2', 64), 'openai', 'codex-cli'), 'ok',
	'a ChatGPT sign-in begins');
reset role;
select pg_temp.cl_expect((select model_login_kind || '/' || model_login_scope
	from public.qorpera_native_provider_login_sessions where id = (pg_temp.cl_last() ->> 'login_id')::uuid),
	'codex/account', 'a ChatGPT sign-in is still a Codex account sign-in');
rollback to savepoint cl_codex;
reset role;

-- 3. On the list: a Claude sign-in begins as an account sign-in of kind 'claude', for the member's own identity only.
insert into public.qorpera_claude_sign_in_members(user_id) values ('92400000-0000-4000-8000-000000000001');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect((public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') ->> 'signInOpen'),
	'true', 'the list says Claude sign-in is open');
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('3', 64), 'anthropic', 'codex-cli'),
	'55000:native provider execution is not enabled for this deployment', 'a mixed provider and harness is refused');
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('4', 64), 'anthropic', 'claude-code',
	'56400000-0000-4000-8000-0000000000c1'), 'ok', 'the member begins a Claude sign-in');
reset role;
select set_config('qorpera_test.cl_login', pg_temp.cl_last() ->> 'login_id', true) \g /dev/null
select pg_temp.cl_expect((select model_login_kind || '/' || model_login_scope
	from public.qorpera_native_provider_login_sessions where id = current_setting('qorpera_test.cl_login')::uuid),
	'claude/account', 'a Claude sign-in is a Claude account sign-in');
select pg_temp.base_claims('service_role');
select pg_temp.cl_expect((public.qorpera_runtime_login_gateway_choose(repeat('4', 64)) ->> 'reason'),
	'MODEL_LOGIN_VAULT', 'the chooser sends a Claude sign-in to the vault');
select pg_temp.cl_expect((public.qorpera_runtime_login_gateway_choose(repeat('4', 64)) ->> 'url'),
	'https://vault.qorpera.test/v1/model-logins/92400000-0000-4000-8000-000000000010/', 'to its company''s vault');
-- Another member on the list still cannot sign in with someone else's identity (the begin itself refuses).
insert into public.qorpera_claude_sign_in_members(user_id) values ('92400000-0000-4000-8000-000000000002');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.cl_expect(left(pg_temp.cl_begin('92400000-0000-4000-8000-000000000002',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('5', 64)), 5), '22023',
	'another member''s identity is refused');
reset role;
select pg_temp.base_claims('service_role');

-- 4. It never gets a login machine or allocation, never completes on a node, and never as a Codex login.
do $$
begin
	begin
		insert into public.qorpera_runtime_login_machine_requests(allocation_id, login_session_id, profile_id,
			compute_identity_id, provider_adapter, instance_sha256)
		values (extensions.gen_random_uuid(), current_setting('qorpera_test.cl_login')::uuid,
			'92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.cl_identity')::uuid, 'native26-phql-b1',
			repeat('e', 64));
		raise exception 'a Claude sign-in got a login machine';
	exception when insufficient_privilege then null;
	end;
	begin
		insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
			provider_adapter, instance_sha256)
		values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010',
			current_setting('qorpera_test.cl_login')::uuid, current_setting('qorpera_test.cl_identity')::uuid,
			'native26-phql-b1', repeat('e', 64));
		raise exception 'a Claude sign-in got a machine allocation';
	exception when insufficient_privilege then null;
	end;
	-- A node's completion would make a provider connection and capsule agents could use: refused (a Claude sign-in is
	-- no Codex one), with all it wrote.
	begin
		perform public.qorpera_complete_native_provider_login(current_setting('qorpera_test.cl_login')::uuid, repeat('4', 64),
			extensions.gen_random_uuid(), 'object://claude/node', repeat('d', 64), 'claude-account', 'personal-subscription',
			'qorpera-native-provider-consent/v1',
			'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
		raise exception 'a node completed a Claude sign-in';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'native provider login is unavailable' then raise; end if;
	end;
	-- And whatever else would mark it completed without its Claude login.
	begin
		update public.qorpera_native_provider_login_sessions set status = 'completed', completed_at = statement_timestamp()
		where id = current_setting('qorpera_test.cl_login')::uuid;
		raise exception 'a Claude sign-in completed without its Claude login';
	exception when insufficient_privilege then
		if sqlerrm <> 'A Claude sign-in completes only as a Claude login' then raise; end if;
	end;
	if (select status from public.qorpera_native_provider_login_sessions
			where id = current_setting('qorpera_test.cl_login')::uuid) <> 'pending'
		or exists (select 1 from public.qorpera_native_credential_capsules where provider = 'anthropic')
		or exists (select 1 from public.qorpera_provider_connections where provider = 'anthropic') then
		raise exception 'a refused node completion left rows behind'; end if;
	begin
		update public.qorpera_native_provider_login_sessions set model_login_kind = 'codex'
		where id = current_setting('qorpera_test.cl_login')::uuid;
		raise exception 'a Claude sign-in became a Codex sign-in';
	exception when insufficient_privilege then null;
	end;
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.cl_expect(pg_temp.cl_try(format($q$select public.qorpera_describe_model_login_sign_in_v2(
	'56400000-0000-4000-8000-000000000040', repeat('c', 64), %L, repeat('4', 64))::text$q$,
	current_setting('qorpera_test.cl_login'))), 'ok', 'the vault reads the Claude sign-in');
select pg_temp.cl_expect((select jsonb_build_object('kind', answer ->> 'loginKind', 'scope', answer ->> 'scope',
		'status', answer ->> 'status', 'owner', answer ->> 'computeIdentityOwnerUserId', 'login', answer -> 'modelLoginId')::text
	from pg_temp.cl_last() as answer),
	jsonb_build_object('kind', 'claude', 'scope', 'account', 'status', 'pending',
		'owner', '92400000-0000-4000-8000-000000000001', 'login', null)::text, 'the read names a Claude account sign-in');
select pg_temp.cl_expect(pg_temp.cl_try(format($q$select public.qorpera_complete_account_model_login_sign_in(
	'56400000-0000-4000-8000-000000000040', repeat('c', 64), %L, repeat('4', 64), '56400000-0000-4000-8000-0000000000f0',
	'vault-root-1', encode('codex'::bytea, 'base64'), encode(sha256('codex'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days', null, null)::text$q$,
	current_setting('qorpera_test.cl_login'))), '42501:model login sign-in is unavailable',
	'a Claude sign-in never completes as a Codex account login');
select pg_temp.cl_expect(pg_temp.cl_try(format($q$select public.qorpera_complete_model_login_sign_in(
	'56400000-0000-4000-8000-000000000040', repeat('c', 64), %L, repeat('4', 64), '56400000-0000-4000-8000-0000000000f0',
	'vault-root-1', encode('codex'::bytea, 'base64'), encode(sha256('codex'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days', null, null)::text$q$,
	current_setting('qorpera_test.cl_login'))), '42501:model login sign-in is unavailable',
	'a Claude sign-in never completes as a Codex company login');

-- 5. The vault completes it: the member's Claude login; a repeat answers the same; a forged capability is refused.
select pg_temp.cl_expect(pg_temp.cl_complete(current_setting('qorpera_test.cl_login'), repeat('9', 64),
	'56400000-0000-4000-8000-000000000101', 'claude-files-1'), '42501:Claude sign-in is unavailable',
	'a wrong sign-in capability');
select pg_temp.cl_expect(pg_temp.cl_complete(current_setting('qorpera_test.cl_login'), repeat('4', 64),
	'56400000-0000-4000-8000-000000000101', 'claude-files-1'), 'ok', 'the vault completes the Claude sign-in');
select set_config('qorpera_test.cl_completed', pg_temp.cl_last()::text, true) \g /dev/null
select pg_temp.cl_expect(pg_temp.cl_complete(current_setting('qorpera_test.cl_login'), repeat('4', 64),
	'56400000-0000-4000-8000-000000000101', 'claude-files-1'), 'ok', 'a repeat after a lost answer');
select pg_temp.cl_expect(pg_temp.cl_last()::text, current_setting('qorpera_test.cl_completed'), 'the repeat answers the same');
select pg_temp.cl_expect(pg_temp.cl_complete(current_setting('qorpera_test.cl_login'), repeat('4', 64),
	'56400000-0000-4000-8000-000000000101', 'other-files'), '55000:Claude sign-in is already complete',
	'a different completion of a completed sign-in');
reset session authorization;
do $$
begin
	if not exists (select 1 from public.qorpera_claude_logins where id = '56400000-0000-4000-8000-000000000101'
			and owner_user_id = '92400000-0000-4000-8000-000000000001' and status = 'active'
			and principal_id = '56400000-0000-4000-8000-000000000050'
			and encrypted_envelope = 'claude-files-1'::bytea and provider_account_email = 'base-owner@example.test')
		or (select status from public.qorpera_native_provider_login_sessions
			where id = current_setting('qorpera_test.cl_login')::uuid) <> 'completed' then
		raise exception 'the Claude login was not kept'; end if;
	-- Nothing a run, renewal, usage read or sponsor uses was made.
	if exists (select 1 from public.qorpera_model_logins where sign_in_session_id = current_setting('qorpera_test.cl_login')::uuid)
		or exists (select 1 from public.qorpera_provider_connections where provider = 'anthropic')
		or exists (select 1 from public.qorpera_native_credential_capsules where provider = 'anthropic') then
		raise exception 'a Claude sign-in made a model login, connection or capsule'; end if;
end $$;

-- 6. The member lists it; another member sees none of it and cannot sign it out.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect((select jsonb_build_object('n', jsonb_array_length(list -> 'logins'),
		'id', list -> 'logins' -> 0 ->> 'loginId', 'email', list -> 'logins' -> 0 ->> 'providerAccountEmail',
		'connection', list -> 'logins' -> 0 ->> 'clientConnectionId')::text
	from public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') as list),
	jsonb_build_object('n', 1, 'id', '56400000-0000-4000-8000-000000000101', 'email', 'base-owner@example.test',
		'connection', '56400000-0000-4000-8000-0000000000c1')::text, 'the member lists their Claude login');
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.cl_expect(jsonb_array_length(public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010')
	-> 'logins')::text, '0', 'another member lists none');
select pg_temp.cl_expect(pg_temp.cl_try($q$select public.qorpera_sign_out_claude_login(
	'56400000-0000-4000-8000-000000000101')::text$q$), '42501:Claude login is unavailable',
	'another member cannot sign it out');
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.cl_expect(pg_temp.cl_try($q$select public.qorpera_list_claude_logins(
	'68500000-0000-4000-8000-0000000000ff')::text$q$), '42501:Claude logins are unavailable',
	'no list in a company the member is not in');
reset role;

-- 7. A newer sign-in replaces the older login and wipes its sealed files.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('6', 64)), 'ok', 'the member signs in again');
reset role;
select set_config('qorpera_test.cl_login2', pg_temp.cl_last() ->> 'login_id', true) \g /dev/null
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.cl_expect(pg_temp.cl_complete(current_setting('qorpera_test.cl_login2'), repeat('6', 64),
	'56400000-0000-4000-8000-000000000102', 'claude-files-2'), 'ok', 'the newer sign-in completes');
reset session authorization;
do $$
begin
	if (select status || '/' || coalesce(encode(encrypted_envelope, 'escape'), 'wiped')
			from public.qorpera_claude_logins where id = '56400000-0000-4000-8000-000000000101') <> 'revoked/wiped'
		or (select status from public.qorpera_claude_logins where id = '56400000-0000-4000-8000-000000000102') <> 'active' then
		raise exception 'the newer sign-in did not replace the older login'; end if;
end $$;
-- Deleting the sign-in it came from (its company's deletion does) keeps the member's login and its connection id.
savepoint cl_company_gone;
delete from public.qorpera_native_provider_login_sessions where id = current_setting('qorpera_test.cl_login2')::uuid;
select pg_temp.cl_expect((select status || '/' || (sign_in_session_id is null)::text || '/' || client_connection_id::text
	from public.qorpera_claude_logins where id = '56400000-0000-4000-8000-000000000102'),
	'active/true/' || (select client_connection_id::text from public.qorpera_claude_logins
		where id = '56400000-0000-4000-8000-000000000102'), 'the login outlives its sign-in');
rollback to savepoint cl_company_gone;

-- 8. Sign out wipes the sealed files; a member taken off the list cannot sign in.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect(pg_temp.cl_try($q$select public.qorpera_sign_out_claude_login(
	'56400000-0000-4000-8000-000000000102')::text$q$), 'ok', 'the member signs out');
select pg_temp.cl_expect(pg_temp.cl_last() ->> 'status', 'revoked', 'the sign-out answers revoked');
select pg_temp.cl_expect(jsonb_array_length(public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010')
	-> 'logins')::text, '0', 'nothing is listed after the sign-out');
reset role;
do $$
begin
	if exists (select 1 from public.qorpera_claude_logins where encrypted_envelope is not null) then
		raise exception 'a signed-out Claude login kept its sealed files'; end if;
end $$;
delete from public.qorpera_claude_sign_in_members where user_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.cl_expect(pg_temp.cl_begin('92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cl_identity')::uuid, repeat('7', 64)),
	'42501:Claude sign-in is not available here', 'off the list, no Claude sign-in begins');
reset role;

rollback;
