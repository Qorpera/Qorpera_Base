-- @fixture 490_folder_git_rules.test.sql until "-- A coding session writes its own worktree"
-- git's leases (20260930446300; F3 step 5b, part 3: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Code areas and
-- git"). A coding session or a code host takes the lease on a shared file X of a repo.git (refs/**, packed-refs, shallow).
-- Another valid view's lease answers busy, a git rule answers refused, a repository the view may not write answers
-- refused ('denied'), and a lease lives as long as its view. A code host's gc block answers new takes busy
-- ('maintenance'). Publish and release are 492's. The office, code/acme/app and the helpers are 490's.

-- The commit keeps every marker. The calls are the service role's alone; the helpers and the leases are no role's.
do $$
declare v_def text := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure);
	v_api text[] := array['public.qorpera_folder_git_lease_take(uuid,jsonb,text)', 'public.qorpera_folder_git_leases_drop(uuid,jsonb)',
		'public.qorpera_folder_git_gc_begin(uuid,jsonb,text)', 'public.qorpera_folder_git_gc_end(uuid,jsonb,text)',
		'public.qorpera_folder_git_publish(uuid,jsonb,uuid,text,jsonb)', 'public.qorpera_folder_git_lease_release(uuid,jsonb,uuid,jsonb)'];
	v_helpers text[] := array['public.qorpera_folder_git_view(uuid,jsonb)', 'public.qorpera_folder_git_shared_repository(text)',
		'public.qorpera_folder_git_reflog_key(text)', 'public.qorpera_folder_git_version(uuid,text)',
		'public.qorpera_folder_git_repository_lock(uuid,text,boolean)', 'public.qorpera_folder_git_repository(text)',
		'public.qorpera_folder_git_land(uuid,jsonb,uuid,text,jsonb,boolean)'];
begin
	if strpos(v_def, '20260930446300') = 0 or strpos(v_def, '20260930446200') = 0 or strpos(v_def, '20260930446000') = 0
		or strpos(v_def, '20260930445000') = 0 then raise exception 'The commit lost a marker'; end if;
	if exists (select 1 from unnest(array['anon','authenticated']) r(role) cross join unnest(v_api) f(sig)
			where has_function_privilege(r.role, f.sig, 'EXECUTE'))
		or exists (select 1 from unnest(v_api) f(sig) where not has_function_privilege('service_role', f.sig, 'EXECUTE')) then
		raise exception 'The git calls are not the service role''s alone'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role) cross join unnest(v_helpers) f(sig)
			where has_function_privilege(r.role, f.sig, 'EXECUTE'))
		or exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
			where has_table_privilege(r.role, 'public.qorpera_folder_git_leases', 'SELECT,INSERT,UPDATE,DELETE')) then
		raise exception 'A git helper or the leases are a role''s'; end if;
	if public.qorpera_folder_git_shared_repository('code/acme/app/repo.git/refs/heads/main') is distinct from 'code/acme/app'
		or public.qorpera_folder_git_shared_repository('code/acme/app/repo.git/packed-refs') is distinct from 'code/acme/app'
		or public.qorpera_folder_git_shared_repository('code/acme/app/repo.git/logs/refs/heads/main') is not null
		or public.qorpera_folder_git_shared_repository('code/acme/app/repo.git/HEAD') is not null
		or public.qorpera_folder_git_reflog_key('code/acme/app/repo.git/refs/heads/main')
			is distinct from 'code/acme/app/repo.git/logs/refs/heads/main' then
		raise exception 'The shared files are the wrong keys'; end if;
end $$;

