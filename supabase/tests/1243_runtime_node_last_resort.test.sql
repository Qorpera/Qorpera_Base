-- @fixture 627_runtime_company_computer_seats.test.sql until "select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2))='setup','no host offers computer 2 yet');"
-- A last-resort node (20260930749000) is chosen for new work only when no other node has room. 627's fixture on 924's
-- folder-v2 company: computer 2 was added for Carol and its start requested, with no host yet (the office fleet's case).
-- Three nodes: A and B regular (16 CPUs, 64 GiB), C the spare with the most room (32 CPUs, 128 GiB) and the lowest id, so
-- every chooser below would pick C today. For each chooser of new work: (i) while a regular node has room C is never
-- chosen; (ii) with the regular nodes full C is chosen; (iii) with the flag false the choice is today's (C); (iv) where a
-- chooser puts the node of a failed start last, a healthy C is preferred over it; (v) the pull path: C's machine executor
-- admits a waiting machine, or gives up a stopped machine's disk for one, only when no regular node could take it now,
-- and a machine asleep on C still wakes there. "Full" is a real coding reservation that leaves 1 CPU on the node; run
-- placement and the coding enrollment have no room test, so for them (ii) is "no regular fast host takes runs" and "no
-- regular executor is enabled". Nodes,
-- providers, observations, reservations and every chooser are the real functions; the machines, the coding executors,
-- worker and session, the second company and a run's start failure are rows written as the fixtures elsewhere write them.
-- Review r1: section 4b drives real claims through every bypass of the claim turn (F1; r2: a refusal takes only the host
-- that refused out of the set), and section 6 proves that a regular node reporting less hardware than its policy counts
-- on is no candidate, so the spare still admits work (F2).
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.lr_id(p_node text) returns uuid language sql immutable as $$
	select case p_node when 'a' then '12430000-0000-4000-8000-00000000000a'::uuid when 'b' then '12430000-0000-4000-8000-00000000000b'::uuid
		else '12430000-0000-4000-8000-000000000001'::uuid end
$$;
create function pg_temp.lr_sha(p_node text) returns text language sql immutable as $$ select repeat('1' || p_node, 32) $$;
create function pg_temp.lr_cpu(p_node text) returns bigint language sql immutable as $$
	select case when p_node = 'c' then 32000 else 16000 end::bigint
$$;
create function pg_temp.lr_memory(p_node text) returns bigint language sql immutable as $$
	select case when p_node = 'c' then 137438953472 else 68719476736 end::bigint
$$;
create function pg_temp.lr_policy(p_name text) returns text language sql immutable as $$
	select encode(extensions.digest('last-resort-' || p_name, 'sha256'), 'hex')
$$;
create function pg_temp.lr_node_policy(p_node text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',pg_temp.lr_id(p_node),'machineIdSha256',pg_temp.lr_sha(p_node),
		'label','last-resort-' || p_node,'cpuMillis',pg_temp.lr_cpu(p_node),'memoryBytes',pg_temp.lr_memory(p_node),
		'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,'standardMemoryBytes',4294967296,'enabled',true)
$$;
create function pg_temp.lr_machine_policy(p_node text) returns jsonb language sql immutable as $$
	select jsonb_build_object('providerId','machine-' || p_node,'providerPolicySha256',pg_temp.lr_policy('machine-' || p_node),
		'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0')
$$;
-- A fresh ready observation whose inventory reports exactly the node's reserved machines (628's mc_observe).
create function pg_temp.lr_observe_at(p_node text, p_cpu bigint, p_memory bigint) returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context(pg_temp.lr_id(p_node));
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',pg_temp.lr_id(p_node),'machineIdSha256',pg_temp.lr_sha(p_node),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',p_cpu,'memoryBytes',p_memory,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
create function pg_temp.lr_observe(p_node text) returns void language sql as $$
	select pg_temp.lr_observe_at(p_node, pg_temp.lr_cpu(p_node), pg_temp.lr_memory(p_node))
$$;
create function pg_temp.lr_observe_all() returns void language sql as $$
	select pg_temp.lr_observe('a'); select pg_temp.lr_observe('b'); select pg_temp.lr_observe('c');
$$;
-- A node, its inventory policy, and a provider of every kind: runs and sign-ins 4 CPUs / 8 GiB, a Company Computer
-- 2 CPUs / 2 GiB, a coding machine 4 CPUs / 8 GiB, agents' machines up to 8 CPUs / 32 GiB with 300 GiB of disk.
create function pg_temp.lr_node(p_node text, p_office uuid) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(pg_temp.lr_node_policy(p_node), 0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',pg_temp.lr_id(p_node),'host',jsonb_build_object('machineIdSha256',pg_temp.lr_sha(p_node),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_enroll_runtime_node_provider(pg_temp.lr_id(p_node), pg_temp.lr_sha(p_node), kind, provider,
		pg_temp.lr_policy(provider), cpu, memory)
	from (values ('native', 'run-' || p_node, 4000, 8589934592), ('login', 'login-' || p_node, 4000, 8589934592),
		('office', p_office::text, 2000, 2147483648), ('coding', 'coding-' || p_node, 4000, 8589934592),
		('machine', 'machine-' || p_node, 8000, 34359738368)) providers(kind, provider, cpu, memory);
	perform public.qorpera_configure_machine_executor('mx-' || p_node, pg_temp.lr_sha(p_node), true, pg_temp.lr_machine_policy(p_node),
		322122547200);
end $$;
-- A regular node made full: a real coding reservation of 13 CPUs / 52 GiB leaves it 1 CPU and 4 GiB.
create function pg_temp.lr_fill(p_node text) returns void language plpgsql as $$
declare v_allocation uuid := extensions.gen_random_uuid(); v_result jsonb;
begin
	perform public.qorpera_enroll_runtime_node_provider(pg_temp.lr_id(p_node), pg_temp.lr_sha(p_node), 'coding', 'fill-' || p_node,
		pg_temp.lr_policy('fill-' || p_node), 13000, 55834574848);
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_machine_id, provider_adapter, instance_sha256)
	values (v_allocation, '92400000-0000-4000-8000-000000000010', v_allocation, 'fill-' || p_node, pg_temp.lr_policy(v_allocation::text));
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.lr_observe_all();
	v_result := public.qorpera_reserve_runtime_node_machine(v_allocation, 'coding', 'fill-' || p_node, pg_temp.lr_policy('fill-' || p_node),
		pg_temp.lr_policy(v_allocation::text), pg_temp.lr_sha(p_node), 13000, 55834574848);
	perform pg_temp.base_assert(v_result ->> 'state' = 'reserved', 'Node ' || p_node || ' is filled: ' || v_result::text);
	perform pg_temp.lr_observe_all();
