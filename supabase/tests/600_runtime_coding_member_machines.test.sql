-- @fixture 396_runtime_coding_executor.test.sql until "-- 4. Control plane only."
-- Coding machines per member: one machine carries all of a member's sessions,
-- sleeps without holding node capacity, wakes for the next turn, lets a turn
-- wait in the queue instead of failing on a full node, and is removed with a
-- deletion proof; a kept per-session VM from before is retired the same way.
-- Nothing here deletes a session's NAS folders.

create function pg_temp.vm() returns uuid language sql as $$ select current_setting('qorpera_test.coding_vm')::uuid $$;
create function pg_temp.machine(p_id uuid) returns public.qorpera_coding_machines language sql as $$
	select machine from public.qorpera_coding_machines machine where machine.id = p_id
$$;
create function pg_temp.demand(p_id uuid) returns public.qorpera_runtime_node_demands language sql as $$
	select demand from public.qorpera_runtime_node_demands demand where demand.allocation_id = p_id
$$;
create function pg_temp.listed(p_id uuid) returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_coding_machines('exec-test',repeat('c',64))) entry where entry ->> 'machineId' = p_id::text
$$;
create function pg_temp.custody(p_id uuid,p_binding text,p_intent text,p_worker uuid default null,p_lease uuid default null) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_custody(p_id,'exec-test',p_binding,repeat('c',64),p_intent,p_worker,p_lease)
$$;
create function pg_temp.node_cpu() returns bigint language sql as $$
	select (public.qorpera_runtime_node_capacity('30000000-0000-4000-8000-000000000310') ->> 'allocatedCpuMillis')::bigint
$$;
create function pg_temp.storage(p_worker uuid) returns jsonb language sql as $$
	select current_setting('qorpera_test.coding_storage')::jsonb || jsonb_build_object('volumeId',p_worker,'workerId',p_worker,
		'dataSource','/srv/coding/executor/workers/30000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000020/' || p_worker::text || '/data',
		'custodySource','/srv/coding/executor/workers/30000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000020/' || p_worker::text || '/guest-state')
$$;
create function pg_temp.run(p_worker uuid,p_lease uuid,p_binding text) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_run(p_worker,p_lease,p_binding,pg_temp.storage(p_worker),repeat('c',64))
$$;
create function pg_temp.plan(p_worker uuid,p_lease uuid) returns jsonb language sql as $$
	select public.qorpera_plan_coding_machine(p_worker,p_lease,repeat('c',64))
$$;
-- The node's inventory observation is only valid for a minute: observe again before long sections.
create function pg_temp.observe() returns void language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
	select null::void
$$;
select pg_temp.path_claims('service_role');

