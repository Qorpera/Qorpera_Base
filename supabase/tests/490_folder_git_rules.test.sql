-- @fixture 487_folder_view_served_by_code_host.test.sql until "-- A coding session's view: renewed only with a service."
-- git's rules in the folder's commit (20260930446200; F3 step 5b: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
-- "Code areas and git"). Under code/<owner>/<name>/, a coding session writes its own worktree and git's objects, and a
-- ref only through a lease; main/ and the rest of repo.git are the platform's. A member restores; the platform and a code
-- host's view have no rule. Under repo.git an object written onto its own bytes and a folder that is there are saved as
-- they stand, and a conflict keeps no copy. The office, code/ and the helpers are 639's and 487's.

-- The commit keeps every marker, and the new functions are no role's.
do $$
declare v_def text := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure);
begin
	if strpos(v_def, '20260930446200') = 0 or strpos(v_def, '20260930446000') = 0 or strpos(v_def, '20260930445000') = 0 then
		raise exception 'The commit lost a marker'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
		cross join unnest(array['public.qorpera_folder_git_object(text)', 'public.qorpera_folder_git_refusal(text,text,text,uuid)',
			'public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)']) f(sig)
		where has_function_privilege(r.role, f.sig, 'EXECUTE')) then
		raise exception 'A git rule is callable'; end if;
end $$;

-- The rule, key by key (w is the session's worker, x another worker's; a null worker is a session that is no coding view).
do $$
declare w uuid := '63200000-0000-4000-8000-0000000000c1'; x text := '63200000-0000-4000-8000-0000000000c2';
	d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/'; v_wrong text;
