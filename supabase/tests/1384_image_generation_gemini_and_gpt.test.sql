-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.img_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.img_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.img_activate() returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := jsonb_set(
		jsonb_set(v_active.manifest, '{modelPolicy,geminiChoice}', '"thread"'),
		'{modelPolicy,claudeChoice}', '"thread"'
	);
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
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

select pg_temp.img_activate() \g /dev/null

do $$
declare
	v_profile uuid := pg_temp.img_profile();
	v_owner uuid := pg_temp.img_owner();
	v_profile_b uuid := '13840000-0000-4000-8000-000000000020';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_defaults jsonb;
	v_key_id uuid;
	v_surface uuid;
	v_session uuid;
	v_lease constant uuid := '13840000-0000-4000-8000-000000000101';
	v_turn jsonb;
	v_enqueued jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_binding jsonb;
	v_model_binding jsonb;
	v_ctx jsonb;
	v_opened jsonb;
	v_usage jsonb;
	v_err_rec jsonb;
	v_cap_rec jsonb;
	v_refused boolean := false;
	v_revoked jsonb;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = v_profile and status = 'active' limit 1;

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

	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(
		v_turn ->> 'imageModel' = 'chatgpt-image',
		'4: surface turn carries default chatgpt-image before Gemini image preference is set: ' || v_turn::text);

	set local role service_role;
	v_enqueued := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	reset role;
	perform pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enqueued ->> 'wakeId')::uuid;
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	v_binding := pg_temp.base_start(v_run.id);
	v_model_binding := v_binding - array['provider', 'nativeHarness', 'model'];

	v_refused := false;
	begin
		set local session authorization qorpera_secret_broker;
		perform public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
		reset session authorization;
	exception when insufficient_privilege then
		reset session authorization;
		v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '4b: vault refuses Gemini key when imageModel is chatgpt-image');

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, null, ''gemini-3-pro-image'')', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'gemini-3-pro-image'
		and v_defaults ->> 'storedImageModel' = 'gemini-3-pro-image'
		and (v_defaults ->> 'version')::bigint = 1,
		'5: member selected gemini-3-pro-image: ' || v_defaults::text);

	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	v_ctx := public.qorpera_describe_company_run_context(v_binding);
	reset role;
	perform pg_temp.base_assert(
		v_turn ->> 'imageModel' = 'gemini-3-pro-image'
		and v_ctx ->> 'imageModel' = 'gemini-3-pro-image',
		'5b: turn and run context both carry gemini-3-pro-image: ' || coalesce(v_turn ->> 'imageModel', 'null') || ' / ' || coalesce(v_ctx ->> 'imageModel', 'null'));

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'6: vault opens Gemini key for folder surface session when gemini-3-pro-image is selected: ' || v_opened::text);

	v_refused := false;
	update public.qorpera_surface_sessions set is_internal = true where id = v_session;
	begin
		set local session authorization qorpera_secret_broker;
		perform public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
		reset session authorization;
	exception when insufficient_privilege then
		reset session authorization;
		v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '6b: vault refuses Gemini key for internal reconciliation surface session');
	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(v_profile, v_session, v_lease);
	reset role;
	perform pg_temp.base_assert(v_turn ->> 'imageModel' = 'chatgpt-image',
		'6c: internal surface session falls back to chatgpt-image: ' || v_turn::text);
	update public.qorpera_surface_sessions set is_internal = false where id = v_session;

	perform pg_temp.base_assert(
		public.qorpera_gemini_image_microdollars('gemini-3-pro-image', 100, 1, 10, 1120) = (99 * 2 + 1 + 10 * 12 + 1120 * 120),
		'7: exact Gemini 3 Pro Image pricing math');

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
		and (v_usage ->> 'monthSpendMicrodollars')::bigint = (95 * 2 + 2 + 20 * 12 + 1120 * 120)
		and (v_usage ->> 'capReached')::boolean = false
		and (v_err_rec ->> 'recorded')::boolean = true,
		'7b: image usage and key error recording work from non-Gemini run: ' || v_usage::text || ' / ' || v_err_rec::text);

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
		'8: cap reached recorded from non-Gemini run: ' || v_usage::text || ' / ' || v_cap_rec::text);

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'refused' and v_opened ->> 'reason' = 'CAP_REACHED',
		'8b: vault returns CAP_REACHED after image spend crosses cap: ' || v_opened::text);

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
		'9: company without Gemini falls back cleanly while keeping stored image preference: ' || v_defaults::text);

	v_revoked := pg_temp.img_call(v_owner,
		format('select public.qorpera_revoke_gemini_key(%L)', v_profile));
	perform pg_temp.base_assert(v_revoked ->> 'error' is null, '10: Gemini key revoked: ' || v_revoked::text);

	v_defaults := pg_temp.img_call(v_owner,
		format('select public.qorpera_get_member_default_models(%L)', v_profile));
	perform pg_temp.base_assert(
		v_defaults ->> 'imageModel' = 'chatgpt-image'
		and v_defaults -> 'storedImageModel' = 'null'::jsonb
		and (v_defaults ->> 'version')::bigint = 2,
		'10b: revoking Gemini key clears stored gemini-3-pro-image preference: ' || v_defaults::text);
end $$;
