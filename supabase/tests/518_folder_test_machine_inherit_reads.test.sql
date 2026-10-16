-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- A test machine's output takes in its reads (20260930498000; F3 step 6, slice 6d-3b: deploy/first-node/
-- RUNTIME-FOLDER-TEST-MACHINES.md "Reads", rules 3 and 5). Before what a command on the machine printed reaches a run, the
-- machine executor has that run take in the reads of the placement's newest view, on the boot it read the output on. A
-- read the run can no longer read comes back with the detail the executor retires the placement on. The machine,
-- placement, run and view helpers are 510's, 639's and 632's; the release is 514's.

-- 514's: the view reads the path and releases it.
create function pg_temp.release(p_view jsonb, p_path text) returns jsonb language plpgsql as $$
declare e jsonb := pg_temp.read(p_path, pg_temp.vactor(p_view)) -> 'entry';
begin
	return public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view),
		extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version',
		'authority', e -> 'authority')), repeat('6', 64));
end $$;
-- Whether the run's records hold the path under the inherit id.
create function pg_temp.run_has(p_run jsonb, p_inherit uuid, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.run_id = (p_run ->> 'runId')::uuid and rec.release_id = p_inherit and x ->> 'path' = p_path)
$$;
-- The executor's call for the anchor's boot and the run.
create function pg_temp.take(p_anchor jsonb, p_run jsonb, p_inherit uuid) returns jsonb language sql as $$
	select public.qorpera_folder_test_machine_inherit_reads((p_anchor ->> 'placementId')::uuid, (p_anchor ->> 'bootId')::uuid,
		(p_run ->> 'runId')::uuid, p_inherit)
$$;
create function pg_temp.take_refused(p_anchor jsonb, p_run jsonb, p_inherit uuid, p_state text, p_message text,
	p_detail text default null) returns void language sql as $$
	select pg_temp.refused(format('select pg_temp.take(%L, %L, %L)', p_anchor, p_run, p_inherit), p_state, p_message, p_detail)
$$;
create function pg_temp.expect_take(p_result jsonb, p_inherit uuid, p_view jsonb, p_reads integer, p_replay boolean)
returns void language plpgsql as $$
begin
	if p_result is distinct from jsonb_build_object('schema', 'qorpera.folder-inherit/v1', 'inheritId', p_inherit,
		'viewId', p_view ->> 'viewId', 'reads', p_reads, 'replay', p_replay) then
		raise exception 'Expected % reads for % from view % (replay %), got %', p_reads, p_inherit, p_view ->> 'viewId', p_replay,
			p_result; end if;
end $$;


-- The platform's alone: a security definer with an empty search path, not owned by an API role, that no API role but
-- the service may run, and that refuses any other caller's claims.
do $$
declare f constant text := 'public.qorpera_folder_test_machine_inherit_reads(uuid,uuid,uuid,uuid)'; r name; p pg_proc%rowtype;
begin
	select * into p from pg_proc where oid = f::regprocedure;
	if not p.prosecdef or p.proconfig is distinct from array['search_path=""']
		or pg_get_userbyid(p.proowner) in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'The wrapper is a security definer with an empty search path and no API owner'; end if;
	foreach r in array array['public', 'anon', 'authenticated', 'qorpera_secret_broker']::name[] loop
		if has_function_privilege(r, f, 'EXECUTE') then raise exception '% may run the wrapper', r; end if;
	end loop;
	if not has_function_privilege('service_role', f, 'EXECUTE') then raise exception 'The service runs the wrapper'; end if;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.refused(format('select public.qorpera_folder_test_machine_inherit_reads(%L, %L, %L, %L)', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid()), '42501', 'Folder core authority is required');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- The take-in copies only what is new (part 2): its body carries the marker on top of the earlier patches, and the
-- marks are the platform's alone.
do $$
declare d constant text := pg_get_functiondef('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure);
	t constant text := 'public.qorpera_folder_run_inherited_records'; r name;
begin
	if strpos(d, '20260930498000') = 0 or strpos(d, '20260930446000') = 0 or strpos(d, '20260930480000') = 0 then
		raise exception 'The take-in carries 20260930498000 on top of the earlier patches'; end if;
	if not (select relrowsecurity from pg_class where oid = t::regclass) then
		raise exception 'The marks have row level security'; end if;
	foreach r in array array['public', 'anon', 'authenticated', 'service_role']::name[] loop
		if has_table_privilege(r, t, 'select,insert,update,delete') then raise exception '% reaches the marks', r; end if;
	end loop;
end $$;

-- Setup: tmi/ with two files, which the machines read.
do $$
declare a jsonb := pg_temp.stage('test machine inherit');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tmi-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','tmi'),
		jsonb_build_object('op','write','path','tmi/a.txt','file',a), jsonb_build_object('op','write','path','tmi/b.txt','file',a))), 3, 'saved');
