-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sdaa_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_discard_agent_awareness: %', p_message;
	end if;
end $$;

create function pg_temp.sdaa_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sdaa_open_turn(p_session uuid, p_lease uuid)
returns void language plpgsql as $$
begin
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = p_lease, lease_expires_at = clock_timestamp() + interval '5 minutes',
		updated_at = clock_timestamp()
	where id = p_session;
end $$;

create function pg_temp.sdaa_read_turn(p_company uuid, p_session uuid, p_lease uuid)
returns jsonb language plpgsql as $$
declare
	v_turn jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(p_company, p_session, p_lease);
	reset role;
	return v_turn;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_site uuid;
	v_studio uuid;
	v_code_session uuid;
	v_opt_session uuid;
	v_studio_session uuid;
	v_main_sha constant text := repeat('1', 40);
	v_c1_sha constant text := repeat('2', 40);
	v_c2_sha constant text := repeat('3', 40);
	v_c3_sha constant text := repeat('4', 40);
	v_c4_sha constant text := repeat('5', 40);
	v_c5_sha constant text := repeat('8', 40);
	v_opt1_sha constant text := repeat('6', 40);
	v_opt2_sha constant text := repeat('7', 40);
	v_lease_1 constant uuid := '13840000-0000-4000-8000-000000000101';
	v_lease_2 constant uuid := '13840000-0000-4000-8000-000000000102';
	v_lease_3 constant uuid := '13840000-0000-4000-8000-000000000103';
	v_lease_4 constant uuid := '13840000-0000-4000-8000-000000000104';
	v_lease_5 constant uuid := '13840000-0000-4000-8000-000000000105';
	v_lease_6 constant uuid := '13840000-0000-4000-8000-000000000106';
	v_lease_7 constant uuid := '13840000-0000-4000-8000-000000000107';
	v_lease_8 constant uuid := '13840000-0000-4000-8000-000000000108';
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_c4 uuid;
	v_s1 uuid;
	v_s2 uuid;
	v_res jsonb;
	v_turn jsonb;
	v_msg_count_before integer;
	v_msg_count_after integer;
	v_err_state text;
	v_err_msg text;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_cs public.qorpera_coding_sessions%rowtype;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	v_site := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'studio', 'website', 'figure:browser', null,
		'surfaces/website', null, false
	) ->> 'id')::uuid;
	v_studio := (public.qorpera_create_surface(
		v_company, 'Identity', 'identity', 'studio', 'identity', 'figure:sparkles', null,
		'identity', null, false
	) ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces
	set source_kind = 'code_repo', repository_key = 'acme/website', live_head_sha = v_main_sha
	where id = v_site;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	v_code_session := (public.qorpera_start_surface_session(
		v_site, 'Sketch the website', 'Website sketches'
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sdaa_open_turn(v_code_session, v_lease_1);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_res := public.qorpera_native_surface_record_change(
		v_company, v_code_session, 'Three calm directions', 'Initial calm homepage directions.',
		'git_range', v_main_sha, v_c1_sha, '{}'::uuid[], array['index.html', 'styles.css'],
		null, null, false, v_lease_1, null, null
	);
	v_c1 := (v_res ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_code_session, 'ready', 'Built three initial directions.', null, null, v_c1_sha, v_lease_1
	);
	reset role;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_code_session, 'Try a bolder direction like Superpower.', true);
	reset role;

	perform pg_temp.sdaa_open_turn(v_code_session, v_lease_2);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_res := public.qorpera_native_surface_record_change(
		v_company, v_code_session, 'Superpower-inspired sketches', 'Three bold dark-hero variations.',
		'git_range', v_c1_sha, v_c2_sha, '{}'::uuid[], array['index.html', 'hero.css'],
		null, null, false, v_lease_2, null, null
	);
	v_c2 := (v_res ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_code_session, 'ready', 'Built three revised Superpower sketches.', null, null, v_c2_sha, v_lease_2
	);
	reset role;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	v_res := public.qorpera_discard_surface_change(v_c2);
	reset role;

	perform pg_temp.sdaa_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_code_session
				and m.author_kind = 'system'
				and m.author_user_id = v_anna
				and m.change_id = v_c2
				and m.body = 'Discarded change: Superpower-inspired sketches'
		),
		'discarding a change inserts a system message into the session thread'
	);

	select count(*) into v_msg_count_before
	from public.qorpera_surface_session_messages where session_id = v_code_session;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_c2);
	reset role;

	select count(*) into v_msg_count_after
	from public.qorpera_surface_session_messages where session_id = v_code_session;
	perform pg_temp.sdaa_assert(
		v_msg_count_after = v_msg_count_before,
		're-discarding an already-discarded change does not duplicate system messages'
	);

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_code_session, 'Keep the first sketch and tighten the hero spacing.', true);
	reset role;

	perform pg_temp.sdaa_open_turn(v_code_session, v_lease_3);
	v_turn := pg_temp.sdaa_read_turn(v_company, v_code_session, v_lease_3);

	perform pg_temp.sdaa_assert(
		v_turn ->> 'prompt' = 'Sketch the website',
		'code_repo turn keeps opening prompt alone'
	);
	perform pg_temp.sdaa_assert(
		jsonb_array_length(v_turn -> 'openChanges') = 1
			and (v_turn -> 'openChanges' -> 0 ->> 'id')::uuid = v_c1
			and (v_turn -> 'openChanges' -> 0 ->> 'seq')::integer = 1
			and (v_turn -> 'openChanges' -> 0 ->> 'status') = 'staged'
			and (v_turn -> 'openChanges' -> 0 ->> 'summary') = 'Initial calm homepage directions.'
			and (v_turn -> 'openChanges' -> 0 -> 'affectedPaths' ->> 0) = 'index.html',
		'openChanges exposes seq, status, summary, and affectedPaths for active change'
	);
	perform pg_temp.sdaa_assert(
		jsonb_array_length(v_turn -> 'resolvedChanges') = 1
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'id')::uuid = v_c2
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'seq')::integer = 2
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'title') = 'Superpower-inspired sketches'
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'status') = 'discarded'
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'parentSha') = v_c1_sha
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'headSha') = v_c2_sha
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'discardedByExploration')::boolean = false
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'resolvedAt') is not null,
		'resolvedChanges exposes the discarded change with its commit range and metadata'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_code_session, 'Accidental build on discarded change', 'Should fail.',
			'git_range', v_c2_sha, v_c3_sha, '{}'::uuid[], array['index.html'],
			null, null, false, v_lease_3, null, null
		);
		v_err_state := null;
	exception when others then
		v_err_state := sqlstate;
		v_err_msg := sqlerrm;
	end;
	reset role;
	perform pg_temp.sdaa_assert(
		v_err_state = '22023'
			and position('Superpower-inspired sketches' in v_err_msg) > 0
			and position('git read-tree --reset -u ' || v_c1_sha in v_err_msg) > 0,
		'recording a change whose parentSha is a discarded change is refused with recovery guidance, got ' || coalesce(v_err_state, 'none') || ': ' || coalesce(v_err_msg, '')
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_code_session, 'Omitted parent while tip discarded', 'Should fail.',
			'git_range', null, v_c3_sha, '{}'::uuid[], array['index.html'],
			null, null, false, v_lease_3, null, null
		);
		v_err_state := null;
	exception when others then
		v_err_state := sqlstate;
		v_err_msg := sqlerrm;
	end;
	reset role;
	perform pg_temp.sdaa_assert(
		v_err_state = '22023'
			and position('parentSha is required while branch tip' in v_err_msg) > 0
			and position('git read-tree --reset -u ' || v_c1_sha in v_err_msg) > 0,
		'omitted parentSha while branch tip is discarded is refused when open change remains, got ' || coalesce(v_err_state, 'none') || ': ' || coalesce(v_err_msg, '')
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_code_session, 'Accidental rebase onto discarded change', 'Should fail.',
			'git_range', v_c2_sha, v_c3_sha, '{}'::uuid[], array['index.html'],
			null, '{"rebase": true}'::jsonb, false, v_lease_3, null, null, v_c1
		);
		v_err_state := null;
	exception when others then
		v_err_state := sqlstate;
		v_err_msg := sqlerrm;
	end;
	reset role;
	perform pg_temp.sdaa_assert(
		v_err_state = '22023'
			and position('Superpower-inspired sketches' in v_err_msg) > 0,
		'rebasing an open change onto a discarded change parentSha is refused, got ' || coalesce(v_err_state, 'none') || ': ' || coalesce(v_err_msg, '')
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_res := public.qorpera_native_surface_record_change(
		v_company, v_code_session, 'Tighter hero spacing', 'Tightened hero padding on top of first sketch.',
		'git_range', v_c1_sha, v_c3_sha, '{}'::uuid[], array['styles.css'],
		null, null, false, v_lease_3, null, null
	);
	v_c3 := (v_res ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_code_session, 'ready', 'Tightened the hero spacing.', null, null, v_c3_sha, v_lease_3
	);
	reset role;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_c3);
	reset role;

	perform pg_temp.sdaa_open_turn(v_code_session, v_lease_4);
	v_cs.surface_session_id := v_code_session;
	v_cs.base_sha := v_main_sha;
	v_worker.sequence := 3;
	perform public.qorpera_surface_sync_coding_completion(
		v_cs,
		v_worker,
		'succeeded',
		'Answered question without new commits.',
		null,
		null,
		jsonb_build_array(jsonb_build_object('headSha', v_c3_sha, 'baseSha', v_main_sha))
	);
	perform pg_temp.sdaa_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_code_session and status in ('staged', 'conflicted')) = 1
			and (select count(*) from public.qorpera_surface_changes where session_id = v_code_session) = 3
			and (select head_sha from public.qorpera_surface_changes where id = v_c1) = v_c1_sha,
		'coding completion at an already-discarded branch tip does not resurrect the discarded change or overwrite open change'
	);

	perform pg_temp.sdaa_open_turn(v_code_session, '13840000-0000-4000-8000-00000000010a');
	v_worker.sequence := 4;
	perform public.qorpera_surface_sync_coding_completion(
		v_cs,
		v_worker,
		'succeeded',
		'Committed without calling coding_record_change.',
		null,
		null,
		jsonb_build_array(jsonb_build_object('headSha', v_c5_sha, 'baseSha', v_main_sha))
	);
	perform pg_temp.sdaa_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_code_session) = 3
			and (select head_sha from public.qorpera_surface_changes where id = v_c1) = v_c1_sha
			and (select branch_head_sha from public.qorpera_surface_sessions where id = v_code_session) = v_c3_sha
			and exists (
				select 1 from public.qorpera_surface_session_messages m
				where m.session_id = v_code_session
					and m.author_kind = 'system'
					and m.body like 'Latest commits were not staged automatically%'
			),
		'sync fallback does not auto-stage unrecorded commits over a discarded branch tip and keeps branch_head_sha at discarded tip'
	);

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_set_session_chat_open(v_code_session, true);
	perform public.qorpera_discard_surface_change(v_c1);
	reset role;

	perform pg_temp.sdaa_open_turn(v_code_session, v_lease_5);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_code_session, 'Build on discarded c1', 'Should fail.',
			'git_range', v_c1_sha, v_c4_sha, '{}'::uuid[], array['index.html'],
			null, null, false, v_lease_5, null, null
		);
		v_err_state := null;
	exception when others then
		v_err_state := sqlstate;
		v_err_msg := sqlerrm;
	end;
	reset role;
	perform pg_temp.sdaa_assert(
		v_err_state = '22023'
			and position('git reset --hard ' || v_main_sha in v_err_msg) > 0,
		'refuses discarded parentSha with git reset --hard mainSha when no open changes remain'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company, v_code_session, 'Omitted parent after all discarded', 'Should fail.',
			'git_range', null, v_c4_sha, '{}'::uuid[], array['index.html'],
			null, null, false, v_lease_5, null, null
		);
		v_err_state := null;
	exception when others then
		v_err_state := sqlstate;
		v_err_msg := sqlerrm;
	end;
	reset role;
	perform pg_temp.sdaa_assert(
		v_err_state = '22023'
			and position('parentSha is required while branch tip' in v_err_msg) > 0
			and position('git reset --hard ' || v_main_sha in v_err_msg) > 0,
		'omitted parentSha while branch tip is discarded is refused when no open changes remain, got ' || coalesce(v_err_state, 'none') || ': ' || coalesce(v_err_msg, '')
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_res := public.qorpera_native_surface_record_change(
		v_company, v_code_session, 'Fresh direction from main', 'Started clean from main.',
		'git_range', v_main_sha, v_c4_sha, '{}'::uuid[], array['index.html'],
		null, null, false, v_lease_5, null, null
	);
	v_c4 := (v_res ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_code_session, 'ready', 'Started clean from main.', null, null, v_c4_sha, v_lease_5
	);
	reset role;
	perform pg_temp.sdaa_assert(
		(select parent_sha from public.qorpera_surface_changes where id = v_c4) = v_main_sha,
		'explicit mainSha parentSha succeeds after all prior changes were discarded'
	);

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_c1);
	reset role;
	perform pg_temp.sdaa_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_code_session
				and m.author_kind = 'system'
				and m.author_user_id = v_anna
				and m.change_id = v_c1
				and m.body = 'Restored change: Three calm directions'
		),
		'restoring a discarded change inserts a Restored change system message'
	);

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	v_opt_session := (public.qorpera_start_surface_session(
		v_site, 'Show hero options', 'Hero options'
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sdaa_open_turn(v_opt_session, v_lease_6);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_native_surface_record_change(
		v_company, v_opt_session, 'Editorial Hero', 'Calm serif hero.',
		'git_range', v_main_sha, v_opt1_sha, '{}'::uuid[], array['index.html'],
		null, null, false, v_lease_6, 'hero-style', 'Hero directions'
	);
	perform public.qorpera_native_surface_record_change(
		v_company, v_opt_session, 'Bold Hero', 'High-contrast hero.',
		'git_range', v_main_sha, v_opt2_sha, '{}'::uuid[], array['index.html'],
		null, null, false, v_lease_6, 'hero-style', 'Hero directions'
	);
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_opt_session, 'ready', 'Prepared two hero directions.', null, null, v_opt2_sha, v_lease_6
	);
	reset role;

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_set_session_chat_open(v_opt_session, true);
	perform public.qorpera_discard_surface_option_group(v_opt_session, 'hero-style');
	reset role;

	perform pg_temp.sdaa_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_opt_session
				and m.author_kind = 'system'
				and m.author_user_id = v_anna
				and m.change_id is null
				and m.body = 'Discarded options: Editorial Hero, Bold Hero'
		),
		'discarding an option group records a single Discarded options system message'
	);

	select count(*) into v_msg_count_before
	from public.qorpera_surface_session_messages where session_id = v_opt_session;
	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_option_group(v_opt_session, 'hero-style');
	reset role;
	select count(*) into v_msg_count_after
	from public.qorpera_surface_session_messages where session_id = v_opt_session;
	perform pg_temp.sdaa_assert(
		v_msg_count_after = v_msg_count_before,
		're-discarding an option group is idempotent'
	);

	perform pg_temp.sdaa_open_turn(v_opt_session, v_lease_7);
	v_turn := pg_temp.sdaa_read_turn(v_company, v_opt_session, v_lease_7);
	perform pg_temp.sdaa_assert(
		jsonb_array_length(v_turn -> 'openChanges') = 0
			and jsonb_array_length(v_turn -> 'resolvedChanges') = 2
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'optionGroupKey') = 'hero-style'
			and (v_turn -> 'resolvedChanges' -> 1 ->> 'status') = 'discarded',
		'option group discard appears in resolvedChanges'
	);

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	v_studio_session := (public.qorpera_start_surface_session(
		v_studio, 'Update brand brief and voice', 'Brand update'
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sdaa_open_turn(v_studio_session, v_lease_8);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_s1 := (public.qorpera_native_surface_record_change(
		v_company, v_studio_session, 'Updated brief', 'Sharper brand brief.',
		'folder_patch', null, null, '{}'::uuid[], array['brief.md'],
		null, jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', '# Brief')),
		false, v_lease_8, null, null
	) ->> 'changeId')::uuid;
	v_s2 := (public.qorpera_native_surface_record_change(
		v_company, v_studio_session, 'Experimental voice', 'Playful tone draft.',
		'folder_patch', null, null, '{}'::uuid[], array['voice.md'],
		null, jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'voice.md', 'content', '# Voice')),
		false, v_lease_8, null, null
	) ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_studio_session, 'ready', 'Staged brief and voice drafts.', null, null, null, v_lease_8
	);
	reset role;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
	values
		(v_company, v_studio_session, 'system', 'Previous attempt failed; retrying automatically.'),
		(v_company, v_studio_session, 'system', 'Discarded carts should get a reminder.');

	perform pg_temp.sdaa_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_s2);
	perform public.qorpera_reply_surface_session(v_studio_session, 'Keep the brief and make the voice calmer instead.', true);
	reset role;

	perform pg_temp.sdaa_open_turn(v_studio_session, '13840000-0000-4000-8000-000000000109');
	v_turn := pg_temp.sdaa_read_turn(v_company, v_studio_session, '13840000-0000-4000-8000-000000000109');
	perform pg_temp.sdaa_assert(
		position(E'System:\nDiscarded change: Experimental voice' in (v_turn ->> 'prompt')) > 0
			and position(E'You:\nStaged brief and voice drafts.' in (v_turn ->> 'prompt'))
				< position(E'System:\nDiscarded change: Experimental voice' in (v_turn ->> 'prompt'))
			and position(E'System:\nDiscarded change: Experimental voice' in (v_turn ->> 'prompt'))
				< position('Keep the brief and make the voice calmer instead.' in (v_turn ->> 'prompt'))
			and position('Previous attempt failed' in (v_turn ->> 'prompt')) = 0
			and position('Discarded carts should get a reminder.' in (v_turn ->> 'prompt')) = 0,
		'folder surface turn prompt includes discard event chronologically and keeps retry/non-lifecycle system rows out, got ' || coalesce(v_turn ->> 'prompt', 'null')
	);
	perform pg_temp.sdaa_assert(
		jsonb_array_length(v_turn -> 'openChanges') = 1
			and (v_turn -> 'openChanges' -> 0 ->> 'id')::uuid = v_s1
			and jsonb_array_length(v_turn -> 'resolvedChanges') = 1
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'id')::uuid = v_s2
			and (v_turn -> 'resolvedChanges' -> 0 ->> 'status') = 'discarded',
		'folder surface turn read exposes both openChanges and resolvedChanges'
	);
end $$;
