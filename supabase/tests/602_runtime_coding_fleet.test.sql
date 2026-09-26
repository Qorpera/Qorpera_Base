-- @fixture 396_runtime_coding_executor.test.sql until "-- 1. Deployment policies"
-- Two real registered node targets; no per-environment replacement, no second
-- NAS writer, and capacity reserved before a plan can become physical.
create function pg_temp.fleet_node(p_node uuid, p_owner text, p_host text, p_provider text) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020',p_owner,true,array['codex']);
	perform public.qorpera_configure_coding_vm_policy('30000000-0000-4000-8000-000000000020',p_owner,
		jsonb_build_object('providerId',p_provider,'providerPolicySha256',repeat('f',64),'project','coding','imageFingerprint',repeat('a',64),
		'bootstrapSha256',repeat('b',64),'storagePool','coding','network','coding','cpus',2,'memoryBytes',2147483648,'rootDiskBytes',4294967296));
	perform public.qorpera_configure_coding_nas_policy('30000000-0000-4000-8000-000000000020',p_owner,p_host,
		jsonb_build_object('schema','qorpera.coding-nas-policy/v1','mountPoint','/srv/coding','rootPath','/srv/coding/executor',
		'source','192.168.1.40:/coding','serverAddress','192.168.1.40'));
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId',p_node,'machineIdSha256',p_host,'label',p_provider,'cpuMillis',6000,'memoryBytes',8589934592,
		'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_provider(p_node,p_host,'coding',p_provider,repeat('f',64),2000,2147483648);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_host,'socketPath','/var/snap/lxd/common/lxd/unix.socket',
		'socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd','serverVersion','5.21','architecture','x86_64'),
		'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_host,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context(p_node) ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end $$;

create function pg_temp.fleet_session(p_suffix text, p_member uuid) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	insert into public.qorpera_runtime_workers select * from jsonb_populate_record(null::public.qorpera_runtime_workers,
		(select to_jsonb(w) || jsonb_build_object('id',v_id,'worker_key','fleet-'||p_suffix,'owner_user_id',p_member,
			'state','active','result',null,'reported_at',null,'completion_state','none','completion_occurrence_id',null,
			'occurrence_id',null,'sequence',1) from public.qorpera_runtime_workers w where w.worker_key='fix-send'));
	insert into public.qorpera_coding_sessions select * from jsonb_populate_record(null::public.qorpera_coding_sessions,
		(select to_jsonb(s) || jsonb_build_object('worker_id',v_id,'branch','qorpera/coding/'||v_id,'phase','queued','vm_allocation_id',null,'storage_volume_id',null,
			'lease_owner',null,'lease_token',null,'lease_until',null,'claim_after',null) from public.qorpera_coding_sessions s
			join public.qorpera_runtime_workers w on w.id=s.worker_id where w.worker_key='fix-send'));
	return v_id;
end $$;

select pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,
	'An executor without VM, NAS, provider and fresh inventory leaves work queued');
select pg_temp.fleet_node('30000000-0000-4000-8000-000000000310','exec-test',repeat('c',64),'coding-a');
select pg_temp.fleet_node('30000000-0000-4000-8000-000000000311','exec-other',repeat('d',64),'coding-b');
select pg_temp.wake_assert((select count(*) from public.qorpera_coding_executors where environment_id='30000000-0000-4000-8000-000000000020')=2,
	'Adding the second executor retains the first executor and policies');

-- BEGIN FLEET PLACEMENT ASSERTIONS
do $$
declare v_claim jsonb; v_plan jsonb; v_again jsonb; v_worker uuid := (pg_temp.worker_row('fix-send')).id;
	v_second uuid; v_second_claim jsonb; v_second_plan jsonb; v_third uuid; v_third_claim jsonb; v_third_plan jsonb;
	v_storage jsonb; v_policy jsonb; v_root text;
