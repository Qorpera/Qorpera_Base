-- An agent can page through all of its todos and workers (runtime review of
-- v106, 2026-09-25). Since v95 an agent may keep any number of todos and
-- workers, but manage_todo list showed only the first 32 and manage_worker
-- status the first 16: asking again returned the same page, so the rest of the
-- agent's own work was out of its reach.
-- * A page is a response size, not a limit. nextCursor continues after the
--   last item shown; moreTodos and moreWorkers count exactly what the same
--   filters still hold after this page.
-- * Pages run in creation order, newest first, keyed on (created_at, id).
--   Creation never changes, so a todo or worker that changes between two pages
--   keeps its place: nothing is skipped or shown twice. The former order (most
--   recently changed first, open ones first) moved an item every time it
--   changed, which no cursor can follow.
-- * Filters: state and search for todos; todoKey, workerKey, state and search
--   for workers. search is a case-insensitive text match in titles and keys.
-- * A todo in a listing shows its latest sixteen workers and counts the earlier
--   ones in moreWorkers; manage_worker status with its todoKey pages through all.
-- * qorpera_describe_agent_open_work counts a run's open work, so the prompt can
--   say how much there is without listing it.

create function pg_temp.page_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Listing page patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- The keyset of both listings, per agent.
create index qorpera_runtime_agent_todos_created on public.qorpera_runtime_agent_todos
	(profile_id, environment_id, staff_agent_id, created_at desc, id desc);
create index qorpera_runtime_workers_created on public.qorpera_runtime_workers
	(profile_id, environment_id, staff_agent_id, created_at desc, id desc);

