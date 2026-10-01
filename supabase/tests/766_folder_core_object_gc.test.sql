-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- Company folder core, C1d-2a: garbage collection of folder-v2 objects (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md
-- §9). The sweep and when an object lost its roots, the root check across environments and proof versions, the claim
-- and its mark, the refusals of a marked object, the unlink's SQL, the quarantine state, the folder-v2-only catalog,
-- the lock text and the grants. Races are in 767.

-- An intent of the actor that is opened, its objects confirmed, and left: never sealed or committed.
create function pg_temp.abandon(p_actor jsonb, p_chunks text[], p_env uuid default '63400000-0000-4000-8000-000000000020')
returns uuid language plpgsql as $$
declare v_manifest text := pg_temp.manifest(p_chunks); v_open jsonb; v_text text;
begin
	v_open := public.qorpera_folder_open_upload(p_env, p_actor, v_manifest);
	foreach v_text in array p_chunks || v_manifest loop
		if not (v_open -> 'present') ? pg_temp.hash(v_text) then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, pg_temp.hash(v_text),
				octet_length(convert_to(v_text, 'utf8'))); end if;
	end loop;
	return (v_open ->> 'intentId')::uuid;
end $$;
-- Moves an intent's expiry into the past, as if its time ran out.
create function pg_temp.expire(p_intent uuid, p_ago interval) returns timestamptz language sql as $$
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - p_ago where id = p_intent returning expires_at
$$;
create function pg_temp.gc(p_sha text) returns public.qorpera_folder_object_gc language sql as $$
	select * from public.qorpera_folder_object_gc where profile_id = '63400000-0000-4000-8000-000000000010' and sha256 = p_sha
$$;
create function pg_temp.age(p_sha text, p_ago interval) returns void language sql as $$
	update public.qorpera_folder_object_gc set unreferenced_since = clock_timestamp() - p_ago
	where profile_id = '63400000-0000-4000-8000-000000000010' and sha256 = p_sha
$$;
create function pg_temp.mark(p_sha text, p_lease uuid, p_for interval default interval '10 minutes') returns void language sql as $$
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since, lease_id, lease_expires_at)
	values ('63400000-0000-4000-8000-000000000010', p_sha, clock_timestamp() - interval '2 days', p_lease, clock_timestamp() + p_for)
	on conflict (profile_id, sha256) do update set lease_id = excluded.lease_id, lease_expires_at = excluded.lease_expires_at
