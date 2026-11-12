-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Core work runs deep (20260930532000; contract 17, the 2026-10-22 amendment). Under a runtime bundle whose model policy
-- declares `unattended` (the runtime declares high), a run no member waits on runs at that effort, or at the effort of
-- its agent's agent.md: a hire's first run, a coworker's message, a worker's own run, a member's finished task. Work
-- that carries on a chain keeps the effort the chain's first run was pinned with. A member's turn keeps its
-- conversation's Model menu effort and a routine its own. Under a bundle without `unattended` nothing changes (also 423).
-- The runs come from hires, posts, coworker messages and routine files through the folder materializer; the carry-on
-- kinds are a real coworker wake with its kind and origin rewritten, read by the resolver the pin trigger calls.
reset role;

-- The active bundle with its model policy's `unattended` set to an effort, or left out (null), as the bundle's next
-- version, activated as a release would; answers its hash. The tests hold whether or not the active bundle declares it.
create function pg_temp.ce_activate(p_unattended text) returns text language plpgsql as $$
declare v_active public.qorpera_runtime_bundles; v_manifest jsonb; v_bundle public.qorpera_runtime_bundles;
begin
	select b.* into strict v_active from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
	v_manifest := case when p_unattended is null then v_active.manifest #- '{modelPolicy,unattended}'
		else jsonb_set(v_active.manifest, '{modelPolicy,unattended}', to_jsonb(p_unattended)) end;
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
	return v_bundle.sha256;
end $$;

-- The active bundle with `unattended: high` in its model policy.
select set_config('qorpera_test.ce_new', pg_temp.ce_activate('high'), true) \g /dev/null
select pg_temp.base_claims('service_role');

create function pg_temp.ce_run(p_run uuid) returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = p_run
$$;
create function pg_temp.ce_wake_run(p_wake uuid) returns uuid language sql as $$
	select run_id from public.qorpera_wake_occurrences where id = p_wake
$$;
-- The run of an agent's in a pass's runs.
create function pg_temp.ce_pass_run(p_pass jsonb, p_staff uuid) returns uuid language sql as $$
	select run.id from public.qorpera_execution_runs run
	where run.id in (select value::uuid from jsonb_array_elements_text(p_pass -> 'run_ids')) and run.staff_agent_id = p_staff
$$;
-- A bundle made here, as a run of it reads it (no run is inserted).
create function pg_temp.ce_bundle(p_key text, p_manifest jsonb) returns jsonb language plpgsql as $$
declare v_sha256 text := encode(extensions.digest(convert_to(p_manifest::text, 'utf8'), 'sha256'), 'hex'); v_id uuid;
begin
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-789-' || p_key, 1, p_manifest, v_sha256) returning id into v_id;
	return jsonb_build_object('runtime_bundle_id', v_id, 'runtime_bundle_sha256', v_sha256);
end $$;
-- An agent.md with an effort (none when null), as the TS parser sends it: a new agent's folder, or a save over the
-- version read.
create function pg_temp.ce_agent_text(p_id uuid, p_name text, p_effort text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Research\nkind: agent\nstatus: active\n%s---\nRead and change the company folder.\n',
		p_id, p_name, coalesce('effort: ' || p_effort || E'\n', ''))
$$;
create function pg_temp.ce_agent_parse(p_id uuid, p_name text, p_effort text) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'agent', 'id', p_id, 'name', p_name, 'role', 'Research', 'agentKind', 'agent',
		'status', 'active', 'colour', null, 'figure', null, 'model', null, 'effort', p_effort,
		'instructions', 'Read and change the company folder.')
$$;
create function pg_temp.ce_hire(p_handle text, p_id uuid, p_name text, p_effort text) returns jsonb language sql as $$
	select jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path', 'agent.md', 'kind', 'file',
				'file', pg_temp.base_stage(pg_temp.ce_agent_text(p_id, p_name, p_effort))),
			jsonb_build_object('path', 'memory', 'kind', 'folder'), jsonb_build_object('path', 'routines', 'kind', 'folder'),
			jsonb_build_object('path', 'todos', 'kind', 'folder')),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/' || p_handle || '/agent.md', 'kind', 'agent',
			'text', pg_temp.ce_agent_text(p_id, p_name, p_effort), 'parserVersion', 1,
			'parse', pg_temp.ce_agent_parse(p_id, p_name, p_effort))))