end $$;
create function pg_temp.lr_spare(p_on boolean) returns jsonb language sql as $$
	select public.qorpera_set_runtime_node_last_resort(pg_temp.lr_id('c'), p_on, 1, 'emergency capacity')
$$;
create function pg_temp.lr_candidate(p_kind text, p_node text) returns jsonb language sql as $$
	select c from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates(p_kind)) c where (c ->> 'nodeId')::uuid = pg_temp.lr_id(p_node)
$$;
create function pg_temp.lr_first(p_kind text) returns uuid language sql as $$
	select (public.qorpera_runtime_node_placement_candidates(p_kind) -> 0 ->> 'nodeId')::uuid
$$;
create function pg_temp.lr_decide(p_kind text, p_provider text, p_failed text default null) returns jsonb language sql as $$
	select public.qorpera_runtime_node_placement_decide(extensions.gen_random_uuid(), p_kind, p_provider, null::uuid,
		case when p_failed is not null then pg_temp.lr_id(p_failed) end, null::text)
$$;
-- The sign-in, account-refresh and old gateway choosers' nodes.
create function pg_temp.lr_routes() returns uuid[] language sql as $$
	select array[(public.qorpera_runtime_login_gateway_choose(null::text) ->> 'nodeId')::uuid,
		(public.qorpera_runtime_account_refresh_gateway_choose(null::text) ->> 'nodeId')::uuid,
		(public.qorpera_runtime_login_gateway_choose() ->> 'nodeId')::uuid]
$$;
create function pg_temp.lr_orchestrator(p_node text) returns uuid language sql immutable as $$
	select ('12430000-0000-4000-8000-0000000005a' || p_node)::uuid
