-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Summary trees M4a (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §3, §5.5; 20260930220000): branches, a native host
-- call. Which conversations a run's branches are (a thread run's group chats, a group-chat run's thread and other group
-- chats, a run with no conversation's all of them, the Co-Founder's every agent's thread), their order by activity and
-- their message counts; what is left out (a removed member, a retired group, a retired or deleted agent, an agent with
-- no folder, another environment's conversation, a person member's id); the trees a request names; malformed requests;
-- the grants and the call list. Runs are 647's hand-built runs, on 769's helpers.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A structured entry as the TS parser sends it, and a file written with it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n', p_id, p_name)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind','agent','status','active',
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit, staged by the owner who commits it (as 943).
create function pg_temp.hire(p_handle text, p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name), pg_temp.member(1))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name), pg_temp.agent_parse(p_id, p_name))))
$$;
-- A group chat's folder (as 940), with the owner among its people, staged by the owner.
create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n  - 63400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n',
		p_id, p_name, (select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a))
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents), pg_temp.member(1)))),
		'structured', jsonb_build_array(pg_temp.entry('agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents),
			jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',null,'agents',to_jsonb(p_agents),
				'people','["63400000-0000-4000-8000-000000000001"]'::jsonb,'purpose','Plan the launch.'))))
$$;
-- The ids: agents a1 to a4, groups b1 to b6.
create function pg_temp.id(p_name text) returns uuid language sql immutable as $$
	select ('97000000-0000-4000-8000-0000000000' || case p_name when 'nora' then 'a1' when 'otto' then 'a2' when 'pia' then 'a3'
		when 'quinn' then 'a4' when 'launch' then 'b1' when 'design' then 'b2' when 'hiring' then 'b3' when 'ops' then 'b4'
		when 'press' then 'b5' when 'board' then 'b6' end)::uuid
$$;
-- An agent's thread conversation, and a group chat's.
create function pg_temp.thread(p_agent text) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = pg_temp.id(p_agent)
$$;
create function pg_temp.chat(p_group text) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.id(p_group)
$$;

-- The tree's files (as 943).
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
create function pg_temp.toml(p_session uuid) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = 1024\n', p_session)
$$;
create function pg_temp.line0(p_k bigint, p_seq bigint) returns text language sql as $$
	select format('{"l":0,"k":%s,"seq":%s,"hash":"%s","free":true,"text":"said"}', p_k, p_seq, pg_temp.ehash(p_seq))
$$;
create function pg_temp.line(p_l integer, p_k bigint, p_text text) returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
create function pg_temp.tree_file(p_path text, p_text text) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
create function pg_temp.memory(p_key text, p_units jsonb, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session,
			'generation', (select memory_generation from public.qorpera_shared_sessions where id = p_session)))))
$$;

-- The transcripts: one event per sequence number across the conversations, at 09:<seq> UTC, each with its own id and
-- hash (as 943's).
create function pg_temp.event(p_session uuid, p_seq bigint, p_type text default 'message') returns void language sql as $$
	select pg_temp.fx(format('insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body,
		event_hash, created_at) values (%L, %s, %L, %L, %L, %L, %L, %L)', p_session, p_seq,
		('97000000-0000-4000-8000-e' || lpad(p_seq::text, 11, '0'))::uuid, p_type, '63400000-0000-4000-8000-000000000001',
		case p_type when 'message' then '{"entry":{"message":{"role":"user","content":"Hello"}}}'
			when 'interaction_request' then '{"entry":{"customType":"qorpera.interaction_request","data":{"question":"Ship?"}}}'
			else '{"entry":{"customType":"qorpera.info"}}' end, pg_temp.ehash(p_seq),
		timestamptz '2026-10-04 09:00:00+00' + p_seq * interval '1 minute'))
$$;

-- The runs' bindings and ids (Nora's and Otto's), and a branches call by one.
create function pg_temp.b(p_who text) returns jsonb language sql as $$ select current_setting('qorpera_test.binding_' || p_who)::jsonb $$;
create function pg_temp.run_id(p_who text) returns uuid language sql as $$ select current_setting('qorpera_test.run_' || p_who)::uuid $$;
create function pg_temp.branches(p_who text, p_request jsonb default '{"sessions":[]}') returns jsonb language sql as $$
	select public.qorpera_memory_branches(pg_temp.b(p_who), p_request)
