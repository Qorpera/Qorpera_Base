-- @fixture 988_runtime_coding_busy_checkins.test.sql until "-- 1. Busy for less than an hour"
-- C5 (20260930508000) with the beta off, for a coding turn's run (W6a, 20260930250000). Test 924's company never chose
-- Shared context. The owner answers coding session a, the session's machine begins its second turn, and the run the
-- materializer makes for the turn is recorded with Agent notebooks, with no run log place and no view (921's path).

create function pg_temp.ct_turn(p_worker uuid, p_sequence integer) returns public.qorpera_coding_session_turns language sql as $$
	select * from public.qorpera_coding_session_turns where worker_id = p_worker and sequence = p_sequence
$$;

do $$
declare v_claim jsonb; v_begin jsonb; v_pass jsonb; v_bind jsonb; v_token uuid; v_run uuid; t public.qorpera_coding_session_turns;
begin
	perform pg_temp.c3_answer('98800000-0000-4000-8000-0000000000b1', 'Keep the old route.');
	t := pg_temp.ct_turn('98800000-0000-4000-8000-0000000000b1', 2);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = t.worker_id::text, 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(t.worker_id)).lease_token;
	v_begin := public.qorpera_begin_coding_turn(t.worker_id, v_token, '{}');
	t := pg_temp.ct_turn(t.worker_id, 2);
	perform pg_temp.base_assert(t.occurrence_id = (v_begin ->> 'occurrenceId')::uuid, 'the begin''s occurrence: ' || to_jsonb(t)::text);
	v_pass := pg_temp.base_materialize();
	v_run := (select o.run_id from public.qorpera_wake_occurrences o where o.id = t.occurrence_id);
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'the turn''s run: ' || v_pass::text);
	v_bind := pg_temp.base_start(v_run);
	perform pg_temp.base_assert((select memory_mode from public.qorpera_execution_runs where id = v_run) = 'notebooks',
		'the turn''s run is recorded with notebooks');
	perform pg_temp.base_assert(public.qorpera_memory_run_log_place('92400000-0000-4000-8000-000000000020', v_run) = '{"off":true}'::jsonb,
		'the turn''s run has no run log place');
	perform pg_temp.base_assert(public.qorpera_memory_view(v_bind) is null and public.qorpera_memory_view_of(v_run) is null,
		'the turn''s run has no view');
end
$$;

rollback;
