-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Rolling updates, step 1 (20260929996000).
--   * The runs switch stops new runs and sign-ins on a node and nothing else: its orchestrators claim
--     nothing new, run and sign-in candidates leave it out, the ledger refuses a new run reservation there,
--     and machines (here a coding machine) are still admitted. A held reservation passes again.
--   * Drain status: runsServing, and readyForNodeRelease once no run, run machine or sign-in is left,
--     while awake machines may stay. A new policy version keeps the runs switch.
--   * Placement follows bundle declarations: a provider whose orchestrators all run another bundle is no
--     candidate for a run of this bundle; the five- and four-argument choosers pass no bundle.
--   * qorpera_declare_runtime_node_bundle declares one node's orchestrators at once.
-- Node A: the fixture orchestrator ...092 (adapter 'process'); it holds the fixture run. Node B: a fast
-- host ...b1 (adapter 'native-b'). Node C: only a coding provider.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','runs-switch-ack');
select public.qorpera_manage_agent_todo(current_setting('qorpera_test.wake_binding')::jsonb,
	'{"action":"upsert","operationKey":"runs-switch-todo","todoKey":"runs-switch","title":"Roll a node"}');
reset role;

create function pg_temp.rs_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;
create function pg_temp.rs_inventory(p_node uuid,p_machine text) returns jsonb language sql as $$
	select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_machine,
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','5.21','architecture','x86_64'),'operatingCpuMillis',2000,'operatingMemoryBytes',4294967296,'infrastructure','[]'::jsonb))
$$;
create function pg_temp.rs_observe(p_node uuid,p_machine text) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_machine,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state','ready'),
		public.qorpera_runtime_node_inventory_context(p_node) ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
create function pg_temp.rs_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.rs_status(p_node uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_node_drain_status(p_node)
$$;
create function pg_temp.rs_candidate(p_kind text,p_provider text) returns jsonb language sql as $$
	select c from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates(p_kind)) c where c ->> 'providerId' = p_provider
$$;
create function pg_temp.rs_decide(p_provider text,p_bundle text) returns jsonb language sql as $$
	select public.qorpera_runtime_node_placement_decide(extensions.gen_random_uuid(),'native',p_provider,null::uuid,null::uuid,p_bundle)
$$;
create function pg_temp.rs_coding(p_worker uuid,p_provider text,p_policy text,p_machine text) returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_node_machine(p_worker,'coding',p_provider,p_policy,
		encode(extensions.digest('runs-switch-vm-' || p_worker::text,'sha256'),'hex'),p_machine,4000,8589934592)
$$;

