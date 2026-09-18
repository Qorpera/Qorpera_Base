-- Accepted native demand survives the requesting process and member/native
-- coalescing. These are delivery claims, not another execution queue. Only
-- the existing typed wake bus can admit the subsequent run.
create table public.qorpera_runtime_office_start_waiters (
 id uuid primary key default extensions.gen_random_uuid(),
 intent_id uuid not null references public.qorpera_runtime_office_start_intents(id) on delete restrict,
 parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
 receipt_id uuid not null unique references public.qorpera_run_operation_receipts(id) on delete restrict,
 staff_version bigint not null check(staff_version>0),
 grant_id uuid not null,
 grant_version bigint not null check(grant_version>0),
 state text not null default 'waiting' check(state in ('waiting','delivered','cancelled')),
 occurrence_id uuid unique references public.qorpera_wake_occurrences(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 scanned_at timestamptz not null default '-infinity',
 unique(intent_id,parent_run_id),
 check((state='delivered')=(occurrence_id is not null))
);
create index qorpera_office_start_waiter_scan on public.qorpera_runtime_office_start_waiters(scanned_at,created_at,id) where state='waiting';
alter table public.qorpera_runtime_office_start_waiters enable row level security;
revoke all on public.qorpera_runtime_office_start_waiters from public,anon,authenticated,service_role,qorpera_secret_broker;
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
 check(source_kind in ('input','schedule','company-file','coworker','room','office-activation'));

-- Exact source, current grant and completed parent work. Never copy a former
-- run lease as authority, resurrect a cancelled/failed run or race its work.
-- Locks use NOWAIT because the caller may already hold a wake/job lock.
create function public.qorpera_office_waiter_authorized(p_waiter public.qorpera_runtime_office_start_waiters)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_intent public.qorpera_runtime_office_start_intents%rowtype;
 v_parent public.qorpera_execution_runs%rowtype; v_office public.qorpera_runtime_offices%rowtype; v_job_status text;
 v_parent_wake public.qorpera_wake_occurrences%rowtype;
begin
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id;
 if not found then return false; end if;
 -- Standalone effect validators may already hold a job lock. Acquire the
 -- common profile fence without waiting before taking any office/grant lock.
 perform 1 from public.qorpera_profiles where id=v_parent.profile_id for update nowait;
 if not found then return false; end if;
 select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_waiter.intent_id for share nowait;
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id for share nowait;
 select status into v_job_status from public.qorpera_runner_jobs where id=v_parent.job_id for share nowait;
 select * into v_office from public.qorpera_runtime_offices where id=v_intent.office_id for share nowait;
 if v_office.id is null or v_parent.id is null or v_intent.state<>'reserved'
  or v_office.state<>'active' or v_office.generation<>v_intent.computer_generation
  or v_office.image_sha256<>v_intent.image_sha256 or v_office.bootstrap_sha256<>v_intent.bootstrap_sha256
  or v_parent.profile_id<>v_office.profile_id or v_parent.environment_id<>v_office.environment_id
  or v_parent.audience_kind<>'company' or v_parent.audience_user_id is not null
  or v_job_status is distinct from 'completed' or v_parent.staff_version<>p_waiter.staff_version
  or p_waiter.state='cancelled' or public.qorpera_company_execution_paused(v_parent.profile_id) then return false; end if;
 -- Bound repeated internal revivals before admission, rather than launching
 -- a run whose complete historical context cannot be read. Source authority
 -- remains current, including room membership and revoked routine intent.
 if exists(with recursive ancestry(run_id,depth) as (
  select v_parent.id,1 union all select w.parent_run_id,a.depth+1 from ancestry a
  join public.qorpera_wake_occurrences w on w.run_id=a.run_id
  where w.source_kind='office-activation' and a.depth<9
 ) select 1 from ancestry where depth=9) then return false; end if;
 select * into v_parent_wake from public.qorpera_wake_occurrences where run_id=v_parent.id;
 if not found or public.qorpera_runtime_wake_policy_internal(v_parent.id)->>'kind' is distinct from v_parent_wake.wake_kind
  or not public.qorpera_wake_authorized(v_parent_wake) then return false; end if;
 perform 1 from public.qorpera_profile_staff where profile_id=v_parent.profile_id and staff_agent_id=v_parent.staff_agent_id
  and version=p_waiter.staff_version and employment_status='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_profile_members where profile_id=v_parent.profile_id and user_id=v_parent.requested_by_user_id for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_office_access where office_id=v_office.id and profile_id=v_parent.profile_id
  and staff_agent_id=v_parent.staff_agent_id and grant_id=p_waiter.grant_id and version=p_waiter.grant_version and state='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_machine_allocations where id=v_intent.allocation_id and office_id=v_office.id
  and profile_id=v_office.profile_id and computer_generation=v_office.generation and released_at is null
  and instance_sha256=v_intent.instance_sha256 and provider_adapter='lxd' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_logical_computers computer where id=v_office.logical_computer_id
  and status='active' and public.qorpera_runtime_office_matches(computer) for share nowait;
 if not found then return false; end if;
 if not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
  and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
  or not exists(select 1 from public.qorpera_runtime_office_activations where intent_id=v_intent.id
   and office_id=v_office.id and computer_generation=v_office.generation and state='active'
   and allocation_id=v_intent.allocation_id and instance_sha256=v_intent.instance_sha256
   and provider_binding_sha256=v_intent.provider_binding_sha256)
  or not exists(select 1 from public.qorpera_run_operation_receipts where id=p_waiter.receipt_id
   and run_id=v_parent.id and status='completed' and operation_kind='cloud_tool'
   and logical_operation_key like 'computer_start:%' and not requires_company_revision)
  or exists(select 1 from public.qorpera_run_operation_receipts where run_id=v_parent.id
   and (status<>'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
    or (requires_company_revision and output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null))) then return false; end if;
 return true;
end $$;

create function public.qorpera_office_activation_wake_payload(p_waiter public.qorpera_runtime_office_start_waiters)
returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('schema','qorpera.office-start-continuation/v1','intentId',a.intent_id,
  'activationId',a.activation_id,'companyComputerId',a.office_id,'computerGeneration',a.computer_generation,'receiptId',p_waiter.receipt_id)
 from public.qorpera_runtime_office_activations a where a.intent_id=p_waiter.intent_id and a.state='active'
$$;

-- A revival keeps its parent's causal chain; appending the same agent would
-- incorrectly trip the coworker ping-pong fence. No human actor is invented.
create function public.qorpera_office_activation_wake_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_waiter public.qorpera_runtime_office_start_waiters%rowtype; v_parent public.qorpera_execution_runs%rowtype;
 v_wake public.qorpera_wake_occurrences%rowtype;
begin
 select * into v_waiter from public.qorpera_runtime_office_start_waiters where id=p_wake.source_id;
 select * into v_parent from public.qorpera_execution_runs where id=v_waiter.parent_run_id;
 select * into v_wake from public.qorpera_wake_occurrences where run_id=v_parent.id;
 if v_waiter.id is null or v_parent.id is null or v_wake.id is null or p_wake.wake_kind<>'agent'
  or p_wake.source_kind<>'office-activation' or p_wake.parent_run_id is distinct from v_parent.id
  or p_wake.profile_id is distinct from v_parent.profile_id or p_wake.environment_id is distinct from v_parent.environment_id
  or p_wake.staff_agent_id is distinct from v_parent.staff_agent_id or p_wake.requested_by_user_id is distinct from v_parent.requested_by_user_id
  or p_wake.session_id is not null or p_wake.file_event_id is not null
  or p_wake.trigger_id is distinct from 'office-activation'
  or p_wake.occurrence_key is distinct from 'office-activation:'||v_waiter.intent_id::text||':'||v_parent.id::text
  or p_wake.payload is distinct from public.qorpera_office_activation_wake_payload(v_waiter)
  or (v_waiter.occurrence_id is not null and v_waiter.occurrence_id<>p_wake.id)
  or not public.qorpera_office_waiter_authorized(v_waiter)
  or public.qorpera_runtime_wake_policy_internal(v_parent.id)->>'kind' is distinct from v_wake.wake_kind
  or v_wake.causal_root_id is null or cardinality(v_wake.causal_agent_ids) not between 1 and 16
  or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_parent.staff_agent_id then return null; end if;
 return jsonb_build_object('rootId',v_wake.causal_root_id,'agentIds',to_jsonb(v_wake.causal_agent_ids));
end $$;

-- Scan fairly; waiting for parent completion or physical activation must not
-- starve other offices. Admission and delivery are one SQL transaction.
create function public.qorpera_drain_office_activation_wakes(p_limit integer default 32)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_waiter public.qorpera_runtime_office_start_waiters%rowtype; v_parent public.qorpera_execution_runs%rowtype;
 v_intent public.qorpera_runtime_office_start_intents%rowtype; v_id uuid; v_at timestamptz; v_job_status text;
begin
 if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
  raise exception 'Office wake admission authority or bound is invalid' using errcode='42501'; end if;
 for v_waiter in select * from public.qorpera_runtime_office_start_waiters where state='waiting'
  order by scanned_at,created_at,id for update skip locked limit p_limit loop
  update public.qorpera_runtime_office_start_waiters set scanned_at=clock_timestamp() where id=v_waiter.id;
  begin
   select * into strict v_parent from public.qorpera_execution_runs where id=v_waiter.parent_run_id;
   select status into strict v_job_status from public.qorpera_runner_jobs where id=v_parent.job_id;
   perform public.qorpera_serialize_wake_admission(v_parent.profile_id);
   select * into strict v_intent from public.qorpera_runtime_office_start_intents where id=v_waiter.intent_id;
   if v_job_status in ('failed','cancelled') or v_intent.state='cancelled'
    or not exists(select 1 from public.qorpera_runtime_offices where id=v_intent.office_id and generation=v_intent.computer_generation) then
    update public.qorpera_runtime_office_start_waiters set state='cancelled' where id=v_waiter.id; continue;
   end if;
   if v_job_status<>'completed' or public.qorpera_company_execution_paused(v_parent.profile_id)
    or not exists(select 1 from public.qorpera_runtime_office_activations where intent_id=v_intent.id and state='active') then continue; end if;
   if not public.qorpera_office_waiter_authorized(v_waiter) then
    update public.qorpera_runtime_office_start_waiters set state='cancelled' where id=v_waiter.id; continue;
   end if;
   select activated_at into strict v_at from public.qorpera_runtime_office_activations where intent_id=v_intent.id;
   insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,staff_agent_id,
    parent_run_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
   values(extensions.gen_random_uuid(),v_parent.profile_id,v_parent.environment_id,'agent','office-activation',v_waiter.id,v_parent.staff_agent_id,
    v_parent.id,'office-activation','office-activation:'||v_intent.id::text||':'||v_parent.id::text,v_at,clock_timestamp(),
    public.qorpera_office_activation_wake_payload(v_waiter)) returning id into v_id;
   update public.qorpera_runtime_office_start_waiters set state='delivered',occurrence_id=v_id where id=v_waiter.id;
  exception when lock_not_available then continue;
   when insufficient_privilege or no_data_found then
    update public.qorpera_runtime_office_start_waiters set state='cancelled' where id=v_waiter.id;
  end;
 end loop;
end $$;

-- Fail the migration if an earlier function no longer matches the reviewed
-- integration points; preserve its owner and existing private permissions.
create function pg_temp.office_wake_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
 if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
  raise exception 'Office wake integration differs: %',p_target; end if;
 execute replace(v_definition,p_old,p_new);
end $$;

select pg_temp.office_wake_patch('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,$old$	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);$old$,$new$	insert into public.qorpera_runtime_office_start_waiters(intent_id,parent_run_id,receipt_id,staff_version,grant_id,grant_version)
 values(v_intent.id,v_receipt.run_id,v_receipt.id,(v_authority#>>'{identity,staffVersion}')::bigint,
  (v_descriptor#>>'{resources,officeGrantId}')::uuid,(v_descriptor#>>'{resources,officeGrantVersion}')::bigint)
 on conflict(intent_id,parent_run_id) do nothing;
 if not exists(select 1 from public.qorpera_runtime_office_start_waiters where intent_id=v_intent.id and parent_run_id=v_receipt.run_id
  and staff_version=(v_authority#>>'{identity,staffVersion}')::bigint
  and grant_id=(v_descriptor#>>'{resources,officeGrantId}')::uuid and grant_version=(v_descriptor#>>'{resources,officeGrantVersion}')::bigint) then
  raise exception 'Office start continuation cannot be rebound' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);$new$);

select pg_temp.office_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,$old$		if new.source_kind <> 'coworker' then raise exception 'Coworker source is invalid' using errcode = '22023'; end if;
		v_actor := v_run.staff_agent_id; new.source_id := new.id; new.requested_by_user_id := v_run.requested_by_user_id;$old$,$new$		if new.source_kind not in ('coworker','office-activation') then raise exception 'Agent source is invalid' using errcode = '22023'; end if;
  if new.source_kind='coworker' then v_actor:=v_run.staff_agent_id; new.source_id:=new.id; end if;
  new.requested_by_user_id:=v_run.requested_by_user_id;$new$);

select pg_temp.office_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,$old$	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));$old$,$new$ if new.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(new);
 else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id)); end if;$new$);

