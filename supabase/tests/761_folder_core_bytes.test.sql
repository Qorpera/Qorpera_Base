-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, C1d-1a: the byte path (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md). Staging under upload
-- intents, the version-2 proof, commit step 6, the download check, usage and the soft quota, and the snapshot-v1 paths
-- this branches. Races are in 762.

-- A version-2 manifest of the given chunks, as canonical JSON (C1D §2).
create function pg_temp.manifest(p_chunks text[], p_media text default 'text/markdown', p_exec boolean default false)
returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"%s","executable":%s,"chunks":[%s]}',
		encode(extensions.digest(convert_to(array_to_string(p_chunks, ''), 'utf8'), 'sha256'), 'hex'),
		octet_length(convert_to(array_to_string(p_chunks, ''), 'utf8')), p_media, case when p_exec then 'true' else 'false' end,
		coalesce((select string_agg(format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(c, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(c, 'utf8'))), ',' order by o) from unnest(p_chunks) with ordinality u(c, o)), ''))
$$;
create function pg_temp.hash(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
create function pg_temp.open(p_actor jsonb, p_manifest text) returns jsonb language sql as $$
	select public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', p_actor, p_manifest)
$$;
create function pg_temp.confirm(p_actor jsonb, p_intent uuid, p_text text) returns jsonb language sql as $$
	select public.qorpera_folder_confirm_object('63400000-0000-4000-8000-000000000020', p_actor, p_intent, pg_temp.hash(p_text),
		octet_length(convert_to(p_text, 'utf8')))
$$;
create function pg_temp.seal(p_actor jsonb, p_intent uuid) returns jsonb language sql as $$
	select public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', p_actor, p_intent)
$$;
-- Stages a file of the given chunks as the actor, as the gateway and the runtime do: open, put what is missing (the
-- chunks and the manifest), seal. Returns the file reference.
create function pg_temp.stage_v2(p_actor jsonb, p_chunks text[], p_media text default 'text/markdown', p_exec boolean default false)
returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest(p_chunks, p_media, p_exec); v_open jsonb; v_chunk text; v_seal jsonb;
begin
	v_open := pg_temp.open(p_actor, v_manifest);
	foreach v_chunk in array p_chunks || v_manifest loop
		if not (v_open -> 'present') ? pg_temp.hash(v_chunk) then
			perform pg_temp.confirm(p_actor, (v_open ->> 'intentId')::uuid, v_chunk); end if;
	end loop;
	v_seal := pg_temp.seal(p_actor, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' then raise exception 'Fixture: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
create function pg_temp.download(p_actor jsonb, p_sha text, p_env uuid default '63400000-0000-4000-8000-000000000020') returns jsonb
language sql as $$
	select public.qorpera_folder_authorize_object_download(p_env, p_actor, p_sha)
$$;
create function pg_temp.usage() returns public.qorpera_folder_storage_usage language sql as $$
	select * from public.qorpera_folder_storage_usage where profile_id = '63400000-0000-4000-8000-000000000010'
$$;

-- 1. The version-2 manifest --------------------------------------------------------------------------------------------
do $$
declare v_ok text := pg_temp.manifest(array['a','bb']);
begin
	if public.qorpera_folder_manifest(v_ok) is null or public.qorpera_folder_manifest(pg_temp.manifest(array[]::text[])) is null
		or public.qorpera_folder_manifest(pg_temp.manifest(array['x'], 'application/x-sh', true)) is null
		-- A chunk repeated at its one size: a file of two identical blocks.
		or public.qorpera_folder_manifest(pg_temp.manifest(array['ab', 'ab'])) is null then
		raise exception 'Valid manifests: %', v_ok; end if;
	if exists (select 1 from unnest(array[
		replace(v_ok, 'manifest/v2', 'manifest/v1'),
		replace(v_ok, '"executable":false', '"executable":"no"'),
		replace(v_ok, '"mediaType":"text/markdown"', '"mediaType":"Text/Markdown"'),
		replace(v_ok, '"bytes":3,', '"bytes":4,'),
		replace(v_ok, '"chunks":[', '"extra":1,"chunks":['),
		replace(v_ok, '{"sha256":"', '{"extra":1,"sha256":"'),
		'{not json',
		format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":10,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":4},{"sha256":"%s","bytes":6}]}',
			repeat('a', 64), repeat('b', 64), repeat('b', 64)),
		format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":4194305,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":4194305}]}',
			repeat('a', 64), repeat('b', 64)),
		format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":65,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
			repeat('a', 64), (select string_agg(format('{"sha256":"%s","bytes":1}', lpad(to_hex(i), 64, '0')), ',') from generate_series(1, 65) i))
		]) t where public.qorpera_folder_manifest(t) is not null) then
		raise exception 'Every broken manifest is refused'; end if;
