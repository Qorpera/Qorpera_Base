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
		-- Not the canonical text: a space, and keys in another order.
		replace(v_ok, '","bytes"', '", "bytes"'),
		replace(replace(v_ok, '"schema":"qorpera.cloud-file-manifest/v2",', ''), '"chunks":[', '"schema":"qorpera.cloud-file-manifest/v2","chunks":['),
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
	v_row public.qorpera_folder_upload_intents; v_text text;
begin
	-- A chunk already stored is present only to an actor that may read it: agent A must put it (which proves it has the
	-- bytes); the platform, which reads everything, need not.
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.hash('one '), 4, 'nas-object-gateway');
	-- (The trigger counted it: 4 bytes, one object.)
	v_usage := pg_temp.usage();
	if v_usage.bytes <> 4 or v_usage.objects <> 1 then raise exception 'The first object starts the usage row: %', to_jsonb(v_usage); end if;
	v_open := pg_temp.open(a, v_manifest);
	v_intent := (v_open ->> 'intentId')::uuid;
	select * into v_row from public.qorpera_folder_upload_intents where id = v_intent;
	if v_open -> 'present' <> '[]'::jsonb or v_open ->> 'manifestSha256' <> pg_temp.hash(v_manifest)
		or v_row.actor_kind <> 'run' or v_row.scope_id <> (a ->> 'runId')::uuid or v_row.state <> 'open'
		or v_row.expires_at not between clock_timestamp() + interval '14 minutes' and clock_timestamp() + interval '16 minutes'
		or v_row.media_type <> 'text/markdown' or v_row.executable or v_row.bytes <> 7
		or (select count(*) from public.qorpera_folder_upload_intent_objects where intent_id = v_intent and not held and not put) <> 3 then
		raise exception 'An open intent: % %', v_open, to_jsonb(v_row); end if;
	if pg_temp.open('{"kind":"platform"}', v_manifest) -> 'present' <> jsonb_build_array(pg_temp.hash('one ')) then
		raise exception 'The platform holds what the company stores'; end if;
	-- Another kind of actor with the same id is not the intent's actor.
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 3)', c_env,
		jsonb_build_object('kind', 'member', 'userId', a ->> 'runId'), v_intent, pg_temp.hash('two')), '42501');

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
	-- Its confirm checks the same itself (it no longer calls the authorization, 20260928309710): an unlisted object, or
	-- a listed one at another size, is refused and nothing is catalogued.
	perform pg_temp.raises(format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, 3)', c_env, a, v_intent,
		pg_temp.hash('other')), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, 4)', c_env, a, v_intent,
		pg_temp.hash('two')), '42501');
	if exists (select 1 from public.qorpera_profile_objects where profile_id = '63400000-0000-4000-8000-000000000010'
		and sha256 in (pg_temp.hash('other'), pg_temp.hash('two'))) then
		raise exception 'A refused confirm catalogues nothing'; end if;

	-- Sealing before every object is there says what is missing, and changes nothing.
	v_seal := pg_temp.seal(a, v_intent);
	if v_seal ->> 'state' <> 'incomplete' or v_seal -> 'missing' <> (select jsonb_agg(h order by h collate "C")
		from unnest(array[pg_temp.hash('one '), pg_temp.hash('two'), pg_temp.hash(v_manifest)]) h)
		or exists (select 1 from public.qorpera_verified_company_file_objects where manifest_sha256 = pg_temp.hash(v_manifest)) then
		raise exception 'An incomplete seal: %', v_seal; end if;

	-- The catalog row, once; usage counts it once.
	if (pg_temp.confirm(a, v_intent, 'two') ->> 'stored')::boolean is not true
		or (pg_temp.confirm(a, v_intent, 'two') ->> 'stored')::boolean then raise exception 'A confirm stores once'; end if;
	if (pg_temp.usage()).bytes <> v_usage.bytes + 3 or (pg_temp.usage()).objects <> v_usage.objects + 1 then
		raise exception 'Usage counts each stored object once: %, %', to_jsonb(v_usage), to_jsonb(pg_temp.usage()); end if;
	perform pg_temp.confirm(a, v_intent, v_manifest);
	-- A stored chunk the actor has not put or read is still missing; putting it stores nothing new.
	if pg_temp.seal(a, v_intent) -> 'missing' <> jsonb_build_array(pg_temp.hash('one ')) then
		raise exception 'Seal counts only what the actor put or holds'; end if;
	if (pg_temp.confirm(a, v_intent, 'one ') ->> 'stored')::boolean or (pg_temp.usage()).objects <> v_usage.objects + 2 then
		raise exception 'Putting a stored chunk proves possession and stores nothing'; end if;
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
	v_text := format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":5,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":5}]}',
		pg_temp.hash('one '), pg_temp.hash('one '));
	v_open := pg_temp.open(a, v_text);
	perform pg_temp.raises(format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, 5)', c_env, a, v_open ->> 'intentId',
		pg_temp.hash('one ')), '23505');
	-- Seal checks the size too: with the manifest put, the object put under another size is the one missing.
	perform pg_temp.confirm(a, (v_open ->> 'intentId')::uuid, v_text);
	update public.qorpera_folder_upload_intent_objects set put = true where intent_id = (v_open ->> 'intentId')::uuid;
	v_seal := pg_temp.seal(a, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'incomplete' or v_seal -> 'missing' <> jsonb_build_array(pg_temp.hash('one ')) then
		raise exception 'An object of another size is missing: %', v_seal; end if;

	-- Refused at open: a bad manifest, a member who left, another kind of actor, a snapshot-v1 company.
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', a, '{"schema":"x"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', '{"kind":"member","userId":"63400000-0000-4000-8000-000000000099"}',
		pg_temp.manifest(array['m'])), '42501');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', '{"kind":"robot"}', pg_temp.manifest(array['m'])), '22023');
	if (pg_temp.open(pg_temp.member(2), pg_temp.manifest(array['m'])) ->> 'intentId') is null
		or (pg_temp.open('{"kind":"platform"}', pg_temp.manifest(array['m'])) ->> 'intentId') is null then
		raise exception 'A member and the platform stage'; end if;
	-- A member who leaves after opening cannot seal (the membership row is restored by the rollback below).
	v_open := pg_temp.open(pg_temp.member(2), pg_temp.manifest(array['leave']));
	begin
		perform pg_temp.fx($f$delete from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
			and user_id = '63400000-0000-4000-8000-000000000002'$f$);
		perform pg_temp.raises(format('select public.qorpera_folder_seal_upload(%L, %L, %L)', c_env, pg_temp.member(2),
			v_open ->> 'intentId'), '42501');
		raise exception 'undo' using errcode = 'P0761';
	exception when sqlstate 'P0761' then null;
	end;
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
	-- A pause stops work, not reading (F1): downloads follow qorpera_folder_read, which refuses a paused company's runs.
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', pg_temp.member(1), repeat('a', 64)), '42501');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', a, repeat('a', 64)), '55000');
	delete from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010';
	-- A company being deleted serves no bytes to anyone.
	perform pg_temp.fx($f$insert into public.qorpera_company_deletions(profile_id) values ('63400000-0000-4000-8000-000000000010')$f$);
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', pg_temp.member(1), repeat('a', 64)), '55000');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', '{"kind":"platform"}', repeat('a', 64)), '55000');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', pg_temp.member(1), pg_temp.manifest(array['x'])), '55000');
	delete from public.qorpera_company_deletions where profile_id = '63400000-0000-4000-8000-000000000010';
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
	perform pg_temp.expect(pg_temp.commit(a, 'c1d-copy-missing', jsonb_build_array(
		jsonb_build_object('op','copy','from','docs/a.md','to','docs/a-copy.md'))), 1, 'refused', 'bytes_unverified');
	-- The objects a change set references, manifests and chunks, for step 6's lock.
	if (select array_agg(h order by h) from public.qorpera_folder_unit_objects('63400000-0000-4000-8000-000000000020',
			'63400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object('op','copy','from','docs','to','docs2'))) h) is distinct from
		(select array_agg(h order by h) from unnest(array[v_file ->> 'manifestSha256', pg_temp.hash('chunk one '), pg_temp.hash('chunk two'),
			v_exec ->> 'manifestSha256', pg_temp.hash('#!/bin/sh')]) h) then
		raise exception 'A copied folder references every file''s objects'; end if;
	-- A move references nothing new; beside a copy, its source counts, since it may carry files into the copy's source.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'c1d-mv-seed', '[{"op":"mkdir","path":"mv-src"},{"op":"mkdir","path":"mv-dst"}]'),
		1, 'saved');
	v_file := pg_temp.stage_v2(pg_temp.member(1), array['moved content']);
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'c1d-mv-write', jsonb_build_array(
		jsonb_build_object('op','write','path','mv-src/m.md','file',v_file))), 1, 'saved');
	if exists (select from public.qorpera_folder_unit_objects('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			'[{"op":"move","from":"mv-src/m.md","to":"mv-dst/m.md"}]')) then
		raise exception 'A move alone references nothing new'; end if;
	r := pg_temp.commit(pg_temp.member(1), 'c1d-mv-copy', jsonb_build_array(
		jsonb_build_object('op','move','from','mv-src/m.md','to','mv-dst/m.md','expectedVersion',
			pg_temp.read('mv-src/m.md') -> 'entry' ->> 'version'),
		jsonb_build_object('op','copy','from','mv-dst','to','mv-dst-copy')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
end $$;

-- 5. The download check ----------------------------------------------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_old jsonb; v_new jsonb; v_res uuid; v_version uuid; v_open jsonb; v_seal jsonb; v_there jsonb;
	c_env2 constant uuid := '63400000-0000-4000-8000-000000000022';
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

	-- Possession before reference (C1D §3). Agent B knows the secret file's reference but may not read it: a file it
	-- writes with that reference is refused, and the bytes stay out of its reach.
	perform pg_temp.expect(pg_temp.commit(b, 'dl-minted', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/minted.md','file',v_old))), 1, 'refused', 'bytes_unverified');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, pg_temp.hash('old secret ')), '42501');
	-- Knowing only a chunk's hash does not help either: the intent does not report it present, and seal counts it
	-- missing until B puts its bytes.
	v_open := pg_temp.open(b, pg_temp.manifest(array['old secret ', 'mine']));
	if v_open -> 'present' <> '[]'::jsonb then raise exception 'No oracle of stored bytes: %', v_open; end if;
	perform pg_temp.confirm(b, (v_open ->> 'intentId')::uuid, 'mine');
	perform pg_temp.confirm(b, (v_open ->> 'intentId')::uuid, pg_temp.manifest(array['old secret ', 'mine']));
	v_seal := pg_temp.seal(b, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'incomplete' or v_seal -> 'missing' <> jsonb_build_array(pg_temp.hash('old secret ')) then
		raise exception 'A chunk the actor neither put nor reads is missing: %', v_seal; end if;
	-- Nor does knowing the whole manifest: an open intent over its exact text, with only the manifest put, is not
	-- possession.
	v_open := pg_temp.open(b, pg_temp.manifest(array['old secret ', 'text']));
	perform pg_temp.confirm(b, (v_open ->> 'intentId')::uuid, pg_temp.manifest(array['old secret ', 'text']));
	perform pg_temp.expect(pg_temp.commit(b, 'dl-open-intent', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/open-intent.md','file',v_old))), 1, 'refused', 'bytes_unverified');
	-- An own sealed intent is possession while it lasts: expired, it is not.
	v_new := pg_temp.stage_v2(b, array['b own']);
	perform pg_temp.fx(format($f$update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '1 second'
		where manifest_sha256 = %L and actor_kind = 'run'$f$, v_new ->> 'manifestSha256'));
	perform pg_temp.expect(pg_temp.commit(b, 'dl-expired', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/b-own.md','file',v_new))), 1, 'refused', 'bytes_unverified');
	perform pg_temp.fx(format($f$update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() + interval '1 hour'
		where manifest_sha256 = %L and actor_kind = 'run'$f$, v_new ->> 'manifestSha256'));
	perform pg_temp.expect(pg_temp.commit(b, 'dl-sealed', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/b-own.md','file',v_new))), 1, 'saved');
	-- The held path: A may read the secret, so a new file sharing its chunk seals without putting that chunk again.
	v_open := pg_temp.open(a, pg_temp.manifest(array['old secret ', 'extra part']));
	if v_open -> 'present' <> jsonb_build_array(pg_temp.hash('old secret ')) then
		raise exception 'What the actor reads is present: %', v_open; end if;
	perform pg_temp.confirm(a, (v_open ->> 'intentId')::uuid, 'extra part');
	perform pg_temp.confirm(a, (v_open ->> 'intentId')::uuid, pg_temp.manifest(array['old secret ', 'extra part']));
	v_seal := pg_temp.seal(a, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' then raise exception 'A held chunk counts at seal: %', v_seal; end if;
	-- The decision reads only what step 6 locked (C1D §4): a closure object outside the locked set is unverified.
	if public.qorpera_folder_file_bytes_problem(c_env, '63400000-0000-4000-8000-000000000010', '{"kind":"platform"}', null, v_old,
			array[v_old ->> 'manifestSha256', pg_temp.hash('old secret '), pg_temp.hash('text')]) is not null
		or public.qorpera_folder_file_bytes_problem(c_env, '63400000-0000-4000-8000-000000000010', '{"kind":"platform"}', null, v_old,
			array[v_old ->> 'manifestSha256']) is distinct from 'bytes_unverified' then
		raise exception 'The decision reads the locked set'; end if;

	-- An old version stays readable to who may read the path now.
	v_version := (pg_temp.read('secret/s.md', a) -> 'entry' ->> 'version')::uuid;
	v_new := pg_temp.stage_v2(a, array['new secret']);
	perform pg_temp.expect(pg_temp.commit(a, 'dl-rewrite', jsonb_build_array(
		jsonb_build_object('op','write','path','secret/s.md','file',v_new,'expectedVersion',v_version))), 1, 'saved');
	perform pg_temp.download(a, pg_temp.hash('old secret '));
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, pg_temp.hash('old secret ')), '42501');
	-- Another environment of the company: a file there is readable there, and not through this environment.
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (c_env2, '63400000-0000-4000-8000-000000000010', 'Second', 1, '63400000-0000-4000-8000-000000000001');
	perform public.qorpera_folder_enable(c_env2);
	v_open := public.qorpera_folder_open_upload(c_env2, pg_temp.member(1), pg_temp.manifest(array['elsewhere']));
	perform public.qorpera_folder_confirm_object(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid, pg_temp.hash('elsewhere'), 9);
	perform public.qorpera_folder_confirm_object(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid,
		pg_temp.hash(pg_temp.manifest(array['elsewhere'])), octet_length(pg_temp.manifest(array['elsewhere'])));
	v_there := public.qorpera_folder_seal_upload(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid) -> 'file';
	perform pg_temp.expect(public.qorpera_folder_commit(c_env2, pg_temp.member(1), 'dl-there-1', jsonb_build_array(
		jsonb_build_object('op','write','path','there.md','file',v_there))), 1, 'saved');
	perform pg_temp.download(pg_temp.member(1), pg_temp.hash('elsewhere'), c_env2);
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', pg_temp.member(1), pg_temp.hash('elsewhere')), '42501');
	-- The owner, who may read the secret, may reference it: a copy where agents read it shares its bytes with them.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'dl-owner-copy', jsonb_build_array(
		jsonb_build_object('op','write','path','docs/owner-copy.md','file',v_old))), 1, 'saved');
	perform pg_temp.download(b, pg_temp.hash('old secret '));
end $$;

-- 6. Usage, the soft quota, replication and the old catalog insert ----------------------------------------------------
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	v_before public.qorpera_folder_storage_usage := pg_temp.usage(); v_files bigint;
	v_open jsonb; v_limit bigint;
begin
	select storage_used_bytes into v_files from public.qorpera_company_files where environment_id = '63400000-0000-4000-8000-000000000020';
	-- The catalog trigger counts folder-v2 bytes in the usage row, never in company_files.
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values (c_profile, repeat('1', 64), 100, 'nas-object-gateway');
	update public.qorpera_profile_objects set backend = 'supabase-storage' where profile_id = c_profile and sha256 = repeat('1', 64);
	if (pg_temp.usage()).bytes <> v_before.bytes + 100 or (pg_temp.usage()).objects <> v_before.objects + 1
		or (select storage_used_bytes from public.qorpera_company_files where environment_id = '63400000-0000-4000-8000-000000000020') <> v_files then
		raise exception 'Folder-v2 usage: %', to_jsonb(pg_temp.usage()); end if;
	delete from public.qorpera_profile_objects where profile_id = c_profile and sha256 = repeat('1', 64);
	if (pg_temp.usage()).bytes <> v_before.bytes or (pg_temp.usage()).objects <> v_before.objects then
		raise exception 'A removed object leaves usage'; end if;

	-- The quota is read plainly and checked before the NAS write (20260928309710): the gateway's authorization of a new
	-- object past the limit is refused, and so is the Storage trigger's insert; one already stored is not counted again.
	v_limit := (pg_temp.usage()).bytes;
	update public.qorpera_company_files set storage_limit_bytes = v_limit where profile_id = c_profile;
	v_open := pg_temp.open(pg_temp.member(1), pg_temp.manifest(array['x']));
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 1)', c_env, pg_temp.member(1),
		v_open ->> 'intentId', pg_temp.hash('x')), '23514');
	perform pg_temp.raises(format($f$insert into storage.objects(bucket_id, name, metadata) values ('qorpera-profile-objects', %L, '{"size":1}')$f$,
		c_profile || '/' || repeat('2', 64)), '23514');
	-- A confirm follows a write the gateway authorized before the limit was reached: it keeps the object, past the
	-- limit (the quota is soft), rather than strand its bytes on the NAS outside the catalog.
	perform pg_temp.confirm(pg_temp.member(1), (v_open ->> 'intentId')::uuid, 'x');
	if (pg_temp.usage()).bytes <> v_limit + 1
		or not exists (select 1 from public.qorpera_profile_objects where profile_id = c_profile and sha256 = pg_temp.hash('x')) then
		raise exception 'A confirm keeps what was written: %', to_jsonb(pg_temp.usage()); end if;
	-- An object already stored costs nothing more, at the authorization, the confirm and the Storage trigger.
	v_open := pg_temp.open(pg_temp.member(1), pg_temp.manifest(array['text']));
	perform public.qorpera_folder_authorize_object_upload(c_env, pg_temp.member(1), (v_open ->> 'intentId')::uuid, pg_temp.hash('text'), 4);
	perform pg_temp.confirm(pg_temp.member(1), (v_open ->> 'intentId')::uuid, 'text');
	if not public.qorpera_folder_storage_quota('qorpera-profile-objects', c_profile || '/' || pg_temp.hash('text'), '{"size":4}') then
		raise exception 'The Storage trigger decides for folder-v2'; end if;
	update public.qorpera_company_files set storage_limit_bytes = 53687091200 where profile_id = c_profile;

	-- A company whose row is missing (switched to folder-v2 with objects already stored) seeds it from the catalog at
	-- its first change.
	delete from public.qorpera_folder_storage_usage where profile_id = c_profile;
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values (c_profile, repeat('5', 64), 7, 'nas-object-gateway');
	if (pg_temp.usage()).bytes <> (select sum(bytes) from public.qorpera_profile_objects where profile_id = c_profile)
		or (pg_temp.usage()).objects <> (select count(*) from public.qorpera_profile_objects where profile_id = c_profile) then
		raise exception 'The usage row seeds from the catalog: %', to_jsonb(pg_temp.usage()); end if;

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

-- 8. The lock text (C1D §8): the snapshot-v1 bodies are the reviewed ones but for their folder-v2 line, which comes
-- first after "begin", the folder-v2 bodies take no company-wide lock, and step 6 keeps its sorted locks.
do $$
declare v_check record; v_definition text;
begin
	for v_check in select * from (values
		('public.qorpera_enforce_company_storage_quota()',
			'if public.qorpera_folder_storage_quota(new.bucket_id, new.name, new.metadata) then return new; end if;',
			'339d3122eed3d8f154b6a671a836dd074aaa9a6b07c47e42998fd8003c58eb59'),
		('public.qorpera_refresh_company_storage_usage()',
			'if public.qorpera_folder_storage_usage_changed(tg_op, old, new) then return case when tg_op = ''DELETE'' then old else new end; end if;',
			'f70353b583f7cf6853f57331bc9fa897eaa96251d13eb3d120838522965b5075'),
		('public.qorpera_authorize_profile_object_replication(uuid,text,bigint)',
			'if public.qorpera_company_is_folder_v2(p_profile_id) then return public.qorpera_folder_authorize_replication(p_profile_id, p_sha256, p_bytes); end if;',
			'483143cc9ae9e1d4b3c7eec128b047f99161632303f628df572ddc2060961beb'),
		('public.qorpera_confirm_profile_object_upload(uuid,text,bigint,text)',
			'if public.qorpera_company_is_folder_v2(p_profile_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;',
			'e97bb1724e5235cd41d1f2ed6af295f17765d7ab4e87e8ad98262303714e0059')) c(target, guard, digest)
	loop
		v_definition := pg_get_functiondef(v_check.target::regprocedure);
		if position(E'\nbegin\n\t' || v_check.guard || E'\n' in v_definition) = 0
			or encode(extensions.digest(replace(v_definition, E'\t' || v_check.guard || E'\n', ''), 'sha256'), 'hex') <> v_check.digest then
			raise exception 'The snapshot-v1 body of % changed beyond its folder-v2 line', v_check.target; end if;
	end loop;
	for v_check in select p.proname, p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
		'qorpera_folder_manifest', 'qorpera_folder_upload_scope', 'qorpera_folder_upload_actor', 'qorpera_folder_object_readable',
		'qorpera_folder_open_upload', 'qorpera_folder_put_intent', 'qorpera_folder_authorize_object_upload', 'qorpera_folder_confirm_object',
		'qorpera_folder_seal_upload', 'qorpera_folder_renew_upload', 'qorpera_folder_storage_quota_check', 'qorpera_folder_storage_quota',
		'qorpera_folder_storage_usage_changed', 'qorpera_folder_authorize_replication', 'qorpera_folder_authorize_object_download',
		'qorpera_folder_unit_objects', 'qorpera_folder_file_bytes_problem')
	loop
		if v_check.prosrc ~* '(for update|for share\M|nowait|lock_profile_gc_fence|qorpera_folder_fences|qorpera_runner_jobs)'
			or (v_check.prosrc ~* 'for no key update' and v_check.proname <> 'qorpera_folder_authorize_replication') then
			raise exception 'A folder-v2 body takes a lock it must not: %', v_check.proname; end if;
	end loop;
	if position('order by o.sha256 collate "C" for key share' in (select prosrc from pg_proc
		where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit')) = 0 then
		raise exception 'Step 6 locks the objects in one hash order'; end if;
end $$;

-- 9. Only the service role stages and downloads.
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
