-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- The folder core's run client (core C3, packages/runtime/src/cloud-company-folder-client.ts) parses what the four entry
-- points return to a run with closed key sets. This pins those shapes on the real functions: the keys of a read, a
-- listing, a commit and its units, and a release, as test cloud-company-folder-client.test.ts sends them.

create function pg_temp.shape(p jsonb, p_keys text, p_what text) returns void language plpgsql as $$
begin
	if jsonb_typeof(p) is distinct from 'object'
		or array(select k collate "C" from jsonb_object_keys(p) k order by 1)
			is distinct from array(select k collate "C" from unnest(string_to_array(p_keys, ',')) k order by 1) then
		raise exception 'The client reads % as {%}; SQL returned %', p_what, p_keys, p;
	end if;
end $$;

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb; r jsonb; e jsonb; v_seed jsonb; v_release uuid := extensions.gen_random_uuid();
begin
	a := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_seed := public.qorpera_folder_commit(env, '{"kind":"platform"}', 'client-shape-seed', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','notes'),
		jsonb_build_object('op','write','path','notes/a.md','file',pg_temp.stage('hello'))));
	if v_seed -> 'units' -> 1 ->> 'outcome' is distinct from 'saved' then raise exception 'Fixture: %', v_seed; end if;

	-- A read of a file, a folder and nothing.
	r := public.qorpera_folder_read(env, a, 'notes/a.md');
	perform pg_temp.shape(r, 'asOfSeq,entry,found,schema', 'a read');
	e := r -> 'entry';
	perform pg_temp.shape(e, 'authority,bytes,executable,fileSha256,kind,manifestSha256,mediaType,path,seq,updatedAt,version',
		'a file entry');
	perform pg_temp.shape(e -> 'authority', 'grantId,grantRevision,resourceId,resourceRevision', 'a receipt');
	if r ->> 'schema' <> 'qorpera.folder-read/v1' or jsonb_typeof(r -> 'asOfSeq') <> 'number' or (r ->> 'found')::boolean is not true
		or e ->> 'kind' <> 'file' or jsonb_typeof(e -> 'seq') <> 'number' or jsonb_typeof(e -> 'bytes') <> 'number'
		or jsonb_typeof(e -> 'executable') <> 'boolean' or jsonb_typeof(e -> 'updatedAt') <> 'string'
		or jsonb_typeof(e -> 'authority' -> 'resourceRevision') <> 'number'
		or jsonb_typeof(e -> 'authority' -> 'grantRevision') not in ('number','null')
		or (jsonb_typeof(e -> 'authority' -> 'grantId') = 'null') <> (jsonb_typeof(e -> 'authority' -> 'grantRevision') = 'null') then
		raise exception 'A file read''s values: %', r; end if;
	perform pg_temp.shape(public.qorpera_folder_read(env, a, 'notes') -> 'entry', 'authority,kind,path,seq,updatedAt,version',
		'a folder entry');
	r := public.qorpera_folder_read(env, a, 'notes/missing.md');
	perform pg_temp.shape(r, 'asOfSeq,entry,found,schema', 'a read of nothing');
	if (r ->> 'found')::boolean or jsonb_typeof(r -> 'entry') <> 'null' then raise exception 'Nothing read: %', r; end if;

	-- A listing names `next` only on a full page.
	r := public.qorpera_folder_list(env, a, '', null, 1, true);
	perform pg_temp.shape(r, 'asOfSeq,entries,next,schema', 'a listing');
	if r ->> 'schema' <> 'qorpera.folder-list/v1' or jsonb_array_length(r -> 'entries') <> 1 or jsonb_typeof(r -> 'next') <> 'string' then
		raise exception 'A full page: %', r; end if;
	r := public.qorpera_folder_list(env, a, 'notes', null, 200, false);
	if jsonb_array_length(r -> 'entries') <> 1 or jsonb_typeof(r -> 'next') <> 'null' then raise exception 'The last page: %', r; end if;

	-- A commit as the run: a saved unit carries its version, a conflict its reason; a replay returns the same units.
	r := public.qorpera_folder_commit(env, a, 'client-shape-commit', jsonb_build_array(
		jsonb_build_object('op','write','path','notes/b.md','file',pg_temp.stage('b')),
		jsonb_build_object('op','write','path','notes/a.md','file',pg_temp.stage('again')),
		jsonb_build_object('op','copy','from','notes/a.md','to','notes/c.md')));
	perform pg_temp.shape(r, 'commitId,replay,schema,seq,units', 'a commit');
	perform pg_temp.shape(r -> 'units' -> 0, 'op,outcome,path,unit,version', 'a saved write');
	perform pg_temp.shape(r -> 'units' -> 1, 'op,outcome,path,reason,unit', 'a unit that was not saved');
	perform pg_temp.shape(r -> 'units' -> 2, 'op,outcome,path,to,unit,version', 'a saved copy');
	if r ->> 'schema' <> 'qorpera.folder-commit/v1' or jsonb_typeof(r -> 'seq') <> 'number' or (r ->> 'replay')::boolean
		or r -> 'units' -> 1 ->> 'outcome' <> 'conflict' or r -> 'units' -> 1 ->> 'reason' <> 'exists'
		or (r -> 'units' -> 0 ->> 'unit')::integer <> 1 or r -> 'units' -> 2 ->> 'to' <> 'notes/c.md' then
		raise exception 'A run''s commit: %', r; end if;
	e := public.qorpera_folder_commit(env, a, 'client-shape-commit', jsonb_build_array(
		jsonb_build_object('op','write','path','notes/b.md','file',pg_temp.stage('b')),
		jsonb_build_object('op','write','path','notes/a.md','file',pg_temp.stage('again')),
		jsonb_build_object('op','copy','from','notes/a.md','to','notes/c.md')));
	if not (e ->> 'replay')::boolean or e -> 'units' <> r -> 'units' or e -> 'seq' <> r -> 'seq' then
		raise exception 'A replay: %', e; end if;
	-- Nothing saved: no sequence number.
	r := public.qorpera_folder_commit(env, a, 'client-shape-nothing', jsonb_build_array(jsonb_build_object('op','mkdir','path','notes')));
	if jsonb_typeof(r -> 'seq') <> 'null' or r -> 'units' -> 0 ->> 'outcome' <> 'conflict' then raise exception 'Nothing saved: %', r; end if;

	-- A release of what the run read, as the client sends it (with the file's content hash as audit data).
	e := public.qorpera_folder_read(env, a, 'notes/a.md') -> 'entry';
	r := public.qorpera_folder_record_release(env, a, v_release, jsonb_build_array(jsonb_build_object('path', e ->> 'path',
		'version', e ->> 'version', 'authority', e -> 'authority', 'fileSha256', e ->> 'fileSha256')), repeat('1', 64));
	perform pg_temp.shape(r, 'releaseId,reads,replay,schema', 'a release');
	if r ->> 'schema' <> 'qorpera.folder-release/v1' or (r ->> 'releaseId')::uuid <> v_release or (r ->> 'reads')::integer <> 1
		or (r ->> 'replay')::boolean then
		raise exception 'A release: %', r; end if;
	r := public.qorpera_folder_record_release(env, a, v_release, jsonb_build_array(jsonb_build_object('path', e ->> 'path',
		'version', e ->> 'version', 'authority', e -> 'authority', 'fileSha256', e ->> 'fileSha256')), repeat('1', 64));
	perform pg_temp.shape(r, 'releaseId,reads,replay,schema', 'a replayed release');
	if not (r ->> 'replay')::boolean then raise exception 'A replayed release: %', r; end if;
end $$;

-- The recheck's refusal words the client tells apart from a run that ended (42501 either way).
do $$
begin
	if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'public' and p.proname = 'qorpera_folder_release_pairs'
			and p.prosrc like '%''A released read is no longer readable''%') then
		raise exception 'The client matches the release recheck''s refusal by its words';
	end if;
end $$;

rollback;
