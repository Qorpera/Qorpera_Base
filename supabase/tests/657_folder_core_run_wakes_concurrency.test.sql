-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-2c part 1 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9
-- tests 11, 13, 14 and 15): a coworker message against the recipient's own send into its thread, and two agents
-- messaging each other, in both orders and for a first message, without a deadlock; a thread that changed while the
-- message waited refuses as retryable; a wake insert with rank 0 and admission held never meets 55P03, and the routine
-- lifecycle's FOR NO KEY UPDATE runs beside a routine run's tool call and after a routine save; removing another member
-- while a run messages; the materializer never touches a folder-v2 company row; a save archiving the sender against its
-- message; the scheduler waits for a message into its agent's thread before admission. 648's committed fixture (Ada's leased human run), with a Co-Founder run in its thread, removed at the end.

-- Ada's run acknowledges, so its tool calls may work.
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'ack', 'On it.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null

-- A leased human run of the Co-Founder in its own thread (the room's conversation), for its sends and messages.
set session_replication_role = replica;
do $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000c0'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_run uuid := '65700000-0000-4000-8000-0000000000b1'; v_job uuid := '65700000-0000-4000-8000-0000000000b2';
	v_wake uuid := '65700000-0000-4000-8000-0000000000b3'; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_assignment uuid := '65700000-0000-4000-8000-0000000000b5'; v_lease uuid := '65700000-0000-4000-8000-0000000000b6';
	v_input uuid := '65700000-0000-4000-8000-0000000000b8'; v_bundle uuid := '64800000-0000-4000-8000-0000000000f9';
	v_session uuid;
begin
	select session_id into strict v_session from public.qorpera_company_rooms where profile_id = v_profile and bound_staff_agent_id = v_staff;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_bundle, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, compute_identity_id)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, '64800000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester,
		'openai', 'gpt-test', 'provider_default', 'company', v_bundle, repeat('b', 64), v_session, array[v_input],
		'64800000-0000-4000-8000-0000000000d1');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, '64800000-0000-4000-8000-0000000000b1', 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, extensions.gen_random_uuid(), v_job, v_run, v_runner, repeat('e', 64), 'accepted',
		clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run, v_job, '64800000-0000-4000-8000-0000000000b3', 1, '64800000-0000-4000-8000-0000000000d2',
		'64800000-0000-4000-8000-0000000000d1', v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run, v_job, v_profile, '64800000-0000-4000-8000-0000000000b1', 1, '64800000-0000-4000-8000-0000000000b3', 1,
		date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_job, v_profile, v_env, '["gpt-test"]', 32, 1000, 1000, v_requester);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run);
	-- The company's login pays for unattended work, so it pays for a coworker message's run (as 647's does).
	update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
	update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
	-- A routine of Ada (a one-time run), for the wake admission races.
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin)
	values ('65700000-0000-4000-8000-0000000000e1', v_profile, v_env, extensions.gen_random_uuid(), 1, 'active', v_requester, 'member');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values ('65700000-0000-4000-8000-0000000000e1', 1, extensions.gen_random_uuid(), v_profile, v_env,
		'64800000-0000-4000-8000-0000000000a1', 'Check in', 'Check the numbers.',
		'[{"id":"t1","kind":"once","at":"2026-10-01T09:00:00Z","timeZone":"UTC"}]', 'medium',
		'64800000-0000-4000-8000-0000000000b1', 1, repeat('e', 64), v_requester);
	-- A scheduled routine of Ada, with its schedule position, for the scheduler's race.
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin)
	values ('65700000-0000-4000-8000-0000000000e3', v_profile, v_env, extensions.gen_random_uuid(), 1, 'active', v_requester, 'member');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values ('65700000-0000-4000-8000-0000000000e3', 1, extensions.gen_random_uuid(), v_profile, v_env,
		'64800000-0000-4000-8000-0000000000a1', 'Hourly', 'Check the inbox.', '[{"id":"s1","kind":"schedule","intervalMinutes":60}]',
		'medium', '64800000-0000-4000-8000-0000000000b1', 1, repeat('e', 64), v_requester);
	insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, next_due_at)
	values ('65700000-0000-4000-8000-0000000000e3', 1, 's1', date_trunc('second', clock_timestamp()));
	-- A queued snapshot-v1 wake the materializer takes.
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, status, payload, admission_scan_at)
	values ('65700000-0000-4000-8000-0000000000e2', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
		'coworker', 'snapshot-race', clock_timestamp(), clock_timestamp(), 'agent', 'coworker', 'queued', '{}', '2026-01-01T00:00:00Z');
