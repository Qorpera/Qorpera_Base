-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The member is told when their login's usage limit stops the work (launch checklist L29.1; contract section 21 item 29:
-- "the member is notified, the affected run fails without moving to another login, its recovery read names the usage
-- limit ... A rate limit or a provider outage is not a usage limit and does not show the usage-limit message. No other
-- member's credential is ever used."). Alice's run of test 924, and runs of Bob's and Carol's, are paid by the owner's
-- own Codex login. Only the node host records a provider signal. A rate limit and an outage on Bob's run notify nobody,
-- and his failed run's recovery names no usage limit. The usage limit on Alice's run gives the owner, and only the
-- owner, one notice naming the login, the run and the reset, with no prompt or provider text; a replay or a second
-- limit on the same login adds no second open notice, and only the owner can mark it read. The runner then fails
-- Alice's run: it stays on the owner's login and is not queued again, and its recovery read gives the thread what it
-- needs to say why the work stopped (the web's words are tested in run-failure.test.ts and conversation-ui.test.ts).

create function pg_temp.ul_run(p_staff uuid) returns jsonb language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, 'Draft the weekly note.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'fixture: a run: ' || v_pass::text);
	return pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
end
$$;
-- The node host's calls: a provider signal on a run's binding, and the runner's failure report.
create function pg_temp.ul_signal(p_binding jsonb, p_kind text, p_resets timestamptz default null) returns jsonb language plpgsql as $$
declare v_receipt jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_receipt := public.qorpera_record_provider_usage_signal(p_binding, p_kind, p_resets);
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
-- A member's reads: their notices in the company, and a run's recovery.
create function pg_temp.ul_notices(p_user uuid) returns jsonb language plpgsql as $$
declare v_notices jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_notices := public.qorpera_list_member_notifications('92400000-0000-4000-8000-000000000010');
	reset role;
	return v_notices;
end
$$;
create function pg_temp.ul_recovery(p_run uuid) returns jsonb language plpgsql as $$
declare v_recovery jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_recovery := public.qorpera_get_execution_run_recovery(p_run);
	reset role;
	return v_recovery;
end
$$;

-- Bob's and Carol's runs start on the same login before any signal.
select set_config('qorpera_test.ul_bob', pg_temp.ul_run('92400000-0000-4000-8000-000000000031')::text, true) \g /dev/null
select set_config('qorpera_test.ul_carol', pg_temp.ul_run('92400000-0000-4000-8000-000000000032')::text, true) \g /dev/null
select set_config('qorpera_test.ul_resets', (date_trunc('second', statement_timestamp()) + interval '3 hours')::text, true) \g /dev/null
select set_config('qorpera_test.ul_version', sponsor_version::text, true)
from public.qorpera_execution_runs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid \g /dev/null

-- 1. Only the node host records a signal, of a known kind with a near reset; a member's own login cannot.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_error(format('select public.qorpera_record_provider_usage_signal(%L, %L)',
	current_setting('qorpera_test.base_binding'), 'usage_limit'), '42501');
reset role;
select pg_temp.base_error(format('select pg_temp.ul_signal(%L, %L)', current_setting('qorpera_test.base_binding'), 'quota'),
	'22023', 'Provider usage signal is invalid');
select pg_temp.base_error(format('select pg_temp.ul_signal(%L, %L, %L)', current_setting('qorpera_test.base_binding'), 'usage_limit',
	statement_timestamp() + interval '91 days'), '22023', 'Provider usage signal is invalid');

