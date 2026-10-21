-- @fixture 926_folder_core_proposals.test.sql until "-- 1. A view parks"
-- Company folder links, LK1 (migration 20260930380000; deploy/first-node/RUNTIME-FOLDER-LINKS.md): a view makes links as
-- plain writes and parks their deletion and move for review, which applies them; a parked hire's link is listed with
-- its target and made with the agent; a conflicting link keeps a conflict copy of kind 'symlink' with its target, also
-- for each link of a conflicting new folder; erasure removes a link's target with its history and copies and leaves a
-- link naming the erased path as it was; a hard link's bytes wait for GC only once its last path is erased. On 926's
-- company (its fixture part); the unit itself is in 460.

-- A symlink unit; a null target or version is left out.
create function pg_temp.link(p_path text, p_target text, p_expected text default null) returns jsonb language sql as $$
	select jsonb_strip_nulls(jsonb_build_object('op','symlink','path',p_path,'target',p_target,'expectedVersion',p_expected))
$$;
create function pg_temp.entry(p_path text) returns jsonb language sql as $$
	select pg_temp.read(p_path) -> 'entry'
$$;
create function pg_temp.version(p_path text) returns text language sql as $$
	select pg_temp.read(p_path) -> 'entry' ->> 'version'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'
$$;
create function pg_temp.copies(p_commit jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_conflict_copies_of('63400000-0000-4000-8000-000000000020', (p_commit ->> 'commitId')::uuid)
$$;
-- A proposal's path rows: unit, item, path and manifest.
create function pg_temp.paths(p_proposal uuid) returns jsonb language sql as $$
	select jsonb_agg(jsonb_build_object('unit', q.unit_no, 'item', q.item_no, 'path', q.path, 'manifest', q.manifest_sha256)
		order by q.unit_no, q.item_no) from public.qorpera_folder_proposal_paths q where q.proposal_id = p_proposal
$$;
-- Steps an erasure until it is done or waiting, as pg_cron would; a waiting one is revisited once (its bytes).
create function pg_temp.settle(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for n in 1..60 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step(3, 3, 3);
	end loop;
	if v.state = 'waiting' then
		update public.qorpera_folder_erasures set revisit_at = clock_timestamp() - interval '1 second' where id = p_id;
		perform public.qorpera_folder_erasure_step();
	end if;
	select * into v from public.qorpera_folder_erasures where id = p_id;
	return v;
end $$;
-- Whether any row of a public table holds a text.
create function pg_temp.found_in(p_table text, p_text text) returns boolean language plpgsql as $$
declare v boolean;
begin
	execute format('select exists (select 1 from public.%I t where t::text like %L)', p_table, '%' || p_text || '%') into v;
	return v;
end $$;
-- The company's upload intents end (they root their objects for a day after they end).
create function pg_temp.expire_intents() returns void language sql as $$
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where environment_id = '63400000-0000-4000-8000-000000000020'
$$;

-- 1. A view makes links as it makes files; deleting or moving one waits for review, and the approval applies it.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); r jsonb; p public.qorpera_folder_proposals;
begin
	r := pg_temp.vcommit(b, 'lk-view-make', jsonb_build_array(jsonb_build_object('op','mkdir','path','lkr'),
		pg_temp.link('lkr/a.lnk', '../a-target'), pg_temp.link('lkr/b.lnk', 'b-target')));
	perform pg_temp.expect(r, 3, 'saved');
	if (pg_temp.parked(r)).id is not null or pg_temp.entry('lkr/b.lnk') ->> 'target' <> 'b-target' then
		raise exception 'A view''s links: %', r; end if;
	r := pg_temp.vcommit(b, 'lk-view-delete', jsonb_build_array(pg_temp.deletes('lkr/a.lnk')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	p := pg_temp.parked(r);
	if p.effect <> 'destructive' or not pg_temp.present('lkr/a.lnk') then raise exception 'A parked link deletion: %', to_jsonb(p); end if;
	perform pg_temp.same(pg_temp.paths(p.id), '[{"unit":1,"item":0,"path":"lkr/a.lnk","manifest":null}]', 'Its path rows');
	perform set_config('qorpera_test.lk_delete', p.id::text, true);
	r := pg_temp.vcommit(b, 'lk-view-move', jsonb_build_array(jsonb_build_object('op','move','from','lkr/b.lnk','to','lkr/c.lnk',
		'expectedVersion',pg_temp.version('lkr/b.lnk'))));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	p := pg_temp.parked(r);
	if p.effect <> 'destructive' or pg_temp.present('lkr/c.lnk') then raise exception 'A parked link move: %', to_jsonb(p); end if;
	perform pg_temp.same(pg_temp.paths(p.id), '[{"unit":1,"item":0,"path":"lkr/b.lnk","manifest":null},
		{"unit":1,"item":1,"path":"lkr/c.lnk","manifest":null}]', 'Its path rows');
	perform set_config('qorpera_test.lk_move', p.id::text, true);
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); p uuid := current_setting('qorpera_test.lk_delete')::uuid;
begin
	perform pg_temp.expect(pg_temp.approve(x, 'apply-lk-delete', p), 1, 'saved');
	if (pg_temp.proposal(p)).status <> 'applied' or pg_temp.present('lkr/a.lnk') then
		raise exception 'The approved link deletion: %', to_jsonb(pg_temp.proposal(p)); end if;
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); p uuid := current_setting('qorpera_test.lk_move')::uuid;
begin
	perform pg_temp.expect(pg_temp.approve(x, 'apply-lk-move', p), 1, 'saved');
	if (pg_temp.proposal(p)).status <> 'applied' or pg_temp.present('lkr/b.lnk') or pg_temp.entry('lkr/c.lnk') ->> 'kind' <> 'symlink'
		or pg_temp.entry('lkr/c.lnk') ->> 'target' <> 'b-target' then
		raise exception 'The approved link move: % %', to_jsonb(pg_temp.proposal(p)), pg_temp.entry('lkr/c.lnk'); end if;
end $$;

-- 2. A parked hire whose new folder holds a link: its path row has no bytes, the list names the link with its target
-- for the review to read, and the approval makes it with the agent.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); h jsonb; r jsonb; p public.qorpera_folder_proposals;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'lk-agents-folder',
		'[{"op":"mkdir","path":"QorperaOS"},{"op":"mkdir","path":"QorperaOS/agents"}]'), 2, 'saved');
	h := pg_temp.hire(b, 'pia', '63400000-0000-4000-8000-00000000f460', 'Pia');
	h := jsonb_set(h, '{contents}', (h -> 'contents') || '[{"path":"notes.lnk","kind":"symlink","target":"../shared/notes.md"}]');
	r := pg_temp.vcommit(b, 'lk-park-hire', jsonb_build_array(h));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	p := pg_temp.parked(r);
	if p.effect <> 'delegation' or jsonb_array_length(pg_temp.paths(p.id)) <> 5
		or pg_temp.paths(p.id) -> 4 <> '{"unit":1,"item":4,"path":"QorperaOS/agents/pia/notes.lnk","manifest":null}' then
		raise exception 'The parked hire: % %', to_jsonb(p), pg_temp.paths(p.id); end if;
	perform pg_temp.same((select q -> 'units' -> 0 -> 'contains' from jsonb_array_elements(pg_temp.list(x -> 'actor') -> 'proposals') q
		where q ->> 'proposalId' = p.id::text), '[{"path":"QorperaOS/agents/pia/agent.md","kind":"file"},
		{"path":"QorperaOS/agents/pia/memory","kind":"folder"},{"path":"QorperaOS/agents/pia/todos","kind":"folder"},
		{"path":"QorperaOS/agents/pia/notes.lnk","kind":"symlink","target":"../shared/notes.md"}]', 'A listed new folder''s link');
	perform set_config('qorpera_test.lk_hire', p.id::text, true);
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); p uuid := current_setting('qorpera_test.lk_hire')::uuid; e jsonb;
begin
	perform pg_temp.expect(pg_temp.approve(x, 'apply-lk-hire', p, 'delegation'), 1, 'saved');
	e := pg_temp.entry('QorperaOS/agents/pia/notes.lnk');
	if (pg_temp.proposal(p)).status <> 'applied' or e ->> 'kind' <> 'symlink' or e ->> 'target' <> '../shared/notes.md'
		or not exists (select 1 from public.qorpera_profile_staff where profile_id = '63400000-0000-4000-8000-000000000010'
			and staff_agent_id = '63400000-0000-4000-8000-00000000f460') then
		raise exception 'The approved hire''s link: % %', to_jsonb(pg_temp.proposal(p)), e; end if;