$$;
-- An agent's branches in a conversation (null for none), as the host call lists them for a run there. A hand-built run
-- is in its agent's thread: a run in a group chat needs a room wake, so the list is checked there directly.
create function pg_temp.list(p_who text, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_memory_branch_list('63400000-0000-4000-8000-000000000020', pg_temp.id(p_who), p_session)
$$;
-- A branch as the answer lists it, and the refs of a list.
create function pg_temp.br(p_ref text, p_name text, p_session uuid, p_messages integer) returns jsonb language sql as $$
	select jsonb_build_object('ref', p_ref, 'kind', split_part(p_ref, ':', 1), 'name', p_name, 'sessionId', p_session, 'messages', p_messages)
$$;
create function pg_temp.refs(p_list jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_agg(b.value -> 'ref' order by b.n), '[]'::jsonb) from jsonb_array_elements(p_list) with ordinality as b(value, n)
$$;

-- The setup: four hires, Quinn's folder retired; six group chats (a group chat has at least two agents). Nora is in
-- launch, design, hiring, press (removed later) and board (retired later); Otto in launch and ops; Pia in design,
-- hiring, ops, press and board. The runs: Nora's and Otto's, each in its own thread. The transcripts, newest last:
-- launch 1-3, Otto's thread 5, Nora's thread 10-11, design 15, ops 20, press 30, board 35, and a session_info (not an
-- included event) in hiring at 40 and in Pia's thread at 41. Otto's tree, with one line. The company chose Shared
-- context, the beta its place on the test list offers, so its runs are recorded in the beta (C5, 20260930508000); the
-- files that build on this fixture (946, 947, 951, 971) have the choice too.
insert into public.qorpera_memory_tree_companies(profile_id) values ('63400000-0000-4000-8000-000000000010');
insert into public.qorpera_company_memory_modes(profile_id, mode) values ('63400000-0000-4000-8000-000000000010', 'tree');
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'branches-setup',
	'[{"op":"mkdir","path":"agents"},{"op":"mkdir","path":"agents/groups"}]'), 2, 'saved') \g /dev/null
do $$
declare
	x jsonb; r jsonb; i integer; s uuid; all_ uuid[]; root constant text := 'agents/otto/memory/thread';
	nora constant uuid := pg_temp.id('nora'); otto constant uuid := pg_temp.id('otto'); pia constant uuid := pg_temp.id('pia');
begin
	r := pg_temp.commit(pg_temp.member(1), 'branches-hire', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'),
		pg_temp.hire('otto', otto, 'Otto'), pg_temp.hire('pia', pia, 'Pia'), pg_temp.hire('quinn', pg_temp.id('quinn'), 'Quinn')));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.member(1), 'branches-groups', jsonb_build_array(
		pg_temp.new_group('launch', pg_temp.id('launch'), 'Launch', array[nora, otto]),
		pg_temp.new_group('design', pg_temp.id('design'), 'Design', array[nora, pia]),
		pg_temp.new_group('hiring', pg_temp.id('hiring'), 'Hiring', array[nora, pia]),
		pg_temp.new_group('ops', pg_temp.id('ops'), 'Ops', array[otto, pia]),
		pg_temp.new_group('press', pg_temp.id('press'), 'Press', array[nora, pia]),
		pg_temp.new_group('board', pg_temp.id('board'), 'Board', array[nora, pia])));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.fx(format('update public.qorpera_profile_staff set folder_retired_at = now() where staff_agent_id = %L', pg_temp.id('quinn')));

	x := pg_temp.agent_run(nora);
	perform set_config('qorpera_test.binding_nora', (x -> 'binding')::text, true);
	perform set_config('qorpera_test.run_nora', x -> 'actor' ->> 'runId', true);
	x := pg_temp.agent_run(otto);
	perform set_config('qorpera_test.binding_otto', (x -> 'binding')::text, true);
	perform set_config('qorpera_test.run_otto', x -> 'actor' ->> 'runId', true);
	if (select session_id from public.qorpera_execution_runs where id = pg_temp.run_id('nora')) is distinct from pg_temp.thread('nora')
		or (select session_id from public.qorpera_execution_runs where id = pg_temp.run_id('otto')) is distinct from pg_temp.thread('otto') then
		raise exception 'Each run is in its agent''s thread'; end if;
	all_ := array[pg_temp.thread('nora'), pg_temp.thread('otto'), pg_temp.thread('pia'), pg_temp.thread('quinn'),
		pg_temp.chat('launch'), pg_temp.chat('design'), pg_temp.chat('hiring'), pg_temp.chat('ops'), pg_temp.chat('press'),
		pg_temp.chat('board')];
	if (select count(distinct x.s) from unnest(all_) as x(s)) <> 10
		or exists (select 1 from public.qorpera_session_events where session_id = any(all_)) then
		raise exception 'Ten conversations with no events yet'; end if;

	foreach i in array array[1, 2, 3] loop perform pg_temp.event(pg_temp.chat('launch'), i); end loop;
	perform pg_temp.event(pg_temp.thread('otto'), 5);
	perform pg_temp.event(pg_temp.thread('nora'), 10);
	perform pg_temp.event(pg_temp.thread('nora'), 11, 'interaction_request');
	perform pg_temp.event(pg_temp.chat('design'), 15);
	perform pg_temp.event(pg_temp.chat('ops'), 20);
	perform pg_temp.event(pg_temp.chat('press'), 30);
	perform pg_temp.event(pg_temp.chat('board'), 35);
	perform pg_temp.event(pg_temp.chat('hiring'), 40, 'session_info');
	perform pg_temp.event(pg_temp.thread('pia'), 41, 'session_info');

	s := pg_temp.thread('otto');
	r := pg_temp.memory('branches-tree', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.line0(0, 5) || E'\n')), s);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- The checks start here.

