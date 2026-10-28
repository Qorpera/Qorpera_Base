-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Production DB slowness, item H (20260930482000): the orchestrator's claim no longer runs the whole reconcile. It keeps
-- the gate (only an active orchestrator claims, also on a replay) and a heartbeat it writes only when the stored one is
-- more than 5 seconds old. An expired lease waits for the reconcile lane. The reconcile's sweep of expired reserved
-- model requests starts from a partial index and still quarantines a finished job's requests, and nothing else.
-- Test 924's orchestrator …092 holds Alice's run on a lease.
reset role;
set local track_functions = 'all';

create function pg_temp.h_calls(p_name text) returns bigint language sql as $$
	select coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = p_name), 0)::bigint
$$;
create function pg_temp.h_claim(p_client uuid default null) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
		coalesce(p_client, extensions.gen_random_uuid()), 120)
$$;

-- 0. Timing, reported and not asserted (the test machines are shared). Before this change an idle claim cost about a
-- claim plus a reconcile; on master this block prints that, and the checks below then fail.
do $$
declare v_start timestamptz; v_claim numeric; v_reconcile numeric;
begin
	v_start := clock_timestamp();
	for i in 1..200 loop perform pg_temp.h_claim(); end loop;
	v_claim := extract(epoch from clock_timestamp() - v_start) * 1000 / 200;
	v_start := clock_timestamp();
	for i in 1..200 loop perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092'); end loop;
	v_reconcile := extract(epoch from clock_timestamp() - v_start) * 1000 / 200;
	raise notice '667 timing: idle claim % ms, reconcile % ms (200 calls each)', round(v_claim, 3), round(v_reconcile, 3);
end $$;

-- 1. The claim's text, settings and grants; the index.
do $$
declare v_claim regprocedure := 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)';
	v_text text := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	v_proc pg_proc;
begin
	select * into strict v_proc from pg_proc where oid = v_claim;
	perform pg_temp.base_assert(position('20260930482000' in v_text) > 0
		and position('qorpera_reconcile_runner_orchestrator(' in v_text) = 0, 'the claim no longer reconciles');
	perform pg_temp.base_assert(position('qorpera_runtime_orchestrator_nodes(v_adapter)' in v_text) > 0
		and position('declared.runtime_bundle_sha256' in v_text) > 0
		and position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in v_text) > 0,
		'the claim keeps the texts the bundle activations look for');
	perform pg_temp.base_assert(v_proc.prosecdef and v_proc.proconfig @> array['search_path=""', 'lock_timeout=25s',
		'statement_timeout=25s'], 'the claim keeps its settings: ' || coalesce(v_proc.proconfig::text, 'none'));
	perform pg_temp.base_assert(has_function_privilege('service_role', v_claim, 'execute'), 'the service role claims');
	perform pg_temp.base_assert(exists (select 1 from pg_indexes where schemaname = 'public'
		and indexname = 'qorpera_runner_model_requests_reserved_expiry'
		and indexdef like '%(reservation_expires_at, job_id) WHERE (status = ''reserved''::text)'), 'the partial index');
end $$;

-- 2. Twenty idle claims make no reconcile call; one reconcile counts, so the zero means something.
do $$
declare v_claims bigint := pg_temp.h_calls('qorpera_claim_runner_job_for_orchestrator');
	v_outer bigint := pg_temp.h_calls('qorpera_reconcile_runner_orchestrator');
	v_inner bigint := pg_temp.h_calls('qorpera_reconcile_runner_orchestrator_without_sponsored_turns');
	v_work jsonb;
begin
	for i in 1..20 loop
		v_work := pg_temp.h_claim();
		perform pg_temp.base_assert(v_work #>> '{work,job_id}' is null, 'nothing is queued: ' || v_work::text);
	end loop;
	perform pg_temp.base_assert(pg_temp.h_calls('qorpera_claim_runner_job_for_orchestrator') = v_claims + 20
		and pg_temp.h_calls('qorpera_reconcile_runner_orchestrator') = v_outer
		and pg_temp.h_calls('qorpera_reconcile_runner_orchestrator_without_sponsored_turns') = v_inner,
		format('20 claims: claim +%s, reconcile +%s, inner +%s',
			pg_temp.h_calls('qorpera_claim_runner_job_for_orchestrator') - v_claims,
			pg_temp.h_calls('qorpera_reconcile_runner_orchestrator') - v_outer,
			pg_temp.h_calls('qorpera_reconcile_runner_orchestrator_without_sponsored_turns') - v_inner));
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(pg_temp.h_calls('qorpera_reconcile_runner_orchestrator') = v_outer + 1
		and pg_temp.h_calls('qorpera_reconcile_runner_orchestrator_without_sponsored_turns') = v_inner + 1,
		'the call counts see a reconcile');
end $$;

-- 3. A draining or revoked orchestrator does not claim, with the reconcile's error.
savepoint h667_gate;
update public.qorpera_runner_orchestrators set status = 'draining' where id = '92400000-0000-4000-8000-000000000092';
select pg_temp.base_error('select pg_temp.h_claim()', '42501', 'orchestrator is unavailable');
update public.qorpera_runner_orchestrators set status = 'revoked' where id = '92400000-0000-4000-8000-000000000092';
select pg_temp.base_error('select pg_temp.h_claim()', '42501', 'orchestrator is unavailable');
rollback to savepoint h667_gate;

-- 4. The heartbeat: written when more than 5 seconds old, left alone (no new row version) when fresher.
do $$
declare v_seen timestamptz; v_row tid;
begin
	update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() - interval '10 seconds'
	where id = '92400000-0000-4000-8000-000000000092';
	perform pg_temp.h_claim();
	select last_heartbeat_at into strict v_seen from public.qorpera_runner_orchestrators
	where id = '92400000-0000-4000-8000-000000000092';
	perform pg_temp.base_assert(v_seen = statement_timestamp(), 'a stale heartbeat is written: ' || v_seen::text);
	update public.qorpera_runner_orchestrators set last_heartbeat_at = statement_timestamp() - interval '2 seconds'
	where id = '92400000-0000-4000-8000-000000000092';
	select ctid into strict v_row from public.qorpera_runner_orchestrators where id = '92400000-0000-4000-8000-000000000092';
	perform pg_temp.h_claim();
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_runner_orchestrators
		where id = '92400000-0000-4000-8000-000000000092' and ctid = v_row
			and last_heartbeat_at = statement_timestamp() - interval '2 seconds'), 'a fresh heartbeat is not rewritten');
