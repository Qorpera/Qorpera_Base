-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930201000: the weekly check-in for always-on machines under one idle rule for every machine (the 2026-10-03
-- amendment, item 6), on a folder-v2 company (folder-v2 only, the founder's decision of 3 October). 648's committed
-- fixture with a machine node and executor as 989 makes them: Ada's run started the always-on machine m-999, placed on
-- node A and running in boot b1. Covered:
-- 1. Under a week nothing is asked.
-- 2. At a week Ada is asked once, in the conversation that started the machine, busy or not; the question waits while
--    that run runs.
-- 3. At two weeks Ada is asked again from the same start, and the week-one question no longer stands.
-- 4. After a late drain Ada is asked once, for the latest week passed, never for each week missed.
-- 5. A move to another node keeps the count.
-- 6. A stop leaves the question standing no more, and a new start restarts the count.
-- 7. Who is not asked: a machine a member started (no agent starter), an archived starter, a task machine, a company not
--    on folder-v2.
-- 8. Delivery by the folder drain's step, once the parent ended; a question no longer standing is suppressed.
-- 9. Bounds, the kind, privileges and markers. The fixture is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Always-on check-in: %', p_message; end if; end
$$;
create function pg_temp.refused(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % (%), got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;

-- A machine node and its executor, as 873 makes them: the node, its inventory, a fresh ready observation, its machine
-- provider (named as the node) and the executor.
create function pg_temp.observe(p_node uuid, p_hash text) returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context(p_node);
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_hash,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
create function pg_temp.node(p_node uuid, p_hash text, p_label text, p_owner text) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId',p_node,'machineIdSha256',p_hash,'label',p_label,'cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_hash,
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe(p_node, p_hash);
	perform public.qorpera_enroll_runtime_node_provider(p_node,p_hash,'machine',p_label,repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor(p_owner,p_hash,true,jsonb_build_object('providerId',p_label,
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;
select pg_temp.node('99900000-0000-4000-8000-000000000410', repeat('9a', 32), 'machine-999a', 'mx-999a');

-- Ada's always-on machine, started by Ada's leased run in the conversation with the member, and given room on node A.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('99900000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-999',
	'Serve the docs', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'always-on', 'running', clock_timestamp(),
	clock_timestamp());
select pg_temp.observe('99900000-0000-4000-8000-000000000410', repeat('9a', 32));
select public.qorpera_admit_executor_machines('mx-999a', repeat('9a', 32)) \g /dev/null

create function pg_temp.run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = '99900000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.placement() returns public.qorpera_company_machine_placements language sql as $$
	select * from public.qorpera_company_machine_placements where machine_id = '99900000-0000-4000-8000-0000000000a1' and removed_at is null
	order by created_at desc limit 1
$$;
-- As if p_by passed: the machine's start and its questions' starts move back by p_by.
create function pg_temp.age(p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machines set wanted_at = wanted_at - p_by where id = '99900000-0000-4000-8000-0000000000a1';
	update public.qorpera_machine_checkins set since = since - p_by
	where machine_kind = 'always-on' and subject_id = '99900000-0000-4000-8000-0000000000a1';
	set local session_replication_role = origin;
end $$;
create function pg_temp.ask() returns integer language sql as $$
	select public.qorpera_ask_always_on_company_machines('64800000-0000-4000-8000-000000000020', 32)
$$;
create function pg_temp.due() returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_due(null, 100)
$$;
create function pg_temp.asked_again() returns boolean language plpgsql as $$
begin
	delete from public.qorpera_machine_checkins;
	return pg_temp.ask() > 0;
end $$;
-- The machine's latest question for a mark.
create function pg_temp.question(p_mark integer) returns public.qorpera_machine_checkins language sql as $$
	select * from public.qorpera_machine_checkins where machine_kind = 'always-on' and subject_id = '99900000-0000-4000-8000-0000000000a1'
		and mark_hours = p_mark
	order by created_at desc limit 1
$$;

select pg_temp.check((pg_temp.placement()).owner = 'mx-999a'
	and public.qorpera_company_machine_placement_reserved((pg_temp.placement()).id), 'the machine has room on node A');
select pg_temp.check((select public.qorpera_mark_company_machine_running(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256, '99900000-0000-4000-8000-0000000000b1')::jsonb ->> 'state' from pg_temp.placement() p) = 'running',
	'the machine runs in boot b1');
select pg_temp.check((pg_temp.machine()).started_conversation_run_id = (pg_temp.run()).id
	and (pg_temp.machine()).started_by_staff_agent_id = (pg_temp.run()).staff_agent_id, 'Ada''s run started it');

-- 1. Under a week nothing is asked.
select pg_temp.check(pg_temp.ask() = 0 and pg_temp.due() -> 'items' = '[]'::jsonb, 'just started: nothing is due or asked');
select pg_temp.age('167 hours');
select pg_temp.check(pg_temp.ask() = 0 and pg_temp.due() -> 'items' = '[]'::jsonb, 'at 167 hours: nothing is due or asked');

-- 2. At a week the company is due, and Ada is asked once, in the conversation that started the machine. The machine
--    was never found busy: it is asked about all the same.
select pg_temp.age('61 minutes');
select pg_temp.check(pg_temp.due() = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('environment_id',
	'64800000-0000-4000-8000-000000000020')), 'has_more', false, 'next_after_environment_id', null),
	'the company with an always-on machine wanted for a week is due: ' || pg_temp.due()::text);
select pg_temp.check(pg_temp.ask() = 1, 'a week since Ada started it, Ada is asked');
select pg_temp.check(pg_temp.ask() = 0, 'and only once per week');
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb,
	'asked, and while the run it goes to still runs, the company is not due: the question waits');
select pg_temp.check((select count(*) = 1 and bool_and(q.machine_kind = 'always-on' and q.subject_id = (pg_temp.machine()).id
		and q.parent_run_id = (pg_temp.run()).id and q.staff_agent_id = (pg_temp.run()).staff_agent_id
		and q.profile_id = '64800000-0000-4000-8000-000000000010' and q.environment_id = '64800000-0000-4000-8000-000000000020'
		and q.mark_hours = 168 and q.since = (pg_temp.machine()).wanted_at and q.delivery = 'waiting'
		and q.body = jsonb_build_object('machine', 'm-999', 'weeks', 1))
	from public.qorpera_machine_checkins q),
	'the question names the machine and its weeks, in the conversation that started it: '
		|| (select jsonb_agg(to_jsonb(q)) from public.qorpera_machine_checkins q)::text);
select pg_temp.check((pg_temp.machine()).busy_at is null and public.qorpera_machine_checkin_current(pg_temp.question(168)),
	'the question stands, busy or not');

-- 3. At two weeks Ada is asked again, from the same start; the week-one question no longer stands.
select pg_temp.age('1 week');
select pg_temp.check(pg_temp.ask() = 1, 'at two weeks Ada is asked again');
select pg_temp.check((pg_temp.question(336)).since = (pg_temp.question(168)).since
	and (pg_temp.question(336)).body = jsonb_build_object('machine', 'm-999', 'weeks', 2), 'from the same start, for week two');
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(168))
	and public.qorpera_machine_checkin_current(pg_temp.question(336)), 'the week-one question no longer stands; the latest does');

-- 4. A late drain: three more weeks pass unasked. Ada is asked once, for week five, never for weeks three and four.
begin;
select pg_temp.age('3 weeks');
select pg_temp.check(pg_temp.ask() = 1 and pg_temp.ask() = 0, 'three weeks late, Ada is asked once');
select pg_temp.check((select array_agg(q.mark_hours order by q.mark_hours) from public.qorpera_machine_checkins q) = array[168, 336, 840]
	and (pg_temp.question(840)).body = jsonb_build_object('machine', 'm-999', 'weeks', 5)
	and (pg_temp.question(840)).since = (pg_temp.question(168)).since,
	'for the latest week passed only: ' || (select jsonb_agg(q.mark_hours) from public.qorpera_machine_checkins q)::text);
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(336))
	and public.qorpera_machine_checkin_current(pg_temp.question(840)), 'and only that question stands');
