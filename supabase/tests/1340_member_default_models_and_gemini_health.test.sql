-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.md_activate() returns text language plpgsql as $$
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

create function pg_temp.md_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.md_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.md_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;

create function pg_temp.md_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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

create function pg_temp.md_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;

create function pg_temp.md_turn(p_staff uuid, p_text text) returns public.qorpera_execution_runs language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post(pg_temp.md_owner(), p_staff, p_text); v_pass jsonb := pg_temp.base_materialize();
	v_run public.qorpera_execution_runs;
begin
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the post is a run: ' || v_pass::text);
	return v_run;
end $$;

select pg_temp.md_activate() \g /dev/null
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.md_owner());
select pg_temp.c4_login('13400000-0000-4000-8000-0000000000c1', pg_temp.md_owner(), 'canary-default-models') \g /dev/null

do $$
declare
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
	v_profile_b uuid := '13400000-0000-4000-8000-000000000020';
	v_profile_c uuid := '13400000-0000-4000-8000-000000000021';
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_defaults jsonb;
	v_menu jsonb;
	v_run public.qorpera_execution_runs;
	v_worker_run public.qorpera_execution_runs;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_check_ticket jsonb;
	v_check_cap_sha text;
	v_check_desc jsonb;
	v_check_done jsonb;
	v_key_state jsonb;
	v_binding jsonb;
	v_err_res jsonb;
	v_usage_res jsonb;
	v_envelope bytea := convert_to('{"sealed":"gemini-health-envelope"}', 'utf8');
	v_envelope_b64 text := encode(v_envelope, 'base64');
	v_envelope_sha text := encode(extensions.digest(v_envelope, 'sha256'), 'hex');
	v_alice jsonb := pg_temp.c4_alice();
	v_dispatch jsonb;
	v_worker public.qorpera_runtime_workers;
	v_wake public.qorpera_wake_occurrences;
	v_cross_refused boolean := false;
