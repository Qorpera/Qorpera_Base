-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.img_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.img_other_user() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000002'::uuid
$$;

create function pg_temp.img_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.img_activate(p_with_image_bundle boolean) returns public.qorpera_runtime_bundles language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := jsonb_set(
		jsonb_set(v_active.manifest, '{modelPolicy,geminiChoice}', '"thread"'),
		'{modelPolicy,claudeChoice}', '"thread"'
	);
	if p_with_image_bundle then
		v_manifest := jsonb_set(
			v_manifest,
			'{implementation,packages/runtime/src/cloud-run-picture-lane.ts}',
			to_jsonb(repeat('a', 64))
		);
	else
		v_manifest := v_manifest #- '{implementation,packages/runtime/src/cloud-run-picture-lane.ts}'
			#- '{modelPolicy,imageChoice}';
	end if;
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle;
end $$;

create function pg_temp.img_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	execute p_sql into v_result;
	perform pg_temp.base_claims('service_role');
	return v_result;
exception when others then
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end $$;

create function pg_temp.img_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;

create function pg_temp.img_save_key(p_hint text, p_cap_cents bigint default 10000)
returns uuid language plpgsql as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_env bytea := convert_to('{"sealed":"img-key"}', 'utf8');
	v_env_b64 text := encode(v_env, 'base64');
	v_env_sha text := encode(extensions.digest(v_env, 'sha256'), 'hex');
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.img_profile() and status = 'active' limit 1;
	v_ticket := pg_temp.img_call(pg_temp.img_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, %s)', pg_temp.img_profile(), p_cap_cents));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_env_b64, v_env_sha, p_hint);
	reset session authorization;
	return (v_saved ->> 'id')::uuid;
end $$;

create function pg_temp.img_open_refused(
	p_authority public.qorpera_cloud_secret_broker_authorities,
	p_model_binding jsonb
) returns boolean language plpgsql as $$
begin
	set local session authorization qorpera_secret_broker;
	perform public.qorpera_open_gemini_key_for_run(p_authority.id, p_authority.capability_sha256, p_model_binding);
	reset session authorization;
	return false;
exception when insufficient_privilege then
	reset session authorization;
	return true;
end $$;

create function pg_temp.img_usage_refused(p_binding jsonb) returns boolean language plpgsql as $$
begin
	set local role service_role;
	perform public.qorpera_record_gemini_image_usage(
		p_binding,
		'gemini-3-pro-image',
		jsonb_build_object('inputTokens', 10, 'cachedTokens', 0, 'textOutputTokens', 0, 'imageOutputTokens', 1120)
	);
	reset role;
	return false;
exception when insufficient_privilege then
	reset role;
	return true;
end $$;

