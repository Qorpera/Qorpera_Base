-- Supabase Auth owns the metadata write. Exercise its database effect as the
-- service, then verify names through the real authenticated read surfaces.
begin;

insert into auth.users (id, email, raw_user_meta_data)
values
	('96210000-0000-4000-8000-00000000000a', 'name-owner@example.test', '{"name":"Provider Name","full_name":"Original Name"}'),
	('96210000-0000-4000-8000-00000000000b', 'name-friend@example.test', '{"name":"Friend Provider"}');
update auth.users set email_confirmed_at = now()
where id = '96210000-0000-4000-8000-00000000000a';

select set_config('request.jwt.claims', '{"sub":"96210000-0000-4000-8000-00000000000a","email":"name-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Old JWT Name"}}', true);
set local role authenticated;
select set_config('qorpera_test.name_profile_a', public.qorpera_begin_company_founding('96210000-0000-4000-8000-00000000001a', 'Name A', 2) ->> 'profile_id', true);
select set_config('qorpera_test.name_profile_b', public.qorpera_begin_company_founding('96210000-0000-4000-8000-00000000001b', 'Name B', 2) ->> 'profile_id', true);
select public.qorpera_send_friend_request('name-friend@example.test');
reset role;

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.name_profile_a')::uuid,
	'96210000-0000-4000-8000-00000000000b', 'name-friend@example.test', 'Friend Provider', 'contributor');

do $$
begin
	if (select count(*) from public.qorpera_profile_members
		where user_id = '96210000-0000-4000-8000-00000000000a' and display_name = 'Original Name') <> 2 then
		raise exception 'membership creation preferred stale JWT metadata over the account name';
	end if;
end
$$;

select set_config('qorpera_test.name_access_version', (
	select version::text from public.qorpera_profile_access_state
	where profile_id = current_setting('qorpera_test.name_profile_a')::uuid
		and user_id = '96210000-0000-4000-8000-00000000000a'
), true);

update auth.users set raw_user_meta_data = raw_user_meta_data || '{"display_name":"Chosen Username"}'::jsonb
where id = '96210000-0000-4000-8000-00000000000a';

do $$
begin
	if (select count(*) from public.qorpera_profile_members
		where user_id = '96210000-0000-4000-8000-00000000000a' and display_name = 'Chosen Username') <> 2 then
		raise exception 'renaming an account did not update every existing membership';
	end if;
	if not exists (select 1 from public.qorpera_profile_access_state
		where profile_id = current_setting('qorpera_test.name_profile_a')::uuid
			and user_id = '96210000-0000-4000-8000-00000000000a'
			and status = 'active' and role = 'owner'
			and version = current_setting('qorpera_test.name_access_version')::bigint + 1) then
		raise exception 'rename did not emit a member refresh hint while preserving access';
	end if;
	if (select raw_user_meta_data ->> 'name' from auth.users
		where id = '96210000-0000-4000-8000-00000000000a') <> 'Provider Name' then
		raise exception 'rename changed unrelated provider metadata';
	end if;
end
$$;

-- An unchanged display name and unrelated metadata write must not emit hints.
update auth.users set raw_user_meta_data = raw_user_meta_data || '{"picture":"provider-picture"}'::jsonb
where id = '96210000-0000-4000-8000-00000000000a';

do $$
begin
	if (select version from public.qorpera_profile_access_state
		where profile_id = current_setting('qorpera_test.name_profile_a')::uuid
			and user_id = '96210000-0000-4000-8000-00000000000a')
		<> current_setting('qorpera_test.name_access_version')::bigint + 1 then
		raise exception 'unrelated metadata invalidated the member list';
	end if;
end
$$;

-- A third company created with the same old JWT still gets the saved name.
set local role authenticated;
select set_config('qorpera_test.name_profile_c', public.qorpera_begin_company_founding('96210000-0000-4000-8000-00000000001c', 'Name C', 2) ->> 'profile_id', true);
do $$
declare
	v_team jsonb := public.qorpera_profile_team_info(current_setting('qorpera_test.name_profile_c')::uuid);
begin
	if v_team -> 'members' -> 0 ->> 'display_name' is distinct from 'Chosen Username' then
		raise exception 'team RPC did not return the saved username: %', v_team;
	end if;
	if public.qorpera_list_friends() -> 0 ->> 'display_name' is distinct from 'Friend Provider' then
		raise exception 'a friend without an edited name lost their provider name';
	end if;
	begin
		update auth.users set raw_user_meta_data = '{"full_name":"Impersonated"}'
		where id = '96210000-0000-4000-8000-00000000000b';
		raise exception 'authenticated member directly updated another account';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"96210000-0000-4000-8000-00000000000b","email":"name-friend@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;
do $$
declare v_friend jsonb := public.qorpera_list_friends() -> 0;
begin
	if v_friend ->> 'display_name' is distinct from 'Chosen Username'
		or v_friend ->> 'email' is distinct from 'name-owner@example.test' then
		raise exception 'friends did not prioritize the edited username while preserving email: %', v_friend;
	end if;
	if not exists (select 1 from public.qorpera_profile_access_state
		where profile_id = current_setting('qorpera_test.name_profile_a')::uuid
			and user_id = '96210000-0000-4000-8000-00000000000a'
			and version = current_setting('qorpera_test.name_access_version')::bigint + 1) then
		raise exception 'another company member cannot see the name-change invalidation';
	end if;
end
$$;
reset role;

-- OAuth can refresh provider names without replacing an explicitly chosen name.
update auth.users set raw_user_meta_data = raw_user_meta_data ||
	jsonb_build_object('full_name', repeat('n', 100), 'name', 'Refreshed Provider Name')
where id = '96210000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_profile_members
		where user_id = '96210000-0000-4000-8000-00000000000a' and display_name <> 'Chosen Username') then
		raise exception 'an OAuth refresh overwrote the explicitly chosen username';
	end if;
end
$$;
set local role authenticated;
do $$
begin
	if public.qorpera_list_friends() -> 0 ->> 'display_name' is distinct from 'Chosen Username' then
		raise exception 'friends preferred a refreshed provider name over the chosen username';
	end if;
end
$$;
reset role;

-- Clearing the explicit name restores the provider name, including names
-- longer than the inline editor limit. Empty or malformed names use Member.
update auth.users set raw_user_meta_data = raw_user_meta_data - 'display_name'
where id = '96210000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_profile_members
		where user_id = '96210000-0000-4000-8000-00000000000a' and display_name <> repeat('n', 100)) then
		raise exception 'a provider name exceeding the editor limit did not propagate';
	end if;
end
$$;
update auth.users set raw_user_meta_data = '{"full_name":null,"name":" ","user_name":42}'
where id = '96210000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_profile_members
		where user_id = '96210000-0000-4000-8000-00000000000a' and display_name <> 'Member') then
		raise exception 'a nameless account did not fall back to Member';
	end if;
end
$$;
set local role authenticated;
do $$
begin
	if public.qorpera_list_friends() -> 0 ->> 'display_name' is distinct from 'Member' then
		raise exception 'a nameless friend did not fall back to Member';
	end if;
end
$$;
reset role;

set local role anon;
do $$
begin
	perform public.qorpera_list_friends();
	raise exception 'anonymous callers can read friends';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
