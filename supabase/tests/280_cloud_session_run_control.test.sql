-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's Stop of a run in an agent's thread, on folder-v2 (ported from snapshot-v1 in the legacy sweep): the
-- conversation run control (qorpera_get_session_run_control) and its Stop (qorpera_cancel_session_run). The runs are real:
-- the contributor's posts in Bob's thread, turned into runs by the folder materializer, and the base's leased run of
-- Alice's. The read names the conversation's current run, never an older failed or completed one, with public control
-- fields only. Only the run's creator, while a contributor, or an owner or admin stops it, and only by its exact
-- conversation and run; a retry or a late Stop never reaches another run, and a Stop writes nothing into the
-- conversation. A Stop of a leased run takes its execution token and ends its native lease, never the saved login;
-- completion and failure end that lease the same way; a recovered identity fences the old lease and runner. The grants
-- (anon none, authenticated both) are 001's allowlist rows.

-- The contributor's own native login and member sponsor, as the base makes the owner's: a post spends only the
-- poster's own login. Answers the sponsor's binding.
create function pg_temp.rc_member_binding() returns uuid language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_identity jsonb; v_login jsonb; v_connection jsonb;
	v_sponsor jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity('92400000-0000-4000-8000-000000000010',
		'28000000-0000-4000-8000-000000000050', 'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login('92400000-0000-4000-8000-000000000010',
		'28000000-0000-4000-8000-000000000051', '28000000-0000-4000-8000-000000000052',
		(v_identity ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('c', 64), 900);
	reset role;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat('c', 64),
		'28000000-0000-4000-8000-000000000060', 'object://native-capsules/28000000-0000-4000-8000-000000000060', repeat('d', 64),
		'fixture-member-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_sponsor := public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
		'28000000-0000-4000-8000-000000000061', (v_connection ->> 'connection_id')::uuid, 1, false);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return (v_sponsor ->> 'binding_id')::uuid;
end $$;
-- An agent's thread conversation.
create function pg_temp.rc_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- The contributor's post in Bob's thread as one run, its job made p_minutes ago (the order the conversation's runs were
-- made in); answers the run.
create function pg_temp.rc_post(p_text text, p_minutes integer) returns uuid language plpgsql as $$
declare v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000031', p_text,
		current_setting('qorpera_test.rc_member_binding')::uuid);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'Fixture: the post is one run: ' || v_pass::text);
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert((select run.source_kind = 'room_delivery' and run.session_id = pg_temp.rc_session(run.staff_agent_id)
		and run.staff_agent_id = '92400000-0000-4000-8000-000000000031' and job.status = 'queued'
		and job.created_by_user_id = '92400000-0000-4000-8000-000000000002'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_run),
		'Fixture: the post is a queued run in Bob''s thread, made for the contributor');
	update public.qorpera_runner_jobs set created_at = statement_timestamp() - make_interval(mins => p_minutes) where run_id = v_run;
	return v_run;
end $$;
create function pg_temp.rc_denied(p_session uuid, p_run uuid) returns void language sql as $$
	select pg_temp.base_error(format('select public.qorpera_cancel_session_run(%L, %L)', p_session, p_run), '42501',
		'cloud run cancellation is not allowed')
$$;
create function pg_temp.rc_job(p_run text) returns uuid language sql security definer as $$
	select job_id from public.qorpera_execution_runs where id = current_setting(p_run)::uuid
$$;

