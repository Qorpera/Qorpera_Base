-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
-- 20260930803000: GPT-6.2 Sol replaces GPT-6.1 Sol in a conversation's Model menu and is the platform's GPT model.
-- 1. The menu offers GPT-6 Astra and GPT-6.2 Sol (and Claude when the member may pick it); a conversation with no pick
--    reads GPT-6.2 Sol, from its agent's model or, with none, the default.
-- 2. The setter takes GPT-6.2 Sol with its efforts (extra high under threadEfforts) and refuses GPT-6.1 Sol; the table too.
-- 3. A member's turn runs GPT-6.2 Sol on the default path; a pick of GPT-6 Astra or GPT-6.2 Sol is kept.
-- 4. The migration's move: conversations on GPT-6.1 Sol go to GPT-6.2 Sol, agents whose agent.md names no model go to
--    GPT-6.2 Sol, and an agent.md that names GPT-6 Astra keeps it.
select pg_temp.base_claims('service_role');

create function pg_temp.sx_activate(p_thread jsonb, p_claude boolean default true) returns text language plpgsql as $$
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
create function pg_temp.sx_owner() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000001'::uuid
$$;
create function pg_temp.sx_profile() returns uuid language sql as $$
	select profile_id from public.qorpera_profile_staff where staff_agent_id = '92400000-0000-4000-8000-000000000031'
$$;
create function pg_temp.sx_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(p_staff)
$$;
create function pg_temp.sx_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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
create function pg_temp.sx_get(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.sx_call(pg_temp.sx_owner(), format('select public.qorpera_get_session_model(%L)', pg_temp.sx_session(p_staff)))
$$;
create function pg_temp.sx_set(p_staff uuid, p_model text, p_effort text default null) returns jsonb language sql as $$
	select pg_temp.sx_call(pg_temp.sx_owner(), format('select public.qorpera_set_session_model(%L, %L, %s, %L)',
		pg_temp.sx_session(p_staff), p_model,
		coalesce((select version from public.qorpera_session_models where session_id = pg_temp.sx_session(p_staff)), 0), p_effort))
$$;
create function pg_temp.sx_refused(p_result jsonb) returns text language sql as $$
	select case when p_result ->> 'error' = 'PGRST' then (p_result ->> 'message')::jsonb ->> 'code' else p_result ->> 'error' end
$$;
create function pg_temp.sx_list(p_result jsonb, p_key text) returns text language sql as $$
	select string_agg(item, ',' order by ordinality)
	from jsonb_array_elements_text(case when p_key = 'models' then p_result -> 'models' else p_result -> 'efforts' -> p_key end)
		with ordinality as e(item)
$$;
create function pg_temp.sx_turn(p_staff uuid, p_text text) returns public.qorpera_execution_runs language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post(pg_temp.sx_owner(), p_staff, p_text); v_pass jsonb := pg_temp.base_materialize();
	v_run public.qorpera_execution_runs;
begin
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.run_id = run.id where wake.id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the post is a run: ' || v_pass::text);
	return v_run;
end $$;
create function pg_temp.sx_staff(p_staff uuid) returns text language sql as $$
	select s.model_id || '/' || coalesce((select m.model_id from public.qorpera_staff_provider_models m
		where m.profile_id = s.profile_id and m.staff_agent_id = s.staff_agent_id and m.provider = 'openai'), '-')
	from public.qorpera_profile_staff s where s.staff_agent_id = p_staff
$$;

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.sx_owner());
select pg_temp.c4_login('12990000-0000-4000-8000-0000000000c1', pg_temp.sx_owner()) \g /dev/null

select pg_temp.sx_activate(null, false) \g /dev/null
savepoint sx_menu;
do $$
declare v_result jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.base_assert(pg_temp.sx_staff(v_bob) = 'gpt-6.2-sol/gpt-6.2-sol'
		and pg_temp.sx_staff('92400000-0000-4000-8000-000000000032') = 'gpt-6.2-sol/gpt-6.2-sol',
		'1: an agent whose agent.md names no model is on GPT-6.2 Sol, its mapping too: ' || pg_temp.sx_staff(v_bob));
	v_result := pg_temp.sx_get(v_bob);
	perform pg_temp.base_assert(pg_temp.sx_list(v_result, 'models') = 'gpt-6-astra,gpt-6.2-sol'
		and v_result ->> 'model_id' = 'gpt-6.2-sol' and (v_result ->> 'version')::integer = 0
		and pg_temp.sx_list(v_result, 'gpt-6.2-sol') = 'low,medium,high'
		and pg_temp.sx_list(v_result, 'gpt-6-astra') = 'low,medium,high'
		and (select count(*) from jsonb_object_keys(v_result -> 'efforts')) = 2,
		'1: the menu offers GPT-6 Astra and GPT-6.2 Sol, and a conversation with no pick reads GPT-6.2 Sol: '
		|| v_result::text);
	delete from public.qorpera_staff_provider_models where profile_id = pg_temp.sx_profile() and staff_agent_id = v_bob;
	v_result := pg_temp.sx_get(v_bob);
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.2-sol',
		'1: with no agent model either, the default is GPT-6.2 Sol: ' || v_result::text);
