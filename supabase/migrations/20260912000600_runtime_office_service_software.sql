-- Governed service-only revisions on an existing office allocation. Protected
-- provider verification supplies physical evidence; SQL supplies current
-- authority and immutable provenance. Nothing here stops, installs or starts.
-- Operator/postgres enrollment only. The ordinary office has service_role;
-- it must never be able to mint the separate protected provider capability.
create table public.qorpera_office_software_provider_capabilities (
 allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
 provider_id uuid not null, provider_policy_sha256 text not null check(provider_policy_sha256 ~ '^[0-9a-f]{64}$'),
 capability_sha256 text not null unique check(capability_sha256 ~ '^[0-9a-f]{64}$'),
 revision bigint not null check(revision between 1 and 9007199254740990), enabled boolean not null
);
create function public.qorpera_guard_office_software_capability()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.allocation_id<>old.allocation_id or new.provider_id<>old.provider_id or new.provider_policy_sha256<>old.provider_policy_sha256
  or new.revision<>old.revision+1 then raise exception 'Office software capability rotation differs' using errcode='42501'; end if;
 return new;
end $$;
create trigger qorpera_guard_office_software_capability before update on public.qorpera_office_software_provider_capabilities
 for each row execute function public.qorpera_guard_office_software_capability();
create function public.qorpera_require_office_software_capability(p_allocation_id uuid,p_capability text,p_lock boolean)
returns bigint language plpgsql security definer set search_path='' as $$
declare c public.qorpera_office_software_provider_capabilities%rowtype;
begin
 if auth.role() is distinct from 'service_role' or p_capability is null or p_capability !~ '^[0-9a-f]{64}$' or p_lock is null then
  raise exception 'Office software provider capability required' using errcode='42501'; end if;
 -- Precheck never acquires a company/authority lock for an untrusted token.
 -- The post-lock check holds SHARE through commit; operator rotation must
 -- use profile -> office -> capability order if it acquires broader locks.
 if p_lock then
  select c0.* into c from public.qorpera_office_software_provider_capabilities c0
   where c0.allocation_id=p_allocation_id for share;
 else
  select * into c from public.qorpera_office_software_provider_capabilities where allocation_id=p_allocation_id;
 end if;
 if not found or not c.enabled or c.capability_sha256<>encode(extensions.digest(p_capability,'sha256'),'hex')
  or not exists(select 1 from public.qorpera_runtime_machine_allocations a
   join public.qorpera_runtime_office_providers p on p.office_id=a.office_id and p.computer_generation=a.computer_generation
   where a.id=p_allocation_id and a.provider_adapter='lxd' and a.released_at is null
    and p.provider_id=c.provider_id and p.policy_sha256=c.provider_policy_sha256) then
  raise exception 'Office software provider capability unavailable' using errcode='42501'; end if;
 return c.revision;
end $$;

create table public.qorpera_office_software_baselines (
 allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
 activation_id uuid not null unique references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 predecessor jsonb not null, base jsonb not null, original_service jsonb not null,
 evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 current_revision bigint not null default 0 check(current_revision between 0 and 9007199254740990)
);
create table public.qorpera_office_software_revisions (
 allocation_id uuid not null references public.qorpera_office_software_baselines(allocation_id) on delete restrict,
 revision bigint not null check(revision between 0 and 9007199254740990),
 specification jsonb not null, primary key(allocation_id,revision)
);
alter table public.qorpera_runtime_office_activations add column software_revision bigint,
 add foreign key(allocation_id,software_revision) references public.qorpera_office_software_revisions(allocation_id,revision) on delete restrict;
