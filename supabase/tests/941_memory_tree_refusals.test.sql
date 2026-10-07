-- @fixture 700_folder_state_vision_agents.test.sql until "-- 2. The vision: a new name"
-- Summary trees M1a (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.2, §4.3; 20260930110000, 20260930111000): what
-- is refused. A block's own rules; the platform-only paths outside the memory commit; inside it, only a tree's own
-- files, each naming its conversation's current generation, with tree.toml and every level-0 line bound to the
-- conversation; the memory commit's request; and who may call what.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '70000000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
-- Events 1 to n: 2 is not a message (session_info), 4 is a question, the rest are messages.
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
create function pg_temp.line0(p_k bigint, p_seq bigint, p_text text default 'said') returns text language sql as $$
	select format('{"l":0,"k":%s,"seq":%s,"hash":"%s","free":true,"text":"%s"}', p_k, p_seq, pg_temp.ehash(p_seq), p_text)
$$;
create function pg_temp.line(p_l integer, p_k bigint, p_text text default 'summed up') returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
create function pg_temp.block(p_lines text[]) returns text language sql as $$
	select array_to_string(p_lines, E'\n') || E'\n'
$$;
create function pg_temp.tree_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind), p_expected)
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
-- A file that is no structured file.
create function pg_temp.plain(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
$$;
-- A memory commit as the platform, naming each conversation at its current generation, or at the one given.
create function pg_temp.memory(p_key text, p_units jsonb, p_sessions uuid[], p_generation bigint default null) returns jsonb
language sql as $$
	select public.qorpera_folder_memory_commit('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', coalesce((select jsonb_agg(jsonb_build_object('sessionId', s.id,
			'generation', coalesce(p_generation, s.memory_generation)) order by u.o)
			from unnest(p_sessions) with ordinality u(id, o) join public.qorpera_shared_sessions s on s.id = u.id), '[]'::jsonb)))
$$;
-- A unit refused with one problem.
create function pg_temp.refused(p_result jsonb, p_unit integer, p_reason text, p_message text, p_code text default 'value',
	p_line integer default null)
returns void language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from 'refused' or v ->> 'reason' is distinct from p_reason
		or jsonb_array_length(v -> 'problems') is distinct from 1 or v -> 'problems' -> 0 ->> 'code' is distinct from p_code
		or v -> 'problems' -> 0 ->> 'message' is distinct from p_message
		or (v -> 'problems' -> 0 ->> 'line')::integer is distinct from p_line then
		raise exception 'Unit % expected % (%, line %: %), got %', p_unit, p_reason, p_code, p_line, p_message, p_result
			using errcode = 'QTF01'; end if;
end $$;
-- A statement that must fail with this SQLSTATE.
create function pg_temp.raises(p_sql text, p_state text) returns void language plpgsql as $$
declare v_state text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate;
		if v_state = p_state then return; end if;
		raise exception '% raised %, want %', left(p_sql, 300), v_state, p_state using errcode = 'QTF01';
	end;
	raise exception '% did not raise %', left(p_sql, 300), p_state using errcode = 'QTF01';
end $$;
-- A block's parse in short: "lines <n>", or "<line or -> <problem>".
create function pg_temp.block_result(p_key text, p_text text) returns text language sql as $$
	select case when r ? 'lines' then 'lines ' || jsonb_array_length(r -> 'lines')
		else coalesce(r ->> 'line', '-') || ' ' || (r ->> 'problem') end
	from (select public.qorpera_memory_block_parse(p_key, p_text) as r) x
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

-- 1. A block's own rules ------------------------------------------------------------------------------------------------

do $$
declare
	b0 constant text := 'agents/nora/memory/thread/t0/00000000.jsonl'; t1 constant text := 'agents/nora/memory/thread/t1/00000000.jsonl';
	full_block text[] := array(select pg_temp.line0(k, k + 1) from generate_series(0, 15) k)
		|| array(select pg_temp.line(1, k) from generate_series(0, 7) k) || array(select pg_temp.line(2, k) from generate_series(0, 3) k)
		|| array(select pg_temp.line(3, k) from generate_series(0, 1) k);
	size_problem constant text := '- a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes';
	not_a_line constant text := '1 this line is not a summary line';
