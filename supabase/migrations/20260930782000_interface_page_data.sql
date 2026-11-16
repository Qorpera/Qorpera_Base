do $$ begin
	if exists (select 1 from pg_catalog.pg_constraint
		where conname = 'qorpera_interface_pages_page_check'
			and pg_catalog.pg_get_constraintdef(oid) like '%''data''%') then
		raise exception '20260930782000 is already applied'; end if;
	if to_regprocedure('public.qorpera_set_interface_page_hidden(uuid,text,boolean)') is null
		or to_regprocedure('public.qorpera_member_app_layout_valid(jsonb)') is null
		or not exists (select 1 from pg_catalog.pg_constraint
			where conrelid = 'public.qorpera_member_hidden_interface_pages'::regclass
				and conname = 'qorpera_member_hidden_interface_pages_page_check' and contype = 'c') then
		raise exception '20260930782000 needs the pages hidden per member (20260930697000) and the members'' own drawer (20260930728000)';
	end if;
end $$;

set local lock_timeout = '3s';

alter table public.qorpera_interface_pages drop constraint qorpera_interface_pages_page_check;
alter table public.qorpera_interface_pages
	add constraint qorpera_interface_pages_page_check check (page in ('mailbox', 'members', 'bank', 'data'));

alter table public.qorpera_member_hidden_interface_pages
	drop constraint qorpera_member_hidden_interface_pages_page_check;
alter table public.qorpera_member_hidden_interface_pages
	add constraint qorpera_member_hidden_interface_pages_page_check check (page in ('mailbox', 'members', 'bank', 'data'));

create or replace function public.qorpera_interface_pages_json(p_environment_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1',
		'pages', (select jsonb_agg(jsonb_build_object(
					'page', listed.page,
					'on', coalesce(kept.enabled, listed.page in ('mailbox', 'bank', 'data')),
					'hidden', exists (select 1 from public.qorpera_member_hidden_interface_pages as mine
						where mine.environment_id = p_environment_id and mine.user_id = p_user and mine.page = listed.page))
				order by listed.place)
			from unnest(array['mailbox', 'members', 'bank', 'data']) with ordinality as listed(page, place)
			left join public.qorpera_interface_pages as kept
				on kept.environment_id = p_environment_id and kept.page = listed.page),
		'mayChange', exists (select 1 from public.qorpera_company_files as file
			join public.qorpera_profile_members as member on member.profile_id = file.profile_id
			where file.environment_id = p_environment_id and member.user_id = p_user
				and member.role::text in ('owner', 'admin')))
$$;
revoke all on function public.qorpera_interface_pages_json(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.qorpera_set_interface_page(p_environment_id uuid, p_page text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (public.qorpera_member_folder_actor(p_environment_id) ->> 'userId')::uuid; v_profile uuid;
begin
	if p_page is null or p_page not in ('mailbox', 'members', 'bank', 'data') or p_on is null then
		raise exception 'Only the Mailbox, Members, Bank and Data pages can be switched on or off' using errcode = '22023'; end if;
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

create or replace function public.qorpera_set_interface_page_hidden(p_environment_id uuid, p_page text, p_hidden boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (public.qorpera_member_folder_actor(p_environment_id) ->> 'userId')::uuid; v_profile uuid;
begin
	if p_page is null or p_page not in ('mailbox', 'members', 'bank', 'data') or p_hidden is null then
		raise exception 'Only the Mailbox, Members, Bank and Data pages can be hidden or shown' using errcode = '22023'; end if;
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

do $$
declare
	v_definition text := pg_catalog.pg_get_functiondef('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure);
	v_old constant text := 'page:(mailbox|members|bank)|';
	v_found integer;
begin
	v_found := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
	if v_found <> 3 then
		raise exception '20260930782000 expects the members'' drawer keys 3 times in qorpera_member_app_layout_valid, found %', v_found;
	end if;
	execute replace(v_definition, v_old, 'page:(mailbox|members|bank|data)|');
end $$;
