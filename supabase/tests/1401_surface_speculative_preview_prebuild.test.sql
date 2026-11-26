-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sspp_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_speculative_preview_prebuild: %', p_message;
	end if;
end $$;

create function pg_temp.sspp_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create function pg_temp.sspp_service(p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_other_owner constant uuid := '14010000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '14010000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '14010000-0000-4000-8000-000000000021';
	v_env_a uuid;
	v_surface uuid;
	v_folder_surface uuid;
	v_no_site_surface uuid;
	v_no_head_surface uuid;
	v_s1 uuid;
	v_s2 uuid;
	v_s_folder uuid;
	v_s_internal uuid;
	v_s_no_site uuid;
	v_s_no_head uuid;
	v_exp_id uuid;
	v_var_a uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_opt1 uuid;
	v_opt2 uuid;
	v_preview public.qorpera_surface_previews%rowtype;
	v_preview_after public.qorpera_surface_previews%rowtype;
	v_preview_multi public.qorpera_surface_previews%rowtype;
	v_preview_exp public.qorpera_surface_previews%rowtype;
	v_previews_before integer;
	v_claimed jsonb;
	v_lease uuid;
	v_req jsonb;
	v_build_id uuid;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_b_lease uuid;
	v_manifest jsonb;
	v_recipe constant jsonb := '{"run":"npm ci && npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_sel jsonb;
begin
	perform pg_temp.sspp_assert(
		not has_function_privilege('public', 'public.qorpera_surface_enqueue_speculative_preview(uuid,uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_surface_enqueue_speculative_preview(uuid,uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_enqueue_speculative_preview(uuid,uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_enqueue_speculative_preview(uuid,uuid,uuid)', 'EXECUTE'),
		'speculative helper is private'
	);

	update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true;
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company;
	insert into auth.users(id, email) values (v_other_owner, 'owner-1401-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SSPP Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SSPP Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1401', true, array['codex']);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('14010000-0000-4000-8000-0000000000d1', 'member', v_company, v_env_a, v_owner, 'exec-1401', repeat('7', 64), '{}');
	set local session_replication_role = origin;

	perform pg_temp.sspp_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Webshop', 'webshop', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_folder_surface := (public.qorpera_create_surface(
		v_company, 'Deck', 'deck', 'studio', 'custom', 'book', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_s1 := (public.qorpera_start_surface_session(v_surface, 'Hero update', 'Hero') ->> 'id')::uuid;
	v_s2 := (public.qorpera_start_surface_session(v_surface, 'Directions', 'Directions') ->> 'id')::uuid;
	v_s_folder := (public.qorpera_start_surface_session(v_folder_surface, 'Note', 'Note') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;

	perform public.qorpera_record_surface_change(
		v_s_folder, 'Folder note', 'Folder note', 'folder_patch',
		null, null, '{}'::uuid[], array['notes.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'notes.md', 'content', 'hi')),
		false
	);
	perform pg_temp.sspp_assert(
		not exists (select 1 from public.qorpera_surface_previews where surface_id = v_folder_surface),
		'folder surface never enqueues speculative preview'
	);

	v_c1 := (public.qorpera_record_surface_change(
		v_s1, 'Hero headline', 'Update hero', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false
	) ->> 'changeId')::uuid;

	select * into strict v_preview
	from public.qorpera_surface_previews
	where surface_id = v_surface and status = 'composing' and expires_at > clock_timestamp();
	perform pg_temp.sspp_assert(
		v_preview.selected_change_ids = array[v_c1]
		and v_preview.requested_by_user_id = v_owner,
		'recording a code_repo change immediately enqueues a speculative composing preview'
	);

	v_claimed := pg_temp.sspp_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem where (elem ->> 'previewId')::uuid = v_preview.id;
	v_req := pg_temp.sspp_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'preview', v_preview.id, v_lease, repeat('2', 40), repeat('a', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	select * into strict v_builder from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_owner;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;

	v_coding_claim := pg_temp.sspp_service($q$select public.qorpera_claim_coding_session('exec-1401', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.sspp_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));

	v_manifest := jsonb_build_object(
		'files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', repeat('1', 64), 'bytes', 256, 'content_type', 'text/html; charset=utf-8')
		),
		'redirects', '[]'::jsonb,
		'headers', '[]'::jsonb,
		'spa_fallback', null,
		'not_found_page', null
	);
	perform pg_temp.sspp_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 1, 256, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('c', 64), v_manifest::text
	));

	select * into strict v_preview_after from public.qorpera_surface_previews where id = v_preview.id;
	perform pg_temp.sspp_assert(
		v_preview_after.status = 'ready'
		and v_preview_after.site_version_id is not null
		and v_preview_after.expires_at > clock_timestamp() + interval '50 minutes',
		'speculative native preview stays ready and warm for one hour even before any member selects it'
	);

	perform pg_temp.sspp_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface, array[v_c1], null, '{}'::uuid[], '/');
	reset role;
	perform pg_temp.sspp_assert(
		(v_sel #>> '{primary,previewId}')::uuid = v_preview.id
		and v_sel #>> '{primary,status}' = 'ready'
		and nullif(v_sel #>> '{primary,memberPass}', '') is not null,
		'member opening the surface gets an immediate ready preview hit with zero rebuild wait'
	);

	perform public.qorpera_record_surface_change(
		v_s1, 'Hero headline v2', 'Revised hero', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false,
		null, null, v_c1
	);
	perform pg_temp.sspp_assert(
		exists (
			select 1 from public.qorpera_surface_previews p
			where p.surface_id = v_surface
				and p.id <> v_preview.id
				and p.status = 'composing'
				and p.selected_change_ids = array[v_c1]
				and p.expires_at > clock_timestamp()
		),
		'in-place change update enqueues fresh speculative preview for updated head_sha'
	);

	v_opt1 := (public.qorpera_record_surface_change(
		v_s2, 'Option A', 'Option A', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['src/theme.css'], null, null, false,
		'theme-choice', 'Theme'
	) ->> 'changeId')::uuid;
	select * into strict v_preview from public.qorpera_surface_previews
	where surface_id = v_surface and selected_change_ids = array[v_c1, v_opt1] and expires_at > clock_timestamp();

	v_opt2 := (public.qorpera_record_surface_change(
		v_s2, 'Option B', 'Option B', 'git_range',
		repeat('1', 40), repeat('5', 40), '{}'::uuid[], array['src/theme.css'], null, null, false,
		'theme-choice', 'Theme'
	) ->> 'changeId')::uuid;
	perform pg_temp.sspp_assert(
		(select expires_at > clock_timestamp() from public.qorpera_surface_previews where id = v_preview.id)
		and not exists (
			select 1 from public.qorpera_surface_previews
			where surface_id = v_surface and v_opt2 = any(selected_change_ids)
		),
		'staging a second option in an option group does not expire or overwrite option 1 speculative preview'
	);

	update public.qorpera_surface_sessions set updated_at = clock_timestamp() + interval '5 minutes' where id = v_s2;
	select * into strict v_preview_multi from public.qorpera_surface_previews where id = v_preview.id;
	update public.qorpera_surface_previews
	set status = 'ready', site_version_id = v_preview_after.site_version_id, expires_at = clock_timestamp() + interval '1 hour'
	where id = v_preview_multi.id;

	perform pg_temp.sspp_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface, array[v_opt1, v_c1], null, '{}'::uuid[], '/');
	reset role;
	perform pg_temp.sspp_assert(
		(v_sel #>> '{primary,previewId}')::uuid = v_preview_multi.id
		and v_sel #>> '{primary,status}' = 'ready'
		and v_sel #> '{primary,toggledChangeIds}' = jsonb_build_array(v_c1, v_opt1),
		'multi-session selection in reverse updated_at order normalizes canonically and hits ready speculative preview'
	);

	perform pg_temp.sspp_as(v_owner);
	set local role authenticated;
	perform public.qorpera_start_surface_session(
		v_surface, 'Explore header styles', 'Header exploration', 'member', null, null, 2, 'Header', array['Minimal', 'Bold']
	);
	reset role;
	select id into strict v_exp_id from public.qorpera_surface_explorations where surface_id = v_surface order by created_at desc limit 1;
	select id into strict v_var_a from public.qorpera_surface_sessions where exploration_id = v_exp_id and exploration_variant_label = 'Minimal';
	perform public.qorpera_record_surface_change(
		v_var_a, 'Minimal header', 'Minimal header', 'git_range',
		repeat('1', 40), repeat('6', 40), '{}'::uuid[], array['src/header.tsx'], null, null, false
	);
	select * into strict v_preview_exp
	from public.qorpera_surface_previews
	where surface_id = v_surface and exploration_session_id = v_var_a and status = 'composing' and expires_at > clock_timestamp();
	perform pg_temp.sspp_assert(
		v_preview_exp.selected_change_ids = array[v_c1, v_opt1]
		and v_preview_exp.requested_by_user_id = v_owner,
		'recording a change on an exploration session enqueues a speculative preview for that exploration session'
	);

	perform pg_temp.sspp_as(v_owner);
	set local role authenticated;
	v_s_internal := (public.qorpera_start_surface_session(v_surface, 'Internal sync', 'Internal') ->> 'id')::uuid;
	v_no_site_surface := (public.qorpera_create_surface(
		v_company, 'No Site', 'no-site', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_no_head_surface := (public.qorpera_create_surface(
		v_company, 'No Head', 'no-head', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_s_no_site := (public.qorpera_start_surface_session(v_no_site_surface, 'No site edit', 'Edit') ->> 'id')::uuid;
	v_s_no_head := (public.qorpera_start_surface_session(v_no_head_surface, 'No head edit', 'Edit') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surface_sessions set is_internal = true where id = v_s_internal;
	update public.qorpera_surfaces set site_id = null, live_head_sha = repeat('1', 40) where id = v_no_site_surface;
	update public.qorpera_surfaces set live_head_sha = null where id = v_no_head_surface;

	select count(*)::int into v_previews_before from public.qorpera_surface_previews where surface_id = v_surface;
	perform public.qorpera_record_surface_change(
		v_s_internal, 'Internal change', 'Internal change', 'git_range',
		repeat('1', 40), repeat('7', 40), '{}'::uuid[], array['src/internal.ts'], null, null, false
	);
	perform pg_temp.sspp_assert(
		(select count(*)::int from public.qorpera_surface_previews where surface_id = v_surface) = v_previews_before,
		'internal session skips speculative preview enqueue'
	);

	perform public.qorpera_record_surface_change(
		v_s_no_site, 'No site change', 'No site', 'git_range',
		repeat('1', 40), repeat('8', 40), '{}'::uuid[], array['src/a.ts'], null, null, false
	);
	perform public.qorpera_record_surface_change(
		v_s_no_head, 'No head change', 'No head', 'git_range',
		repeat('1', 40), repeat('9', 40), '{}'::uuid[], array['src/b.ts'], null, null, false
	);
	perform pg_temp.sspp_assert(
		not exists (select 1 from public.qorpera_surface_previews where surface_id in (v_no_site_surface, v_no_head_surface)),
		'surfaces without site_id or live_head_sha skip speculative preview enqueue'
	);

	update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
	insert into public.qorpera_computer_hour_usage(profile_id, metered_at, run_seconds, standard_seconds)
	values (v_company, clock_timestamp(), 100000000, 100000000);
	update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
	perform public.qorpera_computer_hour_zero_sweep(clock_timestamp());
	update public.qorpera_computer_hour_billing set coding_zero_rule_since = clock_timestamp() - interval '1 second';
	perform pg_temp.sspp_assert(public.qorpera_company_coding_at_zero(v_company, clock_timestamp()), 'company is at zero hours');

	select count(*)::int into v_previews_before from public.qorpera_surface_previews where surface_id = v_surface;
	v_c2 := (public.qorpera_record_surface_change(
		v_s1, 'Zero hour change', 'Zero hour change', 'git_range',
		repeat('3', 40), repeat('b', 40), '{}'::uuid[], array['src/zero.ts'], null, null, false
	) ->> 'changeId')::uuid;
	perform pg_temp.sspp_assert(
		v_c2 is not null
		and (select count(*)::int from public.qorpera_surface_previews where surface_id = v_surface) = v_previews_before,
		'company at zero computer hours skips speculative preview enqueue'
	);
end $$;

rollback;
