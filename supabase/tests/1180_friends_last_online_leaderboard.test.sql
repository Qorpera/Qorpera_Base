-- Friends' last online time and the friends leaderboard (20260930690000), as the real client role, in one
-- transaction that is rolled back. A and B become friends; C is a stranger with a pending request to A.
-- A owns "Board shop" (two good will months: 500 kr and 250 kr without VAT); B is a member of it and owns
-- "Board cafe" (one month: 100 kr).
begin;

insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data)
values
	('11800000-0000-4000-8000-00000000000a', 'board-a@example.test', statement_timestamp(), null, '{"display_name":"Board A"}'),
	('11800000-0000-4000-8000-00000000000b', 'board-b@example.test', statement_timestamp(), null, '{"display_name":"Board B"}'),
	('11800000-0000-4000-8000-00000000000c', 'board-c@example.test', statement_timestamp(),
		statement_timestamp() - interval '2 days', '{"display_name":"Board C"}');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values
	('11800000-0000-4000-8000-000000000101', 'Board shop', '11800000-0000-4000-8000-00000000000a'),
	('11800000-0000-4000-8000-000000000102', 'Board cafe', '11800000-0000-4000-8000-00000000000b');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role, joined_at)
values
	('11800000-0000-4000-8000-000000000101', '11800000-0000-4000-8000-00000000000a', 'board-a@example.test', 'Board A', 'owner', statement_timestamp() - interval '3 days'),
	('11800000-0000-4000-8000-000000000101', '11800000-0000-4000-8000-00000000000b', 'board-b@example.test', 'Board B', 'contributor', statement_timestamp() - interval '2 days'),
	('11800000-0000-4000-8000-000000000102', '11800000-0000-4000-8000-00000000000b', 'board-b@example.test', 'Board B', 'owner', statement_timestamp() - interval '1 day');
insert into public.qorpera_good_will_months (profile_id, month, sales_ore, moms_ore, net_ore)
values
	('11800000-0000-4000-8000-000000000101', '2026-10-01', 62500, 12500, 50000),
	('11800000-0000-4000-8000-000000000101', '2026-11-01', 31250, 6250, 25000),
	('11800000-0000-4000-8000-000000000102', '2026-11-01', 12500, 2500, 10000);

-- A marks itself online and asks B.
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000a","email":"board-a@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb; v_first timestamptz; v_ok boolean := false;
begin
	if current_user <> 'authenticated' then
		raise exception 'board suite is not running as authenticated (got %)', current_user;
	end if;
	perform public.qorpera_send_friend_request('board-b@example.test');
	select public.qorpera_mark_online() into v;
	v_first := (v ->> 'last_seen_at')::timestamptz;
	if v_first is null or v_first < clock_timestamp() - interval '1 minute' then
		raise exception 'mark_online did not record now: %', v;
	end if;
	-- A second mark within 30 seconds keeps the first.
	select public.qorpera_mark_online() into v;
	if (v ->> 'last_seen_at')::timestamptz is distinct from v_first then
		raise exception 'a second mark within 30 seconds moved the time: % then %', v_first, v;
	end if;
	-- Members never read the table themselves.
	begin
		perform 1 from public.qorpera_account_presence;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated could read qorpera_account_presence'; end if;
	-- Before B accepts, A's board holds A and A's company only.
	select public.qorpera_friends_leaderboard() into v;
	-- The week runs from Monday 00:00 in Copenhagen for seven days.
	if extract(isodow from (v ->> 'since')::timestamptz at time zone 'Europe/Copenhagen') <> 1
		or ((v ->> 'since')::timestamptz at time zone 'Europe/Copenhagen')::time <> '00:00'
		or (v ->> 'until')::timestamptz - (v ->> 'since')::timestamptz <> interval '7 days'
		or (v ->> 'since')::timestamptz > statement_timestamp()
		or (v ->> 'week')::int <> extract(week from statement_timestamp() at time zone 'Europe/Copenhagen')::int then
		raise exception 'the board''s week is not this Monday-to-Sunday week in Copenhagen: %', v;
	end if;
	if jsonb_array_length(v -> 'people') <> 1
		or v -> 'people' -> 0 ->> 'main_profile_id' <> '11800000-0000-4000-8000-000000000101'
		or (v -> 'people' -> 0 ->> 'revenue_ore')::bigint <> 75000
		or jsonb_array_length(v -> 'companies') <> 1
		or v -> 'companies' -> 0 ->> 'name' <> 'Board shop' then
		raise exception 'A''s board before B accepts is not as expected: %', v;
	end if;
