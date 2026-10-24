-- The Bank page: a third page a company may show beside Mailbox and Members (supabase/CLIENT-CONTRACT.md "Pages";
-- packages/web/src/app/bank-page.ts). Like the other two it is off until an owner or admin switches it on, and the web
-- draws it from what it ships, never from the folder's interfaces/. Switching it changes no data.
--
-- 1. qorpera_interface_pages takes `bank` as a page.
-- 2. The pages answer lists Mailbox, Members and Bank, in the Interfaces tab's order.
-- 3. The switch takes `bank`.
--
-- Locks: as 20260930509000. The constraint swap holds the table's ACCESS EXCLUSIVE lock for the migration only.

set local lock_timeout = '3s';

alter table public.qorpera_interface_pages drop constraint qorpera_interface_pages_page_check;
alter table public.qorpera_interface_pages
	add constraint qorpera_interface_pages_page_check check (page in ('mailbox', 'members', 'bank'));

create or replace function public.qorpera_interface_pages_json(p_environment_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930520000 (Bank page)
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1',
		'pages', (select jsonb_agg(jsonb_build_object('page', listed.page, 'on', coalesce(kept.enabled, false))
				order by listed.place)
			from unnest(array['mailbox', 'members', 'bank']) with ordinality as listed(page, place)
			left join public.qorpera_interface_pages as kept
				on kept.environment_id = p_environment_id and kept.page = listed.page),
		'mayChange', exists (select 1 from public.qorpera_company_files as file
			join public.qorpera_profile_members as member on member.profile_id = file.profile_id
			where file.environment_id = p_environment_id and member.user_id = p_user
				and member.role::text in ('owner', 'admin')))
$$;
revoke all on function public.qorpera_interface_pages_json(uuid, uuid) from public, anon, authenticated, service_role;

-- Switches a page on or off. Only an owner or admin may (42501), only Mailbox, Members or Bank (22023), and not while
-- the company is being deleted (55000). Switching a page to what it is already changes nothing.
create or replace function public.qorpera_set_interface_page(p_environment_id uuid, p_page text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (public.qorpera_member_folder_actor(p_environment_id) ->> 'userId')::uuid; v_profile uuid;
begin
	-- 20260930520000 (Bank page)
	if p_page is null or p_page not in ('mailbox', 'members', 'bank') or p_on is null then
		raise exception 'Only the Mailbox, Members and Bank pages can be switched on or off' using errcode = '22023'; end if;
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

revoke all on function public.qorpera_set_interface_page(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.qorpera_set_interface_page(uuid, text, boolean) to authenticated;
