-- Screenshot identity extends the existing operation receipt and immutable
-- artifact catalog. It is neither another effect ledger nor a Company File write.
create table public.qorpera_runtime_office_captures (
	receipt_id uuid primary key references public.qorpera_runtime_office_resources(receipt_id) on delete restrict,
	artifact_id uuid not null unique references public.qorpera_artifacts(id) on delete restrict,
	operation_envelope text not null check (octet_length(operation_envelope)<=65536),
	surface text not null check (surface in ('browser','desktop')),
	width integer not null check (width between 1 and 1920),
	height integer not null check (height between 1 and 1200),
	check (surface<>'desktop' or (width=1920 and height=1200))
);
alter table public.qorpera_runtime_office_captures enable row level security;
revoke all on public.qorpera_runtime_office_captures from public,anon,authenticated,service_role;

create function public.qorpera_runtime_office_capture_json(p_capture public.qorpera_runtime_office_captures)
returns jsonb language sql stable security definer set search_path='' as $$
	select jsonb_build_object('assetId',a.id,'sha256',a.content_sha256,'bytes',a.bytes,'mediaType',a.media_type,
		'screenId',r.screen_id,'surface',p_capture.surface,'width',p_capture.width,'height',p_capture.height)
	from public.qorpera_artifacts a join public.qorpera_runtime_office_resources r on r.receipt_id=p_capture.receipt_id
	where a.id=p_capture.artifact_id
$$;