$$;
create function pg_temp.ce_effort_edit(p_handle text, p_id uuid, p_name text, p_effort text) returns jsonb language sql as $$
	select pg_temp.base_write('QorperaOS/agents/' || p_handle || '/agent.md', 'agent', pg_temp.ce_agent_text(p_id, p_name, p_effort),
		pg_temp.ce_agent_parse(p_id, p_name, p_effort), pg_temp.base_version('QorperaOS/agents/' || p_handle || '/agent.md'))
$$;
-- A member's choice of effort for an agent's thread, in its Model menu.
create function pg_temp.ce_choose(p_staff uuid, p_effort text) returns void language sql as $$
	insert into public.qorpera_session_models(session_id, reasoning_effort, version, updated_by_user_id)
	select room.session_id, p_effort, 1, '92400000-0000-4000-8000-000000000001' from public.qorpera_company_rooms room
	where room.id = pg_temp.base_thread(p_staff)
$$;
-- Bob's delivery of the owner's post, started and acknowledged: its binding. The queue holds no other run.
create function pg_temp.ce_bob(p_key text) returns jsonb language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Hand Carol the note.');
	v_pass jsonb := pg_temp.base_materialize(); v_run uuid := pg_temp.ce_wake_run((v_wakes ->> 0)::uuid); v_binding jsonb;
begin
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'Bob''s delivery: ' || v_pass::text);
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.base_public_send(v_binding, 'progress', p_key || '-ack');
	return v_binding;
end $$;
-- A coworker message from a started run to Carol: Carol's run, made by the materializer.
create function pg_temp.ce_message(p_from jsonb, p_key text) returns uuid language plpgsql as $$
declare v_message jsonb := public.qorpera_send_coworker_message(p_from, '92400000-0000-4000-8000-000000000032', p_key,
	'Examine this note.');
begin
	perform pg_temp.base_materialize();
	return pg_temp.ce_wake_run((v_message ->> 'occurrenceId')::uuid);
end $$;
-- A routine file with an effort, as the TS parser sends it.
create function pg_temp.ce_routine(p_path text, p_id uuid, p_effort text) returns jsonb language sql as $$
	select pg_temp.base_write(p_path, 'routine', E'---\n' || r::text || E'\n---\n', r, pg_temp.base_version(p_path))
	from (select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Tick', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 5, 'starts', null), 'timezone', null, 'ends', null,
		'runs', null, 'quiet', null, 'effort', p_effort, 'reply', 'optional', 'conclusion', null,
		'instructions', 'Examine the authorized change.') as r) as parsed
