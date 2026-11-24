-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spl_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_preview_lineage: %', p_message;
	end if;
end $$;

create function pg_temp.spl_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_code_surface uuid;
	v_s1 jsonb;
	v_s2 jsonb;
	v_s2_id uuid;
	v_s3 jsonb;
	v_s_ptc jsonb;
	v_s_big jsonb;
	v_s_big_read jsonb;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_c_big uuid;
	v_lease uuid;
	v_turn jsonb;
	v_rec record;
	v_rec_session public.qorpera_surface_sessions%rowtype;
	v_rec_count integer;
	v_discard_rec record;
	v_approve_res jsonb;
	v_job_count integer;
	v_code_s1 uuid;
	v_code_s2 uuid;
	v_code_s3 uuid;
	v_code_c1 uuid;
	v_code_c2 uuid;
	v_code_c3 uuid;
	v_code_rec record;
	v_code_preview jsonb;
	v_code_preview_status text;
	v_priv_leaks integer;
	v_big_text text;
	v_turn_bytes integer;
	v_s_fill uuid;
	v_c_fill uuid;
	v_s_tail uuid;
	v_c_tail uuid;
	v_s_tail2 uuid;
	v_c_tail2 uuid;
	v_s_over uuid;
	v_f2_surface uuid;
	v_f2_s1 uuid;
	v_f2_s2 uuid;
	v_f2_s3 uuid;
	v_f2_s4 uuid;
	v_f2_c1 uuid;
	v_f2_c2 uuid;
	v_f2_c3 uuid;
	v_f2_c4 uuid;
	v_f2_rec record;
	v_f2_rec2 record;
	v_f2_rec3 record;
	v_f2_msg_count integer;
	v_f3_surface uuid;
	v_f3_sa uuid;
	v_f3_s1 uuid;
	v_f3_s2 uuid;
	v_f3_s3 uuid;
	v_f3_ca uuid;
	v_f3_c1 uuid;
	v_f3_c2 uuid;
	v_f3_c3 uuid;
	v_f3_rec record;