-- 1. Which branches: a thread run's group chats; a group-chat run's thread and other group chats; a run with no
-- conversation's all of them. The most recently active first, then by ref, a conversation with no included event last.
-- A removed member and a retired group are left out --------------------------------------------------------------------

do $$
declare
	launch jsonb := pg_temp.br('group:launch', 'Launch', pg_temp.chat('launch'), 3);
	design jsonb := pg_temp.br('group:design', 'Design', pg_temp.chat('design'), 1);
	hiring jsonb := pg_temp.br('group:hiring', 'Hiring', pg_temp.chat('hiring'), 0);
	nora jsonb := pg_temp.br('thread:nora', 'Nora', pg_temp.thread('nora'), 2);
begin
	perform pg_temp.fx(format('update public.qorpera_company_room_members set status = %L, removed_at = now()
		where room_id = %L and principal_kind = %L and principal_id = %L', 'removed', pg_temp.id('press'), 'staff_agent', pg_temp.id('nora')));
	perform pg_temp.fx(format('update public.qorpera_company_rooms set folder_retired_at = now() where id = %L', pg_temp.id('board')));

	perform pg_temp.same(pg_temp.branches('nora'), jsonb_build_object('schema', 'qorpera.memory-branches/v1',
		'branches', jsonb_build_array(design, launch, hiring), 'trees', '[]'::jsonb), 'A thread run: its group chats');
	perform pg_temp.same(pg_temp.branches('otto'), jsonb_build_object('schema', 'qorpera.memory-branches/v1',
		'branches', jsonb_build_array(pg_temp.br('group:ops', 'Ops', pg_temp.chat('ops'), 1), pg_temp.br('group:launch', 'Launch',
			pg_temp.chat('launch'), 3)), 'trees', '[]'::jsonb), 'Another agent''s thread run');

	perform pg_temp.same(pg_temp.list('nora', pg_temp.thread('nora')), jsonb_build_array(design, launch, hiring),
		'The list for the run''s conversation');

	perform pg_temp.same(pg_temp.list('nora', pg_temp.chat('launch')), jsonb_build_array(design, nora, hiring),
		'In a group chat: the thread and the other group chats');
	perform pg_temp.same(pg_temp.list('nora', pg_temp.chat('hiring')), jsonb_build_array(design, nora, launch), 'In another group chat');
	perform pg_temp.same(pg_temp.list('nora', null), jsonb_build_array(design, nora, launch, hiring), 'In no conversation');
	-- In a conversation that is none of the agent's, every one is a branch.
	perform pg_temp.same(pg_temp.list('nora', pg_temp.thread('pia')), jsonb_build_array(design, nora, launch, hiring),
		'In another agent''s thread');

	-- A tie in activity goes by ref: Nora's thread and the launch chat as recent as the design chat.
	perform pg_temp.fx(format('update public.qorpera_session_events set created_at = %L where session_id in (%L, %L)',
		timestamptz '2026-10-04 09:15:00+00', pg_temp.thread('nora'), pg_temp.chat('launch')));
	perform pg_temp.same(pg_temp.refs(pg_temp.list('nora', null)), '["group:design", "group:launch", "thread:nora", "group:hiring"]',
		'A tie, by ref');
	perform pg_temp.fx(format('update public.qorpera_session_events set created_at = timestamptz %L + sequence * interval %L
		where session_id in (%L, %L)', '2026-10-04 09:00:00+00', '1 minute', pg_temp.thread('nora'), pg_temp.chat('launch')));
end $$;

-- 2. The Co-Founder: also every other agent's thread, live as zoom finds it. An agent with no folder (634's Agents A and
-- B), a retired or deleted agent, another environment's conversation and a person member's id are left out -----------

do $$
begin
	perform pg_temp.fx(format('insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, formation_id,
		created_by_user_id) values (%L, %L, %L, null, %L)', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		pg_temp.id('nora'), '63400000-0000-4000-8000-000000000001'));
	perform pg_temp.same(pg_temp.branches('nora') -> 'branches', jsonb_build_array(
		pg_temp.br('group:design', 'Design', pg_temp.chat('design'), 1), pg_temp.br('thread:otto', 'Otto', pg_temp.thread('otto'), 1),
		pg_temp.br('group:launch', 'Launch', pg_temp.chat('launch'), 3), pg_temp.br('group:hiring', 'Hiring', pg_temp.chat('hiring'), 0),
		pg_temp.br('thread:pia', 'Pia', pg_temp.thread('pia'), 0)), 'The Co-Founder''s thread run');
	perform pg_temp.same(pg_temp.refs(pg_temp.list('nora', pg_temp.chat('launch'))),
		'["group:design", "thread:nora", "thread:otto", "group:hiring", "thread:pia"]', 'The Co-Founder in a group chat');
	perform pg_temp.same(pg_temp.refs(pg_temp.branches('otto') -> 'branches'), '["group:ops", "group:launch"]', 'Otto is not the Co-Founder');

	-- A deleted agent's thread, a conversation in another environment and an id that is a person member's, not an agent's.
	perform pg_temp.fx(format('update public.qorpera_profile_staff set deleted_at = now(), deleted_by_user_id = %L where staff_agent_id = %L',
		'63400000-0000-4000-8000-000000000001', pg_temp.id('pia')));
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set environment_id = %L where id = %L', extensions.gen_random_uuid(),
		pg_temp.chat('hiring')));
	perform pg_temp.fx(format('insert into public.qorpera_company_room_members(room_id, principal_kind, principal_id, status,
		source_path_version) values (%L, %L, %L, %L, %L)', pg_temp.id('ops'), 'member', pg_temp.id('nora'), 'active',
		extensions.gen_random_uuid()));
	perform pg_temp.same(pg_temp.refs(pg_temp.branches('nora') -> 'branches'), '["group:design", "thread:otto", "group:launch"]', 'Left out');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set deleted_at = null, deleted_by_user_id = null where staff_agent_id = %L',
		pg_temp.id('pia')));
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set environment_id = %L where id = %L',
		'63400000-0000-4000-8000-000000000020', pg_temp.chat('hiring')));

	-- The list is the environment's: another environment lists nothing; the run's agent and conversation decide it.
	perform pg_temp.same(public.qorpera_memory_branch_list(extensions.gen_random_uuid(), pg_temp.id('nora'), null), '[]',
		'Another environment');
	perform pg_temp.same(public.qorpera_memory_branch_list('63400000-0000-4000-8000-000000000020', pg_temp.id('quinn'), null), '[]',
		'An agent in no conversation of its own');
	perform pg_temp.same(public.qorpera_memory_branch_list('63400000-0000-4000-8000-000000000020', pg_temp.id('pia'), null),
		jsonb_build_array(pg_temp.br('group:press', 'Press', pg_temp.chat('press'), 1), pg_temp.br('group:ops', 'Ops', pg_temp.chat('ops'), 1),
			pg_temp.br('group:design', 'Design', pg_temp.chat('design'), 1), pg_temp.br('group:hiring', 'Hiring', pg_temp.chat('hiring'), 0),
			pg_temp.br('thread:pia', 'Pia', pg_temp.thread('pia'), 0)),
		'Pia''s, with no run');
