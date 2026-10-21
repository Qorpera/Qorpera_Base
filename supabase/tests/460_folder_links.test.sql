-- @fixture 926_folder_core_proposals.test.sql until "-- 1. A view parks"
-- Company folder links, LK1 (migration 20260930380000; deploy/first-node/RUNTIME-FOLDER-LINKS.md): a link is an entry
-- of kind 'symlink' holding its target, 1 to 4,095 bytes kept exactly and never resolved. Targets of every shape and
-- the length bounds; a link over a file or link at its version, and a write that makes it a file again; nothing below a
-- link; move, copy and delete of a link and of a folder holding links; a new folder's links; authority, reserved paths
-- and the places a link cannot stand; a run's read, list and release; a hard link as a write of another path's file.
-- On 926's company (its fixture part). A view's links, conflict copies and erasure are in 461.

create function pg_temp.platform(p_key text, p_units jsonb) returns jsonb language sql as $$
	select pg_temp.commit('{"kind":"platform"}', p_key, p_units)
$$;
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
create function pg_temp.pv(p_version text) returns public.qorpera_folder_path_versions language sql as $$
	select * from public.qorpera_folder_path_versions where version = p_version::uuid
$$;
-- A commit's path versions: op, kind, path and target, by unit and path.
create function pg_temp.versions_of(p_commit jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('op', v.op, 'kind', v.kind, 'path', v.path, 'target', v.target))
		order by v.unit_no, v.path collate "C", v.op collate "C"), '[]')
	from public.qorpera_folder_path_versions v where v.commit_id = (p_commit ->> 'commitId')::uuid
$$;
-- The message of a unit refused because a link cannot stand where it would.
create function pg_temp.refusal(p_result jsonb) returns text language sql as $$
	select pg_temp.expect(p_result, 1, 'refused', 'structured_invalid') -> 'problems' -> 0 ->> 'message'
$$;

-- 1. Targets are kept exactly, whatever they name: up the tree, absolute, outside the company, with spaces, the longest
-- (4,095 bytes, also as two-byte characters). Each link is a write of kind 'symlink' with its target and no file; read,
-- list, the feed and a member's path history show the target.
do $$
declare r jsonb; u jsonb; e jsonb; p public.qorpera_folder_path_versions; v_seq bigint; f jsonb; h jsonb;
	v_targets text[] := array['../up/a.txt', '/etc/hosts', '/home/x/outside', 'my docs/a file.txt', repeat('t', 4095),
		repeat('é', 2047) || 'x'];
begin
	perform pg_temp.expect(pg_temp.platform('lk-folder', '[{"op":"mkdir","path":"lk"}]'), 1, 'saved');
	v_seq := pg_temp.seq();
	r := pg_temp.platform('lk-targets', (select jsonb_agg(pg_temp.link('lk/t' || n || '.lnk', v_targets[n]) order by n)
		from generate_series(1, 6) n));
	for n in 1..6 loop
		u := pg_temp.expect(r, n, 'saved');
		e := pg_temp.entry('lk/t' || n || '.lnk');
		if e ->> 'kind' <> 'symlink' or e ->> 'target' <> v_targets[n] or e ? 'manifestSha256' or e ? 'bytes'
			or e ->> 'version' <> u ->> 'version' then raise exception 'Link %: % %', n, u, e; end if;
		p := pg_temp.pv(u ->> 'version');
		if p.op <> 'write' or p.kind <> 'symlink' or p.target <> v_targets[n] or p.prior_version is not null
			or p.manifest_sha256 is not null then raise exception 'Link %''s version: %', n, to_jsonb(p); end if;
	end loop;
	if octet_length(v_targets[6]) <> 4095 then raise exception 'Fixture: the two-byte target is 4,095 bytes'; end if;
	if (select count(*) from jsonb_array_elements(public.qorpera_folder_list('63400000-0000-4000-8000-000000000020',
			'{"kind":"platform"}', 'lk', null, 100) -> 'entries') x
			where x ->> 'kind' = 'symlink' and x ->> 'target' = v_targets[substr(x ->> 'path', 5, 1)::integer]) <> 6 then
		raise exception 'The list shows each target'; end if;
	f := public.qorpera_folder_feed('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', v_seq, 100);
	if jsonb_array_length(f -> 'events') <> 1 or f -> 'events' -> 0 ->> 'kind' <> 'change_set'
		or (select jsonb_agg(c ->> 'target' order by c ->> 'path') from jsonb_array_elements(f -> 'events' -> 0 -> 'changes') c)
			<> to_jsonb(v_targets) then raise exception 'The feed shows each target: %', f; end if;
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	h := public.qorpera_member_folder_path_history('63400000-0000-4000-8000-000000000020', 'lk/t1.lnk', null, 100);
	perform pg_temp.path_claims('service_role');
	if jsonb_array_length(h -> 'items') <> 1 or h -> 'items' -> 0 ->> 'op' <> 'write' or h -> 'items' -> 0 ->> 'kind' <> 'symlink'
		or h -> 'items' -> 0 ->> 'target' <> v_targets[1] then raise exception 'A member''s path history: %', h; end if;
