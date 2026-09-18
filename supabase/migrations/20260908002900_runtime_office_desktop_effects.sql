-- Separate desktop authority from page automation without bypassing shared
-- privacy, exact screen/receipt checks, expiry or one-attempt effect admission.
-- Existing grants remain shell-only. Browser consent is independently derived
-- from the current profile grant and must never be stored in this capability set.
alter table public.qorpera_runtime_office_access
 drop constraint qorpera_runtime_office_access_capabilities_check,
 add constraint qorpera_runtime_office_access_capabilities_check
 check(capabilities in ('["shell"]'::jsonb,'["desktop"]'::jsonb,'["desktop","shell"]'::jsonb));

create function public.qorpera_runtime_office_access_status(p_scope jsonb,p_staff_agent_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Office grant administration required' using errcode='42501'; end if;
 select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
 if not found or public.qorpera_runtime_office_scope(v_office) is distinct from p_scope then
  raise exception 'Office grant scope differs' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
 if not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
   and user_id=auth.uid() and role in ('owner','admin'))
  or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id) then
  raise exception 'Office grant administration unavailable' using errcode='42501'; end if;
 select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id and staff_agent_id=p_staff_agent_id;
 return jsonb_build_object('schema','qorpera.office-access-status/v1','scope',p_scope,'staffAgentId',p_staff_agent_id,
  'grant',case when v_access.grant_id is null then null else jsonb_build_object('grantId',v_access.grant_id,
   'version',v_access.version,'state',v_access.state,'capabilities',v_access.capabilities) end);
end
$$;

create function public.qorpera_configure_runtime_office_access(
 p_scope jsonb,p_staff_agent_id uuid,p_expected_version bigint,p_enabled boolean,p_capabilities jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_capabilities is null or p_capabilities not in ('["shell"]'::jsonb,'["desktop"]'::jsonb,'["desktop","shell"]'::jsonb)
  or p_expected_version is null or p_expected_version not between 0 and 9007199254740990 then
  raise exception 'Invalid office capabilities or version' using errcode='22023'; end if;
 -- Check the full office scope and current owner/admin first. The original
 -- setter retains the profile/office/access locks and increments the CAS version
 -- before the capability write in this same transaction. Every change fences
 -- previously issued leases; no intermediate grant can become visible.
 perform public.qorpera_runtime_office_access_status(p_scope,p_staff_agent_id);
 perform public.qorpera_set_runtime_office_access((p_scope->>'companyComputerId')::uuid,p_staff_agent_id,p_expected_version,p_enabled);
 update public.qorpera_runtime_office_access set capabilities=p_capabilities
  where office_id=(p_scope->>'companyComputerId')::uuid and staff_agent_id=p_staff_agent_id;
 return public.qorpera_runtime_office_access_status(p_scope,p_staff_agent_id);
end
$$;
revoke all on function public.qorpera_runtime_office_access_status(jsonb,uuid),
 public.qorpera_configure_runtime_office_access(jsonb,uuid,bigint,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_access_status(jsonb,uuid),
 public.qorpera_configure_runtime_office_access(jsonb,uuid,bigint,boolean,jsonb) to authenticated;

create function public.qorpera_valid_office_desktop_action(p_args jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_action text:=p_args->>'action'; v_keys text[]:=array['kind','action']; v_x numeric; v_y numeric;
 v_key_pattern text:='^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$';
 -- ECMAScript String.trim whitespace, matching the runtime text parser.
 v_whitespace text:=E' \t\n\r\f'||chr(11)||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
 if jsonb_typeof(p_args) is distinct from 'object' then return false; end if;
 if p_args->>'kind'='screenshot' then return p_args='{"kind":"screenshot","surface":"desktop"}'::jsonb; end if;
 if p_args->>'kind' is distinct from 'desktop' or v_action is null then return false; end if;
 case v_action
 when 'move','click' then
  v_keys:=v_keys||array['x','y'];
  if jsonb_typeof(p_args->'x') is distinct from 'number' or jsonb_typeof(p_args->'y') is distinct from 'number' then return false; end if;
  v_x:=(p_args->>'x')::numeric; v_y:=(p_args->>'y')::numeric;
  if v_x<0 or v_x>=1920 or v_y<0 or v_y>=1200 or v_x<>trunc(v_x) or v_y<>trunc(v_y) then return false; end if;
  if v_action='click' then
   v_keys:=v_keys||array['button'];
   if coalesce(p_args->>'button','') not in ('left','middle','right') then return false; end if;
  end if;
 when 'scroll' then
  v_keys:=v_keys||array['direction','amount'];
  if coalesce(p_args->>'direction','') not in ('up','down') or jsonb_typeof(p_args->'amount') is distinct from 'number' then return false; end if;
  v_x:=(p_args->>'amount')::numeric;
  if v_x<1 or v_x>20 or v_x<>trunc(v_x) then return false; end if;
 when 'press' then
  v_keys:=v_keys||array['key'];
  if jsonb_typeof(p_args->'key') is distinct from 'string' or (p_args->>'key') !~ v_key_pattern then return false; end if;
 when 'type' then
  v_keys:=v_keys||array['text'];
  if jsonb_typeof(p_args->'text') is distinct from 'string' or octet_length(p_args->>'text')>16384
   or length(btrim(p_args->>'text',v_whitespace))=0 then return false; end if;
 else return false;
 end case;
 return p_args-v_keys='{}'::jsonb;
end
$$;
revoke all on function public.qorpera_valid_office_desktop_action(jsonb) from public,anon,authenticated,service_role;

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
		if not (v_descriptor->'capabilities' ? 'shell') or not public.qorpera_valid_office_file_export(v_operation->'arguments') then
			raise exception 'Invalid office file transfer or workbench grant' using errcode='42501'; end if;
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
