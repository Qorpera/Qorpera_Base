-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C2 R1 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §3, §6): the review
-- recorder against the other takers of the approval row. Another run's begin (FOR UPDATE on the action review, as an
-- answer takes it) and a recorder (FOR SHARE) wait for each other, one at a time, in both orders, and both finish; a
-- member's commit does not wait for a recorder in flight (its KEY SHARE on the folder clock row is compatible with the
-- commit's update); a recorder behind a first answer finds the card not yet used and refuses; two recorders of one run
-- queue on the run mutex and the second replays. 648's committed fixture, removed at the end.

set session_replication_role = replica;
-- A second leased human run of Ada in the same conversation, for a second tool call of the same agent.
do $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_run uuid := '64800000-0000-4000-8000-0000000001f1'; v_job uuid := '64800000-0000-4000-8000-0000000001f2';
	v_wake uuid := '64800000-0000-4000-8000-0000000001f3'; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_assignment uuid := '64800000-0000-4000-8000-0000000001f5'; v_lease uuid := '64800000-0000-4000-8000-0000000001f6';
	v_session uuid := '64800000-0000-4000-8000-0000000000f7'; v_input uuid := '64800000-0000-4000-8000-0000000001f8';
	v_bundle uuid := '64800000-0000-4000-8000-0000000000f9';
begin
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
end $$;
set session_replication_role = origin;
select set_config('qorpera_test.binding2', jsonb_build_object('leaseId','64800000-0000-4000-8000-0000000001f6',
	'runId','64800000-0000-4000-8000-0000000001f1','jobId','64800000-0000-4000-8000-0000000001f2',
	'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','64800000-0000-4000-8000-0000000001f5',
	'credentialCapsuleId','64800000-0000-4000-8000-0000000000d2','computeIdentityId','64800000-0000-4000-8000-0000000000d1',
	'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, false) \g /dev/null

-- Ada's approvals in run f1, committed: her own allow (a1), and a card answered by the member and used by the run's
-- holding call (a2).
create function pg_temp.sql_record(p_action uuid, p_path text) returns text language sql as $$
	select format('select public.qorpera_folder_record_review(%L, %L)::text', current_setting('qorpera_test.binding'),
		jsonb_build_object('actionReviewId', p_action, 'tool', 'hire_agent', 'argumentSha256', review.argument_sha256,
			'units', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', p_path))))
	from public.qorpera_action_reviews review where review.id = p_action
$$;
create function pg_temp.review(p_call text, p_decision text) returns uuid language sql as $$
	select (public.qorpera_record_action_review(current_setting('qorpera_test.binding')::jsonb, jsonb_build_object('callId', p_call,
		'tool', 'hire_agent', 'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Hire an agent', 'target', 'nora', 'details', '{}'::jsonb), 'decision', p_decision,
		'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna'))
		->> 'reviewId')::uuid
$$;
select set_config('qorpera_test.a1', pg_temp.review('race-recorder-allow', 'allow')::text, false) \g /dev/null
select set_config('qorpera_test.a2', pg_temp.review('race-recorder-card', 'ask')::text, false) \g /dev/null
update public.qorpera_action_reviews set answer = 'allow_once', answered_by_user_id = '64800000-0000-4000-8000-000000000002',
	answered_at = clock_timestamp() where id = current_setting('qorpera_test.a2')::uuid;
select public.qorpera_await_action_review(current_setting('qorpera_test.binding')::jsonb, current_setting('qorpera_test.a2')::uuid, false)
	->> 'state' \g /dev/null
do $$
begin
	if (select consumed_run_id from public.qorpera_action_reviews where id = current_setting('qorpera_test.a2')::uuid)
		is distinct from '64800000-0000-4000-8000-0000000000f1' then raise exception 'The fixture card is used by run f1'; end if;
end $$;
-- Another run's begin of the same call: it takes the approval row FOR UPDATE (it matches an answered card).
create function pg_temp.sql_begin() returns text language sql as $$
	select format('select public.qorpera_begin_action_review(%L, %L)::text', current_setting('qorpera_test.binding2'),
		jsonb_build_object('tool', 'hire_agent', 'argumentSha256', md5('race-recorder-card') || md5('race-recorder-card')))
$$;

select set_config('qorpera_test.a3', pg_temp.review('race-recorder-card-2', 'ask')::text, false) \g /dev/null

-- A. A begin in flight on the approval: the recorder waits at that row (holding no conversation), then records.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_begin()) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_record(current_setting('qorpera_test.a2')::uuid, 'race-card'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the recorder must wait for the begin'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_action_reviews'::regclass then
		raise exception 'A: the recorder must wait at the approval, not on %', pg_temp.queued_on('fence_two'); end if;
	perform 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7' for update nowait;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or not exists (select 1 from public.qorpera_folder_reviews
			where id = md5('qorpera.folder-review:' || current_setting('qorpera_test.a2'))::uuid
				and run_id = '64800000-0000-4000-8000-0000000000f1') then
		raise exception 'A: the recorder after the begin: %', v_state; end if;
end $$;

-- B. A recorder in flight (its replay shares the row too): the other run's begin waits for it, then finishes.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_record(current_setting('qorpera_test.a2')::uuid, 'race-card')) as t(r text);
	perform dblink_send_query('fence_one', pg_temp.sql_begin());
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'B: the begin must wait for the recorder'; end if;
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'B: the begin after the recorder: %', v_state; end if;
end $$;

-- C. A member's commit runs beside a recorder in flight.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', pg_temp.sql_record(current_setting('qorpera_test.a1')::uuid, 'race-allow')) as t(r text);
	perform dblink_send_query('fence_three', format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'race-recorder-member',
		'[{"op":"mkdir","path":"race-member"}]'));
	if not pg_temp.finishes_unblocked('fence_three', 'fence_two') then raise exception 'C: a member''s commit must not wait for a recorder'; end if;
	v_state := pg_temp.outcome('fence_three');
	perform dblink_exec('fence_two', 'commit');
	if v_state <> 'ok' or not exists (select 1 from public.qorpera_folder_entries
			where environment_id = '64800000-0000-4000-8000-000000000020' and key_text = 'race-member') then
		raise exception 'C: the member''s commit: %', v_state; end if;
