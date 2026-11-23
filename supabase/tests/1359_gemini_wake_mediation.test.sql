-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.gwm_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;

create function pg_temp.gwm_profile() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;

create function pg_temp.gwm_activate() returns text language plpgsql as $$
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

create function pg_temp.gwm_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	execute p_sql into v_result;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;

create function pg_temp.gwm_save_key(p_hint text, p_payload text default '{"sealed":"gwm-key"}')
returns uuid language plpgsql as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket jsonb;
	v_cap_sha text;
	v_described jsonb;
	v_saved jsonb;
	v_env bytea := convert_to(p_payload, 'utf8');
	v_env_b64 text := encode(v_env, 'base64');
	v_env_sha text := encode(extensions.digest(v_env, 'sha256'), 'hex');
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.gwm_profile() and status = 'active' limit 1;
	v_ticket := pg_temp.gwm_call(pg_temp.gwm_owner(),
		format('select public.qorpera_begin_gemini_key_save(%L, false, 10000)', pg_temp.gwm_profile()));
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

create function pg_temp.gwm_carried(p_run uuid, p_source text, p_origin uuid) returns jsonb language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = p_source, origin_run_id = p_origin where run_id = p_run;
	set local session_replication_role = origin;
	return public.qorpera_resolve_run_gemini_choice(run, bundle.manifest)
	from public.qorpera_execution_runs run
	join public.qorpera_runtime_bundles bundle on bundle.id = run.runtime_bundle_id
	where run.id = p_run;
end $$;

select pg_temp.gwm_activate() \g /dev/null

do $$
declare
	v_alice jsonb := pg_temp.c4_alice();
	v_alice_run uuid := (v_alice ->> 'runId')::uuid;
	v_key_id uuid := pg_temp.gwm_save_key('AQ...gwm1', '{"sealed":"gwm-key-1"}');
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_worker_id uuid := '13590000-0000-4000-8000-0000000000b1';
	v_folder text := 'QorperaOS/agents/alice/todos/onboarding/gwm';
	v_result jsonb;
	v_worker public.qorpera_runtime_workers;
	v_dispatch_wake public.qorpera_wake_occurrences;
	v_dispatch_run public.qorpera_execution_runs;
	v_worker_binding jsonb;
	v_comp_wake public.qorpera_wake_occurrences;
	v_comp_run public.qorpera_execution_runs;
	v_comp_binding jsonb;
	v_comp_model_binding jsonb;
	v_context jsonb;
	v_opened jsonb;
	v_usage jsonb;
	v_rotated_key uuid;
	v_other_user uuid := '92400000-0000-4000-8000-000000000002';
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_bob_run uuid;
	v_refused boolean := false;
