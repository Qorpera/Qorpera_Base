-- Node-scoped automatic update authority. No signing keys, credentials, timer,
-- deployment, schema activation or enrollment is introduced by this migration.
create table public.qorpera_node_update_enrollments (
 node_id uuid primary key references public.qorpera_runtime_nodes(id) on delete restrict,
 capability_revision bigint not null check(capability_revision between 1 and 9007199254740990),
 capability_sha256 text not null unique check(capability_sha256 ~ '^[0-9a-f]{64}$'), enabled boolean not null,
 current_revision bigint not null check(current_revision between 0 and 9007199254740989),
 current_release_sha256 text not null check(current_release_sha256 ~ '^[0-9a-f]{64}$'),
 current_artifact_sha256 text not null check(current_artifact_sha256 ~ '^[0-9a-f]{64}$')
);
create table public.qorpera_node_update_targets (
 node_id uuid not null references public.qorpera_node_update_enrollments(node_id) on delete restrict,
 revision bigint not null, release_sha256 text not null unique check(release_sha256 ~ '^[0-9a-f]{64}$'),
 release_text text not null check(octet_length(release_text) between 1 and 16384), signature text not null,
 publication_evidence_sha256 text not null check(publication_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 company_ids uuid[] not null check(cardinality(company_ids) between 1 and 100),
 pause_proof jsonb, drain_authorization_sha256 text,
 original_policy jsonb, original_version bigint, disabled_policy jsonb, disabled_version bigint,
 admission_evidence_sha256 text, resumed_version bigint,
 created_at timestamptz not null default clock_timestamp(), primary key(node_id,revision)
);
create unique index qorpera_node_update_one_pending on public.qorpera_node_update_targets(node_id) where resumed_version is null;
create table public.qorpera_node_update_phase_intents (
 node_id uuid not null, revision bigint not null, phase_index smallint not null check(phase_index between 1 and 8),
 intent_text text not null check(octet_length(intent_text) between 1 and 16384),
 prepared_at timestamptz not null default clock_timestamp(), primary key(node_id,revision,phase_index),
 foreign key(node_id,revision) references public.qorpera_node_update_targets(node_id,revision) on delete restrict
);
create table public.qorpera_node_update_phase_receipts (
 node_id uuid not null, revision bigint not null, phase_index smallint not null check(phase_index between 1 and 8),
 intent_text text not null check(octet_length(intent_text) between 1 and 16384),
 receipt_text text not null check(octet_length(receipt_text) between 1 and 16384),
 recorded_at timestamptz not null default clock_timestamp(), primary key(node_id,revision,phase_index),
 foreign key(node_id,revision) references public.qorpera_node_update_targets(node_id,revision) on delete restrict
);

-- JSON canonicalization for the closed ASCII-key release/intent/receipt schema;
-- strings retain JSON escaping and arrays retain their signed order.
create function public.qorpera_node_update_canonical(p_value jsonb)
returns text language sql immutable strict set search_path='' as $$
 select case jsonb_typeof(p_value)
 when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||public.qorpera_node_update_canonical(value),',' order by key collate "C") from jsonb_each(p_value)),'')||'}'
 when 'array' then '['||coalesce((select string_agg(public.qorpera_node_update_canonical(value),',' order by ordinality) from jsonb_array_elements(p_value) with ordinality),'')||']'
 else p_value::text end
$$;
create function public.qorpera_node_update_sha(p_value jsonb)
returns text language sql immutable strict set search_path='' as $$
 select encode(extensions.digest(public.qorpera_node_update_canonical(p_value),'sha256'),'hex')
$$;
create function public.qorpera_node_update_operator()
returns void language plpgsql set search_path='' as $$
begin
 -- SECURITY DEFINER current_user and arbitrary JWT claims are not operator proof.
 if session_user<>'postgres' or current_setting('role',true) not in ('none','postgres') then
  raise exception 'Direct postgres node update operator required' using errcode='42501'; end if;
end $$;

