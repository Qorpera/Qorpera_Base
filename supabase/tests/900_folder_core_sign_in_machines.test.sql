-- Company folder core, P13 (20260930035000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.14, C1B §8): on a
-- folder-v2 company a sign-in's and an account refresh's login machine are reserved and released on the folder core's
-- order: the folder fence and the company row KEY SHARE, the requester's member row, the identity's machine lock, then
-- the sign-in. No gc fence: a folder effect holding the fence and the company row KEY SHARE never makes them wait, a
-- stop's second phase (the fence FOR UPDATE) does, before the sign-in is locked. Two machines of one identity serialize
-- on the identity's machine lock and the second is refused. Rank 5 in C1B §8's order: a member removal and the account
-- metadata take the model login before the identity, so neither deadlocks with a sign-in's completion. A company without
-- a folder takes no gc fence since the legacy sweep's F2d (20260930293000): its machines are refused at the fence. Every
-- patched body carries its branch. The fixture is committed so the connections can see it, and removed at the end. Waits
-- are detected with pg_blocking_pids.

insert into auth.users(id,email) values ('09000000-0000-4000-8000-000000000001','p13-owner@example.test'),
	('09000000-0000-4000-8000-000000000002','p13-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('09000000-0000-4000-8000-000000000010','Sign-in machines','09000000-0000-4000-8000-000000000001'),
	('09000000-0000-4000-8000-000000000011','Sign-in machines, snapshot','09000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('09000000-0000-4000-8000-000000000010','09000000-0000-4000-8000-000000000001','p13-owner@example.test','Owner','owner'),
	('09000000-0000-4000-8000-000000000010','09000000-0000-4000-8000-000000000002','p13-member@example.test','Member','contributor'),
	('09000000-0000-4000-8000-000000000011','09000000-0000-4000-8000-000000000001','p13-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('09000000-0000-4000-8000-000000000020','09000000-0000-4000-8000-000000000010','Environment',1,'09000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('09000000-0000-4000-8000-000000000020') \g /dev/null
-- The members' identities: the owner's and the member's on the folder-v2 company, the owner's on the one without a folder.
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, owner_user_id, client_identity_id, display_name) values
	('09000000-0000-4000-8000-000000000031','09000000-0000-4000-8000-000000000010','member','09000000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid(),'Owner identity'),
	('09000000-0000-4000-8000-000000000032','09000000-0000-4000-8000-000000000010','member','09000000-0000-4000-8000-000000000002',
		extensions.gen_random_uuid(),'Member identity'),
	('09000000-0000-4000-8000-000000000033','09000000-0000-4000-8000-000000000011','member','09000000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid(),'Snapshot identity');
create function pg_temp.sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;
-- One machine per sign-in (or refresh request): each section begins its own, as the owner of the owner's identity.
create function pg_temp.cap(p_id text) returns text language sql as $$ select pg_temp.sha('p13-' || p_id) $$;
create function pg_temp.sign_in(p_id text) returns void language sql as $$
	insert into public.qorpera_native_provider_login_sessions(id, profile_id, compute_identity_id, client_login_id, client_connection_id,
		provider, native_harness, capability_sha256, requested_by_user_id, expires_at)
	values (p_id::uuid, '09000000-0000-4000-8000-000000000010', '09000000-0000-4000-8000-000000000031', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 'openai', 'codex-cli', pg_temp.cap(p_id), '09000000-0000-4000-8000-000000000001',
		clock_timestamp() + interval '50 minutes')
$$;
create function pg_temp.refresh_request(p_id text) returns void language sql as $$
	-- One pending refresh per identity: the previous section's is done.
	update public.qorpera_native_account_refresh_requests set status = 'cancelled'
	where compute_identity_id = '09000000-0000-4000-8000-000000000031' and status = 'pending';
	insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
		requested_by_user_id, capability_sha256, compute_recovery_epoch)
	select p_id::uuid, identity.profile_id, extensions.gen_random_uuid(), identity.id, '09000000-0000-4000-8000-000000000001',
		pg_temp.cap(p_id), identity.recovery_epoch
	from public.qorpera_member_compute_identities as identity where identity.id = '09000000-0000-4000-8000-000000000031'
$$;
-- The member's pending sign-in of their identity, and the owner's on the company without a folder.
insert into public.qorpera_native_provider_login_sessions(id, profile_id, compute_identity_id, client_login_id, client_connection_id,
	provider, native_harness, capability_sha256, requested_by_user_id, expires_at) values
	('09000000-0000-4000-8000-000000000043','09000000-0000-4000-8000-000000000010','09000000-0000-4000-8000-000000000032',
		extensions.gen_random_uuid(),'09000000-0000-4000-8000-000000000243','openai','codex-cli',pg_temp.sha('p13-login-2'),
		'09000000-0000-4000-8000-000000000002',clock_timestamp() + interval '50 minutes'),
	('09000000-0000-4000-8000-000000000044','09000000-0000-4000-8000-000000000011','09000000-0000-4000-8000-000000000033',
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),'openai','codex-cli',pg_temp.sha('p13-login-s'),
		'09000000-0000-4000-8000-000000000001',clock_timestamp() + interval '50 minutes');
-- The member's model login, which their sign-in completes (its client connection): a capsule for its first version.
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
values ('09000000-0000-4000-8000-000000000051','09000000-0000-4000-8000-000000000010','09000000-0000-4000-8000-000000000243',
	'09000000-0000-4000-8000-000000000002','openai','09000000-0000-4000-8000-000000000002');
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id, provider,
	native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
values ('09000000-0000-4000-8000-000000000052','09000000-0000-4000-8000-000000000010','09000000-0000-4000-8000-000000000032',
	'member','09000000-0000-4000-8000-000000000002','openai','codex-cli','fixture://not-a-credential',repeat('e',64),
	'09000000-0000-4000-8000-000000000002');

-- A login node, as 824 sets up its machine node: the node, its inventory, a fresh ready observation, and the login
-- provider the reservations name.
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('09000000-0000-4000-8000-000000000060');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','09000000-0000-4000-8000-000000000060','machineIdSha256',repeat('9',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','logins','name','l-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','09000000-0000-4000-8000-000000000060','machineIdSha256',repeat('9',64),'label','login-900','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','09000000-0000-4000-8000-000000000060','host',jsonb_build_object('machineIdSha256',repeat('9',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('09000000-0000-4000-8000-000000000060',repeat('9',64),'login','lxd-p13',
		repeat('f',64),2000,4294967296);
end $$;

-- The calls, as the login gateway makes them: a reservation or a release of one allocation of a sign-in or refresh
-- (each allocation its own instance).
create function pg_temp.reserve(p_allocation text, p_kind text, p_id text, p_capability text) returns text language sql as $$
	select format('select public.qorpera_reserve_runtime_%s_machine(%L,%L,%L,%L,%L)::text',
		case p_kind when 'login' then 'login' else 'account_refresh' end, p_allocation, 'lxd-p13', pg_temp.sha(p_allocation), p_id, p_capability)
$$;
create function pg_temp.release(p_allocation text, p_kind text, p_id text) returns text language sql as $$
	select format('select public.qorpera_release_runtime_%s_machine(%L,%L,%L,%L)::text',
		case p_kind when 'login' then 'login' else 'account_refresh' end, p_allocation, 'lxd-p13', pg_temp.sha(p_allocation), p_id)
$$;
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

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['p13_a','p13_b','p13_c']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['p13_a','p13_b','p13_c']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['p13_a','p13_b','p13_c']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;
-- The kind of lock a waiting connection asks for ('advisory', 'transactionid' for a row holder, 'tuple' ...).
create function pg_temp.waiting_on(p_conn text) returns text language sql as $$
	select string_agg(distinct locktype, ',') from pg_locks
	where pid = current_setting('qorpera_test.pid_' || p_conn)::integer and not granted
$$;
create function pg_temp.state(p_value text) returns text language sql as $$
	select case when p_value like 'error %' then p_value else coalesce(p_value::jsonb ->> 'reason', p_value::jsonb ->> 'state') end
$$;

-- The node's observation must be under 60 s old for its node reservation.
select pg_temp.observe();

-- A. A folder effect (the fence and the company row KEY SHARE) never makes a folder-v2 sign-in machine wait: the
-- reservation, the node reservation and the release of a sign-in's machine, and a refresh's, all finish beside it.
select pg_temp.sign_in('09000000-0000-4000-8000-000000000101');
select pg_temp.refresh_request('09000000-0000-4000-8000-000000000102');
do $$
declare v_value text;
begin
	perform dblink_exec('p13_a', 'begin');
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_folder_fences where profile_id = '09000000-0000-4000-8000-000000000010' for key share; end $d$ $q$);
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_profiles where id = '09000000-0000-4000-8000-000000000010' for key share; end $d$ $q$);
	foreach v_value in array array[
		pg_temp.reserve('09000000-0000-4000-8000-000000000071', 'login', '09000000-0000-4000-8000-000000000101',
			pg_temp.cap('09000000-0000-4000-8000-000000000101')),
		-- The gateway's node reservation of the same machine.
		format('select public.qorpera_reserve_runtime_node_machine(%L,%L,%L,%L,%L,%L,%s,%s)::text', '09000000-0000-4000-8000-000000000071',
			'login', 'lxd-p13', repeat('f', 64), pg_temp.sha('09000000-0000-4000-8000-000000000071'), repeat('9', 64), 2000, 4294967296),
		pg_temp.release('09000000-0000-4000-8000-000000000071', 'login', '09000000-0000-4000-8000-000000000101'),
		pg_temp.reserve('09000000-0000-4000-8000-000000000072', 'refresh', '09000000-0000-4000-8000-000000000102',
			pg_temp.cap('09000000-0000-4000-8000-000000000102')),
		pg_temp.release('09000000-0000-4000-8000-000000000072', 'refresh', '09000000-0000-4000-8000-000000000102')] loop
		perform dblink_send_query('p13_b', v_value);
		if not pg_temp.finishes_unblocked('p13_b', 'p13_a') then
			raise exception 'A: a folder-v2 sign-in machine waited behind a folder effect: %', left(v_value, 90); end if;
		v_value := pg_temp.state(pg_temp.result('p13_b'));
		if v_value not in ('reserved', 'released') then raise exception 'A: unexpected outcome %', v_value; end if;
	end loop;
	perform dblink_exec('p13_a', 'rollback');
	if (select count(*) from public.qorpera_runtime_machine_allocations
		where id in ('09000000-0000-4000-8000-000000000071', '09000000-0000-4000-8000-000000000072') and released_at is not null) <> 2 then
		raise exception 'A: both machines must be reserved and released'; end if;
	if not exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = '09000000-0000-4000-8000-000000000071'
		and reserved_at is not null and released_at is not null) then
		raise exception 'A: the login machine''s node demand must be reserved and released'; end if;
end $$;

-- B. A stop's second phase (the fence FOR UPDATE) makes a reservation and a release wait at the fence, holding no
-- sign-in and no member row. A reservation with a wrong capability is refused before any lock: it finishes at once
-- while the stop holds the fence and the sign-in.
select pg_temp.sign_in('09000000-0000-4000-8000-000000000103');
do $$
declare v_value text;
begin
	perform dblink_exec('p13_a', 'begin');
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_folder_fences where profile_id = '09000000-0000-4000-8000-000000000010' for update; end $d$ $q$);
	perform dblink_send_query('p13_b', pg_temp.reserve('09000000-0000-4000-8000-000000000073', 'login',
		'09000000-0000-4000-8000-000000000103', pg_temp.cap('09000000-0000-4000-8000-000000000103')));
	if not pg_temp.waits_for('p13_b', 'p13_a') then raise exception 'B: the reservation must wait for the stop'; end if;
	perform dblink_exec('p13_c', 'begin');
	begin
		perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_native_provider_login_sessions where id = '09000000-0000-4000-8000-000000000103' for update nowait; end $d$ $q$);
		perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_profile_members where profile_id = '09000000-0000-4000-8000-000000000010'
			and user_id = '09000000-0000-4000-8000-000000000001' for update nowait; end $d$ $q$);
	exception when others then
		raise exception 'B: the waiting reservation must hold no sign-in and no member row: %', sqlerrm;
	end;
	perform dblink_exec('p13_c', 'rollback');
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_native_provider_login_sessions where id = '09000000-0000-4000-8000-000000000103' for update; end $d$ $q$);
	perform dblink_send_query('p13_c', pg_temp.reserve('09000000-0000-4000-8000-000000000078', 'login',
		'09000000-0000-4000-8000-000000000103', pg_temp.sha('not-the-capability')));
	if not pg_temp.finishes_unblocked('p13_c', 'p13_a') then raise exception 'B: a wrong capability must not wait'; end if;
	v_value := pg_temp.result('p13_c');
	if v_value not like 'error 42501 %' then raise exception 'B: a wrong capability must refuse: %', v_value; end if;
	perform dblink_exec('p13_a', 'rollback');
	v_value := pg_temp.state(pg_temp.result('p13_b'));
	if v_value is distinct from 'reserved' then raise exception 'B: the reservation must go on once the stop ends: %', v_value; end if;
	-- The release waits at the fence the same way.
	perform dblink_exec('p13_a', 'begin');
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_folder_fences where profile_id = '09000000-0000-4000-8000-000000000010' for update; end $d$ $q$);
	perform dblink_send_query('p13_b', pg_temp.release('09000000-0000-4000-8000-000000000073', 'login', '09000000-0000-4000-8000-000000000103'));
	if not pg_temp.waits_for('p13_b', 'p13_a') then raise exception 'B: the release must wait for the stop'; end if;
	begin
		perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_native_provider_login_sessions where id = '09000000-0000-4000-8000-000000000103' for update nowait; end $d$ $q$);
	exception when others then
		raise exception 'B: the waiting release must hold no sign-in: %', sqlerrm;
	end;
	perform dblink_exec('p13_a', 'rollback');
	v_value := pg_temp.state(pg_temp.result('p13_b'));
	if v_value is distinct from 'released' then raise exception 'B: the release must go on once the stop ends: %', v_value; end if;
