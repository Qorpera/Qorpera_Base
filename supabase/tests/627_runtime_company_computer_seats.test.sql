-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- 20260928237100/237200 on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): several Company Computers
-- per company, screens as seats. 405's office fixture registers computer 1 with two screens on 924's folder-v2 company and
-- gives Alice's live run (…030) a native screen lease on it. Members open screens for Bob (…031) and Carol (…032); Dan
-- and Erin are hired, archived and hired again through their agent.md in the owner's folder commits. 924's Co-Founder
-- (…033) is an active agent too. Real registry, access, native authority and member RPCs; only guest readiness is
-- synthetic (state='active'), as in the fixture.

create function pg_temp.cs_member(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.cs_open(p_scope jsonb,p_staff uuid) returns jsonb language sql as $$
	select pg_temp.cs_member(format('select public.qorpera_open_runtime_office_screen(%L::jsonb,%L::uuid)',p_scope,p_staff))
$$;
create function pg_temp.cs_agent_office(p_staff uuid) returns jsonb language sql as $$
	select pg_temp.cs_member(format('select public.qorpera_member_agent_office(%L::uuid,%L::uuid)',
		'92400000-0000-4000-8000-000000000020',p_staff))
$$;
create function pg_temp.cs_place(p_staff uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_office_placement('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020',p_staff)
$$;
create function pg_temp.cs_office(p_number integer) returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices
	where environment_id='92400000-0000-4000-8000-000000000020' and computer_number=p_number
$$;
create function pg_temp.cs_scope(p_number integer) returns jsonb language sql as $$
	select public.qorpera_runtime_office_scope(pg_temp.cs_office(p_number))
$$;
create function pg_temp.cs_age(p_staff uuid) returns void language sql as $$
	update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()-interval '3 minutes' where staff_agent_id=p_staff
$$;
-- An agent's agent.md saved with a status, over the version read (924's agent text and parse).
create function pg_temp.cs_status(p_handle text,p_id uuid,p_name text,p_status text) returns jsonb language sql as $$
	select pg_temp.base_write('QorperaOS/agents/'||p_handle||'/agent.md','agent',
		replace(pg_temp.base_agent_text(p_id,p_name),E'status: active\n','status: '||p_status||E'\n'),
		jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Research','agentKind','agent','status',p_status,
			'colour',null,'figure',null,'model',null,'effort',null,'instructions','Read and change the company folder.'),
		pg_temp.base_version('QorperaOS/agents/'||p_handle||'/agent.md'))
$$;

select pg_temp.base_assert((pg_temp.cs_office(1)).computer_number=1 and (pg_temp.cs_office(1)).max_screens=2,
	'the registered computer is the company''s computer 1 with two screens');

-- 1. Seats. Alice holds a lease; Bob's screen is opened by a member: computer 1 is full.
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000031')->>'state'='open',
	'a member opens Bob''s screen on the second seat');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000032')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'with both seats in use Carol gets none');
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','screen','officeId',(pg_temp.cs_office(1)).id),'Bob is placed on his screen');
-- Switched off (as it ships until the runtime reaches several computers): computer 1 only, as before.
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','room','officeId',(pg_temp.cs_office(1)).id),
	'switched off, Carol is offered computer 1 even when it is full, as before');
select pg_temp.base_assert(pg_temp.cs_agent_office('92400000-0000-4000-8000-000000000032')->>'placement'='room'
	and (select count(*)=1 from public.qorpera_runtime_offices where environment_id='92400000-0000-4000-8000-000000000020'),
	'switched off, nobody adds a computer');
update public.qorpera_runtime_office_scale_out set enabled=true;
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000032')='{"decision":"new"}'::jsonb,
	'every running computer is full: Carol needs another computer');

