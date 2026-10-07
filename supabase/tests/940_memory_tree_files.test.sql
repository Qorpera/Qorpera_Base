-- @fixture 700_folder_state_vision_agents.test.sql until "-- 2. The vision: a new name"
-- Summary trees M1a (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §3, §4.2-§4.4; 20260930110000, 20260930111000):
-- the helpers, a tree built, rewritten and pruned by qorpera_folder_memory_commit, and its index following the files: an
-- agent's rename, its folder's delete and restore, a group chat's tree and rename, and erasure of a retired tree.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- An agent's thread's conversation.
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '70000000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
-- An event's hash, by its sequence.
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
-- Events 1 to n in a conversation: 2 is not a message (session_info), 4 is a question, the rest are messages. So event
-- n is message number n - 2 from 3 on.
create function pg_temp.events(p_session uuid, p_count integer) returns void language sql as $$
	insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
	select p_session, n, extensions.gen_random_uuid(),
		case n when 2 then 'session_info' when 4 then 'interaction_request' else 'message' end,
		'70000000-0000-4000-8000-000000000001', jsonb_build_object('entry', jsonb_build_object('n', n)), pg_temp.ehash(n),
		statement_timestamp() + n * interval '1 second'
	from generate_series(1, p_count) n
$$;
create function pg_temp.toml(p_session uuid, p_bytes integer default 1024) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = %s\n', p_session, p_bytes)
$$;
-- A level-0 line: message number k, the event at sequence seq.
create function pg_temp.line0(p_k bigint, p_seq bigint, p_text text default 'said') returns text language sql as $$
	select format('{"l":0,"k":%s,"seq":%s,"hash":"%s","free":true,"text":"%s"}', p_k, p_seq, pg_temp.ehash(p_seq), p_text)
$$;
-- A line above level 0.
create function pg_temp.line(p_l integer, p_k bigint, p_text text default 'summed up') returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
create function pg_temp.block(p_lines text[]) returns text language sql as $$
	select array_to_string(p_lines, E'\n') || E'\n'
$$;
-- A tree file written, tree.toml or a block, with its parse.
create function pg_temp.tree_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind), p_expected)
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
-- A memory commit as the platform, naming each conversation at its current generation.
create function pg_temp.memory(p_key text, p_units jsonb, p_sessions uuid[]) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', coalesce((select jsonb_agg(jsonb_build_object('sessionId', s.id,
			'generation', s.memory_generation) order by u.o)
			from unnest(p_sessions) with ordinality u(id, o) join public.qorpera_shared_sessions s on s.id = u.id), '[]'::jsonb)))
$$;
-- A conversation's lines in the index, as l:k:seq.
create function pg_temp.nodes(p_session uuid) returns text language sql as $$
	select coalesce(string_agg(n.l || ':' || n.k || ':' || coalesce(n.seq::text, '-'), ',' order by n.l, n.k), '')
	from public.qorpera_memory_tree_nodes n
	where n.environment_id = '70000000-0000-4000-8000-000000000020' and n.session_id = p_session
$$;
create function pg_temp.tree(p_session uuid) returns public.qorpera_memory_trees language sql as $$
	select * from public.qorpera_memory_trees where environment_id = '70000000-0000-4000-8000-000000000020' and session_id = p_session