end $$;

-- C. Two machines of one identity: a refresh's reservation waits on the identity's machine lock while a sign-in's
-- reservation of the same identity is open, then sees its machine and is refused.
select pg_temp.sign_in('09000000-0000-4000-8000-000000000104');
select pg_temp.refresh_request('09000000-0000-4000-8000-000000000105');
do $$
declare v_value text;
begin
	perform dblink_exec('p13_a', 'begin');
	select r into v_value from dblink('p13_a', pg_temp.reserve('09000000-0000-4000-8000-000000000074', 'login',
		'09000000-0000-4000-8000-000000000104', pg_temp.cap('09000000-0000-4000-8000-000000000104'))) as t(r text);
	if pg_temp.state(v_value) <> 'reserved' then raise exception 'C: the first machine must be reserved: %', v_value; end if;
	perform dblink_send_query('p13_b', pg_temp.reserve('09000000-0000-4000-8000-000000000075', 'refresh',
		'09000000-0000-4000-8000-000000000105', pg_temp.cap('09000000-0000-4000-8000-000000000105')));
	if not pg_temp.waits_for('p13_b', 'p13_a') then raise exception 'C: the second machine must wait for the first'; end if;
	if pg_temp.waiting_on('p13_b') is distinct from 'advisory' then
		raise exception 'C: the second machine must wait on the identity''s machine lock, not %', pg_temp.waiting_on('p13_b'); end if;
	perform dblink_exec('p13_a', 'commit');
	v_value := pg_temp.state(pg_temp.result('p13_b'));
	if v_value <> 'COMPUTE_IDENTITY_OCCUPIED' then raise exception 'C: the second machine must be refused, not %', v_value; end if;
	if (select count(*) from public.qorpera_runtime_machine_allocations where login_compute_identity_id = '09000000-0000-4000-8000-000000000031'
		and released_at is null) <> 1 then
		raise exception 'C: one machine per identity'; end if;
	perform * from dblink('p13_a', pg_temp.release('09000000-0000-4000-8000-000000000074', 'login', '09000000-0000-4000-8000-000000000104')) as t(r text);