$$;
-- The scheduler offers a routine's slot at its current version's position (as 924's wb_slot); answers the occurrence.
create function pg_temp.ce_slot(p_routine uuid, p_key text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_at timestamptz := statement_timestamp() - interval '5 minutes';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	select c.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version where r.id = p_routine;
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, v_id, p_key, v_cursor.trigger_id,
		v_at, v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
	return v_id;
end $$;
-- The effort the resolver gives a run whose wake is rewritten to a carry-on kind and origin (triggers off for the
-- rewrite, as 678 builds its chains), under the run's own bundle.
create function pg_temp.ce_carried(p_run uuid, p_source text, p_origin uuid) returns text language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = p_source, origin_run_id = p_origin where run_id = p_run;
	set local session_replication_role = origin;
	return public.qorpera_resolve_run_reasoning_effort(run, bundle.manifest)
	from public.qorpera_execution_runs run join public.qorpera_runtime_bundles bundle on bundle.id = run.runtime_bundle_id
	where run.id = p_run;
end $$;

-- 1. The policy: a bundle's model policy may name `unattended` as low, medium or high, or leave it out; any other value
--    or type is refused like any other unknown policy (42501). The allowed efforts include it.
do $$
declare v_active jsonb := (select b.manifest from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton);
	v_case record; v_run jsonb; v_cases integer := 0;
begin
	perform pg_temp.base_assert(v_active #>> '{modelPolicy,unattended}' = 'high' and v_active #>> '{modelPolicy,effort}' = 'low',
		'fixture: the active bundle runs unattended work at high, the rest at low');
	for v_case in select * from (values ('low', '"low"'::jsonb, true), ('medium', '"medium"', true), ('high', '"high"', true),
		('absent', null, true), ('max', '"max"', false), ('empty', '""', false), ('json-null', 'null', false),
		('number', '1', false), ('array', '["high"]', false)) as c(name, value, valid) loop
		v_run := pg_temp.ce_bundle(v_case.name, case when v_case.name = 'absent' then v_active #- '{modelPolicy,unattended}'
			else jsonb_set(v_active, '{modelPolicy,unattended}', v_case.value) end);
		if v_case.valid then
			perform public.qorpera_execution_runtime_manifest(jsonb_populate_record(null::public.qorpera_execution_runs, v_run));
		else
			perform pg_temp.base_error(format('select public.qorpera_execution_runtime_manifest(jsonb_populate_record('
				'null::public.qorpera_execution_runs, %L::jsonb))', v_run), '42501', 'Run requires an executable runtime bundle');
		end if;
		v_cases := v_cases + 1;
	end loop;
	perform pg_temp.base_assert(v_cases = 9, 'every policy case ran');
	-- True or false, never null: the checks that use it read `not allowed`.
	perform pg_temp.base_assert(public.qorpera_manifest_allows_reasoning_effort(
			'{"modelPolicy":{"effort":"low","overrides":"none","unattended":"high"}}', 'high') is true
		and public.qorpera_manifest_allows_reasoning_effort(
			'{"modelPolicy":{"effort":"low","overrides":"none","unattended":"high"}}', 'medium') is false
		and public.qorpera_manifest_allows_reasoning_effort('{"modelPolicy":{"effort":"low","overrides":"none"}}', 'high') is false
		and public.qorpera_manifest_allows_reasoning_effort('{"modelPolicy":{"effort":"low","overrides":"none"}}', 'low') is true
		and public.qorpera_manifest_allows_reasoning_effort(v_active, 'high') is true
		and public.qorpera_manifest_allows_reasoning_effort(v_active, null) is false, 'the allowed efforts include unattended');
	perform pg_temp.base_assert(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) role
			where has_function_privilege(role, 'public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)',
				'execute')), 'no API role can call the resolver');
end
$$;