$$;
create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n%s---\nPlan the launch.\n', p_id, p_name,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		coalesce((select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a), ''))
$$;
create function pg_temp.group_parse(p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',null,'agents',to_jsonb(p_agents),
		'people',to_jsonb(coalesce(p_people, '{}'::uuid[])),'purpose','Plan the launch.')
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents, p_people)))),
		'structured', jsonb_build_array(pg_temp.entry('agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents, p_people), pg_temp.group_parse(p_id, p_name, p_agents, p_people))))
$$;

-- 1. The helpers: kinds, roots, platform paths, what a memory commit makes, tree.toml, message numbers ------------------

do $$
declare s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
begin
	perform pg_temp.same((select jsonb_agg(public.qorpera_structured_path_kind(p) order by o) from unnest(array[
		'agents/nora/memory/thread/tree.toml', 'agents/nora/memory/thread/t0/00000000.jsonl', 'agents/nora/memory/thread/t14/99999999.jsonl',
		'agents/groups/launch/memory/tree.toml', 'agents/groups/launch/memory/t3/00000001.jsonl',
		'agents/nora/memory/thread/t15/00000000.jsonl', 'agents/nora/memory/thread/t0/0000000.jsonl', 'agents/nora/memory/tree.toml',
		'agents/nora/memory/thread/t0/tree.toml', 'agents/groups/launch/memory/thread/tree.toml', 'notes/memory/thread/tree.toml'])
		with ordinality x(p, o)),
		'["memory-tree","memory-block","memory-block","memory-tree","memory-block",null,null,null,null,null,null]', 'Tree kinds');
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_tree_root_key(p) order by o) from unnest(array[
		'agents/nora/memory/thread', 'agents/nora/memory/thread/t0/00000000.jsonl', 'agents/nora/memory', 'agents/nora/memory/threads',
		'agents/groups/launch/memory', 'agents/groups/launch/memory/t0', 'agents/groups/launch', 'agents/groups/memory/thread',
		'notes/memory/thread']) with ordinality x(p, o)),
		'["agents/nora/memory/thread","agents/nora/memory/thread",null,null,"agents/groups/launch/memory",'
		'"agents/groups/launch/memory",null,null,null]', 'Tree roots');
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_platform_only_path(p) order by o) from unnest(array[
		'agents/nora/memory', 'agents/nora/memory/notes.md', 'agents/nora/memory/thread', 'agents/nora/memory/thread/t0',
		'agents/groups/launch/memory', 'agents/groups/memory', 'agents/nora']) with ordinality x(p, o)),
		'[false,false,true,true,true,false,false]', 'Platform paths');
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_tree_path_allowed(r, k, op) order by o) from (values
		(1, '', 'folder', 'mkdir'), (2, '', 'folder', 'new_folder'), (3, '', 'folder', 'delete'), (4, 'tree.toml', 'file', 'write'),
		(5, 'tree.toml', 'file', 'delete'), (6, 't0', 'folder', 'mkdir'), (7, 't14', 'folder', 'new_folder'), (8, 't15', 'folder', 'mkdir'),
		(9, 't0', 'folder', 'delete'), (10, 't0/00000000.jsonl', 'file', 'write'), (11, 't14/12345678.jsonl', 'file', 'delete'),
		(12, 't0/00000000.jsonl', 'folder', 'mkdir'), (13, 'notes.md', 'file', 'write'), (14, 't0/0000000.jsonl', 'file', 'write'))
		x(o, r, k, op)),
		'[true,true,false,true,false,true,true,false,false,true,true,false,false,false]', 'What a memory commit makes');
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_included_event(t) order by o) from unnest(array['message',
		'interaction_request','interaction_answer','authorization_request','authorization_decision','session_info','tool_call'])
		with ordinality x(t, o)), '[true,true,true,true,true,false,false]', 'Included events');
	perform pg_temp.same(public.qorpera_memory_tree_toml(pg_temp.toml(s, 512)),
		jsonb_build_object('conversation', s::text, 'nodeBytes', 512), 'tree.toml');
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_tree_toml(t) is null order by o) from unnest(array[
		pg_temp.toml(s, 1024), pg_temp.toml(s, 1025), replace(pg_temp.toml(s), 'node_bytes = 1024', 'node_bytes = 0'),
		replace(pg_temp.toml(s), 'node_bytes = 1024', 'node_bytes = 01'),
		left(pg_temp.toml(s), -1), pg_temp.toml(s) || E'extra = 1\n', upper(pg_temp.toml(s)), replace(pg_temp.toml(s), ' = ', '=')])
		with ordinality x(t, o)),
		'[false,true,true,true,true,true,true,true]', 'tree.toml is exact');
	perform pg_temp.events(s, 18);
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_message_index(s, q) order by q)
		from unnest(array[1,2,3,4,5,18,19]::bigint[]) q), '[0,null,1,2,3,16,null]', 'Message numbers');
end $$;

-- 2. The Co-Founder's tree, built, rewritten and pruned by the memory commit, and its index ------------------------------

do $$
declare
	cofounder constant uuid := '70000000-0000-4000-8000-0000000000c0'; s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	root constant text := 'agents/co-founder/memory/thread'; r jsonb; i integer; t public.qorpera_memory_trees;
