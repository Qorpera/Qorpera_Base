-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-2b part 1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6): a folder-v2 run's operation
-- receipts, and the commits that satisfy them. A receipt begins and completes on the folder fence; a commit carries at
-- most one receipt and a receipt is satisfied by at most one commit, whatever its outcomes; completion names the commit.
-- The commit also takes the hook's session targets (rank 11). Runs are 647's hand-built runs with their native rows;
-- coworker runs are used where the tool call must not first owe an acknowledgement. Races are in 651.

create function pg_temp.coworker() returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000002'); v jsonb;
begin
	v := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'agent', '63400000-0000-4000-8000-000000000002', 'coworker', p);
	return jsonb_build_object('actor', v, 'binding', pg_temp.native(v));
end $$;
create function pg_temp.begin(p_binding jsonb, p_receipt uuid, p_key text, p_requires boolean default true, p_input text default repeat('a', 64))
returns jsonb language sql as $$
	select public.qorpera_begin_native_tool_operation(p_binding, p_receipt, p_key, p_input, repeat('b', 64), p_requires)
$$;
create function pg_temp.complete(p_binding jsonb, p_receipt uuid, p_commit uuid, p_result jsonb default '{"ok":true}')
returns jsonb language sql as $$
	select public.qorpera_folder_complete_run_receipt(p_binding, p_receipt, repeat('a', 64), p_result, p_commit)
$$;
create function pg_temp.rcommit(p_actor jsonb, p_key text, p_units jsonb, p_receipt uuid) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', p_actor, p_key, p_units, null, p_receipt)
$$;

-- 1. Begin: through the legacy entry point, on the folder fence; a replay returns the receipt; the same key for other
-- work refuses; one unresolved operation per run; the budget counts it.
do $$
declare w jsonb := pg_temp.coworker(); b jsonb := w -> 'binding'; r uuid := extensions.gen_random_uuid(); x jsonb;
begin
	x := pg_temp.begin(b, r, 'op-one');
	if x ->> 'state' <> 'executing' or x ->> 'receipt_id' <> r::text or x ->> 'run_id' <> b ->> 'runId' then
		raise exception 'Folder receipt begin: %', x; end if;
	if (select operation_count from public.qorpera_execution_run_budgets where run_id = (b ->> 'runId')::uuid) <> 1 then
		raise exception 'The budget counts the operation'; end if;
	if (select to_jsonb(o) - 'created_at' from public.qorpera_run_operation_receipts o where id = r)
		<> jsonb_build_object('id', r, 'run_id', b ->> 'runId', 'job_id', b ->> 'jobId', 'assignment_id', b ->> 'assignmentId',
			'logical_operation_key', 'op-one', 'operation_kind', 'cloud_tool', 'input_sha256', repeat('a', 64),
			'downstream_idempotency_sha256', repeat('b', 64), 'requires_company_revision', true, 'status', 'executing',
			'result', null, 'output_snapshot_id', null, 'proposal_id', null, 'completed_at', null, 'recovery_resolution', null,
			'recovery_resolved_by_user_id', null, 'recovery_resolved_at', null, 'company_path_proposal_id', null,
			'folder_commit_id', null) then
		raise exception 'The receipt row: %', (select to_jsonb(o) from public.qorpera_run_operation_receipts o where id = r); end if;
	x := pg_temp.begin(b, extensions.gen_random_uuid(), 'op-one');
	if x ->> 'receipt_id' <> r::text or x ->> 'state' <> 'executing' then raise exception 'A begin replay: %', x; end if;
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L, true, %L)', b, extensions.gen_random_uuid(), 'op-one', repeat('c', 64)),
		'23505', 'logical operation key is already bound to other work');
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L)', b, extensions.gen_random_uuid(), 'op-two'),
		'55000', 'run has an unresolved operation');
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L, null)', b, extensions.gen_random_uuid(), 'op-three'),
		'22023', 'native tool operation is invalid');
	-- The run check under it: a stopped company refuses before any receipt.
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id) values (%L)', '63400000-0000-4000-8000-000000000010'));
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L)', b, extensions.gen_random_uuid(), 'op-four'), '55000',
		'Company execution is paused');
	perform pg_temp.fx('delete from public.qorpera_company_deletions where profile_id = ''63400000-0000-4000-8000-000000000010''');
end $$;

-- 2. The wake's work gate runs under the folder begin: a human run that owes an acknowledgement refuses.
do $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
begin
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L)', pg_temp.native(p), extensions.gen_random_uuid(), 'op-ack'),
		'55000', 'Wake requires an acknowledgement before work');
end $$;

