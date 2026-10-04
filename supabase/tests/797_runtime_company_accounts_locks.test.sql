-- @fixture 602_runtime_coding_lock_order.test.sql until "-- END COMMITTED FIXTURE"
-- Company accounts, A1-1: who waits for an account's rows. A second connection holds a row while a real call
-- runs (602's committed fixture and connections; this test's rows go with its cleanup at the end).
-- 1. A member the removal refuses (a contributor, someone outside the company) is refused at once while the
--    account's secret, or the company row (as an agent call's lease holds it), is held; the owner waits for the
--    secret, then removes.
-- 2. The broker's call for another company's account (its secret or its account row held), or for another kind
--    of secret, is refused without locking it: no wait while that row is held.
-- 3. A removal and the broker's use of the same account meet without a deadlock: the removal takes the
--    company row's key share before the vault rows, so the broker's lease (company row FOR UPDATE) waits for
--    the removal instead of holding the company row while it waits for the secret the removal holds.

-- The settings row was there before the fixture: the cleanup puts it back as it was.
insert into pg_temp.lock_order_rows
select 'public.qorpera_company_account_settings', to_jsonb(settings) from public.qorpera_company_account_settings settings;
update public.qorpera_company_account_settings set enabled = true;

insert into auth.users(id,email) values
	('79700000-0000-4000-8000-000000000001','accounts-locks-outsider@example.test'),
	('79700000-0000-4000-8000-000000000002','accounts-locks-contributor@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30000000-0000-4000-8000-000000000010','79700000-0000-4000-8000-000000000002',
	'accounts-locks-contributor@example.test','Contributor','contributor');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('79700000-0000-4000-8000-000000000010','Other company','79700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('79700000-0000-4000-8000-000000000010','79700000-0000-4000-8000-000000000001',
	'accounts-locks-outsider@example.test','Other owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('79700000-0000-4000-8000-000000000020','79700000-0000-4000-8000-000000000010','Environment',1,
	'79700000-0000-4000-8000-000000000001');
-- The run's company keeps its broker authority if the fixture has one; the other company gets its own.
do $$
begin
	if not exists (select 1 from public.qorpera_cloud_secret_broker_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010') then
		insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
		values ('79700000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000010',
			'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64));
	end if;
end $$;
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('79700000-0000-4000-8000-000000000041','79700000-0000-4000-8000-000000000010',
	'https://company41-node-01.tailbb15c7.ts.net:10000','other-kek-1',repeat('e',64));
select set_config('qorpera_test.cl_' || name, value, false)
from public.qorpera_cloud_secret_broker_authorities authority,
	lateral (values ('authority', authority.id::text), ('capability', authority.capability_sha256),
		('key', authority.key_id)) as setting(name, value)
where authority.profile_id = '30000000-0000-4000-8000-000000000010';

-- Accounts: two of the run's company (one each for races 1 and 3), the other company's, and a Gmail secret.
create function pg_temp.cl_account(p_id uuid, p_profile uuid, p_environment uuid, p_authority uuid, p_key text,
	p_connector text, p_login text, p_by uuid) returns void language plpgsql as $$
begin
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
		connector_id,secret_name,purpose,current_version,created_by_user_id)
	values (p_id,p_profile,p_environment,p_authority,'company',null,p_connector,
		case p_connector when 'website' then 'site-' || right(p_id::text,8) else 'primary' end,'Account',1,p_by);
	insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
		envelope_sha256,created_by_user_id)
	values (p_id,1,p_authority,p_key,'\x0102'::bytea,encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),p_by);
	if p_connector = 'website' then
		insert into public.qorpera_company_accounts(secret_id,profile_id,environment_id,site,login,opened_by_user_id)
		values (p_id,p_profile,p_environment,'vercel.com',p_login,p_by);
	end if;
end
$$;
select pg_temp.cl_account(account.id,'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.cl_authority')::uuid,current_setting('qorpera_test.cl_key'),account.connector,
	account.login,'30000000-0000-4000-8000-000000000001')
from (values ('79700000-0000-4000-8000-000000000050'::uuid,'website','race-one@nordlys.example'),
	('79700000-0000-4000-8000-000000000051'::uuid,'website','race-three@nordlys.example'),
	('79700000-0000-4000-8000-000000000053'::uuid,'gmail','')) as account(id,connector,login);
