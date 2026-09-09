-- One current invocation with immutable predecessor/stop history. A restart
-- retains its VM, generation, working files and private browser state. This
-- SQL handoff grants closed startup/readiness only; the provider must separately
-- inspect the stopped guest, journal root start and freshly measure activation.
alter table public.qorpera_runtime_office_activations
	add column predecessor_activation_id uuid unique references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	add column superseded_at timestamptz,
	add check(superseded_at is null or state='active');
alter table public.qorpera_runtime_office_activations drop constraint qorpera_runtime_office_activations_pkey;
alter table public.qorpera_runtime_office_activations add primary key(activation_id);
do $$
declare v_constraint record; v_count integer:=0;
begin
	for v_constraint in select conname from pg_constraint where conrelid='public.qorpera_runtime_office_activations'::regclass
		and pg_get_constraintdef(oid) in ('UNIQUE (allocation_id)','UNIQUE (office_id, computer_generation)') loop
		execute format('alter table public.qorpera_runtime_office_activations drop constraint %I',v_constraint.conname);
		v_count:=v_count+1;
	end loop;
	if v_count<>2 then raise exception 'Office activation uniqueness differs'; end if;
	v_count:=0;
	for v_constraint in select conname from pg_constraint where conrelid='public.qorpera_runtime_office_lifecycle_transitions'::regclass
		and pg_get_constraintdef(oid)='UNIQUE (office_id, computer_generation)' loop
		execute format('alter table public.qorpera_runtime_office_lifecycle_transitions drop constraint %I',v_constraint.conname);
		v_count:=v_count+1;
	end loop;
	if v_count<>1 then raise exception 'Office lifecycle uniqueness differs'; end if;
end $$;
create unique index qorpera_office_current_intent on public.qorpera_runtime_office_activations(intent_id) where superseded_at is null;
create unique index qorpera_office_current_allocation on public.qorpera_runtime_office_activations(allocation_id) where superseded_at is null;
create unique index qorpera_office_current_generation on public.qorpera_runtime_office_activations(office_id,computer_generation) where superseded_at is null;
create unique index qorpera_office_distinct_invocation on public.qorpera_runtime_office_activations(allocation_id,service_invocation_id) where service_invocation_id is not null;

create table public.qorpera_runtime_office_successors (
	activation_id uuid primary key references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	transition_id uuid not null unique references public.qorpera_runtime_office_stops(transition_id) on delete restrict,
	request jsonb not null,
	office_revision bigint not null,
	privacy_state text not null,
	privacy_version bigint not null,
	privacy_challenge jsonb,
	prepared_at timestamptz not null default clock_timestamp()
);

create function public.qorpera_assert_runtime_office_successor_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
	if jsonb_typeof(p_request) is distinct from 'object' or p_request-array['schema','predecessor','attestation']<>'{}'::jsonb
		or not(p_request ?& array['schema','predecessor','attestation'])
		or p_request->>'schema' is distinct from 'qorpera.office-service-successor-request/v1'
		or octet_length(p_request::text)>65536 then raise exception 'Invalid office successor request' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request->'predecessor');
	perform public.qorpera_assert_runtime_office_activation_attestation(p_request->'attestation');
	if p_request#>>'{predecessor,action}'<>'service_restart'
		or p_request#>'{attestation,activationId}'=p_request#>'{predecessor,activationId}'
		or p_request#>'{attestation,bootId}' is distinct from p_request#>'{predecessor,startup,bootId}'
		or p_request#>'{attestation,configurationSha256}' is distinct from p_request#>'{predecessor,startup,configurationSha256}' then
		raise exception 'Office successor requires a distinct same-boot invocation' using errcode='22023'; end if;
end $$;

