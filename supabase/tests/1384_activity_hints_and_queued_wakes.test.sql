-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- WHY: Verify 20260930902000 activity live hints on job status changes, message_composition inserts, and queued wake
-- visibility in qorpera_list_staff_execution_activity before materialization.

create function pg_temp.ah_clear_hints() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;

create function pg_temp.ah_flush_hints() returns void language plpgsql as $$
begin
	set constraints qorpera_activity_hint, qorpera_activity_hint_status immediate;
	set constraints qorpera_activity_hint, qorpera_activity_hint_status deferred;
end $$;

create function pg_temp.ah_activity_hints() returns integer language sql as $$
	select count(*)::integer
	from realtime.messages
	where topic like 'qorpera-live-92400000-0000-4000-8000-000000000010-%'
		and event = 'activity'
		and extension = 'broadcast'
		and private = true
		and payload = '{"schema":"qorpera.live-hint/v1"}'::jsonb
$$;

create function pg_temp.ah_agent_rows(p_staff uuid) returns jsonb language plpgsql as $$
declare
	v_claims text := current_setting('request.jwt.claims', true);
	v_rows jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
	set local role authenticated;
	select coalesce(jsonb_agg(entry order by n), '[]'::jsonb) into v_rows
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020'))
		with ordinality as list(entry, n)
	where entry ->> 'staff_agent_id' = p_staff::text;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_rows;
end $$;

select pg_temp.base_claims('service_role');

do $$
declare
	v_role text;
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_run_id uuid := (v_binding ->> 'runId')::uuid;
	v_job_id uuid := (v_binding ->> 'jobId')::uuid;
	v_client_lease_id uuid;
	v_members integer;
	v_alice uuid := '92400000-0000-4000-8000-000000000030';
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_occurrences jsonb;
	v_wake_id uuid;
	v_rows jsonb;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(v_role, 'public.qorpera_activity_hint()', 'EXECUTE'),
			'qorpera_activity_hint is internal for ' || v_role
		);
	end loop;
	perform pg_temp.base_assert(
		has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'EXECUTE'),
		'activity RPC grants preserved'
	);

	select count(*)::integer into v_members
	from public.qorpera_profile_members
	where profile_id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.base_assert(v_members >= 3, 'fixture has company members');

	select client_lease_id into strict v_client_lease_id
	from public.qorpera_runner_jobs
	where id = v_job_id;

	-- WHY: Flush setup triggers before asserting per-event activity hint behavior.
	perform pg_temp.ah_flush_hints();
	perform pg_temp.ah_clear_hints();

	-- WHY: Lease heartbeat updates must not emit activity hints.
	update public.qorpera_runner_jobs
	set lease_expires_at = lease_expires_at + interval '10 seconds'
	where id = v_job_id;
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(pg_temp.ah_activity_hints() = 0, 'heartbeat lease update emits no activity hint');

	-- WHY: Non-composition runtime observations must not emit activity hints.
	insert into public.qorpera_runtime_observations (
		run_id, attempt_id, phase, assignment_id, operation, observed_at, observation
	) values (
		v_run_id, extensions.gen_random_uuid(), 'start', v_client_lease_id, 'company_read',
		clock_timestamp(), '{"schema":"qorpera.runtime-observation/v1"}'::jsonb
	);
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(pg_temp.ah_activity_hints() = 0, 'company_read observation emits no activity hint');

	-- WHY: message_composition start emits one activity hint per company member and flips phase to writing.
	insert into public.qorpera_runtime_observations (
		run_id, attempt_id, phase, assignment_id, operation, observed_at, observation
	) values (
		v_run_id, extensions.gen_random_uuid(), 'start', v_client_lease_id, 'message_composition',
		clock_timestamp(), '{"schema":"qorpera.runtime-observation/v1"}'::jsonb
	);
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(
		pg_temp.ah_activity_hints() = v_members,
		'message_composition start emits activity hint to all company members: ' || pg_temp.ah_activity_hints()
	);
	v_rows := pg_temp.ah_agent_rows(v_alice);
	perform pg_temp.base_assert(
		v_rows -> 0 ->> 'phase' = 'writing',
		'Alice phase flips to writing after message_composition start: ' || v_rows::text
	);

	-- WHY: Deliver required progress/final messages before marking the conversation job completed.
	perform pg_temp.base_public_send(v_binding, 'progress');
	perform pg_temp.base_public_send(v_binding, 'final');
	perform pg_temp.ah_flush_hints();
	perform pg_temp.ah_clear_hints();

	-- WHY: Job status transition emits an activity hint.
	update public.qorpera_runner_jobs
	set status = 'completed', result = '{}'::jsonb, finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = v_job_id;
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(
		pg_temp.ah_activity_hints() = v_members,
		'job status transition emits activity hint: ' || pg_temp.ah_activity_hints()
	);

	-- WHY: Posting to Bob's thread queues a wake that immediately appears in activity before materialization.
	perform pg_temp.ah_clear_hints();
	perform pg_temp.base_assert(pg_temp.ah_agent_rows(v_bob) = '[]'::jsonb, 'Bob starts idle');
	v_occurrences := pg_temp.base_post('92400000-0000-4000-8000-000000000001', v_bob, 'Draft the summary.');
	v_wake_id := (v_occurrences ->> 0)::uuid;
	perform set_config('qorpera_test.ah_wake_id', v_wake_id::text, true);
	perform set_config('qorpera_test.ah_members', v_members::text, true);
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(
		pg_temp.ah_activity_hints() = v_members,
		'queued wake insert emits activity hint: ' || pg_temp.ah_activity_hints()
	);

	v_rows := pg_temp.ah_agent_rows(v_bob);
	perform pg_temp.base_assert(
		jsonb_array_length(v_rows) = 1
		and (v_rows -> 0 ->> 'run_id')::uuid = v_wake_id
		and v_rows -> 0 ->> 'source_kind' = 'room_delivery'
		and v_rows -> 0 ->> 'job_status' = 'queued'
		and v_rows -> 0 ->> 'activity' = 'waiting'
		and not (v_rows -> 0 ? 'paused_until'),
		'queued wake immediately surfaces as waiting in activity: ' || v_rows::text
	);
