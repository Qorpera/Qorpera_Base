-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A counted dispatch failure, and a fresh retry, make the job wait longer each time (20260930537000, WB-002 G3).
-- Production, 2026-10-28: WB-002 spent its eight dispatch attempts in about 23 seconds, because the job waited (15 s)
-- only while the attempt's machine was still reserved, and a fresh retry after a lapsed lease was queued again at
-- once. Now every orchestrator waits qorpera_runner_dispatch_wait(n) = min(15 s × 2^(n-1), 5 min) after the n-th
-- counted failure, and after a fresh retry of the n-th attempt; both caps of 8 and the typed refusals are unchanged.
-- Nodes as in 598: node A (fast host ...092, adapter 'process', holds the fixture run) and node B (fast host ...b1,
-- adapter 'native-b'). The counted failures are the owner's post in Bob's thread, turned into a run by the folder
-- materializer.
select pg_temp.base_claims('service_role');
reset role;
create function pg_temp.bo_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.bo_release(p_orchestrator uuid,p_claim jsonb,p_error text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),p_error)
$$;
-- Neither orchestrator gets work.
create function pg_temp.bo_nobody() returns boolean language sql as $$
	select pg_temp.bo_claim('92400000-0000-4000-8000-000000000092') #>> '{work,job_id}' is null
		and pg_temp.bo_claim('59900000-0000-4000-8000-0000000000b1') #>> '{work,job_id}' is null
$$;
-- Every wait over: the job may be claimed by whoever asks.
create function pg_temp.bo_ready() returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
		dispatch_deferred_until = null, dispatch_refused_by = null
	where id = current_setting('qorpera_test.bo_job')::uuid
$$;
create function pg_temp.bo_job() returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job where job.id = current_setting('qorpera_test.bo_job')::uuid
$$;
create function pg_temp.bo_released_at(p_claim jsonb) returns timestamptz language sql as $$
	select claim.released_at from public.qorpera_runner_job_claims claim where claim.id = (p_claim ->> 'claim_id')::uuid
$$;
create function pg_temp.bo_last_event(p_type text) returns jsonb language sql as $$
	select event.payload from public.qorpera_execution_run_events event
	where event.run_id = current_setting('qorpera_test.bo_run')::uuid and event.event_type = p_type
	order by event.id desc limit 1
