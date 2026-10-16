-- @fixture 643_runtime_runs_follow_placement.test.sql until "-- END FAST PLACEMENT FIXTURE"
-- 20260930492000 (launch checklist L18.2/L26.2), on a folder-v2 company: the operator's run query names the node the
-- claim placed the run on. An assignment's physicalNodeId is the node of the placement recorded for its runner's machine
-- when that placement's decision is 'placed'; the run's identity names its newest accepted assignment's node. A refused,
-- deferred or unbound placement, or no machine at all, reads as null, never as a node. Node B's fast host (...b1) takes
-- a post in Bob's thread, as in test 810; the fixture's own run (Alice's) never reserved a machine.
select public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000b1','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000a2','overflow') \g /dev/null
reset role;
-- The operator's view of a run, and one assignment's item in it.
create function pg_temp.p431_view(p_run uuid) returns jsonb language sql as $$
	select public.qorpera_get_runtime_operational_run(p_run,200)
$$;
create function pg_temp.p431_item(p_run uuid,p_assignment uuid) returns jsonb language sql as $$
	select item from jsonb_array_elements(pg_temp.p431_view(p_run) #> '{sections,assignments,items}') item
	where item ->> 'assignmentId' = p_assignment::text
$$;
select set_config('qorpera_test.p431_run',pg_temp.fp_run('92400000-0000-4000-8000-000000000031')::text,true) \g /dev/null
select pg_temp.fp_age(current_setting('qorpera_test.p431_run')::uuid,-30);

-- 1. Node B's fast host claims the run and reserves its machine: the claim turn records the placement on node B.
set local role service_role;
select set_config('qorpera_test.p431_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.p431_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.p431_run'),
	'Node B''s fast host takes the run: ' || current_setting('qorpera_test.p431_claim'));
select set_config('qorpera_test.p431_runner',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.p431_run')::uuid,
	'43100000-0000-4000-8000-0000000000c1','native-b',repeat('1',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine('43100000-0000-4000-8000-0000000000c1','native-b',repeat('7',64),
	current_setting('qorpera_test.p431_run')::uuid,current_setting('qorpera_test.p431_runner')::uuid) ->> 'state' = 'reserved',
	'The fast host reserves the run''s machine');
reset role;
select pg_temp.base_assert((select decision = 'placed' and node_id = '64300000-0000-4000-8000-00000000000b'
		and reason = 'CLAIM_TURN_LEAST_BUSY'
	from public.qorpera_runtime_node_placements where allocation_id = '43100000-0000-4000-8000-0000000000c1'),
	'The claim placed the run on node B');

-- 2. The runner is assigned the run: its offered assignment names node B, but the run names no node until one is
--    accepted. Once accepted, both name node B, and the coverage says what the value is.
set local role service_role;
select public.qorpera_activate_runner(current_setting('qorpera_test.p431_runner')::uuid,repeat('1',64),repeat('2',64),'linux','p431') \g /dev/null
select set_config('qorpera_test.p431_assignment',(public.qorpera_assign_runner_job('64300000-0000-4000-8000-0000000000b1',
	(current_setting('qorpera_test.p431_claim')::jsonb ->> 'claim_id')::uuid,current_setting('qorpera_test.p431_runner')::uuid,
	extensions.gen_random_uuid(),repeat('3',64),120) ->> 'assignment_id'),true) \g /dev/null
select pg_temp.base_assert(pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,
		current_setting('qorpera_test.p431_assignment')::uuid) ->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000b',
	'The offered assignment names the node its machine was placed on: ' || coalesce(pg_temp.p431_item(
		current_setting('qorpera_test.p431_run')::uuid,current_setting('qorpera_test.p431_assignment')::uuid)::text,'none'));
select pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) -> 'identity' -> 'physicalNodeId' = 'null'::jsonb,
	'Before an assignment is accepted the run names no node');
select public.qorpera_accept_runner_assignment(current_setting('qorpera_test.p431_runner')::uuid,repeat('2',64),
	current_setting('qorpera_test.p431_assignment')::uuid,(current_setting('qorpera_test.p431_claim')::jsonb #>> '{work,job_id}')::uuid,
	repeat('3',64)) \g /dev/null
select pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{identity,physicalNodeId}'
		= '64300000-0000-4000-8000-00000000000b',
	'The run names the node its accepted assignment was placed on: '
		|| coalesce(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) ->> 'identity','none'));
select pg_temp.base_assert(pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,
		current_setting('qorpera_test.p431_assignment')::uuid) ->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000b',
	'The accepted assignment still names node B');
select pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{coverage,physicalNodeTelemetry}'
		= 'placement_node_at_claim_not_measured_utilization',
	'The coverage names the claim''s placement, not measured telemetry: '
		|| coalesce(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{coverage,physicalNodeTelemetry}','none'));

-- 3. The fixture's run (Alice's) has an accepted assignment whose runner reserved no machine: no node anywhere.
reset role;
select pg_temp.base_assert((select a.accepted_at is not null from public.qorpera_runner_assignments a
	where a.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid
		and not exists(select 1 from public.qorpera_runtime_machine_allocations m where m.runner_id = a.runner_id)),
	'The fixture run''s assignment is accepted and its runner has no machine');
