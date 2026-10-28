-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Identical nodes, change 4 (20260928182000), on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): each
-- run keeps its version.
--   * An undeclared orchestrator claims as before.
--   * A declared orchestrator claims only runs of its runtime bundle; the declaration can be cleared.
--   * During a roll the new bundle's node takes new runs and the old bundle's node finishes old ones.
--   * The roll status shows each bundle's work and whether a serving node can take it.
-- The runs are the owner's posts in Bob's and Carol's threads, turned into runs by the folder materializer (a
-- conversation runs one run at a time, 20260930538000, so the old and the new run are in two threads). The fixture's own
-- run (Alice's) is leased through orchestrator ...092. An input not yet turned into a run is a hire's kickoff that waits
-- for its hirer: the contributor, who has no login, hires Dave.
select pg_temp.base_claims('service_role');
reset role;
create function pg_temp.kv_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
-- The owner's post in an agent's thread (Bob's unless named), and the materializer pass that makes it a queued run.
create function pg_temp.kv_run(p_text text,p_staff uuid default '92400000-0000-4000-8000-000000000031') returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001',p_staff,p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
create function pg_temp.kv_bundle(p_version bigint) returns jsonb language sql as $$
	select jsonb_build_object('id',id,'sha256',sha256) from public.qorpera_runtime_bundles
	where bundle_key = 'qorpera.cloud-runtime' and version = p_version
$$;
create function pg_temp.kv_status() returns jsonb language sql as $$ select public.qorpera_runtime_bundle_roll_status() $$;
create function pg_temp.kv_entry(p_status jsonb,p_sha text) returns jsonb language sql as $$
	select b from jsonb_array_elements(p_status -> 'bundles') b where b ->> 'sha256' = p_sha
$$;

-- The old bundle is the fixture's active one; register a newer one.
select set_config('qorpera_test.kv_old',(select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton),true);
select pg_temp.base_assert((select runtime_bundle_sha256 from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid) = current_setting('qorpera_test.kv_old'),
	'The fixture run is of the active bundle');
-- The same executable manifest plus one marker: a different, valid bundle.
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
select 'qorpera.cloud-runtime',b.version + 1,b.manifest || '{"fixtureRolling":true}'::jsonb,
	encode(extensions.digest(convert_to((b.manifest || '{"fixtureRolling":true}'::jsonb)::text,'utf8'),'sha256'),'hex')
from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;
select set_config('qorpera_test.kv_new',(select sha256 from public.qorpera_runtime_bundles
	where bundle_key = 'qorpera.cloud-runtime' order by version desc limit 1),true);

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_register_runner_orchestrator('64200000-0000-4000-8000-000000000012','Updated node','native-b',repeat('4',64),3600) \g /dev/null

-- Operator only; the declaration names a registered bundle and a live orchestrator.
reset role;
select pg_temp.base_assert(not has_function_privilege(role_name,fn,'EXECUTE'),'Not public: ' || fn || ' for ' || role_name)
from unnest(array['anon','authenticated']) role_name,
	unnest(array['public.qorpera_declare_runner_orchestrator_bundle(uuid,text)','public.qorpera_runtime_bundle_roll_status()']) fn;
set local role service_role;
select pg_temp.base_error($q$select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',repeat('9',64))$q$,
	'42501','Runtime bundle is not registered');
select pg_temp.base_error($q$select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012','NOT-A-SHA')$q$,
	'42501','Invalid orchestrator bundle declaration');
select pg_temp.base_error($q$select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000099',null)$q$,
	'42501','Orchestrator is unavailable');

-- The updated node declares the new bundle: it leaves an old-bundle run to the undeclared old node.
select pg_temp.base_assert(public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',
	current_setting('qorpera_test.kv_new')) ->> 'runtimeBundleSha256' = current_setting('qorpera_test.kv_new'),'Updated node declares the new bundle');
reset role;
select set_config('qorpera_test.kv_run_old',pg_temp.kv_run('Work before the switch.')::text,true);
select pg_temp.base_assert((select runtime_bundle_sha256 from public.qorpera_execution_runs where id = current_setting('qorpera_test.kv_run_old')::uuid)
	= current_setting('qorpera_test.kv_old'),'A run before the switch keeps the old bundle');
set local role service_role;
select pg_temp.base_assert(pg_temp.kv_claim('64200000-0000-4000-8000-000000000012') = 'null'::jsonb,
	'The new-bundle node does not take an old-bundle run');
select pg_temp.base_assert(pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'queuedRuns' = '1'
	and (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'active')::boolean
	and (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'servedOnServingNode')::boolean
	and pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'declaredBy' -> 0 ->> 'orchestratorId'
		= '64200000-0000-4000-8000-000000000012',
	'Roll status before the switch: ' || pg_temp.kv_status()::text);

-- An input accepted before the switch but not yet turned into a run keeps the old bundle and is counted
-- (inputs already turned into a run, failed or completed are not: see below). The contributor has no login, so Dave's
-- kickoff waits for them, with no turn queued.
select set_config('qorpera_test.kv_pending',coalesce(pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs','0'),true);
reset role;
select pg_temp.base_commit('{"kind":"member","userId":"92400000-0000-4000-8000-000000000002"}','kv-hire-dave',
	jsonb_build_array(pg_temp.base_hire('dave','64200000-0000-4000-8000-000000000034','Dave'))) \g /dev/null
select set_config('qorpera_test.kv_input',(select first_run.input_id::text from public.qorpera_agent_first_runs first_run
	where first_run.profile_id = '92400000-0000-4000-8000-000000000010' and first_run.staff_agent_id = '64200000-0000-4000-8000-000000000034'),true);
select pg_temp.base_assert((select runtime_bundle_sha256 = current_setting('qorpera_test.kv_old') and execution_run_id is null
		and completed_at is null and failed_at is null
	from public.qorpera_session_inputs where id = current_setting('qorpera_test.kv_input')::uuid)
	and not exists (select 1 from public.qorpera_session_turn_requests where input_id = current_setting('qorpera_test.kv_input')::uuid),
	'Dave''s kickoff waits for its hirer, of the old bundle');
set local role service_role;
select pg_temp.base_assert((pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs')::bigint
	= current_setting('qorpera_test.kv_pending')::bigint + 1,'Old-bundle inputs not yet turned into runs are counted, exactly');
reset role;

-- The switch: new runs get the new bundle. The old node now declares the old bundle and finishes it.
reset role;
update public.qorpera_active_runtime_bundle set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
from public.qorpera_runtime_bundles b where singleton and b.sha256 = current_setting('qorpera_test.kv_new');
set local role service_role;
select public.qorpera_declare_runner_orchestrator_bundle('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.kv_old')) \g /dev/null
reset role;
-- In Carol's thread: Bob's still holds the old run, and a conversation runs one run at a time (20260930538000).
select set_config('qorpera_test.kv_run_new',pg_temp.kv_run('Work after the switch.','92400000-0000-4000-8000-000000000032')::text,true);
select pg_temp.base_assert((select runtime_bundle_sha256 from public.qorpera_execution_runs where id = current_setting('qorpera_test.kv_run_new')::uuid)
	= current_setting('qorpera_test.kv_new'),'A run after the switch gets the new bundle');
set local role service_role;
select pg_temp.base_assert(pg_temp.kv_claim('64200000-0000-4000-8000-000000000012') #>> '{work,run_id}' = current_setting('qorpera_test.kv_run_new'),
	'The new-bundle node takes the new run, although an older run waits ahead of it');
select pg_temp.base_assert(pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) ->> 'runningRuns' = '1'
	and pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) ->> 'queuedRuns' = '0',
	'A claimed run counts as running');
select pg_temp.base_assert(pg_temp.kv_claim('64200000-0000-4000-8000-000000000012') = 'null'::jsonb,
	'The new-bundle node still leaves the old run');
select pg_temp.base_assert(pg_temp.kv_claim('92400000-0000-4000-8000-000000000092') #>> '{work,run_id}' = current_setting('qorpera_test.kv_run_old'),
	'The old-bundle node finishes the old run');
select pg_temp.base_assert(not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'active')::boolean
	and (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) ->> 'active')::boolean
	and (pg_temp.kv_status() ->> 'activeSha256') = current_setting('qorpera_test.kv_new')
	and pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'queuedRuns' = '0',
	'Roll status after the switch: ' || pg_temp.kv_status()::text);

