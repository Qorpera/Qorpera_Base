-- @fixture 803_folder_state_human_task_index.test.sql until "-- 2. A new task: open, due in the future"
-- Company folder core, P18a (migration 20260930009200; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md): permanent
-- erasure of deleted paths. The request's refusals; a deleted contact erased with its index row, its versions, its
-- path in change sets, and its bytes once folder GC serves the company; a live path keeping its current life (a reused
-- path, a case-only rename, a delete and re-create in one change set); histories through moves; the units scrub; the
-- grants and the lock text. On 803's company (contacts, human tasks); rolled back at the end. Races are in 884.

create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','70700000-0000-4000-8000-00000000000' || p_n)
$$;
create function pg_temp.erase(p_paths text[], p_key text, p_actor jsonb default null) returns jsonb language sql as $$
	select public.qorpera_folder_erase('70700000-0000-4000-8000-000000000020', coalesce(p_actor, pg_temp.owner()),
		to_jsonb(p_paths), p_key)
$$;
-- Steps until this erasure is done or waiting, as pg_cron would (one step a tick).
create function pg_temp.drain(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for i in 1..60 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step(3, 3, 3);
	end loop;
	select * into v from public.qorpera_folder_erasures where id = p_id;
	return v;
end $$;
create function pg_temp.versions_at(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_path_versions where environment_id = '70700000-0000-4000-8000-000000000020'
		and public.qorpera_folder_key(path) = p_key
$$;
-- The SQLSTATE a statement fails with ('ok' when it does not), its changes undone.
create function pg_temp.fails(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
	begin
		execute p_sql;
		raise exception using errcode = 'P0883';
	exception when sqlstate 'P0883' then return 'ok';
	when others then get stacked diagnostics v_state = returned_sqlstate; return v_state;
	end;
end $$;
create function pg_temp.detail(p_sql text) returns jsonb language plpgsql as $$
declare v_detail text;
begin
	begin
		execute p_sql;
	exception when others then get stacked diagnostics v_detail = pg_exception_detail; return v_detail::jsonb;
	end;
	raise exception 'Expected a refusal: %', p_sql;
end $$;
create function pg_temp.mv(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','move','from',p_from,'to',p_to,'expectedVersion',pg_temp.version(public.qorpera_folder_key(p_from)),
		'asOfSeq',pg_temp.seq())
$$;

-- 1. Refusals before anything changes -----------------------------------------------------------------------------------

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts/no-mail.md'], 'erase-0001')$q$), '42501',
		'only the service role asks');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts/no-mail.md'], 'erase-0002', '{"kind":"platform"}')$q$),
		'22023', 'only a member erases');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts/no-mail.md'], 'erase-0003', pg_temp.member(2))$q$),
		'42501', 'a contributor does not erase');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['agents/nora'], 'erase-0004')$q$), '0A000',
		'agents/ waits for P18b');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['rules/x.md'], 'erase-0005')$q$), '0A000', 'rules/ too');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts', 'contacts/no-mail.md'], 'erase-0006')$q$),
		'22023', 'a root inside another');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['members/70700000-0000-4000-8000-000000000002/private'], 'erase-0007')$q$),
		'42501', 'another member''s private paths');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts/maria.md'], 'erase-0008')$q$), '22023',
		'a live root with no earlier life has nothing to erase');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['contacts/no-mail.md'], 'bad key')$q$), '22023',
		'the operation key');
	if exists (select 1 from public.qorpera_folder_erasures) then raise exception 'A refusal recorded an erasure'; end if;
end $$;

-- 2. A deleted contact ------------------------------------------------------------------------------------------------

