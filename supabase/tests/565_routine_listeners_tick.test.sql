-- @fixture 656_folder_core_run_wakes.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Listener routines, L1 (20260930565000; deploy/first-node/RUNTIME-LISTENER-ROUTINES.md): the folder tick holds a
-- dynamic routine's first run back while its `after` todo or human task is still open and its `at` is ahead, then
-- starts it at once when nothing open is left there (done, cancelled, declined, deleted) or when `at` comes. The run's
-- payload says what it waited for and what became of it (done, cancelled, gone, or open when the latest time came
-- first). A member's Stop of its latest run pauses it at once, also while it listens. The lookups use the folder key
-- indexes. A dynamic routine without `after` is unchanged. The
-- version trigger's shape: `after` is a folded key of a todo or a human task file.

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
-- A hand-built dynamic routine of agent A that waits for p_after (a folder key), at p_at at the latest.
create function pg_temp.listener(p_after text, p_at timestamptz) returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.routine('agent');
begin
	set local session_replication_role = replica;
	update public.qorpera_cloud_routine_versions set triggers = jsonb_build_array(jsonb_build_object('id', 't1', 'kind', 'once',
		'at', to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'timeZone', 'UTC', 'after', p_after))
	where routine_id = v_id;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A todo file's index row of agent A, in p_state.
create function pg_temp.todo(p_name text, p_state text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id)
	values (v_id, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-0000000000a1', p_name, 'Landing page', p_state, '63400000-0000-4000-8000-000000000020',
		'QorperaOS/agents/builder/todos/' || p_name || '.md', extensions.gen_random_uuid(), extensions.gen_random_uuid());
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A human task file's index row, in p_status.
create function pg_temp.task(p_name text, p_status text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_folder_human_task_index(environment_id, id, profile_id, folder_path, folder_key,
		folder_path_version, commit_id, status, title, member_user_id, from_staff_agent_id, due_at)
	values ('63400000-0000-4000-8000-000000000020', v_id, '63400000-0000-4000-8000-000000000010',
		'QorperaOS/human-tasks/' || p_name || '.md', 'qorperaos/human-tasks/' || p_name || '.md', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), p_status, 'Sign the contract', '63400000-0000-4000-8000-000000000002',
		'63400000-0000-4000-8000-0000000000a1', clock_timestamp() + interval '2 days');
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.inserted(p_result jsonb) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = (p_result ->> 'occurrence_id')::uuid
$$;

-- 1. The shape: `after` is a folded key of a todo or a human task file, in the file and in the version's trigger.
do $$
declare v_parse jsonb := jsonb_build_object('kind','routine','id','56500000-0000-4000-8000-0000000000e1','title','Review',
	'status','active','timezone','UTC','ends',null,'runs',null,'quiet',null,'effort','medium','reply','optional',
	'conclusion',null,'instructions','Review it.');
	v_trigger jsonb;
begin
	if jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z','after','QorperaOS/agents/builder/todos/landing-page.md')))) <> 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z','after','QorperaOS/human-tasks/sign.md')))) <> 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z')))) <> 0 then
		raise exception 'A dynamic routine may wait for a todo or a human task'; end if;
	if jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z','after','product/plan.md')))) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z','after','')))) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','every','minutes',60,'starts',null,'after','QorperaOS/human-tasks/sign.md')))) = 0 then
		raise exception 'after is only a todo''s or a human task''s path, and only beside when: once'; end if;
	v_trigger := public.qorpera_company_state_routine_trigger(v_parse || jsonb_build_object('trigger',
		jsonb_build_object('when','once','at','2030-01-01T09:00:00Z','after','QorperaOS/agents/Builder/todos/landing-page.md')));
	if v_trigger ->> 'after' is distinct from 'qorperaos/agents/builder/todos/landing-page.md'
		or not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
		raise exception 'The version keeps the folded key: %', v_trigger; end if;
	if public.qorpera_cloud_routine_trigger_valid(v_trigger || '{"after":"QorperaOS/agents/builder/todos/landing-page.md"}')
		or public.qorpera_cloud_routine_trigger_valid(v_trigger || '{"after":"qorperaos/vision/vision.md"}')
		or public.qorpera_cloud_routine_trigger_valid(v_trigger || '{"after":7}') then
		raise exception 'A version''s after is a folded key of a todo or a human task file'; end if;
	if public.qorpera_company_state_routine_trigger(v_parse || jsonb_build_object('trigger',
			jsonb_build_object('when','once','at','2030-01-01T09:00:00Z'))) ? 'after' then
		raise exception 'A plain dynamic routine has no after'; end if;
end $$;

