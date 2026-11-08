-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- Own code storage, slice 1 (migration 20260930670000): a coding session on a repository kept in Qorpera (host
-- qorpera), with no GitHub. 928's fixture: Alice's run for the owner, on the owner's own codex-cli login, and Alice's
-- todo fix-login with its folder.
--   1. The repository's rules: lower-case owner and name, GitHub's unchanged.
--   2. No executor anywhere: refused as before. With one serving another company, the first dispatch enrolls this
--      company with it (its node's settings copied) and writes Alice's grant of the repository; no operator step.
--   3. One place under code/ never holds both: a GitHub grant's place refuses a repository kept in Qorpera there, and a
--      repository kept in Qorpera refuses a GitHub dispatch at its place. A grant an operator turned off stays off.
--   4. The completion: no pull request; a succeeded turn may say where it landed, as its one artifact, which the
--      agent's report and summary carry.

create function pg_temp.own_repo(p_owner text default 'company', p_name text default 'shop') returns jsonb language sql
immutable as $$
	select jsonb_build_object('host', 'qorpera', 'owner', p_owner, 'name', p_name, 'baseBranch', 'main')
$$;
create function pg_temp.own_brief(p_id uuid, p_repository jsonb default pg_temp.own_repo()) returns jsonb language sql as $$
	select pg_temp.c3_brief(p_id) || jsonb_build_object('repository', p_repository)
$$;

-- 1. The repository's rules -------------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(public.qorpera_coding_repository_valid(pg_temp.own_repo())
		and public.qorpera_coding_repository_valid(pg_temp.own_repo('web-2', 'shop_v2.app'))
		and public.qorpera_coding_repository_valid(pg_temp.c3_repo()), 'kept in Qorpera, and on GitHub');
	perform pg_temp.base_assert(not public.qorpera_coding_repository_valid(pg_temp.own_repo('Company'))
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo('company', 'Shop'))
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo('company', 'shop.'))
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo('-company'))
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo() || '{"host":"gitlab.com"}')
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo() || '{"baseBranch":"a..b"}')
		-- One repository, one default branch (review 1544 r1): its identity, grant and main/ are one.
		and not public.qorpera_coding_repository_valid(pg_temp.own_repo() || '{"baseBranch":"dev"}')
		and public.qorpera_coding_repository_valid(pg_temp.c3_repo() || '{"baseBranch":"dev"}'),
		'upper case, a trailing dot, a leading hyphen, another host, a bad branch and another branch in Qorpera are refused');
end $$;

