-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Order 9, part 3: the executor's side of a coding session. The dispatch fixture
-- is part 1's (395); what follows is the VM, the storage, the turn as the runner
-- sees it, the submission and the completion.
-- Part 1 fixture: The agent dispatches
-- it as a species of the Order 5 worker; one member owns it and their own
-- connection sponsors its wakes; the executor admits each turn when the
-- workspace is ready and reports through the Order 5 completion path; only the
-- owner talks to the session; the session survives cancellation and completion.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.parent_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.todo(p_request jsonb,p_binding jsonb default null) returns jsonb language sql as $$
	select public.qorpera_manage_agent_todo(coalesce(p_binding,current_setting('qorpera_test.parent_binding')::jsonb),p_request)
$$;
create function pg_temp.worker(p_request jsonb,p_binding jsonb default null) returns jsonb language sql as $$
	select public.qorpera_manage_agent_worker(coalesce(p_binding,current_setting('qorpera_test.parent_binding')::jsonb),p_request)
$$;
create function pg_temp.worker_row(p_key text) returns public.qorpera_runtime_workers language sql as $$
	select worker from public.qorpera_runtime_workers worker where worker.worker_key = p_key
$$;
create function pg_temp.session_row(p_key text) returns public.qorpera_coding_sessions language sql as $$
	select session from public.qorpera_coding_sessions session join public.qorpera_runtime_workers worker on worker.id = session.worker_id
	where worker.worker_key = p_key
$$;
create function pg_temp.events(p_key text,p_kind text) returns bigint language sql as $$
	select count(*) from public.qorpera_coding_session_events event join public.qorpera_runtime_workers worker on worker.id = event.worker_id
	where worker.worker_key = p_key and event.kind = p_kind
$$;
create function pg_temp.finish_job(p_run uuid,p_status text default 'completed') returns void language sql as $$
	update public.qorpera_runner_jobs set status = p_status,result = case when p_status = 'completed' then '{}'::jsonb end,
		last_error = case when p_status = 'failed' then 'Fixture failure' end,
		finished_at = case when p_status <> 'cancelled' then statement_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then statement_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '30000000-0000-4000-8000-000000000001'::uuid end,
		lease_token_sha256 = null,lease_expires_at = null where run_id = p_run
$$;
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
	select pg_temp.path_claims('authenticated',p_user)
$$;

select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'progress','coding-ack');
select pg_temp.todo('{"action":"upsert","operationKey":"todo-c1","todoKey":"composer-latency","title":"Fix the delay after send"}');

-- 1. Dispatch is refused until the company has an executor and the agent a repository grant; then it creates
--    a coding worker owned by the requesting member, sponsored by that member's own connection, with no wake yet.
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"Fix the delay after send","goal":"Post first, refresh after.","definitionOfDone":"Tests pass.","access":"read",
	"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,
	'55000','No coding executor serves this company for codex');
select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-test',true,array['codex']);
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"Fix the delay after send","goal":"Post first, refresh after.","definitionOfDone":"Tests pass.","access":"read",
	"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,
	'42501','This agent has no grant for that repository');
select public.qorpera_set_coding_repository_grant('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000030',
	'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}',true);
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"Fix the delay after send","goal":"g","definitionOfDone":"d","access":"read","species":"coding","harness":"claude-code",
	"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,'55000');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"Fix the delay after send","goal":"g","definitionOfDone":"d","access":"write","species":"coding","harness":"codex",
	"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,'22023',
	'A coding session needs a harness, a repository and read access');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"t","goal":"g","definitionOfDone":"d","access":"read","harness":"codex"}')$q$,'22023','Worker species is invalid');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c0","todoKey":"composer-latency","workerKey":"fix-send",
	"title":"t","goal":"g","definitionOfDone":"d","access":"read","species":"coding","harness":"codex","owner":"30000000-0000-4000-8000-000000000003",
	"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,'42501',
	'The session owner has no active openai account connected for codex');