select pg_temp.cl_account('79700000-0000-4000-8000-000000000052','79700000-0000-4000-8000-000000000010',
	'79700000-0000-4000-8000-000000000020','79700000-0000-4000-8000-000000000041','other-kek-1','website',
	'team@other.example','79700000-0000-4000-8000-000000000001');

-- The run's tool call begins (committed, so the other connections see it) and finishes its receipt.
create function pg_temp.cl_receipt(p_id uuid, p_key text) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		p_id,p_key,repeat('a',64),repeat('b',64),false);
end
$$;
create function pg_temp.cl_done(p_id uuid) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		p_id,repeat('a',64),'{}'::jsonb);
end
$$;
-- A connection acts as a member (PostgREST's role and claims) or as the broker's own login.
create function pg_temp.cl_as(p_connection text, p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec(p_connection, 'reset session authorization');
	perform dblink_exec(p_connection, 'reset role');
	if p_claims is null then
		perform dblink_exec(p_connection, 'set session authorization qorpera_secret_broker');
	else
		perform pg_temp.lock_as(p_connection, p_claims);
	end if;
end
$$;
create function pg_temp.cl_use(p_receipt uuid, p_account uuid) returns text language sql as $$
	select format('select public.qorpera_use_company_account(%L,%L,%L::jsonb,%L,repeat(''a'',64),repeat(''b'',64),%L)',
		current_setting('qorpera_test.cl_authority'),current_setting('qorpera_test.cl_capability'),
		current_setting('qorpera_test.parent_binding'),p_receipt,p_account)
$$;
create function pg_temp.cl_remove(p_account uuid) returns text language sql as $$
	select format('select public.qorpera_remove_company_account(''30000000-0000-4000-8000-000000000010'',%L)', p_account)
$$;
-- The holder locks one row while a single call runs: the call's result or error, and whether it waited.
create function pg_temp.cl_single(p_hold text, p_call text, p_claims jsonb) returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_waited boolean := false; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.cl_as('lock_first', p_claims);
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then v_waited := true; exit; end if;
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := pg_temp.lock_collect('lock_first') || jsonb_build_object('waited', v_waited);
	perform pg_temp.cl_as('lock_first', '{"role":"service_role"}');
	return v_outcome;
end
$$;
create function pg_temp.cl_check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if not p_ok then raise exception '%', p_message; end if;
end
$$;

-- 1. The removal refuses a contributor and an outsider without waiting for the held secret; the owner waits, then removes.
select pg_temp.cl_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '42501'
		and outcome ->> 'error' = 'company account removal is unavailable',
	'A caller the removal refuses waited for the account or was not refused: ' || who || ' ' || outcome::text)
from (values ('contributor','{"role":"authenticated","sub":"79700000-0000-4000-8000-000000000002"}'::jsonb),
	('outsider','{"role":"authenticated","sub":"79700000-0000-4000-8000-000000000001"}'::jsonb)) as caller(who, claims),
	lateral (select pg_temp.cl_single(pg_temp.lock_row('qorpera_cloud_secrets','id','79700000-0000-4000-8000-000000000050'),
		pg_temp.cl_remove('79700000-0000-4000-8000-000000000050'), caller.claims) as outcome) as call;
select pg_temp.cl_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '42501'
		and outcome ->> 'error' = 'company account removal is unavailable',
	'A caller the removal refuses waited for the company row or was not refused: ' || who || ' ' || outcome::text)
from (values ('contributor','{"role":"authenticated","sub":"79700000-0000-4000-8000-000000000002"}'::jsonb),
	('outsider','{"role":"authenticated","sub":"79700000-0000-4000-8000-000000000001"}'::jsonb)) as caller(who, claims),
	lateral (select pg_temp.cl_single(pg_temp.lock_row('qorpera_profiles','id','30000000-0000-4000-8000-000000000010'),
		pg_temp.cl_remove('79700000-0000-4000-8000-000000000050'), caller.claims) as outcome) as call;
select pg_temp.cl_check(outcome ->> 'waited' = 'true' and outcome #>> '{result,removed}' = 'true',
	'The owner did not wait for the held account, or did not remove it: ' || outcome::text)
from (select pg_temp.cl_single(pg_temp.lock_row('qorpera_cloud_secrets','id','79700000-0000-4000-8000-000000000050'),
	pg_temp.cl_remove('79700000-0000-4000-8000-000000000050'),
	'{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}') as outcome) as call;

