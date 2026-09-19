-- Managed-auth ownership protects rotating credentials for the official client
-- lifetime. Same-capsule concurrency stays closed until a supported owner adapter
-- is pinned; independent capsules do not share this ownership record.
-- An interrupted refresh intent NEVER expires into permission to refresh again.
create table public.qorpera_native_credential_generations (
 capsule_id uuid primary key references public.qorpera_native_credential_capsules(id) on delete cascade,
 generation bigint not null default 0 check(generation between 0 and 9007199254740990),
 reference text not null,
 ciphertext_sha256 text check(ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
 state text not null default 'ready' check(state in ('ready','refreshing','recovery-required')),
 owner_id uuid,
 owner_token_sha256 text check(owner_token_sha256 ~ '^[0-9a-f]{64}$'),
 owner_identity_epoch bigint,
 candidate_reference text,
 updated_at timestamptz not null default statement_timestamp(),
 check((generation=0) or ciphertext_sha256 is not null),
 check((state='ready' and owner_id is null and owner_token_sha256 is null and owner_identity_epoch is null and candidate_reference is null)
  or (state<>'ready' and owner_id is not null and owner_token_sha256 is not null and owner_identity_epoch is not null and candidate_reference is not null))
);
alter table public.qorpera_native_credential_generations enable row level security;
revoke all on public.qorpera_native_credential_generations from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_native_credential_generation_json(p_row public.qorpera_native_credential_generations)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('schema','qorpera.native-credential-generation/v1','capsuleId',p_row.capsule_id,
  'generation',p_row.generation,'reference',p_row.reference,'ciphertextSha256',p_row.ciphertext_sha256,
  'state',p_row.state,'ownerId',p_row.owner_id)
$$;

-- This receipt is an operator attestation, never SQL proof that an offline
-- native process stopped. The operator must physically drain old hosts first.
create table public.qorpera_native_credential_adoptions (
 capsule_id uuid not null references public.qorpera_native_credential_capsules(id) on delete restrict,
 compute_identity_epoch bigint not null check(compute_identity_epoch between 0 and 9007199254740991),
 runtime_bundle_id uuid not null,
 runtime_bundle_sha256 text not null,
 physical_drain_evidence_sha256 text not null check(physical_drain_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 adopted_at timestamptz not null default statement_timestamp(),
 primary key(capsule_id,compute_identity_epoch,runtime_bundle_sha256),
 foreign key(runtime_bundle_id,runtime_bundle_sha256) references public.qorpera_runtime_bundles(id,sha256) on delete restrict
);
alter table public.qorpera_native_credential_adoptions enable row level security;
revoke all on public.qorpera_native_credential_adoptions from public,anon,authenticated,service_role,qorpera_secret_broker;
create function public.qorpera_reject_native_credential_adoption_mutation()
returns trigger language plpgsql security definer set search_path='' as $$
begin raise exception 'Native credential adoption evidence is immutable' using errcode='42501'; end $$;
create trigger qorpera_native_credential_adoption_immutable before update or delete
on public.qorpera_native_credential_adoptions for each row execute function public.qorpera_reject_native_credential_adoption_mutation();

create function public.qorpera_adopt_native_credential_generations(p_capsule_id uuid,p_compute_identity_epoch bigint,
 p_runtime_bundle_sha256 text,p_physical_drain_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_capsule public.qorpera_native_credential_capsules%rowtype; v_identity public.qorpera_member_compute_identities%rowtype;
 v_bundle public.qorpera_active_runtime_bundle%rowtype; v_manifest jsonb; v_evidence text; v_profile uuid;
begin
 if auth.role() is distinct from 'service_role' or p_capsule_id is null or p_compute_identity_epoch is null
  or p_compute_identity_epoch<0 or p_runtime_bundle_sha256 is null or p_runtime_bundle_sha256!~'^[0-9a-f]{64}$'
  or p_physical_drain_evidence_sha256 is null or p_physical_drain_evidence_sha256!~'^[0-9a-f]{64}$' then
  raise exception 'Native credential adoption evidence is required' using errcode='42501'; end if;
 select profile_id into v_profile from public.qorpera_native_credential_capsules where id=p_capsule_id;
 if v_profile is null then raise exception 'Native credential adoption unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_profile);
 select identity.* into strict v_identity from public.qorpera_member_compute_identities identity
  join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id=identity.id
  where capsule.id=p_capsule_id for update of identity;
 select * into strict v_capsule from public.qorpera_native_credential_capsules where id=p_capsule_id for update;
 select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton for share;
 select manifest into strict v_manifest from public.qorpera_runtime_bundles where id=v_bundle.runtime_bundle_id;
 if v_capsule.status<>'active' or v_capsule.provider<>'openai' or v_capsule.native_harness<>'codex-cli'
  or v_identity.status<>'active' or v_identity.recovery_pending_id is not null
  or v_identity.recovery_epoch<>p_compute_identity_epoch or v_bundle.runtime_bundle_sha256<>p_runtime_bundle_sha256
  or not coalesce(v_manifest->'implementation' ?& array['packages/runtime/src/cloud-native-credential-owner.ts','packages/runtime/src/cloud-native-process-settlement.ts'],false) then
  raise exception 'Native credential adoption identity or supported runtime differs' using errcode='42501'; end if;
 -- Even an expired ACTIVE record must be explicitly revoked after physical
 -- drain. Lease expiry alone is never accepted as proof a refresh writer died.
 if exists(select 1 from public.qorpera_native_provider_connection_leases where credential_capsule_id=p_capsule_id and status='active') then
  raise exception 'Native credential adoption requires drained and revoked leases' using errcode='55000'; end if;
 insert into public.qorpera_native_credential_adoptions(capsule_id,compute_identity_epoch,runtime_bundle_id,runtime_bundle_sha256,physical_drain_evidence_sha256)
 values(p_capsule_id,p_compute_identity_epoch,v_bundle.runtime_bundle_id,p_runtime_bundle_sha256,p_physical_drain_evidence_sha256)
 on conflict(capsule_id,compute_identity_epoch,runtime_bundle_sha256) do nothing;
 select physical_drain_evidence_sha256 into strict v_evidence from public.qorpera_native_credential_adoptions
 where capsule_id=p_capsule_id and compute_identity_epoch=p_compute_identity_epoch and runtime_bundle_sha256=p_runtime_bundle_sha256;
 if v_evidence<>p_physical_drain_evidence_sha256 then raise exception 'Native credential adoption evidence already bound' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.native-credential-adoption/v1','capsuleId',p_capsule_id,
  'computeIdentityEpoch',p_compute_identity_epoch,'runtimeBundleSha256',p_runtime_bundle_sha256,'physicalDrainEvidenceSha256',v_evidence);
end $$;
revoke all on function public.qorpera_reject_native_credential_adoption_mutation() from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_adopt_native_credential_generations(uuid,bigint,text,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_adopt_native_credential_generations(uuid,bigint,text,text) to service_role;

create function public.qorpera_assert_native_credential_binding(p_binding jsonb)
returns public.qorpera_native_credential_capsules language plpgsql security definer set search_path='' as $$
declare v_authority jsonb; v_capsule public.qorpera_native_credential_capsules%rowtype; v_run public.qorpera_execution_runs%rowtype;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_binding) is distinct from 'object'
  or not(p_binding ?& array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId','computeIdentityId','provider','nativeHarness','model','computeIdentityEpoch'])
  or (p_binding-array['leaseId','runId','jobId','runnerId','assignmentId','credentialCapsuleId','computeIdentityId','provider','nativeHarness','model','computeIdentityEpoch'])<>'{}'::jsonb
  or p_binding->>'provider' is distinct from 'openai' or p_binding->>'nativeHarness' is distinct from 'codex-cli'
  or jsonb_typeof(p_binding->'computeIdentityEpoch') is distinct from 'number'
  or (p_binding->>'computeIdentityEpoch')!~'^[0-9]+$' then
  raise exception 'Native credential binding unavailable' using errcode='42501'; end if;
 v_run:=public.qorpera_native_tool_locked_run(p_binding-'computeIdentityEpoch');
 v_authority:=public.qorpera_validate_native_provider_execution_lease(
  (p_binding->>'leaseId')::uuid,(p_binding->>'runId')::uuid,(p_binding->>'jobId')::uuid,
  (p_binding->>'runnerId')::uuid,(p_binding->>'assignmentId')::uuid,(p_binding->>'credentialCapsuleId')::uuid,
  (p_binding->>'computeIdentityId')::uuid,p_binding->>'provider',p_binding->>'nativeHarness');
 if (v_authority->>'compute_identity_epoch')::bigint is distinct from (p_binding->>'computeIdentityEpoch')::bigint then
  raise exception 'Native credential identity generation differs' using errcode='42501'; end if;
 if v_run.model_id is distinct from p_binding->>'model' then
  raise exception 'Native credential model differs' using errcode='42501'; end if;
 -- The canonical validator has acquired the company/identity fence first.
 select * into strict v_capsule from public.qorpera_native_credential_capsules
  where id=(p_binding->>'credentialCapsuleId')::uuid and status='active' for share;
 if not exists(select 1 from public.qorpera_native_credential_adoptions adoption
  join public.qorpera_active_runtime_bundle active on active.singleton and active.runtime_bundle_id=adoption.runtime_bundle_id
   and active.runtime_bundle_sha256=adoption.runtime_bundle_sha256
  where adoption.capsule_id=v_capsule.id and adoption.compute_identity_epoch=(p_binding->>'computeIdentityEpoch')::bigint
   and adoption.runtime_bundle_id=v_run.runtime_bundle_id and adoption.runtime_bundle_sha256=v_run.runtime_bundle_sha256) then
  raise exception 'Native credential requires attested physical-drain adoption for this identity and runtime' using errcode='42501'; end if;
 return v_capsule;
end $$;

create function public.qorpera_read_native_credential_generation(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_capsule public.qorpera_native_credential_capsules%rowtype; v_row public.qorpera_native_credential_generations%rowtype;
begin
 v_capsule:=public.qorpera_assert_native_credential_binding(p_binding);
 if v_capsule.encrypted_capsule_reference<>'native-capsule/'||v_capsule.id::text then
  raise exception 'Native enrollment capsule reference differs' using errcode='42501'; end if;
 insert into public.qorpera_native_credential_generations(capsule_id,reference)
  values(v_capsule.id,v_capsule.encrypted_capsule_reference) on conflict(capsule_id) do nothing;
 select * into strict v_row from public.qorpera_native_credential_generations where capsule_id=v_capsule.id for share;
 return public.qorpera_native_credential_generation_json(v_row);
end $$;

create function public.qorpera_claim_native_credential_refresh(p_binding jsonb,p_expected_generation bigint,
 p_owner_id uuid,p_owner_token_sha256 text,p_candidate_reference text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.qorpera_native_credential_generations%rowtype; v_capsule uuid;
begin
 perform public.qorpera_read_native_credential_generation(p_binding);
 v_capsule:=(p_binding->>'credentialCapsuleId')::uuid;
 if p_owner_id is null or p_expected_generation is null or p_expected_generation<0
  or p_owner_token_sha256 is null or p_owner_token_sha256!~'^[0-9a-f]{64}$'
  or p_candidate_reference is distinct from 'native-capsule/'||v_capsule::text||'/generations/'||p_owner_id::text then
  raise exception 'Native refresh claim differs' using errcode='42501'; end if;
 select * into strict v_row from public.qorpera_native_credential_generations where capsule_id=v_capsule for update;
 if v_row.state<>'ready' or v_row.generation<>p_expected_generation then
  -- No idempotent success: a lost claim reply cannot authorize another upstream refresh.
  raise exception 'Native refresh already owned or generation changed' using errcode='55000'; end if;
 update public.qorpera_native_credential_generations set state='refreshing',owner_id=p_owner_id,
  owner_token_sha256=p_owner_token_sha256,owner_identity_epoch=(p_binding->>'computeIdentityEpoch')::bigint,
  candidate_reference=p_candidate_reference,updated_at=statement_timestamp()
  where capsule_id=v_capsule returning * into v_row;
 return public.qorpera_native_credential_generation_json(v_row);
end $$;

create function public.qorpera_publish_native_credential_generation(p_binding jsonb,p_expected_generation bigint,
 p_owner_id uuid,p_owner_token_sha256 text,p_candidate_reference text,p_ciphertext_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.qorpera_native_credential_generations%rowtype;
begin
 perform public.qorpera_assert_native_credential_binding(p_binding);
 if p_ciphertext_sha256 is null or p_ciphertext_sha256!~'^[0-9a-f]{64}$' or p_expected_generation is null then
  raise exception 'Native credential digest differs' using errcode='42501'; end if;
 select * into strict v_row from public.qorpera_native_credential_generations
  where capsule_id=(p_binding->>'credentialCapsuleId')::uuid for update;
 if v_row.state='ready' and v_row.generation=p_expected_generation+1 and v_row.reference=p_candidate_reference
  and v_row.ciphertext_sha256=p_ciphertext_sha256 then return public.qorpera_native_credential_generation_json(v_row); end if;
 if v_row.state<>'refreshing' or v_row.generation<>p_expected_generation
  or v_row.owner_id is distinct from p_owner_id or v_row.owner_token_sha256 is distinct from p_owner_token_sha256
  or v_row.owner_identity_epoch is distinct from (p_binding->>'computeIdentityEpoch')::bigint
  or v_row.candidate_reference is distinct from p_candidate_reference then
  raise exception 'Native credential publication fenced' using errcode='42501'; end if;
 update public.qorpera_native_credential_generations set generation=generation+1,reference=p_candidate_reference,
  ciphertext_sha256=p_ciphertext_sha256,state='ready',owner_id=null,owner_token_sha256=null,
  owner_identity_epoch=null,candidate_reference=null,updated_at=statement_timestamp()
  where capsule_id=v_row.capsule_id returning * into v_row;
 return public.qorpera_native_credential_generation_json(v_row);
end $$;

create function public.qorpera_fail_native_credential_refresh(p_binding jsonb,p_expected_generation bigint,
 p_owner_id uuid,p_owner_token_sha256 text,p_candidate_reference text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.qorpera_assert_native_credential_binding(p_binding);
 update public.qorpera_native_credential_generations set state='recovery-required',updated_at=statement_timestamp()
 where capsule_id=(p_binding->>'credentialCapsuleId')::uuid and generation=p_expected_generation and state='refreshing'
  and owner_id=p_owner_id and owner_token_sha256=p_owner_token_sha256 and candidate_reference=p_candidate_reference
  and owner_identity_epoch=(p_binding->>'computeIdentityEpoch')::bigint;
 if not found then raise exception 'Native refresh failure fenced' using errcode='42501'; end if;
end $$;

revoke all on function public.qorpera_native_credential_generation_json(public.qorpera_native_credential_generations) from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_assert_native_credential_binding(jsonb) from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_read_native_credential_generation(jsonb) from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_claim_native_credential_refresh(jsonb,bigint,uuid,text,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_publish_native_credential_generation(jsonb,bigint,uuid,text,text,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_fail_native_credential_refresh(jsonb,bigint,uuid,text,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_read_native_credential_generation(jsonb) to service_role;
grant execute on function public.qorpera_claim_native_credential_refresh(jsonb,bigint,uuid,text,text) to service_role;
grant execute on function public.qorpera_publish_native_credential_generation(jsonb,bigint,uuid,text,text,text) to service_role;
grant execute on function public.qorpera_fail_native_credential_refresh(jsonb,bigint,uuid,text,text) to service_role;
