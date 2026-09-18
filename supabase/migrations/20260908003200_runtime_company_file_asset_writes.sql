-- Reuse completed shared exports in the governed Company File mutation gateway.
create function public.qorpera_native_shared_file_export_source(p_binding jsonb,p_source jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_export public.qorpera_runtime_office_file_exports%rowtype;
 v_asset public.qorpera_artifacts%rowtype; v_resource public.qorpera_runtime_office_resources%rowtype;
 v_receipt public.qorpera_run_operation_receipts%rowtype; v_result jsonb; v_download jsonb;
begin
 if not coalesce(jsonb_typeof(p_source)='object' and p_source-array['realm','assetId','sha256']='{}'::jsonb
  and p_source->>'realm'='object_storage' and (p_source->>'assetId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (p_source->>'sha256') ~ '^[0-9a-f]{64}$',false) then
  raise exception 'Invalid shared file selection' using errcode='42501'; end if;
 v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
 if v_authority#>>'{identity,audienceKind}' is distinct from 'company' or v_authority#>'{identity,audienceUserId}' is distinct from 'null'::jsonb then
  raise exception 'Shared office import requires company audience' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence((v_authority#>>'{identity,companyId}')::uuid);
 select * into v_export from public.qorpera_runtime_office_file_exports where artifact_id=(p_source->>'assetId')::uuid;
 if not found then raise exception 'Completed shared export required' using errcode='42501'; end if;
 select * into strict v_asset from public.qorpera_artifacts where id=v_export.artifact_id for share;
 select * into strict v_resource from public.qorpera_runtime_office_resources where receipt_id=v_export.receipt_id;
 select * into strict v_receipt from public.qorpera_run_operation_receipts where id=v_export.receipt_id for share;
 v_result:=public.qorpera_runtime_office_file_export_json(v_export);
 if v_asset.profile_id::text is distinct from v_authority#>>'{identity,companyId}'
  or v_asset.environment_id::text is distinct from v_authority#>>'{identity,environmentId}'
  or v_asset.content_sha256 is distinct from p_source->>'sha256' or v_asset.bytes not between 0 and 8388608
  or v_asset.deleted_at is not null or v_asset.gc_completed_at is not null
  or v_resource.state<>'drained' or v_receipt.status<>'completed'
  or v_export.operation_envelope::jsonb#>>'{principals,audienceKind}' is distinct from 'company'
  or v_export.operation_envelope::jsonb#>'{principals,audienceUserId}' is distinct from 'null'::jsonb
  or v_receipt.input_sha256<>encode(extensions.digest(convert_to(v_export.operation_envelope,'UTF8'),'sha256'),'hex')
  or v_receipt.result is distinct from jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
   'inputSha256',v_receipt.input_sha256,'content',jsonb_build_object('kind','json','value',v_result)) then
  raise exception 'Shared export source differs or is unavailable' using errcode='42501'; end if;
 -- Shared export publication is durable company data, not the original run's
 -- ephemeral browser grant. Later company runs may reuse it with current access.
 v_download:=public.qorpera_authorize_native_company_object_download(p_binding,v_asset.profile_id,v_asset.content_sha256);
 if v_download->>'bytes' is distinct from v_asset.bytes::text then raise exception 'Shared export bytes changed' using errcode='42501'; end if;
 return v_result;
end
$$;

revoke all on function public.qorpera_native_shared_file_export_source(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.qorpera_native_office_import_source(p_binding jsonb,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.qorpera_valid_office_file_import(p_args) then raise exception 'Invalid office import' using errcode='42501'; end if;
 if p_args#>>'{source,realm}'='company_file' then return public.qorpera_native_office_company_file_source(p_binding,p_args); end if;
 return public.qorpera_native_shared_file_export_source(p_binding,p_args->'source');
end
$$;

create function public.qorpera_native_company_file_write_source(p_environment_id uuid,p_binding jsonb,p_source jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_binding is null then
  raise exception 'Native Company File authority required' using errcode='42501'; end if;
 v_actor:=public.qorpera_company_path_actor(p_environment_id,p_binding);
 perform public.qorpera_company_path_assert_context(v_actor);
 perform public.qorpera_assert_wake_work_allowed((p_binding->>'runId')::uuid);
 return public.qorpera_native_shared_file_export_source(p_binding,p_source);
end
$$;
revoke all on function public.qorpera_native_company_file_write_source(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qorpera_native_company_file_write_source(uuid,jsonb,jsonb) to service_role;

create table public.qorpera_company_file_asset_writes (
 receipt_id uuid primary key references public.qorpera_run_operation_receipts(id) on delete restrict,
 source_artifact_id uuid not null references public.qorpera_artifacts(id) on delete restrict,
 source jsonb not null check(jsonb_typeof(source)='object'),
 plan jsonb not null check(jsonb_typeof(plan)='object'),
 result jsonb not null check(jsonb_typeof(result)='object')
);
alter table public.qorpera_company_file_asset_writes enable row level security;
revoke all on public.qorpera_company_file_asset_writes from public,anon,authenticated,service_role;
create trigger qorpera_company_file_asset_write_immutable before update or delete on public.qorpera_company_file_asset_writes
 for each row execute function public.qorpera_reject_runtime_bundle_mutation();

-- All canonical effects and protected proposals still use the existing atomic
-- mutation gateway. A transfer may not decorate a pre-existing text receipt or
-- replace its selected source, even when two assets contain identical bytes.
create function public.qorpera_native_company_file_write(p_environment_id uuid,p_binding jsonb,p_source jsonb,p_plan jsonb,p_action text,
 p_expected_head uuid default null,p_tree_sha256 text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_source jsonb; v_checked jsonb; v_result jsonb; v_write public.qorpera_company_file_asset_writes%rowtype; v_actor jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_binding is null or p_action is null or p_action not in ('check','prepare','commit')
  or (p_action<>'commit' and (p_expected_head is not null or p_tree_sha256 is not null)) then
  raise exception 'Native Company File write authority required' using errcode='42501'; end if;
 v_source:=public.qorpera_native_company_file_write_source(p_environment_id,p_binding,p_source);
 v_checked:=public.qorpera_check_company_path_mutation(p_environment_id,p_binding,p_plan);
 if p_plan#>>'{entry,kind}' is distinct from 'file' or p_plan#>'{entry,executable}' is distinct from 'false'::jsonb
  or p_plan#>>'{entry,file,fileSha256}' is distinct from v_source->>'sha256'
  or p_plan#>'{entry,file,bytes}' is distinct from v_source->'bytes'
  or p_plan#>>'{entry,file,mediaType}' is distinct from 'application/octet-stream' then
  raise exception 'Company File bytes differ from selected export' using errcode='42501'; end if;
 if v_checked->>'state'='completed' then
  select * into v_write from public.qorpera_company_file_asset_writes where receipt_id=(v_checked#>>'{result,receiptId}')::uuid;
  if not found or v_write.source is distinct from v_source or v_write.plan is distinct from p_plan
   or v_write.result is distinct from v_checked->'result' then
   raise exception 'Company File operation is bound to different source provenance' using errcode='23505'; end if;
  return case when p_action='commit' then v_checked->'result' else v_checked end;
 end if;
 if p_action='check' then return v_checked; end if;
 if p_action='prepare' then return public.qorpera_prepare_company_path_mutation(p_environment_id,p_binding,p_plan); end if;
 v_result:=public.qorpera_commit_company_path_mutation(p_environment_id,p_binding,p_plan,p_expected_head,p_tree_sha256);
 insert into public.qorpera_company_file_asset_writes(receipt_id,source_artifact_id,source,plan,result)
 values((v_result->>'receiptId')::uuid,(v_source->>'assetId')::uuid,v_source,p_plan,v_result);
 v_actor:=public.qorpera_company_path_actor(p_environment_id,p_binding);
 insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
 values((v_actor->>'companyId')::uuid,(v_source->>'assetId')::uuid,(v_result->>'receiptId')::uuid,
  'Company File mutation source receipt',(v_actor->>'userId')::uuid);
 return v_result;
end
$$;
revoke all on function public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text) from public,anon,authenticated;
grant execute on function public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text) to service_role;
