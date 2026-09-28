-- Vault By Default, part 1 (20260929130000): the shared vault's principal lists the companies it serves and
-- the new companies it should register, and registers a new company: its authority row (the principal's
-- origin and key id, the capability hash the broker derived) and its switch to vault sign-in. A company
-- created before (or at) the principal's start time, a company that has a vault (a retired one too), a repeat
-- with another capability, another company's capability and another principal are refused; a repeat never
-- switches a company back on; the existing broker guard accepts the registered company; registration runs at
-- read committed only.
begin;

create function pg_temp.vbd_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.vbd_call(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	return v_result;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.vbd_expect(text,text,text), pg_temp.vbd_call(text) to qorpera_secret_broker;

-- Companies: one before the principal's start time, one exactly at it, two after, one after that already has
-- its own vault, and one after whose vault was retired.
insert into auth.users(id,email) values ('69700000-0000-4000-8000-000000000001','vault-default-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id,created_at) values
	('69700000-0000-4000-8000-000000000010','Before the shared vault','69700000-0000-4000-8000-000000000001','2099-01-01 00:00:00+00'),
	('69700000-0000-4000-8000-000000000011','New company one','69700000-0000-4000-8000-000000000001','2099-01-02 00:00:00+00'),
	('69700000-0000-4000-8000-000000000012','New company two','69700000-0000-4000-8000-000000000001','2099-01-02 00:00:01+00'),
	('69700000-0000-4000-8000-000000000013','New company with its own vault','69700000-0000-4000-8000-000000000001','2099-01-02 00:00:02+00'),
	('69700000-0000-4000-8000-000000000014','Created at the start time','69700000-0000-4000-8000-000000000001','2099-01-01 12:00:00+00'),
	('69700000-0000-4000-8000-000000000015','New company, vault retired','69700000-0000-4000-8000-000000000001','2099-01-02 00:00:03+00');
insert into public.qorpera_cloud_secret_broker_principals(id,service_origin,key_id,capability_sha256,registers_companies_created_after) values
	('69700000-0000-4000-8000-000000000050','https://vault.qorpera.test','vault-root-1',repeat('a',64),'2099-01-01 12:00:00+00'),
	('69700000-0000-4000-8000-000000000051','https://other-vault.qorpera.test','other-root-1',repeat('b',64),'2099-01-01 12:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256,principal_id,status,retired_at) values
	('69700000-0000-4000-8000-000000000043','69700000-0000-4000-8000-000000000013','https://own.qorpera.test','own-kek-1',repeat('f',64),null,'active',null),
	('69700000-0000-4000-8000-000000000045','69700000-0000-4000-8000-000000000015','https://vault.qorpera.test','vault-root-1',repeat('6',64),
		'69700000-0000-4000-8000-000000000050','retired','2099-01-03 00:00:00+00');

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_broker_principal_companies(uuid,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_register_company_with_broker_principal(uuid,text,uuid,text)','execute') then
			raise exception 'The shared vault''s registration is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_broker_principal(uuid,text)','execute')
			or has_table_privilege(v_role,'public.qorpera_cloud_secret_broker_principals','select,insert,update,delete,truncate') then
			raise exception 'The principal guard or table is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker','public.qorpera_register_company_with_broker_principal(uuid,text,uuid,text)','execute') then
		raise exception 'The broker cannot register companies'; end if;
end $$;

set local session authorization qorpera_secret_broker;
-- 1. The guard: a forged capability.
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_broker_principal_companies(
		'69700000-0000-4000-8000-000000000050', repeat('e',64))::text$q$),
	'42501:cloud secret broker principal is unavailable', 'a forged principal capability');
-- 2. The new companies without a vault are listed; the older one and the one with its own vault are not.
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_broker_principal_companies(
		'69700000-0000-4000-8000-000000000050', repeat('a',64))::text$q$),
	jsonb_build_object('schema','qorpera.broker-principal-companies/v1','keyId','vault-root-1','registered','[]'::jsonb,
		'unregistered',jsonb_build_array('69700000-0000-4000-8000-000000000011','69700000-0000-4000-8000-000000000012'))::text,
	'new companies without a vault are listed to register');
