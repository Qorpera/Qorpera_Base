-- Company state files, F2-5a: todos (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5). The todo table
-- gains nullable columns, and its run and requester columns become optional for folder rows only.
--
-- agents/<handle>/todos/<name>.md is one of an agent's todos: id (workers reference it), title, status, requested_by
-- (none: the agent's own) and the detail. The index is today's table, qorpera_runtime_agent_todos, so the runtime's
-- readers (open work, pages, worker runs) see file todos unchanged. Worker briefs and results follow (F2-5b), with core
-- C3's writers, which dispatch and report through the platform.
-- * Owner: the agent whose folder holds the file (its agent.md is indexed and not retired, or the same unit writes it,
--   as a hire with its first todo). The key is the file name.
-- * Rules (today's): done is refused while a worker is at work; a closed todo is not opened again (write a new file);
--   requested_by is checked (a member) only when the save changes it; a move or delete that carries a todo with a
--   working worker is refused. The id never changes and belongs to one file. Not reviewed.
-- * Index: a folder row has no run ids (the commit records the actor). Deleting the file cancels an open todo, retires
--   the row and gives its key a tombstone with a '.' (no file name has one) and the whole id, so a new file of that name
--   is free and two tombstones never meet; a restore brings it back. The row's foreign key to the company row takes it
--   KEY SHARE, so a todo save takes the company row at rank 2 first.
-- * Follow-ups for C2's queue: a cancelled todo stops its workers.
--
-- Builds on F2-4 (20260929190000) and replaces the hook functions with the todo branches added.

-- 1. The todo table as the index of todo files --------------------------------------------------------------------------

-- The runtime reads and writes this table on every agent turn: never queue them behind this change.
set local lock_timeout = '3s';

alter table public.qorpera_runtime_agent_todos
	alter column requested_by_user_id drop not null,
	alter column created_by_run_id drop not null,
	alter column updated_by_run_id drop not null,
	add column folder_environment_id uuid,
	add column folder_path text collate "C",
	add column folder_path_version uuid,
	add column folder_commit_id uuid,
	add column folder_retired_at timestamptz,
	-- A run's row keeps its runs and requester; only a file's row goes without.
	add constraint qorpera_runtime_agent_todos_source check (folder_path is not null
		or (requested_by_user_id is not null and created_by_run_id is not null and updated_by_run_id is not null)),
	add constraint qorpera_runtime_agent_todos_folder_complete check (
		(folder_path is null) = (folder_environment_id is null)
		and (folder_path is null) = (folder_path_version is null)
		and (folder_path is null) = (folder_commit_id is null)
		and (folder_retired_at is null or folder_path is not null));
create index qorpera_runtime_agent_todos_folder_path on public.qorpera_runtime_agent_todos(folder_environment_id, folder_path collate "C")
	where folder_path is not null;

-- 2. The parse's shape, now for todos too ---------------------------------------------------------------------------

create or replace function public.qorpera_company_state_parse_problems(p_kind text, p_parse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_bad text[] := '{}'; v_named jsonb;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if jsonb_typeof(p_parse) is distinct from 'object' or p_parse ->> 'kind' is distinct from p_kind then
		return jsonb_build_array(public.qorpera_company_state_problem('value', null, null, 'the parse does not match the file''s kind'));
	end if;
	if p_kind = 'vision' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','name'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 120) then v_bad := array_append(v_bad, 'name'); end if;
	elsif p_kind = 'agent' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agentKind','colour','effort','figure','id','instructions','kind','model','name','role','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 160) then v_bad := array_append(v_bad, 'name'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'role', 1, 320) then v_bad := array_append(v_bad, 'role'); end if;
		if coalesce(p_parse ->> 'agentKind', '') not in ('co-founder','agent') then v_bad := array_append(v_bad, 'agentKind'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','archived') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'colour') <> 'null' and coalesce(p_parse ->> 'colour', '') not in
			('charcoal','brown','coral','orange','gold','green','teal','blue','purple','pink','gray') then v_bad := array_append(v_bad, 'colour'); end if;
		if jsonb_typeof(p_parse -> 'figure') <> 'null' and coalesce(p_parse ->> 'figure', '') not in
			('planet','acorn','flame','rocket','crown','heart','ghost') then v_bad := array_append(v_bad, 'figure'); end if;
		if jsonb_typeof(p_parse -> 'model') <> 'null' and coalesce(p_parse ->> 'model', '') not in
			('gpt-6-astra','gpt-6-sol','gpt-6-luna') then v_bad := array_append(v_bad, 'model'); end if;
		if jsonb_typeof(p_parse -> 'effort') <> 'null' and coalesce(p_parse ->> 'effort', '') not in ('low','medium','high') then
			v_bad := array_append(v_bad, 'effort'); end if;
		if jsonb_typeof(p_parse -> 'instructions') is distinct from 'string'
			or octet_length(p_parse ->> 'instructions') not between 1 and 32768
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r')
			or (p_parse ->> 'instructions') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
			v_bad := array_append(v_bad, 'instructions'); end if;
	elsif p_kind = 'group' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agents','id','kind','name','people','purpose','subtitle'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 256) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'subtitle') <> 'null' and not public.qorpera_company_state_one_line(p_parse -> 'subtitle', 0, 256) then
			v_bad := array_append(v_bad, 'subtitle'); end if;
		-- At least two agents, and no id twice in a list.
		if jsonb_typeof(p_parse -> 'agents') is distinct from 'array' or jsonb_array_length(p_parse -> 'agents') < 2
			or exists (select 1 from jsonb_array_elements(p_parse -> 'agents') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'agents') a) <> jsonb_array_length(p_parse -> 'agents') then
			v_bad := array_append(v_bad, 'agents'); end if;
		if jsonb_typeof(p_parse -> 'people') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'people') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'people') a) <> jsonb_array_length(p_parse -> 'people') then
			v_bad := array_append(v_bad, 'people'); end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string'
			or octet_length(p_parse ->> 'purpose') not between 1 and 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	elsif p_kind = 'sections' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'sections') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'sections') s
				where jsonb_typeof(s) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(s) k) is distinct from array['line','members','name']
					or not public.qorpera_company_state_one_line(s -> 'name', 1, 60)
					or jsonb_typeof(s -> 'line') <> 'number' or (s ->> 'line') !~ '^[1-9][0-9]{0,8}$'
					or jsonb_typeof(s -> 'members') <> 'array'
					or exists (select 1 from jsonb_array_elements(s -> 'members') m
						where jsonb_typeof(m) <> 'object'
							or (select array_agg(k order by k) from jsonb_object_keys(m) k) is distinct from array['id','line']
							or jsonb_typeof(m -> 'id') <> 'string' or (m ->> 'id') !~ c_uuid
							or jsonb_typeof(m -> 'line') <> 'number' or (m ->> 'line') !~ '^[1-9][0-9]{0,8}$')) then
			v_bad := array_append(v_bad, 'sections');
		-- Names are unique ignoring case as the database compares them (lower(), the index's unique key), which can
		-- join two names the parser keeps apart; and an id is listed once in the whole file.
		else
			if (select count(distinct lower(s ->> 'name')) from jsonb_array_elements(p_parse -> 'sections') s)
					<> jsonb_array_length(p_parse -> 'sections') then
				v_named := public.qorpera_company_state_problem('value', null, null,
					'two sections have the same name when case is ignored; rename one');
			end if;
			if (select count(*) <> count(distinct m ->> 'id') from jsonb_array_elements(p_parse -> 'sections') s,
					jsonb_array_elements(s -> 'members') m) then
				v_bad := array_append(v_bad, 'sections');
			end if;
		end if;
	elsif p_kind = 'connection' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['account','actions','connectedAt','connectedBy','id','kind','purpose','service','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if jsonb_typeof(p_parse -> 'service') is distinct from 'string' or (p_parse ->> 'service') !~ '^[a-z][a-z0-9_-]{0,63}$' then
			v_bad := array_append(v_bad, 'service'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'account', 1, 254) then v_bad := array_append(v_bad, 'account'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('connected','broken') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'actions') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'actions') a
				where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$')
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'actions') a) <> jsonb_array_length(p_parse -> 'actions') then
			v_bad := array_append(v_bad, 'actions'); end if;
		if coalesce(p_parse ->> 'connectedBy', '') !~ c_uuid then v_bad := array_append(v_bad, 'connectedBy'); end if;
		-- The parser's canonical instant: seconds always, a fraction without trailing zeros, UTC.
		if jsonb_typeof(p_parse -> 'connectedAt') is distinct from 'string'
			or (p_parse ->> 'connectedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{0,5}[1-9])?Z$' then
			v_bad := array_append(v_bad, 'connectedAt');
		else
			begin
				perform (p_parse ->> 'connectedAt')::timestamptz;
			exception when others then v_bad := array_append(v_bad, 'connectedAt');
			end;
		end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string' or octet_length(p_parse ->> 'purpose') > 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	elsif p_kind = 'rule' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['id','kind','outcome','text'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if coalesce(p_parse ->> 'outcome', '') not in ('ask-first','allow') then v_bad := array_append(v_bad, 'outcome'); end if;
		-- One line of 1-280 characters, trimmed, no controls: the rule table's own check on when_text.
		if not public.qorpera_company_state_one_line(p_parse -> 'text', 1, 280) then v_bad := array_append(v_bad, 'text'); end if;
	elsif p_kind = 'todo' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['detail','id','kind','requestedBy','status','title'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'title', 1, 200, true) then v_bad := array_append(v_bad, 'title'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('open','blocked','done','cancelled') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'requestedBy') <> 'null' and coalesce(p_parse ->> 'requestedBy', '') !~ c_uuid then
			v_bad := array_append(v_bad, 'requestedBy'); end if;
		if jsonb_typeof(p_parse -> 'detail') is distinct from 'string' or octet_length(p_parse ->> 'detail') > 4000
			or (p_parse ->> 'detail') <> btrim(p_parse ->> 'detail', E' \t\n\r') then
			v_bad := array_append(v_bad, 'detail'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;
	return case when v_named is null then '[]'::jsonb else jsonb_build_array(v_named) end
		|| case when cardinality(v_bad) = 0 then '[]'::jsonb else jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
			'the platform read this file differently from its rules (' || array_to_string(v_bad, ', ') || ')')) end;
