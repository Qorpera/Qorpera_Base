-- Host elapsed time is the tariff clock. Guest clocks corroborate continuity;
-- taking the smaller delta per observation systematically discards capture
-- jitter. Bound corroboration over each entire continuous segment instead.
-- This remains sampled evidence: subsecond unobserved suspension is within the
-- one-second paired-clock uncertainty, not proof of exact suspension duration.
create table public.qorpera_computer_clock_segments (
    permit_id uuid primary key references public.qorpera_coding_computer_permits(id),
    host_uptime_ms bigint not null check(host_uptime_ms>=0),
    guest_uptime_ms bigint not null check(guest_uptime_ms>=0),
    observation_id uuid not null
);
alter table public.qorpera_computer_clock_segments enable row level security;
revoke all on public.qorpera_computer_clock_segments from public,anon,authenticated,service_role,qorpera_secret_broker;

-- Called only by the private validated sample applier, under its permit lock,
-- after exact-replay detection. It accepts no billable amount or elapsed time.
create function public.qorpera_computer_clock_segment(p_permit_id uuid,p_previous jsonb,p_sample jsonb,p_pair_valid boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare anchor public.qorpera_computer_clock_segments%rowtype; valid boolean:=false;
begin
    select * into anchor from public.qorpera_computer_clock_segments where permit_id=p_permit_id;
    if p_pair_valid then
        if not found then
            -- Upgrade an existing permit at its previous real endpoint. Never
            -- recalculate or rewrite an earlier checkpoint or settlement.
            insert into public.qorpera_computer_clock_segments values(p_permit_id,
                (p_previous->>'hostUptimeMs')::bigint,(p_previous->>'guestUptimeMs')::bigint,
                (p_previous->>'observationId')::uuid) returning * into anchor;
        end if;
        valid:=abs(((p_sample->>'guestUptimeMs')::bigint-anchor.guest_uptime_ms)
            -((p_sample->>'hostUptimeMs')::bigint-anchor.host_uptime_ms))<=1000;
    end if;
    if not valid then
        if p_sample->>'state'='running' then
            insert into public.qorpera_computer_clock_segments values(p_permit_id,
                (p_sample->>'hostUptimeMs')::bigint,(p_sample->>'guestUptimeMs')::bigint,
                (p_sample->>'observationId')::uuid)
            on conflict(permit_id) do update set host_uptime_ms=excluded.host_uptime_ms,
                guest_uptime_ms=excluded.guest_uptime_ms,observation_id=excluded.observation_id;
        else
            delete from public.qorpera_computer_clock_segments where permit_id=p_permit_id;
        end if;
    end if;
    return valid;
end $$;

create function public.qorpera_computer_sample_ready(p_permit_id uuid,p_sample jsonb)
returns boolean language sql stable security definer set search_path='' as $$
    select p_sample->>'state'='running' and exists(select 1
        from public.qorpera_coding_computer_permits p
        join public.qorpera_coding_computer_samples s on s.permit_id=p.id
        where p.id=p_permit_id and p.last_sample=p_sample and s.sample=p_sample
            and s.observation_id=(p_sample->>'observationId')::uuid and s.coverage in ('initial','continuous'))
$$;
revoke all on function public.qorpera_computer_clock_segment(uuid,jsonb,jsonb,boolean),
    public.qorpera_computer_sample_ready(uuid,jsonb) from public,anon,authenticated,service_role,qorpera_secret_broker;

create function pg_temp.clock_segment_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare definition text:=pg_get_functiondef(p_target);
begin
    if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Reviewed clock segment source changed: %',p_target; end if;
    execute replace(definition,p_old,p_new);
end $$;
select pg_temp.clock_segment_patch('public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean)',
    'and v_guest_delta>=0 and abs(v_guest_delta-v_host_delta)<=1000',
    'and v_host_delta>0 and v_guest_delta>0 and abs(v_guest_delta-v_host_delta)<=1000');
select pg_temp.clock_segment_patch('public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean)',
    'v_delta:=least(v_guest_delta,v_host_delta); v_coverage:=''continuous'';',
    'v_delta:=v_host_delta; v_coverage:=''continuous'';');
select pg_temp.clock_segment_patch('public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean)',
    '    v_sequence:=s.last_sequence+1;',
    $new$    if not public.qorpera_computer_clock_segment(p.id,p.last_sample,p_sample,v_coverage='continuous') then
        v_delta:=0;
        if v_coverage='continuous' then v_coverage:='gap'; end if;
    end if;
    v_sequence:=s.last_sequence+1;$new$);

do $$ declare target regprocedure; anchor text; begin
    foreach target in array array['public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_renew_runtime_computer_permit(jsonb,text)'::regprocedure] loop
        anchor:='    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->''sample'',false);';
        perform pg_temp.clock_segment_patch(target,anchor,anchor||$new$
    if not public.qorpera_computer_sample_ready(p.id,p_request->'sample') then
        raise exception 'Confirmed continuous clock required for renewal' using errcode='55000'; end if;$new$);
    end loop;
end $$;
select pg_temp.clock_segment_patch('public.qorpera_native_computer_permit_ready(uuid,uuid)',
    'and p.last_sample->>''state''=''running''',
    'and public.qorpera_computer_sample_ready(p.id,p.last_sample)');
select pg_temp.clock_segment_patch('public.qorpera_check_office_outage_running(public.qorpera_runtime_office_outage_recoveries,jsonb)',
    'or p.last_sample->>''state'' is distinct from ''running''',
    'or not public.qorpera_computer_sample_ready(p.id,p.last_sample)');

-- Retain split trusted SECURITY DEFINER ownership without exposing helpers or
-- anchor rows to guests, the shared runtime credential, or the secret broker.
do $$ declare caller regprocedure; helper regprocedure; owner_name name; begin
    for caller,helper in select * from (values
        ('public.qorpera_apply_computer_sample_before_guard(uuid,bigint,jsonb,boolean)'::regprocedure,
            'public.qorpera_computer_clock_segment(uuid,jsonb,jsonb,boolean)'::regprocedure),
        ('public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_sample_ready(uuid,jsonb)'::regprocedure),
        ('public.qorpera_renew_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_sample_ready(uuid,jsonb)'::regprocedure),
        ('public.qorpera_native_computer_permit_ready(uuid,uuid)'::regprocedure,'public.qorpera_computer_sample_ready(uuid,jsonb)'::regprocedure),
        ('public.qorpera_check_office_outage_running(public.qorpera_runtime_office_outage_recoveries,jsonb)'::regprocedure,
            'public.qorpera_computer_sample_ready(uuid,jsonb)'::regprocedure)
    ) edge(caller,helper) loop
        select pg_get_userbyid(proowner) into strict owner_name from pg_proc where oid=caller and prosecdef;
        if owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Trusted clock caller required'; end if;
        execute format('grant execute on function %s to %I',helper,owner_name);
    end loop;
end $$;