end $$;

-- 2. Staging -----------------------------------------------------------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_manifest text := pg_temp.manifest(array['one ', 'two']); v_open jsonb; v_intent uuid; v_seal jsonb; v_usage public.qorpera_folder_storage_usage;
	v_row public.qorpera_folder_upload_intents;
begin
	-- A chunk already stored is reported present, and not put again.
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.hash('one '), 4, 'nas-object-gateway');
	-- (The trigger counted it: 4 bytes, one object.)
	v_usage := pg_temp.usage();
	if v_usage.bytes <> 4 or v_usage.objects <> 1 then raise exception 'The first object starts the usage row: %', to_jsonb(v_usage); end if;
	v_open := pg_temp.open(a, v_manifest);
	v_intent := (v_open ->> 'intentId')::uuid;
	select * into v_row from public.qorpera_folder_upload_intents where id = v_intent;
	if v_open -> 'present' <> jsonb_build_array(pg_temp.hash('one ')) or v_open ->> 'manifestSha256' <> pg_temp.hash(v_manifest)
		or v_row.actor_kind <> 'run' or v_row.scope_id <> (a ->> 'runId')::uuid or v_row.state <> 'open'
		or v_row.expires_at not between clock_timestamp() + interval '14 minutes' and clock_timestamp() + interval '16 minutes'
		or v_row.media_type <> 'text/markdown' or v_row.executable or v_row.bytes <> 7
		or (select count(*) from public.qorpera_folder_upload_intent_objects where intent_id = v_intent) <> 3 then
		raise exception 'An open intent: % %', v_open, to_jsonb(v_row); end if;

	-- Each chunk's put: listed, this actor's, open and unexpired.
	if public.qorpera_folder_authorize_object_upload(c_env, a, v_intent, pg_temp.hash('two'), 3) ->> 'profileId'
		<> '63400000-0000-4000-8000-000000000010' then raise exception 'A listed chunk may be put'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 3)', c_env, a, v_intent,
		pg_temp.hash('other')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, a, v_intent,
		pg_temp.hash('two')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 3)', c_env, b, v_intent,
		pg_temp.hash('two')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 3)', c_env,
		pg_temp.member(1), v_intent, pg_temp.hash('two')), '42501');

	-- Sealing before every object is there says what is missing, and changes nothing.
	v_seal := pg_temp.seal(a, v_intent);
	if v_seal ->> 'state' <> 'incomplete' or v_seal -> 'missing' <> (select jsonb_agg(h order by h)
		from unnest(array[pg_temp.hash('two'), pg_temp.hash(v_manifest)]) h)
		or exists (select 1 from public.qorpera_verified_company_file_objects where manifest_sha256 = pg_temp.hash(v_manifest)) then
		raise exception 'An incomplete seal: %', v_seal; end if;

	-- The catalog row, once; usage counts it once.
	if (pg_temp.confirm(a, v_intent, 'two') ->> 'stored')::boolean is not true
		or (pg_temp.confirm(a, v_intent, 'two') ->> 'stored')::boolean then raise exception 'A confirm stores once'; end if;
	if (pg_temp.usage()).bytes <> v_usage.bytes + 3 or (pg_temp.usage()).objects <> v_usage.objects + 1 then
		raise exception 'Usage counts each stored object once: %, %', to_jsonb(v_usage), to_jsonb(pg_temp.usage()); end if;
	perform pg_temp.confirm(a, v_intent, v_manifest);
	v_seal := pg_temp.seal(a, v_intent);
	if v_seal ->> 'state' <> 'sealed' or v_seal -> 'file' <> jsonb_build_object('manifestSha256', pg_temp.hash(v_manifest),
			'fileSha256', pg_temp.hash('one two'), 'bytes', 7, 'mediaType', 'text/markdown', 'executable', false)
		or not exists (select 1 from public.qorpera_verified_company_file_objects where manifest_sha256 = pg_temp.hash(v_manifest)
			and verifier_version = 2 and media_type = 'text/markdown' and executable = false and jsonb_array_length(objects) = 3)
		or (select array_agg(chunk_sha256 order by chunk_sha256) from public.qorpera_folder_file_chunks
			where manifest_sha256 = pg_temp.hash(v_manifest)) <> (select array_agg(h order by h) from unnest(array[pg_temp.hash('one '),
			pg_temp.hash('two')]) h)
		or (select state from public.qorpera_folder_upload_intents where id = v_intent) <> 'sealed'
		or (select expires_at from public.qorpera_folder_upload_intents where id = v_intent)
			not between clock_timestamp() + interval '59 minutes' and clock_timestamp() + interval '61 minutes' then
		raise exception 'A sealed file: %', v_seal; end if;
	-- Sealing again returns the same file; a sealed intent takes no more puts; another actor cannot seal or renew it.
	if pg_temp.seal(a, v_intent) -> 'file' <> v_seal -> 'file' then raise exception 'Sealing is idempotent'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 3)', c_env, a, v_intent,
		pg_temp.hash('two')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_seal_upload(%L, %L, %L)', c_env, b, v_intent), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_renew_upload(%L, %L, %L)', c_env, b, v_intent), '42501');
	if (public.qorpera_folder_renew_upload(c_env, a, v_intent) ->> 'state') <> 'sealed' then raise exception 'Renew a sealed intent'; end if;

	-- An expired intent takes nothing.
	v_open := pg_temp.open(a, pg_temp.manifest(array['late']));
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '1 second'
	where id = (v_open ->> 'intentId')::uuid;
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, a,
		v_open ->> 'intentId', pg_temp.hash('late')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_seal_upload(%L, %L, %L)', c_env, a, v_open ->> 'intentId'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_renew_upload(%L, %L, %L)', c_env, a, v_open ->> 'intentId'), '42501');

	-- A hash already stored with another size.
	v_open := pg_temp.open(a, format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":5,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":5}]}',
		pg_temp.hash('one '), pg_temp.hash('one ')));
	perform pg_temp.raises(format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, 5)', c_env, a, v_open ->> 'intentId',
		pg_temp.hash('one ')), '23505');

	-- Refused at open: a bad manifest, a member who left, another kind of actor, a snapshot-v1 company.
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', a, '{"schema":"x"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', '{"kind":"member","userId":"63400000-0000-4000-8000-000000000099"}',
		pg_temp.manifest(array['m'])), '42501');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', '{"kind":"robot"}', pg_temp.manifest(array['m'])), '22023');
	if (pg_temp.open(pg_temp.member(2), pg_temp.manifest(array['m'])) ->> 'intentId') is null
		or (pg_temp.open('{"kind":"platform"}', pg_temp.manifest(array['m'])) ->> 'intentId') is null then
		raise exception 'A member and the platform stage'; end if;
