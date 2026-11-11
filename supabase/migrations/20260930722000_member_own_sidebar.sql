-- Each member's own sidebar, over the company's (Jonas, 11 November 2026).
--
-- Jonas: "company's on creation. but when a member changes something it's specific to that member, like with any other
-- change to the sidepanel. we should really add a reset sidepanel button too, getting you back to companywide
-- defaults." Until now a member who made, renamed or deleted a section, or dragged an agent or a group chat, changed
-- the sidebar for everyone (on a folder-v2 company by writing QorperaOS/agents/sections.md). From here the company's
-- sidebar is the one its agents keep in that file, and it is what a new member sees; what a member changes is theirs.
--
-- What a member touches is theirs, and the rest keeps following the company: a member who moved one agent still sees
-- every other agent where the company's agents put it, today and after the agents sort again.
--
-- 1. qorpera_member_sidebar_sections: a member's own sections (own), and the company's sections they renamed or
--    removed for themselves. A row about a company section the company has since removed says nothing.
-- 2. qorpera_member_sidebar_places: where a member put an agent or a group chat: a section (theirs or the company's)
--    or none, and the item it stands after there (`first`: at the top; neither: at the end). The item keeps that
--    place while it is in the company and the section is still in the member's sidebar; otherwise the company's
--    place holds again.
-- 3. qorpera_member_sidebar_resets: what a member's last reset took away, so Undo can put it back.
-- 4. qorpera_sidebar_state, which qorpera_read_company_sidebar and qorpera_manage_company_sidebar answer with, now
--    answers the member's sidebar: the company's with the member's changes over it. Every agent and open group chat
--    gets an explicit place. Sections the member made carry `mine: true`. `own` counts and names what the member
--    changed (a client that reads it knows this cloud keeps each member's own sidebar).
-- 5. qorpera_manage_company_sidebar: creating, renaming and deleting sections and moving agents and group chats
--    change the caller's own sidebar, for any member, viewers too, and on every company. `reset` takes away
--    everything the caller changed in this company's sidebar (their sections, places, pins, hidden agents and group
--    chats, contact places and hidden pages); `undo_reset` puts the last reset's rows back where nothing newer took
--    their place.
-- 6. qorpera_place_member_contacts also takes the member's own sections.
--
-- The agents' organize_sidebar keeps writing the company's sections file, as before; nothing here changes it.

set local lock_timeout = '3s';

create table public.qorpera_member_sidebar_sections (
	profile_id uuid not null,
	user_id uuid not null,
	section_id uuid not null,
	-- true: a section the member made; false: one of the company's, renamed or removed for the member.
	own boolean not null,
	name text check (name is null or (char_length(name) between 1 and 60 and name = btrim(name) and name !~ '[[:cntrl:]]')),
	removed boolean not null default false,
	-- The order of the member's own sections, after the company's.
	position integer not null default 0 check (position >= 0),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, section_id),
	constraint qorpera_member_sidebar_sections_own check (not own or (name is not null and not removed)),
	constraint qorpera_member_sidebar_sections_change check (own or (removed = (name is null))),
	constraint qorpera_member_sidebar_sections_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);

create table public.qorpera_member_sidebar_places (
	profile_id uuid not null,
	user_id uuid not null,
	-- An agent or a group chat (qorpera_company_rooms.id).
	item_id uuid not null,
	-- The section, the member's or the company's; none: in no section.
	section_id uuid,
	after_item_id uuid,
	first boolean not null default false,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, item_id),
	constraint qorpera_member_sidebar_places_anchor check (not (first and after_item_id is not null)),
	constraint qorpera_member_sidebar_places_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);

create table public.qorpera_member_sidebar_resets (
	profile_id uuid not null,
	user_id uuid not null,
	-- The rows the reset took away, by table.
	removed jsonb not null,
	reset_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id),
	constraint qorpera_member_sidebar_resets_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);

