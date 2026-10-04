-- @fixture 602_runtime_coding_lock_order.test.sql until "-- END COMMITTED FIXTURE"
-- 20260928419980: a change to a vault row takes the company row's key share first. A connector tool call's lease
-- locks the company row FOR UPDATE and then share-locks its grant and secret; a member's Disconnect, grant, grant
-- withdrawal, share with agents or rotation start, and the broker's rotation seal, took the secret (or grant, or
-- ticket) first and the company row only at their first insert's foreign key. Here a second connection holds a row
-- while real calls run (602's committed fixture and connections; this test's rows go with its cleanup at the end).
-- 1. A caller a function refuses is refused at once while the company row is held FOR UPDATE, as an agent call's
--    lease holds it, with the error it got before: someone outside the company and a contributor, for each function,
--    the company's owner for a member's own connection and its grant, a call for a grant or a secret nobody has, and
--    another company's broker sealing this company's capture ticket.
-- 2. An admin who passes the plain checks and loses the role while the call waits for the company row is still
--    refused (the Disconnect, a grant, a grant's withdrawal, the share): the membership is read again, FOR SHARE,
--    after the key share.
-- 3. The owner waits for the held company row, then lands.
-- 4. An agent call first, as in production: the holder keeps the run's compute identity, which the lease locks right
--    after the company row, so the call holds the company row and waits. Each change to the call's secret or grant
--    (a grant, the share with agents, a rotation's start and the broker's seal, the grant's withdrawal, the
--    Disconnect) then waits for the company row; the holder lets go; the call is authorized and the change lands.
--    On the previous function text each of these races ended in "deadlock detected".
-- 5. A Disconnect first: the holder keeps the secret, the Disconnect waits for it holding the company row's key
--    share, and the agent call's lease waits for the company row. The holder lets go: the Disconnect lands and the
--    call is refused for its revoked grant.

insert into auth.users(id,email) values
	('80000000-0000-4000-8000-000000000001','secret-locks-outsider@example.test'),
	('80000000-0000-4000-8000-000000000003','secret-locks-admin@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30000000-0000-4000-8000-000000000010','80000000-0000-4000-8000-000000000003',
	'secret-locks-admin@example.test','Admin','admin');
-- The run's company keeps its broker authority if the fixture has one.
do $$
begin
	if not exists (select 1 from public.qorpera_cloud_secret_broker_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010') then
		insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
		values ('80000000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000010',
			'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64));
	end if;
end $$;
-- Another company and its own broker.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('80000000-0000-4000-8000-000000000010','Other company','80000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('80000000-0000-4000-8000-000000000041','80000000-0000-4000-8000-000000000010',
	'https://company41-node-01.tailbb15c7.ts.net:10000','other-kek-1',repeat('e',64));
select set_config('qorpera_test.cs_' || name, value, false)
from public.qorpera_cloud_secret_broker_authorities authority,
	lateral (values ('authority', authority.id::text), ('capability', authority.capability_sha256),
		('key', authority.key_id)) as setting(name, value)
where authority.profile_id = '30000000-0000-4000-8000-000000000010';

-- Four company Gmail connections, sealed by the company's broker: one each for the single calls of sections 1 and 2
-- (051 the Disconnect, 054 the grants, share and rotation), 052 for section 3's races, 053 for section 4's.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
select secret.id,'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.cs_authority')::uuid,'company',null,'gmail',secret.name,'Gmail account',1,
	'30000000-0000-4000-8000-000000000001'
from (values ('80000000-0000-4000-8000-000000000051'::uuid,'single-revoke'),
	('80000000-0000-4000-8000-000000000052'::uuid,'primary'),
	('80000000-0000-4000-8000-000000000053'::uuid,'revoke-first'),
	('80000000-0000-4000-8000-000000000054'::uuid,'single-grants')) as secret(id,name);
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,created_by_user_id)
select secret.id,1,secret.broker_authority_id,current_setting('qorpera_test.cs_key'),'\x0102'::bytea,
	encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),secret.created_by_user_id
