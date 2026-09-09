-- Explicit workbench exports use the existing native effect/resource ledger.
-- No member device path, canonical path, shell string or raw object address is accepted.
create function public.qorpera_valid_workbench_file_path(p_path text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(p_path<>'' and left(p_path,1)<>'/' and octet_length(p_path)<=1024
  and p_path !~ '[[:cntrl:]]' and position(chr(92) in p_path)=0
  and cardinality(string_to_array(p_path,'/'))<=32
  and not exists(select 1 from unnest(string_to_array(p_path,'/')) part where part in ('','.','..') or octet_length(part)>255),false)
$$;
create function public.qorpera_valid_office_file_export(p_args jsonb)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p_args)='object' and p_args-array['kind','action','source','destination','mediaType']='{}'::jsonb
  and p_args->>'kind'='transfer' and p_args->>'action'='export'
  and jsonb_typeof(p_args->'source')='object' and (p_args->'source')-array['realm','path']='{}'::jsonb
  and p_args#>>'{source,realm}'='company_computer' and jsonb_typeof(p_args#>'{source,path}')='string'
  and public.qorpera_valid_workbench_file_path(p_args#>>'{source,path}')
  and p_args->'destination'='{"realm":"object_storage"}'::jsonb
  and jsonb_typeof(p_args->'mediaType')='string' and octet_length(p_args->>'mediaType')<=256
  and (p_args->>'mediaType') ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$',false)
$$;
revoke all on function public.qorpera_valid_workbench_file_path(text),public.qorpera_valid_office_file_export(jsonb) from public,anon,authenticated,service_role;

create table public.qorpera_runtime_office_file_exports (
	receipt_id uuid primary key references public.qorpera_runtime_office_resources(receipt_id) on delete restrict,
	artifact_id uuid not null unique references public.qorpera_artifacts(id) on delete restrict,
	operation_envelope text not null check(octet_length(operation_envelope)<=65536)
);
alter table public.qorpera_runtime_office_file_exports enable row level security;
revoke all on public.qorpera_runtime_office_file_exports from public,anon,authenticated,service_role;

create function public.qorpera_runtime_office_file_export_json(p_export public.qorpera_runtime_office_file_exports)
returns jsonb language sql stable security definer set search_path='' as $$
	select jsonb_build_object('schema','qorpera.file-transfer-asset/v1','assetId',a.id,
		'sha256',a.content_sha256,'bytes',a.bytes,'mediaType',a.media_type,
		'source',jsonb_build_object('realm','company_computer','companyComputerId',r.office_id,'screenId',r.screen_id,
			'path',p_export.operation_envelope::jsonb#>>'{operation,arguments,source,path}'),
		'destination',jsonb_build_object('realm','object_storage'))
	from public.qorpera_artifacts a join public.qorpera_runtime_office_resources r on r.receipt_id=p_export.receipt_id
	where a.id=p_export.artifact_id
$$;

create function public.qorpera_native_office_file_export(
	p_binding jsonb,p_scope jsonb,p_lease jsonb,p_envelope text,p_receipt_id uuid,p_idempotency_sha256 text,p_file jsonb,p_action text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_operation jsonb; v_authority jsonb; v_export public.qorpera_runtime_office_file_exports%rowtype;
	v_asset public.qorpera_artifacts%rowtype; v_company uuid; v_actor uuid; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','publish') then
		raise exception 'Office transfer authority required' using errcode='42501'; end if;
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	v_operation:=p_envelope::jsonb->'operation';
	if v_operation->>'tool' is distinct from 'computer_transfer' or not public.qorpera_valid_office_file_export(v_operation->'arguments') then
		raise exception 'Office transfer requires an export receipt' using errcode='42501'; end if;
	if jsonb_typeof(p_file) is distinct from 'object' or p_file-array['sha256','bytes','mediaType']<>'{}'::jsonb
		or coalesce(p_file->>'sha256','') !~ '^[0-9a-f]{64}$'
		or p_file->>'mediaType' is distinct from v_operation#>>'{arguments,mediaType}'
		or jsonb_typeof(p_file->'bytes') is distinct from 'number' or coalesce(p_file->>'bytes','') !~ '^[0-9]{1,7}$'
		or (p_file->>'bytes')::bigint not between 0 and 8388608 then
		raise exception 'Invalid office file metadata' using errcode='22023'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_company:=(v_authority#>>'{identity,companyId}')::uuid;
	v_actor:=(v_authority#>>'{identity,requesterUserId}')::uuid;
	perform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_file->>'sha256',(p_file->>'bytes')::bigint);
	if p_action='authorize' then return '{"state":"authorized"}'::jsonb; end if;
	perform public.qorpera_lock_profile_gc_fence(v_company);
	if not exists(select 1 from public.qorpera_profile_objects where profile_id=v_company
		and sha256=p_file->>'sha256' and bytes=(p_file->>'bytes')::bigint)
		or not public.qorpera_object_exists(v_company,p_file->>'sha256') then
		raise exception 'Office export object unavailable' using errcode='42501'; end if;
	select * into v_export from public.qorpera_runtime_office_file_exports where receipt_id=p_receipt_id;
	if found then
		v_result:=public.qorpera_runtime_office_file_export_json(v_export);
		if v_export.operation_envelope<>p_envelope or v_result-array['schema','assetId','source','destination'] is distinct from p_file then
			raise exception 'Office transfer receipt already bound' using errcode='23505'; end if;
	else
		insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,owner_staff_agent_id,
			artifact_type,name,root_object_sha256,root_contract,content_sha256,bytes,media_type,created_by_user_id)
		values(v_company,(v_authority#>>'{identity,environmentId}')::uuid,p_receipt_id,
			(v_authority#>>'{identity,sessionId}')::uuid,(v_authority#>>'{identity,staffAgentId}')::uuid,
			'office_file_export','Company Computer file export',p_file->>'sha256','qorpera.object/v1',
			p_file->>'sha256',(p_file->>'bytes')::bigint,p_file->>'mediaType',v_actor) returning * into v_asset;
		insert into public.qorpera_runtime_office_file_exports(receipt_id,artifact_id,operation_envelope)
		values(p_receipt_id,v_asset.id,p_envelope) returning * into v_export;
		insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
		values(v_company,v_asset.id,p_receipt_id,'Company Computer file transfer receipt',v_actor);
		v_result:=public.qorpera_runtime_office_file_export_json(v_export);
	end if;
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	return v_result;
end
$$;
revoke all on function public.qorpera_runtime_office_file_export_json(public.qorpera_runtime_office_file_exports),
	public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text) to service_role;

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
		or coalesce(v_operation#>>'{arguments,kind}','') not in ('screen','shell','browser','screenshot','transfer') then
		raise exception 'Office effect differs from current authority' using errcode='42501';
	end if;
	if v_operation#>>'{arguments,kind}'='screen' then
		if (v_operation->'arguments')-'kind'-'action'<>'{}'::jsonb
			or coalesce(v_operation#>>'{arguments,action}','') not in ('open','release') then
			raise exception 'Invalid office screen operation' using errcode='22023';
		end if;
	elsif v_operation#>>'{arguments,kind}'='transfer' then
		if not (v_descriptor->'capabilities' ? 'shell') or not public.qorpera_valid_office_file_export(v_operation->'arguments') then
			raise exception 'Invalid office file transfer or workbench grant' using errcode='42501'; end if;
	elsif v_operation#>>'{arguments,kind}'='shell' then
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
