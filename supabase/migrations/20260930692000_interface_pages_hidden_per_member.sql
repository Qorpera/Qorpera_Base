-- Hiding a page is each member's own (Jonas, 9 Nov 2026: "hiding/unhiding interfaces should not be company wide, but
-- userbased"). A member hides Mailbox, Members or Bank from their own rail with a right-click, and shows it again from
-- the rail's Hidden fold, as they hide an agent; nobody else's rail changes (supabase/CLIENT-CONTRACT.md "Pages").
--
-- 1. qorpera_member_hidden_interface_pages: the pages a member hid in a company. No row: the page shows for them. A
--    member's rows go with the member's account and with the company's file.
-- 2. The pages answer gains `hidden` for each page: whether the caller hid it. `on`, the company's switch, stays in the
--    answer for clients from before this; a client that reads `hidden` draws a page unless the member hid it.
-- 3. qorpera_set_interface_page_hidden(environment, page, hidden): any member hides or shows a page for themselves.
--    Hiding changes no data, the company's switch included.
--
-- Locks: hiding holds the caller's member row FOR SHARE (a leaving or a deletion waits for it, or goes first), then
-- the member's row for the page.

set local lock_timeout = '3s';

create table public.qorpera_member_hidden_interface_pages (
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	page text not null check (page in ('mailbox', 'members', 'bank')),
	hidden_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, user_id, page)
);
alter table public.qorpera_member_hidden_interface_pages enable row level security;
revoke all on public.qorpera_member_hidden_interface_pages from public, anon, authenticated, service_role;

create or replace function public.qorpera_interface_pages_json(p_environment_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930692000 (hidden per member), 20260930583000 (Mailbox and Bank on by default), 20260930520000 (Bank page)
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1',
		'pages', (select jsonb_agg(jsonb_build_object(
					'page', listed.page,
					'on', coalesce(kept.enabled, listed.page in ('mailbox', 'bank')),
					'hidden', exists (select 1 from public.qorpera_member_hidden_interface_pages as mine
						where mine.environment_id = p_environment_id and mine.user_id = p_user and mine.page = listed.page))
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

-- Hides a page from the caller's own rail, or shows it again. Any member of the company may (42501 for anyone else),
-- only Mailbox, Members or Bank (22023), and not while the company is being deleted (55000). Hiding a page that is
-- hidden, or showing one that shows, changes nothing.
create function public.qorpera_set_interface_page_hidden(p_environment_id uuid, p_page text, p_hidden boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (public.qorpera_member_folder_actor(p_environment_id) ->> 'userId')::uuid; v_profile uuid;
begin
	-- 20260930692000 (hidden per member)
	if p_page is null or p_page not in ('mailbox', 'members', 'bank') or p_hidden is null then
		raise exception 'Only the Mailbox, Members and Bank pages can be hidden or shown' using errcode = '22023'; end if;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = v_profile and member.user_id = v_user
	for share;
	if not found then
		raise exception 'Only the company''s members can hide its pages' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_profile) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
	if p_hidden then
		insert into public.qorpera_member_hidden_interface_pages (environment_id, user_id, page)
		values (p_environment_id, v_user, p_page)
		on conflict (environment_id, user_id, page) do nothing;
	else
		delete from public.qorpera_member_hidden_interface_pages
		where environment_id = p_environment_id and user_id = v_user and page = p_page;
	end if;
	return public.qorpera_interface_pages_json(p_environment_id, v_user);
end $$;

revoke all on function public.qorpera_set_interface_page_hidden(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.qorpera_set_interface_page_hidden(uuid, text, boolean) to authenticated;
