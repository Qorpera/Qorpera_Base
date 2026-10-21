-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- 20260930525000 (QORPERA-RUNTIME-CONTRACT.md, the 2026-10-21 amendment, items 5 and 6): an agent moves or renames a
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
	-- Without a review the move waits, as a deletion does.
	perform pg_temp.expect(pg_temp.commit(p, 'move-none', u), 1, 'denied', 'review_required');
	if not pg_temp.present('rr1.txt') or pg_temp.present('rr1-renamed.txt') then
		raise exception 'A move without a review moved the file'; end if;
	-- Approved as company_move's: recorded, and the commit moves the file under the review.
	r := pg_temp.record(b, pg_temp.action(b, 'move-own', 'allow', 'destructive', 'company_move'), u);
	c := pg_temp.commit(p, 'move-reviewed', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if pg_temp.present('rr1.txt') or not pg_temp.present('rr1-renamed.txt') then
		raise exception 'The reviewed move did not move the file: %', c; end if;
end $$;

-- The vocabulary, and the markers for release guards.
do $$
begin
	if position('/* 20260930525000 */''company_edit'',''company_move'','
		in pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) = 0 then
		raise exception 'The observation vocabulary lacks company_edit and company_move'; end if;
	if position('''company_move'' /* 20260930525000 */'
		in pg_get_functiondef('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure)) = 0 then
		raise exception 'The recorder lacks company_move'; end if;
end $$;

rollback;
