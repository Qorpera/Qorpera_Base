-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Thin writers W1 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Built (W1)"): a folder-v2 run lists its own
-- todos from the todo index (qorpera_folder_agent_todos, 20260929770000), paged as today's list, behind the run's plain
-- check and its read authority on its todos folder.

-- Structured files as the TS parser sends them (the shapes of test 707), in this fixture's company.
create function pg_temp.w1_entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.w1_version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_path
$$;
create function pg_temp.w1_write(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.w1_entry(p_path, p_kind, p_text, p_parse)))
		|| case when pg_temp.w1_version(p_path) is not null then jsonb_build_object('expectedVersion', pg_temp.w1_version(p_path))
			else '{}'::jsonb end
$$;
create function pg_temp.w1_hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: active\n---\nSell.\n', p_id, p_name, p_kind))),
			jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.w1_entry('agents/' || p_handle || '/agent.md', 'agent',
			format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: active\n---\nSell.\n', p_id, p_name, p_kind),
			jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status','active',
				'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.'))))
$$;
create function pg_temp.w1_todo(p_path text, p_title text, p_status text default 'open', p_detail text default '') returns jsonb
language sql as $$
	select pg_temp.w1_write(p_path, 'todo',
		format(E'---\nid: %s\ntitle: %s\nstatus: %s\n---\n%s\n',
			coalesce((select id from public.qorpera_runtime_agent_todos where folder_path = p_path), extensions.gen_random_uuid()),
			p_title, p_status, p_detail),
		jsonb_build_object('kind','todo','id',
			coalesce((select id from public.qorpera_runtime_agent_todos where folder_path = p_path), extensions.gen_random_uuid()),
			'title',p_title,'status',p_status,'requestedBy',null,'detail',p_detail))
$$;
create function pg_temp.w1_list(p_actor jsonb, p_request jsonb default '{}') returns jsonb language sql as $$
	select public.qorpera_folder_agent_todos('63400000-0000-4000-8000-000000000020', p_actor, p_request)
$$;

-- 1. An agent folder with todos, and a run of that agent --------------------------------------------------------------
do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'w1-seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.w1_write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.w1_hire('co-founder', '63400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.member(1), 'w1-hire-0001', jsonb_build_array(
		pg_temp.w1_hire('ada', '63400000-0000-4000-8000-0000000000e1', 'Ada'),
		pg_temp.w1_hire('ben', '63400000-0000-4000-8000-0000000000e2', 'Ben')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- One commit each, so the todos are made in this order.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1-todo-0001', jsonb_build_array(
		pg_temp.w1_todo('agents/ada/todos/call-the-bank.md', 'Call the bank', 'open', repeat('x', 250)))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1-todo-0002', jsonb_build_array(
		pg_temp.w1_todo('agents/ada/todos/send-the-offer.md', 'Send the offer', 'blocked', 'Waiting for prices.'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1-todo-0003', jsonb_build_array(
		pg_temp.w1_todo('agents/ada/todos/book-the-room.md', 'Book the room', 'done'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1-todo-0004', jsonb_build_array(
		pg_temp.w1_todo('agents/ben/todos/ben-only.md', 'Ben''s work'))), 1, 'saved');
	perform set_config('qorpera_test.ada', pg_temp.run('63400000-0000-4000-8000-0000000000e1', 'human',
		'63400000-0000-4000-8000-000000000001')::text, false);
end $$;

