-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Order 5: a parent dispatches a blank in-house worker and stays interruptible;
-- the worker reports once, durably, to its parent only; the kernel revives the
-- parent with a typed continuation; todos and accepted outputs are durable and
-- published to the Company File.
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
create function pg_temp.finish_job(p_run uuid,p_status text default 'completed') returns void language sql as $$
	update public.qorpera_runner_jobs set status = p_status,result = case when p_status = 'completed' then '{}'::jsonb end,
		last_error = case when p_status = 'failed' then 'Fixture failure' end,
		finished_at = case when p_status <> 'cancelled' then statement_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then statement_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '30000000-0000-4000-8000-000000000001'::uuid end,
		lease_token_sha256 = null,lease_expires_at = null where run_id = p_run
$$;
-- A governed write by a given run, through the same two calls the path gateway makes.
create function pg_temp.write_as(p_binding jsonb,p_key text,p_path text,p_text text) returns jsonb language plpgsql as $$
declare v_saved text := current_setting('qorpera_test.wake_binding'); v_result jsonb;
begin
	perform set_config('qorpera_test.wake_binding',p_binding::text,true);
	v_result := pg_temp.path_commit(pg_temp.path_plan(p_key,p_path,pg_temp.path_stage_file(p_path,p_text)));
	perform set_config('qorpera_test.wake_binding',v_saved,true);
	return v_result;
end $$;
create function pg_temp.mkdir_as(p_binding jsonb,p_key text,p_path text) returns jsonb language plpgsql as $$
declare v_saved text := current_setting('qorpera_test.wake_binding'); v_result jsonb;
begin
	perform set_config('qorpera_test.wake_binding',p_binding::text,true);
	v_result := pg_temp.path_commit(pg_temp.path_plan(p_key,p_path,jsonb_build_object('path',p_path,'kind','directory')));
	perform set_config('qorpera_test.wake_binding',v_saved,true);
	return v_result;
end $$;

-- A human wake owes its acknowledgement before any work, todos and workers included.
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list"}')$q$,'55000','Wake requires an acknowledgement before work');
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'progress','workers-ack');

-- 1. Durable todos, idempotent by operation key, published to the Company File.
do $$
declare v_first jsonb; v_replay jsonb; v_write jsonb; v_confirm jsonb; v_other jsonb;
	v_binding jsonb := current_setting('qorpera_test.parent_binding')::jsonb;
	v_request jsonb := '{"action":"upsert","operationKey":"todo-1","todoKey":"market-scan","title":"Market scan for Q4",
		"detail":"Compare the three competitors and recommend a price."}';
begin
	v_first := pg_temp.todo(v_request);
	perform pg_temp.wake_assert(v_first #>> '{todo,state}' = 'open' and (v_first #>> '{todo,revision}')::int = 1
		and v_first #>> '{todo,published}' = 'false'
		and v_first #>> '{publication,path}' = 'work/todos/30000000-0000-4000-8000-000000000030/market-scan.json'
		and (v_first #>> '{publication,text}')::jsonb ->> 'schema' = 'qorpera.agent-todo/v1','A todo is a durable object with a canonical document');
	v_replay := pg_temp.todo(v_request);
	perform pg_temp.wake_assert(v_replay = v_first and (select count(*) from public.qorpera_runtime_agent_todos) = 1,
		'Replaying one operation key returns the same receipt and creates nothing');
	perform pg_temp.mkdir_as(v_binding,'todo-dir-1','work');
	perform pg_temp.mkdir_as(v_binding,'todo-dir-2','work/todos');
	perform pg_temp.mkdir_as(v_binding,'todo-dir-3','work/todos/30000000-0000-4000-8000-000000000030');
	v_write := pg_temp.write_as(v_binding,'todo-publish-1',v_first #>> '{publication,path}',v_first #>> '{publication,text}');
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','The todo document is live Company File state, not a proposal');
	v_other := pg_temp.write_as(v_binding,'todo-other-1','work/todos/30000000-0000-4000-8000-000000000030/elsewhere.md','x');
	perform pg_temp.wake_error(format($q$select public.qorpera_confirm_agent_todo_publication(%L::jsonb,
		'{"todoKey":"market-scan","revision":1,"snapshotId":"%s"}')$q$,v_binding,v_other ->> 'snapshotId'),'42501');
	v_confirm := public.qorpera_confirm_agent_todo_publication(v_binding,
		jsonb_build_object('todoKey','market-scan','revision',1,'snapshotId',v_write ->> 'snapshotId'));
	perform pg_temp.wake_assert(v_confirm ->> 'published' = 'true' and (select published_version is not null
		from public.qorpera_runtime_agent_todos where todo_key = 'market-scan'),'Publication is confirmed against the revision this run wrote');
	perform pg_temp.wake_assert(jsonb_array_length(pg_temp.todo('{"action":"list"}') -> 'todos') = 1
		and jsonb_array_length(pg_temp.todo('{"action":"list"}') -> 'unpublished') = 0,'List shows open todos and nothing left to publish');
end $$;
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"upsert","operationKey":"x1","todoKey":"Bad Key","title":"t"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"upsert","operationKey":"x2","todoKey":"k","title":"t","staffAgentId":"30000000-0000-4000-8000-000000000031"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"done","operationKey":"x3","todoKey":"absent"}')$q$,'P0002');
-- Runtime v95: an agent keeps any number of open todos (was 64). Probed in a subtransaction.
do $$
declare v_index integer;
begin
	begin
		for v_index in 1..65 loop
			perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','many-' || v_index,'todoKey','many-' || v_index,
				'title','Todo ' || v_index));
		end loop;
		perform pg_temp.wake_assert((select count(*) >= 66 from public.qorpera_runtime_agent_todos where state in ('open','blocked')
			and staff_agent_id = '30000000-0000-4000-8000-000000000030'),'An agent keeps sixty-six open todos');
		perform pg_temp.wake_assert(jsonb_array_length(pg_temp.todo('{"action":"list"}') -> 'todos') = 32
			and (pg_temp.todo('{"action":"list"}') ->> 'moreTodos')::int >= 34,'The todo list is a page of thirty-two and counts the rest');
		raise exception 'rollback-todo-count-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-todo-count-probe' then raise; end if;
	end;
