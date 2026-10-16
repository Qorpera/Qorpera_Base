begin;
-- 2026-09-27: a shared execution host's identity devices. The node's login
-- gateway attaches each Compute Identity volume it creates to the host; the
-- observer leaves those devices out of the host's digest and reports them as
-- the entry's `identities`. The registry accepts an identity only when this
-- node reserved a login machine for it, which is when the gateway creates its
-- volume. Login machines below are reserved through the real
-- qorpera_reserve_runtime_login_machine and qorpera_reserve_runtime_node_machine.
-- The company is on the folder core: since the legacy sweep's F2c (20260930292000)
-- every machine takes the folder fence, so a company without a folder gets none.
create function pg_temp.claims(p_role text,p_user uuid default null) returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void $$;
create function pg_temp.ok(p_value boolean,p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.fails(p_statement text,p_message text) returns void language plpgsql as $$
declare v_message text;
begin
	begin execute p_statement; exception when others then get stacked diagnostics v_message = message_text;
		if v_message not like p_message then raise exception 'Expected "%", got "%" for %',p_message,v_message,p_statement; end if;
		return; end;
	raise exception 'Accepted: %',p_statement;
end $$;

insert into auth.users(id,email) values
	('40600000-0000-4000-8000-000000000001','ehi-owner@example.test'),
	('40600000-0000-4000-8000-000000000002','ehi-member@example.test'),
	('40600000-0000-4000-8000-000000000003','ehi-other@example.test'),
	('40600000-0000-4000-8000-000000000004','ehi-away@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
	values ('40600000-0000-4000-8000-000000000010','Exec host identity fixture','40600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('40600000-0000-4000-8000-000000000010','40600000-0000-4000-8000-000000000001','ehi-owner@example.test','Owner','owner'),
	('40600000-0000-4000-8000-000000000010','40600000-0000-4000-8000-000000000002','ehi-member@example.test','Member','contributor'),
	('40600000-0000-4000-8000-000000000010','40600000-0000-4000-8000-000000000003','ehi-other@example.test','Other','contributor'),
	('40600000-0000-4000-8000-000000000010','40600000-0000-4000-8000-000000000004','ehi-away@example.test','Away','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('40600000-0000-4000-8000-000000000020','40600000-0000-4000-8000-000000000010','Environment',1,'40600000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{"role":"service_role"}',true) \g /dev/null
select public.qorpera_folder_enable('40600000-0000-4000-8000-000000000020') \g /dev/null
-- Identities: a1 logs in on the exec host's node, a2 never logs in anywhere, a3 logs in on another node.
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,client_identity_id,display_name) values
	('40600000-0000-4000-8000-0000000000a1','40600000-0000-4000-8000-000000000010','member','40600000-0000-4000-8000-000000000002','40600000-0000-4000-8000-0000000000a1','Member identity'),
	('40600000-0000-4000-8000-0000000000a2','40600000-0000-4000-8000-000000000010','member','40600000-0000-4000-8000-000000000003','40600000-0000-4000-8000-0000000000a2','Idle identity'),
	('40600000-0000-4000-8000-0000000000a3','40600000-0000-4000-8000-000000000010','member','40600000-0000-4000-8000-000000000004','40600000-0000-4000-8000-0000000000a3','Away identity');

-- Two nodes, each with a login provider and an inventory policy; node 2 carries the exec host.
create function pg_temp.node(p_n integer) returns uuid language sql as $$ select ('40600000-0000-4000-8000-00000000010' || p_n)::uuid $$;
create function pg_temp.host(p_n integer) returns text language sql as $$ select repeat(p_n::text,64) $$;
create function pg_temp.exec_entry(p_sha text,p_declared boolean) returns jsonb language sql as $$
	select jsonb_build_object('project','qn25b2','name','qorpera-exec-node02','physicalId','40600000-0000-4000-8000-0000000000e1',
		'type','virtual-machine','configurationSha256',p_sha,'cpuMillis',4000,'memoryBytes',8589934592)
		|| case when p_declared then '{"identityVolumes":{"pool":"qorpera-vm","sourcePrefix":"phql-a1-identity-"}}'::jsonb else '{}'::jsonb end
$$;
create function pg_temp.policy(p_n integer,p_infrastructure jsonb) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1','nodeId',pg_temp.node(p_n),
		'host',jsonb_build_object('machineIdSha256',pg_temp.host(p_n),'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',101,
			'certificateSha256',repeat('e',64),'serverName','node-' || p_n,'serverVersion','6.9','architecture','x86_64'),
		'operatingCpuMillis',4000,'operatingMemoryBytes',4294967296,'infrastructure',p_infrastructure)
$$;
-- One observation of node p_n; p_entry is the exec host's inventory entry (or null for none).
create function pg_temp.observe(p_n integer,p_state text,p_entry jsonb) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',pg_temp.node(p_n),'machineIdSha256',pg_temp.host(p_n),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state',p_state),
		public.qorpera_runtime_node_inventory_context(pg_temp.node(p_n)) ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),
			'entries',case when p_entry is null then '[]'::jsonb else jsonb_build_array(p_entry) end))
