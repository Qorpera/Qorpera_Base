-- @fixture 490_folder_git_rules.test.sql until "-- A coding session writes its own worktree"
-- Only the platform moves main where a repository is kept in Qorpera (migration 20260930707000; own code storage,
-- step 1). 490's fixture: the office, code/acme/app laid out by the platform, two coding sessions' views.
--   1. The mark, refs/qorpera/**, and its log are the platform's alone, key by key.
--   2. A copy of a GitHub repository (no mark) is as it was: a session takes the lease on main.
--   3. With the mark: a member's and a session's write of it are refused; a session's lease on main, packed-refs and
--      shallow is refused; its own branch and another ref of its own are held; another worker's branch is the other's.
--   4. After git's cleanup packed the mark into packed-refs and removed its file, the kernel's own record of the
--      repository (a coding session on it as one kept in Qorpera) keeps main the platform's.
-- And since 20260930720000 a member writes, restores and removes no ref there either (3, 4): only the platform moves
-- main. Where the repository is a copy of a GitHub one, a member's refs are as 490 has them.

create function pg_temp.take(p_view jsonb, p_path text) returns jsonb language sql as $$
	select public.qorpera_folder_git_lease_take('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path)
$$;
create function pg_temp.lease(p_view jsonb, p_path text, p_state text, p_reason text default null) returns void
language plpgsql as $$
declare r jsonb := pg_temp.take(p_view, p_path);
begin
	if r ->> 'state' is distinct from p_state or (p_state = 'refused' and r ->> 'reason' is distinct from p_reason) then
		raise exception 'Lease on %: expected % (%), got %', p_path, p_state, p_reason, r; end if;
end $$;

-- 1. The rule, key by key -------------------------------------------------------------------------------------------
do $$
declare w uuid := '63200000-0000-4000-8000-0000000000c1'; g text := 'code/acme/app/repo.git/'; v_wrong text;
	v_def text := pg_get_functiondef('public.qorpera_folder_git_refusal(text,text,text,uuid)'::regprocedure);
begin
	if strpos(v_def, '20260930707000') = 0 or strpos(pg_get_functiondef(
			'public.qorpera_folder_git_lease_take(uuid,jsonb,text)'::regprocedure), '20260930707000') = 0 then
		raise exception 'A rule lost its marker'; end if;
	select string_agg(format('%s %s %s: %s', t.k, t.op, t.cls, coalesce(public.qorpera_folder_git_refusal(t.k, t.op, t.cls,
			case when t.own then w end), 'null')), '; ') into v_wrong
	from (values
		(g || 'refs/qorpera/kept-here', 'write', 'platform', false, null),
		(g || 'refs/qorpera/kept-here', 'delete', 'platform', false, null),
		(g || 'refs/qorpera/kept-here', 'write', 'member', false, 'git_platform_only'),
		(g || 'refs/qorpera/kept-here', 'delete', 'member', false, 'git_platform_only'),
		(g || 'refs/qorpera/kept-here', 'write', 'session', true, 'git_platform_only'),
		(g || 'refs/qorpera/kept-here', 'delete', 'session', true, 'git_platform_only'),
		(g || 'refs/qorpera/kept-here', 'write', 'session', false, 'git_platform_only'),
		(g || 'refs/qorpera', 'rmdir', 'member', false, 'git_platform_only'),
		(g || 'refs/qorpera', 'mkdir', 'session', true, 'git_platform_only'),
		(g || 'refs/qorpera/other', 'write', 'session', true, 'git_platform_only'),
		(g || 'logs/refs/qorpera/kept-here', 'write', 'session', true, 'git_platform_only'),
		(g || 'logs/refs/qorpera/kept-here', 'write', 'member', false, 'git_platform_only'),
		-- The sessions' own branches are under refs/heads/qorpera: as before.
		(g || 'refs/heads/qorpera/coding/' || w::text, 'write', 'session', true, 'git_lease_required'),
		(g || 'refs/heads/qorpera/coding', 'mkdir', 'session', true, null),
		(g || 'refs/heads/main', 'write', 'session', true, 'git_lease_required'),
		(g || 'refs/heads/main', 'write', 'member', false, null),
		(g || 'refs/qorperax', 'write', 'member', false, null)) t(k, op, cls, own, want)
	where public.qorpera_folder_git_refusal(t.k, t.op, t.cls, case when t.own then w end) is distinct from t.want;
	if v_wrong is not null then raise exception 'git_refusal: %', v_wrong; end if;
end $$;

-- 2. A copy of a GitHub repository: as it was ---------------------------------------------------------------------------
do $$
declare g text := 'code/acme/app/repo.git/'; r jsonb;
begin
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/main', 'held');
	perform pg_temp.lease(pg_temp.cv(1), g || 'packed-refs', 'held');
	r := public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(pg_temp.cv(1)));
	if exists (select 1 from public.qorpera_folder_git_leases) then raise exception 'Leases stayed: %', r; end if;
end $$;

-- 3. Kept in Qorpera ---------------------------------------------------------------------------------------------------
do $$
declare g text := 'code/acme/app/repo.git/'; a jsonb := pg_temp.stage('git-alpha'); b jsonb := pg_temp.stage('git-beta');
	w1 text := pg_temp.wk(1); w2 text := pg_temp.wk(2); r jsonb; v_mark text; v_main text;
begin
	-- The platform (the code host's start) writes the mark.
	r := pg_temp.commit('{"kind":"platform"}', 'kept-here', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',g || 'refs/qorpera'),
		jsonb_build_object('op','write','path',g || 'refs/qorpera/kept-here','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	v_mark := pg_temp.ver(g || 'refs/qorpera/kept-here');
	-- A member cannot replace or remove it, and neither can a session, with or without a lease.
	r := pg_temp.commit(pg_temp.member(1), 'kept-member', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'refs/qorpera/kept-here','file',b,'expectedVersion',v_mark),
		jsonb_build_object('op','delete','path',g || 'refs/qorpera/kept-here','expectedVersion',v_mark)));
	perform pg_temp.refused(r, array['git_platform_only','git_platform_only']);
	r := pg_temp.vcommit(pg_temp.cv(1), 'kept-session', jsonb_build_array(
		jsonb_build_object('op','delete','path',g || 'refs/qorpera/kept-here','expectedVersion',v_mark)));
	perform pg_temp.refused(r, array['git_platform_only']);
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/qorpera/kept-here', 'refused', 'git_platform_only');
	if pg_temp.ver(g || 'refs/qorpera/kept-here') is distinct from v_mark then raise exception 'The mark changed'; end if;
	-- 20260930720000: with the mark there, a member writes, restores and removes no ref, and neither of the two files
	-- that would move main for every reader: not main, not a new branch, not the folder with what it holds.
	v_main := pg_temp.ver(g || 'refs/heads/main');
	r := pg_temp.commit(pg_temp.member(1), 'kept-member-refs', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'refs/heads/main','file',b,'expectedVersion',v_main),
		jsonb_build_object('op','delete','path',g || 'refs/heads/main','expectedVersion',v_main),
		jsonb_build_object('op','write','path',g || 'refs/heads/feature','file',b),
		jsonb_build_object('op','write','path',g || 'packed-refs','file',b,'expectedVersion',pg_temp.ver(g || 'packed-refs')),
		jsonb_build_object('op','write','path',g || 'shallow','file',b),
		jsonb_build_object('op','delete','path',g || 'refs/heads')));
	perform pg_temp.refused(r, array['git_platform_only','git_platform_only','git_platform_only','git_platform_only',
		'git_platform_only','git_platform_only']);
	if pg_temp.ver(g || 'refs/heads/main') is distinct from v_main then raise exception 'A member moved main'; end if;
	-- Main, and the two files that would move it for every reader: never a session's lease, in any spelling.
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/main', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(2), g || 'REFS/heads/MAIN', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(1), g || 'packed-refs', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(1), g || 'shallow', 'refused', 'git_platform_only');
	if exists (select 1 from public.qorpera_folder_git_leases) then raise exception 'A refused lease left a row'; end if;
	-- Its own branch, and another ref it makes, are held as before; another worker's branch is that worker's.
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || w1, 'held');
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/feature', 'held');
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/tags/v1', 'held');
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/main-2', 'held');
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || w2, 'refused', 'git_other_worker');
	perform pg_temp.lease(pg_temp.cv(2), g || 'refs/heads/qorpera/coding/' || w2, 'held');
end $$;

-- 4. After git's cleanup ------------------------------------------------------------------------------------------------
do $$
declare g text := 'code/acme/app/repo.git/'; b jsonb := pg_temp.stage('git-beta'); w1 text := pg_temp.wk(1); r jsonb;
begin
	-- The cleanup (the platform's) packs the mark into packed-refs and removes its file. With no record of the
	-- repository as one kept in Qorpera, nothing would tell it from a GitHub copy: main could be leased again.
	r := pg_temp.commit('{"kind":"platform"}', 'kept-packed', jsonb_build_array(
		jsonb_build_object('op','delete','path',g || 'refs/qorpera/kept-here','expectedVersion',pg_temp.ver(g || 'refs/qorpera/kept-here')),
		jsonb_build_object('op','write','path',g || 'packed-refs','file',b,'expectedVersion',pg_temp.ver(g || 'packed-refs'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.ver(g || 'refs/qorpera/kept-here') is not null then raise exception 'The mark''s file stayed'; end if;
	perform pg_temp.lease(pg_temp.cv(2), g || 'refs/heads/main', 'held');
	r := public.qorpera_folder_git_leases_drop('63200000-0000-4000-8000-000000000020', pg_temp.vactor(pg_temp.cv(2)));
	-- (And a member's write of main is the member's again, for the same reason.)
	if public.qorpera_folder_git_unit_refusal('63200000-0000-4000-8000-000000000020', '{"op":"write"}', g || 'refs/heads/main',
		null, 'member', null) is not null then raise exception 'A member''s main with no record and no mark'; end if;
	-- The kernel's record: the sessions are on acme/app as a repository kept in Qorpera (a dispatch wrote them so).
	-- (With the agent's grant of it, which a dispatch writes too: a session without one loses its view.)
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		'{"host":"qorpera","owner":"acme","name":"app","baseBranch":"main"}', true);
	update public.qorpera_coding_sessions set repository = jsonb_set(repository, '{host}', '"qorpera"')
	where environment_id = '63200000-0000-4000-8000-000000000020' and repository ->> 'owner' = 'acme' and repository ->> 'name' = 'app';
	perform set_config('session_replication_role', 'origin', true);
	-- (And the repository's row in the registry, which such a session's insert writes: 20260930710000.)
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	select e.id, e.profile_id, 'acme', 'app' from public.qorpera_company_environments e
	where e.id = '63200000-0000-4000-8000-000000000020';
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/main', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(2), g || 'refs/heads/main', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(1), g || 'packed-refs', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(1), g || 'shallow', 'refused', 'git_platform_only');
	perform pg_temp.lease(pg_temp.cv(1), g || 'refs/heads/qorpera/coding/' || w1, 'held');
	-- Another place of the same company, with no record and no mark, is not held back by this rule.
	r := pg_temp.take(pg_temp.cv(1), 'code/acme/other/repo.git/refs/heads/main');
	if r ->> 'reason' is not distinct from 'git_platform_only' then raise exception 'Another place: %', r; end if;
	-- 20260930720000: the registry's row keeps a member from main and the two files too, with the mark's file gone.
	r := pg_temp.commit(pg_temp.member(1), 'packed-member-refs', jsonb_build_array(
		jsonb_build_object('op','write','path',g || 'refs/heads/main','file',b,'expectedVersion',pg_temp.ver(g || 'refs/heads/main')),
		jsonb_build_object('op','write','path',g || 'packed-refs','file',b,'expectedVersion',pg_temp.ver(g || 'packed-refs'))));
	perform pg_temp.refused(r, array['git_platform_only','git_platform_only']);
	if public.qorpera_folder_git_unit_refusal('63200000-0000-4000-8000-000000000020', '{"op":"write"}',
		'code/acme/other/repo.git/refs/heads/main', null, 'member', null) is not null then
		raise exception 'A member''s main in another place'; end if;
end $$;
