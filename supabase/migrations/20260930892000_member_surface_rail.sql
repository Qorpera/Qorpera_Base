set local lock_timeout = '3s';

create table public.qorpera_member_surface_rails (
	profile_id uuid not null,
	user_id uuid not null,
	layout jsonb not null,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id),
	constraint qorpera_member_surface_rails_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);
alter table public.qorpera_member_surface_rails enable row level security;
revoke all on public.qorpera_member_surface_rails from public, anon, authenticated, service_role;
comment on table public.qorpera_member_surface_rails is
	'Each member''s own order and sections of the rail''s interfaces (20260930892000). Written only through '
	'qorpera_set_member_surface_rail.';

create function public.qorpera_member_surface_rail_valid(p_layout jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_ids text[] := '{}'; v_sections text[] := '{}'; v_section jsonb; v_item jsonb;
begin
	if jsonb_typeof(p_layout) is distinct from 'object'
		or p_layout ->> 'schema' is distinct from 'qorpera.member-surface-rail/v1'
		or p_layout - array['schema','order','sections'] <> '{}'::jsonb
		or jsonb_typeof(p_layout -> 'order') is distinct from 'array'
		or jsonb_typeof(p_layout -> 'sections') is distinct from 'array'
		or pg_catalog.octet_length(p_layout::text) > 65536
		or jsonb_array_length(p_layout -> 'order') > 500
		or jsonb_array_length(p_layout -> 'sections') > 50 then
		return false; end if;
	for v_item in select value from jsonb_array_elements(p_layout -> 'order') loop
		if jsonb_typeof(v_item) is distinct from 'string'
			or v_item #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			return false; end if;
		v_ids := v_ids || (v_item #>> '{}');
	end loop;
	for v_section in select value from jsonb_array_elements(p_layout -> 'sections') loop
		if jsonb_typeof(v_section) is distinct from 'object'
			or v_section - array['id','name','surfaces'] <> '{}'::jsonb
			or jsonb_typeof(v_section -> 'id') is distinct from 'string'
			or v_section ->> 'id' !~ '^[a-z0-9-]{1,40}$'
			or jsonb_typeof(v_section -> 'name') is distinct from 'string'
			or char_length(v_section ->> 'name') not between 1 and 40
			or v_section ->> 'name' <> btrim(v_section ->> 'name')
			or v_section ->> 'name' ~ '[[:cntrl:]]'
			or jsonb_typeof(v_section -> 'surfaces') is distinct from 'array'
			or jsonb_array_length(v_section -> 'surfaces') > 500 then
			return false; end if;
		v_sections := v_sections || (v_section ->> 'id');
		for v_item in select value from jsonb_array_elements(v_section -> 'surfaces') loop
			if jsonb_typeof(v_item) is distinct from 'string'
				or v_item #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
				return false; end if;
			v_ids := v_ids || (v_item #>> '{}');
		end loop;
	end loop;
	return cardinality(v_ids) <= 500
		and cardinality(v_ids) = (select count(distinct id) from unnest(v_ids) id)
		and cardinality(v_sections) = (select count(distinct id) from unnest(v_sections) id);
end $$;

create function public.qorpera_member_surface_rail(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := public.qorpera_sidebar_member(p_profile_id); v_layout jsonb; v_at timestamptz;
begin
	select rail.layout, rail.updated_at into v_layout, v_at
	from public.qorpera_member_surface_rails rail
	where rail.profile_id = p_profile_id and rail.user_id = v_user;
	return jsonb_build_object('schema', 'qorpera.member-surface-rail-read/v1',
		'layout', coalesce(v_layout, '{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[]}'::jsonb),
		'updatedAt', v_at);
end $$;

create function public.qorpera_set_member_surface_rail(p_profile_id uuid, p_layout jsonb, p_expected timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := public.qorpera_sidebar_member(p_profile_id); v_at timestamptz;
begin
	if public.qorpera_member_surface_rail_valid(p_layout) is not true then
		raise exception 'The interfaces layout is invalid' using errcode = '22023'; end if;
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'qorpera.member-sidebar:' || p_profile_id::text || ':' || v_user::text, 0));
	select rail.updated_at into v_at from public.qorpera_member_surface_rails rail
	where rail.profile_id = p_profile_id and rail.user_id = v_user;
	if v_at is distinct from p_expected then
		raise exception 'Your interfaces changed in another tab; read them again' using errcode = 'QSR01'; end if;
	if p_layout -> 'order' = '[]'::jsonb and p_layout -> 'sections' = '[]'::jsonb then
		delete from public.qorpera_member_surface_rails where profile_id = p_profile_id and user_id = v_user;
	else
		insert into public.qorpera_member_surface_rails as rail (profile_id, user_id, layout)
		values (p_profile_id, v_user, p_layout)
		on conflict (profile_id, user_id) do update set layout = excluded.layout, updated_at = clock_timestamp();
	end if;
	perform public.qorpera_sidebar_touch(p_profile_id);
	return public.qorpera_member_surface_rail(p_profile_id);
end $$;

create function pg_temp.surface_rail_replace(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930892000' in v_definition) > 0 and position('20260930892000' in p_new) > 0 then
		raise exception '20260930892000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% is not the text 20260930892000 expects at: %', p_function, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.surface_rail_replace('public.qorpera_sidebar_own_summary(uuid,uuid)'::regprocedure,
	$old$	select jsonb_build_object(
		'changes', moved.n + sections.n + marks.pinned + marks.hidden + contacts.n + pages.n + apps.n,
		'moved', moved.ids, 'sections', sections.list, 'pinned', marks.pinned, 'hidden', marks.hidden,
		'contacts', contacts.n, 'pages', pages.n, 'apps', apps.n)
	from moved, sections, marks, contacts, pages, apps$old$,
	$new$	, surfaces as (
		-- 20260930892000: the member's order of interfaces as one change, and each section of theirs as one.
		select coalesce((select 1 + jsonb_array_length(rail.layout -> 'sections')
			from public.qorpera_member_surface_rails rail
			where rail.profile_id = p_profile_id and rail.user_id = p_user_id), 0) as n
	)
	select jsonb_build_object(
		'changes', moved.n + sections.n + marks.pinned + marks.hidden + contacts.n + pages.n + apps.n + surfaces.n,
		'moved', moved.ids, 'sections', sections.list, 'pinned', marks.pinned, 'hidden', marks.hidden,
		'contacts', contacts.n, 'pages', pages.n, 'apps', apps.n, 'surfaces', surfaces.n)
	from moved, sections, marks, contacts, pages, apps, surfaces$new$);

select pg_temp.surface_rail_replace('public.qorpera_sidebar_own_reset(uuid,uuid)'::regprocedure,
	$old$	), apps as (
		-- 20260930728000$old$,
	$new$	), surfaces as (
		-- 20260930892000
		delete from public.qorpera_member_surface_rails rail
		where rail.profile_id = p_profile_id and rail.user_id = p_user_id returning rail.*
	), apps as (
		-- 20260930728000$new$);
select pg_temp.surface_rail_replace('public.qorpera_sidebar_own_reset(uuid,uuid)'::regprocedure,
	$old$		'apps', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from apps row_), '[]'))$old$,
	$new$		'apps', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from apps row_), '[]'),
		'surfaces', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from surfaces row_), '[]'))$new$);

