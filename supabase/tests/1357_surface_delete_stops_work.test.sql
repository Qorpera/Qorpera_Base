-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sdel_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_delete_stops_work: %', p_message;
	end if;
end $$;

create function pg_temp.sdel_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sdel_delete(p_user uuid, p_surface uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.sdel_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_archive_surface(p_surface);
	reset role;
	return v_result;
end $$;

create function pg_temp.sdel_refused(p_user uuid, p_sql text, p_state text, p_message text default null)
returns void language plpgsql as $$
begin
	if p_user is null then
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
	else
		perform pg_temp.sdel_as(p_user);
		set local role authenticated;
	end if;
	begin
		execute p_sql;
	exception when others then
		reset role;
		if sqlstate is distinct from p_state or (p_message is not null and sqlerrm is distinct from p_message) then
			raise exception 'surface_delete_stops_work: expected % %, got % (%) from %',
				p_state, coalesce(p_message, ''), sqlstate, sqlerrm, p_sql;
		end if;
		return;
	end;
	reset role;
	raise exception 'surface_delete_stops_work: expected % from %', p_state, p_sql;
end $$;

create function pg_temp.sdel_turn(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	v_enq := public.qorpera_surface_enqueue_session_run(p_session, v_lease);
	reset role;
	if v_enq ->> 'status' <> 'enqueued' then
		raise exception 'surface_delete_stops_work: enqueue failed: %', v_enq;
	end if;
	return v_enq;
end $$;

create function pg_temp.sdel_trigger(p_automation uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_trigger_automation(p_automation);
	reset role;
	return v_result;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_vic constant uuid := '13570000-0000-4000-8000-000000000003';
	v_out constant uuid := '13570000-0000-4000-8000-000000000004';
	v_other_owner constant uuid := '13570000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13570000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13570000-0000-4000-8000-000000000021';
	v_job_queued constant uuid := '13570000-0000-4000-8000-000000000031';
	v_job_running constant uuid := '13570000-0000-4000-8000-000000000032';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_site uuid;
	v_note uuid;
	v_keep uuid;
	v_money uuid;
	v_proposed uuid;
	v_code_session uuid;
	v_note_session uuid;
	v_variant uuid;
	v_exploration uuid;
	v_waiting uuid;
	v_done uuid;
	v_kept uuid;
	v_worker uuid;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_enq jsonb;
	v_result jsonb;
	v_auto_site uuid;
	v_auto_note uuid;
	v_auto_keep uuid;
	v_auto_free uuid;
	v_auto_money uuid;
	v_auto_late uuid;
	v_errcode text;
	v_count integer;
	v_site_row uuid;
	v_site_slug text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	-- WHY: Exercise the pre-v284 wake-based surface session path tested by this suite.
	update public.qorpera_active_runtime_bundle a
	set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
	from public.qorpera_runtime_bundles b
	where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = 283;
	insert into auth.users(id, email) values
		(v_vic, 'vic-sdel@example.test'), (v_out, 'out-sdel@example.test'), (v_other_owner, 'owner-sdel-b@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select v_company, v_bo, 'bo@example.test', 'Bo', 'contributor'
	where not exists (select 1 from public.qorpera_profile_members where profile_id = v_company and user_id = v_bo);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_vic, 'vic-sdel@example.test', 'Vic', 'viewer');

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Template Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Template Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1357', true, array['codex', 'claude-code']);

	perform pg_temp.sdel_assert(
		not has_function_privilege('anon', 'public.qorpera_surface_remove(uuid,boolean)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_remove(uuid,boolean)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_remove(uuid,boolean)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_refuse_removed()', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_refuse_removed()', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_archive_surface(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_archive_surface(uuid)', 'EXECUTE'),
		'only a signed-in member reaches the delete, and only through qorpera_archive_surface'
	);

	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_site := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_note := (public.qorpera_create_surface(
		v_company, 'Launch Note', 'launch-note', 'studio', 'report', 'figure:book', null, 'surfaces/launch-note', null, false
	) ->> 'id')::uuid;
	v_keep := (public.qorpera_create_surface(
		v_company, 'Keep', 'keep', 'studio', 'report', 'figure:book', null, 'surfaces/keep', null, false
	) ->> 'id')::uuid;
	v_code_session := (public.qorpera_start_surface_session(v_site, 'Build the landing page', 'Landing') ->> 'id')::uuid;
	reset role;
	v_enq := pg_temp.sdel_turn(v_code_session);
	v_worker := (v_enq ->> 'workerId')::uuid;
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_runtime_workers where id = v_worker) = 'active',
		'the website session works on a coding worker: ' || v_enq::text
	);

	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_note_session := (public.qorpera_start_surface_session(v_note, 'Write the launch note', 'Note') ->> 'id')::uuid;
	reset role;
	v_enq := pg_temp.sdel_turn(v_note_session);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.sdel_assert(
		public.qorpera_folder_wake_authorized(v_wake),
		'the studio session works on a wake that may run'
	);

	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_variant := (public.qorpera_start_surface_session(
		v_site, 'Try two looks', 'Looks', 'member', null, null, 2, 'Two looks'
	) ->> 'id')::uuid;
	v_waiting := (public.qorpera_start_surface_session(v_site, 'Pick a font', 'Font') ->> 'id')::uuid;
	v_done := (public.qorpera_start_surface_session(v_note, 'Fix a typo', 'Typo') ->> 'id')::uuid;
	v_kept := (public.qorpera_start_surface_session(v_keep, 'Leave me be', 'Stay') ->> 'id')::uuid;
	v_auto_site := (public.qorpera_create_surface_automation(
		v_company, 'Check links', 'Check the links', 'Every day · 09:00', 'website') ->> 'id')::uuid;
	v_auto_note := (public.qorpera_create_surface_automation(
		v_company, 'Tidy note', 'Tidy the note', 'Every day · 09:00', 'launch-note') ->> 'id')::uuid;
	v_auto_keep := (public.qorpera_create_surface_automation(
		v_company, 'Water keep', 'Water the keep', 'Every day · 09:00', 'keep') ->> 'id')::uuid;
	v_auto_free := (public.qorpera_create_surface_automation(
		v_company, 'Morning look', 'Look at the company', 'Every day · 09:00', null) ->> 'id')::uuid;
	reset role;
	select exploration_id into strict v_exploration from public.qorpera_surface_sessions where id = v_variant;
	update public.qorpera_surface_sessions
	set state = 'completed', closed_at = clock_timestamp()
	where id in (v_done, v_kept);
	update public.qorpera_surface_sessions
	set state = 'needs_input', question = '{"text":"Serif or sans?"}'::jsonb
	where id = v_waiting;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, status)
	values
		(v_company, v_site, v_waiting, 1, 'Serif headings', 'staged'),
		(v_company, v_site, v_waiting, 2, 'Footer links', 'merging'),
		(v_company, v_site, v_waiting, 3, 'Landed footer', 'merged');
	insert into public.qorpera_surface_jobs(id, profile_id, surface_id, kind, status, lease_token, lease_expires_at)
	values
		(v_job_queued, v_company, v_site, 'publish_surface', 'queued', null, null),
		(v_job_running, v_company, v_site, 'land_change', 'running',
			extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes');
	insert into public.qorpera_surface_publish_asks(surface_id, profile_id, asked_by_user_id, asked_user_id, change_count)
	values (v_site, v_company, v_anna, v_bo, 1);
	update public.qorpera_surfaces set publish_status = 'publishing' where id = v_site;

	v_result := pg_temp.sdel_delete(v_bo, v_site);
	perform pg_temp.sdel_assert(
		v_result ->> 'id' = v_site::text and v_result ->> 'status' = 'archived'
			and (v_result ->> 'activeSessionCount')::integer = 0
			and (v_result ->> 'runningSessionCount')::integer = 0
			and (v_result ->> 'pendingChangeCount')::integer = 0
			and v_result ->> 'publishStatus' = 'idle',
		'a contributor deletes the website and gets it back archived with nothing open: ' || v_result::text
	);
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_runtime_workers where id = v_worker) = 'cancelled'
			and (select phase from public.qorpera_coding_sessions where worker_id = v_worker) = 'cancelled',
		'the coding worker of its working session is cancelled'
	);
	select count(*) into v_count from public.qorpera_surface_sessions where surface_id = v_site;
	perform pg_temp.sdel_assert(
		v_count = 4 and not exists (
			select 1 from public.qorpera_surface_sessions s
			where s.surface_id = v_site and (
				s.state <> 'discarded' or s.lease_token is not null or s.lease_expires_at is not null
				or s.wake_id is not null or s.closed_at is null or s.has_active_chat
			)
		),
		'its working, waiting and option sessions are all discarded with no lease and no wake'
	);
	perform pg_temp.sdel_assert(
		(select array_agg(c.status order by c.seq) from public.qorpera_surface_changes c where c.session_id = v_waiting)
			= array['discarded', 'discarded', 'merged']
			and not exists (
				select 1 from public.qorpera_surface_changes c
				where c.session_id = v_waiting and c.status = 'discarded' and c.resolved_at is null
			),
		'its waiting and merging changes are discarded, a landed one stays'
	);
	perform pg_temp.sdel_assert(
		(select status = 'discarded' and resolved_at is not null from public.qorpera_surface_explorations where id = v_exploration),
		'its open choice between options is closed'
	);
	perform pg_temp.sdel_assert(
		not exists (
			select 1 from public.qorpera_surface_jobs j
			where j.id in (v_job_queued, v_job_running) and (
				j.status <> 'failed' or j.lease_token is not null or j.lease_expires_at is not null
				or j.completed_at is null or j.error_detail is distinct from 'The interface was deleted'
			)
		),
		'its queued and running jobs fail with the reason and hold no lease'
	);
	perform pg_temp.sdel_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_site),
		'its publish ask is gone'
	);
	perform pg_temp.sdel_assert(
		not exists (select 1 from public.qorpera_surface_automations where id = v_auto_site)
			and (select count(*) from public.qorpera_surface_automations where id in (v_auto_note, v_auto_keep, v_auto_free)) = 3,
		'its scheduled agent is deleted in the same call, the others stay'
	);
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_surface_sessions where id = v_note_session) = 'running'
			and (select wake_id from public.qorpera_surface_sessions where id = v_note_session) = v_wake.id
			and (select state from public.qorpera_surface_sessions where id = v_kept) = 'completed'
			and (select status from public.qorpera_surfaces where id = v_note) = 'active',
		'other interfaces and their sessions are left alone'
	);
	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_result := public.qorpera_list_surfaces(v_company);
	reset role;
	perform pg_temp.sdel_assert(
		not exists (select 1 from jsonb_array_elements(v_result) elem where elem ->> 'id' = v_site::text)
			and exists (select 1 from jsonb_array_elements(v_result) elem where elem ->> 'id' = v_note::text),
		'the deleted website is no longer listed'
	);

	v_result := pg_temp.sdel_delete(v_anna, v_note);
	perform pg_temp.sdel_assert(
		v_result ->> 'status' = 'archived'
			and (select s.state = 'discarded' and s.wake_id is null and s.lease_token is null
				from public.qorpera_surface_sessions s where s.id = v_note_session)
			and not public.qorpera_folder_wake_authorized(v_wake),
		'deleting a studio discards its working session and its wake may no longer run'
	);
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_surface_sessions where id = v_done) = 'completed'
			and not exists (select 1 from public.qorpera_surface_automations where id = v_auto_note)
			and (select count(*) from public.qorpera_surface_automations where id in (v_auto_keep, v_auto_free)) = 2,
		'a finished session stays finished and only the studio''s own scheduled agent goes'
	);

	perform pg_temp.sdel_assert(
		pg_temp.sdel_delete(v_anna, v_site) ->> 'status' = 'archived',
		'deleting a deleted interface again answers the same'
	);

	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_start_surface_session(%L, %L, %L)', v_note, 'Once more', 'Again'), '55000');
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_reply_surface_session(%L, %L, true)', v_done, 'One more thing'), '55000');
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_reply_surface_session(%L, %L, true)', v_note_session, 'Carry on'), '55000');
	perform pg_temp.sdel_refused(null,
		format('select public.qorpera_service_start_surface_session(%L, %L, %L, %L, %L, %L, null, null, null)',
			v_company, v_site, 'Check the links', 'Check links', 'automation', 'Check links'), '55000');
	begin
		insert into public.qorpera_surface_jobs(profile_id, surface_id, kind) values (v_company, v_site, 'publish_surface');
		v_errcode := 'none';
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.sdel_assert(v_errcode = '55000', 'a job for a deleted interface is refused, got ' || v_errcode);
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_surface_sessions where id = v_done) = 'completed'
			and (select state from public.qorpera_surface_sessions where id = v_note_session) = 'discarded'
			and not exists (
				select 1 from public.qorpera_surface_session_messages m
				where m.session_id in (v_done, v_note_session) and m.body in ('One more thing', 'Carry on')
			)
			and (select count(*) from public.qorpera_surface_sessions where surface_id in (v_site, v_note)) = 6,
		'refused work leaves a deleted interface''s sessions as they were'
	);

	update public.qorpera_surfaces set unpublished_change_count = 1 where id in (v_site, v_note);
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_approve_proposed_surface(%L)', v_site), '55000', 'This interface was deleted');
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_ask_surface_publish(%L, %L)', v_site, v_bo), '55000', 'This interface was deleted');
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_publish_surface(%L)', v_note), '55000', 'This interface was deleted');
	perform pg_temp.sdel_assert(
		(select count(*) from public.qorpera_surfaces
			where id in (v_site, v_note) and status = 'archived' and unpublished_change_count = 1) = 2
			and not exists (select 1 from public.qorpera_surface_publish_asks where surface_id in (v_site, v_note)),
		'a deleted interface cannot be approved back, published or asked about'
	);

	select surface.site_id, site.slug into v_site_row, v_site_slug
	from public.qorpera_surfaces surface
	left join public.qorpera_company_sites site on site.id = surface.site_id
	where surface.id = v_site;
	perform pg_temp.sdel_assert(v_site_row is not null, 'the deleted website has a site of its own');
	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_result := public.qorpera_surface_migration_checklist(v_company);
	perform public.qorpera_apply_surface_migration(v_company, '{}'::text[], '[]'::jsonb, '{}'::text[]);
	perform public.qorpera_apply_surface_migration(v_company, array[v_site_slug, 'website'], '[]'::jsonb, '{}'::text[]);
	reset role;
	perform pg_temp.sdel_assert(
		not exists (
			select 1 from jsonb_array_elements(v_result -> 'proposedSurfaces') elem
			where elem ->> 'slug' in (v_site_slug, 'website')
		)
			and (select status from public.qorpera_surfaces where id = v_site) = 'archived'
			and (select count(*) from public.qorpera_surfaces where site_id = v_site_row) = 1
			and not exists (
				select 1 from public.qorpera_surfaces
				where profile_id = v_company and slug = v_site_slug and id <> v_site
			),
		'the move-to-surfaces sheet neither lists a deleted interface''s site nor brings the interface back'
	);
	perform pg_temp.sdel_refused(null,
		format('select public.qorpera_native_surface_propose(%L, %L, %L, %L, %L, %L, p_activate_immediately => true)',
			v_company, 'website', 'Website again', 'products', 'live_build', 'code_repo'),
		'55000', 'An interface with this slug was deleted; propose it under another slug');
	perform pg_temp.sdel_refused(null,
		format('select public.qorpera_native_surface_propose(%L, %L, %L, %L, %L, %L)',
			v_company, 'launch-note', 'Launch Note', 'products', 'studio', 'folder'),
		'55000', 'An interface with this slug was deleted; propose it under another slug');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_native_surface_propose(
		v_company, 'shop', 'Shop', 'products', 'studio', 'folder', p_activate_immediately => true
	);
	reset role;
	perform pg_temp.sdel_assert(
		v_result ->> 'status' = 'active'
			and (select count(*) from public.qorpera_surfaces where id in (v_site, v_note) and status = 'archived') = 2,
		'an agent cannot propose a deleted interface back, and still proposes one under a new slug: ' || v_result::text
	);

	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_kept, 'And the hedge too', true);
	perform public.qorpera_start_surface_session(v_keep, 'Plant a tree', 'Tree');
	v_auto_late := (public.qorpera_create_surface_automation(
		v_company, 'Late links', 'Check the links again', 'Every day · 09:00', 'website') ->> 'id')::uuid;
	reset role;
	perform pg_temp.sdel_assert(
		(select state from public.qorpera_surface_sessions where id = v_kept) = 'queued',
		'a finished session on a live interface still reopens on a reply'
	);

	select count(*) into v_count from public.qorpera_surface_sessions where profile_id = v_company;
	v_result := pg_temp.sdel_trigger(v_auto_late);
	perform pg_temp.sdel_assert(
		v_result ->> 'status' = 'skipped' and v_result ->> 'reason' = 'no_target_surface'
			and (select count(*) from public.qorpera_surface_sessions where profile_id = v_company) = v_count,
		'a scheduled agent whose interface is deleted does not run on another one: ' || v_result::text
	);
	v_result := pg_temp.sdel_trigger(v_auto_free);
	perform pg_temp.sdel_assert(
		v_result ->> 'status' = 'started'
			and (select surface.status from public.qorpera_surface_sessions session
				join public.qorpera_surfaces surface on surface.id = session.surface_id
				where session.id = (v_result -> 'session' ->> 'sessionId')::uuid) = 'active',
		'a scheduled agent with no interface of its own still runs on a live one: ' || v_result::text
	);

	perform pg_temp.sdel_refused(v_vic, format('select public.qorpera_archive_surface(%L)', v_keep), '42501');
	perform pg_temp.sdel_refused(v_out, format('select public.qorpera_archive_surface(%L)', v_keep), '42501');
	perform pg_temp.sdel_refused(v_anna,
		format('select public.qorpera_archive_surface(%L)', '13570000-0000-4000-8000-0000000009ff'), 'P0002');

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, status, icon, source_kind, preview_mode, sort_order
	)
	values (v_company, 'money', 'Money', 'operations', 'ops', 'money', 'active', 'coin', 'native_ops', 'none', 110)
	on conflict (profile_id, slug) do update set status = 'active'
	returning id into v_money;
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, status, icon, source_kind, preview_mode, sort_order
	)
	values (v_company, 'files', 'Files', 'operations', 'ops', 'files', 'proposed', 'drawers', 'native_ops', 'none', 140)
	on conflict (profile_id, slug) do update set status = 'proposed'
	returning id into v_proposed;
	perform pg_temp.sdel_as(v_anna);
	set local role authenticated;
	v_auto_money := (public.qorpera_create_surface_automation(
		v_company, 'Count coins', 'Count the coins', 'Every day · 09:00', 'money') ->> 'id')::uuid;
	reset role;
	perform pg_temp.sdel_refused(v_anna, format('select public.qorpera_archive_surface(%L)', v_money), '55000');
	perform pg_temp.sdel_assert(
		(select status from public.qorpera_surfaces where id = v_money) = 'active'
			and exists (select 1 from public.qorpera_surface_automations where id = v_auto_money)
			and (select status from public.qorpera_surfaces where id = v_keep) = 'active',
		'a built-in interface is not deleted and keeps its scheduled agent; refused calls change nothing'
	);
	perform pg_temp.sdel_assert(
		pg_temp.sdel_delete(v_anna, v_proposed) ->> 'status' = 'archived',
		'a proposed interface is still dismissed, built-in or not'
	);

	update public.qorpera_surfaces set status = 'archived' where id = v_keep;
	perform public.qorpera_surface_remove(v_keep, false);
	perform public.qorpera_surface_remove(v_money, false);
	perform pg_temp.sdel_assert(
		not exists (
			select 1 from public.qorpera_surface_sessions s
			join public.qorpera_surfaces surface on surface.id = s.surface_id
			where surface.profile_id = v_company and surface.status = 'archived' and s.state not in ('completed', 'discarded')
		)
			and (select status from public.qorpera_surfaces where id = v_money) = 'archived'
			and not exists (select 1 from public.qorpera_surface_automations where id in (v_auto_keep, v_auto_money))
			and exists (select 1 from public.qorpera_surface_automations where id = v_auto_free),
		'the settling the migration runs for surfaces archived before it leaves no open session and no scheduled agent'
	);
end $$;

rollback;
