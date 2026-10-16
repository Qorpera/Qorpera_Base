-- @fixture 490_folder_git_rules.test.sql until "-- A coding session writes its own worktree"
-- git's publish and release under a lease (20260930446300; F3 step 5b, part 3: deploy/first-node/RUNTIME-FOLDER-CODING-
-- MACHINES.md, "Code areas and git"). A publish is one commit: the folders above its units that are missing, the
-- session's objects, then X and logs/X, which land together or not at all. If either one's version moved, both are
-- conflicts and the lease stays; if an object was not saved, both are refused. A publish that lands them ends the lease.
-- A release ends the lease, landing what it names. A replay answers as the first time, also after its view has ended.
-- Leases are 491's; the office, code/acme/app and the helpers are 490's.

create function pg_temp.take(p_view jsonb, p_path text) returns jsonb language sql as $$
	select public.qorpera_folder_git_lease_take('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path)
$$;
-- A publish or a release as the view, which takes possession of its files first. p_lease is the take's answer.
create function pg_temp.publish(p_view jsonb, p_lease jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_units);
	return public.qorpera_folder_git_publish('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view),
		(p_lease ->> 'leaseId')::uuid, p_key, p_units);
end $$;
create function pg_temp.release(p_view jsonb, p_lease jsonb, p_units jsonb default null) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_units);
	return public.qorpera_folder_git_lease_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view),
		(p_lease ->> 'leaseId')::uuid, p_units);
end $$;
create function pg_temp.w(p_path text, p_file jsonb, p_expected text default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',p_file)
		|| case when p_expected is null then '{}'::jsonb else jsonb_build_object('expectedVersion', p_expected) end
$$;
create function pg_temp.del(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.ver(p_path))
$$;
create function pg_temp.leased(p_lease jsonb) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_git_leases where id = (p_lease ->> 'leaseId')::uuid)
$$;
-- Every unit of p_result has p_outcome, numbered from 1, and published is p_published.
create function pg_temp.landed(p_result jsonb, p_outcomes text[], p_published boolean) returns void language plpgsql as $$
begin
	if p_result ->> 'schema' is distinct from 'qorpera.folder-commit/v1' or (p_result ->> 'published')::boolean is distinct from p_published
		or jsonb_array_length(p_result -> 'units') <> cardinality(p_outcomes) then raise exception 'Landed: %', p_result; end if;
	for i in 1..cardinality(p_outcomes) loop
		if (p_result -> 'units' -> (i - 1) ->> 'unit')::integer is distinct from i
			or p_result -> 'units' -> (i - 1) ->> 'outcome' is distinct from p_outcomes[i] then
			raise exception 'Unit %: %', i, p_result; end if;
	end loop;
end $$;

-- A session publishes: its objects (one in a folder that is missing), X onto the version it read, and a new reflog
-- below folders that are missing. The folders are made first and the answer lists the caller's units only. The lease
-- has ended, and the next take reads the new versions. The same publish again is a replay.
do $$
declare g text := 'code/acme/app/repo.git/'; l jsonb := pg_temp.take(pg_temp.cv(1), 'code/acme/app/repo.git/refs/heads/main');
	l2 jsonb; u jsonb; r jsonb; v_seq bigint;
