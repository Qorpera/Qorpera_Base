-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Order 9, part 1: a coding session is a sponsored worker. The agent dispatches
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
-- A member's sessions run side by side on their coding machine: a second one in the same harness is not refused.
do $$
begin
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c3","todoKey":"composer-latency","workerKey":"fix-send-2",
		"title":"Second","goal":"g","definitionOfDone":"d","access":"read","species":"coding","harness":"codex",
		"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send-2')).phase = 'queued'
		and (pg_temp.worker_row('fix-send-2')).owner_user_id = (pg_temp.worker_row('fix-send')).owner_user_id,
		'The owner may start a second coding session in the same harness while the first runs');
	perform pg_temp.worker('{"action":"cancel","operationKey":"c3-cancel","todoKey":"composer-latency","workerKey":"fix-send-2"}');
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send-2')).phase = 'cancelled','The second session leaves the queue');
end $$;

create function pg_temp.fleet_node(p_node uuid, p_owner text, p_host text, p_provider text) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020',p_owner,true,array['codex']);
	perform public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020',p_owner,
		jsonb_build_object('providerId',p_provider,'providerPolicySha256',repeat('f',64),'project','coding','imageFingerprint',repeat('a',64),
		'bootstrapSha256',repeat('b',64),'storagePool','coding','network','coding','cpus',2,'memoryBytes',2147483648,'rootDiskBytes',4294967296));
	perform public.qorpera_configure_coding_nas_policy('30000000-0000-4000-8000-000000000020',p_owner,p_host,
		jsonb_build_object('schema','qorpera.coding-nas-policy/v1','mountPoint','/srv/coding','rootPath','/srv/coding/executor',
		'source','192.168.1.40:/coding','serverAddress','192.168.1.40'));
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId',p_node,'machineIdSha256',p_host,'label',p_provider,'cpuMillis',6000,'memoryBytes',8589934592,
		'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_provider(p_node,p_host,'coding',p_provider,repeat('f',64),2000,2147483648);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_host,'socketPath','/var/snap/lxd/common/lxd/unix.socket',
		'socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd','serverVersion','5.21','architecture','x86_64'),
		'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_host,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context(p_node) ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end $$;

select pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'An unconfigured executor keeps sessions queued');
select pg_temp.fleet_node('30000000-0000-4000-8000-000000000310','exec-test',repeat('c',64),'coding-fixture');

