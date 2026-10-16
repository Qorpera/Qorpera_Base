-- @fixture 942_memory_tree_generation.test.sql until "-- A. An erase holds Nora's conversation"
-- Summary trees M3b (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10 GC; 20260930442000) against the upload intent
-- sweeper (C1D §9.5), on 942's committed company. An intent expired between 1 and 24 hours ago roots its bytes, and the
-- sweep removes it. The prune takes the intents that root the bytes it releases FOR KEY SHARE before its checks: a sweep
-- holding the intent makes the prune wait and read it gone, so the prune queues the bytes; a prune holding it makes the
-- sweep pass the intent over, and the next sweep queues them. Either way the pruned version's bytes get their GC row.

-- Nora's tree.toml rewritten at node_bytes p_bytes in this connection, at generation 0; returns the new version.
create function pg_temp.toml_write(p_key text, p_bytes integer) returns uuid language plpgsql as $$
declare v jsonb; t constant text := 'agents/nora/memory/thread/tree.toml';
begin
	execute pg_temp.sql_memory(p_key, jsonb_build_array(pg_temp.tree_file(t,
		pg_temp.toml(current_setting('qorpera_test.nora_session')::uuid, p_bytes), pg_temp.version(t))),
		array[current_setting('qorpera_test.nora_session')::uuid], array[0]) into v;
	perform pg_temp.expect(v, 1, 'saved');
	return pg_temp.version(t);
end $$;
-- The version's manifest, and the one upload intent that staged it.
create function pg_temp.manifest(p_version uuid) returns text language sql as $$
	select manifest_sha256 from public.qorpera_folder_path_versions where version = p_version
$$;
create function pg_temp.intent(p_manifest text) returns uuid language plpgsql as $$
declare v uuid[];
begin
	v := array(select id from public.qorpera_folder_upload_intents
		where profile_id = '94200000-0000-4000-8000-000000000010' and manifest_sha256 = p_manifest);
	if cardinality(v) <> 1 then raise exception 'One intent staged the manifest: %', v; end if;
	return v[1];
end $$;
-- The manifest's GC row's unreferenced_since, or null.
create function pg_temp.queued(p_manifest text) returns timestamptz language sql as $$
	select unreferenced_since from public.qorpera_folder_object_gc
	where profile_id = '94200000-0000-4000-8000-000000000010' and sha256 = p_manifest
$$;
-- The tree.toml's versions given (or all of them) 8 days old, and the prune's cursor at the start.
create function pg_temp.age(p_versions uuid[] default null) returns void language sql as $$
	update public.qorpera_folder_path_versions set created_at = created_at - interval '8 days'
	where environment_id = '94200000-0000-4000-8000-000000000020'
		and public.qorpera_folder_key(path) = 'agents/nora/memory/thread/tree.toml' and (p_versions is null or version = any (p_versions));
	update public.qorpera_memory_tree_prune_cursor set created_at = '-infinity', version = '00000000-0000-0000-0000-000000000000',
		updated_at = clock_timestamp() where id;
$$;

-- Nora's tree.toml written three times (1024, 768, 640; 942's fixture staged 1024 and 512): the second is the version the prune deletes. Its intent
-- expired two hours ago, so it still roots the bytes and the sweep takes it.
do $$
declare v jsonb;
begin
	execute current_setting('qorpera_test.memory_a') into v;
	perform pg_temp.expect(v, 1, 'saved'); perform pg_temp.expect(v, 2, 'saved');
	perform set_config('qorpera_test.v2', pg_temp.toml_write('m3b-race-2', 768)::text, false);
	perform pg_temp.toml_write('m3b-race-3', 640);
	perform set_config('qorpera_test.m2', pg_temp.manifest(current_setting('qorpera_test.v2')::uuid), false);
	perform set_config('qorpera_test.i2', pg_temp.intent(current_setting('qorpera_test.m2'))::text, false);
	perform pg_temp.age();
	delete from public.qorpera_memory_tree_prune_held;
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 hours'
	where id = current_setting('qorpera_test.i2')::uuid;
	if not public.qorpera_folder_gc_company('94200000-0000-4000-8000-000000000010')
		or not public.qorpera_folder_object_rooted('94200000-0000-4000-8000-000000000010', current_setting('qorpera_test.m2'))
		or pg_temp.queued(current_setting('qorpera_test.m2')) is not null then
		raise exception 'Folder GC serves the company, and the intent alone roots the second version''s bytes'; end if;
end $$;

-- A. The sweep first: it removes the intent and queues nothing (the version still roots the bytes). The prune deletes
-- the version, waits for the sweep at the intent, then reads it gone and queues the bytes itself.
do $$
declare v jsonb; m constant text := current_setting('qorpera_test.m2'); i constant uuid := current_setting('qorpera_test.i2')::uuid;
	e timestamptz := (select expires_at from public.qorpera_folder_upload_intents where id = current_setting('qorpera_test.i2')::uuid);
