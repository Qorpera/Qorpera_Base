-- Fresh physical starts pin their one sample producer before prepare returns.
-- v3 is a downgrade fence: older runtime SQL accepted extra v2 request fields,
-- so a marker alone could not prove that the database understood this fence.
create function pg_temp.producer_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare definition text:=pg_get_functiondef(p_target);
begin
    if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Reviewed producer source changed: %',p_target; end if;
    execute replace(definition,p_old,p_new);
end $$;
select pg_temp.producer_patch('public.qorpera_computer_prestart_identity(jsonb,text,text)',
    $old$p_request->>'schema' is distinct from ('qorpera.'||p_kind||'-computer-prepare/v2')$old$,
    $new$(p_request->>'schema' is distinct from ('qorpera.'||p_kind||'-computer-prepare/v2')
        and p_request->>'schema' is distinct from ('qorpera.'||p_kind||'-computer-prepare/v3'))
        or (p_request->>'schema'='qorpera.'||p_kind||'-computer-prepare/v3' and p_request->'usageProducer' is distinct from '"guard-v1"'::jsonb)
        or (p_request->>'schema'='qorpera.'||p_kind||'-computer-prepare/v2' and p_request ? 'usageProducer')$new$);
select pg_temp.producer_patch('public.qorpera_register_computer_prestart(jsonb,text,text)',
    '    insert into public.qorpera_computer_prestart_attempts(permit_id,profile_id,kind,host_key_id,identity,prepare_request_text)',
    $new$    if p_request->>'schema' is distinct from ('qorpera.'||p_kind||'-computer-prepare/v3')
        or p_request->'usageProducer' is distinct from '"guard-v1"'::jsonb then
        raise exception 'Fresh computer requires durable guard producer' using errcode='55000'; end if;
    insert into public.qorpera_computer_prestart_attempts(permit_id,profile_id,kind,host_key_id,identity,prepare_request_text)$new$);
select pg_temp.producer_patch('public.qorpera_prepare_coding_computer_permit(jsonb,text)',
    $old$p_request->>'schema' is distinct from 'qorpera.coding-computer-prepare/v2'$old$,
    $new$(p_request->>'schema' is distinct from 'qorpera.coding-computer-prepare/v2' and p_request->>'schema' is distinct from 'qorpera.coding-computer-prepare/v3')$new$);
select pg_temp.producer_patch('public.qorpera_prepare_coding_computer_permit(jsonb,text)',
    '(select count(*) from jsonb_object_keys(p_request))<>13',
    '(select count(*) from jsonb_object_keys(p_request))<>(case when p_request->>''schema''=''qorpera.coding-computer-prepare/v3'' then 14 else 13 end)');
select pg_temp.producer_patch('public.qorpera_prepare_runtime_computer_permit(jsonb,text)',
    $old$p_request->>'schema' is distinct from 'qorpera.runtime-computer-prepare/v2'$old$,
    $new$(p_request->>'schema' is distinct from 'qorpera.runtime-computer-prepare/v2' and p_request->>'schema' is distinct from 'qorpera.runtime-computer-prepare/v3')$new$);

create function public.qorpera_pin_computer_guard_producer() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from public.qorpera_computer_prestart_attempts a where a.permit_id=new.id
        and a.prepare_request_text::jsonb->>'usageProducer'='guard-v1') then
        insert into public.qorpera_computer_guard_sample_cursors(permit_id) values(new.id);
    end if;
    return new;
end $$;
revoke all on function public.qorpera_pin_computer_guard_producer() from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_pin_computer_guard_producer after insert on public.qorpera_coding_computer_permits
    for each row execute function public.qorpera_pin_computer_guard_producer();

-- Old unmarked attempts keep their original producer. A nonzero guard cursor
-- proves an accepted pre-upgrade guard stream; preserve its terminal/replay
-- authority without changing the immutable request digest. Raw-only attempts
-- cannot switch producer, even before their first observation.
select pg_temp.producer_patch('public.qorpera_record_computer_guard_samples(jsonb,text)',
    '    if a.closure is not null or a.profile_id<>p.profile_id',
    $new$    if a.prepare_request_text::jsonb->>'usageProducer' is distinct from 'guard-v1'
        and not exists(select 1 from public.qorpera_computer_guard_sample_cursors where permit_id=p.id and sequence>0) then
        raise exception 'Permit has no durable guard producer' using errcode='55000'; end if;
    if a.closure is not null or a.profile_id<>p.profile_id$new$);
