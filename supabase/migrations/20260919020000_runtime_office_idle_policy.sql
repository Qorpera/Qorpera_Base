-- Server-owned demand and repeated idle stop/resume. Authentication presence
-- and durable open desktop rows are deliberately not power demand.
create table public.qorpera_runtime_office_idle_policies (
	office_id uuid primary key references public.qorpera_runtime_offices(id) on delete restrict,
	idle_since timestamptz,
	activation_id uuid,
	idle_ms integer not null check(idle_ms between 60000 and 86400000)
);
create table public.qorpera_runtime_office_idle_cycles (
	transition_id uuid primary key references public.qorpera_runtime_office_lifecycle_transitions(id) on delete restrict,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null,
	request jsonb not null,
	requested_at timestamptz not null default clock_timestamp(),
	wake_requested_at timestamptz,
	activated_at timestamptz,
	superseded_at timestamptz
);
create index qorpera_office_idle_cycle_latest on public.qorpera_runtime_office_idle_cycles(office_id,computer_generation,requested_at desc);
alter table public.qorpera_runtime_office_idle_policies enable row level security;
alter table public.qorpera_runtime_office_idle_cycles enable row level security;
revoke all on public.qorpera_runtime_office_idle_policies,public.qorpera_runtime_office_idle_cycles from public,anon,authenticated,service_role;

create function public.qorpera_runtime_office_idle_pending(p_office public.qorpera_runtime_offices)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_office.state='maintenance' and exists (
		select 1 from public.qorpera_runtime_office_idle_cycles c
		where c.office_id=p_office.id and c.computer_generation=p_office.generation and c.activated_at is null and c.superseded_at is null
		and not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions t
			where t.office_id=c.office_id and t.computer_generation=c.computer_generation and t.id<>c.transition_id and t.requested_at>c.requested_at)
	)
$$;

-- Called while the office is locked. Resource rows that have not physically
-- drained remain demand even after expiry; time alone cannot prove cleanup.
create function public.qorpera_runtime_office_has_demand(p_office public.qorpera_runtime_offices)
returns boolean language sql volatile security definer set search_path = '' as $$
	select p_office.privacy_state<>'shared'
		or exists(select 1 from public.qorpera_runtime_office_screens s where s.office_id=p_office.id
			and (s.drain_pending or s.takeover_user_id is not null or s.lease_id is not null))
		or exists(select 1 from public.qorpera_runtime_office_resources r where r.office_id=p_office.id and r.state<>'drained')
		or exists(select 1 from public.qorpera_runtime_office_viewers v where v.office_id=p_office.id
			and v.state<>'ended' and (v.expires_at>clock_timestamp() or v.mode='control' or v.state='draining'))
		-- Tool discovery precedes the first guest lease. Retain a warm office for
		-- its currently authorized turns, including routines while members are away.
		or exists(select 1 from public.qorpera_execution_runs e join public.qorpera_runner_jobs j on j.id=e.job_id
			join public.qorpera_runtime_office_access g on g.office_id=p_office.id and g.profile_id=e.profile_id and g.staff_agent_id=e.staff_agent_id
			join public.qorpera_profile_staff s on s.profile_id=e.profile_id and s.staff_agent_id=e.staff_agent_id
			where e.profile_id=p_office.profile_id and e.environment_id=p_office.environment_id
			and e.audience_kind='company' and e.audience_user_id is null and j.status in ('queued','leased')
			and e.deadline_at>clock_timestamp() and g.state='active' and s.employment_status='active' and s.version=e.staff_version)
		or exists(select 1 from public.qorpera_runtime_office_start_waiters w
			join public.qorpera_runtime_office_start_intents i on i.id=w.intent_id
			join public.qorpera_execution_runs e on e.id=w.parent_run_id
			join public.qorpera_runner_jobs j on j.id=e.job_id
			where i.office_id=p_office.id and i.computer_generation=p_office.generation
			and w.state='waiting' and j.status not in ('failed','cancelled'))
		or exists(select 1 from public.qorpera_wake_occurrences w
			left join public.qorpera_execution_runs e on e.id=w.run_id
			left join public.qorpera_runner_jobs j on j.id=e.job_id
			where w.source_kind='office-activation' and w.payload->>'companyComputerId'=p_office.id::text
			and (w.status='queued' or j.status in ('queued','leased','running')))
$$;

