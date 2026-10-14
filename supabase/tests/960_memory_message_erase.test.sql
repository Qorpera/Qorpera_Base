-- @fixture 700_folder_state_vision_agents.test.sql until "-- 2. The vision: a new name"
-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930320000): a message's erase, steps 1 to 4.
-- The helpers; a request and its refusals; step 1 in one memory commit (the event and its input blanked, the candidate
-- blocks deleted with their other lines kept, the run table); step 2's plan and rewrite; step 3's block-history requests;
-- step 4's scrub of the receipts; the readers after an erase; and the privileges.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A statement that must fail with this SQLSTATE.
create function pg_temp.fails(p_sql text, p_state text, p_what text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from p_state then
		raise exception '%: got % (%), want %', p_what, v_state, v_message, p_state using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '70000000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
-- Events 1 to n: 2 is not a message (session_info), 4 is a question, the rest are messages; event n is message n - 2
-- from 3 on. Each entry has its id e<n> and names e<n-1> as its parent.
create function pg_temp.events(p_session uuid, p_count integer) returns void language sql as $$
	insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
	select p_session, n, extensions.gen_random_uuid(),
		case n when 2 then 'session_info' when 4 then 'interaction_request' else 'message' end,
		'70000000-0000-4000-8000-000000000001',
		jsonb_build_object('entry', jsonb_build_object('n', n, 'id', 'e' || n, 'parentId', case when n > 1 then 'e' || (n - 1) end),
			'text', 'message ' || n),
		pg_temp.ehash(n), statement_timestamp() + n * interval '1 second'
	from generate_series(1, p_count) n
$$;
create function pg_temp.event(p_session uuid, p_seq bigint) returns public.qorpera_session_events language sql as $$
	select * from public.qorpera_session_events where session_id = p_session and sequence = p_seq
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
-- A line above level 0 as the erase writes it back (its keys in the index's order).
create function pg_temp.kept(p_l integer, p_k bigint, p_text text default 'summed up') returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"text":"%s","tries":1}', p_l, p_k, p_text)
$$;
create function pg_temp.block(p_lines text[]) returns text language sql as $$
	select array_to_string(p_lines, E'\n') || E'\n'
$$;
-- tree.toml as the platform stages it (application/toml), or a block (text/markdown, the fixture's).
create function pg_temp.toml_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,
		'file',pg_temp.seal_v2('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}',
			replace(pg_temp.manifest_v2(p_text), '"text/markdown"', '"application/toml"')) -> 'file',
		'structured', jsonb_build_array(pg_temp.entry(p_path, 'memory-tree', p_text, '{"kind":"memory-tree"}')))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.block_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'memory-block', p_text, '{"kind":"memory-block"}', p_expected)
$$;
create function pg_temp.memory(p_key text, p_units jsonb, p_sessions uuid[]) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', coalesce((select jsonb_agg(jsonb_build_object('sessionId', s.id,
			'generation', s.memory_generation) order by u.o)
			from unnest(p_sessions) with ordinality u(id, o) join public.qorpera_shared_sessions s on s.id = u.id), '[]'::jsonb)))
$$;
create function pg_temp.nodes(p_session uuid) returns text language sql as $$
	select coalesce(string_agg(n.l || ':' || n.k || ':' || coalesce(n.seq::text, '-'), ',' order by n.l, n.k), '')
	from public.qorpera_memory_tree_nodes n
	where n.environment_id = '70000000-0000-4000-8000-000000000020' and n.session_id = p_session
$$;
create function pg_temp.erase(p_id uuid) returns public.qorpera_memory_message_erases language sql as $$
	select * from public.qorpera_memory_message_erases where id = p_id
