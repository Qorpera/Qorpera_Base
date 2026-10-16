-- @fixture 842_folder_state_worker_drain.test.sql until "-- 3. A new run's workers: a stopped parent cancels its worker, a cancelled todo its own; a refused start fails ----------"
-- The review origin (20260930497000, finding 881f1f21): a wake of the agent's own chain (a worker's report, the
-- worker's own run, a machine event or check-in, an office start) records the run whose request started the chain, and
-- the action review reads that run's request. 842's fixture leaves the drain's real wakes for Ada's two workers.

-- A run of Ada's chain, its wake written with triggers off (pg_temp.run), then given the trigger's own origin.
create function pg_temp.child(p_parent jsonb, p_source text, p_staff uuid default '84000000-0000-4000-8000-0000000000e1',
	p_requester uuid default '63400000-0000-4000-8000-000000000002') returns jsonb language plpgsql as $$
declare v jsonb := pg_temp.run(p_staff, 'agent', p_requester, p_source, p_parent, extensions.gen_random_uuid());
begin
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences w set origin_run_id = public.qorpera_wake_origin(w)
		where run_id = %L', v ->> 'runId'));
	return v;
end $$;
create function pg_temp.origin(p jsonb) returns uuid language sql as $$
	select origin_run_id from public.qorpera_wake_occurrences where run_id = (p ->> 'runId')::uuid
$$;
create function pg_temp.review(p jsonb) returns jsonb language sql as $$
	select public.qorpera_run_review_origin(run) from public.qorpera_execution_runs run where id = (p ->> 'runId')::uuid
$$;
-- A run Ada's routine woke, with that routine's intent.
create function pg_temp.routine_run(p_member jsonb, p_prompt text) returns jsonb language plpgsql as $$
declare v jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'agent', '63400000-0000-4000-8000-000000000002',
		'schedule', p_member);
	v_routine uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin)
	values (v_routine, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), 1, 'active', '63400000-0000-4000-8000-000000000002', 'member');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values (v_routine, 1, extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000020', '84000000-0000-4000-8000-0000000000e1', 'Prices', p_prompt,
		'[{"id":"t1","kind":"once","at":"2026-10-01T09:00:00Z","timeZone":"UTC"}]', 'medium',
		'63400000-0000-4000-8000-0000000000b1', 1, repeat('e', 64), '63400000-0000-4000-8000-000000000002');
	update public.qorpera_wake_occurrences set wake_kind = 'routine', trigger_id = 't1', routine_id = v_routine,
		routine_version = 1, parent_run_id = null
	where run_id = (v ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v;
end $$;

-- The checks start here: a test that runs after this file's fixture part stops at this line.

-- 1. The drain's real wakes carry Ada's run as their origin, and no one can change it ----------------------------------
do $$
declare ada uuid := (current_setting('qorpera_test.ada')::jsonb -> 'actor' ->> 'runId')::uuid;
	price constant uuid := '84000000-0000-4000-8000-000000000101'; extra constant uuid := '84000000-0000-4000-8000-000000000104';
	o public.qorpera_wake_occurrences;
begin
	-- Extra's start (price's was replaced by 842's hand-built run) and both workers' reports.
	foreach o in array array[pg_temp.wake((pg_temp.w(extra)).occurrence_id),
		pg_temp.wake((pg_temp.w(price)).completion_occurrence_id), pg_temp.wake((pg_temp.w(extra)).completion_occurrence_id)] loop
		if o.id is null or o.source_kind not in ('worker-dispatch','worker-completion') or o.parent_run_id is distinct from ada
			or o.origin_run_id is distinct from ada then
			raise exception 'A worker''s real wake carries its parent''s run as its origin: %', to_jsonb(o); end if;
	end loop;
	perform pg_temp.raises_like(format('update public.qorpera_wake_occurrences set origin_run_id = %L where id = %L',
		extensions.gen_random_uuid(), (pg_temp.w(extra)).occurrence_id), '42501', '%immutable%');
	perform pg_temp.raises_like(format('update public.qorpera_wake_occurrences set origin_run_id = null where id = %L',
		(pg_temp.w(extra)).occurrence_id), '42501', '%immutable%');
end $$;

-- 2. Each of the five kinds carries the chain's first run; a coworker, another agent or requester and an older chain none
do $$
declare m jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	c jsonb; k text;
begin
	c := pg_temp.child(m, 'worker-completion');
	if pg_temp.origin(c) is distinct from (m ->> 'runId')::uuid then
		raise exception 'A report to a member''s run: %', pg_temp.origin(c); end if;
	foreach k in array array['worker-completion','worker-dispatch','machine-event','machine-checkin','office-activation'] loop
		if pg_temp.origin(pg_temp.child(m, k)) is distinct from (m ->> 'runId')::uuid
			or pg_temp.origin(pg_temp.child(c, k)) is distinct from (m ->> 'runId')::uuid then
			raise exception 'A % wake carries the chain''s first run', k; end if;
	end loop;
	-- A coworker's wake is another agent's request, never this agent's own work.
	if pg_temp.origin(pg_temp.child(m, 'coworker')) is not null or pg_temp.origin(pg_temp.child(m, 'event')) is not null then
		raise exception 'A coworker or event wake has no origin'; end if;
	-- Another agent's or another requester's run is not this chain's.
	if pg_temp.origin(pg_temp.child(m, 'worker-completion', '84000000-0000-4000-8000-0000000000e2')) is not null
		or pg_temp.origin(pg_temp.child(m, 'machine-event', p_requester => '63400000-0000-4000-8000-000000000001')) is not null then
		raise exception 'Another agent''s or requester''s run is no origin'; end if;
	-- A chain whose wake has no origin (written before 20260930497000) stays without one.
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set origin_run_id = null where run_id = %L', c ->> 'runId'));
	if pg_temp.origin(pg_temp.child(c, 'machine-event')) is not null then raise exception 'An older chain has no origin'; end if;
end $$;

-- 3. The review reads the origin's request: its member input or routine, never a coworker's message; none without one
do $$
declare m jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	routine jsonb := pg_temp.routine_run(m, 'Keep the price list current.');
	coworker jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'agent', '63400000-0000-4000-8000-000000000002',
		'coworker', m);
	refused jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	silent jsonb := pg_temp.child(m, 'event'); r jsonb; k text;