begin
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-other',60) is null,'Equal capacity chooses node A deterministically');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_plan := public.qorpera_plan_coding_machine(v_worker,(v_claim->>'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(v_plan->>'state'='planned' and v_plan->>'bindingText' is not null
		and (select reserved_at is not null from public.qorpera_runtime_node_demands where allocation_id=(v_plan->>'machineId')::uuid)
		and not exists(select 1 from public.qorpera_coding_storage_volumes where worker_id=v_worker),
		'The first plan reserves capacity atomically before any storage is pinned');
	v_again := public.qorpera_plan_coding_machine(v_worker,(v_claim->>'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(v_again=v_plan and (public.qorpera_runtime_node_capacity('30000000-0000-4000-8000-000000000310')->>'allocatedCpuMillis')::bigint=2000,
		'Repeated planning does not reserve twice');
	perform pg_temp.wake_assert(v_plan->>'bindingText' = '{"schema":"qorpera.lxd-coding-machine/v1","machineId":"'||(v_plan->>'machineId')||'","companyId":"30000000-0000-4000-8000-000000000010","environmentId":"30000000-0000-4000-8000-000000000020","memberUserId":"30000000-0000-4000-8000-000000000001","providerId":"coding-a","providerPolicySha256":"'||repeat('f',64)||'","project":"coding","imageFingerprint":"'||repeat('a',64)||'","bootstrapSha256":"'||repeat('b',64)||'","storagePool":"coding","network":"coding","cpus":2,"memoryBytes":2147483648,"rootDiskBytes":4294967296}',
		'The reserved digest uses exactly the TypeScript machine-plan serialization');
	select nas_policy into v_policy from public.qorpera_coding_executors where owner='exec-test';
	v_root := '/srv/coding/executor/workers/30000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000020/'||v_worker;
	v_storage := jsonb_build_object('schema','qorpera.coding-storage/v1','volumeId',v_worker,'workerId',v_worker,
		'companyId','30000000-0000-4000-8000-000000000010','environmentId','30000000-0000-4000-8000-000000000020',
		'writerGeneration',1,'machineIdSha256',repeat('c',64),'policy',v_policy,'dataSource',v_root||'/data','custodySource',v_root||'/guest-state',
		'dataTarget','/workspace','custodyTarget','/var/lib/qorpera-coding');
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_machine_run(v_worker,(v_claim->>'leaseToken')::uuid,v_plan->>'bindingText',v_storage,repeat('c',64))->>'intent'='run',
		'The normal run authority accepts the reserved exact binding and pins storage');
	v_second := pg_temp.fleet_session('second','30000000-0000-4000-8000-000000000002');
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'A new member chooses the node with more free capacity');
	v_second_claim := public.qorpera_claim_coding_session('exec-other',60);
	perform pg_temp.wake_assert(v_second_claim->>'workerId'=v_second::text,'Node B claims the second member');
	v_second_plan := public.qorpera_plan_coding_machine(v_second,(v_second_claim->>'leaseToken')::uuid,repeat('d',64));
	perform pg_temp.wake_assert(v_second_plan#>>'{binding,providerId}'='coding-b','Node B reserves its own provider');
	-- Another session of member 1 stays on A even though B may have more room.
	v_third := pg_temp.fleet_session('same-member','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-other',60) is null,'A foreign executor never claims a retained member machine');
	v_third_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_third_plan := public.qorpera_plan_coding_machine(v_third,(v_third_claim->>'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(v_third_plan->>'machineId'=v_plan->>'machineId','Concurrent member sessions share one machine and one reservation');
	begin perform public.qorpera_plan_coding_machine(v_third,(v_third_claim->>'leaseToken')::uuid,repeat('d',64));
		raise exception 'Foreign host accepted'; exception when insufficient_privilege then null; end;
	-- Admission races after a claim: if the node fills, no machine, allocation,
	-- node demand or storage survives the refused plan.
	perform public.qorpera_complete_coding_turn(v_second,(v_second_claim->>'leaseToken')::uuid,'failed','Fixture completed');
	v_third := pg_temp.fleet_session('capacity-race','30000000-0000-4000-8000-000000000003');
	v_third_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_third_claim->>'workerId'=v_third::text,'The third member obtains its queue lease');
	update public.qorpera_runtime_nodes set headroom_cpu_millis=4000 where id='30000000-0000-4000-8000-000000000310';
	v_third_plan := public.qorpera_plan_coding_machine(v_third,(v_third_claim->>'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(v_third_plan->>'reason'='NODE_CAPACITY_EXHAUSTED'
		and not exists(select 1 from public.qorpera_coding_machines where member_user_id='30000000-0000-4000-8000-000000000003')
		and (select vm_allocation_id is null from public.qorpera_coding_sessions where worker_id=v_third),
		'A losing capacity race rolls back the entire new placement');
	perform public.qorpera_defer_coding_session(v_third,(v_third_claim->>'leaseToken')::uuid,'NODE_CAPACITY_EXHAUSTED');
	update public.qorpera_coding_sessions set claim_after=clock_timestamp()-interval '1 second' where worker_id=v_third;
	v_third_claim := public.qorpera_claim_coding_session('exec-other',60);
	v_third_plan := public.qorpera_plan_coding_machine(v_third,(v_third_claim->>'leaseToken')::uuid,repeat('d',64));
	perform pg_temp.wake_assert(v_third_plan#>>'{binding,providerId}'='coding-b','A refused fresh member can be placed on the other node');
	-- The owning executor dies: another enabled peer settles failure but never
	-- acquires its machine or NAS writer merely because a lease expired.
	update public.qorpera_coding_sessions set lease_until=clock_timestamp()-interval '1 second' where worker_id=v_third;
	perform public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-other',false,array['codex']);
	v_again := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_again is null
		and (select phase='failed' and lease_owner is null from public.qorpera_coding_sessions where worker_id=v_third)
		and (select owner='exec-other' from public.qorpera_coding_machines where id=(v_third_plan->>'machineId')::uuid),
		'A peer settles an expired turn after the old executor is disabled without taking its machine');
	perform public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-other',true,array['codex']);
	perform public.qorpera_complete_coding_turn(v_worker,(v_claim->>'leaseToken')::uuid,'failed','Fixture completed');
	perform set_config('qorpera_test.fleet_machine_a',v_plan->>'machineId',true);
	perform set_config('qorpera_test.fleet_binding_a',v_plan->>'bindingText',true);
end $$;

-- Stale inventory is excluded even when hardware observation remains fresh.
do $$
declare v_worker uuid; v_result text;
begin
	-- Reuse a new auth fixture member with no coding machine yet.
	insert into auth.users(id,email) values ('60200000-0000-4000-8000-000000000004','fleet-four@example.test');
	v_worker := pg_temp.fleet_session('stale','60200000-0000-4000-8000-000000000004');
	update public.qorpera_runtime_nodes set headroom_cpu_millis=2000,version=version+1 where id='30000000-0000-4000-8000-000000000310';
	v_result := public.qorpera_coding_executor_pick(v_worker);
	perform pg_temp.wake_assert(v_result is null,'A fresh hardware observation with the old node version cannot attract a new member');
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null and public.qorpera_claim_coding_session('exec-other',60) is null,
		'No usable capacity leaves the session queued');
end $$;

-- An operator's deletion proof closes the old machine. Retained member NAS
-- volumes still fence its replacement to the original writer host, even when
-- that host is disabled and the other executor is healthy.
do $$
declare v_worker uuid; v_claim jsonb; v_machine uuid := current_setting('qorpera_test.fleet_machine_a')::uuid;
	v_session public.qorpera_coding_sessions%rowtype;
begin
	for v_session in select * from public.qorpera_coding_sessions where lease_owner='exec-test' and lease_token is not null loop
		perform public.qorpera_complete_coding_turn(v_session.worker_id,v_session.lease_token,'failed','Fixture completed');
	end loop;
	perform public.qorpera_release_runtime_machine(v_machine,'coding-a',
		(select instance_sha256 from public.qorpera_coding_machines where id=v_machine));
	perform public.qorpera_release_coding_machine(v_machine,'exec-test',current_setting('qorpera_test.fleet_binding_a'),repeat('c',64));
	v_worker := pg_temp.fleet_session('retained-storage','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-test',false,array['codex']);
	perform pg_temp.wake_assert(public.qorpera_coding_executor_pick(v_worker)='exec-test',
		'Retained storage selects its original writer after machine deletion');
	v_claim := public.qorpera_claim_coding_session('exec-other',60);
	perform pg_temp.wake_assert(v_claim is null
		and (select phase='queued' and lease_owner is null from public.qorpera_coding_sessions where worker_id=v_worker)
		and (select count(distinct owner)=1 and min(owner)='exec-test' from public.qorpera_coding_storage_volumes
			where member_user_id='30000000-0000-4000-8000-000000000001'),
		'A disabled original writer queues work; a healthy peer cannot take NAS custody');
end $$;

select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_route_coding_command(jsonb,jsonb,text,uuid,text)','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_coding_executor_pick(uuid)','EXECUTE'),'Routing helpers cannot bypass turn authority');
rollback;