$$;
create function pg_temp.bo_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.bo_policy('59900000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0) \g /dev/null
select public.qorpera_configure_runtime_node(pg_temp.bo_policy('59900000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('59900000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('59900000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592) \g /dev/null
select public.qorpera_register_runner_orchestrator('59900000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600) \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('59900000-0000-4000-8000-0000000000b1','fast') \g /dev/null
reset role;

-- 1. The wait: 15 s, 30 s, 1, 2, 4, then 5 minutes; the seven waits before the eighth failure add up to 17 min 45 s.
-- It is immutable, pins its search path and is nobody's to call (the release and the retry are security definers).
do $$
declare v_role text;
begin
	perform pg_temp.base_assert(array(select public.qorpera_runner_dispatch_wait(n) from generate_series(1, 9) n order by n)
		= array['15 seconds','30 seconds','1 minute','2 minutes','4 minutes','5 minutes','5 minutes','5 minutes','5 minutes']::interval[],
		'the wait doubles up to 5 minutes');
	perform pg_temp.base_assert(public.qorpera_runner_dispatch_wait(0) = interval '15 seconds'
		and public.qorpera_runner_dispatch_wait(-3) = interval '15 seconds'
		and public.qorpera_runner_dispatch_wait(null) = interval '15 seconds'
		and public.qorpera_runner_dispatch_wait(2147483647) = interval '5 minutes', 'the wait is bounded for any count');
	perform pg_temp.base_assert((select sum(public.qorpera_runner_dispatch_wait(n)) from generate_series(1, 7) n)
		= interval '17 minutes 45 seconds', 'eight failures span about 20 minutes');
	perform pg_temp.base_assert((select provolatile = 'i' and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_runner_dispatch_wait(integer)'::regprocedure), 'the wait is immutable with a pinned search path');
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_runner_dispatch_wait(integer)', 'EXECUTE'),
			'the wait is open to ' || v_role);
	end loop;
end $$;

-- 2. A fresh retry after a lapsed lease (the fixture's accepted run on node A) waits as long as after the same
-- number of counted failures, keyed by the attempt it retries, and is queued from the end of the wait. Every
-- orchestrator leaves it alone meanwhile. Each case is rolled back.
create function pg_temp.bo_pristine(p_attempts integer) returns void language plpgsql as $$
declare v_job uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid; v_row public.qorpera_runner_jobs;
begin
	begin
		perform pg_temp.base_claims('service_role');
		update public.qorpera_runner_jobs set attempt_count = p_attempts, lease_expires_at = statement_timestamp() - interval '1 second',
			dispatch_refused_by = '59900000-0000-4000-8000-0000000000b1', dispatch_deferred_until = statement_timestamp() - interval '1 second'
		where id = v_job and status = 'leased';
		perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
		select * into strict v_row from public.qorpera_runner_jobs where id = v_job;
		perform pg_temp.base_assert(v_row.status = 'queued' and v_row.attempt_count = p_attempts and v_row.dispatch_failure_count = 0
			and v_row.last_error = 'Runner lease expired before durable completion' and v_row.dispatch_refused_by is null
			and v_row.dispatch_deferred_until = statement_timestamp() + public.qorpera_runner_dispatch_wait(p_attempts)
			and v_row.queued_at = v_row.dispatch_deferred_until,
			format('the fresh retry of attempt %s waits %s: %s', p_attempts, public.qorpera_runner_dispatch_wait(p_attempts), to_jsonb(v_row)));
		perform pg_temp.base_assert(pg_temp.bo_nobody(), format('every orchestrator leaves the fresh retry of attempt %s alone', p_attempts));
		raise exception using errcode = 'QG3RB', message = 'roll the retry back';
	exception when sqlstate 'QG3RB' then null;
	end;
end $$;
select pg_temp.base_assert((select status = 'leased' and attempt_count = 1 from public.qorpera_runner_jobs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid), 'the fixture run holds attempt 1');
select pg_temp.bo_pristine(1) \g /dev/null
select pg_temp.bo_pristine(3) \g /dev/null
select pg_temp.bo_pristine(7) \g /dev/null

-- The run of the counted failures, on node B's or node A's fast host.
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000031','Work');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	perform set_config('qorpera_test.bo_run', v_pass -> 'run_ids' ->> 0, true);
	perform set_config('qorpera_test.bo_job', (select id::text from public.qorpera_runner_jobs
		where run_id = (v_pass -> 'run_ids' ->> 0)::uuid), true);
end $$;

-- 3. Counted failures (a provider error before any machine): after the n-th the job stays queued for attempt 1 and
-- every orchestrator waits min(15 s × 2^(n-1), 5 min), even one an earlier refusal named. The eighth fails the job.
savepoint counted;
select pg_temp.bo_ready();
do $$
declare v_n integer; v_claim jsonb; v_result jsonb; v_row public.qorpera_runner_jobs; v_event jsonb; v_queued timestamptz;
begin
	perform pg_temp.base_claims('service_role');
	v_queued := (pg_temp.bo_job()).queued_at;
	for v_n in 1..8 loop
		-- The wait before is over.
		update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() where id = (pg_temp.bo_job()).id;
		if v_n = 3 then
			-- Node B's fast host was refused a moment ago (node preference): only node A's may claim.
			update public.qorpera_runner_jobs set dispatch_refused_by = '59900000-0000-4000-8000-0000000000b1',
				dispatch_deferred_until = statement_timestamp() + interval '5 seconds'
			where id = (pg_temp.bo_job()).id;
		end if;
		v_claim := pg_temp.bo_claim('92400000-0000-4000-8000-000000000092');
		perform pg_temp.base_assert(v_claim #>> '{work,job_id}' = (pg_temp.bo_job()).id::text and v_claim #>> '{work,attempt}' = '1',
			format('claim %s is attempt 1: %s', v_n, v_claim));
		v_result := pg_temp.bo_release('92400000-0000-4000-8000-000000000092', v_claim,
			'Runner provider request failed (503) [code=PROVIDER_ACQUIRE]');
		v_row := pg_temp.bo_job();
		v_event := pg_temp.bo_last_event('infrastructure_retry');
		exit when v_n = 8;
		perform pg_temp.base_assert(not (v_result ->> 'terminal')::boolean and not (v_result ->> 'attempt_abandoned')::boolean
			and v_row.status = 'queued' and v_row.attempt_count = 0 and v_row.dispatch_failure_count = v_n
			and v_row.dispatch_refused_by is null and v_row.queued_at = v_queued
			and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = public.qorpera_runner_dispatch_wait(v_n)
			and (v_event ->> 'dispatch_failure_count')::integer = v_n
			and (v_event ->> 'deferred_until')::timestamptz = v_row.dispatch_deferred_until,
			format('failure %s waits %s: %s %s', v_n, public.qorpera_runner_dispatch_wait(v_n), v_result, to_jsonb(v_row)));
		perform pg_temp.base_assert(pg_temp.bo_nobody(), format('every orchestrator waits after failure %s', v_n));
	end loop;
	perform pg_temp.base_assert((v_result ->> 'terminal')::boolean and v_row.status = 'failed' and v_row.attempt_count = 0
		and v_row.dispatch_failure_count = 8
		and v_row.last_error = 'Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (503) [code=PROVIDER_ACQUIRE]'
		and (v_event ->> 'terminal')::boolean and v_event -> 'deferred_until' = 'null'::jsonb,
		format('the eighth failure fails the job: %s %s %s', v_result, to_jsonb(v_row), v_event));
end $$;
rollback to savepoint counted;

-- 4. Typed refusals are placement and are unchanged: no failure counted; node preference makes this orchestrator
-- wait 5 s, an unavailable node observation or full capacity 15 s, for this orchestrator unless another's refusal
-- is live.
savepoint typed;
update public.qorpera_runner_jobs set dispatch_failure_count = 3 where id = current_setting('qorpera_test.bo_job')::uuid;
select pg_temp.bo_ready();
do $$
declare v_claim jsonb; v_row public.qorpera_runner_jobs; v_event jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := pg_temp.bo_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.bo_release('92400000-0000-4000-8000-000000000092', v_claim, 'ADMISSION_REFUSED:NODE_NOT_PREFERRED');
	v_row := pg_temp.bo_job();
	v_event := pg_temp.bo_last_event('placement_deferred');
	perform pg_temp.base_assert(v_row.status = 'queued' and v_row.dispatch_failure_count = 3
		and v_row.dispatch_refused_by = '92400000-0000-4000-8000-000000000092'
		and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = interval '5 seconds'
		and v_event ->> 'reason' = 'NODE_NOT_PREFERRED' and pg_temp.bo_last_event('infrastructure_retry') is null,
		'node preference makes node A''s fast host wait 5 s: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert(pg_temp.bo_claim('92400000-0000-4000-8000-000000000092') #>> '{work,job_id}' is null,
		'node A''s fast host waits');
	-- Node B's fast host claims at once; its node observation is unavailable, while node A's refusal is live.
	v_claim := pg_temp.bo_claim('59900000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(v_claim #>> '{work,job_id}' = (pg_temp.bo_job()).id::text, 'node B''s fast host claims: ' || v_claim::text);
	perform pg_temp.bo_release('59900000-0000-4000-8000-0000000000b1', v_claim, 'ADMISSION_REFUSED:NODE_OBSERVATION_UNAVAILABLE');
	v_row := pg_temp.bo_job();
	perform pg_temp.base_assert(v_row.status = 'queued' and v_row.dispatch_failure_count = 3 and v_row.dispatch_refused_by is null
		and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = interval '15 seconds'
		and pg_temp.bo_last_event('placement_deferred') ->> 'reason' = 'NODE_OBSERVATION_UNAVAILABLE',
		'an unavailable node observation makes every orchestrator wait 15 s: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert(pg_temp.bo_nobody(), 'every orchestrator waits after the observation refusal');
end $$;
select pg_temp.bo_ready();
do $$
declare v_claim jsonb; v_row public.qorpera_runner_jobs;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := pg_temp.bo_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.bo_release('92400000-0000-4000-8000-000000000092', v_claim, 'ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED');
	v_row := pg_temp.bo_job();
	perform pg_temp.base_assert(v_row.status = 'queued' and v_row.dispatch_failure_count = 3 and v_row.attempt_count = 0
		and v_row.dispatch_refused_by = '92400000-0000-4000-8000-000000000092'
		and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = interval '15 seconds'
		and pg_temp.bo_last_event('placement_deferred') ->> 'reason' = 'SANDBOX_CAPACITY_EXHAUSTED',
		'full capacity makes node A''s fast host wait 15 s: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert(pg_temp.bo_claim('59900000-0000-4000-8000-0000000000b1') #>> '{work,job_id}' = v_row.id::text,
		'node B''s fast host still claims');
end $$;
rollback to savepoint typed;

-- 5. The attempt's machine is still reserved: the failure waits as any other (it was 15 s, for this case only). When
-- the provider has released the machine, the next failure moves the job to attempt 2, which is queued from the end
-- of its wait.
select pg_temp.bo_ready();
do $$
declare v_run uuid := current_setting('qorpera_test.bo_run')::uuid; v_claim jsonb; v_runner jsonb; v_result jsonb;
	v_row public.qorpera_runner_jobs; v_queued timestamptz;
begin
	perform pg_temp.base_claims('service_role');
	v_queued := (pg_temp.bo_job()).queued_at;
	v_claim := pg_temp.bo_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(v_claim #>> '{work,attempt}' = '1', 'node A''s fast host claims attempt 1: ' || v_claim::text);
	v_runner := public.qorpera_provision_execution_runner(v_run, public.qorpera_run_attempt_acquisition_id(v_run, 1), 'process', repeat('1', 64));
	perform pg_temp.base_assert(public.qorpera_reserve_runtime_machine(public.qorpera_run_attempt_acquisition_id(v_run, 1), 'process',
		repeat('7', 64), v_run, (v_runner ->> 'runner_id')::uuid) ->> 'state' = 'reserved', 'attempt 1''s machine is reserved on node A');
	v_result := pg_temp.bo_release('92400000-0000-4000-8000-000000000092', v_claim, 'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]');
	v_row := pg_temp.bo_job();
	perform pg_temp.base_assert(not (v_result ->> 'attempt_abandoned')::boolean and v_row.status = 'queued' and v_row.attempt_count = 0
		and v_row.dispatch_failure_count = 1 and v_row.dispatch_refused_by is null and v_row.queued_at = v_queued
		and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = interval '15 seconds',
		'a reserved machine''s failure waits 15 s: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert(pg_temp.bo_nobody(), 'every orchestrator waits for the reserved machine');
	-- The provider releases the machine, and the wait is over.
	update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
	where id = public.qorpera_run_attempt_acquisition_id(v_run, 1);
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() where id = v_row.id;
	v_claim := pg_temp.bo_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(v_claim #>> '{work,attempt}' = '1', 'the retry is attempt 1: ' || v_claim::text);
	v_result := pg_temp.bo_release('92400000-0000-4000-8000-000000000092', v_claim, 'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]');
	v_row := pg_temp.bo_job();
	perform pg_temp.base_assert((v_result ->> 'attempt_abandoned')::boolean and not (v_result ->> 'terminal')::boolean
		and (select status = 'revoked' from public.qorpera_runners where id = (v_runner ->> 'runner_id')::uuid)
		and v_row.status = 'queued' and v_row.attempt_count = 1 and v_row.dispatch_failure_count = 2 and v_row.dispatch_refused_by is null
		and v_row.dispatch_deferred_until - pg_temp.bo_released_at(v_claim) = interval '30 seconds'
		and v_row.queued_at = v_row.dispatch_deferred_until
		and (pg_temp.bo_last_event('infrastructure_retry') ->> 'deferred_until')::timestamptz = v_row.dispatch_deferred_until,
		'the abandoned attempt waits 30 s and attempt 2 is queued from the end of the wait: ' || to_jsonb(v_row)::text);
	perform pg_temp.base_assert(pg_temp.bo_nobody(), 'every orchestrator leaves attempt 2 alone while it waits');
end $$;

rollback;
