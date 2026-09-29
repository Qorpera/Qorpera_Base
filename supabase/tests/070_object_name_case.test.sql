-- Case-alias containment (20260818005000) and the backfill function.
--
-- The exploit this guards against needed only ordinary profile write access:
-- upload at an upper-case uuid prefix, and the old identity function folded
-- it onto the canonical object's catalog key, where the mirror's on-conflict
-- clause overwrote bytes. These assertions fail if either half regresses.

select set_config('qorpera_test.case_profile',
	(select profile.id::text from public.qorpera_profiles as profile
	where profile.name = 'Separation A' limit 1), false);

do $$
declare
	v_profile uuid := current_setting('qorpera_test.case_profile')::uuid;
	v_upper text := upper(current_setting('qorpera_test.case_profile'));
	v_sha text := repeat('7', 64);
	v_identity record;
begin
	if v_profile is null then raise exception 'case suite lost its profile fixture'; end if;

	-- The identity function must not recognise a non-canonical name at all.
	select * into v_identity
	from public.qorpera_profile_object_identity(
		'qorpera-profile-objects', v_upper || '/' || v_sha, '{"size":"99"}'::jsonb);
	if v_identity.profile_id is not null or v_identity.sha256 is not null then
		raise exception 'identity function still normalises an upper-case prefix';
	end if;

	-- The canonical spelling of the same object must still be recognised, so
	-- the assertion above is containment rather than a blanket rejection.
	select * into v_identity
	from public.qorpera_profile_object_identity(
		'qorpera-profile-objects', v_profile::text || '/' || v_sha, '{"size":"99"}'::jsonb);
	if v_identity.profile_id is distinct from v_profile
		or v_identity.sha256 is distinct from v_sha
		or v_identity.bytes is distinct from 99 then
		raise exception 'identity function rejects a canonical name';
	end if;
end
$$;

-- The mirror must not let a non-canonical name touch the catalog, even when
-- the row reaches storage.objects by a path that bypasses the policies (as
-- the service role can). This is the poisoning attempt in its purest form:
-- same profile, same sha, different size, different spelling.
insert into storage.objects (bucket_id, name, metadata)
values ('qorpera-profile-objects',
	current_setting('qorpera_test.case_profile') || '/' || repeat('8', 64),
	'{"size":"500"}');

insert into storage.objects (bucket_id, name, metadata)
values ('qorpera-profile-objects',
	upper(current_setting('qorpera_test.case_profile')) || '/' || repeat('8', 64),
	'{"size":"1"}');

do $$
declare
	v_profile uuid := current_setting('qorpera_test.case_profile')::uuid;
	v_bytes bigint;
	v_rows integer;
begin
	select count(*), max(bytes) into v_rows, v_bytes
	from public.qorpera_profile_objects
	where profile_id = v_profile and sha256 = repeat('8', 64);
	if v_rows <> 1 then
		raise exception 'expected exactly one catalog row for the canonical object, got %', v_rows;
	end if;
	if v_bytes <> 500 then
		raise exception 'alias upload poisoned the catalog size (bytes=%)', v_bytes;
	end if;
	if not public.qorpera_object_exists(v_profile, repeat('8', 64), 500) then
		raise exception 'canonical object lost its recorded size';
	end if;
end
$$;

-- An authenticated member must not be able to create an alias in the first
-- place: the insert policy is the outer half of the fix.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_upper text := upper(current_setting('qorpera_test.case_profile'));
	v_ok boolean := false;
begin
	if current_user <> 'authenticated' then
		raise exception 'case policy block is not running as authenticated (got %)', current_user;
	end if;
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-profile-objects', v_upper || '/' || repeat('9', 64), '{"size":"5"}');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then
		raise exception 'the insert policy still accepts a non-canonical uuid prefix';
	end if;

	-- Positive control: the same member may still write the canonical name,
	-- so the denial above is about spelling, not a broken write path.
	insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-profile-objects',
		current_setting('qorpera_test.case_profile') || '/' || repeat('a', 64), '{"size":"7"}');
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- The backfill, exercised with data for the first time. Dropping catalog rows
-- and re-adopting them is exactly what the production deploy did once.
do $$
declare
	v_profile uuid := current_setting('qorpera_test.case_profile')::uuid;
	v_before bigint;
	v_adopted bigint;
	v_after bigint;
begin
	select count(*) into v_before from public.qorpera_profile_objects;
	if v_before = 0 then raise exception 'backfill test needs existing catalog rows'; end if;

	delete from public.qorpera_profile_objects where profile_id = v_profile;
	if public.qorpera_object_catalog_drift() = 0 then
		raise exception 'drift blind to deliberately removed catalog rows';
	end if;

	select public.qorpera_backfill_profile_object_catalog() into v_adopted;
	if v_adopted < 1 then
		raise exception 'backfill adopted nothing (%)', v_adopted;
	end if;
	select count(*) into v_after from public.qorpera_profile_objects;
	if v_after <> v_before then
		raise exception 'backfill did not restore the catalog (% -> %)', v_before, v_after;
	end if;
	if public.qorpera_object_catalog_drift() <> 0 then
		raise exception 'drift remains after backfill: %', public.qorpera_object_catalog_drift();
	end if;

	-- Idempotent: running it again must change nothing.
	perform public.qorpera_backfill_profile_object_catalog();
	if public.qorpera_object_catalog_drift() <> 0 then
		raise exception 'second backfill introduced drift';
	end if;
end
$$;

-- The backfill is service-side only.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_backfill_profile_object_catalog();
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated can run the catalog backfill'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Posture. This file used to assert that the database has no default privileges
-- handing EXECUTE to the client roles, the assumption that "revoke from public"
-- protects an internal function. Production does have them (Supabase's platform
-- defaults), and bootstrap.sql now mirrors them, so that assumption is gone:
-- 001_api_function_allowlist.test.sql pins every SECURITY DEFINER function the
-- client roles can execute, and the revokes above name the roles.
