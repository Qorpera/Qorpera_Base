-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.cm_activate(p_claude boolean) returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := case when p_claude then jsonb_set(v_active.manifest, '{modelPolicy,claudeChoice}', '"thread"')
		else v_active.manifest #- '{modelPolicy,claudeChoice}' end #- '{modelPolicy,threadEfforts}';
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
end $$;
create function pg_temp.cm_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;
create function pg_temp.cm_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;
create function pg_temp.cm_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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
create function pg_temp.cm_get(p_user uuid, p_staff uuid) returns jsonb language sql as $$
	select pg_temp.cm_call(p_user, format('select public.qorpera_get_session_model(%L)', pg_temp.cm_session(p_staff)))
$$;
create function pg_temp.cm_set(p_user uuid, p_staff uuid, p_model text, p_effort text default null) returns jsonb
language sql as $$
	select pg_temp.cm_call(p_user, format('select public.qorpera_set_session_model(%L, %L, %s, %L)', pg_temp.cm_session(p_staff),
		p_model, coalesce((select version from public.qorpera_session_models where session_id = pg_temp.cm_session(p_staff)), 0),
		p_effort))
$$;
create function pg_temp.cm_speed(p_user uuid, p_staff uuid, p_tier text) returns jsonb language sql as $$
	select pg_temp.cm_call(p_user, format('select public.qorpera_set_session_service_tier(%L, %L, %s)', pg_temp.cm_session(p_staff),
		p_tier, coalesce((select version from public.qorpera_session_models where session_id = pg_temp.cm_session(p_staff)), 0)))
$$;
create function pg_temp.cm_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;
create function pg_temp.cm_models(p_result jsonb) returns text language sql as $$
	select string_agg(model, ',' order by ordinality) from jsonb_array_elements_text(p_result -> 'models') with ordinality as m(model)
$$;
create function pg_temp.cm_run(p_run uuid) returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = p_run
$$;
create function pg_temp.cm_turn(p_staff uuid, p_text text) returns public.qorpera_execution_runs language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post(pg_temp.cm_owner(), p_staff, p_text); v_pass jsonb := pg_temp.base_materialize();
	v_run public.qorpera_execution_runs;
begin
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the post is a run: ' || v_pass::text);
	return v_run;
end $$;
create function pg_temp.cm_default_model(p_staff uuid) returns text language sql as $$
	select coalesce((select mapping.model_id from public.qorpera_staff_provider_models mapping
		where mapping.profile_id = '92400000-0000-4000-8000-000000000010' and mapping.staff_agent_id = p_staff
			and mapping.provider = 'openai'), 'provider-default')
$$;

create function pg_temp.cm_carried(p_run uuid, p_source text, p_origin uuid) returns jsonb language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = p_source, origin_run_id = p_origin where run_id = p_run;
	set local session_replication_role = origin;
	return public.qorpera_resolve_run_claude_choice(run, bundle.manifest)
	from public.qorpera_execution_runs run join public.qorpera_runtime_bundles bundle on bundle.id = run.runtime_bundle_id
	where run.id = p_run;
end $$;
create function pg_temp.cm_start_only(p_run uuid) returns jsonb language plpgsql as $$
declare v_other uuid;
begin
	for v_other in select job.run_id from public.qorpera_runner_jobs job where job.status = 'queued' and job.run_id <> p_run loop
		perform pg_temp.c4_end_job(v_other, 'cancelled');
	end loop;
	return pg_temp.base_start(p_run);
end $$;
create function pg_temp.cm_bob(p_key text) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs := pg_temp.cm_turn('92400000-0000-4000-8000-000000000031', 'Hand Carol the note.');
	v_binding jsonb;
begin
	v_binding := pg_temp.base_start(v_run.id);
	perform pg_temp.base_public_send(v_binding, 'progress', p_key || '-ack');
	return v_binding;
end $$;

select pg_temp.cm_activate(false) \g /dev/null
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.cm_owner());
select pg_temp.c4_login('12810000-0000-4000-8000-0000000000c1', pg_temp.cm_owner()) \g /dev/null