set local role service_role;
select pg_temp.base_assert((select count(*) >= 1 and bool_and(item -> 'physicalNodeId' = 'null'::jsonb)
	from jsonb_array_elements(pg_temp.p431_view((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)
		#> '{sections,assignments,items}') item),
	'An assignment without a machine names no node');
select pg_temp.base_assert(pg_temp.p431_view((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)
		-> 'identity' -> 'physicalNodeId' = 'null'::jsonb,
	'A run whose accepted assignment has no machine names no node');

-- 4. A placement that did not place the run names no node, though a refused or deferred row carries the asking
--    provider's node (here node B's). The superuser rewrites the decision; the claims still say service role.
reset role;
do $$
declare v_decision text; v_view jsonb;
begin
	foreach v_decision in array array['refused','deferred','unbound'] loop
		update public.qorpera_runtime_node_placements
		set decision = v_decision,node_id = case v_decision when 'unbound' then null else node_id end
		where allocation_id = '43100000-0000-4000-8000-0000000000c1';
		v_view := pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid);
		perform pg_temp.base_assert(v_view -> 'identity' -> 'physicalNodeId' = 'null'::jsonb
			and (select item -> 'physicalNodeId' = 'null'::jsonb from jsonb_array_elements(v_view #> '{sections,assignments,items}') item
				where item ->> 'assignmentId' = current_setting('qorpera_test.p431_assignment')),
			'A ' || v_decision || ' placement names no node: ' || coalesce(v_view ->> 'identity','none') || ' '
				|| coalesce(v_view #>> '{sections,assignments}','none'));
	end loop;
	update public.qorpera_runtime_node_placements set decision = 'placed',node_id = '64300000-0000-4000-8000-00000000000b'
	where allocation_id = '43100000-0000-4000-8000-0000000000c1';
	perform pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{identity,physicalNodeId}'
		= '64300000-0000-4000-8000-00000000000b','Placed again, the run names node B');
end
$$;

-- 5. A later attempt on another runner whose machine was placed on node A (rows written by hand: a copy of the first
--    runner and machine). Each assignment names its own node; the run names its newest accepted assignment's. A later
--    attempt not yet accepted does not move the run's node, and an accepted one that was not placed leaves the run
--    without a node (no fallback to an older attempt's).
savepoint later_attempt;
insert into public.qorpera_runners
select (jsonb_populate_record(r,jsonb_build_object('id','43100000-0000-4000-8000-0000000000d2',
	'client_runner_id','43100000-0000-4000-8000-0000000000c2'))).*
from public.qorpera_runners r where r.id = current_setting('qorpera_test.p431_runner')::uuid;
insert into public.qorpera_runtime_machine_allocations
select (jsonb_populate_record(m,jsonb_build_object('id','43100000-0000-4000-8000-0000000000c2',
	'runner_id','43100000-0000-4000-8000-0000000000d2','instance_sha256',repeat('9',64)))).*
from public.qorpera_runtime_machine_allocations m where m.id = '43100000-0000-4000-8000-0000000000c1';
insert into public.qorpera_runtime_node_placements(allocation_id,provider_kind,provider_id,node_id,decision,reason,candidates)
values ('43100000-0000-4000-8000-0000000000c2','native','process','64300000-0000-4000-8000-00000000000a','placed',
	'CLAIM_TURN_LEAST_BUSY','[]'::jsonb);
-- The first attempt failed after it was accepted.
update public.qorpera_runner_assignments set status = 'failed',finished_at = greatest(accepted_at,statement_timestamp())
where id = current_setting('qorpera_test.p431_assignment')::uuid;
savepoint offered;
insert into public.qorpera_runner_assignments
select (jsonb_populate_record(a,jsonb_build_object('id','43100000-0000-4000-8000-0000000000e2',
	'runner_id','43100000-0000-4000-8000-0000000000d2','status','offered','created_at',a.created_at + interval '1 second',
	'accepted_at',null,'finished_at',null))).*
from public.qorpera_runner_assignments a where a.id = current_setting('qorpera_test.p431_assignment')::uuid;
select pg_temp.base_assert(pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,'43100000-0000-4000-8000-0000000000e2')
		->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000a'
	and pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{identity,physicalNodeId}' = '64300000-0000-4000-8000-00000000000b',
	'A later attempt not yet accepted names its own node, and the run keeps the accepted attempt''s: '
		|| coalesce(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) ->> 'identity','none'));
rollback to savepoint offered;
insert into public.qorpera_runner_assignments
select (jsonb_populate_record(a,jsonb_build_object('id','43100000-0000-4000-8000-0000000000e2',
	'runner_id','43100000-0000-4000-8000-0000000000d2','status','accepted','created_at',a.created_at + interval '1 second',
	'accepted_at',a.accepted_at + interval '1 second','finished_at',null))).*
from public.qorpera_runner_assignments a where a.id = current_setting('qorpera_test.p431_assignment')::uuid;
set local role service_role;
select pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) #>> '{identity,physicalNodeId}'
		= '64300000-0000-4000-8000-00000000000a',
	'The run names its newest accepted assignment''s node: '
		|| coalesce(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) ->> 'identity','none'));
select pg_temp.base_assert(pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,'43100000-0000-4000-8000-0000000000e2')
		->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000a'
	and pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,current_setting('qorpera_test.p431_assignment')::uuid)
		->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000b',
	'Each assignment names the node its own machine was placed on');
reset role;
update public.qorpera_runtime_node_placements set decision = 'deferred',reason = 'NO_ELIGIBLE_NODE'
where allocation_id = '43100000-0000-4000-8000-0000000000c2';
set local role service_role;
select pg_temp.base_assert(pg_temp.p431_view(current_setting('qorpera_test.p431_run')::uuid) -> 'identity' -> 'physicalNodeId' = 'null'::jsonb
	and pg_temp.p431_item(current_setting('qorpera_test.p431_run')::uuid,current_setting('qorpera_test.p431_assignment')::uuid)
		->> 'physicalNodeId' = '64300000-0000-4000-8000-00000000000b',
	'A newest accepted assignment that was not placed leaves the run without a node, not an older attempt''s');
rollback to savepoint later_attempt;
reset role;
rollback;
