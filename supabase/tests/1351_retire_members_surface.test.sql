-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.rms_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		raise exception 'retire_members_surface: %', p_message;
	end if;
end $$;

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_company constant uuid := '13510000-0000-4000-8000-000000000011';
	v_env constant uuid := '13510000-0000-4000-8000-000000000021';
begin
	perform pg_temp.rms_assert(
		position('''members''' in pg_get_functiondef(
			'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure
		)) = 0,
		'bootstrap no longer names the Members surface'
	);
	perform pg_temp.rms_assert(
		not has_function_privilege('anon', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE'),
		'keeps the grants on qorpera_service_bootstrap_company_surfaces'
	);

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company, 'People Co', v_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_owner, 'base-owner@example.test', 'Owner', 'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_company, 'Environment', 1, v_owner);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_folder_enable(v_env);
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, null);

	perform pg_temp.rms_assert(
		not exists (select 1 from public.qorpera_surfaces where profile_id = v_company and slug = 'members'),
		'a new company gets no Members surface'
	);
	perform pg_temp.rms_assert(
		(select array_agg(slug order by slug) from public.qorpera_surfaces where profile_id = v_company)
			= array['files', 'identity', 'inbox', 'money'],
		'a new company keeps identity, Inbox, Money and Files'
	);
	perform pg_temp.rms_assert(
		not exists (select 1 from public.qorpera_surfaces where surface_kind = 'members' and status <> 'archived'),
		'no Members surface stays active'
	);
end $$;

rollback;