-- 3. A commit carries the receipt; completion names it. One commit per receipt: a replay replays, the same key with
-- another receipt is another change set, and a second commit with the same receipt refuses. A completed receipt is
-- no longer carried.
do $$
declare w jsonb := pg_temp.coworker(); v jsonb := w -> 'actor'; b jsonb := w -> 'binding'; r uuid := extensions.gen_random_uuid();
	c jsonb; x jsonb; v_units constant jsonb := '[{"op":"mkdir","path":"receipt-one"}]';
begin
	perform pg_temp.begin(b, r, 'op-commit');
	c := pg_temp.rcommit(v, 'receipt-commit-1', v_units, r);
	perform pg_temp.expect(c, 1, 'saved');
	if (select receipt_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) is distinct from r then
		raise exception 'The commit records its receipt'; end if;
	if (pg_temp.rcommit(v, 'receipt-commit-1', v_units, r) ->> 'replay')::boolean is not true then
		raise exception 'A commit replay with its receipt must replay'; end if;
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-commit-1', v_units, extensions.gen_random_uuid()),
		'22023', 'Operation key was used for a different change set');
	perform pg_temp.raises_like(format('select pg_temp.commit(%L, %L, %L)', v, 'receipt-commit-1', v_units),
		'22023', 'Operation key was used for a different change set');
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-commit-2', '[{"op":"mkdir","path":"receipt-two"}]', r),
		'22023', 'Run receipt is already satisfied by another commit');
	x := pg_temp.complete(b, r, (c ->> 'commitId')::uuid);
	if x ->> 'state' <> 'completed' or x ->> 'folder_commit_id' <> c ->> 'commitId' then raise exception 'Completion: %', x; end if;
	if (select folder_commit_id from public.qorpera_run_operation_receipts where id = r)::text <> c ->> 'commitId' then
		raise exception 'The receipt records its commit'; end if;
	if pg_temp.complete(b, r, (c ->> 'commitId')::uuid) <> x then raise exception 'A completion replay returns the receipt'; end if;
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L, null)', b, r), '23505', 'run operation completion replay differs');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L, %L, %L)', b, r, c ->> 'commitId', '{"ok":false}'), '23505',
		'run operation completion replay differs');
	-- Completed, the receipt is no longer carried; the run is free for its next operation.
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-commit-3', '[{"op":"mkdir","path":"receipt-three"}]', r),
		'42501', 'Run receipt is unavailable');
	if pg_temp.begin(b, extensions.gen_random_uuid(), 'op-next') ->> 'state' <> 'executing' then raise exception 'The next operation'; end if;
end $$;

-- 4. Whatever its outcomes, a commit satisfies its receipt: a conflicted commit saved nothing, and completes it. A
-- receipt that requires a revision does not complete without its commit, or with a commit that does not carry it.
do $$
declare w jsonb := pg_temp.coworker(); v jsonb := w -> 'actor'; b jsonb := w -> 'binding'; r uuid := extensions.gen_random_uuid();
	other jsonb; c jsonb;
begin
	perform pg_temp.begin(b, r, 'op-conflict');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L, null)', b, r), '55000', 'Company folder operation has no commit');
	other := pg_temp.commit(v, 'receipt-other-1', '[{"op":"mkdir","path":"receipt-other"}]');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L, %L)', b, r, other ->> 'commitId'), '55000',
		'Company folder commit does not carry this receipt');
	c := pg_temp.rcommit(v, 'receipt-conflict-1', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'receipt-other')), r);
	perform pg_temp.expect(c, 1, 'conflict', 'exists');
	if c -> 'seq' <> 'null'::jsonb then raise exception 'A commit that saved nothing has no seq'; end if;
	if pg_temp.complete(b, r, (c ->> 'commitId')::uuid) ->> 'state' <> 'completed' then raise exception 'A conflicted commit completes its receipt'; end if;
	-- The redo takes a new receipt.
	r := extensions.gen_random_uuid();
	perform pg_temp.begin(b, r, 'op-conflict:redo');
	perform pg_temp.expect(pg_temp.rcommit(v, 'receipt-conflict-2', '[{"op":"mkdir","path":"receipt-redo"}]', r), 1, 'saved');
end $$;

-- 5. Only the run's own executing receipt that requires a revision is carried, and only by a run.
do $$
declare w jsonb := pg_temp.coworker(); v jsonb := w -> 'actor'; b jsonb := w -> 'binding';
	w2 jsonb := pg_temp.coworker(); r uuid := extensions.gen_random_uuid(); r2 uuid := extensions.gen_random_uuid(); x jsonb;
