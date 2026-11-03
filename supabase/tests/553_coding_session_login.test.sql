-- @fixture 928_folder_coding_dispatch.test.sql until "-- 8. Session 1's turn on folder-v2"
-- 20260930551000: a coding session whose login cannot pay says so, and its owner can move it to another of their logins
-- (live company-building test, 3 Nov 2026). 928's base: Alice's run, and coding session 1 dispatched for the owner on the
-- owner's own codex-cli login. Session 1's first turn fails at the provider: it keeps the executor's summary and reports
-- the bridge's code as its reason (the turn's outcome, the worker's result, the failed event's `code`). A turn that
-- fails before it begins reports turn_not_begun. The owner signs the login out; the session's next turn is cancelled at
-- admission and reports login_removed in plain words, never "The coding turn did not finish.". The owner signs in with
-- another login and moves the session to it (never while a turn runs, never as another member, never to a login that
-- cannot pay); the move is an event, a second move to the same login does nothing, the session pays with the binding
-- the dispatch would choose for that login, and the next turn's wake and run pay with it. The other login states read
-- as their own reasons, and the API reaches only the two member functions.

-- The runner's failure report on a run's binding.
create function pg_temp.cl_fail(p_binding jsonb, p_error text) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	perform public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
	reset role;
end
$$;
-- The executor claims session 1; answers its lease token.
create function pg_temp.cl_claim() returns uuid language plpgsql as $$
declare v_claim jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-928', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '92800000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	return (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).lease_token;
end
$$;
-- A member's call of one of the two new functions, as the web app makes it.
create function pg_temp.cl_logins(p_user uuid default '92400000-0000-4000-8000-000000000001') returns jsonb language plpgsql as $$
declare v_value jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_value := public.qorpera_list_coding_session_logins('92800000-0000-4000-8000-0000000000b1');
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_value;
end
$$;
create function pg_temp.cl_choose(p_connection uuid, p_user uuid default '92400000-0000-4000-8000-000000000001')
returns jsonb language plpgsql as $$
declare v_value jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_value := public.qorpera_choose_coding_session_login('92800000-0000-4000-8000-0000000000b1', p_connection);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_value;
end
$$;
-- The view as the session's readers get it.
create function pg_temp.cl_view() returns jsonb language sql as $$
	select public.qorpera_coding_session_view(s, w) from public.qorpera_coding_sessions s
	join public.qorpera_runtime_workers w on w.id = s.worker_id where s.worker_id = '92800000-0000-4000-8000-0000000000b1'
$$;
-- Session 1's last event of a kind, and a turn's outcome.
create function pg_temp.cl_event(p_kind text) returns public.qorpera_coding_session_events language sql as $$
	select * from public.qorpera_coding_session_events where worker_id = '92800000-0000-4000-8000-0000000000b1' and kind = p_kind
	order by id desc limit 1
$$;
create function pg_temp.cl_outcome(p_sequence integer) returns jsonb language sql as $$
	select outcome from public.qorpera_coding_session_turns where worker_id = '92800000-0000-4000-8000-0000000000b1'
		and sequence = p_sequence
$$;
-- The words a login's reason reports, with the shared tail.
create function pg_temp.cl_words(p_first text) returns text language sql immutable as $$
	select p_first || ' The session does not move to another login by itself: the member who owns it can choose '
		|| 'another of their logins for it on the coding session''s card in the conversation, then ask for the work again.'
$$;

-- The owner's coding machine is on exec-928, so the fleet picks it for the owner's sessions (as 928's §8).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('92800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-928', repeat('7', 64), '{}');
set local session_replication_role = origin;

-- 1. A turn that fails at the provider keeps its summary and reports the bridge's code ----------------------------------
do $$
declare v_token uuid; v_begin jsonb; v_pass jsonb; v_turn jsonb; v_event public.qorpera_coding_session_events%rowtype;
	w public.qorpera_runtime_workers%rowtype;
	v_error constant text := 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]';
	v_summary constant text := 'The coding turn did not finish: ' || v_error;