do $$
declare v_first jsonb; v_replay jsonb; v_worker public.qorpera_runtime_workers; v_session public.qorpera_coding_sessions;
	v_sponsor jsonb := current_setting('qorpera_test.wake_sponsor')::jsonb;
	v_request jsonb := '{"action":"dispatch","operationKey":"c1","todoKey":"composer-latency","workerKey":"fix-send",
		"title":"Fix the delay after send","goal":"Post the message before refreshing the account.","definitionOfDone":"The send test passes and a draft PR exists.",
		"context":"The composer awaits the refresh.","sources":["work/todos"],"access":"read","species":"coding","harness":"codex",
		"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}';
begin
	v_first := pg_temp.worker(v_request);
	v_worker := pg_temp.worker_row('fix-send');
	v_session := pg_temp.session_row('fix-send');
	perform pg_temp.wake_assert(v_worker.species = 'coding' and v_worker.state = 'active' and v_worker.occurrence_id is null
		and v_worker.owner_user_id = '30000000-0000-4000-8000-000000000001'
		and v_worker.owner_sponsor_binding_id = (v_sponsor ->> 'binding_id')::uuid and v_worker.owner_sponsor_version = 1,
		'A coding worker is owned by the requesting member and sponsored by that member''s own connection');
	perform pg_temp.wake_assert(v_session.phase = 'queued' and v_session.harness = 'codex' and v_session.branch = 'qorpera/coding/' || v_worker.id::text
		and v_session.repository ->> 'name' = 'Qorpera_Base' and v_session.lease_token is null
		and v_first #>> '{coding,phase}' = 'queued' and v_first #>> '{coding,harness}' = 'codex' and v_first #>> '{worker,state}' = 'queued',
		'The session waits for the executor; no wake is admitted before the workspace exists');
	perform pg_temp.wake_assert(pg_temp.events('fix-send','phase') = 1 and v_worker.dispatch ->> 'output' like 'Finish through coding_finish%',
		'The dispatch is recorded as the first session event and tells the harness how to finish');
	v_replay := pg_temp.worker(v_request);
	perform pg_temp.wake_assert(v_replay = v_first and (select count(*) from public.qorpera_coding_sessions) = 1,'A replayed dispatch clones nothing');
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c2","todoKey":"composer-latency","workerKey":"notes",
		"title":"Notes","goal":"Summarise the thread.","definitionOfDone":"A note.","access":"read"}');
	perform pg_temp.wake_assert((pg_temp.worker_row('notes')).species = 'in-house' and (pg_temp.worker_row('notes')).occurrence_id is not null
		and (pg_temp.worker_row('notes')).owner_user_id is null,'An in-house worker is unchanged: admitted at once, no owner');
	perform pg_temp.worker('{"action":"cancel","operationKey":"c2-cancel","todoKey":"composer-latency","workerKey":"notes"}');
	perform pg_temp.wake_assert((pg_temp.worker_row('notes')).state = 'cancelled','The in-house helper leaves the queue');
end $$;
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"c3","todoKey":"composer-latency","workerKey":"fix-send-2",
	"title":"Second","goal":"g","definitionOfDone":"d","access":"read","species":"coding","harness":"codex",
	"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}')$q$,'54000',
	'The owner already has a coding session running in codex; wait for it or follow it up');


-- 1. Deployment policies belong to the executor; without them no machine is admitted.
do $$
declare v_claim jsonb; v_worker public.qorpera_runtime_workers; v_turn jsonb; v_plan jsonb; v_nas jsonb; v_storage jsonb; v_root text;
	v_binding text; v_env uuid := '30000000-0000-4000-8000-000000000020'; v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_vm uuid; v_machine jsonb; v_plan_row public.qorpera_coding_vm_plans; v_allocation public.qorpera_runtime_machine_allocations;