create function public.qorpera_enroll_node_updater(p_node_id uuid,p_capability_sha256 text,p_expected_capability_revision bigint,
 p_enabled boolean,p_baseline_revision bigint,p_baseline_release_sha256 text,p_baseline_artifact_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.qorpera_node_update_enrollments%rowtype;
begin
 perform public.qorpera_node_update_operator();
 if p_node_id is null or p_expected_capability_revision is null or p_expected_capability_revision not between 0 and 9007199254740989
  or p_enabled is null or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$'
  or p_baseline_revision is null or p_baseline_revision not between 0 and 9007199254740989
  or coalesce(p_baseline_release_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_baseline_artifact_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid node updater enrollment' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||p_node_id::text,0));
 perform 1 from public.qorpera_runtime_nodes where id=p_node_id for update;
 if not found then raise exception 'Node unavailable' using errcode='42501'; end if;
 select * into e from public.qorpera_node_update_enrollments where node_id=p_node_id for update;
 if coalesce(e.capability_revision,0)<>p_expected_capability_revision then raise exception 'Capability version changed' using errcode='40001'; end if;
 if e.node_id is not null and (e.current_revision<>p_baseline_revision or e.current_release_sha256<>p_baseline_release_sha256 or e.current_artifact_sha256<>p_baseline_artifact_sha256) then
  raise exception 'Enrolled predecessor is immutable' using errcode='42501'; end if;
 insert into public.qorpera_node_update_enrollments values(p_node_id,p_expected_capability_revision+1,p_capability_sha256,p_enabled,p_baseline_revision,p_baseline_release_sha256,p_baseline_artifact_sha256)
 on conflict(node_id) do update set capability_revision=excluded.capability_revision,capability_sha256=excluded.capability_sha256,enabled=excluded.enabled;
 return jsonb_build_object('nodeId',p_node_id,'capabilityRevision',p_expected_capability_revision+1);
end $$;

create function public.qorpera_publish_node_update(p_release_text text,p_signature text,p_company_ids uuid[],p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; n public.qorpera_runtime_nodes%rowtype; e public.qorpera_node_update_enrollments%rowtype; v_sha text; v_id uuid;
begin
 perform public.qorpera_node_update_operator();
 if p_release_text is null or octet_length(p_release_text) not between 1 and 16384 or coalesce(p_signature,'') !~ '^[A-Za-z0-9+/]{86}==$'
  or coalesce(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' or p_company_ids is null or cardinality(p_company_ids) not between 1 and 100
  or array_position(p_company_ids,null) is not null or (select count(distinct x) from unnest(p_company_ids) x)<>cardinality(p_company_ids) then
  raise exception 'Invalid desired node release' using errcode='22023'; end if;
 r:=p_release_text::jsonb;
 perform public.qorpera_office_software_object(r,array['schema','nodeId','machineIdSha256','revision','previous','artifact','runtimeBundleSha256','sourceCommit','acceptanceEvidenceSha256']);
 perform public.qorpera_office_software_object(r->'previous',array['revision','releaseSha256','artifactSha256']);
 perform public.qorpera_office_software_object(r->'artifact',array['bytes','sha256']);
 if r->>'schema' is distinct from 'qorpera.runtime-node-update-release/v1' or public.qorpera_node_update_canonical(r)<>p_release_text
  or coalesce(r->>'sourceCommit','') !~ '^[0-9a-f]{40}$'
  or exists(select 1 from unnest(array[r->>'machineIdSha256',r->>'runtimeBundleSha256',r->>'acceptanceEvidenceSha256',r#>>'{previous,releaseSha256}',r#>>'{previous,artifactSha256}',r#>>'{artifact,sha256}']) x where x is null or x !~ '^[0-9a-f]{64}$')
  or jsonb_typeof(r->'revision') is distinct from 'number' or coalesce(r->>'revision','') !~ '^[1-9][0-9]*$'
  or jsonb_typeof(r#>'{previous,revision}') is distinct from 'number' or coalesce(r#>>'{previous,revision}','') !~ '^(0|[1-9][0-9]*)$'
  or jsonb_typeof(r#>'{artifact,bytes}') is distinct from 'number' or coalesce(r#>>'{artifact,bytes}','') !~ '^[1-9][0-9]*$'
  or (r->>'revision')::bigint not between 1 and 9007199254740990 or (r#>>'{artifact,bytes}')::bigint not between 1 and 67108864
  or (r->>'revision')::bigint<>(r#>>'{previous,revision}')::bigint+1 then
  raise exception 'Invalid signed release payload' using errcode='22023'; end if;
 v_id:=(r->>'nodeId')::uuid; v_sha:=public.qorpera_node_update_sha(r);
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||v_id::text,0));
 select * into n from public.qorpera_runtime_nodes where id=v_id for update;
 select * into e from public.qorpera_node_update_enrollments where node_id=v_id for update;
 if n.id is null or e.node_id is null or not e.enabled or n.machine_id_sha256<>r->>'machineIdSha256'
  or e.current_revision<>(r#>>'{previous,revision}')::bigint or e.current_release_sha256<>r#>>'{previous,releaseSha256}' or e.current_artifact_sha256<>r#>>'{previous,artifactSha256}'
  or exists(select 1 from unnest(p_company_ids) x where not exists(select 1 from public.qorpera_profiles where id=x)) then
  raise exception 'Desired release predecessor or scope differs' using errcode='42501'; end if;
 -- A successor cannot hide an incomplete predecessor publication. Even after
 -- publication, its immutable receipt remains readable across a lost reply.
 if exists(select 1 from public.qorpera_node_update_targets t where t.node_id=v_id and
  (t.resumed_version is null or not exists(select 1 from public.qorpera_node_update_phase_receipts p where p.node_id=t.node_id and p.revision=t.revision and p.phase_index=8 and p.receipt_text::jsonb->>'state'='succeeded'))) then
  raise exception 'Previous node update publication incomplete' using errcode='42501'; end if;
 insert into public.qorpera_node_update_targets(node_id,revision,release_sha256,release_text,signature,publication_evidence_sha256,company_ids)
 values(v_id,(r->>'revision')::bigint,v_sha,p_release_text,p_signature,p_evidence_sha256,p_company_ids);
 return jsonb_build_object('nodeId',v_id,'releaseSha256',v_sha);
end $$;

-- Capability authentication never accepts the stored digest as the token.
-- Lock order: company fences -> node advisory/row -> capability -> target.
create function public.qorpera_node_update_locked(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text)
returns public.qorpera_node_update_targets language plpgsql security definer set search_path='' as $$
declare e public.qorpera_node_update_enrollments%rowtype; t public.qorpera_node_update_targets%rowtype; v_company uuid;
begin
 if p_capability is null or p_capability !~ '^[0-9a-f]{64}$' or p_capability_revision is null then raise exception 'Node capability required' using errcode='42501'; end if;
 select * into e from public.qorpera_node_update_enrollments where node_id=p_node_id;
 if not found or not e.enabled or e.capability_revision<>p_capability_revision or e.capability_sha256<>encode(extensions.digest(p_capability,'sha256'),'hex') then
  raise exception 'Node capability unavailable' using errcode='42501'; end if;
 select * into t from public.qorpera_node_update_targets where node_id=p_node_id and release_sha256=p_release_sha256;
 if not found then raise exception 'Desired node release unavailable' using errcode='42501'; end if;
 for v_company in select x from unnest(t.company_ids) x order by x loop perform public.qorpera_lock_profile_gc_fence(v_company); end loop;
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||p_node_id::text,0));
 perform 1 from public.qorpera_runtime_nodes where id=p_node_id for update;
 select * into strict e from public.qorpera_node_update_enrollments where node_id=p_node_id for share;
 select * into strict t from public.qorpera_node_update_targets where node_id=p_node_id and revision=t.revision for update;
 if not e.enabled or e.capability_revision<>p_capability_revision or e.capability_sha256<>encode(extensions.digest(p_capability,'sha256'),'hex')
  or (t.resumed_version is null and exists(select 1 from public.qorpera_node_update_targets where node_id=p_node_id and revision>t.revision))
  or (t.resumed_version is null and (e.current_revision<>(t.release_text::jsonb#>>'{previous,revision}')::bigint or e.current_release_sha256<>t.release_text::jsonb#>>'{previous,releaseSha256}' or e.current_artifact_sha256<>t.release_text::jsonb#>>'{previous,artifactSha256}')) then
  raise exception 'Node update authority changed' using errcode='42501'; end if;
 return t;
end $$;

create function public.qorpera_desired_node_update(p_node_id uuid,p_capability_revision bigint,p_capability text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.qorpera_node_update_enrollments%rowtype; v_sha text;
begin
 if p_capability is null or p_capability !~ '^[0-9a-f]{64}$' or p_capability_revision is null then raise exception 'Node capability required' using errcode='42501'; end if;
 select * into e from public.qorpera_node_update_enrollments where node_id=p_node_id;
 if not found or not e.enabled or e.capability_revision<>p_capability_revision or e.capability_sha256<>encode(extensions.digest(p_capability,'sha256'),'hex') then
  raise exception 'Node capability unavailable' using errcode='42501'; end if;
 select release_sha256 into v_sha from public.qorpera_node_update_targets where node_id=p_node_id order by revision desc limit 1;
 if not found then return null; end if;
 return public.qorpera_read_node_update(p_node_id,p_capability_revision,p_capability,v_sha);
end $$;

create function public.qorpera_node_update_pause_proof(p_company_ids uuid[])
returns jsonb language sql stable security definer set search_path='' as $$
 select case when count(*)=cardinality(p_company_ids) then jsonb_agg(jsonb_build_object('profileId',profile_id,'pausedAt',paused_at,'pausedByUserId',paused_by_user_id) order by profile_id) else null end
 from public.qorpera_company_execution_pauses where profile_id=any(p_company_ids)
$$;
create function public.qorpera_authorize_node_update_drain(p_node_id uuid,p_release_sha256 text,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; v_company uuid; v_proof jsonb;
begin
 perform public.qorpera_node_update_operator();
 if coalesce(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Drain evidence required' using errcode='22023'; end if;
 select * into t from public.qorpera_node_update_targets where node_id=p_node_id and release_sha256=p_release_sha256;
 if not found then raise exception 'Target unavailable' using errcode='42501'; end if;
 for v_company in select x from unnest(t.company_ids) x order by x loop perform public.qorpera_lock_profile_gc_fence(v_company); end loop;
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||p_node_id::text,0));
 perform 1 from public.qorpera_runtime_nodes where id=p_node_id for update;
 select * into strict t from public.qorpera_node_update_targets where node_id=p_node_id and revision=t.revision for update;
 v_proof:=public.qorpera_node_update_pause_proof(t.company_ids);
 if v_proof is null or t.drain_authorization_sha256 is not null or t.resumed_version is not null then raise exception 'Drain authorization unavailable' using errcode='42501'; end if;
 update public.qorpera_node_update_targets set pause_proof=v_proof,drain_authorization_sha256=p_evidence_sha256 where node_id=p_node_id and revision=t.revision;
 return jsonb_build_object('nodeId',p_node_id,'releaseSha256',p_release_sha256,'evidenceSha256',p_evidence_sha256);
end $$;

create function public.qorpera_node_update_assert_hold(t public.qorpera_node_update_targets,p_quiet boolean)
returns void language plpgsql security definer set search_path='' as $$
declare n public.qorpera_runtime_nodes%rowtype; v_policy jsonb;
begin
 select * into strict n from public.qorpera_runtime_nodes where id=t.node_id;
 select policy into strict v_policy from public.qorpera_runtime_node_policies where node_id=t.node_id and version=n.version;
 if t.drain_authorization_sha256 is null or t.pause_proof is distinct from public.qorpera_node_update_pause_proof(t.company_ids)
  or t.disabled_version is null or n.version<>t.disabled_version or n.enabled or v_policy<>t.disabled_policy or t.resumed_version is not null then
  raise exception 'Owned node drain or company pause changed' using errcode='42501'; end if;
 -- Persistent offices retain allocations while powered off; physical stop proof
 -- is required by the protected adapter. Ephemeral jobs/logins must be released.
 if exists(select 1 from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=t.node_id and d.reserved_at is not null and d.released_at is null and (not(a.profile_id=any(t.company_ids)) or (p_quiet and a.office_id is null))) then
  raise exception 'Node allocation drain remains incomplete' using errcode='55000'; end if;
end $$;

create function public.qorpera_read_node_update(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; n public.qorpera_runtime_nodes%rowtype; v_policy jsonb; v_bundle text;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 select * into strict n from public.qorpera_runtime_nodes where id=p_node_id;
 select policy into strict v_policy from public.qorpera_runtime_node_policies where node_id=p_node_id and version=n.version;
 select runtime_bundle_sha256 into strict v_bundle from public.qorpera_active_runtime_bundle;
 return jsonb_build_object('schema','qorpera.node-update-state/v1','envelope',jsonb_build_object('release',t.release_text::jsonb,'signature',t.signature),
  'observation',jsonb_build_object('nodeId',p_node_id,'machineIdSha256',n.machine_id_sha256,'desiredReleaseSha256',t.release_sha256,'activeRuntimeBundleSha256',v_bundle,
   'admissionReleaseSha256',case when t.admission_evidence_sha256 is not null then t.release_sha256 end,'admissionEvidenceSha256',t.admission_evidence_sha256,
   'policyVersion',n.version,'policySha256',public.qorpera_node_update_sha(v_policy),'enabled',n.enabled),
  'drain',case when t.disabled_version is not null then jsonb_build_object('policySha256',public.qorpera_node_update_sha(t.original_policy),'disabledPolicySha256',public.qorpera_node_update_sha(t.disabled_policy),
   'previousVersion',t.original_version,'disabledVersion',t.disabled_version,'previousEnabled',(t.original_policy->>'enabled')::boolean) end,
  'resumedVersion',t.resumed_version,
  'intents',coalesce((select jsonb_agg(intent_text::jsonb order by phase_index) from public.qorpera_node_update_phase_intents where node_id=p_node_id and revision=t.revision),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object('intent',intent_text::jsonb,'receipt',receipt_text::jsonb) order by phase_index) from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision),'[]'::jsonb));
end $$;

-- Retain the exact authenticated pre-effect snapshot before dispatch. A bundle
-- activation after this transaction cannot rewrite history or strand publication.
-- Preparation is not permission to ignore later policy/pause revocation: effect
-- RPCs and physical adapters still recheck the exact owned hold at dispatch.
create function public.qorpera_prepare_node_update_phase(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text,p_intent_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; i jsonb; v_phase smallint; v_previous text; v_existing text; s jsonb;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 if p_intent_text is null or octet_length(p_intent_text) not between 1 and 16384 then raise exception 'Phase intent invalid' using errcode='22023'; end if;
 i:=p_intent_text::jsonb;
 perform public.qorpera_office_software_object(i,array['schema','releaseSha256','phase','previousReceiptSha256','observation']);
 perform public.qorpera_office_software_object(i->'observation',array['nodeId','machineIdSha256','desiredReleaseSha256','activeRuntimeBundleSha256','admissionReleaseSha256','admissionEvidenceSha256','policyVersion','policySha256','enabled']);
 v_phase:=array_position(array['stage','drain','stop','install','start','verify','acknowledge','resume'],i->>'phase');
 if v_phase is null or i->>'schema' is distinct from 'qorpera.runtime-node-update-intent/v1' or i->>'releaseSha256' is distinct from t.release_sha256
  or public.qorpera_node_update_canonical(i)<>p_intent_text then raise exception 'Phase intent binding differs' using errcode='42501'; end if;
 select intent_text into v_existing from public.qorpera_node_update_phase_intents where node_id=p_node_id and revision=t.revision and phase_index=v_phase;
 if found then
  if v_existing<>p_intent_text then raise exception 'Immutable phase intent differs' using errcode='42501'; end if;
  return jsonb_build_object('phase',i->>'phase','intentSha256',public.qorpera_node_update_sha(i));
 end if;
 s:=public.qorpera_read_node_update(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 if i->'observation' is distinct from s->'observation' or t.resumed_version is not null then raise exception 'Pre-effect observation differs' using errcode='42501'; end if;
 if v_phase=1 then
  if i->'previousReceiptSha256'<>'null'::jsonb or t.disabled_version is not null then raise exception 'Stage predecessor differs' using errcode='42501'; end if;
 else
  select public.qorpera_node_update_sha(receipt_text::jsonb) into v_previous from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=v_phase-1 and receipt_text::jsonb->>'state'='succeeded';
  if not found or v_previous is distinct from i->>'previousReceiptSha256' then raise exception 'Phase predecessor unavailable' using errcode='42501'; end if;
 end if;
 if v_phase=2 and (t.disabled_version is not null or t.drain_authorization_sha256 is null or t.pause_proof is distinct from public.qorpera_node_update_pause_proof(t.company_ids)) then
  raise exception 'Drain preparation requires coordinator pause' using errcode='42501'; end if;
 if v_phase>=3 then perform public.qorpera_node_update_assert_hold(t,true); end if;
 if v_phase=8 and (t.admission_evidence_sha256 is null or s#>>'{observation,activeRuntimeBundleSha256}'<>t.release_text::jsonb->>'runtimeBundleSha256') then
  raise exception 'Coordinator admission release required' using errcode='42501'; end if;
 insert into public.qorpera_node_update_phase_intents values(p_node_id,t.revision,v_phase,p_intent_text,clock_timestamp());
 return jsonb_build_object('phase',i->>'phase','intentSha256',public.qorpera_node_update_sha(i));
end $$;

create function public.qorpera_drain_node_update(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text,p_expected_version bigint,p_expected_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; n public.qorpera_runtime_nodes%rowtype; v_policy jsonb; v_disabled jsonb;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 select * into strict n from public.qorpera_runtime_nodes where id=p_node_id;
 select policy into strict v_policy from public.qorpera_runtime_node_policies where node_id=p_node_id and version=n.version;
 if t.disabled_version is not null or t.resumed_version is not null or n.version is distinct from p_expected_version or public.qorpera_node_update_sha(v_policy) is distinct from p_expected_policy_sha256
  or n.version>=9007199254740990 or t.drain_authorization_sha256 is null or t.pause_proof is distinct from public.qorpera_node_update_pause_proof(t.company_ids)
  or exists(select 1 from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=2)
  or not exists(select 1 from public.qorpera_node_update_phase_intents where node_id=p_node_id and revision=t.revision and phase_index=2
   and intent_text::jsonb#>>'{observation,policyVersion}'=p_expected_version::text and intent_text::jsonb#>>'{observation,policySha256}'=p_expected_policy_sha256)
  or not exists(select 1 from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=1 and receipt_text::jsonb->>'state'='succeeded') then
  raise exception 'Node update drain authority differs' using errcode='42501'; end if;
 if exists(select 1 from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null and not(a.profile_id=any(t.company_ids))) then
  raise exception 'Unpaused company occupies node' using errcode='55000'; end if;
 v_disabled:=jsonb_set(v_policy,'{enabled}','false'::jsonb);
 -- Same lock/version/history semantics as configure_runtime_node, closed to
 -- enabled-only changes. No spoofed service-role claims or general policy grant.
 update public.qorpera_runtime_nodes set enabled=false,version=n.version+1,updated_at=clock_timestamp() where id=p_node_id;
 insert into public.qorpera_runtime_node_policies values(p_node_id,n.version+1,v_disabled,clock_timestamp());
 update public.qorpera_node_update_targets set original_policy=v_policy,original_version=n.version,disabled_policy=v_disabled,disabled_version=n.version+1 where node_id=p_node_id and revision=t.revision;
 return jsonb_build_object('policySha256',public.qorpera_node_update_sha(v_policy),'disabledPolicySha256',public.qorpera_node_update_sha(v_disabled),'previousVersion',n.version,'disabledVersion',n.version+1,'previousEnabled',n.enabled);
end $$;

create function public.qorpera_check_node_update(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text,p_intent_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 perform public.qorpera_node_update_assert_hold(t,true);
 if not exists(select 1 from public.qorpera_node_update_phase_intents i where i.node_id=p_node_id and i.revision=t.revision and i.phase_index between 3 and 7
  and public.qorpera_node_update_sha(i.intent_text::jsonb)=p_intent_sha256 and not exists(select 1 from public.qorpera_node_update_phase_receipts r where r.node_id=i.node_id and r.revision=i.revision and r.phase_index=i.phase_index)) then
  raise exception 'Prepared physical phase unavailable' using errcode='42501'; end if;
 return jsonb_build_object('nodeId',p_node_id,'releaseSha256',p_release_sha256,'disabledVersion',t.disabled_version,'drainAuthorizationSha256',t.drain_authorization_sha256);
end $$;

create function public.qorpera_record_node_update_phase(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text,p_intent_text text,p_receipt_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; i jsonb; r jsonb; v_phase smallint; v_previous text; v_existing public.qorpera_node_update_phase_receipts%rowtype; v_drain jsonb; v_policy jsonb; v_version bigint;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 if p_intent_text is null or p_receipt_text is null or octet_length(p_intent_text) not between 1 and 16384 or octet_length(p_receipt_text) not between 1 and 16384 then raise exception 'Phase payload invalid' using errcode='22023'; end if;
 i:=p_intent_text::jsonb; r:=p_receipt_text::jsonb;
 perform public.qorpera_office_software_object(i,array['schema','releaseSha256','phase','previousReceiptSha256','observation']);
 perform public.qorpera_office_software_object(r,array['schema','intentSha256','state','evidenceSha256','drain']);
 perform public.qorpera_office_software_object(i->'observation',array['nodeId','machineIdSha256','desiredReleaseSha256','activeRuntimeBundleSha256','admissionReleaseSha256','admissionEvidenceSha256','policyVersion','policySha256','enabled']);
 v_phase:=array_position(array['stage','drain','stop','install','start','verify','acknowledge','resume'],i->>'phase');
 if v_phase is null or i->>'schema' is distinct from 'qorpera.runtime-node-update-intent/v1' or i->>'releaseSha256' is distinct from t.release_sha256
  or r->>'schema' is distinct from 'qorpera.runtime-node-update-receipt/v1' or r->>'intentSha256' is distinct from public.qorpera_node_update_sha(i) or coalesce(r->>'state','') not in ('succeeded','failed')
  or coalesce(r->>'evidenceSha256','') !~ '^[0-9a-f]{64}$' or public.qorpera_node_update_canonical(i)<>p_intent_text or public.qorpera_node_update_canonical(r)<>p_receipt_text
  or i#>>'{observation,nodeId}' is distinct from p_node_id::text or i#>>'{observation,desiredReleaseSha256}' is distinct from t.release_sha256
  or i#>>'{observation,machineIdSha256}' is distinct from t.release_text::jsonb->>'machineIdSha256' then raise exception 'Phase binding differs' using errcode='42501'; end if;
 select * into v_existing from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=v_phase;
 if found then
  if v_existing.intent_text<>p_intent_text or v_existing.receipt_text<>p_receipt_text then raise exception 'Immutable phase receipt differs' using errcode='42501'; end if;
  return jsonb_build_object('phase',i->>'phase','receiptSha256',public.qorpera_node_update_sha(r));
 end if;
 if not exists(select 1 from public.qorpera_node_update_phase_intents where node_id=p_node_id and revision=t.revision and phase_index=v_phase and intent_text=p_intent_text) then
  raise exception 'Exact retained pre-effect intent required' using errcode='42501'; end if;
 if v_phase=1 or (v_phase=2 and r->>'state'='failed' and t.disabled_version is null) then
  select n.version,p.policy into strict v_version,v_policy from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_policies p on p.node_id=n.id and p.version=n.version where n.id=p_node_id;
  v_drain:='null'::jsonb;
 else
  v_policy:=case when v_phase=2 then t.original_policy else t.disabled_policy end;
  v_version:=case when v_phase=2 then t.original_version else t.disabled_version end;
  v_drain:=jsonb_build_object('policySha256',public.qorpera_node_update_sha(t.original_policy),'disabledPolicySha256',public.qorpera_node_update_sha(t.disabled_policy),
   'previousVersion',t.original_version,'disabledVersion',t.disabled_version,'previousEnabled',(t.original_policy->>'enabled')::boolean);
 end if;
 if r->'drain' is distinct from v_drain or i#>>'{observation,policyVersion}' is distinct from v_version::text
  or i#>>'{observation,policySha256}' is distinct from public.qorpera_node_update_sha(v_policy) or i#>'{observation,enabled}' is distinct from v_policy->'enabled' then
  raise exception 'Phase admission binding differs' using errcode='42501'; end if;
 if v_phase=1 then
  if i->'previousReceiptSha256'<>'null'::jsonb or t.disabled_version is not null then raise exception 'Stage predecessor differs' using errcode='42501'; end if;
 else
  select public.qorpera_node_update_sha(receipt_text::jsonb) into v_previous from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=v_phase-1 and receipt_text::jsonb->>'state'='succeeded';
  if not found or v_previous is distinct from i->>'previousReceiptSha256' then raise exception 'Phase predecessor unavailable' using errcode='42501'; end if;
 end if;
 if v_phase between 2 and 7 and not(v_phase=2 and r->>'state'='failed' and t.disabled_version is null) then perform public.qorpera_node_update_assert_hold(t,v_phase>=3); end if;
 if v_phase=8 and (t.resumed_version is null or t.admission_evidence_sha256 is null) then raise exception 'Admission not restored' using errcode='42501'; end if;
 insert into public.qorpera_node_update_phase_receipts values(p_node_id,t.revision,v_phase,p_intent_text,p_receipt_text,clock_timestamp());
 return jsonb_build_object('phase',i->>'phase','receiptSha256',public.qorpera_node_update_sha(r));
end $$;

create function public.qorpera_release_node_update_admission(p_node_id uuid,p_release_sha256 text,p_expected_capability_revision bigint,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; v_company uuid; v_bundle text;
begin
 perform public.qorpera_node_update_operator();
 if coalesce(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Coordinator evidence required' using errcode='22023'; end if;
 select * into t from public.qorpera_node_update_targets where node_id=p_node_id and release_sha256=p_release_sha256;
 if not found then raise exception 'Target unavailable' using errcode='42501'; end if;
 for v_company in select x from unnest(t.company_ids) x order by x loop perform public.qorpera_lock_profile_gc_fence(v_company); end loop;
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||p_node_id::text,0));
 perform 1 from public.qorpera_runtime_nodes where id=p_node_id for update;
 perform 1 from public.qorpera_node_update_enrollments where node_id=p_node_id and enabled and capability_revision=p_expected_capability_revision for share;
 if not found then raise exception 'Capability enrollment changed' using errcode='42501'; end if;
 select * into strict t from public.qorpera_node_update_targets where node_id=p_node_id and revision=t.revision for update;
 perform public.qorpera_node_update_assert_hold(t,true);
 select runtime_bundle_sha256 into strict v_bundle from public.qorpera_active_runtime_bundle for share;
 if v_bundle<>t.release_text::jsonb->>'runtimeBundleSha256' or t.admission_evidence_sha256 is not null
  or exists(select 1 from public.qorpera_node_update_phase_intents i where i.node_id=p_node_id and i.revision=t.revision and not exists(select 1 from public.qorpera_node_update_phase_receipts r where r.node_id=i.node_id and r.revision=i.revision and r.phase_index=i.phase_index))
  or not exists(select 1 from public.qorpera_node_update_phase_receipts where node_id=p_node_id and revision=t.revision and phase_index=7 and receipt_text::jsonb->>'state'='succeeded') then
  raise exception 'Installed node or target runtime not ready' using errcode='42501'; end if;
 update public.qorpera_node_update_targets set admission_evidence_sha256=p_evidence_sha256 where node_id=p_node_id and revision=t.revision;
 return jsonb_build_object('nodeId',p_node_id,'releaseSha256',p_release_sha256,'evidenceSha256',p_evidence_sha256);
end $$;

create function public.qorpera_resume_node_update(p_node_id uuid,p_capability_revision bigint,p_capability text,p_release_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.qorpera_node_update_targets%rowtype; v_bundle text;
begin
 t:=public.qorpera_node_update_locked(p_node_id,p_capability_revision,p_capability,p_release_sha256);
 perform public.qorpera_node_update_assert_hold(t,true);
 select runtime_bundle_sha256 into strict v_bundle from public.qorpera_active_runtime_bundle for share;
 if t.admission_evidence_sha256 is null or v_bundle<>t.release_text::jsonb->>'runtimeBundleSha256' or t.disabled_version>=9007199254740990 then
  raise exception 'Coordinator admission release required' using errcode='42501'; end if;
 if not exists(select 1 from public.qorpera_node_update_phase_intents where node_id=p_node_id and revision=t.revision and phase_index=8
  and intent_text::jsonb#>>'{observation,admissionReleaseSha256}'=t.release_sha256 and intent_text::jsonb#>>'{observation,admissionEvidenceSha256}'=t.admission_evidence_sha256
  and intent_text::jsonb#>>'{observation,policyVersion}'=t.disabled_version::text and intent_text::jsonb#>>'{observation,policySha256}'=public.qorpera_node_update_sha(t.disabled_policy)) then
  raise exception 'Prepared admission intent required' using errcode='42501'; end if;
 update public.qorpera_runtime_nodes set enabled=(t.original_policy->>'enabled')::boolean,version=t.disabled_version+1,updated_at=clock_timestamp() where id=p_node_id;
 insert into public.qorpera_runtime_node_policies values(p_node_id,t.disabled_version+1,t.original_policy,clock_timestamp());
 update public.qorpera_node_update_targets set resumed_version=t.disabled_version+1 where node_id=p_node_id and revision=t.revision;
 update public.qorpera_node_update_enrollments set current_revision=t.revision,current_release_sha256=t.release_sha256,current_artifact_sha256=t.release_text::jsonb#>>'{artifact,sha256}' where node_id=p_node_id;
 return jsonb_build_object('nodeId',p_node_id,'releaseSha256',p_release_sha256,'version',t.disabled_version+1,'enabled',(t.original_policy->>'enabled')::boolean);
end $$;

do $$ declare t text; f record; begin
 foreach t in array array['qorpera_node_update_enrollments','qorpera_node_update_targets','qorpera_node_update_phase_intents','qorpera_node_update_phase_receipts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array[
  'qorpera_node_update_canonical','qorpera_node_update_sha','qorpera_node_update_operator','qorpera_enroll_node_updater','qorpera_publish_node_update',
  'qorpera_node_update_locked','qorpera_desired_node_update','qorpera_node_update_pause_proof','qorpera_authorize_node_update_drain','qorpera_node_update_assert_hold',
  'qorpera_read_node_update','qorpera_prepare_node_update_phase','qorpera_drain_node_update','qorpera_check_node_update','qorpera_record_node_update_phase','qorpera_release_node_update_admission','qorpera_resume_node_update']) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
-- Public project key plus separate node capability; no broad service key.
grant execute on function public.qorpera_desired_node_update(uuid,bigint,text), public.qorpera_read_node_update(uuid,bigint,text,text), public.qorpera_drain_node_update(uuid,bigint,text,text,bigint,text),
 public.qorpera_prepare_node_update_phase(uuid,bigint,text,text,text), public.qorpera_check_node_update(uuid,bigint,text,text,text), public.qorpera_record_node_update_phase(uuid,bigint,text,text,text,text),
 public.qorpera_resume_node_update(uuid,bigint,text,text) to anon,authenticated,service_role;