begin
	v_token := pg_temp.cl_claim();
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.cl_fail(v_turn, v_error);
	perform pg_temp.base_claims('service_role');
	-- The executor's own words without the code: the code comes from the run's last error.
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.')
		= jsonb_build_object('reason', 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED', 'summary', 'The coding turn did not finish.'),
		'the run''s code: ' || public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.')::text);
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'failed', v_summary);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'failed' and w.result ->> 'summary' = v_summary
		and w.result ->> 'reason' = 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED', 'the worker''s result: ' || w.result::text);
	perform pg_temp.base_assert(pg_temp.cl_outcome(1) ->> 'reason' = 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED'
		and pg_temp.cl_outcome(1) ->> 'summary' = v_summary, 'the turn''s outcome: ' || coalesce(pg_temp.cl_outcome(1)::text, 'none'));
	v_event := pg_temp.cl_event('failed');
	perform pg_temp.base_assert(v_event.sequence = 1 and v_event.body ->> 'code' = 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED'
		and v_event.body ->> 'summary' = v_summary and not v_event.body ? 'reason', 'the failed event: ' || v_event.body::text);
	perform pg_temp.base_assert(pg_temp.cl_view() ->> 'loginState' = 'ready'
		and pg_temp.cl_view() ->> 'reason' = 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED', 'the view: ' || pg_temp.cl_view()::text);
end $$;

-- 2. A turn that fails before it begins reports turn_not_begun -----------------------------------------------------------
do $$
declare v_token uuid; w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'Try again, please.');
	v_token := pg_temp.cl_claim();
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'failed',
		'The repository could not be prepared.');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.sequence = 2 and w.result ->> 'reason' = 'turn_not_begun'
		and w.result ->> 'summary' = 'The repository could not be prepared.' and pg_temp.cl_outcome(2) ->> 'reason' = 'turn_not_begun',
		'a turn that never began: ' || w.result::text);
end $$;

-- 3. The owner signs the login out: the next turn is cancelled at admission and says why ---------------------------------
do $$
declare v_connection uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	v_token uuid; v_begin jsonb; v_pass jsonb; v_wake public.qorpera_wake_occurrences%rowtype; v_logins jsonb;
	v_event public.qorpera_coding_session_events%rowtype; w public.qorpera_runtime_workers%rowtype; v_words text;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_revoke_native_provider_connection('92400000-0000-4000-8000-000000000010', v_connection);
	reset role;
	perform pg_temp.base_claims('service_role');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'removed'
		and pg_temp.cl_view() ->> 'loginState' = 'removed', 'the session''s login is removed: ' || pg_temp.cl_view()::text);
	-- The owner sees it, with no other login to choose; the removed one cannot be chosen.
	v_logins := pg_temp.cl_logins();
	perform pg_temp.base_assert(v_logins = jsonb_build_object('schema', 'qorpera.coding-session-logins/v1',
		'workerId', '92800000-0000-4000-8000-0000000000b1', 'current', jsonb_build_object('connectionId', v_connection,
			'state', 'removed'), 'logins', '[]'::jsonb), 'the owner''s logins: ' || v_logins::text);
	perform pg_temp.base_error(format('select pg_temp.cl_choose(%L)', v_connection), '22023', 'This login cannot pay for this coding session');
	-- The agent asks the session to try again: the turn's wake is cancelled for its payer, as on 3 November.
	perform pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'Start again with my remaining login.');
	v_token := pg_temp.cl_claim();
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'cancelled' and v_wake.run_id is null
		and v_wake.blocked_reason = 'Wake execution authority is unavailable', 'the wake: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'failed', 'The coding turn did not finish.');
	v_words := pg_temp.cl_words('This coding session''s login was removed (signed out), so its turn could not run.');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.sequence = 3 and w.state = 'failed' and w.result ->> 'reason' = 'login_removed'
		and w.result ->> 'summary' = v_words, 'the worker''s result: ' || w.result::text);
	perform pg_temp.base_assert(pg_temp.cl_outcome(3) ->> 'reason' = 'login_removed' and pg_temp.cl_outcome(3) ->> 'summary' = v_words,
		'the turn''s outcome: ' || coalesce(pg_temp.cl_outcome(3)::text, 'none'));
	v_event := pg_temp.cl_event('failed');
	perform pg_temp.base_assert(v_event.sequence = 3 and v_event.body ->> 'code' = 'login_removed' and v_event.body ->> 'summary' = v_words,
		'the failed event: ' || v_event.body::text);
	perform pg_temp.base_assert((select e.body ->> 'summary' from public.qorpera_runtime_worker_events e
		where e.worker_id = w.id and e.sequence = 3 and e.kind = 'reported') = v_words, 'the agent reads the words');
	perform pg_temp.base_assert(pg_temp.cl_view() ->> 'reason' = 'login_removed', 'the view''s reason');