end $$;
set session_replication_role = origin;
select set_config('qorpera_test.cofounder', jsonb_build_object('leaseId','65700000-0000-4000-8000-0000000000b6',
	'runId','65700000-0000-4000-8000-0000000000b1','jobId','65700000-0000-4000-8000-0000000000b2',
	'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','65700000-0000-4000-8000-0000000000b5',
	'credentialCapsuleId','64800000-0000-4000-8000-0000000000d2','computeIdentityId','64800000-0000-4000-8000-0000000000d1',
	'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, false) \g /dev/null
select set_config('qorpera_test.cf_thread', session_id::text, false), set_config('qorpera_test.cf_room', id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null
select set_config('qorpera_test.ada_room', id::text, false) from public.qorpera_company_rooms
where profile_id = '64800000-0000-4000-8000-000000000010' and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000a1' \g /dev/null
-- The Co-Founder's run acknowledges too.
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'ack', 'On it.', 'progress')
from (select current_setting('qorpera_test.cofounder')::jsonb b) x \g /dev/null
-- A member another member removes while a run messages.
insert into auth.users(id,email) values ('65700000-0000-4000-8000-000000000004','wakes-race-member@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values ('64800000-0000-4000-8000-000000000010',
	'65700000-0000-4000-8000-000000000004','wakes-race-member@example.test','Removable','contributor');
-- Ada's agent.md archived and active again, staged now, and taken into the owner's possession now (C1D §3): staging
-- inside a save's own transaction would lock the company row, and the other connections see only what is committed.
select set_config('qorpera_test.ada_' || s, pg_temp.stage(replace(pg_temp.agent_text('64800000-0000-4000-8000-0000000000a1', 'Ada'),
	'status: active', 'status: ' || s))::text, false) from unnest(array['archived', 'active']) s \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}',
	jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'agents/ada/agent.md', 'file', current_setting('qorpera_test.ada_' || s)::jsonb)))
from unnest(array['archived', 'active']) s \g /dev/null

create function pg_temp.sql_cw(p_binding text, p_to uuid, p_key text) returns text language sql as $$
	select format('select public.qorpera_send_coworker_message(%L, %L, %L, %L, true)::text', current_setting(p_binding), p_to, p_key,
		'A race message.')
$$;
create function pg_temp.sql_cf_send(p_key text) returns text language sql as $$
	select format('select public.qorpera_send_native_agent_message(%L, %L, %L, %L, %L, %L, %L, ''openai'', ''codex-cli'', %L, %L, %L)::text',
		b ->> 'leaseId', b ->> 'runId', b ->> 'jobId', b ->> 'runnerId', b ->> 'assignmentId', b ->> 'credentialCapsuleId', b ->> 'computeIdentityId',
		p_key, 'Working on it.', 'progress')
	from (select current_setting('qorpera_test.cofounder')::jsonb b) x
$$;
create function pg_temp.sql_routine_wake(p_key text) returns text language sql as $$
	select format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, routine_id,
		routine_version, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (extensions.gen_random_uuid(), '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'routine',
			'schedule', '65700000-0000-4000-8000-0000000000e1', 1, 't1', %L, clock_timestamp(), clock_timestamp(), '{}') returning id::text$f$,
		p_key)
