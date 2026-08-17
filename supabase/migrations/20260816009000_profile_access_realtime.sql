-- Durable, bounded access state for online role changes and revocation.
--
-- A membership DELETE cannot itself be the revocation signal: after deletion,
-- the removed account no longer passes the membership table's RLS policy.
-- This one-row-per-account projection remains readable by its subject and lets
-- Realtime tell every connected checkout to fail closed before refreshing.

create table if not exists public.qorpera_profile_access_state (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	status text not null check (status in ('active', 'revoked')),
	role public.qorpera_profile_role,
	version bigint not null default 1 check (version > 0),
	updated_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, user_id),
	check ((status = 'active' and role is not null) or (status = 'revoked' and role is null))
);

alter table public.qorpera_profile_access_state enable row level security;

create policy qorpera_profile_access_state_subject_or_member_read
	on public.qorpera_profile_access_state
	for select
	to authenticated
	using (user_id = auth.uid() or public.qorpera_can_read_profile(profile_id));

revoke all on public.qorpera_profile_access_state from anon, authenticated;
grant select on public.qorpera_profile_access_state to authenticated;

create function public.qorpera_project_profile_access_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_user_id uuid;
	v_status text;
	v_role public.qorpera_profile_role;
begin
	if tg_op = 'DELETE' then
		v_profile_id := old.profile_id;
		v_user_id := old.user_id;
		v_status := 'revoked';
		v_role := null;
	else
		v_profile_id := new.profile_id;
		v_user_id := new.user_id;
		v_status := 'active';
		v_role := new.role;
	end if;
	insert into public.qorpera_profile_access_state (profile_id, user_id, status, role)
	values (v_profile_id, v_user_id, v_status, v_role)
	on conflict (profile_id, user_id) do update
	set status = excluded.status,
		role = excluded.role,
		version = public.qorpera_profile_access_state.version + 1,
		updated_at = statement_timestamp();
	if tg_op = 'DELETE' then
		return old;
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_project_profile_access_state() from public;

insert into public.qorpera_profile_access_state (profile_id, user_id, status, role)
select member.profile_id, member.user_id, 'active', member.role
from public.qorpera_profile_members as member
on conflict (profile_id, user_id) do update
set status = excluded.status,
	role = excluded.role,
	version = public.qorpera_profile_access_state.version + 1,
	updated_at = statement_timestamp();

create trigger qorpera_profile_members_project_access_state
	after insert or update of role or delete
	on public.qorpera_profile_members
	for each row
	execute function public.qorpera_project_profile_access_state();

do $$
begin
	if not exists (
		select 1
		from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_profile_access_state'
	) then
		alter publication supabase_realtime add table public.qorpera_profile_access_state;
	end if;
end
$$;