$$;
-- An erase's blocks as rel:kind:keep(l:k, ...):cutoff?, by key.
create function pg_temp.blocks(p_id uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(substr(b.block_key, length(e.root_key) + 2) || ':' || b.kind || ':'
		|| coalesce((select string_agg((x ->> 'l') || '.' || (x ->> 'k'), ' ' order by (x ->> 'l')::integer, (x ->> 'k')::bigint)
			from jsonb_array_elements(b.keep) x), case when b.keep is null then '-' else '' end)
		|| ':' || case when b.cutoff_seq is null then 'key' else 'cut' end
		order by b.block_key collate "C"), '[]'::jsonb)
	from public.qorpera_memory_message_erase_blocks b join public.qorpera_memory_message_erases e on e.id = b.erase_id
	where b.erase_id = p_id
$$;
-- Step 2 as the runtime runs it: the plan, each text staged, the rewrite.
create function pg_temp.rewrite(p_id uuid) returns jsonb language plpgsql as $$
declare v_plan jsonb := public.qorpera_memory_message_erase_plan('70000000-0000-4000-8000-000000000020', p_id);
begin
	return public.qorpera_memory_message_erase_rewrite('70000000-0000-4000-8000-000000000020', p_id, v_plan ->> 'planSha256',
		coalesce((select jsonb_agg(jsonb_build_object('path', b ->> 'path', 'file', pg_temp.stage(b ->> 'text')) order by o)
			from jsonb_array_elements(v_plan -> 'blocks') with ordinality x(b, o)), '[]'::jsonb));
end $$;

-- 1. The helpers: an entry's id, the lines an erase drops, its candidate blocks, a line as the index holds it ----------

do $$
begin
	perform pg_temp.same(jsonb_build_array(
			public.qorpera_memory_entry_id('{"entry":{"id":"e7"}}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"erased":true}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"erased":true,"entry":{"id":"e7"}}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"text":"x"}', '70000000-0000-4000-8000-0000000000e7')),
		'["e7","70000000-0000-4000-8000-0000000000e7","e7",null]', 'An erased event''s entry id is its event id');
	-- Message 5: level 0 from 5 to 31, level 1 from 2 to 15, level 4 only 0 and 1. Message 20: from 20 to 47 at level 0,
	-- and no level-4 line before 1.
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_erase_drops(i, l, k) order by o) from (values
		(1, 5, 0, 4), (2, 5, 0, 5), (3, 5, 0, 31), (4, 5, 0, 32), (5, 5, 1, 1), (6, 5, 1, 2), (7, 5, 1, 15), (8, 5, 1, 16),
		(9, 5, 4, 0), (10, 5, 4, 1), (11, 5, 4, 2), (12, 5, 14, 0), (13, 20, 0, 19), (14, 20, 0, 47), (15, 20, 0, 48),
		(16, 20, 4, 0), (17, 20, 4, 1), (18, 0, 0, 0), (19, 15, 0, 31), (20, 16, 0, 15)) x(o, i, l, k)),
		'[false,true,true,false,false,true,true,false,true,true,false,true,false,true,false,false,true,true,true,false]',
		'The lines an erase drops');
	perform pg_temp.same((select jsonb_agg(rel order by block_key collate "C") from public.qorpera_memory_erase_candidates('r', 5)
		where rel ~ '^t[01]/'), '["t0/00000000.jsonl","t0/00000001.jsonl","t1/00000000.jsonl"]', 'Message 5''s candidates');
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_memory_erase_candidates('r', 5))), '16', 'Two in tier 0, one above');
	perform pg_temp.same((select jsonb_agg(rel order by block_key collate "C") from public.qorpera_memory_erase_candidates('r', 40)
		where rel ~ '^t[01]/'), '["t0/00000002.jsonl","t0/00000003.jsonl","t1/00000000.jsonl"]', 'Message 40''s candidates');
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_memory_erase_candidates(null, 5))), '0', 'No root, no candidates');
end $$;

-- 2. The Co-Founder's tree, and a request for message 5 (event 7) with its refusals -------------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); root constant text := 'agents/co-founder/memory/thread';
	r jsonb; i integer; e7 uuid; e2 uuid;