do $$
declare v_result jsonb;
begin
	perform pg_temp.base_assert(public.qorpera_member_may_pick_claude('92400000-0000-4000-8000-000000000010', pg_temp.cm_owner()),
		'1: fixture: the owner can run Claude Code here');
	v_result := pg_temp.cm_get(pg_temp.cm_owner(), '92400000-0000-4000-8000-000000000031');
	perform pg_temp.base_assert(pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol'
		and v_result ->> 'model_id' = 'gpt-6-astra' and v_result ->> 'reasoning_effort' = 'low', '1: GPT only: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), '92400000-0000-4000-8000-000000000031', 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = 'QRC02', '1: Claude refused: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), '92400000-0000-4000-8000-000000000031', 'gpt-6.1-sol', 'medium');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.1-sol' and v_result ->> 'reasoning_effort' = 'medium'
		and (v_result ->> 'version')::integer = 1 and pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol',
		'1: GPT-6.1 Sol for everyone: ' || v_result::text);
	delete from public.qorpera_session_models where session_id = pg_temp.cm_session('92400000-0000-4000-8000-000000000031');
end $$;

select set_config('qorpera_test.cm_bundle', pg_temp.cm_activate(true), false) \g /dev/null

savepoint cm_set;
do $$
declare v_result jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_member uuid := '92400000-0000-4000-8000-000000000002';
begin
	v_result := pg_temp.cm_get(pg_temp.cm_owner(), v_bob);
	perform pg_temp.base_assert(pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol,claude-fable-5-2,claude-opus-5-5',
		'2: the owner may pick Claude: ' || v_result::text);
	perform pg_temp.base_assert(not public.qorpera_member_may_pick_claude('92400000-0000-4000-8000-000000000010', v_member),
		'2: a member off the Claude list may not pick Claude');
	v_result := pg_temp.cm_get(v_member, v_bob);
	perform pg_temp.base_assert(v_result ? 'error' or pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol',
		'2: a member off the Claude list is offered GPT only: ' || v_result::text);
	v_result := pg_temp.cm_set(v_member, v_bob, 'claude-fable-5-2', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) in ('QRC02', '42501'), '2: and may not pick it: ' || v_result::text);

	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'max');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-opus-5-5' and v_result ->> 'reasoning_effort' = 'max'
		and v_result ->> 'service_tier' = 'fast' and (v_result ->> 'version')::integer = 1, '2: Opus 5.5 at max: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-fable-5-2', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-fable-5-2' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: Fable 5.2 at extra high: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, null, 'max');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-fable-5-2' and v_result ->> 'reasoning_effort' = 'max',
		'2: an effort alone on a Claude model: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'gpt-6-astra');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = '22023', '2: GPT with max kept is refused: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'gpt-6-astra', 'high');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-astra' and v_result ->> 'reasoning_effort' = 'high',
		'2: Claude max to GPT comes with an allowed effort: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, null, 'xhigh');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = '22023', '2: xhigh on GPT is refused: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'gpt-6.1-sol', 'max');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = '22023', '2: max on GPT-6.1 Sol is refused: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-sonnet-5-5', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = '22023', '2: an unknown model is refused: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'gpt-6-astra', 'ultra');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = '22023', '2: an unknown effort is refused: ' || v_result::text);
	v_result := pg_temp.cm_speed(pg_temp.cm_owner(), v_bob, 'standard');
	perform pg_temp.base_assert(v_result ->> 'service_tier' = 'standard' and v_result ->> 'model_id' = 'gpt-6-astra'
		and pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol,claude-fable-5-2,claude-opus-5-5',
		'2: the speed answer names the models too: ' || v_result::text);
	perform pg_temp.base_error(format('insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version,'
		' updated_by_user_id) values (%L, %L, %L, 1, %L)', pg_temp.cm_session('92400000-0000-4000-8000-000000000032'), 'gpt-6-astra',
		'max', pg_temp.cm_owner()), '23514');
	perform pg_temp.base_error(format('insert into public.qorpera_session_models(session_id, reasoning_effort, version,'
		' updated_by_user_id) values (%L, %L, 1, %L)', pg_temp.cm_session('92400000-0000-4000-8000-000000000032'), 'max',
		pg_temp.cm_owner()), '23514');
	insert into public.qorpera_session_models(session_id, model_id, version, updated_by_user_id)
	values (pg_temp.cm_session('92400000-0000-4000-8000-000000000032'), 'gpt-6-luna', 1, pg_temp.cm_owner());
	v_result := pg_temp.cm_get(pg_temp.cm_owner(), '92400000-0000-4000-8000-000000000032');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-luna', '2: an earlier model still reads: ' || v_result::text);

	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-opus-5-5', '2: fixture: Bob''s thread on Opus 5.5: ' || v_result::text);
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where id = '12810000-0000-4000-8000-0000000000c1';
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, null, 'max');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = 'QRC02',
		'2: a writer who may not pick Claude may not change a Claude conversation''s effort: ' || v_result::text);
	perform pg_temp.base_assert((select reasoning_effort from public.qorpera_session_models
		where session_id = pg_temp.cm_session(v_bob)) = 'high', '2: and the effort stays as it was');
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'gpt-6-astra', 'medium');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6-astra' and v_result ->> 'reasoning_effort' = 'medium',
		'2: but may switch it to GPT: ' || v_result::text);
	v_result := pg_temp.cm_get(pg_temp.cm_owner(), v_bob);
	perform pg_temp.base_assert(pg_temp.cm_models(v_result) = 'gpt-6-astra,gpt-6.1-sol',
		'2: signed out of Claude, the owner is offered GPT only: ' || v_result::text);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = 'QRC02', '2: and may not pick Claude: ' || v_result::text);
	perform pg_temp.c4_login('12810000-0000-4000-8000-0000000000c2', pg_temp.cm_owner());
	perform pg_temp.h1_switch(true, false);
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = 'QRC02', '2: nor without the company''s home: ' || v_result::text);
	perform pg_temp.h1_switch(true, true);
	update public.qorpera_account_model_login_settings set enabled = false;
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(pg_temp.cm_refused(v_result) = 'QRC02', '2: nor while Claude sign-in is closed: ' || v_result::text);
	update public.qorpera_account_model_login_settings set enabled = true;
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_bob, 'claude-opus-5-5', 'high');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-opus-5-5', '2: signed in again, it is open: ' || v_result::text);
end $$;
rollback to savepoint cm_set;