-- A todo as a listing shows it: its latest sixteen workers, in the order they were
-- dispatched, and a count of the earlier ones, so one busy todo cannot swell a page.
create function public.qorpera_agent_todo_listing(p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	select (public.qorpera_agent_todo_view(p_todo) - 'workers')
		|| jsonb_build_object('workers', coalesce((select jsonb_agg(public.qorpera_worker_view(latest.worker, false)
				order by (latest.worker).created_at, (latest.worker).id)
			from (select worker from public.qorpera_runtime_workers worker where worker.todo_id = p_todo.id
				order by worker.created_at desc, worker.id desc limit 16) latest), '[]'::jsonb))
		|| coalesce((select jsonb_build_object('moreWorkers', count(*) - 16) from public.qorpera_runtime_workers worker
			where worker.todo_id = p_todo.id having count(*) > 16), '{}'::jsonb)
$$;

-- One page of the run's agent's todos. Without state, open and blocked todos
-- (all of them with includeClosed); a cursor is the last todo of the page before.
create function public.qorpera_agent_todo_page(p_run public.qorpera_execution_runs, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_states text[]; v_search text; v_after public.qorpera_runtime_agent_todos%rowtype;
	v_todos jsonb; v_more bigint; v_last uuid;
begin
	if exists (select 1 from jsonb_object_keys(p_request) key
			where key not in ('action','includeClosed','state','search','cursor'))
		or (p_request ? 'includeClosed' and jsonb_typeof(p_request -> 'includeClosed') <> 'boolean')
		or (p_request ? 'state' and (jsonb_typeof(p_request -> 'state') <> 'string'
			or p_request ->> 'state' not in ('open','blocked','done','cancelled')))
		or (p_request ? 'search' and (jsonb_typeof(p_request -> 'search') <> 'string'
			or octet_length(btrim(p_request ->> 'search')) not between 1 and 200 or (p_request ->> 'search') ~ '[[:cntrl:]]'))
		or (p_request ? 'cursor' and (jsonb_typeof(p_request -> 'cursor') <> 'string'
			or (p_request ->> 'cursor') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
		raise exception 'Todo request is invalid' using errcode = '22023'; end if;
	v_states := case when p_request ? 'state' then array[p_request ->> 'state']
		when coalesce((p_request ->> 'includeClosed')::boolean, false) then array['open','blocked','done','cancelled']
		else array['open','blocked'] end;
	v_search := lower(btrim(p_request ->> 'search'));
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_runtime_agent_todos todo
		where todo.id = (p_request ->> 'cursor')::uuid and todo.profile_id = p_run.profile_id
			and todo.environment_id = p_run.environment_id and todo.staff_agent_id = p_run.staff_agent_id;
		if not found then raise exception 'Todo cursor is unavailable; list again without it' using errcode = '22023'; end if;
	end if;
	with matching as (
		select todo from public.qorpera_runtime_agent_todos todo
		where todo.profile_id = p_run.profile_id and todo.environment_id = p_run.environment_id
			and todo.staff_agent_id = p_run.staff_agent_id and todo.state = any(v_states)
			and (v_search is null or strpos(lower(todo.title), v_search) > 0 or strpos(todo.todo_key, v_search) > 0)
			and (v_after.id is null or (todo.created_at, todo.id) < (v_after.created_at, v_after.id))),
	page as (select todo from matching order by (todo).created_at desc, (todo).id desc limit 32)
	select coalesce(jsonb_agg(public.qorpera_agent_todo_listing(page.todo) order by (page.todo).created_at desc, (page.todo).id desc),
			'[]'::jsonb),
		(select count(*) from matching) - count(*),
		(array_agg((page.todo).id order by (page.todo).created_at, (page.todo).id))[1]
	into v_todos, v_more, v_last from page;
	return jsonb_build_object('todos', v_todos, 'moreTodos', v_more, 'nextCursor', case when v_more > 0 then v_last end);
end
$$;

-- One page of the run's agent's workers. Without todoKey, those of open todos and
-- any changed in the last week; a cursor is the last worker of the page before.
create function public.qorpera_agent_worker_page(p_run public.qorpera_execution_runs, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_search text; v_after public.qorpera_runtime_workers%rowtype; v_workers jsonb; v_more bigint; v_last uuid;
begin
	if exists (select 1 from jsonb_object_keys(p_request) key
			where key not in ('action','todoKey','workerKey','state','search','cursor'))
		or (p_request ? 'todoKey' and coalesce(p_request ->> 'todoKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$')
		or (p_request ? 'workerKey' and (not p_request ? 'todoKey'
			or coalesce(p_request ->> 'workerKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'))
		or (p_request ? 'state' and (jsonb_typeof(p_request -> 'state') <> 'string'
			or p_request ->> 'state' not in ('active','blocked','succeeded','failed','cancelled')))
		or (p_request ? 'search' and (jsonb_typeof(p_request -> 'search') <> 'string'
			or octet_length(btrim(p_request ->> 'search')) not between 1 and 200 or (p_request ->> 'search') ~ '[[:cntrl:]]'))
		or (p_request ? 'cursor' and (jsonb_typeof(p_request -> 'cursor') <> 'string'
			or (p_request ->> 'cursor') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	v_search := lower(btrim(p_request ->> 'search'));
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_runtime_workers worker
		where worker.id = (p_request ->> 'cursor')::uuid and worker.profile_id = p_run.profile_id
			and worker.environment_id = p_run.environment_id and worker.staff_agent_id = p_run.staff_agent_id;
		if not found then raise exception 'Worker cursor is unavailable; ask for status again without it' using errcode = '22023'; end if;
	end if;
	with matching as (
		select worker, todo.todo_key from public.qorpera_runtime_workers worker
		join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
		where worker.profile_id = p_run.profile_id and worker.environment_id = p_run.environment_id
			and worker.staff_agent_id = p_run.staff_agent_id
			and (p_request ->> 'todoKey' is null or todo.todo_key = p_request ->> 'todoKey')
			and (p_request ->> 'workerKey' is null or worker.worker_key = p_request ->> 'workerKey')
			and (p_request ->> 'todoKey' is not null or todo.state in ('open','blocked')
				or worker.updated_at > clock_timestamp() - interval '7 days')
			and (p_request ->> 'state' is null or worker.state = p_request ->> 'state')
			and (v_search is null or strpos(lower(worker.title), v_search) > 0 or strpos(worker.worker_key, v_search) > 0)
			and (v_after.id is null or (worker.created_at, worker.id) < (v_after.created_at, v_after.id))),
	page as (select * from matching order by (worker).created_at desc, (worker).id desc limit 16)
	-- One named worker is shown in full; a listing keeps summaries short so many fit one result.
	select coalesce(jsonb_agg(public.qorpera_worker_view(page.worker, p_request ? 'workerKey')
				|| jsonb_build_object('todoKey', page.todo_key)
				|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, page.worker))
					from public.qorpera_coding_sessions session where session.worker_id = (page.worker).id), '{}'::jsonb)
			order by (page.worker).created_at desc, (page.worker).id desc), '[]'::jsonb),
		(select count(*) from matching) - count(*),
		(array_agg((page.worker).id order by (page.worker).created_at, (page.worker).id))[1]
	into v_workers, v_more, v_last from page;
	return jsonb_build_object('workers', v_workers, 'moreWorkers', v_more, 'nextCursor', case when v_more > 0 then v_last end);
end
$$;

select pg_temp.page_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$
		if exists (select 1 from jsonb_object_keys(p_request) key where key not in ('action','includeClosed'))
			or (p_request ? 'includeClosed' and jsonb_typeof(p_request -> 'includeClosed') <> 'boolean') then
			raise exception 'Todo request is invalid' using errcode = '22023'; end if;
		-- A page of thirty-two, open todos first; the rest are counted in moreTodos (runtime v95).
		return jsonb_build_object('schema','qorpera.agent-todos/v1','runId',v_run.id,'todos',coalesce((
			select jsonb_agg(public.qorpera_agent_todo_view(todo) order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))
				order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id limit 32) todo), '[]'::jsonb),
			'moreTodos',greatest((select count(*) from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))) - 32, 0),
$old$,
	$new$
		-- A page of thirty-two in creation order, newest first; nextCursor continues it (see qorpera_agent_todo_page).
		return jsonb_build_object('schema','qorpera.agent-todos/v1','runId',v_run.id)
			|| public.qorpera_agent_todo_page(v_run, p_request) || jsonb_build_object(
$new$);
select pg_temp.page_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$
		if exists (select 1 from jsonb_object_keys(p_request) key where key not in ('action','todoKey','workerKey'))
			or (p_request ? 'todoKey' and coalesce(p_request ->> 'todoKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$')
			or (p_request ? 'workerKey' and (not p_request ? 'todoKey'
				or coalesce(p_request ->> 'workerKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$')) then
			raise exception 'Worker request is invalid' using errcode = '22023'; end if;
		-- A page of sixteen, active and blocked workers first; the rest are counted in moreWorkers, never silently
		-- dropped (runtime v95: an agent may run any number of workers).
		return (select jsonb_build_object('schema','qorpera.agent-workers/v1','runId',v_run.id,'workers',coalesce(
			-- One named worker is shown in full; a listing keeps summaries short so many fit one result.
			jsonb_agg(public.qorpera_worker_view(listed.worker, p_request ? 'workerKey') || jsonb_build_object('todoKey', listed.todo_key)
				|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, listed.worker))
					from public.qorpera_coding_sessions session where session.worker_id = (listed.worker).id), '{}'::jsonb)
				order by (listed.worker).state in ('active','blocked') desc, (listed.worker).updated_at desc, (listed.worker).id), '[]'::jsonb),
			'moreWorkers', coalesce(max(listed.total), 0) - count(*))
		from (
				select worker, todo.todo_key, count(*) over () as total from public.qorpera_runtime_workers worker
				join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
				where worker.profile_id = v_run.profile_id and worker.environment_id = v_run.environment_id
					and worker.staff_agent_id = v_run.staff_agent_id
					and (p_request ->> 'todoKey' is null or todo.todo_key = p_request ->> 'todoKey')
					and (p_request ->> 'workerKey' is null or worker.worker_key = p_request ->> 'workerKey')
					and (p_request ->> 'todoKey' is not null or todo.state in ('open','blocked')
						or worker.updated_at > clock_timestamp() - interval '7 days')
				order by worker.state in ('active','blocked') desc, worker.updated_at desc, worker.id limit 16) listed);