-- A runner whose heartbeat stopped does not count as able to take the work.
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() - interval '1 hour'
where id = '92400000-0000-4000-8000-000000000092';
set local role service_role;
select pg_temp.base_assert(not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) -> 'servedBy')
		? '92400000-0000-4000-8000-000000000092'
	and not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'servedBy')
		? '92400000-0000-4000-8000-000000000092'
	and (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'servedBy')
		? '64200000-0000-4000-8000-000000000012',
	'A runner whose heartbeat stopped serves no bundle: ' || pg_temp.kv_status()::text);
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() where id = '92400000-0000-4000-8000-000000000092';
set local role service_role;

-- Undeclared live runners are listed. A runner on a switched-off node, or a revoked one, serves nothing.
select pg_temp.base_assert(not (pg_temp.kv_status() -> 'undeclaredLive') ? '64200000-0000-4000-8000-000000000012'
	and not (pg_temp.kv_status() -> 'undeclaredLive') ? '92400000-0000-4000-8000-000000000092','Both fixture runners are declared');
savepoint served;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
	'nodeId','64200000-0000-4000-8000-00000000000b','machineIdSha256',repeat('b',64),'label','node-b','cpuMillis',32000,
	'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,'standardCpuMillis',4000,
	'standardMemoryBytes',8589934592,'enabled',true),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('64200000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592) \g /dev/null
select pg_temp.base_assert((pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'servedBy') ? '64200000-0000-4000-8000-000000000012',
	'Serving node B''s runner serves the new bundle');
select public.qorpera_set_runtime_node_serving('64200000-0000-4000-8000-00000000000b',false,1,'roll') \g /dev/null
select pg_temp.base_assert(not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'servedBy') ? '64200000-0000-4000-8000-000000000012'
	and pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'declaredBy' -> 0 ->> 'serving' = 'false',
	'An emptying node''s runner serves nothing');
