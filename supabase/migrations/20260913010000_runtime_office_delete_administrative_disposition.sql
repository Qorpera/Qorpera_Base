-- Administrative continuation is not an operation settlement. The accepted
-- delete remains unknown. No capability or provider-only credential admits it.
-- Physical execution-fence/custody verification is performed by the privileged
-- root command; SQL binds its exact public document and existing reset history.
create table public.qorpera_office_delete_dispositions (
 audit_id uuid primary key,
 reset_id uuid not null unique references public.qorpera_runtime_office_resets(reset_id) on delete restrict,
 profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
 operator_id uuid not null references auth.users(id) on delete restrict,
 delete_command_id uuid not null unique,
 operation_id uuid not null unique,
 document_text text not null check(octet_length(document_text) between 1 and 16384),
 document jsonb not null,
 document_sha256 text not null unique check(document_sha256 ~ '^[0-9a-f]{64}$'),
 expected_office_revision bigint not null,
 expected_reset_revision bigint not null,
 expected_provider_version bigint not null,
 expected_capability_revision bigint not null,
 receipt jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 check(document=document_text::jsonb),
 check(document_sha256=encode(extensions.digest(document_text,'sha256'),'hex'))
);
alter table public.qorpera_office_delete_dispositions enable row level security;
revoke all on public.qorpera_office_delete_dispositions from public,anon,authenticated,service_role;

create function public.qorpera_guard_office_delete_disposition()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Office delete disposition is immutable' using errcode='42501'; end $$;
create trigger qorpera_guard_office_delete_disposition before update or delete on public.qorpera_office_delete_dispositions
 for each row execute function public.qorpera_guard_office_delete_disposition();

-- Only the closed phase5 evidence's string-valued object is serialized here.
-- This is not a general JSON/JavaScript numeric serializer.
create function public.qorpera_office_delete_evidence_json(p_value jsonb)
returns text language plpgsql immutable strict set search_path='' as $$
declare v text:=''; r record; child text;
begin
 if jsonb_typeof(p_value)='string' then return p_value::text; end if;
 if jsonb_typeof(p_value)<>'object' then raise exception 'Invalid administrative phase evidence' using errcode='22023'; end if;
 for r in select key,value from jsonb_each(p_value) order by key collate "C" loop
  if r.key!~'^[A-Za-z][A-Za-z0-9]*$' then raise exception 'Invalid administrative phase key' using errcode='22023'; end if;
  child:=public.qorpera_office_delete_evidence_json(r.value);
  v:=v||case when v='' then '' else ',' end||to_jsonb(r.key)::text||':'||child;
 end loop;
 return '{'||v||'}';
end $$;

