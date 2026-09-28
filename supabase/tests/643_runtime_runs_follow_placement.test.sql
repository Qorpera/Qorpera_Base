-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Identical nodes, change 3 (20260928183000): runs follow the placement.
-- Node A: the fixture orchestrator ...092 as its fast host (adapter 'process') and a fresh-VM
-- orchestrator as overflow (same adapter). Node B: a fast host (adapter 'native-b').
-- The fixture's own run is held by ...092, so node A starts busier than node B.
select pg_temp.path_claims('service_role');
reset role;
create function pg_temp.fp_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.fp_refuse(p_orchestrator uuid,p_claim jsonb,p_reason text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),
		'ADMISSION_REFUSED:' || p_reason)
$$;
create function pg_temp.fp_run(p_input uuid) returns uuid language plpgsql as $$
begin
	insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
	values(p_input,'30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
		'user_message','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.session-prompt/v1","text":"Work","images":[]}');
	return pg_temp.wake_input_run(array[p_input]);
end $$;
create function pg_temp.fp_placement(p_run uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_run_placement(job,run) from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.id = job.run_id where run.id = p_run
$$;
-- Waits count from queued_at (a retry queues the job again); created_at stays.
create function pg_temp.fp_age(p_run uuid,p_seconds numeric) returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - make_interval(secs => p_seconds)
	where run_id = p_run
$$;
create function pg_temp.fp_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;

select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.fp_policy('64300000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0);
select public.qorpera_configure_runtime_node(pg_temp.fp_policy('64300000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0);
select public.qorpera_enroll_runtime_node_provider('64300000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592);
select public.qorpera_enroll_runtime_node_provider('64300000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592);
select public.qorpera_register_runner_orchestrator('64300000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600);
select public.qorpera_register_runner_orchestrator('64300000-0000-4000-8000-0000000000a2','Node A fresh VMs','process',repeat('5',64),3600);

-- Without roles nothing changes: the first orchestrator to ask takes the run.
reset role;
select set_config('qorpera_test.fp_r0',pg_temp.fp_run('64300000-0000-4000-8000-000000000100')::text,true);
set local role service_role;
savepoint no_roles;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'Without dispatch roles the fresh-VM path claims at once, as before');
rollback to savepoint no_roles;

-- Roles: operator only; a revoked or unknown orchestrator is refused.
reset role;
select pg_temp.wake_assert(not has_function_privilege(role_name,'public.qorpera_set_runner_orchestrator_dispatch_role(uuid,text)','EXECUTE'),
	'Not public for ' || role_name) from unnest(array['anon','authenticated']) role_name;
select pg_temp.wake_assert(not has_function_privilege('service_role',
	'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)','EXECUTE'),'The claim turn is internal');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000b1','fastest')$q$,
	'42501','Invalid orchestrator dispatch role');
select pg_temp.wake_error($q$select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000ff','fast')$q$,
	'42501','Orchestrator is unavailable');
select public.qorpera_set_runner_orchestrator_dispatch_role('30000000-0000-4000-8000-000000000092','fast');
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000b1','fast');
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000a2','overflow');

-- The least busy node is B (A holds the fixture run). A's fast host and A's overflow wait; B takes it.
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000b'
	and pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'reason' = 'LEAST_BUSY'
	and jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 2,
	'Placement: ' || pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid)::text);
select pg_temp.wake_assert(pg_temp.fp_claim('30000000-0000-4000-8000-000000000092') = 'null'::jsonb,
	'The busier node''s fast host leaves the run to the preferred node during the head start');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') = 'null'::jsonb,
	'The fresh-VM path waits while a fast host may take the run');
savepoint preferred;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.fp_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The preferred node''s fast host takes the run at once');

-- B's fast host is full: A's fast host and the overflow may both take it now, inside B's wait.
select pg_temp.fp_refuse('64300000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fp_claim')::jsonb,'SANDBOX_CAPACITY_EXHAUSTED');
savepoint refused;
select pg_temp.wake_assert(pg_temp.fp_claim('30000000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'After the preferred node refused, the other fast host takes the run');
rollback to savepoint refused;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.fp_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'After a fast host refused for capacity, the fresh-VM path takes the run');
-- A fast host refuses work it does not serve (NODE_NOT_PREFERRED): the overflow takes it at once.
rollback to savepoint refused;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('30000000-0000-4000-8000-000000000092')::text,true);
select pg_temp.fp_refuse('30000000-0000-4000-8000-000000000092',current_setting('qorpera_test.fp_claim')::jsonb,'NODE_NOT_PREFERRED');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The fresh-VM path takes what a fast host does not serve');
-- The overflow never skips its own wait: its node is full too, so everyone waits, the overflow included.
rollback to savepoint refused;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2')::text,true);
select pg_temp.fp_refuse('64300000-0000-4000-8000-0000000000a2',current_setting('qorpera_test.fp_claim')::jsonb,'NODE_CAPACITY_EXHAUSTED');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') = 'null'::jsonb,'The overflow waits out its own refusal');
-- Both fast hosts full inside one wait (everyone waits, 20260928180000): the overflow still may.
rollback to savepoint refused;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('30000000-0000-4000-8000-000000000092')::text,true);
select pg_temp.fp_refuse('30000000-0000-4000-8000-000000000092',current_setting('qorpera_test.fp_claim')::jsonb,'SANDBOX_CAPACITY_EXHAUSTED');
reset role;
select pg_temp.wake_assert((select dispatch_refused_by is null and dispatch_deferred_until > statement_timestamp()
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.fp_r0')::uuid),'Two full fast hosts: every orchestrator waits');
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1') = 'null'::jsonb,'A full fast host waits');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The fresh-VM path takes what both fast hosts refused, without waiting');
rollback to savepoint preferred;

-- The claim turn records its choice: the claim event names it, and a run machine's reservation records it
-- instead of asking the node chooser again.
savepoint recorded;
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1')::text,true);
reset role;
select pg_temp.wake_assert((select payload -> 'placement' = '{"reason":"LEAST_BUSY","nodeId":"64300000-0000-4000-8000-00000000000b"}'::jsonb
	from public.qorpera_execution_run_events where run_id = current_setting('qorpera_test.fp_r0')::uuid and event_type = 'orchestrator_claimed'
	order by created_at desc limit 1),'The claim event names the placement');
set local role service_role;
select set_config('qorpera_test.fp_runner',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.fp_r0')::uuid,
	'64300000-0000-4000-8000-0000000000c1','native-b',repeat('1',64)) ->> 'runner_id'),true);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine('64300000-0000-4000-8000-0000000000c1','native-b',repeat('7',64),
	current_setting('qorpera_test.fp_r0')::uuid,current_setting('qorpera_test.fp_runner')::uuid) ->> 'state' = 'reserved',
	'The fast host''s reservation follows the claim');
