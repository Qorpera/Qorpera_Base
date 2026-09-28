-- Company state files, F2-2: group chats and sections (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5). The rooms table
-- gains nullable columns that snapshot-v1 never sets.
--
-- Builds on F2-1 (20260929020000) and replaces its hook functions with the two new kinds added:
-- * agents/groups/<handle>/group.md -> qorpera_company_rooms (a group chat: no bound agent) and its room members. A
--   new group.md opens the chat and its conversation; deleting the folder closes both, and a restore reopens them.
-- * agents/sections.md -> the company sidebar's sections, agent placements and group chat placements, in file order.
--   Anything not listed is Unassigned, in roster order.
-- * The parse of both kinds is shape-checked, and the database rules of §2 are enforced in decide: ids the save adds
--   must exist, an agent's run may add only its requester to a group, and the Co-Founder is never in a section.
--
-- Locks: every index write that ends in a company operation (a group's session update, a room insert) takes the
-- company row FOR KEY SHARE at rank 2 first, as F2-1 does for the roster (posting takes it FOR UPDATE before the room
-- and the operation clock). An existing group's room is taken FOR NO KEY UPDATE at rank 4: posting's FOR SHARE waits
-- for it, a run's FOR KEY SHARE does not. The sidebar tables need no lock of their own: agents/sections.md's path lock
-- serializes their only writer, and the member RPC's section and move actions are refused for folder-v2 companies
-- (the web reads the folder feed, core C4, so the sidebar revision row is not bumped either).

-- 1. Group chats in the rooms index ---------------------------------------------------------------------------------

-- A folder-v2 group chat's room points at its group.md: the environment, the path as stored, that path's current
-- version and the commit that wrote it. It has no snapshot source and no bound agent. Deleting the folder retires
-- the room (folder_retired_at, and archived); a restore brings it back.
alter table public.qorpera_company_rooms
	add column folder_environment_id uuid,
	add column folder_path text collate "C",
	add column folder_path_version uuid,
	add column folder_commit_id uuid,
	add column folder_retired_at timestamptz,
	add constraint qorpera_company_rooms_folder_complete check (
		(folder_path is null) = (folder_environment_id is null)
		and (folder_path is null) = (folder_path_version is null)
		and (folder_path is null) = (folder_commit_id is null)
		and (folder_path is null or (bound_staff_agent_id is null and source_path_version is null))
		and (folder_retired_at is null or folder_path is not null)),
	drop constraint qorpera_company_rooms_source_or_binding,
	add constraint qorpera_company_rooms_source_or_binding check (bound_staff_agent_id is not null
		or (source_path_version is not null and source_snapshot_id is not null and source_file_sha256 is not null)
		or folder_path is not null);
create index qorpera_company_rooms_folder_path on public.qorpera_company_rooms(folder_environment_id, folder_path collate "C")
	where folder_path is not null;

-- 2. The parse's shape, now for group chats and sections too ------------------------------------------------------

create or replace function public.qorpera_company_state_parse_problems(p_kind text, p_parse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_bad text[] := '{}';
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
		-- Names are unique ignoring case (the index's unique key), and an id is listed once in the whole file.
		elsif (select count(distinct lower(s ->> 'name')) from jsonb_array_elements(p_parse -> 'sections') s)
				<> jsonb_array_length(p_parse -> 'sections')
			or (select count(*) <> count(distinct m ->> 'id') from jsonb_array_elements(p_parse -> 'sections') s,
				jsonb_array_elements(s -> 'members') m) then
			v_bad := array_append(v_bad, 'sections');
		end if;
	end if;
	if cardinality(v_bad) = 0 then return '[]'::jsonb; end if;
	return jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
		'the platform read this file differently from its rules (' || array_to_string(v_bad, ', ') || ')'));
end $$;

-- The checked parse of one structured file a unit writes (F2-1), now with the shape of group chats and sections.
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
	if v_kind in ('vision','agent','group','sections') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 3. The database rules of group.md and sections.md ----------------------------------------------------------------

-- The parse this path's current version stored, or null.
create function public.qorpera_company_state_base(p_environment_id uuid, p_key text)
returns jsonb language sql stable set search_path = '' as $$
	select v.structured -> 'parse'
	from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256') and e.kind = 'file'
$$;

-- One group.md (contract 5.6, §2): the id never changes and belongs to this folder's chat only; the ids a save adds
-- exist (agents active, people members); an agent's run may add only the member it works for, since adding a person
-- lets them read the conversation. Ids already in the saved version are never checked again.
create function public.qorpera_company_state_group_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key);
	v_room public.qorpera_company_rooms%rowtype; v_exists boolean; v_problem text; v_added text[];