-- Three nodes; A and B take runs, A and C coding machines. Every node is observed ready.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.rs_policy('79500000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0);
select public.qorpera_configure_runtime_node(pg_temp.rs_policy('79500000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0);
select public.qorpera_configure_runtime_node(pg_temp.rs_policy('79500000-0000-4000-8000-00000000000c',repeat('c',64),'node-c'),0);
select public.qorpera_enroll_runtime_node_provider('79500000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_provider('79500000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_provider('79500000-0000-4000-8000-00000000000a',repeat('a',64),'coding','coding-a',repeat('3',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_provider('79500000-0000-4000-8000-00000000000c',repeat('c',64),'coding','coding-c',repeat('5',64),4000,8589934592);
select public.qorpera_register_runner_orchestrator('79500000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600);
select pg_temp.rs_inventory(node,machine), pg_temp.rs_observe(node,machine)
from (values ('79500000-0000-4000-8000-00000000000a'::uuid,repeat('a',64)),('79500000-0000-4000-8000-00000000000b'::uuid,repeat('b',64)),
	('79500000-0000-4000-8000-00000000000c'::uuid,repeat('c',64))) nodes(node,machine);

-- Coding machines: two workers' allocations (one per coding node).
reset role;
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select ('79500000-0000-4000-8000-00000000030' || n)::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'runs-switch-' || n,
	'coding','Runs switch ' || n,'read','each','{}'::jsonb,'30000000-0000-4000-8000-000000000001',todo.created_by_run_id,
	'30000000-0000-4000-8000-000000000001',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo cross join generate_series(1,2) n where todo.todo_key = 'runs-switch';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select worker.id,worker.profile_id,worker.id,case when n = 1 then 'coding-a' else 'coding-c' end,
	encode(extensions.digest('runs-switch-vm-' || worker.id::text,'sha256'),'hex')
from generate_series(1,2) n join public.qorpera_runtime_workers worker on worker.id = ('79500000-0000-4000-8000-00000000030' || n)::uuid;

-- Operator only.
select pg_temp.wake_assert(not has_function_privilege(role_name,fn,'EXECUTE'),'Not public: ' || fn || ' for ' || role_name)
from unnest(array['anon','authenticated']) role_name,
	unnest(array['public.qorpera_set_runtime_node_runs(uuid,boolean,bigint,text)','public.qorpera_declare_runtime_node_bundle(uuid,text)',
		'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text)']) fn;
select pg_temp.wake_assert(has_function_privilege('service_role',fn,'EXECUTE'),'Operator: ' || fn)
from unnest(array['public.qorpera_set_runtime_node_runs(uuid,boolean,bigint,text)','public.qorpera_declare_runtime_node_bundle(uuid,text)',
		'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text)']) fn;
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_runtime_adapter_takes_bundle(text,text)','EXECUTE'),
	'The bundle helper is internal');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',false,1,'roll')$q$,'42501');
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',false,1,'  ')$q$,
	'42501','Invalid node runs change');
select pg_temp.wake_error($q$select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',null,1,'roll')$q$,
	'42501','Invalid node runs change');
select pg_temp.wake_error($q$select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-000000000009',false,1,'roll')$q$,
	'42501','Node is not configured');

-- Before: both run nodes serve and are candidates; the fixture run is on node A.
select pg_temp.wake_assert((pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'runsServing')::boolean
	and (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'runs')::bigint = 1
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'readyForNodeRelease')::boolean
	and (pg_temp.rs_candidate('native','process') ->> 'eligible')::boolean
	and (pg_temp.rs_candidate('native','native-b') ->> 'eligible')::boolean,
	'Both nodes take runs: ' || pg_temp.rs_status('79500000-0000-4000-8000-00000000000a')::text);
-- A run machine on node A, reserved before the switch (its demand not yet admitted by the ledger).
reset role;
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
values('79500000-0000-4000-8000-000000000100','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
	'kickoff','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}');
select set_config('qorpera_test.rs_run',pg_temp.wake_input_run(array['79500000-0000-4000-8000-000000000100'::uuid])::text,true);
set local role service_role;
select set_config('qorpera_test.rs_runner',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.rs_run')::uuid,
	'79500000-0000-4000-8000-0000000000c0','process',repeat('1',64)) ->> 'runner_id'),true);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine('79500000-0000-4000-8000-0000000000c0','process',repeat('7',64),
	current_setting('qorpera_test.rs_run')::uuid,current_setting('qorpera_test.rs_runner')::uuid) ->> 'state' = 'reserved',
	'The run machine is reserved on node A');

-- Runs off on node A.
select pg_temp.wake_assert(public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',false,1,'roll to v164')
	= '{"nodeId":"79500000-0000-4000-8000-00000000000a","version":1,"serving":true,"runsServing":false,"changed":true}'::jsonb,
	'Runs off on node A');
select pg_temp.wake_assert(public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',false,1,'again') ->> 'changed' = 'false',
	'Runs off again changes nothing');
select pg_temp.wake_error($q$select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',true,7,'stale')$q$,'PGRST');
reset role;
select pg_temp.wake_assert((select enabled and not runs_enabled and version = 1 from public.qorpera_runtime_nodes
		where id = '79500000-0000-4000-8000-00000000000a')
	and (select policy ->> 'enabled' = 'true' and not policy ? 'runsEnabled' from public.qorpera_runtime_node_policies
		where node_id = '79500000-0000-4000-8000-00000000000a' and version = 1)
	and (select count(*) = 1 from public.qorpera_runtime_node_serving_changes where node_id = '79500000-0000-4000-8000-00000000000a'
		and scope = 'runs' and not serving and reason = 'roll to v164'),
	'Only the runs switch moved, with its own record; the policy is untouched');
set local role service_role;

-- No new run lands on node A; machines still do.
select pg_temp.wake_assert(not (pg_temp.rs_candidate('native','process') ->> 'eligible')::boolean
	and (pg_temp.rs_candidate('native','native-b') ->> 'eligible')::boolean
	and (pg_temp.rs_candidate('coding','coding-a') ->> 'eligible')::boolean,
	'Node A is no run candidate, but still a coding candidate');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('79500000-0000-4000-8000-0000000000c0','native','process',repeat('1',64),
	repeat('7',64),repeat('a',64),4000,8589934592) = '{"state":"refused","reason":"NODE_DISABLED"}'::jsonb,
	'The ledger refuses a new run machine on node A');
select pg_temp.wake_assert(pg_temp.rs_coding('79500000-0000-4000-8000-000000000301','coding-a',repeat('3',64),repeat('a',64)) ->> 'state' = 'reserved',
	'A coding machine is still admitted on node A');
select pg_temp.wake_assert(pg_temp.rs_claim('30000000-0000-4000-8000-000000000092') = 'null'::jsonb,
	'Node A''s orchestrator claims nothing new');
select pg_temp.wake_assert(pg_temp.rs_claim('79500000-0000-4000-8000-0000000000b1') #>> '{work,run_id}' = current_setting('qorpera_test.rs_run'),
	'Node B''s orchestrator claims the run');
select pg_temp.wake_assert(public.qorpera_runtime_bundle_roll_status() #> '{bundles,0,servedBy}' = '["79500000-0000-4000-8000-0000000000b1"]'::jsonb,
	'Roll status counts only node B as serving: ' || public.qorpera_runtime_bundle_roll_status()::text);

-- Drain status: the fixture run still holds node A; machines do not.
select pg_temp.wake_assert((pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'serving')::boolean
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'runsServing')::boolean
	and (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'runs')::bigint = 1
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'readyForNodeRelease')::boolean
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'readyForUpdate')::boolean
	and pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') #>> '{lastChange,scope}' = 'runs',
	'Node A still holds its run: ' || pg_temp.rs_status('79500000-0000-4000-8000-00000000000a')::text);
