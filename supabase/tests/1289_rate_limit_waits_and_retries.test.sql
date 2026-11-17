-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 1. The receipts read"

create function pg_temp.rl_id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
	select ('1289' || lpad(p_kind::text, 4, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.rl_job() returns public.qorpera_runner_jobs language sql as $$
	select * from public.qorpera_runner_jobs where run_id = pg_temp.rr_run()
$$;
create function pg_temp.rl_connection() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.rl_key() returns text language sql as $$
	select public.qorpera_run_provider_account_key(pg_temp.rr_run())
$$;
create function pg_temp.rl_cooldown() returns public.qorpera_provider_account_cooldowns language sql as $$
	select * from public.qorpera_provider_account_cooldowns where account_key = pg_temp.rl_key()
$$;
create function pg_temp.rl_admits(p_run uuid) returns boolean language sql as $$
	select public.qorpera_provider_account_turn_admits(run) from public.qorpera_execution_runs as run where run.id = p_run
$$;
create function pg_temp.rl_claim() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
		extensions.gen_random_uuid(), 120);
end
$$;
create function pg_temp.rl_turned_away(p_binding jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(p_binding, 'rate_limited');
	return pg_temp.rr_fail(p_binding,
		'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]');
end
$$;
create function pg_temp.rl_ready() returns void language plpgsql as $$
begin
	update public.qorpera_runner_jobs set dispatch_deferred_until = clock_timestamp() - interval '1 second',
		queued_at = clock_timestamp() - interval '1 second'
	where id = (pg_temp.rl_job()).id;
	update public.qorpera_provider_account_cooldowns set cool_until = clock_timestamp() - interval '1 second';
end
$$;
create function pg_temp.rl_as_member(p_sql text) returns jsonb language plpgsql as $$
declare v_answer jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_answer;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_answer;
end
$$;
create function pg_temp.rl_activity() returns jsonb language sql as $$
	select row from jsonb_array_elements(pg_temp.rl_as_member(
			'select public.qorpera_list_staff_execution_activity(''92400000-0000-4000-8000-000000000020'')')) as row
	where row ->> 'run_id' = pg_temp.rr_run()::text
$$;
create function pg_temp.rl_recovery() returns jsonb language sql as $$
	select pg_temp.rl_as_member(format('select public.qorpera_get_execution_run_recovery(%L)', pg_temp.rr_run()))
$$;
create function pg_temp.rl_connection_of(p_n integer, p_identity text) returns uuid language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, status,
		created_by_user_id)
	values (pg_temp.rl_id(1, p_n), pg_temp.rl_id(2, p_n), pg_temp.rl_id(3, p_n), '92400000-0000-4000-8000-000000000001',
		'openai', 'active', '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions, to_jsonb(existing)
		|| jsonb_build_object('connection_id', pg_temp.rl_id(1, p_n), 'version', 1,
			'credential_capsule_id', pg_temp.rl_id(4, p_n)))).*
	from public.qorpera_provider_connection_versions as existing
	where existing.connection_id = pg_temp.rl_connection() and existing.version = 2;
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
	values (pg_temp.rl_id(1, p_n), 1, p_identity);
	set local session_replication_role = origin;
	return pg_temp.rl_id(1, p_n);
end
$$;
create function pg_temp.rl_run(p_n integer, p_connection uuid, p_version bigint) returns uuid language plpgsql as $$
declare v_run public.qorpera_execution_runs;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
	set local session_replication_role = replica;
	insert into public.qorpera_execution_sponsor_versions
	select (jsonb_populate_record(null::public.qorpera_execution_sponsor_versions, to_jsonb(sponsor)
		|| jsonb_build_object('binding_id', pg_temp.rl_id(5, p_n), 'provider_connection_id', p_connection,
			'provider_connection_version', p_version))).*
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(null::public.qorpera_execution_runs, to_jsonb(v_run)
		|| jsonb_build_object('id', pg_temp.rl_id(6, p_n), 'job_id', pg_temp.rl_id(7, p_n), 'source_id', pg_temp.rl_id(8, p_n),
			'sponsor_binding_id', pg_temp.rl_id(5, p_n)))).*;
	set local session_replication_role = origin;
	return pg_temp.rl_id(6, p_n);
