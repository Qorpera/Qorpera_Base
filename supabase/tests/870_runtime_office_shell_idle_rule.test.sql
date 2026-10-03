-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260930007000 (with 20260929070000): the Company Computer under one idle
-- rule for every machine (2026-10-03 amendment).
-- 1. A waiting dev server keeps nothing awake: the computer sleeps, the sleep
--    ends the command as slept, and the agent's next run in that conversation
--    is told once. Other stops end commands as closed, paused or lost.
-- 2. A busy job keeps the computer awake; after an hour busy with no turn from
--    its agent, the agent is asked whether it still needs it, in the
--    conversation of the run that worked with it last; a turn resets the count.
-- 3. Telling and asking wait for their switch.
-- The office's registration, start and activation are the SQL policy fixture
-- of 718; guest readiness and reports are synthetic. Not a Linux test.

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'30000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
reset role;
create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.path_claims('service_role');
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000001',repeat('f',64),0,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002');
select pg_temp.path_claims('service_role');
select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000003',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'39000000-0000-4000-8000-000000000001',repeat('f',64));
insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
	provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,
	state,service_invocation_id,ready_at,activated_at)
select i.id,'39000000-0000-4000-8000-000000000004',i.office_id,1,i.allocation_id,p.provider_id,p.policy_sha256,
	i.provider_binding_sha256,i.instance_sha256,i.image_sha256,i.bootstrap_sha256,
	jsonb_build_object('bootId','39000000-0000-4000-8000-000000000005','configurationSha256',repeat('e',64)),
	'[]','active',repeat('a',32),clock_timestamp(),clock_timestamp()
from public.qorpera_runtime_office_start_intents i join public.qorpera_runtime_office_providers p on p.office_id=i.office_id;
update public.qorpera_runtime_offices set state='active';
-- The agent's run has acknowledged its wake; its screen was acquired and let go.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
set local role service_role;
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
reset role;
select set_config('qorpera_test.screen',current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}',true);

create function pg_temp.office() returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid
$$;
create function pg_temp.demand() returns boolean language sql as $$
	select public.qorpera_runtime_office_has_demand(pg_temp.office())
$$;
create function pg_temp.idle_poll() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.office_scope')::jsonb,1,
		'39000000-0000-4000-8000-000000000001',repeat('f',64),60000)
$$;
create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid
$$;
create function pg_temp.command(p_n integer) returns uuid language sql as $$
	select ('00000000-0000-4000-8000-000000000' || lpad(p_n::text,3,'0'))::uuid
$$;
create function pg_temp.command_row(p_n integer) returns public.qorpera_runtime_office_shell_commands language sql as $$
	select * from public.qorpera_runtime_office_shell_commands where id=pg_temp.command(p_n)
$$;
create function pg_temp.at(p_ago interval) returns text language sql as $$
	select to_char((clock_timestamp()-p_ago) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
-- A command as the office reports it: still open, or ended since the last report.
create function pg_temp.open_item(p_n integer,p_command text,p_started interval,p_worked interval) returns jsonb language sql as $$
	select jsonb_build_object('id',pg_temp.command(p_n),'runId',current_setting('qorpera_test.wake_binding')::jsonb->>'runId',
		'command',p_command,'startedAt',pg_temp.at(p_started),'workedAt',pg_temp.at(p_worked))
$$;
create function pg_temp.ended_item(p_n integer,p_command text,p_reason text) returns jsonb language sql as $$
	select jsonb_build_object('id',pg_temp.command(p_n),'runId',current_setting('qorpera_test.wake_binding')::jsonb->>'runId',
		'command',p_command,'startedAt',pg_temp.at('20 minutes'),'reason',p_reason,'endedAt',pg_temp.at('1 minute'))
$$;
-- The office's report of the agent's screen.
create function pg_temp.shells(p_busy boolean,p_open jsonb default '[]',p_ended jsonb default '[]') returns jsonb language sql as $$
	select public.qorpera_report_runtime_office_shell_activity(current_setting('qorpera_test.office_scope')::jsonb,
		current_setting('qorpera_test.generation')::bigint,
		jsonb_build_object('schema','qorpera.office-shell-report/v1','screens',jsonb_build_array(jsonb_build_object(
			'screenId',current_setting('qorpera_test.screen'),'busy',p_busy,'open',p_open,'ended',p_ended))))
$$;
create function pg_temp.open_work() returns jsonb language sql as $$
	select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.wake_binding')::jsonb)
$$;
select set_config('qorpera_test.generation',(pg_temp.office()).generation::text,true);

-- The fixture leaves a turn waiting for an agent with computer access, demand of its own; without
-- that access the computer has nothing to do.
update public.qorpera_runtime_office_access set state='revoked' where office_id=(pg_temp.office()).id;
select pg_temp.wake_assert(not pg_temp.demand(),'An active computer with nothing to do has no demand');
select pg_temp.wake_assert((select not enabled from public.qorpera_idle_rule_settings),'Telling and asking start switched off');

-- 1. A waiting dev server: on record with the run that started it, and no demand.
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.shells(false,jsonb_build_array(pg_temp.open_item(1,'npm run dev','10 minutes','10 minutes')),
	jsonb_build_array(pg_temp.ended_item(3,'npm test','exited')))->'screens'='[]'::jsonb,'A waiting dev server is reported, not busy');
