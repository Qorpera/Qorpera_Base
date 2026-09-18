-- Read-only screen discovery and usage. Retained provider stop acknowledgement
-- proves absence by that time; it does not invent a missing guest close event.
create index qorpera_runtime_screen_lifetimes_by_activation
 on public.qorpera_runtime_screen_lifetimes(activation_id,id);
create index qorpera_runtime_screen_events_by_time
 on public.qorpera_runtime_screen_events(lifetime_id,((event->>'observedAt')),sequence);

create function public.qorpera_runtime_screen_termination(p_lifetime_id uuid)
returns jsonb language sql stable set search_path = '' as $$
 select jsonb_build_object('source','office_service_stop','transitionId',t.id,
  'inspectionId',s.challenge_id,'confirmedGoneAt',s.acknowledged_at,
  'action',t.request->'action','exactScreenCloseTime',false)
 from public.qorpera_runtime_screen_lifetimes l
 join public.qorpera_runtime_office_lifecycle_transitions t on t.activation_id=l.activation_id
  and t.office_id=l.office_id and t.request->'startup'=l.startup
 join public.qorpera_runtime_office_stops s on s.transition_id=t.id
 where l.id=p_lifetime_id
$$;

create function public.qorpera_runtime_screen_lifetimes(p_allocation_id uuid,p_after_lifetime_id uuid,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_lifetimes jsonb; v_has_more boolean;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen discovery requires operator authority' using errcode='42501'; end if;
 if p_allocation_id is null or p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'Invalid screen discovery window' using errcode='22023'; end if;
 if not exists(select 1 from public.qorpera_runtime_machine_allocations where id=p_allocation_id) then
  raise exception 'Screen allocation is unavailable' using errcode='22023'; end if;
 with selected as materialized (
  select l.* from public.qorpera_runtime_office_activations a
  join public.qorpera_runtime_screen_lifetimes l on l.activation_id=a.activation_id
  where a.allocation_id=p_allocation_id and (p_after_lifetime_id is null or l.id>p_after_lifetime_id)
  order by l.id limit p_limit+1
 ), page as (select * from selected order by id limit p_limit)
 select coalesce(jsonb_agg(jsonb_build_object('lifetimeId',l.id,'activationId',l.activation_id,
   'startup',l.startup,'binding',l.binding,'kind',l.kind,'recordedState',l.state,'lastSequence',l.sequence,
   'requestedAt',e.event->'observedAt','lastObservedAt',l.observed_at,'guestClosedAt',l.closed_at,
   'termination',public.qorpera_runtime_screen_termination(l.id)) order by l.id),'[]'),
  (select count(*)>p_limit from selected)
 into v_lifetimes,v_has_more from page l
 join public.qorpera_runtime_screen_events e on e.lifetime_id=l.id and e.sequence=1;
 return jsonb_build_object('schema','qorpera.runtime-screen-lifetimes/v1','allocationId',p_allocation_id,
  'observedAt',statement_timestamp(),'coverage','registered_lifetimes_only','snapshotAcrossPages',false,
  'lifetimes',v_lifetimes,'hasMore',v_has_more,
  'nextLifetimeId',case when v_has_more then v_lifetimes->-1->'lifetimeId' else null end);
end
$$;

create function public.qorpera_runtime_screen_history(p_lifetime_id uuid,p_from timestamptz,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_life public.qorpera_runtime_screen_lifetimes%rowtype; v_requested timestamptz;
 v_from timestamptz; v_until timestamptz; v_termination jsonb; v_count bigint;
 v_intervals jsonb:='[]'; v_usage jsonb; v_result jsonb; v_lower text; v_upper text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen history requires operator authority' using errcode='42501'; end if;
 if p_lifetime_id is null or p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
  or p_from>=p_until or p_until-p_from>interval '24 hours' or p_until>statement_timestamp() then
  raise exception 'Screen history requires a finite past window of at most 24 hours' using errcode='22023'; end if;
 select * into v_life from public.qorpera_runtime_screen_lifetimes where id=p_lifetime_id;
 if not found then raise exception 'Screen lifetime is unavailable' using errcode='22023'; end if;
 select (event->>'observedAt')::timestamptz into strict v_requested
  from public.qorpera_runtime_screen_events where lifetime_id=p_lifetime_id and sequence=1;
 v_termination:=public.qorpera_runtime_screen_termination(p_lifetime_id);
 v_from:=greatest(p_from,v_requested);
 v_until:=least(p_until,coalesce(v_life.closed_at,p_until),coalesce((v_termination->>'confirmedGoneAt')::timestamptz,p_until));
 if v_from<v_until then
  -- Indexed whole-second prefix bounds overselect the boundary seconds.
  -- Exact decisions still use timestamps: optional fractional precision means
  -- lexicographic ordering alone is not chronological within one second.
  v_lower:=to_char((v_from-interval '15 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS');
  v_upper:=to_char((v_until+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS');
  select count(*) into v_count from (select 1 from public.qorpera_runtime_screen_events
   where lifetime_id=p_lifetime_id and event->>'observedAt'>=v_lower and event->>'observedAt'<v_upper
    and (event->>'observedAt')::timestamptz>=v_from-interval '15 seconds'
    and (event->>'observedAt')::timestamptz<v_until limit 20001) e;
  if v_count>20000 then raise exception 'Screen history window has too many observations' using errcode='54000'; end if;
  with samples as materialized (
   select (event->>'observedAt')::timestamptz at,event_id,sequence,event->>'state' state,event->>'reason' reason
   from public.qorpera_runtime_screen_events where lifetime_id=p_lifetime_id
    and event->>'observedAt'>=v_lower and event->>'observedAt'<v_upper
    and (event->>'observedAt')::timestamptz>=v_from-interval '15 seconds'
    and (event->>'observedAt')::timestamptz<v_until
  ), ordered as (
   select *,lead(at,1,v_until) over(order by at,sequence) next_at from samples
  ), pieces as (
   select greatest(v_from,at) starts_at,least(v_until,next_at,at+interval '15 seconds') ends_at,
    state,reason,event_id from ordered
   union all
   select greatest(v_from,at+interval '15 seconds'),least(v_until,next_at),'unknown','SCREEN_OBSERVATION_STALE',null
    from ordered where at+interval '15 seconds'<least(v_until,next_at)
   union all
   select v_from,least(v_until,coalesce((select min(at) from samples),v_until)),'unknown','SCREEN_OBSERVATION_MISSING',null
  ), valid as (select * from pieces where starts_at<ends_at), boundaries as (
   select *,case when row(state,reason) is distinct from row(lag(state) over w,lag(reason) over w) then 1 else 0 end boundary
   from valid window w as (order by starts_at)
  ), numbered as (
   select *,sum(boundary) over(order by starts_at) segment from boundaries
  ), merged as (
   select min(starts_at) starts_at,max(ends_at) ends_at,state,reason,
    (array_agg(event_id order by starts_at))[1] first_event_id,
    (array_agg(event_id order by starts_at desc))[1] last_event_id
   from numbered group by segment,state,reason
  ) select coalesce(jsonb_agg(jsonb_build_object('from',starts_at,'until',ends_at,'state',state,'reason',reason,
    'firstEventId',first_event_id,'lastEventId',last_event_id,'seconds',extract(epoch from ends_at-starts_at)) order by starts_at),'[]')
   into v_intervals from merged;
 end if;
 select jsonb_build_object('observedLifetimeHours',coalesce(sum((i->>'seconds')::numeric),0)/3600,
  'estimatedReadyScreenHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='ready'),0)/3600,
  'requestedScreenHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='requested'),0)/3600,
  'closingScreenHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='closing'),0)/3600,
  'failedScreenHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='failed'),0)/3600,
  'unknownScreenHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='unknown'),0)/3600)
 into v_usage from jsonb_array_elements(v_intervals) i;
 v_result:=jsonb_build_object('schema','qorpera.runtime-screen-history/v1','lifetimeId',v_life.id,
  'activationId',v_life.activation_id,'startup',v_life.startup,'binding',v_life.binding,'kind',v_life.kind,
  'from',p_from,'until',p_until,'requestedAt',v_requested,'guestClosedAt',v_life.closed_at,'termination',v_termination,
  'coverage','registered_lifetime_only','method','guest_screen_heartbeat_hold','maximumSampleHoldSeconds',15,
  'exactTransitionTimes',false,'usage',v_usage,'intervals',v_intervals);
 if octet_length(v_result::text)>4194304 then raise exception 'Screen history response requires a smaller window' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_runtime_screen_termination(uuid),public.qorpera_runtime_screen_lifetimes(uuid,uuid,integer),
 public.qorpera_runtime_screen_history(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_screen_lifetimes(uuid,uuid,integer),
 public.qorpera_runtime_screen_history(uuid,timestamptz,timestamptz) to service_role;
