-- @fixture 490_folder_git_rules.test.sql until "-- A coding session writes its own worktree"
-- git's old objects and the history view (20260930446400; F3 step 5b, part 4: deploy/first-node/RUNTIME-FOLDER-CODING-
-- MACHINES.md, "Code areas and git"). A version under a repo.git's objects/ (by key) goes 7 days after it ended (a delete,
-- a write over it, a move away), once, in batches, and its bytes wait for the folder's GC, whose claim drops them while
-- something roots them. Current objects, refs and worktree files keep every version. A member's history shows a change
-- set's repo.git paths as one line. The office, code/acme/app and the helpers are 490's. The race with the upload
-- intents' sweep is 532's.

-- The history keeps every marker; the expiry is no role's and runs every minute.
do $$
declare v_def text := pg_get_functiondef('public.qorpera_member_folder_history(uuid,bigint,integer)'::regprocedure);
begin
	if strpos(v_def, '20260930446400') = 0 or strpos(v_def, 'C4 P27a (20260930013000)') = 0
		or strpos(v_def, 'C4 P33 (20260930013200)') = 0 or strpos(v_def, 'limit v_cap + 1') = 0 then
		raise exception 'The history lost a marker'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
			where has_function_privilege(r.role, 'public.qorpera_folder_git_versions_expire(integer)', 'EXECUTE')
				or has_function_privilege(r.role, 'public.qorpera_schedule_folder_git_expiry()', 'EXECUTE')
				or has_table_privilege(r.role, 'public.qorpera_folder_git_expiry', 'SELECT,INSERT,UPDATE,DELETE')) then
		raise exception 'The expiry is a role''s'; end if;
	if not public.qorpera_folder_gc_company('63200000-0000-4000-8000-000000000010') then
		raise exception 'Folder GC does not serve the office'; end if;
end $$;
do $$
declare v jsonb;
begin
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_folder_git_expiry() ->> 'scheduled' is distinct from 'false' then
			raise exception 'The expiry claimed a schedule without pg_cron'; end if;
		-- A stand-in with pg_cron's schedule-by-name contract (as 411).
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user, unique (jobname, username));
		create table cron.job_run_details(runid bigint generated always as identity primary key, jobid bigint, end_time timestamptz);
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v := public.qorpera_schedule_folder_git_expiry();
	if v ->> 'scheduled' is distinct from 'true' or jsonb_array_length(v -> 'jobs') <> 2
		or public.qorpera_schedule_folder_git_expiry() -> 'jobs' <> v -> 'jobs'
		or (select schedule from cron.job where jobname = 'qorpera-folder-git-expiry') is distinct from '* * * * *'
		or (select command from cron.job where jobname = 'qorpera-folder-git-expiry')
			is distinct from 'select public.qorpera_folder_git_versions_expire()'
		or (select schedule from cron.job where jobname = 'qorpera-folder-git-expiry-log') is distinct from '41 3 * * *' then
		raise exception 'The expiry is not scheduled once, every minute, with a daily cleanup: %', v; end if;
end $$;

create temporary table expiry_seqs(name text primary key, seq bigint not null);
create function pg_temp.seq(p_name text) returns bigint language sql as $$ select seq from expiry_seqs where name = p_name $$;
-- A change set's versions made p_hours older.
create function pg_temp.age(p_name text, p_hours integer) returns void language sql as $$
	update public.qorpera_folder_path_versions set created_at = created_at - make_interval(hours => p_hours)
	where commit_id = (select id from public.qorpera_folder_commits
		where environment_id = '63200000-0000-4000-8000-000000000020' and seq = pg_temp.seq(p_name))
$$;
-- A path's versions left, oldest first.
create function pg_temp.versions(p_path text) returns text language sql as $$
	select coalesce(string_agg(op, ',' order by created_at, version), '') from public.qorpera_folder_path_versions
	where environment_id = '63200000-0000-4000-8000-000000000020'
		and key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
$$;
create function pg_temp.queued(p_file jsonb) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_object_gc
		where profile_id = '63200000-0000-4000-8000-000000000010' and sha256 = p_file ->> 'manifestSha256')
