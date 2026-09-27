-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"
-- Reuse its exclusive-database guard and exact committed-fixture cleanup.
-- Physical inventory is synthetic; both concurrent RPCs and FK locks are real.
set request.jwt.claims='{"role":"service_role"}';
select public.qorpera_heartbeat_coding_session((pg_temp.worker_row('fix-send')).id,
    (current_setting('qorpera_test.coding_claim')::jsonb->>'leaseToken')::uuid,300);
delete from public.qorpera_runtime_node_instance_bindings where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
-- The context helper itself takes node SHARE. Materialize it in this separate
-- committed statement, never hold that third-session lock across the race.
create temporary table inventory_lock_context as select public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') context;
do $$
declare context jsonb; allocation jsonb; observation jsonb; inventory jsonb; result jsonb; first_result jsonb;
    machine uuid:=current_setting('qorpera_test.coding_vm')::uuid;
    v_node_id uuid:='30000000-0000-4000-8000-000000000310';
    physical uuid:='67600000-0000-4000-8000-000000000001';
    first_pid integer:=current_setting('qorpera_test.lock_first_pid')::integer;
    second_pid integer:=current_setting('qorpera_test.lock_second_pid')::integer;
    blocked boolean:=false;
begin
    select saved.context into strict context from pg_temp.inventory_lock_context saved;
    select value into strict allocation from jsonb_array_elements(context->'allocations') where value->>'allocationId'=machine::text;
    observation:=jsonb_build_object('schema','qorpera.runtime-node-observation/v1','nodeId',v_node_id,
        'machineIdSha256',repeat('c',64),'observationId','67600000-0000-4000-8000-000000000002',
        'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'cpuMillis',6000,'memoryBytes',8589934592,'state','ready');
    inventory:=jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId','67600000-0000-4000-8000-000000000003',
        'entries',jsonb_build_array(jsonb_build_object('project','coding','name','coding-lock-fixture','physicalId',physical,
            'type','virtual-machine','state','running','configurationSha256',repeat('e',64),
            'cpuMillis',allocation->'cpuMillis','memoryBytes',allocation->'memoryBytes','allocation',allocation,'category','managed','reason',null)));
    -- Pause admission at its existing allocation lock, before it takes node.
    perform dblink_exec('lock_first','begin');
    perform * from dblink('lock_first',pg_temp.lock_row('qorpera_runtime_machine_allocations','id',machine)) as held(n integer);
    perform pg_temp.lock_as('lock_second','{"role":"service_role"}');
    perform dblink_send_query('lock_second',format('select public.qorpera_observe_runtime_node_inventory(%L,%L,%L)',observation,context->>'contextSha256',inventory));
    for attempt in 1..200 loop
        blocked:=first_pid=any(pg_blocking_pids(second_pid));
        exit when blocked or dblink_is_busy('lock_second')=0;
        perform pg_sleep(0.025);
    end loop;
    perform pg_temp.wake_assert(blocked,'Inventory did not wait at its real allocation FK authority');
    perform pg_temp.lock_as('lock_first','{"role":"service_role"}');
    perform dblink_send_query('lock_first',format('select public.qorpera_authorize_coding_machine_run(%L,%L,%L,%L,%L)',
        (pg_temp.worker_row('fix-send')).id,current_setting('qorpera_test.coding_claim')::jsonb->>'leaseToken',
        current_setting('qorpera_test.coding_binding'),current_setting('qorpera_test.coding_storage'),repeat('c',64)));
    first_result:=pg_temp.lock_collect('lock_first');
    perform dblink_exec('lock_first','rollback');
    result:=pg_temp.lock_collect('lock_second');
    perform pg_temp.lock_race_ok(jsonb_build_object('first',first_result,'second',result),'inventory first binding against coding admission');
    perform pg_temp.wake_assert((first_result#>>'{result,intent}'='run'
        and result#>>'{result,nodeId}'=v_node_id::text
        and result#>>'{result,observationId}'=observation->>'observationId'
        and exists(select 1 from public.qorpera_runtime_node_observations observed where observed.node_id=v_node_id and observed.observation->>'state'='ready')
        and exists(select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id=machine and physical_id=physical)) is true,
        'Both calls must complete and retain the measured binding');
    -- Historical exact replay stays valid, mismatched replay still refuses.
    perform pg_temp.wake_assert(public.qorpera_observe_runtime_node_inventory(observation,context->>'contextSha256',inventory)=result->'result','Exact inventory replay changed');
    perform pg_temp.wake_error(format('select public.qorpera_observe_runtime_node_inventory(%L,%L,%L)',
        observation,context->>'contextSha256',jsonb_set(inventory,'{entries,0,name}','"other"')),'42501');
    -- Missing allocation refuses before the node lock rather than acquiring an
    -- unplanned FK lock if that row appears concurrently after the snapshot.
    observation:=observation||jsonb_build_object('observationId',extensions.gen_random_uuid());
    inventory:=jsonb_set(inventory,'{entries,0,allocation,allocationId}','"67600000-0000-4000-8000-000000000099"');
    perform pg_temp.wake_error(format('select public.qorpera_observe_runtime_node_inventory(%L,%L,%L)',observation,context->>'contextSha256',inventory),'PGRST');
end $$;
select pg_temp.lock_order_cleanup();
