-- Trusted physical samples, not charges. Unknown intervals remain explicit.
-- Each sample ID is replayable even after physical release; the server owns
-- sequence numbers and differences cumulative counters exactly once.
create table public.qorpera_computer_observer_heads (
    allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
    node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
    epoch uuid,
    last_sample jsonb not null,
    boot_sample jsonb not null,
    foreign key(allocation_id,epoch) references public.qorpera_computer_usage_streams(allocation_id,epoch)
);
create table public.qorpera_computer_observer_samples (
    node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
    observation_id uuid not null,
    allocation_id uuid not null references public.qorpera_runtime_machine_allocations(id) on delete restrict,
    sample jsonb not null check(jsonb_typeof(sample)='object' and octet_length(sample::text)<=4096),
    coverage text not null check(coverage in ('initial','continuous','gap','boot_changed','stale','released','excluded')),
    active_delta_ms bigint not null check(active_delta_ms between 0 and 15000),
    gap_reason text check(gap_reason in ('not_running','missing','unconfirmed','restart','sampling_gap','predecessor_missing','clock_changed')),
    result jsonb not null,
    received_at timestamptz not null default clock_timestamp(),
    primary key(node_id,observation_id)
);
alter table public.qorpera_computer_observer_heads enable row level security;
alter table public.qorpera_computer_observer_samples enable row level security;
revoke all on public.qorpera_computer_observer_heads,public.qorpera_computer_observer_samples from public,anon,authenticated,service_role;

