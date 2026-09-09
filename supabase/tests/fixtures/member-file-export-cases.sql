-- Runs after the existing real native/office export fixture in one transaction.
reset role;
create function pg_temp.member_export(p_source jsonb default null) returns jsonb language sql as $$
 select public.qorpera_member_file_export_source((current_setting('qorpera_test.office_scope')::jsonb->>'environmentId')::uuid,
  coalesce(p_source,jsonb_build_object('realm','object_storage','assetId',current_setting('qorpera_test.export_asset')::jsonb->>'assetId','sha256',current_setting('qorpera_test.export_asset')::jsonb->>'sha256')))
$$;
create function pg_temp.member_exports(p_after uuid default null,p_limit integer default 50) returns jsonb language sql as $$
 select public.qorpera_list_member_file_exports((current_setting('qorpera_test.office_scope')::jsonb->>'environmentId')::uuid,p_after,p_limit)
$$;
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_member_file_export_source(uuid,jsonb)','EXECUTE')
 and not has_function_privilege('anon','public.qorpera_list_member_file_exports(uuid,uuid,integer)','EXECUTE'),'only authenticated member entrypoints');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.wake_assert(pg_temp.member_export()->'asset'=current_setting('qorpera_test.export_asset')::jsonb,'ordinary member reads exact completed shared export');
select pg_temp.wake_assert(pg_temp.member_exports()=jsonb_build_object('items',jsonb_build_array(current_setting('qorpera_test.export_asset')::jsonb),'nextAfter',null),'bounded member discovery');
select pg_temp.wake_assert(pg_temp.member_exports((current_setting('qorpera_test.export_asset')::jsonb->>'assetId')::uuid)->'items'='[]'::jsonb,'cursor advances past exact immutable asset');
select pg_temp.wake_error($q$select pg_temp.member_exports(null,51)$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.member_export(jsonb_build_object('realm','object_storage','assetId',current_setting('qorpera_test.export_asset')::jsonb->>'assetId','sha256',repeat('a',64)))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.member_export('{"realm":"company_computer","path":"projects/report.bin"}')$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_member_file_export_source('30000000-0000-4000-8000-000000000099',jsonb_build_object('realm','object_storage','assetId',current_setting('qorpera_test.export_asset')::jsonb->>'assetId','sha256',repeat('c',64)))$q$,'55000');
reset role;
savepoint member_exports;
update public.qorpera_runtime_office_access set state='revoked';
set local role authenticated;
select pg_temp.wake_assert(pg_temp.member_export()->'asset'=current_setting('qorpera_test.export_asset')::jsonb,'completed shared data outlives the producing office grant');
reset role;
rollback to savepoint member_exports;
update public.qorpera_artifacts set deleted_at=clock_timestamp(),deleted_by_user_id='30000000-0000-4000-8000-000000000001' where id=(current_setting('qorpera_test.export_asset')::jsonb->>'assetId')::uuid;
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_export()$q$,'42501');
select pg_temp.wake_assert(pg_temp.member_exports()->'items'='[]'::jsonb,'deleted exports are not discovered');
reset role;
rollback to savepoint member_exports;
update public.qorpera_runtime_office_resources set state='draining',drained_at=null where receipt_id=current_setting('qorpera_test.export_receipt')::uuid;
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_export()$q$,'42501');
reset role;
rollback to savepoint member_exports;
update public.qorpera_run_operation_receipts set result='{}'::jsonb where id=current_setting('qorpera_test.export_receipt')::uuid;
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_export()$q$,'42501');
reset role;
rollback to savepoint member_exports;
update public.qorpera_runtime_office_file_exports set operation_envelope=jsonb_set(operation_envelope::jsonb,'{principals,audienceKind}','"member_private"')::text;
-- Keep hash/result consistency so audience privacy is the only refusal reason.
update public.qorpera_run_operation_receipts r set input_sha256=encode(extensions.digest(convert_to(e.operation_envelope,'UTF8'),'sha256'),'hex'),
 result=jsonb_set(r.result,'{inputSha256}',to_jsonb(encode(extensions.digest(convert_to(e.operation_envelope,'UTF8'),'sha256'),'hex')))
 from public.qorpera_runtime_office_file_exports e where r.id=e.receipt_id;
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_export()$q$,'42501');
select pg_temp.wake_assert(pg_temp.member_exports()->'items'='[]'::jsonb,'private exports are not discovered');
reset role;
rollback to savepoint member_exports;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_export()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.member_exports()$q$,'42501');
reset role;
rollback to savepoint member_exports;

