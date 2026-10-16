-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The context fence's three calls (20260930481000), on 924's real native run of Alice's after she read and released a
-- shared file: one fence makes the run check three times and re-checks the run's released reads twice (the seven-call
-- fence of 20260928339400 made seven and four); a null read set is refused after the view, and the view rolls back; a
-- legacy environment is refused before any check. Last, both fences are timed side by side (printed, not checked).

-- Alice's run records its native start and acknowledges its wake. The owner shares a folder with Alice for reading
-- only; her run reads its file and releases the read (as test 746 does).
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_identity jsonb; v_actor jsonb; v_read jsonb;
	v_resource uuid;
begin
	v_actor := jsonb_build_object('kind','run','runId',v_binding ->> 'runId','jobId',v_binding ->> 'jobId',
		'runnerId',v_binding ->> 'runnerId','assignmentId',v_binding ->> 'assignmentId');
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.base_public_send(v_binding, 'progress', 'fc-ack');
	v_resource := public.qorpera_folder_set_resource('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'fc-shared',
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), v_resource, 'staff_agent',
		'92400000-0000-4000-8000-000000000030', array['read']);
	perform pg_temp.base_commit('{"kind":"platform"}', 'fc-shared', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','fc-shared'),
		jsonb_build_object('op','write','path','fc-shared/s.txt','file',pg_temp.base_stage('shared text'))));
	v_read := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', v_actor, 'fc-shared/s.txt') -> 'entry';
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', v_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version', 'authority', v_read -> 'authority')),
		repeat('0', 64));
end
$$;

create function pg_temp.fc_view(p_request text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.native-context-view/v1','requestId',p_request,'threadId','thread-1',
		'turnId','turn-1','purpose','turn','outputs','[]'::jsonb)
$$;
create function pg_temp.fc_viewed(p_request text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_native_context_views
		where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid and request_id = p_request)
$$;
-- The fence as 20260928339400 made it, for the counts and the timing.
create function pg_temp.fc_seven(p_environment_id uuid, p_binding jsonb, p_paths text[], p_view jsonb)
returns jsonb language plpgsql as $$
declare v_receipt jsonb; v_authority jsonb;
begin
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	v_receipt := public.qorpera_record_native_context_view(p_environment_id, p_binding, p_view);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	return jsonb_build_object('authority', v_authority, 'receipt', v_receipt);
end
$$;
-- This transaction's calls of the run check, the read re-check and describe.
create function pg_temp.fc_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_folder_tool_run', 'qorpera_folder_run_reads_current', 'qorpera_describe_native_tool_authority'])
		with ordinality as n(name, ordinal)
$$;

-- 1. The calls one fence makes: three run checks, two read re-checks and one describe (the seven-call fence: seven,
--    four and three). The fence answers and records its view.
set local track_functions = 'all';
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_at bigint[]; v_seven bigint[];
	v_three bigint[]; v_fence jsonb;
begin
	v_at := pg_temp.fc_calls();
	set local role service_role;
	perform pg_temp.fc_seven('92400000-0000-4000-8000-000000000020', v_binding, '{}', pg_temp.fc_view('fc-seven'));
	reset role;
	v_seven := pg_temp.fc_calls();
	set local role service_role;
	v_fence := public.qorpera_fence_native_context('92400000-0000-4000-8000-000000000020', v_binding, '{}',
		pg_temp.fc_view('fc-three'));
	reset role;
	v_three := pg_temp.fc_calls();
	perform set_config('qorpera_test.fc_counts', format('seven-call fence %s, this fence %s (run checks, read re-checks, describes)',
		array[v_seven[1] - v_at[1], v_seven[2] - v_at[2], v_seven[3] - v_at[3]],
		array[v_three[1] - v_seven[1], v_three[2] - v_seven[2], v_three[3] - v_seven[3]]), true);
	if array[v_seven[1] - v_at[1], v_seven[2] - v_at[2], v_seven[3] - v_at[3]] is distinct from array[7, 4, 3]::bigint[]
			or array[v_three[1] - v_seven[1], v_three[2] - v_seven[2], v_three[3] - v_seven[3]] is distinct from array[3, 2, 1]::bigint[] then
		raise exception 'The fences'' calls are not as expected: %', current_setting('qorpera_test.fc_counts'); end if;
	if v_fence ->> 'schema' is distinct from 'qorpera.native-context-fence/v1' or v_fence -> 'authority' ->> 'schema'
			is distinct from 'qorpera.native-tool-authority/v1' or v_fence -> 'receipt' is null
			or v_fence -> 'kept' is distinct from '[]'::jsonb or not pg_temp.fc_viewed('fc-three') then
		raise exception 'The fence did not answer and record its view: %', v_fence; end if;
end
$$;
select current_setting('qorpera_test.fc_counts') as fc_counts \gset
\echo 666 calls: :fc_counts

-- 2. A null read set is refused by the read-set check after the view, and the view rolls back with the call.
set local role service_role;
select pg_temp.base_error(format('select public.qorpera_fence_native_context(%L::uuid, %L::jsonb, null::text[], %L::jsonb)',
	'92400000-0000-4000-8000-000000000020', current_setting('qorpera_test.base_binding'), pg_temp.fc_view('fc-null')),
	'22023', 'Company File context read set is invalid');
reset role;
select pg_temp.base_assert(not pg_temp.fc_viewed('fc-null'), 'A fence refused after its view kept the view');

-- 3. A legacy environment (here one with no folder-v2 Company File) is refused before any check.
do $$
declare v_at bigint[] := pg_temp.fc_calls();
begin
	set local role service_role;
	perform pg_temp.base_error(format('select public.qorpera_fence_native_context(%L::uuid, %L::jsonb, %L::text[], %L::jsonb)',
		extensions.gen_random_uuid(), current_setting('qorpera_test.base_binding'), '{}', pg_temp.fc_view('fc-legacy')),
		'0A000', 'The context fence serves folder-v2 companies only');
	reset role;
	if pg_temp.fc_calls() is distinct from v_at then
		raise exception 'A legacy environment''s fence made a check: % then %', v_at, pg_temp.fc_calls(); end if;
end
$$;
select pg_temp.base_assert(not pg_temp.fc_viewed('fc-legacy'), 'A legacy environment''s fence recorded its view');

-- 4. The timing, on this machine with nothing else running: the two fences in turn, 40 times each (printed only).
reset track_functions;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_start timestamptz;
	v_seven double precision := 0; v_three double precision := 0; c_rounds constant integer := 40;
begin
	set local role service_role;
	for i in 1 .. c_rounds loop
		v_start := clock_timestamp();
		perform pg_temp.fc_seven('92400000-0000-4000-8000-000000000020', v_binding, '{}', pg_temp.fc_view('fc-seven-' || i));
		v_seven := v_seven + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_fence_native_context('92400000-0000-4000-8000-000000000020', v_binding, '{}',
			pg_temp.fc_view('fc-three-' || i));
		v_three := v_three + extract(epoch from clock_timestamp() - v_start);
	end loop;
	reset role;
	perform set_config('qorpera_test.fc_ms', format('seven-call fence %s ms, this fence %s ms (mean of %s each)',
		round((v_seven * 1000 / c_rounds)::numeric, 2), round((v_three * 1000 / c_rounds)::numeric, 2), c_rounds), true);
end
$$;
select current_setting('qorpera_test.fc_ms') as fc_ms \gset
\echo 666 timing: :fc_ms
rollback;