create function pg_temp.take(p_view jsonb, p_path text) returns jsonb language sql as $$
	select public.qorpera_folder_git_lease_take('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path)
$$;
create function pg_temp.drop_all(p_view jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view))
$$;
create function pg_temp.gc(p_view jsonb, p_begin boolean, p_repository text default 'code/acme/app') returns jsonb
language plpgsql as $$
begin
	if p_begin then
		return public.qorpera_folder_git_gc_begin('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_repository); end if;
	return public.qorpera_folder_git_gc_end('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_repository);
end $$;
create function pg_temp.until(p_view jsonb) returns timestamptz language sql as $$
	select lease_until from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;
create function pg_temp.entries() returns bigint language sql as $$
	select count(*) from public.qorpera_folder_entries where environment_id = '63200000-0000-4000-8000-000000000020'
$$;

-- A session takes X: held, with the versions git reads under it (logs/X has none yet). It takes it again as the same
-- lease, and another session is busy on it with the holder's lease time. A lease is a row, never an entry.
do $$
declare g text := 'code/acme/app/repo.git/'; v_entries bigint := pg_temp.entries(); r jsonb; r2 jsonb;
begin
	r := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	if r ->> 'schema' is distinct from 'qorpera.folder-git-lease/v1' or r ->> 'state' is distinct from 'held'
		or r ->> 'leaseId' is null or r ->> 'path' is distinct from g || 'refs/heads/main'
		or r -> 'versions' ->> 'file' is null or r -> 'versions' ->> 'file' is distinct from pg_temp.ver(g || 'refs/heads/main')
		or r -> 'versions' ->> 'packedRefs' is null or r -> 'versions' ->> 'packedRefs' is distinct from pg_temp.ver(g || 'packed-refs')
		or r -> 'versions' -> 'reflog' is distinct from 'null'::jsonb then raise exception 'Take: %', r; end if;
	r2 := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	if r2 ->> 'state' is distinct from 'held' or r2 ->> 'leaseId' is distinct from r ->> 'leaseId' then
		raise exception 'Again: %', r2; end if;
	r2 := pg_temp.take(pg_temp.cv(2), g || 'REFS/heads/main');
	if r2 ->> 'state' is distinct from 'busy' or (r2 ->> 'leaseUntil')::timestamptz is distinct from pg_temp.until(pg_temp.cv(1))
		or r2 -> 'reason' is distinct from 'null'::jsonb then raise exception 'Busy: %', r2; end if;
	r2 := pg_temp.take(pg_temp.cv(2), g || 'refs/heads/feature');
	if r2 ->> 'state' is distinct from 'held' or r2 -> 'versions' ->> 'file' is not null then raise exception 'New ref: %', r2; end if;
	if pg_temp.entries() <> v_entries or (select count(*) from public.qorpera_folder_git_leases) <> 2 then
		raise exception 'Leases: % entries, % rows', pg_temp.entries() - v_entries, (select count(*) from public.qorpera_folder_git_leases); end if;
end $$;

-- A session's take keeps git's rules: another worker's branch, the stash and the platform's files are refused. Its own
-- branch is held, and a code host has no rule.
do $$
declare g text := 'code/acme/app/repo.git/'; h jsonb := pg_temp.open('code_host', '{}'); r jsonb;
begin
	foreach r in array array[
		pg_temp.take(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || pg_temp.wk(2)) || '{"want":"git_other_worker"}',
		pg_temp.take(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || pg_temp.wk(2) || '/x') || '{"want":"git_other_worker"}',
		pg_temp.take(pg_temp.cv(1), g || 'refs/stash') || '{"want":"git_stash"}',
		pg_temp.take(pg_temp.cv(1), g || 'config') || '{"want":"git_platform_only"}',
		pg_temp.take(pg_temp.cv(1), 'code/acme/app/main/README') || '{"want":"git_platform_only"}'] loop
		if r ->> 'schema' is distinct from 'qorpera.folder-git-lease/v1' or r ->> 'state' is distinct from 'refused'
			or r ->> 'reason' is distinct from r ->> 'want' then raise exception 'Refused: %', r; end if;
	end loop;
	r := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || pg_temp.wk(1));
	if r ->> 'state' is distinct from 'held' then raise exception 'Own branch: %', r; end if;
	r := pg_temp.take(h, g || 'refs/heads/qorpera/coding/' || pg_temp.wk(2));
	if r ->> 'state' is distinct from 'held' then raise exception 'Code host: %', r; end if;
	r := pg_temp.take(pg_temp.cv(2), g || 'refs/heads/qorpera/coding/' || pg_temp.wk(2));
	if r ->> 'state' is distinct from 'busy' then raise exception 'Behind the code host: %', r; end if;
	perform pg_temp.drop_all(h);
end $$;

-- A take is the view's only where its commits may write X: in a repository its agent holds no grant on, a session is
-- 'denied', with no lease and no versions. Granted, it takes the lease. A code host writes every repository.
do $$
declare g text := 'code/acme/locked/repo.git/'; h jsonb := pg_temp.open('code_host', '{}'); v_resource uuid; r jsonb;
	v_leases bigint := (select count(*) from public.qorpera_folder_git_leases);
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'git-locked-setup', '[{"op":"mkdir","path":"code/acme/locked"}]'),
		1, 'saved');
	v_resource := public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'code/acme/locked',
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	r := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	if r is distinct from '{"schema":"qorpera.folder-git-lease/v1","state":"refused","reason":"denied"}'::jsonb
		or (select count(*) from public.qorpera_folder_git_leases) <> v_leases then raise exception 'Denied: %', r; end if;
	perform public.qorpera_folder_grant('63200000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63200000-0000-4000-8000-0000000000a1', array['read','write']);
	r := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	if r ->> 'state' is distinct from 'held' then raise exception 'Granted: %', r; end if;
	perform public.qorpera_folder_git_lease_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(pg_temp.cv(1)),
		(r ->> 'leaseId')::uuid);
	r := pg_temp.take(h, g || 'refs/heads/main');
	if r ->> 'state' is distinct from 'held' then raise exception 'Code host: %', r; end if;
	perform pg_temp.drop_all(h);
