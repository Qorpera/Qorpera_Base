-- Host-attested durable prestart decisions. A missing VM or expired deadline is
-- never cancellation evidence. These records survive even a prepare that has
-- not reached SQL, fencing its delayed request. They do not release node/VM
-- custody, authorize physical deletion, or change paid-readiness switches.
create table public.qorpera_computer_prestart_attempts (
    permit_id uuid primary key,
    profile_id uuid not null references public.qorpera_profiles(id),
    kind text not null check(kind in ('coding','runtime')),
    host_key_id uuid not null,
    identity jsonb not null,
    prepare_request_text text not null,
    abandonment_request jsonb,
    closure jsonb,
    created_at timestamptz not null default clock_timestamp(),
    check((abandonment_request is null)=(closure is null))
);
create unique index qorpera_computer_abandonment_request on public.qorpera_computer_prestart_attempts
    ((abandonment_request->>'requestId')) where abandonment_request is not null;
alter table public.qorpera_computer_prestart_attempts enable row level security;
revoke all on public.qorpera_computer_prestart_attempts from public,anon,authenticated,service_role,qorpera_secret_broker;

-- Compare parsed sanitized identity, but hash its exact transport bytes. No
-- shared canonical JSON implementation and no persisted executor/lease secret
-- is required by the guard. The dedicated host key attests its journal.
create function public.qorpera_computer_prestart_identity(p_request jsonb,p_secret text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_text text:=p_request->>'prepareRequestText'; v_safe jsonb; v_pre jsonb:=p_request->'prestart';
    v_profile uuid; v_host uuid; v_allocation uuid; v_instance text;
    m public.qorpera_coding_machines%rowtype; k public.qorpera_runtime_computer_host_keys%rowtype;
    a public.qorpera_computer_prestart_attempts%rowtype;
begin
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=(p_request->>'requestId')::uuid;
    if p_kind='coding' and a.permit_id is not null then
        -- Cleanup uses immutable enrollment/scope, even if the current machine
        -- or worker has moved on. Revocation still withdraws host authority.
        if auth.role() is distinct from 'service_role' or p_secret is null or octet_length(p_secret) not between 32 and 512 then
            raise exception 'Dedicated computer executor authority required' using errcode='42501'; end if;
        select id into v_host from public.qorpera_computer_executor_keys where id=a.host_key_id and revoked_at is null
            and owner=p_request->>'owner' and machine_id_sha256=p_request->>'machineIdSha256'
            and key_sha256=encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex') for share;
        if v_host is null then raise exception 'Dedicated computer executor authority required' using errcode='42501'; end if;
        v_profile:=a.profile_id; v_allocation:=(p_request->>'machineId')::uuid;
        v_instance:=encode(extensions.digest(convert_to(p_request->>'bindingText','UTF8'),'sha256'),'hex');
    elsif p_kind='coding' then
        m:=public.qorpera_computer_executor_machine((p_request->>'machineId')::uuid,p_secret);
        if m.owner is distinct from p_request->>'owner' or m.machine_id_sha256 is distinct from p_request->>'machineIdSha256'
            or m.binding is distinct from (p_request->>'bindingText')::jsonb
            or m.instance_sha256 is distinct from encode(extensions.digest(convert_to(p_request->>'bindingText','UTF8'),'sha256'),'hex') then
            raise exception 'Computer prestart binding differs' using errcode='42501'; end if;
        select id into strict v_host from public.qorpera_computer_executor_keys where environment_id=m.environment_id
            and owner=m.owner and machine_id_sha256=m.machine_id_sha256 and revoked_at is null
            and key_sha256=encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex') for share;
        v_profile:=m.profile_id; v_allocation:=m.id; v_instance:=m.instance_sha256;
    elsif p_kind='runtime' then
        k:=public.qorpera_runtime_computer_host(p_request,p_secret);
        v_profile:=case when a.permit_id is not null then a.profile_id else public.qorpera_runtime_computer_profile(p_request) end; v_host:=k.id;
        v_allocation:=(p_request->>'allocationId')::uuid; v_instance:=p_request->>'instanceSha256';
    else raise exception 'Invalid computer prestart kind' using errcode='22023'; end if;
    if p_request->>'schema' is distinct from ('qorpera.'||p_kind||'-computer-prepare/v2')
        or v_text is null or octet_length(v_text) not between 2 and 18000 or jsonb_typeof(v_pre) is distinct from 'object'
        or not v_pre ?& array['guardIncarnationId','prepareSha256'] or (select count(*) from jsonb_object_keys(v_pre))<>2
        or coalesce(v_pre->>'prepareSha256','') !~ '^[0-9a-f]{64}$' or v_pre->>'guardIncarnationId' is null
        or p_request->>'requestId' is null or p_request->>'hostBootId' is null
        or v_allocation is null or coalesce(v_instance,'') !~ '^[0-9a-f]{64}$' then
        raise exception 'Durable computer prestart intent required' using errcode='22023'; end if;
    v_safe:=v_text::jsonb;
    if v_safe is distinct from p_request-'prestart'-'prepareRequestText'-'leaseToken'
        or v_pre->>'prepareSha256' is distinct from encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex') then
        raise exception 'Computer prestart request digest differs' using errcode='23505'; end if;
    return jsonb_build_object('profileId',v_profile,'hostKeyId',v_host,'kind',p_kind,
        'guard',jsonb_build_object('schema','qorpera.computer-prestart-abandonment/v1','permitId',(p_request->>'requestId')::uuid,
            'allocationId',v_allocation,'instanceSha256',v_instance,'hostMachineIdSha256',p_request->>'machineIdSha256',
            'hostBootId',(p_request->>'hostBootId')::uuid,'prepareSha256',v_pre->>'prepareSha256',
            'guardIncarnationId',(v_pre->>'guardIncarnationId')::uuid));
end $$;

-- Called after the existing profile/command locks and before any hold exists.
create function public.qorpera_register_computer_prestart(p_request jsonb,p_secret text,p_kind text)
returns void language plpgsql security definer set search_path='' as $$
declare v_identity jsonb; a public.qorpera_computer_prestart_attempts%rowtype; v_id uuid:=(p_request->>'requestId')::uuid;
begin
    v_identity:=public.qorpera_computer_prestart_identity(p_request,p_secret,p_kind);
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=v_id for update;
    if found then
        if a.identity<>v_identity or a.prepare_request_text<>p_request->>'prepareRequestText' then
            raise exception 'Computer prestart replay differs' using errcode='23505'; end if;
        if a.closure is not null then raise exception 'Computer attempt abandoned before dispatch' using errcode='55000'; end if;
        return;
    end if;
    if exists(select 1 from public.qorpera_coding_computer_permits where id=v_id)
        or exists(select 1 from public.qorpera_coding_computer_commands where request_id=v_id) then
        raise exception 'Legacy computer attempt has no durable prestart intent' using errcode='55000'; end if;
    insert into public.qorpera_computer_prestart_attempts(permit_id,profile_id,kind,host_key_id,identity,prepare_request_text)
        values(v_id,(v_identity->>'profileId')::uuid,p_kind,(v_identity->>'hostKeyId')::uuid,v_identity,p_request->>'prepareRequestText');
end $$;

create function pg_temp.prestart_patch(p_function regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_function);
begin
    if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Computer prestart patch source differs: %',p_function; end if;
    execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.prestart_patch('public.qorpera_prepare_coding_computer_permit(jsonb,text)',
    'qorpera.coding-computer-prepare/v1','qorpera.coding-computer-prepare/v2');
select pg_temp.prestart_patch('public.qorpera_prepare_coding_computer_permit(jsonb,text)',
    '(select count(*) from jsonb_object_keys(p_request))<>11','(select count(*) from jsonb_object_keys(p_request))<>13');
select pg_temp.prestart_patch('public.qorpera_prepare_coding_computer_permit(jsonb,text)',
    'select * into c from public.qorpera_coding_computer_commands where request_id=v_id;',
    'perform public.qorpera_register_computer_prestart(p_request,p_executor_secret,''coding'');
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;');
select pg_temp.prestart_patch('public.qorpera_prepare_runtime_computer_permit(jsonb,text)',
    'qorpera.runtime-computer-prepare/v1','qorpera.runtime-computer-prepare/v2');
select pg_temp.prestart_patch('public.qorpera_prepare_runtime_computer_permit(jsonb,text)',
    'select * into c from public.qorpera_coding_computer_commands where request_id=v_id;',
    'perform public.qorpera_register_computer_prestart(p_request,p_executor_secret,''runtime'');
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;');

alter function public.qorpera_computer_permit_receipt(uuid,bigint) rename to qorpera_computer_permit_receipt_before_prestart;
create function public.qorpera_computer_permit_receipt(p_permit_id uuid,p_generation bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; a public.qorpera_computer_prestart_attempts%rowtype;
begin
    v_result:=public.qorpera_computer_permit_receipt_before_prestart(p_permit_id,p_generation);
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=p_permit_id;
    if found then return v_result||jsonb_build_object('schema','qorpera.computer-usage-permit/v2',
        'prestart',jsonb_build_object('guardIncarnationId',a.identity#>>'{guard,guardIncarnationId}','prepareSha256',a.identity#>>'{guard,prepareSha256}'),
        'closure',a.closure); end if;
    return v_result;
end $$;

-- No sample is synthesized. Close only the untouched zero checkpoint and settle
-- exactly that initial receipt. The original hold sources receive their own
-- reserved capacity back through the existing atomic settlement ledger.
create function public.qorpera_abandon_computer_prestart(p_request jsonb,p_secret text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_prepare jsonb; v_identity jsonb; v_id uuid; v_profile uuid; v_guard jsonb:=p_request->'abandonment';
    a public.qorpera_computer_prestart_attempts%rowtype; p public.qorpera_coding_computer_permits%rowtype;
    s public.qorpera_computer_usage_streams%rowtype; r public.qorpera_computer_allowance_reservations%rowtype;
    v_result jsonb; v_settlement jsonb; v_reserved boolean:=false;
begin
    if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>22000
        or p_request->>'schema' is distinct from 'qorpera.computer-abandon/v1'
        or not p_request ?& array['requestId','permitId','generation','prepareRequestText','abandonment']
        or (select count(*) from jsonb_object_keys(p_request))<>6 or p_request->>'requestId' is null
        or p_request->'generation' is distinct from '1'::jsonb then raise exception 'Invalid computer abandonment request' using errcode='22023'; end if;
    perform (p_request->>'requestId')::uuid;
    v_id:=(p_request->>'permitId')::uuid;
    v_prepare:=(p_request->>'prepareRequestText')::jsonb||jsonb_build_object('prepareRequestText',p_request->>'prepareRequestText',
        'prestart',jsonb_build_object('guardIncarnationId',v_guard->'guardIncarnationId','prepareSha256',v_guard->'prepareSha256'));
    v_identity:=public.qorpera_computer_prestart_identity(v_prepare,p_secret,p_kind);
    if v_guard is distinct from v_identity->'guard' or v_id is distinct from (v_guard->>'permitId')::uuid then
        raise exception 'Computer abandonment identity differs' using errcode='42501'; end if;
    v_profile:=(v_identity->>'profileId')::uuid;
    perform 1 from public.qorpera_profiles where id=v_profile for update;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=v_id for update;
    if found then
        if a.identity<>v_identity or a.prepare_request_text<>p_request->>'prepareRequestText' then
            raise exception 'Computer abandonment replay differs' using errcode='23505'; end if;
        if a.closure is not null then
            if a.abandonment_request<>p_request then raise exception 'Computer abandonment replay differs' using errcode='23505'; end if;
            return a.closure;
        end if;
    else
        if exists(select 1 from public.qorpera_coding_computer_permits where id=v_id)
            or exists(select 1 from public.qorpera_coding_computer_commands where request_id=v_id) then
            raise exception 'Legacy computer attempt has no durable prestart intent' using errcode='55000'; end if;
        insert into public.qorpera_computer_prestart_attempts(permit_id,profile_id,kind,host_key_id,identity,prepare_request_text)
            values(v_id,v_profile,p_kind,(v_identity->>'hostKeyId')::uuid,v_identity,p_request->>'prepareRequestText');
    end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=(v_guard->>'allocationId')::uuid for update;
    select * into p from public.qorpera_coding_computer_permits where id=v_id for update;
    if found then
        if p.profile_id<>v_profile or p.allocation_id<>(v_guard->>'allocationId')::uuid or p.instance_sha256<>v_guard->>'instanceSha256'
            or p.host_boot_id<>(v_guard->>'hostBootId')::uuid or p.state<>'prepared' or p.generation<>1
            or p.physical_id is not null or p.guest_boot_id is not null or p.last_sample is not null
            or (select count(*) from public.qorpera_coding_computer_windows where permit_id=p.id)<>1
            or exists(select 1 from public.qorpera_coding_computer_samples where permit_id=p.id) then
            raise exception 'Computer attempt has dispatch or observation history' using errcode='55000'; end if;
        select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch for update;
        select reservation.* into strict r from public.qorpera_computer_allowance_reservations reservation
            join public.qorpera_coding_computer_windows w on w.reservation_id=reservation.id where w.permit_id=p.id and w.generation=1 for update of reservation;
        if s.last_sequence<>0 or s.active_ms<>0 or s.elapsed_ms<>0 or s.closed or r.settled_at is not null
            or r.from_sequence<>0 or r.from_standard_us<>0 or r.allocation_id<>p.allocation_id or r.epoch<>p.epoch
            or (select count(*) from public.qorpera_computer_usage_receipts where allocation_id=p.allocation_id and epoch=p.epoch)<>1
            or not exists(select 1 from public.qorpera_computer_usage_receipts where allocation_id=p.allocation_id and epoch=p.epoch
                and sequence=0 and elapsed_ms=0 and active_ms=0 and not closed and missing_checkpoints=0)
            or exists(select 1 from public.qorpera_computer_allowance_settlements where allocation_id=p.allocation_id and epoch=p.epoch)
            or exists(select 1 from public.qorpera_computer_allowance_cursors where allocation_id=p.allocation_id and epoch=p.epoch
                and (settled_sequence<>0 or settled_standard_us<>0)) then
            raise exception 'Computer attempt has usage or settlement history' using errcode='55000'; end if;
        v_settlement:=public.qorpera_settle_computer_allowance_internal(r.id,0);
        if v_settlement->>'debitedUs'<>'0' then raise exception 'Prestart settlement consumed allowance'; end if;
        update public.qorpera_computer_usage_streams set closed=true where allocation_id=p.allocation_id and epoch=p.epoch;
        update public.qorpera_coding_computer_permits set state='closed',closed_at=clock_timestamp() where id=p.id;
        v_reserved:=true;
    end if;
    v_result:=jsonb_build_object('schema','qorpera.computer-abandonment-receipt/v1','permitId',v_id,'state','abandoned_before_dispatch',
        'abandonment',v_guard,'reservationReleased',v_reserved,'debitedUs','0','releasedUs',coalesce(v_settlement->>'releasedUs','0'));
    update public.qorpera_computer_prestart_attempts set abandonment_request=p_request,closure=v_result where permit_id=v_id;
    return v_result;
end $$;
create function public.qorpera_abandon_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_abandon_computer_prestart(p_request,p_executor_secret,'coding')
$$;
create function public.qorpera_abandon_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_abandon_computer_prestart(p_request,p_executor_secret,'runtime')
$$;
revoke all on function public.qorpera_computer_prestart_identity(jsonb,text,text),public.qorpera_register_computer_prestart(jsonb,text,text),
    public.qorpera_computer_permit_receipt(uuid,bigint),public.qorpera_computer_permit_receipt_before_prestart(uuid,bigint),
    public.qorpera_abandon_computer_prestart(jsonb,text,text),public.qorpera_abandon_coding_computer_permit(jsonb,text),
    public.qorpera_abandon_runtime_computer_permit(jsonb,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_abandon_coding_computer_permit(jsonb,text),public.qorpera_abandon_runtime_computer_permit(jsonb,text) to service_role;

-- Preserve split SECURITY DEFINER caller ownership across the new private
-- helper and replacement receipt OID. Grants follow reviewed call edges only.
do $$ declare v_caller regprocedure; v_helper regprocedure; v_owner name; v_definer boolean; begin
    for v_caller,v_helper in select * from (values
        ('public.qorpera_prepare_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_register_computer_prestart(jsonb,text,text)'::regprocedure),
        ('public.qorpera_prepare_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_register_computer_prestart(jsonb,text,text)'::regprocedure),
        ('public.qorpera_prepare_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_describe_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_checkpoint_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_runtime_computer_receipt(uuid,bigint)'::regprocedure,'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure),
        ('public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure,'public.qorpera_computer_permit_receipt_before_prestart(uuid,bigint)'::regprocedure)
    ) edge(caller,helper) loop
        select pg_get_userbyid(proowner),prosecdef into strict v_owner,v_definer from pg_proc where oid=v_caller;
        if not v_definer or v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
            raise exception 'Computer prestart helper requires a trusted SECURITY DEFINER caller: %',v_caller; end if;
        execute format('grant execute on function %s to %I',v_helper,v_owner);
    end loop;
end $$;

-- Recovery of an exact retained guard intent must not require a still-current
-- worker, native run, or office generation. Authenticate its original enrolled
-- host and immutable request before reading the terminal decision. An unknown
-- attempt still requires current source authority; no legacy intent is created.
create function public.qorpera_describe_computer_prestart(p_request jsonb,p_secret text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_identity jsonb; v_id uuid; a public.qorpera_computer_prestart_attempts%rowtype;
    p public.qorpera_coding_computer_permits%rowtype; v_receipt jsonb;
begin
    v_identity:=public.qorpera_computer_prestart_identity(p_request,p_secret,p_kind);
    v_id:=(p_request->>'requestId')::uuid;
    perform 1 from public.qorpera_profiles where id=(v_identity->>'profileId')::uuid for update;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=v_id;
    select * into p from public.qorpera_coding_computer_permits where id=v_id;
    if a.permit_id is null then
        if p.id is not null or exists(select 1 from public.qorpera_coding_computer_commands where request_id=v_id) then
            raise exception 'Legacy computer attempt has no durable prestart intent' using errcode='55000'; end if;
        return jsonb_build_object('state','absent','permit',null,'lastSample',null,'closure',null);
    end if;
    if a.identity<>v_identity or a.prepare_request_text<>p_request->>'prepareRequestText' then
        raise exception 'Computer prestart recovery identity differs' using errcode='23505'; end if;
    if p.id is not null then
        v_receipt:=case when p_kind='runtime' then public.qorpera_runtime_computer_receipt(p.id,p.generation)
            else public.qorpera_computer_permit_receipt(p.id,p.generation) end;
    elsif a.closure is null then raise exception 'Computer prestart history is incomplete' using errcode='55000'; end if;
    return jsonb_build_object('state',case when a.closure is not null then 'abandoned' else p.state end,
        'permit',v_receipt,'lastSample',p.last_sample,'closure',a.closure);
end $$;
create function public.qorpera_describe_coding_computer_prestart(p_request jsonb,p_executor_secret text)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_describe_computer_prestart(p_request,p_executor_secret,'coding')
$$;
create function public.qorpera_describe_runtime_computer_prestart(p_request jsonb,p_executor_secret text)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_describe_computer_prestart(p_request,p_executor_secret,'runtime')
$$;
revoke all on function public.qorpera_describe_computer_prestart(jsonb,text,text),
    public.qorpera_describe_coding_computer_prestart(jsonb,text),public.qorpera_describe_runtime_computer_prestart(jsonb,text)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_describe_coding_computer_prestart(jsonb,text),public.qorpera_describe_runtime_computer_prestart(jsonb,text) to service_role;