$$;
create function pg_temp.stored(p_sha text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_profile_objects where profile_id = '63400000-0000-4000-8000-000000000010' and sha256 = p_sha)
$$;
-- A live intent of the platform naming an object: a root, written directly (open refuses a marked object).
create function pg_temp.root_intent(p_sha text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
	insert into public.qorpera_folder_upload_intents(environment_id, profile_id, actor_kind, scope_id, manifest_sha256, manifest_text,
		file_sha256, bytes, media_type, executable, expires_at)
	values ('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', 'platform',
		'00000000-0000-0000-0000-000000000000', p_sha, '{}', p_sha, 1, 'text/plain', false, clock_timestamp() + interval '15 minutes')
	returning id into v_id;
	insert into public.qorpera_folder_upload_intent_objects(intent_id, sha256, bytes, profile_id)
	values (v_id, p_sha, 1, '63400000-0000-4000-8000-000000000010');
	return v_id;
end $$;
-- A refusal as a conflict: the runtime's QRC01 409 envelope (C1D §9.7), never 40001.
create function pg_temp.conflict(p_sql text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_state = 'PGRST' and v_message::jsonb ->> 'code' = 'QRC01' then return; end if;
		raise exception 'Expected the QRC01 conflict, got % %: %', v_state, v_message, p_sql;
	end;
	raise exception 'Expected the QRC01 conflict: %', p_sql;
end $$;
-- The version-2 stage helper (C1D §9.3 step 1): the version-1 helper's name and result shape, on the byte path (open,
-- confirm, seal). A version-2 file is held to possession, so a fixture whose run or member commits it passes that actor.
drop function pg_temp.stage(text);
create function pg_temp.stage(p_text text, p_actor jsonb default '{"kind":"platform"}') returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest(case when p_text = '' then '{}'::text[] else array[p_text] end, 'text/plain');
	v_open jsonb; v_object text; v_seal jsonb;
begin
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', p_actor, v_manifest);
	foreach v_object in array case when p_text = '' then array[v_manifest] else array[p_text, v_manifest] end loop
		if not (v_open -> 'present') ? pg_temp.hash(v_object) then
			perform public.qorpera_folder_confirm_object('63400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid,
				pg_temp.hash(v_object), octet_length(convert_to(v_object, 'utf8'))); end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' then raise exception 'Fixture: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
create function pg_temp.claimed(p_result jsonb) returns text[] language sql as $$
	select coalesce(array_agg(o ->> 'sha256' order by o ->> 'sha256'), '{}') from jsonb_array_elements(p_result -> 'objects') o
$$;

-- 1. The sweep, and when objects lost their roots (G4) ----------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_kept jsonb; v_left uuid; v_recent uuid; v_again uuid; v_expired timestamptz; v_later timestamptz; v_open jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'gc-seed-01', '[{"op":"mkdir","path":"gc"}]'), 1, 'saved');
	-- A committed file shares a chunk with an upload that is then left.
	v_kept := pg_temp.stage_v2(a, array['gc kept ']);
	perform pg_temp.expect(pg_temp.commit(a, 'gc-kept-01', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/kept.md','file',v_kept))), 1, 'saved');
	v_left := pg_temp.abandon(pg_temp.member(1), array['gc kept ', 'gc left']);
	v_expired := pg_temp.expire(v_left, interval '2 hours');
	-- Expired less than an hour ago: not swept yet, and its objects are still rooted through the grace window.
	v_recent := pg_temp.abandon(pg_temp.member(1), array['gc recent']);
	perform pg_temp.expire(v_recent, interval '30 minutes');
	if public.qorpera_folder_sweep_upload_intents(100) <> 1 then raise exception 'One intent is past its sweep'; end if;
	if exists (select 1 from public.qorpera_folder_upload_intents where id = v_left)
		or not exists (select 1 from public.qorpera_folder_upload_intents where id = v_recent) then
		raise exception 'The sweep removes the intent past its time only'; end if;
	-- The left chunk and manifest lost their roots at the intent's expiry; the shared chunk is still the committed file's.
	if (pg_temp.gc(pg_temp.hash('gc left'))).unreferenced_since is distinct from v_expired
		or (pg_temp.gc(pg_temp.hash(pg_temp.manifest(array['gc kept ', 'gc left'])))).unreferenced_since is distinct from v_expired
		or (pg_temp.gc(pg_temp.hash('gc kept '))).sha256 is not null then
		raise exception 'The sweep records what lost its roots, and when'; end if;
	if not public.qorpera_folder_object_rooted('63400000-0000-4000-8000-000000000010', pg_temp.hash('gc recent')) then
		raise exception 'An intent the sweep has not reached roots its objects through grace'; end if;
	-- Reused by a later intent that is left too: the time moves forward to that one's expiry.
	v_again := pg_temp.abandon(pg_temp.member(1), array['gc left']);
	v_later := pg_temp.expire(v_again, interval '90 minutes');
	perform pg_temp.expire(v_recent, interval '3 hours');
	if public.qorpera_folder_sweep_upload_intents(100) <> 2 then raise exception 'Two more intents are past their sweep'; end if;
	if (pg_temp.gc(pg_temp.hash('gc left'))).unreferenced_since is distinct from v_later then
		raise exception 'Reuse moves the time forward (greatest)'; end if;
	-- An intent that expired earlier never moves it back.
	perform pg_temp.expire(pg_temp.abandon(pg_temp.member(1), array['gc left']), interval '5 hours');
	perform public.qorpera_folder_sweep_upload_intents(100);
	if (pg_temp.gc(pg_temp.hash('gc left'))).unreferenced_since is distinct from v_later then
		raise exception 'An earlier expiry never moves the time back (greatest)'; end if;
	-- An old version of an overwritten file still roots its objects (path versions are kept for good).
	v_kept := pg_temp.stage_v2(a, array['gc old version']);
	perform pg_temp.expect(pg_temp.commit(a, 'gc-old-01', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/old.md','file',v_kept))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(a, 'gc-old-02', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/old.md','file',pg_temp.stage_v2(a, array['gc new version']),
			'expectedVersion', pg_temp.read('gc/old.md') -> 'entry' ->> 'version'))), 1, 'saved');
	-- (Its own sealed intents expired long ago: only the path version is left to root it.)
	delete from public.qorpera_folder_upload_intents where manifest_sha256 = pg_temp.hash(pg_temp.manifest(array['gc old version']));
	v_again := pg_temp.abandon(pg_temp.member(1), array['gc old version', 'gc old tail']);
	perform pg_temp.expire(v_again, interval '2 hours');
	-- And an intent whose chunk was never put: its object has no catalog row, so it gets no GC row.
	v_open := pg_temp.open(pg_temp.member(1), pg_temp.manifest(array['gc never put']));
	perform pg_temp.expire((v_open ->> 'intentId')::uuid, interval '2 hours');
	perform public.qorpera_folder_sweep_upload_intents(100);
	if (pg_temp.gc(pg_temp.hash('gc old version'))).sha256 is not null or (pg_temp.gc(pg_temp.hash('gc old tail'))).sha256 is null then
		raise exception 'An old path version roots its objects'; end if;
	if exists (select 1 from public.qorpera_folder_upload_intents where id = (v_open ->> 'intentId')::uuid)
		or (pg_temp.gc(pg_temp.hash('gc never put'))).sha256 is not null then
		raise exception 'An intent with an object never put is swept, and that object gets no GC row'; end if;
	-- Objects without a catalog row get no GC row: the put whose confirm never ran is C1d-2c's.
	if exists (select 1 from public.qorpera_folder_object_gc g where not pg_temp.stored(g.sha256)) then
		raise exception 'GC rows are for catalog objects'; end if;
	perform pg_temp.raises('select public.qorpera_folder_sweep_upload_intents(0)', '22023');
	perform pg_temp.raises('select public.qorpera_folder_sweep_upload_intents(101)', '22023');