$$;
-- The owner's post in an agent's thread, turned into a queued run by the materializer (924's helpers).
create function pg_temp.lr_run(p_staff uuid) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, 'Which node takes this?');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'The post is one queued run: ' || v_pass::text);
	perform pg_temp.base_claims('service_role');
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
-- A real claim by one node's orchestrator: the run it took, or nothing.
create function pg_temp.lr_take(p_node text) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(pg_temp.lr_orchestrator(p_node), extensions.gen_random_uuid(), 120)
$$;
create function pg_temp.lr_claim(p_node text) returns text language plpgsql as $$
declare v_work jsonb := pg_temp.lr_take(p_node);
begin
	return case when v_work = 'null'::jsonb then 'nothing' else coalesce(v_work #>> '{work,run_id}', v_work::text) end;
end $$;
-- The job waited past the claim turn's 1.5 seconds.
create function pg_temp.lr_age_job(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = clock_timestamp() - interval '5 seconds' where run_id = p_run
$$;
-- One node's orchestrator claims the run and then refuses its admission, as a host with no room does (721's pattern):
-- the claim is released with the reason, which is what qorpera_runtime_refused_recently reads.
create function pg_temp.lr_claim_then_refuse(p_node text) returns text language plpgsql as $$
declare v_work jsonb := pg_temp.lr_take(p_node);
begin
	if v_work = 'null'::jsonb then return 'nothing'; end if;
	perform public.qorpera_release_runner_job_claim(pg_temp.lr_orchestrator(p_node), (v_work ->> 'claim_id')::uuid,
		extensions.gen_random_uuid(), 'ADMISSION_REFUSED:NODE_CAPACITY_EXHAUSTED');
	return coalesce(v_work #>> '{work,run_id}', v_work::text);
end $$;
-- The 15 seconds every host waits after a refusal, sat out (721's fa_ready). The refusals themselves stay on the
-- released claims, which is where the guard reads them.
create function pg_temp.lr_waited_out(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set dispatch_deferred_until = null, dispatch_refused_by = null where run_id = p_run
$$;
create function pg_temp.lr_roles(p_role text) returns void language sql as $$
	select public.qorpera_set_runner_orchestrator_dispatch_role(pg_temp.lr_orchestrator(n), p_role)
	from unnest(array['a', 'b', 'c']) n
$$;
-- Where a run with orchestrator roles goes: a run of its own (no conversation, identity or bundle).
create function pg_temp.lr_run_node() returns uuid language sql as $$
	select (public.qorpera_runtime_run_placement(jsonb_populate_record(null::public.qorpera_runner_jobs, '{}'::jsonb),
		jsonb_populate_record(null::public.qorpera_execution_runs, jsonb_build_object('id', '12430000-0000-4000-8000-0000000000f0',
			'created_at', clock_timestamp()))) ->> 'nodeId')::uuid
$$;
-- An agent's machine that waits for room, as machine_start writes it before admitting it.
create function pg_temp.lr_machine(p_name text, p_cpus integer, p_memory_gib integer, p_disk_gib integer) returns uuid language sql as $$
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
		started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_name,
		'Last-resort check', '92400000-0000-4000-8000-000000000030', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
		extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', p_cpus, p_memory_gib * 1073741824::bigint,
		p_disk_gib * 1073741824::bigint, 'standard', 'task')
	returning id
$$;
create function pg_temp.lr_owner(p_machine uuid) returns text language sql as $$
	select (public.qorpera_company_machine_placement(p_machine)).owner
$$;
create function pg_temp.lr_pull(p_node text) returns jsonb language sql as $$
	select public.qorpera_admit_executor_machines('mx-' || p_node, pg_temp.lr_sha(p_node))
$$;
-- A start's admission, or an executor's pass, and where the machine is then (read in a statement of its own: a change is
-- not seen by the statement that made it).
create function pg_temp.lr_admit(p_machine uuid) returns text language plpgsql as $$
declare v_result jsonb := public.qorpera_admit_company_machine(p_machine);
begin
	return coalesce(v_result ->> 'state', v_result::text) || ' on ' || coalesce(pg_temp.lr_owner(p_machine), 'nothing');
end $$;
create function pg_temp.lr_pull_for(p_node text, p_machine uuid) returns text language plpgsql as $$
declare v_result jsonb := pg_temp.lr_pull(p_node);
begin
	return case when v_result = jsonb_build_array(p_machine) then 'admitted' else v_result::text end
		|| ' on ' || coalesce(pg_temp.lr_owner(p_machine), 'nothing');
end $$;
create function pg_temp.lr_expect(p_got text, p_want text, p_message text) returns void language sql as $$
	select pg_temp.base_assert(p_got = p_want, p_message || ': ' || p_got)
$$;
-- A Company Computer host's offer of computer 2 (its scope and start intent read before).
create function pg_temp.lr_offer(p_node text, p_office uuid, p_allocation uuid) returns jsonb language sql as $$
	select public.qorpera_offer_runtime_office_fleet(jsonb_build_object('schema','qorpera.office-fleet-offer/v1',
		'scope',current_setting('qorpera_test.lr_scope')::jsonb,'computerGeneration',1,'intentId',current_setting('qorpera_test.lr_intent'),
		'providerId',p_office,'nodeId',pg_temp.lr_id(p_node),'policySha256',pg_temp.lr_policy(p_office::text),
		'machineIdSha256',pg_temp.lr_sha(p_node),'allocationId',p_allocation,'instanceSha256',pg_temp.lr_policy('office-instance-' || p_node),
		'providerBindingSha256',pg_temp.lr_policy('office-binding-' || p_node),'imageSha256',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'cpuMillis',2000,'memoryBytes',2147483648,'serviceConfigSha256',pg_temp.lr_policy('office-config-' || p_node)))
$$;
create function pg_temp.lr_office_node() returns uuid language sql as $$
	select (public.qorpera_place_runtime_office_fleet(current_setting('qorpera_test.lr_scope')::jsonb, 1) #>> '{offer,nodeId}')::uuid
$$;
create function pg_temp.lr_enrolled() returns text language sql as $$
	select public.qorpera_coding_executor_enroll('12430000-0000-4000-8000-0000000004a1', 'codex');
	select string_agg(owner, ',' order by owner) from public.qorpera_coding_executors where environment_id = '12430000-0000-4000-8000-0000000004a1';
$$;

-- The three nodes, observed ready.
select pg_temp.lr_node('a', '12430000-0000-4000-8000-00000000010a');
select pg_temp.lr_node('b', '12430000-0000-4000-8000-00000000010b');
select pg_temp.lr_node('c', '12430000-0000-4000-8000-000000000101');
select pg_temp.lr_observe_all();

-- 1. The flag and its setter (as the runs switch: the service role only; the policy version is checked, not bumped).
select pg_temp.base_assert(not has_function_privilege(role_name, 'public.qorpera_set_runtime_node_last_resort(uuid,boolean,bigint,text)', 'EXECUTE'),
	'Not public: ' || role_name)
from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_set_runtime_node_last_resort(uuid,boolean,bigint,text)', 'EXECUTE'),
	'The operator sets it');
select pg_temp.base_assert(not has_table_privilege(role_name, 'public.qorpera_runtime_node_last_resort_changes', 'SELECT'),
	'The changes are no API role''s: ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;
select pg_temp.base_assert((select bool_and(not last_resort) from public.qorpera_runtime_nodes)
	and not (pg_temp.lr_candidate('native', 'c') ->> 'lastResort')::boolean,
	'Every node is regular until an operator says otherwise');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select pg_temp.lr_spare(true)$q$, '42501', 'Invalid node last-resort change');
select pg_temp.base_claims('service_role');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_last_resort('12430000-0000-4000-8000-000000000001', true, 1, '  ')$q$,
	'42501', 'Invalid node last-resort change');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_last_resort('12430000-0000-4000-8000-000000000001', null, 1, 'spare')$q$,
	'42501', 'Invalid node last-resort change');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_last_resort('12430000-0000-4000-8000-000000000009', true, 1, 'spare')$q$,
	'42501', 'Node is not configured');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_last_resort('12430000-0000-4000-8000-000000000001', true, 7, 'spare')$q$,
	'PGRST');
