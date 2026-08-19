-- Friends (20260819010000), exercised as the real client roles. The
-- separation users from 040 are order-coupled fixtures: A is
-- sep-owner-a@example.test, B is sep-owner-b@example.test.

-- A requests B by email.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v jsonb; v_ok boolean := false;
begin
	if current_user <> 'authenticated' then
		raise exception 'friends suite is not running as authenticated (got %)', current_user;
	end if;
	-- Self-befriending is refused.
	begin
		perform public.qorpera_send_friend_request('sep-owner-a@example.test');
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'self friend request was accepted'; end if;
	-- Unknown email is a clean not-found.
	v_ok := false;
	begin
		perform public.qorpera_send_friend_request('nobody@example.test');
	exception when sqlstate 'P0002' then v_ok := true;
	end;
	if not v_ok then raise exception 'unknown email did not report not-found'; end if;

	select public.qorpera_send_friend_request('SEP-OWNER-B@example.test') into v;
	if v ->> 'status' is distinct from 'pending' then
		raise exception 'request did not enter pending: %', v;
	end if;
	-- Repeat is idempotent.
	select public.qorpera_send_friend_request('sep-owner-b@example.test') into v;
	if v ->> 'status' is distinct from 'pending' then
		raise exception 'repeat request changed state: %', v;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- B sees the incoming request; the requester cannot answer their own ask.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v jsonb;
begin
	select public.qorpera_list_friends() into v;
	if jsonb_array_length(v) <> 1
		or v -> 0 ->> 'status' is distinct from 'pending'
		or v -> 0 ->> 'direction' is distinct from 'incoming'
		or v -> 0 ->> 'email' is distinct from 'sep-owner-a@example.test' then
		raise exception 'incoming request not listed as expected: %', v;
	end if;
	-- B sending back = accepting (mutual request auto-accept).
	select public.qorpera_send_friend_request('sep-owner-a@example.test') into v;
	if v ->> 'status' is distinct from 'accepted' then
		raise exception 'mutual request did not auto-accept: %', v;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Both sides now list an accepted friendship.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v jsonb;
begin
	select public.qorpera_list_friends() into v;
	if jsonb_array_length(v) <> 1 or v -> 0 ->> 'status' is distinct from 'accepted' then
		raise exception 'A does not list the accepted friendship: %', v;
	end if;
	-- Remove, then re-request to exercise decline.
	perform public.qorpera_remove_friend((v -> 0 ->> 'user_id')::uuid);
	select public.qorpera_list_friends() into v;
	if jsonb_array_length(v) <> 0 then raise exception 'removal left rows: %', v; end if;
	perform public.qorpera_send_friend_request('sep-owner-b@example.test');
	-- The requester may not answer their own request.
	declare v_ok boolean := false;
	begin
		begin
			perform public.qorpera_respond_friend_request('80000000-0000-4000-8000-00000000000b', true);
		exception when insufficient_privilege then v_ok := true;
		end;
		if not v_ok then raise exception 'requester answered their own request'; end if;
	end;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- B declines: the row is gone for both.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v jsonb;
begin
	select public.qorpera_respond_friend_request('80000000-0000-4000-8000-00000000000a', false) into v;
	if v ->> 'status' is distinct from 'declined' then raise exception 'decline failed: %', v; end if;
	select public.qorpera_list_friends() into v;
	if jsonb_array_length(v) <> 0 then raise exception 'decline left rows: %', v; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Anon holds no grant on any of it; the table is unreachable directly.
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_list_friends();
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon can list friends'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean := false; v_seen integer;
begin
	begin
		select count(*) into v_seen from public.qorpera_friendships;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated can read the friendships table directly'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
