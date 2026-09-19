-- A coding provider completion has its own durable listener and wake source.
-- Creating a wake and consuming its outbox event are one transaction. This
-- does not make provider output an instruction or create a public audience.
alter table public.qorpera_coding_completions
	add column delivery_state text not null default 'pending' check(delivery_state in ('pending','delivered','cancelled')),
	add column scanned_at timestamptz not null default '-infinity',
	add column occurrence_id uuid unique references public.qorpera_wake_occurrences(id) on delete restrict,
	add column delivered_at timestamptz,
	add check((delivery_state='delivered')=(occurrence_id is not null)),
	add check((delivery_state='delivered')=(delivered_at is not null));
create index qorpera_coding_completion_delivery on public.qorpera_coding_completions(scanned_at,created_at,id)
	where delivery_state='pending';
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
	check(source_kind in ('input','schedule','company-file','coworker','room','office-activation','coding-completion'));

create function public.qorpera_coding_completion_payload(p_event public.qorpera_coding_completions)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-completion/v1','eventId',p_event.id,
		'requestId',q.id,'workerId',q.worker_id,'turn',q.turn,'receiptId',q.receipt_id,
		'worker',p_event.payload->'worker','result',coalesce(p_event.payload->'result',
			jsonb_build_object('reason',p_event.payload->>'reason')))
	from public.qorpera_coding_requests q where q.id=p_event.request_id
$$;

