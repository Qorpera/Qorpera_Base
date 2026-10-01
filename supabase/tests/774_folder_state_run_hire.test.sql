-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Company state files, thin writers W4a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5; RUNTIME-COMPANY-FOLDER-C2.md
-- §5): a run's hire, as hire_agent saves it. One new folder agents/<handle> with agent.md, the agent's folders and its
-- first assignment as a todo, staged by the run and saved with the review recorded for exactly that change set. The
-- commit indexes the agent (its roster row and thread) and the todo as the new agent's, asked for by the run's
-- requester. Without the review, or with a review of other units, nothing is saved. The agent rules still hold for a
-- reviewed hire. Runs are 647's hand-built runs, on 769's helpers.

-- A structured entry as the runtime sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent') returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Bookkeeper\nkind: %s\nstatus: active\nfigure: acorn\n---\nKeep the books.\n',
		p_id, p_name, p_kind)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Bookkeeper','agentKind',p_kind,'status','active',
		'colour',null,'figure','acorn','model',null,'effort',null,'instructions','Keep the books.')
$$;
create function pg_temp.todo_text(p_id uuid) returns text language sql as $$
	select format(E'---\nid: %s\ntitle: Reconcile September\nstatus: open\nrequested_by: %s\n---\nMatch every bank line.\n',
		p_id, '63400000-0000-4000-8000-000000000002')
$$;
create function pg_temp.todo_parse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind','todo','id',p_id,'title','Reconcile September','status','open',
		'requestedBy','63400000-0000-4000-8000-000000000002','detail','Match every bank line.')
$$;
-- The hire's one unit, staged by the actor that commits it (a version-2 file is held to possession).
create function pg_temp.hire(p_actor jsonb, p_handle text, p_agent uuid, p_todo uuid, p_name text default 'Vera',
	p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_agent, p_name, p_kind), p_actor)),
			jsonb_build_object('path','memory','kind','folder'),
			jsonb_build_object('path','skills','kind','folder'),
			jsonb_build_object('path','routines','kind','folder'),
			jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/first-assignment.md','kind','file','file',pg_temp.stage(pg_temp.todo_text(p_todo), p_actor))),
		'structured', jsonb_build_array(
			pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_agent, p_name, p_kind),
				pg_temp.agent_parse(p_agent, p_name, p_kind)),
			pg_temp.entry('agents/' || p_handle || '/todos/first-assignment.md', 'todo', pg_temp.todo_text(p_todo),
				pg_temp.todo_parse(p_todo)))))
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

-- The agents folder, as the seeded tree has it.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'run-hire-setup', '[{"op":"mkdir","path":"agents"}]'), 1, 'saved')
	\g /dev/null

-- 1. Unreviewed, or reviewed for other units: denied, and nothing is indexed.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb;
	c_agent constant uuid := '77400000-0000-4000-8000-0000000000a1'; c_todo constant uuid := '77400000-0000-4000-8000-0000000000d1';
begin
	u := pg_temp.hire(p, 'vera', c_agent, c_todo);
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-none', u), 1, 'denied', 'review_required');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-other'), pg_temp.hire(p, 'vera-other', c_agent, c_todo));
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-other', u, (r ->> 'reviewId')::uuid), 1, 'denied', 'review_required');
	if (pg_temp.staff(c_agent)).staff_agent_id is not null or pg_temp.present('agents/vera') then
		raise exception 'A hire without its review saves nothing'; end if;
end $$;

-- 2. Reviewed: saved and indexed. The roster row is the file's, its thread exists, and the first todo is the new
-- agent's own, asked for by the run's requester.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	s public.qorpera_profile_staff%rowtype;
	c_agent constant uuid := '77400000-0000-4000-8000-0000000000a2'; c_todo constant uuid := '77400000-0000-4000-8000-0000000000d2';
begin
	u := pg_temp.hire(p, 'vera', c_agent, c_todo);
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-1'), u);
	c := pg_temp.commit(p, 'run-hire-0001', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if (select review_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) is distinct from (r ->> 'reviewId')::uuid then
		raise exception 'The hire''s commit names its review'; end if;
	s := pg_temp.staff(c_agent);
	if s.display_name is distinct from 'Vera' or s.role is distinct from 'Bookkeeper' or s.charter is distinct from 'Keep the books.'
		or s.folder_path is distinct from 'agents/vera/agent.md' or s.employment_status is distinct from 'active' then
		raise exception 'The hire reaches the roster from its file: %', to_jsonb(s); end if;
	if not exists (select 1 from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
			and bound_staff_agent_id = c_agent) then
		raise exception 'A hire gets its thread'; end if;
	if not exists (select 1 from public.qorpera_runtime_agent_todos where id = c_todo and staff_agent_id = c_agent
			and requested_by_user_id = '63400000-0000-4000-8000-000000000002' and state = 'open') then
		raise exception 'The first assignment is the new agent''s open todo, asked for by the requester'; end if;
	if not (pg_temp.present('agents/vera/memory') and pg_temp.present('agents/vera/skills') and pg_temp.present('agents/vera/routines')
			and pg_temp.present('agents/vera/todos/first-assignment.md')) then
		raise exception 'The hire brings its folders'; end if;
	-- The folder is now taken: another hire of the same handle is a conflict.
	u := pg_temp.hire(p, 'vera', '77400000-0000-4000-8000-0000000000a3', '77400000-0000-4000-8000-0000000000d3', 'Vera Two');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-2'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-0002', u, (r ->> 'reviewId')::uuid), 1, 'conflict', 'exists');
end $$;

-- 3. A review does not lift the agent rules: a run never hires a Co-Founder, and an id another agent holds is refused.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; v jsonb;
begin
	u := pg_temp.hire(p, 'chief', '77400000-0000-4000-8000-0000000000a4', '77400000-0000-4000-8000-0000000000d4', 'Chief', 'co-founder');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-3'), u);
	v := pg_temp.expect(pg_temp.commit(p, 'run-hire-0003', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	u := pg_temp.hire(p, 'vera-again', '77400000-0000-4000-8000-0000000000a2', '77400000-0000-4000-8000-0000000000d5', 'Vera Again');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-4'), u);
	v := pg_temp.expect(pg_temp.commit(p, 'run-hire-0004', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	if pg_temp.present('agents/chief') or pg_temp.present('agents/vera-again') then raise exception 'A refused hire saves nothing'; end if;
end $$;

rollback;
