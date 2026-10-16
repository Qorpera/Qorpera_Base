begin;
-- F3 step 5e-3a (20260930397000): the code hosts in a node's inventory. A policy may declare
-- codeHosts {imageFingerprint, storagePool, cpus, memoryBytes, rootDiskBytes, running}: running of that size are always
-- counted against headroom, and no infrastructure or build space sits in a code host project. The registry accepts
-- `code-host` entries only as code-host in a qorpera-codehost-<32 hex> project under such a policy, never with an
-- allocation, of the policy's size, at most `running` of them not stopped; anything else in a code host project is
-- unmanaged and keeps the node unavailable. Policies without codeHosts behave as before.
create function pg_temp.claims(p_role text) returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true)::text::void $$;
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

-- Two code hosts of 2 vCPU / 4 GiB with a 20 GiB disk; p_change edits the block.
create function pg_temp.hosts(p_change jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('imageFingerprint',repeat('c',64),'storagePool','default','cpus',2,'memoryBytes',4294967296,
		'rootDiskBytes',21474836480,'running',2) || p_change
$$;
create function pg_temp.policy(p_hosts jsonb,p_infrastructure jsonb default '[]',p_build jsonb default null) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1','nodeId','49300000-0000-4000-8000-000000000001',
		'host',jsonb_build_object('machineIdSha256',repeat('4',64),'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',101,
			'certificateSha256',repeat('e',64),'serverName','node-a','serverVersion','6.9','architecture','x86_64'),
		'operatingCpuMillis',4000,'operatingMemoryBytes',4294967296,'infrastructure',p_infrastructure)
		|| case when p_hosts is null then '{}'::jsonb else jsonb_build_object('codeHosts',p_hosts) end
		|| case when p_build is null then '{}'::jsonb else jsonb_build_object('buildSpace',p_build) end
$$;
create function pg_temp.enroll(p_policy jsonb) returns text language sql as $$
	select format('select public.qorpera_enroll_runtime_node_inventory(%L::jsonb)',p_policy)
$$;
-- A company's code host as the observer reports it.
create function pg_temp.host(p_company text,p_state text default 'running',p_cpu bigint default 2000,p_memory bigint default 4294967296,
	p_reason text default null) returns jsonb language sql as $$
	select jsonb_build_object('project','qorpera-codehost-'||repeat(p_company,32),'name','code-host','physicalId',extensions.gen_random_uuid(),
		'type','virtual-machine','state',p_state,'configurationSha256',repeat('b',64),'cpuMillis',p_cpu,'memoryBytes',p_memory,
		'allocation',null,'category','code-host','reason',p_reason)
$$;
create function pg_temp.observe(p_state text,p_entries jsonb) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','49300000-0000-4000-8000-000000000001','machineIdSha256',repeat('4',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state',p_state),
		public.qorpera_runtime_node_inventory_context('49300000-0000-4000-8000-000000000001') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',p_entries))
$$;
create function pg_temp.ready() returns boolean language sql as $$
	select public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
	from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_observations o on o.node_id = n.id
	where n.id = '49300000-0000-4000-8000-000000000001'
$$;
create function pg_temp.state() returns text language sql as $$
	select observation->>'state' from public.qorpera_runtime_node_observations where node_id = '49300000-0000-4000-8000-000000000001'
$$;
create function pg_temp.node(p_headroom_cpu bigint) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','49300000-0000-4000-8000-000000000001','machineIdSha256',repeat('4',64),'label','node-a','cpuMillis',32000,
		'memoryBytes',68719476736,'headroomCpuMillis',p_headroom_cpu,'headroomMemoryBytes',17179869184,'standardCpuMillis',4000,
		'standardMemoryBytes',8589934592,'enabled',true)
$$;

select pg_temp.claims('service_role');
set local role service_role;
-- 32 vCPU / 64 GiB, headroom 12 vCPU / 16 GiB: host 4 vCPU / 4 GiB plus two code hosts of 2 vCPU / 4 GiB.
select public.qorpera_configure_runtime_node(pg_temp.node(12000),0);

