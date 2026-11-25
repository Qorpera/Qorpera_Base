-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.ss_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		raise exception 'strategy_surface: %', p_message;
	end if;
end $$;

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_company constant uuid := '13760000-0000-4000-8000-000000000011';
	v_env constant uuid := '13760000-0000-4000-8000-000000000021';
	v_proposed jsonb;
begin
	perform pg_temp.ss_assert(
		not has_function_privilege('anon', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE'),
		'preserves grants on qorpera_service_bootstrap_company_surfaces'
	);

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company, 'Strategy Co', v_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_owner, 'base-owner@example.test', 'Owner', 'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_company, 'Environment', 1, v_owner);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_folder_enable(v_env);
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, null);

	perform pg_temp.ss_assert(
		exists (
			select 1 from public.qorpera_surfaces
			where profile_id = v_company
				and slug = 'strategy'
				and title = 'Strategy'
				and surface_group = 'products'
				and archetype = 'studio'
				and surface_kind = 'strategy'
				and status = 'active'
				and icon = 'figure:lighthouse'
				and source_kind = 'folder'
				and folder_root = 'surfaces/strategy'
				and preview_mode = 'studio_overlay'
				and sort_order = 5
		),
		'bootstrap seeds active Strategy Studio surface'
	);

	v_proposed := public.qorpera_propose_surface(
		v_company, 'pricing-lab', 'Pricing Lab', 'products', 'studio', 'folder',
		'star', null, null, 'studio_overlay', 'Test competing pricing models', 'custom', null, false, true
	);
	perform pg_temp.ss_assert(
		v_proposed ->> 'folderRoot' = 'surfaces/pricing-lab'
		and v_proposed ->> 'kind' = 'custom'
		and v_proposed ->> 'archetype' = 'studio',
		'propose_surface defaults folder_root for custom studio surfaces'
	);
end $$;

rollback;