select pg_temp.wake_assert(not pg_temp.demand(),'A waiting dev server is no demand');
select pg_temp.wake_assert((select c.staff_agent_id=(pg_temp.run()).staff_agent_id and c.run_id=(pg_temp.run()).id
	and c.session_id is not distinct from (pg_temp.run()).session_id and c.command='npm run dev' and c.ended_at is null
	and c.computer_generation=(pg_temp.office()).generation and c.told_at is null from pg_temp.command_row(1) c),
	'The command is on record with the run that started it');
select pg_temp.wake_assert((select c.end_reason='exited' and c.ended_at is not null from pg_temp.command_row(3) c),
	'A command that exited is on record as exited');
-- Only the screen's agent's own runs, an exact shape, and the office's own end reasons.
select pg_temp.wake_error(format('select pg_temp.shells(false,%L::jsonb)',jsonb_build_array(pg_temp.open_item(4,'ls','1 minute','1 minute')
	||jsonb_build_object('runId','30000000-0000-4000-8000-0000000000ff'))),'42501','Office shell activity run differs');
select pg_temp.wake_error(format('select pg_temp.shells(false,%L::jsonb)',jsonb_build_array(pg_temp.open_item(4,repeat('x',301),'1 minute','1 minute'))),
	'22023','Invalid office shell activity');
select pg_temp.wake_error(format('select pg_temp.shells(false,%L::jsonb)',jsonb_build_array(pg_temp.open_item(4,'ls','1 minute','1 minute')||'{"busy":true}')),
	'22023','Invalid office shell activity');
select pg_temp.wake_error(format('select pg_temp.shells(false,''[]'',%L::jsonb)',jsonb_build_array(pg_temp.ended_item(4,'ls','slept'))),
	'22023','Invalid office shell activity');

-- 2. A busy job keeps the computer awake while its report is fresh.
select pg_temp.wake_assert(pg_temp.shells(true,jsonb_build_array(pg_temp.open_item(1,'npm run dev','10 minutes','10 minutes'),
	pg_temp.open_item(2,'npm run build','5 minutes','5 minutes')))->'screens'=jsonb_build_array(current_setting('qorpera_test.screen')),
	'A busy job is reported busy');
select pg_temp.wake_assert(pg_temp.demand(),'A busy job keeps the computer awake');
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','The idle policy does not put a busy computer to sleep');
-- The job finishes; the dev server only waits.
select pg_temp.shells(false,jsonb_build_array(pg_temp.open_item(1,'npm run dev','10 minutes','10 minutes')),
	jsonb_build_array(pg_temp.ended_item(2,'npm run build','exited')));
select pg_temp.wake_assert(not pg_temp.demand(),'Once the job is done, the waiting dev server keeps nothing awake');

