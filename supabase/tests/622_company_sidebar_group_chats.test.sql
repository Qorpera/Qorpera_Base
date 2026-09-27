-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Group chats in the sidebar (2026-09-27): a group chat is placed, ordered, pinned and
-- hidden like an agent, in one order with the agents of its section. An agent's own
-- thread is never a group chat. Group chats take images like an agent's thread.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.sidebar_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.agent_sidebar(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_sidebar(current_setting('qorpera_test.sidebar_binding')::jsonb,p_request)
$$;
create function pg_temp.member_sidebar(p_user uuid,p_request jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_manage_company_sidebar('30000000-0000-4000-8000-000000000010',p_request);
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_result;
end $$;
create function pg_temp.member_read(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_read_company_sidebar('30000000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_result;
end $$;
create function pg_temp.member_error(p_user uuid,p_request jsonb,p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.member_sidebar(p_user,p_request);
	exception when others then
		reset role;
		perform pg_temp.path_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected %, got % (%)',p_code,sqlstate,sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %',p_code,p_request;
end $$;
-- A section's agents and group chats in the order a client draws them.
create function pg_temp.container(p_state jsonb,p_section text) returns text[] language sql as $$
	select coalesce(array_agg(item.id order by item.position),'{}') from (
		select placement ->> 'staffAgentId' id,(placement ->> 'position')::int position
		from jsonb_array_elements(p_state -> 'placements') placement
		where placement ->> 'sectionId' is not distinct from p_section
		union all
		select placement ->> 'roomId',(placement ->> 'position')::int
		from jsonb_array_elements(p_state -> 'roomPlacements') placement
		where placement ->> 'sectionId' is not distinct from p_section) item
$$;
create function pg_temp.room_section(p_state jsonb,p_room text) returns text language sql as $$
	select placement ->> 'sectionId' from jsonb_array_elements(p_state -> 'roomPlacements') placement
	where placement ->> 'roomId' = p_room
$$;

-- Two group chats. Rooms are inserted as the projection leaves them; the sidebar
-- reads only their company, binding and status. The fixture's agents have their own
-- threads already, which are rooms too.
insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,version,
	source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id,created_at)
values
	('62200000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'chat-launch','Launch','Plan the launch','active',1,'organization/rooms/62200000-0000-4000-8000-000000000001.json',
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat('a',64),'30000000-0000-4000-8000-000000000001',
		'2026-09-27 10:00:00+00'),
	('62200000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'chat-hiring','Hiring','Hire the team','active',1,'organization/rooms/62200000-0000-4000-8000-000000000002.json',
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat('b',64),'30000000-0000-4000-8000-000000000001',
		'2026-09-27 11:00:00+00');
select set_config('qorpera_test.bob_thread',(select id::text from public.qorpera_company_rooms
	where profile_id = '30000000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '30000000-0000-4000-8000-000000000031'),true);

-- An agent's wake still owes its acknowledgement before any sidebar work.
select pg_temp.wake_public_send(current_setting('qorpera_test.sidebar_binding')::jsonb,'progress','sidebar-ack');

do $$
declare v_state jsonb; v_list jsonb; v_owner uuid := '30000000-0000-4000-8000-000000000001';
	v_contributor uuid := '30000000-0000-4000-8000-000000000002'; v_viewer uuid := '30000000-0000-4000-8000-000000000003';
	v_research uuid := '62200000-0000-4000-8000-000000000011'; v_ops uuid := '62200000-0000-4000-8000-000000000012';
	v_agent text := '30000000-0000-4000-8000-000000000030'; v_bob text := '30000000-0000-4000-8000-000000000031';
	v_carol text := '30000000-0000-4000-8000-000000000032';
	v_launch text := '62200000-0000-4000-8000-000000000001'; v_hiring text := '62200000-0000-4000-8000-000000000002';
	v_thread text := current_setting('qorpera_test.bob_thread'); v_revision bigint;
begin
	-- Unassigned lists agents in roster order, then group chats oldest first; never an agent's thread.
	perform pg_temp.wake_assert(public.qorpera_sidebar_container('30000000-0000-4000-8000-000000000010',null)
		= array[v_agent,v_bob,v_carol,v_launch,v_hiring]::uuid[],'Group chats follow the agents in Unassigned');
	v_state := pg_temp.member_read(v_owner);
	perform pg_temp.wake_assert(v_state -> 'roomPlacements' = '[]' and v_state -> 'placements' = '[]',
		'Nothing is placed at first');

	-- A group chat goes into a new section in one step, like an agent.
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','create_section','sectionId',v_research,
		'name','Research','roomId',v_launch));
	perform pg_temp.wake_assert(pg_temp.room_section(v_state,v_launch) = v_research::text,
		'Create with a group chat places the group chat');
	-- A contributor drags an agent above the group chat: one order for both kinds.
	v_state := pg_temp.member_sidebar(v_contributor,jsonb_build_object('action','move_agent','staffAgentId',v_carol,
		'sectionId',v_research,'order',jsonb_build_array(v_carol,v_launch)));
	perform pg_temp.wake_assert(pg_temp.container(v_state,v_research::text) = array[v_carol,v_launch],
		'An agent lands above a group chat');
	v_state := pg_temp.member_sidebar(v_contributor,jsonb_build_object('action','move_room','roomId',v_hiring,
		'sectionId',v_research,'order',jsonb_build_array(v_hiring,v_carol,v_launch)));
	perform pg_temp.wake_assert(pg_temp.container(v_state,v_research::text) = array[v_hiring,v_carol,v_launch],
		'A dragged group chat lands where it was dropped');
	perform pg_temp.wake_assert(public.qorpera_sidebar_container('30000000-0000-4000-8000-000000000010',v_research)
		= array[v_hiring,v_carol,v_launch]::uuid[],'The cloud orders the section the same way');
	-- Older clients read agents where they always did; group chats never enter placements.
	perform pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(v_state -> 'placements') placement
		where placement ->> 'staffAgentId' in (v_launch,v_hiring)),'Agent placements hold only agents');
	-- Moving a group chat where it already is changes nothing and sends no hint.
	v_revision := (select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010');
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','move_room','roomId',v_launch,'sectionId',v_research));
	perform pg_temp.wake_assert((select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010') = v_revision,'A no-op move sends no hint');
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','move_room','roomId',v_launch,'sectionId',null));
	perform pg_temp.wake_assert(pg_temp.room_section(v_state,v_launch) is null
		and (select revision from public.qorpera_company_sidebar_revisions
			where profile_id = '30000000-0000-4000-8000-000000000010') = v_revision + 1,
		'A group chat goes back to Unassigned with one hint');

	-- A viewer cannot place a group chat but pins and hides for themself, agents and group chats in one row.
	perform pg_temp.member_error(v_viewer,jsonb_build_object('action','move_room','roomId',v_launch,'sectionId',v_research),'42501');
	v_state := pg_temp.member_sidebar(v_viewer,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_launch,v_bob,v_hiring)));
	perform pg_temp.wake_assert(v_state -> 'pinned' = jsonb_build_array(v_launch,v_bob,v_hiring),'Pins mix agents and group chats in order');
	perform pg_temp.wake_assert(pg_temp.member_read(v_owner) -> 'pinned' = '[]','Pins stay with their member');
	v_state := pg_temp.member_sidebar(v_viewer,jsonb_build_object('action','set_hidden','roomId',v_launch,'hidden',true));
	perform pg_temp.wake_assert(v_state -> 'hidden' = jsonb_build_array(v_launch)
		and v_state -> 'pinned' = jsonb_build_array(v_bob,v_hiring),'Hiding a group chat unpins it');
	v_state := pg_temp.member_sidebar(v_viewer,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_launch)));
	perform pg_temp.wake_assert(v_state -> 'hidden' = '[]' and v_state -> 'pinned' = jsonb_build_array(v_launch),
		'Pinning a hidden group chat shows it and the new order replaces the old');
	v_state := pg_temp.member_sidebar(v_viewer,jsonb_build_object('action','set_hidden','roomId',v_hiring,'hidden',true));
	v_state := pg_temp.member_sidebar(v_viewer,jsonb_build_object('action','set_hidden','roomId',v_hiring,'hidden',false));
	perform pg_temp.wake_assert(v_state -> 'hidden' = '[]'
		and not exists (select 1 from public.qorpera_member_sidebar_rooms where user_id = v_viewer and room_id = v_hiring::uuid),
		'Showing a group chat again leaves no row behind');
	-- A drag out of the pinned row into a section unpins in the same call.
	v_state := pg_temp.member_sidebar(v_contributor,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_hiring)));
	v_state := pg_temp.member_sidebar(v_contributor,jsonb_build_object('action','move_room','roomId',v_hiring,
		'sectionId',null,'unpin',true));
	perform pg_temp.wake_assert(v_state -> 'pinned' = '[]' and pg_temp.room_section(v_state,v_hiring) is null,
		'A group chat move can unpin');

	-- An agent's own thread, an unknown room and mixed-up requests are refused.
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_room','roomId',v_thread,'sectionId',null),'P0002');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_thread)),'P0002');
	begin
		perform pg_temp.member_sidebar(v_owner,jsonb_build_object('action','set_pins','order',
			jsonb_build_array('62200000-0000-4000-8000-000000000099')));
		raise exception 'an unknown id was pinned';
	exception when sqlstate 'P0002' then
		reset role;
		perform pg_temp.path_claims('service_role');
		perform pg_temp.wake_assert(sqlerrm = 'That agent or group chat is no longer in this company',
			'A pin of something gone says so for both kinds');
	end;
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','set_hidden','roomId',v_thread,'hidden',true),'P0002');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_room','roomId',
		'62200000-0000-4000-8000-000000000099','sectionId',null),'P0002');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_agent','staffAgentId',v_launch,'sectionId',null),'P0002');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_room','staffAgentId',v_bob,'sectionId',null),'22023');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','set_hidden','staffAgentId',v_bob,'roomId',v_launch,
		'hidden',true),'22023');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_launch,v_launch)),'22023');
	perform pg_temp.member_error(v_owner,'{"action":"set_hidden","hidden":true}','22023');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_room','roomId',v_launch),'22023');

	-- An agent moving a coworker keeps the group chats of the section where they stood,
	-- and still lists only agents.
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','create_section','sectionId',v_ops,'name','Operations'));
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','move_room','roomId',v_launch,'sectionId',v_ops));
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','move_agent','agentId',v_bob,'section','Operations'));
	perform pg_temp.wake_assert((v_list ->> 'changed')::boolean
		and v_list #> '{sections,1,agents}' = jsonb_build_array(jsonb_build_object('id',v_bob,'name','Bob')),
		'The agent sees agents only');
	perform pg_temp.wake_assert(public.qorpera_sidebar_container('30000000-0000-4000-8000-000000000010',v_ops)
		= array[v_launch,v_bob]::uuid[],'The group chat keeps its place above the moved agent');
	-- Deleting a section sends its group chats to the end of Unassigned with its agents.
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','delete_section','section','Research'));
	perform pg_temp.wake_assert(public.qorpera_sidebar_container('30000000-0000-4000-8000-000000000010',null)
		= array[v_agent,v_hiring,v_carol]::uuid[],'A deleted section''s group chats are Unassigned, in their order');
	perform pg_temp.wake_assert((select section_id is null and position = 1
		from public.qorpera_company_sidebar_room_placements where room_id = v_hiring::uuid),'Its placement was renumbered');
