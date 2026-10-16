-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- C3a (migration 20260930077000, deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)"): a coding session
-- dispatched on folder-v2, through manage_worker's folder entry (qorpera_folder_worker_commit) with its brief.md. A1's
-- twelve cases from 396 (snapshot-v1, deleted with the old core): the six refusals, in the old worker writer's order
-- and words, as rule refusals that write nothing; the worker, its session, its first turn and event; no wake; a replay;
-- an in-house worker beside it; a second session that queues and is cancelled. Then: a coding follow-up; a coding
-- session's turn claimed, begun, authorized, submitted and completed on folder-v2, its turn's wake carrying the
-- folder-v2 payload, report_work refused to it, and its parent revived by F2's drain once the parent's turn ended, its
-- batch's coding sibling stopped working and the platform wrote that sibling's results.md (C3d), with an in-house
-- sibling's result in the same wake; and
-- the drain stopping an active coding worker whose parent a member stopped. 924's base: Alice's run for the owner, on
-- the owner's own codex-cli login (allowed to work while they are away).

-- The repository the agents may work in, and executor exec-928 (configured in §1).
create function pg_temp.c3_repo() returns jsonb language sql immutable as $$
	select '{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'::jsonb
$$;
-- A run's actor, as the native host's folder calls send it.
create function pg_temp.c3_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding ->> 'runId', 'jobId', p_binding ->> 'jobId',
		'runnerId', p_binding ->> 'runnerId', 'assignmentId', p_binding ->> 'assignmentId')
$$;
create function pg_temp.c3_alice() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
-- A brief as the parser gives it, with the platform's standing texts; a coding brief names its harness and repository.
create function pg_temp.c3_brief(p_id uuid, p_species text default 'coding', p_access text default 'read',
	p_harness text default 'codex', p_title text default 'Fix the login page') returns jsonb language sql as $$
	select jsonb_build_object('kind', 'worker-brief', 'id', p_id, 'title', p_title, 'species', p_species, 'access', p_access,
		'revival', 'batch', 'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'followUps', 0, 'followedUpAt', null, 'goal', 'Make the login page accept a pasted code.',
		'doneWhen', 'A draft pull request that does it.', 'context', null, 'sources', '[]'::jsonb, 'followUp', null)
		|| case when p_species = 'coding' then jsonb_build_object('harness', p_harness, 'repository', pg_temp.c3_repo())
			else '{}'::jsonb end
		|| public.qorpera_company_state_worker_standing(p_species, p_access, 'batch')
$$;
-- The request manage_worker sends with a brief, and what the model added.
create function pg_temp.c3_request(p_folder text, p_brief jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('action', 'dispatch', 'folder', p_folder, 'title', p_brief ->> 'title', 'goal', p_brief ->> 'goal',
		'doneWhen', p_brief ->> 'doneWhen', 'context', p_brief -> 'context', 'sources', p_brief -> 'sources',
		'access', p_brief ->> 'access', 'revival', p_brief ->> 'revival')
		|| case when p_brief ->> 'species' = 'coding' then jsonb_build_object('species', 'coding', 'harness', p_brief ->> 'harness',
			'repository', p_brief -> 'repository') else '{}'::jsonb end
		|| p_extra
$$;
-- A file staged as the run that commits it (a version-2 file is held to possession).
create function pg_temp.c3_stage(p_binding jsonb, p_text text) returns jsonb language plpgsql as $$
declare v_seal jsonb := pg_temp.base_seal(pg_temp.c3_actor(p_binding), pg_temp.base_manifest(p_text));
begin
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end $$;
-- A structured file's entry, as the shared parser sends it; the text is the parse's, as the folder core reads no bytes.
create function pg_temp.c3_entry(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_parse ->> 'kind', 'text', p_parse::text, 'parse', p_parse, 'parserVersion', 1)
$$;
-- A dispatch's one unit: the worker's folder with its brief (the todo's folder exists).
create function pg_temp.c3_units(p_binding jsonb, p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', p_folder,
		'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', pg_temp.c3_stage(p_binding, p_brief::text))),
		'structured', jsonb_build_array(pg_temp.c3_entry(p_folder || '/brief.md', p_brief))))