end $$;

-- 2. A target of the wrong length is invalid, and keeps no copy; one that is not a string, or a link without one or
-- with a destination, is a malformed request. jsonb holds no NUL, so no target can.
do $$
declare r jsonb; t text; n integer := 0;
begin
	foreach t in array array['', repeat('t', 4096), repeat('é', 2048)] loop
		n := n + 1;
		r := pg_temp.platform('lk-bad-' || n, jsonb_build_array(pg_temp.link('lk/bad.lnk', t)));
		perform pg_temp.expect(r, 1, 'refused', 'invalid');
		perform pg_temp.same(public.qorpera_folder_conflict_copies_of('63400000-0000-4000-8000-000000000020',
			(r ->> 'commitId')::uuid), '[]', 'An invalid link keeps no copy');
	end loop;
	perform pg_temp.raises(format('select pg_temp.platform(%L, %L)', 'lk-bad-number',
		'[{"op":"symlink","path":"lk/bad.lnk","target":1}]'), '22023');
	perform pg_temp.raises(format('select pg_temp.platform(%L, %L)', 'lk-bad-none', '[{"op":"symlink","path":"lk/bad.lnk"}]'),
		'22023');
	perform pg_temp.raises(format('select pg_temp.platform(%L, %L)', 'lk-bad-to',
		'[{"op":"symlink","path":"lk/bad.lnk","target":"x","to":"lk/other.lnk"}]'), '22023');
	perform pg_temp.raises(format('select %L::jsonb', '"a' || chr(92) || 'u0000b"'), '22P05');
	if pg_temp.present('lk/bad.lnk') then raise exception 'No bad link was made'; end if;
end $$;

-- 3. A link replaces only the file or link at the version it names; without one it lands only on a free path. Over a
-- folder or at a stale version it conflicts. A write, a mkdir or a delete without a version over a link conflicts as
-- over a file; a write at the link's version makes it a file again.
do $$
declare r jsonb; u jsonb; e jsonb; p public.qorpera_folder_path_versions; v_file text; v_link text;
	v_back jsonb := pg_temp.stage('lk3 back again');