-- 2. An open todo holds the run back; once it is done, the run comes at once and says so.
do $$
declare v_todo uuid := pg_temp.todo('landing-page', 'open'); v_result jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_routine uuid := pg_temp.listener('qorperaos/agents/builder/todos/landing-page.md', clock_timestamp() + interval '2 days');
begin
	perform pg_temp.path_claims('service_role');
	v_result := pg_temp.restore(v_routine);
	if pg_temp.listed(v_routine) or v_result ->> 'status' <> 'busy' or v_result ->> 'listening' <> 'true'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine) then
		raise exception 'A listener waits while its todo is open: %', v_result; end if;
	-- Blocked is still open.
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set state = %L where id = %L', 'blocked', v_todo));
	if pg_temp.listed(v_routine) then raise exception 'A blocked todo is still open'; end if;
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set state = %L where id = %L', 'done', v_todo));
	if not pg_temp.listed(v_routine) then raise exception 'A done todo lets the run come'; end if;
	v_result := pg_temp.restore(v_routine);
	v_wake := pg_temp.inserted(v_result);
	if v_result ->> 'status' <> 'inserted' or v_wake.not_before > clock_timestamp() or v_wake.occurrence_key <> 'once:1:1'
		or v_wake.payload ->> 'schema' <> 'qorpera.routine-once-occurrence/v1' or v_wake.payload ->> 'attempt' <> '1'
		or v_wake.payload ->> 'after' <> 'qorperaos/agents/builder/todos/landing-page.md' or v_wake.payload ->> 'state' <> 'done' then
		raise exception 'The heard run comes now and says what it waited for: % / %', v_result, to_jsonb(v_wake); end if;
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'Then it is an ordinary pending run'; end if;
end $$;

-- 3. The fallback: `at` came first, the todo still open. The run comes, and says the todo is not done.
do $$
declare v_todo uuid := pg_temp.todo('pricing', 'open'); v_result jsonb;
	v_routine uuid := pg_temp.listener('qorperaos/agents/builder/todos/pricing.md', clock_timestamp() - interval '1 minute');
begin
	perform pg_temp.path_claims('service_role');
	if not pg_temp.listed(v_routine) then raise exception 'A listener whose latest time passed is due'; end if;
	v_result := pg_temp.restore(v_routine);
	if v_result ->> 'status' <> 'inserted' or (pg_temp.inserted(v_result)).payload ->> 'state' <> 'open'
		or (pg_temp.inserted(v_result)).not_before > clock_timestamp() then
		raise exception 'The fallback run says its todo is not done: % / %', v_result, to_jsonb(pg_temp.inserted(v_result)); end if;
end $$;

-- 4. Cancelled, deleted (retired) and never-made todos leave nothing open; a human task waits while open or returned.
do $$
declare v_cancelled uuid := pg_temp.todo('cancelled-one', 'open'); v_retired uuid := pg_temp.todo('deleted-one', 'open');
	v_task uuid := pg_temp.task('sign', 'open'); v_routine uuid;
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set state = %L where id = %L', 'cancelled', v_cancelled));
	perform pg_temp.fx(format('update public.qorpera_runtime_agent_todos set folder_retired_at = clock_timestamp() where id = %L', v_retired));
	if public.qorpera_routine_listener_state('63400000-0000-4000-8000-000000000020',
			'qorperaos/agents/builder/todos/cancelled-one.md') <> 'cancelled'
		or public.qorpera_routine_listener_state('63400000-0000-4000-8000-000000000020',
			'qorperaos/agents/builder/todos/deleted-one.md') <> 'gone' then
		raise exception 'A cancelled todo is cancelled, a deleted one gone'; end if;
	foreach v_routine in array array[
		pg_temp.listener('qorperaos/agents/builder/todos/cancelled-one.md', clock_timestamp() + interval '2 days'),
		pg_temp.listener('qorperaos/agents/builder/todos/deleted-one.md', clock_timestamp() + interval '2 days'),
		pg_temp.listener('qorperaos/agents/builder/todos/never.md', clock_timestamp() + interval '2 days')] loop
		if not pg_temp.listed(v_routine) then raise exception 'Nothing open is left: % is due', v_routine; end if;
	end loop;
	if (pg_temp.inserted(pg_temp.restore(v_routine))).payload ->> 'state' <> 'gone' then
		raise exception 'A never-made todo is gone'; end if;
	v_routine := pg_temp.listener('qorperaos/human-tasks/sign.md', clock_timestamp() + interval '2 days');
	if pg_temp.listed(v_routine) then raise exception 'An open human task holds the run back'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'returned', v_task));
	if pg_temp.listed(v_routine) then raise exception 'A returned human task is open again'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'done', v_task));
	if not pg_temp.listed(v_routine) or (pg_temp.inserted(pg_temp.restore(v_routine))).payload ->> 'state' <> 'done' then
		raise exception 'A done human task lets the run come'; end if;
	v_routine := pg_temp.listener('qorperaos/human-tasks/decline.md', clock_timestamp() + interval '2 days');
	perform pg_temp.task('decline', 'declined');
	if (pg_temp.inserted(pg_temp.restore(v_routine))).payload ->> 'state' <> 'cancelled' then
		raise exception 'A declined human task is cancelled'; end if;
end $$;