$$;
-- The automatic review's allow of one manage_worker call, recorded as the review of exactly these units (C2 R1).
create function pg_temp.c3_review(p_binding jsonb, p_call text, p_units jsonb) returns uuid language plpgsql as $$
declare v_action uuid;
begin
	v_action := (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'manage_worker',
		'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Start a coding session', 'target', 'fix-login', 'details', '{}'::jsonb),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	return (public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', v_action, 'tool', 'manage_worker',
		'argumentSha256', md5(p_call) || md5(p_call), 'units', p_units)) ->> 'reviewId')::uuid;
end $$;
-- One worker commit by a run, as manage_worker makes it.
create function pg_temp.c3_commit(p_binding jsonb, p_key text, p_units jsonb, p_request jsonb, p_review uuid) returns jsonb
language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', pg_temp.c3_actor(p_binding), p_key,
		p_units, p_request, p_review);
end $$;
-- A dispatch by a run: its units, reviewed, under the request.
create function pg_temp.c3_dispatch(p_binding jsonb, p_key text, p_folder text, p_brief jsonb, p_extra jsonb default '{}')
returns jsonb language plpgsql as $$
declare v_units jsonb := pg_temp.c3_units(p_binding, p_folder, p_brief);
begin
	return pg_temp.c3_commit(p_binding, p_key, v_units, pg_temp.c3_request(p_folder, p_brief, p_extra),
		pg_temp.c3_review(p_binding, p_key, v_units));
end $$;
-- A dispatch refused by the worker rules with exactly these words, and nothing written for the brief's worker.
create function pg_temp.c3_refused(p_result jsonb, p_brief jsonb, p_words text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and p_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = p_words, format('refused with "%s": %s', p_words, p_result));
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_runtime_workers where id = (p_brief ->> 'id')::uuid)
		and not exists (select 1 from public.qorpera_coding_sessions where worker_id = (p_brief ->> 'id')::uuid),
		'a refused dispatch writes nothing: ' || p_words);
end $$;
create function pg_temp.c3_worker(p_id uuid) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = p_id
$$;
create function pg_temp.c3_session(p_id uuid) returns public.qorpera_coding_sessions language sql as $$
	select * from public.qorpera_coding_sessions where worker_id = p_id
$$;
-- The owner's answer in the session's thread, as the web app sends it.
create function pg_temp.c3_answer(p_worker uuid, p_text text) returns jsonb language plpgsql as $$
declare v_view jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_view := public.qorpera_answer_coding_session(p_worker, p_text, extensions.gen_random_uuid());
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_view;
end $$;
-- The agent's follow-up of a worker: its brief with one more follow-up, under review.
create function pg_temp.c3_followup(p_binding jsonb, p_key text, p_folder text, p_text text) returns jsonb language plpgsql as $$
declare v_base jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = pg_temp.base_version(p_folder || '/brief.md'));
	v_brief jsonb; v_units jsonb;
begin
	v_brief := v_base || jsonb_build_object('followUps', (v_base ->> 'followUps')::integer + 1,
		'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', p_text);
	v_units := jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/brief.md',
		'file', pg_temp.c3_stage(p_binding, v_brief::text), 'expectedVersion', pg_temp.base_version(p_folder || '/brief.md'),
		'structured', jsonb_build_array(pg_temp.c3_entry(p_folder || '/brief.md', v_brief))));
	return pg_temp.c3_commit(p_binding, p_key, v_units,
		jsonb_build_object('action', 'followup', 'folder', p_folder, 'resultsVersion', null, 'text', p_text),
		pg_temp.c3_review(p_binding, p_key, v_units));
end $$;

-- 0. Alice's todo with its folder, written by the owner -------------------------------------------------------------
select pg_temp.base_commit(pg_temp.base_owner(), 'c3-todos', jsonb_build_array(
	pg_temp.base_write('agents/alice/todos/fix-login.md', 'todo', E'---\ntitle: Fix the login page\nstatus: open\n---\n',
		'{"kind":"todo","id":"92800000-0000-4000-8000-0000000000a1","title":"Fix the login page","status":"open","requestedBy":null,"detail":""}'),
	jsonb_build_object('op', 'mkdir', 'path', 'agents/alice/todos/fix-login'))) \g /dev/null

-- 1. The refusals, in A1's order (cases 1-6): each a rule refusal with the legacy words, and nothing written ---------
do $$
declare
	v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'agents/alice/todos/fix-login/session-1';
	v_brief jsonb := pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1');
