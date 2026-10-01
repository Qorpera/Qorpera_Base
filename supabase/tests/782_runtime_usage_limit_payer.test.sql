-- @fixture 395_runtime_coding_sessions.test.sql until "-- 3. The session asks the owner something: the worker blocks, the parent is woken with the question,"
-- Sign in with ChatGPT, switch-on gate 2a (20260929993000): a run's recovery says whether a ChatGPT plan pays for it
-- (paid_by_chatgpt_plan), and a coding turn that stopped at its login's usage limit says so in its failed event
-- (usageLimit, paidByChatgptPlan). Test 395's fixture: the coding session 'fix-send' is leased, and its turn's run
-- (the worker's occurrence) is paid by the owner's own login.
create function pg_temp.run782() returns public.qorpera_execution_runs language sql as $$
	select run.* from public.qorpera_execution_runs as run
	where run.id = (select wake.run_id from public.qorpera_wake_occurrences as wake
		where wake.id = (pg_temp.worker_row('fix-send')).occurrence_id)
$$;
create function pg_temp.connection782() returns uuid language sql as $$
	select sponsor.provider_connection_id from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = (pg_temp.run782()).sponsor_binding_id and sponsor.version = (pg_temp.run782()).sponsor_version
$$;
-- The run's login becomes a ChatGPT plan's (rows written directly, as test 775 does).
create function pg_temp.plan782() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at, login_kind)
	select '78200000-0000-4000-8000-000000000001', connection.profile_id, extensions.gen_random_uuid(),
		version.credential_capsule_id, extensions.gen_random_uuid(), 'openai', 'codex-cli', 1, statement_timestamp(),
		statement_timestamp() + interval '1 hour', 'chatgpt_plan'
	from public.qorpera_provider_connections as connection
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
	where connection.id = pg_temp.connection782() order by version.version desc limit 1;
	set local session_replication_role = origin;
end $$;

-- 1. Kernel only: no API role may ask what a coding turn's run tells.
do $$
begin
	if has_function_privilege('anon', 'public.qorpera_coding_turn_usage_limit(uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_coding_turn_usage_limit(uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_coding_turn_usage_limit(uuid)', 'execute')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_coding_turn_usage_limit(uuid)', 'execute') then
		raise exception 'an API role may call qorpera_coding_turn_usage_limit'; end if;
end $$;

-- 2. A turn's run without a usage-limit signal tells nothing; with one for its pinned sponsor version, it tells the
--    limit and whether a plan pays; a signal for another sponsor version tells nothing.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.run782(); v_occurrence uuid := (pg_temp.worker_row('fix-send')).occurrence_id;
begin
	perform pg_temp.wake_assert(v_run.id is not null and public.qorpera_coding_turn_usage_limit(v_occurrence) = '{}'::jsonb,
		'A turn whose run reached no limit tells nothing');
	-- A signal for another sponsor version of the binding (written directly; the binding has no such version).
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source)
	select v_run.profile_id, v_run.id, v_run.job_id, v_run.sponsor_binding_id, v_run.sponsor_version + 1,
		sponsor.provider_connection_id, sponsor.provider_connection_version, 'openai', 'usage_limit', 'native_adapter'
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	set local session_replication_role = origin;
	perform pg_temp.wake_assert(public.qorpera_coding_turn_usage_limit(v_occurrence) = '{}'::jsonb,
		'A limit of another sponsor version is not this run''s');
	-- A rate limit on the run is no usage limit.
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source)
	select v_run.profile_id, v_run.id, v_run.job_id, v_run.sponsor_binding_id, v_run.sponsor_version,
		sponsor.provider_connection_id, sponsor.provider_connection_version, 'openai', 'rate_limited', 'native_adapter'
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	perform pg_temp.wake_assert(public.qorpera_coding_turn_usage_limit(v_occurrence) = '{}'::jsonb,
		'A rate limit is not a usage limit');
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source)
	select v_run.profile_id, v_run.id, v_run.job_id, v_run.sponsor_binding_id, v_run.sponsor_version,
		sponsor.provider_connection_id, sponsor.provider_connection_version, 'openai', 'usage_limit', 'native_adapter'
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	perform pg_temp.wake_assert(public.qorpera_coding_turn_usage_limit(v_occurrence)
		= '{"usageLimit": true, "paidByChatgptPlan": false}'::jsonb, 'A Codex login''s limit is told as a limit');
	perform pg_temp.plan782();
	perform pg_temp.wake_assert(public.qorpera_coding_turn_usage_limit(v_occurrence)
		= '{"usageLimit": true, "paidByChatgptPlan": true}'::jsonb, 'A plan''s limit is told as a plan''s');
end $$;

-- 3. The run's recovery says a plan pays for it, to a member who may read it.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.run782(); v_recovery jsonb;
begin
	-- The run stopped at the limit (the fixture had it finish; a recovery is read only for a failed run).
	set local session_replication_role = replica;
	perform pg_temp.finish_job(v_run.id, 'failed');
	set local session_replication_role = origin;
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
	v_recovery := public.qorpera_get_execution_run_recovery(v_run.id);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((v_recovery ->> 'usage_limit')::boolean and (v_recovery ->> 'paid_by_chatgpt_plan')::boolean,
		'The recovery tells the limit and that a plan pays');
	delete from public.qorpera_model_logins where id = '78200000-0000-4000-8000-000000000001';
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
	v_recovery := public.qorpera_get_execution_run_recovery(v_run.id);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(v_recovery ? 'paid_by_chatgpt_plan' and not (v_recovery ->> 'paid_by_chatgpt_plan')::boolean,
		'A Codex login''s run reads as no plan');
	perform pg_temp.plan782();
end $$;

-- 4. The executor fails the turn: its failed event carries the limit and the plan; the report and the session are
--    as before.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_session public.qorpera_coding_sessions := pg_temp.session_row('fix-send');
	v_body jsonb;
begin
	-- A turn that asks a question tells no limit, even when its run has one (undone, so the turn can still fail).
	begin
		perform public.qorpera_complete_coding_turn(v_worker.id, v_session.lease_token, 'blocked', 'Which branch?', 'Which branch?');
		select event.body into strict v_body from public.qorpera_coding_session_events as event
		where event.worker_id = v_worker.id and event.kind = 'needs_input';
		perform pg_temp.wake_assert(not (v_body ? 'usageLimit'), 'A turn that asks tells no limit');
		raise exception 'undo' using errcode = 'Q7820';
	exception when sqlstate 'Q7820' then null;
	end;
	perform public.qorpera_complete_coding_turn(v_worker.id, v_session.lease_token, 'failed',
		'The coding turn did not finish: Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]');
	select event.body into strict v_body from public.qorpera_coding_session_events as event
	where event.worker_id = v_worker.id and event.kind = 'failed';
	perform pg_temp.wake_assert(v_body = jsonb_build_object('summary',
		'The coding turn did not finish: Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]',
		'needs', null, 'usageLimit', true, 'paidByChatgptPlan', true), 'The failed event tells the limit and the plan');
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).state = 'failed' and not ((pg_temp.worker_row('fix-send')).result ? 'usageLimit')
		and (pg_temp.session_row('fix-send')).phase = 'failed', 'The worker''s report and the session are as before');
end $$;

rollback;