begin
	perform pg_temp.fx(format($q$update public.qorpera_session_inputs set body = '{"text":"Send the offer to Nora."}'
		where id = (select input_ids[1] from public.qorpera_execution_runs where id = %L)$q$, m ->> 'runId'));
	-- A worker's own run and a machine event (8c's #1242 reviews machine_run) read the member's request like the rest.
	foreach k in array array['worker-completion','worker-dispatch','machine-event','machine-checkin','office-activation'] loop
		r := pg_temp.review(pg_temp.child(pg_temp.child(m, 'worker-dispatch'), k));
		if r ->> 'runId' is distinct from m ->> 'runId' or jsonb_array_length(r -> 'inputs') <> 1
			or r -> 'inputs' -> 0 ->> 'kind' is distinct from 'current_human_request'
			or r -> 'inputs' -> 0 ->> 'authorUserId' is distinct from '63400000-0000-4000-8000-000000000002'
			or r -> 'inputs' -> 0 -> 'content' ->> 'text' is distinct from 'Send the offer to Nora.'
			or (r -> 'inputs' -> 0 -> 'content' ->> 'offset')::integer <> 0
			or r -> 'routineIntent' <> 'null'::jsonb
			or (select array_agg(key order by key) from jsonb_object_keys(r) key) <> array['inputs','routineIntent','runId'] then
			raise exception 'A % run reads the member''s request: %', k, r; end if;
	end loop;
	r := pg_temp.review(pg_temp.child(routine, 'worker-completion'));
	if r ->> 'runId' is distinct from routine ->> 'runId' or r -> 'inputs' <> '[]'::jsonb
		or r ->> 'routineIntent' is distinct from 'Keep the price list current.' then
		raise exception 'A routine''s chain reads its intent: %', r; end if;
	-- A coworker's message is another agent's words, never the request (contract 9.2): a chain it started has none.
	perform pg_temp.fx(format($q$update public.qorpera_wake_occurrences set payload = jsonb_build_object('text',
		'Check the invoices.', 'senderStaffId', '84000000-0000-4000-8000-0000000000e2') where run_id = %L$q$, coworker ->> 'runId'));
	if pg_temp.origin(pg_temp.child(coworker, 'machine-event')) is distinct from (coworker ->> 'runId')::uuid
		or pg_temp.review(pg_temp.child(coworker, 'machine-event')) is not null then
		raise exception 'A coworker''s chain reads no request: %', pg_temp.review(pg_temp.child(coworker, 'machine-event')); end if;
	-- No origin, an origin with no request, and a source the context refuses (42501) read as none.
	perform pg_temp.fx(format($q$update public.qorpera_session_inputs set runtime_bundle_sha256 = repeat('f', 64)
		where id = (select input_ids[1] from public.qorpera_execution_runs where id = %L)$q$, refused ->> 'runId'));
	if pg_temp.review(m) is not null or pg_temp.review(routine) is not null
		or pg_temp.review(pg_temp.child(silent, 'worker-completion')) is not null
		or pg_temp.review(pg_temp.child(refused, 'worker-completion')) is not null then
		raise exception 'No origin request reads as none'; end if;
	-- The API roles cannot call the functions.
	if exists (select 1 from unnest(array['qorpera_wake_origin(public.qorpera_wake_occurrences)',
			'qorpera_set_wake_origin()', 'qorpera_run_review_origin(public.qorpera_execution_runs)']) f,
			unnest(array['anon','authenticated','service_role']) role
		where has_function_privilege(role, 'public.' || f, 'execute')) then
		raise exception 'An API role can call an origin function'; end if;