select pg_temp.check(pg_temp.asked_again(), 'never asked before, five weeks on, Ada is asked');
select pg_temp.check((select array_agg(q.mark_hours) from public.qorpera_machine_checkins q) = array[840],
	'one question, for week five: ' || (select jsonb_agg(q.mark_hours) from public.qorpera_machine_checkins q)::text);
rollback;

-- 5. A move to another node keeps the count. Node A is gone for good: its executor is disabled and given up, and node
--    B's executor admits the machine there.
begin;
do $$
declare v_wanted timestamptz := (pg_temp.machine()).wanted_at; v_since timestamptz := (pg_temp.question(336)).since;
begin
	perform pg_temp.node('99900000-0000-4000-8000-000000000420', repeat('9b', 32), 'machine-999b', 'mx-999b');
	perform public.qorpera_configure_machine_executor('mx-999a', repeat('9a', 32), false,
		(select executor.policy from public.qorpera_machine_executors executor where executor.owner = 'mx-999a'), 322122547200);
	if public.qorpera_abandon_machine_executor('mx-999a', repeat('9a', 32)) <> 1 or (pg_temp.placement()).id is not null then
		raise exception 'Always-on check-in: node A''s placement is given up'; end if;
	perform pg_temp.observe('99900000-0000-4000-8000-000000000420', repeat('9b', 32));
	perform public.qorpera_admit_executor_machines('mx-999b', repeat('9b', 32));
	if (pg_temp.placement()).owner is distinct from 'mx-999b' then
		raise exception 'Always-on check-in: the machine moves to node B: %', to_jsonb(pg_temp.placement()); end if;
	if (pg_temp.machine()).wanted_at is distinct from v_wanted then
		raise exception 'Always-on check-in: a move keeps the machine''s start'; end if;
	if not public.qorpera_machine_checkin_current(pg_temp.question(336)) then
		raise exception 'Always-on check-in: a move leaves the question standing'; end if;
	-- Asked afresh, in its own statement: the check below reads what it asked.
	if not pg_temp.asked_again() then raise exception 'Always-on check-in: after a move, Ada is asked'; end if;
	if (select array_agg(q.mark_hours) from public.qorpera_machine_checkins q) is distinct from array[336]
		or (pg_temp.question(336)).since is distinct from v_since then
		raise exception 'Always-on check-in: after a move, the count goes on from the same start'; end if;
