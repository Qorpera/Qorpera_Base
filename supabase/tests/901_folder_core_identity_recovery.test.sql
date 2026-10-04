-- Company folder core, P13 part 2 (20260930049000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.17, C1B §8): on
-- a folder-v2 company identity recovery and retirement follow the folder core's order with no gc fence: the folder
-- fence and the company row KEY SHARE, then (recovery) every member row FOR SHARE, then the identity. A folder effect
-- never makes them wait; a stop's second phase does, before any member, identity, sign-in or company row is locked. A
-- login's recovery request holds no sign-in while it waits for the identity: a new sign-in cancels the earlier one at
-- once and a completion finishes first, and the request then refuses on its re-check. A completion's epoch trigger
-- never queues behind recovery's identity lock. Every patched body carries its branch. The fixture is committed so the
-- connections can see it, and removed at the end. Waits are detected with pg_blocking_pids. A snapshot-v1 company keeps
-- the gc fence in each else branch, untested (folder-v2 only since 3 Oct).

-- The owner, and one member per identity (a member has one identity in a company).
insert into auth.users(id,email) values ('09010000-0000-4000-8000-000000000001','p13b-owner@example.test');
insert into auth.users(id,email)
select ('09010000-0000-4000-8000-00000000000' || (n + 1))::uuid, 'p13b-member-' || n || '@example.test' from generate_series(1, 6) as n;
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('09010000-0000-4000-8000-000000000010','Identity recovery','09010000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('09010000-0000-4000-8000-000000000010','09010000-0000-4000-8000-000000000001','p13b-owner@example.test','Owner','owner');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
select '09010000-0000-4000-8000-000000000010', ('09010000-0000-4000-8000-00000000000' || (n + 1))::uuid, 'p13b-member-' || n || '@example.test',
	'Member ' || n, 'contributor'
from generate_series(1, 6) as n;
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('09010000-0000-4000-8000-000000000020','09010000-0000-4000-8000-000000000010','Environment',1,'09010000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('09010000-0000-4000-8000-000000000020') \g /dev/null
-- Member n's identity n, one per scenario (a recovery fences its identity for good unless it completes): 1 a login's
-- recovery and its release, 2 a refresh's recovery, 3 an owner's request and the member's consent, 4 a new sign-in's
-- race, 5 a completion's race with a request, 6 a completion's race with a release.
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, owner_user_id, client_identity_id, display_name)
select ('09010000-0000-4000-8000-00000000003' || n)::uuid, '09010000-0000-4000-8000-000000000010', 'member',
	('09010000-0000-4000-8000-00000000000' || (n + 1))::uuid, extensions.gen_random_uuid(), 'Identity ' || n
from generate_series(1, 6) as n;
-- The company's recovery service (public-key shapes only, as 298).
insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
values ('09010000-0000-4000-8000-000000000030','09010000-0000-4000-8000-000000000010',repeat('A',59),repeat('A',550),
	'https://recovery.example.test',repeat('c',64));
-- Members 5's and 6's model logins, which their sign-ins complete (the sign-ins' client connections).
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id) values
	('09010000-0000-4000-8000-000000000055','09010000-0000-4000-8000-000000000010','09010000-0000-4000-8000-000000000255',
		'09010000-0000-4000-8000-000000000006','openai','09010000-0000-4000-8000-000000000006'),
	('09010000-0000-4000-8000-000000000056','09010000-0000-4000-8000-000000000010','09010000-0000-4000-8000-000000000256',
		'09010000-0000-4000-8000-000000000007','openai','09010000-0000-4000-8000-000000000007');

create function pg_temp.sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;
create function pg_temp.cap(p_id text) returns text language sql as $$ select pg_temp.sha('p13b-' || p_id) $$;
create function pg_temp.member(p_n integer) returns uuid language sql as $$ select ('09010000-0000-4000-8000-00000000000' || (p_n + 1))::uuid $$;
create function pg_temp.identity(p_n integer) returns uuid language sql as $$ select ('09010000-0000-4000-8000-00000000003' || p_n)::uuid $$;
create function pg_temp.target(p_n integer) returns uuid language sql as $$ select ('09010000-0000-4000-8000-00000000004' || p_n)::uuid $$;
-- A pending sign-in of member n's identity, as qorpera_begin_native_provider_login makes it.
create function pg_temp.sign_in(p_id text, p_n integer, p_connection text default null) returns void language sql as $$
	insert into public.qorpera_native_provider_login_sessions(id, profile_id, compute_identity_id, client_login_id, client_connection_id,
		provider, native_harness, capability_sha256, requested_by_user_id, expires_at)
	values (p_id::uuid, '09010000-0000-4000-8000-000000000010', pg_temp.identity(p_n), extensions.gen_random_uuid(),
		coalesce(p_connection::uuid, extensions.gen_random_uuid()), 'openai', 'codex-cli', pg_temp.cap(p_id),
		pg_temp.member(p_n), clock_timestamp() + interval '50 minutes')
$$;
create function pg_temp.refresh_request(p_id text, p_n integer) returns void language sql as $$
	insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
		requested_by_user_id, capability_sha256, compute_recovery_epoch)
	values (p_id::uuid, '09010000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), pg_temp.identity(p_n),
		pg_temp.member(p_n), pg_temp.cap(p_id), 0)
