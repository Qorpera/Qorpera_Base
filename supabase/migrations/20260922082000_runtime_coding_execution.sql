-- A coding turn is a distinct silent agent wake and native execution run.
-- The ordinary admission, quota, assignment, capsule and lease kernels remain
-- authoritative. Neither a parent lease nor an invented VM is executable proof.
alter table public.qorpera_coding_executors add column orchestrator_id uuid references public.qorpera_runner_orchestrators(id) on delete restrict;
create table public.qorpera_coding_executions (
	request_id uuid primary key references public.qorpera_coding_requests(id) on delete restrict,
	occurrence_id uuid not null unique references public.qorpera_wake_occurrences(id) on delete restrict,
	finish_operation_key text,
	finish_receipt_id uuid unique references public.qorpera_run_operation_receipts(id) on delete restrict,
	finish jsonb,
	created_at timestamptz not null default clock_timestamp(),
	check((finish is null)=(finish_receipt_id is null) and (finish is null)=(finish_operation_key is null))
);
alter table public.qorpera_coding_executions enable row level security;
revoke all on public.qorpera_coding_executions from public,anon,authenticated,service_role,qorpera_secret_broker;
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
	check(source_kind in ('input','schedule','company-file','coworker','room','office-activation','coding-completion','coding-dispatch'));

create function public.qorpera_bind_coding_executor_orchestrator(p_environment_id uuid,p_owner text,p_orchestrator_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
	if auth.role() is distinct from 'service_role' or not exists(select 1 from public.qorpera_runner_orchestrators
		where id=p_orchestrator_id and status='active') then raise exception 'Coding orchestrator unavailable' using errcode='42501'; end if;
	update public.qorpera_coding_executors set orchestrator_id=p_orchestrator_id where environment_id=p_environment_id and owner=p_owner;
	if not found then raise exception 'Coding executor unavailable' using errcode='42501'; end if;
end $$;

create function public.qorpera_coding_dispatch_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
	r public.qorpera_execution_runs%rowtype; parent public.qorpera_wake_occurrences%rowtype;
begin
	select * into q from public.qorpera_coding_requests where id=p_wake.source_id;
	select * into w from public.qorpera_coding_workers where id=q.worker_id;
	select * into r from public.qorpera_execution_runs where id=q.run_id;
	select * into parent from public.qorpera_wake_occurrences where run_id=r.id;
	perform 1 from public.qorpera_profiles where id=w.company_id for update nowait;
	perform 1 from public.qorpera_company_wake_admission_fences where profile_id=w.company_id for update nowait;
	perform 1 from public.qorpera_company_files where environment_id=w.environment_id for update nowait;
	if exists(with recursive ancestry(run_id,depth) as (select r.id,1 union all
		select wake.parent_run_id,a.depth+1 from ancestry a join public.qorpera_wake_occurrences wake on wake.run_id=a.run_id
		where wake.source_kind in ('office-activation','coding-completion','coding-dispatch') and a.depth<9)
		select 1 from ancestry where depth=9) then return null; end if;
	if q.id is null or w.id is null or r.id is null or parent.id is null
		or q.kind not in ('dispatch','followup') or q.status<>'leased' or q.lease_until<=clock_timestamp() or q.turn<>w.turn
		or p_wake.wake_kind<>'agent' or p_wake.source_kind<>'coding-dispatch'
		or p_wake.parent_run_id is distinct from r.id or p_wake.profile_id is distinct from r.profile_id
		or p_wake.environment_id is distinct from r.environment_id or p_wake.staff_agent_id is distinct from r.staff_agent_id
		or p_wake.requested_by_user_id is distinct from r.requested_by_user_id
		or p_wake.sponsor_binding_id is distinct from r.sponsor_binding_id or p_wake.sponsor_version is distinct from r.sponsor_version
		or p_wake.logical_computer_id is not null or p_wake.session_id is not null or p_wake.file_event_id is not null
		or p_wake.trigger_id is distinct from 'coding-dispatch'
		or p_wake.occurrence_key is distinct from 'coding-dispatch:'||q.id::text
		or p_wake.payload is distinct from jsonb_build_object('schema','qorpera.coding-dispatch/v1','requestId',q.id,'workerId',w.id,'turn',q.turn)
		or r.audience_kind<>'company' or exists(select 1 from public.qorpera_runner_jobs where id=r.job_id and status in ('failed','cancelled'))
		or not public.qorpera_wake_authorized(parent)
		or parent.causal_root_id is null or cardinality(parent.causal_agent_ids) not between 1 and 16
		or parent.causal_agent_ids[cardinality(parent.causal_agent_ids)] is distinct from r.staff_agent_id then return null; end if;
	perform public.qorpera_coding_assert_delegation(w,r.id);
	return jsonb_build_object('rootId',parent.causal_root_id,'agentIds',to_jsonb(parent.causal_agent_ids));
exception when insufficient_privilege or no_data_found then return null;
end $$;

create function pg_temp.coding_execution_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$ declare definition text:=pg_get_functiondef(p_target); begin
	if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Coding execution integration differs: %',p_target; end if;
	execute replace(definition,p_old,p_new);
end $$;
select pg_temp.coding_execution_patch('public.qorpera_pin_wake_occurrence()',
	$new$new.source_kind not in ('coworker','office-activation','coding-completion')$new$,
	$new$new.source_kind not in ('coworker','office-activation','coding-completion','coding-dispatch')$new$);
select pg_temp.coding_execution_patch('public.qorpera_pin_wake_occurrence()',
	$old$if new.source_kind='coding-completion' then
   new.sponsor_binding_id:=v_run.sponsor_binding_id; new.sponsor_version:=v_run.sponsor_version;
   new.logical_computer_id:=v_run.logical_computer_id;$old$,
	$new$if new.source_kind in ('coding-completion','coding-dispatch') then
   new.sponsor_binding_id:=v_run.sponsor_binding_id; new.sponsor_version:=v_run.sponsor_version;
   new.logical_computer_id:=case when new.source_kind='coding-dispatch' then null else v_run.logical_computer_id end;$new$);
select pg_temp.coding_execution_patch('public.qorpera_pin_wake_occurrence()',
	$old$if new.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(new);$old$,
	$new$if new.source_kind='coding-dispatch' then v_ancestry:=public.qorpera_coding_dispatch_ancestry(new);
 elsif new.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(new);$new$);
select pg_temp.coding_execution_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)',
	$old$p_wake.source_kind<>'coding-completion' and not exists$old$,
	$new$p_wake.source_kind not in ('coding-completion','coding-dispatch') and not exists$new$);
