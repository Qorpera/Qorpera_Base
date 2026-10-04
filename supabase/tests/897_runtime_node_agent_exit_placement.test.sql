-- @fixture 628_runtime_company_machines.test.sql until "-- 4. Full: the next machine waits in line, unplaced, with its place and its reason."
-- Agent exit E2d part 2 (20260930052100): a node whose exit is not healthy takes no new agent road machine.
--   * Agents' machines: no new one is placed there (it waits as for room), a sleeping one does not wake there (refused
--     NODE_AGENT_EXIT_UNHEALTHY) and moves to a node whose exit is healthy; one already reserved keeps going, and one
--     tied to its repository's node wakes there. A node that never reported its exit takes nothing. An observer that
--     stopped is not an exit that is down: the node's observation is checked first, and its grace keeps a sleeping
--     machine on its node.
--   * Company Computers: no new one there (the node is not a candidate, and its reservation is refused); a sleeping one
--     wakes on its node (it cannot move).
--   * Coding machines are never refused (they cannot move); only the executor pick's fresh branch asks for the exit.
-- At this point of 628: node A (machine-a, executor mx-a) holds build-a, placed and starting.
select pg_temp.path_claims('service_role');
-- The real exit health from here on: the test databases' shim (supabase/tests/bootstrap.sql) stays out of this transaction.
select set_config('qorpera_test.agent_exit_real', 'on', true);

-- A node's exit as its observer last posted it: healthy and current, or not.
create function pg_temp.agent_exit(p_node uuid, p_healthy boolean) returns void language sql as $$
	insert into public.qorpera_runtime_node_agent_exit(node_id, observation_id, observed_at, checked_at, healthy, problem_count)
	values (p_node, extensions.gen_random_uuid(), clock_timestamp(), clock_timestamp(), p_healthy, case when p_healthy then 0 else 2 end)
	on conflict (node_id) do update set observation_id = excluded.observation_id, observed_at = excluded.observed_at,
		checked_at = excluded.checked_at, healthy = excluded.healthy, problem_count = excluded.problem_count
$$;
create function pg_temp.synthetic(p_sql text) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	execute p_sql;
	perform set_config('session_replication_role', 'origin', true);
end $$;
create function pg_temp.reserve(p_allocation uuid, p_kind text, p_provider text, p_policy text, p_instance text) returns jsonb
language sql as $$
	select public.qorpera_reserve_runtime_node_machine(p_allocation, p_kind, p_provider, p_policy, p_instance, repeat('c', 64),
		4000, 8589934592)
$$;
create function pg_temp.office_eligible(p_kind text) returns boolean language sql as $$
	select (c ->> 'eligible')::boolean from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates(p_kind)) c
	where c ->> 'nodeId' = '30000000-0000-4000-8000-000000000410'
$$;

-- 1. Node A's exit is down: a new agent's machine gets no place and waits as for room; build-a, already reserved there,
--    keeps going.
select pg_temp.agent_exit('30000000-0000-4000-8000-000000000410', false);
do $$
declare v_new jsonb;
begin
	perform pg_temp.observe_a();
	perform pg_temp.wake_assert(not public.qorpera_runtime_node_agent_exit_ready('30000000-0000-4000-8000-000000000410')
		and not exists (select 1 from public.qorpera_company_machine_candidates(1000, 1073741824, 10737418240)),
		'No node takes a new agent''s machine');
	v_new := pg_temp.start('m-exit-new', '{"name":"exit-new","purpose":"Needs the internet","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}');
	perform pg_temp.wake_assert(v_new #>> '{machine,state}' = 'waiting' and v_new #>> '{machine,waitingFor}' = 'NODE_CAPACITY_EXHAUSTED'
		and pg_temp.placement('exit-new') is null, 'A new machine waits, unplaced, as for room: ' || v_new::text);
	perform pg_temp.wake_assert(pg_temp.custody('build-a', 'run') ->> 'intent' = 'run', 'A machine already reserved there keeps going');
