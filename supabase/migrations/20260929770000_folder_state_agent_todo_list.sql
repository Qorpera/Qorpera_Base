-- Company state files, thin writers W1: a folder-v2 run's own todos from the todo index
-- (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Built (W1)").
--
-- manage_todo's list on a folder-v2 company reads the index of the agent's todo files: qorpera_runtime_agent_todos
-- rows with a folder path (F2-5a, 20260928259210), which the folder core's commit updates in the same transaction as
-- the files, so the index is exactly as fresh as they are. One plain read, paged as today's list (32 a page, newest
-- first, the same filters and cursor), in place of a file read per todo: the coordinator's ruling of 2026-10-01
-- (registry), which F1 may overrule. A todo's whole content is read from its file, through the folder client.
-- Inert: only a folder-v2 run reaches it, and none exists before C1c-3.

-- A folder-v2 run's own todos, as an index page: the run's plain check (qorpera_folder_read_actor: no job, run mutex or
-- fence lock; a paused company's run is refused, as for any folder read), a company run that is not a worker, and its
-- read authority on its todos folder. Files that were deleted (retired rows, keyed by a tombstone) are not listed.
create function public.qorpera_folder_agent_todos(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_auth jsonb; v_profile uuid; v_staff uuid; v_folder text; v_states text[]; v_search text;
	v_after public.qorpera_runtime_agent_todos%rowtype; v_todos jsonb; v_more bigint; v_last uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Todo authority is unavailable' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth -> 'audience' ->> 'kind' is distinct from 'company'
		or (public.qorpera_run_worker((p_actor ->> 'runId')::uuid)).id is not null then
		raise exception 'Todo authority is unavailable' using errcode = '42501'; end if;
	select profile_id into v_profile from public.qorpera_company_files
	where environment_id = p_environment_id and core = 'folder-v2';
	v_staff := (v_auth ->> 'staffAgentId')::uuid;
	v_folder := public.qorpera_company_state_run_folder(p_environment_id, v_staff, '{}'::uuid[]) ->> 'agent';
	if v_folder is null or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth,
			'agents/' || v_folder || '/todos', 'read') then
		raise exception 'Todo authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) key where key not in ('includeClosed','state','search','cursor'))
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
		where todo.id = (p_request ->> 'cursor')::uuid and todo.profile_id = v_profile
			and todo.environment_id = p_environment_id and todo.staff_agent_id = v_staff
			and todo.folder_path is not null and todo.folder_retired_at is null;
		if not found then raise exception 'Todo cursor is unavailable; list again without it' using errcode = '22023'; end if;
	end if;
	-- Only the keyset is kept for counting; whole rows are read for the page alone.
	with matching as (
		select todo.id, todo.created_at from public.qorpera_runtime_agent_todos todo
		where todo.profile_id = v_profile and todo.environment_id = p_environment_id and todo.staff_agent_id = v_staff
			and todo.folder_path is not null and todo.folder_retired_at is null and todo.state = any(v_states)
			and (v_search is null or strpos(lower(todo.title), v_search) > 0 or strpos(todo.todo_key, v_search) > 0)
			and (v_after.id is null or (todo.created_at, todo.id) < (v_after.created_at, v_after.id))),
	page as (select * from matching order by created_at desc, id desc limit 32)
	select coalesce(jsonb_agg(jsonb_build_object('todoKey', todo.todo_key, 'title', todo.title, 'state', todo.state,
				'detail', left(todo.detail, 200), 'path', todo.folder_path, 'version', todo.folder_path_version,
				'updatedAt', todo.updated_at, 'cursor', todo.id)
			|| case when char_length(todo.detail) > 200 then '{"detailTruncated":true}'::jsonb else '{}'::jsonb end
			order by page.created_at desc, page.id desc), '[]'::jsonb),
		(select count(*) from matching) - count(*),
		(array_agg(page.id order by page.created_at, page.id))[1]
	into v_todos, v_more, v_last
	from page join public.qorpera_runtime_agent_todos todo on todo.id = page.id;
	return jsonb_build_object('schema', 'qorpera.folder-agent-todos/v1', 'todos', v_todos, 'moreTodos', v_more,
		'nextCursor', case when v_more > 0 then v_last end);
end $$;

revoke all on function public.qorpera_folder_agent_todos(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_agent_todos(uuid, jsonb, jsonb) to service_role;
