-- Preserve future database failure-transition times. Historical delivery_failed
-- assignments remain NULL rather than being backfilled with migration time.
alter table public.qorpera_runner_assignments add column delivery_failed_at timestamptz;
create function public.qorpera_record_dispatch_failure_time()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='UPDATE' then
  new.delivery_failed_at:=old.delivery_failed_at;
  if old.status is distinct from 'delivery_failed' and new.status='delivery_failed' and old.delivery_failed_at is null then
   new.delivery_failed_at:=clock_timestamp(); end if;
 else
  new.delivery_failed_at:=case when new.status='delivery_failed' then clock_timestamp() else null end;
 end if;
 return new;
end
$$;
revoke all on function public.qorpera_record_dispatch_failure_time() from public,anon,authenticated,service_role;
create trigger qorpera_record_dispatch_failure_time before insert or update on public.qorpera_runner_assignments
 for each row execute function public.qorpera_record_dispatch_failure_time();
create index qorpera_runner_assignments_job_failure on public.qorpera_runner_assignments
 (job_id,status,delivery_failed_at desc nulls last,created_at desc,id desc);

create function public.qorpera_runtime_request_placements(p_kind text,p_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare result jsonb; n bigint;
begin
 with selected as materialized (
  select a.*,d.node_id,d.provider_kind,d.provider_id,d.policy_sha256,d.requested_at node_requested_at,
   d.last_checked_at,d.last_refusal,d.reserved_at node_reserved_at,d.released_at node_released_at
  from public.qorpera_runtime_machine_allocations a left join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
  where (p_kind='office' and exists(select 1 from public.qorpera_runtime_office_start_intents i where i.id=p_id and i.allocation_id=a.id))
   or (p_kind='login' and a.login_session_id=p_id)
   or (p_kind='native' and a.run_id=(select r.id from public.qorpera_execution_runs r where r.job_id=p_id))
  order by a.id limit 1001
 ) select count(*),coalesce(jsonb_agg(jsonb_build_object('allocationId',id,'instanceSha256',instance_sha256,
  'providerAdapter',provider_adapter,'companyReservedAt',reserved_at,'companyReleasedAt',released_at,
  'nodeId',node_id,'source',case when node_id is not null then 'local' else null end,
  'providerKind',provider_kind,'providerId',provider_id,'policySha256',policy_sha256,
  'nodeRequestedAt',node_requested_at,'nodeReservedAt',node_reserved_at,'nodeReleasedAt',node_released_at,
  'lastAdmissionCheckAt',last_checked_at,'lastAdmissionRefusal',last_refusal,
  'nodePlacementState',case when node_id is null then 'unassigned' when node_reserved_at is null then 'requested'
   when node_released_at is null then 'reserved' else 'released' end,
  'physicalProvisioningOutcome',null,'physicalStateQuery','qorpera_runtime_node_computers') order by id),'[]') into n,result from selected;
 if n>1000 then raise exception 'Request placement history exceeds page bound' using errcode='54000'; end if;
 return result;
end
$$;
revoke all on function public.qorpera_runtime_request_placements(text,uuid) from public,anon,authenticated,service_role;

create function public.qorpera_runtime_compute_requests(p_company_id uuid,p_after_kind text default null,p_after_id uuid default null,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare records jsonb; more boolean; next_kind text; next_id uuid; result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_company_id is null or p_limit is null or p_limit not between 1 and 1000
  or (p_after_kind is null)<>(p_after_id is null) or (p_after_kind is not null and p_after_kind not in ('office','native','login','capacity_refusal')) then
  raise exception 'Invalid compute request page' using errcode='22023'; end if;
 with requests as (
  select 'capacity_refusal'::text kind,f.allocation_id id,f.created_at requested_at,'recorded_refusal'::text state,
   jsonb_build_object('reason','MACHINE_CAPACITY_EXHAUSTED','usedAtRefusal',f.used,'ceilingAtRefusal',f.ceiling,
    'currentWaitState',null,'requestSource',null) details
  from public.qorpera_runtime_machine_refusals f where f.profile_id=p_company_id
   and not exists(select 1 from public.qorpera_runtime_machine_allocations a where a.id=f.allocation_id)
  union all
  select 'office'::text kind,i.id,i.created_at requested_at,i.state,
   jsonb_build_object('officeId',i.office_id,'computerGeneration',i.computer_generation,'cancelledAt',i.cancelled_at,
    'configuredProviderId',p.provider_id,'configuredPolicySha256',p.policy_sha256,'preparationEnabled',p.preparation_enabled,
    'providerDiagnosticSource','host_office_provider_journal','provisioningFailure',null) details
  from public.qorpera_runtime_office_start_intents i join public.qorpera_runtime_offices o on o.id=i.office_id
  left join public.qorpera_runtime_office_providers p on p.office_id=i.office_id and p.computer_generation=i.computer_generation
  where o.profile_id=p_company_id
  union all
  select 'login',s.id,s.created_at,s.status,
   jsonb_build_object('loginSessionId',s.id,'expiresAt',s.expires_at,'completedAt',s.completed_at,
    'machineRequestId',r.allocation_id,'machineRequestedAt',r.requested_at,'lastAdmissionCheckAt',r.last_checked_at,
    'lastAdmissionRefusal',r.last_refusal,'machineRequestReleasedAt',r.released_at,
    'providerDiagnosticSource','host_login_provider_journal','provisioningFailure',null)
  from public.qorpera_native_provider_login_sessions s left join public.qorpera_runtime_login_machine_requests r on r.login_session_id=s.id
  where s.profile_id=p_company_id
  union all
  select 'native',j.id,j.created_at,j.status,
   jsonb_build_object('jobId',j.id,'startedAt',j.started_at,'finishedAt',j.finished_at,'cancelledAt',j.cancelled_at,
    'runtimeBundleId',r.runtime_bundle_id,'jobOutcome',j.status,
    'provisioningFailure',null,'providerDiagnosticSource','runner_assignment_records')
  from public.qorpera_runner_jobs j left join public.qorpera_execution_runs r on r.id=j.run_id and r.job_id=j.id
  where j.profile_id=p_company_id
 ), page as materialized (
  select * from requests where p_after_kind is null or (kind,id)>(p_after_kind,p_after_id)
   order by kind,id limit p_limit+1
 ), selected as (select *,row_number() over(order by kind,id) ordinal from page), enriched as (
  select kind,id,jsonb_build_object('kind',kind,'requestId',id,'companyId',p_company_id,'requestedAt',requested_at,
   'recordedState',state,'details',details,'placements',public.qorpera_runtime_request_placements(kind,id),
   'dispatchAttempts',case when kind='native' then (select jsonb_build_object('recordedAttempts',count(*),
    'deliveryFailedAttempts',count(*) filter(where a.status='delivery_failed'),
    'source','runner_assignments','latestFailure',(
     select jsonb_build_object('assignmentId',f.id,'runnerId',f.runner_id,'runId',f.run_id,
      'reason','DISPATCH_DELIVERY_FAILED','failedAt',f.delivery_failed_at,'failureTimeSource',
      case when f.delivery_failed_at is null then 'not_recorded' else 'database_status_transition' end)
     from public.qorpera_runner_assignments f where f.job_id=selected.id and f.status='delivery_failed'
      order by f.delivery_failed_at desc nulls last,f.created_at desc,f.id desc limit 1))
    from public.qorpera_runner_assignments a where a.job_id=selected.id) else null end,
   'admissionRechecked',false,'resourceReleaseInferred',false) record
  from selected where ordinal<=p_limit
 ) select coalesce(jsonb_agg(record order by kind,id),'[]'),(select count(*)>p_limit from page),
  (array_agg(kind order by kind desc,id desc))[1],(array_agg(id order by kind desc,id desc))[1]
 into records,more,next_kind,next_id from enriched;
 result:=jsonb_build_object('schema','qorpera.runtime-compute-requests/v1','companyId',p_company_id,'asOf',statement_timestamp(),
  'requests',records,'hasMore',more,'nextKind',case when more then next_kind else null end,'nextId',case when more then next_id else null end,
  'snapshotAcrossPages',false,'coverage','retained_office_intents_login_sessions_native_jobs_and_unallocated_company_refusals',
  'configuredTargetsArePlacements',false,'overflow','unavailable','capacityQuery','qorpera_runtime_node_capacity');
 if octet_length(result::text)>4194304 then raise exception 'Compute request page requires a smaller limit' using errcode='54000'; end if;
 return result;
end
$$;
revoke all on function public.qorpera_runtime_compute_requests(uuid,text,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_compute_requests(uuid,text,uuid,integer) to service_role;
