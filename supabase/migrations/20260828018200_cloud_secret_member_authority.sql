-- Forward-only Step 2 correction. A missing membership must deny authority,
-- never become SQL NULL and fall through a SECURITY DEFINER check. Preserve
-- the signed custody baseline; upgrade its three member-facing operations.

create or replace function public.qorpera_grant_cloud_secret_operation(
	p_profile_id uuid,p_environment_id uuid,p_secret_id uuid,p_staff_agent_id uuid,
	p_connector_id text,p_operation_id text,p_operation_version bigint,
	p_expires_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_role public.qorpera_profile_role;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_operation public.qorpera_cloud_connector_operations%rowtype;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role = 'viewer' then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;
	if not found or v_secret.status <> 'active'
		or (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and v_secret.owner_user_id is distinct from v_user_id)
		or (p_expires_at is not null and p_expires_at <= clock_timestamp()) then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_staff staff where staff.profile_id = p_profile_id
		and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active' for share;
	if not found then raise exception 'secret grant agent is unavailable' using errcode = '42501'; end if;
	select operation.* into v_operation from public.qorpera_cloud_connector_operations operation
	where operation.connector_id = p_connector_id and operation.operation_id = p_operation_id
		and operation.version = p_operation_version and operation.status = 'active' for share;
	if not found or v_operation.connector_id <> v_secret.connector_id then
		raise exception 'connector operation does not match the secret' using errcode = '22023'; end if;
	insert into public.qorpera_cloud_secret_operation_grants(
		profile_id,environment_id,secret_id,staff_agent_id,connector_id,operation_id,
		operation_version,tool_name,issued_by_user_id,expires_at)
	values (p_profile_id,p_environment_id,p_secret_id,p_staff_agent_id,p_connector_id,p_operation_id,
		p_operation_version,v_operation.tool_name,v_user_id,p_expires_at) returning * into v_grant;
	insert into public.qorpera_cloud_secret_audit_events(
		profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id)
	values (p_profile_id,p_environment_id,p_secret_id,v_secret.current_version,v_grant.id,
		'grant_issued',v_user_id,p_connector_id,p_operation_id);
	return jsonb_build_object('schema','qorpera.cloud-secret-grant/v1','grantId',v_grant.id,'secretId',p_secret_id,
		'staffAgentId',p_staff_agent_id,'toolName',v_grant.tool_name,'connectorId',p_connector_id,
		'operationId',p_operation_id,'operationVersion',p_operation_version,
		'status',v_grant.status,'expiresAt',v_grant.expires_at);
end
$$;

create or replace function public.qorpera_revoke_cloud_secret_grant(p_profile_id uuid,p_grant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_role public.qorpera_profile_role;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	select grant_row.* into v_grant from public.qorpera_cloud_secret_operation_grants grant_row
	where grant_row.id = p_grant_id and grant_row.profile_id = p_profile_id for update;
	if not found then raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets secret where secret.id = v_grant.secret_id;
	if (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and v_secret.owner_user_id is distinct from v_user_id) then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	if v_grant.status = 'active' then
		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where id = v_grant.id returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events(
			profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id)
		values (v_grant.profile_id,v_grant.environment_id,v_grant.secret_id,v_secret.current_version,v_grant.id,
			'grant_revoked',v_user_id,v_grant.connector_id,v_grant.operation_id);
	end if;
	return jsonb_build_object('schema','qorpera.cloud-secret-grant/v1','grantId',v_grant.id,'status',v_grant.status);
end
$$;

create or replace function public.qorpera_revoke_cloud_secret(p_profile_id uuid,p_secret_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_role public.qorpera_profile_role;
	v_secret public.qorpera_cloud_secrets%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;
	if not found or (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and v_secret.owner_user_id is distinct from v_user_id) then
		raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	if v_secret.status = 'active' then
		update public.qorpera_cloud_secrets set status = 'revoked',revoked_at = statement_timestamp(),
			revoked_by_user_id = v_user_id,updated_at = statement_timestamp() where id = v_secret.id returning * into v_secret;
		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';
		insert into public.qorpera_cloud_secret_audit_events(
			profile_id,environment_id,secret_id,secret_version,event_type,actor_user_id,connector_id)
		values (v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,
			'secret_revoked',v_user_id,v_secret.connector_id);
	end if;
	return jsonb_build_object('schema','qorpera.cloud-secret-descriptor/v1','secretId',v_secret.id,'status',v_secret.status);
end
$$;

-- Serialize capture admission at the INSERT boundary. The earlier capture
-- RPC's unlocked role read alone can race a downgrade: revocation sees no
-- uncommitted ticket, then the stale ticket commits after access was removed.
create function public.qorpera_require_secret_capture_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role;
begin
	select role into v_role from public.qorpera_profile_members
	where profile_id = new.profile_id and user_id = new.created_by_user_id for share;
	if v_role is null or v_role = 'viewer'
		or (new.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (new.owner_kind = 'member' and new.owner_user_id is distinct from new.created_by_user_id) then
		raise exception 'secret capture membership is unavailable' using errcode = '42501'; end if;
	return new;
end
$$;
create trigger qorpera_cloud_secret_capture_membership
before insert on public.qorpera_cloud_secret_capture_tickets
for each row execute function public.qorpera_require_secret_capture_membership();

-- Lost membership/issuing authority is a durable revocation, not a suspended
-- grant or capture ticket that silently revives after invitation/promotion.
create function public.qorpera_revoke_secret_grants_on_membership_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_cloud_secret_capture_tickets ticket set status = 'cancelled'
	where ticket.profile_id = old.profile_id and ticket.created_by_user_id = old.user_id and ticket.status = 'pending'
		and (tg_op = 'DELETE' or (ticket.owner_kind = 'company' and new.role not in ('owner','admin'))
			or (ticket.owner_kind = 'member' and new.role = 'viewer'));
	with revoked as (
		update public.qorpera_cloud_secret_operation_grants grant_row
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = auth.uid()
		from public.qorpera_cloud_secrets secret
		where secret.id = grant_row.secret_id and grant_row.profile_id = old.profile_id
			and grant_row.issued_by_user_id = old.user_id and grant_row.status = 'active'
			and (tg_op = 'DELETE' or (secret.owner_kind = 'company' and new.role not in ('owner','admin'))
				or (secret.owner_kind = 'member' and new.role = 'viewer'))
		returning grant_row.*,secret.current_version
	)
	insert into public.qorpera_cloud_secret_audit_events(
		profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id)
	select profile_id,environment_id,secret_id,current_version,id,'grant_revoked',auth.uid(),connector_id,operation_id
	from revoked;
	if tg_op = 'DELETE' then return old; end if;
	return new;
end
$$;
create trigger qorpera_cloud_secret_membership_authority
after update of role or delete on public.qorpera_profile_members
for each row execute function public.qorpera_revoke_secret_grants_on_membership_change();

-- Quarantine pre-correction grants/tickets whose issuer no longer has authority.
-- Keep their rows and audit history; never rewrite a credential or resurrect one.
update public.qorpera_cloud_secret_capture_tickets ticket set status = 'cancelled'
where ticket.status = 'pending' and not exists (
	select 1 from public.qorpera_profile_members member
	where member.profile_id = ticket.profile_id and member.user_id = ticket.created_by_user_id
		and ((ticket.owner_kind = 'company' and member.role in ('owner','admin'))
			or (ticket.owner_kind = 'member' and ticket.owner_user_id = member.user_id and member.role <> 'viewer'))
);
with revoked as (
	update public.qorpera_cloud_secret_operation_grants grant_row
	set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = null
	from public.qorpera_cloud_secrets secret
	where secret.id = grant_row.secret_id and grant_row.status = 'active' and not exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = grant_row.profile_id and member.user_id = grant_row.issued_by_user_id
			and ((secret.owner_kind = 'company' and member.role in ('owner','admin'))
				or (secret.owner_kind = 'member' and secret.owner_user_id = member.user_id and member.role <> 'viewer'))
	) returning grant_row.*,secret.current_version
)
insert into public.qorpera_cloud_secret_audit_events(
	profile_id,environment_id,secret_id,secret_version,grant_id,event_type,connector_id,operation_id)
select profile_id,environment_id,secret_id,current_version,id,'grant_revoked',connector_id,operation_id from revoked;

revoke all on function public.qorpera_revoke_secret_grants_on_membership_change(),public.qorpera_require_secret_capture_membership()
	from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz),
	public.qorpera_revoke_cloud_secret_grant(uuid,uuid),public.qorpera_revoke_cloud_secret(uuid,uuid)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz),
	public.qorpera_revoke_cloud_secret_grant(uuid,uuid),public.qorpera_revoke_cloud_secret(uuid,uuid) to authenticated;
