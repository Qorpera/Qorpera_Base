-- @fixture 928_folder_coding_dispatch.test.sql until "-- 8. Session 1's turn on folder-v2"
-- 20260930560000: a failed coding turn reads as its own, in plain words (live company-building test, 3 Nov 2026). 928's
-- base: Alice's run, and coding session 1 dispatched for the owner on the owner's own codex-cli login. Session 1's
-- first turn fails with ChatGPT's overload (the bridge's PROVIDER_FAILED, and the node host's provider_outage signal):
-- the agent, the turn's outcome, the failed event and the view read reason provider_outage and fixed words, never the
-- bridge's text, its status or a code; and the turn's failed run is not listed as its agent's failure. Its second turn
-- fails with a dropped connection and no signal: plain words for that class, with the bridge's code as its reason. A
-- signal from an attempt that paused and went on says nothing. Plain summaries stay as they are, and both bodies name
-- this migration.

-- The node host's calls on a run's binding: a provider signal, and the runner's failure report.
create function pg_temp.pw_signal(p_binding jsonb, p_kind text) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	perform public.qorpera_record_provider_usage_signal(p_binding, p_kind);
	reset role;
end
$$;
create function pg_temp.pw_fail(p_binding jsonb, p_error text) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	perform public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
	reset role;
end
$$;
-- The executor claims session 1 and begins its turn; the materializer makes the turn's run, which a runner starts.
-- Answers the lease token and the run's binding.
create function pg_temp.pw_turn() returns jsonb language plpgsql as $$
declare v_claim jsonb; v_token uuid; v_begin jsonb; v_pass jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-928', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '92800000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).lease_token;
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	return pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid) || jsonb_build_object('token', v_token);
end
$$;
-- The members' activity list, as Alice reads it.
create function pg_temp.pw_activity() returns jsonb language plpgsql as $$
declare v_rows jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020');
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_rows;
end
$$;
create function pg_temp.pw_event() returns jsonb language sql as $$
	select body from public.qorpera_coding_session_events where worker_id = '92800000-0000-4000-8000-0000000000b1'
		and kind = 'failed' order by id desc limit 1
$$;
create function pg_temp.pw_view() returns jsonb language sql as $$
	select public.qorpera_coding_session_view(s, w) from public.qorpera_coding_sessions s
	join public.qorpera_runtime_workers w on w.id = s.worker_id where s.worker_id = '92800000-0000-4000-8000-0000000000b1'
$$;

-- The owner's coding machine is on exec-928, so the fleet picks it for the owner's sessions (as 928's §8).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('92800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-928', repeat('7', 64), '{}');
set local session_replication_role = origin;

-- 1. ChatGPT's overload: reason provider_outage, the words, and not the agent's failure --------------------------------
do $$
declare v_turn jsonb; w public.qorpera_runtime_workers%rowtype; v_event jsonb; v_rows jsonb; v_run uuid; v_agent uuid;
	v_error constant text := 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]';
	v_words constant text := 'ChatGPT was overloaded or had a server error while Codex worked, so the coding turn stopped. '
		|| 'This is usually brief, and the login that pays for it is fine. The files the turn wrote stay in the session''s '
		|| 'workspace as it left them; a follow-up turn continues from them.';
begin
	v_turn := pg_temp.pw_turn();
	v_run := (v_turn ->> 'runId')::uuid;
	-- The host records the outage (Codex's serverOverloaded), then the runner fails the job with the bridge's code.
	perform pg_temp.pw_signal(v_turn - 'token', 'provider_outage');
	perform pg_temp.pw_fail(v_turn - 'token', v_error || '; durable attempt output requires review');
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', (v_turn ->> 'token')::uuid, 'failed',
		'The coding turn did not finish: ' || v_error || '; durable attempt output requires review');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'failed' and w.result ->> 'summary' = v_words
		and w.result ->> 'reason' = 'provider_outage', 'the worker''s result: ' || w.result::text);
	perform pg_temp.base_assert(w.result::text !~ '422|\[code=|bridge|PROVIDER_FAILED|durable', 'no machinery reaches the agent: ' || w.result::text);
	perform pg_temp.base_assert((select e.body ->> 'summary' from public.qorpera_runtime_worker_events e
		where e.worker_id = w.id and e.sequence = w.sequence and e.kind = 'reported') = v_words, 'the reported event');
	perform pg_temp.base_assert((select outcome ->> 'reason' = 'provider_outage' and outcome ->> 'summary' = v_words
		from public.qorpera_coding_session_turns where worker_id = w.id and sequence = 1), 'the turn''s outcome');
	v_event := pg_temp.pw_event();
	perform pg_temp.base_assert(v_event ->> 'code' = 'provider_outage' and v_event ->> 'summary' = v_words,
		'the failed event: ' || coalesce(v_event::text, 'none'));
	perform pg_temp.base_assert(pg_temp.pw_view() ->> 'reason' = 'provider_outage', 'the view: ' || pg_temp.pw_view()::text);
	-- The run is a failed wake of the session's agent that nobody resolved, which the list would show as the agent's
	-- failure: it does not, since the session's card says it.
	select run.staff_agent_id into strict v_agent from public.qorpera_execution_runs as run where run.id = v_run;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_wake_occurrences o
		where o.run_id = v_run and o.status in ('failed', 'requires_review'))
		and not exists (select 1 from public.qorpera_execution_run_events e where e.run_id = v_run
			and e.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged')), 'an unresolved failed wake');
	v_rows := pg_temp.pw_activity();
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) as entry
		where entry ->> 'run_id' = v_run::text or (entry ->> 'staff_agent_id' = v_agent::text
			and entry ->> 'job_status' in ('failed', 'cancelled'))), 'not the agent''s failure: ' || coalesce(v_rows::text, 'none'));
	-- Unless it left an operation of unknown outcome: only the run's recovery card lets a person settle that.
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, completed_at)
	select '56000000-0000-4000-8000-0000000000c1', run.id, run.job_id, job.client_lease_id, 'test-560', 'folder_write',
		repeat('a', 64), repeat('b', 64), 'ambiguous', statement_timestamp()
	from public.qorpera_execution_runs as run join public.qorpera_runner_jobs as job on job.id = run.job_id where run.id = v_run;
	set local session_replication_role = origin;
	v_rows := pg_temp.pw_activity();
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) as entry
		where entry ->> 'run_id' = v_run::text and entry ->> 'job_status' = 'failed'),
		'a run with an unsettled operation stays listed: ' || coalesce(v_rows::text, 'none'));
	set local session_replication_role = replica;
	delete from public.qorpera_run_operation_receipts where id = '56000000-0000-4000-8000-0000000000c1';
	set local session_replication_role = origin;