savepoint cm_sol;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_context jsonb;
begin
	perform pg_temp.cm_set(pg_temp.cm_owner(), '92400000-0000-4000-8000-000000000031', 'gpt-6.1-sol', 'medium');
	v_run := pg_temp.cm_turn('92400000-0000-4000-8000-000000000031', 'Look at the numbers.');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6.1-sol' and v_run.model_selection = 'session_override'
		and v_run.reasoning_effort = 'medium' and v_run.service_tier = 'fast' and v_run.claude_model is null
		and v_run.claude_effort is null and v_run.runtime_bundle_sha256 = current_setting('qorpera_test.cm_bundle'),
		'3: GPT-6.1 Sol reaches the run: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.base_assert(not (v_context ? 'claude') and v_context ->> 'serviceTier' = 'fast',
		'3: a GPT turn''s context names no Claude pick: ' || (v_context - 'history' - 'currentInputs')::text);
end $$;
rollback to savepoint cm_sol;

savepoint cm_claude;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_context jsonb; v_result jsonb;
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	v_result := pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'claude-opus-5-5', 'max');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'claude-opus-5-5', '3: fixture: Carol''s thread picks Opus 5.5: '
		|| v_result::text);
	perform pg_temp.cm_speed(pg_temp.cm_owner(), v_carol, 'standard');
	v_run := pg_temp.cm_turn(v_carol, 'Build the onboarding PDF.');
	perform pg_temp.base_assert(v_run.model_provider = 'openai' and v_run.model_selection in ('provider_mapping', 'provider_default')
		and v_run.model_id = pg_temp.cm_default_model(v_carol) and v_run.model_id not like 'claude-%',
		'3: a Claude pick keeps the front on its default path: ' || to_jsonb(v_run)::text);
	perform pg_temp.base_assert(v_run.reasoning_effort = 'low' and v_run.service_tier = 'standard',
		'3: at the bundle''s default effort and the conversation''s speed: ' || to_jsonb(v_run)::text);
	perform pg_temp.base_assert(v_run.claude_model = 'claude-opus-5-5' and v_run.claude_effort = 'max',
		'3: the run carries the pick: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	perform pg_temp.base_assert(v_binding ->> 'model' = pg_temp.cm_default_model(v_carol)
		and (public.qorpera_describe_native_tool_authority(v_binding) #>> '{identity,reasoningEffort}') = 'low',
		'3: the runner gets the default model and effort, never Claude''s: ' || v_binding::text);
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.base_assert(v_context -> 'claude' = '{"model":"claude-opus-5-5","effort":"max"}'::jsonb
		and v_context ->> 'serviceTier' = 'standard',
		'3: the context carries the pick: ' || (v_context - 'history' - 'currentInputs')::text);
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set claude_effort = %L where id = %L', 'low', v_run.id),
		'42501', 'Execution Claude choice is immutable');
