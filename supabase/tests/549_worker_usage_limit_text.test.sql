-- @fixture 928_folder_coding_dispatch.test.sql until "-- 8. Session 1's turn on folder-v2"
-- 20260930549300: a worker stopped at its login's usage limit tells its agent so in plain words (live company-building
-- test, 3 Nov 2026). 928's base: Alice's run, and coding session 1 dispatched for the owner on the owner's own codex-cli
-- login. Session 1's turn begins and its run reaches the login's usage limit (the node host's signal; the login's weekly
-- window is full); the executor then completes the turn failed with the provider bridge's code, and the agent reads,
-- in the worker's result, its `reported` event and its results.md claim, the fixed words with the window's reset, and
-- the `failed` event says the same and keeps usageLimit. An in-house worker whose run stops the same way fails with
-- reason usage_limit and the same words. The reset is the signal's own when it is ahead, else the full window's, else
-- left out; a run without the signal, or no run, has no text; and no API role calls the new function.

-- The node host's calls on a run's binding: a provider signal, and the runner's failure report.
create function pg_temp.ul_signal(p_binding jsonb, p_kind text) returns jsonb language plpgsql as $$
declare v_receipt jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_receipt := public.qorpera_record_provider_usage_signal(p_binding, p_kind);
	reset role;
	return v_receipt;
end
$$;
create function pg_temp.ul_fail(p_binding jsonb, p_error text) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	perform public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
	reset role;
