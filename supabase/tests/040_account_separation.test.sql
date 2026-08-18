-- DBTEST-1: cross-account separation, exercised as the real PostgREST roles.
--
-- Every other suite runs as the bootstrap superuser, which silently bypasses
-- row security and every table grant — so the separation model itself has
-- never been executed. These tests switch to `authenticated` and `anon` with
-- real JWT claims, which is the only way an RLS policy or a missing/extra
-- grant can actually fail a build.

insert into auth.users (id, email, email_confirmed_at)
values
	('80000000-0000-4000-8000-00000000000a', 'sep-owner-a@example.test', statement_timestamp()),
	('80000000-0000-4000-8000-00000000000b', 'sep-owner-b@example.test', statement_timestamp());

create or replace function pg_temp.act_as(p_user uuid)
returns void language sql as $$
	select set_config(
		'request.jwt.claims',
		json_build_object(
			'sub', p_user,
			'email', (select email from auth.users where id = p_user),
			'role', 'authenticated',
			'user_metadata', json_build_object()
		)::text,
		false
	);
	set role authenticated;
$$;

-- Two independent accounts each create their own hosted profile through the
-- ordinary authenticated path.
select pg_temp.act_as('80000000-0000-4000-8000-00000000000a');
select public.qorpera_create_hosted_profile('Separation A', 'main', 1);
reset role;

select pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
select public.qorpera_create_hosted_profile('Separation B', 'main', 1);
reset role;

reset role;
select set_config('request.jwt.claims', '', false);
create temporary table sep_ids as
select
	(select id from public.qorpera_profiles where name = 'Separation A') as profile_a,
	(select id from public.qorpera_profiles where name = 'Separation B') as profile_b;

do $$
declare v_a uuid; v_b uuid; v_seen integer; v_ok boolean;
begin
	select profile_a, profile_b into v_a, v_b from sep_ids;
	if v_a is null or v_b is null then
		raise exception 'fixture profiles were not created';
	end if;

	-- 1. RLS read isolation: B must not see A's profile, members, or environments.
	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
	select count(*) into v_seen from public.qorpera_profiles where id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: account B read account A profile row'; end if;
	select count(*) into v_seen from public.qorpera_profile_members where profile_id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: account B read account A membership'; end if;
	select count(*) into v_seen from public.qorpera_company_environments where profile_id = v_a;
	if v_seen <> 0 then raise exception 'RLS leak: account B read account A environments'; end if;
	-- and must still see its own
	select count(*) into v_seen from public.qorpera_profiles where id = v_b;
	if v_seen <> 1 then raise exception 'RLS over-restriction: account B cannot read its own profile'; end if;
	reset role;

	-- 2. Authorization helpers must refuse across accounts.
	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
	if public.qorpera_can_read_profile(v_a) then raise exception 'can_read_profile true across accounts'; end if;
	if public.qorpera_can_write_profile(v_a) then raise exception 'can_write_profile true across accounts'; end if;
	if public.qorpera_can_authorize_profile(v_a) then raise exception 'can_authorize_profile true across accounts'; end if;
	reset role;

	-- 3. Protected tables reject direct writes from authenticated; mutations
	--    exist only behind security-definer RPCs.
	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
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
	reset role;

	-- 4. Service-only entry points must be unreachable for authenticated
	--    callers, whether by missing grant or by their own role check.
	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
	v_ok := false;
	begin
		perform public.qorpera_claim_runner_job(
			'80000000-0000-4000-8000-0000000000c1', repeat('a', 64),
			'80000000-0000-4000-8000-0000000000c2', repeat('b', 64));
	exception when insufficient_privilege or undefined_function then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated could invoke the runner claim entry point'; end if;

	v_ok := false;
	begin
		perform public.qorpera_renew_artifact_gc_lease(
			'80000000-0000-4000-8000-0000000000c3', '80000000-0000-4000-8000-0000000000c4',
			array[repeat('c', 64)]);
	exception when insufficient_privilege or undefined_function then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated could invoke the GC lease renewal'; end if;
	reset role;

	-- 5. anon holds no read access at all.
	set role anon;
	select set_config('request.jwt.claims', '{"role":"anon"}', false);
	select count(*) into v_seen from public.qorpera_profiles;
	if v_seen <> 0 then raise exception 'anon read profile rows'; end if;
	select count(*) into v_seen from public.qorpera_session_events;
	if v_seen <> 0 then raise exception 'anon read session events'; end if;
	reset role;

	select set_config('request.jwt.claims', '', false);
end
$$;

-- 6. Storage separation: an account may only write objects under its own
--    profile prefix, and may not read another account's objects.
do $$
declare v_a uuid; v_b uuid; v_seen integer;
begin
	select profile_a, profile_b into v_a, v_b from sep_ids;

	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000a');
	insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-profile-objects', v_a::text || '/' || repeat('1', 64), '{"size":"11"}');
	reset role;

	perform pg_temp.act_as('80000000-0000-4000-8000-00000000000b');
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-profile-objects', v_a::text || '/' || repeat('2', 64), '{"size":"12"}');
		raise exception 'account B wrote an object under account A prefix';
	exception when insufficient_privilege then null;
	end;
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-profile-objects' and name like v_a::text || '/%';
	if v_seen <> 0 then raise exception 'account B read objects under account A prefix'; end if;
	reset role;

	select set_config('request.jwt.claims', '', false);
end
$$;