end $$;

-- 3. The stop: every upload call refuses once the company is paused or being deleted.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_open jsonb := pg_temp.open(pg_temp.member(1), pg_temp.manifest(array['stop']));
begin
	perform pg_temp.fx($f$insert into public.qorpera_company_execution_pauses(profile_id, reason, paused_by_user_id)
		values ('63400000-0000-4000-8000-000000000010', 'test', '63400000-0000-4000-8000-000000000001')$f$);
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', pg_temp.member(1), pg_temp.manifest(array['x'])), '55000');
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, pg_temp.member(1),
		v_open ->> 'intentId', pg_temp.hash('stop')), '55000');
	perform pg_temp.raises(format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, 4)', c_env, pg_temp.member(1),
		v_open ->> 'intentId', pg_temp.hash('stop')), '55000');
	perform pg_temp.raises(format('select public.qorpera_folder_seal_upload(%L, %L, %L)', c_env, pg_temp.member(1), v_open ->> 'intentId'),
		'55000');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', pg_temp.member(1), repeat('a', 64)), '55000');
	delete from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010';
end $$;

-- 4. Commit step 6 --------------------------------------------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_file jsonb; v_exec jsonb; r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'c1d-seed', '[{"op":"mkdir","path":"docs"}]'), 1, 'saved');
	v_file := pg_temp.stage_v2(a, array['chunk one ', 'chunk two']);
	-- A write and a new folder's file save; a copy references the same objects.
	r := pg_temp.commit(a, 'c1d-write', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/a.md','file',v_file),
		jsonb_build_object('op','new_folder','path','docs/b','contents',jsonb_build_array(
			jsonb_build_object('path','b.md','kind','file','file',v_file))),
		jsonb_build_object('op','copy','from','docs/a.md','to','docs/c.md')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved'); perform pg_temp.expect(r, 3, 'saved');
	-- A reference whose media type or executable bit is not its manifest's is malformed.
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', a, 'c1d-media', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/d.md','file',v_file || '{"mediaType":"text/plain"}'))), '22023');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', a, 'c1d-exec-bit', jsonb_build_array(
		jsonb_build_object('op','new_folder','path','docs/e','contents',jsonb_build_array(
			jsonb_build_object('path','e.md','kind','file','file',v_file || '{"executable":true}'))))), '22023');
	v_exec := pg_temp.stage_v2(a, array['#!/bin/sh'], 'application/x-sh', true);
	perform pg_temp.expect(pg_temp.commit(a, 'c1d-exec', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/run.sh','file',v_exec))), 1, 'saved');
	-- A missing chunk makes the reference unverified, for a write and for a new folder's file.
	perform pg_temp.fx(format($f$delete from public.qorpera_profile_objects where profile_id = '63400000-0000-4000-8000-000000000010'
		and sha256 = %L$f$, pg_temp.hash('chunk two')));
	r := pg_temp.commit(a, 'c1d-missing', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/f.md','file',v_file),
		jsonb_build_object('op','new_folder','path','docs/g','contents',jsonb_build_array(
			jsonb_build_object('path','g.md','kind','file','file',v_file)))));
	perform pg_temp.expect(r, 1, 'refused', 'bytes_unverified'); perform pg_temp.expect(r, 2, 'refused', 'bytes_unverified');
	-- The objects a change set references, manifests and chunks, for step 6's lock.
	if (select array_agg(h order by h) from public.qorpera_folder_unit_objects('63400000-0000-4000-8000-000000000020',
			'63400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object('op','copy','from','docs','to','docs2'))) h) is distinct from
		(select array_agg(h order by h) from unnest(array[v_file ->> 'manifestSha256', pg_temp.hash('chunk one '), pg_temp.hash('chunk two'),
			v_exec ->> 'manifestSha256', pg_temp.hash('#!/bin/sh')]) h) then
		raise exception 'A copied folder references every file''s objects'; end if;
end $$;

-- 5. The download check ----------------------------------------------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_old jsonb; v_new jsonb; v_res uuid; v_version uuid;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'dl-seed-1', '[{"op":"mkdir","path":"secret"}]'), 1, 'saved');
	v_old := pg_temp.stage_v2(a, array['old secret ', 'text']);
	perform pg_temp.expect(pg_temp.commit(a, 'dl-write', jsonb_build_array(
		jsonb_build_object('op','write','path','secret/s.md','file',v_old))), 1, 'saved');
	-- Agent A reads it, as its manifest and as a chunk of it; the owner too.
	if (pg_temp.download(a, v_old ->> 'manifestSha256') ->> 'bytes')::bigint <> octet_length(convert_to(pg_temp.manifest(
			array['old secret ', 'text']), 'utf8'))
		or (pg_temp.download(a, pg_temp.hash('text')) ->> 'bytes')::bigint <> 4
		or pg_temp.download(pg_temp.member(1), pg_temp.hash('old secret ')) ->> 'profileId' <> '63400000-0000-4000-8000-000000000010' then
		raise exception 'A readable file''s objects'; end if;
	-- A hash nothing references, and one only an unsealed intent lists, are not fetched.
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', a, repeat('e', 64)), '42501');
	perform pg_temp.open(a, pg_temp.manifest(array['staged only']));
	perform pg_temp.confirm(a, (select id from public.qorpera_folder_upload_intents where manifest_sha256 =
		pg_temp.hash(pg_temp.manifest(array['staged only']))), 'staged only');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', a, pg_temp.hash('staged only')), '42501');
	-- Narrow secret/ to agent A: agent B may no longer fetch its bytes, a chunk included.
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'secret', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read','write']);
	perform pg_temp.download(a, v_old ->> 'manifestSha256');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, v_old ->> 'manifestSha256'), '42501');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, pg_temp.hash('text')), '42501');
	-- An old version stays readable to who may read the path now.
	v_version := (pg_temp.read('secret/s.md', a) -> 'entry' ->> 'version')::uuid;
	v_new := pg_temp.stage_v2(a, array['new secret']);
	perform pg_temp.expect(pg_temp.commit(a, 'dl-rewrite', jsonb_build_array(
		jsonb_build_object('op','write','path','secret/s.md','file',v_new,'expectedVersion',v_version))), 1, 'saved');
	perform pg_temp.download(a, pg_temp.hash('old secret '));
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, pg_temp.hash('old secret ')), '42501');
	-- Another environment of the company has none of it.
	perform pg_temp.raises(format('select pg_temp.download(%L, %L, %L)', a, v_new ->> 'manifestSha256',
		'63400000-0000-4000-8000-000000000099'), '42501');