create function public.qorpera_read_node_computer_usage(p_node_id uuid,p_machine_id_sha256 text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
    if auth.role() is distinct from 'service_role' or not exists(select 1 from public.qorpera_runtime_nodes
        where id=p_node_id and machine_id_sha256=p_machine_id_sha256) then
        raise exception 'Computer observer node authority required' using errcode='42501'; end if;
    return jsonb_build_object('schema','qorpera.node-computer-usage/v1','allocations',coalesce((
        select jsonb_agg(jsonb_build_object('allocationId',head.allocation_id,'instanceSha256',allocation.instance_sha256) order by head.allocation_id)
        from public.qorpera_computer_observer_heads head join public.qorpera_runtime_machine_allocations allocation on allocation.id=head.allocation_id
        where head.node_id=p_node_id and head.epoch is not null),'[]'::jsonb));
end $$;

create function public.qorpera_observe_computer_usage(p_sample jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
    v_node uuid; v_id uuid; v_allocation_id uuid; v_time timestamptz; v_uptime bigint; v_delta bigint:=0;
    v_elapsed_delta bigint:=0; v_wall numeric; v_epoch uuid; v_coverage text:='gap'; v_kind text; v_result jsonb;
    v_old public.qorpera_computer_observer_samples%rowtype;
    v_head public.qorpera_computer_observer_heads%rowtype;
    v_allocation public.qorpera_runtime_machine_allocations%rowtype;
    v_stream public.qorpera_computer_usage_streams%rowtype;
    v_same_boot boolean; v_hash text; v_gap_reason text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Trusted computer observer required' using errcode='42501'; end if;
    if p_sample is null or jsonb_typeof(p_sample)<>'object' or octet_length(p_sample::text)>4096
        or p_sample-array['schema','nodeId','machineIdSha256','allocationId','instanceSha256','observationId','observerId','previousObservationId','hostBootId','physicalId','guestBootId','uptimeMs','observedAt','state','reason']<>'{}'::jsonb
        or not p_sample ?& array['schema','nodeId','machineIdSha256','allocationId','instanceSha256','observationId','observerId','previousObservationId','hostBootId','physicalId','guestBootId','uptimeMs','observedAt','state','reason']
        or p_sample->>'schema' is distinct from 'qorpera.computer-usage-sample/v1'
        or coalesce(p_sample->>'machineIdSha256','') !~ '^[0-9a-f]{64}$' or coalesce(p_sample->>'instanceSha256','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_sample->>'state','') not in ('running','gap') or coalesce(p_sample->>'reason','') not in ('running','not_running','missing','unconfirmed')
        or exists(select 1 from unnest(array['nodeId','allocationId','observationId','observerId','hostBootId']) k where coalesce(p_sample->>k,'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        or exists(select 1 from unnest(array['previousObservationId','physicalId','guestBootId']) k where p_sample->k<>'null'::jsonb and coalesce(p_sample->>k,'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        or jsonb_typeof(p_sample->'observedAt')<>'string'
        or (p_sample->'uptimeMs'<>'null'::jsonb and (jsonb_typeof(p_sample->'uptimeMs')<>'number' or (p_sample->>'uptimeMs') !~ '^(0|[1-9][0-9]{0,15})$')) then
        raise exception 'Invalid computer observation' using errcode='22023'; end if;
    v_node:=(p_sample->>'nodeId')::uuid; v_id:=(p_sample->>'observationId')::uuid; v_allocation_id:=(p_sample->>'allocationId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('qorpera.computer-observation:'||v_node::text||':'||v_id::text,0));
    select * into v_old from public.qorpera_computer_observer_samples where node_id=v_node and observation_id=v_id;
    if found then
        if v_old.sample<>p_sample then raise exception 'Computer sample replay differs' using errcode='23505'; end if;
        return v_old.result;
    end if;
    v_time:=(p_sample->>'observedAt')::timestamptz; v_uptime:=(p_sample->>'uptimeMs')::bigint;
    if not isfinite(v_time) or v_time>clock_timestamp()+interval '2 seconds' or v_uptime>9007199254740991
        or (p_sample->>'state'='running' and (p_sample->>'reason'<>'running' or p_sample->>'physicalId' is null or p_sample->>'guestBootId' is null or v_uptime is null))
        or (p_sample->>'state'='gap' and (p_sample->>'reason'='running' or p_sample->>'guestBootId' is not null or v_uptime is not null)) then
        raise exception 'Invalid computer observation clock' using errcode='22023'; end if;
    select * into v_allocation from public.qorpera_runtime_machine_allocations where id=v_allocation_id for update;
    if not found or v_allocation.instance_sha256 is distinct from p_sample->>'instanceSha256'
        or not exists(select 1 from public.qorpera_runtime_node_demands demand join public.qorpera_runtime_nodes node on node.id=demand.node_id
            where demand.allocation_id=v_allocation_id and demand.node_id=v_node and demand.reserved_at is not null
            and node.machine_id_sha256=p_sample->>'machineIdSha256') then
        raise exception 'Computer observation authority differs' using errcode='42501'; end if;
    v_kind:=case when v_allocation.office_id is not null then 'company_computer'
        when v_allocation.coding_machine_id is not null or v_allocation.coding_worker_id is not null then 'coding_machine'
        when v_allocation.run_id is not null then 'agent_sandbox' else 'login_helper' end;
    select * into v_head from public.qorpera_computer_observer_heads where allocation_id=v_allocation_id for update;
    if v_head.allocation_id is not null and v_head.node_id<>v_node then raise exception 'Computer observer node changed' using errcode='42501'; end if;
    if v_head.epoch is not null then
        select * into strict v_stream from public.qorpera_computer_usage_streams where allocation_id=v_allocation_id and epoch=v_head.epoch for update;
    end if;
    v_hash:=encode(extensions.digest(convert_to(p_sample::text,'UTF8'),'sha256'),'hex');
    v_result:=jsonb_build_object('observationId',v_id,'recorded',true,'charged',false,'reason','observed');
    if v_kind='login_helper' then
        v_coverage:='excluded'; v_result:=v_result||'{"recorded":false,"reason":"excluded"}'::jsonb;
    elsif v_allocation.released_at is not null then
        v_coverage:='released'; v_result:=v_result||'{"recorded":false,"reason":"allocation_released"}'::jsonb;
        if v_head.epoch is not null and not v_stream.closed then
            perform public.qorpera_record_computer_usage_checkpoint(v_allocation_id,v_allocation.instance_sha256,v_head.epoch,v_stream.last_sequence+1,
                v_stream.elapsed_ms,v_stream.active_ms,v_stream.observed_at,true,v_kind,v_hash);
            update public.qorpera_computer_observer_heads set epoch=null,last_sample=p_sample where allocation_id=v_allocation_id;
        end if;
    elsif v_head.allocation_id is not null and v_time<=(v_head.last_sample->>'observedAt')::timestamptz then
        v_coverage:='stale';
    elsif p_sample->>'state'='gap' then
        v_gap_reason:=p_sample->>'reason';
        -- Preserve the epoch and cumulative clock, break the predecessor chain.
        if v_head.allocation_id is not null then update public.qorpera_computer_observer_heads set last_sample=p_sample where allocation_id=v_allocation_id; end if;
    else
        if not exists(select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id=v_allocation_id and node_id=v_node
            and physical_id=(p_sample->>'physicalId')::uuid) then raise exception 'Physical computer is not enrolled' using errcode='42501'; end if;
        v_same_boot:=v_head.epoch is not null and not v_stream.closed and v_head.boot_sample->>'hostBootId'=p_sample->>'hostBootId'
            and v_head.boot_sample->>'guestBootId'=p_sample->>'guestBootId' and v_head.boot_sample->>'physicalId'=p_sample->>'physicalId';
        if v_same_boot then
            v_epoch:=v_head.epoch;
            v_wall:=extract(epoch from (v_time-(v_head.last_sample->>'observedAt')::timestamptz))*1000;
            v_elapsed_delta:=greatest(0,v_uptime-(v_head.boot_sample->>'uptimeMs')::bigint);
            v_gap_reason:=case when v_head.last_sample->>'state'='gap' then v_head.last_sample->>'reason'
                when p_sample->>'observerId'<>v_head.last_sample->>'observerId' then 'restart'
                when v_wall>15000 then 'sampling_gap'
                when p_sample->>'previousObservationId' is distinct from v_head.last_sample->>'observationId' then 'predecessor_missing'
                else 'clock_changed' end;
            if v_head.last_sample->>'state'='running' and p_sample->>'previousObservationId'=v_head.last_sample->>'observationId'
                and p_sample->>'observerId'=v_head.last_sample->>'observerId' and v_wall>0 and v_wall<=15000
                and v_uptime>=(v_head.last_sample->>'uptimeMs')::bigint and v_elapsed_delta<=15000 and abs(v_elapsed_delta-v_wall)<=1000 then
                v_delta:=v_elapsed_delta; v_coverage:='continuous'; v_gap_reason:=null;
            end if;
            perform public.qorpera_record_computer_usage_checkpoint(v_allocation_id,v_allocation.instance_sha256,v_epoch,v_stream.last_sequence+1,
                v_stream.elapsed_ms+v_elapsed_delta,v_stream.active_ms+v_delta,v_time,false,v_kind,v_hash);
        else
            if v_head.epoch is not null and not v_stream.closed then
                perform public.qorpera_record_computer_usage_checkpoint(v_allocation_id,v_allocation.instance_sha256,v_head.epoch,v_stream.last_sequence+1,
                    v_stream.elapsed_ms,v_stream.active_ms,v_stream.observed_at,true,v_kind,v_hash);
            end if;
            v_epoch:=extensions.gen_random_uuid(); v_coverage:=case when v_head.allocation_id is null then 'initial' else 'boot_changed' end;
            perform public.qorpera_record_computer_usage_checkpoint(v_allocation_id,v_allocation.instance_sha256,v_epoch,0,0,0,v_time,false,v_kind,v_hash);
        end if;
        insert into public.qorpera_computer_observer_heads(allocation_id,node_id,epoch,last_sample,boot_sample) values(v_allocation_id,v_node,v_epoch,p_sample,p_sample)
            on conflict(allocation_id) do update set epoch=excluded.epoch,last_sample=excluded.last_sample,boot_sample=excluded.boot_sample;
    end if;
    insert into public.qorpera_computer_observer_samples(node_id,observation_id,allocation_id,sample,coverage,active_delta_ms,gap_reason,result)
        values(v_node,v_id,v_allocation_id,p_sample,v_coverage,v_delta,v_gap_reason,v_result);
    return v_result;
end $$;
revoke all on function public.qorpera_read_node_computer_usage(uuid,text),public.qorpera_observe_computer_usage(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_read_node_computer_usage(uuid,text),public.qorpera_observe_computer_usage(jsonb) to service_role;