begin
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_worker := pg_temp.worker_row('fix-send');
	v_turn := public.qorpera_describe_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_turn ->> 'phase' = 'preparing' and v_turn ->> 'vmAllocationId' is null and v_turn -> 'submission' = 'null'::jsonb
		and (v_turn ->> 'turnId')::uuid = public.qorpera_coding_turn_id(v_worker.id,1) and v_turn ->> 'occurrenceId' is null,
		'The executor reads the turn it holds: preparing, no machine, no submission, a derived turn id');
	perform set_config('qorpera_test.coding_claim',v_claim::text,true);
	perform pg_temp.wake_assert(public.qorpera_coding_turn_id(v_worker.id,1) <> public.qorpera_coding_turn_id(v_worker.id,2)
		and public.qorpera_coding_turn_id(v_worker.id,1)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$',
		'Turn ids are per sequence and well formed');
	v_vm := '30000000-0000-4000-8000-000000000300';
	v_plan := jsonb_build_object('providerId','coding-fixture','providerPolicySha256',repeat('f',64),'project','coding','imageFingerprint',repeat('a',64),
		'bootstrapSha256',repeat('b',64),'storagePool','coding','network','coding','cpus',2,'memoryBytes',2147483648,'rootDiskBytes',4294967296);
	v_nas := jsonb_build_object('schema','qorpera.coding-nas-policy/v1','mountPoint','/srv/coding','rootPath','/srv/coding/executor',
		'source','192.168.1.40:/coding','serverAddress','192.168.1.40');
	v_root := '/srv/coding/executor/workers/' || v_profile::text || '/' || v_env::text || '/' || v_worker.id::text;
	v_storage := jsonb_build_object('schema','qorpera.coding-storage/v1','volumeId',v_worker.id,'workerId',v_worker.id,
		'companyId',v_profile,'environmentId',v_env,'writerGeneration',1,'machineIdSha256',repeat('c',64),
		'policy',v_nas,'dataSource',v_root || '/data','custodySource',v_root || '/guest-state',
		'dataTarget','/workspace','custodyTarget','/var/lib/qorpera-coding');
	v_binding := (v_plan || jsonb_build_object('storage',v_storage,'schema','qorpera.lxd-coding-vm/v2','workerId',v_worker.id,'allocationId',v_vm,
		'companyId',v_profile,'environmentId',v_env,'repository',(pg_temp.session_row('fix-send')).repository))::text;
	perform set_config('qorpera_test.coding_binding',v_binding,true);
	begin perform public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding,repeat('c',64),'run');
		raise exception 'Missing coding deployment policy admitted'; exception when insufficient_privilege then null; end;
	perform public.qorpera_configure_coding_vm_policy(v_env,'exec-test',v_plan);
	begin perform public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding,repeat('c',64),'run');
		raise exception 'Missing NAS policy admitted'; exception when insufficient_privilege then null; end;
	perform public.qorpera_configure_coding_nas_policy(v_env,'exec-test',repeat('c',64),v_nas);
	begin perform public.qorpera_authorize_coding_machine(v_worker.id,extensions.gen_random_uuid(),v_binding,repeat('c',64),'run');
		raise exception 'Foreign lease admitted a machine'; exception when insufficient_privilege then null; end;
	v_machine := public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding,repeat('c',64),'run');
	perform pg_temp.wake_assert(v_machine ->> 'reason' = 'NODE_PROVIDER_UNCONFIGURED','No coding node yet: refused, not invented');
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'label','coding-fixture',
		'cpuMillis',6000,'memoryBytes',8589934592,'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,
		'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'coding','coding-fixture',repeat('f',64),2000,2147483648);
	-- A node is usable only with a hardware observation and a matching inventory report.
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','5.21','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
	v_machine := public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding,repeat('c',64),'run');
	perform pg_temp.wake_assert(v_machine ->> 'schema' = 'qorpera.coding-vm-admission/v1' and v_machine ->> 'allocationId' = v_vm::text
		and v_machine ->> 'intent' = 'run' and (v_machine ->> 'validForMs')::int between 1 and 5000,'The machine is admitted with a short receipt: '||v_machine::text);
	select * into v_plan_row from public.qorpera_coding_vm_plans where worker_id = v_worker.id;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_vm;
	perform pg_temp.wake_assert(v_plan_row.owner = 'exec-test' and v_plan_row.allocation_id = v_vm and v_allocation.coding_worker_id = v_worker.id
		and v_allocation.run_id is null and v_allocation.runner_id is null and (pg_temp.session_row('fix-send')).vm_allocation_id = v_vm
		and (pg_temp.session_row('fix-send')).storage_volume_id = v_worker.id
		and exists (select 1 from public.qorpera_coding_storage_volumes where worker_id = v_worker.id and owner = 'exec-test'),
		'The plan, the ledger allocation, the storage volume and the session agree on the machine');
	begin perform public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,(v_binding::jsonb || jsonb_build_object('network','drift'))::text,repeat('c',64),'run');
		raise exception 'Plan drift accepted'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_authorize_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding,repeat('d',64),'run');
		raise exception 'Foreign host acquired the plan'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_configure_coding_nas_policy(v_env,'exec-test',repeat('d',64),v_nas);
		raise exception 'NAS writer host replaced without physical fence'; exception when sqlstate '55000' then null; end;
	-- Cleanup custody is the plan's owner on the plan's node, lease or no lease.
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_cleanup(v_worker.id,'exec-test',v_binding,repeat('c',64)) ->> 'intent' = 'stop'
		and public.qorpera_describe_coding_cleanup(v_worker.id,'exec-test',repeat('c',64)) ->> 'schema' = 'qorpera.coding-cleanup/v1',
		'Cleanup authority and the retained binding are available to the planning executor');
	begin perform public.qorpera_authorize_coding_cleanup(v_worker.id,'someone-else',v_binding,repeat('c',64));
		raise exception 'Foreign owner may stop the machine'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_describe_coding_cleanup(v_worker.id,'exec-test',repeat('d',64));
		raise exception 'Foreign node may read the binding'; exception when insufficient_privilege then null; end;
	perform public.qorpera_record_coding_progress(v_worker.id,(v_claim ->> 'leaseToken')::uuid,null,'Workspace ready',0,
		'[{"kind":"step","actor":"executor","body":{"text":"Prepared the repository VM"}}]',null,'a4d8f9f1c0b6e5a2d3c4b5a69788776655443322',v_vm,null,null);
