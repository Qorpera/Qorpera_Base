-- Governed same-allocation, same-node, pinned-image office root reset.
-- The allocation, node demand, generation, instance and every historical
-- activation/screen/lifetime row are retained. Only the physical root
-- incarnation, boot, configuration, activation and invocation change. SQL
-- records exact provider evidence digests and issues short-lived phase
-- permission; it cannot observe a VM, copy a file or prove a physical
-- transition. Status is historical metadata, never dispatch permission.
create table public.qorpera_runtime_office_resets (
	reset_id uuid primary key,
	transition_id uuid not null unique references public.qorpera_runtime_office_lifecycle_transitions(id) on delete restrict,
	predecessor_activation_id uuid not null unique references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	successor_activation_id uuid not null unique,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null check(computer_generation between 1 and 9007199254740991),
	allocation_id uuid not null references public.qorpera_runtime_machine_allocations(id) on delete restrict,
	node_id uuid,
	provider_id uuid not null,
	provider_policy_sha256 text not null check(provider_policy_sha256 ~ '^[0-9a-f]{64}$'),
	instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
	predecessor_root_incarnation_id uuid,
	root_incarnation_id uuid not null unique,
	plan jsonb not null,
	plan_sha256 text not null check(plan_sha256 ~ '^[0-9a-f]{64}$'),
	phase text not null check(phase in ('fenced','stopped','custodied','powered_off','root_deleted','root_created','restored','prepared','active')),
	revision bigint not null default 1 check(revision between 1 and 9007199254740991),
	custody jsonb,
	custody_sha256 text check(custody_sha256 ~ '^[0-9a-f]{64}$'),
	restore jsonb,
	restore_sha256 text check(restore_sha256 ~ '^[0-9a-f]{64}$'),
	office_revision bigint not null,
	privacy_state text not null,
	privacy_version bigint not null,
	privacy_challenge jsonb,
	begun_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check((custody is null)=(custody_sha256 is null)),
	check((restore is null)=(restore_sha256 is null)),
	check(predecessor_root_incarnation_id is null or predecessor_root_incarnation_id<>root_incarnation_id)
);
-- One nonterminal reset per allocation; a completed reset may be followed by
-- another explicit reset that names the then-current incarnation.
create unique index qorpera_runtime_office_reset_open on public.qorpera_runtime_office_resets(allocation_id) where phase<>'active';
create index qorpera_runtime_office_reset_allocation on public.qorpera_runtime_office_resets(allocation_id,begun_at);
create table public.qorpera_runtime_office_reset_events (
	reset_id uuid not null references public.qorpera_runtime_office_resets(reset_id) on delete restrict,
	sequence bigint not null check(sequence between 1 and 9),
	phase text not null check(phase in ('fenced','stopped','custodied','powered_off','root_deleted','root_created','restored','prepared','active')),
	previous_sha256 text check(previous_sha256 ~ '^[0-9a-f]{64}$'),
	evidence jsonb not null,
	evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
	challenge_id uuid,
	recorded_at timestamptz not null default clock_timestamp(),
	primary key(reset_id,sequence),
	check((sequence=1)=(previous_sha256 is null))
);
create table public.qorpera_runtime_office_reset_challenges (
	id uuid primary key,
	reset_id uuid not null references public.qorpera_runtime_office_resets(reset_id) on delete restrict,
	phase text not null check(phase in ('stopped','custodied','powered_off','root_deleted','root_created','restored')),
	revision bigint not null,
	office_revision bigint not null,
	privacy_version bigint not null,
	evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
	issued_at timestamptz not null,
	expires_at timestamptz not null,
	check(expires_at=issued_at+interval '5 seconds')
);
create index qorpera_runtime_office_reset_challenges_reset on public.qorpera_runtime_office_reset_challenges(reset_id,phase);

create function public.qorpera_runtime_office_reset_phase_index(p_phase text)
returns integer language sql immutable set search_path = '' as $$
	select array_position(array['fenced','stopped','custodied','powered_off','root_deleted','root_created','restored','prepared','active'],p_phase)
$$;

