-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.shw_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_host_wiring: %', p_message;
	end if;
end $$;

create function pg_temp.shw_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.shw_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '85600000-0000-4000-8000-000000000002';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_other_owner uuid := '13260000-0000-4000-8000-000000000098';
	v_company_b uuid := '13260000-0000-4000-8000-000000000011';
	v_folder_surface_id uuid;
	v_code_surface_id uuid;
	v_ops_surface_id uuid;
	v_session_member uuid;
	v_session_cofounder uuid;
	v_session_cofounder_folder uuid;
	v_session_auto uuid;
	v_session_ops uuid;
	v_session_big_prompt uuid;
	v_lease_member uuid;
	v_lease_cofounder uuid;
	v_lease_cofounder_folder uuid;
	v_lease_auto uuid;
	v_lease_ops uuid;
	v_lease_big uuid;
	v_change_folder uuid;
	v_change_code_1 uuid;
	v_change_code_2 uuid;
	v_change_ops uuid;
	v_snap jsonb;
	v_rebased jsonb;
	v_claimed jsonb;
	v_enq jsonb;
	v_mat jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_policy jsonb;
	v_turn_read jsonb;
	v_begin jsonb;
	v_list jsonb;
	v_put jsonb;
	v_finish jsonb;
	v_site_id uuid;
	v_ver_live uuid;
	v_ver_keep_preview uuid;
	v_ver_expired_preview uuid;
	v_ver_recent uuid;
	v_pruned integer;
	v_html bytea := convert_to('<!doctype html><h1>Hello Preview</h1>', 'utf8');
	v_html_sha text := encode(extensions.digest(convert_to('<!doctype html><h1>Hello Preview</h1>', 'utf8'), 'sha256'), 'hex');
	v_manifest_sha text;
	v_big_prompt text := repeat('p', 16000);
	v_errcode text;
	v_auto jsonb;
	v_auto_id uuid;
	v_trigger jsonb;
	v_preview_id uuid;
	v_idx integer;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	-- WHY: Exercise the pre-v284 wake-based surface session path tested by this suite.
	update public.qorpera_active_runtime_bundle a
	set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
	from public.qorpera_runtime_bundles b
	where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = 283;
	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-shw-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Host Wiring Co B', v_other_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company_b, v_other_owner, 'owner-shw-b@example.test', 'Owner B', 'owner');

	perform pg_temp.shw_assert(
		(select count(*) from public.qorpera_native_host_calls where name like 'qorpera_native_surface_%' and scope = 'profile') = 9,
		'all 9 tenant-scoped native surface wrappers are registered in qorpera_native_host_calls with profile scope'
	);

	perform pg_temp.shw_as(v_owner);
	set local role authenticated;
	v_folder_surface_id := (public.qorpera_create_surface(v_company_a, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_code_surface_id := (public.qorpera_create_surface(v_company_a, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false) ->> 'id')::uuid;
	v_ops_surface_id := (public.qorpera_create_surface(v_company_a, 'Inbox', 'inbox', 'ops', 'inbox', 'mail', '#34c759', null, null, false) ->> 'id')::uuid;

	v_session_member := (public.qorpera_start_surface_session(v_folder_surface_id, 'Update accent', 'Change primary accent') ->> 'id')::uuid;
	v_session_big_prompt := (public.qorpera_start_surface_session(v_folder_surface_id, v_big_prompt, 'Max prompt session') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_code_surface_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;

	perform pg_temp.shw_assert(
		jsonb_array_length(public.qorpera_native_surface_describe_senses(v_company_a) -> 'surfaces') >= 3,
		'qorpera_native_surface_describe_senses lists company A surfaces'
	);

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_start_session(
			v_company_a, v_code_surface_id, 'Spoof member origin', 'Spoofed', 'member', 'Founder'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_start_session refuses non-cofounder/automation origin');

	v_session_cofounder := (public.qorpera_native_surface_start_session(
		v_company_a, v_code_surface_id, 'Build landing hero', 'Landing hero', 'cofounder', 'Co-Founder'
	) ->> 'sessionId')::uuid;
	v_session_cofounder_folder := (public.qorpera_native_surface_start_session(
		v_company_a, v_folder_surface_id, 'Refresh palette notes', 'Palette refresh', 'cofounder', 'Co-Founder'
	) ->> 'sessionId')::uuid;

	v_auto := public.qorpera_native_surface_manage_automation(
		v_company_a, 'create', null, 'Daily Identity Check', 'Review identity tokens', 'Daily at 09:00', 'identity', true
	);
	v_auto_id := (v_auto ->> 'id')::uuid;
	v_trigger := public.qorpera_surface_trigger_automation(v_auto_id);
	v_session_auto := (v_trigger -> 'session' ->> 'sessionId')::uuid;
	perform pg_temp.shw_assert(
		v_trigger ->> 'status' = 'started' and v_session_auto is not null,
		'qorpera_surface_trigger_automation starts an automation session on the target surface'
	);

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	perform pg_temp.shw_assert(
		jsonb_array_length(v_claimed -> 'sessions') >= 5,
		'sessions lane claims all queued surface sessions'
	);

	select (elem ->> 'leaseToken')::uuid into strict v_lease_member
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_member;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_big
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_big_prompt;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_cofounder
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_cofounder;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_cofounder_folder
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_cofounder_folder;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_auto
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_auto;

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_read_session_turn(v_company_b, v_session_big_prompt, v_lease_big);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_read_session_turn rejects cross-profile session');

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_read_session_turn(v_company_a, v_session_big_prompt, gen_random_uuid());
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_read_session_turn rejects mismatched lease');

	v_turn_read := public.qorpera_native_surface_read_session_turn(v_company_a, v_session_big_prompt, v_lease_big);
	perform pg_temp.shw_assert(
		char_length(v_turn_read ->> 'prompt') = 16000 and v_turn_read ->> 'surfaceSlug' = 'identity',
		'qorpera_native_surface_read_session_turn returns full 16000-char prompt for active lease'
	);

	v_enq := public.qorpera_surface_enqueue_session_run(v_session_member, gen_random_uuid());
	perform pg_temp.shw_assert(
		v_enq ->> 'status' = 'unavailable' and v_enq ->> 'reason' = 'lease_lost',
		'enqueue rejects mismatched lease token cleanly'
	);

	v_enq := public.qorpera_surface_enqueue_session_run(v_session_big_prompt, v_lease_big);
	reset role;
	perform pg_temp.shw_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'wakeId') is not null,
		'16000-character prompt enqueues cleanly under 8192-byte wake payload check'
	);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.shw_assert(
		pg_column_size(v_wake.payload) <= 1024 and public.qorpera_folder_wake_authorized(v_wake),
		'surface-session wake payload stays compact and passes qorpera_folder_wake_authorized'
	);

	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'simulated wake cancellation'
	where id = v_wake.id;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;
	perform pg_temp.shw_assert(
		(select retry_count from public.qorpera_surface_sessions where id = v_session_big_prompt) >= 1,
		'terminal wake_id reconciles surface session automatically'
	);

	set local session_replication_role = replica;
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = false
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_company_a);
	set local session_replication_role = origin;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session_member, v_lease_member);
	perform pg_temp.shw_assert(v_enq ->> 'status' = 'enqueued', 'member-initiated session enqueues deterministically');
	v_wake := (select w from public.qorpera_wake_occurrences w where w.id = (v_enq ->> 'wakeId')::uuid);
	reset role;

	v_mat := pg_temp.shw_materialize(v_company_a, 16);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.shw_assert(
		v_mat ->> 'state' = 'done' and v_wake.status = 'materialized' and v_wake.run_id is not null,
		'member-initiated surface-session wake materializes under allow_autonomous = false'
	);
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.shw_assert(
		public.qorpera_run_autonomous_authority(v_run)
		and not public.qorpera_run_autonomous_authority(
			jsonb_populate_record(v_run, jsonb_build_object('requested_by_user_id', v_member))
		),
		'qorpera_run_autonomous_authority admits member-initiated session only for its requester'
	);
	v_policy := public.qorpera_runtime_wake_policy_internal(v_run.id);
	perform pg_temp.shw_assert(
		v_policy ->> 'final' = 'forbidden' and (v_policy ->> 'maxPublicSends')::integer = 0,
		'qorpera_runtime_wake_policy_internal enforces silent agent wake policy for surface-session'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session_cofounder_folder, v_lease_cofounder_folder);
	perform pg_temp.shw_assert(v_enq ->> 'status' = 'enqueued', 'cofounder folder session enqueues wake');
	v_wake := (select w from public.qorpera_wake_occurrences w where w.id = (v_enq ->> 'wakeId')::uuid);
	v_enq := public.qorpera_surface_enqueue_session_run(v_session_auto, v_lease_auto);
	perform pg_temp.shw_assert(v_enq ->> 'status' = 'enqueued', 'automation folder session enqueues wake');
	reset role;

	v_mat := pg_temp.shw_materialize(v_company_a, 16);
	perform pg_temp.shw_assert(
		not exists (
			select 1 from public.qorpera_wake_occurrences w
			where w.source_kind = 'surface-session'
				and w.source_id in (v_session_cofounder_folder, v_session_auto)
				and w.status = 'materialized'
		),
		'cofounder and automation surface sessions do NOT materialize when allow_autonomous = false'
	);
	perform pg_temp.shw_assert(
		not public.qorpera_run_autonomous_authority(
			jsonb_populate_record(v_run, jsonb_build_object('source_id', v_wake.id))
		)
		and not public.qorpera_run_autonomous_authority(
			jsonb_populate_record(v_run, jsonb_build_object('source_id', (v_enq ->> 'wakeId')::uuid))
		),
		'qorpera_run_autonomous_authority denies cofounder and automation sessions under allow_autonomous = false'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company_b, v_session_member, 'Wrong tenant', 'Should fail', 'folder_patch',
			null, null, '{}', '{}', null, null, false, v_lease_member
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_record_change rejects cross-profile session');

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company_a, v_session_member, 'Missing lease', 'Should fail', 'folder_patch',
			null, null, '{}', '{}', null, null, false, null
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_record_change requires non-null lease token');

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company_a, v_session_member, 'Stale lease', 'Should fail', 'folder_patch',
			null, null, '{}', '{}', null, null, false, gen_random_uuid()
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_record_change rejects mismatched lease token');

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_complete_turn(
			v_company_a, v_session_member, 'ready', 'No lease token', null, null, null, null
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_complete_turn requires non-null lease token');

	v_change_folder := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_member, 'Warm accent', 'Update tokens', 'folder_patch',
		null, null, '{}', array['identity/tokens.json'], null,
		'{"ops":[{"op":"set_file","path":"identity/tokens.json","content":"{\"accent\":\"#c84b31\"}"}]}'::jsonb,
		false, v_lease_member
	) ->> 'changeId')::uuid;
	perform pg_temp.shw_assert(v_change_folder is not null, 'qorpera_native_surface_record_change records folder change with active lease');

	v_snap := public.qorpera_surface_save_folder_snapshot(
		v_company_a, v_folder_surface_id, 'snap-1', 'identity', array[v_change_folder],
		'{"identity/tokens.json":"{\"accent\":\"#000000\"}"}'::jsonb,
		'{"identity/tokens.json":"v2"}'::jsonb,
		'{"identity/tokens.json":"abc"}'::jsonb
	);
	perform pg_temp.shw_assert((v_snap ->> 'saved')::boolean, 'folder snapshot saved');
	v_snap := public.qorpera_surface_load_folder_snapshot(v_company_a, v_folder_surface_id, v_change_folder, null);
	perform pg_temp.shw_assert(
		v_snap ->> 'snapshotId' = 'snap-1' and v_snap -> 'versionsAfter' ->> 'identity/tokens.json' = 'v2',
		'folder snapshot loads by changeId with versionsAfter intact'
	);

	v_change_code_1 := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_cofounder, 'Hero copy', 'Adds hero copy', 'git_range',
		null, repeat('2', 40), '{}', array['index.html'], null, null, false, v_lease_cofounder
	) ->> 'changeId')::uuid;
	v_change_code_2 := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_cofounder, 'Pricing copy', 'Adds pricing copy', 'git_range',
		null, repeat('3', 40), '{}', array['pricing.html'], null, null, false, v_lease_cofounder
	) ->> 'changeId')::uuid;
	reset role;
	perform pg_temp.shw_assert(
		(select parent_sha from public.qorpera_surface_changes where id = v_change_code_1) = repeat('1', 40)
		and (select parent_sha from public.qorpera_surface_changes where id = v_change_code_2) = repeat('2', 40),
		'qorpera_native_surface_record_change derives parent_sha from live head and prior change head'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_rebased := public.qorpera_surface_update_rebased_changes(
		v_code_surface_id,
		v_session_cofounder,
		repeat('5', 40),
		jsonb_build_array(jsonb_build_object('changeId', v_change_code_1, 'parentSha', repeat('4', 40), 'headSha', repeat('5', 40))),
		null,
		null
	);
	reset role;
	perform pg_temp.shw_assert(
		(v_rebased ->> 'updated')::integer = 1
		and (select head_sha from public.qorpera_surface_changes where id = v_change_code_1) = repeat('5', 40)
		and (select branch_head_sha from public.qorpera_surface_sessions where id = v_session_cofounder) = repeat('5', 40),
		'qorpera_surface_update_rebased_changes updates change SHAs and session branch_head_sha'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_manifest_sha := encode(
		extensions.digest(
			convert_to('index.html' || chr(9) || v_html_sha || chr(9) || octet_length(v_html)::text, 'utf8'),
			'sha256'
		),
		'hex'
	);
	for v_idx in 1..6 loop
		v_begin := public.qorpera_surface_site_version_begin(
			v_code_surface_id, repeat(to_hex(v_idx), 40), repeat('b', 40), v_manifest_sha, 1, octet_length(v_html), 'V' || v_idx::text
		);
		v_ver_recent := (v_begin ->> 'versionId')::uuid;
		v_site_id := (v_begin ->> 'siteId')::uuid;
		v_list := public.qorpera_surface_site_version_list(
			v_ver_recent,
			jsonb_build_object(
				'files', jsonb_build_array(jsonb_build_object('path', 'index.html', 'bytes', octet_length(v_html), 'sha256', v_html_sha)),
				'last', true
			)
		);
		v_put := public.qorpera_surface_site_version_put(
			v_ver_recent,
			jsonb_build_object(
				'parts', jsonb_build_array(jsonb_build_object(
					'path', 'index.html', 'part', 0, 'of', 1,
					'contentBase64', replace(encode(v_html, 'base64'), chr(10), '')
				))
			)
		);
		if v_idx = 1 then
			v_finish := public.qorpera_surface_site_version_finish(v_ver_recent, true);
			v_ver_live := v_ver_recent;
		else
			v_finish := public.qorpera_surface_site_version_finish(v_ver_recent, false);
			if v_idx = 2 then
				v_ver_keep_preview := v_ver_recent;
				reset role;
				insert into public.qorpera_surface_previews(
					profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids,
					status, site_version_id, expires_at
				)
				values (
					v_company_a, v_code_surface_id, 'comp-keep-1', 'keep0001', repeat('1', 40), array[v_change_code_1],
					'ready', v_ver_keep_preview, clock_timestamp() + interval '1 hour'
				);
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				set local role service_role;
			elsif v_idx = 3 then
				v_ver_expired_preview := v_ver_recent;
				reset role;
				insert into public.qorpera_surface_previews(
					profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids,
					status, site_version_id, expires_at
				)
				values (
					v_company_a, v_code_surface_id, 'comp-exp-1', 'exp00001', repeat('1', 40), array[v_change_code_1],
					'ready', v_ver_expired_preview, clock_timestamp() - interval '1 hour'
				);
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				set local role service_role;
			end if;
		end if;
	end loop;
	reset role;

	perform pg_temp.shw_assert(
		(select current_version_id from public.qorpera_company_sites where id = v_site_id) = v_ver_live
		and exists (select 1 from public.qorpera_company_site_versions where id = v_ver_live)
		and exists (select 1 from public.qorpera_company_site_versions where id = v_ver_keep_preview)
		and not exists (select 1 from public.qorpera_company_site_versions where id = v_ver_expired_preview),
		'surface site version pruning keeps live and unexpired preview versions while deleting expired preview versions'
	);

	perform pg_temp.shw_as(v_owner);
	set local role authenticated;
	v_preview_id := (public.qorpera_set_preview_selection(v_code_surface_id, array[v_change_code_1], null, '{}'::uuid[], '/') -> 'primary' ->> 'previewId')::uuid;
	perform public.qorpera_approve_surface_change(v_change_folder, false);
	perform public.qorpera_approve_surface_change(v_change_code_1, false);
	v_session_ops := (public.qorpera_start_surface_session(v_ops_surface_id, 'Send update', 'Ops action') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_ops
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_ops;

	v_change_ops := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_ops, 'Ops step', 'Toggle automation', 'ops_action',
		null, null, '{}', '{}', null, '{"actionKind":"noop","actionPayload":{}}'::jsonb, false, v_lease_ops
	) ->> 'changeId')::uuid;
	reset role;

	perform pg_temp.shw_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_change_ops, false);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder');
	perform pg_temp.shw_assert(
		jsonb_array_length(v_claimed -> 'sessions') = 0
		and jsonb_array_length(v_claimed -> 'previews') = 0
		and jsonb_array_length(v_claimed -> 'merges') = 1
		and (v_claimed -> 'merges' -> 0 ->> 'sourceKind') = 'folder'
		and (v_claimed -> 'merges' -> 0 ->> 'environmentId') = v_env_a::text,
		'folder lane claims only folder merges and attaches environmentId'
	);

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	perform pg_temp.shw_assert(
		jsonb_array_length(v_claimed -> 'sessions') = 0
		and jsonb_array_length(v_claimed -> 'merges') = 1
		and jsonb_array_length(v_claimed -> 'previews') = 1
		and (v_claimed -> 'previews' -> 0 ->> 'previewId')::uuid = v_preview_id
		and jsonb_array_length(v_claimed -> 'previews' -> 0 -> 'changes') = 1
		and (v_claimed -> 'merges' -> 0 ->> 'sourceKind') = 'code_repo',
		'code_repo lane claims code_repo merges and previews with derived parent_sha changes'
	);

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	perform pg_temp.shw_assert(
		jsonb_array_length(v_claimed -> 'merges') = 1
		and (v_claimed -> 'merges' -> 0 ->> 'sourceKind') = 'native_ops',
		'sessions lane claims native_ops merges only'
	);

	reset role;
end $$;
