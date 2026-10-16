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

-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them (C1D §9.3).
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms each object the open did not report present (the manifest's
-- chunks and the manifest itself, by hash and size, as the gateway does once it has stored them), and seals it.
create function pg_temp.seal_v2(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload(p_env, p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
end $$;
-- The files pg_temp.stage made, which were version 1 before C5 and so exempt from possession.
create temp table fixture_files(manifest_sha256 text primary key, manifest_text text not null);
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text) returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb; v_manifest text := pg_temp.manifest_v2(p_text);
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = '63000000-0000-4000-8000-000000000010'
		and core = 'folder-v2' order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', v_manifest);
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	insert into pg_temp.fixture_files values (v_seal -> 'file' ->> 'manifestSha256', v_manifest) on conflict do nothing;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files pg_temp.stage made itself, as its own upload would, unless it holds an unexpired sealed intent
-- for it already. A file a test stages any other way is left alone. An actor that may not stage (42501) or a stopped
-- company (55000) is left to the commit's own refusal; any other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct s.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join pg_temp.fixture_files s on s.manifest_sha256 = refs.f ->> 'manifestSha256'
		where not exists (select 1 from public.qorpera_folder_upload_intents i where i.environment_id = p_env
			and i.manifest_sha256 = s.manifest_sha256 and i.state = 'sealed' and i.expires_at > clock_timestamp()
			and i.actor_kind = p_actor ->> 'kind' and i.scope_id = public.qorpera_folder_upload_scope(p_actor)) loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;

create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','63000000-0000-4000-8000-00000000000' || p_n)
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63000000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('63000000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
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

-- The folder's invariants: no claim outlives a transaction; every entry below the root has a live parent
-- folder whose stored path is its own parent's spelling; every version that made a path live is still
-- current, or a later version names it as its prior.
create function pg_temp.folder_invariants(p_environment_id uuid) returns void language plpgsql as $$
declare v_claims bigint; v_orphans bigint; v_spelling bigint; v_lost bigint;
begin
	select count(*) filter (where e.kind = 'claim'),
		count(*) filter (where strpos(e.path, '/') > 0 and not exists (select 1 from public.qorpera_folder_entries p
			where p.environment_id = e.environment_id and p.key_sha256 = e.parent_key_sha256 and p.kind = 'folder')),
		count(*) filter (where strpos(e.path, '/') > 0 and exists (select 1 from public.qorpera_folder_entries p
			where p.environment_id = e.environment_id and p.key_sha256 = e.parent_key_sha256 and p.kind = 'folder'
				and p.path <> public.qorpera_folder_parent_path(e.path)))
	into v_claims, v_orphans, v_spelling
	from public.qorpera_folder_entries e where e.environment_id = p_environment_id;
	select count(*) into v_lost from public.qorpera_folder_path_versions v
	where v.environment_id = p_environment_id and v.op in ('write','mkdir','copy','move_in')
		and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = v.environment_id and e.version = v.version)
		and not exists (select 1 from public.qorpera_folder_path_versions w where w.environment_id = v.environment_id and w.prior_version = v.version);
	if v_claims + v_orphans + v_spelling + v_lost <> 0 then
		raise exception 'Folder invariants: % claims, % orphans, % spelling mismatches, % lost versions', v_claims, v_orphans, v_spelling, v_lost;
	end if;
end $$;

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
		or pg_temp.read('docs/a.txt') -> 'entry' ->> 'mediaType' <> 'text/plain'
		or (pg_temp.read('docs/a.txt') -> 'entry' ->> 'updatedAt')::timestamptz is distinct from
			(select updated_at from public.qorpera_folder_entries where environment_id = '63000000-0000-4000-8000-000000000020' and key_text = 'docs/a.txt') then
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
	-- '.git' only below code/<owner>/<name>/ (20260930446100; 488 covers the depths).
	perform pg_temp.expect(r, 5, 'saved'); perform pg_temp.expect(r, 6, 'refused', 'reserved');
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
			jsonb_build_object('path','notes.md','kind','file','file',a),
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
	if exists (select 1 from jsonb_array_elements(l -> 'entries') e where e ->> 'updatedAt' is null) then
		raise exception 'Every listed entry carries its version''s time: %', l; end if;
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

-- Review round 2: a unit that creates a key an earlier unit of the same change set removed, or lands under a
-- move or copy target, really lands; new-folder contents take their folders' spelling; an exact resource on
-- a folder does not stand in for its descendants; a copy source cannot change under the copy.
do $$
declare r jsonb; a jsonb := pg_temp.stage('alpha'); b jsonb := pg_temp.stage('beta'); v uuid;
begin
	r := pg_temp.commit(pg_temp.member(2), 'r2-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','la'), jsonb_build_object('op','write','path','la/x','file',a),
		jsonb_build_object('op','write','path','lf.txt','file',a), jsonb_build_object('op','mkdir','path','lm'),
		jsonb_build_object('op','mkdir','path','lc')));
	perform pg_temp.expect(r, 5, 'saved');

	-- 1. Replace a file by deleting it and writing it again.
	v := (pg_temp.read('lf.txt') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(2), 'r2-delete-write', jsonb_build_array(
		jsonb_build_object('op','delete','path','lf.txt','expectedVersion',v),
		jsonb_build_object('op','write','path','lf.txt','file',b)));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('lf.txt') -> 'entry' ->> 'version') is distinct from (pg_temp.expect(r, 2, 'saved') ->> 'version')
		or (pg_temp.read('lf.txt') -> 'entry' ->> 'fileSha256') is distinct from b ->> 'fileSha256' then
		raise exception 'Delete then write must leave the new file: %', pg_temp.read('lf.txt'); end if;

	-- 2. Move a folder away, then make a folder at its old name.
	r := pg_temp.commit(pg_temp.member(2), 'r2-move-mkdir', jsonb_build_array(
		jsonb_build_object('op','move','from','lm','to','lm2','expectedVersion',pg_temp.read('lm') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','mkdir','path','lm')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.read('lm') -> 'entry' ->> 'kind' is distinct from 'folder' or pg_temp.read('lm2') -> 'entry' ->> 'kind' is distinct from 'folder' then
		raise exception 'Move then mkdir at the old name must leave both folders'; end if;

	-- 3. Copy a folder, then write a new file under the copy.
	r := pg_temp.commit(pg_temp.member(2), 'r2-copy-write', jsonb_build_array(
		jsonb_build_object('op','copy','from','la','to','lb'), jsonb_build_object('op','write','path','lb/new.txt','file',b)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if (pg_temp.read('lb/new.txt') ->> 'found')::boolean is not true or (pg_temp.read('lb/x') ->> 'found')::boolean is not true then
		raise exception 'Copy then write under the copy must leave both files'; end if;

	-- 4. Copy a folder, then a new folder with contents under the copy.
	r := pg_temp.commit(pg_temp.member(2), 'r2-copy-new-folder', jsonb_build_array(
		jsonb_build_object('op','copy','from','lc','to','ld'),
		jsonb_build_object('op','new_folder','path','ld/nf','contents',jsonb_build_array(jsonb_build_object('path','k.txt','kind','file','file',b)))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.read('ld/nf') -> 'entry' ->> 'kind' is distinct from 'folder' or (pg_temp.read('ld/nf/k.txt') ->> 'found')::boolean is not true then
		raise exception 'Copy then new folder under the copy must leave the folder and its file'; end if;

	-- A rename after an edit in one change set (write agents/x/agent.md, then move agents/x): the subtree
	-- move's asOfSeq does not count this change set's own write as unseen. Kept on purpose (structured files, C2).
	r := pg_temp.commit(pg_temp.member(2), 'r2-rename-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','rnx'),
		jsonb_build_object('op','write','path','rnx/agent.md','file',a)));
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r2-edit-then-rename', jsonb_build_array(
		jsonb_build_object('op','write','path','rnx/agent.md','expectedVersion',pg_temp.read('rnx/agent.md') -> 'entry' ->> 'version','file',b),
		jsonb_build_object('op','move','from','rnx','to','rny','expectedVersion',pg_temp.read('rnx') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.read('rny/agent.md') -> 'entry' ->> 'fileSha256' is distinct from b ->> 'fileSha256' then
		raise exception 'An edit then a rename must carry the edit: %', pg_temp.read('rny/agent.md'); end if;

	-- New-folder contents take their folder's spelling, whatever case a deeper path uses.
	r := pg_temp.commit(pg_temp.member(2), 'r2-new-folder-spelling', jsonb_build_array(jsonb_build_object('op','new_folder','path','nfs',
		'contents',jsonb_build_array(jsonb_build_object('path','sub/f.txt','kind','file','file',a),
			jsonb_build_object('path','Sub','kind','folder'), jsonb_build_object('path','SUB/deep','kind','folder'),
			jsonb_build_object('path','sub/DEEP/g.txt','kind','file','file',a)))));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.read('nfs/sub/f.txt') -> 'entry' ->> 'path' is distinct from 'nfs/Sub/f.txt'
		or pg_temp.read('nfs/sub/deep/g.txt') -> 'entry' ->> 'path' is distinct from 'nfs/Sub/deep/g.txt' then
		raise exception 'New-folder contents must take their folder''s spelling: % %', pg_temp.read('nfs/sub/f.txt'), pg_temp.read('nfs/sub/deep/g.txt'); end if;

	-- A move or copy that would push a stored path past the limit is refused, not raised. Full-width letters
	-- take 3 bytes in the path and 1 in the key, so the path limit binds before the key bound.
	r := pg_temp.commit(pg_temp.member(2), 'r2-long-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','tl'),
		jsonb_build_object('op','write','path','tl/' || repeat(U&'\FF41', 1364),'file',a)));
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r2-long-move', jsonb_build_array(jsonb_build_object('op','move','from','tl','to','tl-longer',
		'expectedVersion',pg_temp.read('tl') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','copy','from','tl','to','tl-copy'), jsonb_build_object('op','copy','from','tl','to','tlc')));
	perform pg_temp.expect(r, 1, 'refused', 'too_long'); perform pg_temp.expect(r, 2, 'refused', 'too_long');
	perform pg_temp.expect(r, 3, 'saved');

	-- An exact resource on a folder covers the folder only. Its descendants fall to the nearest subtree
	-- resource above, here member 2's own: member 4 may not delete, move or copy the folder with them.
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id) values
		('63000000-0000-4000-8000-000000000020','locked','subtree','member_private','63000000-0000-4000-8000-000000000002','normal','63000000-0000-4000-8000-000000000001'),
		('63000000-0000-4000-8000-000000000020','locked/open','exact','company_shared',null,'normal','63000000-0000-4000-8000-000000000001');
	r := pg_temp.commit('{"kind":"platform"}', 'r2-locked-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','locked'),
		jsonb_build_object('op','mkdir','path','locked/open'), jsonb_build_object('op','write','path','locked/open/x.txt','file',a)));
	perform pg_temp.expect(r, 3, 'saved');
	v := (pg_temp.read('locked/open') -> 'entry' ->> 'version')::uuid;
	r := pg_temp.commit(pg_temp.member(4), 'r2-exact-delete', jsonb_build_array(jsonb_build_object('op','delete','path','locked/open',
		'expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(4), 'r2-exact-copy', '[{"op":"copy","from":"locked/open","to":"unlocked"}]');
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(4), 'r2-exact-new-folder', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','locked/open/mine','contents','[]'::jsonb)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(2), 'r2-exact-owner-delete', jsonb_build_array(jsonb_build_object('op','delete','path','locked/open',
		'expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
end $$;

-- Review round 3: keys casefold every letter, not only ASCII, the same way from stored paths and from requests
-- (Æ, Ø and Å included); a narrower resource on such a path covers it; a key past the index bound is refused.
do $$
declare r jsonb; a jsonb := pg_temp.stage('alpha'); v text; long_name text;
begin
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-mkdir', '[{"op":"mkdir","path":"Økonomi"}]');
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-write', jsonb_build_array(jsonb_build_object('op','write','path','ØKONOMI/Budget.txt','file',a)));
	if pg_temp.expect(r, 1, 'saved') ->> 'path' <> 'Økonomi/Budget.txt' then raise exception 'A Danish name must keep its folder''s spelling: %', r; end if;
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-lower', '[{"op":"mkdir","path":"økonomi"}]');
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	if pg_temp.read('økonomi') -> 'entry' ->> 'path' is distinct from 'Økonomi' then
		raise exception 'Reading økonomi must find Økonomi: %', pg_temp.read('økonomi'); end if;
	v := pg_temp.read('økonomi') -> 'entry' ->> 'version';
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-move', jsonb_build_array(jsonb_build_object('op','move','from','ØKONOMI','to','Æble',
		'expectedVersion',v,'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.read('æble/budget.txt') -> 'entry' ->> 'path' is distinct from 'Æble/Budget.txt' or (pg_temp.read('Økonomi') ->> 'found')::boolean then
		raise exception 'A Danish move must carry its subtree: %', pg_temp.read('æble/budget.txt'); end if;
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-dup', jsonb_build_array(jsonb_build_object('op','new_folder','path','dkdup',
		'contents',jsonb_build_array(jsonb_build_object('path','Å','kind','folder'), jsonb_build_object('path','å','kind','folder')))));
	perform pg_temp.expect(r, 1, 'refused', 'invalid');
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-new-folder', jsonb_build_array(jsonb_build_object('op','new_folder','path','dknf',
		'contents',jsonb_build_array(jsonb_build_object('path','Å','kind','folder'), jsonb_build_object('path','å/x.txt','kind','file','file',a)))));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.read('dknf/å/x.txt') -> 'entry' ->> 'path' is distinct from 'dknf/Å/x.txt' then
		raise exception 'New-folder contents must take their Danish folder''s spelling: %', pg_temp.read('dknf/å/x.txt'); end if;

	-- A narrower resource on a path with Ø covers the same path in any case.
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63000000-0000-4000-8000-000000000020','Løn','subtree','member_private','63000000-0000-4000-8000-000000000002','normal','63000000-0000-4000-8000-000000000001');
	r := pg_temp.commit('{"kind":"platform"}', 'r3-dk-private-setup', '[{"op":"mkdir","path":"LØN"}]');
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(4), 'r3-dk-private-other', jsonb_build_array(jsonb_build_object('op','write','path','løn/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(2), 'r3-dk-private-owner', jsonb_build_array(jsonb_build_object('op','write','path','løn/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('LØN/X.TXT', pg_temp.member(4)) ->> 'found')::boolean then
		raise exception 'Another member must not see a private Danish folder'; end if;

	-- A key past the index bound is refused, not raised: a long name that does not compress, and a move that
	-- would push a key past it.
	select string_agg(md5(i::text), '') into long_name from generate_series(1, 90) i;
	r := pg_temp.commit(pg_temp.member(2), 'r3-long-key', jsonb_build_array(jsonb_build_object('op','write','path','kb-' || long_name,'file',a),
		jsonb_build_object('op','mkdir','path','kb')));
	perform pg_temp.expect(r, 1, 'refused', 'too_long'); perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r3-long-key-setup', jsonb_build_array(jsonb_build_object('op','write','path','kb/' || left(long_name, 2550),'file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(2), 'r3-long-key-move', jsonb_build_array(jsonb_build_object('op','move','from','kb','to','kb-' || repeat('x', 100),
		'expectedVersion',pg_temp.read('kb') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'refused', 'too_long');
end $$;

-- Review round 4: a sibling of members/<id>/private is not that private folder; two resources sharing one
-- folder key cover nothing, so nobody but the platform reaches the path.
do $$
declare r jsonb; a jsonb := pg_temp.stage('alpha');
begin
	-- Member 4 has no private folder, so a boundary wrongly taken at members/<m4>/private would deny this.
	r := pg_temp.commit('{"kind":"platform"}', 'r4-private-sibling-setup', '[{"op":"mkdir","path":"members/63000000-0000-4000-8000-000000000004"}]');
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(4), 'r4-private-sibling', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','members/63000000-0000-4000-8000-000000000004/privatenotes','contents',jsonb_build_array(
			jsonb_build_object('path','private','kind','folder'), jsonb_build_object('path','private/n.txt','kind','file','file',a)))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(4), 'r4-private-sibling-delete', jsonb_build_array(jsonb_build_object('op','delete',
		'path','members/63000000-0000-4000-8000-000000000004/privatenotes',
		'expectedVersion',pg_temp.read('members/63000000-0000-4000-8000-000000000004/privatenotes') -> 'entry' ->> 'version','asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');

	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id) values
		('63000000-0000-4000-8000-000000000020','Østen','subtree','member_private','63000000-0000-4000-8000-000000000002','normal','63000000-0000-4000-8000-000000000001'),
		('63000000-0000-4000-8000-000000000020','østen','subtree','company_shared',null,'normal','63000000-0000-4000-8000-000000000001');
	r := pg_temp.commit('{"kind":"platform"}', 'r4-tie-setup', '[{"op":"mkdir","path":"Østen"}]');
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(pg_temp.member(4), 'r4-tie-other', jsonb_build_array(jsonb_build_object('op','write','path','østen/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member(2), 'r4-tie-owner', jsonb_build_array(jsonb_build_object('op','write','path','østen/x.txt','file',a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
end $$;

-- Review round 2: the core flag trusts the marker only from the table's owner, since any session can set it.
do $$
begin
	create role folder_guard_probe bypassrls;
	grant usage on schema public to folder_guard_probe;
	grant select, update on public.qorpera_company_files to folder_guard_probe;
	set local role folder_guard_probe;
	perform set_config('qorpera.folder_enable', 'on', true);
	begin
		update public.qorpera_company_files set core = 'folder-v2' where environment_id = '63000000-0000-4000-8000-000000000021';
		raise exception 'A session that set the marker changed the core flag';
	exception when insufficient_privilege then null;
	end;
	perform set_config('qorpera.folder_enable', '', true);
	reset role;
	if (select core from public.qorpera_company_files where environment_id = '63000000-0000-4000-8000-000000000021') <> 'snapshot-v1' then
		raise exception 'The core flag changed'; end if;
end $$;

-- Operation keys: a replay returns the stored outcomes; a reused key for another change set is refused.
-- An agent acts as a run (C1b), never as a bare staff-agent actor. No claim outlives its transaction.
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
		raise exception 'A bare staff-agent actor was accepted: agents act as a run (C1b)';
	exception when invalid_parameter_value then null;
	end;
	if exists (select 1 from public.qorpera_folder_entries where kind = 'claim') then raise exception 'A claim outlived its transaction'; end if;
	if (select count(*) from public.qorpera_folder_journal where environment_id = '63000000-0000-4000-8000-000000000020') <> pg_temp.seq()
		or exists (select 1 from public.qorpera_folder_commits c where c.seq is not null and not exists
			(select 1 from public.qorpera_folder_journal j where j.commit_id = c.id and j.seq = c.seq)) then
		raise exception 'Every sequence number has exactly one journal row'; end if;
	perform pg_temp.folder_invariants('63000000-0000-4000-8000-000000000020');
end $$;

rollback;
