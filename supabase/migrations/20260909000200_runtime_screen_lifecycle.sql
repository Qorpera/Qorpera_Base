-- Physical screen evidence is separate from desired power and driver leases.
-- A lifetime belongs to one admitted guest invocation, including private
-- sign-in surfaces. Publication grants no input or physical dispatch authority.
create table public.qorpera_runtime_screen_lifetimes (
 id uuid primary key,
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
 screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete restrict,
 startup jsonb not null,
 binding jsonb not null,
 privacy_challenge jsonb not null,
 kind text not null check(kind in ('shared','private')),
 state text not null check(state in ('requested','ready','closing','closed','failed')),
 sequence bigint not null check(sequence between 1 and 9007199254740991),
 observed_at timestamptz not null check(isfinite(observed_at)),
 closed_at timestamptz,
 check((state='closed')=(closed_at is not null))
);
create unique index qorpera_one_physical_screen_per_invocation
 on public.qorpera_runtime_screen_lifetimes(activation_id,screen_id) where closed_at is null;
create table public.qorpera_runtime_screen_events (
 event_id uuid primary key,
 lifetime_id uuid not null references public.qorpera_runtime_screen_lifetimes(id) on delete restrict,
 sequence bigint not null,
 event jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(lifetime_id,sequence)
);

create function public.qorpera_runtime_screen_event_result(p_value public.qorpera_runtime_screen_events)
returns jsonb language sql immutable set search_path = '' as $$
 select jsonb_build_object('schema','qorpera.runtime-screen-event-receipt/v1','lifetimeId',p_value.lifetime_id,
  'eventId',p_value.event_id,'sequence',p_value.sequence,'state',p_value.event->'state',
  'observedAt',p_value.event->'observedAt','recordedAt',p_value.recorded_at)
$$;

