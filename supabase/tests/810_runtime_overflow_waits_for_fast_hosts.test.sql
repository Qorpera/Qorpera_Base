-- @fixture 643_runtime_runs_follow_placement.test.sql until "-- END FAST PLACEMENT FIXTURE"
-- 20260928439975: with a fast host on each node, a run one fast host refuses for capacity goes to the other
-- fast host first. The fresh-VM overflow takes it at once only when no fast host the run may use is left to
-- try it; otherwise only after its 10 s wait. Node A: fast host ...092 (the fixture's) and the overflow ...a2.
-- Node B: fast host ...b1. Test 643 covers the main path (B refuses: the overflow waits; both refuse: it takes).
select public.qorpera_set_runner_orchestrator_dispatch_role('30000000-0000-4000-8000-000000000092','fast');
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000b1','fast');
select public.qorpera_set_runner_orchestrator_dispatch_role('64300000-0000-4000-8000-0000000000a2','overflow');
reset role;
select set_config('qorpera_test.fp_r0',pg_temp.fp_run('81000000-0000-4000-8000-000000000100')::text,true);
select pg_temp.fp_age(current_setting('qorpera_test.fp_r0')::uuid,-30);
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) ->> 'nodeId' = '64300000-0000-4000-8000-00000000000b'
	and jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 2,
	'Placement prefers node B, with both fast hosts: ' || pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid)::text);

-- Node B's fast host takes the run and refuses it: it is retiring. Like a full host, the overflow waits for A's.
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('64300000-0000-4000-8000-0000000000b1')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.fp_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The preferred fast host takes the run');
select pg_temp.fp_refuse('64300000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fp_claim')::jsonb,'SANDBOX_RETIRING');
savepoint refused;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') = 'null'::jsonb,
	'After a retiring fast host refused, the fresh-VM path waits for the other fast host');
select pg_temp.wake_assert(pg_temp.fp_claim('30000000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'The other node''s fast host takes it');
rollback to savepoint refused;

-- A fast host that has gone silent (no heartbeat for 30 s) is not one the run may use: the overflow takes it.
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = statement_timestamp() - interval '5 minutes'
where id = '30000000-0000-4000-8000-000000000092';
set local role service_role;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 1,
	'A silent fast host leaves the placement');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'With the other fast host silent, the fresh-VM path takes the refused run at once');
rollback to savepoint refused;

-- A fast host declared for another bundle cannot run it either: the overflow takes it at once.
reset role;
update public.qorpera_runner_orchestrators set runtime_bundle_sha256 = (select bundle.sha256 from public.qorpera_runtime_bundles bundle
	where bundle.sha256 is distinct from (select run.runtime_bundle_sha256 from public.qorpera_execution_runs run
		where run.id = current_setting('qorpera_test.fp_r0')::uuid) order by bundle.version desc limit 1),
	runtime_bundle_declared_at = statement_timestamp()
where id = '30000000-0000-4000-8000-000000000092';
set local role service_role;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.fp_placement(current_setting('qorpera_test.fp_r0')::uuid) -> 'fast') = 1,
	'A fast host declared for another bundle leaves the placement');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'With the other fast host on another bundle, the fresh-VM path takes the refused run at once');
rollback to savepoint refused;

-- The other fast host stays alive but never claims: after its 10 s the overflow takes the run anyway.
reset role;
select pg_temp.fp_age(current_setting('qorpera_test.fp_r0')::uuid,11);
set local role service_role;
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'After 10 s the fresh-VM path takes the refused run even while the other fast host has not refused it');
rollback to savepoint refused;

-- Unchanged: work a fast host does not serve (NODE_NOT_PREFERRED) goes to the overflow at once, even while
-- another fast host has not refused it.
select set_config('qorpera_test.fp_claim',pg_temp.fp_claim('30000000-0000-4000-8000-000000000092')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.fp_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'Node A''s fast host claims the run');
select pg_temp.fp_refuse('30000000-0000-4000-8000-000000000092',current_setting('qorpera_test.fp_claim')::jsonb,'NODE_NOT_PREFERRED');
select pg_temp.wake_assert(pg_temp.fp_claim('64300000-0000-4000-8000-0000000000a2') #>> '{work,run_id}' = current_setting('qorpera_test.fp_r0'),
	'Work a fast host does not serve goes to the fresh-VM path at once');
reset role;
rollback;