$$;

-- The calls, as the recovery service, the login gateway and the members make them; each returns one text value.
create function pg_temp.register(p_n integer) returns text language sql as $$
	select format('select public.qorpera_register_identity_recovery_target(%L,%L,%L,%L,%L,%L,%L,%L,%L) ->> ''targetId''',
		'09010000-0000-4000-8000-000000000030', repeat('c', 64), pg_temp.target(p_n), pg_temp.identity(p_n),
		'09010000-0000-4000-8000-000000000049', repeat('1', 64), repeat('2', 64), repeat('A', 549) || p_n, pg_temp.sha('p13b-target-' || p_n))
$$;
create function pg_temp.backup(p_n integer, p_login text, p_complete boolean) returns text language sql as $$
	select case when p_complete then
		format('select public.qorpera_complete_identity_key_backup(%L,%L,%L,%L,%L,1,%L,1024) ->> ''status''',
			'09010000-0000-4000-8000-000000000030', repeat('c', 64), p_login, pg_temp.cap(p_login), pg_temp.sha('p13b-key-' || p_n),
			pg_temp.sha('p13b-object-' || p_n))
	else format('select public.qorpera_prepare_identity_key_backup(%L,%L,%L,%L,%L) ->> ''status''',
		'09010000-0000-4000-8000-000000000030', repeat('c', 64), p_login, pg_temp.cap(p_login), pg_temp.sha('p13b-key-' || p_n)) end
$$;
create function pg_temp.request_login(p_login text, p_n integer, p_request text) returns text language sql as $$
	select format('select public.qorpera_request_login_identity_recovery(%L,%L,%L,''nas'') ->> ''status''', p_login, pg_temp.target(p_n), p_request)
$$;
create function pg_temp.request_refresh(p_refresh text, p_n integer, p_request text) returns text language sql as $$
	select format('select public.qorpera_request_account_refresh_identity_recovery(%L,%L,%L,''nas'') ->> ''status''', p_refresh,
		pg_temp.target(p_n), p_request)
$$;
create function pg_temp.request_owner(p_n integer, p_request text) returns text language sql as $$
	select format('select public.qorpera_request_identity_recovery(%L,%L,%L,1,%L,''nas'') ->> ''status''', pg_temp.identity(p_n),
		pg_temp.target(p_n), p_request, pg_temp.sha('p13b-object-' || p_n))
$$;
create function pg_temp.recovery_call(p_function text, p_request text) returns text language sql as $$
	select format('select public.qorpera_%s_identity_recovery((select id from public.qorpera_identity_recoveries where client_request_id = %L)) ->> ''status''',
		p_function, p_request)
$$;
-- The key release: its first step is qorpera_recovery_locked.
create function pg_temp.release(p_n integer, p_request text) returns text language sql as $$
	select format('select public.qorpera_prepare_identity_key_release(%L,%L,(select id from public.qorpera_identity_recoveries where client_request_id = %L),%L) ->> ''status''',
		'09010000-0000-4000-8000-000000000030', repeat('c', 64), p_request, pg_temp.sha('p13b-target-' || p_n))
$$;
create function pg_temp.complete(p_login text, p_capsule text) returns text language sql as $$
	select format($q$select public.qorpera_complete_native_provider_login(%L, %L, %L, %L, repeat('b', 64),
		'codex-cli:p13b', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
		'p13b-member@example.test') ->> 'authorization_state'$q$, p_login, pg_temp.cap(p_login), p_capsule, 'object://native-capsules/p13b-' || p_capsule)
$$;
create function pg_temp.retire() returns text language sql as $$
	select format('select public.qorpera_confirm_runtime_identity_retirement(%L,%L,%L,%L)::text', 'lxd-p13b', repeat('8', 64),
		pg_temp.identity(1), '{"schema":"qorpera.identity-retirement-evidence/v1","volume":"deleted","device":"detached"}')
$$;
create function pg_temp.not_before(p_request text) returns text language sql as $$
	-- Advance only the fixture's not-before clock (as 298).
	select format('update public.qorpera_identity_recoveries set not_before = clock_timestamp() - interval ''1 second'' where client_request_id = %L returning ''advanced''::text',
		p_request)
$$;
create function pg_temp.run(p_statement text) returns text language plpgsql as $$
declare v_value text;
begin
	execute p_statement into v_value;
	return v_value;
end $$;
create function pg_temp.claims(p_user text) returns text language sql as $$
	select case when p_user is null then '{"role":"service_role"}' else jsonb_build_object('role', 'authenticated', 'sub', p_user)::text end
$$;