-- 3. The computer sleeps; sleep ends the dev server, and the next run is told once.
savepoint before_sleep;
update public.qorpera_runtime_office_idle_policies set idle_since=clock_timestamp()-interval '2 hours';
do $$
declare v_poll jsonb := pg_temp.idle_poll();
begin
	perform pg_temp.wake_assert(v_poll#>>'{request,action}'='power_off','A computer with only a waiting dev server goes to sleep');
	perform pg_temp.wake_assert((select c.end_reason='slept' and c.ended_at is not null and c.told_at is null from pg_temp.command_row(1) c),
		'Sleep ends the dev server as slept');
	perform pg_temp.wake_assert((select c.end_reason='exited' from pg_temp.command_row(2) c)
		and (select c.end_reason='exited' from pg_temp.command_row(3) c),'What had already ended keeps its own end');
end $$;
do $$
declare v_work jsonb;
begin
	-- Switched off, nothing is listed and nothing is marked told.
	v_work := pg_temp.open_work();
	perform pg_temp.wake_assert(not v_work ? 'computerStopped' and v_work->>'schema'='qorpera.agent-open-work/v1'
		and (pg_temp.command_row(1)).told_at is null,'Switched off, the run is not told and the command waits');
	update public.qorpera_idle_rule_settings set enabled=true;
	v_work := pg_temp.open_work();
	perform pg_temp.wake_assert(jsonb_array_length(v_work->'computerStopped')=1
		and v_work#>>'{computerStopped,0,command}'='npm run dev' and v_work#>>'{computerStopped,0,reason}'='slept'
		and (v_work#>>'{computerStopped,0,startedAt}')::timestamptz=(pg_temp.command_row(1)).started_at
		and (v_work#>>'{computerStopped,0,endedAt}')::timestamptz=(pg_temp.command_row(1)).ended_at
		and v_work->'todos' is not null and v_work->'workers' is not null,
		'The next run is told what sleep stopped, and only that: '||v_work::text);
	perform pg_temp.wake_assert((pg_temp.command_row(1)).told_run_id=(pg_temp.run()).id and (pg_temp.command_row(1)).told_at is not null
		and (pg_temp.command_row(2)).told_at is null and (pg_temp.command_row(3)).told_at is null,
		'The command is marked told by that run; what ended by itself is never told');
	-- The same run restarted is told again; another run is not.
	perform pg_temp.wake_assert(jsonb_array_length(pg_temp.open_work()->'computerStopped')=1,'A restart of the same run is told again');
	update public.qorpera_runtime_office_shell_commands set told_run_id=extensions.gen_random_uuid() where id=pg_temp.command(1);
	perform pg_temp.wake_assert(not pg_temp.open_work() ? 'computerStopped','A command told in another run is not told again');
	-- At most 32 a run, oldest first.
	insert into public.qorpera_runtime_office_shell_commands(id,office_id,computer_generation,screen_id,staff_agent_id,run_id,session_id,
		command,started_at,worked_at,ended_at,end_reason)
	select extensions.gen_random_uuid(),(pg_temp.office()).id,(pg_temp.office()).generation,current_setting('qorpera_test.screen')::uuid,
		(pg_temp.run()).staff_agent_id,(pg_temp.run()).id,(pg_temp.run()).session_id,'job '||n,clock_timestamp()-interval '1 hour',
		clock_timestamp()-interval '1 hour',clock_timestamp()-(40-n)*interval '1 second','closed'
	from generate_series(1,40) n;
	v_work := pg_temp.open_work();
	perform pg_temp.wake_assert(jsonb_array_length(v_work->'computerStopped')=32 and v_work#>>'{computerStopped,0,command}'='job 1'
		and v_work#>>'{computerStopped,31,command}'='job 32','At most 32 a run, oldest first');
end $$;
rollback to before_sleep;

-- 4. Other stops: a screen gone, a paused company, an earlier generation, any other stop of the computer.
savepoint other_stops;
select public.qorpera_report_runtime_office_shell_activity(current_setting('qorpera_test.office_scope')::jsonb,
	current_setting('qorpera_test.generation')::bigint,'{"schema":"qorpera.office-shell-report/v1","screens":[]}');
select pg_temp.wake_assert((pg_temp.command_row(1)).end_reason='closed','A shell whose screen is gone ends as closed');
rollback to other_stops;
insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id)
values((pg_temp.office()).profile_id,'30000000-0000-4000-8000-000000000001');
select set_config('qorpera_test.paused',pg_temp.shells(true,jsonb_build_array(pg_temp.open_item(1,'npm run dev','10 minutes','10 minutes')))::text,true);
select pg_temp.wake_assert((current_setting('qorpera_test.paused')::jsonb->>'paused')::boolean
	and (pg_temp.command_row(1)).end_reason='paused','A pause ends what still runs as paused');
rollback to other_stops;
update public.qorpera_runtime_office_shell_commands set computer_generation=computer_generation-1 where id=pg_temp.command(1);
select pg_temp.shells(false);
select pg_temp.wake_assert((pg_temp.command_row(1)).end_reason='lost','A command of an earlier generation nobody ended is lost');
rollback to other_stops;
select pg_temp.wake_assert(pg_get_functiondef('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure)
	like '%update public.qorpera_runtime_office_shell_commands set ended_at=clock_timestamp(),end_reason=''closed''%'
	and pg_get_functiondef('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure)
	like '%end_reason=''slept''%perform public.qorpera_begin_runtime_office_lifecycle(v_request);%',
	'Sleep ends commands as slept before the stop; any other stop of the computer ends them as closed');
rollback to other_stops;

-- 5. Check-ins. The marks: 1, 3 and 7 hours, then every 24.
select pg_temp.wake_assert(public.qorpera_machine_checkin_mark(0.99) is null and public.qorpera_machine_checkin_mark(1)=1
	and public.qorpera_machine_checkin_mark(2.99)=1 and public.qorpera_machine_checkin_mark(3)=3
	and public.qorpera_machine_checkin_mark(6.99)=3 and public.qorpera_machine_checkin_mark(7)=7
	and public.qorpera_machine_checkin_mark(30.99)=7 and public.qorpera_machine_checkin_mark(31)=31
	and public.qorpera_machine_checkin_mark(54.99)=31 and public.qorpera_machine_checkin_mark(55)=55
	and public.qorpera_machine_checkin_mark(null) is null,'Check-in marks: 1, 3, 7, then every 24 hours');
-- A crawl the agent last worked with 90 minutes ago keeps the computer busy.
select pg_temp.shells(true,jsonb_build_array(pg_temp.open_item(5,'python crawl.py','2 hours','90 minutes')),
	jsonb_build_array(pg_temp.ended_item(1,'npm run dev','stopped')));
select pg_temp.wake_assert(pg_temp.demand(),'The busy crawl keeps the computer awake');
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_machine_checkins),'Switched off, nobody is asked');
update public.qorpera_idle_rule_settings set enabled=true;
select public.qorpera_ask_busy_office_shells(32);
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert((select count(*)=1 and bool_and(q.machine_kind='computer' and q.subject_id=current_setting('qorpera_test.screen')::uuid
	and q.parent_run_id=(pg_temp.run()).id and q.staff_agent_id=(pg_temp.run()).staff_agent_id and q.mark_hours=1
	and q.since=(pg_temp.command_row(5)).worked_at and q.delivery='waiting'
	and q.body->'running'=jsonb_build_array(jsonb_build_object('command','python crawl.py','startedAt',(pg_temp.command_row(5)).started_at))
	and (q.body->>'busyHours')::integer=1)
	from public.qorpera_machine_checkins q),'After an hour busy with no turn, the agent is asked once');
-- At three busy hours it is asked again.
update public.qorpera_runtime_office_shell_commands set worked_at=worked_at-interval '2 hours' where id=pg_temp.command(5);
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert((select count(*) from public.qorpera_machine_checkins where mark_hours=3)=1,'At three busy hours it is asked again');
savepoint asked;
-- A turn (the agent typed into it) resets the count.
select pg_temp.shells(true,jsonb_build_array(pg_temp.open_item(5,'python crawl.py','2 hours','0 seconds')));
delete from public.qorpera_machine_checkins;
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_machine_checkins),'A turn with the command resets the count');
rollback to asked;
-- A shell that only waits, or an archived agent, is not asked.
select pg_temp.shells(false,jsonb_build_array(pg_temp.open_item(5,'python crawl.py','2 hours','3 hours')));
delete from public.qorpera_machine_checkins;
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_machine_checkins),'A shell that only waits is not asked about');
rollback to asked;
update public.qorpera_profile_staff set employment_status='archived' where staff_agent_id=(pg_temp.run()).staff_agent_id;
delete from public.qorpera_machine_checkins;
select public.qorpera_ask_busy_office_shells(32);
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_machine_checkins),'An archived agent is not asked');
rollback to asked;

