-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.idlogo_as(p_user uuid) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
end $$;

create function pg_temp.idlogo_back() returns void language plpgsql as $$
begin
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

do $$
declare
	v jsonb;
	v_legacy_sha text := encode(extensions.digest(convert_to('legacy logo', 'utf8'), 'sha256'), 'hex');
	v_identity_sha text := encode(extensions.digest(convert_to('identity svg logo', 'utf8'), 'sha256'), 'hex');
	v_png_sha text := encode(extensions.digest(convert_to('identity png logo', 'utf8'), 'sha256'), 'hex');
	v_custom_sha text := encode(extensions.digest(convert_to('custom root logo', 'utf8'), 'sha256'), 'hex');
	v_profile uuid := '92400000-0000-4000-8000-000000000010';
	v_identity_copy text := '92400000-0000-4000-8000-000000000010/' || v_identity_sha || '.png';
	v_custom_copy text := '92400000-0000-4000-8000-000000000010/' || v_custom_sha || '.png';
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'idlogo-0001', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/brand'),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/brand/logo.svg', 'file', pg_temp.base_stage('legacy logo'))));

	perform pg_temp.idlogo_as('92400000-0000-4000-8000-000000000002');
	select public.qorpera_company_logos(array[v_profile]) into v;
	if v -> 0 ->> 'source_sha256' <> v_legacy_sha or v -> 0 ->> 'source_path' <> 'QorperaOS/brand/logo.svg' then
		raise exception 'legacy fallback logo not resolved: %', v;
	end if;
	perform pg_temp.idlogo_back();

	perform pg_temp.base_commit(pg_temp.base_owner(), 'idlogo-0002', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'identity'),
		jsonb_build_object('op', 'write', 'path', 'identity/logo.png', 'file', pg_temp.base_stage('identity png logo'))));

	perform pg_temp.idlogo_as('92400000-0000-4000-8000-000000000002');
	select public.qorpera_company_logos(array[v_profile]) into v;
	if v -> 0 ->> 'source_sha256' <> v_png_sha or v -> 0 ->> 'source_path' <> 'identity/logo.png' then
		raise exception 'identity raster logo did not supersede legacy brand logo: %', v;
	end if;
	perform pg_temp.idlogo_back();

	perform pg_temp.base_commit(pg_temp.base_owner(), 'idlogo-0003', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'identity/logo.svg', 'file', pg_temp.base_stage('identity svg logo'))));

	perform pg_temp.idlogo_as('92400000-0000-4000-8000-000000000002');
	select public.qorpera_company_logos(array[v_profile]) into v;
	if v -> 0 ->> 'source_sha256' <> v_identity_sha or v -> 0 ->> 'source_path' <> 'identity/logo.svg' then
		raise exception 'identity svg logo did not supersede identity png logo: %', v;
	end if;
	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-company-logos', v_identity_copy, '{"size":"10"}');
	select public.qorpera_publish_company_logo(v_profile, v_identity_copy) into v;
	if v ->> 'object_name' <> v_identity_copy then
		raise exception 'identity svg logo copy was not published: %', v;
	end if;
	perform pg_temp.idlogo_back();

	perform pg_temp.idlogo_as('92400000-0000-4000-8000-000000000003');
	select public.qorpera_company_logos(array[v_profile]) into v;
	if v -> 0 ->> 'object_name' <> v_identity_copy
		or v -> 0 ->> 'source_sha256' is not null
		or v -> 0 ->> 'source_path' is not null then
		raise exception 'viewer received unexpected source details: %', v;
	end if;
	perform pg_temp.idlogo_back();

	insert into public.qorpera_surfaces (
		profile_id, slug, title, surface_group, archetype, surface_kind, is_global, status, source_kind, folder_root
	) values (
		v_profile, 'identity', 'Identity', 'products', 'studio', 'identity', true, 'active', 'folder', 'brand-kit'
	);
	perform pg_temp.base_commit(pg_temp.base_owner(), 'idlogo-0004', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'brand-kit'),
		jsonb_build_object('op', 'write', 'path', 'brand-kit/logo.svg', 'file', pg_temp.base_stage('custom root logo'))));

	perform pg_temp.idlogo_as('92400000-0000-4000-8000-000000000002');
	select public.qorpera_company_logos(array[v_profile]) into v;
	if v -> 0 ->> 'source_sha256' <> v_custom_sha or v -> 0 ->> 'source_path' <> 'brand-kit/logo.svg' then
		raise exception 'custom identity folder_root logo did not supersede identity/logo.svg: %', v;
	end if;
	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-company-logos', v_custom_copy, '{"size":"10"}');
	select public.qorpera_publish_company_logo(v_profile, v_custom_copy) into v;
	if v ->> 'object_name' <> v_custom_copy or v ->> 'previous_object_name' <> v_identity_copy then
		raise exception 'custom identity logo copy did not replace previous copy: %', v;
	end if;
	perform pg_temp.idlogo_back();
end
$$;

rollback;