from public.qorpera_cloud_secrets secret where secret.id::text like '80000000-0000-4000-8000-0000000000%';
-- Grants the owner gave: the run's agent (030) on 052 (two operations) and 053; agent 031 on 054.
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select grant_row.id,'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',grant_row.secret_id,
	grant_row.agent,operation.connector_id,operation.operation_id,operation.version,operation.tool_name,
	'30000000-0000-4000-8000-000000000001'
from (values ('80000000-0000-4000-8000-000000000062'::uuid,'80000000-0000-4000-8000-000000000052'::uuid,
		'30000000-0000-4000-8000-000000000030'::uuid,'search_messages'),
	('80000000-0000-4000-8000-000000000063'::uuid,'80000000-0000-4000-8000-000000000052'::uuid,
		'30000000-0000-4000-8000-000000000030'::uuid,'read_thread'),
	('80000000-0000-4000-8000-000000000064'::uuid,'80000000-0000-4000-8000-000000000053'::uuid,
		'30000000-0000-4000-8000-000000000030'::uuid,'get_profile'),
	('80000000-0000-4000-8000-000000000065'::uuid,'80000000-0000-4000-8000-000000000054'::uuid,
		'30000000-0000-4000-8000-000000000031'::uuid,'search_messages')) as grant_row(id,secret_id,agent,operation_id)
join public.qorpera_cloud_connector_operations operation on operation.connector_id = 'gmail'
	and operation.operation_id = grant_row.operation_id and operation.status = 'active';
-- The contributor's own Gmail connection (055) and their grant of it to the run's agent (066), for section 1.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('80000000-0000-4000-8000-000000000055','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.cs_authority')::uuid,'member','30000000-0000-4000-8000-000000000002','gmail','member-own',
	'Gmail account',1,'30000000-0000-4000-8000-000000000002');
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,created_by_user_id)
values ('80000000-0000-4000-8000-000000000055',1,current_setting('qorpera_test.cs_authority')::uuid,
	current_setting('qorpera_test.cs_key'),'\x0102'::bytea,encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),
	'30000000-0000-4000-8000-000000000002');
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '80000000-0000-4000-8000-000000000066','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	'80000000-0000-4000-8000-000000000055','30000000-0000-4000-8000-000000000030',operation.connector_id,
	operation.operation_id,operation.version,operation.tool_name,'30000000-0000-4000-8000-000000000002'
from public.qorpera_cloud_connector_operations operation
where operation.connector_id = 'gmail' and operation.operation_id = 'delete_draft' and operation.status = 'active';
-- The owner starts capturing a new connection: a pending ticket of the company's broker.
do $$
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform set_config('qorpera_test.cs_ticket', public.qorpera_begin_cloud_secret_capture('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020','company',null,'gmail','other-broker','Gmail account') ->> 'ticketId', false);
end $$;

-- The run's tool call begins its receipt (committed, so the other connections see it) and finishes it afterwards.
create function pg_temp.cs_receipt(p_id uuid, p_grant uuid) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		p_id,(select grant_row.tool_name || ':' || grant_row.id || ':' || right(p_id::text,4)
			from public.qorpera_cloud_secret_operation_grants grant_row where grant_row.id = p_grant),
		repeat('a',64),repeat('b',64),false);
end
$$;
create function pg_temp.cs_done(p_id uuid) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,
		p_id,repeat('a',64),'{}'::jsonb);