-- 2. The executor claims the session, prepares, admits the turn under the owner's sponsor, and the
--    finished run is not mistaken for the worker's report.
do $$
declare v_claim jsonb; v_worker public.qorpera_runtime_workers; v_session public.qorpera_coding_sessions; v_turn jsonb;
	v_wake public.qorpera_wake_occurrences; v_run public.qorpera_execution_runs; v_parent public.qorpera_wake_occurrences;
	v_identity uuid := (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid;
begin
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('someone-else',60) is null,'Another executor sees nothing');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_worker := pg_temp.worker_row('fix-send');
	v_session := pg_temp.session_row('fix-send');
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text and (v_claim ->> 'sequence')::int = 1 and v_claim ->> 'harness' = 'codex'
		and v_claim #>> '{sponsor,bindingId}' = v_worker.owner_sponsor_binding_id::text and v_claim #>> '{dispatch,goal}' like 'Post the message%'
		and v_session.phase = 'preparing' and v_session.lease_token::text = v_claim ->> 'leaseToken' and v_session.lease_owner = 'exec-test',
		'The claim carries the dispatch, the harness and the owner''s sponsor; the session is leased');
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'A leased session is not claimed twice');
	perform public.qorpera_heartbeat_coding_session(v_worker.id,v_session.lease_token,60);
	perform public.qorpera_record_coding_progress(v_worker.id,v_session.lease_token,null,'Cloning the repository',0,
		'[{"kind":"step","actor":"executor","body":{"text":"Cloning Qorpera_Base"}}]','sess-1','a4d8f9f1c0b6e5a2d3c4b5a69788776655443322');
	perform pg_temp.wake_assert(pg_temp.events('fix-send','step') = 1 and (pg_temp.session_row('fix-send')).base_sha like 'a4d8%'
		and (pg_temp.session_row('fix-send')).last_step = 'Cloning the repository','Progress and steps land on the session and its stream');
	v_turn := public.qorpera_begin_coding_turn(v_worker.id,v_session.lease_token,'{"vmId":"30000000-0000-4000-8000-000000000099"}');
	v_worker := pg_temp.worker_row('fix-send');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
	select * into strict v_parent from public.qorpera_wake_occurrences where run_id = v_worker.steering_run_id;
	perform pg_temp.wake_assert(v_wake.status = 'queued' and v_wake.source_kind = 'worker-dispatch' and v_wake.payload ->> 'species' = 'coding'
		and v_wake.payload #>> '{coding,harness}' = 'codex' and v_wake.payload #>> '{coding,vmId}' = '30000000-0000-4000-8000-000000000099'
		and v_wake.payload #>> '{coding,branch}' = 'qorpera/coding/' || v_worker.id::text
		and v_wake.sponsor_binding_id = v_worker.owner_sponsor_binding_id and v_wake.sponsor_version = v_worker.owner_sponsor_version
		and v_wake.causal_root_id = v_parent.causal_root_id and public.qorpera_wake_authorized(v_wake)
		and (pg_temp.session_row('fix-send')).phase = 'running',
		'The turn is admitted through the wake bus under the owner''s sponsor, with the coding scope in its payload');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_run from public.qorpera_execution_runs where id = (select run_id from public.qorpera_wake_occurrences where id = v_worker.occurrence_id);
	perform pg_temp.wake_assert(v_run.sponsor_binding_id = v_worker.owner_sponsor_binding_id and v_run.compute_identity_id = v_identity
		and v_run.staff_agent_id = v_worker.staff_agent_id,'The run carries the owner''s sponsor and compute identity');
	-- The model run ends. For an in-house child that would be a missing report; a coding session reports through its executor.
	perform pg_temp.finish_job(v_run.id,'completed');
	update public.qorpera_wake_occurrences set status = 'completed', finished_at = clock_timestamp() where id = v_worker.occurrence_id;
	perform public.qorpera_drain_worker_wakes(32);
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).state = 'active' and (pg_temp.session_row('fix-send')).phase = 'running',
		'A finished coding run does not fail the worker; the executor still owes its report');
end $$;
select pg_temp.wake_error($q$select public.qorpera_begin_coding_turn((pg_temp.worker_row('fix-send')).id,(pg_temp.session_row('fix-send')).lease_token)$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_heartbeat_coding_session((pg_temp.worker_row('fix-send')).id,extensions.gen_random_uuid(),60)$q$,'42501');

-- 3. The session asks the owner something: the worker blocks, the parent is woken with the question,
--    and only the owner answers, from the thread, recorded as an event.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_session public.qorpera_coding_sessions := pg_temp.session_row('fix-send');
	v_view jsonb; v_parent uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid; v_wake public.qorpera_wake_occurrences;
begin
	v_view := public.qorpera_complete_coding_turn(v_worker.id,v_session.lease_token,'blocked','Composer fixed; the poll interval is your call.',
		'Keep the orchestrator poll at 250 ms, or raise it to 500 ms?',null,null,null,'sess-1',3);
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'blocked' and v_worker.completion_state = 'waiting' and v_worker.result ->> 'needs' like 'Keep the%'
		and v_view ->> 'phase' = 'awaiting_input' and (v_view ->> 'filesChanged')::int = 3 and (pg_temp.session_row('fix-send')).lease_token is null
		and pg_temp.events('fix-send','needs_input') = 1,'A question blocks the worker and frees the lease; the session waits for input');
	perform pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','coding-final');
	perform pg_temp.finish_job(v_parent,'completed');
	perform public.qorpera_drain_worker_wakes(32);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'worker-completion' and parent_run_id = v_parent;
	perform pg_temp.wake_assert(v_wake.status in ('queued','materialized') and v_wake.payload #>> '{completions,0,outcome}' = 'blocked'
		and v_wake.payload #>> '{completions,0,needs}' like 'Keep the%','The parent is woken at once with the question');
	-- The manager continues from the revived run, as in production: later steering comes from that run's binding.
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.wake_assert(v_wake.status = 'materialized' and (pg_temp.worker_row('fix-send')).completion_state = 'delivered',
		'The question revives the parent once');
	perform set_config('qorpera_test.parent_binding',pg_temp.wake_start(v_wake.run_id)::text,true);
end $$;
select pg_temp.as_user('30000000-0000-4000-8000-000000000002');
select pg_temp.wake_error($q$select public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,'Keep 250 ms.','30000000-0000-4000-8000-000000000101')$q$,
	'42501','Only the owner of this coding session can talk to it; ask the agent to steer it');