-- 1. The turn has ended: the machine is idle, and sleeps once the environment's delay has passed.
--    Asleep, its node demand keeps its row but no longer counts.
do $$
declare v_sleep jsonb; v_again jsonb;
begin
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'live' = 'false' and pg_temp.listed(pg_temp.vm()) ->> 'reserved' = 'true'
		and pg_temp.listed(pg_temp.vm()) ->> 'sleepDue' = 'false' and pg_temp.listed(pg_temp.vm()) ->> 'removeDue' = 'false'
		and pg_temp.listed(pg_temp.vm()) ->> 'kind' = 'member' and pg_temp.node_cpu() = 2000,
		'An idle machine keeps its place until the sleep delay passes: '||(pg_temp.listed(pg_temp.vm()))::text);
	update public.qorpera_coding_machines set last_used_at = clock_timestamp() - interval '11 minutes' where id = pg_temp.vm();
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'sleepDue' = 'true','Ten idle minutes make the machine due to sleep');
	perform public.qorpera_configure_coding_machine_lifecycle('30000000-0000-4000-8000-000000000020','exec-test',1800,86400);
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'sleepDue' = 'false','The sleep delay is the environment''s configuration');
	perform public.qorpera_configure_coding_machine_lifecycle('30000000-0000-4000-8000-000000000020','exec-test',600,86400);
	begin perform public.qorpera_configure_coding_machine_lifecycle('30000000-0000-4000-8000-000000000020','exec-test',10,86400);
		raise exception 'A ten second sleep delay was accepted'; exception when check_violation then null; end;
	perform pg_temp.wake_assert(public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))
		->> 'reason' = 'MACHINE_USED_SINCE_STOP','No suspension without a stop custody first');
	perform pg_temp.wake_assert(pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'stop') ->> 'intent' = 'stop'
		and pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'delete') ->> 'reason' = 'MACHINE_AWAKE',
		'An idle machine may be stopped; an awake one is never deleted');
	v_sleep := public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
	v_again := public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
	perform pg_temp.wake_assert(v_sleep ->> 'state' = 'suspended' and v_again = v_sleep and (pg_temp.demand(pg_temp.vm())).suspended_at is not null
		and (pg_temp.demand(pg_temp.vm())).released_at is null and pg_temp.node_cpu() = 0
		and pg_temp.listed(pg_temp.vm()) ->> 'reserved' = 'false' and pg_temp.listed(pg_temp.vm()) ->> 'asleepSince' is not null
		and pg_temp.listed(pg_temp.vm()) ->> 'sleepDue' = 'false' and pg_temp.listed(pg_temp.vm()) ->> 'removeDue' = 'false',
		'Asleep, the machine holds no node capacity and keeps its placement');
	begin perform public.qorpera_suspend_coding_machine(pg_temp.vm(),'someone-else',current_setting('qorpera_test.coding_binding'),repeat('c',64));
		raise exception 'A foreign executor put the machine to sleep'; exception when insufficient_privilege then null; end;
	perform pg_temp.wake_assert(pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'delete') ->> 'reason' = 'MACHINE_NOT_DUE'
		and (pg_temp.machine(pg_temp.vm())).removing_at is null,
		'A current machine that just fell asleep is not removed before the removal delay');
end $$;

-- 2. The owner's answer wakes it: the next turn is planned on the same machine and re-reserves the node.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_claim jsonb; v_run jsonb;
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Raise it to 500 ms.','30000000-0000-4000-8000-000000000202');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.observe();
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text and (v_claim ->> 'sequence')::int = 3,'The answer is the next turn');
	perform set_config('qorpera_test.claim_1',v_claim::text,true);
	perform pg_temp.wake_assert(pg_temp.plan(v_worker.id,(v_claim ->> 'leaseToken')::uuid) ->> 'machineId' = pg_temp.vm()::text,
		'The next turn is planned on the member''s sleeping machine');
	v_run := pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding'));
	perform pg_temp.wake_assert(v_run ->> 'intent' = 'run' and (v_run ->> 'guestUid')::int = 200000 and (pg_temp.demand(pg_temp.vm())).suspended_at is null
		and pg_temp.node_cpu() = 2000 and pg_temp.listed(pg_temp.vm()) ->> 'live' = 'true'
		and (pg_temp.machine(pg_temp.vm())).last_used_at > clock_timestamp() - interval '1 minute',
		'Waking re-reserves the node demand; the session keeps its guest uid');
end $$;

