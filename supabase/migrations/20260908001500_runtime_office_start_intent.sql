-- Durable demand precedes provider effects. An accepted request survives its
-- requester disconnecting; current grant/member authority is rechecked before
-- physical provisioning. Neither a request nor reservation activates an office.
create table public.qorpera_runtime_office_start_intents (
	id uuid primary key,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null check(computer_generation between 1 and 9007199254740991),
	state text not null check(state in ('requested','reserved','cancelled')),
	requested_by_user_id uuid references auth.users(id) on delete restrict,
	requested_by_staff_agent_id uuid,
	grant_id uuid,
	grant_version bigint,
	receipt_id uuid unique references public.qorpera_run_operation_receipts(id) on delete restrict,
	allocation_id uuid unique references public.qorpera_runtime_machine_allocations(id) on delete restrict,
	instance_sha256 text check(instance_sha256 ~ '^[0-9a-f]{64}$'),
	image_sha256 text check(image_sha256 ~ '^[0-9a-f]{64}$'),
	bootstrap_sha256 text check(bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
	provider_binding_sha256 text check(provider_binding_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	cancelled_at timestamptz,
	unique(office_id,computer_generation),
	check((requested_by_user_id is not null and requested_by_staff_agent_id is null and grant_id is null and grant_version is null and receipt_id is null)
		or (requested_by_user_id is null and requested_by_staff_agent_id is not null and grant_id is not null and grant_version is not null and grant_version>0 and receipt_id is not null)),
	check((allocation_id is null and instance_sha256 is null and image_sha256 is null and bootstrap_sha256 is null and provider_binding_sha256 is null)
		or (allocation_id is not null and instance_sha256 is not null and image_sha256 is not null and bootstrap_sha256 is not null and provider_binding_sha256 is not null)),
	check((state='requested' and allocation_id is null) or (state='reserved' and allocation_id is not null) or state='cancelled'),
	check((state='cancelled')=(cancelled_at is not null))
);

create function public.qorpera_runtime_office_start_result(p_intent public.qorpera_runtime_office_start_intents)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-start-intent/v1','intentId',p_intent.id,
		'companyComputerId',p_intent.office_id,'computerGeneration',p_intent.computer_generation,'state',p_intent.state)
$$;

-- Internal only: callers have already taken job (native only), profile and
-- office locks in that order. This does not inspect a native run's lifetime:
-- accepting a durable start is not a lease on the requesting process.
create function public.qorpera_assert_runtime_office_start_source(
	p_office public.qorpera_runtime_offices,p_intent public.qorpera_runtime_office_start_intents
)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if p_intent.office_id<>p_office.id or p_intent.computer_generation<>p_office.generation
		or p_intent.state='cancelled' or p_office.state not in ('provisioning','recovering')
		or (p_intent.allocation_id is not null and (p_intent.image_sha256<>p_office.image_sha256 or p_intent.bootstrap_sha256<>p_office.bootstrap_sha256))
		or public.qorpera_company_execution_paused(p_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=p_office.environment_id
			and profile_id=p_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=p_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		raise exception 'Office start authority unavailable' using errcode='42501'; end if;
	if p_intent.requested_by_user_id is not null then
		perform 1 from public.qorpera_profile_members where profile_id=p_office.profile_id
			and user_id=p_intent.requested_by_user_id and role in ('owner','admin') for share;
		if not found then raise exception 'Office start requester unavailable' using errcode='42501'; end if;
	else
		perform 1 from public.qorpera_runtime_office_access access
			join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
			where access.office_id=p_office.id and access.profile_id=p_office.profile_id
			and access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id
			and access.version=p_intent.grant_version and access.state='active' and staff.employment_status='active'
			for share of access,staff;
		if not found then raise exception 'Office start grant unavailable' using errcode='42501'; end if;
	end if;
end
$$;

create function public.qorpera_request_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_request_id is null
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991 then
		raise exception 'Invalid office start request' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()
		and role in ('owner','admin') for share;
	if not found then raise exception 'Office start requires founder authority' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation for update;
	if not found then
		insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_user_id)
		values(p_request_id,v_office.id,v_office.generation,'requested',auth.uid()) returning * into v_intent;
	end if;
	-- Coalesce simultaneous requests for the same physical generation. A
	-- cancelled generation is retained for cleanup and cannot be revived here.
	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);
	return public.qorpera_runtime_office_start_result(v_intent);
end
$$;