do $$
declare r jsonb; v_manifest text; v_erasure public.qorpera_folder_erasures%rowtype; v_units jsonb; v_id uuid;
begin
	select manifest_sha256 into v_manifest from public.qorpera_folder_entries
	where environment_id = '70700000-0000-4000-8000-000000000020' and key_text = 'contacts/no-mail.md';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-del-no-mail', jsonb_build_array(pg_temp.del('contacts/no-mail.md'))),
		1, 'saved');
	if not exists (select 1 from public.qorpera_folder_contact_index where environment_id = '70700000-0000-4000-8000-000000000020'
			and folder_key = 'contacts/no-mail.md' and retired_at is not null) then
		raise exception 'Fixture: the contact row is retired'; end if;
	r := pg_temp.erase(array['contacts/no-mail.md'], 'erase-no-mail-1');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '2', 'the write and the delete are counted');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'path', 'contacts/no-mail.md', 'the root as named');
	-- The index row goes with the request; the claim does not outlive it.
	if exists (select 1 from public.qorpera_folder_contact_index where environment_id = '70700000-0000-4000-8000-000000000020'
			and folder_key = 'contacts/no-mail.md') then raise exception 'The contact row is deleted by the request'; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020'
			and kind = 'claim') then raise exception 'No claim outlives the request'; end if;
	-- A replay answers the same; the same key for other paths is refused.
	if pg_temp.erase(array['contacts/no-mail.md'], 'erase-no-mail-1') is distinct from r then raise exception 'A replay answers the same'; end if;
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['docs/other.md'], 'erase-no-mail-1')$q$), '22023',
		'a key reused for other paths');
	v_id := (r ->> 'erasureId')::uuid;
	v_erasure := pg_temp.drain(v_id);
	perform pg_temp.is(pg_temp.versions_at('contacts/no-mail.md')::text, '0', 'its versions are gone');
	-- Its path is gone from the change set that saved it, which keeps the parser's shape.
	select units into v_units from public.qorpera_folder_commits
	where environment_id = '70700000-0000-4000-8000-000000000020' and operation_key = 'human-roots';
	perform pg_temp.is(v_units -> 5 ->> 'path', '', 'the saving unit''s path is blank');
	perform pg_temp.is(v_units -> 5 ->> 'outcome', 'saved', 'its outcome stays');
	if v_units -> 5 ? 'problems' or exists (select 1 from jsonb_array_elements(v_units) u, jsonb_object_keys(u) k
			where k not in ('unit','op','path','to','version','outcome','reason','problems')) then
		raise exception 'Units keep the parser''s keys: %', v_units; end if;
	if exists (select 1 from public.qorpera_folder_commits c where c.environment_id = '70700000-0000-4000-8000-000000000020'
			and c.units::text like '%contacts/no-mail.md%') then raise exception 'No change set names the path'; end if;
	-- The company has a snapshot-v1 environment beside its folder-v2 one: folder GC does not serve it yet, so the bytes wait.
	perform pg_temp.is(v_erasure.state, 'waiting', 'the erasure waits for its bytes');
	if not v_erasure.bytes_pending or (v_erasure.counts ->> 'versions')::integer <> 2 then
		raise exception 'Bytes pending and the counts: %', v_erasure; end if;
	if exists (select 1 from public.qorpera_folder_object_gc where profile_id = '70700000-0000-4000-8000-000000000010') then
		raise exception 'No side row while GC does not serve the company'; end if;
	-- Once folder GC serves it, the revisit enqueues the bytes nothing roots, and the erasure is done. The fixture's
	-- upload intents (which root their objects for a day after they end) are made older than that first.
	perform public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	update public.qorpera_folder_erasures set revisit_at = clock_timestamp() - interval '1 second' where id = v_id;
	perform public.qorpera_folder_erasure_step();
	select * into v_erasure from public.qorpera_folder_erasures where id = v_id;
	perform pg_temp.is(v_erasure.state, 'done', 'done once its bytes are enqueued');
	if v_erasure.roots is not null or v_erasure.request_sha256 is not null or v_erasure.reply ? 'roots'
		or exists (select 1 from public.qorpera_folder_erasure_needles where erasure_id = v_id) then
		raise exception 'A done erasure keeps no path: %', v_erasure; end if;
	if not exists (select 1 from public.qorpera_folder_object_gc where profile_id = '70700000-0000-4000-8000-000000000010'
			and sha256 = v_manifest and unreferenced_since > clock_timestamp() - interval '1 minute') then
		raise exception 'The contact''s manifest lost its roots and waits for GC'; end if;
	-- A replay after done answers the stored outcome.
	if (pg_temp.erase(array['contacts/no-mail.md'], 'erase-no-mail-1') ->> 'erasureId')::uuid <> v_id then
		raise exception 'A replay after done'; end if;