end $$;

-- D. A sign-in's completion and a member removal: the completion holds the model login (its upsert) and waits for its
-- version (a held conflicting insert); the removal's prelude takes the model login before the identity, so it waits
-- for the completion holding no identity, and both finish. (Identities first, the completion's epoch trigger would wait
-- for the identity the removal held while the removal waited for the model login: 40P01.)
do $$
declare v_value text;
begin
	perform dblink_exec('p13_c', 'begin');
	perform dblink_exec('p13_c', $q$insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		billing_source, consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy)
		values ('09000000-0000-4000-8000-000000000051', 1, 'native_subscription', 'codex-cli', 'subscription', 'fixture',
		'09000000-0000-4000-8000-000000000002', '09000000-0000-4000-8000-000000000002', '09000000-0000-4000-8000-000000000052', 1,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}')$q$);
	perform dblink_send_query('p13_a', format($q$select public.qorpera_complete_native_provider_login(%L, %L, %L, 'object://native-capsules/p13',
		repeat('b', 64), 'codex-cli:p13', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
		'p13-member@example.test')::text$q$, '09000000-0000-4000-8000-000000000043', pg_temp.sha('p13-login-2'), '09000000-0000-4000-8000-000000000053'));
	if not pg_temp.waits_for('p13_a', 'p13_c') then raise exception 'D: the completion must hold the model login and wait for its version'; end if;
	perform dblink_exec('p13_b', 'begin');
	perform dblink_send_query('p13_b', $q$select 'entered'::text from public.qorpera_folder_member_change_enter('09000000-0000-4000-8000-000000000010',
		'09000000-0000-4000-8000-000000000002', 'remove')$q$);
	if not pg_temp.waits_for('p13_b', 'p13_a') then raise exception 'D: the removal must wait for the completion at the model login'; end if;
	perform dblink_exec('p13_c', 'rollback');
	v_value := pg_temp.result('p13_a');
	if v_value like 'error %' then raise exception 'D: the completion must finish: %', v_value; end if;
	v_value := pg_temp.result('p13_b');
	if v_value is distinct from 'entered' then raise exception 'D: the removal''s prelude must finish: %', v_value; end if;
	perform dblink_exec('p13_b', 'rollback');
