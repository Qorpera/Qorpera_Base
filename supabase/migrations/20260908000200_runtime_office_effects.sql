-- The office is a shared work surface. Only company-audience work is admitted.
-- Each guest attempt consumes one existing native effect receipt. Expiry stops
-- authority, but neither expiry nor a lost HTTP response proves physical drain.
create table public.qorpera_runtime_office_resources (
	id uuid primary key default extensions.gen_random_uuid(),
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete restrict,
	receipt_id uuid not null unique references public.qorpera_run_operation_receipts(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	native_binding jsonb not null,
	screen_lease jsonb not null,
	input_sha256 text not null check(input_sha256 ~ '^[0-9a-f]{64}$'),
	downstream_idempotency_sha256 text not null check(downstream_idempotency_sha256 ~ '^[0-9a-f]{64}$'),
	state text not null check(state in ('active','draining','drained')),
	expires_at timestamptz not null,
	created_at timestamptz not null default clock_timestamp(),
	drained_at timestamptz,
	check((state='drained')=(drained_at is not null))
);
create index qorpera_runtime_office_unresolved_resources on public.qorpera_runtime_office_resources(office_id,screen_id)
	where state<>'drained';

alter table public.qorpera_runtime_office_screens
	add column drain_id uuid,
	add column takeover_user_id uuid references auth.users(id) on delete restrict,
	add column drain_acknowledged_at timestamptz,
	add constraint office_drain_challenge check(drain_pending=(drain_id is not null and drain_acknowledged_at is null));

-- The existing screen function remains the single admission implementation.
-- Wrap it to enforce the shared audience and the acknowledged drain interlock.
alter function public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb) rename to qorpera_native_office_screen_v1;
revoke all on function public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;

