-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- 20260928244200 on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): an agent never waits for a seat.
-- 405's office fixture registers computer 1 with two screens on 924's folder-v2 company and gives Alice's live run
-- (…030) a screen lease on it. Dan, Erin, Finn, Gus, Ivy and Jay are hired through their agent.md in the owner's folder
-- commit. Alice's computer_start runs through the real native start (authorize, receipt, begin). Other agents' waits
-- are start waiters on a computer's start intent: synthetic rows (replica mode) stand in for the runs that asked for
-- computer_start, and for the nodes a computer would run on. A woken waiter keeping its seat (an office-activation wake)
-- is left out: folder-v2 refuses those wakes (§3).

create function pg_temp.nw_member(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.nw_open(p_scope jsonb,p_staff uuid) returns jsonb language sql as $$
	select pg_temp.nw_member(format('select public.qorpera_open_runtime_office_screen(%L::jsonb,%L::uuid)',p_scope,p_staff))
$$;
create function pg_temp.nw_agent_office(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.nw_member(format('select public.qorpera_member_agent_office(%L::uuid,%L::uuid)',
		'92400000-0000-4000-8000-000000000020',p_staff))
$$;
create function pg_temp.nw_place(p_staff uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_office_placement('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020',p_staff)
$$;
create function pg_temp.nw_office(p_number integer) returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices
	where environment_id='92400000-0000-4000-8000-000000000020' and computer_number=p_number
$$;
create function pg_temp.nw_scope(p_number integer) returns jsonb language sql as $$
	select public.qorpera_runtime_office_scope(pg_temp.nw_office(p_number))
$$;
create function pg_temp.nw_at(p_decision text,p_number integer) returns jsonb language sql as $$
	select jsonb_build_object('decision',p_decision,'officeId',(pg_temp.nw_office(p_number)).id)
$$;
create function pg_temp.nw_taken(p_number integer,p_staff uuid) returns integer language sql as $$
	select public.qorpera_runtime_office_seats_taken((pg_temp.nw_office(p_number)).id,p_staff)
$$;
-- Changes a synthetic row. A row inserted in replica mode is checked against its
-- foreign keys again on any later update in the same transaction, so updates stay
-- in replica mode too.
create function pg_temp.nw_synthetic(p_sql text) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role','replica',true);
	execute p_sql;
	perform set_config('session_replication_role','origin',true);
end $$;
create function pg_temp.nw_stop_waiting(p_staff uuid) returns void language sql as $$
	select pg_temp.nw_synthetic(format('update public.qorpera_runtime_office_start_waiters w set state=''cancelled''
		from public.qorpera_execution_runs r where r.id=w.parent_run_id and r.staff_agent_id=%L and w.state=''waiting''',p_staff))
$$;
-- An agent waiting for computer p_number, as a native start records it: a start
-- waiter on the computer's current start intent, from a run that did not fail (a
-- copy of Alice's run for that agent). On folder-v2 a waiter is never delivered (no
-- office-activation wake), so every wait here is 'waiting'.
create function pg_temp.nw_hold(p_number integer,p_staff uuid)
returns uuid language plpgsql as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent uuid; v_base public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype; v_run uuid:=extensions.gen_random_uuid(); v_job_id uuid:=extensions.gen_random_uuid();
	v_waiter uuid:=extensions.gen_random_uuid();
begin
	v_office:=pg_temp.nw_office(p_number);
	select id into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation;
	if v_intent is null then
		insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id)
		values(extensions.gen_random_uuid(),v_office.id,v_office.generation,'requested','92400000-0000-4000-8000-000000000001')
		returning id into v_intent;
	end if;
	select * into strict v_base from public.qorpera_execution_runs
		where id=(current_setting('qorpera_test.base_binding')::jsonb->>'runId')::uuid;
	select * into strict v_job from public.qorpera_runner_jobs where id=v_base.job_id;
	perform set_config('session_replication_role','replica',true);
	insert into public.qorpera_runner_jobs
	select (jsonb_populate_record(null::public.qorpera_runner_jobs,to_jsonb(v_job)
		||jsonb_build_object('id',v_job_id,'client_job_id',v_job_id,'client_lease_id',v_job_id,'run_id',v_run))).*;
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(null::public.qorpera_execution_runs,to_jsonb(v_base)
		||jsonb_build_object('id',v_run,'job_id',v_job_id,'source_id',v_run,'staff_agent_id',p_staff))).*;
	insert into public.qorpera_runtime_office_start_waiters(id,intent_id,parent_run_id,receipt_id,staff_version,grant_id,grant_version,
		state,occurrence_id)
	values(v_waiter,v_intent,v_run,extensions.gen_random_uuid(),1,extensions.gen_random_uuid(),1,'waiting',null);
	perform set_config('session_replication_role','origin',true);
	return v_waiter;
end $$;
-- A node with its inventory receipt, observed ready now, with an office
-- provider of 4 CPUs and 8 GiB enrolled on it: 15 CPUs and 60 GiB to give.
create function pg_temp.nw_node(p_id uuid,p_label text) returns void language plpgsql as $$
declare v_observation uuid:=extensions.gen_random_uuid();
begin
	perform set_config('session_replication_role','replica',true);
	insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,headroom_cpu_millis,
		headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
	values(p_id,encode(sha256(convert_to(p_label,'UTF8')),'hex'),p_label,1,16000,68719476736,1000,4294967296,4000,8589934592,true);
	insert into public.qorpera_runtime_node_observations(node_id,observation_id,observed_at,observation)
	values(p_id,v_observation,clock_timestamp(),'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
	insert into public.qorpera_runtime_node_inventory_policies(node_id,policy,policy_sha256) values(p_id,'{}',repeat('a',64));
	insert into public.qorpera_runtime_node_inventory_receipts(node_id,observation_id,node_version,policy_sha256,context_sha256,inventory)
	values(p_id,v_observation,1,repeat('a',64),repeat('b',64),'{}');
	insert into public.qorpera_runtime_node_providers(provider_kind,provider_id,node_id,policy_sha256,cpu_millis,memory_bytes)
	values('office',extensions.gen_random_uuid()::text,p_id,repeat('c',64),4000,8589934592);
	perform set_config('session_replication_role','origin',true);
end $$;
-- Alice's computer_start as the runtime sends it: the envelope names the target
-- p_scope; 'begin' first opens the operation's receipt.
create function pg_temp.nw_start(p_action text,p_scope jsonb,p_key text) returns jsonb language plpgsql as $$
declare v_binding jsonb:=current_setting('qorpera_test.base_binding')::jsonb; v_descriptor jsonb; v_envelope text;
	v_receipt uuid:=extensions.gen_random_uuid(); v_result jsonb;
begin
	v_descriptor:=jsonb_build_object('scope',p_scope,'computerGeneration',
		(select generation from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid),
		'resources',(select jsonb_build_object('officeGrantId',grant_id,'officeGrantVersion',version) from public.qorpera_runtime_office_access
			where office_id=(p_scope->>'companyComputerId')::uuid and staff_agent_id='92400000-0000-4000-8000-000000000030'));
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_envelope:=jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(v_binding)->'identity')
			-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','computer_start','toolVersion','qorpera.company-computer-tools/v2',
			'logicalOperationKey',p_key,'requiresCompanyRevision',false,'arguments',jsonb_build_object('kind','start'),
			'target',jsonb_build_object('realm','company_computer')||v_descriptor))::text;
	if p_action='begin' then
		perform public.qorpera_begin_native_tool_operation(v_binding,v_receipt,'computer_start:'||p_key,
			encode(extensions.digest(v_envelope,'sha256'),'hex'),repeat('e',64),false);
		v_result:=public.qorpera_native_office_start(v_binding,v_envelope,'begin',v_receipt,repeat('e',64));
	else
		v_result:=public.qorpera_native_office_start(v_binding,v_envelope,'authorize');
	end if;
	reset role;
	return v_result;
end $$;

-- An agent's agent.md saved with a status, over the version read (924's agent text and parse).
create function pg_temp.nw_status(p_handle text,p_id uuid,p_name text,p_status text) returns jsonb language sql as $$
	select pg_temp.base_write('QorperaOS/agents/'||p_handle||'/agent.md','agent',
		replace(pg_temp.base_agent_text(p_id,p_name),E'status: active\n','status: '||p_status||E'\n'),
		jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Research','agentKind','agent','status',p_status,
			'colour',null,'figure',null,'model',null,'effort',null,'instructions','Read and change the company folder.'),
		pg_temp.base_version('QorperaOS/agents/'||p_handle||'/agent.md'))
$$;

-- Six more agents, hired through their agent.md in the owner's commit.
select pg_temp.base_commit(pg_temp.base_owner(),'nw-hire-six',jsonb_build_array(
	pg_temp.base_hire('dan','62800000-0000-4000-8000-000000000a33','Dan'),
	pg_temp.base_hire('erin','62800000-0000-4000-8000-000000000a34','Erin'),
	pg_temp.base_hire('finn','62800000-0000-4000-8000-000000000a35','Finn'),
	pg_temp.base_hire('gus','62800000-0000-4000-8000-000000000a36','Gus'),
	pg_temp.base_hire('ivy','62800000-0000-4000-8000-000000000a37','Ivy'),
	pg_temp.base_hire('jay','62800000-0000-4000-8000-000000000a38','Jay')));
select pg_temp.base_assert((select count(*)=6 from public.qorpera_profile_staff where profile_id='92400000-0000-4000-8000-000000000010'
	and staff_agent_id::text like '62800000-0000-4000-8000-000000000a3_' and employment_status='active'),'the six agents are hired');
update public.qorpera_runtime_office_scale_out set enabled=true;

-- 1. A start never moves under its agent. Alice releases her screen; Bob and Carol
-- fill computer 1. Alice's run asks for its start descriptor: computer 2 is added
-- for her. Before her computer_start arrives, Dan and Erin's starts take both of
-- computer 2's seats.
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_assert(public.qorpera_native_office_screen(current_setting('qorpera_test.base_binding')::jsonb,
	current_setting('qorpera_test.office_scope')::jsonb,'release',current_setting('qorpera_test.office_lease')::jsonb)->>'state'='released',
	'Alice releases her screen');
reset role;
update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()-interval '3 minutes'
where staff_agent_id='92400000-0000-4000-8000-000000000030';
select pg_temp.base_assert(pg_temp.nw_open(pg_temp.nw_scope(1),'92400000-0000-4000-8000-000000000031')->>'state'='open'
	and pg_temp.nw_open(pg_temp.nw_scope(1),'92400000-0000-4000-8000-000000000032')->>'state'='open'
	and (pg_temp.nw_office(1)).max_screens=2,'Bob and Carol fill computer 1''s two screens');
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.discovered',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.base_binding')::jsonb)::text,true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.discovered')::jsonb->'scope'=pg_temp.nw_scope(2)
	and (pg_temp.nw_office(2)).state='provisioning','Alice''s run is offered computer_start for computer 2, added for her');
select pg_temp.nw_hold(2,'62800000-0000-4000-8000-000000000a33');
select pg_temp.nw_hold(2,'62800000-0000-4000-8000-000000000a34');
select pg_temp.base_assert(pg_temp.nw_place('92400000-0000-4000-8000-000000000030')='{"decision":"new"}'::jsonb,
	'placed now, Alice would need another computer: computer 2''s seats are held');
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','nw-ack');
reset role;
select pg_temp.base_assert(pg_temp.nw_start('authorize',pg_temp.nw_scope(2),'start-628')='{"state":"authorized"}'::jsonb,
	'her computer_start for computer 2 is still authorized');
select set_config('qorpera_test.started',pg_temp.nw_start('begin',pg_temp.nw_scope(2),'start-628')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.started')::jsonb->>'companyComputerId'=(pg_temp.nw_office(2)).id::text
	and exists(select 1 from public.qorpera_runtime_office_start_waiters w join public.qorpera_execution_runs r on r.id=w.parent_run_id
		where r.staff_agent_id='92400000-0000-4000-8000-000000000030' and w.state='waiting'),
	'and begins: Alice now waits for computer 2');
select pg_temp.base_assert(pg_temp.nw_start('authorize',pg_temp.nw_scope(2),'start-628')='{"state":"authorized"}'::jsonb,
	'the check after completion sees computer 2 as well');
select pg_temp.base_assert(pg_temp.nw_taken(2,'62800000-0000-4000-8000-000000000a33')=0
	and pg_temp.nw_taken(2,'62800000-0000-4000-8000-000000000a34')=1
	and pg_temp.nw_taken(2,'92400000-0000-4000-8000-000000000030')=2
	and pg_temp.nw_place('92400000-0000-4000-8000-000000000030')='{"decision":"new"}'::jsonb,
	'seats go first come: Dan and Erin asked first, so Alice, third on two seats, is placed again');
select pg_temp.nw_stop_waiting('62800000-0000-4000-8000-000000000a34');
select pg_temp.base_assert(pg_temp.nw_place('92400000-0000-4000-8000-000000000030')=pg_temp.nw_at('starting',2)
	and pg_temp.nw_place('62800000-0000-4000-8000-000000000a33')=pg_temp.nw_at('starting',2),
	'once Erin stops waiting, Alice and Dan are placed on the computer they wait for');

-- 2. A burst adds as many computers as it needs.
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a34')='{"decision":"new"}'::jsonb,
	'Erin does not wait for computer 2, whose seats Dan and Alice hold: she needs another computer');
select pg_temp.base_assert(pg_temp.nw_agent_office('62800000-0000-4000-8000-000000000a34')->>'placement'='unstarted'
	and (pg_temp.nw_office(3)).state='provisioning','computer 3 is added for Erin while computer 2 is still starting');
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a35')=pg_temp.nw_at('unstarted',3),
	'Finn joins computer 3, which nobody holds yet');
select pg_temp.nw_hold(3,'62800000-0000-4000-8000-000000000a34');
select pg_temp.nw_hold(3,'62800000-0000-4000-8000-000000000a34');
select pg_temp.base_assert(public.qorpera_runtime_office_seat_claims((pg_temp.nw_office(3)).id,'62800000-0000-4000-8000-000000000a35',false)=1,
	'an agent waiting twice for one computer holds one seat');
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a35')=pg_temp.nw_at('starting',3),
	'Finn joins computer 3''s free seat');

-- 3. Computer 2 comes up (synthetic readiness): its waiters stop waiting and open its seats. A woken agent (its wait
-- delivered by an office-activation wake) keeping its seat until its woken run ends is left out: folder-v2 refuses
-- office-activation wakes (inserting one answers 0A000 "This wake source does not serve folder-v2 yet"), so no folder-v2
-- start waiter is ever delivered. A waiting agent holds a seat; an archived one does not.
select pg_temp.nw_stop_waiting('62800000-0000-4000-8000-000000000a33');
select pg_temp.nw_stop_waiting('92400000-0000-4000-8000-000000000030');
update public.qorpera_runtime_offices set state='active' where id=(pg_temp.nw_office(2)).id;
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a36')=pg_temp.nw_at('room',2)
	and pg_temp.nw_open(pg_temp.nw_scope(2),'62800000-0000-4000-8000-000000000a36')->>'state'='open',
	'Gus opens a seat on computer 2, which nobody holds now');
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a33')=pg_temp.nw_at('room',2)
	and pg_temp.nw_open(pg_temp.nw_scope(2),'62800000-0000-4000-8000-000000000a33')->>'state'='open',
	'Dan opens computer 2''s other seat');
select pg_temp.base_assert(pg_temp.nw_open(pg_temp.nw_scope(2),'62800000-0000-4000-8000-000000000a38')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'Jay gets no screen on computer 2: Gus and Dan use both');
select pg_temp.nw_hold(3,'62800000-0000-4000-8000-000000000a37');
select pg_temp.base_assert(public.qorpera_runtime_office_seat_claims((pg_temp.nw_office(3)).id,'62800000-0000-4000-8000-000000000a36',false)=2,
	'Ivy''s wait for computer 3 holds a seat there, beside Erin''s');
select pg_temp.base_commit(pg_temp.base_owner(),'nw-archive-ivy',jsonb_build_array(
	pg_temp.nw_status('ivy','62800000-0000-4000-8000-000000000a37','Ivy','archived')));
select pg_temp.base_assert((select employment_status='archived' from public.qorpera_profile_staff
	where staff_agent_id='62800000-0000-4000-8000-000000000a37')
	and public.qorpera_runtime_office_seat_claims((pg_temp.nw_office(3)).id,'62800000-0000-4000-8000-000000000a36',false)=1,
	'an archived agent''s wait holds no seat');
select pg_temp.base_commit(pg_temp.base_owner(),'nw-reactivate-ivy',jsonb_build_array(
	pg_temp.nw_status('ivy','62800000-0000-4000-8000-000000000a37','Ivy','active')));
select pg_temp.nw_stop_waiting('62800000-0000-4000-8000-000000000a37');

-- 4. Switched off, held seats are not counted: seats are taken first come, as before.
update public.qorpera_runtime_office_scale_out set enabled=false;
select pg_temp.base_assert(pg_temp.nw_taken(3,'62800000-0000-4000-8000-000000000a36')=0,
	'switched off, Erin''s wait for computer 3 holds no seat');
update public.qorpera_runtime_office_scale_out set enabled=true;
select pg_temp.base_assert(pg_temp.nw_taken(3,'62800000-0000-4000-8000-000000000a36')=1,'switched on again, it does');

-- 5. A start no host offers for 30 minutes holds no seats.
select pg_temp.nw_synthetic(format('update public.qorpera_runtime_office_start_intents set created_at=clock_timestamp()-interval ''31 minutes''
	where office_id=%L',(pg_temp.nw_office(3)).id));
select pg_temp.base_assert(public.qorpera_runtime_office_start_stuck(pg_temp.nw_office(3))
	and pg_temp.nw_taken(3,'62800000-0000-4000-8000-000000000a36')=0,'computer 3 is stuck: Erin''s wait holds no seat there');
select pg_temp.nw_synthetic(format('update public.qorpera_runtime_office_start_intents set created_at=clock_timestamp()
	where office_id=%L',(pg_temp.nw_office(3)).id));

-- 6. A sleeping computer is woken only when its node would admit it now. Computer 4
-- sleeps after its idle time on node A, where 13 of 15 CPUs are reserved.
select public.qorpera_add_runtime_office_computer('92400000-0000-4000-8000-000000000020','member',
	'92400000-0000-4000-8000-000000000030',null,'92400000-0000-4000-8000-000000000001');
select pg_temp.nw_node('62800000-0000-4000-8000-00000000000a','node-a');
set local session_replication_role = replica;
update public.qorpera_runtime_offices set state='maintenance' where id=(pg_temp.nw_office(4)).id;
insert into public.qorpera_runtime_office_idle_cycles(transition_id,office_id,computer_generation,request)
values(extensions.gen_random_uuid(),(pg_temp.nw_office(4)).id,(pg_temp.nw_office(4)).generation,'{}');
insert into public.qorpera_runtime_machine_allocations(id,profile_id,office_id,computer_generation,provider_adapter,instance_sha256)
values('62800000-0000-4000-8000-000000000002','92400000-0000-4000-8000-000000000010',(pg_temp.nw_office(4)).id,
	(pg_temp.nw_office(4)).generation,'lxd-office',repeat('7',64));
insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,
	reserved_at,suspended_at)
values('62800000-0000-4000-8000-000000000002','62800000-0000-4000-8000-00000000000a','office','office-628',repeat('8',64),
	4000,8589934592,clock_timestamp(),clock_timestamp()),
	('62800000-0000-4000-8000-000000000003','62800000-0000-4000-8000-00000000000a','run','run-628',repeat('9',64),
	13000,8589934592,clock_timestamp(),null);
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_runtime_office_idle_pending(pg_temp.nw_office(4))
	and not public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4)),'computer 4 sleeps, and node A has no room to wake it');
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')=pg_temp.nw_at('starting',3),
	'Ivy is placed on computer 3''s free seat, not on sleeping computer 4');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set cpu_millis=11000 where allocation_id=''62800000-0000-4000-8000-000000000003''');
select pg_temp.base_assert(public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4))
	and pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')=pg_temp.nw_at('stopped',4),
	'with room on node A, sleeping computer 4 is woken for Ivy, before a starting computer');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set suspended_at=null where allocation_id=''62800000-0000-4000-8000-000000000002''');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set cpu_millis=14000 where allocation_id=''62800000-0000-4000-8000-000000000003''');
select pg_temp.base_assert(public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4)),
	'a sleeping computer that still holds its node slot can always wake');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set suspended_at=clock_timestamp() where allocation_id=''62800000-0000-4000-8000-000000000002''');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set cpu_millis=11000 where allocation_id=''62800000-0000-4000-8000-000000000003''');
