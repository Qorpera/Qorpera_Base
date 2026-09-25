begin;
create function pg_temp.shadow_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
insert into auth.users(id,email) values('63400000-0000-4000-8000-000000000001','shadow@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values('63400000-0000-4000-8000-000000000010','Shadow','63400000-0000-4000-8000-000000000001');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
    values('63400000-0000-4000-8000-000000000020','63400000-0000-4000-8000-000000000010','Shadow',1,'63400000-0000-4000-8000-000000000001');
insert into public.qorpera_coding_machines(id,kind,profile_id,environment_id,member_user_id,owner,machine_id_sha256,binding,instance_sha256)
    values('63400000-0000-4000-8000-000000000030','member','63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000020',
        '63400000-0000-4000-8000-000000000001','test',repeat('a',64),'{}',repeat('b',64));
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_machine_id,provider_adapter,instance_sha256)
    values('63400000-0000-4000-8000-000000000030','63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000030','coding',repeat('b',64));
insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
    values('63400000-0000-4000-8000-000000000040',repeat('a',64),'shadow',1,16000,68719476736,1000,1073741824,4000,8589934592,true);
insert into public.qorpera_runtime_node_providers(provider_kind,provider_id,node_id,policy_sha256,cpu_millis,memory_bytes)
    values('coding','coding','63400000-0000-4000-8000-000000000040',repeat('c',64),4000,8589934592);
insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,reserved_at)
    values('63400000-0000-4000-8000-000000000030','63400000-0000-4000-8000-000000000040','coding','coding',repeat('c',64),4000,8589934592,now());
insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
    values('63400000-0000-4000-8000-000000000030','63400000-0000-4000-8000-000000000040','63400000-0000-4000-8000-000000000050','{}');
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare
    a uuid:='63400000-0000-4000-8000-000000000030'; n uuid:='63400000-0000-4000-8000-000000000040';
    t timestamptz:=clock_timestamp()-interval '10 minutes'; p jsonb; old jsonb; receipt jsonb; v_epoch uuid;
begin
    p:=jsonb_build_object('schema','qorpera.computer-usage-sample/v1','nodeId',n,'machineIdSha256',repeat('a',64),
        'allocationId',a,'instanceSha256',repeat('b',64),'observationId',extensions.gen_random_uuid(),
        'observerId',extensions.gen_random_uuid(),'previousObservationId',null,'hostBootId',extensions.gen_random_uuid(),
        'physicalId','63400000-0000-4000-8000-000000000050','guestBootId',extensions.gen_random_uuid(),
        'uptimeMs',100000,'observedAt',t,'state','running','reason','running');
    perform public.qorpera_observe_computer_usage(p);
    select head.epoch into v_epoch from public.qorpera_computer_observer_heads head where allocation_id=a;
    perform pg_temp.shadow_assert((select active_ms=0 and elapsed_ms=0 from public.qorpera_computer_usage_streams where allocation_id=a and epoch=v_epoch),'First sample must not backfill boot uptime');
    p:=p||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'uptimeMs',105000,'observedAt',t+interval '5 seconds');
    receipt:=public.qorpera_observe_computer_usage(p); old:=p;
    perform pg_temp.shadow_assert(receipt=public.qorpera_observe_computer_usage(p),'Exact replay changes no totals');
    perform pg_temp.shadow_assert((select active_ms=5000 from public.qorpera_computer_usage_streams where allocation_id=a and epoch=v_epoch),'Consecutive observed interval accrues once');
    begin perform public.qorpera_observe_computer_usage(p||'{"uptimeMs":106000}'); raise exception 'Conflicting replay accepted'; exception when unique_violation then null; end;
    p:=p||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'uptimeMs',165000,'observedAt',t+interval '65 seconds');
    perform public.qorpera_observe_computer_usage(p);
    perform pg_temp.shadow_assert((select active_ms=5000 from public.qorpera_computer_usage_streams where allocation_id=a and epoch=v_epoch),'Missing observation span adds zero active time');
    perform pg_temp.shadow_assert((select gap_reason='sampling_gap' from public.qorpera_computer_observer_samples where observation_id=(p->>'observationId')::uuid),'Gap reason is explicit');
    p:=p||jsonb_build_object('previousObservationId',null,'observerId',extensions.gen_random_uuid(),'observationId',extensions.gen_random_uuid(),'uptimeMs',170000,'observedAt',t+interval '70 seconds');
    perform public.qorpera_observe_computer_usage(p);
    perform pg_temp.shadow_assert((select active_ms=5000 from public.qorpera_computer_usage_streams where allocation_id=a and epoch=v_epoch),'Observer restart cannot earn downtime');
    old:=p;
    p:=p||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'state','gap','reason','not_running','uptimeMs',null,'guestBootId',null,'observedAt',t+interval '75 seconds');
    perform public.qorpera_observe_computer_usage(p);
    p:=old||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'uptimeMs',180000,'observedAt',t+interval '80 seconds');
    perform public.qorpera_observe_computer_usage(p);
    perform pg_temp.shadow_assert((select active_ms=5000 from public.qorpera_computer_usage_streams where allocation_id=a and epoch=v_epoch),'Frozen same-boot gap is not awake time');
    p:=p||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'guestBootId',extensions.gen_random_uuid(),'uptimeMs',5000,'observedAt',t+interval '85 seconds');
    perform public.qorpera_observe_computer_usage(p);
    perform pg_temp.shadow_assert((select count(*)=2 and sum(active_ms)=5000 from public.qorpera_computer_usage_streams where allocation_id=a),'New guest boot closes prior epoch and begins at zero');
    old:=p; receipt:=public.qorpera_observe_computer_usage(p);
    update public.qorpera_runtime_machine_allocations set released_at=clock_timestamp(),instance_sha256=repeat('f',64) where id=a;
    perform pg_temp.shadow_assert(public.qorpera_observe_computer_usage(p)=receipt,'Historical exact retry survives physical release');
    update public.qorpera_runtime_machine_allocations set instance_sha256=repeat('b',64) where id=a;
    p:=p||jsonb_build_object('previousObservationId',p->'observationId','observationId',extensions.gen_random_uuid(),'state','gap','reason','missing','uptimeMs',null,'guestBootId',null,'physicalId',null,'observedAt',t+interval '90 seconds');
    perform pg_temp.shadow_assert(public.qorpera_observe_computer_usage(p)->>'reason'='allocation_released','Released allocation drains pending outbox safely');
    perform pg_temp.shadow_assert((select bool_and(closed) from public.qorpera_computer_usage_streams where allocation_id=a),'Release closes only confirmed cumulative values');
    perform pg_temp.shadow_assert(jsonb_array_length(public.qorpera_read_node_computer_usage(n,repeat('a',64))->'allocations')=0,'Closed heads leave recovery inventory');
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"63400000-0000-4000-8000-000000000001"}';
do $$ begin
    begin perform public.qorpera_observe_computer_usage('{}'); raise exception 'Member forged telemetry'; exception when insufficient_privilege then null; end;
    if has_function_privilege('authenticated','public.qorpera_observe_computer_usage(jsonb)','EXECUTE') then raise exception 'Member can publish telemetry'; end if;
end $$;
rollback;
