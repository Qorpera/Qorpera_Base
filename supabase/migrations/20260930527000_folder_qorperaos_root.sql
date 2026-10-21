-- 20260930527000: the platform's folders live under one top folder, QorperaOS/ (Jonas, 21 October 2026: "bundle the
-- seeded folders inside of the "QorperaOS" folder ... you want to have clear view of what's about the platform and
-- what's about the company"; QORPERA-RUNTIME-CONTRACT.md 5.6). vision/, agents/ (with groups/ and sections.md),
-- rules/, connections/, skills/, contacts/, human-tasks/, interfaces/ and tables/ move below it, so
-- `vision/vision.md` is now `QorperaOS/vision/vision.md` and `agents/<handle>/agent.md` is
-- `QorperaOS/agents/<handle>/agent.md`. code/, members/ and the company's own work stay at the top. The TS twin is
-- packages/cloud-client/src/company-state-shared.ts (QORPERA_OS_ROOT, osPath, osRelative).
--
-- The name is written exactly QorperaOS; its folder key is qorperaos, and every key here is lowercase as before.
-- The case rule: a structured path is written as its key BELOW the root; the root itself is the folder's own
-- (qorpera_company_state_path_problems reads the names and the case below it, and accepts any spelling of the root
-- whose key is qorperaos, since a path is stored under its parent's spelling and the seed writes QorperaOS). So a
-- structured file's stored path is QorperaOS/<its key below the root>, no longer equal to its key, and every check
-- that compared a stored path with a key now compares keys (the todo and routine rows' ranges in
-- qorpera_folder_structured_decide, _apply and _targets).
--
-- 1. qorpera_os_relative(path): the part of a path or a key below QorperaOS/ ('' for the root, null outside it).
-- 2. The classifiers read below the root: qorpera_structured_path_kind and qorpera_structured_folder_names (their
--    positions count below the root, as before), and the seeded list, which now holds the root itself.
-- 3. qorpera_company_state_path_problems: names and the case rule below the root.
-- 4. Every key literal, range scan and anchored pattern of the nine roots gains the qorperaos/ prefix, positions in
--    stored paths and keys move one part right, messages name QorperaOS/..., and the paths the platform writes
--    (connection and hook files, the Co-Founder's first todo, the rules/ resource) are spelled QorperaOS/....
--
-- There are no users: every company is a test company, nothing is migrated and nothing of the old layout is kept.
-- A company made before this migration keeps its files at the old roots, where they are now ordinary files; it is
-- deleted and made again.
--
-- Deploy order, in one cut: this migration, the runtime roll, the object gateway (its creation worker seeds
-- QorperaOS/), the web; then the test companies are made again.

set local lock_timeout = '3s';

create function pg_temp.os527_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception '20260930527000 anchor differs in % (% expected): %', p_function, p_count, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The root ---------------------------------------------------------------------------------------------------------

-- The TS twin is osRelative. The root is matched by its key, as the folder finds it.
create function public.qorpera_os_relative(p_path text)
returns text language sql immutable parallel safe strict set search_path = '' as $$
	-- 20260930527000
	select case when public.qorpera_folder_key(split_part(p_path, '/', 1)) = 'qorperaos'
		then substr(p_path, char_length(split_part(p_path, '/', 1)) + 2) end
$$;
revoke all on function public.qorpera_os_relative(text) from public, anon, authenticated, service_role;

-- 2. The classifiers --------------------------------------------------------------------------------------------------

create or replace function public.qorpera_structured_path_kind(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930527000: every structured file is under qorperaos/; below it the kinds are as before.
	select case
		when r.k is null then null
		when r.k = 'vision/vision.md' then 'vision'
		when r.k = 'agents/sections.md' then 'sections'
		-- 20260930060000 (E1): a hook's and a mailbox's files, before the vault's.
		when r.k ~ '^connections/hook-[^/]*\.md$' then 'hook'
		when r.k ~ '^connections/mailbox-[^/]*\.md$' then 'mailbox'
		when r.k ~ '^connections/[^/]*\.md$' then 'connection'
		-- 20260930230000 (E8a): the company's network rules.
		when r.k = 'rules/network.toml' then 'network-rules'
		when r.k ~ '^rules/[^/]*\.md$' then 'rule'
		-- 20260929999000 (H1): a human task and a contact.
		when r.k ~ '^human-tasks/[^/]*\.md$' then 'human-task'
		when r.k ~ '^contacts/[^/]*\.md$' then 'contact'
		-- 20260930016000 (P16): interfaces and tables.
		when r.k = 'interfaces/order.md' then 'interface-order'
		when r.k ~ '^interfaces/[^/]+/interface\.toml$' then 'interface'
		when r.k ~ '^tables/[^/]+/table\.toml$' then 'table'
		when r.k ~ '^tables/[^/]+/rows\.csv$' then 'table-rows'
		when r.k ~ '^agents/groups/[^/]+/group\.md$' then 'group'
		-- 20260930111000 (M1a): a group chat's summary tree.
		when r.k ~ '^agents/groups/[^/]+/memory/tree\.toml$' then 'memory-tree'
		when r.k ~ '^agents/groups/[^/]+/memory/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): a group chat's run logs.
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
		when r.k ~ '^agents/(groups|sections\.md)(/|$)' then null
		when r.k ~ '^agents/[^/]+/agent\.md$' then 'agent'
		-- 20260930111000 (M1a): an agent's thread's summary tree.
		when r.k ~ '^agents/[^/]+/memory/thread/tree\.toml$' then 'memory-tree'
		when r.k ~ '^agents/[^/]+/memory/thread/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): an agent's thread's run logs.
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
		when r.k ~ '^agents/[^/]+/routines/[^/]*\.md$' then 'routine'
		when r.k ~ '^agents/[^/]+/todos/[^/]*\.md$' then 'todo'
		when r.k ~ '^agents/[^/]+/todos/[^/]+/[^/]+/brief\.md$' then 'worker-brief'
		when r.k ~ '^agents/[^/]+/todos/[^/]+/[^/]+/results\.md$' then 'worker-results'
	end
	from (select public.qorpera_os_relative(p_key) as k) r
$$;

-- Each place's number counts the key's parts below the root (qorpera_company_state_path_problems reads the written
-- path's parts below it the same way).
create or replace function public.qorpera_structured_folder_names(p_key text)
returns text[] language sql immutable parallel safe set search_path = '' as $$
	select case
		when r.k is null then null
		-- 20260930527000: QorperaOS/ itself is a place: it holds the platform's folders.
		when r.k = '' then array[]::text[]
		-- 20260929999000 (H1): the two roots are places, and a task's folder is named.
		when r.k in ('contacts', 'human-tasks') then array[]::text[]
		-- 20260930016000 (P16): interfaces and tables.
		when r.k in ('interfaces', 'tables') then array[]::text[]
		when r.k ~ '^interfaces/[^/]+$' then array['2:an interface''s folder']
		when r.k ~ '^tables/[^/]+$' then array['2:a table''s folder']
		when r.k ~ '^human-tasks/[^/]+(/proof)?$' then array['2:a human task''s folder']
		when r.k = 'agents/groups' then array[]::text[]
		when r.k ~ '^agents/groups/[^/]+$' then array['3:a group chat''s folder']
		when r.k ~ '^agents/(groups|sections\.md)(/|$)' then null
		when r.k ~ '^agents/[^/]+$' then array['2:an agent''s folder']
		when r.k ~ '^agents/[^/]+/(routines|todos)$' then array['2:an agent''s folder']
		when r.k ~ '^agents/[^/]+/todos/[^/]+$' then array['2:an agent''s folder', '4:the todo''s folder']
		when r.k ~ '^agents/[^/]+/todos/[^/]+/[^/]+$' then array['2:an agent''s folder', '4:the todo''s folder', '5:the worker''s folder']
	end
	from (select public.qorpera_os_relative(p_key) as k) r
$$;

create or replace function public.qorpera_company_state_seeded(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260930527000: QorperaOS/ itself, and the seeded folders and files below it.
	select p_key = any (array['qorperaos','qorperaos/vision','qorperaos/vision/vision.md','qorperaos/agents',
		'qorperaos/agents/sections.md','qorperaos/agents/groups','qorperaos/connections','qorperaos/human-tasks',
		'qorperaos/contacts','qorperaos/skills','qorperaos/rules',
		-- 20260930016000 (P16): interfaces/ and tables/, and the areas table.
		'qorperaos/interfaces','qorperaos/interfaces/order.md','qorperaos/tables','qorperaos/tables/areas',
		'qorperaos/tables/areas/table.toml','qorperaos/tables/areas/rows.csv'])
	-- 20260929999980 (H2): human-tasks/ and contacts/ are fixed folders (Jonas, 2 October 2026).
$$;

-- 3. The names and the case rule --------------------------------------------------------------------------------------

create or replace function public.qorpera_company_state_path_problems(p_path text, p_folder boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_path text := p_path; v_key text; v_kind text; v_places text[]; v_place text; v_written text[];
	v_named jsonb := '[]'::jsonb; v_name text; v_problems jsonb := '[]'::jsonb; v_item jsonb; v_below text;
begin
	if p_folder then v_path := regexp_replace(v_path, '/+$', ''); end if;
	v_key := public.qorpera_folder_key(v_path);
	-- 20260930527000: every structured place is under QorperaOS/. The names and the case rule are read below the root;
	-- the root is the folder's own, in any spelling with its key.
	v_below := public.qorpera_os_relative(v_path);
	if v_below is null then return '[]'::jsonb; end if;
	v_written := string_to_array(v_below, '/');
	if p_folder then
		-- 20260930230000 (E8a): the network rules' path is a file's.
		if v_key = 'qorperaos/rules/network.toml' then
			return jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
				'QorperaOS/rules/network.toml is the name of the network rules file, not a folder')); end if;
		v_places := public.qorpera_structured_folder_names(v_key);
		if v_places is null then return '[]'::jsonb; end if;
		foreach v_place in array v_places loop
			v_named := v_named || jsonb_build_array(jsonb_build_array(v_written[split_part(v_place, ':', 1)::integer],
				substr(v_place, strpos(v_place, ':') + 1)));
		end loop;
	else
		v_kind := public.qorpera_structured_path_kind(v_key);
		if v_kind is null then return '[]'::jsonb; end if;
		if v_kind = 'group' then v_named := jsonb_build_array(jsonb_build_array(v_written[3], 'a group chat''s folder'));
		elsif v_kind in ('interface','table','table-rows') then -- 20260930016000 (P16)
			v_named := jsonb_build_array(jsonb_build_array(v_written[2],
				case when v_kind = 'interface' then 'an interface''s folder' else 'a table''s folder' end));
		elsif v_kind in ('agent','routine','todo','worker-brief','worker-results') then
			v_named := jsonb_build_array(jsonb_build_array(v_written[2], 'an agent''s folder')); end if;
		if v_kind in ('routine','todo') then
			v_named := v_named || jsonb_build_array(jsonb_build_array(regexp_replace(v_written[4], '\.md$', '', 'i'), 'the file'));
		elsif v_kind in ('rule','connection','hook','mailbox','human-task','contact') then -- H1; 20260930060000 (E1)
			v_named := v_named || jsonb_build_array(jsonb_build_array(regexp_replace(v_written[2], '\.md$', '', 'i'), 'the file'));
		elsif v_kind in ('worker-brief','worker-results') then
			v_named := v_named || jsonb_build_array(jsonb_build_array(v_written[4], 'the todo''s folder'),
				jsonb_build_array(v_written[5], 'the worker''s folder'));
		end if;
	end if;
	for v_item in select value from jsonb_array_elements(v_named) loop
		v_name := v_item ->> 0;
		if v_name is null or char_length(v_name) > 64 or v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
			v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
				format('the name of %s (%s) must be lowercase letters a-z, digits and single hyphens, at most 64 characters',
					v_item ->> 1, left(coalesce(v_name, ''), 100))));
		end if;
	end loop;
	if not p_folder and v_kind not in ('vision','sections','interface','interface-order','table','table-rows', -- 20260930016000 (P16)
		'memory-tree','memory-block' /* 20260930111000 (M1a) */, 'network-rules' /* 20260930230000 (E8a) */,
		'memory-run','memory-steps','memory-run-block' /* 20260930231000 (W1b) */)
		and v_written[array_length(v_written, 1)] !~ '\.md$' then
		v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
			'the file name ends in .md, in lowercase'));
	elsif jsonb_array_length(v_problems) = 0 and v_below <> public.qorpera_folder_key(v_below) then
		v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
			'write the path below QorperaOS/ in lowercase, as QorperaOS/' || left(public.qorpera_folder_key(v_below), 100)));
	end if;
	return v_problems;