begin
	perform pg_temp.events(s, 34);
	r := pg_temp.memory('m3-tree-1', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',root),
		pg_temp.toml_file(root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.block_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3),
			pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line0(4, 6), pg_temp.line0(5, 7), pg_temp.line0(6, 8),
			pg_temp.line(1, 0), pg_temp.line(1, 1), pg_temp.line(1, 2), pg_temp.line(2, 0), pg_temp.line(2, 1), pg_temp.line(3, 0)])),
		pg_temp.block_file(root || '/t0/00000001.jsonl', pg_temp.block(array[pg_temp.line0(16, 18), pg_temp.line(1, 8)])),
		pg_temp.block_file(root || '/t0/00000002.jsonl', pg_temp.block(array[pg_temp.line0(32, 34)])),
		jsonb_build_object('op','mkdir','path',root || '/t1'),
		pg_temp.block_file(root || '/t1/00000000.jsonl', pg_temp.block(array[pg_temp.line(4, 0)])),
		jsonb_build_object('op','mkdir','path',root || '/t2'),
		pg_temp.block_file(root || '/t2/00000000.jsonl', pg_temp.block(array[pg_temp.line(8, 0)]))), array[s]);
	for i in 1..10 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- A block deleted before the erase keeps its versions: step 3 asks it by key alone.
	r := pg_temp.memory('m3-tree-2', jsonb_build_array(jsonb_build_object('op','delete','path',root || '/t2/00000000.jsonl',
		'expectedVersion',pg_temp.version(root || '/t2/00000000.jsonl'))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)),
		'"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,0:5:7,0:6:8,0:16:18,0:32:34,1:0:-,1:1:-,1:2:-,1:8:-,2:0:-,2:1:-,3:0:-,4:0:-"', 'The tree');
	e7 := (pg_temp.event(s, 7)).event_id; e2 := (pg_temp.event(s, 2)).event_id;

	-- Only the folder core asks.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e7), '42501', 'Only the folder core');
	perform pg_temp.service();
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, null), '22023', 'A request names all four');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), e7),
		'P0002', 'No such conversation');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), s, e7), '42501', 'Not a member');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e2), 'P0002', 'Not a message');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, extensions.gen_random_uuid()),
		'P0002', 'No such message');
	if exists (select 1 from public.qorpera_memory_message_erases) then raise exception 'A refusal leaves no row'; end if;

	r := public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e7);
	perform pg_temp.same(r - 'eraseId', jsonb_build_object('schema', 'qorpera.memory-message-erase/v1', 'state', 'pending',
		'sessionId', s, 'eventId', e7, 'blocks', 0, 'runsPending', 0), 'A request');
	perform pg_temp.same(public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', s, e7), r, 'A second request joins the first');
	perform pg_temp.same(to_jsonb((select array_agg(x.erase_id) from public.qorpera_memory_message_erase_due(10) x)),
		jsonb_build_array(r -> 'eraseId'), 'The queue');
	perform pg_temp.same((select jsonb_build_object('sequence', e.sequence, 'index', e.message_index, 'input', e.input_id,
			'user', e.requested_by_user_id, 'generation', e.generation, 'root', e.root_key)
		from public.qorpera_memory_message_erases e where e.id = (r ->> 'eraseId')::uuid),
		'{"sequence":7,"index":5,"input":null,"user":"70000000-0000-4000-8000-000000000001","generation":null,"root":null}',
		'The row holds the message and its number');
	perform pg_temp.same(public.qorpera_memory_message_erase_status('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', (r ->> 'eraseId')::uuid), r, 'Its status');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_status(%L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), r ->> 'eraseId'), 'P0002', 'Status for members only');
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(0)', '22023', 'A limit from 1 to 1000');
end $$;

