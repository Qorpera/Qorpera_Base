-- @fixture 628_runtime_company_machines.test.sql until "-- 8. Stop: the agent's wish, carried out under custody; the room is given back and the next in line gets it."
-- Computer hours, build step 6b part 3 (20260929730000): agents' machines at zero.
--   * At zero no machine starts or wakes: a new one waits, unplaced, for computer hours, and so does
--     an asleep one, on its own node with its disk. Neither takes a place in line.
--   * Within the hour after the company ran out, machines keep running.
--   * Once the hour is over every machine sleeps, the always-on one too, still wanted running: its
--     room is given back, its disk kept, its open commands end as lost, and no run is told it stopped.
--   * No stopped machine's disk is given up for a machine of a company at zero.
--   * Once hours are added the admit line wakes it on its own node, before the next sweep.
-- At this point of 628: build-a (task) runs on mx-a, big (always-on) holds its room and is starting,
-- and wait waits in line, unplaced, for room.
select pg_temp.path_claims('service_role');
select pg_temp.observe_a();

-- The admit line skips companies at zero in both of its queries.
select pg_temp.wake_assert((length(d) - length(replace(d, 'and not public.qorpera_company_at_zero(machine.profile_id, clock_timestamp())', '')))
		/ length('and not public.qorpera_company_at_zero(machine.profile_id, clock_timestamp())') = 2,
	'The admit line and the disk give-up skip companies at zero')
from pg_get_functiondef('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure) d;

-- 1. Switched off: an always-on machine never sleeps on its own; wait waits for room.
select pg_temp.wake_assert(pg_temp.custody('big', 'stop') ->> 'reason' = 'MACHINE_IN_USE'
	and not (pg_temp.listed('mx-a', repeat('c', 64), 'big') ->> 'sleepDue')::boolean, 'Switched off: big keeps running');
select pg_temp.wake_assert(public.qorpera_company_machine_view(pg_temp.machine('wait')) ->> 'waitingFor' = 'NODE_CAPACITY_EXHAUSTED',
	'Switched off: wait waits for room');

-- 2. The company uses more than its free hours, live, with the zero rule on; the sweep records it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');

do $$
declare v_view jsonb := public.qorpera_company_machine_view(pg_temp.machine('wait')); v_small jsonb;
	v_build uuid := (pg_temp.placement('build-a')).id;
begin
	perform pg_temp.wake_assert(v_view ->> 'state' = 'waiting' and v_view ->> 'waitingFor' = 'COMPUTER_HOURS_EXHAUSTED'
		and v_view -> 'queuePosition' = 'null', 'At zero wait waits for hours, with no place in line: ' || v_view::text);
	-- A machine small enough for the room left is not started: it waits, unplaced, for hours.
	perform pg_temp.observe_a();
	v_small := pg_temp.start('m-zero-small', '{"name":"small","purpose":"At zero","cpus":1,"memoryGiB":2,"diskGiB":10,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_small #>> '{machine,state}' = 'waiting' and v_small #>> '{machine,waitingFor}' = 'COMPUTER_HOURS_EXHAUSTED'
		and pg_temp.placement('small') is null, 'No new machine at zero: ' || v_small::text);
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-a', repeat('c', 64)) = '[]'::jsonb
		and pg_temp.placement('small') is null, 'The admit line starts nothing at zero');
	-- No stopped machine's disk is given up for a machine of a company at zero: build-a, stopped by its agent,
	-- sleeps with 40 GiB; a new 200 GiB machine would need it (160 GiB free). Rolled back afterwards.
	begin
		perform public.qorpera_native_machine_manage(pg_temp.binding(), '{"action":"stop","machine":"build-a"}');
		perform pg_temp.custody('build-a', 'stop');
		perform pg_temp.suspend('build-a');
		perform pg_temp.start('m-zero-deep', '{"name":"deep","purpose":"Needs disk","cpus":1,"memoryGiB":2,"diskGiB":200,"lifetime":"task"}');
		perform public.qorpera_admit_executor_machines('mx-a', repeat('c', 64));
		perform pg_temp.wake_assert((select retired_at is null from public.qorpera_company_machine_placements where id = v_build),
			'No disk is given up for a machine of a company at zero');
		raise sqlstate 'P0T01';
	exception when sqlstate 'P0T01' then null;
	end;
	-- Within the hour running machines keep running.
	perform pg_temp.wake_assert(pg_temp.custody('big', 'stop') ->> 'reason' = 'MACHINE_IN_USE'
		and not (pg_temp.listed('mx-a', repeat('c', 64), 'big') ->> 'sleepDue')::boolean
		and not (pg_temp.listed('mx-a', repeat('c', 64), 'build-a') ->> 'sleepDue')::boolean
		and pg_temp.custody('build-a', 'run') ->> 'intent' = 'run', 'Within the hour machines keep running');
	-- Running work: a command whose end its run asked to hear about.
	perform pg_temp.run('30000000-0000-4000-8000-0000000007a1', 'zero-notify', repeat('b', 64), 'build-a', './long-job.sh', true);
