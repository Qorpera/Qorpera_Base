-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "create function pg_temp.browser("
-- 20260929020000: an agent never waits for a seat. The fixture registers computer 1
-- with two screens and gives Alice (…030) a native screen lease on it; a member opens
-- Bob's (…031) screen, so computer 1 is full. Waiting agents are start waiters on a
-- computer's start intent: synthetic rows (replica mode) stand in for the runs that
-- asked for computer_start, and for the node a sleeping computer would wake on.

create function pg_temp.member(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_result;
end $$;
create function pg_temp.open(p_scope jsonb,p_staff uuid) returns jsonb language sql as $$
	select pg_temp.member(format('select public.qorpera_open_runtime_office_screen(%L::jsonb,%L::uuid)',p_scope,p_staff))
$$;
create function pg_temp.agent_office(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.member(format('select public.qorpera_member_agent_office(%L::uuid,%L::uuid)',
		'30000000-0000-4000-8000-000000000020',p_staff))
$$;
create function pg_temp.place(p_staff uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_office_placement('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020',p_staff)
$$;
create function pg_temp.office(p_number integer) returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices
	where environment_id='30000000-0000-4000-8000-000000000020' and computer_number=p_number
$$;
create function pg_temp.scope(p_number integer) returns jsonb language sql as $$
	select public.qorpera_runtime_office_scope(pg_temp.office(p_number))
$$;
create function pg_temp.at(p_decision text,p_number integer) returns jsonb language sql as $$
	select jsonb_build_object('decision',p_decision,'officeId',(pg_temp.office(p_number)).id)
$$;
create function pg_temp.staff(p_id uuid,p_name text) returns void language sql as $$
	insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
		employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
	select profile_id,p_id,p_name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,
		model_provider,model_id,created_at,updated_at,updated_by_user_id from public.qorpera_profile_staff
	where staff_agent_id='30000000-0000-4000-8000-000000000030'
$$;
-- An agent waiting for computer p_number, as a native start records it: a start
-- waiter on the computer's current start intent. 'delivered' waiters were woken
-- p_woken ago.
create function pg_temp.hold(p_number integer,p_staff uuid,p_state text default 'waiting',p_woken interval default null)
returns uuid language plpgsql as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent uuid; v_base public.qorpera_execution_runs%rowtype;
	v_run uuid:=extensions.gen_random_uuid(); v_wake uuid; v_waiter uuid:=extensions.gen_random_uuid();
begin
	v_office:=pg_temp.office(p_number);
	select id into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation;
	if v_intent is null then
		insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id)
		values(extensions.gen_random_uuid(),v_office.id,v_office.generation,'requested','30000000-0000-4000-8000-000000000001')
		returning id into v_intent;
	end if;
	select * into strict v_base from public.qorpera_execution_runs
		where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
	perform set_config('session_replication_role','replica',true);
	insert into public.qorpera_execution_runs
	select (jsonb_populate_record(null::public.qorpera_execution_runs,to_jsonb(v_base)
		||jsonb_build_object('id',v_run,'job_id',extensions.gen_random_uuid(),'source_id',v_run,'staff_agent_id',p_staff))).*;
	if p_state='delivered' then
		insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,staff_agent_id,
			parent_run_id,trigger_id,occurrence_key,scheduled_for,not_before,payload,created_at)
		values(extensions.gen_random_uuid(),v_office.profile_id,v_office.environment_id,'agent','office-activation',v_waiter,p_staff,
			v_run,'office-activation','office-activation:'||v_intent::text||':'||v_run::text,clock_timestamp(),clock_timestamp(),'{}',
			clock_timestamp()-p_woken)
		returning id into v_wake;
	end if;
	insert into public.qorpera_runtime_office_start_waiters(id,intent_id,parent_run_id,receipt_id,staff_version,grant_id,grant_version,
		state,occurrence_id)
	values(v_waiter,v_intent,v_run,extensions.gen_random_uuid(),1,extensions.gen_random_uuid(),1,p_state,v_wake);
	perform set_config('session_replication_role','origin',true);
	return v_waiter;
end $$;

select pg_temp.staff('30000000-0000-4000-8000-000000000033','Dan');
select pg_temp.staff('30000000-0000-4000-8000-000000000034','Erin');
select pg_temp.staff('30000000-0000-4000-8000-000000000035','Finn');
select pg_temp.staff('30000000-0000-4000-8000-000000000036','Gus');
select pg_temp.staff('30000000-0000-4000-8000-000000000037','Ivy');
select pg_temp.staff('30000000-0000-4000-8000-000000000038','Jay');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000031')->>'state'='open'
	and (pg_temp.office(1)).max_screens=2,'computer 1 (two screens) is full: Alice''s lease and Bob''s screen');