$$;
-- A save of Ada's agent.md with this status (a change of status takes her thread room FOR UPDATE at rank 4).
create function pg_temp.ada_units(p_status text) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'agents/ada/agent.md',
		'file', current_setting('qorpera_test.ada_' || p_status)::jsonb, 'expectedVersion', pg_temp.version('agents/ada/agent.md'),
		'structured', jsonb_build_array(pg_temp.entry('agents/ada/agent.md', 'agent',
			replace(pg_temp.agent_text('64800000-0000-4000-8000-0000000000a1', 'Ada'), 'status: active', 'status: ' || p_status),
			pg_temp.agent_parse('64800000-0000-4000-8000-0000000000a1', 'Ada') || jsonb_build_object('status', p_status)))))
$$;
-- Its SQL for another connection, after taking possession of its file in this one (held already: a no-op).
create function pg_temp.sql_ada_status(p_status text, p_key text) returns text language plpgsql as $$
begin
	perform pg_temp.possess('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}',
		pg_temp.ada_units(p_status));
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', p_key, pg_temp.ada_units(p_status));
end $$;
-- The connections a waiting connection waits for, once it waits for any.
create function pg_temp.blockers(p_conn text) returns integer[] language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds'; v integer[];
begin
	loop
		v := pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer);
		if cardinality(v) > 0 or clock_timestamp() > v_until then return v; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;
-- Whether a connection has written to the conversation tables yet (a row lock there comes with the first write).
create function pg_temp.wrote_conversation(p_conn text) returns boolean language sql as $$
	select exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer and mode = 'RowExclusiveLock'
		and relation in ('public.qorpera_session_events'::regclass, 'public.qorpera_profile_operation_clocks'::regclass,
			'public.qorpera_wake_occurrences'::regclass))
$$;

-- A. Ada's first message to the Co-Founder (the pair conversation is created) against the Co-Founder's own send into its
-- thread, in both orders. The message locks every conversation it may write, in id order, before its first write: with
-- the send holding the Co-Founder's thread, the message waits there having written nothing, so it never holds the
-- operation clock the send needs (the deadlock of C1C §5.6).
do $$
declare v_state text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_cf_send('cf-race-1')) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'first-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then
		raise exception 'The message must wait for the send into the thread: %', pg_temp.outcome('fence_one'); end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The message must wait at the conversation, not on %', pg_temp.queued_on('fence_one'); end if;
	if pg_temp.wrote_conversation('fence_one') then raise exception 'The message waits before its first conversation write'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The first message after the send: %', v_state; end if;
	if not exists (select 1 from public.qorpera_shared_sessions where execution_scope ->> 'agentPairKey'
		= public.qorpera_agent_pair_key('64800000-0000-4000-8000-0000000000a1', c_cf)) then
		raise exception 'The first message creates the pair conversation'; end if;

	-- The message first: the send waits until it commits.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'first-2')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_cf_send('cf-race-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The send must wait for the message in flight'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The send after the message: %', v_state; end if;
end $$;

-- B. Ada and the Co-Founder message each other at once, in both orders: the second waits (the pair lock, then the same
-- conversations in the same order) and both land.
do $$
declare v_state text; c_ada constant uuid := '64800000-0000-4000-8000-0000000000a1'; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'cross-1')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_cw('qorpera_test.cofounder', c_ada, 'cross-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The reply must wait for the message in flight'; end if;
	if pg_temp.wrote_conversation('fence_two') then raise exception 'The waiting reply has written nothing'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The Co-Founder''s message after Ada''s: %', v_state; end if;

	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_cw('qorpera_test.cofounder', c_ada, 'cross-3')) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'cross-4'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'Ada''s message must wait for the Co-Founder''s'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'Ada''s message after the Co-Founder''s: %', v_state; end if;
	if (select count(*) from public.qorpera_wake_occurrences where source_kind = 'coworker' and status = 'queued'
		and occurrence_key like 'coworker:%:cross-%') <> 4 then raise exception 'Four crossed messages, four wakes'; end if;