-- 2. The page: the agent's own open and blocked todos, newest first, as the index has them -----------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; r jsonb;
begin
	r := pg_temp.w1_list(ada);
	if r ->> 'schema' <> 'qorpera.folder-agent-todos/v1' or (r ->> 'moreTodos')::int <> 0 or r -> 'nextCursor' <> 'null'::jsonb
		or (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(r -> 'todos') t) <> '["send-the-offer","call-the-bank"]'
		or r -> 'todos' -> 0 ->> 'state' <> 'blocked' or r -> 'todos' -> 0 ->> 'title' <> 'Send the offer'
		or r -> 'todos' -> 0 ->> 'path' <> 'agents/ada/todos/send-the-offer.md'
		or (r -> 'todos' -> 0 ->> 'version')::uuid is distinct from pg_temp.w1_version('agents/ada/todos/send-the-offer.md')
		or r -> 'todos' -> 0 ->> 'detail' <> 'Waiting for prices.' or r -> 'todos' -> 0 ? 'detailTruncated'
		or char_length(r -> 'todos' -> 1 ->> 'detail') <> 200 or (r -> 'todos' -> 1 ->> 'detailTruncated')::boolean is not true
		or not (r -> 'todos' -> 1 ? 'cursor') or not (r -> 'todos' -> 1 ? 'updatedAt') then
		raise exception 'The open page: %', r; end if;
	-- Closed ones on request, by state, and by search in a title or a key, in any case.
	if (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(pg_temp.w1_list(ada, '{"includeClosed":true}') -> 'todos') t)
			<> '["book-the-room","send-the-offer","call-the-bank"]'
		or (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(pg_temp.w1_list(ada, '{"state":"done"}') -> 'todos') t)
			<> '["book-the-room"]'
		or (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(pg_temp.w1_list(ada, '{"search":"BANK"}') -> 'todos') t)
			<> '["call-the-bank"]'
		or (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(pg_temp.w1_list(ada, '{"search":"offer"}') -> 'todos') t)
			<> '["send-the-offer"]' then
		raise exception 'Filters'; end if;
end $$;

-- 3. Pages of 32, continued from the cursor; a deleted file is not listed -------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; r jsonb; s jsonb; v_units jsonb := '[]'; i integer;
begin
	for i in 1..33 loop
		v_units := v_units || jsonb_build_array(pg_temp.w1_todo(format('agents/ada/todos/item-%s.md', i), format('Item %s', i)));
	end loop;
	r := pg_temp.commit(pg_temp.member(1), 'w1-todo-many', v_units);
	for i in 1..33 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.w1_list(ada);
	if jsonb_array_length(r -> 'todos') <> 32 or (r ->> 'moreTodos')::int <> 3
		or r ->> 'nextCursor' <> r -> 'todos' -> 31 ->> 'cursor' then
		raise exception 'A full page: % more, cursor %', r -> 'moreTodos', r -> 'nextCursor'; end if;
	s := pg_temp.w1_list(ada, jsonb_build_object('cursor', r ->> 'nextCursor'));
	if jsonb_array_length(s -> 'todos') <> 3 or (s ->> 'moreTodos')::int <> 0 or s -> 'nextCursor' <> 'null'::jsonb
		or exists (select 1 from jsonb_array_elements(r -> 'todos') a join jsonb_array_elements(s -> 'todos') b
			on a ->> 'todoKey' = b ->> 'todoKey') then
		raise exception 'The next page: %', s; end if;
	-- A search matches a key the title does not have.
	if (select jsonb_agg(t ->> 'todoKey') from jsonb_array_elements(pg_temp.w1_list(ada, '{"search":"item-3"}') -> 'todos') t)
			<> '["item-33","item-32","item-31","item-30","item-3"]' then
		raise exception 'A search by key'; end if;
	-- Deleting a file retires its row (a tombstone key): it is listed no more, closed or not.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1-todo-delete', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/ada/todos/call-the-bank.md','expectedVersion',pg_temp.w1_version('agents/ada/todos/call-the-bank.md')))), 1, 'saved');
	-- (A search reaches it on any page: its tombstone key starts with its old name.)
	if (select todo_key from public.qorpera_runtime_agent_todos where folder_path = 'agents/ada/todos/call-the-bank.md')
			not like 'call-the-bank.%'
		or jsonb_array_length(pg_temp.w1_list(ada, '{"includeClosed":true,"search":"call-the-bank"}') -> 'todos') <> 0 then
		raise exception 'A deleted todo is not listed'; end if;
	-- A retired row is no cursor either.
	perform pg_temp.raises(format('select pg_temp.w1_list(%L, %L)', ada, jsonb_build_object('cursor',
		(select id from public.qorpera_runtime_agent_todos where folder_path = 'agents/ada/todos/call-the-bank.md'))), '22023');
end $$;

