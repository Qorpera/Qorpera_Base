-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sco_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_change_options: %', p_message;
	end if;
end $$;

create function pg_temp.sco_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sco_errcode(p_user_id uuid, p_sql text)
returns text language plpgsql as $$
declare v_errcode text;
begin
	perform pg_temp.sco_as(p_user_id);
	set local role authenticated;
	begin
		execute p_sql;
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	return v_errcode;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_outsider constant uuid := '13770000-0000-4000-8000-000000000099';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_session uuid;
	v_lease uuid;
	v_base_sha constant text := repeat('a', 40);
	v_sha_1 constant text := repeat('1', 40);
	v_sha_2 constant text := repeat('2', 40);
	v_sha_3 constant text := repeat('3', 40);
	v_opt1 uuid;
	v_opt2 uuid;
	v_opt3 uuid;
	v_opt_g2_a uuid;
	v_opt_g2_b uuid;
	v_res jsonb;
	v_turn jsonb;
	v_err text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into auth.users(id, email) values (v_outsider, 'sco-outsider@example.test');

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Brooks', 'brooks', 'live_build', 'website', 'figure:browser', null,
		null, null, false) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Show three website directions', 'Website sketch') ->> 'id')::uuid;
	reset role;

	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surfaces set live_head_sha = v_base_sha where id = v_surface;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '5 minutes', base_sha = v_base_sha
	where id = v_session;

	v_res := public.qorpera_native_surface_record_change(
		v_company, v_session, 'Maegleren', 'Editorial broker landing page', 'git_range',
		v_base_sha, v_sha_1, '{}'::uuid[], array['index.html'], null, null, false, v_lease,
		'homepage-direction', 'Website direction'
	);
	v_opt1 := (v_res ->> 'changeId')::uuid;

	v_res := public.qorpera_native_surface_record_change(
		v_company, v_session, 'Kataloget', 'Catalog-first storefront', 'git_range',
		null, v_sha_2, '{}'::uuid[], array['index.html'], null, null, false, v_lease,
		'homepage-direction', null
	);
	v_opt2 := (v_res ->> 'changeId')::uuid;

	perform pg_temp.sco_assert(
		(select parent_sha = v_base_sha and option_group_key = 'homepage-direction' and option_group_title = 'Website direction'
			from public.qorpera_surface_changes where id = v_opt2),
		'second option inherits shared parent_sha and option_group_title rather than stacking on option 1 head_sha'
	);

	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_session, 'Bad parent', 'Wrong base', 'git_range',
			v_sha_1, v_sha_3, '{}'::uuid[], array['index.html'], null, null, false, v_lease,
			'homepage-direction', null
		);
	exception when others then
		v_err := sqlstate;
	end;
	perform pg_temp.sco_assert(v_err = '22023', 'rejects git option with mismatched parent_sha in same optionGroup');

	v_res := public.qorpera_native_surface_record_change(
		v_company, v_session, 'Handelsbordet', 'Live trading board layout', 'git_range',
		v_base_sha, v_sha_3, '{}'::uuid[], array['index.html'], null, null, false, v_lease,
		'homepage-direction', 'Website direction'
	);
	v_opt3 := (v_res ->> 'changeId')::uuid;

	v_turn := public.qorpera_native_surface_read_session_turn(v_company, v_session, v_lease);
	perform pg_temp.sco_assert(
		jsonb_array_length(v_turn -> 'openChanges') = 3
		and (v_turn -> 'openChanges' -> 1 ->> 'optionGroupKey') = 'homepage-direction'
		and (v_turn -> 'openChanges' -> 1 ->> 'parentSha') = v_base_sha,
		'read_session_turn includes openChanges with optionGroupKey and shared parentSha'
	);

	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_session;

	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_anna, format('select public.qorpera_approve_surface_change(%L::uuid, true)', v_opt2)) = '22023',
		'cannot approve an option directly while sibling options are still open'
	);
	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_anna, format('select public.qorpera_approve_session_all(%L::uuid)', v_session)) = '22023',
		'cannot approve_session_all while an unresolved option group has multiple open options'
	);
	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_outsider, format('select public.qorpera_choose_surface_change_option(%L::uuid)', v_opt2)) = '42501',
		'non-member cannot choose an option'
	);

	insert into public.qorpera_member_surface_state(user_id, surface_id, toggled_change_ids)
	values (v_anna, v_surface, array[v_opt1, v_opt2]);

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	v_res := public.qorpera_choose_surface_change_option(v_opt2);
	reset role;

	perform pg_temp.sco_assert(
		(select status = 'staged' and option_group_key is null and option_group_title is null
			from public.qorpera_surface_changes where id = v_opt2)
		and (select bool_and(status = 'discarded' and discarded_by_exploration)
			from public.qorpera_surface_changes where id in (v_opt1, v_opt3))
		and (select state = 'ready' and branch_head_sha = v_sha_3 from public.qorpera_surface_sessions where id = v_session)
		and (select toggled_change_ids = array[v_opt2] from public.qorpera_member_surface_state where user_id = v_anna and surface_id = v_surface)
		and (v_res ->> 'openChangeCount')::integer = 1,
		'choosing option 2 discards siblings, promotes option 2 to normal staged change, preserves branch_head_sha, and strips discarded toggles'
	);

	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_anna, format('select public.qorpera_undo_surface_change(%L::uuid)', v_opt1)) = '22023',
		'restoring an unchosen option sibling is refused'
	);

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	v_res := public.qorpera_choose_surface_change_option(v_opt2);
	reset role;
	perform pg_temp.sco_assert((v_res ->> 'openChangeCount')::integer = 1, 'choosing already-chosen option is idempotent');

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_opt2, true);
	reset role;
	perform pg_temp.sco_assert(
		(select status = 'merging' from public.qorpera_surface_changes where id = v_opt2)
		and exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_surface
				and j.kind = 'land_change'
				and j.status = 'queued'
				and j.payload -> 'changeIds' = jsonb_build_array(v_opt2::text)
		),
		'chosen option queues a land_change job in tier 2 for only the selected option'
	);

	declare
		v_unrecorded_sha constant text := repeat('9', 40);
		v_claimed jsonb;
		v_merge_job jsonb;
	begin
		update public.qorpera_surface_sessions set branch_head_sha = v_unrecorded_sha where id = v_session;
		v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
		select elem into v_merge_job
		from jsonb_array_elements(v_claimed -> 'merges') elem
		where (elem ->> 'sessionId')::uuid = v_session
		limit 1;
		perform pg_temp.sco_assert(
			v_merge_job is not null
			and (v_merge_job ->> 'sessionBranchHeadSha') = v_unrecorded_sha
			and (v_merge_job -> 'sessionRecordedChangeHeadShas') ? v_sha_1
			and (v_merge_job -> 'sessionRecordedChangeHeadShas') ? v_sha_2
			and (v_merge_job -> 'sessionRecordedChangeHeadShas') ? v_sha_3
			and not ((v_merge_job -> 'sessionRecordedChangeHeadShas') ? v_unrecorded_sha),
			'claim_pending_jobs_for_lane exposes recorded git_range heads without allowing unrecorded branch_head_sha'
		);
		update public.qorpera_surface_sessions set branch_head_sha = v_sha_3 where id = v_session;
	end;

	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '5 minutes', closed_at = null
	where id = v_session;

	v_opt_g2_a := (public.qorpera_native_surface_record_change(
		v_company, v_session, 'Footer A', 'Compact footer', 'folder_patch',
		null, null, '{}'::uuid[], array['footer.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'footer.md', 'content', 'A')),
		false, v_lease, 'footer-style', 'Footer style'
	) ->> 'changeId')::uuid;
	v_opt_g2_b := (public.qorpera_native_surface_record_change(
		v_company, v_session, 'Footer B', 'Wide footer', 'folder_patch',
		null, null, '{}'::uuid[], array['footer.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'footer.md', 'content', 'B')),
		false, v_lease, 'footer-style', null
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_session;

	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_outsider, format('select public.qorpera_discard_surface_option_group(%L::uuid, %L)', v_session, 'footer-style')) = '42501',
		'non-member cannot discard an option group'
	);

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	v_res := public.qorpera_discard_surface_option_group(v_session, 'footer-style');
	reset role;

	perform pg_temp.sco_assert(
		(select bool_and(status = 'discarded') from public.qorpera_surface_changes where id in (v_opt_g2_a, v_opt_g2_b))
		and (v_res ->> 'openChangeCount')::integer = 1,
		'discard_surface_option_group discards every open option in the group while leaving unrelated open changes intact'
	);

	v_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '5 minutes', closed_at = null
	where id = v_session;
	v_opt_g2_a := (public.qorpera_native_surface_record_change(
		v_company, v_session, 'Header A', 'Minimal', 'folder_patch',
		null, null, '{}'::uuid[], array['header.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'header.md', 'content', 'A')),
		false, v_lease, 'header-style', 'Header style'
	) ->> 'changeId')::uuid;
	v_opt_g2_b := (public.qorpera_native_surface_record_change(
		v_company, v_session, 'Header B', 'Full', 'folder_patch',
		null, null, '{}'::uuid[], array['header.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'header.md', 'content', 'B')),
		false, v_lease, 'header-style', null
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_session;

	perform pg_temp.sco_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_opt_g2_a);
	reset role;
	perform pg_temp.sco_assert(
		(select status = 'staged' and option_group_key is null and option_group_title is null
			from public.qorpera_surface_changes where id = v_opt_g2_b),
		'discarding down to one remaining option graduates the survivor to a normal staged change'
	);

	perform pg_temp.sco_assert(
		pg_temp.sco_errcode(v_anna, format('select public.qorpera_undo_surface_change(%L::uuid)', v_opt_g2_a)) = '22023',
		'undo cannot revive a manually discarded option after its sibling graduated out of the option group'
	);

	declare
		v_trio_a uuid;
		v_trio_b uuid;
		v_trio_c uuid;
		v_dep_on_opt uuid;
	begin
		v_lease := extensions.gen_random_uuid();
		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_lease, lease_expires_at = clock_timestamp() + interval '5 minutes', closed_at = null
		where id = v_session;

		v_trio_a := (public.qorpera_native_surface_record_change(
			v_company, v_session, 'Nav A', 'Top nav', 'folder_patch',
			null, null, '{}'::uuid[], array['nav.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'nav.md', 'content', 'A')),
			false, v_lease, 'nav-style', 'Navigation style'
		) ->> 'changeId')::uuid;
		v_trio_b := (public.qorpera_native_surface_record_change(
			v_company, v_session, 'Nav B', 'Side nav', 'folder_patch',
			null, null, '{}'::uuid[], array['nav.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'nav.md', 'content', 'B')),
			false, v_lease, 'nav-style', null
		) ->> 'changeId')::uuid;
		v_trio_c := (public.qorpera_native_surface_record_change(
			v_company, v_session, 'Nav C', 'Compact nav', 'folder_patch',
			null, null, '{}'::uuid[], array['nav.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'nav.md', 'content', 'C')),
			false, v_lease, 'nav-style', null
		) ->> 'changeId')::uuid;
		v_dep_on_opt := (public.qorpera_native_surface_record_change(
			v_company, v_session, 'Badge on Nav B', 'Depends on Nav B', 'folder_patch',
			null, null, array[v_trio_b], array['badge.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'badge.md', 'content', 'Badge')),
			false, v_lease, null, null
		) ->> 'changeId')::uuid;
		update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_session;

		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_anna, format('select public.qorpera_approve_surface_change(%L::uuid, true)', v_dep_on_opt)) = '22023',
			'approving a regular change with dependencies cannot bypass an unresolved option group'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_discard_surface_change(v_trio_a);
		reset role;
		perform pg_temp.sco_assert(
			(select status = 'discarded' from public.qorpera_surface_changes where id = v_trio_a)
			and (select count(*) = 2 from public.qorpera_surface_changes where id in (v_trio_b, v_trio_c) and option_group_key = 'nav-style' and status = 'staged'),
			'discarding 1 of 3 options keeps the remaining 2 grouped'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_undo_surface_change(v_trio_a);
		reset role;
		perform pg_temp.sco_assert(
			(select status = 'staged' and option_group_key = 'nav-style' from public.qorpera_surface_changes where id = v_trio_a),
			'undo still restores a discarded option while 2+ open siblings remain in the group'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_discard_surface_option_group(v_session, 'nav-style');
		perform public.qorpera_discard_surface_change(v_dep_on_opt);
		reset role;
		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_anna, format('select public.qorpera_undo_surface_change(%L::uuid)', v_trio_b)) = '22023',
			'undo cannot revive an option after its entire option group was discarded'
		);
	end;

	declare
		v_viewer constant uuid := '13770000-0000-4000-8000-000000000088';
		v_studio uuid;
		v_studio_session uuid;
		v_dep_session_choose uuid;
		v_dep_session_discard uuid;
		v_internal_session uuid;
		v_studio_lease uuid := extensions.gen_random_uuid();
		v_dep1_lease uuid := extensions.gen_random_uuid();
		v_dep2_lease uuid := extensions.gen_random_uuid();
		v_standalone uuid;
		v_l1 uuid;
		v_l2 uuid;
		v_g1 uuid;
		v_g2 uuid;
		v_dep1 uuid;
		v_dep2 uuid;
		v_msg_count_before integer;
		v_msg_count_after integer;
	begin
		insert into auth.users(id, email) values (v_viewer, 'sco-viewer@example.test');
		insert into public.qorpera_profile_members(profile_id, user_id, email, role)
		values (v_company, v_viewer, 'sco-viewer@example.test', 'viewer');

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		v_studio := (public.qorpera_create_surface(v_company, 'Brand Studio', 'brand-studio', 'studio', 'brand', 'figure:palette', null,
			null, null, false) ->> 'id')::uuid;
		v_studio_session := (public.qorpera_start_surface_session(v_studio, 'Explore layout and copy directions', 'Brand directions') ->> 'id')::uuid;
		reset role;

		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_studio_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
		where id = v_studio_session;

		v_standalone := (public.qorpera_native_surface_record_change(
			v_company, v_studio_session, 'Fix typo', 'Fix title typo', 'folder_patch',
			null, null, '{}'::uuid[], array['copy.md'], null,
			jsonb_build_object(
				'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'copy.md', 'content', 'Clean copy')),
				'baseFiles', jsonb_build_object('copy.md', 'Old copy')
			),
			false, v_studio_lease, null, null
		) ->> 'changeId')::uuid;

		v_l1 := (public.qorpera_native_surface_record_change(
			v_company, v_studio_session, 'Minimal layout', 'Single tab layout', 'folder_patch',
			null, null, '{}'::uuid[], array['layout.json'], null,
			jsonb_build_object(
				'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"schema":"qorpera.surface-layout/v1","tabs":[]}')),
				'baseFiles', jsonb_build_object('layout.json', '{}')
			),
			false, v_studio_lease, 'layout-dir', 'Layout direction'
		) ->> 'changeId')::uuid;

		v_l2 := (public.qorpera_native_surface_record_change(
			v_company, v_studio_session, 'Editorial layout', 'Multi tab layout', 'folder_patch',
			null, null, '{}'::uuid[], array['layout.json'], null,
			jsonb_build_object(
				'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"schema":"qorpera.surface-layout/v1","tabs":[{"title":"Overview","blocks":[]}]}')),
				'baseFiles', jsonb_build_object('layout.json', '{}')
			),
			false, v_studio_lease, 'layout-dir', null
		) ->> 'changeId')::uuid;

		v_g1 := (public.qorpera_native_surface_record_change(
			v_company, v_studio_session, 'Warm tone', 'Warm Danish copy', 'folder_patch',
			null, null, '{}'::uuid[], array['voice.md'], null,
			jsonb_build_object(
				'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'voice.md', 'content', 'Warm')),
				'baseFiles', jsonb_build_object('voice.md', 'Base')
			),
			false, v_studio_lease, 'voice-dir', 'Voice direction'
		) ->> 'changeId')::uuid;

		v_g2 := (public.qorpera_native_surface_record_change(
			v_company, v_studio_session, 'Crisp tone', 'Crisp Danish copy', 'folder_patch',
			null, null, '{}'::uuid[], array['voice.md'], null,
			jsonb_build_object(
				'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'voice.md', 'content', 'Crisp')),
				'baseFiles', jsonb_build_object('voice.md', 'Base')
			),
			false, v_studio_lease, 'voice-dir', null
		) ->> 'changeId')::uuid;

		perform pg_temp.sco_assert(
			(select base_files = jsonb_build_object('layout.json', '{}') from public.qorpera_surface_changes where id = v_l1),
			'grouped folder_patch preserves 20260930888000 baseFiles snapshot extraction'
		);

		v_turn := public.qorpera_native_surface_read_session_turn(v_company, v_studio_session, v_studio_lease);
		perform pg_temp.sco_assert(
			jsonb_array_length(v_turn -> 'openLayoutOps') = 0
			and jsonb_array_length(v_turn -> 'openChanges') = 5,
			'grouped layout.json options stay excluded from openLayoutOps while appearing in openChanges'
		);

		update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_studio_session;

		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_viewer, format('select public.qorpera_choose_surface_change_option(%L::uuid)', v_l2)) = '42501',
			'viewer role cannot choose an option'
		);
		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_viewer, format('select public.qorpera_discard_surface_option_group(%L::uuid, %L)', v_studio_session, 'voice-dir')) = '42501',
			'viewer role cannot discard an option group'
		);
		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_anna, format('select public.qorpera_discard_surface_option_group(%L::uuid, %L)', v_studio_session, 'Bad Key')) = '22023',
			'invalid option group slug is rejected with 22023'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_approve_surface_change(v_standalone, true);
		reset role;
		perform pg_temp.sco_assert(
			(select status in ('merging', 'merged') from public.qorpera_surface_changes where id = v_standalone),
			'standalone change can be approved while sibling option groups remain unresolved'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		v_dep_session_choose := (public.qorpera_start_surface_session(
			v_studio, 'Build on layout L1', 'Dependent on L1', 'member', null,
			jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_l1::text))
		) ->> 'id')::uuid;
		v_dep_session_discard := (public.qorpera_start_surface_session(
			v_studio, 'Build on voice G1', 'Dependent on G1', 'member', null,
			jsonb_build_object('previewBaseChangeIds', jsonb_build_array(v_g1::text))
		) ->> 'id')::uuid;
		reset role;

		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_dep1_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
		where id = v_dep_session_choose;
		v_dep1 := (public.qorpera_native_surface_record_change(
			v_company, v_dep_session_choose, 'Follow-up on L1', 'Adds block on L1', 'folder_patch',
			null, null, '{}'::uuid[], array['notes.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'notes.md', 'content', 'Built on L1')),
			true, v_dep1_lease, null, null
		) ->> 'changeId')::uuid;

		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_dep2_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
		where id = v_dep_session_discard;
		v_dep2 := (public.qorpera_native_surface_record_change(
			v_company, v_dep_session_discard, 'Follow-up on G1', 'Adds tagline on G1', 'folder_patch',
			null, null, '{}'::uuid[], array['tagline.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'tagline.md', 'content', 'Built on G1')),
			true, v_dep2_lease, null, null
		) ->> 'changeId')::uuid;

		perform pg_temp.sco_assert(
			(select preview_base_change_ids = array[v_l1] from public.qorpera_surface_changes where id = v_dep1)
			and (select preview_base_change_ids = array[v_g1] from public.qorpera_surface_changes where id = v_dep2),
			'recreated qorpera_record_surface_change preserves 20260930890000 preview_base_change_ids lineage'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_choose_surface_change_option(v_l2);
		reset role;

		perform pg_temp.sco_assert(
			exists (
				select 1 from public.qorpera_surface_reconciliations r
				where r.surface_id = v_studio
					and r.selected_change_ids = array[v_dep1]
					and r.status in ('queued', 'running', 'ready')
			),
			'choosing L2 enqueues standalone dependent reconciliation for D1 built on discarded L1'
		);

		select count(*) into v_msg_count_before
		from public.qorpera_surface_session_messages where session_id = v_studio_session;
		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_choose_surface_change_option(v_l2);
		reset role;
		select count(*) into v_msg_count_after
		from public.qorpera_surface_session_messages where session_id = v_studio_session;
		perform pg_temp.sco_assert(
			v_msg_count_after = v_msg_count_before,
			're-choosing an already-graduated option does not duplicate Selected option messages'
		);
		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_anna, format('select public.qorpera_choose_surface_change_option(%L::uuid)', v_l1)) = '55000',
			'choosing an already-discarded sibling fails with 55000'
		);

		v_studio_lease := extensions.gen_random_uuid();
		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_studio_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
		where id = v_studio_session;
		v_turn := public.qorpera_native_surface_read_session_turn(v_company, v_studio_session, v_studio_lease);
		perform pg_temp.sco_assert(
			jsonb_array_length(v_turn -> 'openLayoutOps') = 1,
			'graduated L2 layout.json op is now visible in openLayoutOps'
		);
		update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_studio_session;

		perform pg_temp.sco_assert(
			pg_temp.sco_errcode(v_anna, format('select public.qorpera_approve_session_all(%L::uuid)', v_studio_session)) = '22023',
			'approve_session_all stays blocked while a second option group remains unresolved'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_discard_surface_option_group(v_studio_session, 'voice-dir');
		reset role;
		perform pg_temp.sco_assert(
			exists (
				select 1 from public.qorpera_surface_reconciliations r
				where r.surface_id = v_studio
					and r.selected_change_ids = array[v_dep2]
					and r.status in ('queued', 'running', 'ready')
			),
			'discard_surface_option_group enqueues standalone dependent reconciliation for D2 built on discarded G1'
		);

		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		perform public.qorpera_approve_session_all(v_studio_session);
		reset role;
		perform pg_temp.sco_assert(
			(select status in ('merging', 'merged') from public.qorpera_surface_changes where id = v_l2),
			'approve_session_all succeeds once every option group in the session is resolved'
		);

		select r.session_id into v_internal_session
		from public.qorpera_surface_reconciliations r
		where r.surface_id = v_studio and r.session_id is not null
		limit 1;
		perform pg_temp.sco_assert(v_internal_session is not null, 'expected an internal reconciliation session');
		v_err := null;
		begin
			perform public.qorpera_record_surface_change(
				v_internal_session, 'Bad option', 'Should fail', 'folder_patch',
				null, null, '{}'::uuid[], array['notes.md'], null,
				jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'notes.md', 'content', 'X')),
				false, 'bad-group', 'Bad group'
			);
		exception when others then
			v_err := sqlstate;
		end;
		perform pg_temp.sco_assert(v_err = '22023', 'internal reconciliation sessions are forbidden from staging option groups');
	end;

	declare
		v_many_session uuid;
		v_many_lease uuid := extensions.gen_random_uuid();
		v_i integer;
		v_turn jsonb;
	begin
		perform pg_temp.sco_as(v_anna);
		set local role authenticated;
		v_many_session := (public.qorpera_start_surface_session(v_surface, 'Many changes', 'Many changes') ->> 'id')::uuid;
		reset role;

		update public.qorpera_surface_sessions
		set state = 'running', lease_token = v_many_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
		where id = v_many_session;

		for v_i in 1..34 loop
			perform public.qorpera_native_surface_record_change(
				v_company, v_many_session, 'Change ' || v_i::text, 'Step ' || v_i::text, 'folder_patch',
				null, null, '{}'::uuid[], array['c' || v_i::text || '.md'], null,
				jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'c' || v_i::text || '.md', 'content', v_i::text)),
				false, v_many_lease, null, null
			);
		end loop;

		v_turn := public.qorpera_native_surface_read_session_turn(v_company, v_many_session, v_many_lease);
		perform pg_temp.sco_assert(
			jsonb_array_length(v_turn -> 'openChanges') = 32
			and (v_turn -> 'openChanges' -> 0 ->> 'title') = 'Change 3'
			and (v_turn -> 'openChanges' -> 31 ->> 'title') = 'Change 34',
			'openChanges returns the newest 32 open changes in ascending seq order'
		);
	end;
end $$;