end $$;

-- 3. Trees: the live tree of each named session that is one of the run's branches, in the branches' order -------------

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020';
	otto uuid := pg_temp.thread('otto'); launch uuid := pg_temp.chat('launch'); answer jsonb;
begin
	-- Nora is the Co-Founder here: Otto's thread is one of her branches.
	answer := pg_temp.branches('nora', jsonb_build_object('sessions', jsonb_build_array(launch, extensions.gen_random_uuid(), otto,
		pg_temp.thread('nora'))));
	perform pg_temp.same(answer -> 'trees', jsonb_build_array(public.qorpera_memory_tree_read(env, otto),
		public.qorpera_memory_tree_read(env, launch)), 'The trees, in the branches'' order');
	perform pg_temp.same(jsonb_build_array(answer #> '{trees,0,root}', answer #> '{trees,0,messages}',
		jsonb_array_length(answer #> '{trees,0,lines}'), answer #> '{trees,0,blocks,0,path}', answer #> '{trees,1,root}',
		answer #> '{trees,1,lines}'), '["agents/otto/memory/thread", 1, 1, "agents/otto/memory/thread/t0/00000000.jsonl", null, []]',
		'Otto''s tree has its line; the launch chat has no tree');
	perform pg_temp.same(answer -> 'branches', pg_temp.branches('nora') -> 'branches', 'The same branches');
	-- A retired tree has no lines.
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = now() where session_id = %L', otto));
	perform pg_temp.same(pg_temp.branches('nora', jsonb_build_object('sessions', jsonb_build_array(otto))) -> 'trees',
		jsonb_build_array(public.qorpera_memory_tree_read(env, otto)), 'A retired tree, as zoom reads it');
	perform pg_temp.same(pg_temp.branches('nora', jsonb_build_object('sessions', jsonb_build_array(otto))) #> '{trees,0,lines}', '[]',
		'A retired tree has no lines');
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = null where session_id = %L', otto));

	-- Not the Co-Founder: Otto's thread is no branch, and is left out.
	perform pg_temp.fx(format('delete from public.qorpera_company_cofounders where profile_id = %L', '63400000-0000-4000-8000-000000000010'));
	perform pg_temp.same(pg_temp.branches('nora', jsonb_build_object('sessions', jsonb_build_array(otto, launch))) -> 'trees',
		jsonb_build_array(public.qorpera_memory_tree_read(env, launch)), 'A session that is no branch');
	perform pg_temp.same(pg_temp.branches('otto', jsonb_build_object('sessions', jsonb_build_array(otto))) -> 'trees', '[]',
		'The run''s own conversation is no branch');
end $$;

-- 4. Malformed requests refuse (22023); the run check comes first -----------------------------------------------------

do $$
declare request text;
begin
	foreach request in array array['[]', '"branches"', '1', 'true', '{}', '{"sessions":null}', '{"sessions":{}}', '{"sessions":"x"}',
		'{"sessions":[],"more":1}', '{"sessions":[5]}', '{"sessions":[null]}', '{"sessions":[["x"]]}', '{"sessions":["x"]}',
		'{"sessions":["97000000-0000-4000-8000-0000000000B1"]}', '{"sessions":["97000000000040008000000000000000b1"]}',
		'{"sessions":[" 97000000-0000-4000-8000-0000000000b1"]}',
		'{"sessions":["97000000-0000-4000-8000-0000000000b1","97000000-0000-4000-8000-0000000000b1"]}'] loop
		perform pg_temp.raises(format('select public.qorpera_memory_branches(%L, %L)', pg_temp.b('nora'), request), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_memory_branches(%L, null)', pg_temp.b('nora')), '22023');
	-- The run check comes before the request's: a run whose lease is gone refuses whatever the request (the block's
	-- rollback restores it).
	begin
		perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', pg_temp.run_id('nora')));
		perform public.qorpera_memory_branches(pg_temp.b('nora'), '[]');
		raise exception 'A run with no lease' using errcode = 'QTF02';
	exception when others then
		if sqlstate <> '42501' then raise; end if;
	end;
	if not exists (select 1 from public.qorpera_execution_run_budgets where run_id = pg_temp.run_id('nora')) then
		raise exception 'The run''s budget is back'; end if;
end $$;

-- 5. The grants and the call list -------------------------------------------------------------------------------------

do $$
declare v_bad text;
begin
	select string_agg(f || ' ' || r, ', ') into v_bad
	from unnest(array['public.qorpera_memory_branches(jsonb,jsonb)', 'public.qorpera_memory_branch_list(uuid,uuid,uuid)']) f,
		unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (f = 'public.qorpera_memory_branches(jsonb,jsonb)' and r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if not (select p.prosecdef from pg_proc p where p.oid = 'public.qorpera_memory_branches(jsonb,jsonb)'::regprocedure)
		or (select p.prosecdef or p.provolatile <> 's' from pg_proc p
			where p.oid = 'public.qorpera_memory_branch_list(uuid,uuid,uuid)'::regprocedure) then
		raise exception 'branches is the definer; its list is a stable invoker'; end if;
	perform pg_temp.same((select to_jsonb(array[c.scope, c.budget]) from public.qorpera_native_host_calls c
		where c.name = 'qorpera_memory_branches'), '["binding", "standard"]', 'The call list');
end $$;

rollback;