select pg_temp.base_assert(pg_temp.lr_spare(true)
		= jsonb_build_object('nodeId', pg_temp.lr_id('c'), 'version', 1, 'lastResort', true, 'changed', true),
	'Node C is the last resort');
select pg_temp.base_assert(pg_temp.lr_spare(true) ->> 'changed' = 'false', 'Again changes nothing');
select pg_temp.base_assert((select last_resort and enabled and runs_enabled and version = 1 from public.qorpera_runtime_nodes where id = pg_temp.lr_id('c'))
	and (select bool_and(not last_resort) from public.qorpera_runtime_nodes where id <> pg_temp.lr_id('c'))
	and (select not policy ? 'lastResort' from public.qorpera_runtime_node_policies where node_id = pg_temp.lr_id('c') and version = 1)
	and (select count(*) = 1 from public.qorpera_runtime_node_last_resort_changes where node_id = pg_temp.lr_id('c')
		and version = 1 and last_resort and reason = 'emergency capacity')
	and not exists (select 1 from public.qorpera_runtime_node_serving_changes where node_id = pg_temp.lr_id('c')),
	'Only the flag moved, with its own record; the policy, the serving switches and their record are untouched');
savepoint new_version;
select public.qorpera_configure_runtime_node(pg_temp.lr_node_policy('c') || '{"headroomCpuMillis":3000}'::jsonb, 1) \g /dev/null
select pg_temp.base_assert((select version = 2 and last_resort from public.qorpera_runtime_nodes where id = pg_temp.lr_id('c')),
	'A new policy version keeps the flag');
rollback to savepoint new_version;

-- 2. Runs: the candidates and the node chooser.
select pg_temp.lr_observe_all();
select pg_temp.base_assert(pg_temp.lr_first('native') = pg_temp.lr_id('a')
		and (pg_temp.lr_candidate('native', 'c') ->> 'lastResort')::boolean and not (pg_temp.lr_candidate('native', 'a') ->> 'lastResort')::boolean
		and (pg_temp.lr_candidate('native', 'c') ->> 'freeSlots')::bigint > (pg_temp.lr_candidate('native', 'a') ->> 'freeSlots')::bigint
		and (pg_temp.lr_candidate('native', 'c') ->> 'eligible')::boolean and (pg_temp.lr_candidate('native', 'c') ->> 'fits')::boolean,
	'(i) Node C has the most room but ranks last: ' || public.qorpera_runtime_node_placement_candidates('native')::text);