-- 3. Step 1: one memory commit blanks the event, deletes the three live candidate blocks and keeps their other lines ----

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); root constant text := 'agents/co-founder/memory/thread';
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); g bigint; r jsonb; er public.qorpera_memory_message_erases;
begin
	perform pg_temp.service();
	g := (select memory_generation from public.qorpera_shared_sessions where id = s);
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1","state":"open",'
		'"blocks":4,"runsPending":0}', 'Step 1 opens the erase');
	er := pg_temp.erase(eid);
	if er.generation is distinct from g + 1 or (select memory_generation from public.qorpera_shared_sessions where id = s) <> g + 1
		or er.owner_kind is distinct from 'agent' or er.owner_id is distinct from '70000000-0000-4000-8000-0000000000c0'
		or er.root_key is distinct from root or er.last_error is not null then
		raise exception 'The row holds the generation, the owner and the root: %', to_jsonb(er); end if;
	-- The event keeps its place and hash; its body goes. Its neighbours stay.
	if (pg_temp.event(s, 7)).body is distinct from '{"erased":true}'::jsonb or (pg_temp.event(s, 7)).event_hash <> pg_temp.ehash(7)
		or (pg_temp.event(s, 6)).body #>> '{entry,id}' is distinct from 'e6' or (pg_temp.event(s, 8)).body #>> '{entry,id}' is distinct from 'e8' then
		raise exception 'Step 1 blanks the event and only it'; end if;
	-- The deleted blocks' lines leave the index; the unrelated block stays.
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:32:34"', 'The index after step 1');
	if pg_temp.version(root || '/t0/00000000.jsonl') is not null or pg_temp.version(root || '/t0/00000001.jsonl') is not null
		or pg_temp.version(root || '/t1/00000000.jsonl') is not null or pg_temp.version(root || '/t0/00000002.jsonl') is null
		or pg_temp.version(root || '/tree.toml') is null then
		raise exception 'Step 1 deletes the live candidate blocks and nothing else'; end if;
	perform pg_temp.same(pg_temp.blocks(eid), '["t0/00000000.jsonl:block:0.0 0.1 0.2 0.3 0.4 1.0 1.1 2.0:cut",'
		'"t0/00000001.jsonl:block::cut","t1/00000000.jsonl:block::cut","t2/00000000.jsonl:block:-:key"]', 'The blocks');
	-- A kept line as the index held it.
	perform pg_temp.same((select b.keep -> 0 from public.qorpera_memory_message_erase_blocks b
			where b.erase_id = eid and b.block_key = root || '/t0/00000000.jsonl'),
		jsonb_build_object('l', 0, 'k', 0, 'line', pg_temp.line0(0, 1)), 'A kept level-0 line');
	perform pg_temp.same((select b.keep -> 7 from public.qorpera_memory_message_erase_blocks b
			where b.erase_id = eid and b.block_key = root || '/t0/00000000.jsonl'),
		jsonb_build_object('l', 2, 'k', 0, 'line', pg_temp.kept(2, 0)), 'A kept summary line');
	-- The commit: the member's, by the eraser's key; each cut is its block's delete there.
	if not exists (select 1 from public.qorpera_folder_commits c where c.id = er.commit_id
			and c.requester_kind = 'member' and c.requester_id = '70000000-0000-4000-8000-000000000001'
			and c.operation_key like 'memerase:' || eid || ':%')
		or exists (select 1 from public.qorpera_memory_message_erase_blocks b where b.erase_id = eid and b.cutoff_seq is not null
			and not exists (select 1 from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
				where v.commit_id = er.commit_id and v.op = 'delete' and v.key_sha256 = extensions.digest(b.block_key, 'sha256')
					and c.seq = b.cutoff_seq and v.unit_no = b.cutoff_unit)) then
		raise exception 'The member''s commit and its cuts'; end if;
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_folder_commits c where c.operation_key like 'memerase:%')), '1',
		'One commit');
	-- An open erase is past step 1: a second call answers where it stands.
	perform pg_temp.same(public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid), r, 'Step 1 runs once');
	perform pg_temp.same(public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', s, (pg_temp.event(s, 7)).event_id), r, 'A request joins the open erase');
end $$;
