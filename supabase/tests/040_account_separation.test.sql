-- DBTEST-1: cross-account separation, exercised as the real PostgREST roles.
--
-- Every other suite runs as the bootstrap superuser, which bypasses row
-- security and every table grant, so the separation model itself has never
-- been executed. These tests switch to authenticated and anon with real JWT
-- claims, the only way a broken RLS policy or a missing grant can fail a
-- build.
--
-- Role switching stays at the top level (psql), never inside plpgsql, so each
-- assertion block provably runs under the role named just above it. Profile
-- ids travel in session GUCs, because RLS deliberately hides the other
-- account's id from the account doing the asserting, and psql does not
-- interpolate its own variables inside dollar-quoted blocks.

insert into auth.users (id, email, email_confirmed_at)
values
	('80000000-0000-4000-8000-00000000000a', 'sep-owner-a@example.test', statement_timestamp()),
	('80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', statement_timestamp());

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
-- Privileged legacy fixture construction; authority assertions below still
-- execute as the actual client roles. New clients must use founding creation.
select set_config('qorpera_test.profile_a', public.qorpera_create_hosted_profile('Separation A', 'main', 1) ->> 'profile_id', false);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
select set_config('qorpera_test.profile_b', public.qorpera_create_hosted_profile('Separation B', 'main', 1) ->> 'profile_id', false);

-- Account A writes and reads back its own object first. Ordering matters:
-- B's cross-account read assertion below is vacuous unless something actually
-- exists under A's prefix for it to fail to see.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_a uuid := current_setting('qorpera_test.profile_a')::uuid; v_seen integer;
begin
	if current_user <> 'authenticated' then
		raise exception 'owner block is not running as authenticated (got %)', current_user;
	end if;
	insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-profile-objects', v_a::text || '/' || repeat('1', 64), '{"size":"11"}');
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-profile-objects' and name like v_a::text || '/%';
	if v_seen <> 1 then raise exception 'owning account could not read back its own object'; end if;
end
$$;

reset role;

-- Anti-vacuity, asserted from outside any client role: B's zero-count read
-- below only means "hidden" if there is genuinely something under A's prefix
-- to hide. Without this, deleting the read policy outright would still pass.
do $$
declare v_a uuid := current_setting('qorpera_test.profile_a')::uuid; v_seen integer;
begin
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-profile-objects' and name = v_a::text || '/' || repeat('1', 64);
	if v_seen <> 1 then
		raise exception 'cross-account read assertion would be vacuous: A has no object to hide';
	end if;
end
$$;

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_a uuid := current_setting('qorpera_test.profile_a')::uuid; v_b uuid := current_setting('qorpera_test.profile_b')::uuid; v_seen integer; v_ok boolean;
begin
	if current_user <> 'authenticated' then
		raise exception 'separation test is not running as authenticated (got %)', current_user;
	end if;

	select count(*) into v_seen from public.qorpera_profiles where id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: B read A profile row'; end if;
	select count(*) into v_seen from public.qorpera_profile_members where profile_id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: B read A membership'; end if;
	select count(*) into v_seen from public.qorpera_company_environments where profile_id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: B read A environments'; end if;
	select count(*) into v_seen from public.qorpera_profiles where id = v_b;
	if v_seen <> 1 then raise exception 'RLS over-restriction: B cannot read its own profile'; end if;

	if public.qorpera_can_read_profile(v_a) then raise exception 'can_read_profile true across accounts'; end if;
	if public.qorpera_can_write_profile(v_a) then raise exception 'can_write_profile true across accounts'; end if;
	if public.qorpera_can_authorize_profile(v_a) then raise exception 'can_authorize_profile true across accounts'; end if;

	begin
		insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
		values (v_a, '80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', 'B', 'owner');
		raise exception 'direct membership insert was permitted';
	exception when insufficient_privilege then null;
	end;
	begin
		update public.qorpera_profiles set name = 'hijacked' where id = v_a;
		raise exception 'direct profile update was permitted';
	exception when insufficient_privilege then null;
	end;
	begin
		delete from public.qorpera_session_events;
		raise exception 'direct event delete was permitted';
	exception when insufficient_privilege then null;
	end;

	-- Existence is asserted separately so a renamed or re-signed function
	-- fails the suite instead of raising undefined_function and being scored
	-- as a denial forever after.
	if to_regprocedure('qorpera_claim_runner_job(uuid, text, uuid, text)') is null then
		raise exception 'qorpera_claim_runner_job signature drifted; denial test would be vacuous';
	end if;
	v_ok := false;
	begin
		perform public.qorpera_claim_runner_job(
			'80000000-0000-4000-8000-0000000000c1', repeat('a', 64),
			'80000000-0000-4000-8000-0000000000c2', repeat('b', 64));
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated invoked the runner claim entry point'; end if;

	if to_regprocedure('qorpera_renew_artifact_gc_lease(uuid, uuid, text[])') is null then
		raise exception 'qorpera_renew_artifact_gc_lease signature drifted; denial test would be vacuous';
	end if;
	v_ok := false;
	begin
		perform public.qorpera_renew_artifact_gc_lease(
			'80000000-0000-4000-8000-0000000000c3', '80000000-0000-4000-8000-0000000000c4',
			array[repeat('c', 64)]);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated invoked the GC lease renewal'; end if;

	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-profile-objects', v_a::text || '/' || repeat('2', 64), '{"size":"12"}');
		raise exception 'B wrote an object under A prefix';
	exception when insufficient_privilege then null;
	end;
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-profile-objects' and name like v_a::text || '/%';
	if v_seen <> 0 then raise exception 'B read objects under A prefix'; end if;
end
$$;

reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

do $$
declare v_seen integer; v_ok boolean;
begin
	if current_user <> 'anon' then
		raise exception 'anon block is not running as anon (got %)', current_user;
	end if;
	-- anon is denied at the grant level, not merely filtered by RLS: the
	-- baseline revokes every privilege and only re-grants select to
	-- authenticated. Asserting the error (rather than a zero count) pins the
	-- stronger of the two guarantees, and would fail if a future migration
	-- handed anon a grant and left RLS as the only defence.
	v_ok := false;
	begin
		select count(*) into v_seen from public.qorpera_profiles;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon holds a grant on qorpera_profiles'; end if;

	v_ok := false;
	begin
		select count(*) into v_seen from public.qorpera_session_events;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon holds a grant on qorpera_session_events'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