create function public.qorpera_reserve_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_image_sha256 text,p_bootstrap_sha256 text,p_provider_binding_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype; v_reserved jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_intent_id is null or p_allocation_id is null
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991
		or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_image_sha256,'') !~ '^[0-9a-f]{64}$'
		or coalesce(p_bootstrap_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_provider_binding_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid office start reservation' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation
		or v_office.image_sha256<>p_image_sha256 or v_office.bootstrap_sha256<>p_bootstrap_sha256 then
		raise exception 'Office start reservation differs' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_intent_id for update;
	if not found then raise exception 'Office start intent unavailable' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);
	if v_intent.allocation_id is not null and (v_intent.allocation_id<>p_allocation_id or v_intent.instance_sha256<>p_instance_sha256
		or v_intent.provider_binding_sha256<>p_provider_binding_sha256) then
		raise exception 'Office start allocation cannot be rebound' using errcode='42501'; end if;
	v_reserved:=public.qorpera_reserve_runtime_machine(p_allocation_id,'lxd',p_instance_sha256,null,null,v_office.id,v_office.generation);
	if v_reserved->>'state'='refused' then return v_reserved; end if;
	if v_reserved is distinct from jsonb_build_object('state','reserved','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256) then
		raise exception 'Office start capacity unconfirmed' using errcode='42501'; end if;
	update public.qorpera_runtime_office_start_intents set state='reserved',allocation_id=p_allocation_id,
		instance_sha256=p_instance_sha256,image_sha256=p_image_sha256,bootstrap_sha256=p_bootstrap_sha256,
		provider_binding_sha256=p_provider_binding_sha256 where id=v_intent.id returning * into v_intent;
	return public.qorpera_runtime_office_start_result(v_intent)||jsonb_build_object('allocationId',p_allocation_id,
		'instanceSha256',p_instance_sha256,'providerBindingSha256',p_provider_binding_sha256);
end
$$;

-- Native startup is independent of the guest endpoint and screen admission.
-- Return only cloud identity/version metadata, never a provider URL or path.
create function public.qorpera_native_office_start_descriptor(p_binding jsonb,p_allow_active boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Native office authority required' using errcode='42501'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
		raise exception 'Shared office start requires company audience' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices
		where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid
		and (state in ('provisioning','recovering') or (p_allow_active is true and state='active')) for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if public.qorpera_company_execution_paused(v_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		return '{"state":"unavailable"}'::jsonb; end if;
	select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id
		and staff_agent_id=(v_authority#>>'{identity,staffAgentId}')::uuid and profile_id=v_office.profile_id and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if exists(select 1 from public.qorpera_runtime_office_start_intents where office_id=v_office.id
		and computer_generation=v_office.generation and state='cancelled') then return '{"state":"unavailable"}'::jsonb; end if;
	-- Completion/result release may race provider activation. Current matching
	-- active demand permits reauthorization of a recorded start, not another
	-- begin or new startup-tool discovery on an already active office.
	if v_office.state='active' and not exists(select 1 from public.qorpera_runtime_office_start_intents intent
		join public.qorpera_runtime_machine_allocations allocation on allocation.id=intent.allocation_id
		where intent.office_id=v_office.id and intent.computer_generation=v_office.generation and intent.state='reserved'
		and intent.image_sha256=v_office.image_sha256 and intent.bootstrap_sha256=v_office.bootstrap_sha256
		and allocation.office_id=v_office.id and allocation.computer_generation=v_office.generation
		and allocation.instance_sha256=intent.instance_sha256 and allocation.released_at is null) then
		return '{"state":"unavailable"}'::jsonb; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','available','scope',public.qorpera_runtime_office_scope(v_office),
		'computerGeneration',v_office.generation,'resources',jsonb_build_object('officeGrantId',v_access.grant_id,'officeGrantVersion',v_access.version));
end
$$;

create function public.qorpera_native_office_start(p_binding jsonb,p_envelope text,p_action text,
	p_receipt_id uuid default null,p_idempotency_sha256 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority jsonb; v_descriptor jsonb; v_envelope jsonb; v_operation jsonb; v_sha text;
	v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','begin')
		or p_envelope is null or octet_length(p_envelope)>16384 then
		raise exception 'Invalid native office start' using errcode='42501'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_wake_work_allowed((p_binding->>'runId')::uuid);
	-- Take the exclusive office lock before descriptor reads acquire a shared
	-- lock, so simultaneous native starts never race a share-to-update upgrade.
	select * into v_office from public.qorpera_runtime_offices
		where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid for update;
	if not found then raise exception 'Native office start unavailable' using errcode='42501'; end if;
	-- Match the exact native input and receipt before recording durable demand.
	v_descriptor:=public.qorpera_native_office_start_descriptor(p_binding,p_action='authorize');
	v_envelope:=p_envelope::jsonb;
	v_operation:=v_envelope->'operation';
	if jsonb_typeof(v_envelope) is distinct from 'object' or v_envelope-'schema'-'principals'-'operation'<>'{}'::jsonb
		or v_envelope->>'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_envelope->'principals' is distinct from (v_authority->'identity')-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion']
		or jsonb_typeof(v_operation) is distinct from 'object'
		or v_operation-array['tool','toolVersion','logicalOperationKey','arguments','target','requiresCompanyRevision']<>'{}'::jsonb
		or v_operation->>'tool' is distinct from 'computer_start'
		or v_operation->>'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation->'requiresCompanyRevision' is distinct from 'false'::jsonb
		or coalesce(v_operation->>'logicalOperationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or v_operation->'arguments' is distinct from '{"kind":"start"}'::jsonb
		or v_descriptor->>'state' is distinct from 'available'
		or v_operation->'target' is distinct from jsonb_build_object('realm','company_computer','scope',v_descriptor->'scope',
			'computerGeneration',v_descriptor->'computerGeneration','resources',v_descriptor->'resources') then
		raise exception 'Native office start differs from current authority' using errcode='42501'; end if;
	if p_action='authorize' then
		if p_receipt_id is not null or p_idempotency_sha256 is not null then raise exception 'Unexpected start receipt' using errcode='22023'; end if;
		perform public.qorpera_describe_native_tool_authority(p_binding);
		return '{"state":"authorized"}'::jsonb;
	end if;
	v_sha:=encode(extensions.digest(convert_to(p_envelope,'UTF8'),'sha256'),'hex');
	select * into v_receipt from public.qorpera_run_operation_receipts where id=p_receipt_id for update;
	if not found or v_receipt.run_id::text is distinct from p_binding->>'runId' or v_receipt.status<>'executing'
		or v_receipt.operation_kind<>'cloud_tool' or v_receipt.input_sha256<>v_sha
		or coalesce(p_idempotency_sha256,'') !~ '^[0-9a-f]{64}$'
		or v_receipt.downstream_idempotency_sha256 is distinct from p_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'computer_start:'||(v_operation->>'logicalOperationKey')
		or v_receipt.requires_company_revision then
		raise exception 'Native office start receipt differs' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation for update;
	if not found then
		insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_staff_agent_id,
			grant_id,grant_version,receipt_id)
		values(p_receipt_id,v_office.id,v_office.generation,'requested',(v_authority#>>'{identity,staffAgentId}')::uuid,
			(v_descriptor#>>'{resources,officeGrantId}')::uuid,(v_descriptor#>>'{resources,officeGrantVersion}')::bigint,p_receipt_id)
		returning * into v_intent;
	end if;
	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return public.qorpera_runtime_office_start_result(v_intent);
end
$$;

-- This authorizes only provider preparation, never native effects, screens,
-- viewers or guest service activation. Recheck immediately before each effect.
create function public.qorpera_check_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_provider_binding_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_intent_id is null or p_allocation_id is null
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991
		or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_provider_binding_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid office start check' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for share;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_intent_id for share;
	if not found or v_intent.state<>'reserved' or v_intent.allocation_id<>p_allocation_id
		or v_intent.instance_sha256<>p_instance_sha256 or v_intent.provider_binding_sha256<>p_provider_binding_sha256 then
		raise exception 'Office start reservation differs' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);
	perform 1 from public.qorpera_runtime_machine_allocations where id=p_allocation_id
		and profile_id=v_office.profile_id and office_id=v_office.id and computer_generation=v_office.generation
		and provider_adapter='lxd' and instance_sha256=p_instance_sha256 and released_at is null for share;
	if not found then raise exception 'Office start allocation unavailable' using errcode='42501'; end if;
	return jsonb_build_object('state','authorized','intentId',v_intent.id,'computerGeneration',v_office.generation,'validForMs',5000);
end
$$;

create function public.qorpera_cancel_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_intent_id is null
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991 then
		raise exception 'Invalid office start cancellation' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation
		or v_office.state not in ('provisioning','recovering') then
		raise exception 'Office start cancellation differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()
		and role in ('owner','admin') for share;
	if not found then raise exception 'Office start cancellation requires founder authority' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_intent_id
		and office_id=v_office.id and computer_generation=v_office.generation for update;
	if not found then raise exception 'Office start intent unavailable' using errcode='42501'; end if;
	update public.qorpera_runtime_office_start_intents set state='cancelled',cancelled_at=coalesce(cancelled_at,clock_timestamp())
		where id=v_intent.id returning * into v_intent;
	-- Capacity stays occupied. Cancellation cannot settle a provider operation
	-- or prove deletion, and this API cannot revive the cancelled generation.
	return public.qorpera_runtime_office_start_result(v_intent);
end
$$;

-- Member recovery after a lost request/cancel response. No provider binding,
-- requester identity, receipt, credentials or physical-readiness claim leaks.
create function public.qorpera_runtime_office_start_status(p_scope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Office start status requires membership' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for share;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	if not found then raise exception 'Office start status requires membership' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation for share;
	return jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
		'officeState',v_office.state,'intent',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end);
end
$$;

alter table public.qorpera_runtime_office_start_intents enable row level security;
revoke all on public.qorpera_runtime_office_start_intents from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_office_start_result(public.qorpera_runtime_office_start_intents),
	public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents),
	public.qorpera_request_runtime_office_start(jsonb,bigint,uuid),
	public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text),
	public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text),
	public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_office_start_status(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_native_office_start_descriptor(jsonb,boolean),public.qorpera_native_office_start(jsonb,text,text,uuid,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_request_runtime_office_start(jsonb,bigint,uuid),
	public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid),public.qorpera_runtime_office_start_status(jsonb) to authenticated;
grant execute on function public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text),
	public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text) to service_role;
grant execute on function public.qorpera_native_office_start_descriptor(jsonb,boolean),public.qorpera_native_office_start(jsonb,text,text,uuid,text) to service_role;
