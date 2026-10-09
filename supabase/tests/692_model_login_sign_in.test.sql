-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Stateless Compute step 1 (change 2B) on folder-v2: a member's vault sign-in is the company's broker's alone. The
-- service role cannot read or complete one, nor read the vault's address, and no API role reads the switched companies.
-- The broker of an unswitched company, another company's broker, a wrong broker capability or another sign-in's
-- capability reads nothing; a key the broker does not hold, a second login for a completed sign-in and a sign-in left
-- open when its company is switched back complete nothing. The sign-ins are clones of 924's owner's sign-in (ported from
-- snapshot-v1 in the legacy sweep).

-- The company's broker and another company's broker.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('69200000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69200000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64)),
	('69200000-0000-4000-8000-000000000041', '69200000-0000-4000-8000-000000000010', 'https://other.qorpera.test', 'other-kek-1', repeat('d', 64));

-- Two pending Codex sign-ins of the owner, made like 924's own.
do $$
declare v_columns text; v_base jsonb;
begin
	select string_agg(quote_ident(attname), ',' order by attnum) into v_columns from pg_attribute
	where attrelid = 'public.qorpera_native_provider_login_sessions'::regclass
		and attnum > 0 and not attisdropped and attgenerated = '';
	select to_jsonb(session) into strict v_base from public.qorpera_native_provider_login_sessions as session
	where session.compute_identity_id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid
		and session.provider = 'openai' and session.native_harness = 'codex-cli'
	order by session.created_at limit 1;
	execute format('insert into public.qorpera_native_provider_login_sessions (%1$s) select %1$s from '
		|| 'jsonb_populate_record(null::public.qorpera_native_provider_login_sessions, $1)', v_columns)
	using v_base || jsonb_build_object('id', '69200000-0000-4000-8000-000000000101',
		'client_login_id', '69200000-0000-4000-8000-000000000102', 'client_connection_id', '69200000-0000-4000-8000-000000000103',
		'capability_sha256', encode(sha256('sign-in-one'::bytea), 'hex'), 'status', 'pending', 'completed_at', null,
		'created_at', clock_timestamp(), 'expires_at', clock_timestamp() + interval '10 minutes');
	execute format('insert into public.qorpera_native_provider_login_sessions (%1$s) select %1$s from '
		|| 'jsonb_populate_record(null::public.qorpera_native_provider_login_sessions, $1)', v_columns)
	using v_base || jsonb_build_object('id', '69200000-0000-4000-8000-000000000201',
		'client_login_id', '69200000-0000-4000-8000-000000000202', 'client_connection_id', '69200000-0000-4000-8000-000000000203',
		'capability_sha256', encode(sha256('sign-in-two'::bytea), 'hex'), 'status', 'pending', 'completed_at', null,
		'created_at', clock_timestamp() + interval '1 second', 'expires_at', clock_timestamp() + interval '10 minutes');
end $$;
-- The second sign-in superseded the first (same member and identity): make both pending again.
update public.qorpera_native_provider_login_sessions set status = 'pending'
where id in ('69200000-0000-4000-8000-000000000101', '69200000-0000-4000-8000-000000000201');

create function pg_temp.si_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.si_describe(p_authority uuid, p_capability text, p_login uuid, p_secret text)
returns text language plpgsql as $$
begin
	return public.qorpera_describe_model_login_sign_in(p_authority, p_capability, p_login,
		encode(sha256(p_secret::bytea), 'hex')) ->> 'status';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.si_complete(p_login uuid, p_secret text, p_model_login uuid, p_envelope bytea,
	p_key text default 'company-kek-1')
returns text language plpgsql as $$
begin
	perform public.qorpera_complete_model_login_sign_in('69200000-0000-4000-8000-000000000040', repeat('c', 64),
		p_login, encode(sha256(p_secret::bytea), 'hex'), p_model_login, p_key, encode(p_envelope, 'base64'),
		encode(sha256(p_envelope), 'hex'), clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 days',
		'account-reference', 'member@example.test');
	return 'completed';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.si_switch(p_enabled boolean)
returns text language plpgsql as $$
begin
	return public.qorpera_set_model_login_sign_in('92400000-0000-4000-8000-000000000010', p_enabled)::text;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.si_expect(text,text,text), pg_temp.si_describe(uuid,text,uuid,text),
	pg_temp.si_complete(uuid,text,uuid,bytea,text), pg_temp.si_switch(boolean) to qorpera_secret_broker, service_role;

-- 1. Privileges: describe and complete are the broker's, the vault's address is the database's; the service role has
-- none of them, the broker cannot read the switched companies and the service role cannot add one by hand.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_describe_model_login_sign_in(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_complete_model_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_model_login_sign_in_url(uuid)', 'execute') then
		raise exception 'Vault sign-in is exposed to service_role'; end if;
	if has_table_privilege('qorpera_secret_broker', 'public.qorpera_model_login_sign_in_companies', 'select')
		or has_table_privilege('service_role', 'public.qorpera_model_login_sign_in_companies', 'insert') then
		raise exception 'Vault sign-in companies are exposed'; end if;
end $$;

-- 2. The broker of a company not switched to the vault reads nothing.
set local session authorization qorpera_secret_broker;
select pg_temp.si_expect(pg_temp.si_describe('69200000-0000-4000-8000-000000000040', repeat('c', 64),
	'69200000-0000-4000-8000-000000000101', 'sign-in-one'),
	'42501:model login sign-in is unavailable', 'the broker of an unswitched company');
reset session authorization;
set local role service_role;
select pg_temp.si_expect(pg_temp.si_switch(true), 'true', 'the operator switches the company');
reset role;

-- 3. Switched: the broker reads a pending sign-in by its capability; another sign-in's capability, another company's
-- broker and a wrong broker capability read nothing; a key the broker does not hold completes nothing.
set local session authorization qorpera_secret_broker;
select pg_temp.si_expect(pg_temp.si_describe('69200000-0000-4000-8000-000000000040', repeat('c', 64),
	'69200000-0000-4000-8000-000000000101', 'sign-in-one'), 'pending', 'the broker reads a pending sign-in');
select pg_temp.si_expect(pg_temp.si_describe('69200000-0000-4000-8000-000000000040', repeat('c', 64),
	'69200000-0000-4000-8000-000000000101', 'sign-in-two'),
	'42501:model login sign-in is unavailable', 'another sign-in''s capability');
select pg_temp.si_expect(pg_temp.si_describe('69200000-0000-4000-8000-000000000041', repeat('d', 64),
	'69200000-0000-4000-8000-000000000101', 'sign-in-one'),
	'42501:model login sign-in is unavailable', 'another company''s broker');
select pg_temp.si_expect(pg_temp.si_describe('69200000-0000-4000-8000-000000000040', repeat('0', 64),
	'69200000-0000-4000-8000-000000000101', 'sign-in-one'),
	'42501:cloud secret broker authority is unavailable', 'a wrong broker capability');
select pg_temp.si_expect(pg_temp.si_complete('69200000-0000-4000-8000-000000000101', 'sign-in-one',
	'69200000-0000-4000-8000-000000000150', 'envelope-one'::bytea, 'other-kek-1'),
	'22023:model login sign-in completion is invalid', 'a key the broker does not hold');

-- 4. The broker completes the sign-in once; a second login for the same sign-in is refused.
select pg_temp.si_expect(pg_temp.si_complete('69200000-0000-4000-8000-000000000101', 'sign-in-one',
	'69200000-0000-4000-8000-000000000150', 'envelope-one'::bytea), 'completed', 'the broker completes the sign-in');
select pg_temp.si_expect(pg_temp.si_complete('69200000-0000-4000-8000-000000000101', 'sign-in-one',
	'69200000-0000-4000-8000-000000000151', 'envelope-other'::bytea),
	'55000:model login sign-in is already complete', 'a second login for the same sign-in');
reset session authorization;

-- 5. Switched back: a vault sign-in left open cannot complete.
set local role service_role;
select pg_temp.si_expect(pg_temp.si_switch(false), 'false', 'the operator switches the company back');
reset role;
set local session authorization qorpera_secret_broker;
select pg_temp.si_expect(pg_temp.si_complete('69200000-0000-4000-8000-000000000201', 'sign-in-two',
	'69200000-0000-4000-8000-000000000250', 'envelope-two'::bytea),
	'55000:model login sign-in is unavailable', 'a sign-in after the switch back');
reset session authorization;

rollback;