select pg_temp.base_assert(pg_temp.lr_decide('native', 'run-c') ->> 'decision' = 'refused'
		and pg_temp.lr_decide('native', 'run-c') ->> 'reason' = 'NODE_NOT_PREFERRED'
		and (pg_temp.lr_decide('native', 'run-c') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('a')
		and pg_temp.lr_decide('native', 'run-a') ->> 'decision' = 'placed' and pg_temp.lr_decide('native', 'run-a') ->> 'reason' = 'LEAST_LOADED',
	'(i) A run goes to node A, not C: ' || pg_temp.lr_decide('native', 'run-c')::text);
savepoint runs_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert(pg_temp.lr_first('native') = pg_temp.lr_id('c')
		and pg_temp.lr_decide('native', 'run-c') ->> 'decision' = 'placed'
		and (pg_temp.lr_decide('native', 'run-a') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('c'),
	'(iii) Flag off: node C, with the most room, is chosen as today');
rollback to savepoint runs_flag_off;
savepoint runs_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.base_assert(pg_temp.lr_first('native') = pg_temp.lr_id('c')
		and not (pg_temp.lr_candidate('native', 'a') ->> 'fits')::boolean and (pg_temp.lr_candidate('native', 'a') ->> 'eligible')::boolean
		and pg_temp.lr_decide('native', 'run-c') ->> 'decision' = 'placed' and pg_temp.lr_decide('native', 'run-c') ->> 'reason' = 'LEAST_LOADED'
		and (pg_temp.lr_decide('native', 'run-a') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('c'),
	'(ii) Nodes A and B full: node C takes the run: ' || public.qorpera_runtime_node_placement_candidates('native')::text);
rollback to savepoint runs_full;
savepoint runs_failed;
select pg_temp.lr_fill('b');
select pg_temp.base_assert(pg_temp.lr_decide('native', 'run-a') ->> 'decision' = 'placed'
		and (pg_temp.lr_decide('native', 'run-a', 'a') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('c')
		and pg_temp.lr_decide('native', 'run-a', 'a') ->> 'reason' = 'NODE_NOT_PREFERRED'
		and pg_temp.lr_decide('native', 'run-c', 'a') ->> 'decision' = 'placed',
	'(iv) Node B full: a new run goes to node A, but a run whose start failed on node A goes to node C');
rollback to savepoint runs_failed;

-- 3. Sign-ins: the chooser's own fallback (no gateway yet), then the gateway routes.
savepoint sign_in_fallback;
select pg_temp.lr_fill('a');
select pg_temp.base_assert(pg_temp.lr_decide('login', 'login-a') ->> 'reason' = 'NODE_NOT_PREFERRED'
		and (pg_temp.lr_decide('login', 'login-a') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('b'),
	'(i) Node A full, no gateway: the sign-in is pointed to node B, not C: ' || pg_temp.lr_decide('login', 'login-a')::text);
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert((pg_temp.lr_decide('login', 'login-a') ->> 'preferredNodeId')::uuid = pg_temp.lr_id('c'),
	'(iii) Flag off: to node C, as today');
rollback to savepoint sign_in_fallback;
insert into public.qorpera_runtime_login_gateways(provider_id, node_id, url)
select 'login-' || n, pg_temp.lr_id(n), 'https://login-' || n || '.last-resort.test/' from unnest(array['a', 'b', 'c']) n;
select pg_temp.lr_observe_all();
select pg_temp.base_assert(pg_temp.lr_routes() = array[pg_temp.lr_id('a'), pg_temp.lr_id('a'), pg_temp.lr_id('a')],
	'(i) Sign-ins and account refreshes are routed to node A, not C: ' || pg_temp.lr_routes()::text);
savepoint routes_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert(pg_temp.lr_routes() = array[pg_temp.lr_id('c'), pg_temp.lr_id('c'), pg_temp.lr_id('c')],
	'(iii) Flag off: to node C, as today');
rollback to savepoint routes_flag_off;
savepoint routes_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.base_assert(pg_temp.lr_routes() = array[pg_temp.lr_id('c'), pg_temp.lr_id('c'), pg_temp.lr_id('c')],
	'(ii) Nodes A and B full: to node C');
rollback to savepoint routes_full;

-- 4. Runs with orchestrator roles: one fast host per node.
select public.qorpera_register_runner_orchestrator(('12430000-0000-4000-8000-0000000005a' || n)::uuid, 'Last resort ' || n, 'run-' || n,
	pg_temp.lr_policy('orchestrator-' || n), 3600)
from unnest(array['a', 'b', 'c']) n \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role(('12430000-0000-4000-8000-0000000005a' || n)::uuid, 'fast')
from unnest(array['a', 'b', 'c']) n \g /dev/null
select pg_temp.base_assert(pg_temp.lr_run_node() = pg_temp.lr_id('a'), '(i) The run goes to node A''s fast host, not C''s');
savepoint fast_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert(pg_temp.lr_run_node() = pg_temp.lr_id('c'), '(iii) Flag off: node C (first by id, none busy), as today');
rollback to savepoint fast_flag_off;
savepoint fast_regular_off;
select public.qorpera_set_runtime_node_runs(pg_temp.lr_id(n), false, 1, 'roll') from unnest(array['a', 'b']) n \g /dev/null
select pg_temp.base_assert(pg_temp.lr_run_node() = pg_temp.lr_id('c'), '(ii) No regular fast host takes runs: node C');
rollback to savepoint fast_regular_off;
savepoint fast_failed;
select public.qorpera_set_runtime_node_runs(pg_temp.lr_id('b'), false, 1, 'roll') \g /dev/null
select pg_temp.base_assert(pg_temp.lr_run_node() = pg_temp.lr_id('a'), 'Node B takes no runs: node A');
set local session_replication_role = replica;
insert into public.qorpera_runtime_run_start_failures(run_id, attempt, allocation_id, node_id)
values ('12430000-0000-4000-8000-0000000000f0', 1, extensions.gen_random_uuid(), pg_temp.lr_id('a'));
set local session_replication_role = origin;
select pg_temp.base_assert(pg_temp.lr_run_node() = pg_temp.lr_id('c'), '(iv) The run''s start failed on node A: node C, not A again');
rollback to savepoint fast_failed;

-- 4b. The claim itself (review r1 F1, narrowed in r2): a last-resort node's orchestrator claims a run only when no
--     regular node could take it right now, through every bypass of the claim turn. A host's refused admission takes
--     that host out of the set and nothing more, so another regular host with room is still preferred; the set is empty
--     only once every regular host has refused or gone ineligible. With dispatch roles, run placement ranks live fast
--     hosts without a room test, so a full regular node is still preferred and refuses, and the spare waits for the
--     others' refusals; the no-role path, which is how both nodes run today, asks the chooser instead.
select set_config('qorpera_test.lr_run', pg_temp.lr_run('92400000-0000-4000-8000-000000000031')::text, true);
select pg_temp.lr_observe_all();
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_runner_jobs where status = 'queued'
		and run_id = current_setting('qorpera_test.lr_run')::uuid)
	and (select count(*) = 1 from public.qorpera_runner_jobs where status = 'queued'),
	'The new run is the only queued job');
savepoint claim_fresh;
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', '(i) Node C''s fast host claims nothing while node A has room');
select pg_temp.lr_expect(pg_temp.lr_claim('a'), current_setting('qorpera_test.lr_run'), '(i) Node A''s fast host claims the run');
rollback to savepoint claim_fresh;
-- The claim turn lets any fast host take a run that waited 1.5 seconds; the guard holds node C back anyway.
savepoint claim_waited;
select pg_temp.lr_age_job(current_setting('qorpera_test.lr_run')::uuid);
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', '(i) Node C claims nothing after the 1.5 s wait either');
select pg_temp.lr_expect(pg_temp.lr_claim('a'), current_setting('qorpera_test.lr_run'), 'Node A still claims it');
rollback to savepoint claim_waited;
-- A refusal takes the host that refused out of the set and says nothing about the others: node B still has room, so
-- node B claims it and node C stays out (review r2 F1).
savepoint claim_refused;
select pg_temp.lr_expect(pg_temp.lr_claim_then_refuse('a'), current_setting('qorpera_test.lr_run'),
	'Node A claims the run and refuses its admission');
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', '(i) Node A refused, but node B has room: node C claims nothing');
select pg_temp.lr_expect(pg_temp.lr_claim('b'), current_setting('qorpera_test.lr_run'), '(i) Node B claims it instead');
rollback to savepoint claim_refused;
-- No dispatch role, as both nodes run today: the same, and then the case that matters -- once every regular host has
-- refused, the set is empty and node C claims on the ordinary rule.
savepoint claim_refused_no_role;
select pg_temp.lr_roles(null) \g /dev/null
select pg_temp.lr_expect(pg_temp.lr_claim_then_refuse('a'), current_setting('qorpera_test.lr_run'), 'No role: node A refuses');
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', '(i) No role: node B has room, so node C claims nothing');
select pg_temp.lr_expect(pg_temp.lr_claim_then_refuse('b'), current_setting('qorpera_test.lr_run'), 'Node B claims it and refuses too');
select pg_temp.lr_waited_out(current_setting('qorpera_test.lr_run')::uuid);
select pg_temp.lr_expect(pg_temp.lr_claim('c'), current_setting('qorpera_test.lr_run'),
	'(ii) Every regular host has refused: node C claims it');
rollback to savepoint claim_refused_no_role;
savepoint claim_waited_flag_off;
select pg_temp.lr_age_job(current_setting('qorpera_test.lr_run')::uuid);
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.lr_expect(pg_temp.lr_claim('c'), current_setting('qorpera_test.lr_run'),
	'(iii) Flag off: node C claims the waiting run, as today');
rollback to savepoint claim_waited_flag_off;
-- No dispatch role, as both nodes run today: the claim turn says yes at once, and the guard asks the chooser instead.
savepoint claim_no_role;
select pg_temp.lr_roles(null) \g /dev/null
select pg_temp.lr_observe_all();
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', '(i) No role: node C claims nothing while node A has room');
select pg_temp.lr_expect(pg_temp.lr_claim('a'), current_setting('qorpera_test.lr_run'), '(i) No role: node A claims the run');
rollback to savepoint claim_no_role;
savepoint claim_no_role_flag_off;
select pg_temp.lr_roles(null) \g /dev/null
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.lr_observe_all();
select pg_temp.lr_expect(pg_temp.lr_claim('c'), current_setting('qorpera_test.lr_run'), '(iii) No role, flag off: node C claims it, as today');
rollback to savepoint claim_no_role_flag_off;
savepoint claim_no_role_full;
select pg_temp.lr_roles(null) \g /dev/null
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.lr_expect(pg_temp.lr_claim('c'), current_setting('qorpera_test.lr_run'),
	'(ii) No role, nodes A and B full: node C claims it');
rollback to savepoint claim_no_role_full;
savepoint claim_no_role_failed;
select pg_temp.lr_roles(null) \g /dev/null
select pg_temp.lr_fill('b');
select pg_temp.lr_expect(pg_temp.lr_claim('c'), 'nothing', 'No role: node C claims nothing while node A has room');
set local session_replication_role = replica;
insert into public.qorpera_runtime_run_start_failures(run_id, attempt, allocation_id, node_id)
values (current_setting('qorpera_test.lr_run')::uuid, 1, extensions.gen_random_uuid(), pg_temp.lr_id('a'));
set local session_replication_role = origin;
select pg_temp.lr_expect(pg_temp.lr_claim('c'), current_setting('qorpera_test.lr_run'),
	'(iv) The run''s start failed on node A: node C claims it, as the failed-start rule says');
rollback to savepoint claim_no_role_failed;

-- 5. Company Computers: every node offers computer 2.
select set_config('qorpera_test.lr_scope', pg_temp.cs_scope(2)::text, true);
select set_config('qorpera_test.lr_intent', (select id::text from public.qorpera_runtime_office_start_intents
	where office_id = (pg_temp.cs_office(2)).id), true);
select pg_temp.lr_observe_all();
select pg_temp.lr_offer(n, office, allocation)
from (values ('a', '12430000-0000-4000-8000-00000000010a'::uuid, '12430000-0000-4000-8000-00000000020a'::uuid),
	('b', '12430000-0000-4000-8000-00000000010b'::uuid, '12430000-0000-4000-8000-00000000020b'::uuid),
	('c', '12430000-0000-4000-8000-000000000101'::uuid, '12430000-0000-4000-8000-000000000201'::uuid)) offers(n, office, allocation) \g /dev/null
savepoint office_room;
select set_config('qorpera_test.lr_office', pg_temp.lr_office_node()::text, true);
select pg_temp.base_assert(current_setting('qorpera_test.lr_office')::uuid = pg_temp.lr_id('a'),
	'(i) Computer 2 is placed on node A, not C: ' || current_setting('qorpera_test.lr_office'));
rollback to savepoint office_room;
savepoint office_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select set_config('qorpera_test.lr_office', pg_temp.lr_office_node()::text, true);
select pg_temp.base_assert(current_setting('qorpera_test.lr_office')::uuid = pg_temp.lr_id('c'), '(iii) Flag off: on node C, as today');
rollback to savepoint office_flag_off;
savepoint office_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select set_config('qorpera_test.lr_office', pg_temp.lr_office_node()::text, true);
select pg_temp.base_assert(current_setting('qorpera_test.lr_office')::uuid = pg_temp.lr_id('c'), '(ii) Nodes A and B full: on node C');
rollback to savepoint office_full;

-- 6. Agents' machines: the candidates (the push path's order), a new machine's start, and each node executor's pull. A
--    change is read in a statement after the one that made it.
select pg_temp.lr_observe_all();
select pg_temp.base_assert((select owner from public.qorpera_company_machine_candidates(2000, 4294967296, 21474836480) limit 1) = 'mx-a',
	'(i) Node A is the first candidate, not C');
savepoint machine_push;
select pg_temp.lr_expect(pg_temp.lr_admit(pg_temp.lr_machine('push-one', 2, 4, 20)), 'reserved on mx-a', '(i) A new machine starts on node A');
rollback to savepoint machine_push;
savepoint machine_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert((select owner from public.qorpera_company_machine_candidates(2000, 4294967296, 21474836480) limit 1) = 'mx-c',
	'(iii) Flag off: node C is the first candidate, as today');
select pg_temp.lr_expect(pg_temp.lr_admit(pg_temp.lr_machine('push-one', 2, 4, 20)), 'reserved on mx-c', '(iii) Flag off: on node C, as today');
rollback to savepoint machine_flag_off;
savepoint machine_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.base_assert((select owner from public.qorpera_company_machine_candidates(2000, 4294967296, 21474836480) limit 1) = 'mx-c',
	'(ii) Nodes A and B full: node C is the first candidate');
select pg_temp.lr_expect(pg_temp.lr_admit(pg_temp.lr_machine('push-one', 2, 4, 20)), 'reserved on mx-c', '(ii) Nodes A and B full: on node C');
rollback to savepoint machine_full;
-- (v) The pull path: a waiting machine node A could take now is not node C's.
savepoint pull_room;
select set_config('qorpera_test.lr_machine', pg_temp.lr_machine('pull-one', 2, 4, 20)::text, true);
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', current_setting('qorpera_test.lr_machine')::uuid), '[] on nothing',
	'(v) Node C''s executor leaves a waiting machine that node A could take');
select pg_temp.lr_expect(pg_temp.lr_pull_for('a', current_setting('qorpera_test.lr_machine')::uuid), 'admitted on mx-a',
	'(v) Node A''s executor takes it');
rollback to savepoint pull_room;
savepoint pull_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', pg_temp.lr_machine('pull-one', 2, 4, 20)), 'admitted on mx-c',
	'(v) Nodes A and B full: node C''s executor takes it');