begin
	u := jsonb_build_array(pg_temp.w(g || 'objects/ab/' || repeat('d', 38), pg_temp.stage('git-object-d')),
		pg_temp.w(g || 'objects/cd/' || repeat('e', 38), pg_temp.stage('git-object-e')),
		pg_temp.w(g || 'refs/heads/main', pg_temp.stage('git-ref-1'), l -> 'versions' ->> 'file'),
		pg_temp.w(g || 'logs/refs/heads/main', pg_temp.stage('git-log-1')));
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-1', u);
	perform pg_temp.landed(r, array['saved','saved','saved','saved'], true);
	if r -> 'units' -> 2 ->> 'path' is distinct from g || 'refs/heads/main' or r ->> 'replay' is distinct from 'false'
		or pg_temp.leased(l) or pg_temp.ver(g || 'refs/heads/main') = l -> 'versions' ->> 'file'
		or (select kind from public.qorpera_folder_entries where environment_id = '63200000-0000-4000-8000-000000000020'
			and key_sha256 = extensions.digest(g || 'logs/refs/heads', 'sha256')) is distinct from 'folder' then
		raise exception 'Publish: %', r; end if;
	v_seq := (r ->> 'seq')::bigint;
	l2 := pg_temp.take(pg_temp.cv(2), g || 'refs/heads/main');
	if l2 -> 'versions' ->> 'file' is distinct from pg_temp.ver(g || 'refs/heads/main')
		or l2 -> 'versions' ->> 'reflog' is null
		or l2 -> 'versions' ->> 'reflog' is distinct from pg_temp.ver(g || 'logs/refs/heads/main') then
		raise exception 'Next take: %', l2; end if;
	perform public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(pg_temp.cv(2)));
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-1', u);
	perform pg_temp.landed(r, array['saved','saved','saved','saved'], true);
	if r ->> 'replay' is distinct from 'true' or (r ->> 'seq')::bigint is distinct from v_seq then raise exception 'Replay: %', r; end if;
end $$;

-- X and logs/X land together. When the platform moved X after the take, or logs/X, both are 'version_changed' and the
-- lease stays; the objects land anyway. Publishing again onto the versions it reads now lands both.
do $$
declare g text := 'code/acme/app/repo.git/'; x text := 'code/acme/app/repo.git/refs/heads/main';
	lx text := 'code/acme/app/repo.git/logs/refs/heads/main'; l jsonb := pg_temp.take(pg_temp.cv(1), x); r jsonb; v_log text;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'git-move-x-1', jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-p'), pg_temp.ver(x))));
	perform pg_temp.expect(r, 1, 'saved');
	v_log := pg_temp.ver(lx);
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-2', jsonb_build_array(
		pg_temp.w(g || 'objects/ab/' || repeat('f', 38), pg_temp.stage('git-object-f')),
		pg_temp.w(x, pg_temp.stage('git-ref-2'), l -> 'versions' ->> 'file'), pg_temp.w(lx, pg_temp.stage('git-log-2'), v_log)));
	perform pg_temp.landed(r, array['saved','conflict','conflict'], false);
	if r -> 'units' -> 1 ->> 'reason' is distinct from 'version_changed' or r -> 'units' -> 2 ->> 'reason' is distinct from 'version_changed'
		or pg_temp.ver(lx) is distinct from v_log or not pg_temp.leased(l) or pg_temp.ver(g || 'objects/ab/' || repeat('f', 38)) is null then
		raise exception 'X moved: %', r; end if;
	-- The reflog moved instead.
	r := pg_temp.commit('{"kind":"platform"}', 'git-move-log-1', jsonb_build_array(pg_temp.w(lx, pg_temp.stage('git-log-p'), v_log)));
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-3', jsonb_build_array(
		pg_temp.w(x, pg_temp.stage('git-ref-2'), pg_temp.ver(x)), pg_temp.w(lx, pg_temp.stage('git-log-2'), v_log)));
	perform pg_temp.landed(r, array['conflict','conflict'], false);
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'version_changed' or not pg_temp.leased(l) then
		raise exception 'logs/X moved: %', r; end if;
	-- X written onto a version with no expectedVersion is a version moved, too.
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-4', jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-2'))));
	perform pg_temp.landed(r, array['conflict'], false);
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-publish-5', jsonb_build_array(
		pg_temp.w(x, pg_temp.stage('git-ref-2'), pg_temp.ver(x)), pg_temp.w(lx, pg_temp.stage('git-log-2'), pg_temp.ver(lx))));
	perform pg_temp.landed(r, array['saved','saved'], true);
	if pg_temp.leased(l) then raise exception 'The lease stayed after its publish'; end if;
end $$;

-- An object that is not saved (here its bytes are unverified) keeps X and logs/X from landing: both are
-- 'git_objects_unsaved' and the lease stays. The objects are decided first wherever the caller names them, the answer
-- keeps the caller's order, and the objects that were saved stay. Once every object is saved, the publish lands.
do $$
declare g text := 'code/acme/app/repo.git/'; x text := 'code/acme/app/repo.git/refs/heads/main';
	lx text := 'code/acme/app/repo.git/logs/refs/heads/main'; l jsonb := pg_temp.take(pg_temp.cv(1), x);
	bad text := g || 'objects/cd/' || repeat('1', 38); good text := g || 'objects/cd/' || repeat('2', 38);
	v_x text := pg_temp.ver(x); v_log text := pg_temp.ver(lx); r jsonb;
