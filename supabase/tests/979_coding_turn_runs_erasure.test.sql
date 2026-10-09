-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- W6a (migration 20260930250000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1; the W6 note of 9 Oct): P18
-- notes a coding session's turn runs, each that began before the erasure's newest cutoff, wherever it finds the session:
-- a version or conflict copy its view's commit wrote (phase 1), its view's change set, saved or not (phase 2), its
-- view's read record (phase 3, after the runs' read records, paging across steps), and a noted turn run's session (last
-- in phase 3). The controls: a read before the first erased version, a read of another path, a read after the cutoff,
-- a change set of another path, and turns that began after the request. A block-history request notes none. Sessions
-- b1..b9 are turn rows alone (their occurrences and turns written with triggers off): two ended turns each, and a view
-- each but b6's. On 803's company; rolled back
-- at the end.

create function pg_temp.w6_worker(p_n integer) returns uuid language sql as $$
	select format('97900000-0000-4000-8000-0000000000b%s', p_n)::uuid
$$;
-- Turn m's run of session n: ...nm ends in n0m.
create function pg_temp.w6_run(p_n integer, p_m integer) returns uuid language sql as $$
	select format('97900000-0000-4000-8000-000000000%s0%s', p_n, p_m)::uuid
$$;
-- Turn m of session n with the occurrence its begin made and the run the materializer gave it, as of now.
create function pg_temp.w6_turn(p_n integer, p_m integer, p_ended boolean) returns void language plpgsql as $$
declare v_occurrence uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
		trigger_id, occurrence_key, scheduled_for, not_before, status, run_id, created_at)
	values (v_occurrence, '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', 'agent', 'worker-dispatch',
		pg_temp.w6_worker(p_n), '70700000-0000-4000-8000-0000000000a1', 'worker-dispatch',
		'worker-dispatch:' || pg_temp.w6_worker(p_n)::text || ':' || p_m::text, clock_timestamp(), clock_timestamp(), 'materialized',
		pg_temp.w6_run(p_n, p_m), clock_timestamp());
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text, occurrence_id, outcome, settled_at)
	values (pg_temp.w6_worker(p_n), p_m, case when p_m = 1 then 'dispatch' else 'member' end, case when p_m > 1 then 'Go on.' end,
		v_occurrence, case when p_ended then '{"state":"succeeded"}'::jsonb end, case when p_ended then clock_timestamp() end);
	set local session_replication_role = origin;
end $$;
create function pg_temp.w6_view(p_n integer) returns uuid language sql as $$
	insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access, worker_id,
		attachment_token, pass_sha256, lease_until)
	values ('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010', 'coding_session',
		'70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000001', 'write', pg_temp.w6_worker(p_n),
		extensions.gen_random_uuid(), extensions.digest('w6', 'sha256'), clock_timestamp() + interval '1 minute')
	returning id
$$;
create function pg_temp.w6_view_of(p_n integer) returns uuid language sql as $$
	select id from public.qorpera_folder_views where worker_id = pg_temp.w6_worker(p_n) and state = 'open'
$$;
-- The change set as session n's view saved it (detached: no run).
create function pg_temp.w6_as_view(p_key text, p_n integer) returns void language plpgsql as $$
begin
	update public.qorpera_folder_commits set actor_kind = 'staff_agent', actor_id = '70700000-0000-4000-8000-0000000000a1',
		session_kind = 'coding', view_id = pg_temp.w6_view_of(p_n), view_kind = 'coding_session'
	where environment_id = '70700000-0000-4000-8000-000000000020' and operation_key = p_key;
	if not found then raise exception 'No change set %', p_key; end if;
end $$;
create function pg_temp.w6_commit(p_key text) returns public.qorpera_folder_commits language sql as $$
	select * from public.qorpera_folder_commits where environment_id = '70700000-0000-4000-8000-000000000020' and operation_key = p_key
