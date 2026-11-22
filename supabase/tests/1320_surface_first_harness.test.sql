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
	v_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_list jsonb;
	v_created jsonb;
	v_surface_id uuid;
	v_site_id uuid;
	v_site_slug text;
	v_session jsonb;
	v_session_id uuid;
	v_claimed jsonb;
	v_completed jsonb;
	v_exploration jsonb;
	v_automations jsonb;
	v_due jsonb;
	v_host jsonb;
	v_workspace jsonb;
	v_checklist jsonb;
	v_senses jsonb;
	v_change_id uuid;
	v_approved jsonb;
	v_undone jsonb;
	v_published jsonb;
	v_refused boolean := false;
begin
	insert into auth.users(id, email) values (v_outsider, 'sf-outsider@example.test');

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
	perform pg_temp.sf_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_bootstrap_company_surfaces(v_profile);
	exception when others then
		v_refused := true;
	end;
	reset role;
	perform pg_temp.sf_assert(v_refused, 'viewer refused by qorpera_bootstrap_company_surfaces');

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_list := public.qorpera_bootstrap_company_surfaces(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_list) >= 6, 'bootstrap creates identity + 5 ops surfaces');
	perform pg_temp.sf_assert(
		exists (select 1 from public.qorpera_surfaces where profile_id = v_profile and slug = 'identity' and is_global),
		'bootstrap creates global identity surface'
	);

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_automations := public.qorpera_list_automations(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_automations) >= 1, 'bootstrap creates Co-Founder Pulse automation');

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

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs(16);
	reset role;
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
	v_completed := public.qorpera_surface_complete_session_turn(v_session_id, 'failed', 'Transient failure');
	reset role;
	perform pg_temp.sf_assert(v_completed ->> 'state' = 'queued', 'first failure auto-retries once back to queued');
	perform pg_temp.sf_assert(
		(select retry_count from public.qorpera_surface_sessions where id = v_session_id) = 1,
		'first failure increments retry_count to 1'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_completed := public.qorpera_surface_complete_session_turn(v_session_id, 'failed', 'Permanent failure');
	reset role;
	perform pg_temp.sf_assert(v_completed ->> 'state' = 'failed', 'second failure transitions to failed');

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
	perform pg_temp.sf_assert(
		(select count(*) from public.qorpera_surface_sessions where exploration_id = (v_exploration ->> 'explorationId')::uuid) = 3,
		'3-variant exploration spawns 3 parallel sessions'
	);

	update public.qorpera_surface_automations
	set next_run_at = clock_timestamp() - interval '1 minute'
	where profile_id = v_profile;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_due := public.qorpera_surface_claim_due_automations(16);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_due) >= 1, 'due surface automation is claimed and dispatched');

	update public.qorpera_site_settings set hosts_domain = 'qorpera.com';
	v_host := public.qorpera_site_host('look-shop--pab12cd34.qorpera.com');
	perform pg_temp.sf_assert(
		v_host = jsonb_build_object('slug', 'look-shop', 'scope', 'preview', 'previewId', 'ab12cd34'),
		'qorpera_site_host parses isolated preview host'
	);

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary,
		affected_paths, kind, status, head_sha
	)
	values (
		v_profile, v_surface_id, v_session_id, 1, 'Tighten hero spacing', 'Adjusted hero vertical rhythm',
		array['src/index.html'], 'git_range', 'staged', repeat('a', 40)
	)
	returning id into v_change_id;

	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_workspace := public.qorpera_get_surface_workspace(v_surface_id);
	v_checklist := public.qorpera_surface_migration_checklist(v_profile);
	perform public.qorpera_set_preview_selection(v_surface_id, array[v_change_id], null, '{}'::uuid[], '/');
	v_approved := public.qorpera_approve_surface_change(v_change_id, true);
	reset role;
	update public.qorpera_surface_changes set status = 'merged' where id = v_change_id;
	perform pg_temp.sf_as(v_owner);
	set local role authenticated;
	v_undone := public.qorpera_undo_surface_change(v_change_id);
	v_published := public.qorpera_publish_surface(v_surface_id);
	perform public.qorpera_reply_surface_session(v_session_id, 'Looks good, ship it', true);
	reset role;
	perform pg_temp.sf_assert(v_workspace -> 'surface' ->> 'id' = v_surface_id::text, 'get_surface_workspace returns surface');
	perform pg_temp.sf_assert(v_checklist ->> 'companyId' = v_profile::text, 'surface_migration_checklist returns companyId');
	perform pg_temp.sf_assert(v_approved is not null and v_undone is not null and v_published is not null, 'approve, undo, and publish RPCs succeed');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_senses := public.qorpera_surface_describe_company_senses(v_profile);
	reset role;
	perform pg_temp.sf_assert(jsonb_array_length(v_senses -> 'surfaces') >= 7, 'describe_company_senses lists seeded and created surfaces');
end $$;

rollback;