begin
	select string_agg(format('%s %s %s: %s', t.k, t.op, t.cls, coalesce(public.qorpera_folder_git_refusal(t.k, t.op, t.cls,
			case when t.own then w end), 'null')), '; ') into v_wrong
	from (values
		(d || 'main/x', 'write', 'session', true, 'git_platform_only'),
		(d || 'main/x', 'write', 'member', true, 'git_platform_only'),
		(d || 'main/x', 'write', 'platform', true, null),
		(d || 'main', 'mkdir', 'session', true, 'git_platform_only'),
		(d || 'worktrees', 'mkdir', 'session', true, null),
		(d || 'worktrees/' || w || '/src/a.ts', 'write', 'session', true, null),
		(d || 'worktrees/' || w || '/.git', 'write', 'session', true, null),
		(d || 'worktrees/' || x || '/a', 'write', 'session', true, 'git_other_worker'),
		(d || 'worktrees/' || x || '/a', 'write', 'member', true, null),
		(d || 'worktrees/' || w || '/a', 'write', 'session', false, 'git_other_worker'),
		(d || 'worktrees/' || w || '/link', 'symlink', 'session', true, null),
		(d || 'worktrees/' || x || '/link', 'symlink', 'session', true, 'git_other_worker'),
		(g || 'refs/heads/link', 'symlink', 'session', true, 'git_platform_only'),
		(g || 'refs/heads/link', 'symlink', 'member', true, 'git_platform_only'),
		(g || 'refs/heads/link', 'symlink', 'platform', true, null),
		(d || 'notes.md', 'write', 'session', true, null),
		('code/acme/app', 'rmdir', 'session', true, null),
		('code/acme', 'move', 'session', true, null),
		(d || 'repo.git', 'mkdir', 'session', true, 'git_platform_only'),
		(d || 'repo.git', 'mkdir', 'member', true, 'git_platform_only'),
		(g || 'HEAD', 'write', 'session', true, 'git_platform_only'),
		(g || 'config', 'write', 'member', true, 'git_platform_only'),
		(g || 'hooks/pre-commit', 'write', 'session', true, 'git_platform_only'),
		(g || 'info', 'mkdir', 'session', true, 'git_platform_only'),
		(g || 'objects', 'mkdir', 'session', true, null),
		(g || 'objects/ab', 'mkdir', 'session', true, null),
		(g || 'objects/ab', 'rmdir', 'session', true, 'git_object_delete'),
		(g || 'objects/ab', 'mkdir', 'member', true, 'git_platform_only'),
		(g || 'objects/pack', 'mkdir', 'session', true, null),
		(g || 'objects/info', 'mkdir', 'session', true, 'git_platform_only'),
		(g || 'objects/ab/' || repeat('c', 38), 'write', 'session', true, null),
		(g || 'objects/ab/' || repeat('c', 62), 'write', 'session', false, null),
		(g || 'objects/ab/' || repeat('c', 38), 'write', 'member', true, 'git_platform_only'),
		(g || 'objects/ab/' || repeat('c', 38), 'delete', 'session', true, 'git_object_delete'),
		(g || 'objects/ab/' || repeat('c', 38), 'move', 'session', true, 'git_platform_only'),
		(g || 'objects/ab/' || repeat('c', 37), 'write', 'session', true, 'git_platform_only'),
		(g || 'objects/pack/pack-' || repeat('e', 40) || '.pack', 'write', 'session', true, null),
		(g || 'objects/pack/pack-' || repeat('e', 64) || '.idx', 'write', 'session', true, null),
		(g || 'objects/pack/pack-' || repeat('e', 40) || '.keep', 'write', 'session', true, 'git_keep_file'),
		(g || 'objects/pack/tmp_pack_1', 'write', 'session', true, 'git_platform_only'),
		(g || 'objects/info/alternates', 'write', 'session', true, 'git_platform_only'),
		(g || 'refs', 'mkdir', 'session', true, null),
		(g || 'refs/heads/qorpera', 'mkdir', 'session', true, null),
		(g || 'refs/heads/main', 'write', 'session', true, 'git_lease_required'),
		(g || 'refs/heads/main', 'delete', 'session', false, 'git_lease_required'),
		(g || 'refs/heads/main', 'write', 'member', true, null),
		(g || 'refs/stash', 'write', 'member', true, 'git_stash'),
		(g || 'logs', 'mkdir', 'session', true, null),
		(g || 'logs/head', 'write', 'session', true, 'git_platform_only'),
		(g || 'logs/refs/heads/main', 'write', 'session', true, 'git_lease_required'),
		(g || 'logs/refs/stash', 'write', 'session', true, 'git_stash'),
		(g || 'packed-refs', 'write', 'session', true, 'git_lease_required'),
		(g || 'packed-refs', 'write', 'member', true, null),
		(g || 'shallow', 'mkdir', 'member', true, 'git_platform_only'),
		(g || 'worktrees', 'mkdir', 'session', true, null),
		(g || 'worktrees', 'write', 'session', true, 'git_platform_only'),
		(g || 'worktrees/' || w || '/head', 'write', 'session', true, null),
		(g || 'worktrees/' || w || '/config.worktree', 'write', 'session', true, 'git_platform_only'),
		(g || 'worktrees/' || x || '/index', 'write', 'session', true, 'git_other_worker'),
		(g || 'worktrees/' || x || '/index', 'write', 'member', true, null),
		(g || 'worktrees/main/commondir', 'write', 'session', true, 'git_platform_only'),
		(g || 'worktrees/main/commondir', 'write', 'member', true, 'git_platform_only'),
		(g || 'refs/heads/main', 'move', 'member', true, 'git_platform_only'),
		(g || 'config', 'write', 'platform', true, null)) t(k, op, cls, own, want)
	where public.qorpera_folder_git_refusal(t.k, t.op, t.cls, case when t.own then w end) is distinct from t.want;
	if v_wrong is not null then raise exception 'git_refusal: %', v_wrong; end if;
	if public.qorpera_folder_git_object('code/acme/app/repo.git/objects/AB/' || repeat('c', 38))
		or public.qorpera_folder_git_object('code/acme/app/sub/repo.git/objects/ab/' || repeat('c', 38))
		or not public.qorpera_folder_git_object('code/acme/app/repo.git/objects/pack/pack-' || repeat('0', 40) || '.rev') then
		raise exception 'git_object names the wrong keys'; end if;