-- 6. The question reaches the run's conversation once that run has ended, as a continuation.
delete from public.qorpera_machine_checkins where mark_hours=1;
do $$
declare v_parent public.qorpera_execution_runs := pg_temp.run(); v_wake public.qorpera_wake_occurrences;
	v_run public.qorpera_execution_runs; v_continuation jsonb;
begin
	perform public.qorpera_drain_machine_checkin_wakes(32);
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where source_kind='machine-checkin')
		and (select delivery from public.qorpera_machine_checkins)='waiting','Nothing races the run that is still working');
	update public.qorpera_idle_rule_settings set enabled=false;
	perform pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'final','checkin-final');
	update public.qorpera_runner_jobs set status='completed',result='{}'::jsonb,finished_at=statement_timestamp(),
		lease_token_sha256=null,lease_expires_at=null where run_id=v_parent.id;
	perform public.qorpera_materialize_wake_execution_runs(32);
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where source_kind='machine-checkin')
		and (select delivery from public.qorpera_machine_checkins)='waiting','Switched off, nothing is delivered');
	update public.qorpera_idle_rule_settings set enabled=true;
	perform public.qorpera_materialize_wake_execution_runs(32);
	select * into strict v_wake from public.qorpera_wake_occurrences where source_kind='machine-checkin';
	perform pg_temp.wake_assert(v_wake.status='materialized' and v_wake.wake_kind='agent' and v_wake.parent_run_id=v_parent.id
		and v_wake.staff_agent_id=v_parent.staff_agent_id and v_wake.session_id is not distinct from v_parent.session_id
		and v_wake.trigger_id='machine-checkin' and v_wake.occurrence_key='machine-checkin:'||v_wake.id::text
		and v_wake.payload->>'schema'='qorpera.machine-checkin/v1' and v_wake.payload->>'parentRunId'=v_parent.id::text
		and v_wake.payload#>>'{checkin,kind}'='computer' and (v_wake.payload#>>'{checkin,hours}')::integer=3
		and v_wake.payload#>>'{checkin,subjectId}'=current_setting('qorpera_test.screen')
		and v_wake.payload#>>'{checkin,detail,running,0,command}'='python crawl.py'
		and (select delivery='delivered' and occurrence_id=v_wake.id from public.qorpera_machine_checkins)
		and public.qorpera_wake_authorized(v_wake),'The question is a wake of the same agent in the same conversation: '||v_wake.payload::text);
	select * into strict v_run from public.qorpera_execution_runs where id=v_wake.run_id;
	v_continuation := public.qorpera_run_continuation(v_run);
	perform pg_temp.wake_assert(v_run.staff_agent_id=v_parent.staff_agent_id and v_run.session_id is not distinct from v_parent.session_id
		and v_continuation->>'schema'='qorpera.machine-checkin-continuation/v1' and v_continuation->>'parentRunId'=v_parent.id::text
		and (v_continuation#>>'{checkin,hours}')::integer=3 and v_continuation->>'parentOutcome'='completed'
		and (public.qorpera_runtime_wake_policy(v_run.id)->>'final') is not null,
		'The continuation run carries the question and what the run did: '||left(v_continuation::text,2000));
	-- A later mark waits for that continuation to end; a person who stops it hears nothing more.
	insert into public.qorpera_machine_checkins(profile_id,environment_id,staff_agent_id,parent_run_id,machine_kind,subject_id,since,mark_hours,body)
	select profile_id,environment_id,staff_agent_id,parent_run_id,machine_kind,subject_id,since,7,body from public.qorpera_machine_checkins;
	perform public.qorpera_drain_machine_checkin_wakes(32);
	perform pg_temp.wake_assert((select count(*) from public.qorpera_wake_occurrences where source_kind='machine-checkin')=1,
		'One question at a time');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_cancel_session_run(v_run.session_id,v_run.id);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_drain_machine_checkin_wakes(32);
	perform pg_temp.wake_assert(public.qorpera_machine_checkin_stopped(v_parent.id)
		and (select delivery from public.qorpera_machine_checkins where mark_hours=7)='suppressed',
		'A run whose question a person stopped is asked nothing more');
end $$;

-- 7. Only the platform: no API role reaches the tables, the switch or the functions.
select pg_temp.wake_assert(not exists(select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	cross join unnest(array['public.qorpera_idle_rule_settings','public.qorpera_machine_checkins',
		'public.qorpera_runtime_office_shell_commands']) t(name)
	where has_table_privilege(r.role,t.name,'select') or has_table_privilege(r.role,t.name,'update'))
	and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	cross join unnest(array['public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs)',
		'public.qorpera_ask_busy_office_shells(integer)','public.qorpera_drain_machine_checkin_wakes(integer)',
		'public.qorpera_machine_checkin_run_continuation(public.qorpera_execution_runs,integer)',
		'public.qorpera_machine_checkin_payload(public.qorpera_machine_checkins)',
		'public.qorpera_machine_checkin_wake_ancestry(public.qorpera_wake_occurrences)',
		'public.qorpera_machine_checkin_stopped(uuid)','public.qorpera_machine_checkin_mark(double precision)',
		'public.qorpera_office_shell_command_run(public.qorpera_runtime_offices,public.qorpera_runtime_office_screens,jsonb,boolean)']) f(name)
	where has_function_privilege(r.role,f.name,'execute')),'Only the platform reads, writes and runs these');

rollback;
