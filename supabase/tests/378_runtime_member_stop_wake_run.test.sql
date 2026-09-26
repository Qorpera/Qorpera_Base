-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A member's Stop stops the run the agent is on in the displayed conversation,
-- whatever woke it (20260926141000). A routine run is a wake run in its agent's
-- thread; the conversation run control saw member turns only, so the web's Stop
-- never offered a routine run. Same authority as a member turn: the member may
-- write the conversation and saved the routine (created the job) or is an owner
-- or admin.

-- Bob's routine, saved by the owner, reports in Bob's company conversation (42).
select pg_temp.path_claims('service_role');
do $$
declare v_routine jsonb; v_wake uuid; v_run uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"tick","kind":"schedule","intervalMinutes":60,"replyPolicy":"required"}');
	v_wake := pg_temp.wake_schedule(v_routine,'stop-1');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = v_wake and status = 'materialized' and session_id = '30000000-0000-4000-8000-000000000042';
	perform pg_temp.wake_assert((select run.source_kind = 'wake' and job.created_by_user_id = '30000000-0000-4000-8000-000000000001'
		and job.status = 'queued' from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = v_run),'Fixture: the routine run is a queued wake run created for the member who saved the routine');
	perform set_config('qorpera_test.stop_wake',v_wake::text,true);
	perform set_config('qorpera_test.stop_run',v_run::text,true);
end
$$;

create function pg_temp.stop_read(p_session uuid) returns jsonb language sql as $$
	select public.qorpera_get_session_run_control(p_session) -> 'run'
$$;
create function pg_temp.stop_denied(p_session uuid,p_run uuid) returns void language plpgsql as $$
begin
	perform pg_temp.wake_error(format('select public.qorpera_cancel_session_run(%L,%L)',p_session,p_run),'42501');
end
$$;

set role authenticated;
-- The owner sees the queued routine run in Bob's conversation and may stop it.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','queued','can_cancel',true),
	'The conversation run control shows the routine run');
-- Only that conversation: the same run is not another conversation's to stop.
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000043') = 'null'::jsonb,
	'Another agent''s conversation does not show the run');
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000043',current_setting('qorpera_test.stop_run')::uuid);
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000040',current_setting('qorpera_test.stop_run')::uuid);

-- A contributor who did not save the routine and a viewer see the run and cannot stop it.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') ->> 'can_cancel' = 'false',
	'A contributor cannot stop a routine run another member set up');
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000042',current_setting('qorpera_test.stop_run')::uuid);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') ->> 'can_cancel' = 'false',
	'A viewer cannot stop a routine run');
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000042',current_setting('qorpera_test.stop_run')::uuid);
-- An outsider reads nothing and cannot stop by a remembered id.
reset role;
insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000009','stop-outsider@example.test');
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000009');
select pg_temp.wake_error($q$select public.qorpera_get_session_run_control('30000000-0000-4000-8000-000000000042')$q$,'42501');
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000042',current_setting('qorpera_test.stop_run')::uuid);
reset role;
select pg_temp.wake_assert((select status = 'queued' from public.qorpera_runner_jobs
	where run_id = current_setting('qorpera_test.stop_run')::uuid),'Refused Stops leave the run queued');

-- The routine run starts: it holds a runner lease and a native provider lease.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.stop_binding',pg_temp.wake_start(current_setting('qorpera_test.stop_run')::uuid)::text,true);

-- The member who saved the routine, now a contributor, stops it while it works.
-- (A company has one owner: ownership moves to a new member first.)
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '30000000-0000-4000-8000-000000000001';
insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000008','stop-owner@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000008','stop-owner@example.test','New owner','owner');
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','leased','can_cancel',true),
	'The working routine run is stoppable by the contributor who saved the routine');
select pg_temp.wake_assert(public.qorpera_cancel_session_run('30000000-0000-4000-8000-000000000042',
	current_setting('qorpera_test.stop_run')::uuid) = jsonb_build_object('session_id','30000000-0000-4000-8000-000000000042',
	'run_id',current_setting('qorpera_test.stop_run'),'status','cancelled'),'Stop confirms the cancelled routine run');
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') = 'null'::jsonb,
	'The conversation has no run after Stop');
