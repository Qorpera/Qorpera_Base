-- Chosen account names live in Auth metadata's display_name, ahead of names
-- imported by OAuth. Existing memberships project it; friends read it directly.
create function public.qorpera_account_display_name(p_metadata jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
	select left(coalesce((
		select nullif(btrim(p_metadata ->> field.key), '')
		from unnest(array['display_name', 'full_name', 'name', 'user_name', 'preferred_username'])
			with ordinality as field(key, priority)
		where jsonb_typeof(p_metadata -> field.key) = 'string'
			and nullif(btrim(p_metadata ->> field.key), '') is not null
		order by field.priority limit 1
	), 'Member'), 256)
$$;

revoke all on function public.qorpera_account_display_name(jsonb) from public, anon, authenticated;

create function public.qorpera_sync_account_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_name text := public.qorpera_account_display_name(new.raw_user_meta_data);
begin
	-- OAuth providers also write these fields; do not reject Auth updates using
	-- the editor's narrower validation rules.
	update public.qorpera_profile_members
	set display_name = v_name
	where user_id = new.id and display_name is distinct from v_name;
	return new;
end
$$;

revoke all on function public.qorpera_sync_account_display_name() from public, anon, authenticated;

create trigger qorpera_account_display_name_changed
	after update of raw_user_meta_data on auth.users
	for each row
	when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
	execute function public.qorpera_sync_account_display_name();

-- Auth updates do not replace already issued JWTs. Read the saved name when
-- joining or creating a company so a stale token cannot restore an old name.
-- Provider names already present before this feature keep their existing limit.
create function public.qorpera_member_account_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_name text;
begin
	select public.qorpera_account_display_name(account.raw_user_meta_data) into v_name
	from auth.users as account where account.id = new.user_id;
	if v_name is not null then
		new.display_name := v_name;
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_member_account_display_name() from public, anon, authenticated;

create trigger qorpera_member_account_display_name
	before insert or update of display_name on public.qorpera_profile_members
	for each row execute function public.qorpera_member_account_display_name();

-- Company clients already refresh their member list on access-state hints.
-- A name change emits the same invalidation without changing anyone's access.
create function public.qorpera_member_display_name_hint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_profile_access_state
	set version = version + 1, updated_at = statement_timestamp()
	where profile_id = new.profile_id and user_id = new.user_id;
	return new;
end
$$;

revoke all on function public.qorpera_member_display_name_hint() from public, anon, authenticated;

create trigger qorpera_member_display_name_hint
	after update of display_name on public.qorpera_profile_members
	for each row when (old.display_name is distinct from new.display_name)
	execute function public.qorpera_member_display_name_hint();

update public.qorpera_profile_members as member
set display_name = public.qorpera_account_display_name(account.raw_user_meta_data)
from auth.users as account
where account.id = member.user_id
	and member.display_name is distinct from public.qorpera_account_display_name(account.raw_user_meta_data);

create or replace function public.qorpera_list_friends()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'user_id', friend.id,
		'email', friend.email,
		'display_name', left(public.qorpera_account_display_name(friend.raw_user_meta_data), 160),
		'status', f.status,
		'direction', case when f.requested_by = v_actor then 'outgoing' else 'incoming' end,
		'since', coalesce(f.responded_at, f.created_at)
	) order by f.status desc, coalesce(f.responded_at, f.created_at) desc), '[]'::jsonb)
	into v_result
	from public.qorpera_friendships f
	join auth.users friend on friend.id = case when f.user_low = v_actor then f.user_high else f.user_low end
	where v_actor in (f.user_low, f.user_high);
	return v_result;
end
$$;
