-- @fixture 887_folder_core_listener.test.sql until "-- 1. Listeners: the trigger, activation, the refusals gone"
-- L09.3 (P29's tree rule, 20260930111000 M1a): a plain file wakes its listener once; a memory-tree write wakes no one.
-- A memory commit's tree files, under an agent's thread (agents/<agent>/memory/thread) or a group chat's tree
-- (agents/groups/<group>/memory), wake no listener, not even one whose watch covers them. On 708's company; rolled back.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- 940's helpers, on 708's company.
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '70700000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
create function pg_temp.toml(p_session uuid) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = 1024\n', p_session)
$$;
create function pg_temp.tree_file(p_path text, p_text text) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
-- A memory commit as the platform, naming the conversation at its current generation.
create function pg_temp.memory(p_key text, p_units jsonb, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('70700000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', s.id, 'generation', s.memory_generation))))
	from public.qorpera_shared_sessions s where s.id = p_session
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
-- The run actor of an agent's listener the owner saved (the company audience), and what it hears of a change set.
create function pg_temp.reader(p_agent uuid) returns jsonb language sql as $$
	select public.qorpera_folder_listener_actor('70700000-0000-4000-8000-000000000010', p_agent, '70700000-0000-4000-8000-000000000001', null)
$$;
create function pg_temp.hears(p_agent uuid, p_commit jsonb, p_watch text) returns jsonb language sql as $$
	select public.qorpera_folder_listener_matches('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010',
		pg_temp.reader(p_agent), (p_commit ->> 'commitId')::uuid, p_watch, 'subtree')
$$;
-- A change set's paths, each with whether Nora's and Otto's listeners may read it.
create function pg_temp.readable(p_commit jsonb) returns jsonb language sql as $$
	select jsonb_agg(jsonb_build_array(v.path,
		public.qorpera_folder_actor_allowed(v.environment_id, '70700000-0000-4000-8000-000000000010',
			pg_temp.reader('70700000-0000-4000-8000-0000000000a1'), v.path, 'read'),
		public.qorpera_folder_actor_allowed(v.environment_id, '70700000-0000-4000-8000-000000000010',
			pg_temp.reader('70700000-0000-4000-8000-0000000000a2'), v.path, 'read')) order by v.path)
	from public.qorpera_folder_path_versions v where v.commit_id = (p_commit ->> 'commitId')::uuid
$$;
-- The listeners, drained until they have heard every change set.
create function pg_temp.heard() returns void language plpgsql as $$
declare r jsonb;
begin
	loop r := pg_temp.listen(); exit when not coalesce((r ->> 'more')::boolean, false); end loop;
	if r ->> 'state' not in ('done', 'idle') or (r ->> 'processedSeq')::bigint is distinct from pg_temp.seq() then
		raise exception 'The listeners hear every change set: %', r; end if;
end $$;
-- The file wakes of the three listeners (e1/e2/e3), and the company's wakes of any kind.
create function pg_temp.woken() returns text language sql as $$
	select format('%s/%s/%s', pg_temp.fw_count('68100000-0000-4000-8000-0000000000e1'),
		pg_temp.fw_count('68100000-0000-4000-8000-0000000000e2'), pg_temp.fw_count('68100000-0000-4000-8000-0000000000e3'))
$$;
create function pg_temp.wakes() returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where environment_id = '70700000-0000-4000-8000-000000000020'
$$;

-- 1. A plain file in Nora's memory folder wakes the listeners watching it, once ---------------------------------------------

do $$
declare nora constant uuid := '70700000-0000-4000-8000-0000000000a1'; r jsonb; w public.qorpera_wake_occurrences;
begin
	perform pg_temp.saved(pg_temp.commit('{"kind":"platform"}', 'l093-0001', '[{"op":"mkdir","path":"agents/groups"}]'));
	-- e1: Nora's whole folder; e2: only her thread's tree; e3 (Otto's): every agent's folder.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'l093-0002', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/folder.md', pg_temp.watch('68100000-0000-4000-8000-0000000000e1', 'agents/nora', 'subtree')),
		pg_temp.routine('agents/nora/routines/tree.md',
			pg_temp.watch('68100000-0000-4000-8000-0000000000e2', 'agents/nora/memory/thread', 'subtree')),
		pg_temp.routine('agents/otto/routines/agents.md', pg_temp.watch('68100000-0000-4000-8000-0000000000e3', 'agents', 'subtree')))));
	perform pg_temp.heard();
	perform pg_temp.is(pg_temp.woken(), '0/0/0', 'activation: nothing up to the saving change set');
	r := pg_temp.saved(pg_temp.commit('{"kind":"platform"}', 'l093-0003', jsonb_build_array(
		pg_temp.put('agents/nora/memory/notes.md', 'A plain note.'))));
	perform pg_temp.heard();
	perform pg_temp.is(pg_temp.woken(), '1/0/1', 'a plain file wakes each listener whose watch covers it, once');
	select * into w from pg_temp.fw('68100000-0000-4000-8000-0000000000e1');
	perform pg_temp.same(w.payload, jsonb_build_object('schema','qorpera.folder-file-wake/v1','seq',(r ->> 'seq')::bigint,
		'commitId',r ->> 'commitId','versions',jsonb_build_array(pg_temp.version('agents/nora/memory/notes.md')),'more',0),
		'Nora''s wake names the plain file');
	perform pg_temp.same(pg_temp.hears(nora, r, 'agents/nora'), jsonb_build_object('versions',
		jsonb_build_array(pg_temp.version('agents/nora/memory/notes.md')), 'more', 0), 'The matcher hears the plain file');
