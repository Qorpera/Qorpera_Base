-- A dedicated physical host may upload its guard's immutable sample chain
-- after a provider/database outage. Upload grants no start, renewal or capacity.
create table public.qorpera_computer_guard_sample_cursors (
    permit_id uuid primary key references public.qorpera_coding_computer_permits(id),
    sequence bigint not null default 0 check(sequence>=0),
    sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
    observation_id uuid,
    sealed boolean not null default false,
    check((sequence=0)=(sha256 is null)),
    check((sequence=0)=(observation_id is null))
);
create table public.qorpera_computer_guard_sample_entries (
    permit_id uuid not null references public.qorpera_coding_computer_permits(id),
    sequence bigint not null check(sequence>0),
    sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
    entry_text text not null check(octet_length(entry_text) between 2 and 8192),
    entry jsonb not null,
    applied_generation bigint not null,
    observation_id uuid not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key(permit_id,sequence),
    unique(permit_id,observation_id),
    foreign key(permit_id,applied_generation) references public.qorpera_coding_computer_windows(permit_id,generation)
);
alter table public.qorpera_computer_guard_sample_cursors enable row level security;
alter table public.qorpera_computer_guard_sample_entries enable row level security;
revoke all on public.qorpera_computer_guard_sample_cursors,public.qorpera_computer_guard_sample_entries
    from public,anon,authenticated,service_role,qorpera_secret_broker;
create function public.qorpera_computer_guard_entry_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Guard sample receipt is immutable' using errcode='42501'; end $$;
create trigger qorpera_computer_guard_entry_immutable before update or delete on public.qorpera_computer_guard_sample_entries
    for each row execute function public.qorpera_computer_guard_entry_immutable();

-- Once a permit has a durable producer, direct checkpoint/bind callers cannot
-- insert competing observations. Renewal and finish may replay its exact tip.
alter function public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)
    rename to qorpera_apply_computer_sample_before_guard;
create function public.qorpera_apply_coding_computer_sample(p_permit_id uuid,p_generation bigint,p_sample jsonb,p_terminal boolean)
returns bigint language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from public.qorpera_computer_guard_sample_cursors where permit_id=p_permit_id)
        and not exists(select 1 from public.qorpera_computer_guard_sample_entries
            where permit_id=p_permit_id and observation_id=(p_sample->>'observationId')::uuid
            and applied_generation=p_generation and entry->'sample'=p_sample) then
        raise exception 'Durable guard sample required' using errcode='42501'; end if;
    return public.qorpera_apply_computer_sample_before_guard(p_permit_id,p_generation,p_sample,p_terminal);
end $$;