reset role;
select pg_temp.wake_assert((select decision = 'placed' and reason = 'CLAIM_TURN_LEAST_BUSY' and node_id = '64300000-0000-4000-8000-00000000000b'
	from public.qorpera_runtime_node_placements where allocation_id = '64300000-0000-4000-8000-0000000000c1'),
	'The placement record names the claim turn, not the node chooser');
set local role service_role;
rollback to savepoint recorded;

-- Held claims count as runs: after node B's fast host holds one, A and B are equal and the lower node id wins.
savepoint held;
reset role;
select set_config('qorpera_test.fp_r1',pg_temp.fp_run('64300000-0000-4000-8000-000000000101')::text,true);
update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
	created_at = statement_timestamp() - interval '1 minute' where run_id = current_setting('qorpera_test.fp_r1')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r1'),
	'B takes the older run');
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000a',
	'A held claim makes node B as busy as node A: ' || pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid)::text);
rollback to savepoint held;

-- Only fast hosts the run's login allows count: a login whose home is node A keeps the run's placement on A.
savepoint homed;
reset role;
insert into public.qorpera_runtime_machine_allocations(id,profile_id,login_session_id,login_compute_identity_id,provider_adapter,instance_sha256)
select '64300000-0000-4000-8000-0000000000d1',run.profile_id,(current_setting('qorpera_test.wake_login')::jsonb ->> 'login_id')::uuid,
	run.compute_identity_id,'process',repeat('8',64)
from public.qorpera_execution_runs run where run.id = current_setting('qorpera_test.fp_r0')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast'
		= '[{"nodeId":"64300000-0000-4000-8000-00000000000a","orchestratorId":"30000000-0000-4000-8000-000000000092"}]'::jsonb,
	'Only the home node''s fast host may take a homed run: ' || pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid)::text);