end
$$;

reset role;

-- C asks A: a pending request shows no last online time either way, and C's board holds only C.
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000c","email":"board-c@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb;
begin
	perform public.qorpera_send_friend_request('board-a@example.test');
	select friend into v from jsonb_array_elements(public.qorpera_list_friends()) friend
	where friend ->> 'user_id' = '11800000-0000-4000-8000-00000000000a';
	if v ->> 'status' is distinct from 'pending' or v ->> 'last_seen_at' is not null then
		raise exception 'C sees A''s last online time on a pending request: %', v;
	end if;
	select public.qorpera_friends_leaderboard() into v;
	if jsonb_array_length(v -> 'people') <> 1 or v -> 'people' -> 0 ->> 'user_id' <> '11800000-0000-4000-8000-00000000000c'
		or jsonb_array_length(v -> 'companies') <> 0 then
		raise exception 'C''s board shows someone or something that is not C''s: %', v;
	end if;
end
$$;

reset role;

-- B accepts (a request back accepts), sees A's last online time, and has A and both companies on its board:
-- B's revenue is both companies' (850 kr), A's only Board shop's (750 kr).
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000b","email":"board-b@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb; v_friend jsonb;
begin
	select public.qorpera_send_friend_request('board-a@example.test') into v;
	if v ->> 'status' is distinct from 'accepted' then
		raise exception 'B and A are not friends: %', v;
	end if;
	select friend into v_friend from jsonb_array_elements(public.qorpera_list_friends()) friend
	where friend ->> 'user_id' = '11800000-0000-4000-8000-00000000000a';
	if v_friend ->> 'last_seen_at' is null then
		raise exception 'B does not see when A was last online: %', v_friend;
	end if;
	select public.qorpera_friends_leaderboard() into v;
	if (v ->> 'hidden')::boolean
		or jsonb_array_length(v -> 'people') <> 2
		or not exists (select 1 from jsonb_array_elements(v -> 'people') p
			where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000b' and (p ->> 'me')::boolean
				and (p ->> 'revenue_ore')::bigint = 85000 and (p ->> 'companies')::int = 2 and (p ->> 'tasks')::int = 0 and (p ->> 'last_week_tasks')::int = 0
				-- No tasks anywhere: the main company is the one B joined first.
				and p ->> 'main_profile_id' = '11800000-0000-4000-8000-000000000101')
		or not exists (select 1 from jsonb_array_elements(v -> 'people') p
			where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000a' and not (p ->> 'me')::boolean
				and (p ->> 'revenue_ore')::bigint = 75000 and p ->> 'last_seen_at' is not null)
		or not exists (select 1 from jsonb_array_elements(v -> 'companies') c
			where c ->> 'name' = 'Board shop' and (c ->> 'revenue_ore')::bigint = 75000
				and c -> 'members' = '["11800000-0000-4000-8000-00000000000a", "11800000-0000-4000-8000-00000000000b"]'::jsonb)
		or not exists (select 1 from jsonb_array_elements(v -> 'companies') c
			where c ->> 'name' = 'Board cafe' and (c ->> 'revenue_ore')::bigint = 10000) then
		raise exception 'B''s board is not as expected: %', v;
	end if;
	-- B leaves its friends' boards; B still sees itself.
	perform public.qorpera_set_leaderboard_hidden(true);
	select public.qorpera_friends_leaderboard() into v;
	if not (v ->> 'hidden')::boolean
		or not exists (select 1 from jsonb_array_elements(v -> 'people') p
			where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000b') then
		raise exception 'B no longer sees itself after leaving: %', v;
	end if;
end
$$;

reset role;

-- A no longer sees B or B's own company, and still sees itself.
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000a","email":"board-a@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb;
begin
	select public.qorpera_friends_leaderboard() into v;
	if exists (select 1 from jsonb_array_elements(v -> 'people') p
		where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000b')
		or exists (select 1 from jsonb_array_elements(v -> 'companies') c where c ->> 'name' = 'Board cafe') then
		raise exception 'A still sees B or B''s company after B left the boards: %', v;
	end if;
	if not exists (select 1 from jsonb_array_elements(v -> 'people') p
		where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000a' and (p ->> 'me')::boolean) then
		raise exception 'A does not see itself: %', v;
	end if;
end
$$;

reset role;
rollback;
