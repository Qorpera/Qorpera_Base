-- Friends search finds a person by email only when an account holds that
-- address. An address counts once its owner has confirmed it: the email
-- sign-in creates an unconfirmed Auth user for any address typed into it, and
-- company invitations already require a confirmed address. The match is the
-- whole address, case-insensitive, never a prefix, so the search cannot list
-- accounts. Sending a request has always told the caller whether an address
-- has an account; the lookup says so before they send, and both now use the
-- same rule. It also returns the account's display name, which the sender
-- saw on the Sent row once a request was out.

create function public.qorpera_confirmed_account(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select account.id
	from auth.users as account
	where lower(account.email) = lower(btrim(coalesce(p_email, '')))
		and account.email_confirmed_at is not null
	limit 1
$$;

revoke all on function public.qorpera_confirmed_account(text) from public, anon, authenticated;

create function public.qorpera_find_account_by_email(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_target uuid;
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	v_target := public.qorpera_confirmed_account(p_email);
	if v_target is null then
		return null;
	end if;
	select jsonb_build_object(
		'user_id', account.id,
		'email', account.email,
		'display_name', left(public.qorpera_account_display_name(account.raw_user_meta_data), 160),
		'self', account.id = v_actor
	) into v_result
	from auth.users as account
	where account.id = v_target;
	return v_result;
end
$$;

revoke all on function public.qorpera_find_account_by_email(text) from public, anon;
grant execute on function public.qorpera_find_account_by_email(text) to authenticated;

create or replace function public.qorpera_send_friend_request(p_email text)
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
	v_target := public.qorpera_confirmed_account(p_email);
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