end $$;

-- 4. The other readers ------------------------------------------------------------------------------------------------

-- Pure helpers on keys.
create or replace function public.qorpera_company_state_task_stem(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930527000: under qorperaos/human-tasks/.
	select case when p_key ~ '^qorperaos/human-tasks/[^/]+\.md$' then substring(p_key from '^qorperaos/human-tasks/([^/]+)\.md$')
		when p_key ~ '^qorperaos/human-tasks/[^/]+(/|$)' then substring(p_key from '^qorperaos/human-tasks/([^/]+)') end
$$;

-- A worker's folder, QorperaOS/agents/<a>/todos/<t>/<w>, for a key or for a request's folder in its stored spelling.
create or replace function public.qorpera_company_state_worker_folder(p_key text)
returns text language sql immutable set search_path = '' as $$
	-- 20260930527000: one part right, below the root (any spelling of it).
	select case when public.qorpera_os_relative(p_key) is not null and split_part(p_key, '/', 2) = 'agents'
		and split_part(p_key, '/', 3) not in ('', 'groups', 'sections.md')
		and split_part(p_key, '/', 4) = 'todos' and split_part(p_key, '/', 5) <> '' and split_part(p_key, '/', 6) <> ''
		then array_to_string((string_to_array(p_key, '/'))[1:6], '/') end
$$;

create or replace function public.qorpera_company_state_worker_todo_file(p_folder_key text)
returns text language sql immutable set search_path = '' as $$
	-- 20260930527000: one part right.
	select array_to_string((string_to_array(p_folder_key, '/'))[1:4], '/') || '/' || split_part(p_folder_key, '/', 5) || '.md'
$$;

create or replace function public.qorpera_interface_folder(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930527000
	select case when p_key <> 'qorperaos/interfaces/order.md' then substring(p_key from '^(qorperaos/interfaces/[^/]+)(/|$)') end
$$;

create or replace function public.qorpera_interface_table_folder(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930527000
	select substring(p_key from '^(qorperaos/tables/[^/]+)(/|$)')
$$;

create or replace function public.qorpera_memory_tree_root_key(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930527000
	select case
		when p_key ~ '^qorperaos/agents/groups/[^/]+/memory(/|$)' then substring(p_key from '^qorperaos/agents/groups/[^/]+/memory')
		when p_key ~ '^qorperaos/agents/groups(/|$)' then null
		when p_key ~ '^qorperaos/agents/[^/]+/memory/thread(/|$)' then substring(p_key from '^qorperaos/agents/[^/]+/memory/thread')
	end
$$;

create or replace function public.qorpera_folder_coding_protected(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260930527000: under qorperaos/.
	select p_key in ('qorperaos/agents','qorperaos/rules') or p_key like 'qorperaos/agents/%' or p_key like 'qorperaos/rules/%'
		-- 20260930016000 (P16): interfaces/ and every table's table.toml.
		or p_key = 'qorperaos/interfaces' or p_key like 'qorperaos/interfaces/%' or p_key ~ '^qorperaos/tables/[^/]+/table\.toml$'
$$;

create or replace function public.qorpera_company_state_task_at(p_environment_id uuid, p_stem text)
returns public.qorpera_folder_human_task_index language sql stable set search_path = '' as $$
	select * from public.qorpera_folder_human_task_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = 'qorperaos/human-tasks/' || p_stem || '.md'
$$;

create or replace function public.qorpera_interface_area_rows(p_environment_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_definition jsonb := public.qorpera_interface_stored(p_environment_id, 'qorperaos/tables/areas/table.toml');
	v_rows jsonb := public.qorpera_interface_stored(p_environment_id, 'qorperaos/tables/areas/rows.csv');
begin
	-- 20260930371000 (I9b); 20260930527000
	if v_definition is null or v_rows is null then return '[]'::jsonb; end if;
	return coalesce(public.qorpera_interface_rows(v_definition, v_rows) -> 'rows', '[]'::jsonb);
end $$;

create or replace function public.qorpera_interface_mains(p_environment_id uuid)
returns table(key text, path text) language sql stable set search_path = '' as $$
	select e.key_text, e.path from public.qorpera_folder_entries e
		join public.qorpera_folder_path_versions v on v.version = e.version
	where e.environment_id = p_environment_id and e.kind = 'file' and e.key_text like 'qorperaos/interfaces/%/interface.toml'
		and v.structured ->> 'kind' = 'interface' and v.structured -> 'parse' -> 'main' = 'true'::jsonb
$$;

-- Agents' and group chats' folders: their stored paths are QorperaOS/agents/<handle>/agent.md and
-- QorperaOS/agents/groups/<name>/group.md, so a name is one part further right.
create or replace function public.qorpera_company_state_run_folder(p_environment_id uuid, p_staff_agent_id uuid, p_coworkers uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('agent', split_part(s.folder_path, '/', 3),
		'coworkers', coalesce((select jsonb_object_agg(c.staff_agent_id, split_part(c.folder_path, '/', 3))
			from public.qorpera_profile_staff c
			where c.profile_id = f.profile_id and c.staff_agent_id = any (p_coworkers) and c.staff_agent_id <> p_staff_agent_id
				and c.folder_environment_id = p_environment_id and c.folder_retired_at is null), '{}'::jsonb))
	from public.qorpera_company_files f
	join public.qorpera_profile_staff s on s.profile_id = f.profile_id and s.staff_agent_id = p_staff_agent_id
		and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
	where f.environment_id = p_environment_id and f.core = 'folder-v2'
$$;

create or replace function public.qorpera_memory_branch_list(p_environment_id uuid, p_staff_agent_id uuid, p_own_session_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	with candidates as (
		select 'thread:' || split_part(s.folder_path, '/', 3) as ref, 'thread' as kind, r.session_id, s.display_name as name
		from public.qorpera_profile_staff s
		join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
		where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
			and public.qorpera_folder_key(s.folder_path) ~ '^qorperaos/agents/[^/]+/agent\.md$'
			and public.qorpera_folder_key(s.folder_path) !~ '^qorperaos/agents/(groups|\.\.?)/'
			and (s.staff_agent_id = p_staff_agent_id or exists (select 1 from public.qorpera_company_cofounders c
				where c.environment_id = p_environment_id and c.staff_agent_id = p_staff_agent_id))
		union all
		select 'group:' || split_part(r.folder_path, '/', 4), 'group', r.session_id, r.name
		from public.qorpera_company_rooms r
		where r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.bound_staff_agent_id is null
			and public.qorpera_folder_key(r.folder_path) ~ '^qorperaos/agents/groups/[^/]+/group\.md$'
			and public.qorpera_folder_key(r.folder_path) !~ '^qorperaos/agents/groups/\.\.?/'
			and exists (select 1 from public.qorpera_company_room_members m where m.room_id = r.id
				and m.principal_kind = 'staff_agent' and m.principal_id = p_staff_agent_id and m.status = 'active')
	)
	select coalesce(jsonb_agg(jsonb_build_object('ref', b.ref, 'kind', b.kind, 'name', b.name, 'sessionId', b.session_id,
			'messages', b.messages) order by b.last_at desc nulls last, b.ref collate "C"), '[]'::jsonb)
	from (select c.ref, c.kind, coalesce(c.name, s.title) as name, c.session_id,
			(select count(*) from public.qorpera_session_events e where e.session_id = s.id
				and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision'))
				as messages,
			(select e.created_at from public.qorpera_session_events e where e.session_id = s.id
				and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
				order by e.sequence desc limit 1) as last_at
		from candidates c
		join public.qorpera_shared_sessions s on s.id = c.session_id and s.environment_id = p_environment_id
		where c.session_id is distinct from p_own_session_id) as b
$$;

create or replace function public.qorpera_memory_conversation(p_environment_id uuid, p_ref text, p_own_session_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_key text; v_session uuid;
begin
	if p_ref = '.' then
		v_session := p_own_session_id;
	elsif p_ref ~ '^thread:.' then
		v_key := public.qorpera_folder_key('QorperaOS/agents/' || substr(p_ref, 8) || '/agent.md');
		if v_key !~ '^qorperaos/agents/[^/]+/agent\.md$' or v_key ~ '^qorperaos/agents/(groups|\.\.?)/' then return null; end if;
		select r.session_id into v_session
		from public.qorpera_profile_staff s
		join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
		where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
			and s.folder_path is not null and public.qorpera_folder_key(s.folder_path) = v_key
		limit 1;
	elsif p_ref ~ '^group:.' then
		v_key := public.qorpera_folder_key('QorperaOS/agents/groups/' || substr(p_ref, 7) || '/group.md');
		if v_key !~ '^qorperaos/agents/groups/[^/]+/group\.md$' or v_key ~ '^qorperaos/agents/groups/\.\.?/' then return null; end if;
		select r.session_id into v_session
		from public.qorpera_company_rooms r
		where r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.folder_path is not null
			and public.qorpera_folder_key(r.folder_path) = v_key
		limit 1;
	end if;
	if v_session is null then return null; end if;
	return (select jsonb_build_object('sessionId', s.id,
			'kind', case when r.bound_staff_agent_id is not null then 'thread' when r.id is not null then 'group' else 'conversation' end,
			'name', coalesce(st.display_name, r.name, s.title))
		from public.qorpera_shared_sessions s
		left join public.qorpera_company_rooms r on r.session_id = s.id
		left join public.qorpera_profile_staff st on st.profile_id = r.profile_id and st.staff_agent_id = r.bound_staff_agent_id
		where s.id = v_session and s.environment_id = p_environment_id);
end $$;

create or replace function public.qorpera_memory_erase_roots(p_environment_id uuid, p_session_id uuid)
returns table(root_key text) language sql stable set search_path = '' as $$
	select distinct regexp_replace(k.key, '/tree\.toml$', '') collate "C"
	from public.qorpera_memory_erase_toml_manifests(p_session_id) m
	join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest_sha256
	cross join lateral (select public.qorpera_folder_key(v.path) as key) k
	where k.key ~ '^qorperaos/agents/groups/[^/]+/memory/tree\.toml$'
		or (k.key ~ '^qorperaos/agents/[^/]+/memory/thread/tree\.toml$' and k.key !~ '^qorperaos/agents/groups/')
$$;

create or replace function public.qorpera_memory_notebook_holds_root(p_environment_id uuid, p_key text)
returns boolean language sql stable set search_path = '' as $$
	select p_key ~ '^qorperaos/agents/[^/]+/memory$' and p_key !~ '^qorperaos/agents/groups/' and exists (select 1
		from public.qorpera_folder_entries e where e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(p_key || '/thread', 'sha256') and e.kind <> 'claim')
$$;

create or replace function public.qorpera_memory_root_owner(p_environment_id uuid, p_root_key text)
returns table(owner_kind text, owner_id uuid, session_id uuid) language sql stable set search_path = '' as $$
	select 'agent'::text, s.staff_agent_id, r.session_id
	from public.qorpera_profile_staff s
	left join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
	where p_root_key ~ '^qorperaos/agents/[^/]+/memory/thread$' and p_root_key !~ '^qorperaos/agents/groups/'
		and s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
		and public.qorpera_folder_key(s.folder_path) = regexp_replace(p_root_key, '/memory/thread$', '/agent.md')
	union all
	select 'group', r.id, r.session_id
	from public.qorpera_company_rooms r
	where p_root_key ~ '^qorperaos/agents/groups/[^/]+/memory$'
		and r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.folder_path is not null
		and public.qorpera_folder_key(r.folder_path) = regexp_replace(p_root_key, '/memory$', '/group.md')
	limit 1
$$;

-- Moving and copying folders: nothing below a root outside the structured roots under qorperaos/ can be structured. A
-- folder holding them is QorperaOS/ itself (never moved, but it may be copied): its contents are checked too, so a copy of
-- it lands no structured file as an ordinary one.
select pg_temp.os527_replace('public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$	if p_from_key !~ '^(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$)' -- P16
		and v_to_key !~ '^(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$)' then$old$,
	$new$	if p_from_key !~ '^qorperaos($|/(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$))' -- P16; 527000
		and v_to_key !~ '^qorperaos($|/(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$))' then$new$);

-- Interfaces and tables.
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$a folder above the roots is the company root, which no unit removes or moves$old$,
	$new$a folder above the roots is QorperaOS/ or the company root, which no unit removes or moves$new$);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$'^(interfaces|tables)(/|$)'$old$, $new$'^qorperaos/(interfaces|tables)(/|$)'$new$, 2);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$'^(interfaces(/|$)|tables(/[^/]+(/table\.toml)?)?$)'$old$, $new$'^qorperaos/(interfaces(/|$)|tables(/[^/]+(/table\.toml)?)?$)'$new$, 2);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$p_key ~ '^interfaces(/|$)'$old$, $new$p_key ~ '^qorperaos/interfaces(/|$)'$new$, 2);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$p_key ~ '^tables/[^/]+/(table\.toml|rows\.csv)$'$old$, $new$p_key ~ '^qorperaos/tables/[^/]+/(table\.toml|rows\.csv)$'$new$);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$e.key_text like 'interfaces/%/interface.toml'$old$, $new$e.key_text like 'qorperaos/interfaces/%/interface.toml'$new$);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$p_to_key ~ '^(interfaces|tables)/'$old$, $new$p_to_key ~ '^qorperaos/(interfaces|tables)/'$new$);
select pg_temp.os527_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$		if v_landing.key in ('interfaces','tables') and (v_landing.kind <> 'folder' or p_op in ('move','copy')) then
			return public.qorpera_interface_refused('placement', v_landing.key || '/ is a folder the company keeps; nothing lands on it');
		elsif v_landing.key like 'interfaces/%' and not (
			(v_landing.kind = 'file' and v_landing.key = 'interfaces/order.md')
			or (v_landing.kind = 'folder' and v_landing.key ~ '^interfaces/[^/]+$' and v_landing.key <> 'interfaces/order.md')
			or (v_landing.kind = 'file' and v_landing.key ~ '^interfaces/[^/]+/(interface\.toml|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'interfaces/ holds order.md and one folder per interface, each with interface.toml and README.md only');
		elsif v_landing.key like 'tables/%' and not (
			(v_landing.kind = 'folder' and v_landing.key ~ '^tables/[^/]+$')
			or (v_landing.kind = 'file' and v_landing.key ~ '^tables/[^/]+/(table\.toml|rows\.csv|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'tables/ holds one folder per table, each with table.toml, rows.csv and README.md only');
		elsif v_landing.key ~ '^(interfaces|tables)/[^/]+/readme\.md$' and v_name not in ('README.md', 'readme.md') then$old$,
	$new$		if v_landing.key in ('qorperaos/interfaces','qorperaos/tables') and (v_landing.kind <> 'folder' or p_op in ('move','copy')) then
			return public.qorpera_interface_refused('placement',
				'QorperaOS/' || public.qorpera_os_relative(v_landing.key) || '/ is a folder the company keeps; nothing lands on it');
		elsif v_landing.key like 'qorperaos/interfaces/%' and not (
			(v_landing.kind = 'file' and v_landing.key = 'qorperaos/interfaces/order.md')
			or (v_landing.kind = 'folder' and v_landing.key ~ '^qorperaos/interfaces/[^/]+$' and v_landing.key <> 'qorperaos/interfaces/order.md')
			or (v_landing.kind = 'file' and v_landing.key ~ '^qorperaos/interfaces/[^/]+/(interface\.toml|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'QorperaOS/interfaces/ holds order.md and one folder per interface, each with interface.toml and README.md only');
		elsif v_landing.key like 'qorperaos/tables/%' and not (
			(v_landing.kind = 'folder' and v_landing.key ~ '^qorperaos/tables/[^/]+$')
			or (v_landing.kind = 'file' and v_landing.key ~ '^qorperaos/tables/[^/]+/(table\.toml|rows\.csv|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'QorperaOS/tables/ holds one folder per table, each with table.toml, rows.csv and README.md only');
		elsif v_landing.key ~ '^qorperaos/(interfaces|tables)/[^/]+/readme\.md$' and v_name not in ('README.md', 'readme.md') then$new$);

select pg_temp.os527_replace('public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$e.key_text like 'interfaces/%/interface.toml'$old$, $new$e.key_text like 'qorperaos/interfaces/%/interface.toml'$new$);
select pg_temp.os527_replace('public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$v_folder = 'tables/areas'$old$, $new$v_folder = 'qorperaos/tables/areas'$new$, 5);
select pg_temp.os527_replace('public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$'tables/areas/ keeps owner and supervisor$old$, $new$'QorperaOS/tables/areas/ keeps owner and supervisor$new$);

select pg_temp.os527_replace('public.qorpera_company_state_interface_targets(uuid,jsonb)'::regprocedure,
	$old$if v_key = 'tables' then continue; end if;$old$, $new$if v_key = 'qorperaos/tables' then continue; end if;$new$);

select pg_temp.os527_replace('public.qorpera_folder_note_interface_changes(jsonb,jsonb)'::regprocedure,
	$old$public.qorpera_folder_key(v.path) ~ '^(interfaces|tables)/'$old$,
	$new$public.qorpera_folder_key(v.path) ~ '^qorperaos/(interfaces|tables)/'$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_note_interface_changes(jsonb,jsonb)'::regprocedure,
	$old$public.qorpera_folder_key(v.path) !~ '^tables/[^/]+/rows\.csv$'$old$,
	$new$public.qorpera_folder_key(v.path) !~ '^qorperaos/tables/[^/]+/rows\.csv$'$new$, 2);

select pg_temp.os527_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$~ '^(interfaces|tables)/'$old$, $new$~ '^qorperaos/(interfaces|tables)/'$new$, 2);

-- The areas table (I9b).
select pg_temp.os527_replace('public.qorpera_interface_agent_supervisor(uuid,uuid,text)'::regprocedure,
	$old$i.folder_key = 'tables/areas'$old$, $new$i.folder_key = 'qorperaos/tables/areas'$new$);
select pg_temp.os527_replace('public.qorpera_consent_interface_supervision(uuid,jsonb)'::regprocedure,
	$old$i.folder_key = 'tables/areas'$old$, $new$i.folder_key = 'qorperaos/tables/areas'$new$);
select pg_temp.os527_replace('public.qorpera_offer_interface_agent(uuid,jsonb)'::regprocedure,
	$old$i.folder_key = 'tables/areas'$old$, $new$i.folder_key = 'qorperaos/tables/areas'$new$);
select pg_temp.os527_replace('public.qorpera_interface_supervision_settle(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure,
	$old$if p_folder_key is distinct from 'tables/areas' then return; end if;$old$,
	$new$if p_folder_key is distinct from 'qorperaos/tables/areas' then return; end if;$new$);

-- Human tasks and contacts.
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$if p_key ~ '^human-tasks/[^/]+\.md$' then$old$, $new$if p_key ~ '^qorperaos/human-tasks/[^/]+\.md$' then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$extensions.digest('human-tasks/' || v_stem$old$, $new$extensions.digest('qorperaos/human-tasks/' || v_stem$new$, 4);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$'the task''s folder human-tasks/'$old$, $new$'the task''s folder QorperaOS/human-tasks/'$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$elsif p_key ~ '^contacts/[^/]*\.md$' and p_op = 'delete' then$old$,
	$new$elsif p_key ~ '^qorperaos/contacts/[^/]*\.md$' and p_op = 'delete' then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$p_key <> 'human-tasks/' || v_stem then$old$, $new$p_key <> 'qorperaos/human-tasks/' || v_stem then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$		if v_landing.key = 'human-tasks' and p_op in ('move','copy') then
			v_problem := 'human-tasks/ is made empty, with a new folder; nothing moves or copies onto it';
		elsif v_landing.key ~ '^human-tasks/[^/]+\.md$' then$old$,
	$new$		if v_landing.key = 'qorperaos/human-tasks' and p_op in ('move','copy') then
			v_problem := 'QorperaOS/human-tasks/ is made empty, with a new folder; nothing moves or copies onto it';
		elsif v_landing.key ~ '^qorperaos/human-tasks/[^/]+\.md$' then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$'a folder named human-tasks/'$old$, $new$'a folder named QorperaOS/human-tasks/'$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$		elsif v_landing.key ~ '^human-tasks/[^/]+$' and v_landing.kind <> 'folder' then
			v_problem := 'directly under human-tasks/ go only task files (.md) and task folders';$old$,
	$new$		elsif v_landing.key ~ '^qorperaos/human-tasks/[^/]+$' and v_landing.kind <> 'folder' then
			v_problem := 'directly under QorperaOS/human-tasks/ go only task files (.md) and task folders';$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$v_problem := 'human-tasks/' || left(v_stem, 64) || '/ belongs to the task human-tasks/' || left(v_stem, 64)$old$,
	$new$v_problem := 'QorperaOS/human-tasks/' || left(v_stem, 64) || '/ belongs to the task QorperaOS/human-tasks/' || left(v_stem, 64)$new$);

select pg_temp.os527_replace('public.qorpera_company_state_task_targets(uuid,jsonb)'::regprocedure,
	$old$if v_key ~ '^human-tasks/[^/]+\.md$' then$old$, $new$if v_key ~ '^qorperaos/human-tasks/[^/]+\.md$' then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_targets(uuid,jsonb)'::regprocedure,
	$old$elsif v_key ~ '^contacts/[^/]*\.md$' then$old$, $new$elsif v_key ~ '^qorperaos/contacts/[^/]*\.md$' then$new$);
select pg_temp.os527_replace('public.qorpera_company_state_task_targets(uuid,jsonb)'::regprocedure,
	$old$i.folder_key = 'human-tasks/' || v_stem || '.md'$old$, $new$i.folder_key = 'qorperaos/human-tasks/' || v_stem || '.md'$new$);

select pg_temp.os527_replace('public.qorpera_company_state_human_task_rules(uuid,uuid,jsonb,text,jsonb)'::regprocedure,
	$old$'human-tasks/' || v_stem$old$, $new$'qorperaos/human-tasks/' || v_stem$new$, 3);

-- A contact's task shows nothing under the folders outside readers may not see.
select pg_temp.os527_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$~ '^(agents|contacts|human-tasks|connections|rules|hooks)/'$old$,
	$new$~ '^(qorperaos/(agents|contacts|human-tasks|connections|rules)|hooks)/'$new$);

-- The folder listener's human-task wakes: the range scan and its pattern.
select pg_temp.os527_replace('public.qorpera_folder_listener_commit(uuid,jsonb)'::regprocedure,
	$old$				and public.qorpera_folder_key(v.path) collate "C" >= 'human-tasks/' collate "C"
				and public.qorpera_folder_key(v.path) collate "C" < 'human-tasks0' collate "C"
				and public.qorpera_folder_key(v.path) ~ '^human-tasks/[^/]+\.md$'$old$,
	$new$				and public.qorpera_folder_key(v.path) collate "C" >= 'qorperaos/human-tasks/' collate "C"
				and public.qorpera_folder_key(v.path) collate "C" < 'qorperaos/human-tasks0' collate "C"
				and public.qorpera_folder_key(v.path) ~ '^qorperaos/human-tasks/[^/]+\.md$'$new$);

-- Workers: an agent's folder, its todos and its workers' folders, one part right.
select pg_temp.os527_replace('public.qorpera_company_state_worker_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$'^agents/[^/]+$'$old$, $new$'^qorperaos/agents/[^/]+$'$new$, 3);
select pg_temp.os527_replace('public.qorpera_company_state_worker_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$'^agents/[^/]+/todos/[^/]+$'$old$, $new$'^qorperaos/agents/[^/]+/todos/[^/]+$'$new$);
select pg_temp.os527_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$v_agent_folder text := array_to_string((string_to_array(v_folder, '/'))[1:2], '/');$old$,
	$new$v_agent_folder text := array_to_string((string_to_array(v_folder, '/'))[1:3], '/');$new$);
select pg_temp.os527_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$w.worker_key = split_part(v_folder, '/', 5)$old$, $new$w.worker_key = split_part(v_folder, '/', 6)$new$, 2);
select pg_temp.os527_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$v_todo, split_part(v_folder, '/', 5),$old$, $new$v_todo, split_part(v_folder, '/', 6),$new$);
-- A worker request's folder is spelled as the worker's row keeps it (its wake's outputFolder): QorperaOS/agents/....
select pg_temp.os527_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$c_path constant text := '^agents/$old$, $new$c_path constant text := '^QorperaOS/agents/$new$);
select pg_temp.os527_replace('public.qorpera_folder_cancel_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$c_path constant text := '^agents/$old$, $new$c_path constant text := '^QorperaOS/agents/$new$);
select pg_temp.os527_replace('public.qorpera_folder_cancel_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$v_worker := public.qorpera_company_state_worker_at(v_environment, v_folder);$old$,
	$new$v_worker := public.qorpera_company_state_worker_at(v_environment, public.qorpera_folder_key(v_folder));$new$);
select pg_temp.os527_replace('public.qorpera_folder_cancel_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$= array_to_string((string_to_array(v_folder, '/'))[1:2], '/')) then$old$,
	$new$= public.qorpera_folder_key(array_to_string((string_to_array(v_folder, '/'))[1:3], '/'))) then$new$);
select pg_temp.os527_replace('public.qorpera_folder_archive_coding_worker(jsonb,jsonb)'::regprocedure,
	$old$c_path constant text := '^agents/$old$, $new$c_path constant text := '^QorperaOS/agents/$new$);
select pg_temp.os527_replace('public.qorpera_folder_archive_coding_worker(jsonb,jsonb)'::regprocedure,
	$old$v_worker := public.qorpera_company_state_worker_at(v_environment, v_folder);$old$,
	$new$v_worker := public.qorpera_company_state_worker_at(v_environment, public.qorpera_folder_key(v_folder));$new$);
select pg_temp.os527_replace('public.qorpera_folder_archive_coding_worker(jsonb,jsonb)'::regprocedure,
	$old$= array_to_string((string_to_array(v_folder, '/'))[1:2], '/')) then$old$,
	$new$= public.qorpera_folder_key(array_to_string((string_to_array(v_folder, '/'))[1:3], '/'))) then$new$);

-- An agent's own todos and workers.
select pg_temp.os527_replace('public.qorpera_folder_agent_todos(uuid,jsonb,jsonb)'::regprocedure,
	$old$'agents/' || v_folder || '/todos', 'read')$old$, $new$'QorperaOS/agents/' || v_folder || '/todos', 'read')$new$);
select pg_temp.os527_replace('public.qorpera_folder_agent_workers(uuid,jsonb,jsonb)'::regprocedure,
	$old$public.qorpera_folder_key('agents/' || v_folder || '/todos/'$old$,
	$new$public.qorpera_folder_key('QorperaOS/agents/' || v_folder || '/todos/'$new$);

-- Todo and routine rows keep their file's stored path, which is no longer its key: their ranges compare keys.
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$t.folder_path = v_key collate "C"$old$, $new$public.qorpera_folder_key(t.folder_path) = v_key collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"$old$,
	$new$public.qorpera_folder_key(t.folder_path) > (v_key || '/') collate "C"
						and public.qorpera_folder_key(t.folder_path) < (v_key || '0') collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$r.folder_path = v_key collate "C"$old$, $new$public.qorpera_folder_key(r.folder_path) = v_key collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"$old$,
	$new$public.qorpera_folder_key(r.folder_path) > (v_key || '/') collate "C"
							and public.qorpera_folder_key(r.folder_path) < (v_key || '0') collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$t.folder_path = v_key collate "C"$old$, $new$public.qorpera_folder_key(t.folder_path) = v_key collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"$old$,
	$new$public.qorpera_folder_key(t.folder_path) > (v_key || '/') collate "C"
					and public.qorpera_folder_key(t.folder_path) < (v_key || '0') collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$r.folder_path = v_key collate "C"$old$, $new$public.qorpera_folder_key(r.folder_path) = v_key collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"$old$,
	$new$public.qorpera_folder_key(r.folder_path) > (v_key || '/') collate "C"
					and public.qorpera_folder_key(r.folder_path) < (v_key || '0') collate "C"$new$, 2);
select pg_temp.os527_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$r.folder_path = v_key collate "C"$old$, $new$public.qorpera_folder_key(r.folder_path) = v_key collate "C"$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"$old$,
	$new$public.qorpera_folder_key(r.folder_path) > (v_key || '/') collate "C"
								and public.qorpera_folder_key(r.folder_path) < (v_key || '0') collate "C"$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$public.qorpera_folder_key(p.path) like 'tables/%'$old$, $new$public.qorpera_folder_key(p.path) like 'qorperaos/tables/%'$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$i.folder_key = 'tables/areas'$old$, $new$i.folder_key = 'qorperaos/tables/areas'$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$if v_key like 'agents/%' then$old$, $new$if v_key like 'qorperaos/agents/%' then$new$);

-- The network rules and the vision.
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$if v_op = 'move' and v_key = 'rules/network.toml' then$old$, $new$if v_op = 'move' and v_key = 'qorperaos/rules/network.toml' then$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$'rules/network.toml does not move; edit it where it is'$old$, $new$'QorperaOS/rules/network.toml does not move; edit it where it is'$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$'rules/network.toml'$old$, $new$'qorperaos/rules/network.toml'$new$, 3);
select pg_temp.os527_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$					and e.key_sha256 = extensions.digest('rules/network.toml', 'sha256') and e.version = n.folder_path_version
					and e.path = 'rules/network.toml'))$old$,
	$new$					and e.key_sha256 = extensions.digest('qorperaos/rules/network.toml', 'sha256') and e.version = n.folder_path_version
					and public.qorpera_os_relative(e.path) = 'rules/network.toml'))$new$);