begin
	perform pg_temp.begin(w2 -> 'binding', r2, 'op-other-run');
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-foreign-1', '[{"op":"mkdir","path":"receipt-foreign"}]', r2),
		'42501', 'Run receipt is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-missing-1', '[{"op":"mkdir","path":"receipt-missing"}]',
		extensions.gen_random_uuid()), '42501', 'Run receipt is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', pg_temp.member(1), 'receipt-member-1',
		'[{"op":"mkdir","path":"receipt-member"}]', r2), '22023', 'Only a run carries a receipt');
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', '{"kind":"platform"}', 'receipt-platform-1',
		'[{"op":"mkdir","path":"receipt-platform"}]', r2), '22023', 'Only a run carries a receipt');
	-- A receipt that requires no revision is not carried, and completes through the legacy entry point without one.
	perform pg_temp.begin(b, r, 'op-no-revision', false);
	perform pg_temp.raises_like(format('select pg_temp.rcommit(%L, %L, %L, %L)', v, 'receipt-norev-1', '[{"op":"mkdir","path":"receipt-norev"}]', r),
		'42501', 'Run receipt is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_complete_native_tool_operation(%L, %L, %L, %L, %L)', b, r, repeat('a', 64), '{}',
		extensions.gen_random_uuid()), '22023', 'A folder-v2 operation completes with its folder commit');
	x := public.qorpera_complete_native_tool_operation(b, r, repeat('a', 64), '{"done":true}', null, null);
	if x ->> 'state' <> 'completed' or x -> 'folder_commit_id' <> 'null'::jsonb then raise exception 'Legacy entry completion: %', x; end if;
end $$;

-- 6. Session targets (rank 11): the hook may name the sessions its apply step writes, FOR UPDATE only; anything else
-- at rank 11 is a defect. The hook is swapped for this block and put back.
do $$
declare v_saved text := pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure);
	v_session uuid;
begin
	insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, audience_kind)
	values (extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Group',
		'63400000-0000-4000-8000-000000000001', 'company') returning id into v_session;
	create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
	returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
		select (t ->> 'rank')::smallint, t ->> 'tbl', t ->> 'key', t ->> 'mode'
		from jsonb_array_elements(coalesce(current_setting('qorpera_test.targets', true), '[]')::jsonb) t
	$f$;
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions',
		'key', v_session, 'mode', 'update'))::text, true);
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'sessions-target-1', '[{"op":"mkdir","path":"sessions-one"}]'), 1, 'saved');
	-- A session that is gone is not required of the hook: the apply step may create it (C1C §5.6 step 2).
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions',
		'key', extensions.gen_random_uuid(), 'mode', 'update'))::text, true);
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'sessions-target-2', '[{"op":"mkdir","path":"sessions-two"}]'), 1, 'saved');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions',
		'key', v_session, 'mode', 'keyshare'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'sessions-bad-1', '[{"op":"mkdir","path":"sessions-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_profile_staff',
		'key', v_session, 'mode', 'update'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'sessions-bad-2', '[{"op":"mkdir","path":"sessions-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_shared_sessions',
		'key', v_session, 'mode', 'update'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'sessions-bad-3', '[{"op":"mkdir","path":"sessions-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions',
		'key', 'not-a-uuid', 'mode', 'update'))::text, true);
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'sessions-bad-4', '[{"op":"mkdir","path":"sessions-bad"}]'), 'XX000');
	perform set_config('qorpera_test.targets', '[]', true);
	execute v_saved;
	-- The lock helper itself refuses a required session that is gone.
	perform public.qorpera_folder_lock_sessions('63400000-0000-4000-8000-000000000020', jsonb_build_array(jsonb_build_object('rank', 11,
		'tbl', 'qorpera_shared_sessions', 'key', v_session, 'mode', 'update', 'required', true)));
	perform pg_temp.raises_like(format('select public.qorpera_folder_lock_sessions(%L, %L)', '63400000-0000-4000-8000-000000000020',
		jsonb_build_array(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', extensions.gen_random_uuid(), 'mode', 'update',
			'required', true))), '42501', 'A session this change set relies on is unavailable');
end $$;

-- 7. Snapshot-v1 controls, the replaced signature and privileges.
do $$
declare s jsonb := current_setting('qorpera_test.snapshot_binding')::jsonb;
begin
	-- The legacy bodies run for snapshot-v1: the legacy run check refuses the hand-made binding in its lease check.
	perform pg_temp.raises_like(format('select pg_temp.begin(%L, %L, %L)', s, extensions.gen_random_uuid(), 'op-snapshot'), '42501',
		'native execution binding is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_complete_native_tool_operation(%L, %L, %L, %L)', s, extensions.gen_random_uuid(),
		repeat('a', 64), '{}'), '42501', 'native execution binding is unavailable');
	-- One commit function, never two (PostgREST could not choose).
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit') <> 1
		or to_regprocedure('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)') is null then
		raise exception 'The commit must have exactly its six-argument signature'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_lock_sessions(uuid,jsonb)', 'execute') then
		raise exception 'Receipt privileges'; end if;
end $$;

rollback;