begin
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-unsaved-1', jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-u'), v_x),
		pg_temp.w(bad, jsonb_build_object('manifestSha256', repeat('a', 64), 'fileSha256', repeat('b', 64), 'bytes', 1,
			'mediaType', 'text/plain', 'executable', false)),
		pg_temp.w(good, pg_temp.stage('git-object-g')), pg_temp.w(lx, pg_temp.stage('git-log-u'), v_log)));
	perform pg_temp.landed(r, array['refused','refused','saved','refused'], false);
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'git_objects_unsaved' or r -> 'units' -> 0 ->> 'path' is distinct from x
		or r -> 'units' -> 1 ->> 'reason' is distinct from 'bytes_unverified'
		or r -> 'units' -> 3 ->> 'reason' is distinct from 'git_objects_unsaved' or not pg_temp.leased(l)
		or pg_temp.ver(x) is distinct from v_x or pg_temp.ver(lx) is distinct from v_log or pg_temp.ver(bad) is not null
		or pg_temp.ver(good) is null then raise exception 'An object unsaved: %', r; end if;
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-unsaved-2', jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-u'), v_x),
		pg_temp.w(bad, pg_temp.stage('git-object-u')), pg_temp.w(good, pg_temp.stage('git-object-g')),
		pg_temp.w(lx, pg_temp.stage('git-log-u'), v_log)));
	perform pg_temp.landed(r, array['saved','saved','saved','saved'], true);
end $$;

-- Outside a publish a session still saves no ref (490), and the commit takes a git request only for its own commit
-- and its own view's lease.
do $$
declare x text := 'code/acme/app/repo.git/refs/heads/main'; l jsonb := pg_temp.take(pg_temp.cv(1), x); u jsonb;
begin
	u := jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-3'), pg_temp.ver(x)));
	perform pg_temp.refused(pg_temp.vcommit(pg_temp.cv(1), 'git-plain-1', u), array['git_lease_required']);
	perform set_config('qorpera.folder_git', jsonb_build_object('environmentId', '63200000-0000-4000-8000-000000000020',
		'operationKey', 'git-forged-1', 'leaseId', l ->> 'leaseId')::text, true);
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', pg_temp.cv(2), 'git-forged-1', u), '42501');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', pg_temp.cv(1), 'git-forged-2', u), '55000');
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(1), l, 'git-forged-1', u), '55000');
	perform set_config('qorpera.folder_git', jsonb_build_object('environmentId', '63200000-0000-4000-8000-000000000020',
		'operationKey', 'git-forged-3', 'leaseId', extensions.gen_random_uuid())::text, true);
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', pg_temp.cv(1), 'git-forged-3', u), '42501');
	perform set_config('qorpera.folder_git', '', true);
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(2), l, 'git-forged-4', u), '42501');
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(1),
		jsonb_build_object('leaseId', extensions.gen_random_uuid()), 'git-forged-5', u), '42501');
	perform public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(pg_temp.cv(1)));
end $$;

-- A release ends the lease. With no units it lands nothing, and again it is still released. With units it lands them
-- (a branch deleted with its reflog, under folders it makes), and it ends the lease when they conflict too.
do $$
declare g text := 'code/acme/app/repo.git/'; x text := 'code/acme/app/repo.git/refs/heads/topic/a';
	lx text := 'code/acme/app/repo.git/logs/refs/heads/topic/a'; l jsonb := pg_temp.take(pg_temp.cv(1), x); r jsonb;