begin
	-- 1. No coding executor serves the company for the harness.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'c3-refuse-1', v_folder, v_brief), v_brief,
		'No coding executor serves this company for codex');
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-928', true, array['codex']);
	-- 2. An executor, but no grant of the repository to the agent.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'c3-refuse-2', v_folder, v_brief), v_brief,
		'This agent has no grant for that repository');
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	-- 3. A harness the executor does not serve.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'c3-refuse-3', v_folder,
		pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1', p_harness => 'claude-code')),
		v_brief, 'No coding executor serves this company for claude-code');
	-- 4. Write access.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'c3-refuse-4', v_folder,
		pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1', p_access => 'write')),
		v_brief, 'A coding session needs a harness, a repository and read access');
	-- 5. No species, with a harness: an in-house worker cannot name one.
	perform pg_temp.c3_refused(pg_temp.c3_commit(v_alice, 'c3-refuse-5', pg_temp.c3_units(v_alice, v_folder,
			pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1', 'in-house')),
		pg_temp.c3_request(v_folder, pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1', 'in-house'), '{"harness":"codex"}'),
		pg_temp.c3_review(v_alice, 'c3-refuse-5', pg_temp.c3_units(v_alice, v_folder,
			pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1', 'in-house')))),
		v_brief, 'Worker species is invalid');
	-- 6. An owner other than the member who asked.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'c3-refuse-6', v_folder, v_brief,
		'{"owner":"92400000-0000-4000-8000-000000000002"}'), v_brief, 'A coding session runs for the member who asked for it');
	-- The owner who asked may be named.
	perform pg_temp.base_assert(public.qorpera_folder_worker_request() is null, 'the request is cleared after each commit');
end $$;

-- 2. Accepted (cases 7-9): the worker, its queued session, its first turn and event; no wake -------------------------
do $$
declare
	v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'agents/alice/todos/fix-login/session-1';
	v_brief jsonb := pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b1'); v_result jsonb;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_events jsonb; v_drain jsonb; v_units jsonb := pg_temp.c3_units(v_alice, v_folder, v_brief); v_review uuid;
	v_request jsonb := pg_temp.c3_request(v_folder, v_brief, '{"owner":"92400000-0000-4000-8000-000000000001"}');
begin
	v_review := pg_temp.c3_review(v_alice, 'c3-dispatch-1', v_units);
	v_result := pg_temp.c3_commit(v_alice, 'c3-dispatch-1', v_units, v_request, v_review);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch saves: ' || v_result::text);
	-- Kept for the replay (§3): the call's change set, request and review.
	perform set_config('qorpera_test.c3_dispatch', jsonb_build_object('result', v_result, 'units', v_units, 'request', v_request,
		'review', v_review)::text, false);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_alice ->> 'runId')::uuid;
	-- 7. The worker: coding, active, no wake, owned by the run's requester and paid by that member's own login.
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.species = 'coding' and w.state = 'active' and w.occurrence_id is null and w.sequence = 1
		and w.access = 'read' and w.owner_user_id = '92400000-0000-4000-8000-000000000001'
		and w.requested_by_user_id = '92400000-0000-4000-8000-000000000001' and w.steering_run_id = v_run.id
		and (w.owner_sponsor_binding_id, w.owner_sponsor_version) = (select sponsor.binding_id, sponsor.version
			from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
				'codex') sponsor)
		and w.owner_sponsor_binding_id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		and w.folder_path = v_folder and w.folder_brief_version = pg_temp.base_version(v_folder || '/brief.md')
		and w.dispatch ->> 'output' like 'Finish through coding_finish%', 'the coding worker: ' || to_jsonb(w)::text);
	-- 8. Its session: queued, the harness and repository, its own branch, no lease; in the run's conversation.
	s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(s.phase = 'queued' and s.harness = 'codex' and s.repository = pg_temp.c3_repo()
		and s.branch = 'qorpera/coding/' || w.id::text and s.lease_token is null and s.lease_owner is null
		and s.session_id = v_run.session_id and s.profile_id = '92400000-0000-4000-8000-000000000010', 'the session: ' || to_jsonb(s)::text);
	perform pg_temp.base_assert(public.qorpera_worker_view(w) ->> 'state' = 'queued'
		and public.qorpera_coding_session_view(s, w) ->> 'phase' = 'queued'
		and public.qorpera_coding_session_view(s, w) ->> 'harness' = 'codex', 'the views read queued');
	-- No wake before the workspace exists: the executor's claim starts the session.
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences where source_id = w.id), 'no wake yet');
	-- 9. The dispatch is the session's first event; its first turn is the dispatch's.
	select jsonb_agg(jsonb_build_object('kind', e.kind, 'actor', e.actor, 'body', e.body) order by e.id) into v_events
	from public.qorpera_coding_session_events e where e.worker_id = w.id;
	perform pg_temp.base_assert(v_events = '[{"kind":"phase","actor":"kernel","body":{"phase":"queued"}}]'::jsonb,
		'the first event: ' || v_events::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_session_turns t where t.worker_id = w.id and t.sequence = 1
		and t.input_from = 'dispatch' and t.input_run_id = v_run.id and t.outcome is null) = 1, 'the first turn');
	perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_worker_events e where e.worker_id = w.id
		and e.kind = 'dispatched' and e.body = w.dispatch) = 1, 'the dispatched event');
	-- F2's drain never starts a coding worker: its turns do.
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'idle', 'the drain leaves it: ' || v_drain::text);
	perform pg_temp.base_assert((pg_temp.c3_worker(w.id)).occurrence_id is null
		and not exists (select 1 from public.qorpera_wake_occurrences where source_id = w.id), 'still no wake');