end $$;

-- A take names a shared file (logs/X is not one: its lease is X's), a valid path, and a coding session's or code
-- host's valid view, with the service role.
do $$
declare g text := 'code/acme/app/repo.git/'; h jsonb := pg_temp.open('code_host', '{}');
begin
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', pg_temp.cv(1), g || 'logs/refs/heads/main'), '22023');
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', pg_temp.cv(1), 'notes/a.txt'), '22023');
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', h, g || 'HEAD'), '22023');
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', h, g || 'refs/../HEAD'), '22023');
	perform pg_temp.raises(format('select pg_temp.take(%L, null)', h), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_git_lease_take(%L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.member(2), g || 'refs/heads/main'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_git_lease_take(%L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', g || 'refs/heads/main'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_git_leases_drop(%L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(h) || jsonb_build_object('pass', repeat('A', 43))), '42501');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', h, g || 'refs/heads/main'), '42501');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_view_close((h ->> 'viewId')::uuid, h ->> 'pass');
	perform pg_temp.raises(format('select pg_temp.take(%L, %L)', h, g || 'refs/heads/main'), '42501');
end $$;

-- A lease lives as long as its view: once the holder's view is closed or has expired, the next take on X deletes it.
do $$
declare g text := 'code/acme/app/repo.git/'; s jsonb := pg_temp.coding('git-3'); h jsonb := pg_temp.open('code_host', '{}');
	r jsonb; v_old uuid;
begin
	v_old := (pg_temp.take(s, g || 'refs/tags/v1') ->> 'leaseId')::uuid;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
	r := pg_temp.take(pg_temp.cv(1), g || 'refs/tags/v1');
	if r ->> 'state' is distinct from 'held' or exists (select 1 from public.qorpera_folder_git_leases where id = v_old) then
		raise exception 'After a close: %', r; end if;
	v_old := (pg_temp.take(h, g || 'shallow') ->> 'leaseId')::uuid;
	update public.qorpera_folder_views set lease_until = clock_timestamp() - interval '1 second' where id = (h ->> 'viewId')::uuid;
	r := pg_temp.take(pg_temp.cv(1), g || 'shallow');
	if r ->> 'state' is distinct from 'held' or exists (select 1 from public.qorpera_folder_git_leases where id = v_old) then
		raise exception 'After an expiry: %', r; end if;
end $$;

-- A command's end drops every lease its view holds and answers their paths; another view's stay.
do $$
declare g text := 'code/acme/app/repo.git/'; r jsonb;
begin
	perform pg_temp.take(pg_temp.cv(2), g || 'packed-refs');
	r := pg_temp.drop_all(pg_temp.cv(2));
	if r is distinct from jsonb_build_array(g || 'packed-refs', g || 'refs/heads/feature') then raise exception 'Drop: %', r; end if;
	if pg_temp.drop_all(pg_temp.cv(2)) is distinct from '[]'::jsonb then raise exception 'Dropped twice'; end if;
	r := pg_temp.drop_all(pg_temp.cv(1));
	if r is distinct from jsonb_build_array(g || 'refs/heads/main', g || 'refs/heads/qorpera/coding/' || pg_temp.wk(1),
		g || 'refs/tags/v1', g || 'shallow') then raise exception 'Drop: %', r; end if;
	if exists (select 1 from public.qorpera_folder_git_leases) then raise exception 'Leases left after the drops'; end if;
end $$;

-- A code host's gc block: it counts the leases other views hold, new takes are busy ('maintenance') until it ends, and
-- a second code host is busy behind it. Leases already held go on. The block lives as long as its view.
do $$
declare g text := 'code/acme/app/repo.git/'; h1 jsonb := pg_temp.open('code_host', '{}'); h2 jsonb := pg_temp.open('code_host', '{}');
	r jsonb;
begin
	perform pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	r := pg_temp.gc(h1, true);
	if r ->> 'schema' is distinct from 'qorpera.folder-git-gc/v1' or r ->> 'state' is distinct from 'blocking'
		or (r ->> 'held')::integer is distinct from 1 or (r ->> 'until')::timestamptz is distinct from pg_temp.until(h1) then
		raise exception 'Begin: %', r; end if;
	r := pg_temp.take(pg_temp.cv(2), g || 'refs/heads/feature');
	if r ->> 'state' is distinct from 'busy' or r ->> 'reason' is distinct from 'maintenance'
		or (r ->> 'leaseUntil')::timestamptz is distinct from pg_temp.until(h1) then raise exception 'Take under gc: %', r; end if;
	if pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main') ->> 'state' is distinct from 'held' then
		raise exception 'A held lease was not answered again under gc'; end if;
	r := pg_temp.gc(h2, true);
	if r ->> 'state' is distinct from 'busy' or (r ->> 'until')::timestamptz is distinct from pg_temp.until(h1) then
		raise exception 'Second code host: %', r; end if;
	if pg_temp.gc(h2, false) ->> 'state' is distinct from 'ended'
		or pg_temp.take(pg_temp.cv(2), g || 'refs/heads/feature') ->> 'reason' is distinct from 'maintenance' then
		raise exception 'Another code host ended the block'; end if;
	perform pg_temp.drop_all(pg_temp.cv(1));
	r := pg_temp.gc(h1, true);
	if r ->> 'state' is distinct from 'blocking' or (r ->> 'held')::integer is distinct from 0 then raise exception 'Again: %', r; end if;
	r := pg_temp.gc(h1, false);
	if r ->> 'schema' is distinct from 'qorpera.folder-git-gc/v1' or r ->> 'state' is distinct from 'ended'
		or pg_temp.take(pg_temp.cv(2), g || 'refs/heads/feature') ->> 'state' is distinct from 'held' then
		raise exception 'End: %', r; end if;
	-- An expired code host's block counts for nothing.
	perform pg_temp.drop_all(pg_temp.cv(2));
	perform pg_temp.gc(h1, true);
	update public.qorpera_folder_views set lease_until = clock_timestamp() - interval '1 second' where id = (h1 ->> 'viewId')::uuid;
	if pg_temp.take(pg_temp.cv(2), g || 'refs/heads/feature') ->> 'state' is distinct from 'held'
		or pg_temp.gc(h2, true) ->> 'state' is distinct from 'blocking' then raise exception 'An expired block held'; end if;
	perform pg_temp.gc(h2, false);
	perform pg_temp.drop_all(pg_temp.cv(2));
	-- Only a code host blocks, and only a repository: code/<owner>/<name>.
	perform pg_temp.raises(format('select pg_temp.gc(%L, true)', pg_temp.cv(1)), '42501');
	perform pg_temp.raises(format('select pg_temp.gc(%L, false)', pg_temp.cv(1)), '42501');
	perform pg_temp.raises(format('select pg_temp.gc(%L, true, %L)', h2, 'code/acme'), '22023');
	perform pg_temp.raises(format('select pg_temp.gc(%L, true, %L)', h2, 'code/acme/app/repo.git'), '22023');
	perform pg_temp.raises(format('select pg_temp.gc(%L, true, null)', h2), '22023');
	if exists (select 1 from public.qorpera_folder_git_leases) then raise exception 'Leases left after gc'; end if;
end $$;