-- Catalog clones isolate pagination from native execution. Their source
-- descriptors retain completed result consistency; the first is unavailable.
do $$ declare r public.qorpera_run_operation_receipts%rowtype; o public.qorpera_runtime_office_resources%rowtype;
 a public.qorpera_artifacts%rowtype; e public.qorpera_runtime_office_file_exports%rowtype; i integer; ids uuid[];
begin
 for i in 1..2 loop
  select * into r from public.qorpera_run_operation_receipts where id=current_setting('qorpera_test.export_receipt')::uuid;
  select * into o from public.qorpera_runtime_office_resources where receipt_id=r.id;
  select * into e from public.qorpera_runtime_office_file_exports where receipt_id=r.id;
  select * into a from public.qorpera_artifacts where id=e.artifact_id;
  r.id:=extensions.gen_random_uuid(); r.logical_operation_key:='page-'||i;
  a.id:=extensions.gen_random_uuid(); a.client_artifact_id:=r.id;
  r.result:=jsonb_set(r.result,'{content,value,assetId}',to_jsonb(a.id));
  o.id:=extensions.gen_random_uuid(); o.receipt_id:=r.id; e.receipt_id:=r.id; e.artifact_id:=a.id;
  insert into public.qorpera_run_operation_receipts select r.*;
  insert into public.qorpera_runtime_office_resources select o.*;
  insert into public.qorpera_artifacts select a.*;
  insert into public.qorpera_runtime_office_file_exports select e.*;
 end loop;
 select array_agg(artifact_id order by artifact_id) into ids from public.qorpera_runtime_office_file_exports;
 perform set_config('qorpera_test.export_page_ids',to_jsonb(ids)::text,true);
 update public.qorpera_run_operation_receipts set result='{}'::jsonb
 where id=(select receipt_id from public.qorpera_runtime_office_file_exports where artifact_id=ids[1]);
end $$;
set local role authenticated;
select pg_temp.wake_assert(pg_temp.member_exports(null,1)=jsonb_build_object('items','[]'::jsonb,'nextAfter',current_setting('qorpera_test.export_page_ids')::jsonb->0),'unavailable first page still advances');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.member_exports((current_setting('qorpera_test.export_page_ids')::jsonb->>0)::uuid,1)->'items')=1
 and pg_temp.member_exports((current_setting('qorpera_test.export_page_ids')::jsonb->>0)::uuid,1)->>'nextAfter'=current_setting('qorpera_test.export_page_ids')::jsonb->>1,'next page returns valid export and advancing cursor');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.member_exports((current_setting('qorpera_test.export_page_ids')::jsonb->>1)::uuid,1)->'items')=1
 and pg_temp.member_exports((current_setting('qorpera_test.export_page_ids')::jsonb->>1)::uuid,1)->'nextAfter'='null'::jsonb,'last page terminates');
reset role;
rollback to savepoint member_exports;

-- Manifest size is measured before compression, while hashes and immutability
-- remain enforced. The accepted payload exceeds the previous logical bound.
do $$ declare v_manifest jsonb; begin
 v_manifest:=jsonb_build_object('fixture',repeat('x',70000));
 insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
 values('test.manifest.capacity',1,v_manifest,encode(extensions.digest(convert_to(v_manifest::text,'utf8'),'sha256'),'hex'));
 v_manifest:=jsonb_build_object('fixture',repeat('x',131072));
 begin
  insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
  values('test.manifest.capacity',2,v_manifest,encode(extensions.digest(convert_to(v_manifest::text,'utf8'),'sha256'),'hex'));
  raise exception 'Oversized runtime manifest admitted';
 exception when check_violation then null;
 end;
end $$;