-- 2. An owner opening Carol's computer adds computer 2, once.
select set_config('qorpera_test.carol',pg_temp.cs_agent_office('92400000-0000-4000-8000-000000000032')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.carol')::jsonb->>'placement'='unstarted'
	and current_setting('qorpera_test.carol')::jsonb#>>'{computer,number}'='2'
	and current_setting('qorpera_test.carol')::jsonb->>'computers'='2'
	and current_setting('qorpera_test.carol')::jsonb#>'{computer,waiting}'='null'::jsonb
	and current_setting('qorpera_test.carol')::jsonb#>'{computer,scope}'=pg_temp.cs_scope(2),
	'computer 2 is added for Carol and not started yet');
select pg_temp.base_assert((pg_temp.cs_office(2)).state='provisioning' and (pg_temp.cs_office(2)).image_sha256=(pg_temp.cs_office(1)).image_sha256
	and (pg_temp.cs_office(2)).bootstrap_sha256=(pg_temp.cs_office(1)).bootstrap_sha256 and (pg_temp.cs_office(2)).max_screens=2
	and (pg_temp.cs_office(2)).client_computer_id<>(pg_temp.cs_office(1)).client_computer_id,
	'computer 2 copies computer 1''s image, bootstrap and screens');
select pg_temp.base_assert((select count(*)=4 from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(2)).id and state='active'),
	'every agent (the Co-Founder, Alice, Bob and Carol) has access to computer 2 by default');
select pg_temp.base_assert(exists(select 1 from public.qorpera_logical_computers c where c.id=(pg_temp.cs_office(2)).logical_computer_id
	and c.status='active' and public.qorpera_runtime_office_matches(c)),'computer 2 has its own logical computer');
select pg_temp.base_assert((select requested_by='member' and staff_agent_id='92400000-0000-4000-8000-000000000032'
	and user_id='92400000-0000-4000-8000-000000000001' and template_office_id=(pg_temp.cs_office(1)).id
	from public.qorpera_runtime_office_additions where office_id=(pg_temp.cs_office(2)).id),'the addition records who asked');
select pg_temp.base_assert(pg_temp.cs_agent_office('92400000-0000-4000-8000-000000000032')->>'placement'='unstarted'
	and (select count(*)=2 from public.qorpera_runtime_offices where environment_id='92400000-0000-4000-8000-000000000020'),
	'asking again adds nothing');
select pg_temp.base_assert(pg_temp.cs_member('select public.qorpera_member_office_catalog(''92400000-0000-4000-8000-000000000020'')')->'scope'
	=pg_temp.cs_scope(1),'the catalog still names computer 1');

-- A started computer waits for its host first ('setup'), then for room ('room').
insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id)
values(extensions.gen_random_uuid(),(pg_temp.cs_office(2)).id,1,'requested','92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_runtime_office_start_wait(pg_temp.cs_office(2))='setup','no host offers computer 2 yet');
select set_config('qorpera_test.office2',(pg_temp.cs_office(2)).id::text,true);
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.queue',public.qorpera_runtime_office_setup_queue()::text,true);
reset role;
select pg_temp.base_assert(exists(select 1 from jsonb_array_elements(current_setting('qorpera_test.queue')::jsonb) q
	where q->>'companyComputerId'=current_setting('qorpera_test.office2') and q->>'waiting'='setup'
	and q->>'computerNumber'='2' and q->'intentId' is not null and q->>'maxScreens'='2' and not q ? 'template'),
	'operators see computer 2 waiting for its host, with no node named');
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','starting','officeId',(pg_temp.cs_office(2)).id),'Carol waits for computer 2 to start');

-- 3. A seat nobody uses is free: Bob's seat ages and changes hands to Carol.
select pg_temp.cs_age('92400000-0000-4000-8000-000000000031');
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','room','officeId',(pg_temp.cs_office(1)).id),'a free seat on a running computer comes first');
select set_config('qorpera_test.bob_row',(select row_to_json(s)::text from public.qorpera_runtime_office_screens s
	where office_id=(pg_temp.cs_office(1)).id and staff_agent_id='92400000-0000-4000-8000-000000000031'),true);
select set_config('qorpera_test.carol_screen',pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000032')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.carol_screen')::jsonb->>'state'='open'
	and current_setting('qorpera_test.carol_screen')::jsonb->>'screenId'=current_setting('qorpera_test.bob_row')::jsonb->>'id'
	and (select staff_agent_id='92400000-0000-4000-8000-000000000032' and power='open'
		and generation>(current_setting('qorpera_test.bob_row')::jsonb->>'generation')::bigint
		and epoch>(current_setting('qorpera_test.bob_row')::jsonb->>'epoch')::bigint
		from public.qorpera_runtime_office_screens where id=(current_setting('qorpera_test.bob_row')::jsonb->>'id')::uuid)
	and (select count(*)=2 from public.qorpera_runtime_office_screens where office_id=(pg_temp.cs_office(1)).id),
	'Carol takes over Bob''s unused screen with a new generation: never more rows than screens');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000031')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'Bob gets no seat back while two are in use');

