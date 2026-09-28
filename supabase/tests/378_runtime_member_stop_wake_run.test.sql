-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A member's Stop in a conversation reaches the agent's runs there
-- (20260926183100). In an agent's own thread a member's message is a room post
-- and a routine run is a wake run; the conversation run control saw plain member
-- turns only, so the web's Stop offered neither. Same authority as a member
-- turn: the member may write the conversation and created the run's job (posted
-- the message, saved the routine) or is an owner or admin.

-- Bob's own thread. The fixture closes the agents' threads; reopened, it is where
-- a routine reports, as in production (qorpera_wake_public_session prefers it).
select pg_temp.path_claims('service_role');
do $$
declare v_thread uuid; v_room uuid;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	select id into strict v_room from public.qorpera_company_rooms where session_id = v_thread and status = 'active';
	perform set_config('qorpera_test.stop_thread',v_thread::text,true);
	perform set_config('qorpera_test.stop_room',v_room::text,true);
end
$$;

-- Bob's routine, saved by the owner, runs in Bob's thread.
do $$
declare v_routine jsonb; v_wake uuid; v_run uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"tick","kind":"schedule","intervalMinutes":60,"replyPolicy":"required"}');
	v_wake := pg_temp.wake_schedule(v_routine,'stop-1');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = v_wake and status = 'materialized' and session_id = current_setting('qorpera_test.stop_thread')::uuid;
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

-- A contributor's own queued message in Bob's thread: a room delivery, as every
-- member message there is. Inserted as 280 does, on an account of the contributor's
-- own: a member's login pays only for that member's work (20260928230000).
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select set_config('qorpera_test.stop_member_connection',public.qorpera_register_provider_connection(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000780','30000000-0000-4000-8000-000000000002',
	'openai','api_key','openai-responses','vault://member/openai','member-account','member-api-budget',
	'qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
	false)::text,true);
select set_config('qorpera_test.stop_member_sponsor',public.qorpera_create_member_execution_sponsor(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000781',
	(current_setting('qorpera_test.stop_member_connection')::jsonb ->> 'connection_id')::uuid,1,false)::text,true);
select pg_temp.path_claims('service_role');
create function pg_temp.stop_member_run(p_user uuid) returns uuid language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_id uuid := extensions.gen_random_uuid(); v_job uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = current_setting('qorpera_test.stop_run')::uuid;
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,v_base.session_id,v_base.substrate_version_id,v_id,
		'agent_turn','agent_turn','{}',p_user) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	values(v_id,v_base.profile_id,v_base.environment_id,'room_delivery',v_id,v_base.session_id,v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,v_base.staff_agent_id,v_base.staff_version,'{}',
		case when p_user = v_base.requested_by_user_id then v_base.sponsor_binding_id
			else (current_setting('qorpera_test.stop_member_sponsor')::jsonb ->> 'binding_id')::uuid end,
		case when p_user = v_base.requested_by_user_id then v_base.sponsor_version else 1 end,
		'agent_turn','agent_turn',repeat('e',64),
		case when p_user = v_base.requested_by_user_id then v_base.compute_identity_id end,0,p_user);
	update public.qorpera_runner_jobs set run_id = v_id where id = v_job;
	return v_id;
end
$$;

set role authenticated;
-- The owner sees the queued routine run in Bob's thread and may stop it.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','queued','can_cancel',true),
	'The conversation run control shows the routine run');
-- Only that conversation, even another one with the same agent: Bob's plain
-- company conversation (42) neither shows the run nor stops it.
select pg_temp.wake_assert(pg_temp.stop_read('30000000-0000-4000-8000-000000000042') = 'null'::jsonb,
	'Another conversation with the same agent does not show the run');
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000042',current_setting('qorpera_test.stop_run')::uuid);
select pg_temp.stop_denied('30000000-0000-4000-8000-000000000043',current_setting('qorpera_test.stop_run')::uuid);

-- A contributor who did not save the routine and a viewer see the run and cannot stop it.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) ->> 'can_cancel' = 'false',
	'A contributor cannot stop a routine run another member set up');
select pg_temp.stop_denied(current_setting('qorpera_test.stop_thread')::uuid,current_setting('qorpera_test.stop_run')::uuid);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) ->> 'can_cancel' = 'false',
	'A viewer cannot stop a routine run');