end $$;
rollback to savepoint cm_claude;

savepoint cm_claude_medium;
do $$
declare v_run public.qorpera_execution_runs; v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	perform pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'claude-fable-5-2', 'medium');
	v_run := pg_temp.cm_turn(v_carol, 'Write the plan.');
	perform pg_temp.base_assert(v_run.reasoning_effort = 'low' and v_run.service_tier = 'fast'
		and v_run.claude_model = 'claude-fable-5-2' and v_run.claude_effort = 'medium',
		'3: a Claude pick''s effort never reaches the front, even one the front allows: ' || to_jsonb(v_run)::text);
end $$;
rollback to savepoint cm_claude_medium;

savepoint cm_claude_signed_out;
do $$
declare v_run public.qorpera_execution_runs; v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	perform pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'claude-opus-5-5', 'high');
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where owner_user_id = pg_temp.cm_owner() and status = 'active';
	v_run := pg_temp.cm_turn(v_carol, 'Write the plan.');
	perform pg_temp.base_assert(v_run.claude_model is null and v_run.model_id = pg_temp.cm_default_model(v_carol)
		and v_run.reasoning_effort = 'low', '3: a member who can no longer run Claude Code carries no pick: ' || to_jsonb(v_run)::text);
end $$;
rollback to savepoint cm_claude_signed_out;

savepoint cm_old_bundle;
do $$
declare v_run public.qorpera_execution_runs; v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	perform pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'claude-opus-5-5', 'high');
	perform pg_temp.cm_activate(false);
	v_run := pg_temp.cm_turn(v_carol, 'Write the plan.');
	perform pg_temp.base_assert(v_run.claude_model is null and v_run.model_id = pg_temp.cm_default_model(v_carol)
		and v_run.reasoning_effort = 'low',
		'3: under a bundle without claudeChoice the run carries no pick and the front keeps its default: ' || to_jsonb(v_run)::text);
end $$;
rollback to savepoint cm_old_bundle;

savepoint cm_carry_on;
do $$
declare v_carol uuid := '92400000-0000-4000-8000-000000000032'; v_member public.qorpera_execution_runs; v_bob jsonb;
	v_message jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'claude-opus-5-5', 'max');
	v_member := pg_temp.cm_turn(v_carol, 'Build the onboarding PDF.');
	perform pg_temp.base_assert(v_member.claude_model = 'claude-opus-5-5' and v_member.claude_effort = 'max',
		'3b: fixture: the member turn is pinned: ' || to_jsonb(v_member)::text);
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(),
		last_error = 'Fixture: the member turn ends' where run_id = v_member.id;
	perform pg_temp.cm_speed(pg_temp.cm_owner(), v_carol, 'standard');
	perform pg_temp.cm_set(pg_temp.cm_owner(), v_carol, 'gpt-6-astra', 'low');
	v_bob := pg_temp.cm_bob('cm-carry');
	v_message := public.qorpera_send_coworker_message(v_bob, v_carol, 'cm-carry-note', 'The worker reported.');
	perform pg_temp.base_materialize();
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_message ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_run.claude_model is null,
		'3b: a coworker''s message starts no chain of the member''s: ' || to_jsonb(v_run)::text);
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-completion', v_member.id)
		= '{"model":"claude-opus-5-5","effort":"max"}'::jsonb, '3b: a worker report on the member''s chain keeps the pick');
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'machine-event', v_member.id)
		= '{"model":"claude-opus-5-5","effort":"max"}'::jsonb, '3b: a machine event on the chain keeps it');
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-dispatch', v_member.id) is null,
		'3b: never on a worker''s own run');
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-completion', null) is null,
		'3b: a chain whose first run is unknown carries none');
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-completion', (v_bob ->> 'runId')::uuid) is null,
		'3b: another agent''s run is no first run of this chain');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set claude_model = null, claude_effort = null where id = v_member.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-completion', v_member.id) is null,
		'3b: a carry-on from an unpinned chain carries none');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set claude_model = 'claude-opus-5-5', claude_effort = 'max' where id = v_member.id;
	set local session_replication_role = origin;
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where owner_user_id = pg_temp.cm_owner() and status = 'active';
	perform pg_temp.base_assert(pg_temp.cm_carried(v_run.id, 'worker-completion', v_member.id) is null,
		'3b: a carry-on whose member has since lost Claude carries none');