-- A node with a login provider, as 900 sets one up, for the retirement confirmation (its node and provider).
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('09010000-0000-4000-8000-000000000060');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','09010000-0000-4000-8000-000000000060','machineIdSha256',repeat('8',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end $$;
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','09010000-0000-4000-8000-000000000060','machineIdSha256',repeat('8',64),'label','login-901','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','09010000-0000-4000-8000-000000000060','host',jsonb_build_object('machineIdSha256',repeat('8',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('09010000-0000-4000-8000-000000000060',repeat('8',64),'login','lxd-p13b',
		repeat('f',64),2000,4294967296);
end $$;

-- Each identity's sign-ins, backup, target and recovery, made through the calls (as the service, unless named):
-- 1: a completed sign-in (its capsule and model login, which a release needs) and a pending one for the request;
-- 2: a pending sign-in and refresh request; 3: a pending sign-in; 4: a pending sign-in and refresh request, a backup and
-- a target; 5: a pending sign-in on model login 55, a backup and a target; 6: a completed sign-in, a backup, a target,
-- a pending sign-in on model login 56 and an approved recovery (an owner's request, the member's consent).
select pg_temp.sign_in('09010000-0000-4000-8000-000000000106', 1);
do $$
begin
	perform pg_temp.run(pg_temp.backup(1, '09010000-0000-4000-8000-000000000106', false));
	perform pg_temp.run(pg_temp.backup(1, '09010000-0000-4000-8000-000000000106', true));
	perform pg_temp.run(pg_temp.complete('09010000-0000-4000-8000-000000000106', '09010000-0000-4000-8000-000000000521'));
end $$;
select pg_temp.sign_in('09010000-0000-4000-8000-000000000101', 1);
select pg_temp.sign_in('09010000-0000-4000-8000-000000000102', 2);
select pg_temp.refresh_request('09010000-0000-4000-8000-000000000112', 2);
select pg_temp.sign_in('09010000-0000-4000-8000-000000000103', 3);
select pg_temp.sign_in('09010000-0000-4000-8000-000000000104', 4);
select pg_temp.refresh_request('09010000-0000-4000-8000-000000000114', 4);
select pg_temp.sign_in('09010000-0000-4000-8000-000000000105', 5, '09010000-0000-4000-8000-000000000255');
select pg_temp.sign_in('09010000-0000-4000-8000-000000000126', 6);
do $$
declare v_n integer; v_login text;
begin
	foreach v_n in array array[4, 5, 6] loop
		v_login := case v_n when 4 then '09010000-0000-4000-8000-000000000104' when 5 then '09010000-0000-4000-8000-000000000105'
			else '09010000-0000-4000-8000-000000000126' end;
		perform pg_temp.run(pg_temp.backup(v_n, v_login, false));
		perform pg_temp.run(pg_temp.backup(v_n, v_login, true));
		perform pg_temp.run(pg_temp.register(v_n));
	end loop;
	perform pg_temp.run(pg_temp.complete('09010000-0000-4000-8000-000000000126', '09010000-0000-4000-8000-000000000526'));
end $$;
select pg_temp.sign_in('09010000-0000-4000-8000-000000000116', 6, '09010000-0000-4000-8000-000000000256');
do $$
begin
	perform set_config('request.jwt.claims', pg_temp.claims('09010000-0000-4000-8000-000000000001'), false);
	if pg_temp.run(pg_temp.request_owner(6, '09010000-0000-4000-8000-000000000166')) <> 'awaiting_member' then
		raise exception 'fixture: identity 6''s recovery must await the member'; end if;
	perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.member(6)::text), false);
	if pg_temp.run(pg_temp.recovery_call('consent', '09010000-0000-4000-8000-000000000166')) <> 'approved' then
		raise exception 'fixture: identity 6''s recovery must be approved'; end if;
	perform set_config('request.jwt.claims', pg_temp.claims(null), false);
	perform pg_temp.run(pg_temp.not_before('09010000-0000-4000-8000-000000000166'));
end $$;

-- A sent statement's value, or its error as 'error <state> <message>'; drains the connection.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v_value text;
begin
	begin
		select r into v_value from dblink_get_result(p_conn) as t(r text);
	exception when others then v_value := 'error ' || sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_value;
end $$;
-- Sends a call as the service (no user) or as a member.
create function pg_temp.send(p_conn text, p_user text, p_statement text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L', pg_temp.claims(p_user)));
	perform dblink_send_query(p_conn, p_statement);
end $$;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['p13b_a','p13b_b','p13b_c','p13b_d','p13b_e']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['p13b_a','p13b_b','p13b_c','p13b_d','p13b_e']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['p13b_a','p13b_b','p13b_c','p13b_d','p13b_e']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.pids(p_conns text[]) returns integer[] language sql as $$
	select array(select current_setting('qorpera_test.pid_' || name)::integer from unnest(p_conns) as name)
$$;
-- Whether a connection's statement waits for one of the holders (a second waiter on a row waits for the first).
create function pg_temp.waits_for(p_waiter text, variadic p_holders text[]) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if pg_temp.pids(p_holders) && pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer) then
			return true; end if;
		exit when clock_timestamp() > v_until or dblink_is_busy(p_waiter) = 0;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.finishes_unblocked(p_conn text, variadic p_holders text[]) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if pg_temp.pids(p_holders) && pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer)
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;
-- Whether a connection inside a transaction can take a lock at once (`<table> where ... for <mode>`, nowait).
create function pg_temp.lockable(p_conn text, p_lock text) returns boolean language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'savepoint probe');
	begin
		perform dblink_exec(p_conn, format('do $d$ begin perform 1 from %s nowait; end $d$', p_lock));
	exception when others then
		perform dblink_exec(p_conn, 'rollback to savepoint probe');
		return false;
	end;
	perform dblink_exec(p_conn, 'rollback to savepoint probe');
	return true;
