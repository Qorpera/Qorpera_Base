-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-2c part 2 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9 test
-- 12): completion takes the job FOR UPDATE, so it waits out a send and a release in flight, and a tool call that arrives
-- while completion holds the job waits at the job (behind the run mutex) and then refuses. Completion never takes the
-- company row FOR UPDATE, and takes it before the requester's member row. 648's committed fixture, with more leased human runs of Ada, removed at the end.

-- A leased human run of Ada (run n) in her conversation, with its native rows, an acknowledgement and its native start,
-- committed. Its binding is in qorpera_test.race_<n>.
create function pg_temp.race_run(p_n integer) returns void language plpgsql as $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_hex text := lpad(to_hex(p_n), 2, '0');
	v_run uuid := ('65900000-0000-4000-8000-0000000001' || v_hex)::uuid; v_job uuid := ('65900000-0000-4000-8000-0000000002' || v_hex)::uuid;
	v_wake uuid := ('65900000-0000-4000-8000-0000000003' || v_hex)::uuid; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_assignment uuid := ('65900000-0000-4000-8000-0000000005' || v_hex)::uuid; v_lease uuid := ('65900000-0000-4000-8000-0000000006' || v_hex)::uuid;
	v_session uuid := '64800000-0000-4000-8000-0000000000f7'; v_input uuid := ('65900000-0000-4000-8000-0000000008' || v_hex)::uuid;
	v_bundle uuid := '64800000-0000-4000-8000-0000000000f9'; b jsonb;
	v_substrate uuid := ('65900000-0000-4000-8000-0000000009' || v_hex)::uuid;