end $$;

-- 6. Usage, the soft quota, replication and the old catalog insert ----------------------------------------------------
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	v_before public.qorpera_folder_storage_usage := pg_temp.usage(); v_files bigint;
	v_open jsonb;
begin
	select storage_used_bytes into v_files from public.qorpera_company_files where profile_id = c_profile;
	-- The catalog trigger counts folder-v2 bytes in the usage row, never in company_files.
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values (c_profile, repeat('1', 64), 100, 'nas-object-gateway');
	update public.qorpera_profile_objects set backend = 'supabase-storage' where profile_id = c_profile and sha256 = repeat('1', 64);
	if (pg_temp.usage()).bytes <> v_before.bytes + 100 or (pg_temp.usage()).objects <> v_before.objects + 1
		or (select storage_used_bytes from public.qorpera_company_files where profile_id = c_profile) <> v_files then
		raise exception 'Folder-v2 usage: %', to_jsonb(pg_temp.usage()); end if;
	delete from public.qorpera_profile_objects where profile_id = c_profile and sha256 = repeat('1', 64);
	if (pg_temp.usage()).bytes <> v_before.bytes or (pg_temp.usage()).objects <> v_before.objects then
		raise exception 'A removed object leaves usage'; end if;

	-- The quota is read plainly: a new object past the limit is refused, at confirm and at the Storage trigger; one
	-- already stored is not counted again.
	update public.qorpera_company_files set storage_limit_bytes = (pg_temp.usage()).bytes + 10 where profile_id = c_profile;
	v_open := pg_temp.open(pg_temp.member(1), pg_temp.manifest(array['eleven byte']));
	perform pg_temp.raises(format('select pg_temp.confirm(%L, %L, %L)', pg_temp.member(1), v_open ->> 'intentId', 'eleven byte'), '23514');
	perform pg_temp.raises(format($f$insert into storage.objects(bucket_id, name, metadata) values ('qorpera-profile-objects', %L, '{"size":11}')$f$,
		c_profile || '/' || repeat('2', 64)), '23514');
	perform public.qorpera_folder_storage_quota('qorpera-profile-objects', c_profile || '/' || pg_temp.hash('text'), '{"size":4}');
	update public.qorpera_company_files set storage_limit_bytes = 53687091200 where profile_id = c_profile;

	-- Replication of a folder-v2 object: the object and the company, no fence; the old catalog insert refuses.
	if not public.qorpera_authorize_profile_object_replication(c_profile, pg_temp.hash('text'), 4) then
		raise exception 'A stored object replicates'; end if;
	perform pg_temp.raises(format('select public.qorpera_authorize_profile_object_replication(%L, %L, 4)', c_profile, repeat('3', 64)),
		'42501');
	perform pg_temp.raises(format($f$select public.qorpera_confirm_profile_object_upload(%L, %L, 4, 'nas-object-gateway')$f$, c_profile,
		pg_temp.hash('text')), '0A000');
