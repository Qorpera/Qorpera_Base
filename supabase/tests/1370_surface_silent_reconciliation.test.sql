-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ssr_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_silent_reconciliation: %', p_message;
	end if;
end $$;

create function pg_temp.ssr_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_outsider constant uuid := '13700000-0000-4000-8000-000000000099';
	v_exec_owner constant uuid := '13700000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13700000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13700000-0000-4000-8000-000000000021';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_folder_surface_id uuid;
	v_code_surface_id uuid;
	v_fs1 uuid;
	v_fs2 uuid;
	v_fc1 uuid;
	v_fc2 uuid;
	v_rec1 jsonb;
	v_rec2 jsonb;
	v_rec_id uuid;
	v_hidden_sess uuid;
	v_hidden_lease uuid;
	v_turn jsonb;
	v_ws jsonb;
	v_claimed jsonb;
	v_merge_job jsonb;
	v_merge_job_id uuid;
	v_merge_lease uuid;
	v_undo_job jsonb;
	v_cs1 uuid;
	v_cs2 uuid;
	v_cc1 uuid;
	v_cc2 uuid;
	v_preview_id uuid;
	v_preview_lease uuid;
	v_code_rec_id uuid;
	v_code_hidden_sess uuid;
	v_code_hidden_lease uuid;
	v_code_worker uuid;
	v_code_rec_retry jsonb;
	v_code_hidden_sess_2 uuid;
	v_code_hidden_lease_2 uuid;
	v_preview_claim jsonb;
	v_cs3 uuid;
	v_cc3 uuid;
	v_land_job_id uuid;
	v_land_lease uuid;
	v_auto_rec_id uuid;
	v_auto_sess_id uuid;
	v_auto_land_job_id uuid;
	v_auto_land_lease uuid;
	v_cs_rebase uuid;
	v_cc_rebase uuid;
	v_errcode text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	insert into auth.users(id, email) values (v_outsider, 'outsider-1370@example.test');
	insert into auth.users(id, email) values (v_exec_owner, 'exec-owner-1370@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SSR Exec Co', v_exec_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SSR Exec Env', 1, v_exec_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1370', true, array['codex', 'claude-code']);

	perform pg_temp.ssr_assert(
		not has_table_privilege('anon', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_table_privilege('authenticated', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_function_privilege('anon', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_ensure_surface_reconciliation(uuid,uuid[],text[],boolean)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_ensure_surface_reconciliation(uuid,uuid[],text[],boolean)', 'EXECUTE'),
		'reconciliation table and helpers are locked down while ensure_surface_reconciliation is authenticated-only'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_folder_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Identity', 'identity', 'studio', 'identity', 'palette', '#1a56db', 'identity', null, false
	) ->> 'id')::uuid;
	v_code_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Storefront', 'storefront', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_code_surface_id;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_fs1 := (public.qorpera_start_surface_session(v_folder_surface_id, 'Add buyer journey diagram', 'Buyer journey') ->> 'id')::uuid;
	v_fs2 := (public.qorpera_start_surface_session(v_folder_surface_id, 'Lighter blue accent on dark backgrounds', 'Lighter blue') ->> 'id')::uuid;
	reset role;

	v_fc1 := (public.qorpera_record_surface_change(
		v_fs1, 'Buyer journey section', 'Adds journey diagram to guide', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md'], null,
		jsonb_build_object(
			'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nJourney copy')),
			'baseFiles', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')
		),
		true
	) ->> 'changeId')::uuid;

	v_fc2 := (public.qorpera_record_surface_change(
		v_fs2, 'Lighter blue guide update', 'Updates blue guidance', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md'], null,
		jsonb_build_object(
			'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nLighter blue copy')),
			'baseFiles', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')
		),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_assert(
		(select jsonb_typeof(patch_manifest) = 'array' and base_files ->> 'identity/guide.md' = E'# Brand\nOriginal copy'
			from public.qorpera_surface_changes where id = v_fc1)
		and (select (public.qorpera_surface_session_json(s) #>> '{changes,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy'
			from public.qorpera_surface_sessions s where s.id = v_fs1),
		'record_surface_change unwraps folder_patch ops and baseFiles and exposes baseFiles in session JSON'
	);

	v_errcode := null;
	perform pg_temp.ssr_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc1, v_fc2], array['identity/guide.md'], false);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.ssr_assert(v_errcode = '42501', 'outsider refused by qorpera_ensure_surface_reconciliation');

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_rec1 := public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc2, v_fc1], array['identity/guide.md'], false);
	v_rec2 := public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc1, v_fc2], array['identity/guide.md'], false);
	v_ws := public.qorpera_get_surface_workspace(v_folder_surface_id);
	reset role;

	v_rec_id := (v_rec1 ->> 'id')::uuid;
	select session_id into strict v_hidden_sess from public.qorpera_surface_reconciliations where id = v_rec_id;

	perform pg_temp.ssr_assert(
		v_rec1 ->> 'status' = 'queued'
		and v_rec2 ->> 'id' = v_rec1 ->> 'id'
		and (select count(*) from public.qorpera_surface_sessions where surface_id = v_folder_surface_id and is_internal) = 1
		and (v_ws #>> '{surface,folderRevision}')::bigint = 0
		and (v_ws #>> '{surface,activeSessionCount}')::integer = 2
		and (v_ws #>> '{surface,needsAttentionCount}')::integer = 0
		and not exists (
			select 1 from jsonb_array_elements(v_ws -> 'activeSessions') s where (s ->> 'id')::uuid = v_hidden_sess
		)
		and jsonb_array_length(v_ws -> 'reconciliations') = 1
		and (v_ws #>> '{reconciliations,0,id}')::uuid = v_rec_id,
		'ensure_surface_reconciliation deduplicates idempotently, hides internal session from workspace, and exposes reconciliation'
	);

	update public.qorpera_surface_sessions set state = 'ready' where id in (v_fs1, v_fs2);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_hidden_sess;

	v_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_hidden_sess, v_hidden_lease);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'running' and attempts = 1 from public.qorpera_surface_reconciliations where id = v_rec_id)
		and (v_turn ->> 'isInternal')::boolean = true
		and (v_turn ->> 'folderRevision')::bigint = 0
		and jsonb_array_length(v_turn -> 'conflictDetails') = 2
		and (v_turn #>> '{conflictDetails,0,prompt}') = 'Add buyer journey diagram'
		and jsonb_typeof(v_turn #> '{conflictDetails,0,patchManifest}') = 'array'
		and (v_turn #>> '{conflictDetails,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy',
		'claiming internal folder reconciliation marks running and turn read includes isInternal, prompt, patchManifest, and baseFiles'
	);

	perform public.qorpera_record_surface_change(
		v_hidden_sess, 'Combined guide update', 'Preserves journey and lighter blue', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nJourney copy\nLighter blue copy')),
		true
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(
		v_hidden_sess, 'ready', 'Combined overlapping updates cleanly.', null, null, null, v_hidden_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'ready' and jsonb_typeof(reconciled_patch_manifest) = 'array' from public.qorpera_surface_reconciliations where id = v_rec_id)
		and (select state = 'completed' and wake_id is null from public.qorpera_surface_sessions where id = v_hidden_sess)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_fc1)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_fc2),
		'completing internal folder reconciliation caches ready overlay without discarding original changes'
	);

	-- WHY: Queue a multi-change folder land job matching the ready reconciliation and verify claim attaches reconciledPatchManifest + baseFiles.
	update public.qorpera_surface_changes set status = 'merging' where id in (v_fc1, v_fc2);
	insert into public.qorpera_surface_jobs(profile_id, surface_id, session_id, kind, payload, requested_by_user_id)
	values (
		v_company_a, v_folder_surface_id, v_fs1, 'land_change',
		jsonb_build_object('changeIds', jsonb_build_array(v_fc1, v_fc2), 'autoPublish', false),
		v_owner
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder');
	select elem into strict v_merge_job
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_folder_surface_id;
	v_merge_job_id := (v_merge_job ->> 'jobId')::uuid;
	v_merge_lease := (v_merge_job ->> 'leaseToken')::uuid;
	reset role;

	perform pg_temp.ssr_assert(
		jsonb_typeof(v_merge_job -> 'reconciledPatchManifest') = 'array'
		and (v_merge_job #>> '{approvedChanges,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy',
		'folder merge claim attaches reconciledPatchManifest and per-change baseFiles'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_merge_job_id, 'landed', null, null, null, null, null,
		jsonb_build_object('snapshotId', repeat('a', 64), 'folderRoot', 'identity', 'filesBefore', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')),
		v_merge_lease
	);
	reset role;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_folder_surface_id);
	reset role;

	perform pg_temp.ssr_assert(
		(v_ws #>> '{surface,folderRevision}')::bigint = 1
		and jsonb_array_length(v_ws -> 'reconciliations') = 0,
		'folder land increments folderRevision and drops stale reconciliations from workspace'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_fc1);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder');
	select elem into strict v_undo_job
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_folder_surface_id and elem ->> 'kind' = 'undo_change';
	perform public.qorpera_surface_complete_merge(
		(v_undo_job ->> 'jobId')::uuid, 'landed', null, null, null, null, null, null, (v_undo_job ->> 'leaseToken')::uuid
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select folder_revision from public.qorpera_surfaces where id = v_folder_surface_id) = 2,
		'folder undo increments folderRevision'
	);

	-- WHY: Verify code_repo preview conflict -> silent reconciling -> failure -> explicit retry -> ready -> composing with reconciledCommitSha.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs1 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update pricing hero', 'Hero A') ->> 'id')::uuid;
	v_cs2 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update pricing subtitle', 'Hero B') ->> 'id')::uuid;
	reset role;

	v_cc1 := (public.qorpera_record_surface_change(
		v_cs1, 'Pricing hero', 'Hero title', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;
	v_cc2 := (public.qorpera_record_surface_change(
		v_cs2, 'Pricing subtitle', 'Hero subtitle', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_preview_id := (public.qorpera_set_preview_selection(v_code_surface_id, array[v_cc1, v_cc2], null, '{}'::uuid[], '/') #>> '{primary,previewId}')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'leaseToken')::uuid into strict v_preview_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = v_preview_id;

	perform public.qorpera_surface_complete_preview(
		v_preview_id, 'conflicted', null, null,
		jsonb_build_object('paths', jsonb_build_array('src/pricing.tsx'), 'changeIds', jsonb_build_array(v_cc1, v_cc2)),
		null, v_preview_lease
	);
	reset role;

	select id, session_id into strict v_code_rec_id, v_code_hidden_sess
	from public.qorpera_surface_reconciliations
	where surface_id = v_code_surface_id;

	perform pg_temp.ssr_assert(
		(select status = 'reconciling' and conflict_report is null from public.qorpera_surface_previews where id = v_preview_id)
		and (select status = 'queued' from public.qorpera_surface_reconciliations where id = v_code_rec_id),
		'code_repo preview conflict transitions preview to reconciling and enqueues hidden reconciliation'
	);

	update public.qorpera_surface_sessions set state = 'ready' where id in (v_cs1, v_cs2);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess;

	v_code_worker := (public.qorpera_surface_enqueue_session_run(v_code_hidden_sess, v_code_hidden_lease) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.ssr_assert(
		v_code_worker is not null
		and position('Never call coding_ask.' in (select dispatch ->> 'goal' from public.qorpera_runtime_workers where id = v_code_worker)) > 0
		and position('Never call coding_ask.' in (select dispatch ->> 'definitionOfDone' from public.qorpera_runtime_workers where id = v_code_worker)) > 0,
		'internal code_repo reconciliation enqueues non-interactive coding worker'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(
		v_code_hidden_sess, 'needs_input', 'Asked a question anyway', null, null, null, v_code_hidden_lease
	);
	reset role;
	perform pg_temp.ssr_assert(
		(select state = 'reconciling' and retry_count = 1 from public.qorpera_surface_sessions where id = v_code_hidden_sess)
		and (select status = 'running' from public.qorpera_surface_reconciliations where id = v_code_rec_id),
		'first incomplete internal reconciliation turn retries automatically'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess;
	perform public.qorpera_surface_complete_session_turn(
		v_code_hidden_sess, 'failed', 'Second attempt failed', null, null, null, v_code_hidden_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'failed' from public.qorpera_surface_reconciliations where id = v_code_rec_id)
		and (select status = 'failed' from public.qorpera_surface_previews where id = v_preview_id),
		'exhausted internal reconciliation fails both reconciliation row and waiting reconciling preview'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_code_rec_retry := public.qorpera_ensure_surface_reconciliation(v_code_surface_id, array[v_cc1, v_cc2], array['src/pricing.tsx'], true);
	reset role;

	select session_id into strict v_code_hidden_sess_2 from public.qorpera_surface_reconciliations where id = v_code_rec_id;
	perform pg_temp.ssr_assert(
		v_code_rec_retry ->> 'status' = 'queued'
		and v_code_hidden_sess_2 <> v_code_hidden_sess
		and (select status = 'reconciling' from public.qorpera_surface_previews where id = v_preview_id),
		'explicit retry resets failed reconciliation to queued and restores waiting preview to reconciling'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease_2
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess_2;
	reset role;

	perform public.qorpera_record_surface_change(
		v_code_hidden_sess_2, 'Reconciled pricing', 'Combined hero and subtitle', 'git_range',
		repeat('1', 40), repeat('9', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	);

	perform pg_temp.ssr_assert(
		(select status = 'ready' and reconciled_commit_sha = repeat('9', 40) from public.qorpera_surface_reconciliations where id = v_code_rec_id)
		and (select status = 'composing' from public.qorpera_surface_previews where id = v_preview_id)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_cc1)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_cc2),
		'ready code_repo reconciliation flips preview back to composing without discarding original changes'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select elem into strict v_preview_claim
	from jsonb_array_elements(v_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = v_preview_id;
	reset role;

	perform pg_temp.ssr_assert(
		v_preview_claim ->> 'reconciledCommitSha' = repeat('9', 40),
		'code_repo preview claim attaches reconciledCommitSha'
	);

	-- WHY: Verify merge conflict -> auto_approve_after silent reconciliation -> automatic land_change re-queue, and no infinite loop if that retry conflicts.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs3 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update checkout copy', 'Checkout') ->> 'id')::uuid;
	reset role;

	v_cc3 := (public.qorpera_record_surface_change(
		v_cs3, 'Checkout copy', 'Checkout wording', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['src/checkout.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_cc3, false);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_land_job_id, v_land_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_code_surface_id;

	perform public.qorpera_surface_complete_merge(
		v_land_job_id, 'conflicted', repeat('1', 40), null, v_cc3, array['src/checkout.tsx'], 'Merge conflict', null, v_land_lease
	);
	reset role;

	select id, session_id into strict v_auto_rec_id, v_auto_sess_id
	from public.qorpera_surface_reconciliations
	where surface_id = v_code_surface_id and v_cc3 = any(selected_change_ids);

	perform pg_temp.ssr_assert(
		(select status = 'staged' from public.qorpera_surface_changes where id = v_cc3)
		and (select auto_approve_after = true and status = 'queued' from public.qorpera_surface_reconciliations where id = v_auto_rec_id),
		'merge conflict keeps change staged and queues auto_approve_after silent reconciliation'
	);

	perform public.qorpera_record_surface_change(
		v_auto_sess_id, 'Reconciled checkout', 'Clean checkout commit', 'git_range',
		repeat('1', 40), repeat('8', 40), '{}'::uuid[], array['src/checkout.tsx'], null, null, true
	);

	perform pg_temp.ssr_assert(
		(select status = 'merging' from public.qorpera_surface_changes where id = v_cc3)
		and exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_code_surface_id
				and j.kind = 'land_change'
				and j.status = 'queued'
				and (j.payload ->> 'reconciliationId')::uuid = v_auto_rec_id
		),
		'completing auto_approve_after reconciliation automatically re-queues land_change with reconciliationId'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_auto_land_job_id, v_auto_land_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_code_surface_id and elem ->> 'reconciledCommitSha' = repeat('8', 40);

	perform public.qorpera_surface_complete_merge(
		v_auto_land_job_id, 'conflicted', repeat('1', 40), null, v_cc3, array['src/checkout.tsx'], 'Still conflicted', null, v_auto_land_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		not exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_code_surface_id and j.kind = 'land_change' and j.status in ('queued', 'running')
		)
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_cs3 and m.author_kind = 'system' and m.body = 'Could not apply this change automatically. Try approving again.'
		),
		'conflicted retry carrying reconciliationId does not loop and posts plain retry message'
	);

	-- WHY: Verify rebase conflict keeps change staged and queues silent reconciliation.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs_rebase := (public.qorpera_start_surface_session(v_code_surface_id, 'Update footer text', 'Footer') ->> 'id')::uuid;
	reset role;
	v_cc_rebase := (public.qorpera_record_surface_change(
		v_cs_rebase, 'Footer text', 'Footer copy', 'git_range',
		repeat('1', 40), repeat('5', 40), '{}'::uuid[], array['src/footer.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_update_rebased_changes(
		v_code_surface_id, v_cs_rebase, null, '[]'::jsonb, v_cc_rebase, array['src/footer.tsx']
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'staged' and conflict_paths is null from public.qorpera_surface_changes where id = v_cc_rebase)
		and exists (
			select 1 from public.qorpera_surface_reconciliations r
			where r.surface_id = v_code_surface_id and v_cc_rebase = any(r.selected_change_ids)
		),
		'rebase conflict keeps change staged and enqueues silent reconciliation'
	);
end $$;
