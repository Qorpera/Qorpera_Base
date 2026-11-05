-- @fixture 656_folder_core_run_wakes.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Routine follow-ups (20260930570000; deploy/first-node/RUNTIME-COMPANY-PACE.md): when agent A's open todos changed
-- outside its routines since its dynamic routine last ran and stayed quiet for the wait (30 minutes plus A's offset,
-- doubling after each run brought forward), while A is active, runs nothing and has nothing else queued sooner, the
-- folder tick lists the routine and the restore cancels its queued run and starts it now, with `followUp` in the payload
-- and the attempt of the run that gave way. A blocked todo, a todo with a worker at it or an open human task, one last
-- saved by a routine run or a stopped run, one changed before the routine last ran or too recently, a run the agent
-- chose soon, a run already brought forward, quiet hours, a busy agent, an earlier wake of A, a paused routine, a paused
-- company, an archived agent, a listener and a member's Stop of the latest run bring nothing forward. The agent's
-- offset matches the runtime's (cloud-routine-pace.test.ts pins the same ids).

create function pg_temp.due(p_after uuid default null, p_limit integer default 100) returns jsonb language sql as $$
	select public.qorpera_folder_dynamic_routines_due(p_after, p_limit)
$$;
create function pg_temp.restore(p_routine uuid, p_version bigint default 1) returns jsonb language sql as $$
	select public.qorpera_folder_restore_dynamic_routine_run(p_routine, p_version)
$$;
create function pg_temp.listed(p_routine uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(pg_temp.due() -> 'items') as item(value)
		where item.value ->> 'routine_id' = p_routine::text)
$$;
create function pg_temp.inserted(p_result jsonb) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = (p_result ->> 'occurrence_id')::uuid
$$;
-- Each check starts from a quiet company: nothing queued, every earlier routine of A paused, every todo of A closed.
create function pg_temp.quiet() returns void language plpgsql as $$
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx($q$update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
		where profile_id = '63400000-0000-4000-8000-000000000010' and status = 'queued'$q$);
	perform pg_temp.fx($q$update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'agent'
		where profile_id = '63400000-0000-4000-8000-000000000010' and status = 'active'$q$);
	perform pg_temp.fx($q$update public.qorpera_runtime_agent_todos set state = 'done'
		where profile_id = '63400000-0000-4000-8000-000000000010' and state in ('open', 'blocked')$q$);
end $$;
-- A dynamic routine of agent A, set up p_ago ago, whose run the agent chose p_ahead from now, that run queued.
create function pg_temp.chosen(p_ago interval, p_ahead interval) returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.routine('agent'); v_at timestamptz := date_trunc('second', clock_timestamp() + p_ahead);
	v_result jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set created_at = %L where id = %L',
		clock_timestamp() - p_ago, v_id));
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routine_versions set triggers = jsonb_build_array(jsonb_build_object(
		'id', 't1', 'kind', 'once', 'at', %L, 'timeZone', 'UTC')) where routine_id = %L$f$,
		to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_id));
	v_result := pg_temp.restore(v_id);
	if v_result ->> 'status' <> 'inserted' or (pg_temp.inserted(v_result)).not_before <> v_at then
		raise exception 'The chosen run is queued at its time: %', v_result; end if;
	return v_id;
end $$;
-- An open or blocked todo of agent A, last changed p_ago ago.
create function pg_temp.todo(p_name text, p_state text, p_ago interval) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id, created_at, updated_at)
	values (v_id, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-0000000000a1', p_name, 'Legal sources', p_state, '63400000-0000-4000-8000-000000000020',
		'QorperaOS/agents/legal/todos/' || p_name || '.md', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		clock_timestamp() - p_ago, clock_timestamp() - p_ago);
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A run of agent A that started p_ago ago and ended, cancelled by a member when p_stopped; no wake. Built by hand as in
-- 565.
create function pg_temp.ended_run(p_ago interval, p_stopped boolean default false) returns uuid language plpgsql as $$
declare v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id,
		client_job_id, required_capability, job_type, payload, created_by_user_id, status, run_id, result, finished_at, cancelled_at,
		cancelled_by_user_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
			extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '63400000-0000-4000-8000-000000000002', %L, %L, %L,
			%L, %L, %L)$f$, v_job, case when p_stopped then 'cancelled' else 'completed' end, v_run,
		case when not p_stopped then '{}' end, case when not p_stopped then clock_timestamp() end,
		case when p_stopped then clock_timestamp() end, case when p_stopped then '63400000-0000-4000-8000-000000000002' end));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id,
		job_id, substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version,
		required_capability, job_type, payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id,
		model_provider, model_id, model_selection, audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids, created_at)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'wake', %L, %L,
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63400000-0000-4000-8000-0000000000a1', 1,
			'63400000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			'63400000-0000-4000-8000-000000000002', '63400000-0000-4000-8000-000000000002', 'openai', 'gpt-test',
			'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}', %L)$f$,
		v_run, extensions.gen_random_uuid(), v_job, clock_timestamp() - p_ago));
	return v_run;
