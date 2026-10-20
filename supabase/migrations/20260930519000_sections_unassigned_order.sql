-- 20260930519000: agents/sections.md orders the agents and group chats in no section (Jonas, 20 October 2026: "Let
-- agents outside a section be reordered"; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "agents/sections.md").
--
-- Until now an id line before the first section was refused, and the sidebar index kept no positions for Unassigned
-- (20260928249100: "Everything not listed is Unassigned, whose positions are not kept"), so a member could not order the
-- agents outside every section. Now the id lines before the first section are the Unassigned order. The shared parser
-- (packages/cloud-client/src/company-state-files.ts) sends them as `unassigned`, [{id, line}], and only when there are
-- some, so every parse of a file without them keeps its exact shape.
-- 1. The parse's shape (qorpera_company_state_parse_problems): `unassigned` may be there, a non-empty list of {id, line};
--    an id is still listed once in the whole file, Unassigned included.
-- 2. The database rules (qorpera_company_state_sections_rules) hold for those ids too: each one the save adds is an
--    agent or an open group chat of this company, the Co-Founder is never listed, and an id already in the saved
--    version (in a section or not) never blocks a save.
-- 3. The index (qorpera_company_state_index_sections) places them with no section, in file order, one order for agents
--    and group chats as in a section. Anyone listed nowhere still has no placement and comes after them, in roster
--    order, as the sidebar already draws a container.
-- 4. The member's sidebar (qorpera_sidebar_state) says `unassignedOrder: true`, so a client writes the order only to a
--    cloud that keeps it.
--
-- Deploy order: this migration first, then the object gateway and the runtime (their shared parser sends `unassigned`),
-- then the web (it writes the order only where the sidebar says unassignedOrder). Before the gateway is redeployed its
-- parser refuses such a file ("put this line under a ## section"), so nothing is saved that this database cannot read.

set local lock_timeout = '3s';

create function pg_temp.unassigned_order_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930519000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The parse's shape -----------------------------------------------------------------------------------------------

select pg_temp.unassigned_order_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$	elsif p_kind = 'sections' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections'] then
			v_bad := array_append(v_bad, 'keys'); end if;$old$,
	$new$	elsif p_kind = 'sections' then
		-- 20260930519000: `unassigned`, the id lines before the first section, is there only when the file has some.
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections']
			and (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections','unassigned'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if p_parse ? 'unassigned' and (jsonb_typeof(p_parse -> 'unassigned') is distinct from 'array'
			or jsonb_array_length(p_parse -> 'unassigned') = 0
			or exists (select 1 from jsonb_array_elements(p_parse -> 'unassigned') m
				where jsonb_typeof(m) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(m) k) is distinct from array['id','line']
					or jsonb_typeof(m -> 'id') <> 'string' or (m ->> 'id') !~ c_uuid
					or jsonb_typeof(m -> 'line') <> 'number' or (m ->> 'line') !~ '^[1-9][0-9]{0,8}$')) then
			v_bad := array_append(v_bad, 'unassigned'); end if;$new$);

select pg_temp.unassigned_order_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			if (select count(*) <> count(distinct m ->> 'id') from jsonb_array_elements(p_parse -> 'sections') s,
					jsonb_array_elements(s -> 'members') m) then$old$,
	$new$			if (select count(*) <> count(distinct m ->> 'id') from (
					select m from jsonb_array_elements(p_parse -> 'sections') s, jsonb_array_elements(s -> 'members') m
					union all select m from jsonb_array_elements(case when jsonb_typeof(p_parse -> 'unassigned') = 'array'
						then p_parse -> 'unassigned' else '[]'::jsonb end) m) listed) then$new$);

-- 2. The database rules ----------------------------------------------------------------------------------------------