select pg_temp.path_claims('anon');
select pg_temp.wake_error($q$select public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,'Keep 250 ms.','30000000-0000-4000-8000-000000000101')$q$,'42501');
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
do $$
declare v_view jsonb; v_replay jsonb; v_read jsonb; v_worker public.qorpera_runtime_workers;
begin
	v_view := public.qorpera_delegate_coding_session((pg_temp.worker_row('fix-send')).id,'30000000-0000-4000-8000-000000000100');
	perform pg_temp.wake_assert(pg_temp.events('fix-send','delegated') = 1,'Delegating to the agent is recorded for the thread');
	v_view := public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,'Keep 250 ms.','30000000-0000-4000-8000-000000000101');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'active' and v_worker.sequence = 2 and v_worker.occurrence_id is null and v_worker.dispatch ->> 'followUp' = 'Keep 250 ms.'
		and v_view ->> 'phase' = 'input_ready' and pg_temp.events('fix-send','input') = 1,'The owner''s answer continues the same session as a new turn');
	v_replay := public.qorpera_answer_coding_session(v_worker.id,'Keep 250 ms.','30000000-0000-4000-8000-000000000101');
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).sequence = 2 and pg_temp.events('fix-send','input') = 1,'A replayed answer is one answer');
	v_read := public.qorpera_read_coding_session(v_worker.id,0,100);
	perform pg_temp.wake_assert(v_read ->> 'isOwner' = 'true' and v_read #>> '{session,phase}' = 'input_ready'
		and jsonb_array_length(v_read -> 'events') >= 5 and v_read #>> '{events,0,kind}' = 'phase','The thread reads the session and its stream');
	v_read := public.qorpera_list_coding_sessions('30000000-0000-4000-8000-000000000040');
	-- Both sessions the agent dispatched here, the cancelled second one included.
	perform pg_temp.wake_assert(jsonb_array_length(v_read -> 'sessions') = 2 and exists (select 1 from jsonb_array_elements(v_read -> 'sessions') listed
		where listed.value ->> 'workerId' = v_worker.id::text and listed.value ->> 'isOwner' = 'true'
			and listed.value ->> 'sessionId' = '30000000-0000-4000-8000-000000000040'
			and listed.value ->> 'agentId' = '30000000-0000-4000-8000-000000000030'),
		'The conversation lists the coding sessions its agent dispatched from it');
end $$;
select pg_temp.wake_error($q$select public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,'Again','30000000-0000-4000-8000-000000000102')$q$,
	'55000','The session is still working; wait for its question or its result');