create function public.qorpera_coding_completion_authorized(p_event public.qorpera_coding_completions)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare w public.qorpera_coding_workers%rowtype; q public.qorpera_coding_requests%rowtype;
	r public.qorpera_execution_runs%rowtype; parent_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into w from public.qorpera_coding_workers where id=p_event.worker_id;
	-- Wake effect validators may already hold staff or job locks. Obtain the
	-- common profile/File fences without waiting before delegation reads; a
	-- contended editor retries instead of forming a reverse lock dependency.
	perform 1 from public.qorpera_profiles where id=w.company_id for update nowait;
	if not found then return false; end if;
	perform 1 from public.qorpera_company_wake_admission_fences where profile_id=w.company_id for update nowait;
	perform 1 from public.qorpera_company_files where environment_id=w.environment_id for update nowait;
	if not found then return false; end if;
	select * into q from public.qorpera_coding_requests where id=p_event.request_id;
	select * into r from public.qorpera_execution_runs where id=p_event.parent_run_id;
	if w.id is null or q.id is null or r.id is null or p_event.delivery_state='cancelled'
		or q.worker_id<>w.id or q.run_id<>r.id or q.status not in ('completed','recovery-required')
		or r.profile_id<>w.company_id or r.environment_id<>w.environment_id or r.staff_agent_id<>w.parent_agent_id
		or (p_event.payload#>>'{worker,id}') is distinct from w.id::text
		or (p_event.payload#>>'{worker,parentRunId}') is distinct from w.parent_run_id::text
		or (p_event.payload#>>'{worker,turn}') is distinct from q.turn::text
		-- The existing agent wake has no private-member audience. Refuse rather
		-- than widening a private coding result to company scope.
		or r.audience_kind<>'company' or r.audience_user_id is not null
		or not exists(select 1 from public.qorpera_runner_jobs where id=r.job_id and status='completed')
		or public.qorpera_company_execution_paused(r.profile_id) then return false; end if;
	-- Bound mixed internal continuations before recursively checking their
	-- source authority. Historical completed parents need no execution lease.
	if exists(with recursive ancestry(run_id,depth) as (
		select r.id,1 union all select wake.parent_run_id,a.depth+1 from ancestry a
		join public.qorpera_wake_occurrences wake on wake.run_id=a.run_id
		where wake.source_kind in ('office-activation','coding-completion') and a.depth<9
	) select 1 from ancestry where depth=9) then return false; end if;
	perform public.qorpera_coding_assert_delegation(w,r.id);
	select * into parent_wake from public.qorpera_wake_occurrences where run_id=r.id;
	if not found or not public.qorpera_wake_authorized(parent_wake)
		or public.qorpera_runtime_wake_policy_internal(r.id)->>'kind' is distinct from parent_wake.wake_kind
		or not exists(select 1 from public.qorpera_run_operation_receipts where id=q.receipt_id and run_id=r.id
			and status='completed' and operation_kind='cloud_tool' and logical_operation_key='coding:'||q.operation_key
			and not requires_company_revision)
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id=r.id
			and (status<>'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
				or (requires_company_revision and output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null)))
		then return false; end if;
	return true;
exception when insufficient_privilege or no_data_found then return false;
end $$;

create function public.qorpera_coding_completion_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e public.qorpera_coding_completions%rowtype; q public.qorpera_coding_requests%rowtype;
	r public.qorpera_execution_runs%rowtype; source public.qorpera_wake_occurrences%rowtype;
begin
	select * into e from public.qorpera_coding_completions where id=p_wake.source_id;
	select * into q from public.qorpera_coding_requests where id=e.request_id;
	select * into r from public.qorpera_execution_runs where id=e.parent_run_id;
	select * into source from public.qorpera_wake_occurrences where run_id=r.id;
	if e.id is null or q.id is null or r.id is null or source.id is null
		or p_wake.source_kind<>'coding-completion' or p_wake.wake_kind<>'agent'
		or p_wake.parent_run_id is distinct from r.id or p_wake.profile_id is distinct from r.profile_id
		or p_wake.environment_id is distinct from r.environment_id or p_wake.staff_agent_id is distinct from r.staff_agent_id
		or p_wake.requested_by_user_id is distinct from r.requested_by_user_id
		or p_wake.sponsor_binding_id is distinct from r.sponsor_binding_id
		or public.qorpera_wake_standing_sponsor_version(p_wake) is distinct from r.sponsor_version
		or p_wake.logical_computer_id is distinct from r.logical_computer_id
		or p_wake.session_id is not null or p_wake.file_event_id is not null
		or p_wake.trigger_id is distinct from 'coding-completion'
		or p_wake.occurrence_key is distinct from 'coding-completion:'||e.worker_id::text||':'||q.turn::text||':'||q.id::text
		or p_wake.payload is distinct from public.qorpera_coding_completion_payload(e)
		or (e.occurrence_id is not null and e.occurrence_id<>p_wake.id)
		or not public.qorpera_coding_completion_authorized(e)
		or source.causal_root_id is null or cardinality(source.causal_agent_ids) not between 1 and 16
		or source.causal_agent_ids[cardinality(source.causal_agent_ids)] is distinct from r.staff_agent_id then return null; end if;
	return jsonb_build_object('rootId',source.causal_root_id,'agentIds',to_jsonb(source.causal_agent_ids));
end $$;

create function public.qorpera_deliver_coding_completion(p_event_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e public.qorpera_coding_completions%rowtype; w public.qorpera_coding_workers%rowtype;
	q public.qorpera_coding_requests%rowtype; r public.qorpera_execution_runs%rowtype; occurrence uuid;
begin
	if auth.role() is distinct from 'service_role' or p_event_id is null then
		raise exception 'Coding listener authority required' using errcode='42501'; end if;
	select * into strict e from public.qorpera_coding_completions where id=p_event_id;
	select * into strict w from public.qorpera_coding_workers where id=e.worker_id;
	-- Match parent steering/executor lock order. No provider or cloud endpoint
	-- is called while this database transaction holds the allocation identity.
	perform public.qorpera_lock_profile_gc_fence(w.company_id);
	perform public.qorpera_serialize_wake_admission(w.company_id);
	perform 1 from public.qorpera_company_files where environment_id=w.environment_id for update;
	select * into strict w from public.qorpera_coding_workers where id=w.id for update;
	select * into strict q from public.qorpera_coding_requests where id=e.request_id for update;
	select * into strict e from public.qorpera_coding_completions where id=p_event_id for update;
	select * into strict r from public.qorpera_execution_runs where id=e.parent_run_id;
	if e.delivery_state='pending' then
		if public.qorpera_company_execution_paused(w.company_id)
			or exists(select 1 from public.qorpera_runner_jobs where id=r.job_id and status not in ('completed','failed','cancelled')) then
			return jsonb_build_object('schema','qorpera.coding-completion-delivery/v1','eventId',e.id,'status','pending','occurrenceId',null);
		end if;
		if w.turn<>q.turn or w.version::text is distinct from e.payload#>>'{worker,version}'
			or not public.qorpera_coding_completion_authorized(e) then
			update public.qorpera_coding_completions set delivery_state='cancelled' where id=e.id returning * into e;
		else
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
				staff_agent_id,parent_run_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
			values(extensions.gen_random_uuid(),r.profile_id,r.environment_id,'agent','coding-completion',e.id,r.staff_agent_id,r.id,'coding-completion',
				'coding-completion:'||w.id::text||':'||q.turn::text||':'||q.id::text,e.created_at,clock_timestamp(),
				public.qorpera_coding_completion_payload(e)) returning id into occurrence;
			update public.qorpera_coding_completions set delivery_state='delivered',occurrence_id=occurrence,delivered_at=clock_timestamp()
				where id=e.id returning * into e;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.coding-completion-delivery/v1','eventId',e.id,
		'status',e.delivery_state,'occurrenceId',e.occurrence_id);
end $$;

create function pg_temp.coding_wake_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare definition text:=pg_get_functiondef(p_target);
begin
	if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Coding wake integration differs: %',p_target; end if;
	execute replace(definition,p_old,p_new);
end $$;

select pg_temp.coding_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$new.source_kind not in ('coworker','office-activation')$old$,
	$new$new.source_kind not in ('coworker','office-activation','coding-completion')$new$);
select pg_temp.coding_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;$old$,
	$new$if new.source_kind='coding-completion' then
   new.sponsor_binding_id:=v_run.sponsor_binding_id; new.sponsor_version:=v_run.sponsor_version;
   new.logical_computer_id:=v_run.logical_computer_id;
  else
   select * into strict v_authority from public.qorpera_staff_execution_authorities
   where profile_id=new.profile_id and staff_agent_id=new.staff_agent_id for share;
   new.sponsor_binding_id:=v_authority.sponsor_binding_id; new.sponsor_version:=v_authority.sponsor_version;
   new.logical_computer_id:=v_authority.logical_computer_id;
  end if;
  new.session_id:=null;$new$);