-- 2. Enrolment and the grant ------------------------------------------------------------------------------------------
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('91170000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('91170000-0000-4000-8000-000000000020', '91170000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000001');
do $$
declare
	v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'QorperaOS/agents/alice/todos/fix-login/shop';
	v_brief jsonb := pg_temp.own_brief('91170000-0000-4000-8000-0000000000b1'); v_result jsonb;
	e public.qorpera_coding_executors%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	-- No executor serves any company: refused as before, and nothing is enrolled.
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'own-refuse-1', v_folder, v_brief), v_brief,
		'No coding executor serves this company for codex');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_coding_executors), 'no executor yet');
	-- An executor serves another company, with its node's settings.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_configure_coding_executor('91170000-0000-4000-8000-000000000020', 'exec-1170', true, array['codex']);
	update public.qorpera_coding_executors set vm_policy = '{"providerId":"lxd"}', nas_policy = '{"schema":"nas"}',
		nas_machine_id_sha256 = repeat('5', 64), machine_sleep_after_seconds = 900
	where environment_id = '91170000-0000-4000-8000-000000000020';
	-- An owner in upper case is no repository kept in Qorpera: its brief does not parse, and nothing is written.
	v_result := pg_temp.c3_dispatch(v_alice, 'own-refuse-2', v_folder,
		pg_temp.own_brief('91170000-0000-4000-8000-0000000000b1', pg_temp.own_repo('Company')));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and not exists (select 1 from public.qorpera_runtime_workers where id = '91170000-0000-4000-8000-0000000000b1')
		and not exists (select 1 from public.qorpera_coding_executors
			where environment_id = '92400000-0000-4000-8000-000000000020'), 'an upper-case owner: ' || v_result::text);
	-- Accepted: no grant first. The company is enrolled with exec-1170, with its settings, and Alice holds the grant.
	v_result := pg_temp.c3_dispatch(v_alice, 'own-dispatch-1', v_folder, v_brief);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch saves: ' || v_result::text);
	select * into strict e from public.qorpera_coding_executors where environment_id = '92400000-0000-4000-8000-000000000020';
	perform pg_temp.base_assert(e.owner = 'exec-1170' and e.enabled and e.harnesses = array['codex']
		and e.vm_policy = '{"providerId":"lxd"}' and e.nas_policy = '{"schema":"nas"}'
		and e.nas_machine_id_sha256 = repeat('5', 64) and e.machine_sleep_after_seconds = 900, 'enrolled: ' || to_jsonb(e)::text);
	-- (The fixture's stand-in settings go again, as 928's executor has none, before its claim in 4.)
	update public.qorpera_coding_executors set vm_policy = null, nas_policy = null, nas_machine_id_sha256 = null
	where owner = 'exec-1170';
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_coding_repository_grants g
		where g.environment_id = '92400000-0000-4000-8000-000000000020' and g.staff_agent_id = '92400000-0000-4000-8000-000000000030'
			and g.repository = pg_temp.own_repo() and g.enabled), 'Alice''s grant of the company''s repository');
	s := pg_temp.c3_session('91170000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(s.phase = 'queued' and s.repository = pg_temp.own_repo()
		and s.branch = 'qorpera/coding/91170000-0000-4000-8000-0000000000b1', 'the session: ' || to_jsonb(s)::text);
	-- A second session on the same repository: the enrolment and the grant stay as they are.
	v_result := pg_temp.c3_dispatch(v_alice, 'own-dispatch-2', 'QorperaOS/agents/alice/todos/fix-login/shop-2',
		pg_temp.own_brief('91170000-0000-4000-8000-0000000000b2'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the second dispatch: ' || v_result::text);
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_executors
		where environment_id = '92400000-0000-4000-8000-000000000020') = 1 and (select count(*)
		from public.qorpera_coding_repository_grants where environment_id = '92400000-0000-4000-8000-000000000020') = 1, 'one of each');
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder',
		'QorperaOS/agents/alice/todos/fix-login/shop-2', 'operationKey', 'own-cancel-2'));
end $$;

-- 3. One place under code/, and a grant turned off ---------------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_folder text := 'QorperaOS/agents/alice/todos/fix-login/place';
	v_brief jsonb; v_result jsonb;
begin
	perform pg_temp.base_claims('service_role');
	-- The company's GitHub repository Qorpera/Qorpera_Base is at code/qorpera/qorpera_base.
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	v_brief := pg_temp.own_brief('91170000-0000-4000-8000-0000000000b3', pg_temp.own_repo('qorpera', 'qorpera_base'));
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'own-refuse-3', v_folder, v_brief), v_brief,
		'The company''s code already holds a copy of a GitHub repository at code/qorpera/qorpera_base; keep this repository in Qorpera under another owner or name');
	-- A GitHub repository at the place of the company's own code/company/shop: refused before its grant is looked for.
	v_brief := pg_temp.c3_brief('91170000-0000-4000-8000-0000000000b3')
		|| '{"repository":{"host":"github.com","owner":"Company","name":"Shop","baseBranch":"main"}}';
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'own-refuse-4', v_folder, v_brief), v_brief,
		'The company keeps a repository of its own in Qorpera at code/company/shop; use that one (host qorpera), or a GitHub repository with another owner or name');
	-- An operator turns Alice's grant of the company's repository off: it stays off.
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.own_repo(), false);
	v_brief := pg_temp.own_brief('91170000-0000-4000-8000-0000000000b3');
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'own-refuse-5', v_folder, v_brief), v_brief,
		'This agent''s work on that repository was turned off');
	-- The same repository on another branch is no way around it: no such repository (review 1544 r1 F1).
	v_result := pg_temp.c3_dispatch(v_alice, 'own-refuse-6', v_folder,
		pg_temp.own_brief('91170000-0000-4000-8000-0000000000b3', pg_temp.own_repo() || '{"baseBranch":"dev"}'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and not exists (select 1 from public.qorpera_runtime_workers where id = '91170000-0000-4000-8000-0000000000b3')
		and (select count(*) from public.qorpera_coding_repository_grants g
			where g.environment_id = '92400000-0000-4000-8000-000000000020' and g.repository ->> 'host' = 'qorpera') = 1,
		'another branch: ' || v_result::text);
	perform pg_temp.base_assert(not (select g.enabled from public.qorpera_coding_repository_grants g
		where g.environment_id = '92400000-0000-4000-8000-000000000020' and g.staff_agent_id = '92400000-0000-4000-8000-000000000030'
			and g.repository = pg_temp.own_repo()), 'still off');
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.own_repo(), true);
end $$;

