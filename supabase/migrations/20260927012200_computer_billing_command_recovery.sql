-- Positive canonical provider proof only. An aged ambiguous command is never
-- reset or retried with a fresh provider key, and absence is not proof.
alter table public.qorpera_computer_billing_commands add column recovered_terminal boolean not null default false;
create table public.qorpera_computer_billing_command_recoveries (
    command_id uuid primary key references public.qorpera_computer_billing_commands(id),
    proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=8192),
    recovered_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_computer_billing_command_recoveries enable row level security;
revoke all on public.qorpera_computer_billing_command_recoveries from public,anon,authenticated,service_role,qorpera_secret_broker;
create function public.qorpera_billing_recovery_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Billing recovery receipt is immutable' using errcode='42501'; end $$;
create trigger qorpera_billing_recovery_immutable before update or delete on public.qorpera_computer_billing_command_recoveries
    for each row execute function public.qorpera_billing_recovery_immutable();

create function public.qorpera_describe_computer_billing_command(p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.qorpera_computer_billing_commands%rowtype;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing bridge required' using errcode='42501'; end if;
    select * into strict c from public.qorpera_computer_billing_commands where id=p_command_id;
    return jsonb_build_object('commandId',c.id,'userId',c.user_id,'kind',c.kind,'requestId',c.request_id,
        'payload',c.payload,'createdAt',c.created_at,'result',c.result,'recoveredTerminal',c.recovered_terminal,
        'idempotencyKey','qorpera-computer-'||c.id::text,
        'customerId',(select customer_id from public.qorpera_computer_billing_customers where user_id=c.user_id),
        'recovery',(select proof from public.qorpera_computer_billing_command_recoveries where command_id=c.id));
end $$;

create function public.qorpera_recover_computer_billing_command(p_command_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.qorpera_computer_billing_commands%rowtype; v_user uuid; prior jsonb; v_result jsonb; v_customer text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing bridge required' using errcode='42501'; end if;
    select user_id into strict v_user from public.qorpera_computer_billing_commands where id=p_command_id;
    perform 1 from auth.users where id=v_user for update;
    select * into strict c from public.qorpera_computer_billing_commands where id=p_command_id for update;
    select proof into prior from public.qorpera_computer_billing_command_recoveries where command_id=c.id;
    if found then
        if prior is distinct from p_proof then raise exception 'Billing recovery replay differs' using errcode='23505'; end if;
        return public.qorpera_describe_computer_billing_command(c.id);
    end if;
    if c.result is not null or c.recovered_terminal or c.created_at>clock_timestamp()-interval '23 hours'
        or c.lease_until>clock_timestamp() then raise exception 'Billing command is not recoverable' using errcode='55000'; end if;
    if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>8192
        or not p_proof ?& array['schema','kind','userId','providerObjectId','providerRequestKey','customerId','priceId','returnUrl','providerState','result','objectSha256','eventId','eventSha256','verifiedAt']
        or (select count(*) from jsonb_object_keys(p_proof))<>14
        or p_proof->>'schema' is distinct from 'qorpera.billing-command-recovery/v1'
        or p_proof->>'kind' is distinct from c.kind or p_proof->>'userId' is distinct from c.user_id::text
        or p_proof->>'providerRequestKey' is distinct from 'qorpera-computer-'||c.id::text
        or coalesce(p_proof->>'objectSha256','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_proof->>'customerId','') !~ '^cus_[A-Za-z0-9]+$'
        or p_proof->>'verifiedAt' is null or not isfinite((p_proof->>'verifiedAt')::timestamptz)
        or (p_proof->>'verifiedAt')::timestamptz not between clock_timestamp()-interval '10 minutes' and clock_timestamp()+interval '30 seconds'
        or ((p_proof->>'eventId') is null) is distinct from ((p_proof->>'eventSha256') is null)
        or (p_proof->>'eventId' is not null and (p_proof->>'eventId' !~ '^evt_[A-Za-z0-9]+$' or p_proof->>'eventSha256' !~ '^[0-9a-f]{64}$')) then
        raise exception 'Canonical correlated billing proof required' using errcode='22023'; end if;
    v_result:=nullif(p_proof->'result','null'::jsonb);
    if c.kind='customer' then
        if p_proof->>'providerState' is distinct from 'present' or p_proof->>'providerObjectId' is distinct from p_proof->>'customerId'
            or v_result is distinct from jsonb_build_object('customerId',p_proof->>'customerId')
            or p_proof->>'priceId' is not null or p_proof->>'returnUrl' is not null then
            raise exception 'Recovered customer differs' using errcode='22023'; end if;
        perform public.qorpera_map_computer_billing_customer(c.user_id,p_proof->>'customerId');
    else
        select customer_id into v_customer from public.qorpera_computer_billing_customers where user_id=c.user_id;
        if v_customer is null or v_customer is distinct from p_proof->>'customerId'
            or p_proof->>'priceId' is distinct from c.payload->>'priceId' or p_proof->>'returnUrl' is distinct from c.payload->>'returnUrl'
            or coalesce(p_proof->>'providerObjectId','') !~ '^cs_[A-Za-z0-9_]+$'
            or coalesce(p_proof->>'providerState','') not in ('open','complete','expired') then
            raise exception 'Recovered checkout intent differs' using errcode='22023'; end if;
        if p_proof->>'providerState'='open' then
            if v_result is null or jsonb_typeof(v_result)<>'object' or (select count(*) from jsonb_object_keys(v_result))<>3
                or v_result->>'sessionId' is distinct from p_proof->>'providerObjectId'
                or coalesce(v_result->>'url','') !~ '^https://checkout[.]stripe[.]com/'
                or v_result->>'expiresAt' is null or not isfinite((v_result->>'expiresAt')::timestamptz)
                or (v_result->>'expiresAt')::timestamptz<=clock_timestamp() then
                raise exception 'Open checkout result differs' using errcode='22023'; end if;
        elsif v_result is not null then raise exception 'Terminal checkout cannot advertise a payment URL' using errcode='22023'; end if;
    end if;
    insert into public.qorpera_computer_billing_command_recoveries(command_id,proof) values(c.id,p_proof);
    update public.qorpera_computer_billing_commands set result=v_result,lease_token=null,lease_until=null,
        recovered_terminal=(c.kind='checkout' and p_proof->>'providerState'<>'open') where id=c.id;
    return public.qorpera_describe_computer_billing_command(c.id);
end $$;
revoke all on function public.qorpera_billing_recovery_immutable(),public.qorpera_describe_computer_billing_command(uuid),
    public.qorpera_recover_computer_billing_command(uuid,jsonb) from public,anon,authenticated,service_role,qorpera_secret_broker;

do $$ declare definition text; anchor text; replacement text; begin
    definition:=pg_get_functiondef('public.qorpera_begin_computer_billing_command(uuid,text,uuid,jsonb)'::regprocedure);
    anchor:='(result is null or (result->>''expiresAt'')::timestamptz>clock_timestamp())';
    replacement:='((result is null and not recovered_terminal) or (result->>''expiresAt'')::timestamptz>clock_timestamp())';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Billing recovery candidate anchor differs'; end if;
    definition:=replace(definition,anchor,replacement);
    anchor:='    if c.result is not null then return jsonb_build_object(''state'',''completed'',''result'',c.result); end if;';
    replacement:=$new$    if c.recovered_terminal then return jsonb_build_object('state','recovered_terminal','requestId',c.request_id,
        'sessionId',(select proof->>'providerObjectId' from public.qorpera_computer_billing_command_recoveries where command_id=c.id),
        'expiresAt',(select recovered_at from public.qorpera_computer_billing_command_recoveries where command_id=c.id)); end if;
$new$||anchor;
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Billing recovery replay anchor differs'; end if;
    execute replace(definition,anchor,replacement);
end $$;