end
$$;

-- 3. The hour is over: every machine sleeps, still wanted running, keeping its disk.
update public.qorpera_computer_hour_zero_state set ran_out_at = ran_out_at - interval '61 minutes'
where profile_id = '30000000-0000-4000-8000-000000000010';
do $$
declare v_big uuid := (pg_temp.placement('big')).id; v_build uuid := (pg_temp.placement('build-a')).id; v_stop jsonb;
begin
	perform pg_temp.observe_a();
	perform pg_temp.wake_assert((pg_temp.listed('mx-a', repeat('c', 64), 'big') ->> 'sleepDue')::boolean
		and (pg_temp.listed('mx-a', repeat('c', 64), 'build-a') ->> 'sleepDue')::boolean, 'After the hour every machine is due to sleep');
	v_stop := pg_temp.custody('big', 'stop');
	perform pg_temp.wake_assert(v_stop ->> 'intent' = 'stop' and (pg_temp.machine('big')).desired_state = 'running',
		'The always-on machine may sleep, still wanted running: ' || v_stop::text);
	v_stop := pg_temp.suspend('big');
	perform pg_temp.wake_assert(v_stop ->> 'state' = 'suspended' and (pg_temp.placement('big')).id = v_big,
		'It gives its room back and keeps its placement and disk: ' || v_stop::text);
	perform pg_temp.wake_assert(pg_temp.custody('build-a', 'stop') ->> 'intent' = 'stop'
		and pg_temp.suspend('build-a') ->> 'state' = 'suspended' and (pg_temp.placement('build-a')).id = v_build,
		'The task machine sleeps too, though a command runs on it');
	perform pg_temp.wake_assert((select state = 'lost' and ended_at is not null from public.qorpera_company_machine_commands
			where id = '30000000-0000-4000-8000-0000000007a1')
		and (public.qorpera_company_machine_view(pg_temp.machine('build-a')) ->> 'commandsRunning')::int = 0
		and exists (select 1 from public.qorpera_company_machine_events where kind = 'command'
			and machine_id = (pg_temp.machine('build-a')).id),
		'Its open command ends as lost, and the run that asked is told when it may run again');
	perform pg_temp.wake_assert(public.qorpera_company_machine_view(pg_temp.machine('big')) ->> 'state' = 'waiting'
		and public.qorpera_company_machine_view(pg_temp.machine('big')) ->> 'waitingFor' = 'COMPUTER_HOURS_EXHAUSTED'
		and not exists (select 1 from public.qorpera_company_machine_events where kind = 'stopped'),
		'Asleep, it waits for hours; no run is told it stopped');
	-- An agent wakes it at zero: it is not moved and waits for hours on its own node.
	perform pg_temp.wake_assert(public.qorpera_admit_company_machine((pg_temp.machine('big')).id) ->> 'reason' = 'COMPUTER_HOURS_EXHAUSTED',
		'An asleep machine is not woken or moved at zero');
	perform pg_temp.start('m-zero-wake-big', '{"machine":"big"}');
	perform pg_temp.wake_assert(public.qorpera_company_machine_view(pg_temp.machine('big')) ->> 'waitingFor' = 'COMPUTER_HOURS_EXHAUSTED'
		and (pg_temp.placement('big')).id = v_big and (pg_temp.placement('big')).owner = 'mx-a', 'A wake at zero waits on its own node');
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-a', repeat('c', 64)) = '[]'::jsonb,
		'The admit line wakes nothing at zero');
end
$$;

-- 4. Hours are added: the admit line wakes the machines on their own node, before the next sweep.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
do $$
declare v_build uuid := (pg_temp.placement('build-a')).id; v_admitted jsonb;
begin
	perform pg_temp.observe_a();
	-- build-a has waited longest.
	v_admitted := public.qorpera_admit_executor_machines('mx-a', repeat('c', 64));
	perform pg_temp.wake_assert(v_admitted = jsonb_build_array((pg_temp.machine('build-a')).id)
		and (pg_temp.placement('build-a')).id = v_build and public.qorpera_company_machine_state(pg_temp.machine('build-a')) = 'starting',
		'Hours added: build-a wakes on its own disk: ' || coalesce(v_admitted::text, 'null'));
	perform pg_temp.wake_assert(not (pg_temp.listed('mx-a', repeat('c', 64), 'build-a') ->> 'sleepDue')::boolean
		and public.qorpera_company_machine_view(pg_temp.machine('wait')) ->> 'waitingFor' = 'NODE_CAPACITY_EXHAUSTED',
		'With hours, nothing is due to sleep and a waiting machine waits for room again');
end
$$;
rollback;
