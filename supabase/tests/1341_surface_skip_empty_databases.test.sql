-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.ssed_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		raise exception 'surface_skip_empty_databases: %', p_message;
	end if;
end $$;

create function pg_temp.ssed_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ssed_make_company(p_profile uuid, p_env uuid, p_owner uuid, p_name text)
returns void language plpgsql as $$
begin
	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values (p_profile, p_name, p_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (p_profile, p_owner, 'base-owner@example.test', 'Owner', 'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (p_env, p_profile, 'Environment', 1, p_owner);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_folder_enable(p_env);
end $$;

create function pg_temp.ssed_stage(p_env uuid, p_text text)
returns jsonb language plpgsql as $$
declare
	v_manifest text := pg_temp.base_manifest(p_text);
	v_actor constant jsonb := '{"kind":"platform"}'::jsonb;
	v_open jsonb;
	v_obj jsonb;
	v_seal jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_open := public.qorpera_folder_open_upload(p_env, v_actor, v_manifest);
	for v_obj in
		select c from jsonb_array_elements(v_manifest::jsonb -> 'chunks') c
		union all
		select jsonb_build_object(
			'sha256', encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(v_manifest, 'utf8'))
		)
	loop
		if not (v_open -> 'present') ? (v_obj ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(
				p_env, v_actor, (v_open ->> 'intentId')::uuid, v_obj ->> 'sha256', (v_obj ->> 'bytes')::bigint
			);
		end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload(p_env, v_actor, (v_open ->> 'intentId')::uuid);
	perform pg_temp.ssed_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end $$;

create function pg_temp.ssed_write_file(p_env uuid, p_path text, p_text text, p_key text)
returns void language plpgsql as $$
declare
	v_actor constant jsonb := '{"kind":"platform"}'::jsonb;
	v_file jsonb := pg_temp.ssed_stage(p_env, p_text);
	v_parent text := public.qorpera_folder_parent_path(p_path);
	v_anc text;
	v_units jsonb := '[]'::jsonb;
	v_res jsonb;
begin
	if v_parent is not null then
		foreach v_anc in array public.qorpera_folder_ancestors(p_path) loop
			if not exists (
				select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_env
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_anc), 'sha256')
			) then
				v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', v_anc));
			end if;
		end loop;
	end if;
	v_units := v_units || jsonb_build_array(jsonb_build_object(
		'op', 'write',
		'path', p_path,
		'file', v_file
	));
	v_res := public.qorpera_folder_commit(p_env, v_actor, p_key, v_units);
	perform pg_temp.ssed_assert(
		not exists (select 1 from jsonb_array_elements(v_res -> 'units') u where u ->> 'outcome' <> 'saved'),
		'write saved for ' || p_path || ': ' || v_res::text
	);
end $$;

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_base_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_base_env constant uuid := '92400000-0000-4000-8000-000000000020';
	v_co_preseeded uuid := '13410000-0000-4000-8000-000000000011';
	v_env_preseeded uuid := '13410000-0000-4000-8000-000000000021';
	v_co_disabled uuid := '13410000-0000-4000-8000-000000000012';
	v_env_disabled uuid := '13410000-0000-4000-8000-000000000022';
	v_co_proposed uuid := '13410000-0000-4000-8000-000000000013';
	v_env_proposed uuid := '13410000-0000-4000-8000-000000000023';
	v_co_archived uuid := '13410000-0000-4000-8000-000000000014';
	v_env_archived uuid := '13410000-0000-4000-8000-000000000024';
	v_co_prune_empty uuid := '13410000-0000-4000-8000-000000000015';
	v_env_prune_empty uuid := '13410000-0000-4000-8000-000000000025';
	v_co_prune_session uuid := '13410000-0000-4000-8000-000000000016';
	v_env_prune_session uuid := '13410000-0000-4000-8000-000000000026';
	v_co_prune_auto uuid := '13410000-0000-4000-8000-000000000017';
	v_env_prune_auto uuid := '13410000-0000-4000-8000-000000000027';
	v_co_prune_prop uuid := '13410000-0000-4000-8000-000000000018';
	v_env_prune_prop uuid := '13410000-0000-4000-8000-000000000028';
	v_co_new_folder uuid := '13410000-0000-4000-8000-000000000019';
	v_env_new_folder uuid := '13410000-0000-4000-8000-000000000029';
	v_co_cofounder uuid := '13410000-0000-4000-8000-00000000001a';
	v_env_cofounder uuid := '13410000-0000-4000-8000-00000000002a';
	v_list jsonb;
	v_data_surface_id uuid;
	v_shop_ver uuid;
	v_deleted integer;
	v_fn text;