$$;
create function pg_temp.entry(p_sha text,p_identities jsonb) returns jsonb language sql as $$
	select pg_temp.exec_entry(p_sha,false) || jsonb_build_object('state','running','allocation',null,'category','infrastructure','reason',null)
		|| case when p_identities is null then '{}'::jsonb else jsonb_build_object('identities',p_identities) end
$$;
-- Placement eligibility needs a fresh ready observation with an inventory receipt of the current policy.
create function pg_temp.ready(p_n integer) returns boolean language sql as $$
	select public.qorpera_runtime_node_capacity(pg_temp.node(p_n)) ->> 'state' = 'eligible'
$$;
-- A member's sign-in on the login provider of node p_n, reserved as the node's login gateway does it.
create function pg_temp.login(p_user uuid,p_identity uuid,p_n integer,p_allocation uuid) returns jsonb language plpgsql as $$
declare v_login uuid;
begin
	perform pg_temp.claims('authenticated',p_user);
	set local role authenticated;
	v_login := (public.qorpera_begin_native_provider_login('40600000-0000-4000-8000-000000000010',extensions.gen_random_uuid(),
		extensions.gen_random_uuid(),p_identity,'openai','codex-cli',repeat('1',64),3600) ->> 'login_id')::uuid;
	reset role;
	perform pg_temp.claims('service_role');
	set local role service_role;
	perform pg_temp.ok(public.qorpera_reserve_runtime_login_machine(p_allocation,'login-node-' || p_n,repeat('9',64),v_login,repeat('1',64))
		->> 'state' = 'reserved','Login machine reserved');
	return public.qorpera_reserve_runtime_node_machine(p_allocation,'login','login-node-' || p_n,repeat('f',64),repeat('9',64),
		pg_temp.host(p_n),2000,4294967296);
end $$;

select pg_temp.claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',pg_temp.node(n),
	'machineIdSha256',pg_temp.host(n),'label','ehi-node-' || n,'cpuMillis',32000,'memoryBytes',68719476736,
	'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,'standardCpuMillis',8000,'standardMemoryBytes',17179869184,'enabled',true),0)
from generate_series(1,2) n;
select public.qorpera_enroll_runtime_node_provider(pg_temp.node(n),pg_temp.host(n),'login','login-node-' || n,repeat('f',64),2000,4294967296)
from generate_series(1,2) n;

-- Policy validation: identityVolumes only on a virtual machine, exactly {pool, sourcePrefix}, the gateway's name rules.
select pg_temp.fails(format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',
	pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),true) || '{"type":"container"}'))),'Invalid infrastructure inventory policy');
select pg_temp.fails(format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',
	pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false)
		|| '{"identityVolumes":{"pool":"qorpera-vm","sourcePrefix":"phql-a1-identity-","path":"/"}}'))),'Invalid infrastructure inventory policy');
select pg_temp.fails(format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',
	pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false)
		|| '{"identityVolumes":{"pool":"qorpera-vm","sourcePrefix":"../identity-"}}'))),'Invalid infrastructure inventory policy');
select pg_temp.fails(format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',
	pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false)
		|| '{"identityVolumes":{"pool":["qorpera-vm"],"sourcePrefix":"phql-a1-identity-"}}'))),'Invalid infrastructure inventory policy');
select pg_temp.fails(format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',
	pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false) || '{"identityVolumes":"qorpera-vm"}'))),'Invalid infrastructure inventory policy');

-- Before the cut: the exec host is plain infrastructure, and an observer that sends no identities is unchanged.
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(1,'[]'));
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false))));
select pg_temp.observe(1,'ready',null);
select pg_temp.observe(2,'ready',pg_temp.entry(repeat('a',64),null));
select pg_temp.ok(pg_temp.ready(1) and pg_temp.ready(2),'Both nodes ready before the cut');
select pg_temp.ok(not public.qorpera_runtime_node_inventory_context(pg_temp.node(n)) ? 'acceptedIdentities',
	'A node without an identity host gets the context it always got') from generate_series(1,2) n;
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('a',64),'[]'))$q$,
	'Node inventory reports identity devices its policy does not declare');

-- The cut: the operator declares the exec host an identity host with the new-rule digest.
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('b',64),true))),
	encode(extensions.digest(pg_temp.policy(2,jsonb_build_array(pg_temp.exec_entry(repeat('a',64),false)))::text,'sha256'),'hex'));
select pg_temp.ok(public.qorpera_runtime_node_inventory_context(pg_temp.node(2)) -> 'acceptedIdentities' = '[]',
	'The identity host context names the accepted identities: none yet');
select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'[]'));
select pg_temp.ok(pg_temp.ready(2),'An identity host with no identity devices is ready');
-- An old observer (no identities) against the declaring policy never reads ready.
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),null))$q$,'Node inventory is not ready');

-- a1 signs in on node 2 and a3 on node 1: each node reserves a login machine, and only then does a gateway create a volume.
reset role;
select pg_temp.ok(pg_temp.login('40600000-0000-4000-8000-000000000002','40600000-0000-4000-8000-0000000000a1',2,
	'40600000-0000-4000-8000-0000000000c1') ->> 'state' = 'reserved','a1 login machine reserved on node 2');