-- 2. A member's turn keeps its conversation's effort and its fast tier: the owner's posts in Bob's thread, where they
--    chose medium, and in Carol's, where nobody chose, run at medium and at the default, low.
savepoint ce_member;
do $$
declare v_pass jsonb; v_bob public.qorpera_execution_runs; v_carol public.qorpera_execution_runs;
begin
	perform pg_temp.ce_choose('92400000-0000-4000-8000-000000000031', 'medium');
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Look at the numbers.');
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032', 'Look at the plan.');
	v_pass := pg_temp.base_materialize();
	v_bob := pg_temp.ce_run(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000031'));
	v_carol := pg_temp.ce_run(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000032'));
	perform pg_temp.base_assert(v_bob.source_kind = 'room_delivery' and v_carol.source_kind = 'room_delivery'
		and v_bob.runtime_bundle_sha256 = current_setting('qorpera_test.ce_new')
		and v_carol.runtime_bundle_sha256 = current_setting('qorpera_test.ce_new'), 'the posts run on the new bundle: ' || v_pass::text);
	perform pg_temp.base_assert(v_bob.reasoning_effort = 'medium' and v_bob.service_tier = 'fast',
		'Bob''s turn keeps the thread''s choice: ' || to_jsonb(v_bob)::text);
	perform pg_temp.base_assert(v_carol.reasoning_effort = 'low' and v_carol.service_tier = 'fast',
		'Carol''s turn runs at the default: ' || to_jsonb(v_carol)::text);
end
$$;
rollback to ce_member;

-- 3. A first run runs high, or at its agent.md's effort: the owner hires Dana (no effort) and Erin (effort: medium); the
--    follow-up queue queues their kickoffs and one pass makes them runs. An effort chosen in another thread does not
--    carry over; the tier is unchanged. The runner's authority reads the pin, with the hash of the policy that names it.
savepoint ce_first_run;
select pg_temp.ce_choose('92400000-0000-4000-8000-000000000030', 'low') \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'core-effort-hires', jsonb_build_array(
	pg_temp.ce_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana', null),
	pg_temp.ce_hire('erin', '92400000-0000-4000-8000-000000000035', 'Erin', 'medium'))) \g /dev/null
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_dana public.qorpera_execution_runs; v_erin public.qorpera_execution_runs;
	v_binding jsonb; v_identity jsonb; v_policy text;
begin
	v_dana := pg_temp.ce_run(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000034'));
	v_erin := pg_temp.ce_run(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000035'));
	perform pg_temp.base_assert(v_dana.id is not null and v_erin.id is not null
		and (select wake_kind from public.qorpera_wake_occurrences where run_id = v_dana.id) = 'first-run'
		and (select wake_kind from public.qorpera_wake_occurrences where run_id = v_erin.id) = 'first-run'
		and v_dana.source_kind = 'session_turn' and v_dana.runtime_bundle_sha256 = current_setting('qorpera_test.ce_new'),
		'the kickoffs are first runs on the new bundle: ' || v_pass::text);
	perform pg_temp.base_assert(v_dana.reasoning_effort = 'high' and v_dana.service_tier = 'fast',
		'Dana''s first run runs high: ' || to_jsonb(v_dana)::text);
	perform pg_temp.base_assert(v_erin.reasoning_effort = 'medium', 'Erin''s first run takes her agent.md''s effort: '
		|| to_jsonb(v_erin)::text);
	v_policy := encode(extensions.digest(convert_to((select manifest -> 'modelPolicy' from public.qorpera_runtime_bundles
		where id = v_dana.runtime_bundle_id)::text, 'utf8'), 'sha256'), 'hex');
	perform pg_temp.base_assert(v_dana.reasoning_policy_sha256 = v_policy and v_erin.reasoning_policy_sha256 = v_policy,
		'the runs pin the hash of the policy that names unattended');
	v_binding := pg_temp.base_start(null);
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform pg_temp.base_assert(v_identity ->> 'reasoningEffort' = (pg_temp.ce_run((v_binding ->> 'runId')::uuid)).reasoning_effort
		and v_identity ->> 'reasoningEffort' in ('high', 'medium') and v_identity ->> 'reasoningPolicySha256' = v_policy,
		'the runner reads the pin: ' || v_identity::text);
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set reasoning_effort = %L where id = %L', 'low',
		v_dana.id), '42501', 'Execution reasoning policy is immutable');
end
$$;
rollback to ce_first_run;

-- 4. A coworker's message runs high, or at the recipient's agent.md effort once the owner sets one: Bob's delivery hands
--    Carol a note, before and after Carol's agent.md says `effort: medium`. Bob's own turn keeps the default.
savepoint ce_coworker;
do $$
declare v_bob jsonb := pg_temp.ce_bob('core-effort-coworker'); v_carol public.qorpera_execution_runs;
begin
	perform pg_temp.base_assert((pg_temp.ce_run((v_bob ->> 'runId')::uuid)).reasoning_effort = 'low', 'Bob''s turn runs at the default');
	v_carol := pg_temp.ce_run(pg_temp.ce_message(v_bob, 'core-effort-note'));
	perform pg_temp.base_assert(v_carol.source_kind = 'wake' and v_carol.reasoning_effort = 'high'
		and v_carol.service_tier = 'standard' and (select source_kind from public.qorpera_wake_occurrences
			where run_id = v_carol.id) = 'coworker', 'Carol''s coworker run runs high: ' || to_jsonb(v_carol)::text);
end
$$;
rollback to ce_coworker;
savepoint ce_coworker_agent;
select pg_temp.base_commit(pg_temp.base_owner(), 'core-effort-carol-medium', jsonb_build_array(
	pg_temp.ce_effort_edit('carol', '92400000-0000-4000-8000-000000000032', 'Carol', 'medium'))) \g /dev/null
do $$
declare v_carol public.qorpera_execution_runs := pg_temp.ce_run(pg_temp.ce_message(pg_temp.ce_bob('core-effort-agent'),
	'core-effort-agent-note'));
begin
	perform pg_temp.base_assert(v_carol.reasoning_effort = 'medium', 'Carol''s coworker run takes her agent.md''s effort: '
		|| to_jsonb(v_carol)::text);
end
$$;
rollback to ce_coworker_agent;

-- 5. A routine keeps its own effort, over the agent.md's and the policy's: Carol's routine with `effort: low`, while her
--    agent.md says high.
savepoint ce_routine;
select pg_temp.base_commit(pg_temp.base_owner(), 'core-effort-routine', jsonb_build_array(
	pg_temp.ce_effort_edit('carol', '92400000-0000-4000-8000-000000000032', 'Carol', 'high'),
	pg_temp.ce_routine('QorperaOS/agents/carol/routines/tick.md', '92400000-0000-4000-8000-0000000000e9', 'low'))) \g /dev/null
do $$
declare v_wake uuid := pg_temp.ce_slot('92400000-0000-4000-8000-0000000000e9', 'core-effort-tick');
	v_pass jsonb := pg_temp.base_materialize(); v_run public.qorpera_execution_runs := pg_temp.ce_run(pg_temp.ce_wake_run(v_wake));
begin
	perform pg_temp.base_assert(v_run.id is not null and v_pass -> 'run_ids' ? v_run.id::text, 'the slot is a run: ' || v_pass::text);
	perform pg_temp.base_assert(v_run.reasoning_effort = 'low' and v_run.runtime_bundle_sha256 = current_setting('qorpera_test.ce_new'),
		'the routine keeps its effort: ' || to_jsonb(v_run)::text);
end
$$;
rollback to ce_routine;

-- 6. Work that carries on a chain a wake started keeps the effort its first run was pinned with; work that carries on
--    a member's chat (20260930661000), a worker's own run, a member's finished task and a chain whose first run is
--    unknown or another agent's take the agent.md's effort, else high.
--    Carol's coworker run (from Bob's delivery) has its wake rewritten to each kind; her member turn, at the medium
--    the owner chose in her thread, is the origin, and runs after the coworker run's job ends.
savepoint ce_carried;
do $$
declare v_bob jsonb := pg_temp.ce_bob('core-effort-carried'); v_coworker uuid := pg_temp.ce_message(v_bob, 'core-effort-carried-note');
	v_member uuid; v_pass jsonb; v_kind text;
