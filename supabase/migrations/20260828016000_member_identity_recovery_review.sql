-- Human-only discovery and exact-review decisions. No secret, target capability,
-- key release, worker start or public-send authority is exposed by this surface.
create index qorpera_recovery_identity_member_page
  on public.qorpera_member_compute_identities(profile_id,id);
create index qorpera_recovery_target_member_page
  on public.qorpera_identity_recovery_targets(compute_identity_id,id);

create function public.qorpera_recovery_member_role(p_company_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_role text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'Recovery review requires member sign-in' using errcode='42501'; end if;
  perform public.qorpera_lock_profile_gc_fence(p_company_id);
  select role into v_role from public.qorpera_profile_members
    where profile_id=p_company_id and user_id=auth.uid() for share;
  if not found then raise exception 'Recovery membership is unavailable' using errcode='42501'; end if;
  return v_role;
end
$$;

create function public.qorpera_list_member_recovery_identities(
  p_company_id uuid,p_after uuid default null,p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_rows jsonb; v_more boolean;
begin
  v_role:=public.qorpera_recovery_member_role(p_company_id);
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Recovery page size is invalid' using errcode='22023'; end if;
  with candidates as (
    select id,display_name,ownership_kind,owner_user_id,status,recovery_epoch,recovery_pending_id
    from public.qorpera_member_compute_identities
    where profile_id=p_company_id and (v_role='owner' or owner_user_id=auth.uid())
      and (p_after is null or id>p_after) order by id limit p_limit+1
  ), page as (select * from candidates order by id limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object(
    'computeIdentityId',id,'displayName',display_name,'ownershipKind',ownership_kind,
    'ownerUserId',owner_user_id,'status',status,'epoch',recovery_epoch,
    'blocked',recovery_pending_id is not null) order by id) from page),'[]'::jsonb),
    (select count(*)>p_limit from candidates) into v_rows,v_more;
  return jsonb_build_object('companyId',p_company_id,'viewerUserId',auth.uid(),
    'isOwner',v_role='owner','items',v_rows,
    'nextAfter',case when v_more then v_rows->-1->>'computeIdentityId' else null end);
end
$$;

create function public.qorpera_list_member_recovery_targets(
  p_company_id uuid,p_compute_identity_id uuid,p_after uuid default null,p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_rows jsonb; v_more boolean;
begin
  v_role:=public.qorpera_recovery_member_role(p_company_id);
  perform 1 from public.qorpera_member_compute_identities where id=p_compute_identity_id
    and profile_id=p_company_id and (v_role='owner' or owner_user_id=auth.uid()) for share;
  if not found then raise exception 'Recovery identity is unavailable' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Recovery page size is invalid' using errcode='22023'; end if;
  with candidates as (
    select id,node_id,status,expires_at from public.qorpera_identity_recovery_targets
    where profile_id=p_company_id and compute_identity_id=p_compute_identity_id
      and (p_after is null or id>p_after) order by id limit p_limit+1
  ), page as (select * from candidates order by id limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object(
    'targetId',id,'nodeId',node_id,'status',status,
    'expiresAt',to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by id)
    from page),'[]'::jsonb),(select count(*)>p_limit from candidates) into v_rows,v_more;
  return jsonb_build_object('companyId',p_company_id,'computeIdentityId',p_compute_identity_id,
    'items',v_rows,'nextAfter',case when v_more then v_rows->-1->>'targetId' else null end);
end
$$;

