-- Vault By Default, part 1 (founder decisions 2026-09-28, "Vault By Default"): one shared vault registers
-- every new company itself.
--
-- Until now each company's vault (cloud secret broker) was made by hand: an authority row, a capability and
-- a key per company, and an operator switch for vault sign-in. A broker *principal* is the shared vault's own
-- identity. It serves every company created after its start time: the shared broker lists those companies,
-- and registers each one that has no authority yet. Registering creates the company's authority row, with
-- the principal's service origin and key id and the capability hash the broker derived for that company,
-- and switches the company to vault sign-in. After that every existing broker function works for the
-- company unchanged, since each call still names the company's own authority and capability.
--
-- Existing companies keep their own brokers, or none, and are switched one by one as before. A principal
-- never registers a company created before its start time, and never takes over an authority. Locks: the
-- new authority row and the company's switch row, plus the key-share locks their foreign keys take on the
-- company's profile row and the principal row.
set local lock_timeout = '3s';

create table public.qorpera_cloud_secret_broker_principals (
	id uuid primary key default extensions.gen_random_uuid(),
	service_origin text not null check (
		service_origin ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'
		and char_length(service_origin) <= 512
	),
	-- The key id the companies it registers get: the broker derives each company's key from its master key.
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	capability_sha256 text not null unique check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	-- Only companies created after this serve from the shared vault by themselves.
	registers_companies_created_after timestamptz not null,
	status text not null default 'active' check (status in ('active','retired')),
	created_at timestamptz not null default statement_timestamp(),
	retired_at timestamptz,
	check ((status = 'retired') = (retired_at is not null))
);
alter table public.qorpera_cloud_secret_broker_principals enable row level security;
revoke all on public.qorpera_cloud_secret_broker_principals
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_cloud_secret_broker_authorities
	add column principal_id uuid references public.qorpera_cloud_secret_broker_principals(id) on delete restrict;
create index qorpera_cloud_secret_broker_authorities_principal
	on public.qorpera_cloud_secret_broker_authorities(principal_id) where principal_id is not null;

-- The shared broker's guard: its own database login, an active principal, the matching capability.
create function public.qorpera_broker_principal(p_principal_id uuid, p_capability_sha256 text)
returns public.qorpera_cloud_secret_broker_principals
language plpgsql stable security definer set search_path = '' as $$
declare v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = p_principal_id;
	if v_principal.id is null or v_principal.status <> 'active'
		or v_principal.capability_sha256 is distinct from p_capability_sha256 then
		raise exception 'cloud secret broker principal is unavailable' using errcode = '42501';
	end if;
	return v_principal;
end
$$;

-- The companies the shared broker serves (their authorities) and, at most 50 at a time, the companies it
-- should register: created after its start time and with no authority at all.
create function public.qorpera_broker_principal_companies(p_principal_id uuid, p_capability_sha256 text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_registered jsonb;
	v_unregistered jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(jsonb_build_object('companyId', authority.profile_id, 'authorityId', authority.id,
			'keyId', authority.key_id) order by authority.created_at, authority.id), '[]'::jsonb)
	into v_registered
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.principal_id = v_principal.id and authority.status = 'active';
	select coalesce(jsonb_agg(waiting.id order by waiting.created_at, waiting.id), '[]'::jsonb)
	into v_unregistered
	from (
		select profile.id, profile.created_at from public.qorpera_profiles as profile
		where profile.created_at > v_principal.registers_companies_created_after
			and not exists (select 1 from public.qorpera_cloud_secret_broker_authorities as authority
				where authority.profile_id = profile.id)
		order by profile.created_at, profile.id
		limit 50
	) as waiting;
	return jsonb_build_object('schema', 'qorpera.broker-principal-companies/v1', 'keyId', v_principal.key_id,
		'registered', v_registered, 'unregistered', v_unregistered);
end
$$;

-- Registers a new company with the shared broker: its authority row (the principal's origin and key id,
-- the capability hash the broker derived for it) and its switch to vault sign-in. A repeat with the same
-- capability, by either copy of the shared broker and at the same moment too, answers the same authority
-- and changes nothing: only the call that creates the authority switches the company on, so an operator's
-- later switch-off stays.
create function public.qorpera_register_company_with_broker_principal(
	p_principal_id uuid,
	p_capability_sha256 text,
	p_profile_id uuid,
	p_authority_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_created_at timestamptz;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_created boolean := false;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_profile_id is null or coalesce(p_authority_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_authority_capability_sha256 = v_principal.capability_sha256 then
		raise exception 'company registration is invalid' using errcode = '22023';
	end if;
	select profile.created_at into v_created_at from public.qorpera_profiles as profile where profile.id = p_profile_id;
	if v_created_at is null or v_created_at <= v_principal.registers_companies_created_after then
		raise exception 'company is not the shared vault''s to register' using errcode = '42501';
	end if;
	begin
		insert into public.qorpera_cloud_secret_broker_authorities(profile_id, service_origin, key_id,
			capability_sha256, principal_id)
		values (p_profile_id, v_principal.service_origin, v_principal.key_id, p_authority_capability_sha256,
			v_principal.id)
		on conflict (profile_id) do nothing
		returning * into v_authority;
		v_created := v_authority.id is not null;
	exception when unique_violation then
		-- The other copy registered the same company at the same moment, and its capability hash (unique too)
		-- clashed first. The unique check waited for that copy's commit: the row below is its.
		v_created := false;
	end;
	if not v_created then
		select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.profile_id = p_profile_id;
		if v_authority.id is null then
			-- The capability hash names another company's authority.
			raise exception 'company registration capability is taken' using errcode = '22023';
		end if;
		if v_authority.principal_id is distinct from v_principal.id
			or v_authority.capability_sha256 is distinct from p_authority_capability_sha256
			or v_authority.status <> 'active' then
			raise exception 'company already has a vault' using errcode = '23505';
		end if;
	else
		insert into public.qorpera_model_login_sign_in_companies(profile_id) values (p_profile_id)
		on conflict (profile_id) do nothing;
	end if;
	return jsonb_build_object('schema', 'qorpera.broker-principal-registration/v1', 'companyId', p_profile_id,
		'authorityId', v_authority.id, 'keyId', v_authority.key_id);
end
$$;

revoke all on function public.qorpera_broker_principal(uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_broker_principal_companies(uuid,text),
	public.qorpera_register_company_with_broker_principal(uuid,text,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_broker_principal_companies(uuid,text),
	public.qorpera_register_company_with_broker_principal(uuid,text,uuid,text)
	to qorpera_secret_broker;