create table public.qorpera_office_software_updates (
 id uuid primary key, allocation_id uuid not null references public.qorpera_office_software_baselines(allocation_id) on delete restrict,
 predecessor_activation_id uuid not null unique references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 successor_activation_id uuid not null unique,
 transition_id uuid not null unique references public.qorpera_runtime_office_stops(transition_id) on delete restrict,
 previous_revision bigint not null, target_revision bigint not null,
 plan jsonb not null, statement jsonb not null, plan_sha256 text not null, statement_sha256 text not null,
 office_revision bigint not null, privacy_version bigint not null, privacy_state text not null, privacy_challenge jsonb,
 state text not null default 'begun' check(state in ('begun','installed')),
 receipt jsonb, installation_evidence_sha256 text,
 check(target_revision=previous_revision+1),
 check((state='begun' and receipt is null and installation_evidence_sha256 is null)
  or (state='installed' and receipt is not null and installation_evidence_sha256 ~ '^[0-9a-f]{64}$')),
 unique(allocation_id,target_revision)
);
create table public.qorpera_office_software_challenges (
 id uuid primary key, allocation_id uuid not null references public.qorpera_office_software_baselines(allocation_id) on delete restrict,
 update_id uuid references public.qorpera_office_software_updates(id) on delete restrict,
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 phase text not null check(phase in ('install','invocation')), revision bigint not null,
 startup jsonb, office_revision bigint not null, privacy_version bigint not null,
 capability_revision bigint not null check(capability_revision between 1 and 9007199254740990),
 issued_at timestamptz not null, expires_at timestamptz not null,
 check(expires_at=issued_at+interval '5 seconds')
);
create table public.qorpera_office_software_measurements (
 activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
 challenge_id uuid primary key references public.qorpera_office_software_challenges(id) on delete restrict,
 startup jsonb not null, revision bigint not null, service jsonb not null,
 evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'), measured_at timestamptz not null
);
create index qorpera_office_software_measurements_activation on public.qorpera_office_software_measurements(activation_id,measured_at desc);
alter table public.qorpera_office_software_updates add column installation_challenge_id uuid unique
 references public.qorpera_office_software_challenges(id) on delete restrict;

create function public.qorpera_office_software_object(p_value jsonb,p_keys text[])
returns void language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'object' or not(p_value ?& p_keys) or p_value-p_keys<>'{}'::jsonb then
  raise exception 'Invalid office software object' using errcode='22023'; end if;
end $$;
create function public.qorpera_office_software_uuid(p_value uuid)
returns void language plpgsql immutable set search_path='' as $$
begin
 if p_value is null or p_value::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception 'Invalid office software challenge identity' using errcode='22023'; end if;
end $$;
create function public.qorpera_office_software_strings(p_value jsonb,p_keys text[])
returns void language plpgsql immutable set search_path='' as $$
declare k text;
begin
 foreach k in array p_keys loop
  if jsonb_typeof(p_value->k) is distinct from 'string' then raise exception 'Invalid office software string' using errcode='22023'; end if;
 end loop;
end $$;
create function public.qorpera_office_software_sha(p_value text)
returns void language plpgsql immutable set search_path='' as $$
begin
 if p_value is null or p_value !~ '^[0-9a-f]{64}$' then raise exception 'Invalid office software digest' using errcode='22023'; end if;