-- 2. The broker's call for another company's account, or a Gmail secret, locks neither: no wait while each is held.
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000101','company_account:use:79700000-0000-4000-8000-000000000052:r1');
select pg_temp.cl_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '22023'
		and outcome ->> 'error' = 'The company has no such open account',
	'The broker waited for another company''s account, or used it: ' || outcome::text)
from (select pg_temp.cl_single(pg_temp.lock_row('qorpera_cloud_secrets','id','79700000-0000-4000-8000-000000000052'),
	pg_temp.cl_use('79700000-0000-4000-8000-000000000101','79700000-0000-4000-8000-000000000052'), null) as outcome) as call;
select pg_temp.cl_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '22023'
		and outcome ->> 'error' = 'The company has no such open account',
	'The broker waited for another company''s account row, or used it: ' || outcome::text)
from (select pg_temp.cl_single(pg_temp.lock_row('qorpera_company_accounts','secret_id','79700000-0000-4000-8000-000000000052'),
	pg_temp.cl_use('79700000-0000-4000-8000-000000000101','79700000-0000-4000-8000-000000000052'), null) as outcome) as call;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000101');
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000102','company_account:use:79700000-0000-4000-8000-000000000053:r2');
select pg_temp.cl_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '22023',
	'The broker waited for a Gmail secret, or used it: ' || outcome::text)
from (select pg_temp.cl_single(pg_temp.lock_row('qorpera_cloud_secrets','id','79700000-0000-4000-8000-000000000053'),
	pg_temp.cl_use('79700000-0000-4000-8000-000000000102','79700000-0000-4000-8000-000000000053'), null) as outcome) as call;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000102');

-- 3. A removal and the broker's use of one account. The holder keeps the account row; the removal (company key
--    share, member, secret) waits for it; the broker's call then waits too (its lease takes the company row FOR
--    UPDATE). The holder lets go: the removal lands, and the use is refused because the account is gone. Neither
--    is killed as a deadlock.
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000103','company_account:use:79700000-0000-4000-8000-000000000051:r3');
do $$
declare v_name text; v_pid integer; v_outcome jsonb := '{}'::jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder',
		pg_temp.lock_row('qorpera_company_accounts','secret_id','79700000-0000-4000-8000-000000000051')) as held(held integer);
	perform pg_temp.cl_as('lock_first', '{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}');
	perform dblink_send_query('lock_first', pg_temp.cl_remove('79700000-0000-4000-8000-000000000051'));
	perform pg_temp.cl_as('lock_second', null);
	foreach v_name in array array['first','second'] loop
		if v_name = 'second' then
			perform dblink_send_query('lock_second',
				pg_temp.cl_use('79700000-0000-4000-8000-000000000103','79700000-0000-4000-8000-000000000051'));
		end if;
		v_pid := current_setting('qorpera_test.lock_' || v_name || '_pid')::integer;
		for attempt in 1..200 loop
			exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_' || v_name) = 0;
			perform pg_sleep(0.025);
		end loop;
		if cardinality(pg_blocking_pids(v_pid)) = 0 then
			perform dblink_exec('lock_holder', 'rollback');
			raise exception 'Race 3: the % call did not wait: % / %', v_name, pg_temp.lock_collect('lock_first'),
				pg_temp.lock_collect('lock_second');
		end if;
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := jsonb_build_object('removal', pg_temp.lock_collect('lock_first'), 'use', pg_temp.lock_collect('lock_second'));
	perform pg_temp.cl_as('lock_first', '{"role":"service_role"}');
	perform pg_temp.cl_as('lock_second', '{"role":"service_role"}');
	if v_outcome #>> '{removal,result,removed}' is distinct from 'true'
		or v_outcome #>> '{use,state}' is distinct from '22023'
		or v_outcome #>> '{use,error}' is distinct from 'The company has no such open account' then
		raise exception 'A removal and a use of one account did not both land: %', v_outcome;
	end if;
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000103');

select pg_temp.cl_check(not exists (select 1 from public.qorpera_cloud_secret_versions where secret_id in
		('79700000-0000-4000-8000-000000000050','79700000-0000-4000-8000-000000000051'))
	and (select count(*) from public.qorpera_company_accounts where status = 'closed'
		and secret_id in ('79700000-0000-4000-8000-000000000050','79700000-0000-4000-8000-000000000051')) = 2,
	'The removed accounts kept envelopes or stayed open');

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