end $$;

-- E. The account metadata and a member removal: the removal holds the model login and waits for the identity (held
-- FOR SHARE by a third session); the metadata takes the model login first, so it waits for the removal holding nothing,
-- and all three finish. (Identity first, the metadata would hold it FOR SHARE beside the third session and wait for
-- the model login, and the removal would wait for that identity: 40P01.)
do $$
declare v_value text;
begin
	perform dblink_exec('p13_c', 'begin');
	perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_member_compute_identities where id = '09000000-0000-4000-8000-000000000032' for share; end $d$ $q$);
	perform dblink_exec('p13_b', 'begin');
	perform dblink_send_query('p13_b', $q$select 'entered'::text from public.qorpera_folder_member_change_enter('09000000-0000-4000-8000-000000000010',
		'09000000-0000-4000-8000-000000000002', 'remove')$q$);
	if not pg_temp.waits_for('p13_b', 'p13_c') then raise exception 'E: the removal must hold the model login and wait for the identity'; end if;
	perform dblink_send_query('p13_a', format('select ''recorded''::text from public.qorpera_record_native_provider_account_metadata(%L, %s, %L, 1, %L, %L, null)',
		'09000000-0000-4000-8000-000000000032',
		(select recovery_epoch from public.qorpera_member_compute_identities where id = '09000000-0000-4000-8000-000000000032'),
		'09000000-0000-4000-8000-000000000051', '09000000-0000-4000-8000-000000000053', 'p13-member@example.test'));
	if not pg_temp.waits_for('p13_a', 'p13_b') then raise exception 'E: the metadata must wait for the removal at the model login'; end if;
	perform dblink_exec('p13_c', 'rollback');
	v_value := pg_temp.result('p13_b');
	if v_value is distinct from 'entered' then raise exception 'E: the removal''s prelude must finish: %', v_value; end if;
	perform dblink_exec('p13_b', 'rollback');
	v_value := pg_temp.result('p13_a');
	if v_value is distinct from 'recorded' then raise exception 'E: the metadata must finish: %', v_value; end if;
