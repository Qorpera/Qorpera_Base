-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sprmh_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_preview_reconcile_and_merge_hardening: %', p_message;
	end if;
end $$;

create function pg_temp.sprmh_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sprmh_finish_preview(
	p_preview_id uuid,
	p_status text,
	p_tree text default null,
	p_conflict jsonb default null,
	p_error text default null
)
returns void language plpgsql as $$
declare
	v_lease uuid;
begin
	update public.qorpera_surface_previews
	set status = 'building',
		lease_token = coalesce(lease_token, extensions.gen_random_uuid()),
		lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = p_preview_id
	returning lease_token into strict v_lease;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_preview(
		p_preview_id, p_status, p_tree, null, p_conflict, p_error, v_lease
	);
	reset role;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '85600000-0000-4000-8000-000000000002';
	v_other_owner constant uuid := '13420000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13420000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13420000-0000-4000-8000-000000000021';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_proposed_id uuid;
	v_approved_surface jsonb;
	v_surface_id uuid;
	v_sess_prev uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c_disc uuid;
	v_sel jsonb;
	v_ws jsonb;
	v_p1_id uuid;
	v_p1_key text;
	v_p2_id uuid;
	v_p3_id uuid;
	v_claimed jsonb;
	v_preview_claim jsonb;
	v_exp_id uuid;
	v_var_a uuid;
	v_var_b uuid;
	v_cmp_a_id uuid;
	v_cmp_b_id uuid;
	v_pub_job_id uuid;
	v_pub_lease uuid;
	v_sess_ra uuid;
	v_sess_rb uuid;
	v_ch_ra uuid;
	v_ch_rb uuid;
	v_rec_sess uuid;
	v_rec_lease uuid;
	v_rec_turn jsonb;
	v_rec_worker uuid;
	v_sess_s1 uuid;
	v_lease_s1 uuid;
	v_worker_s1 uuid;
	v_sess_pre uuid;
	v_lease_pre uuid;
	v_worker_pre uuid;
	v_sess_sys uuid;
	v_lease_sys uuid;
	v_worker_sys uuid;
	v_sess_exp uuid;
	v_lease_exp uuid;
	v_worker_exp uuid;
	v_sess_par uuid;
	v_lease_par uuid;
	v_rec_par jsonb;
	v_sess_dep uuid;
	v_d1 uuid;
	v_d2 uuid;
	v_d3 uuid;
	v_d_disc uuid;
	v_sess_peer_run uuid;
	v_sess_peer_idle uuid;
	v_worker_peer_run uuid;
	v_worker_peer_idle uuid;
	v_sess_other uuid;
	v_ch_other uuid;
	v_job_1 uuid;
	v_job_1_lease uuid;
	v_job_2 uuid;
	v_job_2_lease uuid;
	v_merge_1 jsonb;
	v_sess_batch uuid;
	v_b1 uuid;
	v_b2 uuid;
	v_batch_job uuid;
	v_batch_lease uuid;
	v_undo_job uuid;
	v_undo_lease uuid;
	v_errcode text;
	v_peer_coding_base text;
	v_peer_change_id uuid;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env_a
	from public.qorpera_company_cofounders
	where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-sprmh-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SPRMH Executor Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SPRMH Executor Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1342', true, array['codex', 'claude-code']);

	perform pg_temp.sprmh_assert(
		not has_function_privilege('anon', 'public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)', 'EXECUTE'),
		'composition key helper is revoked from all API roles'
	);

	-- WHY: Verify qorpera_approve_proposed_surface provisions a site for proposed live_build/code_repo surfaces.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_proposed_id := (public.qorpera_propose_surface(
		v_company_a, 'proposed-shop', 'Proposed Shop', 'products', 'live_build', 'code_repo',
		'globe', 'surfaces/proposed-shop', null, 'static_site', 'Shop brief', 'website', '#112233', false, false
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sprmh_assert(
		(select site_id from public.qorpera_surfaces where id = v_proposed_id) is null,
		'proposed surface starts without site_id before approval'
	);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_approved_surface := public.qorpera_approve_proposed_surface(v_proposed_id);
	reset role;

	perform pg_temp.sprmh_assert(
		v_approved_surface ->> 'status' = 'active'
		and nullif(v_approved_surface ->> 'siteSlug', '') is not null
		and nullif(v_approved_surface ->> 'liveUrl', '') is not null
		and (select site_id from public.qorpera_surfaces where id = v_proposed_id) is not null,
		'qorpera_approve_proposed_surface provisions company site for live_build/code_repo surfaces'
	);

	-- WHY: Test preview freshness, retry reset, superseding, newest-first claim, expiry cap, selection filtering, and compare mode.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Storefront', 'storefront', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface_id;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_prev := (public.qorpera_start_surface_session(v_surface_id, 'Add hero banner', 'Hero banner') ->> 'id')::uuid;
	reset role;

	v_c1 := (public.qorpera_record_surface_change(
		v_sess_prev, 'Hero copy', 'Update hero copy', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.ts'], null, null, false
	) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(
		v_sess_prev, 'Footer links', 'Update footer', 'git_range',
		repeat('2', 40), repeat('3', 40), '{}'::uuid[], array['src/footer.ts'], null, null, false
	) ->> 'changeId')::uuid;
	v_c_disc := (public.qorpera_record_surface_change(
		v_sess_prev, 'Old draft', 'Discarded draft', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['src/old.ts'], null, null, true
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes set status = 'discarded', resolved_at = clock_timestamp() where id = v_c_disc;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface_id, array[v_c1, v_c_disc, v_c1], null, '{}'::uuid[], '/');
	reset role;

	v_p1_id := (v_sel #>> '{primary,previewId}')::uuid;
	select composition_key into strict v_p1_key from public.qorpera_surface_previews where id = v_p1_id;
	perform pg_temp.sprmh_assert(
		v_sel #> '{primary,toggledChangeIds}' = jsonb_build_array(v_c1)
		and (select toggled_change_ids from public.qorpera_member_surface_state where user_id = v_owner and surface_id = v_surface_id) = array[v_c1]
		and v_p1_id is not null,
		'set_preview_selection deduplicates and filters out discarded changes preserving order'
	);

	perform pg_temp.sprmh_finish_preview(
		v_p1_id, 'failed', null, jsonb_build_object('paths', jsonb_build_array('src/hero.ts')), 'Build failed'
	);

	update public.qorpera_surface_previews set attempts = 3 where id = v_p1_id;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface_id, array[v_c1], null, '{}'::uuid[], '/');
	reset role;

	perform pg_temp.sprmh_assert(
		(v_sel #>> '{primary,previewId}')::uuid = v_p1_id
		and v_sel #>> '{primary,status}' = 'composing'
		and (v_sel #>> '{primary,errorDetail}') is null
		and (v_sel #>> '{primary,conflictReport}') is null
		and (select conflict_report is null and error_detail is null and attempts = 0 from public.qorpera_surface_previews where id = v_p1_id),
		'failed preview resets status, error_detail, conflict_report, and attempts on re-selection'
	);

	-- WHY: Toggling away from an unbuilt composing preview immediately expires it so the worker skips obsolete toggles.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface_id, array[v_c2], null, '{}'::uuid[], '/');
	reset role;
	v_p2_id := (v_sel #>> '{primary,previewId}')::uuid;

	perform pg_temp.sprmh_assert(
		v_p2_id <> v_p1_id
		and (select expires_at <= clock_timestamp() from public.qorpera_surface_previews where id = v_p1_id),
		'obsolete unbuilt composing preview is superseded immediately'
	);

	-- WHY: Second member selects [c1, c2] later so newest-first claim order can be verified across active previews.
	update public.qorpera_surface_previews set created_at = clock_timestamp() - interval '30 seconds' where id = v_p2_id;
	perform pg_temp.sprmh_as(v_member);
	set local role authenticated;
	v_p3_id := (public.qorpera_set_preview_selection(v_surface_id, array[v_c1, v_c2], null, '{}'::uuid[], '/') #>> '{primary,previewId}')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(1, 'code_repo');
	reset role;

	perform pg_temp.sprmh_assert(
		jsonb_array_length(v_claimed -> 'previews') = 1
		and (v_claimed #>> '{previews,0,previewId}')::uuid = v_p3_id,
		'preview lane claims composing previews newest-first and skips superseded ones'
	);

	-- WHY: Verify expired building preview retries twice and fails permanently on 3rd lease expiry.
	for i in 1..3 loop
		update public.qorpera_surface_previews
		set status = 'building', lease_expires_at = clock_timestamp() - interval '1 minute'
		where id = v_p3_id;
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
		perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
		reset role;
		if i < 3 then
			perform pg_temp.sprmh_assert(
				(select attempts = i and status = 'building' from public.qorpera_surface_previews where id = v_p3_id),
				'expired building preview attempt ' || i::text || ' increments attempts and re-claims'
			);
		else
			perform pg_temp.sprmh_assert(
				(select attempts = 3 and status = 'failed' and error_detail = 'Preview worker lease expired repeatedly'
					from public.qorpera_surface_previews where id = v_p3_id),
				'expired building preview transitions to failed after 3 attempts'
			);
		end if;
	end loop;

	-- WHY: Complete p2 ready, then verify workspace invalidates on change rebase and on surface live_head_sha advance.
	perform pg_temp.sprmh_finish_preview(v_p2_id, 'ready', repeat('a', 40), null, null);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		(v_ws #>> '{previewState,primary,previewId}')::uuid = v_p2_id
		and v_ws #>> '{previewState,primary,status}' = 'ready'
		and v_ws #>> '{surface,liveHeadSha}' = repeat('1', 40),
		'workspace returns matching ready preview before rebase'
	);
	reset role;

	update public.qorpera_surface_changes set head_sha = repeat('5', 40) where id = v_c2;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		(v_ws #>> '{previewState,primary,previewId}') is null
		and v_ws #>> '{previewState,primary,status}' = 'live_baseline',
		'workspace refuses stale preview after change head_sha rebase'
	);
	v_p2_id := (public.qorpera_set_preview_selection(v_surface_id, array[v_c2], null, '{}'::uuid[], '/') #>> '{primary,previewId}')::uuid;
	reset role;

	perform pg_temp.sprmh_finish_preview(v_p2_id, 'ready', repeat('b', 40), null, null);

	update public.qorpera_surfaces set live_head_sha = repeat('6', 40) where id = v_surface_id;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		(v_ws #>> '{previewState,primary,previewId}') is null
		and v_ws #>> '{previewState,primary,status}' = 'live_baseline',
		'workspace refuses stale preview after surface live_head_sha advances'
	);
	reset role;

	-- WHY: Verify compare mode returns compareFrames in get_surface_workspace and invalidates when exploration branch_head_sha updates.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_start_surface_session(
		v_surface_id, 'Compare two header layouts', 'Header layouts', 'member', null, null, 2, 'Header exploration', array['Minimal', 'Bold']
	);
	reset role;

	select id into strict v_exp_id from public.qorpera_surface_explorations where surface_id = v_surface_id order by created_at desc limit 1;
	select id into strict v_var_a from public.qorpera_surface_sessions where exploration_id = v_exp_id and exploration_variant_label = 'Minimal';
	select id into strict v_var_b from public.qorpera_surface_sessions where exploration_id = v_exp_id and exploration_variant_label = 'Bold';
	update public.qorpera_surface_sessions set state = 'ready', branch_head_sha = repeat('7', 40) where id = v_var_a;
	update public.qorpera_surface_sessions set state = 'ready', branch_head_sha = repeat('8', 40) where id = v_var_b;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface_id, '{}'::uuid[], v_var_a, array[v_var_a, v_var_b], '/');
	reset role;
	v_cmp_a_id := (v_sel #>> '{compareFrames,0,frame,previewId}')::uuid;
	v_cmp_b_id := (v_sel #>> '{compareFrames,1,frame,previewId}')::uuid;

	perform pg_temp.sprmh_finish_preview(v_cmp_a_id, 'ready', repeat('c', 40), null, null);
	perform pg_temp.sprmh_finish_preview(v_cmp_b_id, 'ready', repeat('d', 40), null, null);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		v_ws #>> '{previewState,mode}' = 'compare'
		and jsonb_array_length(v_ws #> '{previewState,compareFrames}') = 2
		and (v_ws #>> '{previewState,compareFrames,0,frame,previewId}')::uuid = v_cmp_a_id
		and (v_ws #>> '{previewState,compareFrames,1,frame,previewId}')::uuid = v_cmp_b_id,
		'workspace returns compare mode and matching compareFrames'
	);
	reset role;

	update public.qorpera_surface_sessions set branch_head_sha = repeat('9', 40) where id = v_var_a;
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		(v_ws #>> '{previewState,compareFrames,0,frame,previewId}') is null
		and (v_ws #>> '{previewState,compareFrames,1,frame,previewId}')::uuid = v_cmp_b_id,
		'updating exploration branch_head_sha invalidates only that variant preview'
	);
	reset role;

	-- WHY: Verify lastPublishError is exposed in qorpera_surface_summary_json after a failed publish.
	update public.qorpera_surfaces set unpublished_change_count = 1 where id = v_surface_id;
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface_id);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_pub_job_id, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface_id;
	perform public.qorpera_surface_complete_publish(v_pub_job_id, 'failed', null, 'Vite build exited with code 1', v_pub_lease);
	reset role;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface_id);
	perform pg_temp.sprmh_assert(
		v_ws #>> '{surface,publishStatus}' = 'failed'
		and v_ws #>> '{surface,lastPublishError}' = 'Vite build exited with code 1',
		'summary exposes lastPublishError when publish fails'
	);
	reset role;

	-- WHY: Test conflict reconciliation with ragged conflict_paths arrays (no 2202E), rich origin_ref, turn read, enqueue, and discarding resolved conflicts.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_ra := (public.qorpera_start_surface_session(v_surface_id, 'Update pricing table', 'Pricing A') ->> 'id')::uuid;
	v_sess_rb := (public.qorpera_start_surface_session(v_surface_id, 'Update pricing badges', 'Pricing B') ->> 'id')::uuid;
	reset role;

	v_ch_ra := (public.qorpera_record_surface_change(
		v_sess_ra, 'Pricing tiers', 'Tier copy', 'git_range',
		repeat('6', 40), repeat('a', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;
	v_ch_rb := (public.qorpera_record_surface_change(
		v_sess_rb, 'Pricing badges', 'Badge styles', 'git_range',
		repeat('6', 40), repeat('b', 40), '{}'::uuid[], array['src/pricing.tsx', 'src/badges.css'], null, null, true
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes set status = 'conflicted', conflict_paths = array['src/pricing.tsx'] where id = v_ch_ra;
	update public.qorpera_surface_changes set status = 'conflicted', conflict_paths = array['src/pricing.tsx', 'src/badges.css'] where id = v_ch_rb;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_rec_sess := (public.qorpera_reconcile_surface_changes(v_surface_id, array[v_ch_ra, v_ch_rb]) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sprmh_assert(
		(select origin_ref ->> 'mainSha' from public.qorpera_surface_sessions where id = v_rec_sess) = repeat('6', 40)
		and (select origin_ref -> 'paths' from public.qorpera_surface_sessions where id = v_rec_sess) = '["src/badges.css","src/pricing.tsx"]'::jsonb
		and jsonb_array_length((select origin_ref -> 'changes' from public.qorpera_surface_sessions where id = v_rec_sess)) = 2,
		'reconcile_surface_changes handles ragged conflict_paths arrays without 2202E and populates rich origin_ref'
	);

	update public.qorpera_surface_sessions set state = 'ready' where id in (v_sess_prev, v_var_a, v_var_b, v_sess_ra, v_sess_rb);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_rec_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_rec_sess;

	v_rec_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_rec_sess, v_rec_lease);
	perform pg_temp.sprmh_assert(
		v_rec_turn -> 'conflictPaths' = '["src/badges.css","src/pricing.tsx"]'::jsonb
		and v_rec_turn ->> 'mainSha' = repeat('6', 40)
		and jsonb_array_length(v_rec_turn -> 'conflictDetails') = 2,
		'native_surface_read_session_turn unions origin_ref paths and exposes conflictDetails and mainSha'
	);

	v_rec_worker := (public.qorpera_surface_enqueue_session_run(v_rec_sess, v_rec_lease) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.sprmh_assert(
		(select base_sha from public.qorpera_coding_sessions where worker_id = v_rec_worker) is null
		and position('src/pricing.tsx' in (select dispatch ->> 'goal' from public.qorpera_runtime_workers where id = v_rec_worker)) > 0
		and position(repeat('6', 40) in (select dispatch ->> 'context' from public.qorpera_runtime_workers where id = v_rec_worker)) > 0
		and position(left(repeat('a', 40), 12) in (select dispatch ->> 'context' from public.qorpera_runtime_workers where id = v_rec_worker)) > 0,
		'reconciling enqueue sets base_sha null and enriches goal/context with conflicting commits and mainSha'
	);

	perform public.qorpera_record_surface_change(
		v_rec_sess, 'Resolved pricing', 'Combined tiers and badges', 'git_range',
		repeat('6', 40), repeat('c', 40), '{}'::uuid[], array['src/pricing.tsx', 'src/badges.css'], null, null, true
	);
	perform pg_temp.sprmh_assert(
		(select status = 'discarded' and conflict_paths is null from public.qorpera_surface_changes where id = v_ch_ra)
		and (select status = 'discarded' and conflict_paths is null from public.qorpera_surface_changes where id = v_ch_rb)
		and (select state from public.qorpera_surface_sessions where id = v_sess_ra) = 'discarded'
		and (select state from public.qorpera_surface_sessions where id = v_sess_rb) = 'discarded',
		'recording a resolved change on a reconciling session discards superseded conflicted changes and closes their sessions'
	);

	-- WHY: Verify S1 (base_sha null), S2 (active-worker reply cancels worker & supersedes), S3 (pre-v274 followUp & system fallback), and 30m coding expiry exemption.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_s1 := (public.qorpera_start_surface_session(v_surface_id, 'Add FAQ section', 'FAQ') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_s1
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_s1;
	v_worker_s1 := (public.qorpera_surface_enqueue_session_run(v_sess_s1, v_lease_s1) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.sprmh_assert(
		(select base_sha from public.qorpera_coding_sessions where worker_id = v_worker_s1) is null,
		'S1: initial coding session insert leaves base_sha null even when surface.live_head_sha is set'
	);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_sess_s1, 'Make FAQ collapsible', true);
	reset role;

	perform pg_temp.sprmh_assert(
		(select state from public.qorpera_runtime_workers where id = v_worker_s1) = 'cancelled'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_s1) = 'cancelled'
		and (select state = 'queued' and wake_id is null from public.qorpera_surface_sessions where id = v_sess_s1),
		'S2: replying to an active coding session cancels the active coding worker and re-queues cleanly'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_s1
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_s1;
	perform public.qorpera_surface_enqueue_session_run(v_sess_s1, v_lease_s1);
	reset role;

	perform pg_temp.sprmh_assert(
		(select sequence = 2 and dispatch ->> 'followUp' = 'Make FAQ collapsible'
			from public.qorpera_runtime_workers where id = v_worker_s1),
		'S2: re-enqueuing after active-worker reply dispatches sequence 2 with member reply'
	);

	-- WHY: Verify enqueue does not short-circuit an active worker when a newer member message exists.
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body, created_at)
	values (v_company_a, v_sess_s1, 'member', v_owner, 'Also add search filter', clock_timestamp() + interval '5 seconds');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_enqueue_session_run(v_sess_s1, v_lease_s1);
	reset role;
	perform pg_temp.sprmh_assert(
		(select sequence = 3 and dispatch ->> 'followUp' = 'Also add search filter'
			from public.qorpera_runtime_workers where id = v_worker_s1),
		'S2: enqueue supersedes active worker when a newer member message exists'
	);

	-- WHY: Verify S3 pre-v274 session (worker_id null) carries latest member reply in dispatch.followUp.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_pre := (public.qorpera_start_surface_session(v_surface_id, 'Initial pre-v274 prompt', 'Pre-v274') ->> 'id')::uuid;
	perform public.qorpera_reply_surface_session(v_sess_pre, 'Follow-up after v274 upgrade', true);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_pre
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_pre;
	v_worker_pre := (public.qorpera_surface_enqueue_session_run(v_sess_pre, v_lease_pre) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.sprmh_assert(
		(select dispatch ->> 'followUp' from public.qorpera_runtime_workers where id = v_worker_pre) = 'Follow-up after v274 upgrade',
		'S3: pre-v274 session with worker_id null populates dispatch.followUp from latest member reply'
	);

	-- WHY: Verify system/cofounder session follow-up falls back to v_session.prompt instead of generic text.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_sess_sys := (public.qorpera_service_start_surface_session(
		v_company_a, v_surface_id, 'Polish checkout typography', 'Checkout polish', 'cofounder', 'Co-Founder'
	) ->> 'sessionId')::uuid;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_sys
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_sys;
	v_worker_sys := (public.qorpera_surface_enqueue_session_run(v_sess_sys, v_lease_sys) ->> 'workerId')::uuid;
	reset role;

	perform public.qorpera_surface_cancel_coding_workers(array[v_sess_sys], 'surface_superseded');
	update public.qorpera_surface_sessions set state = 'queued', lease_expires_at = null, lease_token = null where id = v_sess_sys;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_sys
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_sys;
	perform public.qorpera_surface_enqueue_session_run(v_sess_sys, v_lease_sys);
	reset role;

	perform pg_temp.sprmh_assert(
		(select dispatch ->> 'followUp' from public.qorpera_runtime_workers where id = v_worker_sys) = 'Polish checkout typography',
		'system/cofounder follow-up falls back to session prompt when no member message exists'
	);

	-- WHY: Verify 30-minute queued coding session exemption in qorpera_surface_expire_coding_sessions.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_exp := (public.qorpera_start_surface_session(v_surface_id, 'Long queued coding job', 'Queue wait') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_exp
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_sess_exp;
	v_worker_exp := (public.qorpera_surface_enqueue_session_run(v_sess_exp, v_lease_exp) ->> 'workerId')::uuid;
	reset role;

	update public.qorpera_surface_sessions set lease_expires_at = clock_timestamp() - interval '1 minute' where id = v_sess_exp;
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '15 minutes' where worker_id = v_worker_exp;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;

	perform pg_temp.sprmh_assert(
		(select state = 'running' and retry_count = 0 from public.qorpera_surface_sessions where id = v_sess_exp)
		and (select state = 'active' from public.qorpera_runtime_workers where id = v_worker_exp),
		'queued coding session under 30 minutes is exempted from lease expiry'
	);

	update public.qorpera_coding_sessions
	set created_at = clock_timestamp() - interval '31 minutes', updated_at = clock_timestamp() - interval '31 minutes'
	where worker_id = v_worker_exp;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;

	perform pg_temp.sprmh_assert(
		(select retry_count = 1 from public.qorpera_surface_sessions where id = v_sess_exp)
		and (select state = 'cancelled' from public.qorpera_runtime_workers where id = v_worker_exp),
		'queued coding session over 30 minutes expires cleanly'
	);

	-- WHY: Verify fallback parent_sha skips merged/discarded changes in qorpera_native_surface_record_change.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_par := (public.qorpera_start_surface_session(v_surface_id, 'Multi-step edits', 'Parent SHA test') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surface_sessions
	set state = 'running', base_sha = repeat('6', 40), branch_head_sha = null,
		lease_token = extensions.gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_sess_par
	returning lease_token into strict v_lease_par;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind, parent_sha, head_sha, status, resolved_at
	) values (
		v_company_a, v_surface_id, v_sess_par, 1, 'Merged step', 'Already landed', 'git_range',
		repeat('6', 40), repeat('d', 40), 'merged', clock_timestamp()
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_rec_par := public.qorpera_native_surface_record_change(
		v_company_a, v_sess_par, 'Next step', 'Fresh edit', 'git_range',
		null, repeat('e', 40), '{}'::uuid[], array['src/next.ts'], null, null, true, v_lease_par
	);
	reset role;

	perform pg_temp.sprmh_assert(
		(select parent_sha from public.qorpera_surface_changes where id = (v_rec_par ->> 'changeId')::uuid) = repeat('6', 40),
		'fallback parent_sha ignores already-merged changes'
	);

	-- WHY: Verify transitive depends_on_change_ids (depth/cycle safe, filters merged/discarded) + v_needs_worker across all targets.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_dep := (public.qorpera_start_surface_session(v_surface_id, 'Chained changes', 'Dep chain') ->> 'id')::uuid;
	v_sess_other := (public.qorpera_start_surface_session(v_surface_id, 'Concurrent change', 'Concurrent') ->> 'id')::uuid;
	v_sess_peer_run := (public.qorpera_start_surface_session(v_surface_id, 'Active peer', 'Active peer') ->> 'id')::uuid;
	v_sess_peer_idle := (public.qorpera_start_surface_session(v_surface_id, 'Idle peer', 'Idle peer') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surface_sessions set state = 'ready', base_sha = repeat('6', 40) where id in (v_sess_dep, v_sess_other, v_sess_peer_idle);
	update public.qorpera_surface_sessions set state = 'running', base_sha = repeat('6', 40) where id = v_sess_peer_run;

	v_worker_peer_run := v_worker_s1;
	v_worker_peer_idle := v_worker_pre;
	perform public.qorpera_surface_cancel_coding_workers(array[v_sess_pre], 'surface_superseded');
	update public.qorpera_coding_sessions set base_sha = repeat('6', 40) where worker_id = v_worker_peer_idle;
	update public.qorpera_surface_sessions set worker_id = v_worker_peer_run where id = v_sess_peer_run;
	update public.qorpera_surface_sessions set worker_id = v_worker_peer_idle where id = v_sess_peer_idle;

	perform public.qorpera_record_surface_change(
		v_sess_peer_run, 'Peer running change', 'In progress', 'git_range',
		repeat('6', 40), repeat('9', 40), '{}'::uuid[], array['src/peer1.ts'], null, null, false
	);
	perform public.qorpera_record_surface_change(
		v_sess_peer_idle, 'Peer idle change', 'Ready to rebase', 'git_range',
		repeat('6', 40), repeat('8', 40), '{}'::uuid[], array['src/peer2.ts'], null, null, true
	);

	v_d1 := (public.qorpera_record_surface_change(
		v_sess_dep, 'Base merged', 'Landed', 'git_range',
		repeat('6', 40), repeat('1', 40), '{}'::uuid[], array['src/d1.ts'], null, null, false
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes set status = 'merged', resolved_at = clock_timestamp() where id = v_d1;

	v_d_disc := (public.qorpera_record_surface_change(
		v_sess_dep, 'Discarded dep', 'Dropped', 'git_range',
		repeat('6', 40), repeat('2', 40), '{}'::uuid[], array['src/dd.ts'], null, null, false
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes set status = 'discarded', resolved_at = clock_timestamp() where id = v_d_disc;

	v_d2 := (public.qorpera_record_surface_change(
		v_sess_dep, 'Middle dep', 'Staged', 'git_range',
		repeat('6', 40), repeat('3', 40), array[v_d1, v_d_disc], array['src/d2.ts'], null, null, false
	) ->> 'changeId')::uuid;
	v_d3 := (public.qorpera_record_surface_change(
		v_sess_dep, 'Top change', 'Depends on middle', 'git_range',
		repeat('3', 40), null, array[v_d2], array['src/d3.ts'], null, null, true
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes set depends_on_change_ids = array[v_d1, v_d_disc, v_d3] where id = v_d2;

	v_ch_other := (public.qorpera_record_surface_change(
		v_sess_other, 'Other session edit', 'Queued second', 'git_range',
		repeat('6', 40), repeat('4', 40), '{}'::uuid[], array['src/other.ts'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_d3, true);
	perform public.qorpera_approve_surface_change(v_ch_other, true);
	reset role;

	select id into strict v_job_1 from public.qorpera_surface_jobs where session_id = v_sess_dep and kind = 'land_change' order by created_at desc limit 1;
	select id into strict v_job_2 from public.qorpera_surface_jobs where session_id = v_sess_other and kind = 'land_change' order by created_at desc limit 1;

	perform pg_temp.sprmh_assert(
		(select payload -> 'changeIds' from public.qorpera_surface_jobs where id = v_job_1) = jsonb_build_array(v_d2, v_d3),
		'approve_surface_change resolves transitive cycle-safe open deps, excludes merged/discarded, and detects v_needs_worker across all targets'
	);

	-- WHY: Verify claim_pending_jobs_for_lane serializes land_change per surface_id, filters approvedChanges, and excludes running peers.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;

	perform pg_temp.sprmh_assert(
		(select count(*) from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'surfaceId')::uuid = v_surface_id) = 1
		and (select status from public.qorpera_surface_jobs where id = v_job_1) = 'running'
		and (select status from public.qorpera_surface_jobs where id = v_job_2) = 'queued',
		'claim_pending_jobs_for_lane serializes merge jobs per surface_id'
	);

	select m into strict v_merge_1
	from jsonb_array_elements(v_claimed -> 'merges') m
	where (m ->> 'jobId')::uuid = v_job_1;
	v_job_1_lease := (v_merge_1 ->> 'leaseToken')::uuid;

	perform pg_temp.sprmh_assert(
		not exists (
			select 1 from jsonb_array_elements(v_merge_1 -> 'peerSessions') p
			where (p ->> 'sessionId')::uuid = v_sess_peer_run
		)
		and exists (
			select 1 from jsonb_array_elements(v_merge_1 -> 'peerSessions') p
			where (p ->> 'sessionId')::uuid = v_sess_peer_idle
		),
		'peerSessions excludes running peer sessions and includes idle peer sessions'
	);

	-- WHY: A second claim while job_1 is running must not claim job_2 on the same surface.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;
	perform pg_temp.sprmh_assert(
		not exists (select 1 from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'surfaceId')::uuid = v_surface_id),
		'second claim skips surface with an already running land_change job'
	);

	-- WHY: Verify complete_merge writes system messages on conflict/failure and releases surface for job_2.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_job_1, 'conflicted', repeat('6', 40), null, v_d2, array['src/d2.ts'], 'Conflict on src/d2.ts', null, v_job_1_lease
	);
	reset role;

	perform pg_temp.sprmh_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_sess_dep and m.author_kind = 'system' and m.body like 'Merge conflicted%src/d2.ts%'
		),
		'complete_merge posts concise system message on merge conflict'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (m ->> 'leaseToken')::uuid into strict v_job_2_lease
	from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'jobId')::uuid = v_job_2;
	perform public.qorpera_surface_complete_merge(
		v_job_2, 'failed', repeat('6', 40), null, null, null, 'Code host unavailable', null, v_job_2_lease
	);
	reset role;

	perform pg_temp.sprmh_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_sess_other and m.author_kind = 'system' and m.body like 'Merge failed%Code host unavailable%'
		),
		'complete_merge posts concise system message on merge failure'
	);

	-- WHY: Verify approve_session_all strips toggled_change_ids, git_range batch undo expands to all batch changes,
	-- active-job guard blocks approve-during-undo, complete_merge clears landed_main_* on undo landed, and rebase updates surface session base_sha only.
	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	v_sess_batch := (public.qorpera_start_surface_session(v_surface_id, 'Batch git range', 'Batch git') ->> 'id')::uuid;
	reset role;

	v_b1 := (public.qorpera_record_surface_change(
		v_sess_batch, 'Batch 1', 'First commit', 'git_range',
		repeat('6', 40), repeat('a', 40), '{}'::uuid[], array['src/b1.ts'], null, null, false
	) ->> 'changeId')::uuid;
	v_b2 := (public.qorpera_record_surface_change(
		v_sess_batch, 'Batch 2', 'Second commit', 'git_range',
		repeat('a', 40), repeat('b', 40), array[v_b1], array['src/b2.ts'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_set_preview_selection(v_surface_id, array[v_b1, v_b2], null, '{}'::uuid[], '/');
	perform public.qorpera_approve_session_all(v_sess_batch);
	reset role;

	perform pg_temp.sprmh_assert(
		(select toggled_change_ids from public.qorpera_member_surface_state where user_id = v_owner and surface_id = v_surface_id) = '{}'::uuid[],
		'approve_session_all strips approved change IDs from toggled_change_ids'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (m ->> 'jobId')::uuid, (m ->> 'leaseToken')::uuid
	into strict v_batch_job, v_batch_lease
	from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'sessionId')::uuid = v_sess_batch;
	perform public.qorpera_surface_complete_merge(
		v_batch_job, 'landed', repeat('6', 40), repeat('f', 40), null, null, null, null, v_batch_lease
	);
	reset role;

	perform pg_temp.sprmh_assert(
		(select (public.qorpera_surface_session_json(s) #>> '{changes,1,undoBatchSize}')::integer
			from public.qorpera_surface_sessions s where s.id = v_sess_batch) = 2,
		'session JSON reports undoBatchSize = 2 for multi-change git_range batch'
	);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_b2);
	reset role;

	select id into strict v_undo_job from public.qorpera_surface_jobs where session_id = v_sess_batch and kind = 'undo_change' order by created_at desc limit 1;
	perform pg_temp.sprmh_assert(
		(select status from public.qorpera_surface_changes where id = v_b1) = 'staged'
		and (select status from public.qorpera_surface_changes where id = v_b2) = 'staged'
		and (select payload -> 'changeIds' from public.qorpera_surface_jobs where id = v_undo_job) = jsonb_build_array(v_b1, v_b2),
		'undo_surface_change expands multi-change git_range undo to all merged changes in the same batch range'
	);

	v_errcode := null;
	begin
		perform pg_temp.sprmh_as(v_owner);
		set local role authenticated;
		perform public.qorpera_approve_surface_change(v_b1, true);
		reset role;
	exception when others then
		v_errcode := sqlstate;
		reset role;
	end;
	perform pg_temp.sprmh_assert(
		v_errcode = '55000',
		'approve_surface_change rejects approving a change while its undo_change job is still active'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (m ->> 'leaseToken')::uuid into strict v_undo_lease
	from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'jobId')::uuid = v_undo_job;
	perform public.qorpera_surface_complete_merge(
		v_undo_job, 'failed', repeat('f', 40), null, null, null, 'Revert rejected by host', null, v_undo_lease
	);
	reset role;

	perform pg_temp.sprmh_assert(
		(select status = 'merged' from public.qorpera_surface_changes where id = v_b1)
		and (select status = 'merged' from public.qorpera_surface_changes where id = v_b2)
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_sess_batch and m.author_kind = 'system' and m.body like 'Undo failed%Revert rejected by host%'
		),
		'failed undo restores batch to merged and posts concise system message'
	);

	perform pg_temp.sprmh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_b2);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (m ->> 'jobId')::uuid, (m ->> 'leaseToken')::uuid
	into strict v_undo_job, v_undo_lease
	from jsonb_array_elements(v_claimed -> 'merges') m where (m ->> 'sessionId')::uuid = v_sess_batch and m ->> 'kind' = 'undo_change';
	perform public.qorpera_surface_complete_merge(
		v_undo_job, 'landed', repeat('f', 40), repeat('6', 40), null, null, null, null, v_undo_lease
	);
	reset role;

	perform pg_temp.sprmh_assert(
		(select live_head_sha from public.qorpera_surfaces where id = v_surface_id) = repeat('6', 40)
		and (select landed_main_before is null and landed_main_after is null from public.qorpera_surface_changes where id = v_b1)
		and (select landed_main_before is null and landed_main_after is null from public.qorpera_surface_changes where id = v_b2),
		'landed undo updates live_head_sha and clears landed_main_before/landed_main_after on undone batch'
	);

	-- WHY: Verify qorpera_surface_update_rebased_changes advances surface session base_sha without mutating coding_sessions.base_sha.
	update public.qorpera_surfaces set live_head_sha = repeat('e', 40) where id = v_surface_id;
	select base_sha into strict v_peer_coding_base from public.qorpera_coding_sessions where worker_id = v_worker_peer_idle;
	select id into strict v_peer_change_id from public.qorpera_surface_changes where session_id = v_sess_peer_idle limit 1;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_update_rebased_changes(
		v_surface_id,
		v_sess_peer_idle,
		repeat('7', 40),
		jsonb_build_array(jsonb_build_object(
			'changeId', v_peer_change_id,
			'parentSha', repeat('e', 40),
			'headSha', repeat('7', 40)
		)),
		null,
		null
	);
	reset role;

	perform pg_temp.sprmh_assert(
		(select base_sha = repeat('e', 40) and branch_head_sha = repeat('7', 40)
			from public.qorpera_surface_sessions where id = v_sess_peer_idle)
		and (select base_sha from public.qorpera_coding_sessions where worker_id = v_worker_peer_idle) = v_peer_coding_base,
		'update_rebased_changes advances qorpera_surface_sessions.base_sha without modifying qorpera_coding_sessions.base_sha'
	);
end $$;