select pg_temp.office_wake_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,$old$	v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
		coalesce(p_wake.file_event_id,p_wake.id));$old$,$new$ if p_wake.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(p_wake);
 else v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
  coalesce(p_wake.file_event_id,p_wake.id)); end if;$new$);

select pg_temp.office_wake_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,$old$(v_wake.wake_kind = 'agent' and v_wake.source_kind = 'coworker')$old$,$new$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation'))$new$);

select pg_temp.office_wake_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,$old$	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1'$old$,$new$ if v_wake.source_kind='office-activation' then v_sender:=null; v_actor_user:=null; end if;
	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1'$new$);

select pg_temp.office_wake_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,$old$	perform public.qorpera_drain_company_file_wakes(p_limit);$old$,$new$	perform public.qorpera_drain_office_activation_wakes(p_limit);
	perform public.qorpera_drain_company_file_wakes(p_limit);$new$);

select pg_temp.office_wake_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
 $old$				v_reviewers := v_version.reviewer_staff_ids;
			end if;$old$,
 $new$				v_reviewers := v_version.reviewer_staff_ids;
			elsif v_wake.source_kind='office-activation' then
    -- Continuing protected work cannot downgrade its publication policy.
    select required_capability,job_type,publication_mode,review_policy_key,reviewer_staff_ids
    into strict v_capability,v_job_type,v_publication,v_review,v_reviewers
    from public.qorpera_execution_runs where id=v_wake.parent_run_id;
			end if;$new$);

