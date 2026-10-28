-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Identical nodes, change 1 (20260928180700), on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): a
-- node is serving or emptying.
--   * The switch flips only the node's `enabled` flag (and its stored policy's), with a reason and the
--     node's version check; it keeps the version.
--   * A reservation the node already holds (reserved, awake) passes admission again; a new one or a
--     sleeping machine's wake does not.
--   * An executor on an emptying node starts no new coding turn (its queued turns stay out of the claim's window of 8,
--     so a lapsed turn is still failed) and starts the next one once serving again; a running one blocks the update.
--   * An emptying node's orchestrators claim nothing new; the other node's orchestrators do.
--   * A node-local refusal makes only the refusing orchestrator wait; a second one inside that
--     wait makes every orchestrator wait. Preference and other refusals keep their old waits.
--   * The drain status counts runs, run machines, sign-ins and machines still on a node.
-- The fixture orchestrator ...092 (adapter 'process') holds the fixture run's claim (Alice's); here its
-- adapter runs on node A. A second orchestrator (adapter 'native-b') runs on node B. The queued runs are the owner's
-- posts in Bob's thread, turned into runs by the folder materializer. The coding workers' todo is a real todo file in
-- Alice's folder, written by the owner's folder commit; the workers, their machine allocations, the coding executors
-- and the coding sessions are fixture rows, and the coding claims go through the real qorpera_claim_coding_session.
select pg_temp.base_commit(pg_temp.base_owner(), 'serving-todo', jsonb_build_array(pg_temp.base_write('QorperaOS/agents/alice/todos/serving.md',
	'todo', E'---\nid: 64000000-0000-4000-8000-0000000000d1\ntitle: Empty a node\nstatus: open\n---\n\n',
	'{"kind":"todo","id":"64000000-0000-4000-8000-0000000000d1","title":"Empty a node","status":"open","requestedBy":null,"detail":""}'))) \g /dev/null
select pg_temp.base_claims('service_role');
reset role;

create function pg_temp.sw_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;
create function pg_temp.sw_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.sw_refuse(p_orchestrator uuid,p_claim jsonb,p_reason text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),'ADMISSION_REFUSED:' || p_reason)
$$;
create function pg_temp.sw_job(p_run uuid) returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id = job.id where run.id = p_run
$$;
create function pg_temp.sw_status(p_node uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_node_drain_status(p_node)
$$;
-- The owner's post in Bob's thread, and the materializer pass that makes it a queued run. Called with the role reset.
create function pg_temp.sw_post_run(p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000031',p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.sw_policy('64000000-0000-4000-8000-000000000001',repeat('a',64),'node-a'),0);
select public.qorpera_configure_runtime_node(pg_temp.sw_policy('64000000-0000-4000-8000-000000000002',repeat('b',64),'node-b'),0);
select public.qorpera_configure_runtime_node(pg_temp.sw_policy('64000000-0000-4000-8000-000000000003',repeat('c',64),'node-c'),0);
select public.qorpera_enroll_runtime_node_provider('64000000-0000-4000-8000-000000000001',repeat('a',64),'native','process',repeat('1',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_provider('64000000-0000-4000-8000-000000000002',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592);
select public.qorpera_register_runner_orchestrator('64000000-0000-4000-8000-000000000012','Node B fast host','native-b',repeat('4',64),3600);

-- Operator only.
reset role;
select pg_temp.base_assert(not has_function_privilege(role_name,fn,'EXECUTE'),'Not public: ' || fn || ' for ' || role_name)
from unnest(array['anon','authenticated']) role_name,
	unnest(array['public.qorpera_set_runtime_node_serving(uuid,boolean,bigint,text)','public.qorpera_runtime_node_drain_status(uuid)',
		'public.qorpera_runtime_orchestrator_nodes(text)']) fn;
select pg_temp.base_assert(not has_function_privilege('service_role','public.qorpera_runtime_orchestrator_nodes(text)','EXECUTE'),
	'The adapter-to-node helper is internal');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_runtime_node_drain_status('64000000-0000-4000-8000-000000000001')$q$,'42501');
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',false,1,'  ')$q$,
	'42501','Invalid node serving change');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000009',false,1,'update')$q$,
	'42501','Node is not configured');

-- Both nodes serve; the fixture run on node A counts as one run there.
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'serving')::boolean
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'runs')::bigint = 1
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'readyForUpdate')::boolean
	and pg_temp.sw_status('64000000-0000-4000-8000-000000000001') -> 'lastChange' = 'null'::jsonb
	and jsonb_array_length(pg_temp.sw_status('64000000-0000-4000-8000-000000000001') -> 'orchestrators') = 1,
	'Node A serves, with the fixture run on it: ' || pg_temp.sw_status('64000000-0000-4000-8000-000000000001')::text);
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'runs')::bigint = 0,
	'Node B has no run yet');