create function public.qorpera_record_runtime_screen_event(p_startup jsonb,p_binding jsonb,p_privacy jsonb,p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_life public.qorpera_runtime_screen_lifetimes%rowtype; v_previous public.qorpera_runtime_screen_events%rowtype;
 v_activation public.qorpera_runtime_office_activations%rowtype; v_office public.qorpera_runtime_offices%rowtype;
 v_id uuid; v_event_id uuid; v_sequence bigint; v_at timestamptz; v_state text; v_reason text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen observer authority required' using errcode='42501'; end if;
 if jsonb_typeof(p_startup) is distinct from 'object' or octet_length(p_startup::text)>4096
  or jsonb_typeof(p_binding) is distinct from 'object' or octet_length(p_binding::text)>4096
  or p_privacy is null or jsonb_typeof(p_privacy) not in ('object','null') or octet_length(p_privacy::text)>65536
  or jsonb_typeof(p_event) is distinct from 'object'
  or p_event-array['lifetimeId','eventId','sequence','observedAt','state','reason']<>'{}'::jsonb
  or not(p_event ?& array['lifetimeId','eventId','sequence','observedAt','state','reason'])
  or octet_length(p_event::text)>1024
  or coalesce(p_event->>'lifetimeId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or coalesce(p_event->>'eventId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or jsonb_typeof(p_event->'sequence') is distinct from 'number' or coalesce(p_event->>'sequence','') !~ '^[1-9][0-9]{0,15}$'
  or (p_event->>'sequence')::numeric>9007199254740991
  or coalesce(p_event->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then
  raise exception 'Invalid screen lifecycle event' using errcode='22023'; end if;
 v_id:=(p_event->>'lifetimeId')::uuid; v_event_id:=(p_event->>'eventId')::uuid;
 v_sequence:=(p_event->>'sequence')::bigint; v_at:=(p_event->>'observedAt')::timestamptz;
 v_state:=p_event->>'state'; v_reason:=p_event->>'reason';
 if not isfinite(v_at) or not coalesce(
  (v_state='requested' and v_reason='SCREEN_REQUESTED')
  or (v_state='ready' and v_reason in ('DESKTOP_READY','SCREEN_HEARTBEAT'))
  or (v_state='closing' and v_reason in ('SCREEN_DRAIN_REQUESTED','OFFICE_SERVICE_STOPPING','PRIVACY_FENCE','AUTHORITY_LOST'))
  or (v_state='closed' and v_reason='DESKTOP_REAPED')
  or (v_state='failed' and v_reason in ('DESKTOP_START_FAILED','DESKTOP_EXITED','DESKTOP_DRAIN_UNCONFIRMED','SERVICE_INTERRUPTED')),false)
  then raise exception 'Invalid screen lifecycle state or reason' using errcode='22023'; end if;
 -- Exact replay retains the original acknowledgement even after revocation,
 -- a successor activation, closure, or a long registry outage.
 select * into v_previous from public.qorpera_runtime_screen_events where event_id=v_event_id;
 if found then
  select * into strict v_life from public.qorpera_runtime_screen_lifetimes where id=v_previous.lifetime_id;
  if v_previous.event<>p_event or v_life.startup<>p_startup or v_life.binding<>p_binding or v_life.privacy_challenge<>p_privacy then
   raise exception 'Screen event identity changed' using errcode='42501'; end if;
  return public.qorpera_runtime_screen_event_result(v_previous);
 end if;
 select * into v_life from public.qorpera_runtime_screen_lifetimes where id=v_id;
 if v_life.id is not null and (v_life.startup<>p_startup or v_life.binding<>p_binding or v_life.privacy_challenge<>p_privacy) then
  raise exception 'Screen lifetime binding changed' using errcode='42501'; end if;
 if v_state in ('requested','ready') then
  v_activation:=public.qorpera_lock_runtime_office_startup(p_startup);
  if v_activation.state<>'active' or v_activation.service_invocation_id is distinct from p_startup->>'serviceInvocationId' then
   raise exception 'Screen lifetime requires an active invocation' using errcode='42501'; end if;
  if p_privacy='null'::jsonb then perform public.qorpera_check_runtime_office_shared_surface(p_binding);
  else
   perform public.qorpera_check_runtime_office_private_surface(p_privacy);
   if p_binding->>'screenId' is distinct from p_privacy->>'screenId'
    or not exists(select 1 from jsonb_array_elements(p_privacy->'drains') d where d->'binding'=p_binding) then
    raise exception 'Private screen binding differs' using errcode='42501'; end if;
  end if;
  if (p_binding-array['screenId','screenOrdinal','screenGeneration','staffAgentId']) is distinct from
   (p_startup->'scope')||jsonb_build_object('computerGeneration',p_startup->'computerGeneration') then
   raise exception 'Screen belongs to another invocation scope' using errcode='42501'; end if;
 else
  if v_life.id is null then raise exception 'Screen cleanup requires retained lifetime' using errcode='42501'; end if;
  -- Cleanup preserves the original invocation after current authority is
  -- revoked. Take the common profile -> office -> lifetime lock order.
  select * into strict v_office from public.qorpera_runtime_offices where id=v_life.office_id;
  perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
  perform 1 from public.qorpera_runtime_offices where id=v_life.office_id for update;
 end if;
 select * into v_life from public.qorpera_runtime_screen_lifetimes where id=v_id for update;
 -- The office lock also serializes competing first events. Recheck replay
 -- after waiting: concurrent identical delivery must return the same receipt.
 select * into v_previous from public.qorpera_runtime_screen_events where event_id=v_event_id;
 if found then
  if v_previous.event<>p_event or v_previous.lifetime_id<>v_id or v_life.startup<>p_startup
   or v_life.binding<>p_binding or v_life.privacy_challenge<>p_privacy then
   raise exception 'Screen event identity changed' using errcode='42501'; end if;
  return public.qorpera_runtime_screen_event_result(v_previous);
 end if;
 if v_at>clock_timestamp()+interval '2 seconds' then raise exception 'Screen observation is in the future' using errcode='22023'; end if;
 if v_life.id is null then
  if v_state<>'requested' or v_sequence<>1 or v_at<clock_timestamp()-interval '60 seconds'
   or v_at<v_activation.activated_at-interval '2 seconds' then
   raise exception 'Screen lifetime must begin with a current request' using errcode='42501'; end if;
  insert into public.qorpera_runtime_screen_lifetimes(id,activation_id,office_id,screen_id,startup,binding,privacy_challenge,kind,state,sequence,observed_at)
   values(v_id,v_activation.activation_id,v_activation.office_id,(p_binding->>'screenId')::uuid,p_startup,p_binding,p_privacy,
    case when p_privacy='null'::jsonb then 'shared' else 'private' end,v_state,v_sequence,v_at);
 else
  if v_life.startup<>p_startup or v_life.binding<>p_binding or v_life.privacy_challenge<>p_privacy
   or v_sequence<>v_life.sequence+1 or v_at<v_life.observed_at or v_life.state='closed'
   or not coalesce((v_state='ready' and ((v_life.state='requested' and v_reason='DESKTOP_READY')
      or (v_life.state='ready' and v_reason='SCREEN_HEARTBEAT')))
    or (v_state='closing' and v_life.state in ('requested','ready','failed'))
    or (v_state='failed' and v_life.state in ('requested','ready','closing'))
    or (v_state='closed' and v_life.state in ('closing','failed')),false) then
   raise exception 'Screen lifecycle sequence or transition differs' using errcode='42501'; end if;
  update public.qorpera_runtime_screen_lifetimes set state=v_state,sequence=v_sequence,observed_at=v_at,
   closed_at=case when v_state='closed' then v_at else null end where id=v_id;
 end if;
 insert into public.qorpera_runtime_screen_events(event_id,lifetime_id,sequence,event) values(v_event_id,v_id,v_sequence,p_event)
  returning * into v_previous;
 return public.qorpera_runtime_screen_event_result(v_previous);
end
$$;

create function public.qorpera_runtime_screen_events(p_lifetime_id uuid,p_after_sequence bigint,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_life public.qorpera_runtime_screen_lifetimes%rowtype; v_events jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen history requires operator authority' using errcode='42501'; end if;
 if p_lifetime_id is null or p_after_sequence is null or p_after_sequence not between 0 and 9007199254740991
  or p_limit is null or p_limit not between 1 and 1000 then raise exception 'Invalid screen history window' using errcode='22023'; end if;
 select * into v_life from public.qorpera_runtime_screen_lifetimes where id=p_lifetime_id;
 if not found then raise exception 'Screen lifetime is unavailable' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('event',e.event,'recordedAt',e.recorded_at) order by e.sequence),'[]') into v_events
  from (select * from public.qorpera_runtime_screen_events where lifetime_id=p_lifetime_id and sequence>p_after_sequence order by sequence limit p_limit) e;
 return jsonb_build_object('schema','qorpera.runtime-screen-events/v1','lifetimeId',p_lifetime_id,'activationId',v_life.activation_id,
  'startup',v_life.startup,'binding',v_life.binding,'kind',v_life.kind,'state',v_life.state,'lastSequence',v_life.sequence,
  'closedAt',v_life.closed_at,'events',v_events,'nextSequence',coalesce((v_events->-1#>>'{event,sequence}')::bigint,p_after_sequence));
end
$$;
alter table public.qorpera_runtime_screen_lifetimes enable row level security;
alter table public.qorpera_runtime_screen_events enable row level security;
revoke all on public.qorpera_runtime_screen_lifetimes,public.qorpera_runtime_screen_events from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_screen_event_result(public.qorpera_runtime_screen_events),
 public.qorpera_record_runtime_screen_event(jsonb,jsonb,jsonb,jsonb),public.qorpera_runtime_screen_events(uuid,bigint,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.qorpera_record_runtime_screen_event(jsonb,jsonb,jsonb,jsonb),
 public.qorpera_runtime_screen_events(uuid,bigint,integer) to service_role;
