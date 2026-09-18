-- Physical stop is separate from admission revocation and machine release.
-- A provider obtains a bounded current-state challenge before independently
-- inspecting the protected guest completion. SQL never treats task success,
-- elapsed time, a screen drain or an old completion as physical evidence.
create table public.qorpera_runtime_office_stop_challenges (
	id uuid primary key,
	transition_id uuid not null references public.qorpera_runtime_office_lifecycle_transitions(id) on delete restrict,
	command jsonb not null,
	start_completion_sha256 text not null check(start_completion_sha256 ~ '^[0-9a-f]{64}$'),
	office_revision bigint not null,
	privacy_version bigint not null,
	drains jsonb not null,
	issued_at timestamptz not null,
	expires_at timestamptz not null,
	check(expires_at=issued_at+interval '5 seconds')
);
create index qorpera_runtime_office_stop_challenges_transition on public.qorpera_runtime_office_stop_challenges(transition_id);
create table public.qorpera_runtime_office_stops (
	transition_id uuid primary key references public.qorpera_runtime_office_lifecycle_transitions(id) on delete restrict,
	challenge_id uuid not null unique references public.qorpera_runtime_office_stop_challenges(id) on delete restrict,
	inspection jsonb not null,
	acknowledged_at timestamptz not null default clock_timestamp()
);

create function public.qorpera_assert_runtime_office_stop_command(p_command jsonb,p_request jsonb,p_inspection_id uuid,p_start_completion_sha256 text)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text; v_keys text[]:=array['commandId','requestSha256','bootId'];
begin
	if jsonb_typeof(p_command) is distinct from 'object' or p_command-v_keys<>'{}'::jsonb or not(p_command ?& v_keys)
		or jsonb_typeof(p_command->'requestSha256') is distinct from 'string' or p_command->>'requestSha256' !~ '^[0-9a-f]{64}$'
		or p_start_completion_sha256 is null or p_start_completion_sha256 !~ '^[0-9a-f]{64}$'
		or p_command->>'bootId' is distinct from p_request#>>'{startup,bootId}' or p_inspection_id is null
		or p_inspection_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or p_inspection_id::text=p_command->>'commandId' then raise exception 'Invalid office stop command' using errcode='22023'; end if;
	foreach v_key in array array['commandId','bootId'] loop
		if jsonb_typeof(p_command->v_key) is distinct from 'string' or p_command->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office stop identity' using errcode='22023'; end if;
	end loop;
end
$$;

-- Same lock order as activation/revocation. No active-work or pause check:
-- a disabled provider may still terminate its previously admitted service.
create function public.qorpera_lock_runtime_office_stop(p_request jsonb)
returns public.qorpera_runtime_office_lifecycle_transitions language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{startup,scope}',(p_request#>>'{startup,computerGeneration}')::bigint,
		(p_request->>'providerId')::uuid,p_request->>'providerPolicySha256',false);
	select * into strict v_office from public.qorpera_runtime_offices where id=(p_request#>>'{startup,scope,companyComputerId}')::uuid;
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request->>'activationId')::uuid for update;
	if not found or v_office.state<>'maintenance' or v_activation.state<>'active' or v_activation.office_id<>v_office.id
		or v_activation.computer_generation<>v_office.generation
		or v_activation.provider_id::text is distinct from p_request->>'providerId'
		or v_activation.provider_policy_sha256 is distinct from p_request->>'providerPolicySha256'
		or v_activation.allocation_id::text is distinct from p_request#>>'{startup,allocationId}'
		or v_activation.instance_sha256 is distinct from p_request#>>'{startup,instanceSha256}'
		or v_activation.image_sha256 is distinct from p_request#>>'{startup,imageSha256}'
		or v_activation.bootstrap_sha256 is distinct from p_request#>>'{startup,bootstrapSha256}'
		or v_activation.attestation->>'bootId' is distinct from p_request#>>'{startup,bootId}'
		or v_activation.attestation->>'configurationSha256' is distinct from p_request#>>'{startup,configurationSha256}'
		or v_activation.service_invocation_id is distinct from p_request#>>'{startup,serviceInvocationId}' then
		raise exception 'Office stop activation differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_machine_allocations where id=v_activation.allocation_id and office_id=v_office.id
		and computer_generation=v_office.generation and profile_id=v_office.profile_id and provider_adapter='lxd'
		and instance_sha256=v_activation.instance_sha256 and released_at is null for share;
	if not found then raise exception 'Office stop allocation differs' using errcode='42501'; end if;
	select * into v_transition from public.qorpera_runtime_office_lifecycle_transitions where id=(p_request->>'transitionId')::uuid for update;
	if not found or v_transition.request<>p_request or v_transition.activation_id<>v_activation.activation_id
		or v_transition.office_id<>v_office.id or v_transition.computer_generation<>v_office.generation
		or v_transition.allocation_id<>v_activation.allocation_id then raise exception 'Office stop revocation differs' using errcode='42501'; end if;
	return v_transition;