reset role;
select pg_temp.ok(pg_temp.login('40600000-0000-4000-8000-000000000004','40600000-0000-4000-8000-0000000000a3',1,
	'40600000-0000-4000-8000-0000000000c3') ->> 'state' = 'reserved','a3 login machine reserved on node 1');
reset role;
select pg_temp.claims('service_role');
set local role service_role;

select pg_temp.ok(public.qorpera_runtime_node_inventory_context(pg_temp.node(2)) -> 'acceptedIdentities'
	= '["40600000-0000-4000-8000-0000000000a1"]','Node 2 accepts exactly the identity it reserved a login machine for');
select pg_temp.ok(not public.qorpera_runtime_node_inventory_context(pg_temp.node(1)) ? 'acceptedIdentities',
	'Node 1 (no identity host) is unchanged by its login machine');

-- The digest is unchanged by the attach; the reported identity is this node's own login.
select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a1"]'));
select pg_temp.ok(pg_temp.ready(2),'The exec host with a1 attached is ready');
reset role;
select pg_temp.ok((select r.inventory -> 'entries' -> 0 -> 'identities' from public.qorpera_runtime_node_inventory_receipts r
	join public.qorpera_runtime_node_observations o on o.node_id = r.node_id and o.observation_id = r.observation_id
	where r.node_id = pg_temp.node(2)) = '["40600000-0000-4000-8000-0000000000a1"]','The receipt keeps the attached identity set');
select pg_temp.claims('service_role');
set local role service_role;

-- Anything else is refused: an identity with no login anywhere, one whose login machine is on another node, one that does not exist.
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),
	'["40600000-0000-4000-8000-0000000000a1","40600000-0000-4000-8000-0000000000a2"]'))$q$,'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a3"]'))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000ff"]'))$q$,
	'Node inventory is not ready');
select pg_temp.observe(2,'unavailable',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a2"]'));
select pg_temp.ok(not pg_temp.ready(2),'An unexplained identity publishes the node unavailable');
-- Every other difference stays exact.
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('c',64),'["40600000-0000-4000-8000-0000000000a1"]'))$q$,
	'Node inventory is not ready');

-- The report is canonical: distinct, sorted, lower-case identity ids, and only on infrastructure.
select pg_temp.fails(format('select pg_temp.observe(2,%L,%L::jsonb)','unavailable',pg_temp.entry(repeat('b',64),v::jsonb)),'Invalid node inventory entry')
from unnest(array[
	'["40600000-0000-4000-8000-0000000000a1","40600000-0000-4000-8000-0000000000a1"]',
	'["40600000-0000-4000-8000-0000000000a3","40600000-0000-4000-8000-0000000000a1"]',
	'["40600000-0000-4000-8000-0000000000A1"]',
	'[1]',
	'"40600000-0000-4000-8000-0000000000a1"',
	'{"a1":true}']) v;
select pg_temp.fails(format('select pg_temp.observe(2,%L,%L::jsonb)','unavailable',
	pg_temp.entry(repeat('b',64),'[]') || '{"category":"unmanaged","reason":"UNREGISTERED_INSTANCE"}'),'Invalid node inventory entry');
select pg_temp.fails(format('select pg_temp.observe(2,%L,%L::jsonb)','unavailable',
	pg_temp.entry(repeat('b',64),'[]') || jsonb_build_object('identities',(select jsonb_agg(extensions.gen_random_uuid()) from generate_series(1,4097)))),
	'Invalid node inventory entry');

-- The login ends: its machine and node demand are released, as after every completed sign-in. Still accepted.
reset role;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '40600000-0000-4000-8000-0000000000c1';
update public.qorpera_runtime_node_demands set released_at = clock_timestamp() where allocation_id = '40600000-0000-4000-8000-0000000000c1';
select pg_temp.claims('service_role');
set local role service_role;
select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a1"]'));
select pg_temp.ok(pg_temp.ready(2),'A released login machine still accepts its identity');
reset role;

-- A member who leaves keeps the node ready: the identity is retired, its volume still mounted until an operator detaches it.
reset role;
delete from public.qorpera_profile_members where profile_id = '40600000-0000-4000-8000-000000000010' and user_id = '40600000-0000-4000-8000-000000000002';
select pg_temp.ok((select status from public.qorpera_member_compute_identities where id = '40600000-0000-4000-8000-0000000000a1') = 'retired',
	'The member identity is retired');
select pg_temp.claims('service_role');
set local role service_role;
select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a1"]'));
select pg_temp.ok(pg_temp.ready(2),'A retired identity still attached keeps the node ready');
reset role;

-- A login that was never reserved on the node (refused or still waiting) gives no volume and no acceptance.
update public.qorpera_runtime_node_demands set reserved_at = null, released_at = null where allocation_id = '40600000-0000-4000-8000-0000000000c1';
select pg_temp.claims('service_role');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe(2,'ready',pg_temp.entry(repeat('b',64),'["40600000-0000-4000-8000-0000000000a1"]'))$q$,
	'Node inventory is not ready');
reset role;
rollback;