begin
	perform pg_temp.expect(pg_temp.platform('lk3-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lk3'),
		jsonb_build_object('op','write','path','lk3/f.txt','file',pg_temp.stage('lk3 file')),
		jsonb_build_object('op','mkdir','path','lk3/d'))), 3, 'saved');
	v_file := pg_temp.version('lk3/f.txt');
	perform pg_temp.expect(pg_temp.platform('lk3-free', jsonb_build_array(pg_temp.link('lk3/f.txt', 'x'))), 1, 'conflict', 'exists');
	perform pg_temp.expect(pg_temp.platform('lk3-folder', jsonb_build_array(pg_temp.link('lk3/d', 'x', pg_temp.version('lk3/d')))),
		1, 'conflict', 'version_changed');
	perform pg_temp.expect(pg_temp.platform('lk3-stale', jsonb_build_array(pg_temp.link('lk3/f.txt', 'x',
		extensions.gen_random_uuid()::text))), 1, 'conflict', 'version_changed');
	-- Over the file at its version, then over the link at its version.
	u := pg_temp.expect(pg_temp.platform('lk3-over-file', jsonb_build_array(pg_temp.link('lk3/f.txt', '../elsewhere.txt', v_file))),
		1, 'saved');
	p := pg_temp.pv(u ->> 'version');
	e := pg_temp.entry('lk3/f.txt');
	if p.prior_version::text <> v_file or p.target <> '../elsewhere.txt' or e ->> 'kind' <> 'symlink'
		or e ->> 'target' <> '../elsewhere.txt' or e ? 'manifestSha256' or e ? 'mediaType' then
		raise exception 'A link over a file: % %', to_jsonb(p), e; end if;
	v_link := u ->> 'version';
	u := pg_temp.expect(pg_temp.platform('lk3-over-link', jsonb_build_array(pg_temp.link('lk3/f.txt', 'other.txt', v_link))),
		1, 'saved');
	if (pg_temp.pv(u ->> 'version')).prior_version::text <> v_link or pg_temp.entry('lk3/f.txt') ->> 'target' <> 'other.txt' then
		raise exception 'A link over a link: %', pg_temp.entry('lk3/f.txt'); end if;
	v_link := u ->> 'version';
	-- Over the link: a write or mkdir without a version, a delete without one.
	perform pg_temp.expect(pg_temp.platform('lk3-write-free', jsonb_build_array(jsonb_build_object('op','write','path','lk3/f.txt',
		'file',v_back))), 1, 'conflict', 'exists');
	perform pg_temp.expect(pg_temp.platform('lk3-mkdir', '[{"op":"mkdir","path":"lk3/f.txt"}]'), 1, 'conflict', 'exists');
	perform pg_temp.expect(pg_temp.platform('lk3-delete-free', '[{"op":"delete","path":"lk3/f.txt"}]'), 1, 'conflict', 'version_changed');
	-- A write at the link's version: a file again, with no target.
	u := pg_temp.expect(pg_temp.platform('lk3-write-back', jsonb_build_array(jsonb_build_object('op','write','path','lk3/f.txt',
		'file',v_back,'expectedVersion',v_link))), 1, 'saved');
	p := pg_temp.pv(u ->> 'version');
	e := pg_temp.entry('lk3/f.txt');
	if p.op <> 'write' or p.kind <> 'file' or p.target is not null or p.prior_version::text <> v_link or e ->> 'kind' <> 'file'
		or e ? 'target' or e ->> 'manifestSha256' <> v_back ->> 'manifestSha256'
		or (select target from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
			and key_text = 'lk3/f.txt') is not null then
		raise exception 'A write over a link: % %', to_jsonb(p), e; end if;
end $$;

-- 4. Nothing is below a link: its path is no folder, so nothing is written, made or linked under it, and a new folder
-- that puts an item under one of its links is invalid.
do $$
begin
	if pg_temp.present('lk/t1.lnk/x.txt') then raise exception 'Nothing is under a link'; end if;
	perform pg_temp.expect(pg_temp.platform('lk4-write', jsonb_build_array(jsonb_build_object('op','write','path','lk/t1.lnk/x.txt',
		'file',pg_temp.stage('under a link')))), 1, 'refused', 'parent_missing');
	perform pg_temp.expect(pg_temp.platform('lk4-mkdir', '[{"op":"mkdir","path":"lk/t1.lnk/sub"}]'), 1, 'refused', 'parent_missing');
	perform pg_temp.expect(pg_temp.platform('lk4-link', jsonb_build_array(pg_temp.link('lk/t1.lnk/y.lnk', 'y'))), 1, 'refused',
		'parent_missing');
	perform pg_temp.same(public.qorpera_folder_list('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'lk/t1.lnk',
		null, 10) -> 'entries', '[]', 'A link lists nothing');
	perform pg_temp.expect(pg_temp.platform('lk4-new-folder', jsonb_build_array(jsonb_build_object('op','new_folder','path','lk4',
		'contents', jsonb_build_array(jsonb_build_object('path','l','kind','symlink','target','x'),
			jsonb_build_object('path','l/f.txt','kind','file','file',pg_temp.stage('under a new link')))))), 1, 'refused', 'invalid');
end $$;

