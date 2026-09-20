-- Viewer records above came from real mint/redeem/input/drain functions.
-- The following retained host/allocation placement is deliberately synthetic.
reset role;
select pg_temp.path_claims('service_role');
insert into auth.users(id,email) values('37000000-0000-4000-8000-000000000030','inactive-member@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
 values('30000000-0000-4000-8000-000000000010','37000000-0000-4000-8000-000000000030','inactive-member@example.test','Unobserved member','viewer');
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
 'nodeId','37000000-0000-4000-8000-000000000010','machineIdSha256',repeat('7',64),'label','users-fixture',
 'cpuMillis',8000,'memoryBytes',8589934592,'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,
 'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
select public.qorpera_enroll_runtime_node_provider('37000000-0000-4000-8000-000000000010',repeat('7',64),
 'office','37000000-0000-4000-8000-000000000001',repeat('8',64),2000,2147483648);
insert into public.qorpera_runtime_machine_allocations(id,profile_id,office_id,computer_generation,provider_adapter,instance_sha256,reserved_at)
 select '37000000-0000-4000-8000-000000000020',profile_id,id,generation,'lxd',repeat('9',64),clock_timestamp()-interval '2 hours'
 from public.qorpera_runtime_offices;
insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,requested_at,reserved_at)
 values('37000000-0000-4000-8000-000000000020','37000000-0000-4000-8000-000000000010','office',
 '37000000-0000-4000-8000-000000000001',repeat('8',64),2000,2147483648,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours');

create function pg_temp.users_view(p_from timestamptz,p_until timestamptz) returns jsonb language sql as $$
 select public.qorpera_runtime_compute_users('37000000-0000-4000-8000-000000000010',p_from,p_until)
$$;
do $proof$
declare v jsonb; before_records jsonb; t timestamptz:=statement_timestamp(); edge timestamptz;
begin
 select jsonb_build_object('allocations',(select jsonb_agg(to_jsonb(a)) from public.qorpera_runtime_machine_allocations a),
  'demands',(select jsonb_agg(to_jsonb(d)) from public.qorpera_runtime_node_demands d),
  'viewers',(select jsonb_agg(to_jsonb(viewer_row) order by id) from public.qorpera_runtime_office_viewers viewer_row),
  'inputs',(select jsonb_agg(to_jsonb(i) order by id) from public.qorpera_runtime_office_viewer_inputs i)) into before_records;
 v:=pg_temp.users_view(t-interval '1 hour',t);
 perform pg_temp.wake_assert(v#>>'{activity,observedActiveUsers}'='3','three actual humans, repeated viewers and input deduplicated');
 perform pg_temp.wake_assert(v#>>'{activity,observedComputers}'='1' and v#>>'{activity,observedCompanies}'='1','shared computer counted once');
 perform pg_temp.wake_assert((v#>>'{activity,recordedEvents}')::int>3,'multiple actual events are not users');
 perform pg_temp.wake_assert(v#>>'{currentAllocation,allocatedComputers}'='1' and v#>>'{currentAllocation,companies}'='1','current allocation counts');
 perform pg_temp.wake_assert((v#>>'{currentAllocation,associatedMembers}')::int=(select count(distinct user_id) from public.qorpera_profile_members),'associated membership counted separately');
 perform pg_temp.wake_assert(v#>>'{currentAllocation,associatedMembers}'='4','unobserved company member is associated but not active');
 perform pg_temp.wake_assert(v#>'{activity,completeHumanPresence}'='false'::jsonb and v#>'{activity,continuousWatchPresence}'='null'::jsonb,'no continuous presence inference');
 perform pg_temp.wake_assert(v::text !~ 'capability|commitment|privateSignIn|challengeId|memberId','no sensitive records in aggregate');
 perform pg_temp.wake_assert(pg_temp.users_view(t-interval '2 hours',t-interval '1 hour')#>>'{activity,state}'='unknown','missing activity unknown');
 perform pg_temp.wake_assert(pg_temp.users_view(t-interval '2 hours',t-interval '1 hour')#>'{activity,observedActiveUsers}'='null'::jsonb,'missing activity not zero humans');
 select min(redeemed_at) into edge from public.qorpera_runtime_office_viewers;
 perform pg_temp.wake_assert(pg_temp.users_view(edge-interval '1 second',edge)#>>'{activity,recordedEvents}'='0','upper time boundary excluded');
 perform pg_temp.wake_assert(pg_temp.users_view(edge,edge+interval '1 microsecond')#>>'{activity,recordedEvents}'='1','lower microsecond boundary included');
 perform pg_temp.wake_assert(before_records=jsonb_build_object('allocations',(select jsonb_agg(to_jsonb(a)) from public.qorpera_runtime_machine_allocations a),
  'demands',(select jsonb_agg(to_jsonb(d)) from public.qorpera_runtime_node_demands d),
  'viewers',(select jsonb_agg(to_jsonb(viewer_row) order by id) from public.qorpera_runtime_office_viewers viewer_row),
  'inputs',(select jsonb_agg(to_jsonb(i) order by id) from public.qorpera_runtime_office_viewer_inputs i)),'query leaves authority and records unchanged');
end
$proof$;

savepoint placement;
insert into public.qorpera_runtime_machine_allocations(id,profile_id,office_id,computer_generation,provider_adapter,instance_sha256,reserved_at)
 select '37000000-0000-4000-8000-000000000021',profile_id,office_id,computer_generation+1,provider_adapter,repeat('6',64),reserved_at
 from public.qorpera_runtime_machine_allocations where id='37000000-0000-4000-8000-000000000020';
insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,requested_at,reserved_at)
 select '37000000-0000-4000-8000-000000000021',node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,requested_at,reserved_at
 from public.qorpera_runtime_node_demands where allocation_id='37000000-0000-4000-8000-000000000020';
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{currentAllocation,allocatedComputers}'='2','two retained allocations count as two computers');
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{currentAllocation,companies}'='1','one company on two computers counted once');
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{currentAllocation,associatedMembers}'='4','members not doubled by shared computers');
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,observedComputers}'='1','only observed generation contributes activity');
rollback to placement;
update public.qorpera_runtime_node_demands set reserved_at=clock_timestamp() where allocation_id='37000000-0000-4000-8000-000000000020';
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,state}'='unknown','events before node placement excluded');
rollback to placement;
update public.qorpera_runtime_node_demands set released_at=reserved_at+interval '1 second';
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,state}'='unknown','events after node release excluded');
rollback to placement;
update public.qorpera_runtime_machine_allocations set computer_generation=computer_generation+1;
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,state}'='unknown','another computer generation excluded');
rollback to placement;
update public.qorpera_runtime_node_demands set released_at=clock_timestamp();
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,observedActiveUsers}'='3','historical users survive release');
select pg_temp.wake_assert(pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{currentAllocation,associatedMembers}'='0','released computers no longer contribute current members');
rollback to placement;
-- A window row stands for packet_count packets; a per-packet row for one.
select set_config('qorpera_test.users_inputs_before',pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,admittedControlInputs}',true);
select set_config('qorpera_test.users_events_before',pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,recordedEvents}',true);
insert into public.qorpera_runtime_office_viewer_inputs(viewer_id,sequence,input_commitment,packet_count,admitted_at)
 select (select id from public.qorpera_runtime_office_viewers where mode='control' limit 1),90001,repeat('b',64),500,statement_timestamp()-interval '1 second';
select pg_temp.wake_assert((pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,admittedControlInputs}')::bigint
 =current_setting('qorpera_test.users_inputs_before')::bigint+500,'a window row counts its packets, not one');
select pg_temp.wake_assert((pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())#>>'{activity,recordedEvents}')::bigint
 =current_setting('qorpera_test.users_events_before')::bigint+1,'a window row is still one recorded event');
rollback to placement;
-- Boundary load fixture; it is not evidence of real input execution.
insert into public.qorpera_runtime_office_viewer_inputs(viewer_id,sequence,input_commitment,admitted_at)
 select (select id from public.qorpera_runtime_office_viewers where mode='control' limit 1),n,repeat('a',64),statement_timestamp()-interval '1 second'
 from generate_series(100001,120001) n;
select pg_temp.wake_error($q$select pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())$q$,'54000');
rollback to placement;
select pg_temp.wake_error($q$select pg_temp.users_view(statement_timestamp()-interval '25 hours',statement_timestamp())$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.users_view(statement_timestamp(),statement_timestamp())$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.users_view(statement_timestamp(),statement_timestamp()+interval '1 hour')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.users_view('-infinity',statement_timestamp())$q$,'22023');
select pg_temp.wake_assert(not exists(select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r
 where has_function_privilege(r,'public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz)','execute')),'operator-only aggregate');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.users_view(statement_timestamp()-interval '1 hour',statement_timestamp())$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
