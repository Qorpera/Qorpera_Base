-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, C4 (P32, 20260930032000): the operator observability functions on folder-v2. For a hand-built
-- leased run of agent A (634's fixture) that read two files, released its reads, committed a folder, and had a change
-- set reviewed: the run query (schema v2) shows the run's folder commit with its path versions, the review with its
-- answer, the released read set, the run's company_seq, and none of the legacy sections. The company query (schema v2)
-- lists only the members' own commits, never a run's or the platform's. Neither names a path or an operation key.
-- Both stay the service role's alone.

-- 0. The run's work ---------------------------------------------------------------------------------------------------

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v jsonb := pg_temp.run(c_a, 'human', '63400000-0000-4000-8000-000000000002'); l jsonb; r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p32-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','p32'),
		jsonb_build_object('op','write','path','p32/a.txt','file',pg_temp.stage('alpha')),
		jsonb_build_object('op','write','path','p32/b.txt','file',pg_temp.stage('beta')))), 3, 'saved');
	l := public.qorpera_folder_list(c_env, v, 'p32', null, 10);
	perform pg_temp.release(v, '84400000-0000-4000-8000-0000000000e1', l -> 'entries', repeat('1', 64));
	-- A release whose version is text the runner made up: filed as given, shown only as null (closed metadata).
	perform public.qorpera_folder_record_release(c_env, v, '84400000-0000-4000-8000-0000000000e2',
		(select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', 'LEAKED_p32/a.txt', 'authority', e -> 'authority'))
			from jsonb_array_elements(l -> 'entries') e), repeat('2', 64));
	r := pg_temp.commit(v, 'p32-run-commit', '[{"op":"mkdir","path":"p32/out"},{"op":"mkdir","path":"p32/out/notes"}]');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'p32-member-commit', '[{"op":"mkdir","path":"p32/by-member"}]'), 1, 'saved');
	-- A reviewed change set of the run, answered (as the review card leaves it).
	perform pg_temp.fx(format($f$insert into public.qorpera_folder_reviews(id, environment_id, run_id, change_set_sha256, units,
		decision, answer, answered_by_user_id, answered_at)
		values ('84400000-0000-4000-8000-0000000000f1', %L, %L, %L, '{1}', 'ask', 'allow', '63400000-0000-4000-8000-000000000001',
			clock_timestamp())$f$, c_env, v ->> 'runId', repeat('9', 64)));
	-- The run's pin (P28): a folder-v2 run carries company_seq, not a snapshot.
	perform pg_temp.fx(format('update public.qorpera_execution_runs set substrate_version_id = null, company_snapshot_id = null,
		company_seq = 41 where id = %L', v ->> 'runId'));
	perform set_config('qorpera_test.p32_run', v::text, true);
end $$;

-- 1. The run query ----------------------------------------------------------------------------------------------------

do $$
declare v jsonb := current_setting('qorpera_test.p32_run')::jsonb; q jsonb; c jsonb;
begin
	q := public.qorpera_get_runtime_operational_run((v ->> 'runId')::uuid);
	if q ->> 'schema' <> 'qorpera.runtime-operational-run/v2' or (q #>> '{identity,companySeq}')::bigint is distinct from 41
		or q -> 'sections' ?| array['revisions','proposals','reads'] then
		raise exception 'The run query is not v2 or keeps a legacy section: %', q -> 'sections'; end if;
	-- The commit, with its two path versions, attributed to the agent for the requester.
	c := q #> '{sections,commits,items,0}';
	if jsonb_array_length(q #> '{sections,commits,items}') <> 1
		or c ->> 'actorKind' <> 'staff_agent' or c ->> 'actorId' <> '63400000-0000-4000-8000-0000000000a1'
		or c ->> 'requesterId' <> '63400000-0000-4000-8000-000000000002' or (c ->> 'unitCount')::integer <> 2
		or c -> 'seq' = 'null'::jsonb or (c ->> 'versionsTruncated')::boolean
		or (select array_agg((p ->> 'version')::uuid order by (p ->> 'unit')::integer) from jsonb_array_elements(c -> 'versions') p)
			is distinct from (select array_agg(v.version order by v.unit_no) from public.qorpera_folder_path_versions v
				where v.commit_id = (c ->> 'commitId')::uuid)
		or exists (select 1 from jsonb_array_elements(c -> 'versions') p where p ->> 'op' <> 'mkdir' or p ->> 'kind' <> 'folder')
		or (select operation_key from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) <> 'p32-run-commit' then
		raise exception 'The run''s commit is not shown as made: %', c; end if;
	if (q #> '{sections,commits,truncated}')::boolean then raise exception 'One commit is not a truncated page'; end if;
	-- The review and its answer.
	c := q #> '{sections,reviews,items,0}';
	if jsonb_array_length(q #> '{sections,reviews,items}') <> 1 or c ->> 'reviewId' <> '84400000-0000-4000-8000-0000000000f1'
		or c ->> 'decision' <> 'ask' or c ->> 'answer' <> 'allow' or c -> 'units' <> '[1]'::jsonb
		or c ->> 'answeredByUserId' <> '63400000-0000-4000-8000-000000000001' then
		raise exception 'The run''s review is not shown: %', c; end if;
	if (c ->> 'unitCount')::integer <> 1 or (c ->> 'unitsTruncated')::boolean then
		raise exception 'The review''s units are not counted: %', c; end if;
	-- The released read sets: one covering resource each, both files' versions; the made-up versions come back null.
	if jsonb_array_length(q #> '{sections,readSets,items}') <> 2 then
		raise exception 'Both releases are shown: %', q #> '{sections,readSets}'; end if;
	select item into c from jsonb_array_elements(q #> '{sections,readSets,items}') item
	where item ->> 'releaseId' = '84400000-0000-4000-8000-0000000000e1';
	if (c ->> 'readCount')::integer <> 2 or c ->> 'outputSha256' <> repeat('1', 64) or (c ->> 'versionsTruncated')::boolean
		or c ->> 'resourceId' <> (pg_temp.root()).id::text
		or (select array_agg(x.value ->> 'version' order by x.value ->> 'version') from jsonb_array_elements(
				(select reads from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
					and release_id = '84400000-0000-4000-8000-0000000000e1')) x)
			is distinct from (select array_agg(x #>> '{}' order by x #>> '{}') from jsonb_array_elements(c -> 'versions') x) then
		raise exception 'The run''s read set is not shown with its versions: %', c; end if;
	select item into c from jsonb_array_elements(q #> '{sections,readSets,items}') item
	where item ->> 'releaseId' = '84400000-0000-4000-8000-0000000000e2';
	if c -> 'versions' <> '[null,null]'::jsonb or q::text ~ 'LEAKED' then
		raise exception 'A made-up version is shown as text: %', c; end if;
	-- Not completed: no result, so no output commit.
	if q -> 'canonicalResult' <> 'null'::jsonb or q #>> '{canonicalJob,status}' <> 'leased' then
		raise exception 'An unfinished run shows a result: %', q -> 'canonicalResult'; end if;
	-- A page of one commit with two: truncated.
	perform pg_temp.commit(v, 'p32-run-commit-2', '[{"op":"mkdir","path":"p32/out/more"}]');
	q := public.qorpera_get_runtime_operational_run((v ->> 'runId')::uuid, 1);
	if not (q #> '{sections,commits,truncated}')::boolean or jsonb_array_length(q #> '{sections,commits,items}') <> 1
		or (select operation_key from public.qorpera_folder_commits where id = (q #>> '{sections,commits,items,0,commitId}')::uuid)
			<> 'p32-run-commit-2' then
		raise exception 'A page of one is not the newest commit, truncated: %', q #> '{sections,commits}'; end if;
end $$;

-- A commit's versions stop at 32, and say so. The output names no path and no operation key (closed metadata).
do $$
declare v jsonb := current_setting('qorpera_test.p32_run')::jsonb; q jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(v, 'p32-wide', (select jsonb_agg(jsonb_build_object('op','mkdir','path','p32/w' || n))
		from generate_series(1, 33) n)), 33, 'saved');
	q := public.qorpera_get_runtime_operational_run((v ->> 'runId')::uuid, 1);
	if (q #>> '{sections,commits,items,0,unitCount}')::integer <> 33
		or jsonb_array_length(q #> '{sections,commits,items,0,versions}') <> 32
		or not (q #>> '{sections,commits,items,0,versionsTruncated}')::boolean then
		raise exception 'A wide commit''s versions are not bounded: %', q #> '{sections,commits,items,0}'; end if;
	q := public.qorpera_get_runtime_operational_run((v ->> 'runId')::uuid);
	if q::text ~ 'p32/|p32-|"path"|operationKey|"reads"' then
		raise exception 'The run query exposed a path or an operation key'; end if;
end $$;

-- A view's commit during the leased turn names the run in turn_run_id (C1b-3): it is the run's work too.
do $$
declare v jsonb := current_setting('qorpera_test.p32_run')::jsonb; q jsonb;
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_folder_commits(id, environment_id, seq, operation_key, actor_kind,
		actor_id, units, session_kind, view_id, view_kind, turn_run_id) values ('84400000-0000-4000-8000-0000000000c1',
		'63400000-0000-4000-8000-000000000020', null, 'p32-view-commit', 'staff_agent', '63400000-0000-4000-8000-0000000000a1', '[]',
		'coding', extensions.gen_random_uuid(), 'coding_session', %L)$f$, v ->> 'runId'));
	q := public.qorpera_get_runtime_operational_run((v ->> 'runId')::uuid);
	if not exists (select 1 from jsonb_array_elements(q #> '{sections,commits,items}') c
		where c ->> 'commitId' = '84400000-0000-4000-8000-0000000000c1') then
		raise exception 'A view''s commit during the turn is not the run''s work'; end if;
end $$;

-- 2. The company query: the members' own commits only ------------------------------------------------------------------

do $$
declare q jsonb := public.qorpera_get_company_operational_commands('63400000-0000-4000-8000-000000000010');
begin
	if q ->> 'schema' <> 'qorpera.company-operational-commands/v2'
		or q::text ~ 'p32/|p32-|"path"|operationKey'
		or exists (select 1 from jsonb_array_elements(q #> '{commands,items}') c where c -> 'runId' <> 'null'::jsonb
			or (select actor_kind from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) <> 'member')
		or not exists (select 1 from jsonb_array_elements(q #> '{commands,items}') c
			join public.qorpera_folder_commits fc on fc.id = (c ->> 'commitId')::uuid and fc.operation_key = 'p32-member-commit'
			where c ->> 'actorUserId' = '63400000-0000-4000-8000-000000000002' and (c ->> 'unitCount')::integer = 1) then
		raise exception 'The company query is not the members'' own commits: %', q; end if;
	perform pg_temp.raises($q$select public.qorpera_get_company_operational_commands('84400000-0000-4000-8000-000000000099')$q$, '42501');
end $$;

-- 3. Only the service role ---------------------------------------------------------------------------------------------

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_get_runtime_operational_run(uuid,integer)',
		'public.qorpera_get_company_operational_commands(uuid,integer)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or has_function_privilege('authenticated', v_function, 'EXECUTE')
			or not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is not the operator''s alone', v_function; end if;
	end loop;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub','63400000-0000-4000-8000-000000000001')::text, true)
	\g /dev/null
select pg_temp.raises(format('select public.qorpera_get_runtime_operational_run(%L)',
	current_setting('qorpera_test.p32_run')::jsonb ->> 'runId'), '42501');

rollback;
