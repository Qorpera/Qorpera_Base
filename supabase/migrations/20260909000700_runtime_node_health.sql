-- Optional host diagnostics have independent custody and never gate resource
-- admission. Raw/last observations stay private, with no automatic deletion.
create table public.qorpera_runtime_node_health_receipts (
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 observation_id uuid not null,
 observed_at timestamptz not null check(isfinite(observed_at)),
 received_at timestamptz not null default clock_timestamp(),
 observation jsonb not null,
 primary key(node_id,observation_id)
);
create index qorpera_runtime_node_health_history on public.qorpera_runtime_node_health_receipts(node_id,observed_at,observation_id);
create table public.qorpera_runtime_node_health_latest (
 node_id uuid primary key references public.qorpera_runtime_nodes(id) on delete restrict,
 observation_id uuid not null,
 observed_at timestamptz not null,
 foreign key(node_id,observation_id) references public.qorpera_runtime_node_health_receipts(node_id,observation_id) on delete restrict
);
alter table public.qorpera_runtime_node_health_receipts enable row level security;
alter table public.qorpera_runtime_node_health_latest enable row level security;
revoke all on public.qorpera_runtime_node_health_receipts,public.qorpera_runtime_node_health_latest from public,anon,authenticated,service_role;

create function public.qorpera_node_health_object(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(p_value)='object' and p_value-p_keys='{}'::jsonb and p_value ?& p_keys,false)
$$;
create function public.qorpera_node_health_uint(p_value jsonb,p_max bigint default 9007199254740991)
returns boolean language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(p_value)='number' and p_value::text ~ '^(0|[1-9][0-9]{0,15})$'
  then (p_value::text)::bigint<=p_max else false end