end $$;

-- 7. Snapshot-v1 companies keep today's paths: company_files usage, the fenced catalog insert and replication.
do $$
declare c_profile constant uuid := '76100000-0000-4000-8000-000000000010';
begin
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (c_profile, 'Snapshot', '63400000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('76100000-0000-4000-8000-000000000020', c_profile, 'Environment', 1, '63400000-0000-4000-8000-000000000001');
	-- (The environment provisions its Company File, snapshot-v1.)
	-- (Separate statements: a subquery beside a volatile call may be read before it.)
	if (public.qorpera_confirm_profile_object_upload(c_profile, repeat('4', 64), 9, 'nas-object-gateway') ->> 'bytes')::bigint <> 9
		or not public.qorpera_authorize_profile_object_replication(c_profile, repeat('4', 64), 9) then
		raise exception 'A snapshot-v1 company''s catalog insert and replication go the old way'; end if;
	if (select storage_used_bytes from public.qorpera_company_files where profile_id = c_profile) <> 9
		or exists (select 1 from public.qorpera_folder_storage_usage where profile_id = c_profile) then
		raise exception 'A snapshot-v1 company''s usage stays in company_files: %', (select to_jsonb(u)
			from public.qorpera_folder_storage_usage u where profile_id = c_profile); end if;
end $$;

-- 8. Only the service role stages and downloads.
set local role authenticated;
do $$
declare v_fn text;
begin
	foreach v_fn in array array[
		format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63400000-0000-4000-8000-000000000020', pg_temp.member(1),
			pg_temp.manifest(array['x'])),
		format('select public.qorpera_folder_authorize_object_download(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
			pg_temp.member(1), repeat('a', 64)),
		format('select public.qorpera_folder_manifest(%L)', pg_temp.manifest(array['x']))] loop
		begin
			execute v_fn;
			raise exception 'Members cannot call %', v_fn;
		exception when insufficient_privilege then null;
		end;
	end loop;
end $$;
reset role;

rollback;