$$;
create function pg_temp.expired(p_result jsonb, p_scanned integer, p_expired integer) returns void language plpgsql as $$
begin
	if p_result ->> 'schema' is distinct from 'qorpera.folder-git-expiry/v1'
		or (p_result ->> 'scanned')::integer <> p_scanned or (p_result ->> 'expired')::integer <> p_expired then
		raise exception 'Expiry: % (expected % scanned, % expired)', p_result, p_scanned, p_expired; end if;
end $$;
-- Change set p_seq as member 1's history shows it: its item, or null when it is not listed.
create function pg_temp.item(p_seq bigint) returns jsonb language plpgsql as $$
declare v_page jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63200000-0000-4000-8000-000000000001')::text, true);
	v_page := public.qorpera_member_folder_history('63200000-0000-4000-8000-000000000020', p_seq + 1, 1);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return (select i from jsonb_array_elements(v_page -> 'items') i where (i ->> 'seq')::bigint = p_seq);
end $$;
-- Its paths, in order.
create function pg_temp.lines(p_item jsonb) returns text language sql as $$
	select string_agg(p.value ->> 'path', ',' order by p.position)
	from jsonb_array_elements(p_item -> 'paths') with ordinality as p(value, position)
$$;

-- The code host's gc, as the platform: two loose objects and a temporary pack (A); a prune of the first object, with a
-- ref and a worktree file written over (B1); the pack moved into place (B2). Once they are 7 days old a batch of 4 ends
-- the pruned object (its write and its delete); the next ends the temporary pack's write and its leaving. The bytes of
-- both wait for GC; the claim drops the pack's, rooted where they arrived. The ref, the worktree file and the current
-- objects keep every version, and a third run finds nothing. A repository spelled REPO.git expires the same way.
do $$
declare g text := 'code/acme/app/repo.git/'; d1 text := g || 'objects/ab/' || repeat('d', 38);
	e1 text := g || 'objects/ab/' || repeat('e', 38); tmp text := g || 'objects/pack/tmp_pack_1';
	pack text := g || 'objects/pack/pack-' || repeat('1', 40) || '.pack'; readme text := 'code/acme/app/main/README';
	o1 jsonb := pg_temp.stage('git-expire-one'); o2 jsonb := pg_temp.stage('git-expire-two');
	o3 jsonb := pg_temp.stage('git-expire-pack'); f jsonb := pg_temp.stage('git-expire-file'); r jsonb;
	upper1 text := 'code/acme/Tool/REPO.git/objects/AB/' || repeat('B', 38); o4 jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-a', jsonb_build_array(
		jsonb_build_object('op','write','path',d1,'file',o1), jsonb_build_object('op','write','path',e1,'file',o2),
		jsonb_build_object('op','write','path',tmp,'file',o3)));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	insert into expiry_seqs values ('a', (r ->> 'seq')::bigint);
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-b1', jsonb_build_array(
		jsonb_build_object('op','delete','path',d1,'expectedVersion',pg_temp.ver(d1)),
		jsonb_build_object('op','write','path',g || 'refs/heads/main','file',f,
			'expectedVersion',pg_temp.ver(g || 'refs/heads/main')),
		jsonb_build_object('op','write','path',readme,'file',f,'expectedVersion',pg_temp.ver(readme))));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	insert into expiry_seqs values ('b1', (r ->> 'seq')::bigint);
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-b2', jsonb_build_array(
		jsonb_build_object('op','move','from',tmp,'to',pack,'expectedVersion',pg_temp.ver(tmp))));
	perform pg_temp.expect(r, 1, 'saved');
	insert into expiry_seqs values ('b2', (r ->> 'seq')::bigint);

	-- Within 7 days nothing goes.
	perform pg_temp.age('a', 144); perform pg_temp.age('b1', 144); perform pg_temp.age('b2', 144);
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 0, 0);
	perform pg_temp.age('a', 72); perform pg_temp.age('b1', 60); perform pg_temp.age('b2', 48);
	-- Staging's upload intents root their objects for a day after they end.
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '63200000-0000-4000-8000-000000000010';

	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(4), 4, 2);
	if pg_temp.versions(d1) <> '' or pg_temp.versions(tmp) <> 'write,move_out' then
		raise exception 'The first batch: % / %', pg_temp.versions(d1), pg_temp.versions(tmp); end if;
	if not pg_temp.queued(o1) or pg_temp.queued(o2) or pg_temp.queued(o3) then
		raise exception 'The pruned object waits for GC'; end if;
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 2, 2);
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 0, 0);
	if pg_temp.versions(tmp) <> '' or pg_temp.versions(pack) <> 'move_in' or pg_temp.versions(e1) <> 'write'
			or pg_temp.versions(g || 'objects/ab/' || repeat('c', 38)) <> 'write'
			or pg_temp.versions(g || 'refs/heads/main') <> 'write,write' or pg_temp.versions(readme) <> 'write,write' then
		raise exception 'Versions left: tmp %, pack %, e1 %', pg_temp.versions(tmp), pg_temp.versions(pack),
			pg_temp.versions(e1); end if;
	if not pg_temp.queued(o3) or pg_temp.queued(f) then raise exception 'The temporary pack''s bytes wait for GC'; end if;
	-- A day later the claim finds them rooted by the pack and drops their row: it takes nothing in use.
	update public.qorpera_folder_object_gc set unreferenced_since = clock_timestamp() - interval '25 hours'
	where profile_id = '63200000-0000-4000-8000-000000000010' and sha256 = o3 ->> 'manifestSha256';
	if public.qorpera_folder_claim_object_gc(100, gen_random_uuid()) -> 'objects' @> jsonb_build_array(jsonb_build_object(
			'sha256', o3 ->> 'manifestSha256')) or pg_temp.queued(o3) then
		raise exception 'The claim took rooted bytes'; end if;

	-- A later prune of the second object goes 7 days after it, though the expiry already passed the object's write.
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-c', jsonb_build_array(
		jsonb_build_object('op','delete','path',e1,'expectedVersion',pg_temp.ver(e1))));
	perform pg_temp.expect(r, 1, 'saved');
	insert into expiry_seqs values ('c', (r ->> 'seq')::bigint);
	perform pg_temp.age('c', 144);
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 0, 0);
	if pg_temp.versions(e1) <> 'write,delete' then raise exception 'Kept 6 days: %', pg_temp.versions(e1); end if;
	perform pg_temp.age('c', 36);
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 1, 2);
	if pg_temp.versions(e1) <> '' or not pg_temp.queued(o2) then
		raise exception 'The second prune: %', pg_temp.versions(e1); end if;

	-- code/acme/Tool/REPO.git is a repository by key: its pruned object goes too (the objects/AB folder stays current).
	o4 := pg_temp.stage('git-expire-upper');
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-d',
		(select jsonb_agg(jsonb_build_object('op','mkdir','path',p) order by n) from unnest(array['code/acme/Tool',
			'code/acme/Tool/REPO.git', 'code/acme/Tool/REPO.git/objects', 'code/acme/Tool/REPO.git/objects/AB'])
			with ordinality t(p, n))
		|| jsonb_build_array(jsonb_build_object('op','write','path',upper1,'file',o4)));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	insert into expiry_seqs values ('d', (r ->> 'seq')::bigint);
	r := pg_temp.commit('{"kind":"platform"}', 'git-expire-e', jsonb_build_array(
		jsonb_build_object('op','delete','path',upper1,'expectedVersion',pg_temp.ver(upper1))));
	perform pg_temp.expect(r, 1, 'saved');
	insert into expiry_seqs values ('e', (r ->> 'seq')::bigint);
	perform pg_temp.age('d', 170); perform pg_temp.age('e', 170);
	perform pg_temp.expired(public.qorpera_folder_git_versions_expire(), 3, 2);
	if pg_temp.versions(upper1) <> '' or pg_temp.versions('code/acme/Tool/REPO.git/objects/AB') <> 'mkdir'
			or not pg_temp.queued(o4) then
		raise exception 'REPO.git: % / %', pg_temp.versions(upper1),
			pg_temp.versions('code/acme/Tool/REPO.git/objects/AB'); end if;

	perform pg_temp.raises('select public.qorpera_folder_git_versions_expire(0)', '22023');
	perform pg_temp.raises('select public.qorpera_folder_git_versions_expire(10001)', '22023');
	perform pg_temp.raises('select public.qorpera_folder_git_versions_expire(null)', '22023');
