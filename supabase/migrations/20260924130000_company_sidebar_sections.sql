-- Company sidebar sections (founder decision 2026-09-24, Grok Bot's rail).
--
-- Sections belong to the company: every member sees the same sections, and
-- members and agents alike create, rename and delete them and move agents
-- between them, so agents can organise themselves. An agent sits in at most
-- one section; an agent in none is "Unassigned". The Co-Founder always stands
-- above the sections and is never placed.
--
-- Pins and hidden agents belong to one member: a member's own quick row under
-- the Co-Founder card, and agents that member keeps out of their rail. They are
-- read and written only through the member RPCs below.
--
-- Order is explicit: positions within a section (and within Unassigned) are
-- shared, pin positions are per member. Agents without a position follow the
-- positioned ones in roster order (created_at, id), the order
-- qorpera_list_profile_staff returns, so a client draws the same order.
--
-- Every change to the shared sidebar bumps one row per company in
-- qorpera_company_sidebar_revisions, the only sidebar table in the realtime
-- publication and the only one members read directly: a move by anyone (an agent
-- included) reaches every open rail as one hint, however many rows it renumbered,
-- and no DELETE event (which Realtime delivers unfiltered) ever leaves it.
begin;

create table public.qorpera_company_sidebar_sections (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	name text not null check (char_length(name) between 1 and 60 and name = btrim(name) and name !~ '[[:cntrl:]]'),
	position integer not null check (position >= 0),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_by_staff_agent_id uuid,
	updated_by_user_id uuid references auth.users(id) on delete set null,
	updated_by_staff_agent_id uuid,
	unique (profile_id, id)
);
create unique index qorpera_company_sidebar_sections_name
	on public.qorpera_company_sidebar_sections(profile_id, lower(name));

create table public.qorpera_company_sidebar_placements (
	profile_id uuid not null,
	staff_agent_id uuid not null,
	section_id uuid,
	position integer not null check (position >= 0),
	updated_at timestamptz not null default clock_timestamp(),
	updated_by_user_id uuid references auth.users(id) on delete set null,
	updated_by_staff_agent_id uuid,
	primary key (profile_id, staff_agent_id),
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete cascade,
	foreign key (profile_id, section_id)
		references public.qorpera_company_sidebar_sections(profile_id, id) on delete set null (section_id)
);
create index qorpera_company_sidebar_placements_section
	on public.qorpera_company_sidebar_placements(profile_id, section_id, position);

create table public.qorpera_member_sidebar_agents (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	staff_agent_id uuid not null,
	pinned_position integer check (pinned_position >= 0),
	hidden boolean not null default false,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, staff_agent_id),
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete cascade
);

create table public.qorpera_company_sidebar_revisions (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	revision bigint not null default 1 check (revision > 0),
	updated_at timestamptz not null default clock_timestamp()
);

alter table public.qorpera_company_sidebar_revisions enable row level security;
alter table public.qorpera_company_sidebar_sections enable row level security;
alter table public.qorpera_company_sidebar_placements enable row level security;
alter table public.qorpera_member_sidebar_agents enable row level security;
revoke all on public.qorpera_company_sidebar_sections from public, anon, authenticated, service_role;
revoke all on public.qorpera_company_sidebar_placements from public, anon, authenticated, service_role;
revoke all on public.qorpera_member_sidebar_agents from public, anon, authenticated, service_role;
revoke all on public.qorpera_company_sidebar_revisions from public, anon, authenticated, service_role;
-- Read access exists for Realtime change hints only; every write goes through the functions below.
grant select on public.qorpera_company_sidebar_revisions to authenticated;
create policy qorpera_company_sidebar_revisions_member_read on public.qorpera_company_sidebar_revisions
	for select to authenticated using (public.qorpera_can_read_profile(profile_id));

do $$
begin
	if not exists (select 1 from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'qorpera_company_sidebar_revisions') then
		alter publication supabase_realtime add table public.qorpera_company_sidebar_revisions;
	end if;
end
$$;

-- One writer per company sidebar at a time: positions are renumbered as a whole.
create function public.qorpera_sidebar_lock(p_profile_id uuid)
returns void language sql security definer set search_path = '' as $$
	select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.company-sidebar:' || p_profile_id::text, 0))