end $$;

-- 3. A replay (case 10): the same operation key and request give the same answer, and no second session -------------
do $$
declare v_call jsonb := current_setting('qorpera_test.c3_dispatch')::jsonb; v_first jsonb := v_call -> 'result'; v_again jsonb;
begin
	v_again := pg_temp.c3_commit(pg_temp.c3_alice(), 'c3-dispatch-1', v_call -> 'units', v_call -> 'request',
		(v_call ->> 'review')::uuid);
	perform pg_temp.base_assert((v_again ->> 'replay')::boolean and v_again - 'replay' = v_first - 'replay',
		'the replay answers the first commit: ' || v_again::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_sessions s join public.qorpera_runtime_workers w on w.id = s.worker_id
		where w.todo_id = '92800000-0000-4000-8000-0000000000a1') = 1, 'one session');
end $$;

-- 4. An in-house worker beside it (case 11): no owner and no session; the drain starts it at once; a cancel takes it out
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'agents/alice/todos/fix-login/notes';
	v_brief jsonb := pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b2', 'in-house'); v_result jsonb; v_drain jsonb;
	w public.qorpera_runtime_workers%rowtype;
begin
	v_result := pg_temp.c3_dispatch(v_alice, 'c3-in-house-1', v_folder, v_brief);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the in-house dispatch: ' || v_result::text);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b2');
	perform pg_temp.base_assert(w.species = 'in-house' and w.owner_user_id is null and w.owner_sponsor_binding_id is null
		and pg_temp.c3_session(w.id) is null, 'the in-house worker');
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'started')::integer = 1, 'started: ' || v_drain::text);
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.occurrence_id is not null and (select status from public.qorpera_wake_occurrences
		where id = w.occurrence_id) = 'queued', 'its wake is queued');
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).occurrence_id is null,
		'the coding worker still has none');
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'c3-cancel-1'));
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.state = 'cancelled' and (select status from public.qorpera_wake_occurrences
		where id = w.occurrence_id) = 'cancelled', 'the cancel takes it out of the queue');
end $$;

-- 5. A second session for the same owner and harness (case 12) queues beside the first; a cancel ends its session ------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'agents/alice/todos/fix-login/session-2';
	v_brief jsonb := pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b3', p_title => 'Fix the logout page'); v_result jsonb;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	v_result := pg_temp.c3_dispatch(v_alice, 'c3-dispatch-2', v_folder, v_brief);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the second dispatch: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.c3_session('92800000-0000-4000-8000-0000000000b3')).phase = 'queued'
		and (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).phase = 'queued', 'both queue');
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'c3-cancel-2'));
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b3'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'cancelled' and s.phase = 'cancelled' and s.finished_at is not null
		and s.lease_token is null, 'the cancelled session: ' || to_jsonb(s)::text);
	perform pg_temp.base_assert((select e.body ->> 'phase' from public.qorpera_coding_session_events e where e.worker_id = w.id
		order by e.id desc limit 1) = 'cancelled', 'its last event');
	perform pg_temp.base_assert((pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).phase = 'queued', 'the first waits on');
end $$;