begin
	select * into strict v_authority from public.qorpera_cloud_secret_broker_authorities
	where profile_id = pg_temp.gwm_profile() and status = 'active' limit 1;

	set local session_replication_role = replica;
	update public.qorpera_execution_runs
	set gemini_model = 'gemini-4-neon', gemini_effort = 'high', gemini_key_id = v_key_id,
		claude_model = null, claude_effort = null
	where id = v_alice_run;
	set local session_replication_role = origin;

	v_result := pg_temp.c4_dispatch(
		v_alice, 'gwm-dispatch-1', v_folder,
		pg_temp.c4_brief(v_worker_id, 'codex', 'Inspect onboarding files'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved',
		'1: Gemini origin dispatches worker: ' || v_result::text);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();

	v_worker := pg_temp.c4_worker(v_worker_id);
	select * into strict v_dispatch_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
	select * into strict v_dispatch_run from public.qorpera_execution_runs where id = v_dispatch_wake.run_id;
	perform pg_temp.base_assert(
		v_dispatch_wake.origin_run_id = v_alice_run
		and v_dispatch_run.source_kind = 'wake'
		and v_dispatch_run.gemini_model is null
		and v_dispatch_run.gemini_effort is null
		and v_dispatch_run.gemini_key_id is null,
		'1: worker-dispatch run never inherits Gemini: ' || to_jsonb(v_dispatch_run)::text);

	v_worker_binding := pg_temp.base_start(v_dispatch_run.id);
	v_result := pg_temp.c4_results(v_worker_binding, 'gwm-report-1', v_folder);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved',
		'2: worker reports back: ' || v_result::text);
	perform pg_temp.c4_end_job(v_dispatch_run.id, 'completed');
	perform pg_temp.c4_end_job(v_alice_run, 'failed');
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();

	select * into v_comp_wake from public.qorpera_wake_occurrences
	where staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and source_kind = 'worker-completion'
	order by created_at desc limit 1;
	select * into v_comp_run from public.qorpera_execution_runs where id = v_comp_wake.run_id;
	perform pg_temp.base_assert(
		v_comp_run.id is not null
		and v_comp_wake.origin_run_id = v_alice_run
		and v_comp_run.source_kind = 'wake'
		and v_comp_run.gemini_model = 'gemini-4-neon'
		and v_comp_run.gemini_effort = 'high'
		and v_comp_run.gemini_key_id = v_key_id
		and v_comp_run.claude_model is null,
		'2: worker-completion wake carries Gemini choice from origin: '
		|| coalesce((to_jsonb(v_comp_wake) - 'payload')::text, 'no wake') || ' '
		|| coalesce(to_jsonb(v_comp_run)::text, 'no run'));

	v_comp_binding := pg_temp.base_start(v_comp_run.id);
	v_comp_model_binding := v_comp_binding - array['provider', 'nativeHarness', 'model'];
	v_context := public.qorpera_describe_company_run_context(v_comp_binding);
	perform pg_temp.base_assert(
		v_context -> 'gemini' = jsonb_build_object('model', 'gemini-4-neon', 'effort', 'high', 'keyId', v_key_id),
		'2: wake run context carries gemini choice: ' || coalesce(v_context -> 'gemini', 'null'::jsonb)::text);

	set local session authorization qorpera_secret_broker;
	v_opened := public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_comp_model_binding);
	reset session authorization;
	perform pg_temp.base_assert(
		v_opened ->> 'state' = 'open' and (v_opened ->> 'geminiKeyId')::uuid = v_key_id,
		'2: vault opens Gemini key for worker-completion wake: ' || v_opened::text);

	v_usage := public.qorpera_record_gemini_run_usage(
		v_comp_binding,
		jsonb_build_object('inputTokens', 1000, 'cachedTokens', 0, 'outputTokens', 100));
	perform pg_temp.base_assert(
		(v_usage ->> 'monthSpendMicrodollars')::bigint > 0,
		'2: usage records cleanly on Gemini wake run: ' || v_usage::text);

	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'machine-event', v_alice_run)
		= jsonb_build_object('model', 'gemini-4-neon', 'effort', 'high', 'keyId', v_key_id),
		'3: machine-event keeps Gemini choice');
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'machine-checkin', v_alice_run)
		= jsonb_build_object('model', 'gemini-4-neon', 'effort', 'high', 'keyId', v_key_id),
		'3: machine-checkin keeps Gemini choice');
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'office-activation', v_alice_run)
		= jsonb_build_object('model', 'gemini-4-neon', 'effort', 'high', 'keyId', v_key_id),
		'3: office-activation keeps Gemini choice');
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'worker-dispatch', v_alice_run) is null,
		'3: worker-dispatch never carries Gemini');
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'coworker', v_alice_run) is null,
		'3: coworker wake never carries Gemini');
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'worker-completion', null) is null,
		'3: null origin carries none');

	select id into v_bob_run from public.qorpera_execution_runs where staff_agent_id = v_bob limit 1;
	if v_bob_run is not null then
		set local session_replication_role = replica;
		update public.qorpera_execution_runs
		set gemini_model = 'gemini-4-neon', gemini_effort = 'low', gemini_key_id = v_key_id,
			claude_model = null, claude_effort = null
		where id = v_bob_run;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(
			pg_temp.gwm_carried(v_comp_run.id, 'worker-completion', v_bob_run) is null,
			'3: another agent origin carries none');
	end if;

	v_rotated_key := pg_temp.gwm_save_key('AQ...gwm2', '{"sealed":"gwm-key-2"}');
	perform pg_temp.base_assert(
		v_rotated_key <> v_key_id
		and pg_temp.gwm_carried(v_comp_run.id, 'worker-completion', v_alice_run)
		= jsonb_build_object('model', 'gemini-4-neon', 'effort', 'high', 'keyId', v_rotated_key),
		'4: wake resolves member active rotated key');

	set local session_replication_role = replica;
	update public.qorpera_execution_runs set requested_by_user_id = v_other_user where id = v_comp_run.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'worker-completion', v_alice_run) is null,
		'4: mismatched requester never inherits origin Gemini key');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set requested_by_user_id = pg_temp.gwm_owner() where id = v_comp_run.id;
	set local session_replication_role = origin;

	perform pg_temp.gwm_call(pg_temp.gwm_owner(),
		format('select public.qorpera_revoke_gemini_key(%L)', pg_temp.gwm_profile()));
	perform pg_temp.base_assert(
		pg_temp.gwm_carried(v_comp_run.id, 'worker-completion', v_alice_run) is null,
		'4: revoked Gemini key cleanly falls back to null');

	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = 'worker-dispatch' where id = v_comp_wake.id;
	set local session_replication_role = origin;
	begin
		set local session authorization qorpera_secret_broker;
		perform public.qorpera_open_gemini_key_for_run(v_authority.id, v_authority.capability_sha256, v_comp_model_binding);
		reset session authorization;
	exception when insufficient_privilege then
		reset session authorization;
		v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '5: vault refuses opening Gemini key for worker-dispatch wake');
end $$;
