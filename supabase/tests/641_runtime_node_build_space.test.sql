begin;
-- Identical nodes, change 2 (20260928180500): an image build space that keeps the node serving.
-- A policy may declare buildSpace {project, network, cpuMillis, memoryBytes}: always counted against headroom,
-- never next to an infrastructure entry. The registry accepts `build` entries only in that project,
-- never with an allocation, together within the space; nothing in the build project may stay
-- unclassified. Policies without a build space behave as before.
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

create function pg_temp.policy(p_build jsonb,p_infrastructure jsonb default '[]') returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1','nodeId','64100000-0000-4000-8000-000000000001',
		'host',jsonb_build_object('machineIdSha256',repeat('4',64),'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',101,
			'certificateSha256',repeat('e',64),'serverName','node-a','serverVersion','6.9','architecture','x86_64'),
		'operatingCpuMillis',4000,'operatingMemoryBytes',4294967296,'infrastructure',p_infrastructure)
		|| case when p_build is null then '{}'::jsonb else jsonb_build_object('buildSpace',p_build) end
$$;
create function pg_temp.build(p_project text,p_name text,p_cpu bigint,p_memory bigint,p_reason text default null) returns jsonb language sql as $$
	select jsonb_build_object('project',p_project,'name',p_name,'physicalId',extensions.gen_random_uuid(),'type','virtual-machine',
		'state','running','configurationSha256',repeat('b',64),'cpuMillis',p_cpu,'memoryBytes',p_memory,'allocation',null,
		'category','build','reason',p_reason)
$$;
create function pg_temp.observe(p_state text,p_entries jsonb) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','64100000-0000-4000-8000-000000000001','machineIdSha256',repeat('4',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state',p_state),
		public.qorpera_runtime_node_inventory_context('64100000-0000-4000-8000-000000000001') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',p_entries))
$$;
create function pg_temp.ready() returns boolean language sql as $$
	select public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
	from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_observations o on o.node_id = n.id
	where n.id = '64100000-0000-4000-8000-000000000001'
$$;

select pg_temp.claims('service_role');
set local role service_role;
-- 32 vCPU / 64 GiB, headroom 12 vCPU / 16 GiB: host 4 vCPU / 4 GiB plus a build space of at most 8 vCPU / 12 GiB.
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
	'nodeId','64100000-0000-4000-8000-000000000001','machineIdSha256',repeat('4',64),'label','node-a','cpuMillis',32000,
	'memoryBytes',68719476736,'headroomCpuMillis',12000,'headroomMemoryBytes',17179869184,'standardCpuMillis',4000,
	'standardMemoryBytes',8589934592,'enabled',true),0);

-- Enrolment: the space's shape is strict; it counts against headroom; no infrastructure in its project.
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":8000}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","cpuMillis":8000,"memoryBytes":1}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"../n","cpuMillis":8000,"memoryBytes":1}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":8000,"memoryBytes":1,"x":1}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"../b","network":"qorpera0","cpuMillis":8000,"memoryBytes":1}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":"8000","memoryBytes":1}'))$q$,
	'Invalid node inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":8001,"memoryBytes":12884901888}'))$q$,
	'Infrastructure exceeds reserved headroom or duplicates identity');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":4000,"memoryBytes":4294967296}',
	jsonb_build_array(jsonb_build_object('project','qorpera-build','name','exec','physicalId','64100000-0000-4000-8000-0000000000e1',
		'type','virtual-machine','configurationSha256',repeat('c',64),'cpuMillis',1000,'memoryBytes',1073741824))))$q$,
	'Infrastructure exceeds reserved headroom or duplicates identity');
-- Rollout direction: the node starts without a space, then its policy is replaced with one.
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(null));
reset role;
select set_config('qorpera_test.build_policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '64100000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy('{"project":"qorpera-build","network":"qorpera0","cpuMillis":8000,"memoryBytes":12884901888}'),
	current_setting('qorpera_test.build_policy'));

-- A builder and its verifier inside the space: the node stays ready.
select pg_temp.observe('ready','[]');
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready without a build');
set local role service_role;
select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',4000,8589934592),
	pg_temp.build('qorpera-build','image-verify',4000,4294967296)));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready with a builder and a verifier inside the space');
set local role service_role;

-- Beyond the space, or reported as beyond: not ready.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',4000,8589934592),
	pg_temp.build('qorpera-build','image-verify',4000,8589934592)))$q$,'Node inventory is not ready');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.build('qorpera-build','image-build',4000,8589934592),
	pg_temp.build('qorpera-build','image-verify',4000,8589934592)));
reset role;
select pg_temp.ok((select observation->>'state' from public.qorpera_runtime_node_observations
	where node_id = '64100000-0000-4000-8000-000000000001') = 'unavailable','Beyond the space the node is published unavailable');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824,'BUILD_SPACE_EXCEEDED')))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824,'INSTANCE_AUTHORITY_DIFFERS')))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',null,1073741824)))$q$,
	'Node inventory is not ready');

-- Only in the declared project; never with an allocation; nothing unclassified in the build project.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qn25b2','image-build',1000,1073741824)))$q$,
	'Node inventory mixes the build space with other instances');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824)
	|| '{"type":"container"}'::jsonb))$q$,'Node inventory is not ready');
-- The observer reports it honestly as unavailable: that observation is recorded and the node turns unavailable.
select pg_temp.observe('ready','[]');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824)
	|| '{"type":"container","reason":"INSTANCE_AUTHORITY_DIFFERS"}'::jsonb));
reset role;
select pg_temp.ok((select o.observation->>'state' = 'unavailable' and r.inventory->'entries'->0->>'type' = 'container'
	from public.qorpera_runtime_node_observations o join public.qorpera_runtime_node_inventory_receipts r
		on r.node_id = o.node_id and r.observation_id = o.observation_id
	where o.node_id = '64100000-0000-4000-8000-000000000001'),'The container is recorded and the node is unavailable');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','guest',1000,1073741824)
	|| jsonb_build_object('category','managed','allocation',jsonb_build_object('allocationId',extensions.gen_random_uuid()))))$q$,
	'Node inventory mixes the build space with other instances');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824)
	|| jsonb_build_object('allocation',jsonb_build_object('allocationId',extensions.gen_random_uuid()))))$q$,
	'A build machine cannot claim an allocation');
select pg_temp.fails($q$select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.build('qorpera-build','stray',1000,1073741824)
	|| '{"category":"unmanaged","reason":"UNREGISTERED_INSTANCE"}'::jsonb))$q$,
	'Node inventory mixes the build space with other instances');

-- Without a declared space a build entry is refused outright, and an unregistered builder keeps the node unavailable, as before.
reset role;
select set_config('qorpera_test.build_policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '64100000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(null),current_setting('qorpera_test.build_policy'));
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824)))$q$,
	'Node inventory reports a build machine outside the build space');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.build('qorpera-build','image-build',1000,1073741824)
	|| '{"category":"unmanaged","reason":"UNREGISTERED_INSTANCE"}'::jsonb))$q$,'Node inventory is not ready');
select pg_temp.observe('ready','[]');
reset role;
select pg_temp.ok(pg_temp.ready(),'A policy without a build space works as before');
set local role service_role;
reset role;
rollback;
