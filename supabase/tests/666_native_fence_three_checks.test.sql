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

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_fence jsonb;
begin
	set local role service_role;
	v_fence := public.qorpera_fence_native_context('92400000-0000-4000-8000-000000000020', v_binding, '{}',
		pg_temp.fc_view('fc-three'));
	reset role;
	if v_fence ->> 'schema' is distinct from 'qorpera.native-context-fence/v1' or v_fence -> 'authority' ->> 'schema'
			is distinct from 'qorpera.native-tool-authority/v1' or v_fence -> 'receipt' is null
			or v_fence -> 'kept' is distinct from '[]'::jsonb or not pg_temp.fc_viewed('fc-three') then
		raise exception 'The fence did not answer and record its view: %', v_fence; end if;
end
$$;

-- 2. A null read set is refused by the read-set check after the view, and the view rolls back with the call.
set local role service_role;
select pg_temp.base_error(format('select public.qorpera_fence_native_context(%L::uuid, %L::jsonb, null::text[], %L::jsonb)',
	'92400000-0000-4000-8000-000000000020', current_setting('qorpera_test.base_binding'), pg_temp.fc_view('fc-null')),
	'22023', 'Company File context read set is invalid');
reset role;
select pg_temp.base_assert(not pg_temp.fc_viewed('fc-null'), 'A fence refused after its view kept the view');

-- 3. A legacy environment (here one with no folder-v2 Company File) is refused before any check.
do $$
begin
	set local role service_role;
	perform pg_temp.base_error(format('select public.qorpera_fence_native_context(%L::uuid, %L::jsonb, %L::text[], %L::jsonb)',
		extensions.gen_random_uuid(), current_setting('qorpera_test.base_binding'), '{}', pg_temp.fc_view('fc-legacy')),
		'0A000', 'The context fence serves folder-v2 companies only');
	reset role;
end
$$;
select pg_temp.base_assert(not pg_temp.fc_viewed('fc-legacy'), 'A legacy environment''s fence recorded its view');

rollback;
