-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- C3b (migration 20260930097000, deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)"): the agent's archive of
-- a coding session on folder-v2, a run effect like F2's cancel under its own receipt. An active session is cancelled
-- first and then archived, keeping its branch; a replay answers the first call; a second archive finds it archived; an
-- in-house worker and a missing one are refused; a follow-up reopens it. 928's helpers on 924's base: Alice's run.

do $$
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-932', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(pg_temp.c3_alice(), 'c3b-dispatch-1', 'QorperaOS/agents/alice/todos/fix-login/session-a',
		pg_temp.c3_brief('93200000-0000-4000-8000-0000000000b1')) -> 'units' -> 0 ->> 'outcome' = 'saved', 'the coding dispatch');
	perform pg_temp.base_assert(pg_temp.c3_dispatch(pg_temp.c3_alice(), 'c3b-dispatch-2', 'QorperaOS/agents/alice/todos/fix-login/notes',
		pg_temp.c3_brief('93200000-0000-4000-8000-0000000000b2', 'in-house')) -> 'units' -> 0 ->> 'outcome' = 'saved',
		'the in-house dispatch');
end $$;
create function pg_temp.c3b_archive(p_folder text, p_key text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_archive_coding_worker(pg_temp.c3_alice(), jsonb_build_object('folder', p_folder, 'operationKey', p_key));
end $$;

-- 1. An active session: cancelled, then archived; its branch and workspace stay -----------------------------------------
do $$
declare v_result jsonb; w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	v_result := pg_temp.c3b_archive('QorperaOS/agents/alice/todos/fix-login/session-a', 'c3b-archive-1');
	w := pg_temp.c3_worker('93200000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(v_result ->> 'action' = 'archive' and (v_result ->> 'archived')::boolean
		and v_result ->> 'phase' = 'cancelled' and v_result ->> 'folder' = 'QorperaOS/agents/alice/todos/fix-login/session-a'
		and v_result -> 'worker' ->> 'state' = 'cancelled' and v_result ->> 'runId' = pg_temp.c3_alice() ->> 'runId',
		'the answer: ' || v_result::text);
	perform pg_temp.base_assert(w.state = 'cancelled' and w.result ->> 'reason' = 'archived' and s.phase = 'cancelled'
		and s.archived_at is not null and s.archived_by = 'agent' and s.branch = 'qorpera/coding/' || w.id::text,
		'the archived session: ' || to_jsonb(s)::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_session_events e where e.worker_id = w.id
		and e.kind = 'step' and (e.body ->> 'archived')::boolean and e.body ->> 'by' = 'agent') = 1, 'its archive event');
	-- A replay of the call answers the first, under its receipt.
	perform pg_temp.base_assert(pg_temp.c3b_archive('QorperaOS/agents/alice/todos/fix-login/session-a', 'c3b-archive-1') = v_result,
		'the replay');
	-- Archived already: nothing more happens.
	v_result := pg_temp.c3b_archive('QorperaOS/agents/alice/todos/fix-login/session-a', 'c3b-archive-2');
	perform pg_temp.base_assert(not (v_result ->> 'archived')::boolean, 'a second archive: ' || v_result::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_session_events e where e.worker_id = w.id
		and (e.body ->> 'archived')::boolean) = 1, 'one archive event');
end $$;

-- 2. Refusals: an in-house worker, and a folder with no worker ------------------------------------------------------------
select pg_temp.base_error($$select pg_temp.c3b_archive('QorperaOS/agents/alice/todos/fix-login/notes', 'c3b-archive-3')$$, '22023',
	'Only a coding session can be archived');
select pg_temp.base_error($$select pg_temp.c3b_archive('QorperaOS/agents/alice/todos/fix-login/nobody', 'c3b-archive-4')$$, 'P0002',
	'Worker is unavailable');
select pg_temp.base_error($$select pg_temp.c3b_archive('QorperaOS/agents/alice/todos/Fix-Login/session-a', 'c3b-archive-5')$$, '22023',
	'Worker request is invalid');

-- 3. A follow-up reopens it: the next turn queues on the same branch ------------------------------------------------------
do $$
declare v_folder text := 'QorperaOS/agents/alice/todos/fix-login/session-a'; v_alice jsonb := pg_temp.c3_alice(); v_brief jsonb; v_units jsonb;
	v_result jsonb; w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	v_brief := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = pg_temp.base_version(v_folder || '/brief.md')) || jsonb_build_object('followUps', 1,
		'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Pick it up again.');
	v_units := jsonb_build_array(jsonb_build_object('op', 'write', 'path', v_folder || '/brief.md',
		'file', pg_temp.c3_stage(v_alice, v_brief::text), 'expectedVersion', pg_temp.base_version(v_folder || '/brief.md'),
		'structured', jsonb_build_array(pg_temp.c3_entry(v_folder || '/brief.md', v_brief))));
	v_result := pg_temp.c3_commit(v_alice, 'c3b-followup-1', v_units,
		jsonb_build_object('action', 'followup', 'folder', v_folder, 'resultsVersion', null, 'text', 'Pick it up again.'),
		pg_temp.c3_review(v_alice, 'c3b-followup-1', v_units));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the follow-up: ' || v_result::text);
	w := pg_temp.c3_worker('93200000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2 and s.phase = 'input_ready' and s.archived_at is null
		and s.branch = 'qorpera/coding/' || w.id::text, 'reopened: ' || to_jsonb(s)::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_coding_session_events e where e.worker_id = w.id
		and e.kind = 'step' and (e.body ->> 'reopened')::boolean), 'its reopen event');
end $$;

-- 4. The native host may call it with the binding's scope; no API role but the service role may ---------------------------
do $$
begin
	perform pg_temp.base_assert((select scope from public.qorpera_native_host_calls
		where name = 'qorpera_folder_archive_coding_worker') = 'binding', 'a binding-scope host call');
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_folder_archive_coding_worker(jsonb,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_folder_archive_coding_worker(jsonb,jsonb)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_folder_archive_coding_worker(jsonb,jsonb)', 'execute'),
		'service role only');
end $$;

rollback;
