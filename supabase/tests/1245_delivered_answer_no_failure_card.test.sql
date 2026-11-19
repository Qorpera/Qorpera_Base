-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930751000: a run that already sent its final message shows no failure under its answer. The agents' activity read
-- (qorpera_list_staff_execution_activity) called every failed run of an agent 'needs_attention', so a run that answered
-- its member and then failed put a card under that answer, with Try again while it had saved nothing durable, which
-- would answer the same message twice. The answer first (20260930748000) widens that window from 0.13 s to the run's
-- bookkeeping tail, so the hole is closed here. On 924's base (Alice's live run of the owner's post in her thread, a
-- room_delivery run on a real runner with a native lease), each case in a savepoint of its own:
-- 1. A failed run that sent nothing is listed as before: one row, job failed, needs_attention, with the keys a member
--    reads. A progress send is no answer: it is still listed.
-- 2. A failed run that sent its final message is not listed at all, for any member: the thread shows the answer alone.
--    The failure itself is kept (the job, its error, the run's row), for whoever looks after the platform.
-- 3. Unless its work left an open proposal: that decision is still listed, as the one the member must make.
-- 4. A member's Stop is unchanged (never a failure), also after a final send, and the stop's ranking line stays.
-- 5. A completed run with its final send is listed by nothing new, and another agent's failure is untouched.
-- 6. The function's grants, its earlier rules and the markers.
-- Without 20260930751000 case 2 fails (the run is listed): that is the control run named in the report.
-- Everything is rolled back at the end.

create function pg_temp.da_binding() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
create function pg_temp.da_run() returns text language sql as $$
	select pg_temp.da_binding() ->> 'runId'
$$;
-- What a member sees of one agent: its rows in the list's order, without the times, phase and agent (as 469 reads them).
create function pg_temp.da_rows(p_member text, p_staff text) returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_rows jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_member::uuid);
	set local role authenticated;
	select coalesce(jsonb_agg(list.entry - 'updated_at' - 'phase' - 'staff_agent_id' order by list.n), '[]'::jsonb) into v_rows
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020'))
		with ordinality as list(entry, n)
	where list.entry ->> 'staff_agent_id' = p_staff;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_rows;
end $$;
-- Alice's rows, as the owner reads them.
create function pg_temp.da_alice() returns jsonb language sql as $$
	select pg_temp.da_rows('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030')
$$;
-- The keys of the run's own entry, as the owner reads them.
create function pg_temp.da_keys() returns text[] language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_keys text[];
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	select array_agg(key order by key) into v_keys
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020')) entry,
		jsonb_object_keys(entry) key
	where entry ->> 'run_id' = pg_temp.da_run();
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_keys;
end $$;
create function pg_temp.da_row(p_status text, p_activity text) returns jsonb language sql as $$
	select jsonb_build_object('run_id', pg_temp.da_run(), 'source_kind', 'room_delivery', 'job_status', p_status,
		'activity', p_activity)
$$;
-- The run's job fails, as its runner reports it (the real call, as 1195 makes it).
create function pg_temp.da_fail() returns void language plpgsql as $$
begin
	perform public.qorpera_fail_runner_job((pg_temp.da_binding() ->> 'runnerId')::uuid, repeat('2', 64),
		(pg_temp.da_binding() ->> 'jobId')::uuid, repeat('3', 64), 'Qorpera lost contact with this run', false);
end $$;
-- The owner's Stop on the run, through the real call (as 586 makes one): the activity read looks at who cancelled it.
create function pg_temp.da_stop() returns void language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_job jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_job := public.qorpera_cancel_runner_job((pg_temp.da_binding() ->> 'jobId')::uuid);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform pg_temp.base_assert(v_job ->> 'status' = 'cancelled' and (select cancelled_by_user_id is not null
		from public.qorpera_runner_jobs where id = (pg_temp.da_binding() ->> 'jobId')::uuid),
		'Fixture: the owner''s Stop records them: ' || v_job::text);
end $$;
-- An open Company File proposal of the run's, as the runtime leaves one for a member's decision (as 469 writes it).
create function pg_temp.da_proposal() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_proposals (profile_id, environment_id, client_proposal_id, proposal_snapshot_id,
		execution_kind, execution_id, execution_claimant_id, trail_end_sequence, reason, title, created_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 'run', pg_temp.da_run()::uuid, extensions.gen_random_uuid(), 0,
		'recovery', 'The price list', '92400000-0000-4000-8000-000000000001');
	set local session_replication_role = origin;
end $$;
select pg_temp.base_claims('service_role');

-- The fixture's run is Alice's live room_delivery run, and she has nothing else.
select pg_temp.base_assert((select run.source_kind = 'room_delivery' and job.status = 'leased'
	from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
	where run.id = pg_temp.da_run()::uuid), 'Fixture: Alice''s run is leased, from a post in her thread');