$old$,
	$new$
		-- A page of sixteen in creation order, newest first; nextCursor continues it (see qorpera_agent_worker_page).
		return jsonb_build_object('schema','qorpera.agent-workers/v1','runId',v_run.id)
			|| public.qorpera_agent_worker_page(v_run, p_request);
$new$);

-- How much open work the run's agent has, for its prompt: counts only, never the list.
-- Workers count while their todo is open, so a blocked worker of a closed todo does not linger.
create function public.qorpera_describe_agent_open_work(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_actor jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if v_run.staff_agent_id is null or v_run.audience_kind <> 'company' or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Todo authority is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.agent-open-work/v1','runId',v_run.id,
		'todos',(select jsonb_build_object('open',count(*) filter (where todo.state = 'open'),
				'blocked',count(*) filter (where todo.state = 'blocked'))
			from public.qorpera_runtime_agent_todos todo
			where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
				and todo.staff_agent_id = v_run.staff_agent_id and todo.state in ('open','blocked')),
		'workers',(select jsonb_build_object('active',count(*) filter (where worker.state = 'active'),
				'blocked',count(*) filter (where worker.state = 'blocked'))
			from public.qorpera_runtime_workers worker join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
			where worker.profile_id = v_run.profile_id and worker.environment_id = v_run.environment_id
				and worker.staff_agent_id = v_run.staff_agent_id and worker.state in ('active','blocked')
				and todo.state in ('open','blocked')));
end
$$;

revoke all on function public.qorpera_agent_todo_listing(public.qorpera_runtime_agent_todos),
	public.qorpera_agent_todo_page(public.qorpera_execution_runs, jsonb),
	public.qorpera_agent_worker_page(public.qorpera_execution_runs, jsonb),
	public.qorpera_describe_agent_open_work(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_describe_agent_open_work(jsonb) to service_role;

-- The patched functions keep their owners; those owners call the new helpers.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_manage_agent_todo(jsonb, jsonb)'::regprocedure,
		'public.qorpera_manage_agent_worker(jsonb, jsonb)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Listing function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_agent_todo_page(public.qorpera_execution_runs, jsonb),
			public.qorpera_agent_worker_page(public.qorpera_execution_runs, jsonb) to %I', v_owner);
	end loop;
end $$;