select pg_temp.os527_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$extensions.digest('vision/vision.md', 'sha256')$old$, $new$extensions.digest('qorperaos/vision/vision.md', 'sha256')$new$);

-- Summary trees and run logs.
select pg_temp.os527_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		if v_memtree is null and (v_key ~ '^agents/groups/[^/]+/memory/tree\.toml$'
				or (v_key ~ '^agents/[^/]+/memory/thread/tree\.toml$' and split_part(v_key, '/', 2) <> 'groups')) then$old$,
	$new$		if v_memtree is null and (v_key ~ '^qorperaos/agents/groups/[^/]+/memory/tree\.toml$'
				or (v_key ~ '^qorperaos/agents/[^/]+/memory/thread/tree\.toml$' and split_part(v_key, '/', 3) <> 'groups')) then$new$);
select pg_temp.os527_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$'^agents(/|$)'$old$, $new$'^qorperaos/agents(/|$)'$new$, 3);
select pg_temp.os527_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$p_key ~ '^agents/[^/]+/memory$'
			and p_key !~ '^agents/groups/'$old$,
	$new$p_key ~ '^qorperaos/agents/[^/]+/memory$'
			and p_key !~ '^qorperaos/agents/groups/'$new$);
select pg_temp.os527_replace('public.qorpera_memory_run_log_admits(uuid,text,jsonb,text,text,jsonb)'::regprocedure,
	$old$t.key ~ '^agents/([^/]+|groups/[^/]+)/memory(/|$)'$old$, $new$t.key ~ '^qorperaos/agents/([^/]+|groups/[^/]+)/memory(/|$)'$new$);