end $$;

-- A member's history: a change set's paths under repo.git (by key) are one line, the repository's folder at the change
-- set's first version there. The setup lists its 9 other paths and that line, with nothing more; a change set whose versions
-- all expired is not listed.
do $$
declare g text := 'code/acme/app/repo.git/'; d text := 'code/acme/app/'; w1 text := pg_temp.wk(1); w2 text := pg_temp.wk(2);
	f jsonb := pg_temp.stage('git-fold-file'); r jsonb; v_item jsonb; v_setup bigint;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'git-fold-1', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('f', 38),'file',pg_temp.stage('git-fold-object')),
		jsonb_build_object('op','write','path',d || 'main/NOTES','file',f),
		jsonb_build_object('op','write','path',g || 'refs/heads/fold','file',f),
		jsonb_build_object('op','write','path',g || 'objects/ab/' || repeat('9', 38),'file',pg_temp.stage('git-fold-object-2'))));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	v_item := pg_temp.item((r ->> 'seq')::bigint);
	if pg_temp.lines(v_item) is distinct from 'code/acme/app/repo.git,code/acme/app/main/NOTES'
		or v_item -> 'paths' -> 0 <> jsonb_build_object('path', 'code/acme/app/repo.git', 'op', 'write', 'kind', 'folder',
			'version', pg_temp.ver(g || 'objects/ab/' || repeat('f', 38)))
		or (v_item ->> 'more')::boolean then
		raise exception 'The fold: %', v_item; end if;

	select seq into v_setup from public.qorpera_folder_commits
	where environment_id = '63200000-0000-4000-8000-000000000020' and operation_key = 'git-setup';
	v_item := pg_temp.item(v_setup);
	if pg_temp.lines(v_item) is distinct from concat_ws(',', 'code/acme', 'code/acme/app', d || 'main', d || 'worktrees',
			d || 'worktrees/' || w1, d || 'worktrees/' || w2, 'code/acme/app/repo.git', d || 'main/README',
			d || 'worktrees/' || w1 || '/a.txt', d || 'worktrees/' || w2 || '/b.txt')
		or v_item -> 'paths' -> 6 ->> 'version' is distinct from pg_temp.ver('code/acme/app/repo.git')
		or (v_item ->> 'more')::boolean then
		raise exception 'The setup: %', v_item; end if;

	if pg_temp.lines(pg_temp.item(pg_temp.seq('b1'))) is distinct from 'code/acme/app/repo.git,' || d || 'main/README'
			or pg_temp.lines(pg_temp.item(pg_temp.seq('b2'))) is distinct from 'code/acme/app/repo.git'
			or pg_temp.item(pg_temp.seq('a')) is not null or pg_temp.item(pg_temp.seq('c')) is not null then
		raise exception 'The gc''s change sets: % / % / % / %', pg_temp.item(pg_temp.seq('a')),
			pg_temp.item(pg_temp.seq('b1')), pg_temp.item(pg_temp.seq('b2')), pg_temp.item(pg_temp.seq('c')); end if;

	-- REPO.git folds by key, spelled as its paths spell it.
	v_item := pg_temp.item(pg_temp.seq('d'));
	if pg_temp.lines(v_item) is distinct from 'code/acme/Tool,code/acme/Tool/REPO.git'
			or v_item -> 'paths' -> 1 ->> 'version' is distinct from pg_temp.ver('code/acme/Tool/REPO.git') then
		raise exception 'REPO.git''s change set: %', v_item; end if;
end $$;