-- Node C: an awake coding machine, no runs. Runs off: ready for a node release, not for a restart.
select pg_temp.wake_assert(pg_temp.rs_coding('79500000-0000-4000-8000-000000000302','coding-c',repeat('5',64),repeat('c',64)) ->> 'state' = 'reserved',
	'A coding machine runs on node C');
select pg_temp.wake_assert(not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForNodeRelease')::boolean,
	'A node that takes runs is never ready for a release');
select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000c',false,1,'roll to v164');
select pg_temp.wake_assert((pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForNodeRelease')::boolean
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForUpdate')::boolean
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForRestart')::boolean
	and pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') -> 'machinesAwake' = '{"coding":1}'::jsonb,
	'Runs off and no run left: ready for a node release while the coding machine runs: '
		|| pg_temp.rs_status('79500000-0000-4000-8000-00000000000c')::text);
-- The full switch still counts as runs off.
savepoint full_switch;
select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000c',true,1,'back');
select public.qorpera_set_runtime_node_serving('79500000-0000-4000-8000-00000000000c',false,1,'restart the host');
select pg_temp.wake_assert(not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'runsServing')::boolean
	and (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForNodeRelease')::boolean
	and not (pg_temp.rs_status('79500000-0000-4000-8000-00000000000c') ->> 'readyForRestart')::boolean,
	'The full switch stops runs too');
rollback to savepoint full_switch;

-- A new policy version keeps the runs switch (it is not part of the policy).
savepoint new_version;
select public.qorpera_configure_runtime_node(pg_temp.rs_policy('79500000-0000-4000-8000-00000000000a',repeat('a',64),'node-a')
	|| '{"headroomCpuMillis":7000}'::jsonb,1);
reset role;
select pg_temp.wake_assert((select version = 2 and enabled and not runs_enabled from public.qorpera_runtime_nodes
	where id = '79500000-0000-4000-8000-00000000000a'),'A new policy version keeps runs off');
set local role service_role;
rollback to savepoint new_version;

-- Runs on again: node A's orchestrator claims again (the run node B holds stays there).
select public.qorpera_set_runtime_node_runs('79500000-0000-4000-8000-00000000000a',true,1,'v164 on node A');
select pg_temp.wake_assert((pg_temp.rs_candidate('native','process') ->> 'eligible')::boolean
	and (pg_temp.rs_status('79500000-0000-4000-8000-00000000000a') ->> 'runsServing')::boolean,'Node A takes runs again');
reset role;
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
values('79500000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
	'user_message','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.session-prompt/v1","text":"Work","images":[]}');
select set_config('qorpera_test.rs_run2',pg_temp.wake_input_run(array['79500000-0000-4000-8000-000000000101'::uuid])::text,true);
set local role service_role;
savepoint claim_again;
select pg_temp.wake_assert(pg_temp.rs_claim('30000000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.rs_run2'),
	'Node A''s orchestrator claims again');
rollback to savepoint claim_again;

-- Placement follows bundle declarations. Node A holds the coding machine, so node B has more room and
-- is preferred; B's fast host is then declared for another bundle.
reset role;
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
select 'qorpera.cloud-runtime',b.version + 1,b.manifest || '{"fixtureRunsSwitch":true}'::jsonb,
	encode(extensions.digest(convert_to((b.manifest || '{"fixtureRunsSwitch":true}'::jsonb)::text,'utf8'),'sha256'),'hex')
from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
select set_config('qorpera_test.rs_next',(select sha256 from public.qorpera_runtime_bundles where manifest ? 'fixtureRunsSwitch'),true);
select set_config('qorpera_test.rs_bundle',(select runtime_bundle_sha256 from public.qorpera_execution_runs
	where id = current_setting('qorpera_test.rs_run2')::uuid),true);
select pg_temp.wake_assert(current_setting('qorpera_test.rs_bundle') = (select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton),
	'The run is of the active bundle');
set local role service_role;
select pg_temp.wake_assert(pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) ->> 'decision' = 'refused'
	and pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) ->> 'preferredNodeId' = '79500000-0000-4000-8000-00000000000b',
	'Undeclared, node B (more room) is preferred');
