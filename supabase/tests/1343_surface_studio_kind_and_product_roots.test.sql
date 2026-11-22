-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spkr_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_studio_kind_and_product_roots: %', p_message;
	end if;
end $$;

create function pg_temp.spkr_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_other_owner uuid := '13430000-0000-4000-8000-000000000098';
	v_company_b uuid := '13430000-0000-4000-8000-000000000011';
	v_product_1 uuid;
	v_product_2 uuid;
	v_report_id uuid;
	v_db_id uuid;
	v_session_product uuid;
	v_session_report uuid;
	v_session_db uuid;
	v_lease_product uuid := '13430000-0000-4000-8000-000000000101';
	v_lease_report uuid := '13430000-0000-4000-8000-000000000102';
	v_lease_db uuid := '13430000-0000-4000-8000-000000000103';
	v_roots text[];
	v_turn jsonb;
	v_errcode text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	insert into auth.users(id, email) values (v_other_owner, 'owner-spkr-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Product Roots Co B', v_other_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company_b, v_other_owner, 'owner-spkr-b@example.test', 'Owner B', 'owner');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_roots := public.qorpera_surface_shared_product_folder_roots(v_company_a);
	perform pg_temp.spkr_assert(v_roots = '{}'::text[], 'empty when no active product studio exists');
	reset role;

	perform pg_temp.spkr_as(v_owner);
	set local role authenticated;
	v_product_1 := (public.qorpera_create_surface(v_company_a, 'Thetabands', 'thetabands', 'studio', 'product', 'figure:headband', null, 'surfaces/thetabands', null, false) ->> 'id')::uuid;
	v_product_2 := (public.qorpera_create_surface(v_company_a, 'Travel Case', 'travel-case', 'studio', 'product', 'figure:parcel', null, 'surfaces/travel-case', null, false) ->> 'id')::uuid;
	v_report_id := (public.qorpera_create_surface(v_company_a, 'Market Notes', 'market-notes', 'studio', 'report', 'figure:book', null, 'surfaces/market-notes', null, false) ->> 'id')::uuid;
	v_db_id := (public.qorpera_create_surface(v_company_a, 'Inventory', 'inventory', 'studio', 'database', 'figure:can', null, 'surfaces/inventory', null, false) ->> 'id')::uuid;

	v_session_product := (public.qorpera_start_surface_session(v_product_1, 'Design headband variants', 'Design') ->> 'id')::uuid;
	v_session_report := (public.qorpera_start_surface_session(v_report_id, 'Compare EEG competitors', 'Competitors') ->> 'id')::uuid;
	v_session_db := (public.qorpera_start_surface_session(v_db_id, 'Add SKU table', 'Schema') ->> 'id')::uuid;

	v_errcode := null;
	begin
		perform public.qorpera_surface_shared_product_folder_roots(v_company_a);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.spkr_assert(v_errcode = '42501', 'authenticated cannot execute qorpera_surface_shared_product_folder_roots');
	reset role;

	perform pg_temp.spkr_as(v_other_owner);
	set local role authenticated;
	perform public.qorpera_create_surface(v_company_b, 'Other Product', 'other-product', 'studio', 'product', 'figure:parcel', null, 'surfaces/other-product', null, false);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;

	perform public.qorpera_native_surface_propose(
		v_company_a, 'proposed-product', 'Proposed Product', 'products', 'studio', 'folder',
		'figure:parcel', null, 'surfaces/proposed-product', 'studio_overlay', null, 'product', null, false, false
	);

	v_roots := public.qorpera_surface_shared_product_folder_roots(v_company_a);
	perform pg_temp.spkr_assert(
		v_roots = array['surfaces/thetabands', 'surfaces/travel-case'],
		'returns only active product studio folder roots for the tenant in sort order, got ' || coalesce(array_to_string(v_roots, ','), 'null')
	);

	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease_product where id = v_session_product;
	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease_report where id = v_session_report;
	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease_db where id = v_session_db;

	v_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_session_product, v_lease_product);
	perform pg_temp.spkr_assert(v_turn ->> 'surfaceKind' = 'product', 'product turn returns surfaceKind=product');
	perform pg_temp.spkr_assert(v_turn ->> 'folderRoot' = 'surfaces/thetabands', 'product turn returns isolated folderRoot');
	perform pg_temp.spkr_assert(
		v_turn -> 'productFolderRoots' = '["surfaces/thetabands","surfaces/travel-case"]'::jsonb,
		'product turn returns productFolderRoots'
	);

	v_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_session_report, v_lease_report);
	perform pg_temp.spkr_assert(v_turn ->> 'surfaceKind' = 'report', 'report turn returns surfaceKind=report');

	v_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_session_db, v_lease_db);
	perform pg_temp.spkr_assert(v_turn ->> 'surfaceKind' = 'database', 'database turn returns surfaceKind=database');

	reset role;
end $$;
