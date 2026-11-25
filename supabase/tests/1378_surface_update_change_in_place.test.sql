-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.suci_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_update_change_in_place: %', p_message;
	end if;
end $$;

create function pg_temp.suci_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env_id uuid;
	v_staff_id uuid;
	v_sponsor_binding_id uuid;
	v_sponsor_version bigint;
	v_priv_leaks integer;
	v_old_overloads integer;
	v_folder_surface uuid;
	v_code_surface uuid;
	v_ops_surface uuid;
	v_f_session uuid;
	v_f_other_session uuid;
	v_f_c1 uuid;
	v_f_other_c1 uuid;
	v_f_res jsonb;
	v_f_change public.qorpera_surface_changes%rowtype;
	v_f_turn jsonb;
	v_f_lease uuid;
	v_c_session uuid;
	v_c_lease uuid;
	v_c_c1 uuid;
	v_c_c2 uuid;
	v_c_res jsonb;
	v_c_change public.qorpera_surface_changes%rowtype;
	v_c_turn jsonb;
	v_c_key_before text;
	v_c_key_after text;
	v_rec_id uuid;
	v_rec_status text;
	v_rec_expired boolean;
	v_preview_id uuid;
	v_preview_expired boolean;
	v_ops_session uuid;
	v_ops_lease uuid;
	v_ops_c1 uuid;
	v_ops_change public.qorpera_surface_changes%rowtype;
	v_ops_turn jsonb;
	v_errcode text;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_sync_session uuid;
	v_sync_c1 uuid;
	v_sync_c2 uuid;
	v_sync_change public.qorpera_surface_changes%rowtype;
	v_msg_count_before integer;
	v_msg_count_after integer;
