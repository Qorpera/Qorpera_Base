-- Friends: a first-class social graph between accounts. Company invitations
-- stay email-keyed and unchanged server-side; the friends list is where the
-- hub picks people from, and friendship state is what both hubs can render.

create table public.qorpera_friendships (
	user_low uuid not null references auth.users(id) on delete cascade,
	user_high uuid not null references auth.users(id) on delete cascade,
	requested_by uuid not null references auth.users(id) on delete cascade,
	status text not null default 'pending' check (status in ('pending', 'accepted')),
	created_at timestamptz not null default statement_timestamp(),
	responded_at timestamptz,
	primary key (user_low, user_high),
	check (user_low < user_high),
	check (requested_by in (user_low, user_high))
);

alter table public.qorpera_friendships enable row level security;
revoke all on public.qorpera_friendships from anon, authenticated;

create function public.qorpera_friend_pair(p_a uuid, p_b uuid)
returns table (user_low uuid, user_high uuid)
language sql
immutable
security definer
set search_path = ''
as $$
	select least(p_a, p_b), greatest(p_a, p_b)
$$;

revoke all on function public.qorpera_friend_pair(uuid, uuid) from public, anon, authenticated;

create function public.qorpera_send_friend_request(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_target uuid;
	v_low uuid;
	v_high uuid;
	v_existing public.qorpera_friendships%rowtype;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select id into v_target from auth.users
	where lower(email) = lower(btrim(coalesce(p_email, ''))) limit 1;
	if v_target is null then
		raise exception 'no account with that email' using errcode = 'P0002';
	end if;
	if v_target = v_actor then
		raise exception 'befriending yourself is automatic' using errcode = '22023';
	end if;
	select * into v_low, v_high from public.qorpera_friend_pair(v_actor, v_target);
	select * into v_existing from public.qorpera_friendships
	where user_low = v_low and user_high = v_high for update;
	if found then
		if v_existing.status = 'accepted' then
			return jsonb_build_object('status', 'accepted');
		end if;
		if v_existing.requested_by = v_actor then
			return jsonb_build_object('status', 'pending');
		end if;
		-- They already asked us: sending back is accepting.
		update public.qorpera_friendships
		set status = 'accepted', responded_at = statement_timestamp()
		where user_low = v_low and user_high = v_high;
		return jsonb_build_object('status', 'accepted');
	end if;
	insert into public.qorpera_friendships (user_low, user_high, requested_by)
	values (v_low, v_high, v_actor);
	return jsonb_build_object('status', 'pending');
end
$$;

create function public.qorpera_list_friends()
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
		'display_name', coalesce(
			friend.raw_user_meta_data ->> 'name',
			friend.raw_user_meta_data ->> 'full_name',
			split_part(friend.email, '@', 1)
		),
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

create function public.qorpera_respond_friend_request(p_user_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_low uuid;
	v_high uuid;
	v_existing public.qorpera_friendships%rowtype;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select * into v_low, v_high from public.qorpera_friend_pair(v_actor, p_user_id);
	select * into v_existing from public.qorpera_friendships
	where user_low = v_low and user_high = v_high and status = 'pending' for update;
	if not found then
		raise exception 'no pending request from that account' using errcode = 'P0002';
	end if;
	if v_existing.requested_by = v_actor then
		raise exception 'the other side answers this request' using errcode = '42501';
	end if;
	if p_accept then
		update public.qorpera_friendships
		set status = 'accepted', responded_at = statement_timestamp()
		where user_low = v_low and user_high = v_high;
		return jsonb_build_object('status', 'accepted');
	end if;
	delete from public.qorpera_friendships where user_low = v_low and user_high = v_high;
	return jsonb_build_object('status', 'declined');
end
$$;

create function public.qorpera_remove_friend(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_low uuid;
	v_high uuid;
	v_removed integer;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select * into v_low, v_high from public.qorpera_friend_pair(v_actor, p_user_id);
	delete from public.qorpera_friendships where user_low = v_low and user_high = v_high;
	get diagnostics v_removed = row_count;
	return jsonb_build_object('removed', v_removed);
end
$$;

revoke all on function public.qorpera_send_friend_request(text) from public, anon;
revoke all on function public.qorpera_list_friends() from public, anon;
revoke all on function public.qorpera_respond_friend_request(uuid, boolean) from public, anon;
revoke all on function public.qorpera_remove_friend(uuid) from public, anon;
grant execute on function public.qorpera_send_friend_request(text) to authenticated;
grant execute on function public.qorpera_list_friends() to authenticated;
grant execute on function public.qorpera_respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.qorpera_remove_friend(uuid) to authenticated;
