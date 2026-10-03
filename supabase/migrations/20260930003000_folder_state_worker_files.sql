-- Company state files, F2-5b-2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)"): a worker's brief and
-- results as files on the folder core, with the worker row as their index. Without the wakes: the folder-v2 worker drain
-- (F2-5b-3) starts and revives workers, once C4's folder-v2 materializer calls it.
--
-- 1. Columns on qorpera_runtime_workers, as the roster's: the worker's folder, the versions of its two files, the commit
--    and the retirement. All null for snapshot-v1 rows, which keep every path they have.
-- 2. Who writes the files (§2): only the worker tools, through qorpera_folder_worker_commit, which carries the tool's
--    request into the commit in the transaction setting qorpera.folder_worker (bound to the environment, the run and
--    the operation key). The commit's actor is the run, so the receipt and the review stay inside the commit. Without a
--    request, a worker's files are written only by a restore of a retired worker, byte for byte as its row records them.
--    A carried report by the worker's own run passes authority (the read-only worker's ban included); the hook then
--    allows only its own results.md.
-- 3. The actions (§3): dispatch (the todo's folder and a new worker folder with brief.md), followup (brief.md with one
--    more follow-up; results.md removed), report and decide (results.md). Cancel and status are functions of their own.
-- 4. A todo with workers is never renamed, and its file goes only after its folder (§3a). A worker's folder moves only
--    with its agent's folder and goes only with a folder that holds it, never while a worker there is active.
-- 5. The index (§4): the row is written in apply from the files' parses; a move repoints it, a delete retires it, a
--    restore brings it back; verify checks each row this commit wrote.
-- 6. Locks (§5): rank 5 gains qorpera_runtime_agent_todos and qorpera_runtime_workers, after the routines. Every unit
--    that writes, moves or deletes a todo file takes its row FOR NO KEY UPDATE; a worker change takes its todo FOR SHARE
--    and its worker FOR NO KEY UPDATE. No company-wide lock.
-- Every patched body carries the marker 20260930003000 for the deploy guard.

-- A second run stops here, before anything changes.
do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_runtime_workers'::regclass
		and attname = 'folder_path' and not attisdropped) then
		raise exception 'F2-5b-2 (20260930003000) is already applied'; end if;
end $$;

-- 1. The index columns. Nullable and without defaults, so adding them rewrites nothing; the check is validated apart,
-- under a lock that leaves reads and writes alone.
alter table public.qorpera_runtime_workers
	add column folder_environment_id uuid,
	add column folder_path text,
	add column folder_key text,
	add column folder_brief_version uuid,
	add column folder_results_version uuid,
	add column folder_commit_id uuid,
	add column folder_retired_at timestamptz;
alter table public.qorpera_runtime_workers add constraint qorpera_runtime_workers_folder_check check (
	(folder_path is null) = (folder_environment_id is null) and (folder_path is null) = (folder_key is null)
	and (folder_path is null) = (folder_brief_version is null) and (folder_path is null) = (folder_commit_id is null)
	and (folder_path is not null or (folder_results_version is null and folder_retired_at is null))) not valid;
alter table public.qorpera_runtime_workers validate constraint qorpera_runtime_workers_folder_check;
create index qorpera_runtime_workers_folder on public.qorpera_runtime_workers(folder_environment_id, folder_key)
	where folder_path is not null;

-- 2. Helpers -----------------------------------------------------------------------------------------------------

-- The worker tool's request this transaction carries (§2), or null.
create function public.qorpera_folder_worker_request()
returns jsonb language sql stable set search_path = '' as $$
	select case when coalesce(current_setting('qorpera.folder_worker', true), '') = '' then null
		else current_setting('qorpera.folder_worker', true)::jsonb end
$$;
revoke all on function public.qorpera_folder_worker_request() from public, anon, authenticated, service_role;

-- The platform's standing texts of a brief (contract 13), exactly as qorpera_manage_agent_worker writes them.
create function public.qorpera_company_state_worker_standing(p_species text, p_access text, p_revival text)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object(
		'authority', case when p_species = 'coding'
				then 'Work only in the repository and branch the cloud selected. Company File sources are read-only context. Publication is a draft PR through the trusted path.'
			when p_access = 'write'
				then 'Read what this agent may read. Write only inside outputFolder, or where this agent already holds a write grant.'
			else 'Read what this agent may read. Write nothing.' end,
		'output', case when p_species = 'coding'
				then 'Finish through coding_finish with the commit to publish, or ask the owner through coding_ask when a decision is theirs.'
			else 'Report once through report_work: outcome, a summary the parent can act on, and the files you wrote.' end,
		'cancellation', 'Ends with its todo, or when the parent cancels it. A cancelled worker cannot report.',
		'completion', case when p_revival = 'each' then 'The parent is revived as soon as you report.'
			else 'The parent is revived once every worker it dispatched together has reported, or at once when you are blocked.' end)
$$;
revoke all on function public.qorpera_company_state_worker_standing(text, text, text) from public, anon, authenticated, service_role;

-- The worker folder a key is at or under (agents/<a>/todos/<t>/<w>), or null.
create function public.qorpera_company_state_worker_folder(p_key text)
returns text language sql immutable set search_path = '' as $$
	select case when split_part(p_key, '/', 1) = 'agents' and split_part(p_key, '/', 2) not in ('', 'groups', 'sections.md')
		and split_part(p_key, '/', 3) = 'todos' and split_part(p_key, '/', 4) <> '' and split_part(p_key, '/', 5) <> ''
		then array_to_string((string_to_array(p_key, '/'))[1:5], '/') end
$$;
revoke all on function public.qorpera_company_state_worker_folder(text) from public, anon, authenticated, service_role;

-- The todo file a worker folder belongs to: agents/<a>/todos/<t>/<w> gives agents/<a>/todos/<t>.md.
create function public.qorpera_company_state_worker_todo_file(p_folder_key text)
returns text language sql immutable set search_path = '' as $$
	select array_to_string((string_to_array(p_folder_key, '/'))[1:3], '/') || '/' || split_part(p_folder_key, '/', 4) || '.md'
$$;
revoke all on function public.qorpera_company_state_worker_todo_file(text) from public, anon, authenticated, service_role;

-- The worker row at a worker folder key: the live one, else the newest retired one (a todo deleted and written again
-- under its old name can leave retired rows at the same key).
create function public.qorpera_company_state_worker_at(p_environment_id uuid, p_folder_key text)
returns public.qorpera_runtime_workers language sql stable set search_path = '' as $$
	select w from public.qorpera_runtime_workers w
	where w.folder_environment_id = p_environment_id and w.folder_key = p_folder_key
	order by w.folder_retired_at is null desc, w.created_at desc limit 1