end $$;

-- F. A sign-in's completion and a run materializer's rank 5 on the same model login (its statements as
-- qorpera_folder_materialize_company takes them: the model logins and their versions FOR UPDATE, then the identities
-- FOR SHARE NOWAIT): the completion waits for the model login and finishes; the materializer never waits. No order can
-- deadlock this pair (the completion's identity locks, KEY SHARE through its capsule and FOR SHARE through its epoch
-- trigger, never conflict with FOR SHARE NOWAIT); it shows the two run beside each other on one model login.
update public.qorpera_native_provider_login_sessions set status = 'pending', completed_at = null,
	expires_at = created_at + interval '55 minutes', capability_sha256 = pg_temp.sha('p13-login-3')
where id = '09000000-0000-4000-8000-000000000043';
do $$
declare v_value text;
begin
	perform dblink_exec('p13_c', 'begin');
	perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_provider_connections where id = '09000000-0000-4000-8000-000000000051' for update; end $d$ $q$);
	perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_provider_connection_versions where connection_id = '09000000-0000-4000-8000-000000000051'
		order by version for update; end $d$ $q$);
	perform dblink_send_query('p13_a', format($q$select public.qorpera_complete_native_provider_login(%L, %L, %L, 'object://native-capsules/p13b',
		repeat('b', 64), 'codex-cli:p13', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
		'p13-member@example.test')::text$q$, '09000000-0000-4000-8000-000000000043', pg_temp.sha('p13-login-3'), '09000000-0000-4000-8000-000000000054'));
	if not pg_temp.waits_for('p13_a', 'p13_c') then raise exception 'F: the completion must wait for the model login'; end if;
	perform dblink_exec('p13_c', $q$do $d$ begin perform 1 from public.qorpera_member_compute_identities where id = '09000000-0000-4000-8000-000000000032' for share nowait; end $d$ $q$);
	perform dblink_exec('p13_c', 'commit');
	v_value := pg_temp.result('p13_a');
	if v_value like 'error %' then raise exception 'F: the completion must finish: %', v_value; end if;