end $$;
rollback to savepoint cm_carry_on;

set local session_replication_role = replica;
update public.qorpera_execution_runs set claude_model = 'claude-opus-5-5', claude_effort = 'xhigh'
where id = (pg_temp.c4_alice() ->> 'runId')::uuid;
set local session_replication_role = origin;
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf'; v_result jsonb;
	w public.qorpera_runtime_workers; v_wake public.qorpera_wake_occurrences;
begin
	v_result := pg_temp.c4_dispatch(v_alice, 'cm-dispatch-1', v_folder, pg_temp.c4_brief('12810000-0000-4000-8000-0000000000b1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4: the dispatch saves: ' || v_result::text);
	w := pg_temp.c4_worker('12810000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.harness = 'claude-code' and w.claude_model = 'claude-opus-5-5' and w.claude_effort = 'xhigh',
		'4: the worker records the pick: ' || to_jsonb(w)::text);
	v_result := pg_temp.c4_dispatch(v_alice, 'cm-dispatch-plain', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12810000-0000-4000-8000-0000000000b2', 'codex', 'Read the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved'
		and (pg_temp.c4_worker('12810000-0000-4000-8000-0000000000b2')).claude_model is null,
		'4: a Codex worker records none: ' || v_result::text);
	perform pg_temp.c4_drain();
	w := pg_temp.c4_worker(w.id);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.occurrence_id;
	perform pg_temp.base_assert(v_wake.payload -> 'claude' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb
		and v_wake.payload ->> 'harness' = 'claude-code', '4: its wake carries the pick: ' || v_wake.payload::text);
	perform pg_temp.base_assert(not ((select payload from public.qorpera_wake_occurrences
		where id = (pg_temp.c4_worker('12810000-0000-4000-8000-0000000000b2')).occurrence_id) ? 'claude'),
		'4: the Codex worker''s wake names none');
	perform pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.occurrence_id;
	perform pg_temp.base_assert(v_wake.run_id is not null and (pg_temp.cm_run(v_wake.run_id)).claude_model is null,
		'4: the worker''s own run is materialized and carries no pick of its own');
	set local session_replication_role = replica;
	perform pg_temp.c4_end_job(v_wake.run_id, 'failed');
	set local session_replication_role = origin;
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = coalesce(finished_at, clock_timestamp())
	where id = v_wake.id and status = 'materialized';
	perform pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).state <> 'active', '4: the first run of the worker has ended');

	set local session_replication_role = replica;
	update public.qorpera_execution_runs set claude_model = null, claude_effort = null where id = (v_alice ->> 'runId')::uuid;
	set local session_replication_role = origin;
	v_result := pg_temp.c4_followup(v_alice, 'cm-followup-1', v_folder, 'Use the new logo.');
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved' and w.sequence = 2
		and w.claude_model = 'claude-opus-5-5' and w.claude_effort = 'xhigh',
		'4: a follow-up from a run without a pick keeps the recorded one: ' || v_result::text || ' ' || to_jsonb(w)::text);
	perform pg_temp.c4_drain();
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert((select payload -> 'claude' from public.qorpera_wake_occurrences where id = w.occurrence_id)
		= '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb, '4: and its next wake carries it');
	perform pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.occurrence_id;
	set local session_replication_role = replica;
	perform pg_temp.c4_end_job(v_wake.run_id, 'failed');
	set local session_replication_role = origin;
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = coalesce(finished_at, clock_timestamp())
	where id = v_wake.id and status = 'materialized';
	perform pg_temp.c4_drain();

	set local session_replication_role = replica;
	update public.qorpera_execution_runs set claude_model = 'claude-fable-5-2', claude_effort = 'high'
	where id = (v_alice ->> 'runId')::uuid;
	set local session_replication_role = origin;
	v_result := pg_temp.c4_followup(v_alice, 'cm-followup-2', v_folder, 'Make it shorter.');
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved' and w.sequence = 3
		and w.claude_model = 'claude-fable-5-2' and w.claude_effort = 'high',
		'4: a follow-up from a run with a pick takes that pick: ' || v_result::text || ' ' || to_jsonb(w)::text);
