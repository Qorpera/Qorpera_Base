-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The one-call native context fence (20260928339400) on a folder-v2 company (ported from snapshot-v1 in the legacy
-- sweep), on 924's real native run of Alice's: only the service role may call it; a call without the service's claims,
-- or for a run whose lease is revoked, whose assignment expired, whose job ended or whose sponsor binding is revoked, is
-- refused; and once the owner revokes Alice's folder grant on a file her run read and released, the next model request
-- is refused and records no view.

-- Only the service role calls it, like each call it makes.
reset role;
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)','EXECUTE')
				is distinct from (v_role = 'service_role') then
			raise exception 'One-call fence boundary is incorrect for %', v_role; end if;
	end loop;
end
$$;

create function pg_temp.fn_view(p_request text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.native-context-view/v1','requestId',p_request,'threadId','thread-1',
		'turnId','turn-1','purpose','turn','outputs','[]'::jsonb)
$$;
-- The fence call the host makes before a model request. On folder-v2 the run's released reads are checked, not a sent
-- path list.
create function pg_temp.fn_call(p_request text) returns text language sql as $$
	select format('select public.qorpera_fence_native_context(%L::uuid,%L::jsonb,%L::text[],%L::jsonb)',
		'92400000-0000-4000-8000-000000000020', current_setting('qorpera_test.base_binding'), '{}', pg_temp.fn_view(p_request))
$$;
create function pg_temp.fn_viewed(p_request text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_native_context_views
		where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid and request_id = p_request)
$$;

-- Alice's run records its native start and acknowledges its wake. The owner shares a folder with Alice for reading
-- only; her run reads its file and releases the read.
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
	perform pg_temp.base_public_send(v_binding, 'progress', 'fn-ack');
	v_resource := public.qorpera_folder_set_resource('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'fn-secret',
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform set_config('qorpera_test.fn_resource', v_resource::text, true);
	perform set_config('qorpera_test.fn_grant', public.qorpera_folder_grant('92400000-0000-4000-8000-000000000020',
		pg_temp.base_owner(), v_resource, 'staff_agent', '92400000-0000-4000-8000-000000000030', array['read']) ->> 'grantId', true);
	perform pg_temp.base_commit('{"kind":"platform"}', 'fn-secret', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','fn-secret'),
		jsonb_build_object('op','write','path','fn-secret/s.txt','file',pg_temp.base_stage('secret text'))));
	v_read := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', v_actor, 'fn-secret/s.txt') -> 'entry';
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', v_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version', 'authority', v_read -> 'authority')),
		repeat('0', 64));
end
$$;

-- A call under a member's claims, even through the service role, is refused.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role service_role;
select pg_temp.base_error(pg_temp.fn_call('fn-claims'), '42501', 'Context fence requires cloud authority');
reset role;
select pg_temp.base_claims('service_role');

-- The fence makes the run check: a run whose lease is revoked, whose assignment expired, whose job ended or whose
-- sponsor binding is revoked is refused and records no view. Each case is rolled back.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_case text;
begin
	foreach v_case in array array['lease','assignment','job','sponsor'] loop
		begin
			if v_case = 'lease' then
				update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = clock_timestamp()
				where id = (v_binding ->> 'leaseId')::uuid;
			elsif v_case = 'assignment' then
				update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 second'
				where id = (v_binding ->> 'assignmentId')::uuid;
			elsif v_case = 'job' then
				set local role service_role;
				perform public.qorpera_terminalize_runner_attempt((v_binding ->> 'jobId')::uuid, 'failed', 'Fence check', false);
				reset role;
			elsif v_case = 'sponsor' then
				update public.qorpera_execution_sponsor_bindings set status = 'revoked'
				where id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
			end if;
			set local role service_role;
			perform pg_temp.base_error(pg_temp.fn_call('fn-' || v_case), '42501');
			reset role;
			perform pg_temp.base_assert(not pg_temp.fn_viewed('fn-' || v_case), 'A refused fence recorded its view: ' || v_case);
			raise exception using errcode = 'QTF01';
		exception when sqlstate 'QTF01' then reset role;
		end;
	end loop;
end
$$;

-- The control: while the grant stands, the fence answers and records the view.
set local role service_role;
select set_config('qorpera_test.fn_before', (select public.qorpera_fence_native_context('92400000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.base_binding')::jsonb, '{}', pg_temp.fn_view('fn-before')))::text, true);
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.fn_before')::jsonb ->> 'schema' = 'qorpera.native-context-fence/v1'
	and pg_temp.fn_viewed('fn-before'), 'The fence answers while the grant stands: ' || current_setting('qorpera_test.fn_before'));

-- The owner revokes Alice's grant: the next model request is refused and records nothing.
select public.qorpera_folder_revoke('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(),
	current_setting('qorpera_test.fn_resource')::uuid, current_setting('qorpera_test.fn_grant')::uuid) \g /dev/null
set local role service_role;
select pg_temp.base_error(pg_temp.fn_call('fn-revoked'), '42501', 'A read is no longer readable');
reset role;
select pg_temp.base_assert(not pg_temp.fn_viewed('fn-revoked'), 'A refused fence recorded its view');
rollback;