begin
	r := pg_temp.release(pg_temp.cv(1), l);
	if r is distinct from '{"schema":"qorpera.folder-git-lease/v1","state":"released"}'::jsonb or pg_temp.leased(l)
		or pg_temp.release(pg_temp.cv(1), l) is distinct from r then raise exception 'Release: %', r; end if;
	l := pg_temp.take(pg_temp.cv(1), x);
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-topic-1', jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-t')),
		pg_temp.w(lx, pg_temp.stage('git-log-t'))));
	perform pg_temp.landed(r, array['saved','saved'], true);
	l := pg_temp.take(pg_temp.cv(1), x);
	r := pg_temp.release(pg_temp.cv(1), l, jsonb_build_array(pg_temp.del(x), pg_temp.del(lx)));
	perform pg_temp.landed(r, array['saved','saved'], true);
	if pg_temp.leased(l) or pg_temp.ver(x) is not null or pg_temp.ver(lx) is not null then raise exception 'Deleted: %', r; end if;
	-- A release that conflicts still ends the lease.
	l := pg_temp.take(pg_temp.cv(1), g || 'refs/heads/main');
	r := pg_temp.release(pg_temp.cv(1), l, jsonb_build_array(pg_temp.w(g || 'logs/refs/heads/main', pg_temp.stage('git-log-r'))));
	perform pg_temp.landed(r, array['conflict'], false);
	if pg_temp.leased(l) then raise exception 'The lease stayed after its release'; end if;
	-- Another view's lease is not this view's to release.
	l := pg_temp.take(pg_temp.cv(2), g || 'refs/heads/main');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L)', pg_temp.cv(1), l), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_git_lease_release(%L, %L, null)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(pg_temp.cv(2))), '22023');
	perform pg_temp.release(pg_temp.cv(2), l);
end $$;

-- A publish or a release with units answers as the first time again once its view may do no new work: while the
-- company is paused, and after the view has closed (its leases gone). New work then raises.
create function pg_temp.replayed(p_first jsonb, p_again jsonb) returns boolean language sql as $$
	select (p_again ->> 'replay')::boolean is true and p_again ->> 'seq' = p_first ->> 'seq' and p_again -> 'units' = p_first -> 'units'
		and p_again -> 'published' = p_first -> 'published'
$$;
do $$
declare g text := 'code/acme/app/repo.git/'; x text := 'code/acme/app/repo.git/refs/heads/topic/b';
	lx text := 'code/acme/app/repo.git/logs/refs/heads/topic/b'; v jsonb := pg_temp.cv(1); l jsonb; l2 jsonb; l3 jsonb;
	u jsonb; u2 jsonb; u3 jsonb; r jsonb; r2 jsonb;
begin
	l := pg_temp.take(v, x);
	l3 := pg_temp.take(v, g || 'refs/heads/topic/c');
	u := jsonb_build_array(pg_temp.w(x, pg_temp.stage('git-ref-b')), pg_temp.w(lx, pg_temp.stage('git-log-b')));
	r := pg_temp.publish(v, l, 'git-replay-1', u);
	perform pg_temp.landed(r, array['saved','saved'], true);
	l2 := pg_temp.take(v, x);
	u2 := jsonb_build_array(pg_temp.del(x), pg_temp.del(lx));
	r2 := pg_temp.release(v, l2, u2);
	perform pg_temp.landed(r2, array['saved','saved'], true);
	u3 := jsonb_build_array(pg_temp.w(g || 'refs/heads/topic/c', pg_temp.stage('git-ref-c')));
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		'63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000001', 'test'));
	if not pg_temp.replayed(r, pg_temp.publish(v, l, 'git-replay-1', u)) or not pg_temp.replayed(r2, pg_temp.release(v, l2, u2)) then
		raise exception 'Paused replay: %', pg_temp.publish(v, l, 'git-replay-1', u); end if;
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', v, l3, 'git-replay-2', u3), '55000');
	perform pg_temp.fx('delete from public.qorpera_company_execution_pauses where profile_id = ''63200000-0000-4000-8000-000000000010''');
	perform public.qorpera_folder_view_close((v ->> 'viewId')::uuid, v ->> 'pass');
	if not pg_temp.replayed(r, pg_temp.publish(v, l, 'git-replay-1', u)) or not pg_temp.replayed(r2, pg_temp.release(v, l2, u2)) then
		raise exception 'Closed replay: %', pg_temp.publish(v, l, 'git-replay-1', u); end if;
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', v, l3, 'git-replay-3', u3), '42501');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', v, l3, u3), '42501');
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;

