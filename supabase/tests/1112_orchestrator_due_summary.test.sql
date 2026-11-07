-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930612000: qorpera_orchestrator_due_summary answers an orchestrator's idle pass in one call: each of the ten lists
-- the pass would ask, by name. It is the control plane's call alone. Its answers come from the lists themselves (a post
-- makes the materializer's true through the real list), and each answer reads its own list, first page of one.

create function pg_temp.ds_summary() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_orchestrator_due_summary();
end $$;
create table pg_temp.ds_lists (key text primary key, fn regproc not null);
insert into pg_temp.ds_lists values
	('workers', 'public.qorpera_folder_workers_due'),
	('listen', 'public.qorpera_folder_listen_due'),
	('human_tasks', 'public.qorpera_folder_human_tasks_due'),
	('machine_events', 'public.qorpera_folder_machine_events_due'),
	('office_wakes', 'public.qorpera_folder_office_wakes_due'),
	('machine_checkins', 'public.qorpera_folder_machine_checkins_due'),
	('coding_checkins', 'public.qorpera_folder_coding_checkins_due'),
	('events', 'public.qorpera_folder_event_wakes_due'),
	('materialize', 'public.qorpera_folder_materialize_due'),
	('routine_heads', 'public.qorpera_list_routine_schedule_heads');
-- Replaces a list: it has an item only when asked for the first page of one, so a caller that reads any other page
-- would see nothing.
create function pg_temp.ds_stub(p_fn regproc, p_due boolean) returns void language plpgsql as $$
begin
	execute format('create or replace function %s(%s) returns jsonb language sql stable as %L', p_fn,
		pg_get_function_arguments(p_fn),
		format('select jsonb_build_object(''items'', case when $1 is null and $2 = 1 and %L then ''[{"x":1}]''::jsonb else ''[]''::jsonb end, ''has_more'', false)',
			p_due));
end $$;

-- Who may call it: only the service role, by grant and by claim.
do $$
declare v_fn constant text := 'public.qorpera_orchestrator_due_summary()';
begin
	perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'EXECUTE')
		and not has_function_privilege('authenticated', v_fn, 'EXECUTE')
		and has_function_privilege('service_role', v_fn, 'EXECUTE'), 'the summary is the control plane''s call');
	perform pg_temp.base_assert((select provolatile = 's' and prosecdef and proconfig = array['search_path=""']
		from pg_proc where oid = v_fn::regprocedure), 'the summary reads only, with a fixed search path');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error($q$select public.qorpera_orchestrator_due_summary()$q$, '42501');
end $$;

-- Its answers are the real lists' answers, and a post makes the materializer's true through the real list.
do $$
declare v_summary jsonb := pg_temp.ds_summary(); v_list record; v_page jsonb;
begin
	perform pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(v_summary) as key)
		= (select array_agg(key order by key) from pg_temp.ds_lists), 'one answer per list: ' || v_summary::text);
	for v_list in select * from pg_temp.ds_lists loop
		execute format('select %s(null, 1)', v_list.fn) into v_page;
		perform pg_temp.base_assert((v_summary ->> v_list.key)::boolean = (v_page -> 'items' <> '[]'::jsonb),
			v_list.key || ' answers as its list does: ' || v_summary::text || ' ' || v_page::text);
	end loop;
	perform pg_temp.base_assert(not (v_summary ->> 'materialize')::boolean, 'nothing to materialize yet: ' || v_summary::text);
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Hello Bob.');
	v_summary := pg_temp.ds_summary();
	perform pg_temp.base_assert((v_summary ->> 'materialize')::boolean, 'a post is due: ' || v_summary::text);
end $$;

-- Each answer reads its own list, and a list's error is the call's error (the orchestrator then asks the lists one by one).
do $$
declare v_list record; v_other record; v_summary jsonb;
begin
	for v_list in select * from pg_temp.ds_lists loop perform pg_temp.ds_stub(v_list.fn, false); end loop;
	v_summary := pg_temp.ds_summary();
	perform pg_temp.base_assert((select bool_and(not (v_summary ->> key)::boolean) from pg_temp.ds_lists),
		'all quiet: ' || v_summary::text);
	for v_list in select * from pg_temp.ds_lists loop
		perform pg_temp.ds_stub(v_list.fn, true);
		v_summary := pg_temp.ds_summary();
		for v_other in select * from pg_temp.ds_lists loop
			perform pg_temp.base_assert((v_summary ->> v_other.key)::boolean = (v_other.key = v_list.key),
				v_list.key || ' due shows on its own name only: ' || v_summary::text);
		end loop;
		perform pg_temp.ds_stub(v_list.fn, false);
	end loop;
	execute format('create or replace function %s(%s) returns jsonb language plpgsql stable as %L',
		'public.qorpera_folder_listen_due'::regproc, pg_get_function_arguments('public.qorpera_folder_listen_due'::regproc),
		$body$begin raise exception 'list down' using errcode = 'P1112'; end$body$);
	perform pg_temp.base_error($q$select public.qorpera_orchestrator_due_summary()$q$, 'P1112');
end $$;

rollback;
