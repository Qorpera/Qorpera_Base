-- The Friends search (20260928031000): an address finds a person only when an
-- account has confirmed it, the whole address and nothing less. A friend
-- request follows the same rule.
begin;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values
	('96220000-0000-4000-8000-00000000000a', 'lookup-owner@example.test', statement_timestamp(), '{"display_name":"Lookup Owner"}'),
	('96220000-0000-4000-8000-00000000000b', 'lookup-friend@example.test', statement_timestamp(), '{"display_name":"Lookup Friend"}'),
	-- The email sign-in creates this row for any address typed into it; nobody has confirmed it.
	('96220000-0000-4000-8000-00000000000c', 'lookup-typed@example.test', null, '{}');

select set_config('request.jwt.claims', '{"sub":"96220000-0000-4000-8000-00000000000a","email":"lookup-owner@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb; v_ok boolean := false;
begin
	if current_user <> 'authenticated' then
		raise exception 'lookup suite is not running as authenticated (got %)', current_user;
	end if;
	v := public.qorpera_find_account_by_email('lookup-friend@example.test');
	if v is distinct from jsonb_build_object(
		'user_id', '96220000-0000-4000-8000-00000000000b',
		'email', 'lookup-friend@example.test',
		'display_name', 'Lookup Friend',
		'self', false
	) then
		raise exception 'an account''s address did not find it: %', v;
	end if;
	if public.qorpera_find_account_by_email('  Lookup-FRIEND@Example.test ') ->> 'user_id'
		is distinct from '96220000-0000-4000-8000-00000000000b' then
		raise exception 'the address match is not case-insensitive and trimmed';
	end if;
	if public.qorpera_find_account_by_email('lookup-owner@example.test') ->> 'self' is distinct from 'true' then
		raise exception 'the caller''s own address is not marked as theirs';
	end if;
	-- Only the whole address finds someone: no prefixes, patterns or blanks.
	if public.qorpera_find_account_by_email('lookup-friend@example') is not null
		or public.qorpera_find_account_by_email('lookup-friend') is not null
		or public.qorpera_find_account_by_email('%@example.test') is not null
		or public.qorpera_find_account_by_email('lookup-_riend@example.test') is not null
		or public.qorpera_find_account_by_email('') is not null
		or public.qorpera_find_account_by_email(null) is not null then
		raise exception 'part of an address found an account';
	end if;
	if public.qorpera_find_account_by_email('nobody@example.test') is not null then
		raise exception 'an unknown address found an account';
	end if;
	if public.qorpera_find_account_by_email('lookup-typed@example.test') is not null then
		raise exception 'an unconfirmed address found an account';
	end if;
	-- A request cannot reach an address the search does not find.
	begin
		perform public.qorpera_send_friend_request('lookup-typed@example.test');
	exception when sqlstate 'P0002' then v_ok := true;
	end;
	if not v_ok then raise exception 'a friend request reached an unconfirmed address'; end if;
	if public.qorpera_send_friend_request('lookup-friend@example.test') ->> 'status' is distinct from 'pending' then
		raise exception 'a friend request to a found account did not go out';
	end if;
	begin
		perform public.qorpera_confirmed_account('lookup-friend@example.test');
		raise exception 'members can call the private address helper';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

-- Confirming the address makes it an account.
update auth.users set email_confirmed_at = statement_timestamp()
where id = '96220000-0000-4000-8000-00000000000c';
set local role authenticated;
do $$
begin
	if public.qorpera_find_account_by_email('lookup-typed@example.test') ->> 'user_id'
		is distinct from '96220000-0000-4000-8000-00000000000c' then
		raise exception 'a confirmed address did not find its account';
	end if;
end
$$;
reset role;

-- A token without an account, and anonymous callers, find nobody.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
do $$
begin
	perform public.qorpera_find_account_by_email('lookup-friend@example.test');
	raise exception 'a caller without an account can look up addresses';
exception when insufficient_privilege then null;
end
$$;
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
	perform public.qorpera_find_account_by_email('lookup-friend@example.test');
	raise exception 'anonymous callers can look up addresses';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
