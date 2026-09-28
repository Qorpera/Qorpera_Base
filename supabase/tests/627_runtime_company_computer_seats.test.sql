-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "create function pg_temp.browser("
-- 20260928100000/100100: several Company Computers per company, screens as seats.
-- The fixture registers computer 1 with two screens and gives Alice (…030) a
-- native screen lease on it. Members open screens for Bob (…031) and Carol (…032).
-- Real registry, access, native authority and member RPCs; only guest readiness
-- is synthetic (state='active'), as in the fixture.

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
create function pg_temp.age(p_staff uuid) returns void language sql as $$
	update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()-interval '3 minutes' where staff_agent_id=p_staff
$$;

select pg_temp.wake_assert((pg_temp.office(1)).computer_number=1 and (pg_temp.office(1)).max_screens=2,
	'the registered computer is the company''s computer 1 with two screens');

-- 1. Seats. Alice holds a lease; Bob's screen is opened by a member: computer 1 is full.
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000031')->>'state'='open',
	'a member opens Bob''s screen on the second seat');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000032')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'with both seats in use Carol gets none');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','screen','officeId',(pg_temp.office(1)).id),'Bob is placed on his screen');
-- Switched off (as it ships until the runtime reaches several computers): computer 1 only, as before.
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','room','officeId',(pg_temp.office(1)).id),
	'switched off, Carol is offered computer 1 even when it is full, as before');
select pg_temp.wake_assert(pg_temp.agent_office('30000000-0000-4000-8000-000000000032')->>'placement'='room'
	and (select count(*)=1 from public.qorpera_runtime_offices where environment_id='30000000-0000-4000-8000-000000000020'),
	'switched off, nobody adds a computer');
update public.qorpera_runtime_office_scale_out set enabled=true;
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')='{"decision":"new"}'::jsonb,
	'every running computer is full: Carol needs another computer');

-- 2. An owner opening Carol's computer adds computer 2, once.
select set_config('qorpera_test.carol',pg_temp.agent_office('30000000-0000-4000-8000-000000000032')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.carol')::jsonb->>'placement'='unstarted'
	and current_setting('qorpera_test.carol')::jsonb#>>'{computer,number}'='2'
	and current_setting('qorpera_test.carol')::jsonb->>'computers'='2'
	and current_setting('qorpera_test.carol')::jsonb#>'{computer,waiting}'='null'::jsonb
	and current_setting('qorpera_test.carol')::jsonb#>'{computer,scope}'=pg_temp.scope(2),
	'computer 2 is added for Carol and not started yet');
select pg_temp.wake_assert((pg_temp.office(2)).state='provisioning' and (pg_temp.office(2)).image_sha256=(pg_temp.office(1)).image_sha256
	and (pg_temp.office(2)).bootstrap_sha256=(pg_temp.office(1)).bootstrap_sha256 and (pg_temp.office(2)).max_screens=2
	and (pg_temp.office(2)).client_computer_id<>(pg_temp.office(1)).client_computer_id,
	'computer 2 copies computer 1''s image, bootstrap and screens');
select pg_temp.wake_assert((select count(*)=3 from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(2)).id and state='active'),'every agent has access to computer 2 by default');
select pg_temp.wake_assert(exists(select 1 from public.qorpera_logical_computers c where c.id=(pg_temp.office(2)).logical_computer_id
	and c.status='active' and public.qorpera_runtime_office_matches(c)),'computer 2 has its own logical computer');
select pg_temp.wake_assert((select requested_by='member' and staff_agent_id='30000000-0000-4000-8000-000000000032'
	and user_id='30000000-0000-4000-8000-000000000001' and template_office_id=(pg_temp.office(1)).id
	from public.qorpera_runtime_office_additions where office_id=(pg_temp.office(2)).id),'the addition records who asked');
select pg_temp.wake_assert(pg_temp.agent_office('30000000-0000-4000-8000-000000000032')->>'placement'='unstarted'
	and (select count(*)=2 from public.qorpera_runtime_offices where environment_id='30000000-0000-4000-8000-000000000020'),
	'asking again adds nothing');
select pg_temp.wake_assert(pg_temp.member('select public.qorpera_member_office_catalog(''30000000-0000-4000-8000-000000000020'')')->'scope'
	=pg_temp.scope(1),'the catalog still names computer 1');

