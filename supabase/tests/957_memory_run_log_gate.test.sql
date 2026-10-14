-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Context tree W1c-3 (20260930352000): run logs turn on only for the companies in qorpera_memory_tree_companies, until
-- W1d (erasure of work) is live. Test 924's run of Alice's: while its company is not on the list, the log's place
-- answers off; once it is, the place answers where the new log goes. A log already made goes on when the company leaves
-- the list, and a log made once and no longer there answers gone, listed or not. A run the place does not know answers
-- gone, never off. The place is still the platform's alone.

create function pg_temp.lg_run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.lg_place(p_run uuid default null) returns jsonb language sql as $$
	select public.qorpera_memory_run_log_place('92400000-0000-4000-8000-000000000020', coalesce(p_run, (pg_temp.lg_run()).id))
$$;
create function pg_temp.lg_list(p_on boolean) returns void language plpgsql as $$
begin
	if p_on then
		insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
	else
		delete from public.qorpera_memory_tree_companies where profile_id = '92400000-0000-4000-8000-000000000010';
	end if;
end
$$;

-- 1. The place is the platform's alone, and the gate names its migration.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_memory_run_log_place(uuid,uuid)', 'EXECUTE'),
			'the place is open to ' || v_role);
	end loop;
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_memory_run_log_place(uuid,uuid)', 'EXECUTE'),
		'the platform can place a log');
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure), '20260930352000') > 0, 'the gate is in the place');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_log_place(%L, %L)', '92400000-0000-4000-8000-000000000020',
		(pg_temp.lg_run()).id), '42501', 'Folder core authority is required');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 2. Off while the company is not on the list; where the new log goes once it is; off again when it leaves before a log
--    is made. A run the place does not know answers gone.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.lg_run(); v_place jsonb;
begin
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_memory_tree_companies
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'the base company is not on the list');
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb, 'an unlisted company''s run is off: '
		|| pg_temp.lg_place()::text);
	perform pg_temp.base_assert(pg_temp.lg_place(extensions.gen_random_uuid()) = '{"gone":true}'::jsonb,
		'a run the place does not know is gone, not off');
	perform pg_temp.lg_list(true);
	v_place := pg_temp.lg_place();
	perform pg_temp.base_assert(not v_place ? 'off' and v_place ->> 'exists' = 'false' and v_place ->> 'gone' = 'false'
		and v_place ->> 'path' = 'agents/alice/memory/thread/runs/' || v_run.id
		and v_place #>> '{origin,conversation}' = v_run.session_id::text,
		'a listed company''s run is placed in its conversation''s tree: ' || v_place::text);
	perform pg_temp.base_assert(pg_temp.lg_place(extensions.gen_random_uuid()) = '{"gone":true}'::jsonb,
		'a run the place does not know is still gone');
	perform pg_temp.lg_list(false);
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"off":true}'::jsonb, 'off again when the company leaves the list');
end
$$;

-- 3. A log already made goes on when its company is not on the list; a log made once and no longer there is gone, listed
--    or not.
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
		'an unlisted company''s live log goes on: ' || v_place::text);
	update public.qorpera_memory_run_logs set retired_at = clock_timestamp() where run_id = v_run.id;
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a retired log is gone, not off');
	perform pg_temp.lg_list(true);
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a retired log is gone when listed');
	perform pg_temp.lg_list(false);
	-- Made once (the generation row keeps when), and its log row is no longer there.
	delete from public.qorpera_memory_run_logs where run_id = v_run.id;
	perform pg_temp.base_assert(pg_temp.lg_place() = '{"gone":true}'::jsonb, 'a log made once is gone, not off');
end
$$;
