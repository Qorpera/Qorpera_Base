-- @fixture 928_folder_coding_dispatch.test.sql until "-- 8. Session 1's turn on folder-v2"
-- 20260930669000: a coding turn whose model run completed but whose hand-in did not finish (the executor's summary
-- ending in [code=CODING_PUBLICATION_UNFINISHED]; own code storage, slice 0) reads as that, in plain words, with the code
-- as its reason: never "a problem on Qorpera's side". 928's base up to its §8: Alice's run, and coding session 1
-- dispatched for the owner on the owner's own codex-cli login, queued on exec-928.

set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('92800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-928', repeat('7', 64), '{}');
set local session_replication_role = origin;

do $$
declare v_claim jsonb; v_token uuid; v_begin jsonb; v_pass jsonb; v_turn jsonb; w public.qorpera_runtime_workers%rowtype;
	v_event jsonb;
	v_summary constant text := 'Handing in the work did not finish, so it may not have reached the repository yet. The work is '
		|| 'kept on the session''s branch; finishing again hands it in. [code=CODING_PUBLICATION_UNFINISHED]';
	v_words constant text := 'The coding turn did its work, but handing it in did not finish, so it may not have reached the '
		|| 'repository yet. Finishing again hands it in. The files the turn wrote stay in the session''s workspace as it '
		|| 'left them; a follow-up turn continues from them.';
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-928', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '92800000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('92800000-0000-4000-8000-0000000000b1')).lease_token;
	v_begin := public.qorpera_begin_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	-- The model run completed (its submission was a finish); the executor's hand-in did not.
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (v_turn ->> 'jobId')::uuid;
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', v_token, 'failed', v_summary);
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'failed' and w.result ->> 'summary' = v_words
		and w.result ->> 'reason' = 'CODING_PUBLICATION_UNFINISHED', 'the worker''s result: ' || w.result::text);
	v_event := (select body from public.qorpera_coding_session_events where worker_id = w.id and kind = 'failed'
		order by id desc limit 1);
	perform pg_temp.base_assert(v_event ->> 'summary' = v_words and v_event ->> 'code' = 'CODING_PUBLICATION_UNFINISHED',
		'the failed event: ' || coalesce(v_event::text, 'none'));
	-- Another code of the executor's still reads as Qorpera's own problem.
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'Broke. [code=CODING_SOMETHING_ELSE]') ->> 'summary'
		like 'The coding turn stopped because of a problem on Qorpera''s side.%', 'another code');
end $$;

select pg_temp.base_assert(position('20260930669000' in pg_get_functiondef(
	'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure)) > 0, 'the marker') \g /dev/null
