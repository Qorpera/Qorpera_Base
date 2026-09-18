-- Runtime Step 2: company-centered cloud secret custody.
--
-- Secret plaintext never enters PostgreSQL, the Company File, a runner, or a
-- model-facing tool. Members create one-time capture tickets; only the
-- independently credentialed cloud broker may commit an encrypted envelope or
-- resolve it for one currently admitted and durably receipted connector
-- effect. The native execution host can discover safe tool descriptors and
-- assert a grant, but cannot read an envelope.

do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'qorpera_secret_broker') then
		create role qorpera_secret_broker
			nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
	end if;
end
$$;

create table public.qorpera_cloud_secret_broker_authorities (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null unique references public.qorpera_profiles(id) on delete cascade,
	service_origin text not null check (
		service_origin ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'
		and char_length(service_origin) <= 512
	),
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	capability_sha256 text not null unique check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active','retired')),
	created_at timestamptz not null default statement_timestamp(),
	retired_at timestamptz,
	check ((status = 'retired') = (retired_at is not null))
);

create table public.qorpera_cloud_connector_operations (
	connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	operation_id text not null check (operation_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	version bigint not null check (version > 0),
	tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
	description text not null check (
		char_length(btrim(description)) between 1 and 2048 and description = btrim(description)
	),
	input_schema jsonb not null check (
		jsonb_typeof(input_schema) = 'object'
		and input_schema ->> 'type' = 'object'
		and input_schema -> 'additionalProperties' = 'false'::jsonb
		and pg_column_size(input_schema) <= 16384
	),
	destination_origin text not null check (
		destination_origin ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'
		and char_length(destination_origin) <= 512
	),
	credential_name text not null check (credential_name ~ '^[a-z][a-z0-9_]{0,63}$'),
	adapter_sha256 text not null check (adapter_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active','retired')),
	created_at timestamptz not null default statement_timestamp(),
	primary key (connector_id, operation_id, version),
	unique (tool_name, version, adapter_sha256)
);

create table public.qorpera_cloud_secrets (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	owner_kind text not null check (owner_kind in ('company','member')),
	owner_user_id uuid references auth.users(id) on delete restrict,
	connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	secret_name text not null check (
		secret_name ~ '^[a-z][a-z0-9_-]{0,63}$'
	),
	purpose text not null check (
		char_length(btrim(purpose)) between 1 and 512 and purpose = btrim(purpose)
	),
	status text not null default 'active' check (status in ('active','revoked')),
	current_version bigint not null check (current_version > 0),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	revoked_by_user_id uuid references auth.users(id) on delete restrict,
	check (
		(owner_kind = 'company' and owner_user_id is null)
		or (owner_kind = 'member' and owner_user_id is not null)
	),
	check ((status = 'revoked') = (revoked_at is not null)),
	check (status = 'revoked' or revoked_by_user_id is null)
);

create unique index qorpera_cloud_secrets_active_name
	on public.qorpera_cloud_secrets (
		profile_id, environment_id, owner_kind, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
		connector_id, secret_name
	)
	where status = 'active';

create table public.qorpera_cloud_secret_versions (
	secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete restrict,
	version bigint not null check (version > 0),
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	encrypted_envelope bytea not null check (octet_length(encrypted_envelope) between 1 and 131072),
	envelope_sha256 text not null check (envelope_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default statement_timestamp(),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	primary key (secret_id, version),
	unique (secret_id, envelope_sha256)
);

create table public.qorpera_cloud_secret_capture_tickets (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	secret_id uuid not null,
	target_version bigint not null check (target_version > 0),
	owner_kind text not null check (owner_kind in ('company','member')),
	owner_user_id uuid references auth.users(id) on delete restrict,
	connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	secret_name text not null check (secret_name ~ '^[a-z][a-z0-9_-]{0,63}$'),
	purpose text not null check (
		char_length(btrim(purpose)) between 1 and 512 and purpose = btrim(purpose)
	),
	capture_capability_sha256 text not null unique check (capture_capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'pending' check (status in ('pending','committed','cancelled','expired')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz not null,
	committed_at timestamptz,
	envelope_sha256 text check (envelope_sha256 is null or envelope_sha256 ~ '^[0-9a-f]{64}$'),
	check (
		(owner_kind = 'company' and owner_user_id is null)
		or (owner_kind = 'member' and owner_user_id is not null)
	),
	check ((status = 'committed') = (committed_at is not null)),
	check ((status = 'committed') = (envelope_sha256 is not null)),
	check (expires_at > created_at)
);

create unique index qorpera_cloud_secret_capture_one_pending_rotation
	on public.qorpera_cloud_secret_capture_tickets (secret_id)
	where status = 'pending' and target_version > 1;

create table public.qorpera_cloud_secret_operation_grants (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete restrict,
	staff_agent_id uuid not null,
	connector_id text not null,
	operation_id text not null,
	operation_version bigint not null,
	tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
	issued_by_user_id uuid not null references auth.users(id) on delete restrict,
	status text not null default 'active' check (status in ('active','revoked')),
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz,
	revoked_at timestamptz,
	revoked_by_user_id uuid references auth.users(id) on delete restrict,
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete cascade,
	foreign key (connector_id, operation_id, operation_version)
		references public.qorpera_cloud_connector_operations(connector_id, operation_id, version) on delete restrict,
	check (expires_at is null or expires_at > created_at),
	check ((status = 'revoked') = (revoked_at is not null)),
	check (status = 'revoked' or revoked_by_user_id is null)
);

create unique index qorpera_cloud_secret_grants_active_tool
	on public.qorpera_cloud_secret_operation_grants (profile_id, environment_id, staff_agent_id, tool_name)
	where status = 'active';

create table public.qorpera_cloud_secret_audit_events (
	id bigint generated always as identity primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	secret_id uuid,
	secret_version bigint,
	grant_id uuid,
	run_id uuid,
	receipt_id uuid,
	event_type text not null check (
		event_type in ('capture_started','captured','rotated','grant_issued','grant_revoked','secret_revoked','effect_authorized')
	),
	actor_user_id uuid references auth.users(id) on delete restrict,
	connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	operation_id text check (operation_id is null or operation_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_cloud_secret_audit_profile_time
	on public.qorpera_cloud_secret_audit_events (profile_id, created_at desc, id desc);

alter table public.qorpera_cloud_secret_broker_authorities enable row level security;
alter table public.qorpera_cloud_connector_operations enable row level security;
alter table public.qorpera_cloud_secrets enable row level security;
alter table public.qorpera_cloud_secret_versions enable row level security;
alter table public.qorpera_cloud_secret_capture_tickets enable row level security;
alter table public.qorpera_cloud_secret_operation_grants enable row level security;
alter table public.qorpera_cloud_secret_audit_events enable row level security;

revoke all on table public.qorpera_cloud_secret_broker_authorities from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_connector_operations from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secrets from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_versions from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_capture_tickets from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_operation_grants from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_audit_events from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on sequence public.qorpera_cloud_secret_audit_events_id_seq from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_begin_cloud_secret_capture(
	p_profile_id uuid,
	p_environment_id uuid,
	p_owner_kind text,
	p_owner_user_id uuid,
	p_connector_id text,
	p_secret_name text,
	p_purpose text,
	p_existing_secret_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_ticket public.qorpera_cloud_secret_capture_tickets%rowtype;
	v_capability text := encode(extensions.gen_random_bytes(32),'hex');
begin
	select member.role::text into v_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_user_id is null or v_role is null or v_role = 'viewer' then
		raise exception 'secret capture requires company write access' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_company_environments as environment
		where environment.id = p_environment_id and environment.profile_id = p_profile_id
	) then
		raise exception 'secret environment is invalid' using errcode = '22023';
	end if;
	if p_owner_kind not in ('company','member')
		or (p_owner_kind = 'company' and (p_owner_user_id is not null or v_role not in ('owner','admin')))
		or (p_owner_kind = 'member' and p_owner_user_id is distinct from v_user_id)
		or p_connector_id !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_secret_name !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(btrim(p_purpose)) not between 1 and 512
		or p_purpose <> btrim(p_purpose) then
		raise exception 'secret capture scope is invalid' using errcode = '22023';
	end if;
	select authority.* into strict v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = p_profile_id and authority.status = 'active';
	if p_existing_secret_id is null then
		if exists (
			select 1 from public.qorpera_cloud_secrets as secret
			where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
				and secret.owner_kind = p_owner_kind
				and secret.owner_user_id is not distinct from p_owner_user_id
				and secret.connector_id = p_connector_id and secret.secret_name = p_secret_name
				and secret.status = 'active'
		) then
			raise exception 'an active secret already has this name' using errcode = '23505';
		end if;
		v_secret.id := extensions.gen_random_uuid();
		v_secret.current_version := 0;
	else
		select secret.* into strict v_secret
		from public.qorpera_cloud_secrets as secret
		where secret.id = p_existing_secret_id
			and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
		for update;
		if v_secret.status <> 'active'
			or v_secret.owner_kind <> p_owner_kind
			or v_secret.owner_user_id is distinct from p_owner_user_id
			or v_secret.connector_id <> p_connector_id
			or v_secret.secret_name <> p_secret_name
			or (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
			or (v_secret.owner_kind = 'member' and v_secret.owner_user_id <> v_user_id) then
			raise exception 'secret rotation authority is unavailable' using errcode = '42501';
		end if;
		update public.qorpera_cloud_secret_capture_tickets
		set status = 'expired'
		where secret_id = v_secret.id and target_version > 1 and status = 'pending'
			and expires_at <= clock_timestamp();
	end if;
	insert into public.qorpera_cloud_secret_capture_tickets (
		profile_id, environment_id, broker_authority_id, key_id, secret_id, target_version,
		owner_kind, owner_user_id, connector_id, secret_name, purpose,
		capture_capability_sha256, created_by_user_id, expires_at
	) values (
		p_profile_id, p_environment_id, v_authority.id, v_authority.key_id,
		v_secret.id, v_secret.current_version + 1,
		p_owner_kind, p_owner_user_id, p_connector_id, p_secret_name, p_purpose,
		encode(extensions.digest(v_capability,'sha256'),'hex'), v_user_id, statement_timestamp() + interval '10 minutes'
	) returning * into v_ticket;
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id, environment_id, secret_id, secret_version, event_type, actor_user_id, connector_id
	) values (p_profile_id,p_environment_id,v_ticket.secret_id,v_ticket.target_version,'capture_started',v_user_id,p_connector_id);
	return jsonb_build_object(
		'schema','qorpera.cloud-secret-capture/v1',
		'ticketId',v_ticket.id,
		'captureCapability',v_capability,
		'serviceOrigin',v_authority.service_origin,
		'scope',jsonb_build_object(
			'companyId',p_profile_id,'environmentId',p_environment_id,'secretId',v_ticket.secret_id,
			'version',v_ticket.target_version,'ownerKind',p_owner_kind,'ownerUserId',p_owner_user_id,
			'connectorId',p_connector_id,'secretName',p_secret_name,'purpose',p_purpose
		),
		'expiresAt',v_ticket.expires_at
	);
end
$$;

create function public.qorpera_describe_cloud_secret_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_ticket public.qorpera_cloud_secret_capture_tickets%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into strict v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;
	if v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.capture_capability_sha256 <> p_capture_capability_sha256
		or v_ticket.status <> 'pending'
		or v_ticket.expires_at <= clock_timestamp() then
		if v_ticket.status = 'pending' and v_ticket.expires_at <= clock_timestamp() then
			update public.qorpera_cloud_secret_capture_tickets set status = 'expired' where id = v_ticket.id;
		end if;
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema','qorpera.cloud-secret-capture-description/v1',
		'ticketId',v_ticket.id,'companyId',v_ticket.profile_id,'environmentId',v_ticket.environment_id,
		'secretId',v_ticket.secret_id,'version',v_ticket.target_version,
		'ownerKind',v_ticket.owner_kind,'ownerUserId',v_ticket.owner_user_id,
		'connectorId',v_ticket.connector_id,'secretName',v_ticket.secret_name,'purpose',v_ticket.purpose,
		'keyId',v_ticket.key_id,'expiresAt',v_ticket.expires_at
	);
end
$$;

create function public.qorpera_complete_cloud_secret_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_ticket public.qorpera_cloud_secret_capture_tickets%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_envelope bytea;
	v_event text;
	v_creator_role text;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into strict v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256
		or p_envelope_sha256 !~ '^[0-9a-f]{64}$'
		or char_length(p_encrypted_envelope_base64) not between 1 and 180000 then
		raise exception 'cloud secret broker completion is invalid' using errcode = '42501';
	end if;
	begin
		v_envelope := decode(p_encrypted_envelope_base64,'base64');
	exception when others then
		raise exception 'encrypted secret envelope is invalid' using errcode = '22023';
	end;
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope,'sha256'),'hex') <> p_envelope_sha256 then
		raise exception 'encrypted secret envelope is invalid' using errcode = '22023';
	end if;
	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;
	if v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.capture_capability_sha256 <> p_capture_capability_sha256 then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	select member.role::text into v_creator_role
	from public.qorpera_profile_members as member
	where member.profile_id = v_ticket.profile_id and member.user_id = v_ticket.created_by_user_id
	for share;
	if v_ticket.key_id <> v_authority.key_id or v_creator_role is null
		or (v_ticket.owner_kind = 'company' and v_creator_role not in ('owner','admin'))
		or (v_ticket.owner_kind = 'member' and (
			v_ticket.owner_user_id <> v_ticket.created_by_user_id or v_creator_role = 'viewer'
		)) then
		raise exception 'cloud secret capture authority changed' using errcode = '42501';
	end if;
	if v_ticket.status = 'committed' then
		return jsonb_build_object(
			'schema','qorpera.cloud-secret-descriptor/v1','secretId',v_ticket.secret_id,
			'version',v_ticket.target_version,'connectorId',v_ticket.connector_id,
			'secretName',v_ticket.secret_name,'purpose',v_ticket.purpose,
			'ownerKind',v_ticket.owner_kind,'ownerUserId',v_ticket.owner_user_id,'status','active'
		);
	end if;
	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	if v_ticket.target_version = 1 then
		insert into public.qorpera_cloud_secrets (
			id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
			connector_id,secret_name,purpose,current_version,created_by_user_id
		) values (
			v_ticket.secret_id,v_ticket.profile_id,v_ticket.environment_id,v_ticket.broker_authority_id,
			v_ticket.owner_kind,v_ticket.owner_user_id,v_ticket.connector_id,v_ticket.secret_name,
			v_ticket.purpose,1,v_ticket.created_by_user_id
		);
		v_event := 'captured';
	else
		update public.qorpera_cloud_secrets
		set current_version = v_ticket.target_version, purpose = v_ticket.purpose,
			updated_at = statement_timestamp()
		where id = v_ticket.secret_id and status = 'active'
			and broker_authority_id = v_ticket.broker_authority_id
			and current_version = v_ticket.target_version - 1;
		if not found then
			raise exception 'secret rotation version changed' using errcode = '40001';
		end if;
		v_event := 'rotated';
	end if;
	insert into public.qorpera_cloud_secret_versions (
		secret_id,version,broker_authority_id,key_id,encrypted_envelope,envelope_sha256,created_by_user_id
	) values (
		v_ticket.secret_id,v_ticket.target_version,v_ticket.broker_authority_id,v_ticket.key_id,
		v_envelope,p_envelope_sha256,v_ticket.created_by_user_id
	);
	update public.qorpera_cloud_secret_capture_tickets
	set status = 'committed', committed_at = statement_timestamp(), envelope_sha256 = p_envelope_sha256
	where id = v_ticket.id;
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id,environment_id,secret_id,secret_version,event_type,actor_user_id,connector_id
	) values (
		v_ticket.profile_id,v_ticket.environment_id,v_ticket.secret_id,v_ticket.target_version,v_event,
		v_ticket.created_by_user_id,v_ticket.connector_id
	);
	return jsonb_build_object(
		'schema','qorpera.cloud-secret-descriptor/v1','secretId',v_ticket.secret_id,
		'version',v_ticket.target_version,'connectorId',v_ticket.connector_id,
		'secretName',v_ticket.secret_name,'purpose',v_ticket.purpose,
		'ownerKind',v_ticket.owner_kind,'ownerUserId',v_ticket.owner_user_id,'status','active'
	);
end
$$;

create function public.qorpera_list_cloud_secret_connections(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select case when not public.qorpera_can_read_profile(p_profile_id) then '[]'::jsonb else coalesce((
		select jsonb_agg(jsonb_build_object(
			'schema','qorpera.cloud-secret-descriptor/v1','secretId',secret.id,
			'version',secret.current_version,'connectorId',secret.connector_id,
			'secretName',secret.secret_name,'purpose',secret.purpose,
			'ownerKind',secret.owner_kind,
			'ownerUserId',case when secret.owner_kind = 'member' and secret.owner_user_id = auth.uid()
				then secret.owner_user_id else null end,
			'status',secret.status
		) order by secret.connector_id,secret.secret_name,secret.id)
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
			and (secret.owner_kind = 'company' or secret.owner_user_id = auth.uid())
	), '[]'::jsonb) end
$$;

create function public.qorpera_grant_cloud_secret_operation(
	p_profile_id uuid,
	p_environment_id uuid,
	p_secret_id uuid,
	p_staff_agent_id uuid,
	p_connector_id text,
	p_operation_id text,
	p_operation_version bigint,
	p_expires_at timestamptz default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_operation public.qorpera_cloud_connector_operations%rowtype;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
begin
	select member.role::text into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;
	if v_secret.status <> 'active'
		or (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and (v_role is null or v_role = 'viewer' or v_secret.owner_user_id <> v_user_id))
		or p_expires_at is not null and p_expires_at <= statement_timestamp() then
		raise exception 'secret grant authority is unavailable' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active'
	) then
		raise exception 'secret grant agent is unavailable' using errcode = '42501';
	end if;
	select operation.* into strict v_operation
	from public.qorpera_cloud_connector_operations as operation
	where operation.connector_id = p_connector_id and operation.operation_id = p_operation_id
		and operation.version = p_operation_version and operation.status = 'active';
	if v_operation.connector_id <> v_secret.connector_id then
		raise exception 'connector operation does not match the secret' using errcode = '22023';
	end if;
	insert into public.qorpera_cloud_secret_operation_grants (
		profile_id,environment_id,secret_id,staff_agent_id,connector_id,operation_id,
		operation_version,tool_name,issued_by_user_id,expires_at
	) values (
		p_profile_id,p_environment_id,p_secret_id,p_staff_agent_id,p_connector_id,p_operation_id,
		p_operation_version,v_operation.tool_name,v_user_id,p_expires_at
	) returning * into v_grant;
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id
	) values (
		p_profile_id,p_environment_id,p_secret_id,v_secret.current_version,v_grant.id,'grant_issued',v_user_id,
		p_connector_id,p_operation_id
	);
	return jsonb_build_object(
		'schema','qorpera.cloud-secret-grant/v1','grantId',v_grant.id,'secretId',p_secret_id,
		'staffAgentId',p_staff_agent_id,'toolName',v_grant.tool_name,'connectorId',p_connector_id,
		'operationId',p_operation_id,'operationVersion',p_operation_version,
		'status',v_grant.status,'expiresAt',v_grant.expires_at
	);
end
$$;

create function public.qorpera_revoke_cloud_secret_grant(p_profile_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
begin
	select member.role::text into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	select grant_row.* into strict v_grant from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.id = p_grant_id and grant_row.profile_id = p_profile_id for update;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret where secret.id = v_grant.secret_id;
	if (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and v_secret.owner_user_id <> v_user_id) then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501';
	end if;
	if v_grant.status = 'active' then
		update public.qorpera_cloud_secret_operation_grants
		set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=v_user_id
		where id=v_grant.id returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id
		) values (
			v_grant.profile_id,v_grant.environment_id,v_grant.secret_id,v_secret.current_version,v_grant.id,
			'grant_revoked',v_user_id,v_grant.connector_id,v_grant.operation_id
		);
	end if;
	return jsonb_build_object('schema','qorpera.cloud-secret-grant/v1','grantId',v_grant.id,'status',v_grant.status);
end
$$;

create function public.qorpera_revoke_cloud_secret(p_profile_id uuid, p_secret_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_secret public.qorpera_cloud_secrets%rowtype;
begin
	select member.role::text into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;
	if (v_secret.owner_kind = 'company' and v_role not in ('owner','admin'))
		or (v_secret.owner_kind = 'member' and v_secret.owner_user_id <> v_user_id) then
		raise exception 'secret revocation is unavailable' using errcode = '42501';
	end if;
	if v_secret.status = 'active' then
		update public.qorpera_cloud_secrets
		set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=v_user_id,updated_at=statement_timestamp()
		where id=v_secret.id returning * into v_secret;
		update public.qorpera_cloud_secret_operation_grants
		set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=v_user_id
		where secret_id=v_secret.id and status='active';
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id,environment_id,secret_id,secret_version,event_type,actor_user_id,connector_id
		) values (
			v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,
			'secret_revoked',v_user_id,v_secret.connector_id
		);
	end if;
	return jsonb_build_object('schema','qorpera.cloud-secret-descriptor/v1','secretId',v_secret.id,'status',v_secret.status);
end
$$;

create function public.qorpera_native_connector_locked_grant(p_binding jsonb, p_grant_id uuid)
returns public.qorpera_cloud_secret_operation_grants
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
begin
	if auth.role() is distinct from 'service_role' and session_user <> 'qorpera_secret_broker' then
		raise exception 'native connector authority is required' using errcode = '42501';
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select grant_row.* into strict v_grant
	from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.id = p_grant_id for share;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = v_grant.secret_id for share;
	if v_grant.status <> 'active' or (v_grant.expires_at is not null and v_grant.expires_at <= clock_timestamp())
		or v_grant.profile_id <> v_run.profile_id or v_grant.environment_id <> v_run.environment_id
		or v_grant.staff_agent_id <> v_run.staff_agent_id or v_secret.status <> 'active'
		or v_secret.profile_id <> v_run.profile_id or v_secret.environment_id <> v_run.environment_id
		or not exists (
			select 1 from public.qorpera_cloud_connector_operations as operation
			where operation.connector_id=v_grant.connector_id and operation.operation_id=v_grant.operation_id
				and operation.version=v_grant.operation_version and operation.tool_name=v_grant.tool_name
				and operation.status='active'
		)
		or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id=v_grant.profile_id and staff.staff_agent_id=v_grant.staff_agent_id
				and staff.employment_status='active'
		)
		or (v_secret.owner_kind='company' and not exists (
			select 1 from public.qorpera_profile_members as issuer
			where issuer.profile_id=v_grant.profile_id and issuer.user_id=v_grant.issued_by_user_id
				and issuer.role in ('owner','admin')
		))
		or (v_secret.owner_kind='member' and (
			v_grant.issued_by_user_id <> v_secret.owner_user_id
			or v_run.sponsored_by_user_id is distinct from v_secret.owner_user_id
			or not exists (
				select 1 from public.qorpera_profile_members as owner_member
				where owner_member.profile_id=v_grant.profile_id and owner_member.user_id=v_secret.owner_user_id
					and owner_member.role <> 'viewer'
			)
		)) then
		raise exception 'native connector grant is unavailable' using errcode = '42501';
	end if;
	return v_grant;
end
$$;

create function public.qorpera_list_native_connector_tools(p_binding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_result jsonb := '[]'::jsonb;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	for v_grant in
		select grant_row.* from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id=v_run.profile_id and grant_row.environment_id=v_run.environment_id
			and grant_row.staff_agent_id=v_run.staff_agent_id and grant_row.status='active'
		order by grant_row.tool_name,grant_row.id limit 32
	loop
		begin
			v_grant := public.qorpera_native_connector_locked_grant(p_binding,v_grant.id);
			v_result := v_result || (
				select jsonb_build_array(jsonb_build_object(
					'schema','qorpera.native-connector-tool/v1','grantId',v_grant.id,
					'toolName',operation.tool_name,'description',operation.description,
					'inputSchema',operation.input_schema,'connectorId',operation.connector_id,
					'operationId',operation.operation_id,'operationVersion',operation.version,
					'adapterSha256',operation.adapter_sha256,'destinationOrigin',operation.destination_origin
				)) from public.qorpera_cloud_connector_operations as operation
				where operation.connector_id=v_grant.connector_id and operation.operation_id=v_grant.operation_id
					and operation.version=v_grant.operation_version
			);
		exception when insufficient_privilege or no_data_found then null;
		end;
	end loop;
	return v_result;
end
$$;

create function public.qorpera_assert_native_connector_operation(
	p_binding jsonb,
	p_grant_id uuid,
	p_connector_id text,
	p_operation_id text,
	p_operation_version bigint,
	p_adapter_sha256 text,
	p_destination_origin text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
begin
	v_grant := public.qorpera_native_connector_locked_grant(p_binding,p_grant_id);
	if not exists (
		select 1 from public.qorpera_cloud_connector_operations as operation
		where operation.connector_id=v_grant.connector_id and operation.operation_id=v_grant.operation_id
			and operation.version=v_grant.operation_version
			and operation.connector_id=p_connector_id and operation.operation_id=p_operation_id
			and operation.version=p_operation_version and operation.adapter_sha256=p_adapter_sha256
			and operation.destination_origin=p_destination_origin and operation.status='active'
	) then
		raise exception 'native connector operation differs from its grant' using errcode = '42501';
	end if;
end
$$;

create function public.qorpera_authorize_cloud_secret_operation(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_grant_id uuid,
	p_connector_id text,
	p_operation_id text,
	p_operation_version bigint,
	p_adapter_sha256 text,
	p_destination_origin text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_operation public.qorpera_cloud_connector_operations%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_logical_operation_prefix text;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into strict v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id=p_broker_authority_id for share;
	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	v_grant := public.qorpera_native_connector_locked_grant(p_binding,p_grant_id);
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id=v_grant.secret_id for share;
	if v_secret.broker_authority_id <> v_authority.id then
		raise exception 'cloud secret broker does not own this envelope' using errcode = '42501';
	end if;
	select operation.* into strict v_operation from public.qorpera_cloud_connector_operations as operation
	where operation.connector_id=v_grant.connector_id and operation.operation_id=v_grant.operation_id
		and operation.version=v_grant.operation_version for share;
	if v_operation.connector_id <> p_connector_id or v_operation.operation_id <> p_operation_id
		or v_operation.version <> p_operation_version or v_operation.adapter_sha256 <> p_adapter_sha256
		or v_operation.destination_origin <> p_destination_origin or v_operation.status <> 'active' then
		raise exception 'cloud secret operation differs from its grant' using errcode = '42501';
	end if;
	select receipt.* into strict v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id=p_receipt_id and receipt.run_id=(p_binding->>'runId')::uuid for update;
	v_logical_operation_prefix := v_operation.tool_name || ':' || v_grant.id::text || ':';
	if v_receipt.status <> 'executing' or v_receipt.operation_kind <> 'cloud_tool'
		or v_receipt.input_sha256 <> p_input_sha256
		or p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$'
		or v_receipt.downstream_idempotency_sha256 <> p_downstream_idempotency_sha256
		or left(v_receipt.logical_operation_key, char_length(v_logical_operation_prefix)) <> v_logical_operation_prefix
		or substring(v_receipt.logical_operation_key from char_length(v_logical_operation_prefix) + 1)
			!~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
		raise exception 'cloud secret effect receipt is unavailable' using errcode = '42501';
	end if;
	select version.* into strict v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id=v_secret.id and version.version=v_secret.current_version for share;
	if v_version.broker_authority_id <> v_authority.id or v_version.key_id <> v_authority.key_id then
		raise exception 'cloud secret version is unavailable' using errcode = '42501';
	end if;
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id,environment_id,secret_id,secret_version,grant_id,run_id,receipt_id,event_type,
		connector_id,operation_id
	) values (
		v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,v_grant.id,
		(p_binding->>'runId')::uuid,p_receipt_id,'effect_authorized',v_operation.connector_id,v_operation.operation_id
	);
	return jsonb_build_object(
		'schema','qorpera.cloud-secret-operation-authorization/v1',
		'companyId',v_secret.profile_id,'environmentId',v_secret.environment_id,
		'secretId',v_secret.id,'secretVersion',v_secret.current_version,'keyId',v_version.key_id,
		'grantId',v_grant.id,'connectorId',v_operation.connector_id,'operationId',v_operation.operation_id,
		'operationVersion',v_operation.version,'adapterSha256',v_operation.adapter_sha256,
		'destinationOrigin',v_operation.destination_origin,'credentialName',v_operation.credential_name,
		'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
		'envelopeSha256',v_version.envelope_sha256,'receiptId',p_receipt_id,'inputSha256',p_input_sha256
	);
end
$$;

create function public.qorpera_revoke_secret_grants_for_inactive_staff()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if new.employment_status <> 'active' and old.employment_status = 'active' then
		update public.qorpera_cloud_secret_operation_grants
		set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=new.updated_by_user_id
		where profile_id=new.profile_id and staff_agent_id=new.staff_agent_id and status='active';
	end if;
	return new;
end
$$;

create trigger qorpera_cloud_secret_staff_archive
	after update of employment_status on public.qorpera_profile_staff
	for each row execute function public.qorpera_revoke_secret_grants_for_inactive_staff();

create function public.qorpera_revoke_member_secrets_on_removal()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_cloud_secrets
	set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=null,updated_at=statement_timestamp()
	where profile_id=old.profile_id and owner_kind='member' and owner_user_id=old.user_id and status='active';
	update public.qorpera_cloud_secret_operation_grants as grant_row
	set status='revoked',revoked_at=statement_timestamp(),revoked_by_user_id=null
	from public.qorpera_cloud_secrets as secret
	where grant_row.secret_id=secret.id and secret.profile_id=old.profile_id
		and secret.owner_kind='member' and secret.owner_user_id=old.user_id and grant_row.status='active';
	return old;
end
$$;

create trigger qorpera_cloud_secret_member_removal
	after delete on public.qorpera_profile_members
	for each row execute function public.qorpera_revoke_member_secrets_on_removal();

revoke all on function public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid) from public, anon, service_role;
revoke all on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_list_cloud_secret_connections(uuid,uuid) from public, anon, service_role;
revoke all on function public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz) from public, anon, service_role;
revoke all on function public.qorpera_revoke_cloud_secret_grant(uuid,uuid) from public, anon, service_role;
revoke all on function public.qorpera_revoke_cloud_secret(uuid,uuid) from public, anon, service_role;
revoke all on function public.qorpera_native_connector_locked_grant(jsonb,uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_list_native_connector_tools(jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_assert_native_connector_operation(jsonb,uuid,text,text,bigint,text,text) from public, anon, authenticated;
revoke all on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_revoke_secret_grants_for_inactive_staff() from public, anon, authenticated, service_role;
revoke all on function public.qorpera_revoke_member_secrets_on_removal() from public, anon, authenticated, service_role;

grant execute on function public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid) to authenticated;
grant usage on schema public to qorpera_secret_broker;
grant execute on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text) to qorpera_secret_broker;
grant execute on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text) to qorpera_secret_broker;
grant execute on function public.qorpera_list_cloud_secret_connections(uuid,uuid) to authenticated;
grant execute on function public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz) to authenticated;
grant execute on function public.qorpera_revoke_cloud_secret_grant(uuid,uuid) to authenticated;
grant execute on function public.qorpera_revoke_cloud_secret(uuid,uuid) to authenticated;
grant execute on function public.qorpera_list_native_connector_tools(jsonb) to service_role;
grant execute on function public.qorpera_assert_native_connector_operation(jsonb,uuid,text,text,bigint,text,text) to service_role;
grant execute on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text) to qorpera_secret_broker;
