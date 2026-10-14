-- @fixture 960_memory_message_erase.test.sql until "-- 1. The helpers: an entry"
-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930320000): a message's erase across its
-- owner's life. A member's message with an image, its agent renamed first (the tree and the image under an earlier root),
-- its agent deleted (no root, nothing to rewrite), its agent hired again; a later erase of the conversation, a block live
-- again, another request at a block's key, and a member who is no longer an owner or admin.

-- An erase's blocks as key:kind:kept lines:cutoff?, by key (whole keys: some lie under earlier roots).
create function pg_temp.keys(p_id uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(b.block_key || ':' || b.kind || ':' || coalesce(jsonb_array_length(b.keep)::text, '-')
		|| ':' || case when b.cutoff_seq is null then 'key' else 'cut' end order by b.block_key collate "C"), '[]'::jsonb)
	from public.qorpera_memory_message_erase_blocks b where b.erase_id = p_id
$$;
-- A member's message at this place, with its input (as the turn-input step writes it; the fixture has no active bundle,
-- and step 1's update of the input checks its bundle again).
create function pg_temp.member(p_session uuid, p_seq bigint, p_cid uuid) returns uuid language plpgsql as $$
declare
	v_input uuid := extensions.gen_random_uuid(); v_event uuid := extensions.gen_random_uuid(); v_bundle uuid := extensions.gen_random_uuid();
	v_manifest constant jsonb := jsonb_build_object('m3x', p_seq);
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_bundles(id, bundle_key, version, manifest, sha256)
	values (v_bundle, 'qorpera.m3x-test', p_seq, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex'));
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, body)
	values (v_input, p_session, p_cid, '70000000-0000-4000-8000-000000000001', 'human', 'user_message',
		v_bundle, encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex'),
		jsonb_build_object('text', 'message ' || p_seq));
	insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash,
		created_at, session_input_id)
	values (p_session, p_seq, v_event, 'message', '70000000-0000-4000-8000-000000000001',
		jsonb_build_object('entry', jsonb_build_object('n', p_seq, 'id', 'e' || p_seq, 'parentId', 'e' || (p_seq - 1)),
			'text', 'message ' || p_seq), pg_temp.ehash(p_seq), statement_timestamp() + p_seq * interval '1 second', v_input);
	set local session_replication_role = origin;
	return v_event;
end $$;
-- The message's image, as the room's image commit writes it: root/images/<cid>/<sha256>.png, with no structured entry.
create function pg_temp.image(p_root text, p_cid uuid) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','mkdir','path',p_root || '/images/' || p_cid),
		jsonb_build_object('op','write','path',p_root || '/images/' || p_cid || '/'
			|| encode(extensions.digest(convert_to('png ' || p_cid, 'utf8'), 'sha256'), 'hex') || '.png',
			'file', pg_temp.seal_v2('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}',
				replace(pg_temp.manifest_v2('png ' || p_cid), '"text/markdown"', '"image/png"')) -> 'file'))
$$;
-- P18's steps until this erasure is done or waiting, as pg_cron runs them (from 883).
create function pg_temp.drain(p_id uuid) returns void language plpgsql as $$
begin
	for i in 1..60 loop
		exit when (select state from public.qorpera_folder_erasures where id = p_id) <> 'working';
		perform public.qorpera_folder_erasure_step(3, 3, 3);
	end loop;
end $$;
-- Step 3 until the erase is requested, as the eraser runs it: a block whose history another erasure's versions phase
-- covers is asked again once that phase is past (here its steps run in between). Returns the reply and the waits.
create function pg_temp.ask_all(p_id uuid) returns jsonb language plpgsql as $$
declare r jsonb; v_waits integer := 0; v_erasure uuid;
begin
	for i in 1..40 loop
		r := public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', p_id);
		exit when r ->> 'state' <> 'rewritten';
		if (pg_temp.erase(p_id)).last_error is not null then
			if (pg_temp.erase(p_id)).last_error <> 'Block history is being erased; ask again' then
				raise exception 'Ask: %', (pg_temp.erase(p_id)).last_error; end if;
			v_waits := v_waits + 1;
			for v_erasure in select e.id from public.qorpera_folder_erasures e where e.state = 'working' and e.phase = 1 loop
				perform pg_temp.drain(v_erasure); end loop;
		end if;
	end loop;
	return r || jsonb_build_object('waits', v_waits);