end $$;

-- C. The Co-Founder's thread is closed while Ada's message waits for its room: the message took the room KEY SHARE (an
-- open thread when it looked), so it cannot reopen the thread now without strengthening a lock. It refuses as a
-- retryable conflict (QRC01, 409), and the retry takes the room FOR UPDATE and reopens the thread.
do $$
declare v_state text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', format('select 1 from public.qorpera_company_rooms where id = %L for update',
		current_setting('qorpera_test.cf_room'))) as t(x integer);
	perform dblink_exec('fence_two', format('update public.qorpera_shared_sessions set status = ''closed'' where id = %L',
		current_setting('qorpera_test.cf_thread')));
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'changed-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the thread''s room'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The message must wait at the room, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state not like 'PGRST %"QRC01"%Coworker thread changed while the message waited%' then
		raise exception 'A thread that changed while the message waited: %', v_state; end if;
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'changed-1')) as t(x text);
	if (select status from public.qorpera_shared_sessions where id = current_setting('qorpera_test.cf_thread')::uuid) <> 'open' then
		raise exception 'The retry reopens the thread'; end if;
end $$;

-- C2. The thread is closed after both messages checked it, while they wait for the pair lock (something of this pair is
-- in flight): a member closing the thread takes only its conversation. Each message finds the thread closed once it
-- holds the conversations, and refuses as a retryable conflict instead of taking the room FOR UPDATE it holds KEY SHARE
-- (a lock upgrade, and 40P01 between the two). The retries reopen the thread and land.
do $$
declare v_one text; v_four text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
	c_ada constant uuid := '64800000-0000-4000-8000-0000000000a1';
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select pg_advisory_xact_lock(hashtext(%L))::text',
		'qorpera_agent_pair:64800000-0000-4000-8000-000000000010:' || public.qorpera_agent_pair_key(c_ada, c_cf))) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'closed-late-ada'));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'Ada''s message must wait at the pair lock'; end if;
	perform dblink_send_query('fence_four', pg_temp.sql_cw('qorpera_test.cofounder', c_ada, 'closed-late-cf'));
	if not pg_temp.waits_for('fence_four', 'fence_three') then raise exception 'The Co-Founder''s message must wait at the pair lock'; end if;
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform * from dblink('fence_two', format('select public.qorpera_close_shared_session(%L)::text', current_setting('qorpera_test.cf_thread')))
		as t(x text);
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	perform dblink_exec('fence_three', 'commit');
	v_one := pg_temp.outcome('fence_one'); v_four := pg_temp.outcome('fence_four');
	if (v_one <> 'ok' and v_one not like 'PGRST %"QRC01"%Coworker thread changed%')
		or (v_four <> 'ok' and v_four not like 'PGRST %"QRC01"%Coworker thread changed%') then
		raise exception 'A thread closed after the check: % / %', v_one, v_four; end if;
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'closed-late-ada')) as t(x text);
	perform * from dblink('fence_four', pg_temp.sql_cw('qorpera_test.cofounder', c_ada, 'closed-late-cf')) as t(x text);
	if (select status from public.qorpera_shared_sessions where id = current_setting('qorpera_test.cf_thread')::uuid) <> 'open' then
		raise exception 'The retries reopen the thread'; end if;
end $$;