end $$;


-- A run of another member takes in what the machine's view read; the same inherit id replays, and a new one checks
-- the whole set but copies only what the view read since (nothing, when nothing is new). After a reboot the newest
-- view counts: the earlier boot's until the new boot opens its own, which carries the disk's reads as its own records,
-- so the run copies them once more. Agent B's run takes them in too. A placement that never had a view answers with
-- no view and no reads.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	v jsonb := pg_temp.run('human', c_m2); w jsonb := pg_temp.run('human', c_m4); vb jsonb := pg_temp.agent_b(c_m4);
	m uuid := pg_temp.machine(v, 'inherit-take-in'); a jsonb := pg_temp.place(m); a2 jsonb; s jsonb; s2 jsonb;
	k uuid := extensions.gen_random_uuid(); k2 uuid := extensions.gen_random_uuid(); k3 uuid := extensions.gen_random_uuid();
	k4 uuid := extensions.gen_random_uuid(); kb uuid := extensions.gen_random_uuid(); n uuid := extensions.gen_random_uuid();
	e jsonb;
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'tmi/a.txt');
	perform pg_temp.expect_take(pg_temp.take(a, w, k), k, s, 1, false);
	if not pg_temp.run_has(w, k, 'tmi/a.txt') or not exists (select 1 from public.qorpera_folder_run_reads where run_id = (w ->> 'runId')::uuid)
		or not exists (select 1 from public.qorpera_folder_run_inheritances i
			where i.run_id = (w ->> 'runId')::uuid and i.inherit_id = k and i.view_id = (s ->> 'viewId')::uuid) then
		raise exception 'The run takes in the read set and the records'; end if;
	perform pg_temp.expect_take(pg_temp.take(a, w, k), k, s, 1, true);
	perform pg_temp.release(s, 'tmi/b.txt');
	perform pg_temp.expect_take(pg_temp.take(a, w, k2), k2, s, 2, false);
	if not pg_temp.run_has(w, k2, 'tmi/b.txt') or pg_temp.run_has(w, k2, 'tmi/a.txt') then
		raise exception 'A new inherit id copies only what the view read since'; end if;
	if (select jsonb_agg(i.inherit_id order by i.created_at) from public.qorpera_folder_run_inherited_records i
			where i.run_id = (w ->> 'runId')::uuid and i.view_id = (s ->> 'viewId')::uuid)
		is distinct from jsonb_build_array(k, k2) then
		raise exception 'Each of the view''s records is marked once, with the inherit id that filed it'; end if;
	-- The disk boots again: the earlier boot is not current, and its view is the newest until the new boot opens one.
	a2 := pg_temp.reboot(a);
	perform pg_temp.take_refused(a, w, extensions.gen_random_uuid(), '42501', 'Folder inheritance read is not current');
	perform pg_temp.expect_take(pg_temp.take(a2, w, k3), k3, s, 2, false);
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id = (w ->> 'runId')::uuid and release_id = k3) then
		raise exception 'A take-in with nothing new copies nothing'; end if;
	s2 := pg_temp.open_machine(a2);
	perform pg_temp.expect_take(pg_temp.take(a2, w, k4), k4, s2, 2, false);
	if not pg_temp.run_has(w, k4, 'tmi/a.txt') or not pg_temp.run_has(w, k4, 'tmi/b.txt') then
		raise exception 'The new boot''s view carries the disk''s reads'; end if;
	perform pg_temp.expect_take(pg_temp.take(a2, vb, kb), kb, s2, 2, false);
	if not pg_temp.run_has(vb, kb, 'tmi/a.txt') then raise exception 'Agent B''s run takes in the machine''s reads'; end if;
	-- A new disk with no view yet: nothing to take in, and nothing written.
	e := pg_temp.take(pg_temp.place(m), w, n);
	if e is distinct from jsonb_build_object('schema', 'qorpera.folder-inherit/v1', 'inheritId', n, 'viewId', null, 'reads', 0,
			'replay', false)
		or exists (select 1 from public.qorpera_folder_run_read_records where release_id = n)
		or exists (select 1 from public.qorpera_folder_run_inheritances where inherit_id = n) then
		raise exception 'A placement without a view: %', e; end if;