select public.qorpera_declare_runner_orchestrator_bundle('79500000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.rs_next'));
select pg_temp.wake_assert(pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) ->> 'decision' = 'placed'
	and pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) ->> 'reason' = 'LEAST_LOADED'
	and pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) ->> 'preferredNodeId' = '79500000-0000-4000-8000-00000000000a',
	'Node B runs another bundle: node A takes the run');
select pg_temp.wake_assert(pg_temp.rs_decide('native-b',current_setting('qorpera_test.rs_bundle')) ->> 'decision' = 'refused'
	and pg_temp.rs_decide('native-b',current_setting('qorpera_test.rs_bundle')) ->> 'preferredNodeId' = '79500000-0000-4000-8000-00000000000a',
	'Node B is refused a run of the other bundle');
select pg_temp.wake_assert(pg_temp.rs_decide('native-b',current_setting('qorpera_test.rs_next')) ->> 'decision' = 'placed',
	'Node B is chosen for a run of its own bundle');
select pg_temp.wake_assert(exists(select 1 from jsonb_array_elements(pg_temp.rs_decide('process',current_setting('qorpera_test.rs_bundle')) -> 'candidates') c
		where c ->> 'providerId' = 'native-b' and (c ->> 'otherBundle')::boolean and not (c ->> 'eligible')::boolean),
	'The record shows why node B was passed over');
select pg_temp.wake_assert(public.qorpera_runtime_node_placement_decide(extensions.gen_random_uuid(),'native','process',null::uuid,null::uuid)
		->> 'preferredNodeId' = '79500000-0000-4000-8000-00000000000b'
	and public.qorpera_runtime_node_placement_decide(extensions.gen_random_uuid(),'native','process',null::uuid)
		->> 'preferredNodeId' = '79500000-0000-4000-8000-00000000000b',
	'The five- and four-argument choosers pass no bundle and decide as before');
-- The run reservation passes its run's bundle (no dispatch roles here, so the chooser decides). The run's
-- identity moves into the vault first, as 691 does, so it has no home node and the general rule places it.
reset role;
select set_config('qorpera_test.rs_identity',(select compute_identity_id::text from public.qorpera_execution_runs
	where id = current_setting('qorpera_test.rs_run2')::uuid),true);
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
select '79500000-0000-4000-8000-000000000040', identity.profile_id, 'https://secrets.qorpera.test', 'company-kek-1', repeat('c',64)
from public.qorpera_member_compute_identities identity where identity.id = current_setting('qorpera_test.rs_identity')::uuid;
insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
	owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
select '79500000-0000-4000-8000-000000000060', capsule.profile_id, capsule.compute_identity_id, capsule.ownership_kind,
	capsule.owner_user_id, capsule.owner_scope_key, 'openai', 'codex-cli',
	'model-login/79500000-0000-4000-8000-000000000050', capsule.attestation_policy_sha256, capsule.created_by_user_id
from public.qorpera_native_credential_capsules capsule
where capsule.compute_identity_id = current_setting('qorpera_test.rs_identity')::uuid and capsule.status = 'active'
order by capsule.created_at limit 1;
insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
	provider,native_harness,current_version,access_issued_at,access_expires_at)
select '79500000-0000-4000-8000-000000000050', capsule.profile_id, capsule.compute_identity_id, capsule.id,
	'79500000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '10 days'