-- C3. The pair lock comes before the conversations are read and locked: a first message of a pair that is creating the
-- pair conversation (not yet committed, with an id below both threads') holds it, and a message arriving meanwhile waits
-- there, so it reads the new conversation and locks it in id order. Without it, the late message would lock the threads
-- first and the pair conversation after them, out of id order, and meet another message in a cycle (review r1, S1).
-- The earlier races created this pair's conversation: it is retired (its key renamed, committed now) so a new one is made.
set session_replication_role = replica;
update public.qorpera_shared_sessions set execution_scope = jsonb_set(execution_scope, '{agentPairKey}',
	to_jsonb('retired-' || public.qorpera_agent_pair_key('64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000c0')))
where execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key('64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000c0');
set session_replication_role = origin;
do $$
declare v_two text; v_four text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
	c_ada constant uuid := '64800000-0000-4000-8000-0000000000a1'; c_pair constant uuid := '00000000-0000-4000-8000-000000000657';
	v_ada_thread uuid; v_cf_thread uuid := current_setting('qorpera_test.cf_thread')::uuid;
begin
	select session_id into v_ada_thread from public.qorpera_company_rooms where id = current_setting('qorpera_test.ada_room')::uuid;
	-- The first message's pair conversation, being created: what qorpera_agent_pair_session_internal does (the pair's
	-- advisory lock, then the conversation), with a fixed id that sorts below both threads' random ones. A drawn id
	-- needed many tries when a thread's id sorted low.
	if not (c_pair::text < v_ada_thread::text and c_pair::text < v_cf_thread::text) then
		raise exception 'The pair conversation''s id must sort below both threads'''; end if;
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format($q$select pg_advisory_xact_lock(hashtext('qorpera_agent_pair:' || %L || ':'
		|| public.qorpera_agent_pair_key(%L, %L)))::text$q$, '64800000-0000-4000-8000-000000000010', c_ada, c_cf)) as t(x text);
	perform dblink_exec('fence_three', format($q$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title,
		staff_agent_id, created_by_user_id, audience_kind, audience_user_id, execution_scope)
		select %L, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
			least(a.display_name, b.display_name) || ' & ' || greatest(a.display_name, b.display_name), null,
			'64800000-0000-4000-8000-000000000002', 'company', null,
			jsonb_build_object('agentPair', jsonb_build_array(least(%L, %L), greatest(%L, %L)),
				'agentPairKey', public.qorpera_agent_pair_key(%L, %L))
		from public.qorpera_profile_staff a, public.qorpera_profile_staff b
		where a.profile_id = '64800000-0000-4000-8000-000000000010' and a.staff_agent_id = %L
			and b.profile_id = '64800000-0000-4000-8000-000000000010' and b.staff_agent_id = %L$q$,
		c_pair, c_ada::text, c_cf::text, c_ada::text, c_cf::text, c_ada, c_cf, c_ada, c_cf));
	-- Both threads held elsewhere (a send in flight).
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', format('select 1 from public.qorpera_shared_sessions where id in (%L, %L) order by id for update',
		v_ada_thread, v_cf_thread)) as t(x integer);
	-- The Co-Founder's message, while the pair conversation is not yet committed: it waits at the pair lock.
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.cofounder', c_ada, 'pair-late-cf'));
	if not (current_setting('qorpera_test.pid_fence_three')::integer = any (pg_temp.blockers('fence_one'))) then
		raise exception 'A message arriving while its pair conversation is being created waits at the pair lock'; end if;
	perform dblink_exec('fence_three', 'commit');
	-- Ada's message, after the pair conversation committed.
	perform dblink_send_query('fence_four', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'pair-late-ada'));
	if cardinality(pg_temp.blockers('fence_four')) = 0 then raise exception 'Ada''s message waits too'; end if;
	perform dblink_exec('fence_two', 'rollback');
	v_two := pg_temp.outcome('fence_one'); v_four := pg_temp.outcome('fence_four');
	if v_two <> 'ok' or v_four <> 'ok' then raise exception 'Two messages around a new pair conversation: % / %', v_two, v_four; end if;
	-- The hand-made conversation is the one the function finds (a change of its shape would make this case test another).
	if public.qorpera_agent_pair_session_internal('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', c_ada,
			c_cf, '64800000-0000-4000-8000-000000000002') <> c_pair then
		raise exception 'The pair conversation must be the hand-made one'; end if;
end $$;

