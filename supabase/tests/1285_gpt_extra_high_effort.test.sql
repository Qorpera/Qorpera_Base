-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.gx_activate(p_thread jsonb, p_claude boolean default true) returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := case when p_claude then jsonb_set(v_active.manifest, '{modelPolicy,claudeChoice}', '"thread"')
		else v_active.manifest #- '{modelPolicy,claudeChoice}' end;
	v_manifest := case when p_thread is null then v_manifest #- '{modelPolicy,threadEfforts}'
		else jsonb_set(v_manifest, '{modelPolicy,threadEfforts}', p_thread) end;
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
end $$;
create function pg_temp.gx_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;
create function pg_temp.gx_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;
create function pg_temp.gx_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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
create function pg_temp.gx_get(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.gx_call(pg_temp.gx_owner(), format('select public.qorpera_get_session_model(%L)', pg_temp.gx_session(p_staff)))
$$;
create function pg_temp.gx_set(p_staff uuid, p_model text, p_effort text default null) returns jsonb language sql as $$
	select pg_temp.gx_call(pg_temp.gx_owner(), format('select public.qorpera_set_session_model(%L, %L, %s, %L)',
		pg_temp.gx_session(p_staff), p_model,
		coalesce((select version from public.qorpera_session_models where session_id = pg_temp.gx_session(p_staff)), 0), p_effort))
$$;
create function pg_temp.gx_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;
create function pg_temp.gx_turn(p_staff uuid, p_text text) returns public.qorpera_execution_runs language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post(pg_temp.gx_owner(), p_staff, p_text); v_pass jsonb := pg_temp.base_materialize();
	v_run public.qorpera_execution_runs;
begin
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the post is a run: ' || v_pass::text);
	return v_run;
end $$;
create function pg_temp.gx_admit(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	select * into strict v_run from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid;
	return public.qorpera_begin_native_company_execution_v3(p_binding,
		public.qorpera_execution_runtime_manifest(v_run) ->> 'nativeBinarySha256', v_run.runtime_bundle_sha256,
		v_run.reasoning_policy_sha256,
		'{"type":"namespace","name":"qorpera","description":"Fixture catalog","tools":[{"type":"function","name":"tool_1","description":"Fixture tool","inputSchema":{"type":"object","additionalProperties":false}}]}');
end $$;
create function pg_temp.gx_efforts(p_result jsonb, p_model text) returns text language sql as $$
	select string_agg(effort, ',' order by ordinality)
	from jsonb_array_elements_text(p_result -> 'efforts' -> p_model) with ordinality as e(effort)
$$;

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.gx_owner());
select pg_temp.c4_login('12850000-0000-4000-8000-0000000000c1', pg_temp.gx_owner()) \g /dev/null

select pg_temp.gx_activate(null) \g /dev/null
do $$
declare v_result jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	v_result := pg_temp.gx_get(v_bob);
	perform pg_temp.base_assert(pg_temp.gx_efforts(v_result, 'gpt-6-astra') = 'low,medium,high'
		and pg_temp.gx_efforts(v_result, 'gpt-6.1-sol') = 'low,medium,high'
		and pg_temp.gx_efforts(v_result, 'claude-opus-5-5') = 'low,medium,high,xhigh,max'
		and pg_temp.gx_efforts(v_result, 'claude-fable-5-2') = 'low,medium,high,xhigh,max'
		and (select count(*) from jsonb_object_keys(v_result -> 'efforts')) = 4,
		'1: without threadEfforts, GPT is offered low to high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'claude-opus-5-5', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'reasoning_effort' = 'xhigh', '1: Claude keeps extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'gpt-6.1-sol');
	perform pg_temp.base_assert(pg_temp.gx_refused(v_result) = '22023',
		'1: Claude at extra high to GPT, the effort kept, is refused: ' || v_result::text);
end $$;
select pg_temp.gx_activate(null, false) \g /dev/null
do $$
declare v_result jsonb := pg_temp.gx_get('92400000-0000-4000-8000-000000000031');
begin
	perform pg_temp.base_assert(pg_temp.gx_efforts(v_result, 'gpt-6-astra') = 'low,medium,high'
		and (select count(*) from jsonb_object_keys(v_result -> 'efforts')) = 2
		and v_result -> 'models' = '["gpt-6-astra","gpt-6.1-sol"]'::jsonb,
		'1: efforts name exactly the models offered: ' || v_result::text);
end $$;
delete from public.qorpera_session_models;

select set_config('qorpera_test.gx_bundle', pg_temp.gx_activate('["xhigh"]'), false) \g /dev/null

savepoint gx_set;
do $$
declare v_result jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	v_result := pg_temp.gx_get(v_bob);
	perform pg_temp.base_assert(pg_temp.gx_efforts(v_result, 'gpt-6-astra') = 'low,medium,high,xhigh'
		and pg_temp.gx_efforts(v_result, 'gpt-6.1-sol') = 'low,medium,high,xhigh'
		and pg_temp.gx_efforts(v_result, 'claude-opus-5-5') = 'low,medium,high,xhigh,max',
		'2: with threadEfforts, GPT is offered extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, null, 'xhigh');
	perform pg_temp.base_assert(pg_temp.gx_refused(v_result) = '22023',
		'2: extra high with no model chosen is refused: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'gpt-6-astra', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-astra' and v_result ->> 'reasoning_effort' = 'xhigh'
		and pg_temp.gx_efforts(v_result, 'gpt-6-astra') = 'low,medium,high,xhigh',
		'2: GPT-6 Astra at extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'gpt-6.1-sol');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.1-sol' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: GPT-6.1 Sol keeps extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, null, 'max');
	perform pg_temp.base_assert(pg_temp.gx_refused(v_result) = '22023', '2: max stays Claude only: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'claude-opus-5-5', 'max');
	perform pg_temp.base_assert(v_result ->> 'reasoning_effort' = 'max', '2: Opus 5.5 at max: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'gpt-6-astra');
	perform pg_temp.base_assert(pg_temp.gx_refused(v_result) = '22023', '2: GPT with max kept is refused: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'gpt-6-astra', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-astra' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: Claude max to GPT steps down to extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_bob, 'claude-fable-5-2', 'xhigh');
	v_result := pg_temp.gx_set(v_bob, 'gpt-6.1-sol');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.1-sol' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: Claude at extra high to GPT keeps extra high: ' || v_result::text);
	v_result := pg_temp.gx_set(v_carol, 'gpt-6-luna', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-luna' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: an earlier GPT model takes extra high too (Codex lists it): ' || v_result::text);
	delete from public.qorpera_session_models where session_id = pg_temp.gx_session(v_carol);
	perform pg_temp.base_error(format('insert into public.qorpera_session_models(session_id, reasoning_effort, version,'
		' updated_by_user_id) values (%L, %L, 1, %L)', pg_temp.gx_session(v_carol), 'xhigh', pg_temp.gx_owner()), '23514');
	insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version, updated_by_user_id)
	values (pg_temp.gx_session(v_carol), 'gpt-6.1-sol', 'xhigh', 1, pg_temp.gx_owner());
end $$;
rollback to savepoint gx_set;

savepoint gx_turn;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_admission jsonb; v_authority jsonb;
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.gx_set(v_bob, 'gpt-6.1-sol', 'xhigh');
	v_run := pg_temp.gx_turn(v_bob, 'Think this through carefully.');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6.1-sol' and v_run.model_selection = 'session_override'
		and v_run.reasoning_effort = 'xhigh' and v_run.claude_model is null
		and v_run.runtime_bundle_sha256 = current_setting('qorpera_test.gx_bundle'),
		'3: the member''s turn runs GPT-6.1 Sol at extra high: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	v_authority := public.qorpera_describe_native_tool_authority(v_binding);
	perform pg_temp.base_assert(v_authority #>> '{identity,reasoningEffort}' = 'xhigh',
		'3: the tool authority names extra high: ' || v_authority::text);
	v_admission := pg_temp.gx_admit(v_binding);
	perform pg_temp.base_assert(v_admission ->> 'reasoningEffort' = 'xhigh' and v_admission ->> 'runId' = v_run.id::text,
		'3: and the native admission takes it: ' || v_admission::text);
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set reasoning_effort = %L where id = %L', 'high',
		v_run.id), '42501', 'Execution reasoning policy is immutable');