rollback to savepoint pull_full;
savepoint pull_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', pg_temp.lr_machine('pull-one', 2, 4, 20)), 'admitted on mx-c',
	'(iii) Flag off: node C''s executor takes it, as today');
rollback to savepoint pull_flag_off;
-- A machine asleep on node C wakes there, on its own placement, though node A has room.
savepoint pull_wake;
select pg_temp.lr_spare(false) \g /dev/null
select set_config('qorpera_test.lr_machine', pg_temp.lr_machine('asleep-on-c', 2, 4, 20)::text, true);
select pg_temp.lr_expect(pg_temp.lr_admit(current_setting('qorpera_test.lr_machine')::uuid), 'reserved on mx-c', 'Flag off, it starts on node C');
select set_config('qorpera_test.lr_placement', (public.qorpera_company_machine_placement(current_setting('qorpera_test.lr_machine')::uuid)).id::text, true);
set local session_replication_role = replica;
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
where allocation_id = current_setting('qorpera_test.lr_placement')::uuid;
set local session_replication_role = origin;
select pg_temp.lr_spare(true) \g /dev/null
select pg_temp.lr_observe_all();
select pg_temp.base_assert(not public.qorpera_company_machine_placement_reserved(current_setting('qorpera_test.lr_placement')::uuid),
	'It sleeps on node C');
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', current_setting('qorpera_test.lr_machine')::uuid), 'admitted on mx-c',
	'A machine asleep on node C wakes on node C');