end $$;

-- 3. Conflict copies: a link that lands on a taken path or a stale version keeps its target as a copy of kind
-- 'symlink'; a conflicting new folder keeps one per file and per link, by item.
do $$
declare m jsonb := pg_temp.member(2); r jsonb; v_file jsonb := pg_temp.stage('lkc k text', pg_temp.member(2));
begin
	perform pg_temp.expect(pg_temp.commit(m, 'lkc-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lkc'),
		jsonb_build_object('op','write','path','lkc/f.txt','file',pg_temp.stage('lkc f text', m)))), 2, 'saved');
	r := pg_temp.commit(m, 'lkc-taken', jsonb_build_array(pg_temp.link('lkc/f.txt', 'mine.txt')));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	perform pg_temp.same(pg_temp.copies(r), '[{"unit":1,"file":1,"path":"lkc/f.txt","kind":"symlink","target":"mine.txt"}]',
		'A taken path''s copy');
	r := pg_temp.commit(m, 'lkc-stale', jsonb_build_array(pg_temp.link('lkc/f.txt', 'stale.txt', extensions.gen_random_uuid()::text)));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	perform pg_temp.same(pg_temp.copies(r), '[{"unit":1,"file":1,"path":"lkc/f.txt","kind":"symlink","target":"stale.txt"}]',
		'A stale version''s copy');
	r := pg_temp.commit(m, 'lkc-new-folder', jsonb_build_array(jsonb_build_object('op','new_folder','path','lkc','contents',
		jsonb_build_array(jsonb_build_object('path','k.txt','kind','file','file',v_file),
			jsonb_build_object('path','k.lnk','kind','symlink','target','../k-target')))));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	perform pg_temp.same(pg_temp.copies(r), jsonb_build_array(
		jsonb_build_object('unit',1,'file',1,'path','lkc/k.txt','manifestSha256',v_file ->> 'manifestSha256'),
		jsonb_build_object('unit',1,'file',2,'path','lkc/k.lnk','kind','symlink','target','../k-target')), 'A new folder''s copies');