end $$;

-- 4. The owner signs in with another login and moves the session to it -----------------------------------------------
do $$
declare v_identity uuid := (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
	v_old uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	v_login jsonb; v_second jsonb; v_connection uuid; v_logins jsonb; v_view jsonb; v_events integer;
	w public.qorpera_runtime_workers%rowtype; v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_event public.qorpera_coding_session_events%rowtype;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_login := public.qorpera_begin_native_provider_login('92400000-0000-4000-8000-000000000010',
		'55300000-0000-4000-8000-000000000051', '55300000-0000-4000-8000-000000000052', v_identity, 'openai', 'codex-cli',
		repeat('c', 64), 900);
	reset role;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_second := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat('c', 64),
		'55300000-0000-4000-8000-000000000060', 'object://native-capsules/55300000-0000-4000-8000-000000000060', repeat('d', 64),
		'fixture-openai-account-2', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	v_connection := (v_second ->> 'connection_id')::uuid;
	-- Its member allows it to work while they are away (as 924 consents the first).
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v where connection_id = v_connection and version = 1;
	perform set_config('qorpera_test.cl_second', v_connection::text, false);
	-- The owner reads it as the one login that can pay for the session.
	v_logins := pg_temp.cl_logins();
	perform pg_temp.base_assert(v_logins -> 'current' = jsonb_build_object('connectionId', v_old, 'state', 'removed')
		and v_logins -> 'logins' = jsonb_build_array(jsonb_build_object('connectionId', v_connection, 'email', null, 'current', false)),
		'the owner''s logins: ' || v_logins::text);
	-- Another member can neither read nor choose them; nobody chooses a login that does not exist.
	perform pg_temp.base_error($q$select pg_temp.cl_logins('92400000-0000-4000-8000-000000000002')$q$, '42501');
	perform pg_temp.base_error(format('select pg_temp.cl_choose(%L, %L)', v_connection, '92400000-0000-4000-8000-000000000002'), '42501');
	perform pg_temp.base_error(format('select pg_temp.cl_choose(%L)', extensions.gen_random_uuid()), '22023',
		'This login cannot pay for this coding session');
	-- Never while a turn runs.
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = '92800000-0000-4000-8000-0000000000b1';
	set local session_replication_role = origin;
	perform pg_temp.base_error(format('select pg_temp.cl_choose(%L)', v_connection), '55000',
		'A coding session keeps its login while a turn runs; choose again when it stops');
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'failed' where worker_id = '92800000-0000-4000-8000-0000000000b1';
	set local session_replication_role = origin;
	-- The owner moves it: the session pays with that login, the binding the dispatch would choose for it now.
	select count(*) into v_events from public.qorpera_coding_session_events where worker_id = '92800000-0000-4000-8000-0000000000b1';
	v_view := pg_temp.cl_choose(v_connection);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = w.owner_sponsor_binding_id and version = w.owner_sponsor_version;
	perform pg_temp.base_assert(v_sponsor.provider_connection_id = v_connection and v_sponsor.provider_connection_version = 2
		and v_sponsor.allow_autonomous and v_sponsor.sponsor_kind = 'member_connection'
		and v_sponsor.created_by_user_id = '92400000-0000-4000-8000-000000000001', 'the session''s payer: ' || to_jsonb(v_sponsor)::text);
	perform pg_temp.base_assert((w.owner_sponsor_binding_id, w.owner_sponsor_version) = (select sponsor.binding_id, sponsor.version
		from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
			'codex') sponsor), 'the dispatch''s binding for that login');
	perform pg_temp.base_assert(v_view ->> 'loginState' = 'ready' and v_view ->> 'workerId' = w.id::text
		and pg_temp.cl_view() ->> 'loginState' = 'ready', 'the view after the move: ' || v_view::text);
	v_event := pg_temp.cl_event('step');
	perform pg_temp.base_assert(v_event.actor = 'member' and v_event.sequence = 3
		and v_event.body = '{"loginChosen":true,"text":"Moved to another login"}'::jsonb, 'the move''s event: ' || to_jsonb(v_event)::text);
	perform pg_temp.base_assert(pg_temp.cl_logins() -> 'logins' -> 0 ->> 'current' = 'true'
		and pg_temp.cl_logins() -> 'current' = jsonb_build_object('connectionId', v_connection, 'state', 'ready'), 'the logins after it');
	-- The same choice again changes nothing.
	perform pg_temp.cl_choose(v_connection);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_session_events
		where worker_id = '92800000-0000-4000-8000-0000000000b1') = v_events + 1
		and (pg_temp.c3_worker(w.id)).owner_sponsor_binding_id = w.owner_sponsor_binding_id, 'a second choice is a no-op');