-- D. C2's creation shape: rank 0 and admission held, a wake insert never meets 55P03. A save rewriting Ada's agent.md
-- holds her staff row FOR NO KEY UPDATE and a run of her routine holds the routine KEY SHARE; the folder pin trigger
-- takes neither lock (today's would take the company row FOR UPDATE NOWAIT and the staff row FOR SHARE), and the
-- routine lifecycle's FOR NO KEY UPDATE does not wait for KEY SHARE. A routine save (FOR NO KEY UPDATE) is waited for,
-- at the routine, and nothing deadlocks.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010'
		and staff_agent_id = '64800000-0000-4000-8000-0000000000a1' for no key update$q$) as t(x integer);
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_cloud_routines where id = '65700000-0000-4000-8000-0000000000e1'
		for key share$q$) as t(x integer);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select public.qorpera_folder_admit_wakes('64800000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_routine_wake('once:1:1'));
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'The admitted wake insert must not wait'; end if;
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The admitted wake beside a save and a routine run: %', v_state; end if;
	perform dblink_exec('fence_one', 'commit');
	perform dblink_exec('fence_two', 'rollback');

	-- A routine save holds the routine FOR NO KEY UPDATE: the insert waits at the routine, then lands. (This caller takes
	-- admission before the routine to test the trigger's mode alone; a real inserter takes the routine at rank 5 first.)
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_cloud_routines where id = '65700000-0000-4000-8000-0000000000e1'
		for no key update$q$) as t(x integer);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select public.qorpera_folder_admit_wakes('64800000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_routine_wake('once:1:2'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The wake insert must wait for the routine save'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_cloud_routines'::regclass then
		raise exception 'The wake insert must wait at the routine, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The wake insert after the routine save: %', v_state; end if;
	perform dblink_exec('fence_one', 'commit');
	if (select count(*) from public.qorpera_wake_occurrences where routine_id = '65700000-0000-4000-8000-0000000000e1') <> 2 then
		raise exception 'Both routine wakes landed'; end if;
end $$;

-- D2. The scheduler against a message into the routine agent's thread: the message holds the thread FOR UPDATE, and the
-- scheduler waits for it there, KEY SHARE before admission, holding no admission row; a scheduler that took admission
-- first and then waited at the thread would deadlock with a message waiting for admission.
do $$
declare v_state text; v_slot timestamptz;
begin
	select next_due_at into v_slot from public.qorpera_cloud_routine_schedule_cursors where routine_id = '65700000-0000-4000-8000-0000000000e3';
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_cw('qorpera_test.cofounder', '64800000-0000-4000-8000-0000000000a1', 'before-slot'))
		as t(x text);
	perform dblink_send_query('fence_one', format('select public.qorpera_enqueue_routine_wake(%L, 1, %L, %L, %L, %L, null, %L)::text',
		'65700000-0000-4000-8000-0000000000e3', '65700000-0000-4000-8000-0000000000f3', 'slot-1', 's1', v_slot, v_slot + interval '1 hour'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The scheduler must wait for the message into the thread'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The scheduler must wait at the thread, not on %', pg_temp.queued_on('fence_one'); end if;
	if exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_one')::integer
		and relation = 'public.qorpera_folder_admissions'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'The scheduler waits before admission'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The scheduler after the message: %', v_state; end if;
	if (select status from public.qorpera_wake_occurrences where id = '65700000-0000-4000-8000-0000000000f3') is distinct from 'queued' then
		raise exception 'The scheduler queues its slot'; end if;
end $$;

-- D3. The scheduler's other step, moving a schedule position forward, takes this company's row KEY SHARE on folder-v2,
-- not the gc fence: it does not wait for any folder effect holding the company row KEY SHARE.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_advance_routine_next_due(%L, 1, %L, (select last_scheduled_for
		from public.qorpera_cloud_routine_schedule_cursors where routine_id = %L), %L)::text',
		'65700000-0000-4000-8000-0000000000e3', 's1', '65700000-0000-4000-8000-0000000000e3', clock_timestamp() + interval '3 hours'));
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'The schedule advance must not wait for the company row'; end if;
	v_state := pg_temp.outcome('fence_one');
	perform dblink_exec('fence_two', 'rollback');
	if v_state <> 'ok' then raise exception 'The schedule advance: %', v_state; end if;
end $$;

-- E. Removing another member while a run messages, in both orders. Since C1c-3c a removal on folder-v2 takes the company
-- row KEY SHARE only and every agent thread room FOR UPDATE (rank 4), the message those rooms KEY SHARE, so they meet
-- at a thread room.
do $$
declare v_state text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
	c_remove constant text := $q$select public.qorpera_remove_profile_member('64800000-0000-4000-8000-000000000010',
		'65700000-0000-4000-8000-000000000004')::text$q$;
begin
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'remove-1')) as t(x text);
	perform dblink_send_query('fence_two', c_remove);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The removal must wait for the message in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The removal must wait at a thread room, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The removal after the message: %', v_state; end if;
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values ('64800000-0000-4000-8000-000000000010',
		'65700000-0000-4000-8000-000000000004','wakes-race-member@example.test','Removable','contributor');
