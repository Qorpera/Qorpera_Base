-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.cn_activate() returns text language plpgsql as $$
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

create function pg_temp.cn_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.cn_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.cn_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;

create function pg_temp.cn_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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

create function pg_temp.cn_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;

select pg_temp.cn_activate() \g /dev/null
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.cn_owner());
select pg_temp.c4_login('13640000-0000-4000-8000-0000000000c1', pg_temp.cn_owner(), 'canary-no-claude-conv') \g /dev/null

do $$
declare
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_defaults jsonb;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_menu jsonb;
	v_envelope bytea := convert_to('{"sealed":"gemini-no-claude-conv"}', 'utf8');
	v_envelope_b64 text := encode(v_envelope, 'base64');
	v_envelope_sha text := encode(extensions.digest(v_envelope, 'sha256'), 'hex');
	v_check_failed boolean;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.cn_profile() and status = 'active' limit 1;

	v_ticket := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 10000)', pg_temp.cn_profile()));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AQ...z9k1');
	reset session authorization;

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.cn_profile()));
	perform pg_temp.base_assert(
		v_defaults -> 'conversationModels' = '["gpt-6.2-sol","gpt-6-astra","gemini-4-neon"]'::jsonb
		and not (v_defaults -> 'conversationEfforts' ? 'claude-opus-5-5')
		and not (v_defaults -> 'conversationEfforts' ? 'claude-fable-5-2')
		and v_defaults -> 'codingModels' = '["claude-opus-5-5","claude-fable-5-2","gpt-6.2-sol","gpt-6-astra"]'::jsonb
		and v_defaults ->> 'codingModel' = 'claude-opus-5-5',
		'1: conversational defaults exclude Claude while coding defaults keep Claude: ' || v_defaults::text);

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(), 'select public.qorpera_get_member_default_models(null)');
	perform pg_temp.base_assert(
		v_defaults -> 'conversationModels' = '["gpt-6.2-sol","gpt-6-astra","gemini-4-neon"]'::jsonb
		and v_defaults -> 'codingModels' = '["claude-opus-5-5","claude-fable-5-2","gpt-6.2-sol","gpt-6-astra"]'::jsonb,
		'1: account-wide defaults exclude Claude from conversational models: ' || v_defaults::text);

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''claude-opus-5-5'', ''high'', null, null, 0)', pg_temp.cn_profile()));
	perform pg_temp.base_assert(pg_temp.cn_refused(v_defaults) = '22023',
		'2: claude-opus-5-5 refused for conversational default: ' || v_defaults::text);

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''claude-fable-5-2'', ''high'', null, null, 0)', pg_temp.cn_profile()));
	perform pg_temp.base_assert(pg_temp.cn_refused(v_defaults) = '22023',
		'2: claude-fable-5-2 refused for conversational default: ' || v_defaults::text);

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gemini-4-neon'', ''max'', null, null, 0)', pg_temp.cn_profile()));
	perform pg_temp.base_assert(pg_temp.cn_refused(v_defaults) = '22023',
		'2: max effort refused for conversational default: ' || v_defaults::text);

	v_defaults := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gemini-4-neon'', ''xhigh'', ''claude-fable-5-2'', ''max'', 0)', pg_temp.cn_profile()));
	perform pg_temp.base_assert(
		v_defaults ->> 'conversationModel' = 'gemini-4-neon'
		and v_defaults ->> 'conversationEffort' = 'xhigh'
		and v_defaults ->> 'codingModel' = 'claude-fable-5-2'
		and v_defaults ->> 'codingEffort' = 'max'
		and (v_defaults ->> 'version')::bigint = 1,
		'2: Gemini conversational + Claude coding max accepted: ' || v_defaults::text);

	v_check_failed := false;
	begin
		update public.qorpera_member_default_models set conversation_model = 'claude-opus-5-5' where user_id = pg_temp.cn_owner();
	exception when check_violation then
		v_check_failed := true;
	end;
	perform pg_temp.base_assert(v_check_failed, '3: table check rejects claude-opus-5-5 in conversation_model');

	v_check_failed := false;
	begin
		update public.qorpera_member_default_models set conversation_model = 'claude-fable-5-2' where user_id = pg_temp.cn_owner();
	exception when check_violation then
		v_check_failed := true;
	end;
	perform pg_temp.base_assert(v_check_failed, '3: table check rejects claude-fable-5-2 in conversation_model');

	v_check_failed := false;
	begin
		update public.qorpera_member_default_models set conversation_effort = 'max' where user_id = pg_temp.cn_owner();
	exception when check_violation then
		v_check_failed := true;
	end;
	perform pg_temp.base_assert(v_check_failed, '3: table check rejects max in conversation_effort');

	v_menu := pg_temp.cn_call(pg_temp.cn_owner(),
		format('select public.qorpera_set_session_model(%L, ''claude-opus-5-5'', 0, ''max'')', pg_temp.cn_session(v_bob)));
	perform pg_temp.base_assert(
		v_menu ->> 'model_id' = 'claude-opus-5-5' and v_menu ->> 'reasoning_effort' = 'max',
		'4: explicit per-session Claude model remains available: ' || v_menu::text);
end $$;