select pg_temp.surface_rail_replace('public.qorpera_sidebar_own_undo_reset(uuid,uuid)'::regprocedure,
	$old$	from jsonb_populate_recordset(null::public.qorpera_member_app_layouts, coalesce(v_removed -> 'apps', '[]')) gone
	on conflict do nothing;$old$,
	$new$	from jsonb_populate_recordset(null::public.qorpera_member_app_layouts, coalesce(v_removed -> 'apps', '[]')) gone
	on conflict do nothing;
	-- 20260930892000: the interfaces layout, unless the member made a new one since.
	insert into public.qorpera_member_surface_rails (profile_id, user_id, layout, updated_at)
	select p_profile_id, p_user_id, gone.layout, gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_surface_rails, coalesce(v_removed -> 'surfaces', '[]')) gone
	on conflict do nothing;$new$);

drop function pg_temp.surface_rail_replace(regprocedure, text, text);

revoke all on function public.qorpera_member_surface_rail_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_surface_rail(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_set_member_surface_rail(uuid, jsonb, timestamptz)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_surface_rail(uuid) to authenticated;
grant execute on function public.qorpera_set_member_surface_rail(uuid, jsonb, timestamptz) to authenticated;

comment on function public.qorpera_member_surface_rail(uuid) is
	'The caller''s own order and sections of the rail''s interfaces in a company (20260930892000), or an empty one.';
comment on function public.qorpera_set_member_surface_rail(uuid, jsonb, timestamptz) is
	'Writes the caller''s own order and sections of the rail''s interfaces whole (20260930892000); QSR01 when it changed '
	'since `expected`.';