alter table public.qorpera_member_sidebar_sections enable row level security;
alter table public.qorpera_member_sidebar_places enable row level security;
alter table public.qorpera_member_sidebar_resets enable row level security;
revoke all on public.qorpera_member_sidebar_sections from public, anon, authenticated, service_role;
revoke all on public.qorpera_member_sidebar_places from public, anon, authenticated, service_role;
revoke all on public.qorpera_member_sidebar_resets from public, anon, authenticated, service_role;
comment on table public.qorpera_member_sidebar_sections is
	'A member''s own sidebar sections, and the company''s sections they renamed or removed for themselves '
	'(20260930722000). Written only through qorpera_manage_company_sidebar.';
comment on table public.qorpera_member_sidebar_places is
	'Where a member put an agent or a group chat in their own sidebar (20260930722000). Written only through '
	'qorpera_manage_company_sidebar.';
comment on table public.qorpera_member_sidebar_resets is
	'What a member''s last sidebar reset took away, for Undo (20260930722000).';

/** The sections the member sees, in order: the company's (by the member's name for one they renamed, none they
 * removed), then the member's own. */
create function public.qorpera_sidebar_own_sections(p_profile_id uuid, p_user_id uuid)
returns table (section_id uuid, name text, own boolean, n bigint)
language sql stable security definer set search_path = '' as $$
	select listed.id, listed.name, listed.own,
		row_number() over (order by listed.part, listed.position, listed.created_at, listed.id)
	from (
		select section.id, coalesce(mine.name, section.name) as name, false as own, 0 as part,
			section.position, section.created_at
		from public.qorpera_company_sidebar_sections section
		left join public.qorpera_member_sidebar_sections mine
			on mine.profile_id = section.profile_id and mine.user_id = p_user_id and mine.section_id = section.id
				and not mine.own
		where section.profile_id = p_profile_id and not coalesce(mine.removed, false)
		union all
		select mine.section_id, mine.name, true, 1, mine.position, mine.created_at
		from public.qorpera_member_sidebar_sections mine
		where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.own
	) listed
$$;

/** Whether the member's place for an item holds: the item is still an agent or open group chat of the company, and
 * its section is still in the member's sidebar. */
