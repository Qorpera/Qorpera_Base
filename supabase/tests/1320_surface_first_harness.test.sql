-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.sf_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception 'surface_first_harness: %', p_what;
	end if;
end $$;

create function pg_temp.sf_as(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_viewer constant uuid := '92400000-0000-4000-8000-000000000003';
	v_outsider constant uuid := '13200000-0000-4000-8000-000000000099';
	v_other_owner constant uuid := '13200000-0000-4000-8000-000000000098';
	v_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_env constant uuid := '92400000-0000-4000-8000-000000000020';
	v_other_profile constant uuid := '13200000-0000-4000-8000-000000000011';
	v_other_env constant uuid := '13200000-0000-4000-8000-000000000021';
	v_list jsonb;
	v_created jsonb;
	v_surface_id uuid;
	v_other_surface_id uuid;
	v_other_session_id uuid;
	v_other_change_id uuid;
	v_other_site_id uuid := '13200000-0000-4000-8000-000000000301';
	v_other_version_id uuid := '13200000-0000-4000-8000-000000000302';
	v_site_id uuid;
	v_site_slug text;
	v_preview_version_id uuid := '13200000-0000-4000-8000-000000000401';
	v_session jsonb;
	v_session_id uuid;
	v_session_lease uuid;
	v_reconcile_session_id uuid;
	v_reconcile_lease uuid;
	v_claimed jsonb;
	v_claimed2 jsonb;
	v_completed jsonb;
	v_renewed jsonb;
	v_exploration jsonb;
	v_exploration_id uuid;
	v_exp_winner_id uuid;
	v_exp_loser_id uuid;
	v_exp_w_c1 uuid;
	v_exp_w_c2 uuid;
	v_exp_w_c3 uuid;
	v_exp_w_manual_disc uuid;
	v_exp_l_c1 uuid;
	v_exp_l_manual_disc uuid;
	v_automations jsonb;
	v_auto_id uuid;
	v_legacy_routine_id uuid := '13200000-0000-4000-8000-000000000501';
	v_due jsonb;
	v_host jsonb;
	v_workspace jsonb;
	v_preview_state jsonb;
	v_preview_id uuid;
	v_preview_lease uuid;
	v_preview_host text;
	v_preview_pass text;
	v_redeemed jsonb;
	v_served jsonb;
	v_checklist jsonb;
	v_senses jsonb;
	v_change_id uuid;
	v_folder_surface_id uuid;
	v_folder_session_id uuid;
	v_folder_change_id uuid;
	v_batch_session_id uuid;
	v_batch_c1 uuid;
	v_batch_c2 uuid;
	v_batch_job_id uuid;
	v_batch_lease uuid;
	v_batch_undo_job_id uuid;
	v_batch_undo_lease uuid;
	v_batch_unpub_before integer;
	v_release_session_id uuid;
	v_release_lease uuid;
	v_released jsonb;
	v_merge_job_id uuid;
	v_merge_lease uuid;
	v_undo_job jsonb;
	v_publish_job_id uuid;
	v_publish_lease uuid;
	v_approved jsonb;
	v_undone jsonb;
	v_published jsonb;
	v_preview_count_before integer;
	v_preview_count_after integer;
	v_refused boolean;
	v_errcode text;
begin
	insert into auth.users(id, email) values
		(v_outsider, 'sf-outsider@example.test'),
		(v_other_owner, 'sf-other-owner@example.test');

	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values (v_other_profile, 'Other Company', v_other_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_other_profile, v_other_owner, 'sf-other-owner@example.test', 'Other Owner', 'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_other_env, v_other_profile, 'Other Env', 1, v_other_owner);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform pg_temp.sf_assert(public.qorpera_surfaces_enabled() is false, 'qorpera_surfaces_enabled defaults to false');
	v_errcode := null;
	begin
		perform public.qorpera_bootstrap_company_surfaces(v_profile);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '0A000', 'mutating member RPC refuses with 0A000 while surfaces are disabled');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_errcode := null;
	begin
		perform public.qorpera_create_surface(v_profile, 'Disabled Site', 'disabled-site', 'live_build');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '0A000', 'qorpera_create_surface refuses with 0A000 while surfaces are disabled');

	perform pg_temp.sf_assert(
		not exists (select 1 from public.qorpera_surfaces where profile_id = v_profile),
		'Day-0 cofounder trigger does not bootstrap surfaces while disabled'
	);

	update public.qorpera_surface_settings set enabled = true where singleton = true;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform pg_temp.sf_assert(public.qorpera_surfaces_enabled() is true, 'qorpera_surfaces_enabled reflects enabled switch');
	reset role;

	v_refused := false;
	perform pg_temp.sf_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_list_surfaces(v_profile);
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'outsider refused by qorpera_list_surfaces');

	v_refused := false;
	perform pg_temp.sf_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_create_surface(v_profile, 'Blocked', 'blocked', 'live_build');
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'outsider refused by qorpera_create_surface');

	v_refused := false;
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_bootstrap_company_surfaces(v_profile);
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_bootstrap_company_surfaces');

	v_refused := false;
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_create_surface(v_profile, 'Viewer Site', 'viewer-site', 'live_build');
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_create_surface');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_list := public.qorpera_bootstrap_company_surfaces(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_list) >= 6, 'bootstrap creates identity + 5 ops surfaces');
	perform pg_temp.sf_assert(
		exists (select 1 from public.qorpera_surfaces where profile_id = v_profile and slug = 'identity' and is_global),
		'bootstrap creates global identity surface'
	);
	select id into v_folder_surface_id from public.qorpera_surfaces where profile_id = v_profile and slug = 'identity';

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_automations := public.qorpera_list_automations(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_automations) >= 1, 'bootstrap creates Co-Founder Pulse automation');
	v_auto_id := (v_automations -> 0 ->> 'id')::uuid;

	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	v_refused := false;
	begin
		perform public.qorpera_toggle_automation(v_auto_id, false);
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_toggle_automation');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_toggle_automation(v_auto_id, false);
	perform public.qorpera_toggle_automation(v_auto_id, true);
	reset role;

	insert into public.qorpera_cloud_routines(
		id, profile_id, environment_id, client_routine_id, status, current_version, created_by_user_id
	)
	values (v_legacy_routine_id, v_profile, v_env, '13200000-0000-4000-8000-000000000502', 'paused', 1, v_owner);
	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_toggle_automation(v_legacy_routine_id, true);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'qorpera_toggle_automation refuses legacy cloud routines with 42501');
	perform pg_temp.sf_assert(
		(select status from public.qorpera_cloud_routines where id = v_legacy_routine_id) = 'paused',
		'legacy cloud routine remains paused after refused toggle'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_created := public.qorpera_create_surface(
		v_profile,
		'Marketing Website',
		'website',
		'live_build',
		'website',
		'globe',
		'#0f172a',
		null,
		'Primary storefront',
		false
	);
	reset role;
	v_surface_id := (v_created ->> 'id')::uuid;
	select site_id into v_site_id from public.qorpera_surfaces where id = v_surface_id;
	perform pg_temp.sf_assert(v_site_id is not null, 'live_build surface ensures a backing qorpera_company_sites row');
	select slug into v_site_slug from public.qorpera_company_sites where id = v_site_id;
	perform pg_temp.sf_assert(public.qorpera_site_slug_valid(v_site_slug), 'ensured site slug passes qorpera_site_slug_valid');
	perform pg_temp.sf_assert(
		exists (select 1 from public.qorpera_company_site_secrets where site_id = v_site_id),
		'live_build surface ensures a qorpera_company_site_secrets row'
	);

	perform pg_temp.sf_as(v_other_owner);
	set local role authenticated;
	v_other_surface_id := (
		public.qorpera_create_surface(v_other_profile, 'Other Site', 'other-site', 'live_build') ->> 'id'
	)::uuid;
	v_other_session_id := (
		public.qorpera_start_surface_session(v_other_surface_id, 'Other company task', 'Other task') ->> 'id'
	)::uuid;
	reset role;
	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary,
		affected_paths, kind, status, parent_sha, head_sha
	)
	values (
		v_other_profile, v_other_surface_id, v_other_session_id, 1, 'Other company change', 'Secret',
		array['secret.html'], 'git_range', 'staged', repeat('1', 40), repeat('2', 40)
	)
	returning id into v_other_change_id;

	v_refused := false;
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_start_surface_session(v_surface_id, 'Viewer cannot start');
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_start_surface_session');

	v_refused := false;
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_publish_surface(v_surface_id);
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_publish_surface');

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_start_surface_session(v_surface_id, 'Spoofed cofounder', 'Spoof', 'cofounder');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '22023', 'member cannot spoof cofounder origin_kind');

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_start_surface_session(v_surface_id, 'Spoofed automation', 'Spoof', 'automation');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '22023', 'member cannot spoof automation origin_kind');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_session := public.qorpera_start_surface_session(
		v_surface_id,
		'Refresh hero typography and CTA contrast',
		'Hero polish'
	);
	reset role;
	v_session_id := (v_session ->> 'id')::uuid;
	perform pg_temp.sf_assert(v_session_id is not null, 'start_surface_session creates session');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_session_turn(v_session_id, 'ready', 'Premature');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_session_turn rejects queued session');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_session_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where elem ->> 'sessionId' = v_session_id::text;
	perform pg_temp.sf_assert(v_session_lease is not null, 'claim_pending_jobs returns leaseToken for claimed session');
	perform pg_temp.sf_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'sessions') elem
			where elem ->> 'sessionId' = v_session_id::text
				and elem ->> 'surfaceSlug' = 'website'
				and elem ->> 'siteSlug' = v_site_slug
				and (elem ->> 'retryCount')::integer = 0
		),
		'claim_pending_jobs returns enriched queued surface session'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_renewed := public.qorpera_surface_renew_lease('session', v_session_id, v_session_lease, 300);
	reset role;
	perform pg_temp.sf_assert((v_renewed ->> 'renewed')::boolean is true, 'renew_lease extends active session lease');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_renewed := public.qorpera_surface_renew_lease('session', v_session_id, '13200000-0000-4000-8000-000000000999', 300);
	reset role;
	perform pg_temp.sf_assert((v_renewed ->> 'renewed')::boolean is false, 'renew_lease ignores mismatched lease token');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_session_turn(
			v_session_id, 'ready', 'Wrong lease', null, null, null, '13200000-0000-4000-8000-000000000999'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_session_turn rejects wrong lease_token');

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '1 minute'
	where id = v_session_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	perform pg_temp.sf_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed -> 'sessions') elem
			where elem ->> 'sessionId' = v_session_id::text
				and (elem ->> 'retryCount')::integer = 1
				and (elem ->> 'leaseToken')::uuid <> v_session_lease
		),
		'expired running session is reclaimed through retry path with fresh leaseToken'
	);
	select (elem ->> 'leaseToken')::uuid into v_session_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where elem ->> 'sessionId' = v_session_id::text;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_completed := public.qorpera_surface_complete_session_turn(
		v_session_id, 'failed', 'Permanent failure', null, null, null, v_session_lease
	);
	reset role;
	perform pg_temp.sf_assert(v_completed ->> 'state' = 'failed', 'second failure transitions to failed');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_session_turn(
			v_session_id, 'ready', 'Late retry', null, null, null, v_session_lease
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_session_turn rejects non-running failed session');

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary,
		affected_paths, kind, status, parent_sha, head_sha
	)
	values (
		v_profile, v_surface_id, v_session_id, 1, 'Tighten hero spacing', 'Adjusted hero vertical rhythm',
		array['src/index.html'], 'git_range', 'staged', repeat('9', 40), repeat('a', 40)
	)
	returning id into v_change_id;

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_reconcile_surface_changes(v_surface_id, array[v_other_change_id]);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'reconcile_surface_changes rejects foreign change id');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_reconcile_session_id := (
		public.qorpera_reconcile_surface_changes(v_surface_id, array[v_change_id]) ->> 'id'
	)::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	v_claimed2 := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_reconcile_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where elem ->> 'sessionId' = v_reconcile_session_id::text;
	perform pg_temp.sf_assert(v_reconcile_lease is not null, 'reconciling session is claimed once');
	perform pg_temp.sf_assert(
		(select state from public.qorpera_surface_sessions where id = v_reconcile_session_id) = 'reconciling_running',
		'claimed reconciling session transitions to reconciling_running'
	);
	perform pg_temp.sf_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed2 -> 'sessions') elem
			where elem ->> 'sessionId' = v_reconcile_session_id::text
		),
		'second claim cannot double-claim active reconciling_running session'
	);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(
		v_reconcile_session_id, 'ready', 'Reconciled', null, null, null, v_reconcile_lease
	);
	reset role;

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_set_preview_selection(v_surface_id, array[v_other_change_id], null, '{}'::uuid[], '/');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'set_preview_selection rejects foreign change id');

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_set_preview_selection(v_surface_id, '{}'::uuid[], v_other_session_id, '{}'::uuid[], '/');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'set_preview_selection rejects foreign exploration session id');

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_set_preview_selection(v_surface_id, '{}'::uuid[], null, array[v_other_session_id], '/');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'set_preview_selection rejects foreign compare session id');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_exploration := public.qorpera_start_surface_session(
		v_surface_id,
		'Explore 3 hero directions',
		null,
		'member',
		null,
		null,
		3,
		'Hero directions',
		array['Warm Nordic', 'Editorial Minimal', 'Bold Contrast']
	);
	reset role;
	v_exploration_id := (v_exploration ->> 'explorationId')::uuid;
	perform pg_temp.sf_assert(
		(select count(*) from public.qorpera_surface_sessions where exploration_id = v_exploration_id) = 3,
		'3-variant exploration spawns 3 parallel sessions'
	);
	perform pg_temp.sf_assert(
		(select owner_label from public.qorpera_surface_explorations where id = v_exploration_id) = 'Member',
		'member exploration defaults owner_label to Member instead of Co-Founder'
	);

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_choose_exploration(v_exploration_id, v_session_id);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'choose_exploration rejects session not belonging to exploration');

	select id into v_exp_winner_id from public.qorpera_surface_sessions
	where exploration_id = v_exploration_id order by created_at asc limit 1;
	select id into v_exp_loser_id from public.qorpera_surface_sessions
	where exploration_id = v_exploration_id and id <> v_exp_winner_id order by created_at asc limit 1;

	update public.qorpera_surface_sessions set state = 'ready' where exploration_id = v_exploration_id;

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_winner_id, 1, 'Winner C1', 'First', 'folder_patch', 'staged')
	returning id into v_exp_w_c1;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_winner_id, 2, 'Winner C2', 'Second', 'folder_patch', 'staged')
	returning id into v_exp_w_c2;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_winner_id, 3, 'Winner C3 merging', 'In-flight', 'folder_patch', 'merging')
	returning id into v_exp_w_c3;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_winner_id, 4, 'Winner manually discarded', 'Manual', 'folder_patch', 'discarded')
	returning id into v_exp_w_manual_disc;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_loser_id, 1, 'Loser C1', 'Alt', 'folder_patch', 'staged')
	returning id into v_exp_l_c1;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_profile, v_surface_id, v_exp_loser_id, 2, 'Loser manually discarded', 'Manual', 'folder_patch', 'discarded')
	returning id into v_exp_l_manual_disc;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_choose_exploration(v_exploration_id, v_exp_winner_id);
	reset role;

	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_exp_w_c1) = 'merged'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_c2) = 'merged'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_c3) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_manual_disc) = 'discarded'
		and (select discarded_by_exploration from public.qorpera_surface_changes where id = v_exp_l_c1) is true
		and (select discarded_by_exploration from public.qorpera_surface_changes where id = v_exp_l_manual_disc) is false,
		'choose_exploration merges winner open changes and tags only exploration-discarded loser rows'
	);

	v_errcode := null;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_undo_surface_change(v_exp_l_c1);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '22023', 'undoing a discarded loser change is refused while winner is landed');
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_explorations where id = v_exploration_id) = 'chosen'
		and (select status from public.qorpera_surface_changes where id = v_exp_l_c1) = 'discarded',
		'refused loser undo leaves exploration chosen and loser change discarded'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_exp_w_c1);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_exp_w_c1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_c2) = 'merged'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_c3) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_exp_w_manual_disc) = 'discarded'
		and (select status from public.qorpera_surface_changes where id = v_exp_l_c1) = 'discarded'
		and (select status from public.qorpera_surface_changes where id = v_exp_l_manual_disc) = 'discarded'
		and (select status from public.qorpera_surface_explorations where id = v_exploration_id) = 'chosen'
		and (select chosen_session_id from public.qorpera_surface_explorations where id = v_exploration_id) = v_exp_winner_id,
		'undoing one winner change keeps exploration chosen while other winner changes remain merged or merging'
	);

	update public.qorpera_surface_changes set status = 'discarded' where id = v_exp_w_c3;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_exp_w_c2);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_explorations where id = v_exploration_id) = 'open'
		and (select chosen_session_id from public.qorpera_surface_explorations where id = v_exploration_id) is null
		and (select status from public.qorpera_surface_changes where id = v_exp_l_c1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_exp_l_manual_disc) = 'discarded',
		'after all winner changes are undone, exploration reopens and only exploration-discarded sibling changes restore'
	);

	update public.qorpera_surface_automations
	set next_run_at = clock_timestamp() - interval '1 minute'
	where profile_id = v_profile;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_due := public.qorpera_surface_claim_due_automations(16);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_due) >= 1, 'due surface automation is claimed and dispatched');

	select count(*)::integer into v_preview_count_before from public.qorpera_surface_previews where surface_id = v_surface_id;
	insert into public.qorpera_member_surface_state(user_id, surface_id, toggled_change_ids)
	values (v_viewer, v_surface_id, array[v_change_id])
	on conflict (user_id, surface_id) do update set toggled_change_ids = excluded.toggled_change_ids;

	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	v_workspace := public.qorpera_get_surface_workspace(v_surface_id);
	reset role;
	select count(*)::integer into v_preview_count_after from public.qorpera_surface_previews where surface_id = v_surface_id;
	perform pg_temp.sf_assert(v_preview_count_after = v_preview_count_before, 'viewer get_surface_workspace does not insert preview rows');
	perform pg_temp.sf_assert(v_workspace -> 'surface' ->> 'id' = v_surface_id::text, 'get_surface_workspace returns surface');

	update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.com';
	update public.qorpera_site_settings set hosts_enabled = true;
	v_host := public.qorpera_site_host('look-shop--pab12cd34.qorpera.com');
	perform pg_temp.sf_assert(
		v_host = jsonb_build_object('slug', 'look-shop', 'scope', 'preview', 'previewId', 'ab12cd34'),
		'qorpera_site_host parses isolated preview host'
	);

	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (v_other_site_id, v_other_profile, v_other_env, 'other-preview-site', 'Other', 'web', '92400000-0000-4000-8000-000000000030');
	insert into public.qorpera_company_site_versions(
		id, site_id, run_id, call_id, staff_agent_id, first_publish, source_path,
		manifest_sha256, file_count, total_bytes, state, published_at
	)
	values
		(
			v_other_version_id, v_other_site_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
			'sf-other-v1', '92400000-0000-4000-8000-000000000030', true, 'web', repeat('b', 64), 1, 16, 'live', clock_timestamp()
		),
		(
			v_preview_version_id, v_site_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
			'sf-preview-v1', '92400000-0000-4000-8000-000000000030', true, 'surfaces/website', repeat('c', 64), 1, 16, 'live', clock_timestamp()
		);
	insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content)
	values (
		v_preview_version_id, 'index.html', 16, encode(extensions.digest('<h1>Preview</h1>', 'sha256'), 'hex'),
		'text/html; charset=utf-8', convert_to('<h1>Preview</h1>', 'utf8')
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_preview_state := public.qorpera_set_preview_selection(v_surface_id, array[v_change_id], null, '{}'::uuid[], '/');
	reset role;
	v_preview_id := (v_preview_state -> 'primary' ->> 'previewId')::uuid;
	perform pg_temp.sf_assert(v_preview_id is not null, 'set_preview_selection creates composing preview');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_preview_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem
	where elem ->> 'previewId' = v_preview_id::text;
	perform pg_temp.sf_assert(v_preview_lease is not null, 'preview claim returns leaseToken');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_preview(
			v_preview_id, 'ready', repeat('d', 40), v_other_version_id, null, null, v_preview_lease
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'complete_preview rejects site_version_id from another site');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_preview(
			v_preview_id, 'ready', repeat('d', 40), v_preview_version_id, null, null, '13200000-0000-4000-8000-000000000999'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_preview rejects mismatched lease_token');

	v_errcode := null;
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_mint_surface_preview_pass(v_preview_id);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'mint_surface_preview_pass refuses non-ready preview');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_preview(
		v_preview_id, 'ready', repeat('d', 40), v_preview_version_id, null, null, v_preview_lease
	);
	reset role;

	v_errcode := null;
	perform pg_temp.sf_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_mint_surface_preview_pass(v_preview_id);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '42501', 'outsider refused by qorpera_mint_surface_preview_pass');

	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	v_preview_state := public.qorpera_mint_surface_preview_pass(v_preview_id);
	reset role;
	v_preview_pass := v_preview_state ->> 'memberPass';
	v_preview_host := v_site_slug || '--p' || (select short_host_id from public.qorpera_surface_previews where id = v_preview_id) || '.qorpera.com';
	perform pg_temp.sf_assert(
		v_preview_pass is not null and v_preview_state ->> 'doorActionUrl' = 'https://' || v_preview_host || '/__qorpera/member',
		'viewer mints one-use memberPass for ready preview via qorpera_mint_surface_preview_pass'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_served := public.qorpera_site_serve_host(v_preview_host, '/', null, null, null, null);
	perform pg_temp.sf_assert(v_served ->> 'state' = 'locked' and v_served ->> 'scope' = 'preview', 'preview host is locked without member token');

	v_redeemed := public.qorpera_site_member_pass_redeem(v_preview_host, v_preview_pass);
	perform pg_temp.sf_assert(v_redeemed ->> 'state' = 'open' and v_redeemed ->> 'token' is not null, 'qorpera_site_member_pass_redeem opens session on --p preview host');
	perform pg_temp.sf_assert(
		(public.qorpera_site_member_pass_redeem(v_preview_host, v_preview_pass) ->> 'state') = 'refused',
		'preview member pass is single-use'
	);

	v_served := public.qorpera_site_serve_host(v_preview_host, '/', v_redeemed ->> 'token', null, null, null);
	perform pg_temp.sf_assert(v_served ->> 'state' = 'file' and v_served ->> 'path' = 'index.html', 'qorpera_site_serve_host serves preview file with redeemed member token');

	v_served := public.qorpera_site_serve_host(v_site_slug || '--p00000000.qorpera.com', '/', v_redeemed ->> 'token', null, null, null);
	perform pg_temp.sf_assert(v_served ->> 'state' = 'locked', 'preview session token is bound strictly to its --p host');
	reset role;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_folder_session_id := (
		public.qorpera_start_surface_session(v_folder_surface_id, 'Update identity accent', 'Accent update') ->> 'id'
	)::uuid;
	reset role;
	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary,
		affected_paths, kind, status, patch_manifest
	)
	values (
		v_profile, v_folder_surface_id, v_folder_session_id, 1, 'Update accent', 'Brand token update',
		array['identity/tokens.json'], 'folder_patch', 'staged',
		'[{"op":"merge_json","path":"identity/tokens.json","patch":{"colors":{"accent":"#d76f45"}}}]'::jsonb
	)
	returning id into v_folder_change_id;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_approved := public.qorpera_approve_surface_change(v_folder_change_id, true);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_folder_change_id) = 'merging',
		'approving folder_patch transitions change to merging and queues land_change job'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into v_merge_job_id, v_merge_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where elem ->> 'kind' = 'land_change' and elem ->> 'surfaceId' = v_folder_surface_id::text;
	perform pg_temp.sf_assert(v_merge_job_id is not null and v_merge_lease is not null, 'land_change job is claimed with leaseToken');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_merge(
			v_merge_job_id, 'landed', repeat('1', 64), repeat('2', 64), null, null, null, null, '13200000-0000-4000-8000-000000000999'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_merge rejects mismatched lease_token');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_merge_job_id, 'landed', repeat('1', 64), repeat('2', 64), null, null, null,
		jsonb_build_object('snapshotId', repeat('1', 64), 'folderRoot', 'identity', 'filesBefore', jsonb_build_object('identity/tokens.json', '{}')),
		v_merge_lease
	);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_folder_change_id) = 'merged',
		'complete_merge transitions change to merged'
	);

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_merge(
			v_merge_job_id, 'landed', repeat('1', 64), repeat('2', 64), null, null, null, null, v_merge_lease
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_merge rejects already completed job');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_undone := public.qorpera_undo_surface_change(v_folder_change_id);
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select elem into v_undo_job
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where elem ->> 'kind' = 'undo_change' and elem ->> 'surfaceId' = v_folder_surface_id::text;
	perform pg_temp.sf_assert(
		v_undo_job -> 'preMergeSnapshot' ->> 'snapshotId' = repeat('1', 64),
		'undo_change claim includes durable preMergeSnapshot from database'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_published := public.qorpera_publish_surface(v_surface_id);
	reset role;
	perform pg_temp.sf_assert(v_published ->> 'publishStatus' = 'publishing', 'publish_surface queues publish job for code_repo surface');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into v_publish_job_id, v_publish_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where elem ->> 'surfaceId' = v_surface_id::text;
	perform pg_temp.sf_assert(v_publish_job_id is not null and v_publish_lease is not null, 'publish_surface job is claimed with leaseToken');

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_complete_publish(
			v_publish_job_id, 'published', repeat('e', 40), null, '13200000-0000-4000-8000-000000000999'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'complete_publish rejects mismatched lease_token');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_publish(
		v_publish_job_id, 'published', repeat('e', 40), null, v_publish_lease
	);
	reset role;
	perform pg_temp.sf_assert(
		(select publish_status from public.qorpera_surfaces where id = v_surface_id) = 'idle'
		and (select published_head_sha from public.qorpera_surfaces where id = v_surface_id) = repeat('e', 40),
		'complete_publish marks surface idle with updated published_head_sha'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_checklist := public.qorpera_surface_migration_checklist(v_profile);
	perform public.qorpera_reply_surface_session(v_session_id, 'Looks good, ship it', true);
	reset role;
	perform pg_temp.sf_assert(v_checklist ->> 'companyId' = v_profile::text, 'surface_migration_checklist returns companyId');
	perform pg_temp.sf_assert(
		(select retry_count from public.qorpera_surface_sessions where id = v_session_id) = 0,
		'reply_surface_session resets retry_count for fresh turn'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_senses := public.qorpera_surface_describe_company_senses(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_senses -> 'surfaces') >= 7, 'describe_company_senses lists seeded and created surfaces');

	select coalesce(unpublished_change_count, 0) into v_batch_unpub_before
	from public.qorpera_surfaces where id = v_folder_surface_id;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_session := public.qorpera_start_surface_session(v_folder_surface_id, 'Batch folder edits', 'Batch test', 'member', null, null, null, null, null);
	reset role;
	v_batch_session_id := (v_session ->> 'id')::uuid;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_batch_c1 := (public.qorpera_record_surface_change(
		v_batch_session_id, 'Batch A', 'Update tokens', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/tokens.json'], null,
		'[{"op":"merge_json","path":"identity/tokens.json","patch":{"accent":"#445566"}}]'::jsonb,
		false
	) ->> 'changeId')::uuid;
	v_batch_c2 := (public.qorpera_record_surface_change(
		v_batch_session_id, 'Batch B', 'Update voice', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/voice.md'], null,
		'[{"op":"write_text","path":"identity/voice.md","content":"Calm voice\n"}]'::jsonb,
		true
	) ->> 'changeId')::uuid;
	reset role;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_session_all(v_batch_session_id);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into v_batch_job_id, v_batch_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where elem ->> 'kind' = 'land_change' and elem ->> 'sessionId' = v_batch_session_id::text;
	perform pg_temp.sf_assert(v_batch_job_id is not null, 'approve_session_all queued batch land_change job');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_batch_job_id,
		'landed',
		repeat('a', 64),
		repeat('b', 64),
		null,
		null,
		null,
		jsonb_build_object(
			'snapshotId', repeat('a', 64),
			'folderRoot', 'identity',
			'changeIds', jsonb_build_array(v_batch_c1::text, v_batch_c2::text),
			'filesBefore', jsonb_build_object('identity/tokens.json', '{}', 'identity/voice.md', 'Old')
		),
		v_batch_lease
	);
	reset role;

	perform pg_temp.sf_assert(
		(select unpublished_change_count from public.qorpera_surfaces where id = v_folder_surface_id) = v_batch_unpub_before + 2,
		'batch folder landing incremented unpublished_change_count by 2'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_workspace := public.qorpera_get_surface_workspace(v_folder_surface_id);
	reset role;
	perform pg_temp.sf_assert(
		exists (
			select 1
			from jsonb_array_elements(v_workspace -> 'recentHistory') sess,
				jsonb_array_elements(sess -> 'changes') ch
			where ch ->> 'id' = v_batch_c1::text and (ch ->> 'undoBatchSize')::integer = 2
		),
		'merged batch folder change exposes undoBatchSize = 2'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_undone := public.qorpera_undo_surface_change(v_batch_c1);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_batch_c1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_batch_c2) = 'staged'
		and (select unpublished_change_count from public.qorpera_surfaces where id = v_folder_surface_id) = v_batch_unpub_before,
		'undoing one change in a folder batch resets every change in the batch and decrements unpublished_change_count by batch size'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	select elem, (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into v_undo_job, v_batch_undo_job_id, v_batch_undo_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where elem ->> 'kind' = 'undo_change' and elem ->> 'sessionId' = v_batch_session_id::text;
	perform pg_temp.sf_assert(
		jsonb_array_length(v_undo_job -> 'payload' -> 'changeIds') = 2,
		'folder batch undo_change payload carries all batch changeIds'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_batch_undo_job_id,
		'conflicted',
		null,
		null,
		v_batch_c1,
		array['identity/tokens.json'],
		'Conflicted paths: identity/tokens.json',
		null,
		v_batch_undo_lease
	);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_batch_c1) = 'merged'
		and (select status from public.qorpera_surface_changes where id = v_batch_c2) = 'merged'
		and (select unpublished_change_count from public.qorpera_surfaces where id = v_folder_surface_id) = v_batch_unpub_before + 2,
		'conflicted folder undo restores batch changes to merged and restores unpublished_change_count'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_batch_c1);
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into v_batch_undo_job_id, v_batch_undo_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where elem ->> 'kind' = 'undo_change' and elem ->> 'sessionId' = v_batch_session_id::text;
	perform pg_temp.sf_assert(v_batch_undo_job_id is not null, 'claimed second batch undo job');

	update public.qorpera_surface_jobs
	set lease_expires_at = clock_timestamp() - interval '1 minute'
	where id = v_batch_undo_job_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_batch_undo_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'jobId')::uuid = v_batch_undo_job_id;
	perform pg_temp.sf_assert(v_batch_undo_lease is not null, 'expired undo_change attempt 1 is requeued and reclaimed');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_batch_undo_job_id,
		'landed',
		repeat('b', 64),
		repeat('a', 64),
		null,
		null,
		null,
		null,
		v_batch_undo_lease
	);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_changes where id = v_batch_c1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_batch_c2) = 'staged'
		and (select unpublished_change_count from public.qorpera_surfaces where id = v_folder_surface_id) = v_batch_unpub_before,
		'retried undo_change completing landed keeps batch staged and unpublished_change_count aligned'
	);

	update public.qorpera_surface_jobs
	set status = 'running', attempts = 3, lease_expires_at = clock_timestamp() - interval '1 minute', lease_token = gen_random_uuid()
	where id = v_batch_undo_job_id;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	perform pg_temp.sf_assert(
		(select status from public.qorpera_surface_jobs where id = v_batch_undo_job_id) = 'failed'
		and (select status from public.qorpera_surface_changes where id = v_batch_c1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_batch_c2) = 'staged'
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_batch_session_id
				and m.author_kind = 'system'
				and m.body like 'Rollback worker lease expired%'
		),
		'expired undo_change at max attempts marks job failed, records a system message, and leaves staged changes intact'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_session := public.qorpera_start_surface_session(v_folder_surface_id, 'Capacity test', 'Release claim test', 'member', null, null, null, null, null);
	reset role;
	v_release_session_id := (v_session ->> 'id')::uuid;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_release_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where elem ->> 'sessionId' = v_release_session_id::text;
	perform pg_temp.sf_assert(
		v_release_lease is not null
		and (select state from public.qorpera_surface_sessions where id = v_release_session_id) = 'running'
		and (select retry_count from public.qorpera_surface_sessions where id = v_release_session_id) = 0,
		'session claimed before release test'
	);

	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_surface_release_session_claim(v_release_session_id, gen_random_uuid());
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.sf_assert(v_errcode = '55000', 'release_session_claim rejects mismatched lease token');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_released := public.qorpera_surface_release_session_claim(v_release_session_id, v_release_lease);
	reset role;
	perform pg_temp.sf_assert(
		(v_released ->> 'released')::boolean = true
		and (v_released ->> 'state') = 'queued'
		and (v_released ->> 'retryAfterAt') is not null
		and (select state from public.qorpera_surface_sessions where id = v_release_session_id) = 'queued'
		and (select lease_token from public.qorpera_surface_sessions where id = v_release_session_id) is null
		and (select lease_expires_at from public.qorpera_surface_sessions where id = v_release_session_id) > clock_timestamp()
		and (select retry_count from public.qorpera_surface_sessions where id = v_release_session_id) = 0,
		'release_session_claim returns running session to queued with backoff without incrementing retry_count'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed2 := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	perform pg_temp.sf_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed2 -> 'sessions') elem
			where elem ->> 'sessionId' = v_release_session_id::text
		),
		'released session is not immediately reclaimed during backoff window'
	);

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '1 second'
	where id = v_release_session_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed2 := public.qorpera_surface_claim_pending_jobs(32);
	reset role;
	perform pg_temp.sf_assert(
		exists (
			select 1 from jsonb_array_elements(v_claimed2 -> 'sessions') elem
			where elem ->> 'sessionId' = v_release_session_id::text
		)
		and (select retry_count from public.qorpera_surface_sessions where id = v_release_session_id) = 0,
		'released session is reclaimable after backoff elapses with retry_count still 0'
	);
end $$;

rollback;