end $$;

-- 3. Lives at a path ----------------------------------------------------------------------------------------------------

do $$
declare r jsonb; v_live uuid;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-docs', jsonb_build_array(pg_temp.mkdir('docs'))), 1, 'saved');
	-- A path reused by another file: the earlier life goes, the current one stays.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-a-1', jsonb_build_array(pg_temp.put('docs/a.md', 'first life'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-a-2', jsonb_build_array(pg_temp.del('docs/a.md'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-a-3', jsonb_build_array(pg_temp.put('docs/a.md', 'second life'))), 1, 'saved');
	v_live := pg_temp.version('docs/a.md');
	r := pg_temp.erase(array['docs/a.md'], 'erase-a-live');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '2', 'the earlier life''s write and delete');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('docs/a.md')::text, '1', 'the current life''s version stays');
	if not exists (select 1 from public.qorpera_folder_path_versions where version = v_live) then
		raise exception 'The entry''s current version stays'; end if;
	if (select units -> 0 ->> 'path' from public.qorpera_folder_commits where operation_key = 'erase-a-3') <> 'docs/a.md'
		or (select units -> 0 ->> 'path' from public.qorpera_folder_commits where operation_key = 'erase-a-1') <> '' then
		raise exception 'Only the earlier life''s change sets lose the path'; end if;
	-- A case-only rename continues a life: nothing is earlier than it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-case-1', jsonb_build_array(pg_temp.put('docs/Case.md', 'case'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-case-2', jsonb_build_array(pg_temp.mv('docs/Case.md', 'docs/case.md'))),
		1, 'saved');
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['docs/case.md'], 'erase-case-x')$q$), '22023',
		'a case-renamed live file has nothing to erase');
	perform pg_temp.is(pg_temp.versions_at('docs/case.md')::text, '3', 'and keeps its history');
	-- A delete and a re-create in one change set split at the re-create's unit.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-z-1', jsonb_build_array(pg_temp.put('docs/z.md', 'z one'))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'erase-z-2', jsonb_build_array(pg_temp.del('docs/z.md'),
		jsonb_build_object('op','write','path','docs/z.md','file',pg_temp.stage('z two'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.erase(array['docs/z.md'], 'erase-z-live');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '2', 'the write and the delete before the re-create');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('docs/z.md')::text, '1', 'the re-create stays');
	perform pg_temp.is((select units -> 1 ->> 'path' from public.qorpera_folder_commits where operation_key = 'erase-z-2'), 'docs/z.md',
		'the re-create''s unit keeps its path');
	perform pg_temp.is((select units -> 0 ->> 'path' from public.qorpera_folder_commits where operation_key = 'erase-z-2'), '',
		'the delete''s unit in the same change set loses it');
end $$;

-- 4. Histories through moves --------------------------------------------------------------------------------------------

do $$
declare r jsonb; d jsonb;
begin
	-- A renamed-then-deleted file: the old name is part of its history.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-lead-1', jsonb_build_array(pg_temp.put('docs/lead.md', 'a lead'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-lead-2', jsonb_build_array(pg_temp.mv('docs/lead.md', 'docs/carla.md'))),
		1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-lead-3', jsonb_build_array(pg_temp.del('docs/carla.md'))), 1, 'saved');
	d := pg_temp.detail($q$select pg_temp.erase(array['docs/carla.md'], 'erase-carla-1')$q$);
	if d -> 'add' <> '["docs/lead.md"]'::jsonb or d -> 'live' <> '[]'::jsonb then raise exception 'Name the old path: %', d; end if;
	r := pg_temp.erase(array['docs/carla.md', 'docs/lead.md'], 'erase-carla-2');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('docs/carla.md') + pg_temp.versions_at('docs/lead.md') <> 0 then raise exception 'The whole history goes'; end if;
	-- A file moved on to a live path was moved, not deleted.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-x-1', jsonb_build_array(pg_temp.put('docs/x.md', 'x'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-x-2', jsonb_build_array(pg_temp.mv('docs/x.md', 'docs/y.md'))), 1, 'saved');
	d := pg_temp.detail($q$select pg_temp.erase(array['docs/x.md'], 'erase-x-3')$q$);
	if d -> 'live' <> '["docs/y.md"]'::jsonb then raise exception 'The live continuation is named: %', d; end if;
	-- A deleted folder: every key under it, files deleted before the folder included.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-f-1', jsonb_build_array(pg_temp.mkdir('docs/f'),
		pg_temp.put('docs/f/one.md', 'one'), pg_temp.put('docs/f/two.md', 'two'))), 3, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-f-2', jsonb_build_array(pg_temp.del('docs/f/one.md'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-f-3', jsonb_build_array(pg_temp.del('docs/f'))), 1, 'saved');
	r := pg_temp.erase(array['docs/f'], 'erase-f-4');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '6', 'mkdir, two writes, the file''s delete and the subtree delete''s two rows');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('docs/f') + pg_temp.versions_at('docs/f/one.md') + pg_temp.versions_at('docs/f/two.md') <> 0 then
		raise exception 'The subtree''s history goes'; end if;