-- 4. One computer per agent. Computer 2 is up (synthetic readiness); Bob opens there.
delete from public.qorpera_runtime_office_start_intents where office_id=(pg_temp.cs_office(2)).id;
update public.qorpera_runtime_offices set state='active' where id=(pg_temp.cs_office(2)).id;
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','room','officeId',(pg_temp.cs_office(2)).id),'Bob is placed on computer 2, which has room');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(2),'92400000-0000-4000-8000-000000000031')->>'state'='open',
	'Bob''s screen opens on computer 2');
select pg_temp.cs_age('92400000-0000-4000-8000-000000000032');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000031')->>'reason'='AGENT_ON_OTHER_COMPUTER',
	'Bob cannot open a second screen on computer 1 while his screen on computer 2 is in use');
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','screen','officeId',(pg_temp.cs_office(2)).id),'Bob stays placed on computer 2');

-- The native path: Alice's run cannot take a seat on computer 2 while her lease on computer 1 lives.
select set_config('qorpera_test.scope1',pg_temp.cs_scope(1)::text,true),set_config('qorpera_test.scope2',pg_temp.cs_scope(2)::text,true);
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_assert(public.qorpera_native_office_screen(current_setting('qorpera_test.base_binding')::jsonb,
	current_setting('qorpera_test.scope2')::jsonb,'acquire')=jsonb_build_object('state','refused','reason','SCREEN_OCCUPIED'),
	'a native acquire on another computer is refused while the agent works on one');
select pg_temp.base_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)->'scope'
	=current_setting('qorpera_test.scope1')::jsonb,'the native descriptor offers Alice the computer her screen is on');
reset role;

-- 5. Idle: a run of Alice's keeps computer 1 on, never computer 2.
select pg_temp.base_assert(public.qorpera_runtime_office_has_demand(pg_temp.cs_office(1)),'computer 1 has demand (Alice''s lease)');
select pg_temp.base_assert(not public.qorpera_runtime_office_has_demand(pg_temp.cs_office(2)),
	'computer 2 has no demand from the company''s runs: only its own leases, viewers and placed agents count');

-- 6. An agent with no seat anywhere while every computer is full: the start descriptor adds the next computer.
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_assert(public.qorpera_native_office_screen(current_setting('qorpera_test.base_binding')::jsonb,
	current_setting('qorpera_test.office_scope')::jsonb,'release',current_setting('qorpera_test.office_lease')::jsonb)->>'state'='released',
	'Alice releases her screen');
reset role;
select pg_temp.cs_age('92400000-0000-4000-8000-000000000030');
select pg_temp.cs_open(pg_temp.cs_scope(1),'92400000-0000-4000-8000-000000000032');
update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()
where staff_agent_id='92400000-0000-4000-8000-000000000031' and office_id=(pg_temp.cs_office(2)).id;
-- Fill the remaining seats with two more agents, hired through their agent.md in the owner's commit.
select pg_temp.base_commit(pg_temp.base_owner(),'cs-hire-dan-erin',jsonb_build_array(
	pg_temp.base_hire('dan','62700000-0000-4000-8000-0000000000d1','Dan'),
	pg_temp.base_hire('erin','62700000-0000-4000-8000-0000000000e1','Erin')));