end $$;

-- 2. The agent's own todo area needs no member write grant; nothing else opens up.
savepoint own_area;
alter table public.qorpera_company_path_grants disable trigger user;
update public.qorpera_company_path_grants set permissions = array['read']
where principal_kind = 'staff_agent' and principal_id = '30000000-0000-4000-8000-000000000030';
alter table public.qorpera_company_path_grants enable trigger user;
do $$
declare v_actor jsonb := public.qorpera_company_path_actor('30000000-0000-4000-8000-000000000020',current_setting('qorpera_test.parent_binding')::jsonb);
begin
	perform pg_temp.wake_assert(public.qorpera_company_path_allowed(v_actor,'work/todos/30000000-0000-4000-8000-000000000030/market-scan.json','write')
		and public.qorpera_company_path_allowed(v_actor,'work/todos/30000000-0000-4000-8000-000000000030/market-scan/w1/result.md','write')
		and public.qorpera_company_path_allowed(v_actor,'work/todos','write'),'An agent with a read grant writes its own todo area');
	perform pg_temp.wake_assert(not public.qorpera_company_path_allowed(v_actor,'work/todos/30000000-0000-4000-8000-000000000031/x.json','write')
		and not public.qorpera_company_path_allowed(v_actor,'notes.md','write')
		and not public.qorpera_company_path_allowed(v_actor,'work/other.md','write'),'A coworker''s todo area and everything else stay closed');
end $$;
rollback to own_area;

-- 3. A complete dispatch admits a blank child through the wake bus.
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"d0","todoKey":"market-scan","workerKey":"prices",
	"title":"Collect prices","goal":"Collect list prices.","access":"write"}')$q$,'22023','Worker dispatch is incomplete or exceeds its bounds');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"d0","todoKey":"absent","workerKey":"prices",
	"title":"Collect prices","goal":"g","definitionOfDone":"d","access":"read"}')$q$,'P0002');
do $$
declare v_first jsonb; v_replay jsonb; v_worker public.qorpera_runtime_workers; v_wake public.qorpera_wake_occurrences;
	v_parent public.qorpera_wake_occurrences; v_run uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
	v_request jsonb := '{"action":"dispatch","operationKey":"d1","todoKey":"market-scan","workerKey":"prices","title":"Collect prices",
		"goal":"Collect the public list prices of the three competitors.","definitionOfDone":"A table with one verified price per competitor.",
		"context":"Competitors: Alfa, Beta, Gamma.","sources":["work/todos"],"access":"write","revival":"each"}';
begin
	v_first := pg_temp.worker(v_request);
	v_worker := pg_temp.worker_row('prices');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
	select * into strict v_parent from public.qorpera_wake_occurrences where run_id = v_run;
	perform pg_temp.wake_assert(v_first #>> '{worker,state}' = 'queued' and v_worker.state = 'active' and v_worker.steering_run_id = v_run
		and (v_first #>> '{publication,revision}')::int = 2,'Dispatch returns at admission, with the todo document to publish');
	perform pg_temp.wake_assert(v_wake.wake_kind = 'agent' and v_wake.source_kind = 'worker-dispatch' and v_wake.status = 'queued'
		and v_wake.parent_run_id = v_run and v_wake.session_id is null and v_wake.staff_agent_id = v_worker.staff_agent_id
		and v_wake.causal_root_id = v_parent.causal_root_id and v_wake.causal_agent_ids = v_parent.causal_agent_ids,
		'The child enters through the wake bus: same agent, no conversation, its parent''s causal chain');
	perform pg_temp.wake_assert(v_wake.payload #>> '{dispatch,goal}' like 'Collect the public%' and v_wake.payload #>> '{dispatch,definitionOfDone}' is not null
		and v_wake.payload #>> '{dispatch,authority}' is not null and v_wake.payload #>> '{dispatch,output}' is not null
		and v_wake.payload #>> '{dispatch,cancellation}' is not null and v_wake.payload #>> '{dispatch,completion}' is not null
		and v_wake.payload ->> 'parentRunId' = v_run::text and v_wake.payload #>> '{todo,todoKey}' = 'market-scan'
		and v_wake.payload ->> 'outputFolder' = 'work/todos/30000000-0000-4000-8000-000000000030/market-scan/prices',
		'The dispatch is complete: goal, done, context, authority, destination, parent and todo, cancellation, completion');
	v_replay := pg_temp.worker(v_request);
	perform pg_temp.wake_assert(v_replay = v_first and (select count(*) from public.qorpera_runtime_workers) = 1
		and (select count(*) from public.qorpera_wake_occurrences where source_kind = 'worker-dispatch') = 1,'A replayed dispatch clones nothing');
end $$;
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"d2","todoKey":"market-scan","workerKey":"prices",
	"title":"Again","goal":"g","definitionOfDone":"d","access":"read"}')$q$,'55000',
	'This worker already exists; steer it with a follow-up instead of a second dispatch');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"done","operationKey":"x4","todoKey":"market-scan"}')$q$,'55000');

