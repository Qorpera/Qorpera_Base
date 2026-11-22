-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

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

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_company_a constant uuid := '92400000-0000-4000-8000-000000000010';
	v_env_a constant uuid := '92400000-0000-4000-8000-000000000020';
	v_other_owner uuid := '13260000-0000-4000-8000-000000000098';
	v_company_b uuid := '13260000-0000-4000-8000-000000000011';
	v_folder_surface_id uuid;
	v_code_surface_id uuid;
	v_ops_surface_id uuid;
	v_session_a uuid;
	v_session_b uuid;
	v_session_ops uuid;
	v_change_folder uuid;
	v_change_code uuid;
	v_change_ops uuid;
	v_snap jsonb;
	v_rebased jsonb;
	v_claimed jsonb;
	v_begin jsonb;
	v_list jsonb;
	v_put jsonb;
	v_finish jsonb;
	v_version_id uuid;
	v_html bytea := convert_to('<!doctype html><h1>Hello Preview</h1>', 'utf8');
	v_html_sha text := encode(extensions.digest(convert_to('<!doctype html><h1>Hello Preview</h1>', 'utf8'), 'sha256'), 'hex');
	v_manifest_sha text;
	v_errcode text;
	v_auto jsonb;
	v_auto_id uuid;
	v_trigger jsonb;
	v_enq jsonb;
	v_lease uuid;
	v_run_job_id uuid;
	v_cofounder_staff uuid;
	v_formation_id uuid := gen_random_uuid();
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	insert into auth.users(id, email) values (v_other_owner, 'owner-shw-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Host Wiring Co B', v_other_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company_b, v_other_owner, 'owner-shw-b@example.test', 'Owner B', 'owner');

	if not exists (select 1 from public.qorpera_company_cofounders where profile_id = v_company_a) then
		select staff_agent_id into v_cofounder_staff
		from public.qorpera_profile_staff
		where profile_id = v_company_a
		limit 1;
		insert into public.qorpera_company_formations(id, profile_id, environment_id, created_by_user_id, company_name, goal, status)
		values (v_formation_id, v_company_a, v_env_a, v_owner, 'Host Wiring Co A', 'Ship surfaces', 'completed');
		insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, formation_id, created_by_user_id)
		values (v_company_a, v_env_a, v_cofounder_staff, v_formation_id, v_owner);
	end if;

	perform pg_temp.shw_assert(
		(select count(*) from public.qorpera_native_host_calls where name like 'qorpera_native_surface_%' and scope = 'profile') = 7,
		'all 7 tenant-scoped native surface wrappers are registered in qorpera_native_host_calls with profile scope'
	);

	perform pg_temp.shw_as(v_owner);
	set local role authenticated;
	v_folder_surface_id := (public.qorpera_create_surface(v_company_a, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_code_surface_id := (public.qorpera_create_surface(v_company_a, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false) ->> 'id')::uuid;
	v_ops_surface_id := (public.qorpera_create_surface(v_company_a, 'Inbox', 'inbox', 'ops', 'inbox', 'mail', '#34c759', null, null, false) ->> 'id')::uuid;

	v_session_a := (public.qorpera_start_surface_session(v_folder_surface_id, 'Update accent', 'Change primary accent') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;

	perform pg_temp.shw_assert(
		jsonb_array_length(public.qorpera_native_surface_describe_senses(v_company_a) -> 'surfaces') >= 3,
		'qorpera_native_surface_describe_senses lists company A surfaces'
	);

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company_b, v_session_a, 'Wrong tenant', 'Should fail', 'folder_patch'
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_record_change rejects cross-profile session');

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_complete_turn(
			v_company_a, v_session_a, 'ready', 'No lease token', null, null, null, null
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.shw_assert(v_errcode = '42501', 'qorpera_native_surface_complete_turn requires non-null lease token');

	v_change_folder := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_a, 'Warm accent', 'Update tokens', 'folder_patch',
		null, null, '{}', array['identity/tokens.json'], null,
		'{"ops":[{"op":"set_file","path":"identity/tokens.json","content":"{\"accent\":\"#c84b31\"}"}]}'::jsonb,
		false
	) ->> 'changeId')::uuid;
	perform pg_temp.shw_assert(v_change_folder is not null, 'qorpera_native_surface_record_change records folder change');

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

	v_session_b := (public.qorpera_native_surface_start_session(
		v_company_a, v_code_surface_id, 'Build landing hero', 'Landing hero'
	) ->> 'sessionId')::uuid;
	v_change_code := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_b, 'Hero copy', 'Adds hero copy', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}', array['index.html'], null, null, false
	) ->> 'changeId')::uuid;

	v_rebased := public.qorpera_surface_update_rebased_changes(
		v_code_surface_id,
		v_session_b,
		repeat('4', 40),
		jsonb_build_array(jsonb_build_object('changeId', v_change_code, 'parentSha', repeat('3', 40), 'headSha', repeat('4', 40))),
		null,
		null
	);
	reset role;
	perform pg_temp.shw_assert(
		(v_rebased ->> 'updated')::integer = 1
		and (select head_sha from public.qorpera_surface_changes where id = v_change_code) = repeat('4', 40)
		and (select branch_head_sha from public.qorpera_surface_sessions where id = v_session_b) = repeat('4', 40),
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
	v_begin := public.qorpera_surface_site_version_begin(
		v_code_surface_id, repeat('a', 40), repeat('b', 40), v_manifest_sha, 1, octet_length(v_html), 'Preview'
	);
	v_version_id := (v_begin ->> 'versionId')::uuid;
	perform pg_temp.shw_assert(v_begin ->> 'state' = 'uploading' and v_version_id is not null, 'site version begin creates uploading version');

	v_list := public.qorpera_surface_site_version_list(
		v_version_id,
		jsonb_build_object(
			'files', jsonb_build_array(jsonb_build_object('path', 'index.html', 'bytes', octet_length(v_html), 'sha256', v_html_sha)),
			'last', true
		)
	);
	perform pg_temp.shw_assert(v_list ->> 'state' = 'listed' and (v_list ->> 'missing')::integer = 1, 'site version list marks listed');

	v_put := public.qorpera_surface_site_version_put(
		v_version_id,
		jsonb_build_object(
			'parts', jsonb_build_array(jsonb_build_object(
				'path', 'index.html', 'part', 0, 'of', 1,
				'contentBase64', replace(encode(v_html, 'base64'), chr(10), '')
			))
		)
	);
	perform pg_temp.shw_assert(v_put ->> 'state' = 'kept' and (v_put ->> 'filed')::integer = 1, 'site version put stores verified bytes');

	v_finish := public.qorpera_surface_site_version_finish(v_version_id, false);
	perform pg_temp.shw_assert(v_finish ->> 'state' = 'ready', 'site version finish transitions preview version to ready');

	v_finish := public.qorpera_surface_site_version_finish(v_version_id, true);
	reset role;
	perform pg_temp.shw_assert(
		v_finish ->> 'state' = 'live'
		and (select current_version_id from public.qorpera_company_sites where id = (v_finish ->> 'siteId')::uuid) = v_version_id,
		'site version finish with promote_live promotes version live'
	);

	perform pg_temp.shw_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_change_folder, false);
	perform public.qorpera_approve_surface_change(v_change_code, false);

	v_session_ops := (public.qorpera_start_surface_session(v_ops_surface_id, 'Send update', 'Ops action') ->> 'id')::uuid;
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_change_ops := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_ops, 'Ops step', 'Toggle automation', 'ops_action',
		null, null, '{}', '{}', null, '{"actionKind":"noop","actionPayload":{}}'::jsonb, false
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
		and (v_claimed -> 'merges' -> 0 ->> 'sourceKind') = 'code_repo',
		'code_repo lane claims only code_repo merges and previews'
	);

	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	perform pg_temp.shw_assert(
		jsonb_array_length(v_claimed -> 'sessions') >= 1
		and jsonb_array_length(v_claimed -> 'merges') = 1
		and (v_claimed -> 'merges' -> 0 ->> 'sourceKind') = 'native_ops',
		'sessions lane claims sessions and native_ops merges only'
	);

	v_lease := (v_claimed -> 'sessions' -> 0 ->> 'leaseToken')::uuid;
	v_enq := public.qorpera_surface_enqueue_session_run((v_claimed -> 'sessions' -> 0 ->> 'sessionId')::uuid, v_lease);
	reset role;
	perform pg_temp.shw_assert(
		v_enq ->> 'status' in ('enqueued', 'deferred', 'unavailable'),
		'qorpera_surface_enqueue_session_run returns enqueued, deferred, or structured unavailable'
	);
	if v_enq ->> 'status' = 'enqueued' then
		v_run_job_id := (v_enq ->> 'wakeId')::uuid;
		perform pg_temp.shw_assert(
			exists (
				select 1 from public.qorpera_wake_occurrences wk
				where wk.id = v_run_job_id
					and wk.wake_kind = 'agent'
					and wk.source_kind = 'surface-session'
					and wk.payload ->> 'schema' = 'qorpera.surface-session-wake/v1'
					and public.qorpera_folder_wake_authorized(wk)
			),
			'enqueued wake carries qorpera.surface-session-wake/v1 payload and passes qorpera_folder_wake_authorized'
		);
		update public.qorpera_wake_occurrences
		set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'simulated wake cancellation'
		where id = v_run_job_id;
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
		perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
		reset role;
		perform pg_temp.shw_assert(
			(select retry_count from public.qorpera_surface_sessions where id = (v_claimed -> 'sessions' -> 0 ->> 'sessionId')::uuid) >= 1,
			'terminal wake_id reconciles surface session automatically'
		);
	end if;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_auto := public.qorpera_native_surface_manage_automation(
		v_company_a, 'create', null, 'Daily Website Check', 'Review website metrics', 'Daily at 09:00', 'website', true
	);
	v_auto_id := (v_auto ->> 'id')::uuid;
	v_trigger := public.qorpera_surface_trigger_automation(v_auto_id);
	perform pg_temp.shw_assert(
		v_trigger ->> 'status' = 'started' and (v_trigger -> 'session' ->> 'sessionId') is not null,
		'qorpera_surface_trigger_automation starts a session on the target surface'
	);

	reset role;
end $$;