end $$;
-- A run of routine p_routine (version 1) that started p_ago ago and ended, with this payload.
create function pg_temp.routine_run(p_routine uuid, p_ago interval, p_payload jsonb, p_stopped boolean default false)
returns uuid language plpgsql as $$
declare v_run uuid := pg_temp.ended_run(p_ago, p_stopped); v_key integer;
begin
	select count(*) + 1 into v_key from public.qorpera_wake_occurrences where routine_id = p_routine;
	perform pg_temp.fx(format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id,
		routine_version, trigger_id, occurrence_key, scheduled_for, not_before, payload, status, run_id, finished_at, created_at)
		values (extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', %L, 1,
			't1', %L, %L, %L, %L, 'completed', %L, clock_timestamp(), %L)$f$, p_routine, 'once:1:' || v_key,
		clock_timestamp() - p_ago, clock_timestamp() - p_ago, p_payload, v_run, clock_timestamp() - p_ago));
	return v_run;
end $$;
-- Todo p_todo as last saved by run p_run (a commit of agent A).
create function pg_temp.saved_by(p_todo uuid, p_run uuid) returns void language plpgsql as $$
declare v_commit uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id,
		requester_kind, requester_id, run_id, session_kind, units)
		values (%L, '63400000-0000-4000-8000-000000000020', %L, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
			'member', '63400000-0000-4000-8000-000000000002', %L, 'in_house', '[]')$f$, v_commit, 'save-' || v_commit, p_run));
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set folder_commit_id = %L where id = %L', v_commit, p_todo));
end $$;
-- A human task agent A asked for on todo p_todo, in p_status.
create function pg_temp.task(p_name text, p_todo uuid, p_status text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_folder_human_task_index(environment_id, id, profile_id, folder_path, folder_key,
		folder_path_version, commit_id, status, title, member_user_id, from_staff_agent_id, todo_id, due_at)
	values ('63400000-0000-4000-8000-000000000020', v_id, '63400000-0000-4000-8000-000000000010',
		'QorperaOS/human-tasks/' || p_name || '.md', 'qorperaos/human-tasks/' || p_name || '.md', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), p_status, 'Send the CVR number', '63400000-0000-4000-8000-000000000002',
		'63400000-0000-4000-8000-0000000000a1', p_todo, clock_timestamp() + interval '2 days');
	set local session_replication_role = origin;
	return v_id;
end $$;

-- 1. The agent's offset: 1 to 20 minutes from the id, as the runtime's.
do $$
declare v_minutes integer[];
begin
	if public.qorpera_routine_agent_offset_minutes('63400000-0000-4000-8000-0000000000a1') <> 15
		or public.qorpera_routine_agent_offset_minutes('00000000-0000-4000-8000-000000000001') <> 10
		or public.qorpera_routine_agent_offset_minutes('0f1a2b3c-8888-4888-8888-000000000001') <> 18 then
		raise exception 'The offsets differ from the runtime''s'; end if;
	select array_agg(distinct public.qorpera_routine_agent_offset_minutes(extensions.gen_random_uuid())) into v_minutes
	from generate_series(1, 400);
	if exists (select 1 from unnest(v_minutes) as m where m not between 1 and 20) or cardinality(v_minutes) < 15 then
		raise exception 'An offset is 1 to 20 minutes, spread: %', v_minutes; end if;
end $$;