update public.qorpera_runtime_office_scale_out set enabled=true;

-- 1. A burst adds as many computers as it needs. Carol gets computer 2 and waits for it.
select pg_temp.wake_assert(pg_temp.agent_office('30000000-0000-4000-8000-000000000032')->>'placement'='unstarted'
	and (pg_temp.office(2)).state='provisioning','computer 2 is added for Carol');
select pg_temp.hold(2,'30000000-0000-4000-8000-000000000032');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000033')=pg_temp.at('starting',2),
	'Dan joins computer 2 while it is starting: one of its two seats is still free');
select pg_temp.hold(2,'30000000-0000-4000-8000-000000000033');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000034')='{"decision":"new"}'::jsonb,
	'Erin does not wait for computer 2, whose seats Carol and Dan hold: she needs another computer');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')=pg_temp.at('starting',2)
	and pg_temp.place('30000000-0000-4000-8000-000000000033')=pg_temp.at('starting',2),
	'Carol and Dan stay placed on the computer they wait for');
select pg_temp.wake_assert(pg_temp.agent_office('30000000-0000-4000-8000-000000000034')->>'placement'='unstarted'
	and (pg_temp.office(3)).state='provisioning','computer 3 is added for Erin while computer 2 is still starting');
select pg_temp.hold(3,'30000000-0000-4000-8000-000000000034');
select pg_temp.wake_assert(public.qorpera_runtime_office_seat_claims((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000035',false)=2
	and public.qorpera_runtime_office_seats_taken((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000035')=2
	and public.qorpera_runtime_office_seats_taken((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000032')=1,
	'held seats count against everyone but the agent holding them');
select pg_temp.hold(2,'30000000-0000-4000-8000-000000000032');
select pg_temp.wake_assert(public.qorpera_runtime_office_seat_claims((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000035',false)=2,
	'an agent waiting twice for one computer holds one seat');

-- 2. The agent's own seat first. Dan stops waiting: computer 2 has a free seat again,
-- yet Erin stays placed on computer 3, where she waits; Finn takes computer 2's seat.
update public.qorpera_runtime_office_start_waiters w set state='cancelled'
from public.qorpera_execution_runs r where r.id=w.parent_run_id and r.staff_agent_id='30000000-0000-4000-8000-000000000033';
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000034')=pg_temp.at('starting',3),
	'Erin is placed on computer 3, where she holds a seat, not on computer 2 with its lower number');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000035')=pg_temp.at('starting',2),
	'Finn joins computer 2''s free seat');

-- 3. A woken agent's seat is held for two minutes. Computer 2 comes up (synthetic
-- readiness) and Carol's wait is delivered.
update public.qorpera_runtime_office_start_waiters w set state='cancelled'
from public.qorpera_execution_runs r where r.id=w.parent_run_id and r.staff_agent_id='30000000-0000-4000-8000-000000000032';
select pg_temp.hold(2,'30000000-0000-4000-8000-000000000032','delivered',interval '30 seconds');
update public.qorpera_runtime_offices set state='active' where id=(pg_temp.office(2)).id;
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000035')=pg_temp.at('room',2)
	and pg_temp.open(pg_temp.scope(2),'30000000-0000-4000-8000-000000000035')->>'state'='open',
	'Finn opens computer 2''s free seat');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(2),'30000000-0000-4000-8000-000000000036')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'Gus gets no screen on computer 2: its other seat is Carol''s, woken 30 seconds ago');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000036')=pg_temp.at('starting',3),
	'Gus is placed on computer 3''s free seat instead');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')=pg_temp.at('room',2)
	and pg_temp.open(pg_temp.scope(2),'30000000-0000-4000-8000-000000000032')->>'state'='open',
	'Carol opens the seat she waited for');