create function public.qorpera_reconcile_runtime_office_idle(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_provider_policy_sha256 text,p_idle_ms integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.qorpera_runtime_offices%rowtype; a public.qorpera_runtime_office_activations%rowtype;
	p public.qorpera_runtime_office_idle_policies%rowtype; c public.qorpera_runtime_office_idle_cycles%rowtype;
	v_provider public.qorpera_runtime_office_providers%rowtype; v_request jsonb; v_at timestamptz;
begin
	if p_idle_ms is null or p_idle_ms not between 60000 and 86400000 then
		raise exception 'Invalid office idle policy' using errcode='22023'; end if;
	v_provider:=public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into strict o from public.qorpera_runtime_offices where id=v_provider.office_id;
	v_at:=clock_timestamp();
	select * into c from public.qorpera_runtime_office_idle_cycles where office_id=o.id and computer_generation=o.generation and superseded_at is null
		order by requested_at desc limit 1 for update;
	if o.state='maintenance' then
		if not public.qorpera_runtime_office_idle_pending(o) then
			return jsonb_build_object('schema','qorpera.office-idle-policy/v1','request',null,'wakeRequested',false); end if;
		return jsonb_build_object('schema','qorpera.office-idle-policy/v1','request',c.request,'wakeRequested',c.wake_requested_at is not null);
	end if;
	if o.state<>'active' then
		return jsonb_build_object('schema','qorpera.office-idle-policy/v1','request',null,'wakeRequested',false); end if;
	select * into a from public.qorpera_runtime_office_activations where office_id=o.id and computer_generation=o.generation
		and state='active' and superseded_at is null for share;
	if not found then raise exception 'Office idle activation unavailable' using errcode='42501'; end if;
	if c.transition_id is not null and not exists(select 1 from public.qorpera_runtime_office_successors
		where transition_id=c.transition_id and activation_id=a.activation_id) and exists(
		select 1 from public.qorpera_runtime_office_successors s join public.qorpera_runtime_office_lifecycle_transitions t on t.id=s.transition_id
		where s.activation_id=a.activation_id and t.office_id=o.id and t.requested_at>c.requested_at) then
		-- A later explicit recovery owns its successor; never replay the old idle lineage.
		update public.qorpera_runtime_office_idle_cycles set superseded_at=v_at where transition_id=c.transition_id;
		c:=null;
	end if;
	if c.transition_id is not null and c.activated_at is null then
		if c.wake_requested_at is null or not exists(select 1 from public.qorpera_runtime_office_successors
			where transition_id=c.transition_id and activation_id=a.activation_id) then
			raise exception 'Office idle successor differs' using errcode='42501'; end if;
		update public.qorpera_runtime_office_idle_cycles set activated_at=a.activated_at where transition_id=c.transition_id returning * into c;
	end if;
	insert into public.qorpera_runtime_office_idle_policies(office_id,idle_since,activation_id,idle_ms)
		values(o.id,v_at,a.activation_id,p_idle_ms) on conflict(office_id) do nothing;
	select * into strict p from public.qorpera_runtime_office_idle_policies where office_id=o.id for update;
	if p.activation_id is distinct from a.activation_id or p.idle_ms<>p_idle_ms then
		update public.qorpera_runtime_office_idle_policies set activation_id=a.activation_id,idle_since=v_at,idle_ms=p_idle_ms
			where office_id=o.id returning * into p;
	end if;
	if not v_provider.preparation_enabled or public.qorpera_company_execution_paused(o.profile_id)
		or public.qorpera_runtime_office_has_demand(o) then
		update public.qorpera_runtime_office_idle_policies set idle_since=null where office_id=o.id;
	elsif p.idle_since is null then
		update public.qorpera_runtime_office_idle_policies set idle_since=v_at where office_id=o.id;
	elsif v_at>=p.idle_since+p_idle_ms*interval '1 millisecond' then
		v_request:=jsonb_build_object('schema','qorpera.office-lifecycle-request/v1','transitionId',extensions.gen_random_uuid(),
			'action','power_off','activationId',a.activation_id,'providerId',a.provider_id,'providerPolicySha256',a.provider_policy_sha256,
			'startup',jsonb_build_object('scope',p_scope,'computerGeneration',o.generation,'allocationId',a.allocation_id,
				'instanceSha256',a.instance_sha256,'imageSha256',a.image_sha256,'bootstrapSha256',a.bootstrap_sha256,
				'bootId',a.attestation->>'bootId','configurationSha256',a.attestation->>'configurationSha256','serviceInvocationId',a.service_invocation_id));
		-- The same office lock fences new viewers and native leases until this
		-- revocation is committed. New demand then requests this exact idle wake.
		perform public.qorpera_begin_runtime_office_lifecycle(v_request);
		insert into public.qorpera_runtime_office_idle_cycles(transition_id,office_id,computer_generation,request,requested_at)
			values((v_request->>'transitionId')::uuid,o.id,o.generation,v_request,v_at) returning * into c;
	end if;
	return jsonb_build_object('schema','qorpera.office-idle-policy/v1','request',c.request,'wakeRequested',coalesce(c.wake_requested_at is not null,false));
end $$;

-- Member requests wake an idle cycle without creating a new allocation or
-- tying runtime lifetime to a login. Initial provisioning retains its gate.
alter function public.qorpera_request_runtime_office_start(jsonb,bigint,uuid) rename to qorpera_request_runtime_office_start_before_idle;
create function public.qorpera_request_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.qorpera_runtime_offices%rowtype; i public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_request_id is null then
		raise exception 'Office member required' using errcode='42501'; end if;
	select * into o from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(o.profile_id);
	select * into strict o from public.qorpera_runtime_offices where id=o.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation is distinct from p_computer_generation then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	if public.qorpera_runtime_office_idle_pending(o) or o.state='active' then
		if not public.qorpera_can_write_profile(o.profile_id) or public.qorpera_company_execution_paused(o.profile_id) then
			raise exception 'Office wake unavailable' using errcode='42501'; end if;
		select * into strict i from public.qorpera_runtime_office_start_intents where office_id=o.id
			and computer_generation=o.generation and state='reserved';
		update public.qorpera_runtime_office_idle_cycles set wake_requested_at=coalesce(wake_requested_at,clock_timestamp())
			where office_id=o.id and computer_generation=o.generation and activated_at is null and superseded_at is null;
		insert into public.qorpera_runtime_office_idle_policies(office_id,idle_since,idle_ms)
			values(o.id,clock_timestamp(),300000) on conflict(office_id) do update set idle_since=clock_timestamp();
		return public.qorpera_runtime_office_start_result(i);
	end if;
	return public.qorpera_request_runtime_office_start_before_idle(p_scope,p_computer_generation,p_request_id);
end $$;

-- Retain existing native receipt/continuation admission. Cold work only adds
-- durable demand after the original begin succeeds under its current grant.
create function pg_temp.office_idle_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office idle integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_idle_patch('public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure,
	$old$(o.state='maintenance' and public.qorpera_runtime_office_maintenance(o) is not null)$old$,
	$new$(o.state='maintenance' and (public.qorpera_runtime_office_maintenance(o) is not null or public.qorpera_runtime_office_idle_pending(o)))$new$);
select pg_temp.office_idle_patch('public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)'::regprocedure,
	$old$p_office.state not in ('provisioning','recovering')$old$,
	$new$(p_office.state not in ('provisioning','recovering') and not public.qorpera_runtime_office_idle_pending(p_office)
		and not (p_office.state='maintenance' and public.qorpera_runtime_office_maintenance(p_office) is not null))$new$);
select pg_temp.office_idle_patch('public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)'::regprocedure,
	$old$if p_intent.requested_by_user_id is not null then$old$,
	$new$if public.qorpera_runtime_office_idle_pending(p_office) and p_intent.state='reserved' then return; end if;
	if p_intent.requested_by_user_id is not null then$new$);
select pg_temp.office_idle_patch('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);$old$,
	$new$perform public.qorpera_assert_runtime_office_start_source(v_office,v_intent);
	if public.qorpera_runtime_office_idle_pending(v_office) then
		update public.qorpera_runtime_office_idle_cycles set wake_requested_at=coalesce(wake_requested_at,clock_timestamp())
			where office_id=v_office.id and computer_generation=v_office.generation and activated_at is null and superseded_at is null;
	end if;$new$);

-- Preserve the exact maintenance envelope consumed by both member clients.
alter function public.qorpera_runtime_office_maintenance(public.qorpera_runtime_offices) rename to qorpera_runtime_office_maintenance_before_idle;
create function public.qorpera_runtime_office_maintenance(p_office public.qorpera_runtime_offices)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce((select jsonb_build_object('reason','idle','transitionId',c.transition_id,'requestedAt',c.requested_at,
			'resumedAt',c.wake_requested_at,'activatedAt',c.activated_at,
			'state',case when c.activated_at is not null then 'activated' when c.wake_requested_at is not null then 'resumed' else 'requested' end)
		from public.qorpera_runtime_office_idle_cycles c where c.office_id=p_office.id and c.computer_generation=p_office.generation
			and c.superseded_at is null and public.qorpera_runtime_office_idle_pending(p_office) order by c.requested_at desc limit 1),
		(select public.qorpera_runtime_office_maintenance_before_idle(p_office)
		where exists(select 1 from public.qorpera_runtime_office_host_reboots h where h.office_id=p_office.id
			and h.computer_generation=p_office.generation and h.activated_at is null
			and not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions t where t.office_id=h.office_id
				and t.computer_generation=h.computer_generation and t.id<>h.transition_id and t.requested_at>h.requested_at))))
$$;

revoke all on function public.qorpera_runtime_office_idle_pending(public.qorpera_runtime_offices),
	public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices),
	public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer),
	public.qorpera_request_runtime_office_start_before_idle(jsonb,bigint,uuid),
	public.qorpera_request_runtime_office_start(jsonb,bigint,uuid),
	public.qorpera_runtime_office_maintenance_before_idle(public.qorpera_runtime_offices),
	public.qorpera_runtime_office_maintenance(public.qorpera_runtime_offices) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer) to service_role;
grant execute on function public.qorpera_request_runtime_office_start(jsonb,bigint,uuid) to authenticated;

-- The runtime authority functions have private owners in production.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
		'public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
		'public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure,
		'public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)'::regprocedure,
		'public.qorpera_runtime_office_start_status(jsonb)'::regprocedure,
		'public.qorpera_runtime_office_member_status(jsonb)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Office idle function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_runtime_office_idle_pending(public.qorpera_runtime_offices),
			public.qorpera_runtime_office_maintenance(public.qorpera_runtime_offices) to %I',v_owner);
		execute format('grant select,update on public.qorpera_runtime_office_idle_cycles to %I',v_owner);
	end loop;
end $$;
