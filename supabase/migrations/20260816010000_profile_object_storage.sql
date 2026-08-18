-- Private, profile-scoped content-addressed object storage.
--
-- Objects are immutable and named <profile UUID>/<sha256>. The desktop hashes
-- every upload and verifies every download. Files larger than one object are
-- represented by a content-addressed chunk manifest.

insert into storage.buckets (id, name, public, file_size_limit)
values ('qorpera-profile-objects', 'qorpera-profile-objects', false, 8388608)
on conflict (id) do update
set public = false,
	file_size_limit = excluded.file_size_limit;

create policy qorpera_profile_objects_member_read
	on storage.objects
	for select
	to authenticated
	using (
		bucket_id = 'qorpera-profile-objects'
		and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[0-9a-f]{64}$'
		and public.qorpera_can_read_profile(((storage.foldername(name))[1])::uuid)
	);

create policy qorpera_profile_objects_member_insert
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'qorpera-profile-objects'
		and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[0-9a-f]{64}$'
		and public.qorpera_can_write_profile(((storage.foldername(name))[1])::uuid)
	);
