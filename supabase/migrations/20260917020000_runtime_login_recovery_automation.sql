-- 2026-09-17 amendment: a member login of an established identity on a node
-- that lacks its identity volume completes without operator work.
-- (1) Logins follow the identity home: the gateway chooser prefers an eligible
--     gateway on a node where a login of that identity completed before.
-- (2) Node registrars: a runtime node's login gateway may register recovery
--     targets for guests on its own node with a per-node registrar capability
--     enrolled by the operator (the operator route remains for replacements).
-- (3) The login is the consent: the member who began the login may recover
--     their own member-owned identity for that login; a company owner may
--     recover any identity of the company for a login they began. The node's
--     gateway requests it on the login's behalf (service role, login-bound).

-- (1) Home-affine gateway choice ------------------------------------------
create function public.qorpera_runtime_login_identity_homes(p_compute_identity_id uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
	select coalesce(array_agg(distinct p.node_id),'{}') from public.qorpera_runtime_machine_allocations a
	join public.qorpera_native_provider_login_sessions s on s.id=a.login_session_id and s.status='completed'
	join public.qorpera_runtime_node_providers p on p.provider_kind='native' and p.provider_id=a.provider_adapter
	where a.login_compute_identity_id=p_compute_identity_id
$$;

create function public.qorpera_runtime_login_gateway_choose(p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_candidates jsonb; v_pick jsonb; v_gateway public.qorpera_runtime_login_gateways%rowtype; v_reason text;
	v_session public.qorpera_native_provider_login_sessions%rowtype; v_homes uuid[]:='{}';
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Login gateway authority required' using errcode='42501';
	end if;
	if p_capability_sha256 is not null and p_capability_sha256 ~ '^[0-9a-f]{64}$' then
		select * into v_session from public.qorpera_native_provider_login_sessions
			where capability_sha256=p_capability_sha256 and status='pending' and expires_at>clock_timestamp()
			order by created_at desc limit 1;
		if found then v_homes:=public.qorpera_runtime_login_identity_homes(v_session.compute_identity_id); end if;
	end if;
	v_candidates := public.qorpera_runtime_node_placement_candidates('login');
	if cardinality(v_homes)>0 then
		select c into v_pick from jsonb_array_elements(v_candidates) c
			join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
			where (c->>'eligible')::boolean and (c->>'fits')::boolean and (c->>'nodeId')::uuid = any(v_homes)
			order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
			limit 1;
		if v_pick is not null then v_reason:='IDENTITY_HOME'; end if;
	end if;
	if v_pick is null then
		select c into v_pick from jsonb_array_elements(v_candidates) c
			join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
			where (c->>'eligible')::boolean and (c->>'fits')::boolean
			order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
			limit 1;
		if v_pick is not null then v_reason:=case when cardinality(v_homes)>0 then 'HOME_UNAVAILABLE_LEAST_LOADED' else 'LEAST_LOADED' end; end if;
	end if;
	if v_pick is not null then
		select * into v_gateway from public.qorpera_runtime_login_gateways where provider_id = v_pick->>'providerId';
	else
		select * into v_gateway from public.qorpera_runtime_login_gateways order by registered_at desc, provider_id limit 1;
		v_reason := 'NO_ELIGIBLE_NODE';
	end if;
	if v_gateway.provider_id is null then return jsonb_build_object('url', null, 'reason', 'NO_GATEWAY', 'identityHomes', to_jsonb(v_homes)); end if;
	return jsonb_build_object('url', v_gateway.url, 'providerId', v_gateway.provider_id, 'nodeId', v_gateway.node_id, 'reason', v_reason,
		'identityHomes', to_jsonb(v_homes));
end
$$;

-- (2) Node registrars -------------------------------------------------------
create table public.qorpera_identity_recovery_registrars (
	node_id uuid primary key references public.qorpera_runtime_nodes(id) on delete restrict,
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active','revoked')),
	enrolled_at timestamptz not null default clock_timestamp(),
	revoked_at timestamptz
);
alter table public.qorpera_identity_recovery_registrars enable row level security;
revoke all on public.qorpera_identity_recovery_registrars from public,anon,authenticated,service_role;

-- Operator enrolment (service role, operator lane): one active registrar per node; re-enrolment rotates the capability.
create function public.qorpera_enroll_identity_recovery_registrar(p_node_id uuid,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_identity_recovery_registrars%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Registrar enrolment requires the operator' using errcode='42501'; end if;
	if p_node_id is null or p_capability_sha256 is null or p_capability_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Registrar enrolment is invalid' using errcode='22023'; end if;
	perform 1 from public.qorpera_runtime_nodes where id=p_node_id;
	if not found then raise exception 'Registrar node is unknown' using errcode='42501'; end if;
	insert into public.qorpera_identity_recovery_registrars(node_id,capability_sha256) values(p_node_id,p_capability_sha256)
	on conflict (node_id) do update set capability_sha256=excluded.capability_sha256,status='active',enrolled_at=clock_timestamp(),revoked_at=null
	returning * into v_row;
	return jsonb_build_object('nodeId',v_row.node_id,'status',v_row.status,'enrolledAt',v_row.enrolled_at);
end
$$;

create function public.qorpera_revoke_identity_recovery_registrar(p_node_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_identity_recovery_registrars%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Registrar revocation requires the operator' using errcode='42501'; end if;
	update public.qorpera_identity_recovery_registrars set status='revoked',revoked_at=clock_timestamp() where node_id=p_node_id returning * into v_row;
	if not found then raise exception 'Registrar node is unknown' using errcode='42501'; end if;
	return jsonb_build_object('nodeId',v_row.node_id,'status',v_row.status,'revokedAt',v_row.revoked_at);
end
$$;

-- Registration through a node registrar: the recovery service forwards the
-- registrar's node and capability; the target must be on that node.
create function public.qorpera_register_identity_recovery_target(
	p_authority_id uuid,p_service_capability_sha256 text,p_target_id uuid,p_compute_identity_id uuid,
	p_node_id uuid,p_image_sha256 text,p_guest_manifest_sha256 text,p_recipient_public_key text,
	p_target_capability_sha256 text,p_registrar_node_id uuid,p_registrar_capability_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_registrar public.qorpera_identity_recovery_registrars%rowtype;
begin
	perform public.qorpera_recovery_service(p_authority_id,p_service_capability_sha256);
	if p_registrar_node_id is null or p_registrar_capability_sha256 is null or p_registrar_capability_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'recovery registrar is invalid' using errcode='22023'; end if;
	select * into v_registrar from public.qorpera_identity_recovery_registrars where node_id=p_registrar_node_id for share;
	if not found or v_registrar.status<>'active' or v_registrar.capability_sha256<>p_registrar_capability_sha256 then
		raise exception 'recovery registrar is unavailable' using errcode='42501'; end if;
	if p_node_id is distinct from p_registrar_node_id then
		raise exception 'recovery registrar may only register its own node' using errcode='42501'; end if;
	return public.qorpera_register_identity_recovery_target(p_authority_id,p_service_capability_sha256,p_target_id,p_compute_identity_id,
		p_node_id,p_image_sha256,p_guest_manifest_sha256,p_recipient_public_key,p_target_capability_sha256)
		|| jsonb_build_object('registrarNodeId',p_registrar_node_id);
end
$$;

-- (3) Login-bound recovery request ------------------------------------------
-- Requested by the node's login gateway (service role) for a pending login of
-- the identity; the requester of record is the member who began the login.
create function public.qorpera_request_login_identity_recovery(p_login_id uuid,p_target_id uuid,p_client_request_id uuid,p_storage_source text default 'nas')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_native_provider_login_sessions%rowtype; v_identity public.qorpera_member_compute_identities%rowtype;
	v_target public.qorpera_identity_recovery_targets%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
	v_recovery public.qorpera_identity_recoveries%rowtype; v_authority public.qorpera_identity_recovery_authorities%rowtype;
	v_user uuid; v_owner boolean; v_self boolean;
begin
	if auth.role() is distinct from 'service_role' or p_login_id is null or p_client_request_id is null
		or p_storage_source is null or p_storage_source not in ('nas','supabase') then
		raise exception 'login recovery requires the node gateway' using errcode='42501'; end if;
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for share;
	if not found or v_session.status<>'pending' or v_session.expires_at<=clock_timestamp() then
		raise exception 'login recovery requires a pending login' using errcode='42501'; end if;
	v_user:=v_session.requested_by_user_id;
	select * into v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id;
	if not found then raise exception 'recovery identity is unavailable' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
	v_owner:=exists(select 1 from public.qorpera_profile_members where profile_id=v_identity.profile_id and user_id=v_user and role='owner');
	v_self:=v_identity.ownership_kind='member' and v_identity.owner_user_id=v_user;
	if v_identity.status<>'active' or not (v_owner or v_self) then
		raise exception 'login recovery requires the identity owner or a company owner' using errcode='42501'; end if;
	select * into v_recovery from public.qorpera_identity_recoveries
		where profile_id=v_identity.profile_id and client_request_id=p_client_request_id;
	if found then
		if v_recovery.compute_identity_id<>v_identity.id or v_recovery.target_id<>p_target_id or v_recovery.owner_user_id<>v_user
			or v_recovery.storage_source<>p_storage_source then
			raise exception 'recovery request id is already bound' using errcode='23505'; end if;
	else
		select target.* into v_target from public.qorpera_identity_recovery_targets target
		join public.qorpera_identity_recovery_authorities authority on authority.id=target.authority_id and authority.status='active'
		where target.id=p_target_id and target.compute_identity_id=v_identity.id and target.profile_id=v_identity.profile_id
			and target.status='active' and target.expires_at>clock_timestamp() for share of target,authority;
		select * into v_backup from public.qorpera_identity_key_backups where compute_identity_id=v_identity.id
			and status='ready' order by revision desc limit 1 for share;
		if v_target.id is null or v_backup.revision is null or v_backup.authority_id<>v_target.authority_id
			or v_backup.policy_sha256<>public.qorpera_compute_policy_sha256(v_identity.policy) then
			raise exception 'recovery target or current backup is unavailable' using errcode='42501'; end if;
		insert into public.qorpera_identity_recoveries(client_request_id,profile_id,compute_identity_id,authority_id,
			backup_revision,storage_source,target_id,owner_user_id,member_consent_user_id,status,expires_at)
		values(p_client_request_id,v_identity.profile_id,v_identity.id,v_target.authority_id,v_backup.revision,
			p_storage_source,v_target.id,v_user,case when v_self then v_user else null end,'awaiting_member',v_target.expires_at)
		returning * into v_recovery;
		if v_identity.ownership_kind<>'member' or v_self then
			v_recovery:=public.qorpera_activate_identity_recovery(v_recovery.id);
		end if;
	end if;
	select * into v_backup from public.qorpera_identity_key_backups where compute_identity_id=v_identity.id and revision=v_recovery.backup_revision;
	select * into v_authority from public.qorpera_identity_recovery_authorities where id=v_recovery.authority_id;
	return public.qorpera_identity_recovery_json(v_recovery)||jsonb_build_object('loginId',v_session.id,'requestedByUserId',v_user,
		'backupSha256',v_backup.object_sha256,'authorityId',v_authority.id,'serviceOrigin',v_authority.service_origin,
		'signingPublicKey',v_authority.signing_public_key);
end
$$;

revoke all on function public.qorpera_runtime_login_identity_homes(uuid),public.qorpera_runtime_login_gateway_choose(text),
	public.qorpera_enroll_identity_recovery_registrar(uuid,text),public.qorpera_revoke_identity_recovery_registrar(uuid),
	public.qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text,uuid,text),
	public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_login_gateway_choose(text),
	public.qorpera_enroll_identity_recovery_registrar(uuid,text),public.qorpera_revoke_identity_recovery_registrar(uuid),
	public.qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text,uuid,text),
	public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text) to service_role;