end $$;

do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_worker_run uuid; v_worker jsonb; v_result jsonb; v_wake public.qorpera_wake_occurrences;
	v_run public.qorpera_execution_runs; v_binding jsonb; v_context jsonb; v_pass jsonb;
begin
	v_worker_run := (select run_id from public.qorpera_wake_occurrences
		where id = (pg_temp.c4_worker('12810000-0000-4000-8000-0000000000b2')).occurrence_id);
	v_worker := pg_temp.cm_start_only(v_worker_run);
	v_result := pg_temp.c4_results(v_worker, 'cm-report', 'QorperaOS/agents/alice/todos/onboarding/notes');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4b: the worker reports: ' || v_result::text);
	perform pg_temp.c4_end_job(v_worker_run, 'completed');
	perform pg_temp.c4_end_job((v_alice ->> 'runId')::uuid, 'failed');
	perform pg_temp.c4_drain();
	v_pass := pg_temp.base_materialize();
	select * into v_wake from public.qorpera_wake_occurrences
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and source_kind = 'worker-completion'
	order by created_at desc limit 1;
	select * into v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.base_assert(v_run.id is not null and v_wake.origin_run_id = (v_alice ->> 'runId')::uuid
		and v_run.claude_model = 'claude-fable-5-2' and v_run.claude_effort = 'high' and v_run.model_id not like 'claude-%',
		'4b: the worker''s report wakes the agent on its chain, with the chain''s Claude pick: ' || v_pass::text || ' '
		|| coalesce((to_jsonb(v_wake) - 'payload')::text, 'no wake') || ' ' || coalesce(to_jsonb(v_run)::text, 'no run'));
	v_binding := pg_temp.cm_start_only(v_run.id);
	v_context := public.qorpera_describe_company_run_context(v_binding);
	perform pg_temp.base_assert(v_context -> 'claude' = '{"model":"claude-fable-5-2","effort":"high"}'::jsonb,
		'4b: and its context carries it: ' || (v_context - 'history' - 'currentInputs')::text);
end $$;

do $$
declare v_active jsonb := (select b.manifest from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton);
	v_case record; v_sha text; v_id uuid; v_role text; v_function text;
begin
	for v_case in select * from (values ('thread', '"thread"'::jsonb, true), ('absent', null, true), ('yes', '"yes"', false),
		('json-null', 'null', false), ('number', '1', false), ('object', '{"thread":true}', false)) as c(name, value, valid) loop
		v_active := case when v_case.value is null then v_active #- '{modelPolicy,claudeChoice}'
			else jsonb_set(v_active, '{modelPolicy,claudeChoice}', v_case.value) end;
		v_sha := encode(extensions.digest(convert_to(v_active::text, 'utf8'), 'sha256'), 'hex');
		insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
		values ('test-1281-' || v_case.name, 1, v_active, v_sha) returning id into v_id;
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
		foreach v_function in array array['public.qorpera_member_may_pick_claude(uuid,uuid)',
			'public.qorpera_resolve_run_claude_choice(public.qorpera_execution_runs,jsonb)',
			'public.qorpera_active_bundle_claude_choice()', 'public.qorpera_pin_execution_claude_choice()'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '5: % may call %', v_role, v_function; end if;
		end loop;
	end loop;
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_get_session_model(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_set_session_model(uuid,text,bigint,text)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_set_session_model(uuid,text,bigint,text)', 'execute'),
		'5: the session model calls stay the members''');
end $$;

rollback;