begin
	perform pg_temp.ce_choose('92400000-0000-4000-8000-000000000032', 'medium');
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032', 'Draft the offer.');
	-- A conversation runs one run at a time (20260930538000): the member's turn waits while Carol's coworker run is live
	-- in her thread, and runs once that run's job ends (the resolver below reads the ended run as it was pinned).
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000032') is null,
		'fixture: Carol''s member turn waits for her coworker run: ' || v_pass::text);
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: Carol''s coworker run ends'
	where run_id = v_coworker;
	v_pass := pg_temp.base_materialize();
	v_member := pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000032');
	perform pg_temp.base_assert((pg_temp.ce_run(v_member)).reasoning_effort = 'medium'
		and (pg_temp.ce_run(v_coworker)).reasoning_effort = 'high', 'fixture: Carol''s member turn at medium, her coworker run high: '
		|| v_pass::text);
	foreach v_kind in array array['worker-completion', 'machine-event', 'machine-checkin', 'office-activation'] loop
		perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, v_kind, v_member) = 'high',
			'a ' || v_kind || ' wake after a member''s chat runs high, not at the chat''s medium');
		perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, v_kind, v_coworker) = 'high',
			'a ' || v_kind || ' wake keeps the effort of a chain a wake started');
		perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, v_kind, null) = 'high',
			'a ' || v_kind || ' wake with no origin runs high');
		perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, v_kind, (v_bob ->> 'runId')::uuid) = 'high',
			'another agent''s run is no origin of Carol''s ' || v_kind);
	end loop;
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'worker-dispatch', v_member) = 'high',
		'a worker''s own run runs high');
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'human-task', null) = 'high', 'a member''s finished task runs high');
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'coworker', null) = 'high', 'the coworker wake again: high');
	-- A chain a wake started keeps whatever its first run was pinned with; a chat's low never carries on.
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set reasoning_effort = 'low' where id = v_member;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'worker-completion', v_member) = 'high',
		'a chat at low does not carry low into the agent''s own work');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set reasoning_effort = 'low' where id = v_coworker;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'worker-completion', v_coworker) = 'low',
		'a chain a wake started at low stays low');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set reasoning_effort = 'high' where id = v_coworker;
	set local session_replication_role = origin;
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set reasoning_effort = 'medium' where id = v_member;
	set local session_replication_role = origin;
	perform pg_temp.base_commit(pg_temp.base_owner(), 'core-effort-carol-low', jsonb_build_array(
		pg_temp.ce_effort_edit('carol', '92400000-0000-4000-8000-000000000032', 'Carol', 'low')));
	perform pg_temp.base_assert(pg_temp.ce_carried(v_coworker, 'worker-dispatch', v_member) = 'low'
		and pg_temp.ce_carried(v_coworker, 'machine-event', null) = 'low'
		and pg_temp.ce_carried(v_coworker, 'worker-completion', v_member) = 'low'
		and pg_temp.ce_carried(v_coworker, 'worker-completion', v_coworker) = 'high',
		'the agent.md''s effort sets a worker''s own run, an unknown chain and work after a chat, not a chain a wake started');
