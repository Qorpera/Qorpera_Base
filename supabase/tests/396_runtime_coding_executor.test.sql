-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Order 9, part 3: the executor's side of a coding session. Since C1c-3i (20260930026000) coding sessions serve
-- folder-v2 only and this fixture is snapshot-v1, so the executor's sections are gone; what is left is the dispatch
-- (part 1), which 602's committed fixture cuts at the end marker below.
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
	'A coding session runs for the member who asked for it');
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

-- END DISPATCH FIXTURE

rollback;
