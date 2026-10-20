-- @fixture 842_folder_state_worker_drain.test.sql until "-- 3. A new run's workers: a stopped parent cancels its worker, a cancelled todo its own; a refused start fails ----------"
-- The review origin (20260930497000, finding 881f1f21): a wake of the agent's own chain (a worker's report, the
-- worker's own run, a machine event or check-in, an office start) records the run whose request started the chain, and
-- the action review reads that run's request. So does the run a member's approval of the agent's card woke in its
-- thread (20260930518000, C6-8b): it records the card's run, or that run's own origin (§5). 842's fixture leaves the
-- drain's real wakes for Ada's two workers.

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

-- 5. A member's approval of Ada's card wakes a run that carries on the card's run (20260930518000, C6-8b) -------------
-- A card a run of Ada's asked in a conversation, as qorpera_record_action_review raises it (hand-built: 634's runs are
-- not the recorder's).
create function pg_temp.card(p_run jsonb, p_session uuid, p_decision text default 'ask',
	p_staff uuid default '84000000-0000-4000-8000-0000000000e1') returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($q$insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id,
			session_id, requester_user_id, tool_name, effect, argument_sha256, action, decision, built_in, reason, reviewer_model,
			approver_scope, approver_user_id, card_session_id)
		values (%L, '63400000-0000-4000-8000-000000000010', %L, %L, %L, %L, '63400000-0000-4000-8000-000000000002', 'send_email',
			'external', repeat('d', 64), '{}', %L, 'none', 'A mail to a customer.', 'gpt-test', %L,
			'63400000-0000-4000-8000-000000000002', %L)$q$,
		v_id, p_run ->> 'runId', 'call-' || v_id, p_staff, p_session, p_decision,
		case when p_decision = 'ask' then 'member' end, p_session));
	return v_id;
end $$;
-- The answer qorpera_answer_action_review writes for a card.
create function pg_temp.approval(p_card uuid, p_answer text default 'allow_once') returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.interaction-answer/v1', 'interactionId', p_card, 'surface', 'approval',
		'outcome', case when p_answer = 'deny' then 'declined' else 'approved' end, 'answer', jsonb_build_object('answer', p_answer))
$$;
create function pg_temp.thread(p jsonb) returns uuid language sql as $$
	select session_id from public.qorpera_execution_runs where id = (p ->> 'runId')::uuid