create function public.qorpera_record_computer_guard_samples(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; a public.qorpera_computer_prestart_attempts%rowtype;
    c public.qorpera_computer_guard_sample_cursors%rowtype; old public.qorpera_computer_guard_sample_entries%rowtype;
    w public.qorpera_coding_computer_windows%rowtype;
    item jsonb; e jsonb; local_permit jsonb; sample jsonb; stop jsonb; expected jsonb;
    v_text text; v_sha text; v_sequence bigint; v_generation bigint; v_terminal boolean; v_runtime boolean;
begin
    if p_request is null or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>65536
        or (select count(*) from jsonb_object_keys(p_request))<>3 or not p_request ?& array['permitId','generation','entries']
        or jsonb_typeof(p_request->'entries') is distinct from 'array'
        or jsonb_array_length(p_request->'entries') not between 1 and 16 then
        raise exception 'Bounded guard sample batch required' using errcode='22023'; end if;
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    select * into strict a from public.qorpera_computer_prestart_attempts where permit_id=p.id;
    v_runtime:=exists(select 1 from public.qorpera_runtime_computer_contexts where permit_id=p.id);
    if v_runtime then perform public.qorpera_runtime_computer_permit_host(p.id,p_executor_secret);
    else perform public.qorpera_coding_computer_terminal_host(p.id,p_executor_secret); end if;
    if a.closure is not null or a.profile_id<>p.profile_id or a.kind<>(case when v_runtime then 'runtime' else 'coding' end) then
        raise exception 'Original guard authority differs' using errcode='42501'; end if;
    -- Match checkpoint/finish ordering; a refund cannot erase this held usage.
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id for update;
    select * into strict p from public.qorpera_coding_computer_permits where id=p.id for update;
    select * into c from public.qorpera_computer_guard_sample_cursors where permit_id=p.id for update;
    if not found then
        if p.state<>'prepared' or p.last_sample is not null then
            raise exception 'Existing sampled permit requires its original producer' using errcode='55000'; end if;
        insert into public.qorpera_computer_guard_sample_cursors(permit_id) values(p.id) returning * into c;
    end if;
    for item in select value from jsonb_array_elements(p_request->'entries') loop
        if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>3
            or not item ?& array['sequence','sha256','entryText'] or coalesce(item->>'sequence','') !~ '^[1-9][0-9]{0,14}$'
            or coalesce(item->>'sha256','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(item->'entryText') is distinct from 'string'
            or octet_length(item->>'entryText') not between 2 and 8192 then
            raise exception 'Invalid guard sample envelope' using errcode='22023'; end if;
        v_sequence:=(item->>'sequence')::bigint; v_sha:=item->>'sha256'; v_text:=item->>'entryText';
        if v_sha<>encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex') then
            raise exception 'Guard sample bytes differ' using errcode='23505'; end if;
        select * into old from public.qorpera_computer_guard_sample_entries where permit_id=p.id and sequence=v_sequence;
        if found then
            if old.sha256<>v_sha or old.entry_text<>v_text then raise exception 'Guard sample replay differs' using errcode='23505'; end if;
            continue;
        end if;
        if p.state='closed' or c.sealed or (p_request->>'generation')::bigint is distinct from p.generation then
            raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Guard sample generation unavailable","details":null,"hint":null}',
                detail='{"status":409,"headers":{}}'; end if;
        e:=v_text::jsonb;
        if jsonb_typeof(e) is distinct from 'object' or (select count(*) from jsonb_object_keys(e))<>10
            or not e ?& array['schema','sequence','previousSha256','permit','hostMachineIdSha256','physicalInstanceId','deadlineUptimeMs','stopAtUptimeMs','sample','stopReceipt']
            or e->>'schema' is distinct from 'qorpera.computer-guard-usage-entry/v1'
            or e->'sequence' is distinct from item->'sequence' or v_sequence<>c.sequence+1
            or e->>'previousSha256' is distinct from c.sha256
            or e->>'hostMachineIdSha256' is distinct from a.identity#>>'{guard,hostMachineIdSha256}'
            or jsonb_typeof(e->'permit') is distinct from 'object' or jsonb_typeof(e->'sample') is distinct from 'object'
            or coalesce(e->>'deadlineUptimeMs','') !~ '^(0|[1-9][0-9]{0,15})$'
            or coalesce(e->>'stopAtUptimeMs','') !~ '^(0|[1-9][0-9]{0,15})$'
            or (e->>'deadlineUptimeMs')::bigint>9007199254740991
            or (e->>'deadlineUptimeMs')::bigint-(e->>'stopAtUptimeMs')::bigint<>30000 then
            raise exception 'Guard sample chain differs' using errcode='23505'; end if;
        local_permit:=e->'permit'; sample:=e->'sample'; stop:=e->'stopReceipt';
        if sample->>'state'<>'running' and sample->'guestUptimeMs' is distinct from 'null'::jsonb then
            raise exception 'Unconfirmed guest clock cannot carry uptime' using errcode='22023'; end if;
        if coalesce(local_permit->>'generation','') !~ '^[1-9][0-9]{0,14}$' then
            raise exception 'Invalid captured generation' using errcode='22023'; end if;
        v_generation:=(local_permit->>'generation')::bigint;
        if v_generation not in (p.generation,p.generation-1) then
            raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Captured generation skipped","details":null,"hint":null}',
                detail='{"status":409,"headers":{}}'; end if;
        select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=v_generation;
        expected:=public.qorpera_computer_permit_receipt(p.id,v_generation);
        -- Ignore mutable receipt fields, but compare every authority field.
        if local_permit->>'schema' is distinct from 'qorpera.computer-usage-permit/v2'
            or (local_permit-'validForMs'-'state'-'guestBootId'-'physicalId'-'runtimeContext'-'closure')
                is distinct from (expected-'validForMs'-'state'-'guestBootId'-'physicalId'-'runtimeContext'-'closure')
            or coalesce(local_permit->>'state','') not in ('prepared','bound')
            or sample->>'previousObservationId' is distinct from c.observation_id::text
            or sample->>'physicalId' is distinct from e->>'physicalInstanceId'
            or (p.physical_id is not null and e->>'physicalInstanceId' is distinct from p.physical_id::text) then
            raise exception 'Captured computer identity differs' using errcode='42501'; end if;
        perform (e->>'physicalInstanceId')::uuid;
        v_terminal:=coalesce(sample->>'state','') in ('stopped','absent');
        if not v_terminal then
            if stop is distinct from 'null'::jsonb or sample->>'hostBootId' is distinct from p.host_boot_id::text
                or (sample->>'hostUptimeMs')::bigint>(e->>'deadlineUptimeMs')::bigint
                or (sample->>'observedAt')::timestamptz<w.issued_at or (sample->>'observedAt')::timestamptz>w.deadline then
                raise exception 'Sample exceeds captured authority' using errcode='42501'; end if;
        else
            if jsonb_typeof(stop) is distinct from 'object' or (select count(*) from jsonb_object_keys(stop))<>11
                or not stop ?& array['permitId','generation','allocationId','instanceSha256','physicalInstanceId','hostBootId','observedUptimeMs','closedAtUptimeMs','closedHostBootId','state','operationId']
                or stop->>'permitId' is distinct from p.id::text or stop->'generation' is distinct from local_permit->'generation'
                or stop->>'allocationId' is distinct from p.allocation_id::text or stop->>'instanceSha256' is distinct from p.instance_sha256
                or stop->>'physicalInstanceId' is distinct from e->>'physicalInstanceId' or stop->>'hostBootId' is distinct from p.host_boot_id::text
                or stop->>'state' is distinct from sample->>'state' or stop->>'closedHostBootId' is distinct from sample->>'hostBootId'
                or coalesce(stop->>'observedUptimeMs','') !~ '^(0|[1-9][0-9]{0,15})$'
                or coalesce(stop->>'closedAtUptimeMs','') !~ '^(0|[1-9][0-9]{0,15})$'
                or (stop->>'closedAtUptimeMs')::bigint is distinct from (sample->>'hostUptimeMs')::bigint
                or (stop->>'observedUptimeMs')::bigint>(stop->>'closedAtUptimeMs')::bigint then
                raise exception 'Terminal guard receipt differs' using errcode='42501'; end if;
            if stop->>'operationId' is not null then perform (stop->>'operationId')::uuid; end if;
        end if;
        -- Publish the authority row and financial checkpoint atomically. No API
        -- role can preinsert an entry to bypass the producer fence.
        insert into public.qorpera_computer_guard_sample_entries(permit_id,sequence,sha256,entry_text,entry,applied_generation,observation_id)
            values(p.id,v_sequence,v_sha,v_text,e,p.generation,(sample->>'observationId')::uuid);
        perform public.qorpera_apply_coding_computer_sample(p.id,p.generation,sample,v_terminal);
        update public.qorpera_computer_guard_sample_cursors set sequence=v_sequence,sha256=v_sha,
            observation_id=(sample->>'observationId')::uuid,sealed=v_terminal where permit_id=p.id returning * into c;
        select * into strict p from public.qorpera_coding_computer_permits where id=p.id;
    end loop;
    return jsonb_build_object('schema','qorpera.computer-guard-usage-receipt/v1',
        'permit',case when v_runtime then public.qorpera_runtime_computer_receipt(p.id,p.generation)
            else public.qorpera_computer_permit_receipt(p.id,p.generation) end,
        'cursor',jsonb_build_object('sequence',c.sequence,'sha256',c.sha256,'observationId',c.observation_id),
        'sealed',c.sealed,'lastSample',p.last_sample);
end $$;

-- Renewal must consume the latest running fact under the caller's existing
-- profile/allocation/permit locks. Historical checkpoint replay remains valid,
-- but cannot renew across a newer running observation or an unresolved gap.
create function public.qorpera_assert_computer_guard_renew(p_permit_id uuid,p_sample jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare c public.qorpera_computer_guard_sample_cursors%rowtype;
begin
    select * into c from public.qorpera_computer_guard_sample_cursors where permit_id=p_permit_id;
    if found and (c.sealed or p_sample->>'state' is distinct from 'running' or not exists(
        select 1 from public.qorpera_computer_guard_sample_entries where permit_id=p_permit_id
            and sequence=c.sequence and sha256=c.sha256 and observation_id=c.observation_id and entry->'sample'=p_sample)) then
        raise exception 'Current running guard sample required for renewal' using errcode='55000'; end if;
end $$;

create function public.qorpera_assert_computer_guard_finish(p_permit_id uuid,p_sample jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare c public.qorpera_computer_guard_sample_cursors%rowtype;
begin
    select * into c from public.qorpera_computer_guard_sample_cursors where permit_id=p_permit_id;
    if found and (not c.sealed or not exists(select 1 from public.qorpera_computer_guard_sample_entries
        where permit_id=p_permit_id and sequence=c.sequence and sha256=c.sha256 and entry->'sample'=p_sample)) then
        raise exception 'Sealed guard sample chain required before settlement' using errcode='55000'; end if;
end $$;

do $$ declare target regprocedure; definition text; anchor text; begin
    foreach target in array array['public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_renew_runtime_computer_permit(jsonb,text)'::regprocedure] loop
        definition:=pg_get_functiondef(target);
        anchor:='    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->''sample'',false);';
        if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Guard renewal integration changed'; end if;
        execute replace(definition,anchor,
            '    perform public.qorpera_assert_computer_guard_renew(p.id,p_request->''sample'');'||chr(10)||anchor);
    end loop;
    foreach target in array array['public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_finish_runtime_computer_permit(jsonb,text)'::regprocedure] loop
        definition:=pg_get_functiondef(target);
        anchor:='    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->''sample'',true);';
        if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Guard finish integration changed'; end if;
        definition:=replace(definition,anchor,
            '    perform public.qorpera_assert_computer_guard_finish(p.id,p_request->''sample'');'||chr(10)||anchor);
        anchor:='    select last_sequence into strict v_settle_seq from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch;';
        if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Guard settlement integration changed'; end if;
        execute replace(definition,anchor,
            '    select coalesce(max(sequence),0) into v_settle_seq from public.qorpera_coding_computer_samples where permit_id=p.id and coverage<>''terminal'';');
    end loop;
end $$;

revoke all on function public.qorpera_computer_guard_entry_immutable(),
    public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean),
    public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean),
    public.qorpera_record_computer_guard_samples(jsonb,text),public.qorpera_assert_computer_guard_finish(uuid,jsonb),
    public.qorpera_assert_computer_guard_renew(uuid,jsonb)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_record_computer_guard_samples(jsonb,text) to service_role;
-- Preserve split trusted SECURITY DEFINER ownership on the changed call edges.
do $$ declare caller regprocedure; helper regprocedure; owner_name name; begin
    for caller,helper in select * from (values
        ('public.qorpera_checkpoint_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_checkpoint_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_renew_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_assert_computer_guard_renew(uuid,jsonb)'::regprocedure),
        ('public.qorpera_renew_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_assert_computer_guard_renew(uuid,jsonb)'::regprocedure),
        ('public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_finish_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)'::regprocedure),
        ('public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_assert_computer_guard_finish(uuid,jsonb)'::regprocedure),
        ('public.qorpera_finish_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_assert_computer_guard_finish(uuid,jsonb)'::regprocedure)
    ) edge(caller,helper) loop
        select pg_get_userbyid(proowner) into strict owner_name from pg_proc where oid=caller and prosecdef;
        if owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Trusted sample caller required'; end if;
        execute format('grant execute on function %s to %I',helper,owner_name);
    end loop;
end $$;