end
$$;
create function pg_temp.rl_lease(p_n integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs
	select (jsonb_populate_record(null::public.qorpera_runner_jobs, current_setting('qorpera_test.rl_leased')::jsonb
		|| jsonb_build_object('id', pg_temp.rl_id(7, p_n), 'run_id', pg_temp.rl_id(6, p_n), 'client_job_id', pg_temp.rl_id(9, p_n),
			'client_lease_id', pg_temp.rl_id(10, p_n), 'lease_expires_at', clock_timestamp() + interval '1 hour'))).*;
	set local session_replication_role = origin;
end
$$;
create function pg_temp.rl_wake(p_n integer, p_changes jsonb) returns uuid language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_wake_occurrences
	select (jsonb_populate_record(null::public.qorpera_wake_occurrences, to_jsonb(wake)
		|| jsonb_build_object('id', pg_temp.rl_id(11, p_n), 'run_id', pg_temp.rl_id(6, p_n),
			'occurrence_key', 'rl-' || p_n) || p_changes)).*
	from public.qorpera_wake_occurrences as wake where wake.run_id = pg_temp.rr_run();
	set local session_replication_role = origin;
	return pg_temp.rl_id(11, p_n);
end
$$;

set local session_replication_role = replica;
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
values (pg_temp.rl_connection(), 2, repeat('a', 64))
on conflict (connection_id, connection_version) do update set provider_account_identity = excluded.provider_account_identity;
set local session_replication_role = origin;
select pg_temp.rl_connection_of(2, repeat('a', 64)), pg_temp.rl_connection_of(3, repeat('c', 64)) \g /dev/null
select pg_temp.rl_run(2, pg_temp.rl_id(1, 2), 1), pg_temp.rl_run(3, pg_temp.rl_id(1, 3), 1),
	pg_temp.rl_run(4, pg_temp.rl_id(1, 2), 1) \g /dev/null

do $$
declare v_role text;
begin
	perform pg_temp.base_assert(pg_temp.rl_key() = public.qorpera_provider_account_key(pg_temp.rl_id(1, 2), 1)
		and pg_temp.rl_key() = public.qorpera_run_provider_account_key(pg_temp.rl_id(6, 4))
		and pg_temp.rl_key() like 'openai:identity:' || repeat('a', 64) || ':member:92400000-0000-4000-8000-000000000001'
		and public.qorpera_provider_account_key(pg_temp.rl_id(1, 3), 1) <> pg_temp.rl_key(),
		'one account behind two companies'' logins is one key, another account another: ' || coalesce(pg_temp.rl_key(), 'none'));
	perform pg_temp.base_assert(public.qorpera_provider_account_key(extensions.gen_random_uuid(), 1) like 'connection:%',
		'a login with no account reading is its own key');
	perform pg_temp.base_assert((select max_concurrent_turns = 6 and rate_limit_waits = 5
		from public.qorpera_provider_account_turn_settings), 'the defaults');
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(v_role, 'public.qorpera_provider_account_turn_admits(public.qorpera_execution_runs,boolean)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_provider_account_rate_limited(text,timestamp with time zone)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_rate_limit_wait_until(uuid)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_run_rate_limited(uuid)', 'EXECUTE')
			and not has_table_privilege(v_role, 'public.qorpera_provider_account_cooldowns', 'SELECT')
			and not has_table_privilege(v_role, 'public.qorpera_provider_account_turn_settings', 'UPDATE'),
			'nothing of it is ' || v_role || '''s to call');
	end loop;
end
$$;

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_job public.qorpera_runner_jobs;
	v_pause jsonb; v_cooldown public.qorpera_provider_account_cooldowns; v_activity jsonb;
begin
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.base_assert(not public.qorpera_run_had_effect(pg_temp.rr_run()), 'the run has had no effect yet');
	perform pg_temp.rl_turned_away(v_binding);
	v_job := pg_temp.rl_job();
	v_cooldown := pg_temp.rl_cooldown();
	perform pg_temp.base_assert(v_cooldown.strikes = 1 and v_cooldown.cool_until = statement_timestamp() + interval '1 minute',
		'the account cools for a minute: ' || to_jsonb(v_cooldown)::text);
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 0
		and v_job.dispatch_deferred_until >= v_cooldown.cool_until
		and v_job.dispatch_deferred_until <= statement_timestamp() + interval '72 seconds',
		'the run waits about a minute, not spending an attempt: ' || to_jsonb(v_job)::text);
	select payload into strict v_pause from public.qorpera_execution_run_events
	where run_id = pg_temp.rr_run() and event_type = 'run_paused';
	perform pg_temp.base_assert(v_pause ->> 'pausedFor' = 'rate_limited'
		and v_pause ->> 'assignmentId' = v_binding ->> 'assignmentId'
		and (v_pause ->> 'resetsAt')::timestamptz = v_job.dispatch_deferred_until
		and v_pause ->> 'providerConnectionId' = pg_temp.rl_connection()::text, 'one rate-limit pause: ' || v_pause::text);
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') = 0
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 0
		and (select status from public.qorpera_wake_occurrences where run_id = pg_temp.rr_run()) = 'materialized',
		'nothing waits for review and the wake stays with its run');
	v_activity := pg_temp.rl_activity();
	perform pg_temp.base_assert(v_activity ->> 'paused_for' = 'rate_limited'
		and (v_activity ->> 'paused_until')::timestamptz = v_job.dispatch_deferred_until
		and v_activity -> 'movable' = 'false', 'the activity says it waits for a rate limit: ' || coalesce(v_activity::text, 'none'));
	perform pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(
			(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid) = 0
		and (pg_temp.rl_job()).dispatch_deferred_until = v_job.dispatch_deferred_until,
		'a usage reading with room does not end a rate-limit wait');
	perform pg_temp.base_assert(public.qorpera_provider_account_rate_limited(pg_temp.rl_key(), null) = v_cooldown.cool_until
		and (pg_temp.rl_cooldown()).strikes = 1, 'another turn turned away in the same cool-down adds nothing');
end
$$;
select pg_temp.base_error(format('select pg_temp.rl_as_member(%L)', format('select public.qorpera_move_paused_run(%L, %L)',
	pg_temp.rr_run(), pg_temp.rl_id(1, 2))), '55000', 'This work is not waiting for a usage limit') \g /dev/null

do $$
begin
	update public.qorpera_runner_jobs set dispatch_deferred_until = clock_timestamp() - interval '1 second'
	where id = (pg_temp.rl_job()).id;
	perform pg_temp.base_assert(pg_temp.rl_claim() = 'null'::jsonb, 'the claim leaves it while its account cools');
	perform pg_temp.base_assert(not pg_temp.rl_admits(pg_temp.rl_id(6, 2)) and pg_temp.rl_admits(pg_temp.rl_id(6, 3)),
		'the cool-down holds the same account''s login in another company, not another account');
end
$$;

do $$
declare v_next jsonb;
begin
	perform pg_temp.rl_ready();
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.base_assert(pg_temp.rr_begin(v_next) ->> 'leaseId' = v_next ->> 'leaseId'
		and (select provider_connection_id from public.qorpera_native_provider_connection_leases
			where id = (v_next ->> 'leaseId')::uuid) = pg_temp.rl_connection(), 'the next attempt starts on the same login');
	perform pg_temp.base_assert(pg_temp.rr_read(v_next) ->> 'why' = 'limit_reset'
		and pg_temp.rr_read(v_next) -> 'receipts' = '[]'::jsonb, 'it is told it comes back after a wait, with nothing done');
	perform pg_temp.rr_record(v_next, jsonb_build_object('stepsRead', 0, 'unknownCalls', '[]'::jsonb));
	perform set_config('qorpera_test.rl_next', v_next::text, true);
	perform set_config('qorpera_test.rl_leased', to_jsonb(pg_temp.rl_job())::text, true);
end
$$;

savepoint rl_effect;
do $$
declare v_next jsonb := current_setting('qorpera_test.rl_next')::jsonb; v_recovery jsonb;
begin
	perform pg_temp.base_public_send(v_next, 'progress', 'rl-ack');
	perform pg_temp.base_assert(public.qorpera_run_had_effect(pg_temp.rr_run()), 'a progress message is an effect');
	perform pg_temp.rl_turned_away(v_next);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed'
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 1
		and pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') > 0, 'a run with an effect keeps today''s path');
	v_recovery := pg_temp.rl_recovery();
	perform pg_temp.base_assert(v_recovery -> 'rate_limited' = 'true' and v_recovery -> 'usage_limit' = 'false',
		'its recovery says ChatGPT turned it away: ' || v_recovery::text);
end
$$;
rollback to savepoint rl_effect;

savepoint rl_cap;
do $$
begin
	update public.qorpera_provider_account_turn_settings set max_concurrent_turns = 1;
	perform pg_temp.rl_lease(2);
	perform pg_temp.base_assert(public.qorpera_provider_account_busy_turns(pg_temp.rl_key(), null) = 2,
		'two turns of the account run, in two companies');
	perform pg_temp.base_assert(not pg_temp.rl_admits(pg_temp.rl_id(6, 4)) and pg_temp.rl_admits(pg_temp.rl_id(6, 3)),
		'a full account takes no other turn; another account does');
	perform pg_temp.rl_wake(4, jsonb_build_object('source_kind', 'worker-dispatch', 'parent_run_id', pg_temp.rl_id(6, 2)));
	perform pg_temp.base_assert(pg_temp.rl_admits(pg_temp.rl_id(6, 4)), 'a running parent''s worker borrows its turn');
	update public.qorpera_provider_account_cooldowns set cool_until = clock_timestamp() + interval '1 minute';
	perform pg_temp.base_assert(not pg_temp.rl_admits(pg_temp.rl_id(6, 4)), 'but waits while the account cools');
end
$$;
rollback to savepoint rl_cap;

do $$
declare v_next jsonb := current_setting('qorpera_test.rl_next')::jsonb; v_job public.qorpera_runner_jobs;
	v_cooldown public.qorpera_provider_account_cooldowns;
begin
	perform pg_temp.rl_turned_away(v_next);
	v_job := pg_temp.rl_job();
	v_cooldown := pg_temp.rl_cooldown();
	perform pg_temp.base_assert(v_cooldown.strikes = 2 and v_cooldown.cool_until = statement_timestamp() + interval '2 minutes',
		'turned away again soon after: the account cools longer: ' || to_jsonb(v_cooldown)::text);
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.dispatch_deferred_until >= v_cooldown.cool_until
		and v_job.dispatch_deferred_until <= statement_timestamp() + interval '144 seconds'
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 2, 'the second wait is about two minutes: ' || to_jsonb(v_job)::text);
end
$$;

savepoint rl_cap_claim;
do $$
begin
	perform pg_temp.rl_ready();
	update public.qorpera_provider_account_turn_settings set max_concurrent_turns = 1;
	perform pg_temp.rl_lease(2);
	perform pg_temp.base_assert(pg_temp.rl_claim() = 'null'::jsonb, 'a full account''s run stays in the queue');
end
$$;
rollback to savepoint rl_cap_claim;
savepoint rl_other_account;
do $$
begin
	perform pg_temp.rl_ready();
	update public.qorpera_provider_account_turn_settings set max_concurrent_turns = 1;
	perform pg_temp.rl_lease(3);
	perform pg_temp.base_assert(pg_temp.rl_claim() #>> '{work,run_id}' = pg_temp.rr_run()::text,
		'another account''s turn does not hold it');
end
$$;
rollback to savepoint rl_other_account;
savepoint rl_skip;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.rl_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', pg_temp.rl_id(20, 1), pg_temp.rl_id(20, 2),
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('d', 64),
	900)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.rl_second', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.rl_login')::jsonb ->> 'login_id')::uuid, repeat('d', 64), pg_temp.rl_id(20, 3),
	'object://native-capsules/' || pg_temp.rl_id(20, 3), repeat('e', 64), 'fixture-openai-account-two',
	'personal-subscription', 'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,
	true) \g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(existing) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions as existing
where existing.connection_id = (current_setting('qorpera_test.rl_second')::jsonb ->> 'connection_id')::uuid
	and existing.version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.rl_second_sponsor', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', pg_temp.rl_id(20, 4),
	(current_setting('qorpera_test.rl_second')::jsonb ->> 'connection_id')::uuid, 2, true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_pass jsonb; v_claim jsonb;
begin
	perform pg_temp.rl_ready();
	perform public.qorpera_provider_account_rate_limited(pg_temp.rl_key(), clock_timestamp() + interval '10 minutes');
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Check the numbers.', (current_setting('qorpera_test.rl_second_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1
		and public.qorpera_run_provider_account_key((v_pass -> 'run_ids' ->> 0)::uuid) <> pg_temp.rl_key(),
		'a newer run on another account is queued: ' || v_pass::text);
	v_claim := pg_temp.rl_claim();
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = v_pass -> 'run_ids' ->> 0,
		'the claim passes over the older run of the cooling account to the other account''s: ' || coalesce(v_claim::text, 'none'));
end
$$;
rollback to savepoint rl_skip;

do $$
declare v_next jsonb; v_recovery jsonb;
begin
	update public.qorpera_provider_account_turn_settings set rate_limit_waits = 2;
	perform pg_temp.rl_ready();
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.rr_begin(v_next);
	perform pg_temp.rl_turned_away(v_next);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed' and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 2
		and pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') > 0
		and (select status from public.qorpera_wake_occurrences where run_id = pg_temp.rr_run()) = 'requires_review',
		'after its last wait the run fails as today');
	perform pg_temp.base_assert(public.qorpera_run_rate_limited(pg_temp.rr_run()), 'it ended turned away');
	v_recovery := pg_temp.rl_recovery();
	perform pg_temp.base_assert(v_recovery -> 'rate_limited' = 'true' and v_recovery -> 'usage_limit' = 'false',
		'its recovery says ChatGPT turned it away: ' || v_recovery::text);
	perform pg_temp.base_assert((pg_temp.rl_cooldown()).strikes = 3, 'the account cools longer each time');
end
$$;

do $$
declare v_run public.qorpera_execution_runs; v_routine uuid := pg_temp.rl_id(12, 1); v_result jsonb;
	v_wake public.qorpera_wake_occurrences; v_n integer; v_until timestamptz;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin, owner_staff_agent_id, routine_key)
	values (v_routine, v_run.profile_id, v_run.environment_id, extensions.gen_random_uuid(), 1, 'active',
		'92400000-0000-4000-8000-000000000001', 'agent', '92400000-0000-4000-8000-000000000030', 'r-rate-limit');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values (v_routine, 1, extensions.gen_random_uuid(), v_run.profile_id, v_run.environment_id,
		'92400000-0000-4000-8000-000000000030', 'Check in', 'Check the numbers.',
		'[{"id":"t1","kind":"once","at":"2026-10-01T09:00:00Z","timeZone":"UTC"}]', 'medium', v_run.sponsor_binding_id,
		v_run.sponsor_version, repeat('e', 64), '92400000-0000-4000-8000-000000000001');
	set local session_replication_role = origin;
	for v_n in 21..23 loop
		perform pg_temp.rl_run(v_n, pg_temp.rl_connection(), 2);
		perform pg_temp.rl_wake(v_n, jsonb_build_object('wake_kind', 'routine', 'source_kind', 'schedule',
			'routine_id', v_routine, 'routine_version', 1, 'trigger_id', 't1', 'occurrence_key', 'once:1:' || (v_n - 20),
			'status', 'requires_review', 'finished_at', clock_timestamp(), 'payload', '{}'::jsonb, 'parent_run_id', null,
			'created_at', clock_timestamp() - make_interval(mins => 30 - v_n)));
		set local session_replication_role = replica;
		insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id,
			sponsor_version, provider_connection_id, provider_connection_version, provider, signal_kind, source, assignment_id)
		select run.profile_id, run.id, run.job_id, run.sponsor_binding_id, run.sponsor_version, pg_temp.rl_connection(), 2,
			'openai', 'rate_limited', 'native_adapter', extensions.gen_random_uuid()
		from public.qorpera_execution_runs as run where run.id = pg_temp.rl_id(6, v_n);
		set local session_replication_role = origin;
	end loop;
	perform pg_temp.base_assert(public.qorpera_routine_turned_away_runs(v_routine, 1) = 3,
		'three runs of the routine were turned away');
	update public.qorpera_provider_account_cooldowns set cool_until = clock_timestamp() + interval '5 minutes'
	returning cool_until into v_until;
	perform pg_temp.base_claims('service_role');
	v_result := public.qorpera_folder_restore_dynamic_routine_run(v_routine, 1);
	select * into v_wake from public.qorpera_wake_occurrences where id = (v_result ->> 'occurrence_id')::uuid;
	perform pg_temp.base_assert(v_result ->> 'status' = 'inserted' and v_wake.occurrence_key = 'once:1:4'
		and v_wake.payload ->> 'attempt' = '1' and v_wake.not_before = v_until,
		'the routine''s next run is its first attempt, after the account''s cool-down: ' || v_result::text || ' / '
		|| coalesce(to_jsonb(v_wake)::text, 'none'));
end
$$;

set constraints all immediate;
rollback;