select pg_temp.nw_synthetic('update public.qorpera_runtime_nodes set enabled=false where id=''62800000-0000-4000-8000-00000000000a''');
select pg_temp.base_assert(not public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4)),'a node that is emptying wakes no sleeping computer');
select pg_temp.nw_synthetic('update public.qorpera_runtime_nodes set enabled=true where id=''62800000-0000-4000-8000-00000000000a''');
select pg_temp.nw_synthetic('delete from public.qorpera_runtime_node_inventory_receipts where node_id=''62800000-0000-4000-8000-00000000000a''');
select pg_temp.base_assert(not public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4)),'nor does a node whose inventory is not confirmed');
select pg_temp.nw_synthetic('insert into public.qorpera_runtime_node_inventory_receipts(node_id,observation_id,node_version,policy_sha256,
	context_sha256,inventory) select node_id,observation_id,1,repeat(''a'',64),repeat(''b'',64),''{}'' from public.qorpera_runtime_node_observations
	where node_id=''62800000-0000-4000-8000-00000000000a''');
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set cpu_millis=13000 where allocation_id=''62800000-0000-4000-8000-000000000003''');
select pg_temp.base_assert(not public.qorpera_runtime_office_can_wake(pg_temp.nw_office(4)),'node A is confirmed again, and full');