-- A lost receipt's retry reads back; it never repeats the cancellation.
select pg_temp.wake_assert(public.qorpera_cancel_session_run('30000000-0000-4000-8000-000000000042',
	current_setting('qorpera_test.stop_run')::uuid) ->> 'status' = 'cancelled','A retried Stop reads back the cancelled run');
reset role;

-- The kernel's cancellation: the member is recorded (a dynamic routine pauses on
-- exactly this), the runner and native leases lose their authority, the routine's
-- occurrence ends cancelled, and the agent reads as idle, not failed.
select pg_temp.wake_assert((select status = 'cancelled' and cancelled_by_user_id = '30000000-0000-4000-8000-000000000001'
	and lease_token_sha256 is null and lease_expires_at is null
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.stop_run')::uuid),
	'Stop cancels the job, records the member and drops the runner lease');
select pg_temp.wake_assert((select count(*) = 1 from public.qorpera_runner_audit_receipts receipt
	join public.qorpera_runner_jobs job on job.id = receipt.job_id
	where job.run_id = current_setting('qorpera_test.stop_run')::uuid and receipt.event_type = 'job_cancelled'),
	'The retry did not repeat the cancellation');
select pg_temp.wake_assert((select status = 'revoked' and released_at is not null
	from public.qorpera_native_provider_connection_leases
	where id = (current_setting('qorpera_test.stop_binding')::jsonb ->> 'leaseId')::uuid),
	'Stop releases the run''s native provider lease');
select pg_temp.wake_assert((select status = 'cancelled' from public.qorpera_wake_occurrences
	where id = current_setting('qorpera_test.stop_wake')::uuid),'The routine occurrence ends cancelled');
select pg_temp.wake_assert((select status = 'active' from public.qorpera_cloud_routines where id = (
	select routine_id from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.stop_wake')::uuid)),
	'A scheduled routine keeps its schedule after one run is stopped');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(not exists(select 1 from jsonb_array_elements(
	public.qorpera_list_staff_execution_activity('30000000-0000-4000-8000-000000000020')) activity
	where activity ->> 'staff_agent_id' = '30000000-0000-4000-8000-000000000031'),
	'A stopped routine run is not shown as a failure to dismiss');

-- The same Stop ends an agent's answer to a coworker message, the member brake on a
-- loop between two agents (contract 14.6): the message wakes Bob in his own thread,
-- and the owner, who did not start that chain, stops the run there.
select pg_temp.path_claims('service_role');
do $$
declare v_alice jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_send jsonb; v_run uuid; v_thread uuid;
begin
	perform pg_temp.wake_public_send(v_alice,'progress');
	v_send := public.qorpera_send_coworker_message(v_alice,'30000000-0000-4000-8000-000000000031','stop-ask','Could you check the note?');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id,session_id into strict v_run,v_thread from public.qorpera_wake_occurrences
	where id = (v_send ->> 'occurrenceId')::uuid and status = 'materialized';
	perform pg_temp.wake_assert(v_thread <> '30000000-0000-4000-8000-000000000042' and (select staff_agent_id
		from public.qorpera_execution_runs where id = v_run) = '30000000-0000-4000-8000-000000000031',
		'Fixture: Bob answers in his own thread');
	perform set_config('qorpera_test.stop_peer_run',v_run::text,true);
	perform set_config('qorpera_test.stop_peer_thread',v_thread::text,true);
end
$$;
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000008');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_peer_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_peer_run'),'status','queued','can_cancel',true),
	'The owner sees the coworker wake in Bob''s thread and may stop it');
select pg_temp.wake_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.stop_peer_thread')::uuid,
	current_setting('qorpera_test.stop_peer_run')::uuid) ->> 'status' = 'cancelled','The owner stops the coworker wake');
reset role;
select pg_temp.wake_assert((select status = 'cancelled' and cancelled_by_user_id = '30000000-0000-4000-8000-000000000008'
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.stop_peer_run')::uuid),
	'The coworker wake is cancelled by the owner');

rollback;