-- A publish's units are the lease's X (written), its logs/X, and objects of its repository written; a release's are X's
-- and logs/X's. Anything else, a key twice, or a publish without X lands nothing.
do $$
declare g text := 'code/acme/app/repo.git/'; x text := 'code/acme/app/repo.git/refs/heads/main'; l jsonb := pg_temp.take(pg_temp.cv(1), x);
	o jsonb := pg_temp.w(g || 'objects/ab/' || repeat('9', 38), pg_temp.stage('git-object-9')); xw jsonb;
	bad jsonb; h jsonb := pg_temp.open('code_host', '{}'); pair text[];
begin
	xw := pg_temp.w(x, pg_temp.stage('git-ref-4'), pg_temp.ver(x));
	foreach bad in array array['null'::jsonb, '[]', '{"op":"write"}', jsonb_build_array(xw, 1), jsonb_build_array(o),
		jsonb_build_array(xw, pg_temp.w(g || 'HEAD', pg_temp.stage('git-head'))),
		jsonb_build_array(xw, pg_temp.w('code/acme/other/repo.git/objects/ab/' || repeat('9', 38), pg_temp.stage('git-object-9'))),
		jsonb_build_array(xw, pg_temp.w(g || 'objects/info/alternates', pg_temp.stage('git-object-9'))),
		jsonb_build_array(xw, jsonb_build_object('op','mkdir','path',g || 'refs/heads/x')),
		jsonb_build_array(pg_temp.del(x)), jsonb_build_array(xw, pg_temp.w(upper(x), pg_temp.stage('git-ref-4'))),
		jsonb_build_array(xw, pg_temp.w(g || 'refs/heads/other', pg_temp.stage('git-ref-4')))] loop
		perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(1), l, 'git-bad-1', bad), '22023');
	end loop;
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', pg_temp.cv(1), l, jsonb_build_array(o)), '22023');
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(1), '{}', 'git-bad-2', jsonb_build_array(xw)),
		'22023');
	if not pg_temp.leased(l) then raise exception 'A bad publish ended the lease'; end if;
	perform pg_temp.release(pg_temp.cv(1), l);
	-- The lease's repository is matched as named: '_' and '%' (valid under code/) stand for no other character.
	foreach pair slice 1 in array array[['code/acme/app_1', 'code/acme/appx1'], ['code/acme/a%b', 'code/acme/a-x-b']] loop
		l := pg_temp.take(h, pair[1] || '/repo.git/refs/heads/main');
		perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', h, l, 'git-bad-3', jsonb_build_array(
			pg_temp.w(pair[1] || '/repo.git/refs/heads/main', pg_temp.stage('git-ref-4')),
			pg_temp.w(pair[2] || '/repo.git/objects/ab/' || repeat('9', 38), pg_temp.stage('git-object-9')))), '22023');
		if not pg_temp.leased(l) then raise exception 'Another repository''s object: %', pair; end if;
	end loop;
	perform public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(h));
end $$;

-- A publish that would land X without logs/X (here packed-refs, whose logs/ name is the platform's) lands nothing.
do $$
declare g text := 'code/acme/app/repo.git/'; l jsonb := pg_temp.take(pg_temp.cv(1), 'code/acme/app/repo.git/packed-refs');
	v text := pg_temp.ver('code/acme/app/repo.git/packed-refs'); r jsonb;
begin
	perform pg_temp.raises(format('select pg_temp.publish(%L, %L, %L, %L)', pg_temp.cv(1), l, 'git-split-1', jsonb_build_array(
		pg_temp.w(g || 'packed-refs', pg_temp.stage('git-packed'), v), pg_temp.w(g || 'logs/packed-refs', pg_temp.stage('git-log-p')))),
		'22023');
	if pg_temp.ver(g || 'packed-refs') is distinct from v or not pg_temp.leased(l) then raise exception 'A split landed'; end if;
	r := pg_temp.publish(pg_temp.cv(1), l, 'git-split-2', jsonb_build_array(pg_temp.w(g || 'packed-refs', pg_temp.stage('git-packed'), v)));
	perform pg_temp.landed(r, array['saved'], true);
end $$;