rollback to savepoint served;
savepoint revoked;
reset role;
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '64200000-0000-4000-8000-000000000012';
set local role service_role;
select pg_temp.base_assert(pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'declaredBy' = '[]'::jsonb
	and not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_new')) -> 'servedBy') ? '64200000-0000-4000-8000-000000000012',
	'A revoked runner neither declares nor serves');
rollback to savepoint revoked;

-- A stale undeclared runner is in `undeclared` but not in `undeclaredLive`; a revoked one in neither.
savepoint undeclared;
select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',null) \g /dev/null
reset role;
update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() - interval '1 hour'
where id = '64200000-0000-4000-8000-000000000012';
set local role service_role;
select pg_temp.base_assert((pg_temp.kv_status() -> 'undeclared') ? '64200000-0000-4000-8000-000000000012'
	and not (pg_temp.kv_status() -> 'undeclaredLive') ? '64200000-0000-4000-8000-000000000012'
	and not (pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) -> 'servedBy') ? '64200000-0000-4000-8000-000000000012',
	'A stopped, undeclared runner is listed but does not serve');
reset role;
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '64200000-0000-4000-8000-000000000012';
set local role service_role;
select pg_temp.base_assert(not (pg_temp.kv_status() -> 'undeclared') ? '64200000-0000-4000-8000-000000000012','A revoked runner is not listed');
select pg_temp.base_error($q$select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',null)$q$,
	'42501','Orchestrator is unavailable');