end $$;
rollback to savepoint gx_turn;

savepoint gx_claude;
do $$
declare v_run public.qorpera_execution_runs; v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	perform pg_temp.gx_set(v_carol, 'claude-opus-5-5', 'xhigh');
	v_run := pg_temp.gx_turn(v_carol, 'Build the onboarding PDF.');
	perform pg_temp.base_assert(v_run.reasoning_effort = 'low' and v_run.claude_model = 'claude-opus-5-5'
		and v_run.claude_effort = 'xhigh', '3: a Claude pick at extra high still leaves the front at its default: '
		|| to_jsonb(v_run)::text);
end $$;
rollback to savepoint gx_claude;

savepoint gx_old_bundle;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.gx_set(v_bob, 'gpt-6-astra', 'xhigh');
	perform pg_temp.gx_activate(null);
	v_run := pg_temp.gx_turn(v_bob, 'Think this through carefully.');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6-astra' and v_run.reasoning_effort = 'high',
		'4: under a bundle without threadEfforts a conversation saved at extra high runs at high: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	perform pg_temp.base_assert(public.qorpera_describe_native_tool_authority(v_binding) #>> '{identity,reasoningEffort}' = 'high'
		and pg_temp.gx_admit(v_binding) ->> 'reasoningEffort' = 'high', '4: and starts at high');
	perform pg_temp.base_assert((pg_temp.gx_get(v_bob)) ->> 'reasoning_effort' = 'xhigh',
		'4: the conversation keeps its choice for when the bundle allows it again');