-- 3. A second session of the same member runs beside it on the same machine as its own guest user.
do $$
declare v_first jsonb := current_setting('qorpera_test.claim_1')::jsonb; v_claim jsonb; v_worker public.qorpera_runtime_workers; v_run jsonb;
begin
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c4","todoKey":"composer-latency","workerKey":"fix-send-3",
		"title":"Group chat composer","goal":"Post first there too.","definitionOfDone":"Its send test passes.","access":"read",
		"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
	v_worker := pg_temp.worker_row('fix-send-3');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text,'The second session is claimed while the first runs');
	perform set_config('qorpera_test.claim_3',v_claim::text,true);
	perform pg_temp.wake_assert(pg_temp.plan(v_worker.id,(v_claim ->> 'leaseToken')::uuid) ->> 'machineId' = pg_temp.vm()::text
		and (select count(*) from public.qorpera_coding_machines where kind = 'member' and removed_at is null) = 1,
		'Both sessions of the member share one machine');
	v_run := pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding'));
	perform pg_temp.wake_assert(v_run ->> 'intent' = 'run' and (v_run ->> 'guestUid')::int = 200001 and pg_temp.node_cpu() = 2000
		and (pg_temp.session_row('fix-send-3')).vm_allocation_id = pg_temp.vm(),
		'The second session runs as the member''s next guest user without new capacity');
	perform pg_temp.wake_assert(pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'stop') ->> 'reason' = 'MACHINE_IN_USE'
		and public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64)) ->> 'reason' = 'MACHINE_IN_USE'
		and pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'detach',(pg_temp.worker_row('fix-send')).id) ->> 'reason' = 'SESSION_IN_USE'
		and pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'detach',v_worker.id,(v_claim ->> 'leaseToken')::uuid) ->> 'intent' = 'detach',
		'A machine with leased turns stays awake; each turn detaches only itself');
	begin perform pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'detach',
			(pg_temp.worker_row('fix-send-2')).id);
		raise exception 'A session never on the machine was detached'; exception when insufficient_privilege then null; end;
	-- Volumes from before per-member machines share one uid: never two of them on a machine at once.
	update public.qorpera_coding_storage_volumes set guest_uid = null where worker_id in ((pg_temp.worker_row('fix-send')).id, v_worker.id);
	perform pg_temp.wake_assert(pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding')) ->> 'reason'
		= 'LEGACY_SESSION_BUSY','Two sessions with the shared coding uid are never on one machine');
	update public.qorpera_coding_storage_volumes set guest_uid = 200000 where worker_id = (pg_temp.worker_row('fix-send')).id;
	update public.qorpera_coding_storage_volumes set guest_uid = 200001 where worker_id = v_worker.id;
	begin update public.qorpera_coding_storage_volumes set guest_uid = 200000 where worker_id = v_worker.id;
		raise exception 'Two sessions of a member got one guest uid'; exception when unique_violation then null; end;
end $$;

-- 4. A full node: the turn goes back to the queue with one visible step, is claimed again after its wait,
--    and admitted once there is room.
do $$
declare v_first jsonb := current_setting('qorpera_test.claim_1')::jsonb; v_claim jsonb := current_setting('qorpera_test.claim_3')::jsonb;
	v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send-3'); v_view jsonb; v_events bigint; v_phases bigint;
