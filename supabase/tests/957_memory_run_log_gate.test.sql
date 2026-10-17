-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Run logs only for runs recorded in the beta (Shared context): the gate W1c-3 made on the operator's test list
-- (20260930352000), by the run's memory mode since C5 (20260930508000), kept until an explicit product decision. Test
-- 924's run of Alice's, made while its company had Agent notebooks: its log's place answers off, and goes on answering
-- off once the company is on the test list and chose the beta, since a run keeps the mode it was made with. A run
-- recorded in the beta is placed in its conversation's tree, also once its company left the beta; a run made before C5
-- (no mode) is off. A run with no conversation tree, or one the place does not know, keeps no log: off in either mode.
-- A log already made goes on in either mode, and only a log made once and no longer there answers gone. The place is
-- still the platform's alone.

create function pg_temp.lg_run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.lg_place(p_run uuid default null) returns jsonb language sql as $$
	select public.qorpera_memory_run_log_place('92400000-0000-4000-8000-000000000020', coalesce(p_run, (pg_temp.lg_run()).id))
$$;
-- The company in the beta (on the test list, Shared context chosen), or in neither.
create function pg_temp.lg_beta(p_on boolean) returns void language plpgsql as $$
begin
	if p_on then
		insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
		insert into public.qorpera_company_memory_modes(profile_id, mode) values ('92400000-0000-4000-8000-000000000010', 'tree');
	else
		delete from public.qorpera_company_memory_modes where profile_id = '92400000-0000-4000-8000-000000000010';
		delete from public.qorpera_memory_tree_companies where profile_id = '92400000-0000-4000-8000-000000000010';
	end if;
end
$$;
-- Alice's run as if it was made in another mode (a run's mode never changes): with triggers off.
create function pg_temp.lg_mode(p_mode text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set memory_mode = p_mode where id = (pg_temp.lg_run()).id;
	set local session_replication_role = origin;
end
$$;

-- 1. The place is the platform's alone, and the gate names both migrations.
do $$
declare v_role text; v_src text := (select prosrc from pg_proc where oid = 'public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure);
begin
	foreach v_role in array array['anon', 'authenticated'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_memory_run_log_place(uuid,uuid)', 'EXECUTE'),
			'the place is open to ' || v_role);
	end loop;
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_memory_run_log_place(uuid,uuid)', 'EXECUTE'),
		'the platform can place a log');
	perform pg_temp.base_assert(strpos(v_src, '20260930352000') > 0 and strpos(v_src, '20260930508000') > 0,
		'the gate is in the place');
	perform pg_temp.base_assert(strpos(v_src, 'qorpera_memory_tree_companies') = 0, 'the place reads the run''s mode, not the list');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_log_place(%L, %L)', '92400000-0000-4000-8000-000000000020',
		(pg_temp.lg_run()).id), '42501', 'Folder core authority is required');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 2. A notebook run is off, also once its company chose the beta; a run recorded in the beta is placed, also once its
--    company left it; a run made before C5 is off. A run the place does not know keeps no log: off in either mode.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.lg_run(); v_place jsonb;
begin
	perform pg_temp.base_assert(v_run.memory_mode = 'notebooks', 'Alice''s run was made with Agent notebooks: '
		|| coalesce(v_run.memory_mode, 'no mode'));
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb, 'a notebook run is off: ' || pg_temp.lg_place()::text);
	perform pg_temp.base_assert(pg_temp.lg_place(extensions.gen_random_uuid()) = '{"off":true}'::jsonb,
		'a run the place does not know is off, not gone');
	perform pg_temp.lg_beta(true);
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb, 'a notebook run stays off when its company chooses the beta: '
		|| pg_temp.lg_place()::text);
	perform pg_temp.lg_mode('tree');
	v_place := pg_temp.lg_place();
	perform pg_temp.base_assert(not v_place ? 'off' and v_place ->> 'exists' = 'false' and v_place ->> 'gone' = 'false'
		and v_place ->> 'path' = 'agents/alice/memory/thread/runs/' || v_run.id
		and v_place #>> '{origin,conversation}' = v_run.session_id::text,
		'a beta run is placed in its conversation''s tree: ' || v_place::text);
	perform pg_temp.base_assert(pg_temp.lg_place(extensions.gen_random_uuid()) = '{"off":true}'::jsonb,
		'a run the place does not know is still off');
	perform pg_temp.lg_beta(false);
	perform pg_temp.base_assert(pg_temp.lg_place() = v_place, 'a beta run keeps its place when its company leaves the beta: '
		|| pg_temp.lg_place()::text);
	perform pg_temp.lg_mode(null);
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb, 'a run made before C5 is off');
	perform pg_temp.lg_mode('notebooks');
end
$$;

-- 3. A beta run whose conversation has no tree keeps no log: off, not gone. The room goes for this block alone (its error
--    undoes it), with triggers off so nothing else moves.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.lg_run();
begin
	perform pg_temp.lg_mode('tree');
	begin
		set local session_replication_role = replica;
		update public.qorpera_company_rooms set session_id = extensions.gen_random_uuid() where session_id = v_run.session_id;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb,
			'a beta run with no conversation tree is off: ' || pg_temp.lg_place()::text);
		raise exception 'undo the room' using errcode = 'QG957';
	exception when sqlstate 'QG957' then null;
	end;
	perform pg_temp.base_assert(pg_temp.lg_place() ->> 'path' = 'agents/alice/memory/thread/runs/' || v_run.id,
		'the room is back: ' || pg_temp.lg_place()::text);
	perform pg_temp.lg_mode('notebooks');
end
$$;

-- 4. A log already made goes on for a notebook run (a run made before C5 in a listed company kept one); a log made once
--    and no longer there is gone, in either mode.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.lg_run(); v_place jsonb;
begin
	-- The run's log, as its runtime's first batch indexes runs/<run>/run.toml and marks the generation row.
	insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
	values (v_run.environment_id, v_run.id, v_run.session_id, 'agents/alice/memory/thread/runs/' || v_run.id,
		'agents/alice/memory/thread/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
	insert into public.qorpera_memory_run_generations(environment_id, run_id, log_created_at)
	values (v_run.environment_id, v_run.id, clock_timestamp());
	v_place := pg_temp.lg_place();
	perform pg_temp.base_assert(v_place ->> 'exists' = 'true' and v_place ->> 'gone' = 'false' and not v_place ? 'off'
		and v_place ->> 'path' = 'agents/alice/memory/thread/runs/' || v_run.id,
		'a notebook run''s live log goes on: ' || v_place::text);
	update public.qorpera_memory_run_logs set retired_at = clock_timestamp() where run_id = v_run.id;
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a retired log is gone, not off');
	perform pg_temp.lg_mode('tree');
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a beta run''s retired log is gone');
	perform pg_temp.lg_mode('notebooks');
	-- Made once (the generation row keeps when), and its log row is no longer there.
	delete from public.qorpera_memory_run_logs where run_id = v_run.id;
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a log made once is gone, not off');
end
$$;