-- Enrolment: the block's shape and bounds are strict.
select pg_temp.fails(pg_temp.enroll(pg_temp.policy('"default"')),'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts()-'running')),'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"network":"qorpera0"}'))),'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts(jsonb_build_object('imageFingerprint',repeat('C',64))))),
	'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts(jsonb_build_object('imageFingerprint',repeat('c',63))))),
	'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"storagePool":"../p"}'))),'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"storagePool":1}'))),'Invalid node inventory policy');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts(change))),'Invalid node inventory policy')
from unnest(array['{"cpus":0}','{"cpus":65}','{"cpus":"2"}','{"cpus":1.5}','{"cpus":-1}','{"cpus":null}',
	'{"memoryBytes":0}','{"memoryBytes":4294967297}','{"memoryBytes":536870912}','{"memoryBytes":1100585369600}',
	'{"rootDiskBytes":9663676416}','{"rootDiskBytes":21474836481}','{"rootDiskBytes":2200096997376}',
	'{"running":0}','{"running":65}','{"running":true}']::jsonb[]) change;
-- The bounds themselves are accepted (1 vCPU / 1 GiB / 10 GiB; 64 / 1024 GiB / 2048 GiB need more headroom than this node has).
savepoint bounds;
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(pg_temp.hosts('{"cpus":1,"memoryBytes":1073741824,"rootDiskBytes":10737418240,"running":1}')));
rollback to savepoint bounds;
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"cpus":64,"memoryBytes":1099511627776,"rootDiskBytes":2199023255552,"running":64}'))),
	'Infrastructure exceeds reserved headroom or duplicates identity');
-- `running` code hosts count against headroom: five of 2 vCPU, or two of 8 GiB, do not fit.
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"running":5}'))),
	'Infrastructure exceeds reserved headroom or duplicates identity');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts('{"memoryBytes":8589934592}'))),
	'Infrastructure exceeds reserved headroom or duplicates identity');
-- Neither infrastructure nor the build space sits in a code host project.
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(pg_temp.hosts(),
	jsonb_build_array(jsonb_build_object('project','qorpera-codehost-'||repeat('a',32),'name','exec','physicalId','49300000-0000-4000-8000-0000000000e1',
		'type','virtual-machine','configurationSha256',repeat('c',64),'cpuMillis',1000,'memoryBytes',1073741824)))),
	'Infrastructure exceeds reserved headroom or duplicates identity');
select pg_temp.fails(pg_temp.enroll(pg_temp.policy(null,'[]',
	jsonb_build_object('project','qorpera-codehost-'||repeat('a',32),'network','qorpera0','cpuMillis',1000,'memoryBytes',1073741824))),
	'Infrastructure exceeds reserved headroom or duplicates identity');
-- Rollout direction: the node starts without code hosts, then its policy is replaced with them.
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(null));
reset role;
select set_config('qorpera_test.policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '49300000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(pg_temp.hosts()),current_setting('qorpera_test.policy'));

-- Two companies' code hosts running and a third's stopped: the node stays ready.
select pg_temp.observe('ready','[]');
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready without a code host');
set local role service_role;
select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a'),pg_temp.host('b','starting'),pg_temp.host('d','suspended')));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready with two code hosts running and one stopped');
set local role service_role;

-- More than `running` not stopped, or reported as beyond the space: not ready, and recorded when reported honestly.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a'),pg_temp.host('b'),pg_temp.host('d','stopping')))$q$,
	'Node inventory is not ready');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.host('a'),pg_temp.host('b'),
	pg_temp.host('d','stopping',p_reason=>'CODE_HOST_SPACE_EXCEEDED')));
reset role;
select pg_temp.ok(pg_temp.state() = 'unavailable','Beyond the code hosts'' space the node is published unavailable');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a',p_reason=>'CODE_HOST_SPACE_EXCEEDED')))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a','suspended',p_reason=>'INSTANCE_AUTHORITY_DIFFERS')))$q$,
	'Node inventory is not ready');
