-- Member-reviewed email effects. The browser cannot assert that mail was sent:
-- a one-use capability binds exact edited content to an independently authenticated
-- broker. Ambiguous provider outcomes remain locked, never automatically resent.
begin;
create table public.qorpera_member_email_drafts (
 interaction_id uuid primary key references public.qorpera_session_events(event_id) on delete cascade,
 session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete cascade,
 from_address text not null,
 content jsonb not null,
 draft_id text,
 message_id text,
 status text not null default 'ready' check(status in ('ready','saved','sending','sent','discarded','unconfirmed')),
 action_id uuid,
 updated_at timestamptz not null default statement_timestamp()
);
create table public.qorpera_member_email_actions (
 id uuid primary key,
 interaction_id uuid not null references public.qorpera_member_email_drafts(interaction_id) on delete cascade,
 capability_sha256 text not null check(capability_sha256 ~ '^[0-9a-f]{64}$'),
 action text not null check(action in ('save','send','discard')),
 content jsonb not null,
 status text not null default 'pending' check(status in ('pending','executing','completed','failed','unconfirmed')),
 result jsonb,
 sponsor_binding_id uuid,
 sponsor_version bigint,
 expires_at timestamptz not null default statement_timestamp() + interval '10 minutes'
);
alter table public.qorpera_member_email_drafts enable row level security;
alter table public.qorpera_member_email_actions enable row level security;
revoke all on public.qorpera_member_email_drafts, public.qorpera_member_email_actions from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_email_content_valid(p_content jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_address jsonb;
begin
 if jsonb_typeof(p_content) is distinct from 'object' or not(p_content ?& array['to','cc','subject','body'])
  or p_content - array['to','cc','subject','body'] <> '{}'::jsonb
  or jsonb_typeof(p_content->'to') is distinct from 'array' or jsonb_typeof(p_content->'cc') is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_content->'to') not between 1 and 20 or jsonb_array_length(p_content->'cc') > 20
  or not coalesce(public.qorpera_interaction_text_valid(p_content->'subject',1,500),false)
  or p_content->>'subject' ~ '[\r\n]'
  or not coalesce(public.qorpera_interaction_text_valid(p_content->'body',1,50000),false) then return false; end if;
 for v_address in select value from jsonb_array_elements((p_content->'to') || (p_content->'cc')) loop
  if not coalesce(public.qorpera_interaction_text_valid(v_address,3,254),false)
   or (v_address #>> '{}') !~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+\.[^[:space:]<>@,;]+$' then return false; end if;
 end loop;
 return true;
end $$;

-- Internal state renderer. Never returns a capability, credential or envelope.
create function public.qorpera_email_draft_state(p_interaction_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_strip_nulls(jsonb_build_object('schema','qorpera.email-draft-state/v1',
  'phase',case when a.status='completed' then 'succeeded' else a.status end,'error',a.result->>'error',
  'notificationPending',d.status in ('sent','discarded') and not exists(select 1 from public.qorpera_session_inputs i where i.session_id=d.session_id and i.client_input_id=d.action_id),
  'companyId',s.profile_id,'from',d.from_address,'content',d.content,'status',d.status,
  'draftId',d.draft_id,'messageId',d.message_id,'actionId',d.action_id,'brokerOrigin',b.service_origin))
 from public.qorpera_member_email_drafts d join public.qorpera_cloud_secrets s on s.id=d.secret_id
 join public.qorpera_cloud_secret_broker_authorities b on b.id=s.broker_authority_id
 left join public.qorpera_member_email_actions a on a.id=d.action_id
 where d.interaction_id=p_interaction_id
$$;

create function public.qorpera_get_email_draft(p_session_id uuid,p_interaction_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_payload jsonb; v_data jsonb;
 v_secret public.qorpera_cloud_secrets%rowtype; v_content jsonb; v_actor uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'email draft authority required' using errcode='42501'; end if;
 if not public.qorpera_can_read_session(p_session_id) then raise exception 'email draft unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(public.qorpera_session_profile_id(p_session_id));
 if public.qorpera_profile_gc_deletion_active(public.qorpera_session_profile_id(p_session_id)) then raise exception 'company cleanup is in progress' using errcode='55000'; end if;
 select * into v_session from public.qorpera_shared_sessions where id=p_session_id for update;
 select body #> '{entry,data}',actor_user_id into v_data,v_actor from public.qorpera_session_events
 where session_id=p_session_id and event_id=p_interaction_id and event_type='interaction_request';
 v_payload:=v_data->'payload';
 if v_data->>'surface' is distinct from 'draft' or v_payload->>'platform' is distinct from 'email'
  or v_payload->>'connectorId' is distinct from 'gmail' then raise exception 'email draft unavailable' using errcode='22023'; end if;
 if v_payload ? 'replyTo' and coalesce(v_payload->>'replyTo','') !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'Gmail reply reference invalid' using errcode='22023'; end if;
 if not exists(select 1 from public.qorpera_member_email_drafts where interaction_id=p_interaction_id) then
  if v_session.status<>'open' or (v_data ? 'expiresAt' and (v_data->>'expiresAt')::timestamptz <= clock_timestamp()) then raise exception 'email draft expired' using errcode='55000'; end if;
  select * into v_secret from public.qorpera_cloud_secrets where profile_id=v_session.profile_id and environment_id=v_session.environment_id
   and connector_id='gmail' and secret_name='primary' and owner_kind='company' and status='active';
  if v_secret.id is null or v_secret.account_label is null or lower(v_secret.account_label) is distinct from lower(v_payload->>'from') then
   raise exception 'Gmail sender does not match the connected account' using errcode='42501'; end if;
  v_content:=jsonb_build_object('to',v_payload->'to','cc',coalesce(v_payload->'cc','[]'::jsonb),'subject',coalesce(v_payload->'subject','""'::jsonb),'body',v_payload->'body');
  insert into public.qorpera_member_email_drafts(interaction_id,session_id,user_id,secret_id,from_address,content)
  values(p_interaction_id,p_session_id,case when exists(select 1 from public.qorpera_company_rooms where session_id=p_session_id and bound_staff_agent_id is not null) then v_actor else coalesce(v_session.audience_user_id,v_session.created_by_user_id) end,v_secret.id,v_secret.account_label,v_content);
 end if;
 return public.qorpera_email_draft_state(p_interaction_id);
end $$;

create function public.qorpera_prepare_email_draft_action(p_session_id uuid,p_interaction_id uuid,p_client_action_id uuid,p_action text,p_content jsonb,p_capability_sha256 text,p_sponsor_binding_id uuid default null,p_sponsor_version bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_draft public.qorpera_member_email_drafts%rowtype; v_action public.qorpera_member_email_actions%rowtype; v_session public.qorpera_shared_sessions%rowtype;
begin
 perform public.qorpera_get_email_draft(p_session_id,p_interaction_id);
 select * into strict v_draft from public.qorpera_member_email_drafts where interaction_id=p_interaction_id for update;
 perform public.qorpera_session_profile_for_write(p_session_id);
 select * into strict v_session from public.qorpera_shared_sessions where id=p_session_id;
 if v_session.status<>'open' or v_draft.user_id is distinct from auth.uid() then raise exception 'email draft author required' using errcode='42501'; end if;
 if p_client_action_id is null or p_action is null or p_action not in ('save','send','discard') or p_capability_sha256 is null or p_capability_sha256 !~ '^[0-9a-f]{64}$'
  or (p_action<>'discard' and not public.qorpera_email_content_valid(p_content))
  or jsonb_typeof(p_content) is distinct from 'object' or octet_length(p_content::text)>65536 then
  raise exception 'email action invalid' using errcode='22023'; end if;
 select * into v_action from public.qorpera_member_email_actions where id=p_client_action_id;
 if found then
  if v_action.interaction_id<>p_interaction_id or v_action.action<>p_action or v_action.content<>p_content or v_action.capability_sha256<>p_capability_sha256 then raise exception 'email action id reused' using errcode='23505'; end if;
  if v_draft.action_id is distinct from p_client_action_id then raise exception 'email action superseded; refresh the card' using errcode='55000'; end if;
  return public.qorpera_email_draft_state(p_interaction_id);
 end if;
 if v_draft.status not in ('ready','saved') then raise exception 'email action already in progress or finished' using errcode='55000'; end if;
 if exists(select 1 from public.qorpera_session_inputs where session_id=p_session_id and body->>'interactionId'=p_interaction_id::text)
  or exists(select 1 from public.qorpera_session_events where session_id=p_session_id and event_type='interaction_answer' and body#>>'{entry,data,interactionId}'=p_interaction_id::text) then
  raise exception 'email draft already answered' using errcode='55000'; end if;
 insert into public.qorpera_member_email_actions(id,interaction_id,capability_sha256,action,content,sponsor_binding_id,sponsor_version)
 values(p_client_action_id,p_interaction_id,p_capability_sha256,p_action,p_content,p_sponsor_binding_id,p_sponsor_version);
 update public.qorpera_member_email_drafts set status='sending',content=p_content,action_id=p_client_action_id,updated_at=statement_timestamp() where interaction_id=p_interaction_id;
 return public.qorpera_email_draft_state(p_interaction_id);
end $$;

-- Internal refusal for an action that provably never reached the provider.
create function public.qorpera_refuse_email_draft_action(p_action_id uuid,p_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_interaction uuid;
begin
 update public.qorpera_member_email_actions set status='failed',result=jsonb_build_object('status','failed','error',p_error)
 where id=p_action_id and status='pending' returning interaction_id into strict v_interaction;
 update public.qorpera_member_email_drafts set status=case when draft_id is null then 'ready' else 'saved' end
 where interaction_id=v_interaction;
 return jsonb_build_object('execute',false,'state',public.qorpera_email_draft_state(v_interaction));
end $$;

create function public.qorpera_claim_email_draft_action(p_broker_authority_id uuid,p_broker_capability_sha256 text,p_action_id uuid,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_broker public.qorpera_cloud_secret_broker_authorities%rowtype; v_action public.qorpera_member_email_actions%rowtype;
 v_draft public.qorpera_member_email_drafts%rowtype; v_secret public.qorpera_cloud_secrets%rowtype; v_version public.qorpera_cloud_secret_versions%rowtype;
 v_session public.qorpera_shared_sessions%rowtype; v_data jsonb; v_operation text; v_staff text;
begin
 if session_user<>'qorpera_secret_broker' then raise exception 'broker authority required' using errcode='42501'; end if;
 select * into v_broker from public.qorpera_cloud_secret_broker_authorities where id=p_broker_authority_id and status='active' and capability_sha256=p_broker_capability_sha256 for share;
 if not found then raise exception 'broker unavailable' using errcode='42501'; end if;
 -- Same lock order as member preparation: session, draft, action.
 select s.* into v_session from public.qorpera_shared_sessions s join public.qorpera_member_email_drafts d on d.session_id=s.id
 join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id where a.id=p_action_id for update of s;
 select d.* into v_draft from public.qorpera_member_email_drafts d join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id where a.id=p_action_id for update of d;
 select * into v_action from public.qorpera_member_email_actions where id=p_action_id for update;
 if v_action.id is null or v_action.capability_sha256 is distinct from p_capability_sha256 or v_session.profile_id<>v_broker.profile_id then raise exception 'email action unavailable' using errcode='42501'; end if;
 if v_draft.action_id is distinct from p_action_id then raise exception 'email action superseded' using errcode='55000'; end if;
 if v_action.status='completed' then
  return jsonb_build_object('execute',false,'state',public.qorpera_finish_email_draft_action(p_broker_authority_id,p_broker_capability_sha256,p_action_id,p_capability_sha256,v_action.result));
 end if;
 if v_action.status<>'pending' then return jsonb_build_object('execute',false,'state',public.qorpera_email_draft_state(v_draft.interaction_id)); end if;
 if v_action.expires_at<=clock_timestamp() then
  return public.qorpera_refuse_email_draft_action(p_action_id,'This email action expired before it started. Try again.');
 end if;
 v_operation:=case when v_action.action='save' then case when v_draft.draft_id is null then 'create_draft' else 'update_draft' end when v_action.action='send' then case when v_draft.draft_id is null then 'send_message' else 'send_draft' end else 'delete_draft' end;
 select coalesce((select bound_staff_agent_id::text from public.qorpera_company_rooms where session_id=v_session.id),v_session.staff_agent_id::text) into v_staff;
 select body#>'{entry,data}' into v_data from public.qorpera_session_events where event_id=v_draft.interaction_id;
 if v_session.status<>'open'
  or (v_data ? 'expiresAt' and (v_data->>'expiresAt')::timestamptz<=clock_timestamp())
  or not exists(select 1 from public.qorpera_profile_members where profile_id=v_broker.profile_id and user_id=v_draft.user_id and role<>'viewer')
  or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_broker.profile_id and staff_agent_id::text=v_staff and employment_status='active')
  or (exists(select 1 from public.qorpera_company_rooms where session_id=v_session.id) and not exists(select 1 from public.qorpera_company_rooms r join public.qorpera_company_room_members m on m.room_id=r.id and m.principal_kind='member' and m.principal_id=v_draft.user_id and m.status='active' where r.session_id=v_session.id and r.bound_staff_agent_id is not null and r.status='active'))
  or (not(v_action.action='discard' and v_draft.draft_id is null) and not exists(select 1 from public.qorpera_cloud_secret_operation_grants g join public.qorpera_profile_members m on m.profile_id=g.profile_id and m.user_id=g.issued_by_user_id and m.role in ('owner','admin')
   join public.qorpera_cloud_connector_operations o on o.connector_id=g.connector_id and o.operation_id=g.operation_id and o.version=g.operation_version and o.status='active'
   where g.secret_id=v_draft.secret_id and g.staff_agent_id::text=v_staff and g.status='active' and (g.expires_at is null or g.expires_at>clock_timestamp())
   and g.operation_id=v_operation)) then
  return public.qorpera_refuse_email_draft_action(p_action_id,'The conversation or Gmail connection permission is no longer available.'); end if;
 if v_action.action='discard' and v_draft.draft_id is null then
  update public.qorpera_member_email_actions set status='executing' where id=p_action_id;
  return jsonb_build_object('execute',true,'action','discard','draftId',null);
 end if;
 select * into v_secret from public.qorpera_cloud_secrets where id=v_draft.secret_id and profile_id=v_broker.profile_id and environment_id=v_session.environment_id
  and broker_authority_id=v_broker.id and status='active' and account_label=v_draft.from_address for share;
 if not found then return public.qorpera_refuse_email_draft_action(p_action_id,'The Gmail account changed or was disconnected. Create a new draft with the current account.'); end if;
 select * into v_version from public.qorpera_cloud_secret_versions where secret_id=v_secret.id and version=v_secret.current_version and broker_authority_id=v_broker.id and key_id=v_broker.key_id;
 if not found then return public.qorpera_refuse_email_draft_action(p_action_id,'The Gmail credential is unavailable. Reconnect Gmail.'); end if;
 update public.qorpera_member_email_actions set status='executing' where id=p_action_id;
 return jsonb_build_object('execute',true,'action',v_action.action,'content',v_action.content,'draftId',v_draft.draft_id,'replyTo',v_data#>>'{payload,replyTo}',
  'companyId',v_secret.profile_id,'environmentId',v_secret.environment_id,'secretId',v_secret.id,'version',v_secret.current_version,'keyId',v_version.key_id,
  'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),'envelopeSha256',v_version.envelope_sha256);
end $$;

create function public.qorpera_finish_email_draft_action(p_broker_authority_id uuid,p_broker_capability_sha256 text,p_action_id uuid,p_capability_sha256 text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_action public.qorpera_member_email_actions%rowtype; v_draft public.qorpera_member_email_drafts%rowtype;
 v_profile uuid; v_status text; v_claims text;
begin
 if session_user<>'qorpera_secret_broker' then raise exception 'broker authority required' using errcode='42501'; end if;
 select profile_id into v_profile from public.qorpera_cloud_secret_broker_authorities where id=p_broker_authority_id and status='active' and capability_sha256=p_broker_capability_sha256;
 if not found then raise exception 'broker unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_shared_sessions s join public.qorpera_member_email_drafts d on d.session_id=s.id join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id
 where a.id=p_action_id and s.profile_id=v_profile for update of s;
 if not found then raise exception 'email action unavailable' using errcode='42501'; end if;
 select d.* into v_draft from public.qorpera_member_email_drafts d join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id where a.id=p_action_id for update of d;
 select * into v_action from public.qorpera_member_email_actions where id=p_action_id and capability_sha256=p_capability_sha256 for update;
 if not found then raise exception 'email capability invalid' using errcode='42501'; end if;
 if v_draft.action_id is distinct from p_action_id then raise exception 'email action superseded' using errcode='55000'; end if;
 if v_action.status='completed' then
  if v_action.result is distinct from p_result then raise exception 'email completion changed' using errcode='23505'; end if;
 elsif v_action.status<>'executing' or jsonb_typeof(p_result) is distinct from 'object' then raise exception 'email completion invalid' using errcode='22023'; end if;
 v_status:=case when p_result->>'status'='unconfirmed' then 'unconfirmed' when p_result->>'status'='failed' then case when v_draft.draft_id is null then 'ready' else 'saved' end when v_action.action='save' then 'saved' when v_action.action='send' then 'sent' else 'discarded' end;
 if p_result->>'status' is distinct from 'failed' and (v_status='saved' and coalesce(p_result->>'draft_id','') !~ '^[A-Za-z0-9_-]{1,128}$'
  or v_status='sent' and coalesce(p_result->>'message_id','') !~ '^[A-Za-z0-9_-]{1,128}$'
  or v_status='discarded' and p_result->'deleted' is distinct from 'true'::jsonb) then raise exception 'email provider receipt invalid' using errcode='22023'; end if;
 update public.qorpera_member_email_actions set status=case when v_status='unconfirmed' then 'unconfirmed' when p_result->>'status'='failed' then 'failed' else 'completed' end,result=p_result where id=p_action_id;
 update public.qorpera_member_email_drafts set status=v_status,draft_id=case when v_status='saved' and p_result->>'status' is distinct from 'failed' then p_result->>'draft_id' else draft_id end,
 message_id=case when v_status='sent' then p_result->>'message_id' else message_id end,updated_at=statement_timestamp() where interaction_id=v_draft.interaction_id;
 if v_status in ('sent','discarded') then
  -- Reuse the kernel's author, sponsor, room and plain-conversation delivery
  -- rules. The stored provider receipt authorizes only this final answer.
  -- A queue/sponsor failure never rolls back a successful external email.
  v_claims:=current_setting('request.jwt.claims',true);
  begin
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_draft.user_id,'role','authenticated')::text,true);
   perform public.qorpera_answer_interaction(v_draft.session_id,p_action_id,v_draft.interaction_id,v_status,'{}'::jsonb,v_action.sponsor_binding_id,v_action.sponsor_version);
  exception when others then null;
  end;
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
 end if;
 return public.qorpera_email_draft_state(v_draft.interaction_id);
end $$;

-- A browser may publish a completed receipt, but cannot fabricate the effect.
-- This also lets a member retry wake delivery with a newly selected sponsor.
do $$ declare v_definition text; v_start integer; v_end integer; v_branch text; begin
 v_definition:=pg_get_functiondef('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)'::regprocedure);
 -- Expiry prevents a new effect, but cannot erase a provider receipt for an
 -- action admitted before that deadline (or prevent delayed wake delivery).
 v_definition:=replace(v_definition,
  'if v_data ? ''expiresAt'' and (v_data ->> ''expiresAt'')::timestamptz <= statement_timestamp() then',
  'if v_data ? ''expiresAt'' and (v_data ->> ''expiresAt'')::timestamptz <= statement_timestamp() and not exists(select 1 from public.qorpera_member_email_drafts d where d.interaction_id=p_interaction_id and d.action_id=p_client_input_id and d.status in (''sent'',''discarded'')) then');
 v_start:=position('elsif v_surface = ''draft'' then' in v_definition);
 v_end:=position('elsif v_surface = ''approval'' then' in v_definition);
 if v_start=0 or v_end<=v_start then raise exception 'draft answer branch missing'; end if;
 v_branch:=substring(v_definition from v_start for v_end-v_start);
 execute replace(v_definition,v_branch,
  $patch$elsif v_surface = 'draft' then
  if v_payload->>'platform'='email' and v_payload->>'connectorId'='gmail' then
   if not exists(select 1 from public.qorpera_member_email_drafts d
    where d.interaction_id=p_interaction_id and d.session_id=p_session_id and d.user_id=v_user_id
    and d.action_id=p_client_input_id and d.status=p_outcome and d.status in ('sent','discarded')) then
    raise exception 'Gmail completion requires a provider receipt' using errcode='42501';
   end if;
   select case when p_outcome='sent' then jsonb_build_object('sentSummary','Sent through Gmail',
    'from',d.from_address,'content',d.content,'messageId',d.message_id) else '{}'::jsonb end
   into v_answer from public.qorpera_member_email_drafts d where d.interaction_id=p_interaction_id;
  else
  $patch$ || substring(v_branch from length('elsif v_surface = ''draft'' then')+1) || E' end if;\n');
end $$;
revoke all on function public.qorpera_email_content_valid(jsonb),public.qorpera_email_draft_state(uuid),public.qorpera_refuse_email_draft_action(uuid,text),public.qorpera_get_email_draft(uuid,uuid),public.qorpera_prepare_email_draft_action(uuid,uuid,uuid,text,jsonb,text,uuid,bigint),public.qorpera_claim_email_draft_action(uuid,text,uuid,text),public.qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_get_email_draft(uuid,uuid),public.qorpera_prepare_email_draft_action(uuid,uuid,uuid,text,jsonb,text,uuid,bigint) to authenticated;
grant execute on function public.qorpera_claim_email_draft_action(uuid,text,uuid,text),public.qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb) to qorpera_secret_broker;
commit;