-- 7. Computer 3's last seat is held by Jay; computer 4 cannot wake; computer 5 is
-- updating. With no node able to take a new computer, sleeping computer 4 is still
-- woken (its wake waits for room, as before). Once node B has room, it is passed
-- over, and so is computer 5: a new computer is added.
select pg_temp.nw_hold(3,'62800000-0000-4000-8000-000000000a38');
select public.qorpera_add_runtime_office_computer('92400000-0000-4000-8000-000000000020','member',
	'92400000-0000-4000-8000-000000000030',null,'92400000-0000-4000-8000-000000000001');
update public.qorpera_runtime_offices set state='maintenance' where id=(pg_temp.nw_office(5)).id;
select pg_temp.base_assert(not public.qorpera_runtime_office_new_machine_room()
	and pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')=pg_temp.nw_at('stopped',4),
	'no node has room for a new computer: sleeping computer 4 is woken for Ivy');
select pg_temp.nw_node('62800000-0000-4000-8000-00000000000b','node-b');
select pg_temp.base_assert(public.qorpera_runtime_office_new_machine_room()
	and pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')='{"decision":"new"}'::jsonb,
	'node B has room: Ivy needs a new computer, not the sleeping or the updating one');
update public.qorpera_runtime_offices set state='provisioning' where id=(pg_temp.nw_office(5)).id;
insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id,cancelled_at)
values(extensions.gen_random_uuid(),(pg_temp.nw_office(5)).id,(pg_temp.nw_office(5)).generation,'cancelled',
	'92400000-0000-4000-8000-000000000001',clock_timestamp());
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')='{"decision":"new"}'::jsonb,
	'a computer whose start an owner cancelled is passed over too');