select pg_temp.os527_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	$old$case when v_root !~ '^agents/groups/'$old$, $new$case when v_root !~ '^qorperaos/agents/groups/'$new$);
select pg_temp.os527_replace('public.qorpera_memory_run_log_targets(uuid,jsonb)'::regprocedure,
	$old$v_key !~ '^agents(/|$)'$old$, $new$v_key !~ '^qorperaos/agents(/|$)'$new$);

-- A summary tree's paths are written below the root as their keys; the root keeps the folder's spelling, from which a
-- new path's parent spelling comes.
select pg_temp.os527_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$		if v_touch.op <> 'delete' and v_touch.path is distinct from v_touch.key then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('name', null, null, 'write the path in lowercase, as ' || left(v_touch.key, 100))));$old$,
	$new$		if v_touch.op <> 'delete'
			and public.qorpera_os_relative(v_touch.path) is distinct from public.qorpera_os_relative(v_touch.key) then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('name', null, null, 'write the path below QorperaOS/ in lowercase, as QorperaOS/'
					|| left(public.qorpera_os_relative(v_touch.key), 100))));$new$);

-- Paths the database hands out to be written or shown are spelled QorperaOS/..., as the folder stores them; the roots
-- it compares stay keys. A run's log before it exists, and the folders on the way to it:
select pg_temp.os527_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	$old$return jsonb_build_object('path', v_root || '/runs/' || p_run_id, 'exists', false,$old$,
	$new$return jsonb_build_object('path', 'QorperaOS/' || public.qorpera_os_relative(v_root) || '/runs/' || p_run_id, 'exists', false,$new$);
select pg_temp.os527_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	$old$jsonb_agg(m.p order by m.n)$old$, $new$jsonb_agg('QorperaOS/' || public.qorpera_os_relative(m.p) order by m.n)$new$);

