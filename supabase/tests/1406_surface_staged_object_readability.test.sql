-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."

create function pg_temp.t1406_as_member(p_n integer) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63000000-0000-4000-8000-00000000000' || p_n)::text, true)::text::void
$$;

create function pg_temp.t1406_ok(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception '1406 failed: %', p_msg;
	end if;
end $$;

create function pg_temp.t1406_state_of(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;

insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'surface-staged-stranger@example.test');

do $$
declare
	v_env uuid := '63000000-0000-4000-8000-000000000020';
	v_profile uuid := '63000000-0000-4000-8000-000000000010';
	v_user1 uuid := '63000000-0000-4000-8000-000000000001';
	v_surface_id uuid := '63000000-0000-4000-8000-000000009001';
	v_session_id uuid := '63000000-0000-4000-8000-000000009002';
	v_change_id uuid := '63000000-0000-4000-8000-000000009003';
	v_locked_change_id uuid := '63000000-0000-4000-8000-000000009004';
	v_secret_change_id uuid := '63000000-0000-4000-8000-000000009005';
	v_img_file jsonb := pg_temp.stage('staged-studio-image-bytes');
	v_img_manifest text := v_img_file ->> 'manifestSha256';
	v_img_chunk text;
	v_locked_file jsonb := pg_temp.stage('staged-locked-file-bytes');
	v_locked_manifest text := v_locked_file ->> 'manifestSha256';
	v_secret_file jsonb := pg_temp.stage('staged-secret-file-bytes');
	v_secret_manifest text := v_secret_file ->> 'manifestSha256';
	v_auth jsonb;
	v_role text;
begin
	select chunk_sha256 into v_img_chunk
	from public.qorpera_folder_file_chunks
	where profile_id = v_profile and manifest_sha256 = v_img_manifest
	limit 1;
	perform pg_temp.t1406_ok(v_img_chunk is not null, 'chunk indexed for staged image');

	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.t1406_ok(
			not has_table_privilege(v_role, 'public.qorpera_surface_change_files', 'SELECT'),
			'table select revoked for ' || v_role);
		perform pg_temp.t1406_ok(
			not has_function_privilege(v_role, 'public.qorpera_sync_surface_change_files(uuid)', 'EXECUTE'),
			'sync function revoked for ' || v_role);
		perform pg_temp.t1406_ok(
			not has_function_privilege(v_role, 'public.qorpera_surface_change_file_company_path(text,text)', 'EXECUTE'),
			'path helper revoked for ' || v_role);
		perform pg_temp.t1406_ok(
			not has_function_privilege(v_role, 'public.qorpera_folder_object_readable_state(uuid,uuid,jsonb,text)', 'EXECUTE'),
			'readable_state revoked for ' || v_role);
	end loop;

	update public.qorpera_folder_upload_intents
	set expires_at = clock_timestamp() - interval '48 hours'
	where profile_id = v_profile;

	perform pg_temp.t1406_ok(
		not public.qorpera_folder_object_rooted(v_profile, v_img_manifest),
		'unreferenced staged image is not rooted before surface change exists');

	perform pg_temp.t1406_as_member(3);
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_img_manifest)) like '42501 %',
		'member cannot read unreferenced staged object');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	insert into public.qorpera_surfaces (
		id, profile_id, slug, title, surface_group, archetype, status, icon, source_kind, folder_root, created_by_user_id
	) values (
		v_surface_id, v_profile, 'product-preview-test', 'Product Preview Test', 'products', 'studio', 'active', 'box', 'folder', 'surfaces/product-preview-test', v_user1
	);

	insert into public.qorpera_surface_sessions (
		id, profile_id, surface_id, title, prompt, created_by_user_id
	) values (
		v_session_id, v_profile, v_surface_id, 'Stage preview render', 'Render preview visual', v_user1
	);

	insert into public.qorpera_surface_changes (
		id, profile_id, surface_id, session_id, seq, kind, title, summary, affected_paths, patch_manifest, status
	) values (
		v_change_id,
		v_profile,
		v_surface_id,
		v_session_id,
		1,
		'folder_patch',
		'Add concept render',
		'Adds studio render',
		array['modules/hero/renders/worn.png'],
		jsonb_build_array(
			jsonb_build_object('op', 'write_file', 'path', 'modules/hero/renders/worn.png', 'file', v_img_file)
		),
		'staged'
	);

	perform pg_temp.t1406_ok(
		public.qorpera_folder_object_rooted(v_profile, v_img_manifest),
		'staged surface manifest is rooted against GC');
	perform pg_temp.t1406_ok(
		public.qorpera_folder_object_rooted(v_profile, v_img_chunk),
		'staged surface chunk is rooted against GC');

	perform pg_temp.t1406_as_member(3);
	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_img_manifest);
	perform pg_temp.t1406_ok(
		(v_auth ->> 'profileId')::uuid = v_profile and (v_auth ->> 'viaActive')::boolean = false,
		'member can authorize staged manifest with viaActive=false');
	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_img_chunk);
	perform pg_temp.t1406_ok(
		(v_auth ->> 'profileId')::uuid = v_profile and (v_auth ->> 'viaActive')::boolean = false,
		'member can authorize staged chunk with viaActive=false');
	perform pg_temp.t1406_ok(
		(public.qorpera_member_folder_object(v_env, v_img_chunk) ->> 'profileId')::uuid = v_profile,
		'legacy member object RPC authorizes staged chunk');

	perform pg_temp.t1406_as_member(5);
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_img_manifest)) like '42501 %',
		'non-member cannot read staged surface object');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	insert into public.qorpera_surface_changes (
		id, profile_id, surface_id, session_id, seq, kind, title, summary, affected_paths, patch_manifest, status
	) values (
		v_locked_change_id,
		v_profile,
		v_surface_id,
		v_session_id,
		2,
		'folder_patch',
		'Locked path',
		'Locked path test',
		array['/locked/private.png'],
		jsonb_build_array(
			jsonb_build_object('op', 'write_file', 'path', '/locked/private.png', 'file', v_locked_file)
		),
		'staged'
	), (
		v_secret_change_id,
		v_profile,
		v_surface_id,
		v_session_id,
		3,
		'folder_patch',
		'Secret path',
		'Secret path test',
		array['/secrets/key.bin'],
		jsonb_build_array(
			jsonb_build_object('op', 'write_file', 'path', '/secrets/key.bin', 'file', v_secret_file)
		),
		'staged'
	);

	perform pg_temp.t1406_as_member(3);
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_locked_manifest)) like '42501 %',
		'member without access to /locked cannot read staged file targeting /locked');
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_secret_manifest)) like '42501 %',
		'member cannot read staged file targeting /secrets');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	update public.qorpera_surface_changes
	set patch_manifest = patch_manifest || jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'modules/hero/renders/worn.png')
	)
	where id = v_change_id;

	perform pg_temp.t1406_ok(
		not public.qorpera_folder_object_rooted(v_profile, v_img_manifest),
		'overwriting write_file with delete in patch removes root');

	update public.qorpera_surface_changes
	set patch_manifest = jsonb_build_array(
		jsonb_build_object('op', 'write_file', 'path', 'modules/hero/renders/worn.png', 'file', v_img_file)
	)
	where id = v_change_id;

	perform pg_temp.t1406_ok(
		public.qorpera_folder_object_rooted(v_profile, v_img_manifest),
		'restoring write_file re-roots manifest');

	update public.qorpera_surface_changes
	set status = 'discarded'
	where id = v_change_id;

	perform pg_temp.t1406_ok(
		not public.qorpera_folder_object_rooted(v_profile, v_img_manifest),
		'discarding surface change unroots staged manifest');

	perform pg_temp.t1406_as_member(3);
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_img_manifest)) like '42501 %',
		'member can no longer read staged manifest after change is discarded');
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format(
			'select public.qorpera_member_folder_object_fence(%L, %L, %s, %L::timestamptz, false)',
			v_env, v_img_manifest, (v_auth ->> 'authoritySeq')::bigint, v_auth ->> 'checkedAt'
		)) like '42501 %',
		'fence recheck denies discarded staged manifest when viaActive=false');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	update public.qorpera_surface_changes set status = 'staged' where id = v_change_id;
	update public.qorpera_surfaces set folder_root = 'locked' where id = v_surface_id;
	perform pg_temp.t1406_as_member(3);
	perform pg_temp.t1406_ok(
		pg_temp.t1406_state_of(format('select public.qorpera_member_folder_object(%L, %L)', v_env, v_img_manifest)) like '42501 %',
		'updating surface folder_root to restricted folder revokes staged object read');
end $$;