begin
	perform pg_temp.same(to_jsonb(array[
		pg_temp.block_result(b0, pg_temp.block(full_block)),
		pg_temp.block_result(b0, pg_temp.block(full_block || pg_temp.line(3, 1))),
		pg_temp.block_result(b0, pg_temp.line0(0, 1)),
		pg_temp.block_result(b0, ''),
		pg_temp.block_result(b0, E'\n'),
		pg_temp.block_result(b0, repeat('x', 65004) || E'\n'),
		pg_temp.block_result(b0, pg_temp.line0(0, 1) || E'\n\n' || pg_temp.line0(1, 3) || E'\n'),
		pg_temp.block_result('agents/nora/memory/thread/t15/00000000.jsonl', pg_temp.block(array[pg_temp.line(60, 0)])),
		pg_temp.block_result('agents/nora/memory/thread/t0/0000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1)]))]),
		to_jsonb(array['lines 30', size_problem, size_problem, size_problem, size_problem, size_problem,
			'2 this line is not a summary line', '- a block''s name is t<tier>/<8 digits>.jsonl',
			'- a block''s name is t<tier>/<8 digits>.jsonl']), 'A block''s count, size and name');

	-- Sizes: 2,048 bytes of text as stored, escapes counted; a line is sized before it is parsed, and again by its level.
	perform pg_temp.same(to_jsonb(array[
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(0, 1, repeat('a', 2048))])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line(1, 0, repeat('a', 2048))])),
		pg_temp.block_result(b0, pg_temp.block(array[format('{"l":1,"k":0,"free":false,"tries":1,"text":"%s\""}', repeat('a', 2047))])),
		pg_temp.block_result(b0, pg_temp.block(array[format('{"l":1,"k":0,"free":false,"tries":1,"text":"%s\\"}', repeat('a', 2047))])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(0, 1, repeat(chr(233), 1024))])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(0, 1, repeat(chr(233), 1024) || 'a')])),
		pg_temp.block_result(b0, pg_temp.block(array[repeat('x', 2213)])),
		pg_temp.block_result(b0, pg_temp.block(array['{"l":1,"k":0,"free":false,"tries":1,"text":"x"' || repeat(' ', 2100) || '}'])),
		pg_temp.block_result(b0, pg_temp.block(array['{"l":0,"k":0,"seq":1,"hash":"' || pg_temp.ehash(1) || '","free":true,"text":"x"'
			|| repeat(' ', 2000) || '}']))]),
		to_jsonb(array['lines 1', 'lines 1', not_a_line, not_a_line, 'lines 1', not_a_line,
			'1 this line is longer than a summary line can be', '1 this line is longer than a summary line can be', 'lines 1']),
		'A line''s sizes');

	-- Order and place: by level, then number, each once; levels 4t to 4t+3 inside the block.
	perform pg_temp.same(to_jsonb(array[
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line(1, 0), pg_temp.line0(0, 1)])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(0, 1)])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(1, 3), pg_temp.line0(0, 1)])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line0(16, 17)])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line(1, 8)])),
		pg_temp.block_result(b0, pg_temp.block(array[pg_temp.line(4, 0)])),
		pg_temp.block_result(t1, pg_temp.block(array[pg_temp.line0(0, 1)])),
		pg_temp.block_result(t1, pg_temp.block(array[pg_temp.line(4, 0), pg_temp.line(4, 15), pg_temp.line(7, 1)])),
		pg_temp.block_result(t1, pg_temp.block(array[pg_temp.line(4, 16)])),
		pg_temp.block_result('agents/nora/memory/thread/t1/00000001.jsonl', pg_temp.block(array[pg_temp.line(4, 16), pg_temp.line(7, 3)]))]),
		to_jsonb(array['2 the lines go by level, then by number, each once', '2 the lines go by level, then by number, each once',
			'2 the lines go by level, then by number, each once', '1 this line does not belong in this block',
			'1 this line does not belong in this block', '1 this line does not belong in this block',
			'1 this line does not belong in this block', 'lines 3', '1 this line does not belong in this block', 'lines 2']),
		'A line''s order and place');

	-- A line's keys are closed, each once, typed: 22 that are no line, then 3 that are.
	perform pg_temp.same((select jsonb_agg(pg_temp.block_result(b0, l || E'\n') order by o) from unnest(array[
		'{"l":1,"k":0,"free":true,"tries":1,"text":"x"}',
		'{"l":1,"k":0,"free":false,"text":"x"}',
		'{"l":1,"k":0,"free":false,"tries":4,"text":"x"}',
		'{"l":1,"k":0,"free":false,"tries":0,"text":"x"}',
		'{"l":1,"l":1,"k":0,"free":false,"tries":1,"text":"x"}',
		'{"l":1,"k":0,"free":false,"tries":1,"text":"x","x":1}',
		'{"l":1,"k":-1,"free":false,"tries":1,"text":"x"}',
		'{"l":1,"k":1.0,"free":false,"tries":1,"text":"x"}',
		'{"l":1,"k":"0","free":false,"tries":1,"text":"x"}',
		'{"l":1,"k":0,"free":"true","text":"x"}',
		'{"l":1,"k":0,"free":true,"text":1}',
		'{"l":1,"k":0,"free":true,"text":"a\u0007"}',
		'{"l":1,"k":0,"free":true,"text":"a\u009f"}',
		'{"l":0,"k":0,"seq":1,"free":true,"text":"x"}',
		'{"l":0,"k":0,"seq":1,"hash":"' || upper(pg_temp.ehash(1)) || '","free":true,"text":"x"}',
		'{"l":0,"k":0,"seq":"1","hash":"' || pg_temp.ehash(1) || '","free":true,"text":"x"}',
		'{"l":0,"k":0,"hash":"' || pg_temp.ehash(1) || '","free":true,"text":"x"}',
		'{"l":1,"k":0,"seq":1,"free":true,"text":"x"}',
		'[1]',
		'{"l":60,"k":0,"free":true,"text":"x"}',
		'{"l":1,"k":9223372036854775808,"free":true,"text":"x"}',
		'{"l":"1","k":0,"free":true,"text":"x"}',
		'{"l":1,"k":0,"free":true,"text":"x"}',
		'{"l":0,"k":0,"seq":1,"hash":"' || pg_temp.ehash(1) || '","free":false,"tries":3,"text":""}',
		'{"text":"x","free":true,"k":0,"l":1}']) with ordinality x(l, o)),
		(select jsonb_agg(case when o > 22 then 'lines 1' else not_a_line end order by o)
			from generate_series(1, 25) o), 'A line''s keys');