-- 2. A rate limit and an outage are not a usage limit: nobody is notified, and the failed run's recovery names none.
do $$
declare v_bob jsonb := current_setting('qorpera_test.ul_bob')::jsonb; v_receipt jsonb; v_recovery jsonb;
begin
	foreach v_receipt in array array[pg_temp.ul_signal(v_bob, 'rate_limited'), pg_temp.ul_signal(v_bob, 'provider_outage')] loop
		perform pg_temp.base_assert(v_receipt ->> 'runId' = v_bob ->> 'runId' and v_receipt -> 'notifiedUserIds' = '[]'::jsonb
			and (v_receipt ->> 'replayed')::boolean is false, 'a signal that is not a usage limit notifies nobody: ' || v_receipt::text);
	end loop;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_member_notifications
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'no notice after a rate limit or an outage');
	perform pg_temp.ul_fail(v_bob, 'Native provider bridge request failed (429) [code=RATE_LIMITED]');
	v_recovery := pg_temp.ul_recovery((v_bob ->> 'runId')::uuid);
	perform pg_temp.base_assert(v_recovery #>> '{job,status}' = 'failed' and (v_recovery ->> 'usage_limit')::boolean is false,
		'a run failed at a rate limit names no usage limit: ' || jsonb_build_object('job', v_recovery #>> '{job,status}',
			'usage_limit', v_recovery -> 'usage_limit')::text);
end
$$;

-- 3. The usage limit on Alice's run notifies the login's owner once; a replay is the same signal and notice.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_resets timestamptz := current_setting('qorpera_test.ul_resets')::timestamptz;
	v_first jsonb := pg_temp.ul_signal(v_binding, 'usage_limit', v_resets); v_replay jsonb := pg_temp.ul_signal(v_binding, 'usage_limit', v_resets);
begin
	perform pg_temp.base_assert(v_first ->> 'runId' = v_binding ->> 'runId' and (v_first ->> 'replayed')::boolean is false
		and v_first -> 'notifiedUserIds' = '["92400000-0000-4000-8000-000000000001"]'::jsonb
		and v_first ->> 'providerConnectionId' = current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'
		and (v_first ->> 'resetsAt')::timestamptz = v_resets, 'the usage limit notifies the login''s owner: ' || v_first::text);
	perform pg_temp.base_assert((v_replay ->> 'replayed')::boolean and v_replay ->> 'signalId' = v_first ->> 'signalId',
		'a replay is the same signal: ' || v_replay::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_member_notifications
		where profile_id = '92400000-0000-4000-8000-000000000010') = 1, 'one notice in the company');
	perform set_config('qorpera_test.ul_signal', v_first ->> 'signalId', true);
end
$$;

-- 4. The owner reads one notice naming the login, the run and the reset, and nothing else; no other member reads one.
do $$
declare v_notices jsonb := pg_temp.ul_notices('92400000-0000-4000-8000-000000000001'); v_subject jsonb := v_notices -> 0 -> 'subject';
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_user uuid;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_notices) = 1 and v_notices -> 0 ->> 'kind' = 'provider_usage_limit'
		and v_notices -> 0 ->> 'schema' = 'qorpera.member-notification/v1' and v_notices -> 0 -> 'acknowledged_at' = 'null'::jsonb,
		'the owner has one open usage-limit notice: ' || v_notices::text);
	perform pg_temp.base_assert(v_subject ->> 'schema' = 'qorpera.member-notification.provider-usage-limit/v1'
		and v_subject ->> 'signalId' = current_setting('qorpera_test.ul_signal')
		and v_subject ->> 'connectionId' = current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'
		and (v_subject ->> 'connectionVersion')::bigint = 2 and v_subject ->> 'provider' = 'openai'
		and v_subject ->> 'runId' = v_binding ->> 'runId'
		and v_subject ->> 'sponsorBindingId' = current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id'
		and (v_subject ->> 'sponsorVersion')::bigint = current_setting('qorpera_test.ul_version')::bigint
		and (v_subject ->> 'resetsAt')::timestamptz = current_setting('qorpera_test.ul_resets')::timestamptz,
		'the notice names the login, the run and the reset: ' || v_subject::text);
	perform pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(v_subject) key)
		= array['accountEmail', 'connectionId', 'connectionVersion', 'movedTo', 'provider', 'resetsAt', 'runId', 'schema',
			'signalId', 'sponsorBindingId', 'sponsorVersion'], 'the notice carries identities only: ' || v_subject::text);
	-- 20260930575000: the login's email (none recorded here) and the owner's login work moves to (none with room here).
	perform pg_temp.base_assert(v_subject -> 'accountEmail' = 'null'::jsonb and v_subject -> 'movedTo' = 'null'::jsonb,
		'the notice names no other login when none has room: ' || v_subject::text);
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000004']::uuid[] loop
		perform pg_temp.base_assert(pg_temp.ul_notices(v_user) = '[]'::jsonb, 'another member has no notice: ' || v_user);
	end loop;
	perform pg_temp.base_error(format('select pg_temp.ul_notices(%L)', '92400000-0000-4000-8000-000000000005'), '42501',
		'member notification access denied');
	perform set_config('qorpera_test.ul_notice', v_notices -> 0 ->> 'notification_id', true);