end $$;

-- 4. Erasure: an erased folder's links go with their history and their conflict copies, so no row holds a target any
-- more; a link elsewhere whose target names the erased path is left as it was (a target is never resolved).
do $$
declare m jsonb := pg_temp.member(2); e jsonb; v public.qorpera_folder_erasures; v_table text; v_hit text[] := '{}';
	v_secret constant text := 'lk1-erase-target-7f3a';
begin
	perform pg_temp.expect(pg_temp.commit(m, 'lke-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lke'),
		pg_temp.link('lke/a.lnk', v_secret), jsonb_build_object('op','mkdir','path','lkx'), pg_temp.link('lkx/pointer.lnk', 'lke/a.lnk'))),
		4, 'saved');
	perform pg_temp.expect(pg_temp.commit(m, 'lke-copy', jsonb_build_array(pg_temp.link('lke/a.lnk', v_secret))), 1, 'conflict', 'exists');
	perform pg_temp.expect(pg_temp.commit(m, 'lke-delete', jsonb_build_array(jsonb_build_object('op','delete','path','lke',
		'expectedVersion',pg_temp.version('lke'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	e := public.qorpera_folder_erase('63400000-0000-4000-8000-000000000020', pg_temp.member(1), '["lke"]', 'lk-erase-1');
	perform pg_temp.same(e -> 'copies', '[]', 'A link''s erasure names no copies of bytes');
	perform pg_temp.expire_intents();
	v := pg_temp.settle((e ->> 'erasureId')::uuid);
	if v.state <> 'done' then raise exception 'The erasure: %', to_jsonb(v); end if;
	for v_table in select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname loop
		if pg_temp.found_in(v_table, v_secret) then v_hit := v_hit || v_table; end if;
	end loop;
	if cardinality(v_hit) > 0 then raise exception 'An erased link''s target is still held in %', v_hit; end if;
	if pg_temp.entry('lkx/pointer.lnk') ->> 'target' <> 'lke/a.lnk' then
		raise exception 'A link naming the erased path: %', pg_temp.entry('lkx/pointer.lnk'); end if;
end $$;

-- 5. A hard link roots its bytes: erasing the first path names the second as a live copy and leaves the bytes; once the
-- second is deleted and erased too, they wait for GC.
do $$
declare m jsonb := pg_temp.member(2); a jsonb; e jsonb; v public.qorpera_folder_erasures; v_manifest text;
begin
	perform pg_temp.expect(pg_temp.commit(m, 'lkg-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lkg'),
		jsonb_build_object('op','write','path','lkg/a.txt','file',pg_temp.stage('lkg shared bytes', m)))), 2, 'saved');
	a := pg_temp.entry('lkg/a.txt');
	v_manifest := a ->> 'manifestSha256';
	perform pg_temp.expect(pg_temp.commit(m, 'lkg-link', jsonb_build_array(jsonb_build_object('op','write','path','lkg/b.txt',
		'file', a - array['path','kind','version','seq','updatedAt']))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(m, 'lkg-delete-a', jsonb_build_array(pg_temp.deletes('lkg/a.txt'))), 1, 'saved');
	e := public.qorpera_folder_erase('63400000-0000-4000-8000-000000000020', pg_temp.member(1), '["lkg/a.txt"]', 'lkg-erase-a');
	perform pg_temp.same(e -> 'copies', '[{"environmentId":"63400000-0000-4000-8000-000000000020","path":"lkg/b.txt","live":true}]',
		'The hard link is named as a live copy');
	perform pg_temp.expire_intents();
	v := pg_temp.settle((e ->> 'erasureId')::uuid);
	if v.state <> 'done' or exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63400000-0000-4000-8000-000000000010'
			and sha256 = v_manifest) then
		raise exception 'The live copy roots the bytes: %', to_jsonb(v); end if;
	if pg_temp.entry('lkg/b.txt') ->> 'manifestSha256' <> v_manifest then raise exception 'The hard link is as it was'; end if;
	perform pg_temp.expect(pg_temp.commit(m, 'lkg-delete-b', jsonb_build_array(pg_temp.deletes('lkg/b.txt'))), 1, 'saved');
	e := public.qorpera_folder_erase('63400000-0000-4000-8000-000000000020', pg_temp.member(1), '["lkg/b.txt"]', 'lkg-erase-b');
	perform pg_temp.expire_intents();
	v := pg_temp.settle((e ->> 'erasureId')::uuid);
	if v.state <> 'done' or not exists (select 1 from public.qorpera_folder_object_gc
			where profile_id = '63400000-0000-4000-8000-000000000010' and sha256 = v_manifest
				and unreferenced_since > clock_timestamp() - interval '1 minute') then
		raise exception 'The last path''s erasure leaves the bytes to GC: %', to_jsonb(v); end if;
end $$;