select pg_temp.wake_error($q$select public.qorpera_delegate_coding_session((pg_temp.worker_row('fix-send')).id,'30000000-0000-4000-8000-000000000103')$q$,'55000');
select pg_temp.as_user('30000000-0000-4000-8000-000000000002');
do $$
declare v_read jsonb := public.qorpera_read_coding_session((pg_temp.worker_row('fix-send')).id,0,100);
begin
	perform pg_temp.wake_assert(v_read ->> 'isOwner' = 'false' and v_read #>> '{session,harness}' = 'codex','Other members read the session and are told they are not the owner');
	v_read := public.qorpera_list_coding_sessions('30000000-0000-4000-8000-000000000040');
	perform pg_temp.wake_assert(jsonb_array_length(v_read -> 'sessions') = 2
		and not exists (select 1 from jsonb_array_elements(v_read -> 'sessions') listed where listed.value ->> 'isOwner' <> 'false'),
		'Other members see the sessions in the thread too');
end $$;
select pg_temp.path_claims('anon');
select pg_temp.wake_error($q$select public.qorpera_list_coding_sessions('30000000-0000-4000-8000-000000000040')$q$,'22023');
select pg_temp.path_claims('service_role');

-- 4. The next turn finishes with a draft PR; follow-ups continue the session after completion and after cancellation.
do $$
declare v_claim jsonb; v_worker public.qorpera_runtime_workers; v_session public.qorpera_coding_sessions; v_view jsonb; v_follow jsonb;
	v_parent uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
begin
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_worker := pg_temp.worker_row('fix-send');
	v_session := pg_temp.session_row('fix-send');
	perform pg_temp.wake_assert((v_claim ->> 'sequence')::int = 2 and v_claim ->> 'followUp' = 'Keep 250 ms.' and v_claim ->> 'harnessSessionRef' = 'sess-1'
		and v_session.phase = 'preparing','The next turn resumes the same harness session with the owner''s answer');
	v_view := public.qorpera_complete_coding_turn(v_worker.id,v_session.lease_token,'succeeded','Draft PR opened; the send test covers the change.',null,
		'{"url":"https://github.com/Qorpera/Qorpera_Base/pull/204","number":204,"headSha":"b4d8f9f1c0b6e5a2d3c4b5a69788776655443322"}',
		'[{"name":"web client","status":"passed"}]','[{"kind":"screenshot","objectId":"30000000-0000-4000-8000-000000000201"}]','sess-1',3);
	v_worker := pg_temp.worker_row('fix-send');
	v_session := pg_temp.session_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'succeeded' and v_session.phase = 'completed' and (v_session.pull_request ->> 'number')::int = 204
		and jsonb_array_length(v_session.checks) = 1 and jsonb_array_length(v_session.artifacts) = 1 and v_session.finished_at is not null
		and pg_temp.events('fix-send','published') = 1 and pg_temp.events('fix-send','finished') = 1
		and v_worker.result #>> '{pullRequest,number}' = '204','The PR, its checks and artifacts are session state, not prose');
	v_follow := pg_temp.worker('{"action":"followup","operationKey":"c4","todoKey":"composer-latency","workerKey":"fix-send","text":"Also fix the group chat composer."}');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.sequence = 3 and v_worker.state = 'active' and (pg_temp.session_row('fix-send')).phase = 'input_ready'
		and (pg_temp.session_row('fix-send')).pull_request ->> 'number' = '204' and v_follow #>> '{coding,phase}' = 'input_ready',
		'A follow-up after completion keeps the branch and the PR');
	perform pg_temp.worker('{"action":"cancel","operationKey":"c5","todoKey":"composer-latency","workerKey":"fix-send"}');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'cancelled' and (pg_temp.session_row('fix-send')).phase = 'cancelled'
		and (pg_temp.session_row('fix-send')).lease_token is null,'Cancellation settles the session and keeps its workspace');
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'A cancelled session is not claimed');
	v_follow := pg_temp.worker('{"action":"followup","operationKey":"c6","todoKey":"composer-latency","workerKey":"fix-send","text":"Resume: the composer change only."}');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.sequence = 4 and v_worker.state = 'active' and (pg_temp.session_row('fix-send')).phase = 'input_ready',
		'A coding session continues after cancellation; the same worker, branch and PR');
end $$;

-- 5. An executor that disappears mid-turn fails the session visibly and keeps the workspace; the parent hears about it.
do $$
declare v_claim jsonb := public.qorpera_claim_coding_session('exec-test',60); v_worker public.qorpera_runtime_workers;
begin
	perform pg_temp.wake_assert((v_claim ->> 'sequence')::int = 4 and (pg_temp.session_row('fix-send')).phase = 'preparing','The resumed turn is claimed');
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = (v_claim ->> 'workerId')::uuid;
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'An expired lease is not silently resumed');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'failed' and v_worker.result ->> 'reason' = 'executor-lease-expired' and v_worker.completion_state = 'waiting'
		and (pg_temp.session_row('fix-send')).phase = 'failed' and pg_temp.events('fix-send','failed') = 1
		and (pg_temp.session_row('fix-send')).pull_request ->> 'number' = '204','The failure is visible and the session keeps its state');
end $$;

-- 6. Control-plane only.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_claim_coding_session('exec-test',60)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','x',true,array['codex'])$q$,'42501');
select pg_temp.wake_error($q$select * from public.qorpera_coding_sessions$q$,'42501');
select pg_temp.wake_error($q$select * from public.qorpera_coding_session_events$q$,'42501');
reset role;
