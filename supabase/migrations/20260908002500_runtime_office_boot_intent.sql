-- Durable explicit permission request before reboot/resume of the retained VM.
-- An acknowledged service stop alone never resumes a powered-off office.
-- Physical shutdown/history, one journaled VM start and observed new boot remain
-- provider responsibilities. Recoverable metadata does not authorize dispatch.
create table public.qorpera_runtime_office_boot_intents (
	boot_intent_id uuid primary key,
	activation_id uuid not null unique,
	transition_id uuid not null unique references public.qorpera_runtime_office_stops(transition_id) on delete restrict,
	predecessor_activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	request jsonb not null,
	office_revision bigint not null,
	privacy_state text not null,
	privacy_version bigint not null,
	privacy_challenge jsonb,
	prepared_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_runtime_office_boot_intents enable row level security;
revoke all on public.qorpera_runtime_office_boot_intents from public,anon,authenticated,service_role;

create function public.qorpera_assert_runtime_office_boot_intent_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request-array['schema','bootIntentId','activationId','predecessor','stopHistorySha256','powerOffCompletionSha256']<>'{}'::jsonb
		or not(p_request ?& array['schema','bootIntentId','activationId','predecessor','stopHistorySha256','powerOffCompletionSha256'])
		or p_request->>'schema' is distinct from 'qorpera.office-boot-intent-request/v1'
		or octet_length(p_request::text)>65536 then raise exception 'Invalid office boot intent request' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request->'predecessor');
	if p_request#>>'{predecessor,action}' not in ('reboot','power_off')
		or p_request->'activationId'=p_request#>'{predecessor,activationId}' then
		raise exception 'Office boot intent requires a new activation after shutdown' using errcode='22023'; end if;
	foreach v_key in array array['bootIntentId','activationId'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string'
			or (p_request->>v_key)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office boot intent identity' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string' or (p_request->>v_key)!~'^[0-9a-f]{64}$' then
			raise exception 'Invalid office boot intent history' using errcode='22023'; end if;
	end loop;
end $$;

create function public.qorpera_runtime_office_boot_intent_result(p_intent public.qorpera_runtime_office_boot_intents)
returns jsonb language sql volatile set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-boot-intent/v1','request',p_intent.request,
		'state',case when exists(select 1 from public.qorpera_runtime_office_successors s where s.transition_id=p_intent.transition_id
			and s.activation_id=p_intent.activation_id) then 'admitted' else 'prepared' end,
		'stopAcknowledgedAtMs',floor(extract(epoch from stop.acknowledged_at)*1000)::bigint,
		'officeRevision',p_intent.office_revision,'privacyVersion',p_intent.privacy_version,'validForMs',5000)
	from public.qorpera_runtime_office_stops stop where stop.transition_id=p_intent.transition_id
$$;

