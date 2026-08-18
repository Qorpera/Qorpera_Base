-- Owner-delete and member-leave (20260818006000), exercised as the real
-- client roles. The separation users from 040 are order-coupled fixtures.

-- Owner A creates the profile the suite revolves around.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.dl_profile',
	public.qorpera_create_hosted_profile('Delete Leave QA', 'main', 1) ->> 'profile_id', false);
reset role;
select set_config('request.jwt.claims', '', false);

-- B joins as a contributor (fixture shortcut for the invitation flow).
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.dl_profile')::uuid,
	'80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', 'B', 'contributor');

-- A member leaves; the membership is gone and nothing else is.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_profile uuid := current_setting('qorpera_test.dl_profile')::uuid; v_ok boolean;
begin
	if current_user <> 'authenticated' then
		raise exception 'leave suite is not running as authenticated (got %)', current_user;
	end if;
	perform public.qorpera_leave_hosted_profile(v_profile);

	-- Leaving twice must be a clean not-found, not a silent success.
	v_ok := false;
	begin
		perform public.qorpera_leave_hosted_profile(v_profile);
	exception when no_data_found or sqlstate 'P0002' then v_ok := true;
	end;
	if not v_ok then raise exception 'second leave did not report not-found'; end if;

	-- A non-member must not be able to delete.
	v_ok := false;
	begin
		perform public.qorpera_delete_hosted_profile(v_profile);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'non-member deleted the profile'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare v_profile uuid := current_setting('qorpera_test.dl_profile')::uuid; v_seen integer;
begin
	select count(*) into v_seen from public.qorpera_profile_members
	where profile_id = v_profile and user_id = '80000000-0000-4000-8000-00000000000b';
	if v_seen <> 0 then raise exception 'leave did not remove the membership'; end if;
	select count(*) into v_seen from public.qorpera_profiles where id = v_profile;
	if v_seen <> 1 then raise exception 'leave damaged the profile itself'; end if;
end
$$;

-- Re-add B as contributor: a plain member must not be able to delete either.
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.dl_profile')::uuid,
	'80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', 'B', 'contributor');

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_delete_hosted_profile(current_setting('qorpera_test.dl_profile')::uuid);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'contributor deleted the profile'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- The owner cannot leave -- deletion is the owner's exit.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_profile uuid := current_setting('qorpera_test.dl_profile')::uuid; v_ok boolean := false;
begin
	begin
		perform public.qorpera_leave_hosted_profile(v_profile);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'the owner was allowed to leave'; end if;

	-- And the owner deletes: the profile and its whole graph go.
	perform public.qorpera_delete_hosted_profile(v_profile);
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare v_profile uuid := current_setting('qorpera_test.dl_profile')::uuid; v_seen integer;
begin
	select count(*) into v_seen from public.qorpera_profiles where id = v_profile;
	if v_seen <> 0 then raise exception 'delete left the profile row'; end if;
	select count(*) into v_seen from public.qorpera_profile_members where profile_id = v_profile;
	if v_seen <> 0 then raise exception 'delete left memberships behind'; end if;
	select count(*) into v_seen from public.qorpera_company_environments where profile_id = v_profile;
	if v_seen <> 0 then raise exception 'delete left environments behind'; end if;
end
$$;

-- Anon holds no grant on either entry point.
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_delete_hosted_profile('80000000-0000-4000-8000-0000000000d1');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon can call profile deletion'; end if;
	v_ok := false;
	begin
		perform public.qorpera_leave_hosted_profile('80000000-0000-4000-8000-0000000000d1');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon can call profile leave'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