begin
	perform public.qorpera_complete_coding_turn((pg_temp.worker_row('fix-send')).id,(v_first ->> 'leaseToken')::uuid,'failed','Stopped for the test.');
	v_view := public.qorpera_defer_coding_session(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'NODE_CAPACITY_EXHAUSTED');
	v_events := pg_temp.events('fix-send-3','step');
	v_phases := pg_temp.events('fix-send-3','phase');
	perform pg_temp.wake_assert(v_view ->> 'phase' = 'queued' and v_view ->> 'lastStep' = 'Waiting for a coding machine'
		and (pg_temp.session_row('fix-send-3')).lease_token is null and (pg_temp.session_row('fix-send-3')).claim_after > clock_timestamp()
		and (pg_temp.worker_row('fix-send-3')).state = 'active',
		'A turn that cannot have its machine waits in the queue; it has not failed');
	begin perform public.qorpera_defer_coding_session(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'NODE_CAPACITY_EXHAUSTED');
		raise exception 'A lost lease deferred the turn'; exception when insufficient_privilege then null; end;
	-- Everyone idle: the machine sleeps; then the node has no room for it. A use after the stop
	-- custody (here a detach) needs a new stop before the machine may count as asleep.
	perform pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'stop');
	perform pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'detach',v_worker.id);
	perform pg_temp.wake_assert(public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))
		->> 'reason' = 'MACHINE_USED_SINCE_STOP' and (pg_temp.demand(pg_temp.vm())).suspended_at is null,
		'A machine used after its stop was authorized does not count as asleep');
	perform pg_temp.custody(pg_temp.vm(),current_setting('qorpera_test.coding_binding'),'stop');
	perform public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
	update public.qorpera_runtime_nodes set headroom_cpu_millis = 5000, standard_cpu_millis = 1000 where id = '30000000-0000-4000-8000-000000000310';
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'The waiting turn is not claimed before its wait ends');
	update public.qorpera_coding_sessions set claim_after = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform pg_temp.observe();
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text and pg_temp.events('fix-send-3','phase') = v_phases,
		'After its wait the turn is claimed again, without a second "preparing"');
	perform pg_temp.wake_assert(pg_temp.plan(v_worker.id,(v_claim ->> 'leaseToken')::uuid) ->> 'machineId' = pg_temp.vm()::text
		and pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding')) ->> 'reason' = 'NODE_CAPACITY_EXHAUSTED'
		and (pg_temp.demand(pg_temp.vm())).suspended_at is not null,
		'A full node refuses to wake the machine and leaves it asleep');
	perform public.qorpera_defer_coding_session(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'NODE_CAPACITY_EXHAUSTED');
	perform pg_temp.wake_assert(pg_temp.events('fix-send-3','step') = v_events,'Waiting again adds no second step to the thread');
	update public.qorpera_runtime_nodes set headroom_cpu_millis = 2000, standard_cpu_millis = 2000 where id = '30000000-0000-4000-8000-000000000310';
	update public.qorpera_coding_sessions set claim_after = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding')) ->> 'intent' = 'run'
		and (pg_temp.demand(pg_temp.vm())).suspended_at is null,'With room again the machine wakes for the waiting turn');
	perform public.qorpera_begin_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId',pg_temp.vm(),'turnId',public.qorpera_coding_turn_id(v_worker.id,1)));
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send-3')).claim_after is null and (pg_temp.session_row('fix-send-3')).phase = 'running',
		'The turn begins and forgets its wait');
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'failed','Stopped for the test.');
end $$;

-- 5. The deployment policy moves on (a new image): the machine takes no new turn, is stopped, put to
--    sleep and deleted; the deletion proof releases its capacity; the next turn gets a new machine.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_claim jsonb; v_old uuid := pg_temp.vm();
	v_binding text := current_setting('qorpera_test.coding_binding'); v_release jsonb; v_plan jsonb; v_next jsonb; v_run jsonb; v_steps bigint;
