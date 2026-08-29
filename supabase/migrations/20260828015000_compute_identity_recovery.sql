-- Private recovery authority. No private key or provider credential is stored in SQL.
-- A separate cloud service holds the wrapping/signing keys and its own control
-- capability. The ordinary service role cannot read or mutate this registry.

create table public.qorpera_identity_recovery_authorities (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	signing_public_key text not null check (length(signing_public_key) between 50 and 1024 and signing_public_key ~ '^[A-Za-z0-9_-]+$'),
	wrapping_public_key text not null check (length(wrapping_public_key) between 400 and 1024 and wrapping_public_key ~ '^[A-Za-z0-9_-]+$'),
	service_origin text not null check (service_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active','revoked')),
	created_at timestamptz not null default clock_timestamp(),
	unique (profile_id,id)
);
create unique index qorpera_identity_recovery_authority_active
	on public.qorpera_identity_recovery_authorities(profile_id) where status = 'active';

alter table public.qorpera_member_compute_identities
	add column recovery_epoch bigint not null default 0 check (recovery_epoch between 0 and 9007199254740991),
	add column recovery_pending_id uuid;
alter table public.qorpera_execution_runs
	add column compute_recovery_epoch bigint not null default 0 check (compute_recovery_epoch between 0 and 9007199254740991);
alter table public.qorpera_runners
	add column compute_recovery_epoch bigint not null default 0 check (compute_recovery_epoch between 0 and 9007199254740991);
alter table public.qorpera_native_provider_login_sessions
	add column compute_recovery_epoch bigint not null default 0 check (compute_recovery_epoch between 0 and 9007199254740991);

-- Default table grants must not let an ordinary host reset the recovery fence.
-- Preserve its pre-existing column access; only security-definer recovery
-- functions may write the two new identity fields.
revoke insert,update on public.qorpera_member_compute_identities from public,anon,authenticated,service_role;
do $$
declare v_columns text;
begin
	select string_agg(quote_ident(attname),',' order by attnum) into v_columns
	from pg_attribute where attrelid='public.qorpera_member_compute_identities'::regclass
		and attnum>0 and not attisdropped and attname not in ('recovery_epoch','recovery_pending_id');
	execute format('grant insert (%s),update (%s) on public.qorpera_member_compute_identities to service_role',v_columns,v_columns);
end
$$;

create table public.qorpera_identity_key_backups (
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	revision bigint not null check (revision between 1 and 9007199254740991),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	authority_id uuid not null,
	source_login_id uuid not null references public.qorpera_native_provider_login_sessions(id) on delete restrict,
	policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
	key_sha256 text not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'prepared' check (status in ('prepared','ready')),
	object_sha256 text check (object_sha256 ~ '^[0-9a-f]{64}$'),
	object_bytes integer check (object_bytes between 1 and 16384),
	created_at timestamptz not null default clock_timestamp(),
	verified_at timestamptz,
	primary key (compute_identity_id,revision),
	foreign key (profile_id,authority_id) references public.qorpera_identity_recovery_authorities(profile_id,id),
	check ((status = 'ready') = (object_sha256 is not null and object_bytes is not null and verified_at is not null))
);

create table public.qorpera_identity_recovery_targets (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	authority_id uuid not null,
	node_id uuid not null,
	image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
	guest_manifest_sha256 text not null check (guest_manifest_sha256 ~ '^[0-9a-f]{64}$'),
	recipient_public_key text not null check (length(recipient_public_key) between 400 and 1024 and recipient_public_key ~ '^[A-Za-z0-9_-]+$'),
	recipient_key_sha256 text not null check (recipient_key_sha256 ~ '^[0-9a-f]{64}$'),
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active','revoked')),
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	foreign key (profile_id,authority_id) references public.qorpera_identity_recovery_authorities(profile_id,id),
	check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);

create table public.qorpera_identity_recoveries (
	id uuid primary key default extensions.gen_random_uuid(),
	client_request_id uuid not null,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	authority_id uuid not null,
	backup_revision bigint not null,
	storage_source text not null check (storage_source in ('nas','supabase')),
	target_id uuid not null unique references public.qorpera_identity_recovery_targets(id) on delete restrict,
	owner_user_id uuid not null references auth.users(id) on delete restrict,
	member_consent_user_id uuid references auth.users(id) on delete restrict,
	status text not null check (status in ('awaiting_member','approved','released','completed','cancelled')),
	epoch bigint check (epoch between 1 and 9007199254740991),
	not_before timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	release_issued_at timestamptz,
	release_expires_at timestamptz,
	release_sha256 text check (release_sha256 ~ '^[0-9a-f]{64}$'),
	release_bytes integer check (release_bytes between 1 and 16384),
	receipt_id uuid unique,
	proof_sha256 text check (proof_sha256 ~ '^[0-9a-f]{64}$'),
	completed_at timestamptz,
	unique (profile_id,client_request_id),
	foreign key (profile_id,authority_id) references public.qorpera_identity_recovery_authorities(profile_id,id),
	foreign key (compute_identity_id,backup_revision) references public.qorpera_identity_key_backups(compute_identity_id,revision),
	check (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
	check ((receipt_id is not null) = (status = 'completed')),
	check ((completed_at is not null) = (status = 'completed')),
	check ((proof_sha256 is not null) = (status = 'completed')),
	check ((epoch is null) = (not_before is null)),
	check ((release_issued_at is null) = (release_expires_at is null)),
	check (release_expires_at is null or (release_expires_at > release_issued_at and release_expires_at <= release_issued_at + interval '60 seconds'))
);
alter table public.qorpera_member_compute_identities add foreign key (recovery_pending_id)
	references public.qorpera_identity_recoveries(id) on delete restrict;

alter table public.qorpera_identity_recovery_authorities enable row level security;
alter table public.qorpera_identity_key_backups enable row level security;
alter table public.qorpera_identity_recovery_targets enable row level security;
alter table public.qorpera_identity_recoveries enable row level security;
revoke all on public.qorpera_identity_recovery_authorities, public.qorpera_identity_key_backups,
	public.qorpera_identity_recovery_targets, public.qorpera_identity_recoveries
	from public, anon, authenticated, service_role;

create table public.qorpera_identity_backup_login_receipts (
	login_id uuid primary key references public.qorpera_native_provider_login_sessions(id) on delete restrict,
	compute_identity_id uuid not null,
	revision bigint not null,
	verified_at timestamptz not null default clock_timestamp(),
	foreign key (compute_identity_id,revision) references public.qorpera_identity_key_backups(compute_identity_id,revision)
);
alter table public.qorpera_identity_backup_login_receipts enable row level security;
revoke all on public.qorpera_identity_backup_login_receipts from public,anon,authenticated,service_role;

insert into storage.buckets(id,name,public,file_size_limit)
values ('qorpera-identity-recovery','qorpera-identity-recovery',false,16384)
on conflict (id) do update set public = false, file_size_limit = 16384;

create function public.qorpera_recovery_public_key_sha256(p_key text)
returns text language plpgsql immutable set search_path = '' as $$
begin
	if p_key is null or length(p_key) not between 50 and 1024 or p_key !~ '^[A-Za-z0-9_-]+$' then
		raise exception 'recovery public key is invalid' using errcode = '22023'; end if;
	return encode(extensions.digest(decode(translate(p_key,'-_','+/') || repeat('=',(4-length(p_key)%4)%4),'base64'),'sha256'),'hex');
end
$$;

create function public.qorpera_recovery_service(p_authority_id uuid,p_capability_sha256 text)
returns public.qorpera_identity_recovery_authorities language plpgsql security definer set search_path = '' as $$
declare v_authority public.qorpera_identity_recovery_authorities%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_capability_sha256 is null then
		raise exception 'recovery service authority is required' using errcode = '42501'; end if;
	select * into v_authority from public.qorpera_identity_recovery_authorities
	where id = p_authority_id and capability_sha256 = p_capability_sha256 and status = 'active' for share;
	if not found then raise exception 'recovery service authority is unavailable' using errcode = '42501'; end if;
	return v_authority;
end
$$;

create function public.qorpera_identity_backup_json(p_backup public.qorpera_identity_key_backups)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('binding',jsonb_build_object(
		'companyId',p_backup.profile_id,'computeIdentityId',p_backup.compute_identity_id,
		'authorityId',p_backup.authority_id,'revision',p_backup.revision,
		'policySha256',p_backup.policy_sha256,'keySha256',p_backup.key_sha256,
		'wrappingKeySha256',public.qorpera_recovery_public_key_sha256(authority.wrapping_public_key)),
		'status',p_backup.status,'objectSha256',p_backup.object_sha256,'objectBytes',p_backup.object_bytes)
	from public.qorpera_identity_recovery_authorities authority where authority.id = p_backup.authority_id
$$;

create function public.qorpera_identity_recovery_service_configuration(p_authority_id uuid,p_service_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_authority public.qorpera_identity_recovery_authorities%rowtype;
begin
	v_authority:=public.qorpera_recovery_service(p_authority_id,p_service_capability_sha256);
	return jsonb_build_object('companyId',v_authority.profile_id,'authorityId',v_authority.id,
		'signingPublicKey',v_authority.signing_public_key,'wrappingPublicKey',v_authority.wrapping_public_key);
end
$$;

create function public.qorpera_identity_recovery_authority_immutable()
returns trigger language plpgsql security definer set search_path='' as $$
begin
	if row(new.id,new.profile_id,new.signing_public_key,new.wrapping_public_key,new.service_origin,new.capability_sha256)
		is distinct from row(old.id,old.profile_id,old.signing_public_key,old.wrapping_public_key,old.service_origin,old.capability_sha256) then
		raise exception 'Recovery authority requires a new explicit identity for rotation' using errcode='42501';
	end if;
	return new;
end
$$;
create trigger qorpera_identity_recovery_authority_immutable before update on public.qorpera_identity_recovery_authorities
for each row execute function public.qorpera_identity_recovery_authority_immutable();

create function public.qorpera_prepare_identity_key_backup(
	p_authority_id uuid,p_service_capability_sha256 text,p_login_id uuid,p_login_capability_sha256 text,p_key_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_identity_recovery_authorities%rowtype;
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_backup public.qorpera_identity_key_backups%rowtype;
	v_revision bigint;
begin
	v_authority := public.qorpera_recovery_service(p_authority_id,p_service_capability_sha256);
	if p_key_sha256 is null or p_key_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'recovery key commitment is invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	select * into v_login from public.qorpera_native_provider_login_sessions
	where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
		and status in ('pending','completed') and expires_at > clock_timestamp() for share;
	if not found then raise exception 'recovery source login is unavailable' using errcode = '42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities
	where id = v_login.compute_identity_id and profile_id = v_authority.profile_id and status = 'active'
		and recovery_pending_id is null for update;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = v_identity.profile_id and user_id = v_login.requested_by_user_id
			and (v_identity.ownership_kind = 'member' and user_id = v_identity.owner_user_id
				or v_identity.ownership_kind <> 'member' and role in ('owner','admin'))) then
		raise exception 'recovery source identity is unavailable' using errcode = '42501'; end if;
	if v_login.compute_recovery_epoch <> v_identity.recovery_epoch then
		raise exception 'recovery source login generation changed' using errcode = '42501'; end if;
	-- The same identity cannot silently replace a lost key with a new one.
	if exists(select 1 from public.qorpera_identity_key_backups
		where compute_identity_id = v_identity.id and key_sha256 <> p_key_sha256) then
		raise exception 'identity key commitment changed' using errcode = '42501'; end if;
	select * into v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = v_identity.id
	order by revision desc limit 1;
	if not found or v_backup.authority_id <> v_authority.id
		or v_backup.policy_sha256 <> public.qorpera_compute_policy_sha256(v_identity.policy) then
		select coalesce(max(revision),0)+1 into v_revision from public.qorpera_identity_key_backups
		where compute_identity_id = v_identity.id;
		insert into public.qorpera_identity_key_backups(compute_identity_id,revision,profile_id,authority_id,
			source_login_id,policy_sha256,key_sha256)
		values(v_identity.id,v_revision,v_identity.profile_id,v_authority.id,v_login.id,
			public.qorpera_compute_policy_sha256(v_identity.policy),p_key_sha256) returning * into v_backup;
	end if;
	return public.qorpera_identity_backup_json(v_backup);
end
$$;

create function public.qorpera_complete_identity_key_backup(
	p_authority_id uuid,p_service_capability_sha256 text,p_login_id uuid,p_login_capability_sha256 text,
	p_key_sha256 text,p_revision bigint,p_object_sha256 text,p_object_bytes integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan jsonb; v_backup public.qorpera_identity_key_backups%rowtype;
begin
	if p_object_sha256 is null or p_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_object_bytes is null or p_object_bytes not between 1 and 16384 then
		raise exception 'recovery backup object is invalid' using errcode = '22023'; end if;
	v_plan := public.qorpera_prepare_identity_key_backup(p_authority_id,p_service_capability_sha256,
		p_login_id,p_login_capability_sha256,p_key_sha256);
	if (v_plan->'binding'->>'revision')::bigint is distinct from p_revision then
		raise exception 'recovery backup revision changed' using errcode = '42501'; end if;
	select * into strict v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = (v_plan->'binding'->>'computeIdentityId')::uuid and revision = p_revision for update;
	if v_backup.status = 'ready' then
		if v_backup.object_sha256 <> p_object_sha256 or v_backup.object_bytes <> p_object_bytes then
			raise exception 'recovery backup is already bound' using errcode = '23505'; end if;
	else
		update public.qorpera_identity_key_backups set status = 'ready',object_sha256 = p_object_sha256,
			object_bytes = p_object_bytes,verified_at = clock_timestamp()
		where compute_identity_id = v_backup.compute_identity_id and revision = v_backup.revision returning * into v_backup;
	end if;
	insert into public.qorpera_identity_backup_login_receipts(login_id,compute_identity_id,revision)
	values(p_login_id,v_backup.compute_identity_id,v_backup.revision) on conflict (login_id) do nothing;
	if not exists(select 1 from public.qorpera_identity_backup_login_receipts where login_id=p_login_id
		and compute_identity_id=v_backup.compute_identity_id and revision=v_backup.revision) then
		raise exception 'Login recovery receipt is already bound' using errcode='23505'; end if;
	return public.qorpera_identity_backup_json(v_backup);
end
$$;

-- Registration is an operator-side service action. This function is never
-- granted to a member, runner capability, or model tool.
create function public.qorpera_register_identity_recovery_target(
	p_authority_id uuid,p_service_capability_sha256 text,p_target_id uuid,p_compute_identity_id uuid,
	p_node_id uuid,p_image_sha256 text,p_guest_manifest_sha256 text,p_recipient_public_key text,
	p_target_capability_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority public.qorpera_identity_recovery_authorities%rowtype;
	v_target public.qorpera_identity_recovery_targets%rowtype;
begin
	v_authority := public.qorpera_recovery_service(p_authority_id,p_service_capability_sha256);
	if p_target_id is null or p_node_id is null or p_image_sha256 is null
		or p_image_sha256 !~ '^[0-9a-f]{64}$' or p_guest_manifest_sha256 is null
		or p_guest_manifest_sha256 !~ '^[0-9a-f]{64}$' or p_target_capability_sha256 is null
		or p_target_capability_sha256 !~ '^[0-9a-f]{64}$' or p_recipient_public_key is null
		or length(p_recipient_public_key) not between 400 and 1024 or p_recipient_public_key !~ '^[A-Za-z0-9_-]+$' then
		raise exception 'recovery target is invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	perform 1 from public.qorpera_member_compute_identities where id = p_compute_identity_id
		and profile_id = v_authority.profile_id and status = 'active' for share;
	if not found then raise exception 'recovery identity is unavailable' using errcode = '42501'; end if;
	select * into v_target from public.qorpera_identity_recovery_targets where id = p_target_id for update;
	if found then
		if v_target.profile_id <> v_authority.profile_id or v_target.authority_id <> v_authority.id
			or v_target.compute_identity_id <> p_compute_identity_id or v_target.node_id <> p_node_id
			or v_target.image_sha256 <> p_image_sha256 or v_target.guest_manifest_sha256 <> p_guest_manifest_sha256
			or v_target.recipient_public_key <> p_recipient_public_key or v_target.capability_sha256 <> p_target_capability_sha256 then
			raise exception 'recovery target is already bound' using errcode = '23505'; end if;
	else
		insert into public.qorpera_identity_recovery_targets(id,profile_id,compute_identity_id,authority_id,node_id,
			image_sha256,guest_manifest_sha256,recipient_public_key,recipient_key_sha256,capability_sha256,expires_at)
		values(p_target_id,v_authority.profile_id,p_compute_identity_id,v_authority.id,p_node_id,p_image_sha256,
			p_guest_manifest_sha256,p_recipient_public_key,public.qorpera_recovery_public_key_sha256(p_recipient_public_key),
			p_target_capability_sha256,statement_timestamp()+interval '1 hour') returning * into v_target;
	end if;
	return jsonb_build_object('targetId',v_target.id,'companyId',v_target.profile_id,
		'computeIdentityId',v_target.compute_identity_id,'recipientKeySha256',v_target.recipient_key_sha256,
		'expiresAt',to_char(v_target.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end
$$;

create function public.qorpera_identity_recovery_json(p_recovery public.qorpera_identity_recoveries)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('recoveryId',p_recovery.id,'companyId',p_recovery.profile_id,
		'computeIdentityId',p_recovery.compute_identity_id,'targetId',p_recovery.target_id,
		'backupRevision',p_recovery.backup_revision,'storageSource',p_recovery.storage_source,
		'status',p_recovery.status,'epoch',p_recovery.epoch,
		'notBefore',case when p_recovery.not_before is null then null else
			to_char(p_recovery.not_before at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
		'expiresAt',to_char(p_recovery.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'receiptId',p_recovery.receipt_id)
$$;

create function public.qorpera_activate_identity_recovery(p_recovery_id uuid)
returns public.qorpera_identity_recoveries language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype; v_until timestamptz;
begin
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id;
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = v_recovery.compute_identity_id for update;
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id for update;
	if v_recovery.epoch is not null then return v_recovery; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_recovery.profile_id
		and user_id = v_recovery.owner_user_id and role = 'owner' for share;
	if not found or v_identity.status <> 'active' or v_recovery.status <> 'awaiting_member'
		or v_recovery.expires_at <= clock_timestamp() then
		raise exception 'recovery owner authority is unavailable' using errcode = '42501'; end if;
	if v_identity.ownership_kind = 'member' then
		perform 1 from public.qorpera_profile_members where profile_id = v_recovery.profile_id
			and user_id = v_identity.owner_user_id and user_id = v_recovery.member_consent_user_id for share;
		if not found then raise exception 'recovery member consent is required' using errcode = '42501'; end if;
	end if;
	perform 1 from public.qorpera_identity_key_backups backup
	join public.qorpera_identity_recovery_targets target on target.id = v_recovery.target_id
	join public.qorpera_identity_recovery_authorities authority on authority.id = v_recovery.authority_id
	where backup.compute_identity_id = v_identity.id and backup.revision = v_recovery.backup_revision
		and backup.status = 'ready' and backup.authority_id = authority.id
		and backup.policy_sha256 = public.qorpera_compute_policy_sha256(v_identity.policy)
		and not exists(select 1 from public.qorpera_identity_key_backups newer
			where newer.compute_identity_id = v_identity.id and newer.status = 'ready' and newer.revision > backup.revision)
		and target.profile_id = v_recovery.profile_id and target.compute_identity_id = v_identity.id
		and target.authority_id = authority.id and target.status = 'active' and target.expires_at > clock_timestamp()
		and authority.profile_id = v_recovery.profile_id and authority.status = 'active' for share of backup,target,authority;
	if not found then raise exception 'recovery target or backup changed before consent' using errcode = '42501'; end if;
	if v_identity.recovery_pending_id is not null and exists(select 1 from public.qorpera_identity_recoveries
		where id = v_identity.recovery_pending_id and status not in ('completed','cancelled') and expires_at > clock_timestamp()) then
		raise exception 'identity recovery is already in progress' using errcode = '55000'; end if;
	-- Lease writes take a share lock on this identity, so a concurrent renewal
	-- either commits before this read or observes the newly fenced generation.
	select greatest(clock_timestamp(),coalesce(max(expires_at),clock_timestamp()))+interval '60 seconds'
	into v_until from public.qorpera_native_provider_connection_leases
	where compute_identity_id = v_identity.id and status = 'active';
	if v_until >= v_recovery.expires_at then
		raise exception 'recovery must wait for existing execution authority' using errcode = '55000'; end if;
	update public.qorpera_identity_recoveries set status = 'approved',epoch = v_identity.recovery_epoch+1,not_before = v_until
	where id = v_recovery.id returning * into v_recovery;
	update public.qorpera_member_compute_identities set recovery_epoch = v_recovery.epoch,recovery_pending_id = v_recovery.id
	where id = v_identity.id;
	return v_recovery;
end
$$;

create function public.qorpera_request_identity_recovery(
	p_compute_identity_id uuid,p_target_id uuid,p_client_request_id uuid,p_backup_revision bigint,p_backup_sha256 text,
	p_storage_source text default 'nas'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_target public.qorpera_identity_recovery_targets%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
	v_recovery public.qorpera_identity_recoveries%rowtype; v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_client_request_id is null
		or p_storage_source is null or p_storage_source not in ('nas','supabase') then
		raise exception 'recovery requires a company owner' using errcode = '42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id;
	if not found then raise exception 'recovery identity is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	select * into strict v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id for update;
	perform 1 from public.qorpera_profile_members where profile_id = v_identity.profile_id and user_id = v_user and role = 'owner' for share;
	if not found or v_identity.status <> 'active' then
		raise exception 'recovery requires a current company owner' using errcode = '42501'; end if;
	select * into v_recovery from public.qorpera_identity_recoveries
	where profile_id = v_identity.profile_id and client_request_id = p_client_request_id;
	if found then
		if v_recovery.compute_identity_id <> p_compute_identity_id or v_recovery.target_id <> p_target_id
			or v_recovery.backup_revision is distinct from p_backup_revision or v_recovery.owner_user_id <> v_user
			or v_recovery.storage_source <> p_storage_source
			or not exists(select 1 from public.qorpera_identity_key_backups where compute_identity_id = p_compute_identity_id
				and revision = p_backup_revision and object_sha256 = p_backup_sha256) then
			raise exception 'recovery request id is already bound' using errcode = '23505'; end if;
		return public.qorpera_identity_recovery_json(v_recovery);
	end if;
	select target.* into v_target from public.qorpera_identity_recovery_targets target
	join public.qorpera_identity_recovery_authorities authority on authority.id = target.authority_id and authority.status = 'active'
	where target.id = p_target_id and target.compute_identity_id = p_compute_identity_id
		and target.profile_id = v_identity.profile_id and target.status = 'active' and target.expires_at > clock_timestamp() for share of target,authority;
	select * into v_backup from public.qorpera_identity_key_backups where compute_identity_id = p_compute_identity_id
		and status = 'ready' order by revision desc limit 1 for share;
	if v_target.id is null or v_backup.revision is distinct from p_backup_revision
		or v_backup.object_sha256 is distinct from p_backup_sha256 or v_backup.authority_id <> v_target.authority_id
		or v_backup.policy_sha256 <> public.qorpera_compute_policy_sha256(v_identity.policy) then
		raise exception 'recovery target or current backup is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_identity_recoveries(client_request_id,profile_id,compute_identity_id,authority_id,
		backup_revision,storage_source,target_id,owner_user_id,member_consent_user_id,status,expires_at)
	values(p_client_request_id,v_identity.profile_id,v_identity.id,v_target.authority_id,v_backup.revision,
		p_storage_source,v_target.id,v_user,case when v_identity.owner_user_id = v_user then v_user else null end,'awaiting_member',v_target.expires_at)
	returning * into v_recovery;
	if v_identity.ownership_kind <> 'member' or v_identity.owner_user_id = v_user then
		v_recovery := public.qorpera_activate_identity_recovery(v_recovery.id);
	end if;
	return public.qorpera_identity_recovery_json(v_recovery);
end
$$;

create function public.qorpera_recovery_locked(
	p_authority_id uuid,p_service_capability_sha256 text,p_recovery_id uuid,p_target_capability_sha256 text
) returns public.qorpera_identity_recoveries language plpgsql security definer set search_path = '' as $$
declare v_authority public.qorpera_identity_recovery_authorities%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype; v_recovery public.qorpera_identity_recoveries%rowtype;
	v_target public.qorpera_identity_recovery_targets%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
begin
	v_authority := public.qorpera_recovery_service(p_authority_id,p_service_capability_sha256);
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	select * into v_recovery from public.qorpera_identity_recoveries
	where id = p_recovery_id and profile_id = v_authority.profile_id and authority_id = v_authority.id;
	if not found then raise exception 'identity recovery is unavailable' using errcode = '42501'; end if;
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = v_recovery.compute_identity_id and profile_id = v_recovery.profile_id for update;
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id for update;
	select * into v_target from public.qorpera_identity_recovery_targets
	where id = v_recovery.target_id and profile_id = v_recovery.profile_id and authority_id = v_authority.id
		and compute_identity_id = v_identity.id and capability_sha256 = p_target_capability_sha256 for share;
	if not found then raise exception 'recovery recipient is unavailable' using errcode = '42501'; end if;
	-- A completed receipt is private historical evidence, never another release.
	if v_recovery.status = 'completed' then return v_recovery; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_recovery.profile_id
		and user_id = v_recovery.owner_user_id and role = 'owner' for share;
	if not found then raise exception 'recovery owner authority changed' using errcode = '42501'; end if;
	if v_identity.ownership_kind = 'member' then
		perform 1 from public.qorpera_profile_members where profile_id = v_recovery.profile_id
			and user_id = v_identity.owner_user_id and user_id = v_recovery.member_consent_user_id for share;
		if not found then raise exception 'recovery member consent changed' using errcode = '42501'; end if;
	end if;
	select * into v_backup from public.qorpera_identity_key_backups where compute_identity_id = v_identity.id
		and status = 'ready' order by revision desc limit 1 for share;
	if v_recovery.status not in ('approved','released') or v_recovery.expires_at <= clock_timestamp()
		or v_recovery.not_before > clock_timestamp() or v_recovery.not_before is null
		or v_target.status <> 'active' or v_target.expires_at <= clock_timestamp()
		or v_identity.status <> 'active' or v_identity.recovery_pending_id is distinct from v_recovery.id
		or v_identity.recovery_epoch is distinct from v_recovery.epoch
		or v_backup.revision is distinct from v_recovery.backup_revision or v_backup.authority_id <> v_authority.id
		or v_backup.policy_sha256 is distinct from public.qorpera_compute_policy_sha256(v_identity.policy)
		or not exists(select 1 from public.qorpera_native_credential_capsules capsule
			join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
			join public.qorpera_provider_connections connection on connection.id = version.connection_id
			where capsule.compute_identity_id = v_identity.id and capsule.profile_id = v_identity.profile_id
				and capsule.status = 'active' and capsule.ownership_kind = v_identity.ownership_kind
				and capsule.owner_user_id is not distinct from v_identity.owner_user_id
				and capsule.owner_scope_key is not distinct from v_identity.owner_scope_key
				and version.authorization_state = 'active' and connection.status = 'active'
				and connection.owner_user_id is not distinct from v_identity.owner_user_id
				and public.qorpera_provider_execution_enabled(connection.provider,version.authentication_mode,version.native_harness)) then
		raise exception 'recovery authority changed, expired, or remains fenced' using errcode = '42501'; end if;
	return v_recovery;
end
$$;

create function public.qorpera_prepare_identity_key_release(
	p_authority_id uuid,p_service_capability_sha256 text,p_recovery_id uuid,p_target_capability_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype;
	v_backup public.qorpera_identity_key_backups%rowtype; v_target public.qorpera_identity_recovery_targets%rowtype;
	v_issued timestamptz;
begin
	v_recovery := public.qorpera_recovery_locked(p_authority_id,p_service_capability_sha256,p_recovery_id,p_target_capability_sha256);
	if v_recovery.status = 'completed' then
		return jsonb_build_object('status','completed','receipt',public.qorpera_identity_recovery_json(v_recovery)); end if;
	if v_recovery.release_issued_at is null then
		v_issued := date_trunc('milliseconds',clock_timestamp());
		update public.qorpera_identity_recoveries set release_issued_at = v_issued,
			release_expires_at = least(v_issued+interval '60 seconds',expires_at)
		where id = v_recovery.id returning * into v_recovery;
	end if;
	if v_recovery.release_expires_at <= clock_timestamp() then
		raise exception 'recovery release expired' using errcode = '42501'; end if;
	select * into strict v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = v_recovery.compute_identity_id and revision = v_recovery.backup_revision;
	select * into strict v_target from public.qorpera_identity_recovery_targets where id = v_recovery.target_id;
	return jsonb_build_object('status',v_recovery.status,'binding',jsonb_build_object(
		'key',public.qorpera_identity_backup_json(v_backup)->'binding','recoveryId',v_recovery.id,
		'targetId',v_target.id,'epoch',v_recovery.epoch,'backupSha256',v_backup.object_sha256,
		'recipientKeySha256',v_target.recipient_key_sha256,
		'issuedAt',to_char(v_recovery.release_issued_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'expiresAt',to_char(v_recovery.release_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
		'backupBytes',v_backup.object_bytes,'storageSource',v_recovery.storage_source,
		'recipientPublicKey',v_target.recipient_public_key,'releaseSha256',v_recovery.release_sha256,'releaseBytes',v_recovery.release_bytes);
end
$$;

create function public.qorpera_commit_identity_key_release(
	p_authority_id uuid,p_service_capability_sha256 text,p_recovery_id uuid,p_target_capability_sha256 text,
	p_release_sha256 text,p_release_bytes integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan jsonb; v_recovery public.qorpera_identity_recoveries%rowtype;
begin
	if p_release_sha256 is null or p_release_sha256 !~ '^[0-9a-f]{64}$'
		or p_release_bytes is null or p_release_bytes not between 1 and 16384 then
		raise exception 'recovery release object is invalid' using errcode = '22023'; end if;
	v_plan := public.qorpera_prepare_identity_key_release(p_authority_id,p_service_capability_sha256,
		p_recovery_id,p_target_capability_sha256);
	if v_plan->>'status' = 'completed' then raise exception 'recovery release is already completed' using errcode = '55000'; end if;
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id for update;
	if v_recovery.status = 'released' then
		if v_recovery.release_sha256 <> p_release_sha256 or v_recovery.release_bytes <> p_release_bytes then
			raise exception 'recovery release is already bound' using errcode = '23505'; end if;
	else
		update public.qorpera_identity_recoveries set status = 'released',release_sha256 = p_release_sha256,
			release_bytes = p_release_bytes where id = p_recovery_id returning * into v_recovery;
	end if;
	return jsonb_build_object('releaseSha256',v_recovery.release_sha256,'releaseBytes',v_recovery.release_bytes);
end
$$;

create function public.qorpera_complete_identity_recovery(
	p_authority_id uuid,p_service_capability_sha256 text,p_recovery_id uuid,p_target_capability_sha256 text,
	p_release_sha256 text,p_proof_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype;
begin
	if p_release_sha256 is null or p_release_sha256 !~ '^[0-9a-f]{64}$'
		or p_proof_sha256 is null or p_proof_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'recovery completion is invalid' using errcode = '22023'; end if;
	v_recovery := public.qorpera_recovery_locked(p_authority_id,p_service_capability_sha256,p_recovery_id,p_target_capability_sha256);
	if v_recovery.status = 'completed' then
		if v_recovery.release_sha256 <> p_release_sha256 or v_recovery.proof_sha256 <> p_proof_sha256 then
			raise exception 'recovery receipt is already bound' using errcode = '23505'; end if;
		return public.qorpera_identity_recovery_json(v_recovery);
	end if;
	if v_recovery.status <> 'released' or v_recovery.release_sha256 <> p_release_sha256 then
		raise exception 'recovery release is unconfirmed' using errcode = '42501'; end if;
	update public.qorpera_identity_recoveries set status = 'completed',receipt_id = extensions.gen_random_uuid(),
		proof_sha256 = p_proof_sha256,completed_at = clock_timestamp()
	where id = p_recovery_id returning * into v_recovery;
	update public.qorpera_member_compute_identities set recovery_pending_id = null
	where id = v_recovery.compute_identity_id and recovery_pending_id = v_recovery.id and recovery_epoch = v_recovery.epoch;
	if not found then raise exception 'recovery generation changed' using errcode = '42501'; end if;
	return public.qorpera_identity_recovery_json(v_recovery);
end
$$;

create function public.qorpera_identity_recovery_completion_authority(
	p_authority_id uuid,p_service_capability_sha256 text,p_recovery_id uuid,p_target_capability_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
begin
	v_recovery := public.qorpera_recovery_locked(p_authority_id,p_service_capability_sha256,p_recovery_id,p_target_capability_sha256);
	if v_recovery.status = 'completed' then
		return jsonb_build_object('status','completed','receipt',public.qorpera_identity_recovery_json(v_recovery)); end if;
	if v_recovery.status <> 'released' then raise exception 'recovery release is unconfirmed' using errcode = '42501'; end if;
	select * into strict v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = v_recovery.compute_identity_id and revision = v_recovery.backup_revision;
	return jsonb_build_object('status','released','backup',public.qorpera_identity_backup_json(v_backup),
		'storageSource',v_recovery.storage_source,'releaseSha256',v_recovery.release_sha256);
end
$$;

create function public.qorpera_identity_recovery_runtime_state(p_compute_identity_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native host authority is required' using errcode = '42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id for share;
	if not found then raise exception 'compute identity is unavailable' using errcode = '42501'; end if;
	select * into v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = p_compute_identity_id order by revision desc limit 1;
	return jsonb_build_object('companyId',v_identity.profile_id,'computeIdentityId',v_identity.id,
		'epoch',v_identity.recovery_epoch,'blocked',v_identity.status <> 'active' or v_identity.recovery_pending_id is not null,
		'policySha256',public.qorpera_compute_policy_sha256(v_identity.policy),'keySha256',v_backup.key_sha256,
		'recoveryConfiguration',(select jsonb_build_object('authorityId',authority.id,
			'serviceOrigin',authority.service_origin,'signingPublicKey',authority.signing_public_key,
			'wrappingPublicKey',authority.wrapping_public_key)
			from public.qorpera_identity_recovery_authorities authority
			where authority.profile_id=v_identity.profile_id and authority.status='active'),
		'canInitialize',v_identity.status = 'active' and v_identity.recovery_pending_id is null and v_identity.recovery_epoch = 0
			and v_backup.compute_identity_id is null and not exists(select 1 from public.qorpera_native_credential_capsules
				where compute_identity_id = p_compute_identity_id));
end
$$;

create function public.qorpera_pin_run_recovery_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if tg_op = 'UPDATE' then
		if new.compute_recovery_epoch <> old.compute_recovery_epoch then
			raise exception 'execution recovery generation is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	if new.compute_identity_id is null then new.compute_recovery_epoch := 0; return new; end if;
	select * into v_identity from public.qorpera_member_compute_identities
	where id = new.compute_identity_id and profile_id = new.profile_id for share;
	if not found or v_identity.status <> 'active' or v_identity.recovery_pending_id is not null then
		raise exception 'execution identity is fenced for recovery' using errcode = '42501'; end if;
	new.compute_recovery_epoch := v_identity.recovery_epoch;
	return new;
end
$$;
create trigger qorpera_pin_run_recovery_epoch before insert or update on public.qorpera_execution_runs
for each row execute function public.qorpera_pin_run_recovery_epoch();

create function public.qorpera_pin_login_recovery_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if tg_op = 'UPDATE' and new.compute_recovery_epoch <> old.compute_recovery_epoch then
		raise exception 'login recovery generation is immutable' using errcode = '42501'; end if;
	if new.status in ('cancelled','expired') then return new; end if;
	select * into v_identity from public.qorpera_member_compute_identities
	where id = new.compute_identity_id and profile_id = new.profile_id for share;
	if not found or v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or (tg_op = 'UPDATE' and new.compute_recovery_epoch <> v_identity.recovery_epoch) then
		raise exception 'native login generation is fenced for recovery' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then new.compute_recovery_epoch := v_identity.recovery_epoch; end if;
	if new.status='completed' and exists(select 1 from public.qorpera_identity_recovery_authorities
		where profile_id=v_identity.profile_id and status='active') and not exists(
		select 1 from public.qorpera_identity_backup_login_receipts receipt
		join public.qorpera_identity_key_backups backup using(compute_identity_id,revision)
		join public.qorpera_identity_recovery_authorities authority on authority.id=backup.authority_id
		where receipt.login_id=new.id and receipt.compute_identity_id=v_identity.id
			and backup.status='ready' and backup.policy_sha256=public.qorpera_compute_policy_sha256(v_identity.policy)
			and authority.status='active' and authority.profile_id=v_identity.profile_id) then
		raise exception 'Native login requires a verified recovery backup' using errcode='42501'; end if;
	return new;
end
$$;
create trigger qorpera_pin_login_recovery_epoch before insert or update on public.qorpera_native_provider_login_sessions
for each row execute function public.qorpera_pin_login_recovery_epoch();

create function public.qorpera_pin_runner_recovery_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if tg_op = 'UPDATE' and new.compute_recovery_epoch <> old.compute_recovery_epoch then
		raise exception 'runner recovery generation is immutable' using errcode = '42501'; end if;
	if new.compute_identity_id is null then return new; end if;
	if tg_op = 'UPDATE' and new.status = 'revoked' then return new; end if;
	select * into v_identity from public.qorpera_member_compute_identities
	where id = new.compute_identity_id and profile_id = new.profile_id for share;
	if not found or v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or (tg_op = 'UPDATE' and new.compute_recovery_epoch <> v_identity.recovery_epoch) then
		raise exception 'runner identity is fenced for recovery' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then new.compute_recovery_epoch := v_identity.recovery_epoch; end if;
	return new;
end
$$;
create trigger qorpera_pin_runner_recovery_epoch before insert or update on public.qorpera_runners
for each row execute function public.qorpera_pin_runner_recovery_epoch();

create function public.qorpera_guard_native_recovery_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if new.status <> 'active' then return new; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id = new.compute_identity_id for share;
	if not found or v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or not exists(select 1 from public.qorpera_execution_runs run join public.qorpera_runners runner on runner.id = new.runner_id
			where run.id = new.run_id and run.compute_identity_id = v_identity.id and runner.compute_identity_id = v_identity.id
				and run.compute_recovery_epoch = v_identity.recovery_epoch and runner.compute_recovery_epoch = v_identity.recovery_epoch) then
		raise exception 'native lease generation is fenced for recovery' using errcode = '42501'; end if;
	return new;
end
$$;
create trigger qorpera_guard_native_recovery_epoch before insert or update on public.qorpera_native_provider_connection_leases
for each row execute function public.qorpera_guard_native_recovery_epoch();

create or replace function public.qorpera_execution_compute_available(p_run public.qorpera_execution_runs)
returns boolean language sql volatile security definer set search_path = '' as $$
	select (p_run.logical_computer_id is null or exists (
		select 1 from public.qorpera_logical_computers computer join public.qorpera_runner_jobs job on job.id = p_run.job_id
		where computer.id = p_run.logical_computer_id and computer.profile_id = p_run.profile_id
			and computer.status = 'active' and computer.capabilities ? job.required_capability))
	and (p_run.compute_identity_id is null or exists (
		select 1 from public.qorpera_member_compute_identities identity where identity.id = p_run.compute_identity_id
			and identity.profile_id = p_run.profile_id and identity.status = 'active'
			and identity.recovery_pending_id is null and identity.recovery_epoch = p_run.compute_recovery_epoch))
$$;

alter function public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)
rename to qorpera_validate_native_provider_execution_lease_before_recovery;
create function public.qorpera_validate_native_provider_execution_lease(
	p_lease_id uuid,p_run_id uuid,p_job_id uuid,p_runner_id uuid,p_assignment_id uuid,
	p_credential_capsule_id uuid,p_compute_identity_id uuid,p_provider text,p_native_harness text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype; v_profile uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native host authority is required' using errcode = '42501'; end if;
	select profile_id into v_profile from public.qorpera_member_compute_identities where id = p_compute_identity_id;
	if v_profile is null then raise exception 'native identity is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	select * into strict v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id for share;
	if v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or not exists(select 1 from public.qorpera_execution_runs where id = p_run_id and compute_identity_id = v_identity.id
			and compute_recovery_epoch = v_identity.recovery_epoch)
		or not exists(select 1 from public.qorpera_runners where id = p_runner_id and compute_identity_id = v_identity.id
			and compute_recovery_epoch = v_identity.recovery_epoch) then
		raise exception 'native execution generation is fenced for recovery' using errcode = '42501'; end if;
	return public.qorpera_validate_native_provider_execution_lease_before_recovery(p_lease_id,p_run_id,p_job_id,p_runner_id,
		p_assignment_id,p_credential_capsule_id,p_compute_identity_id,p_provider,p_native_harness)
		||jsonb_build_object('compute_identity_epoch',v_identity.recovery_epoch);
end
$$;

create function public.qorpera_consent_identity_recovery(p_recovery_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype; v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'recovery member consent is required' using errcode = '42501'; end if;
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id;
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	select * into strict v_identity from public.qorpera_member_compute_identities where id = v_recovery.compute_identity_id for update;
	if v_identity.ownership_kind <> 'member' or v_identity.owner_user_id is distinct from auth.uid()
		or not exists(select 1 from public.qorpera_profile_members where profile_id = v_identity.profile_id and user_id = auth.uid()) then
		raise exception 'recovery member consent is unavailable' using errcode = '42501'; end if;
	update public.qorpera_identity_recoveries set member_consent_user_id = auth.uid()
	where id = p_recovery_id and status = 'awaiting_member';
	v_recovery := public.qorpera_activate_identity_recovery(p_recovery_id);
	return public.qorpera_identity_recovery_json(v_recovery);
end
$$;

create function public.qorpera_cancel_identity_recovery(p_recovery_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.qorpera_identity_recoveries%rowtype; v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'recovery cancellation is unavailable' using errcode = '42501'; end if;
	select * into strict v_recovery from public.qorpera_identity_recoveries where id = p_recovery_id;
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	select * into strict v_identity from public.qorpera_member_compute_identities where id = v_recovery.compute_identity_id for update;
	perform 1 from public.qorpera_profile_members where profile_id = v_recovery.profile_id and user_id = auth.uid()
		and (role = 'owner' or user_id = v_identity.owner_user_id) for share;
	if not found or v_recovery.status = 'completed' then
		raise exception 'recovery cancellation is unavailable' using errcode = '42501'; end if;
	update public.qorpera_identity_recoveries set status = 'cancelled' where id = p_recovery_id returning * into v_recovery;
	-- Deliberately retain the pending fence. Cancellation is not permission for
	-- the lost node to resume, nor permission to reuse this generation.
	return public.qorpera_identity_recovery_json(v_recovery);
end
$$;

create function public.qorpera_review_identity_recovery(p_compute_identity_id uuid,p_target_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_target public.qorpera_identity_recovery_targets%rowtype; v_backup public.qorpera_identity_key_backups%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'recovery review is unavailable' using errcode = '42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id = p_compute_identity_id;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = v_identity.profile_id and user_id = auth.uid()
			and (role = 'owner' or user_id = v_identity.owner_user_id)) then
		raise exception 'recovery review is unavailable' using errcode = '42501'; end if;
	select * into v_target from public.qorpera_identity_recovery_targets
	where id = p_target_id and profile_id = v_identity.profile_id and compute_identity_id = v_identity.id;
	if not found then raise exception 'recovery target is unavailable' using errcode = '42501'; end if;
	select * into v_backup from public.qorpera_identity_key_backups
	where compute_identity_id = v_identity.id and status = 'ready' order by revision desc limit 1;
	return jsonb_build_object('companyId',v_identity.profile_id,'computeIdentityId',v_identity.id,
		'ownerUserId',v_identity.owner_user_id,'ownershipKind',v_identity.ownership_kind,
		'epoch',v_identity.recovery_epoch,'blocked',v_identity.recovery_pending_id is not null,
		'backup',case when v_backup.revision is null then null else public.qorpera_identity_backup_json(v_backup) end,
		'target',jsonb_build_object('targetId',v_target.id,'nodeId',v_target.node_id,'authorityId',v_target.authority_id,
			'imageSha256',v_target.image_sha256,'guestManifestSha256',v_target.guest_manifest_sha256,
			'recipientKeySha256',v_target.recipient_key_sha256,'status',v_target.status,
			'expiresAt',to_char(v_target.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
		'recovery',(select public.qorpera_identity_recovery_json(recovery) from public.qorpera_identity_recoveries recovery
			where recovery.target_id = v_target.id));
end
$$;

-- Default Supabase privileges include direct grants; remove all of them from
-- every new helper, then grant only the public member and service entrypoints.
do $$
declare v_function regprocedure;
begin
	for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.proname = any(array[
		'qorpera_recovery_public_key_sha256','qorpera_recovery_service','qorpera_identity_backup_json',
		'qorpera_prepare_identity_key_backup','qorpera_complete_identity_key_backup','qorpera_register_identity_recovery_target',
		'qorpera_identity_recovery_json','qorpera_activate_identity_recovery','qorpera_request_identity_recovery',
		'qorpera_consent_identity_recovery','qorpera_cancel_identity_recovery','qorpera_recovery_locked',
		'qorpera_prepare_identity_key_release','qorpera_commit_identity_key_release','qorpera_complete_identity_recovery',
		'qorpera_identity_recovery_completion_authority','qorpera_identity_recovery_runtime_state',
		'qorpera_review_identity_recovery','qorpera_pin_login_recovery_epoch',
		'qorpera_identity_recovery_service_configuration','qorpera_identity_recovery_authority_immutable',
		'qorpera_pin_run_recovery_epoch','qorpera_pin_runner_recovery_epoch','qorpera_guard_native_recovery_epoch',
		'qorpera_validate_native_provider_execution_lease_before_recovery','qorpera_validate_native_provider_execution_lease']) loop
		execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function);
	end loop;
end
$$;
grant execute on function public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text) to authenticated;
grant execute on function public.qorpera_consent_identity_recovery(uuid),public.qorpera_cancel_identity_recovery(uuid) to authenticated;
grant execute on function public.qorpera_review_identity_recovery(uuid,uuid) to authenticated;
grant execute on function public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text) to service_role;
grant execute on function public.qorpera_identity_recovery_service_configuration(uuid,text) to service_role;
grant execute on function public.qorpera_complete_identity_key_backup(uuid,text,uuid,text,text,bigint,text,integer) to service_role;
grant execute on function public.qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.qorpera_prepare_identity_key_release(uuid,text,uuid,text) to service_role;
grant execute on function public.qorpera_commit_identity_key_release(uuid,text,uuid,text,text,integer) to service_role;
grant execute on function public.qorpera_complete_identity_recovery(uuid,text,uuid,text,text,text) to service_role;
grant execute on function public.qorpera_identity_recovery_completion_authority(uuid,text,uuid,text) to service_role;
grant execute on function public.qorpera_identity_recovery_runtime_state(uuid) to service_role;
grant execute on function public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text) to service_role;
