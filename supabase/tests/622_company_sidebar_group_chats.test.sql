-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Group chats in the sidebar on folder-v2 (ported from snapshot-v1 in the legacy sweep): a group chat (its group.md) is
-- placed and ordered by agents/sections.md in one order with the agents of its section, and pinned and hidden by each
-- member like an agent. Unassigned lists the agents, then the group chats oldest first; an agent's own thread is never a
-- group chat. A group chat with no model chosen names none. A group chat whose folder is gone leaves every list but keeps
-- its place; a deleted one takes its rows with it.
select pg_temp.base_claims('service_role');

create function pg_temp.gc_manage(p_user uuid, p_request jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', p_request);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.gc_read(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.gc_refused(p_user uuid, p_request jsonb, p_code text, p_message text default null) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.gc_manage(p_user, p_request);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code or (p_message is not null and sqlerrm <> p_message) then
			raise exception 'expected % %, got % (%)', p_code, coalesce(p_message, ''), sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_request;
end $$;
-- A section's agents and group chats in the order a client draws them.
create function pg_temp.gc_container(p_state jsonb, p_section text) returns text[] language sql as $$
	select coalesce(array_agg(item.id order by item.position), '{}') from (
		select placement ->> 'staffAgentId' id, (placement ->> 'position')::int position
		from jsonb_array_elements(p_state -> 'placements') placement where placement ->> 'sectionId' is not distinct from p_section
		union all
		select placement ->> 'roomId', (placement ->> 'position')::int
		from jsonb_array_elements(p_state -> 'roomPlacements') placement where placement ->> 'sectionId' is not distinct from p_section) item
$$;
-- A new group chat's folder with its group.md, as one unit.
create function pg_temp.gc_group(p_handle text, p_id uuid, p_name text, p_agents uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op', 'new_folder', 'path', 'agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(g.text))),
		'structured', jsonb_build_array(jsonb_build_object('path', 'agents/groups/' || p_handle || '/group.md', 'kind', 'group', 'text', g.text,
			'parse', jsonb_build_object('kind', 'group', 'id', p_id, 'name', p_name, 'subtitle', null, 'agents', to_jsonb(p_agents),
				'people', '["92400000-0000-4000-8000-000000000001"]'::jsonb, 'purpose', 'Plan the launch.'), 'parserVersion', 1)))
	from (select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n  - 92400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n',
		p_id, p_name, (select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a)) as text) g
$$;
create function pg_temp.gc_sections(p_sections jsonb) returns jsonb language sql as $$
	select pg_temp.base_write('agents/sections.md', 'sections', 'sections ' || p_sections::text, jsonb_build_object('kind', 'sections',
		'sections', coalesce((select jsonb_agg(jsonb_build_object('name', section ->> 'name', 'line', 3 + 10 * (ordinal - 1)::integer,
			'members', coalesce((select jsonb_agg(jsonb_build_object('id', member #>> '{}', 'line', 4 + 10 * (ordinal - 1)::integer + n::integer)
				order by n) from jsonb_array_elements(section -> 'items') with ordinality m(member, n)), '[]'::jsonb)) order by ordinal)
			from jsonb_array_elements(p_sections) with ordinality s(section, ordinal)), '[]'::jsonb)),
		pg_temp.base_version('agents/sections.md'))
$$;

-- Two group chats, Launch then Hiring, each saved by the owner.
select pg_temp.base_commit(pg_temp.base_owner(), 'gc-launch-0001', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/groups'),
	pg_temp.gc_group('launch', '62200000-0000-4000-8000-000000000001', 'Launch',
		array['92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032']::uuid[]))) \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'gc-hiring-0001', jsonb_build_array(
	pg_temp.gc_group('hiring', '62200000-0000-4000-8000-000000000002', 'Hiring',
		array['92400000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000031']::uuid[]))) \g /dev/null
select set_config('qorpera_test.gc_bob_thread', pg_temp.base_thread('92400000-0000-4000-8000-000000000031')::text, true);

do $$
declare v_state jsonb; v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_contributor uuid := '92400000-0000-4000-8000-000000000002';
	v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_research text;
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_bob text := '92400000-0000-4000-8000-000000000031';
	v_carol text := '92400000-0000-4000-8000-000000000032';
	v_launch text := '62200000-0000-4000-8000-000000000001'; v_hiring text := '62200000-0000-4000-8000-000000000002';
	v_thread text := current_setting('qorpera_test.gc_bob_thread');