select pg_temp.coding_execution_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)',
	$old$if p_wake.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(p_wake);$old$,
	$new$if p_wake.source_kind='coding-dispatch' then v_ancestry:=public.qorpera_coding_dispatch_ancestry(p_wake);
 elsif p_wake.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(p_wake);$new$);
select pg_temp.coding_execution_patch('public.qorpera_runtime_wake_policy_internal(uuid)',
	$old$v_wake.source_kind in ('coworker','office-activation','coding-completion')$old$,
	$new$v_wake.source_kind in ('coworker','office-activation','coding-completion','coding-dispatch')$new$);
select pg_temp.coding_execution_patch('public.qorpera_read_native_wake(jsonb)',
	$old$v_wake.source_kind in ('office-activation','coding-completion')$old$,
	$new$v_wake.source_kind in ('office-activation','coding-completion','coding-dispatch')$new$);
select pg_temp.coding_execution_patch('public.qorpera_materialize_wake_execution_runs(integer)',
	$old$elsif v_wake.source_kind in ('office-activation','coding-completion') then$old$,
	$new$elsif v_wake.source_kind in ('office-activation','coding-completion','coding-dispatch') then$new$);
select pg_temp.coding_execution_patch('public.qorpera_materialize_wake_execution_runs(integer)',
	$old$v_payload := jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id);$old$,
	$new$v_payload := case when v_wake.source_kind='coding-dispatch'
    then jsonb_build_object('schema','qorpera.coding-run/v1','occurrenceId',v_wake.id,'requestId',v_wake.source_id)
    else jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id) end;$new$);
-- The ordinary company-runtime orchestrator must never launch a coding turn.
select pg_temp.coding_execution_patch('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)',
	$old$where job.status = 'queued' and job.attempt_count < 8 and job.dispatch_failure_count < 8$old$,
	$new$where job.status = 'queued' and job.attempt_count < 8 and job.dispatch_failure_count < 8
  and job.payload->>'schema' is distinct from 'qorpera.coding-run/v1'$new$);