revoke all on function public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters),
 public.qorpera_office_activation_wake_payload(public.qorpera_runtime_office_start_waiters),
 public.qorpera_office_activation_wake_ancestry(public.qorpera_wake_occurrences),
 public.qorpera_drain_office_activation_wakes(integer) from public,anon,authenticated,service_role,qorpera_secret_broker;

-- Context is read through the existing attributed, hash-bound continuation
-- source. Parent inputs remain historical; neither they nor prior receipts
-- add a public audience, revive a grant or authorize repeating an effect.
create function public.qorpera_office_run_continuation(p_run public.qorpera_execution_runs,p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_parent public.qorpera_execution_runs%rowtype;
 v_parent_wake public.qorpera_wake_occurrences%rowtype; v_inputs jsonb; v_receipts jsonb; v_sends jsonb; v_result jsonb;
begin
 select * into v_wake from public.qorpera_wake_occurrences where run_id=p_run.id and source_kind='office-activation';
 if not found then return null; end if;
 if p_depth not between 0 and 7 then raise exception 'Office continuation ancestry exceeds its bound' using errcode='54000'; end if;
 select * into strict v_parent from public.qorpera_execution_runs where id=v_wake.parent_run_id
  and profile_id=p_run.profile_id and environment_id=p_run.environment_id and staff_agent_id=p_run.staff_agent_id
  and requested_by_user_id=p_run.requested_by_user_id and audience_kind='company'
  and exists(select 1 from public.qorpera_runner_jobs where id=job_id and status='completed');
 select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id=v_parent.id;
 select coalesce(jsonb_agg(public.qorpera_company_context_source(v_parent,'input',input_id) order by ordinal),'[]') into v_inputs
  from unnest(v_parent.input_ids) with ordinality ids(input_id,ordinal);
 select coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'logicalOperationKey',logical_operation_key,
  'assignmentId',assignment_id,'inputSha256',input_sha256,'completedAt',completed_at,'result',result,
  'outputSnapshotId',output_snapshot_id,'proposalId',proposal_id,'companyPathProposalId',company_path_proposal_id)
  order by completed_at,id),'[]') into v_receipts from public.qorpera_run_operation_receipts where run_id=v_parent.id and status='completed';
 select coalesce(jsonb_agg(jsonb_build_object('eventId',event.event_id,'sequence',event.sequence,'body',event.body)
  order by event.sequence),'[]') into v_sends from public.qorpera_agent_sends send
  join public.qorpera_session_events event on event.event_id=send.event_id where send.run_id=v_parent.id;
 v_result:=jsonb_build_object('schema','qorpera.office-start-continuation/v1','runId',p_run.id,'parentRunId',v_parent.id,
  'activation',v_wake.payload,'parentInputs',v_inputs,'parentJob',public.qorpera_company_context_source(v_parent,'job',v_parent.id),
  'parentWake',jsonb_build_object('kind',v_parent_wake.wake_kind,'sourceKind',v_parent_wake.source_kind,
   'payload',v_parent_wake.payload,'routineIntent',(select prompt from public.qorpera_cloud_routine_versions
    where routine_id=v_parent_wake.routine_id and version=v_parent_wake.routine_version),
   'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body',body)
    from public.qorpera_session_inputs where v_parent_wake.source_kind='room' and id=v_parent_wake.source_id
     and session_id=v_parent.session_id and kind='user_message')),
  'receipts',v_receipts,'priorSends',v_sends,'earlierOfficeStart',public.qorpera_office_run_continuation(v_parent,p_depth+1));
 if octet_length(v_result::text)>33554432 then raise exception 'Office continuation exceeds its bound' using errcode='54000'; end if;
 return v_result;