begin
	select * into v_room from public.qorpera_company_rooms where id = v_id;
	v_exists := found;
	if v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	elsif v_exists and (v_room.profile_id <> p_profile_id or v_room.folder_path is null) then
		v_problem := 'this id belongs to another conversation; give this group chat a new id';
	elsif v_exists and v_room.folder_retired_at is null and public.qorpera_folder_key(v_room.folder_path) <> p_key then
		v_problem := 'this id belongs to the group chat at ' || left(v_room.folder_path, 100) || '; give this group chat a new id';
	elsif exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = v_id) then
		v_problem := 'this id belongs to an agent; give this group chat a new id';
	end if;
	if v_problem is null then
		select array_agg(a) into v_added from jsonb_array_elements_text(p_parse -> 'agents') a
		where not coalesce(v_base -> 'agents', '[]'::jsonb) ? a
			and not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = a::uuid
				and s.employment_status = 'active' and s.folder_retired_at is null and s.deleted_at is null);
		if v_added is not null then
			v_problem := 'no active agent has the id ' || v_added[1];
		end if;
	end if;
	if v_problem is null then
		select array_agg(a) into v_added from jsonb_array_elements_text(p_parse -> 'people') a
		where not coalesce(v_base -> 'people', '[]'::jsonb) ? a
			and not exists (select 1 from public.qorpera_profile_members m where m.profile_id = p_profile_id and m.user_id = a::uuid);
		if v_added is not null then
			v_problem := 'no member of this company has the id ' || v_added[1];
		end if;
	end if;
	if v_problem is null and p_actor ->> 'kind' not in ('member','platform') then
		select array_agg(a) into v_added from jsonb_array_elements_text(p_parse -> 'people') a
		where not coalesce(v_base -> 'people', '[]'::jsonb) ? a and a is distinct from p_actor ->> 'requesterUserId';
		if v_added is not null then
			v_problem := 'an agent adds only the member it works for to a group chat';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- agents/sections.md (§2): every id the save adds is an agent or an open group chat of this company; the Co-Founder
-- stands above the sections and is never listed. Ids already in the saved version are never refused: the index
-- skips an agent or chat that is gone.
create function public.qorpera_company_state_sections_rules(p_environment_id uuid, p_profile_id uuid, p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_old text[]; v_id text; v_problem text;
begin
	select coalesce(array_agg(m ->> 'id'), '{}') into v_old
	from jsonb_array_elements(coalesce(v_base -> 'sections', '[]'::jsonb)) s, jsonb_array_elements(s -> 'members') m;
	for v_id in select m ->> 'id' from jsonb_array_elements(p_parse -> 'sections') s, jsonb_array_elements(s -> 'members') m loop
		if exists (select 1 from public.qorpera_company_cofounders c where c.profile_id = p_profile_id and c.staff_agent_id = v_id::uuid) then
			v_problem := 'the Co-Founder stands above the sections; remove ' || v_id;
		elsif v_id = any (v_old) then
			continue;
		elsif not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = v_id::uuid
				and s.folder_retired_at is null and s.deleted_at is null)
			and not exists (select 1 from public.qorpera_company_rooms r where r.profile_id = p_profile_id and r.id = v_id::uuid
				and r.bound_staff_agent_id is null and r.status = 'active') then
			v_problem := 'no agent or group chat has the id ' || v_id;
		end if;
		exit when v_problem is not null;
	end loop;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- 4. The hook: targets -----------------------------------------------------------------------------------------------

-- F2-1's targets, plus: a group.md or sections.md write takes the company row (rank 2, KEY SHARE; the room insert and
-- the conversation's session update end in company operations), and an existing group's room FOR NO KEY UPDATE at
-- rank 4; deleting or moving a folder under agents/ takes the rooms of the group chats in it the same way.
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
				where e.value ->> 'kind' in ('group','sections')
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

-- 5. The hook: decide ------------------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
	v_entries jsonb; v_ids text[] := '{}'; v_cofounders integer := 0; v_groups text[] := '{}';
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
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

-- 6. The hook: apply -------------------------------------------------------------------------------------------------

