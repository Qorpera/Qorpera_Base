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
	a jsonb; r jsonb; e jsonb; v_units jsonb; v_seed jsonb; v_release uuid := extensions.gen_random_uuid();
begin
	a := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_seed := public.qorpera_folder_commit(env, '{"kind":"platform"}', 'client-shape-seed', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','notes'),
		jsonb_build_object('op','write','path','notes/a.md','file',pg_temp.stage('hello')),
		jsonb_build_object('op','mkdir','path','agents'),
		jsonb_build_object('op','mkdir','path','agents/x')));
	if exists (select 1 from jsonb_array_elements(v_seed -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture: %', v_seed; end if;

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
	perform pg_temp.shape(r -> 'entries' -> 0,
		'authority,bytes,executable,fileSha256,kind,manifestSha256,mediaType,path,seq,updatedAt,version', 'a listed file');
	perform pg_temp.shape(r -> 'entries' -> 0 -> 'authority', 'grantId,grantRevision,resourceId,resourceRevision', 'a listed receipt');

	-- A commit as the run: a saved unit carries its version, a conflict its reason; a replay returns the same units. The
	-- run holds its files first, as its own upload would (634's pg_temp.possess).
	v_units := jsonb_build_array(
		jsonb_build_object('op','write','path','notes/b.md','file',pg_temp.stage('b')),
		jsonb_build_object('op','write','path','notes/a.md','file',pg_temp.stage('again')),
		jsonb_build_object('op','copy','from','notes/a.md','to','notes/c.md'));
	perform pg_temp.possess(env, a, v_units);
	r := public.qorpera_folder_commit(env, a, 'client-shape-commit', v_units);
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
	-- A move. An in-house run's move is a deletion, denied without a review, and names its target even so; saved (as
	-- the platform, which the same outcome code answers), it names its source and target; a missing source is a conflict.
	r := public.qorpera_folder_commit(env, a, 'client-shape-move', jsonb_build_array(
		jsonb_build_object('op','move','from','notes/c.md','to','notes/d.md','expectedVersion',
			public.qorpera_folder_read(env, a, 'notes/c.md') -> 'entry' ->> 'version')));
	perform pg_temp.shape(r -> 'units' -> 0, 'op,outcome,path,reason,to,unit', 'a move that was not saved');
	if r -> 'units' -> 0 ->> 'outcome' <> 'denied' or r -> 'units' -> 0 ->> 'reason' <> 'review_required' then
		raise exception 'A run''s move: %', r; end if;
	r := public.qorpera_folder_commit(env, '{"kind":"platform"}', 'client-shape-move-platform', jsonb_build_array(
		jsonb_build_object('op','move','from','notes/c.md','to','notes/d.md','expectedVersion',
			public.qorpera_folder_read(env, a, 'notes/c.md') -> 'entry' ->> 'version'),
		jsonb_build_object('op','move','from','notes/missing.md','to','notes/e.md','expectedVersion',extensions.gen_random_uuid())));
	perform pg_temp.shape(r -> 'units' -> 0, 'op,outcome,path,to,unit,version', 'a saved move');
	perform pg_temp.shape(r -> 'units' -> 1, 'op,outcome,path,reason,to,unit', 'a move with a missing source');
	if r -> 'units' -> 0 ->> 'path' <> 'notes/c.md' or r -> 'units' -> 0 ->> 'to' <> 'notes/d.md'
		or r -> 'units' -> 1 ->> 'outcome' <> 'conflict' or r -> 'units' -> 1 ->> 'reason' <> 'missing' then
		raise exception 'A saved move: %', r; end if;

	-- A structured file refused with problems: the commit strips nulls inside each outcome, so a problem without a
	-- line or key comes back without those keys (the client reads them as null).
	v_units := jsonb_build_array(
		jsonb_build_object('op','write','path','agents/x/agent.md','file',pg_temp.stage('not an agent'),
			'structured', jsonb_build_array(jsonb_build_object('path','agents/x/agent.md','kind','agent','problems',
				jsonb_build_array(jsonb_build_object('line', null, 'key', null, 'code', 'front_matter', 'message', 'no front matter'),
					jsonb_build_object('line', 2, 'key', 'name', 'code', 'value', 'message', 'a name'))))));
	perform pg_temp.possess(env, a, v_units);
	r := public.qorpera_folder_commit(env, a, 'client-shape-refused', v_units);
	perform pg_temp.shape(r -> 'units' -> 0, 'op,outcome,path,problems,reason,unit', 'a refused structured unit');
	perform pg_temp.shape(r -> 'units' -> 0 -> 'problems' -> 0, 'code,message', 'a problem without a line or key');
	perform pg_temp.shape(r -> 'units' -> 0 -> 'problems' -> 1, 'code,key,line,message', 'a problem with a line and key');
	if r -> 'units' -> 0 ->> 'outcome' <> 'refused' or r -> 'units' -> 0 ->> 'reason' <> 'structured_invalid' then
		raise exception 'A refused structured unit: %', r; end if;

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

-- The words and codes the client reads: the recheck's refusals, which it tells apart from a run that ended (42501
-- either way), and the commit's authority change, which PostgREST answers as 409 QRC01 and the client retries.
do $$
declare v_check record;
begin
	for v_check in select * from (values
		('qorpera_folder_release_pairs', '%''A released read is no longer readable'' using errcode = ''42501''%'),
		('qorpera_folder_run_reads_current', '%''A read is no longer readable'' using errcode = ''42501''%'),
		('qorpera_folder_commit', '%''code'', ''QRC01'', ''message'', ''Company folder authority changed''%'),
		('qorpera_folder_commit', '%detail = ''{"status":409,"headers":{}}''%'),
		('qorpera_folder_commit', '%''Company execution is paused'' using errcode = ''55000''%')) c(fn, text)
	loop
		if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname = 'public' and p.proname = v_check.fn and p.prosrc like v_check.text) then
			raise exception 'The client reads % in %', v_check.text, v_check.fn;
		end if;
	end loop;
end $$;

rollback;