-- 5. A link moves, copies and deletes as a file does: its versions carry its target (a delete's does not), and a copy
-- leaves the source as it was.
do $$
declare r jsonb; e jsonb;
begin
	r := pg_temp.platform('lk5-move', jsonb_build_array(jsonb_build_object('op','move','from','lk/t2.lnk','to','lk/t2m.lnk',
		'expectedVersion',pg_temp.version('lk/t2.lnk'))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"move_out","kind":"symlink","path":"lk/t2.lnk","target":"/etc/hosts"},
		{"op":"move_in","kind":"symlink","path":"lk/t2m.lnk","target":"/etc/hosts"}]', 'A moved link''s versions');
	if pg_temp.present('lk/t2.lnk') or pg_temp.entry('lk/t2m.lnk') ->> 'target' <> '/etc/hosts' then
		raise exception 'The moved link: %', pg_temp.entry('lk/t2m.lnk'); end if;
	e := pg_temp.entry('lk/t3.lnk');
	r := pg_temp.platform('lk5-copy', '[{"op":"copy","from":"lk/t3.lnk","to":"lk/t3c.lnk"}]');
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"copy","kind":"symlink","path":"lk/t3c.lnk","target":"/home/x/outside"}]',
		'A copied link''s version');
	perform pg_temp.same(pg_temp.entry('lk/t3.lnk'), e, 'The copied link');
	if pg_temp.entry('lk/t3c.lnk') ->> 'target' <> '/home/x/outside' then raise exception 'The copy: %', pg_temp.entry('lk/t3c.lnk'); end if;
	r := pg_temp.platform('lk5-delete', jsonb_build_array(pg_temp.deletes('lk/t4.lnk')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"delete","kind":"symlink","path":"lk/t4.lnk"}]', 'A deleted link''s version');
	if pg_temp.present('lk/t4.lnk') then raise exception 'The deleted link is gone'; end if;
end $$;

