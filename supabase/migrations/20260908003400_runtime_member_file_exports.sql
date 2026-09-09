-- Completed shared exports are company data, independent of the producing
-- agent's expired run or office grant. Their immutable identity is not a grant.
create function public.qorpera_member_file_export_source(p_environment_id uuid,p_source jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_export public.qorpera_runtime_office_file_exports%rowtype;
 v_asset public.qorpera_artifacts%rowtype; v_resource public.qorpera_runtime_office_resources%rowtype;
 v_receipt public.qorpera_run_operation_receipts%rowtype; v_result jsonb;
begin
 v_actor:=public.qorpera_company_path_actor(p_environment_id,null);
 if not coalesce(jsonb_typeof(p_source)='object' and p_source-array['realm','assetId','sha256']='{}'::jsonb
  and p_source->>'realm'='object_storage' and p_source->>'assetId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and p_source->>'sha256' ~ '^[0-9a-f]{64}$',false) then
  raise exception 'Invalid member export selection' using errcode='22023'; end if;
 perform public.qorpera_lock_profile_gc_fence((v_actor->>'companyId')::uuid);
 select * into v_export from public.qorpera_runtime_office_file_exports where artifact_id=(p_source->>'assetId')::uuid;
 if not found then raise exception 'Completed shared export required' using errcode='42501'; end if;
 select * into strict v_asset from public.qorpera_artifacts where id=v_export.artifact_id for share;
 select * into strict v_resource from public.qorpera_runtime_office_resources where receipt_id=v_export.receipt_id;
 select * into strict v_receipt from public.qorpera_run_operation_receipts where id=v_export.receipt_id for share;
 v_result:=public.qorpera_runtime_office_file_export_json(v_export);
 if v_asset.profile_id::text is distinct from v_actor->>'companyId' or v_asset.environment_id is distinct from p_environment_id
  or v_asset.content_sha256 is distinct from p_source->>'sha256' or v_asset.bytes not between 0 and 8388608
  or v_asset.deleted_at is not null or v_asset.gc_completed_at is not null
  or v_asset.artifact_type is distinct from 'office_file_export' or v_asset.root_contract is distinct from 'qorpera.object/v1'
  or v_asset.root_object_sha256 is distinct from v_asset.content_sha256
  or v_resource.state<>'drained' or v_receipt.status<>'completed'
  or v_export.operation_envelope::jsonb#>>'{principals,audienceKind}' is distinct from 'company'
  or v_export.operation_envelope::jsonb#>'{principals,audienceUserId}' is distinct from 'null'::jsonb
  or v_export.operation_envelope::jsonb#>>'{principals,companyId}' is distinct from v_actor->>'companyId'
  or v_export.operation_envelope::jsonb#>>'{principals,environmentId}' is distinct from p_environment_id::text
  or v_receipt.input_sha256<>encode(extensions.digest(convert_to(v_export.operation_envelope,'UTF8'),'sha256'),'hex')
  or v_receipt.result is distinct from jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
   'inputSha256',v_receipt.input_sha256,'content',jsonb_build_object('kind','json','value',v_result))
  or not exists(select 1 from public.qorpera_profile_objects where profile_id=v_asset.profile_id and sha256=v_asset.content_sha256 and bytes=v_asset.bytes)
  or not public.qorpera_object_exists(v_asset.profile_id,v_asset.content_sha256) then
  raise exception 'Shared export differs or is unavailable' using errcode='42501'; end if;
 return jsonb_build_object('companyId',v_asset.profile_id,'environmentId',p_environment_id,'asset',v_result);
end
$$;

create function public.qorpera_list_member_file_exports(p_environment_id uuid,p_after uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_row record; v_source jsonb; v_items jsonb:='[]'; v_last uuid; v_more boolean:=false; v_scanned integer:=0;
begin
 v_actor:=public.qorpera_company_path_actor(p_environment_id,null);
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid export page' using errcode='22023'; end if;
 -- Scan a bounded page; unavailable shared exports are skipped. The cursor
 -- advances over scanned rows so one unavailable file cannot stall discovery.
 for v_row in select a.id,a.content_sha256 from public.qorpera_artifacts a
  join public.qorpera_runtime_office_file_exports e on e.artifact_id=a.id
  join public.qorpera_run_operation_receipts receipt on receipt.id=e.receipt_id
  where a.profile_id=(v_actor->>'companyId')::uuid and a.environment_id=p_environment_id
   and a.deleted_at is null and a.gc_completed_at is null and receipt.status='completed'
   and e.operation_envelope::jsonb#>>'{principals,audienceKind}'='company'
   and e.operation_envelope::jsonb#>'{principals,audienceUserId}'='null'::jsonb
   and (p_after is null or a.id>p_after) order by a.id limit p_limit+1 loop
  if v_scanned>=p_limit then v_more:=true; exit; end if;
  v_scanned:=v_scanned+1;
  v_last:=v_row.id;
  begin
   v_source:=public.qorpera_member_file_export_source(p_environment_id,jsonb_build_object('realm','object_storage','assetId',v_row.id,'sha256',v_row.content_sha256));
   v_items:=v_items||jsonb_build_array(v_source->'asset');
  exception when insufficient_privilege then null;
  end;
 end loop;
 perform public.qorpera_company_path_actor(p_environment_id,null);
 return jsonb_build_object('items',v_items,'nextAfter',case when v_more then v_last else null end);
end
$$;

revoke all on function public.qorpera_member_file_export_source(uuid,jsonb),public.qorpera_list_member_file_exports(uuid,uuid,integer)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_member_file_export_source(uuid,jsonb),public.qorpera_list_member_file_exports(uuid,uuid,integer) to authenticated;
