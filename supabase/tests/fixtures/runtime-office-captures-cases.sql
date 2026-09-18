-- Native authority + current browser grant from the privacy fixture. Storage
-- catalog confirmation is synthetic; these tests exercise real SQL admission.
set local role service_role;
select set_config('qorpera_test.browser_envelope',pg_temp.browser_envelope('{"kind":"screenshot","surface":"browser"}'),true);
select set_config('qorpera_test.browser_receipt',extensions.gen_random_uuid()::text,true);
select set_config('qorpera_test.capture_image',jsonb_build_object('sha256',repeat('f',64),'bytes',67,
	'mediaType','image/png','width',1,'height',1)::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.browser_receipt')::uuid,'computer_screenshot:browser-effect',
	encode(extensions.digest(current_setting('qorpera_test.browser_envelope'),'sha256'),'hex'),repeat('e',64),false);
create function pg_temp.capture(p_action text,p_image jsonb default null,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_capture(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		coalesce(p_envelope,current_setting('qorpera_test.browser_envelope')),current_setting('qorpera_test.browser_receipt')::uuid,
		repeat('e',64),coalesce(p_image,current_setting('qorpera_test.capture_image')::jsonb),p_action)
$$;
select pg_temp.wake_error($q$select pg_temp.capture('authorize')$q$,'42501');
select pg_temp.browser_effect('begin');
select pg_temp.wake_assert(pg_temp.capture('authorize')='{"state":"authorized"}'::jsonb,'capture uses admitted effect');
select pg_temp.wake_error($q$select pg_temp.capture('publish')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture('authorize',null,pg_temp.browser_envelope('{"kind":"browser","action":"snapshot"}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture('authorize',jsonb_set(current_setting('qorpera_test.capture_image')::jsonb,'{width}','1921'))$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.capture('authorize',jsonb_set(current_setting('qorpera_test.capture_image')::jsonb,'{bytes}','8388609'))$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.capture('authorize',current_setting('qorpera_test.capture_image')::jsonb||'{"url":"https://untrusted.invalid"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.capture('authorize',current_setting('qorpera_test.capture_image')::jsonb-'width')$q$,'22023');
select public.qorpera_confirm_native_company_object_upload(current_setting('qorpera_test.wake_binding')::jsonb,
	(current_setting('qorpera_test.office_scope')::jsonb->>'companyId')::uuid,repeat('f',64),67);
select set_config('qorpera_test.capture_asset',pg_temp.capture('publish')::text,true);
select pg_temp.wake_assert(pg_temp.capture('publish')=current_setting('qorpera_test.capture_asset')::jsonb,'same publication keeps artifact identity');
select pg_temp.wake_error($q$select pg_temp.capture('publish',jsonb_set(current_setting('qorpera_test.capture_image')::jsonb,'{width}','2'))$q$,'23505');
create function pg_temp.capture_read() returns jsonb language sql as $$
	select public.qorpera_read_native_office_capture(current_setting('qorpera_test.wake_binding')::jsonb,
		(current_setting('qorpera_test.capture_asset')::jsonb->>'assetId')::uuid)
$$;
select pg_temp.wake_error($q$select pg_temp.capture_read()$q$,'42501');
select pg_temp.browser_effect('finish');
select pg_temp.wake_error($q$select pg_temp.capture('publish')$q$,'42501');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.browser_receipt')::uuid,encode(extensions.digest(current_setting('qorpera_test.browser_envelope'),'sha256'),'hex'),
	jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
		'inputSha256',encode(extensions.digest(current_setting('qorpera_test.browser_envelope'),'sha256'),'hex'),
		'content',jsonb_build_object('kind','json','value',current_setting('qorpera_test.capture_asset')::jsonb)));
select pg_temp.wake_assert(pg_temp.capture_read()=current_setting('qorpera_test.capture_asset')::jsonb,'completed capture has live run read authority');
create function pg_temp.capture_assert(p_assets jsonb default null) returns jsonb language sql as $$
	select public.qorpera_assert_native_office_captures(current_setting('qorpera_test.wake_binding')::jsonb,
		coalesce(p_assets,jsonb_build_array(current_setting('qorpera_test.capture_asset')::jsonb)))
$$;
select pg_temp.wake_assert(pg_temp.capture_assert()=jsonb_build_object('state','authorized','assets',jsonb_build_array(current_setting('qorpera_test.capture_asset')::jsonb)),'bounded capture authority round trip');
select pg_temp.wake_error($q$select pg_temp.capture_assert('{}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.capture_assert('[null]')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.capture_assert(jsonb_build_array(current_setting('qorpera_test.capture_asset')::jsonb||'{"url":"https://untrusted.invalid"}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture_assert(jsonb_build_array(jsonb_set(current_setting('qorpera_test.capture_asset')::jsonb,'{sha256}',to_jsonb(repeat('a',64)))))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture_assert((select jsonb_agg(current_setting('qorpera_test.capture_asset')::jsonb) from generate_series(1,129)))$q$,'54000');
reset role;
-- Real launch admission, with synthetic tool catalog/context digests. This
-- gives image evidence the same immutable parent lineage as Company File reads.
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
	v_manifest:=public.qorpera_execution_runtime_manifest(v_run);
	set local role service_role;
	perform public.qorpera_begin_native_company_execution_v2(current_setting('qorpera_test.wake_binding')::jsonb,
		v_manifest->>'nativeBinarySha256',v_run.runtime_bundle_sha256,v_run.reasoning_policy_sha256,
		'{"type":"namespace","name":"qorpera","description":"capture fixture","tools":[{"type":"function","name":"computer_screenshot","description":"capture","inputSchema":{"type":"object","additionalProperties":false}}]}',repeat('a',64),10);
end $$;
select set_config('qorpera_test.capture_view',jsonb_build_object('schema','qorpera.native-context-view/v1',
	'requestId','capture-turn','threadId','capture-thread','turnId','capture-turn','purpose','turn','outputs',jsonb_build_array(
		jsonb_build_object('callId','capture-call','kind','function_call_output','sha256',repeat('a',64),'bytes',800,
		'readId',null,'readSha256',null,'includedBytes',null,'includedSha256',null,'capture',current_setting('qorpera_test.capture_asset')::jsonb)))::text,true);
create function pg_temp.capture_view(p_view jsonb default null) returns jsonb language sql as $$
	select public.qorpera_record_native_context_view((current_setting('qorpera_test.office_scope')::jsonb->>'environmentId')::uuid,
		current_setting('qorpera_test.wake_binding')::jsonb,coalesce(p_view,current_setting('qorpera_test.capture_view')::jsonb))
$$;
select set_config('qorpera_test.capture_view_receipt',pg_temp.capture_view()::text,true);
select pg_temp.wake_assert(pg_temp.capture_view()=current_setting('qorpera_test.capture_view_receipt')::jsonb,'exact image view replay is stable');
select pg_temp.wake_error($q$select pg_temp.capture_view(jsonb_set(current_setting('qorpera_test.capture_view')::jsonb,'{outputs,0,capture,sha256}',to_jsonb(repeat('b',64))))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture_view(jsonb_set(current_setting('qorpera_test.capture_view')::jsonb,'{outputs,0,capture}','null'))$q$,'22023');
select pg_temp.capture_view(current_setting('qorpera_test.capture_view')::jsonb||'{"requestId":"capture-compaction","purpose":"compaction","outputs":[]}');
reset role;
select pg_temp.wake_assert((select parent_id=(current_setting('qorpera_test.capture_view_receipt')::jsonb->>'viewId')::uuid
	from public.qorpera_native_context_views where request_id='capture-compaction'),'compaction preserves capture evidence ancestry');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_captures),'one capture per original receipt');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_artifact_retention_holds where client_hold_id=current_setting('qorpera_test.browser_receipt')::uuid
	and released_at is null and expires_at is null),'receipt evidence is retained');
savepoint capture_read_guard;
update public.qorpera_runtime_browser_grants set version=version+1;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.capture_read()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture_assert()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.capture_view()$q$,'42501');
reset role;
rollback to savepoint capture_read_guard;
update public.qorpera_runtime_offices set privacy_version=privacy_version+1;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.capture_read()$q$,'42501');
reset role;
rollback to savepoint capture_read_guard;
update public.qorpera_runtime_office_access set state='revoked';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.capture_read()$q$,'42501');
reset role;
rollback to savepoint capture_read_guard;
update public.qorpera_run_operation_receipts set result=jsonb_set(result,'{content,value,width}','2')
	where id=current_setting('qorpera_test.browser_receipt')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.capture_read()$q$,'42501');
reset role;
rollback to savepoint capture_read_guard;
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_captures','SELECT,INSERT,UPDATE,DELETE'),'capture provenance is private');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)','EXECUTE'),'members cannot publish native captures');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_read_native_office_capture(jsonb,uuid)','EXECUTE'),'members cannot impersonate a native image read');
select pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_read_native_office_capture(jsonb,uuid)','EXECUTE'),'anonymous cannot read images');
