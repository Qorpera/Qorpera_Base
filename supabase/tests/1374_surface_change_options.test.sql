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
	v_outsider constant uuid := '13740000-0000-4000-8000-000000000099';
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
end $$;