end $$;

-- 2. A memory commit into Nora's thread tree wakes no listener, not even the one watching only the tree -------------------

do $$
declare
	nora constant uuid := '70700000-0000-4000-8000-0000000000a1'; otto constant uuid := '70700000-0000-4000-8000-0000000000a2';
	root constant text := 'agents/nora/memory/thread'; s uuid := pg_temp.thread('70700000-0000-4000-8000-0000000000a1');
	n bigint := pg_temp.wakes(); r jsonb;
begin
	-- tree.toml and a block of one level-1 line (no level-0 line, so no conversation event is needed).
	r := pg_temp.saved(pg_temp.memory('l093-0004', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', E'{"l":1,"k":0,"free":false,"tries":1,"text":"summed up"}\n')), s));
	perform pg_temp.same((select jsonb_build_array(t.root_path, t.owner_kind, t.owner_id, t.commit_id) from public.qorpera_memory_trees t
		where t.environment_id = '70700000-0000-4000-8000-000000000020' and t.session_id = s),
		jsonb_build_array(root, 'agent', nora, r ->> 'commitId'), 'The commit makes Nora''s tree');
	-- Every version is one both listeners may read: only the tree rule keeps them unheard.
	perform pg_temp.same(pg_temp.readable(r), jsonb_build_array(jsonb_build_array(root, true, true),
		jsonb_build_array(root || '/t0', true, true), jsonb_build_array(root || '/t0/00000000.jsonl', true, true),
		jsonb_build_array(root || '/tree.toml', true, true)), 'The tree''s versions, readable by both listeners');
	perform pg_temp.same(jsonb_build_array(pg_temp.hears(nora, r, 'agents/nora'), pg_temp.hears(nora, r, root),
		pg_temp.hears(otto, r, 'agents')), '[{"versions": [], "more": 0}, {"versions": [], "more": 0}, {"versions": [], "more": 0}]',
		'The matcher hears none of the tree''s files');
	perform pg_temp.heard();
	perform pg_temp.is(pg_temp.woken(), '1/0/1', 'a memory-tree write wakes no listener');
	perform pg_temp.is(pg_temp.wakes()::text, n::text, 'and no wake of any kind');
end $$;

-- 3. A group chat's tree, at agents/groups/<group>/memory, wakes no listener either; its group.md does -------------------

do $$
declare
	launch constant uuid := '68100000-0000-4000-8000-0000000000b1'; root constant text := 'agents/groups/launch/memory';
	s uuid; n bigint; r jsonb;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'l093-0005', jsonb_build_array(pg_temp.new_group('launch', launch, 'Launch',
		array['70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-0000000000a2']::uuid[],
		array['70700000-0000-4000-8000-000000000001']::uuid[]))));
	perform pg_temp.heard();
	perform pg_temp.is(pg_temp.woken(), '1/0/2', 'the new group chat wakes Otto''s listener');
	s := (select session_id from public.qorpera_company_rooms where id = launch);
	n := pg_temp.wakes();
	r := pg_temp.saved(pg_temp.memory('l093-0006', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s))), s));
	perform pg_temp.same(pg_temp.readable(r), jsonb_build_array(jsonb_build_array(root, true, true),
		jsonb_build_array(root || '/tree.toml', true, true)), 'The group tree''s versions, readable by both listeners');
	perform pg_temp.same(pg_temp.hears('70700000-0000-4000-8000-0000000000a2', r, 'agents'), '{"versions": [], "more": 0}',
		'The matcher hears none of the group tree''s files');
	perform pg_temp.heard();
	perform pg_temp.is(pg_temp.woken(), '1/0/2', 'a group chat''s tree wakes no listener');
	perform pg_temp.is(pg_temp.wakes()::text, n::text, 'and no wake of any kind');
end $$;

rollback;