end $$;

-- 2. Asleep, an agent's machine does not wake on a node whose exit is down, and node A's own executor admits nothing.
do $$
declare v_stop jsonb; v_place public.qorpera_company_machine_placements := pg_temp.placement('build-a');
begin
	perform public.qorpera_native_machine_manage(pg_temp.binding(), '{"action":"stop","machine":"build-a"}');
	perform pg_temp.custody('build-a', 'stop');
	v_stop := pg_temp.suspend('build-a');
	perform pg_temp.wake_assert(v_stop ->> 'state' = 'suspended', 'build-a sleeps: ' || v_stop::text);
	perform pg_temp.observe_a();
	perform pg_temp.start('m-exit-wake', '{"machine":"build-a"}');
	perform pg_temp.wake_assert(public.qorpera_company_machine_state(pg_temp.machine('build-a')) = 'waiting'
		and pg_temp.custody('build-a', 'run') ->> 'reason' = 'NODE_AGENT_EXIT_UNHEALTHY',
		'A woken machine waits, refused for its node''s exit');
	-- The node reservation itself keeps its refusal on the demand.
	perform pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine(v_place.id, 'machine', 'machine-fixture', repeat('f',64),
			v_place.instance_sha256, repeat('c',64), 2000, 4294967296) ->> 'reason' = 'NODE_AGENT_EXIT_UNHEALTHY'
		and (select last_refusal from public.qorpera_runtime_node_demands where allocation_id = v_place.id) = 'NODE_AGENT_EXIT_UNHEALTHY',
		'The reservation is refused, with the reason on the demand');
	-- Tied to its repository's node, it wakes there (without internet while the exit is down). Rolled back.
	begin
		perform pg_temp.synthetic(format('update public.qorpera_company_machines set repository_worker_id = %L where id = %L',
			'89700000-0000-4000-8000-0000000000d1', (pg_temp.machine('build-a')).id));
		perform pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine(v_place.id, 'machine', 'machine-fixture',
			repeat('f',64), v_place.instance_sha256, repeat('c',64), 2000, 4294967296) ->> 'state' = 'reserved',
			'A repository-tied machine wakes on its node');
		raise sqlstate 'P0T97';
	exception when sqlstate 'P0T97' then null;
	end;
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-a', repeat('c', 64)) = '[]'::jsonb
		and (pg_temp.placement('build-a')).owner = 'mx-a', 'Node A admits nothing while its exit is down');
end $$;

-- 3. Node B arrives. Until its exit reports healthy it takes nothing; then the new machine is placed there and the
--    sleeping one moves there (fresh, its old placement retired).
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-fixture-b','providerPolicySha256',repeat('e',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
	v_old public.qorpera_company_machine_placements := pg_temp.placement('build-a'); v_admitted jsonb;
begin
	perform pg_temp.node('30000000-0000-4000-8000-000000000420', repeat('d',64), 'machine-b', 16000, 68719476736);
	perform public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000420', repeat('d',64), 'machine',
		'machine-fixture-b', repeat('e',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-b', repeat('d',64), true, v_policy, 322122547200);
	perform pg_temp.observe_a();
	perform pg_temp.wake_assert(public.qorpera_admit_executor_machines('mx-b', repeat('d',64)) = '[]'::jsonb
		and pg_temp.placement('exit-new') is null, 'A node that never reported its exit takes nothing');
	perform pg_temp.agent_exit('30000000-0000-4000-8000-000000000420', true);
	v_admitted := public.qorpera_admit_executor_machines('mx-b', repeat('d',64))
		|| public.qorpera_admit_executor_machines('mx-b', repeat('d',64));
	perform pg_temp.wake_assert(jsonb_array_length(v_admitted) = 2
		and v_admitted @> jsonb_build_array((pg_temp.machine('exit-new')).id, (pg_temp.machine('build-a')).id)
		and (pg_temp.placement('exit-new')).owner = 'mx-b' and (pg_temp.placement('build-a')).owner = 'mx-b'
		and (pg_temp.placement('build-a')).id <> v_old.id
		and (select retired_at is not null from public.qorpera_company_machine_placements where id = v_old.id)
		and exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = (pg_temp.placement('build-a')).id
			and reserved_at is not null and node_id = '30000000-0000-4000-8000-000000000420'),
		'Both are placed on node B, whose exit is healthy: ' || v_admitted::text);