end $$;

create or replace function public.qorpera_company_state_checked(p_entry jsonb, p_path text, p_key text, p_file jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_kind text := public.qorpera_structured_path_kind(p_key); v_entry jsonb := p_entry; v_problems jsonb;
begin
	v_problems := public.qorpera_company_state_path_problems(p_path, false);
	if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	if v_entry is null or v_entry ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the platform could not read this file; save it again')));
	end if;
	if jsonb_typeof(v_entry -> 'problems') = 'array' then
		return jsonb_build_object('ok', false, 'problems', (select coalesce(jsonb_agg(p.value), '[]'::jsonb)
			from (select value from jsonb_array_elements(v_entry -> 'problems') limit 51) p));
	end if;
	if jsonb_typeof(v_entry -> 'text') is distinct from 'string' or jsonb_typeof(v_entry -> 'parserVersion') is distinct from 'number'
		or encode(extensions.digest(convert_to(v_entry ->> 'text', 'utf8'), 'sha256'), 'hex') is distinct from p_file ->> 'fileSha256' then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the text read does not match the saved file; save it again')));
	end if;
	if v_kind in ('vision','agent','group','sections','connection','rule','todo') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 3. The rules of a todo file -----------------------------------------------------------------------------------------

-- The agent whose folder holds a todo key (agents/<h>/todos/<name>.md): its indexed, unretired agent.md.
create function public.qorpera_company_state_todo_owner(p_environment_id uuid, p_key text)
returns uuid language sql stable set search_path = '' as $$
	select s.staff_agent_id from public.qorpera_profile_staff s
	where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
		and public.qorpera_folder_key(s.folder_path) = regexp_replace(p_key, '/todos/[^/]+[.]md$', '/agent.md')
$$;

-- A todo's key: its file name without .md.
create function public.qorpera_company_state_todo_key(p_path text)
returns text language sql immutable set search_path = '' as $$
	select regexp_replace(regexp_replace(p_path, '^.*/', ''), '[.]md$', '')
$$;

-- One todo file (§2): it lives in an agent's folder (an indexed agent, or the agent.md the same unit writes, as a hire
-- with its first todo); the id never changes and belongs to this file's todo only; a closed todo stays closed; done
-- waits for its working workers; a changed requested_by is a member.
create function public.qorpera_company_state_todo_rules(p_environment_id uuid, p_profile_id uuid, p_key text, p_parse jsonb,
	p_owner_in_unit boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_row public.qorpera_runtime_agent_todos%rowtype;
	v_exists boolean; v_problem text; v_prev jsonb;
begin
	-- The saved version is trusted only when the index points at this path for its todo.
	if v_base is not null and (jsonb_array_length(public.qorpera_company_state_parse_problems('todo', v_base)) > 0
		or not exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.id = (v_base ->> 'id')::uuid and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and public.qorpera_folder_key(t.folder_path) = p_key)) then
		v_base := null; end if;
	select * into v_row from public.qorpera_runtime_agent_todos where id = (p_parse ->> 'id')::uuid;
	v_exists := found;
	-- A restore has no saved version at its path: the saved version is the todo's last file.
	v_prev := v_base;
	if v_prev is null and v_exists and v_row.profile_id = p_profile_id and v_row.folder_environment_id = p_environment_id
		and v_row.folder_retired_at is not null then
		select v.structured -> 'parse' into v_prev from public.qorpera_folder_path_versions v where v.version = v_row.folder_path_version;
		if v_prev is not null and jsonb_array_length(public.qorpera_company_state_parse_problems('todo', v_prev)) > 0 then
			v_prev := null; end if;
	end if;
	if public.qorpera_company_state_todo_owner(p_environment_id, p_key) is null and not p_owner_in_unit then
		v_problem := 'a todo lives in an agent''s folder, next to its agent.md';
	elsif v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	elsif v_exists and (v_row.profile_id <> p_profile_id or v_row.folder_path is null
		or v_row.folder_environment_id is distinct from p_environment_id) then
		v_problem := 'this id belongs to another todo; give this todo a new id';
	elsif v_exists and v_row.folder_retired_at is null and public.qorpera_folder_key(v_row.folder_path) <> p_key then
		v_problem := 'this id belongs to the todo at ' || left(v_row.folder_path, 100) || '; give this todo a new id';
	elsif v_prev is not null and v_prev ->> 'status' in ('done','cancelled') and p_parse ->> 'status' <> v_prev ->> 'status' then
		v_problem := 'a closed todo is not opened again; write a new todo';
	elsif p_parse ->> 'status' = 'done' and exists (select 1 from public.qorpera_runtime_workers w
		where w.todo_id = (p_parse ->> 'id')::uuid and w.state = 'active') then
		v_problem := 'a worker is still at work on this todo; wait for it or cancel it first';
	elsif jsonb_typeof(p_parse -> 'requestedBy') = 'string'
		and (v_prev is null or v_prev ->> 'requestedBy' is distinct from p_parse ->> 'requestedBy')
		and not exists (select 1 from public.qorpera_profile_members m
			where m.profile_id = p_profile_id and m.user_id = (p_parse ->> 'requestedBy')::uuid) then
		v_problem := 'requested_by is a member of this company';
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- One todo file's row. A second change set that wrote another file with the same new id first makes this one abort (its
-- retry is refused by decide).
create function public.qorpera_company_state_index_todo(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_count bigint; v_owner uuid := public.qorpera_company_state_todo_owner(p_environment_id, public.qorpera_folder_key(p_path));
begin
	insert into public.qorpera_runtime_agent_todos as t(id, profile_id, environment_id, staff_agent_id, todo_key, title, detail, state,
		requested_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
	values ((p_parse ->> 'id')::uuid, p_profile_id, p_environment_id, v_owner, public.qorpera_company_state_todo_key(p_path),
		p_parse ->> 'title', p_parse ->> 'detail', p_parse ->> 'status', (p_parse ->> 'requestedBy')::uuid,
		p_environment_id, p_path, p_version, p_commit_id)
	on conflict (id) do update set staff_agent_id = excluded.staff_agent_id, todo_key = excluded.todo_key, title = excluded.title,
		detail = excluded.detail, state = excluded.state, requested_by_user_id = excluded.requested_by_user_id,
		folder_path = excluded.folder_path, folder_path_version = excluded.folder_path_version, folder_commit_id = excluded.folder_commit_id,
		folder_retired_at = null, revision = t.revision + 1, updated_at = clock_timestamp()
	where t.profile_id = excluded.profile_id and t.folder_environment_id = excluded.folder_environment_id
		and (t.folder_retired_at is not null or public.qorpera_folder_key(t.folder_path) = public.qorpera_folder_key(excluded.folder_path));
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A todo id was taken by another change set' using errcode = '23505'; end if;
end $$;

-- 4. The hooks, with the todo branches ------------------------------------------------------------------------------

create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare
	v_profile uuid; v_unit jsonb; v_op text; v_key text; v_entry jsonb; v_staff record; v_room uuid;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	if v_profile is null then return; end if;
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		if v_op in ('write','new_folder') then
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent' and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid
			loop
				rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || (v_entry -> 'parse' ->> 'id'); mode := 'nokeyupdate';
				return next;
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				select s.display_name, s.employment_status, s.folder_retired_at into v_staff from public.qorpera_profile_staff s
				where s.profile_id = v_profile and s.staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid;
				if found and (v_staff.display_name is distinct from v_entry -> 'parse' ->> 'name'
					or v_staff.employment_status is distinct from v_entry -> 'parse' ->> 'status' or v_staff.folder_retired_at is not null) then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.profile_id = v_profile and r.bound_staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
						return next;
					end loop;
				end if;
			end loop;
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' in ('group','sections','rule','todo')
			loop
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				if v_entry ->> 'kind' = 'group' and coalesce(v_entry -> 'parse' ->> 'id', '') ~ c_uuid then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.id = (v_entry -> 'parse' ->> 'id')::uuid and r.profile_id = v_profile and r.folder_path is not null loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
						return next;
					end loop;
				end if;
			end loop;
		elsif v_op in ('delete','move') then
			v_key := public.qorpera_folder_key(case when v_op = 'move' then v_unit ->> 'from' else v_unit ->> 'path' end);
			if v_key like 'agents/%' then
				for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_path is not null and s.deleted_at is null
						and (public.qorpera_folder_key(s.folder_path) = v_key
							or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || v_staff.staff_agent_id::text; mode := 'nokeyupdate';
					return next;
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					if v_op = 'delete' and v_staff.employment_status = 'active' then
						for v_room in select r.id from public.qorpera_company_rooms r
							where r.profile_id = v_profile and r.bound_staff_agent_id = v_staff.staff_agent_id loop
							rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
							return next;
						end loop;
					end if;
				end loop;
				for v_room in select r.id from public.qorpera_company_rooms r
					where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
						and (public.qorpera_folder_key(r.folder_path) = v_key
							or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		end if;
	end loop;
end $$;

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
	v_entries jsonb; v_ids text[] := '{}'; v_cofounders integer := 0; v_groups text[] := '{}'; v_connections text[] := '{}';
	v_rules text[] := '{}'; v_rule_bytes bigint := 0; v_todos text[] := '{}'; v_agent_files text[];
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	v_key := public.qorpera_folder_key(p_eff_path);

	if v_op in ('delete','move') then
		if public.qorpera_company_state_seeded(v_key) then return jsonb_build_object('ok', false, 'reason', 'seeded'); end if;
		select s.folder_path into v_cofounder_path from public.qorpera_company_cofounders c
			join public.qorpera_profile_staff s on s.profile_id = c.profile_id and s.staff_agent_id = c.staff_agent_id
		where c.profile_id = v_profile and s.folder_environment_id = p_environment_id;
		-- The Co-Founder's agent.md and its folder are never deleted; the folder only moves within agents/ (the
		-- kind-change rule refuses anywhere else), and the file never moves alone.
		if v_cofounder_path is not null and v_op = 'delete'
			and (public.qorpera_folder_key(v_cofounder_path) = v_key
				or public.qorpera_folder_key(v_cofounder_path) like public.qorpera_folder_under(v_key)) then
			return jsonb_build_object('ok', false, 'reason', 'cofounder'); end if;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		-- An agent.md or group.md never goes alone: its folder is deleted or moved instead.
		if v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) in ('agent','group') then
			return jsonb_build_object('ok', false, 'reason', 'lone_structured_file'); end if;
		-- A connection's file goes only when the platform removes it after a disconnect.
		if v_op = 'delete' and v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) = 'connection'
			and (p_actor ->> 'kind' is distinct from 'platform'
				or exists (select 1 from public.qorpera_folder_connection_index i
					join public.qorpera_cloud_secrets s on s.id = i.secret_id
					where i.environment_id = p_environment_id and i.retired_at is null
						and public.qorpera_folder_key(i.folder_path) = v_key and s.status = 'active')) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a connection''s file goes when its account is disconnected in Settings'))); end if;
		-- A todo with a working worker stays where it is, its folder too: cancel the worker first.
		if exists (select 1 from public.qorpera_runtime_agent_todos t
			join public.qorpera_runtime_workers w on w.todo_id = t.id and w.state = 'active'
			where t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a todo here has a worker at work; cancel the worker first'))); end if;
		if v_op = 'move' and exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))
				and not exists (select 1 from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
						and regexp_replace(public.qorpera_folder_key(p_eff_to || substr(t.folder_path, char_length(p_eff_path) + 1)),
								'/todos/[^/]+[.]md$', '/agent.md')
							= case when public.qorpera_folder_key(s.folder_path) = v_key
									or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key)
								then public.qorpera_folder_key(p_eff_to || substr(s.folder_path, char_length(p_eff_path) + 1))
								else public.qorpera_folder_key(s.folder_path) end)) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a todo moves only into an agent''s todos folder'))); end if;
		if v_op = 'move' then return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row); end if;
		return jsonb_build_object('ok', true);
	end if;

	if v_op = 'copy' then
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row);
	end if;

	if v_op = 'mkdir' then
		v_problems := public.qorpera_company_state_path_problems(p_eff_path, true);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;

	-- write or new_folder: the folders a new folder brings are checked by name; every structured file it writes
	-- is checked, then its database rules.
	if v_op = 'new_folder' then
		for v_content in select to_jsonb(c) from (select p_eff_path as path union all
			select s.path from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s where s.kind = 'folder') c loop
			v_problems := public.qorpera_company_state_path_problems(v_content ->> 'path', true);
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		end loop;
	end if;
	v_entries := public.qorpera_company_state_entries(p_unit);
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		if public.qorpera_structured_path_kind(v_file.key) is null then continue; end if;
		v_checked := public.qorpera_company_state_checked(v_entries -> v_file.key, v_file.path, v_file.key, v_file.file);
		if not (v_checked ->> 'ok')::boolean then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_checked -> 'problems'); end if;
		if v_checked ->> 'kind' = 'agent' then
			-- One id per agent, and one Co-Founder, within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_ids) or (v_checked -> 'parse' ->> 'agentKind' = 'co-founder' and v_cofounders > 0) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two agent.md files in one change carry the same id or kind'))); end if;
			v_ids := array_append(v_ids, v_checked -> 'parse' ->> 'id');
			if v_checked -> 'parse' ->> 'agentKind' = 'co-founder' then v_cofounders := v_cofounders + 1; end if;
			v_rule := public.qorpera_company_state_agent_rules(p_environment_id, v_profile, p_actor, v_file.path, v_file.key,
				v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
			-- An agent never takes a conversation's id: sections.md lists both kinds by id.
			if exists (select 1 from public.qorpera_company_rooms r where r.id = (v_checked -> 'parse' ->> 'id')::uuid) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'this id belongs to a conversation; give this agent a new id'))); end if;
		elsif v_checked ->> 'kind' = 'group' then
			-- One id per group chat within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_groups) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two group.md files in one change carry the same id'))); end if;
			v_groups := array_append(v_groups, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_group_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'sections' then
			v_rule := public.qorpera_company_state_sections_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'connection' then
			-- One file per connection within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_connections) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two connection files in one change carry the same id'))); end if;
			v_connections := array_append(v_connections, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_connection_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'rule' then
			-- One file per rule within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_rules) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two rule files in one change carry the same id'))); end if;
			v_rule := public.qorpera_company_state_rule_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse',
				v_rules, v_rule_bytes);
			if v_rule is not null then return v_rule; end if;
			v_rules := array_append(v_rules, v_checked -> 'parse' ->> 'id');
			v_rule_bytes := v_rule_bytes + octet_length(v_checked -> 'parse' ->> 'text');
		elsif v_checked ->> 'kind' = 'todo' then
			-- One file per todo within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_todos) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two todo files in one change carry the same id'))); end if;
			v_todos := array_append(v_todos, v_checked -> 'parse' ->> 'id');
			-- The agent.md files this unit writes, read once for the whole unit.
			if v_agent_files is null then
				v_agent_files := array(select o.key from public.qorpera_company_state_unit_files(p_unit, p_eff_path) o
					where v_entries -> o.key ->> 'kind' is not distinct from 'agent'); end if;
			v_rule := public.qorpera_company_state_todo_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse',
				regexp_replace(v_file.key, '/todos/[^/]+[.]md$', '/agent.md') = any (v_agent_files));
			if v_rule is not null then return v_rule; end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