end $$;
revoke all on function public.qorpera_office_run_continuation(public.qorpera_execution_runs,integer)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
select pg_temp.office_wake_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
 $old$if not found then return null; end if;$old$,
 $new$if not found then return public.qorpera_office_run_continuation(p_run); end if;$new$);
select pg_temp.office_wake_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
 $old$'handoffId',v_handoff.id,'reason',v_handoff.reason,'receipts',v_receipts,'priorSends',v_sends);$old$,
 $new$'handoffId',v_handoff.id,'reason',v_handoff.reason,'receipts',v_receipts,'priorSends',v_sends,
  'officeStart',public.qorpera_office_run_continuation(p_run));$new$);

do $$ declare v_owner name; begin
 for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
  'public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
  'public.qorpera_pin_wake_occurrence()'::regprocedure,
  'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
  'public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
  'public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure
 ]) loop
  if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Office wake function has an API owner'; end if;
  execute format('grant execute on function public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters),
   public.qorpera_office_activation_wake_payload(public.qorpera_runtime_office_start_waiters),
   public.qorpera_office_activation_wake_ancestry(public.qorpera_wake_occurrences),
   public.qorpera_drain_office_activation_wakes(integer),public.qorpera_office_run_continuation(public.qorpera_execution_runs,integer) to %I',v_owner);
  execute format('grant select,insert,update on public.qorpera_runtime_office_start_waiters to %I',v_owner);
 end loop;
end $$;