-- A started computer waits for its host first ('setup'), then for room ('room').
insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id)
values(extensions.gen_random_uuid(),(pg_temp.office(2)).id,1,'requested','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_wait(pg_temp.office(2))='setup','no host offers computer 2 yet');
select set_config('qorpera_test.office2',(pg_temp.office(2)).id::text,true);
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.queue',public.qorpera_runtime_office_setup_queue()::text,true);
reset role;
select pg_temp.wake_assert(exists(select 1 from jsonb_array_elements(current_setting('qorpera_test.queue')::jsonb) q
	where q->>'companyComputerId'=current_setting('qorpera_test.office2') and q->>'waiting'='setup'
	and q->>'computerNumber'='2' and q->'intentId' is not null),'operators see computer 2 waiting for its host');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','starting','officeId',(pg_temp.office(2)).id),'Carol waits for computer 2 to start');

-- 3. A seat nobody uses is free: Bob's seat ages and changes hands to Carol.
select pg_temp.age('30000000-0000-4000-8000-000000000031');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')
	=jsonb_build_object('decision','room','officeId',(pg_temp.office(1)).id),'a free seat on a running computer comes first');
select set_config('qorpera_test.bob_row',(select row_to_json(s)::text from public.qorpera_runtime_office_screens s
	where office_id=(pg_temp.office(1)).id and staff_agent_id='30000000-0000-4000-8000-000000000031'),true);
select set_config('qorpera_test.carol_screen',pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000032')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.carol_screen')::jsonb->>'state'='open'
	and current_setting('qorpera_test.carol_screen')::jsonb->>'screenId'=current_setting('qorpera_test.bob_row')::jsonb->>'id'
	and (select staff_agent_id='30000000-0000-4000-8000-000000000032' and power='open'
		and generation>(current_setting('qorpera_test.bob_row')::jsonb->>'generation')::bigint
		and epoch>(current_setting('qorpera_test.bob_row')::jsonb->>'epoch')::bigint
		from public.qorpera_runtime_office_screens where id=(current_setting('qorpera_test.bob_row')::jsonb->>'id')::uuid)
	and (select count(*)=2 from public.qorpera_runtime_office_screens where office_id=(pg_temp.office(1)).id),
	'Carol takes over Bob''s unused screen with a new generation: never more rows than screens');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000031')->>'reason'='SCREEN_CAPACITY_EXHAUSTED',
	'Bob gets no seat back while two are in use');

-- 4. One computer per agent. Computer 2 is up (synthetic readiness); Bob opens there.
delete from public.qorpera_runtime_office_start_intents where office_id=(pg_temp.office(2)).id;
update public.qorpera_runtime_offices set state='active' where id=(pg_temp.office(2)).id;
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','room','officeId',(pg_temp.office(2)).id),'Bob is placed on computer 2, which has room');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(2),'30000000-0000-4000-8000-000000000031')->>'state'='open',
	'Bob''s screen opens on computer 2');
select pg_temp.age('30000000-0000-4000-8000-000000000032');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000031')->>'reason'='AGENT_ON_OTHER_COMPUTER',
	'Bob cannot open a second screen on computer 1 while his screen on computer 2 is in use');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000031')
	=jsonb_build_object('decision','screen','officeId',(pg_temp.office(2)).id),'Bob stays placed on computer 2');

-- The native path: Alice's run cannot take a seat on computer 2 while her lease on computer 1 lives.
select set_config('qorpera_test.scope1',pg_temp.scope(1)::text,true),set_config('qorpera_test.scope2',pg_temp.scope(2)::text,true);
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.scope2')::jsonb,'acquire')=jsonb_build_object('state','refused','reason','SCREEN_OCCUPIED'),
	'a native acquire on another computer is refused while the agent works on one');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'scope'
	=current_setting('qorpera_test.scope1')::jsonb,'the native descriptor offers Alice the computer her screen is on');
reset role;

-- 5. Idle: a run of Alice's keeps computer 1 on, never computer 2.
select pg_temp.wake_assert(public.qorpera_runtime_office_has_demand(pg_temp.office(1)),'computer 1 has demand (Alice''s lease)');
select pg_temp.wake_assert(not public.qorpera_runtime_office_has_demand(pg_temp.office(2)),
	'computer 2 has no demand from the company''s runs: only its own leases, viewers and placed agents count');

-- 6. An agent with no seat anywhere while every computer is full: the start descriptor adds the next computer.
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.office_scope')::jsonb,'release',current_setting('qorpera_test.office_lease')::jsonb)->>'state'='released',
	'Alice releases her screen');
reset role;
select pg_temp.age('30000000-0000-4000-8000-000000000030');
select pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000032');
update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()
where staff_agent_id='30000000-0000-4000-8000-000000000031' and office_id=(pg_temp.office(2)).id;
-- Fill the remaining seats with two more agents.
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
	employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
select profile_id,staff_id,name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,
	model_provider,model_id,created_at,updated_at,updated_by_user_id from public.qorpera_profile_staff,
	(values ('30000000-0000-4000-8000-000000000033'::uuid,'Dan'),('30000000-0000-4000-8000-000000000034'::uuid,'Erin')) b(staff_id,name)