select pg_temp.coding_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$if new.source_kind='office-activation' then$old$,
	$new$if new.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(new);
 elsif new.source_kind='office-activation' then$new$);
select pg_temp.coding_wake_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$if not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id$old$,
	$new$if p_wake.source_kind<>'coding-completion' and not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id$new$);
select pg_temp.coding_wake_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$if p_wake.source_kind='office-activation' then$old$,
	$new$if p_wake.source_kind='coding-completion' then v_ancestry:=public.qorpera_coding_completion_ancestry(p_wake);
 elsif p_wake.source_kind='office-activation' then$new$);
select pg_temp.coding_wake_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$v_wake.source_kind in ('coworker','office-activation')$old$,
	$new$v_wake.source_kind in ('coworker','office-activation','coding-completion')$new$);
select pg_temp.coding_wake_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$if v_wake.source_kind='office-activation' then v_sender:=null; v_actor_user:=null; end if;$old$,
	$new$if v_wake.source_kind in ('office-activation','coding-completion') then v_sender:=null; v_actor_user:=null; end if;$new$);
select pg_temp.coding_wake_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$elsif v_wake.source_kind='office-activation' then$old$,
	$new$elsif v_wake.source_kind in ('office-activation','coding-completion') then$new$);

-- Pull-style service listener inspects only pending events. Fair durable scan
-- rotation happens before returning the batch, so a lost response, poisoned
-- delivery or still-running parent cannot keep the oldest batch at the front.
-- No event is consumed here; only the atomic delivery RPC may acknowledge it.
create or replace function public.qorpera_read_coding_completions(p_owner text,p_limit integer default 50)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare result jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding listener authority required' using errcode='42501'; end if;
	if p_limit is null or p_limit not between 1 and 100 then raise exception 'Coding listener limit invalid' using errcode='22023'; end if;
	with selected as (
		select c.id from public.qorpera_coding_completions c
		join public.qorpera_coding_workers w on w.id=c.worker_id
		join public.qorpera_coding_executors e on e.environment_id=w.environment_id and e.owner=p_owner
		where c.delivery_state='pending' order by c.scanned_at,c.created_at,c.id
		for update of c skip locked limit p_limit
	), scanned as (
		update public.qorpera_coding_completions c set scanned_at=clock_timestamp()
		from selected where c.id=selected.id
		returning c.id,c.request_id,c.worker_id,c.parent_run_id,c.payload,c.created_at
	)
	select coalesce(jsonb_agg(scanned order by created_at,id),'[]'::jsonb) into result from scanned;
	return result;