rollback to savepoint undeclared;
-- Only the operator declares, and only a registered runtime bundle.
savepoint declare_checks;
reset role;
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
values('qorpera.other-bundle',1,'{"other":true}'::jsonb,encode(extensions.digest(convert_to('{"other": true}','utf8'),'sha256'),'hex'));
select set_config('qorpera_test.kv_other_key',encode(extensions.digest(convert_to('{"other": true}','utf8'),'sha256'),'hex'),true);
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',null)$q$,'42501');
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error(format('select public.qorpera_declare_runner_orchestrator_bundle(%L,%L)','64200000-0000-4000-8000-000000000012',
	current_setting('qorpera_test.kv_other_key')),'42501','Runtime bundle is not registered');
rollback to savepoint declare_checks;
-- A completed input, a failed one and one already turned into a run are not pending.
select set_config('qorpera_test.kv_pending2',pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs',true);
savepoint completed_input;
reset role;
update public.qorpera_session_inputs set completed_at = clock_timestamp() where id = current_setting('qorpera_test.kv_input')::uuid;
set local role service_role;
select pg_temp.base_assert(coalesce((pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs')::bigint,0)
	= current_setting('qorpera_test.kv_pending2')::bigint - 1,'A completed input is not pending');
rollback to savepoint completed_input;
savepoint failed_input;
reset role;
update public.qorpera_session_inputs set failed_at = clock_timestamp(), failure_reason = 'fixture' where id = current_setting('qorpera_test.kv_input')::uuid;
set local role service_role;
select pg_temp.base_assert(coalesce((pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs')::bigint,0)
	= current_setting('qorpera_test.kv_pending2')::bigint - 1,'A failed input is not pending');
rollback to savepoint failed_input;
savepoint run_input;
reset role;
update public.qorpera_session_inputs set execution_run_id = current_setting('qorpera_test.kv_run_old')::uuid
where id = current_setting('qorpera_test.kv_input')::uuid;
set local role service_role;
select pg_temp.base_assert(coalesce((pg_temp.kv_entry(pg_temp.kv_status(),current_setting('qorpera_test.kv_old')) ->> 'pendingInputs')::bigint,0)
	= current_setting('qorpera_test.kv_pending2')::bigint - 1,'An input already turned into a run is not pending');
rollback to savepoint run_input;

-- Re-registering a runner (a rebuilt fast host) clears its declaration: it is undeclared until declared again.
savepoint reregister;
select public.qorpera_register_runner_orchestrator('64200000-0000-4000-8000-000000000012','Updated node','native-b',repeat('6',64),3600) \g /dev/null
reset role;
select pg_temp.base_assert((select runtime_bundle_sha256 is null and runtime_bundle_declared_at is null from public.qorpera_runner_orchestrators
	where id = '64200000-0000-4000-8000-000000000012'),'Re-registration clears the declaration');
set local role service_role;
select pg_temp.base_assert((pg_temp.kv_status() -> 'undeclaredLive') ? '64200000-0000-4000-8000-000000000012',
	'A re-registered runner shows as undeclared and live');
rollback to savepoint reregister;

-- Clearing the declaration restores the old behaviour.
select pg_temp.base_assert(public.qorpera_declare_runner_orchestrator_bundle('64200000-0000-4000-8000-000000000012',null) -> 'runtimeBundleSha256'
	= 'null'::jsonb,'Declaration cleared');
reset role;
select pg_temp.base_assert((select runtime_bundle_sha256 is null and runtime_bundle_declared_at is null from public.qorpera_runner_orchestrators
	where id = '64200000-0000-4000-8000-000000000012'),'No declaration left');
-- The old node has finished the old run, so the next post in Bob's thread is a run (one run at a time in a conversation,
-- 20260930538000).
update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: the old run ends',
	lease_token_sha256 = null, lease_expires_at = null
where run_id = current_setting('qorpera_test.kv_run_old')::uuid;
select set_config('qorpera_test.kv_run_any',pg_temp.kv_run('Any work.')::text,true);
set local role service_role;
select pg_temp.base_assert(pg_temp.kv_claim('64200000-0000-4000-8000-000000000012') #>> '{work,run_id}' = current_setting('qorpera_test.kv_run_any'),
	'An undeclared orchestrator claims as before');
reset role;
rollback;