end $$;

-- D. A first answer in flight (its write of the card's row, uncommitted): the recorder waits for it, then finds the
-- card answered but not used by this run, and refuses.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform dblink_exec('fence_one', format('update public.qorpera_action_reviews set answer = %L, answered_by_user_id = %L,
		answered_at = clock_timestamp() where id = %L', 'allow_once', '64800000-0000-4000-8000-000000000002',
		current_setting('qorpera_test.a3')));
	perform dblink_send_query('fence_two', pg_temp.sql_record(current_setting('qorpera_test.a3')::uuid, 'race-card-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'D: the recorder must wait for the answer'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '42501 This change has no approval in this run%' then
		raise exception 'D: an answered card this run has not used: %', v_state; end if;
end $$;

-- E. Two recorders of one run: the second waits at the run mutex, then replays the first's record.
do $$
declare v_one text; v_two text;
begin
	perform dblink_exec('fence_one', 'begin');
	select r into v_one from dblink('fence_one', pg_temp.sql_record(current_setting('qorpera_test.a1')::uuid, 'race-allow')) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_record(current_setting('qorpera_test.a1')::uuid, 'race-allow'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'E: the second recorder must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'E: the second recorder must wait at the run mutex, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	select r into v_two from dblink_get_result('fence_two') as t(r text);
	perform * from dblink_get_result('fence_two') as t(r text);
	if v_two is distinct from v_one then raise exception 'E: the second recorder replays the first: % / %', v_one, v_two; end if;
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
		or exists (select 1 from public.qorpera_agent_sends where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