create or replace function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_user uuid; v_file record; v_kind text; v_entry jsonb; v_version uuid;
	v_key text; v_staff record; v_room record; v_connection record; v_new_path text; v_actor jsonb; v_entries jsonb;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select jsonb_build_object('kind', c.actor_kind, 'requesterUserId', c.requester_id) into v_actor
	from public.qorpera_folder_commits c where c.id = p_commit_id;
	v_user := public.qorpera_company_state_actor_user(v_profile, case v_actor ->> 'kind'
		when 'member' then jsonb_build_object('kind', 'member', 'userId', v_actor ->> 'requesterUserId') else v_actor end);

	if v_op in ('write','new_folder') then
		v_entries := public.qorpera_company_state_entries(p_unit);
		-- Todos last, so an agent the same unit brings is indexed before its todos.
		for v_file in select f.* from public.qorpera_company_state_unit_files(p_unit, p_eff_path) f
			order by public.qorpera_structured_path_kind(f.key) is not distinct from 'todo' loop
			v_kind := public.qorpera_structured_path_kind(v_file.key);
			if v_kind is null then continue; end if;
			v_entry := v_entries -> v_file.key;
			update public.qorpera_folder_path_versions set structured = jsonb_build_object('kind', v_kind, 'parse', v_entry -> 'parse',
				'parserVersion', v_entry -> 'parserVersion')
			where commit_id = p_commit_id and unit_no = p_unit_no and key_sha256 = extensions.digest(v_file.key, 'sha256')
			returning version into v_version;
			if v_version is null then raise exception 'A structured file has no version in its commit' using errcode = 'XX000'; end if;
			if v_kind = 'vision' then
				insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version, vision_seeded, commit_id)
				values (p_environment_id, v_profile, v_entry -> 'parse' ->> 'name', v_version, v_actor ->> 'kind' = 'platform', p_commit_id)
				on conflict (environment_id) do update set name = excluded.name, vision_path_version = excluded.vision_path_version,
					vision_seeded = false, commit_id = excluded.commit_id, updated_at = clock_timestamp();
			elsif v_kind = 'agent' then
				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
			elsif v_kind = 'group' then
				perform public.qorpera_company_state_index_group(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse');
			elsif v_kind = 'sections' then
				perform public.qorpera_company_state_index_sections(v_profile, v_user, v_entry -> 'parse');
			elsif v_kind = 'connection' then
				perform public.qorpera_company_state_index_connection(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'rule' then
				perform public.qorpera_company_state_index_rule(p_environment_id, v_profile, p_commit_id, v_user, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'todo' then
				perform public.qorpera_company_state_index_todo(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			end if;
		end loop;
		return;
	end if;

	if v_op = 'move' then
		-- Moved structured files keep their parse on their new versions.
		update public.qorpera_folder_path_versions v set structured = p.structured
		from public.qorpera_folder_path_versions p
		where v.commit_id = p_commit_id and v.unit_no = p_unit_no and v.op = 'move_in' and v.prior_version = p.version
			and p.structured is not null;
		-- The roster and the group chats follow their folders: a rename keeps the id, and so the thread and history.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.folder_path from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_staff.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved agent.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_profile_staff set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1,
				updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
		end loop;
		for v_room in select r.id, r.folder_path from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_room.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved group.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_company_rooms set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
		end loop;
		-- Connection files follow their path; the vault row is never touched.
		for v_connection in select i.secret_id, i.folder_path from public.qorpera_folder_connection_index i
			where i.environment_id = p_environment_id and i.retired_at is null
				and (public.qorpera_folder_key(i.folder_path) = v_key
					or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved connection file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_folder_connection_index set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, commit_id = p_commit_id, updated_at = clock_timestamp()
			where secret_id = v_connection.secret_id;
		end loop;
		-- Rule files follow their path; the rule keeps its id, so review records still cite it.
		for v_connection in select r.id, r.folder_path from public.qorpera_review_rules r
			where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved rule file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_review_rules set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, updated_at = clock_timestamp()
			where id = v_connection.id;
		end loop;
		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the
		-- roster rows above were repointed).
		for v_connection in select t.id, t.folder_path from public.qorpera_runtime_agent_todos t
			where t.profile_id = v_profile and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved todo file has no version in its commit' using errcode = 'XX000'; end if;
			v_new_path := (select e.path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256'));
			update public.qorpera_runtime_agent_todos set folder_path = v_new_path, folder_path_version = v_version,
				folder_commit_id = p_commit_id, todo_key = public.qorpera_company_state_todo_key(v_new_path),
				staff_agent_id = public.qorpera_company_state_todo_owner(p_environment_id, public.qorpera_folder_key(v_new_path)),
				revision = revision + 1, updated_at = clock_timestamp()
			where id = v_connection.id;
		end loop;
		return;
	end if;

	if v_op = 'delete' then
		-- Deleting an agent's folder retires it: its runs are fenced (archived), its conversations stay, and a restore
		-- of the folder brings the row back.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_profile_staff set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
				version = version + 1, updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			if v_staff.employment_status = 'active' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			end if;
		end loop;
		-- Deleting a group chat's folder closes the chat; its conversation stays, and a restore reopens both.
		for v_room in select r.id, r.session_id from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_company_rooms set status = 'archived', folder_retired_at = clock_timestamp(),
				folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
			update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
			where id = v_room.session_id and status <> 'closed';
		end loop;
		-- A connection's file removed (after its account was disconnected): its index row retires.
		update public.qorpera_folder_connection_index i set retired_at = clock_timestamp(), commit_id = p_commit_id, updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (public.qorpera_folder_key(i.folder_path) = v_key
				or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key));
		-- A todo file removed: an open or blocked todo is cancelled, the row retires, and its key becomes a tombstone with a
		-- '.' (no file name has one) and the whole id, so a new file of that name is free and two tombstones never meet; a
		-- restore brings the key back.
		update public.qorpera_runtime_agent_todos t set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
			state = case when t.state in ('open','blocked') then 'cancelled' else t.state end,
			todo_key = left(t.todo_key, 31) || '.' || replace(t.id::text, '-', ''),
			revision = t.revision + 1, updated_at = clock_timestamp()
		where t.profile_id = v_profile and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
			and (t.folder_path = v_key collate "C"
				or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"));
		-- A rule file removed: the rule is archived (review records keep citing it); a restore brings it back.
		update public.qorpera_review_rules r set archived_at = clock_timestamp(), folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
			and (public.qorpera_folder_key(r.folder_path) = v_key
				or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key));
	end if;
end $$;

create or replace function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_profile_staff s
		where s.folder_environment_id = p_environment_id and s.folder_path is not null and s.folder_commit_id = p_commit_id
			and s.folder_retired_at is null
			and s.deleted_at is null and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
				and e.version = s.folder_path_version and e.path = s.folder_path))
		or exists (select 1 from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_commit_id = p_commit_id
				and r.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_connection_index c
			where c.environment_id = p_environment_id and c.commit_id = p_commit_id and c.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(c.folder_path), 'sha256')
					and e.version = c.folder_path_version and e.path = c.folder_path))
		or exists (select 1 from public.qorpera_review_rules r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_commit_id = p_commit_id
				and r.archived_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_path is not null and t.folder_commit_id = p_commit_id
				and t.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(t.folder_path), 'sha256')
					and e.version = t.folder_path_version and e.path = t.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 5. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_state_todo_owner(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_todo_key(text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_todo_rules(uuid, uuid, text, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_todo(uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