-- A member's chat image, where company_read opens it and the commit saves it.
create or replace function public.qorpera_room_image_path(p_session_id uuid, p_client_input_id uuid, p_image jsonb)
returns text language sql stable set search_path = '' as $$
	-- 20260930527000: spelled QorperaOS/..., below the conversation's root key.
	select 'QorperaOS/' || public.qorpera_os_relative(public.qorpera_room_image_root(p_session_id)) || '/images/'
		|| p_client_input_id::text || '/' || (p_image ->> 'objectSha256')
		|| '.' || case p_image ->> 'mediaType' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif'
			when 'image/webp' then 'webp' end
	where p_client_input_id is not null and jsonb_typeof(p_image) = 'object'
		and coalesce(p_image ->> 'objectSha256', '') ~ '^[0-9a-f]{64}$'
		and p_image ->> 'mediaType' in ('image/png','image/jpeg','image/gif','image/webp')
$$;

-- A link's refusal names the path as people see it.
create or replace function public.qorpera_folder_link_problems(p_key text)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930380000 (LK1); 20260930527000: a path under the root is named QorperaOS/....
	select case when v.what is null then '[]'::jsonb else jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
		format('%s is %s; a link cannot stand there', left(coalesce(rtrim('QorperaOS/' || public.qorpera_os_relative(p_key), '/'), p_key), 100),
			v.what))) end
	from (select case
		when public.qorpera_memory_tree_root_key(p_key) is not null then 'in a summary tree'
		when public.qorpera_structured_path_kind(p_key) is not null then 'the path of a structured file'
		when public.qorpera_company_state_seeded(p_key) then 'a folder the company keeps'
		when x.n is not null then coalesce(substr(x.n[cardinality(x.n)], strpos(x.n[cardinality(x.n)], ':') + 1),
			'a folder the company keeps')
	end as what from (select public.qorpera_structured_folder_names(p_key) as n) x) v