$$;
create function pg_temp.w6_copies(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_conflict_copies where commit_id = (pg_temp.w6_commit(p_key)).id
$$;
-- Session n's view read the path, as of now.
create function pg_temp.w6_read(p_n integer, p_path text) returns void language sql as $$
	insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
	values (pg_temp.w6_view_of(p_n), extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', p_path)), repeat('0', 64))
$$;
-- A run read the path, as of now.
create function pg_temp.w6_run_read(p_run uuid, p_path text) returns void language sql as $$
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	values (p_run, extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', p_path)), repeat('0', 64))
$$;
-- The erasure's noted runs: nm for turn m of session n, any other run in full.
create function pg_temp.w6_noted(p_id uuid) returns text language sql as $$
	select coalesce(string_agg(case when run_id::text like '97900000-%' then right(run_id::text, 3) else run_id::text end, ','
		order by run_id), '')
	from public.qorpera_folder_erasure_runs where erasure_id = p_id
$$;
-- One step, as pg_cron's drain takes it, which must serve this erasure.
create function pg_temp.w6_step(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare r jsonb; v public.qorpera_folder_erasures%rowtype;
begin
	r := public.qorpera_folder_erasure_step(3, 3, 3);
	select * into v from public.qorpera_folder_erasures where id = p_id;
	if r ->> 'erasureId' is distinct from p_id::text or r ? 'error' or r ? 'contended' then
		raise exception 'The step served %, not %: % (%)', r, p_id, to_jsonb(v), v.last_error; end if;
	return v;
end $$;
-- Steps until the phase is done (or, with p_unsaved, until phase 2's saved change sets are), and the noted runs then.
create function pg_temp.w6_through(p_id uuid, p_phase integer, p_unsaved boolean default false) returns text language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for i in 1..200 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working' or v.phase > p_phase or (p_unsaved and v.cursor ? 'unsaved');
		v := pg_temp.w6_step(p_id);
	end loop;
	if v.state <> 'working' or v.phase <> case when p_unsaved then p_phase else p_phase + 1 end then
		raise exception 'Phase % did not end: %', p_phase, to_jsonb(v); end if;
	return pg_temp.w6_noted(p_id);
end $$;
-- W1a's request for a block cut at its path's newest delete, for an erase row.
create function pg_temp.w6_block(p_path text, p_id uuid) returns jsonb language sql as $$
	select public.qorpera_folder_erase_block_history('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000001',
		'memtree:' || encode(extensions.digest(convert_to('qorpera_memory_message_erases:' || p_id::text || ':'
			|| public.qorpera_folder_key(p_path), 'utf8'), 'sha256'), 'hex'),
		(select jsonb_build_object('path', p_path, 'cutoffSeq', c.seq, 'cutoffUnit', v.unit_no,
			'for', jsonb_build_object('table', 'qorpera_memory_message_erases', 'id', p_id))
		from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
		where v.environment_id = '70700000-0000-4000-8000-000000000020'
			and public.qorpera_folder_key(v.path) = public.qorpera_folder_key(p_path) and v.op = 'delete'
		order by c.seq desc, v.unit_no desc limit 1))
$$;

-- 0. Folder GC serves the company (so an erasure's bytes do not wait); the folder; sessions b1..b9 -------------------------

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-dir', jsonb_build_array(pg_temp.mkdir('w6'))), 1, 'saved');
	for n in 1..9 loop
		perform pg_temp.w6_turn(n, 1, true);
		perform pg_temp.w6_turn(n, 2, true);
		if n <> 6 then perform pg_temp.w6_view(n); end if;
	end loop;
end $$;

-- 1. A member's erasure of w6/a.md notes each session that touched it before the request, phase by phase -------------------

do $$
declare r jsonb; e uuid; v public.qorpera_folder_erasures%rowtype;
begin
	-- b8 read the path before its first erased version: outside the reads' window.
	perform pg_temp.w6_read(8, 'w6/a.md');
	-- b1's view wrote the version (phase 1); b8's wrote another path (no phase notes it).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-k1', jsonb_build_array(pg_temp.put('w6/a.md', 'w6 a one'))), 1, 'saved');
	perform pg_temp.w6_as_view('w6-k1', 1);
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-k0', jsonb_build_array(pg_temp.put('w6/other.md', 'w6 other'))), 1,
		'saved');
	perform pg_temp.w6_as_view('w6-k0', 8);
	-- b6's first turn's run read the path (phase 3's runs); b7's view read another path twice (phase 3's views, step 1).
	perform pg_temp.w6_run_read(pg_temp.w6_run(6, 1), 'w6/a.md');
	perform pg_temp.w6_read(7, 'w6/other.md');
	perform pg_temp.w6_read(7, 'w6/other.md');
	-- b2's view wrote a stale version: a conflict copy, in a change set that saved nothing (phase 1's copies).
	r := pg_temp.commit(pg_temp.owner(), 'w6-k2', jsonb_build_array(pg_temp.put('w6/a.md', 'w6 a stale')
		|| jsonb_build_object('expectedVersion', extensions.gen_random_uuid())));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (pg_temp.w6_commit('w6-k2')).seq is not null or pg_temp.w6_copies('w6-k2') <> 1 then
		raise exception 'Fixture: an unsaved change set with a copy: %', r; end if;
	perform pg_temp.w6_as_view('w6-k2', 2);
	-- b5's view read the path, after b7's reads (phase 3's views, step 2).
	perform pg_temp.w6_read(5, 'w6/a.md');
	-- b3's view saved a change set whose delete of the path conflicted (phase 2's saved change sets); b4's saved nothing
	-- (phase 2's unsaved ones). Neither keeps a copy.
	r := pg_temp.commit(pg_temp.owner(), 'w6-k3', jsonb_build_array(pg_temp.put('w6/c3.md', 'w6 c3'),
		jsonb_build_object('op', 'delete', 'path', 'w6/a.md', 'expectedVersion', extensions.gen_random_uuid(), 'asOfSeq', pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'conflict', 'version_changed');
	if (pg_temp.w6_commit('w6-k3')).seq is null or pg_temp.w6_copies('w6-k3') <> 0 then
		raise exception 'Fixture: a saved change set without a copy: %', r; end if;
	perform pg_temp.w6_as_view('w6-k3', 3);
	r := pg_temp.commit(pg_temp.owner(), 'w6-k4', jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'w6/a.md',
		'expectedVersion', extensions.gen_random_uuid(), 'asOfSeq', pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (pg_temp.w6_commit('w6-k4')).seq is not null or pg_temp.w6_copies('w6-k4') <> 0 then
		raise exception 'Fixture: an unsaved change set without a copy: %', r; end if;
	perform pg_temp.w6_as_view('w6-k4', 4);
	-- The owner deletes it, and erases it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-k5', jsonb_build_array(pg_temp.del('w6/a.md'))), 1, 'saved');
	r := pg_temp.erase(array['w6/a.md'], 'w6-erase-a');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '2', 'the write and the delete');
	e := (r ->> 'erasureId')::uuid;
	-- After the request: each session's third turn (it began after the cutoff), and b7's read of the path.
	for n in 1..9 loop perform pg_temp.w6_turn(n, 3, false); end loop;
	perform pg_temp.w6_read(7, 'w6/a.md');

	perform pg_temp.is(pg_temp.w6_through(e, 1), '101,102,201,202', 'phase 1: the version''s session and the copy''s');
	perform pg_temp.is(pg_temp.w6_through(e, 2, true), '101,102,201,202,301,302', 'phase 2''s saved change sets: b3''s');
	perform pg_temp.is(pg_temp.w6_through(e, 2), '101,102,201,202,301,302,401,402', 'phase 2''s unsaved change sets: b4''s');
	-- Phase 3, step 1: the runs' one read record (b6's turn run alone), then two of the views' three (b7's, of another path).
	v := pg_temp.w6_step(e);
	if v.phase <> 3 or not v.cursor ? 'views' then raise exception 'Phase 3 pages into its views: %', to_jsonb(v); end if;
	perform pg_temp.is(pg_temp.w6_noted(e), '101,102,201,202,301,302,401,402,601',
		'phase 3, step 1: the run that read it; the expansion waits for the views');
	-- Step 2: b5's read, then b6's other turn run through the noted 601.
	v := pg_temp.w6_step(e);
	perform pg_temp.is(v.phase::text, '4', 'phase 3 is done');
	perform pg_temp.is(pg_temp.w6_noted(e), '101,102,201,202,301,302,401,402,501,502,601,602',
		'phase 3, step 2: b5''s read, then b6''s session');
	-- The fake runs never end: the erasure waits for them, and notes nothing more.
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	v := pg_temp.drain(e);
	perform pg_temp.is(v.state || v.phase, 'waiting7', 'waiting for its runs');
	perform pg_temp.is(pg_temp.w6_noted(e), '101,102,201,202,301,302,401,402,501,502,601,602', 'the same runs');
	if exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = e and state <> 'pending') then
		raise exception 'Every noted run is pending'; end if;
	perform pg_temp.is(pg_temp.versions_at('w6/a.md')::text, '0', 'its versions are gone');
end $$;

-- 2. A block-history request notes no session --------------------------------------------------------------------------------

do $$
declare r jsonb; b uuid; v public.qorpera_folder_erasures%rowtype;
begin
	-- b9's view wrote w6/b.md and read it; its first turn's run read it too.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-b-1', jsonb_build_array(pg_temp.put('w6/b.md', 'w6 b one'))), 1, 'saved');
	perform pg_temp.w6_as_view('w6-b-1', 9);
	perform pg_temp.w6_read(9, 'w6/b.md');
	perform pg_temp.w6_run_read(pg_temp.w6_run(9, 1), 'w6/b.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w6-b-2', jsonb_build_array(pg_temp.del('w6/b.md'))), 1, 'saved');
	r := pg_temp.w6_block('w6/b.md', '97900000-0000-4000-8000-0000000000f1');
	perform pg_temp.is(r ->> 'kind' || (r -> 'roots' -> 0 ->> 'versions'), 'block-history1', 'the write before the delete');
	b := (r ->> 'erasureId')::uuid;
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	for i in 1..120 loop
		v := pg_temp.w6_step(b);
		perform pg_temp.is(pg_temp.w6_noted(b), '', format('nothing noted (step %s, phase %s)', i, v.phase));
		exit when v.state <> 'working';
	end loop;
	perform pg_temp.is(v.state, 'done', 'the block-history request is done');
	perform pg_temp.is(pg_temp.versions_at('w6/b.md')::text, '1', 'the delete stays');
end $$;

rollback;