-- Waking computer 4 is requested but node A is full: joined only while no node has room.
select pg_temp.nw_synthetic(format('update public.qorpera_runtime_office_idle_cycles set wake_requested_at=clock_timestamp()
	where office_id=%L',(pg_temp.nw_office(4)).id));
select pg_temp.nw_synthetic('update public.qorpera_runtime_node_demands set cpu_millis=13000 where allocation_id=''62800000-0000-4000-8000-000000000003''');
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a37')='{"decision":"new"}'::jsonb,
	'a waking computer its node cannot take is not joined while node B has room');
select pg_temp.base_assert(pg_temp.nw_agent_office('62800000-0000-4000-8000-000000000a37')->>'placement'='unstarted'
	and (pg_temp.nw_office(6)).computer_number=6,'computer 6 is added for Ivy');

-- 8. A waiting agent is placed on the computer it waits for, which stays awake for
-- it, until a running computer has a free seat: then that one comes first.
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a38')=pg_temp.nw_at('starting',3)
	and public.qorpera_runtime_office_has_demand(pg_temp.nw_office(3)),'Jay, waiting for computer 3, is placed there and keeps it awake');
update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()-interval '3 minutes'
where staff_agent_id='62800000-0000-4000-8000-000000000a36' and office_id=(pg_temp.nw_office(2)).id;
select pg_temp.base_assert(pg_temp.nw_place('62800000-0000-4000-8000-000000000a38')=pg_temp.nw_at('room',2),
	'Gus left computer 2: Jay takes its free seat instead of waiting for computer 3');

-- 9. Held seats never add rows: a computer never holds more screen rows than screens.
select pg_temp.base_assert(not exists(select 1 from public.qorpera_runtime_office_screens s
	join public.qorpera_runtime_offices o on o.id=s.office_id
	where o.environment_id='92400000-0000-4000-8000-000000000020' group by o.id,o.max_screens having count(*)>o.max_screens),
	'no computer has more screen rows than screens');

rollback;