begin
	select count(*) into v_priv_leaks
	from unnest(array[
		'public.qorpera_surface_normalize_paths(text,text[])',
		'public.qorpera_surface_dependent_chain(uuid,uuid[])',
		'public.qorpera_surface_preview_turn_context(public.qorpera_surfaces,uuid[])',
		'public.qorpera_surface_reconciliation_omitted_bases(uuid,uuid[])',
		'public.qorpera_surface_needs_standalone_reconciliation(public.qorpera_surfaces,uuid[])',
		'public.qorpera_surface_enqueue_chain_reconciliation(uuid,uuid)',
		'public.qorpera_surface_enqueue_standalone_dependents(uuid,uuid[])'
	]) as fn(sig)
	cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) as r(role_name)
	where has_function_privilege(r.role_name, fn.sig, 'EXECUTE');
	perform pg_temp.spl_assert(v_priv_leaks = 0, 'Internal preview lineage helpers must have zero API execute grants');

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.spl_as(v_owner);
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, folder_root, status
	)
	values (
		v_profile, 'lineage-identity', 'Identity', 'products', 'studio', 'folder', 'identity', 'active'
	)
	returning id into v_surface;

	v_s1 := public.qorpera_start_surface_session(v_surface, 'Add Electric Blue accent token', 'Add accent');
	perform pg_temp.as_service();
	v_c1 := (public.qorpera_record_surface_change(
		(v_s1 ->> 'id')::uuid,
		'Add Electric Blue token',
		'Sets accent to #0070f3',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['tokens.json'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'tokens.json', 'content', '{"accent":"#0070f3","name":"Electric Blue"}' || E'\n')
			),
			'baseFiles', jsonb_build_object('tokens.json', '{"accent":"#222222"}' || E'\n')
		),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_s2 := public.qorpera_start_surface_session(
		v_surface,
		'Write launch promo using the new accent color',
		'Write promo',
		'member',
		null,
		jsonb_build_object(
			'previewBaseChangeIds', jsonb_build_array(v_c1, 'not-a-uuid', extensions.gen_random_uuid())
		)
	);
	v_s2_id := (v_s2 ->> 'id')::uuid;

	perform pg_temp.spl_assert(
		(select origin_ref is null from public.qorpera_surface_sessions where id = v_s2_id),
		'previewBaseChangeIds-only origin_ref must be stripped to null'
	);
	perform pg_temp.spl_assert(
		(select preview_base_change_ids = array[v_c1] from public.qorpera_surface_sessions where id = v_s2_id),
		'Session must persist validated open previewBaseChangeIds'
	);

	v_s_ptc := public.qorpera_start_surface_session(
		v_surface,
		'Adjust headline copy',
		'Point to change',
		'point_to_change',
		'Headline',
		jsonb_build_object(
			'route', '/',
			'selector', 'h1',
			'tagName', 'h1',
			'textSnippet', 'Hello',
			'boundingBox', jsonb_build_object('x', 0, 'y', 0, 'width', 100, 'height', 40),
			'viewport', jsonb_build_object('width', 1280, 'height', 800),
			'previewBaseChangeIds', jsonb_build_array(v_c1)
		)
	);
	perform pg_temp.spl_assert(
		(select (origin_ref ->> 'selector') = 'h1' and not (origin_ref ? 'previewBaseChangeIds') and preview_base_change_ids = array[v_c1]
		 from public.qorpera_surface_sessions where id = (v_s_ptc ->> 'id')::uuid),
		'Point-to-Change origin_ref fields must be preserved when previewBaseChangeIds is stripped'
	);

	perform pg_temp.as_service();
	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_s2_id;

	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_s2_id, v_lease);
	perform pg_temp.spl_assert(
		jsonb_array_length(v_turn -> 'previewBaseChangeIds') = 1
			and (v_turn -> 'previewBaseChangeIds' ->> 0)::uuid = v_c1,
		'Turn read must expose previewBaseChangeIds'
	);
	perform pg_temp.spl_assert(
		jsonb_array_length(v_turn -> 'previewContext' -> 'previewBaseChanges') = 1
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 0 ->> 'changeId')::uuid = v_c1
			and jsonb_array_length(v_turn -> 'previewContext' -> 'previewBaseChanges' -> 0 -> 'patchManifest') = 1,
		'Turn read must expose previewBaseChanges with folder_patch manifest'
	);

	v_c2 := (public.qorpera_record_surface_change(
		v_s2_id,
		'Add Electric Blue promo',
		'Adds promo.md referencing Electric Blue',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['promo.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'promo.md', 'content', '# Electric Blue Launch' || E'\n')
			),
			'baseFiles', jsonb_build_object('promo.md', null)
		),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_assert(
		(select preview_base_change_ids = array[v_c1] from public.qorpera_surface_changes where id = v_c2),
		'Recorded change must inherit still-open preview_base_change_ids from session'
	);
	perform pg_temp.spl_assert(
		(select (public.qorpera_surface_session_json(s) -> 'changes' -> 0 -> 'previewBaseChangeIds' ->> 0)::uuid = v_c1
		 from public.qorpera_surface_sessions s where s.id = v_s2_id),
		'Session JSON must expose previewBaseChangeIds on change'
	);
	select count(*) into v_rec_count from public.qorpera_surface_reconciliations where surface_id = v_surface;
	perform pg_temp.spl_assert(v_rec_count = 0, 'Sequential C1 -> C2 without overlap must not enqueue reconciliation');

	perform pg_temp.spl_as(v_owner);
	v_s3 := public.qorpera_start_surface_session(v_surface, 'Switch accent to Sunset Orange', 'Sunset Orange');
	perform pg_temp.as_service();
	v_c3 := (public.qorpera_record_surface_change(
		(v_s3 ->> 'id')::uuid,
		'Switch accent to Sunset Orange',
		'Updates accent to #ff5500',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['identity/tokens.json', 'identity/banner.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'identity/tokens.json', 'content', '{"accent":"#ff5500","name":"Sunset Orange"}' || E'\n'),
				jsonb_build_object('op', 'write_text', 'path', 'identity/banner.md', 'content', '# Sunset Banner' || E'\n')
			),
			'baseFiles', jsonb_build_object('identity/tokens.json', '{"accent":"#222222"}' || E'\n')
		),
		true
	) ->> 'changeId')::uuid;

	select * into v_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_surface
	order by created_at desc
	limit 1;
	perform pg_temp.spl_assert(v_rec.id is not null, 'C3 overlapping C1 must proactively enqueue chain reconciliation');
	perform pg_temp.spl_assert(
		v_rec.selected_change_ids = array[v_c1, v_c2, v_c3],
		'Chain reconciliation must cover full chain [C1, C2, C3]'
	);
	perform pg_temp.spl_assert(
		v_rec.conflict_paths = array['tokens.json'],
		'Chain reconciliation conflict_paths must contain normalized overlapping path tokens.json'
	);

	select * into v_rec_session from public.qorpera_surface_sessions where id = v_rec.session_id;
	perform pg_temp.spl_assert(v_rec_session.is_internal, 'Chain reconciliation session must be internal');
	perform pg_temp.spl_assert(
		v_rec_session.origin_kind = 'cofounder',
		'System-triggered chain reconciliation must use cofounder origin_kind'
	);
	perform pg_temp.spl_assert(
		v_rec_session.origin_ref ->> 'chainMode' = 'true',
		'Chain reconciliation origin_ref must set chainMode=true'
	);
	perform pg_temp.spl_assert(
		(v_rec_session.origin_ref -> 'changes' -> 1 -> 'previewBaseChangeIds' ->> 0)::uuid = v_c1,
		'Chain reconciliation origin_ref changes must carry previewBaseChangeIds lineage'
	);

	v_big_text := repeat('x', 110000);
	perform pg_temp.spl_as(v_owner);
	v_s_big := public.qorpera_start_surface_session(v_surface, 'Add huge file', 'Huge file');
	perform pg_temp.as_service();
	v_c_big := (public.qorpera_record_surface_change(
		(v_s_big ->> 'id')::uuid,
		'Add huge doc',
		'Large content',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['huge.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'huge.md', 'content', v_big_text)
			)
		),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_s_big_read := public.qorpera_start_surface_session(
		v_surface,
		'Build on huge doc',
		'Build huge',
		'member',
		null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_c_big))
	);
	perform pg_temp.as_service();
	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = (v_s_big_read ->> 'id')::uuid;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, (v_s_big_read ->> 'id')::uuid, v_lease);
	v_turn_bytes := octet_length(v_turn::text);
	perform pg_temp.spl_assert(
		v_turn_bytes < 131072
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 0 ->> 'truncated') = 'true'
			and not ((v_turn -> 'previewContext' -> 'previewBaseChanges' -> 0) ? 'patchManifest'),
		'Oversized preview patch must truncate manifest while keeping metadata under 96 KiB budget'
	);

	perform pg_temp.spl_as(v_owner);
	v_s_fill := (public.qorpera_start_surface_session(v_surface, 'Fill budget') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_c_fill := (public.qorpera_record_surface_change(
		v_s_fill, 'Fill budget', 'Fills manifest budget', 'folder_patch', null, null, '{}'::uuid[],
		array['fill.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'fill.md', 'content', repeat('f', 69000)))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_s_tail := (public.qorpera_start_surface_session(v_surface, 'Tail change') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_c_tail := (public.qorpera_record_surface_change(
		v_s_tail, 'Tail change', 'Many long paths', 'folder_patch', null, null, '{}'::uuid[],
		(select array_agg('dir/' || repeat('p', 900) || '-' || g::text || '.md' order by g) from generate_series(1, 35) as g),
		null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dir/p.md', 'content', 'tail' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_s_tail2 := (public.qorpera_start_surface_session(v_surface, 'Tail change 2') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_c_tail2 := (public.qorpera_record_surface_change(
		v_s_tail2, 'Tail change 2', 'Pushes past meta budget', 'folder_patch', null, null, '{}'::uuid[],
		(select array_agg('dir2/' || repeat('q', 900) || '-' || g::text || '.md' order by g) from generate_series(1, 35) as g),
		null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dir2/q.md', 'content', 'tail2' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_s_over := (public.qorpera_start_surface_session(
		v_surface, 'Over budget read', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_c_fill, v_c_tail, v_c_tail2))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_s_over;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_s_over, v_lease);
	perform pg_temp.spl_assert(
		octet_length((v_turn -> 'previewContext')::text) <= 98304
			and jsonb_array_length(v_turn -> 'previewContext' -> 'previewBaseChanges') = 3
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 1 ->> 'changeId')::uuid = v_c_tail
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 1 ->> 'truncated') = 'true'
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 1 ->> 'pathsTruncated') = 'true'
			and jsonb_array_length(v_turn -> 'previewContext' -> 'previewBaseChanges' -> 1 -> 'affectedPaths') = 32
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 2 ->> 'changeId')::uuid = v_c_tail2
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 2 ->> 'truncated') = 'true'
			and (v_turn -> 'previewContext' -> 'previewBaseChanges' -> 2 ->> 'pathsTruncated') = 'true'
			and jsonb_array_length(v_turn -> 'previewContext' -> 'previewBaseChanges' -> 2 -> 'affectedPaths') = 0,
		'Exhausted budget must emit 32-path then pathless truncated stubs while keeping previewContext strictly <= 96 KiB'
	);

	perform pg_temp.spl_as(v_owner);
	perform public.qorpera_discard_surface_change(v_c1);
	select * into v_discard_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_surface and selected_change_ids = array[v_c2];
	perform pg_temp.spl_assert(
		v_discard_rec.id is not null and v_discard_rec.status = 'queued',
		'Discarding C1 must proactively enqueue standalone reconciliation for dependent C2'
	);
	select * into v_rec_session from public.qorpera_surface_sessions where id = v_discard_rec.session_id;
	perform pg_temp.spl_assert(
		v_rec_session.origin_kind = 'cofounder'
			and jsonb_array_length(v_rec_session.origin_ref -> 'omittedBaseChanges') = 1
			and (v_rec_session.origin_ref -> 'omittedBaseChanges' -> 0 ->> 'changeId')::uuid = v_c1,
		'Discard standalone reconciliation must record omitted base change C1 in origin_ref'
	);

	select count(*) into v_rec_count from public.qorpera_surface_sessions where surface_id = v_surface and is_internal;
	perform public.qorpera_discard_surface_change(v_c1);
	perform pg_temp.spl_assert(
		(select count(*) from public.qorpera_surface_sessions where surface_id = v_surface and is_internal) = v_rec_count,
		'Idempotent discard of already-discarded C1 must not enqueue extra reconciliations'
	);

	perform pg_temp.spl_as(v_owner);
	perform public.qorpera_set_preview_selection(v_surface, array[v_c2], null, '{}'::uuid[], '/');
	v_approve_res := public.qorpera_approve_surface_change(v_c2, true);
	perform pg_temp.spl_assert(
		(select status from public.qorpera_surface_changes where id = v_c2) = 'staged',
		'Approving C2 before standalone reconciliation completes must keep C2 staged while auto_approve_after runs'
	);
	perform pg_temp.spl_assert(
		(select v_c2 = any(toggled_change_ids) from public.qorpera_member_surface_state where surface_id = v_surface and user_id = v_owner),
		'Deferred approval must keep C2 in toggled_change_ids until landing begins'
	);
	perform pg_temp.spl_assert(
		(select auto_approve_after from public.qorpera_surface_reconciliations where id = v_discard_rec.id),
		'Approving C2 must set auto_approve_after=true on pending standalone reconciliation'
	);
	select count(*) into v_job_count from public.qorpera_surface_jobs where surface_id = v_surface and kind = 'land_change';
	perform pg_temp.spl_assert(v_job_count = 0, 'No land_change job should be queued before standalone reconciliation finishes');

	perform pg_temp.as_service();
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_discard_rec.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_discard_rec.session_id;
	perform public.qorpera_record_surface_change(
		v_discard_rec.session_id,
		'Standalone promo',
		'Adapted promo without C1',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['promo.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'promo.md', 'content', '# Launch Promo' || E'\n')
			)
		),
		true
	);
	perform pg_temp.spl_assert(
		(select status = 'merging' and approved_by_user_id is not null from public.qorpera_surface_changes where id = v_c2),
		'Completing standalone reconciliation with auto_approve_after must transition C2 to merging with approver'
	);
	perform pg_temp.spl_assert(
		(select not (v_c2 = any(toggled_change_ids)) from public.qorpera_member_surface_state where surface_id = v_surface and user_id = v_owner),
		'Auto-landing after standalone reconciliation must strip C2 from toggled_change_ids'
	);
	select count(*) into v_job_count
	from public.qorpera_surface_jobs
	where surface_id = v_surface and kind = 'land_change' and (payload ->> 'reconciliationId')::uuid = v_discard_rec.id;
	perform pg_temp.spl_assert(v_job_count = 1, 'Completing standalone reconciliation must enqueue land_change with reconciliationId');

	perform pg_temp.spl_as(v_owner);
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, repository_key, live_head_sha, status
	)
	values (
		v_profile, 'lineage-site', 'Site', 'products', 'live_build', 'code_repo', 'site', repeat('a', 40), 'active'
	)
	returning id into v_code_surface;

	v_code_s1 := (public.qorpera_start_surface_session(v_code_surface, 'Add HeroBanner') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_code_c1 := (public.qorpera_record_surface_change(
		v_code_s1, 'Add HeroBanner', 'Creates HeroBanner', 'git_range',
		repeat('a', 40), repeat('1', 40), '{}'::uuid[], array['src/Hero.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_code_s2 := (public.qorpera_start_surface_session(
		v_code_surface, 'Use HeroBanner on Pricing', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_code_c1))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_code_c2 := (public.qorpera_record_surface_change(
		v_code_s2, 'Use HeroBanner on Pricing', 'Imports HeroBanner', 'git_range',
		repeat('a', 40), repeat('2', 40), '{}'::uuid[], array['src/Pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_code_s3 := (public.qorpera_start_surface_session(v_code_surface, 'Rename HeroBanner prop') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_code_c3 := (public.qorpera_record_surface_change(
		v_code_s3, 'Rename HeroBanner prop', 'Changes prop API', 'git_range',
		repeat('a', 40), repeat('3', 40), '{}'::uuid[], array['src/Hero.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	select * into v_code_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_code_surface and selected_change_ids = array[v_code_c1, v_code_c2, v_code_c3];
	perform pg_temp.spl_assert(v_code_rec.id is not null, 'code_repo C3 overlapping C1 must enqueue chain reconciliation');

	perform pg_temp.spl_as(v_owner);
	v_code_preview := public.qorpera_set_preview_selection(
		v_code_surface, array[v_code_c1, v_code_c2, v_code_c3], null, '{}'::uuid[], '/'
	);
	perform pg_temp.spl_assert(
		(v_code_preview -> 'primary' ->> 'status') = 'reconciling',
		'Selecting code_repo chain while reconciliation is queued must start preview in reconciling state'
	);

	perform pg_temp.as_service();
	update public.qorpera_surface_previews set status = 'ready' where id = (v_code_preview -> 'primary' ->> 'previewId')::uuid;
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_code_rec.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_code_rec.session_id;
	perform public.qorpera_record_surface_change(
		v_code_rec.session_id, 'Reconciled chain', 'Adapted Pricing for Hero prop', 'git_range',
		repeat('a', 40), repeat('9', 40), '{}'::uuid[], array['src/Hero.tsx', 'src/Pricing.tsx'], null, null, true
	);
	select status into v_code_preview_status
	from public.qorpera_surface_previews
	where id = (v_code_preview -> 'primary' ->> 'previewId')::uuid;
	perform pg_temp.spl_assert(
		v_code_preview_status = 'composing',
		'Completing code_repo chain reconciliation must reset matching ready preview back to composing'
	);

	perform pg_temp.spl_as(v_owner);
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, folder_root, status
	)
	values (
		v_profile, 'lineage-f2', 'Lineage F2', 'products', 'studio', 'folder', 'f2', 'active'
	)
	returning id into v_f2_surface;

	v_f2_s1 := (public.qorpera_start_surface_session(v_f2_surface, 'Base C1') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f2_c1 := (public.qorpera_record_surface_change(
		v_f2_s1, 'Base C1', 'Adds token', 'folder_patch', null, null, '{}'::uuid[], array['tokens.json'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'tokens.json', 'content', '{"a":1}' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_f2_s2 := (public.qorpera_start_surface_session(
		v_f2_surface, 'Dep C2', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_f2_c1))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f2_c2 := (public.qorpera_record_surface_change(
		v_f2_s2, 'Dep C2', 'Uses token', 'folder_patch', null, null, '{}'::uuid[], array['promo.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'promo.md', 'content', 'Promo 2' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	perform public.qorpera_approve_surface_change(v_f2_c1, true);
	perform pg_temp.spl_assert(
		(select status from public.qorpera_surface_changes where id = v_f2_c1) = 'merging',
		'F2 setup: C1 must be merging'
	);
	perform public.qorpera_approve_surface_change(v_f2_c2, true);
	perform pg_temp.spl_assert(
		(select status from public.qorpera_surface_changes where id = v_f2_c2) = 'merging',
		'Approving dependent C2 while base C1 is merging must not defer C2 into standalone reconciliation'
	);
	perform pg_temp.spl_assert(
		(select count(*) from public.qorpera_surface_reconciliations where surface_id = v_f2_surface) = 0,
		'Approving C2 while base C1 is merging must not enqueue standalone reconciliation'
	);

	v_f2_s3 := (public.qorpera_start_surface_session(v_f2_surface, 'Base C3') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f2_c3 := (public.qorpera_record_surface_change(
		v_f2_s3, 'Base C3', 'Base change', 'folder_patch', null, null, '{}'::uuid[], array['base3.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'base3.md', 'content', 'Base 3' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_f2_s4 := (public.qorpera_start_surface_session(
		v_f2_surface, 'Dep C4', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_f2_c3))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f2_c4 := (public.qorpera_record_surface_change(
		v_f2_s4, 'Dep C4', 'Dependent change', 'folder_patch', null, null, '{}'::uuid[], array['dep4.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dep4.md', 'content', 'Dep 4' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	perform public.qorpera_set_preview_selection(v_f2_surface, array[v_f2_c4], null, '{}'::uuid[], '/');
	perform public.qorpera_approve_session_all(v_f2_s4);
	perform pg_temp.spl_assert(
		(select status from public.qorpera_surface_changes where id = v_f2_c4) = 'staged',
		'approve_session_all on C4 with unmerged base C3 must defer C4'
	);
	perform pg_temp.spl_assert(
		(select v_f2_c4 = any(toggled_change_ids) from public.qorpera_member_surface_state where surface_id = v_f2_surface and user_id = v_owner),
		'Deferred approve_session_all must preserve toggled_change_ids'
	);

	select * into v_f2_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_f2_surface and selected_change_ids = array[v_f2_c4]
	order by created_at desc
	limit 1;
	perform pg_temp.spl_assert(v_f2_rec.id is not null and v_f2_rec.auto_approve_after, 'Deferred C4 must have auto_approve_after=true');

	perform pg_temp.as_service();
	update public.qorpera_surfaces set folder_revision = folder_revision + 1 where id = v_f2_surface;
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_f2_rec.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_f2_rec.session_id;
	perform public.qorpera_record_surface_change(
		v_f2_rec.session_id, 'Standalone C4 v1', 'Stale base', 'folder_patch', null, null, '{}'::uuid[], array['dep4.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dep4.md', 'content', 'Dep 4 standalone' || E'\n'))),
		true
	);
	select * into v_f2_rec2
	from public.qorpera_surface_reconciliations
	where surface_id = v_f2_surface and selected_change_ids = array[v_f2_c4] and id <> v_f2_rec.id
	order by created_at desc
	limit 1;
	perform pg_temp.spl_assert(
		v_f2_rec2.id is not null and v_f2_rec2.status = 'queued' and v_f2_rec2.auto_approve_after,
		'Stale base_fingerprint during deferred approval must re-enqueue against new folder_revision'
	);

	update public.qorpera_surfaces set folder_revision = folder_revision + 1 where id = v_f2_surface;
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_f2_rec2.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_f2_rec2.session_id;
	perform public.qorpera_record_surface_change(
		v_f2_rec2.session_id, 'Standalone C4 v2', 'Stale base 2', 'folder_patch', null, null, '{}'::uuid[], array['dep4.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dep4.md', 'content', 'Dep 4 standalone 2' || E'\n'))),
		true
	);
	select * into v_f2_rec3
	from public.qorpera_surface_reconciliations
	where surface_id = v_f2_surface and selected_change_ids = array[v_f2_c4] and id not in (v_f2_rec.id, v_f2_rec2.id)
	order by created_at desc
	limit 1;
	perform pg_temp.spl_assert(
		v_f2_rec3.id is not null and v_f2_rec3.status = 'queued' and v_f2_rec3.auto_approve_after,
		'Second stale base_fingerprint must re-enqueue attempt 3'
	);

	update public.qorpera_surfaces set folder_revision = folder_revision + 1 where id = v_f2_surface;
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_f2_rec3.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_f2_rec3.session_id;
	perform public.qorpera_record_surface_change(
		v_f2_rec3.session_id, 'Standalone C4 v3', 'Stale base 3', 'folder_patch', null, null, '{}'::uuid[], array['dep4.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dep4.md', 'content', 'Dep 4 standalone 3' || E'\n'))),
		true
	);
	select count(*) into v_f2_msg_count
	from public.qorpera_surface_session_messages
	where session_id = v_f2_s4
		and body = 'Could not apply this change automatically. Try approving again.';
	perform pg_temp.spl_assert(
		v_f2_msg_count = 1,
		'Reaching retry cap on stale deferred approval must post Try approving again message'
	);

	perform pg_temp.spl_as(v_owner);
	perform public.qorpera_approve_surface_change(v_f2_c4, true);
	select * into v_f2_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_f2_surface and selected_change_ids = array[v_f2_c4] and status = 'queued'
	order by created_at desc
	limit 1;
	perform pg_temp.as_service();
	update public.qorpera_surface_changes set status = 'merged', resolved_at = clock_timestamp() where id = v_f2_c3;
	update public.qorpera_surfaces set folder_revision = folder_revision + 1 where id = v_f2_surface;
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_f2_rec.id;
	update public.qorpera_surface_sessions set state = 'reconciling_running' where id = v_f2_rec.session_id;
	perform public.qorpera_record_surface_change(
		v_f2_rec.session_id, 'Standalone C4 after C3 merged', 'Base merged', 'folder_patch', null, null, '{}'::uuid[], array['dep4.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'dep4.md', 'content', 'Dep 4 standalone 4' || E'\n'))),
		true
	);
	perform pg_temp.spl_assert(
		(select status from public.qorpera_surface_changes where id = v_f2_c4) = 'merging',
		'When omitted base C3 merges while C4 is reconciling, C4 must land directly'
	);
	perform pg_temp.spl_assert(
		(select not (v_f2_c4 = any(toggled_change_ids)) from public.qorpera_member_surface_state where surface_id = v_f2_surface and user_id = v_owner),
		'Direct land after omitted base merges must strip C4 from toggled_change_ids'
	);
	perform pg_temp.spl_assert(
		exists (
			select 1 from public.qorpera_surface_jobs
			where surface_id = v_f2_surface
				and session_id = v_f2_s4
				and kind = 'land_change'
				and not (payload ? 'reconciliationId')
		),
		'Direct land after omitted base merges must enqueue land_change without stale reconciliationId'
	);

	perform pg_temp.spl_as(v_owner);
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, folder_root, status
	)
	values (
		v_profile, 'lineage-f3', 'Lineage F3', 'products', 'studio', 'folder', 'f3', 'active'
	)
	returning id into v_f3_surface;

	v_f3_sa := (public.qorpera_start_surface_session(v_f3_surface, 'Unrelated A') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f3_ca := (public.qorpera_record_surface_change(
		v_f3_sa, 'Unrelated A', 'Adds voice', 'folder_patch', null, null, '{}'::uuid[], array['voice.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'voice.md', 'content', 'Voice A' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_f3_s1 := (public.qorpera_start_surface_session(v_f3_surface, 'Base C1') ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f3_c1 := (public.qorpera_record_surface_change(
		v_f3_s1, 'Base C1', 'Adds tokens', 'folder_patch', null, null, '{}'::uuid[], array['tokens.json'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'tokens.json', 'content', '{"accent":"#0070f3"}' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_f3_s2 := (public.qorpera_start_surface_session(
		v_f3_surface, 'Dep C2', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_f3_c1))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f3_c2 := (public.qorpera_record_surface_change(
		v_f3_s2, 'Dep C2', 'Uses tokens', 'folder_patch', null, null, '{}'::uuid[], array['promo.md'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'promo.md', 'content', 'Blue promo' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.spl_as(v_owner);
	v_f3_s3 := (public.qorpera_start_surface_session(
		v_f3_surface, 'Mod C3', null, 'member', null,
		jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_f3_ca, v_f3_c1, v_f3_c2))
	) ->> 'id')::uuid;
	perform pg_temp.as_service();
	v_f3_c3 := (public.qorpera_record_surface_change(
		v_f3_s3, 'Mod C3', 'Modifies tokens', 'folder_patch', null, null, '{}'::uuid[], array['tokens.json'], null,
		jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'tokens.json', 'content', '{"accent":"#ff5500"}' || E'\n'))),
		true
	) ->> 'changeId')::uuid;

	select * into v_f3_rec
	from public.qorpera_surface_reconciliations
	where surface_id = v_f3_surface
	order by created_at desc
	limit 1;
	perform pg_temp.spl_assert(
		v_f3_rec.id is not null and v_f3_rec.selected_change_ids = array[v_f3_ca, v_f3_c1, v_f3_c2, v_f3_c3],
		'F3 chain reconciliation when C3 has preview bases [A, C1, C2] must include [A, C1, C2, C3]'
	);

	declare
		v_ds_surface uuid;
		v_ds_s1 uuid;
		v_ds_s2 uuid;
		v_ds_c1 uuid;
		v_ds_c1b uuid;
		v_ds_c2 uuid;
		v_ds_rec public.qorpera_surface_reconciliations%rowtype;
		v_ds_origin_ref jsonb;
		v_ex_id uuid;
		v_ex_v1 uuid;
		v_ex_v2 uuid;
		v_ex_c1 uuid;
		v_ex_dep_s uuid;
		v_ex_dep_c uuid;
		v_ex_rec public.qorpera_surface_reconciliations%rowtype;
		v_ch_id uuid;
		v_ch_v1 uuid;
		v_ch_v2 uuid;
		v_ch_c2 uuid;
		v_ch_dep_s uuid;
		v_ch_dep_c uuid;
		v_ch_rec public.qorpera_surface_reconciliations%rowtype;
	begin
		perform pg_temp.spl_as(v_owner);
		insert into public.qorpera_surfaces(
			profile_id, slug, title, surface_group, archetype, source_kind, folder_root, status
		)
		values (
			v_profile, 'lineage-discard-session', 'Lineage Discard Session', 'products', 'studio', 'folder', 'ds', 'active'
		)
		returning id into v_ds_surface;

		v_ds_s1 := (public.qorpera_start_surface_session(v_ds_surface, 'Base session S1') ->> 'id')::uuid;
		perform pg_temp.as_service();
		v_ds_c1 := (public.qorpera_record_surface_change(
			v_ds_s1, 'Base C1', 'Adds token', 'folder_patch', null, null, '{}'::uuid[], array['tokens.json'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'tokens.json', 'content', '{"accent":"#112233"}' || E'\n'))),
			false
		) ->> 'changeId')::uuid;
		v_ds_c1b := (public.qorpera_record_surface_change(
			v_ds_s1, 'Same-session C1b', 'Uses token in same session', 'folder_patch', null, null, '{}'::uuid[], array['same.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'same.md', 'content', 'Same session' || E'\n'))),
			true
		) ->> 'changeId')::uuid;
		update public.qorpera_surface_changes set preview_base_change_ids = array[v_ds_c1] where id = v_ds_c1b;

		perform pg_temp.spl_as(v_owner);
		v_ds_s2 := (public.qorpera_start_surface_session(
			v_ds_surface, 'Dependent session S2', null, 'member', null,
			jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_ds_c1))
		) ->> 'id')::uuid;
		perform pg_temp.as_service();
		v_ds_c2 := (public.qorpera_record_surface_change(
			v_ds_s2, 'Dependent C2', 'Uses C1 token', 'folder_patch', null, null, '{}'::uuid[], array['banner.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'banner.md', 'content', 'Banner using C1' || E'\n'))),
			true
		) ->> 'changeId')::uuid;

		perform pg_temp.spl_as(v_owner);
		perform public.qorpera_discard_surface_session(v_ds_s1);

		perform pg_temp.as_service();
		select * into v_ds_rec
		from public.qorpera_surface_reconciliations
		where surface_id = v_ds_surface and selected_change_ids = array[v_ds_c2]
		order by created_at desc
		limit 1;
		perform pg_temp.spl_assert(
			v_ds_rec.id is not null and v_ds_rec.status = 'queued',
			'discard_surface_session must enqueue standalone reconciliation for open cross-session dependent C2'
		);
		perform pg_temp.spl_assert(
			not exists (
				select 1 from public.qorpera_surface_reconciliations
				where surface_id = v_ds_surface and v_ds_c1b = any(selected_change_ids)
			),
			'discard_surface_session must not enqueue standalone reconciliation for same-session discarded change C1b'
		);
		select origin_ref into v_ds_origin_ref
		from public.qorpera_surface_sessions
		where id = v_ds_rec.session_id;
		perform pg_temp.spl_assert(
			jsonb_typeof(v_ds_origin_ref -> 'omittedBaseChanges') = 'array'
				and exists (
					select 1 from jsonb_array_elements(v_ds_origin_ref -> 'omittedBaseChanges') as elem
					where elem ->> 'changeId' = v_ds_c1::text
				),
			'Standalone reconciliation after discard_surface_session must include discarded base C1 in omittedBaseChanges'
		);

		perform pg_temp.spl_as(v_owner);
		insert into public.qorpera_surface_explorations(profile_id, surface_id, title, status)
		values (v_profile, v_ds_surface, 'Discard Exp', 'open')
		returning id into v_ex_id;
		insert into public.qorpera_surface_sessions(profile_id, surface_id, exploration_id, title, prompt, state, origin_kind)
		values (v_profile, v_ds_surface, v_ex_id, 'Variant A', 'Try A', 'ready', 'member')
		returning id into v_ex_v1;
		insert into public.qorpera_surface_sessions(profile_id, surface_id, exploration_id, title, prompt, state, origin_kind)
		values (v_profile, v_ds_surface, v_ex_id, 'Variant B', 'Try B', 'ready', 'member')
		returning id into v_ex_v2;
		perform pg_temp.as_service();
		v_ex_c1 := (public.qorpera_record_surface_change(
			v_ex_v1, 'Exp Base E1', 'Variant A patch', 'folder_patch', null, null, '{}'::uuid[], array['exp.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'exp.md', 'content', 'Exp A' || E'\n'))),
			true
		) ->> 'changeId')::uuid;
		perform pg_temp.spl_as(v_owner);
		v_ex_dep_s := (public.qorpera_start_surface_session(
			v_ds_surface, 'Dep on Exp E1', null, 'member', null,
			jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_ex_c1))
		) ->> 'id')::uuid;
		perform pg_temp.as_service();
		v_ex_dep_c := (public.qorpera_record_surface_change(
			v_ex_dep_s, 'Dep E2', 'Follow-up on E1', 'folder_patch', null, null, '{}'::uuid[], array['exp-dep.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'exp-dep.md', 'content', 'Follow-up' || E'\n'))),
			true
		) ->> 'changeId')::uuid;
		perform pg_temp.spl_as(v_owner);
		perform public.qorpera_discard_exploration(v_ex_id);
		perform pg_temp.as_service();
		select * into v_ex_rec
		from public.qorpera_surface_reconciliations
		where surface_id = v_ds_surface and selected_change_ids = array[v_ex_dep_c]
		order by created_at desc
		limit 1;
		perform pg_temp.spl_assert(
			v_ex_rec.id is not null and v_ex_rec.status = 'queued',
			'discard_exploration must enqueue standalone reconciliation for open dependent E2'
		);

		perform pg_temp.spl_as(v_owner);
		insert into public.qorpera_surface_explorations(profile_id, surface_id, title, status)
		values (v_profile, v_ds_surface, 'Choose Exp', 'open')
		returning id into v_ch_id;
		insert into public.qorpera_surface_sessions(profile_id, surface_id, exploration_id, title, prompt, state, origin_kind)
		values (v_profile, v_ds_surface, v_ch_id, 'Winner A', 'Win A', 'ready', 'member')
		returning id into v_ch_v1;
		insert into public.qorpera_surface_sessions(profile_id, surface_id, exploration_id, title, prompt, state, origin_kind)
		values (v_profile, v_ds_surface, v_ch_id, 'Loser B', 'Lose B', 'ready', 'member')
		returning id into v_ch_v2;
		perform pg_temp.as_service();
		v_ch_c2 := (public.qorpera_record_surface_change(
			v_ch_v2, 'Loser B1', 'Variant B patch', 'folder_patch', null, null, '{}'::uuid[], array['loser.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'loser.md', 'content', 'Loser B' || E'\n'))),
			true
		) ->> 'changeId')::uuid;
		perform pg_temp.spl_as(v_owner);
		v_ch_dep_s := (public.qorpera_start_surface_session(
			v_ds_surface, 'Dep on Loser B1', null, 'member', null,
			jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_ch_c2))
		) ->> 'id')::uuid;
		perform pg_temp.as_service();
		v_ch_dep_c := (public.qorpera_record_surface_change(
			v_ch_dep_s, 'Dep B2', 'Follow-up on B1', 'folder_patch', null, null, '{}'::uuid[], array['loser-dep.md'], null,
			jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'loser-dep.md', 'content', 'Follow-up B' || E'\n'))),
			true
		) ->> 'changeId')::uuid;
		perform pg_temp.spl_as(v_owner);
		perform public.qorpera_choose_exploration(v_ch_id, v_ch_v1);
		perform pg_temp.as_service();
		select * into v_ch_rec
		from public.qorpera_surface_reconciliations
		where surface_id = v_ds_surface and selected_change_ids = array[v_ch_dep_c]
		order by created_at desc
		limit 1;
		perform pg_temp.spl_assert(
			v_ch_rec.id is not null and v_ch_rec.status = 'queued',
			'choose_exploration must enqueue standalone reconciliation for open dependent B2 of discarded loser variant'
		);
	end;
end $$;