end
$$;
rollback to ce_carried;

-- 7. Under a bundle without `unattended` nothing changes: a first run and a coworker's message run at the default, low.
--    The bundle is the active one less that key, so the section holds whatever the database's bundle declares.
savepoint ce_none_bundle;
select set_config('qorpera_test.ce_none', pg_temp.ce_activate(null), true) \g /dev/null
do $$
declare v_bob jsonb; v_carol public.qorpera_execution_runs;
begin
	perform pg_temp.base_assert((select b.sha256 = current_setting('qorpera_test.ce_none')
			and not (b.manifest -> 'modelPolicy' ? 'unattended') and b.manifest #>> '{modelPolicy,effort}' = 'low'
		from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
		where a.singleton), 'fixture: the active bundle declares no unattended and runs the rest at low');
	v_bob := pg_temp.ce_bob('core-effort-old');
	v_carol := pg_temp.ce_run(pg_temp.ce_message(v_bob, 'core-effort-old-note'));
	perform pg_temp.base_assert(v_carol.reasoning_effort = 'low' and v_carol.runtime_bundle_sha256 = current_setting('qorpera_test.ce_none'),
		'a coworker run under a bundle without unattended runs low: ' || to_jsonb(v_carol)::text);
end
$$;
select pg_temp.base_commit(pg_temp.base_owner(), 'core-effort-old-hire', jsonb_build_array(
	pg_temp.ce_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana', 'high'))) \g /dev/null
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_dana public.qorpera_execution_runs;
begin
	v_dana := pg_temp.ce_run(pg_temp.ce_pass_run(v_pass, '92400000-0000-4000-8000-000000000034'));
	perform pg_temp.base_assert(v_dana.reasoning_effort = 'low' and v_dana.runtime_bundle_sha256 = current_setting('qorpera_test.ce_none'),
		'a first run under a bundle without unattended runs low, whatever its agent.md says: ' || to_jsonb(v_dana)::text);
end
$$;
rollback to ce_none_bundle;

rollback;