-- An older accepted claim of the same job by node B (a retry moved the job) never counts: only the newest one does.
savepoint older_claim;
reset role;
insert into public.qorpera_runner_job_claims(id,orchestrator_id,client_claim_id,job_id,run_id,lease_expires_at,status,created_at)
select extensions.gen_random_uuid(),'64000000-0000-4000-8000-000000000012',extensions.gen_random_uuid(),job.id,job.run_id,
	clock_timestamp() + interval '1 minute','accepted',clock_timestamp() - interval '1 hour'
from public.qorpera_runner_jobs job where job.run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
set local role service_role;
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'runs')::bigint = 0
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'runs')::bigint = 1,'Only the newest accepted claim counts');
rollback to savepoint older_claim;

-- Empty node A.
select pg_temp.base_assert(public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',false,1,'update to v142')
	= '{"nodeId":"64000000-0000-4000-8000-000000000001","version":1,"serving":false,"changed":true}'::jsonb,'Node A switched off');
select pg_temp.base_assert(public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',false,1,'again')
	= '{"nodeId":"64000000-0000-4000-8000-000000000001","version":1,"serving":false,"changed":false}'::jsonb,
	'Switching off again changes nothing');
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',true,7,'stale')$q$,
	'PGRST');
reset role;
-- The node keeps its policy version, so its inventory receipt stays valid; the switch has its own record.
select pg_temp.base_assert((select not enabled and version = 1 from public.qorpera_runtime_nodes where id = '64000000-0000-4000-8000-000000000001')
	and (select count(*) = 1 from public.qorpera_runtime_node_policies where node_id = '64000000-0000-4000-8000-000000000001')
	and (select count(*) = 1 from public.qorpera_runtime_node_serving_changes where node_id = '64000000-0000-4000-8000-000000000001'
		and version = 1 and not serving and reason = 'update to v142'),
	'The node keeps its version and the change record says why');
set local role service_role;
select pg_temp.base_assert(not (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'serving')::boolean
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'runs')::bigint = 1
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000001') ->> 'readyForUpdate')::boolean
	and pg_temp.sw_status('64000000-0000-4000-8000-000000000001') #>> '{lastChange,reason}' = 'update to v142',
	'Emptying node A still holds its running run');

-- A queued run (the owner's post in Bob's thread): node A's orchestrator (emptying) takes nothing; node B's takes it.
reset role;
select set_config('qorpera_test.sw_run',pg_temp.sw_post_run('Look at the numbers.')::text,true);
set local role service_role;
select pg_temp.base_assert(pg_temp.sw_claim('92400000-0000-4000-8000-000000000092') = 'null'::jsonb,
	'The emptying node''s orchestrator claims nothing');
select set_config('qorpera_test.sw_claim',pg_temp.sw_claim('64000000-0000-4000-8000-000000000012')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.sw_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.sw_run'),
	'The serving node''s orchestrator claims the run');

-- Node B's fast host is full: only node B waits.
select pg_temp.base_assert((pg_temp.sw_refuse('64000000-0000-4000-8000-000000000012',current_setting('qorpera_test.sw_claim')::jsonb,
	'SANDBOX_CAPACITY_EXHAUSTED') ->> 'deferred')::boolean,'A full fast host defers');