end $$;

-- An archived group chat leaves every list but keeps its place; a deleted one takes its rows with it.
do $$
declare v_state jsonb;
begin
	perform pg_temp.member_sidebar('30000000-0000-4000-8000-000000000003',jsonb_build_object('action','set_pins',
		'order',jsonb_build_array('62200000-0000-4000-8000-000000000001','62200000-0000-4000-8000-000000000002')));
	update public.qorpera_company_rooms set status = 'archived' where id = '62200000-0000-4000-8000-000000000001';
	v_state := pg_temp.member_read('30000000-0000-4000-8000-000000000003');
	perform pg_temp.wake_assert(v_state -> 'pinned' = '["62200000-0000-4000-8000-000000000002"]'
		and not exists (select 1 from jsonb_array_elements(v_state -> 'roomPlacements') placement
			where placement ->> 'roomId' = '62200000-0000-4000-8000-000000000001'),'An archived group chat is not listed');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_sidebar_room_placements
		where room_id = '62200000-0000-4000-8000-000000000001'),'Its placement is kept');
	perform pg_temp.member_error('30000000-0000-4000-8000-000000000001',jsonb_build_object('action','move_room',
		'roomId','62200000-0000-4000-8000-000000000001','sectionId',null),'P0002');
	delete from public.qorpera_company_rooms where id = '62200000-0000-4000-8000-000000000002';
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_company_sidebar_room_placements
			where room_id = '62200000-0000-4000-8000-000000000002')
		and not exists (select 1 from public.qorpera_member_sidebar_rooms where room_id = '62200000-0000-4000-8000-000000000002'),
		'A deleted group chat leaves no sidebar rows');
