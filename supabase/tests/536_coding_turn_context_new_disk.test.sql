-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- 20260930515000 (F3 step 5g-5, part 3, PR C; C2): a coding turn's context says whether the session's machine got a new
-- disk since the previous turn began, as machine: {newDisk}. The machine is the session's vm_allocation_id, which the
-- rebuild's detach leaves; the new disk is a 'replaced' record of it (the rebuild's) at or after the previous turn's
-- begin (its wake occurrence), or when that turn opened if it never began. The first turn says false, and so does the
-- turn after the one that said it, unless the machine got another new disk since. An earlier rebuild, another machine's,
-- and a start's records say false. 928's helpers on 924's base: Alice's run and one coding session of hers, b1, on the
-- owner's machine d1 on exec-536; d2 is the owner's other machine there.

do $$
declare v_alice jsonb := pg_temp.c3_alice();
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-536', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'nd-dispatch', 'agents/alice/todos/fix-login/session-a',
		pg_temp.c3_brief('53600000-0000-4000-8000-0000000000b1')) -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch');
	-- The owner's two machines on exec-536, each pinned to its binding text as the first run authority pins it.
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	select ('53600000-0000-4000-8000-0000000000d' || n)::uuid, 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-536', repeat('7', 64), binding::jsonb,
		encode(extensions.digest(convert_to(binding, 'utf8'), 'sha256'), 'hex')
	from (values (1, '{}'), (2, '{"number":2}')) v(n, binding);
	set local session_replication_role = origin;
end $$;

