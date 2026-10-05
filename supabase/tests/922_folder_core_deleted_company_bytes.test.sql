-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- A deleted folder-v2 company's bytes go through the deleted-company cleanup (deploy/first-node/RUNTIME-GC-SWITCH-ON.md,
-- part 1; RUNTIME-COMPANY-DELETE.md D5a). Its folder objects share the catalog (qorpera_profile_objects, which outlives
-- the purge), the NAS layout and the Storage replica path with every other company object, so the artifact GC worker's
-- deleted-profile phase removes them: here its SQL half, end to end. The company holds committed files with their
-- chunks, an object staged under an upload intent and never committed, and a GC side row; it is deleted and purged; the
-- purge takes the chunk index, the side rows and the intents with it and leaves every catalog row; then the worker's
-- calls (claim, authorize and finalize each object, complete) remove every catalog row, and nothing holds one back.
-- Folder GC itself never claims the company once it is being deleted (881 §2), and the gateway's own sweep of bytes
-- with no catalog row leaves a purged company alone ('other'). On 803's company; rolled back at the end.

create function pg_temp.same(p_got anyelement, p_want anyelement, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;

-- The whole company on folder-v2, as every company is since 3 October.
select public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');

-- 1. What the company holds before its deletion ---------------------------------------------------------------------------

do $$
declare v_staged jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dcb-folder-1', jsonb_build_array(pg_temp.mkdir('dcb'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dcb-file-a-1', jsonb_build_array(pg_temp.put('dcb/a.md', 'first'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dcb-file-a-2', jsonb_build_array(pg_temp.put('dcb/a.md', 'second'))), 1, 'saved');
	-- Staged under an upload intent and never committed: catalogued, rooted only by its intent.
	v_staged := pg_temp.stage('staged, never committed');
	perform set_config('qorpera_test.dcb_staged', v_staged ->> 'manifestSha256', true);
	-- A GC side row, as the intent sweep leaves for an object nothing else roots.
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	values ('70700000-0000-4000-8000-000000000010', v_staged ->> 'manifestSha256', now() - interval '2 days');
end $$;

create temp table dcb_before as
select (select count(*) from public.qorpera_profile_objects where profile_id = '70700000-0000-4000-8000-000000000010') as catalog,
	(select count(*) from public.qorpera_folder_file_chunks where profile_id = '70700000-0000-4000-8000-000000000010') as chunks,
	(select count(*) from public.qorpera_folder_object_gc where profile_id = '70700000-0000-4000-8000-000000000010') as side_rows,
	(select count(*) from public.qorpera_folder_upload_intents where profile_id = '70700000-0000-4000-8000-000000000010') as intents,
	(select count(*) from public.qorpera_profile_objects where profile_id = '70700000-0000-4000-8000-000000000010'
		and backend = 'nas-object-gateway') as nas_backed;

do $$
declare v dcb_before%rowtype;
begin
	select * into strict v from dcb_before;
	if v.catalog < 3 or v.chunks < 1 or v.side_rows <> 1 or v.intents < 1 or v.nas_backed <> v.catalog then
		raise exception 'The fixture holds files, chunks, a side row and an intent, all NAS-backed: %', to_jsonb(v); end if;
end $$;

-- 2. Deleted and purged: the catalog stays, the rest goes with the company -----------------------------------------------

do $$
declare r jsonb;
begin
	perform public.qorpera_request_company_deletion('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001');
	-- Folder GC serves no company being deleted (881 §2); the deleted-company cleanup takes it after its purge.
	perform pg_temp.same(public.qorpera_folder_gc_company('70700000-0000-4000-8000-000000000010'), false,
		'folder GC leaves a company being deleted');
	r := public.qorpera_finish_company_deletion('70700000-0000-4000-8000-000000000010');
	perform pg_temp.same(r ->> 'state', 'purged', 'the nodes hold nothing of it, so the pass purges it');
	if exists (select 1 from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_files where profile_id = '70700000-0000-4000-8000-000000000010') then
		raise exception 'The company and its folder are gone'; end if;
	perform pg_temp.same((select count(*) from public.qorpera_profile_objects where profile_id = '70700000-0000-4000-8000-000000000010'),
		(select catalog from dcb_before), 'every catalog row outlives the purge, as the cleanup''s queue');
	perform pg_temp.same((select count(*) from public.qorpera_folder_file_chunks where profile_id = '70700000-0000-4000-8000-000000000010')
		+ (select count(*) from public.qorpera_folder_object_gc where profile_id = '70700000-0000-4000-8000-000000000010')
		+ (select count(*) from public.qorpera_folder_upload_intents where profile_id = '70700000-0000-4000-8000-000000000010'),
		0::bigint, 'the chunk index, the side rows and the intents go with the company');
end $$;

-- The gateway's sweep of bytes with no catalog row leaves a purged company alone (C1D §9.9: 'other'); a catalogued
-- object is the cleanup's.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
	perform pg_temp.same(public.qorpera_folder_gc_catalog_state('70700000-0000-4000-8000-000000000010', repeat('f', 64)), 'other',
		'no catalog row, company purged');
	perform pg_temp.same(public.qorpera_folder_gc_catalog_state('70700000-0000-4000-8000-000000000010',
		current_setting('qorpera_test.dcb_staged')), 'catalogued', 'a catalogued object');
end $$;

-- 3. The worker's deleted-profile phase, its SQL half (index.ts: claim, then per object authorize and, after the gateway
-- or Storage removed the bytes, finalize; then complete). It runs until no claim names the company; every catalog row
-- goes, and none is held back by a reference.

do $$
declare
	v_job jsonb; v_lease uuid; v_object jsonb; v_auth jsonb; v_rounds integer := 0; v_removed integer := 0; v_attempts integer;
begin
	loop
		v_rounds := v_rounds + 1;
		exit when v_rounds > 20;
		-- Other deleted companies may be queued first (other tests' leftovers): claim until this one comes.
		v_attempts := 0;
		loop
			v_attempts := v_attempts + 1;
			v_lease := extensions.gen_random_uuid();
			v_job := public.qorpera_claim_deleted_profile_object_gc(100, v_lease);
			exit when v_job is null or v_job ->> 'profile_id' = '70700000-0000-4000-8000-000000000010' or v_attempts > 50;
		end loop;
		exit when v_job is null or v_job ->> 'profile_id' is distinct from '70700000-0000-4000-8000-000000000010';
		for v_object in select value from jsonb_array_elements(v_job -> 'objects') loop
			perform pg_temp.same(v_object ->> 'backend', 'nas-object-gateway', 'a folder object is removed through the gateway');
			perform pg_temp.same(v_object ->> 'path', '70700000-0000-4000-8000-000000000010/' || (v_object ->> 'sha256'),
				'at the company''s path, the one the gateway''s DELETE /v1/profile-objects names');
			v_auth := public.qorpera_authorize_profile_object_deletion('70700000-0000-4000-8000-000000000010', v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint, v_object ->> 'backend', v_lease);
			if v_auth ->> 'state' = 'completed' then continue; end if;
			if not public.qorpera_finalize_profile_object_deletion((v_auth ->> 'authorization_id')::uuid,
					'70700000-0000-4000-8000-000000000010', v_object ->> 'sha256', (v_object ->> 'bytes')::bigint, v_object ->> 'backend') then
				raise exception 'An authorized deletion finalizes: %', v_object; end if;
			v_removed := v_removed + 1;
		end loop;
		perform public.qorpera_complete_deleted_profile_object_gc('70700000-0000-4000-8000-000000000010', v_lease,
			array(select value ->> 'sha256' from jsonb_array_elements(v_job -> 'objects')));
	end loop;
	perform pg_temp.same(v_removed::bigint, (select catalog from dcb_before), 'every catalog object of the company is removed once');
	if exists (select 1 from public.qorpera_profile_objects where profile_id = '70700000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_object_deletion_authorizations where profile_id = '70700000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_deleted_profile_object_gc_leases where profile_id = '70700000-0000-4000-8000-000000000010') then
		raise exception 'Nothing of the company''s bytes is left in the catalog, the authorizations or the leases'; end if;
end $$;

rollback;