end $$;

-- 5. The next turn pays with the chosen login -------------------------------------------------------------------------
do $$
declare v_token uuid; v_begin jsonb; v_pass jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.c3_answer('92800000-0000-4000-8000-0000000000b1', 'Go on with the new login.');
	v_token := pg_temp.cl_claim();
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'materialized' and v_wake.sponsor_binding_id = w.owner_sponsor_binding_id
		and (select run.sponsor_binding_id from public.qorpera_execution_runs run where run.id = v_wake.run_id) = w.owner_sponsor_binding_id,
		'the turn''s wake and run pay with the chosen login: ' || to_jsonb(v_wake)::text || ' ' || v_pass::text);
	-- While it runs, the session keeps it.
	perform pg_temp.base_error(format('select pg_temp.cl_choose(%L)', current_setting('qorpera_test.cl_second')), '55000');
end $$;

-- 6. The other states of a login, and their words ----------------------------------------------------------------------
do $$
declare v_connection uuid := current_setting('qorpera_test.cl_second')::uuid; w public.qorpera_runtime_workers%rowtype;
	v_failure jsonb;
begin
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'ready', 'ready');
	set local session_replication_role = replica;
	update public.qorpera_provider_connections set status = 'disabled' where id = v_connection;
	set local session_replication_role = origin;
	v_failure := public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.');
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'disabled' and v_failure = jsonb_build_object(
		'reason', 'login_disabled', 'summary', pg_temp.cl_words('This coding session''s login was turned off by an owner or admin, '
			|| 'so its turn could not run. It can run again once they turn the login back on.')), 'disabled: ' || v_failure::text);
	set local session_replication_role = replica;
	update public.qorpera_provider_connections set status = 'active' where id = v_connection;
	update public.qorpera_provider_connection_versions set authorization_state = 'reauthentication_required'
	where connection_id = v_connection and version = 2;
	set local session_replication_role = origin;
	v_failure := public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.');
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'needs_sign_in'
		and v_failure ->> 'reason' = 'login_needs_sign_in' and v_failure ->> 'summary' like 'This coding session''s login needs a new sign-in%',
		'needs a sign-in: ' || v_failure::text);
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_versions set authorization_state = 'active' where connection_id = v_connection and version = 2;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
	from public.qorpera_provider_connection_versions v where connection_id = v_connection and version = 2;
	set local session_replication_role = origin;
	v_failure := public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.');
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'not_allowed_away'
		and v_failure ->> 'reason' = 'login_not_allowed_away', 'no work while away: ' || v_failure::text);
	-- Such a login is no choice for a session either.
	perform pg_temp.base_assert(pg_temp.cl_logins() -> 'logins' = '[]'::jsonb, 'nothing to choose: ' || pg_temp.cl_logins()::text);
	set local session_replication_role = replica;
	delete from public.qorpera_provider_connection_versions where connection_id = v_connection and version = 3;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_coding_session_login_state(w) = 'ready', 'ready again');
end $$;

-- 7. The API reaches the two member functions only; every new or patched body names this migration -------------------
do $$
declare v_role text; v_name text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_name in array array['public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)',
			'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)',
			'public.qorpera_coding_session_login_candidates(public.qorpera_runtime_workers,text)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_name, 'execute'), v_role || ' calls ' || v_name);
		end loop;
		foreach v_name in array array['public.qorpera_list_coding_session_logins(uuid)',
			'public.qorpera_choose_coding_session_login(uuid,uuid)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_name, 'execute') = (v_role = 'authenticated'),
				v_role || ' and ' || v_name);
		end loop;
	end loop;
	foreach v_name in array array['public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)',
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)',
		'public.qorpera_coding_session_login_candidates(public.qorpera_runtime_workers,text)',
		'public.qorpera_list_coding_session_logins(uuid)', 'public.qorpera_choose_coding_session_login(uuid,uuid)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_coding_session_view(public.qorpera_coding_sessions,public.qorpera_runtime_workers)'] loop
		perform pg_temp.base_assert(position('20260930551000' in pg_get_functiondef(v_name::regprocedure)) > 0, v_name || ' names 20260930551000');
	end loop;
end $$;

rollback;