create function public.qorpera_sidebar_own_place_holds(p_profile_id uuid, p_user_id uuid, p_item_id uuid,
	p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select (public.qorpera_sidebar_placeable(p_profile_id, p_item_id)
			or public.qorpera_sidebar_room_placeable(p_profile_id, p_item_id))
		and (p_section_id is null or exists (select 1 from public.qorpera_sidebar_own_sections(p_profile_id, p_user_id) seen
			where seen.section_id = p_section_id))
$$;

/** The member's sidebar: sections, and a place for every agent and open group chat. Each container starts from the
 * company's order (in none: also what stands in a company section the member removed), less what the member put
 * elsewhere; then what the member put there goes in after the item it stands after, oldest change first. An item
 * whose anchor is not there yet waits for a later pass, and goes to the end when its anchor never comes. */
create function public.qorpera_sidebar_own_view(p_profile_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_sections jsonb;
	v_containers uuid[];
	v_removed uuid[];
	v_moved uuid[];
	v_container uuid;
	v_list uuid[];
	v_items uuid[]; v_afters uuid[]; v_firsts boolean[]; v_done boolean[];
	v_progress boolean;
	v_at integer;
	v_index integer;
	v_agents jsonb := '[]';
	v_rooms jsonb := '[]';
	v_id uuid;
	v_n integer := 0;
begin
	select coalesce(jsonb_agg(jsonb_build_object('sectionId', seen.section_id, 'name', seen.name)
			|| case when seen.own then '{"mine":true}'::jsonb else '{}'::jsonb end order by seen.n), '[]'),
		coalesce(array_agg(seen.section_id order by seen.n), '{}')
	into v_sections, v_containers
	from public.qorpera_sidebar_own_sections(p_profile_id, p_user_id) seen;
	select coalesce(array_agg(section.id order by section.position, section.created_at, section.id), '{}') into v_removed
	from public.qorpera_company_sidebar_sections section
	join public.qorpera_member_sidebar_sections mine
		on mine.profile_id = section.profile_id and mine.user_id = p_user_id and mine.section_id = section.id
			and not mine.own and mine.removed
	where section.profile_id = p_profile_id;
	select coalesce(array_agg(place.item_id), '{}') into v_moved
	from public.qorpera_member_sidebar_places place
	where place.profile_id = p_profile_id and place.user_id = p_user_id
		and public.qorpera_sidebar_own_place_holds(p_profile_id, p_user_id, place.item_id, place.section_id);
	-- None first (index 0), then the sections in the member's order.
	for v_index in 0 .. pg_catalog.cardinality(v_containers) loop
		v_container := case when v_index = 0 then null else v_containers[v_index] end;
		if v_container is null then
			v_list := public.qorpera_sidebar_container(p_profile_id, null);
			foreach v_id in array v_removed loop
				v_list := v_list || public.qorpera_sidebar_container(p_profile_id, v_id);
			end loop;
		elsif exists (select 1 from public.qorpera_company_sidebar_sections section
				where section.profile_id = p_profile_id and section.id = v_container) then
			v_list := public.qorpera_sidebar_container(p_profile_id, v_container);
		else
			v_list := '{}';
		end if;
		select coalesce(array_agg(listed.id order by listed.n), '{}') into v_list
		from unnest(v_list) with ordinality listed(id, n) where not listed.id = any(v_moved);
		select coalesce(array_agg(place.item_id order by place.updated_at, place.item_id), '{}'),
			coalesce(array_agg(place.after_item_id order by place.updated_at, place.item_id), '{}'),
			coalesce(array_agg(place.first order by place.updated_at, place.item_id), '{}')
		into v_items, v_afters, v_firsts
		from public.qorpera_member_sidebar_places place
		where place.profile_id = p_profile_id and place.user_id = p_user_id
			and place.section_id is not distinct from v_container and place.item_id = any(v_moved);
		v_done := array_fill(false, array[pg_catalog.cardinality(v_items)]);
		loop
			v_progress := false;
			for v_at in 1 .. coalesce(pg_catalog.cardinality(v_items), 0) loop
				continue when v_done[v_at];
				if v_firsts[v_at] then
					v_list := array[v_items[v_at]] || v_list;
				elsif v_afters[v_at] is null then
					v_list := v_list || v_items[v_at];
				elsif v_afters[v_at] = any(v_list) then
					v_n := pg_catalog.array_position(v_list, v_afters[v_at]);
					v_list := v_list[1:v_n] || v_items[v_at] || v_list[v_n + 1:];
				else
					continue;
				end if;
				v_done[v_at] := true;
				v_progress := true;
			end loop;
			exit when not v_progress;
		end loop;
		for v_at in 1 .. coalesce(pg_catalog.cardinality(v_items), 0) loop
			if not v_done[v_at] then v_list := v_list || v_items[v_at]; end if;
		end loop;
		v_n := 0;
		foreach v_id in array v_list loop
			if public.qorpera_sidebar_room_placeable(p_profile_id, v_id) then
				v_rooms := v_rooms || jsonb_build_object('roomId', v_id, 'sectionId', v_container, 'position', v_n);
			else
				v_agents := v_agents || jsonb_build_object('staffAgentId', v_id, 'sectionId', v_container, 'position', v_n);
			end if;
			v_n := v_n + 1;
		end loop;
	end loop;
	return jsonb_build_object('sections', v_sections, 'placements', v_agents, 'roomPlacements', v_rooms);
end $$;

/** What the member changed in this company's sidebar, for the reset's question: the agents and group chats they put
 * somewhere, their sections, their pins and hidden items, their placed contacts and hidden pages. */
create function public.qorpera_sidebar_own_summary(p_profile_id uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	with moved as (
		select coalesce(jsonb_agg(place.item_id order by place.updated_at, place.item_id), '[]') as ids, count(*) as n
		from public.qorpera_member_sidebar_places place
		where place.profile_id = p_profile_id and place.user_id = p_user_id
			and public.qorpera_sidebar_own_place_holds(p_profile_id, p_user_id, place.item_id, place.section_id)
	), sections as (
		select coalesce(jsonb_agg(change.entry order by change.at, change.id), '[]') as list, count(*) as n
		from (
			select mine.section_id as id, mine.updated_at as at, case
					when mine.own then jsonb_build_object('change', 'added', 'name', mine.name)
					when mine.removed then jsonb_build_object('change', 'removed', 'name', section.name)
					else jsonb_build_object('change', 'renamed', 'from', section.name, 'name', mine.name) end as entry
			from public.qorpera_member_sidebar_sections mine
			left join public.qorpera_company_sidebar_sections section
				on section.profile_id = mine.profile_id and section.id = mine.section_id
			where mine.profile_id = p_profile_id and mine.user_id = p_user_id and (mine.own or section.id is not null)
		) change
	), marks as (
		select count(*) filter (where mark.pinned) as pinned, count(*) filter (where mark.hidden) as hidden
		from (
			select mine.pinned_position is not null as pinned, mine.hidden
			from public.qorpera_member_sidebar_agents mine
			where mine.profile_id = p_profile_id and mine.user_id = p_user_id
				and public.qorpera_sidebar_placeable(p_profile_id, mine.staff_agent_id)
			union all
			select mine.pinned_position is not null, mine.hidden
			from public.qorpera_member_sidebar_rooms mine
			where mine.profile_id = p_profile_id and mine.user_id = p_user_id
				and public.qorpera_sidebar_room_placeable(p_profile_id, mine.room_id)
		) mark
	), contacts as (
		-- Any row: a contact moved in the Members group (its rank) is the member's change too.
		select count(*) as n from public.qorpera_member_sidebar_contacts placed
		where placed.profile_id = p_profile_id and placed.user_id = p_user_id
	), pages as (
		select count(*) as n
		from public.qorpera_member_hidden_interface_pages mine
		join public.qorpera_company_files file on file.environment_id = mine.environment_id
		where file.profile_id = p_profile_id and mine.user_id = p_user_id
	)
	select jsonb_build_object(
		'changes', moved.n + sections.n + marks.pinned + marks.hidden + contacts.n + pages.n,
		'moved', moved.ids, 'sections', sections.list, 'pinned', marks.pinned, 'hidden', marks.hidden,
		'contacts', contacts.n, 'pages', pages.n)
	from moved, sections, marks, contacts, pages
$$;

create or replace function public.qorpera_sidebar_state(p_profile_id uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930722000: the member's own sidebar over the company's; `own` says what the member changed.
	select jsonb_build_object(
		'schema', 'qorpera.company-sidebar/v1',
		-- 20260930519000: agents/sections.md keeps the order of the agents and group chats in no section.
		'unassignedOrder', true,
		'own', public.qorpera_sidebar_own_summary(p_profile_id, p_user_id),
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
		|| public.qorpera_sidebar_own_view(p_profile_id, p_user_id)
$$;

/** A section the member sees whose name is p_name, but p_except; none: null. */
create function public.qorpera_sidebar_own_name_taken(p_profile_id uuid, p_user_id uuid, p_name text, p_except uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_sidebar_own_sections(p_profile_id, p_user_id) seen
		where lower(seen.name) = lower(p_name) and seen.section_id is distinct from p_except)
$$;

/** Puts an agent or a group chat in the member's own sidebar: in p_section (none: in no section), after the item
 * before it in p_order, the container as the member saw it (first when it leads; with no order: at the end). */
create function public.qorpera_sidebar_own_place(p_profile_id uuid, p_user_id uuid, p_item_id uuid, p_section_id uuid,
	p_order uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_at integer; v_after uuid; v_first boolean := false; v_view jsonb; v_section text; v_position integer;
	v_before uuid; v_dependent uuid;
begin
	if p_section_id is not null and not exists (select 1 from public.qorpera_sidebar_own_sections(p_profile_id, p_user_id) seen
			where seen.section_id = p_section_id) then
		raise exception 'That section is no longer in your sidebar' using errcode = 'P0002'; end if;
	-- What the member placed right after the item stays where it stood: it now stands after what stood before the item
	-- (first, when the item led), so no two places ever point at each other.
	v_view := public.qorpera_sidebar_own_view(p_profile_id, p_user_id);
	select listed.section, listed.position into v_section, v_position
	from (select entry ->> 'staffAgentId' as id, entry ->> 'sectionId' as section, (entry ->> 'position')::integer as position
			from jsonb_array_elements(v_view -> 'placements') entry
		union all
		select entry ->> 'roomId', entry ->> 'sectionId', (entry ->> 'position')::integer
			from jsonb_array_elements(v_view -> 'roomPlacements') entry) listed
	where listed.id = p_item_id::text;
	if found then
		select listed.id::uuid into v_before
		from (select entry ->> 'staffAgentId' as id, entry ->> 'sectionId' as section, (entry ->> 'position')::integer as position
				from jsonb_array_elements(v_view -> 'placements') entry
			union all
			select entry ->> 'roomId', entry ->> 'sectionId', (entry ->> 'position')::integer
				from jsonb_array_elements(v_view -> 'roomPlacements') entry) listed
		where listed.section is not distinct from v_section and listed.position = v_position - 1;
		-- Only what stands in the item's own section, in the order it stands there: the first takes the item's place,
		-- each next one stands after the one before it, so their order holds however old each place is.
		for v_dependent in
			select place.item_id
			from public.qorpera_member_sidebar_places place
			join (select entry ->> 'staffAgentId' as id, (entry ->> 'position')::integer as position
					from jsonb_array_elements(v_view -> 'placements') entry
					where entry ->> 'sectionId' is not distinct from v_section
				union all
				select entry ->> 'roomId', (entry ->> 'position')::integer
					from jsonb_array_elements(v_view -> 'roomPlacements') entry
					where entry ->> 'sectionId' is not distinct from v_section) listed on listed.id = place.item_id::text
			where place.profile_id = p_profile_id and place.user_id = p_user_id and place.after_item_id = p_item_id
				and place.item_id <> p_item_id and place.section_id::text is not distinct from v_section
			order by listed.position
		loop
			update public.qorpera_member_sidebar_places set after_item_id = v_before, first = v_before is null
			where profile_id = p_profile_id and user_id = p_user_id and item_id = v_dependent;
			v_before := v_dependent;
		end loop;
	end if;
	if p_order is not null then
		v_at := pg_catalog.array_position(p_order, p_item_id);
		if v_at is null then
			raise exception 'The order must name what is moved' using errcode = '22023'; end if;
		if (select count(distinct item) from unnest(p_order) item) <> pg_catalog.cardinality(p_order) then
			raise exception 'Each agent or group chat is in the order once' using errcode = '22023'; end if;
		if v_at = 1 then v_first := true; else v_after := p_order[v_at - 1]; end if;
	end if;
	insert into public.qorpera_member_sidebar_places as place
		(profile_id, user_id, item_id, section_id, after_item_id, first)
	values (p_profile_id, p_user_id, p_item_id, p_section_id, v_after, v_first)
	on conflict (profile_id, user_id, item_id) do update set
		section_id = excluded.section_id, after_item_id = excluded.after_item_id, first = excluded.first,
		updated_at = clock_timestamp();
end $$;

/** Takes away everything the member changed in this company's sidebar, and keeps it for one Undo. */
create function public.qorpera_sidebar_own_reset(p_profile_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- The rows kept for Undo are the rows this statement deleted: a change another call commits meanwhile is either
	-- deleted and kept, or made after and stays.
	with sections as (
		delete from public.qorpera_member_sidebar_sections mine
		where mine.profile_id = p_profile_id and mine.user_id = p_user_id returning mine.*
	), places as (
		delete from public.qorpera_member_sidebar_places place
		where place.profile_id = p_profile_id and place.user_id = p_user_id returning place.*
	), agents as (
		delete from public.qorpera_member_sidebar_agents mine
		where mine.profile_id = p_profile_id and mine.user_id = p_user_id returning mine.*
	), rooms as (
		delete from public.qorpera_member_sidebar_rooms mine
		where mine.profile_id = p_profile_id and mine.user_id = p_user_id returning mine.*
	), contacts as (
		delete from public.qorpera_member_sidebar_contacts placed
		where placed.profile_id = p_profile_id and placed.user_id = p_user_id returning placed.*
	), pages as (
		delete from public.qorpera_member_hidden_interface_pages mine
		using public.qorpera_company_files file
		where file.environment_id = mine.environment_id and file.profile_id = p_profile_id and mine.user_id = p_user_id
		returning mine.*
	)
	insert into public.qorpera_member_sidebar_resets as kept (profile_id, user_id, removed)
	select p_profile_id, p_user_id, jsonb_build_object(
		'sections', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from sections row_), '[]'),
		'places', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from places row_), '[]'),
		'agents', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from agents row_), '[]'),
		'rooms', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from rooms row_), '[]'),
		'contacts', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from contacts row_), '[]'),
		'pages', coalesce((select jsonb_agg(to_jsonb(row_) - 'user_id') from pages row_), '[]'))
	on conflict (profile_id, user_id) do update set removed = excluded.removed, reset_at = clock_timestamp();
