-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.mdv_activate() returns text language plpgsql as $$
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

create function pg_temp.mdv_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.mdv_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.mdv_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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

create function pg_temp.mdv_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;

select pg_temp.mdv_activate() \g /dev/null

do $$
declare
	v_profile_b uuid := '13640000-0000-4000-8000-000000000020';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_defaults jsonb;
	v_resolved jsonb;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_revoked jsonb;
	v_envelope bytea := convert_to('{"sealed":"gemini-voice-envelope"}', 'utf8');
	v_envelope_b64 text := encode(v_envelope, 'base64');
	v_envelope_sha text := encode(extensions.digest(v_envelope, 'sha256'), 'hex');
begin
	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'voiceName' = 'cove'
		and v_defaults -> 'storedVoiceModel' = 'null'::jsonb
		and v_defaults -> 'storedVoiceName' = 'null'::jsonb
		and v_defaults -> 'voiceModels' = '["chatgpt-voice"]'::jsonb
		and jsonb_array_length(v_defaults -> 'voiceProfiles' -> 'chatgpt-voice') = 9
		and jsonb_array_length(v_defaults -> 'voiceProfiles' -> 'gemini-3.8-flash-tts') = 30
		and jsonb_array_length(v_defaults -> 'voiceProfiles' -> 'gemini-3.8-flash-lite-tts') = 30,
		'1: initial voice defaults without Gemini key: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, ''gemini-3.8-flash-tts'', ''Charon'')', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(pg_temp.mdv_refused(v_defaults) = 'QRC02',
		'2: Gemini voice model refused without key: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, ''chatgpt-voice'', ''Kore'')', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(pg_temp.mdv_refused(v_defaults) = '22023',
		'2: Gemini voice profile refused with chatgpt-voice: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, ''Kore'')', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(pg_temp.mdv_refused(v_defaults) = '22023',
		'2: Gemini voice profile refused when effective model is chatgpt-voice: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0, null, ''juniper'')', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'voiceName' = 'juniper'
		and v_defaults ->> 'storedVoiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'storedVoiceName' = 'juniper'
		and (v_defaults ->> 'version')::bigint = 1,
		'3: voice-only save pins coherent model and profile: ' || v_defaults::text);

	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.mdv_profile() and status = 'active' limit 1;

	v_ticket := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 10000)', pg_temp.mdv_profile()));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AQ...vOic');
	reset session authorization;

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults -> 'voiceModels' = '["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts","chatgpt-voice"]'::jsonb
		and v_defaults ->> 'voiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'voiceName' = 'juniper',
		'4: Gemini voice models offered once key is saved while preserving explicit ChatGPT choice: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 1, ''gemini-3.8-flash-tts'', null)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'gemini-3.8-flash-tts'
		and v_defaults ->> 'voiceName' = 'Charon'
		and v_defaults ->> 'storedVoiceModel' = 'gemini-3.8-flash-tts'
		and v_defaults ->> 'storedVoiceName' = 'Charon'
		and (v_defaults ->> 'version')::bigint = 2,
		'5: switching model without voice name clamps profile to model default: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 2, null, ''Kore'')', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'gemini-3.8-flash-tts'
		and v_defaults ->> 'voiceName' = 'Kore'
		and (v_defaults ->> 'version')::bigint = 3,
		'6: switching Gemini voice profile keeps model: ' || v_defaults::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 3, ''gemini-3.8-flash-lite-tts'', null)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'gemini-3.8-flash-lite-tts'
		and v_defaults ->> 'voiceName' = 'Kore'
		and (v_defaults ->> 'version')::bigint = 4,
		'7: switching between Gemini TTS models preserves compatible voice profile: ' || v_defaults::text);

	v_resolved := public.qorpera_resolve_member_voice_preference(pg_temp.mdv_profile(), pg_temp.mdv_owner());
	perform pg_temp.base_assert(
		v_resolved ->> 'voiceModel' = 'gemini-3.8-flash-lite-tts'
		and v_resolved ->> 'voiceName' = 'Kore',
		'8: internal voice resolver matches stored preference: ' || v_resolved::text);

	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values (v_profile_b, 'Voice No Gemini', pg_temp.mdv_owner());
	insert into public.qorpera_profile_members(profile_id, user_id, email, role)
	values (v_profile_b, pg_temp.mdv_owner(), 'owner@example.com', 'owner');

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_get_member_default_models(%L)', v_profile_b));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'voiceName' = 'cove'
		and v_defaults ->> 'storedVoiceModel' = 'gemini-3.8-flash-lite-tts'
		and v_defaults ->> 'storedVoiceName' = 'Kore'
		and v_defaults -> 'voiceModels' = '["chatgpt-voice"]'::jsonb,
		'9: company without Gemini falls back cleanly while keeping stored voice preference: ' || v_defaults::text);

	v_revoked := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_revoke_gemini_key(%L)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(v_revoked ->> 'error' is null, '10: Gemini key revoked: ' || v_revoked::text);

	v_defaults := pg_temp.mdv_call(pg_temp.mdv_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.mdv_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'voiceModel' = 'chatgpt-voice'
		and v_defaults ->> 'voiceName' = 'cove'
		and v_defaults -> 'storedVoiceModel' = 'null'::jsonb
		and v_defaults -> 'storedVoiceName' = 'null'::jsonb
		and (v_defaults ->> 'version')::bigint = 5,
		'10: revoking Gemini key clears stored Gemini voice preference: ' || v_defaults::text);
end $$;