end $$;

-- 4. An observer that stops is not an exit that is down. Node B's observation and its exit answer both go stale while
--    exit-new sleeps there, and node A (healthy again) could take it: its wake reads NODE_OBSERVATION_UNAVAILABLE, and
--    the grace for a node that may only be looking away keeps it on node B.
do $$
declare v_stop jsonb;
begin
	perform pg_temp.agent_exit('30000000-0000-4000-8000-000000000410', true);
	perform pg_temp.observe_a();
	perform public.qorpera_native_machine_manage(pg_temp.binding(), '{"action":"stop","machine":"exit-new"}');
	perform pg_temp.custody('exit-new', 'stop');
	v_stop := pg_temp.suspend('exit-new');
	perform pg_temp.wake_assert(v_stop ->> 'state' = 'suspended', 'exit-new sleeps on node B: ' || v_stop::text);
	update public.qorpera_runtime_node_observations set observed_at = clock_timestamp() - interval '2 minutes'
	where node_id = '30000000-0000-4000-8000-000000000420';
	update public.qorpera_runtime_node_agent_exit set observed_at = clock_timestamp() - interval '2 minutes',
		checked_at = clock_timestamp() - interval '2 minutes'
	where node_id = '30000000-0000-4000-8000-000000000420';
	perform pg_temp.start('m-exit-wake-b', '{"machine":"exit-new"}');
	perform pg_temp.wake_assert(pg_temp.custody('exit-new', 'run') ->> 'reason' = 'NODE_OBSERVATION_UNAVAILABLE'
		and public.qorpera_admit_executor_machines('mx-a', repeat('c', 64)) = '[]'::jsonb
		and (pg_temp.placement('exit-new')).owner = 'mx-b', 'A stopped observer keeps the sleeping machine on its node');
	perform pg_temp.agent_exit('30000000-0000-4000-8000-000000000410', false);
end $$;

-- 5. Coding machines are never refused for their node's exit: a new one and a sleeping one's wake both pass on node A.
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000410', repeat('c',64), 'coding', 'coding-exit',
	repeat('3',64), 4000, 8589934592);
select pg_temp.synthetic($sql$insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_machine_id, provider_adapter,
	instance_sha256) values ('89700000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-000000000010',
	'89700000-0000-4000-8000-0000000000c1', 'coding-exit', repeat('4',64))$sql$);
do $$
begin
	perform pg_temp.observe_a();
	perform pg_temp.wake_assert(not public.qorpera_runtime_node_agent_exit_ready('30000000-0000-4000-8000-000000000410')
		and pg_temp.reserve('89700000-0000-4000-8000-0000000000c1', 'coding', 'coding-exit', repeat('3',64), repeat('4',64))
			->> 'state' = 'reserved', 'A new coding machine starts on a node whose exit is down');
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
	where allocation_id = '89700000-0000-4000-8000-0000000000c1';
	perform pg_temp.wake_assert(pg_temp.reserve('89700000-0000-4000-8000-0000000000c1', 'coding', 'coding-exit', repeat('3',64),
		repeat('4',64)) ->> 'state' = 'reserved', 'A sleeping coding machine wakes there');
end $$;
-- The executor pick asks for the exit in its fresh branch only: a member with a machine, storage or a turn stays.
select pg_temp.wake_assert((length(d) - length(replace(d, 'qorpera_runtime_node_agent_exit_ready', '')))
		/ length('qorpera_runtime_node_agent_exit_ready') = 1
	and position('qorpera_runtime_node_agent_exit_ready(node.id)' in d) > position('from public.qorpera_coding_executors executor' in d),
	'The pick filters only a new member''s machine')