end $$;

/** Puts back what the member's last reset took away. A row the member has made again since stays as it is now, and
 * one about an agent, group chat, member or page that is gone stays away. */
create function public.qorpera_sidebar_own_undo_reset(p_profile_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_removed jsonb;
begin
	delete from public.qorpera_member_sidebar_resets kept
	where kept.profile_id = p_profile_id and kept.user_id = p_user_id
	returning kept.removed into v_removed;
	if v_removed is null then
		raise exception 'There is no reset to undo' using errcode = 'P0002'; end if;
	insert into public.qorpera_member_sidebar_sections
		(profile_id, user_id, section_id, own, name, removed, position, created_at, updated_at)
	select p_profile_id, p_user_id, gone.section_id, gone.own, gone.name, gone.removed, gone.position, gone.created_at,
		gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_sidebar_sections, v_removed -> 'sections') gone
	on conflict do nothing;
	insert into public.qorpera_member_sidebar_places
		(profile_id, user_id, item_id, section_id, after_item_id, first, updated_at)
	select p_profile_id, p_user_id, gone.item_id, gone.section_id, gone.after_item_id, gone.first, gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_sidebar_places, v_removed -> 'places') gone
	on conflict do nothing;
	insert into public.qorpera_member_sidebar_agents
		(profile_id, user_id, staff_agent_id, pinned_position, hidden, updated_at)
	select p_profile_id, p_user_id, gone.staff_agent_id, gone.pinned_position, gone.hidden, gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_sidebar_agents, v_removed -> 'agents') gone
	where exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = gone.staff_agent_id)
	on conflict do nothing;
	insert into public.qorpera_member_sidebar_rooms
		(profile_id, user_id, room_id, pinned_position, hidden, updated_at)
	select p_profile_id, p_user_id, gone.room_id, gone.pinned_position, gone.hidden, gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_sidebar_rooms, v_removed -> 'rooms') gone
	where exists (select 1 from public.qorpera_company_rooms room where room.profile_id = p_profile_id and room.id = gone.room_id)
	on conflict do nothing;
	insert into public.qorpera_member_sidebar_contacts
		(profile_id, user_id, other_user_id, zone, section_id, after_item_id, rank, hidden, updated_at)
	select p_profile_id, p_user_id, gone.other_user_id, gone.zone, gone.section_id, gone.after_item_id, gone.rank, gone.hidden,
		gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_sidebar_contacts, v_removed -> 'contacts') gone
	where exists (select 1 from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = gone.other_user_id)
	on conflict do nothing;
	insert into public.qorpera_member_hidden_interface_pages (environment_id, user_id, page, hidden_at)
	select gone.environment_id, p_user_id, gone.page, gone.hidden_at
	from jsonb_populate_recordset(null::public.qorpera_member_hidden_interface_pages, v_removed -> 'pages') gone
	where exists (select 1 from public.qorpera_company_files file
		where file.environment_id = gone.environment_id and file.profile_id = p_profile_id)
	on conflict do nothing;