begin
	select count(*) into v_priv_leaks
	from unnest(array[
		'public.qorpera_surface_deep_merge_jsonb(jsonb,jsonb,integer)',
		'public.qorpera_surface_merge_folder_patch_ops(text,jsonb,jsonb,jsonb)',
		'public.qorpera_surface_session_open_changes_json(public.qorpera_surfaces,uuid)',
		'public.qorpera_surface_reply_target_change_id(uuid)'
	]) as fn(sig)
	cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) as r(role_name)
	where has_function_privilege(r.role_name, fn.sig, 'EXECUTE');
	perform pg_temp.suci_assert(v_priv_leaks = 0, 'Internal update-in-place helpers must have zero API execute grants');

	select count(*) into v_old_overloads
	from pg_proc p
	where p.pronamespace = 'public'::regnamespace
		and p.proname in (
			'qorpera_reply_surface_session',
			'qorpera_reply_surface_session_with_images',
			'qorpera_record_surface_change',
			'qorpera_native_surface_record_change'
		);
	perform pg_temp.suci_assert(v_old_overloads = 4, 'Exactly one overload must remain for each updated surface RPC');

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select environment_id, staff_agent_id into strict v_env_id, v_staff_id
	from public.qorpera_company_cofounders
	where profile_id = v_profile
	limit 1;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, folder_root, status
	)
	values (
		v_profile, 'uip-studio', 'Studio', 'products', 'studio', 'folder', 'surfaces/uip-studio', 'active'
	)
	returning id into v_folder_surface;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, repository_key, live_head_sha, status
	)
	values (
		v_profile, 'uip-site', 'Website', 'products', 'live_build', 'code_repo', 'uip-site', repeat('a', 40), 'active'
	)
	returning id into v_code_surface;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, status
	)
	values (
		v_profile, 'uip-inbox', 'Inbox', 'operations', 'ops', 'native_ops', 'active'
	)
	returning id into v_ops_surface;

	perform pg_temp.suci_as(v_owner);
	v_f_session := (public.qorpera_start_surface_session(v_folder_surface, 'Draft brand brief and layout', 'Brand pass') ->> 'id')::uuid;
	v_f_other_session := (public.qorpera_start_surface_session(v_folder_surface, 'Separate change', 'Other pass') ->> 'id')::uuid;

	v_f_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_f_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_f_session;

	v_f_c1 := (public.qorpera_native_surface_record_change(
		v_profile,
		v_f_session,
		'Initial brief and layout',
		'Created brief and draft note.',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['brief.md', 'scratch.md', 'tokens.json'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', 'Brief v1'),
				jsonb_build_object('op', 'write_text', 'path', 'scratch.md', 'content', 'Temporary scratch'),
				jsonb_build_object('op', 'merge_json', 'path', 'tokens.json', 'patch', jsonb_build_object('colors', jsonb_build_object('accent', '#112233', 'paper', '#ffffff')))
			),
			'baseFiles', jsonb_build_object(
				'brief.md', 'Live brief',
				'scratch.md', null
			)
		),
		false,
		v_f_lease
	) ->> 'changeId')::uuid;

	v_f_other_c1 := (public.qorpera_record_surface_change(
		v_f_other_session,
		'Other session brief tweak',
		'Tweak brief.',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['brief.md'],
		null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', 'Other brief')),
		true
	) ->> 'changeId')::uuid;

	insert into public.qorpera_surface_reconciliations(
		profile_id, surface_id, composition_key, base_fingerprint, selected_change_ids, status, reconciled_patch_manifest, expires_at
	)
	values (
		v_profile, v_folder_surface, 'stale-rec-key-folder', 'folder-rev:0', array[v_f_c1, v_f_other_c1],
		'ready', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', 'Old reconciled')),
		clock_timestamp() + interval '1 hour'
	)
	returning id into v_rec_id;

	perform public.qorpera_surface_complete_session_turn(v_f_session, 'ready', 'Draft ready.', null, null, null, v_f_lease);

	begin
		perform pg_temp.suci_as(v_owner);
		perform public.qorpera_reply_surface_session(v_f_session, 'Wrong change id', true, v_f_other_c1);
		perform pg_temp.suci_assert(false, 'reply must reject change_id from another session');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'cross-session change_id must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_f_session, 'Re: [Initial brief and layout]' || E'\n' || 'Tighten the brief and drop scratch.', true, v_f_c1);

	perform pg_temp.suci_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_f_session and m.author_kind = 'member' and m.change_id = v_f_c1
		),
		'reply persists target change_id on member message'
	);

	v_f_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_f_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_f_session;

	v_f_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_f_session, v_f_lease);
	perform pg_temp.suci_assert(
		v_f_turn ->> 'replyChangeId' = v_f_c1::text
		and jsonb_array_length(v_f_turn -> 'sessionOpenChanges') = 1
		and (v_f_turn -> 'sessionOpenChanges' -> 0 ->> 'changeId') = v_f_c1::text
		and jsonb_typeof(v_f_turn -> 'sessionOpenChanges' -> 0 -> 'patchManifest') = 'array',
		'read_session_turn exposes sessionOpenChanges with manifest and replyChangeId: ' || v_f_turn::text
	);

	select count(*) into v_msg_count_before from public.qorpera_surface_session_messages where session_id = v_f_session;

	v_f_res := public.qorpera_native_surface_record_change(
		v_profile,
		v_f_session,
		'Tighter brief and tokens',
		'Revised brief, updated tokens, removed scratch.',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['brief.md', 'scratch.md', 'tokens.json', 'extra.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', 'Brief v2'),
				jsonb_build_object('op', 'delete', 'path', 'scratch.md'),
				jsonb_build_object('op', 'merge_json', 'path', 'tokens.json', 'patch', jsonb_build_object('colors', jsonb_build_object('accent', '#445566'), 'radius', '12px')),
				jsonb_build_object('op', 'write_text', 'path', 'extra.md', 'content', 'Extra note')
			),
			'baseFiles', jsonb_build_object(
				'brief.md', 'Brief v1',
				'extra.md', null
			)
		),
		false,
		v_f_lease,
		v_f_c1
	);

	select count(*) into v_msg_count_after from public.qorpera_surface_session_messages where session_id = v_f_session;
	select * into strict v_f_change from public.qorpera_surface_changes where id = v_f_c1;

	perform pg_temp.suci_assert(
		v_f_res ->> 'changeId' = v_f_c1::text
		and (v_f_res ->> 'seq')::integer = 1
		and (v_f_res ->> 'updated')::boolean = true
		and (select count(*) from public.qorpera_surface_changes where session_id = v_f_session) = 1
		and v_msg_count_after = v_msg_count_before,
		'folder_patch in-place update keeps single change row, seq 1, and no duplicate Staged change message'
	);
	perform pg_temp.suci_assert(
		v_f_change.title = 'Tighter brief and tokens'
		and v_f_change.base_files ->> 'brief.md' = 'Live brief'
		and (v_f_change.base_files ? 'extra.md') and jsonb_typeof(v_f_change.base_files -> 'extra.md') = 'null'
		and not (v_f_change.base_files ? 'scratch.md')
		and not ('scratch.md' = any(v_f_change.affected_paths))
		and 'brief.md' = any(v_f_change.affected_paths)
		and 'tokens.json' = any(v_f_change.affected_paths)
		and 'extra.md' = any(v_f_change.affected_paths)
		and jsonb_array_length(v_f_change.patch_manifest) = 3
		and (
			select elem -> 'patch'
			from jsonb_array_elements(v_f_change.patch_manifest) as elem
			where elem ->> 'path' = 'tokens.json'
			limit 1
		) = jsonb_build_object('colors', jsonb_build_object('accent', '#445566', 'paper', '#ffffff'), 'radius', '12px'),
		'folder_patch update preserves original live base_files, coalesces merge_json deeply, drops Turn-1-created delete, and updates affected_paths: '
			|| coalesce(v_f_change.patch_manifest::text, 'null') || ' base=' || coalesce(v_f_change.base_files::text, 'null')
	);

	select expires_at <= clock_timestamp() into strict v_rec_expired
	from public.qorpera_surface_reconciliations
	where id = v_rec_id;
	perform pg_temp.suci_assert(v_rec_expired, 'in-place update expires stale cached reconciliations referencing the change');

	v_f_res := public.qorpera_native_surface_record_change(
		v_profile,
		v_f_session,
		'Fresh start brief',
		'Replaced entire patch.',
		'folder_patch',
		null,
		null,
		'{}'::uuid[],
		array['brief.md'],
		null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', 'Brand new brief')
			),
			'baseFiles', jsonb_build_object('brief.md', 'Brief v2'),
			'replaceAll', true
		),
		false,
		v_f_lease,
		v_f_c1
	);
	select * into strict v_f_change from public.qorpera_surface_changes where id = v_f_c1;
	perform pg_temp.suci_assert(
		jsonb_array_length(v_f_change.patch_manifest) = 1
		and v_f_change.affected_paths = array['brief.md']
		and v_f_change.base_files ->> 'brief.md' = 'Live brief',
		'replaceAll replaces full folder_patch manifest while still preserving original live base_files'
	);

	perform public.qorpera_surface_complete_session_turn(v_f_session, 'ready', 'Updated.', null, null, null, v_f_lease);

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_f_session, 'Plain follow-up without quote');
	v_f_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_f_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_f_session;
	v_f_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_f_session, v_f_lease);
	perform pg_temp.suci_assert(
		v_f_turn -> 'replyChangeId' = 'null'::jsonb,
		'plain follow-up reply clears replyChangeId instead of sticking to an earlier targeted change'
	);

	perform pg_temp.suci_as(v_owner);
	v_c_session := (public.qorpera_start_surface_session(v_code_surface, 'Sketch three directions', 'Website sketch') ->> 'id')::uuid;
	v_c_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_c_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_c_session;

	v_c_c1 := (public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Tre retninger', 'First sketch.', 'git_range',
		repeat('a', 40), repeat('b', 40), '{}'::uuid[], array['index.html'], null, null, false, v_c_lease
	) ->> 'changeId')::uuid;

	v_c_key_before := public.qorpera_surface_preview_composition_key(v_code_surface, repeat('a', 40), array[v_c_c1], null);
	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids, status, expires_at
	)
	values (
		v_profile, v_code_surface, v_c_key_before, '12345678', repeat('a', 40), array[v_c_c1], 'composing', clock_timestamp() + interval '1 hour'
	)
	returning id into v_preview_id;

	v_c_res := public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Three revised designs', 'Superpower-inspired take.', 'git_range',
		null, repeat('c', 40), '{}'::uuid[], array['index.html', 'styles.css'], null, null, false, v_c_lease, v_c_c1
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c1;
	v_c_key_after := public.qorpera_surface_preview_composition_key(v_code_surface, repeat('a', 40), array[v_c_c1], null);
	select expires_at <= clock_timestamp() into strict v_preview_expired from public.qorpera_surface_previews where id = v_preview_id;

	perform pg_temp.suci_assert(
		v_c_res ->> 'changeId' = v_c_c1::text
		and (select count(*) from public.qorpera_surface_changes where session_id = v_c_session) = 1
		and v_c_change.parent_sha = repeat('a', 40)
		and v_c_change.head_sha = repeat('c', 40)
		and v_c_change.title = 'Three revised designs'
		and v_c_key_after <> v_c_key_before
		and v_preview_expired,
		'git_range update preserves original parent_sha when omitted, advances head_sha, changes preview key, and expires old composing preview'
	);

	perform public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Three revised designs v2', 'Polished typography.', 'git_range',
		repeat('c', 40), repeat('e', 40), '{}'::uuid[], array['index.html', 'styles.css'], null, null, false, v_c_lease, v_c_c1
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c1;
	perform pg_temp.suci_assert(
		v_c_change.parent_sha = repeat('a', 40)
		and v_c_change.head_sha = repeat('e', 40),
		'git_range update preserves original parent_sha even if caller passes prior head_sha as parent_sha'
	);

	v_c_c2 := (public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Pricing section', 'Added pricing table.', 'git_range',
		repeat('e', 40), repeat('f', 40), array[v_c_c1], array['pricing.html'], null, null, false, v_c_lease
	) ->> 'changeId')::uuid;

	perform public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Pricing section v2', 'Tightened pricing copy.', 'git_range',
		null, repeat('1', 40), null, array['pricing.html'], null, null, false, v_c_lease, v_c_c2
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c2;
	perform pg_temp.suci_assert(
		v_c_change.parent_sha = repeat('e', 40)
		and v_c_change.head_sha = repeat('1', 40)
		and v_c_change.depends_on_change_ids = array[v_c_c1],
		'updating a change with null depends_on_change_ids preserves existing dependencies'
	);

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Non-tip omit parent', 'Should refuse.', 'git_range',
			null, repeat('2', 40), null, '{}'::text[], null, null, false, v_c_lease, v_c_c1
		);
		perform pg_temp.suci_assert(false, 'updating non-tip git_range without explicit parent_sha must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'non-tip null parent must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Non-tip wrong parent', 'Should refuse.', 'git_range',
			repeat('1', 40), repeat('2', 40), null, '{}'::text[], null, null, false, v_c_lease, v_c_c1
		);
		perform pg_temp.suci_assert(false, 'updating non-tip git_range with tip head_sha as parent_sha must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'non-tip mismatched parent must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Tip bogus parent', 'Should refuse.', 'git_range',
			repeat('9', 40), repeat('2', 40), null, '{}'::text[], null, null, false, v_c_lease, v_c_c2
		);
		perform pg_temp.suci_assert(false, 'updating tip git_range with unrelated parent_sha without rebase must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'unrelated parent without rebase must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	perform public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Hero rebased', 'Rebased hero commit.', 'git_range',
		repeat('a', 40), repeat('7', 40), null, array['index.html'], null, null, false, v_c_lease, v_c_c1
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c2;
	perform pg_temp.suci_assert(
		v_c_change.status = 'conflicted',
		'updating non-tip git_range head_sha immediately marks chained downstream change conflicted until re-recorded'
	);

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Stale parent no rebase', 'Should refuse.', 'git_range',
			repeat('e', 40), repeat('8', 40), null, array['pricing.html'], null, null, false, v_c_lease, v_c_c2
		);
		perform pg_temp.suci_assert(false, 're-recording conflicted downstream change with stale parent_sha must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'stale-parent conflicted update must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Omitted parent while conflicted', 'Should refuse.', 'git_range',
			null, repeat('8', 40), null, array['pricing.html'], null, null, false, v_c_lease, v_c_c2
		);
		perform pg_temp.suci_assert(false, 're-recording conflicted downstream change without moving parent_sha must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'omitted-parent conflicted update must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c2;
	perform pg_temp.suci_assert(
		v_c_change.status = 'conflicted',
		'refused stale-parent updates leave downstream change conflicted'
	);

	perform public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Pricing rebased', 'Rebased pricing on new hero.', 'git_range',
		repeat('7', 40), repeat('8', 40), null, array['pricing.html'], null,
		jsonb_build_object('rebase', true), false, v_c_lease, v_c_c2
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c2;
	perform pg_temp.suci_assert(
		(select head_sha from public.qorpera_surface_changes where id = v_c_c1) = repeat('7', 40)
		and v_c_change.status = 'staged'
		and v_c_change.parent_sha = repeat('7', 40)
		and v_c_change.head_sha = repeat('8', 40)
		and v_c_change.depends_on_change_ids = array[v_c_c1],
		'explicit rebase restores downstream change to staged while preserving omitted dependencies'
	);

	perform public.qorpera_native_surface_record_change(
		v_profile, v_c_session, 'Pricing independent', 'Cleared dependency after rebase.', 'git_range',
		repeat('7', 40), repeat('8', 40), '{}'::uuid[], array['pricing.html'], null, null, false, v_c_lease, v_c_c2
	);
	select * into strict v_c_change from public.qorpera_surface_changes where id = v_c_c2;
	perform pg_temp.suci_assert(
		v_c_change.depends_on_change_ids = '{}'::uuid[],
		'explicit empty depends_on_change_ids array clears existing dependencies on update'
	);

	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'Bad self dep', 'Bad.', 'git_range',
			null, repeat('d', 40), array[v_c_c2], '{}'::text[], null, null, false, v_c_lease, v_c_c2
		);
		perform pg_temp.suci_assert(false, 'updating a change with self-dependency must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'self-dependency must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	update public.qorpera_surface_changes set status = 'merged', resolved_at = clock_timestamp() where id = v_c_c1;
	begin
		perform public.qorpera_native_surface_record_change(
			v_profile, v_c_session, 'After merge', 'Bad.', 'git_range',
			null, repeat('d', 40), '{}'::uuid[], '{}'::text[], null, null, false, v_c_lease, v_c_c1
		);
		perform pg_temp.suci_assert(false, 'updating a merged change must fail');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.suci_assert(v_errcode = '22023', 'updating merged change must fail with 22023, got ' || coalesce(v_errcode, 'null'));
	end;

	perform pg_temp.suci_as(v_owner);
	v_ops_session := (public.qorpera_start_surface_session(v_ops_surface, 'Draft reply to customer', 'Customer reply') ->> 'id')::uuid;
	v_ops_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_ops_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_ops_session;

	v_ops_c1 := (public.qorpera_native_surface_record_change(
		v_profile, v_ops_session, 'Re: Pricing', 'Initial email draft.', 'ops_action',
		null, null, '{}'::uuid[], array['mailto:ada@example.com'], null,
		jsonb_build_object('actionKind', 'inbox.draft_email', 'actionPayload', jsonb_build_object('body', 'Draft v1')),
		false, v_ops_lease
	) ->> 'changeId')::uuid;

	v_ops_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_ops_session, v_ops_lease);
	perform pg_temp.suci_assert(
		jsonb_array_length(v_ops_turn -> 'sessionOpenChanges') = 1
		and (v_ops_turn -> 'sessionOpenChanges' -> 0 ->> 'actionKind') = 'inbox.draft_email',
		'ops_action open change includes actionKind in read_session_turn'
	);

	perform public.qorpera_native_surface_record_change(
		v_profile, v_ops_session, 'Re: Pricing (shorter)', 'Shortened email draft.', 'ops_action',
		null, null, '{}'::uuid[], array['mailto:ada@example.com'], null,
		jsonb_build_object('actionKind', 'inbox.draft_email', 'actionPayload', jsonb_build_object('body', 'Draft v2')),
		false, v_ops_lease, v_ops_c1
	);
	select * into strict v_ops_change from public.qorpera_surface_changes where id = v_ops_c1;
	perform pg_temp.suci_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_ops_session) = 1
		and v_ops_change.title = 'Re: Pricing (shorter)'
		and v_ops_change.patch_manifest #>> '{actionPayload,body}' = 'Draft v2',
		'ops_action updates in place without duplicating action cards'
	);

	perform pg_temp.suci_as(v_owner);
	v_sync_session := (public.qorpera_start_surface_session(v_code_surface, 'Build landing hero', 'Landing hero') ->> 'id')::uuid;

	select sv.binding_id, sv.version
	into strict v_sponsor_binding_id, v_sponsor_version
	from public.qorpera_execution_sponsor_versions sv
	join public.qorpera_execution_sponsor_bindings sb on sb.id = sv.binding_id
	where sb.profile_id = v_profile
	order by sv.version desc
	limit 1;

	insert into public.qorpera_runtime_workers(
		profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
		access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
		owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
		surface_backed, surface_session_id
	)
	values (
		v_profile, v_env_id, v_staff_id, null,
		'surface-' || replace(v_sync_session::text, '-', ''), 'coding', 'Landing hero',
		'read', 'each', jsonb_build_object('goal', 'Build landing hero'), 'active', 1, v_owner, null,
		v_owner, v_sponsor_binding_id, v_sponsor_version,
		true, v_sync_session
	)
	returning * into v_worker;

	insert into public.qorpera_coding_sessions(
		worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
		phase, surface_session_id
	)
	values (
		v_worker.id, v_profile, v_env_id, null, 'codex',
		jsonb_build_object('host', 'qorpera', 'owner', 'qorpera', 'name', 'uip-site', 'baseBranch', 'main'),
		'qorpera/coding/' || v_worker.id::text, repeat('a', 40), 'running', v_sync_session
	)
	returning * into v_coding;

	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 1, 'dispatch', null);

	update public.qorpera_surface_sessions
	set worker_id = v_worker.id, state = 'running', lease_token = extensions.gen_random_uuid(), base_sha = repeat('a', 40)
	where id = v_sync_session;

	v_sync_c1 := (public.qorpera_record_surface_change(
		v_sync_session, 'Hero direction v1', 'Initial hero.', 'git_range',
		repeat('a', 40), repeat('1', 40), '{}'::uuid[], '{}'::text[], null, null, false
	) ->> 'changeId')::uuid;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Turn 1 complete.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('1', 40), 'baseSha', repeat('a', 40)))
	);

	update public.qorpera_runtime_workers set sequence = 2 where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 2, 'member', 'Try a Superpower-style direction instead.');

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = extensions.gen_random_uuid()
	where id = v_sync_session;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Revised hero in Superpower direction.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('2', 40), 'baseSha', repeat('a', 40)))
	);

	select * into strict v_sync_change from public.qorpera_surface_changes where id = v_sync_c1;
	perform pg_temp.suci_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_sync_session) = 1
		and v_sync_change.parent_sha = repeat('a', 40)
		and v_sync_change.head_sha = repeat('2', 40)
		and v_sync_change.title = 'Hero direction v1'
		and v_sync_change.summary = 'Revised hero in Superpower direction.',
		'follow-up coding_finish auto-sync updates single open change in place preserving parent_sha and title'
	);

	v_sync_c2 := (public.qorpera_record_surface_change(
		v_sync_session, 'Pricing section', 'Added pricing.', 'git_range',
		repeat('2', 40), repeat('3', 40), '{}'::uuid[], '{}'::text[], null, null, false
	) ->> 'changeId')::uuid;

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_sync_session, 'Make pricing tighter', true, v_sync_c2);

	update public.qorpera_runtime_workers set sequence = 3 where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 3, 'member', 'Make pricing tighter');

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = extensions.gen_random_uuid()
	where id = v_sync_session;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Tightened pricing.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('4', 40), 'baseSha', repeat('a', 40)))
	);

	select * into strict v_sync_change from public.qorpera_surface_changes where id = v_sync_c2;
	perform pg_temp.suci_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_sync_session) = 2
		and v_sync_change.parent_sha = repeat('2', 40)
		and v_sync_change.head_sha = repeat('4', 40),
		'follow-up coding_finish auto-sync updates targeted tip change in place on multi-change session'
	);

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_sync_session, 'Also add footer');

	update public.qorpera_runtime_workers set sequence = 4 where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 4, 'member', 'Also add footer');

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = extensions.gen_random_uuid()
	where id = v_sync_session;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Added footer.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('5', 40), 'baseSha', repeat('a', 40)))
	);

	perform pg_temp.suci_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_sync_session) = 3,
		'untargeted follow-up coding_finish on multi-change session inserts new change instead of clobbering'
	);

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_sync_session, 'Make hero blue', true, v_sync_c1);

	update public.qorpera_runtime_workers set sequence = 5 where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 5, 'member', 'Make hero blue');

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = extensions.gen_random_uuid()
	where id = v_sync_session;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Hero tweak on tip.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('6', 40), 'baseSha', repeat('a', 40)))
	);

	select * into strict v_sync_change from public.qorpera_surface_changes where id = v_sync_c1;
	perform pg_temp.suci_assert(
		v_sync_change.parent_sha = repeat('a', 40)
		and v_sync_change.head_sha = repeat('2', 40)
		and (select count(*) from public.qorpera_surface_changes where session_id = v_sync_session) = 4,
		'follow-up coding_finish targeting a non-tip change must not corrupt its commit range'
	);

	select * into strict v_sync_change
	from public.qorpera_surface_changes
	where session_id = v_sync_session
	order by seq desc, id desc
	limit 1;

	perform pg_temp.suci_as(v_owner);
	perform public.qorpera_reply_surface_session(v_sync_session, 'Tweak latest change', true, v_sync_change.id);

	update public.qorpera_runtime_workers set sequence = 6 where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 6, 'member', 'Tweak latest change');

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = extensions.gen_random_uuid()
	where id = v_sync_session;

	perform public.qorpera_record_surface_change(
		v_sync_session, 'Hero rebased during tip turn', 'Moved base change head.', 'git_range',
		repeat('a', 40), repeat('9', 40), null, '{}'::text[], null, null, false, v_sync_c1
	);

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Finished without re-recording conflicted tip.', null, null,
		jsonb_build_array(jsonb_build_object('headSha', repeat('b', 40), 'baseSha', repeat('a', 40)))
	);

	select * into strict v_sync_change
	from public.qorpera_surface_changes
	where id = v_sync_change.id;
	perform pg_temp.suci_assert(
		v_sync_change.status = 'conflicted'
		and v_sync_change.parent_sha = repeat('5', 40)
		and v_sync_change.head_sha = repeat('6', 40)
		and (select count(*) from public.qorpera_surface_changes where session_id = v_sync_session) = 4
		and exists (
			select 1
			from public.qorpera_surface_session_messages m
			where m.session_id = v_sync_session
				and m.author_kind = 'system'
				and m.change_id = v_sync_change.id
				and m.body like 'Latest commits were not staged:%'
		),
		'coding_finish sync leaves conflicted stacked tip conflicted and records a system message'
	);
end $$;
