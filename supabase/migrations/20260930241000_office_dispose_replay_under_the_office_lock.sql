-- 20260930241000: the legacy sweep, step G. Two identical administrative office disposals at the same time both return
-- the receipt (registry, 9 October: the known gap). Since C1c-3k (20260930019000) the disposal's fence on folder-v2 is
-- the folder fence and the company row KEY SHARE, so two disposals passed the fence together, both missed the replay
-- check, and the second, after waiting for the office row, failed "Disposition reset snapshot differs" (42501). The
-- office row FOR UPDATE now comes right after the membership check, before the replay check: the second waits there,
-- and once the first commits it finds the disposition and returns the same receipt. The lock order is unchanged (the
-- statements it moves past take no locks). Folder-v2 only (3 October): the snapshot-v1 branch (the profile gc fence)
-- and the old Company File path gateway's file (path_gateway_version 1) go; a company with no company folder is
-- refused by the folder fence. The rest is the live text, unchanged.

set local lock_timeout = '3s';

create or replace function public.qorpera_administratively_dispose_office_reset_delete(p_document_text text, p_expected_office_revision bigint,
 p_expected_reset_revision bigint, p_expected_provider_version bigint, p_expected_capability_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare d jsonb; p jsonb; old public.qorpera_office_delete_dispositions%rowtype;
 r public.qorpera_runtime_office_resets%rowtype; o public.qorpera_runtime_offices%rowtype;
 a public.qorpera_runtime_office_activations%rowtype; provider public.qorpera_runtime_office_providers%rowtype;
 t public.qorpera_runtime_office_lifecycle_transitions%rowtype; q public.qorpera_office_package_provisions%rowtype;
 cap public.qorpera_office_package_capabilities%rowtype; ev jsonb; evsha text; sha text; receipt jsonb; observed timestamptz; n timestamptz;
begin
 if session_user<>'postgres' or auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Privileged authenticated company operator required' using errcode='42501'; end if;
 if p_document_text is null or octet_length(p_document_text) not between 1 and 16384 then
  raise exception 'Invalid disposition bytes' using errcode='22023'; end if;
 d:=p_document_text::jsonb;
 select * into r from public.qorpera_runtime_office_resets where reset_id=(d->>'resetId')::uuid;
 if not found then raise exception 'Disposition reset unavailable' using errcode='42501'; end if;
 p:=r.plan;
 perform public.qorpera_assert_office_delete_document(d,p);
 if d#>>'{operator,principalId}' is distinct from auth.uid()::text then
  raise exception 'Disposition operator differs' using errcode='42501'; end if;
 select * into strict o from public.qorpera_runtime_offices where id=r.office_id;
 -- Same profile/admission lock precedes membership and all office locks: the folder fence and the company row KEY SHARE
 -- (C1c-3k, 20260930019000). A company with no company folder is refused there (20260930241000).
 perform public.qorpera_folder_machine_fence(o.profile_id);
 perform 1 from public.qorpera_profile_members where profile_id=o.profile_id and user_id=auth.uid() and role in ('owner','admin') for share;
 if not found then raise exception 'Disposition requires company owner or admin' using errcode='42501'; end if;
 -- 20260930241000: the office row before the replay check. The fence is KEY SHARE, so an identical dispose running
 -- at the same time is held here until it commits, and then replays its receipt below.
 select * into strict o from public.qorpera_runtime_offices where id=r.office_id for update;
 sha:=encode(extensions.digest(p_document_text,'sha256'),'hex');
 select * into old from public.qorpera_office_delete_dispositions where reset_id=r.reset_id;
 if found then
  if old.audit_id::text is distinct from d->>'auditId' or old.document_text<>p_document_text or old.document_sha256<>sha
   or old.expected_office_revision is distinct from p_expected_office_revision or old.expected_reset_revision is distinct from p_expected_reset_revision
   or old.expected_provider_version is distinct from p_expected_provider_version or old.expected_capability_revision is distinct from p_expected_capability_revision then
   raise exception 'Disposition cannot be rebound' using errcode='42501'; end if;
  return old.receipt;
 end if;
 if exists(select 1 from public.qorpera_office_delete_dispositions where audit_id=(d->>'auditId')::uuid or operation_id=(d->>'operationId')::uuid)
  or p_expected_office_revision is null or p_expected_reset_revision is null or p_expected_provider_version is null or p_expected_capability_revision is null then
  raise exception 'Disposition audit or revision unavailable' using errcode='42501'; end if;
 observed:=(d->>'observedAt')::timestamptz;
 n:=clock_timestamp();
 if observed>n or observed<=n-interval '300 seconds' then raise exception 'Disposition observation expired' using errcode='42501'; end if;
 select * into provider from public.qorpera_runtime_office_providers where office_id=o.id and computer_generation=o.generation for share;
 if not found or provider.provider_id<>r.provider_id or provider.policy_sha256<>r.provider_policy_sha256
  or provider.version<>p_expected_provider_version or not provider.preparation_enabled then
  raise exception 'Disposition provider differs' using errcode='42501'; end if;
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=r.predecessor_activation_id for update;
 perform 1 from public.qorpera_runtime_machine_allocations where id=r.allocation_id and office_id=o.id and profile_id=o.profile_id
  and computer_generation=o.generation and provider_adapter='lxd' and instance_sha256=r.instance_sha256 and released_at is null for share;
 if not found then raise exception 'Disposition allocation differs' using errcode='42501'; end if;
 perform 1 from public.qorpera_runtime_node_demands where allocation_id=r.allocation_id and released_at is null and node_id=r.node_id for share;
 if (r.node_id is not null and not found) or (r.node_id is null and exists(select 1 from public.qorpera_runtime_node_demands where allocation_id=r.allocation_id)) then
  raise exception 'Disposition node demand differs' using errcode='42501'; end if;
 select * into strict t from public.qorpera_runtime_office_lifecycle_transitions where id=r.transition_id for update;
 perform 1 from public.qorpera_runtime_office_stops where transition_id=t.id for share;
 if not found then raise exception 'Disposition stop unavailable' using errcode='42501'; end if;
 select * into strict r from public.qorpera_runtime_office_resets where reset_id=r.reset_id for update;
 if r.plan<>p or r.plan_sha256 is distinct from d->>'planSha256' or r.phase<>'powered_off' or r.revision<>p_expected_reset_revision
  or r.restore is not null or r.restore_sha256 is not null or r.custody is null or r.custody_sha256 is distinct from d->>'custodyEvidenceSha256'
  or o.revision<>p_expected_office_revision or o.revision<>r.office_revision or o.state<>'maintenance'
  or o.privacy_state<>r.privacy_state or o.privacy_version<>r.privacy_version or o.privacy_challenge is distinct from r.privacy_challenge
  or o.generation<>r.computer_generation or not public.qorpera_company_execution_paused(o.profile_id)
  or t.request is distinct from p->'predecessor' or t.activation_id<>a.activation_id or t.allocation_id<>r.allocation_id or t.office_id<>o.id
  or a.state<>'active' or a.superseded_at is not null or a.office_id<>o.id or a.computer_generation<>o.generation
  or a.allocation_id<>r.allocation_id or a.provider_id<>r.provider_id or a.provider_policy_sha256<>r.provider_policy_sha256
  or a.instance_sha256<>r.instance_sha256 or a.image_sha256<>o.image_sha256 or a.bootstrap_sha256<>o.bootstrap_sha256
  or a.intent_id::text is distinct from p->>'intentId' or a.provider_binding_sha256 is distinct from p->>'providerBindingSha256'
  or a.attestation->>'preparationObservationSha256' is distinct from p->>'preparationObservationSha256'
  or a.attestation->>'bootId' is distinct from p#>>'{predecessor,startup,bootId}'
  or a.attestation->>'configurationSha256' is distinct from p#>>'{predecessor,startup,configurationSha256}'
  or a.service_invocation_id is distinct from p#>>'{predecessor,startup,serviceInvocationId}'
  or exists(select 1 from public.qorpera_runtime_office_activations where activation_id=r.successor_activation_id or predecessor_activation_id=a.activation_id)
  or exists(select 1 from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id and sequence>4)
  or (select count(*) from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id)<>4
  or exists(select 1 from public.qorpera_runtime_office_screens where office_id=o.id and (drain_pending or lease_id is not null or takeover_user_id is not null))
  or exists(select 1 from public.qorpera_runtime_office_resources where office_id=o.id and state<>'drained')
  or exists(select 1 from public.qorpera_runtime_office_viewers where office_id=o.id and state<>'ended')
  or not exists(select 1 from public.qorpera_company_files where environment_id=o.environment_id and profile_id=o.profile_id and state='ready'
  and core='folder-v2' /* 20260930241000 */)
  or not exists(select 1 from public.qorpera_logical_computers c where c.id=o.logical_computer_id and c.status='active' and public.qorpera_runtime_office_matches(c)) then
  raise exception 'Disposition reset snapshot differs' using errcode='42501'; end if;
 perform public.qorpera_assert_runtime_office_reset_plan(p);
 perform public.qorpera_assert_runtime_office_reset_custody(r.custody,p);
 perform 1 from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id and sequence=1 and phase='fenced' and evidence_sha256=r.plan_sha256 and previous_sha256 is null;
 if not found then raise exception 'Disposition initial evidence differs' using errcode='42501'; end if;
 perform 1 from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id and sequence=2 and phase='stopped'
  and evidence_sha256=d->>'stopAcknowledgementSha256' and previous_sha256=r.plan_sha256;
 if not found then raise exception 'Disposition stopped evidence differs' using errcode='42501'; end if;
 perform 1 from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id and sequence=3 and phase='custodied'
  and evidence->'observation'=r.custody and evidence_sha256=d->>'custodyEvidenceSha256' and previous_sha256=d->>'stopAcknowledgementSha256';
 if not found then raise exception 'Disposition custody evidence differs' using errcode='42501'; end if;
 perform 1 from public.qorpera_runtime_office_reset_events where reset_id=r.reset_id and sequence=4 and phase='powered_off'
  and evidence_sha256=d->>'poweredOffPhaseSha256' and previous_sha256=d->>'custodyEvidenceSha256';
 if not found then raise exception 'Disposition powered-off evidence differs' using errcode='42501'; end if;
 -- This helper takes package baseline then provision locks and keeps the active
 -- bundle assertion. The original signed24 package is not rewritten for recovery.
 perform public.qorpera_assert_office_package_reset(p,r.plan_sha256,false);
 select * into strict q from public.qorpera_office_package_provisions where reset_id=r.reset_id for share;
 select * into cap from public.qorpera_office_package_capabilities where allocation_id=r.allocation_id for share;
 if not found or not cap.enabled or cap.revision<>p_expected_capability_revision or cap.provider_id<>r.provider_id
  or cap.provider_policy_sha256<>r.provider_policy_sha256 or q.state<>'enrolled' or q.request is not null
  or q.predecessor_activation_id<>a.activation_id or q.root_incarnation_id<>r.root_incarnation_id
  or q.successor_activation_id<>r.successor_activation_id or q.allocation_id<>r.allocation_id
  or exists(select 1 from public.qorpera_office_package_installations where provision_id=q.id) then
  raise exception 'Disposition package admission differs' using errcode='42501'; end if;
 ev:=jsonb_build_object('schema','qorpera.office-reset-phase-evidence/v1','resetId',r.reset_id,'phase','root_deleted','observation',
  jsonb_build_object('schema','qorpera.office-delete-administrative-boundary/v1','auditId',d->'auditId','dispositionSha256',sha,
   'commandId',d->'deleteCommandId','operationId',d->'operationId','originalOutcome','unknown','targetPostcondition','absent',
   'nextCreateCommandId',d->'nextCreateCommandId'));
 evsha:=encode(extensions.digest(public.qorpera_office_delete_evidence_json(ev),'sha256'),'hex');
 receipt:=jsonb_build_object('schema','qorpera.office-delete-administrative-receipt/v1','auditId',d->'auditId','resetId',r.reset_id,
  'dispositionSha256',sha,'operatorId',auth.uid(),'recordedAt',to_char(n at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'originalOutcome','unknown','recoveryKind','administrative_delete','cleanResetAcceptance',false,
  'phaseEvidence',ev,'phaseEvidenceSha256',evsha,'resetRevision',r.revision+1);
 insert into public.qorpera_office_delete_dispositions(audit_id,reset_id,profile_id,operator_id,delete_command_id,operation_id,document_text,document,document_sha256,
  expected_office_revision,expected_reset_revision,expected_provider_version,expected_capability_revision,receipt,recorded_at)
 values((d->>'auditId')::uuid,r.reset_id,o.profile_id,auth.uid(),(d->>'deleteCommandId')::uuid,(d->>'operationId')::uuid,p_document_text,d,sha,
  p_expected_office_revision,p_expected_reset_revision,p_expected_provider_version,p_expected_capability_revision,receipt,n);
 update public.qorpera_runtime_office_resets set phase='root_deleted',revision=revision+1,updated_at=n where reset_id=r.reset_id;
 insert into public.qorpera_runtime_office_reset_events(reset_id,sequence,phase,previous_sha256,evidence,evidence_sha256,challenge_id,recorded_at)
 values(r.reset_id,5,'root_deleted',d->>'poweredOffPhaseSha256',ev,evsha,null,n);
 if observed<=clock_timestamp()-interval '300 seconds' then raise exception 'Disposition observation expired' using errcode='42501'; end if;
 return receipt;
end $function$;