end $$;
do $$
declare v_state text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select public.qorpera_remove_profile_member('64800000-0000-4000-8000-000000000010',
		'65700000-0000-4000-8000-000000000004')::text$q$) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'remove-2'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the removal in flight'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The message must wait at a thread room, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The message after the removal: %', v_state; end if;
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
end $$;

-- E2. A member joins while a message runs. A join takes every thread room FOR UPDATE in id order, then every thread
-- conversation, before any of those writes (since C1c-3d-1 in its prelude, before the invitation; the member trigger
-- then finds them held), so it never holds one room and waits for another that a message holds KEY SHARE (review r1,
-- S2). A member row written with no prelude (as an account deletion writes one) takes them NOWAIT in the trigger and
-- refuses at once, retryably.
insert into auth.users(id,email,email_confirmed_at) values ('65700000-0000-4000-8000-000000000005','wakes-race-joiner@example.test',
	clock_timestamp());
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, expires_at)
values ('65700000-0000-4000-8000-0000000000e5', '64800000-0000-4000-8000-000000000010', 'wakes-race-joiner@example.test', 'contributor',
	'64800000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 day');
do $$
declare v_join text; v_message text; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
	v_first_session uuid;
begin
	-- The joining transaction stops at the higher thread's conversation, held elsewhere.
	select session_id into v_first_session from public.qorpera_company_rooms
	where id = greatest(current_setting('qorpera_test.ada_room'), current_setting('qorpera_test.cf_room'))::uuid;
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_shared_sessions where id = %L for update', v_first_session))
		as t(x integer);
	perform dblink_send_query('fence_two', $q$insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values ('64800000-0000-4000-8000-000000000010','65700000-0000-4000-8000-000000000005','wakes-race-joiner@example.test','Joiner','contributor')
		returning 'ok'::text$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then
		raise exception 'A member row written with no prelude must not wait at the held conversation'; end if;
	v_join := pg_temp.outcome('fence_two');
	if v_join not like 'PGRST %"QRC01"%An agent thread is busy; try again%' then
		raise exception 'A member row written with no prelude: %', v_join; end if;
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"65700000-0000-4000-8000-000000000005","email":"wakes-race-joiner@example.test"}'$q$);
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', $q$select public.qorpera_accept_profile_invitation('65700000-0000-4000-8000-0000000000e5')::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_three') then raise exception 'The join must wait at the held conversation'; end if;
	-- By then the join holds both thread rooms: the message waits at the first room, holding no room.
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'while-joining'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the join'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The message must wait at a thread room, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_three', 'rollback');
	v_join := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
	v_message := pg_temp.outcome('fence_one');
	if v_join <> 'ok' or v_message <> 'ok' then raise exception 'A member joining beside a message: % / %', v_join, v_message; end if;