end $$;

-- 5. The units scrub, directly ------------------------------------------------------------------------------------------

do $$
declare v_roots jsonb := '[{"key":"contacts/maria.md","cutoffSeq":10,"cutoffUnit":2147483647,"cutoffAt":"2026-10-03T00:00:00Z"}]';
	v_needles jsonb := '[{"needle":"contacts/Maria.md","cutoffSeq":10,"cutoffUnit":2147483647,"cutoffAt":"2026-10-03T00:00:00Z"}]';
	v_units jsonb := '[{"unit":1,"op":"write","path":"contacts/Maria.md","outcome":"refused","reason":"structured_rule",
		"problems":[{"line":3,"key":"email","code":"invalid","message":"put \"x\" in double quotes"}]},
		{"unit":2,"op":"write","path":"contacts/other.md","outcome":"refused","reason":"structured_rule",
		"problems":[{"line":null,"key":"id","code":"taken","message":"this contact already has the file contacts/Maria.md"},
			{"line":null,"key":"name","code":"x","message":"unrelated"},
			{"line":null,"key":"near","code":"x","message":"see contacts/Maria for more"}]},
		{"unit":3,"op":"move","path":"docs/q.md","to":"contacts/maria.md","outcome":"saved","version":"11111111-1111-4111-8111-111111111111"}]';
	v_out jsonb;
begin
	v_out := public.qorpera_folder_erasure_units(v_units, 9, now(), v_roots, v_needles);
	if v_out -> 0 <> '{"unit":1,"op":"write","path":"","outcome":"refused","reason":"structured_rule"}'::jsonb then
		raise exception 'A unit under the root loses its path and problems: %', v_out -> 0; end if;
	if v_out -> 1 -> 'problems' -> 0 ->> 'message' <> '' or v_out -> 1 -> 'problems' -> 1 ->> 'message' <> 'unrelated'
		or v_out -> 1 -> 'problems' -> 2 ->> 'message' <> 'see contacts/Maria for more' or v_out -> 1 ->> 'path' <> 'contacts/other.md' then
		raise exception 'Another unit''s quoting message is blanked, nothing else (a stem alone never): %', v_out -> 1; end if;
	if v_out -> 2 ->> 'to' <> '' or v_out -> 2 ->> 'path' <> 'docs/q.md' then raise exception 'A target under the root: %', v_out -> 2; end if;
	-- After the cutoff (a later life), nothing changes; an unsaved change set goes by time.
	if public.qorpera_folder_erasure_units(v_units, 11, now(), v_roots, v_needles) is not null then
		raise exception 'A change set after the cutoff keeps its units'; end if;
	if public.qorpera_folder_erasure_units(v_units, null, '2026-10-04T00:00:00Z', v_roots, v_needles) is not null
		or public.qorpera_folder_erasure_units(v_units, null, '2026-10-02T00:00:00Z', v_roots, v_needles) is null then
		raise exception 'Unsaved change sets go by the cutoff''s time'; end if;