end $$;


-- Refusals. Invalid: a missing id. Not current: an unknown placement, another boot, a retired or removed placement.
-- The run: unknown, its job's lease lapsed, in another environment. The take-in's own: a run without the company-wide
-- view, the pause (an inherit id already taken in replays), and a read the run can no longer read, which carries the
-- executor's detail (an inherit id already taken in replays).
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	c_profile constant uuid := '63200000-0000-4000-8000-000000000010';
	v jsonb := pg_temp.run('human', c_m2); w jsonb := pg_temp.run('human', c_m4); x jsonb := pg_temp.run('human', c_m4);
	m uuid := pg_temp.machine(v, 'inherit-refusals'); a jsonb := pg_temp.place(m); s jsonb; a3 jsonb;
	k uuid := extensions.gen_random_uuid();
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'tmi/a.txt');
	perform pg_temp.take_refused(a - 'placementId', w, k, '22023', 'Folder inheritance is invalid');
	perform pg_temp.take_refused(a - 'bootId', w, k, '22023', 'Folder inheritance is invalid');
	perform pg_temp.take_refused(a, '{}', k, '22023', 'Folder inheritance is invalid');
	perform pg_temp.take_refused(a, w, null, '22023', 'Folder inheritance is invalid');
	perform pg_temp.take_refused(a || jsonb_build_object('placementId', extensions.gen_random_uuid()), w, k, '42501',
		'Folder inheritance read is not current');
	perform pg_temp.take_refused(a || jsonb_build_object('bootId', extensions.gen_random_uuid()), w, k, '42501',
		'Folder inheritance read is not current');
	perform pg_temp.take_refused(a, jsonb_build_object('runId', extensions.gen_random_uuid()), k, '42501', 'Run is unavailable');
	perform pg_temp.lapse(x);
	perform pg_temp.take_refused(a, x, k, '42501', 'Run is unavailable');
	x := pg_temp.run('human', c_m4);
	perform pg_temp.fx(format('update public.qorpera_execution_runs set environment_id = %L where id = %L',
		'63200000-0000-4000-8000-000000000021', x ->> 'runId'));
	perform pg_temp.take_refused(a, x, k, '42501', 'Run is unavailable');
	perform pg_temp.take_refused(a, pg_temp.run('human', c_m4, 'member_private'), k, '42501',
		'A run inherits a test machine''s reads only with the company-wide view');
	perform pg_temp.expect_take(pg_temp.take(a, w, k), k, s, 1, false);
	-- The pause refuses a new inherit id; one already taken in replays.
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63200000-0000-4000-8000-000000000001', 'test'));
	perform pg_temp.take_refused(a, w, extensions.gen_random_uuid(), '55000', 'Company execution is paused');
	perform pg_temp.expect_take(pg_temp.take(a, w, k), k, s, 1, true);
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
	-- tmi/ narrows to a resource agent A holds no grant on: the run can no longer read what the machine read. The run
	-- took that read in with k, so nothing is new, and the whole set is still checked.
	begin
		perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'tmi', 'subtree',
			'company_shared', 'normal');
		perform pg_temp.take_refused(a, w, extensions.gen_random_uuid(), '42501', 'A released read is no longer readable',
			'qorpera.test-machine/unreadable');
		perform pg_temp.expect_take(pg_temp.take(a, w, k), k, s, 1, true);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- A removed placement, and a retired one (a new disk).
	perform pg_temp.fx(format('update public.qorpera_company_machine_placements set removing_at = clock_timestamp(),
		removed_at = clock_timestamp() where id = %L', a ->> 'placementId'));
	perform pg_temp.take_refused(a, w, extensions.gen_random_uuid(), '42501', 'Folder inheritance read is not current');
	perform pg_temp.fx(format('update public.qorpera_company_machine_placements set removing_at = null, removed_at = null where id = %L',
		a ->> 'placementId'));
	a3 := pg_temp.place(m);
	perform pg_temp.take_refused(a, w, extensions.gen_random_uuid(), '42501', 'Folder inheritance read is not current');
	if pg_temp.take(a3, w, extensions.gen_random_uuid()) ->> 'viewId' is not null then
		raise exception 'The new disk is current and has no view yet'; end if;
end $$;