end $$;

-- 2. Outside the memory commit, trees are the platform's -----------------------------------------------------------------

do $$
declare
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; otto constant uuid := '70000000-0000-4000-8000-0000000000a2';
	launch constant uuid := '70000000-0000-4000-8000-0000000000b1'; ns uuid; gs uuid; r jsonb; i integer;
	pia constant uuid := '70000000-0000-4000-8000-0000000000a3'; ps uuid;
	root constant text := 'agents/nora/memory/thread';
begin
	r := pg_temp.commit(pg_temp.owner(), 'refuse-hire-1', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'),
		pg_temp.hire('otto', otto, 'Otto'), jsonb_build_object('op','mkdir','path','notes')));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-group-1', jsonb_build_array(
		pg_temp.new_group('launch', launch, 'Launch', array[nora, otto], array['70000000-0000-4000-8000-000000000001']::uuid[]))),
		1, 'saved');
	ns := pg_temp.thread(nora);
	gs := (select session_id from public.qorpera_company_rooms where id = launch);
	perform pg_temp.events(ns, 5);
	perform pg_temp.events(gs, 1);
	r := pg_temp.memory('refuse-tree-1', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(ns)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3)]))), array[ns]);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.memory('refuse-tree-2', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/groups/launch/memory'),
		pg_temp.tree_file('agents/groups/launch/memory/tree.toml', pg_temp.toml(gs))), array[gs]);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;

	-- A copy out of a tree is a read: its files are ordinary files there, and no tree.
	r := pg_temp.commit(pg_temp.owner(), 'refuse-copy-1', jsonb_build_array(
		jsonb_build_object('op','copy','from',root,'to','notes/thread-copy'),
		jsonb_build_object('op','copy','from',root || '/tree.toml','to','notes/tree.toml')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	if (select count(*) from public.qorpera_memory_trees where environment_id = '70000000-0000-4000-8000-000000000020') <> 2
		or (select count(*) from public.qorpera_memory_tree_nodes where environment_id = '70000000-0000-4000-8000-000000000020') <> 2
		or pg_temp.version('notes/thread-copy/t0/00000000.jsonl') is null then
		raise exception 'A copy out of a tree indexes nothing'; end if;
	-- The notebook beside the thread stays the agent's.
	r := pg_temp.commit(pg_temp.owner(), 'refuse-notebook-1', jsonb_build_array(pg_temp.plain('agents/nora/memory/notes.md', 'Remember.'),
		jsonb_build_object('op','mkdir','path','agents/nora/memory/people')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	-- A folder elsewhere shaped like a tree, to move into agents/.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-shape-1', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','notes/x','contents',jsonb_build_array(jsonb_build_object('path','memory','kind','folder'),
			jsonb_build_object('path','memory/thread','kind','folder'),
			jsonb_build_object('path','memory/thread/tree.toml','kind','file','file',pg_temp.stage(pg_temp.toml(ns))))))), 1, 'saved');

	-- Each of these is the platform's, one unit per change set.
	for r in select pg_temp.commit(pg_temp.owner(), 'refuse-owner-' || o, jsonb_build_array(u)) from unnest(array[
		-- writes at or under a root
		pg_temp.plain(root || '/notes.md', 'Mine.'),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(ns, 512), pg_temp.version(root || '/tree.toml')),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1)]), pg_temp.version(root || '/t0/00000000.jsonl')),
		jsonb_build_object('op','mkdir','path','agents/otto/memory/thread'),
		jsonb_build_object('op','mkdir','path',root || '/t1'),
		jsonb_build_object('op','mkdir','path','agents/groups/launch/memory/t0'),
		jsonb_set(pg_temp.hire('pia', '70000000-0000-4000-8000-0000000000a3', 'Pia'), '{contents}',
			(pg_temp.hire('pia', '70000000-0000-4000-8000-0000000000a3', 'Pia') -> 'contents')
				|| jsonb_build_array(jsonb_build_object('path','memory/thread','kind','folder'))),
		-- deletes of a tree's files, its root, or the notebook folder that holds the root
		jsonb_build_object('op','delete','path',root || '/t0/00000000.jsonl','expectedVersion',pg_temp.version(root || '/t0/00000000.jsonl')),
		jsonb_build_object('op','delete','path',root,'expectedVersion',pg_temp.version(root),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','delete','path','agents/nora/memory','expectedVersion',pg_temp.version('agents/nora/memory'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','delete','path','agents/groups/launch/memory','expectedVersion',pg_temp.version('agents/groups/launch/memory'),
			'asOfSeq',pg_temp.seq()),
		-- moves of a tree's parts, onto a root, or carrying a root to another kind of place
		jsonb_build_object('op','move','from','agents/nora/memory','to','agents/nora/notebook','expectedVersion',
			pg_temp.version('agents/nora/memory'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from',root || '/t0','to',root || '/t1','expectedVersion',pg_temp.version(root || '/t0'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','notes/thread-copy','to','agents/otto/memory/thread','expectedVersion',
			pg_temp.version('notes/thread-copy'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','agents/nora','to','agents/groups/nora','expectedVersion',pg_temp.version('agents/nora'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','agents/groups/launch','to','agents/launch','expectedVersion',
			pg_temp.version('agents/groups/launch'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','notes/x','to','agents/x','expectedVersion',pg_temp.version('notes/x'),'asOfSeq',pg_temp.seq()),
		-- copies into a tree, or of a folder holding one into agents/
		jsonb_build_object('op','copy','from','agents/nora/memory/notes.md','to',root || '/notes.md'),
		jsonb_build_object('op','copy','from','notes/thread-copy','to','agents/otto/memory/thread'),
		jsonb_build_object('op','copy','from','agents/nora','to','agents/nora-copy'),
		jsonb_build_object('op','copy','from','notes/x','to','agents/x')]) with ordinality x(u, o) order by o loop
		perform pg_temp.refused(r, 1, 'platform_only', 'summary trees are written by the platform only');
	end loop;
	-- The platform too, without the memory commit.
	perform pg_temp.refused(pg_temp.commit('{"kind":"platform"}', 'refuse-platform-1', jsonb_build_array(
		pg_temp.tree_file(root || '/t0/00000001.jsonl', pg_temp.block(array[pg_temp.line0(16, 18)])))),
		1, 'platform_only', 'summary trees are written by the platform only');
	if pg_temp.version(root || '/tree.toml') is null or pg_temp.version('agents/x') is not null or pg_temp.version('agents/nora-copy') is not null
		or pg_temp.version('agents/otto/memory/thread') is not null then
		raise exception 'Nothing refused changed the folder'; end if;

	-- Until it holds the root, agents/<agent>/memory is the agent's: Pia clears it away, puts a file there, makes it
	-- again spelled otherwise and moves it out and back. Then the memory commit makes her root, and it is the platform's.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-1', jsonb_build_array(pg_temp.hire('pia', pia, 'Pia'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-2', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/pia/memory','expectedVersion',pg_temp.version('agents/pia/memory'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-3', jsonb_build_array(pg_temp.plain('agents/pia/memory', 'A file.'))),
		1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-4', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/pia/memory','expectedVersion',pg_temp.version('agents/pia/memory')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-5', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents/pia/Memory'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-6', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/pia/Memory','to','agents/pia/notebook','expectedVersion',pg_temp.version('agents/pia/memory'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'refuse-pia-7', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/pia/notebook','to','agents/pia/memory','expectedVersion',pg_temp.version('agents/pia/notebook'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	ps := pg_temp.thread(pia);
	r := pg_temp.memory('refuse-pia-tree', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/pia/memory/thread'),
		pg_temp.tree_file('agents/pia/memory/thread/tree.toml', pg_temp.toml(ps))), array[ps]);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	for r in select pg_temp.commit(pg_temp.owner(), 'refuse-pia-' || (7 + o), jsonb_build_array(u)) from unnest(array[
		jsonb_build_object('op','delete','path','agents/pia/memory','expectedVersion',pg_temp.version('agents/pia/memory'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','agents/pia/memory','to','agents/pia/notebook','expectedVersion',
			pg_temp.version('agents/pia/memory'),'asOfSeq',pg_temp.seq())]) with ordinality x(u, o) order by o loop
		perform pg_temp.refused(r, 1, 'platform_only', 'summary trees are written by the platform only');
	end loop;
	if pg_temp.version('agents/pia/memory/thread/tree.toml') is null or pg_temp.version('agents/pia/notebook') is not null then
		raise exception 'Pia''s tree stays where it is'; end if;
end $$;

-- 3. Inside the memory commit: only a tree's own files, each naming its conversation at its current generation --------

do $$
declare
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; otto constant uuid := '70000000-0000-4000-8000-0000000000a2';
	ns uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a1'); os uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a2');
	cs uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	root constant text := 'agents/nora/memory/thread'; oroot constant text := 'agents/otto/memory/thread'; r jsonb;
	block0 constant text := 'agents/nora/memory/thread/t0/00000000.jsonl';
	only_tree constant text := 'a summary tree holds only tree.toml and its blocks; only blocks are deleted';
	no_generation constant text := 'a summary tree''s change names its conversation''s generation';
	mismatch constant text := 'a level-0 line does not match its message (seq, hash and number)';
begin
	-- Not moved, not copied, nothing else written, only blocks deleted, paths as the folder spells them.
	perform pg_temp.refused(pg_temp.memory('refuse-memory-1', jsonb_build_array(jsonb_build_object('op','move','from',block0,
		'to',root || '/t0/00000001.jsonl','expectedVersion',pg_temp.version(block0))), array[ns]),
		1, 'structured_rule', 'a summary tree''s files are not moved or copied');
	perform pg_temp.refused(pg_temp.memory('refuse-memory-2', jsonb_build_array(jsonb_build_object('op','copy','from',block0,
		'to',root || '/t0/00000001.jsonl')), array[ns]), 1, 'structured_rule', 'a summary tree''s files are not moved or copied');
	perform pg_temp.refused(pg_temp.memory('refuse-memory-3', jsonb_build_array(pg_temp.plain('notes/a.md', 'A.')), array[ns]),
		1, 'structured_rule', 'a memory commit writes only summary trees');
	perform pg_temp.refused(pg_temp.memory('refuse-memory-4', jsonb_build_array(pg_temp.plain('agents/nora/memory/other.md', 'B.')),
		array[ns]), 1, 'structured_rule', 'a memory commit writes only summary trees');
	perform pg_temp.refused(pg_temp.memory('refuse-memory-5', jsonb_build_array(pg_temp.plain(root || '/notes.md', 'C.')), array[ns]),
		1, 'structured_rule', only_tree);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-6', jsonb_build_array(jsonb_build_object('op','delete','path',root || '/tree.toml',
		'expectedVersion',pg_temp.version(root || '/tree.toml'))), array[ns]), 1, 'structured_rule', only_tree);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-7', jsonb_build_array(jsonb_build_object('op','delete','path',root || '/t0',
		'expectedVersion',pg_temp.version(root || '/t0'),'asOfSeq',pg_temp.seq())), array[ns]), 1, 'structured_rule', only_tree);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-8', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/t15')),
		array[ns]), 1, 'structured_rule', only_tree);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-9', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/T1')),
		array[ns]), 1, 'structured_invalid', 'write the path in lowercase, as ' || root || '/t1', 'name');

	-- Each tree.toml or t<n> unit names its conversation; the root alone needs none.
	perform pg_temp.refused(pg_temp.memory('refuse-memory-10', jsonb_build_array(
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(ns, 512), pg_temp.version(root || '/tree.toml'))), '{}'),
		1, 'structured_rule', no_generation);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-11', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/t1')),
		array[os]), 1, 'structured_rule', no_generation);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-12', jsonb_build_array(jsonb_build_object('op','new_folder','path',oroot,
		'contents',jsonb_build_array(jsonb_build_object('path','t0','kind','folder')))), '{}'), 1, 'structured_rule', no_generation);
	perform pg_temp.expect(pg_temp.memory('refuse-memory-13', jsonb_build_array(jsonb_build_object('op','mkdir','path',oroot)), '{}'),
		1, 'saved');
	if exists (select 1 from public.qorpera_memory_trees where session_id = os) then
		raise exception 'A root without tree.toml has no tree'; end if;
	perform pg_temp.refused(pg_temp.memory('refuse-memory-14', jsonb_build_array(jsonb_build_object('op','mkdir','path',oroot || '/t0'),
		pg_temp.tree_file(oroot || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1)]))), array[os]),
		2, 'structured_rule', 'write this tree''s tree.toml first');

	-- A request that is not this change set's.
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', '70000000-0000-4000-8000-000000000020',
		'operationKey', 'someone-else', 'preconditions', '{}'::jsonb)::text, true);
	r := pg_temp.commit('{"kind":"platform"}', 'refuse-memory-15', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/t1')));
	perform set_config('qorpera.folder_memory', '', true);
	perform pg_temp.refused(r, 1, 'structured_rule', 'the memory request does not belong to this change');
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', extensions.gen_random_uuid(),
		'operationKey', 'refuse-memory-16', 'preconditions', '{}'::jsonb)::text, true);
	r := pg_temp.commit('{"kind":"platform"}', 'refuse-memory-16', jsonb_build_array(pg_temp.plain('notes/b.md', 'B.')));
	perform set_config('qorpera.folder_memory', '', true);
	perform pg_temp.refused(r, 1, 'structured_rule', 'the memory request does not belong to this change');

	-- An erase raised the generation: every unit of a change set naming the old one is refused.
	update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = ns;
	r := pg_temp.memory('refuse-memory-17', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/t1'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1, 'again')]), pg_temp.version(block0)),
		pg_temp.plain('notes/c.md', 'C.')), array[ns], 0);
	perform pg_temp.expect(r, 1, 'refused', 'memory_generation_stale');
	perform pg_temp.expect(r, 2, 'refused', 'memory_generation_stale');
	perform pg_temp.expect(r, 3, 'refused', 'memory_generation_stale');
	perform pg_temp.expect(pg_temp.memory('refuse-memory-18', jsonb_build_array(jsonb_build_object('op','mkdir','path',root || '/t1')),
		array[ns]), 1, 'saved');

	-- tree.toml: exact, the owner's own conversation, and no other tree holds the conversation or the place.
	perform pg_temp.refused(pg_temp.memory('refuse-memory-19', jsonb_build_array(
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(os), pg_temp.version(root || '/tree.toml'))), array[ns]),
		1, 'structured_rule', 'conversation is this tree''s own, ' || ns);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-20', jsonb_build_array(
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(ns) || E'\n', pg_temp.version(root || '/tree.toml'))), array[ns]),
		1, 'structured_invalid', 'tree.toml is format = 1, conversation = "<id>" and node_bytes = 1 to 1024, one per line');
	insert into public.qorpera_memory_trees(environment_id, session_id, root_path, root_key, owner_kind, owner_id, node_bytes,
		toml_path_version, commit_id)
	values ('70000000-0000-4000-8000-000000000020', os, 'agents/ghost/memory/thread', 'agents/ghost/memory/thread', 'agent', otto, 1024,
		extensions.gen_random_uuid(), extensions.gen_random_uuid());
	perform pg_temp.refused(pg_temp.memory('refuse-memory-21', jsonb_build_array(pg_temp.tree_file(oroot || '/tree.toml', pg_temp.toml(os))),
		array[os]), 1, 'structured_rule', 'another tree holds this conversation or this place');
	-- The place: a tree of the Co-Founder's conversation at Otto's root. The change names both.
	if cs is null then raise exception 'The Co-Founder has a thread'; end if;
	update public.qorpera_memory_trees set session_id = cs, root_path = oroot, root_key = oroot where session_id = os;
	perform pg_temp.refused(pg_temp.memory('refuse-memory-22', jsonb_build_array(pg_temp.tree_file(oroot || '/tree.toml', pg_temp.toml(os))),
		array[os, cs]), 1, 'structured_rule', 'another tree holds this conversation or this place');
	delete from public.qorpera_memory_trees where root_key = oroot;
	perform pg_temp.expect(pg_temp.memory('refuse-memory-23', jsonb_build_array(pg_temp.tree_file(oroot || '/tree.toml', pg_temp.toml(os))),
		array[os]), 1, 'saved');

	-- A block: its parse is only its kind; its lines parse; each level-0 line is its event, by seq, hash and number.
	perform pg_temp.refused(pg_temp.memory('refuse-memory-24', jsonb_build_array(pg_temp.write(block0, 'memory-block',
		pg_temp.block(array[pg_temp.line0(0, 1)]), '{"kind":"memory-block","lines":1}', pg_temp.version(block0))), array[ns]),
		1, 'structured_invalid', 'the platform could not read this file; save it again', 'front_matter');
	perform pg_temp.refused(pg_temp.memory('refuse-memory-25', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(1, 3)]), pg_temp.version(block0))), array[ns]),
		1, 'structured_invalid', 'the lines go by level, then by number, each once', 'value', 3);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-26', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(0, 1), replace(pg_temp.line0(1, 3), pg_temp.ehash(3), pg_temp.ehash(9))]), pg_temp.version(block0))),
		array[ns]), 1, 'structured_rule', mismatch);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-27', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(2, 3)]), pg_temp.version(block0))), array[ns]), 1, 'structured_rule', mismatch);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-28', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(1, 2)]), pg_temp.version(block0))), array[ns]), 1, 'structured_rule', mismatch);
	perform pg_temp.refused(pg_temp.memory('refuse-memory-29', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(5, 6)]), pg_temp.version(block0))), array[ns]), 1, 'structured_rule', mismatch);
	-- Lines above level 0 bind to nothing yet; the right events save, a question counted as a message.
	perform pg_temp.expect(pg_temp.memory('refuse-memory-30', jsonb_build_array(pg_temp.tree_file(block0,
		pg_temp.block(array[pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line(1, 0), pg_temp.line(3, 1)]), pg_temp.version(block0))),
		array[ns]), 1, 'saved');
	if (select string_agg(l || ':' || k, ',' order by l, k) from public.qorpera_memory_tree_nodes where session_id = ns)
		is distinct from '0:1,0:2,1:0,3:1' then
		raise exception 'The saved block is the index'; end if;