where staff_agent_id='30000000-0000-4000-8000-000000000030';
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(1),'30000000-0000-4000-8000-000000000033')->>'state'='open','Dan takes computer 1''s second seat');
select pg_temp.wake_assert(pg_temp.open(pg_temp.scope(2),'30000000-0000-4000-8000-000000000034')->>'state'='open','Erin takes computer 2''s second seat');
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000030')='{"decision":"new"}'::jsonb,'Alice needs a third computer');
-- A grant revoked on purpose on one computer is revoked on the next one too.
update public.qorpera_runtime_office_access set state='revoked',version=version+1
where office_id=(pg_temp.office(1)).id and staff_agent_id='30000000-0000-4000-8000-000000000034';
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.start',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)::text,true);
reset role;
select pg_temp.wake_assert(current_setting('qorpera_test.start')::jsonb->>'state'='available'
	and current_setting('qorpera_test.start')::jsonb->'scope'=pg_temp.scope(3)
	and (select requested_by='agent' and staff_agent_id='30000000-0000-4000-8000-000000000030' and run_id is not null
		from public.qorpera_runtime_office_additions where office_id=(pg_temp.office(3)).id),
	'the start descriptor adds computer 3 for Alice and offers computer_start for it');
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.start_again',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)::text,true);
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)
	='{"state":"unavailable"}'::jsonb,'no screen tools while every running computer is full');
reset role;
select pg_temp.wake_assert(current_setting('qorpera_test.start_again')::jsonb->'scope'=pg_temp.scope(3),'asking again offers computer 3 and adds nothing');
select pg_temp.wake_assert((select count(*)=3 from public.qorpera_runtime_offices where environment_id='30000000-0000-4000-8000-000000000020'),
	'three computers');
select pg_temp.wake_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(2)).id and staff_agent_id='30000000-0000-4000-8000-000000000034'),
	'computer access is company-wide: revoking Erin on computer 1 revokes her on computer 2');
select pg_temp.wake_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(3)).id and staff_agent_id='30000000-0000-4000-8000-000000000034')
	and (select state='active' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(3)).id and staff_agent_id='30000000-0000-4000-8000-000000000030'),
	'computer 3 keeps Erin''s revoked grant revoked and gives Alice access');

-- An agent revoked on every computer is denied, and no computer is added around it.
update public.qorpera_runtime_office_access set state='revoked',version=version+1
where staff_agent_id='30000000-0000-4000-8000-000000000032' and state='active';
select pg_temp.wake_assert(pg_temp.place('30000000-0000-4000-8000-000000000032')='{"decision":"denied"}'::jsonb,
	'Carol, revoked everywhere, is denied');
select set_config('qorpera_test.denied',pg_temp.agent_office('30000000-0000-4000-8000-000000000032')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.denied')::jsonb->>'placement'='denied'
	and current_setting('qorpera_test.denied')::jsonb->'computer'='null'::jsonb
	and (select count(*)=3 from public.qorpera_runtime_offices where environment_id='30000000-0000-4000-8000-000000000020'),
	'an owner opening Carol''s computer adds nothing');

-- 6b. Access is company-wide: capabilities follow too, and a re-hired agent keeps its revocation.
update public.qorpera_runtime_office_access set capabilities='["shell"]',version=version+1
where office_id=(pg_temp.office(1)).id and staff_agent_id='30000000-0000-4000-8000-000000000030';
select pg_temp.wake_assert((select count(*)=3 from public.qorpera_runtime_office_access
	where staff_agent_id='30000000-0000-4000-8000-000000000030' and capabilities='["shell"]'::jsonb),
	'capabilities changed on computer 1 reach computers 2 and 3');
-- Erin (revoked everywhere) is archived; a fourth computer is added meanwhile; she is re-hired.
update public.qorpera_profile_staff set employment_status='archived' where staff_agent_id='30000000-0000-4000-8000-000000000034';
select public.qorpera_add_runtime_office_computer('30000000-0000-4000-8000-000000000020','member',
	'30000000-0000-4000-8000-000000000030',null,'30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(4)).id and staff_agent_id='30000000-0000-4000-8000-000000000034'),
	'an archived agent gets no grant on a new computer');
update public.qorpera_profile_staff set employment_status='active' where staff_agent_id='30000000-0000-4000-8000-000000000034';
select pg_temp.wake_assert((select state='revoked' from public.qorpera_runtime_office_access
	where office_id=(pg_temp.office(4)).id and staff_agent_id='30000000-0000-4000-8000-000000000034'),
	'a grant created again for a re-hired agent takes her revoked grant on the other computers');

-- 7. A computer never holds more screen rows than screens: the guest keeps a desktop for each.
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_screens s
	join public.qorpera_runtime_offices o on o.id=s.office_id
	where o.environment_id='30000000-0000-4000-8000-000000000020' group by o.id,o.max_screens having count(*)>o.max_screens),
	'no computer has more screen rows than screens');

rollback;