-- 6. A folder holding links: a copy and a move carry each link's target; a move needs the seq it read; a delete
-- removes them.
do $$
declare r jsonb;
begin
	perform pg_temp.expect(pg_temp.platform('lk6-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lk6'),
		pg_temp.link('lk6/a.lnk', 'a-target'), jsonb_build_object('op','mkdir','path','lk6/sub'),
		pg_temp.link('lk6/sub/b.lnk', '../b-target'))), 4, 'saved');
	r := pg_temp.platform('lk6-copy', '[{"op":"copy","from":"lk6","to":"lk6c"}]');
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"copy","kind":"folder","path":"lk6c"},
		{"op":"copy","kind":"symlink","path":"lk6c/a.lnk","target":"a-target"},{"op":"copy","kind":"folder","path":"lk6c/sub"},
		{"op":"copy","kind":"symlink","path":"lk6c/sub/b.lnk","target":"../b-target"}]', 'A copied folder''s links');
	perform pg_temp.expect(pg_temp.platform('lk6-move-unread', jsonb_build_array(jsonb_build_object('op','move','from','lk6',
		'to','lk6m','expectedVersion',pg_temp.version('lk6')))), 1, 'refused', 'as_of_seq_required');
	r := pg_temp.platform('lk6-move', jsonb_build_array(jsonb_build_object('op','move','from','lk6','to','lk6m',
		'expectedVersion',pg_temp.version('lk6'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"move_out","kind":"folder","path":"lk6"},
		{"op":"move_out","kind":"symlink","path":"lk6/a.lnk","target":"a-target"},{"op":"move_out","kind":"folder","path":"lk6/sub"},
		{"op":"move_out","kind":"symlink","path":"lk6/sub/b.lnk","target":"../b-target"},{"op":"move_in","kind":"folder","path":"lk6m"},
		{"op":"move_in","kind":"symlink","path":"lk6m/a.lnk","target":"a-target"},{"op":"move_in","kind":"folder","path":"lk6m/sub"},
		{"op":"move_in","kind":"symlink","path":"lk6m/sub/b.lnk","target":"../b-target"}]', 'A moved folder''s links');
	r := pg_temp.platform('lk6-delete', jsonb_build_array(jsonb_build_object('op','delete','path','lk6m',
		'expectedVersion',pg_temp.version('lk6m'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"delete","kind":"folder","path":"lk6m"},
		{"op":"delete","kind":"symlink","path":"lk6m/a.lnk"},{"op":"delete","kind":"folder","path":"lk6m/sub"},
		{"op":"delete","kind":"symlink","path":"lk6m/sub/b.lnk"}]', 'A deleted folder''s links');
	if pg_temp.present('lk6m/a.lnk') or pg_temp.entry('lk6c/sub/b.lnk') ->> 'target' <> '../b-target' then
		raise exception 'The deleted folder and the copy'; end if;
end $$;

-- 7. A new folder holds links ({path, kind:"symlink", target}), each a write of kind 'symlink'. A link item without a
-- target, with one of the wrong type or length, or with a file, and a file with a target, are invalid.
do $$
declare r jsonb; v_file jsonb := pg_temp.stage('lk7 file'); v_item jsonb; n integer := 0;
begin
	r := pg_temp.platform('lk7-new-folder', jsonb_build_array(jsonb_build_object('op','new_folder','path','lk7','contents', jsonb_build_array(
		jsonb_build_object('path','a.lnk','kind','symlink','target','../a'), jsonb_build_object('path','d','kind','folder'),
		jsonb_build_object('path','d/b.lnk','kind','symlink','target','/b'),
		jsonb_build_object('path','f.txt','kind','file','file',v_file)))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.versions_of(r), '[{"op":"mkdir","kind":"folder","path":"lk7"},
		{"op":"write","kind":"symlink","path":"lk7/a.lnk","target":"../a"},{"op":"mkdir","kind":"folder","path":"lk7/d"},
		{"op":"write","kind":"symlink","path":"lk7/d/b.lnk","target":"/b"},{"op":"write","kind":"file","path":"lk7/f.txt"}]',
		'A new folder''s links');
	if pg_temp.entry('lk7/d/b.lnk') ->> 'target' <> '/b' then raise exception 'The new folder''s link'; end if;
	foreach v_item in array array[
		'{"path":"x","kind":"symlink"}', '{"path":"x","kind":"symlink","target":1}', '{"path":"x","kind":"symlink","target":""}',
		jsonb_build_object('path','x','kind','symlink','target',repeat('t', 4096)),
		jsonb_build_object('path','x','kind','symlink','target','a','file',v_file),
		jsonb_build_object('path','x','kind','file','file',v_file,'target','a')]::jsonb[] loop
		n := n + 1;
		perform pg_temp.expect(pg_temp.platform('lk7-bad-' || n, jsonb_build_array(jsonb_build_object('op','new_folder',
			'path','lk7-bad-' || n,'contents',jsonb_build_array(v_item)))), 1, 'refused', 'invalid');
	end loop;
end $$;

-- 8. A link needs write on its path: a viewer is denied, a contributor makes it.
do $$
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(3), 'lk8-viewer', jsonb_build_array(pg_temp.link('lk8.lnk', 'x'))), 1,
		'denied', 'denied');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'lk8-contributor', jsonb_build_array(pg_temp.link('lk8.lnk', 'x'))), 1,
		'saved');
end $$;

-- 9. Reserved paths take no link, even the platform's.
do $$
declare v_path text; n integer := 0;
begin
	foreach v_path in array array['lk/.git', 'lk/node_modules', 'secrets/x.lnk'] loop
		n := n + 1;
		perform pg_temp.expect(pg_temp.platform('lk9-reserved-' || n, jsonb_build_array(pg_temp.link(v_path, 'x'))), 1, 'refused',
			'reserved');
	end loop;
end $$;

-- 10. A link stands nowhere the company keeps or reads: not as a folder it keeps, on a structured file's path or as a
-- folder it names; a move or copy carries none there, alone or inside a folder; a new folder brings none there.
do $$
declare v_lina constant text := 'QorperaOS/agents/lina is an agent''s folder; a link cannot stand there';
	v_agent constant text := 'QorperaOS/agents/lina/agent.md is the path of a structured file; a link cannot stand there';