end
$$;
-- A connection acts as a member (PostgREST's role and claims) or, without claims, as the broker's own login.
create function pg_temp.cs_as(p_connection text, p_claims jsonb) returns void language plpgsql as $$
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
create function pg_temp.cs_member(p_user text) returns jsonb language sql as $$
	select jsonb_build_object('role','authenticated','sub',p_user)
$$;
-- The calls. The broker's authorization of the run's tool call with one grant (the operation as the grant names it).
create function pg_temp.cs_authorize(p_receipt uuid, p_grant uuid) returns text language sql as $$
	select format('select public.qorpera_authorize_cloud_secret_operation(%L,%L,%L::jsonb,%L,repeat(''a'',64),repeat(''b'',64),%L,%L,%L,%s,%L,%L)',
		current_setting('qorpera_test.cs_authority'),current_setting('qorpera_test.cs_capability'),
		current_setting('qorpera_test.parent_binding'),p_receipt,p_grant,operation.connector_id,operation.operation_id,
		operation.version,operation.adapter_sha256,operation.destination_origin)
	from public.qorpera_cloud_secret_operation_grants grant_row
	join public.qorpera_cloud_connector_operations operation on operation.connector_id = grant_row.connector_id
		and operation.operation_id = grant_row.operation_id and operation.version = grant_row.operation_version
	where grant_row.id = p_grant
$$;
create function pg_temp.cs_revoke(p_secret uuid) returns text language sql as $$
	select format('select public.qorpera_revoke_cloud_secret(''30000000-0000-4000-8000-000000000010'',%L)', p_secret)
$$;
create function pg_temp.cs_grant(p_secret uuid, p_agent uuid, p_operation text) returns text language sql as $$
	select format('select public.qorpera_grant_cloud_secret_operation(''30000000-0000-4000-8000-000000000010'',''30000000-0000-4000-8000-000000000020'',%L,%L,''gmail'',%L,1,null)',
		p_secret, p_agent, p_operation)
$$;
create function pg_temp.cs_revoke_grant(p_grant uuid) returns text language sql as $$
	select format('select public.qorpera_revoke_cloud_secret_grant(''30000000-0000-4000-8000-000000000010'',%L)', p_grant)
$$;
create function pg_temp.cs_share(p_secret uuid, p_agent uuid) returns text language sql as $$
	select format('select public.qorpera_grant_cloud_connector(''30000000-0000-4000-8000-000000000010'',''30000000-0000-4000-8000-000000000020'',%L,array[%L]::uuid[])',
		p_secret, p_agent)
$$;
create function pg_temp.cs_rotate(p_secret uuid, p_name text) returns text language sql as $$
	select format('select public.qorpera_begin_cloud_secret_capture(''30000000-0000-4000-8000-000000000010'',''30000000-0000-4000-8000-000000000020'',''company'',null,''gmail'',%L,''Gmail account'',%L)',
		p_name, p_secret)
$$;
create function pg_temp.cs_seal(p_capture jsonb) returns text language sql as $$
	select format('select public.qorpera_complete_cloud_secret_capture(%L,%L,%L,%L,%L,%L,null)',
		current_setting('qorpera_test.cs_authority'),current_setting('qorpera_test.cs_capability'),p_capture ->> 'ticketId',
		encode(extensions.digest(p_capture ->> 'captureCapability','sha256'),'hex'),encode('\x0304'::bytea,'base64'),
		encode(extensions.digest('\x0304'::bytea,'sha256'),'hex'))
$$;
-- The holder locks one row while a single call runs: the call's result or error, and whether it waited. With
-- p_demote, the holder makes that member a contributor while the call waits, and commits.
create function pg_temp.cs_single(p_hold text, p_call text, p_claims jsonb, p_demote uuid default null)
returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_waited boolean := false; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.cs_as('lock_first', p_claims);
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then v_waited := true; exit; end if;
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	-- A call still running that never waited proves nothing either way.
	if not v_waited and dblink_is_busy('lock_first') = 1 then
		perform dblink_exec('lock_holder', 'rollback');
		raise exception 'Lock check: the call neither waited nor finished: %', pg_temp.lock_collect('lock_first');
	end if;
	if p_demote is not null and v_waited then
		perform dblink_exec('lock_holder', format('update public.qorpera_profile_members set role = ''contributor''
			where profile_id = ''30000000-0000-4000-8000-000000000010'' and user_id = %L', p_demote));
		perform dblink_exec('lock_holder', 'commit');
	else
		perform dblink_exec('lock_holder', 'rollback');
	end if;
	v_outcome := pg_temp.lock_collect('lock_first') || jsonb_build_object('waited', v_waited);
	perform pg_temp.cs_as('lock_first', '{"role":"service_role"}');
	return v_outcome;
end
$$;
-- The holder locks one row; the first call starts and must wait, then the second, which must wait too; the holder
-- lets go. Each call's result or error.
create function pg_temp.cs_race(p_hold text, p_first text, p_first_claims jsonb, p_second text, p_second_claims jsonb)
returns jsonb language plpgsql as $$
declare v_name text; v_pid integer; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	foreach v_name in array array['first','second'] loop
		perform pg_temp.cs_as('lock_' || v_name, case v_name when 'first' then p_first_claims else p_second_claims end);
		perform dblink_send_query('lock_' || v_name, case v_name when 'first' then p_first else p_second end);
		v_pid := current_setting('qorpera_test.lock_' || v_name || '_pid')::integer;
		for attempt in 1..200 loop
			exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_' || v_name) = 0;
			perform pg_sleep(0.025);
		end loop;
		if cardinality(pg_blocking_pids(v_pid)) = 0 then
			perform dblink_exec('lock_holder', 'rollback');
			v_outcome := jsonb_build_object('first', pg_temp.lock_collect('lock_first'));
			if v_name = 'second' then v_outcome := v_outcome || jsonb_build_object('second', pg_temp.lock_collect('lock_second')); end if;
			raise exception 'Lock race: the % call did not wait: %', v_name, v_outcome;
		end if;
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := jsonb_build_object('first', pg_temp.lock_collect('lock_first'), 'second', pg_temp.lock_collect('lock_second'));
	perform pg_temp.cs_as('lock_first', '{"role":"service_role"}');
	perform pg_temp.cs_as('lock_second', '{"role":"service_role"}');
	return v_outcome;
end
$$;
create function pg_temp.cs_check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception '%', p_message; end if;
end
$$;
create function pg_temp.cs_company() returns text language sql as $$
	select pg_temp.lock_row('qorpera_profiles','id','30000000-0000-4000-8000-000000000010')
$$;

-- 1. Refused at once while the company row is held: someone outside the company and a contributor, for each
--    function; the owner for a member's own connection and its grant; a grant nobody has, and a secret nobody has
--    for the share and the rotation.
select pg_temp.cs_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = state and outcome ->> 'error' = error,
	format('%s waited for the company row or was not refused as before: %s', who, outcome))
from (values
	('outsider Disconnect', pg_temp.cs_revoke('80000000-0000-4000-8000-000000000051'), '80000000-0000-4000-8000-000000000001',
		'42501', 'secret revocation is unavailable'),
	('contributor Disconnect', pg_temp.cs_revoke('80000000-0000-4000-8000-000000000051'), '30000000-0000-4000-8000-000000000002',
		'42501', 'secret revocation is unavailable'),
	('outsider grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031','read_message'),
		'80000000-0000-4000-8000-000000000001', '42501', 'secret grant authority is unavailable'),
	('contributor grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031','read_message'),
		'30000000-0000-4000-8000-000000000002', '42501', 'secret grant authority is unavailable'),
	('outsider grant withdrawal', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000065'),
		'80000000-0000-4000-8000-000000000001', '42501', 'secret grant revocation is unavailable'),
	('contributor grant withdrawal', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000065'),
		'30000000-0000-4000-8000-000000000002', '42501', 'secret grant revocation is unavailable'),
	('owner withdrawal of a grant nobody has', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000069'),
		'30000000-0000-4000-8000-000000000001', '42501', 'secret grant revocation is unavailable'),
	('owner Disconnect of a member''s own connection', pg_temp.cs_revoke('80000000-0000-4000-8000-000000000055'),
		'30000000-0000-4000-8000-000000000001', '42501', 'secret revocation is unavailable'),
	('owner withdrawal of a grant of a member''s own connection', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000066'),
		'30000000-0000-4000-8000-000000000001', '42501', 'secret grant revocation is unavailable'),
	('outsider share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031'),
		'80000000-0000-4000-8000-000000000001', '42501', 'secret grant authority is unavailable'),
	('contributor share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031'),
		'30000000-0000-4000-8000-000000000002', '42501', 'secret grant authority is unavailable'),
	('owner share of a secret nobody has', pg_temp.cs_share('80000000-0000-4000-8000-000000000059','30000000-0000-4000-8000-000000000031'),
		'30000000-0000-4000-8000-000000000001', 'P0002', 'query returned no rows'),
	('outsider rotation', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000054','single-grants'),
		'80000000-0000-4000-8000-000000000001', '42501', 'secret capture requires company write access'),
	('contributor rotation', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000054','single-grants'),
		'30000000-0000-4000-8000-000000000002', '22023', 'secret capture scope is invalid'),
	('owner rotation of a secret nobody has', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000059','single-grants'),
		'30000000-0000-4000-8000-000000000001', 'P0002', 'query returned no rows')
) as caller(who, call, user_id, state, error),
	lateral (select pg_temp.cs_single(pg_temp.cs_company(), caller.call, pg_temp.cs_member(caller.user_id)) as outcome) as single;
