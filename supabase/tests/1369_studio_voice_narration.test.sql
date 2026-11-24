-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.svn_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.svn_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.svn_activate() returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := jsonb_set(v_active.manifest, '{modelPolicy,geminiChoice}', '"thread"');
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
end $$;

create function pg_temp.svn_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	execute p_sql into v_result;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;

create function pg_temp.svn_save_key(p_hint text, p_cap_cents bigint default 10000)
returns uuid language plpgsql as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_env bytea := convert_to('{"sealed":"svn-key"}', 'utf8');
	v_env_b64 text := encode(v_env, 'base64');
	v_env_sha text := encode(extensions.digest(v_env, 'sha256'), 'hex');
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.svn_profile() and status = 'active' limit 1;
	v_ticket := pg_temp.svn_call(pg_temp.svn_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, %s)', pg_temp.svn_profile(), p_cap_cents));
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

select pg_temp.svn_activate() \g /dev/null

do $$
declare
	v_profile uuid := pg_temp.svn_profile();
	v_owner uuid := pg_temp.svn_owner();
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_key_id uuid;
	v_surface uuid;
	v_session uuid;
	v_lease constant uuid := '13690000-0000-4000-8000-000000000101';
	v_turn jsonb;
	v_defaults jsonb;
	v_enqueued jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_binding jsonb;
	v_model_binding jsonb;
	v_opened jsonb;
	v_usage jsonb;
	v_refused boolean := false;
	v_obs jsonb;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = v_profile and status = 'active' limit 1;

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	v_surface := (pg_temp.svn_call(v_owner, format(
		'select public.qorpera_create_surface(%L, %L, %L, %L, %L, %L, null, %L, null, false)',
		v_profile, 'Identity', 'identity-voice-test', 'studio', 'identity', 'figure:stamp', 'identity'
	)) ->> 'id')::uuid;

	v_session := (pg_temp.svn_call(v_owner, format(
		'select public.qorpera_start_surface_session(%L, %L, %L)',
		v_surface, 'Create a narrated breakdown of our UX', 'UX breakdown'
	)) ->> 'id')::uuid;

	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease where id = v_session;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind, affected_paths, patch_manifest, status
	) values (
		v_profile, v_surface, v_session, 1, 'Add breakdown', 'Staged scenes.js', 'folder_patch',
		array['breakdowns/ux/scenes.js', 'brief.md'],
		jsonb_build_array(
			jsonb_build_object('op', 'write_text', 'path', 'breakdowns/ux/scenes.js', 'content', 'V.scene((s) => { s.say("Hello."); });'),
			jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', '# Ignored non-scenes file')
		),
		'staged'
	), (
		v_profile, v_surface, v_session, 2, 'Refine breakdown', 'Updated scenes.js', 'folder_patch',
		array['breakdowns/ux/scenes.js'],
		jsonb_build_array(
			jsonb_build_object('op', 'write_text', 'path', 'breakdowns/ux/scenes.js', 'content', 'V.scene((s) => { s.say("Updated."); });')
		),
		'staged'
	);

	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(
		v_turn ->> 'voiceModel' = 'chatgpt-voice'
		and v_turn ->> 'voiceName' = 'cove'
		and jsonb_array_length(v_turn -> 'openScenesOps') = 1
		and v_turn -> 'openScenesOps' -> 0 ->> 'path' = 'breakdowns/ux/scenes.js'
		and v_turn -> 'openScenesOps' -> 0 ->> 'content' = 'V.scene((s) => { s.say("Updated."); });',
		'1: turn payload carries default voice and latest openScenesOps per path: ' || v_turn::text
	);

	v_key_id := pg_temp.svn_save_key('AQ...svn1', 10000);
	set local role service_role;
	v_enqueued := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(
		v_enqueued ->> 'status' = 'enqueued',
		'2: surface session enqueued: ' || v_enqueued::text
	);
	perform pg_temp.base_materialize();

	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enqueued ->> 'wakeId')::uuid;
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.base_assert(
		v_run.source_kind = 'wake' and v_run.gemini_key_id is null,
		'2: surface-session run is a non-Gemini wake run: ' || to_jsonb(v_run)::text
	);

	v_binding := pg_temp.base_start(v_run.id);
	v_model_binding := v_binding - array['provider', 'nativeHarness', 'model'];

	begin
		set local session authorization qorpera_secret_broker;
		perform public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
		reset session authorization;
	exception when insufficient_privilege then
		reset session authorization;
		v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '2: vault refuses Gemini key when member selected chatgpt-voice');

	v_defaults := pg_temp.svn_call(v_owner, format(
		'select public.qorpera_get_member_default_models(%L)', v_profile
	));
	v_defaults := pg_temp.svn_call(v_owner, format(
		'select public.qorpera_set_member_default_models(%L, null, null, null, null, %s, %L, %L)',
		v_profile, (v_defaults ->> 'version')::bigint, 'gemini-3.8-flash-tts', 'Kore'
	));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'gemini-3.8-flash-tts' and v_defaults ->> 'voiceName' = 'Kore',
		'3: member selected Gemini TTS voice: ' || v_defaults::text
	);

	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(
		v_turn ->> 'voiceModel' = 'gemini-3.8-flash-tts' and v_turn ->> 'voiceName' = 'Kore',
		'3: read_session_turn reflects Gemini TTS preference: ' || v_turn::text
	);

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'3: vault opens Gemini key for folder surface-session wake with Gemini TTS preference: ' || v_opened::text
	);

	v_refused := false;
	update public.qorpera_surface_sessions
	set origin_kind = 'cofounder', turn_requested_by_user_id = null
	where id = v_session;
	begin
		set local session authorization qorpera_secret_broker;
		perform public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
		reset session authorization;
	exception when insufficient_privilege then
		reset session authorization;
		v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '3b: vault refuses Gemini key for agent-originated folder surface session');
	update public.qorpera_surface_sessions set origin_kind = 'member' where id = v_session;

	set local role service_role;
	v_usage := public.qorpera_record_gemini_voice_usage(
		v_binding,
		'gemini-3.8-flash-tts',
		jsonb_build_object('inputTokens', 41, 'cachedTokens', 0, 'outputTokens', 500)
	);
	reset role;
	perform pg_temp.base_assert(
		v_usage ->> 'schema' = 'qorpera.gemini-voice-usage/v1'
		and (v_usage ->> 'monthSpendMicrodollars')::bigint = 4521
		and (v_usage ->> 'capReached')::boolean = false,
		'3: voice usage records exact TTS microdollars: ' || v_usage::text
	);

	update public.qorpera_gemini_keys set monthly_cap_cents = 100 where id = v_key_id;
	set local role service_role;
	v_usage := public.qorpera_record_gemini_voice_usage(
		v_binding,
		'gemini-3.8-flash-lite-tts',
		jsonb_build_object('inputTokens', 100, 'cachedTokens', 0, 'outputTokens', 200000)
	);
	reset role;
	perform pg_temp.base_assert(
		(v_usage ->> 'capReached')::boolean = true
		and (v_usage ->> 'monthSpendMicrodollars')::bigint = 4521 + 50 + 1200000,
		'4: flash-lite usage accumulates and flags capReached: ' || v_usage::text
	);

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'refused' and v_opened ->> 'reason' = 'CAP_REACHED',
		'4: vault refuses with CAP_REACHED after TTS spend crosses monthly cap: ' || v_opened::text
	);

	perform pg_temp.base_assert(
		strpos(
			pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			$q$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',$q$
		) > 0,
		'5: runtime observation vocabulary includes narrate_explainer'
	);
	set local role service_role;
	v_obs := public.qorpera_record_runtime_observation(
		v_run.id,
		jsonb_build_object(
			'schema', 'qorpera.runtime-observation/v1',
			'attemptId', '13690000-0000-4000-8000-000000000501',
			'parentAttemptId', null,
			'assignmentId', (v_binding ->> 'assignmentId')::uuid,
			'phase', 'finish',
			'operation', 'narrate_explainer',
			'logicalOperationSha256', null,
			'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'durationMs', 420,
			'status', 'succeeded',
			'errorCategory', null,
			'receiptId', null,
			'readId', null,
			'inputBytes', 64,
			'outputBytes', 128,
			'inputTokens', null,
			'outputTokens', null,
			'cachedInputTokens', null,
			'cacheWriteInputTokens', null,
			'reasoningOutputTokens', null,
			'totalTokens', null
		)
	);
	reset role;
	perform pg_temp.base_assert(v_obs is not null, '5: runtime observation accepts narrate_explainer');
end $$;