select pg_temp.wake_assert(public.qorpera_runtime_office_seat_claims((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000036',false)=0
	and public.qorpera_runtime_office_seats_taken((pg_temp.office(2)).id,'30000000-0000-4000-8000-000000000036')=2,
	'a seat in use is counted once, not also as held');
select pg_temp.hold(3,'30000000-0000-4000-8000-000000000038','delivered',interval '3 minutes');
select pg_temp.wake_assert(public.qorpera_runtime_office_seat_claims((pg_temp.office(3)).id,'30000000-0000-4000-8000-000000000036',false)=1,
	'a wake older than two minutes holds no seat');

-- 4. Switched off, held seats are not counted: seats are taken first come, as before.
update public.qorpera_runtime_office_scale_out set enabled=false;
select pg_temp.wake_assert(public.qorpera_runtime_office_seats_taken((pg_temp.office(3)).id,'30000000-0000-4000-8000-000000000036')=0,
	'switched off, Erin''s wait for computer 3 holds no seat');
update public.qorpera_runtime_office_scale_out set enabled=true;
select pg_temp.wake_assert(public.qorpera_runtime_office_seats_taken((pg_temp.office(3)).id,'30000000-0000-4000-8000-000000000036')=1,
	'switched on again, it does');

-- 5. A sleeping computer is woken only when its node would admit it now. Computer 4
-- sleeps after its idle time; its node has 15 of 16 CPUs to give and 13 are reserved.
select public.qorpera_add_runtime_office_computer('30000000-0000-4000-8000-000000000020','member',
	'30000000-0000-4000-8000-000000000030',null,'30000000-0000-4000-8000-000000000001');
set local session_replication_role = replica;
update public.qorpera_runtime_offices set state='maintenance' where id=(pg_temp.office(4)).id;
insert into public.qorpera_runtime_office_idle_cycles(transition_id,office_id,computer_generation,request)
values(extensions.gen_random_uuid(),(pg_temp.office(4)).id,(pg_temp.office(4)).generation,'{}');
insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,headroom_cpu_millis,
	headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
values('62800000-0000-4000-8000-000000000001',repeat('6',64),'node-628',1,16000,68719476736,1000,4294967296,4000,8589934592,true);
insert into public.qorpera_runtime_node_observations(node_id,observation_id,observed_at,observation)
values('62800000-0000-4000-8000-000000000001',extensions.gen_random_uuid(),clock_timestamp(),
	'{"state":"ready","cpuMillis":16000,"memoryBytes":68719476736}');
insert into public.qorpera_runtime_machine_allocations(id,profile_id,office_id,computer_generation,provider_adapter,instance_sha256)
values('62800000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000010',(pg_temp.office(4)).id,
	(pg_temp.office(4)).generation,'lxd-office',repeat('7',64));
insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes,
	reserved_at,suspended_at)
values('62800000-0000-4000-8000-000000000002','62800000-0000-4000-8000-000000000001','office','office-628',repeat('8',64),
	4000,8589934592,clock_timestamp(),clock_timestamp()),
	('62800000-0000-4000-8000-000000000003','62800000-0000-4000-8000-000000000001','run','run-628',repeat('9',64),
	13000,8589934592,clock_timestamp(),null);
set local session_replication_role = origin;
select pg_temp.wake_assert(public.qorpera_runtime_office_idle_pending(pg_temp.office(4))
	and not public.qorpera_runtime_office_can_wake(pg_temp.office(4)),'computer 4 sleeps, and its node has no room to wake it');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000037')=pg_temp.at('starting',3),
	'Ivy is not placed on sleeping computer 4 but on computer 3''s free seat');