-- Another company's broker sealing this company's ticket takes no lock on this company's row.
select pg_temp.cs_check(outcome ->> 'waited' = 'false' and outcome ->> 'state' = '42501'
		and outcome ->> 'error' = 'cloud secret capture is unavailable',
	'Another company''s broker waited for the company row or was not refused: ' || outcome::text)
from (select pg_temp.cs_single(pg_temp.cs_company(),
	format('select public.qorpera_complete_cloud_secret_capture(''80000000-0000-4000-8000-000000000041'',%L,%L,%L,%L,%L,null)',
		repeat('e',64), current_setting('qorpera_test.cs_ticket'), repeat('0',64), encode('\x0506'::bytea,'base64'),
		encode(extensions.digest('\x0506'::bytea,'sha256'),'hex')), null) as outcome) as single;

-- 2. An admin who loses the role while the call waits for the company row is refused after it (the holder makes
--    them a contributor and commits); they are an admin again before the next call.
do $$
declare v_who text; v_call text; v_error text; v_outcome jsonb;
begin
	for v_who, v_call, v_error in values
		('Disconnect', pg_temp.cs_revoke('80000000-0000-4000-8000-000000000051'), 'secret revocation is unavailable'),
		('grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031','read_message'),
			'secret grant authority is unavailable'),
		('grant withdrawal', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000065'),
			'secret grant revocation is unavailable'),
		('share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031'),
			'secret grant authority is unavailable')
	loop
		v_outcome := pg_temp.cs_single(pg_temp.cs_company(), v_call, pg_temp.cs_member('80000000-0000-4000-8000-000000000003'),
			'80000000-0000-4000-8000-000000000003');
		perform pg_temp.cs_check(v_outcome ->> 'waited' = 'true' and v_outcome ->> 'state' = '42501'
				and v_outcome ->> 'error' = v_error,
			format('%s: an admin who lost the role while waiting was not refused: %s', v_who, v_outcome));
		perform dblink_exec('lock_holder', 'update public.qorpera_profile_members set role = ''admin''
			where profile_id = ''30000000-0000-4000-8000-000000000010'' and user_id = ''80000000-0000-4000-8000-000000000003''');
	end loop;
end $$;

-- 3. The owner waits for the held company row, then lands: the Disconnect, a grant, a grant's withdrawal, the share
--    with agents and a rotation's start.
select pg_temp.cs_check(outcome ->> 'waited' = 'true' and outcome -> 'result' ->> landed is not null,
	format('The owner''s %s did not wait for the company row, or did not land: %s', who, outcome))
from (values
	('Disconnect', pg_temp.cs_revoke('80000000-0000-4000-8000-000000000051'), 'status'),
	('grant', pg_temp.cs_grant('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031','read_message'),
		'grantId'),
	('grant withdrawal', pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000065'), 'status'),
	('share', pg_temp.cs_share('80000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000031'), 'grantsIssued'),
	('rotation', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000054','single-grants'), 'ticketId')
) as caller(who, call, landed),
	lateral (select pg_temp.cs_single(pg_temp.cs_company(), caller.call,
		pg_temp.cs_member('30000000-0000-4000-8000-000000000001')) as outcome) as single;
select pg_temp.cs_check((select status from public.qorpera_cloud_secrets where id = '80000000-0000-4000-8000-000000000051') = 'revoked'
	and (select status from public.qorpera_cloud_secret_operation_grants where id = '80000000-0000-4000-8000-000000000065') = 'revoked'
	and (select count(*) from public.qorpera_cloud_secret_operation_grants where secret_id = '80000000-0000-4000-8000-000000000054'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' and status = 'active') = 9,
	'The owner''s calls did not leave the Disconnect, the withdrawal and nine grants of the shared connection');

-- 4. The agent call first. The holder keeps the run's compute identity; the broker's authorization of the run's tool
--    call takes the company row (its lease's fence) and waits there; the owner's change to the call's secret or
--    grant waits for the company row. The holder lets go: the call is authorized, then the change lands.
create function pg_temp.cs_call_first(p_receipt uuid, p_grant uuid, p_change text, p_change_claims jsonb, p_who text)
returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.cs_race(pg_temp.lock_row('qorpera_member_compute_identities','id',
			(current_setting('qorpera_test.parent_binding')::jsonb ->> 'computeIdentityId')::uuid),
		pg_temp.cs_authorize(p_receipt, p_grant), null, p_change, p_change_claims);
	perform pg_temp.cs_check(v_outcome #>> '{first,result,schema}' = 'qorpera.cloud-secret-operation-authorization/v1'
			and v_outcome #> '{second,result}' is not null,
		format('An agent call and the %s did not both land: %s', p_who, v_outcome));
	return v_outcome -> 'second' -> 'result';
end
$$;
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000101','80000000-0000-4000-8000-000000000062');
select pg_temp.cs_call_first('80000000-0000-4000-8000-000000000101','80000000-0000-4000-8000-000000000062',
	pg_temp.cs_grant('80000000-0000-4000-8000-000000000052','30000000-0000-4000-8000-000000000032','read_message'),
	pg_temp.cs_member('30000000-0000-4000-8000-000000000001'), 'grant of one operation');
select pg_temp.cs_done('80000000-0000-4000-8000-000000000101');
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000102','80000000-0000-4000-8000-000000000062');
select pg_temp.cs_check((result ->> 'grantsIssued')::integer = 8, 'The share issued other grants than eight: ' || result::text)
from (select pg_temp.cs_call_first('80000000-0000-4000-8000-000000000102','80000000-0000-4000-8000-000000000062',
	pg_temp.cs_share('80000000-0000-4000-8000-000000000052','30000000-0000-4000-8000-000000000032'),
	pg_temp.cs_member('30000000-0000-4000-8000-000000000001'), 'share with an agent') as result) as share;
select pg_temp.cs_done('80000000-0000-4000-8000-000000000102');
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000103','80000000-0000-4000-8000-000000000062');
select set_config('qorpera_test.cs_capture', pg_temp.cs_call_first('80000000-0000-4000-8000-000000000103',
	'80000000-0000-4000-8000-000000000062', pg_temp.cs_rotate('80000000-0000-4000-8000-000000000052','primary'),
	pg_temp.cs_member('30000000-0000-4000-8000-000000000001'), 'rotation''s start')::text, false);
select pg_temp.cs_done('80000000-0000-4000-8000-000000000103');
-- The broker seals that rotation (version 2) while the next call holds the company row.
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000104','80000000-0000-4000-8000-000000000062');
select pg_temp.cs_check((result ->> 'version')::integer = 2, 'The rotation was not sealed as version 2: ' || result::text)
from (select pg_temp.cs_call_first('80000000-0000-4000-8000-000000000104','80000000-0000-4000-8000-000000000062',
	pg_temp.cs_seal(current_setting('qorpera_test.cs_capture')::jsonb), null, 'rotation''s seal') as result) as seal;
select pg_temp.cs_done('80000000-0000-4000-8000-000000000104');
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000105','80000000-0000-4000-8000-000000000062');
select pg_temp.cs_check(result ->> 'status' = 'revoked', 'The call''s grant was not withdrawn: ' || result::text)
from (select pg_temp.cs_call_first('80000000-0000-4000-8000-000000000105','80000000-0000-4000-8000-000000000062',
	pg_temp.cs_revoke_grant('80000000-0000-4000-8000-000000000062'),
	pg_temp.cs_member('30000000-0000-4000-8000-000000000001'), 'withdrawal of its grant') as result) as withdrawal;
select pg_temp.cs_done('80000000-0000-4000-8000-000000000105');
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000106','80000000-0000-4000-8000-000000000063');
select pg_temp.cs_check(result ->> 'status' = 'revoked', 'The call''s connection was not disconnected: ' || result::text)
from (select pg_temp.cs_call_first('80000000-0000-4000-8000-000000000106','80000000-0000-4000-8000-000000000063',
	pg_temp.cs_revoke('80000000-0000-4000-8000-000000000052'),
	pg_temp.cs_member('30000000-0000-4000-8000-000000000001'), 'Disconnect') as result) as disconnect;
select pg_temp.cs_done('80000000-0000-4000-8000-000000000106');

-- 5. The Disconnect first. The holder keeps the secret; the owner's Disconnect waits for it, holding the company
--    row's key share; the next agent call's lease waits for the company row. The holder lets go: the Disconnect
--    lands, and the call is refused for its revoked grant.
select pg_temp.cs_receipt('80000000-0000-4000-8000-000000000107','80000000-0000-4000-8000-000000000064');
select pg_temp.cs_check(outcome #>> '{first,result,status}' = 'revoked' and outcome #>> '{second,state}' = '42501'
		and outcome #>> '{second,error}' = 'native connector grant is unavailable',
	'A Disconnect and an agent call on its secret did not both land: ' || outcome::text)
from (select pg_temp.cs_race(pg_temp.lock_row('qorpera_cloud_secrets','id','80000000-0000-4000-8000-000000000053'),
	pg_temp.cs_revoke('80000000-0000-4000-8000-000000000053'), pg_temp.cs_member('30000000-0000-4000-8000-000000000001'),
	pg_temp.cs_authorize('80000000-0000-4000-8000-000000000107','80000000-0000-4000-8000-000000000064'), null) as outcome) as race;
select pg_temp.cs_done('80000000-0000-4000-8000-000000000107');

-- Every call above left its rows: six authorized calls, the sealed version 2, and the revoked connections and grants.
select pg_temp.cs_check((select count(*) from public.qorpera_cloud_secret_audit_events where event_type = 'effect_authorized'
		and receipt_id::text like '80000000-0000-4000-8000-0000000001%') = 6
	and (select current_version from public.qorpera_cloud_secrets where id = '80000000-0000-4000-8000-000000000052') = 2
	and not exists (select 1 from public.qorpera_cloud_secrets where id in ('80000000-0000-4000-8000-000000000051',
		'80000000-0000-4000-8000-000000000052','80000000-0000-4000-8000-000000000053') and status <> 'revoked')
	and not exists (select 1 from public.qorpera_cloud_secret_operation_grants where secret_id in
		('80000000-0000-4000-8000-000000000052','80000000-0000-4000-8000-000000000053') and status = 'active'),
	'The calls did not leave the rows they returned');

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
