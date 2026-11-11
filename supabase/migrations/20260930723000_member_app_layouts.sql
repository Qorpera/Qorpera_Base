-- Each member's own arrangement of the apps drawer, over the company's (Jonas, 11 November 2026).
--
-- Jonas: "the same way we have categories and groups for agents, we should have so for the interfaces as well. they
-- should be a collapsed group of interfaces you can expand ... the agents should be able to organize the interfaces for
-- you natively". The company's groups are its file apps/groups.md, which its agents keep (organize_apps); a member who
-- moves an app, makes, renames or ungroups a group changes only their own drawer, as with the sidebar
-- (20260930722000): what they touched is theirs, the rest follows the company's file.
--
-- 1. qorpera_member_app_layouts: one document per member and company, `qorpera.member-app-layout/v1`:
--    `places` (an app's or a group's place: its group or none, and what it stands after, or first) and `groups` (a
--    company group renamed or removed by the member, or one of the member's own). The web arranges the drawer from the
--    file and this document; the database keeps the document whole and checks its shape and size.
-- 2. qorpera_member_app_layout(company) reads it; qorpera_set_member_app_layout(company, layout, expected) writes it
--    whole, refusing (40001) when the member's other tab wrote since `expected`. Any member, viewers too.
-- 3. Reset sidebar takes the document away with the rest, Undo puts it back, and `own` counts it as `apps`.

set local lock_timeout = '3s';

create table public.qorpera_member_app_layouts (
	profile_id uuid not null,
	user_id uuid not null,
	layout jsonb not null,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id),
	constraint qorpera_member_app_layouts_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);
alter table public.qorpera_member_app_layouts enable row level security;
revoke all on public.qorpera_member_app_layouts from public, anon, authenticated, service_role;
comment on table public.qorpera_member_app_layouts is
	'Each member''s own arrangement of the apps drawer over the company''s apps/groups.md (20260930723000). Written '
	'only through qorpera_set_member_app_layout.';

/** Whether a layout document has the shape the web writes: a key is a drawer key or `group:<id>`, a group id 1-40 of
 * a-z, 0-9 and hyphens, a name 1-40 characters on one line. */