begin
	perform public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020','exec-test',
		(v_binding::jsonb - array['schema','machineId','companyId','environmentId','memberUserId']) || jsonb_build_object('imageFingerprint',repeat('e',64)));
	perform pg_temp.wake_assert(pg_temp.listed(v_old) ->> 'superseded' = 'true' and pg_temp.listed(v_old) ->> 'removeDue' = 'true'
		and pg_temp.listed(v_old) ->> 'sleepDue' = 'false','A machine whose policy moved on is due for removal once idle');
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Try again on the new image.','30000000-0000-4000-8000-000000000203');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.observe();
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_plan := pg_temp.plan(v_worker.id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_plan ->> 'reason' = 'MACHINE_RETIRING' and (pg_temp.machine(v_old)).retire_requested_at is not null
		and pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_binding) ->> 'reason' = 'MACHINE_RETIRING',
		'A new turn is not started on the superseded machine');
	-- The turn before may have ended while waiting: this turn's wait still gets its own step.
	update public.qorpera_coding_sessions set last_step = 'Waiting for a coding machine' where worker_id = v_worker.id;
	v_steps := pg_temp.events('fix-send','step');
	perform public.qorpera_defer_coding_session(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'MACHINE_RETIRING');
	perform pg_temp.wake_assert(pg_temp.events('fix-send','step') = v_steps + 1,'Every turn that waits shows its wait once');
	begin perform public.qorpera_release_coding_machine(v_old,'exec-test',v_binding,repeat('c',64));
		raise exception 'Capacity released without a deletion'; exception when insufficient_privilege then null; end;
	perform pg_temp.custody(v_old,v_binding,'stop');
	perform public.qorpera_suspend_coding_machine(v_old,'exec-test',v_binding,repeat('c',64));
	perform pg_temp.wake_assert(pg_temp.custody(v_old,v_binding,'delete') ->> 'intent' = 'delete' and (pg_temp.machine(v_old)).removing_at is not null
		and pg_temp.listed(v_old) ->> 'removing' = 'true','Delete custody is granted for the idle, asleep machine and cannot be taken back');
	-- Had no turn planned (so nothing marked it retiring), the policy going back does not stop the removal.
	update public.qorpera_coding_machines set retire_requested_at = null where id = v_old;
	perform public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020','exec-test',
		v_binding::jsonb - array['schema','machineId','companyId','environmentId','memberUserId']);
	perform pg_temp.wake_assert(pg_temp.custody(v_old,v_binding,'delete') ->> 'intent' = 'delete'
		and pg_temp.listed(v_old) ->> 'removeDue' = 'true','A removal once begun continues after the policy goes back');
	perform public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020','exec-test',
		(v_binding::jsonb - array['schema','machineId','companyId','environmentId','memberUserId']) || jsonb_build_object('imageFingerprint',repeat('e',64)));
	update public.qorpera_coding_machines set retire_requested_at = clock_timestamp() where id = v_old;
	v_release := public.qorpera_release_coding_machine(v_old,'exec-test',v_binding,repeat('c',64));
	perform pg_temp.wake_assert(v_release ->> 'state' = 'released' and v_release ->> 'machineId' = v_old::text
		and (select released_at from public.qorpera_runtime_machine_allocations where id = v_old) is not null
		and (pg_temp.demand(v_old)).released_at is not null and (pg_temp.machine(v_old)).removed_at is not null
		and (pg_temp.session_row('fix-send')).vm_allocation_id = v_old and not public.qorpera_coding_machine_live(pg_temp.machine(v_old))
		and pg_temp.listed(v_old) is null and pg_temp.node_cpu() = 0,
		'The deletion proof releases the allocation and the node demand; the sessions only remember where they last ran');
	perform pg_temp.wake_assert(public.qorpera_release_coding_machine(v_old,'exec-test',v_binding,repeat('c',64)) = v_release,
		'A repeated release answers the same');
	begin perform pg_temp.custody(v_old,v_binding,'stop');
		raise exception 'A removed machine was stopped'; exception when insufficient_privilege then null; end;
	-- The waiting turn now atomically reserves a new machine with the new policy.
	update public.qorpera_coding_sessions set claim_after = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_next := pg_temp.plan(v_worker.id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_next ->> 'state' = 'planned' and v_next ->> 'machineId' <> v_old::text
		and v_next #>> '{binding,imageFingerprint}' = repeat('e',64)
		and (pg_temp.machine((v_next ->> 'machineId')::uuid)).instance_sha256 is not null
		and (pg_temp.demand((v_next ->> 'machineId')::uuid)).reserved_at is not null and pg_temp.node_cpu() = 2000,
		'After removal the new plan and its physical capacity reservation are atomic');
	begin perform public.qorpera_release_coding_machine((v_next ->> 'machineId')::uuid,'exec-test',v_next ->> 'bindingText',repeat('c',64));
		raise exception 'An admitted plan was released without physical custody'; exception when insufficient_privilege then null; end;
	v_run := pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,v_next ->> 'bindingText');
	perform pg_temp.wake_assert(v_run ->> 'intent' = 'run' and (v_run ->> 'guestUid')::int = 200000 and pg_temp.node_cpu() = 2000,
		'The session runs on its new machine as the same guest user');
	perform set_config('qorpera_test.coding_vm',v_next ->> 'machineId',true);
	perform set_config('qorpera_test.coding_binding',v_next ->> 'bindingText',true);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'failed','Stopped for the test.');
