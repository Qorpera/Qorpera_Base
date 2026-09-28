begin;
-- Identical nodes, change 6 (20260928186000): the fast host is listed by its job.
-- An infrastructure entry may declare "role": "execution-host" (virtual machine only, with or without
-- identityVolumes). The observer leaves image.* out of its digest and reports INSTANCE_IMAGE_NOT_RELEASED
-- when the host's image is not one a signed release on the node pins. The registry accepts the field and the
-- reason, and compares the observed entry without the role, like identityVolumes.
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

create function pg_temp.host(p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('project','qn25b2','name','qorpera-exec-node01','physicalId','64900000-0000-4000-8000-0000000000e1',
		'type','virtual-machine','configurationSha256',repeat('c',64),'cpuMillis',8000,'memoryBytes',17179869184) || p_extra
$$;
create function pg_temp.policy(p_infrastructure jsonb) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1','nodeId','64900000-0000-4000-8000-000000000001',
		'host',jsonb_build_object('machineIdSha256',repeat('6',64),'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',101,
			'certificateSha256',repeat('e',64),'serverName','node-a','serverVersion','6.9','architecture','x86_64'),
		'operatingCpuMillis',4000,'operatingMemoryBytes',4294967296,'infrastructure',p_infrastructure)
$$;
-- The observer's entry for the host: the policy entry without role/identityVolumes, plus state and classification.
create function pg_temp.seen(p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.host() || jsonb_build_object('state','running','allocation',null,'category','infrastructure','reason',null) || p_extra
$$;
create function pg_temp.observe(p_state text,p_entries jsonb) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','64900000-0000-4000-8000-000000000001','machineIdSha256',repeat('6',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state',p_state),
		public.qorpera_runtime_node_inventory_context('64900000-0000-4000-8000-000000000001') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',p_entries))
$$;
-- Published ready, with a receipt under the current policy.
create function pg_temp.ready() returns boolean language sql as $$
	select o.observation->>'state' = 'ready' and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
	from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_observations o on o.node_id = n.id
	where n.id = '64900000-0000-4000-8000-000000000001'
$$;
create function pg_temp.state() returns text language sql as $$
	select observation->>'state' from public.qorpera_runtime_node_observations where node_id = '64900000-0000-4000-8000-000000000001'
$$;

select pg_temp.claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
	'nodeId','64900000-0000-4000-8000-000000000001','machineIdSha256',repeat('6',64),'label','node-a','cpuMillis',32000,
	'memoryBytes',68719476736,'headroomCpuMillis',12000,'headroomMemoryBytes',21474836480,'standardCpuMillis',4000,
	'standardMemoryBytes',8589934592,'enabled',true),0);

-- Enrolment: only "execution-host", only on a virtual machine, one role key.
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":"office"}'))))$q$,
	'Invalid infrastructure inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":["execution-host"]}'))))$q$,
	'Invalid infrastructure inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":null}'))))$q$,
	'Invalid infrastructure inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":"execution-host","type":"container"}'))))$q$,
	'Invalid infrastructure inventory policy');
select pg_temp.fails($q$select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":"execution-host","roles":"x"}'))))$q$,
	'Invalid infrastructure inventory policy');
-- Rollout direction: the node starts with today's exact entry, then its policy is replaced with the role.
select public.qorpera_enroll_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host())));
select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen()));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready with the exact entry, as before');
select set_config('qorpera_test.role_policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '64900000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host('{"role":"execution-host"}'))),
	current_setting('qorpera_test.role_policy'));

-- The observer compares everything but the image; the receipt carries no role.
select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen()));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready with the entry listed by role');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen('{"role":"execution-host"}')))$q$,
	'Invalid node inventory entry');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen(jsonb_build_object('configurationSha256',repeat('d',64)))))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen('{"physicalId":"64900000-0000-4000-8000-0000000000e2"}')))$q$,
	'Node inventory is not ready');
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen('{"cpuMillis":4000}')))$q$,
	'Node inventory is not ready');

-- An image no signed release pins: the new reason is recorded, and the node is unavailable.
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen('{"reason":"INSTANCE_IMAGE_NOT_RELEASED"}')))$q$,
	'Node inventory is not ready');
select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.seen('{"reason":"INSTANCE_IMAGE_NOT_RELEASED"}')));
reset role;
select pg_temp.ok(pg_temp.state() = 'unavailable' and not pg_temp.ready(),'An image outside the releases makes the node unavailable');
select pg_temp.ok((select r.inventory->'entries'->0->>'reason' from public.qorpera_runtime_node_inventory_receipts r
	join public.qorpera_runtime_node_observations o on o.node_id = r.node_id and o.observation_id = r.observation_id
	where r.node_id = '64900000-0000-4000-8000-000000000001') = 'INSTANCE_IMAGE_NOT_RELEASED','The receipt names the reason');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('unavailable',jsonb_build_array(pg_temp.seen('{"reason":"IMAGE_UNKNOWN"}')))$q$,
	'Invalid node inventory entry');

-- A role combines with identity volumes: identities still follow the identity rule.
reset role;
select set_config('qorpera_test.role_policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '64900000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host(
	'{"role":"execution-host","identityVolumes":{"pool":"qorpera-vm","sourcePrefix":"phql-a1-identity-"}}'))),
	current_setting('qorpera_test.role_policy'));
select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen('{"identities":[]}')));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready with role and identity volumes');
set local role service_role;
select pg_temp.fails($q$select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen()))$q$,'Node inventory is not ready');

-- Back to the exact entry (rollback): the plain entry is ready again, a role-less receipt as before.
reset role;
select set_config('qorpera_test.role_policy',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '64900000-0000-4000-8000-000000000001'),true);
set local role service_role;
select public.qorpera_replace_runtime_node_inventory(pg_temp.policy(jsonb_build_array(pg_temp.host())),current_setting('qorpera_test.role_policy'));
select pg_temp.observe('ready',jsonb_build_array(pg_temp.seen()));
reset role;
select pg_temp.ok(pg_temp.ready(),'Ready after returning to the exact entry');
rollback;
