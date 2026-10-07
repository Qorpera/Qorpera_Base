-- The worker tools on folder-v2, two corrections from F2-5b-4's review (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
-- §8 "Plan (F2-5b)" §3 and §7). Every patched body carries the marker 20260930075000.
--
-- 1. A follow-up names the results it removes. Its change set writes the brief, then deletes results.md at the version
--    the tool read. A decision that landed in between left the brief saved and the delete a conflict, which the verify
--    step then refused as a defect (XX000), rolling back the commit under a receipt that stayed open. The request now
--    carries `resultsVersion` (the version read, or null when there were none), and the brief is a `version_changed`
--    conflict when the worker's results are no longer those: the worker row is locked at rank 5 by the commit, so a
--    decision and a follow-up meet there. Nothing of such a change set is saved, and the tool answers a conflict.
-- 2. Status lists one todo's workers a page at a time: at most 16, newest first, after `cursor` (a worker id the last
--    page ended on), filtered in SQL by `workerKey`, `state` (active covers queued and running) and `search` (a title or
--    a key, any case), with `moreWorkers` and `nextCursor`. A todo with many workers no longer outgrows one answer.

set local lock_timeout = '3s';

create function pg_temp.f25b4_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'F2-5b-4 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The follow-up's request and rule ------------------------------------------------------------------------------------

select pg_temp.f25b4_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$		when 'followup' then array['action','folder','text']$old$,
	$new$		-- 20260930075000: the results the follow-up removes, as the tool read them (null: none).
		when 'followup' then array['action','folder','resultsVersion','text']$new$);
select pg_temp.f25b4_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$		or (v_action = 'followup' and jsonb_typeof(p_request -> 'text') <> 'string')$old$,
	$new$		or (v_action = 'followup' and (jsonb_typeof(p_request -> 'text') <> 'string'
			or (jsonb_typeof(p_request -> 'resultsVersion') <> 'null' and coalesce(p_request ->> 'resultsVersion', '')
				!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))$new$);

select pg_temp.f25b4_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$		elsif v_action = 'followup' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			if not v_brief or v_base is null then$old$,
	$new$		elsif v_action = 'followup' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			-- 20260930075000: the results it removes are the worker's now (the row is locked at rank 5); a decision that
			-- landed since the tool read them makes the whole follow-up a conflict, never a half-saved change set.
			if v_brief and v_worker.folder_results_version is distinct from (v_request ->> 'resultsVersion')::uuid then
				return jsonb_build_object('ok', false, 'reason', 'version_changed'); end if;
			if not v_brief or v_base is null then$new$);

-- 2. Status, filtered and paged --------------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_agent_workers(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_auth jsonb; v_profile uuid; v_staff uuid; v_folder text; v_todo public.qorpera_runtime_agent_todos%rowtype;
	v_after public.qorpera_runtime_workers%rowtype; v_rows public.qorpera_runtime_workers[]; v_search text; v_more bigint;
	c_page constant integer := 16;
begin
	-- 20260928469130 (F2-5b-2), 20260930075000: filters and pages.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth -> 'audience' ->> 'kind' is distinct from 'company'
		or (public.qorpera_run_worker((p_actor ->> 'runId')::uuid)).id is not null then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) k where k not in ('todoKey','workerKey','state','search','cursor'))
		or coalesce(p_request ->> 'todoKey', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
		or (p_request ? 'workerKey' and coalesce(p_request ->> 'workerKey', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$')
		or (p_request ? 'state' and coalesce(p_request ->> 'state', '') not in ('active','blocked','succeeded','failed','cancelled'))
		or (p_request ? 'search' and (jsonb_typeof(p_request -> 'search') is distinct from 'string'
			or char_length(btrim(p_request ->> 'search')) not between 1 and 200))
		or (p_request ? 'cursor' and coalesce(p_request ->> 'cursor', '')
			!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	v_staff := (v_auth ->> 'staffAgentId')::uuid;
	v_folder := public.qorpera_company_state_run_folder(p_environment_id, v_staff, '{}'::uuid[]) ->> 'agent';
	select * into v_todo from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
		and t.folder_retired_at is null and t.staff_agent_id = v_staff
		and public.qorpera_folder_key(t.folder_path)
			= public.qorpera_folder_key('agents/' || v_folder || '/todos/' || (p_request ->> 'todoKey') || '.md');
	if v_folder is null or v_todo.id is null
		or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, v_todo.folder_path, 'read') then
		raise exception 'Todo is unavailable' using errcode = 'P0002'; end if;
	-- The cursor is a worker of this todo the last page ended on, wherever the filters leave it.
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_runtime_workers w
		where w.id = (p_request ->> 'cursor')::uuid and w.todo_id = v_todo.id;
		if v_after.id is null then
			raise exception 'Worker cursor is unavailable; list again without it' using errcode = 'P0002'; end if;
	end if;
	v_search := lower(btrim(p_request ->> 'search'));
	v_rows := array(select w from public.qorpera_runtime_workers w
		where w.todo_id = v_todo.id and w.folder_path is not null and w.folder_retired_at is null
			and (not p_request ? 'workerKey' or w.worker_key = p_request ->> 'workerKey')
			and (not p_request ? 'state' or w.state = p_request ->> 'state')
			and (v_search is null or strpos(lower(w.title), v_search) > 0 or strpos(lower(w.worker_key), v_search) > 0)
			and (v_after.id is null or (w.created_at, w.id) < (v_after.created_at, v_after.id))
		order by w.created_at desc, w.id desc limit c_page + 1);
	v_more := greatest(cardinality(v_rows) - c_page, 0);
	if v_more > 0 then
		-- How many more after this page, in all.
		select count(*) into v_more from public.qorpera_runtime_workers w
		where w.todo_id = v_todo.id and w.folder_path is not null and w.folder_retired_at is null
			and (not p_request ? 'workerKey' or w.worker_key = p_request ->> 'workerKey')
			and (not p_request ? 'state' or w.state = p_request ->> 'state')
			and (v_search is null or strpos(lower(w.title), v_search) > 0 or strpos(lower(w.worker_key), v_search) > 0)
			and (w.created_at, w.id) < ((v_rows[c_page]).created_at, (v_rows[c_page]).id);
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-agent-workers/v1', 'todoKey', p_request ->> 'todoKey',
		'workers', coalesce((select jsonb_agg(public.qorpera_worker_view(v_rows[i], false)
			|| jsonb_build_object('folder', (v_rows[i]).folder_path, 'cursor', (v_rows[i]).id) order by i)
			from generate_series(1, least(cardinality(v_rows), c_page)) i), '[]'::jsonb),
		'moreWorkers', v_more,
		'nextCursor', case when v_more > 0 then to_jsonb((v_rows[c_page]).id) else 'null'::jsonb end);
end $$;
