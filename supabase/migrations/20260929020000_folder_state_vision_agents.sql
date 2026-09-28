-- Company state files, F2-1: the vision and agents (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5). The shared
-- tables gain nullable columns that snapshot-v1 never sets, and the Co-Founder record's formation becomes optional.
--
-- This slice fills in the structured-file hook's stubs of C1b-1 (20260928200000 §5, signatures agreed on #408):
-- * which paths hold structured files, and the path checks of contract 5.6 on the path an entry is stored under;
-- * the checked parse of every structured file, stored on its path version (the TS parser is authoritative;
--   SQL re-hashes the text and re-checks the parse's shape for the kinds it indexes);
-- * the seeded-path, Co-Founder, lone-file, kind-change and copy refusals;
-- * vision/vision.md -> qorpera_folder_company_index (the company's name);
-- * agents/<handle>/agent.md -> qorpera_profile_staff (the roster), with the Co-Founder record written by the
--   creation commit;
-- * the review class of hires and of archiving or reactivating an agent.
-- The other kinds (sections, group chats, connections, rules, todos, workers, routines) are recognised, their
-- parse is checked for shape and stored, and their indexes come with their own slices (F2-2 to F2-6). Follow-ups
-- that converge after the commit (a hire's first run, an archive's paused routines and removed execution access)
-- need C2's queue and come with it.

-- 1. The checked parse on each path version ----------------------------------------------------------------

alter table public.qorpera_folder_path_versions add column structured jsonb
	check (structured is null or (jsonb_typeof(structured) = 'object' and structured ? 'kind' and structured ? 'parse'
		and structured ? 'parserVersion'));

-- 2. The company index: the company's name, from vision/vision.md ---------------------------------------------

create table public.qorpera_folder_company_index (
	environment_id uuid primary key references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
	vision_path_version uuid not null,
	-- True while the vision is still the file the platform seeded; the Co-Founder's first job is to fill it.
	vision_seeded boolean not null,
	commit_id uuid not null,
	updated_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_folder_company_index enable row level security;
revoke all on public.qorpera_folder_company_index from public, anon, authenticated;
grant select on public.qorpera_folder_company_index to service_role;

-- 3. The roster as the index of agent.md ----------------------------------------------------------------------

-- A folder-v2 agent's row points at its agent.md: the environment, the path as stored, that path's current
-- version and the commit that wrote it. A folder-v2 row never has the snapshot-v1 source columns. Deleting the
-- folder retires the row (folder_retired_at, and archived) without deleted_at, which freezes a row for good, so a
-- restore can bring it back.
alter table public.qorpera_profile_staff
	add column folder_environment_id uuid,
	add column folder_path text collate "C",
	add column folder_path_version uuid,
	add column folder_commit_id uuid,
	add column folder_retired_at timestamptz,
	add constraint qorpera_profile_staff_folder_complete check (
		(folder_path is null) = (folder_environment_id is null)
		and (folder_path is null) = (folder_path_version is null)
		and (folder_path is null) = (folder_commit_id is null)
		and (folder_path is null or source_path is null)
		and (folder_retired_at is null or folder_path is not null));
create index qorpera_profile_staff_folder_path on public.qorpera_profile_staff(folder_environment_id, folder_path collate "C")
	where folder_path is not null;

-- A folder-v2 company has no formation document: its Co-Founder record carries no formation.
alter table public.qorpera_company_cofounders alter column formation_id drop not null;

-- 4. Which paths hold structured files ------------------------------------------------------------------------

-- The kind of structured file at a folder key (contract 5.6), or null for an ordinary file. The TS table is
-- companyStatePath in @qorpera/cloud-client/company-state-files; both decide on the key.
create function public.qorpera_structured_path_kind(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	select case
		when p_key = 'vision/vision.md' then 'vision'
		when p_key = 'agents/sections.md' then 'sections'
		when p_key ~ '^connections/[^/]*\.md$' then 'connection'
		when p_key ~ '^rules/[^/]*\.md$' then 'rule'
		when p_key ~ '^agents/groups/[^/]+/group\.md$' then 'group'
		when p_key ~ '^agents/(groups|sections\.md)(/|$)' then null
		when p_key ~ '^agents/[^/]+/agent\.md$' then 'agent'
		when p_key ~ '^agents/[^/]+/routines/[^/]*\.md$' then 'routine'
		when p_key ~ '^agents/[^/]+/todos/[^/]*\.md$' then 'todo'
		when p_key ~ '^agents/[^/]+/todos/[^/]+/[^/]+/brief\.md$' then 'worker-brief'
		when p_key ~ '^agents/[^/]+/todos/[^/]+/[^/]+/results\.md$' then 'worker-results'
	end
$$;

-- The folder places whose names are checked like the files they will hold (companyStatePathProblems' folder mode):
-- the agent's folder, a group chat's folder, an agent's routines/ and todos/, a todo's folder and a worker's folder.
-- Returns the (1-based) name positions to check with what they name, or null for an ordinary folder.
create function public.qorpera_structured_folder_names(p_key text)
returns text[] language sql immutable parallel safe set search_path = '' as $$
	select case
		when p_key ~ '^agents/groups/[^/]+$' then array['3:a group chat''s folder']
		when p_key ~ '^agents/(groups|sections\.md)(/|$)' then null
		when p_key ~ '^agents/[^/]+$' then array['2:an agent''s folder']
		when p_key ~ '^agents/[^/]+/(routines|todos)$' then array['2:an agent''s folder']
		when p_key ~ '^agents/[^/]+/todos/[^/]+$' then array['2:an agent''s folder', '4:the todo''s folder']
		when p_key ~ '^agents/[^/]+/todos/[^/]+/[^/]+$' then array['2:an agent''s folder', '4:the todo''s folder', '5:the worker''s folder']
	end
$$;

create function public.qorpera_company_state_problem(p_code text, p_line integer, p_key text, p_message text)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('line', p_line, 'key', p_key, 'code', p_code, 'message', p_message)
$$;

-- The path checks of contract 5.6 (companyStatePathProblems): the names a structured path carries follow the naming
-- rule, a structured file ends in a lowercase .md, and the whole path is written as its key. `p_path` is the path as
-- it is (or will be) stored, its parent's stored spelling included.
create function public.qorpera_company_state_path_problems(p_path text, p_folder boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_path text := p_path; v_key text; v_kind text; v_places text[]; v_place text; v_written text[];
	v_named jsonb := '[]'::jsonb; v_name text; v_problems jsonb := '[]'::jsonb; v_item jsonb;
begin
	if p_folder then v_path := regexp_replace(v_path, '/+$', ''); end if;
	v_key := public.qorpera_folder_key(v_path);
	v_written := string_to_array(v_path, '/');
	if p_folder then
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
		elsif v_kind in ('agent','routine','todo','worker-brief','worker-results') then
			v_named := jsonb_build_array(jsonb_build_array(v_written[2], 'an agent''s folder')); end if;
		if v_kind in ('routine','todo') then
			v_named := v_named || jsonb_build_array(jsonb_build_array(regexp_replace(v_written[4], '\.md$', '', 'i'), 'the file'));
		elsif v_kind in ('rule','connection') then
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
	if not p_folder and v_kind not in ('vision','sections') and v_written[array_length(v_written, 1)] !~ '\.md$' then
		v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
			'the file name ends in .md, in lowercase'));
	elsif jsonb_array_length(v_problems) = 0 and v_path <> v_key then
		v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
			'write the path in lowercase, as ' || left(v_key, 100)));
	end if;
	return v_problems;
end $$;

-- 5. The parse's shape, for the kinds this slice indexes ------------------------------------------------------

-- The TS parser (parseCompanyStateFile) is authoritative; this re-checks that the parse a writer sends has exactly
-- the shape and the limits the file rules give, so an index row can always be written from it.
create function public.qorpera_company_state_one_line(p_value jsonb, p_min integer, p_max integer, p_bytes boolean default false)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') = btrim(p_value #>> '{}', ' ')
		and (p_value #>> '{}') !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
		and (case when p_bytes then octet_length(p_value #>> '{}') else char_length(p_value #>> '{}') end) between p_min and p_max
$$;

create function public.qorpera_company_state_parse_problems(p_kind text, p_parse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_bad text[] := '{}';
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
		if coalesce(p_parse ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_bad := array_append(v_bad, 'id'); end if;
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
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r') then
			v_bad := array_append(v_bad, 'instructions'); end if;
	end if;
	if cardinality(v_bad) = 0 then return '[]'::jsonb; end if;
	return jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
		'the platform read this file differently from its rules (' || array_to_string(v_bad, ', ') || ')'));
end $$;

-- 6. The hook's helpers --------------------------------------------------------------------------------------

-- Paths the platform seeds that cannot be deleted or moved (contract 5.6, "Approval"; COMPANY_STATE_SEEDED_PATHS).
create function public.qorpera_company_state_seeded(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select p_key = any (array['vision','vision/vision.md','agents','agents/sections.md','agents/groups','connections','skills','rules'])
$$;

-- The unit's structured entry for one path (matched by key), or null.
create function public.qorpera_company_state_entry(p_unit jsonb, p_key text)
returns jsonb language sql immutable set search_path = '' as $$
	select e.value from jsonb_array_elements(case when jsonb_typeof(p_unit -> 'structured') = 'array'
		then p_unit -> 'structured' else '[]'::jsonb end) e
	where jsonb_typeof(e.value) = 'object' and public.qorpera_folder_key(e.value ->> 'path') = p_key
	limit 1
$$;

-- The files a unit writes, as stored: (stored path, key, file object). A write is its own path; a new folder's
-- contents are spelled under its stored root.
create function public.qorpera_company_state_unit_files(p_unit jsonb, p_eff_path text)
returns table(path text, key text, file jsonb) language sql stable set search_path = '' as $$
	select p_eff_path, public.qorpera_folder_key(p_eff_path), p_unit -> 'file' where p_unit ->> 'op' = 'write'
	union all
	select c.path, public.qorpera_folder_key(c.path), c.file
	from public.qorpera_folder_spelled_contents(p_eff_path, case when p_unit ->> 'op' = 'new_folder' then p_unit -> 'contents'
		else '[]'::jsonb end) c
	where c.kind = 'file'
$$;

-- The actor's user for the roster's updated_by: the member, a run's requester, or for the platform the company's
-- creator.
create function public.qorpera_company_state_actor_user(p_profile_id uuid, p_actor jsonb)
returns uuid language sql stable set search_path = '' as $$
	select coalesce(case p_actor ->> 'kind' when 'member' then (p_actor ->> 'userId')::uuid end,
		(p_actor ->> 'requesterUserId')::uuid,
		(select created_by_user_id from public.qorpera_profiles where id = p_profile_id))
$$;

-- The checked parse of one structured file a unit writes: {ok, kind, parse, problems}. The entry must carry the
-- file's text, whose hash is the file's own, and a parse of the path's kind with the right shape; a writer that
-- could not read the file sends its problems instead.
create function public.qorpera_company_state_checked(p_unit jsonb, p_path text, p_key text, p_file jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_kind text := public.qorpera_structured_path_kind(p_key); v_entry jsonb; v_problems jsonb;
begin
	v_problems := public.qorpera_company_state_path_problems(p_path, false);
	if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	v_entry := public.qorpera_company_state_entry(p_unit, p_key);
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
	if v_kind in ('vision','agent') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 7. The hook: targets --------------------------------------------------------------------------------------------

-- Rank 2: the roster rows this change set rewrites (FOR NO KEY UPDATE): an agent.md's id, and the rows of agents
-- under a folder that is deleted or moved (read from the index with no lock; the path locks that follow and the
-- subtree's asOfSeq rule refuse a subtree that changed meanwhile).
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare v_profile uuid; v_unit jsonb; v_op text; v_key text; v_id text;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	if v_profile is null then return; end if;
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		if v_op in ('write','new_folder') then
			for v_id in select e.value -> 'parse' ->> 'id' from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent' and coalesce(e.value -> 'parse' ->> 'id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			loop
				rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || v_id; mode := 'nokeyupdate';
				return next;
			end loop;
		elsif v_op in ('delete','move') then
			v_key := public.qorpera_folder_key(case when v_op = 'move' then v_unit ->> 'from' else v_unit ->> 'path' end);
			if v_key like 'agents/%' then
				for v_id in select s.staff_agent_id::text from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_path is not null
						and (public.qorpera_folder_key(s.folder_path) = v_key
							or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || v_id; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		end if;
	end loop;
end $$;

-- 8. The hook: decide -----------------------------------------------------------------------------------------

-- A move or copy never changes a file's kind, and a copy never lands a structured file. For a folder, every entry
-- it carries is compared, and every folder it carries that lands at a structured place is checked by name.
create function public.qorpera_company_state_carried(p_environment_id uuid, p_op text, p_from_key text, p_eff_to text,
	p_row public.qorpera_folder_entries)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_to_key text := public.qorpera_folder_key(p_eff_to); v_entry record; v_new_path text; v_problems jsonb;
begin
	if p_row.kind = 'file' then
		if p_op = 'copy' and public.qorpera_structured_path_kind(v_to_key) is not null then
			return jsonb_build_object('ok', false, 'reason', 'structured_copy'); end if;
		if public.qorpera_structured_path_kind(p_from_key) is distinct from public.qorpera_structured_path_kind(v_to_key) then
			return jsonb_build_object('ok', false, 'reason', 'kind_change'); end if;
		v_problems := public.qorpera_company_state_path_problems(p_eff_to, false);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;
	-- A folder: nothing below a root outside agents/, vision/, connections/ and rules/ can be structured, on either side.
	if p_from_key !~ '^(agents|vision|connections|rules)(/|$)' and v_to_key !~ '^(agents|vision|connections|rules)(/|$)' then
		return jsonb_build_object('ok', true); end if;
	v_problems := public.qorpera_company_state_path_problems(p_eff_to, true);
	if jsonb_array_length(v_problems) > 0 then
		return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
	for v_entry in select e.path, e.key_text, e.kind from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(p_from_key)
	loop
		v_new_path := p_eff_to || substr(v_entry.path, char_length(p_row.path) + 1);
		if v_entry.kind = 'file' then
			if p_op = 'copy' and public.qorpera_structured_path_kind(public.qorpera_folder_key(v_new_path)) is not null then
				return jsonb_build_object('ok', false, 'reason', 'structured_copy'); end if;
			if public.qorpera_structured_path_kind(v_entry.key_text)
				is distinct from public.qorpera_structured_path_kind(public.qorpera_folder_key(v_new_path)) then
				return jsonb_build_object('ok', false, 'reason', 'kind_change'); end if;
		else
			v_problems := public.qorpera_company_state_path_problems(v_new_path, true);
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

-- The database rules for one agent.md (contract 5.6): the id never changes and belongs to one folder; only the
-- seeded Co-Founder is kind co-founder, it stays so, and it is never archived. The creation commit (the platform,
-- before any Co-Founder is recorded) seeds it.
create function public.qorpera_company_state_agent_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_path text, p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_cofounder uuid; v_base jsonb; v_other record;
	v_problem text;
begin
	select staff_agent_id into v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select v.structured -> 'parse' into v_base
	from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256') and e.kind = 'file';
	select s.folder_path, s.folder_retired_at into v_other from public.qorpera_profile_staff s
	where s.profile_id = p_profile_id and s.staff_agent_id = v_id;
	if v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	elsif found and v_other.folder_path is null then
		v_problem := 'this id belongs to an agent outside the company folder';
	elsif found and v_other.folder_retired_at is null
		and public.qorpera_folder_key(v_other.folder_path) <> p_key then
		v_problem := 'this id belongs to the agent at ' || left(v_other.folder_path, 100) || '; give this agent a new id';
	elsif p_parse ->> 'agentKind' = 'co-founder' and v_cofounder is distinct from v_id
		and not (v_cofounder is null and p_actor ->> 'kind' = 'platform') then
		v_problem := 'only the Co-Founder has kind: co-founder';
	elsif v_id = v_cofounder and p_parse ->> 'agentKind' <> 'co-founder' then
		v_problem := 'the Co-Founder keeps kind: co-founder';
	elsif v_id = v_cofounder and p_parse ->> 'status' = 'archived' then
		v_problem := 'the Co-Founder cannot be archived';
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
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
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		if public.qorpera_structured_path_kind(v_file.key) is null then continue; end if;
		v_checked := public.qorpera_company_state_checked(p_unit, v_file.path, v_file.key, v_file.file);
		if not (v_checked ->> 'ok')::boolean then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_checked -> 'problems'); end if;
		if v_checked ->> 'kind' = 'agent' then
			v_rule := public.qorpera_company_state_agent_rules(p_environment_id, v_profile, p_actor, v_file.path, v_file.key,
				v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

-- 9. The hook: review class ---------------------------------------------------------------------------------

-- Called for an in-house run's units other than delete and move (the commit classes those as deletion). A new
-- agent (hire) and a change of its status are delegation (contract 5.6); so are a new group.md and any routine
-- file change, until F2-6 exempts a routine run's own end-of-run decision. Everything else is plain.
create or replace function public.qorpera_folder_structured_review_class(p_environment_id uuid, p_actor jsonb, p_unit jsonb,
	p_eff_path text, p_eff_to text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_file record; v_kind text; v_base jsonb; v_entry jsonb;
begin
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		v_kind := public.qorpera_structured_path_kind(v_file.key);
		if v_kind is null then continue; end if;
		select v.structured -> 'parse' into v_base
		from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
		where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_file.key, 'sha256') and e.kind = 'file';
		v_entry := public.qorpera_company_state_entry(p_unit, v_file.key);
		if v_kind = 'agent' and (v_base is null
			or v_base ->> 'status' is distinct from v_entry -> 'parse' ->> 'status') then return 'delegation'; end if;
		if v_kind = 'group' and v_base is null then return 'delegation'; end if;
		if v_kind = 'routine' then return 'delegation'; end if;
	end loop;
	return 'plain';
end $$;

-- 10. The hook: apply ------------------------------------------------------------------------------------------

-- One agent.md's roster row, from its checked parse. Only the columns that change are set, so the roster's
-- triggers (the agent's thread, grants, execution access) run for real changes only; every change bumps the
-- version, which pins a running agent's instructions.
create function public.qorpera_company_state_index_agent(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_user uuid, p_path text, p_version uuid, p_parse jsonb, p_actor jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_row public.qorpera_profile_staff%rowtype; v_now timestamptz := clock_timestamp();
	-- No colour: 'native', which the app draws from the agent's identity, as today's hires.
	v_colour text := coalesce('qorpera-' || (p_parse ->> 'colour'), 'native');
	v_figure text := p_parse ->> 'figure'; v_count bigint; v_sets text[];
begin
	select * into v_row from public.qorpera_profile_staff where profile_id = p_profile_id and staff_agent_id = v_id;
	if not found then
		insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, template_id,
			appearance_color, appearance_shape, appearance_creature, employment_status, lifecycle_state, version,
			created_at, updated_at, updated_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
		values (p_profile_id, v_id, p_parse ->> 'name', p_parse ->> 'role', p_parse ->> 'instructions',
			case when p_parse ->> 'agentKind' = 'co-founder' then 'co-founder' end,
			v_colour, 'round', v_figure, p_parse ->> 'status', 'setup', 1, v_now, v_now, p_user,
			p_environment_id, p_path, p_version, p_commit_id)
		on conflict (profile_id, staff_agent_id) do nothing;
		get diagnostics v_count = row_count;
		-- A second change set that used the same new id first: this one aborts, and its retry is refused by decide.
		if v_count = 0 then raise exception 'An agent id was taken by another change set' using errcode = '23505'; end if;
		if p_parse ->> 'agentKind' = 'co-founder'
			and not exists (select 1 from public.qorpera_company_cofounders where profile_id = p_profile_id) then
			insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, formation_id, created_by_user_id)
			values (p_profile_id, p_environment_id, v_id, null, p_user);
		end if;
		return;
	end if;
	-- The index row follows the file: the pointer always; the fields only when they change, in one statement whose
	-- column list comes from this fixed set. A trigger that runs on a column (UPDATE OF) runs when the column is set,
	-- changed or not, so an unchanged name or status is left out.
	v_sets := array['folder_environment_id = $1', 'folder_path = $2', 'folder_path_version = $3', 'folder_commit_id = $4',
		'folder_retired_at = null', 'version = version + 1', 'updated_at = greatest($5, created_at)', 'updated_by_user_id = $6'];
	if v_row.display_name is distinct from p_parse ->> 'name' then v_sets := array_append(v_sets, 'display_name = $7'); end if;
	if v_row.role is distinct from p_parse ->> 'role' then v_sets := array_append(v_sets, 'role = $8'); end if;
	if v_row.charter is distinct from p_parse ->> 'instructions' then v_sets := array_append(v_sets, 'charter = $9'); end if;
	if v_row.appearance_color is distinct from v_colour then v_sets := array_append(v_sets, 'appearance_color = $10'); end if;
	if v_row.appearance_creature is distinct from v_figure then v_sets := array_append(v_sets, 'appearance_creature = $11'); end if;
	if v_row.employment_status is distinct from p_parse ->> 'status' then v_sets := array_append(v_sets, 'employment_status = $12'); end if;
	execute 'update public.qorpera_profile_staff set ' || array_to_string(v_sets, ', ')
		|| ' where profile_id = $13 and staff_agent_id = $14'
	using p_environment_id, p_path, p_version, p_commit_id, v_now, p_user, p_parse ->> 'name', p_parse ->> 'role',
		p_parse ->> 'instructions', v_colour, v_figure, p_parse ->> 'status', p_profile_id, v_id;
end $$;

create or replace function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_user uuid; v_file record; v_kind text; v_entry jsonb; v_version uuid;
	v_key text; v_staff record; v_new_path text; v_actor jsonb;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select jsonb_build_object('kind', c.actor_kind, 'requesterUserId', c.requester_id) into v_actor
	from public.qorpera_folder_commits c where c.id = p_commit_id;
	v_user := public.qorpera_company_state_actor_user(v_profile, case v_actor ->> 'kind'
		when 'member' then jsonb_build_object('kind', 'member', 'userId', v_actor ->> 'requesterUserId') else v_actor end);

	if v_op in ('write','new_folder') then
		for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
			v_kind := public.qorpera_structured_path_kind(v_file.key);
			if v_kind is null then continue; end if;
			v_entry := public.qorpera_company_state_entry(p_unit, v_file.key);
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
		-- The roster follows its agents' folders: a rename keeps the id, and so the thread and history.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.folder_path from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_staff.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved agent.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_profile_staff set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id and e.version = v_version),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1,
				updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
		end loop;
		return;
	end if;

	if v_op = 'delete' then
		-- Deleting an agent's folder retires it: its runs are fenced (archived), its conversations stay, and a restore
		-- of the folder brings the row back.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
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
	end if;
end $$;

-- 11. The hook: verify -------------------------------------------------------------------------------------------

-- Every index row this commit wrote points at its entry's current version (a retired row points at the last one).
create or replace function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_profile_staff s
		where s.folder_environment_id = p_environment_id and s.folder_commit_id = p_commit_id and s.folder_retired_at is null
			and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
				and e.version = s.folder_path_version and e.path = s.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 12. Grants ----------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_structured_path_kind(text) from public, anon, authenticated;
revoke all on function public.qorpera_structured_folder_names(text) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_problem(text, integer, text, text) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_path_problems(text, boolean) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_one_line(jsonb, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_parse_problems(text, jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_seeded(text) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_entry(jsonb, text) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_unit_files(jsonb, text) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_actor_user(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_checked(jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_carried(uuid, text, text, text, public.qorpera_folder_entries) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_agent_rules(uuid, uuid, jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_company_state_index_agent(uuid, uuid, uuid, uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated;