-- agents/sections.md (§2): every id the save adds, in a section or before the first one, is an agent or an open group
-- chat of this company; the Co-Founder stands above the sections and is never listed. Ids already in the saved version
-- are never refused: an agent or chat that is gone keeps its place, which the sidebar hides until a restore brings it
-- back.
create or replace function public.qorpera_company_state_sections_rules(p_environment_id uuid, p_profile_id uuid, p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_old text[]; v_id text; v_problem text;
begin
	-- A parse stored before its kind's shape was checked (F2-1 alone) is not trusted: every id counts as added.
	if v_base is not null and jsonb_array_length(public.qorpera_company_state_parse_problems('sections', v_base)) > 0 then
		v_base := null; end if;
	select coalesce(array_agg(m ->> 'id'), '{}') into v_old
	from (select m from jsonb_array_elements(coalesce(v_base -> 'sections', '[]'::jsonb)) s, jsonb_array_elements(s -> 'members') m
		union all select m from jsonb_array_elements(case when jsonb_typeof(v_base -> 'unassigned') = 'array'
			then v_base -> 'unassigned' else '[]'::jsonb end) m) listed;
	for v_id in select m ->> 'id'
		from (select m from jsonb_array_elements(p_parse -> 'sections') s, jsonb_array_elements(s -> 'members') m
			union all select m from jsonb_array_elements(case when jsonb_typeof(p_parse -> 'unassigned') = 'array'
				then p_parse -> 'unassigned' else '[]'::jsonb end) m) listed loop
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

-- 3. The index -------------------------------------------------------------------------------------------------------

-- agents/sections.md's sidebar, from its checked parse: sections in file order (matched to today's rows by name,
-- ignoring case, so a section keeps its id), and each section's agents and group chats in file order, sharing one
-- order as the sidebar draws them. The id lines before the first section are the agents and group chats in no section,
-- in that order (a placement with no section). A listed agent or chat that is gone (retired, closed) keeps its place,
-- which the sidebar hides, so a restore brings it back where the file says; an id with no row is skipped. Everything
-- listed nowhere has no placement: it comes after the ordered ones with no section.
create or replace function public.qorpera_company_state_index_sections(p_profile_id uuid, p_user uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_section jsonb; v_position integer := 0; v_id uuid; v_member jsonb; v_slot integer; v_item uuid;
	v_kept uuid[] := '{}'; v_agents uuid[] := '{}'; v_rooms uuid[] := '{}'; v_members jsonb;
begin
	-- The ones in no section first (no row, v_id null), then the sections in file order.
	for v_section in select listed.value from (
			select value, ordinality from jsonb_array_elements(p_parse -> 'sections') with ordinality
			union all select jsonb_build_object('members', p_parse -> 'unassigned'), 0
			where jsonb_typeof(p_parse -> 'unassigned') = 'array') listed
		order by listed.ordinality
	loop
		v_id := null;
		if v_section ? 'name' then
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
			v_position := v_position + 1;
		end if;
		v_slot := 0;
		v_members := v_section -> 'members';
		for v_member in select value from jsonb_array_elements(v_members) loop
			v_item := (v_member ->> 'id')::uuid;
			if exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = v_item
					and s.deleted_at is null)
				and not exists (select 1 from public.qorpera_company_cofounders c where c.profile_id = p_profile_id and c.staff_agent_id = v_item) then
				insert into public.qorpera_company_sidebar_placements as p(profile_id, staff_agent_id, section_id, position, updated_by_user_id)
				values (p_profile_id, v_item, v_id, v_slot, p_user)
				on conflict (profile_id, staff_agent_id) do update set section_id = excluded.section_id, position = excluded.position,
					updated_at = clock_timestamp(), updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = null
				where (p.section_id, p.position) is distinct from (excluded.section_id, excluded.position);
				v_agents := array_append(v_agents, v_item);
				v_slot := v_slot + 1;
			elsif exists (select 1 from public.qorpera_company_rooms r where r.profile_id = p_profile_id and r.id = v_item
					and r.bound_staff_agent_id is null) then
				insert into public.qorpera_company_sidebar_room_placements as p(profile_id, room_id, section_id, position, updated_by_user_id)
				values (p_profile_id, v_item, v_id, v_slot, p_user)
				on conflict (profile_id, room_id) do update set section_id = excluded.section_id, position = excluded.position,
					updated_at = clock_timestamp(), updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = null
				where (p.section_id, p.position) is distinct from (excluded.section_id, excluded.position);
				v_rooms := array_append(v_rooms, v_item);
				v_slot := v_slot + 1;
			end if;
		end loop;
	end loop;
	delete from public.qorpera_company_sidebar_placements where profile_id = p_profile_id and staff_agent_id <> all (v_agents);
	delete from public.qorpera_company_sidebar_room_placements where profile_id = p_profile_id and room_id <> all (v_rooms);
	delete from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id <> all (v_kept);
end $$;

-- 4. The member's sidebar --------------------------------------------------------------------------------------------

select pg_temp.unassigned_order_replace('public.qorpera_sidebar_state(uuid,uuid)'::regprocedure,
	$old$		'schema', 'qorpera.company-sidebar/v1',$old$,
	$new$		'schema', 'qorpera.company-sidebar/v1',
		-- 20260930519000: agents/sections.md keeps the order of the agents and group chats in no section.
		'unassignedOrder', true,$new$);
