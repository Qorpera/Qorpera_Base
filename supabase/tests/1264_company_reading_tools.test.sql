-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- 20260930766000 (the company's reading of itself): end_role sets an agent's agent.md to archived, a delegation, so the
-- review recorder takes an end_role approval for the run's change set and the commit saves it under that review; an
-- approval of update_reading, whose saves are plain and never reviewed, stays refused, as does an end_role approval of
-- another effect. The observation vocabulary names update_reading and end_role after make_picture, and the recorder
-- names end_role after company_move. qorpera_folder_run_receipt_exists (review r2 of #1819) answers whether the calling
-- run has a receipt under a key, the run's own only, to the runtime's role only. Only those three bodies carry the
-- marker.

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
begin
	u := jsonb_build_array(pg_temp.deletes('rr1.txt'));
	-- update_reading writes no reviewed change set: its approval is refused.
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'reading-approved', 'allow', 'delegation', 'update_reading'), u),
		'42501', 'This change has no approval in this run');
	-- An end_role approval of an outside effect stands for no folder units.
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'end-role-external', 'allow', 'external', 'end_role'), u),
		'42501', 'This change has no approval in this run');
	-- Without a review the change waits.
	perform pg_temp.expect(pg_temp.commit(p, 'end-role-none', u), 1, 'denied', 'review_required');
	if not pg_temp.present('rr1.txt') then raise exception 'A change without a review was saved'; end if;
	-- Approved as end_role's delegation: recorded, and the commit saves the change under the review.
	r := pg_temp.record(b, pg_temp.action(b, 'end-role-own', 'allow', 'delegation', 'end_role'), u);
	c := pg_temp.commit(p, 'end-role-reviewed', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if pg_temp.present('rr1.txt') then raise exception 'The reviewed change was not saved: %', c; end if;
end $$;

-- The receipt lookup: none, then the run's own receipt under the key; another run sees none; another key none; only the
-- runtime's role, a run actor and a key of 1 to 256 characters.
do $$
declare x jsonb := pg_temp.agent_run(); p jsonb := x -> 'actor'; y jsonb := pg_temp.agent_run(); q jsonb := y -> 'actor';
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
begin
	perform pg_temp.path_claims('service_role');
	if public.qorpera_folder_run_receipt_exists(c_env, p, 'end_role:end-role:k1') then
		raise exception 'A receipt was found before any began'; end if;
	-- A receipt as the folder core's begin inserts it (20260928279540).
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, requires_company_revision)
	values (extensions.gen_random_uuid(), (p ->> 'runId')::uuid, (p ->> 'jobId')::uuid, (p ->> 'assignmentId')::uuid,
		'end_role:end-role:k1', 'cloud_tool', repeat('a', 64), repeat('b', 64), true);
	set local session_replication_role = origin;
	if not public.qorpera_folder_run_receipt_exists(c_env, p, 'end_role:end-role:k1')
		or not public.qorpera_folder_run_receipt_exists(c_env, p, '  end_role:end-role:k1 ') then
		raise exception 'The run''s own receipt was not found'; end if;
	if public.qorpera_folder_run_receipt_exists(c_env, p, 'end_role:end-role:k2') then
		raise exception 'Another key was found'; end if;
	if public.qorpera_folder_run_receipt_exists(c_env, q, 'end_role:end-role:k1') then
		raise exception 'Another run''s receipt was found'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_receipt_exists(%L, %L, %L)', c_env, p, ''),
		'22023', 'Receipt key is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_receipt_exists(%L, %L, %L)', c_env,
		'{"kind":"platform"}', 'end_role:end-role:k1'), '42501', 'Receipt authority is unavailable');
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000002');
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_receipt_exists(%L, %L, %L)', c_env, p,
		'end_role:end-role:k1'), '42501', 'Folder core authority is required');
	perform pg_temp.path_claims('service_role');
	if has_function_privilege('authenticated', 'public.qorpera_folder_run_receipt_exists(uuid,jsonb,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_run_receipt_exists(uuid,jsonb,text)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_run_receipt_exists(uuid,jsonb,text)', 'execute')
		or not exists (select 1 from public.qorpera_native_host_calls
			where name = 'qorpera_folder_run_receipt_exists' and scope = 'folder') then
		raise exception 'The receipt lookup''s grants or host call differ'; end if;
end $$;

-- The vocabulary and the recorder, and the marker in exactly those three bodies.
do $$
declare v_observation text := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
	v_recorder text := pg_get_functiondef('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure);
begin
	-- After make_picture, not next to it: a later migration that anchors on the same line puts its names between.
	if strpos(v_observation, $q$/* 20260930766000 */'update_reading','end_role',$q$)
		<= strpos(v_observation, $q$/* 20260930746000 */'make_picture',$q$) then
		raise exception 'The observation vocabulary does not name update_reading and end_role after make_picture'; end if;
	if strpos(v_recorder, $q$'end_role' /* 20260930766000 */$q$)
		<= strpos(v_recorder, $q$'company_move' /* 20260930525000 */$q$) then
		raise exception 'The recorder does not name end_role after company_move'; end if;
end $$;

rollback;