end $$;

-- Two coding sessions' views, their workers, and helpers.
create temp table git_views(n integer primary key, view jsonb not null, worker text not null);
do $$
declare v jsonb;
begin
	for i in 1..2 loop
		v := pg_temp.coding('git-' || i);
		insert into git_views select i, v, worker_id::text from public.qorpera_folder_views where id = (v ->> 'viewId')::uuid;
	end loop;
end $$;
create function pg_temp.cv(p_n integer) returns jsonb language sql as $$ select view from git_views where n = p_n $$;
create function pg_temp.wk(p_n integer) returns text language sql as $$ select worker from git_views where n = p_n $$;
create function pg_temp.ver(p_path text) returns text language sql as $$
	select version::text from public.qorpera_folder_entries where environment_id = '63200000-0000-4000-8000-000000000020'
		and key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
$$;
-- Each unit of p_result refused with its reason.
create function pg_temp.refused(p_result jsonb, p_reasons text[]) returns void language plpgsql as $$
begin
	for i in 1..cardinality(p_reasons) loop perform pg_temp.expect(p_result, i, 'refused', p_reasons[i]); end loop;
	if jsonb_array_length(p_result -> 'units') <> cardinality(p_reasons) then raise exception 'Units: %', p_result; end if;
end $$;

-- The platform lays out code/acme/app: main/, two worktrees, and repo.git with an object, a ref and main/'s admin files.
do $$
declare d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/'; w1 text := pg_temp.wk(1); w2 text := pg_temp.wk(2);
	a jsonb := pg_temp.stage('git-alpha'); o jsonb := pg_temp.stage('git-object'); r jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'git-setup',
		(select jsonb_agg(jsonb_build_object('op','mkdir','path',p) order by n) from unnest(array['code/acme', 'code/acme/app',
			d || 'main', d || 'worktrees', d || 'worktrees/' || w1, d || 'worktrees/' || w2, d || 'repo.git', g || 'objects',
			g || 'objects/ab', g || 'objects/pack', g || 'refs', g || 'refs/heads', g || 'logs', g || 'worktrees',
			g || 'worktrees/' || w1, g || 'worktrees/' || w2, g || 'worktrees/main']) with ordinality t(p, n))
		|| (select jsonb_agg(jsonb_build_object('op','write','path',p,'file',case when p like '%/objects/%' then o else a end)
			order by n) from unnest(array[d || 'main/README', d || 'worktrees/' || w1 || '/a.txt', d || 'worktrees/' || w2 || '/b.txt',
			g || 'HEAD', g || 'config', g || 'objects/ab/' || repeat('c', 38), g || 'refs/heads/main', g || 'packed-refs',
			g || 'worktrees/main/commondir']) with ordinality t(p, n)));
	if (select count(*) from jsonb_array_elements(r -> 'units') u where u ->> 'outcome' = 'saved') <> 26 then
		raise exception 'Setup: %', r; end if;
end $$;

-- A coding session writes its own worktree (its .git file and links too), git's objects and packs, refs' folders, its
-- own admin files under repo.git/worktrees/, and code areas git does not own.
do $$
declare cv jsonb := pg_temp.cv(1); w1 text := pg_temp.wk(1); d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/';
	a jsonb := pg_temp.stage('git-alpha'); b jsonb := pg_temp.stage('git-beta'); r jsonb;