begin
	-- Unassigned lists agents in roster order, then group chats oldest first; never an agent's thread.
	perform pg_temp.base_assert(public.qorpera_sidebar_container('92400000-0000-4000-8000-000000000010', null)
		= array[v_alice, v_bob, v_carol, v_launch, v_hiring]::uuid[], 'Group chats follow the agents in Unassigned');
	v_state := pg_temp.gc_read(v_owner);
	perform pg_temp.base_assert(v_state -> 'roomPlacements' = '[]' and v_state -> 'placements' = '[]', 'Nothing is placed at first');

	-- A contributor saves a section with a group chat above an agent above a group chat: one order for both kinds.
	perform pg_temp.base_commit(jsonb_build_object('kind', 'member', 'userId', v_contributor), 'gc-sections-0001', jsonb_build_array(
		pg_temp.gc_sections(jsonb_build_array(jsonb_build_object('name', 'Research', 'items', jsonb_build_array(v_hiring, v_carol, v_launch))))));
	v_state := pg_temp.gc_read(v_owner);
	v_research := v_state #>> '{sections,0,sectionId}';
	perform pg_temp.base_assert(pg_temp.gc_container(v_state, v_research) = array[v_hiring, v_carol, v_launch],
		'Group chats and agents share their section''s order: ' || v_state::text);
	perform pg_temp.base_assert(public.qorpera_sidebar_container('92400000-0000-4000-8000-000000000010', v_research::uuid)
		= array[v_hiring, v_carol, v_launch]::uuid[], 'The cloud orders the section the same way');
	-- Older clients read agents where they always did; group chats never enter placements.
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_state -> 'placements') placement
		where placement ->> 'staffAgentId' in (v_launch, v_hiring)), 'Agent placements hold only agents');

	-- A viewer pins and hides for themself, agents and group chats in one row.
	v_state := pg_temp.gc_manage(v_viewer, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_launch, v_bob, v_hiring)));
	perform pg_temp.base_assert(v_state -> 'pinned' = jsonb_build_array(v_launch, v_bob, v_hiring), 'Pins mix agents and group chats in order');
	perform pg_temp.base_assert(pg_temp.gc_read(v_owner) -> 'pinned' = '[]', 'Pins stay with their member');
	v_state := pg_temp.gc_manage(v_viewer, jsonb_build_object('action', 'set_hidden', 'roomId', v_launch, 'hidden', true));
	perform pg_temp.base_assert(v_state -> 'hidden' = jsonb_build_array(v_launch)
		and v_state -> 'pinned' = jsonb_build_array(v_bob, v_hiring), 'Hiding a group chat unpins it');
	v_state := pg_temp.gc_manage(v_viewer, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_launch)));
	perform pg_temp.base_assert(v_state -> 'hidden' = '[]' and v_state -> 'pinned' = jsonb_build_array(v_launch),
		'Pinning a hidden group chat shows it and the new order replaces the old');
	v_state := pg_temp.gc_manage(v_viewer, jsonb_build_object('action', 'set_hidden', 'roomId', v_hiring, 'hidden', true));
	v_state := pg_temp.gc_manage(v_viewer, jsonb_build_object('action', 'set_hidden', 'roomId', v_hiring, 'hidden', false));
	perform pg_temp.base_assert(v_state -> 'hidden' = '[]'
		and not exists (select 1 from public.qorpera_member_sidebar_rooms where user_id = v_viewer and room_id = v_hiring::uuid),
		'Showing a group chat again leaves no row behind');

	-- An agent's own thread, an unknown room and mixed-up requests are refused.
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_thread)), 'P0002');
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order',
		jsonb_build_array('62200000-0000-4000-8000-000000000099')), 'P0002', 'That agent or group chat is no longer in this company');
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_hidden', 'roomId', v_thread, 'hidden', true), 'P0002');
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_hidden', 'staffAgentId', v_bob, 'roomId', v_launch, 'hidden', true), '22023');
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_launch, v_launch)), '22023');
	perform pg_temp.gc_refused(v_owner, '{"action":"set_hidden","hidden":true}', '22023');
end $$;

-- A page opened before group chats sends agents-only pins without groupChats: the member's pinned group chats stay
-- pinned, after its agents.
do $$
declare v_state jsonb; v_owner uuid := '92400000-0000-4000-8000-000000000001';
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_carol text := '92400000-0000-4000-8000-000000000032';
	v_launch text := '62200000-0000-4000-8000-000000000001';
