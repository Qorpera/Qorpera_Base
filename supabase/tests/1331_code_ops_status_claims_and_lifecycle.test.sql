-- @fixture 1210_code_change_record.test.sql until "-- The checks start here"

update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';

do $$
declare
	v_res jsonb;
	v_id uuid;
	v_claim jsonb;
	v_item jsonb;
	v_token uuid;
	v_profile uuid := '92400000-0000-4000-8000-000000000010';
	v_member uuid := '92400000-0000-4000-8000-000000000001';
	v_outsider uuid := '92400000-0000-4000-8000-000000000099';
	v_b1 uuid := '91170000-0000-4000-8000-0000000000b1';
	v_b2 uuid := '91170000-0000-4000-8000-0000000000b2';
	v_other_w uuid;
begin
	perform pg_temp.base_assert(
		public.qorpera_code_claimed_paths_valid(array['src/auth/**', 'packages/api/index.ts', '*.sql'])
		and not public.qorpera_code_claimed_paths_valid(array['/etc/passwd'])
		and not public.qorpera_code_claimed_paths_valid(array['src/../secret'])
		and not public.qorpera_code_claimed_paths_valid(array['src/a.ts', 'SRC/A.TS'])
		and not public.qorpera_code_claimed_paths_valid(array(select 'f/' || i::text from generate_series(1, 33) i)),
		'claimed_paths validation enforces relative paths, uniqueness and 32-item cap'
	);

	perform pg_temp.base_assert(
		public.qorpera_code_glob_overlaps('src/auth/**', 'src/auth/login.ts')
		and public.qorpera_code_glob_overlaps('src/auth', 'src/auth/login.ts')
		and not public.qorpera_code_glob_overlaps('src/auth', 'src/auth-v2/login.ts')
		and not public.qorpera_code_glob_overlaps('src/*.ts', 'src/*.md')
		and public.qorpera_code_glob_overlaps('src/*.ts', 'src/index.ts'),
		'glob overlap detection matches prefixes and globs without false positives'
	);

	update public.qorpera_coding_sessions
	set claimed_paths = array['src/auth/**', 'packages/api/routes.ts'], phase = 'running'
	where worker_id = v_b1;
	update public.qorpera_runtime_workers set state = 'active' where id = v_b1;

	perform pg_temp.base_claims('service_role');
	v_res := public.qorpera_folder_code_claim_overlaps(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'company', 'name', 'shop', 'baseBranch', 'main'),
			'claimedPaths', jsonb_build_array('src/auth/session.ts', 'docs/readme.md'),
			'excludeWorkerId', v_b2
		)
	);
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.code-claim-overlaps/v1'
		and jsonb_array_length(v_res -> 'overlaps') = 1
		and v_res -> 'overlaps' -> 0 ->> 'workerId' = v_b1::text
		and v_res -> 'overlaps' -> 0 -> 'matchedPaths' = '["src/auth/**"]'::jsonb,
		'claim overlap detects colliding active coding session: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_claim_overlaps(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'company', 'name', 'shop', 'baseBranch', 'main'),
			'claimedPaths', jsonb_build_array('docs/readme.md'),
			'excludeWorkerId', v_b2
		)
	);
	perform pg_temp.base_assert(
		jsonb_array_length(v_res -> 'overlaps') = 0,
		'disjoint claimedPaths produce zero overlaps: ' || v_res::text
	);

	insert into public.qorpera_code_changes(
		environment_id, owner, name, n, profile_id, kind, state, how,
		main_before, main_after, worker_id, sequence, title, notice,
		files_changed, paths, checks_state, checks, site_state, site
	)
	values
		(pg_temp.rec_here(), 'company', 'shop', 1, v_profile, 'landing', 'landed', 'fast-forward',
			pg_temp.rec_sha('s0'), pg_temp.rec_sha('s1'), v_b1, 1, 'Add auth login', 'Login works',
			1, '[{"path":"src/auth/login.ts","change":"added"}]'::jsonb,
			'passed', jsonb_build_object('schema', 'qorpera.code-checks/v1', 'commit', pg_temp.rec_sha('s1'), 'how', 'fast-forward', 'file', pg_temp.rec_sha('cf1'), 'ms', 100, 'copyMs', 10, 'checks', jsonb_build_array(jsonb_build_object('name', 'test', 'run', 'npm test', 'ms', 90)), 'changed', null, 'tries', 1),
			'made', jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', pg_temp.rec_sha('t1'), 'files', 2, 'bytes', 100, 'folder', 'dist', 'name', 'shop-app', 'title', 'Shop')),
		(pg_temp.rec_here(), 'company', 'shop', 2, v_profile, 'landing', 'landed', 'fast-forward',
			pg_temp.rec_sha('s1'), pg_temp.rec_sha('s2'), v_b1, 2, 'Update checkout', 'Checkout updated',
			1, '[{"path":"src/checkout/cart.ts","change":"changed"}]'::jsonb,
			'passed', jsonb_build_object('schema', 'qorpera.code-checks/v1', 'commit', pg_temp.rec_sha('s2'), 'how', 'fast-forward', 'file', pg_temp.rec_sha('cf2'), 'ms', 100, 'copyMs', 10, 'checks', jsonb_build_array(jsonb_build_object('name', 'test', 'run', 'npm test', 'ms', 90)), 'changed', null, 'tries', 1),
			'made', jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', pg_temp.rec_sha('t2'), 'files', 2, 'bytes', 120, 'folder', 'dist', 'name', 'shop-app', 'title', 'Shop')),
		(pg_temp.rec_here(), 'company', 'shop', 3, v_profile, 'landing', 'landed', 'merged',
			pg_temp.rec_sha('s2'), pg_temp.rec_sha('s3'), v_b2, 1, 'Fix header', null,
			1, '[{"path":"src/ui/header.tsx","change":"changed"}]'::jsonb,
			'none', null, null, null);
	update public.qorpera_code_repositories
	set last_change = 3, last_main = pg_temp.rec_sha('s3'), main_sha = pg_temp.rec_sha('s3')
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'shop';

	v_res := public.qorpera_folder_code_status(pg_temp.c3_alice(), 'company', 'shop');
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.code-repository-status/v1'
		and (v_res ->> 'registered')::boolean
		and (v_res ->> 'changesCount')::integer = 3
		and jsonb_array_length(v_res -> 'recentChanges') = 3
		and (v_res -> 'recentChanges' -> 0 ->> 'n')::integer = 3
		and (v_res -> 'queue' ->> 'running')::integer = 1
		and exists (
			select 1 from jsonb_array_elements(v_res -> 'sessions') s
			where s ->> 'workerId' = v_b1::text
				and s ->> 'phase' = 'running'
				and s -> 'claimedPaths' = '["src/auth/**","packages/api/routes.ts"]'::jsonb
				and s ->> 'worktree' = 'code/company/shop/worktrees/' || v_b1::text
		),
		'qorpera_folder_code_status returns sessions, claimedPaths, recentChanges and queue: ' || v_res::text
	);

	perform pg_temp.base_claims('authenticated', v_member);
	set local role authenticated;
	v_res := public.qorpera_code_repository_status(pg_temp.rec_here(), 'company', 'shop');
	reset role;
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.code-repository-status/v1'
		and (v_res ->> 'changesCount')::integer = 3,
		'company member can read qorpera_code_repository_status'
	);

	perform pg_temp.base_claims('authenticated', v_outsider);
	perform pg_temp.base_error(
		format('set local role authenticated; select public.qorpera_code_repository_status(%L, ''company'', ''shop'')', pg_temp.rec_here()),
		'42501',
		'Code unavailable'
	);
	reset role;

	perform pg_temp.base_claims('anon');
	perform pg_temp.base_error(
		format('set local role anon; select public.qorpera_code_repository_status(%L, ''company'', ''shop'')', pg_temp.rec_here()),
		'42501',
		'permission denied for function qorpera_code_repository_status'
	);
	reset role;

	perform pg_temp.base_claims('service_role');
	v_res := public.qorpera_folder_code_history(
		pg_temp.c3_alice(),
		jsonb_build_object('owner', 'company', 'name', 'shop', 'limit', 2)
	);
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.code-history/v1'
		and (v_res ->> 'total')::integer = 3
		and jsonb_array_length(v_res -> 'changes') = 2
		and (v_res ->> 'nextCursor')::integer = 2,
		'paginated history returns page 1 and nextCursor: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_history(
		pg_temp.c3_alice(),
		jsonb_build_object('owner', 'company', 'name', 'shop', 'cursor', 2, 'limit', 2)
	);
	perform pg_temp.base_assert(
		jsonb_array_length(v_res -> 'changes') = 1
		and (v_res -> 'changes' -> 0 ->> 'n')::integer = 1
		and v_res -> 'nextCursor' = 'null'::jsonb,
		'paginated history returns page 2 with null nextCursor: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_history(
		pg_temp.c3_alice(),
		jsonb_build_object('owner', 'company', 'name', 'shop', 'path', 'src/auth')
	);
	perform pg_temp.base_assert(
		(v_res ->> 'total')::integer = 1
		and (v_res -> 'changes' -> 0 ->> 'n')::integer = 1,
		'history path filter matches directory prefix: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_query(
		pg_temp.c3_alice(),
		jsonb_build_object('op', 'diff', 'owner', 'company', 'name', 'shop', 'from', 1, 'to', 2, 'statOnly', true)
	);
	v_id := (v_res ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued' and v_id is not null, 'query enqueued');

	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 10, array['undo','download','restore','query','lifecycle']);
	reset role;
	v_item := v_claim -> 'requests' -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(
		v_item ->> 'kind' = 'query'
		and v_item ->> 'op' = 'diff'
		and v_item -> 'query' ->> 'from' = pg_temp.rec_sha('s1')
		and v_item -> 'query' ->> 'to' = pg_temp.rec_sha('s2'),
		'query claim resolves change numbers to commit SHAs: ' || v_item::text
	);

	set local role service_role;
	v_res := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_id, v_token,
		jsonb_build_object('schema', 'qorpera.code-request-outcome/v1', 'state', 'done', 'result', 'ok',
			'data', jsonb_build_object('filesChanged', 1, 'stat', '1 file changed'))
	);
	reset role;
	perform pg_temp.base_assert(v_res ->> 'state' = 'recorded', 'query finished');
	v_res := public.qorpera_folder_code_request_v2(pg_temp.c3_alice(), v_id);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'done' and v_res ->> 'result' = 'ok' and (v_res -> 'data' ->> 'filesChanged')::integer = 1,
		'code_request_v2 returns query data: ' || v_res::text
	);

	v_res := public.qorpera_folder_request_code_undo_v2(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'undo-dry-1',
			'owner', 'company',
			'name', 'shop',
			'change', 3,
			'andLater', false,
			'dryRun', true,
			'reason', 'Preview reverting header change'
		)
	);
	v_id := (v_res ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued', 'dryRun undo queued');

	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 10, array['undo','download','restore','query','lifecycle']);
	reset role;
	v_item := v_claim -> 'requests' -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(
		(v_item ->> 'dryRun')::boolean
		and v_item -> 'priorSite' ->> 'tree' = pg_temp.rec_sha('t2')
		and (v_item -> 'priorSite' ->> 'change')::integer = 2,
		'v2 undo claim carries dryRun and priorSite metadata: ' || v_item::text
	);

	set local role service_role;
	v_res := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_id, v_token,
		jsonb_build_object('schema', 'qorpera.code-request-outcome/v1', 'state', 'done', 'result', 'dry_run',
			'clean', true, 'mainBefore', pg_temp.rec_sha('s3'), 'filesChanged', 1, 'wouldRevert', jsonb_build_array(3),
			'matchesBeforeTree', true, 'checksFilePresent', false)
	);
	reset role;
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'recorded' and v_res -> 'change' = 'null'::jsonb
		and (select count(*) from public.qorpera_code_changes where owner = 'company' and name = 'shop') = 3,
		'dryRun undo does not write a change row'
	);

	v_res := public.qorpera_folder_request_code_undo_v2(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'undo-range-1',
			'owner', 'company',
			'name', 'shop',
			'change', 2,
			'toChange', 3,
			'runChecks', true,
			'reason', 'Revert changes 2 and 3'
		)
	);
	v_id := (v_res ->> 'requestId')::uuid;
	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 10, array['undo','download','restore','query','lifecycle']);
	v_item := v_claim -> 'requests' -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(
		jsonb_array_length(v_item -> 'targets') = 2
		and (v_item -> 'targets' -> 0 ->> 'n')::integer = 3
		and (v_item -> 'targets' -> 1 ->> 'n')::integer = 2
		and (v_item ->> 'runChecks')::boolean
		and (v_item ->> 'priorVerifiedChange')::integer = 1
		and v_item -> 'priorSite' ->> 'tree' = pg_temp.rec_sha('t1'),
		'range undo claim includes targets newest-first, priorVerifiedChange, and priorSite at change 1: ' || v_item::text
	);
	v_res := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_id, v_token,
		jsonb_build_object(
			'schema', 'qorpera.code-request-outcome/v1',
			'state', 'done',
			'result', 'undone',
			'mainBefore', pg_temp.rec_sha('s3'),
			'mainAfter', pg_temp.rec_sha('s4'),
			'filesChanged', 2,
			'paths', '[{"path":"src/checkout/cart.ts","change":"changed"},{"path":"src/ui/header.tsx","change":"changed"}]'::jsonb,
			'pathsMore', 0,
			'matchesBeforeTree', true,
			'checksVerified', 'inherited',
			'siteReused', true
		)
	);
	reset role;
	perform pg_temp.base_assert(
		v_res = jsonb_build_object('schema', 'qorpera.code-request-finish/v1', 'state', 'recorded', 'change', 4)
		and (pg_temp.rec_row(4)).undoes = array[2, 3]
		and (pg_temp.rec_row(2)).state = 'reverted'
		and (pg_temp.rec_row(3)).state = 'reverted'
		and (pg_temp.rec_row(4)).checks_state = 'inherited'
		and (pg_temp.rec_row(4)).site_state = 'made'
		and (pg_temp.rec_row(4)).site ->> 'tree' = pg_temp.rec_sha('t1'),
		'range undo reverts both rows and inherits checks and site tree via matchesBeforeTree'
	);

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
	values (pg_temp.rec_here(), v_profile, 'company', 'huge', 505, pg_temp.rec_sha('h505'));
	insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, main_before, main_after, title)
	select pg_temp.rec_here(), 'company', 'huge', n, v_profile, 'found', 'landed',
		pg_temp.rec_sha('h' || (n - 1)), pg_temp.rec_sha('h' || n), 'Change ' || n
	from generate_series(1, 505) as n;
	v_res := public.qorpera_folder_request_code_undo_v2(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'undo-huge-1',
			'owner', 'company',
			'name', 'huge',
			'change', 1,
			'andLater', true,
			'reason', 'Rollback all 505 changes'
		)
	);
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued', 'v2 undo lifts 500-change cap cleanly: ' || v_res::text);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-create-1', 'op', 'create', 'owner', 'company', 'name', 'fresh-api')
	);
	v_id := (v_res ->> 'requestId')::uuid;
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'queued'
		and exists (
			select 1 from public.qorpera_code_repositories
			where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'fresh-api'
		),
		'lifecycle create registers repository and queues start request: ' || v_res::text
	);
	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 10, array['lifecycle']);
	v_item := v_claim -> 'requests' -> 0;
	v_token := (v_item ->> 'token')::uuid;
	v_res := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_id, v_token,
		jsonb_build_object('schema', 'qorpera.code-request-outcome/v1', 'state', 'done', 'result', 'created',
			'mainSha', pg_temp.rec_sha('init'), 'created', true)
	);
	reset role;
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'recorded'
		and (select last_main from public.qorpera_code_repositories
			where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'fresh-api') = pg_temp.rec_sha('init'),
		'lifecycle create finish records last_main on repository'
	);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-archive-active', 'op', 'archive', 'owner', 'company', 'name', 'shop')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'refused' and v_res ->> 'reason' = 'sessions_active',
		'archive refuses while coding session is active: ' || v_res::text
	);

	update public.qorpera_coding_sessions
	set phase = 'completed', archived_at = clock_timestamp(), archived_by = 'agent'
	where worker_id in (v_b1, v_b2);
	update public.qorpera_runtime_workers set state = 'succeeded', result = '{}'::jsonb where id in (v_b1, v_b2);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-archive-ok', 'op', 'archive', 'owner', 'company', 'name', 'shop', 'reason', 'Retired project')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'done' and v_res ->> 'result' = 'archived'
		and (pg_temp.rec_shop()).archived_at is not null,
		'archive succeeds once sessions are inactive: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_status(pg_temp.c3_alice(), 'company', 'shop');
	perform pg_temp.base_assert(
		(v_res -> 'repository' ->> 'archived')::boolean
		and (v_res -> 'queue' ->> 'restoring')::boolean = false,
		'archived repo remains readable via status with queue.restoring'
	);

	v_res := public.qorpera_folder_code_history(
		pg_temp.c3_alice(),
		jsonb_build_object('owner', 'company', 'name', 'shop')
	);
	perform pg_temp.base_assert((v_res ->> 'total')::integer = 4, 'archived repo remains readable via history');

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-tag-archived', 'op', 'tag', 'owner', 'company', 'name', 'shop', 'mode', 'create', 'tag', 'v1.0.0')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'refused' and v_res ->> 'reason' = 'archived',
		'tag create refuses on archived repository: ' || v_res::text
	);

	perform pg_temp.base_error(
		$sql$select public.qorpera_folder_code_lifecycle(pg_temp.c3_alice(), '{"operationKey":"life-tag-dot","op":"tag","owner":"company","name":"shop","mode":"create","tag":"v1/.hidden"}'::jsonb)$sql$,
		'22023',
		'Code request is invalid'
	);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-tag-list', 'op', 'tag', 'owner', 'company', 'name', 'shop', 'mode', 'list')
	);
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued', 'tag list still works on archived repository');

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-prune-1', 'op', 'prune', 'owner', 'company', 'name', 'shop', 'deleteMergedBranches', true)
	);
	v_id := (v_res ->> 'requestId')::uuid;
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'queued'
		and not ((select input from public.qorpera_code_requests where id = v_id) ? 'workerIds'),
		'prune queues lifecycle request without pre-snapshotted workerIds'
	);
	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 10, array['lifecycle']);
	select elem into v_item from jsonb_array_elements(v_claim -> 'requests') as elem where (elem ->> 'requestId')::uuid = v_id;
	v_token := (v_item ->> 'token')::uuid;
	v_res := public.qorpera_code_request_step('exec-1170', repeat('5', 64), v_id, v_token, '{"step":"files"}'::jsonb);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'go'
		and jsonb_typeof(v_res -> 'candidates') = 'array'
		and (v_res -> 'candidates') ? v_b1::text
		and (v_res -> 'candidates') ? v_b2::text,
		'prune step returns live archived candidates: ' || v_res::text
	);
	reset role;
	update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = v_b2;
	set local role service_role;
	v_res := public.qorpera_code_request_step('exec-1170', repeat('5', 64), v_id, v_token, '{"step":"git-folder"}'::jsonb);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'go'
		and (v_res -> 'candidates') ? v_b1::text
		and not ((v_res -> 'candidates') ? v_b2::text),
		'prune second step re-checks live candidates and excludes reopened session: ' || v_res::text
	);
	reset role;

	v_other_w := pg_temp.rec_turn(10, 2, pg_temp.rec_sha('h10'));
	perform pg_temp.base_error(
		format('select public.qorpera_open_coding_turn((select w from public.qorpera_runtime_workers w where w.id = %L), ''agent'', ''Next turn'', null, null)', v_other_w),
		'55000',
		'This repository is archived; no new coding sessions can run on it'
	);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-unarchive-1', 'op', 'unarchive', 'owner', 'company', 'name', 'shop')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'done' and v_res ->> 'result' = 'unarchived'
		and (pg_temp.rec_shop()).archived_at is null,
		'unarchive clears archived_at and restores repository: ' || v_res::text
	);
	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-unarchive-2', 'op', 'unarchive', 'owner', 'company', 'name', 'shop')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'already',
		'second unarchive reports already: ' || v_res::text
	);

	v_res := public.qorpera_folder_request_code_undo_v2(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'undo-range-reverted-edge',
			'owner', 'company',
			'name', 'shop',
			'change', 2,
			'toChange', 4,
			'dryRun', true,
			'reason', 'Range starting on reverted change 2 selects smallest landed change 4'
		)
	);
	v_id := (v_res ->> 'requestId')::uuid;
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'queued'
		and ((select input ->> 'change' from public.qorpera_code_requests where id = v_id)::integer) = 4,
		'range undo starting on reverted change advances lower edge to smallest landed change: ' || v_res::text
	);

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values ((pg_temp.rec_shop()).environment_id, (pg_temp.rec_shop()).profile_id, 'surfaces', 'website');
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, status, source_kind, repository_key
	)
	values
		((pg_temp.rec_shop()).profile_id, 'website', 'Website', 'products', 'live_build', 'active', 'code_repo', null),
		((pg_temp.rec_shop()).profile_id, 'storefront', 'Storefront', 'products', 'live_build', 'active', 'code_repo', 'company/shop');

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-archive-surface-default', 'op', 'archive', 'owner', 'surfaces', 'name', 'website')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'refused' and v_res ->> 'reason' = 'surface_backed',
		'archive refuses default surfaces/<slug> repository: ' || v_res::text
	);

	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-archive-surface-custom', 'op', 'archive', 'owner', 'company', 'name', 'shop')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'refused' and v_res ->> 'reason' = 'surface_backed'
		and (pg_temp.rec_shop()).archived_at is null,
		'archive refuses custom repository_key backing a code_repo surface: ' || v_res::text
	);

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values ((pg_temp.rec_shop()).environment_id, (pg_temp.rec_shop()).profile_id, 'company', 'retired');
	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-archive-retired', 'op', 'archive', 'owner', 'company', 'name', 'retired')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'done' and v_res ->> 'result' = 'archived',
		'standalone repo archives cleanly: ' || v_res::text
	);
	perform pg_temp.base_error(
		format(
			'insert into public.qorpera_surfaces(profile_id, slug, title, surface_group, archetype, status, source_kind, repository_key) values (%L, ''retired-app'', ''Retired'', ''products'', ''live_build'', ''active'', ''code_repo'', ''company/retired'')',
			(pg_temp.rec_shop()).profile_id
		),
		'55000',
		'This repository is archived; unarchive it before attaching a surface'
	);
	perform pg_temp.base_error(
		format(
			'update public.qorpera_surfaces set repository_key = ''company/retired'' where profile_id = %L and slug = ''storefront''',
			(pg_temp.rec_shop()).profile_id
		),
		'55000',
		'This repository is archived; unarchive it before attaching a surface'
	);
	v_res := public.qorpera_folder_code_lifecycle(
		pg_temp.c3_alice(),
		jsonb_build_object('operationKey', 'life-unarchive-retired', 'op', 'unarchive', 'owner', 'company', 'name', 'retired')
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'done' and v_res ->> 'result' = 'unarchived',
		'unarchiving retired repo succeeds: ' || v_res::text
	);
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, status, source_kind, repository_key
	)
	values (
		(pg_temp.rec_shop()).profile_id, 'retired-app', 'Retired', 'products', 'live_build', 'active', 'code_repo', 'company/retired'
	);
end $$;