end $$;

-- 2. A dropped connection without a signal: that class's words, with the bridge's code as the reason ---------------------
do $$
declare v_turn jsonb; w public.qorpera_runtime_workers%rowtype;
	v_error constant text := 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE]';
begin
	perform pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'Please go on.');
	v_turn := pg_temp.pw_turn();
	perform pg_temp.pw_fail(v_turn - 'token', v_error);
	perform pg_temp.base_claims('service_role');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	-- Plain summaries stay as they are.
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.')
		= jsonb_build_object('reason', 'NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE', 'summary', 'The coding turn did not finish.'),
		'a plain summary: ' || public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.')::text);
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', (v_turn ->> 'token')::uuid, 'failed',
		'The coding turn did not finish: ' || v_error);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.sequence = 2 and w.result ->> 'reason' = 'NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE'
		and w.result ->> 'summary' = 'The coding turn lost its connection while it worked, so it stopped. This is usually brief. '
			|| 'The files the turn wrote stay in the session''s workspace as it left them; a follow-up turn continues from them.',
		'the worker''s result: ' || w.result::text);
	perform pg_temp.base_assert(pg_temp.pw_event() ->> 'code' = 'NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE',
		'the failed event: ' || pg_temp.pw_event()::text);
	-- An outage signal says nothing of how the run ended when an earlier attempt recorded it, or when its attempt paused
	-- and went on (549300's rule). The signal is turn 1's, moved to this run.
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source, resets_at, assignment_id)
	select first.profile_id, run.id, run.job_id, run.sponsor_binding_id, run.sponsor_version, first.provider_connection_id,
		first.provider_connection_version, first.provider, 'provider_outage', first.source, null,
		'56000000-0000-4000-8000-0000000000a1'
	from public.qorpera_provider_connection_usage_signals as first
	join public.qorpera_execution_runs as run on run.id = (v_turn ->> 'runId')::uuid
	where first.signal_kind = 'provider_outage' and first.run_id <> run.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish: ' || v_error) ->> 'reason'
		= 'NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE', 'an earlier attempt''s signal');
	-- The job's last attempt's own signal, paused and gone on: still nothing.
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_usage_signals as signal set assignment_id = job.client_lease_id
	from public.qorpera_runner_jobs as job
	where signal.run_id = (v_turn ->> 'runId')::uuid and job.id = signal.job_id;
	insert into public.qorpera_execution_run_events(run_id, event_type, payload)
	select (v_turn ->> 'runId')::uuid, 'run_paused', jsonb_build_object('schema', 'qorpera.run-resume/v1',
		'assignmentId', job.client_lease_id, 'reason', 'provider outage')
	from public.qorpera_runner_jobs as job where job.id = (v_turn ->> 'jobId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish: ' || v_error) ->> 'reason'
		= 'NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE', 'a paused attempt''s signal');
	-- Without that pause the last attempt's signal decides.
	set local session_replication_role = replica;
	delete from public.qorpera_execution_run_events where run_id = (v_turn ->> 'runId')::uuid and event_type = 'run_paused';
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish: ' || v_error) ->> 'reason'
		= 'provider_outage', 'the last attempt''s signal');
	-- A run's error without a code keeps the executor's summary (the web still reads it there), with what the rows say.
	set local session_replication_role = replica;
	delete from public.qorpera_provider_connection_usage_signals where run_id = (v_turn ->> 'runId')::uuid;
	update public.qorpera_runner_jobs set last_error = 'Runner lease expired before durable completion'
	where id = (v_turn ->> 'jobId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w,
			'The coding turn did not finish: Runner lease expired before durable completion')
		= jsonb_build_object('reason', 'turn_failed', 'summary',
			'The coding turn did not finish: Runner lease expired before durable completion'),
		'an error without a code: ' || public.qorpera_coding_turn_failure(w,
			'The coding turn did not finish: Runner lease expired before durable completion')::text);
end $$;

-- 3. Every new or patched body names this migration; the grants stay ---------------------------------------------------
select pg_temp.base_assert(position('20260930560000' in pg_get_functiondef(
	'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure)) > 0
	and position('20260930560000' in pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0,
	'the marker');
select pg_temp.base_assert(not has_function_privilege('authenticated',
	'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)', 'execute')
	and has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute'), 'the grants');