end $$;
rollback;

-- 6. A stop, and a new start, restart the count.
begin;
create temp table always_on_start on commit drop as select (pg_temp.machine()).wanted_at, pg_temp.question(336) as question;
select public.qorpera_set_company_machine_desired(pg_temp.machine(), 'stopped', 'agent') \g /dev/null
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(336)),
	'an agent''s stop leaves the question standing no more');
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb, 'a stopped machine is not asked about');
-- Ada starts it again, as 20260928259050's machine_start starts a machine that is not running.
update public.qorpera_company_machines set desired_state = 'running', desired_by = 'agent', wanted_at = clock_timestamp(),
	updated_at = clock_timestamp()
where id = '99900000-0000-4000-8000-0000000000a1';
select pg_temp.check((select (s.question).mark_hours = 336 from always_on_start s), 'the old start''s question is kept');
select pg_temp.check(not public.qorpera_machine_checkin_current((select s.question from always_on_start s)),
	'started again by the same agent: the old start''s question stands no more');
select pg_temp.check(not pg_temp.asked_again(), 'started again, the count starts again: nothing is asked under a week');
select pg_temp.age('1 week 1 minute');
select pg_temp.check(pg_temp.asked_again(), 'a week after the new start, Ada is asked');
select pg_temp.check((select count(*) = 1 and bool_and(q.mark_hours = 168 and q.since = (pg_temp.machine()).wanted_at
		and q.since > (select s.wanted_at from always_on_start s) + interval '1 week' and q.body ->> 'weeks' = '1')
	from public.qorpera_machine_checkins q), 'for week one, counted from the new start');
rollback;

-- 7. Who is not asked.
-- A member stops it and starts it again: no agent started it last, and nobody is asked.
begin;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}', true);
select public.qorpera_member_manage_company_machine('64800000-0000-4000-8000-000000000010', '99900000-0000-4000-8000-0000000000a1', 'stop')
\g /dev/null
select public.qorpera_member_manage_company_machine('64800000-0000-4000-8000-000000000010', '99900000-0000-4000-8000-0000000000a1', 'start')
\g /dev/null
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.check((pg_temp.machine()).desired_state = 'running' and (pg_temp.machine()).desired_by = 'member'
	and (pg_temp.machine()).wanted_at > clock_timestamp() - interval '1 minute', 'the member started it again');
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(336)),
	'a member''s start leaves the question standing no more');
