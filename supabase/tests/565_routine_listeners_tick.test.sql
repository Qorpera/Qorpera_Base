-- @fixture 656_folder_core_run_wakes.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Listener routines, L1 (20260930565000; deploy/first-node/RUNTIME-LISTENER-ROUTINES.md): the folder tick holds a
-- dynamic routine's first run back while its `after` todo or human task is still open and its `at` is ahead, then
-- starts it at once when nothing open is left there (done, cancelled, declined, deleted) or when `at` comes. The run's
-- payload says what it waited for and whether that is done. A dynamic routine without `after` is unchanged. The
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
		or v_wake.payload ->> 'after' <> 'qorperaos/agents/builder/todos/landing-page.md' or v_wake.payload ->> 'done' <> 'true' then
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
	if v_result ->> 'status' <> 'inserted' or (pg_temp.inserted(v_result)).payload ->> 'done' <> 'false'
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
	foreach v_routine in array array[
		pg_temp.listener('qorperaos/agents/builder/todos/cancelled-one.md', clock_timestamp() + interval '2 days'),
		pg_temp.listener('qorperaos/agents/builder/todos/deleted-one.md', clock_timestamp() + interval '2 days'),
		pg_temp.listener('qorperaos/agents/builder/todos/never.md', clock_timestamp() + interval '2 days')] loop
		if not pg_temp.listed(v_routine) then raise exception 'Nothing open is left: % is due', v_routine; end if;
	end loop;
	v_routine := pg_temp.listener('qorperaos/human-tasks/sign.md', clock_timestamp() + interval '2 days');
	if pg_temp.listed(v_routine) then raise exception 'An open human task holds the run back'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'returned', v_task));
	if pg_temp.listed(v_routine) then raise exception 'A returned human task is open again'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set status = %L where id = %L', 'done', v_task));
	if not pg_temp.listed(v_routine) or (pg_temp.inserted(pg_temp.restore(v_routine))).payload ->> 'done' <> 'true' then
		raise exception 'A done human task lets the run come'; end if;
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
		or (pg_temp.inserted(v_result)).payload ? 'done' then
		raise exception 'A plain dynamic routine runs at its at: % / %', v_result, to_jsonb(pg_temp.inserted(v_result)); end if;
end $$;

rollback;
