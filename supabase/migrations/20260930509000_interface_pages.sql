-- Interfaces C6a: which pages a company shows (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §4,
-- deploy/first-node/RUNTIME-INTERFACES.md). Folder-v2 only.
--
-- 1. qorpera_interface_pages: whether each of the two pages a company may show, Mailbox and Members (an area's owner,
--    supervisor and agents), is on. A company has no row until an owner or admin first switches a page; no row is off.
--    Nothing else can be a page: the web draws only these two, from the definitions it ships, and never a definition
--    from the folder's interfaces/ (where `status` and `main` are only words in a file anyone with write access, an
--    agent included, could change).
-- 2. Two calls: any member lists the pages and whether they may switch them; an owner or admin switches one. Switching
--    changes no data: a page's tables, the areas' consents and offers, and who pays stay as they are, so a page turned
--    off and on again shows what it showed.
--
-- Locks: switching holds the caller's member row FOR SHARE (a role change or a leaving waits for it, or goes first), then
-- the page's row.

set local lock_timeout = '3s';

create table public.qorpera_interface_pages (
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	page text not null check (page in ('mailbox', 'members')),
	enabled boolean not null,
	changed_by_user_id uuid not null,
	changed_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, page)
);
alter table public.qorpera_interface_pages enable row level security;
revoke all on public.qorpera_interface_pages from public, anon, authenticated, service_role;

-- The pages as a member reads them: both, in the Interfaces tab's order, each on or off, and whether the caller may
-- switch them (an owner or admin).
create function public.qorpera_interface_pages_json(p_environment_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930509000 (C6a)
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1',
		'pages', (select jsonb_agg(jsonb_build_object('page', listed.page, 'on', coalesce(kept.enabled, false))
				order by listed.place)
			from unnest(array['mailbox', 'members']) with ordinality as listed(page, place)
			left join public.qorpera_interface_pages as kept
				on kept.environment_id = p_environment_id and kept.page = listed.page),
		'mayChange', exists (select 1 from public.qorpera_company_files as file
			join public.qorpera_profile_members as member on member.profile_id = file.profile_id
			where file.environment_id = p_environment_id and member.user_id = p_user
				and member.role::text in ('owner', 'admin')))
$$;
revoke all on function public.qorpera_interface_pages_json(uuid, uuid) from public, anon, authenticated, service_role;

create function public.qorpera_member_interface_pages(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
begin
	-- 20260930509000 (C6a)
	return public.qorpera_interface_pages_json(p_environment_id, (v_actor ->> 'userId')::uuid);
end $$;

-- Switches a page on or off. Only an owner or admin may (42501), only Mailbox or Members (22023), and not while the
-- company is being deleted (55000). Switching a page to what it is already changes nothing.
create function public.qorpera_set_interface_page(p_environment_id uuid, p_page text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (public.qorpera_member_folder_actor(p_environment_id) ->> 'userId')::uuid; v_profile uuid;
begin
	-- 20260930509000 (C6a)
	if p_page is null or p_page not in ('mailbox', 'members') or p_on is null then
		raise exception 'Only the Mailbox and Members pages can be switched on or off' using errcode = '22023'; end if;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = v_profile and member.user_id = v_user and member.role::text in ('owner', 'admin')
	for share;
	if not found then
		raise exception 'Only the company''s owners and admins can switch its pages' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_profile) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
	insert into public.qorpera_interface_pages as kept (environment_id, page, enabled, changed_by_user_id)
	values (p_environment_id, p_page, p_on, v_user)
	on conflict (environment_id, page) do update
		set enabled = excluded.enabled, changed_by_user_id = excluded.changed_by_user_id, changed_at = clock_timestamp()
		where kept.enabled is distinct from excluded.enabled;
	return public.qorpera_interface_pages_json(p_environment_id, v_user);
end $$;

revoke all on function public.qorpera_member_interface_pages(uuid) from public, anon, service_role;
revoke all on function public.qorpera_set_interface_page(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.qorpera_member_interface_pages(uuid) to authenticated;
grant execute on function public.qorpera_set_interface_page(uuid, text, boolean) to authenticated;
