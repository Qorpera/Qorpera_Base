-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Context tree W5a-2 (20260930270000): the resume gate reads the run's log, and no attempt of a run starts while a step
-- erase is open on its log. Test 924's run of Alice's resumes from its log only when it has a live one, no erase is open
-- on it and it is not narrow. Its first attempt's lease runs out before it starts, and the job is queued again. While an
-- erase is open (its first commit made by hand here, as the erase makes it), the claim leaves the job alone, and the
-- runner's accept and start refuse it (55006); with two erases one after the other, the run goes on only after both. An
-- erase does not open while an attempt holds the job, and a replayed accept is answered as before. The races are 994;
-- the cut-off and the pause on the real gate are 991 and 992.

create function pg_temp.rg_run() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
-- The run's log, as its runtime's first batch indexes runs/<run>/run.toml and marks the generation row.
create function pg_temp.rg_log() returns void language plpgsql as $$
declare v_run public.qorpera_execution_runs := pg_temp.rg_run();
begin
	insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
	values (v_run.environment_id, v_run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || v_run.id,
		'qorperaos/agents/alice/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
	insert into public.qorpera_memory_run_generations(environment_id, run_id, log_created_at)
	values (v_run.environment_id, v_run.id, clock_timestamp());
end
$$;
-- A step erase's first commit, as the erase makes it (§10.1): the run's generation row FOR UPDATE, then the job read
-- plainly. It opens only while no attempt holds the job and no other erase is open: it sets its mark and raises the
-- generation. Null when it may not open yet.
create function pg_temp.rg_erase_open() returns uuid language plpgsql as $$
declare v_run public.qorpera_execution_runs := pg_temp.rg_run(); v_open uuid; v_erase uuid := extensions.gen_random_uuid();
begin
	insert into public.qorpera_memory_run_generations(environment_id, run_id) values (v_run.environment_id, v_run.id)
	on conflict do nothing;
	select erase_open into v_open from public.qorpera_memory_run_generations
	where environment_id = v_run.environment_id and run_id = v_run.id for update;
	if v_open is not null or exists (select 1 from public.qorpera_runner_jobs where id = v_run.job_id and status = 'leased') then
		return null;
	end if;
	update public.qorpera_memory_run_generations set erase_open = v_erase, memory_generation = memory_generation + 1,
		updated_at = clock_timestamp()
	where environment_id = v_run.environment_id and run_id = v_run.id;
	return v_erase;
end
$$;
-- Its last commit, after the rewrite.
create function pg_temp.rg_erase_close(p_erase uuid) returns void language plpgsql as $$
begin
	update public.qorpera_memory_run_generations set erase_open = null, updated_at = clock_timestamp()
	where run_id = (pg_temp.rg_run()).id and erase_open = p_erase;
	if not found then raise exception 'Base assertion: no erase % is open', p_erase; end if;
end
$$;
create function pg_temp.rg_claim() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
end
$$;
create function pg_temp.rg_accept_sql(p_attempt jsonb) returns text language sql as $$
	select format('select public.qorpera_accept_runner_assignment(%L, %L, %L, %L, %L)', p_attempt ->> 'runnerId', repeat('2', 64),
		p_attempt ->> 'assignmentId', p_attempt ->> 'jobId', repeat('3', 64))
$$;
create function pg_temp.rg_start_sql(p_attempt jsonb) returns text language sql as $$
	select format('select public.qorpera_start_runner_assignment(%L, %L, %L, %L, %L, null)', p_attempt ->> 'runnerId', repeat('2', 64),
		p_attempt ->> 'assignmentId', p_attempt ->> 'jobId', repeat('3', 64))
$$;

-- 1. The gate is still nobody's to call.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_run_resumes_from_log(uuid)', 'EXECUTE'),
			'the gate is open to ' || v_role);
	end loop;
end
$$;

-- 2. The gate: a run with no log does not resume; with a live log it does, but not while an erase is open on it, not
--    when the log is narrow (wholly, from a step on, or by its machine) and not once the log is retired.
do $$
declare v_run public.qorpera_execution_runs := pg_temp.rg_run(); v_erase uuid;
begin
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id) is false, 'a run with no log does not resume');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(extensions.gen_random_uuid()) is false, 'no run does not resume');
	perform pg_temp.rg_log();
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id), 'a run with a live log resumes');
	-- The erase's mark is all the gate reads: the leased job would keep a real erase from opening.
	update public.qorpera_memory_run_generations set erase_open = extensions.gen_random_uuid() where run_id = v_run.id;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id) is false, 'a run with an open erase does not resume');
	update public.qorpera_memory_run_generations set erase_open = null where run_id = v_run.id;
	update public.qorpera_memory_run_logs set narrow = true where run_id = v_run.id;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id) is false, 'a narrow run does not resume');
	update public.qorpera_memory_run_logs set narrow = false, narrow_from = 0 where run_id = v_run.id;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id) is false, 'a run narrow from a step on does not resume');
	update public.qorpera_memory_run_logs set narrow_from = null, retired_at = clock_timestamp() where run_id = v_run.id;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id) is false, 'a run whose log is retired does not resume');
	update public.qorpera_memory_run_logs set retired_at = null where run_id = v_run.id;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run.id), 'the live log resumes again');