-- 4. The child runs blank, silent and without delegation.
do $$
declare v_runs jsonb; v_child jsonb; v_wake jsonb; v_run public.qorpera_execution_runs; v_context jsonb;
begin
	v_runs := public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_run from public.qorpera_execution_runs run
	where run.id = (select run_id from public.qorpera_wake_occurrences where id = (pg_temp.worker_row('prices')).occurrence_id);
	perform pg_temp.wake_assert(v_run.session_id is null and v_run.source_kind = 'wake' and v_run.audience_kind = 'company',
		'The child run has no conversation');
	v_child := pg_temp.wake_start(v_run.id);
	perform set_config('qorpera_test.child_binding',v_child::text,true);
	v_wake := public.qorpera_read_native_wake(v_child);
	perform pg_temp.wake_assert(v_wake ->> 'kind' = 'agent' and v_wake #>> '{source,kind}' = 'worker-dispatch'
		and v_wake #>> '{policy,final}' = 'forbidden' and (v_wake #>> '{policy,maxPublicSends}')::int = 0
		and v_wake -> 'actorStaffId' = 'null'::jsonb and v_wake -> 'actorUserId' = 'null'::jsonb
		and v_wake #>> '{payload,schema}' = 'qorpera.worker-dispatch/v1' and v_wake #>> '{audience,sessionId}' is null,
		'The worker wake is a typed internal activation with no public mouth and no human or coworker sender');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_company_run_read_paths where run_id = v_run.id),
		'A worker starts blank: it inherits nothing its parent read');
	v_context := public.qorpera_describe_company_run_context(v_child);
	perform pg_temp.wake_assert(v_context -> 'history' = '[]'::jsonb and v_context -> 'currentInputs' = '[]'::jsonb
		and v_context -> 'continuation' = 'null'::jsonb,'No parent conversation reaches the child');
	perform pg_temp.wake_assert((pg_temp.worker('{"action":"status"}') #>> '{workers,0,state}') = 'running','The parent sees the worker running');
end $$;
select pg_temp.wake_error($q$select pg_temp.wake_public_send(current_setting('qorpera_test.child_binding')::jsonb,'final','child-speaks')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"dispatch","operationKey":"sub1","todoKey":"market-scan","workerKey":"sub",
	"title":"Sub","goal":"g","definitionOfDone":"d","access":"read"}',current_setting('qorpera_test.child_binding')::jsonb)$q$,'42501','Worker authority is unavailable');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list"}',current_setting('qorpera_test.child_binding')::jsonb)$q$,'42501','Todo authority is unavailable');
select pg_temp.wake_error($q$select public.qorpera_report_worker_result(current_setting('qorpera_test.parent_binding')::jsonb,
	'{"operationKey":"r0","outcome":"succeeded","summary":"I am not a worker"}')$q$,'42501','Only a worker reports to a parent');

-- 4b. A worker's access is kernel authority: a write worker writes its own output folder and the
-- todo document, never a sibling's folder or another todo; a read worker writes only the document.
-- With only a read grant, so that a member's write grant does not mask the rule.
savepoint worker_access;
alter table public.qorpera_company_path_grants disable trigger user;
update public.qorpera_company_path_grants set permissions = array['read']
where principal_kind = 'staff_agent' and principal_id = '30000000-0000-4000-8000-000000000030';
alter table public.qorpera_company_path_grants enable trigger user;
do $$
declare v_child jsonb := current_setting('qorpera_test.child_binding')::jsonb; v_actor jsonb;
	v_area text := 'work/todos/30000000-0000-4000-8000-000000000030'; v_worker public.qorpera_runtime_workers;
begin
	v_actor := public.qorpera_company_path_actor('30000000-0000-4000-8000-000000000020',v_child);
	v_worker := pg_temp.worker_row('prices');
	perform pg_temp.wake_assert(public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan.json','write')
		and public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan','write')
		and public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan/prices','write')
		and public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan/prices/result.md','write')
		and public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan.json','read'),
		'A write worker writes its todo document, the todo folder and its own output folder');
	perform pg_temp.wake_assert(not public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan/other/result.md','write')
		and not public.qorpera_company_path_allowed(v_actor,v_area || '/other-todo.json','write')
		and not public.qorpera_company_path_allowed(v_actor,v_area || '/other-todo/prices/x.md','write')
		and not public.qorpera_company_path_allowed(v_actor,'notes.md','write'),
		'A write worker cannot write a sibling''s folder, another todo, or elsewhere without a grant');
	update public.qorpera_runtime_workers set access = 'read' where id = v_worker.id;
	perform pg_temp.wake_assert(public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan.json','write')
		and not public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan/prices/result.md','write')
		and not public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan','write')
		and public.qorpera_company_path_allowed(v_actor,v_area || '/market-scan/prices/result.md','read'),
		'A read worker writes nothing but the todo document its report publishes');
	update public.qorpera_runtime_workers set access = 'write' where id = v_worker.id;