end $$;

-- WHY: Blocked, stale, or future-scheduled wakes must not stay stuck showing working.
savepoint ah_blocked_wake;
update public.qorpera_wake_occurrences
set blocked_reason = 'Waiting for computer hours'
where id = current_setting('qorpera_test.ah_wake_id')::uuid;
select pg_temp.base_assert(
	pg_temp.ah_agent_rows('92400000-0000-4000-8000-000000000031') = '[]'::jsonb,
	'blocked wake does not surface as active'
) \g /dev/null
rollback to savepoint ah_blocked_wake;

savepoint ah_stale_wake;
set local session_replication_role = replica;
update public.qorpera_wake_occurrences
set created_at = statement_timestamp() - interval '10 minutes'
where id = current_setting('qorpera_test.ah_wake_id')::uuid;
set local session_replication_role = origin;
select pg_temp.base_assert(
	pg_temp.ah_agent_rows('92400000-0000-4000-8000-000000000031') = '[]'::jsonb,
	'stale queued wake expires from activity'
) \g /dev/null
rollback to savepoint ah_stale_wake;

savepoint ah_future_wake;
set local session_replication_role = replica;
update public.qorpera_wake_occurrences
set not_before = statement_timestamp() + interval '5 minutes'
where id = current_setting('qorpera_test.ah_wake_id')::uuid;
set local session_replication_role = origin;
select pg_temp.base_assert(
	pg_temp.ah_agent_rows('92400000-0000-4000-8000-000000000031') = '[]'::jsonb,
	'future-scheduled wake does not surface yet'
) \g /dev/null
rollback to savepoint ah_future_wake;

-- WHY: Once materialized, the real execution run cleanly replaces the queued wake entry.
do $$
declare
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_members integer := current_setting('qorpera_test.ah_members')::integer;
	v_pass jsonb;
	v_rows jsonb;
begin
	perform pg_temp.ah_clear_hints();
	v_pass := pg_temp.base_materialize();
	perform pg_temp.ah_flush_hints();
	perform pg_temp.base_assert(
		pg_temp.ah_activity_hints() = v_members,
		'materialized runner job insert emits activity hint'
	);
	v_rows := pg_temp.ah_agent_rows(v_bob);
	perform pg_temp.base_assert(
		jsonb_array_length(v_rows) = 1
		and (v_rows -> 0 ->> 'run_id')::uuid = (v_pass -> 'run_ids' ->> 0)::uuid
		and v_rows -> 0 ->> 'job_status' = 'queued'
		and v_rows -> 0 ->> 'activity' = 'waiting',
		'materialized run replaces queued wake seamlessly: ' || v_rows::text
	);
end $$;

rollback;