begin
	r := pg_temp.vcommit(cv, 'git-w1-own', jsonb_build_array(
		jsonb_build_object('op','write','path',d || 'worktrees/' || w1 || '/.git','file',a),
		jsonb_build_object('op','mkdir','path',d || 'worktrees/' || w1 || '/src'),
		jsonb_build_object('op','move','from',d || 'worktrees/' || w1 || '/a.txt','to',d || 'worktrees/' || w1 || '/src/a.txt',
			'expectedVersion',pg_temp.ver(d || 'worktrees/' || w1 || '/a.txt')),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('d', 38),'file',b),
		jsonb_build_object('op','mkdir','path',g || 'objects/cd'),
		jsonb_build_object('op','write','path',g || 'objects/pack/pack-' || repeat('e', 40) || '.pack','file',b),
		jsonb_build_object('op','mkdir','path',g || 'refs/heads/qorpera'),
		jsonb_build_object('op','write','path',g || 'worktrees/' || w1 || '/HEAD','file',a),
		jsonb_build_object('op','write','path',d || 'notes.md','file',a),
		jsonb_build_object('op','symlink','path',d || 'worktrees/' || w1 || '/src/link','target','a.txt')));
	for i in 1..10 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- What it may not do: main/, other workers' worktrees and admin files, main/'s admin files, refs without a lease, the
-- stash, a pack's keep file, removing an object, git's other files, and anything moved, copied, made whole or linked into
-- repo.git.
-- A move's source is removed, as a delete's is, and a unit that removes a folder is held to every key below it.
do $$
declare cv jsonb := pg_temp.cv(1); w1 text := pg_temp.wk(1); w2 text := pg_temp.wk(2); d text := 'code/acme/app/';
	g text := 'code/acme/app/repo.git/'; a jsonb := pg_temp.stage('git-alpha'); r jsonb;
begin
	r := pg_temp.vcommit(cv, 'git-w1-refused', jsonb_build_array(
		jsonb_build_object('op','write','path',d || 'main/x','file',a),
		jsonb_build_object('op','write','path',d || 'worktrees/' || w2 || '/x','file',a),
		jsonb_build_object('op','write','path',g || 'worktrees/' || w2 || '/index','file',a),
		jsonb_build_object('op','write','path',g || 'worktrees/main/gitdir','file',a),
		jsonb_build_object('op','write','path',g || 'worktrees/' || w1 || '/config.worktree','file',a),
		jsonb_build_object('op','write','path',g || 'refs/heads/qorpera/x','file',a),
		jsonb_build_object('op','write','path',g || 'packed-refs','file',a,'expectedVersion',pg_temp.ver(g || 'packed-refs')),
		jsonb_build_object('op','delete','path',g || 'refs/heads/main','expectedVersion',pg_temp.ver(g || 'refs/heads/main')),
		jsonb_build_object('op','write','path',g || 'refs/stash','file',a),
		jsonb_build_object('op','write','path',g || 'objects/pack/pack-' || repeat('e', 40) || '.keep','file',a),
		jsonb_build_object('op','write','path',g || 'objects/info/alternates','file',a),
		jsonb_build_object('op','write','path',g || 'config','file',a,'expectedVersion',pg_temp.ver(g || 'config')),
		jsonb_build_object('op','mkdir','path',g || 'hooks'),
		jsonb_build_object('op','mkdir','path','code/acme/app/repo.git'),
		jsonb_build_object('op','delete','path',g || 'objects/ab/' || repeat('c', 38),
			'expectedVersion',pg_temp.ver(g || 'objects/ab/' || repeat('c', 38))),
		jsonb_build_object('op','delete','path',g || 'objects/ab','expectedVersion',pg_temp.ver(g || 'objects/ab')),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('d', 38),'file',a),
		jsonb_build_object('op','move','from',d || 'worktrees/' || w1 || '/src/a.txt','to',g || 'objects/ab/' || repeat('f', 38),
			'expectedVersion',pg_temp.ver(d || 'worktrees/' || w1 || '/src/a.txt')),
		jsonb_build_object('op','copy','from',d || 'worktrees/' || w1 || '/src/a.txt','to',g || 'refs/heads/copied'),
		jsonb_build_object('op','move','from',g || 'objects/ab/' || repeat('d', 38),'to',d || 'worktrees/' || w1 || '/obj',
			'expectedVersion',pg_temp.ver(g || 'objects/ab/' || repeat('d', 38))),
		jsonb_build_object('op','new_folder','path',g || 'info','contents','[]'::jsonb),
		jsonb_build_object('op','delete','path','code/acme/app','expectedVersion',pg_temp.ver('code/acme/app')),
		jsonb_build_object('op','delete','path',d || 'worktrees','expectedVersion',pg_temp.ver(d || 'worktrees')),
		jsonb_build_object('op','symlink','path',g || 'refs/heads/link','target','main'),
		jsonb_build_object('op','symlink','path',d || 'worktrees/' || w2 || '/link','target','x')));
	perform pg_temp.refused(r, array['git_platform_only', 'git_other_worker', 'git_other_worker', 'git_platform_only',
		'git_platform_only', 'git_lease_required', 'git_lease_required', 'git_lease_required', 'git_stash', 'git_keep_file',
		'git_platform_only', 'git_platform_only', 'git_platform_only', 'git_platform_only', 'git_object_delete',
		'git_object_delete', 'git_object_delete', 'git_platform_only', 'git_platform_only', 'git_object_delete',
		'git_platform_only', 'git_platform_only', 'git_other_worker', 'git_platform_only', 'git_other_worker']);
	if r -> 'seq' <> 'null'::jsonb then raise exception 'A refused commit took a seq: %', r; end if;