create function public.qorpera_review_member_identity_recovery(
  p_company_id uuid,p_compute_identity_id uuid,p_target_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_role text; v_identity public.qorpera_member_compute_identities%rowtype;
  v_target public.qorpera_identity_recovery_targets%rowtype;
  v_backup public.qorpera_identity_key_backups%rowtype;
  v_recovery public.qorpera_identity_recoveries%rowtype;
  v_review jsonb; v_ready boolean; v_owner boolean;
begin
  v_role:=public.qorpera_recovery_member_role(p_company_id);
  select * into v_identity from public.qorpera_member_compute_identities where id=p_compute_identity_id
    and profile_id=p_company_id and (v_role='owner' or owner_user_id=auth.uid()) for share;
  if not found then raise exception 'Recovery identity is unavailable' using errcode='42501'; end if;
  select * into v_target from public.qorpera_identity_recovery_targets where id=p_target_id
    and profile_id=p_company_id and compute_identity_id=p_compute_identity_id for share;
  if not found then raise exception 'Recovery target is unavailable' using errcode='42501'; end if;
  select * into v_recovery from public.qorpera_identity_recoveries where target_id=p_target_id for share;
  -- Existing consent reviews show the originally approved backup, never substitute
  -- the newest backup under a pending human decision.
  select * into v_backup from public.qorpera_identity_key_backups
    where compute_identity_id=p_compute_identity_id and status='ready'
      and (v_recovery.id is null or revision=v_recovery.backup_revision)
    order by revision desc limit 1 for share;
  v_owner:=v_role='owner';
  v_ready:=v_identity.status='active' and v_target.status='active'
    and v_target.expires_at>clock_timestamp() and v_backup.revision is not null
    and v_backup.authority_id=v_target.authority_id
    and v_backup.policy_sha256=public.qorpera_compute_policy_sha256(v_identity.policy)
    and not exists(select 1 from public.qorpera_identity_key_backups newer
      where newer.compute_identity_id=p_compute_identity_id and newer.status='ready' and newer.revision>v_backup.revision)
    and exists(select 1 from public.qorpera_identity_recovery_authorities
      where id=v_target.authority_id and profile_id=p_company_id and status='active');
  v_review:=jsonb_build_object(
    'companyId',p_company_id,'viewerUserId',auth.uid(),
    'identity',jsonb_build_object('computeIdentityId',v_identity.id,'displayName',v_identity.display_name,
      'ownershipKind',v_identity.ownership_kind,'ownerUserId',v_identity.owner_user_id,'status',v_identity.status,
      'epoch',v_identity.recovery_epoch,'blocked',v_identity.recovery_pending_id is not null),
    'target',jsonb_build_object('targetId',v_target.id,'nodeId',v_target.node_id,'authorityId',v_target.authority_id,
      'imageSha256',v_target.image_sha256,'guestManifestSha256',v_target.guest_manifest_sha256,
      'recipientKeySha256',v_target.recipient_key_sha256,'status',v_target.status,
      'expiresAt',to_char(v_target.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'backup',case when v_backup.revision is null then null else jsonb_build_object(
      'revision',v_backup.revision,'objectSha256',v_backup.object_sha256,'objectBytes',v_backup.object_bytes,
      'authorityId',v_backup.authority_id,'policySha256',v_backup.policy_sha256) end,
    'recovery',case when v_recovery.id is null then null else public.qorpera_identity_recovery_json(v_recovery) end,
    'canRequest',coalesce(v_ready and v_owner and v_recovery.id is null and not exists(
      select 1 from public.qorpera_identity_recoveries pending where pending.id=v_identity.recovery_pending_id
        and pending.status not in ('completed','cancelled') and pending.expires_at>clock_timestamp()),false),
    'canConsent',coalesce(v_ready and v_recovery.status='awaiting_member'
      and v_identity.ownership_kind='member' and v_identity.owner_user_id=auth.uid()
      and v_recovery.expires_at>clock_timestamp(),false),
    'canCancel',coalesce(v_recovery.status not in ('completed','cancelled')
      and (v_owner or v_identity.owner_user_id=auth.uid()),false));
  return jsonb_build_object('schema','qorpera.member-identity-recovery-review/v1','review',v_review,
    'reviewSha256',encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'));
end
$$;

create function public.qorpera_decide_member_identity_recovery(
  p_company_id uuid,p_compute_identity_id uuid,p_target_id uuid,p_review_sha256 text,
  p_decision text,p_client_request_id uuid default null,p_storage_source text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_review jsonb; v_body jsonb;
begin
  v_review:=public.qorpera_review_member_identity_recovery(p_company_id,p_compute_identity_id,p_target_id);
  if p_review_sha256 is null or p_review_sha256 is distinct from v_review->>'reviewSha256' then
    raise exception 'Recovery review changed; inspect it again' using errcode='40001'; end if;
  v_body:=v_review->'review';
  if p_decision='request' then
    if not (v_body->>'canRequest')::boolean or p_client_request_id is null
      or p_storage_source is null or p_storage_source not in ('nas','supabase') then
      raise exception 'Recovery request is unavailable' using errcode='42501'; end if;
    return public.qorpera_request_identity_recovery(p_compute_identity_id,p_target_id,p_client_request_id,
      (v_body->'backup'->>'revision')::bigint,v_body->'backup'->>'objectSha256',p_storage_source);
  end if;
  if p_client_request_id is not null or p_storage_source is not null then
    raise exception 'Recovery decision fields are invalid' using errcode='22023'; end if;
  if p_decision='consent' and (v_body->>'canConsent')::boolean then
    return public.qorpera_consent_identity_recovery((v_body->'recovery'->>'recoveryId')::uuid);
  elsif p_decision='cancel' and (v_body->>'canCancel')::boolean then
    return public.qorpera_cancel_identity_recovery((v_body->'recovery'->>'recoveryId')::uuid);
  end if;
  raise exception 'Recovery decision is unavailable' using errcode='42501';
end
$$;

revoke all on function public.qorpera_recovery_member_role(uuid),
  public.qorpera_list_member_recovery_identities(uuid,uuid,integer),
  public.qorpera_list_member_recovery_targets(uuid,uuid,uuid,integer),
  public.qorpera_review_member_identity_recovery(uuid,uuid,uuid),
  public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.qorpera_list_member_recovery_identities(uuid,uuid,integer),
  public.qorpera_list_member_recovery_targets(uuid,uuid,uuid,integer),
  public.qorpera_review_member_identity_recovery(uuid,uuid,uuid),
  public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text) to authenticated;
