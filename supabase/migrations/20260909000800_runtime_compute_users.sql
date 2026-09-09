-- Read existing transactional viewer evidence without adding a diagnostic
-- dependency to viewer or input admission. Membership is never activity.
create index qorpera_runtime_viewer_activity_time on public.qorpera_runtime_office_viewers(redeemed_at,office_id)
 where redeemed_at is not null;
create index qorpera_runtime_viewer_input_activity_time on public.qorpera_runtime_office_viewer_inputs(admitted_at,viewer_id);

create function public.qorpera_runtime_compute_users(p_node_id uuid,p_from timestamptz,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_at timestamptz:=statement_timestamp(); v_current jsonb; v_activity jsonb; v_events bigint;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_node_id is null or p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
  or p_from>=p_until or p_until>v_at or p_until-p_from>interval '24 hours'
  or not exists(select 1 from public.qorpera_runtime_nodes where id=p_node_id) then
  raise exception 'Invalid computer user window' using errcode='22023'; end if;
 with allocated as materialized (
  select a.id,a.profile_id from public.qorpera_runtime_node_demands d
   join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
   where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null
 ), companies as (select distinct profile_id from allocated)
 select jsonb_build_object('asOf',v_at,'allocatedComputers',(select count(*) from allocated),
  'companies',(select count(*) from companies),
  'associatedMembers',(select count(distinct m.user_id) from companies c join public.qorpera_profile_members m using(profile_id)),
  'source','unreleased_node_reservations_and_current_company_membership',
  'physicalRunningCount',null,'activityInferredFromMembership',false) into v_current;

 with placed as materialized (
  select a.id,a.profile_id,a.office_id,a.computer_generation,
   greatest(a.reserved_at,d.reserved_at) began,
   least(a.released_at,d.released_at) ended
  from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=p_node_id and d.reserved_at is not null and a.office_id is not null
   and greatest(a.reserved_at,d.reserved_at)<p_until
   and (least(a.released_at,d.released_at) is null or least(a.released_at,d.released_at)>p_from)
 ), events as (
  select a.id allocation_id,a.profile_id,v.member_id,v.redeemed_at at,'viewer_redemption' source
   from placed a join public.qorpera_runtime_office_viewers v on v.office_id=a.office_id
    and v.binding->>'computerGeneration'=a.computer_generation::text
   where v.redeemed_at>=p_from and v.redeemed_at<p_until and v.redeemed_at>=a.began and (a.ended is null or v.redeemed_at<a.ended)
  union all
  select a.id,a.profile_id,v.member_id,i.admitted_at,'admitted_control_input'
   from public.qorpera_runtime_office_viewer_inputs i join public.qorpera_runtime_office_viewers v on v.id=i.viewer_id
   join placed a on a.office_id=v.office_id and v.binding->>'computerGeneration'=a.computer_generation::text
   where i.admitted_at>=p_from and i.admitted_at<p_until and i.admitted_at>=a.began and (a.ended is null or i.admitted_at<a.ended)
 ), bounded as materialized (select * from events limit 20001)
 select count(*),jsonb_build_object('from',p_from,'until',p_until,'interval','half_open',
  'state',case when count(*)=0 then 'unknown' else 'observed' end,
  'reason',case when count(*)=0 then 'NO_ACTIVITY_OBSERVATIONS' else null end,
  'observedActiveUsers',case when count(*)>0 then count(distinct member_id) else null end,
  'observedComputers',count(distinct allocation_id),'observedCompanies',count(distinct profile_id),
  'recordedEvents',count(*),'firstObservedAt',min(at),'lastObservedAt',max(at),
  'viewerRedemptions',count(*) filter(where source='viewer_redemption'),
  'admittedControlInputs',count(*) filter(where source='admitted_control_input'),
  'sources',jsonb_build_array('viewer_redemption','admitted_control_input'),
  'coverage','retained_office_viewer_records_during_recorded_node_placement',
  'completeHumanPresence',false,'continuousWatchPresence',null,'inputExecutionConfirmed',false,
  'nativeJobSponsorsCountedAsActiveUsers',false,'membershipUsedAsActivity',false)
 into v_events,v_activity from bounded;
 if v_events>20000 then raise exception 'Computer user window requires a smaller interval' using errcode='54000'; end if;
 return jsonb_build_object('schema','qorpera.runtime-compute-users/v1','source','local','nodeId',p_node_id,'asOf',v_at,
  'currentAllocation',v_current,'activity',v_activity,'usedForAdmission',false,'overflow','unavailable');
end
$$;
revoke all on function public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz) to service_role;