begin
	perform pg_temp.expect(pg_temp.platform('lk10-root', '[{"op":"mkdir","path":"QorperaOS"}]'), 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-agents', jsonb_build_array(pg_temp.link('QorperaOS/agents', 'x'))))),
		to_jsonb('QorperaOS/agents is a folder the company keeps; a link cannot stand there'::text), 'A link as QorperaOS/agents/');
	perform pg_temp.expect(pg_temp.platform('lk10-agents-folder', '[{"op":"mkdir","path":"QorperaOS/agents"}]'), 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-sections', jsonb_build_array(
		pg_temp.link('QorperaOS/agents/sections.md', 'x'))))),
		to_jsonb('QorperaOS/agents/sections.md is the path of a structured file; a link cannot stand there'::text),
		'A link as a structured file');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-lina', jsonb_build_array(
		pg_temp.link('QorperaOS/agents/lina', 'x'))))),
		to_jsonb(v_lina), 'A link as an agent''s folder');
	-- Moved or copied there, alone or inside a folder.
	perform pg_temp.expect(pg_temp.platform('lk10-setup', jsonb_build_array(pg_temp.link('lkm.lnk', 'x'),
		jsonb_build_object('op','mkdir','path','lkf'), pg_temp.link('lkf/agent.md', 'x'))), 3, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-move', jsonb_build_array(jsonb_build_object('op','move',
		'from','lkm.lnk','to','QorperaOS/agents/lina','expectedVersion',pg_temp.version('lkm.lnk')))))), to_jsonb(v_lina), 'A link moved there');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-copy', '[{"op":"copy","from":"lkm.lnk","to":"QorperaOS/agents/lina"}]'))),
		to_jsonb(v_lina), 'A link copied there');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-move-folder', jsonb_build_array(jsonb_build_object('op','move',
		'from','lkf','to','QorperaOS/agents/lina','expectedVersion',pg_temp.version('lkf'),'asOfSeq',pg_temp.seq()))))), to_jsonb(v_agent),
		'A folder''s link moved there');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-copy-folder', '[{"op":"copy","from":"lkf","to":"QorperaOS/agents/lina"}]'))),
		to_jsonb(v_agent), 'A folder''s link copied there');
	perform pg_temp.same(to_jsonb(pg_temp.refusal(pg_temp.platform('lk10-new-folder', jsonb_build_array(jsonb_build_object(
		'op','new_folder','path','QorperaOS/agents/lina','contents','[{"path":"agent.md","kind":"symlink","target":"x"}]'::jsonb))))),
		to_jsonb(v_agent), 'A new folder''s link there');
	if pg_temp.present('QorperaOS/agents/lina') or not pg_temp.present('lkm.lnk') or not pg_temp.present('lkf/agent.md') then
		raise exception 'Nothing moved'; end if;
end $$;

-- 11. Where a link may stand (qorpera_folder_link_problems, by key): never in a summary tree, on a structured file's
-- path, as a folder the company keeps or names; anywhere else, also inside an agent's folder and under the old roots,
-- which are ordinary folders since 20260930527000. The message names the place as people see it, QorperaOS/... (the
-- root itself QorperaOS/). The service's alone.
do $$
declare v record; v_problems jsonb;
begin
	for v in select * from (values
		('qorperaos/agents/nora/memory/thread/t0', 'in a summary tree'), ('qorperaos/agents/groups/g/memory', 'in a summary tree'),
		('qorperaos/agents/nora/agent.md', 'the path of a structured file'), ('qorperaos/rules/x.md', 'the path of a structured file'),
		('qorperaos/vision/vision.md', 'the path of a structured file'),
		('qorperaos/agents/sections.md', 'the path of a structured file'), ('qorperaos/interfaces/x', 'an interface''s folder'),
		('qorperaos/agents/groups/g', 'a group chat''s folder'), ('qorperaos/human-tasks/x.lnk', 'a human task''s folder'),
		('qorperaos/agents/lina', 'an agent''s folder'), ('qorperaos/agents/lina/todos/t1', 'the todo''s folder'),
		('qorperaos/skills', 'a folder the company keeps'), ('qorperaos/tables/areas', 'a folder the company keeps'),
		('qorperaos/agents', 'a folder the company keeps'), ('qorperaos', 'a folder the company keeps'),
		('qorperaos/agents/pia/notes.lnk', null), ('qorperaos/agents/nora/memory', null), ('docs/x', null),
		('agents/lina', null), ('agents/sections.md', null), ('rules/x.md', null)) t(key, what) loop
		v_problems := public.qorpera_folder_link_problems(v.key);
		if jsonb_array_length(v_problems) <> (case when v.what is null then 0 else 1 end)
			or v_problems -> 0 ->> 'message' is distinct from (case when v.what is not null
				then format('%s is %s; a link cannot stand there', rtrim('QorperaOS/' || substr(v.key, 11), '/'), v.what) end) then
			raise exception 'Where a link may stand, %: %', v.key, v_problems; end if;
	end loop;
	if has_function_privilege('anon', 'public.qorpera_folder_link_problems(text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_link_problems(text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_link_problems(text)', 'execute') then
		raise exception 'qorpera_folder_link_problems is the service''s alone'; end if;