-- 6. Follow-ups: a cancelled session keeps its branch and continues; an active one is still working --------------------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_folder text; v_base jsonb; v_brief jsonb; v_units jsonb; v_result jsonb;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	foreach v_folder in array array['agents/alice/todos/fix-login/session-1', 'agents/alice/todos/fix-login/session-2'] loop
		v_base := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
			where v.version = pg_temp.base_version(v_folder || '/brief.md'));
		v_brief := v_base || jsonb_build_object('followUps', 1,
			'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Keep the old route.');
		v_units := jsonb_build_array(jsonb_build_object('op', 'write', 'path', v_folder || '/brief.md',
			'file', pg_temp.c3_stage(v_alice, v_brief::text), 'expectedVersion', pg_temp.base_version(v_folder || '/brief.md'),
			'structured', jsonb_build_array(pg_temp.c3_entry(v_folder || '/brief.md', v_brief))));
		v_result := pg_temp.c3_commit(v_alice, 'c3-followup-' || right(v_folder, 1), v_units,
			jsonb_build_object('action', 'followup', 'folder', v_folder, 'resultsVersion', null, 'text', 'Keep the old route.'),
			pg_temp.c3_review(v_alice, 'c3-followup-' || right(v_folder, 1), v_units));
		if v_folder like '%session-1' then
			perform pg_temp.base_assert(v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
				= 'this worker is still working; wait for its report or cancel it', 'an active session: ' || v_result::text);
		else
			perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the follow-up: ' || v_result::text);
			w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b3'); s := pg_temp.c3_session(w.id);
			perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2 and w.occurrence_id is null and s.phase = 'input_ready'
				and s.lease_token is null and s.branch = 'qorpera/coding/' || w.id::text, 'the continued session: ' || to_jsonb(s)::text);
			perform pg_temp.base_assert(exists (select 1 from public.qorpera_coding_session_turns t where t.worker_id = w.id
					and t.sequence = 2 and t.input_from = 'agent' and t.input_text = 'Keep the old route.')
				and exists (select 1 from public.qorpera_coding_session_turns t where t.worker_id = w.id and t.sequence = 1
					and t.outcome is not null), 'its second turn, after the first settled');
			perform pg_temp.base_assert((select e.kind from public.qorpera_coding_session_events e where e.worker_id = w.id
				order by e.id desc limit 1) = 'input', 'its input event');
		end if;
	end loop;
	-- Cancelled again, so the claim below takes session 1.
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', 'agents/alice/todos/fix-login/session-2',
		'operationKey', 'c3-cancel-3'));
end $$;

-- 6b. A member's answer turns a coding session too, without its brief; the agent's next follow-up counts its own -------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'agents/alice/todos/fix-login/session-2'; v_result jsonb;
	w public.qorpera_runtime_workers%rowtype;
begin
	-- The owner answers the cancelled session in its thread: it works again, at sequence 3; its brief still says 1.
	perform pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b3', 'Use the new route after all.');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b3');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 3, 'the member''s turn: ' || to_jsonb(w)::text);
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'c3-cancel-4'));
	-- The agent's follow-up: follow_ups 2 (one more than the brief), at sequence 4.
	v_result := pg_temp.c3_followup(v_alice, 'c3-followup-3', v_folder, 'Only the login route.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the agent''s follow-up: ' || v_result::text);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b3');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 4 and (pg_temp.c3_session(w.id)).phase = 'input_ready'
		and (select (v.structured -> 'parse' ->> 'followUps')::integer from public.qorpera_folder_path_versions v
			where v.version = w.folder_brief_version) = 2, 'the counted follow-up: ' || to_jsonb(w)::text);
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'c3-cancel-5'));
end $$;

-- 7. The drain stops an active coding worker whose parent a member stopped -------------------------------------------
do $$
declare v_wakes jsonb; v_pass jsonb; v_bob jsonb; v_result jsonb; v_drain jsonb; v_run public.qorpera_execution_runs%rowtype;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
	v_folder text := 'agents/bob/todos/fix-signup/session-b';
begin
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000031', pg_temp.c3_repo(), true);
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-bob-todo', jsonb_build_array(
		pg_temp.base_write('agents/bob/todos/fix-signup.md', 'todo', E'---\ntitle: Fix the signup page\nstatus: open\n---\n',
			'{"kind":"todo","id":"92800000-0000-4000-8000-0000000000a2","title":"Fix the signup page","status":"open","requestedBy":null,"detail":""}'),
		jsonb_build_object('op', 'mkdir', 'path', 'agents/bob/todos/fix-signup')));
	v_wakes := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Fix the signup page.');
	v_pass := pg_temp.base_materialize();
	v_bob := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	v_result := pg_temp.c3_dispatch(v_bob, 'c3-bob-1', v_folder, pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b4'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'Bob''s dispatch: ' || v_result::text);
	-- The owner stops Bob's run in his thread.
	select * into strict v_run from public.qorpera_execution_runs where id = (v_bob ->> 'runId')::uuid;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_cancel_session_run(v_run.session_id, v_run.id);
	reset role;
	perform pg_temp.base_claims('service_role');
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'cancelled')::integer = 1, 'the stop: ' || v_drain::text);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b4'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'cancelled' and w.result ->> 'reason' = 'parent_stopped' and s.phase = 'cancelled'
		and w.occurrence_id is null, 'the stopped session: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert((select e.body ->> 'reason' from public.qorpera_coding_session_events e where e.worker_id = w.id
		order by e.id desc limit 1) = 'parent_stopped', 'its event');