-- 4b. A member stopped the run that set the listener: the tick lists the routine while it still listens, and the restore
-- pauses it at once (not at its latest time). The listener is version 2; version 1's run is the stopped one, built by
-- hand as in 819.
do $$
declare v_todo uuid := pg_temp.todo('stopped-one', 'open'); v_wake uuid; v_run uuid := extensions.gen_random_uuid();
	v_job uuid := extensions.gen_random_uuid();
	v_routine uuid := pg_temp.listener('qorperaos/agents/builder/todos/stopped-one.md', clock_timestamp() + interval '2 days');
begin
	perform pg_temp.path_claims('service_role');
	v_wake := extensions.gen_random_uuid();
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id,
		environment_id, staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256,
		created_by_user_id)
		select routine_id, 2, extensions.gen_random_uuid(), profile_id, environment_id, staff_agent_id, title, prompt, triggers,
			effort, sponsor_binding_id, sponsor_version, repeat('f', 64), created_by_user_id
		from public.qorpera_cloud_routine_versions where routine_id = %L and version = 1$f$, v_routine));
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set current_version = 2 where id = %L', v_routine));
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id,
		client_job_id, required_capability, job_type, payload, created_by_user_id, status, run_id, cancelled_at, cancelled_by_user_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
			extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '63400000-0000-4000-8000-000000000002', 'cancelled', %L,
			clock_timestamp(), '63400000-0000-4000-8000-000000000002')$f$, v_job, v_run));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id,
		job_id, substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version,
		required_capability, job_type, payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id,
		model_provider, model_id, model_selection, audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'wake', %L, %L,
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63400000-0000-4000-8000-0000000000a1', 1,
			'63400000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			'63400000-0000-4000-8000-000000000002', '63400000-0000-4000-8000-000000000002', 'openai', 'gpt-test',
			'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}')$f$, v_run, v_wake, v_job));
	perform pg_temp.fx(format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id,
		routine_version, trigger_id, occurrence_key, scheduled_for, not_before, payload, status, run_id, finished_at)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', %L, 1, 't1', 'once:1:1',
			clock_timestamp(), clock_timestamp(), '{}', 'failed', %L, clock_timestamp())$f$, v_wake, v_routine, v_run));
	if not public.qorpera_routine_listening(
			(select r from public.qorpera_cloud_routines r where r.id = v_routine),
			(select triggers -> 0 from public.qorpera_cloud_routine_versions where routine_id = v_routine and version = 2)) then
		raise exception 'Version 2 still listens'; end if;
	if not pg_temp.listed(v_routine) or pg_temp.restore(v_routine, 2) ->> 'status' <> 'stopped'
		or (select status || '/' || pause_reason from public.qorpera_cloud_routines where id = v_routine) <> 'paused/member'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine and routine_version = 2) then
		raise exception 'A member''s Stop pauses a listening routine at once'; end if;
end $$;

-- 4c. The lookups can use the folder key indexes (seq scans off: the fixture's tables are tiny).
do $$
declare v_plan text := ''; v_line text;
begin
	set local enable_seqscan = off;
	for v_line in execute $q$explain (costs off) select 1 from public.qorpera_runtime_agent_todos t
		where t.folder_environment_id = '63400000-0000-4000-8000-000000000020' and t.folder_path is not null
			and t.folder_retired_at is null
			and (public.qorpera_folder_key(t.folder_path)) collate "C" = 'qorperaos/agents/builder/todos/x.md' collate "C"$q$ loop
		v_plan := v_plan || v_line || E'\n'; end loop;
	if v_plan not like '%qorpera_runtime_agent_todos_folder_key%' then
		raise exception 'The todo lookup uses its folder key index: %', v_plan; end if;
	raise notice 'L1 todo lookup plan: %', v_plan;
	v_plan := '';
	for v_line in execute $q$explain (costs off) select 1 from public.qorpera_folder_human_task_index h
		where h.environment_id = '63400000-0000-4000-8000-000000000020'
			and h.folder_key = 'qorperaos/human-tasks/x.md' collate "C" and h.retired_at is null$q$ loop
		v_plan := v_plan || v_line || E'\n'; end loop;
	if v_plan not like '%qorpera_folder_human_task_index_key%' then
		raise exception 'The task lookup uses its folder key index: %', v_plan; end if;
	raise notice 'L1 task lookup plan: %', v_plan;
	reset enable_seqscan;
end $$;

-- 5. A dynamic routine without `after` is unchanged: its first run is queued for its `at`.
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_result jsonb; v_at timestamptz := date_trunc('second', clock_timestamp()) + interval '2 days';
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routine_versions set triggers = jsonb_build_array(jsonb_build_object(
		'id', 't1', 'kind', 'once', 'at', %L, 'timeZone', 'UTC')) where routine_id = %L$f$,
		to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_routine));
	if not pg_temp.listed(v_routine) then raise exception 'A plain dynamic routine is listed'; end if;
	v_result := pg_temp.restore(v_routine);
	if v_result ->> 'status' <> 'inserted' or (pg_temp.inserted(v_result)).not_before <> v_at
		or (pg_temp.inserted(v_result)).payload ? 'state' then
		raise exception 'A plain dynamic routine runs at its at: % / %', v_result, to_jsonb(pg_temp.inserted(v_result)); end if;
end $$;

rollback;