-- Caller holds profile -> office -> provider -> current activation locks.
-- No historical mapping is re-adopted and no old grant becomes current here.
-- Both initial preparation and final activation require the same current drain
-- and privacy snapshot. New drains cause refusal, never automatic clearing.
create function public.qorpera_check_runtime_office_restart_surfaces(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype;
begin
	perform public.qorpera_assert_runtime_office_provider(
		public.qorpera_runtime_office_scope((select o from public.qorpera_runtime_offices o where id=p_activation.office_id)),
		p_activation.computer_generation,p_activation.provider_id,p_activation.provider_policy_sha256,true);
	select * into strict v_office from public.qorpera_runtime_offices where id=p_activation.office_id;
	if v_office.state<>'maintenance' or v_office.image_sha256<>p_activation.image_sha256
		or v_office.bootstrap_sha256<>p_activation.bootstrap_sha256 or public.qorpera_company_execution_paused(v_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers c where c.id=v_office.logical_computer_id and c.status='active' and public.qorpera_runtime_office_matches(c))
		or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or lease_id is not null or takeover_user_id is not null))
		or exists(select 1 from public.qorpera_runtime_office_resources where office_id=v_office.id and state<>'drained')
		or exists(select 1 from public.qorpera_runtime_office_viewers where office_id=v_office.id and state<>'ended') then
		raise exception 'Office restart authority unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_machine_allocations where id=p_activation.allocation_id and profile_id=v_office.profile_id
		and office_id=v_office.id and computer_generation=v_office.generation and instance_sha256=p_activation.instance_sha256
		and provider_adapter='lxd' and released_at is null for share;
	if not found then raise exception 'Office restart allocation differs' using errcode='42501'; end if;
end $$;

create function public.qorpera_check_runtime_office_successor_startup(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path = '' as $$
declare v_successor public.qorpera_runtime_office_successors%rowtype; v_office public.qorpera_runtime_offices%rowtype;
begin
	perform public.qorpera_check_runtime_office_restart_surfaces(p_activation);
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=p_activation.activation_id for share;
	select * into strict v_office from public.qorpera_runtime_offices where id=p_activation.office_id;
	if not found or v_successor.activation_id is null or p_activation.predecessor_activation_id is null or p_activation.superseded_at is not null
		or v_office.revision<>v_successor.office_revision or v_office.privacy_state<>v_successor.privacy_state
		or v_office.privacy_version<>v_successor.privacy_version or v_office.privacy_challenge is distinct from v_successor.privacy_challenge
		or not exists(select 1 from public.qorpera_runtime_office_stops where transition_id=v_successor.transition_id) then
		raise exception 'Office successor snapshot changed' using errcode='42501'; end if;
end $$;

create function public.qorpera_runtime_office_successor_result(p_activation public.qorpera_runtime_office_activations)
returns jsonb language sql volatile set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-service-successor/v1','request',s.request,'state',p_activation.state,
		'serviceInvocationId',p_activation.service_invocation_id,
		'readinessFresh',p_activation.ready_at is not null and p_activation.ready_at>clock_timestamp()-interval '5 seconds',
		'stopAcknowledgedAtMs',floor(extract(epoch from stop.acknowledged_at)*1000)::bigint,
		'officeRevision',s.office_revision,'privacyVersion',s.privacy_version,'validForMs',5000)
	from public.qorpera_runtime_office_successors s join public.qorpera_runtime_office_stops stop on stop.transition_id=s.transition_id
	where s.activation_id=p_activation.activation_id
$$;

-- Metadata is recoverable while preparation is disabled, but a superseded
-- candidate is not returned as current. No missing identity is reconstructed.
create function public.qorpera_runtime_office_successor_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_successor public.qorpera_runtime_office_successors%rowtype;
begin
	perform public.qorpera_assert_runtime_office_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid for share;
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=v_activation.activation_id for share;
	if v_successor.activation_id is null or v_successor.request<>p_request or v_activation.superseded_at is not null then
		raise exception 'Office successor identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_successor_result(v_activation);
end $$;

create function public.qorpera_prepare_runtime_office_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_old public.qorpera_runtime_office_activations%rowtype; v_next public.qorpera_runtime_office_activations%rowtype;
	v_existing public.qorpera_runtime_office_successors%rowtype; v_office public.qorpera_runtime_offices%rowtype;