do $$
declare
	v_profile uuid := pg_temp.img_profile();
	v_owner uuid := pg_temp.img_owner();
	v_other uuid := pg_temp.img_other_user();
	v_profile_b uuid := '13850000-0000-4000-8000-000000000020';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_old_bundle public.qorpera_runtime_bundles%rowtype;
	v_new_bundle public.qorpera_runtime_bundles%rowtype;
	v_defaults jsonb;
	v_key_id uuid;
	v_alice jsonb;
	v_alice_run uuid;
	v_alice_model_binding jsonb;
	v_surface uuid;
	v_session uuid;
	v_lease constant uuid := '13850000-0000-4000-8000-000000000101';
	v_turn jsonb;
	v_enqueued jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_binding jsonb;
	v_model_binding jsonb;
	v_worker_id uuid := '13850000-0000-4000-8000-0000000000b1';
	v_worker public.qorpera_runtime_workers%rowtype;
	v_dispatch_wake public.qorpera_wake_occurrences%rowtype;
	v_dispatch_run public.qorpera_execution_runs%rowtype;
	v_worker_binding jsonb;
	v_worker_model_binding jsonb;
	v_routine_wake_id uuid := '13850000-0000-4000-8000-0000000000c1';
	v_routine_wake public.qorpera_wake_occurrences%rowtype;
	v_ctx jsonb;
	v_opened jsonb;
	v_usage jsonb;
	v_err_rec jsonb;
	v_cap_rec jsonb;
	v_revoked jsonb;
	v_orig_source_kind text;
	v_orig_requester uuid;
	v_sponsor_binding uuid;
	v_sponsor_version bigint;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = v_profile and status = 'active' limit 1;

	v_old_bundle := pg_temp.img_activate(false);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_get_member_default_models(%L)', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'chatgpt-image'
		and v_defaults -> 'storedImageModel' = 'null'::jsonb
		and v_defaults -> 'imageModels' = '["chatgpt-image"]'::jsonb,
		'1: initial image defaults without Gemini key: ' || v_defaults::text);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, null, ''gemini-3-pro-image'')', v_profile));
	perform pg_temp.base_assert(pg_temp.img_refused(v_defaults) = 'QRC02',
		'2: Gemini image model refused without Gemini key: ' || v_defaults::text);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, null, ''bogus-image'')', v_profile));
	perform pg_temp.base_assert(pg_temp.img_refused(v_defaults) = '22023',
		'2b: invalid image model refused: ' || v_defaults::text);

	v_key_id := pg_temp.img_save_key('AQ...img1', 10000);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_get_member_default_models(%L)', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'chatgpt-image'
		and v_defaults -> 'storedImageModel' = 'null'::jsonb
		and v_defaults -> 'imageModels' = '["gemini-3-pro-image","chatgpt-image"]'::jsonb,
		'3: saving Gemini key offers gemini-3-pro-image without overriding default: ' || v_defaults::text);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, null, ''gemini-3-pro-image'')', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'gemini-3-pro-image'
		and v_defaults ->> 'storedImageModel' = 'gemini-3-pro-image'
		and (v_defaults ->> 'version')::bigint = 1,
		'4: member selected gemini-3-pro-image: ' || v_defaults::text);

	v_alice := pg_temp.c4_alice();
	v_alice_run := (v_alice ->> 'runId')::uuid;
	v_alice_model_binding := v_alice - array['provider', 'nativeHarness', 'model'];

	set local role service_role;
	v_ctx := public.qorpera_describe_company_run_context(v_alice);
	reset role;
	perform pg_temp.base_assert(
		not (v_ctx ? 'imageModel'),
		'5: old runtime bundle omits imageModel from company run context for rolling compatibility: ' || v_ctx::text);

	v_new_bundle := pg_temp.img_activate(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs
	set runtime_bundle_id = v_new_bundle.id, runtime_bundle_sha256 = v_new_bundle.sha256
	where id = v_alice_run;
	set local session_replication_role = origin;

	set local role service_role;
	v_ctx := public.qorpera_describe_company_run_context(v_alice);
	reset role;
	perform pg_temp.base_assert(
		v_ctx ->> 'imageModel' = 'gemini-3-pro-image',
		'5b: bundle with image support exposes imageModel on session_turn context: ' || coalesce(v_ctx ->> 'imageModel', 'null'));

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_alice_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'6: session_turn opens Gemini key for image generation: ' || v_opened::text);

	select source_kind, requested_by_user_id into strict v_orig_source_kind, v_orig_requester
	from public.qorpera_execution_runs where id = v_alice_run;

	set local session_replication_role = replica;
	update public.qorpera_execution_runs set source_kind = 'room_delivery' where id = v_alice_run;
	set local session_replication_role = origin;
	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_alice_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'6b: room_delivery opens Gemini key for image generation: ' || v_opened::text);

	set local session_replication_role = replica;
	update public.qorpera_execution_runs
	set source_kind = v_orig_source_kind, requested_by_user_id = v_other
	where id = v_alice_run;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_alice_model_binding)
		and pg_temp.img_usage_refused(v_alice),
		'6c: mismatched requester without Gemini preference is refused on open and usage');

	set local session_replication_role = replica;
	update public.qorpera_execution_runs
	set requested_by_user_id = v_orig_requester,
		gemini_model = 'gemini-4-neon',
		gemini_effort = 'high',
		gemini_key_id = v_key_id
	where id = v_alice_run;
	set local session_replication_role = origin;

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 1, null, null, ''chatgpt-image'')', v_profile));
	perform pg_temp.base_assert(v_defaults ->> 'imageModel' = 'chatgpt-image', '7: switched preference to chatgpt-image');

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_alice_model_binding);
	reset session authorization;
	set local role service_role;
	v_usage := public.qorpera_record_gemini_image_usage(
		v_alice,
		'gemini-3-pro-image',
		jsonb_build_object('inputTokens', 10, 'cachedTokens', 0, 'textOutputTokens', 0, 'imageOutputTokens', 100)
	);
	reset role;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open'
		and v_usage ->> 'schema' = 'qorpera.gemini-image-usage/v1',
		'7b: Gemini conversation run first branch allows both open and image usage even when imageModel is chatgpt-image');

	set local session_replication_role = replica;
	update public.qorpera_execution_runs
	set gemini_model = null, gemini_effort = null, gemini_key_id = null
	where id = v_alice_run;
	set local session_replication_role = origin;

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 2, null, null, ''gemini-3-pro-image'')', v_profile));
	perform pg_temp.base_assert(v_defaults ->> 'imageModel' = 'gemini-3-pro-image', '7c: switched preference back to gemini-3-pro-image');

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	v_surface := (pg_temp.img_call(v_owner, format(
		'select public.qorpera_create_surface(%L, %L, %L, %L, %L, %L, null, %L, null, false)',
		v_profile, 'Identity', 'identity-image-test', 'studio', 'identity', 'figure:stamp', 'identity'
	)) ->> 'id')::uuid;
	v_session := (pg_temp.img_call(v_owner, format(
		'select public.qorpera_start_surface_session(%L, %L, %L)',
		v_surface, 'Generate hero artwork for our studio page', 'Hero artwork'
	)) ->> 'id')::uuid;
	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease where id = v_session;

	perform pg_temp.c4_dispatch(
		v_alice,
		'img-worker-1',
		'QorperaOS/agents/alice/todos/onboarding/img',
		pg_temp.c4_brief(v_worker_id, 'codex', 'Generate onboarding visuals')
	);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	v_worker := pg_temp.c4_worker(v_worker_id);
	select * into strict v_dispatch_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
	select * into strict v_dispatch_run from public.qorpera_execution_runs where id = v_dispatch_wake.run_id;
	v_worker_binding := pg_temp.base_start(v_dispatch_run.id);
	v_worker_model_binding := v_worker_binding - array['provider', 'nativeHarness', 'model'];

	select binding_id, version into strict v_sponsor_binding, v_sponsor_version
	from public.qorpera_execution_sponsor_versions
	limit 1;

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers
	set species = 'in-house', access = 'write', requested_by_user_id = v_owner, surface_session_id = null
	where id = v_worker_id;
	set local session_replication_role = origin;
	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_worker_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'8: member-requested in-house write worker opens Gemini key: ' || v_opened::text);

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set access = 'read' where id = v_worker_id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding)
		and pg_temp.img_usage_refused(v_worker_binding),
		'8b: in-house read worker is refused');

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set access = 'write', requested_by_user_id = v_other where id = v_worker_id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding),
		'8c: in-house write worker with mismatched requester is refused');

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers
	set species = 'coding', access = 'write', owner_user_id = v_owner,
		owner_sponsor_binding_id = v_sponsor_binding, owner_sponsor_version = v_sponsor_version,
		requested_by_user_id = v_owner, surface_session_id = null
	where id = v_worker_id;
	set local session_replication_role = origin;
	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_worker_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'8d: member-owned standalone coding worker opens Gemini key: ' || v_opened::text);

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set owner_user_id = v_other where id = v_worker_id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding),
		'8e: coding worker owned by another user is refused');

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers
	set owner_user_id = v_owner, surface_backed = true, surface_session_id = v_session,
		todo_id = null, steering_run_id = null, folder_path = null,
		folder_environment_id = null, folder_key = null, folder_brief_version = null,
		folder_commit_id = null, folder_results_version = null, folder_retired_at = null
	where id = v_worker_id;
	set local session_replication_role = origin;
	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_worker_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open',
		'8f: coding worker for member-initiated non-internal surface session opens Gemini key: ' || v_opened::text);

	update public.qorpera_surface_sessions set is_internal = true where id = v_session;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding),
		'8g: coding worker for internal surface session is refused');
	update public.qorpera_surface_sessions set is_internal = false where id = v_session;

	set local session_replication_role = replica;
	update public.qorpera_runtime_workers
	set species = 'in-house', access = 'write', owner_user_id = null,
		owner_sponsor_binding_id = null, owner_sponsor_version = null,
		requested_by_user_id = v_owner, surface_backed = false, surface_session_id = null,
		todo_id = v_worker.todo_id, steering_run_id = v_worker.steering_run_id, folder_path = v_worker.folder_path,
		folder_environment_id = v_worker.folder_environment_id, folder_key = v_worker.folder_key,
		folder_brief_version = v_worker.folder_brief_version, folder_commit_id = v_worker.folder_commit_id,
		folder_results_version = v_worker.folder_results_version, folder_retired_at = v_worker.folder_retired_at
	where id = v_worker_id;
	v_routine_wake := v_dispatch_wake;
	v_routine_wake.id := v_routine_wake_id;
	v_routine_wake.wake_kind := 'routine';
	v_routine_wake.source_kind := 'schedule';
	v_routine_wake.source_id := v_routine_wake_id;
	v_routine_wake.routine_id := v_routine_wake_id;
	v_routine_wake.routine_version := 1;
	v_routine_wake.occurrence_key := 'img-routine-root-1';
	v_routine_wake.status := 'queued';
	v_routine_wake.run_id := null;
	v_routine_wake.finished_at := null;
	v_routine_wake.causal_root_id := v_routine_wake_id;
	insert into public.qorpera_wake_occurrences values (v_routine_wake.*);
	update public.qorpera_wake_occurrences set causal_root_id = v_routine_wake_id where id = v_dispatch_wake.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding)
		and pg_temp.img_usage_refused(v_worker_binding),
		'9: routine-rooted worker wake is refused on open and usage');

	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences
	set wake_kind = 'routine', routine_id = v_routine_wake_id, routine_version = 1, causal_root_id = null
	where id = v_dispatch_wake.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_worker_model_binding)
		and pg_temp.img_usage_refused(v_worker_binding),
		'9b: direct routine wake is refused on open and usage');

	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences
	set wake_kind = v_dispatch_wake.wake_kind, routine_id = v_dispatch_wake.routine_id,
		routine_version = v_dispatch_wake.routine_version, causal_root_id = v_dispatch_wake.causal_root_id
	where id = v_dispatch_wake.id;
	delete from public.qorpera_wake_occurrences where id = v_routine_wake_id;
	update public.qorpera_runtime_workers
	set species = v_worker.species, access = v_worker.access, requested_by_user_id = v_worker.requested_by_user_id,
		owner_user_id = v_worker.owner_user_id, owner_sponsor_binding_id = v_worker.owner_sponsor_binding_id,
		owner_sponsor_version = v_worker.owner_sponsor_version, surface_backed = v_worker.surface_backed,
		surface_session_id = v_worker.surface_session_id, todo_id = v_worker.todo_id,
		steering_run_id = v_worker.steering_run_id, folder_path = v_worker.folder_path,
		folder_environment_id = v_worker.folder_environment_id, folder_key = v_worker.folder_key,
		folder_brief_version = v_worker.folder_brief_version, folder_commit_id = v_worker.folder_commit_id,
		folder_results_version = v_worker.folder_results_version, folder_retired_at = v_worker.folder_retired_at
	where id = v_worker_id;
	set local session_replication_role = origin;
	perform pg_temp.c4_end_job(v_dispatch_run.id, 'completed');

	set local role service_role;
	v_enqueued := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	reset role;
	perform pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enqueued ->> 'wakeId')::uuid;
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	v_binding := pg_temp.base_start(v_run.id);
	v_model_binding := v_binding - array['provider', 'nativeHarness', 'model'];

	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	v_ctx := public.qorpera_describe_company_run_context(v_binding);
	reset role;
	perform pg_temp.base_assert(
		v_turn ->> 'imageModel' = 'gemini-3-pro-image'
		and v_ctx ->> 'imageModel' = 'gemini-3-pro-image',
		'10: folder surface turn and run context both carry gemini-3-pro-image');

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'10b: vault opens Gemini key for folder surface session: ' || v_opened::text);

	update public.qorpera_surface_sessions set is_internal = true where id = v_session;
	perform pg_temp.base_assert(
		pg_temp.img_open_refused(v_authority, v_model_binding),
		'10c: internal reconciliation surface session refused');
	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(v_turn ->> 'imageModel' = 'chatgpt-image',
		'10d: internal surface session falls back to chatgpt-image');
	update public.qorpera_surface_sessions set is_internal = false where id = v_session;

	perform pg_temp.base_assert(
		public.qorpera_gemini_image_microdollars('gemini-3-pro-image', 100, 1, 10, 1120) = (99 * 2 + 1 + 10 * 12 + 1120 * 120),
		'11: exact Gemini 3 Pro Image pricing math');

	set local role service_role;
	v_usage := public.qorpera_record_gemini_image_usage(
		v_binding,
		'gemini-3-pro-image',
		jsonb_build_object('inputTokens', 100, 'cachedTokens', 5, 'textOutputTokens', 20, 'imageOutputTokens', 1120)
	);
	v_err_rec := public.qorpera_record_gemini_key_error(v_binding, 'provider_outage');
	reset role;
	perform pg_temp.base_assert(
		v_usage ->> 'schema' = 'qorpera.gemini-image-usage/v1'
		and (v_usage ->> 'capReached')::boolean = false
		and (v_err_rec ->> 'recorded')::boolean = true,
		'11b: image usage and key error recording work from non-Gemini run');

	update public.qorpera_gemini_keys set monthly_cap_cents = 100 where id = v_key_id;
	set local role service_role;
	v_usage := public.qorpera_record_gemini_image_usage(
		v_binding,
		'gemini-3-pro-image',
		jsonb_build_object('inputTokens', 50, 'cachedTokens', 0, 'textOutputTokens', 0, 'imageOutputTokens', 10000)
	);
	v_cap_rec := public.qorpera_record_gemini_cap_reached(v_binding);
	reset role;
	perform pg_temp.base_assert(
		(v_usage ->> 'capReached')::boolean = true
		and (v_cap_rec ->> 'recorded')::boolean = true,
		'12: cap reached recorded from non-Gemini run');

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'refused' and v_opened ->> 'reason' = 'CAP_REACHED',
		'12b: vault returns CAP_REACHED after image spend crosses cap');

	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values (v_profile_b, 'Image No Gemini', v_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, role)
	values (v_profile_b, v_owner, 'owner@example.com', 'owner');
	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_get_member_default_models(%L)', v_profile_b));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'chatgpt-image'
		and v_defaults ->> 'storedImageModel' = 'gemini-3-pro-image'
		and v_defaults -> 'imageModels' = '["chatgpt-image"]'::jsonb,
		'13: company without Gemini falls back cleanly while keeping stored image preference');

	v_revoked := pg_temp.img_call(v_owner,
		format('select public.qorpera_revoke_gemini_key(%L)', v_profile));
	perform pg_temp.base_assert(v_revoked ->> 'error' is null, '14: Gemini key revoked');

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_get_member_default_models(%L)', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'chatgpt-image'
		and v_defaults -> 'storedImageModel' = 'null'::jsonb
		and (v_defaults ->> 'version')::bigint = 4,
		'14b: revoking Gemini key clears stored gemini-3-pro-image preference: ' || v_defaults::text);
end $$;