update public.qorpera_runtime_node_demands set cpu_millis=11000 where allocation_id='62800000-0000-4000-8000-000000000003';
select pg_temp.wake_assert(public.qorpera_runtime_office_can_wake(pg_temp.office(4))
	and pg_temp.place('30000000-0000-4000-8000-000000000037')=pg_temp.at('stopped',4),
	'with room on its node, sleeping computer 4 is woken for Ivy, before a starting computer');
update public.qorpera_runtime_node_demands set suspended_at=null where allocation_id='62800000-0000-4000-8000-000000000002';
update public.qorpera_runtime_node_demands set cpu_millis=14000 where allocation_id='62800000-0000-4000-8000-000000000003';
select pg_temp.wake_assert(public.qorpera_runtime_office_can_wake(pg_temp.office(4)),
	'a sleeping computer that still holds its node slot can always wake');
update public.qorpera_runtime_node_demands set suspended_at=clock_timestamp() where allocation_id='62800000-0000-4000-8000-000000000002';
update public.qorpera_runtime_node_demands set cpu_millis=11000 where allocation_id='62800000-0000-4000-8000-000000000003';
update public.qorpera_runtime_nodes set enabled=false where id='62800000-0000-4000-8000-000000000001';
select pg_temp.wake_assert(not public.qorpera_runtime_office_can_wake(pg_temp.office(4)),
	'a node that is emptying wakes no sleeping computer');
update public.qorpera_runtime_nodes set enabled=true where id='62800000-0000-4000-8000-000000000001';
update public.qorpera_runtime_node_observations set observed_at=clock_timestamp()-interval '5 minutes'
where node_id='62800000-0000-4000-8000-000000000001';
select pg_temp.wake_assert(not public.qorpera_runtime_office_can_wake(pg_temp.office(4)),
	'nor does a node not seen for five minutes');

-- 6. Maintenance for an update and a cancelled start are passed over, never waited for.
-- Computer 3's last seat is held by Jay; computer 4 cannot wake; computer 5 is updating.
select pg_temp.hold(3,'30000000-0000-4000-8000-000000000038');
select public.qorpera_add_runtime_office_computer('30000000-0000-4000-8000-000000000020','member',
	'30000000-0000-4000-8000-000000000030',null,'30000000-0000-4000-8000-000000000001');
update public.qorpera_runtime_offices set state='maintenance' where id=(pg_temp.office(5)).id;
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000037')='{"decision":"new"}'::jsonb,
	'every seat is in use or held, computer 4 cannot wake and computer 5 is updating: Ivy needs another computer');
update public.qorpera_runtime_offices set state='provisioning' where id=(pg_temp.office(5)).id;
insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id,cancelled_at)
values(extensions.gen_random_uuid(),(pg_temp.office(5)).id,(pg_temp.office(5)).generation,'cancelled',
	'30000000-0000-4000-8000-000000000001',clock_timestamp());
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000037')='{"decision":"new"}'::jsonb,
	'a computer whose start an owner cancelled is passed over too');
select pg_temp.wake_assert(pg_temp.agent_office('30000000-0000-4000-8000-000000000037')->>'placement'='unstarted'
	and (pg_temp.office(6)).computer_number=6,'computer 6 is added for Ivy');

-- 7. Held seats never add rows: a computer never holds more screen rows than screens.
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_screens s
	join public.qorpera_runtime_offices o on o.id=s.office_id
	where o.environment_id='30000000-0000-4000-8000-000000000020' group by o.id,o.max_screens having count(*)>o.max_screens),
	'no computer has more screen rows than screens');

rollback;
