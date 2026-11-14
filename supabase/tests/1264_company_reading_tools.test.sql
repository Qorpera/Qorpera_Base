-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- 20260930766000 (the company's reading of itself): end_role sets an agent's agent.md to archived, a delegation, so the
-- review recorder takes an end_role approval for the run's change set and the commit saves it under that review; an
-- approval of update_reading, whose saves are plain and never reviewed, stays refused, as does an end_role approval of
-- another effect. The observation vocabulary names update_reading and end_role after make_picture, and the recorder
-- names end_role after company_move; only those two bodies carry the marker.

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

-- The vocabulary and the recorder, and the marker in exactly those two bodies.
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
	if (select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930766000') > 0)
		is distinct from array['qorpera_folder_record_review', 'qorpera_record_runtime_observation'] then
		raise exception 'The marker is in other bodies'; end if;
end $$;

rollback;
