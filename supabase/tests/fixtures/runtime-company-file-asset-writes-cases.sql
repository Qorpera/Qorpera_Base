-- Run after completed shared-export fixture. Storage catalog bytes here are
-- synthetic; the combined adapter proof must verify actual binary objects.
select set_config('qorpera_test.asset_write_source',jsonb_build_object('realm','object_storage',
 'assetId',current_setting('qorpera_test.export_asset')::jsonb->'assetId','sha256',repeat('c',64))::text,true);
select set_config('qorpera_test.asset_write_manifest',jsonb_build_object('schema','qorpera.cloud-file-manifest/v1',
 'fileSha256',repeat('c',64),'bytes',4,'mediaType','application/octet-stream',
 'chunks',jsonb_build_array(jsonb_build_object('sha256',repeat('c',64),'bytes',4)))::text,true);
select set_config('qorpera_test.asset_write_plan',pg_temp.path_plan('asset-write','output.bin',jsonb_build_object(
 'path','output.bin','kind','file','executable',false,'file',jsonb_build_object('manifestSha256',
 encode(extensions.digest(current_setting('qorpera_test.asset_write_manifest'),'sha256'),'hex'),
 'fileSha256',repeat('c',64),'bytes',4,'mediaType','application/octet-stream')))::text,true);
create function pg_temp.asset_write(p_action text,p_plan jsonb default null,p_source jsonb default null,p_head uuid default null,p_tree text default null)
returns jsonb language sql as $$
 select public.qorpera_native_company_file_write('30000000-0000-4000-8000-000000000020',
 current_setting('qorpera_test.wake_binding')::jsonb,coalesce(p_source,current_setting('qorpera_test.asset_write_source')::jsonb),
 coalesce(p_plan,current_setting('qorpera_test.asset_write_plan')::jsonb),p_action,p_head,p_tree)
$$;
create function pg_temp.asset_write_commit(p_plan jsonb default null)
returns jsonb language plpgsql as $$
declare v_prepared jsonb; v_entries jsonb; v_tree text; v_plan jsonb:=coalesce(p_plan,current_setting('qorpera_test.asset_write_plan')::jsonb);
begin
 v_prepared:=pg_temp.asset_write('prepare',v_plan);
 if v_prepared->>'state'='completed' then return v_prepared->'result'; end if;
 if v_prepared->>'state'='ready' then
  select coalesce(jsonb_agg(value order by value->>'path'),'[]') into v_entries from (
   select value from jsonb_array_elements(v_prepared->'entries') where value->>'path'<>v_plan->>'path'
   union all select v_plan->'entry') entries;
  v_tree:=pg_temp.path_stage_tree(v_entries);
 end if;
 return pg_temp.asset_write('commit',v_plan,null,(v_prepared->>'snapshotId')::uuid,v_tree);
end
$$;
set local role service_role;
select pg_temp.wake_assert(pg_temp.asset_write('check')->>'state'='ready','exact export and destination admitted before staging');
select pg_temp.wake_error($q$select pg_temp.asset_write('prepare')$q$,'55000');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,jsonb_set(current_setting('qorpera_test.asset_write_source')::jsonb,'{realm}','"member_device"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,jsonb_set(current_setting('qorpera_test.asset_write_source')::jsonb,'{realm}','"isolated_worker"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,'{"realm":"isolated_worker","path":"output/report.bin"}')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,current_setting('qorpera_test.asset_write_source')::jsonb||'{"path":"/tmp/file"}')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,jsonb_set(current_setting('qorpera_test.asset_write_source')::jsonb,'{assetId}','"30000000-0000-4000-8000-000000000099"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,'{entry,file,fileSha256}',to_jsonb(repeat('a',64))))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,'{entry,executable}','true'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,'{expectedVersion}','"30000000-0000-4000-8000-000000000099"'))$q$,'PT412');
reset role;
insert into storage.objects(bucket_id,name,metadata) values('qorpera-profile-objects',
 '30000000-0000-4000-8000-000000000010/'||encode(extensions.digest(current_setting('qorpera_test.asset_write_manifest'),'sha256'),'hex'),
 jsonb_build_object('size',octet_length(current_setting('qorpera_test.asset_write_manifest'))));
set local role service_role;
select public.qorpera_verify_company_path_file('30000000-0000-4000-8000-000000000010',current_setting('qorpera_test.asset_write_manifest'));
select pg_temp.wake_assert(pg_temp.asset_write('prepare')->>'state'='ready','verified manifest admits canonical preparation');
-- A second real export has the same bytes but a distinct original receipt.
select set_config('qorpera_test.export_envelope',jsonb_set(current_setting('qorpera_test.export_envelope')::jsonb,
 '{operation,logicalOperationKey}','"file-export-second"')::text,true);
select set_config('qorpera_test.export_receipt',extensions.gen_random_uuid()::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.export_receipt')::uuid,
 'computer_transfer:file-export-second',encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),repeat('e',64),false);
select pg_temp.export_effect('begin');
select set_config('qorpera_test.asset_write_second',pg_temp.export_file('publish')::text,true);
select pg_temp.export_effect('finish');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.export_receipt')::uuid,
 encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
 'inputSha256',encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),
 'content',jsonb_build_object('kind','json','value',current_setting('qorpera_test.asset_write_second')::jsonb)));