end $$;
create function public.qorpera_office_software_artifact(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 perform public.qorpera_office_software_object(p_value,array['path','bytes','sha256']);
 perform public.qorpera_office_software_strings(p_value,array['path','sha256']);
 if p_value->>'path' is distinct from '/opt/qorpera-office/qorpera-company-computer-service.mjs'
  or jsonb_typeof(p_value->'bytes') is distinct from 'number' or p_value->>'bytes' !~ '^[1-9][0-9]{0,7}$'
  or (p_value->>'bytes')::bigint>33554432 then raise exception 'Invalid office software artifact' using errcode='22023'; end if;
 perform public.qorpera_office_software_sha(p_value->>'sha256');
end $$;
create function public.qorpera_office_software_specification(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 perform public.qorpera_office_software_object(p_value,array['packageManifestSha256','sourceCommit','service']);
 perform public.qorpera_office_software_strings(p_value,array['packageManifestSha256','sourceCommit']);
 perform public.qorpera_office_software_sha(p_value->>'packageManifestSha256');
 if coalesce(p_value->>'sourceCommit','') !~ '^[0-9a-f]{40}$' then raise exception 'Invalid office software source' using errcode='22023'; end if;
 perform public.qorpera_office_software_artifact(p_value->'service');
end $$;

-- Enrollment is possible only against the exact acknowledged stopped current
-- activation. The provider independently verifies the original signed image,
-- package/source and installed service bytes before submitting this evidence.
create function public.qorpera_enroll_office_software(p_predecessor jsonb,p_base jsonb,p_current jsonb,p_evidence_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; b public.qorpera_office_software_baselines%rowtype;
begin
 perform public.qorpera_require_office_software_capability((p_predecessor#>>'{startup,allocationId}')::uuid,p_provider_capability,false);
 perform public.qorpera_lock_runtime_office_stop(p_predecessor);
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=(p_predecessor->>'activationId')::uuid;
 perform public.qorpera_check_runtime_office_restart_surfaces(a);
 perform public.qorpera_require_office_software_capability(a.allocation_id,p_provider_capability,true);
 if not exists(select 1 from public.qorpera_runtime_office_stops where transition_id=(p_predecessor->>'transitionId')::uuid)
  then raise exception 'Office software predecessor stop unacknowledged' using errcode='42501'; end if;
 perform public.qorpera_office_software_object(p_base,array['imageSha256','bootstrapSha256','packageManifestSha256','sourceCommit']);
 perform public.qorpera_office_software_strings(p_base,array['imageSha256','bootstrapSha256','packageManifestSha256','sourceCommit']);
 perform public.qorpera_office_software_specification(p_current);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 if p_base->>'imageSha256' is distinct from a.image_sha256 or p_base->>'bootstrapSha256' is distinct from a.bootstrap_sha256
  or p_base->'packageManifestSha256' is distinct from p_current->'packageManifestSha256'
  or p_base->'sourceCommit' is distinct from p_current->'sourceCommit' then
  raise exception 'Office software baseline differs' using errcode='42501'; end if;
 select * into b from public.qorpera_office_software_baselines where allocation_id=a.allocation_id for update;
 if found then
  if b.activation_id<>a.activation_id or b.predecessor<>p_predecessor or b.base<>p_base
   or b.original_service<>p_current or b.evidence_sha256<>p_evidence_sha256 then
   raise exception 'Office software baseline cannot be rebound' using errcode='42501'; end if;
 else
  insert into public.qorpera_office_software_baselines(allocation_id,activation_id,predecessor,base,original_service,evidence_sha256)
   values(a.allocation_id,a.activation_id,p_predecessor,p_base,p_current,p_evidence_sha256) returning * into b;
  insert into public.qorpera_office_software_revisions values(a.allocation_id,0,p_current);
  update public.qorpera_runtime_office_activations set software_revision=0 where activation_id=a.activation_id;
 end if;
 return jsonb_build_object('schema','qorpera.office-software-baseline/v1','allocationId',b.allocation_id,'base',b.base,'revision',b.current_revision);
end $$;

-- Canonical documents are passed as text so their protected SHA256 is checked
-- against the exact bytes, not PostgreSQL's different jsonb serialization.
create function public.qorpera_begin_office_software(p_plan_text text,p_statement_text text,p_plan_sha256 text,p_expected_revision bigint,p_stop_text text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb; s jsonb; a public.qorpera_runtime_office_activations%rowtype;
 b public.qorpera_office_software_baselines%rowtype; u public.qorpera_office_software_updates%rowtype;
 o public.qorpera_runtime_offices%rowtype; v_current jsonb; v_stop jsonb; v_key text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
 if p_plan_text is null or p_statement_text is null or p_stop_text is null or octet_length(p_plan_text)>65536 or octet_length(p_statement_text)>65536 or octet_length(p_stop_text)>65536 then
  raise exception 'Invalid office software documents' using errcode='22023'; end if;
 p:=p_plan_text::jsonb; s:=p_statement_text::jsonb;
 perform public.qorpera_require_office_software_capability((p#>>'{predecessor,startup,allocationId}')::uuid,p_provider_capability,false);
 perform public.qorpera_office_software_object(p,array['schema','updateId','predecessor','stopAcknowledgementSha256','successorActivationId','statementSha256']);
 perform public.qorpera_office_software_object(s,array['schema','base','previous','next','source','acceptance']);
 perform public.qorpera_office_software_object(s->'source',array['repository','commit','tree']);
 perform public.qorpera_office_software_object(s->'acceptance',array['testedAt','evidenceSha256','change']);
 perform public.qorpera_office_software_object(s->'next',array['packageManifestSha256','service']);
 perform public.qorpera_office_software_strings(p,array['schema','updateId','stopAcknowledgementSha256','successorActivationId','statementSha256']);
 perform public.qorpera_office_software_strings(s->'source',array['repository','commit','tree']);
 perform public.qorpera_office_software_strings(s->'acceptance',array['testedAt','evidenceSha256','change']);
 perform public.qorpera_office_software_strings(s->'next',array['packageManifestSha256']);
 perform public.qorpera_office_software_specification(s->'previous');
 perform public.qorpera_office_software_artifact(s#>'{next,service}');
 foreach v_key in array array['updateId','successorActivationId'] loop
  if jsonb_typeof(p->v_key) is distinct from 'string' or p->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception 'Invalid office software identity' using errcode='22023'; end if;
 end loop;
 perform public.qorpera_office_software_sha(p->>'stopAcknowledgementSha256');
 perform public.qorpera_office_software_sha(p->>'statementSha256');
 perform public.qorpera_office_software_sha(p_plan_sha256);
 perform public.qorpera_office_software_sha(s#>>'{next,packageManifestSha256}');
 perform public.qorpera_office_software_sha(s#>>'{acceptance,evidenceSha256}');
 if p->>'schema' is distinct from 'qorpera.office-service-software-plan/v1'
  or s->>'schema' is distinct from 'qorpera.office-service-software-statement/v1'
  or s#>>'{source,tree}' is distinct from 'clean' or s#>>'{acceptance,change}' is distinct from 'service-only'
  or coalesce(s#>>'{source,commit}','') !~ '^[0-9a-f]{40}$'
  or coalesce(s#>>'{source,repository}','') !~ '^https://[^/?#@:]+(/[^?#]*)?$'
  or length(s#>>'{source,repository}')>2048
  or coalesce(s#>>'{acceptance,testedAt}','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or s#>'{previous,service,sha256}'=s#>'{next,service,sha256}'
  or s#>'{previous,packageManifestSha256}'=s#>'{next,packageManifestSha256}'
  or encode(extensions.digest(p_plan_text,'sha256'),'hex')<>p_plan_sha256
  or encode(extensions.digest(p_statement_text,'sha256'),'hex')<>p->>'statementSha256'
  or p#>>'{predecessor,action}' is distinct from 'service_restart'
  or (select count(distinct value) from unnest(array[p->>'updateId',p->>'successorActivationId',p#>>'{predecessor,activationId}',p#>>'{predecessor,transitionId}']) value)<>4 then
  raise exception 'Office software plan or statement differs' using errcode='42501'; end if;
 perform (s#>>'{acceptance,testedAt}')::timestamptz;
 perform public.qorpera_lock_runtime_office_stop(p->'predecessor');
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=(p#>>'{predecessor,activationId}')::uuid;
 perform public.qorpera_check_runtime_office_restart_surfaces(a);
 perform public.qorpera_require_office_software_capability(a.allocation_id,p_provider_capability,true);
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 select * into b from public.qorpera_office_software_baselines where allocation_id=a.allocation_id for update;
 if not found or s->'base' is distinct from b.base then raise exception 'Office software baseline unavailable' using errcode='42501'; end if;
 select public.qorpera_runtime_office_stop_result(stop,p->'predecessor') into v_stop
  from public.qorpera_runtime_office_stops stop where transition_id=(p#>>'{predecessor,transitionId}')::uuid;
 if v_stop is null or p_stop_text::jsonb<>v_stop or encode(extensions.digest(p_stop_text,'sha256'),'hex')<>p->>'stopAcknowledgementSha256'
  then raise exception 'Office software stop unavailable' using errcode='42501'; end if;
 select * into u from public.qorpera_office_software_updates where id=(p->>'updateId')::uuid for update;
 if found then
  if u.plan<>p or u.statement<>s or u.plan_sha256<>p_plan_sha256 or u.previous_revision is distinct from p_expected_revision then
   raise exception 'Office software update cannot be rebound' using errcode='42501'; end if;
  return jsonb_build_object('updateId',u.id,'state',u.state,'targetRevision',u.target_revision);
 end if;
 select specification into v_current from public.qorpera_office_software_revisions where allocation_id=b.allocation_id and revision=b.current_revision;
 if p_expected_revision is null or p_expected_revision<>b.current_revision or a.software_revision is distinct from b.current_revision
  or s->'previous' is distinct from v_current or exists(select 1 from public.qorpera_runtime_office_activations where activation_id=(p->>'successorActivationId')::uuid) then
  raise exception 'Office software current revision changed' using errcode='40001'; end if;
 insert into public.qorpera_office_software_updates(id,allocation_id,predecessor_activation_id,successor_activation_id,transition_id,
  previous_revision,target_revision,plan,statement,plan_sha256,statement_sha256,office_revision,privacy_version,privacy_state,privacy_challenge)
 values((p->>'updateId')::uuid,a.allocation_id,a.activation_id,(p->>'successorActivationId')::uuid,(p#>>'{predecessor,transitionId}')::uuid,
  b.current_revision,b.current_revision+1,p,s,p_plan_sha256,p->>'statementSha256',o.revision,o.privacy_version,o.privacy_state,o.privacy_challenge) returning * into u;
 return jsonb_build_object('updateId',u.id,'state',u.state,'targetRevision',u.target_revision);
end $$;

create function public.qorpera_lock_office_software_install(p_update_id uuid)
returns public.qorpera_office_software_updates language plpgsql security definer set search_path='' as $$
declare u public.qorpera_office_software_updates%rowtype; a public.qorpera_runtime_office_activations%rowtype;
 o public.qorpera_runtime_offices%rowtype; b public.qorpera_office_software_baselines%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
 select * into u from public.qorpera_office_software_updates where id=p_update_id;
 if not found then raise exception 'Office software update unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_runtime_office_stop(u.plan->'predecessor');
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=u.predecessor_activation_id;
 perform public.qorpera_check_runtime_office_restart_surfaces(a);
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 select * into strict b from public.qorpera_office_software_baselines where allocation_id=a.allocation_id for update;
 select * into strict u from public.qorpera_office_software_updates where id=p_update_id for update;
 if o.revision<>u.office_revision or o.privacy_version<>u.privacy_version
  or o.privacy_state<>u.privacy_state or o.privacy_challenge is distinct from u.privacy_challenge
  or b.current_revision<>(case when u.state='installed' then u.target_revision else u.previous_revision end)
  or exists(select 1 from public.qorpera_runtime_office_successors where transition_id=u.transition_id) then
  raise exception 'Office software installation authority changed' using errcode='42501'; end if;
 return u;
end $$;

create function public.qorpera_check_office_software_install(p_update_id uuid,p_challenge_id uuid,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qorpera_office_software_updates%rowtype; c public.qorpera_office_software_challenges%rowtype; t timestamptz; v_capability bigint;
begin
 perform public.qorpera_require_office_software_capability((select allocation_id from public.qorpera_office_software_updates where id=p_update_id),p_provider_capability,false);
 u:=public.qorpera_lock_office_software_install(p_update_id);
 v_capability:=public.qorpera_require_office_software_capability(u.allocation_id,p_provider_capability,true);
 perform public.qorpera_office_software_uuid(p_challenge_id);
 if u.state<>'begun' or p_challenge_id is null then raise exception 'Office software install dispatch unavailable' using errcode='42501'; end if;
 select * into c from public.qorpera_office_software_challenges where id=p_challenge_id for update;
 if found then
  if c.phase<>'install' or c.update_id<>u.id or c.capability_revision<>v_capability then raise exception 'Office software challenge cannot be rebound' using errcode='42501'; end if;
 else
  if (select count(*) from public.qorpera_office_software_challenges where update_id=u.id and phase='install')>=64 then
   raise exception 'Office software challenge budget exhausted' using errcode='54000'; end if;
  t:=clock_timestamp();
  insert into public.qorpera_office_software_challenges(id,allocation_id,update_id,activation_id,phase,revision,office_revision,privacy_version,capability_revision,issued_at,expires_at)
  values(p_challenge_id,u.allocation_id,u.id,u.predecessor_activation_id,'install',u.target_revision,u.office_revision,u.privacy_version,v_capability,t,t+interval '5 seconds') returning * into c;
 end if;
 if c.expires_at<=clock_timestamp() then raise exception 'Office software challenge expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-software-install-challenge/v1','challengeId',c.id,'plan',u.plan,
  'planSha256',u.plan_sha256,'statement',u.statement,'targetRevision',u.target_revision,'capabilityRevision',c.capability_revision,
  'validForMs',least(5000,floor(extract(epoch from(c.expires_at-clock_timestamp()))*1000)::bigint));
end $$;

create function public.qorpera_ack_office_software_install(p_update_id uuid,p_challenge_id uuid,p_receipt_text text,p_measured_service jsonb,p_evidence_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qorpera_office_software_updates%rowtype; c public.qorpera_office_software_challenges%rowtype; r jsonb; v_capability bigint;
begin
 perform public.qorpera_require_office_software_capability((select allocation_id from public.qorpera_office_software_updates where id=p_update_id),p_provider_capability,false);
 u:=public.qorpera_lock_office_software_install(p_update_id);
 v_capability:=public.qorpera_require_office_software_capability(u.allocation_id,p_provider_capability,true);
 if p_receipt_text is null or octet_length(p_receipt_text)>65536 then raise exception 'Invalid office software receipt' using errcode='22023'; end if;
 r:=p_receipt_text::jsonb;
 perform public.qorpera_office_software_object(r,array['schema','plan','planSha256','state','service','installedAt']);
 perform public.qorpera_office_software_strings(r,array['schema','planSha256','state','installedAt']);
 perform public.qorpera_office_software_artifact(p_measured_service);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 if r->>'schema' is distinct from 'qorpera.office-service-software-receipt/v1' or r->>'state' is distinct from 'installed'
  or r->'plan' is distinct from u.plan or r->>'planSha256' is distinct from u.plan_sha256
  or r->'service' is distinct from u.statement#>'{next,service}' or p_measured_service is distinct from r->'service'
  or coalesce(r->>'installedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or (r->>'installedAt')::timestamptz<(u.statement#>>'{acceptance,testedAt}')::timestamptz then
  raise exception 'Office software installation differs' using errcode='42501'; end if;
 select * into c from public.qorpera_office_software_challenges where id=p_challenge_id for update;
 if not found or c.phase<>'install' or c.update_id<>u.id or c.revision<>u.target_revision or c.capability_revision<>v_capability then
  raise exception 'Office software installation challenge differs' using errcode='42501'; end if;
 if u.state='installed' then
  if u.receipt<>r or u.installation_evidence_sha256<>p_evidence_sha256 or u.installation_challenge_id is distinct from p_challenge_id then
   raise exception 'Office software installation cannot be rebound' using errcode='42501'; end if;
 else
  if c.expires_at<=clock_timestamp() then raise exception 'Office software installation challenge expired' using errcode='42501'; end if;
  insert into public.qorpera_office_software_revisions values(u.allocation_id,u.target_revision,
   u.statement->'next'||jsonb_build_object('sourceCommit',u.statement#>'{source,commit}'));
  update public.qorpera_office_software_baselines set current_revision=u.target_revision
   where allocation_id=u.allocation_id and current_revision=u.previous_revision;
  if not found then raise exception 'Office software revision changed' using errcode='40001'; end if;
  update public.qorpera_office_software_updates set state='installed',receipt=r,installation_evidence_sha256=p_evidence_sha256,installation_challenge_id=p_challenge_id where id=u.id;
  if c.expires_at<=clock_timestamp() then raise exception 'Office software installation acknowledgement expired' using errcode='42501'; end if;
 end if;
 return jsonb_build_object('schema','qorpera.office-software-installation/v1','updateId',u.id,'state','installed','targetRevision',u.target_revision);
end $$;

-- Every later activation on an enrolled allocation inherits its software
-- identity. Both ordinary same-boot and new-boot successors use this insert
-- boundary, so an old client cannot silently drop provenance.
create function public.qorpera_inherit_office_software()
returns trigger language plpgsql security definer set search_path='' as $$
declare b public.qorpera_office_software_baselines%rowtype; u public.qorpera_office_software_updates%rowtype;
 a public.qorpera_runtime_office_activations%rowtype;
begin
 select * into b from public.qorpera_office_software_baselines where allocation_id=new.allocation_id for share;
 if not found then
  if new.software_revision is not null then raise exception 'Office software baseline absent' using errcode='42501'; end if;
  return new;
 end if;
 select * into a from public.qorpera_runtime_office_activations where activation_id=new.predecessor_activation_id;
 if not found or a.allocation_id<>new.allocation_id or a.software_revision is null then
  raise exception 'Office software predecessor unavailable' using errcode='42501'; end if;
 select * into u from public.qorpera_office_software_updates where predecessor_activation_id=a.activation_id;
 if found then
  if u.state<>'installed' or new.activation_id<>u.successor_activation_id or b.current_revision<>u.target_revision
   or new.attestation-'activationId'<>a.attestation-'activationId' then
   raise exception 'Office software successor installation unavailable' using errcode='42501'; end if;
  new.software_revision:=u.target_revision;
 else
  if a.software_revision<>b.current_revision then raise exception 'Office software revision inheritance differs' using errcode='42501'; end if;
  new.software_revision:=a.software_revision;
 end if;
 return new;
end $$;
create trigger qorpera_inherit_office_software before insert on public.qorpera_runtime_office_activations
 for each row execute function public.qorpera_inherit_office_software();

create function public.qorpera_lock_office_software_invocation(p_startup jsonb,p_activation_id uuid)
returns public.qorpera_runtime_office_activations language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; b public.qorpera_office_software_baselines%rowtype;
begin
 a:=public.qorpera_lock_runtime_office_startup(p_startup);
 if a.activation_id is distinct from p_activation_id or a.software_revision is null or a.state<>'ready'
  or a.service_invocation_id is distinct from p_startup->>'serviceInvocationId'
  or a.ready_at<=clock_timestamp()-interval '5 seconds' then
  raise exception 'Office software invocation not ready' using errcode='42501'; end if;
 select * into b from public.qorpera_office_software_baselines where allocation_id=a.allocation_id for share;
 if b.current_revision is distinct from a.software_revision then raise exception 'Office software invocation revision changed' using errcode='42501'; end if;
 return a;
end $$;

create function public.qorpera_check_office_software_invocation(p_startup jsonb,p_activation_id uuid,p_challenge_id uuid,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; c public.qorpera_office_software_challenges%rowtype;
 o public.qorpera_runtime_offices%rowtype; v_service jsonb; t timestamptz; v_capability bigint;
begin
 perform public.qorpera_require_office_software_capability((p_startup->>'allocationId')::uuid,p_provider_capability,false);
 a:=public.qorpera_lock_office_software_invocation(p_startup,p_activation_id);
 v_capability:=public.qorpera_require_office_software_capability(a.allocation_id,p_provider_capability,true);
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 perform public.qorpera_office_software_uuid(p_challenge_id);
 select * into c from public.qorpera_office_software_challenges where id=p_challenge_id for update;
 if found then
  if c.phase<>'invocation' or c.activation_id<>a.activation_id or c.startup<>p_startup or c.revision<>a.software_revision
   or c.office_revision<>o.revision or c.privacy_version<>o.privacy_version or c.capability_revision<>v_capability then
   raise exception 'Office software invocation challenge changed' using errcode='42501'; end if;
 else
  if (select count(*) from public.qorpera_office_software_challenges where activation_id=a.activation_id and phase='invocation')>=64 then
   raise exception 'Office software challenge budget exhausted' using errcode='54000'; end if;
  t:=clock_timestamp();
  insert into public.qorpera_office_software_challenges(id,allocation_id,activation_id,phase,revision,startup,office_revision,privacy_version,capability_revision,issued_at,expires_at)
  values(p_challenge_id,a.allocation_id,a.activation_id,'invocation',a.software_revision,p_startup,o.revision,o.privacy_version,v_capability,t,t+interval '5 seconds') returning * into c;
 end if;
 if c.expires_at<=clock_timestamp() then raise exception 'Office software invocation challenge expired' using errcode='42501'; end if;
 select specification->'service' into strict v_service from public.qorpera_office_software_revisions where allocation_id=a.allocation_id and revision=a.software_revision;
 return jsonb_build_object('schema','qorpera.office-software-invocation-challenge/v1','challengeId',c.id,'activationId',a.activation_id,
  'startup',p_startup,'revision',a.software_revision,'service',v_service,'capabilityRevision',c.capability_revision,
  'validForMs',least(5000,floor(extract(epoch from(c.expires_at-clock_timestamp()))*1000)::bigint));
end $$;

create function public.qorpera_ack_office_software_invocation(p_startup jsonb,p_activation_id uuid,p_challenge_id uuid,p_measured_service jsonb,p_evidence_sha256 text,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_office_activations%rowtype; c public.qorpera_office_software_challenges%rowtype;
 m public.qorpera_office_software_measurements%rowtype; v_service jsonb;
begin
 perform public.qorpera_require_office_software_capability((p_startup->>'allocationId')::uuid,p_provider_capability,false);
 a:=public.qorpera_lock_office_software_invocation(p_startup,p_activation_id);
 select * into c from public.qorpera_office_software_challenges where id=p_challenge_id for update;
 if not found then raise exception 'Office software invocation challenge absent' using errcode='42501'; end if;
 perform public.qorpera_check_office_software_invocation(p_startup,p_activation_id,p_challenge_id,p_provider_capability);
 perform public.qorpera_office_software_artifact(p_measured_service);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 select * into strict c from public.qorpera_office_software_challenges where id=p_challenge_id;
 select specification->'service' into strict v_service from public.qorpera_office_software_revisions where allocation_id=a.allocation_id and revision=a.software_revision;
 if p_measured_service<>v_service then raise exception 'Office software invocation bytes differ' using errcode='42501'; end if;
 select * into m from public.qorpera_office_software_measurements where challenge_id=p_challenge_id for update;
 if found and (m.startup<>p_startup or m.revision<>a.software_revision or m.service<>v_service) then
  raise exception 'Office software invocation cannot be rebound' using errcode='42501'; end if;
 if found then
  if m.evidence_sha256<>p_evidence_sha256 then raise exception 'Office software measurement cannot be rebound' using errcode='42501'; end if;
 else
  insert into public.qorpera_office_software_measurements(activation_id,challenge_id,startup,revision,service,evidence_sha256,measured_at)
  values(a.activation_id,p_challenge_id,p_startup,a.software_revision,v_service,p_evidence_sha256,clock_timestamp());
 end if;
 if c.expires_at<=clock_timestamp() then raise exception 'Office software invocation acknowledgement expired' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.office-software-measurement/v1','activationId',a.activation_id,'revision',a.software_revision,'state','measured');
end $$;

create function public.qorpera_assert_office_software_activation(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
declare m public.qorpera_office_software_measurements%rowtype; c public.qorpera_office_software_challenges%rowtype;
begin
 if p_activation.software_revision is null then return; end if;
 select * into m from public.qorpera_office_software_measurements where activation_id=p_activation.activation_id order by measured_at desc limit 1 for share;
 select * into c from public.qorpera_office_software_challenges where id=m.challenge_id;
 if not found or m.activation_id is null then raise exception 'Office software activation measurement unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_office_software_provider_capabilities
  where allocation_id=p_activation.allocation_id and enabled and revision=c.capability_revision for share;
 if not found then raise exception 'Office software activation capability revoked' using errcode='42501'; end if;
 if not found or m.activation_id is null or m.revision<>p_activation.software_revision
  or m.startup->>'serviceInvocationId' is distinct from p_activation.service_invocation_id
  or m.startup->>'bootId' is distinct from p_activation.attestation->>'bootId'
  or m.startup->>'configurationSha256' is distinct from p_activation.attestation->>'configurationSha256'
  or (p_activation.state<>'active' and (m.measured_at<=clock_timestamp()-interval '5 seconds' or c.expires_at<=clock_timestamp()))
  or not exists(select 1 from public.qorpera_office_software_baselines where allocation_id=p_activation.allocation_id and current_revision=m.revision)
  or not exists(select 1 from public.qorpera_office_software_provider_capabilities where allocation_id=p_activation.allocation_id and enabled and revision=c.capability_revision) then
  raise exception 'Office software activation measurement unavailable' using errcode='42501'; end if;
end $$;

-- Prepared startup/readiness remain closed to work, avoiding a circular
-- requirement to measure a process before it exists. The final activation
-- requires independent current invocation/byte measurement in addition to
-- all existing ready, provider, company, drain and privacy fences.
do $$
declare target regprocedure:='public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure;
 definition text:=pg_get_functiondef(target); marker text:=E'\tif v_activation.state=''active'' then';
 commit_marker text:=E'\tupdate public.qorpera_runtime_offices set state=''active'' where id=v_activation.office_id;';
begin
 if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'Office software activation integration differs'; end if;
 if (length(definition)-length(replace(definition,commit_marker,'')))/length(commit_marker)<>1 then raise exception 'Office software activation commit integration differs'; end if;
 definition:=replace(definition,marker,E'\tperform public.qorpera_assert_office_software_activation(v_activation);\n'||marker);
 execute replace(definition,commit_marker,E'\tperform public.qorpera_assert_office_software_activation(v_activation);\n'||commit_marker);
end $$;

-- All new tables are custody history, never a member/native write surface.
create function public.qorpera_office_software_status(p_plan jsonb,p_provider_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qorpera_office_software_updates%rowtype; b public.qorpera_office_software_baselines%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
 select * into u from public.qorpera_office_software_updates where plan=p_plan;
 if not found then raise exception 'Office software update unavailable' using errcode='42501'; end if;
 perform public.qorpera_require_office_software_capability(u.allocation_id,p_provider_capability,false);
 perform public.qorpera_assert_runtime_office_provider(u.plan#>'{predecessor,startup,scope}',
  (u.plan#>>'{predecessor,startup,computerGeneration}')::bigint,(u.plan#>>'{predecessor,providerId}')::uuid,u.plan#>>'{predecessor,providerPolicySha256}',false);
 perform public.qorpera_require_office_software_capability(u.allocation_id,p_provider_capability,true);
 select * into strict b from public.qorpera_office_software_baselines where allocation_id=u.allocation_id for share;
 select * into strict u from public.qorpera_office_software_updates where id=u.id for share;
 return jsonb_build_object('schema','qorpera.office-software-status/v1','plan',u.plan,'statement',u.statement,'state',u.state,
  'base',b.base,'currentRevision',b.current_revision,'targetRevision',u.target_revision,'receipt',u.receipt,
  'installationChallengeId',u.installation_challenge_id,'installationEvidenceSha256',u.installation_evidence_sha256);
end $$;

do $$
declare t text; f record;
begin
 foreach t in array array['qorpera_office_software_provider_capabilities','qorpera_office_software_baselines','qorpera_office_software_revisions','qorpera_office_software_updates',
  'qorpera_office_software_challenges','qorpera_office_software_measurements'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'qorpera_%office_software%' or proname='qorpera_inherit_office_software') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text),
 public.qorpera_begin_office_software(text,text,text,bigint,text,text),public.qorpera_check_office_software_install(uuid,uuid,text),
 public.qorpera_ack_office_software_install(uuid,uuid,text,jsonb,text,text),public.qorpera_check_office_software_invocation(jsonb,uuid,uuid,text),
 public.qorpera_ack_office_software_invocation(jsonb,uuid,uuid,jsonb,text,text),public.qorpera_office_software_status(jsonb,text) to service_role;