select pg_temp.stop_denied(current_setting('qorpera_test.stop_thread')::uuid,current_setting('qorpera_test.stop_run')::uuid);
-- An outsider reads nothing and cannot stop by a remembered id.
reset role;
insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000009','stop-outsider@example.test');
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000009');
select pg_temp.wake_error(format('select public.qorpera_get_session_run_control(%L)',current_setting('qorpera_test.stop_thread')),'42501');
select pg_temp.stop_denied(current_setting('qorpera_test.stop_thread')::uuid,current_setting('qorpera_test.stop_run')::uuid);
reset role;
select pg_temp.wake_assert((select status = 'queued' from public.qorpera_runner_jobs
	where run_id = current_setting('qorpera_test.stop_run')::uuid),'Refused Stops leave the run queued');

-- The routine run starts: it holds a runner lease and a native provider lease.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.stop_binding',pg_temp.wake_start(current_setting('qorpera_test.stop_run')::uuid)::text,true);

-- A member's own message in the thread is a room post; its run is stoppable too.
-- While the routine run works, the owner is offered the working run, and a
-- contributor is offered their own queued message and may not stop another's.
savepoint member_messages;
do $$
declare v_base public.qorpera_execution_runs%rowtype; v_result jsonb; v_run uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_post_company_room_message(current_setting('qorpera_test.stop_room')::uuid,
		extensions.gen_random_uuid(),'{"schema":"qorpera.session-prompt/v1","text":"Bob, also check the invoices."}',
		v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	perform pg_temp.wake_assert((select run.source_kind = 'room_delivery' and run.session_id = current_setting('qorpera_test.stop_thread')::uuid
		and job.created_by_user_id = '30000000-0000-4000-8000-000000000001' and job.status = 'queued'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_run),
		'Fixture: the owner''s message in Bob''s thread is a queued room delivery');
	perform set_config('qorpera_test.stop_post_run',v_run::text,true);
	perform set_config('qorpera_test.stop_own_run',pg_temp.stop_member_run('30000000-0000-4000-8000-000000000002')::text,true);
end
$$;
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','leased','can_cancel',true),
	'An owner is offered the run the agent is working on');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.stop_denied(current_setting('qorpera_test.stop_thread')::uuid,current_setting('qorpera_test.stop_post_run')::uuid);
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_own_run'),'status','queued','can_cancel',true),
	'A contributor is offered their own queued message, not the routine run they may not stop');
select pg_temp.wake_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.stop_thread')::uuid,
	current_setting('qorpera_test.stop_own_run')::uuid) ->> 'status' = 'cancelled','The contributor stops their own run');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','leased','can_cancel',false),
	'Then the contributor sees the routine run, without a Stop');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.stop_thread')::uuid,
	current_setting('qorpera_test.stop_post_run')::uuid) ->> 'status' = 'cancelled','The owner stops the reply to their own message');
reset role;
select pg_temp.wake_assert((select array_agg(cancelled_by_user_id::text order by cancelled_by_user_id) from public.qorpera_runner_jobs
	where run_id in (current_setting('qorpera_test.stop_post_run')::uuid,current_setting('qorpera_test.stop_own_run')::uuid)
		and status = 'cancelled') = array['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002']
	and (select status = 'leased' from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.stop_run')::uuid),
	'Each Stop cancelled exactly its own run');
rollback to savepoint member_messages;

-- The member who saved the routine, now a contributor, stops it while it works.
-- (A company has one owner: ownership moves to a new member first.)
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '30000000-0000-4000-8000-000000000001';
insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000008','stop-owner@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000008','stop-owner@example.test','New owner','owner');
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = jsonb_build_object(
	'run_id',current_setting('qorpera_test.stop_run'),'status','leased','can_cancel',true),
	'The working routine run is stoppable by the contributor who saved the routine');
select pg_temp.wake_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.stop_thread')::uuid,
	current_setting('qorpera_test.stop_run')::uuid) = jsonb_build_object('session_id',current_setting('qorpera_test.stop_thread'),
	'run_id',current_setting('qorpera_test.stop_run'),'status','cancelled'),'Stop confirms the cancelled routine run');
select pg_temp.wake_assert(pg_temp.stop_read(current_setting('qorpera_test.stop_thread')::uuid) = 'null'::jsonb,
	'The conversation has no run after Stop');
-- A lost receipt's retry reads back; it never repeats the cancellation.
select pg_temp.wake_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.stop_thread')::uuid,
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