end $$;

-- 6. Status, grants and the lock text -----------------------------------------------------------------------------------

do $$
declare v_id uuid := (select id from public.qorpera_folder_erasures where operation_key = 'erase-f-4'); v_fn regprocedure; v_body text;
begin
	if public.qorpera_folder_erasure_status('70700000-0000-4000-8000-000000000020', pg_temp.owner(), v_id) ->> 'erasureId'
			is distinct from v_id::text then
		raise exception 'An owner reads the status'; end if;
	perform pg_temp.is(pg_temp.fails(format($q$select public.qorpera_folder_erasure_status('70700000-0000-4000-8000-000000000020',
		pg_temp.member(2), %L)$q$, v_id)), '42501', 'a contributor does not');
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)', 'public.qorpera_folder_erasure_status(uuid,jsonb,uuid)']::regprocedure[] loop
		if not has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_erasure_step(integer,integer,integer)',
			'public.qorpera_folder_erasure_cutoff(uuid,text,bigint,timestamptz)', 'public.qorpera_folder_erasure_open_moves(uuid,jsonb)',
			'public.qorpera_schedule_folder_erasure()']::regprocedure[] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
			raise exception 'No API role runs %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)', 'public.qorpera_folder_erasure_step(integer,integer,integer)']::regprocedure[] loop
		select prosrc into v_body from pg_proc where oid = v_fn;
		if v_body ~* '(qorpera_profiles[^;]*for (update|no key update|share)|nowait|lock_profile_gc_fence|qorpera_folder_fences|40001|qorpera_folder_clocks[^;]*for )'
			or not (select proconfig @> array['lock_timeout=2s'] from pg_proc where oid = v_fn) then
			raise exception 'The lock text of %', v_fn; end if;
	end loop;
	if exists (select 1 from pg_class c where c.relname in ('qorpera_folder_erasures','qorpera_folder_erasure_needles',
			'qorpera_folder_erasure_runs','qorpera_folder_erasure_hashes') and not c.relrowsecurity)
		or has_table_privilege('service_role', 'public.qorpera_folder_erasures', 'select') then
		raise exception 'The erasure tables are closed'; end if;
end $$;

-- 7. Path permissions, a company being deleted, connection rows, copies, a moved folder, the step's bound ---------------

do $$
declare r jsonb; d jsonb; v_id uuid; v_resource uuid; v_version uuid; v_commit uuid; v_secret uuid := extensions.gen_random_uuid();
	v_before bigint;