create function public.qorpera_native_office_screen(p_binding jsonb,p_scope jsonb,p_action text,p_lease jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office runtime authority required' using errcode='42501'; end if;
	if p_action is distinct from 'release' then
		v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
		if v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
			raise exception 'Shared office requires company audience' using errcode='42501';
		end if;
	end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Office scope differs' using errcode='42501';
	end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id
		and case when p_action='release' then id=(p_lease#>>'{binding,screenId}')::uuid
			else staff_agent_id=(v_authority#>>'{identity,staffAgentId}')::uuid end for update;
	if p_action='release' and v_screen.lease_id is not null and v_screen.native_binding=p_binding
		and p_lease-'validForMs'=public.qorpera_runtime_office_screen_lease(v_office,v_screen)-'validForMs'
		and exists(select 1 from public.qorpera_runtime_office_resources where screen_id=v_screen.id and state<>'drained') then
		update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),
			drain_acknowledged_at=null where id=v_screen.id;
		update public.qorpera_runtime_office_resources set state='draining' where screen_id=v_screen.id and state='active';
	end if;
	if p_action is distinct from 'release' and (v_screen.drain_pending or v_screen.takeover_user_id is not null) then
		if p_action='acquire' then return '{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb; end if;
		raise exception 'Office screen is fenced' using errcode='42501';
	end if;
	return public.qorpera_native_office_screen_v1(p_binding,p_scope,p_action,p_lease);
end
$$;

create function public.qorpera_native_office_descriptor(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if auth.role() is distinct from 'service_role' or v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
		raise exception 'Shared office requires company authority' using errcode='42501';
	end if;
	select * into v_office from public.qorpera_runtime_offices where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id
		and staff_agent_id=(v_authority#>>'{identity,staffAgentId}')::uuid and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','available','scope',public.qorpera_runtime_office_scope(v_office),
		'capabilities',v_access.capabilities,'resources',jsonb_build_object('officeGrantId',v_access.grant_id,'officeGrantVersion',v_access.version));
end
$$;

-- p_envelope is the exact UTF-8 JSON hashed by native tool admission. Compare
-- its parsed principals/target to server authority as well as its byte digest;
-- accepting a caller-supplied digest alone would authorize substituted work.
create function public.qorpera_native_office_operation(
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
		or coalesce(v_operation#>>'{arguments,kind}','') not in ('screen','shell') then
		raise exception 'Office effect differs from current authority' using errcode='42501';
	end if;
	if v_operation#>>'{arguments,kind}'='screen' then
		if (v_operation->'arguments')-'kind'-'action'<>'{}'::jsonb
			or coalesce(v_operation#>>'{arguments,action}','') not in ('open','release') then
			raise exception 'Invalid office screen operation' using errcode='22023';
		end if;
	else
		if (v_operation->'arguments')-'kind'-'command'-'timeoutMs'<>'{}'::jsonb
			or jsonb_typeof(v_operation#>'{arguments,command}') is distinct from 'string'
			or length(btrim(v_operation#>>'{arguments,command}'))=0 or octet_length(v_operation#>>'{arguments,command}')>16384
			or coalesce(v_operation#>>'{arguments,timeoutMs}','') !~ '^[0-9]{1,5}$'
			or (v_operation#>>'{arguments,timeoutMs}')::integer not between 1 and 15000 then
			raise exception 'Invalid office shell operation' using errcode='22023';
		end if;
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

-- Member takeover/recovery is a challenge/ack protocol. The challenge fences
-- the old driver immediately. No member control is admitted by this function.
create function public.qorpera_request_runtime_office_drain(p_scope jsonb,p_screen_id uuid,p_computer_generation bigint,
	p_screen_generation bigint,p_epoch bigint,p_takeover boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_takeover is null then
		raise exception 'Member office authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation or v_office.state<>'active'
		or not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
			and user_id=auth.uid() and role in ('owner','admin')) then
		raise exception 'Office takeover unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=p_screen_id for update;
	if not found or v_screen.generation is distinct from p_screen_generation or v_screen.epoch is distinct from p_epoch then
		raise exception 'Office screen changed' using errcode='40001'; end if;
	update public.qorpera_runtime_office_screens set epoch=epoch+1,lease_id=null,run_id=null,lease_expires_at=null,
		grant_version=null,native_binding=null,drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null,
		takeover_user_id=case when p_takeover then auth.uid() else null end,touched_at=clock_timestamp()
		where id=v_screen.id returning * into v_screen;
	update public.qorpera_runtime_office_resources set state='draining' where screen_id=v_screen.id and state='active';
	update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	return jsonb_build_object('state','draining','drainId',v_screen.drain_id,'epoch',v_screen.epoch,
		'binding',public.qorpera_runtime_office_scope(v_office)||jsonb_build_object('computerGeneration',v_office.generation,
			'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id));
end
$$;

create function public.qorpera_ack_runtime_office_drain(p_scope jsonb,p_screen_id uuid,p_computer_generation bigint,
	p_screen_generation bigint,p_epoch bigint,p_drain_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Guest supervisor authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation then
		raise exception 'Office drain generation differs' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=p_screen_id for update;
	if not found or v_screen.generation is distinct from p_screen_generation or v_screen.epoch is distinct from p_epoch
		or v_screen.drain_id is distinct from p_drain_id or p_drain_id is null then
		raise exception 'Office drain acknowledgement differs' using errcode='42501'; end if;
	if v_screen.drain_pending then
		update public.qorpera_runtime_office_resources set state='drained',drained_at=clock_timestamp()
			where screen_id=v_screen.id and state<>'drained';
		update public.qorpera_runtime_office_screens set drain_pending=false,drain_acknowledged_at=clock_timestamp() where id=v_screen.id;
		update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	end if;
	return jsonb_build_object('state','drained','drainId',v_screen.drain_id,'epoch',v_screen.epoch);
end
$$;

alter table public.qorpera_runtime_office_resources enable row level security;
revoke all on public.qorpera_runtime_office_resources from public,anon,authenticated,service_role;
revoke all on function public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb),public.qorpera_native_office_descriptor(jsonb),
	public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text),
	public.qorpera_request_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,boolean),
	public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb),public.qorpera_native_office_descriptor(jsonb),
	public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text),
	public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid) to service_role;
grant execute on function public.qorpera_request_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,boolean) to authenticated;