end $$;

create or replace function public.qorpera_manage_company_sidebar(p_profile_id uuid, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := public.qorpera_sidebar_member(p_profile_id);
	v_action text := p_request ->> 'action';
	v_agent uuid; v_room uuid; v_section uuid; v_order uuid[]; v_id uuid; v_index integer := 0; v_name text;
begin
	-- 20260930722000: sections and places are the caller's own; any member changes them, on every company.
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'action') is distinct from 'string'
		or p_request - array['action','sectionId','name','staffAgentId','roomId','order','unpin','hidden','groupChats']
			<> '{}'::jsonb
		or (p_request ? 'staffAgentId' and p_request ? 'roomId')
		or (p_request ? 'groupChats' and (p_request -> 'groupChats' <> 'true'::jsonb
			or v_action not in ('set_pins','move_agent'))) then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	if p_request ? 'unpin' and jsonb_typeof(p_request -> 'unpin') is distinct from 'boolean' then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	-- One change to a member's own sidebar at a time.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'qorpera.member-sidebar:' || p_profile_id::text || ':' || v_user::text, 0));
	if v_action = 'create_section' then
		if p_request - array['action','sectionId','name','staffAgentId','roomId','unpin'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id');
		v_name := public.qorpera_sidebar_section_name(p_request -> 'name');
		if exists (select 1 from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id = v_section)
			or exists (select 1 from public.qorpera_member_sidebar_sections
				where profile_id = p_profile_id and user_id = v_user and section_id = v_section) then
			raise exception 'That section id is taken' using errcode = '23505'; end if;
		if public.qorpera_sidebar_own_name_taken(p_profile_id, v_user, v_name, null) then
			raise exception 'A section with that name already exists' using errcode = '23505'; end if;
		if (select count(*) from public.qorpera_member_sidebar_sections
				where profile_id = p_profile_id and user_id = v_user and own) >= 50 then
			raise exception 'You can make at most 50 sections of your own' using errcode = '54000'; end if;
		insert into public.qorpera_member_sidebar_sections (profile_id, user_id, section_id, own, name, position)
		values (p_profile_id, v_user, v_section, true, v_name, coalesce((select max(position) + 1
			from public.qorpera_member_sidebar_sections where profile_id = p_profile_id and user_id = v_user and own), 0));
		if p_request ? 'staffAgentId' then
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_assert_agent(p_profile_id, v_agent);
			perform public.qorpera_sidebar_own_place(p_profile_id, v_user, v_agent, v_section, null);
		elsif p_request ? 'roomId' then
			v_room := public.qorpera_sidebar_uuid(p_request -> 'roomId', 'The group chat');
			perform public.qorpera_sidebar_assert_room(p_profile_id, v_room);
			perform public.qorpera_sidebar_own_place(p_profile_id, v_user, v_room, v_section, null);
		end if;
	elsif v_action = 'rename_section' then
		if p_request - array['action','sectionId','name'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id');
		v_name := public.qorpera_sidebar_section_name(p_request -> 'name');
		if not exists (select 1 from public.qorpera_sidebar_own_sections(p_profile_id, v_user) seen
				where seen.section_id = v_section) then
			raise exception 'No section is called that' using errcode = 'P0002'; end if;
		if public.qorpera_sidebar_own_name_taken(p_profile_id, v_user, v_name, v_section) then
			raise exception 'A section with that name already exists' using errcode = '23505'; end if;
		if exists (select 1 from public.qorpera_member_sidebar_sections
				where profile_id = p_profile_id and user_id = v_user and section_id = v_section and own) then
			update public.qorpera_member_sidebar_sections set name = v_name, updated_at = clock_timestamp()
			where profile_id = p_profile_id and user_id = v_user and section_id = v_section;
		elsif v_name = (select name from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id = v_section) then
			-- Back to the company's name: nothing of the member's is left to keep.
			delete from public.qorpera_member_sidebar_sections
			where profile_id = p_profile_id and user_id = v_user and section_id = v_section;
		else
			insert into public.qorpera_member_sidebar_sections as mine (profile_id, user_id, section_id, own, name, removed)
			values (p_profile_id, v_user, v_section, false, v_name, false)
			on conflict (profile_id, user_id, section_id) do update set name = excluded.name, removed = false,
				updated_at = clock_timestamp();
		end if;
	elsif v_action = 'delete_section' then
		if p_request - array['action','sectionId'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id');
		if not exists (select 1 from public.qorpera_sidebar_own_sections(p_profile_id, v_user) seen
				where seen.section_id = v_section) then
			raise exception 'No section is called that' using errcode = 'P0002'; end if;
		-- What the member put in it goes back to where the company keeps it.
		delete from public.qorpera_member_sidebar_places
		where profile_id = p_profile_id and user_id = v_user and section_id = v_section;
		if exists (select 1 from public.qorpera_member_sidebar_sections
				where profile_id = p_profile_id and user_id = v_user and section_id = v_section and own) then
			delete from public.qorpera_member_sidebar_sections
			where profile_id = p_profile_id and user_id = v_user and section_id = v_section;
		else
			insert into public.qorpera_member_sidebar_sections as mine (profile_id, user_id, section_id, own, name, removed)
			values (p_profile_id, v_user, v_section, false, null, true)
			on conflict (profile_id, user_id, section_id) do update set name = null, removed = true,
				updated_at = clock_timestamp();
		end if;
	elsif v_action in ('move_agent','move_room') then
		if p_request - array['action','sectionId',case when v_action = 'move_agent' then 'staffAgentId' else 'roomId' end,
			'order','unpin','groupChats'] <> '{}'::jsonb or not p_request ? 'sectionId' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := case when p_request -> 'sectionId' = 'null'::jsonb then null
			else public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id') end;
		if p_request ? 'order' then v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 500); end if;
		if v_action = 'move_agent' then
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_assert_agent(p_profile_id, v_agent);
			perform public.qorpera_sidebar_own_place(p_profile_id, v_user, v_agent, v_section, v_order);
		else
			v_room := public.qorpera_sidebar_uuid(p_request -> 'roomId', 'The group chat');
			perform public.qorpera_sidebar_assert_room(p_profile_id, v_room);
			perform public.qorpera_sidebar_own_place(p_profile_id, v_user, v_room, v_section, v_order);
		end if;
	elsif v_action = 'reset' then
		if p_request - array['action'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		perform public.qorpera_sidebar_own_reset(p_profile_id, v_user);
	elsif v_action = 'undo_reset' then
		if p_request - array['action'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		perform public.qorpera_sidebar_own_undo_reset(p_profile_id, v_user);
	elsif v_action = 'set_pins' then
		if p_request - array['action','order','groupChats'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 24);
		-- A page opened before group chats were placed pins agents only: the member's
		-- pinned group chats stay, after the agents, in their order.
		if not p_request ? 'groupChats' then
			v_order := v_order || coalesce((select array_agg(mine.room_id order by mine.pinned_position, mine.updated_at, mine.room_id)
				from public.qorpera_member_sidebar_rooms mine
				where mine.profile_id = p_profile_id and mine.user_id = v_user and mine.pinned_position is not null
					and public.qorpera_sidebar_room_placeable(p_profile_id, mine.room_id)
					and not mine.room_id = any(v_order)), '{}');
			if pg_catalog.cardinality(v_order) > 24 then
				raise exception 'The order must be a list of at most 24 agent ids' using errcode = '22023'; end if;
		end if;
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
				-- Hiding also takes the group chat out of the member's pinned gone.
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
				-- Hiding also takes the agent out of the member's pinned gone.
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
	-- The member's other tabs and devices draw it again.
	perform public.qorpera_sidebar_touch(p_profile_id);
	return public.qorpera_sidebar_state(p_profile_id, v_user);
end $$;

-- A contact may stand in a section of the member's own too.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_place_member_contacts(uuid,jsonb)'::regprocedure);
	v_old constant text := $old$			where section.profile_id = p_profile_id and section.id = (item ->> 'sectionId')::uuid)$old$;
	v_new constant text := $new$			where section.profile_id = p_profile_id and section.id = (item ->> 'sectionId')::uuid)
			-- 20260930722000: or one of the member's own.
			and not exists (select 1 from public.qorpera_member_sidebar_sections as mine
				where mine.profile_id = p_profile_id and mine.user_id = v_user and mine.own
					and mine.section_id = (item ->> 'sectionId')::uuid)$new$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'qorpera_place_member_contacts is not the text 20260930722000 expects'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

revoke all on function public.qorpera_sidebar_own_sections(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_place_holds(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_view(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_summary(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_name_taken(uuid, uuid, text, uuid)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_place(uuid, uuid, uuid, uuid, uuid[])
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_reset(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sidebar_own_undo_reset(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_manage_company_sidebar(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_manage_company_sidebar(uuid, jsonb) to authenticated;

comment on function public.qorpera_manage_company_sidebar(uuid, jsonb) is
	'Changes the caller''s own sidebar in a company (20260930722000): their sections, where agents and group chats '
	'stand, pins and hidden items; `reset` takes all of it away, `undo_reset` puts the last reset back.';
