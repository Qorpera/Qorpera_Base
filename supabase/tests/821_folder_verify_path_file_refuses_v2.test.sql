-- Folder core slice P10 (20260930001100; C1D §9.3 step 3): the version-1 proof refuses a folder-v2 company, before
-- any lock, and keeps proving a snapshot-v1 company's files.
begin;

insert into auth.users(id,email) values ('82100000-0000-4000-8000-000000000001','verify-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('82100000-0000-4000-8000-000000000010','Folder company','82100000-0000-4000-8000-000000000001'),
	('82100000-0000-4000-8000-000000000011','Snapshot company','82100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('82100000-0000-4000-8000-000000000010','82100000-0000-4000-8000-000000000001','verify-owner@example.test','Owner','owner'),
	('82100000-0000-4000-8000-000000000011','82100000-0000-4000-8000-000000000001','verify-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('82100000-0000-4000-8000-000000000020','82100000-0000-4000-8000-000000000010','Environment',1,'82100000-0000-4000-8000-000000000001'),
	('82100000-0000-4000-8000-000000000021','82100000-0000-4000-8000-000000000011','Environment',1,'82100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('82100000-0000-4000-8000-000000000020') \g /dev/null

-- A version-1 manifest of a text, with its objects in Storage under the company, as the old fixtures staged it.
create function pg_temp.v1_manifest(p_profile uuid, p_text text) returns text language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text;
begin
	insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects', p_profile || '/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','application/octet-stream','chunks',jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))))::text;
	insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects',
		p_profile || '/' || encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex'),
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return v_manifest;
end $$;

do $$
declare
	c_folder constant uuid := '82100000-0000-4000-8000-000000000010'; c_snapshot constant uuid := '82100000-0000-4000-8000-000000000011';
	v_manifest text;
begin
	-- A folder-v2 company: refused, and nothing is proved.
	v_manifest := pg_temp.v1_manifest(c_folder, 'the plan');
	begin
		perform public.qorpera_verify_company_path_file(c_folder, v_manifest);
		raise exception 'The verifier proved a folder-v2 company''s file' using errcode = 'QTF01';
	exception when sqlstate '0A000' then
		if sqlerrm <> 'This Company File path does not serve folder-v2 companies' then raise; end if;
	end;
	if exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = c_folder) then
		raise exception 'A refused proof recorded a verified file'; end if;
	-- A snapshot-v1 company: proved as before.
	v_manifest := pg_temp.v1_manifest(c_snapshot, 'the plan');
	perform public.qorpera_verify_company_path_file(c_snapshot, v_manifest);
	if (select count(*) from public.qorpera_verified_company_file_objects where profile_id = c_snapshot
			and manifest_sha256 = encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex')) <> 1 then
		raise exception 'A snapshot-v1 company''s proof did not record its file'; end if;
end $$;

-- The refusal comes before the gc fence (no lock for a refused call), and the body carries its release marker.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_verify_company_path_file(uuid,text)'::regprocedure);
begin
	if position('20260930001100' in v_definition) = 0 then raise exception 'The verifier lacks the P10 marker'; end if;
	if position('qorpera_company_is_folder_v2(p_profile_id)' in v_definition) = 0
		or position('qorpera_company_is_folder_v2(p_profile_id)' in v_definition)
			> position('qorpera_lock_profile_gc_fence(p_profile_id)' in v_definition) then
		raise exception 'The folder-v2 refusal does not come before the gc fence'; end if;
end $$;

rollback;