end $$;
create function pg_temp.identity_lock(p_n integer) returns text language sql as $$
	select format('public.qorpera_member_compute_identities where id = %L for no key update', pg_temp.identity(p_n))
$$;
create function pg_temp.members_lock() returns text language sql as $$
	select 'public.qorpera_profile_members where profile_id = ''09010000-0000-4000-8000-000000000010'' order by user_id for no key update'
$$;
create function pg_temp.sign_in_lock(p_id text) returns text language sql as $$
	select format('public.qorpera_native_provider_login_sessions where id = %L for update', p_id)
$$;
create function pg_temp.company_lock() returns text language sql as $$
	select 'public.qorpera_profiles where id = ''09010000-0000-4000-8000-000000000010'' for update'
$$;

-- The steps of A and B: a call, who makes it, its expected value, and (B) the locks it must not hold while it waits.
create temporary table p13b_steps(n serial, section text, label text, user_id text, statement text, expected text,
	free text[] default '{}') on commit preserve rows;
insert into p13b_steps(section, label, user_id, statement, expected) values
	('A', 'target 1', null, pg_temp.register(1), pg_temp.target(1)::text),
	('A', 'login recovery 1', null, pg_temp.request_login('09010000-0000-4000-8000-000000000101', 1, '09010000-0000-4000-8000-000000000161'), 'approved'),
	('A', 'fixture', null, pg_temp.not_before('09010000-0000-4000-8000-000000000161'), 'advanced'),
	('A', 'release 1', null, pg_temp.release(1, '09010000-0000-4000-8000-000000000161'), 'approved'),
	('A', 'member cancel 1', pg_temp.member(1)::text, pg_temp.recovery_call('cancel', '09010000-0000-4000-8000-000000000161'), 'cancelled'),
	('A', 'target 2', null, pg_temp.register(2), pg_temp.target(2)::text),
	('A', 'backup 2', null, pg_temp.backup(2, '09010000-0000-4000-8000-000000000102', false), 'prepared'),
	('A', 'backup 2 complete', null, pg_temp.backup(2, '09010000-0000-4000-8000-000000000102', true), 'ready'),
	('A', 'refresh recovery 2', null, pg_temp.request_refresh('09010000-0000-4000-8000-000000000112', 2, '09010000-0000-4000-8000-000000000162'), 'approved'),
	('A', 'target 3', null, pg_temp.register(3), pg_temp.target(3)::text),
	('A', 'backup 3', null, pg_temp.backup(3, '09010000-0000-4000-8000-000000000103', false), 'prepared'),
	('A', 'backup 3 complete', null, pg_temp.backup(3, '09010000-0000-4000-8000-000000000103', true), 'ready'),
	('A', 'owner request 3', '09010000-0000-4000-8000-000000000001', pg_temp.request_owner(3, '09010000-0000-4000-8000-000000000163'), 'awaiting_member'),
	('A', 'member consent 3', pg_temp.member(3)::text, pg_temp.recovery_call('consent', '09010000-0000-4000-8000-000000000163'), 'approved'),
	('A', 'owner cancel 3', '09010000-0000-4000-8000-000000000001', pg_temp.recovery_call('cancel', '09010000-0000-4000-8000-000000000163'), 'cancelled'),
	('A', 'member role', pg_temp.member(1)::text, 'select public.qorpera_recovery_member_role(''09010000-0000-4000-8000-000000000010'')', 'contributor'),
	('A', 'retirement', null, pg_temp.retire(), 'error 42501 Identity retirement unavailable');