-- 4. Who may list ---------------------------------------------------------------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; v_res uuid;
begin
	-- Only a run, of a company audience, whose agent has a folder.
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', pg_temp.member(1)), '42501');
	perform pg_temp.raises('select pg_temp.w1_list(''{"kind":"platform"}'')', '42501');
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human',
		'63400000-0000-4000-8000-000000000001')), '42501');
	-- A run in a member's private conversation keeps no company todos.
	perform set_config('qorpera_test.private', pg_temp.run('63400000-0000-4000-8000-0000000000e2', 'human',
		'63400000-0000-4000-8000-000000000001')::text, true);
	perform pg_temp.fx(format($f$update public.qorpera_execution_runs set audience_kind = 'member_private',
		audience_user_id = '63400000-0000-4000-8000-000000000001' where id = %L$f$,
		current_setting('qorpera_test.private')::jsonb ->> 'runId'));
	perform pg_temp.fx(format($f$update public.qorpera_shared_sessions set audience_kind = 'member_private',
		audience_user_id = '63400000-0000-4000-8000-000000000001'
		where id = (select session_id from public.qorpera_execution_runs where id = %L)$f$,
		current_setting('qorpera_test.private')::jsonb ->> 'runId'));
	if public.qorpera_folder_read_actor('63400000-0000-4000-8000-000000000020', current_setting('qorpera_test.private')::jsonb)
			-> 'audience' ->> 'kind' is distinct from 'member_private' then
		raise exception 'A private run reads as a private audience'; end if;
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', current_setting('qorpera_test.private')), '42501');
	-- A worker of the agent reports to its parent; it keeps no todos of its own.
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', pg_temp.run('63400000-0000-4000-8000-0000000000e1', 'agent',
		'63400000-0000-4000-8000-000000000001', 'worker-dispatch', ada,
		pg_temp.worker('63400000-0000-4000-8000-0000000000e1', ada, 'in-house', 'write'))), '42501');
	-- A request it does not know, and a cursor that is not this agent's.
	perform pg_temp.raises(format('select pg_temp.w1_list(%L, %L)', ada, '{"todoKey":"x"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.w1_list(%L, %L)', ada, '{"state":"later"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.w1_list(%L, %L)', ada, jsonb_build_object('cursor',
		(select id from public.qorpera_runtime_agent_todos where folder_path = 'agents/ben/todos/ben-only.md'))), '22023');
	-- A paused company's run reads nothing, as for any folder read.
	perform pg_temp.fx($f$insert into public.qorpera_company_execution_pauses(profile_id, reason, paused_by_user_id)
		values ('63400000-0000-4000-8000-000000000010', 'test', '63400000-0000-4000-8000-000000000001')$f$);
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', ada), '55000');
	delete from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010';
	-- One todo file narrowed to another agent: the folder core hides it from this run, and so does the page, its count
	-- and its cursor.
	v_res := public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(1),
		'agents/ada/todos/send-the-offer.md', 'exact', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_res, 'staff_agent',
		'63400000-0000-4000-8000-0000000000e2', array['read']);
	if (public.qorpera_folder_read('63400000-0000-4000-8000-000000000020', ada, 'agents/ada/todos/send-the-offer.md')
			->> 'found')::boolean then
		raise exception 'The core hides the narrowed file'; end if;
	if jsonb_array_length(pg_temp.w1_list(ada, '{"search":"offer"}') -> 'todos') <> 0
		or (pg_temp.w1_list(ada, '{"state":"blocked"}') ->> 'moreTodos')::int <> 0
		or jsonb_array_length(pg_temp.w1_list(ada, '{"state":"blocked"}') -> 'todos') <> 0
		or jsonb_array_length(pg_temp.w1_list(ada, '{"state":"done"}') -> 'todos') <> 1 then
		raise exception 'A todo the run may not read is not listed'; end if;
	perform pg_temp.raises(format('select pg_temp.w1_list(%L, %L)', ada, jsonb_build_object('cursor',
		(select id from public.qorpera_runtime_agent_todos where folder_path = 'agents/ada/todos/send-the-offer.md'))), '22023');
	-- Its todos folder narrowed to another agent: the agent no longer reads it.
	v_res := public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(1), 'agents/ada/todos',
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_res, 'staff_agent',
		'63400000-0000-4000-8000-0000000000e2', array['read']);
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', ada), '42501');
end $$;

-- 5. Only the service role calls it ----------------------------------------------------------------------------------------
do $$
begin
	if has_function_privilege('anon', 'public.qorpera_folder_agent_todos(uuid,jsonb,jsonb)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_agent_todos(uuid,jsonb,jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_agent_todos(uuid,jsonb,jsonb)', 'execute') then
		raise exception 'Grants'; end if;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.raises(format('select pg_temp.w1_list(%L)', current_setting('qorpera_test.ada')), '42501');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

rollback;