end
$$;
-- The words, with the reset when one is given.
create function pg_temp.ul_words(p_reset timestamptz) returns text language sql immutable as $$
	select 'The login paying for this work reached its usage limit. '
		|| case when p_reset is null then ''
			else 'It resets on ' || to_char(p_reset at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work does not move to another login by itself: the member can choose another of their logins for it '
		|| '(in the conversation''s Login menu), or wait until the limit resets.'
$$;
-- The account's usage as the login's refresh records it: a 5-hour window with room and a weekly window that is full.
create function pg_temp.ul_usage(p_signal public.qorpera_provider_connection_usage_signals, p_week timestamptz)
returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	values (p_signal.provider_connection_id, p_signal.provider_connection_version, jsonb_build_object(
		'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'windows', jsonb_build_array(
			jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 40,
				'resetAt', to_char((clock_timestamp() + interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
			jsonb_build_object('id', 'secondary', 'label', 'Week', 'usedPercent', 100,
				'resetAt', to_char(p_week at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.ul_signal_row(p_binding jsonb) returns public.qorpera_provider_connection_usage_signals
language sql as $$
	select * from public.qorpera_provider_connection_usage_signals
	where run_id = (p_binding ->> 'runId')::uuid and signal_kind = 'usage_limit'
$$;

-- The owner's coding machine is on exec-928, so the fleet picks it for the owner's sessions (as 928's §8).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('92800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-928', repeat('7', 64), '{}');
set local session_replication_role = origin;

-- 1. A coding turn stopped at the login's usage limit --------------------------------------------------------------------
do $$
declare v_claim jsonb; v_begin jsonb; v_pass jsonb; v_turn jsonb; v_token uuid; v_week timestamptz; v_words text;
	v_signal public.qorpera_provider_connection_usage_signals; v_written jsonb; v_event jsonb;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
	v_bridge constant text := 'The coding turn did not finish: Native provider bridge request failed (422) '
		|| '[code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]';
begin
	-- The executor claims session 1 and begins its turn; the materializer makes the turn's run, which a runner leases.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-928', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '92800000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).lease_token;
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_assert((select o.run_id from public.qorpera_wake_occurrences o where o.id = (v_begin ->> 'occurrenceId')::uuid)
		= (v_turn ->> 'runId')::uuid, 'the turn''s run is its occurrence''s');
	-- Before the limit, the run has no text.
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text((v_begin ->> 'occurrenceId')::uuid) is null, 'no signal, no text');
	-- The run reaches its login's usage limit: the host records the signal (no reset given), and the login's weekly
	-- window is full until v_week.
	perform pg_temp.ul_signal(v_turn, 'usage_limit');
	v_signal := pg_temp.ul_signal_row(v_turn);
	perform pg_temp.base_assert(v_signal.id is not null and v_signal.resets_at is null, 'the signal: ' || to_jsonb(v_signal)::text);
	v_week := date_trunc('minute', clock_timestamp()) + interval '4 days 3 hours';
	perform pg_temp.ul_usage(v_signal, v_week);
	v_words := pg_temp.ul_words(v_week);
	perform pg_temp.base_assert(v_words ~ ' It resets on [0-9]{1,2} [A-Z][a-z]+ 20[0-9]{2} at [0-2][0-9]:[0-5][0-9] UTC\. ',
		'the reset reads plainly: ' || v_words);
	perform pg_temp.ul_fail(v_turn, 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]');
	-- The executor completes the turn failed with the bridge's code; the agent reads the plain words instead.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'failed', v_bridge);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'failed' and s.phase = 'failed' and w.result ->> 'outcome' = 'failed'
		and w.result ->> 'summary' = v_words and w.result ->> 'runId' = v_turn ->> 'runId', 'the worker''s result: ' || w.result::text);
	perform pg_temp.base_assert(position('BUDGET_EXHAUSTED' in w.result::text) = 0 and position('bridge' in w.result::text) = 0,
		'no provider code reaches the agent: ' || w.result::text);
	perform pg_temp.base_assert((select e.body ->> 'summary' from public.qorpera_runtime_worker_events e
		where e.worker_id = w.id and e.sequence = w.sequence and e.kind = 'reported') = v_words, 'the reported event');
	select e.body into v_event from public.qorpera_coding_session_events e where e.worker_id = w.id and e.kind = 'failed'
	order by e.id desc limit 1;
	perform pg_temp.base_assert(v_event ->> 'summary' = v_words and (v_event ->> 'usageLimit')::boolean,
		'the failed event: ' || coalesce(v_event::text, 'none'));
	-- results.md is written from the same words (C3d).
	v_written := public.qorpera_claim_coding_results_file('92800000-0000-4000-8000-0000000000f1', 60);
	perform pg_temp.base_assert(v_written ->> 'codingWorkerId' = w.id::text and v_written ->> 'outcome' = 'failed'
		and v_written ->> 'summary' = v_words, 'the results claim: ' || coalesce(v_written::text, 'none'));
	perform set_config('qorpera_test.ul_occurrence', v_begin ->> 'occurrenceId', false);
	perform set_config('qorpera_test.ul_week', v_week::text, false);
end $$;

-- 2. The reset: the signal's own when it is ahead, else the full window's, else left out --------------------------------
do $$
declare v_occurrence uuid := current_setting('qorpera_test.ul_occurrence')::uuid;
	v_week timestamptz := current_setting('qorpera_test.ul_week')::timestamptz; v_run uuid;
	v_soon timestamptz := date_trunc('minute', clock_timestamp()) + interval '90 minutes';
begin
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_occurrence;
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_usage_signals set resets_at = v_soon where run_id = v_run and signal_kind = 'usage_limit';
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text(v_occurrence) = pg_temp.ul_words(v_soon), 'the signal''s reset');
	-- A reset already past is no help: the full window's is the one ahead.
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_usage_signals set resets_at = clock_timestamp() - interval '1 minute'
	where run_id = v_run and signal_kind = 'usage_limit';
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text(v_occurrence) = pg_temp.ul_words(v_week), 'the window''s reset');
	-- No full window ahead: no time.
	update public.qorpera_native_provider_account_metadata set provider_account_usage = jsonb_set(provider_account_usage,
		'{windows,1,usedPercent}', '99'::jsonb)
	where (connection_id, connection_version) = (select s.provider_connection_id, s.provider_connection_version
		from public.qorpera_provider_connection_usage_signals s where s.run_id = v_run and s.signal_kind = 'usage_limit');
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text(v_occurrence) = pg_temp.ul_words(null), 'no reset known');
	-- A rate limit or an outage is not the usage limit, and no occurrence has no text.
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_usage_signals set signal_kind = 'rate_limited' where run_id = v_run and signal_kind = 'usage_limit';
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text(v_occurrence) is null, 'a rate limit has no text');
	perform pg_temp.base_assert(public.qorpera_worker_usage_limit_text(null) is null, 'no occurrence, no text');
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_usage_signals set signal_kind = 'usage_limit' where run_id = v_run and signal_kind = 'rate_limited';
	set local session_replication_role = origin;
end $$;

-- 3. An in-house worker stopped at the login's usage limit ---------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_result jsonb; v_drain jsonb; v_pass jsonb; v_research jsonb; v_words text;
	w public.qorpera_runtime_workers%rowtype;
begin
	v_result := pg_temp.c3_dispatch(v_alice, 'ul-research-1', 'QorperaOS/agents/alice/todos/fix-login/research',
		pg_temp.c3_brief('92800000-0000-4000-8000-0000000000c9', 'in-house', p_title => 'Read the login code'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the research dispatch: ' || v_result::text);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert((v_drain ->> 'started')::integer = 1, 'the research worker starts: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'its run: ' || v_pass::text);
	v_research := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.ul_signal(v_research, 'usage_limit');
	perform pg_temp.ul_fail(v_research, 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000c9');
	v_words := public.qorpera_worker_usage_limit_text(w.occurrence_id);
	perform pg_temp.base_assert(v_words like 'The login paying for this work reached its usage limit. %', 'its words: ' || coalesce(v_words, 'none'));
	perform pg_temp.base_claims('service_role');
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.state = 'failed' and w.completion_state = 'waiting' and w.result ->> 'reason' = 'usage_limit'
		and w.result ->> 'summary' = v_words, 'the in-house worker''s result: ' || v_drain::text || ' ' || coalesce(w.result::text, 'none'));
end $$;

-- 4. The new function is the database's own: no API role calls it ------------------------------------------------------
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_worker_usage_limit_text(uuid)', 'execute'),
			v_role || ' calls qorpera_worker_usage_limit_text');
	end loop;
end $$;