reset role;
select pg_temp.base_assert((pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_refused_by = '64000000-0000-4000-8000-000000000012'
	and (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_deferred_until > statement_timestamp() + interval '14 seconds',
	'Only the refusing orchestrator waits, for 15 s');
set local role service_role;
select pg_temp.base_assert(pg_temp.sw_claim('64000000-0000-4000-8000-000000000012') = 'null'::jsonb,'Node B waits');
select pg_temp.base_assert(public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',true,1,'update done') ->> 'serving' = 'true',
	'Node A serves again');
select set_config('qorpera_test.sw_claim',pg_temp.sw_claim('92400000-0000-4000-8000-000000000092')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.sw_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.sw_run'),
	'Node A takes the run at once instead of waiting 15 s');

-- Node A is full too, inside node B's wait: now every orchestrator waits.
select pg_temp.sw_refuse('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.sw_claim')::jsonb,'NODE_CAPACITY_EXHAUSTED');
reset role;
select pg_temp.base_assert((pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_refused_by is null
	and (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_deferred_until > statement_timestamp() + interval '14 seconds',
	'Two full nodes: every orchestrator waits');
set local role service_role;
select pg_temp.base_assert(pg_temp.sw_claim('92400000-0000-4000-8000-000000000092') = 'null'::jsonb
	and pg_temp.sw_claim('64000000-0000-4000-8000-000000000012') = 'null'::jsonb,'Neither node trades the job back');

-- Preference refusals keep their 5 s wait for the refuser; other refusals make everyone wait 15 s.
reset role;
update public.qorpera_runner_jobs set dispatch_deferred_until = null, dispatch_refused_by = null
where id = (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).id;
set local role service_role;
select set_config('qorpera_test.sw_claim',pg_temp.sw_claim('64000000-0000-4000-8000-000000000012')::text,true);
select pg_temp.sw_refuse('64000000-0000-4000-8000-000000000012',current_setting('qorpera_test.sw_claim')::jsonb,'NODE_NOT_PREFERRED');
reset role;
select pg_temp.base_assert((pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_refused_by = '64000000-0000-4000-8000-000000000012'
	and (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_deferred_until < statement_timestamp() + interval '6 seconds',
	'Node preference: the refuser waits 5 s');
set local role service_role;
select set_config('qorpera_test.sw_claim',pg_temp.sw_claim('92400000-0000-4000-8000-000000000092')::text,true);
select pg_temp.sw_refuse('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.sw_claim')::jsonb,'NO_ELIGIBLE_NODE');
reset role;
select pg_temp.base_assert((pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_refused_by is null
	and (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_deferred_until > statement_timestamp() + interval '14 seconds',
	'No eligible node anywhere: every orchestrator waits 15 s');
select pg_temp.base_assert((pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).dispatch_failure_count = 0
	and (pg_temp.sw_job(current_setting('qorpera_test.sw_run')::uuid)).status = 'queued',
	'Placement refusals are never dispatch failures');

-- Node C: a machine's reservation stays through emptying; a new one is refused; the status counts both kinds. The two
-- coding workers work on Alice's todo file, steered by the fixture run.
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select ('64000000-0000-4000-8000-00000000030' || n)::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'serving-' || n,
	'coding','Serving ' || n,'read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	'92400000-0000-4000-8000-000000000001',(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo cross join generate_series(1,2) n
where todo.id = '64000000-0000-4000-8000-0000000000d1' and todo.staff_agent_id = '92400000-0000-4000-8000-000000000030';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select ('64000000-0000-4000-8000-00000000040' || n)::uuid,worker.profile_id,worker.id,'coding-serving',
	encode(extensions.digest('serving-vm-' || n,'sha256'),'hex')
from generate_series(1,2) n join public.qorpera_runtime_workers worker on worker.id = ('64000000-0000-4000-8000-00000000030' || n)::uuid;
select pg_temp.base_assert((select count(*) from public.qorpera_runtime_machine_allocations
	where profile_id = '92400000-0000-4000-8000-000000000010' and provider_adapter = 'coding-serving') = 2,
	'Two coding allocations of the folder-v2 company');
create function pg_temp.sw_observe() returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','64000000-0000-4000-8000-000000000003','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',32000,'memoryBytes',68719476736,'state','ready'),
		public.qorpera_runtime_node_inventory_context('64000000-0000-4000-8000-000000000003') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
create function pg_temp.sw_reserve(p_n integer) returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_node_machine(('64000000-0000-4000-8000-00000000040' || p_n)::uuid,'coding','coding-serving',
		repeat('3',64),encode(extensions.digest('serving-vm-' || p_n,'sha256'),'hex'),repeat('c',64),4000,8589934592)
$$;
set local role service_role;
select public.qorpera_enroll_runtime_node_provider('64000000-0000-4000-8000-000000000003',repeat('c',64),'coding','coding-serving',repeat('3',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
	'nodeId','64000000-0000-4000-8000-000000000003','host',jsonb_build_object('machineIdSha256',repeat('c',64),
	'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
	'serverVersion','5.21','architecture','x86_64'),'operatingCpuMillis',2000,'operatingMemoryBytes',4294967296,'infrastructure','[]'::jsonb));
select pg_temp.sw_observe();
select pg_temp.base_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved','A coding machine is reserved on node C');
select pg_temp.base_assert(pg_temp.sw_status('64000000-0000-4000-8000-000000000003') -> 'machinesAwake' = '{"coding":1}'::jsonb
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'runs')::bigint = 0
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'readyForUpdate')::boolean,
	'A serving node is never ready for an update: ' || pg_temp.sw_status('64000000-0000-4000-8000-000000000003')::text);
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000003',false,1,'restart the host');
reset role;
select pg_temp.base_assert((select policy ->> 'enabled' from public.qorpera_runtime_node_policies
	where node_id = '64000000-0000-4000-8000-000000000003' and version = 1) = 'false',
	'The stored policy of the node''s version follows the switch');
select pg_temp.base_assert((select policy ->> 'enabled' from public.qorpera_runtime_node_policies
	where node_id = '64000000-0000-4000-8000-000000000002' and version = 1) = 'true',
	'Another node''s stored policy is untouched');
set local role service_role;
-- Only the current version's stored policy follows; an older version keeps what it said.
savepoint policy_versions;
select public.qorpera_configure_runtime_node(pg_temp.sw_policy('64000000-0000-4000-8000-000000000002',repeat('b',64),'node-b')
	|| '{"headroomCpuMillis":7000}'::jsonb,1);
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000002',false,2,'older versions stay');
reset role;
select pg_temp.base_assert((select jsonb_object_agg(version::text, policy -> 'enabled') from public.qorpera_runtime_node_policies
	where node_id = '64000000-0000-4000-8000-000000000002') = '{"1": true, "2": false}'::jsonb,
	'The switch writes only the current version''s stored policy');
set local role service_role;
rollback to savepoint policy_versions;
select pg_temp.base_assert(pg_temp.sw_reserve(2) ->> 'reason' = 'NODE_DISABLED','An emptying node admits no new machine');
-- The machine already there keeps its reservation and passes admission again (its coding turn re-asks
-- before each step), with no new observation: the switch kept the node's version.
select pg_temp.base_assert(pg_temp.sw_reserve(1) ->> 'state' = 'reserved','A held reservation keeps passing admission');
reset role;
select pg_temp.base_assert((select reserved_at is not null and released_at is null and suspended_at is null
	from public.qorpera_runtime_node_demands where allocation_id = '64000000-0000-4000-8000-000000000401'),
	'The machine already there keeps its reservation');
-- A coding turn running on node C's executor keeps the node from being ready; a new turn does not start there.
insert into public.qorpera_coding_executors(environment_id,owner,enabled,harnesses,nas_machine_id_sha256)
select environment_id,'coding-node-c',true,array['codex'],repeat('c',64) from public.qorpera_runtime_workers
where id = '64000000-0000-4000-8000-000000000301';
insert into public.qorpera_coding_sessions(worker_id,profile_id,environment_id,harness,repository,branch,phase,lease_owner,lease_token,lease_until,started_at)
select id,profile_id,environment_id,'codex','{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}'::jsonb,'main','running','coding-node-c',extensions.gen_random_uuid(),
	clock_timestamp() + interval '1 minute',clock_timestamp()
from public.qorpera_runtime_workers where id = '64000000-0000-4000-8000-000000000301';
insert into public.qorpera_coding_sessions(worker_id,profile_id,environment_id,harness,repository,branch)
select id,profile_id,environment_id,'codex','{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}'::jsonb,'second' from public.qorpera_runtime_workers
where id = '64000000-0000-4000-8000-000000000302';
set local role service_role;
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'codingTurns')::bigint = 1
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'readyForUpdate')::boolean,
	'A running coding turn blocks the update: ' || pg_temp.sw_status('64000000-0000-4000-8000-000000000003')::text);
-- Only the executor that holds the lease counts: another executor of the same environment on node B does not.
savepoint coding_owner;
reset role;
insert into public.qorpera_coding_executors(environment_id,owner,enabled,harnesses,nas_machine_id_sha256)
select environment_id,'coding-node-b',true,array['codex'],repeat('b',64) from public.qorpera_runtime_workers
where id = '64000000-0000-4000-8000-000000000301';
set local role service_role;
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'codingTurns')::bigint = 0
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'codingTurns')::bigint = 1,
	'A coding turn counts only on the node of the executor holding its lease');
