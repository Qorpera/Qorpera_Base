-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- 20260930525000 (QORPERA-RUNTIME-CONTRACT.md, the 2026-10-21 amendment, item 5): an agent moves or renames a
-- file with company_move, which the folder core reviews as a deletion. The recorder takes a company_move approval
-- (destructive, as company_delete's) for the run's move, and the commit then saves the move under that review; without
-- a review it waits. An approval of company_edit or company_write, which write no reviewed change sets, stays refused.
-- The observation vocabulary names company_edit and company_move.

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	v_tool text;
begin
	u := jsonb_build_array(jsonb_build_object('op', 'move', 'from', 'rr1.txt', 'to', 'rr1-renamed.txt',
		'expectedVersion', pg_temp.read('rr1.txt') -> 'entry' ->> 'version'));
	-- Approved for a tool that writes no reviewed change set: refused.
	foreach v_tool in array array['company_edit', 'company_write'] loop
		perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
			pg_temp.action(b, 'move-as-' || v_tool, 'allow', 'destructive', v_tool), u),
			'42501', 'This change has no approval in this run');
	end loop;
	perform pg_temp.expect(pg_temp.commit(p, 'move-none', u), 1, 'saved');
	if pg_temp.present('rr1.txt') or not pg_temp.present('rr1-renamed.txt') then
		raise exception 'A plain move without a review did not move the file'; end if;
	u := jsonb_build_array(jsonb_build_object('op', 'move', 'from', 'rr2.txt', 'to', 'rr2-renamed.txt',
		'expectedVersion', pg_temp.read('rr2.txt') -> 'entry' ->> 'version'));
	r := pg_temp.record(b, pg_temp.action(b, 'move-own', 'allow', 'destructive', 'company_move'), u);
	c := pg_temp.commit(p, 'move-reviewed', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if pg_temp.present('rr2.txt') or not pg_temp.present('rr2-renamed.txt') then
		raise exception 'The reviewed move did not move the file: %', c; end if;
end $$;

do $$
declare b jsonb := pg_temp.agent_run() -> 'binding'; v_receipts jsonb;
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_receipts := public.qorpera_record_runtime_observation_batch((b ->> 'runId')::uuid,
		(select jsonb_agg(jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',extensions.gen_random_uuid(),
			'parentAttemptId',null,'assignmentId',b -> 'assignmentId','phase','start','operation',o.name,
			'logicalOperationSha256',repeat('7',64),'observedAt','2026-11-14T12:00:00.000Z','durationMs',null,'status','started',
			'errorCategory',null,'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,
			'outputTokens',null,'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,
			'totalTokens',null) order by o.name)
		from unnest(array['company_edit', 'company_move']) o(name)));
	reset role;
	if jsonb_array_length(v_receipts -> 'receipts') <> 2 or exists (select 1 from jsonb_array_elements(v_receipts -> 'receipts') r
			where r ->> 'schema' is distinct from 'qorpera.runtime-observation-receipt/v1') then
		raise exception 'The observation vocabulary lacks company_edit and company_move: %', v_receipts; end if;
end $$;

rollback;