-- The executor claims b1 and begins its open turn, whose run starts; answers the run's binding.
create function pg_temp.nd_turn() returns jsonb language plpgsql as $$
declare v_claim jsonb; v_pass jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-536', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '53600000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	perform public.qorpera_begin_coding_turn('53600000-0000-4000-8000-0000000000b1',
		(pg_temp.c3_session('53600000-0000-4000-8000-0000000000b1')).lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	return pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
end $$;
-- The turn's run ends, the executor completes the turn, and the owner answers: b1's next turn opens.
create function pg_temp.nd_next(p_binding jsonb, p_text text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (p_binding ->> 'jobId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('53600000-0000-4000-8000-0000000000b1',
		(pg_temp.c3_session('53600000-0000-4000-8000-0000000000b1')).lease_token, 'succeeded', 'Done.');
	perform pg_temp.c3_answer('53600000-0000-4000-8000-0000000000b1', p_text);
end $$;
-- The context the turn of p_binding reads, as its run reads it.
create function pg_temp.nd_context(p_binding jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_read_coding_turn_context(p_binding);
end $$;
-- A record of p_machine in p_state at p_at, as the executor's records leave one.
create function pg_temp.nd_record(p_machine uuid, p_state text, p_at timestamptz) returns void language sql as $$
	insert into public.qorpera_coding_machine_folder_restarts(machine_id, operation_id, state, recorded_at)
	values (p_machine, extensions.gen_random_uuid(), p_state, p_at)
$$;
-- Moves the rebuild's record (e1) to p_at.
create function pg_temp.nd_move(p_at timestamptz) returns void language sql as $$
	update public.qorpera_coding_machine_folder_restarts set recorded_at = p_at
	where machine_id = '53600000-0000-4000-8000-0000000000d1' and operation_id = '53600000-0000-4000-8000-0000000000e1'
$$;
-- When b1's turn p_sequence began: its wake occurrence was made.
create function pg_temp.nd_began(p_sequence integer) returns timestamptz language sql as $$
	select o.created_at from public.qorpera_coding_session_turns t join public.qorpera_wake_occurrences o on o.id = t.occurrence_id
	where t.worker_id = '53600000-0000-4000-8000-0000000000b1' and t.sequence = p_sequence
$$;

-- 1. The first turn says false (case 3), though b1's machine gets a new disk while it runs. The rebuild's record
--    detaches b1 (attached there) and leaves its vm_allocation_id ----------------------------------------------------------
do $$
declare b1 constant uuid := '53600000-0000-4000-8000-0000000000b1'; d1 constant uuid := '53600000-0000-4000-8000-0000000000d1';
	v_turn jsonb := pg_temp.nd_turn(); v_result jsonb; v_context jsonb;
begin
	update public.qorpera_coding_sessions set vm_allocation_id = d1 where worker_id = b1;
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set attached_machine_id = d1, attachment_token = extensions.gen_random_uuid(),
		attachment_until = clock_timestamp() + interval '10 minutes', attachment_turn = 1, attached_at = clock_timestamp(),
		observed_at = clock_timestamp()
	where worker_id = b1;
	update public.qorpera_coding_machines set folder_restart_at = clock_timestamp(), new_disk_at = clock_timestamp() where id = d1;
	set local session_replication_role = origin;
	perform pg_temp.base_claims('service_role');
	v_result := public.qorpera_record_coding_machine_new_disk(d1, '53600000-0000-4000-8000-0000000000e1', 'exec-536', '{}',
		repeat('7', 64));
	perform pg_temp.base_assert(v_result ->> 'state' = 'replaced'
		and v_result -> 'detached' @> jsonb_build_array(jsonb_build_object('workerId', b1))
		and (pg_temp.c3_session(b1)).attached_machine_id is null and (pg_temp.c3_session(b1)).vm_allocation_id = d1,
		'the rebuild detached b1 and left its machine: ' || v_result::text);
	v_context := pg_temp.nd_context(v_turn);
	perform pg_temp.base_assert(v_context ->> 'sequence' = '1' and v_context -> 'machine' = '{"newDisk":false}'
		and (select array_agg(k order by k collate "C") from jsonb_object_keys(v_context) k)
			= array['commands', 'earlierTurns', 'input', 'machine', 'omittedEarlierTurns', 'schema', 'sequence', 'workerId'],
		'the first turn: ' || v_context::text);
	perform pg_temp.nd_next(v_turn, 'Go on.');
end $$;

-- 2. Turn 2 says true: the rebuild was recorded after turn 1 began (case 2). Then, on the same turn: a rebuild at turn
--    1's begin says true, one before it false (case 1); turn 1's begin counts, not when it opened, unless it never began;
--    only a rebuild's record says it; another machine's says false (case 4), and the session's machine is its own -------
do $$
declare b1 constant uuid := '53600000-0000-4000-8000-0000000000b1'; d1 constant uuid := '53600000-0000-4000-8000-0000000000d1';
	d2 constant uuid := '53600000-0000-4000-8000-0000000000d2'; v_turn jsonb := pg_temp.nd_turn();
	v_began timestamptz := pg_temp.nd_began(1); v_recorded timestamptz; v_occurrence uuid; v_context jsonb;
begin
	select recorded_at into strict v_recorded from public.qorpera_coding_machine_folder_restarts
	where machine_id = d1 and operation_id = '53600000-0000-4000-8000-0000000000e1' and state = 'replaced';
	perform pg_temp.base_assert(v_recorded >= v_began and v_recorded < pg_temp.nd_began(2)
		and (pg_temp.c3_session(b1)).vm_allocation_id = d1, 'the rebuild came in turn 1: ' || v_began || ' ' || v_recorded);
	v_context := pg_temp.nd_context(v_turn);
	perform pg_temp.base_assert(v_context ->> 'sequence' = '2' and v_context -> 'machine' = '{"newDisk":true}',
		'turn 2: ' || v_context::text);
	perform pg_temp.nd_move(v_began);
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":true}', 'a rebuild at turn 1''s begin');
	perform pg_temp.nd_move(v_began - interval '1 millisecond');
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":false}', 'a rebuild before turn 1 began');
	-- Turn 1 opened an hour before it began; the rebuild came in between.
	set local session_replication_role = replica;
	update public.qorpera_coding_session_turns set created_at = v_began - interval '1 hour' where worker_id = b1 and sequence = 1
	returning occurrence_id into strict v_occurrence;
	set local session_replication_role = origin;
	perform pg_temp.nd_move(v_began - interval '30 minutes');
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":false}',
		'a rebuild after turn 1 opened, before it began');
	set local session_replication_role = replica;
	update public.qorpera_coding_session_turns set occurrence_id = null where worker_id = b1 and sequence = 1;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":true}',
		'turn 1 never begun: from when it opened');
	set local session_replication_role = replica;
	update public.qorpera_coding_session_turns set occurrence_id = v_occurrence where worker_id = b1 and sequence = 1;
	set local session_replication_role = origin;
	-- A start's records on d1 in turn 1, and a rebuild of d2 there.
	perform pg_temp.nd_move(v_began - interval '1 millisecond');
	perform pg_temp.nd_record(d1, s.state, v_began) from unnest(array['unmarked', 'restarted', 'new-disk']) s(state);
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":false}', 'a start''s records');
	perform pg_temp.nd_record(d2, 'replaced', v_began);
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":false}', 'another machine''s rebuild');
	update public.qorpera_coding_sessions set vm_allocation_id = d2 where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":true}', 'd2''s rebuild, were d2 b1''s');
	update public.qorpera_coding_sessions set vm_allocation_id = d1 where worker_id = b1;
	perform pg_temp.nd_move(v_recorded);
	perform pg_temp.nd_next(v_turn, 'And the signup page.');
end $$;

-- 3. Turn 3, after the turn that said it, says false: the rebuild came before turn 2 began. Another rebuild while turn 2
--    ran says true ------------------------------------------------------------------------------------------------------
do $$
declare v_turn jsonb := pg_temp.nd_turn(); v_context jsonb;
begin
	v_context := pg_temp.nd_context(v_turn);
	perform pg_temp.base_assert(v_context ->> 'sequence' = '3' and v_context -> 'machine' = '{"newDisk":false}',
		'turn 3: ' || v_context::text);
	perform pg_temp.nd_record('53600000-0000-4000-8000-0000000000d1', 'replaced', pg_temp.nd_began(2));
	perform pg_temp.base_assert(pg_temp.nd_context(v_turn) -> 'machine' = '{"newDisk":true}', 'a rebuild in turn 2');
end $$;

-- 4. The function names this migration and keeps its grants: only the service role reads a turn's context --------------
select pg_temp.base_assert(position('20260930515000' in pg_get_functiondef('public.qorpera_read_coding_turn_context(jsonb)'::regprocedure)) > 0
	and has_function_privilege('service_role', 'public.qorpera_read_coding_turn_context(jsonb)', 'execute')
	and not exists (select 1 from unnest(array['anon', 'authenticated', 'qorpera_secret_broker']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_read_coding_turn_context(jsonb)', 'execute')),
	'the turn context names 20260930515000; only the service role reads it');

rollback;