end
$$;

-- 5. A second limit on the same login, on Carol's run, adds no second open notice; only the owner marks it read.
do $$
declare v_receipt jsonb := pg_temp.ul_signal(current_setting('qorpera_test.ul_carol')::jsonb, 'usage_limit'); v_notices jsonb;
begin
	perform pg_temp.base_assert((v_receipt ->> 'replayed')::boolean is false and v_receipt ->> 'signalId' <> current_setting('qorpera_test.ul_signal'),
		'Carol''s run reached the limit too: ' || v_receipt::text);
	v_notices := pg_temp.ul_notices('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(jsonb_array_length(v_notices) = 1 and v_notices -> 0 ->> 'notification_id' = current_setting('qorpera_test.ul_notice'),
		'one open notice per login: ' || v_notices::text);
end
$$;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.base_error(format('select public.qorpera_acknowledge_member_notification(%L)', current_setting('qorpera_test.ul_notice')),
	'42501', 'member notification is unavailable');
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_acknowledge_member_notification(current_setting('qorpera_test.ul_notice')::uuid) \g /dev/null
reset role;
select pg_temp.base_assert((pg_temp.ul_notices('92400000-0000-4000-8000-000000000001') -> 0 ->> 'acknowledged_at') is not null,
	'the owner marked the notice read');

-- 6. The runner fails Alice's run: it stops on the owner's login, keeps its binding version, and is not queued again.
select pg_temp.ul_fail(current_setting('qorpera_test.base_binding')::jsonb,
	'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs;
	v_connection uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid; v_recovery jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.base_assert((select status from public.qorpera_runner_jobs where id = v_run.job_id) = 'failed'
		and not exists (select 1 from public.qorpera_runner_jobs where run_id = v_run.id and status = 'queued'),
		'the run at its usage limit failed and is not queued again');
	perform pg_temp.base_assert(v_run.sponsor_version = current_setting('qorpera_test.ul_version')::bigint
		and not exists (select 1 from public.qorpera_execution_sponsor_versions
			where binding_id = v_run.sponsor_binding_id and version > v_run.sponsor_version)
		and (select provider_connection_id from public.qorpera_execution_sponsor_versions
			where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version) = v_connection,
		'the run keeps its binding version, on the owner''s login');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_native_provider_connection_leases
			where run_id = v_run.id and provider_connection_id <> v_connection)
		and not exists (select 1 from public.qorpera_native_provider_connection_lease_history
			where run_id = v_run.id and provider_connection_id <> v_connection)
		and not exists (select 1 from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'sponsor_handoff'),
		'no other login ever paid for the run');
	-- 7. The recovery read gives the thread its words: the usage limit, of a Codex login (not a ChatGPT plan), of the
	--    owner's own request.
	v_recovery := pg_temp.ul_recovery(v_run.id);
	perform pg_temp.base_assert((v_recovery ->> 'usage_limit')::boolean and (v_recovery ->> 'paid_by_chatgpt_plan')::boolean is false
		and v_recovery #>> '{run,requested_by_user_id}' = '92400000-0000-4000-8000-000000000001'
		and v_recovery #>> '{job,status}' = 'failed', 'the recovery read names the usage limit: ' || jsonb_build_object(
			'usage_limit', v_recovery -> 'usage_limit', 'paid_by_chatgpt_plan', v_recovery -> 'paid_by_chatgpt_plan',
			'requested_by', v_recovery #> '{run,requested_by_user_id}', 'job', v_recovery #> '{job,status}')::text);
end
$$;

rollback;