rollback to savepoint coding_owner;
select pg_temp.base_assert(public.qorpera_claim_coding_session('coding-node-c',60) is null,
	'The emptying node''s executor starts no new coding turn');
-- Queued turns pinned to the emptying node's executor stay out of the candidates: ten older ones (nine
-- made here and the queued turn from above) do not crowd a lapsed turn out of the window of 8, so it is
-- still failed visibly. The running turn from above holds its lease on coding-node-c, which is what
-- pins the member's queued turns to that executor.
savepoint coding_window;
reset role;
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select ('64000000-0000-4000-8000-0000000005' || lpad(n::text,2,'0'))::uuid,todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,
	'window-' || n,'coding','Window ' || n,'read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	'92400000-0000-4000-8000-000000000001',(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,1
from public.qorpera_runtime_agent_todos todo cross join generate_series(1,10) n where todo.id = '64000000-0000-4000-8000-0000000000d1';
insert into public.qorpera_coding_sessions(worker_id,profile_id,environment_id,harness,repository,branch,updated_at)
select id,profile_id,environment_id,'codex','{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}'::jsonb,'w-' || worker_key,
	clock_timestamp() - interval '1 hour'
from public.qorpera_runtime_workers where worker_key like 'window-%' and worker_key <> 'window-10';
insert into public.qorpera_coding_sessions(worker_id,profile_id,environment_id,harness,repository,branch,phase,lease_owner,lease_token,
	lease_until,started_at,updated_at)