end $$;

-- G. A company without a folder takes no gc fence (the legacy sweep's F2d, 20260930293000): beside a holder of its
-- company row KEY SHARE, its reservation and its release are refused at once at the fence.
do $$
declare v_call text; v_value text;
begin
	perform dblink_exec('p13_a', 'begin');
	perform dblink_exec('p13_a', $q$do $d$ begin perform 1 from public.qorpera_profiles where id = '09000000-0000-4000-8000-000000000011' for key share; end $d$ $q$);
	foreach v_call in array array[pg_temp.reserve('09000000-0000-4000-8000-000000000076', 'login', '09000000-0000-4000-8000-000000000044',
		pg_temp.sha('p13-login-s')), pg_temp.release('09000000-0000-4000-8000-000000000076', 'login', '09000000-0000-4000-8000-000000000044')] loop
		perform dblink_send_query('p13_b', v_call);
		if not pg_temp.finishes_unblocked('p13_b', 'p13_a') then
			raise exception 'G: a machine of a company without a folder waited for its row: %', left(v_call, 60); end if;
		v_value := pg_temp.result('p13_b');
		if v_value is distinct from 'error 42501 Company folder is unavailable' then
			raise exception 'G: a machine of a company without a folder must be refused at the fence, not %', v_value; end if;
	end loop;
	perform dblink_exec('p13_a', 'rollback');
end $$;

-- H. A paused folder-v2 company refuses a new machine and still releases one (no pause read before the locks).
select pg_temp.refresh_request('09000000-0000-4000-8000-000000000106');
select pg_temp.sign_in('09000000-0000-4000-8000-000000000107');
do $$
declare v_value text;
begin
	select r into v_value from dblink('p13_a', pg_temp.reserve('09000000-0000-4000-8000-000000000077', 'refresh',
		'09000000-0000-4000-8000-000000000106', pg_temp.cap('09000000-0000-4000-8000-000000000106'))) as t(r text);
	if pg_temp.state(v_value) is distinct from 'reserved' then raise exception 'H: the machine must be reserved: %', v_value; end if;
end $$;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
values ('09000000-0000-4000-8000-000000000010', '09000000-0000-4000-8000-000000000001');
do $$
declare v_value text;
begin
	select r into v_value from dblink('p13_a', pg_temp.reserve('09000000-0000-4000-8000-000000000079', 'login',
		'09000000-0000-4000-8000-000000000107', pg_temp.cap('09000000-0000-4000-8000-000000000107'))) as t(r text);
	if pg_temp.state(v_value) is distinct from 'COMPANY_PAUSED' then raise exception 'H: a paused company refuses a new machine, not %', v_value; end if;
	select r into v_value from dblink('p13_a', pg_temp.release('09000000-0000-4000-8000-000000000077', 'refresh',
		'09000000-0000-4000-8000-000000000106')) as t(r text);
	if pg_temp.state(v_value) is distinct from 'released' then raise exception 'H: a paused company releases its machine, not %', v_value; end if;
end $$;
delete from public.qorpera_company_execution_pauses where profile_id = '09000000-0000-4000-8000-000000000010';

-- I. Each patched body carries its folder-v2 branch (or, for the member removal and the account metadata, its new
-- order) exactly once: a later create or replace that drops one fails here (folder-v2 only since 3 Oct, so no
-- snapshot-v1 text pins). The node reservation's fence has no branch since the legacy sweep's F2c, and the sign-in
-- machines' none since its F2d: every kind on every company takes it. The helper is postgres-only, refuses a
-- reservation's unknown sign-in or wrong capability before any lock, returns nothing (locking nothing) for a release of
-- an unknown sign-in, and refuses a sign-in of a company without a folder at the fence.
create temporary table p13_patches(n serial, fn text, patched text) on commit preserve rows;
insert into p13_patches(fn, patched) values
	('qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)',
		$p13new$ v_role text; v_reason text; v_placement jsonb; v_folder jsonb;
$p13new$),
	('qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)',
		$p13new$ -- 20260930035000: on folder-v2 the folder fence, rank 0, the requester (rank 1) and the identity's machine lock come
 -- first, then the sign-in (rank 5, before the model logins: C1B §8), and no gc fence.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('login',p_login_id,p_capability_sha256,true);
 select * into v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company).
 if v_folder is distinct from jsonb_build_object('profileId',v_login.profile_id,'computeIdentityId',v_login.compute_identity_id,
  'requestedByUserId',v_login.requested_by_user_id) then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
$p13new$),
	('qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)',
		$p13new$ v_role text; v_reason text; v_placement jsonb; v_folder jsonb;
$p13new$),
	('qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)',
		$p13new$ -- 20260930035000: on folder-v2 the folder fence, rank 0, the requester (rank 1) and the identity's machine lock come
 -- first, then the sign-in (rank 5, before the model logins: C1B §8), and no gc fence.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('account_refresh',p_request_id,p_capability_sha256,true);
 select * into v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company).
 if v_folder is distinct from jsonb_build_object('profileId',v_login.profile_id,'computeIdentityId',v_login.compute_identity_id,
  'requestedByUserId',v_login.requested_by_user_id) then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