-- 3. Registering: the principal's origin and key id, the derived capability, and the switch to vault sign-in.
select set_config('qorpera_test.vbd_one', pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000011', repeat('1',64))::text$q$), false);
reset session authorization;
select pg_temp.vbd_expect((select jsonb_build_object('origin', authority.service_origin, 'key', authority.key_id,
		'capability', authority.capability_sha256 = repeat('1',64), 'principal', authority.principal_id, 'status', authority.status,
		'answer', current_setting('qorpera_test.vbd_one')::jsonb ->> 'authorityId' = authority.id::text,
		'switched', exists (select 1 from public.qorpera_model_login_sign_in_companies where profile_id = authority.profile_id))::text
	from public.qorpera_cloud_secret_broker_authorities authority where authority.profile_id = '69700000-0000-4000-8000-000000000011'),
	jsonb_build_object('origin','https://vault.qorpera.test','key','vault-root-1','capability',true,
		'principal','69700000-0000-4000-8000-000000000050','status','active','answer',true,'switched',true)::text,
	'the registered company has its authority and takes sign-ins in the vault');
set local session authorization qorpera_secret_broker;
-- 4. A repeat with the same capability (the other copy of the shared vault) answers the same authority, and
-- leaves an operator's switch-off alone.
reset session authorization;
delete from public.qorpera_model_login_sign_in_companies where profile_id = '69700000-0000-4000-8000-000000000011';
set local session authorization qorpera_secret_broker;
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000011', repeat('1',64)) ->> 'authorityId'$q$),
	current_setting('qorpera_test.vbd_one')::jsonb ->> 'authorityId', 'a repeat answers the same authority');
reset session authorization;
select pg_temp.vbd_expect((select count(*)::text from public.qorpera_model_login_sign_in_companies
	where profile_id = '69700000-0000-4000-8000-000000000011'), '0', 'a repeat does not switch the company back on');
set local session authorization qorpera_secret_broker;
-- 5. Refusals: another capability, another principal, an older company (or one created at the start time),
-- a company with its own vault or with a retired one, another company's capability, the principal's own
-- capability for a company.
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000011', repeat('2',64))::text$q$),
	'23505:company already has a vault', 'a repeat with another capability');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000051', repeat('b',64), '69700000-0000-4000-8000-000000000011', repeat('1',64))::text$q$),
	'23505:company already has a vault', 'another principal cannot take a registered company');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000010', repeat('3',64))::text$q$),
	'42501:company is not the shared vault''s to register', 'a company created before the shared vault');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000014', repeat('3',64))::text$q$),
	'42501:company is not the shared vault''s to register', 'a company created at the start time');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000015', repeat('6',64))::text$q$),
	'23505:company already has a vault', 'a company whose vault was retired');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000012', repeat('1',64))::text$q$),
	'22023:company registration capability is taken', 'another company''s capability');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000013', repeat('4',64))::text$q$),
	'23505:company already has a vault', 'a company with its own vault');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000012', repeat('a',64))::text$q$),
	'22023:company registration is invalid', 'the principal''s own capability for a company');
-- 6. The lists after: the registered company is the principal's; the other principal serves none of it.
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_broker_principal_companies(
		'69700000-0000-4000-8000-000000000050', repeat('a',64))::text$q$),
	jsonb_build_object('schema','qorpera.broker-principal-companies/v1','keyId','vault-root-1',
		'registered',jsonb_build_array(jsonb_build_object('companyId','69700000-0000-4000-8000-000000000011',
			'authorityId',current_setting('qorpera_test.vbd_one')::jsonb ->> 'authorityId','keyId','vault-root-1')),
		'unregistered',jsonb_build_array('69700000-0000-4000-8000-000000000012'))::text,
	'the registered company is served; the other waits');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_broker_principal_companies(
		'69700000-0000-4000-8000-000000000051', repeat('b',64)) -> 'registered'$q$),
	'[]', 'another principal serves none of it');
-- 7. Every existing broker call accepts the registered company's own authority and capability.
select pg_temp.vbd_expect(pg_temp.vbd_call(format($q$select public.qorpera_model_login_broker_company(%L::uuid, repeat('1',64))::text$q$,
		current_setting('qorpera_test.vbd_one')::jsonb ->> 'authorityId')),
	'69700000-0000-4000-8000-000000000011', 'the existing broker guard serves the registered company');
reset session authorization;

-- 8. A retired principal registers nothing.
update public.qorpera_cloud_secret_broker_principals set status = 'retired', retired_at = clock_timestamp()
where id = '69700000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_register_company_with_broker_principal(
		'69700000-0000-4000-8000-000000000050', repeat('a',64), '69700000-0000-4000-8000-000000000012', repeat('5',64))::text$q$),
	'42501:cloud secret broker principal is unavailable', 'a retired principal');
select pg_temp.vbd_expect(pg_temp.vbd_call($q$select public.qorpera_broker_principal_companies(
		'69700000-0000-4000-8000-000000000050', repeat('a',64))::text$q$),
	'42501:cloud secret broker principal is unavailable', 'a retired principal lists nothing');
reset session authorization;

rollback;

-- 9. Registration runs at read committed only: its race handling re-reads the other copy's committed row.
begin isolation level repeatable read;
set local session authorization qorpera_secret_broker;
do $$
begin
	perform public.qorpera_register_company_with_broker_principal('69700000-0000-4000-8000-000000000050', repeat('a',64),
		'69700000-0000-4000-8000-000000000012', repeat('7',64));
	raise exception 'registration ran outside read committed';
exception when sqlstate '25000' then null;
end $$;
rollback;
