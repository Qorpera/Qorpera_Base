-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-2c part 1 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9
-- tests 11, 13, 14 and 15): a coworker message against the recipient's own send into its thread, and two agents
-- messaging each other, in both orders and for a first message, without a deadlock; a thread that changed while the
-- message waited refuses as retryable; a wake insert with rank 0 and admission held never meets 55P03, and the routine
-- lifecycle's FOR NO KEY UPDATE runs beside a routine run's tool call and after a routine save; removing another member
-- while a run messages; the materializer never touches a folder-v2 company row; a save archiving the sender against its
-- message. 648's committed fixture (Ada's leased human run), with a Co-Founder run in its thread, removed at the end.

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
-- Ada's agent.md archived, staged now: staging inside a save's own transaction would lock the company row.
select set_config('qorpera_test.ada_' || s, pg_temp.stage(replace(pg_temp.agent_text('64800000-0000-4000-8000-0000000000a1', 'Ada'),
	'status: active', 'status: ' || s))::text, false) from unnest(array['archived']) s \g /dev/null

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
create function pg_temp.sql_ada_status(p_status text, p_key text) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', p_key, pg_temp.ada_units(p_status))
$$;
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

	-- A routine save holds the routine FOR NO KEY UPDATE: the insert waits at the routine, then lands.
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

-- E. Removing another member while a run messages, in both orders: removal takes the company row FOR UPDATE, the message
-- this company's row KEY SHARE (rank 0) before anything else of the company, so they meet there.
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
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The removal must wait at the company row, not on %', pg_temp.queued_on('fence_two'); end if;
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
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The message must wait at the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The message after the removal: %', v_state; end if;
	perform dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
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
-- nothing deadlocks. (After the save commits, her run refuses at the run check: 647 covers an archived run's agent.)
do $$
declare v_state text; v jsonb; c_cf constant uuid := '64800000-0000-4000-8000-0000000000c0';
begin
	-- The save first: the message waits at her room having written nothing. The save is rolled back, and the message lands.
	perform dblink_exec('fence_two', 'begin');
	select x::jsonb into v from dblink('fence_two', pg_temp.sql_ada_status('archived', 'wakes-archive-1')) as t(x text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The archiving save: %', v; end if;
	perform dblink_send_query('fence_one', pg_temp.sql_cw('qorpera_test.binding', c_cf, 'archive-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The message must wait for the archiving save'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_company_rooms'::regclass then
		raise exception 'The message must wait at her room, not on %', pg_temp.queued_on('fence_one'); end if;
	if pg_temp.wrote_conversation('fence_one') then raise exception 'The waiting message has written nothing'; end if;
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The message after the save rolled back: %', v_state; end if;

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
	delete from public.qorpera_cloud_routine_versions where routine_id = '65700000-0000-4000-8000-0000000000e1';
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
	'64800000-0000-4000-8000-000000000003','65700000-0000-4000-8000-000000000004');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_routines where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