-- 2. A todo changed after the routine was set up and quiet since: the routine is listed, and the restore cancels the
-- chosen run and starts it now, as its attempt, saying why. Then it is an ordinary pending run, never brought forward
-- again, also while held (as quiet hours would hold it); and a retry after it counts no attempt for the run that gave way.
do $$
declare v_routine uuid; v_chosen public.qorpera_wake_occurrences%rowtype; v_result jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('3 hours', '1 day');
	select * into v_chosen from public.qorpera_wake_occurrences where routine_id = v_routine and status = 'queued';
	perform pg_temp.todo('legal-sources', 'open', '50 minutes');
	if not pg_temp.listed(v_routine) then raise exception 'A follow-up is due'; end if;
	v_result := pg_temp.restore(v_routine);
	v_wake := pg_temp.inserted(v_result);
	if v_result ->> 'status' <> 'inserted' or v_wake.not_before > clock_timestamp() or v_wake.occurrence_key <> 'once:1:2'
		or v_wake.routine_version <> 1 or v_wake.payload ->> 'schema' <> 'qorpera.routine-once-occurrence/v1'
		or v_wake.payload ->> 'attempt' <> '1'
		or v_wake.payload -> 'followUp' <> jsonb_build_object('step', 1,
			'todos', jsonb_build_array('QorperaOS/agents/legal/todos/legal-sources.md')) then
		raise exception 'The run comes now and says why: % / %', v_result, to_jsonb(v_wake); end if;
	if (select status || '/' || blocked_reason from public.qorpera_wake_occurrences where id = v_chosen.id)
		<> 'cancelled/Brought forward: open todos of the agent changed and are still open' then
		raise exception 'The chosen run gave way'; end if;
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'Then it is an ordinary pending run'; end if;
	-- Held until tomorrow (the quiet hours' end): still never brought forward again.
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set not_before = clock_timestamp() + interval ''1 day''
		where id = %L', v_wake.id));
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'A run brought forward is not brought forward again'; end if;
	-- It ended without a decision: the retry comes now as attempt 2 (the run that gave way is no attempt).
	perform pg_temp.fx(format($f$update public.qorpera_wake_occurrences set status = 'failed', run_id = %L,
		finished_at = clock_timestamp() where id = %L$f$, pg_temp.ended_run('1 minute'), v_wake.id));
	v_result := pg_temp.restore(v_routine);
	if v_result ->> 'status' <> 'inserted' or (pg_temp.inserted(v_result)).not_before > clock_timestamp()
		or (pg_temp.inserted(v_result)).payload ->> 'attempt' <> '2' or (pg_temp.inserted(v_result)).payload ? 'followUp'
		or (pg_temp.inserted(v_result)).occurrence_key <> 'once:1:3' then
		raise exception 'The retry counts only real attempts: % / %', v_result, to_jsonb(pg_temp.inserted(v_result)); end if;
end $$;

-- 3. Nothing is brought forward for a blocked todo, one changed too recently or before the routine was set up, one a
-- worker is at or a member stopped, one with an open or returned human task, a run chosen within the wait, or a listener.
do $$
declare v_routine uuid; v_todo uuid; v_worker uuid; v_task uuid;
begin
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('3 hours', '1 day');
	v_todo := pg_temp.todo('waits-for-jonas', 'blocked', '2 hours');
	if pg_temp.listed(v_routine) then raise exception 'A blocked todo waits for a person'; end if;
	v_todo := pg_temp.todo('just-changed', 'open', '20 minutes');
	if pg_temp.listed(v_routine) then raise exception 'A todo changed within the wait is not quiet yet'; end if;
	-- 30 minutes plus A's 15: quiet at 45.
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set updated_at = clock_timestamp() - interval ''44 minutes''
		where id = %L', v_todo));
	if pg_temp.listed(v_routine) then raise exception 'The wait is 30 minutes plus the agent''s offset'; end if;
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set updated_at = clock_timestamp() - interval ''46 minutes''
		where id = %L', v_todo));
	if not pg_temp.listed(v_routine) then raise exception 'After the wait the follow-up is due'; end if;
	-- A worker at it: its report wakes the agent. A worker a member stopped: the work stays stopped.
	v_worker := pg_temp.worker('63400000-0000-4000-8000-0000000000a1', jsonb_build_object('runId', extensions.gen_random_uuid()),
		'in-house', 'read');
	perform pg_temp.fx(format('update public.qorpera_runtime_workers set todo_id = %L where id = %L', v_todo, v_worker));
	if pg_temp.listed(v_routine) then raise exception 'A todo with an active worker waits for its report'; end if;
	perform pg_temp.fx(format($f$update public.qorpera_runtime_workers set state = 'failed',
		result = '{"outcome":"failed","reason":"member_stopped"}' where id = %L$f$, v_worker));
	if pg_temp.listed(v_routine) then raise exception 'A todo whose worker a member stopped stays stopped'; end if;
	perform pg_temp.fx(format($f$update public.qorpera_runtime_workers set state = 'succeeded', result = '{"outcome":"succeeded"}'
		where id = %L$f$, v_worker));
	if not pg_temp.listed(v_routine) then raise exception 'A finished worker leaves the todo to the agent'; end if;
	-- A human task on it waits for a person, while open or returned.
	v_task := pg_temp.task('send-cvr', v_todo, 'open');
	if pg_temp.listed(v_routine) then raise exception 'A todo with an open human task waits for a person'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'returned', v_task));
	if pg_temp.listed(v_routine) then raise exception 'A returned human task still waits for a person'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'done', v_task));
	if not pg_temp.listed(v_routine) then raise exception 'A done human task leaves the todo to the agent'; end if;
	-- Changed before the routine was set up.
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set updated_at = clock_timestamp() - interval ''4 hours''
		where id = %L', v_todo));
	if pg_temp.listed(v_routine) then raise exception 'A todo that did not change since the routine was set up'; end if;
	-- A run the agent chose within the wait.
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('3 hours', '40 minutes');
	perform pg_temp.todo('soon-anyway', 'open', '2 hours');
	if pg_temp.listed(v_routine) then raise exception 'A run chosen within the wait comes by itself'; end if;
	-- A listener waits for its own todo.
	if public.qorpera_routine_follow_up((select r from public.qorpera_cloud_routines r where r.id = v_routine),
			jsonb_build_object('id', 't1', 'kind', 'once', 'at', '2030-01-01T09:00:00Z', 'timeZone', 'UTC',
				'after', 'qorperaos/agents/legal/todos/soon-anyway.md')) is not null then
		raise exception 'A listener is not brought forward'; end if;