end $$;

-- F. The materializer passes over folder-v2 wakes without touching the company: with the folder-v2 company row held FOR
-- UPDATE elsewhere, a pass finishes without waiting, takes the snapshot-v1 wake, and leaves the folder-v2 wakes as they
-- were.
do $$
declare v_state text; v_scans jsonb;
begin
	select jsonb_object_agg(id, admission_scan_at) into v_scans from public.qorpera_wake_occurrences
	where profile_id = '64800000-0000-4000-8000-000000000010' and status = 'queued';
	if v_scans is null then raise exception 'The races left folder-v2 wakes queued'; end if;
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', 'select public.qorpera_materialize_wake_execution_runs(64)::text');
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'The materializer must not wait for a folder-v2 company'; end if;
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The materializer pass: %', v_state; end if;
	perform dblink_send_query('fence_one', 'select public.qorpera_materialize_session_execution_runs(64)::text');
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'The session materializer must not wait'; end if;
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The session materializer pass: %', v_state; end if;
	perform dblink_exec('fence_two', 'rollback');
	if (select admission_scan_at from public.qorpera_wake_occurrences where id = '65700000-0000-4000-8000-0000000000e2')
		= '2026-01-01T00:00:00Z' then raise exception 'The materializer takes the snapshot-v1 wake'; end if;
	if exists (select 1 from jsonb_each_text(v_scans) s join public.qorpera_wake_occurrences w on w.id = s.key::uuid
		where w.status <> 'queued' or w.admission_scan_at is distinct from s.value::timestamptz) then
		raise exception 'The materializer touched a folder-v2 wake'; end if;
end $$;

-- G. A save archiving Ada against her message, in both orders. The save takes her thread room FOR UPDATE at rank 4, the
-- message the room KEY SHARE there, before either touches a conversation: whichever is second waits at the room, and
-- nothing deadlocks. After the archive commits, her waiting message refuses at the run check and writes nothing.
do $$
declare v_state text; v jsonb; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	-- The save first: the message waits at her room having written nothing, then refuses (her run's agent is archived).
	perform dblink_exec('fence_two', 'begin');
	select x::jsonb into v from dblink('fence_two', pg_temp.sql_ada_status('archived', 'wakes-archive-1')) as t(x text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The archiving save: %', v; end if;
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'archive-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the archiving save'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The message must wait at her room, not on %', pg_temp.queued_on('fence_one'); end if;
	if pg_temp.wrote_conversation('fence_one') then raise exception 'The waiting message has written nothing'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state not like '42501 %' then raise exception 'A message after its sender was archived: %', v_state; end if;
	if exists (select 1 from public.qorpera_run_operation_receipts where logical_operation_key = 'coworker:archive-1') then
		raise exception 'The refused message wrote nothing'; end if;
	-- Ada is made active again (committed on another connection, so her run sees it).
	select x::jsonb into v from dblink('fence_two', pg_temp.sql_ada_status('active', 'wakes-unarchive-1')) as t(x text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The un-archiving save: %', v; end if;

	-- The message first: the save waits at her room, then lands.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'archive-2')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_ada_status('archived', 'wakes-archive-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The archiving save must wait for the message in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The save must wait at her room, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The archiving save after the message: %', v_state; end if;
	if (select employment_status from public.qorpera_profile_staff where staff_agent_id = '64800000-0000-4000-8000-0000000000a1') <> 'archived' then
		raise exception 'The save archived Ada'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 648 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_cloud_routine_versions where routine_id in ('65700000-0000-4000-8000-0000000000e1',
		'65700000-0000-4000-8000-0000000000e3');
	delete from public.qorpera_cloud_routine_schedule_cursors where routine_id = '65700000-0000-4000-8000-0000000000e3';
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003','65700000-0000-4000-8000-000000000004','65700000-0000-4000-8000-000000000005');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_routines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