reset role;
savepoint asset_write_revocation;
update public.qorpera_company_path_grants set revoked_at=clock_timestamp() where principal_id='30000000-0000-4000-8000-000000000030';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.asset_write_commit()$q$,'42501');
reset role;
rollback to savepoint asset_write_revocation;
update public.qorpera_artifacts set deleted_at=clock_timestamp(),deleted_by_user_id='30000000-0000-4000-8000-000000000001'
 where id=(current_setting('qorpera_test.export_asset')::jsonb->>'assetId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.asset_write_commit()$q$,'42501');
reset role;
rollback to savepoint asset_write_revocation;
-- An exported company asset remains reusable after the producing screen grant ends.
update public.qorpera_runtime_office_access set state='revoked';
set local role service_role;
select set_config('qorpera_test.asset_write_result',pg_temp.asset_write_commit()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.asset_write_result')::jsonb->>'state'='applied','ordinary binary write becomes live');
select pg_temp.wake_assert(pg_temp.asset_write_commit()=current_setting('qorpera_test.asset_write_result')::jsonb,'replay returns original canonical receipt');
select pg_temp.wake_assert(pg_temp.asset_write('commit')=current_setting('qorpera_test.asset_write_result')::jsonb,'lost commit response recovers exact receipt');
select pg_temp.wake_error($q$select pg_temp.asset_write('check',null,jsonb_build_object('realm','object_storage',
 'assetId',current_setting('qorpera_test.asset_write_second')::jsonb->'assetId','sha256',repeat('c',64)))$q$,'23505');
select pg_temp.wake_error($q$select pg_temp.asset_write_commit(jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,'{operationKey}','"stale-new-write"'))$q$,'PT412');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_company_file_asset_writes),'one immutable source provenance record');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_artifact_retention_holds where
 client_hold_id=(current_setting('qorpera_test.asset_write_result')::jsonb->>'receiptId')::uuid and released_at is null and expires_at is null),'source held by canonical receipt');
select pg_temp.wake_assert((select source=current_setting('qorpera_test.export_asset')::jsonb and plan=current_setting('qorpera_test.asset_write_plan')::jsonb
 from public.qorpera_company_file_asset_writes),'provenance retains exact original source and destination plan');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_company_file_asset_writes','SELECT,INSERT,UPDATE,DELETE'),'private transfer provenance');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_native_shared_file_export_source(jsonb,jsonb)','EXECUTE'),'private shared export helper');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text)','EXECUTE'),'members cannot impersonate native writes');
set local role service_role;
select set_config('qorpera_test.asset_ordinary_plan',jsonb_set(jsonb_set(jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,
 '{path}','"ordinary.bin"'),'{entry,path}','"ordinary.bin"'),'{operationKey}','"ordinary-write"')::text,true);
select pg_temp.path_commit(current_setting('qorpera_test.asset_ordinary_plan')::jsonb);
select pg_temp.wake_error($q$select pg_temp.asset_write('check',current_setting('qorpera_test.asset_ordinary_plan')::jsonb)$q$,'23505');
select set_config('qorpera_test.asset_protected_plan',jsonb_set(jsonb_set(jsonb_set(current_setting('qorpera_test.asset_write_plan')::jsonb,
 '{path}','"AGENTS.md"'),'{entry,path}','"AGENTS.md"'),'{operationKey}','"asset-protected"')::text,true);
select set_config('qorpera_test.asset_head',(select head_snapshot_id::text from public.qorpera_company_files
 where environment_id='30000000-0000-4000-8000-000000000020'),true);
select set_config('qorpera_test.asset_proposal',pg_temp.asset_write_commit(current_setting('qorpera_test.asset_protected_plan')::jsonb)::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.asset_proposal')::jsonb->>'state'='proposed','protected binary write only proposes');
reset role;
select pg_temp.wake_assert((select head_snapshot_id::text=current_setting('qorpera_test.asset_head') from public.qorpera_company_files
 where environment_id='30000000-0000-4000-8000-000000000020'),'proposal does not advance live head');
-- Existing human consent and approval worker consume the exact retained plan.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.asset_proposal_view',public.qorpera_get_company_path_proposal(
 (current_setting('qorpera_test.asset_proposal')::jsonb->>'proposalId')::uuid)::text,true);
select public.qorpera_review_company_path_proposal((current_setting('qorpera_test.asset_proposal')::jsonb->>'proposalId')::uuid,
 current_setting('qorpera_test.asset_proposal_view')::jsonb->>'planSha256','approve');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_prepared jsonb; v_entries jsonb; v_result jsonb; v_id uuid:=(current_setting('qorpera_test.asset_proposal')::jsonb->>'proposalId')::uuid;
 v_sha text:=current_setting('qorpera_test.asset_proposal_view')::jsonb->>'planSha256';
begin
 v_prepared:=public.qorpera_prepare_company_path_approval(v_id,v_sha);
 select coalesce(jsonb_agg(value order by value->>'path'),'[]') into v_entries from (
  select value from jsonb_array_elements(v_prepared->'entries') where value->>'path'<>v_prepared#>>'{plan,path}'
  union all select v_prepared#>'{plan,entry}') entries;
 v_result:=public.qorpera_apply_company_path_approval(v_id,v_sha,(v_prepared->>'snapshotId')::uuid,pg_temp.path_stage_tree(v_entries));
 perform pg_temp.wake_assert(v_result->>'state'='applied','human-approved exact binary proposal becomes live');
 perform pg_temp.wake_assert(public.qorpera_apply_company_path_approval(v_id,v_sha,null,null)=v_result,'approval replay remains idempotent');
end
$$;
reset role;