begin
	set local session_replication_role = replica;
	-- Completion updates the job twice, and the second update checks its foreign keys again: its substrate row exists
	-- (another company's; the folder lane never reads it).
	insert into public.qorpera_company_substrate_versions(id, profile_id, environment_id, company_snapshot_id, client_version_id,
		contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id)
	values (v_substrate, '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 1, 0, 0, repeat('f', 64), '64800000-0000-4000-8000-000000000003');
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_bundle, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, v_substrate, extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
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
	insert into public.qorpera_execution_run_events(run_id, event_type, payload)
	values (v_run, 'runner_started', jsonb_build_object('schema', 'qorpera.native-company-execution-start/v1', 'runId', v_run,
		'jobId', v_job, 'leaseId', v_lease, 'binarySha256', repeat('9', 64)));
	set local session_replication_role = origin;
	b := jsonb_build_object('leaseId', v_lease, 'runId', v_run, 'jobId', v_job, 'runnerId', v_runner, 'assignmentId', v_assignment,
		'credentialCapsuleId', '64800000-0000-4000-8000-0000000000d2', 'computeIdentityId', '64800000-0000-4000-8000-0000000000d1',
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
	perform set_config('qorpera_test.race_' || p_n, b::text, false);
	perform public.qorpera_send_native_agent_message(v_lease, v_run, v_job, v_runner, v_assignment, '64800000-0000-4000-8000-0000000000d2',
		'64800000-0000-4000-8000-0000000000d1', 'openai', 'codex-cli', 'ack', 'On it.', 'progress');
end $$;
select pg_temp.race_run(1) \g /dev/null
select pg_temp.race_run(2) \g /dev/null
select pg_temp.race_run(3) \g /dev/null
select pg_temp.race_run(4) \g /dev/null
select pg_temp.race_run(5) \g /dev/null
select pg_temp.race_run(6) \g /dev/null
-- Run 6's run box view, open, with a known pass (committed, so other connections see it).
set session_replication_role = replica;
insert into public.qorpera_folder_views(id, environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access, run_id,
	job_id, runner_id, client_lease_id, pass_sha256, state, lease_until)
values ('65900000-0000-4000-8000-0000000007f6', '64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010',
	'run_box', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000002', 'write',
	'65900000-0000-4000-8000-000000000106', '65900000-0000-4000-8000-000000000206', '64800000-0000-4000-8000-0000000000f4',
	'65900000-0000-4000-8000-000000000506', extensions.digest('race-pass', 'sha256'), 'open', clock_timestamp() + interval '10 minutes');
set session_replication_role = origin;

create function pg_temp.sql_send(p_n integer, p_key text, p_phase text) returns text language sql as $$
	select format('select public.qorpera_send_native_agent_message(%L, %L, %L, %L, %L, %L, %L, ''openai'', ''codex-cli'', %L, %L, %L)::text',
		b ->> 'leaseId', b ->> 'runId', b ->> 'jobId', b ->> 'runnerId', b ->> 'assignmentId', b ->> 'credentialCapsuleId', b ->> 'computeIdentityId',
		p_key, 'Done.', p_phase)
	from (select current_setting('qorpera_test.race_' || p_n)::jsonb b) x
$$;
-- The completion call, with the result the runtime sends: the run's two public sends and its final message.
create function pg_temp.sql_complete(p_n integer, p_final text) returns text language sql as $$
	select format('select public.qorpera_complete_runner_job_v6(%L, %L, %L, %L, %L, %L, null, %L)::text', b ->> 'runnerId', repeat('f', 64),
		b ->> 'jobId', repeat('a', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id', b ->> 'leaseId',
			'substrate_version_id', (select substrate_version_id from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid),
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',b ->> 'runId',
				'message_count',2,'final_message_id',p_final,'provider_session_id','race-fixture'),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb))
	from (select current_setting('qorpera_test.race_' || p_n)::jsonb b) x
$$;

-- A. Completion waits for a send in flight: the send holds the job KEY SHARE, completion asks FOR UPDATE and waits at
-- the job. Once the send commits, completion sees it (the final message) and completes.
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(1, 'final', 'final')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_complete(1, v ->> 'messageId'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'Completion must wait for the send in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runner_jobs'::regclass then
		raise exception 'Completion must wait at the job, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'Completion after the send: %', v_state; end if;
	if (select company_disposition from public.qorpera_execution_run_results
		where run_id = (current_setting('qorpera_test.race_1')::jsonb ->> 'runId')::uuid) <> 'unchanged' then
		raise exception 'The completed run has its result'; end if;
end $$;

-- B. Completion waits for a release in flight (a release holds the job KEY SHARE without the run mutex).
do $$
declare v_state text; v jsonb; b jsonb := current_setting('qorpera_test.race_2')::jsonb;
begin
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(2, 'final', 'final')) as t(x text);
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId',
			'runnerId', b ->> 'runnerId', 'assignmentId', b ->> 'assignmentId'), extensions.gen_random_uuid(), '[]', repeat('0', 64)))
		as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_complete(2, v ->> 'messageId'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'Completion must wait for the release in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runner_jobs'::regclass then
		raise exception 'Completion must wait at the job, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'Completion after the release: %', v_state; end if;
end $$;

-- C. A tool call that arrives while completion holds the job takes the run mutex, waits at the job, and refuses once
-- the job is completed. Completion holds this company's row KEY SHARE at most: another session's FOR NO KEY UPDATE on it
-- does not wait.
do $$
declare v_state text; v jsonb;
begin
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(3, 'final', 'final')) as t(x text);
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_complete(3, v ->> 'messageId')) as t(x text);
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for no key update nowait$q$) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_send(3, 'late', 'progress'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'A tool call during completion must wait'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_runner_jobs'::regclass then
		raise exception 'The tool call must wait at the job, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state not like '42501 %' then raise exception 'A tool call after completion: %', v_state; end if;
end $$;

-- D. Completion takes this company's row (rank 0) before the requester's member row. With the company row held FOR
-- UPDATE elsewhere (as legacy member management holds it before the member row), completion waits there holding no
-- member row; without rank 0 it would hold the member row and then wait for the company row through a foreign key. (This
-- is about lock order only: removing the run's own requester, or the member whose login pays for the run, ends the run's
-- job and is C1c-3's case, C1C §5.9 test 15.)
do $$
declare v_state text; v jsonb;
begin
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(4, 'final', 'final')) as t(x text);
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_complete(4, v ->> 'messageId'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'Completion must wait for the company row'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'Completion must wait at the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
		and user_id = '64800000-0000-4000-8000-000000000002' for update nowait$q$) as t(x integer);
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'Completion after the company row: %', v_state; end if;
end $$;

-- E. A second completion call for the same attempt (a runtime retry) that arrives while the first is running waits at the
-- job (the lane's first lock) and then returns the stored result, as today's lane does; it is never refused as a lease
-- that went away.
do $$
declare v_state text; v jsonb; v_call text;
begin
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(5, 'final', 'final')) as t(x text);
	v_call := pg_temp.sql_complete(5, v ->> 'messageId');
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', v_call) as t(x text);
	perform dblink_send_query('fence_two', v_call);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The retry must wait for the completion in flight'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_runner_jobs'::regclass then
		raise exception 'The retry must wait at the job, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'A completion retried during the first gets its result: %', v_state; end if;
end $$;

-- F. A run box view renewal in flight (the view FOR NO KEY UPDATE, no job lock): completion, holding the job, waits at the
-- view before the fence and the ranks, so it holds no member row while it waits; then it closes the view.
do $$
declare v_state text; v jsonb;
begin
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send(6, 'final', 'final')) as t(x text);
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select public.qorpera_folder_view_renew('65900000-0000-4000-8000-0000000007f6', 'race-pass')::text$q$)
		as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_complete(6, v ->> 'messageId'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'Completion must wait for the renewal in flight'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_folder_views'::regclass then
		raise exception 'Completion must wait at the view, not on %', pg_temp.queued_on('fence_one'); end if;
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
		and user_id = '64800000-0000-4000-8000-000000000002' for update nowait$q$) as t(x integer);
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'Completion after the renewal: %', v_state; end if;
	if (select state || ':' || close_reason from public.qorpera_folder_views where id = '65900000-0000-4000-8000-0000000007f6')
		is distinct from 'closed:ended' then raise exception 'Completion closes the run box view'; end if;
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
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_run_results where run_id::text like '65900000%')
		or exists (select 1 from public.qorpera_company_substrate_versions where id::text like '65900000%') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