end $$;

-- Written again under repo.git: an object onto its own bytes and a folder that is there are saved as they stand, at
-- their versions, and a commit of nothing else takes no seq. Outside repo.git a folder that is there is still a conflict.
do $$
declare cv jsonb := pg_temp.cv(1); w1 text := pg_temp.wk(1); d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/';
	b jsonb := pg_temp.stage('git-beta'); r jsonb; v_obj text := pg_temp.ver(g || 'objects/ab/' || repeat('d', 38));
	v_dir text := pg_temp.ver(g || 'objects/cd'); v_refs text := pg_temp.ver(g || 'refs/heads');
begin
	r := pg_temp.vcommit(cv, 'git-w1-again', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('d', 38),'file',b),
		jsonb_build_object('op','mkdir','path',g || 'objects/cd'),
		jsonb_build_object('op','mkdir','path',g || 'refs/heads')));
	if (pg_temp.expect(r, 1, 'saved') ->> 'version') is distinct from v_obj
		or (pg_temp.expect(r, 2, 'saved') ->> 'version') is distinct from v_dir
		or (pg_temp.expect(r, 3, 'saved') ->> 'version') is distinct from v_refs
		or r -> 'seq' <> 'null'::jsonb
		or pg_temp.ver(g || 'objects/ab/' || repeat('d', 38)) is distinct from v_obj then
		raise exception 'Saved as it stands: %', r; end if;
	perform pg_temp.expect(pg_temp.vcommit(cv, 'git-w1-exists', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',d || 'worktrees/' || w1 || '/src'))), 1, 'conflict', 'exists');
end $$;

-- A member restores: other workers' worktrees and refs with no lease; not git's objects, main/ or its admin files, or the
-- stash. A folder that is there is saved as it stands for a member too.
do $$
declare w2 text := pg_temp.wk(2); d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/';
	a jsonb := pg_temp.stage('git-alpha'); b jsonb := pg_temp.stage('git-beta'); r jsonb;
begin
	r := pg_temp.commit(pg_temp.member(1), 'git-member', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',d || 'worktrees/' || w2 || '/m'),
		jsonb_build_object('op','write','path',g || 'refs/heads/feature','file',a),
		jsonb_build_object('op','write','path',g || 'packed-refs','file',b,'expectedVersion',pg_temp.ver(g || 'packed-refs')),
		jsonb_build_object('op','mkdir','path',g || 'refs/heads'),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('9', 38),'file',a),
		jsonb_build_object('op','write','path',d || 'main/y','file',a),
		jsonb_build_object('op','write','path',g || 'worktrees/main/head','file',a),
		jsonb_build_object('op','write','path',g || 'refs/stash','file',a),
		jsonb_build_object('op','delete','path',g || 'objects/ab/' || repeat('c', 38),
			'expectedVersion',pg_temp.ver(g || 'objects/ab/' || repeat('c', 38)))));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.expect(r, 5, 'refused', 'git_platform_only');
	perform pg_temp.expect(r, 6, 'refused', 'git_platform_only');
	perform pg_temp.expect(r, 7, 'refused', 'git_platform_only');
	perform pg_temp.expect(r, 8, 'refused', 'git_stash');
	perform pg_temp.expect(r, 9, 'refused', 'git_object_delete');
