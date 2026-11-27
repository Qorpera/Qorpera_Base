-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.srsb_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_repo_subpath_and_branch: %', p_message;
	end if;
end $$;

create function pg_temp.srsb_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '93400000-0000-4000-8000-000000000002';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env_id uuid;
	v_staff_id uuid;
	v_overload_count integer;
	v_errcode text;
	v_web_app jsonb;
	v_web_app_id uuid;
	v_studio_id uuid;
	v_archived_id uuid;
	v_proposed jsonb;
	v_native_proposed jsonb;
	v_repos jsonb;
	v_bound jsonb;
	v_session_id uuid;
	v_change_id uuid;
	v_preview_id uuid;
	v_preview_expires timestamptz;
	v_senses jsonb;
	v_turn jsonb;
	v_claimed jsonb;
	v_lease uuid;
	v_job_id uuid;
	v_surface_row public.qorpera_surfaces%rowtype;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select count(*) into v_overload_count
	from pg_proc p
	where p.pronamespace = 'public'::regnamespace
		and p.proname in (
			'qorpera_create_surface',
			'qorpera_propose_surface',
			'qorpera_native_surface_propose',
			'qorpera_list_company_code_repositories',
			'qorpera_bind_surface_repository'
		);
	perform pg_temp.srsb_assert(v_overload_count = 5, 'Exactly one overload must exist for each PR 2 RPC');

	select environment_id, staff_agent_id into strict v_env_id, v_staff_id
	from public.qorpera_company_cofounders
	where profile_id = v_profile
	limit 1;

	insert into auth.users(id, email)
	values (v_member, 'member-934@example.test')
	on conflict (id) do nothing;
	insert into public.qorpera_profile_members(profile_id, user_id, email, role, display_name)
	values (v_profile, v_member, 'member-934@example.test', 'contributor', 'Regular Member')
	on conflict (profile_id, user_id) do update set role = 'contributor';

	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	v_web_app := public.qorpera_create_surface(
		v_profile, 'Web App', 'web-app', 'live_build', 'web_app', 'monitor', '#0a84ff', null, null, false,
		'Qorpera/Qorpera_Base', '/packages/web/', 'master'
	);
	v_web_app_id := (v_web_app ->> 'id')::uuid;
	perform pg_temp.srsb_assert(v_web_app ->> 'repositoryKey' = 'qorpera/qorpera_base', 'repositoryKey must normalize to lowercase');
	perform pg_temp.srsb_assert(v_web_app ->> 'repositorySubpath' = 'packages/web', 'repositorySubpath must trim leading/trailing slashes');
	perform pg_temp.srsb_assert(v_web_app ->> 'defaultBranch' = 'master', 'defaultBranch must persist master');

	v_studio_id := (public.qorpera_create_surface(
		v_profile, 'Brand Studio', 'brand-studio', 'studio', 'brand', 'palette', null, 'brand', null, false
	) ->> 'id')::uuid;

	v_archived_id := (public.qorpera_create_surface(
		v_profile, 'Old Site', 'old-site', 'live_build', 'website', 'globe', null, null, null, false
	) ->> 'id')::uuid;
	perform public.qorpera_archive_surface(v_archived_id);

	begin
		perform public.qorpera_create_surface(v_profile, 'Bad Key', null, 'live_build', 'web_app', 'monitor', null, null, null, false, 'bad/repo.git', null, 'main');
		perform pg_temp.srsb_assert(false, 'repositoryKey ending in .git must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '22023', 'Expected 22023 for invalid repositoryKey, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_create_surface(v_profile, 'Bad Subpath', null, 'live_build', 'web_app', 'monitor', null, null, null, false, 'qorpera/base', '../secret', 'main');
		perform pg_temp.srsb_assert(false, 'parent traversal repositorySubpath must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '22023', 'Expected 22023 for invalid repositorySubpath, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_create_surface(v_profile, 'Bad Branch', null, 'live_build', 'web_app', 'monitor', null, null, null, false, 'qorpera/base', 'apps/web', 'bad..branch');
		perform pg_temp.srsb_assert(false, 'invalid defaultBranch must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '22023', 'Expected 22023 for invalid defaultBranch, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_create_surface(v_profile, 'Studio With Repo', null, 'studio', 'custom', 'spark', null, null, null, false, 'qorpera/base', null, 'main');
		perform pg_temp.srsb_assert(false, 'studio surface with repositoryKey must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '22023', 'Expected 22023 for studio repositoryKey, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.as_service();
	v_proposed := public.qorpera_propose_surface(
		v_profile, 'marketing-site', 'Marketing Site', 'products', 'live_build', 'code_repo',
		'globe', 'Qorpera/Marketing', null, 'static_site', 'Public marketing site', 'website', null, false, true,
		'site/public', 'release/v2'
	);
	perform pg_temp.srsb_assert(v_proposed ->> 'repositoryKey' = 'qorpera/marketing', 'propose_surface must normalize repositoryKey');
	perform pg_temp.srsb_assert(v_proposed ->> 'repositorySubpath' = 'site/public', 'propose_surface must store repositorySubpath');
	perform pg_temp.srsb_assert(v_proposed ->> 'defaultBranch' = 'release/v2', 'propose_surface must store defaultBranch');

	v_native_proposed := public.qorpera_native_surface_propose(
		v_profile, 'admin-console', 'Admin Console', 'products', 'live_build', 'code_repo',
		'monitor', 'qorpera/qorpera_base', null, 'static_site', 'Admin UI', 'web_app', null, false, true,
		'packages/admin', 'main'
	);
	perform pg_temp.srsb_assert(v_native_proposed ->> 'repositorySubpath' = 'packages/admin', 'native_surface_propose must forward repositorySubpath');
	perform pg_temp.srsb_assert(v_native_proposed ->> 'defaultBranch' = 'main', 'native_surface_propose must forward defaultBranch');

	begin
		perform public.qorpera_propose_surface(
			v_profile, 'old-site', 'Old Site', 'products', 'live_build', 'code_repo',
			'globe', 'qorpera/old', null, 'static_site', null, 'website', null, false, true, null, 'main'
		);
		perform pg_temp.srsb_assert(false, 'propose_surface must still refuse archived slug');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '55000', 'Expected 55000 for archived slug proposal, got ' || v_errcode);
	end;

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_main, imported_from, imported_at)
	values
		(
			v_env_id, v_profile, 'qorpera', 'qorpera_base', repeat('a', 40),
			jsonb_build_object('kind', 'github', 'repository', 'Qorpera/Qorpera_Base', 'branch', 'master'),
			clock_timestamp()
		),
		(v_env_id, v_profile, 'surfaces', 'site-a', repeat('b', 40), null, null),
		(v_env_id, v_profile, 'qorpera', 'still_importing', null, null, null);

	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, by_user_id)
	values (
		v_env_id, 'qorpera', 'still_importing', v_profile, 'import',
		jsonb_build_object('from', jsonb_build_object('github', 'Qorpera/Still_Importing')),
		'running', 'member', v_owner
	);

	perform pg_temp.srsb_as(v_member);
	set local role authenticated;
	v_repos := public.qorpera_list_company_code_repositories(v_profile);
	perform pg_temp.srsb_assert(jsonb_array_length(v_repos) = 2, 'list_company_code_repositories must exclude in-progress imports');
	perform pg_temp.srsb_assert(v_repos -> 0 ->> 'repositoryKey' = 'qorpera/qorpera_base', 'non-surfaces repositories must sort ahead of surfaces/*');
	perform pg_temp.srsb_assert(v_repos -> 0 ->> 'sourceBranch' = 'master', 'imported GitHub branch must be exposed as sourceBranch');
	perform pg_temp.srsb_assert(v_repos -> 0 ->> 'sourceUrl' = 'https://github.com/Qorpera/Qorpera_Base', 'imported GitHub repo must expose sourceUrl');
	perform pg_temp.srsb_assert(v_repos -> 0 -> 'boundSurfaceSlugs' ? 'web-app', 'boundSurfaceSlugs must include web-app');
	perform pg_temp.srsb_assert(v_repos -> 0 -> 'boundSurfaceSlugs' ? 'admin-console', 'boundSurfaceSlugs must include admin-console');
	perform pg_temp.srsb_assert(v_repos -> 1 ->> 'repositoryKey' = 'surfaces/site-a', 'surfaces/* repository must follow user repositories');

	begin
		perform public.qorpera_bind_surface_repository(v_web_app_id, 'surfaces/site-a', null, 'main');
		perform pg_temp.srsb_assert(false, 'regular member must not be allowed to bind surface repository');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '42501', 'Expected 42501 for non-admin bind, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_bind_surface_repository(v_studio_id, 'qorpera/qorpera_base', null, 'main');
		perform pg_temp.srsb_assert(false, 'studio surface must reject repository binding');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '22023', 'Expected 22023 for studio bind, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_bind_surface_repository(v_archived_id, 'qorpera/qorpera_base', null, 'main');
		perform pg_temp.srsb_assert(false, 'archived surface must reject repository binding');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '55000', 'Expected 55000 for archived bind, got ' || v_errcode);
	end;
	reset role;

	update public.qorpera_surfaces
	set live_head_sha = repeat('1', 40), published_head_sha = repeat('1', 40), unpublished_change_count = 2
	where id = v_web_app_id;

	insert into public.qorpera_surface_previews(profile_id, surface_id, short_host_id, composition_key, base_sha, selected_change_ids, status, expires_at)
	values (v_profile, v_web_app_id, 'pr2test1', 'k1', repeat('1', 40), '{}'::uuid[], 'ready', clock_timestamp() + interval '30 minutes')
	returning id into v_preview_id;

	insert into public.qorpera_surface_sessions(profile_id, surface_id, title, prompt, origin_kind, state, base_sha)
	values (v_profile, v_web_app_id, 'Check layout', 'Check layout', 'member', 'ready', repeat('1', 40))
	returning id into v_session_id;

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, parent_sha, head_sha, status)
	values (v_profile, v_web_app_id, v_session_id, 1, 'Update nav', 'Nav update', 'git_range', repeat('1', 40), repeat('2', 40), 'staged')
	returning id into v_change_id;

	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_bind_surface_repository(v_web_app_id, 'surfaces/site-a', null, 'main');
		perform pg_temp.srsb_assert(false, 'switching repository with open git_range change must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '55000', 'Expected 55000 when switching repo with open change, got ' || v_errcode);
	end;

	v_bound := public.qorpera_bind_surface_repository(v_web_app_id, 'qorpera/qorpera_base', 'apps/console', 'master');
	perform pg_temp.srsb_assert(v_bound ->> 'repositorySubpath' = 'apps/console', 'updating subpath on same repo must succeed');
	perform pg_temp.srsb_assert(v_bound ->> 'defaultBranch' = 'master', 'branch must stay master');
	reset role;

	select * into strict v_surface_row from public.qorpera_surfaces where id = v_web_app_id;
	perform pg_temp.srsb_assert(v_surface_row.live_head_sha = repeat('1', 40), 'subpath-only update on same repo and branch must keep live_head_sha');
	select expires_at into v_preview_expires from public.qorpera_surface_previews where id = v_preview_id;
	perform pg_temp.srsb_assert(v_preview_expires <= clock_timestamp(), 'rebinding subpath must expire active previews');

	update public.qorpera_surface_sessions set state = 'running' where id = v_session_id;
	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_bind_surface_repository(v_web_app_id, 'qorpera/qorpera_base', 'packages/web', 'master');
		perform pg_temp.srsb_assert(false, 'binding while session is running must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '55000', 'Expected 55000 while session is running, got ' || v_errcode);
	end;
	reset role;

	update public.qorpera_surface_sessions set state = 'completed' where id = v_session_id;
	update public.qorpera_surface_changes set status = 'discarded', resolved_at = clock_timestamp() where id = v_change_id;

	insert into public.qorpera_surface_jobs(profile_id, surface_id, kind, status, payload)
	values (v_profile, v_web_app_id, 'publish_surface', 'queued', '{}'::jsonb)
	returning id into v_job_id;

	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_bind_surface_repository(v_web_app_id, 'surfaces/site-a', null, 'main');
		perform pg_temp.srsb_assert(false, 'binding while publish job is queued must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.srsb_assert(v_errcode = '55000', 'Expected 55000 while publish job is queued, got ' || v_errcode);
	end;
	reset role;

	update public.qorpera_surface_jobs set status = 'completed', completed_at = clock_timestamp() where id = v_job_id;

	perform pg_temp.srsb_as(v_owner);
	set local role authenticated;
	v_bound := public.qorpera_bind_surface_repository(v_web_app_id, 'surfaces/site-a', 'packages/site', 'develop');
	perform pg_temp.srsb_assert(v_bound ->> 'repositoryKey' = 'surfaces/site-a', 'switching repo after closing changes must succeed');
	perform pg_temp.srsb_assert(v_bound ->> 'repositorySubpath' = 'packages/site', 'subpath must update on repo switch');
	perform pg_temp.srsb_assert(v_bound ->> 'defaultBranch' = 'develop', 'defaultBranch must update on repo switch');
	reset role;

	select * into strict v_surface_row from public.qorpera_surfaces where id = v_web_app_id;
	perform pg_temp.srsb_assert(v_surface_row.live_head_sha is null, 'switching repo must clear live_head_sha');
	perform pg_temp.srsb_assert(v_surface_row.published_head_sha is null, 'switching repo must clear published_head_sha');
	perform pg_temp.srsb_assert(v_surface_row.unpublished_change_count = 0, 'switching repo must reset unpublished_change_count');

	perform pg_temp.as_service();
	v_senses := public.qorpera_surface_describe_company_senses(v_profile);
	perform pg_temp.srsb_assert(
		exists (
			select 1
			from jsonb_array_elements(v_senses -> 'surfaces') item
			where item ->> 'slug' = 'web-app'
				and item ->> 'repositoryKey' = 'surfaces/site-a'
				and item ->> 'repositorySubpath' = 'packages/site'
				and item ->> 'defaultBranch' = 'develop'
		),
		'describe_company_senses must include repositorySubpath and defaultBranch'
	);

	insert into public.qorpera_surface_sessions(profile_id, surface_id, title, prompt, origin_kind, state)
	values (v_profile, v_web_app_id, 'Turn projection check', 'Inspect subpath', 'member', 'queued')
	returning id into v_session_id;

	insert into public.qorpera_surface_previews(profile_id, surface_id, short_host_id, composition_key, base_sha, selected_change_ids, status, expires_at)
	values (v_profile, v_web_app_id, 'pr2test2', 'k2', repeat('2', 40), '{}'::uuid[], 'composing', clock_timestamp() + interval '30 minutes');

	insert into public.qorpera_surface_jobs(profile_id, surface_id, session_id, kind, status, payload)
	values
		(v_profile, v_web_app_id, v_session_id, 'land_change', 'queued', '{"changeIds":[]}'::jsonb),
		(v_profile, v_web_app_id, null, 'publish_surface', 'queued', '{}'::jsonb);

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'all');
	perform pg_temp.srsb_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'sessions') item
			where item ->> 'sessionId' = v_session_id::text
				and item ->> 'repositorySubpath' = 'packages/site'
				and item ->> 'defaultBranch' = 'develop'
		),
		'claimed sessions must include repositorySubpath and defaultBranch'
	);
	perform pg_temp.srsb_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'previews') item
			where item ->> 'surfaceId' = v_web_app_id::text
				and item ->> 'repositorySubpath' = 'packages/site'
				and item ->> 'defaultBranch' = 'develop'
		),
		'claimed previews must include repositorySubpath and defaultBranch'
	);
	perform pg_temp.srsb_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'merges') item
			where item ->> 'surfaceId' = v_web_app_id::text
				and item ->> 'repositorySubpath' = 'packages/site'
				and item ->> 'defaultBranch' = 'develop'
		),
		'claimed merges must include repositorySubpath and defaultBranch'
	);

	update public.qorpera_surface_jobs
	set status = 'completed', completed_at = clock_timestamp()
	where surface_id = v_web_app_id and kind = 'land_change' and status = 'running';

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	perform pg_temp.srsb_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'publishes') item
			where item ->> 'surfaceId' = v_web_app_id::text
				and item ->> 'repositorySubpath' = 'packages/site'
				and item ->> 'defaultBranch' = 'develop'
		),
		'claimed publishes must include repositorySubpath and defaultBranch'
	);

	select lease_token into strict v_lease from public.qorpera_surface_sessions where id = v_session_id;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session_id, v_lease);
	perform pg_temp.srsb_assert(v_turn ->> 'repositorySubpath' = 'packages/site', 'read_session_turn must include repositorySubpath');
	perform pg_temp.srsb_assert(v_turn ->> 'defaultBranch' = 'develop', 'read_session_turn must include defaultBranch');
end $$;
