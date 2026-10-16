-- @fixture 840_folder_state_worker_files.test.sql until "-- 3. A write worker's report"
-- Company state files, F2-5b-3 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)" §6): the folder-v2
-- worker drain, the shared folder drains' `workers` (RUNTIME-COMPANY-FOLDER-LISTENER.md §9). 840's fixture leaves Ada's
-- two dispatched workers (price-check, extra) active with no wake; the drain starts them, fails one whose wake ended
-- without a report, revives the parent with the results, one revival at a time, cancels a worker whose parent stopped or
-- whose todo was cancelled, fails a dispatch nobody can start, and suppresses an erased worker's results. Races are in 843.

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create function pg_temp.drain(p_limit integer default 32) returns jsonb language sql as $$
	select public.qorpera_folder_workers_company('63400000-0000-4000-8000-000000000020', p_limit)
$$;
create function pg_temp.listed() returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_folder_workers_due() -> 'items') i
		where i.value ->> 'environment_id' = '63400000-0000-4000-8000-000000000020')
$$;
create function pg_temp.w(p_id uuid) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = p_id
$$;
create function pg_temp.wake(p_id uuid) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = p_id
$$;
-- The runner ends a run's job (as 385's finish_job), and its wake with it (the job-status trigger's work: the fixture's
-- hand-built jobs change with foreign keys and triggers off).
create function pg_temp.finish(p_run uuid, p_status text default 'completed') returns void language plpgsql as $$
begin
	perform pg_temp.fx(format($q$update public.qorpera_runner_jobs set status = %L,
		result = case when %L = 'completed' then '{}'::jsonb end, last_error = case when %L = 'failed' then 'Fixture failure' end,
		finished_at = case when %L <> 'cancelled' then statement_timestamp() end,
		cancelled_at = case when %L = 'cancelled' then statement_timestamp() end,
		cancelled_by_user_id = case when %L = 'cancelled' then '63400000-0000-4000-8000-000000000001'::uuid end,
		lease_token_sha256 = null, lease_expires_at = null where run_id = %L$q$, p_status, p_status, p_status, p_status, p_status,
		p_status, p_run));
	perform pg_temp.fx(format($q$update public.qorpera_wake_occurrences set status = %L, finished_at = clock_timestamp()
		where run_id = %L and status = 'materialized'$q$, p_status, p_run));
end $$;
-- A wake that ends before any run took it (as the materializer cancels one).
create function pg_temp.cancel_wake(p_id uuid) returns void language plpgsql as $$
begin
	perform pg_temp.fx(format($q$update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
		where id = %L$q$, p_id));
end $$;
-- A dispatch by a run of Ada's, through the worker entry with the call's review.
create function pg_temp.dispatch(p_run jsonb, p_folder text, p_id uuid, p_key text, p_revival text default 'each') returns uuid
language plpgsql as $$
declare b jsonb := pg_temp.brief(p_id, p_revival => p_revival); u jsonb := pg_temp.dispatch_units(p_run -> 'actor', p_folder, b);
begin
	perform pg_temp.expect(pg_temp.wc(p_run -> 'actor', p_key, u, pg_temp.dispatch_request(p_folder, b),
		pg_temp.reviewed(p_run, p_key || '-call', u)), jsonb_array_length(u), 'saved');
	return p_id;
end $$;

-- 1. The due list names the company; the drain starts both workers with the folder's paths ---------------------------
do $$
declare ada jsonb := current_setting('qorpera_test.ada')::jsonb; v jsonb; x public.qorpera_runtime_workers; o public.qorpera_wake_occurrences;
	price constant uuid := '84000000-0000-4000-8000-000000000101'; extra constant uuid := '84000000-0000-4000-8000-000000000104';