-- Not the policy's size or kind: not ready.
select pg_temp.fails(format('select pg_temp.observe(%L,%L::jsonb)','ready',jsonb_build_array(entry)),'Node inventory is not ready')
from unnest(array[pg_temp.host('a',p_cpu=>3000),pg_temp.host('a',p_cpu=>1000),pg_temp.host('a',p_memory=>8589934592),
	pg_temp.host('a',p_cpu=>null),pg_temp.host('a','suspended',p_memory=>null),pg_temp.host('a') || '{"type":"container"}',
	pg_temp.host('a') || '{"physicalId":null}',pg_temp.host('a','unavailable')]) entry;
select pg_temp.observe('ready','[]');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.host('a',p_cpu=>3000)));
reset role;
select pg_temp.ok((select o.observation->>'state' = 'unavailable' and r.inventory->'entries'->0->>'cpuMillis' = '3000'
	from public.qorpera_runtime_node_observations o join public.qorpera_runtime_node_inventory_receipts r
		on r.node_id = o.node_id and r.observation_id = o.observation_id
	where o.node_id = '49300000-0000-4000-8000-000000000001'),'The wrong size is recorded and the node is unavailable');
set local role service_role;

-- Never an allocation; only code-host in a code host project; nothing but a code host as code-host.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a')
	|| jsonb_build_object('allocation',jsonb_build_object('allocationId',extensions.gen_random_uuid()))))$q$,
	'A code host cannot claim an allocation');
select pg_temp.fails(format('select pg_temp.observe(%L,%L::jsonb)','unavailable',jsonb_build_array(entry)),
	'Node inventory mixes the code hosts with other instances')
from unnest(array[pg_temp.host('a') || '{"name":"other"}',pg_temp.host('a') || '{"project":"qn25b2"}',
	pg_temp.host('a') || '{"project":"qorpera-codehost-abc"}',pg_temp.host('a') || '{"category":"infrastructure"}',
	pg_temp.host('a') || '{"category":"build"}',
	pg_temp.host('a') || jsonb_build_object('category','managed','allocation',jsonb_build_object('allocationId',extensions.gen_random_uuid()))]) entry;
-- Anything else in a code host project stays unmanaged: the node is unavailable, honestly.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a')
	|| '{"name":"stray","category":"unmanaged","reason":"UNREGISTERED_INSTANCE"}'::jsonb))$q$,'Node inventory is not ready');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.host('a'),pg_temp.host('a')
	|| jsonb_build_object('name','stray','physicalId',extensions.gen_random_uuid(),'category','unmanaged','reason','UNREGISTERED_INSTANCE')));
reset role;
select pg_temp.ok(pg_temp.state() = 'unavailable','A stray instance in a code host project is recorded and the node is unavailable');
set local role service_role;

-- The headroom the node keeps back must still cover the code hosts: lowered below it, the node is not ready.
reset role;
select set_config('qorpera_test.node_version',(select version::text from public.qorpera_runtime_nodes
	where id = '49300000-0000-4000-8000-000000000001'),true);
set local role service_role;
savepoint headroom;
select public.qorpera_configure_runtime_node(pg_temp.node(7000),current_setting('qorpera_test.node_version')::bigint);
select pg_temp.fails($q$select pg_temp.observe('ready','[]')$q$,'Node inventory is not ready');
rollback to savepoint headroom;
select pg_temp.observe('ready','[]');
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready again with the headroom that covers the code hosts');
set local role service_role;

-- Without codeHosts a code-host entry is refused outright, and a code host project's instance keeps the node
-- unavailable, as before.
reset role;
select set_config('qorpera_test.policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '49300000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(null),current_setting('qorpera_test.policy'));
select pg_temp.fails($q$select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.host('a','suspended')))$q$,
	'Node inventory mixes the code hosts with other instances');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.host('a','suspended')
	|| '{"category":"unmanaged","reason":"UNREGISTERED_INSTANCE"}'::jsonb))$q$,'Node inventory is not ready');
select pg_temp.observe('ready','[]');
reset role;
select pg_temp.ok(pg_temp.ready(),'A policy without code hosts works as before');
rollback;