-- Exact metadata remains recoverable after handoff or provider disable. No
-- current activation is reconstructed and no physical operation is replayed.
create function public.qorpera_runtime_office_boot_intent_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.qorpera_runtime_office_boot_intents%rowtype;
begin
	perform public.qorpera_assert_runtime_office_boot_intent_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',
		(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_intent from public.qorpera_runtime_office_boot_intents where boot_intent_id=(p_request->>'bootIntentId')::uuid for share;
	if not found or v_intent.request<>p_request then raise exception 'Office boot intent unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_boot_intent_result(v_intent);
end $$;

create function public.qorpera_check_runtime_office_boot_intent(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.qorpera_runtime_office_boot_intents%rowtype; v_old public.qorpera_runtime_office_activations%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
begin
	perform public.qorpera_runtime_office_boot_intent_status(p_request);
	select * into strict v_intent from public.qorpera_runtime_office_boot_intents where boot_intent_id=(p_request->>'bootIntentId')::uuid;
	if exists(select 1 from public.qorpera_runtime_office_successors where transition_id=v_intent.transition_id) then
		raise exception 'Office boot intent already admitted' using errcode='42501'; end if;
	perform public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_intent.predecessor_activation_id;
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	if v_office.revision<>v_intent.office_revision or v_office.privacy_state<>v_intent.privacy_state
		or v_office.privacy_version<>v_intent.privacy_version or v_office.privacy_challenge is distinct from v_intent.privacy_challenge then
		raise exception 'Office boot intent snapshot changed' using errcode='42501'; end if;
	return public.qorpera_runtime_office_boot_intent_result(v_intent);
end $$;

create function public.qorpera_prepare_runtime_office_boot_intent(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.qorpera_runtime_office_boot_intents%rowtype; v_old public.qorpera_runtime_office_activations%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_key text;
begin
	perform public.qorpera_assert_runtime_office_boot_intent_request(p_request);
	-- Shared lock order serializes competing identities and provider/pause edits.
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',
		(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_intent from public.qorpera_runtime_office_boot_intents where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid;
	if found then
		if v_intent.request<>p_request then raise exception 'Office boot intent cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_boot_intent_status(p_request);
	end if;
	perform public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{predecessor,activationId}')::uuid;
	perform 1 from public.qorpera_runtime_office_stops where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid for share;
	if not found then raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_activations where activation_id=(p_request->>'activationId')::uuid) then
		raise exception 'Office boot activation cannot be reused' using errcode='42501'; end if;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256'] loop
		if exists(select 1 from public.qorpera_runtime_office_boot_intents i
			join public.qorpera_runtime_office_activations a on a.activation_id=i.predecessor_activation_id
			where a.allocation_id=v_old.allocation_id and i.request->v_key=p_request->v_key) then
			raise exception 'Office boot intent evidence cannot be reused' using errcode='42501'; end if;
	end loop;
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	insert into public.qorpera_runtime_office_boot_intents(boot_intent_id,activation_id,transition_id,predecessor_activation_id,
		request,office_revision,privacy_state,privacy_version,privacy_challenge)
	values((p_request->>'bootIntentId')::uuid,(p_request->>'activationId')::uuid,(p_request#>>'{predecessor,transitionId}')::uuid,
		v_old.activation_id,p_request,v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge)
	returning * into v_intent;
	return public.qorpera_runtime_office_boot_intent_result(v_intent);
end $$;

-- Closed projection prevents an observed boot from substituting a different
-- planned activation, predecessor or shutdown proof. Used before superseding
-- the old activation; subsequent exact post-boot metadata replay is unchanged.
create function public.qorpera_check_runtime_office_boot_handoff(p_request jsonb)
returns void language plpgsql set search_path = '' as $$
begin
	perform public.qorpera_check_runtime_office_boot_intent(jsonb_build_object(
		'schema','qorpera.office-boot-intent-request/v1','bootIntentId',p_request->'bootIntentId',
		'activationId',p_request#>'{attestation,activationId}','predecessor',p_request->'predecessor',
		'stopHistorySha256',p_request->'stopHistorySha256','powerOffCompletionSha256',p_request->'powerOffCompletionSha256'));
end $$;

revoke all on function public.qorpera_assert_runtime_office_boot_intent_request(jsonb),
	public.qorpera_runtime_office_boot_intent_result(public.qorpera_runtime_office_boot_intents),
	public.qorpera_check_runtime_office_boot_handoff(jsonb),public.qorpera_prepare_runtime_office_boot_intent(jsonb),
	public.qorpera_runtime_office_boot_intent_status(jsonb),public.qorpera_check_runtime_office_boot_intent(jsonb)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_prepare_runtime_office_boot_intent(jsonb),public.qorpera_runtime_office_boot_intent_status(jsonb),
	public.qorpera_check_runtime_office_boot_intent(jsonb) to service_role;

create or replace function public.qorpera_assert_runtime_office_boot_successor_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request-array['schema','bootIntentId','predecessor','attestation','stopHistorySha256','powerOffCompletionSha256','bootObservationSha256']<>'{}'::jsonb
		or not(p_request ?& array['schema','bootIntentId','predecessor','attestation','stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'])
		or p_request->>'schema' is distinct from 'qorpera.office-boot-successor-request/v1'
		or octet_length(p_request::text)>65536 then raise exception 'Invalid office boot successor request' using errcode='22023'; end if;
	if jsonb_typeof(p_request->'bootIntentId') is distinct from 'string'
		or (p_request->>'bootIntentId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		raise exception 'Invalid office boot intent identity' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request->'predecessor');
	perform public.qorpera_assert_runtime_office_activation_attestation(p_request->'attestation');
	if p_request#>>'{predecessor,action}' not in ('reboot','power_off')
		or p_request#>'{attestation,activationId}'=p_request#>'{predecessor,activationId}'
		or p_request#>'{attestation,bootId}'=p_request#>'{predecessor,startup,bootId}'
		or p_request#>'{attestation,configurationSha256}'=p_request#>'{predecessor,startup,configurationSha256}' then
		raise exception 'Office boot successor requires a distinct boot and configuration' using errcode='22023'; end if;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string' or (p_request->>v_key)!~'^[0-9a-f]{64}$' then
			raise exception 'Invalid office boot successor history' using errcode='22023'; end if;
	end loop;
end $$;

create or replace function public.qorpera_prepare_runtime_office_boot_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_old public.qorpera_runtime_office_activations%rowtype; v_next public.qorpera_runtime_office_activations%rowtype;
	v_existing public.qorpera_runtime_office_successors%rowtype; v_office public.qorpera_runtime_offices%rowtype; v_key text;
begin
	perform public.qorpera_assert_runtime_office_boot_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_existing from public.qorpera_runtime_office_successors where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid;
	if found then
		if v_existing.request<>p_request then raise exception 'Office boot successor cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_boot_successor_status(p_request);
	end if;
	perform public.qorpera_check_runtime_office_boot_handoff(p_request);
	-- Common profile -> office -> provider -> activation lock order also
	-- serializes boot-history checks with service successors and founder pause.
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_transition.activation_id;
	perform 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id for share;
	if not found then raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id
		and attestation->>'bootId'=p_request#>>'{attestation,bootId}') then
		raise exception 'Office boot identity cannot be reused' using errcode='42501'; end if;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'] loop
		if exists(select 1 from public.qorpera_runtime_office_successors s
			join public.qorpera_runtime_office_activations a using(activation_id)
			where a.allocation_id=v_old.allocation_id and s.request->v_key=p_request->v_key) then
			raise exception 'Office boot evidence cannot be reused' using errcode='42501'; end if;
	end loop;
	if p_request#>'{attestation,nativePort}' is distinct from v_old.attestation->'nativePort'
		or p_request#>'{attestation,viewerPort}' is distinct from v_old.attestation->'viewerPort' then
		raise exception 'Office boot listener binding changed' using errcode='42501'; end if;
	foreach v_key in array array['preparationObservationSha256','configurationObservationSha256','configurationSha256','adoptionReceiptSha256'] loop
		if p_request->'attestation'->v_key=v_old.attestation->v_key then
			raise exception 'Office boot requires fresh protected observations' using errcode='42501'; end if;
	end loop;
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=v_old.activation_id;
	insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,provider_id,
		provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state,predecessor_activation_id)
	values(v_old.intent_id,(p_request#>>'{attestation,activationId}')::uuid,v_old.office_id,v_old.computer_generation,v_old.allocation_id,v_old.provider_id,
		v_old.provider_policy_sha256,v_old.provider_binding_sha256,v_old.instance_sha256,v_old.image_sha256,v_old.bootstrap_sha256,p_request->'attestation',v_old.mappings,'prepared',v_old.activation_id)
	returning * into v_next;
	insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version,privacy_challenge)
	values(v_next.activation_id,v_transition.id,p_request,v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge);
	perform public.qorpera_check_runtime_office_successor_startup(v_next);
	return public.qorpera_runtime_office_boot_successor_result(v_next);
end $$;