begin
	perform pg_temp.base_assert(
		public.qorpera_usage_credits_valid('{"hasCredits":true,"unlimited":false,"balance":42.5,"currency":"USD"}'::jsonb),
		'1: valid money credits accepted');
	perform pg_temp.base_assert(
		public.qorpera_usage_credits_valid('{"unlimited":true}'::jsonb),
		'1: unlimited credits accepted');
	perform pg_temp.base_assert(
		not public.qorpera_usage_credits_valid('{"balance":"private"}'::jsonb),
		'1: string balance refused');
	perform pg_temp.base_assert(
		not public.qorpera_usage_credits_valid('{"balance":-1}'::jsonb),
		'1: negative balance refused');
	perform pg_temp.base_assert(
		not public.qorpera_usage_credits_valid('{"balance":10,"currency":"us"}'::jsonb),
		'1: lowercase currency refused');
	perform pg_temp.base_assert(
		public.qorpera_claude_usage_valid(
			'{"observedAt":"2026-11-22T18:00:00Z","windows":[{"id":"seven_day","label":"Weekly","usedPercent":25}],"credits":{"balance":15.25,"used":4.75,"limit":20,"currency":"USD"}}'::jsonb),
		'1: Claude usage with credits accepted');
	perform pg_temp.base_assert(
		not public.qorpera_claude_usage_valid(
			'{"observedAt":"2026-11-22T18:00:00Z","windows":[{"id":"seven_day","label":"Weekly","usedPercent":25}],"credits":{"bogus":1}}'::jsonb),
		'1: Claude usage with unknown credits key refused');

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'schema' = 'qorpera.member-default-models/v1'
		and v_defaults ->> 'conversationModel' = 'gpt-6.2-sol'
		and v_defaults ->> 'conversationEffort' = 'low'
		and v_defaults ->> 'codingModel' = 'claude-opus-5-5'
		and v_defaults ->> 'codingEffort' = 'high'
		and v_defaults -> 'storedConversationModel' = 'null'::jsonb
		and v_defaults -> 'storedCodingModel' = 'null'::jsonb
		and v_defaults -> 'codingEfforts' -> 'gpt-6-astra' = '["low","medium","high"]'::jsonb
		and (v_defaults ->> 'version')::bigint = 0,
		'2: initial defaults: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(), 'select public.qorpera_get_member_default_models(null)');
	perform pg_temp.base_assert(v_defaults ->> 'schema' = 'qorpera.member-default-models/v1'
		and v_defaults ->> 'codingModel' = 'claude-opus-5-5',
		'2: account-wide defaults without company: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, null, 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = '22023', '2: empty partial update refused: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gemini-4-neon'', ''low'', ''claude-opus-5-5'', ''high'', 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = 'QRC02', '2: Gemini default refused without key: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6.2-sol'', ''max'', ''claude-opus-5-5'', ''high'', 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = '22023', '2: max effort on OpenAI refused: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, ''gpt-6-astra'', ''xhigh'', 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = '22023', '2: xhigh coding effort on OpenAI refused: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, ''medium'', 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults -> 'storedConversationModel' = 'null'::jsonb
		and v_defaults -> 'storedCodingModel' = 'null'::jsonb
		and v_defaults ->> 'codingEffort' = 'medium'
		and (v_defaults ->> 'version')::bigint = 1,
		'2: single-field save with no prior row keeps stored models null: ' || v_defaults::text);

	v_run := pg_temp.md_turn(v_bob, 'Check staff mapping after coding effort only save');
	perform pg_temp.base_assert(v_run.model_selection is distinct from 'member_default'
		and v_run.claude_model is null and v_run.gemini_model is null,
		'2: single-field coding save does not override conversational staff mapping: sel=' || coalesce(v_run.model_selection, 'null'));
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture end', finished_at = clock_timestamp() where run_id = v_run.id;

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6.2-sol'', ''medium'', ''gpt-6-astra'', ''medium'', 1)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6.2-sol'
		and v_defaults ->> 'conversationEffort' = 'medium'
		and v_defaults ->> 'codingModel' = 'gpt-6-astra'
		and v_defaults ->> 'codingEffort' = 'medium'
		and (v_defaults ->> 'version')::bigint = 2,
		'3: split defaults saved: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6.2-sol'', null, null, null, 0)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = 'QRC01', '3: stale version 0 rejected: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6.2-sol'', null, null, null, 1)', pg_temp.md_profile()));
	perform pg_temp.base_assert(pg_temp.md_refused(v_defaults) = 'QRC01', '3: stale version 1 rejected: ' || v_defaults::text);

	v_menu := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_session_model(%L)', pg_temp.md_session(v_bob)));
	perform pg_temp.base_assert(v_menu ->> 'model_id' = 'gpt-6.2-sol' and v_menu ->> 'reasoning_effort' = 'medium',
		'3: session inherits GPT conversational default: ' || v_menu::text);

	v_run := pg_temp.md_turn(v_bob, 'Hello on GPT default');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6.2-sol' and v_run.model_selection = 'member_default'
		and v_run.reasoning_effort = 'medium' and v_run.claude_model is null and v_run.gemini_model is null,
		'3: run pins member GPT conversational default');
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture end', finished_at = clock_timestamp() where run_id = v_run.id;

	v_dispatch := pg_temp.c4_dispatch(v_alice, 'md-worker-codex', 'QorperaOS/agents/alice/todos/onboarding/md-codex',
		pg_temp.c4_brief('13400000-0000-4000-8000-0000000000d1', null));
	perform pg_temp.base_assert(v_dispatch -> 'units' -> 0 ->> 'outcome' = 'saved', '4: codex worker dispatched: ' || v_dispatch::text);
	v_worker := pg_temp.c4_worker('13400000-0000-4000-8000-0000000000d1');
	perform pg_temp.base_assert(v_worker.harness is null and v_worker.claude_login_id is null
		and v_worker.claude_model is null and v_worker.claude_effort is null,
		'4: OpenAI coding default keeps in-house worker on Codex instead of Claude-first: ' || to_jsonb(v_worker)::text);
	perform pg_temp.c4_drain();
	v_worker := pg_temp.c4_worker('13400000-0000-4000-8000-0000000000d1');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
	perform pg_temp.base_materialize();
	select run.* into strict v_worker_run from public.qorpera_execution_runs as run
	join public.qorpera_wake_occurrences as wake on wake.run_id = run.id
	where wake.id = v_wake.id;
	perform pg_temp.base_assert(v_worker_run.model_id = 'gpt-6-astra'
		and v_worker_run.model_selection = 'member_default'
		and v_worker_run.reasoning_effort = 'medium',
		'4: Codex worker-dispatch run uses member coding default model and effort: model='
			|| coalesce(v_worker_run.model_id, 'null') || ' sel=' || coalesce(v_worker_run.model_selection, 'null')
			|| ' effort=' || coalesce(v_worker_run.reasoning_effort, 'null'));
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture end', finished_at = clock_timestamp() where run_id = v_worker_run.id;

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6-astra'', ''high'', ''claude-fable-5-2'', ''max'', 2)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6-astra'
		and v_defaults ->> 'codingModel' = 'claude-fable-5-2'
		and v_defaults ->> 'codingEffort' = 'max'
		and (v_defaults ->> 'version')::bigint = 3,
		'4: swapped split defaults saved: ' || v_defaults::text);

	v_dispatch := pg_temp.c4_dispatch(v_alice, 'md-worker-claude', 'QorperaOS/agents/alice/todos/onboarding/md-claude',
		pg_temp.c4_brief('13400000-0000-4000-8000-0000000000d2', null));
	perform pg_temp.base_assert(v_dispatch -> 'units' -> 0 ->> 'outcome' = 'saved', '4: claude worker dispatched: ' || v_dispatch::text);
	v_worker := pg_temp.c4_worker('13400000-0000-4000-8000-0000000000d2');
	perform pg_temp.base_assert(v_worker.harness = 'claude-code' and v_worker.claude_login_id is not null
		and v_worker.claude_model = 'claude-fable-5-2' and v_worker.claude_effort = 'max',
		'4: Claude coding default resolves worker to claude-fable-5-2 at max even when chat is OpenAI: ' || to_jsonb(v_worker)::text);

	v_run := pg_temp.md_turn(v_carol, 'Hello on OpenAI default');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6-astra' and v_run.model_selection = 'member_default'
		and v_run.reasoning_effort = 'high' and v_run.claude_model is null and v_run.gemini_model is null,
		'4: OpenAI conversational default pinned on run: model=' || coalesce(v_run.model_id, 'null')
			|| ' sel=' || coalesce(v_run.model_selection, 'null') || ' effort=' || coalesce(v_run.reasoning_effort, 'null'));
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture end', finished_at = clock_timestamp() where run_id = v_run.id;

	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.md_profile() and status = 'active' limit 1;

	v_ticket := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 10000)', pg_temp.md_profile()));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AQ...aXtw');
	reset session authorization;

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gemini-4-neon'', ''high'', ''claude-fable-5-2'', ''max'', 3)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gemini-4-neon'
		and v_defaults ->> 'storedConversationModel' = 'gemini-4-neon'
		and v_defaults ->> 'conversationEffort' = 'high'
		and v_defaults ->> 'codingModel' = 'claude-fable-5-2'
		and (v_defaults ->> 'version')::bigint = 4,
		'5: Gemini conversational + Claude coding split saved: ' || v_defaults::text);

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_profile_b, 'Company B Without Vault', pg_temp.md_owner());
	insert into public.qorpera_profile_members(profile_id, user_id, email, role) values (v_profile_b, pg_temp.md_owner(), 'owner@example.com', 'owner');

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', v_profile_b));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6.2-sol'
		and v_defaults ->> 'storedConversationModel' = 'gemini-4-neon',
		'5: Company B reports effective fallback alongside stored Gemini default: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, null, null, null, ''high'', 4)', v_profile_b));
	perform pg_temp.base_assert(v_defaults ->> 'storedConversationModel' = 'gemini-4-neon'
		and v_defaults ->> 'codingEffort' = 'high'
		and (v_defaults ->> 'version')::bigint = 5,
		'5: partial coding save in Company B preserves stored Gemini default: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gemini-4-neon'
		and v_defaults ->> 'codingEffort' = 'high',
		'5: Company A still uses Gemini after Company B coding save: ' || v_defaults::text);

	v_run := pg_temp.md_turn(v_carol, 'Hello on Gemini default');
	perform pg_temp.base_assert(v_run.gemini_model = 'gemini-4-neon' and v_run.gemini_effort = 'high'
		and v_run.claude_model is null,
		'5: Gemini conversational default pins gemini-4-neon at high');

	v_binding := pg_temp.base_start(v_run.id);
	v_err_res := public.qorpera_record_gemini_key_error(v_binding, 'billing_required');
	perform pg_temp.base_assert((v_err_res ->> 'recorded')::boolean = true,
		'5: runtime Gemini key error recorded: ' || v_err_res::text);
	v_key_state := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_gemini_key(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_key_state -> 'key' ->> 'lastErrorCode' = 'billing_required',
		'5: runtime error surfaced on get_gemini_key: ' || v_key_state::text);

	v_usage_res := public.qorpera_record_gemini_run_usage(v_binding,
		jsonb_build_object('inputTokens', 1000, 'cachedTokens', 0, 'outputTokens', 200));
	perform pg_temp.base_assert((v_usage_res ->> 'monthSpendMicrodollars')::bigint > 0,
		'5: usage recorded: ' || v_usage_res::text);
	v_key_state := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_gemini_key(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_key_state -> 'key' -> 'lastErrorCode' = 'null'::jsonb
		and v_key_state -> 'key' -> 'lastErrorAt' = 'null'::jsonb,
		'5: successful Gemini usage clears last error: ' || v_key_state::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gpt-6-astra'', null, null, null, 5)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6-astra'
		and (v_defaults ->> 'version')::bigint = 6,
		'5: switched conversational default from Gemini to GPT: ' || v_defaults::text);

	v_key_state := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_update_gemini_key_settings(%L, null, 5000, 1)', pg_temp.md_profile()));
	perform pg_temp.base_assert((v_key_state -> 'key' ->> 'monthlyCapCents')::bigint = 5000
		and (v_key_state -> 'key' ->> 'defaultForChats')::boolean = false,
		'5: saving cap with null defaultForChats updates cap without reverting default model: ' || v_key_state::text);
	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6-astra',
		'5: cap save preserved GPT conversational default: ' || v_defaults::text);

	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_set_member_default_models(%L, ''gemini-4-neon'', null, null, null, 6)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gemini-4-neon'
		and (v_defaults ->> 'version')::bigint = 7,
		'5: switched conversational default back to Gemini: ' || v_defaults::text);

	v_ticket := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 5000)', pg_temp.md_profile()));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AQ...bYux');
	reset session authorization;
	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gemini-4-neon',
		'5: replacing Gemini key preserves member default model: ' || v_defaults::text);

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_profile_c, 'Company C Viewer Check', pg_temp.md_owner());
	insert into public.qorpera_profile_members(profile_id, user_id, email, role) values (v_profile_c, pg_temp.md_owner(), 'owner@example.com', 'viewer');
	insert into public.qorpera_cloud_secret_broker_authorities(profile_id, principal_id, service_origin, key_id, capability_sha256, status)
	values (v_profile_c, v_authority.principal_id, v_authority.service_origin, v_authority.key_id, repeat('e', 64), 'active');

	v_check_ticket := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_begin_gemini_key_check(%L)', v_profile_c));
	perform pg_temp.base_assert(v_check_ticket ->> 'schema' = 'qorpera.gemini-key-ticket/v1',
		'5: viewer can begin check on their own active key: ' || v_check_ticket::text);

	v_check_ticket := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_begin_gemini_key_check(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_check_ticket ->> 'schema' = 'qorpera.gemini-key-ticket/v1',
		'5: check ticket issued: ' || v_check_ticket::text);
	v_check_cap_sha := encode(extensions.digest(v_check_ticket ->> 'capability', 'sha256'), 'hex');

	set local session authorization qorpera_secret_broker;
	begin
		perform public.qorpera_describe_gemini_key_ticket(
			v_authority.id, v_authority.capability_sha256, (v_check_ticket ->> 'ticketId')::uuid, v_check_cap_sha);
	exception when insufficient_privilege then
		v_cross_refused := true;
	end;
	perform pg_temp.base_assert(v_cross_refused, '5: check ticket refused by save describe');

	v_check_desc := public.qorpera_describe_gemini_key_check(
		v_authority.id, v_authority.capability_sha256, (v_check_ticket ->> 'ticketId')::uuid, v_check_cap_sha);
	perform pg_temp.base_assert(v_check_desc ->> 'schema' = 'qorpera.gemini-key-check-description/v1',
		'5: check ticket described');

	v_check_done := public.qorpera_complete_gemini_key_check(
		v_authority.id, v_authority.capability_sha256, (v_check_ticket ->> 'ticketId')::uuid, v_check_cap_sha,
		'error', 'quota_exhausted');
	reset session authorization;
	perform pg_temp.base_assert((v_check_done ->> 'ok')::boolean = false
		and v_check_done ->> 'errorCode' = 'quota_exhausted',
		'5: check recorded error: ' || v_check_done::text);

	v_key_state := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_gemini_key(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_key_state -> 'key' ->> 'lastErrorCode' = 'quota_exhausted'
		and v_key_state -> 'key' ->> 'lastErrorAt' is not null
		and v_key_state -> 'key' ->> 'lastCheckedAt' is not null,
		'5: get_gemini_key exposes health error: ' || v_key_state::text);

	v_key_state := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_revoke_gemini_key(%L)', pg_temp.md_profile()));
	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gpt-6.2-sol'
		and v_defaults ->> 'codingModel' = 'claude-fable-5-2',
		'5: revoking Gemini key resets conversational default without touching coding default: ' || v_defaults::text);

	v_ticket := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, true, 10000)', pg_temp.md_profile()));
	v_cap_sha := encode(extensions.digest(v_ticket ->> 'capability', 'sha256'), 'hex');
	set local session authorization qorpera_secret_broker;
	v_described := public.qorpera_describe_gemini_key_ticket(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha);
	v_saved := public.qorpera_complete_gemini_key_save(
		v_authority.id, v_authority.capability_sha256, (v_ticket ->> 'ticketId')::uuid, v_cap_sha,
		v_described ->> 'keyId', v_envelope_b64, v_envelope_sha, 'AQ...cZvy');
	reset session authorization;
	v_defaults := pg_temp.md_call(pg_temp.md_owner(),
		format('select public.qorpera_get_member_default_models(%L)', pg_temp.md_profile()));
	perform pg_temp.base_assert(v_defaults ->> 'conversationModel' = 'gemini-4-neon',
		'5: get_member_default_models agrees with resolvers when key saved with default_for_chats=true and conversation_model is null: ' || v_defaults::text);
end $$;