-- 4. The completion ---------------------------------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('91170000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-1170', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
declare v_claim jsonb; v_token uuid; v_landed jsonb; w public.qorpera_runtime_workers%rowtype;
	s public.qorpera_coding_sessions%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '91170000-0000-4000-8000-0000000000b1'
		and v_claim -> 'repository' = pg_temp.own_repo(), 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('91170000-0000-4000-8000-0000000000b1')).lease_token;
	v_landed := jsonb_build_object('kind', 'landed', 'state', 'merged', 'branch', 'main', 'headSha', repeat('b', 40),
		'mainSha', repeat('c', 40));
	-- No pull request for a repository kept in Qorpera; a landing names the default branch and only it, two commits, and
	-- comes with a succeeded turn.
	perform pg_temp.base_error(format($q$select public.qorpera_complete_coding_turn(%L, %L, 'succeeded', 'Done.', null,
		'{"url":"https://github.com/company/shop/pull/1","number":1,"headSha":"%s"}')$q$,
		'91170000-0000-4000-8000-0000000000b1', v_token, repeat('b', 40)), '22023', 'Coding turn result is invalid');
	perform pg_temp.base_error(format($q$select public.qorpera_complete_coding_turn(%L, %L, 'succeeded', 'Done.', null, null,
		null, %L)$q$, '91170000-0000-4000-8000-0000000000b1', v_token, jsonb_build_array(v_landed || '{"branch":"dev"}')),
		'22023', 'Coding turn result is invalid');
	perform pg_temp.base_error(format($q$select public.qorpera_complete_coding_turn(%L, %L, 'succeeded', 'Done.', null, null,
		null, %L)$q$, '91170000-0000-4000-8000-0000000000b1', v_token, jsonb_build_array(v_landed || '{"state":"forced"}')),
		'22023', 'Coding turn result is invalid');
	perform pg_temp.base_error(format($q$select public.qorpera_complete_coding_turn(%L, %L, 'succeeded', 'Done.', null, null,
		null, %L)$q$, '91170000-0000-4000-8000-0000000000b1', v_token, jsonb_build_array(v_landed, v_landed)),
		'22023', 'Coding turn result is invalid');
	perform pg_temp.base_error(format($q$select public.qorpera_complete_coding_turn(%L, %L, 'failed', 'Broke.', null, null,
		null, %L)$q$, '91170000-0000-4000-8000-0000000000b1', v_token, jsonb_build_array(v_landed)),
		'22023', 'Coding turn result is invalid');
	-- The landing: the session's record keeps it, the agent's report carries it, and the summary says it in one line.
	-- The session's own words fill almost all of their 4000 bytes, two bytes a character: they are cut by bytes, whole
	-- characters only, so the platform's line always fits (review 1544 r1 F3).
	-- Its lines that read as the results file's headings (## Files) are one byte longer there (r2 F1): counted too.
	perform public.qorpera_complete_coding_turn('91170000-0000-4000-8000-0000000000b1', v_token, 'succeeded',
		'The shop has a cart. ' || repeat(E'## Files\n', 40) || repeat('å', 1800), null, null, null, jsonb_build_array(v_landed));
	w := pg_temp.c3_worker('91170000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'succeeded' and s.phase = 'completed' and s.pull_request is null
		and s.artifacts = jsonb_build_array(v_landed) and w.result -> 'landed' = v_landed and w.result -> 'pullRequest' = 'null'
		and octet_length(w.result ->> 'summary') + cardinality(string_to_array(w.result ->> 'summary', E'\n')) <= 4000
		and w.result ->> 'summary' like 'The shop has a cart. ## Files%'
		and w.result ->> 'summary' like E'%å\n\nQorpera landed this commit on main, merged with what it got '
			|| 'meanwhile: main is at cccccccccccc, and the files are in the company folder at code/company/shop/main/.',
		'the landed turn: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert((select e.body ->> 'summary' from public.qorpera_coding_session_events e where e.worker_id = w.id
		and e.kind = 'finished') = w.result ->> 'summary'
		and not exists (select 1 from public.qorpera_coding_session_events e where e.worker_id = w.id and e.kind = 'published'),
		'its finished event, and no publication');
end $$;