-- Match JavaScript string.length (UTF16 units) and trim(), not PostgreSQL
-- codepoint length or ASCII-only btrim. Interior whitespace remains unchanged.
create function public.qorpera_office_delete_reason_valid(v jsonb)
returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(v)='string' and char_length(v#>>'{}')>=1
  and (select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)
       from regexp_split_to_table(v#>>'{}','') as x(c)) between 1 and 512
  and not exists(select 1 from regexp_split_to_table(v#>>'{}','') as x(c) where ascii(c) between 0 and 31 or ascii(c)=127)
  and btrim(v#>>'{}', ' '||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)
      ||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)
      ||chr(8287)||chr(12288)||chr(65279))=v#>>'{}';
$$;

create function public.qorpera_assert_office_delete_document(d jsonb,p jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare k text; ids text[]; observed timestamptz;
begin
 if d is null or not public.qorpera_screen_metadata_object(d,array['schema','auditId','resetId','planSha256','deleteCommandId','operationId',
  'nextCreateCommandId','originalOutcome','targetPostcondition','journal','custodyEvidenceSha256','stopAcknowledgementSha256',
  'poweredOffPhaseSha256','operator','source','executionFence','physicalEvidence','observedAt'])
  or d->>'schema' is distinct from 'qorpera.office-delete-administrative-disposition/v1'
  or d->>'originalOutcome' is distinct from 'unknown' or d->>'targetPostcondition' is distinct from 'absent'
  or d->'resetId' is distinct from p->'resetId' or d->'deleteCommandId' is distinct from p#>'{commands,deleteCommandId}'
  or d->'nextCreateCommandId' is distinct from p#>'{commands,createCommandId}'
  or not public.qorpera_screen_metadata_object(d->'journal',array['authoritySha256','acceptedHeadSha256','eventCount'])
  or not public.qorpera_screen_metadata_object(d->'operator',array['principalId','reasonCode','reason'])
  or not public.qorpera_screen_metadata_object(d->'source',array['sourceCommit','artifactSha256'])
  or not public.qorpera_screen_metadata_object(d->'executionFence',array['schema','mechanism','sha256'])
  or not public.qorpera_screen_metadata_object(d->'physicalEvidence',array['schema','sha256']) then
  raise exception 'Invalid office delete disposition' using errcode='22023'; end if;
 foreach k in array array['auditId','resetId','deleteCommandId','operationId','nextCreateCommandId'] loop
  if not public.qorpera_screen_metadata_uuid(d->k) then raise exception 'Invalid disposition identity' using errcode='22023'; end if;
 end loop;
 ids:=array[p->>'resetId',p->>'intentId',p->>'rootIncarnationId',p->>'successorActivationId',p#>>'{predecessor,transitionId}',
  p#>>'{predecessor,activationId}',p#>>'{predecessor,startup,allocationId}',p#>>'{predecessor,startup,bootId}',
  p#>>'{commands,stopCommandId}',p#>>'{commands,deleteCommandId}',p#>>'{commands,createCommandId}',p#>>'{commands,startCommandId}',
  p->>'nodeId',p->>'predecessorRootIncarnationId'];
 if d->>'auditId'=d->>'operationId' or d->>'auditId'=any(ids) or d->>'operationId'=any(ids) then
  raise exception 'Disposition identity reused' using errcode='22023'; end if;
 foreach k in array array['planSha256','custodyEvidenceSha256','stopAcknowledgementSha256','poweredOffPhaseSha256'] loop
  perform public.qorpera_office_package_sha(d->k);
 end loop;
 if (jsonb_typeof(d#>'{journal,authoritySha256}') is distinct from 'string' or (d#>'{journal,authoritySha256}')#>>'{}'!~'^[0-9a-f]{64}$') or (jsonb_typeof(d#>'{journal,acceptedHeadSha256}') is distinct from 'string' or (d#>'{journal,acceptedHeadSha256}')#>>'{}'!~'^[0-9a-f]{64}$')
  or not public.qorpera_node_health_uint(d#>'{journal,eventCount}',383) or (d#>>'{journal,eventCount}')::bigint<11
  or (d#>>'{journal,eventCount}')::bigint%3<>2
  or not public.qorpera_screen_metadata_uuid(d#>'{operator,principalId}')
  or d#>>'{operator,reasonCode}' is distinct from 'accepted_delete_result_unavailable'
  or public.qorpera_office_delete_reason_valid(d#>'{operator,reason}') is distinct from true
  or jsonb_typeof(d#>'{source,sourceCommit}') is distinct from 'string' or d#>>'{source,sourceCommit}'!~'^[0-9a-f]{40}$'
  or (jsonb_typeof(d#>'{source,artifactSha256}') is distinct from 'string' or (d#>'{source,artifactSha256}')#>>'{}'!~'^[0-9a-f]{64}$')
  or d#>>'{executionFence,schema}' is distinct from 'qorpera.office-delete-execution-fence/v1'
  or d#>>'{executionFence,mechanism}' is distinct from 'lxd-ab8fad2-zfs-ordered-delete/v1'
  or (jsonb_typeof(d#>'{executionFence,sha256}') is distinct from 'string' or (d#>'{executionFence,sha256}')#>>'{}'!~'^[0-9a-f]{64}$')
  or d#>>'{physicalEvidence,schema}' is distinct from 'qorpera.office-delete-physical-evidence/v1'
  or (jsonb_typeof(d#>'{physicalEvidence,sha256}') is distinct from 'string' or (d#>'{physicalEvidence,sha256}')#>>'{}'!~'^[0-9a-f]{64}$')
  or jsonb_typeof(d->'observedAt') is distinct from 'string' or d->>'observedAt'!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
  raise exception 'Invalid disposition evidence' using errcode='22023'; end if;
 observed:=(d->>'observedAt')::timestamptz;
 if to_char(observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>d->>'observedAt' then
  raise exception 'Invalid disposition time' using errcode='22023'; end if;
end $$;

create function public.qorpera_administratively_dispose_office_reset_delete(p_document_text text,
 p_expected_office_revision bigint,p_expected_reset_revision bigint,p_expected_provider_version bigint,p_expected_capability_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
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
 -- Same profile/admission lock precedes membership and all office locks.
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 perform 1 from public.qorpera_profile_members where profile_id=o.profile_id and user_id=auth.uid() and role in ('owner','admin') for share;
 if not found then raise exception 'Disposition requires company owner or admin' using errcode='42501'; end if;
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
 select * into strict o from public.qorpera_runtime_offices where id=r.office_id for update;
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
  or not exists(select 1 from public.qorpera_company_files where environment_id=o.environment_id and profile_id=o.profile_id and state='ready' and path_gateway_version=1)
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
end $$;

-- Historical readback only. Provider can retrieve immutable public audit bytes,
-- never mint them or recover a missing original operation outcome.
create function public.qorpera_office_delete_disposition_status(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_resets%rowtype; d public.qorpera_office_delete_dispositions%rowtype;
begin
 perform public.qorpera_assert_runtime_office_reset_plan(p_plan);
 perform public.qorpera_assert_runtime_office_provider(p_plan#>'{predecessor,startup,scope}',(p_plan#>>'{predecessor,startup,computerGeneration}')::bigint,
  (p_plan#>>'{predecessor,providerId}')::uuid,p_plan#>>'{predecessor,providerPolicySha256}',false);
 select * into r from public.qorpera_runtime_office_resets where reset_id=(p_plan->>'resetId')::uuid;
 if not found or r.plan<>p_plan then raise exception 'Disposition reset differs' using errcode='42501'; end if;
 select * into d from public.qorpera_office_delete_dispositions where reset_id=r.reset_id;
 if not found then return null; end if;
 return jsonb_build_object('schema','qorpera.office-delete-administrative-status/v1','documentText',d.document_text,'receipt',d.receipt);
end $$;

-- The existing closed normal acknowledgement cannot accept administrative
-- evidence. An already-disposed delete also cannot be rebound via an old nonce.
do $migration$
declare s text; old text:=E'\tv_reset:=public.qorpera_lock_runtime_office_reset(p_plan,false);';
begin
 s:=pg_get_functiondef('public.qorpera_ack_runtime_office_reset_phase(jsonb,uuid,jsonb)'::regprocedure);
 if (length(s)-length(replace(s,old,'')))/length(old)<>1 then raise exception 'Reset ack source differs'; end if;
 execute replace(s,old,old||E'\n\tif p_evidence->>''phase''=''root_deleted'' and exists(select 1 from public.qorpera_office_delete_dispositions where reset_id=v_reset.reset_id) then\n\t\traise exception ''Administrative delete cannot be acknowledged as normal'' using errcode=''42501''; end if;');
end $migration$;
revoke all on function public.qorpera_guard_office_delete_disposition(),public.qorpera_office_delete_evidence_json(jsonb),
 public.qorpera_assert_office_delete_document(jsonb,jsonb),public.qorpera_office_delete_reason_valid(jsonb),
 public.qorpera_administratively_dispose_office_reset_delete(text,bigint,bigint,bigint,bigint),
 public.qorpera_office_delete_disposition_status(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_administratively_dispose_office_reset_delete(text,bigint,bigint,bigint,bigint) to authenticated;
grant execute on function public.qorpera_office_delete_disposition_status(jsonb) to service_role;