end $$;

-- 4. Describe gives a worker's run its origin, exactly as the review reads it; the member's own run has none ----------
select set_config('qorpera_test.ada5', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false) \g /dev/null
do $$
declare ada jsonb := current_setting('qorpera_test.ada5')::jsonb; w constant uuid := '84000000-0000-4000-8000-000000000116';
	x jsonb; r jsonb; v_bundle public.qorpera_active_runtime_bundle%rowtype; v_manifest jsonb;
begin
	perform pg_temp.dispatch(ada, 'agents/ada/todos/plan-the-trip/origin', w, 'origin-dispatch-0001');
	perform pg_temp.drain();
	if (pg_temp.wake((pg_temp.w(w)).occurrence_id)).origin_run_id is distinct from (ada -> 'actor' ->> 'runId')::uuid then
		raise exception 'Fixture: the drain starts the worker with Ada''s run as its origin'; end if;
	-- The worker's run, as the materializer makes it from the wake (here with triggers off), with the trigger's origin.
	x := pg_temp.worker_run(ada, w);
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences w set origin_run_id = public.qorpera_wake_origin(w)
		where run_id = %L', x -> 'actor' ->> 'runId'));
	-- Both runs carry the active runtime bundle, whose model policy the context checks (as 647 §8 sets it up), and the
	-- company has its folder index.
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	select manifest into strict v_manifest from public.qorpera_runtime_bundles
	where id = v_bundle.runtime_bundle_id and sha256 = v_bundle.runtime_bundle_sha256;
	perform pg_temp.fx(format('update public.qorpera_execution_runs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L,
		reasoning_effort = %L, reasoning_policy_sha256 = %L, service_tier = ''standard'' where id in (%L, %L)',
		v_bundle.runtime_bundle_id, v_bundle.runtime_bundle_sha256, v_manifest #>> '{modelPolicy,effort}',
		encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'),
		ada -> 'actor' ->> 'runId', x -> 'actor' ->> 'runId'));
	perform pg_temp.fx(format($q$update public.qorpera_session_inputs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L,
		body = '{"text":"Send the offer to Nora."}' where execution_run_id = %L$q$, v_bundle.runtime_bundle_id,
		v_bundle.runtime_bundle_sha256, ada -> 'actor' ->> 'runId'));
	perform pg_temp.fx(format('insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version,
		vision_seeded, commit_id) select %L, %L, %L, %L, true, %L where not exists (select 1 from public.qorpera_folder_company_index
		where environment_id = %L)', '63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', 'Nordlys',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000020'));
	r := public.qorpera_describe_company_run_context(x -> 'binding');
	if r -> 'origin' is null or r -> 'origin' is distinct from pg_temp.review(x -> 'actor')
		or r -> 'origin' ->> 'runId' is distinct from ada -> 'actor' ->> 'runId'
		or r -> 'origin' -> 'inputs' -> 0 -> 'content' ->> 'text' is distinct from 'Send the offer to Nora.' then
		raise exception 'Describe gives a worker''s run its origin: %', r -> 'origin'; end if;
	if public.qorpera_describe_company_run_context(ada -> 'binding') ? 'origin' then
		raise exception 'The member''s own run has no origin'; end if;
end $$;