begin
	-- A path permission at or under a deleted root is revoked first. The environment's root resource, and a live root's
	-- own permission (it governs the current file), never refuse.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', '', 'subtree', 'company_shared', 'normal', '70700000-0000-4000-8000-000000000001')
	on conflict do nothing;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-r-1', jsonb_build_array(pg_temp.mkdir('docs/r'),
		pg_temp.put('docs/r/a.md', 'r'))), 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-r-2', jsonb_build_array(pg_temp.del('docs/r'))), 1, 'saved');
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'docs/r/A.md', 'exact', 'company_shared', 'normal',
		'70700000-0000-4000-8000-000000000001') returning id into v_resource;
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['docs/r'], 'erase-r-3')$q$), '22023',
		'a permission under a deleted root');
	update public.qorpera_company_path_resources set revoked_at = clock_timestamp() where id = v_resource;
	r := pg_temp.erase(array['docs/r'], 'erase-r-3');
	perform pg_temp.is(pg_temp.drain((r ->> 'erasureId')::uuid).state, 'done', 'erased once revoked');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-l-1', jsonb_build_array(pg_temp.put('docs/l.md', 'l one'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-l-2', jsonb_build_array(pg_temp.del('docs/l.md'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-l-3', jsonb_build_array(pg_temp.put('docs/l.md', 'l two'))), 1, 'saved');
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'docs/l.md', 'exact', 'company_shared', 'normal',
		'70700000-0000-4000-8000-000000000001');
	perform pg_temp.drain((pg_temp.erase(array['docs/l.md'], 'erase-l-4') ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('docs/l.md')::text, '1', 'a live root''s own permission does not refuse');

	-- A retired connection row built from an erased file goes with the request, as the index rows do.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-k-1', jsonb_build_array(pg_temp.put('docs/k.md', 'k'))), 1, 'saved');
	v_version := pg_temp.version('docs/k.md');
	select commit_id into v_commit from public.qorpera_folder_path_versions where version = v_version;
	insert into public.qorpera_folder_connection_index(secret_id, environment_id, profile_id, folder_path, folder_path_version,
		commit_id, purpose, retired_at)
	values (v_secret, '70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010', 'docs/k.md', v_version,
		v_commit, 'the k account', clock_timestamp());
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-k-2', jsonb_build_array(pg_temp.del('docs/k.md'))), 1, 'saved');
	r := pg_temp.erase(array['docs/k.md'], 'erase-k-3');
	if exists (select 1 from public.qorpera_folder_connection_index where secret_id = v_secret) then
		raise exception 'The retired connection row goes with the request'; end if;
	-- A company being deleted: no new erasure, and the drain leaves its open ones to the purge.
	v_id := (r ->> 'erasureId')::uuid;
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values ('70700000-0000-4000-8000-000000000010', null);
	perform pg_temp.is(pg_temp.fails($q$select pg_temp.erase(array['docs/r'], 'erase-k-4')$q$), '55000', 'a company being deleted');
	perform public.qorpera_folder_erasure_step(3, 3, 3);
	if pg_temp.versions_at('docs/k.md') <> 2 or (select phase from public.qorpera_folder_erasures where id = v_id) <> 1 then
		raise exception 'The drain leaves a company being deleted'; end if;
	delete from public.qorpera_company_deletions where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.drain(v_id).state, 'done', 'drained once the deletion is gone');
	perform pg_temp.is(pg_temp.versions_at('docs/k.md')::text, '0', 'its versions are gone');

	-- A copy: another file with the erased bytes is named in the reply, not followed.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-c-1', jsonb_build_array(pg_temp.put('docs/c1.md', 'copied text'),
		pg_temp.put('docs/c2.md', 'copied text'))), 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-c-2', jsonb_build_array(pg_temp.del('docs/c1.md'))), 1, 'saved');
	r := pg_temp.erase(array['docs/c1.md'], 'erase-c-3');
	if r -> 'copies' <> '["docs/c2.md"]'::jsonb then raise exception 'The copy is named: %', r; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('docs/c2.md')::text, '1', 'the copy stays');

	-- A moved folder, then deleted: the refusal names the old folder alone, not each key under it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-s-1', jsonb_build_array(pg_temp.mkdir('docs/s'),
		pg_temp.put('docs/s/a.md', 's'))), 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-s-2', jsonb_build_array(pg_temp.mv('docs/s', 'docs/t'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'erase-s-3', jsonb_build_array(pg_temp.del('docs/t'))), 1, 'saved');
	d := pg_temp.detail($q$select pg_temp.erase(array['docs/t'], 'erase-s-4')$q$);
	if d -> 'add' <> '["docs/s"]'::jsonb or d -> 'live' <> '[]'::jsonb then raise exception 'Name the old folder: %', d; end if;
	r := pg_temp.erase(array['docs/t', 'docs/s'], 'erase-s-5');
	-- One step deletes at most its bound of versions.
	v_before := pg_temp.versions_at('docs/s') + pg_temp.versions_at('docs/s/a.md') + pg_temp.versions_at('docs/t')
		+ pg_temp.versions_at('docs/t/a.md');
	perform public.qorpera_folder_erasure_step(3, 3, 3);
	perform pg_temp.is((v_before - pg_temp.versions_at('docs/s') - pg_temp.versions_at('docs/s/a.md') - pg_temp.versions_at('docs/t')
		- pg_temp.versions_at('docs/t/a.md'))::text, '3', 'a step deletes its bound');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('docs/s') + pg_temp.versions_at('docs/s/a.md') + pg_temp.versions_at('docs/t')
		+ pg_temp.versions_at('docs/t/a.md') <> 0 then raise exception 'The moved folder''s whole history goes'; end if;
end $$;

rollback;