end $$;
rollback to savepoint gx_old_bundle;

savepoint gx_old_bundle_low;
do $$
declare v_run public.qorpera_execution_runs; v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_manifest jsonb;
begin
	perform pg_temp.gx_set(v_bob, 'gpt-6-astra', 'xhigh');
	perform pg_temp.gx_activate(null);
	select b.manifest into strict v_manifest from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := jsonb_set(v_manifest, '{modelPolicy,allowed}', '["low","medium"]') #- '{modelPolicy,unattended}';
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select bundle_key, max(version) + 1, v_manifest, encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = (select b.bundle_key from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton)
	group by bundle_key;
	update public.qorpera_active_runtime_bundle set (runtime_bundle_id, runtime_bundle_sha256) = (select id, sha256
		from public.qorpera_runtime_bundles where sha256 = encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'),
			'hex')) where singleton;
	v_run := pg_temp.gx_turn(v_bob, 'Think this through carefully.');
	perform pg_temp.base_assert(v_run.reasoning_effort = 'low',
		'4: under a bundle that allows no high, extra high falls to the default: ' || to_jsonb(v_run)::text);
end $$;
rollback to savepoint gx_old_bundle_low;

savepoint gx_unattended;
do $$
declare v_carol uuid := '92400000-0000-4000-8000-000000000032'; v_bob_run public.qorpera_execution_runs;
	v_bob jsonb; v_message jsonb; v_run public.qorpera_execution_runs; v_manifest jsonb; v_wake public.qorpera_execution_runs;