$$;

-- Paths the platform writes: connection and hook files, the Co-Founder's first todo, the rules/ resource.
select pg_temp.os527_replace('public.qorpera_folder_connection_file_state(uuid)'::regprocedure,
	$old$v_path := 'connections/' || v_name || '.md';$old$, $new$v_path := 'QorperaOS/connections/' || v_name || '.md';$new$);
select pg_temp.os527_replace('public.qorpera_folder_hook_file_state(text,uuid,uuid)'::regprocedure,
	$old$v_path := 'connections/' || v_name || '.md';$old$, $new$v_path := 'QorperaOS/connections/' || v_name || '.md';$new$);
select pg_temp.os527_replace('public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$'firstTodo', 'agents/co-founder/todos/start-with-the-founders.md'$old$,
	$new$'firstTodo', 'QorperaOS/agents/co-founder/todos/start-with-the-founders.md'$new$);
select pg_temp.os527_replace('public.qorpera_folder_enable_internal(uuid)'::regprocedure,
	$old$(p_environment_id, 'rules', 'subtree', 'company_rules', 'normal', v_file.created_by_user_id)$old$,
	$new$(p_environment_id, 'QorperaOS/rules', 'subtree', 'company_rules', 'normal', v_file.created_by_user_id)$new$);
select pg_temp.os527_replace('public.qorpera_folder_set_resource(uuid,jsonb,text,text,text,text)'::regprocedure,
	$old$	if v_key = 'rules' or v_key like 'rules/%' then
		raise exception 'The rules/ folder is fixed' using errcode = '42501'; end if;$old$,
	$new$	if v_key = 'qorperaos/rules' or v_key like 'qorperaos/rules/%' then
		raise exception 'The QorperaOS/rules/ folder is fixed' using errcode = '42501'; end if;$new$);
