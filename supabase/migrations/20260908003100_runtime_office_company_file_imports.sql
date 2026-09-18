-- Company File imports select an exact live path version. No raw canonical
-- mount, member-device path or unbound content hash grants source authority.
create function public.qorpera_native_office_company_file_source(p_binding jsonb,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_read jsonb; v_file jsonb; v_company uuid; v_environment uuid;
 v_cached public.qorpera_verified_company_file_objects%rowtype;
begin
 if not public.qorpera_valid_office_file_import(p_args) or p_args#>>'{source,realm}' is distinct from 'company_file' then
  raise exception 'Invalid Company File import' using errcode='42501'; end if;
 v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
 if v_authority#>>'{identity,audienceKind}' is distinct from 'company' or v_authority#>'{identity,audienceUserId}' is distinct from 'null'::jsonb then
  raise exception 'Company File import requires shared audience' using errcode='42501'; end if;
 v_company:=(v_authority#>>'{identity,companyId}')::uuid; v_environment:=(v_authority#>>'{identity,environmentId}')::uuid;
 perform public.qorpera_assert_wake_work_allowed((p_binding->>'runId')::uuid);
 perform public.qorpera_lock_profile_gc_fence(v_company);
 if public.qorpera_profile_gc_deletion_active(v_company) then raise exception 'Company File storage is busy' using errcode='40001'; end if;
 -- This existing gateway locks the current actor/context, checks path and
 -- audience grants, refuses aliases, and remembers the path in the run read set.
 v_read:=public.qorpera_read_company_path(v_environment,p_args#>>'{source,path}',p_binding);
 if v_read#>>'{entry,kind}' is distinct from 'file' or (v_read->>'version')::uuid is distinct from (p_args#>>'{source,version}')::uuid then
  raise exception 'Company File import source changed' using errcode='40001'; end if;
 v_file:=v_read#>'{entry,file}';
 select * into v_cached from public.qorpera_verified_company_file_objects where profile_id=v_company
  and manifest_sha256=v_file->>'manifestSha256' and verifier_version=1;
 if not found or v_cached.file_sha256 is distinct from v_file->>'fileSha256'
  or v_cached.bytes is distinct from (v_file->>'bytes')::bigint or v_cached.bytes not between 0 and 8388608
  or v_cached.media_type is distinct from 'application/octet-stream' or v_cached.manifest_bytes not between 1 and 8192
  or v_cached.manifest_bytes is distinct from (v_read->>'manifestBytes')::bigint
  or exists(select 1 from jsonb_array_elements(v_cached.objects) o left join public.qorpera_profile_objects stored
   on stored.profile_id=v_company and stored.sha256=o->>'sha256'
   where stored.sha256 is null or stored.bytes is distinct from (o->>'bytes')::bigint or not public.qorpera_object_exists(v_company,o->>'sha256')) then
  raise exception 'Company File import bytes unavailable' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.company-file-transfer-source/v1','companyId',v_company,'environmentId',v_environment,
  'source',p_args->'source','sha256',v_cached.file_sha256,'manifestSha256',v_cached.manifest_sha256,
  'manifestBytes',v_cached.manifest_bytes,'bytes',v_cached.bytes,'mediaType',v_cached.media_type);
end
$$;
revoke all on function public.qorpera_native_office_company_file_source(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.qorpera_valid_office_file_import(p_args jsonb)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p_args)='object' and p_args-array['kind','action','source','destination']='{}'::jsonb
  and p_args->>'kind'='transfer' and p_args->>'action'='import' and jsonb_typeof(p_args->'source')='object'
  and case when p_args#>>'{source,realm}'='company_file' then
   (p_args->'source')-array['realm','path','version']='{}'::jsonb
   and jsonb_typeof(p_args#>'{source,path}')='string' and public.qorpera_company_path_valid(p_args#>>'{source,path}')
   and (p_args#>>'{source,version}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  else (p_args->'source')-array['realm','assetId','sha256']='{}'::jsonb and p_args#>>'{source,realm}'='object_storage'
   and (p_args#>>'{source,assetId}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and (p_args#>>'{source,sha256}') ~ '^[0-9a-f]{64}$' end
  and jsonb_typeof(p_args->'destination')='object' and (p_args->'destination')-array['realm','path']='{}'::jsonb
  and p_args#>>'{destination,realm}'='company_computer' and jsonb_typeof(p_args#>'{destination,path}')='string'
  and public.qorpera_valid_workbench_file_path(p_args#>>'{destination,path}'),false)
$$;

create table public.qorpera_runtime_office_company_file_imports (
 receipt_id uuid primary key references public.qorpera_runtime_office_resources(receipt_id) on delete restrict,
 artifact_id uuid not null unique references public.qorpera_artifacts(id) on delete restrict,
 source jsonb not null check(jsonb_typeof(source)='object'),
 operation_envelope text not null check(octet_length(operation_envelope)<=65536),
 result jsonb not null check(jsonb_typeof(result)='object')
);
alter table public.qorpera_runtime_office_company_file_imports enable row level security;
revoke all on public.qorpera_runtime_office_company_file_imports from public,anon,authenticated,service_role;
create trigger qorpera_office_company_file_import_immutable before update or delete on public.qorpera_runtime_office_company_file_imports
 for each row execute function public.qorpera_reject_runtime_bundle_mutation();

create function public.qorpera_confirm_office_company_file_import(p_binding jsonb,p_scope jsonb,p_lease jsonb,p_envelope text,p_receipt_id uuid,p_source jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_import public.qorpera_runtime_office_company_file_imports%rowtype; v_asset uuid; v_graph uuid;
 v_cached public.qorpera_verified_company_file_objects%rowtype; v_authority jsonb; v_actor uuid; v_result jsonb;
begin
 select * into v_import from public.qorpera_runtime_office_company_file_imports where receipt_id=p_receipt_id;
 if found then
  if v_import.source is distinct from p_source or v_import.operation_envelope<>p_envelope then
   raise exception 'Company File import receipt differs' using errcode='23505'; end if;
  return v_import.result;
 end if;
 v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
 v_actor:=(v_authority#>>'{identity,requesterUserId}')::uuid;
 select * into strict v_cached from public.qorpera_verified_company_file_objects where profile_id=(p_source->>'companyId')::uuid
  and manifest_sha256=p_source->>'manifestSha256' and verifier_version=1;
 -- The trusted adapter has verified the manifest, every chunk, the assembled
 -- file hash and physical installation. Retain that exact closure as evidence.
 insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,owner_staff_agent_id,
  artifact_type,name,root_object_sha256,root_contract,content_sha256,bytes,media_type,created_by_user_id)
 values((p_source->>'companyId')::uuid,(p_source->>'environmentId')::uuid,p_receipt_id,(v_authority#>>'{identity,sessionId}')::uuid,
  (v_authority#>>'{identity,staffAgentId}')::uuid,'office_company_file_import','Company File import source',v_cached.manifest_sha256,
  'qorpera.cloud-file-manifest/v1',v_cached.file_sha256,v_cached.bytes,v_cached.media_type,v_actor) returning id into v_asset;
 v_result:=jsonb_build_object('schema','qorpera.file-import-result/v1','transferId',p_receipt_id,
  'source',(p_source->'source')||jsonb_build_object('assetId',v_asset,'sha256',p_source->'sha256','manifestSha256',p_source->'manifestSha256'),
  'destination',(p_envelope::jsonb#>'{operation,arguments,destination}')||jsonb_build_object('companyComputerId',p_scope->'companyComputerId','screenId',p_lease#>'{binding,screenId}'),
  'bytes',p_source->'bytes','mediaType',p_source->'mediaType');
 insert into public.qorpera_runtime_office_company_file_imports(receipt_id,artifact_id,source,operation_envelope,result)
 values(p_receipt_id,v_asset,p_source,p_envelope,v_result);
 insert into public.qorpera_object_reachability_graphs(profile_id,environment_id,root_kind,root_id,client_graph_id,root_object_sha256,
  contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
 select (p_source->>'companyId')::uuid,(p_source->>'environmentId')::uuid,'artifact',v_asset,p_receipt_id,v_cached.manifest_sha256,1,
  encode(extensions.digest(convert_to(string_agg((o->>'sha256')||':'||(o->>'bytes'),E'\n' order by o->>'sha256'),'UTF8'),'sha256'),'hex'),
  count(*),sum((o->>'bytes')::bigint),v_actor from jsonb_array_elements(v_cached.objects) o returning id into v_graph;
 insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
 select v_graph,o->>'sha256',(o->>'bytes')::bigint from jsonb_array_elements(v_cached.objects) o;
 update public.qorpera_object_reachability_graphs set status='complete',completed_at=clock_timestamp(),closure_verified=true where id=v_graph;
 insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
 values((p_source->>'companyId')::uuid,v_asset,p_receipt_id,'Company File import source receipt',v_actor);
 return v_result;
end
$$;
revoke all on function public.qorpera_confirm_office_company_file_import(jsonb,jsonb,jsonb,text,uuid,jsonb) from public,anon,authenticated,service_role;

-- Only an internally confirmed Company File import can establish this new
-- manifest root. Generic member-created manifest graphs remain unverified.
create function public.qorpera_office_company_file_closure(p_graph public.qorpera_object_reachability_graphs)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(auth.role()='service_role' and p_graph.status='complete' and p_graph.root_kind='artifact' and exists(
  select 1 from public.qorpera_runtime_office_company_file_imports i
  join public.qorpera_artifacts a on a.id=i.artifact_id
  join public.qorpera_verified_company_file_objects c on c.profile_id=a.profile_id and c.manifest_sha256=a.root_object_sha256 and c.verifier_version=1
  where i.artifact_id=p_graph.root_id and a.root_contract='qorpera.cloud-file-manifest/v1'
   and p_graph.profile_id=a.profile_id and p_graph.environment_id=a.environment_id and p_graph.client_graph_id=i.receipt_id
   and p_graph.root_object_sha256=c.manifest_sha256 and a.content_sha256=c.file_sha256 and a.bytes=c.bytes and a.media_type=c.media_type
   and i.source->>'manifestSha256'=c.manifest_sha256 and i.source->>'sha256'=c.file_sha256 and (i.source->>'bytes')::bigint=c.bytes
   and not exists((select o->>'sha256',(o->>'bytes')::bigint from jsonb_array_elements(c.objects) o)
    except (select object_sha256,bytes from public.qorpera_object_reachability_entries where graph_id=p_graph.id))
   and not exists((select object_sha256,bytes from public.qorpera_object_reachability_entries where graph_id=p_graph.id)
    except (select o->>'sha256',(o->>'bytes')::bigint from jsonb_array_elements(c.objects) o))
   and (p_graph.object_count,p_graph.storage_bytes,p_graph.content_sha256)=(select count(*),sum(e.bytes),
    encode(extensions.digest(convert_to(string_agg(e.object_sha256||':'||e.bytes::text,E'\n' order by e.object_sha256),'UTF8'),'sha256'),'hex')
    from public.qorpera_object_reachability_entries e where e.graph_id=p_graph.id)
 ),false)
$$;
revoke all on function public.qorpera_office_company_file_closure(public.qorpera_object_reachability_graphs) from public,anon,authenticated,service_role;

create or replace function public.qorpera_native_office_import_source(p_binding jsonb,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_export public.qorpera_runtime_office_file_exports%rowtype;
 v_asset public.qorpera_artifacts%rowtype; v_resource public.qorpera_runtime_office_resources%rowtype;
 v_receipt public.qorpera_run_operation_receipts%rowtype; v_result jsonb; v_download jsonb;
begin
 if not public.qorpera_valid_office_file_import(p_args) then raise exception 'Invalid office import' using errcode='42501'; end if;
 if p_args#>>'{source,realm}'='company_file' then return public.qorpera_native_office_company_file_source(p_binding,p_args); end if;
 v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
 if v_authority#>>'{identity,audienceKind}' is distinct from 'company' or v_authority#>'{identity,audienceUserId}' is distinct from 'null'::jsonb then
  raise exception 'Shared office import requires company audience' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence((v_authority#>>'{identity,companyId}')::uuid);
 select * into v_export from public.qorpera_runtime_office_file_exports where artifact_id=(p_args#>>'{source,assetId}')::uuid;
 if not found then raise exception 'Completed shared export required' using errcode='42501'; end if;
 select * into strict v_asset from public.qorpera_artifacts where id=v_export.artifact_id for share;
 select * into strict v_resource from public.qorpera_runtime_office_resources where receipt_id=v_export.receipt_id;
 select * into strict v_receipt from public.qorpera_run_operation_receipts where id=v_export.receipt_id for share;
 v_result:=public.qorpera_runtime_office_file_export_json(v_export);
 if v_asset.profile_id::text is distinct from v_authority#>>'{identity,companyId}'
  or v_asset.environment_id::text is distinct from v_authority#>>'{identity,environmentId}'
  or v_asset.content_sha256 is distinct from p_args#>>'{source,sha256}' or v_asset.bytes not between 0 and 8388608
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

create or replace function public.qorpera_native_office_file_import(
 p_binding jsonb,p_scope jsonb,p_lease jsonb,p_envelope text,p_receipt_id uuid,p_idempotency_sha256 text,p_action text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_args jsonb; v_asset jsonb; v_result jsonb; v_import public.qorpera_runtime_office_file_imports%rowtype;
 v_authority jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','confirm') then
  raise exception 'Office import authority required' using errcode='42501'; end if;
 perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
 v_args:=p_envelope::jsonb#>'{operation,arguments}';
 v_asset:=public.qorpera_native_office_import_source(p_binding,v_args);
 if p_action='authorize' then return v_asset; end if;
 if v_args#>>'{source,realm}'='company_file' then
  v_result:=public.qorpera_confirm_office_company_file_import(p_binding,p_scope,p_lease,p_envelope,p_receipt_id,v_asset);
  perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
  return v_result;
 end if;
 v_result:=jsonb_build_object('schema','qorpera.file-import-result/v1','transferId',p_receipt_id,'source',v_args->'source',
  'destination',(v_args->'destination')||jsonb_build_object('companyComputerId',p_scope->'companyComputerId','screenId',p_lease#>'{binding,screenId}'),
  'bytes',v_asset->'bytes','mediaType',v_asset->'mediaType');
 select * into v_import from public.qorpera_runtime_office_file_imports where receipt_id=p_receipt_id;
 if found then
  if v_import.operation_envelope<>p_envelope or v_import.result is distinct from v_result then
   raise exception 'Office import receipt already bound' using errcode='23505'; end if;
 else
  -- Trusted guest assertion after atomic installation; this is provenance, not
  -- a promise that a mutable workbench path will remain unchanged afterward.
  insert into public.qorpera_runtime_office_file_imports(receipt_id,source_artifact_id,operation_envelope,result)
  values(p_receipt_id,(v_asset->>'assetId')::uuid,p_envelope,v_result);
  v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
  insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
  values((v_authority#>>'{identity,companyId}')::uuid,(v_asset->>'assetId')::uuid,p_receipt_id,
   'Company Computer import source receipt',(v_authority#>>'{identity,requesterUserId}')::uuid);
 end if;
 perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
 return v_result;
end
$$;

create or replace function public.qorpera_enforce_object_graph_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_root_creator uuid;
	v_direct_artifact_bytes bigint;
	v_entry_count integer;
	v_entry_bytes bigint;
begin
	v_root_creator := public.qorpera_object_root_creator(new.root_kind, new.root_id);
	if v_root_creator is null or new.created_by_user_id is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if auth.role() is distinct from 'service_role' and auth.uid() is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if tg_op = 'UPDATE' then
		if new.profile_id is distinct from old.profile_id
			or new.environment_id is distinct from old.environment_id
			or new.root_kind is distinct from old.root_kind
			or new.root_id is distinct from old.root_id
			or new.client_graph_id is distinct from old.client_graph_id
			or new.root_object_sha256 is distinct from old.root_object_sha256
			or new.contract_version is distinct from old.contract_version
			or new.content_sha256 is distinct from old.content_sha256
			or new.object_count is distinct from old.object_count
			or new.storage_bytes is distinct from old.storage_bytes
			or new.created_by_user_id is distinct from old.created_by_user_id then
			raise exception 'object reachability graph identity is immutable' using errcode = '22023';
		end if;
		if new.status = 'complete' and new.root_kind = 'artifact' then
			select artifact.bytes into v_direct_artifact_bytes
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1';
			if found and (old.status <> 'complete' or (new.closure_verified and not old.closure_verified)) then
				select count(*), coalesce(sum(entry.bytes), 0)
				into v_entry_count, v_entry_bytes
				from public.qorpera_object_reachability_entries as entry
				where entry.graph_id = new.id;
				if v_entry_count <> 1 or v_entry_bytes <> v_direct_artifact_bytes or not exists (
					select 1
					from public.qorpera_object_reachability_entries as entry
					where entry.graph_id = new.id
						and entry.object_sha256 = new.root_object_sha256
						and entry.bytes = v_direct_artifact_bytes
				) then
					raise exception 'direct artifact reachability must contain exactly its root object'
						using errcode = '22023';
				end if;
				new.closure_verified := true;
			end if;
		end if;
	end if;
	if new.closure_verified and new.root_kind = 'company_snapshot' then
		if new.status <> 'complete' or auth.role() is distinct from 'service_role' then
			raise exception 'company manifest closure requires server verification' using errcode = '42501';
		end if;
	elsif new.closure_verified and (
		new.status <> 'complete'
		or new.root_kind <> 'artifact'
		or not exists (
			select 1
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1'
		)
	) and not public.qorpera_office_company_file_closure(new) then
		raise exception 'manifest reachability closure is not server-verified' using errcode = '42501';
	end if;
	return new;
end
$$;