end $$;

-- 4. Not while the agent works or has something sooner, nor for a paused routine, a paused company, an archived agent
-- or inside the routine's quiet hours; each is due again once that ends.
do $$
declare v_routine uuid; v_other uuid; v_actor jsonb;
begin
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('3 hours', '1 day');
	perform pg_temp.todo('while-busy', 'open', '2 hours');
	v_actor := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	if pg_temp.listed(v_routine) then raise exception 'Not while a run of the agent works'; end if;
	perform pg_temp.fx(format($f$update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = %L$f$, v_actor ->> 'jobId'));
	if not pg_temp.listed(v_routine) then raise exception 'Once the run ended the follow-up is due'; end if;
	-- A paused routine keeps its pause.
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L where id = %L',
		'paused', 'member', v_routine));
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'changed' then
		raise exception 'A paused routine is not brought forward'; end if;
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = null where id = %L',
		'active', v_routine));
	if not pg_temp.listed(v_routine) then raise exception 'Resumed, it is due'; end if;
	-- A paused company runs nothing.
	perform pg_temp.fx($q$insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
		values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', 'follow-up check')$q$);
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'paused' then
		raise exception 'A paused company brings nothing forward'; end if;
	perform pg_temp.fx($q$delete from public.qorpera_company_execution_pauses
		where profile_id = '63400000-0000-4000-8000-000000000010'$q$);
	if not pg_temp.listed(v_routine) then raise exception 'Unpaused, it is due'; end if;
	-- An archived agent is woken by nothing.
	perform pg_temp.fx($q$update public.qorpera_profile_staff set employment_status = 'archived'
		where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = '63400000-0000-4000-8000-0000000000a1'$q$);
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'paused' then
		raise exception 'An archived agent''s routine is not brought forward'; end if;
	perform pg_temp.fx($q$update public.qorpera_profile_staff set employment_status = 'active'
		where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = '63400000-0000-4000-8000-0000000000a1'$q$);
	if not pg_temp.listed(v_routine) then raise exception 'Active again, it is due'; end if;
	-- Inside the routine's quiet hours (UTC, an hour either side of now): not; after them it is.
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routines set quiet_start = %L, quiet_end = %L,
		quiet_time_zone = 'UTC' where id = %L$f$, ((clock_timestamp() - interval '1 hour') at time zone 'UTC')::time,
		((clock_timestamp() + interval '1 hour') at time zone 'UTC')::time, v_routine));
	if pg_temp.listed(v_routine) then raise exception 'Nothing is brought forward inside the quiet hours'; end if;
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routines set quiet_start = %L, quiet_end = %L where id = %L$f$,
		((clock_timestamp() + interval '1 hour') at time zone 'UTC')::time,
		((clock_timestamp() + interval '2 hours') at time zone 'UTC')::time, v_routine));
	if not pg_temp.listed(v_routine) then raise exception 'Outside the quiet hours it is due'; end if;
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set quiet_start = null, quiet_end = null,
		quiet_time_zone = null where id = %L', v_routine));
	-- Another dynamic routine of A comes sooner: that one is brought forward, this one not.
	v_other := pg_temp.chosen('3 hours', '20 hours');
	if pg_temp.listed(v_routine) or not pg_temp.listed(v_other) then
		raise exception 'Only the agent''s earliest wake is brought forward'; end if;
	if (pg_temp.inserted(pg_temp.restore(v_other))).payload -> 'followUp' ->> 'step' <> '1' then
		raise exception 'The earliest routine came now'; end if;
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'The other one waits behind it'; end if;
end $$;

