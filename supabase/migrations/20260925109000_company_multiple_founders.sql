-- Human co-founders share company ownership. The creator is retained provenance;
-- Computer Usage owner is an explicit responsibility, never a model sponsor or
-- an authorization to purchase a plan or incur overages.
alter table public.qorpera_profiles
	drop constraint qorpera_profiles_created_by_user_id_fkey,
	add constraint qorpera_profiles_created_by_user_id_fkey
		foreign key (created_by_user_id) references auth.users(id) on delete restrict,
	add column computer_usage_owner_user_id uuid references auth.users(id) on delete restrict;
update public.qorpera_profiles profile set computer_usage_owner_user_id = coalesce(
	(select member.user_id from public.qorpera_profile_members member
		where member.profile_id = profile.id and member.role = 'owner'),profile.created_by_user_id);
alter table public.qorpera_profiles alter column computer_usage_owner_user_id set not null;

create function public.qorpera_initialize_computer_usage_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	new.computer_usage_owner_user_id := new.created_by_user_id;
	return new;
end
$$;
revoke all on function public.qorpera_initialize_computer_usage_owner() from public, anon, authenticated, service_role;
create trigger qorpera_profiles_initialize_computer_usage_owner before insert on public.qorpera_profiles
for each row execute function public.qorpera_initialize_computer_usage_owner();

drop index public.qorpera_profile_one_owner;

