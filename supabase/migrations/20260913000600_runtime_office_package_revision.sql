-- Code-only provisioning on a recreated, identically pinned office image.
-- Provider signature/filesystem verification supplies physical evidence;
-- this separate capability and revision lane supplies current authority.
-- Never relabel a service-only revision or rewrite original image/history.
create table public.qorpera_office_package_capabilities (
 allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
 provider_id uuid not null, provider_policy_sha256 text not null check(provider_policy_sha256 ~ '^[0-9a-f]{64}$'),
 capability_sha256 text not null unique check(capability_sha256 ~ '^[0-9a-f]{64}$'),
 revision bigint not null check(revision between 1 and 9007199254740990), enabled boolean not null
);
create trigger qorpera_guard_office_package_capability before update on public.qorpera_office_package_capabilities
 for each row execute function public.qorpera_guard_office_software_capability();

create table public.qorpera_office_package_baselines (
 allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
 base jsonb not null, compatibility jsonb not null,
 current_revision bigint not null default 0 check(current_revision between 0 and 9007199254740991)
);
create table public.qorpera_office_package_provisions (
 id uuid primary key,
 allocation_id uuid not null references public.qorpera_office_package_baselines(allocation_id) on delete restrict,
 predecessor_activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 reset_id uuid not null unique, root_incarnation_id uuid not null unique, successor_activation_id uuid not null unique,
 install_command_id uuid not null unique,
 reset_plan jsonb not null, plan jsonb not null, statement jsonb not null,
 plan_sha256 text not null check(plan_sha256 ~ '^[0-9a-f]{64}$'),
 expected_software_revision bigint, target_revision bigint not null check(target_revision between 1 and 9007199254740991),
 office_revision bigint not null, privacy_version bigint not null, privacy_state text not null, privacy_challenge jsonb,
 stop_was_acknowledged boolean not null,
 state text not null default 'enrolled' check(state in ('enrolled','authorized','installed')),
 request jsonb, request_sha256 text check(request_sha256 ~ '^[0-9a-f]{64}$'),
 dispatch_challenge_id uuid unique, dispatch_capability_revision bigint,
 dispatch_issued_at timestamptz, dispatch_expires_at timestamptz,
 enrolled_at timestamptz not null default clock_timestamp(),
 unique(allocation_id,target_revision),
 check((state='enrolled' and request is null and request_sha256 is null and dispatch_challenge_id is null
   and dispatch_capability_revision is null and dispatch_issued_at is null and dispatch_expires_at is null)
  or (state<>'enrolled' and request is not null and request_sha256 is not null and dispatch_challenge_id is not null
   and dispatch_capability_revision is not null and dispatch_issued_at is not null
   and dispatch_expires_at=dispatch_issued_at+interval '5 seconds'))
);
create unique index qorpera_office_package_open on public.qorpera_office_package_provisions(allocation_id) where state<>'installed';
create table public.qorpera_office_package_observations (
 id uuid primary key,
 provision_id uuid not null references public.qorpera_office_package_provisions(id) on delete restrict,
 request_sha256 text not null, reset_revision bigint not null, office_revision bigint not null,
 privacy_version bigint not null, capability_revision bigint not null,
 issued_at timestamptz not null, expires_at timestamptz not null,
 check(expires_at=issued_at+interval '5 seconds')
);
create table public.qorpera_office_package_installations (
 provision_id uuid primary key references public.qorpera_office_package_provisions(id) on delete restrict,
 observation_id uuid not null unique references public.qorpera_office_package_observations(id) on delete restrict,
 receipt jsonb not null, receipt_sha256 text not null check(receipt_sha256 ~ '^[0-9a-f]{64}$'),
 inventory_sha256 text not null check(inventory_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 installed_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_runtime_office_activations add column package_provision_id uuid
 references public.qorpera_office_package_installations(provision_id) on delete restrict;
create table public.qorpera_office_package_invocation_challenges (
 id uuid primary key,
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 provision_id uuid not null references public.qorpera_office_package_installations(provision_id) on delete restrict,
 startup jsonb not null, office_revision bigint not null, privacy_version bigint not null, capability_revision bigint not null,
 issued_at timestamptz not null, expires_at timestamptz not null,
 check(expires_at=issued_at+interval '5 seconds')
);
create table public.qorpera_office_package_measurements (
 challenge_id uuid primary key references public.qorpera_office_package_invocation_challenges(id) on delete restrict,
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 provision_id uuid not null references public.qorpera_office_package_installations(provision_id) on delete restrict,
 startup jsonb not null, service jsonb not null, runtime_bundle jsonb not null,
 receipt_sha256 text not null check(receipt_sha256 ~ '^[0-9a-f]{64}$'),
 inventory_sha256 text not null check(inventory_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 measured_at timestamptz not null default clock_timestamp()
);
create index qorpera_office_package_measurements_activation on public.qorpera_office_package_measurements(activation_id,measured_at desc);

create function public.qorpera_require_office_package_capability(p_allocation_id uuid,p_capability text,p_lock boolean)
returns bigint language plpgsql security definer set search_path='' as $$
declare c public.qorpera_office_package_capabilities%rowtype;
begin
 if auth.role() is distinct from 'service_role' or p_capability is null or p_capability !~ '^[0-9a-f]{64}$' or p_lock is null then
  raise exception 'Office package provider capability required' using errcode='42501'; end if;
 if p_lock then
  select * into c from public.qorpera_office_package_capabilities where allocation_id=p_allocation_id for share;
 else
  select * into c from public.qorpera_office_package_capabilities where allocation_id=p_allocation_id;
 end if;
 if not found or not c.enabled or c.capability_sha256<>encode(extensions.digest(p_capability,'sha256'),'hex')
  or not exists(select 1 from public.qorpera_runtime_machine_allocations a
   join public.qorpera_runtime_office_providers p on p.office_id=a.office_id and p.computer_generation=a.computer_generation
   where a.id=p_allocation_id and a.provider_adapter='lxd' and a.released_at is null
    and p.provider_id=c.provider_id and p.policy_sha256=c.provider_policy_sha256) then
  raise exception 'Office package provider capability unavailable' using errcode='42501'; end if;
 return c.revision;
end $$;


create function public.qorpera_office_package_uint(p_value jsonb,p_min bigint default 1,p_max bigint default 9007199254740991)
returns void language plpgsql immutable set search_path='' as $$
begin
 if not public.qorpera_node_health_uint(p_value,p_max) then
  raise exception 'Invalid office package number' using errcode='22023'; end if;
 if (p_value::text)::bigint<p_min then
  raise exception 'Invalid office package number' using errcode='22023'; end if;
end $$;
create function public.qorpera_office_package_sha(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'string' then raise exception 'Invalid office package digest' using errcode='22023'; end if;
 perform public.qorpera_office_software_sha(p_value#>>'{}');
end $$;
create function public.qorpera_office_package_bundle(p_bundle jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 perform public.qorpera_office_software_object(p_bundle,array['id','version','sha256']);
 if p_bundle->>'id' is distinct from 'qorpera.cloud-runtime' then raise exception 'Invalid office package runtime' using errcode='22023'; end if;
 perform public.qorpera_office_package_uint(p_bundle->'version');
 perform public.qorpera_office_package_sha(p_bundle->'sha256');
end $$;
create function public.qorpera_assert_office_package_bundle(p_bundle jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.qorpera_office_package_bundle(p_bundle);
 perform 1 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id
  where a.singleton and b.bundle_key=p_bundle->>'id' and b.version=(p_bundle->>'version')::bigint
   and b.sha256=p_bundle->>'sha256' and a.runtime_bundle_sha256=b.sha256 for share of a,b;
 if not found then raise exception 'Office package runtime bundle not admitted' using errcode='42501'; end if;
end $$;

create function public.qorpera_assert_office_package_documents(p_plan jsonb,p_statement jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare k text; v jsonb;
begin
 perform public.qorpera_office_software_object(p_plan,array['schema','provisionId','resetId','resetPlanSha256','providerBindingSha256',
  'rootIncarnationId','successorActivationId','statementSha256','expectedSoftwareRevision','targetRevision','installCommandId']);
 if p_plan->>'schema' is distinct from 'qorpera.lxd-office-code-package-provision-plan/v1' then
  raise exception 'Invalid office package plan' using errcode='22023'; end if;
 foreach k in array array['provisionId','resetId','rootIncarnationId','successorActivationId','installCommandId'] loop
  if not public.qorpera_screen_metadata_uuid(p_plan->k) then raise exception 'Invalid office package identity' using errcode='22023'; end if;
 end loop;
 if (select count(distinct p_plan->>identity_key) from unnest(array['provisionId','resetId','rootIncarnationId','successorActivationId','installCommandId']) keys(identity_key))<>5 then
  raise exception 'Office package identities reused' using errcode='22023'; end if;
 foreach k in array array['resetPlanSha256','providerBindingSha256','statementSha256'] loop perform public.qorpera_office_package_sha(p_plan->k); end loop;
 if p_plan->'expectedSoftwareRevision'<>'null'::jsonb then perform public.qorpera_office_package_uint(p_plan->'expectedSoftwareRevision',0); end if;
 perform public.qorpera_office_package_uint(p_plan->'targetRevision');
 perform public.qorpera_office_software_object(p_statement,array['schema','base','target','tools','compatibility','acceptance']);
 perform public.qorpera_office_software_object(p_statement->'base',array['imageSha256','bootstrapSha256','packageManifestSha256','sourceCommit']);
 perform public.qorpera_office_software_object(p_statement->'target',array['packageManifestSha256','sourceCommit','runtimeBundle','service','capabilities']);
 perform public.qorpera_office_software_object(p_statement->'tools',array['bootstrap','measure']);
 perform public.qorpera_office_software_object(p_statement->'compatibility',array['baseInstallationReceiptSha256','unchangedExternalDependenciesSha256']);
 perform public.qorpera_office_software_object(p_statement->'acceptance',array['testedAt','evidenceSha256','change']);
 if p_statement->>'schema' is distinct from 'qorpera.office-code-package-provision-statement/v1'
  or p_statement#>>'{acceptance,change}' is distinct from 'code-only-package'
  or p_statement#>'{target,capabilities}' is distinct from '["reset-configuration/v1","reset-service-start/v1","reset-service-restart/v1"]'::jsonb then
  raise exception 'Invalid office package scope' using errcode='22023'; end if;
 foreach k in array array['base','target'] loop
  v:=p_statement->k;
  perform public.qorpera_office_package_sha(v->'packageManifestSha256');
  if jsonb_typeof(v->'sourceCommit') is distinct from 'string' or v->>'sourceCommit' !~ '^[0-9a-f]{40}$' then
   raise exception 'Invalid office package source' using errcode='22023'; end if;
 end loop;
 perform public.qorpera_office_package_sha(p_statement#>'{base,imageSha256}');
 perform public.qorpera_office_package_sha(p_statement#>'{base,bootstrapSha256}');
 foreach k in array array['baseInstallationReceiptSha256','unchangedExternalDependenciesSha256'] loop
  perform public.qorpera_office_package_sha(p_statement#>array['compatibility',k]); end loop;
 perform public.qorpera_office_package_sha(p_statement#>'{acceptance,evidenceSha256}');
 perform public.qorpera_node_health_time(p_statement#>'{acceptance,testedAt}');
 perform public.qorpera_office_package_bundle(p_statement#>'{target,runtimeBundle}');
 perform public.qorpera_office_software_artifact(p_statement#>'{target,service}');
 foreach k in array array['bootstrap','measure'] loop
  v:=p_statement#>array['tools',k];
  perform public.qorpera_office_software_object(v,array['bytes','sha256']);
  perform public.qorpera_office_package_uint(v->'bytes',1,16777216);
  perform public.qorpera_office_package_sha(v->'sha256');
 end loop;
end $$;

create function public.qorpera_office_package_provision_result(p_provision public.qorpera_office_package_provisions,p_capability_revision bigint)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema','qorpera.office-code-package-provision-status/v1','plan',p_provision.plan,
  'planSha256',p_provision.plan_sha256,'statement',p_provision.statement,'state',p_provision.state,
  'targetRevision',p_provision.target_revision,'currentPackageRevision',b.current_revision,'capabilityRevision',p_capability_revision,
  'request',p_provision.request,'requestSha256',p_provision.request_sha256,
  'receipt',i.receipt,'receiptSha256',i.receipt_sha256,'installationEvidenceSha256',i.evidence_sha256)
 from public.qorpera_office_package_baselines b left join public.qorpera_office_package_installations i on i.provision_id=p_provision.id
 where b.allocation_id=p_provision.allocation_id
$$;

create function public.qorpera_enroll_office_package_provision(p_reset_plan_text text,p_plan_text text,p_statement_text text,p_plan_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb; s jsonb; r jsonb; a public.qorpera_runtime_office_activations%rowtype;
 o public.qorpera_runtime_offices%rowtype; b public.qorpera_office_package_baselines%rowtype;
 q public.qorpera_office_package_provisions%rowtype; x public.qorpera_runtime_office_resets%rowtype; c bigint;
begin
 if p_plan_text is null or p_statement_text is null or p_reset_plan_text is null or octet_length(p_plan_text)>65536
  or octet_length(p_statement_text)>65536 or octet_length(p_reset_plan_text)>65536 then
  raise exception 'Invalid office package documents' using errcode='22023'; end if;
 p:=p_plan_text::jsonb; s:=p_statement_text::jsonb; r:=p_reset_plan_text::jsonb;
 perform public.qorpera_require_office_package_capability((r#>>'{predecessor,startup,allocationId}')::uuid,p_provider_capability,false);
 perform public.qorpera_assert_runtime_office_reset_plan(r);
 perform public.qorpera_assert_office_package_documents(p,s);
 perform public.qorpera_office_software_sha(p_plan_sha256);
 if p_plan_sha256<>encode(extensions.digest(p_plan_text,'sha256'),'hex')
  or p->>'statementSha256'<>encode(extensions.digest(p_statement_text,'sha256'),'hex')
  or p->>'resetPlanSha256'<>encode(extensions.digest(p_reset_plan_text,'sha256'),'hex')
  or p->'resetId'<>r->'resetId' or p->'rootIncarnationId'<>r->'rootIncarnationId'
  or p->'successorActivationId'<>r->'successorActivationId' or p->'providerBindingSha256'<>r->'providerBindingSha256'
  or p->>'installCommandId' in (r#>>'{commands,stopCommandId}',r#>>'{commands,deleteCommandId}',r#>>'{commands,createCommandId}',r#>>'{commands,startCommandId}') then
  raise exception 'Office package reset or document binding differs' using errcode='42501'; end if;
 -- Exact enrollment replay is retained identity only. It must survive a
 -- later phase/supersession so the provider can recover its journal, without
 -- creating or adopting a new relation after the destructive boundary.
 select * into q from public.qorpera_office_package_provisions where id=(p->>'provisionId')::uuid;
 if found then
  perform public.qorpera_office_package_provision_status(q.id,p_provider_capability);
  select * into strict q from public.qorpera_office_package_provisions where id=(p->>'provisionId')::uuid;
  if q.plan<>p or q.statement<>s or q.reset_plan<>r or q.plan_sha256<>p_plan_sha256 then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package enrollment cannot be rebound","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
  c:=public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
  return public.qorpera_office_package_provision_result(q,c);
 end if;
 perform public.qorpera_lock_runtime_office_stop(r->'predecessor');
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=(r#>>'{predecessor,activationId}')::uuid;
 c:=public.qorpera_require_office_package_capability(a.allocation_id,p_provider_capability,true);
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 if a.provider_binding_sha256<>p->>'providerBindingSha256' or s#>>'{base,imageSha256}'<>a.image_sha256
  or s#>>'{base,bootstrapSha256}'<>a.bootstrap_sha256 or a.intent_id::text<>r->>'intentId'
  or a.attestation->>'preparationObservationSha256'<>r->>'preparationObservationSha256' then
  raise exception 'Office package original image or preparation differs' using errcode='42501'; end if;
 select * into x from public.qorpera_runtime_office_resets where reset_id=(p->>'resetId')::uuid for update;
 if found and (x.plan<>r or x.plan_sha256<>p->>'resetPlanSha256' or x.phase not in ('fenced','stopped','custodied')
  or exists(select 1 from public.qorpera_runtime_office_reset_events where reset_id=x.reset_id and sequence>=4)) then
  raise exception 'Office package enrollment is too late for this root' using errcode='42501'; end if;
 select * into b from public.qorpera_office_package_baselines where allocation_id=a.allocation_id for update;
 if not found then
  if exists(select 1 from public.qorpera_office_software_baselines where allocation_id=a.allocation_id and base<>s->'base') then
   raise exception 'Office package original software baseline differs' using errcode='42501'; end if;
  insert into public.qorpera_office_package_baselines(allocation_id,base,compatibility)
   values(a.allocation_id,s->'base',s->'compatibility') returning * into b;
 end if;
 if b.base<>s->'base' or b.compatibility<>s->'compatibility' then raise exception 'Office package baseline is immutable' using errcode='42501'; end if;
 select * into q from public.qorpera_office_package_provisions where id=(p->>'provisionId')::uuid for update;
 if found then
  if q.plan<>p or q.statement<>s or q.reset_plan<>r or q.plan_sha256<>p_plan_sha256 then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package enrollment cannot be rebound","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
  return public.qorpera_office_package_provision_result(q,c);
 end if;
 if a.software_revision is distinct from (p->>'expectedSoftwareRevision')::bigint or b.current_revision+1<>(p->>'targetRevision')::bigint
  or (a.software_revision is not null and not exists(select 1 from public.qorpera_office_software_baselines where allocation_id=a.allocation_id and current_revision=a.software_revision))
  or exists(select 1 from public.qorpera_office_software_updates where predecessor_activation_id=a.activation_id)
  or exists(select 1 from public.qorpera_runtime_office_successors where transition_id=(r#>>'{predecessor,transitionId}')::uuid) then
  raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package current revision changed","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 perform public.qorpera_assert_office_package_bundle(s#>'{target,runtimeBundle}');
 insert into public.qorpera_office_package_provisions(id,allocation_id,predecessor_activation_id,reset_id,root_incarnation_id,successor_activation_id,
  install_command_id,reset_plan,plan,statement,plan_sha256,expected_software_revision,target_revision,office_revision,privacy_version,privacy_state,privacy_challenge,stop_was_acknowledged)
 values((p->>'provisionId')::uuid,a.allocation_id,a.activation_id,(p->>'resetId')::uuid,(p->>'rootIncarnationId')::uuid,(p->>'successorActivationId')::uuid,
  (p->>'installCommandId')::uuid,r,p,s,p_plan_sha256,a.software_revision,(p->>'targetRevision')::bigint,o.revision,o.privacy_version,o.privacy_state,o.privacy_challenge,
 exists(select 1 from public.qorpera_runtime_office_stops where transition_id=(r#>>'{predecessor,transitionId}')::uuid))
 returning * into q;
 return public.qorpera_office_package_provision_result(q,c);
end $$;

-- Enrollment may precede physical stop. Only that exact acknowledged stop
-- advances the authority revision by one; any intervening office/privacy
-- change still fails. Preserve the immutable enrollment snapshot.
create function public.qorpera_office_package_office_revision(p_provision public.qorpera_office_package_provisions)
returns bigint language sql stable security definer set search_path='' as $$
 select p_provision.office_revision+case when not p_provision.stop_was_acknowledged and exists(
  select 1 from public.qorpera_runtime_office_stops s join public.qorpera_runtime_office_stop_challenges c on c.id=s.challenge_id
  where s.transition_id=(p_provision.reset_plan#>>'{predecessor,transitionId}')::uuid
   and c.office_revision=p_provision.office_revision and c.privacy_version=p_provision.privacy_version) then 1 else 0 end
$$;

create function public.qorpera_lock_office_package_install(p_provision_id uuid,p_provider_capability text)
returns public.qorpera_office_package_provisions language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; r public.qorpera_runtime_office_resets%rowtype;
 o public.qorpera_runtime_offices%rowtype; b public.qorpera_office_package_baselines%rowtype;
begin
 select * into q from public.qorpera_office_package_provisions where id=p_provision_id;
 perform public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,false);
 r:=public.qorpera_lock_runtime_office_reset(q.reset_plan,false);
 perform public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
 select * into strict o from public.qorpera_runtime_offices where id=r.office_id;
 select * into strict b from public.qorpera_office_package_baselines where allocation_id=q.allocation_id for update;
 select * into strict q from public.qorpera_office_package_provisions where id=p_provision_id for update;
 if r.phase<>'restored' or r.allocation_id<>q.allocation_id or r.predecessor_activation_id<>q.predecessor_activation_id
  or r.root_incarnation_id<>q.root_incarnation_id or r.successor_activation_id<>q.successor_activation_id
  or r.plan_sha256<>q.plan->>'resetPlanSha256' or r.restore_sha256 is null or r.restore is null
  or o.revision<>public.qorpera_office_package_office_revision(q) or o.privacy_version<>q.privacy_version or o.privacy_state<>q.privacy_state
  or o.privacy_challenge is distinct from q.privacy_challenge
  or b.current_revision<>(case when q.state='installed' then q.target_revision else q.target_revision-1 end)
  or not exists(select 1 from public.qorpera_runtime_office_activations where activation_id=q.predecessor_activation_id
   and software_revision is not distinct from q.expected_software_revision)
  or not exists(select 1 from public.qorpera_runtime_office_stops where transition_id=r.transition_id) then
  raise exception 'Office package restored-root authority changed' using errcode='42501'; end if;
 perform public.qorpera_assert_runtime_office_provider(public.qorpera_runtime_office_scope(o),o.generation,r.provider_id,r.provider_policy_sha256,true);
 perform public.qorpera_check_runtime_office_restart_surfaces((select a from public.qorpera_runtime_office_activations a where activation_id=q.predecessor_activation_id));
 perform public.qorpera_assert_office_package_bundle(q.statement#>'{target,runtimeBundle}');
 return q;
end $$;

create function public.qorpera_office_package_provision_status(p_provision_id uuid,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; c bigint;
begin
 select * into q from public.qorpera_office_package_provisions where id=p_provision_id;
 perform public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,false);
 perform public.qorpera_assert_runtime_office_provider(q.reset_plan#>'{predecessor,startup,scope}',
  (q.reset_plan#>>'{predecessor,startup,computerGeneration}')::bigint,(q.reset_plan#>>'{predecessor,providerId}')::uuid,
  q.reset_plan#>>'{predecessor,providerPolicySha256}',false);
 c:=public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
 perform 1 from public.qorpera_office_package_baselines where allocation_id=q.allocation_id for share;
 select * into strict q from public.qorpera_office_package_provisions where id=p_provision_id for share;
 return public.qorpera_office_package_provision_result(q,c);
end $$;

create function public.qorpera_check_office_package_provision(p_provision_id uuid,p_request_text text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; r public.qorpera_runtime_office_resets%rowtype;
 p jsonb; h text; c bigint; t timestamptz; ms bigint; k text;
begin
 q:=public.qorpera_lock_office_package_install(p_provision_id,p_provider_capability);
 c:=public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
 if p_request_text is null or octet_length(p_request_text)>65536 then raise exception 'Invalid office package request' using errcode='22023'; end if;
 p:=p_request_text::jsonb;h:=encode(extensions.digest(p_request_text,'sha256'),'hex');
 perform public.qorpera_office_software_object(p,array['schema','plan','planSha256','bootId','restoreSha256','challengeId','targetRevision','capabilityRevision','targetManifestSha256']);
 foreach k in array array['bootId','challengeId'] loop
  if not public.qorpera_screen_metadata_uuid(p->k) then raise exception 'Invalid office package request identity' using errcode='22023'; end if;
 end loop;
 perform public.qorpera_office_package_uint(p->'capabilityRevision');
 perform public.qorpera_office_package_uint(p->'targetRevision');
 select * into strict r from public.qorpera_runtime_office_resets where reset_id=q.reset_id;
 if p->>'schema' is distinct from 'qorpera.office-code-package-provision-request/v1' or p->'plan'<>q.plan
  or p->>'planSha256' is distinct from q.plan_sha256 or p->>'restoreSha256' is distinct from r.restore_sha256
  or p->'bootId' is distinct from r.restore->'bootId' or (p->>'targetRevision')::bigint<>q.target_revision
  or (p->>'capabilityRevision')::bigint<>c or p->'targetManifestSha256' is distinct from q.statement#>'{target,packageManifestSha256}'
  or (select count(distinct id) from unnest(array[q.id::text,q.reset_id::text,q.root_incarnation_id::text,
   q.successor_activation_id::text,q.install_command_id::text,p->>'bootId',p->>'challengeId']) id)<>7 then
  raise exception 'Office package request binding differs' using errcode='42501'; end if;
 if q.state='installed' then raise exception 'Office package installation already acknowledged' using errcode='42501'; end if;
 if q.state='authorized' then
  if q.request<>p or q.request_sha256<>h or q.dispatch_capability_revision<>c then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package dispatch identity cannot be replaced","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 else
  t:=clock_timestamp();
  update public.qorpera_office_package_provisions set state='authorized',request=p,request_sha256=h,
   dispatch_challenge_id=(p->>'challengeId')::uuid,dispatch_capability_revision=c,
   dispatch_issued_at=t,dispatch_expires_at=t+interval '5 seconds' where id=q.id returning * into q;
 end if;
 ms:=least(5000,floor(extract(epoch from(q.dispatch_expires_at-clock_timestamp()))*1000)::bigint);
 if ms<1 then raise exception 'Office package dispatch challenge expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-code-package-dispatch-challenge/v1','request',q.request,'requestSha256',q.request_sha256,
  'statement',q.statement,'targetRevision',q.target_revision,'capabilityRevision',c,'validForMs',ms);
end $$;

create function public.qorpera_check_office_package_provision_observation(p_provision_id uuid,p_observation_id uuid,p_original_request_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; n public.qorpera_office_package_observations%rowtype;
 r public.qorpera_runtime_office_resets%rowtype; c bigint; t timestamptz; ms bigint;
begin
 q:=public.qorpera_lock_office_package_install(p_provision_id,p_provider_capability);
 c:=public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
 perform public.qorpera_office_software_uuid(p_observation_id);
 perform public.qorpera_office_software_sha(p_original_request_sha256);
 if q.state='enrolled' or q.request_sha256<>p_original_request_sha256 or q.dispatch_capability_revision<>c
  or p_observation_id in (q.id,q.reset_id,q.root_incarnation_id,q.successor_activation_id,q.install_command_id,q.dispatch_challenge_id,(q.request->>'bootId')::uuid) then
  raise exception 'Office package observation dispatch binding differs' using errcode='42501'; end if;
 select * into strict r from public.qorpera_runtime_office_resets where reset_id=q.reset_id;
 select * into n from public.qorpera_office_package_observations where id=p_observation_id for update;
 if found then
  if n.provision_id<>q.id or n.request_sha256<>q.request_sha256 or n.reset_revision<>r.revision or n.office_revision<>public.qorpera_office_package_office_revision(q)
   or n.privacy_version<>q.privacy_version or n.capability_revision<>c then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package observation identity changed","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 else
  if (select count(*) from public.qorpera_office_package_observations where provision_id=q.id)>=64 then
   raise exception 'Office package observation budget exhausted' using errcode='54000'; end if;
  t:=clock_timestamp();
  insert into public.qorpera_office_package_observations(id,provision_id,request_sha256,reset_revision,office_revision,privacy_version,capability_revision,issued_at,expires_at)
   values(p_observation_id,q.id,q.request_sha256,r.revision,public.qorpera_office_package_office_revision(q),q.privacy_version,c,t,t+interval '5 seconds') returning * into n;
 end if;
 ms:=least(5000,floor(extract(epoch from(n.expires_at-clock_timestamp()))*1000)::bigint);
 if ms<1 then raise exception 'Office package observation challenge expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-code-package-observation-challenge/v1','provisionId',q.id,'observationId',n.id,
  'request',q.request,'requestSha256',q.request_sha256,'statement',q.statement,'targetRevision',q.target_revision,'capabilityRevision',c,'validForMs',ms);
end $$;

create function public.qorpera_ack_office_package_provision(p_provision_id uuid,p_observation_id uuid,p_receipt_text text,
 p_inventory_sha256 text,p_evidence_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; i public.qorpera_office_package_installations%rowtype;
 n public.qorpera_office_package_observations%rowtype; r jsonb; h text; c bigint;
begin
 -- Read-only precheck before profile/office/activation/reset/baseline locks.
 -- Never take status SHARE locks and then upgrade them in a mutating path.
 select * into q from public.qorpera_office_package_provisions where id=p_provision_id;
 perform public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,false);
 if p_receipt_text is null or octet_length(p_receipt_text)>65536 then raise exception 'Invalid office package receipt' using errcode='22023'; end if;
 r:=p_receipt_text::jsonb;h:=encode(extensions.digest(p_receipt_text,'sha256'),'hex');
 perform public.qorpera_office_software_object(r,array['schema','planSha256','provisionId','resetId','rootIncarnationId','bootId','commandId',
  'requestSha256','restoreSha256','state','targetRevision','packageManifestSha256','installedInventorySha256','sourceCommit','runtimeBundle','service']);
 perform public.qorpera_office_software_sha(p_inventory_sha256);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 if q.state='installed' then
  perform public.qorpera_office_package_provision_status(p_provision_id,p_provider_capability);
  select * into strict q from public.qorpera_office_package_provisions where id=p_provision_id;
 else
  q:=public.qorpera_lock_office_package_install(p_provision_id,p_provider_capability);
 end if;
 c:=public.qorpera_require_office_package_capability(q.allocation_id,p_provider_capability,true);
 select * into i from public.qorpera_office_package_installations where provision_id=q.id;
 if found then
  if i.observation_id is distinct from p_observation_id or i.receipt<>r or i.receipt_sha256<>h or i.inventory_sha256<>p_inventory_sha256
   or i.evidence_sha256<>p_evidence_sha256 then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package installation cannot be rebound","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
  return public.qorpera_office_package_provision_result(q,c);
 end if;
 if not exists(select 1 from public.qorpera_office_package_observations where id=p_observation_id and provision_id=q.id) then
  raise exception 'Office package observation challenge absent' using errcode='42501'; end if;
 perform public.qorpera_check_office_package_provision_observation(q.id,p_observation_id,q.request_sha256,p_provider_capability);
 select * into strict n from public.qorpera_office_package_observations where id=p_observation_id for update;
 if r->>'schema' is distinct from 'qorpera.office-code-package-provision-receipt/v1' or r->>'state' is distinct from 'installed'
  or r->>'planSha256' is distinct from q.plan_sha256 or r->'provisionId' is distinct from q.plan->'provisionId'
  or r->'resetId' is distinct from q.plan->'resetId' or r->'rootIncarnationId' is distinct from q.plan->'rootIncarnationId'
  or r->'bootId' is distinct from q.request->'bootId' or r->'commandId' is distinct from q.plan->'installCommandId'
  or r->>'requestSha256' is distinct from q.request_sha256 or r->'restoreSha256' is distinct from q.request->'restoreSha256'
  or r->'targetRevision' is distinct from q.plan->'targetRevision' or r->>'installedInventorySha256' is distinct from p_inventory_sha256
  or r->'packageManifestSha256' is distinct from q.statement#>'{target,packageManifestSha256}'
  or r->'sourceCommit' is distinct from q.statement#>'{target,sourceCommit}' or r->'runtimeBundle' is distinct from q.statement#>'{target,runtimeBundle}'
  or r->'service' is distinct from q.statement#>'{target,service}' then
  raise exception 'Office package measured installation differs' using errcode='42501'; end if;
 insert into public.qorpera_office_package_installations(provision_id,observation_id,receipt,receipt_sha256,inventory_sha256,evidence_sha256)
  values(q.id,n.id,r,h,p_inventory_sha256,p_evidence_sha256);
 update public.qorpera_office_package_baselines set current_revision=q.target_revision where allocation_id=q.allocation_id and current_revision=q.target_revision-1;
 if not found then raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package revision changed","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 update public.qorpera_office_package_provisions set state='installed' where id=q.id returning * into q;
 if n.expires_at<=clock_timestamp() then raise exception 'Office package acknowledgement expired' using errcode='42501'; end if;
 return public.qorpera_office_package_provision_result(q,c);
end $$;

create function public.qorpera_assert_office_package_reset(p_reset_plan jsonb,p_reset_plan_sha256 text,p_installed boolean)
returns void language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype; b public.qorpera_office_package_baselines%rowtype;
 a public.qorpera_runtime_office_activations%rowtype; o public.qorpera_runtime_offices%rowtype;
 r public.qorpera_runtime_office_resets%rowtype;
begin
 select * into q from public.qorpera_office_package_provisions where reset_id=(p_reset_plan->>'resetId')::uuid;
 if not found or q.reset_plan<>p_reset_plan or q.plan->>'resetPlanSha256' is distinct from p_reset_plan_sha256 then
  raise exception 'Office reset requires enrolled package provision' using errcode='42501'; end if;
 select * into b from public.qorpera_office_package_baselines where allocation_id=q.allocation_id for share;
 select * into q from public.qorpera_office_package_provisions where id=q.id for share;
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=q.predecessor_activation_id;
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 if o.revision<>public.qorpera_office_package_office_revision(q) or o.privacy_version<>q.privacy_version or o.privacy_state<>q.privacy_state
  or o.privacy_challenge is distinct from q.privacy_challenge or a.software_revision is distinct from q.expected_software_revision
  or b.current_revision<>(case when q.state='installed' then q.target_revision else q.target_revision-1 end)
  or not exists(select 1 from public.qorpera_office_package_capabilities where allocation_id=q.allocation_id and enabled) then
  raise exception 'Office reset package admission changed' using errcode='42501'; end if;
 if p_installed then
  select * into r from public.qorpera_runtime_office_resets where reset_id=q.reset_id;
  if q.state<>'installed' or q.request->'bootId' is distinct from r.restore->'bootId'
   or q.request->>'restoreSha256' is distinct from r.restore_sha256
   or not exists(select 1 from public.qorpera_office_package_installations where provision_id=q.id)
   or not exists(select 1 from public.qorpera_office_package_capabilities where allocation_id=q.allocation_id and enabled and revision=q.dispatch_capability_revision) then
   raise exception 'Office reset package installation unavailable' using errcode='42501'; end if;
 end if;
 perform public.qorpera_assert_office_package_bundle(q.statement#>'{target,runtimeBundle}');
end $$;

create function public.qorpera_assert_office_package_startup(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
declare q public.qorpera_office_package_provisions%rowtype;
begin
 if p_activation.package_provision_id is null then return; end if;
 select * into q from public.qorpera_office_package_provisions where id=p_activation.package_provision_id;
 if not found or q.state<>'installed' or q.allocation_id<>p_activation.allocation_id or p_activation.software_revision is not null
  or not exists(select 1 from public.qorpera_office_package_baselines where allocation_id=q.allocation_id and current_revision=q.target_revision)
  or not exists(select 1 from public.qorpera_office_package_installations where provision_id=q.id)
  or q.statement#>>'{base,imageSha256}'<>p_activation.image_sha256 or q.statement#>>'{base,bootstrapSha256}'<>p_activation.bootstrap_sha256 then
  raise exception 'Office package startup revision unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_office_package_capabilities where allocation_id=q.allocation_id and enabled and revision=q.dispatch_capability_revision for share;
 if not found then raise exception 'Office package startup capability changed' using errcode='42501'; end if;
 perform public.qorpera_assert_office_package_bundle(q.statement#>'{target,runtimeBundle}');
end $$;

create function public.qorpera_inherit_office_package()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.qorpera_runtime_office_activations%rowtype; q public.qorpera_office_package_provisions%rowtype;
 r public.qorpera_runtime_office_resets%rowtype;
begin
 select * into r from public.qorpera_runtime_office_resets where successor_activation_id=new.activation_id;
 if found then
  perform public.qorpera_assert_office_package_reset(r.plan,r.plan_sha256,true);
  select * into strict q from public.qorpera_office_package_provisions where reset_id=r.reset_id;
  if new.predecessor_activation_id is distinct from q.predecessor_activation_id or new.allocation_id is distinct from q.allocation_id
   or new.attestation->'bootId' is distinct from q.request->'bootId' then
   raise exception 'Office package successor root differs' using errcode='42501'; end if;
 else
  select * into p from public.qorpera_runtime_office_activations where activation_id=new.predecessor_activation_id;
  if p.package_provision_id is null then
   if new.package_provision_id is not null then raise exception 'Office package identity cannot be invented' using errcode='42501'; end if;
   return new;
  end if;
  select * into strict q from public.qorpera_office_package_provisions where id=p.package_provision_id;
  if new.allocation_id<>p.allocation_id then raise exception 'Office package predecessor differs' using errcode='42501'; end if;
 end if;
 if new.package_provision_id is not null and new.package_provision_id<>q.id then raise exception 'Office package identity cannot be rebound' using errcode='42501'; end if;
 new.package_provision_id:=q.id;new.software_revision:=null;
 perform public.qorpera_assert_office_package_startup(new);
 return new;
end $$;
-- Alphabetically before qorpera_inherit_office_software: package rows never
-- inherit the old service-only label, while old rows retain old semantics.
create trigger qorpera_inherit_office_package before insert on public.qorpera_runtime_office_activations
 for each row execute function public.qorpera_inherit_office_package();

create function public.qorpera_lock_office_package_invocation(p_startup jsonb,p_activation_id uuid,p_provider_capability text)
returns public.qorpera_runtime_office_activations language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype;
begin
 perform public.qorpera_require_office_package_capability((p_startup->>'allocationId')::uuid,p_provider_capability,false);
 a:=public.qorpera_lock_runtime_office_startup(p_startup);
 perform public.qorpera_require_office_package_capability(a.allocation_id,p_provider_capability,true);
 if a.activation_id is distinct from p_activation_id or a.package_provision_id is null or a.state<>'ready'
  or a.service_invocation_id is distinct from p_startup->>'serviceInvocationId' or a.ready_at<=clock_timestamp()-interval '5 seconds' then
  raise exception 'Office package invocation not ready' using errcode='42501'; end if;
 perform public.qorpera_assert_office_package_startup(a);
 return a;
end $$;

create function public.qorpera_check_office_package_invocation(p_startup jsonb,p_activation_id uuid,p_challenge_id uuid,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; q public.qorpera_office_package_provisions%rowtype;
 i public.qorpera_office_package_installations%rowtype; n public.qorpera_office_package_invocation_challenges%rowtype;
 o public.qorpera_runtime_offices%rowtype; c bigint; t timestamptz; ms bigint;
begin
 a:=public.qorpera_lock_office_package_invocation(p_startup,p_activation_id,p_provider_capability);
 c:=public.qorpera_require_office_package_capability(a.allocation_id,p_provider_capability,true);
 perform public.qorpera_office_software_uuid(p_challenge_id);
 select * into strict q from public.qorpera_office_package_provisions where id=a.package_provision_id;
 select * into strict i from public.qorpera_office_package_installations where provision_id=q.id;
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 if p_challenge_id in (a.activation_id,q.id,q.reset_id,q.root_incarnation_id,q.install_command_id,q.dispatch_challenge_id,(p_startup->>'bootId')::uuid) then
  raise exception 'Office package invocation nonce reused' using errcode='22023'; end if;
 select * into n from public.qorpera_office_package_invocation_challenges where id=p_challenge_id for update;
 if found then
  if n.activation_id<>a.activation_id or n.provision_id<>q.id or n.startup<>p_startup or n.office_revision<>o.revision
   or n.privacy_version<>o.privacy_version or n.capability_revision<>c then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package invocation challenge changed","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 else
  if (select count(*) from public.qorpera_office_package_invocation_challenges where activation_id=a.activation_id)>=64 then
   raise exception 'Office package invocation budget exhausted' using errcode='54000'; end if;
  t:=clock_timestamp();
  insert into public.qorpera_office_package_invocation_challenges(id,activation_id,provision_id,startup,office_revision,privacy_version,capability_revision,issued_at,expires_at)
   values(p_challenge_id,a.activation_id,q.id,p_startup,o.revision,o.privacy_version,c,t,t+interval '5 seconds') returning * into n;
 end if;
 ms:=least(5000,floor(extract(epoch from(n.expires_at-clock_timestamp()))*1000)::bigint);
 if ms<1 then raise exception 'Office package invocation challenge expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-code-package-invocation-challenge/v1','challengeId',n.id,'activationId',a.activation_id,
  'startup',p_startup,'provisionId',q.id,'planSha256',q.plan_sha256,'revision',q.target_revision,
  'receiptSha256',i.receipt_sha256,'installedInventorySha256',i.inventory_sha256,
  'service',q.statement#>'{target,service}','runtimeBundle',q.statement#>'{target,runtimeBundle}','capabilityRevision',c,'validForMs',ms);
end $$;

create function public.qorpera_ack_office_package_invocation(p_startup jsonb,p_activation_id uuid,p_challenge_id uuid,
 p_receipt_sha256 text,p_inventory_sha256 text,p_measured_service jsonb,p_runtime_bundle jsonb,p_evidence_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; q public.qorpera_office_package_provisions%rowtype;
 i public.qorpera_office_package_installations%rowtype; n public.qorpera_office_package_invocation_challenges%rowtype;
 m public.qorpera_office_package_measurements%rowtype;
begin
 -- An exact acknowledged measurement is durable history, not renewed authority.
 -- Recover its lost reply without requiring the original five-second window;
 -- activation still checks its own current invocation and freshness below.
 select * into m from public.qorpera_office_package_measurements where challenge_id=p_challenge_id;
 if found then
  perform public.qorpera_office_package_provision_status(m.provision_id,p_provider_capability);
  if m.activation_id is distinct from p_activation_id or m.startup is distinct from p_startup
   or m.service is distinct from p_measured_service or m.runtime_bundle is distinct from p_runtime_bundle
   or m.receipt_sha256 is distinct from p_receipt_sha256 or m.inventory_sha256 is distinct from p_inventory_sha256
   or m.evidence_sha256 is distinct from p_evidence_sha256 then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package measurement cannot be rebound","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
  select * into strict q from public.qorpera_office_package_provisions where id=m.provision_id;
  return jsonb_build_object('schema','qorpera.office-code-package-invocation-measurement/v1','activationId',m.activation_id,
   'provisionId',q.id,'revision',q.target_revision,'state','measured');
 end if;
 a:=public.qorpera_lock_office_package_invocation(p_startup,p_activation_id,p_provider_capability);
 select * into n from public.qorpera_office_package_invocation_challenges where id=p_challenge_id;
 if not found then raise exception 'Office package invocation challenge absent' using errcode='42501'; end if;
 perform public.qorpera_check_office_package_invocation(p_startup,p_activation_id,p_challenge_id,p_provider_capability);
 select * into strict q from public.qorpera_office_package_provisions where id=a.package_provision_id;
 select * into strict i from public.qorpera_office_package_installations where provision_id=q.id;
 perform public.qorpera_office_software_sha(p_receipt_sha256);
 perform public.qorpera_office_software_sha(p_inventory_sha256);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 if i.receipt_sha256<>p_receipt_sha256 or i.inventory_sha256<>p_inventory_sha256
  or p_measured_service is distinct from q.statement#>'{target,service}' or p_runtime_bundle is distinct from q.statement#>'{target,runtimeBundle}' then
  raise exception 'Office package invocation measured bytes differ' using errcode='42501'; end if;
 select * into m from public.qorpera_office_package_measurements where challenge_id=p_challenge_id;
 if found then
  if m.activation_id<>a.activation_id or m.provision_id<>q.id or m.startup<>p_startup or m.service<>p_measured_service
   or m.runtime_bundle<>p_runtime_bundle or m.receipt_sha256<>p_receipt_sha256 or m.inventory_sha256<>p_inventory_sha256 or m.evidence_sha256<>p_evidence_sha256 then
   raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Office package measurement cannot be rebound","details":null,"hint":null}',detail='{"status":409,"headers":{}}'; end if;
 else
  insert into public.qorpera_office_package_measurements(challenge_id,activation_id,provision_id,startup,service,runtime_bundle,receipt_sha256,inventory_sha256,evidence_sha256)
   values(p_challenge_id,a.activation_id,q.id,p_startup,p_measured_service,p_runtime_bundle,p_receipt_sha256,p_inventory_sha256,p_evidence_sha256);
 end if;
 if n.expires_at<=clock_timestamp() then raise exception 'Office package invocation acknowledgement expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-code-package-invocation-measurement/v1','activationId',a.activation_id,
  'provisionId',q.id,'revision',q.target_revision,'state','measured');
end $$;

create function public.qorpera_assert_office_package_activation(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
declare m public.qorpera_office_package_measurements%rowtype; n public.qorpera_office_package_invocation_challenges%rowtype;
 q public.qorpera_office_package_provisions%rowtype; i public.qorpera_office_package_installations%rowtype;
begin
 if p_activation.package_provision_id is null then return; end if;
 perform public.qorpera_assert_office_package_startup(p_activation);
 select * into strict q from public.qorpera_office_package_provisions where id=p_activation.package_provision_id;
 select * into strict i from public.qorpera_office_package_installations where provision_id=q.id;
 select * into m from public.qorpera_office_package_measurements where activation_id=p_activation.activation_id order by measured_at desc limit 1 for share;
 select * into n from public.qorpera_office_package_invocation_challenges where id=m.challenge_id;
 if not found or m.provision_id is distinct from q.id or m.receipt_sha256 is distinct from i.receipt_sha256 or m.inventory_sha256 is distinct from i.inventory_sha256
  or m.service is distinct from q.statement#>'{target,service}' or m.runtime_bundle is distinct from q.statement#>'{target,runtimeBundle}'
  or m.startup->>'serviceInvocationId' is distinct from p_activation.service_invocation_id
  or m.startup->>'bootId' is distinct from p_activation.attestation->>'bootId'
  or m.startup->>'configurationSha256' is distinct from p_activation.attestation->>'configurationSha256'
  or n.capability_revision<>q.dispatch_capability_revision
  or (p_activation.state<>'active' and not exists(select 1 from public.qorpera_runtime_offices o where o.id=p_activation.office_id
   and o.revision=n.office_revision and o.privacy_version=n.privacy_version))
  or (p_activation.state<>'active' and (m.measured_at<=clock_timestamp()-interval '5 seconds' or n.expires_at<=clock_timestamp())) then
  raise exception 'Office package activation measurement unavailable' using errcode='42501'; end if;
end $$;

create function public.qorpera_refuse_service_update_on_package(p_allocation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.qorpera_office_package_baselines where allocation_id=p_allocation_id and current_revision>0) then
  raise exception 'Package-provisioned roots require package-aware updates' using errcode='42501'; end if;
end $$;

-- Guarded insertions preserve the effective lock/stop/privacy implementation
-- and all historical reset phase shapes. No old migration is reinterpreted.
create function pg_temp.office_package_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare d text:=pg_get_functiondef(p_target);
begin
 if (length(d)-length(replace(d,p_old,'')))/length(p_old)<>1 then raise exception 'Office package integration differs: %',p_target; end if;
 execute replace(d,p_old,p_new);
end $$;
select pg_temp.office_package_patch('public.qorpera_begin_runtime_office_reset(jsonb,text)'::regprocedure,
 E'\tinsert into public.qorpera_runtime_office_resets(reset_id,',
 E'\tperform public.qorpera_assert_office_package_reset(p_plan,p_plan_sha256,false);\n\tinsert into public.qorpera_runtime_office_resets(reset_id,');
select pg_temp.office_package_patch('public.qorpera_gate_runtime_office_reset_phase(public.qorpera_runtime_office_resets,text)'::regprocedure,
 E'\tif p_phase in (''root_deleted'',''root_created'',''restored'') then',
 E'\tif p_phase in (''powered_off'',''root_deleted'',''root_created'',''restored'') then\n\t\tperform public.qorpera_assert_office_package_reset(p_reset.plan,p_reset.plan_sha256,false);\n\tend if;\n\tif p_phase in (''root_deleted'',''root_created'',''restored'') then');
select pg_temp.office_package_patch('public.qorpera_prepare_runtime_office_reset_successor(jsonb)'::regprocedure,
 E'\tif exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id',
 E'\tperform public.qorpera_assert_office_package_reset(v_reset.plan,v_reset.plan_sha256,true);\n\tif exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id');
select pg_temp.office_package_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
 E'\treturn v_activation;',E'\tperform public.qorpera_assert_office_package_startup(v_activation);\n\treturn v_activation;');
select pg_temp.office_package_patch('public.qorpera_inherit_office_software()'::regprocedure,
 E'begin\n select * into b',
 E'begin\n if new.package_provision_id is not null then\n  if new.software_revision is not null then raise exception ''Package activation cannot claim service-only revision'' using errcode=''42501''; end if;\n  return new;\n end if;\n select * into b');
select pg_temp.office_package_patch('public.qorpera_assert_office_software_activation(public.qorpera_runtime_office_activations)'::regprocedure,
 E' if p_activation.software_revision is null then return; end if;',
 E' if p_activation.package_provision_id is not null then\n  perform public.qorpera_assert_office_package_activation(p_activation);return;\n end if;\n if p_activation.software_revision is null then return; end if;');
select pg_temp.office_package_patch('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure,
 E' perform public.qorpera_lock_runtime_office_stop(p->''predecessor'');',
 E' perform public.qorpera_lock_runtime_office_stop(p->''predecessor'');\n perform public.qorpera_refuse_service_update_on_package((p#>>''{predecessor,startup,allocationId}'')::uuid);');
select pg_temp.office_package_patch('public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text)'::regprocedure,
 E' perform public.qorpera_lock_runtime_office_stop(p_predecessor);',
 E' perform public.qorpera_lock_runtime_office_stop(p_predecessor);\n perform public.qorpera_refuse_service_update_on_package((p_predecessor#>>''{startup,allocationId}'')::uuid);');
select pg_temp.office_package_patch('public.qorpera_lock_office_software_install(uuid)'::regprocedure,
 E' perform public.qorpera_lock_runtime_office_stop(u.plan->''predecessor'');',
 E' perform public.qorpera_lock_runtime_office_stop(u.plan->''predecessor'');\n perform public.qorpera_refuse_service_update_on_package(u.allocation_id);');

-- Custody tables and helpers remain private, including the new capability.
do $$
declare t text; f record;
begin
 foreach t in array array['qorpera_office_package_capabilities','qorpera_office_package_baselines','qorpera_office_package_provisions',
  'qorpera_office_package_observations','qorpera_office_package_installations','qorpera_office_package_invocation_challenges','qorpera_office_package_measurements'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'qorpera_%office_package%' or proname in ('qorpera_inherit_office_package','qorpera_refuse_service_update_on_package')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.qorpera_enroll_office_package_provision(text,text,text,text,text),
 public.qorpera_check_office_package_provision(uuid,text,text),
 public.qorpera_check_office_package_provision_observation(uuid,uuid,text,text),
 public.qorpera_ack_office_package_provision(uuid,uuid,text,text,text,text),
 public.qorpera_office_package_provision_status(uuid,text),
 public.qorpera_check_office_package_invocation(jsonb,uuid,uuid,text),
 public.qorpera_ack_office_package_invocation(jsonb,uuid,uuid,text,text,jsonb,jsonb,text,text) to service_role;