$$;
-- A member's run in Ada's thread, made the run an answer woke: its input the answer and its wake the room wake
-- qorpera_answer_action_review writes (triggers off), then the trigger's own origin. Answers that origin.
create function pg_temp.answered(p_run jsonb, p_body jsonb) returns uuid language plpgsql as $$
begin
	perform pg_temp.fx(format($q$update public.qorpera_session_inputs set body = %L
		where id = (select input_ids[1] from public.qorpera_execution_runs where id = %L)$q$, p_body, p_run ->> 'runId'));
	perform pg_temp.fx(format($q$update public.qorpera_wake_occurrences set wake_kind = 'room', source_kind = 'room',
		trigger_id = 'room' where run_id = %L$q$, p_run ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences w set origin_run_id = public.qorpera_wake_origin(w)
		where run_id = %L', p_run ->> 'runId'));
	return pg_temp.origin(p_run);
end $$;

do $$
declare m jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	routine jsonb := pg_temp.routine_run(m, 'Keep the price list current.');
	b jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	b2 jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000002');
	other jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'human', '63400000-0000-4000-8000-000000000004');
	card uuid; r jsonb; body jsonb;
begin
	card := pg_temp.card(routine, pg_temp.thread(b));
	-- Allow once and Always allow: the routine's run, whose intent the review reads (the production run of 20 October).
	if pg_temp.answered(b, pg_temp.approval(card, 'always_allow')) is distinct from (routine ->> 'runId')::uuid
		or pg_temp.answered(b, pg_temp.approval(card)) is distinct from (routine ->> 'runId')::uuid then
		raise exception 'An approval of the card carries the card''s run: %', pg_temp.origin(b); end if;
	r := pg_temp.review(b);
	if r ->> 'runId' is distinct from routine ->> 'runId' or r -> 'inputs' <> '[]'::jsonb
		or r ->> 'routineIntent' is distinct from 'Keep the price list current.' then
		raise exception 'The approved run reads the routine''s intent: %', r; end if;
	-- Set once: no one changes it.
	perform pg_temp.raises_like(format('update public.qorpera_wake_occurrences set origin_run_id = %L where run_id = %L',
		extensions.gen_random_uuid(), b ->> 'runId'), '42501', '%immutable%');
	perform pg_temp.raises_like(format('update public.qorpera_wake_occurrences set origin_run_id = null where run_id = %L',
		b ->> 'runId'), '42501', '%immutable%');
	-- A card the approved run asked in turn carries the same first run; a card a worker's report led to, that chain's.
	if pg_temp.answered(b2, pg_temp.approval(pg_temp.card(b, pg_temp.thread(b2)))) is distinct from (routine ->> 'runId')::uuid
		or pg_temp.review(b2) ->> 'routineIntent' is distinct from 'Keep the price list current.' then
		raise exception 'A second approval in the chain carries its first run: %', pg_temp.review(b2); end if;
	if pg_temp.answered(b2, pg_temp.approval(pg_temp.card(pg_temp.child(m, 'worker-completion'), pg_temp.thread(b2))))
			is distinct from (m ->> 'runId')::uuid then
		raise exception 'A card a worker''s report led to carries the chain''s first run'; end if;

	-- Any other answer or card gives none.
	foreach body in array array[
		-- A post, one shaped like the answer, a Deny, an answer to an ask_member card or to an approval card of the agent's
		-- own (qorpera_answer_interaction's, with no answer), and an id that names no card.
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Allow once.'),
		pg_temp.approval(card) || '{"schema":"qorpera.session-prompt/v1"}',
		pg_temp.approval(card, 'deny'),
		pg_temp.approval(card) || '{"surface":"question","outcome":"answered"}',
		pg_temp.approval(card) || '{"answer":{}}',
		pg_temp.approval(card) || '{"interactionId":"not-a-card"}',
		-- A card that was not asked, one in another conversation, another agent's, and one of another agent's run.
		pg_temp.approval(pg_temp.card(routine, pg_temp.thread(b), 'allow')),
		pg_temp.approval(pg_temp.card(routine, extensions.gen_random_uuid())),
		pg_temp.approval(pg_temp.card(routine, pg_temp.thread(b), p_staff => '84000000-0000-4000-8000-0000000000e2')),
		pg_temp.approval(pg_temp.card(pg_temp.run('84000000-0000-4000-8000-0000000000e2', 'agent',
			'63400000-0000-4000-8000-000000000002', 'schedule', m), pg_temp.thread(b)))] loop
		if pg_temp.answered(b, body) is not null then raise exception 'No origin from %', body; end if;
	end loop;
	-- Another member's approval (an owner or admin answering for the company): the card's run is not their request.
	if pg_temp.answered(other, pg_temp.approval(pg_temp.card(routine, pg_temp.thread(other)))) is not null then
		raise exception 'Another member''s approval carries no origin'; end if;
	-- The answer is the wake's own source, by its requester.
	perform pg_temp.fx(format($q$update public.qorpera_session_inputs set author_user_id = '63400000-0000-4000-8000-000000000004'
		where id = (select input_ids[1] from public.qorpera_execution_runs where id = %L)$q$, b2 ->> 'runId'));
	if pg_temp.answered(b2, pg_temp.approval(pg_temp.card(routine, pg_temp.thread(b2)))) is not null then
		raise exception 'An answer by someone else than the wake''s requester carries no origin'; end if;
end $$;