select id,profile_id,environment_id,'codex','{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}'::jsonb,'w-window-10',
	'running','coding-node-c',extensions.gen_random_uuid(),clock_timestamp() - interval '1 minute',clock_timestamp() - interval '10 minutes',
	clock_timestamp()
from public.qorpera_runtime_workers where worker_key = 'window-10';
set local role service_role;
select pg_temp.base_assert(public.qorpera_claim_coding_session('coding-node-c',60) is null,'Still no new turn on the emptying node');
reset role;
select pg_temp.base_assert((select phase from public.qorpera_coding_sessions where worker_id = '64000000-0000-4000-8000-000000000510') = 'failed',
	'A lapsed turn is failed although ten older queued turns are pinned to the emptying executor');
set local role service_role;
rollback to savepoint coding_window;
savepoint coding_serving;
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000003',true,1,'serving again');
reset role;
select pg_temp.base_assert((select policy ->> 'enabled' from public.qorpera_runtime_node_policies
	where node_id = '64000000-0000-4000-8000-000000000003' and version = 1) = 'true',
	'Switching back on writes the stored policy too');
set local role service_role;
select pg_temp.base_assert(public.qorpera_claim_coding_session('coding-node-c',60) is not null,
	'Serving again, the executor starts the member''s next turn');
reset role;
select pg_temp.base_assert((select phase = 'preparing' and lease_owner = 'coding-node-c' from public.qorpera_coding_sessions
	where worker_id = '64000000-0000-4000-8000-000000000302'),'The started turn is the member''s queued one, on node C''s executor');
set local role service_role;
rollback to savepoint coding_serving;
reset role;
update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null,
	finished_at = clock_timestamp() where worker_id = '64000000-0000-4000-8000-000000000301';