begin
	perform pg_temp.gx_set(v_carol, 'gpt-6-astra', 'xhigh');
	perform pg_temp.gx_set('92400000-0000-4000-8000-000000000031', 'gpt-6-astra', 'low');
	v_bob_run := pg_temp.gx_turn('92400000-0000-4000-8000-000000000031', 'Hand Carol the note.');
	v_bob := pg_temp.base_start(v_bob_run.id);
	perform pg_temp.base_public_send(v_bob, 'progress', 'gx-ack');
	v_message := public.qorpera_send_coworker_message(v_bob, v_carol, 'gx-carry-note', 'The worker reported.');
	perform pg_temp.base_materialize();
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_message ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_run.source_kind = 'wake' and v_run.reasoning_effort <> 'xhigh',
		'5: a coworker''s message to a conversation at extra high runs at the agent''s own effort: ' || to_jsonb(v_run)::text);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	perform pg_temp.base_assert(not public.qorpera_manifest_allows_reasoning_effort(v_manifest, 'xhigh'),
		'5: routines, chains and agent.md never take extra high (their check is unchanged)');
	v_wake := v_run;
	v_wake.reasoning_effort := 'xhigh';
	perform pg_temp.base_assert(not public.qorpera_run_allows_reasoning_effort(v_manifest, v_wake),
		'5: nor would the admission take it on a wake');
	v_wake.source_kind := 'room_delivery';
	perform pg_temp.base_assert(public.qorpera_run_allows_reasoning_effort(v_manifest, v_wake),
		'5: while a member''s room delivery may run at it');
	v_wake.reasoning_effort := 'max';
	perform pg_temp.base_assert(not public.qorpera_run_allows_reasoning_effort(v_manifest, v_wake),
		'5: max never reaches a run');
	set local session_replication_role = replica;
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set reasoning_effort = %L where id = %L', 'xhigh',
		v_run.id), '23514');
	set local session_replication_role = origin;
end $$;
rollback to savepoint gx_unattended;

do $$
declare v_active jsonb := (select b.manifest from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton);
	v_case record; v_manifest jsonb; v_sha text; v_id uuid; v_role text; v_function text;
begin
	for v_case in select * from (values ('xhigh', '["xhigh"]'::jsonb, null::text, true), ('empty', '[]', null, true),
		('absent', null, null, true), ('max', '["max"]', null, false), ('high', '["high"]', null, false),
		('string', '"xhigh"', null, false), ('object', '{"xhigh":true}', null, false), ('json-null', 'null', null, false),
		('routine-only', '["xhigh"]', 'routine', true)) as c(name, value, overrides, valid) loop
		v_manifest := case when v_case.value is null then v_active #- '{modelPolicy,threadEfforts}'
			else jsonb_set(v_active, '{modelPolicy,threadEfforts}', v_case.value) end;
		if v_case.overrides is not null then
			v_manifest := jsonb_set(v_manifest, '{modelPolicy,overrides}', to_jsonb(v_case.overrides)); end if;
		v_sha := encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex');
		insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
		values ('test-1285-' || v_case.name, 1, v_manifest, v_sha) returning id into v_id;
		if v_case.valid then
			perform public.qorpera_execution_runtime_manifest(jsonb_populate_record(null::public.qorpera_execution_runs,
				jsonb_build_object('runtime_bundle_id', v_id, 'runtime_bundle_sha256', v_sha)));
		else
			perform pg_temp.base_error(format('select public.qorpera_execution_runtime_manifest(jsonb_populate_record('
				'null::public.qorpera_execution_runs, %L::jsonb))', jsonb_build_object('runtime_bundle_id', v_id,
				'runtime_bundle_sha256', v_sha)), '42501', 'Run requires an executable runtime bundle');
		end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_model_policy_thread_efforts(jsonb)',
			'public.qorpera_active_bundle_thread_efforts()',
			'public.qorpera_run_allows_reasoning_effort(jsonb,public.qorpera_execution_runs)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '6: % may call %', v_role, v_function; end if;
		end loop;
	end loop;
end $$;

rollback;
