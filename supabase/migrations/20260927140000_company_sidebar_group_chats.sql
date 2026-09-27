-- Group chats in the sidebar and in the composer (founder request 2026-09-27: "group
-- chats are basically broken on the web client").
--
-- 1. A group chat (a company room that is not an agent's own thread) is placed, pinned
--    and hidden like an agent. It sits in a section or in Unassigned, among the agents
--    there: agents and group chats share one order per container. Pins are one ordered
--    row per member, agents and group chats mixed, at most 24 in all.
--    Its placement is the company's (owner/admin/contributor); pins and hidden are the
--    member's own, as for agents. Only an active group chat is placed; a deleted one
--    takes its rows with it, an archived one keeps them for a return.
--    The read keeps its shape for older clients: agent placements stay in `placements`
--    and group chats' in a new `roomPlacements`; `pinned` and `hidden` now list both
--    kinds of id, which an older client simply does not find in its roster.
--    The agent tool organize_sidebar is unchanged: it still lists and moves agents
--    only, and group chats keep their places around the agents it moves.
-- 2. A group chat takes images like an agent's thread: up to 5, 8 MiB in all
--    (contract amendment 2026-09-27; team rooms were text-only).
begin;

create table public.qorpera_company_sidebar_room_placements (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	room_id uuid not null references public.qorpera_company_rooms(id) on delete cascade,
	section_id uuid,
	position integer not null check (position >= 0),
	updated_at timestamptz not null default clock_timestamp(),
	updated_by_user_id uuid references auth.users(id) on delete set null,
	updated_by_staff_agent_id uuid,
	primary key (profile_id, room_id),
	foreign key (profile_id, section_id)
		references public.qorpera_company_sidebar_sections(profile_id, id) on delete set null (section_id)
);
create index qorpera_company_sidebar_room_placements_section
	on public.qorpera_company_sidebar_room_placements(profile_id, section_id, position);
create index qorpera_company_sidebar_room_placements_room
	on public.qorpera_company_sidebar_room_placements(room_id);

create table public.qorpera_member_sidebar_rooms (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	room_id uuid not null references public.qorpera_company_rooms(id) on delete cascade,
	pinned_position integer check (pinned_position >= 0),
	hidden boolean not null default false,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, room_id)
);
create index qorpera_member_sidebar_rooms_room on public.qorpera_member_sidebar_rooms(room_id);

alter table public.qorpera_company_sidebar_room_placements enable row level security;
alter table public.qorpera_member_sidebar_rooms enable row level security;
revoke all on public.qorpera_company_sidebar_room_placements from public, anon, authenticated, service_role;
revoke all on public.qorpera_member_sidebar_rooms from public, anon, authenticated, service_role;

/** A group chat the sidebar can place: an active room of the company that is not an agent's own thread. */
create function public.qorpera_sidebar_room_placeable(p_profile_id uuid, p_room_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_rooms room
		where room.id = p_room_id and room.profile_id = p_profile_id
			and room.bound_staff_agent_id is null and room.status = 'active')
$$;

create function public.qorpera_sidebar_assert_room(p_profile_id uuid, p_room_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if p_room_id is null then raise exception 'Name the group chat to place' using errcode = '22023'; end if;
	if not public.qorpera_sidebar_room_placeable(p_profile_id, p_room_id) then
		raise exception 'That is not an active group chat of this company' using errcode = 'P0002'; end if;
end $$;

/** Whether an id in a pin order is a group chat; otherwise it must be a placeable agent. */
create function public.qorpera_sidebar_is_room(p_profile_id uuid, p_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	if public.qorpera_sidebar_room_placeable(p_profile_id, p_id) then return true; end if;
	perform public.qorpera_sidebar_assert_agent(p_profile_id, p_id);
	return false;
end $$;

/** The agents and group chats a section (null: Unassigned) shows, in order. Positioned
 * ones first; then agents in roster order, then group chats oldest first. */
create or replace function public.qorpera_sidebar_container(p_profile_id uuid, p_section_id uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
	select coalesce(array_agg(item.id order by item.position nulls last, item.kind, item.created_at, item.id), '{}')
	from (
		select staff.staff_agent_id as id, placement.position, 0 as kind, staff.created_at
		from public.qorpera_profile_staff staff
		left join public.qorpera_company_sidebar_placements placement
			on placement.profile_id = staff.profile_id and placement.staff_agent_id = staff.staff_agent_id
		where staff.profile_id = p_profile_id and staff.employment_status = 'active' and staff.deleted_at is null
			and not public.qorpera_sidebar_is_cofounder(staff.profile_id, staff.staff_agent_id)
			and placement.section_id is not distinct from p_section_id
		union all
		select room.id, placement.position, 1, room.created_at
		from public.qorpera_company_rooms room
		left join public.qorpera_company_sidebar_room_placements placement
			on placement.profile_id = room.profile_id and placement.room_id = room.id
		where room.profile_id = p_profile_id and room.bound_staff_agent_id is null and room.status = 'active'
			and placement.section_id is not distinct from p_section_id
	) item
$$;

/** Writes a container's order as positions 0..n-1, agents and group chats alike. Items without a row get one. */
create or replace function public.qorpera_sidebar_write_order(p_profile_id uuid, p_section_id uuid, p_order uuid[],
	p_user_id uuid, p_staff_agent_id uuid)
returns void language sql security definer set search_path = '' as $$
	insert into public.qorpera_company_sidebar_placements as placement(profile_id, staff_agent_id, section_id, position,
		updated_by_user_id, updated_by_staff_agent_id)
	select p_profile_id, item.staff_agent_id, p_section_id, (item.ordinality - 1)::integer, p_user_id, p_staff_agent_id
	from unnest(p_order) with ordinality as item(staff_agent_id, ordinality)
	where exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = item.staff_agent_id)
	on conflict (profile_id, staff_agent_id) do update set
		section_id = excluded.section_id, position = excluded.position, updated_at = clock_timestamp(),
		updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = excluded.updated_by_staff_agent_id
	-- A row that keeps its place is not written, so it keeps its last editor.
	where (placement.section_id, placement.position) is distinct from (excluded.section_id, excluded.position);
	insert into public.qorpera_company_sidebar_room_placements as placement(profile_id, room_id, section_id, position,
		updated_by_user_id, updated_by_staff_agent_id)
	select p_profile_id, item.room_id, p_section_id, (item.ordinality - 1)::integer, p_user_id, p_staff_agent_id
	from unnest(p_order) with ordinality as item(room_id, ordinality)
	where exists (select 1 from public.qorpera_company_rooms room
		where room.profile_id = p_profile_id and room.id = item.room_id and room.bound_staff_agent_id is null)
	on conflict (profile_id, room_id) do update set
		section_id = excluded.section_id, position = excluded.position, updated_at = clock_timestamp(),
		updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = excluded.updated_by_staff_agent_id
	where (placement.section_id, placement.position) is distinct from (excluded.section_id, excluded.position)
$$;

/** Moves a group chat into a section (null: Unassigned), as qorpera_sidebar_place moves an
 * agent. With p_order, the section's agents and group chats take that order (unknown ids
 * are skipped; the ones it leaves out follow in their current order); without it the
 * group chat goes last. Answers whether anything moved. */
create function public.qorpera_sidebar_place_room(p_profile_id uuid, p_room_id uuid, p_section_id uuid,
	p_order uuid[], p_user_id uuid, p_actor_staff_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_before uuid[]; v_members uuid[]; v_final uuid[]; v_current uuid; v_placed boolean; v_id uuid;
begin
	perform public.qorpera_sidebar_lock(p_profile_id);
	perform public.qorpera_sidebar_assert_room(p_profile_id, p_room_id);
	if p_section_id is not null and not exists (select 1 from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and id = p_section_id) then
		raise exception 'No section is called that' using errcode = 'P0002'; end if;
	select section_id into v_current from public.qorpera_company_sidebar_room_placements
	where profile_id = p_profile_id and room_id = p_room_id;
	v_placed := found;
	v_before := public.qorpera_sidebar_container(p_profile_id, p_section_id);
	v_members := array_remove(v_before, p_room_id);
	if p_order is null then
		if v_current is not distinct from p_section_id and p_room_id = any(v_before) then return false; end if;
		v_final := v_members || p_room_id;
	else
		if pg_catalog.cardinality(p_order) > 500 then raise exception 'Sidebar order is too long' using errcode = '22023'; end if;
		v_final := '{}';
		foreach v_id in array p_order loop
			if v_id is not null and (v_id = p_room_id or v_id = any(v_members)) and not v_id = any(v_final) then
				v_final := v_final || v_id;
			end if;
		end loop;
		if not p_room_id = any(v_final) then v_final := v_final || p_room_id; end if;
		foreach v_id in array v_members loop
			if not v_id = any(v_final) then v_final := v_final || v_id; end if;
		end loop;
		if v_final = v_before and v_placed and v_current is not distinct from p_section_id then return false; end if;
	end if;
	perform public.qorpera_sidebar_write_order(p_profile_id, p_section_id, v_final, p_user_id, p_actor_staff_id);
	perform public.qorpera_sidebar_touch(p_profile_id);
	return true;
end $$;

/** What one member's rail is built from. */
create or replace function public.qorpera_sidebar_state(p_profile_id uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'schema', 'qorpera.company-sidebar/v1',
		'sections', coalesce((select jsonb_agg(jsonb_build_object('sectionId', section.id, 'name', section.name)
				order by section.position, section.created_at, section.id)
			from public.qorpera_company_sidebar_sections section where section.profile_id = p_profile_id), '[]'),
		'placements', coalesce((select jsonb_agg(jsonb_build_object('staffAgentId', placement.staff_agent_id,
				'sectionId', placement.section_id, 'position', placement.position)
				order by placement.staff_agent_id)
			from public.qorpera_company_sidebar_placements placement
			where placement.profile_id = p_profile_id
				and public.qorpera_sidebar_placeable(p_profile_id, placement.staff_agent_id)), '[]'),
		'roomPlacements', coalesce((select jsonb_agg(jsonb_build_object('roomId', placement.room_id,
				'sectionId', placement.section_id, 'position', placement.position)
				order by placement.room_id)
			from public.qorpera_company_sidebar_room_placements placement
			where placement.profile_id = p_profile_id
				and public.qorpera_sidebar_room_placeable(p_profile_id, placement.room_id)), '[]'),
		'pinned', coalesce((select jsonb_agg(pin.id order by pin.pinned_position, pin.updated_at, pin.id)
			from (
				select mine.staff_agent_id as id, mine.pinned_position, mine.updated_at
				from public.qorpera_member_sidebar_agents mine
				where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.pinned_position is not null
					and public.qorpera_sidebar_placeable(p_profile_id, mine.staff_agent_id)
				union all
				select mine.room_id, mine.pinned_position, mine.updated_at
				from public.qorpera_member_sidebar_rooms mine
				where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.pinned_position is not null
					and public.qorpera_sidebar_room_placeable(p_profile_id, mine.room_id)
			) pin), '[]'),
		'hidden', coalesce((select jsonb_agg(hide.id order by hide.id)
			from (
				select mine.staff_agent_id as id
				from public.qorpera_member_sidebar_agents mine
				where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.hidden
					and public.qorpera_sidebar_placeable(p_profile_id, mine.staff_agent_id)
				union all
				select mine.room_id
				from public.qorpera_member_sidebar_rooms mine
				where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.hidden
					and public.qorpera_sidebar_room_placeable(p_profile_id, mine.room_id)
			) hide), '[]'))
$$;

/** A member's sidebar changes. Sections and placement are the company's and need
 * owner, admin or contributor; pins and hidden agents and group chats are the member's
 * own. Answers the member's sidebar after the change. A group chat is named by roomId
 * where an agent is named by staffAgentId. */
create or replace function public.qorpera_manage_company_sidebar(p_profile_id uuid, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := public.qorpera_sidebar_member(p_profile_id);
	v_action text := p_request ->> 'action';
	v_agent uuid; v_room uuid; v_section uuid; v_order uuid[]; v_id uuid; v_index integer := 0;
begin
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'action') is distinct from 'string'
		or p_request - array['action','sectionId','name','staffAgentId','roomId','order','unpin','hidden'] <> '{}'::jsonb
		or (p_request ? 'staffAgentId' and p_request ? 'roomId') then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	if p_request ? 'unpin' and jsonb_typeof(p_request -> 'unpin') is distinct from 'boolean' then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	if v_action in ('create_section','rename_section','delete_section','move_agent','move_room')
		and not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Only owners, admins and contributors can change the company''s sections' using errcode = '42501'; end if;
	if v_action = 'create_section' then
		if p_request - array['action','sectionId','name','staffAgentId','roomId','unpin'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_create_section(p_profile_id,
			public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id'),
			public.qorpera_sidebar_section_name(p_request -> 'name'), v_user, null);
		if p_request ? 'staffAgentId' then
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_place(p_profile_id, v_agent, v_section, null, v_user, null);
		elsif p_request ? 'roomId' then
			v_room := public.qorpera_sidebar_uuid(p_request -> 'roomId', 'The group chat');
			perform public.qorpera_sidebar_place_room(p_profile_id, v_room, v_section, null, v_user, null);
		end if;
	elsif v_action = 'rename_section' then
		if p_request - array['action','sectionId','name'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id');
		if not exists (select 1 from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id = v_section) then
			raise exception 'No section is called that' using errcode = 'P0002'; end if;
		perform public.qorpera_sidebar_rename_section(p_profile_id, v_section,
			public.qorpera_sidebar_section_name(p_request -> 'name'), v_user, null);
	elsif v_action = 'delete_section' then
		if p_request - array['action','sectionId'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		perform public.qorpera_sidebar_delete_section(p_profile_id,
			public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id'), v_user, null);
	elsif v_action in ('move_agent','move_room') then
		if p_request - array['action','sectionId',case when v_action = 'move_agent' then 'staffAgentId' else 'roomId' end,
			'order','unpin'] <> '{}'::jsonb or not p_request ? 'sectionId' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := case when p_request -> 'sectionId' = 'null'::jsonb then null
			else public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id') end;
		if p_request ? 'order' then v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 500); end if;
		if v_action = 'move_agent' then
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_place(p_profile_id, v_agent, v_section, v_order, v_user, null);
		else
			v_room := public.qorpera_sidebar_uuid(p_request -> 'roomId', 'The group chat');
			perform public.qorpera_sidebar_place_room(p_profile_id, v_room, v_section, v_order, v_user, null);
		end if;
	elsif v_action = 'set_pins' then
		if p_request - array['action','order'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 24);
		if (select count(distinct item) from unnest(v_order) item) <> pg_catalog.cardinality(v_order) then
			raise exception 'An agent or group chat is pinned once' using errcode = '22023'; end if;
		update public.qorpera_member_sidebar_agents set pinned_position = null, updated_at = clock_timestamp()
		where profile_id = p_profile_id and user_id = v_user and pinned_position is not null
			and not staff_agent_id = any(v_order);
		update public.qorpera_member_sidebar_rooms set pinned_position = null, updated_at = clock_timestamp()
		where profile_id = p_profile_id and user_id = v_user and pinned_position is not null
			and not room_id = any(v_order);
		foreach v_id in array v_order loop
			-- Pinning shows a hidden agent or group chat again.
			if public.qorpera_sidebar_is_room(p_profile_id, v_id) then
				insert into public.qorpera_member_sidebar_rooms as mine(profile_id, user_id, room_id, pinned_position, hidden)
				values (p_profile_id, v_user, v_id, v_index, false)
				on conflict (profile_id, user_id, room_id) do update set
					pinned_position = excluded.pinned_position, hidden = false,
					updated_at = case when mine.pinned_position is distinct from excluded.pinned_position or mine.hidden
						then clock_timestamp() else mine.updated_at end;
			else
				insert into public.qorpera_member_sidebar_agents as mine(profile_id, user_id, staff_agent_id, pinned_position, hidden)
				values (p_profile_id, v_user, v_id, v_index, false)
				on conflict (profile_id, user_id, staff_agent_id) do update set
					pinned_position = excluded.pinned_position, hidden = false,
					updated_at = case when mine.pinned_position is distinct from excluded.pinned_position or mine.hidden
						then clock_timestamp() else mine.updated_at end;
			end if;
			v_index := v_index + 1;
		end loop;
	elsif v_action = 'set_hidden' then
		if p_request - array['action','staffAgentId','roomId','hidden'] <> '{}'::jsonb
			or not (p_request ? 'staffAgentId' or p_request ? 'roomId')
			or jsonb_typeof(p_request -> 'hidden') is distinct from 'boolean' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		if p_request ? 'roomId' then
			v_room := public.qorpera_sidebar_uuid(p_request -> 'roomId', 'The group chat');
			perform public.qorpera_sidebar_assert_room(p_profile_id, v_room);
			if (p_request ->> 'hidden')::boolean then
				-- Hiding also takes the group chat out of the member's pinned row.
				insert into public.qorpera_member_sidebar_rooms(profile_id, user_id, room_id, pinned_position, hidden)
				values (p_profile_id, v_user, v_room, null, true)
				on conflict (profile_id, user_id, room_id) do update set
					hidden = true, pinned_position = null, updated_at = clock_timestamp();
			else
				update public.qorpera_member_sidebar_rooms set hidden = false, updated_at = clock_timestamp()
				where profile_id = p_profile_id and user_id = v_user and room_id = v_room and hidden;
			end if;
		else
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_assert_agent(p_profile_id, v_agent);
			if (p_request ->> 'hidden')::boolean then
				-- Hiding also takes the agent out of the member's pinned row.
				insert into public.qorpera_member_sidebar_agents(profile_id, user_id, staff_agent_id, pinned_position, hidden)
				values (p_profile_id, v_user, v_agent, null, true)
				on conflict (profile_id, user_id, staff_agent_id) do update set
					hidden = true, pinned_position = null, updated_at = clock_timestamp();
			else
				update public.qorpera_member_sidebar_agents set hidden = false, updated_at = clock_timestamp()
				where profile_id = p_profile_id and user_id = v_user and staff_agent_id = v_agent and hidden;
			end if;
		end if;
	else
		raise exception 'Sidebar request is invalid' using errcode = '22023';
	end if;
	if v_action in ('create_section','move_agent','move_room') and coalesce((p_request ->> 'unpin')::boolean, false) then
		if v_agent is not null then
			update public.qorpera_member_sidebar_agents set pinned_position = null, updated_at = clock_timestamp()
			where profile_id = p_profile_id and user_id = v_user and staff_agent_id = v_agent;
		elsif v_room is not null then
			update public.qorpera_member_sidebar_rooms set pinned_position = null, updated_at = clock_timestamp()
			where profile_id = p_profile_id and user_id = v_user and room_id = v_room;
		end if;
	end if;
	-- A row that neither pins nor hides says nothing.
	delete from public.qorpera_member_sidebar_agents
	where profile_id = p_profile_id and user_id = v_user and pinned_position is null and not hidden;
	delete from public.qorpera_member_sidebar_rooms
	where profile_id = p_profile_id and user_id = v_user and pinned_position is null and not hidden;
	return public.qorpera_sidebar_state(p_profile_id, v_user);
end $$;

-- Group chats take images like an agent's thread (was: team rooms stay text-only).
-- p_agent_thread stays in the signature for qorpera_post_company_room_message, which
-- passes it, and no longer decides anything.
create or replace function public.qorpera_room_post_images_valid(p_body jsonb, p_agent_thread boolean) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_image jsonb; v_bytes bigint; v_total bigint := 0;
begin
	if not (p_body ? 'images') then return true; end if;
	if jsonb_typeof(p_body -> 'images') <> 'array' then return false; end if;
	if jsonb_array_length(p_body -> 'images') > 5 then return false; end if;
	for v_image in select value from jsonb_array_elements(p_body -> 'images') loop
		if jsonb_typeof(v_image) is distinct from 'object' or v_image - 'objectSha256' - 'bytes' - 'mediaType' <> '{}'::jsonb
			or coalesce(v_image ->> 'objectSha256','') !~ '^[0-9a-f]{64}$'
			or jsonb_typeof(v_image -> 'bytes') is distinct from 'number'
			or coalesce(v_image ->> 'mediaType','') not in ('image/png','image/jpeg','image/gif','image/webp') then return false; end if;
		begin v_bytes := (v_image ->> 'bytes')::bigint; exception when others then return false; end;
		if to_jsonb(v_bytes) <> v_image -> 'bytes' or v_bytes not between 1 and 8388608 then return false; end if;
		v_total := v_total + v_bytes;
		if v_total > 8388608 then return false; end if;
	end loop;
	return true;
end
$$;

-- CREATE OR REPLACE keeps each replaced function's ACL; it is restated with the new ones.
revoke all on function public.qorpera_sidebar_room_placeable(uuid, uuid),
	public.qorpera_sidebar_assert_room(uuid, uuid),
	public.qorpera_sidebar_is_room(uuid, uuid),
	public.qorpera_sidebar_container(uuid, uuid),
	public.qorpera_sidebar_write_order(uuid, uuid, uuid[], uuid, uuid),
	public.qorpera_sidebar_place_room(uuid, uuid, uuid, uuid[], uuid, uuid),
	public.qorpera_sidebar_state(uuid, uuid),
	public.qorpera_manage_company_sidebar(uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_manage_company_sidebar(uuid, jsonb) to authenticated;
revoke all on function public.qorpera_room_post_images_valid(jsonb, boolean) from public, anon, authenticated, service_role;

commit;