create function public.qorpera_prepare_coding_execution(p_request_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype; occurrence uuid;
begin
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
	if q.kind='cancel' or not exists(select 1 from public.qorpera_coding_executors e
		join public.qorpera_runner_orchestrators o on o.id=e.orchestrator_id and o.status='active'
		where e.environment_id=w.environment_id and e.owner=q.lease_owner and e.enabled) then
		raise exception 'Coding native executor unavailable' using errcode='42501'; end if;
	select occurrence_id into occurrence from public.qorpera_coding_executions where request_id=q.id;
	if not found then
		occurrence:=extensions.gen_random_uuid();
		insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,staff_agent_id,
			parent_run_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
		values(occurrence,w.company_id,w.environment_id,'agent','coding-dispatch',q.id,w.parent_agent_id,q.run_id,
			'coding-dispatch','coding-dispatch:'||q.id::text,clock_timestamp(),clock_timestamp(),
			jsonb_build_object('schema','qorpera.coding-dispatch/v1','requestId',q.id,'workerId',w.id,'turn',q.turn));
		insert into public.qorpera_coding_executions(request_id,occurrence_id) values(q.id,occurrence);
	end if;
	return jsonb_build_object('schema','qorpera.coding-execution-admission/v1','requestId',q.id,'occurrenceId',occurrence);
end $$;

create function public.qorpera_describe_coding_execution(p_request_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
	e public.qorpera_coding_executions%rowtype; wake public.qorpera_wake_occurrences%rowtype; r public.qorpera_execution_runs%rowtype;
	s public.qorpera_execution_sponsor_versions%rowtype; v public.qorpera_provider_connection_versions%rowtype;
begin
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
	select * into strict e from public.qorpera_coding_executions where request_id=q.id;
	select * into strict wake from public.qorpera_wake_occurrences where id=e.occurrence_id;
	select * into r from public.qorpera_execution_runs where id=wake.run_id;
	select * into s from public.qorpera_execution_sponsor_versions where binding_id=wake.sponsor_binding_id and version=wake.sponsor_version;
	select * into v from public.qorpera_provider_connection_versions where connection_id=s.provider_connection_id and version=s.provider_connection_version;
	return jsonb_build_object('schema','qorpera.coding-execution/v1','requestId',q.id,'workerId',w.id,'turn',q.turn,
		'parentRunId',q.run_id,'repository',w.repository,'branch',w.branch,'vmId',w.vm_id,
		'runId',r.id,'jobId',r.job_id,'occurrenceId',wake.id,'admissionState',wake.status,'blockedReason',wake.blocked_reason,
		'computeIdentityId',r.compute_identity_id,'sponsorBindingId',wake.sponsor_binding_id,'sponsorVersion',wake.sponsor_version,
		'providerConnectionId',s.provider_connection_id,'providerConnectionVersion',s.provider_connection_version,
		'credentialCapsuleId',v.credential_capsule_id,'model',r.model_id,'runtimeBundleId',r.runtime_bundle_id,
		'runtimeBundleSha256',r.runtime_bundle_sha256,'dispatch',w.dispatch,'goal',coalesce(q.input ->> 'goal',w.dispatch ->> 'goal'),
		'finish',e.finish,'worker',public.qorpera_coding_worker_json(w));
end $$;

create function public.qorpera_claim_coding_execution(p_request_id uuid,p_lease_token uuid,p_orchestrator_id uuid,p_client_claim_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
	r public.qorpera_execution_runs%rowtype; job public.qorpera_runner_jobs%rowtype; claim public.qorpera_runner_job_claims%rowtype;
begin
	perform public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id);
	-- Canonical job first, then company/worker lock order used by native leases.
	select run.* into r from public.qorpera_coding_executions e join public.qorpera_wake_occurrences wake on wake.id=e.occurrence_id
		join public.qorpera_execution_runs run on run.id=wake.run_id where e.request_id=p_request_id;
	if r.id is null then raise exception 'Coding run not admitted' using errcode='55000'; end if;
	select * into strict job from public.qorpera_runner_jobs where id=r.job_id for update;
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
	if p_client_claim_id is null or not exists(select 1 from public.qorpera_coding_executors e
		join public.qorpera_runner_orchestrators o on o.id=e.orchestrator_id and o.status='active'
		where e.environment_id=w.environment_id and e.owner=q.lease_owner and e.enabled and o.id=p_orchestrator_id)
		or r.deadline_at<=clock_timestamp() or not public.qorpera_execution_sponsor_available(r)
		or not public.qorpera_execution_compute_available(r) then raise exception 'Coding execution claim unavailable' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_machine_allocations home
		join public.qorpera_native_provider_login_sessions login on login.id=home.login_session_id and login.status='completed'
		where home.login_compute_identity_id=r.compute_identity_id)
		and not exists(select 1 from public.qorpera_runtime_machine_allocations home
		join public.qorpera_native_provider_login_sessions login on login.id=home.login_session_id and login.status='completed'
		join public.qorpera_runner_orchestrators o on o.id=p_orchestrator_id and o.provider_adapter=home.provider_adapter
		where home.login_compute_identity_id=r.compute_identity_id) then
		raise exception 'Coding identity home unavailable' using errcode='42501'; end if;
	select * into claim from public.qorpera_runner_job_claims where orchestrator_id=p_orchestrator_id and client_claim_id=p_client_claim_id;
	if found then
		if claim.job_id<>job.id or claim.status not in ('claimed','assigned') or claim.lease_expires_at<=clock_timestamp() then
			raise exception 'Coding claim replay differs' using errcode='42501'; end if;
		return public.qorpera_execution_work_json(claim);
	end if;
	if job.status<>'queued' or job.attempt_count>=8 or job.dispatch_failure_count>=8 or exists(select 1 from public.qorpera_runner_job_claims where job_id=job.id and status in ('claimed','assigned')) then
		raise exception 'Coding job already claimed' using errcode='55000'; end if;
	insert into public.qorpera_runner_job_claims(id,orchestrator_id,client_claim_id,job_id,run_id,lease_expires_at)
	values(p_client_claim_id,p_orchestrator_id,p_client_claim_id,job.id,r.id,least(r.deadline_at,clock_timestamp()+interval '120 seconds')) returning * into claim;
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values(r.id,'orchestrator_claimed',jsonb_build_object('orchestrator_id',p_orchestrator_id,'claim_id',claim.id,'coding_request_id',q.id));
	return public.qorpera_execution_work_json(claim);
end $$;

create function public.qorpera_authorize_native_coding_execution(p_binding jsonb,p_request_id uuid,p_worker_id uuid,p_vm_id uuid,p_turn integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_execution_runs%rowtype; q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
	e public.qorpera_coding_executions%rowtype; allocation public.qorpera_runtime_machine_allocations%rowtype;
 authority jsonb; valid_ms integer;
begin
	r:=public.qorpera_native_tool_locked_run(p_binding);
	select * into q from public.qorpera_coding_requests where id=p_request_id;
	q:=public.qorpera_coding_locked_request(p_request_id,q.lease_token);
	select * into w from public.qorpera_coding_workers where id=q.worker_id;
	select * into e from public.qorpera_coding_executions where request_id=q.id;
	if q.id is null or w.id is null or e.request_id is null or q.kind='cancel'
		or q.status<>'leased' or q.lease_until<=clock_timestamp() or q.worker_id is distinct from p_worker_id
		or w.vm_id is distinct from p_vm_id or w.vm_id is null or q.turn is distinct from p_turn or w.turn<>q.turn
		or not exists(select 1 from public.qorpera_wake_occurrences where id=e.occurrence_id and run_id=r.id and source_kind='coding-dispatch') then
		raise exception 'Coding native scope unavailable' using errcode='42501'; end if;
	perform public.qorpera_coding_assert_delegation(w,q.run_id);
	select * into allocation from public.qorpera_runtime_machine_allocations where id=w.vm_id and profile_id=w.company_id
		and coding_worker_id=w.id and runner_id is null and released_at is null for share;
	if not found or not exists(select 1 from public.qorpera_execution_runs origin
		join public.qorpera_wake_occurrences wake on wake.run_id=origin.id and wake.source_kind='coding-dispatch'
		join public.qorpera_coding_requests request on request.id=wake.source_id and request.worker_id=w.id
		where origin.id=allocation.run_id and origin.compute_identity_id=r.compute_identity_id)
		or q.lease_until<=clock_timestamp() then raise exception 'Coding retained VM authority unavailable' using errcode='42501'; end if;
	authority:=public.qorpera_describe_native_tool_authority(p_binding);
 valid_ms:=least((authority->>'validForMs')::integer,floor(extract(epoch from(q.lease_until-clock_timestamp()))*1000)::integer);
 if valid_ms<1 then raise exception 'Coding queue lease expired' using errcode='42501'; end if;
 return authority||jsonb_build_object('validForMs',valid_ms,'coding',jsonb_build_object(
		'requestId',q.id,'workerId',w.id,'vmId',w.vm_id,'turn',q.turn,'repository',w.repository,'branch',w.branch,'parentRunId',q.run_id,
		'dispatch',w.dispatch,'goal',coalesce(q.input ->> 'goal',w.dispatch ->> 'goal'),'finish',e.finish));
end $$;

create function public.qorpera_begin_native_coding_execution(p_binding jsonb,p_request_id uuid,p_worker_id uuid,p_vm_id uuid,p_turn integer,
	p_binary_sha256 text,p_runtime_bundle_sha256 text,p_reasoning_policy_sha256 text,p_tool_catalog_text text,p_context_sha256 text,p_context_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare catalog jsonb;
begin
	perform public.qorpera_authorize_native_coding_execution(p_binding,p_request_id,p_worker_id,p_vm_id,p_turn);
	catalog:=p_tool_catalog_text::jsonb;
	if jsonb_typeof(catalog -> 'tools') is distinct from 'array' then raise exception 'Coding catalog invalid' using errcode='22023'; end if;
	if jsonb_array_length(catalog -> 'tools')<>4
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(catalog -> 'tools') tool)<>4 or exists(select 1 from jsonb_array_elements(catalog -> 'tools') tool
		where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish')) then
		raise exception 'Coding catalog must contain only coding tools' using errcode='42501'; end if;
	return public.qorpera_begin_native_company_execution_v2(p_binding,p_binary_sha256,p_runtime_bundle_sha256,
		p_reasoning_policy_sha256,p_tool_catalog_text,p_context_sha256,p_context_bytes);
end $$;

create function public.qorpera_record_coding_context_view(p_binding jsonb,p_request_id uuid,p_worker_id uuid,p_vm_id uuid,p_turn integer,p_view jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;
begin
	authority:=public.qorpera_authorize_native_coding_execution(p_binding,p_request_id,p_worker_id,p_vm_id,p_turn);
	if jsonb_typeof(p_view -> 'outputs') is distinct from 'array' then raise exception 'Coding context invalid' using errcode='22023'; end if;
	if exists(select 1 from jsonb_array_elements(p_view -> 'outputs') output where output -> 'readId' is distinct from 'null'::jsonb
		or output ? 'capture') then
		raise exception 'Coding context cannot introduce Company File reads' using errcode='42501'; end if;
	return public.qorpera_record_native_context_view((authority #>> '{identity,environmentId}')::uuid,p_binding,p_view);
end $$;

create function public.qorpera_finish_native_coding_execution(p_binding jsonb,p_request_id uuid,p_worker_id uuid,p_vm_id uuid,p_turn integer,p_finish jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.qorpera_coding_executions%rowtype; receipt uuid:=extensions.gen_random_uuid(); digest text; response jsonb;
begin
	perform public.qorpera_authorize_native_coding_execution(p_binding,p_request_id,p_worker_id,p_vm_id,p_turn);
	if jsonb_typeof(p_finish) is distinct from 'object' or p_finish-array['operationKey','summary','headSha']<>'{}'::jsonb
		or jsonb_typeof(p_finish -> 'operationKey') is distinct from 'string' or coalesce(p_finish ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or jsonb_typeof(p_finish -> 'summary') is distinct from 'string' or btrim(p_finish ->> 'summary')='' or octet_length(p_finish ->> 'summary')>4000
		or coalesce(p_finish ->> 'headSha','') !~ '^[0-9a-f]{40}$' then raise exception 'Coding finish invalid' using errcode='22023'; end if;
	select * into strict e from public.qorpera_coding_executions where request_id=p_request_id for update;
	response:=jsonb_build_object('schema','qorpera.coding-finish/v1','requestId',p_request_id,'workerId',p_worker_id,'turn',p_turn,
		'state','ready-to-publish','summary',p_finish ->> 'summary','headSha',p_finish ->> 'headSha');
	if e.finish is not null then
		if e.finish<>response or e.finish_operation_key<>p_finish ->> 'operationKey' then raise exception 'Coding finish replay differs' using errcode='23505'; end if;
		return e.finish;
	end if;
	digest:=encode(extensions.digest(p_finish::text,'sha256'),'hex');
	perform public.qorpera_begin_native_tool_operation(p_binding,receipt,'coding-finish:'||(p_finish ->> 'operationKey'),digest,digest,false);
	perform public.qorpera_complete_native_tool_operation(p_binding,receipt,digest,response);
	update public.qorpera_coding_executions set finish=response,finish_receipt_id=receipt,finish_operation_key=p_finish ->> 'operationKey' where request_id=p_request_id;
	return response;
end $$;

revoke all on function public.qorpera_bind_coding_executor_orchestrator(uuid,text,uuid),
	public.qorpera_coding_dispatch_ancestry(public.qorpera_wake_occurrences),public.qorpera_prepare_coding_execution(uuid,uuid),
	public.qorpera_describe_coding_execution(uuid,uuid),public.qorpera_claim_coding_execution(uuid,uuid,uuid,uuid),
	public.qorpera_authorize_native_coding_execution(jsonb,uuid,uuid,uuid,integer),
	public.qorpera_begin_native_coding_execution(jsonb,uuid,uuid,uuid,integer,text,text,text,text,text,integer),
	public.qorpera_record_coding_context_view(jsonb,uuid,uuid,uuid,integer,jsonb),
	public.qorpera_finish_native_coding_execution(jsonb,uuid,uuid,uuid,integer,jsonb)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_bind_coding_executor_orchestrator(uuid,text,uuid),
	public.qorpera_prepare_coding_execution(uuid,uuid),public.qorpera_describe_coding_execution(uuid,uuid),
	public.qorpera_claim_coding_execution(uuid,uuid,uuid,uuid),public.qorpera_authorize_native_coding_execution(jsonb,uuid,uuid,uuid,integer),
	public.qorpera_begin_native_coding_execution(jsonb,uuid,uuid,uuid,integer,text,text,text,text,text,integer),
	public.qorpera_record_coding_context_view(jsonb,uuid,uuid,uuid,integer,jsonb),
	public.qorpera_finish_native_coding_execution(jsonb,uuid,uuid,uuid,integer,jsonb) to service_role;
do $$ declare owner_name name; begin
	for owner_name in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
		'public.qorpera_pin_wake_occurrence()'::regprocedure,'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure]) loop
		execute format('grant execute on function public.qorpera_coding_dispatch_ancestry(public.qorpera_wake_occurrences) to %I',owner_name);
	end loop;
end $$;

-- Repository VMs carry no native runner or credential identity. They consume
-- the same company and node capacity ledger as the separate decision VM. The
-- existing job, office, login and account-refresh sources keep their exact rule.
alter table public.qorpera_runtime_machine_allocations
 add column coding_worker_id uuid unique references public.qorpera_coding_workers(id) on delete restrict,
 drop constraint qorpera_runtime_machine_allocation_source,
 add constraint qorpera_runtime_machine_allocation_source check(
  (coding_worker_id is null and ((run_id is not null and runner_id is not null and office_id is null and computer_generation is null
    and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
   or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
    and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
   or (run_id is null and runner_id is null and office_id is null and computer_generation is null
    and num_nonnulls(login_session_id,account_refresh_request_id)=1 and login_compute_identity_id is not null)))
  or (coding_worker_id is not null and run_id is not null and runner_id is null and office_id is null and computer_generation is null
   and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null));
alter table public.qorpera_runtime_node_providers
 drop constraint qorpera_runtime_node_providers_provider_kind_check,
 drop constraint qorpera_runtime_node_providers_check,
 add constraint qorpera_runtime_node_providers_provider_kind_check check(provider_kind in ('native','office','login','coding')),
 add constraint qorpera_runtime_node_providers_check check((provider_kind in ('native','login','coding') and provider_id ~ '^[a-z][a-z0-9_-]{0,63}$')
  or (provider_kind='office' and provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
select pg_temp.coding_execution_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
 $old$p_provider_kind not in ('native','office','login')$old$,$new$p_provider_kind not in ('native','office','login','coding')$new$);
select pg_temp.coding_execution_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
 $old$or (p_provider_kind='native' and$old$,
 $new$or (p_provider_kind='coding' and (v_allocation.coding_worker_id is null or v_allocation.runner_id is not null or v_allocation.provider_adapter<>p_provider_id))
  or (p_provider_kind='native' and$new$);
alter table public.qorpera_coding_executors add column vm_policy jsonb;
create table public.qorpera_coding_vm_plans (
 worker_id uuid primary key references public.qorpera_coding_workers(id) on delete restrict,
 allocation_id uuid not null unique,
 binding jsonb not null,
 instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$')
);
alter table public.qorpera_coding_vm_plans enable row level security;
revoke all on public.qorpera_coding_vm_plans from public,anon,authenticated,service_role,qorpera_secret_broker;

-- This is trusted deployment configuration, not an image signature verifier.
-- The deployment verifier must check signed image/bootstrap and isolation
-- acceptance before provisioning these exact values. No default is installed.
create function public.qorpera_configure_coding_vm_policy(p_environment_id uuid,p_owner text,p_policy jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_policy) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_policy))<>10
  or p_policy-array['providerId','providerPolicySha256','project','imageFingerprint','bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']<>'{}'::jsonb
  or coalesce(p_policy->>'providerId','') !~ '^[a-z][a-z0-9_-]{0,63}$'
  or exists(select 1 from unnest(array['providerPolicySha256','imageFingerprint','bootstrapSha256']) k where coalesce(p_policy->>k,'') !~ '^[0-9a-f]{64}$')
  or exists(select 1 from unnest(array['project','storagePool','network']) k where coalesce(p_policy->>k,'') !~ '^[a-z][a-z0-9-]{0,62}$')
  or exists(select 1 from unnest(array['cpus','memoryBytes','rootDiskBytes']) k where jsonb_typeof(p_policy->k) is distinct from 'number' or coalesce(p_policy->>k,'') !~ '^[1-9][0-9]{0,12}$')
  then raise exception 'Coding VM policy invalid' using errcode='22023'; end if;
 if (p_policy->>'cpus')::bigint>64 or (p_policy->>'memoryBytes')::bigint>1099511627776 or (p_policy->>'rootDiskBytes')::bigint>1099511627776 then
  raise exception 'Coding VM policy exceeds bound' using errcode='22023'; end if;
 update public.qorpera_coding_executors set vm_policy=p_policy where environment_id=p_environment_id and owner=p_owner;
 if not found then raise exception 'Coding executor unavailable' using errcode='42501'; end if;
end $$;

create function public.qorpera_authorize_coding_machine(p_request_id uuid,p_lease_token uuid,p_binding_text text,p_machine_id_sha256 text,p_intent text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype; r public.qorpera_execution_runs%rowtype;
 plan public.qorpera_coding_vm_plans%rowtype; a public.qorpera_runtime_machine_allocations%rowtype;
 binding jsonb; policy jsonb; digest text; allocation uuid; node jsonb; ceiling integer; occupied bigint; valid_ms integer;
begin
 if octet_length(p_binding_text)>16384 or p_intent is null or p_intent not in ('run','stop') then raise exception 'Coding machine input invalid' using errcode='22023'; end if;
 binding:=p_binding_text::jsonb; digest:=encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex');
 select run.* into r from public.qorpera_coding_executions e join public.qorpera_wake_occurrences wake on wake.id=e.occurrence_id
  join public.qorpera_execution_runs run on run.id=wake.run_id where e.request_id=p_request_id;
 -- Keep native job -> company -> worker ordering. Cancellation has no new native run.
 if r.id is not null then perform 1 from public.qorpera_runner_jobs where id=r.job_id for update; end if;
 q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
 select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
 if jsonb_typeof(binding) is distinct from 'object' or binding->>'schema' is distinct from 'qorpera.lxd-coding-vm/v1'
  or binding->>'workerId' is distinct from w.id::text or binding->>'companyId' is distinct from w.company_id::text
  or binding->>'environmentId' is distinct from w.environment_id::text or binding->'repository' is distinct from w.repository
  or coalesce(binding->>'allocationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception 'Coding machine scope differs' using errcode='42501'; end if;
 allocation:=(binding->>'allocationId')::uuid;
 select * into plan from public.qorpera_coding_vm_plans where worker_id=w.id for update;
 if found and (plan.allocation_id<>allocation or plan.binding<>binding or plan.instance_sha256<>digest) then
  raise exception 'Coding machine plan cannot be rebound' using errcode='42501'; end if;
 if p_intent='run' then
  if q.kind='cancel' or r.id is null or not public.qorpera_execution_compute_available(r)
   or ((r.deadline_at<=clock_timestamp() or not public.qorpera_execution_sponsor_available(r)) and not exists(
    select 1 from public.qorpera_coding_executions e join public.qorpera_runner_jobs j on j.id=r.job_id and j.status='completed'
    join public.qorpera_run_operation_receipts receipt on receipt.id=e.finish_receipt_id and receipt.run_id=r.id and receipt.status='completed'
    where e.request_id=q.id and e.finish is not null and receipt.result=e.finish)) then
   raise exception 'Coding machine execution unavailable' using errcode='42501'; end if;
  -- A finished native turn has settled its model reservation. Its exact durable
  -- finish permits trusted export/publication under this still-live queue lease;
  -- it does not revive the native model lease or authorize another command.
  select vm_policy into policy from public.qorpera_coding_executors where environment_id=w.environment_id and owner=q.lease_owner and enabled for share;
  if policy is null or binding-array['schema','workerId','allocationId','companyId','environmentId','repository']<>policy then
   raise exception 'Coding machine deployment policy unavailable' using errcode='42501'; end if;
  if plan.worker_id is null then
   insert into public.qorpera_coding_vm_plans(worker_id,allocation_id,binding,instance_sha256) values(w.id,allocation,binding,digest);
  end if;
 end if;
 select * into a from public.qorpera_runtime_machine_allocations where id=allocation for update;
 if found then
  if a.profile_id<>w.company_id or a.coding_worker_id is distinct from w.id or a.runner_id is not null
   or a.provider_adapter<>binding->>'providerId' or a.instance_sha256<>digest or a.released_at is not null then
   raise exception 'Coding allocation cannot be rebound or revived' using errcode='42501'; end if;
 elsif p_intent='stop' then raise exception 'Coding cleanup custody unavailable' using errcode='42501';
 else
  if w.vm_id is not null then raise exception 'Coding retained allocation missing' using errcode='42501'; end if;
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=w.company_id),8) into ceiling;
  select count(*) into occupied from public.qorpera_runtime_machine_allocations where profile_id=w.company_id and released_at is null;
  if occupied>=ceiling then
   insert into public.qorpera_runtime_machine_refusals(allocation_id,profile_id,used,ceiling)
    values(allocation,w.company_id,occupied,ceiling) on conflict(allocation_id) do nothing;
   if found then
    insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
    select w.company_id,user_id,'company_ceiling_tripped',jsonb_build_object('schema','qorpera.member-notification.machine-capacity/v1',
     'dimension','machines','used',occupied,'ceiling',ceiling,'allocationId',allocation),'machines:'||allocation::text
    from public.qorpera_profile_members where profile_id=w.company_id and role in ('owner','admin')
    on conflict(profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
   end if;
   return '{"state":"refused","reason":"MACHINE_CAPACITY_EXHAUSTED"}'::jsonb;
  end if;
  insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,coding_worker_id,provider_adapter,instance_sha256)
   values(allocation,w.company_id,r.id,w.id,binding->>'providerId',digest) returning * into a;
 end if;
 if w.vm_id is null then
  update public.qorpera_coding_workers set vm_id=allocation,version=version+1,updated_at=clock_timestamp() where id=w.id returning * into w;
 elsif w.vm_id<>allocation then raise exception 'Coding worker allocation differs' using errcode='42501'; end if;
 if p_intent='run' then
  node:=public.qorpera_reserve_runtime_node_machine(allocation,'coding',binding->>'providerId',binding->>'providerPolicySha256',digest,
   p_machine_id_sha256,(binding->>'cpus')::bigint*1000,(binding->>'memoryBytes')::bigint);
  if node->>'state'<>'reserved' then return node; end if;
 else
  -- Stop remains available for the exact retained allocation after a repository
  -- grant is revoked. It cannot create, move, resize or resume a machine.
  select jsonb_build_object('nodeId',n.id,'nodeVersion',n.version,'validForMs',5000) into node
   from public.qorpera_runtime_node_demands d join public.qorpera_runtime_nodes n on n.id=d.node_id
   where d.allocation_id=allocation and d.provider_kind='coding' and d.policy_sha256=binding->>'providerPolicySha256'
    and d.released_at is null and n.machine_id_sha256=p_machine_id_sha256;
  if node is null then raise exception 'Coding cleanup node custody unavailable' using errcode='42501'; end if;
 end if;
 valid_ms:=least((node->>'validForMs')::integer,floor(extract(epoch from q.lease_until-clock_timestamp())*1000)::integer);
 if valid_ms<1 then raise exception 'Coding lease expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.coding-vm-admission/v1','workerId',w.id,'allocationId',allocation,
  'instanceSha256',digest,'intent',p_intent,'validForMs',valid_ms,'nodeId',node->'nodeId','nodeVersion',node->'nodeVersion');
end $$;

create function public.qorpera_resolve_native_coding_scope(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_execution_runs%rowtype; q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
begin
 r:=public.qorpera_native_tool_locked_run(p_binding);
 select request.* into q from public.qorpera_coding_executions e join public.qorpera_wake_occurrences wake on wake.id=e.occurrence_id
  join public.qorpera_coding_requests request on request.id=e.request_id where wake.run_id=r.id;
 select * into w from public.qorpera_coding_workers where id=q.worker_id;
 if w.id is null then raise exception 'Native coding scope unavailable' using errcode='42501'; end if;
 return public.qorpera_authorize_native_coding_execution(p_binding,q.id,w.id,w.vm_id,q.turn);
end $$;

create function public.qorpera_authorize_coding_command(p_binding jsonb,p_scope jsonb,p_action text,p_command_id uuid,p_input_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb; receipt public.qorpera_run_operation_receipts%rowtype;
begin
 if jsonb_typeof(p_scope) is distinct from 'object' or p_scope-array['requestId','workerId','vmId','turn']<>'{}'::jsonb
  or p_action is null or p_action not in ('start','read','cancel') then raise exception 'Coding command scope invalid' using errcode='22023'; end if;
 authority:=public.qorpera_authorize_native_coding_execution(p_binding,(p_scope->>'requestId')::uuid,(p_scope->>'workerId')::uuid,
  (p_scope->>'vmId')::uuid,(p_scope->>'turn')::integer);
 select * into receipt from public.qorpera_run_operation_receipts where id=p_command_id;
 if not found or receipt.operation_kind<>'cloud_tool' or left(receipt.logical_operation_key,length('coding_run_command:'))<>'coding_run_command:'
  or receipt.requires_company_revision
  or not exists(select 1 from public.qorpera_coding_executions e join public.qorpera_wake_occurrences wake on wake.id=e.occurrence_id
   join public.qorpera_coding_requests q on q.id=e.request_id where wake.run_id=receipt.run_id and q.worker_id=(p_scope->>'workerId')::uuid)
  or (p_action='start' and (receipt.status not in ('executing','completed') or receipt.run_id<>(p_binding->>'runId')::uuid or receipt.input_sha256 is distinct from p_input_sha256
   or authority#>'{coding,finish}' is distinct from 'null'::jsonb)) then
  raise exception 'Coding command authority unavailable' using errcode='42501'; end if;
 return jsonb_build_object('authority',authority,'inputSha256',receipt.input_sha256,
  'operationKey',substring(receipt.logical_operation_key from length('coding_run_command:')+1));
end $$;
revoke all on function public.qorpera_configure_coding_vm_policy(uuid,text,jsonb),public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text),
 public.qorpera_resolve_native_coding_scope(jsonb),public.qorpera_authorize_coding_command(jsonb,jsonb,text,uuid,text)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_configure_coding_vm_policy(uuid,text,jsonb),public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text),
 public.qorpera_resolve_native_coding_scope(jsonb),public.qorpera_authorize_coding_command(jsonb,jsonb,text,uuid,text) to service_role;

-- Cleanup custody survives the expiring execution lease. The old token never
-- grants resume, destruction, replacement, or release of retained capacity.
create function public.qorpera_authorize_coding_cleanup(p_request_id uuid,p_lease_token uuid,p_owner text,p_binding_text text,p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
 plan public.qorpera_coding_vm_plans%rowtype; a public.qorpera_runtime_machine_allocations%rowtype;
 binding jsonb; digest text; node jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_lease_token is null or p_owner is null or octet_length(p_binding_text)>16384 then
  raise exception 'Coding cleanup custody required' using errcode='42501'; end if;
 select * into q from public.qorpera_coding_requests where id=p_request_id;
 select * into w from public.qorpera_coding_workers where id=q.worker_id;
 if w.id is null then raise exception 'Coding cleanup custody unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(w.company_id);
 select * into strict w from public.qorpera_coding_workers where id=w.id for update;
 select * into strict q from public.qorpera_coding_requests where id=p_request_id for update;
 if q.lease_token is distinct from p_lease_token or q.lease_owner is distinct from p_owner then
  raise exception 'Coding cleanup request custody differs' using errcode='42501'; end if;
 if exists(select 1 from public.qorpera_coding_requests newer where newer.worker_id=w.id and newer.id<>q.id
  and newer.created_at>q.created_at and newer.kind<>'cancel' and newer.status='leased' and newer.lease_until>clock_timestamp()) then
  raise exception 'Coding cleanup custody superseded by an active turn' using errcode='42501'; end if;
 binding:=p_binding_text::jsonb; digest:=encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex');
 select * into plan from public.qorpera_coding_vm_plans where worker_id=w.id for share;
 select * into a from public.qorpera_runtime_machine_allocations where id=w.vm_id for share;
 if plan.worker_id is null or plan.binding is distinct from binding or plan.instance_sha256 is distinct from digest
  or plan.allocation_id is distinct from w.vm_id or a.id is null or a.coding_worker_id is distinct from w.id
  or a.profile_id<>w.company_id or a.runner_id is not null or a.instance_sha256<>digest or a.released_at is not null then
  raise exception 'Coding cleanup allocation custody differs' using errcode='42501'; end if;
 select jsonb_build_object('nodeId',n.id,'nodeVersion',n.version) into node
  from public.qorpera_runtime_node_demands d join public.qorpera_runtime_nodes n on n.id=d.node_id
  where d.allocation_id=a.id and d.provider_kind='coding' and d.provider_id=a.provider_adapter
   and d.policy_sha256=binding->>'providerPolicySha256' and d.released_at is null and n.machine_id_sha256=p_machine_id_sha256;
 if node is null then raise exception 'Coding cleanup node custody differs' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.coding-vm-admission/v1','workerId',w.id,'allocationId',a.id,
  'instanceSha256',digest,'intent','stop','validForMs',5000,'nodeId',node->'nodeId','nodeVersion',node->'nodeVersion');
end $$;
revoke all on function public.qorpera_authorize_coding_cleanup(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_authorize_coding_cleanup(uuid,uuid,text,text,text) to service_role;
