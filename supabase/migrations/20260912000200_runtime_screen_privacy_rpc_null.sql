-- Normalize the public RPC boundary without reclassifying retained history.
create or replace function public.qorpera_record_runtime_screen_event(p_startup jsonb,p_binding jsonb,p_privacy jsonb,p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_life public.qorpera_runtime_screen_lifetimes%rowtype; v_previous public.qorpera_runtime_screen_events%rowtype;
 v_activation public.qorpera_runtime_office_activations%rowtype; v_office public.qorpera_runtime_offices%rowtype;
 v_id uuid; v_event_id uuid; v_sequence bigint; v_at timestamptz; v_state text; v_reason text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen observer authority required' using errcode='42501'; end if;
 -- PostgREST maps a top-level JSON null argument to SQL NULL. Store the
 -- existing JSONB null sentinel after normalization; keep all scope, private
 -- surface, event identity, sequence and authority checks unchanged.
 p_privacy:=coalesce(p_privacy,'null'::jsonb);
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