$$;

/** One hint for every open rail: the shared sidebar changed. */
create function public.qorpera_sidebar_touch(p_profile_id uuid)
returns void language sql security definer set search_path = '' as $$
	insert into public.qorpera_company_sidebar_revisions as revision(profile_id) values (p_profile_id)
	on conflict (profile_id) do update set revision = revision.revision + 1, updated_at = clock_timestamp()
$$;

create function public.qorpera_sidebar_is_cofounder(p_profile_id uuid, p_staff_agent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_cofounders cofounder
			where cofounder.profile_id = p_profile_id and cofounder.staff_agent_id = p_staff_agent_id)
		or exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
				and staff.template_id = 'co-founder')
$$;

/** An agent the sidebar can place: active, not deleted, not the Co-Founder. */
create function public.qorpera_sidebar_placeable(p_profile_id uuid, p_staff_agent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active' and staff.deleted_at is null)
		and not public.qorpera_sidebar_is_cofounder(p_profile_id, p_staff_agent_id)
$$;

create function public.qorpera_sidebar_assert_agent(p_profile_id uuid, p_staff_agent_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if p_staff_agent_id is null then raise exception 'Name the agent to place' using errcode = '22023'; end if;
	if public.qorpera_sidebar_is_cofounder(p_profile_id, p_staff_agent_id) then
		raise exception 'The Co-Founder stays at the top of the sidebar' using errcode = '22023'; end if;
	if not public.qorpera_sidebar_placeable(p_profile_id, p_staff_agent_id) then
		raise exception 'That agent is not an active agent of this company' using errcode = 'P0002'; end if;
end $$;

create function public.qorpera_sidebar_section_name(p_name jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare v_name text;
begin
	if jsonb_typeof(p_name) is distinct from 'string' then
		raise exception 'A section needs a name' using errcode = '22023'; end if;
	v_name := pg_catalog.regexp_replace(pg_catalog.btrim(p_name #>> '{}'), '\s+', ' ', 'g');
	if pg_catalog.char_length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then
		raise exception 'A section name is 1 to 60 characters on one line' using errcode = '22023'; end if;
	return v_name;
end $$;

/** A section named by its id or, case-insensitively, by its name. */
create function public.qorpera_sidebar_section_ref(p_profile_id uuid, p_ref text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
	if p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		select id into v_id from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and id = p_ref::uuid;
	end if;
	if v_id is null then
		select id into v_id from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and lower(name) = lower(pg_catalog.btrim(coalesce(p_ref, '')));
	end if;
	if v_id is null then raise exception 'No section is called that' using errcode = 'P0002'; end if;
	return v_id;
end $$;

/** The agents a section (null: Unassigned) shows, in order. */
create function public.qorpera_sidebar_container(p_profile_id uuid, p_section_id uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
	select coalesce(array_agg(staff.staff_agent_id
		order by placement.position nulls last, staff.created_at, staff.staff_agent_id), '{}')
	from public.qorpera_profile_staff staff
	left join public.qorpera_company_sidebar_placements placement
		on placement.profile_id = staff.profile_id and placement.staff_agent_id = staff.staff_agent_id
	where staff.profile_id = p_profile_id and staff.employment_status = 'active' and staff.deleted_at is null
		and not public.qorpera_sidebar_is_cofounder(staff.profile_id, staff.staff_agent_id)
		and placement.section_id is not distinct from p_section_id
$$;

/** Writes a container's order as positions 0..n-1. Agents without a row get one. */
create function public.qorpera_sidebar_write_order(p_profile_id uuid, p_section_id uuid, p_order uuid[],
	p_user_id uuid, p_staff_agent_id uuid)
returns void language sql security definer set search_path = '' as $$
	insert into public.qorpera_company_sidebar_placements as placement(profile_id, staff_agent_id, section_id, position,
		updated_by_user_id, updated_by_staff_agent_id)
	select p_profile_id, item.staff_agent_id, p_section_id, (item.ordinality - 1)::integer, p_user_id, p_staff_agent_id
	from unnest(p_order) with ordinality as item(staff_agent_id, ordinality)
	on conflict (profile_id, staff_agent_id) do update set
		section_id = excluded.section_id, position = excluded.position, updated_at = clock_timestamp(),
		updated_by_user_id = excluded.updated_by_user_id, updated_by_staff_agent_id = excluded.updated_by_staff_agent_id
	-- A row that keeps its place is not written, so it keeps its last editor.
	where (placement.section_id, placement.position) is distinct from (excluded.section_id, excluded.position)
$$;

/** Moves an agent into a section (null: Unassigned). With p_order, the section's
 * agents take that order (unknown ids are skipped; agents it leaves out follow in
 * their current order); without it the agent goes last. Answers whether anything moved. */
create function public.qorpera_sidebar_place(p_profile_id uuid, p_staff_agent_id uuid, p_section_id uuid,
	p_order uuid[], p_user_id uuid, p_actor_staff_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_before uuid[]; v_members uuid[]; v_final uuid[]; v_current uuid; v_id uuid;
begin
	perform public.qorpera_sidebar_lock(p_profile_id);
	perform public.qorpera_sidebar_assert_agent(p_profile_id, p_staff_agent_id);
	if p_section_id is not null and not exists (select 1 from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and id = p_section_id) then
		raise exception 'No section is called that' using errcode = 'P0002'; end if;
	select section_id into v_current from public.qorpera_company_sidebar_placements
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	v_before := public.qorpera_sidebar_container(p_profile_id, p_section_id);
	v_members := array_remove(v_before, p_staff_agent_id);
	if p_order is null then
		if v_current is not distinct from p_section_id and p_staff_agent_id = any(v_before) then return false; end if;
		v_final := v_members || p_staff_agent_id;
	else
		if pg_catalog.cardinality(p_order) > 500 then raise exception 'Sidebar order is too long' using errcode = '22023'; end if;
		v_final := '{}';
		foreach v_id in array p_order loop
			if v_id is not null and (v_id = p_staff_agent_id or v_id = any(v_members)) and not v_id = any(v_final) then
				v_final := v_final || v_id;
			end if;
		end loop;
		if not p_staff_agent_id = any(v_final) then v_final := v_final || p_staff_agent_id; end if;
		foreach v_id in array v_members loop
			if not v_id = any(v_final) then v_final := v_final || v_id; end if;
		end loop;
		if v_final = v_before and exists (select 1 from public.qorpera_company_sidebar_placements
			where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id
				and section_id is not distinct from p_section_id) then return false; end if;
	end if;
	perform public.qorpera_sidebar_write_order(p_profile_id, p_section_id, v_final, p_user_id, p_actor_staff_id);
	perform public.qorpera_sidebar_touch(p_profile_id);
	return true;
end $$;

create function public.qorpera_sidebar_create_section(p_profile_id uuid, p_section_id uuid, p_name text,
	p_user_id uuid, p_actor_staff_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing public.qorpera_company_sidebar_sections%rowtype;
begin
	perform public.qorpera_sidebar_lock(p_profile_id);
	select * into v_existing from public.qorpera_company_sidebar_sections where id = p_section_id;
	if found then
		-- A retried create answers with the section it made.
		if v_existing.profile_id <> p_profile_id then
			raise exception 'That section id belongs to another company' using errcode = '22023'; end if;
		return v_existing.id;
	end if;
	if exists (select 1 from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and lower(name) = lower(p_name)) then
		raise exception 'A section called "%" already exists', p_name using errcode = '23505'; end if;
	if (select count(*) from public.qorpera_company_sidebar_sections where profile_id = p_profile_id) >= 40 then
		raise exception 'A company can have at most 40 sections' using errcode = '54000'; end if;
	insert into public.qorpera_company_sidebar_sections(id, profile_id, name, position,
		created_by_user_id, created_by_staff_agent_id)
	values (p_section_id, p_profile_id, p_name,
		coalesce((select max(position) + 1 from public.qorpera_company_sidebar_sections where profile_id = p_profile_id), 0),
		p_user_id, p_actor_staff_id);
	perform public.qorpera_sidebar_touch(p_profile_id);
	return p_section_id;
end $$;

create function public.qorpera_sidebar_rename_section(p_profile_id uuid, p_section_id uuid, p_name text,
	p_user_id uuid, p_actor_staff_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_sidebar_lock(p_profile_id);
	if exists (select 1 from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and id <> p_section_id and lower(name) = lower(p_name)) then
		raise exception 'A section called "%" already exists', p_name using errcode = '23505'; end if;
	update public.qorpera_company_sidebar_sections set name = p_name, updated_at = clock_timestamp(),
		updated_by_user_id = p_user_id, updated_by_staff_agent_id = p_actor_staff_id
	where profile_id = p_profile_id and id = p_section_id and name is distinct from p_name;
	if not found then return false; end if;
	perform public.qorpera_sidebar_touch(p_profile_id);
	return true;
end $$;

/** Deleting a section keeps its agents: they go to the end of Unassigned. */
create function public.qorpera_sidebar_delete_section(p_profile_id uuid, p_section_id uuid,
	p_user_id uuid, p_actor_staff_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_unassigned uuid[]; v_members uuid[];
begin
	perform public.qorpera_sidebar_lock(p_profile_id);
	if not exists (select 1 from public.qorpera_company_sidebar_sections
		where profile_id = p_profile_id and id = p_section_id) then return false; end if;
	v_unassigned := public.qorpera_sidebar_container(p_profile_id, null);
	v_members := public.qorpera_sidebar_container(p_profile_id, p_section_id);
	delete from public.qorpera_company_sidebar_sections where profile_id = p_profile_id and id = p_section_id;
	perform public.qorpera_sidebar_write_order(p_profile_id, null, v_unassigned || v_members, p_user_id, p_actor_staff_id);
	perform public.qorpera_sidebar_touch(p_profile_id);
	return true;
end $$;

/** What one member's rail is built from. */
create function public.qorpera_sidebar_state(p_profile_id uuid, p_user_id uuid)
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
		'pinned', coalesce((select jsonb_agg(mine.staff_agent_id order by mine.pinned_position, mine.updated_at)
			from public.qorpera_member_sidebar_agents mine
			where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.pinned_position is not null
				and public.qorpera_sidebar_placeable(p_profile_id, mine.staff_agent_id)), '[]'),
		'hidden', coalesce((select jsonb_agg(mine.staff_agent_id order by mine.staff_agent_id)
			from public.qorpera_member_sidebar_agents mine
			where mine.profile_id = p_profile_id and mine.user_id = p_user_id and mine.hidden
				and public.qorpera_sidebar_placeable(p_profile_id, mine.staff_agent_id)), '[]'))
$$;

create function public.qorpera_sidebar_member(p_profile_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company sidebar unavailable' using errcode = '42501'; end if;
	return auth.uid();
end $$;

create function public.qorpera_read_company_sidebar(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_sidebar_state(p_profile_id, public.qorpera_sidebar_member(p_profile_id));
end $$;

create function public.qorpera_sidebar_uuid(p_value jsonb, p_what text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
	if jsonb_typeof(p_value) is distinct from 'string'
		or p_value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception '% must be an id', p_what using errcode = '22023'; end if;
	return (p_value #>> '{}')::uuid;
end $$;

create function public.qorpera_sidebar_uuid_list(p_value jsonb, p_limit integer)
returns uuid[] language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_list uuid[] := '{}';
begin
	if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) > p_limit then
		raise exception 'The order must be a list of at most % agent ids', p_limit using errcode = '22023'; end if;
	for v_item in select value from jsonb_array_elements(p_value) loop
		v_list := v_list || public.qorpera_sidebar_uuid(v_item, 'Each agent in the order');
	end loop;
	return v_list;
end $$;

/** A member's sidebar changes. Sections and placement are the company's and need
 * owner, admin or contributor; pins and hidden agents are the member's own. Answers
 * the member's sidebar after the change. */
create function public.qorpera_manage_company_sidebar(p_profile_id uuid, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := public.qorpera_sidebar_member(p_profile_id);
	v_action text := p_request ->> 'action';
	v_agent uuid; v_section uuid; v_order uuid[]; v_id uuid; v_index integer := 0;
begin
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'action') is distinct from 'string'
		or p_request - array['action','sectionId','name','staffAgentId','order','unpin','hidden'] <> '{}'::jsonb then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	if v_action in ('create_section','rename_section','delete_section','move_agent')
		and not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Only owners, admins and contributors can change the company''s sections' using errcode = '42501'; end if;
	if v_action = 'create_section' then
		if p_request - array['action','sectionId','name','staffAgentId','unpin'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_create_section(p_profile_id,
			public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id'),
			public.qorpera_sidebar_section_name(p_request -> 'name'), v_user, null);
		if p_request ? 'staffAgentId' then
			v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
			perform public.qorpera_sidebar_place(p_profile_id, v_agent, v_section, null, v_user, null);
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
	elsif v_action = 'move_agent' then
		if p_request - array['action','sectionId','staffAgentId','order','unpin'] <> '{}'::jsonb
			or not p_request ? 'sectionId' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_agent := public.qorpera_sidebar_uuid(p_request -> 'staffAgentId', 'The agent');
		v_section := case when p_request -> 'sectionId' = 'null'::jsonb then null
			else public.qorpera_sidebar_uuid(p_request -> 'sectionId', 'The section id') end;
		if p_request ? 'order' then v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 500); end if;
		perform public.qorpera_sidebar_place(p_profile_id, v_agent, v_section, v_order, v_user, null);
	elsif v_action = 'set_pins' then
		if p_request - array['action','order'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_order := public.qorpera_sidebar_uuid_list(p_request -> 'order', 24);
		foreach v_id in array v_order loop
			perform public.qorpera_sidebar_assert_agent(p_profile_id, v_id);
		end loop;
		if (select count(distinct item) from unnest(v_order) item) <> pg_catalog.cardinality(v_order) then
			raise exception 'An agent is pinned once' using errcode = '22023'; end if;
		update public.qorpera_member_sidebar_agents set pinned_position = null, updated_at = clock_timestamp()
		where profile_id = p_profile_id and user_id = v_user and pinned_position is not null
			and not staff_agent_id = any(v_order);
		foreach v_id in array v_order loop
			-- Pinning shows a hidden agent again.
			insert into public.qorpera_member_sidebar_agents as mine(profile_id, user_id, staff_agent_id, pinned_position, hidden)
			values (p_profile_id, v_user, v_id, v_index, false)
			on conflict (profile_id, user_id, staff_agent_id) do update set
				pinned_position = excluded.pinned_position, hidden = false,
				updated_at = case when mine.pinned_position is distinct from excluded.pinned_position or mine.hidden
					then clock_timestamp() else mine.updated_at end;
			v_index := v_index + 1;
		end loop;
	elsif v_action = 'set_hidden' then
		if p_request - array['action','staffAgentId','hidden'] <> '{}'::jsonb
			or jsonb_typeof(p_request -> 'hidden') is distinct from 'boolean' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
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
	else
		raise exception 'Sidebar request is invalid' using errcode = '22023';
	end if;
	if v_action in ('create_section','move_agent') and coalesce((p_request ->> 'unpin')::boolean, false) and v_agent is not null then
		update public.qorpera_member_sidebar_agents set pinned_position = null, updated_at = clock_timestamp()
		where profile_id = p_profile_id and user_id = v_user and staff_agent_id = v_agent;
	end if;
	-- A row that neither pins nor hides says nothing.
	delete from public.qorpera_member_sidebar_agents
	where profile_id = p_profile_id and user_id = v_user and pinned_position is null and not hidden;
	return public.qorpera_sidebar_state(p_profile_id, v_user);
end $$;

/** The company's sections as an agent reads them: every section with its agents in
 * order, then the Unassigned agents. */
create function public.qorpera_sidebar_agent_view(p_profile_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'sections', coalesce((select jsonb_agg(jsonb_build_object('id', section.id, 'name', section.name,
				'agents', (select coalesce(jsonb_agg(jsonb_build_object('id', staff.staff_agent_id, 'name', staff.display_name)
						order by item.ordinality), '[]')
					from unnest(public.qorpera_sidebar_container(p_profile_id, section.id)) with ordinality item(id, ordinality)
					join public.qorpera_profile_staff staff on staff.profile_id = p_profile_id and staff.staff_agent_id = item.id))
				order by section.position, section.created_at, section.id)
			from public.qorpera_company_sidebar_sections section where section.profile_id = p_profile_id), '[]'),
		'unassigned', (select coalesce(jsonb_agg(jsonb_build_object('id', staff.staff_agent_id, 'name', staff.display_name)
				order by item.ordinality), '[]')
			from unnest(public.qorpera_sidebar_container(p_profile_id, null)) with ordinality item(id, ordinality)
			join public.qorpera_profile_staff staff on staff.profile_id = p_profile_id and staff.staff_agent_id = item.id))
$$;

/** The agent tool organize_sidebar: any active agent of the company, in any of its
 * conversations, may list, create, rename and delete sections and move itself or a
 * coworker between them. No member approval; the change is attributed to the agent.
 * Every action is idempotent by content, so a retried call changes nothing twice. */
create function public.qorpera_manage_agent_sidebar(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_action text; v_section uuid; v_agent uuid;
	v_changed boolean := false; v_name text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent can organize the sidebar' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'action') is distinct from 'string'
		or p_request - array['action','section','name','agentId'] <> '{}'::jsonb then
		raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	v_action := p_request ->> 'action';
	if v_action = 'list' then
		if p_request - array['action'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
	elsif v_action = 'create_section' then
		if p_request - array['action','name'] <> '{}'::jsonb then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_name := public.qorpera_sidebar_section_name(p_request -> 'name');
		-- Creating a section that already exists is the same section, not an error.
		perform public.qorpera_sidebar_lock(v_run.profile_id);
		select id into v_section from public.qorpera_company_sidebar_sections
		where profile_id = v_run.profile_id and lower(name) = lower(v_name);
		if v_section is null then
			perform public.qorpera_sidebar_create_section(v_run.profile_id, pg_catalog.gen_random_uuid(), v_name,
				null, v_run.staff_agent_id);
			v_changed := true;
		end if;
	elsif v_action = 'rename_section' then
		if p_request - array['action','section','name'] <> '{}'::jsonb
			or jsonb_typeof(p_request -> 'section') is distinct from 'string' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_section := public.qorpera_sidebar_section_ref(v_run.profile_id, p_request ->> 'section');
		v_changed := public.qorpera_sidebar_rename_section(v_run.profile_id, v_section,
			public.qorpera_sidebar_section_name(p_request -> 'name'), null, v_run.staff_agent_id);
	elsif v_action = 'delete_section' then
		if p_request - array['action','section'] <> '{}'::jsonb
			or jsonb_typeof(p_request -> 'section') is distinct from 'string' then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		begin
			v_section := public.qorpera_sidebar_section_ref(v_run.profile_id, p_request ->> 'section');
		exception when no_data_found then v_section := null;
		end;
		if v_section is not null then
			v_changed := public.qorpera_sidebar_delete_section(v_run.profile_id, v_section, null, v_run.staff_agent_id);
		end if;
	elsif v_action = 'move_agent' then
		if p_request - array['action','section','agentId'] <> '{}'::jsonb or not p_request ? 'section'
			or jsonb_typeof(p_request -> 'section') not in ('string','null') then
			raise exception 'Sidebar request is invalid' using errcode = '22023'; end if;
		v_agent := public.qorpera_sidebar_uuid(p_request -> 'agentId', 'agentId');
		if p_request -> 'section' <> 'null'::jsonb then
			v_section := public.qorpera_sidebar_section_ref(v_run.profile_id, p_request ->> 'section');
		end if;
		v_changed := public.qorpera_sidebar_place(v_run.profile_id, v_agent, v_section, null, null, v_run.staff_agent_id);
	else
		raise exception 'Sidebar request is invalid' using errcode = '22023';
	end if;
	return jsonb_build_object('schema', 'qorpera.agent-sidebar/v1', 'runId', v_run.id, 'action', v_action,
		'changed', v_changed) || public.qorpera_sidebar_agent_view(v_run.profile_id);
end $$;

revoke all on function public.qorpera_sidebar_lock(uuid),
	public.qorpera_sidebar_touch(uuid),
	public.qorpera_sidebar_is_cofounder(uuid, uuid),
	public.qorpera_sidebar_placeable(uuid, uuid),
	public.qorpera_sidebar_assert_agent(uuid, uuid),
	public.qorpera_sidebar_section_name(jsonb),
	public.qorpera_sidebar_section_ref(uuid, text),
	public.qorpera_sidebar_container(uuid, uuid),
	public.qorpera_sidebar_write_order(uuid, uuid, uuid[], uuid, uuid),
	public.qorpera_sidebar_place(uuid, uuid, uuid, uuid[], uuid, uuid),
	public.qorpera_sidebar_create_section(uuid, uuid, text, uuid, uuid),
	public.qorpera_sidebar_rename_section(uuid, uuid, text, uuid, uuid),
	public.qorpera_sidebar_delete_section(uuid, uuid, uuid, uuid),
	public.qorpera_sidebar_state(uuid, uuid),
	public.qorpera_sidebar_member(uuid),
	public.qorpera_sidebar_uuid(jsonb, text),
	public.qorpera_sidebar_uuid_list(jsonb, integer),
	public.qorpera_sidebar_agent_view(uuid),
	public.qorpera_read_company_sidebar(uuid),
	public.qorpera_manage_company_sidebar(uuid, jsonb),
	public.qorpera_manage_agent_sidebar(jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_read_company_sidebar(uuid), public.qorpera_manage_company_sidebar(uuid, jsonb)
	to authenticated;
grant execute on function public.qorpera_manage_agent_sidebar(jsonb, jsonb) to service_role;


-- Runtime observation vocabulary: the agent tool organize_sidebar is observed under its own
-- name. Re-states master's latest definition (20260924000000) with the name added; ACL
-- restated because CREATE OR REPLACE keeps it. Record this migration BEFORE activating the
-- bundle that carries the tool, or its observations are rejected (22023) and dropped.
create or replace function public.qorpera_record_runtime_observation(p_run_id uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_keys text[] := array['schema','attemptId','parentAttemptId','assignmentId','phase','operation',
		'logicalOperationSha256','observedAt','durationMs','status','errorCategory','receiptId','readId',
		'inputBytes','outputBytes','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens',
		'reasoningOutputTokens','totalTokens'];
	v_key text; v_number numeric; v_observed timestamptz;
	v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_runtime_observations%rowtype;
	v_other public.qorpera_runtime_observations%rowtype;
	v_replayed boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_run_id is null or jsonb_typeof(p_observation) is distinct from 'object'
		or octet_length(p_observation::text) > 8192 or not (p_observation ?& v_keys)
		or p_observation - v_keys <> '{}'::jsonb
		or p_observation ->> 'schema' is distinct from 'qorpera.runtime-observation/v1'
		or jsonb_typeof(p_observation -> 'attemptId') is distinct from 'string'
		or p_observation ->> 'attemptId' !~* v_uuid_pattern then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['parentAttemptId','assignmentId','receiptId','readId'] loop
		if p_observation -> v_key <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> v_key) <> 'string' or p_observation ->> v_key !~* v_uuid_pattern) then
			raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	end loop;
	if p_observation ->> 'operation' not in ('model_turn','model_request','company_read','company_list',
		'company_write','company_mkdir','company_delete','send_message','ask_member','read_context','send_coworker_message',
		'computer_start','computer_screen','computer_browser','computer_desktop','computer_shell','computer_screenshot',
		'computer_transfer','hire_agent','create_group_chat','manage_routine','report_work','manage_todo','manage_worker',
		'coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask',
		'update_memory','recall_memory','organize_sidebar',
		'company_context','message_composition','connector','unknown_tool','run_authority','context_authority',
		'native_result_fence','diagnostic_export')
		or jsonb_typeof(p_observation -> 'operation') <> 'string'
		or (p_observation -> 'logicalOperationSha256' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'logicalOperationSha256') <> 'string'
			or p_observation ->> 'logicalOperationSha256' !~ '^[0-9a-f]{64}$'))
		or (p_observation -> 'errorCategory' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'errorCategory') <> 'string' or p_observation ->> 'errorCategory' not in (
			'invalid_arguments','unavailable_tool','call_id_reused','budget_exhausted','authority_unavailable',
			'stale_version','protected_path','ambiguous_effect','cancelled','timeout','provider_failed',
			'transport_unavailable','invalid_response','unknown','export_unavailable')))
		or not coalesce((p_observation ->> 'phase' = 'start' and p_observation ->> 'status' = 'started'
			and p_observation -> 'durationMs' = 'null'::jsonb and p_observation -> 'errorCategory' = 'null'::jsonb)
			or (p_observation ->> 'phase' = 'finish' and p_observation ->> 'status' in
			('succeeded','failed','cancelled','denied','unconfirmed','proposed','replayed')),false) then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['durationMs','inputBytes','outputBytes','inputTokens','outputTokens',
		'cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] loop
		if p_observation -> v_key = 'null'::jsonb then continue; end if;
		if jsonb_typeof(p_observation -> v_key) <> 'number' then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
		v_number := (p_observation ->> v_key)::numeric;
		if v_number < 0 or v_number > 9007199254740991 or v_number <> trunc(v_number) then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
	end loop;
	-- Exactly the emitter's finite UTC-millisecond representation, not PostgreSQL
	-- special dates, local timezone guesses, calendar normalization, or year zero.
	if jsonb_typeof(p_observation -> 'observedAt') <> 'string'
		or p_observation ->> 'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
		or p_observation ->> 'observedAt' like '0000-%' then
		raise exception 'Runtime observation time is invalid' using errcode = '22023'; end if;
	begin
		v_observed := (p_observation ->> 'observedAt')::timestamptz;
		if not isfinite(v_observed) or to_char(v_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			<> p_observation ->> 'observedAt' then raise invalid_datetime_format; end if;
	exception when datetime_field_overflow or invalid_datetime_format then
		raise exception 'Runtime observation time is invalid' using errcode = '22023';
	end;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if not found then raise exception 'Runtime observation run is unavailable' using errcode = '42501'; end if;
	if (p_observation ->> 'assignmentId' is not null and not exists (
		select 1 from public.qorpera_runner_assignments a where a.id = (p_observation ->> 'assignmentId')::uuid
			and a.run_id = p_run_id and a.job_id = v_run.job_id))
		or (p_observation ->> 'receiptId' is not null and not exists (
			select 1 from public.qorpera_run_operation_receipts r where r.id = (p_observation ->> 'receiptId')::uuid
				and r.run_id = p_run_id and r.job_id = v_run.job_id))
		or (p_observation ->> 'readId' is not null and not exists (
			select 1 from public.qorpera_company_read_observations r where r.id = (p_observation ->> 'readId')::uuid
				and r.run_id = p_run_id and r.environment_id = v_run.environment_id)) then
		raise exception 'Runtime observation reference is unavailable' using errcode = '42501'; end if;
	-- Only the new diagnostic identity is locked; telemetry does not lock a
	-- job, lease, file, or live authorization. A finish may arrive before start.
	perform pg_advisory_xact_lock(hashtextextended('runtime-observation:' || p_run_id::text || ':' ||
		(p_observation ->> 'attemptId')::uuid::text,19970));
	select * into v_existing from public.qorpera_runtime_observations
	where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid and phase = p_observation ->> 'phase';
	if found then
		if v_existing.observation <> p_observation then
			raise exception 'Runtime observation identity already records different metadata' using errcode = '23505'; end if;
		v_replayed := true;
	else
		select * into v_other from public.qorpera_runtime_observations
		where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid;
		if found and (v_other.observation -> 'operation',v_other.observation -> 'assignmentId',
			v_other.observation -> 'parentAttemptId',v_other.observation -> 'logicalOperationSha256') is distinct from
			(p_observation -> 'operation',p_observation -> 'assignmentId',p_observation -> 'parentAttemptId',
			p_observation -> 'logicalOperationSha256') then
			raise exception 'Runtime observation attempt metadata changed' using errcode = '23505'; end if;
		insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
			operation,logical_operation_sha256,observed_at,observation)
		values (p_run_id,(p_observation ->> 'attemptId')::uuid,p_observation ->> 'phase',
			(p_observation ->> 'assignmentId')::uuid,(p_observation ->> 'parentAttemptId')::uuid,
			p_observation ->> 'operation',p_observation ->> 'logicalOperationSha256',v_observed,p_observation)
		returning * into v_existing;
	end if;
	return jsonb_build_object('schema','qorpera.runtime-observation-receipt/v1','runId',p_run_id,
		'attemptId',v_existing.attempt_id,'phase',v_existing.phase,'ingestedAt',v_existing.ingested_at,'replayed',v_replayed);
end
$$;
revoke all on function public.qorpera_record_runtime_observation(uuid,jsonb)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_record_runtime_observation(uuid,jsonb) to service_role;

commit;