select pg_temp.base_assert((public.qorpera_company_machine_placement(current_setting('qorpera_test.lr_machine')::uuid)).id
		= current_setting('qorpera_test.lr_placement')::uuid
	and public.qorpera_company_machine_placement_reserved(current_setting('qorpera_test.lr_placement')::uuid),
	'on its own placement, awake');
rollback to savepoint pull_wake;
-- (v) A regular node that reports less hardware than its policy counts on cannot take a machine, and admission there
--     refuses it (NODE_HARDWARE_CHANGED), so it is no candidate and the veto must not read it as room (review r1 F2).
savepoint pull_hardware;
select pg_temp.lr_fill('b');
select set_config('qorpera_test.lr_machine', pg_temp.lr_machine('needs-a-node', 2, 4, 20)::text, true);
select pg_temp.lr_observe_at('a', 8000, pg_temp.lr_memory('a'));
select pg_temp.base_assert(not exists (select 1 from public.qorpera_company_machine_candidates(2000, 4294967296, 21474836480)
		where owner = 'mx-a')
	and exists (select 1 from public.qorpera_company_machine_candidates(2000, 4294967296, 21474836480) where owner = 'mx-c'),
	'(v) Node A reports half its CPUs: no candidate, while node C still is');
select pg_temp.lr_expect(pg_temp.lr_pull_for('a', current_setting('qorpera_test.lr_machine')::uuid), '[] on nothing',
	'(v) Node A''s own executor cannot take the waiting machine');
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', current_setting('qorpera_test.lr_machine')::uuid), 'admitted on mx-c',
	'(v) so node C''s executor does, instead of skipping it for ever');