create function public.qorpera_assert_runtime_office_reset_plan(p_plan jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_commands jsonb:=p_plan->'commands'; v_key text; v_fresh text[]; v_retained text[]; v_root text;
begin
	if not public.qorpera_screen_metadata_object(p_plan,array['schema','resetId','intentId','predecessor','preparationObservationSha256',
			'providerBindingSha256','nodeId','predecessorRootIncarnationId','rootIncarnationId','successorActivationId','commands','custody'])
		or p_plan->>'schema' is distinct from 'qorpera.lxd-office-reset-plan/v1' or octet_length(p_plan::text)>65536
		or not public.qorpera_screen_metadata_object(v_commands,array['stopCommandId','deleteCommandId','createCommandId','startCommandId'])
		or not public.qorpera_screen_metadata_object(p_plan->'custody',array['archiveRoot']) then
		raise exception 'Invalid office reset plan' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_plan->'predecessor');
	if p_plan#>>'{predecessor,action}'<>'replace' then raise exception 'Office reset requires a replace predecessor' using errcode='22023'; end if;
	foreach v_key in array array['resetId','intentId','rootIncarnationId','successorActivationId'] loop
		if not public.qorpera_screen_metadata_uuid(p_plan->v_key) then raise exception 'Invalid office reset identity' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['stopCommandId','deleteCommandId','createCommandId','startCommandId'] loop
		if not public.qorpera_screen_metadata_uuid(v_commands->v_key) then raise exception 'Invalid office reset command' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['nodeId','predecessorRootIncarnationId'] loop
		if p_plan->v_key<>'null'::jsonb and not public.qorpera_screen_metadata_uuid(p_plan->v_key) then
			raise exception 'Invalid office reset binding' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['preparationObservationSha256','providerBindingSha256'] loop
		if jsonb_typeof(p_plan->v_key) is distinct from 'string' or (p_plan->>v_key)!~'^[0-9a-f]{64}$' then
			raise exception 'Invalid office reset digest' using errcode='22023'; end if;
	end loop;
	v_root:=p_plan#>>'{custody,archiveRoot}';
	if jsonb_typeof(p_plan#>'{custody,archiveRoot}') is distinct from 'string' or v_root='/' or v_root!~'^/' or length(v_root)>4096
		or v_root~'/$' or v_root~'[[:cntrl:] \\]' or v_root~'(^|/)\.\.?(/|$)' or v_root~'//' then
		raise exception 'Invalid office reset custody root' using errcode='22023'; end if;
	v_fresh:=array[p_plan->>'resetId',p_plan->>'rootIncarnationId',p_plan->>'successorActivationId',v_commands->>'stopCommandId',
		v_commands->>'deleteCommandId',v_commands->>'createCommandId',v_commands->>'startCommandId']
		||case when p_plan->'predecessorRootIncarnationId'='null'::jsonb then '{}'::text[] else array[p_plan->>'predecessorRootIncarnationId'] end;
	v_retained:=array[p_plan->>'intentId',p_plan#>>'{predecessor,transitionId}',p_plan#>>'{predecessor,activationId}',
		p_plan#>>'{predecessor,startup,bootId}',p_plan#>>'{predecessor,startup,allocationId}']
		||case when p_plan->'nodeId'='null'::jsonb then '{}'::text[] else array[p_plan->>'nodeId'] end;
	if (select count(distinct x) from unnest(v_fresh) x)<>array_length(v_fresh,1) or v_fresh && v_retained then
		raise exception 'Office reset identities cannot be reused' using errcode='22023'; end if;
end $$;

create function public.qorpera_assert_runtime_office_reset_custody(p_custody jsonb,p_plan jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_file jsonb; v_previous text:=''; v_total bigint:=0; v_history_root text; v_manifest text; v_claim boolean:=false; v_seal boolean:=false;
	v_outbox jsonb:=p_custody->'outbox'; v_history jsonb:=p_custody->'history'; v_nas jsonb:=p_custody->'nas';
begin
	perform public.qorpera_assert_runtime_office_reset_plan(p_plan);
	if not public.qorpera_screen_metadata_object(p_custody,array['schema','resetId','rootIncarnationId','predecessorActivationId','outbox','history','journalHeadSha256','nas'])
		or p_custody->>'schema' is distinct from 'qorpera.office-reset-custody/v1' or octet_length(p_custody::text)>65536
		or p_custody->'resetId'<>p_plan->'resetId' or p_custody->'rootIncarnationId'<>p_plan->'rootIncarnationId'
		or p_custody->'predecessorActivationId'<>p_plan#>'{predecessor,activationId}'
		or not public.qorpera_screen_metadata_object(v_outbox,array['manifestSha256','recordCount','totalBytes'])
		or not public.qorpera_screen_metadata_object(v_history,array['manifestSha256','files','totalBytes'])
		or not public.qorpera_screen_metadata_object(v_nas,array['workbenchSource','adoptionId','layoutSha256'])
		or jsonb_typeof(p_custody->'journalHeadSha256') is distinct from 'string' or (p_custody->>'journalHeadSha256')!~'^[0-9a-f]{64}$'
		or jsonb_typeof(v_outbox->'manifestSha256') is distinct from 'string' or (v_outbox->>'manifestSha256')!~'^[0-9a-f]{64}$'
		or jsonb_typeof(v_history->'manifestSha256') is distinct from 'string' or (v_history->>'manifestSha256')!~'^[0-9a-f]{64}$'
		or jsonb_typeof(v_nas->'layoutSha256') is distinct from 'string' or (v_nas->>'layoutSha256')!~'^[0-9a-f]{64}$'
		or not public.qorpera_screen_metadata_uuid(v_nas->'adoptionId')
		or jsonb_typeof(v_nas->'workbenchSource') is distinct from 'string' or (v_nas->>'workbenchSource')!~'^/' or (v_nas->>'workbenchSource')='/'
		or jsonb_typeof(v_outbox->'recordCount') is distinct from 'number' or (v_outbox->>'recordCount')!~'^(0|[1-9][0-9]{0,3})$' or (v_outbox->>'recordCount')::bigint>8192
		or not public.qorpera_screen_metadata_positive(v_outbox->'totalBytes') or (v_outbox->>'totalBytes')::bigint>67108864+73729
		or jsonb_typeof(v_history->'files') is distinct from 'array' or jsonb_array_length(v_history->'files')<2 or jsonb_array_length(v_history->'files')>1024 then
		raise exception 'Invalid office reset custody manifest' using errcode='22023'; end if;
	v_history_root:='/etc/qorpera-office/history/'||(p_plan#>>'{predecessor,startup,bootId}')||'/'||(p_plan#>>'{predecessor,activationId}');
	v_manifest:=v_history->>'manifestSha256';
	for v_file in select * from jsonb_array_elements(v_history->'files') loop
		if not public.qorpera_screen_metadata_object(v_file,array['path','bytes','sha256','mode'])
			or jsonb_typeof(v_file->'path') is distinct from 'string' or length(v_file->>'path')>512 or (v_file->>'path')<=v_previous
			or not ((v_file->>'path')~'^/etc/qorpera-office/history/[0-9a-f-]{36}/[0-9a-f-]{36}/(manifest|claim|[0-9a-f]{64})\.json$'
				or (v_file->>'path') in ('/etc/qorpera-office/adoption.json','/etc/qorpera-office/credentials/config.json')
				or (v_file->>'path')~'^/etc/qorpera-office/boots/[0-9a-f]{32}/(adoption|configuration-claim|configuration-completion|reset-configuration-claim|reset-configuration-completion)\.json$'
				or (v_file->>'path')~'^/etc/qorpera-office/boots/[0-9a-f]{32}/credentials/config\.json$')
			or not public.qorpera_screen_metadata_positive(v_file->'bytes') or (v_file->>'bytes')::bigint>65536
			or jsonb_typeof(v_file->'sha256') is distinct from 'string' or (v_file->>'sha256')!~'^[0-9a-f]{64}$'
			or v_file->'mode' not in ('256'::jsonb,'292'::jsonb,'384'::jsonb) then
			raise exception 'Invalid office reset history file' using errcode='22023'; end if;
		v_previous:=v_file->>'path'; v_total:=v_total+(v_file->>'bytes')::bigint;
		if (v_file->>'path')=v_history_root||'/manifest.json' and (v_file->>'sha256')=v_manifest then v_seal:=true; end if;
		if (v_file->>'path')=v_history_root||'/claim.json' and (v_file->>'sha256')=v_manifest then v_claim:=true; end if;
	end loop;
	if v_total>8388608 or v_history->'totalBytes'<>to_jsonb(v_total) or not v_seal or not v_claim then
		raise exception 'Office reset history totals differ' using errcode='22023'; end if;
end $$;

create function public.qorpera_assert_runtime_office_reset_restore(p_restore jsonb,p_custody jsonb,p_plan jsonb,p_custody_sha256 text)
returns void language plpgsql immutable set search_path = '' as $$
declare v_count bigint; v_bytes bigint;
begin
	perform public.qorpera_assert_runtime_office_reset_custody(p_custody,p_plan);
	select count(*),coalesce(sum((f->>'bytes')::bigint),0) into v_count,v_bytes from jsonb_array_elements(p_custody#>'{history,files}') f
		where (f->>'path')='/etc/qorpera-office/adoption.json' or (f->>'path')~'^/etc/qorpera-office/history/';
	if not public.qorpera_screen_metadata_object(p_restore,array['schema','resetId','rootIncarnationId','custodySha256','bootId','outbox','history','nas','state'])
		or p_restore->>'schema' is distinct from 'qorpera.office-reset-restore/v1' or p_restore->>'state' is distinct from 'restored'
		or octet_length(p_restore::text)>65536 or p_restore->'resetId'<>p_plan->'resetId' or p_restore->'rootIncarnationId'<>p_plan->'rootIncarnationId'
		or p_custody_sha256 is null or p_custody_sha256!~'^[0-9a-f]{64}$' or p_restore->>'custodySha256' is distinct from p_custody_sha256
		or not public.qorpera_screen_metadata_uuid(p_restore->'bootId') or p_restore->'bootId'=p_plan#>'{predecessor,startup,bootId}'
		or p_restore->'outbox' is distinct from jsonb_build_object('manifestSha256',p_custody#>'{outbox,manifestSha256}',
			'fileCount',(p_custody#>>'{outbox,recordCount}')::bigint+1,'totalBytes',p_custody#>'{outbox,totalBytes}')
		or p_restore->'history' is distinct from jsonb_build_object('fileCount',v_count,'totalBytes',v_bytes)
		or p_restore->'nas' is distinct from jsonb_build_object('reattached',true,'layoutSha256',p_custody#>'{nas,layoutSha256}') then
		raise exception 'Invalid office reset restore receipt' using errcode='22023'; end if;
end $$;

create function public.qorpera_runtime_office_reset_result(p_reset public.qorpera_runtime_office_resets)
returns jsonb language sql volatile set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-reset/v1','resetId',p_reset.reset_id,'phase',p_reset.phase,'revision',p_reset.revision,
		'rootIncarnationId',p_reset.root_incarnation_id,'successorActivationId',p_reset.successor_activation_id,
		'custodySha256',p_reset.custody_sha256,'restoreSha256',p_reset.restore_sha256,
		'stopAcknowledgedAtMs',(select floor(extract(epoch from s.acknowledged_at)*1000)::bigint from public.qorpera_runtime_office_stops s where s.transition_id=p_reset.transition_id),
		'officeRevision',p_reset.office_revision,'privacyVersion',p_reset.privacy_version,'validForMs',5000)
$$;

-- Profile -> office -> provider -> activation -> allocation -> node demand ->
-- transition -> reset. Before successor preparation the predecessor must still
-- be the current active activation; afterwards it is superseded by design.
create function public.qorpera_lock_runtime_office_reset(p_plan jsonb,p_superseded boolean)
returns public.qorpera_runtime_office_resets language plpgsql security definer set search_path = '' as $$
declare v_request jsonb:=p_plan->'predecessor'; v_office public.qorpera_runtime_offices%rowtype;
	v_activation public.qorpera_runtime_office_activations%rowtype; v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_demand public.qorpera_runtime_node_demands%rowtype; v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_reset_plan(p_plan);
	perform public.qorpera_assert_runtime_office_provider(v_request#>'{startup,scope}',(v_request#>>'{startup,computerGeneration}')::bigint,
		(v_request->>'providerId')::uuid,v_request->>'providerPolicySha256',false);
	select * into strict v_office from public.qorpera_runtime_offices where id=(v_request#>>'{startup,scope,companyComputerId}')::uuid;
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(v_request->>'activationId')::uuid for update;
	if not found or v_office.state<>'maintenance' or v_activation.state<>'active' or v_activation.office_id<>v_office.id
		or v_activation.computer_generation<>v_office.generation or (not p_superseded and v_activation.superseded_at is not null)
		or v_activation.provider_id::text is distinct from v_request->>'providerId'
		or v_activation.provider_policy_sha256 is distinct from v_request->>'providerPolicySha256'
		or v_activation.allocation_id::text is distinct from v_request#>>'{startup,allocationId}'
		or v_activation.instance_sha256 is distinct from v_request#>>'{startup,instanceSha256}'
		or v_activation.image_sha256 is distinct from v_request#>>'{startup,imageSha256}'
		or v_activation.bootstrap_sha256 is distinct from v_request#>>'{startup,bootstrapSha256}'
		or v_activation.attestation->>'bootId' is distinct from v_request#>>'{startup,bootId}'
		or v_activation.attestation->>'configurationSha256' is distinct from v_request#>>'{startup,configurationSha256}'
		or v_activation.service_invocation_id is distinct from v_request#>>'{startup,serviceInvocationId}'
		or v_activation.intent_id::text is distinct from p_plan->>'intentId'
		or v_activation.provider_binding_sha256 is distinct from p_plan->>'providerBindingSha256'
		or v_activation.attestation->>'preparationObservationSha256' is distinct from p_plan->>'preparationObservationSha256' then
		raise exception 'Office reset activation differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_machine_allocations where id=v_activation.allocation_id and office_id=v_office.id
		and computer_generation=v_office.generation and profile_id=v_office.profile_id and provider_adapter='lxd'
		and instance_sha256=v_activation.instance_sha256 and released_at is null for share;
	if not found then raise exception 'Office reset allocation differs' using errcode='42501'; end if;
	select * into v_demand from public.qorpera_runtime_node_demands where allocation_id=v_activation.allocation_id for share;
	if (found and (v_demand.released_at is not null or v_demand.node_id::text is distinct from p_plan->>'nodeId'))
		or (not found and p_plan->'nodeId'<>'null'::jsonb) then
		raise exception 'Office reset node binding differs' using errcode='42501'; end if;
	select * into v_transition from public.qorpera_runtime_office_lifecycle_transitions where id=(v_request->>'transitionId')::uuid for update;
	if not found or v_transition.request<>v_request or v_transition.activation_id<>v_activation.activation_id
		or v_transition.office_id<>v_office.id or v_transition.computer_generation<>v_office.generation
		or v_transition.allocation_id<>v_activation.allocation_id then raise exception 'Office reset revocation differs' using errcode='42501'; end if;
	select * into v_reset from public.qorpera_runtime_office_resets where reset_id=(p_plan->>'resetId')::uuid for update;
	if not found or v_reset.plan<>p_plan or v_reset.transition_id<>v_transition.id then
		raise exception 'Office reset identity unavailable' using errcode='42501'; end if;
	return v_reset;
end $$;

create function public.qorpera_begin_runtime_office_reset(p_plan jsonb,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request jsonb:=p_plan->'predecessor'; v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_old public.qorpera_runtime_office_activations%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_existing public.qorpera_runtime_office_resets%rowtype; v_demand public.qorpera_runtime_node_demands%rowtype;
	v_previous uuid; v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_reset_plan(p_plan);
	if p_plan_sha256 is null or p_plan_sha256!~'^[0-9a-f]{64}$' then raise exception 'Invalid office reset plan digest' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_provider(v_request#>'{startup,scope}',(v_request#>>'{startup,computerGeneration}')::bigint,
		(v_request->>'providerId')::uuid,v_request->>'providerPolicySha256',false);
	select * into v_existing from public.qorpera_runtime_office_resets where reset_id=(p_plan->>'resetId')::uuid
		or transition_id=(v_request->>'transitionId')::uuid or root_incarnation_id=(p_plan->>'rootIncarnationId')::uuid
		or successor_activation_id=(p_plan->>'successorActivationId')::uuid limit 1;
	if found then
		if v_existing.plan<>p_plan or v_existing.plan_sha256<>p_plan_sha256 then
			raise exception 'Office reset cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_reset_result(public.qorpera_lock_runtime_office_reset(p_plan,v_existing.phase in ('prepared','active')));
	end if;
	v_transition:=public.qorpera_lock_runtime_office_stop(v_request);
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_transition.activation_id;
	if v_old.intent_id::text is distinct from p_plan->>'intentId' or v_old.provider_binding_sha256 is distinct from p_plan->>'providerBindingSha256'
		or v_old.attestation->>'preparationObservationSha256' is distinct from p_plan->>'preparationObservationSha256' then
		raise exception 'Office reset origin differs' using errcode='42501'; end if;
	select * into v_demand from public.qorpera_runtime_node_demands where allocation_id=v_old.allocation_id for share;
	if (found and (v_demand.released_at is not null or v_demand.node_id::text is distinct from p_plan->>'nodeId'))
		or (not found and p_plan->'nodeId'<>'null'::jsonb) then
		raise exception 'Office reset node binding differs' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_resets where allocation_id=v_old.allocation_id and phase<>'active') then
		raise exception 'Office reset already open' using errcode='42501'; end if;
	select root_incarnation_id into v_previous from public.qorpera_runtime_office_resets where allocation_id=v_old.allocation_id and phase='active'
		order by begun_at desc,reset_id desc limit 1;
	if v_previous::text is distinct from p_plan->>'predecessorRootIncarnationId' then
		raise exception 'Office reset incarnation lineage differs' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_activations where activation_id=(p_plan->>'successorActivationId')::uuid) then
		raise exception 'Office reset successor cannot be reused' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	insert into public.qorpera_runtime_office_resets(reset_id,transition_id,predecessor_activation_id,successor_activation_id,office_id,computer_generation,
		allocation_id,node_id,provider_id,provider_policy_sha256,instance_sha256,predecessor_root_incarnation_id,root_incarnation_id,plan,plan_sha256,phase,
		office_revision,privacy_state,privacy_version,privacy_challenge)
	values((p_plan->>'resetId')::uuid,v_transition.id,v_old.activation_id,(p_plan->>'successorActivationId')::uuid,v_office.id,v_office.generation,
		v_old.allocation_id,v_demand.node_id,v_old.provider_id,v_old.provider_policy_sha256,v_old.instance_sha256,v_previous,(p_plan->>'rootIncarnationId')::uuid,
		p_plan,p_plan_sha256,'fenced',v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge)
	returning * into v_reset;
	insert into public.qorpera_runtime_office_reset_events(reset_id,sequence,phase,previous_sha256,evidence,evidence_sha256)
	values(v_reset.reset_id,1,'fenced',null,jsonb_build_object('schema','qorpera.office-reset-phase-evidence/v1','resetId',v_reset.reset_id,'phase','fenced',
		'observation',jsonb_build_object('planSha256',p_plan_sha256,'revocationRevision',v_transition.revocation_revision)),p_plan_sha256);
	return public.qorpera_runtime_office_reset_result(v_reset);
end $$;

create function public.qorpera_runtime_office_reset_status(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request jsonb:=p_plan->'predecessor'; v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_reset_plan(p_plan);
	perform public.qorpera_assert_runtime_office_provider(v_request#>'{startup,scope}',(v_request#>>'{startup,computerGeneration}')::bigint,
		(v_request->>'providerId')::uuid,v_request->>'providerPolicySha256',false);
	select * into v_reset from public.qorpera_runtime_office_resets where reset_id=(p_plan->>'resetId')::uuid for share;
	if not found or v_reset.plan<>p_plan then raise exception 'Office reset identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_reset_result(v_reset);
end $$;

-- Phase gates. Observation and safe custody may proceed while preparation is
-- disabled or execution paused; destruction and the new boot may not.
create function public.qorpera_gate_runtime_office_reset_phase(p_reset public.qorpera_runtime_office_resets,p_phase text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_old public.qorpera_runtime_office_activations%rowtype; v_index integer;
begin
	v_index:=public.qorpera_runtime_office_reset_phase_index(p_phase);
	if p_phase not in ('stopped','custodied','powered_off','root_deleted','root_created','restored')
		or public.qorpera_runtime_office_reset_phase_index(p_reset.phase)<>v_index-1 then
		raise exception 'Office reset phase order differs' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=p_reset.office_id;
	if v_office.state<>'maintenance' or v_office.privacy_state<>p_reset.privacy_state or v_office.privacy_version<>p_reset.privacy_version
		or v_office.privacy_challenge is distinct from p_reset.privacy_challenge then
		raise exception 'Office reset snapshot changed' using errcode='42501'; end if;
	if not exists(select 1 from public.qorpera_runtime_office_stops where transition_id=p_reset.transition_id) then
		raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	if v_index>=4 and p_reset.custody_sha256 is null then raise exception 'Office reset custody unavailable' using errcode='42501'; end if;
	if p_phase in ('root_deleted','root_created','restored') then
		perform public.qorpera_assert_runtime_office_provider(public.qorpera_runtime_office_scope(v_office),v_office.generation,
			p_reset.provider_id,p_reset.provider_policy_sha256,true);
		select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=p_reset.predecessor_activation_id;
		perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	end if;
end $$;

create function public.qorpera_runtime_office_reset_challenge_result(p_challenge public.qorpera_runtime_office_reset_challenges)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_ms bigint;
begin
	v_ms:=least(5000,floor(extract(epoch from(p_challenge.expires_at-clock_timestamp()))*1000)::bigint);
	if v_ms<1 then raise exception 'Office reset challenge expired' using errcode='42501'; end if;
	return jsonb_build_object('schema','qorpera.office-reset-phase-challenge/v1','challengeId',p_challenge.id,'resetId',p_challenge.reset_id,
		'phase',p_challenge.phase,'revision',p_challenge.revision,'officeRevision',p_challenge.office_revision,
		'privacyVersion',p_challenge.privacy_version,'evidenceSha256',p_challenge.evidence_sha256,'validForMs',v_ms);
end $$;

create function public.qorpera_prepare_runtime_office_reset_phase(p_plan jsonb,p_phase text,p_challenge_id uuid,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reset public.qorpera_runtime_office_resets%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_challenge public.qorpera_runtime_office_reset_challenges%rowtype; v_now timestamptz;
begin
	v_reset:=public.qorpera_lock_runtime_office_reset(p_plan,false);
	if p_challenge_id is null or p_evidence_sha256 is null or p_evidence_sha256!~'^[0-9a-f]{64}$'
		or p_challenge_id::text in (p_plan->>'resetId',p_plan#>>'{commands,stopCommandId}',p_plan#>>'{commands,deleteCommandId}',
			p_plan#>>'{commands,createCommandId}',p_plan#>>'{commands,startCommandId}') then
		raise exception 'Invalid office reset challenge' using errcode='22023'; end if;
	perform public.qorpera_gate_runtime_office_reset_phase(v_reset,p_phase);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_reset.office_id;
	select * into v_challenge from public.qorpera_runtime_office_reset_challenges where id=p_challenge_id for update;
	if found then
		if v_challenge.reset_id<>v_reset.reset_id or v_challenge.phase<>p_phase or v_challenge.revision<>v_reset.revision
			or v_challenge.evidence_sha256<>p_evidence_sha256 or v_challenge.office_revision<>v_office.revision
			or v_challenge.privacy_version<>v_office.privacy_version then
			raise exception 'Office reset challenge changed' using errcode='42501'; end if;
	else
		if (select count(*) from public.qorpera_runtime_office_reset_challenges where reset_id=v_reset.reset_id and phase=p_phase)>=64 then
			raise exception 'Office reset challenge budget exhausted' using errcode='54000'; end if;
		v_now:=clock_timestamp();
		insert into public.qorpera_runtime_office_reset_challenges(id,reset_id,phase,revision,office_revision,privacy_version,evidence_sha256,issued_at,expires_at)
		values(p_challenge_id,v_reset.reset_id,p_phase,v_reset.revision,v_office.revision,v_office.privacy_version,p_evidence_sha256,v_now,v_now+interval '5 seconds')
		returning * into v_challenge;
	end if;
	return public.qorpera_runtime_office_reset_challenge_result(v_challenge);
end $$;

create function public.qorpera_check_runtime_office_reset_phase(p_plan jsonb,p_challenge_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reset public.qorpera_runtime_office_resets%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_challenge public.qorpera_runtime_office_reset_challenges%rowtype;
begin
	v_reset:=public.qorpera_lock_runtime_office_reset(p_plan,false);
	select * into v_challenge from public.qorpera_runtime_office_reset_challenges where id=p_challenge_id for share;
	if not found or v_challenge.reset_id<>v_reset.reset_id or v_challenge.revision<>v_reset.revision then
		raise exception 'Office reset challenge unavailable' using errcode='42501'; end if;
	perform public.qorpera_gate_runtime_office_reset_phase(v_reset,v_challenge.phase);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_reset.office_id;
	if v_challenge.office_revision<>v_office.revision or v_challenge.privacy_version<>v_office.privacy_version then
		raise exception 'Office reset challenge changed' using errcode='42501'; end if;
	return public.qorpera_runtime_office_reset_challenge_result(v_challenge);
end $$;

create function public.qorpera_ack_runtime_office_reset_phase(p_plan jsonb,p_challenge_id uuid,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reset public.qorpera_runtime_office_resets%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_challenge public.qorpera_runtime_office_reset_challenges%rowtype; v_event public.qorpera_runtime_office_reset_events%rowtype;
	v_observation jsonb:=p_evidence->'observation'; v_index integer; v_previous text; v_custody jsonb; v_restore jsonb;
begin
	v_reset:=public.qorpera_lock_runtime_office_reset(p_plan,false);
	select * into v_challenge from public.qorpera_runtime_office_reset_challenges where id=p_challenge_id for update;
	if not found or v_challenge.reset_id<>v_reset.reset_id then raise exception 'Office reset challenge unavailable' using errcode='42501'; end if;
	if not public.qorpera_screen_metadata_object(p_evidence,array['schema','resetId','phase','observation'])
		or p_evidence->>'schema' is distinct from 'qorpera.office-reset-phase-evidence/v1' or octet_length(p_evidence::text)>65536
		or p_evidence->'resetId'<>p_plan->'resetId' or p_evidence->>'phase' is distinct from v_challenge.phase
		or jsonb_typeof(v_observation) is distinct from 'object' or v_observation='{}'::jsonb then
		raise exception 'Invalid office reset evidence' using errcode='22023'; end if;
	v_index:=public.qorpera_runtime_office_reset_phase_index(v_challenge.phase);
	if v_reset.phase=v_challenge.phase then
		select * into v_event from public.qorpera_runtime_office_reset_events where reset_id=v_reset.reset_id and sequence=v_index;
		if not found or v_event.challenge_id is distinct from p_challenge_id or v_event.evidence<>p_evidence then
			raise exception 'Office reset phase cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_reset_result(v_reset);
	end if;
	perform public.qorpera_gate_runtime_office_reset_phase(v_reset,v_challenge.phase);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_reset.office_id;
	if v_challenge.revision<>v_reset.revision or clock_timestamp()>=v_challenge.expires_at or v_challenge.office_revision<>v_office.revision
		or v_challenge.privacy_version<>v_office.privacy_version then
		raise exception 'Office reset challenge expired or changed' using errcode='42501'; end if;
	case v_challenge.phase
	when 'stopped' then
		if not public.qorpera_screen_metadata_object(v_observation,array['stopCommandId','acknowledgedAtMs','stopCompletionSha256'])
			or not public.qorpera_screen_metadata_uuid(v_observation->'stopCommandId')
			or not public.qorpera_screen_metadata_positive(v_observation->'acknowledgedAtMs')
			or v_observation->'acknowledgedAtMs'<>(select to_jsonb(floor(extract(epoch from s.acknowledged_at)*1000)::bigint)
				from public.qorpera_runtime_office_stops s where s.transition_id=v_reset.transition_id)
			or jsonb_typeof(v_observation->'stopCompletionSha256') is distinct from 'string' or (v_observation->>'stopCompletionSha256')!~'^[0-9a-f]{64}$' then
			raise exception 'Office reset stop evidence differs' using errcode='42501'; end if;
	when 'custodied' then
		perform public.qorpera_assert_runtime_office_reset_custody(v_observation,p_plan);
		v_custody:=v_observation;
	when 'powered_off','root_deleted','root_created' then
		if not public.qorpera_screen_metadata_object(v_observation,case when v_challenge.phase='root_deleted' then array['commandId','operationId']
				else array['commandId','operationId','instanceSha256'] end)
			or v_observation->'commandId'<>p_plan#>array['commands',case v_challenge.phase when 'powered_off' then 'stopCommandId'
				when 'root_deleted' then 'deleteCommandId' else 'createCommandId' end]
			or not public.qorpera_screen_metadata_uuid(v_observation->'operationId')
			or (v_challenge.phase<>'root_deleted' and v_observation->>'instanceSha256' is distinct from v_reset.instance_sha256) then
			raise exception 'Office reset physical evidence differs' using errcode='42501'; end if;
	when 'restored' then
		perform public.qorpera_assert_runtime_office_reset_restore(v_observation,v_reset.custody,p_plan,v_reset.custody_sha256);
		if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_reset.allocation_id
			and attestation->>'bootId'=v_observation->>'bootId') then
			raise exception 'Office reset boot identity cannot be reused' using errcode='42501'; end if;
		v_restore:=v_observation;
	end case;
	select evidence_sha256 into strict v_previous from public.qorpera_runtime_office_reset_events where reset_id=v_reset.reset_id and sequence=v_index-1;
	update public.qorpera_runtime_office_resets set phase=v_challenge.phase,revision=revision+1,updated_at=clock_timestamp(),
		custody=coalesce(v_custody,custody),custody_sha256=case when v_custody is null then custody_sha256 else v_challenge.evidence_sha256 end,
		restore=coalesce(v_restore,restore),restore_sha256=case when v_restore is null then restore_sha256 else v_challenge.evidence_sha256 end
		where reset_id=v_reset.reset_id and revision=v_challenge.revision returning * into v_reset;
	if not found then raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message','Office reset revision changed','details',null,'hint',null)::text, detail='{"status":409,"headers":{}}'; end if;
	insert into public.qorpera_runtime_office_reset_events(reset_id,sequence,phase,previous_sha256,evidence,evidence_sha256,challenge_id)
	values(v_reset.reset_id,v_index,v_challenge.phase,v_previous,p_evidence,v_challenge.evidence_sha256,p_challenge_id);
	if clock_timestamp()>=v_challenge.expires_at then raise exception 'Office reset acknowledgement expired' using errcode='42501'; end if;
	return public.qorpera_runtime_office_reset_result(v_reset);
end $$;

create function public.qorpera_assert_runtime_office_reset_successor_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text;
begin
	if not public.qorpera_screen_metadata_object(p_request,array['schema','resetId','rootIncarnationId','predecessor','attestation','custodySha256','restoreSha256'])
		or p_request->>'schema' is distinct from 'qorpera.office-reset-successor-request/v1' or octet_length(p_request::text)>65536 then
		raise exception 'Invalid office reset successor request' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request->'predecessor');
	perform public.qorpera_assert_runtime_office_activation_attestation(p_request->'attestation');
	foreach v_key in array array['resetId','rootIncarnationId'] loop
		if not public.qorpera_screen_metadata_uuid(p_request->v_key) then raise exception 'Invalid office reset successor identity' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['custodySha256','restoreSha256'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string' or (p_request->>v_key)!~'^[0-9a-f]{64}$' then
			raise exception 'Invalid office reset successor digest' using errcode='22023'; end if;
	end loop;
	if p_request#>>'{predecessor,action}'<>'replace'
		or p_request#>'{attestation,activationId}'=p_request#>'{predecessor,activationId}'
		or p_request#>'{attestation,bootId}'=p_request#>'{predecessor,startup,bootId}'
		or p_request#>'{attestation,configurationSha256}'=p_request#>'{predecessor,startup,configurationSha256}'
		or (select count(distinct x) from unnest(array[p_request->>'resetId',p_request->>'rootIncarnationId',p_request#>>'{attestation,activationId}',
			p_request#>>'{attestation,bootId}']) x)<>4 then
		raise exception 'Office reset successor requires a distinct activation, boot and configuration' using errcode='22023'; end if;
end $$;

create function public.qorpera_runtime_office_reset_successor_result(p_activation public.qorpera_runtime_office_activations)
returns jsonb language sql volatile set search_path = '' as $$
	select public.qorpera_runtime_office_successor_result(p_activation)||jsonb_build_object('schema','qorpera.office-reset-successor/v1')
$$;

create function public.qorpera_runtime_office_reset_successor_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_successor public.qorpera_runtime_office_successors%rowtype;
	v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	perform public.qorpera_assert_runtime_office_reset_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid for share;
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=v_activation.activation_id for share;
	select * into v_reset from public.qorpera_runtime_office_resets where reset_id=(p_request->>'resetId')::uuid for share;
	if v_successor.activation_id is null or v_successor.request<>p_request or v_activation.superseded_at is not null
		or v_reset.reset_id is null or v_reset.successor_activation_id<>v_activation.activation_id or v_reset.phase not in ('prepared','active')
		or v_reset.custody_sha256 is distinct from p_request->>'custodySha256' or v_reset.restore_sha256 is distinct from p_request->>'restoreSha256' then
		raise exception 'Office reset successor identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_reset_successor_result(v_activation);
end $$;

create function public.qorpera_prepare_runtime_office_reset_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype; v_reset public.qorpera_runtime_office_resets%rowtype;
	v_old public.qorpera_runtime_office_activations%rowtype; v_next public.qorpera_runtime_office_activations%rowtype;
	v_original public.qorpera_runtime_office_activations%rowtype; v_existing public.qorpera_runtime_office_successors%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_key text; v_previous text; v_digest text;
begin
	perform public.qorpera_assert_runtime_office_reset_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_existing from public.qorpera_runtime_office_successors where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid;
	if found then
		if v_existing.request<>p_request then raise exception 'Office reset successor cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_reset_successor_status(p_request);
	end if;
	-- Same lock order as every retained successor: activation, allocation,
	-- transition, then the reset row itself.
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_transition.activation_id;
	perform 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id for share;
	if not found then raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	select * into v_reset from public.qorpera_runtime_office_resets where reset_id=(p_request->>'resetId')::uuid for update;
	if not found or v_reset.transition_id<>v_transition.id or v_reset.phase<>'restored' or v_reset.plan->'predecessor'<>p_request->'predecessor'
		or v_reset.root_incarnation_id::text<>p_request->>'rootIncarnationId'
		or v_reset.successor_activation_id::text<>p_request#>>'{attestation,activationId}'
		or v_reset.custody_sha256 is distinct from p_request->>'custodySha256' or v_reset.restore_sha256 is distinct from p_request->>'restoreSha256'
		or v_reset.restore->>'bootId' is distinct from p_request#>>'{attestation,bootId}' then
		raise exception 'Office reset chain incomplete' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id
		and (attestation->>'bootId'=p_request#>>'{attestation,bootId}' or attestation->>'configurationSha256'=p_request#>>'{attestation,configurationSha256}'
			or attestation->>'configurationObservationSha256'=p_request#>>'{attestation,configurationObservationSha256}')) then
		raise exception 'Office reset requires fresh boot and configuration identity' using errcode='42501'; end if;
	select * into strict v_original from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id and predecessor_activation_id is null;
	if p_request#>'{attestation,nativePort}' is distinct from v_old.attestation->'nativePort'
		or p_request#>'{attestation,viewerPort}' is distinct from v_old.attestation->'viewerPort'
		or p_request#>'{attestation,preparationObservationSha256}' is distinct from v_old.attestation->'preparationObservationSha256'
		or p_request#>'{attestation,adoptionReceiptSha256}' is distinct from v_original.attestation->'adoptionReceiptSha256' then
		raise exception 'Office reset successor retains the original preparation, receipt and listeners' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	if v_office.privacy_state<>v_reset.privacy_state or v_office.privacy_version<>v_reset.privacy_version
		or v_office.privacy_challenge is distinct from v_reset.privacy_challenge then
		raise exception 'Office reset snapshot changed' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_provider(public.qorpera_runtime_office_scope(v_office),v_office.generation,v_reset.provider_id,v_reset.provider_policy_sha256,true);
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=v_old.activation_id;
	insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,provider_id,
		provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state,predecessor_activation_id)
	values(v_old.intent_id,(p_request#>>'{attestation,activationId}')::uuid,v_old.office_id,v_old.computer_generation,v_old.allocation_id,v_old.provider_id,
		v_old.provider_policy_sha256,v_old.provider_binding_sha256,v_old.instance_sha256,v_old.image_sha256,v_old.bootstrap_sha256,p_request->'attestation',v_old.mappings,'prepared',v_old.activation_id)
	returning * into v_next;
	insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version,privacy_challenge)
	values(v_next.activation_id,v_transition.id,p_request,v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge);
	select evidence_sha256 into strict v_previous from public.qorpera_runtime_office_reset_events where reset_id=v_reset.reset_id and sequence=7;
	v_digest:=encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	update public.qorpera_runtime_office_resets set phase='prepared',revision=revision+1,updated_at=clock_timestamp() where reset_id=v_reset.reset_id returning * into v_reset;
	insert into public.qorpera_runtime_office_reset_events(reset_id,sequence,phase,previous_sha256,evidence,evidence_sha256)
	values(v_reset.reset_id,8,'prepared',v_previous,jsonb_build_object('schema','qorpera.office-reset-phase-evidence/v1','resetId',v_reset.reset_id,'phase','prepared',
		'observation',jsonb_build_object('activationId',v_next.activation_id,'requestSha256',v_digest)),v_digest);
	perform public.qorpera_check_runtime_office_successor_startup(v_next);
	return public.qorpera_runtime_office_reset_successor_result(v_next);
end $$;

create function public.qorpera_check_runtime_office_reset_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_successor public.qorpera_runtime_office_successors%rowtype;
	v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	perform public.qorpera_assert_runtime_office_reset_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations
		where activation_id=(p_request#>>'{attestation,activationId}')::uuid and superseded_at is null for share;
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=v_activation.activation_id for share;
	select * into v_reset from public.qorpera_runtime_office_resets where reset_id=(p_request->>'resetId')::uuid for share;
	if v_activation.activation_id is null or v_successor.activation_id is null or v_successor.request<>p_request
		or v_reset.reset_id is null or v_reset.successor_activation_id<>v_activation.activation_id or v_reset.phase not in ('prepared','active')
		or v_reset.custody_sha256 is distinct from p_request->>'custodySha256' or v_reset.restore_sha256 is distinct from p_request->>'restoreSha256' then
		raise exception 'Office reset successor identity unavailable' using errcode='42501'; end if;
	if v_activation.state='active' then
		perform public.qorpera_check_runtime_office_guest_binding(p_request#>'{predecessor,startup,scope}',
			v_activation.computer_generation,v_activation.allocation_id,v_activation.instance_sha256,
			v_activation.image_sha256,v_activation.bootstrap_sha256);
	else
		perform public.qorpera_check_runtime_office_successor_startup(v_activation);
	end if;
	return public.qorpera_runtime_office_reset_successor_result(v_activation);
end $$;

create function public.qorpera_activate_runtime_office_reset_successor(p_request jsonb,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_reset public.qorpera_runtime_office_resets%rowtype;
	v_previous text; v_digest text;
begin
	perform public.qorpera_runtime_office_reset_successor_status(p_request);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid;
	perform public.qorpera_activate_runtime_office(p_request#>'{predecessor,startup,scope}',v_activation.computer_generation,v_activation.intent_id,
		v_activation.activation_id,v_activation.provider_id,v_activation.provider_policy_sha256,p_service_invocation_id);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=v_activation.activation_id;
	select * into strict v_reset from public.qorpera_runtime_office_resets where reset_id=(p_request->>'resetId')::uuid for update;
	if v_activation.state='active' and v_reset.phase='prepared' then
		select evidence_sha256 into strict v_previous from public.qorpera_runtime_office_reset_events where reset_id=v_reset.reset_id and sequence=8;
		v_digest:=encode(extensions.digest(convert_to(v_reset.reset_id::text||':'||v_activation.service_invocation_id,'utf8'),'sha256'),'hex');
		update public.qorpera_runtime_office_resets set phase='active',revision=revision+1,updated_at=clock_timestamp() where reset_id=v_reset.reset_id;
		insert into public.qorpera_runtime_office_reset_events(reset_id,sequence,phase,previous_sha256,evidence,evidence_sha256)
		values(v_reset.reset_id,9,'active',v_previous,jsonb_build_object('schema','qorpera.office-reset-phase-evidence/v1','resetId',v_reset.reset_id,'phase','active',
			'observation',jsonb_build_object('activationId',v_activation.activation_id,'serviceInvocationId',v_activation.service_invocation_id)),v_digest);
	end if;
	return public.qorpera_runtime_office_reset_successor_status(p_request);
end $$;

-- A reset-linked candidate additionally requires the complete acknowledged
-- reset chain before ordinary startup, readiness or activation. The existing
-- same-boot and reboot checks are retained verbatim.
create or replace function public.qorpera_check_runtime_office_successor_startup(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path = '' as $$
declare v_successor public.qorpera_runtime_office_successors%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_reset public.qorpera_runtime_office_resets%rowtype;
begin
	perform public.qorpera_check_runtime_office_restart_surfaces(p_activation);
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=p_activation.activation_id for share;
	select * into strict v_office from public.qorpera_runtime_offices where id=p_activation.office_id;
	if not found or v_successor.activation_id is null or p_activation.predecessor_activation_id is null or p_activation.superseded_at is not null
		or v_office.revision<>v_successor.office_revision or v_office.privacy_state<>v_successor.privacy_state
		or v_office.privacy_version<>v_successor.privacy_version or v_office.privacy_challenge is distinct from v_successor.privacy_challenge
		or not exists(select 1 from public.qorpera_runtime_office_stops where transition_id=v_successor.transition_id) then
		raise exception 'Office successor snapshot changed' using errcode='42501'; end if;
	select * into v_reset from public.qorpera_runtime_office_resets where successor_activation_id=p_activation.activation_id for share;
	if found and (v_reset.phase not in ('prepared','active') or v_reset.custody_sha256 is null or v_reset.restore_sha256 is null
		or v_successor.request->>'schema' is distinct from 'qorpera.office-reset-successor-request/v1'
		or v_successor.request->>'resetId' is distinct from v_reset.reset_id::text
		or v_successor.request->>'custodySha256' is distinct from v_reset.custody_sha256
		or v_successor.request->>'restoreSha256' is distinct from v_reset.restore_sha256
		or v_reset.transition_id<>v_successor.transition_id) then
		raise exception 'Office reset chain incomplete' using errcode='42501'; end if;
	if not found and v_successor.request->>'schema'='qorpera.office-reset-successor-request/v1' then
		raise exception 'Office reset chain incomplete' using errcode='42501'; end if;
end $$;

-- Operator lifecycle projection: root-incarnation events and custody
-- confirmation class. Database times are still not physical transition times.
create or replace function public.qorpera_runtime_computer_lifecycle(p_allocation_id uuid,p_from timestamptz,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.qorpera_runtime_machine_allocations%rowtype;
 d public.qorpera_runtime_node_demands%rowtype;
 o public.qorpera_runtime_offices%rowtype;
 v_events jsonb; v_count bigint; v_physical jsonb; v_result jsonb; v_incarnations jsonb;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Computer lifecycle requires operator authority' using errcode='42501'; end if;
 if p_allocation_id is null or p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
  or p_from>=p_until or p_until-p_from>interval '24 hours' or p_until>statement_timestamp() then
  raise exception 'Computer lifecycle requires a finite past window of at most 24 hours' using errcode='22023'; end if;
 select * into a from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
 if not found then raise exception 'Computer allocation is unavailable' using errcode='22023'; end if;
 select * into d from public.qorpera_runtime_node_demands where allocation_id=a.id;
 select * into o from public.qorpera_runtime_offices where id=a.office_id;
 with activations as materialized (
  select * from public.qorpera_runtime_office_activations where allocation_id=a.id
 ), transitions as materialized (
  select * from public.qorpera_runtime_office_lifecycle_transitions where allocation_id=a.id
 ), resets as materialized (
  select * from public.qorpera_runtime_office_resets where allocation_id=a.id
 ), events as (
  select 'company_allocation'::text layer,'reserved'::text event,a.reserved_at at,a.id source_id,
   'machine_allocation'::text source,'COMPANY_CAPACITY_RESERVED'::text reason,null::text action,
   null::uuid activation_id,null::uuid transition_id,a.computer_generation generation,null::uuid incarnation,null::text custody
  union all select 'company_allocation','released',a.released_at,a.id,'machine_allocation',
   'COMPANY_CAPACITY_RELEASED',null,null,null,a.computer_generation,null,null
  union all select 'node_allocation','requested',d.requested_at,a.id,'node_demand',
   'NODE_CAPACITY_REQUESTED',null,null,null,a.computer_generation,null,null
  union all select 'node_allocation','reserved',d.reserved_at,a.id,'node_demand',
   'NODE_CAPACITY_RESERVED',null,null,null,a.computer_generation,null,null
  union all select 'node_allocation','released',d.released_at,a.id,'node_demand',
   'NODE_CAPACITY_RELEASED',null,null,null,a.computer_generation,null,null
  union all select 'office_admission','requested',s.created_at,s.id,'office_start_intent',
   'OFFICE_START_REQUESTED',null,null,null,s.computer_generation,null,null
   from public.qorpera_runtime_office_start_intents s where s.allocation_id=a.id
  union all select 'office_admission','cancelled',s.cancelled_at,s.id,'office_start_intent',
   'OFFICE_START_CANCELLED',null,null,null,s.computer_generation,null,null
   from public.qorpera_runtime_office_start_intents s where s.allocation_id=a.id
  union all select 'office_service','ready',v.activated_at,v.activation_id,'office_activation',
   'OFFICE_ACTIVATED',null,v.activation_id,null,v.computer_generation,null,null from activations v
  union all select 'office_admission','superseded',v.superseded_at,v.activation_id,'office_activation',
   'SUCCESSOR_PREPARED',null,v.activation_id,null,v.computer_generation,null,null from activations v
  union all select 'office_admission','closing',t.requested_at,t.id,'office_lifecycle_transition',
   'OFFICE_ADMISSION_REVOKED',t.request->>'action',t.activation_id,t.id,t.computer_generation,null,null from transitions t
  union all select 'office_service','stop_acknowledged',s.acknowledged_at,s.transition_id,'office_stop',
   'OFFICE_SERVICE_ABSENCE_CONFIRMED',t.request->>'action',t.activation_id,t.id,t.computer_generation,null,null
   from public.qorpera_runtime_office_stops s join transitions t on t.id=s.transition_id
  union all select 'office_admission','successor_prepared',s.prepared_at,s.activation_id,'office_successor',
   'SUCCESSOR_PREPARED',s.request#>>'{predecessor,action}',s.activation_id,s.transition_id,v.computer_generation,null,null
   from public.qorpera_runtime_office_successors s join activations v using(activation_id)
  union all select 'vm_control','boot_requested',b.prepared_at,b.boot_intent_id,'office_boot_intent',
   'RETAINED_VM_BOOT_REQUESTED',t.request->>'action',b.activation_id,b.transition_id,t.computer_generation,null,null
   from public.qorpera_runtime_office_boot_intents b join transitions t on t.id=b.transition_id
  union all select 'root_incarnation','reset_'||e.phase,e.recorded_at,r.reset_id,'office_reset_event',
   'ROOT_RESET_'||upper(e.phase),'replace',
   case when e.phase in ('prepared','active') then r.successor_activation_id else r.predecessor_activation_id end,
   r.transition_id,r.computer_generation,r.root_incarnation_id,
   case when e.phase in ('custodied','restored') then 'provider_validated_external_archive_digest' else 'sql_recorded_phase_digest' end
   from public.qorpera_runtime_office_reset_events e join resets r using(reset_id)
 ), bounded as materialized (
  select * from events where at>=p_from and at<p_until order by at,layer,event,source_id limit 1001
 ) select count(*),coalesce(jsonb_agg(jsonb_build_object(
   'layer',layer,'event',event,'recordedAt',at,'timeBasis','database_recorded',
   'physicalTransitionAt',null,'source',source,'sourceId',source_id,'reason',reason,'action',action,
   'activationId',activation_id,'transitionId',transition_id,'computerGeneration',generation,
   'rootIncarnationId',incarnation,'custodyConfirmation',custody)
   order by at,layer,event,source_id),'[]') into v_count,v_events from bounded;
 if v_count>1000 then raise exception 'Computer lifecycle requires a smaller window' using errcode='54000'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('resetId',r.reset_id,'rootIncarnationId',r.root_incarnation_id,
   'predecessorRootIncarnationId',r.predecessor_root_incarnation_id,'phase',r.phase,'begunAt',r.begun_at,
   'custodyConfirmation',case when r.custody_sha256 is null then 'none' else 'provider_validated_external_archive_digest' end)
   order by r.begun_at,r.reset_id),'[]') into v_incarnations
  from (select * from public.qorpera_runtime_office_resets where allocation_id=a.id order by begun_at,reset_id limit 65) r;
 if jsonb_array_length(v_incarnations)>64 then raise exception 'Computer lifecycle requires a smaller window' using errcode='54000'; end if;
 if d.allocation_id is not null then
  v_physical:=public.qorpera_runtime_computer_history(a.id,p_from,p_until);
 end if;
 v_result:=jsonb_build_object('schema','qorpera.runtime-computer-lifecycle/v1',
  'allocationId',a.id,'profileId',a.profile_id,'officeId',a.office_id,'logicalComputerId',o.logical_computer_id,
  'environmentId',o.environment_id,'runId',a.run_id,'loginSessionId',a.login_session_id,
  'providerAdapter',a.provider_adapter,'instanceSha256',a.instance_sha256,
  'from',p_from,'until',p_until,'window','half_open','coverage','retained_control_records_and_physical_samples',
  'controlEvents',v_events,'rootIncarnations',v_incarnations,'physicalHistory',v_physical,
  'physicalHistoryUnavailableReason',case when d.allocation_id is null then 'NODE_PLACEMENT_NOT_RECORDED' else null end,
  'exactVmTransitionTimesAvailable',false,'missingPhysicalTransitions','unknown',
  'viewerEventsIncluded',false,'queryCreatesAuthority',false);
 if octet_length(v_result::text)>4194304 then
  raise exception 'Computer lifecycle response requires a smaller window' using errcode='54000'; end if;
 return v_result;
end
$$;

alter table public.qorpera_runtime_office_resets enable row level security;
alter table public.qorpera_runtime_office_reset_events enable row level security;
alter table public.qorpera_runtime_office_reset_challenges enable row level security;
revoke all on public.qorpera_runtime_office_resets,public.qorpera_runtime_office_reset_events,public.qorpera_runtime_office_reset_challenges
	from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_office_reset_phase_index(text),
	public.qorpera_assert_runtime_office_reset_plan(jsonb),public.qorpera_assert_runtime_office_reset_custody(jsonb,jsonb),
	public.qorpera_assert_runtime_office_reset_restore(jsonb,jsonb,jsonb,text),
	public.qorpera_runtime_office_reset_result(public.qorpera_runtime_office_resets),
	public.qorpera_lock_runtime_office_reset(jsonb,boolean),public.qorpera_gate_runtime_office_reset_phase(public.qorpera_runtime_office_resets,text),
	public.qorpera_runtime_office_reset_challenge_result(public.qorpera_runtime_office_reset_challenges),
	public.qorpera_begin_runtime_office_reset(jsonb,text),public.qorpera_runtime_office_reset_status(jsonb),
	public.qorpera_prepare_runtime_office_reset_phase(jsonb,text,uuid,text),public.qorpera_check_runtime_office_reset_phase(jsonb,uuid),
	public.qorpera_ack_runtime_office_reset_phase(jsonb,uuid,jsonb),
	public.qorpera_assert_runtime_office_reset_successor_request(jsonb),
	public.qorpera_runtime_office_reset_successor_result(public.qorpera_runtime_office_activations),
	public.qorpera_prepare_runtime_office_reset_successor(jsonb),public.qorpera_runtime_office_reset_successor_status(jsonb),
	public.qorpera_check_runtime_office_reset_successor(jsonb),public.qorpera_activate_runtime_office_reset_successor(jsonb,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_begin_runtime_office_reset(jsonb,text),public.qorpera_runtime_office_reset_status(jsonb),
	public.qorpera_prepare_runtime_office_reset_phase(jsonb,text,uuid,text),public.qorpera_check_runtime_office_reset_phase(jsonb,uuid),
	public.qorpera_ack_runtime_office_reset_phase(jsonb,uuid,jsonb),
	public.qorpera_prepare_runtime_office_reset_successor(jsonb),public.qorpera_runtime_office_reset_successor_status(jsonb),
	public.qorpera_check_runtime_office_reset_successor(jsonb),public.qorpera_activate_runtime_office_reset_successor(jsonb,text) to service_role;