end $$;
rollback to savepoint sx_menu;

select set_config('qorpera_test.sx_bundle', pg_temp.sx_activate('["xhigh"]'), false) \g /dev/null

savepoint sx_set;
do $$
declare v_result jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
begin
	v_result := pg_temp.sx_get(v_bob);
	perform pg_temp.base_assert(pg_temp.sx_list(v_result, 'models') = 'gpt-6-astra,gpt-6.2-sol,claude-fable-5-2,claude-opus-5-5'
		and pg_temp.sx_list(v_result, 'gpt-6.2-sol') = 'low,medium,high,xhigh'
		and pg_temp.sx_list(v_result, 'claude-opus-5-5') = 'low,medium,high,xhigh,max'
		and not (v_result -> 'efforts') ? 'gpt-6.1-sol',
		'2: a member who may pick Claude gets GPT-6 Astra, GPT-6.2 Sol and Claude; GPT-6.2 Sol takes extra high: '
		|| v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.2-sol', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.2-sol' and v_result ->> 'reasoning_effort' = 'xhigh'
		and (v_result ->> 'version')::integer = 1, '2: GPT-6.2 Sol at extra high: ' || v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.2-sol', 'medium');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.2-sol' and v_result ->> 'reasoning_effort' = 'medium',
		'2: and at medium: ' || v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.1-sol');
	perform pg_temp.base_assert(pg_temp.sx_refused(v_result) = '22023', '2: GPT-6.1 Sol is refused: ' || v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.1-sol', 'low');
	perform pg_temp.base_assert(pg_temp.sx_refused(v_result) = '22023', '2: with an effort too: ' || v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.2-astra');
	perform pg_temp.base_assert(pg_temp.sx_refused(v_result) = '22023', '2: GPT-6.2 Astra is not offered: ' || v_result::text);
	v_result := pg_temp.sx_set(v_bob, 'claude-opus-5-5', 'max');
	v_result := pg_temp.sx_set(v_bob, 'gpt-6.2-sol', 'xhigh');
	perform pg_temp.base_assert(v_result ->> 'model_id' = 'gpt-6.2-sol' and v_result ->> 'reasoning_effort' = 'xhigh',
		'2: Claude at max back to GPT-6.2 Sol steps down to extra high: ' || v_result::text);
	perform pg_temp.base_error(format('insert into public.qorpera_session_models(session_id, model_id, version,'
		' updated_by_user_id) values (%L, %L, 1, %L)', pg_temp.sx_session(v_carol), 'gpt-6.1-sol', pg_temp.sx_owner()), '23514');
	insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version, updated_by_user_id)
	values (pg_temp.sx_session(v_carol), 'gpt-6.2-sol', 'xhigh', 1, pg_temp.sx_owner());
end $$;
rollback to savepoint sx_set;

savepoint sx_turn;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	v_run := pg_temp.sx_turn(v_bob, 'What is next?');
	perform pg_temp.base_assert(v_run.model_provider = 'openai' and v_run.model_id = 'gpt-6.2-sol'
		and v_run.model_selection = 'provider_mapping' and v_run.claude_model is null,
		'3: a member''s turn with no pick runs GPT-6.2 Sol, the agent''s model: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	perform pg_temp.base_assert(public.qorpera_describe_native_tool_authority(v_binding) #>> '{identity,model}' = 'gpt-6.2-sol',
		'3: and the tool authority names GPT-6.2 Sol: ' || public.qorpera_describe_native_tool_authority(v_binding)::text);
end $$;
rollback to savepoint sx_turn;

savepoint sx_turn_astra;
do $$
declare v_run public.qorpera_execution_runs; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.sx_set(v_bob, 'gpt-6-astra', 'high');
	v_run := pg_temp.sx_turn(v_bob, 'What is next?');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6-astra' and v_run.model_selection = 'session_override'
		and v_run.reasoning_effort = 'high',
		'3: a conversation where the member picked GPT-6 Astra keeps it: ' || to_jsonb(v_run)::text);
end $$;
rollback to savepoint sx_turn_astra;

savepoint sx_turn_sol;
do $$
declare v_run public.qorpera_execution_runs; v_binding jsonb; v_bob uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.sx_set(v_bob, 'gpt-6.2-sol', 'xhigh');
	v_run := pg_temp.sx_turn(v_bob, 'Think this through carefully.');
	perform pg_temp.base_assert(v_run.model_id = 'gpt-6.2-sol' and v_run.model_selection = 'session_override'
		and v_run.reasoning_effort = 'xhigh' and v_run.runtime_bundle_sha256 = current_setting('qorpera_test.sx_bundle'),
		'3: a pick of GPT-6.2 Sol at extra high runs it: ' || to_jsonb(v_run)::text);
	v_binding := pg_temp.base_start(v_run.id);
	perform pg_temp.base_assert(public.qorpera_describe_native_tool_authority(v_binding) #>> '{identity,model}' = 'gpt-6.2-sol'
		and public.qorpera_describe_native_tool_authority(v_binding) #>> '{identity,reasoningEffort}' = 'xhigh',
		'3: the tool authority names GPT-6.2 Sol at extra high: ' || public.qorpera_describe_native_tool_authority(v_binding)::text);
end $$;
rollback to savepoint sx_turn_sol;

savepoint sx_move;
do $$
declare v_bob uuid := '92400000-0000-4000-8000-000000000031'; v_carol uuid := '92400000-0000-4000-8000-000000000032';
	v_alice uuid := '92400000-0000-4000-8000-000000000030'; v_moved public.qorpera_session_models;
	v_kept public.qorpera_session_models;
begin
	alter table public.qorpera_session_models drop constraint qorpera_session_models_model_id_check;
	insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version, updated_by_user_id)
	values (pg_temp.sx_session(v_carol), 'gpt-6.1-sol', 'xhigh', 3, pg_temp.sx_owner()),
		(pg_temp.sx_session(v_bob), 'gpt-6-astra', null, 6, pg_temp.sx_owner());
	update public.qorpera_profile_staff set model_id = 'gpt-6-astra' where staff_agent_id in (v_bob, v_carol);
	perform pg_temp.base_assert(pg_temp.sx_staff(v_bob) = 'gpt-6-astra/gpt-6-astra'
		and pg_temp.sx_staff(v_carol) = 'gpt-6-astra/gpt-6-astra', '4: the state before the migration');
	set local session_replication_role = replica;
	update public.qorpera_folder_path_versions v set structured = jsonb_set(v.structured, '{parse,model}', '"gpt-6-astra"')
	from public.qorpera_profile_staff s join public.qorpera_folder_entries e on e.environment_id = s.folder_environment_id
		and e.kind = 'file' and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
	where s.staff_agent_id = v_carol and v.version = e.version;
	set local session_replication_role = origin;

	update public.qorpera_session_models
	set model_id = 'gpt-6.2-sol', version = version + 1, updated_at = clock_timestamp()
	where model_id = 'gpt-6.1-sol';
	alter table public.qorpera_session_models
		add constraint qorpera_session_models_model_id_check check (model_id in ('gpt-6-astra','gpt-6.2-sol','gpt-6-sol',
			'gpt-6-luna','claude-fable-5-2','claude-opus-5-5'));
	update public.qorpera_profile_staff s
	set model_id = 'gpt-6.2-sol'
	from public.qorpera_folder_entries e
	join public.qorpera_folder_path_versions v on v.version = e.version
	where s.folder_environment_id is not null and s.folder_path is not null and s.folder_retired_at is null
		and s.model_provider = 'openai' and s.model_id = 'gpt-6-astra'
		and e.environment_id = s.folder_environment_id and e.kind = 'file'
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
		and v.structured -> 'parse' ->> 'model' is null;

	select * into strict v_moved from public.qorpera_session_models where session_id = pg_temp.sx_session(v_carol);
	select * into strict v_kept from public.qorpera_session_models where session_id = pg_temp.sx_session(v_bob);
	perform pg_temp.base_assert(v_moved.model_id = 'gpt-6.2-sol' and v_moved.reasoning_effort = 'xhigh' and v_moved.version = 4
		and v_kept.model_id = 'gpt-6-astra' and v_kept.version = 6,
		'4: a conversation on GPT-6.1 Sol moves to GPT-6.2 Sol with its effort, its version moved on; a GPT-6 Astra pick stays: '
		|| to_jsonb(v_moved)::text || to_jsonb(v_kept)::text);
	perform pg_temp.base_assert(pg_temp.sx_staff(v_bob) = 'gpt-6.2-sol/gpt-6.2-sol'
		and pg_temp.sx_staff(v_carol) = 'gpt-6-astra/gpt-6-astra' and pg_temp.sx_staff(v_alice) = 'gpt-6.2-sol/gpt-6.2-sol',
		'4: an agent with no model in its agent.md moves to GPT-6.2 Sol with its mapping; one that names GPT-6 Astra keeps it: '
		|| pg_temp.sx_staff(v_bob) || ' ' || pg_temp.sx_staff(v_carol));
end $$;
rollback to savepoint sx_move;

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_get_session_model(uuid)',
		'public.qorpera_set_session_model(uuid,text,bigint,text)',
		'public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'] loop
		perform pg_temp.base_assert(strpos(pg_get_functiondef(v_function::regprocedure), 'gpt-6.2-sol') > 0
			and strpos(pg_get_functiondef(v_function::regprocedure), 'gpt-6.1-sol') = 0, '5: ' || v_function || ' names GPT-6.2 Sol only');
	end loop;
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure),
		'gpt-6-astra') = 0, '5: the agent index has no GPT-6 Astra default left');
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_get_session_model(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_set_session_model(uuid,text,bigint,text)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_set_session_model(uuid,text,bigint,text)', 'execute')
		and not has_function_privilege('authenticated',
			'public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)', 'execute'),
		'5: the grants are unchanged');
end $$;

rollback;