begin
	r := pg_temp.memory('tree-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4),
			pg_temp.line(1, 0)]))), array[s]);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	if coalesce(current_setting('qorpera.folder_memory', true), '') <> '' then
		raise exception 'The memory commit clears its request before it returns'; end if;
	t := pg_temp.tree(s);
	if t.root_path is distinct from root or t.root_key is distinct from root or t.owner_kind is distinct from 'agent'
		or t.owner_id is distinct from cofounder or t.node_bytes is distinct from 1024
		or t.toml_path_version is distinct from pg_temp.version(root || '/tree.toml') or t.commit_id is distinct from (r ->> 'commitId')::uuid
		or t.retired_at is not null then
		raise exception 'tree.toml is its tree''s row: %', to_jsonb(t); end if;
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,1:0:-"', 'A block''s lines are its rows');
	if exists (select 1 from public.qorpera_memory_tree_nodes n where n.session_id = s
		and (n.block_path is distinct from root || '/t0/00000000.jsonl' or n.block_key is distinct from n.block_path
			or n.block_path_version is distinct from pg_temp.version(root || '/t0/00000000.jsonl')
			or n.commit_id is distinct from (r ->> 'commitId')::uuid or n.run_id is not null
			or n.event_hash is distinct from case when n.l = 0 then pg_temp.ehash(n.seq) end
			or n.free is distinct from (n.l = 0) or n.tries is distinct from case when n.l > 0 then 1 end
			or n.text is distinct from case when n.l = 0 then 'said' else 'summed up' end or n.bytes <> octet_length(n.text))) then
		raise exception 'A line''s row holds the line and its file''s version'; end if;
	perform pg_temp.same(jsonb_build_array(
			public.qorpera_memory_owner_root('70000000-0000-4000-8000-000000000020', 'agent', cofounder),
			public.qorpera_memory_session_tree_root('70000000-0000-4000-8000-000000000020', s),
			(select to_jsonb(o) from public.qorpera_memory_root_owner('70000000-0000-4000-8000-000000000020', root) o)),
		jsonb_build_array(root, root, jsonb_build_object('owner_kind', 'agent', 'owner_id', cofounder, 'session_id', s)), 'Owner and root');

	-- A rewrite replaces the block's rows; a second block adds its own; a deleted block's rows go, and its tree stays.
	r := pg_temp.memory('tree-0002', jsonb_build_array(pg_temp.tree_file(root || '/t0/00000000.jsonl',
		pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line(1, 0, 'both'),
			pg_temp.line(1, 1), pg_temp.line(2, 0)]), pg_temp.version(root || '/t0/00000000.jsonl'))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,0:3:5,1:0:-,1:1:-,2:0:-"', 'A rewrite replaces the rows');
	if exists (select 1 from public.qorpera_memory_tree_nodes n where n.session_id = s
		and (n.block_path_version is distinct from pg_temp.version(root || '/t0/00000000.jsonl') or n.commit_id is distinct from (r ->> 'commitId')::uuid))
		or (select text from public.qorpera_memory_tree_nodes where session_id = s and l = 1 and k = 0) is distinct from 'both' then
		raise exception 'The rewritten rows point at the new version'; end if;
	r := pg_temp.memory('tree-0003', jsonb_build_array(pg_temp.tree_file(root || '/t0/00000001.jsonl',
		pg_temp.block(array[pg_temp.line0(16, 18), pg_temp.line(1, 8)]))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.memory('tree-0004', jsonb_build_array(jsonb_build_object('op','delete','path',root || '/t0/00000000.jsonl',
		'expectedVersion',pg_temp.version(root || '/t0/00000000.jsonl'))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:16:18,1:8:-"', 'A deleted block''s rows go with it');
	if public.qorpera_memory_session_tree_root('70000000-0000-4000-8000-000000000020', s) is distinct from root then
		raise exception 'A block''s delete leaves its tree'; end if;
	-- A new tree.toml updates the row.
	r := pg_temp.memory('tree-0005', jsonb_build_array(pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s, 256),
		pg_temp.version(root || '/tree.toml'))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	t := pg_temp.tree(s);
	if t.node_bytes is distinct from 256 or t.toml_path_version is distinct from pg_temp.version(root || '/tree.toml')
		or t.commit_id is distinct from (r ->> 'commitId')::uuid then
		raise exception 'A new tree.toml updates its row: %', to_jsonb(t); end if;
end $$;

-- 3. A tree in one unit. It follows its agent's rename, retires with its folder, stays retired when the agent comes
-- back, and a new tree.toml revives it -----------------------------------------------------------------------------------

do $$
declare
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; s uuid; r jsonb; t public.qorpera_memory_trees; b text;
	root constant text := 'agents/nora-dahl/memory/thread';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-hire-1', jsonb_build_array(pg_temp.hire('nora-dahl', nora, 'Nora Dahl'))),
		1, 'saved');
	s := pg_temp.thread(nora);
	perform pg_temp.events(s, 3);
	b := pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line(1, 0)]);
	r := pg_temp.memory('tree-nora-1', jsonb_build_array(jsonb_build_object('op','new_folder','path',root,
		'contents', jsonb_build_array(
			jsonb_build_object('path','tree.toml','kind','file','file',pg_temp.stage(pg_temp.toml(s, 512))),
			jsonb_build_object('path','t0','kind','folder'),
			jsonb_build_object('path','t0/00000000.jsonl','kind','file','file',pg_temp.stage(b))),
		'structured', jsonb_build_array(
			pg_temp.entry(root || '/tree.toml', 'memory-tree', pg_temp.toml(s, 512), '{"kind":"memory-tree"}'),
			pg_temp.entry(root || '/t0/00000000.jsonl', 'memory-block', b, '{"kind":"memory-block"}')))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(jsonb_build_array(public.qorpera_memory_session_tree_root('70000000-0000-4000-8000-000000000020', s), pg_temp.nodes(s)),
		jsonb_build_array(root, '0:0:1,0:1:3,1:0:-'), 'A tree in one unit');

	-- A rename: the tree and its lines follow their files, to the versions the move made.
	r := pg_temp.commit(pg_temp.owner(), 'tree-rename-1', jsonb_build_array(
		pg_temp.write('agents/nora-dahl/agent.md', 'agent', pg_temp.agent_text(nora, 'Nora Skov'), pg_temp.agent_parse(nora, 'Nora Skov'),
			pg_temp.version('agents/nora-dahl/agent.md')),
		jsonb_build_object('op','move','from','agents/nora-dahl','to','agents/nora-skov',
			'expectedVersion',pg_temp.version('agents/nora-dahl'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	t := pg_temp.tree(s);
	if t.root_path is distinct from 'agents/nora-skov/memory/thread' or t.root_key is distinct from t.root_path
		or t.toml_path_version is distinct from pg_temp.version('agents/nora-skov/memory/thread/tree.toml') or t.retired_at is not null
		or t.owner_id is distinct from nora or t.node_bytes is distinct from 512 or t.commit_id is distinct from (r ->> 'commitId')::uuid then
		raise exception 'A tree follows its agent''s rename: %', to_jsonb(t); end if;
	if pg_temp.nodes(s) is distinct from '0:0:1,0:1:3,1:0:-' or exists (select 1 from public.qorpera_memory_tree_nodes n where n.session_id = s
		and (n.block_path is distinct from 'agents/nora-skov/memory/thread/t0/00000000.jsonl' or n.block_key is distinct from n.block_path
			or n.block_path_version is distinct from pg_temp.version('agents/nora-skov/memory/thread/t0/00000000.jsonl'))) then
		raise exception 'Its lines follow too'; end if;

	-- Deleting the folder retires the tree and drops its lines.
	r := pg_temp.commit(pg_temp.owner(), 'tree-delete-1', jsonb_build_array(jsonb_build_object('op','delete','path','agents/nora-skov',
		'expectedVersion',pg_temp.version('agents/nora-skov'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	t := pg_temp.tree(s);
	if t.retired_at is null or t.commit_id is distinct from (r ->> 'commitId')::uuid or pg_temp.nodes(s) <> ''
		or public.qorpera_memory_session_tree_root('70000000-0000-4000-8000-000000000020', s) is not null
		or public.qorpera_memory_owner_root('70000000-0000-4000-8000-000000000020', 'agent', nora) is not null then
		raise exception 'A deleted folder retires its tree and drops its lines: %', to_jsonb(t); end if;

	-- The agent comes back without its tree; the platform writes a new tree.toml, which revives the same row.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-restore-1', jsonb_build_array(pg_temp.hire('nora-back', nora, 'Nora Skov'))),
		1, 'saved');
	if public.qorpera_memory_session_tree_root('70000000-0000-4000-8000-000000000020', s) is not null
		or public.qorpera_memory_owner_root('70000000-0000-4000-8000-000000000020', 'agent', nora) is distinct from 'agents/nora-back/memory/thread' then
		raise exception 'A restored agent''s tree stays retired until the platform writes it again'; end if;
	r := pg_temp.memory('tree-nora-2', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/nora-back/memory/thread'),
		pg_temp.tree_file('agents/nora-back/memory/thread/tree.toml', pg_temp.toml(s))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	t := pg_temp.tree(s);
	if t.retired_at is not null or t.root_path is distinct from 'agents/nora-back/memory/thread' or t.node_bytes is distinct from 1024
		or (select count(*) from public.qorpera_memory_trees where session_id = s) <> 1 then
		raise exception 'A new tree.toml revives the tree: %', to_jsonb(t); end if;
end $$;

-- 4. A group chat's tree, at agents/groups/<group>/memory, follows the chat's rename ------------------------------------

do $$
declare
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; otto constant uuid := '70000000-0000-4000-8000-0000000000a2';
	launch constant uuid := '70000000-0000-4000-8000-0000000000b1'; s uuid; r jsonb; i integer; t public.qorpera_memory_trees;
	root constant text := 'agents/groups/launch/memory';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-group-0', jsonb_build_array(pg_temp.hire('otto', otto, 'Otto'))),
		1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-group-1', jsonb_build_array(
		pg_temp.new_group('launch', launch, 'Launch', array[nora, otto], array['70000000-0000-4000-8000-000000000001']::uuid[]))),
		1, 'saved');
	s := (select session_id from public.qorpera_company_rooms where id = launch);
	perform pg_temp.events(s, 1);
	r := pg_temp.memory('tree-group-2', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1)]))), array[s]);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	t := pg_temp.tree(s);
	if t.root_path is distinct from root or t.owner_kind is distinct from 'group' or t.owner_id is distinct from launch
		or public.qorpera_memory_owner_root('70000000-0000-4000-8000-000000000020', 'group', launch) is distinct from root then
		raise exception 'A group chat''s tree is its own: %', to_jsonb(t); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-group-3', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/groups/launch','to','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	t := pg_temp.tree(s);
	if t.root_path is distinct from 'agents/groups/launch-team/memory'
		or t.toml_path_version is distinct from pg_temp.version('agents/groups/launch-team/memory/tree.toml')
		or pg_temp.nodes(s) is distinct from '0:0:1'
		or (select block_path from public.qorpera_memory_tree_nodes where session_id = s) is distinct from 'agents/groups/launch-team/memory/t0/00000000.jsonl'
		or public.qorpera_memory_owner_root('70000000-0000-4000-8000-000000000020', 'group', launch) is distinct from t.root_path then
		raise exception 'A group chat''s tree follows its rename: %', to_jsonb(t); end if;
end $$;

-- 5. Erasing a deleted agent folder deletes its retired tree row, and no other tree's ----------------------------------

do $$
declare
	vera constant uuid := '70000000-0000-4000-8000-0000000000a4'; s uuid; r jsonb; n bigint;
	root constant text := 'agents/vera/memory/thread';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-erase-1', jsonb_build_array(pg_temp.hire('vera', vera, 'Vera'))), 1, 'saved');
	s := pg_temp.thread(vera);
	r := pg_temp.memory('tree-erase-2', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tree-erase-3', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/vera','expectedVersion',pg_temp.version('agents/vera'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	if (pg_temp.tree(s)).retired_at is null then raise exception 'Fixture: Vera''s tree is retired'; end if;
	n := (select count(*) from public.qorpera_memory_trees where environment_id = '70000000-0000-4000-8000-000000000020');
	r := public.qorpera_folder_erase('70000000-0000-4000-8000-000000000020', pg_temp.owner(), '["agents/vera"]', 'tree-erase-4');
	if r ->> 'erasureId' is null or exists (select 1 from public.qorpera_memory_trees where session_id = s)
		or (select count(*) from public.qorpera_memory_trees where environment_id = '70000000-0000-4000-8000-000000000020') <> n - 1 then
		raise exception 'Erasure deletes the retired tree under its root, and only that one: %', r; end if;
end $$;

rollback;
