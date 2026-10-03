-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- Folder core slice P20 (20260930001200): the recorder takes an update_skill approval (destructive, as company_delete's)
-- for deletions under the run agent's own skills folder only. The skill is then deleted with its review; an
-- update_skill delete anywhere else, an update_skill write, an internal update_skill and any other tool stay refused.

-- Agent A's folder, as an agent index entry leaves the staff row: folder_path is its agent.md's path (the fixture's
-- agents were inserted by hand).
select pg_temp.fx(format($q$update public.qorpera_profile_staff set folder_path = 'agents/agent-a/agent.md', folder_environment_id = %L,
	folder_path_version = %L, folder_commit_id = %L where staff_agent_id = %L$q$, '63400000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63400000-0000-4000-8000-0000000000a1'));

-- The skill files the runs delete, written by the platform: agent A's own, agent B's, and the company library's.
do $$
declare m jsonb := '{"kind":"platform"}';
begin
	perform pg_temp.expect(pg_temp.commit(m, 'skill-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents'),
		jsonb_build_object('op','mkdir','path','agents/agent-a'),
		jsonb_build_object('op','mkdir','path','agents/agent-a/skills'),
		jsonb_build_object('op','mkdir','path','agents/agent-a/skills/call-the-bank'),
		jsonb_build_object('op','write','path','agents/agent-a/skills/call-the-bank/SKILL.md','file',pg_temp.stage('own skill', m)),
		jsonb_build_object('op','mkdir','path','agents/agent-b'),
		jsonb_build_object('op','mkdir','path','agents/agent-b/skills'),
		jsonb_build_object('op','write','path','agents/agent-b/skills/other.md','file',pg_temp.stage('other agent skill', m)),
		jsonb_build_object('op','mkdir','path','skills'),
		jsonb_build_object('op','write','path','skills/company.md','file',pg_temp.stage('company skill', m)))), 10, 'saved');
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	c_own constant text := 'agents/agent-a/skills/call-the-bank/SKILL.md';
begin
	-- Elsewhere: another agent's skills, the company library, the skills folder itself, a write; each refused.
	foreach u in array array[
		jsonb_build_array(pg_temp.deletes('agents/agent-b/skills/other.md')),
		jsonb_build_array(pg_temp.deletes('skills/company.md')),
		jsonb_build_array(pg_temp.deletes(c_own), pg_temp.deletes('skills/company.md')),
		jsonb_build_array(jsonb_build_object('op','write','path',c_own,'file',pg_temp.stage('rewritten'),
			'expectedVersion', pg_temp.read(c_own) -> 'entry' ->> 'version'))] loop
		perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
			pg_temp.action(b, 'skill-elsewhere-' || md5(u::text), 'allow', 'destructive', 'update_skill'), u),
			'42501', 'This change has no approval in this run');
	end loop;
	-- The skills folder itself is no skill: a deletion of exactly agents/agent-a/skills/ is refused.
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'skill-folder', 'allow', 'destructive', 'update_skill'),
		jsonb_build_array(jsonb_build_object('op','delete','path','agents/agent-a/skills','expectedVersion',
			pg_temp.read('agents/agent-a/skills') -> 'entry' ->> 'version','asOfSeq',0))),
		'42501', 'This change has no approval in this run');
	-- Its own skill, but approved as delegation rather than destructive, or by a tool that is not update_skill: refused.
	u := jsonb_build_array(pg_temp.deletes(c_own));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'skill-delegation', 'allow', 'delegation', 'update_skill'), u), '42501', 'This change has no approval in this run');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'skill-other-tool', 'allow', 'destructive', 'update_memory'), u), '42501', 'This change has no approval in this run');
	-- Its own skill, approved as update_skill's deletion: recorded, and the commit deletes it under the review.
	r := pg_temp.record(b, pg_temp.action(b, 'skill-own', 'allow', 'destructive', 'update_skill'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'skill-delete-none', u), 1, 'denied', 'review_required');
	c := pg_temp.commit(p, 'skill-delete', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if pg_temp.present(c_own) then raise exception 'The reviewed skill deletion did not delete the skill'; end if;
	-- The others are untouched.
	if not pg_temp.present('agents/agent-b/skills/other.md') or not pg_temp.present('skills/company.md') then
		raise exception 'A refused skill deletion deleted something'; end if;
end $$;

-- The marker for release guards.
do $$
begin
	if position('20260930001200' in pg_get_functiondef('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure)) = 0 then
		raise exception 'The recorder lacks the P20 marker'; end if;
end $$;

rollback;