select pg_temp.base_assert((select count(*)=2 from public.qorpera_profile_staff where profile_id='92400000-0000-4000-8000-000000000010'
	and staff_agent_id in ('62700000-0000-4000-8000-0000000000d1','62700000-0000-4000-8000-0000000000e1') and employment_status='active'),
	'Dan and Erin are hired');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(1),'62700000-0000-4000-8000-0000000000d1')->>'state'='open','Dan takes computer 1''s second seat');
select pg_temp.base_assert(pg_temp.cs_open(pg_temp.cs_scope(2),'62700000-0000-4000-8000-0000000000e1')->>'state'='open','Erin takes computer 2''s second seat');
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000030')='{"decision":"new"}'::jsonb,'Alice needs a third computer');
-- A grant revoked on purpose on one computer is revoked on the next one too.
update public.qorpera_runtime_office_access set state='revoked',version=version+1
where office_id=(pg_temp.cs_office(1)).id and staff_agent_id='62700000-0000-4000-8000-0000000000e1';
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.start',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.base_binding')::jsonb)::text,true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.start')::jsonb->>'state'='available'
	and current_setting('qorpera_test.start')::jsonb->'scope'=pg_temp.cs_scope(3)
	and (select requested_by='agent' and staff_agent_id='92400000-0000-4000-8000-000000000030' and run_id is not null
		from public.qorpera_runtime_office_additions where office_id=(pg_temp.cs_office(3)).id),
	'the start descriptor adds computer 3 for Alice and offers computer_start for it');
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.start_again',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.base_binding')::jsonb)::text,true);
select pg_temp.base_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)
	='{"state":"unavailable"}'::jsonb,'no screen tools while every running computer is full');
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.start_again')::jsonb->'scope'=pg_temp.cs_scope(3),'asking again offers computer 3 and adds nothing');
select pg_temp.base_assert((select count(*)=3 from public.qorpera_runtime_offices where environment_id='92400000-0000-4000-8000-000000000020'),
	'three computers');
select pg_temp.base_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(2)).id and staff_agent_id='62700000-0000-4000-8000-0000000000e1'),
	'computer access is company-wide: revoking Erin on computer 1 revokes her on computer 2');
select pg_temp.base_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(3)).id and staff_agent_id='62700000-0000-4000-8000-0000000000e1')
	and (select state='active' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(3)).id and staff_agent_id='92400000-0000-4000-8000-000000000030'),
	'computer 3 keeps Erin''s revoked grant revoked and gives Alice access');

-- An agent revoked on every computer is denied, and no computer is added around it.
update public.qorpera_runtime_office_access set state='revoked',version=version+1
where staff_agent_id='92400000-0000-4000-8000-000000000032' and state='active';
select pg_temp.base_assert(pg_temp.cs_place('92400000-0000-4000-8000-000000000032')='{"decision":"denied"}'::jsonb,
	'Carol, revoked everywhere, is denied');
select set_config('qorpera_test.denied',pg_temp.cs_agent_office('92400000-0000-4000-8000-000000000032')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.denied')::jsonb->>'placement'='denied'
	and current_setting('qorpera_test.denied')::jsonb->'computer'='null'::jsonb
	and (select count(*)=3 from public.qorpera_runtime_offices where environment_id='92400000-0000-4000-8000-000000000020'),
	'an owner opening Carol''s computer adds nothing');

-- 6b. Access is company-wide: capabilities follow too, and a re-hired agent keeps its revocation.
update public.qorpera_runtime_office_access set capabilities='["shell"]',version=version+1
where office_id=(pg_temp.cs_office(1)).id and staff_agent_id='92400000-0000-4000-8000-000000000030';
select pg_temp.base_assert((select count(*)=3 from public.qorpera_runtime_office_access
	where staff_agent_id='92400000-0000-4000-8000-000000000030' and capabilities='["shell"]'::jsonb),
	'capabilities changed on computer 1 reach computers 2 and 3');