set local role service_role;
select pg_temp.base_assert(not exists(select 1 from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('coding')) c
	where c ->> 'nodeId' = '64000000-0000-4000-8000-000000000003' and (c ->> 'eligible')::boolean),'Placement skips the emptying node');
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'readyForUpdate')::boolean
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'readyForRestart')::boolean,
	'No runs left: ready for an update, but an awake machine blocks a restart');
reset role;
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = '64000000-0000-4000-8000-000000000401';
set local role service_role;
select pg_temp.base_assert(pg_temp.sw_status('64000000-0000-4000-8000-000000000003') -> 'machinesAwake' = '{}'::jsonb
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'machinesAsleep')::bigint = 1
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000003') ->> 'readyForRestart')::boolean,
	'A sleeping machine keeps its disk on the node and does not block a restart');
select pg_temp.base_assert(pg_temp.sw_reserve(1) ->> 'reason' = 'NODE_DISABLED','A sleeping machine does not wake on an emptying node');

-- Replays still work on an emptying node: a claim taken before the switch comes back after it. The run is another post
-- in Bob's thread; the queued run from above is deferred for every orchestrator.
savepoint replay;
reset role;
select set_config('qorpera_test.sw_replay_run',pg_temp.sw_post_run('Replay')::text,true);
set local role service_role;
select pg_temp.base_assert(public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
	'64000000-0000-4000-8000-0000000000aa',120) #>> '{work,run_id}' = current_setting('qorpera_test.sw_replay_run'),'Claimed before the switch');
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000001',false,1,'replay check');
select pg_temp.base_assert(public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
	'64000000-0000-4000-8000-0000000000aa',120) #>> '{work,run_id}' = current_setting('qorpera_test.sw_replay_run'),
	'The same claim replays on the emptying node');
select pg_temp.base_assert(pg_temp.sw_claim('92400000-0000-4000-8000-000000000092') = 'null'::jsonb,'But no new claim');
rollback to savepoint replay;

-- An adapter enrolled on a second, serving node is not stopped by the switch: the drain status says so.
-- Node B holds no run, so the doubled adapter is the only thing between it and an update.
savepoint elsewhere;
select public.qorpera_configure_runtime_node(pg_temp.sw_policy('64000000-0000-4000-8000-000000000004',repeat('d',64),'node-d'),0);
select public.qorpera_enroll_runtime_node_provider('64000000-0000-4000-8000-000000000004',repeat('d',64),'native','native-b',repeat('5',64),4000,8589934592);
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000002',false,1,'drain with a doubled adapter');
select pg_temp.base_assert(pg_temp.sw_status('64000000-0000-4000-8000-000000000002') -> 'orchestratorsServingElsewhere'
		= '["64000000-0000-4000-8000-000000000012"]'::jsonb
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'runs')::bigint = 0
	and (pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'codingTurns')::bigint = 0
	and not (pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'readyForUpdate')::boolean,
	'A doubled adapter alone blocks readiness: ' || pg_temp.sw_status('64000000-0000-4000-8000-000000000002')::text);
select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000004',false,1,'drain the other node too');
select pg_temp.base_assert((pg_temp.sw_status('64000000-0000-4000-8000-000000000002') ->> 'readyForUpdate')::boolean,
	'With the other node empty too, node B is ready for its update');
rollback to savepoint elsewhere;

-- The older signed updater keeps `enabled` while it holds a node, and while an update is prepared.
reset role;
insert into public.qorpera_node_update_enrollments(node_id,capability_revision,capability_sha256,enabled,current_revision,
	current_release_sha256,current_artifact_sha256)
values('64000000-0000-4000-8000-000000000002',1,repeat('d',64),true,0,repeat('d',64),repeat('d',64));
insert into public.qorpera_node_update_targets(node_id,revision,release_sha256,release_text,signature,publication_evidence_sha256,
	company_ids)
values('64000000-0000-4000-8000-000000000002',1,repeat('9',64),'{}','x',repeat('9',64),array['92400000-0000-4000-8000-000000000010'::uuid]);
set local role service_role;
select pg_temp.base_error($q$select public.qorpera_set_runtime_node_serving('64000000-0000-4000-8000-000000000002',false,1,'drain')$q$,
	'55000','A node update holds this node');
reset role;
rollback;