end $$;

-- 6. A kept per-session VM from before (the migration made it a machine of kind 'session') is retired
--    through the same custody as soon as its session has no leased turn. Its session moves to the
--    member's machine only after that: its folders may still be attached to the old VM.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send-2'); v_legacy uuid := '30000000-0000-4000-8000-000000000320';
	v_binding text; v_digest text; v_reserved jsonb; v_claim jsonb; v_run jsonb;
begin
	v_binding := jsonb_build_object('schema','qorpera.lxd-coding-vm/v2','workerId',v_worker.id,'allocationId',v_legacy,
		'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'providerId','coding-fixture','providerPolicySha256',repeat('f',64),
		'repository',(pg_temp.session_row('fix-send-2')).repository,'storage',pg_temp.storage(v_worker.id),'project','coding',
		'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','coding','network','coding','cpus',2,
		'memoryBytes',2147483648,'rootDiskBytes',4294967296)::text;
	v_digest := encode(extensions.digest(convert_to(v_binding,'utf8'),'sha256'),'hex');
	perform pg_temp.observe();
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_worker_id, provider_adapter, instance_sha256)
	values (v_legacy, v_worker.profile_id, v_worker.id, 'coding-fixture', v_digest);
	v_reserved := public.qorpera_reserve_runtime_node_machine(v_legacy,'coding','coding-fixture',repeat('f',64),v_digest,repeat('c',64),2000,2147483648);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, worker_id, owner, machine_id_sha256,
		binding, instance_sha256, retire_requested_at)
	values (v_legacy, 'session', v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_worker.id, 'exec-test', repeat('c',64),
		v_binding::jsonb, v_digest, clock_timestamp());
	update public.qorpera_coding_sessions set vm_allocation_id = v_legacy where worker_id = v_worker.id;
	perform pg_temp.wake_assert(v_reserved ->> 'state' = 'reserved' and pg_temp.listed(v_legacy) ->> 'kind' = 'session'
		and pg_temp.listed(v_legacy) ->> 'superseded' = 'true' and pg_temp.listed(v_legacy) ->> 'removeDue' = 'true'
		and pg_temp.listed(v_legacy) ->> 'sleepDue' = 'false' and pg_temp.node_cpu() = 4000,
		'A kept per-session VM is due for removal at once and never sleeps');
	-- Its owner follows up before housekeeping has retired it: the turn waits.
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Pick this up again.','30000000-0000-4000-8000-000000000204');
	perform pg_temp.path_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text
		and pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding')) ->> 'reason' = 'PREVIOUS_MACHINE_AWAKE'
		and pg_temp.custody(v_legacy,v_binding,'stop') ->> 'reason' = 'MACHINE_IN_USE',
		'The session does not move while its old VM is awake, and the old VM keeps its leased turn');
	perform public.qorpera_defer_coding_session(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'PREVIOUS_MACHINE_AWAKE');
	perform pg_temp.custody(v_legacy,v_binding,'stop');
	perform public.qorpera_suspend_coding_machine(v_legacy,'exec-test',v_binding,repeat('c',64));
	perform pg_temp.custody(v_legacy,v_binding,'delete');
	v_reserved := public.qorpera_release_coding_machine(v_legacy,'exec-test',v_binding,repeat('c',64));
	perform pg_temp.wake_assert(v_reserved ->> 'state' = 'released'
		and (select released_at from public.qorpera_runtime_machine_allocations where id = v_legacy) is not null
		and (pg_temp.demand(v_legacy)).released_at is not null and pg_temp.node_cpu() = 2000
		and exists (select 1 from public.qorpera_coding_storage_volumes where worker_id = (pg_temp.worker_row('fix-send')).id),
		'Its capacity comes back through the same deletion proof; the NAS folders stay on record');
	update public.qorpera_coding_sessions set claim_after = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform pg_temp.observe();
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_run := pg_temp.run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,current_setting('qorpera_test.coding_binding'));
	perform pg_temp.wake_assert(v_run ->> 'intent' = 'run' and (v_run ->> 'guestUid')::int = 200002
		and (pg_temp.session_row('fix-send-2')).vm_allocation_id = pg_temp.vm(),
		'Once the old VM is gone the session runs on the member''s machine as a new guest user');
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,'failed','Stopped for the test.');
end $$;

