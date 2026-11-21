-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.gm_activate(p_gemini boolean) returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := case when p_gemini then jsonb_set(v_active.manifest, '{modelPolicy,geminiChoice}', '"thread"')
		else v_active.manifest #- '{modelPolicy,geminiChoice}' end;
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
end $$;

create function pg_temp.gm_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.gm_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.gm_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;

create function pg_temp.gm_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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

create function pg_temp.gm_get(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.gm_call(pg_temp.gm_owner(), format('select public.qorpera_get_session_model(%L)', pg_temp.gm_session(p_staff)))
$$;

create function pg_temp.gm_set(p_staff uuid, p_model text, p_effort text default null) returns jsonb language sql as $$
	select pg_temp.gm_call(pg_temp.gm_owner(), format('select public.qorpera_set_session_model(%L, %L, %s, %L)',
		pg_temp.gm_session(p_staff), p_model,
		coalesce((select version from public.qorpera_session_models where session_id = pg_temp.gm_session(p_staff)), 0), p_effort))
$$;

create function pg_temp.gm_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;

create function pg_temp.gm_models(p_result jsonb) returns text language sql as $$
	select string_agg(model, ',' order by ordinality) from jsonb_array_elements_text(p_result -> 'models') with ordinality as m(model)
$$;

create function pg_temp.gm_turn(p_staff uuid, p_text text) returns public.qorpera_execution_runs language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post(pg_temp.gm_owner(), p_staff, p_text); v_pass jsonb := pg_temp.base_materialize();
	v_run public.qorpera_execution_runs;
begin
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the post is a run: ' || v_pass::text);
	return v_run;
end $$;

select pg_temp.gm_activate(false) \g /dev/null

do $$
declare
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_result jsonb;
begin
	perform pg_temp.base_assert(public.qorpera_gemini_neon_microdollars(1000000, 500000, 200000) = 4575000,
		'1: exact Neon microdollars math');
	perform pg_temp.base_assert(public.qorpera_gemini_neon_microdollars(10, 1, 0) = 28,
		'1: cached token microdollar ceiling');
	v_result := pg_temp.gm_call(pg_temp.gm_owner(), format('select public.qorpera_get_gemini_key(%L)', pg_temp.gm_profile()));
	perform pg_temp.base_assert(v_result ->> 'schema' = 'qorpera.gemini-key/v1'
		and (v_result ->> 'vaultAvailable')::boolean = true and v_result -> 'key' = 'null'::jsonb,
		'1: unconfigured Gemini key: ' || v_result::text);
	v_result := pg_temp.gm_set(v_bob, 'gemini-4-neon', 'high');
	perform pg_temp.base_assert(pg_temp.gm_refused(v_result) = 'QRC03', '1: refused without key or bundle: ' || v_result::text);
end $$;

select pg_temp.gm_activate(true) \g /dev/null

do $$
declare
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket jsonb;
	v_described jsonb;
	v_saved jsonb;
	v_state jsonb;
	v_menu jsonb;
	v_run public.qorpera_execution_runs;
	v_binding jsonb;
	v_context jsonb;
	v_opened jsonb;
	v_usage jsonb;
	v_notice jsonb;
	v_envelope bytea := convert_to('{"sealed":"gemini-envelope"}', 'utf8');
	v_envelope_b64 text := encode(v_envelope, 'base64');
	v_envelope_sha text := encode(extensions.digest(v_envelope, 'sha256'), 'hex');
	v_cap_sha text;
	v_immut_refused boolean := false;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.gm_profile() and status = 'active' limit 1;

	v_ticket := pg_temp.gm_call(pg_temp.gm_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 500)', pg_temp.gm_profile()));
	perform pg_temp.base_assert(v_ticket ->> 'schema' = 'qorpera.gemini-key-ticket/v1'
		and v_ticket ->> 'ticketId' is not null and v_ticket ->> 'capability' is not null,
		'2: ticket issued: ' || v_ticket::text);
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');

	set local role qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	perform pg_temp.base_assert(v_described ->> 'schema' = 'qorpera.gemini-key-ticket-description/v1'
		and (v_described ->> 'ownerUserId')::uuid = pg_temp.gm_owner()
		and (v_described ->> 'monthlyCapCents')::bigint = 500,
		'2: ticket described: ' || v_described::text);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AIza...9z8y');
	reset role;
	perform pg_temp.base_assert(v_saved ->> 'schema' = 'qorpera.gemini-key-saved/v1'
		and v_saved ->> 'keyHint' = 'AIza...9z8y' and (v_saved ->> 'monthlyCapCents')::bigint = 500,
		'2: key completed: ' || v_saved::text);

	v_menu := pg_temp.gm_get(v_bob);
	perform pg_temp.base_assert(position('gemini-4-neon' in pg_temp.gm_models(v_menu)) > 0
		and v_menu -> 'efforts' -> 'gemini-4-neon' = '["low","medium","high","xhigh"]'::jsonb
		and v_menu ->> 'model_id' = 'gpt-6.2-sol',
		'3: menu lists Gemini 4 Neon when configured: ' || v_menu::text);

	v_menu := pg_temp.gm_set(v_bob, 'gemini-4-neon', 'max');
	perform pg_temp.base_assert(pg_temp.gm_refused(v_menu) = '22023', '3: max effort refused for Gemini: ' || v_menu::text);

	v_menu := pg_temp.gm_set(v_bob, 'gemini-4-neon', 'xhigh');
	perform pg_temp.base_assert(v_menu ->> 'model_id' = 'gemini-4-neon' and v_menu ->> 'reasoning_effort' = 'xhigh',
		'3: Gemini 4 Neon at xhigh accepted: ' || v_menu::text);

	v_state := pg_temp.gm_call(pg_temp.gm_owner(),
		format('select public.qorpera_update_gemini_key_settings(%L, true, 500, 1)', pg_temp.gm_profile()));
	perform pg_temp.base_assert((v_state -> 'key' ->> 'defaultForChats')::boolean = true
		and (v_state -> 'key' ->> 'version')::bigint = 2,
		'4: default_for_chats enabled: ' || v_state::text);

	v_menu := pg_temp.gm_get(v_carol);
	perform pg_temp.base_assert(v_menu ->> 'model_id' = 'gemini-4-neon',
		'4: uncustomized conversation defaults to Gemini 4 Neon: ' || v_menu::text);

	v_run := pg_temp.gm_turn(v_carol, 'Check our status.');
	perform pg_temp.base_assert(v_run.gemini_model = 'gemini-4-neon' and v_run.gemini_effort = 'low'
		and v_run.gemini_key_id = (v_saved ->> 'id')::uuid and v_run.claude_model is null
		and v_run.model_provider = 'openai',
		'5: default_for_chats pins Gemini choice on room_delivery while keeping OpenAI lease valid');

	begin
		update public.qorpera_execution_runs set gemini_effort = 'high' where id = v_run.id;
	exception when insufficient_privilege then
		v_immut_refused := true;
	end;
	perform pg_temp.base_assert(v_immut_refused, '5: execution Gemini choice is immutable');

	v_binding := pg_temp.base_start(v_run.id);
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.base_assert(v_context -> 'gemini' ->> 'model' = 'gemini-4-neon'
		and v_context -> 'gemini' ->> 'effort' = 'low'
		and v_context -> 'gemini' ->> 'keyId' = v_saved ->> 'id',
		'5: run context includes gemini choice: ' || coalesce(v_context -> 'gemini', 'null'::jsonb)::text);

	set local role qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_binding);
	reset role;
	perform pg_temp.base_assert(v_opened ->> 'state' = 'open'
		and v_opened ->> 'encryptedEnvelopeBase64' = v_envelope_b64
		and (v_opened ->> 'monthlyCapCents')::bigint = 500,
		'6: vault opens Gemini key for pinned run: ' || v_opened::text);

	v_usage := public.qorpera_record_gemini_run_usage(v_binding,
		jsonb_build_object('inputTokens', 1000000, 'cachedTokens', 0, 'outputTokens', 200000));
	perform pg_temp.base_assert((v_usage ->> 'monthSpendMicrodollars')::bigint = 6000000
		and (v_usage ->> 'capReached')::boolean = true,
		'7: spend recorded and $5 cap reached ($6.00 spent): ' || v_usage::text);

	v_usage := public.qorpera_record_gemini_run_usage(v_binding,
		jsonb_build_object('inputTokens', 500000, 'cachedTokens', 0, 'outputTokens', 100000));
	perform pg_temp.base_assert((v_usage ->> 'monthSpendMicrodollars')::bigint = 6000000,
		'7: usage recording is monotonic and idempotent');

	set local role qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_binding);
	reset role;
	perform pg_temp.base_assert(v_opened ->> 'state' = 'refused' and v_opened ->> 'reason' = 'CAP_REACHED',
		'8: vault refuses with CAP_REACHED once cap hit: ' || v_opened::text);

	v_notice := public.qorpera_record_gemini_cap_reached(v_binding);
	perform pg_temp.base_assert((v_notice ->> 'recorded')::boolean = true, '8: cap notification recorded');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_member_notifications
		where user_id = pg_temp.gm_owner() and kind = 'gemini_cap_reached' and acknowledged_at is null),
		'8: unread gemini_cap_reached notification exists');

	v_menu := pg_temp.gm_get(v_carol);
	perform pg_temp.base_assert((v_menu ->> 'gemini_cap_reached')::boolean = true,
		'8: session model reports gemini_cap_reached: ' || v_menu::text);

	v_state := pg_temp.gm_call(pg_temp.gm_owner(),
		format('select public.qorpera_update_gemini_key_settings(%L, true, 2000, 2)', pg_temp.gm_profile()));
	perform pg_temp.base_assert((v_state -> 'key' ->> 'capReached')::boolean = false,
		'9: raising cap clears capReached: ' || v_state::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_member_notifications
		where user_id = pg_temp.gm_owner() and kind = 'gemini_cap_reached' and acknowledged_at is null),
		'9: raising cap auto-acknowledges notification');

	v_state := pg_temp.gm_call(pg_temp.gm_owner(),
		format('select public.qorpera_revoke_gemini_key(%L)', pg_temp.gm_profile()));
	perform pg_temp.base_assert(v_state -> 'key' = 'null'::jsonb, '10: revoked key is cleared');

	set local role qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_binding);
	reset role;
	perform pg_temp.base_assert(v_opened ->> 'state' = 'refused' and v_opened ->> 'reason' = 'REVOKED',
		'10: vault refuses revoked key: ' || v_opened::text);
end $$;