end $$;

-- 2. The turn as the runner sees it: authority bounded by the lease, commands checked against the turn,
--    a durable submission, and the executor's view of the run's end.
do $$
declare v_claim jsonb := current_setting('qorpera_test.coding_claim')::jsonb; v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send');
	v_turn jsonb; v_wake public.qorpera_wake_occurrences; v_binding jsonb; v_authority jsonb; v_submission jsonb; v_replay jsonb; v_vm uuid := '30000000-0000-4000-8000-000000000300';
begin
	begin perform public.qorpera_authorize_coding_turn(current_setting('qorpera_test.parent_binding')::jsonb);
		raise exception 'The parent run passed as a coding turn'; exception when insufficient_privilege then null; end;
	v_turn := public.qorpera_begin_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId',v_vm,'turnId',public.qorpera_coding_turn_id(v_worker.id,1)));
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid;
	perform pg_temp.wake_assert(v_wake.status = 'materialized' and v_wake.payload #>> '{coding,vmId}' = v_vm::text
		and (v_wake.payload #>> '{coding,turnId}')::uuid = public.qorpera_coding_turn_id(v_worker.id,1),'The wake carries the machine and the turn id');
	v_binding := pg_temp.wake_start(v_wake.run_id);
	perform set_config('qorpera_test.coding_turn_binding',v_binding::text,true);
	v_authority := public.qorpera_authorize_coding_turn(v_binding);
	perform pg_temp.wake_assert(v_authority ->> 'schema' = 'qorpera.native-tool-authority/v1' and (v_authority ->> 'validForMs')::int between 1 and 60000
		and v_authority #>> '{coding,workerId}' = v_worker.id::text and (v_authority #>> '{coding,sequence}')::int = 1
		and v_authority #>> '{coding,vmId}' = v_vm::text and v_authority #>> '{coding,goal}' like 'Post the message%'
		and v_authority #>> '{coding,harness}' = 'codex' and v_authority #> '{coding,submission}' = 'null'::jsonb
		and v_authority #>> '{identity,staffAgentId}' = '30000000-0000-4000-8000-000000000030' and v_authority #> '{identity,sessionId}' = 'null'::jsonb,
		'The runner''s authority is the ordinary one, bounded by the session lease, with the coding scope');
	-- Commands: the scope must be this turn's, and the receipt the run's own.
	begin perform public.qorpera_authorize_coding_command(v_binding,jsonb_build_object('workerId',v_worker.id,'vmId',v_vm,
			'requestId',public.qorpera_coding_turn_id(v_worker.id,2),'turn',2),'start',extensions.gen_random_uuid(),repeat('a',64));
		raise exception 'Another turn''s scope authorized a command'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_authorize_coding_command(v_binding,jsonb_build_object('workerId',v_worker.id,'vmId',v_vm,
			'requestId',public.qorpera_coding_turn_id(v_worker.id,1),'turn',1),'start',extensions.gen_random_uuid(),repeat('a',64));
		raise exception 'A command without a receipt was authorized'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_begin_native_coding_execution(v_binding,repeat('0',64),repeat('0',64),repeat('0',64),
			'{"type":"namespace","name":"qorpera","tools":[{"name":"coding_run_command"},{"name":"send_message"},{"name":"coding_finish"},{"name":"coding_ask"}]}',repeat('0',64),10);
		raise exception 'A catalog with a mouth was admitted'; exception when insufficient_privilege then null; end;
	-- The submission: once, exactly, and replayable.
	begin perform public.qorpera_submit_coding_turn(v_binding,'{"kind":"finish","operationKey":"done","summary":"x","headSha":"short"}');
		raise exception 'A malformed submission was recorded'; exception when sqlstate '22023' then null; end;
	v_submission := public.qorpera_submit_coding_turn(v_binding,jsonb_build_object('kind','finish','operationKey','done',
		'summary','Composer posts first; the send test covers it.','headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
	v_replay := public.qorpera_submit_coding_turn(v_binding,jsonb_build_object('kind','finish','operationKey','done',
		'summary','Composer posts first; the send test covers it.','headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
	perform pg_temp.wake_assert(v_submission = v_replay and v_submission ->> 'kind' = 'finish' and v_submission ->> 'state' = 'submitted'
		and (pg_temp.session_row('fix-send')).submission = v_submission and (pg_temp.session_row('fix-send')).submission_receipt_id is not null
		and pg_temp.events('fix-send','text') >= 1,'The submission is durable, receipted and replay-stable');
	begin perform public.qorpera_submit_coding_turn(v_binding,jsonb_build_object('kind','finish','operationKey','done','summary','other','headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
		raise exception 'A differing replay was accepted'; exception when unique_violation then null; end;
	begin perform public.qorpera_authorize_coding_command(v_binding,jsonb_build_object('workerId',v_worker.id,'vmId',v_vm,
			'requestId',public.qorpera_coding_turn_id(v_worker.id,1),'turn',1),'read',extensions.gen_random_uuid(),null);
		raise exception 'A command without a receipt was authorized'; exception when insufficient_privilege then null; end;
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_turn(v_binding) #>> '{coding,submission,headSha}' = 'b4d8f9f1c0b6e5a2d3c4b5a69788776655443322',
		'The runner sees its own submission');
	v_turn := public.qorpera_describe_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_turn ->> 'phase' = 'running' and v_turn ->> 'jobStatus' = 'leased' and v_turn #>> '{submission,kind}' = 'finish'
		and v_turn ->> 'runId' = v_wake.run_id::text,'The executor sees the running job and the submission');
	perform pg_temp.finish_job(v_wake.run_id,'completed');
	update public.qorpera_wake_occurrences set status = 'completed', finished_at = clock_timestamp() where id = v_wake.id;
	v_turn := public.qorpera_describe_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_turn ->> 'jobStatus' = 'completed','The executor sees the turn end');
	begin perform public.qorpera_authorize_coding_turn(v_binding);
		raise exception 'A finished job still carries turn authority'; exception when insufficient_privilege then null; end;
end $$;

-- 3. The completion consumes the submission; a question carries its choices; the next turn starts clean.
do $$
declare v_claim jsonb := current_setting('qorpera_test.coding_claim')::jsonb; v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send');
	v_view jsonb; v_next jsonb; v_turn jsonb; v_event jsonb;
begin
	perform public.qorpera_record_coding_progress(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'publishing','Publishing the draft pull request');
	v_view := public.qorpera_complete_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'succeeded','Composer posts first; the send test covers it.',null,
		'{"url":"https://github.com/Qorpera/Qorpera_Base/pull/204","number":204,"headSha":"b4d8f9f1c0b6e5a2d3c4b5a69788776655443322"}',
		'[{"name":"web client","status":"passed"}]',null,'sess-1',3,null);
	perform pg_temp.wake_assert(v_view ->> 'phase' = 'completed' and (pg_temp.session_row('fix-send')).submission is null
		and (pg_temp.session_row('fix-send')).submission_receipt_id is null and (pg_temp.session_row('fix-send')).vm_allocation_id = '30000000-0000-4000-8000-000000000300',
		'Completion clears the submission and keeps the machine');
	-- The owner follows up; the second turn is a new claim on the same machine.
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Also fix the group chat composer.','30000000-0000-4000-8000-000000000201');
	perform pg_temp.path_claims('service_role');
	v_next := public.qorpera_claim_coding_session('exec-test',60);
	v_turn := public.qorpera_describe_coding_turn(v_worker.id,(v_next ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert((v_next ->> 'sequence')::int = 2 and v_turn ->> 'vmAllocationId' = '30000000-0000-4000-8000-000000000300'
		and (v_turn ->> 'turnId')::uuid = public.qorpera_coding_turn_id(v_worker.id,2) and v_turn -> 'submission' = 'null'::jsonb
		and v_turn ->> 'baseSha' = 'a4d8f9f1c0b6e5a2d3c4b5a69788776655443322','The next turn keeps the machine and the base and starts without a submission');
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_machine(v_worker.id,(v_next ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding'),repeat('c',64),'run') ->> 'allocationId'
		= '30000000-0000-4000-8000-000000000300','The same plan is admitted again for the next turn');
	begin perform public.qorpera_complete_coding_turn(v_worker.id,(v_next ->> 'leaseToken')::uuid,'blocked','Composer fixed.','Keep 250 ms?',null,null,null,null,null,'["a","b","c","d","e","f","g"]');
		raise exception 'Seven options accepted'; exception when sqlstate '22023' then null; end;
	begin perform public.qorpera_complete_coding_turn(v_worker.id,(v_next ->> 'leaseToken')::uuid,'succeeded','Done.',null,null,null,null,null,null,'["a"]');
		raise exception 'Options without a question accepted'; exception when sqlstate '22023' then null; end;
	v_view := public.qorpera_complete_coding_turn(v_worker.id,(v_next ->> 'leaseToken')::uuid,'blocked','Composer fixed; the poll interval is your call.',
		'Keep 250 ms, or raise to 500 ms?',null,null,null,'sess-1',3,'["Keep 250 ms","Raise to 500 ms"]');
	select event.body into v_event from public.qorpera_coding_session_events event where event.worker_id = v_worker.id and event.kind = 'needs_input' order by event.id desc limit 1;
	perform pg_temp.wake_assert(v_view ->> 'phase' = 'awaiting_input' and v_event -> 'options' = '["Keep 250 ms","Raise to 500 ms"]'::jsonb
		and (pg_temp.worker_row('fix-send')).result -> 'options' = '["Keep 250 ms","Raise to 500 ms"]'::jsonb,
		'A question carries its choices to the thread and to the parent');
end $$;

-- 4. Control plane only.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020','exec-test','{}')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_authorize_coding_cleanup((pg_temp.worker_row('fix-send')).id,'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_describe_coding_turn((pg_temp.worker_row('fix-send')).id,extensions.gen_random_uuid())$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_authorize_coding_turn(current_setting('qorpera_test.coding_turn_binding')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_submit_coding_turn(current_setting('qorpera_test.coding_turn_binding')::jsonb,'{}')$q$,'42501');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_assert_coding_storage(uuid,text,jsonb,text)','EXECUTE')
	and not has_table_privilege('service_role','public.qorpera_coding_vm_plans','INSERT,UPDATE,DELETE')
	and not has_table_privilege('service_role','public.qorpera_coding_storage_volumes','INSERT,UPDATE,DELETE'),
	'No storage or plan authority bypasses the executor RPCs');

rollback;