end $$;
-- The path versions at a key or under it.
create function pg_temp.versions_at(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_path_versions
	where environment_id = '70000000-0000-4000-8000-000000000020'
		and (public.qorpera_folder_key(path) = p_key or public.qorpera_folder_key(path) like p_key || '/%')
$$;
-- The erase of this message.
create function pg_temp.erase_of(p_session uuid, p_seq bigint) returns uuid language sql as $$
	select e.id from public.qorpera_memory_message_erases e
	where e.event_id = (pg_temp.event(p_session, p_seq)).event_id and e.state <> 'refused'
$$;

-- 1. Nora's tree and a member's message with an image; Nora renamed; the erase finds both roots --------------------------

do $$
declare
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; s uuid; r jsonb; i integer;
	root constant text := 'agents/nora-dahl/memory/thread'; cid constant uuid := '96100000-0000-4000-8000-0000000000c7';
begin
	r := pg_temp.commit(pg_temp.owner(), 'm3x-hire-1', jsonb_build_array(pg_temp.hire('nora-dahl', nora, 'Nora Dahl')));
	perform pg_temp.expect(r, 1, 'saved');
	s := pg_temp.thread(nora);
	perform pg_temp.events(s, 6);
	perform pg_temp.member(s, 7, cid);
	r := pg_temp.memory('m3x-tree-1', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',root),
		pg_temp.toml_file(root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.block_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3),
			pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line0(4, 6), pg_temp.line0(5, 7),
			pg_temp.line(1, 0), pg_temp.line(1, 2), pg_temp.line(2, 0), pg_temp.line(3, 0)])),
		jsonb_build_object('op','mkdir','path',root || '/images')) || pg_temp.image(root, cid), array[s]);
	for i in 1..7 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- Renamed: the tree, its nodes and the image move to the new root; the old paths keep their versions.
	r := pg_temp.commit(pg_temp.owner(), 'm3x-rename-1', jsonb_build_array(
		pg_temp.write('agents/nora-dahl/agent.md', 'agent', pg_temp.agent_text(nora, 'Nora Skov'), pg_temp.agent_parse(nora, 'Nora Skov'),
			pg_temp.version('agents/nora-dahl/agent.md')),
		jsonb_build_object('op','move','from','agents/nora-dahl','to','agents/nora-skov',
			'expectedVersion',pg_temp.version('agents/nora-dahl'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.version('agents/nora-skov/memory/thread/images/' || cid) is null
		or pg_temp.version(root || '/t0/00000000.jsonl') is not null then
		raise exception 'The rename moves the tree'; end if;
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,0:5:7,1:0:-,1:2:-,2:0:-,3:0:-"', 'The tree');
end $$;

-- 2. Step 1 under the new root: the live block and image deleted, the old root's by key alone; steps 2 and 3 -----------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a1'); eid uuid; r jsonb; er public.qorpera_memory_message_erases;
	old constant text := 'agents/nora-dahl/memory/thread'; root constant text := 'agents/nora-skov/memory/thread';
	cid constant uuid := '96100000-0000-4000-8000-0000000000c7';
begin
	perform pg_temp.service();
	r := public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001',
		s, (pg_temp.event(s, 7)).event_id);
	eid := (r ->> 'eraseId')::uuid;
	if (pg_temp.erase(eid)).client_input_id is distinct from cid or (pg_temp.erase(eid)).input_id is null then
		raise exception 'The request holds the member''s input'; end if;
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r -> 'state', '"open"', 'Step 1 opens the erase');
	er := pg_temp.erase(eid);
	if er.root_key is distinct from root or er.owner_kind is distinct from 'agent' or er.commit_id is null then
		raise exception 'The row holds the new root: %', to_jsonb(er); end if;
	perform pg_temp.same(pg_temp.keys(eid), jsonb_build_array(old || '/images/' || cid || ':images:-:key',
		old || '/t0/00000000.jsonl:block:-:key', root || '/images/' || cid || ':images:-:key',
		root || '/t0/00000000.jsonl:block:7:cut'), 'The blocks under both roots');
	if (select body from public.qorpera_session_inputs where id = er.input_id) is distinct from '{"erased":true}'::jsonb
		or (pg_temp.event(s, 7)).body is distinct from '{"erased":true}'::jsonb then
		raise exception 'Step 1 blanks the event and its input'; end if;
	if pg_temp.version(root || '/images/' || cid) is not null or pg_temp.version(root || '/t0/00000000.jsonl') is not null
		or pg_temp.version(root || '/tree.toml') is null then
		raise exception 'Step 1 deletes the block and the image under the new root'; end if;
	-- Step 2 writes the kept lines under the new root.
	perform pg_temp.same(pg_temp.rewrite(eid) -> 'state', '"rewritten"', 'Step 2');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,1:0:-,2:0:-"', 'The kept lines');
	-- Step 3 asks each block, the image folders too, under both roots. An old path's history continues at the new one
	-- (the move): its erasure takes the new path's life up to step 1's delete, so the new path's own request, asked once
	-- that erasure's versions phase is past, finds nothing left before its cutoff.
	r := pg_temp.ask_all(eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1","state":"requested",'
		'"blocks":4,"runsPending":0,"waits":1}', 'Step 3');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(b.block_key, b.erasure_id is not null, b.copies,
			e.id is null or e.block_history ->> 'path' = b.path) order by b.block_key collate "C")
			from public.qorpera_memory_message_erase_blocks b left join public.qorpera_folder_erasures e on e.id = b.erasure_id
			where b.erase_id = eid),
		jsonb_build_array(jsonb_build_array(old || '/images/' || cid, true, '[]'::jsonb, true),
			jsonb_build_array(old || '/t0/00000000.jsonl', true, '[]'::jsonb, true),
			jsonb_build_array(root || '/images/' || cid, false, '[]'::jsonb, true),
			jsonb_build_array(root || '/t0/00000000.jsonl', false, '[]'::jsonb, true)), 'Each block''s request');
	-- Once P18 is done: no version of the image or the block before the erase, under either root; the rewritten block stays.
	perform pg_temp.same(jsonb_build_array(pg_temp.versions_at(old || '/images/' || cid), pg_temp.versions_at(old || '/t0/00000000.jsonl'),
			pg_temp.versions_at(root || '/images/' || cid), pg_temp.versions_at(root || '/t0/00000000.jsonl')),
		'[0, 0, 0, 1]', 'The versions left');
	if pg_temp.version(root || '/t0/00000000.jsonl') is null or pg_temp.version(old || '/tree.toml') is not null
		or pg_temp.versions_at(old || '/tree.toml') = 0 or pg_temp.version(root || '/tree.toml') is null then
		raise exception 'The rewritten block and the tree stay'; end if;
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,1:0:-,2:0:-"', 'The index after P18');
end $$;

rollback;