create function public.qorpera_native_office_capture(
	p_binding jsonb,p_scope jsonb,p_lease jsonb,p_envelope text,p_receipt_id uuid,p_idempotency_sha256 text,
	p_image jsonb,p_action text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_operation jsonb; v_authority jsonb; v_capture public.qorpera_runtime_office_captures%rowtype;
	v_asset public.qorpera_artifacts%rowtype; v_company uuid; v_actor uuid; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','publish') then
		raise exception 'Office capture authority required' using errcode='42501'; end if;
	-- Exact native principals, screenshot arguments, grants, privacy epoch,
	-- active physical resource lease, receipt and input digest are checked here.
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	v_operation:=p_envelope::jsonb->'operation';
	if v_operation->>'tool' is distinct from 'computer_screenshot'
		or v_operation#>>'{arguments,kind}' is distinct from 'screenshot'
		or coalesce(v_operation#>>'{arguments,surface}','') not in ('browser','desktop') then
		raise exception 'Office capture requires a screenshot receipt' using errcode='42501'; end if;
	if jsonb_typeof(p_image) is distinct from 'object' or p_image-array['sha256','bytes','mediaType','width','height']<>'{}'::jsonb
		or coalesce(p_image->>'sha256','') !~ '^[0-9a-f]{64}$'
		or p_image->>'mediaType' is distinct from 'image/png'
		or jsonb_typeof(p_image->'bytes') is distinct from 'number' or coalesce(p_image->>'bytes','') !~ '^[0-9]{1,7}$'
		or (p_image->>'bytes')::bigint not between 33 and 8388608
		or jsonb_typeof(p_image->'width') is distinct from 'number' or coalesce(p_image->>'width','') !~ '^[0-9]{1,4}$'
		or (p_image->>'width')::integer not between 1 and 1920
		or jsonb_typeof(p_image->'height') is distinct from 'number' or coalesce(p_image->>'height','') !~ '^[0-9]{1,4}$'
		or (p_image->>'height')::integer not between 1 and 1200
		or (v_operation#>>'{arguments,surface}'='desktop' and (p_image->>'width'<>'1920' or p_image->>'height'<>'1200')) then
		raise exception 'Invalid office capture metadata' using errcode='22023'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_company:=(v_authority#>>'{identity,companyId}')::uuid;
	v_actor:=(v_authority#>>'{identity,requesterUserId}')::uuid;
	-- Shares Company File/principal/GC locks with the existing staging gateway.
	perform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>'sha256',(p_image->>'bytes')::bigint);
	if p_action='authorize' then return '{"state":"authorized"}'::jsonb; end if;
	perform public.qorpera_lock_profile_gc_fence(v_company);
	if not exists(select 1 from public.qorpera_profile_objects where profile_id=v_company
		and sha256=p_image->>'sha256' and bytes=(p_image->>'bytes')::bigint)
		or not public.qorpera_object_exists(v_company,p_image->>'sha256') then
		raise exception 'Office capture object unavailable' using errcode='42501'; end if;
	select * into v_capture from public.qorpera_runtime_office_captures where receipt_id=p_receipt_id;
	if found then
		v_result:=public.qorpera_runtime_office_capture_json(v_capture);
		if v_capture.operation_envelope<>p_envelope or
			v_result-'assetId'-'screenId'-'surface' is distinct from p_image or
			v_result->>'screenId' is distinct from p_lease#>>'{binding,screenId}' or
			v_result->>'surface' is distinct from v_operation#>>'{arguments,surface}' then
			raise exception 'Office capture receipt already bound' using errcode='23505'; end if;
	else
		insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,owner_staff_agent_id,
			artifact_type,name,root_object_sha256,root_contract,content_sha256,bytes,media_type,created_by_user_id)
		values(v_company,(v_authority#>>'{identity,environmentId}')::uuid,p_receipt_id,
			(v_authority#>>'{identity,sessionId}')::uuid,(v_authority#>>'{identity,staffAgentId}')::uuid,
			'office_screenshot','Company Computer screenshot',p_image->>'sha256','qorpera.object/v1',
			p_image->>'sha256',(p_image->>'bytes')::bigint,'image/png',v_actor) returning * into v_asset;
		insert into public.qorpera_runtime_office_captures(receipt_id,artifact_id,operation_envelope,surface,width,height)
		values(p_receipt_id,v_asset.id,p_envelope,v_operation#>>'{arguments,surface}',
			(p_image->>'width')::integer,(p_image->>'height')::integer) returning * into v_capture;
		-- Retain immutable receipt evidence through the existing GC hold mechanism.
		-- No private bytes or model-supplied names enter the audit fields.
		insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
		values(v_company,v_asset.id,p_receipt_id,'Company Computer capture receipt',v_actor);
		v_result:=public.qorpera_runtime_office_capture_json(v_capture);
	end if;
	-- Lock waits and object catalog checks cannot extend the effect's validity.
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	return v_result;
end
$$;

create function public.qorpera_read_native_office_capture(p_binding jsonb,p_asset_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_descriptor jsonb; v_capture public.qorpera_runtime_office_captures%rowtype;
	v_resource public.qorpera_runtime_office_resources%rowtype; v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_asset public.qorpera_artifacts%rowtype; v_result jsonb; v_envelope jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Native capture authority required' using errcode='42501'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_descriptor:=public.qorpera_native_office_descriptor(p_binding);
	select * into v_capture from public.qorpera_runtime_office_captures where artifact_id=p_asset_id;
	if not found then raise exception 'Office capture unavailable' using errcode='42501'; end if;
	select * into v_resource from public.qorpera_runtime_office_resources where receipt_id=v_capture.receipt_id;
	select * into v_receipt from public.qorpera_run_operation_receipts where id=v_capture.receipt_id for share;
	select * into v_asset from public.qorpera_artifacts where id=p_asset_id for share;
	v_envelope:=v_capture.operation_envelope::jsonb;
	v_result:=public.qorpera_runtime_office_capture_json(v_capture);
	if v_authority#>>'{identity,audienceKind}' is distinct from 'company'
		or v_receipt.run_id::text is distinct from p_binding->>'runId' or v_receipt.status<>'completed'
		or v_resource.state<>'drained' or v_descriptor->>'state' is distinct from 'available'
		or v_descriptor#>>'{scope,companyComputerId}' is distinct from v_resource.office_id::text
		or v_envelope#>'{operation,target,resources}' is distinct from v_descriptor->'resources'
		or v_envelope->'principals' is distinct from (v_authority->'identity')-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion']
		or v_receipt.result is distinct from jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
			'inputSha256',v_receipt.input_sha256,'content',jsonb_build_object('kind','json','value',v_result))
		or v_asset.profile_id::text is distinct from v_authority#>>'{identity,companyId}'
		or v_asset.environment_id::text is distinct from v_authority#>>'{identity,environmentId}'
		or v_asset.owner_staff_agent_id::text is distinct from v_authority#>>'{identity,staffAgentId}'
		or v_asset.deleted_at is not null or v_asset.gc_completed_at is not null then
		raise exception 'Office capture authority changed' using errcode='42501'; end if;
	perform public.qorpera_authorize_native_company_object_download(p_binding,v_asset.profile_id,v_asset.content_sha256);
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return v_result;
end
$$;

revoke all on function public.qorpera_runtime_office_capture_json(public.qorpera_runtime_office_captures) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text),
	public.qorpera_read_native_office_capture(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text),
	public.qorpera_read_native_office_capture(jsonb,uuid) to service_role;