select pg_temp.age('2 weeks');
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb,
	'a machine a member started: nobody is asked, however long');
rollback;
-- The agent that started it is no longer active: nobody is asked.
begin;
update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb, 'an archived starter: nobody is asked');
rollback;
begin;
update public.qorpera_company_machines set lifetime = 'task' where id = '99900000-0000-4000-8000-0000000000a1';
select pg_temp.check(not public.qorpera_machine_checkin_current(pg_temp.question(336)) and not pg_temp.asked_again(),
	'a task machine has no weekly check-in');
rollback;
begin;
set local session_replication_role = replica;
delete from public.qorpera_company_files where environment_id = '64800000-0000-4000-8000-000000000020';
set local session_replication_role = origin;
select pg_temp.check(not pg_temp.asked_again() and pg_temp.due() -> 'items' = '[]'::jsonb,
	'a company not on the folder-v2 core is not asked about, nor due');
rollback;

-- 8. Delivery, by the drain's step (as in 872). The company's login may pay for autonomous work: a check-in is paid as
--    the work that started it.
set session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connection_versions set allow_autonomous = true, authorization_state = 'active'
where connection_id = '64800000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
-- Ada's job ends, with the columns its state requires.
create function pg_temp.job_completed() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', lease_token_sha256 = null, lease_expires_at = null, result = '{}'::jsonb,
		finished_at = clock_timestamp()
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
end $$;
create function pg_temp.step() returns jsonb language sql as $$
	select public.qorpera_folder_machine_checkins_company('64800000-0000-4000-8000-000000000020', 8)
$$;
-- The parent's check-in wakes, newest first; forget() removes them, as if each had run and ended.
create function pg_temp.wakes() returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin' order by created_at desc, id desc
$$;
create function pg_temp.forget() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_wake_occurrences where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
		and source_kind = 'machine-checkin';
	set local session_replication_role = origin;
end $$;

-- While Ada's run still runs, its questions wait: the company is not due and its step is idle.
select pg_temp.check(pg_temp.due() -> 'items' = '[]'::jsonb and pg_temp.step() ->> 'state' = 'idle'
	and (pg_temp.question(168)).delivery = 'waiting' and (pg_temp.question(336)).delivery = 'waiting',
	'a running parent''s questions wait');
