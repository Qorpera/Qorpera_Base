-- After file-export cases: original shared export has a completed native receipt.
select set_config('qorpera_test.import_action',jsonb_build_object('kind','transfer','action','import',
 'source',jsonb_build_object('realm','object_storage','assetId',current_setting('qorpera_test.export_asset')::jsonb->'assetId','sha256',repeat('c',64)),
 'destination',jsonb_build_object('realm','company_computer','path','incoming/report.bin'))::text,true);
select set_config('qorpera_test.import_receipt',extensions.gen_random_uuid()::text,true);
create function pg_temp.import_envelope(p_args jsonb default null) returns text language sql as $$
 select jsonb_set(pg_temp.export_envelope(coalesce(p_args,current_setting('qorpera_test.import_action')::jsonb))::jsonb,
  '{operation,logicalOperationKey}','"file-import"')::text
$$;
create function pg_temp.import_effect(p_action text,p_args jsonb default null) returns jsonb language sql as $$
 select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.office_scope')::jsonb,
  current_setting('qorpera_test.office_lease')::jsonb,pg_temp.import_envelope(p_args),p_action,
  case when p_action='authorize' then null else current_setting('qorpera_test.import_receipt')::uuid end,
  case when p_action='authorize' then null else repeat('f',64) end)
$$;
create function pg_temp.import_file(p_action text) returns jsonb language sql as $$
 select public.qorpera_native_office_file_import(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.office_scope')::jsonb,
  current_setting('qorpera_test.office_lease')::jsonb,pg_temp.import_envelope(),current_setting('qorpera_test.import_receipt')::uuid,repeat('f',64),p_action)
$$;
set local role service_role;
select pg_temp.wake_assert(pg_temp.import_effect('authorize')->>'state'='authorized','completed company export admits explicit import');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,sha256}',to_jsonb(repeat('a',64))))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,assetId}','"30000000-0000-4000-8000-000000000099"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',current_setting('qorpera_test.import_action')::jsonb||'{"overwrite":true}')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,realm}','"company_file"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,realm}','"isolated_worker"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{destination,realm}','"isolated_worker"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{destination,path}','"../private"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_file('authorize')$q$,'42501');
reset role;
savepoint import_source;
update public.qorpera_run_operation_receipts set result='{}' where id=current_setting('qorpera_test.export_receipt')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint import_source;
update public.qorpera_runtime_office_resources set state='draining',drained_at=null where receipt_id=current_setting('qorpera_test.export_receipt')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint import_source;
update public.qorpera_artifacts set deleted_at=clock_timestamp(),deleted_by_user_id='30000000-0000-4000-8000-000000000001'
 where id=(current_setting('qorpera_test.export_asset')::jsonb->>'assetId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint import_source;
update public.qorpera_runtime_office_access set state='revoked';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint import_source;
set local role service_role;
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.import_receipt')::uuid,
 'computer_transfer:file-import',encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),repeat('f',64),false);
select pg_temp.wake_error($q$select pg_temp.import_file('confirm')$q$,'42501');
select pg_temp.import_effect('begin');
select pg_temp.wake_error($q$select pg_temp.import_effect('begin')$q$,'55000');
select pg_temp.wake_assert(pg_temp.import_file('authorize')=current_setting('qorpera_test.export_asset')::jsonb,'read authority returns exact immutable source metadata');
-- SQL-only trusted installation assertion. Combined test uses the actual writer.
select set_config('qorpera_test.import_result',pg_temp.import_file('confirm')::text,true);
select pg_temp.wake_assert(pg_temp.import_file('confirm')=current_setting('qorpera_test.import_result')::jsonb,'confirmation preserves original import identity');
select pg_temp.wake_assert(current_setting('qorpera_test.import_result')::jsonb#>>'{destination,path}'='incoming/report.bin'
 and current_setting('qorpera_test.import_result')::jsonb#>>'{source,realm}'='object_storage','provenance identifies both realms');
select pg_temp.import_effect('finish');
select pg_temp.wake_error($q$select pg_temp.import_file('confirm')$q$,'42501');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.import_receipt')::uuid,
 encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
 'inputSha256',encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),'content',jsonb_build_object('kind','json','value',current_setting('qorpera_test.import_result')::jsonb)));
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_file_imports),'one import per original receipt');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_artifact_retention_holds where client_hold_id=current_setting('qorpera_test.import_receipt')::uuid
 and released_at is null and expires_at is null),'source retained for import evidence');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_file_imports','SELECT,INSERT,UPDATE,DELETE'),'import provenance remains private');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_native_office_import_source(jsonb,jsonb)','EXECUTE'),'raw source helper remains private');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_native_office_file_import(jsonb,jsonb,jsonb,text,uuid,text,text)','EXECUTE'),'members cannot impersonate native import');

-- A different admitted staff run may consume a published shared export even
-- after the producer's office access is revoked. No authority helper is replaced.
savepoint import_later_run;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
 '30000000-0000-4000-8000-000000000031',0,true);
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
 '30000000-0000-4000-8000-000000000030',1,false);
select set_config('qorpera_test.import_later_turn',public.qorpera_request_session_turn_v2(
 '30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),extensions.gen_random_uuid(),
 '{"schema":"qorpera.session-prompt/v1","text":"Reuse the shared export.","images":[]}','member_connection',
 (current_setting('qorpera_test.wake_sponsor')::jsonb->>'binding_id')::uuid,1,null,
 (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,
 null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
select set_config('qorpera_test.wake_binding',pg_temp.wake_start((current_setting('qorpera_test.import_later_turn')::jsonb->>'turn_request_id')::uuid)::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)#>>'{identity,staffAgentId}'
 ='30000000-0000-4000-8000-000000000031','consumer has independently admitted staff authority');
select pg_temp.wake_assert(pg_temp.import_effect('authorize')->>'state'='authorized','later company run reuses shared asset after producer grant revocation');
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
reset role;
rollback to savepoint import_later_run;
