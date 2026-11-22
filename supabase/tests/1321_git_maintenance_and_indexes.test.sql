-- @fixture 1170_own_code_repositories.test.sql until "-- 3. One place under code/"

do $$
declare
	g text := 'code/company/shop/repo.git/';
	s40 text := repeat('a', 40);
	s64 text := repeat('b', 64);
	w uuid := '92400000-0000-4000-8000-0000000000c1';
	v_path text;
begin
	foreach v_path in array array[
		'objects/info/commit-graph',
		'objects/info/commit-graphs/commit-graph-chain',
		'objects/info/commit-graphs/graph-' || s40 || '.graph',
		'objects/info/commit-graphs/graph-' || s64 || '.graph',
		'objects/pack/multi-pack-index',
		'objects/pack/multi-pack-index-' || s40 || '.bitmap',
		'objects/pack/multi-pack-index-' || s64 || '.bitmap'
	] loop
		perform pg_temp.base_assert(public.qorpera_folder_git_index(g || v_path),
			'expected git platform index allow-list to accept ' || v_path);
		perform pg_temp.base_assert(not public.qorpera_folder_git_object(g || v_path),
			'expected git object allow-list to exclude platform index ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'write', 'platform', w) is null,
			'expected platform write allowed for ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'delete', 'platform', w) is null,
			'expected platform delete allowed for ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'write', 'session', w) = 'git_platform_only',
			'expected session write refused as git_platform_only for ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'delete', 'session', w) = 'git_platform_only',
			'expected session delete refused as git_platform_only for ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'write', 'member', w) = 'git_platform_only',
			'expected member write refused for ' || v_path);
	end loop;

	foreach v_path in array array[
		'objects/info/packs',
		'objects/info/packs_Ab12Cd',
		'objects/info/alternates',
		'objects/info/commit-graph.lock',
		'objects/info/commit-graph2',
		'objects/info/commit-graphs/commit-graph-chain.lock',
		'objects/info/commit-graphs/graph-0123.graph',
		'objects/info/commit-graphs/graph-' || upper(s40) || '.graph',
		'objects/info/commit-graphs/graph-' || s40 || 'a.graph',
		'objects/info/commit-graphs/evil.txt',
		'objects/info/commit-graphs/sub/graph-' || s40 || '.graph',
		'objects/pack/multi-pack-index.lock',
		'objects/pack/multi-pack-index-0123.bitmap',
		'objects/pack/multi-pack-index-' || upper(s40) || '.bitmap',
		'objects/pack/multi-pack-index-' || s40 || '.pack',
		'objects/pack/multi-pack-index-' || s40 || '.rev',
		'objects/pack/multi-pack-index.d/multi-pack-index-' || s40 || '.midx',
		'objects/pack/evil.bitmap'
	] loop
		perform pg_temp.base_assert(not public.qorpera_folder_git_index(g || v_path),
			'expected git platform index allow-list to reject ' || v_path);
		perform pg_temp.base_assert(not public.qorpera_folder_git_object(g || v_path),
			'expected git object allow-list to reject ' || v_path);
		perform pg_temp.base_assert(public.qorpera_folder_git_refusal(g || v_path, 'write', 'session', w) = 'git_platform_only',
			'expected session write refused for ' || v_path);
	end loop;

	perform pg_temp.base_assert(public.qorpera_code_change_checks_valid(jsonb_build_object(
		'state', 'landed', 'how', 'merged', 'mainAfter', s40,
		'checks', jsonb_build_object('state', 'not_run'))),
		'landed intermediate batch report with checks_state not_run must be valid');
	perform pg_temp.base_assert(not public.qorpera_code_change_checks_valid(jsonb_build_object(
		'state', 'landed', 'how', 'merged', 'mainAfter', s40,
		'checks', jsonb_build_object('state', 'not_run', 'result', jsonb_build_object()))),
		'not_run with extra result key must be rejected');
	perform pg_temp.base_assert(not public.qorpera_code_change_checks_valid(jsonb_build_object(
		'state', 'conflict', 'checks', jsonb_build_object('state', 'not_run'))),
		'non-landed report with not_run checks must be rejected');

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values ('92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010', 'company', 'defaults-check');
	perform pg_temp.base_assert((select r.gc_enabled and r.retire_enabled
		from public.qorpera_code_repositories r
		where r.environment_id = '92400000-0000-4000-8000-000000000020' and r.owner = 'company' and r.name = 'defaults-check'),
		'new repository must default gc_enabled = true and retire_enabled = true');