insert into p13b_steps(section, label, user_id, statement, expected, free) values
	('B', 'login recovery 4', null, pg_temp.request_login('09010000-0000-4000-8000-000000000104', 4, '09010000-0000-4000-8000-000000000174'), 'approved',
		array[pg_temp.identity_lock(4), pg_temp.members_lock(), pg_temp.sign_in_lock('09010000-0000-4000-8000-000000000104'), pg_temp.company_lock()]),
	('B', 'refresh recovery 4', null, pg_temp.request_refresh('09010000-0000-4000-8000-000000000114', 4, '09010000-0000-4000-8000-000000000175'), 'approved',
		array[pg_temp.identity_lock(4), pg_temp.members_lock(), pg_temp.company_lock(),
			'public.qorpera_native_account_refresh_requests where id = ''09010000-0000-4000-8000-000000000114'' for update']),
	('B', 'owner request 5', '09010000-0000-4000-8000-000000000001', pg_temp.request_owner(5, '09010000-0000-4000-8000-000000000176'), 'awaiting_member',
		array[pg_temp.identity_lock(5), pg_temp.members_lock(), pg_temp.company_lock()]),
	('B', 'release 6', null, pg_temp.release(6, '09010000-0000-4000-8000-000000000166'), 'approved',
		array[pg_temp.identity_lock(6), pg_temp.members_lock(), pg_temp.company_lock()]),
	('B', 'owner cancel 6', '09010000-0000-4000-8000-000000000001', pg_temp.recovery_call('cancel', '09010000-0000-4000-8000-000000000166'), 'cancelled',
		array[pg_temp.identity_lock(6), pg_temp.members_lock(), pg_temp.company_lock()]),
	('B', 'backup 4', null, pg_temp.backup(4, '09010000-0000-4000-8000-000000000104', false), 'ready',
		array[pg_temp.identity_lock(4), pg_temp.sign_in_lock('09010000-0000-4000-8000-000000000104'), pg_temp.company_lock()]),
	('B', 'target 4', null, pg_temp.register(4), pg_temp.target(4)::text, array[pg_temp.identity_lock(4), pg_temp.company_lock()]),
	('B', 'member role', pg_temp.member(1)::text, 'select public.qorpera_recovery_member_role(''09010000-0000-4000-8000-000000000010'')', 'contributor',
		array[pg_temp.members_lock(), pg_temp.company_lock()]),
	('B', 'retirement', null, pg_temp.retire(), 'error 42501 Identity retirement unavailable', array[pg_temp.identity_lock(1), pg_temp.company_lock()]);

-- A. Beside a folder effect (the fence and the company row KEY SHARE), every recovery and retirement call finishes and
-- none waits: no gc fence.
do $$
declare v_step record; v_value text;
begin
	perform dblink_exec('p13b_a', 'begin');
	perform dblink_exec('p13b_a', $q$do $d$ begin perform 1 from public.qorpera_folder_fences where profile_id = '09010000-0000-4000-8000-000000000010' for key share; end $d$ $q$);
	perform dblink_exec('p13b_a', $q$do $d$ begin perform 1 from public.qorpera_profiles where id = '09010000-0000-4000-8000-000000000010' for key share; end $d$ $q$);
	for v_step in select * from p13b_steps where section = 'A' order by n loop
		perform pg_temp.send('p13b_b', v_step.user_id, v_step.statement);
		if not pg_temp.finishes_unblocked('p13b_b', 'p13b_a') then
			raise exception 'A: % waited behind a folder effect', v_step.label; end if;
		v_value := pg_temp.result('p13b_b');
		if v_value is distinct from v_step.expected then raise exception 'A: % returned %, not %', v_step.label, v_value, v_step.expected; end if;
	end loop;
	perform dblink_exec('p13b_a', 'rollback');
end $$;

-- B. A stop's second phase (the fence FOR UPDATE) makes each call wait at the fence holding none of the rows it locks
-- after it: no identity, member row, sign-in or company row. Once the stop ends, it goes on (and is rolled back).
do $$
declare v_step record; v_value text; v_lock text;
begin
	for v_step in select * from p13b_steps where section = 'B' order by n loop
		perform dblink_exec('p13b_a', 'begin');
		perform dblink_exec('p13b_a', $q$do $d$ begin perform 1 from public.qorpera_folder_fences where profile_id = '09010000-0000-4000-8000-000000000010' for update; end $d$ $q$);
		perform dblink_exec('p13b_b', 'begin');
		perform pg_temp.send('p13b_b', v_step.user_id, v_step.statement);
		if not pg_temp.waits_for('p13b_b', 'p13b_a') then raise exception 'B: % must wait for the stop', v_step.label; end if;
		perform dblink_exec('p13b_c', 'begin');
		foreach v_lock in array v_step.free loop
			if not pg_temp.lockable('p13b_c', v_lock) then
				raise exception 'B: % holds a lock while it waits at the fence: %', v_step.label, v_lock; end if;
		end loop;
		perform dblink_exec('p13b_c', 'rollback');
		perform dblink_exec('p13b_a', 'rollback');
		v_value := pg_temp.result('p13b_b');
		if v_value is distinct from v_step.expected then raise exception 'B: % returned %, not %', v_step.label, v_value, v_step.expected; end if;
		perform dblink_exec('p13b_b', 'rollback');
	end loop;
end $$;