end $$;
rollback to worker_access;

-- 5. The parent is never held hostage: its run ends, and a new human message
-- starts a new run in the same conversation while the child is still working.
do $$
declare v_parent uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid; v_turn jsonb; v_runs jsonb;
begin
	perform pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','workers-final');
	perform pg_temp.finish_job(v_parent);
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_turn := public.qorpera_request_session_turn_v2('30000000-0000-4000-8000-000000000040',extensions.gen_random_uuid(),extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"While that runs: what is our current price?","images":[]}','member_connection',
		(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,
		(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}');
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_session_turn_requests(32);
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = (v_turn ->> 'turn_request_id')::uuid and job.status = 'queued')
		and exists(select 1 from public.qorpera_runner_jobs job where job.run_id =
			(select run_id from public.qorpera_wake_occurrences where id = (pg_temp.worker_row('prices')).occurrence_id) and job.status = 'leased'),
		'A new human turn is admitted while the worker is still running');
	perform pg_temp.finish_job((v_turn ->> 'turn_request_id')::uuid,'cancelled');
end $$;

-- 6. One durable report, to the parent only; outputs are files this worker wrote.
do $$
declare v_child jsonb := current_setting('qorpera_test.child_binding')::jsonb; v_write jsonb; v_report jsonb; v_replay jsonb;
	v_worker public.qorpera_runtime_workers; v_path text := 'work/todos/30000000-0000-4000-8000-000000000030/market-scan/prices/result.md';
	v_request jsonb;