end $$;

update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';
do $$
declare
	v_env uuid := '92400000-0000-4000-8000-000000000020';
	v_prof uuid := '92400000-0000-4000-8000-000000000010';
	v_mach text := repeat('5', 64);
	v_files jsonb;
	v_arch jsonb;
	i integer;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(
		not has_function_privilege('anon', 'public.qorpera_code_change_archive(text,text,uuid,text,text,integer,integer)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_code_change_archive(text,text,uuid,text,text,integer,integer)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_code_change_archive(text,text,uuid,text,text,integer,integer)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_folder_git_index(text)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_folder_git_object(text)', 'EXECUTE'),
		'expected exact privileges');

	for i in 1..205 loop
		insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, main_after, title)
		values (v_env, 'company', 'defaults-check', i, v_prof, 'found', 'landed', repeat('c', 40), 'Change ' || i);
	end loop;
	update public.qorpera_code_repositories set last_change = 205, index_version = 1, index_written = 0
	where environment_id = v_env and owner = 'company' and name = 'defaults-check';

	v_files := public.qorpera_code_change_files('exec-1170', v_mach, v_env, 'company', 'defaults-check', 200);
	perform pg_temp.base_assert(jsonb_array_length(v_files -> 'changes') = 200
		and (v_files ->> 'hasMore')::boolean
		and (v_files -> 'index' ->> 'total')::integer = 205
		and jsonb_array_length(v_files -> 'index' -> 'lines') = 100
		and (v_files -> 'index' -> 'lines' -> 0 ->> 'n')::integer = 205,
		'files 200: ' || (v_files - 'changes' - 'index')::text);

	perform pg_temp.base_error(format(
		'select public.qorpera_code_change_files(%L, %L, %L, %L, %L, 201)',
		'exec-1170', v_mach, v_env, 'company', 'defaults-check'), '22023', 'Code change files request invalid');

	perform pg_temp.base_assert(public.qorpera_code_change_files_written_valid(jsonb_build_object(
		'changes', (select jsonb_agg(jsonb_build_object('n', n, 'version', 1)) from generate_series(1, 200) n),
		'indexVersion', 1, 'problem', null)), '200 written entries valid');
	perform pg_temp.base_assert(not public.qorpera_code_change_files_written_valid(jsonb_build_object(
		'changes', (select jsonb_agg(jsonb_build_object('n', n, 'version', 1)) from generate_series(1, 201) n),
		'indexVersion', 1, 'problem', null)), '201 written entries invalid');

	perform public.qorpera_code_change_files_written('exec-1170', v_mach, v_env, 'company', 'defaults-check', jsonb_build_object(
		'changes', (select jsonb_agg(jsonb_build_object('n', n, 'version', 1)) from generate_series(1, 200) n),
		'indexVersion', 1, 'problem', null));
	v_files := public.qorpera_code_change_files('exec-1170', v_mach, v_env, 'company', 'defaults-check', 200);
	perform pg_temp.base_assert(jsonb_array_length(v_files -> 'changes') = 5
		and not (v_files ? 'hasMore'), 'remaining 5 without hasMore');

	v_arch := public.qorpera_code_change_archive('exec-1170', v_mach, v_env, 'company', 'defaults-check', 1, 105);
	perform pg_temp.base_assert(v_arch ->> 'schema' = 'qorpera.code-change-archive/v1'
		and jsonb_array_length(v_arch -> 'lines') = 105
		and (v_arch -> 'lines' -> 0 ->> 'n')::integer = 1
		and (v_arch -> 'lines' -> 104 ->> 'n')::integer = 105,
		'archive slice 1..105');

	perform pg_temp.base_error(format(
		'select public.qorpera_code_change_archive(%L, %L, %L, %L, %L, 0, 10)',
		'exec-1170', v_mach, v_env, 'company', 'defaults-check'), '22023', 'Code change archive request invalid');
	perform pg_temp.base_error(format(
		'select public.qorpera_code_change_archive(%L, %L, %L, %L, %L, 10, 5)',
		'exec-1170', v_mach, v_env, 'company', 'defaults-check'), '22023', 'Code change archive request invalid');
	perform pg_temp.base_error(format(
		'select public.qorpera_code_change_archive(%L, %L, %L, %L, %L, 1, 251)',
		'exec-1170', v_mach, v_env, 'company', 'defaults-check'), '22023', 'Code change archive request invalid');
end $$;