-- Another contributor, besides the base's.
insert into auth.users(id, email) values ('28000000-0000-4000-8000-000000000003', 'rc-other@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('92400000-0000-4000-8000-000000000010', '28000000-0000-4000-8000-000000000003', 'rc-other@example.test', 'Other', 'contributor');

-- Four of the contributor's posts in Bob's thread: the oldest failed, then the current run and its successor, both
-- queued, then a newer one that completed (completed with triggers off, as a fixture row: its sends are not this test's).
select set_config('qorpera_test.rc_member_binding', pg_temp.rc_member_binding()::text, true);
do $$
begin
	perform set_config('qorpera_test.rc_failed', pg_temp.rc_post('First question.', 9)::text, true);
	perform set_config('qorpera_test.rc_current', pg_temp.rc_post('Second question.', 8)::text, true);
	perform set_config('qorpera_test.rc_next', pg_temp.rc_post('Third question.', 7)::text, true);
	perform set_config('qorpera_test.rc_completed', pg_temp.rc_post('Fourth question.', 6)::text, true);
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture failure', finished_at = statement_timestamp()
	where run_id = current_setting('qorpera_test.rc_failed')::uuid;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = statement_timestamp()
	where run_id = current_setting('qorpera_test.rc_completed')::uuid;
	set local session_replication_role = origin;
	perform set_config('qorpera_test.rc_bob', pg_temp.rc_session('92400000-0000-4000-8000-000000000031')::text, true);
	perform set_config('qorpera_test.rc_alice', pg_temp.rc_session('92400000-0000-4000-8000-000000000030')::text, true);
	perform set_config('qorpera_test.rc_base_run', current_setting('qorpera_test.base_binding')::jsonb ->> 'runId', true);
	perform set_config('qorpera_test.rc_events', (select count(*) from public.qorpera_session_events
		where session_id in (current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_alice')::uuid))::text, true);
end $$;

-- 1. Older failed and completed runs do not mask current work, and the read returns only the closed public control
--    fields, never a payload, token or output.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_get_session_run_control(current_setting('qorpera_test.rc_bob')::uuid) = jsonb_build_object(
	'session_id', current_setting('qorpera_test.rc_bob'), 'staff_agent_id', '92400000-0000-4000-8000-000000000031',
	'run', jsonb_build_object('run_id', current_setting('qorpera_test.rc_current'), 'status', 'queued', 'can_cancel', true)),
	'The current run, with its public control fields only');

-- 2. Neither another contributor nor a viewer may stop the poster's run.
select pg_temp.base_claims('authenticated', '28000000-0000-4000-8000-000000000003');
select pg_temp.base_assert((public.qorpera_get_session_run_control(current_setting('qorpera_test.rc_bob')::uuid)
	#>> '{run,can_cancel}')::boolean = false, 'Another contributor is not offered the Stop');
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_current')::uuid);
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_current')::uuid);

-- 3. An outsider can neither read the company's run state nor stop by a remembered id.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_current')::uuid);
select pg_temp.base_error(format('select public.qorpera_get_session_run_control(%L)', current_setting('qorpera_test.rc_bob')), '42501',
	'cloud conversation is unavailable');
reset role;

-- 4. Current membership is required, even of the run's creator, on both endpoints. (A removed member's login is revoked
--    and its runs fail with it, so the downgrade and the removal are undone after their checks.)
select set_config('qorpera_test.rc_current_job', pg_temp.rc_job('qorpera_test.rc_current')::text, true);
savepoint rc_membership;
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_current')::uuid);
select pg_temp.base_error(format('select public.qorpera_cancel_runner_job(%L)', current_setting('qorpera_test.rc_current_job')), '42501',
	'runner job cancellation is not allowed');
reset role;
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_current')::uuid);
select pg_temp.base_error(format('select public.qorpera_cancel_runner_job(%L)', current_setting('qorpera_test.rc_current_job')), '42501',
	'runner job cancellation is not allowed');
reset role;
rollback to savepoint rc_membership;
select pg_temp.base_assert((select status from public.qorpera_runner_jobs where id = current_setting('qorpera_test.rc_current_job')::uuid)
	= 'queued', 'Refused Stops leave the run queued');

-- 5. The exact conversation is required, even of an owner, who may stop both runs.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.rc_denied(current_setting('qorpera_test.rc_alice')::uuid, current_setting('qorpera_test.rc_current')::uuid);
select pg_temp.rc_denied(current_setting('qorpera_test.rc_bob')::uuid, current_setting('qorpera_test.rc_base_run')::uuid);

-- 6. The creator stops their run, and the Stop is confirmed. A lost receipt's retry and late Stops of ended runs read
--    back, and none of them selects the successor.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_current')::uuid) = jsonb_build_object('session_id', current_setting('qorpera_test.rc_bob'),
	'run_id', current_setting('qorpera_test.rc_current'), 'status', 'cancelled'), 'The creator''s Stop is confirmed');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_current')::uuid) ->> 'status' = 'cancelled', 'A retried Stop reads back the cancelled run');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_completed')::uuid) ->> 'status' = 'completed', 'A late Stop leaves a completed run');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_failed')::uuid) ->> 'status' = 'failed', 'A late Stop leaves a failed run');
select pg_temp.base_assert(public.qorpera_get_session_run_control(current_setting('qorpera_test.rc_bob')::uuid) #>> '{run,run_id}'
	= current_setting('qorpera_test.rc_next'), 'A stale Stop cancelled no successor');

-- 7. An owner stops another member's exact run; then the conversation reads no run.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_next')::uuid) ->> 'status' = 'cancelled', 'The owner stops another member''s run');
select pg_temp.base_assert(public.qorpera_get_session_run_control(current_setting('qorpera_test.rc_bob')::uuid) -> 'run' = 'null'::jsonb,
	'An idle conversation reads no run');
reset role;

-- 8. The cancellation's effects: one audit receipt despite the retry; the member recorded, no finish, no lease and no
--    attempt; Alice's run in her thread untouched; no event written into either conversation.
select pg_temp.base_assert((select count(*) from public.qorpera_runner_audit_receipts
	where job_id = current_setting('qorpera_test.rc_current_job')::uuid and event_type = 'job_cancelled') = 1,
	'The retry repeated no cancellation');