-- Default company grants need one current human attribution, not a unique owner.
create or replace function public.qorpera_company_owner_user_id(p_profile_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select member.user_id from public.qorpera_profile_members member
	join public.qorpera_profiles profile on profile.id = member.profile_id
	where member.profile_id = p_profile_id and member.role = 'owner'
	order by (member.user_id = profile.created_by_user_id) desc, member.joined_at, member.user_id limit 1
$$;

create or replace function public.qorpera_profile_entitlement_json(p_profile_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select public.qorpera_account_entitlement_json((select profile.computer_usage_owner_user_id
		from public.qorpera_profiles profile where profile.id = p_profile_id))
$$;

-- Keep exact current bootstrap behavior, changing only provenance selection.
do $$ declare v text; v_old text; v_function regprocedure; begin
	v := pg_get_functiondef('public.qorpera_enqueue_company_bootstrap(uuid,boolean)'::regprocedure);
	v_old := 'select user_id into strict v_owner from public.qorpera_profile_members where profile_id = p_profile_id and role = ''owner'';';
	if (length(v) - length(replace(v,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Company bootstrap creator selection differs'; end if;
	execute replace(v,v_old,'select created_by_user_id into strict v_owner from public.qorpera_profiles where id = p_profile_id;');
	v := pg_get_functiondef('public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text)'::regprocedure);
	v_old := E'join public.qorpera_profile_members as member on member.profile_id = file.profile_id\n\t\twhere member.user_id = p_user_id and member.role = ''owner''';
	if (length(v) - length(replace(v,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Company entitlement owner selection differs'; end if;
	v := replace(v,v_old,E'join public.qorpera_profiles as profile on profile.id = file.profile_id\n\t\twhere profile.computer_usage_owner_user_id = p_user_id');
	v_old := 'if p_storage_allocation = ''metered'' and exists (';
	if (length(v) - length(replace(v,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Account entitlement allocation guard differs'; end if;
	execute replace(v,v_old,E'perform 1 from auth.users where id = p_user_id for update;\n\t' || v_old);
	foreach v_function in array array[
		'public.qorpera_ensure_runtime_office_default_access(uuid,uuid)'::regprocedure,
		'public.qorpera_ensure_runtime_company_browser(uuid,uuid)'::regprocedure
	] loop
		v := pg_get_functiondef(v_function);
		v_old := E'select member.user_id into v_owner from public.qorpera_profile_members member\n\t\twhere member.profile_id = v_office.profile_id and member.role = ''owner''\n\t\torder by member.joined_at, member.user_id limit 1;';
		if (length(v) - length(replace(v,v_old,''))) / length(v_old) <> 1 then
			raise exception 'Company default attribution differs: %', v_function; end if;
		execute replace(v,v_old,'v_owner := public.qorpera_company_owner_user_id(v_office.profile_id);');
	end loop;
	-- Preserve their owner-role bans while matching departure's lock order.
	foreach v_function in array array[
		'public.qorpera_remove_profile_member(uuid,uuid)'::regprocedure,
		'public.qorpera_update_profile_member_role(uuid,uuid,public.qorpera_profile_role)'::regprocedure
	] loop
		v := pg_get_functiondef(v_function);
		v_old := 'v_actor_role := public.qorpera_member_role(p_profile_id);';
		if (length(v) - length(replace(v,v_old,''))) / length(v_old) <> 1 then
			raise exception 'Company member management entry differs: %', v_function; end if;
		execute replace(v,v_old,E'perform 1 from public.qorpera_profiles where id = p_profile_id for update;\n\t' || v_old);
	end loop;
end $$;

create or replace function public.qorpera_agent_threads_on_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid := coalesce(new.profile_id, old.profile_id); v_environment uuid; v_room record;
begin
	v_environment := public.qorpera_profile_environment(v_profile);
	if v_environment is null then return coalesce(new, old); end if;
	for v_room in select room.bound_staff_agent_id from public.qorpera_company_rooms room
		where room.profile_id = v_profile and room.bound_staff_agent_id is not null loop
		perform public.qorpera_ensure_agent_thread_internal(v_profile,v_environment,v_room.bound_staff_agent_id,
			coalesce(new.user_id,public.qorpera_company_owner_user_id(v_profile)));
	end loop;
	return coalesce(new, old);
end
$$;

-- Last-owner and responsibility invariants also protect service/auth cascades.
-- The parent row serializes concurrent founder departures. Profile deletion
-- itself is allowed to cascade once the parent has gone.
create function public.qorpera_guard_founder_departure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile public.qorpera_profiles%rowtype;
begin
	if tg_op = 'UPDATE' and new.role = old.role then return new; end if;
	select * into v_profile from public.qorpera_profiles where id = old.profile_id for update;
	if not found then return coalesce(new,old); end if;
	if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
		if v_profile.computer_usage_owner_user_id = old.user_id then
			raise exception 'Reassign Computer Usage owner before leaving' using errcode = '42501'; end if;
		if not exists(select 1 from public.qorpera_profile_members where profile_id = old.profile_id
			and user_id <> old.user_id and role = 'owner') then
			raise exception 'The last company owner cannot leave' using errcode = '42501'; end if;
	end if;
	if tg_op = 'DELETE' and v_profile.created_by_user_id = old.user_id and exists (
		select 1 from public.qorpera_company_bootstrap_jobs where profile_id = old.profile_id and state <> 'completed') then
		raise exception 'Company setup must complete before its creator leaves' using errcode = '42501'; end if;
	return coalesce(new,old);
end
$$;
revoke all on function public.qorpera_guard_founder_departure() from public, anon, authenticated, service_role;
create trigger qorpera_profile_members_guard_founder_departure before delete or update of role
on public.qorpera_profile_members for each row execute function public.qorpera_guard_founder_departure();

create or replace function public.qorpera_leave_hosted_profile(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	delete from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid();
	if not found then raise exception 'profile member was not found' using errcode = 'P0002'; end if;
	return 'true'::jsonb;
end
$$;

create or replace function public.qorpera_delete_hosted_profile(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	if not exists(select 1 from public.qorpera_profile_members where profile_id = p_profile_id
		and user_id = auth.uid() and role = 'owner') then
		raise exception 'deleting a profile requires an owner' using errcode = '42501'; end if;
	if exists(select 1 from public.qorpera_profile_members where profile_id = p_profile_id
		and user_id <> auth.uid() and role = 'owner') then
		raise exception 'Shared company deletion requires co-founder consent; unilateral deletion is unavailable'
			using errcode = '42501'; end if;
	delete from public.qorpera_profiles where id = p_profile_id;
	return 'true'::jsonb;
end
$$;

-- A co-founder may explicitly take responsibility for usage. They cannot put
-- another member in this role. No payment, purchase, or model authority changes.
create function public.qorpera_accept_computer_usage_ownership(p_profile_id uuid,p_expected_owner_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile public.qorpera_profiles%rowtype;
begin
	select * into v_profile from public.qorpera_profiles where id = p_profile_id for update;
	if not found or auth.uid() is null or not exists(select 1 from public.qorpera_profile_members
		where profile_id = p_profile_id and user_id = auth.uid() and role = 'owner') then
		raise exception 'Computer Usage owner must be a current co-founder' using errcode = '42501'; end if;
	if v_profile.computer_usage_owner_user_id is distinct from p_expected_owner_user_id then
		raise exception 'Computer Usage owner changed; refresh before accepting' using errcode = '40001'; end if;
	perform 1 from auth.users where id = auth.uid() for share;
	if public.qorpera_account_entitlement_json(auth.uid()) ->> 'storage_allocation' <> 'unlimited'
		and exists(select 1 from public.qorpera_company_files where profile_id = p_profile_id
			and storage_used_bytes > storage_limit_bytes) then
		raise exception 'Company storage exceeds the new owner allocation' using errcode = '23514'; end if;
	update public.qorpera_profiles set computer_usage_owner_user_id = auth.uid() where id = p_profile_id;
	return jsonb_build_object('profile_id',p_profile_id,'computer_usage_owner_user_id',auth.uid());
end
$$;
revoke all on function public.qorpera_accept_computer_usage_ownership(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_accept_computer_usage_ownership(uuid,uuid) to authenticated;