-- Once its job ended: due, and one wake carries the question that still stands into its conversation; the one a later
-- week replaced is suppressed.
select pg_temp.job_completed();
do $$
declare v_answer jsonb; v_wake public.qorpera_wake_occurrences;
begin
	if pg_temp.due() -> 'items' = '[]'::jsonb then raise exception 'Delivery: an ended parent''s company is due'; end if;
	v_answer := pg_temp.step();
	select * into v_wake from pg_temp.wakes() limit 1;
	if v_wake.id is null or v_answer ->> 'state' <> 'done' or (v_answer ->> 'delivered')::integer <> 1
		or (v_answer ->> 'suppressed')::integer <> 1 or (v_answer ->> 'asked')::integer <> 0
		or v_wake.status <> 'queued' or v_wake.wake_kind <> 'agent' or v_wake.trigger_id <> 'machine-checkin'
		or v_wake.source_id <> (pg_temp.question(336)).id or v_wake.session_id <> (pg_temp.run()).session_id
		or v_wake.staff_agent_id <> (pg_temp.run()).staff_agent_id or v_wake.requested_by_user_id <> (pg_temp.run()).requested_by_user_id
		or v_wake.payload ->> 'schema' <> 'qorpera.machine-checkin/v1' or jsonb_array_length(v_wake.payload -> 'checkins') <> 1
		or (select array_agg(k order by k) from jsonb_object_keys(v_wake.payload #> '{checkins,0}') k)
			<> array['askedAt', 'checkinId', 'machine', 'machineKind', 'since', 'weeks']
		or v_wake.payload #>> '{checkins,0,checkinId}' <> (pg_temp.question(336)).id::text
		or v_wake.payload #>> '{checkins,0,machineKind}' <> 'always-on'
		or v_wake.payload #>> '{checkins,0,machine}' <> 'm-999' or v_wake.payload #> '{checkins,0,weeks}' <> '2'::jsonb
		or (v_wake.payload ->> 'stillWaiting')::integer <> 0 or not public.qorpera_folder_wake_authorized(v_wake) then
		raise exception 'Delivery: one authorized wake with the standing question: % %', v_answer, to_jsonb(v_wake); end if;
	if (pg_temp.question(336)).delivery <> 'delivered' or (pg_temp.question(336)).occurrence_id <> v_wake.id
		or (pg_temp.question(168)).delivery <> 'suppressed' then
		raise exception 'Delivery: delivered by that wake, the replaced one suppressed'; end if;
	-- One continuation at a time: while it is queued, the parent is not asked through another.
	if pg_temp.step() ->> 'state' <> 'idle' then raise exception 'Delivery: one continuation per parent at a time'; end if;
end $$;
-- At three weeks the step asks, and the question waits behind the queued continuation. Once that ran, Ada has stopped
-- the machine: the question no longer stands and is suppressed.
select pg_temp.age('1 week');
do $$
declare v_answer jsonb := pg_temp.step();
begin
	if (v_answer ->> 'asked')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0
		or (pg_temp.question(504)).delivery is distinct from 'waiting' then
		raise exception 'Delivery: the step asks, and the new question waits: %', v_answer; end if;
	perform pg_temp.forget();
	perform public.qorpera_set_company_machine_desired(pg_temp.machine(), 'stopped', 'agent');
	v_answer := pg_temp.step();
	if (v_answer ->> 'suppressed')::integer <> 1 or (v_answer ->> 'delivered')::integer <> 0
		or (pg_temp.question(504)).delivery is distinct from 'suppressed' or exists (select 1 from pg_temp.wakes()) then
		raise exception 'Delivery: a question for a machine stopped since is suppressed: %', v_answer; end if;
end $$;

-- 9. Bounds, the kind, privileges and markers.
select pg_temp.refused(format('select public.qorpera_ask_always_on_company_machines(%L, %s)', bad.environment_id, bad.bound), '22023',
	'Machine check-in bound is invalid')
from (values ('64800000-0000-4000-8000-000000000020', '0'), ('64800000-0000-4000-8000-000000000020', '257'),
	('64800000-0000-4000-8000-000000000020', 'null'), (null, '32')) bad(environment_id, bound);
select pg_temp.refused($sql$insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id,
	machine_kind, subject_id, since, mark_hours, body) values ('64800000-0000-4000-8000-000000000010',
	'64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', 'printer',
	'99900000-0000-4000-8000-0000000000a1', clock_timestamp(), 168, '{}')$sql$, '23514');
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_company_machine_always_on_since(public.qorpera_company_machines)',
		'public.qorpera_company_machine_always_on_checkins_unasked(uuid)', 'public.qorpera_ask_always_on_company_machines(uuid,integer)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute')), 'only the platform runs the new functions');
select pg_temp.check(not exists (select 1 from unnest(array[
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)',
		'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'public.qorpera_folder_machine_checkins_company(uuid,integer)',
		'public.qorpera_company_machine_always_on_since(public.qorpera_company_machines)',
		'public.qorpera_company_machine_always_on_checkins_unasked(uuid)', 'public.qorpera_ask_always_on_company_machines(uuid,integer)']) f(name)
	where position('20260930201000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or patched function names this migration');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the machine nodes and executors, then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_table record; v_node uuid;
begin
	delete from public.qorpera_company_machine_container_stops where machine_id = '99900000-0000-4000-8000-0000000000a1';
	foreach v_node in array array['99900000-0000-4000-8000-000000000410', '99900000-0000-4000-8000-000000000420']::uuid[] loop
		for v_table in select c.table_name from information_schema.columns c
			join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
			where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
			execute format('delete from public.%I where node_id = $1', v_table.table_name) using v_node;
		end loop;
	end loop;
	delete from public.qorpera_runtime_nodes where id in ('99900000-0000-4000-8000-000000000410', '99900000-0000-4000-8000-000000000420');
	delete from public.qorpera_machine_executors where owner in ('mx-999a', 'mx-999b');
end $$;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_machine_checkins where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_runtime_nodes where id in ('99900000-0000-4000-8000-000000000410',
			'99900000-0000-4000-8000-000000000420'))
		or exists (select 1 from public.qorpera_machine_executors where owner in ('mx-999a', 'mx-999b'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