end
$$;

create function public.qorpera_runtime_office_pending_stop_drains(p_office public.qorpera_runtime_offices)
returns jsonb language sql stable set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('state','draining','drainId',s.drain_id,'epoch',s.epoch,
		'binding',public.qorpera_runtime_office_scope(p_office)||jsonb_build_object('computerGeneration',p_office.generation,
			'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id)) order by s.ordinal),'[]'::jsonb)
	from public.qorpera_runtime_office_screens s where s.office_id=p_office.id and s.drain_pending
$$;

create function public.qorpera_prepare_runtime_office_stop(p_request jsonb,p_command jsonb,p_inspection_id uuid,p_start_completion_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_challenge public.qorpera_runtime_office_stop_challenges%rowtype;
	v_now timestamptz; v_ms bigint; v_drains jsonb;
begin
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request);
	perform public.qorpera_assert_runtime_office_stop_command(p_command,p_request,p_inspection_id,p_start_completion_sha256);
	if exists(select 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id) then
		raise exception 'Office stop already acknowledged' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_stop_challenges where transition_id=v_transition.id
		and (command<>p_command or start_completion_sha256<>p_start_completion_sha256)) then
		raise exception 'Office stop command cannot be rebound' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_transition.office_id;
	v_drains:=public.qorpera_runtime_office_pending_stop_drains(v_office);
	select * into v_challenge from public.qorpera_runtime_office_stop_challenges where id=p_inspection_id for update;
	if found then
		if v_challenge.transition_id<>v_transition.id or v_challenge.command<>p_command
			or v_challenge.start_completion_sha256<>p_start_completion_sha256 or v_challenge.office_revision<>v_office.revision
			or v_challenge.privacy_version<>v_office.privacy_version or v_challenge.drains<>v_drains then
			raise exception 'Office stop challenge changed' using errcode='42501'; end if;
	else
		if (select count(*) from public.qorpera_runtime_office_stop_challenges where transition_id=v_transition.id)>=64 then
			raise exception 'Office stop inspection budget exhausted' using errcode='54000'; end if;
		v_now:=clock_timestamp();
		insert into public.qorpera_runtime_office_stop_challenges(id,transition_id,command,start_completion_sha256,office_revision,privacy_version,drains,issued_at,expires_at)
		values(p_inspection_id,v_transition.id,p_command,p_start_completion_sha256,v_office.revision,v_office.privacy_version,v_drains,v_now,v_now+interval '5 seconds')
		returning * into v_challenge;
	end if;
	v_ms:=least(5000,floor(extract(epoch from(v_challenge.expires_at-clock_timestamp()))*1000)::bigint);
	if v_ms<1 then raise exception 'Office stop inspection expired' using errcode='42501'; end if;
	return jsonb_build_object('schema','qorpera.office-service-stop-challenge/v1','inspectionId',v_challenge.id,
		'command',v_challenge.command,'transitionId',v_transition.id,'revocationRevision',v_transition.revocation_revision,
		'officeRevision',v_challenge.office_revision,'privacyVersion',v_challenge.privacy_version,'drains',v_challenge.drains,'validForMs',v_ms);
end
$$;

create function public.qorpera_runtime_office_stop_result(p_stop public.qorpera_runtime_office_stops,p_request jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-service-stop-acknowledgement/v1','state','stopped','request',p_request,
		'inspection',p_stop.inspection,'acknowledgedAtMs',floor(extract(epoch from p_stop.acknowledged_at)*1000)::bigint)
$$;

create function public.qorpera_ack_runtime_office_stop(p_request jsonb,p_inspection jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_challenge public.qorpera_runtime_office_stop_challenges%rowtype;
	v_stop public.qorpera_runtime_office_stops%rowtype; v_complete jsonb:=p_inspection->'stop'; v_key text;
	v_keys text[]:=array['schema','inspectionId','stop','cgroupState'];
	v_complete_keys text[]:=array['schema','command','transitionId','activationId','revocationRevision','configurationSha256','startCompletionSha256','fromServiceInvocationId','observedInvocationId','stoppedInvocationId','controlGroup','cgroupState'];
begin
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request);
	if jsonb_typeof(p_inspection) is distinct from 'object' or p_inspection-v_keys<>'{}'::jsonb or not(p_inspection ?& v_keys)
		or octet_length(p_inspection::text)>65536 or p_inspection->>'schema' is distinct from 'qorpera.office-service-stop-inspection/v1'
		or jsonb_typeof(p_inspection->'inspectionId') is distinct from 'string'
		or p_inspection->>'inspectionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or coalesce(p_inspection->>'cgroupState','') not in ('absent','empty')
		or jsonb_typeof(v_complete) is distinct from 'object' or v_complete-v_complete_keys<>'{}'::jsonb or not(v_complete ?& v_complete_keys)
		or v_complete->>'schema' is distinct from 'qorpera.office-service-stop-completion/v1' then
		raise exception 'Invalid office stop inspection' using errcode='22023'; end if;
	select * into v_challenge from public.qorpera_runtime_office_stop_challenges where id=(p_inspection->>'inspectionId')::uuid for update;
	if not found or v_challenge.transition_id<>v_transition.id then raise exception 'Office stop inspection unavailable' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_stop_command(v_complete->'command',p_request,v_challenge.id,v_complete->>'startCompletionSha256');
	if v_complete->'command' is distinct from v_challenge.command or v_complete->>'transitionId' is distinct from v_transition.id::text
		or v_complete->>'activationId' is distinct from p_request->>'activationId'
		or v_complete->'revocationRevision' is distinct from to_jsonb(v_transition.revocation_revision)
		or v_complete->'configurationSha256' is distinct from p_request#>'{startup,configurationSha256}'
		or jsonb_typeof(v_complete->'startCompletionSha256') is distinct from 'string'
		or v_complete->>'startCompletionSha256' is distinct from v_challenge.start_completion_sha256
		or v_complete->'fromServiceInvocationId' is distinct from p_request#>'{startup,serviceInvocationId}'
		or v_complete->>'controlGroup' is distinct from '/system.slice/qorpera-company-computer.service'
		or coalesce(v_complete->>'cgroupState','') not in ('absent','empty') then
		raise exception 'Office stop completion differs' using errcode='42501'; end if;
	foreach v_key in array array['observedInvocationId','stoppedInvocationId'] loop
		if v_complete->v_key<>'null'::jsonb and (jsonb_typeof(v_complete->v_key) is distinct from 'string'
			or v_complete->>v_key !~ '^[0-9a-f]{32}$' or v_complete->>v_key=repeat('0',32)) then
			raise exception 'Invalid stopped invocation' using errcode='22023'; end if;
	end loop;
	select * into v_stop from public.qorpera_runtime_office_stops where transition_id=v_transition.id;
	if found then
		if v_stop.inspection<>p_inspection then raise exception 'Office stop cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_stop_result(v_stop,p_request);
	end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_transition.office_id;
	if clock_timestamp()>=v_challenge.expires_at or v_office.revision<>v_challenge.office_revision
		or v_office.privacy_version<>v_challenge.privacy_version
		or public.qorpera_runtime_office_pending_stop_drains(v_office)<>v_challenge.drains then
		raise exception 'Office stop inspection expired or changed' using errcode='42501'; end if;
	-- Actual whole-service cleanup covers all viewer inputs and resources. It
	-- does not acknowledge the privacy transition or rewrite persistent state.
	update public.qorpera_runtime_office_resources set state='drained',drained_at=clock_timestamp()
		where office_id=v_office.id and state<>'drained';
	update public.qorpera_runtime_office_viewers set state='ended',ended_at=clock_timestamp()
		where office_id=v_office.id and state<>'ended';
	update public.qorpera_runtime_office_screens set drain_pending=false,drain_acknowledged_at=clock_timestamp()
		where office_id=v_office.id and drain_pending;
	update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	if clock_timestamp()>=v_challenge.expires_at then raise exception 'Office stop acknowledgement expired' using errcode='42501'; end if;
	insert into public.qorpera_runtime_office_stops(transition_id,challenge_id,inspection)
	values(v_transition.id,v_challenge.id,p_inspection) returning * into v_stop;
	return public.qorpera_runtime_office_stop_result(v_stop,p_request);
end
$$;

create function public.qorpera_runtime_office_stop_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype; v_stop public.qorpera_runtime_office_stops%rowtype;
begin
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request);
	select * into v_stop from public.qorpera_runtime_office_stops where transition_id=v_transition.id;
	if not found then return null; end if;
	return public.qorpera_runtime_office_stop_result(v_stop,p_request);
end
$$;

alter table public.qorpera_runtime_office_stop_challenges enable row level security;
alter table public.qorpera_runtime_office_stops enable row level security;
revoke all on public.qorpera_runtime_office_stop_challenges,public.qorpera_runtime_office_stops from public,anon,authenticated,service_role;
revoke all on function public.qorpera_assert_runtime_office_stop_command(jsonb,jsonb,uuid,text),
	public.qorpera_lock_runtime_office_stop(jsonb),public.qorpera_runtime_office_pending_stop_drains(public.qorpera_runtime_offices),
	public.qorpera_prepare_runtime_office_stop(jsonb,jsonb,uuid,text),
	public.qorpera_runtime_office_stop_result(public.qorpera_runtime_office_stops,jsonb),
	public.qorpera_ack_runtime_office_stop(jsonb,jsonb),public.qorpera_runtime_office_stop_status(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_prepare_runtime_office_stop(jsonb,jsonb,uuid,text),
	public.qorpera_ack_runtime_office_stop(jsonb,jsonb),public.qorpera_runtime_office_stop_status(jsonb) to service_role;
