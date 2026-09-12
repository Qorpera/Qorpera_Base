-- Follows ordinary import cases and company-file-source; current native/office
-- admission is real. SQL-only install confirmation is a trusted adapter fixture.
select set_config('qorpera_test.import_receipt',extensions.gen_random_uuid()::text,true);
select set_config('qorpera_test.import_action',jsonb_build_object('kind','transfer','action','import',
 'source',current_setting('qorpera_test.company_import_source')::jsonb->'source',
 'destination',jsonb_build_object('realm','company_computer','path','canonical-import.bin'))::text,true);
create or replace function pg_temp.import_envelope(p_args jsonb default null) returns text language sql as $$
 select jsonb_set(pg_temp.export_envelope(coalesce(p_args,current_setting('qorpera_test.import_action')::jsonb))::jsonb,
  '{operation,logicalOperationKey}','"company-file-import"')::text
$$;
set local role service_role;
select pg_temp.wake_assert(pg_temp.import_effect('authorize')->>'state'='authorized','exact live Company File version admits import');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,version}',to_jsonb(extensions.gen_random_uuid())))$q$,'PGRST');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,path}','"SOURCE.bin"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,path}','"../source.bin"'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize',jsonb_set(current_setting('qorpera_test.import_action')::jsonb,'{source,assetId}',to_jsonb(extensions.gen_random_uuid())))$q$,'42501');
reset role;
savepoint company_import_change;
update public.qorpera_company_path_entries set version=extensions.gen_random_uuid() where path='source.bin';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'PGRST');
reset role;
rollback to savepoint company_import_change;
-- A policy withdrawal is an authorization failure even though bytes/version stay.
update public.qorpera_company_path_grants set revoked_at=clock_timestamp() where principal_id='30000000-0000-4000-8000-000000000030';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.import_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint company_import_change;
set local role service_role;
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.import_receipt')::uuid,
 'computer_transfer:company-file-import',encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),repeat('f',64),false);
select pg_temp.import_effect('begin');
select set_config('qorpera_test.company_import_authorized',pg_temp.import_file('authorize')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.company_import_authorized')::jsonb->>'schema'='qorpera.company-file-transfer-source/v1'
 and current_setting('qorpera_test.company_import_authorized')::jsonb->'source'=current_setting('qorpera_test.company_import_source')::jsonb->'source','source read is bound to exact selection');
select set_config('qorpera_test.import_result',pg_temp.import_file('confirm')::text,true);
select pg_temp.wake_assert(pg_temp.import_file('confirm')=current_setting('qorpera_test.import_result')::jsonb,'same confirmation retains one source artifact');
select pg_temp.import_effect('finish');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.import_receipt')::uuid,
 encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
 'inputSha256',encode(extensions.digest(pg_temp.import_envelope(),'sha256'),'hex'),'content',jsonb_build_object('kind','json','value',current_setting('qorpera_test.import_result')::jsonb)));
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_company_file_imports),'one Company File import');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_artifact_retention_holds where client_hold_id=current_setting('qorpera_test.import_receipt')::uuid
 and released_at is null and expires_at is null),'immutable source artifact retained');
select pg_temp.wake_assert((select g.status='complete' and g.closure_verified and g.object_count=2 and count(e.*)=2
 from public.qorpera_object_reachability_graphs g join public.qorpera_object_reachability_entries e on e.graph_id=g.id
 where g.root_id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid group by g.id),'manifest and chunk closure retained');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_company_file_imports','SELECT,INSERT,UPDATE,DELETE'),'source receipt private');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_native_office_company_file_source(jsonb,jsonb)','EXECUTE'),'source helper private');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_office_company_file_closure(public.qorpera_object_reachability_graphs)','EXECUTE'),'closure helper private');
savepoint import_closure_guard;
-- An authenticated creator cannot assert manifest verification, even for a
-- known internal import; the old member graph boundary remains in place.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$update public.qorpera_object_reachability_graphs set closure_verified=true
 where root_id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid$q$,'42501');
rollback to savepoint import_closure_guard;
delete from public.qorpera_object_reachability_entries where graph_id=(select id from public.qorpera_object_reachability_graphs
 where root_id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid)
 and object_sha256=current_setting('qorpera_test.company_import_authorized')::jsonb->>'sha256';
select pg_temp.wake_error($q$update public.qorpera_object_reachability_graphs set closure_verified=true
 where root_id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid$q$,'42501');
rollback to savepoint import_closure_guard;
-- Even an identical known manifest with a separately created artifact has no
-- internally confirmed import and must not acquire server-verified closure.
do $$
declare v_artifact uuid:=extensions.gen_random_uuid(); v_graph uuid:=extensions.gen_random_uuid(); v_original uuid;
begin
 select id into strict v_original from public.qorpera_object_reachability_graphs
  where root_id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid;
 insert into public.qorpera_artifacts select (jsonb_populate_record(null::public.qorpera_artifacts,
  to_jsonb(a)||jsonb_build_object('id',v_artifact,'client_artifact_id',extensions.gen_random_uuid()))).*
  from public.qorpera_artifacts a where a.id=(current_setting('qorpera_test.import_result')::jsonb#>>'{source,assetId}')::uuid;
 insert into public.qorpera_object_reachability_graphs select (jsonb_populate_record(null::public.qorpera_object_reachability_graphs,
  to_jsonb(g)||jsonb_build_object('id',v_graph,'root_id',v_artifact,'client_graph_id',extensions.gen_random_uuid(),'status','uploading','completed_at',null,'closure_verified',false))).*
  from public.qorpera_object_reachability_graphs g where g.id=v_original;
 insert into public.qorpera_object_reachability_entries select v_graph,object_sha256,bytes from public.qorpera_object_reachability_entries where graph_id=v_original;
 perform pg_temp.wake_error(format('update public.qorpera_object_reachability_graphs set status=''complete'',completed_at=clock_timestamp(),closure_verified=true where id=%L',v_graph),'42501');
end
$$;
rollback to savepoint import_closure_guard;