end $$;

-- 5. An expired lease waits for the reconcile: a claim neither requeues nor takes it; after a reconcile the next
-- claim does. A replay of that claim also passes the gate first.
do $$
declare v_job uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid; v_work jsonb;
begin
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = v_job;
	v_work := pg_temp.h_claim();
	perform pg_temp.base_assert(v_work #>> '{work,job_id}' is null
		and (select status from public.qorpera_runner_jobs where id = v_job) = 'leased',
		'a claim leaves the expired lease to the reconcile: ' || v_work::text);
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert((select status from public.qorpera_runner_jobs where id = v_job) = 'queued',
		'the reconcile requeues the job');
	-- The fresh retry waits first (20260930537000); then the wait is over.
	perform pg_temp.base_assert(pg_temp.h_claim() #>> '{work,job_id}' is null, 'the fresh retry waits');
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp(), queued_at = statement_timestamp()
	where id = v_job;
	v_work := pg_temp.h_claim('66700000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v_work #>> '{work,job_id}' = v_job::text, 'the next claim takes it: ' || v_work::text);
	perform set_config('qorpera_test.h667_claim', v_work ->> 'claim_id', true);
end $$;
savepoint h667_replay;
update public.qorpera_runner_orchestrators set status = 'draining' where id = '92400000-0000-4000-8000-000000000092';
select pg_temp.base_error('select pg_temp.h_claim(''66700000-0000-4000-8000-000000000001'')', '42501',
	'orchestrator is unavailable');
rollback to savepoint h667_replay;
select pg_temp.base_assert(pg_temp.h_claim('66700000-0000-4000-8000-000000000001') ->> 'claim_id'
	= current_setting('qorpera_test.h667_claim'), 'an active orchestrator replays its claim');

-- 6. The sweep of expired reserved model requests reads the partial index (enable_seqscan off: the table is empty, so
-- this shows only that the sweep's condition matches the index's), and quarantines a finished job's requests only.
set local enable_seqscan = off;
do $$
declare v_plan text;
begin
	execute 'explain (format json) select request.job_id from public.qorpera_runner_model_requests as request '
		|| 'where request.status = ''reserved'' and request.reservation_expires_at <= statement_timestamp()' into v_plan;
	perform pg_temp.base_assert(position('qorpera_runner_model_requests_reserved_expiry' in v_plan) > 0, 'the plan: ' || v_plan);
end $$;
reset enable_seqscan;
savepoint h667_sweep;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_job uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
	v_request uuid := extensions.gen_random_uuid();
	v_events bigint;
begin
	insert into public.qorpera_runner_model_requests(id, job_id, profile_id, environment_id, runner_id, actor_user_id,
		authorized_by_user_id, client_request_id, provider, model, request_sha256, input_token_reservation,
		output_token_reservation, reservation_expires_at)
	values (v_request, v_job, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		(v_binding ->> 'runnerId')::uuid, '92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid(), 'openai', 'test-model', repeat('a', 64), 1, 1, statement_timestamp() - interval '1 minute');
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert((select status from public.qorpera_runner_model_requests where id = v_request) = 'reserved',
		'an unfinished job''s request stays reserved');
	select count(*) into v_events from public.qorpera_execution_run_events
	where run_id = (v_binding ->> 'runId')::uuid and event_type = 'review_pending';
	update public.qorpera_runner_jobs set status = 'failed', finished_at = statement_timestamp(), last_error = 'Test 667'
	where id = v_job;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_runner_model_requests where id = v_request
		and status = 'ambiguous' and error_code = 'gateway_outcome_unknown'), 'a finished job''s request is quarantined');
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_run_events
		where run_id = (v_binding ->> 'runId')::uuid and event_type = 'review_pending'
			and payload ->> 'reason' = 'ambiguous_model_usage') = v_events + 1, 'the run is marked for review once');
end $$;
rollback to savepoint h667_sweep;

rollback;
