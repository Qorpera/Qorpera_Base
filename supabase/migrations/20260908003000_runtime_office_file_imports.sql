-- Explicit imports consume completed shared export assets. Private captures,
-- raw hashes, Company File paths and member-device paths are not import grants.
create function public.qorpera_valid_office_file_import(p_args jsonb)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p_args)='object' and p_args-array['kind','action','source','destination']='{}'::jsonb
  and p_args->>'kind'='transfer' and p_args->>'action'='import'
  and jsonb_typeof(p_args->'source')='object' and (p_args->'source')-array['realm','assetId','sha256']='{}'::jsonb
  and p_args#>>'{source,realm}'='object_storage'
  and (p_args#>>'{source,assetId}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (p_args#>>'{source,sha256}') ~ '^[0-9a-f]{64}$'
  and jsonb_typeof(p_args->'destination')='object' and (p_args->'destination')-array['realm','path']='{}'::jsonb
  and p_args#>>'{destination,realm}'='company_computer' and jsonb_typeof(p_args#>'{destination,path}')='string'
  and public.qorpera_valid_workbench_file_path(p_args#>>'{destination,path}'),false)
$$;

create function public.qorpera_native_office_import_source(p_binding jsonb,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_export public.qorpera_runtime_office_file_exports%rowtype;
 v_asset public.qorpera_artifacts%rowtype; v_resource public.qorpera_runtime_office_resources%rowtype;
 v_receipt public.qorpera_run_operation_receipts%rowtype; v_result jsonb; v_download jsonb;
begin
 if not public.qorpera_valid_office_file_import(p_args) then raise exception 'Invalid office import' using errcode='42501'; end if;
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
revoke all on function public.qorpera_valid_office_file_import(jsonb),public.qorpera_native_office_import_source(jsonb,jsonb)
 from public,anon,authenticated,service_role;

create table public.qorpera_runtime_office_file_imports (
 receipt_id uuid primary key references public.qorpera_runtime_office_resources(receipt_id) on delete restrict,
 source_artifact_id uuid not null references public.qorpera_artifacts(id) on delete restrict,
 operation_envelope text not null check(octet_length(operation_envelope)<=65536),
 result jsonb not null check(jsonb_typeof(result)='object')
);
alter table public.qorpera_runtime_office_file_imports enable row level security;
revoke all on public.qorpera_runtime_office_file_imports from public,anon,authenticated,service_role;

create function public.qorpera_native_office_file_import(
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
revoke all on function public.qorpera_native_office_file_import(jsonb,jsonb,jsonb,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.qorpera_native_office_file_import(jsonb,jsonb,jsonb,text,uuid,text,text) to service_role;

create or replace function public.qorpera_native_office_operation(
	p_binding jsonb,p_scope jsonb,p_lease jsonb,p_envelope text,p_action text,
	p_receipt_id uuid default null,p_idempotency_sha256 text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_envelope jsonb; v_operation jsonb; v_authority jsonb; v_descriptor jsonb; v_checked jsonb;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_resource public.qorpera_runtime_office_resources%rowtype;
	v_sha text; v_until timestamptz;
begin
	if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','begin','check','finish')
		or p_envelope is null or octet_length(p_envelope)>65536 then
		raise exception 'Invalid office effect request' using errcode='42501';
	end if;
	v_sha:=encode(extensions.digest(convert_to(p_envelope,'UTF8'),'sha256'),'hex');
	if p_action='finish' then
		-- A successful guest completion is a drain assertion by the trusted
		-- runtime. It grants no data/effect authority and survives cancellation.
		-- Lock office first, consistently with screen release and takeover.
		perform 1 from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid
			and public.qorpera_runtime_office_scope(qorpera_runtime_offices)=p_scope for update;
		if not found then raise exception 'Office cleanup scope differs' using errcode='42501'; end if;
		select * into v_resource from public.qorpera_runtime_office_resources where receipt_id=p_receipt_id for update;
		if not found or v_resource.office_id::text is distinct from p_scope->>'companyComputerId'
			or v_resource.native_binding is distinct from p_binding or v_resource.screen_lease is distinct from p_lease-'validForMs'
			or v_resource.input_sha256<>v_sha or v_resource.downstream_idempotency_sha256 is distinct from p_idempotency_sha256 then
			raise exception 'Office resource cleanup differs' using errcode='42501';
		end if;
		update public.qorpera_runtime_office_resources set state='drained',drained_at=coalesce(drained_at,clock_timestamp()) where id=v_resource.id;
		return '{"state":"drained"}'::jsonb;
	end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_checked:=public.qorpera_native_office_screen(p_binding,p_scope,'check',p_lease);
	perform public.qorpera_assert_wake_work_allowed((p_binding->>'runId')::uuid);
	v_until:=clock_timestamp()+least((v_authority->>'validForMs')::bigint,(v_checked#>>'{lease,validForMs}')::bigint)*interval '1 millisecond';
	v_descriptor:=public.qorpera_native_office_descriptor(p_binding);
	v_envelope:=p_envelope::jsonb;
	v_operation:=v_envelope->'operation';
	if jsonb_typeof(v_envelope) is distinct from 'object' or v_envelope-'schema'-'principals'-'operation'<>'{}'::jsonb
		or v_envelope->>'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_envelope->'principals' is distinct from (v_authority->'identity')-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion']
		or jsonb_typeof(v_operation) is distinct from 'object'
		or v_operation-array['tool','toolVersion','logicalOperationKey','arguments','target','requiresCompanyRevision']<>'{}'::jsonb
		or v_operation->>'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation->'requiresCompanyRevision' is distinct from 'false'::jsonb
		or coalesce(v_operation->>'logicalOperationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or v_descriptor->>'state' is distinct from 'available' or v_descriptor->'scope' is distinct from p_scope
		or v_operation->'target' is distinct from jsonb_build_object('realm','company_computer','binding',p_lease->'binding','resources',v_descriptor->'resources')
		or v_operation->>'tool' is distinct from 'computer_'||(v_operation#>>'{arguments,kind}')
		or coalesce(v_operation#>>'{arguments,kind}','') not in ('screen','shell','browser','desktop','screenshot','transfer') then
		raise exception 'Office effect differs from current authority' using errcode='42501';
	end if;
	if v_operation#>>'{arguments,kind}'='screen' then
		if (v_operation->'arguments')-'kind'-'action'<>'{}'::jsonb
			or coalesce(v_operation#>>'{arguments,action}','') not in ('open','release') then
			raise exception 'Invalid office screen operation' using errcode='22023';
		end if;
	elsif v_operation#>>'{arguments,kind}'='transfer' then
		if not (v_descriptor->'capabilities' ? 'shell') then
			raise exception 'Office workbench grant required' using errcode='42501'; end if;
		if public.qorpera_valid_office_file_import(v_operation->'arguments') then
			perform public.qorpera_native_office_import_source(p_binding,v_operation->'arguments');
		elsif not public.qorpera_valid_office_file_export(v_operation->'arguments') then
			raise exception 'Invalid office file transfer' using errcode='42501'; end if;
	elsif v_operation#>>'{arguments,kind}'='desktop'
		or (v_operation#>>'{arguments,kind}'='screenshot' and v_operation#>>'{arguments,surface}'='desktop') then
		if not (v_descriptor->'capabilities' ? 'desktop') or not public.qorpera_valid_office_desktop_action(v_operation->'arguments') then
			raise exception 'Invalid office desktop operation or grant' using errcode='42501'; end if;
	elsif v_operation#>>'{arguments,kind}'='shell' then
		if not (v_descriptor->'capabilities' ? 'shell') then
			raise exception 'Office shell grant required' using errcode='42501'; end if;
		if (v_operation->'arguments')-'kind'-'command'-'timeoutMs'<>'{}'::jsonb
			or jsonb_typeof(v_operation#>'{arguments,command}') is distinct from 'string'
			or length(btrim(v_operation#>>'{arguments,command}'))=0 or octet_length(v_operation#>>'{arguments,command}')>16384
			or coalesce(v_operation#>>'{arguments,timeoutMs}','') !~ '^[0-9]{1,5}$'
			or (v_operation#>>'{arguments,timeoutMs}')::integer not between 1 and 15000 then
			raise exception 'Invalid office shell operation' using errcode='22023';
		end if;
	else
		if not (v_descriptor->'capabilities' ? 'browser') or not public.qorpera_valid_office_browser_action(v_operation->'arguments') then
			raise exception 'Invalid office browser operation or grant' using errcode='42501'; end if;
	end if;
	if p_action='authorize' then
		if p_receipt_id is not null or p_idempotency_sha256 is not null then raise exception 'Unexpected effect receipt' using errcode='22023'; end if;
		return '{"state":"authorized"}'::jsonb;
	end if;
	select * into v_receipt from public.qorpera_run_operation_receipts where id=p_receipt_id for update;
	if not found or v_receipt.run_id::text is distinct from p_binding->>'runId' or v_receipt.status<>'executing'
		or v_receipt.operation_kind<>'cloud_tool' or v_receipt.input_sha256<>v_sha
		or v_receipt.downstream_idempotency_sha256 is distinct from p_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from (v_operation->>'tool')||':'||(v_operation->>'logicalOperationKey')
		or v_receipt.requires_company_revision then
		raise exception 'Office effect receipt differs' using errcode='42501';
	end if;
	select * into v_resource from public.qorpera_runtime_office_resources where receipt_id=p_receipt_id for update;
	if p_action='begin' then
		if found then raise exception 'Office effect attempt already consumed' using errcode='55000'; end if;
		insert into public.qorpera_runtime_office_resources(office_id,screen_id,receipt_id,run_id,native_binding,screen_lease,
			input_sha256,downstream_idempotency_sha256,state,expires_at)
		values((p_scope->>'companyComputerId')::uuid,(p_lease#>>'{binding,screenId}')::uuid,p_receipt_id,v_receipt.run_id,
			p_binding,p_lease-'validForMs',v_sha,p_idempotency_sha256,'active',v_until) returning * into v_resource;
	else
		if not found or v_resource.state<>'active' or v_resource.expires_at<=clock_timestamp()
			or v_resource.native_binding is distinct from p_binding or v_resource.screen_lease is distinct from p_lease-'validForMs' then
			raise exception 'Office resource lease unavailable' using errcode='42501';
		end if;
	end if;
	-- No lock wait can extend a previously issued lease.
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if v_until<=clock_timestamp() or v_resource.expires_at<=clock_timestamp() then raise exception 'Office resource expired' using errcode='42501'; end if;
	return jsonb_build_object('state','admitted','resourceLeaseId',v_resource.id,
		'validForMs',least(30000,(v_authority->>'validForMs')::bigint,
			floor(extract(epoch from(least(v_until,v_resource.expires_at)-clock_timestamp()))*1000)::bigint));
end
$$;