-- 7. A machine released through the general machine release (an operator's deletion proof) is closed
--    by the executor without an LXD effect, and the member's next turn plans a new one.
do $$
declare v_machine public.qorpera_coding_machines := pg_temp.machine(pg_temp.vm()); v_claim jsonb; v_plan jsonb;
begin
	perform public.qorpera_release_runtime_machine(v_machine.id,'coding-fixture',v_machine.instance_sha256);
	perform pg_temp.wake_assert(pg_temp.listed(v_machine.id) ->> 'released' = 'true' and pg_temp.listed(v_machine.id) ->> 'removeDue' = 'true',
		'The executor sees the machine released elsewhere');
	perform pg_temp.wake_assert(public.qorpera_release_coding_machine(v_machine.id,'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))
		->> 'state' = 'released' and (pg_temp.machine(v_machine.id)).removed_at is not null,'It closes without delete custody');
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,'Once more.','30000000-0000-4000-8000-000000000205');
	perform pg_temp.path_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_plan := pg_temp.plan((pg_temp.worker_row('fix-send')).id,(v_claim ->> 'leaseToken')::uuid);
	perform pg_temp.wake_assert(v_plan ->> 'state' = 'planned' and v_plan ->> 'machineId' <> v_machine.id::text,'The next turn plans a new machine');
	perform set_config('qorpera_test.coding_vm',v_plan ->> 'machineId',true);
	perform public.qorpera_complete_coding_turn((pg_temp.worker_row('fix-send')).id,(v_claim ->> 'leaseToken')::uuid,'failed','Stopped for the test.');
end $$;

-- 8. A failed step stays visible on the machine until the same step succeeds.
do $$
begin
	perform public.qorpera_record_coding_machine_error(pg_temp.vm(),'exec-test',repeat('c',64),'sleep','CODING_VM_RECOVERY_REQUIRED');
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'lastError' = 'sleep:CODING_VM_RECOVERY_REQUIRED'
		and pg_temp.listed(pg_temp.vm()) ->> 'lastErrorAt' is not null,'The executor''s failed step is on record');
	perform public.qorpera_record_coding_machine_error(pg_temp.vm(),'exec-test',repeat('c',64),'delete',null);
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'lastError' = 'sleep:CODING_VM_RECOVERY_REQUIRED','Another step''s success does not hide it');
	perform public.qorpera_record_coding_machine_error(pg_temp.vm(),'someone-else',repeat('c',64),'sleep',null);
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) ->> 'lastError' is not null,'A foreign executor cannot clear it');
	perform public.qorpera_record_coding_machine_error(pg_temp.vm(),'exec-test',repeat('c',64),'sleep',null);
	perform pg_temp.wake_assert(pg_temp.listed(pg_temp.vm()) -> 'lastError' = 'null'::jsonb,'The same step succeeding clears it');
	begin perform public.qorpera_record_coding_machine_error(pg_temp.vm(),'exec-test',repeat('c',64),'sleep','lower case');
		raise exception 'A free-text error was recorded'; exception when sqlstate '22023' then null; end;
end $$;

-- 9. Control plane only.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_list_coding_machines('exec-test',repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_release_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64))$q$,'42501');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_plan_coding_machine(uuid,uuid,text)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_defer_coding_session(uuid,uuid,text)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_configure_coding_machine_lifecycle(uuid,text,integer,integer)','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_coding_machine_live(public.qorpera_coding_machines)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_list_coding_machines(text,text)','EXECUTE'),
	'Machine authority is the executor''s alone');

rollback;