$p13new$),
	('qorpera_release_runtime_login_machine(uuid,text,text,uuid)',
		$p13new$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz; v_folder jsonb;
$p13new$),
	('qorpera_release_runtime_login_machine(uuid,text,text,uuid)',
		$p13new$ -- 20260930035000: on folder-v2 the folder fence and rank 0 come first, then the sign-in, and no gc fence; no pause
 -- read, so a paused company's sign-in machines are released.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('login',p_login_id,null,false);
 select * into strict v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company); a
 -- sign-in they did not find yet is refused here.
 if (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
  raise exception 'Login machine deletion identity differs' using errcode='42501'; end if;
$p13new$),
	('qorpera_release_runtime_account_refresh_machine(uuid,text,text,uuid)',
		$p13new$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz; v_folder jsonb;
$p13new$),
	('qorpera_release_runtime_account_refresh_machine(uuid,text,text,uuid)',
		$p13new$ -- 20260930035000: on folder-v2 the folder fence and rank 0 come first, then the sign-in, and no gc fence; no pause
 -- read, so a paused company's sign-in machines are released.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('account_refresh',p_request_id,null,false);
 select * into strict v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company); a
 -- sign-in they did not find yet is refused here.
 if (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
  raise exception 'Login machine deletion identity differs' using errcode='42501'; end if;
$p13new$),
	('qorpera_folder_member_change_enter(uuid,uuid,text)',
		$p13new$		-- Rank 5 in C1B §8's order (20260930035000): the member's model logins, then its compute identities (revoked and
		-- retired by the triggers), as a sign-in's completion and the run materializer take them.
		perform 1 from public.qorpera_provider_connections where profile_id = p_profile_id and owner_user_id = p_user_id
			and status <> 'revoked' order by id for no key update;
		perform 1 from public.qorpera_member_compute_identities where profile_id = p_profile_id and ownership_kind = 'member'
			and owner_user_id = p_user_id and status <> 'retired' order by id for no key update;
$p13new$),
	('qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text)',
		$p13new$    -- 20260930035000: the model login, its version and capsule, then the identity (C1B §8 rank 5), as a member removal
    -- takes them.
    perform 1 from public.qorpera_provider_connections c
      join public.qorpera_provider_connection_versions v on v.connection_id = c.id and v.version = p_connection_version
      join public.qorpera_native_credential_capsules capsule on capsule.id = v.credential_capsule_id
      where c.id = p_connection_id and c.status = 'active' and v.authorization_state = 'active'
        and c.provider = 'openai' and v.native_harness = 'codex-cli' and v.authentication_mode = 'native_subscription'
        and capsule.id = p_credential_capsule_id and capsule.status = 'active'
        and capsule.compute_identity_id = p_compute_identity_id
        and not exists(select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = c.id and newer.version > v.version)
      for share of c, v, capsule;
    if not found then raise exception 'Account metadata connection unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_member_compute_identities i where i.id = p_compute_identity_id
      and i.status = 'active' and i.recovery_pending_id is null and i.recovery_epoch = p_recovery_epoch for share;
    if not found then raise exception 'Account metadata identity unavailable' using errcode = '42501'; end if;
$p13new$),
	('qorpera_folder_sign_in_machine_locks(text,uuid,text,boolean)',
		$p13new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so a sign-in of any company takes the fence below, and one
	-- of a company without a folder fails in it (42501). Null now means only that the sign-in is unknown.
	if v_profile is null then
		return null; end if;
	perform public.qorpera_folder_machine_fence(v_profile);
$p13new$),
	('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
		$p13new$ -- office kind. 20260930035000: a sign-in's or refresh's login machine too (the gateway's own call, after the
 -- company reservation). C1c-3n (20260930046000): a run's machine (its company reservation took the identity's
 -- machine lock). Legacy sweep F2c (20260930292000): folder-v2 only, so every kind on every company takes it.
 perform public.qorpera_folder_machine_fence(v_profile);
