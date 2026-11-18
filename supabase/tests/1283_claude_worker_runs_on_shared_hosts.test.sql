-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12830000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-1283') \g /dev/null
select public.qorpera_register_runner_orchestrator('12830000-0000-4000-8000-0000000000a1', 'Node 1 fresh VMs', 'process',
	repeat('6', 64), 3600) \g /dev/null

create function pg_temp.cs_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator, extensions.gen_random_uuid(), 120)
$$;
create function pg_temp.cs_none(p_claim jsonb) returns boolean language sql as $$
	select p_claim is null or p_claim = 'null'::jsonb
$$;
create function pg_temp.cs_run() returns uuid language sql as $$
	select current_setting('qorpera_test.cs_run')::uuid
$$;
create function pg_temp.cs_job() returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id = job.id
	where run.id = pg_temp.cs_run()
$$;
create function pg_temp.cs_claims(p_orchestrator uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runner_job_claims claim
	where claim.run_id = pg_temp.cs_run() and claim.orchestrator_id = p_orchestrator
$$;

do $$
declare v_result jsonb; v_run uuid;
begin
	v_result := pg_temp.c4_dispatch(pg_temp.c4_alice(), 'cs-dispatch', 'QorperaOS/agents/alice/todos/onboarding/pdf',
		pg_temp.c4_brief('12830000-0000-4000-8000-0000000000b1', 'claude-code'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the Claude Code dispatch: ' || v_result::text);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	select wake.run_id into v_run from public.qorpera_wake_occurrences wake
	where wake.source_kind = 'worker-dispatch' and wake.source_id = '12830000-0000-4000-8000-0000000000b1';
	perform pg_temp.base_assert(v_run is not null and (public.qorpera_run_worker(v_run)).harness = 'claude-code',
		'the Claude Code worker''s run: ' || coalesce(v_run::text, 'none'));
	perform set_config('qorpera_test.cs_run', v_run::text, false);
	perform pg_temp.base_assert((pg_temp.cs_job()).status = 'queued'
		and not exists (select 1 from public.qorpera_runner_jobs job where job.status = 'queued' and job.run_id <> v_run),
		'the Claude Code worker''s run is the only queued run');
end $$;

do $$
begin
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1')),
		'1: an orchestrator that is no shared execution host never claims a Claude Code worker''s run');
	perform pg_temp.base_assert((pg_temp.cs_job()).status = 'queued' and pg_temp.cs_claims('12830000-0000-4000-8000-0000000000a1') = 0,
		'1: the run stays queued, unclaimed');
end $$;

do $$
declare v_claim jsonb;
begin
	perform public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092', 'fast');
	perform public.qorpera_set_runner_orchestrator_dispatch_role('12830000-0000-4000-8000-0000000000a1', 'overflow');
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '11 seconds' where id = (pg_temp.cs_job()).id;
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1')),
		'2: the overflow does not take it after its 10 s wait');
	v_claim := pg_temp.cs_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = pg_temp.cs_run()::text, '2: the shared host claims it: ' || coalesce(v_claim::text, 'none'));
	perform public.qorpera_release_runner_job_claim('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		extensions.gen_random_uuid(), 'ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED');
	perform pg_temp.base_assert((pg_temp.cs_job()).status = 'queued'
		and (pg_temp.cs_job()).dispatch_refused_by = '92400000-0000-4000-8000-000000000092',
		'2: the full shared host gave it back');
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1')),
		'2: the overflow does not take it when the shared host is full');
	v_claim := pg_temp.cs_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(pg_temp.cs_none(v_claim), '2: the full shared host waits out its refusal');
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() - interval '1 second'
	where id = (pg_temp.cs_job()).id;
	v_claim := pg_temp.cs_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = pg_temp.cs_run()::text,
		'2: after its wait the shared host claims it again: ' || coalesce(v_claim::text, 'none'));
	perform public.qorpera_release_runner_job_claim('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		extensions.gen_random_uuid(), 'ADMISSION_REFUSED:NODE_NOT_PREFERRED');
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1')),
		'2: nor when the shared host says it is not its work');
	perform pg_temp.base_assert(pg_temp.cs_claims('12830000-0000-4000-8000-0000000000a1') = 0, '2: the overflow never claimed it');
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() - interval '1 second', dispatch_refused_by = null,
		last_error = null where id = (pg_temp.cs_job()).id;
