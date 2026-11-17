do $$ begin
	if to_regclass('public.qorpera_pending_spectators') is not null then
		raise exception '20260930794000 is already applied'; end if;
	if to_regprocedure('public.qorpera_invite_profile_member(uuid,text,public.qorpera_profile_role)') is null then
		raise exception '20260930794000 needs qorpera_invite_profile_member'; end if;
end $$;

set local lock_timeout = '3s';

create table public.qorpera_pending_spectators (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 320
		and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	added_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, email)
);
alter table public.qorpera_pending_spectators enable row level security;
revoke all on public.qorpera_pending_spectators from public, anon, authenticated, service_role;

create function public.qorpera_list_pending_spectators(p_profile_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
	select coalesce(array_agg(pending.email order by pending.created_at, pending.email), '{}')
	from public.qorpera_pending_spectators as pending
	where pending.profile_id = p_profile_id
		and coalesce(public.qorpera_member_role(p_profile_id)::text, '') in ('owner', 'admin')
$$;

create function public.qorpera_add_pending_spectators(p_profile_id uuid, p_emails text[])
returns text[] language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated'
		or coalesce(public.qorpera_member_role(p_profile_id)::text, '') not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501'; end if;
	if (select count(*) from (select pending.email from public.qorpera_pending_spectators as pending
			where pending.profile_id = p_profile_id
			union select coalesce(lower(btrim(email)), '') from unnest(p_emails) as email) as wanted) > 50 then
		raise exception 'a company keeps at most 50 spectators to invite' using errcode = '54000'; end if;
	insert into public.qorpera_pending_spectators(profile_id, email, added_by_user_id)
	select p_profile_id, coalesce(lower(btrim(email)), ''), auth.uid() from unnest(p_emails) as email
	on conflict (profile_id, email) do nothing;
	return public.qorpera_list_pending_spectators(p_profile_id);
end $$;

create function public.qorpera_invite_pending_spectators(p_profile_id uuid)
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_email text; v_invited text[] := '{}';
begin
	if auth.role() is distinct from 'authenticated'
		or coalesce(public.qorpera_member_role(p_profile_id)::text, '') not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_foundings as founding
			where founding.profile_id = p_profile_id and founding.phase = 'open') then
		return v_invited; end if;
	for v_email in select pending.email from public.qorpera_pending_spectators as pending
			where pending.profile_id = p_profile_id order by pending.created_at, pending.email
			for update skip locked loop
		begin
			perform public.qorpera_invite_profile_member(p_profile_id, v_email, 'viewer');
			v_invited := v_invited || v_email;
		exception when unique_violation then
			null;
		end;
		delete from public.qorpera_pending_spectators where profile_id = p_profile_id and email = v_email;
	end loop;
	return v_invited;
end $$;

revoke all on function public.qorpera_list_pending_spectators(uuid),
	public.qorpera_add_pending_spectators(uuid, text[]),
	public.qorpera_invite_pending_spectators(uuid)
	from public, anon, service_role;
grant execute on function public.qorpera_list_pending_spectators(uuid),
	public.qorpera_add_pending_spectators(uuid, text[]),
	public.qorpera_invite_pending_spectators(uuid)
	to authenticated;