begin
	perform pg_temp.mkdir_as(v_child,'out-dir-1','work/todos/30000000-0000-4000-8000-000000000030/market-scan');
	perform pg_temp.mkdir_as(v_child,'out-dir-2','work/todos/30000000-0000-4000-8000-000000000030/market-scan/prices');
	v_write := pg_temp.write_as(v_child,'out-1',v_path,'| Alfa | 49 |');
	perform pg_temp.wake_error(format($q$select public.qorpera_report_worker_result(%L::jsonb,
		'{"operationKey":"r-bad","outcome":"succeeded","summary":"Done.","outputs":["work/todos/30000000-0000-4000-8000-000000000030/market-scan.json"]}')$q$,v_child),'22023');
	perform pg_temp.wake_error(format($q$select public.qorpera_report_worker_result(%L::jsonb,
		'{"operationKey":"r-bad2","outcome":"blocked","summary":"Stuck."}')$q$,v_child),'22023','Worker report is invalid');
	v_request := jsonb_build_object('operationKey','r1','outcome','succeeded','summary','Alfa 49, Beta 59, Gamma 45. All verified on their pricing pages.',
		'outputs',jsonb_build_array(v_path));
	v_report := public.qorpera_report_worker_result(v_child,v_request);
	v_worker := pg_temp.worker_row('prices');
	perform pg_temp.wake_assert(v_worker.state = 'succeeded' and v_worker.completion_state = 'waiting'
		and v_worker.result #>> '{outputs,0,snapshotId}' = v_write ->> 'snapshotId'
		and ((v_report #>> '{publication,text}')::jsonb #>> '{workers,0,outcome}') = 'succeeded',
		'The report is durable, its output is bound to the revision the worker wrote, and the todo document carries it');
	v_replay := public.qorpera_report_worker_result(v_child,v_request);
	perform pg_temp.wake_assert(v_replay = v_report,'A replayed report is the same receipt');
	perform pg_temp.wake_error(format($q$select public.qorpera_report_worker_result(%L::jsonb,
		'{"operationKey":"r2","outcome":"failed","summary":"Changed my mind."}')$q$,v_child),'55000','Worker was cancelled or has already reported');
	perform pg_temp.finish_job((v_child ->> 'runId')::uuid);
end $$;

-- 7. Durable completion reaches the parent as a typed continuation in its conversation.
do $$
declare v_parent uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid; v_wake public.qorpera_wake_occurrences;
	v_binding jsonb; v_envelope jsonb; v_context jsonb; v_continuation jsonb; v_decision jsonb;
begin
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'worker-completion';
	perform pg_temp.wake_assert(v_wake.wake_kind = 'agent' and v_wake.parent_run_id = v_parent and v_wake.status = 'materialized'
		and v_wake.session_id = '30000000-0000-4000-8000-000000000040' and v_wake.payload #>> '{completions,0,outcome}' = 'succeeded'
		and v_wake.payload #>> '{completions,0,workerKey}' = 'prices' and (v_wake.payload ->> 'stillActive')::int = 0
		and (pg_temp.worker_row('prices')).completion_state = 'delivered','The kernel, not polling, revives the parent with the result');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from public.qorpera_wake_occurrences where source_kind = 'worker-completion') = 1,
		'A completion is delivered exactly once');
	v_binding := pg_temp.wake_start(v_wake.run_id);
	perform set_config('qorpera_test.revived_binding',v_binding::text,true);
	v_envelope := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.wake_assert(v_envelope #>> '{source,kind}' = 'worker-completion' and v_envelope ->> 'parentRunId' = v_parent::text
		and v_envelope -> 'actorUserId' = 'null'::jsonb and v_envelope -> 'actorStaffId' = 'null'::jsonb
		and v_envelope #>> '{policy,initial}' = 'optional' and v_envelope #>> '{policy,final}' = 'optional'
		and v_envelope -> 'policy' -> 'maxPublicSends' = 'null'::jsonb and v_envelope #>> '{audience,sessionId}' = '30000000-0000-4000-8000-000000000040',
		'The revival is an internal continuation, never a human message, and may speak in the parent''s conversation (no send limit) or stay silent');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	v_continuation := public.qorpera_run_continuation((select run from public.qorpera_execution_runs run where run.id = v_wake.run_id));
	perform pg_temp.wake_assert(v_context -> 'continuation' <> 'null'::jsonb
		and v_continuation ->> 'schema' = 'qorpera.worker-completion-continuation/v1'
		and v_continuation #>> '{completions,0,summary}' like 'Alfa 49%' and v_continuation #>> '{todos,0,todoKey}' = 'market-scan'
		and jsonb_array_length(v_continuation -> 'priorSends') = 2 and jsonb_array_length(v_continuation -> 'parentInputs') = 1,
		'The continuation carries the result, the todo and the parent''s own history');
	-- Runtime v92: a parent that did a lot of work still hears back. Past the old 32 MiB the continuation
	-- failed on every attempt; now it carries the newest results that fit and counts the rest.
	-- Probed in a subtransaction.
	begin
		insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,logical_operation_key,operation_kind,
			input_sha256,downstream_idempotency_sha256,status,result,completed_at)
		select extensions.gen_random_uuid(),v_parent,run.job_id,
			(select assignment_id from public.qorpera_run_operation_receipts where run_id = v_parent limit 1),
			'bulk-' || n,'cloud_tool',repeat('a',64),repeat('b',64),'completed',
			jsonb_build_object('content',(select string_agg(md5(n::text || ':' || g::text || random()::text),'') from generate_series(1,1400) g)),
			clock_timestamp()
		from public.qorpera_execution_runs run, generate_series(1,800) n where run.id = v_parent;
		v_continuation := public.qorpera_run_continuation((select run from public.qorpera_execution_runs run where run.id = v_wake.run_id));
		perform pg_temp.wake_assert(octet_length(v_continuation::text) <= 33554432 and (v_continuation ->> 'receiptsOmitted')::int > 600
			and v_continuation #>> '{receipts,-1,logicalOperationKey}' = 'bulk-800' and jsonb_array_length(v_continuation -> 'priorSends') = 2,
			'A parent with over 32 MiB of results is carried by its newest results, with the rest counted');
		raise exception 'rollback-large-continuation-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-large-continuation-probe' then raise; end if;
	end;
	v_decision := pg_temp.worker('{"action":"decide","operationKey":"a1","todoKey":"market-scan","workerKey":"prices","decision":"accept","note":"Verified."}',v_binding);
	perform pg_temp.wake_assert(v_decision #>> '{worker,decision,decision}' = 'accepted'
		and ((v_decision #>> '{publication,text}')::jsonb #>> '{workers,0,decision,decision}') = 'accepted'
		and ((v_decision #>> '{publication,text}')::jsonb #>> '{workers,0,outputs,0,path}') like '%/prices/result.md',
		'An accepted output is named in the todo document that becomes Company File state');
	perform pg_temp.wake_public_send(v_binding,'progress','revived-note');
end $$;

-- 8. One worker per coherent stream: a follow-up continues the same worker with its own history.
do $$
declare v_binding jsonb := current_setting('qorpera_test.revived_binding')::jsonb; v_follow jsonb; v_worker public.qorpera_runtime_workers;
	v_child jsonb; v_continuation jsonb; v_wake jsonb; v_index integer;
begin
	-- Runtime v92: no turn count and no hourly dispatch count. A worker past the old in-house
	-- limit (12 turns) takes another turn, and an agent dispatches more than the old 24 an hour and
	-- more than the old eight workers for one todo. Probed in a subtransaction, so the fixture keeps
	-- its real state.
	begin
		update public.qorpera_runtime_workers set sequence = 12 where worker_key = 'prices';
		v_follow := pg_temp.worker('{"action":"followup","operationKey":"f13","todoKey":"market-scan","workerKey":"prices","text":"Turn thirteen."}',v_binding);
		perform pg_temp.wake_assert((pg_temp.worker_row('prices')).sequence = 13 and (pg_temp.worker_row('prices')).state = 'active',
			'A worker takes a thirteenth turn');
		perform pg_temp.worker('{"action":"cancel","operationKey":"f13-cancel","todoKey":"market-scan","workerKey":"prices"}',v_binding);
		for v_index in 1..26 loop
			perform pg_temp.worker(jsonb_build_object('action','dispatch','operationKey','many-' || v_index,'todoKey','market-scan',
				'workerKey','many-' || v_index,'title','Many ' || v_index,'goal','Part ' || v_index,'definitionOfDone','A line.','access','read'),v_binding);
			-- Cancelled at once only to keep this probe small; nothing limits how many run.
			perform pg_temp.worker(jsonb_build_object('action','cancel','operationKey','many-cancel-' || v_index,'todoKey','market-scan',
				'workerKey','many-' || v_index),v_binding);
		end loop;
		perform pg_temp.wake_assert((select count(*) from public.qorpera_runtime_workers worker join public.qorpera_runtime_agent_todos todo
			on todo.id = worker.todo_id where todo.todo_key = 'market-scan') = 27,'Twenty-six dispatches in an hour for one todo are admitted');
		raise exception 'rollback-worker-count-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-worker-count-probe' then raise; end if;
	end;
	v_follow := pg_temp.worker('{"action":"followup","operationKey":"f1","todoKey":"market-scan","workerKey":"prices","text":"Add Delta to the table."}',v_binding);
	v_worker := pg_temp.worker_row('prices');
	perform pg_temp.wake_assert(v_worker.sequence = 2 and v_worker.state = 'active' and v_worker.steering_run_id = (v_binding ->> 'runId')::uuid
		and (select count(*) from public.qorpera_runtime_workers) = 1,'The follow-up addresses the same worker; nothing is cloned');
	perform pg_temp.wake_error(format($q$select pg_temp.worker('{"action":"followup","operationKey":"f2","todoKey":"market-scan","workerKey":"prices","text":"And Epsilon."}',%L::jsonb)$q$,v_binding),
		'55000','This worker is still working; wait for its report or cancel it');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_child := pg_temp.wake_start((select run_id from public.qorpera_wake_occurrences where id = v_worker.occurrence_id));
	v_wake := public.qorpera_read_native_wake(v_child);
	v_continuation := public.qorpera_run_continuation((select run from public.qorpera_execution_runs run where run.id = (v_child ->> 'runId')::uuid));
	perform pg_temp.wake_assert(v_wake #>> '{payload,dispatch,followUp}' = 'Add Delta to the table.' and (v_wake #>> '{payload,sequence}')::int = 2
		and v_continuation ->> 'schema' = 'qorpera.worker-stream/v1'
		and (select count(*) from jsonb_array_elements(v_continuation -> 'history') item where item ->> 'kind' = 'reported') = 1,
		'The continued worker reads its own earlier stream, not the parent''s conversation');
	-- Cancellation fences a running child: it can no longer work or report.
	perform pg_temp.worker('{"action":"cancel","operationKey":"c1","todoKey":"market-scan","workerKey":"prices"}',v_binding);
	perform pg_temp.wake_assert((pg_temp.worker_row('prices')).state = 'cancelled' and (pg_temp.worker_row('prices')).completion_state = 'suppressed',
		'A cancelled worker is terminal and wakes nobody');
	perform pg_temp.wake_error(format($q$select public.qorpera_report_worker_result(%L::jsonb,'{"operationKey":"r3","outcome":"succeeded","summary":"Late."}')$q$,v_child),
		'55000','Worker was cancelled');
	perform pg_temp.wake_error(format($q$select public.qorpera_manage_agent_routine(%L::jsonb,'{"action":"list"}')$q$,v_child),'55000','Worker was cancelled');
	perform pg_temp.finish_job((v_child ->> 'runId')::uuid,'failed');
end $$;

-- 9. Batch revival, a child that ends without reporting, limits, and todo cancellation.
do $$
declare v_binding jsonb := current_setting('qorpera_test.revived_binding')::jsonb; v_index integer; v_child jsonb; v_wake public.qorpera_wake_occurrences;
	v_done jsonb; v_other jsonb; v_reporter text; v_silent text;
begin
	-- Runtime v95: any number of workers run at once (was four).
	for v_index in 1..6 loop
		perform pg_temp.worker(jsonb_build_object('action','dispatch','operationKey','b' || v_index,'todoKey','market-scan','workerKey','batch-' || v_index,
			'title','Batch ' || v_index,'goal','Research part ' || v_index,'definitionOfDone','A paragraph.','access','read'),v_binding);
	end loop;
	perform pg_temp.wake_assert((select count(*) = 6 from public.qorpera_runtime_workers where worker_key like 'batch-%' and state = 'active'),
		'Six workers are active at once');
	-- A batch of six is handed back in full, one revival at a time: four, and the other two only after the
	-- first revival's run has ended. Probed in a subtransaction.
	begin
		perform pg_temp.finish_job((v_binding ->> 'runId')::uuid);
		update public.qorpera_runtime_workers set state = 'succeeded', reported_at = clock_timestamp(), completion_state = 'waiting',
			result = jsonb_build_object('outcome','succeeded','outputs','[]'::jsonb,'sequence',sequence,'summary','Part ' || worker_key || '.')
		where worker_key like 'batch-%';
		perform public.qorpera_drain_worker_wakes(32);
		perform public.qorpera_drain_worker_wakes(32);
		select * into strict v_wake from public.qorpera_wake_occurrences
		where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid;
		perform pg_temp.wake_assert(jsonb_array_length(v_wake.payload -> 'completions') = 4 and (v_wake.payload ->> 'stillActive')::int = 2,
			'The first revival carries four and knows two more are coming; the next waits for it');
		perform public.qorpera_materialize_wake_execution_runs(8);
		perform pg_temp.finish_job((select run_id from public.qorpera_wake_occurrences where id = v_wake.id));
		perform public.qorpera_drain_worker_wakes(32);
		perform pg_temp.wake_assert((select array_agg(jsonb_array_length(payload -> 'completions') || ':' || (payload ->> 'stillActive')
				order by jsonb_array_length(payload -> 'completions') desc)
			from public.qorpera_wake_occurrences where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid) = array['4:2','2:0']
			and (select count(*) = 6 from public.qorpera_runtime_workers where worker_key like 'batch-%' and completion_state = 'delivered'),
			'After the first revival ends, the other two reach the parent');
		raise exception 'rollback-batch-six-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-batch-six-probe' then raise; end if;
	end;
	-- A person who stops the first revival holds back the other two reports (still readable through status).
	begin
		perform pg_temp.finish_job((v_binding ->> 'runId')::uuid);
		update public.qorpera_runtime_workers set state = 'succeeded', reported_at = clock_timestamp(), completion_state = 'waiting',
			result = jsonb_build_object('outcome','succeeded','outputs','[]'::jsonb,'sequence',sequence,'summary','Part ' || worker_key || '.')
		where worker_key like 'batch-%';
		perform public.qorpera_drain_worker_wakes(32);
		select * into strict v_wake from public.qorpera_wake_occurrences
		where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid;
		perform public.qorpera_materialize_wake_execution_runs(8);
		perform pg_temp.finish_job((select run_id from public.qorpera_wake_occurrences where id = v_wake.id),'cancelled');
		perform public.qorpera_drain_worker_wakes(32);
		perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences
				where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid)
			and (select count(*) = 2 from public.qorpera_runtime_workers where worker_key like 'batch-%' and completion_state = 'suppressed'),
			'Stopping a revival holds back the rest of its parent''s reports');
		raise exception 'rollback-stopped-revival-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-stopped-revival-probe' then raise; end if;
	end;
	-- A blocked worker revives the parent while five still run; stopping that revival stops the five too.
	begin
		perform pg_temp.finish_job((v_binding ->> 'runId')::uuid);
		update public.qorpera_runtime_workers set state = 'blocked', reported_at = clock_timestamp(), completion_state = 'waiting',
			result = jsonb_build_object('outcome','blocked','outputs','[]'::jsonb,'sequence',sequence,'summary','Need the price list.',
				'needs','The price list.')
		where worker_key = 'batch-1';
		perform public.qorpera_drain_worker_wakes(32);
		select * into strict v_wake from public.qorpera_wake_occurrences
		where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid;
		perform public.qorpera_materialize_wake_execution_runs(8);
		perform pg_temp.finish_job((select run_id from public.qorpera_wake_occurrences where id = v_wake.id),'cancelled');
		perform public.qorpera_drain_worker_wakes(32);
		perform pg_temp.wake_assert((select count(*) = 5 from public.qorpera_runtime_workers
				where worker_key in ('batch-2','batch-3','batch-4','batch-5','batch-6') and state = 'cancelled'),
			'Stopping a revival stops the parent''s workers that are still running');
		raise exception 'rollback-stopped-revival-workers-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-stopped-revival-workers-probe' then raise; end if;
	end;
	-- The status listing is a page of sixteen, active workers first, and counts the rest. Probed in a subtransaction.
	begin
		for v_index in 7..18 loop
			perform pg_temp.worker(jsonb_build_object('action','dispatch','operationKey','b' || v_index,'todoKey','market-scan','workerKey','batch-' || v_index,
				'title','Batch ' || v_index,'goal','Research part ' || v_index,'definitionOfDone','A paragraph.','access','read'),v_binding);
		end loop;
		-- The most recently changed worker is a cancelled one; the page still shows active workers first.
		perform pg_temp.worker('{"action":"cancel","operationKey":"c18","todoKey":"market-scan","workerKey":"batch-18"}',v_binding);
		v_done := pg_temp.worker('{"action":"status"}',v_binding);
		perform pg_temp.wake_assert(jsonb_array_length(v_done -> 'workers') = 16 and (v_done ->> 'moreWorkers')::int >= 2
			and not exists (select 1 from jsonb_array_elements(v_done -> 'workers') listed
				join public.qorpera_runtime_agent_todos todo on todo.todo_key = listed ->> 'todoKey'
				join public.qorpera_runtime_workers worker on worker.todo_id = todo.id and worker.worker_key = listed ->> 'workerKey'
				where worker.state <> 'active'),
			'Seventeen active workers and a newer cancelled one: sixteen listed, all active, and the rest counted');
		raise exception 'rollback-status-page-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-status-page-probe' then raise; end if;
	end;
	perform pg_temp.worker('{"action":"cancel","operationKey":"c3","todoKey":"market-scan","workerKey":"batch-3"}',v_binding);
	perform pg_temp.worker('{"action":"cancel","operationKey":"c4","todoKey":"market-scan","workerKey":"batch-4"}',v_binding);
	perform pg_temp.worker('{"action":"cancel","operationKey":"c5","todoKey":"market-scan","workerKey":"batch-5"}',v_binding);
	perform pg_temp.worker('{"action":"cancel","operationKey":"c6","todoKey":"market-scan","workerKey":"batch-6"}',v_binding);
	perform pg_temp.finish_job((v_binding ->> 'runId')::uuid);
	perform public.qorpera_materialize_wake_execution_runs(8);
	-- The queue, not the test, chooses which child starts first.
	v_child := pg_temp.wake_start(null); v_other := pg_temp.wake_start(null);
	select worker.worker_key into strict v_reporter from public.qorpera_runtime_workers worker
	join public.qorpera_wake_occurrences wake on wake.id = worker.occurrence_id where wake.run_id = (v_child ->> 'runId')::uuid;
	select worker.worker_key into strict v_silent from public.qorpera_runtime_workers worker
	join public.qorpera_wake_occurrences wake on wake.id = worker.occurrence_id where wake.run_id = (v_other ->> 'runId')::uuid;
	perform public.qorpera_report_worker_result(v_child,'{"operationKey":"rb1","outcome":"succeeded","summary":"Part one."}');
	perform pg_temp.finish_job((v_child ->> 'runId')::uuid);
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((pg_temp.worker_row(v_reporter)).completion_state = 'waiting','A batch waits for the workers dispatched together');
	perform pg_temp.finish_job((v_other ->> 'runId')::uuid,'failed');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((pg_temp.worker_row(v_silent)).state = 'failed' and (pg_temp.worker_row(v_silent)).result ->> 'reason' = 'ended_without_report',
		'A child that ends without reporting still completes durably, as a failure');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind = 'worker-completion' and parent_run_id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.wake_assert(jsonb_array_length(v_wake.payload -> 'completions') = 2
		and (pg_temp.worker_row('batch-1')).completion_occurrence_id = v_wake.id and (pg_temp.worker_row('batch-2')).completion_occurrence_id = v_wake.id and v_reporter <> v_silent,
		'One revival carries every result of the batch');
	v_child := pg_temp.wake_start(v_wake.run_id);
	perform pg_temp.worker('{"action":"dispatch","operationKey":"last","todoKey":"market-scan","workerKey":"last","title":"Last","goal":"g","definitionOfDone":"d","access":"read"}',v_child);
	v_done := pg_temp.todo('{"action":"cancel","operationKey":"t-cancel","todoKey":"market-scan"}',v_child);
	perform pg_temp.wake_assert(v_done #>> '{todo,state}' = 'cancelled' and (pg_temp.worker_row('last')).state = 'cancelled'
		and (select status from public.qorpera_wake_occurrences where id = (pg_temp.worker_row('last')).occurrence_id) = 'cancelled',
		'A worker lives no longer than its todo: a queued child never starts');
	perform pg_temp.wake_error(format($q$select pg_temp.worker('{"action":"dispatch","operationKey":"late","todoKey":"market-scan","workerKey":"late",
		"title":"Late","goal":"g","definitionOfDone":"d","access":"read"}',%L::jsonb)$q$,v_child),'55000','Todo is closed; use a new todo for new work');
end $$;

-- 10. A revival never gains a mouth its parent's wake did not have: a silent routine stays silent.
do $$
declare v_routine jsonb; v_id uuid; v_parent jsonb; v_child jsonb; v_wake public.qorpera_wake_occurrences; v_binding jsonb; v_envelope jsonb;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
	v_id := pg_temp.wake_schedule(v_routine,'silent-parent');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_parent := pg_temp.wake_start((select run_id from public.qorpera_wake_occurrences where id = v_id));
	perform pg_temp.todo('{"action":"upsert","operationKey":"quiet-todo","todoKey":"quiet-check","title":"Quiet check"}',v_parent);
	perform pg_temp.worker('{"action":"dispatch","operationKey":"quiet-d","todoKey":"quiet-check","workerKey":"quiet","title":"Quiet work",
		"goal":"g","definitionOfDone":"d","access":"read","revival":"each"}',v_parent);
	perform pg_temp.finish_job((v_parent ->> 'runId')::uuid);
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_child := pg_temp.wake_start((select run_id from public.qorpera_wake_occurrences where id = (pg_temp.worker_row('quiet')).occurrence_id));
	perform public.qorpera_report_worker_result(v_child,'{"operationKey":"quiet-r","outcome":"succeeded","summary":"Nothing to report."}');
	perform pg_temp.finish_job((v_child ->> 'runId')::uuid);
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_kind = 'worker-completion' and parent_run_id = (v_parent ->> 'runId')::uuid;
	v_binding := pg_temp.wake_start(v_wake.run_id);
	v_envelope := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.wake_assert(v_wake.session_id is not null and v_envelope #>> '{policy,final}' = 'forbidden'
		and (v_envelope #>> '{policy,maxPublicSends}')::int = 0,
		'The revival of a silent routine run cannot speak');
end $$;

-- 11. Control-plane only.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_manage_agent_worker(current_setting('qorpera_test.parent_binding')::jsonb,'{"action":"status"}')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_manage_agent_todo(current_setting('qorpera_test.parent_binding')::jsonb,'{"action":"list"}')$q$,'42501');
select pg_temp.path_claims('service_role');
rollback;