end $$;

-- 8. Session 1's turn on folder-v2, beside an in-house worker of the same batch: the in-house one reports; the coding
--    turn is claimed, begun, authorized, submitted and completed, and report_work is refused to it; the parent is revived
--    once, with both results, by F2's drain, after its own turn ended, the batch's coding sibling stopped working and the
--    platform wrote its results.md --------------------------------------------------------------------------------------
create function pg_temp.c3_results(p_binding jsonb, p_key text, p_folder text) returns jsonb language plpgsql as $$
declare v_parse jsonb := jsonb_build_object('kind', 'worker-results', 'outcome', 'succeeded',
	'reportedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'decision', null, 'note', null,
	'summary', 'Done.', 'needs', null, 'files', '[]'::jsonb);
begin
	return pg_temp.c3_commit(p_binding, p_key, jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/results.md',
		'file', pg_temp.c3_stage(p_binding, v_parse::text),
		'structured', jsonb_build_array(pg_temp.c3_entry(p_folder || '/results.md', v_parse)))),
		jsonb_build_object('action', 'report', 'folder', p_folder), null);
end $$;
-- The owner's coding machine is on exec-928, so the fleet picks it for the owner's sessions (the machine step is C1c-3h's).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('92800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-928', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_claim jsonb; v_begin jsonb; v_pass jsonb; v_turn jsonb; v_research jsonb;
	v_authority jsonb; v_wake public.qorpera_wake_occurrences%rowtype; w public.qorpera_runtime_workers%rowtype;
	s public.qorpera_coding_sessions%rowtype; v_token uuid; v_result jsonb; v_drain jsonb; v_written jsonb; v_parse jsonb;
begin
	-- The in-house worker of the batch: started by the drain, its run reports.
	v_result := pg_temp.c3_dispatch(v_alice, 'c3-research-1', 'agents/alice/todos/fix-login/research',
		pg_temp.c3_brief('92800000-0000-4000-8000-0000000000b5', 'in-house', p_title => 'Read the login code'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the research dispatch: ' || v_result::text);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert((v_drain ->> 'started')::integer = 1, 'the research worker starts: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	v_research := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	v_result := pg_temp.c3_results(v_research, 'c3-research-report', 'agents/alice/todos/fix-login/research');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the research report: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b5')).completion_state = 'waiting', 'it waits');
	-- The coding turn: the executor claims session 1 and begins it.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-928', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '92800000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).lease_token;
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	-- Its wake carries the folder-v2 payload: the worker's folder and the todo's file.
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.source_kind = 'worker-dispatch'
		and v_wake.payload ->> 'outputFolder' = 'agents/alice/todos/fix-login/session-1'
		and v_wake.payload #>> '{todo,path}' = 'agents/alice/todos/fix-login.md'
		and v_wake.payload #>> '{coding,branch}' = 'qorpera/coding/92800000-0000-4000-8000-0000000000b1'
		and v_wake.payload #>> '{dispatch,output}' like 'Finish through coding_finish%', 'the turn''s wake: ' || to_jsonb(v_wake)::text);
	-- The materializer makes it a run, which a runner leases.
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	-- report_work is not a coding session's (it finishes through coding_finish): a coding session never writes agents/**.
	v_result := pg_temp.c3_results(v_turn, 'c3-report-1', 'agents/alice/todos/fix-login/session-1');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'denied', 'report_work: ' || v_result::text);
	-- The executor's machine is ready (C1c-3h); the run reads its turn and submits its finish.
	update public.qorpera_coding_sessions set vm_allocation_id = '92800000-0000-4000-8000-0000000000d2'
	where worker_id = '92800000-0000-4000-8000-0000000000b1';
	v_authority := public.qorpera_authorize_coding_turn(v_turn);
	perform pg_temp.base_assert(v_authority #>> '{coding,workerId}' = '92800000-0000-4000-8000-0000000000b1'
		and v_authority #>> '{coding,goal}' = 'Make the login page accept a pasted code.'
		and v_authority -> 'coding' -> 'repository' = pg_temp.c3_repo(), 'the turn''s authority: ' || v_authority::text);
	perform public.qorpera_submit_coding_turn(v_turn, jsonb_build_object('kind', 'finish', 'operationKey', 'c3-finish-1',
		'summary', 'The login page accepts a pasted code.', 'headSha', repeat('a', 40)));
	-- The parent's own turn ends; the batch still waits for its coding sibling, which is at work.
	-- (Its runner's completion is 658's: it needs the run's whole native execution start, which 924's base leaves out.)
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (v_alice ->> 'jobId')::uuid;
	perform set_config('session_replication_role', 'origin', true);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'idle'
		and (pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b5')).completion_state = 'waiting',
		'the batch waits for its coding sibling: ' || v_drain::text);
	-- The executor completes the turn: the session stands by, and the worker is no longer at work.
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'succeeded',
		'The login page accepts a pasted code.', null, jsonb_build_object('url', 'https://github.com/Qorpera/Qorpera_Base/pull/7',
			'number', 7, 'headSha', repeat('a', 40)));
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'succeeded' and w.completion_state = 'waiting' and s.phase = 'completed'
		and s.pull_request ->> 'number' = '7', 'the completed session: ' || to_jsonb(w)::text);
	-- The batch waits for its results.md too, which the platform writes as the turn reported it (C3d; 982 has the rest).
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'idle', 'the batch waits for session 1''s results.md: ' || v_drain::text);
	perform pg_temp.base_claims('service_role');
	v_written := public.qorpera_claim_coding_results_file('92800000-0000-4000-8000-0000000000f1', 60);
	perform pg_temp.base_assert(v_written ->> 'codingWorkerId' = w.id::text and v_written ->> 'outcome' = 'succeeded'
		and v_written ->> 'pullRequest' = 'https://github.com/Qorpera/Qorpera_Base/pull/7'
		and v_written ->> 'path' = 'agents/alice/todos/fix-login/session-1/results.md',
		'session 1''s results claim: ' || coalesce(v_written::text, 'none'));
	v_parse := jsonb_build_object('kind', 'worker-results', 'outcome', 'succeeded', 'reportedAt', v_written ->> 'reportedAt',
		'decision', null, 'note', null, 'summary', (v_written ->> 'summary') || E'\n\nPull request: ' || (v_written ->> 'pullRequest'),
		'needs', null, 'files', '[]'::jsonb);
	perform pg_temp.base_commit('{"kind":"platform"}', v_written ->> 'operationKey', jsonb_build_array(
		pg_temp.base_write(v_written ->> 'path', 'worker-results', v_parse::text, v_parse)));
	perform pg_temp.base_assert((pg_temp.c3_worker(w.id)).folder_results_version = pg_temp.base_version(v_written ->> 'path')
		and not (public.qorpera_finish_coding_results_file('92800000-0000-4000-8000-0000000000f1', w.id,
			(v_written ->> 'generation')::bigint) ->> 'finished')::boolean, 'session 1''s results.md');
	-- One revival of the parent, with both results.
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'revivals')::integer = 1, 'the revival: ' || v_drain::text);
	w := pg_temp.c3_worker(w.id);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.completion_occurrence_id;
	perform pg_temp.base_assert(w.completion_state = 'delivered' and v_wake.source_kind = 'worker-completion'
		and v_wake.parent_run_id = (v_alice ->> 'runId')::uuid and v_wake.status = 'queued'
		and (pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b5')).completion_occurrence_id = v_wake.id,
		'the parent''s wake carries both: ' || to_jsonb(v_wake)::text);
end $$;

-- 8b. A worker whose folder or todo was deleted continues only after a restore -----------------------------------------
do $$
declare v_folder text := 'agents/alice/todos/fix-login/session-1'; v_result jsonb; v_brief jsonb; v_results jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-delete-1', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', v_folder, 'expectedVersion', pg_temp.base_version(v_folder), 'asOfSeq', (select last_seq
			from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'))));
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).folder_retired_at is not null, 'retired');
	perform pg_temp.base_error($q$select pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'One more thing.')$q$, '55000',
		'This session''s folder was deleted; restore it to continue');
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).state = 'succeeded'
		and (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).phase = 'completed', 'nothing turned');
	-- The todo's file cannot go before its other workers' folders.
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'c3-delete-2',
		jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'agents/alice/todos/fix-login.md',
			'expectedVersion', pg_temp.base_version('agents/alice/todos/fix-login.md'), 'asOfSeq', (select last_seq
				from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'))));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = 'this todo has workers: delete its folder first, or write a new todo'
		and (select t.folder_retired_at from public.qorpera_runtime_agent_todos t where t.id = '92800000-0000-4000-8000-0000000000a1') is null,
		'the todo stays: ' || v_result::text);
	-- The whole todo goes, its folder and then its file; then session 1's folder alone comes back, whole. It is live
	-- again under a deleted todo, and does not turn either.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-delete-3', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', 'agents/alice/todos/fix-login', 'expectedVersion', pg_temp.base_version('agents/alice/todos/fix-login'),
		'asOfSeq', (select last_seq from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'))));
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-delete-4', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', 'agents/alice/todos/fix-login.md', 'expectedVersion', pg_temp.base_version('agents/alice/todos/fix-login.md'),
		'asOfSeq', (select last_seq from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'))));
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-restore-1', jsonb_build_array(jsonb_build_object('op', 'mkdir',
		'path', 'agents/alice/todos/fix-login')));
	v_brief := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = (pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).folder_brief_version);
	v_results := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = (pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).folder_results_version);
	perform pg_temp.base_commit(pg_temp.base_owner(), 'c3-restore-2', jsonb_build_array(jsonb_build_object('op', 'new_folder',
		'path', v_folder, 'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file',
			'file', pg_temp.base_stage(v_brief::text)), jsonb_build_object('path', 'results.md', 'kind', 'file',
			'file', pg_temp.base_stage(v_results::text))),
		'structured', jsonb_build_array(pg_temp.c3_entry(v_folder || '/brief.md', v_brief),
			pg_temp.c3_entry(v_folder || '/results.md', v_results)))));
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).folder_retired_at is null
		and (select t.folder_retired_at from public.qorpera_runtime_agent_todos t where t.id = '92800000-0000-4000-8000-0000000000a1') is not null,
		'session 1 back under a deleted todo: ' || to_jsonb(pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1'))::text);
	perform pg_temp.base_error($q$select pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'One more thing.')$q$, '55000',
		'This session''s todo was deleted; restore it to continue');
	perform pg_temp.base_assert((pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')).state = 'succeeded'
		and (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).phase = 'completed', 'nothing turned under the deleted todo');
	-- The claim and the begin skip it by the same test.
	perform pg_temp.base_assert(public.qorpera_coding_worker_retired(pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1')),
		'retired by its todo');
end $$;

-- 8c. The payer: the login that pays is held to the plan rule when the index takes it --------------------------------
-- The owner's login becomes a ChatGPT plan (a vault login of its capsule): it pays only for work of runs it pays for.
set local session_replication_role = replica;
insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
	native_harness, current_version, access_issued_at, access_expires_at, login_kind)
select '92800000-0000-4000-8000-0000000000e1', '92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, v.credential_capsule_id,
	'92800000-0000-4000-8000-0000000000e2', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '1 hour',
	'chatgpt_plan'
from public.qorpera_provider_connection_versions v
where v.connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid and v.version = 2;
set local session_replication_role = origin;
do $$
declare v_sponsor uuid := (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	-- For a run it pays for, the plan pays; for any other run, it does not, and the rules say the same.
	perform pg_temp.base_assert((select payer.binding_id from public.qorpera_coding_owner_payer('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', v_sponsor) payer) = v_sponsor, 'the plan pays for its own run''s work');
	perform pg_temp.base_error($q$select * from public.qorpera_coding_owner_payer('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', '92800000-0000-4000-8000-0000000000e3')$q$, '55000',
		'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it');
	perform pg_temp.base_assert(public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', '92800000-0000-4000-8000-0000000000e3')
		= 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it', 'the rules agree');
end $$;

-- 9. The new helpers are the database's own: no API role calls them -------------------------------------------------
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_coding_owner_login(uuid,uuid,text)',
		'public.qorpera_coding_owner_problem(uuid,uuid,text,uuid)', 'public.qorpera_coding_owner_payer(uuid,uuid,text,uuid)',
		'public.qorpera_coding_worker_retired(public.qorpera_runtime_workers)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
end $$;

rollback;