$$;
revoke all on function public.qorpera_company_state_worker_at(uuid, text) from public, anon, authenticated, service_role;

-- Whether a live worker sits at or under a key, active ones only when asked.
create function public.qorpera_company_state_workers_under(p_environment_id uuid, p_key text, p_active boolean)
returns boolean language sql stable set search_path = '' as $$
	select exists (select 1 from public.qorpera_runtime_workers w
		where w.folder_environment_id = p_environment_id and w.folder_retired_at is null
			and (w.folder_key = p_key or w.folder_key like public.qorpera_folder_under(p_key))
			and (not p_active or w.state = 'active'))
$$;
revoke all on function public.qorpera_company_state_workers_under(uuid, text, boolean) from public, anon, authenticated, service_role;

create function pg_temp.f25b_worker_files_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'F2-5b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 3. The guard, for every unit (§2, §3a): which units may touch a worker's folder and files. Returns a refusal or null.
create function public.qorpera_company_state_worker_paths(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_op text, p_key text, p_to_key text, p_unit jsonb, p_eff_path text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_request jsonb := public.qorpera_folder_worker_request(); v_action text; v_folder text; v_todo_folder text;
	v_place text; v_content record; v_problem text; v_kind text := public.qorpera_structured_path_kind(p_key); v_files text[];
begin
	if v_request is not null then
		-- A carried request belongs to this commit: its environment, run and operation key.
		if v_request ->> 'environmentId' is distinct from p_environment_id::text or p_actor ->> 'kind' is distinct from 'staff_agent'
			or v_request ->> 'runId' is distinct from p_actor ->> 'runId'
			or v_request ->> 'operationKey' is distinct from (select c.operation_key from public.qorpera_folder_commits c where c.id = p_commit_id) then
			v_problem := 'the worker tool''s request does not belong to this change';
		else
			-- A worker change holds only the units its action names.
			v_action := v_request ->> 'action';
			v_folder := public.qorpera_folder_key(v_request ->> 'folder');
			v_todo_folder := regexp_replace(v_folder, '/[^/]+$', '');
			if not ((v_action = 'dispatch' and ((p_op = 'mkdir' and p_key = v_todo_folder)
						or (p_op = 'new_folder' and p_key = v_folder and jsonb_array_length(p_unit -> 'contents') = 1
							and public.qorpera_folder_key(p_unit -> 'contents' -> 0 ->> 'path') = 'brief.md'
							and p_unit -> 'contents' -> 0 ->> 'kind' = 'file')))
					or (v_action = 'followup' and ((p_op = 'write' and p_key = v_folder || '/brief.md')
						-- A change set is not atomic: the results go only after this commit's brief landed.
						or (p_op = 'delete' and p_key = v_folder || '/results.md'
							and (public.qorpera_company_state_worker_at(p_environment_id, v_folder)).folder_commit_id = p_commit_id)))
					or (v_action in ('report','decide') and p_op = 'write' and p_key = v_folder || '/results.md')) then
				v_problem := 'a worker''s change holds only its own files';
			end if;
		end if;
	elsif p_op in ('new_folder','mkdir') then
		-- A worker's folder is made only by a dispatch, or comes back whole (its brief, and its results when it had them)
		-- with a restore of a retired worker.
		v_files := array(select f.key from public.qorpera_company_state_unit_files(p_unit, p_eff_path) f);
		for v_content in select p_key as key union all
			select public.qorpera_folder_key(c.path) from public.qorpera_folder_spelled_contents(p_eff_path,
				case when p_op = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end) c where c.kind = 'folder'
		loop
			v_place := public.qorpera_company_state_worker_folder(v_content.key);
			if v_place = v_content.key and not exists (select 1 from public.qorpera_runtime_workers w
				where w.folder_environment_id = p_environment_id and w.folder_key = v_place and w.folder_retired_at is not null
					and (v_place || '/brief.md') = any (v_files)
					and (w.folder_results_version is null or (v_place || '/results.md') = any (v_files))
					and not exists (select 1 from public.qorpera_runtime_workers l
						where l.folder_environment_id = p_environment_id and l.folder_key = v_place and l.folder_retired_at is null)) then
				v_problem := 'a worker''s folder is made by manage_worker''s dispatch, or comes back whole with its files'; exit;
			end if;
		end loop;
	elsif p_op = 'delete' then
		if v_kind in ('worker-brief','worker-results') then
			v_problem := 'a worker''s files go with its folder';
		elsif public.qorpera_company_state_workers_under(p_environment_id, p_key, true) then
			v_problem := 'a worker here is still at work; cancel it first';
		elsif v_kind = 'todo' and public.qorpera_company_state_workers_under(p_environment_id,
				regexp_replace(p_key, '[.]md$', ''), false) then
			v_problem := 'this todo has workers: delete its folder first, or write a new todo';
		end if;
	elsif p_op in ('move','copy') then
		v_place := public.qorpera_company_state_worker_folder(p_key);
		-- The folder itself and its two files; the other files in it are a write worker's outputs, and ordinary.
		if p_op = 'move' and (v_place = p_key or v_kind in ('worker-brief','worker-results')) then
			v_problem := 'a worker''s folder moves only with its agent''s folder';
		elsif p_op = 'move' and public.qorpera_company_state_workers_under(p_environment_id, p_key, true) then
			v_problem := 'a worker here is still at work; cancel it first';
		elsif p_op = 'move' and ((v_kind = 'todo' and public.qorpera_company_state_workers_under(p_environment_id,
					regexp_replace(p_key, '[.]md$', ''), false))
				or (p_key ~ '^agents/[^/]+/todos/[^/]+$' and public.qorpera_company_state_workers_under(p_environment_id, p_key, false))) then
			v_problem := 'this todo has workers: write a new todo, or delete its folder first';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_company_state_worker_paths(uuid, uuid, jsonb, uuid, text, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- 4. The rules for one worker file (§3). Returns a refusal (or a conflict) or null.
create function public.qorpera_company_state_worker_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_key text, p_parse jsonb, p_file jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_request jsonb := public.qorpera_folder_worker_request(); v_action text; v_brief boolean := p_parse ->> 'kind' = 'worker-brief';
	v_folder text := public.qorpera_company_state_worker_folder(p_key); v_worker public.qorpera_runtime_workers%rowtype;
	v_todo public.qorpera_runtime_agent_todos%rowtype; v_run public.qorpera_execution_runs%rowtype; v_base jsonb;
	v_standing jsonb; v_source jsonb; v_problem text; v_staff uuid := (p_actor ->> 'staffAgentId')::uuid;
	v_agent_folder text := array_to_string((string_to_array(v_folder, '/'))[1:2], '/'); v_file jsonb;
begin
	v_worker := public.qorpera_company_state_worker_at(p_environment_id, v_folder);
	if v_request is null then
		-- Only a restore of a retired worker's files, byte for byte as its row records them.
		if v_worker.id is null or v_worker.folder_retired_at is null
			or p_file ->> 'fileSha256' is distinct from (select v.file_sha256 from public.qorpera_folder_path_versions v
				where v.version = case when v_brief then v_worker.folder_brief_version else v_worker.folder_results_version end) then
			v_problem := 'only manage_worker and report_work write a worker''s files';
		end if;
	else
		v_action := v_request ->> 'action';
		-- Rows read without this commit's lock (written by a commit after this one read the folder) are a conflict.
		if public.qorpera_company_state_changed_since(p_commit_id, v_worker.folder_commit_id) then
			return jsonb_build_object('ok', false, 'reason', 'version_changed'); end if;
		select * into v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
		select * into v_todo from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
			and t.folder_retired_at is null and t.folder_path = public.qorpera_company_state_worker_todo_file(v_folder) collate "C";
		-- A run of the folder's own agent.
		if v_run.id is null or not exists (select 1 from public.qorpera_profile_staff s
			where s.profile_id = p_profile_id and s.staff_agent_id = v_staff and s.folder_environment_id = p_environment_id
				and s.folder_retired_at is null and s.deleted_at is null and public.qorpera_folder_key(s.folder_path) = v_agent_folder) then
			v_problem := 'a worker works on its own agent''s todos';
		elsif v_action in ('dispatch','followup','decide') and (p_actor -> 'audience' ->> 'kind' is distinct from 'company'
			or (public.qorpera_run_worker(v_run.id)).id is not null) then
			-- Contract 13: only the agent's own run manages its workers; a worker cannot delegate further.
			v_problem := 'only the agent''s own run manages its workers';
		elsif v_action in ('dispatch','followup') and (v_todo.id is null or v_todo.state not in ('open','blocked')) then
			v_problem := 'the todo is closed; use a new todo for new work';
		elsif v_action in ('dispatch','followup') and not exists (select 1 from public.qorpera_starter_sponsor(p_profile_id,
				(p_actor ->> 'requesterUserId')::uuid, v_staff, v_run.sponsor_binding_id)) then
			-- Background work is paid by the member who started the chain (20260928230000).
			v_problem := 'no model account is set up for background work by this agent';
		elsif v_action = 'dispatch' then
			v_standing := public.qorpera_company_state_worker_standing(p_parse ->> 'species', p_parse ->> 'access',
				p_parse ->> 'revival');
			if not v_brief then
				v_problem := 'a dispatch writes the worker''s brief';
			elsif p_parse ->> 'species' is distinct from 'in-house' then
				v_problem := 'coding workers come to the company folder with coding machines';
			elsif exists (select 1 from public.qorpera_runtime_workers w where w.id = (p_parse ->> 'id')::uuid
				or (w.todo_id = v_todo.id and w.worker_key = split_part(v_folder, '/', 5))) then
				v_problem := 'this worker already exists; steer it with a follow-up instead of a second dispatch';
			elsif p_parse ->> 'title' is distinct from v_request ->> 'title' or p_parse ->> 'access' is distinct from v_request ->> 'access'
				or p_parse ->> 'revival' is distinct from v_request ->> 'revival' or p_parse ->> 'goal' is distinct from v_request ->> 'goal'
				or p_parse ->> 'doneWhen' is distinct from v_request ->> 'doneWhen'
				or p_parse -> 'context' is distinct from coalesce(v_request -> 'context', 'null'::jsonb)
				or p_parse -> 'sources' is distinct from coalesce(v_request -> 'sources', '[]'::jsonb) then
				v_problem := 'the brief does not match the dispatch';
			elsif (p_parse ->> 'followUps') <> '0' or p_parse ->> 'authority' is distinct from v_standing ->> 'authority'
				or p_parse ->> 'output' is distinct from v_standing ->> 'output'
				or p_parse ->> 'cancellation' is distinct from v_standing ->> 'cancellation'
				or p_parse ->> 'completion' is distinct from v_standing ->> 'completion' then
				v_problem := 'a new brief has no follow-up, and its standing texts are the platform''s';
			elsif abs(extract(epoch from (p_parse ->> 'dispatchedAt')::timestamptz - clock_timestamp())) > 300 then
				v_problem := 'dispatched_at is the time of the dispatch';
			else
				-- A source the run cannot read is not a source.
				for v_source in select value from jsonb_array_elements(p_parse -> 'sources') loop
					if not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_source #>> '{}', 'read') then
						v_problem := 'this run cannot read the source ' || left(v_source #>> '{}', 100); exit;
					end if;
				end loop;
			end if;
		elsif v_worker.id is null or v_worker.folder_retired_at is not null or v_worker.todo_id is distinct from v_todo.id then
			v_problem := 'there is no worker here; dispatch one first';
		elsif v_action = 'followup' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			if not v_brief or v_base is null then
				v_problem := 'a follow-up rewrites the worker''s brief';
			elsif v_worker.state = 'active' then
				v_problem := 'this worker is still working; wait for its report or cancel it';
			elsif v_worker.state = 'cancelled' then
				v_problem := 'this worker cannot continue; dispatch a new one';
			elsif p_parse - array['followUps','followedUpAt','followUp'] is distinct from v_base - array['followUps','followedUpAt','followUp']
				or (p_parse ->> 'followUps')::integer is distinct from v_worker.sequence
				or p_parse ->> 'followUp' is distinct from v_request ->> 'text' then
				v_problem := 'a follow-up adds one follow-up and changes nothing else';
			elsif abs(extract(epoch from (p_parse ->> 'followedUpAt')::timestamptz - clock_timestamp())) > 300 then
				v_problem := 'followed_up_at is the time of the follow-up';
			end if;
		elsif v_action = 'report' then
			-- Once per sequence: the report ends the work. A results.md left from before a follow-up is overwritten.
			if v_brief then
				v_problem := 'a report writes the worker''s results';
			elsif v_worker.state <> 'active' or v_worker.occurrence_id is distinct from (select w.id from public.qorpera_wake_occurrences w
				where w.run_id = v_run.id and w.wake_kind = 'agent' and w.source_kind = 'worker-dispatch' and w.source_id = v_worker.id) then
				v_problem := 'only the worker''s own run reports, while it works';
			elsif p_parse ->> 'outcome' = 'cancelled' or jsonb_typeof(p_parse -> 'decision') is distinct from 'null' then
				v_problem := 'a report is succeeded, blocked or failed, without a decision';
			elsif abs(extract(epoch from (p_parse ->> 'reportedAt')::timestamptz - clock_timestamp())) > 300 then
				v_problem := 'reported_at is the time of the report';
			else
				-- Each listed file is one this run wrote (today: a revision this run wrote).
				for v_file in select value from jsonb_array_elements(p_parse -> 'files') loop
					if not exists (select 1 from public.qorpera_folder_path_versions v
						join public.qorpera_folder_commits c on c.id = v.commit_id
						where v.environment_id = p_environment_id
							and v.key_sha256 = extensions.digest(public.qorpera_folder_key(v_file #>> '{}'), 'sha256')
							and c.run_id = v_run.id) then
						v_problem := 'this run did not write ' || left(v_file #>> '{}', 100); exit;
					end if;
				end loop;
			end if;
		elsif v_action = 'decide' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			if v_brief or v_base is null then
				v_problem := 'a decision is on the worker''s report; without a report there is none';
			elsif v_worker.state = 'active' then
				v_problem := 'this worker is still working; wait for its report';
			elsif p_parse - array['decision','note'] is distinct from v_base - array['decision','note']
				or p_parse ->> 'decision' is distinct from v_request ->> 'decision'
				or p_parse -> 'note' is distinct from coalesce(v_request -> 'note', 'null'::jsonb) then
				v_problem := 'a decision changes only decision and note';
			elsif p_parse ->> 'decision' = 'accepted' and p_parse ->> 'outcome' <> 'succeeded' then
				v_problem := 'only a finished, successful result can be accepted';
			end if;
		else
			v_problem := 'the worker tool''s request is invalid';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_company_state_worker_rules(uuid, uuid, jsonb, uuid, text, jsonb, jsonb)
	from public, anon, authenticated, service_role;

-- 5. The index writer for one worker file (§4).
create function public.qorpera_company_state_index_worker(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_request jsonb := public.qorpera_folder_worker_request(); v_action text := v_request ->> 'action';
	v_folder_path text := regexp_replace(p_path, '/[^/]+$', ''); v_folder text; v_brief boolean := p_parse ->> 'kind' = 'worker-brief';
	v_commit public.qorpera_folder_commits%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_dispatch jsonb;
	v_todo uuid; v_count bigint;
begin
	v_folder := public.qorpera_folder_key(v_folder_path);
	select * into v_commit from public.qorpera_folder_commits where id = p_commit_id;
	if v_brief then
		v_dispatch := jsonb_build_object('goal', p_parse ->> 'goal', 'definitionOfDone', p_parse ->> 'doneWhen',
			'context', coalesce(p_parse ->> 'context', ''), 'sources', p_parse -> 'sources', 'followUp', p_parse -> 'followUp',
			'authority', p_parse ->> 'authority', 'output', p_parse ->> 'output', 'cancellation', p_parse ->> 'cancellation',
			'completion', p_parse ->> 'completion');
	end if;
	if v_action = 'dispatch' then
		select t.id into strict v_todo from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
			and t.folder_retired_at is null and t.folder_path = public.qorpera_company_state_worker_todo_file(v_folder) collate "C";
		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
			access, revival, dispatch, requested_by_user_id, steering_run_id, folder_environment_id, folder_path, folder_key,
			folder_brief_version, folder_commit_id)
		values ((p_parse ->> 'id')::uuid, p_profile_id, p_environment_id, v_commit.actor_id, v_todo, split_part(v_folder, '/', 5),
			'in-house', p_parse ->> 'title', p_parse ->> 'access', p_parse ->> 'revival', v_dispatch, v_commit.requester_id,
			v_commit.run_id, p_environment_id, v_folder_path, v_folder, p_version, p_commit_id)
		returning * into v_worker;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'dispatched', v_commit.run_id, v_dispatch);
		return;
	end if;
	v_worker := public.qorpera_company_state_worker_at(p_environment_id, v_folder);
	if v_worker.id is null then raise exception 'A worker file has no worker row' using errcode = 'XX000'; end if;
	if v_action = 'followup' then
		-- As today's follow-up: the next sequence, at work again, its results and decision cleared.
		update public.qorpera_runtime_workers set sequence = sequence + 1, state = 'active', result = null, reported_at = null,
			acceptance = null, acceptance_note = null, accepted_by_run_id = null, accepted_at = null, completion_state = 'none',
			completion_occurrence_id = null, occurrence_id = null, dispatch = v_dispatch, steering_run_id = v_commit.run_id,
			folder_brief_version = p_version, folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where id = v_worker.id and folder_retired_at is null and state <> 'active'
		returning * into v_worker;
		get diagnostics v_count = row_count;
		if v_count <> 1 then raise exception 'A worker''s follow-up found no row' using errcode = 'XX000'; end if;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'followup', v_commit.run_id, jsonb_build_object('text', p_parse ->> 'followUp'));
	elsif v_action = 'report' then
		update public.qorpera_runtime_workers set state = p_parse ->> 'outcome', reported_at = clock_timestamp(),
			completion_state = 'waiting', updated_at = clock_timestamp(), folder_results_version = p_version,
			folder_commit_id = p_commit_id,
			result = jsonb_build_object('outcome', p_parse ->> 'outcome', 'summary', p_parse ->> 'summary', 'needs', p_parse -> 'needs',
				'outputs', coalesce((select jsonb_agg(jsonb_build_object('path', f #>> '{}')) from jsonb_array_elements(p_parse -> 'files') f),
					'[]'::jsonb), 'runId', v_commit.run_id, 'sequence', sequence)
		where id = v_worker.id and folder_retired_at is null and state = 'active';
		get diagnostics v_count = row_count;
		if v_count <> 1 then raise exception 'A worker''s report found no row at work' using errcode = 'XX000'; end if;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'reported', v_commit.run_id, jsonb_build_object('outcome', p_parse ->> 'outcome'));
	elsif v_action = 'decide' then
		update public.qorpera_runtime_workers set acceptance = p_parse ->> 'decision', acceptance_note = p_parse ->> 'note',
			accepted_by_run_id = v_commit.run_id, accepted_at = clock_timestamp(),
			completion_state = case when completion_state = 'waiting' then 'suppressed' else completion_state end,
			folder_results_version = p_version, folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where id = v_worker.id and folder_retired_at is null;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, p_parse ->> 'decision', v_commit.run_id, jsonb_build_object('note', p_parse ->> 'note'));
	else
		-- A restore: the retired worker comes back, finished, at its folder.
		update public.qorpera_runtime_workers set folder_retired_at = null, folder_path = v_folder_path, folder_key = v_folder,
			folder_brief_version = case when v_brief then p_version else folder_brief_version end,
			folder_results_version = case when v_brief then folder_results_version else p_version end,
			folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where id = v_worker.id;
	end if;
end $$;
revoke all on function public.qorpera_company_state_index_worker(uuid, uuid, uuid, text, uuid, jsonb)
	from public, anon, authenticated, service_role;

-- 6. The rank-5 rows a unit writes or relies on (§5), with the company row at rank 0 for a new worker's foreign key.
create function public.qorpera_company_state_worker_targets(p_environment_id uuid, p_unit jsonb)
returns table(rank smallint, tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_key text; v_request jsonb := public.qorpera_folder_worker_request(); v_folder text;
	v_row record; v_entry jsonb; v_profile uuid;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	select f.profile_id into v_profile from public.qorpera_company_files f where f.environment_id = p_environment_id;
	if v_profile is null then return; end if;
	v_key := public.qorpera_folder_key(case when v_op in ('move','copy') then p_unit ->> 'from' else p_unit ->> 'path' end);
	if v_request is not null and jsonb_typeof(v_request -> 'folder') = 'string' then
		-- A worker change: its worker, the todo it works on (or joins), and a new worker's claimed id.
		v_folder := public.qorpera_folder_key(v_request ->> 'folder');
		for v_row in select w.id, w.todo_id from public.qorpera_runtime_workers w
			where w.folder_environment_id = p_environment_id and w.folder_key = v_folder and w.folder_retired_at is null loop
			rank := 5; tbl := 'qorpera_runtime_workers'; key := v_row.id::text; mode := 'nokeyupdate'; return next;
			rank := 5; tbl := 'qorpera_runtime_agent_todos'; key := v_row.todo_id::text; mode := 'share'; return next;
		end loop;
		for v_row in select t.id from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
			and t.folder_retired_at is null and t.folder_path = public.qorpera_company_state_worker_todo_file(v_folder) collate "C" loop
			rank := 5; tbl := 'qorpera_runtime_agent_todos'; key := v_row.id::text; mode := 'share'; return next;
		end loop;
		for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(p_unit -> 'structured') = 'array'
				then p_unit -> 'structured' else '[]'::jsonb end) e
			where e.value ->> 'kind' = 'worker-brief' and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid loop
			rank := 0; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare'; return next;
			rank := 5; tbl := 'qorpera_runtime_workers'; key := v_entry -> 'parse' ->> 'id'; mode := 'nokeyupdate'; return next;
		end loop;
	end if;
	if v_op in ('write','new_folder') then
		for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(p_unit -> 'structured') = 'array'
				then p_unit -> 'structured' else '[]'::jsonb end) e loop
			-- A todo file's own row, which apply rewrites.
			if v_entry ->> 'kind' = 'todo' and coalesce(v_entry -> 'parse' ->> 'id', '') ~ c_uuid then
				for v_row in select t.id from public.qorpera_runtime_agent_todos t where t.id = (v_entry -> 'parse' ->> 'id')::uuid loop
					rank := 5; tbl := 'qorpera_runtime_agent_todos'; key := v_row.id::text; mode := 'nokeyupdate'; return next;
				end loop;
			-- A worker file restored without a request: its worker and its todo.
			elsif v_request is null and v_entry ->> 'kind' in ('worker-brief','worker-results') then
				for v_row in select w.id, w.todo_id from public.qorpera_runtime_workers w
					where w.folder_environment_id = p_environment_id
						and w.folder_key = public.qorpera_company_state_worker_folder(public.qorpera_folder_key(v_entry ->> 'path')) loop
					rank := 5; tbl := 'qorpera_runtime_workers'; key := v_row.id::text; mode := 'nokeyupdate'; return next;
					rank := 5; tbl := 'qorpera_runtime_agent_todos'; key := v_row.todo_id::text; mode := 'nokeyupdate'; return next;
				end loop;
			end if;
		end loop;
	elsif v_op in ('delete','move') then
		-- The todos and workers at or under the key, which apply retires or repoints.
		for v_row in select t.id from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
			and t.folder_retired_at is null
			and (t.folder_path = v_key collate "C" or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C")) loop
			rank := 5; tbl := 'qorpera_runtime_agent_todos'; key := v_row.id::text; mode := 'nokeyupdate'; return next;
		end loop;
		for v_row in select w.id from public.qorpera_runtime_workers w where w.folder_environment_id = p_environment_id
			and w.folder_retired_at is null
			and (w.folder_key = v_key or w.folder_key like public.qorpera_folder_under(v_key)
				or v_key = w.folder_key || '/results.md') loop
			rank := 5; tbl := 'qorpera_runtime_workers'; key := v_row.id::text; mode := 'nokeyupdate'; return next;
		end loop;
	end if;
end $$;
revoke all on function public.qorpera_company_state_worker_targets(uuid, jsonb) from public, anon, authenticated, service_role;

-- 7. The hook's patches ------------------------------------------------------------------------------------------

-- The parse's shape (§1), with the parser's limits and cross-key rules.
select pg_temp.f25b_worker_files_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$old$,
	$new$	end if;
	-- 20260930003000 (F2-5b): a worker's brief and results (§1).
	if p_kind = 'worker-brief' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
				'followedUpAt','goal','id','kind','output','revival','sources','species','title'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'title', 1, 200, true) then v_bad := array_append(v_bad, 'title'); end if;
		if coalesce(p_parse ->> 'species', '') not in ('in-house','coding') then v_bad := array_append(v_bad, 'species'); end if;
		if coalesce(p_parse ->> 'access', '') not in ('read','write') then v_bad := array_append(v_bad, 'access'); end if;
		if coalesce(p_parse ->> 'revival', '') not in ('each','batch') then v_bad := array_append(v_bad, 'revival'); end if;
		if not coalesce(public.qorpera_company_state_instant(p_parse -> 'dispatchedAt'), false) then
			v_bad := array_append(v_bad, 'dispatchedAt'); end if;
		if jsonb_typeof(p_parse -> 'followUps') is distinct from 'number'
			or case when (p_parse ->> 'followUps') ~ '^(0|[1-9][0-9]{0,9})$' then (p_parse ->> 'followUps')::bigint > 2147483646
				else true end
			or (p_parse ->> 'followUps' = '0') is distinct from (jsonb_typeof(p_parse -> 'followedUpAt') = 'null')
			or (p_parse ->> 'followUps' = '0') is distinct from (jsonb_typeof(p_parse -> 'followUp') = 'null')
			or (jsonb_typeof(p_parse -> 'followedUpAt') <> 'null'
				and not coalesce(public.qorpera_company_state_instant(p_parse -> 'followedUpAt'), false)) then
			v_bad := array_append(v_bad, 'followUps'); end if;
		-- The sections: text of 1 to its bound, trimmed; context and the follow-up may be absent.
		if exists (select 1 from (values ('goal', 4000, true), ('doneWhen', 2000, true), ('context', 4000, false),
				('authority', 32768, true), ('output', 32768, true), ('cancellation', 32768, true), ('completion', 32768, true),
				('followUp', 4000, false)) s(name, bound, required)
			where not ((not s.required and jsonb_typeof(p_parse -> s.name) = 'null')
				or (jsonb_typeof(p_parse -> s.name) = 'string' and octet_length(p_parse ->> s.name) between 1 and s.bound
					and (p_parse ->> s.name) = btrim(p_parse ->> s.name, E' \t\n\r')))) then
			v_bad := array_append(v_bad, 'sections'); end if;
		-- At most 8 sources, each a path the folder can hold of up to 512 bytes, written once by key.
		if jsonb_typeof(p_parse -> 'sources') is distinct from 'array' or jsonb_array_length(p_parse -> 'sources') > 8
			or exists (select 1 from jsonb_array_elements(p_parse -> 'sources') f
				where jsonb_typeof(f) <> 'string' or octet_length(f #>> '{}') > 512 or (f #>> '{}') ~ '[\x01-\x1f\x7f-\x9f  ]'
					or not public.qorpera_company_path_valid(f #>> '{}'))
			or (select count(distinct public.qorpera_folder_key(f #>> '{}')) from jsonb_array_elements(p_parse -> 'sources') f)
				<> jsonb_array_length(p_parse -> 'sources') then
			v_bad := array_append(v_bad, 'sources'); end if;
	elsif p_kind = 'worker-results' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['decision','files','kind','needs','note','outcome','reportedAt','summary'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'outcome', '') not in ('succeeded','blocked','failed','cancelled') then
			v_bad := array_append(v_bad, 'outcome'); end if;
		if not coalesce(public.qorpera_company_state_instant(p_parse -> 'reportedAt'), false) then
			v_bad := array_append(v_bad, 'reportedAt'); end if;
		if (jsonb_typeof(p_parse -> 'decision') <> 'null' and coalesce(p_parse ->> 'decision', '') not in ('accepted','rejected'))
			or (jsonb_typeof(p_parse -> 'note') <> 'null' and (jsonb_typeof(p_parse -> 'decision') = 'null'
				or not public.qorpera_company_state_one_line(p_parse -> 'note', 1, 1000, true))) then
			v_bad := array_append(v_bad, 'decision'); end if;
		if jsonb_typeof(p_parse -> 'summary') is distinct from 'string' or octet_length(p_parse ->> 'summary') not between 1 and 4000
			or (p_parse ->> 'summary') <> btrim(p_parse ->> 'summary', E' \t\n\r') then
			v_bad := array_append(v_bad, 'summary'); end if;
		-- What it needs: exactly when blocked.
		if (p_parse ->> 'outcome' = 'blocked') is distinct from (jsonb_typeof(p_parse -> 'needs') = 'string')
			or (jsonb_typeof(p_parse -> 'needs') = 'string' and (octet_length(p_parse ->> 'needs') not between 1 and 1000
				or (p_parse ->> 'needs') <> btrim(p_parse ->> 'needs', E' \t\n\r')))
			or jsonb_typeof(p_parse -> 'needs') not in ('string','null') then
			v_bad := array_append(v_bad, 'needs'); end if;
		if jsonb_typeof(p_parse -> 'files') is distinct from 'array' or jsonb_array_length(p_parse -> 'files') > 4
			or exists (select 1 from jsonb_array_elements(p_parse -> 'files') f
				where jsonb_typeof(f) <> 'string' or octet_length(f #>> '{}') > 256 or (f #>> '{}') ~ '[\x01-\x1f\x7f-\x9f  ]'
					or not public.qorpera_company_path_valid(f #>> '{}'))
			or (select count(distinct public.qorpera_folder_key(f #>> '{}')) from jsonb_array_elements(p_parse -> 'files') f)
				<> jsonb_array_length(p_parse -> 'files') then
			v_bad := array_append(v_bad, 'files'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$new$);

-- The two worker kinds' parses are checked as the other kinds' are.
select pg_temp.f25b_worker_files_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$	-- 20260929999000 (H1): a human task's and a contact's parse are checked too.
	if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine','human-task','contact') then$old$,
	$new$	-- 20260929999000 (H1): a human task's and a contact's parse are checked too; 20260930003000 (F2-5b): a worker's too.
	if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine','human-task','contact',
		'worker-brief','worker-results') then$new$);

-- The targets: F2-5b's rows, for every unit.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_member uuid; v_h2 record;$old$,
	$new$	v_member uuid; v_h2 record; v_f2 record;$new$);
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$			rank := 5; tbl := v_h2.tbl; key := v_h2.key; mode := v_h2.mode;
			return next;
		end loop;$old$,
	$new$			rank := 5; tbl := v_h2.tbl; key := v_h2.key; mode := v_h2.mode;
			return next;
		end loop;
		-- 20260930003000 (F2-5b): the todos and workers a unit writes or relies on, at rank 5 (and the company row, rank 0).
		for v_f2 in select * from public.qorpera_company_state_worker_targets(p_environment_id, v_unit) loop
			rank := v_f2.rank; tbl := v_f2.tbl; key := v_f2.key; mode := v_f2.mode;
			return next;
		end loop;$new$);

-- The lock: the two tables, after the routines and before H2's, by id.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$			'qorpera_company_room_members','qorpera_cloud_routines','qorpera_folder_human_task_index',$old$,
	$new$			'qorpera_company_room_members','qorpera_cloud_routines','qorpera_runtime_agent_todos','qorpera_runtime_workers',
			'qorpera_folder_human_task_index',$new$);
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$		elsif v_target.tbl in ('qorpera_folder_human_task_index', 'qorpera_folder_contact_index') then$old$,
	$new$		elsif v_target.tbl in ('qorpera_runtime_agent_todos', 'qorpera_runtime_workers') then
			-- key: the row's id (20260930003000, F2-5b).
			execute 'select 1 from public.' || v_target.tbl || ' where id = $1' || v_clause using v_target.key::uuid;
		elsif v_target.tbl in ('qorpera_folder_human_task_index', 'qorpera_folder_contact_index') then$new$);

-- Decide: the guard for every unit, after H2's; the rules for each worker file.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path);
	if v_rule is not null then return v_rule; end if;
$old$,
	$new$		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path);
	if v_rule is not null then return v_rule; end if;
	-- 20260930003000 (F2-5b): workers' folders and files, for every unit.
	v_rule := public.qorpera_company_state_worker_paths(p_environment_id, v_profile, p_actor, p_commit_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path);
	if v_rule is not null then return v_rule; end if;
$new$);
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			v_rule := public.qorpera_company_state_contact_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
$old$,
	$new$			v_rule := public.qorpera_company_state_contact_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		-- 20260930003000 (F2-5b): a worker's brief and results.
		elsif v_checked ->> 'kind' in ('worker-brief','worker-results') then
			v_rule := public.qorpera_company_state_worker_rules(p_environment_id, v_profile, p_actor, p_commit_id, v_file.key,
				v_checked -> 'parse', v_file.file);
			if v_rule is not null then return v_rule; end if;
$new$);

-- Apply: write the rows; a move repoints them; a delete retires them, or clears a follow-up's results.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				perform public.qorpera_company_state_index_contact(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			end if;$old$,
	$new$				perform public.qorpera_company_state_index_contact(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			-- 20260930003000 (F2-5b): a worker's brief and results.
			elsif v_kind in ('worker-brief','worker-results') then
				perform public.qorpera_company_state_index_worker(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			end if;$new$);
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		if v_h2_moved <> v_h2_rows then raise exception 'A moved contact file has no version in its commit' using errcode = 'XX000'; end if;
$old$,
	$new$		if v_h2_moved <> v_h2_rows then raise exception 'A moved contact file has no version in its commit' using errcode = 'XX000'; end if;
		-- Workers' folders follow their agent's folder, with their files' new versions (20260930003000, F2-5b).
		select count(*) into v_h2_rows from public.qorpera_runtime_workers w
		where w.folder_environment_id = p_environment_id and w.folder_retired_at is null
			and (w.folder_key = v_key or w.folder_key like public.qorpera_folder_under(v_key));
		update public.qorpera_runtime_workers w set folder_path = e.path, folder_key = e.key_text,
			folder_brief_version = (select v.version from public.qorpera_folder_path_versions v where v.commit_id = p_commit_id
				and v.unit_no = p_unit_no and v.op = 'move_in' and v.key_sha256 = extensions.digest(e.key_text || '/brief.md', 'sha256')),
			folder_results_version = case when w.folder_results_version is null then null
				else (select v.version from public.qorpera_folder_path_versions v where v.commit_id = p_commit_id and v.unit_no = p_unit_no
					and v.op = 'move_in' and v.key_sha256 = extensions.digest(e.key_text || '/results.md', 'sha256')) end,
			folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		from public.qorpera_folder_entries e
		where w.folder_environment_id = p_environment_id and w.folder_retired_at is null
			and (w.folder_key = v_key or w.folder_key like public.qorpera_folder_under(v_key))
			and e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(w.folder_path, char_length(p_eff_path) + 1)), 'sha256');
		get diagnostics v_h2_moved = row_count;
		if v_h2_moved <> v_h2_rows then raise exception 'A moved worker folder has no version in its commit' using errcode = 'XX000'; end if;
$new$);
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A connection's file removed (after its account was disconnected): its index row retires.$old$,
	$new$		-- A worker's folder removed: its row retires, finished (a restore brings it back); a follow-up's results.md
		-- removed: its row no longer points at results (20260930003000, F2-5b).
		update public.qorpera_runtime_workers w set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where w.folder_environment_id = p_environment_id and w.folder_retired_at is null
			and (w.folder_key = v_key or w.folder_key like public.qorpera_folder_under(v_key));
		update public.qorpera_runtime_workers w set folder_results_version = null, folder_commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where w.folder_environment_id = p_environment_id and w.folder_retired_at is null and v_key = w.folder_key || '/results.md';
		-- A connection's file removed (after its account was disconnected): its index row retires.$new$);

-- Verify: every worker row this commit wrote points at its files' current versions.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		or exists (select 1 from public.qorpera_folder_company_index i$old$,
	$new$		-- 20260930003000 (F2-5b): worker rows, brief and results.
		or exists (select 1 from public.qorpera_runtime_workers w
			where w.folder_environment_id = p_environment_id and w.folder_commit_id = p_commit_id and w.folder_retired_at is null
				and (not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(w.folder_key || '/brief.md', 'sha256') and e.version = w.folder_brief_version)
					or (w.folder_results_version is null) is distinct from not exists (select 1 from public.qorpera_folder_entries e
						where e.environment_id = p_environment_id and e.kind = 'file'
							and e.key_sha256 = extensions.digest(w.folder_key || '/results.md', 'sha256'))
					or (w.folder_results_version is not null and not exists (select 1 from public.qorpera_folder_entries e
						where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(w.folder_key || '/results.md', 'sha256')
							and e.version = w.folder_results_version))))
		or exists (select 1 from public.qorpera_folder_company_index i$new$);

-- Review: a dispatch's and a follow-up's brief is delegation (cloud-action-review, manage_worker); a restore adds none.
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_structured_review_class(uuid,jsonb,jsonb,text,text)'::regprocedure,
	$old$			return 'delegation'; end if;
	end loop;
	return 'plain';$old$,
	$new$			return 'delegation'; end if;
		-- 20260930003000 (F2-5b): dispatching a worker, or steering it, is delegation.
		if v_kind = 'worker-brief' and public.qorpera_folder_worker_request() ->> 'action' in ('dispatch','followup') then
			return 'delegation'; end if;
	end loop;
	return 'plain';$new$);

-- The review recorder takes manage_worker's dispatch and follow-up (their action review is a delegation).
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$		and v_action.tool_name in ('hire_agent','create_group_chat','manage_routine','decide_routine','company_delete')$old$,
	$new$		-- manage_worker: 20260930003000 (F2-5b).
		and v_action.tool_name in ('hire_agent','create_group_chat','manage_routine','decide_routine','company_delete','manage_worker')$new$);

-- Authority: a worker's own report, through report_work, passes (the read-only ban included); the hook then allows only
-- its own results.md (§2).
select pg_temp.f25b_worker_files_replace('public.qorpera_folder_actor_resource_allowed(uuid,jsonb,qorpera_company_path_resources,text)'::regprocedure,
	$old$	if p_actor ->> 'kind' is distinct from 'staff_agent' then return false; end if;
$old$,
	$new$	if p_actor ->> 'kind' is distinct from 'staff_agent' then return false; end if;
	-- 20260930003000 (F2-5b): the worker's own report through report_work.
	if p_permission = 'write' and public.qorpera_folder_worker_request() ->> 'action' = 'report'
		and public.qorpera_folder_worker_request() ->> 'runId' = p_actor ->> 'runId' then return true; end if;
$new$);

-- 8. The entry, cancel and status ---------------------------------------------------------------------------------

-- The worker tools' one way to write a worker's files (§2): the run's change set with the tool's request carried in.
create function public.qorpera_folder_worker_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb,
	p_request jsonb, p_review_id uuid default null, p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_action text := p_request ->> 'action'; v_keys text[]; v_result jsonb;
	c_path constant text := '^agents/[a-z0-9]+(-[a-z0-9]+)*/todos/[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$';
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Only a run writes a worker''s files' using errcode = '22023'; end if;
	if coalesce(current_setting('qorpera.folder_worker', true), '') <> '' then
		raise exception 'A worker request is already set in this transaction' using errcode = '55000'; end if;
	v_keys := case v_action
		when 'dispatch' then array['action','access','context','doneWhen','folder','goal','revival','sources','title']
		when 'followup' then array['action','folder','text']
		when 'decide' then array['action','decision','folder','note']
		when 'report' then array['action','folder'] end;
	if jsonb_typeof(p_request) is distinct from 'object' or v_keys is null
		or (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from (select array_agg(k order by k) from unnest(v_keys) k)
		or jsonb_typeof(p_request -> 'folder') is distinct from 'string' or (p_request ->> 'folder') !~ c_path
		or (v_action = 'dispatch' and (jsonb_typeof(p_request -> 'title') <> 'string' or jsonb_typeof(p_request -> 'goal') <> 'string'
			or jsonb_typeof(p_request -> 'doneWhen') <> 'string' or jsonb_typeof(p_request -> 'context') not in ('string','null')
			or jsonb_typeof(p_request -> 'sources') <> 'array' or jsonb_typeof(p_request -> 'access') <> 'string'
			or jsonb_typeof(p_request -> 'revival') <> 'string'))
		or (v_action = 'followup' and jsonb_typeof(p_request -> 'text') <> 'string')
		or (v_action = 'decide' and (coalesce(p_request ->> 'decision', '') not in ('accepted','rejected')
			or jsonb_typeof(p_request -> 'note') not in ('string','null'))) then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	perform set_config('qorpera.folder_worker', (p_request || jsonb_build_object('environmentId', p_environment_id::text,
		'runId', p_actor ->> 'runId', 'operationKey', p_operation_key))::text, true);
	v_result := public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, p_units, p_review_id, p_receipt_id);
	perform set_config('qorpera.folder_worker', '', true);
	return v_result;
end $$;
revoke all on function public.qorpera_folder_worker_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_worker_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) to service_role;

-- Cancel (§3): no file. A run effect, as a coworker message is: the run's check with the todo (FOR SHARE) and the worker
-- (FOR NO KEY UPDATE) at rank 5, the receipt, then today's cancel on the row. It never touches the todo row.
create function public.qorpera_folder_cancel_agent_worker(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid; v_environment uuid; v_worker public.qorpera_runtime_workers%rowtype; v_targets jsonb := '[]'::jsonb;
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_folder text;
	c_path constant text := '^agents/[a-z0-9]+(-[a-z0-9]+)*/todos/[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$';
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from array['folder','operationKey']
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(p_request ->> 'folder', '') !~ c_path then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	v_folder := p_request ->> 'folder';
	-- The targets, from an unlocked read of the run's company and the worker.
	if coalesce(p_binding ->> 'jobId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		select file.profile_id, file.environment_id into v_profile, v_environment from public.qorpera_runner_jobs job
		join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
		where job.id = (p_binding ->> 'jobId')::uuid;
	end if;
	if v_environment is not null then
		v_worker := public.qorpera_company_state_worker_at(v_environment, v_folder);
		if v_worker.id is not null then
			v_targets := jsonb_build_array(
				jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_agent_todos', 'key', v_worker.todo_id::text, 'mode', 'share',
					'required', false),
				jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', v_worker.id::text, 'mode', 'nokeyupdate',
					'required', false));
		end if;
	end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, v_targets);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- Only the agent's own company run cancels its workers (contract 13).
	if v_tool -> 'resolved' -> 'audience' ->> 'kind' is distinct from 'company' or (public.qorpera_run_worker(v_run.id)).id is not null
		or not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = v_run.profile_id
			and s.staff_agent_id = v_run.staff_agent_id and s.folder_environment_id = v_run.environment_id and s.folder_retired_at is null
			and public.qorpera_folder_key(s.folder_path) = array_to_string((string_to_array(v_folder, '/'))[1:2], '/')) then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema', 'qorpera.folder-worker-cancel/v1',
		'runId', v_run.id, 'folder', v_folder, 'operationKey', p_request ->> 'operationKey')::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'worker:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':worker:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Worker operation needs reconciliation' using errcode = '55000'; end if;
	-- Read again under the locks: the worker the targets named, still at its folder.
	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	if v_worker.id is null or v_worker.folder_retired_at is not null or v_worker.folder_environment_id <> v_run.environment_id
		or v_worker.folder_key <> public.qorpera_folder_key(v_folder) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'The worker changed while the cancel waited',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');
	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	v_result := jsonb_build_object('schema', 'qorpera.agent-worker-receipt/v1', 'runId', v_run.id, 'receiptId', v_receipt_id,
		'action', 'cancel', 'folder', v_worker.folder_path, 'worker', public.qorpera_worker_view(v_worker, false));
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;
revoke all on function public.qorpera_folder_cancel_agent_worker(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_cancel_agent_worker(jsonb, jsonb) to service_role;

-- Status (§3): a folder-v2 run's own workers on one todo, from the index. A plain read, as W1's todo list; no file.
create function public.qorpera_folder_agent_workers(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_auth jsonb; v_profile uuid; v_staff uuid; v_folder text; v_todo public.qorpera_runtime_agent_todos%rowtype; v_workers jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth -> 'audience' ->> 'kind' is distinct from 'company'
		or (public.qorpera_run_worker((p_actor ->> 'runId')::uuid)).id is not null then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from array['todoKey']
		or coalesce(p_request ->> 'todoKey', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	v_staff := (v_auth ->> 'staffAgentId')::uuid;
	v_folder := public.qorpera_company_state_run_folder(p_environment_id, v_staff, '{}'::uuid[]) ->> 'agent';
	select * into v_todo from public.qorpera_runtime_agent_todos t where t.folder_environment_id = p_environment_id
		and t.folder_retired_at is null and t.staff_agent_id = v_staff
		and t.folder_path = ('agents/' || v_folder || '/todos/' || (p_request ->> 'todoKey') || '.md') collate "C";
	if v_folder is null or v_todo.id is null
		or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, v_todo.folder_path, 'read') then
		raise exception 'Todo is unavailable' using errcode = 'P0002'; end if;
	select coalesce(jsonb_agg(public.qorpera_worker_view(w, false) || jsonb_build_object('folder', w.folder_path)
		order by w.created_at desc, w.id desc), '[]'::jsonb) into v_workers
	from public.qorpera_runtime_workers w where w.todo_id = v_todo.id and w.folder_path is not null and w.folder_retired_at is null;
	return jsonb_build_object('schema', 'qorpera.folder-agent-workers/v1', 'todoKey', p_request ->> 'todoKey', 'workers', v_workers);
end $$;
revoke all on function public.qorpera_folder_agent_workers(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_agent_workers(uuid, jsonb, jsonb) to service_role;

-- The native host may call the three (G2): the entry and status with the folder scope, cancel with the binding's.
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_worker_commit', 'folder'),
	('qorpera_folder_agent_workers', 'folder'),
	('qorpera_folder_cancel_agent_worker', 'binding');