end $$;

-- Any other session (a run) names no worker, so no worktree is its own; git's objects need no lease, refs do.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w1 text := pg_temp.wk(1);
	d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/'; a jsonb := pg_temp.stage('git-alpha'); r jsonb;
begin
	r := pg_temp.commit(v, 'git-run-1', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',d || 'worktrees/' || w1 || '/r'),
		jsonb_build_object('op','write','path',g || 'refs/heads/run','file',a),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('a', 38),'file',a),
		jsonb_build_object('op','write','path',d || 'run.md','file',a)));
	perform pg_temp.expect(r, 1, 'refused', 'git_other_worker');
	perform pg_temp.expect(r, 2, 'refused', 'git_lease_required');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(r, 4, 'saved');
end $$;

-- The code host's view and the platform have no rule. Under repo.git a conflict keeps no copy and another object's bytes
-- are a conflict for the platform; elsewhere a conflict still keeps its copy.
do $$
declare ch jsonb := pg_temp.open('code_host', '{}'); d text := 'code/acme/app/'; g text := 'code/acme/app/repo.git/';
	a jsonb := pg_temp.stage('git-alpha'); b jsonb := pg_temp.stage('git-beta'); r jsonb;
begin
	r := pg_temp.vcommit(ch, 'git-host', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',g || 'hooks'),
		jsonb_build_object('op','mkdir','path',d || 'main/src'),
		jsonb_build_object('op','delete','path',g || 'objects/ab/' || repeat('c', 38),
			'expectedVersion',pg_temp.ver(g || 'objects/ab/' || repeat('c', 38))),
		jsonb_build_object('op','delete','path',g || 'refs/heads/feature','expectedVersion',pg_temp.ver(g || 'refs/heads/feature'))));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit('{"kind":"platform"}', 'git-platform', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'HEAD','file',b),
		jsonb_build_object('op','write','path',d || 'main/README','file',b),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('d', 38),'file',a),
		jsonb_build_object('op','write','path',g || 'config','file',b,'expectedVersion',pg_temp.ver(g || 'config'))));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	perform pg_temp.expect(r, 2, 'conflict', 'exists');
	perform pg_temp.expect(r, 3, 'conflict', 'exists');
	perform pg_temp.expect(r, 4, 'saved');
	if array(select c.unit_no from public.qorpera_folder_conflict_copies c where c.commit_id = (r ->> 'commitId')::uuid
		order by c.unit_no) is distinct from array[2] then
		raise exception 'Conflict copies: %', r; end if;
end $$;

-- A session removes its own worktree whole.
do $$
begin
	perform pg_temp.expect(pg_temp.vcommit(pg_temp.cv(1), 'git-w1-done', jsonb_build_array(jsonb_build_object('op','delete',
		'path','code/acme/app/worktrees/' || pg_temp.wk(1),
		'expectedVersion',pg_temp.ver('code/acme/app/worktrees/' || pg_temp.wk(1)),'asOfSeq',(select last_seq::text
			from public.qorpera_folder_clocks where environment_id = '63200000-0000-4000-8000-000000000020')))), 1, 'saved');
end $$;

rollback;