end $$;

-- 2. The claim and its mark (G2) ---------------------------------------------------------------------------------------
do $$
declare
	v_lease uuid := extensions.gen_random_uuid(); v_other uuid := extensions.gen_random_uuid(); r jsonb; v_left text := pg_temp.hash('gc left');
	v_manifest text := pg_temp.hash(pg_temp.manifest(array['gc kept ', 'gc left'])); v_storage jsonb;
begin
	-- Not past grace yet.
	if jsonb_array_length(public.qorpera_folder_claim_object_gc(100, v_lease) -> 'objects') <> 0 then
		raise exception 'Nothing is past grace yet'; end if;
	perform pg_temp.age(v_left, interval '25 hours');
	perform pg_temp.age(v_manifest, interval '25 hours');
	r := public.qorpera_folder_claim_object_gc(100, v_lease);
	if pg_temp.claimed(r) is distinct from (select array_agg(h order by h) from unnest(array[v_left, v_manifest]) h)
		or (pg_temp.gc(v_left)).lease_id is distinct from v_lease
		or (pg_temp.gc(v_left)).lease_expires_at not between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '11 minutes'
		or r -> 'objects' -> 0 ->> 'backend' <> 'nas-object-gateway' or r -> 'objects' -> 0 ->> 'leaseId' <> v_lease::text then
		raise exception 'The claim marks what is past grace: %', r; end if;
	-- A live mark is not claimed again; an expired one is.
	if jsonb_array_length(public.qorpera_folder_claim_object_gc(100, v_other) -> 'objects') <> 0 then
		raise exception 'A live mark is not claimed again'; end if;
	update public.qorpera_folder_object_gc set lease_expires_at = clock_timestamp() - interval '1 second' where sha256 = v_left;
	if pg_temp.claimed(public.qorpera_folder_claim_object_gc(100, v_other)) is distinct from array[v_left] then
		raise exception 'An expired mark is claimed again'; end if;
	-- Rooted again before the claim: the re-check drops its GC row, unmarked.
	update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null where sha256 = v_manifest;
	perform pg_temp.root_intent(v_manifest);
	-- (Each call that changes something runs alone: a condition's terms have no set order.)
	r := public.qorpera_folder_claim_object_gc(100, extensions.gen_random_uuid());
	if jsonb_array_length(r -> 'objects') <> 0 or (pg_temp.gc(v_manifest)).sha256 is not null then
		raise exception 'A rooted object loses its GC row at the claim'; end if;
	-- A Storage-backed row is kept (its Storage file is its catalog row through the mirror trigger).
	insert into storage.objects(bucket_id, name, metadata)
	values ('qorpera-profile-objects', '63400000-0000-4000-8000-000000000010/' || pg_temp.hash('gc storage backed'),
		jsonb_build_object('size', 17));
	v_storage := jsonb_build_object('fileSha256', pg_temp.hash('gc storage backed'));
	if (select backend from public.qorpera_profile_objects where profile_id = '63400000-0000-4000-8000-000000000010'
		and sha256 = v_storage ->> 'fileSha256') <> 'supabase-storage' then raise exception 'Fixture: a Storage-backed row'; end if;
	perform pg_temp.mark(v_storage ->> 'fileSha256', extensions.gen_random_uuid(), interval '-1 minute');
	if pg_temp.claimed(public.qorpera_folder_claim_object_gc(100, extensions.gen_random_uuid())) && array[v_storage ->> 'fileSha256'] then
		raise exception 'A Storage-backed row is not claimed'; end if;
	delete from public.qorpera_folder_object_gc where sha256 = v_storage ->> 'fileSha256';
	perform pg_temp.raises(format('select public.qorpera_folder_claim_object_gc(0, %L)', v_lease), '22023');
	perform pg_temp.raises('select public.qorpera_folder_claim_object_gc(1, null)', '22023');
end $$;

-- 3. A marked object is refused at every reference (G1) --------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_lease uuid := extensions.gen_random_uuid(); v_x text := pg_temp.hash('gc marked'); v_open jsonb; v_seal uuid; v_file jsonb;
begin
	-- An upload sealed before the mark, and one open with its object put.
	v_file := pg_temp.stage_v2(a, array['gc marked', 'gc beside']);
	v_open := pg_temp.open(a, pg_temp.manifest(array['gc marked', 'gc third']));
	v_seal := (v_open ->> 'intentId')::uuid;
	perform pg_temp.confirm(a, v_seal, 'gc third');
	perform pg_temp.confirm(a, v_seal, pg_temp.manifest(array['gc marked', 'gc third']));
	perform pg_temp.mark(v_x, v_lease);
	-- open: a present object GC holds (the platform's present objects are all stored ones).
	perform pg_temp.conflict(format('select pg_temp.open(%L, %L)', '{"kind":"platform"}', pg_temp.manifest(array['gc marked'])));
	-- authorize and confirm the put; seal.
	perform pg_temp.conflict(format($q$select public.qorpera_folder_authorize_object_upload('63400000-0000-4000-8000-000000000020',
		%L, %L, %L, 9)$q$, a, v_seal, v_x));
	perform pg_temp.conflict(format('select pg_temp.confirm(%L, %L, %L)', a, v_seal, 'gc marked'));
	perform pg_temp.conflict(format('select pg_temp.seal(%L, %L)', a, v_seal));
	-- replication, and the download (answered as missing, even for the platform).
	perform pg_temp.conflict(format($q$select public.qorpera_folder_authorize_replication('63400000-0000-4000-8000-000000000010', %L, 9)$q$, v_x));
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', '{"kind":"platform"}', v_x), '42501');
	-- commit step 6: a unit referencing it is refused as for a missing object.
	perform pg_temp.expect(pg_temp.commit(a, 'gc-marked-write', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/marked.md','file',v_file))), 1, 'refused', 'bytes_unverified');
	-- An expired mark is no mark.
	update public.qorpera_folder_object_gc set lease_expires_at = clock_timestamp() - interval '1 second' where sha256 = v_x;
	perform pg_temp.download('{"kind":"platform"}', v_x);
	perform public.qorpera_folder_authorize_replication('63400000-0000-4000-8000-000000000010', v_x, 9);
	perform pg_temp.expect(pg_temp.commit(a, 'gc-unmarked-write', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/marked.md','file',v_file))), 1, 'saved');
	perform pg_temp.confirm(a, v_seal, 'gc marked');
	if (pg_temp.seal(a, v_seal)) ->> 'state' <> 'sealed' then raise exception 'Unmarked, the put and the seal go on'; end if;
	delete from public.qorpera_folder_object_gc where sha256 = v_x;
end $$;

-- 4. The unlink's SQL: begin, finish, abandon, and the quarantine state -------------------------------------------------
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	v_lease uuid := extensions.gen_random_uuid(); v_x text := pg_temp.hash('gc doomed'); v_intent uuid; b jsonb; v_usage bigint;
	v_until timestamptz; v_res text;
begin
	v_intent := pg_temp.abandon(pg_temp.member(1), array['gc doomed']);
	delete from public.qorpera_folder_upload_intents where id = v_intent;
	perform pg_temp.mark(v_x, v_lease);
	-- begin: this lease only; a repeat moves the expiry no earlier.
	b := public.qorpera_folder_gc_unlink_begin(c_profile, v_x, v_lease);
	if b ->> 'backend' <> 'nas-object-gateway' or (b ->> 'bytes')::bigint <> 9 then raise exception 'Begin: %', b; end if;
	v_until := (pg_temp.gc(v_x)).lease_expires_at;
	perform public.qorpera_folder_gc_unlink_begin(c_profile, v_x, v_lease);
	if (pg_temp.gc(v_x)).lease_expires_at < v_until then raise exception 'A repeat begin moves the expiry no earlier'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_gc_unlink_begin(%L, %L, %L)', c_profile, v_x,
		extensions.gen_random_uuid()), '55000');
	-- the quarantine state while the lane is in flight.
	if public.qorpera_folder_gc_quarantine_state(c_profile, v_x, v_lease) <> 'live'
		or public.qorpera_folder_gc_quarantine_state(c_profile, v_x, extensions.gen_random_uuid()) <> 'restore' then
		raise exception 'The quarantine state of a lane in flight'; end if;
	-- finish: another lease is stale; this one removes the row, its GC row and its usage.
	if public.qorpera_folder_gc_unlink_finish(c_profile, v_x, extensions.gen_random_uuid()) <> 'stale' then
		raise exception 'Another lease is stale'; end if;
	v_usage := (pg_temp.usage()).bytes;
	v_res := public.qorpera_folder_gc_unlink_finish(c_profile, v_x, v_lease);
	if v_res <> 'removed' or pg_temp.stored(v_x) or (pg_temp.gc(v_x)).sha256 is not null or (pg_temp.usage()).bytes <> v_usage - 9 then
		raise exception 'Finish removes the object'; end if;
	v_res := public.qorpera_folder_gc_unlink_finish(c_profile, v_x, v_lease);
	if v_res <> 'removed' or public.qorpera_folder_gc_quarantine_state(c_profile, v_x, v_lease) <> 'remove' then
		raise exception 'A finished object is removed, again'; end if;

	-- Rooted again (a path version names it): restore, and its GC row goes.
	v_x := pg_temp.hash('gc rooted late');
	v_intent := pg_temp.abandon(pg_temp.member(1), array['gc rooted late']);
	delete from public.qorpera_folder_upload_intents where id = v_intent;
	perform pg_temp.mark(v_x, v_lease);
	perform pg_temp.root_intent(v_x);
	v_res := public.qorpera_folder_gc_unlink_finish(c_profile, v_x, v_lease);
	if v_res <> 'restore' or not pg_temp.stored(v_x) or (pg_temp.gc(v_x)).sha256 is not null then
		raise exception 'A rooted object is restored'; end if;

	-- Grace moved (a later intent was swept): restore, the mark cleared, the GC row kept.
	v_x := pg_temp.hash('gc grace moved');
	v_intent := pg_temp.abandon(pg_temp.member(1), array['gc grace moved']);
	delete from public.qorpera_folder_upload_intents where id = v_intent;
	perform pg_temp.mark(v_x, v_lease);
	update public.qorpera_folder_object_gc set unreferenced_since = clock_timestamp() - interval '1 hour' where sha256 = v_x;
	v_res := public.qorpera_folder_gc_unlink_finish(c_profile, v_x, v_lease);
	if v_res <> 'restore' or (pg_temp.gc(v_x)).lease_id is not null or (pg_temp.gc(v_x)).sha256 is null then
		raise exception 'Grace moved: restore, unmarked'; end if;

	-- A reference from outside the folder core (23503): restore, and the GC row goes so it is never claimed again.
	create table public.gc_outside_766 (profile_id uuid, sha256 text,
		foreign key (profile_id, sha256) references public.qorpera_profile_objects(profile_id, sha256) on delete restrict);
	insert into public.gc_outside_766 values (c_profile, v_x);
	update public.qorpera_folder_object_gc set unreferenced_since = clock_timestamp() - interval '2 days' where sha256 = v_x;
	perform pg_temp.mark(v_x, v_lease);
	v_res := public.qorpera_folder_gc_unlink_finish(c_profile, v_x, v_lease);
	if v_res <> 'restore' or not pg_temp.stored(v_x) or (pg_temp.gc(v_x)).sha256 is not null then
		raise exception 'A reference outside the folder core: restore, and never claimed again'; end if;
	drop table public.gc_outside_766;

	-- Abandon clears this lease's mark at once.
	perform pg_temp.mark(v_x, v_lease);
	if public.qorpera_folder_gc_unlink_abandon(c_profile, v_x, extensions.gen_random_uuid()) then
		raise exception 'Abandon is this lease''s only'; end if;
	if not public.qorpera_folder_gc_unlink_abandon(c_profile, v_x, v_lease) or (pg_temp.gc(v_x)).lease_id is not null then
		raise exception 'Abandon clears the mark: %', row_to_json(pg_temp.gc(v_x)); end if;
	if public.qorpera_folder_gc_quarantine_state(c_profile, v_x, v_lease) <> 'restore' then
		raise exception 'Abandoned, the file is restored: %', public.qorpera_folder_gc_quarantine_state(c_profile, v_x, v_lease); end if;
	delete from public.qorpera_folder_object_gc where sha256 = v_x;
end $$;

-- 5. Roots across environments and proof versions ---------------------------------------------------------------------
do $$
declare
	c_env2 constant uuid := '63400000-0000-4000-8000-000000000021';
	v_open jsonb; v_there jsonb; v_left uuid; v_v1 jsonb; v_lease uuid := extensions.gen_random_uuid(); r jsonb;
begin
	-- A file committed in another folder-v2 environment of the company roots its objects here too.
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (c_env2, '63400000-0000-4000-8000-000000000010', 'Second', 1, '63400000-0000-4000-8000-000000000001');
	perform public.qorpera_folder_enable(c_env2);
	v_open := public.qorpera_folder_open_upload(c_env2, pg_temp.member(1), pg_temp.manifest(array['gc elsewhere']));
	perform public.qorpera_folder_confirm_object(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid, pg_temp.hash('gc elsewhere'), 12);
	perform public.qorpera_folder_confirm_object(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid,
		pg_temp.hash(pg_temp.manifest(array['gc elsewhere'])), octet_length(pg_temp.manifest(array['gc elsewhere'])));
	v_there := public.qorpera_folder_seal_upload(c_env2, pg_temp.member(1), (v_open ->> 'intentId')::uuid) -> 'file';
	perform pg_temp.expect(public.qorpera_folder_commit(c_env2, pg_temp.member(1), 'gc-there-01', jsonb_build_array(
		jsonb_build_object('op','write','path','there.md','file',v_there))), 1, 'saved');
	v_left := pg_temp.abandon(pg_temp.member(1), array['gc elsewhere', 'gc here only']);
	perform pg_temp.expire(v_left, interval '2 hours');
	delete from public.qorpera_folder_upload_intents where id = (v_open ->> 'intentId')::uuid;
	perform public.qorpera_folder_sweep_upload_intents(100);
	if (pg_temp.gc(pg_temp.hash('gc elsewhere'))).sha256 is not null or (pg_temp.gc(pg_temp.hash('gc here only'))).sha256 is null then
		raise exception 'A file committed in another environment roots its chunk'; end if;
	-- And if its GC row is forced, the claim's re-check drops it.
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.hash('gc elsewhere'), clock_timestamp() - interval '2 days');
	r := public.qorpera_folder_claim_object_gc(100, v_lease);
	if pg_temp.claimed(r) && array[pg_temp.hash('gc elsewhere')] or (pg_temp.gc(pg_temp.hash('gc elsewhere'))).sha256 is not null then
		raise exception 'The claim checks every folder-v2 environment'; end if;

	-- The version-2 stage helper: a file the platform staged, and one a member staged and commits (possession).
	v_v1 := pg_temp.stage('gc staged by the platform');
	if v_v1 - 'manifestSha256' is distinct from jsonb_build_object('fileSha256', pg_temp.hash('gc staged by the platform'), 'bytes', 25,
			'mediaType', 'text/plain', 'executable', false)
		or not exists (select 1 from public.qorpera_verified_company_file_objects
			where manifest_sha256 = v_v1 ->> 'manifestSha256' and verifier_version = 2) then
		raise exception 'The stage helper keeps the version-1 helper''s result shape: %', v_v1; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'gc-v2-help-1', jsonb_build_array(
		jsonb_build_object('op','write','path','gc/by-member.md','file',pg_temp.stage('gc staged by a member', pg_temp.member(1))))),
		1, 'saved');
	if (pg_temp.stage('')) ->> 'bytes' <> '0' then raise exception 'An empty file stages too'; end if;
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('63400000-0000-4000-8000-000000000022', '63400000-0000-4000-8000-000000000010', 'Third', 1,
		'63400000-0000-4000-8000-000000000001');

	-- A company with a snapshot-v1 environment beside its folder-v2 ones is never claimed.
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.hash('gc here only'), clock_timestamp() - interval '2 days')
	on conflict (profile_id, sha256) do update set unreferenced_since = excluded.unreferenced_since;
	if jsonb_array_length(public.qorpera_folder_claim_object_gc(100, v_lease) -> 'objects') <> 0 then
		raise exception 'A mixed company is never claimed'; end if;
	perform public.qorpera_folder_enable('63400000-0000-4000-8000-000000000022');
	if pg_temp.claimed(public.qorpera_folder_claim_object_gc(100, v_lease)) is distinct from array[pg_temp.hash('gc here only')] then
		raise exception 'All folder-v2 again, the company is claimed'; end if;
	-- A company being deleted is never claimed, and its quarantined files are removed.
	update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null;
	perform pg_temp.fx($f$insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
		values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001')$f$);
	r := public.qorpera_folder_claim_object_gc(100, v_lease);
	if jsonb_array_length(r -> 'objects') <> 0
		or public.qorpera_folder_gc_quarantine_state('63400000-0000-4000-8000-000000000010', pg_temp.hash('gc here only'), v_lease)
			<> 'remove' then
		raise exception 'A company being deleted is never claimed'; end if;
	delete from public.qorpera_company_deletions where profile_id = '63400000-0000-4000-8000-000000000010';
end $$;

-- 6. A folder-v2 catalog holds only folder objects (C1D §9.3) -----------------------------------------------------------
do $$
declare v_ref record; v_rows bigint;
begin
	-- No table outside the folder core references a folder-v2 company's catalog rows.
	for v_ref in select c.conrelid::regclass as tbl, a.attname as profile_col
		from pg_constraint c cross join lateral unnest(c.conkey, c.confkey) k(l, r)
		join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.l
		join pg_attribute b on b.attrelid = c.confrelid and b.attnum = k.r and b.attname = 'profile_id'
		where c.contype = 'f' and c.confrelid = 'public.qorpera_profile_objects'::regclass
			and c.conrelid not in ('public.qorpera_folder_file_chunks'::regclass, 'public.qorpera_folder_object_gc'::regclass,
				'public.qorpera_verified_company_file_objects'::regclass)
	loop
		execute format('select count(*) from %s where %I in (select profile_id from public.qorpera_company_files where core = ''folder-v2'')',
			v_ref.tbl, v_ref.profile_col) into v_rows;
		if v_rows <> 0 then raise exception '% references a folder-v2 company''s objects', v_ref.tbl; end if;
	end loop;
	-- Each other writer of a company's bytes refuses folder-v2 before it writes.
	perform pg_temp.raises($q$select public.qorpera_confirm_profile_object_upload('63400000-0000-4000-8000-000000000010', repeat('a', 64), 1,
		'nas-object-gateway')$q$, '0A000');
	-- The session-attachment route (a member's chat image) too.
	perform pg_temp.fx($f$insert into public.qorpera_member_session_attachment_uploads(id, profile_id, session_id, user_id, client_input_id,
		sha256, bytes, media_type) values ('63400000-0000-4000-8000-0000000007a1', '63400000-0000-4000-8000-000000000010',
		extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), repeat('b', 64), 1, 'image/png')$f$);
	perform pg_temp.raises($q$select public.qorpera_stage_member_session_attachment('63400000-0000-4000-8000-0000000007a1', false)$q$, '0A000');
end $$;

-- 7. The lock text and the grants ---------------------------------------------------------------------------------------
do $$
declare v_fn regprocedure; v_body text;
begin
	foreach v_fn in array array['public.qorpera_folder_sweep_upload_intents(integer)', 'public.qorpera_folder_claim_object_gc(integer,uuid)',
		'public.qorpera_folder_gc_unlink_begin(uuid,text,uuid)', 'public.qorpera_folder_gc_unlink_finish(uuid,text,uuid)',
		'public.qorpera_folder_gc_unlink_abandon(uuid,text,uuid)', 'public.qorpera_folder_gc_quarantine_state(uuid,text,uuid)']::regprocedure[] loop
		select prosrc into v_body from pg_proc where oid = v_fn;
		-- No company-wide lock: no fence, no company row, no company_files row, no job or run.
		if v_body ~* '(lock_profile_gc_fence|qorpera_folder_fences|qorpera_runner_jobs|qorpera_execution_runs|nowait)'
			or v_body ~* 'qorpera_profiles[^;]*for (update|share|no key update|key share)'
			or v_body ~* 'qorpera_company_files[^;]*for (update|share|no key update|key share)' then
			raise exception 'GC takes a lock it must not: %', v_fn; end if;
		if not (select proconfig @> array['lock_timeout=2s'] from pg_proc where oid = v_fn) then
			raise exception 'The lock budget of %', v_fn; end if;
	end loop;
	if position('for update of o, g skip locked' in (select prosrc from pg_proc where oid = 'public.qorpera_folder_claim_object_gc(integer,uuid)'::regprocedure)) = 0 then
		raise exception 'The claim skips locked rows, catalog and GC row'; end if;
	-- The patched references keep their budget.
	foreach v_fn in array array['public.qorpera_folder_open_upload(uuid,jsonb,text)', 'public.qorpera_folder_confirm_object(uuid,jsonb,uuid,text,bigint)',
		'public.qorpera_folder_seal_upload(uuid,jsonb,uuid)', 'public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)',
		'public.qorpera_folder_authorize_replication(uuid,text,bigint)', 'public.qorpera_folder_authorize_object_download(uuid,jsonb,text)']::regprocedure[] loop
		if not (select proconfig @> array['lock_timeout=2s'] from pg_proc where oid = v_fn) then
			raise exception 'A patched reference keeps its budget: %', v_fn; end if;
	end loop;
end $$;
set local role authenticated;
do $$
begin
	perform public.qorpera_folder_claim_object_gc(1, extensions.gen_random_uuid());
	raise exception 'Members cannot claim';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_folder_object_rooted(uuid,text,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_gc_company(uuid)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_gc_unlink_finish(uuid,text,uuid)', 'execute') then
		raise exception 'Only the GC entry points are the service role''s'; end if;
end $$;

rollback;