from pg_get_functiondef('public.qorpera_coding_executor_pick(uuid)'::regprocedure) d;

-- 6. Company Computers: node A is no candidate for a new one while its exit is down (for the other kinds it still is),
--    a new one's reservation there is refused, and a sleeping one wakes there.
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000410', repeat('c',64), 'office',
	'89700000-0000-4000-8000-0000000000f1', repeat('9',64), 4000, 8589934592);
select pg_temp.synthetic($sql$insert into public.qorpera_runtime_office_providers(office_id, computer_generation, provider_id,
	policy_sha256, version, preparation_enabled) values ('89700000-0000-4000-8000-0000000000b1', 1,
	'89700000-0000-4000-8000-0000000000f1', repeat('9',64), 1, false)$sql$);
select pg_temp.synthetic($sql$insert into public.qorpera_runtime_machine_allocations(id, profile_id, office_id, computer_generation,
	provider_adapter, instance_sha256) values ('89700000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-000000000010',
	'89700000-0000-4000-8000-0000000000b1', 1, 'lxd', repeat('5',64))$sql$);
do $$
declare v_office jsonb;
begin
	perform pg_temp.observe_a();
	perform pg_temp.wake_assert(pg_temp.office_eligible('office') is false and pg_temp.office_eligible('coding')
		and pg_temp.office_eligible('machine') and not public.qorpera_runtime_office_new_machine_room(),
		'No new Company Computer on node A; the other kinds still see it');
	v_office := pg_temp.reserve('89700000-0000-4000-8000-0000000000a1', 'office', '89700000-0000-4000-8000-0000000000f1',
		repeat('9',64), repeat('5',64));
	perform pg_temp.wake_assert(v_office ->> 'reason' = 'NODE_AGENT_EXIT_UNHEALTHY'
		and (select last_refusal = 'NODE_AGENT_EXIT_UNHEALTHY' and reserved_at is null from public.qorpera_runtime_node_demands
			where allocation_id = '89700000-0000-4000-8000-0000000000a1'), 'A new Company Computer is refused: ' || v_office::text);
	perform pg_temp.agent_exit('30000000-0000-4000-8000-000000000410', true);
	perform pg_temp.wake_assert(pg_temp.office_eligible('office') and public.qorpera_runtime_office_new_machine_room()
		and pg_temp.reserve('89700000-0000-4000-8000-0000000000a1', 'office', '89700000-0000-4000-8000-0000000000f1',
			repeat('9',64), repeat('5',64)) ->> 'state' = 'reserved', 'With the exit healthy again, it starts');
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
	where allocation_id = '89700000-0000-4000-8000-0000000000a1';
	perform pg_temp.agent_exit('30000000-0000-4000-8000-000000000410', false);
	perform pg_temp.wake_assert(pg_temp.reserve('89700000-0000-4000-8000-0000000000a1', 'office', '89700000-0000-4000-8000-0000000000f1',
		repeat('9',64), repeat('5',64)) ->> 'state' = 'reserved', 'A sleeping Company Computer wakes on its node, exit or not');
end $$;

-- 7. A stale answer counts as no exit: the node is ready again only with a current one.
update public.qorpera_runtime_node_agent_exit set healthy = true, problem_count = 0, observed_at = clock_timestamp() - interval '61 seconds',
	checked_at = clock_timestamp() - interval '61 seconds'
where node_id = '30000000-0000-4000-8000-000000000410';
select pg_temp.wake_assert(pg_temp.office_eligible('office') is false
	and not exists (select 1 from public.qorpera_company_machine_candidates(1000, 1073741824, 10737418240, 'mx-a')),
	'A healthy answer over a minute old: no new machine on node A');
rollback;