$$;
create function public.qorpera_node_health_time(p_value jsonb)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare t timestamptz;
begin
 if jsonb_typeof(p_value) is distinct from 'string' or p_value#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
  raise exception 'Invalid node health time' using errcode='22023'; end if;
 t:=(p_value#>>'{}')::timestamptz;
 if not isfinite(t) or to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_value#>>'{}' then
  raise exception 'Invalid node health time' using errcode='22023'; end if;
 return t;
exception when invalid_datetime_format or datetime_field_overflow then
 raise exception 'Invalid node health time' using errcode='22023';
end
$$;
create function public.qorpera_assert_runtime_node_health(p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare k text; v_at timestamptz; v_from timestamptz; v_until timestamptz; v_metric jsonb; v_index integer;
 v_metrics text[]:=array['cpu','memory','rootFilesystem','network'];
 v_errors text[]:=array['CPU_SAMPLE_UNAVAILABLE','MEMORY_SAMPLE_UNAVAILABLE','ROOT_FILESYSTEM_UNAVAILABLE','NETWORK_COUNTERS_UNAVAILABLE'];
begin
 if not public.qorpera_node_health_object(p_value,array['schema','nodeId','machineIdSha256','policySha256','observerPackageSha256',
  'bootId','observationId','observedAt','cpu','memory','rootFilesystem','network','errors'])
  or octet_length(p_value::text)>32768 or p_value->>'schema' is distinct from 'qorpera.runtime-node-health/v1'
  or jsonb_typeof(p_value->'errors') is distinct from 'array' then raise exception 'Invalid node health record' using errcode='22023'; end if;
 foreach k in array array['nodeId','observationId'] loop
  if jsonb_typeof(p_value->k) is distinct from 'string' or p_value->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception 'Invalid node health identity' using errcode='22023'; end if;
 end loop;
 foreach k in array array['machineIdSha256','policySha256'] loop
  if jsonb_typeof(p_value->k) is distinct from 'string' or p_value->>k !~ '^[0-9a-f]{64}$' then
   raise exception 'Invalid node health binding' using errcode='22023'; end if;
 end loop;
 v_at:=public.qorpera_node_health_time(p_value->'observedAt');
 if p_value->'bootId'='null'::jsonb then
  if p_value->'observerPackageSha256'<>'null'::jsonb or p_value->'errors'<>'["COLLECTION_UNCONFIRMED"]'::jsonb
   or exists(select 1 from unnest(v_metrics) m where p_value->m<>'null'::jsonb) then
   raise exception 'Unconfirmed node collection has measurements' using errcode='22023'; end if;
  return;
 end if;
 if jsonb_typeof(p_value->'bootId') is distinct from 'string' or p_value->>'bootId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or jsonb_typeof(p_value->'observerPackageSha256') is distinct from 'string' or p_value->>'observerPackageSha256' !~ '^[0-9a-f]{64}$'
  or exists(select 1 from jsonb_array_elements(p_value->'errors') e where jsonb_typeof(e)<>'string' or not(e#>>'{}'=any(v_errors)))
  or (select count(*)<>count(distinct e) from jsonb_array_elements(p_value->'errors') e) then
  raise exception 'Invalid node health measurement binding' using errcode='22023'; end if;
 for v_index in 1..4 loop
  if (p_value->v_metrics[v_index]='null'::jsonb)<>(p_value->'errors' ? v_errors[v_index]) then
   raise exception 'Missing node health reason' using errcode='22023'; end if;
 end loop;
 v_metric:=p_value->'cpu';
 if v_metric<>'null'::jsonb then
  if not public.qorpera_node_health_object(v_metric,array['usedBasisPoints','from','until'])
   or not public.qorpera_node_health_uint(v_metric->'usedBasisPoints',10000) then raise exception 'Invalid node CPU measurement' using errcode='22023'; end if;
  v_from:=public.qorpera_node_health_time(v_metric->'from');v_until:=public.qorpera_node_health_time(v_metric->'until');
  if v_until-v_from<interval '500 milliseconds' or v_until-v_from>interval '5 seconds' or v_until>v_at or v_at-v_from>interval '10 seconds' then
   raise exception 'Invalid node CPU interval' using errcode='22023'; end if;
 end if;
 v_metric:=p_value->'memory';
 if v_metric<>'null'::jsonb then
  if not public.qorpera_node_health_object(v_metric,array['totalBytes','availableBytes'])
   or not public.qorpera_node_health_uint(v_metric->'totalBytes') or not public.qorpera_node_health_uint(v_metric->'availableBytes')
   or (v_metric->>'totalBytes')::bigint=0 or (v_metric->>'availableBytes')::bigint>(v_metric->>'totalBytes')::bigint then
   raise exception 'Invalid node memory measurement' using errcode='22023'; end if;
 end if;
 v_metric:=p_value->'rootFilesystem';
 if v_metric<>'null'::jsonb then
  if not public.qorpera_node_health_object(v_metric,array['totalBytes','freeBytes','availableBytes'])
   or exists(select 1 from unnest(array['totalBytes','freeBytes','availableBytes']) f where not public.qorpera_node_health_uint(v_metric->f))
   or (v_metric->>'totalBytes')::bigint=0 or (v_metric->>'freeBytes')::bigint>(v_metric->>'totalBytes')::bigint
   or (v_metric->>'availableBytes')::bigint>(v_metric->>'freeBytes')::bigint then raise exception 'Invalid node filesystem measurement' using errcode='22023'; end if;
 end if;
 v_metric:=p_value->'network';
 if v_metric<>'null'::jsonb then
  if not public.qorpera_node_health_object(v_metric,array['receivedBytes','sentBytes','receiveErrors','sendErrors','receiveDrops','sendDrops'])
   or exists(select 1 from jsonb_each(v_metric) e where not public.qorpera_node_health_uint(e.value)) then
   raise exception 'Invalid node network counters' using errcode='22023'; end if;
 end if;
end
$$;

create function public.qorpera_observe_runtime_node_health(p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_observation uuid; v_at timestamptz; v_old public.qorpera_runtime_node_health_receipts%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Node observer required' using errcode='42501'; end if;
 perform public.qorpera_assert_runtime_node_health(p_observation);
 v_id:=(p_observation->>'nodeId')::uuid;v_observation:=(p_observation->>'observationId')::uuid;
 select * into v_old from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id=v_observation;
 if v_old.observation_id is null then
  if not exists(select 1 from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_inventory_policies p on p.node_id=n.id
   where n.id=v_id and n.machine_id_sha256=p_observation->>'machineIdSha256' and p.policy_sha256=p_observation->>'policySha256') then
   raise exception 'Node health host or policy differs' using errcode='42501'; end if;
  v_at:=public.qorpera_node_health_time(p_observation->'observedAt');
  if v_at>clock_timestamp()+interval '2 seconds' or v_at<clock_timestamp()-interval '60 seconds' then
   raise exception 'Node health observation is not current' using errcode='22023'; end if;
  insert into public.qorpera_runtime_node_health_receipts(node_id,observation_id,observed_at,observation)
   values(v_id,v_observation,v_at,p_observation) on conflict(node_id,observation_id) do nothing;
  select * into strict v_old from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id=v_observation;
 end if;
 if v_old.observation<>p_observation then raise exception 'Node health observation identity changed' using errcode='22023'; end if;
 -- Out-of-order delivery never replaces a newer measurement. Exact replay
 -- retains original time and bytes; it cannot refresh operator health.
 insert into public.qorpera_runtime_node_health_latest(node_id,observation_id,observed_at)
  values(v_id,v_observation,v_old.observed_at) on conflict(node_id) do update
   set observation_id=excluded.observation_id,observed_at=excluded.observed_at
   where (excluded.observed_at,excluded.observation_id)>(qorpera_runtime_node_health_latest.observed_at,qorpera_runtime_node_health_latest.observation_id);
 return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_old.observed_at);
end
$$;
create function public.qorpera_runtime_node_health(p_node_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.qorpera_runtime_node_health_receipts%rowtype; v_at timestamptz:=statement_timestamp(); v_reason text; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_node_id is null then raise exception 'Node identity required' using errcode='22023'; end if;
 select h.* into r from public.qorpera_runtime_node_health_latest l join public.qorpera_runtime_node_health_receipts h using(node_id,observation_id) where l.node_id=p_node_id;
 if not exists(select 1 from public.qorpera_runtime_nodes where id=p_node_id) then v_reason:='NODE_UNCONFIGURED';
 elsif r.observation_id is null then v_reason:='OBSERVATION_MISSING';
 elsif r.observed_at<=v_at-interval '60 seconds' then v_reason:='OBSERVATION_STALE';
 elsif r.observed_at>v_at+interval '2 seconds' then v_reason:='OBSERVATION_TIME_UNCONFIRMED';
 elsif not exists(select 1 from public.qorpera_runtime_node_inventory_policies p where p.node_id=p_node_id and p.policy_sha256=r.observation->>'policySha256') then v_reason:='OBSERVER_POLICY_CHANGED';
 elsif r.observation->'bootId'='null'::jsonb then v_reason:='COLLECTION_UNCONFIRMED';
 elsif jsonb_array_length(r.observation->'errors')=4 then v_reason:='METRICS_UNAVAILABLE'; end if;
 v_result:=jsonb_build_object('schema','qorpera.runtime-node-health-view/v1','nodeId',p_node_id,'asOf',v_at,
  'state',case when v_reason is not null then 'unknown' when r.observation->'errors'='[]'::jsonb then 'complete' else 'partial' end,
  'reason',v_reason,'observedAt',r.observed_at,'receivedAt',r.received_at,'observationId',r.observation_id,
  'currentMeasurement',case when v_reason is null then r.observation else null end,'lastObservation',r.observation,
  'maximumAgeSeconds',60,'usedForAdmission',false,
  'sources',jsonb_build_object('cpu','node_os_cpu_times_delta_excluding_idle','memory','linux_MemTotal_and_MemAvailable',
   'rootFilesystem','statfs_root_filesystem','network','cumulative_counters_of_current_non_loopback_interfaces'),
  'nasHealth',null,'networkReachability',null,'trafficAccounting','not_company_file_or_NAS_traffic');
 return v_result;
end
$$;
create function public.qorpera_runtime_node_health_history(p_node_id uuid,p_before_time timestamptz default null,p_before_id uuid default null,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_records jsonb;v_more boolean;v_time timestamptz;v_id uuid;v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_node_id is null or p_limit is null or p_limit not between 1 and 1000 or (p_before_time is null)<>(p_before_id is null)
  or (p_before_time is not null and not isfinite(p_before_time)) then raise exception 'Invalid node health page' using errcode='22023'; end if;
 with page as materialized (
  select * from public.qorpera_runtime_node_health_receipts where node_id=p_node_id
   and (p_before_time is null or (observed_at,observation_id)<(p_before_time,p_before_id))
   order by observed_at desc,observation_id desc limit p_limit+1
 ), selected as (
  select * from page order by observed_at desc,observation_id desc limit p_limit
 ) select coalesce(jsonb_agg(jsonb_build_object('observation',observation,'receivedAt',received_at)
   order by observed_at desc,observation_id desc),'[]'),(select count(*)>p_limit from page),
  (array_agg(observed_at order by observed_at,observation_id))[1],(array_agg(observation_id order by observed_at,observation_id))[1]
  into v_records,v_more,v_time,v_id from selected;
 v_result:=jsonb_build_object('schema','qorpera.runtime-node-health-history/v1','nodeId',p_node_id,'records',v_records,
  'hasMore',v_more,'nextBeforeTime',case when v_more then v_time else null end,'nextBeforeId',case when v_more then v_id else null end,
  'snapshotAcrossPages',false,'coverage','retained_observations');
 if octet_length(v_result::text)>4194304 then raise exception 'Node health page requires a smaller limit' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_node_health_object(jsonb,text[]),public.qorpera_node_health_uint(jsonb,bigint),
 public.qorpera_node_health_time(jsonb),public.qorpera_assert_runtime_node_health(jsonb),public.qorpera_observe_runtime_node_health(jsonb),
 public.qorpera_runtime_node_health(uuid),public.qorpera_runtime_node_health_history(uuid,timestamptz,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_observe_runtime_node_health(jsonb),public.qorpera_runtime_node_health(uuid),
 public.qorpera_runtime_node_health_history(uuid,timestamptz,uuid,integer) to service_role;