from public.qorpera_native_credential_capsules capsule where capsule.id = '79500000-0000-4000-8000-000000000060';
update public.qorpera_native_credential_capsules set status = 'disabled'
where compute_identity_id = current_setting('qorpera_test.rs_identity')::uuid
	and status = 'active' and encrypted_capsule_reference not like 'model-login/%';
select pg_temp.wake_assert(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.rs_identity')::uuid),
	'The run''s login is in the vault');
set local role service_role;
select set_config('qorpera_test.rs_runner2',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.rs_run2')::uuid,
	'79500000-0000-4000-8000-0000000000c1','process',repeat('1',64)) ->> 'runner_id'),true);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine('79500000-0000-4000-8000-0000000000c1','process',repeat('8',64),
	current_setting('qorpera_test.rs_run2')::uuid,current_setting('qorpera_test.rs_runner2')::uuid) ->> 'state' = 'reserved',
	'The run reservation on node A is placed');
reset role;
select pg_temp.wake_assert((select decision = 'placed' and reason = 'LEAST_LOADED' and node_id = '79500000-0000-4000-8000-00000000000a'
	from public.qorpera_runtime_node_placements where allocation_id = '79500000-0000-4000-8000-0000000000c1'),
	'The placement record says node A: ' || (select to_jsonb(p) - 'candidates' from public.qorpera_runtime_node_placements p where allocation_id = '79500000-0000-4000-8000-0000000000c1')::text);
-- The adapter rule: undeclared or same bundle takes it; all declared for another does not; none at all does.
select pg_temp.wake_assert(public.qorpera_runtime_adapter_takes_bundle('process',current_setting('qorpera_test.rs_bundle'))
	and not public.qorpera_runtime_adapter_takes_bundle('native-b',current_setting('qorpera_test.rs_bundle'))
	and public.qorpera_runtime_adapter_takes_bundle('native-b',current_setting('qorpera_test.rs_next'))
	and public.qorpera_runtime_adapter_takes_bundle('no-orchestrator',current_setting('qorpera_test.rs_bundle'))
	and public.qorpera_runtime_adapter_takes_bundle('native-b',null),'Which adapters take a bundle');
savepoint revoked;
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '79500000-0000-4000-8000-0000000000b1';
select pg_temp.wake_assert(public.qorpera_runtime_adapter_takes_bundle('native-b',current_setting('qorpera_test.rs_bundle')),
	'A revoked orchestrator does not hold its adapter to its bundle');
rollback to savepoint revoked;
set local role service_role;

-- One node's orchestrators at once.
select pg_temp.wake_error($q$select public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-00000000000b',repeat('9',64))$q$,
	'42501','Runtime bundle is not registered');
select pg_temp.wake_error($q$select public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-00000000000b','not-a-sha')$q$,
	'42501','Invalid node bundle declaration');
select pg_temp.wake_error($q$select public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-000000000009',null)$q$,
	'42501','Node is not configured');
select pg_temp.wake_assert(public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-00000000000a',current_setting('qorpera_test.rs_bundle'))
	#>> '{orchestrators,0,orchestratorId}' = '30000000-0000-4000-8000-000000000092','Node A declared');
reset role;
select pg_temp.wake_assert((select runtime_bundle_sha256 = current_setting('qorpera_test.rs_bundle') from public.qorpera_runner_orchestrators
		where id = '30000000-0000-4000-8000-000000000092')
	and (select runtime_bundle_sha256 = current_setting('qorpera_test.rs_next') from public.qorpera_runner_orchestrators
		where id = '79500000-0000-4000-8000-0000000000b1'),'Only node A''s orchestrator changed');
set local role service_role;
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-00000000000b',null) -> 'orchestrators') = 1,
	'Node B cleared');
reset role;
select pg_temp.wake_assert((select runtime_bundle_sha256 is null from public.qorpera_runner_orchestrators
	where id = '79500000-0000-4000-8000-0000000000b1'),'Node B''s fast host is undeclared');
set local role service_role;
-- An adapter on two nodes would declare both: refused.
select public.qorpera_enroll_runtime_node_provider('79500000-0000-4000-8000-00000000000c',repeat('c',64),'native','native-b',repeat('6',64),4000,8589934592);
select pg_temp.wake_error($q$select public.qorpera_declare_runtime_node_bundle('79500000-0000-4000-8000-00000000000b',null)$q$,
	'55000','An orchestrator of this node also serves another node');
rollback;
