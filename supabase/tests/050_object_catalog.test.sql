-- The object catalog must track storage.objects exactly for as long as
-- storage remains authoritative. Drift here would mean the future cutover
-- silently changes what the retention system believes exists.

do $$
declare v_drift bigint; v_rows bigint;
begin
	-- Migrations run before any fixture exists, so the inline backfill in
	-- 20260818003000 always ran against an empty table: these rows arrived via
	-- the mirror trigger, and this assertion proves the mirror populated the
	-- catalog, not that the backfill works. The backfill is covered as a
	-- callable function in 070, where it can be exercised with real data.
	select count(*) into v_rows from public.qorpera_profile_objects;
	if v_rows = 0 then
		raise exception 'catalog is empty; the mirror adopted nothing';
	end if;
	select public.qorpera_object_catalog_drift() into v_drift;
	if v_drift <> 0 then
		raise exception 'catalog diverged from storage.objects after backfill: % rows', v_drift;
	end if;
end
$$;

-- Live mirroring: insert, size change, and delete must each propagate.
insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('90000000-0000-4000-8000-000000000010', 'Catalog mirror', '20000000-0000-4000-8000-000000000001');

insert into storage.objects (bucket_id, name, metadata)
values ('qorpera-profile-objects', '90000000-0000-4000-8000-000000000010/' || repeat('e', 64), '{"size":"128"}');

do $$
declare v_bytes bigint; v_drift bigint;
begin
	select bytes into v_bytes from public.qorpera_profile_objects
	where profile_id = '90000000-0000-4000-8000-000000000010' and sha256 = repeat('e', 64);
	if v_bytes is distinct from 128 then
		raise exception 'insert did not mirror into the catalog (bytes=%)', v_bytes;
	end if;
	select public.qorpera_object_catalog_drift() into v_drift;
	if v_drift <> 0 then raise exception 'drift after insert: %', v_drift; end if;
end
$$;

update storage.objects set metadata = '{"size":"256"}'
where bucket_id = 'qorpera-profile-objects'
	and name = '90000000-0000-4000-8000-000000000010/' || repeat('e', 64);

do $$
declare v_bytes bigint; v_drift bigint;
begin
	select bytes into v_bytes from public.qorpera_profile_objects
	where profile_id = '90000000-0000-4000-8000-000000000010' and sha256 = repeat('e', 64);
	if v_bytes is distinct from 256 then
		raise exception 'update did not mirror into the catalog (bytes=%)', v_bytes;
	end if;
	select public.qorpera_object_catalog_drift() into v_drift;
	if v_drift <> 0 then raise exception 'drift after update: %', v_drift; end if;
end
$$;

delete from storage.objects
where bucket_id = 'qorpera-profile-objects'
	and name = '90000000-0000-4000-8000-000000000010/' || repeat('e', 64);

do $$
declare v_seen integer; v_drift bigint;
begin
	select count(*) into v_seen from public.qorpera_profile_objects
	where profile_id = '90000000-0000-4000-8000-000000000010' and sha256 = repeat('e', 64);
	if v_seen <> 0 then raise exception 'delete did not mirror into the catalog'; end if;
	select public.qorpera_object_catalog_drift() into v_drift;
	if v_drift <> 0 then raise exception 'drift after delete: %', v_drift; end if;
end
$$;

-- Non-profile writes must be ignored entirely rather than rejected: the
-- mirror may never be able to fail an upload the storage policies accepted.
insert into storage.buckets (id, name) values ('unrelated-bucket', 'unrelated-bucket')
on conflict (id) do nothing;

insert into storage.objects (bucket_id, name, metadata)
values
	('unrelated-bucket', 'anything/at/all.txt', '{"size":"5"}'),
	('qorpera-profile-objects', '90000000-0000-4000-8000-000000000010/not-a-sha', '{"size":"5"}'),
	('qorpera-profile-objects', 'not-a-uuid/' || repeat('f', 64), '{"size":"5"}');

do $$
declare v_drift bigint; v_seen integer;
begin
	select count(*) into v_seen from public.qorpera_profile_objects
	where profile_id = '90000000-0000-4000-8000-000000000010';
	if v_seen <> 0 then raise exception 'malformed names leaked into the catalog'; end if;
	select public.qorpera_object_catalog_drift() into v_drift;
	if v_drift <> 0 then raise exception 'drift after malformed writes: %', v_drift; end if;
end
$$;

-- The catalog is service-side state: no client role may read or write it.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean; v_seen integer;
begin
	v_ok := false;
	begin
		select count(*) into v_seen from public.qorpera_profile_objects;
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated can read the object catalog'; end if;

	v_ok := false;
	begin
		insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
		values ('90000000-0000-4000-8000-000000000010', repeat('a', 64), 1);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated can write the object catalog'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