begin
	perform dblink_exec('mrace_hold', 'begin');
	perform * from dblink('mrace_hold', 'select public.qorpera_folder_sweep_upload_intents(100)') as t(n integer);
	if (select x from dblink('mrace_hold', format('select count(*) from public.qorpera_folder_upload_intents where id = %L', i))
		as t(x bigint)) <> 0 then
		perform dblink_exec('mrace_hold', 'rollback');
		raise exception 'A: the sweep removes the expired intent'; end if;
	perform dblink_send_query('mrace_save', 'select public.qorpera_memory_tree_prune(2000)');
	if not pg_temp.waits_for('mrace_save', 'mrace_hold') then
		perform dblink_exec('mrace_hold', 'rollback');
		select r into v from dblink_get_result('mrace_save') as t(r jsonb);
		perform * from dblink_get_result('mrace_save') as t(r jsonb);
		raise exception 'A: the prune must wait for the sweep at the intent; it returned %', v; end if;
	perform dblink_exec('mrace_hold', 'commit');
	select r into v from dblink_get_result('mrace_save') as t(r jsonb);
	perform * from dblink_get_result('mrace_save') as t(r jsonb);
	if v ->> 'pruned' is distinct from '1' or coalesce((v ->> 'released')::integer, 0) < 1
		or exists (select 1 from public.qorpera_folder_path_versions where version = current_setting('qorpera_test.v2')::uuid)
		or exists (select 1 from public.qorpera_folder_upload_intents where id = i) then
		raise exception 'A: the prune deletes the version: %', v; end if;
	-- The prune's row (unreferenced since now), not the sweep's (since the intent's expiry).
	if pg_temp.queued(m) is null or pg_temp.queued(m) <= e then
		raise exception 'A: the prune queues the bytes the sweep left: %', pg_temp.queued(m); end if;
end $$;

-- B. The prune first: it deletes the third version (now replaced) and queues nothing, as its intent roots the bytes.
-- The sweep passes over the intent the prune holds; once the prune commits, the next sweep removes it and queues them.
do $$
declare v3 constant uuid := pg_temp.version('agents/nora/memory/thread/tree.toml'); m text; i uuid; e timestamptz;
begin
	m := pg_temp.manifest(v3); i := pg_temp.intent(m);
	perform pg_temp.age(array[pg_temp.toml_write('m3b-race-4', 384)]);
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 hours' where id = i returning expires_at into e;
	perform set_config('qorpera_test.v3', v3::text, false);
	perform set_config('qorpera_test.m3', m, false);
	perform set_config('qorpera_test.i3', i::text, false);
	perform set_config('qorpera_test.e3', e::text, false);
end $$;
do $$
declare v jsonb; m constant text := current_setting('qorpera_test.m3'); i constant uuid := current_setting('qorpera_test.i3')::uuid;
begin
	perform dblink_exec('mrace_hold', 'begin');
	select r into v from dblink('mrace_hold', 'select public.qorpera_memory_tree_prune(2000)') as t(r jsonb);
	if v ->> 'pruned' is distinct from '1' or v ->> 'released' is distinct from '0' then
		perform dblink_exec('mrace_hold', 'rollback');
		raise exception 'B: the prune deletes the third version and queues nothing: %', v; end if;
	perform * from dblink('mrace_save', 'select public.qorpera_folder_sweep_upload_intents(100)') as t(n integer);
	if not exists (select 1 from public.qorpera_folder_upload_intents where id = i) or pg_temp.queued(m) is not null then
		perform dblink_exec('mrace_hold', 'rollback');
		raise exception 'B: the sweep passes over the intent the prune holds'; end if;
	perform dblink_exec('mrace_hold', 'commit');
	perform * from dblink('mrace_save', 'select public.qorpera_folder_sweep_upload_intents(100)') as t(n integer);
	if exists (select 1 from public.qorpera_folder_upload_intents where id = i)
		or exists (select 1 from public.qorpera_folder_path_versions where version = current_setting('qorpera_test.v3')::uuid)
		or pg_temp.queued(m) is distinct from current_setting('qorpera_test.e3')::timestamptz then
		raise exception 'B: the next sweep removes the intent and queues the bytes from its expiry: %', pg_temp.queued(m); end if;
end $$;

select dblink_disconnect(name) from unnest(array['mrace_post','mrace_save','mrace_hold']) name;

-- The committed fixture leaves the shared suite database, and the prune's state is as it was.
set session_replication_role = replica;
delete from public.qorpera_memory_tree_nodes where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_memory_trees where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_memory_read_receipts where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_memory_tree_prune_held where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_company_index where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '94200000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_session_events where session_id in (select id from public.qorpera_shared_sessions where profile_id = '94200000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '94200000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by
-- hand, with their proofs, chunk rows and GC rows; any Storage object takes its mirror row with it.
delete from public.qorpera_profile_objects where profile_id = '94200000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '94200000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '94200000-0000-4000-8000-000000000010';
delete from auth.users where id in ('94200000-0000-4000-8000-000000000001','94200000-0000-4000-8000-000000000002');
update public.qorpera_memory_tree_prune_cursor set created_at = '-infinity', version = '00000000-0000-0000-0000-000000000000',
	updated_at = clock_timestamp() where id;
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '94200000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_memory_trees where environment_id = '94200000-0000-4000-8000-000000000020')
		or exists (select 1 from storage.objects where name like '94200000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_object_gc where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_memory_tree_prune_held where environment_id = '94200000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '94200000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