rollback to savepoint pull_hardware;
-- Node C gives up a stopped machine's disk only for a machine no regular node could take now.
savepoint pull_disk;
select pg_temp.lr_spare(false) \g /dev/null
select public.qorpera_configure_machine_executor('mx-c', pg_temp.lr_sha('c'), true, pg_temp.lr_machine_policy('c'), 42949672960) \g /dev/null
select set_config('qorpera_test.lr_machine', pg_temp.lr_machine('stopped-on-c', 1, 1, 30)::text, true);
select pg_temp.lr_expect(pg_temp.lr_admit(current_setting('qorpera_test.lr_machine')::uuid), 'reserved on mx-c',
	'A 30 GiB machine on node C, whose executor has 40 GiB');
select set_config('qorpera_test.lr_placement', (public.qorpera_company_machine_placement(current_setting('qorpera_test.lr_machine')::uuid)).id::text, true);
set local session_replication_role = replica;
update public.qorpera_company_machines set desired_state = 'stopped' where id = current_setting('qorpera_test.lr_machine')::uuid;
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
where allocation_id = current_setting('qorpera_test.lr_placement')::uuid;
set local session_replication_role = origin;
select set_config('qorpera_test.lr_waiting', pg_temp.lr_machine('needs-disk', 1, 1, 20)::text, true);
select pg_temp.lr_spare(true) \g /dev/null
select pg_temp.lr_observe_all();
savepoint pull_disk_spare;
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', current_setting('qorpera_test.lr_waiting')::uuid), '[] on nothing',
	'(v) Node C admits nothing');
select pg_temp.base_assert((select retired_at is null from public.qorpera_company_machine_placements
		where id = current_setting('qorpera_test.lr_placement')::uuid),
	'(v) and keeps the stopped machine''s disk: node A could take the waiting machine');
rollback to savepoint pull_disk_spare;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.lr_expect(pg_temp.lr_pull_for('c', current_setting('qorpera_test.lr_waiting')::uuid), '[] on nothing',
	'(iii) Flag off: node C admits nothing in this pass');
select pg_temp.base_assert((select retired_at is not null from public.qorpera_company_machine_placements
		where id = current_setting('qorpera_test.lr_placement')::uuid),
	'(iii) but gives the disk up for it, as today');
rollback to savepoint pull_disk;

-- 7. Coding: a member's new coding machine (the executor pick) and a company's executor (its enrollment).
set local session_replication_role = replica;
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, requested_by_user_id,
	created_by_run_id, updated_by_run_id)
values ('12430000-0000-4000-8000-0000000003a0', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', 'last-resort', 'Code', '92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values ('12430000-0000-4000-8000-0000000003c1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', '12430000-0000-4000-8000-0000000003a0', 'last-resort-1', 'coding', 'Code', 'read', 'each', '{}',
	'92400000-0000-4000-8000-000000000001', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	'92400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 1);
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, updated_at)
values ('12430000-0000-4000-8000-0000000003c1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'codex',
	'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'last-resort-1', clock_timestamp());
set local session_replication_role = origin;
-- One coding executor per node; node C's sorts first by name.
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy, nas_machine_id_sha256)
select '92400000-0000-4000-8000-000000000020', owner, true, array['codex'],
	jsonb_build_object('providerId', 'coding-' || n, 'providerPolicySha256', pg_temp.lr_policy('coding-' || n), 'cpus', 4, 'memoryBytes', 8589934592),
	'{}'::jsonb, pg_temp.lr_sha(n)
from (values ('cx-1', 'c'), ('cx-2', 'a'), ('cx-3', 'b')) executors(owner, n);
-- A second company, with no executor yet.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12430000-0000-4000-8000-0000000004a0', 'Last resort second company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12430000-0000-4000-8000-0000000004a1', '12430000-0000-4000-8000-0000000004a0', 'Environment', 1, '92400000-0000-4000-8000-000000000001');
select pg_temp.lr_observe_all();
select pg_temp.base_assert(public.qorpera_coding_executor_pick('12430000-0000-4000-8000-0000000003c1') = 'cx-2',
	'(i) A member''s new coding machine goes to node A, not C');
savepoint coding_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert(public.qorpera_coding_executor_pick('12430000-0000-4000-8000-0000000003c1') = 'cx-1',
	'(iii) Flag off: node C, as today');
rollback to savepoint coding_flag_off;
savepoint coding_full;
select pg_temp.lr_fill('a');
select pg_temp.lr_fill('b');
select pg_temp.base_assert(public.qorpera_coding_executor_pick('12430000-0000-4000-8000-0000000003c1') = 'cx-1',
	'(ii) Nodes A and B full: node C');
rollback to savepoint coding_full;
savepoint coding_kept;
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('12430000-0000-4000-8000-0000000003d1', 'member', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000001', 'cx-1', pg_temp.lr_sha('c'), '{}');
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_coding_executor_pick('12430000-0000-4000-8000-0000000003c1') = 'cx-1',
	'A member whose coding machine is on node C stays there');
rollback to savepoint coding_kept;
savepoint enroll_room;
select pg_temp.base_assert(pg_temp.lr_enrolled() = 'cx-2', '(i) A new company''s coding goes to node A''s executor, not C''s');
rollback to savepoint enroll_room;
savepoint enroll_flag_off;
select pg_temp.lr_spare(false) \g /dev/null
select pg_temp.base_assert(pg_temp.lr_enrolled() = 'cx-1', '(iii) Flag off: node C''s (each serves one company; first by name), as today');
rollback to savepoint enroll_flag_off;
savepoint enroll_alone;
update public.qorpera_coding_executors set enabled = false where owner in ('cx-2', 'cx-3');
select pg_temp.base_assert(pg_temp.lr_enrolled() = 'cx-1', '(ii) No regular executor is enabled: node C''s');
rollback to savepoint enroll_alone;

rollback;