end $$;

-- 4. The memory commit's request ----------------------------------------------------------------------------------------

do $$
declare
	ns uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a1'); os uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a2');
	env constant uuid := '70000000-0000-4000-8000-000000000020'; v_call constant text := 'select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)';
begin
	perform pg_temp.same((select jsonb_agg(public.qorpera_folder_memory_preconditions_valid(env, p) order by o) from unnest(array[
		'{}'::jsonb,
		'{"sessionGenerations":[]}',
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', 1),
			jsonb_build_object('sessionId', os, 'generation', 999999999999999999))),
		'[]',
		'{"other":1}',
		'{"sessionGenerations":{}}',
		'{"sessionGenerations":[1]}',
		(select jsonb_build_object('sessionGenerations', jsonb_agg(jsonb_build_object('sessionId', ns, 'generation', n)))
			from generate_series(1, 65) n),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', 1),
			jsonb_build_object('sessionId', ns, 'generation', 1))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', -1))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', '1'))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', 1000000000000000000))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', 1.5))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', upper(ns::text), 'generation', 1))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns, 'generation', 1, 'x', 1))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', ns))),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', extensions.gen_random_uuid(), 'generation', 0)))])
		with ordinality x(p, o)),
		(select jsonb_agg(o <= 3 order by o) from generate_series(1, 17) o), 'Preconditions');

	perform pg_temp.raises(format(v_call, env, '{"kind":"platform"}', 'bad-1', '[]', '{"other":1}'), '22023');
	perform pg_temp.raises(format(v_call, null, '{"kind":"platform"}', 'bad-2', '[]', '{}'), '22023');
	perform pg_temp.raises(format(v_call, env, '{"kind":"platform"}', '', '[]', '{}'), '22023');
	perform pg_temp.raises(format(v_call, env, '{"kind":"platform"}', null, '[]', '{}'), '22023');
	perform set_config('qorpera.folder_memory', '{"x":1}', true);
	perform pg_temp.raises(format(v_call, env, '{"kind":"platform"}', 'bad-3', '[]', '{}'), '55000');
	perform set_config('qorpera.folder_memory', '', true);
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.raises(format(v_call, env, '{"kind":"platform"}', 'bad-4', '[]', '{}'), '42501');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	-- Only the service role calls the memory commit; nothing else of M1a is anyone's to call or write.
	perform pg_temp.same(to_jsonb(array[
		has_function_privilege('service_role', 'public.qorpera_folder_memory_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)', 'execute'),
		has_function_privilege('authenticated', 'public.qorpera_folder_memory_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)', 'execute'),
		has_function_privilege('anon', 'public.qorpera_folder_memory_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_folder_memory_request()', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_folder_memory_preconditions_valid(uuid,jsonb)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_generation_decide(uuid,uuid)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_tree_file_rules(uuid,jsonb,text,text,jsonb,text)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_tree_index(uuid,uuid,text,text,uuid,text,text)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_tree_moved(uuid,uuid,text,text,text)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_tree_deleted(uuid,uuid,text)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_owner_root(uuid,text,uuid)', 'execute'),
		has_function_privilege('authenticated', 'public.qorpera_memory_message_index(uuid,bigint)', 'execute'),
		has_function_privilege('anon', 'public.qorpera_memory_block_parse(text,text)', 'execute'),
		has_table_privilege('service_role', 'public.qorpera_memory_trees', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_trees', 'insert'),
		has_table_privilege('service_role', 'public.qorpera_memory_tree_nodes', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_tree_nodes', 'update'),
		has_table_privilege('service_role', 'public.qorpera_memory_read_receipts', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_read_receipts', 'insert'),
		has_table_privilege('authenticated', 'public.qorpera_memory_trees', 'select'),
		has_table_privilege('anon', 'public.qorpera_memory_tree_nodes', 'select')]),
		'[true,false,false,false,false,false,false,false,false,false,false,false,false,false,true,false,true,false,true,false,false,false]',
		'Who may call and write');
end $$;

rollback;