begin
	if not pg_temp.listed() then raise exception 'The due list does not name a company with workers to start'; end if;
	v := pg_temp.drain();
	if v ->> 'state' is distinct from 'done' or (v ->> 'started')::integer <> 2 or (v ->> 'failed')::integer <> 0 then
		raise exception 'The drain starts both: %', v; end if;
	x := pg_temp.w(price); o := pg_temp.wake(x.occurrence_id);
	if x.state is distinct from 'active' or o.id is null or o.status is distinct from 'queued' or o.source_kind is distinct from 'worker-dispatch'
		or o.source_id is distinct from price or o.parent_run_id is distinct from (ada -> 'actor' ->> 'runId')::uuid
		or o.staff_agent_id is distinct from '84000000-0000-4000-8000-0000000000e1' or o.wake_kind is distinct from 'agent'
		or o.occurrence_key is distinct from 'worker-dispatch:' || price::text || ':1'
		or o.environment_id is distinct from '63400000-0000-4000-8000-000000000020'
		or o.payload -> 'body' is null and o.payload is null then
		raise exception 'The dispatch wake: % / %', to_jsonb(x), to_jsonb(o); end if;
	-- The payload: legacy's closed shape with the todo's file and the worker's folder.
	if public.qorpera_folder_worker_dispatch_payload(x, (select t from public.qorpera_runtime_agent_todos t where t.id = x.todo_id))
			is distinct from jsonb_build_object('schema','qorpera.worker-dispatch/v1','workerId',price,'workerKey','price-check',
				'sequence',1,'species','in-house','title','Compare suppliers',
				'todo',jsonb_build_object('todoKey','call-the-bank','title','Call the bank','path','agents/ada/todos/call-the-bank.md'),
				'parentRunId',(ada -> 'actor' ->> 'runId')::uuid,'access','write',
				'outputFolder','agents/ada/todos/call-the-bank/price-check','dispatch',x.dispatch)
		or (o.payload #>> '{}') is null then
		raise exception 'The dispatch payload: %', o.payload; end if;
	if (pg_temp.w(extra)).occurrence_id is null or (pg_temp.wake((pg_temp.w(extra)).occurrence_id)).status is distinct from 'queued' then
		raise exception 'The second worker started too'; end if;
	-- Started workers are not due: the company is left out, and a call answers idle.
	if pg_temp.listed() or pg_temp.drain() ->> 'state' is distinct from 'idle' then raise exception 'A started worker stays due'; end if;
end $$;

-- 2. A wake that ended without a report fails its worker; the parent is revived once its own job has ended ------------
do $$
declare ada jsonb := current_setting('qorpera_test.ada')::jsonb; v jsonb; x public.qorpera_runtime_workers; o public.qorpera_wake_occurrences;
	price constant uuid := '84000000-0000-4000-8000-000000000101'; extra constant uuid := '84000000-0000-4000-8000-000000000104';
begin
	-- The worker's run (as the materializer makes it from the wake) ends without a report.
	perform pg_temp.finish((pg_temp.worker_run(ada, price) -> 'actor' ->> 'runId')::uuid);
	v := pg_temp.drain();
	x := pg_temp.w(price);
	if (v ->> 'failed')::integer <> 1 or x.state is distinct from 'failed' or x.completion_state is distinct from 'waiting'
		or x.result ->> 'reason' is distinct from 'ended_without_report' or x.result ->> 'outcome' is distinct from 'failed'
		or not exists (select 1 from public.qorpera_runtime_worker_events where worker_id = price and kind = 'ended'
			and body ->> 'occurrenceStatus' = 'completed') then
		raise exception 'A wake that ended without a report fails its worker: % / %', v, to_jsonb(x); end if;
	-- The parent's own job still runs: never raced.
	if pg_temp.listed() or pg_temp.drain() ->> 'state' is distinct from 'idle' then raise exception 'The parent was raced'; end if;
	perform pg_temp.finish((ada -> 'actor' ->> 'runId')::uuid);
	if not pg_temp.listed() then raise exception 'A parent whose job ended is not listed'; end if;
	v := pg_temp.drain();
	x := pg_temp.w(price); o := pg_temp.wake(x.completion_occurrence_id);
	if (v ->> 'revivals')::integer <> 1 or x.completion_state is distinct from 'delivered' or o.status is distinct from 'queued'
		or o.source_kind is distinct from 'worker-completion' or o.parent_run_id is distinct from (ada -> 'actor' ->> 'runId')::uuid
		or o.occurrence_key is distinct from 'worker-completion:' || price::text || ':1'
		or o.session_id is distinct from (select session_id from public.qorpera_execution_runs where id = (ada -> 'actor' ->> 'runId')::uuid)
		or jsonb_array_length(o.payload -> 'completions') <> 1 or o.payload -> 'completions' -> 0 ->> 'outcome' is distinct from 'failed'
		or (o.payload ->> 'stillActive')::integer <> 1 then
		raise exception 'The parent is revived with the result: % / %', v, to_jsonb(o); end if;
	-- One revival at a time: the second worker ends too, and waits for the first revival's run.
	perform pg_temp.cancel_wake((pg_temp.w(extra)).occurrence_id);
	v := pg_temp.drain();
	if (v ->> 'failed')::integer <> 1 or (pg_temp.w(extra)).result ->> 'reason' is distinct from 'not_started'
		or (pg_temp.w(extra)).completion_state is distinct from 'waiting' or (v ->> 'revivals')::integer <> 0 then
		raise exception 'A cancelled wake is not_started, and the revival waits: %', v; end if;
	if pg_temp.listed() then raise exception 'A parent with a pending revival is listed'; end if;
	-- The first revival's run ends: the second result goes.
	perform pg_temp.cancel_wake(x.completion_occurrence_id);
	v := pg_temp.drain();
	if (v ->> 'revivals')::integer <> 1 or (pg_temp.w(extra)).completion_state is distinct from 'delivered' then
		raise exception 'The next revival: %', v; end if;
end $$;

-- 3. A new run's workers: a stopped parent cancels its worker, a cancelled todo its own; a refused start fails ----------
select set_config('qorpera_test.ada2', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false) \g /dev/null
do $$
declare ada jsonb := current_setting('qorpera_test.ada2')::jsonb; v jsonb; m jsonb := pg_temp.member(2);
	a constant uuid := '84000000-0000-4000-8000-000000000111'; b constant uuid := '84000000-0000-4000-8000-000000000112';
begin
	perform pg_temp.dispatch(ada, 'agents/ada/todos/plan-the-trip/flights', a, 'drain-dispatch-0001');
	perform pg_temp.dispatch(ada, 'agents/ada/todos/plan-the-trip/hotels', b, 'drain-dispatch-0002');
	v := pg_temp.drain();
	if (v ->> 'started')::integer <> 2 then raise exception 'Fixture: two started: %', v; end if;
	-- The todo is cancelled (F2-5a allows it with workers at work): both workers stop with it, their queued wakes too.
	perform pg_temp.expect(pg_temp.commit(m, 'drain-cancel-0001', jsonb_build_array(
		pg_temp.f2_todo(m, 'agents/ada/todos/plan-the-trip.md', 'Plan the trip', 'cancelled'))), 1, 'saved');
	v := pg_temp.drain();
	if (v ->> 'cancelled')::integer <> 2 or (pg_temp.w(a)).state is distinct from 'cancelled'
		or (pg_temp.w(a)).result ->> 'reason' is distinct from 'todo_cancelled'
		or (pg_temp.wake((pg_temp.w(a)).occurrence_id)).status is distinct from 'cancelled'
		or (pg_temp.w(b)).completion_state is distinct from 'suppressed'
		or (select state from public.qorpera_runtime_agent_todos where id = (pg_temp.w(a)).todo_id) is distinct from 'cancelled' then
		raise exception 'A cancelled todo cancels its workers: % / %', v, to_jsonb(pg_temp.w(a)); end if;
end $$;
select set_config('qorpera_test.ada3', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false) \g /dev/null
do $$
declare ada jsonb := current_setting('qorpera_test.ada3')::jsonb; v jsonb; m jsonb := pg_temp.member(2);
	c constant uuid := '84000000-0000-4000-8000-000000000113'; d constant uuid := '84000000-0000-4000-8000-000000000114';
begin
	perform pg_temp.expect(pg_temp.commit(m, 'drain-todo-0002', jsonb_build_array(
		pg_temp.f2_todo(m, 'agents/ada/todos/pay-the-rent.md', 'Pay the rent'))), 1, 'saved');
	perform pg_temp.dispatch(ada, 'agents/ada/todos/pay-the-rent/landlord', c, 'drain-dispatch-0003');
	-- The parent is stopped by a person before the drain: the worker stops with it, never started.
	perform pg_temp.finish((ada -> 'actor' ->> 'runId')::uuid, 'cancelled');
	v := pg_temp.drain();
	if (v ->> 'cancelled')::integer <> 1 or (pg_temp.w(c)).state is distinct from 'cancelled'
		or (pg_temp.w(c)).result ->> 'reason' is distinct from 'parent_stopped' or (pg_temp.w(c)).occurrence_id is not null then
		raise exception 'A stopped parent cancels its worker: % / %', v, to_jsonb(pg_temp.w(c)); end if;
end $$;
-- A start nobody can make: the requester left before the drain. The worker fails (not_started), never left active.
select set_config('qorpera_test.ada4', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false) \g /dev/null
do $$
declare ada jsonb := current_setting('qorpera_test.ada4')::jsonb; v jsonb; d constant uuid := '84000000-0000-4000-8000-000000000115';
begin
	perform pg_temp.dispatch(ada, 'agents/ada/todos/pay-the-rent/bank', d, 'drain-dispatch-0004');
	perform pg_temp.fx($q$delete from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
		and user_id = '63400000-0000-4000-8000-000000000002'$q$);
	v := pg_temp.drain();
	if (v ->> 'failed')::integer <> 1 or (pg_temp.w(d)).state is distinct from 'failed'
		or (pg_temp.w(d)).result ->> 'reason' is distinct from 'not_started' or (pg_temp.w(d)).completion_state is distinct from 'waiting'
		or not exists (select 1 from public.qorpera_runtime_worker_events where worker_id = d and kind = 'ended'
			and body ->> 'occurrenceStatus' = 'refused')
		or exists (select 1 from public.qorpera_wake_occurrences where source_id = d) then
		raise exception 'A refused start fails the worker: % / %', v, to_jsonb(pg_temp.w(d)); end if;
	perform pg_temp.fx($q$insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
		select '63400000-0000-4000-8000-000000000010', id, email, 'Member', 'contributor' from auth.users
		where id = '63400000-0000-4000-8000-000000000002'$q$);
end $$;

-- 4. An erased worker's waiting results are suppressed; a batch waits for its last worker -------------------------------
do $$
declare v jsonb; d constant uuid := '84000000-0000-4000-8000-000000000115';
begin
	-- (As P18b's erasure leaves a retired worker.)
	perform pg_temp.fx(format($q$update public.qorpera_runtime_workers set title = 'Erased',
		worker_key = 'erased.' || replace(id::text, '-', ''), dispatch = public.qorpera_folder_erasure_blank_object(dispatch),
		result = public.qorpera_folder_erasure_blank_object(result), folder_path = null, folder_key = null,
		folder_environment_id = null, folder_retired_at = coalesce(folder_retired_at, clock_timestamp()),
		folder_erased_at = clock_timestamp() where id = %L$q$, d));
	perform pg_temp.finish((current_setting('qorpera_test.ada4')::jsonb -> 'actor' ->> 'runId')::uuid);
	v := pg_temp.drain();
	if (pg_temp.w(d)).completion_state is distinct from 'suppressed' or (v ->> 'suppressed')::integer <> 1
		or exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'worker-completion' and source_id = d) then
		raise exception 'An erased worker''s results are suppressed: %', v; end if;
end $$;
select set_config('qorpera_test.ada5', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false) \g /dev/null
do $$
declare ada jsonb := current_setting('qorpera_test.ada5')::jsonb; v jsonb;
	e constant uuid := '84000000-0000-4000-8000-000000000116'; f constant uuid := '84000000-0000-4000-8000-000000000117';
begin
	perform pg_temp.dispatch(ada, 'agents/ada/todos/pay-the-rent/one', e, 'drain-dispatch-0005', 'batch');
	perform pg_temp.dispatch(ada, 'agents/ada/todos/pay-the-rent/two', f, 'drain-dispatch-0006', 'batch');
	perform pg_temp.drain();
	perform pg_temp.finish((ada -> 'actor' ->> 'runId')::uuid);
	perform pg_temp.cancel_wake((pg_temp.w(e)).occurrence_id);
	v := pg_temp.drain();
	if (pg_temp.w(e)).completion_state is distinct from 'waiting' or (v ->> 'revivals')::integer <> 0 then
		raise exception 'A batch revives before its last worker: %', v; end if;
	perform pg_temp.cancel_wake((pg_temp.w(f)).occurrence_id);
	-- This pass ends the last worker; the next revives the parent with both results.
	v := pg_temp.drain();
	if (v ->> 'failed')::integer <> 1 or (v ->> 'revivals')::integer <> 0 then raise exception 'The last worker ends: %', v; end if;
	v := pg_temp.drain();
	if (v ->> 'revivals')::integer <> 1 or (pg_temp.w(e)).completion_state is distinct from 'delivered'
		or (pg_temp.w(f)).completion_state is distinct from 'delivered'
		or jsonb_array_length((pg_temp.wake((pg_temp.w(e)).completion_occurrence_id)).payload -> 'completions') <> 2 then
		raise exception 'A batch revives once with both results: %', v; end if;
end $$;

-- 5. A paused company, one being deleted and another core answer without locking; the functions are the service role's --
do $$
declare v jsonb;
begin
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', 'F2-5b-3 test');
	if pg_temp.drain() ->> 'state' is distinct from 'paused' then raise exception 'A paused company'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010';
	if public.qorpera_folder_workers_company('63400000-0000-4000-8000-0000000000ff', 1) ->> 'state' is distinct from 'not_folder' then
		raise exception 'Another core''s company'; end if;
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"63400000-0000-4000-8000-000000000001"}', true);
	begin
		perform pg_temp.drain();
		raise exception 'A member ran the drain' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_folder_workers_due();
		raise exception 'A member read the due list' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	begin
		perform pg_temp.drain(33);
		raise exception 'A drain past its limit' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_folder_workers_due(null, 501);
		raise exception 'A due page past its limit' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	if has_function_privilege('authenticated', 'public.qorpera_folder_workers_company(uuid,integer)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_workers_company(uuid,integer)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_worker_due(public.qorpera_runtime_workers)', 'execute') then
		raise exception 'The drain''s privileges'; end if;
	-- Every body carries the marker; the legacy drain went in the legacy sweep's F3b (20260930295000).
	if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_folder_workers_due',
			'qorpera_folder_workers_company', 'qorpera_folder_worker_due', 'qorpera_folder_worker_ended',
			'qorpera_folder_worker_revival_pending', 'qorpera_folder_worker_dispatch_payload')
			and position('20260930003100' in pg_get_functiondef(p.oid)) = 0)
		or to_regprocedure('public.qorpera_drain_worker_wakes(integer)') is not null then
		raise exception 'The markers'; end if;
end $$;

rollback;