begin
	perform public.qorpera_assert_runtime_office_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_existing from public.qorpera_runtime_office_successors where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid;
	if found then
		if v_existing.request<>p_request then raise exception 'Office successor cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_successor_status(p_request);
	end if;
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_transition.activation_id;
	if (p_request->'attestation')-'activationId'<>v_old.attestation-'activationId' then
		raise exception 'Office restart configuration changed' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id for share;
	if not found then raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	-- End only the current pointer; all original activation facts and stop
	-- receipts remain queryable by their immutable primary identities.
	update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=v_old.activation_id;
	insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,provider_id,
		provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state,predecessor_activation_id)
	values(v_old.intent_id,(p_request#>>'{attestation,activationId}')::uuid,v_old.office_id,v_old.computer_generation,v_old.allocation_id,v_old.provider_id,
		v_old.provider_policy_sha256,v_old.provider_binding_sha256,v_old.instance_sha256,v_old.image_sha256,v_old.bootstrap_sha256,p_request->'attestation',v_old.mappings,'prepared',v_old.activation_id)
	returning * into v_next;
	insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version,privacy_challenge)
	values(v_next.activation_id,v_transition.id,p_request,v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge);
	perform public.qorpera_check_runtime_office_successor_startup(v_next);
	return public.qorpera_runtime_office_successor_result(v_next);
end $$;

-- Patches fail if reviewed integration points drift. Preserve existing ACLs
-- and security-definer ownership while moving every current-state lookup and
-- update to the invocation primary key. Historical status remains read-only.
create function pg_temp.office_successor_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office successor integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;

select pg_temp.office_successor_patch('public.qorpera_prepare_runtime_office_activation(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb,jsonb)'::regprocedure,
	'where intent_id=p_intent_id for update;', 'where intent_id=p_intent_id and superseded_at is null for update;');
select pg_temp.office_successor_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
	'where allocation_id=(p_startup->>''allocationId'')::uuid;', 'where allocation_id=(p_startup->>''allocationId'')::uuid and superseded_at is null;');
select pg_temp.office_successor_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
	'where intent_id=v_activation.intent_id for update;', 'where activation_id=v_activation.activation_id and superseded_at is null for update;');
select pg_temp.office_successor_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
	$old$	if v_activation.state='active' then$old$,
	$new$	if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_activation.allocation_id
		and activation_id<>v_activation.activation_id and service_invocation_id=p_startup->>'serviceInvocationId') then
		raise exception 'Office invocation cannot be reused' using errcode='42501'; end if;
	if v_activation.state='active' then$new$);
select pg_temp.office_successor_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
	$old$	else
		perform public.qorpera_check_runtime_office_adoption$old$,
	$new$	elsif v_activation.predecessor_activation_id is not null then
		perform public.qorpera_check_runtime_office_successor_startup(v_activation);
	else
		perform public.qorpera_check_runtime_office_adoption$new$);
select pg_temp.office_successor_patch('public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer)'::regprocedure,
	'where intent_id=v_activation.intent_id returning * into v_activation;', 'where activation_id=v_activation.activation_id returning * into v_activation;');
select pg_temp.office_successor_patch('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
	'and activation_id=p_activation_id and office_id=', 'and activation_id=p_activation_id and superseded_at is null and office_id=');
select pg_temp.office_successor_patch('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
	$old$	perform public.qorpera_check_runtime_office_adoption(p_scope,p_computer_generation,p_intent_id,v_activation.allocation_id,
		v_activation.instance_sha256,v_activation.provider_binding_sha256,p_provider_id,p_provider_policy_sha256,v_activation.mappings);$old$,
	$new$	if v_activation.predecessor_activation_id is not null then
		perform public.qorpera_check_runtime_office_successor_startup(v_activation);
	else
		perform public.qorpera_check_runtime_office_adoption(p_scope,p_computer_generation,p_intent_id,v_activation.allocation_id,
			v_activation.instance_sha256,v_activation.provider_binding_sha256,p_provider_id,p_provider_policy_sha256,v_activation.mappings);
	end if;$new$);