create function public.qorpera_member_app_layout_valid(p_layout jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_layout) = 'object'
		and p_layout ->> 'schema' = 'qorpera.member-app-layout/v1'
		and p_layout - array['schema','places','groups'] = '{}'::jsonb
		and jsonb_typeof(p_layout -> 'places') = 'object' and jsonb_typeof(p_layout -> 'groups') = 'object'
		and pg_catalog.octet_length(p_layout::text) <= 65536
		and (select count(*) from jsonb_object_keys(p_layout -> 'places')) <= 500
		and (select count(*) from jsonb_object_keys(p_layout -> 'groups')) <= 200
		and not exists (
			select 1 from jsonb_each(p_layout -> 'places') place(key, value)
			where place.key !~ '^(page:(mailbox|members|bank)|app:[a-z0-9][a-z0-9-]{0,62}|concepts|sites|group:[a-z0-9][a-z0-9-]{0,39})$'
				or jsonb_typeof(place.value) <> 'object'
				or place.value - array['group','after','first'] <> '{}'::jsonb
				or coalesce(jsonb_typeof(place.value -> 'group'), 'null') not in ('null', 'string')
				or (jsonb_typeof(place.value -> 'group') = 'string' and place.value ->> 'group' !~ '^[a-z0-9][a-z0-9-]{0,39}$')
				or coalesce(jsonb_typeof(place.value -> 'after'), 'null') not in ('null', 'string')
				or (jsonb_typeof(place.value -> 'after') = 'string' and char_length(place.value ->> 'after') > 70)
				or coalesce(jsonb_typeof(place.value -> 'first'), 'boolean') <> 'boolean')
		and not exists (
			select 1 from jsonb_each(p_layout -> 'groups') grouped(id, value)
			where grouped.id !~ '^[a-z0-9][a-z0-9-]{0,39}$'
				or jsonb_typeof(grouped.value) <> 'object'
				or grouped.value - array['name','removed','mine'] <> '{}'::jsonb
				or (grouped.value ? 'name' and (jsonb_typeof(grouped.value -> 'name') <> 'string'
					or char_length(grouped.value ->> 'name') not between 1 and 40 or grouped.value ->> 'name' ~ '[[:cntrl:]]'))
				or (grouped.value ? 'removed' and grouped.value -> 'removed' <> 'true'::jsonb)
				or (grouped.value ? 'mine' and (jsonb_typeof(grouped.value -> 'mine') <> 'object'
					or (grouped.value -> 'mine') - array['name'] <> '{}'::jsonb
					or jsonb_typeof(grouped.value #> '{mine,name}') <> 'string'
					or char_length(grouped.value #>> '{mine,name}') not between 1 and 40
					or grouped.value #>> '{mine,name}' ~ '[[:cntrl:]]')))
$$;

create function public.qorpera_member_app_layout(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := public.qorpera_sidebar_member(p_profile_id); v_layout jsonb; v_at timestamptz;
begin
	select layout.layout, layout.updated_at into v_layout, v_at
	from public.qorpera_member_app_layouts layout
	where layout.profile_id = p_profile_id and layout.user_id = v_user;
	return jsonb_build_object('schema', 'qorpera.member-app-layout-read/v1',
		'layout', coalesce(v_layout, '{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{}}'::jsonb),
		'updatedAt', v_at);
end $$;

create function public.qorpera_set_member_app_layout(p_profile_id uuid, p_layout jsonb, p_expected timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := public.qorpera_sidebar_member(p_profile_id); v_at timestamptz;
begin
	if not public.qorpera_member_app_layout_valid(p_layout) then
		raise exception 'The apps layout is invalid' using errcode = '22023'; end if;
	-- One change to a member's own sidebar at a time (20260930722000), Reset's included.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'qorpera.member-sidebar:' || p_profile_id::text || ':' || v_user::text, 0));
	select layout.updated_at into v_at from public.qorpera_member_app_layouts layout
	where layout.profile_id = p_profile_id and layout.user_id = v_user;
	if v_at is distinct from p_expected then
		raise exception 'Your apps changed in another tab; read them again' using errcode = '40001'; end if;
	if p_layout -> 'places' = '{}'::jsonb and p_layout -> 'groups' = '{}'::jsonb then
		-- Nothing of the member's own is left: the company's arrangement holds.
		delete from public.qorpera_member_app_layouts where profile_id = p_profile_id and user_id = v_user;
	else
		insert into public.qorpera_member_app_layouts as layout (profile_id, user_id, layout)
		values (p_profile_id, v_user, p_layout)
		on conflict (profile_id, user_id) do update set layout = excluded.layout, updated_at = clock_timestamp();
	end if;
	-- The member's other tabs and devices read their sidebar again, and with it the count Reset shows.
	perform public.qorpera_sidebar_touch(p_profile_id);
	return public.qorpera_member_app_layout(p_profile_id);
end $$;

-- Reset sidebar's count, its snapshot and its Undo take the member's apps layout in.
create function pg_temp.app_layouts_replace(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% is not the text 20260930723000 expects at: %', p_function, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.app_layouts_replace('public.qorpera_sidebar_own_summary(uuid,uuid)'::regprocedure,
	$old$	)
	select jsonb_build_object(
		'changes', moved.n + sections.n + marks.pinned + marks.hidden + contacts.n + pages.n,
		'moved', moved.ids, 'sections', sections.list, 'pinned', marks.pinned, 'hidden', marks.hidden,
		'contacts', contacts.n, 'pages', pages.n)
	from moved, sections, marks, contacts, pages$old$,
	$new$	), apps as (
		-- 20260930723000: each app or group the member placed, and each group they renamed, removed or made.
		select coalesce((select (select count(*) from jsonb_object_keys(layout.layout -> 'places'))
				+ (select count(*) from jsonb_object_keys(layout.layout -> 'groups'))
			from public.qorpera_member_app_layouts layout
			where layout.profile_id = p_profile_id and layout.user_id = p_user_id), 0) as n
	)
	select jsonb_build_object(
		'changes', moved.n + sections.n + marks.pinned + marks.hidden + contacts.n + pages.n + apps.n,
		'moved', moved.ids, 'sections', sections.list, 'pinned', marks.pinned, 'hidden', marks.hidden,
		'contacts', contacts.n, 'pages', pages.n, 'apps', apps.n)
	from moved, sections, marks, contacts, pages, apps$new$);

select pg_temp.app_layouts_replace('public.qorpera_sidebar_own_reset(uuid,uuid)'::regprocedure,
	$old$	), pages as (
		delete from public.qorpera_member_hidden_interface_pages mine$old$,
	$new$	), apps as (
		-- 20260930723000
		delete from public.qorpera_member_app_layouts layout
		where layout.profile_id = p_profile_id and layout.user_id = p_user_id returning layout.*
	), pages as (
		delete from public.qorpera_member_hidden_interface_pages mine$new$);
select pg_temp.app_layouts_replace('public.qorpera_sidebar_own_reset(uuid,uuid)'::regprocedure,
	$old$		'pages', coalesce((select jsonb_agg(to_jsonb(row_) - 'user_id') from pages row_), '[]'))$old$,
	$new$		'pages', coalesce((select jsonb_agg(to_jsonb(row_) - 'user_id') from pages row_), '[]'),
		'apps', coalesce((select jsonb_agg(to_jsonb(row_) - 'profile_id' - 'user_id') from apps row_), '[]'))$new$);

select pg_temp.app_layouts_replace('public.qorpera_sidebar_own_undo_reset(uuid,uuid)'::regprocedure,
	$old$		where file.environment_id = gone.environment_id and file.profile_id = p_profile_id)
	on conflict do nothing;$old$,
	$new$		where file.environment_id = gone.environment_id and file.profile_id = p_profile_id)
	on conflict do nothing;
	-- 20260930723000: the apps layout, unless the member made a new one since.
	insert into public.qorpera_member_app_layouts (profile_id, user_id, layout, updated_at)
	select p_profile_id, p_user_id, gone.layout, gone.updated_at
	from jsonb_populate_recordset(null::public.qorpera_member_app_layouts, coalesce(v_removed -> 'apps', '[]')) gone
	on conflict do nothing;$new$);

revoke all on function public.qorpera_member_app_layout_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_app_layout(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_set_member_app_layout(uuid, jsonb, timestamptz)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_app_layout(uuid) to authenticated;
grant execute on function public.qorpera_set_member_app_layout(uuid, jsonb, timestamptz) to authenticated;

comment on function public.qorpera_member_app_layout(uuid) is
	'The caller''s own arrangement of the apps drawer in a company (20260930723000), or an empty one.';
comment on function public.qorpera_set_member_app_layout(uuid, jsonb, timestamptz) is
	'Writes the caller''s own arrangement of the apps drawer whole (20260930723000); 40001 when it changed since `expected`.';