select pg_temp.base_assert((select status = 'cancelled' and cancelled_at is not null and finished_at is null
	and cancelled_by_user_id = '92400000-0000-4000-8000-000000000002' and lease_token_sha256 is null and attempt_count = 0
	from public.qorpera_runner_jobs where id = current_setting('qorpera_test.rc_current_job')::uuid),
	'The Stop records the member, and the job never ran');
select pg_temp.base_assert((select status from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.rc_base_run')::uuid)
	= 'leased', 'Another conversation''s run is untouched');
select pg_temp.base_assert((select count(*) from public.qorpera_session_events where session_id in (current_setting('qorpera_test.rc_bob')::uuid,
	current_setting('qorpera_test.rc_alice')::uuid)) = current_setting('qorpera_test.rc_events')::bigint,
	'A Stop writes no output into the conversation');

-- 9. Alice's leased run (the base's, on a real runner with its native lease). A recovered identity fences the old lease
--    and runner, even for a caller that knows their tokens (only the fixture's generation moves, and goes back).
do $$
declare v_job public.qorpera_runner_jobs;
begin
	select * into strict v_job from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.rc_base_run')::uuid;
	perform pg_temp.base_assert(v_job.status = 'leased' and v_job.lease_token_sha256 is not null and v_job.attempt_count > 0,
		'Fixture: the base run holds its execution token: ' || to_jsonb(v_job)::text);
	perform set_config('qorpera_test.rc_token', v_job.lease_token_sha256, true);
	perform set_config('qorpera_test.rc_attempts', v_job.attempt_count::text, true);
end $$;
savepoint rc_terminal;
update public.qorpera_member_compute_identities set recovery_epoch = 1
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId')::uuid;
select pg_temp.base_assert(not (select public.qorpera_execution_compute_available(run) from public.qorpera_execution_runs run
	where id = current_setting('qorpera_test.rc_base_run')::uuid), 'The old run''s compute is gone after recovery');
select pg_temp.base_error(format('update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval ''3 minutes'' where id = %L',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId'), '42501', 'native lease generation is fenced for recovery');
select pg_temp.base_error(format('update public.qorpera_runners set session_expires_at = clock_timestamp() + interval ''1 hour'' where id = %L',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'runnerId'), '42501', 'runner identity is fenced for recovery');
rollback to savepoint rc_terminal;

-- 10. A Stop of the leased run takes the same exact-run path: the job loses its execution token and runs no new attempt,
--     the run's native lease ends, and the saved login stays.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_get_session_run_control(current_setting('qorpera_test.rc_alice')::uuid) -> 'run'
	= jsonb_build_object('run_id', current_setting('qorpera_test.rc_base_run'), 'status', 'leased', 'can_cancel', true),
	'The leased run is offered');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.rc_alice')::uuid,
	current_setting('qorpera_test.rc_base_run')::uuid) ->> 'status' = 'cancelled', 'The leased run stops');
reset role;
select pg_temp.base_assert((select status = 'cancelled' and lease_token_sha256 is null and lease_expires_at is null
	and terminal_lease_token_sha256 = current_setting('qorpera_test.rc_token') and attempt_count = current_setting('qorpera_test.rc_attempts')::integer
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.rc_base_run')::uuid),
	'A leased Stop keeps no execution authority and reruns nothing');
select pg_temp.base_assert((select status = 'revoked' and released_at is not null from public.qorpera_native_provider_connection_leases
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId')::uuid), 'The Stop ends the run''s native lease');
select pg_temp.base_assert((select status = 'active' from public.qorpera_native_credential_capsules
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid),
	'The Stop ends the run''s lease, not the saved login');
select pg_temp.base_assert(not has_function_privilege('authenticated', 'public.qorpera_terminalize_native_provider_lease()', 'execute'),
	'The native lease cleanup is not a client function');

-- 11. Completion and failure end the same run lease, never the saved login (the fixture transition is undone between
--     cases). The run acknowledges and reports first, as a human wake must.
rollback to savepoint rc_terminal;
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'rc-ack') \g /dev/null
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'rc-final') \g /dev/null
update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = current_setting('qorpera_test.rc_base_run')::uuid;
select pg_temp.base_assert((select status = 'released' and released_at is not null from public.qorpera_native_provider_connection_leases
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId')::uuid), 'Completion releases the run''s native lease');
rollback to savepoint rc_terminal;
update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture failure', finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = current_setting('qorpera_test.rc_base_run')::uuid;
select pg_temp.base_assert((select status = 'revoked' and released_at is not null from public.qorpera_native_provider_connection_leases
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId')::uuid), 'Failure ends the run''s native lease');
select pg_temp.base_assert((select status = 'active' from public.qorpera_native_credential_capsules
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid),
	'Failure ends the run''s lease, not the saved login');

rollback;
