-- Friends' last online time and the friends leaderboard (20260930690000), as the real client role, in one
-- transaction that is rolled back. A and B become friends; C is a stranger with a pending request to A.
begin;

insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data)
values
	('11800000-0000-4000-8000-00000000000a', 'board-a@example.test', statement_timestamp(), null, '{"display_name":"Board A"}'),
	('11800000-0000-4000-8000-00000000000b', 'board-b@example.test', statement_timestamp(), null, '{"display_name":"Board B"}'),
	('11800000-0000-4000-8000-00000000000c', 'board-c@example.test', statement_timestamp(),
		statement_timestamp() - interval '2 days', '{"display_name":"Board C"}');

-- A marks itself online, asks B and is asked by C.
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
	-- Members never read the tables themselves.
	begin
		perform 1 from public.qorpera_account_presence;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated could read qorpera_account_presence'; end if;
	v_ok := false;
	begin
		perform 1 from public.qorpera_account_active_days;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated could read qorpera_account_active_days'; end if;
end
$$;

reset role;

do $$
begin
	if not exists (
		select 1 from public.qorpera_account_active_days
		where user_id = '11800000-0000-4000-8000-00000000000a' and day = (clock_timestamp() at time zone 'UTC')::date
	) then
		raise exception 'the mark did not record an active day';
	end if;
end
$$;

-- A was also online 1, 2, 6 and 7 UTC days ago: the week counts today, 1, 2 and 6 days ago (the last 7 calendar
-- days, today included), and A's streak is 3 (today, yesterday and the day before).
insert into public.qorpera_account_active_days (user_id, day)
select '11800000-0000-4000-8000-00000000000a', (clock_timestamp() at time zone 'UTC')::date - back
from unnest(array[1, 2, 6, 7]) back;

-- C asks A: a pending request shows no last online time either way.
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000c","email":"board-c@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb;
begin
	perform public.qorpera_send_friend_request('board-a@example.test');
	select friend into v from jsonb_array_elements(public.qorpera_list_friends()) friend
	where friend ->> 'user_id' = '11800000-0000-4000-8000-00000000000a';
	if v ->> 'status' is distinct from 'pending' or v ? 'last_seen_at' and v ->> 'last_seen_at' is not null then
		raise exception 'C sees A''s last online time on a pending request: %', v;
	end if;
	-- C's board holds only C.
	select public.qorpera_friends_leaderboard() into v;
	if jsonb_array_length(v -> 'people') <> 1 or v -> 'people' -> 0 ->> 'user_id' <> '11800000-0000-4000-8000-00000000000c' then
		raise exception 'C''s board shows someone who is not a friend: %', v;
	end if;
end
$$;

reset role;

-- B accepts (a request back accepts), sees A's last online time, and has A on its board.
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
		or jsonb_typeof(v -> 'companies') <> 'array' or jsonb_typeof(v -> 'agents') <> 'array'
		or jsonb_array_length(v -> 'people') <> 2
		or not exists (select 1 from jsonb_array_elements(v -> 'people') p
			where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000b' and (p ->> 'me')::boolean)
		or not exists (select 1 from jsonb_array_elements(v -> 'people') p
			where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000a' and not (p ->> 'me')::boolean
				and (p ->> 'active_days')::int = 4 and (p ->> 'streak')::int = 3 and p ->> 'last_seen_at' is not null
				and (p ->> 'tasks')::int = 0) then
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

-- A no longer sees B, and still sees itself.
select set_config('request.jwt.claims', '{"sub":"11800000-0000-4000-8000-00000000000a","email":"board-a@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;

do $$
declare v jsonb;
begin
	select public.qorpera_friends_leaderboard() into v;
	if exists (select 1 from jsonb_array_elements(v -> 'people') p
		where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000b') then
		raise exception 'A still sees B after B left the boards: %', v;
	end if;
	if not exists (select 1 from jsonb_array_elements(v -> 'people') p
		where p ->> 'user_id' = '11800000-0000-4000-8000-00000000000a' and (p ->> 'me')::boolean) then
		raise exception 'A does not see itself: %', v;
	end if;
end
$$;

reset role;
rollback;