end $$;

-- Members never read or write the group chat rows directly.
do $$
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
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
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_sidebar_place_room(uuid,uuid,uuid,uuid[],uuid,uuid)','execute')
		and not has_function_privilege('authenticated','public.qorpera_sidebar_container(uuid,uuid)','execute')
		and not has_function_privilege('authenticated','public.qorpera_sidebar_state(uuid,uuid)','execute')
		and has_function_privilege('authenticated','public.qorpera_manage_company_sidebar(uuid,jsonb)','execute')
		and not has_function_privilege('anon','public.qorpera_manage_company_sidebar(uuid,jsonb)','execute'),
		'Group chat sidebar grants');
end $$;

-- A group chat takes images like an agent's thread, within the same limits.
do $$
declare v_image jsonb := jsonb_build_object('objectSha256',repeat('c',64),'bytes',1024,'mediaType','image/png');
begin
	perform pg_temp.wake_assert(public.qorpera_room_post_images_valid(jsonb_build_object('images',jsonb_build_array(v_image)),false),
		'A group chat post takes an image');
	perform pg_temp.wake_assert(not public.qorpera_room_post_images_valid(jsonb_build_object('images',
		jsonb_build_array(v_image,v_image,v_image,v_image,v_image,v_image)),false),'At most five images');
	perform pg_temp.wake_assert(not public.qorpera_room_post_images_valid(jsonb_build_object('images',jsonb_build_array(
		v_image || '{"mediaType":"application/pdf"}')),false),'Images only');
	perform pg_temp.wake_assert(not public.qorpera_room_post_images_valid(jsonb_build_object('images',jsonb_build_array(
		v_image || '{"bytes":8388608}',v_image)),false),'8 MiB in all');
	perform pg_temp.wake_assert(public.qorpera_room_post_images_valid('{"images":[]}',false)
		and public.qorpera_room_post_images_valid('{}',false),'No images is still fine');
end $$;

rollback;