end $$;

-- 12. A run reads and lists a link with its target and its read authority, and releases it as any entry.
do $$
declare y jsonb := pg_temp.agent_run(); e jsonb; l jsonb; r jsonb;
begin
	perform pg_temp.expect(pg_temp.platform('lk12-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lkv'),
		pg_temp.link('lkv/l.lnk', '../far/away.md'))), 2, 'saved');
	e := pg_temp.read('lkv/l.lnk', y -> 'actor') -> 'entry';
	if e ->> 'kind' <> 'symlink' or e ->> 'target' <> '../far/away.md' or e -> 'authority' ->> 'resourceId' <> (pg_temp.root()).id::text then
		raise exception 'A run reads a link: %', e; end if;
	l := public.qorpera_folder_list('63400000-0000-4000-8000-000000000020', y -> 'actor', 'lkv', null, 10);
	if jsonb_array_length(l -> 'entries') <> 1 or l -> 'entries' -> 0 ->> 'target' <> '../far/away.md'
		or l -> 'entries' -> 0 -> 'authority' is distinct from e -> 'authority' then raise exception 'A run lists a link: %', l; end if;
	r := pg_temp.release(y -> 'actor', extensions.gen_random_uuid(), l -> 'entries', repeat('1', 64));
	if (r ->> 'reads')::integer <> 1 then raise exception 'A run releases a link: %', r; end if;
end $$;

-- 13. A hard link is a write of another path's file: the member holds its bytes as any upload (all present already),
-- the second path names the same manifest, and a later write of the first leaves it as it was.
do $$
declare m jsonb := pg_temp.member(2); v_text constant text := 'lkh shared text'; v_open jsonb; a jsonb; b jsonb; r jsonb;
begin
	perform pg_temp.expect(pg_temp.platform('lkh-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','lkh'),
		jsonb_build_object('op','write','path','lkh/a.txt','file',pg_temp.stage(v_text)))), 2, 'saved');
	a := pg_temp.entry('lkh/a.txt');
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', m, pg_temp.manifest(array[v_text], 'text/plain'));
	if not ((v_open -> 'present') ? pg_temp.hash(v_text) and (v_open -> 'present') ? pg_temp.hash(pg_temp.manifest(array[v_text],
		'text/plain'))) then raise exception 'The bytes are present: %', v_open; end if;
	if public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', m, (v_open ->> 'intentId')::uuid) ->> 'state'
		<> 'sealed' then raise exception 'The member holds the bytes'; end if;
	r := pg_temp.commit(m, 'lkh-link', jsonb_build_array(jsonb_build_object('op','write','path','lkh/b.txt',
		'file', a - array['path','kind','version','seq','updatedAt'])));
	perform pg_temp.expect(r, 1, 'saved');
	b := pg_temp.entry('lkh/b.txt');
	if b ->> 'kind' <> 'file' or b ->> 'manifestSha256' <> a ->> 'manifestSha256' or b ->> 'fileSha256' <> a ->> 'fileSha256' then
		raise exception 'A hard link: % %', a, b; end if;
	perform pg_temp.expect(pg_temp.platform('lkh-rewrite', jsonb_build_array(jsonb_build_object('op','write','path','lkh/a.txt',
		'file',pg_temp.stage('lkh new text'),'expectedVersion',a ->> 'version'))), 1, 'saved');
	perform pg_temp.same(pg_temp.entry('lkh/b.txt'), b, 'The hard link after its first path changed');
end $$;