-- Erin (revoked everywhere) is archived through her agent.md; a fourth computer is added meanwhile; the owner sets her
-- agent.md active again.
select pg_temp.base_commit(pg_temp.base_owner(),'cs-archive-erin',jsonb_build_array(
	pg_temp.cs_status('erin','62700000-0000-4000-8000-0000000000e1','Erin','archived')));
select pg_temp.base_assert((select employment_status='archived' from public.qorpera_profile_staff
	where staff_agent_id='62700000-0000-4000-8000-0000000000e1'),'Erin is archived');
select public.qorpera_add_runtime_office_computer('92400000-0000-4000-8000-000000000020','member',
	'92400000-0000-4000-8000-000000000030',null,'92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(not exists(select 1 from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(4)).id and staff_agent_id='62700000-0000-4000-8000-0000000000e1'),
	'an archived agent gets no grant on a new computer');
select pg_temp.base_commit(pg_temp.base_owner(),'cs-rehire-erin',jsonb_build_array(
	pg_temp.cs_status('erin','62700000-0000-4000-8000-0000000000e1','Erin','active')));
select pg_temp.base_assert((select employment_status='active' from public.qorpera_profile_staff
	where staff_agent_id='62700000-0000-4000-8000-0000000000e1'),'Erin is active again');
select pg_temp.base_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(4)).id and staff_agent_id='62700000-0000-4000-8000-0000000000e1'),
	'a grant created again for a re-hired agent takes her revoked grant on the other computers');

-- An owner's explicit grant on a computer with no row for the agent keeps the owner's choice and
-- spreads it. On a computer 5, Dan's default grant (and its company browser grant) is removed, so
-- he has no row there, as when a grant was never made.
select public.qorpera_add_runtime_office_computer('92400000-0000-4000-8000-000000000020','member',
	'92400000-0000-4000-8000-000000000030',null,'92400000-0000-4000-8000-000000000001');
delete from public.qorpera_runtime_browser_grants
where office_id=(pg_temp.cs_office(5)).id and staff_agent_id='62700000-0000-4000-8000-0000000000d1';
delete from public.qorpera_runtime_office_access
where office_id=(pg_temp.cs_office(5)).id and staff_agent_id='62700000-0000-4000-8000-0000000000d1';
select pg_temp.base_assert(not exists(select 1 from public.qorpera_runtime_office_access
	where office_id=(pg_temp.cs_office(5)).id and staff_agent_id='62700000-0000-4000-8000-0000000000d1'),'Dan has no row on computer 5');
select set_config('qorpera_test.dan_grant',pg_temp.cs_member(format('select public.qorpera_set_runtime_office_access(%L::uuid,%L::uuid,0,false)',
	(pg_temp.cs_office(5)).id,'62700000-0000-4000-8000-0000000000d1'))::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.dan_grant')::jsonb->>'state'='revoked'
	and current_setting('qorpera_test.dan_grant')::jsonb->>'version'='1'
	and (select state='revoked' and version=1 from public.qorpera_runtime_office_access
		where office_id=(pg_temp.cs_office(5)).id and staff_agent_id='62700000-0000-4000-8000-0000000000d1')
	and (select count(*)=5 from public.qorpera_runtime_office_access
		where staff_agent_id='62700000-0000-4000-8000-0000000000d1' and state='revoked'),
	'the owner''s revocation on computer 5 stands, as returned, and reaches every computer');

-- 7. A computer never holds more screen rows than screens: the guest keeps a desktop for each.
select pg_temp.base_assert(not exists(select 1 from public.qorpera_runtime_office_screens s
	join public.qorpera_runtime_offices o on o.id=s.office_id
	where o.environment_id='92400000-0000-4000-8000-000000000020' group by o.id,o.max_screens having count(*)>o.max_screens),
	'no computer has more screen rows than screens');

rollback;