rollback to savepoint homed;

-- A fast host declared for another bundle is left out (rolling updates, 20260928182000); a revoked one too.
savepoint declared;
reset role;
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
select 'qorpera.cloud-runtime',b.version + 1,b.manifest || '{"fixturePlacement":true}'::jsonb,
	encode(extensions.digest(convert_to((b.manifest || '{"fixturePlacement":true}'::jsonb)::text,'utf8'),'sha256'),'hex')
from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
select set_config('qorpera_test.fp_other_bundle',(select sha256 from public.qorpera_runtime_bundles where manifest ? 'fixturePlacement'),true);
set local role service_role;
select public.qorpera_declare_runner_orchestrator_bundle('64300000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fp_other_bundle'));
select pg_temp.wake_assert(jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 1
	and pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000a',
	'A fast host of another bundle is not waited for');
rollback to savepoint declared;
savepoint revoked;
reset role;
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '64300000-0000-4000-8000-0000000000b1';
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000a',
	'A revoked fast host is not waited for');
rollback to savepoint revoked;

-- The head start ends after 1.5 s; the overflow's own wait after 10 s.
reset role;
select pg_temp.fp_age(current_setting('qorpera_test.fp_r0')::uuid,2);
set local role service_role;
savepoint aged;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') = 'null'::jsonb,'Overflow still waits at 2 s');
select pg_temp.wake_assert(pg_temp.fp_claim('30000000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'After the head start any fast host takes the run');
rollback to savepoint aged;
reset role;
select pg_temp.fp_age(current_setting('qorpera_test.fp_r0')::uuid,11);
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'After 10 s the fresh-VM path takes the run');
rollback to savepoint preferred;

-- Warm: the conversation's previous run completed on node A's fast host a minute ago. A new run of the
-- same conversation prefers node A although node A is busier.
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','warm-ack');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'final','warm-final');
reset role;
update public.qorpera_runner_jobs set status = 'completed', finished_at = statement_timestamp() - interval '1 minute',
	result = '{}'::jsonb, lease_token_sha256 = null, lease_expires_at = null
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
update public.qorpera_runner_job_claims set status = 'accepted'
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid and status in ('claimed','assigned');
update public.qorpera_execution_runs set session_id = '30000000-0000-4000-8000-000000000042'
where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid and session_id is distinct from '30000000-0000-4000-8000-000000000042';
update public.qorpera_execution_runs set created_at = statement_timestamp() - interval '2 minutes'
where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000a'
	and pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'reason' = 'WARM_CONVERSATION',
	'A warm conversation prefers its node: ' || pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid)::text);
savepoint warm;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1') = 'null'::jsonb,'The other node leaves a warm run alone');
select pg_temp.wake_assert(pg_temp.fp_claim('30000000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The warm node''s fast host takes it');
rollback to savepoint warm;
-- A previous run that failed leaves nothing warm.
savepoint warm_failed;
reset role;
update public.qorpera_runner_jobs set status = 'failed', result = null
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'reason' = 'LEAST_BUSY',
	'A failed previous run is not warm');
rollback to savepoint warm_failed;
-- Past the warm window the conversation is cold again.
reset role;
update public.qorpera_runner_jobs set finished_at = statement_timestamp() - interval '6 minutes'
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'reason' = 'LEAST_BUSY',
	'Past 5 minutes the conversation is cold');

-- An emptying node, or a fast host whose heartbeat stopped, is not a place to wait for.
select public.qorpera_set_runtime_node_serving('64300000-0000-4000-8000-00000000000a',false,1,'update');
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000b'
	and jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 1,'Only serving nodes count');
select public.qorpera_set_runtime_node_serving('64300000-0000-4000-8000-00000000000a',true,1,'back');
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = statement_timestamp() - interval '1 minute'
where id = '64300000-0000-4000-8000-0000000000b1';
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000a',
	'A fast host that stopped reporting is not waited for');
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = statement_timestamp() - interval '1 minute'
where id = '30000000-0000-4000-8000-000000000092';
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'reason' = 'NO_FAST_HOST'
	and pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'With no live fast host the fresh-VM path takes the run at once');
reset role;
rollback;