-- C. A new sign-in, and a login's recovery request and a key backup's preparation on member 4's earlier sign-in of the
-- same identity. The new sign-in's insert holds the identity FOR SHARE (its epoch trigger; held here first, as the
-- trigger takes it before the insert's supersede) and then cancels the earlier sign-in. The request and the preparation
-- wait for the identity holding no sign-in, so the cancellation goes through at once, and both refuse on their re-check.
-- (Holding the earlier sign-in FOR SHARE while they waited, as the old text did, the cancellation would wait for them:
-- 40P01.) A refresh's recovery request waits the same way, and refuses once the refresh request is cancelled meanwhile
-- (as a newer refresh or the member does).
do $$
declare v_value text;
begin
	perform dblink_exec('p13b_a', 'begin');
	perform dblink_exec('p13b_a', format('set request.jwt.claims = %L', pg_temp.claims(pg_temp.member(4)::text)));
	perform dblink_exec('p13b_a', format('do $d$ begin perform 1 from public.qorpera_member_compute_identities where id = %L for share; end $d$', pg_temp.identity(4)));
	perform pg_temp.send('p13b_b', null, pg_temp.request_login('09010000-0000-4000-8000-000000000104', 4, '09010000-0000-4000-8000-000000000164'));
	if not pg_temp.waits_for('p13b_b', 'p13b_a') then raise exception 'C: the request must wait for the identity'; end if;
	perform pg_temp.send('p13b_d', null, pg_temp.backup(4, '09010000-0000-4000-8000-000000000104', false));
	if not pg_temp.waits_for('p13b_d', 'p13b_a', 'p13b_b') then raise exception 'C: the backup''s preparation must wait for the identity'; end if;
	perform pg_temp.send('p13b_e', null, pg_temp.request_refresh('09010000-0000-4000-8000-000000000114', 4, '09010000-0000-4000-8000-000000000184'));
	if not pg_temp.waits_for('p13b_e', 'p13b_a', 'p13b_b', 'p13b_d') then raise exception 'C: the refresh''s request must wait for the identity'; end if;
	perform dblink_send_query('p13b_a', format($q$select public.qorpera_begin_native_provider_login(%L, %L, %L, %L, 'openai', 'codex-cli', %L, 3600) ->> 'status'$q$,
		'09010000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.identity(4), pg_temp.sha('p13b-new')));
	if not pg_temp.finishes_unblocked('p13b_a', 'p13b_b', 'p13b_d', 'p13b_e') then
		raise exception 'C: the new sign-in must cancel the earlier one without waiting for the request or the preparation'; end if;
	v_value := pg_temp.result('p13b_a');
	if v_value is distinct from 'pending' then raise exception 'C: the new sign-in must begin: %', v_value; end if;
	perform dblink_send_query('p13b_a', $q$update public.qorpera_native_account_refresh_requests set status = 'cancelled'
		where id = '09010000-0000-4000-8000-000000000114' returning 'cancelled'::text$q$);
	if not pg_temp.finishes_unblocked('p13b_a', 'p13b_b', 'p13b_d', 'p13b_e') then
		raise exception 'C: the refresh request''s cancellation must not wait for its recovery request'; end if;
	perform pg_temp.result('p13b_a');
	perform dblink_exec('p13b_a', 'commit');
	perform dblink_exec('p13b_a', format('set request.jwt.claims = %L', pg_temp.claims(null)));
	v_value := pg_temp.result('p13b_b');
	if v_value not like 'error 42501 login recovery requires a pending login%' then
		raise exception 'C: the request must refuse the cancelled sign-in: %', v_value; end if;
	v_value := pg_temp.result('p13b_d');
	if v_value not like 'error 42501 recovery source login is unavailable%' then
		raise exception 'C: the preparation must refuse the cancelled sign-in: %', v_value; end if;
	v_value := pg_temp.result('p13b_e');
	if v_value not like 'error 42501 login recovery requires a pending login%' then
		raise exception 'C: the refresh''s request must refuse the cancelled refresh request: %', v_value; end if;
	if (select status from public.qorpera_native_provider_login_sessions where id = '09010000-0000-4000-8000-000000000104') <> 'cancelled'
		or exists (select 1 from public.qorpera_identity_recoveries where client_request_id in ('09010000-0000-4000-8000-000000000164',
			'09010000-0000-4000-8000-000000000184')) then
		raise exception 'C: the earlier sign-in is cancelled and no recovery begins'; end if;
end $$;

-- D. A sign-in's completion and a login's recovery request on that sign-in. The completion holds the sign-in FOR
-- UPDATE and the identity KEY SHARE (its capsule) and waits for the model login (held here); the request waits for it
-- at the identity, holding the member rows (it is past rank 1) and no sign-in. The completion finishes, and the request
-- refuses on its re-check: the sign-in is no longer pending.
do $$
declare v_value text;
begin
	perform dblink_exec('p13b_c', 'begin');
	perform dblink_exec('p13b_c', $q$do $d$ begin perform 1 from public.qorpera_provider_connections where id = '09010000-0000-4000-8000-000000000055' for update; end $d$ $q$);
	perform pg_temp.send('p13b_a', null, pg_temp.complete('09010000-0000-4000-8000-000000000105', '09010000-0000-4000-8000-000000000525'));
	if not pg_temp.waits_for('p13b_a', 'p13b_c') then raise exception 'D: the completion must wait for the model login'; end if;
	perform pg_temp.send('p13b_b', null, pg_temp.request_login('09010000-0000-4000-8000-000000000105', 5, '09010000-0000-4000-8000-000000000165'));
	if not pg_temp.waits_for('p13b_b', 'p13b_a') then raise exception 'D: the request must wait for the completion'; end if;
	if pg_temp.lockable('p13b_c', pg_temp.members_lock()) then
		raise exception 'D: the request must wait at the identity, holding the member rows'; end if;
	perform dblink_exec('p13b_c', 'commit');
	v_value := pg_temp.result('p13b_a');
	if v_value is distinct from 'active' then raise exception 'D: the completion must finish: %', v_value; end if;
	v_value := pg_temp.result('p13b_b');
	if v_value not like 'error 42501 login recovery requires a pending login%' then
		raise exception 'D: the request must refuse the completed sign-in: %', v_value; end if;
end $$;

-- E. A sign-in's completion and a key release (qorpera_recovery_locked) on an identity whose recovery is approved. The
-- completion holds the identity KEY SHARE (its capsule) and waits for the model login (held here); the release waits for
-- it at the identity, holding the member rows. The completion's epoch trigger then takes the identity FOR SHARE without
-- queueing behind the release's FOR UPDATE and refuses the fenced generation (42501, no deadlock); the release goes on.
do $$
declare v_value text;
begin
	perform dblink_exec('p13b_c', 'begin');
	perform dblink_exec('p13b_c', $q$do $d$ begin perform 1 from public.qorpera_provider_connections where id = '09010000-0000-4000-8000-000000000056' for update; end $d$ $q$);
	perform pg_temp.send('p13b_a', null, pg_temp.complete('09010000-0000-4000-8000-000000000116', '09010000-0000-4000-8000-000000000536'));
	if not pg_temp.waits_for('p13b_a', 'p13b_c') then raise exception 'E: the completion must wait for the model login'; end if;
	perform pg_temp.send('p13b_b', null, pg_temp.release(6, '09010000-0000-4000-8000-000000000166'));
	if not pg_temp.waits_for('p13b_b', 'p13b_a') then raise exception 'E: the release must wait for the completion'; end if;
	if pg_temp.lockable('p13b_c', pg_temp.members_lock()) then
		raise exception 'E: the release must wait at the identity, holding the member rows'; end if;
	perform dblink_exec('p13b_c', 'commit');
	v_value := pg_temp.result('p13b_a');
	if v_value not like 'error 42501 native login generation is fenced for recovery%' then
		raise exception 'E: the completion must refuse the fenced generation: %', v_value; end if;
	v_value := pg_temp.result('p13b_b');
	if v_value is distinct from 'approved' then raise exception 'E: the release must go on: %', v_value; end if;
end $$;

-- F. The helper is postgres-only and takes the fence and the company row KEY SHARE and every member row FOR SHARE,
-- and nothing more (not the identity).
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_folder_identity_recovery_locks(uuid)', 'execute') then
			raise exception 'F: the helper must be postgres-only (%)', v_role; end if;
	end loop;
	perform dblink_exec('p13b_a', 'begin');
	perform dblink_exec('p13b_a', $q$do $d$ begin perform public.qorpera_folder_identity_recovery_locks('09010000-0000-4000-8000-000000000010'); end $d$ $q$);
	perform dblink_exec('p13b_c', 'begin');
	if pg_temp.lockable('p13b_c', pg_temp.members_lock())
		or pg_temp.lockable('p13b_c', 'public.qorpera_folder_fences where profile_id = ''09010000-0000-4000-8000-000000000010'' for update')
		or pg_temp.lockable('p13b_c', pg_temp.company_lock()) then
		raise exception 'F: the helper must hold the member rows, the fence and the company row'; end if;
	if not pg_temp.lockable('p13b_c', pg_temp.identity_lock(1))
		or not pg_temp.lockable('p13b_c', 'public.qorpera_profiles where id = ''09010000-0000-4000-8000-000000000010'' for no key update')
		or not pg_temp.lockable('p13b_c', 'public.qorpera_profile_members where profile_id = ''09010000-0000-4000-8000-000000000010'' for key share') then
		raise exception 'F: the helper must hold the company row and the members no stronger than KEY SHARE and FOR SHARE, and no identity'; end if;
	perform dblink_exec('p13b_c', 'rollback');
	perform dblink_exec('p13b_a', 'rollback');
end $$;

-- G. Each patched body carries its folder-v2 branch exactly once: a later create or replace that drops one fails here
-- (folder-v2 only since 3 Oct, so no snapshot-v1 text pins).
create temporary table p13b_patches(n serial, fn text, patched text) on commit preserve rows;
insert into p13b_patches(fn, patched) values
	('qorpera_activate_identity_recovery(uuid)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$),
	('qorpera_cancel_identity_recovery(uuid)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$),
	('qorpera_consent_identity_recovery(uuid)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$),
	('qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_identity.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$),
	('qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$p13new$),
	('qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	-- 20260930049000: on folder-v2 the sign-in is read with no lock and checked again under the identity's lock;
	-- holding it while waiting for the identity deadlocks with a new sign-in (C1B §8).
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for share;
	end if;
$p13new$),
	('qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$),
	('qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
	if v_folder then
		select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id;
		if not found or v_session.status<>'pending' or v_session.expires_at<=clock_timestamp()
			or v_session.compute_recovery_epoch is distinct from v_identity.recovery_epoch then
			raise exception 'login recovery requires a pending login' using errcode='42501'; end if;
	end if;
$p13new$),
	('qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$p13new$),
	('qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	-- 20260930049000: on folder-v2 the refresh request is read with no lock and checked again under the identity's lock;
	-- holding it while waiting for the identity deadlocks with a new sign-in (C1B §8).
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id for share;
	end if;
$p13new$),
	('qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$),
	('qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)',
		$p13new$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
	if v_folder then
		select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id;
		if not found or v_session.status<>'pending' or v_session.expires_at<=clock_timestamp()
			or v_session.compute_recovery_epoch is distinct from v_identity.recovery_epoch then
			raise exception 'login recovery requires a pending login' using errcode='42501'; end if;
	end if;
$p13new$),
	('qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)',
		$p13new$	v_revision bigint; v_folder boolean;
$p13new$),
	('qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence and rank 0, then the sign-in read with no lock and checked again under
	-- the identity's lock (C1B §8); no gc fence.
	v_folder:=public.qorpera_company_is_folder_v2(v_authority.profile_id);
	if v_folder then
		perform public.qorpera_folder_machine_fence(v_authority.profile_id);
		select * into v_login from public.qorpera_native_provider_login_sessions
		where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
			and status in ('pending','completed') and expires_at > clock_timestamp();
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	select * into v_login from public.qorpera_native_provider_login_sessions
	where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
		and status in ('pending','completed') and expires_at > clock_timestamp() for share;
	end if;
$p13new$),
	('qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)',
		$p13new$	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id = v_login.id
		and status in ('pending','completed') and expires_at > clock_timestamp()
		and compute_recovery_epoch = v_login.compute_recovery_epoch) then
		raise exception 'recovery source login is unavailable' using errcode = '42501'; end if;
	if v_login.compute_recovery_epoch <> v_identity.recovery_epoch then
		raise exception 'recovery source login generation changed' using errcode = '42501'; end if;
$p13new$),
	('qorpera_recovery_locked(uuid,text,uuid,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_authority.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$p13new$),
	('qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text)',
		$p13new$	-- 20260930049000: on folder-v2 the fence and rank 0; no gc fence.
	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_machine_fence(v_authority.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$p13new$),
	('qorpera_recovery_member_role(uuid)',
		$p13new$  -- 20260930049000: on folder-v2 the fence and rank 0, then the member (rank 1); no gc fence.
  if public.qorpera_company_is_folder_v2(p_company_id) then
    perform public.qorpera_folder_machine_fence(p_company_id);
  else
  perform public.qorpera_lock_profile_gc_fence(p_company_id);
  end if;
$p13new$),
	('qorpera_confirm_runtime_identity_retirement(text,text,uuid,jsonb)',
		$p13new$		-- 20260930049000: on folder-v2 the fence and rank 0; no gc fence.
		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
$p13new$);
do $$
declare v_bad text[];
begin
	if (select count(*) from p13b_patches) <> 19 then raise exception 'G: the patch table is incomplete'; end if;
	select array_agg(fn order by n) into v_bad from p13b_patches
	where (length(pg_get_functiondef(('public.' || fn)::regprocedure))
		- length(replace(pg_get_functiondef(('public.' || fn)::regprocedure), patched, ''))) / length(patched) <> 1;
	if v_bad is not null then raise exception 'G: a patched branch is missing in: %', v_bad; end if;
end $$;

select dblink_disconnect(name) from unnest(array['p13b_a','p13b_b','p13b_c','p13b_d','p13b_e']) name;

-- Remove the fixture: the node, the rows of the identities and model logins, then the company's rows.
set session_replication_role = replica;
do $$
declare v_table record; v_profile uuid := '09010000-0000-4000-8000-000000000010';
	v_identities uuid[] := array(select pg_temp.identity(n) from generate_series(1, 6) as n);
	v_connections uuid[] := array(select id from public.qorpera_provider_connections where profile_id = '09010000-0000-4000-8000-000000000010');
begin
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('node_id', 'compute_identity_id', 'connection_id') and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'node_id' then array['09010000-0000-4000-8000-000000000060']::uuid[]
			when 'compute_identity_id' then v_identities else v_connections end;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '09010000-0000-4000-8000-000000000060';
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id') and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = $1', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profile else '09010000-0000-4000-8000-000000000020'::uuid end;
	end loop;
	delete from public.qorpera_profiles where id = v_profile;
end $$;
set session_replication_role = origin;
delete from auth.users where id = '09010000-0000-4000-8000-000000000001' or id in (select pg_temp.member(n) from generate_series(1, 6) as n);
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '09010000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '09010000-0000-4000-8000-000000000060')
		or exists (select 1 from public.qorpera_member_compute_identities where profile_id = '09010000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_identity_recoveries where profile_id = '09010000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_identity_backup_login_receipts where compute_identity_id in (
			select ('09010000-0000-4000-8000-00000000003' || n)::uuid from generate_series(1, 6) as n))
		or exists (select 1 from public.qorpera_company_files where environment_id = '09010000-0000-4000-8000-000000000020') then
		raise exception 'The identity recovery fixture must be removed'; end if;
end $$;
