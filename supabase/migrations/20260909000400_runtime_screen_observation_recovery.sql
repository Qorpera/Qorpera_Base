-- Delayed diagnostic custody is not work authority or confirmed screen usage.
-- Retain original closed metadata after its invocation is revoked/superseded,
-- without modifying the authority-checked prefix in runtime_screen_events.
create table public.qorpera_runtime_screen_observations (
 event_id uuid primary key,
 lifetime_id uuid not null,
 sequence bigint not null check(sequence between 1 and 9007199254740991),
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
 screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete restrict,
 observation jsonb not null,
 record_sha256 text not null check(record_sha256 ~ '^[0-9a-f]{64}$'),
 retained_at timestamptz not null default clock_timestamp(),
 unique(lifetime_id,sequence)
);
create index qorpera_screen_observations_activation on public.qorpera_runtime_screen_observations(activation_id,lifetime_id,sequence);

create function public.qorpera_screen_metadata_object(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(p_value)='object' and p_value-p_keys='{}'::jsonb and p_value ?& p_keys,false)
$$;
create function public.qorpera_screen_metadata_uuid(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(p_value)='string' and p_value#>>'{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
$$;
create function public.qorpera_screen_metadata_positive(p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'number' or coalesce(p_value#>>'{}','') !~ '^[1-9][0-9]{0,15}$' then return false; end if;
 return (p_value#>>'{}')::numeric<=9007199254740991;
end $$;
create function public.qorpera_assert_screen_observation_binding(p_binding jsonb,p_scope jsonb,p_generation jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
 if not public.qorpera_screen_metadata_object(p_binding,array['companyId','environmentId','companyComputerId','logicalComputerId',
  'computerGeneration','screenId','screenOrdinal','screenGeneration','staffAgentId'])
  or (p_binding-array['computerGeneration','screenId','screenOrdinal','screenGeneration','staffAgentId']) is distinct from p_scope
  or p_binding->'computerGeneration' is distinct from p_generation
  or not public.qorpera_screen_metadata_uuid(p_binding->'screenId') or not public.qorpera_screen_metadata_uuid(p_binding->'staffAgentId')
  or not public.qorpera_screen_metadata_positive(p_binding->'screenOrdinal')
  or not public.qorpera_screen_metadata_positive(p_binding->'screenGeneration') then
  raise exception 'Invalid retained screen binding' using errcode='22023'; end if;
 if (p_binding->>'screenOrdinal')::numeric>32 then raise exception 'Invalid retained screen ordinal' using errcode='22023'; end if;
end $$;
create function public.qorpera_assert_screen_observation(p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare s jsonb:=p_value->'startup'; b jsonb:=p_value->'binding'; p jsonb:=p_value->'privacy'; e jsonb:=p_value->'event';
 k text; d jsonb; v_at timestamptz; v_screens jsonb:='[]'; v_ordinals jsonb:='[]'; v_drains jsonb:='[]';
begin
 if not public.qorpera_screen_metadata_object(p_value,array['schema','startup','binding','privacy','event'])
  or p_value->>'schema' is distinct from 'qorpera.runtime-screen-observation/v1'
  or not public.qorpera_screen_metadata_object(s,array['scope','computerGeneration','allocationId','instanceSha256','imageSha256',
   'bootstrapSha256','bootId','configurationSha256','serviceInvocationId'])
  or not public.qorpera_screen_metadata_object(s->'scope',array['companyId','environmentId','companyComputerId','logicalComputerId'])
  or not public.qorpera_screen_metadata_positive(s->'computerGeneration') then
  raise exception 'Invalid retained screen identity' using errcode='22023'; end if;
 foreach k in array array['companyId','environmentId','companyComputerId','logicalComputerId'] loop
  if not public.qorpera_screen_metadata_uuid(s->'scope'->k) then raise exception 'Invalid retained screen scope' using errcode='22023'; end if;
 end loop;
 foreach k in array array['allocationId','bootId'] loop
  if not public.qorpera_screen_metadata_uuid(s->k) then raise exception 'Invalid retained startup identity' using errcode='22023'; end if;
 end loop;
 foreach k in array array['instanceSha256','imageSha256','bootstrapSha256','configurationSha256'] loop
  if jsonb_typeof(s->k) is distinct from 'string' or coalesce(s->>k,'') !~ '^[0-9a-f]{64}$' then
   raise exception 'Invalid retained startup digest' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(s->'serviceInvocationId') is distinct from 'string'
  or coalesce(s->>'serviceInvocationId','') !~ '^[0-9a-f]{32}$' or s->>'serviceInvocationId'=repeat('0',32) then
  raise exception 'Invalid retained invocation' using errcode='22023'; end if;
 perform public.qorpera_assert_screen_observation_binding(b,s->'scope',s->'computerGeneration');
 if p is distinct from 'null'::jsonb then
  if not public.qorpera_screen_metadata_object(p,array['scope','computerGeneration','challengeId','version','state','memberId','profileId','profileVersion','screenId','drains'])
   or p->'scope' is distinct from s->'scope' or p->'computerGeneration' is distinct from s->'computerGeneration'
   or coalesce(p->>'state','') not in ('entering','leaving') or p->'screenId' is distinct from b->'screenId'
   or not public.qorpera_screen_metadata_positive(p->'version') or not public.qorpera_screen_metadata_positive(p->'profileVersion')
   or jsonb_typeof(p->'drains') is distinct from 'array' then
   raise exception 'Invalid retained private metadata' using errcode='22023'; end if;
  if jsonb_array_length(p->'drains') not between 1 and 32 then raise exception 'Invalid retained private drains' using errcode='22023'; end if;
  foreach k in array array['challengeId','memberId','profileId','screenId'] loop
   if not public.qorpera_screen_metadata_uuid(p->k) then raise exception 'Invalid retained private identity' using errcode='22023'; end if;
  end loop;
  for d in select value from jsonb_array_elements(p->'drains') loop
   if not public.qorpera_screen_metadata_object(d,array['state','drainId','epoch','binding'])
    or d->>'state' is distinct from 'draining' or not public.qorpera_screen_metadata_uuid(d->'drainId')
    or not public.qorpera_screen_metadata_positive(d->'epoch') then
    raise exception 'Invalid retained private drain' using errcode='22023'; end if;
   perform public.qorpera_assert_screen_observation_binding(d->'binding',s->'scope',s->'computerGeneration');
   if v_screens @> jsonb_build_array(d#>'{binding,screenId}') or v_ordinals @> jsonb_build_array(d#>'{binding,screenOrdinal}')
    or v_drains @> jsonb_build_array(d->'drainId') then raise exception 'Duplicate retained private drain' using errcode='22023'; end if;
   v_screens:=v_screens||jsonb_build_array(d#>'{binding,screenId}');v_ordinals:=v_ordinals||jsonb_build_array(d#>'{binding,screenOrdinal}');
   v_drains:=v_drains||jsonb_build_array(d->'drainId');
  end loop;
  if not exists(select 1 from jsonb_array_elements(p->'drains') x where x->'binding'=b) then
   raise exception 'Retained private screen differs' using errcode='22023'; end if;
 end if;
 if not public.qorpera_screen_metadata_object(e,array['lifetimeId','eventId','sequence','observedAt','state','reason'])
  or not public.qorpera_screen_metadata_uuid(e->'lifetimeId') or not public.qorpera_screen_metadata_uuid(e->'eventId')
  or not public.qorpera_screen_metadata_positive(e->'sequence') or jsonb_typeof(e->'observedAt') is distinct from 'string'
  or coalesce(e->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or not coalesce((e->>'state'='requested' and e->>'reason'='SCREEN_REQUESTED')
   or (e->>'state'='ready' and e->>'reason' in ('DESKTOP_READY','SCREEN_HEARTBEAT'))
   or (e->>'state'='closing' and e->>'reason' in ('SCREEN_DRAIN_REQUESTED','OFFICE_SERVICE_STOPPING','PRIVACY_FENCE','AUTHORITY_LOST'))
   or (e->>'state'='failed' and e->>'reason' in ('DESKTOP_START_FAILED','DESKTOP_EXITED','DESKTOP_DRAIN_UNCONFIRMED','SERVICE_INTERRUPTED'))
   or (e->>'state'='closed' and e->>'reason'='DESKTOP_REAPED'),false) then
  raise exception 'Invalid retained screen event' using errcode='22023'; end if;
 v_at:=(e->>'observedAt')::timestamptz;
 if not isfinite(v_at) or to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>e->>'observedAt' then
  raise exception 'Invalid retained screen time' using errcode='22023'; end if;
end $$;

create function public.qorpera_runtime_screen_observation_receipt(p_value public.qorpera_runtime_screen_observations)
returns jsonb language sql immutable set search_path = '' as $$
 select jsonb_build_object('schema','qorpera.runtime-screen-retention-receipt/v1','confirmation','unconfirmed',
  'lifetimeId',p_value.lifetime_id,'eventId',p_value.event_id,'sequence',p_value.sequence,
  'observedAt',p_value.observation#>'{event,observedAt}','state',p_value.observation#>'{event,state}',
  'observationSha256',p_value.record_sha256,'retainedAt',p_value.retained_at)
$$;

create function public.qorpera_retain_runtime_screen_observation(p_record text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; s jsonb; b jsonb; p jsonb; e jsonb; v_sha text;
 a public.qorpera_runtime_office_activations%rowtype; o public.qorpera_runtime_offices%rowtype;
 c public.qorpera_runtime_screen_events%rowtype; l public.qorpera_runtime_screen_lifetimes%rowtype;
 r public.qorpera_runtime_screen_observations%rowtype; last_observation jsonb; last_event jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen retention requires observer authority' using errcode='42501'; end if;
 if p_record is null or octet_length(p_record) not between 1 and 73729 then raise exception 'Invalid screen retention size' using errcode='22023'; end if;
 v:=p_record::jsonb;perform public.qorpera_assert_screen_observation(v);
 s:=v->'startup';b:=v->'binding';p:=v->'privacy';e:=v->'event';
 v_sha:=encode(extensions.digest(convert_to(p_record,'UTF8'),'sha256'),'hex');
 -- Historical invocation matching intentionally does not re-open admission.
 select * into a from public.qorpera_runtime_office_activations
  where allocation_id=(s->>'allocationId')::uuid and service_invocation_id=s->>'serviceInvocationId' and activated_at is not null;
 if not found then raise exception 'Retained invocation unavailable' using errcode='42501'; end if;
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 if s is distinct from jsonb_build_object('scope',public.qorpera_runtime_office_scope(o),'computerGeneration',a.computer_generation,
  'allocationId',a.allocation_id,'instanceSha256',a.instance_sha256,'imageSha256',a.image_sha256,'bootstrapSha256',a.bootstrap_sha256,
  'bootId',a.attestation->'bootId','configurationSha256',a.attestation->'configurationSha256','serviceInvocationId',a.service_invocation_id)
  or not exists(select 1 from public.qorpera_runtime_office_screens where id=(b->>'screenId')::uuid and office_id=o.id) then
  raise exception 'Retained invocation binding differs' using errcode='42501'; end if;
 -- Same ordering as canonical screen publication. Immutable sequence custody
 -- is serialized with any late in-flight canonical commit for this office.
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 perform 1 from public.qorpera_runtime_offices where id=o.id for update;
 -- Two fixed namespaces with 256 buckets each bound lock memory even for
 -- large diagnostic batches. Hash collisions only serialize unrelated events.
 perform pg_advisory_xact_lock(177721,(hashtextextended(e->>'lifetimeId',0)&255)::integer);
 perform pg_advisory_xact_lock(177722,(hashtextextended(e->>'eventId',0)&255)::integer);
 select * into c from public.qorpera_runtime_screen_events where event_id=(e->>'eventId')::uuid;
 if found then
  select * into strict l from public.qorpera_runtime_screen_lifetimes where id=c.lifetime_id;
  if c.event<>e or l.startup<>s or l.binding<>b or l.privacy_challenge<>p then
   raise exception 'Retained canonical event differs' using errcode='42501'; end if;
  return public.qorpera_runtime_screen_event_result(c);
 end if;
 select * into r from public.qorpera_runtime_screen_observations where event_id=(e->>'eventId')::uuid;
 if found then
  if r.observation<>v or r.record_sha256<>v_sha then raise exception 'Retained observation changed' using errcode='42501'; end if;
  return public.qorpera_runtime_screen_observation_receipt(r);
 end if;
 select observation into last_observation from public.qorpera_runtime_screen_observations
  where lifetime_id=(e->>'lifetimeId')::uuid order by sequence desc limit 1;
 if last_observation is null then
  select * into l from public.qorpera_runtime_screen_lifetimes where id=(e->>'lifetimeId')::uuid;
  if found then
   select event into last_event from public.qorpera_runtime_screen_events where lifetime_id=l.id order by sequence desc limit 1;
   last_observation:=jsonb_build_object('schema',v->'schema','startup',l.startup,'binding',l.binding,'privacy',l.privacy_challenge,'event',last_event);
  end if;
 end if;
 if last_observation is null then
  if e->>'sequence'<>'1' or e->>'state'<>'requested' then raise exception 'Retained lifetime must begin with request' using errcode='42501'; end if;
 else
  last_event:=last_observation->'event';
  if last_observation-'event'<>v-'event' or (e->>'sequence')::bigint<>(last_event->>'sequence')::bigint+1
   or not coalesce((e->>'state'='ready' and ((last_event->>'state'='requested' and e->>'reason'='DESKTOP_READY')
     or (last_event->>'state'='ready' and e->>'reason'='SCREEN_HEARTBEAT')))
    or (e->>'state'='closing' and last_event->>'state' in ('requested','ready','failed'))
    or (e->>'state'='failed' and last_event->>'state' in ('requested','ready','closing'))
    or (e->>'state'='closed' and last_event->>'state' in ('closing','failed')),false) then
   raise exception 'Retained lifetime sequence or identity differs' using errcode='42501'; end if;
 end if;
 -- Clock-skewed observations are retained verbatim, never counted as usage.
 insert into public.qorpera_runtime_screen_observations(event_id,lifetime_id,sequence,activation_id,office_id,screen_id,observation,record_sha256)
  values((e->>'eventId')::uuid,(e->>'lifetimeId')::uuid,(e->>'sequence')::bigint,a.activation_id,o.id,(b->>'screenId')::uuid,v,v_sha) returning * into r;
 return public.qorpera_runtime_screen_observation_receipt(r);
end $$;

-- Once an uncertain suffix exists, late direct writes must not silently
-- promote it into authority-checked history. Exact earlier receipts still replay.
create function public.qorpera_guard_retained_screen_observation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(177721,(hashtextextended(new.lifetime_id::text,0)&255)::integer);
 perform pg_advisory_xact_lock(177722,(hashtextextended(new.event_id::text,0)&255)::integer);
 if exists(select 1 from public.qorpera_runtime_screen_observations where lifetime_id=new.lifetime_id or event_id=new.event_id) then
  raise exception 'Screen lifetime has retained unconfirmed observations' using errcode='42501'; end if;
 return new;
end $$;
create trigger qorpera_guard_retained_screen_observation before insert on public.qorpera_runtime_screen_events
 for each row execute function public.qorpera_guard_retained_screen_observation();

alter table public.qorpera_runtime_screen_observations enable row level security;
revoke all on public.qorpera_runtime_screen_observations from public,anon,authenticated,service_role;
revoke all on function public.qorpera_screen_metadata_object(jsonb,text[]),public.qorpera_screen_metadata_uuid(jsonb),
 public.qorpera_screen_metadata_positive(jsonb),public.qorpera_assert_screen_observation_binding(jsonb,jsonb,jsonb),
 public.qorpera_assert_screen_observation(jsonb),public.qorpera_runtime_screen_observation_receipt(public.qorpera_runtime_screen_observations),
 public.qorpera_retain_runtime_screen_observation(text),public.qorpera_guard_retained_screen_observation() from public,anon,authenticated,service_role;
grant execute on function public.qorpera_retain_runtime_screen_observation(text) to service_role;

create function public.qorpera_runtime_screen_observation_events(p_lifetime_id uuid,p_after_sequence bigint,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare l public.qorpera_runtime_screen_lifetimes%rowtype; first_raw public.qorpera_runtime_screen_observations%rowtype;
 last_raw public.qorpera_runtime_screen_observations%rowtype; v_events jsonb; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen observations require operator authority' using errcode='42501'; end if;
 if p_lifetime_id is null or p_after_sequence is null or p_after_sequence not between 0 and 9007199254740991
  or p_limit is null or p_limit not between 1 and 1000 then raise exception 'Invalid screen observation page' using errcode='22023'; end if;
 select * into l from public.qorpera_runtime_screen_lifetimes where id=p_lifetime_id;
 select * into first_raw from public.qorpera_runtime_screen_observations where lifetime_id=p_lifetime_id order by sequence limit 1;
 select * into last_raw from public.qorpera_runtime_screen_observations where lifetime_id=p_lifetime_id order by sequence desc limit 1;
 if l.id is null and first_raw.event_id is null then raise exception 'Screen observations unavailable' using errcode='22023'; end if;
 select coalesce(jsonb_agg(x.item order by x.sequence),'[]') into v_events from (
  select sequence,item from (
   select sequence,jsonb_build_object('event',event,'confirmation','authority_checked','recordedAt',recorded_at) as item
    from public.qorpera_runtime_screen_events where lifetime_id=p_lifetime_id and sequence>p_after_sequence
   union all
   select sequence,jsonb_build_object('event',observation->'event','confirmation','unconfirmed','retainedAt',retained_at,
    'observationSha256',record_sha256) from public.qorpera_runtime_screen_observations where lifetime_id=p_lifetime_id and sequence>p_after_sequence
  ) all_events order by sequence limit p_limit
 ) x;
 v_result:=jsonb_build_object('schema','qorpera.runtime-screen-observations/v1','lifetimeId',p_lifetime_id,
  'activationId',coalesce(l.activation_id,first_raw.activation_id),'startup',coalesce(l.startup,first_raw.observation->'startup'),
  'binding',coalesce(l.binding,first_raw.observation->'binding'),
  'kind',coalesce(l.kind,case when first_raw.observation->'privacy'='null'::jsonb then 'shared' else 'private' end),
  'confirmation',case when first_raw.event_id is null then 'authority_checked' else 'unconfirmed_suffix' end,
  'canonicalState',l.state,'reportedState',coalesce(last_raw.observation#>>'{event,state}',l.state),
  'canonicalClosedAt',l.closed_at,'confirmedThroughSequence',coalesce(l.sequence,0),
  'firstUnconfirmedSequence',first_raw.sequence,'lastSequence',coalesce(last_raw.sequence,l.sequence),
  'usageIncludesUnconfirmed',false,'events',v_events,
  'nextSequence',coalesce((v_events->-1#>>'{event,sequence}')::bigint,p_after_sequence));
 if octet_length(v_result::text)>4194304 then raise exception 'Screen observation page too large' using errcode='22023'; end if;
 return v_result;
end $$;

create function public.qorpera_runtime_screen_observation_lifetimes(p_allocation_id uuid,p_after_lifetime_id uuid,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_more boolean; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Screen observation discovery requires operator authority' using errcode='42501'; end if;
 if p_allocation_id is null or p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'Invalid screen observation discovery page' using errcode='22023'; end if;
 with identities as (
  select l.id from public.qorpera_runtime_screen_lifetimes l join public.qorpera_runtime_office_activations a on a.activation_id=l.activation_id
   where a.allocation_id=p_allocation_id and (p_after_lifetime_id is null or l.id>p_after_lifetime_id)
  union
  select r.lifetime_id from public.qorpera_runtime_screen_observations r join public.qorpera_runtime_office_activations a on a.activation_id=r.activation_id
   where a.allocation_id=p_allocation_id and (p_after_lifetime_id is null or r.lifetime_id>p_after_lifetime_id)
 ), page as (select id,row_number() over(order by id) as n from (select id from identities order by id limit p_limit+1) selected)
 select coalesce(jsonb_agg(public.qorpera_runtime_screen_observation_events(id,0,1)-array['events','nextSequence'] order by id)
  filter(where n<=p_limit),'[]'),coalesce(bool_or(n>p_limit),false) into v_rows,v_more from page;
 v_result:=jsonb_build_object('schema','qorpera.runtime-screen-observation-lifetimes/v1','allocationId',p_allocation_id,
  'coverage','retained_observations_only','snapshotAcrossPages',false,'lifetimes',v_rows,'hasMore',v_more,
  'nextLifetimeId',case when v_more then v_rows->-1->'lifetimeId' else null end);
 if octet_length(v_result::text)>4194304 then raise exception 'Screen observation discovery page too large' using errcode='22023'; end if;
 return v_result;
end $$;
revoke all on function public.qorpera_runtime_screen_observation_events(uuid,bigint,integer),
 public.qorpera_runtime_screen_observation_lifetimes(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_screen_observation_events(uuid,bigint,integer),
 public.qorpera_runtime_screen_observation_lifetimes(uuid,uuid,integer) to service_role;