select pg_temp.base_assert(pg_temp.da_alice() = jsonb_build_array(pg_temp.da_row('leased', 'working')),
	'Fixture: Alice reads as working: ' || pg_temp.da_alice()::text);

-- 1. A failed run that answered nothing is listed, as before -----------------------------------------------------------
savepoint da_silent;
select pg_temp.da_fail();
select pg_temp.base_assert(pg_temp.da_alice() = jsonb_build_array(pg_temp.da_row('failed', 'needs_attention')),
	'1: a failure with no answer still stands for the agent: ' || pg_temp.da_alice()::text);
-- Every member reads the same, and the entry keeps the keys the web takes.
select pg_temp.base_assert(pg_temp.da_rows('92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000030')
	= jsonb_build_array(pg_temp.da_row('failed', 'needs_attention')), '1: the viewer reads it too');
-- A failed entry carries no phase (only work in progress has one).
select pg_temp.base_assert(pg_temp.da_keys() = array['activity','job_status','run_id','source_kind',
	'staff_agent_id','updated_at'], '1: the entry keeps its keys: ' || array_to_string(pg_temp.da_keys(), ','));
rollback to savepoint da_silent;

-- A progress send is no answer: such a run is still listed.
savepoint da_progress;
select pg_temp.base_public_send(pg_temp.da_binding(), 'progress', 'da-ack') is not null;
select pg_temp.da_fail();
select pg_temp.base_assert(pg_temp.da_alice() = jsonb_build_array(pg_temp.da_row('failed', 'needs_attention')),
	'1: a progress message is no answer, so the failure still stands: ' || pg_temp.da_alice()::text);
rollback to savepoint da_progress;

-- 2. A failed run that sent its final message is not listed ---------------------------------------------------------
savepoint da_delivered;
select pg_temp.base_public_send(pg_temp.da_binding(), 'progress', 'da-ack') is not null;
select pg_temp.base_public_send(pg_temp.da_binding(), 'final', 'da-final') is not null;
select pg_temp.da_fail();
select pg_temp.base_assert(pg_temp.da_alice() = '[]'::jsonb,
	'2: a delivered answer shows no failure under it: ' || pg_temp.da_alice()::text);
select pg_temp.base_assert(pg_temp.da_rows('92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000030')
	= '[]'::jsonb, '2: no member sees one');
-- The failure itself is kept for whoever looks after the platform.
select pg_temp.base_assert((select job.status = 'failed' and job.last_error is not null
	from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id = job.id
	where run.id = pg_temp.da_run()::uuid), '2: the job keeps its failure and its error');
-- Only this run's own final counts: a send of another run does not hide this failure. (The second run is Bob's, so
-- Alice's row is read as before.)
select pg_temp.base_assert((select count(*) from public.qorpera_agent_sends
	where run_id = pg_temp.da_run()::uuid and phase = 'final') = 1, '2: the run has exactly one final send');
rollback to savepoint da_delivered;

-- 3. Unless its work left a decision ----------------------------------------------------------------------------------
savepoint da_proposal;
select pg_temp.base_public_send(pg_temp.da_binding(), 'final', 'da-final') is not null;
select pg_temp.da_proposal();
select pg_temp.da_fail();
select pg_temp.base_assert(pg_temp.da_alice() = jsonb_build_array(pg_temp.da_row('failed', 'needs_attention')),
	'3: a delivered run whose change waits for a decision is still listed: ' || pg_temp.da_alice()::text);
rollback to savepoint da_proposal;

-- 4. A member's Stop is unchanged --------------------------------------------------------------------------------------
savepoint da_stop;
select pg_temp.base_public_send(pg_temp.da_binding(), 'final', 'da-final') is not null;
select pg_temp.da_stop();
select pg_temp.base_assert(pg_temp.da_alice() = '[]'::jsonb,
	'4: a stopped run is no failure, as before: ' || pg_temp.da_alice()::text);
rollback to savepoint da_stop;
savepoint da_stop_silent;
select pg_temp.da_stop();
select pg_temp.base_assert(pg_temp.da_alice() = '[]'::jsonb,
	'4: a stopped run with no answer is no failure either: ' || pg_temp.da_alice()::text);
rollback to savepoint da_stop_silent;

-- 5. A completed run, and another agent's failure --------------------------------------------------------------------
savepoint da_completed;
select pg_temp.base_public_send(pg_temp.da_binding(), 'final', 'da-final') is not null;
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = clock_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = pg_temp.da_run()::uuid and status = 'leased';
select pg_temp.base_assert(pg_temp.da_alice() = '[]'::jsonb,
	'5: a completed run with its answer is listed by nothing: ' || pg_temp.da_alice()::text);
rollback to savepoint da_completed;

-- 6. Grants, the earlier rules and the markers --------------------------------------------------------------------------
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not exists (select 1 from pg_proc, aclexplode(proacl) acl
		where pg_proc.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure and acl.grantee = 0),
	'6: the activity list keeps its grants');

rollback;
