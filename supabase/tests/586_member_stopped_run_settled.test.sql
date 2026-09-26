-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A run a member stopped is not a failure (20260926192436). The agent activity
-- list keeps one run per agent and ranks an undismissed failure above work, so
-- a stopped message used to stand for the agent as failed and hid the run it
-- was still working on (and with it the composer's Stop). Now a stopped run
-- drops out, except while a Company File proposal of its own waits for a
-- decision; that decision ranks below live work.

-- Bob's own thread, reopened as in 378: his routine runs there, and a member's
-- message there is a room post.
select pg_temp.path_claims('service_role');
do $$
declare v_thread uuid;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	perform set_config('qorpera_test.settled_thread',v_thread::text,true);
end
$$;

-- Bob's routine run is working in his thread.
do $$
declare v_routine jsonb; v_wake uuid; v_run uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"tick","kind":"schedule","intervalMinutes":60,"replyPolicy":"required"}');
	v_wake := pg_temp.wake_schedule(v_routine,'settled-1');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = v_wake and status = 'materialized' and session_id = current_setting('qorpera_test.settled_thread')::uuid;
	perform pg_temp.wake_start(v_run);
	perform set_config('qorpera_test.settled_wake',v_wake::text,true);
	perform set_config('qorpera_test.settled_routine_run',v_run::text,true);
end
$$;

-- One of Bob's runs for a member: a post in his thread or a turn in a plain
-- conversation with him. Inserted as 378 does, because this fixture gives the
-- contributor no model account of their own to post with.
create function pg_temp.settled_run(p_kind text,p_session uuid,p_user uuid) returns uuid language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_id uuid := extensions.gen_random_uuid(); v_job uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = current_setting('qorpera_test.settled_routine_run')::uuid;
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,p_session,v_base.substrate_version_id,v_id,
		'agent_turn','agent_turn','{}',p_user) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	values(v_id,v_base.profile_id,v_base.environment_id,p_kind,v_id,p_session,v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,v_base.staff_agent_id,v_base.staff_version,
		case when p_kind = 'session_turn' then array[v_id] else '{}' end,
		v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,p_user);
	update public.qorpera_runner_jobs set run_id = v_id where id = v_job;
	return v_id;
end
$$;
create function pg_temp.settled_job(p_run uuid) returns uuid language sql security definer as $$
	select job_id from public.qorpera_execution_runs where id = p_run
$$;
-- What a member sees of Bob: his one activity row, or null when he is idle.
create function pg_temp.settled_bob() returns jsonb language sql as $$
	select entry - 'updated_at' - 'phase' - 'staff_agent_id'
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('30000000-0000-4000-8000-000000000020')) entry
	where entry ->> 'staff_agent_id' = '30000000-0000-4000-8000-000000000031'
$$;
create function pg_temp.settled_row(p_run text,p_kind text,p_status text,p_activity text) returns jsonb language sql as $$
	select jsonb_build_object('run_id',p_run,'source_kind',p_kind,'job_status',p_status,'activity',p_activity)
$$;
-- A Company File proposal the run left behind, as a stopped attempt's partial output leaves one.
create function pg_temp.settled_proposal(p_run uuid) returns uuid language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_snapshot uuid := extensions.gen_random_uuid(); v_id uuid := extensions.gen_random_uuid();
begin
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
	insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
		tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
	select v_snapshot,v_run.profile_id,v_run.environment_id,snapshot.workspace_id,v_snapshot,repeat('f',64),2,3,0,0,
		'30000000-0000-4000-8000-000000000001'
	from public.qorpera_company_snapshots snapshot where snapshot.id = v_run.company_snapshot_id;
	insert into public.qorpera_company_proposals(id,profile_id,environment_id,client_proposal_id,base_snapshot_id,
		proposal_snapshot_id,execution_kind,execution_id,execution_claimant_id,session_id,trail_end_sequence,
		reason,policy_key,title,reviewer_staff_ids,created_by_user_id)
	values(v_id,v_run.profile_id,v_run.environment_id,v_id,v_run.company_snapshot_id,v_snapshot,'run',v_run.id,v_run.id,
		v_run.session_id,0,'recovery',null,'Recover completed operation Company File output','{}',
		'30000000-0000-4000-8000-000000000001');
	return v_id;
end
$$;

-- The list is still the members' read only; the patch kept its grants.
select pg_temp.wake_assert(has_function_privilege('authenticated','public.qorpera_list_staff_execution_activity(uuid)','execute')
	and not has_function_privilege('anon','public.qorpera_list_staff_execution_activity(uuid)','execute')
	and not has_function_privilege('qorpera_secret_broker','public.qorpera_list_staff_execution_activity(uuid)','execute')
	and not exists(select 1 from pg_proc, aclexplode(proacl) acl
		where pg_proc.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure and acl.grantee = 0),
	'The activity list keeps its grants');