select pg_temp.office_successor_patch('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
	'where intent_id=v_activation.intent_id returning * into v_activation;', 'where activation_id=v_activation.activation_id returning * into v_activation;');
select pg_temp.office_successor_patch('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure,
	'if not found or v_activation.state<>''active''', 'if not found or v_activation.superseded_at is not null or v_activation.state<>''active''');
select pg_temp.office_successor_patch('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure,
	'where office_id=v_office.id and computer_generation=v_office.generation for update;', 'where activation_id=v_activation.activation_id for update;');
select pg_temp.office_successor_patch('public.qorpera_lock_runtime_office_stop(jsonb)'::regprocedure,
	'if not found or v_office.state<>''maintenance''', 'if not found or v_activation.superseded_at is not null or v_office.state<>''maintenance''');

select pg_temp.office_successor_patch('public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)'::regprocedure,
	'and office_id=v_office.id and computer_generation=v_office.generation and state=''active''', 'and office_id=v_office.id and computer_generation=v_office.generation and state=''active'' and superseded_at is null');
select pg_temp.office_successor_patch('public.qorpera_drain_office_activation_wakes(integer)'::regprocedure,
	'where intent_id=v_intent.id and state=''active'')', 'where intent_id=v_intent.id and state=''active'' and superseded_at is null)');
select pg_temp.office_successor_patch('public.qorpera_drain_office_activation_wakes(integer)'::regprocedure,
	'where intent_id=v_intent.id;', 'where intent_id=v_intent.id and superseded_at is null;');
-- A stopped predecessor remains historical state=active before successor
-- preparation. Maintenance is temporary unavailability, not revoked demand.
select pg_temp.office_successor_patch('public.qorpera_drain_office_activation_wakes(integer)'::regprocedure,
	$old$if v_job_status<>'completed' or public.qorpera_company_execution_paused(v_parent.profile_id)$old$,
	$new$if v_job_status<>'completed' or not exists(select 1 from public.qorpera_runtime_offices where id=v_intent.office_id and state='active')
    or public.qorpera_company_execution_paused(v_parent.profile_id)$new$);
-- A delivered wake retains its original activation provenance through later
-- restart. Waiting deliveries bind the current active invocation instead.
select pg_temp.office_successor_patch('public.qorpera_office_activation_wake_payload(public.qorpera_runtime_office_start_waiters)'::regprocedure,
	$old$where a.intent_id=p_waiter.intent_id and a.state='active'$old$,
	$new$where a.intent_id=p_waiter.intent_id and a.state='active' and
	((p_waiter.state='waiting' and a.superseded_at is null) or (p_waiter.state='delivered' and a.activation_id::text=
		(select w.payload->>'activationId' from public.qorpera_wake_occurrences w where w.id=p_waiter.occurrence_id)))$new$);

create function public.qorpera_activate_runtime_office_successor(p_request jsonb,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_runtime_office_successor_status(p_request);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid;
	perform public.qorpera_activate_runtime_office(p_request#>'{predecessor,startup,scope}',v_activation.computer_generation,v_activation.intent_id,
		v_activation.activation_id,v_activation.provider_id,v_activation.provider_policy_sha256,p_service_invocation_id);
	return public.qorpera_runtime_office_successor_status(p_request);
end $$;

alter table public.qorpera_runtime_office_successors enable row level security;
revoke all on public.qorpera_runtime_office_successors from public,anon,authenticated,service_role;
revoke all on function public.qorpera_assert_runtime_office_successor_request(jsonb),
	public.qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations),
	public.qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations),
	public.qorpera_runtime_office_successor_result(public.qorpera_runtime_office_activations),
	public.qorpera_prepare_runtime_office_successor(jsonb),public.qorpera_runtime_office_successor_status(jsonb),
	public.qorpera_activate_runtime_office_successor(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_prepare_runtime_office_successor(jsonb),public.qorpera_runtime_office_successor_status(jsonb),
	public.qorpera_activate_runtime_office_successor(jsonb,text) to service_role;
