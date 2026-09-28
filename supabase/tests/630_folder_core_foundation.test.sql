-- Company folder core, C1a (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md): the core flag, the change-set
-- commit's units and outcomes, operation keys, the journal and its clock, and reads that take no lock.
begin;

insert into auth.users(id,email) values
	('63000000-0000-4000-8000-000000000001','folder-owner@example.test'),
	('63000000-0000-4000-8000-000000000002','folder-member@example.test'),
	('63000000-0000-4000-8000-000000000003','folder-viewer@example.test'),
	('63000000-0000-4000-8000-000000000004','folder-other@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('63000000-0000-4000-8000-000000000010','Folder core fixture','63000000-0000-4000-8000-000000000001'),
	('63000000-0000-4000-8000-000000000011','Snapshot fixture','63000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000001','folder-owner@example.test','Owner','owner'),
	('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000002','folder-member@example.test','Member','contributor'),
	('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000003','folder-viewer@example.test','Viewer','viewer'),
	('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000004','folder-other@example.test','Other','contributor'),
	('63000000-0000-4000-8000-000000000011','63000000-0000-4000-8000-000000000001','folder-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('63000000-0000-4000-8000-000000000020','63000000-0000-4000-8000-000000000010','Environment',1,'63000000-0000-4000-8000-000000000001'),
	('63000000-0000-4000-8000-000000000021','63000000-0000-4000-8000-000000000011','Environment',1,'63000000-0000-4000-8000-000000000001');

create function pg_temp.claims(p_role text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true)::text::void
$$;
select pg_temp.claims('service_role');

-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text) returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','63000000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','63000000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('63000000-0000-4000-8000-000000000010',v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/plain','executable',false);
end $$;

create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','63000000-0000-4000-8000-00000000000' || p_n)
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63000000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63000000-0000-4000-8000-000000000020'
$$;
create function pg_temp.read(p_path text, p_actor jsonb default null) returns jsonb language sql as $$
	select public.qorpera_folder_read('63000000-0000-4000-8000-000000000020', coalesce(p_actor, '{"kind":"platform"}'), p_path)
$$;

-- The flag: snapshot-v1 by default, folder-v2 only through enabling an untouched company, then immutable.
do $$
begin
	if (select core from public.qorpera_company_files where environment_id = '63000000-0000-4000-8000-000000000020') <> 'snapshot-v1' then
		raise exception 'A new company must default to snapshot-v1'; end if;
	if (public.qorpera_folder_enable('63000000-0000-4000-8000-000000000020') ->> 'changed')::boolean is not true then
		raise exception 'Enabling an untouched company must change it'; end if;
	if (public.qorpera_folder_enable('63000000-0000-4000-8000-000000000020') ->> 'changed')::boolean is not false then
		raise exception 'Enabling twice must be a no-op'; end if;
	if (select state from public.qorpera_company_files where environment_id = '63000000-0000-4000-8000-000000000020') <> 'ready' then
		raise exception 'A folder-v2 company is ready without a head'; end if;
	begin
		update public.qorpera_company_files set core = 'snapshot-v1' where environment_id = '63000000-0000-4000-8000-000000000020';
		raise exception 'The core flag changed';
	exception when insufficient_privilege then null;
	end;
	begin
		update public.qorpera_company_files set core = 'folder-v2' where environment_id = '63000000-0000-4000-8000-000000000021';
		raise exception 'The core flag changed without enabling';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_folder_commit('63000000-0000-4000-8000-000000000021', '{"kind":"platform"}', 'snap-commit-1',
			'[{"op":"mkdir","path":"docs"}]');
		raise exception 'A snapshot-v1 company accepted a folder commit';
	exception when insufficient_privilege then null;
	end;
	if not exists (select 1 from public.qorpera_folder_fences where profile_id = '63000000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_folder_admissions where profile_id = '63000000-0000-4000-8000-000000000010')
		or pg_temp.seq() <> 0 then
		raise exception 'Enabling must create the fence, admission and clock rows'; end if;
end $$;

-- Writes, conflicts, missing parents, one sequence number per change set.
do $$
declare r jsonb; v1 uuid; v2 uuid; a jsonb := pg_temp.stage('alpha'); b jsonb := pg_temp.stage('beta');
begin
	r := pg_temp.commit(pg_temp.member(2), 'unit-mkdir-docs', '[{"op":"mkdir","path":"docs"}]');
	perform pg_temp.expect(r, 1, 'saved');
	if (r ->> 'seq')::bigint <> 1 or pg_temp.seq() <> 1 then raise exception 'First commit must be seq 1: %', r; end if;
	if not exists (select 1 from public.qorpera_folder_journal where environment_id = '63000000-0000-4000-8000-000000000020'
		and seq = 1 and kind = 'change_set' and commit_id = (r ->> 'commitId')::uuid) then raise exception 'Journal row missing'; end if;

	r := pg_temp.commit(pg_temp.member(2), 'unit-write-a-1', jsonb_build_array(jsonb_build_object('op','write','path','docs/a.txt','file',a)));
	v1 := (pg_temp.expect(r, 1, 'saved') ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-write-a-2', jsonb_build_array(jsonb_build_object('op','write','path','docs/a.txt','file',b)));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	if r ->> 'seq' is not null then raise exception 'A change set with nothing saved takes no sequence number'; end if;
	r := pg_temp.commit(pg_temp.member(2), 'unit-write-a-3', jsonb_build_array(jsonb_build_object('op','write','path','docs/a.txt',
		'expectedVersion',v1,'file',b)));
	v2 := (pg_temp.expect(r, 1, 'saved') ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-write-a-4', jsonb_build_array(jsonb_build_object('op','write','path','docs/a.txt',
		'expectedVersion',v1,'file',a)));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (select count(*) from public.qorpera_folder_path_versions where environment_id = '63000000-0000-4000-8000-000000000020'
		and path = 'docs/a.txt') <> 2
		or (select prior_version from public.qorpera_folder_path_versions where version = v2) is distinct from v1 then
		raise exception 'Path versions must keep each write with its prior version'; end if;
	if (pg_temp.read('docs/a.txt') -> 'entry' ->> 'version')::uuid is distinct from v2
		or pg_temp.read('docs/a.txt') -> 'entry' ->> 'mediaType' <> 'text/plain' then
		raise exception 'Read must show the current version: %', pg_temp.read('docs/a.txt'); end if;

	r := pg_temp.commit(pg_temp.member(2), 'unit-parent-missing', jsonb_build_array(jsonb_build_object('op','write','path','nope/b.txt','file',a)));
	perform pg_temp.expect(r, 1, 'refused', 'parent_missing');
	r := pg_temp.commit(pg_temp.member(2), 'unit-same-set-parent', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','x'), jsonb_build_object('op','write','path','x/y.txt','file',a),
		jsonb_build_object('op','write','path','none/q.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'refused', 'parent_missing');
	if (r ->> 'seq')::bigint <> pg_temp.seq() then raise exception 'One change set is one sequence number'; end if;

	r := pg_temp.commit(pg_temp.member(2), 'unit-unverified', ('[{"op":"write","path":"docs/c.txt","file":{"manifestSha256":"'
		|| repeat('a',64) || '","fileSha256":"' || repeat('b',64) || '","bytes":1,"mediaType":"text/plain","executable":false}}]')::jsonb);
	perform pg_temp.expect(r, 1, 'refused', 'bytes_unverified');
end $$;

-- Authority, reserved names and code/.
do $$
declare r jsonb; a jsonb := pg_temp.stage('alpha');
begin
	r := pg_temp.commit(pg_temp.member(3), 'unit-viewer-write', jsonb_build_array(jsonb_build_object('op','write','path','docs/v.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	if (pg_temp.read('docs/a.txt', pg_temp.member(3)) ->> 'found')::boolean is not true then
		raise exception 'A viewer reads shared files'; end if;
	r := pg_temp.commit('{"kind":"platform"}', 'unit-reserved', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','.qorpera'), jsonb_build_object('op','mkdir','path','docs/node_modules'),
		jsonb_build_object('op','mkdir','path','code'), jsonb_build_object('op','mkdir','path','code/repo'),
		jsonb_build_object('op','mkdir','path','code/repo/node_modules'), jsonb_build_object('op','mkdir','path','code/repo/.git')));
	perform pg_temp.expect(r, 1, 'refused', 'reserved'); perform pg_temp.expect(r, 2, 'refused', 'reserved');
	perform pg_temp.expect(r, 3, 'saved'); perform pg_temp.expect(r, 4, 'saved');
	perform pg_temp.expect(r, 5, 'saved'); perform pg_temp.expect(r, 6, 'saved');
	-- A member's private folder is theirs alone: another member neither writes nor sees it.
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63000000-0000-4000-8000-000000000020','members/63000000-0000-4000-8000-000000000002/private','subtree','member_private',
		'63000000-0000-4000-8000-000000000002','normal','63000000-0000-4000-8000-000000000001');
	r := pg_temp.commit('{"kind":"platform"}', 'unit-private-dirs', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','members'),
		jsonb_build_object('op','mkdir','path','members/63000000-0000-4000-8000-000000000002'),
		jsonb_build_object('op','mkdir','path','members/63000000-0000-4000-8000-000000000002/private')));
	perform pg_temp.expect(r, 3, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'unit-private-own', jsonb_build_array(jsonb_build_object('op','write',
		'path','members/63000000-0000-4000-8000-000000000002/private/note.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(4), 'unit-private-other', jsonb_build_array(jsonb_build_object('op','write',
		'path','members/63000000-0000-4000-8000-000000000002/private/other.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	if (pg_temp.read('members/63000000-0000-4000-8000-000000000002/private/note.txt', pg_temp.member(4)) ->> 'found')::boolean then
		raise exception 'An unreadable path must answer like a missing one'; end if;
	if exists (select 1 from jsonb_array_elements(public.qorpera_folder_list('63000000-0000-4000-8000-000000000020', pg_temp.member(4),
		'members/63000000-0000-4000-8000-000000000002/private', null, 100, false) -> 'entries')) then
		raise exception 'A listing must hide unreadable names'; end if;
end $$;

-- Moves, case-only renames, subtree deletes with asOfSeq, copies and new folders.
do $$
declare r jsonb; v uuid; l jsonb; a jsonb := pg_temp.stage('alpha'); s bigint;
begin
	v := (pg_temp.read('docs/a.txt') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-move-file', jsonb_build_array(jsonb_build_object('op','move','from','docs/a.txt',
		'to','docs/b.txt','expectedVersion',v)));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('docs/a.txt') ->> 'found')::boolean or (pg_temp.read('docs/b.txt') ->> 'found')::boolean is not true then
		raise exception 'A move must leave only the new path'; end if;
	v := (pg_temp.read('docs/b.txt') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-case-rename', jsonb_build_array(jsonb_build_object('op','move','from','docs/b.txt',
		'to','docs/B.txt','expectedVersion',v)));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.read('docs/b.txt') -> 'entry' ->> 'path' <> 'docs/B.txt' then raise exception 'A case-only rename keeps the key, new spelling'; end if;

	v := (pg_temp.read('x') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-move-into-self', jsonb_build_array(jsonb_build_object('op','move','from','x',
		'to','x/inner','expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'refused', 'into_itself');
	r := pg_temp.commit(pg_temp.member(2), 'unit-move-folder', jsonb_build_array(jsonb_build_object('op','move','from','x',
		'to','x2','expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('x2/y.txt') ->> 'found')::boolean is not true or (pg_temp.read('x/y.txt') ->> 'found')::boolean then
		raise exception 'A folder move must carry its subtree'; end if;

	s := pg_temp.seq();
	r := pg_temp.commit(pg_temp.member(2), 'unit-touch-inside', jsonb_build_array(jsonb_build_object('op','write','path','x2/new.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	v := (pg_temp.read('x2') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'unit-delete-no-seq', jsonb_build_array(jsonb_build_object('op','delete','path','x2','expectedVersion',v)));
	perform pg_temp.expect(r, 1, 'refused', 'as_of_seq_required');
	r := pg_temp.commit(pg_temp.member(2), 'unit-delete-unseen', jsonb_build_array(jsonb_build_object('op','delete','path','x2',
		'expectedVersion',v,'asOfSeq',s)));
	perform pg_temp.expect(r, 1, 'conflict', 'unseen_change');
	r := pg_temp.commit(pg_temp.member(2), 'unit-delete-folder', jsonb_build_array(jsonb_build_object('op','delete','path','x2',
		'expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '63000000-0000-4000-8000-000000000020'
		and (key_text = 'x2' or key_text like 'x2/%')) then raise exception 'A folder delete must remove its subtree'; end if;
	if (select count(*) from public.qorpera_folder_path_versions where commit_id = (r ->> 'commitId')::uuid and op = 'delete') <> 3 then
		raise exception 'Each deleted path keeps a delete version'; end if;

	r := pg_temp.commit(pg_temp.member(2), 'unit-copy-folder', '[{"op":"copy","from":"docs","to":"docs-copy"}]');
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('docs-copy/B.txt') ->> 'found')::boolean is not true then raise exception 'A folder copy carries its subtree'; end if;

	r := pg_temp.commit(pg_temp.member(2), 'unit-new-folder', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents'),
		jsonb_build_object('op','new_folder','path','agents/mark','contents',jsonb_build_array(
			jsonb_build_object('path','memory/profile.md','kind','file','file',a),
			jsonb_build_object('path','agent.md','kind','file','file',a),
			jsonb_build_object('path','memory','kind','folder')))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if (pg_temp.read('agents/mark/memory/profile.md') ->> 'found')::boolean is not true then
		raise exception 'A new folder lands with its contents'; end if;
	r := pg_temp.commit(pg_temp.member(2), 'unit-new-folder-bad', jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/ann',
		'contents',jsonb_build_array(jsonb_build_object('path','notes/a.md','kind','file','file',a)))));
	perform pg_temp.expect(r, 1, 'refused', 'invalid');

	-- Listing: one level, keyset paging, a whole subtree, and asOfSeq from the same statement.
	l := public.qorpera_folder_list('63000000-0000-4000-8000-000000000020', pg_temp.member(2), '', null, 2, false);
	if jsonb_array_length(l -> 'entries') <> 2 or l ->> 'next' is null or (l ->> 'asOfSeq')::bigint <> pg_temp.seq() then
		raise exception 'First page: %', l; end if;
	l := public.qorpera_folder_list('63000000-0000-4000-8000-000000000020', pg_temp.member(2), '', l ->> 'next', 100, false);
	if exists (select 1 from jsonb_array_elements(l -> 'entries') e where e ->> 'path' like '%/%') then
		raise exception 'A one-level listing shows only children: %', l; end if;
	l := public.qorpera_folder_list('63000000-0000-4000-8000-000000000020', pg_temp.member(2), 'agents', null, 100, true);
	if jsonb_array_length(l -> 'entries') <> 4 then raise exception 'A subtree listing shows every descendant: %', l; end if;
end $$;

-- Review round 1: authority over every path a subtree unit touches, reserved names below the root, the stored
-- spelling (never the request's) when moving, a new name taking its parent's spelling, failures as outcomes,
-- and a move followed by a write under its target in one change set.
do $$
declare r jsonb; a jsonb := pg_temp.stage('alpha'); v text;
begin
	-- Another member neither copies, moves nor deletes a folder holding member 2's private folder.
	r := pg_temp.commit(pg_temp.member(4), 'r1-copy-private', '[{"op":"copy","from":"members/63000000-0000-4000-8000-000000000002","to":"stolen"}]');
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	v := pg_temp.read('members') -> 'entry' ->> 'version';
	r := pg_temp.commit(pg_temp.member(4), 'r1-move-private', jsonb_build_array(jsonb_build_object('op','move','from','members',
		'to','members-open','expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(4), 'r1-delete-private', jsonb_build_array(jsonb_build_object('op','delete','path','members',
		'expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	if (pg_temp.read('members/63000000-0000-4000-8000-000000000002/private/note.txt') ->> 'found')::boolean is not true then
		raise exception 'A denied subtree unit must change nothing'; end if;
	-- Member 2 may share their own private file.
	r := pg_temp.commit(pg_temp.member(2), 'r1-copy-own', '[{"op":"copy","from":"members/63000000-0000-4000-8000-000000000002/private/note.txt","to":"shared-note.txt"}]');
	perform pg_temp.expect(r, 1, 'saved');

	-- Reserved names below the root: git's files leave code/ neither by copy nor inside a new folder.
	r := pg_temp.commit('{"kind":"platform"}', 'r1-copy-git', '[{"op":"copy","from":"code/repo","to":"repo-copy"}]');
	perform pg_temp.expect(r, 1, 'refused', 'reserved');
	r := pg_temp.commit('{"kind":"platform"}', 'r1-new-folder-cache', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','cachey','contents',jsonb_build_array(jsonb_build_object('path','node_modules','kind','folder')))));
	perform pg_temp.expect(r, 1, 'refused', 'reserved');

	-- A request may spell a path in another normalization; the move rebuilds from the stored spelling.
	r := pg_temp.commit(pg_temp.member(2), 'r1-files', jsonb_build_array(jsonb_build_object('op','mkdir','path','files'),
		jsonb_build_object('op','write','path','files/a.txt','file',a)));
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r1-ligature-move', jsonb_build_array(jsonb_build_object('op','move','from',
		U&'\FB01les','to','docs2','expectedVersion',pg_temp.read('files') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('docs2/a.txt') ->> 'found')::boolean is not true or exists (select 1 from public.qorpera_folder_entries
		where environment_id = '63000000-0000-4000-8000-000000000020' and key_text like 'docss%') then
		raise exception 'A move must rebuild paths from the stored spelling'; end if;

	-- A new name takes its existing parent's spelling.
	r := pg_temp.commit(pg_temp.member(2), 'r1-parent-spelling', jsonb_build_array(jsonb_build_object('op','write','path','DOCS/spelled.txt','file',a)));
	if pg_temp.expect(r, 1, 'saved') ->> 'path' <> 'docs/spelled.txt' or pg_temp.read('docs/spelled.txt') -> 'entry' ->> 'path' <> 'docs/spelled.txt' then
		raise exception 'A new name must take its parent''s spelling: %', r; end if;

	-- Malformed contents are outcomes, not exceptions.
	r := pg_temp.commit(pg_temp.member(2), 'r1-dup-contents', jsonb_build_array(jsonb_build_object('op','new_folder','path','dups',
		'contents',jsonb_build_array(jsonb_build_object('path','a','kind','folder'),jsonb_build_object('path','A','kind','folder')))));
	perform pg_temp.expect(r, 1, 'refused', 'invalid');
	r := pg_temp.commit(pg_temp.member(2), 'r1-bad-media', jsonb_build_array(jsonb_build_object('op','new_folder','path','media',
		'contents',jsonb_build_array(jsonb_build_object('path','x.txt','kind','file','file',a || '{"mediaType":"Not A Type"}'::jsonb)))));
	perform pg_temp.expect(r, 1, 'refused', 'invalid');

	-- A move, then a write under its target, in one change set: the write finds the moved file.
	r := pg_temp.commit(pg_temp.member(2), 'r1-mv-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','mv-a'),
		jsonb_build_object('op','write','path','mv-a/x.txt','file',a)));
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r1-mv-then-write', jsonb_build_array(jsonb_build_object('op','move','from','mv-a','to','mv-b',
		'expectedVersion',pg_temp.read('mv-a') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','write','path','mv-b/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'conflict', 'exists');

	begin
		perform public.qorpera_folder_read('63000000-0000-4000-8000-000000000021', '{"kind":"platform"}', 'docs');
		raise exception 'A read of a snapshot-v1 company must be refused';
	exception when insufficient_privilege then null;
	end;
end $$;

-- Operation keys: a replay returns the stored outcomes; a reused key for another change set is refused.
-- Agent actors arrive with C1b/C1c. No claim outlives its transaction.
do $$
declare r1 jsonb; r2 jsonb;
begin
	r1 := pg_temp.commit(pg_temp.member(2), 'unit-replay-1', '[{"op":"mkdir","path":"replayed"}]');
	r2 := pg_temp.commit(pg_temp.member(2), 'unit-replay-1', '[{"op":"mkdir","path":"replayed"}]');
	if (r2 ->> 'replay')::boolean is not true or r2 -> 'units' <> r1 -> 'units' or r2 ->> 'commitId' <> r1 ->> 'commitId' then
		raise exception 'A replay must return the stored outcomes: % %', r1, r2; end if;
	begin
		perform pg_temp.commit(pg_temp.member(2), 'unit-replay-1', '[{"op":"mkdir","path":"other"}]');
		raise exception 'A reused operation key was accepted';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform pg_temp.commit('{"kind":"staff_agent","staffAgentId":"63000000-0000-4000-8000-000000000099"}', 'unit-agent-1',
			'[{"op":"mkdir","path":"agent-made"}]');
		raise exception 'An agent actor was accepted before C1b';
	exception when feature_not_supported then null;
	end;
	if exists (select 1 from public.qorpera_folder_entries where kind = 'claim') then raise exception 'A claim outlived its transaction'; end if;
	if (select count(*) from public.qorpera_folder_journal where environment_id = '63000000-0000-4000-8000-000000000020') <> pg_temp.seq()
		or exists (select 1 from public.qorpera_folder_commits c where c.seq is not null and not exists
			(select 1 from public.qorpera_folder_journal j where j.commit_id = c.id and j.seq = c.seq)) then
		raise exception 'Every sequence number has exactly one journal row'; end if;
end $$;

rollback;