-- One group.md's room, from its checked parse. A new chat gets its room and conversation; an edit sets the room's
-- fields and pointer and reopens a retired chat; members follow the lists (anyone left out is removed, and a member
-- row that stays active is not written).
create function public.qorpera_company_state_index_group(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_user uuid, p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_room public.qorpera_company_rooms%rowtype; v_session uuid; v_count bigint;
begin
	select * into v_room from public.qorpera_company_rooms where id = v_id;
	if not found then
		insert into public.qorpera_company_rooms(id, profile_id, environment_id, room_key, name, subtitle, purpose, status, version,
			source_path, created_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
		values (v_id, p_profile_id, p_environment_id, 'chat-' || v_id::text, p_parse ->> 'name', p_parse ->> 'subtitle',
			p_parse ->> 'purpose', 'active', 1, 'organization/rooms/' || v_id::text || '.json', p_user,
			p_environment_id, p_path, p_version, p_commit_id)
		on conflict (id) do nothing;
		get diagnostics v_count = row_count;
		-- A second change set that used the same new id first: this one aborts, and its retry is refused by decide.
		if v_count = 0 then raise exception 'A group chat id was taken by another change set' using errcode = '23505'; end if;
		insert into public.qorpera_shared_sessions(profile_id, environment_id, title, staff_agent_id, created_by_user_id,
			audience_kind, audience_user_id, execution_scope)
		values (p_profile_id, p_environment_id, p_parse ->> 'name', null, p_user, 'company', null, jsonb_build_object('roomId', v_id))
		returning id into v_session;
		update public.qorpera_company_rooms set session_id = v_session where id = v_id;
	else
		update public.qorpera_company_rooms set name = p_parse ->> 'name', subtitle = p_parse ->> 'subtitle',
			purpose = p_parse ->> 'purpose', status = 'active', version = version + 1, folder_environment_id = p_environment_id,
			folder_path = p_path, folder_path_version = p_version, folder_commit_id = p_commit_id, folder_retired_at = null,
			updated_at = clock_timestamp()
		where id = v_id;
		update public.qorpera_shared_sessions set status = 'open', title = p_parse ->> 'name', updated_at = statement_timestamp()
		where id = v_room.session_id and (status <> 'open' or title is distinct from p_parse ->> 'name');
	end if;
	update public.qorpera_company_room_members m set status = 'removed', removed_at = clock_timestamp(), source_path_version = p_version
	where m.room_id = v_id and m.status = 'active'
		and not ((m.principal_kind = 'staff_agent' and (p_parse -> 'agents') ? m.principal_id::text)
			or (m.principal_kind = 'member' and (p_parse -> 'people') ? m.principal_id::text));
	insert into public.qorpera_company_room_members as m(room_id, principal_kind, principal_id, status, source_path_version)
	select v_id, p.kind, p.id::uuid, 'active', p_version
	from (select 'staff_agent' as kind, a as id from jsonb_array_elements_text(p_parse -> 'agents') a
		union all select 'member', a from jsonb_array_elements_text(p_parse -> 'people') a) p
	on conflict (room_id, principal_kind, principal_id) do update set status = 'active', removed_at = null,
		source_path_version = excluded.source_path_version
	where m.status <> 'active';
end $$;

-- agents/sections.md's sidebar, from its checked parse: sections in file order (matched to today's rows by name,
-- ignoring case, so a section keeps its id), and each section's agents and group chats in file order, sharing one
-- order as the sidebar draws them. Listed ids that are gone are skipped; everything not listed is Unassigned, whose
-- positions are not kept.
create function public.qorpera_company_state_index_sections(p_profile_id uuid, p_user uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_section jsonb; v_position integer := 0; v_id uuid; v_member jsonb; v_slot integer; v_item uuid;
	v_kept uuid[] := '{}'; v_agents uuid[] := '{}'; v_rooms uuid[] := '{}';
begin
	for v_section in select value from jsonb_array_elements(p_parse -> 'sections') loop
		v_id := null;
		select id into v_id from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and lower(name) = lower(v_section ->> 'name');
		if v_id is null then
			insert into public.qorpera_company_sidebar_sections(id, profile_id, name, position, created_by_user_id, updated_by_user_id)
			values (extensions.gen_random_uuid(), p_profile_id, v_section ->> 'name', v_position, p_user, p_user)
			returning id into v_id;
		else
			update public.qorpera_company_sidebar_sections set name = v_section ->> 'name', position = v_position,
				updated_at = clock_timestamp(), updated_by_user_id = p_user, updated_by_staff_agent_id = null
			where id = v_id and (name, position) is distinct from (v_section ->> 'name', v_position);
		end if;
		v_kept := array_append(v_kept, v_id);
		v_slot := 0;
		for v_member in select value from jsonb_array_elements(v_section -> 'members') loop
			v_item := (v_member ->> 'id')::uuid;
			if exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = v_item
					and s.deleted_at is null and s.folder_retired_at is null)
				and not exists (select 1 from public.qorpera_company_cofounders c where c.profile_id = p_profile_id and c.staff_agent_id = v_item) then
				insert into public.qorpera_company_sidebar_placements as p(profile_id, staff_agent_id, section_id, position, updated_by_user_id)
				values (p_profile_id, v_item, v_id, v_slot, p_user)
				on conflict (profile_id, staff_agent_id) do update set section_id = excluded.section_id, position = excluded.position,
					updated_at = clock_timestamp(), updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = null
				where (p.section_id, p.position) is distinct from (excluded.section_id, excluded.position);
				v_agents := array_append(v_agents, v_item);
				v_slot := v_slot + 1;
			elsif exists (select 1 from public.qorpera_company_rooms r where r.profile_id = p_profile_id and r.id = v_item
					and r.bound_staff_agent_id is null and r.status = 'active') then
				insert into public.qorpera_company_sidebar_room_placements as p(profile_id, room_id, section_id, position, updated_by_user_id)
				values (p_profile_id, v_item, v_id, v_slot, p_user)
				on conflict (profile_id, room_id) do update set section_id = excluded.section_id, position = excluded.position,
					updated_at = clock_timestamp(), updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = null
				where (p.section_id, p.position) is distinct from (excluded.section_id, excluded.position);
				v_rooms := array_append(v_rooms, v_item);
				v_slot := v_slot + 1;
			end if;
		end loop;
		v_position := v_position + 1;
	end loop;
	delete from public.qorpera_company_sidebar_placements where profile_id = p_profile_id and staff_agent_id <> all (v_agents);
	delete from public.qorpera_company_sidebar_room_placements where profile_id = p_profile_id and room_id <> all (v_rooms);
	delete from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id <> all (v_kept);
end $$;

create or replace function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_user uuid; v_file record; v_kind text; v_entry jsonb; v_version uuid;
	v_key text; v_staff record; v_room record; v_new_path text; v_actor jsonb; v_entries jsonb;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select jsonb_build_object('kind', c.actor_kind, 'requesterUserId', c.requester_id) into v_actor
	from public.qorpera_folder_commits c where c.id = p_commit_id;
	v_user := public.qorpera_company_state_actor_user(v_profile, case v_actor ->> 'kind'
		when 'member' then jsonb_build_object('kind', 'member', 'userId', v_actor ->> 'requesterUserId') else v_actor end);

	if v_op in ('write','new_folder') then
		v_entries := public.qorpera_company_state_entries(p_unit);
		for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
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
	end if;
end $$;

-- 7. The hook: verify ------------------------------------------------------------------------------------------------

-- Every index row this commit wrote points at its entry's current version (a retired row points at the last one).
create or replace function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_profile_staff s
		where s.folder_environment_id = p_environment_id and s.folder_commit_id = p_commit_id and s.folder_retired_at is null
			and s.deleted_at is null and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
				and e.version = s.folder_path_version and e.path = s.folder_path))
		or exists (select 1 from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_commit_id = p_commit_id and r.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 8. The member sidebar RPC on folder-v2 ------------------------------------------------------------------------------

-- A folder-v2 company's sections live in agents/sections.md, so their changes are file edits; the RPC's section and
-- move actions refuse (pins and hidden agents stay member settings).
do $$
declare v_definition text;
	v_old constant text := $old$	if v_action in ('create_section','rename_section','delete_section','move_agent','move_room')
		and not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Only owners, admins and contributors can change the company''s sections' using errcode = '42501'; end if;$old$;
	v_new constant text := $new$	if v_action in ('create_section','rename_section','delete_section','move_agent','move_room')
		and not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Only owners, admins and contributors can change the company''s sections' using errcode = '42501'; end if;
	if v_action in ('create_section','rename_section','delete_section','move_agent','move_room')
		and exists (select 1 from public.qorpera_company_files f where f.profile_id = p_profile_id and f.core = 'folder-v2') then
		raise exception 'This company keeps its sections in agents/sections.md; edit that file' using errcode = '55000'; end if;$new$;
begin
	v_definition := pg_get_functiondef('public.qorpera_manage_company_sidebar(uuid,jsonb)'::regprocedure);
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Sidebar section guard anchor differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- 9. Grants ----------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_state_base(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_group_rules(uuid, uuid, jsonb, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_sections_rules(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_group(uuid, uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_sections(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
