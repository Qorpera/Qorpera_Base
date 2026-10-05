-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- Company folder core, for F3 step 3 (migration 20260930083000; deploy/first-node/RUNTIME-FOLDER-WRITES.md, 3a): an
-- upload holds the bytes its actor put under its own earlier intents, so a big file's chunks, sent before its manifest
-- was known, are not put again. Only the same actor's (kind and scope), only in the same environment, only while that
-- intent is unexpired; a marked object still refuses.

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_early jsonb; v_whole jsonb; v_seal jsonb; v_file jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'own-puts-seed', '[{"op":"mkdir","path":"big"}]'), 1, 'saved');

	-- Agent A sends the first chunk of a file it is still writing, under an intent of its own (a one-chunk manifest),
	-- and never seals it.
	v_early := pg_temp.open(a, pg_temp.manifest(array['first part '], 'application/octet-stream'));
	if v_early -> 'present' <> '[]'::jsonb then raise exception 'Nobody stored the first part yet: %', v_early; end if;
	perform pg_temp.confirm(a, (v_early ->> 'intentId')::uuid, 'first part ');

	-- The file is closed: its whole manifest. The first part is present (held), so only the rest is put.
	v_whole := pg_temp.open(a, pg_temp.manifest(array['first part ', 'second part']));
	if v_whole -> 'present' <> jsonb_build_array(pg_temp.hash('first part ')) then
		raise exception 'A holds the chunk it put itself: %', v_whole; end if;
	if not (select held from public.qorpera_folder_upload_intent_objects
		where intent_id = (v_whole ->> 'intentId')::uuid and sha256 = pg_temp.hash('first part ')) then
		raise exception 'The chunk is held under the whole file''s intent'; end if;
	perform pg_temp.confirm(a, (v_whole ->> 'intentId')::uuid, 'second part');
	perform pg_temp.confirm(a, (v_whole ->> 'intentId')::uuid, pg_temp.manifest(array['first part ', 'second part']));
	v_seal := pg_temp.seal(a, (v_whole ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' then raise exception 'The whole file seals: %', v_seal; end if;
	v_file := v_seal -> 'file';
	perform pg_temp.expect(pg_temp.commit(a, 'own-puts-write', jsonb_build_array(
		jsonb_build_object('op','write','path','big/file.md','file',v_file))), 1, 'saved');

	-- Another actor (agent B's run) holds nothing of what A put.
	v_early := pg_temp.open(a, pg_temp.manifest(array['private part'], 'application/octet-stream'));
	perform pg_temp.confirm(a, (v_early ->> 'intentId')::uuid, 'private part');
	if pg_temp.open(b, pg_temp.manifest(array['private part', 'tail'])) -> 'present' <> '[]'::jsonb then
		raise exception 'B holds nothing A put'; end if;
	if pg_temp.open(a, pg_temp.manifest(array['private part', 'tail'])) -> 'present'
		<> jsonb_build_array(pg_temp.hash('private part')) then
		raise exception 'A still holds it'; end if;

	-- An expired intent no longer counts: it no longer roots the bytes (G4).
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '1 second'
	where scope_id = (a ->> 'runId')::uuid and manifest_sha256 = pg_temp.hash(pg_temp.manifest(array['private part'], 'application/octet-stream'));
	if pg_temp.open(a, pg_temp.manifest(array['private part', 'more'])) -> 'present' <> '[]'::jsonb then
		raise exception 'An expired intent holds nothing'; end if;

	-- An object GC has marked still refuses the open (409, QRC01), as today's present objects do.
	v_early := pg_temp.open(a, pg_temp.manifest(array['marked part'], 'application/octet-stream'));
	perform pg_temp.confirm(a, (v_early ->> 'intentId')::uuid, 'marked part');
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since, lease_id, lease_expires_at)
	values (c_profile, pg_temp.hash('marked part'), clock_timestamp(), extensions.gen_random_uuid(),
		clock_timestamp() + interval '1 minute');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', a, pg_temp.manifest(array['marked part', 'end'])), 'PGRST');
end $$;

-- The patched body carries the marker.
do $$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_open_upload(uuid,jsonb,text)'::regprocedure),
			'20260930083000') = 0 then
		raise exception 'An upload does not hold its actor''s own puts'; end if;
end $$;

rollback;