-- The reported case: while the routine run works, a contributor posts in Bob's
-- thread and stops their own message.
select set_config('qorpera_test.settled_post',pg_temp.settled_run('room_delivery',
	current_setting('qorpera_test.settled_thread')::uuid,'30000000-0000-4000-8000-000000000002')::text,true);
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(public.qorpera_cancel_runner_job(pg_temp.settled_job(current_setting('qorpera_test.settled_post')::uuid))
	->> 'status' = 'cancelled','The contributor stops their own message');
reset role;
select pg_temp.wake_assert((select cancelled_by_user_id = '30000000-0000-4000-8000-000000000002' from public.qorpera_runner_jobs
	where run_id = current_setting('qorpera_test.settled_post')::uuid),'Fixture: the Stop records the member');
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_routine_run'),
	'wake','leased','working'),'A stopped message does not hide the run the agent is working on');
select pg_temp.wake_assert(not exists(select 1 from jsonb_array_elements(
	public.qorpera_list_staff_execution_activity('30000000-0000-4000-8000-000000000020')) entry
	where entry ->> 'run_id' = current_setting('qorpera_test.settled_post')),'The stopped message is not listed at all');
reset role;

-- A failure still stands for the agent above its work until it is dismissed.
savepoint failure;
select set_config('qorpera_test.settled_failed',pg_temp.settled_run('room_delivery',
	current_setting('qorpera_test.settled_thread')::uuid,'30000000-0000-4000-8000-000000000002')::text,true);
update public.qorpera_runner_jobs set status = 'failed', finished_at = statement_timestamp(),
	last_error = 'Runner lease expired before durable completion'
where run_id = current_setting('qorpera_test.settled_failed')::uuid;
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_failed'),
	'room_delivery','failed','needs_attention'),'A failed message still reads as a failure above live work');
reset role;
rollback to savepoint failure;

-- The same in a plain conversation with Bob: the owner stops their own turn there.
select set_config('qorpera_test.settled_turn',pg_temp.settled_run('session_turn',
	'30000000-0000-4000-8000-000000000042','30000000-0000-4000-8000-000000000001')::text,true);
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_cancel_session_run('30000000-0000-4000-8000-000000000042',
	current_setting('qorpera_test.settled_turn')::uuid) ->> 'status' = 'cancelled','The owner stops their own turn');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_routine_run'),
	'wake','leased','working'),'A stopped member turn does not hide the run the agent is working on');

-- A Stop that left Company File changes: the decision waits, below live work.
-- The owner also stops a post of their own that had begun changing the Company File.
reset role;
select set_config('qorpera_test.settled_changes',pg_temp.settled_run('room_delivery',
	current_setting('qorpera_test.settled_thread')::uuid,'30000000-0000-4000-8000-000000000001')::text,true);
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_cancel_runner_job(pg_temp.settled_job(current_setting('qorpera_test.settled_changes')::uuid))
	->> 'status' = 'cancelled','The owner stops a post that changed the Company File');
reset role;
select set_config('qorpera_test.settled_changes_proposal',
	pg_temp.settled_proposal(current_setting('qorpera_test.settled_changes')::uuid)::text,true);
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_routine_run'),
	'wake','leased','working'),'A stopped run''s open proposal ranks below the run the agent is working on');
-- The owner stops the routine run too. Now the decision is what Bob waits on.
select pg_temp.wake_assert(public.qorpera_cancel_runner_job(pg_temp.settled_job(current_setting('qorpera_test.settled_routine_run')::uuid))
	->> 'status' = 'cancelled','The owner stops the routine run');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_changes'),
	'room_delivery','cancelled','needs_attention'),'Once nothing runs, the stopped run''s open proposal asks for the decision');
-- Dismissing the line does not decide the proposal, so the decision stays.
select pg_temp.wake_assert(public.qorpera_resolve_failed_execution_run(current_setting('qorpera_test.settled_changes')::uuid,
	'acknowledge') ->> 'resolved' = 'true','The owner dismisses the stopped run');
select pg_temp.wake_assert(pg_temp.settled_bob() ->> 'run_id' = current_setting('qorpera_test.settled_changes'),
	'A dismissed stop still asks for its open decision');
reset role;
update public.qorpera_company_proposals set status = 'rejected', resolved_at = statement_timestamp(),
	resolved_by_user_id = '30000000-0000-4000-8000-000000000001'
where id = current_setting('qorpera_test.settled_changes_proposal')::uuid;
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.settled_bob() is null,'With every stop settled and no decision left, Bob is idle');
reset role;
select pg_temp.wake_assert((select status = 'cancelled' from public.qorpera_wake_occurrences
	where id = current_setting('qorpera_test.settled_wake')::uuid),'Fixture: the stopped routine occurrence ended cancelled');

-- A stopped routine run that left changes asks for the decision the same way.
select pg_temp.settled_proposal(current_setting('qorpera_test.settled_routine_run')::uuid);
set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.settled_bob() = pg_temp.settled_row(current_setting('qorpera_test.settled_routine_run'),
	'wake','cancelled','needs_attention'),'A stopped routine run''s open proposal asks for the decision');
reset role;

rollback;