$p13new$);
do $$
declare v_bad text[]; v_value text;
begin
	if (select count(*) from p13_patches) <> 12 then raise exception 'I: the patch table is incomplete'; end if;
	select array_agg(fn order by n) into v_bad from p13_patches
	where (length(pg_get_functiondef(('public.' || fn)::regprocedure))
		- length(replace(pg_get_functiondef(('public.' || fn)::regprocedure), patched, ''))) / length(patched) <> 1;
	if v_bad is not null then raise exception 'I: a patched branch is missing in: %', v_bad; end if;
	if has_function_privilege('anon', 'public.qorpera_folder_sign_in_machine_locks(text,uuid,text,boolean)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_sign_in_machine_locks(text,uuid,text,boolean)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_sign_in_machine_locks(text,uuid,text,boolean)', 'execute') then
		raise exception 'I: the helper must be postgres-only'; end if;
	if public.qorpera_folder_sign_in_machine_locks('login', extensions.gen_random_uuid(), null, false) is not null then
		raise exception 'I: a release of an unknown sign-in takes no folder lock'; end if;
	begin
		perform public.qorpera_folder_sign_in_machine_locks('login', '09000000-0000-4000-8000-000000000044', pg_temp.sha('p13-login-s'), true);
		raise exception 'I: a sign-in of a company without a folder must be refused at the fence';
	exception when sqlstate '42501' then
		if sqlerrm <> 'Company folder is unavailable' then raise; end if;
	end;
	foreach v_value in array array['09000000-0000-4000-8000-000000000107', extensions.gen_random_uuid()::text] loop
		begin
			perform public.qorpera_folder_sign_in_machine_locks('login', v_value::uuid, pg_temp.sha('wrong'), true);
			raise exception 'I: a reservation with a wrong capability or of an unknown sign-in must be refused';
		exception when sqlstate '42501' then null;
		end;
	end loop;
end $$;

select dblink_disconnect(name) from unnest(array['p13_a','p13_b','p13_c']) name;

-- Remove the fixture: the login node, then the two companies' rows.
set session_replication_role = replica;
do $$
declare v_table record; v_profiles uuid[] := array['09000000-0000-4000-8000-000000000010', '09000000-0000-4000-8000-000000000011']::uuid[];
begin
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '09000000-0000-4000-8000-000000000060'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '09000000-0000-4000-8000-000000000060';
	delete from public.qorpera_runtime_node_placements where allocation_id in (select id from public.qorpera_runtime_machine_allocations
		where profile_id = any (v_profiles));
	delete from public.qorpera_native_provider_account_metadata where connection_id = '09000000-0000-4000-8000-000000000051';
	delete from public.qorpera_provider_connection_versions where connection_id = '09000000-0000-4000-8000-000000000051';
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id') and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles
			else array['09000000-0000-4000-8000-000000000020']::uuid[] end;
	end loop;
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from auth.users where id in ('09000000-0000-4000-8000-000000000001','09000000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id in ('09000000-0000-4000-8000-000000000010', '09000000-0000-4000-8000-000000000011'))
		or exists (select 1 from public.qorpera_runtime_nodes where id = '09000000-0000-4000-8000-000000000060')
		or exists (select 1 from public.qorpera_runtime_machine_allocations where profile_id in ('09000000-0000-4000-8000-000000000010',
			'09000000-0000-4000-8000-000000000011'))
		or exists (select 1 from public.qorpera_company_files where environment_id = '09000000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_member_compute_identities where id in ('09000000-0000-4000-8000-000000000031',
			'09000000-0000-4000-8000-000000000032', '09000000-0000-4000-8000-000000000033')) then
		raise exception 'The sign-in machine fixture must be removed'; end if;
end $$;