select pg_temp.os527_replace('public.qorpera_folder_revoke(uuid,jsonb,uuid,uuid)'::regprocedure,
	$old$'The seeded root and rules/ are never revoked'$old$, $new$'The seeded root and QorperaOS/rules/ are never revoked'$new$);

-- What members are told.
select pg_temp.os527_replace('public.qorpera_manage_company_sidebar(uuid,jsonb)'::regprocedure,
	$old$'This company keeps its sections in agents/sections.md; edit that file'$old$,
	$new$'This company keeps its sections in QorperaOS/agents/sections.md; edit that file'$new$);
select pg_temp.os527_replace('public.qorpera_save_review_rule(uuid,uuid,text,text,text)'::regprocedure,
	$old$'This company keeps its rules in rules/; edit those files'$old$,
	$new$'This company keeps its rules in QorperaOS/rules/; edit those files'$new$);
select pg_temp.os527_replace('public.qorpera_archive_review_rule(uuid,uuid)'::regprocedure,
	$old$'This rule comes from a file in rules/; delete the file'$old$, $new$'This rule comes from a file in QorperaOS/rules/; delete the file'$new$);

-- 5. Spot checks ------------------------------------------------------------------------------------------------------

do $check$
begin
	if public.qorpera_structured_path_kind('qorperaos/vision/vision.md') is distinct from 'vision'
		or public.qorpera_structured_path_kind('qorperaos/agents/co-founder/agent.md') is distinct from 'agent'
		or public.qorpera_structured_path_kind('vision/vision.md') is not null
		or public.qorpera_structured_path_kind('agents/co-founder/agent.md') is not null
		or public.qorpera_company_state_path_problems('QorperaOS/agents/co-founder/agent.md', false) <> '[]'::jsonb
		or public.qorpera_company_state_path_problems('qorperaos/agents/co-founder/agent.md', false) <> '[]'::jsonb
		or jsonb_array_length(public.qorpera_company_state_path_problems('QorperaOS/Agents/co-founder/agent.md', false)) <> 1
		or public.qorpera_company_state_path_problems('Agents/Co-Founder/agent.md', false) <> '[]'::jsonb
		or not public.qorpera_company_state_seeded('qorperaos')
		or public.qorpera_company_state_worker_folder('QorperaOS/agents/a/todos/t/w/brief.md') is distinct from 'QorperaOS/agents/a/todos/t/w'
		or public.qorpera_company_state_worker_todo_file('qorperaos/agents/a/todos/t/w') is distinct from 'qorperaos/agents/a/todos/t.md'
		or public.qorpera_os_relative('qorperaosx/agents') is not null then
		raise exception '20260930527000: a classifier does not read QorperaOS/ as it should';
	end if;
end $check$;