end $$;

savepoint drained;
do $$
declare v_refused boolean := false;
begin
	update public.qorpera_runner_orchestrators set status = 'draining' where id = '92400000-0000-4000-8000-000000000092';
	begin
		perform pg_temp.cs_claim('92400000-0000-4000-8000-000000000092');
	exception when insufficient_privilege then v_refused := true;
	end;
	perform pg_temp.base_assert(v_refused, '3: a draining shared host claims nothing');
	perform public.qorpera_set_runner_orchestrator_dispatch_role('12830000-0000-4000-8000-0000000000a1', null);
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1')),
		'3: while the shared host drains for a roll, the run waits: nothing else takes it, with a role or without');
	perform pg_temp.base_assert((pg_temp.cs_job()).status = 'queued', '3: the run is still queued');
end $$;
rollback to savepoint drained;

savepoint revoked;
do $$
begin
	perform public.qorpera_revoke_execution_host_credential('base-shared-host');
	perform pg_temp.base_assert(pg_temp.cs_none(pg_temp.cs_claim('92400000-0000-4000-8000-000000000092')),
		'4: an orchestrator whose execution host is no longer bound no longer claims it');
end $$;
rollback to savepoint revoked;

do $$
declare v_result jsonb; v_codex uuid; v_claim jsonb; v_first public.qorpera_execution_runs; v_next public.qorpera_execution_runs;
begin
	perform public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092', null);
	perform public.qorpera_set_runner_orchestrator_dispatch_role('12830000-0000-4000-8000-0000000000a1', null);
	v_result := pg_temp.c4_dispatch(pg_temp.c4_alice(), 'cs-dispatch-codex', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12830000-0000-4000-8000-0000000000b2', 'codex', 'Write the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '5: the Codex dispatch: ' || v_result::text);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	select wake.run_id into v_codex from public.qorpera_wake_occurrences wake
	where wake.source_kind = 'worker-dispatch' and wake.source_id = '12830000-0000-4000-8000-0000000000b2';
	select * into strict v_first from public.qorpera_execution_runs where id = pg_temp.cs_run();
	select * into strict v_next from public.qorpera_execution_runs where id = v_codex;
	perform pg_temp.base_assert((public.qorpera_run_worker(v_codex)).harness is null
		and not public.qorpera_run_member_waits(v_first) and not public.qorpera_run_member_waits(v_next)
		and (select job.created_at from public.qorpera_runner_jobs job where job.id = v_first.job_id)
			< (select job.created_at from public.qorpera_runner_jobs job where job.id = v_next.job_id),
		'5: a Codex worker''s run is queued behind the Claude Code worker''s, in the claim''s own order');
	v_claim := pg_temp.cs_claim('12830000-0000-4000-8000-0000000000a1');
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = v_codex::text,
		'5: the same orchestrator takes any other run, past the Claude Code worker''s: ' || coalesce(v_claim::text, 'none'));
	v_claim := pg_temp.cs_claim('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = pg_temp.cs_run()::text,
		'5: the shared host takes the Claude Code worker''s run: ' || coalesce(v_claim::text, 'none'));
end $$;

do $$
declare v_turn text := pg_get_functiondef(
	'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure);
begin
	perform pg_temp.base_assert(position('qorpera_execution_host_principals' in v_turn) > 0
		and position('20260929999997' in v_turn) > 0, '6: the claim turn has the rule and keeps what the activations look for');
	perform pg_temp.base_assert(not has_function_privilege('authenticated',
		'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)', 'execute')
		and not has_function_privilege('anon',
		'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)', 'execute'),
		'6: the claim turn is still no API role''s');
end $$;