end $$;

create function public.qorpera_coding_run_continuation(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare wake public.qorpera_wake_occurrences%rowtype; parent public.qorpera_execution_runs%rowtype;
	inputs jsonb; result jsonb;
begin
	select * into wake from public.qorpera_wake_occurrences where run_id=p_run.id and source_kind='coding-completion';
	if not found then return null; end if;
	select * into strict parent from public.qorpera_execution_runs where id=wake.parent_run_id
		and profile_id=p_run.profile_id and environment_id=p_run.environment_id and staff_agent_id=p_run.staff_agent_id
		and requested_by_user_id=p_run.requested_by_user_id and audience_kind='company';
	select coalesce(jsonb_agg(public.qorpera_company_context_source(parent,'input',input_id) order by ordinal),'[]')
		into inputs from unnest(parent.input_ids) with ordinality ids(input_id,ordinal);
	result:=jsonb_build_object('schema','qorpera.coding-continuation/v1','runId',p_run.id,'parentRunId',parent.id,
		'completion',wake.payload,'parentInputs',inputs,'parentJob',public.qorpera_company_context_source(parent,'job',parent.id),
		'parentContinuation',public.qorpera_run_continuation(parent));
	if octet_length(result::text)>33554432 then raise exception 'Coding continuation exceeds its bound' using errcode='54000'; end if;
	return result;
end $$;
select pg_temp.coding_wake_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$if not found then return public.qorpera_office_run_continuation(p_run); end if;$old$,
	$new$if not found then return coalesce(public.qorpera_coding_run_continuation(p_run),public.qorpera_office_run_continuation(p_run)); end if;$new$);
select pg_temp.coding_wake_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$'officeStart',public.qorpera_office_run_continuation(p_run));$old$,
	$new$'officeStart',public.qorpera_office_run_continuation(p_run),'coding',public.qorpera_coding_run_continuation(p_run));$new$);

revoke all on function public.qorpera_coding_completion_payload(public.qorpera_coding_completions),
	public.qorpera_coding_completion_authorized(public.qorpera_coding_completions),
	public.qorpera_coding_completion_ancestry(public.qorpera_wake_occurrences),
	public.qorpera_coding_run_continuation(public.qorpera_execution_runs),
	public.qorpera_deliver_coding_completion(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_deliver_coding_completion(uuid) to service_role;
do $$ declare owner_name name; begin
	for owner_name in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure
	]) loop
		if owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Coding wake function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_coding_completion_payload(public.qorpera_coding_completions),
   public.qorpera_coding_completion_authorized(public.qorpera_coding_completions),
   public.qorpera_coding_completion_ancestry(public.qorpera_wake_occurrences),
   public.qorpera_coding_run_continuation(public.qorpera_execution_runs) to %I',owner_name);
	end loop;
end $$;