end
$$;
savepoint rg_machine_narrow;
create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$ select true $$;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log((pg_temp.rg_run()).id) is false,
	'a run its machine made narrow does not resume') \g /dev/null
rollback to savepoint rg_machine_narrow;

-- 3. An erase does not open while an attempt holds the job, and a replayed accept of that attempt is answered as before.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_assert(pg_temp.rg_erase_open() is null, 'an erase does not open while an attempt holds the job');
	perform pg_temp.base_claims('service_role');
	execute pg_temp.rg_accept_sql(v_binding);
	perform pg_temp.base_assert((select status = 'leased' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		'a replayed accept is answered as before');
end
$$;

-- The attempt's lease runs out before it starts, and the job is queued again for a new attempt.
do $$
begin
	perform pg_temp.base_claims('service_role');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = (pg_temp.rg_run()).job_id;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = (pg_temp.rg_run()).job_id),
		'the job is queued again');
end
$$;

-- 4. Two erases one after the other: the second opens only when the first has closed, and the claim leaves the job
--    alone until both have.
do $$
declare v_first uuid; v_second uuid; v_claim jsonb;
begin
	v_first := pg_temp.rg_erase_open();
	perform pg_temp.base_assert(v_first is not null, 'an erase opens while no attempt holds the job');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log((pg_temp.rg_run()).id) is false, 'the open erase closes the gate');
	perform pg_temp.base_assert(pg_temp.rg_erase_open() is null, 'a second erase does not open while the first is open');
	perform pg_temp.base_assert(pg_temp.rg_claim() = 'null'::jsonb, 'the claim leaves the job alone while an erase is open');
	perform pg_temp.rg_erase_close(v_first);
	v_second := pg_temp.rg_erase_open();
	perform pg_temp.base_assert(v_second is not null, 'the second erase opens once the first has closed');
	perform pg_temp.base_assert(pg_temp.rg_claim() = 'null'::jsonb, 'the claim leaves the job alone while the second erase is open');
	perform pg_temp.rg_erase_close(v_second);
	perform pg_temp.base_assert((select memory_generation = 2 from public.qorpera_memory_run_generations where run_id = (pg_temp.rg_run()).id),
		'each erase raised the generation');
	v_claim := pg_temp.rg_claim();
	perform pg_temp.base_assert(v_claim #>> '{work,job_id}' = (pg_temp.rg_run()).job_id::text,
		'the claim takes the job once both erases have closed: ' || v_claim::text);
	perform set_config('qorpera_test.rg_claim', v_claim::text, true);
end
$$;

-- The next attempt is provisioned and offered to its runner.
do $$
declare v_claim jsonb := current_setting('qorpera_test.rg_claim')::jsonb; v_runner jsonb; v_assignment jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_runner := public.qorpera_provision_execution_runner((pg_temp.rg_run()).id, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'base-fixture');
	v_assignment := public.qorpera_assign_runner_job('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid, extensions.gen_random_uuid(), repeat('3', 64), 120);
	perform set_config('qorpera_test.rg_attempt', jsonb_build_object('runnerId', v_runner ->> 'runner_id',
		'assignmentId', v_assignment ->> 'assignment_id', 'jobId', v_claim #>> '{work,job_id}')::text, true);
end
$$;

-- 5. An erase that opens after the claim: the runner's accept and its start are refused while it is open, and nothing
--    changes. Once it closes, the accept leases the job, and no erase opens until the attempt ends.
do $$
declare v_attempt jsonb := current_setting('qorpera_test.rg_attempt')::jsonb; v_erase uuid := pg_temp.rg_erase_open();
	v_before public.qorpera_runner_jobs; v_job public.qorpera_runner_jobs;
begin
	perform pg_temp.base_assert(v_erase is not null, 'an erase opens on an offered attempt');
	select * into strict v_before from public.qorpera_runner_jobs where id = (v_attempt ->> 'jobId')::uuid;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(pg_temp.rg_accept_sql(v_attempt), '55006', 'memory_erase_open');
	perform pg_temp.base_error(pg_temp.rg_start_sql(v_attempt), '55006', 'memory_erase_open');
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_attempt ->> 'jobId')::uuid;
	perform pg_temp.base_assert(to_jsonb(v_job) = to_jsonb(v_before) and v_job.status = 'queued'
		and (select status = 'offered' from public.qorpera_runner_assignments where id = (v_attempt ->> 'assignmentId')::uuid),
		'a refused accept changes nothing: ' || to_jsonb(v_job)::text);
	perform pg_temp.rg_erase_close(v_erase);
	execute pg_temp.rg_accept_sql(v_attempt);
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_attempt ->> 'jobId')::uuid;
	perform pg_temp.base_assert(v_job.status = 'leased' and v_job.runner_id = (v_attempt ->> 'runnerId')::uuid
		and v_job.attempt_count = v_before.attempt_count + 1,
		'the accept leases the job once the erase has closed: ' || to_jsonb(v_job)::text);
	perform pg_temp.base_assert(pg_temp.rg_erase_open() is null, 'no erase opens while the attempt holds the job');
end
$$;

set constraints all immediate;
rollback;