begin
	v_state := pg_temp.gc_manage(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_launch, v_alice)));
	v_state := pg_temp.gc_manage(v_owner, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array(v_carol, v_alice)));
	perform pg_temp.base_assert(v_state -> 'pinned' = jsonb_build_array(v_carol, v_alice, v_launch),
		'An older page''s pins keep the group chats pinned, after its agents');
	v_state := pg_temp.gc_manage(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', true, 'order', jsonb_build_array(v_carol)));
	perform pg_temp.base_assert(v_state -> 'pinned' = jsonb_build_array(v_carol), 'A current page''s pins are the whole row');
	perform pg_temp.gc_refused(v_owner, jsonb_build_object('action', 'set_pins', 'groupChats', false, 'order', '[]'::jsonb), '22023');
end $$;

-- A group chat's conversation reports no model while none was chosen: each agent runs its own.
do $$
declare v_read jsonb; v_launch_session uuid := (select session_id from public.qorpera_company_rooms where id = '62200000-0000-4000-8000-000000000001');
	v_bob_session uuid := (select session_id from public.qorpera_company_rooms where id = current_setting('qorpera_test.gc_bob_thread')::uuid);
	v_bob_model text;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_read := public.qorpera_get_session_model(v_launch_session);
	v_bob_model := public.qorpera_get_session_model(v_bob_session) ->> 'model_id';
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_read ? 'model_id' and v_read -> 'model_id' = 'null'::jsonb and (v_read ->> 'version')::int = 0,
		'A group chat with no model chosen names none: ' || v_read::text);
	perform pg_temp.base_assert(v_bob_model is not null, 'An agent''s conversation still names its model');
	insert into public.qorpera_session_models(session_id, model_id, version, updated_by_user_id)
	values (v_launch_session, 'gpt-6-sol', 1, '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_read := public.qorpera_get_session_model(v_launch_session);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_read ->> 'model_id' = 'gpt-6-sol', 'A chosen model is reported');
end $$;

-- A group chat whose folder is deleted (its conversation closed) leaves every list but keeps its place; a deleted
-- group chat row takes its sidebar rows with it.
do $$
declare v_state jsonb; v_research uuid := (select id from public.qorpera_company_sidebar_sections
	where profile_id = '92400000-0000-4000-8000-000000000010' and name = 'Research');
begin
	perform pg_temp.gc_manage('92400000-0000-4000-8000-000000000003', jsonb_build_object('action', 'set_pins', 'groupChats', true,
		'order', jsonb_build_array('62200000-0000-4000-8000-000000000001', '62200000-0000-4000-8000-000000000002')));
	perform pg_temp.base_commit(pg_temp.base_owner(), 'gc-delete-hiring', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', 'agents/groups/hiring', 'expectedVersion', pg_temp.base_version('agents/groups/hiring'),
		'asOfSeq', (select last_seq from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'))));
	perform pg_temp.base_assert((select status = 'closed' from public.qorpera_shared_sessions where id = (select session_id
		from public.qorpera_company_rooms where id = '62200000-0000-4000-8000-000000000002')), 'Its conversation is closed');
	v_state := pg_temp.gc_read('92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_assert(v_state -> 'pinned' = '["62200000-0000-4000-8000-000000000001"]'
		and not exists (select 1 from jsonb_array_elements(v_state -> 'roomPlacements') placement
			where placement ->> 'roomId' = '62200000-0000-4000-8000-000000000002'), 'A closed group chat is not listed: ' || v_state::text);
	perform pg_temp.base_assert(not ('62200000-0000-4000-8000-000000000002'::uuid = any(
		public.qorpera_sidebar_container('92400000-0000-4000-8000-000000000010', v_research))), 'A closed conversation is not in the rail');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sidebar_room_placements
		where room_id = '62200000-0000-4000-8000-000000000002'), 'Its placement is kept');
	perform pg_temp.gc_refused('92400000-0000-4000-8000-000000000001', jsonb_build_object('action', 'set_pins', 'groupChats', true,
		'order', jsonb_build_array('62200000-0000-4000-8000-000000000002')), 'P0002');
	delete from public.qorpera_company_rooms where id = '62200000-0000-4000-8000-000000000001';
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sidebar_room_placements
			where room_id = '62200000-0000-4000-8000-000000000001')
		and not exists (select 1 from public.qorpera_member_sidebar_rooms where room_id = '62200000-0000-4000-8000-000000000001'),
		'A deleted group chat leaves no sidebar rows');
end $$;

-- Members never read or write the group chat rows directly.
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
	set local role authenticated;
	begin
		perform 1 from public.qorpera_member_sidebar_rooms;
		raise exception 'member group chat rows were readable directly';
	exception when insufficient_privilege then null;
	end;
	begin
		perform 1 from public.qorpera_company_sidebar_room_placements;
		raise exception 'group chat placements were readable directly';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not has_function_privilege('authenticated', 'public.qorpera_sidebar_place_room(uuid,uuid,uuid,uuid[],uuid,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_sidebar_container(uuid,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_sidebar_state(uuid,uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_manage_company_sidebar(uuid,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_manage_company_sidebar(uuid,jsonb)', 'execute'),
		'Group chat sidebar grants');
end $$;

rollback;