-- 5. After a run brought forward, the next waits twice as long. A change the routine's own run saved moved nothing (that
-- run chose its next run), so a run that only notes "still waiting" ends the follow-ups. A member's Stop of the latest
-- run, or of the run that saved the todo last, ends them too.
do $$
declare v_routine uuid; v_todo uuid; v_result jsonb; v_run uuid;
begin
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('5 hours', '1 day');
	perform pg_temp.routine_run(v_routine, '3 hours', '{"schema":"qorpera.routine-once-occurrence/v1","attempt":1,"followUp":{"step":1,"todos":[]}}');
	-- Step 2: 1 hour plus A's 15 minutes.
	v_todo := pg_temp.todo('second-look', 'open', '70 minutes');
	if pg_temp.listed(v_routine) then raise exception 'The second follow-up waits an hour plus the offset'; end if;
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set updated_at = clock_timestamp() - interval ''80 minutes''
		where id = %L', v_todo));
	if not pg_temp.listed(v_routine) then raise exception 'Then it is due'; end if;
	v_result := pg_temp.restore(v_routine);
	if (pg_temp.inserted(v_result)).payload -> 'followUp' ->> 'step' <> '2'
		or (pg_temp.inserted(v_result)).occurrence_key <> 'once:1:3' then
		raise exception 'It is the second step: % / %', v_result, to_jsonb(pg_temp.inserted(v_result)); end if;
	-- Changed before the routine's latest run started: nothing moved since.
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('5 hours', '1 day');
	v_run := pg_temp.routine_run(v_routine, '1 hour', '{"schema":"qorpera.routine-once-occurrence/v1","attempt":1}');
	v_todo := pg_temp.todo('looked-at', 'open', '2 hours');
	if pg_temp.listed(v_routine) then raise exception 'Nothing moved since the routine last ran'; end if;
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set updated_at = clock_timestamp() - interval ''50 minutes''
		where id = %L', v_todo));
	if not pg_temp.listed(v_routine) then raise exception 'A change after its latest run is due'; end if;
	-- Saved by that routine run itself ("checked, still waiting"): not; by a conversation's run: due.
	perform pg_temp.saved_by(v_todo, v_run);
	if pg_temp.listed(v_routine) then raise exception 'A routine run''s own note moves nothing'; end if;
	perform pg_temp.saved_by(v_todo, pg_temp.ended_run('55 minutes'));
	if not pg_temp.listed(v_routine) then raise exception 'A change another run saved is due'; end if;
	-- Saved by another routine's run of the same agent: not either, so two routines never wake each other.
	perform pg_temp.saved_by(v_todo, pg_temp.routine_run(pg_temp.routine('agent'), '55 minutes', '{}'));
	if pg_temp.listed(v_routine) then raise exception 'A change another routine''s run saved moves nothing'; end if;
	-- A member stopped the latest run.
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('5 hours', '1 day');
	perform pg_temp.routine_run(v_routine, '2 hours', '{"schema":"qorpera.routine-once-occurrence/v1","attempt":1}', true);
	perform pg_temp.todo('stopped-work', 'open', '1 hour');
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'A member''s Stop of the latest run brings nothing forward'; end if;
	-- A todo last saved by a run a member stopped, then by one nobody stopped.
	perform pg_temp.quiet();
	v_routine := pg_temp.chosen('5 hours', '1 day');
	v_todo := pg_temp.todo('stopped-save', 'open', '1 hour');
	v_run := pg_temp.ended_run('70 minutes', true);
	perform pg_temp.saved_by(v_todo, v_run);
	if pg_temp.listed(v_routine) then raise exception 'A todo saved last by a run a member stopped stays stopped'; end if;
	perform pg_temp.fx(format($f$update public.qorpera_runner_jobs set status = 'completed', result = '{}',
		finished_at = clock_timestamp(), cancelled_at = null, cancelled_by_user_id = null where run_id = %L$f$, v_run));
	if not pg_temp.listed(v_routine) then raise exception 'A todo saved by a run nobody stopped is due'; end if;
end $$;

rollback;