begin
	perform pg_temp.ssed_assert(
		public.qorpera_company_database_toml_path('data/shop/database.toml', 'data/shop/database.toml'),
		'accepts valid database.toml path'
	);
	perform pg_temp.ssed_assert(
		public.qorpera_company_database_toml_path('data/a/database.toml', 'data/a/database.toml')
		and public.qorpera_company_database_toml_path(
			'data/' || repeat('a', 40) || '/database.toml',
			'data/' || repeat('a', 40) || '/database.toml'
		)
		and public.qorpera_company_database_toml_path('data/shop_2/database.toml', 'Data/shop_2/Database.toml'),
		'accepts 1-char, 40-char, and case-varied outer segments'
	);
	perform pg_temp.ssed_assert(
		not public.qorpera_company_database_toml_path(
			'data/' || repeat('a', 41) || '/database.toml',
			'data/' || repeat('a', 41) || '/database.toml'
		)
		and not public.qorpera_company_database_toml_path('data/shop/database.toml', 'data/Shop/database.toml')
		and not public.qorpera_company_database_toml_path('data/qorpera/database.toml', 'data/qorpera/database.toml')
		and not public.qorpera_company_database_toml_path('data/pg_stat/database.toml', 'data/pg_stat/database.toml')
		and not public.qorpera_company_database_toml_path('data/qorpera_x/database.toml', 'data/qorpera_x/database.toml')
		and not public.qorpera_company_database_toml_path('data/1shop/database.toml', 'data/1shop/database.toml')
		and not public.qorpera_company_database_toml_path('data/_shop/database.toml', 'data/_shop/database.toml')
		and not public.qorpera_company_database_toml_path('data/shop-1/database.toml', 'data/shop-1/database.toml')
		and not public.qorpera_company_database_toml_path('data/shop/sub/database.toml', 'data/shop/sub/database.toml')
		and not public.qorpera_company_database_toml_path('data/database.toml', 'data/database.toml')
		and not public.qorpera_company_database_toml_path('data/shop/tables/001.sql', 'data/shop/tables/001.sql')
		and not public.qorpera_company_database_toml_path('other/shop/database.toml', 'other/shop/database.toml'),
		'rejects invalid, reserved, uppercase-name, and non-database.toml paths'
	);

	foreach v_fn in array array[
		'public.qorpera_company_database_toml_path(text,text)',
		'public.qorpera_company_has_database(uuid)',
		'public.qorpera_ensure_data_surface_on_database_toml()',
		'public.qorpera_prune_empty_data_surfaces()'
	] loop
		perform pg_temp.ssed_assert(
			not has_function_privilege('anon', v_fn, 'EXECUTE')
			and not has_function_privilege('authenticated', v_fn, 'EXECUTE')
			and not has_function_privilege('service_role', v_fn, 'EXECUTE')
			and not has_function_privilege('qorpera_secret_broker', v_fn, 'EXECUTE'),
			'revokes all API role execute privileges on ' || v_fn
		);
	end loop;
	perform pg_temp.ssed_assert(
		not has_function_privilege('anon', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)', 'EXECUTE'),
		'preserves exact grants on qorpera_service_bootstrap_company_surfaces'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	v_list := public.qorpera_bootstrap_company_surfaces(v_base_profile);
	reset role;
	perform pg_temp.ssed_assert(
		jsonb_array_length(v_list) = 5
		and not exists (select 1 from public.qorpera_surfaces where profile_id = v_base_profile and slug = 'data'),
		'bootstrap skips Databases surface when company has no database'
	);

	perform pg_temp.ssed_make_company(v_co_cofounder, v_env_cofounder, v_owner, 'New Co-Founder Co');
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_service_bootstrap_company_surfaces(v_co_cofounder, null);
	perform pg_temp.ssed_assert(
		(select count(*) from public.qorpera_surfaces where profile_id = v_co_cofounder) = 5
		and not exists (select 1 from public.qorpera_surfaces where profile_id = v_co_cofounder and slug = 'data'),
		'service bootstrap skips Databases surface for new company without a database'
	);

	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_commit('{"kind":"platform"}'::jsonb, 'ssed-non-db-files', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'data'),
		jsonb_build_object('op', 'write', 'path', 'data/notes.md', 'file', pg_temp.base_stage('notes')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/qorpera'),
		jsonb_build_object('op', 'write', 'path', 'data/qorpera/database.toml', 'file', pg_temp.base_stage('format = "qorpera.database/v1"')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/pg_test'),
		jsonb_build_object('op', 'write', 'path', 'data/pg_test/database.toml', 'file', pg_temp.base_stage('format = "qorpera.database/v1"')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/qorpera_sys'),
		jsonb_build_object('op', 'write', 'path', 'data/qorpera_sys/database.toml', 'file', pg_temp.base_stage('format = "qorpera.database/v1"')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/Shop'),
		jsonb_build_object('op', 'write', 'path', 'data/Shop/database.toml', 'file', pg_temp.base_stage('format = "qorpera.database/v1"'))
	));
	perform pg_temp.ssed_assert(
		not public.qorpera_company_has_database(v_base_profile)
		and not exists (select 1 from public.qorpera_surfaces where profile_id = v_base_profile and slug = 'data'),
		'non-database and invalid database paths do not create Databases surface'
	);

	select version into strict v_shop_ver
	from public.qorpera_folder_entries
	where environment_id = v_base_env
		and key_sha256 = extensions.digest(public.qorpera_folder_key('data/Shop'), 'sha256');
	perform pg_temp.base_commit('{"kind":"platform"}'::jsonb, 'ssed-respell-shop', jsonb_build_array(
		jsonb_build_object(
			'op', 'move',
			'from', 'data/Shop',
			'to', 'data/shop',
			'expectedVersion', v_shop_ver,
			'asOfSeq', (select last_seq from public.qorpera_folder_clocks where environment_id = v_base_env)
		)
	));
	perform pg_temp.ssed_assert(
		public.qorpera_company_has_database(v_base_profile)
		and exists (
			select 1 from public.qorpera_surfaces
			where profile_id = v_base_profile
				and slug = 'data'
				and title = 'Databases'
				and surface_group = 'operations'
				and archetype = 'ops'
				and surface_kind = 'data'
				and status = 'active'
				and icon = 'database'
				and source_kind = 'native_ops'
				and preview_mode = 'none'
				and sort_order = 130
		),
		'respelling data/Shop to data/shop creates Databases surface'
	);

	perform pg_temp.ssed_write_file(v_base_env, 'data/crm/database.toml', 'format = "qorpera.database/v1"', 'ssed-second-db');
	perform pg_temp.ssed_assert(
		(select count(*) from public.qorpera_surfaces where profile_id = v_base_profile and slug = 'data') = 1,
		'writing a second database leaves single Databases surface'
	);

	perform pg_temp.ssed_make_company(v_co_new_folder, v_env_new_folder, v_owner, 'New Folder Co');
	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	perform public.qorpera_bootstrap_company_surfaces(v_co_new_folder);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_folder_commit(
		v_env_new_folder,
		'{"kind":"platform"}'::jsonb,
		'ssed-orders-new-folder',
		jsonb_build_array(jsonb_build_object(
			'op', 'new_folder',
			'path', 'data',
			'contents', jsonb_build_array(
				jsonb_build_object('path', 'orders', 'kind', 'folder'),
				jsonb_build_object('path', 'orders/database.toml', 'kind', 'file', 'file', pg_temp.ssed_stage(v_env_new_folder, 'format = "qorpera.database/v1"'))
			)
		))
	);
	perform pg_temp.ssed_assert(
		exists (select 1 from public.qorpera_surfaces where profile_id = v_co_new_folder and slug = 'data' and status = 'active'),
		'new_folder inserting data/orders/database.toml creates Databases surface on bootstrapped company'
	);

	perform pg_temp.ssed_make_company(v_co_preseeded, v_env_preseeded, v_owner, 'Preseeded DB Co');
	perform pg_temp.ssed_write_file(v_env_preseeded, 'data/ledger/database.toml', 'format = "qorpera.database/v1"', 'ssed-preseeded-db');
	perform pg_temp.ssed_assert(
		not exists (select 1 from public.qorpera_surfaces where profile_id = v_co_preseeded),
		'database write does not insert lone Databases surface before company surfaces bootstrap'
	);
	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	v_list := public.qorpera_bootstrap_company_surfaces(v_co_preseeded);
	reset role;
	perform pg_temp.ssed_assert(
		jsonb_array_length(v_list) = 6
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_preseeded and slug = 'data' and status = 'active'),
		'bootstrap includes Databases surface when company already has a database'
	);

	perform pg_temp.ssed_make_company(v_co_proposed, v_env_proposed, v_owner, 'Proposed Data Co');
	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	perform public.qorpera_bootstrap_company_surfaces(v_co_proposed);
	reset role;
	perform public.qorpera_propose_surface(
		v_co_proposed, 'data', 'Databases', 'operations', 'ops', 'native_ops', 'database',
		null, null, 'none', null, 'data', null, false, false
	);
	perform pg_temp.ssed_assert(
		(select status from public.qorpera_surfaces where profile_id = v_co_proposed and slug = 'data') = 'proposed',
		'proposed data surface starts proposed'
	);
	perform pg_temp.ssed_write_file(v_env_proposed, 'data/shop/database.toml', 'format = "qorpera.database/v1"', 'ssed-activate-prop');
	perform pg_temp.ssed_assert(
		(select status from public.qorpera_surfaces where profile_id = v_co_proposed and slug = 'data') = 'active',
		'creating database activates proposed ops data surface'
	);

	perform pg_temp.ssed_make_company(v_co_archived, v_env_archived, v_owner, 'Archived Data Co');
	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	perform public.qorpera_bootstrap_company_surfaces(v_co_archived);
	reset role;
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order
	)
	values (v_co_archived, 'data', 'Databases', 'operations', 'ops', 'data', 'archived', 'database', 'native_ops', 'none', 130);
	perform pg_temp.ssed_write_file(v_env_archived, 'data/shop/database.toml', 'format = "qorpera.database/v1"', 'ssed-archived-stay');
	perform pg_temp.ssed_assert(
		(select status from public.qorpera_surfaces where profile_id = v_co_archived and slug = 'data') = 'archived',
		'creating database does not unarchive explicitly archived data surface'
	);

	perform pg_temp.ssed_make_company(v_co_disabled, v_env_disabled, v_owner, 'Disabled Surfaces Co');
	perform pg_temp.ssed_as(v_owner);
	set local role authenticated;
	perform public.qorpera_bootstrap_company_surfaces(v_co_disabled);
	reset role;
	update public.qorpera_surface_settings set enabled = false, updated_at = clock_timestamp() where singleton = true;
	perform pg_temp.ssed_write_file(v_env_disabled, 'data/shop/database.toml', 'format = "qorpera.database/v1"', 'ssed-disabled-db');
	perform pg_temp.ssed_assert(
		not exists (select 1 from public.qorpera_surfaces where profile_id = v_co_disabled and slug = 'data'),
		'trigger skips creating Databases surface while surfaces are disabled'
	);
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.ssed_make_company(v_co_prune_empty, v_env_prune_empty, v_owner, 'Prune Empty Co');
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order
	)
	values
		(v_co_prune_empty, 'data', 'Databases', 'operations', 'ops', 'data', 'active', 'figure:can', 'native_ops', 'none', 130),
		(v_co_prune_empty, 'database', 'Database', 'products', 'studio', 'database', 'active', 'database', 'folder', 'studio_overlay', 10);
	select id into strict v_data_surface_id from public.qorpera_surfaces where profile_id = v_co_prune_empty and slug = 'data';
	insert into public.qorpera_member_surface_state(user_id, surface_id)
	values (v_owner, v_data_surface_id);

	perform pg_temp.ssed_make_company(v_co_prune_session, v_env_prune_session, v_owner, 'Prune Session Co');
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order
	)
	values (v_co_prune_session, 'data', 'Databases', 'operations', 'ops', 'data', 'active', 'database', 'native_ops', 'none', 130)
	returning id into v_data_surface_id;
	insert into public.qorpera_surface_sessions(profile_id, surface_id, title, prompt, origin_kind, created_by_user_id, state)
	values (v_co_prune_session, v_data_surface_id, 'Set up CRM', 'Create a CRM database', 'member', v_owner, 'ready');

	perform pg_temp.ssed_make_company(v_co_prune_auto, v_env_prune_auto, v_owner, 'Prune Auto Co');
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order
	)
	values (v_co_prune_auto, 'data', 'Databases', 'operations', 'ops', 'data', 'active', 'database', 'native_ops', 'none', 130);
	insert into public.qorpera_surface_automations(
		profile_id, key, title, prompt, schedule_summary, target_surface_slug, output_mode, enabled, status
	)
	values (v_co_prune_auto, 'db-check', 'DB Check', 'Check tables', 'Every day · 09:00', 'data', 'surface_session', true, 'idle');

	perform pg_temp.ssed_make_company(v_co_prune_prop, v_env_prune_prop, v_owner, 'Prune Proposed Co');
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order
	)
	values (v_co_prune_prop, 'data', 'Databases', 'operations', 'ops', 'data', 'proposed', 'database', 'native_ops', 'none', 130);

	v_deleted := public.qorpera_prune_empty_data_surfaces();
	perform pg_temp.ssed_assert(v_deleted = 1, 'prune deletes exactly the 1 unused seeded data surface, got ' || v_deleted);
	perform pg_temp.ssed_assert(
		not exists (select 1 from public.qorpera_surfaces where profile_id = v_co_prune_empty and slug = 'data')
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_prune_empty and slug = 'database'),
		'prune removes empty ops data surface (even with member state) while keeping custom studio database surface'
	);
	perform pg_temp.ssed_assert(
		exists (select 1 from public.qorpera_surfaces where profile_id = v_base_profile and slug = 'data')
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_preseeded and slug = 'data')
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_prune_session and slug = 'data')
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_prune_auto and slug = 'data')
		and exists (select 1 from public.qorpera_surfaces where profile_id = v_co_prune_prop and slug = 'data'),
		'prune preserves data surfaces for companies with databases, sessions, automations, or proposed status'
	);
end $$;

rollback;
