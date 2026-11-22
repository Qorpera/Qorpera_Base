do $$ begin
	if to_regclass('public.qorpera_gemini_keys') is not null then
		raise exception '20260930823000 is already applied'; end if;
	if to_regprocedure('public.qorpera_pin_execution_claude_choice()') is null
		or to_regprocedure('public.qorpera_model_policy_thread_efforts(jsonb)') is null
		or to_regprocedure('public.qorpera_company_account_vault(uuid)') is null
		or to_regprocedure('public.qorpera_model_login_authority(uuid,text)') is null
		or to_regprocedure('public.qorpera_model_login_run_binding(jsonb)') is null
		or to_regprocedure('public.qorpera_native_tool_locked_run(jsonb)') is null
		or to_regclass('public.qorpera_member_notifications') is null then
		raise exception '20260930823000 needs conversation models (20260930784000, 20260930788000, 20260930816000) and the shared vault';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.gm_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930823000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create table public.qorpera_gemini_keys (
	id uuid primary key default extensions.gen_random_uuid(),
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	principal_id uuid not null references public.qorpera_cloud_secret_broker_principals(id) on delete restrict,
	key_id text check (key_id is null or key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	encrypted_envelope bytea check (encrypted_envelope is null or octet_length(encrypted_envelope) between 1 and 131072),
	envelope_sha256 text check (envelope_sha256 is null or envelope_sha256 ~ '^[0-9a-f]{64}$'),
	key_hint text not null check (char_length(btrim(key_hint)) between 4 and 16 and key_hint !~ E'[\r\n]'),
	default_for_chats boolean not null default false,
	monthly_cap_cents bigint check (monthly_cap_cents is null or monthly_cap_cents between 100 and 10000000),
	spend_month text not null default to_char(timezone('UTC', statement_timestamp()), 'YYYY-MM')
		check (spend_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	month_spend_microdollars bigint not null default 0 check (month_spend_microdollars >= 0),
	month_input_tokens bigint not null default 0 check (month_input_tokens >= 0),
	month_cached_tokens bigint not null default 0 check (month_cached_tokens >= 0),
	month_output_tokens bigint not null default 0 check (month_output_tokens >= 0),
	version bigint not null default 1 check (version >= 1),
	status text not null default 'active' check (status in ('active', 'revoked')),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	check ((status = 'active') = (encrypted_envelope is not null and envelope_sha256 is not null and key_id is not null
		and revoked_at is null))
);
create unique index qorpera_gemini_keys_one_active on public.qorpera_gemini_keys(owner_user_id)
	where status = 'active';
alter table public.qorpera_gemini_keys enable row level security;
revoke all on public.qorpera_gemini_keys from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_gemini_key_tickets (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	principal_id uuid not null references public.qorpera_cloud_secret_broker_principals(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	gemini_key_id uuid not null default extensions.gen_random_uuid(),
	default_for_chats boolean not null default false,
	monthly_cap_cents bigint check (monthly_cap_cents is null or monthly_cap_cents between 100 and 10000000),
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'pending' check (status in ('pending', 'completed', 'expired')),
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz not null,
	completed_at timestamptz
);
create index qorpera_gemini_key_tickets_owner on public.qorpera_gemini_key_tickets(owner_user_id, status);
alter table public.qorpera_gemini_key_tickets enable row level security;
revoke all on public.qorpera_gemini_key_tickets from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_gemini_run_usage (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	lease_id uuid not null,
	gemini_key_id uuid not null references public.qorpera_gemini_keys(id) on delete restrict,
	spend_month text not null check (spend_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	input_tokens bigint not null default 0 check (input_tokens >= 0),
	cached_tokens bigint not null default 0 check (cached_tokens >= 0),
	output_tokens bigint not null default 0 check (output_tokens >= 0),
	spend_microdollars bigint not null default 0 check (spend_microdollars >= 0),
	updated_at timestamptz not null default statement_timestamp(),
	primary key (run_id, lease_id)
);
alter table public.qorpera_gemini_run_usage enable row level security;
revoke all on public.qorpera_gemini_run_usage from public, anon, authenticated, service_role, qorpera_secret_broker;

do $kinds$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(c.oid) into v_definition from pg_constraint c
	where c.conrelid = 'public.qorpera_member_notifications'::regclass and c.conname = 'qorpera_member_notifications_kind';
	select array(select distinct k from unnest(
			coalesce(string_to_array((regexp_match(v_definition, '''\{([a-z_,]+)\}'''))[1], ','), '{}'::text[])
			|| array(select m.parts[1] from regexp_matches(v_definition, '''([a-z_]+)''', 'g') as m(parts))
			|| array['gemini_cap_reached']) k order by k)
	into v_kinds;
	if cardinality(v_kinds) < 8 then
		raise exception '20260930823000 could not read the notification kinds'; end if;
	execute format('alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind, '
		'add constraint qorpera_member_notifications_kind check (kind = any (%L::text[]))', v_kinds);
end $kinds$;

create function public.qorpera_gemini_current_month()
returns text language sql volatile set search_path = '' as $$
	select to_char(timezone('UTC', clock_timestamp()), 'YYYY-MM')
$$;

create function public.qorpera_gemini_neon_microdollars(p_input_tokens bigint, p_cached_tokens bigint, p_output_tokens bigint)
returns bigint language sql immutable set search_path = '' as $$
	select greatest(0::bigint, p_input_tokens - least(p_input_tokens, p_cached_tokens)) * 3::bigint
		+ ((least(p_input_tokens, p_cached_tokens) * 15::bigint + 99::bigint) / 100::bigint)
		+ greatest(0::bigint, p_output_tokens) * 15::bigint
$$;

create function public.qorpera_gemini_key_month_spend(p_key public.qorpera_gemini_keys)
returns bigint language sql stable set search_path = '' as $$
	select case when p_key.id is not null and p_key.spend_month = public.qorpera_gemini_current_month()
		then p_key.month_spend_microdollars else 0::bigint end
$$;

create function public.qorpera_gemini_key_cap_reached(p_key public.qorpera_gemini_keys)
returns boolean language sql stable set search_path = '' as $$
	select coalesce(p_key.id is not null and p_key.monthly_cap_cents is not null
		and public.qorpera_gemini_key_month_spend(p_key) >= p_key.monthly_cap_cents * 10000::bigint, false)
$$;

create function public.qorpera_member_gemini_key_open(p_profile_id uuid, p_user_id uuid)
returns public.qorpera_gemini_keys language sql stable security definer set search_path = '' as $$
	select key.*
	from public.qorpera_gemini_keys as key
	where p_profile_id is not null and p_user_id is not null
		and key.owner_user_id = p_user_id and key.status = 'active'
		and key.principal_id = public.qorpera_company_account_vault(p_profile_id)
		and exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id)
	limit 1
$$;

create function public.qorpera_member_may_pick_gemini(p_profile_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select (public.qorpera_member_gemini_key_open(p_profile_id, p_user_id)).id is not null
$$;

create function public.qorpera_active_bundle_gemini_choice()
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select bundle.manifest #>> '{modelPolicy,geminiChoice}' = 'thread'
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton), false)
$$;

revoke all on function public.qorpera_gemini_current_month(),
	public.qorpera_gemini_neon_microdollars(bigint, bigint, bigint),
	public.qorpera_gemini_key_month_spend(public.qorpera_gemini_keys),
	public.qorpera_gemini_key_cap_reached(public.qorpera_gemini_keys),
	public.qorpera_member_gemini_key_open(uuid, uuid),
	public.qorpera_member_may_pick_gemini(uuid, uuid),
	public.qorpera_active_bundle_gemini_choice()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_get_gemini_key(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_principal uuid;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_same_month boolean;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Gemini key settings are unavailable' using errcode = '42501'; end if;
	v_principal := public.qorpera_company_account_vault(p_profile_id);
	if v_principal is not null then
		select key.* into v_key from public.qorpera_gemini_keys as key
		where key.owner_user_id = v_user and key.status = 'active' and key.principal_id = v_principal;
	end if;
	if v_key.id is null then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key/v1',
			'vaultAvailable', v_principal is not null,
			'key', null
		);
	end if;
	v_same_month := v_key.spend_month = v_month;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key/v1',
		'vaultAvailable', true,
		'key', jsonb_build_object(
			'id', v_key.id,
			'keyHint', v_key.key_hint,
			'defaultForChats', v_key.default_for_chats,
			'monthlyCapCents', v_key.monthly_cap_cents,
			'spendMonth', v_month,
			'monthSpendMicrodollars', case when v_same_month then v_key.month_spend_microdollars else 0::bigint end,
			'monthInputTokens', case when v_same_month then v_key.month_input_tokens else 0::bigint end,
			'monthCachedTokens', case when v_same_month then v_key.month_cached_tokens else 0::bigint end,
			'monthOutputTokens', case when v_same_month then v_key.month_output_tokens else 0::bigint end,
			'capReached', public.qorpera_gemini_key_cap_reached(v_key),
			'version', v_key.version,
			'createdAt', v_key.created_at,
			'updatedAt', v_key.updated_at
		)
	);
end $$;

create function public.qorpera_begin_gemini_key_save(
	p_profile_id uuid,
	p_default_for_chats boolean default false,
	p_monthly_cap_cents bigint default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
	v_capability text := encode(extensions.gen_random_bytes(32), 'hex');
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user
				and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Gemini key capture requires member authority' using errcode = '42501'; end if;
	if p_default_for_chats is null
		or (p_monthly_cap_cents is not null and p_monthly_cap_cents not between 100 and 10000000) then
		raise exception 'Gemini key settings are invalid' using errcode = '22023'; end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	join public.qorpera_cloud_secret_broker_principals as principal on principal.id = authority.principal_id
	where authority.profile_id = p_profile_id and authority.status = 'active' and principal.status = 'active'
	order by authority.created_at desc, authority.id
	limit 1;
	if v_authority.id is null or v_authority.principal_id is null then
		raise exception 'The shared vault is unavailable for this company' using errcode = '55000'; end if;
	update public.qorpera_gemini_key_tickets
	set status = 'expired'
	where owner_user_id = v_user and status = 'pending' and expires_at <= clock_timestamp();
	insert into public.qorpera_gemini_key_tickets (
		profile_id, owner_user_id, broker_authority_id, principal_id, key_id,
		default_for_chats, monthly_cap_cents, capability_sha256, expires_at
	) values (
		p_profile_id, v_user, v_authority.id, v_authority.principal_id, v_authority.key_id,
		p_default_for_chats, p_monthly_cap_cents, encode(extensions.digest(v_capability, 'sha256'), 'hex'),
		clock_timestamp() + interval '10 minutes'
	) returning * into v_ticket;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-ticket/v1',
		'ticketId', v_ticket.id,
		'capability', v_capability,
		'serviceOrigin', v_authority.service_origin,
		'profileId', p_profile_id,
		'expiresAt', v_ticket.expires_at
	);
end $$;

create function public.qorpera_update_gemini_key_settings(
	p_profile_id uuid,
	p_default_for_chats boolean,
	p_monthly_cap_cents bigint,
	p_expected_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_principal uuid;
	v_key public.qorpera_gemini_keys%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user
				and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Gemini key settings require member authority' using errcode = '42501'; end if;
	if p_default_for_chats is null
		or (p_monthly_cap_cents is not null and p_monthly_cap_cents not between 100 and 10000000)
		or p_expected_version is null or p_expected_version < 1 then
		raise exception 'Gemini key settings are invalid' using errcode = '22023'; end if;
	v_principal := public.qorpera_company_account_vault(p_profile_id);
	if v_principal is null then
		raise exception 'The shared vault is unavailable for this company' using errcode = '55000'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.owner_user_id = v_user and key.status = 'active' and key.principal_id = v_principal
	for update;
	if v_key.id is null then
		raise exception 'No active Gemini API key is configured' using errcode = '55000'; end if;
	if v_key.version <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Gemini key settings changed; refresh before retrying', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	update public.qorpera_gemini_keys
	set default_for_chats = p_default_for_chats,
		monthly_cap_cents = p_monthly_cap_cents,
		version = version + 1,
		updated_at = clock_timestamp()
	where id = v_key.id
	returning * into v_key;
	if not public.qorpera_gemini_key_cap_reached(v_key) then
		update public.qorpera_member_notifications
		set acknowledged_at = clock_timestamp()
		where user_id = v_user and kind = 'gemini_cap_reached' and acknowledged_at is null;
	end if;
	return public.qorpera_get_gemini_key(p_profile_id);
end $$;

create function public.qorpera_revoke_gemini_key(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Gemini key revocation requires member authority' using errcode = '42501'; end if;
	update public.qorpera_gemini_keys
	set status = 'revoked',
		encrypted_envelope = null,
		envelope_sha256 = null,
		key_id = null,
		default_for_chats = false,
		revoked_at = clock_timestamp(),
		updated_at = clock_timestamp(),
		version = version + 1
	where owner_user_id = v_user and status = 'active';
	update public.qorpera_member_notifications
	set acknowledged_at = clock_timestamp()
	where user_id = v_user and kind = 'gemini_cap_reached' and acknowledged_at is null;
	return public.qorpera_get_gemini_key(p_profile_id);
end $$;

revoke all on function public.qorpera_get_gemini_key(uuid),
	public.qorpera_begin_gemini_key_save(uuid, boolean, bigint),
	public.qorpera_update_gemini_key_settings(uuid, boolean, bigint, bigint),
	public.qorpera_revoke_gemini_key(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_get_gemini_key(uuid),
	public.qorpera_begin_gemini_key_save(uuid, boolean, bigint),
	public.qorpera_update_gemini_key_settings(uuid, boolean, bigint, bigint),
	public.qorpera_revoke_gemini_key(uuid)
	to authenticated;

create function public.qorpera_describe_gemini_key_ticket(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capability_sha256 text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_ticket_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Gemini key ticket request is invalid' using errcode = '22023'; end if;
	select ticket.* into v_ticket from public.qorpera_gemini_key_tickets as ticket where ticket.id = p_ticket_id;
	if v_ticket.id is null or v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.principal_id is distinct from v_authority.principal_id
		or v_ticket.capability_sha256 <> p_capability_sha256
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()
		or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_authority.principal_id then
		raise exception 'Gemini key ticket is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-ticket-description/v1',
		'ticketId', v_ticket.id,
		'profileId', v_ticket.profile_id,
		'ownerUserId', v_ticket.owner_user_id,
		'geminiKeyId', v_ticket.gemini_key_id,
		'keyId', v_ticket.key_id,
		'defaultForChats', v_ticket.default_for_chats,
		'monthlyCapCents', v_ticket.monthly_cap_cents,
		'expiresAt', v_ticket.expires_at
	);
end $$;

create function public.qorpera_complete_gemini_key_save(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capability_sha256 text,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_key_hint text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
	v_previous public.qorpera_gemini_keys%rowtype;
	v_saved public.qorpera_gemini_keys%rowtype;
	v_envelope bytea;
	v_month text := public.qorpera_gemini_current_month();
	v_carry boolean := false;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_ticket_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_key_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_key_hint is null or char_length(btrim(p_key_hint)) not between 4 and 16
		or p_key_hint ~ E'[\r\n]' then
		raise exception 'Gemini key completion is invalid' using errcode = '22023'; end if;
	begin
		v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	exception when others then
		raise exception 'Gemini key envelope is invalid' using errcode = '22023';
	end;
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'Gemini key envelope is invalid' using errcode = '22023'; end if;
	select ticket.* into v_ticket from public.qorpera_gemini_key_tickets as ticket
	where ticket.id = p_ticket_id for update;
	if v_ticket.id is null or v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.principal_id is distinct from v_authority.principal_id
		or v_ticket.capability_sha256 <> p_capability_sha256
		or v_ticket.key_id <> p_key_id
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()
		or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_authority.principal_id then
		raise exception 'Gemini key ticket is unavailable' using errcode = '42501'; end if;
	select key.* into v_previous from public.qorpera_gemini_keys as key
	where key.owner_user_id = v_ticket.owner_user_id and key.status = 'active'
	for update;
	if v_previous.id is not null then
		v_carry := v_previous.spend_month = v_month;
		update public.qorpera_gemini_keys
		set status = 'revoked',
			encrypted_envelope = null,
			envelope_sha256 = null,
			key_id = null,
			default_for_chats = false,
			revoked_at = clock_timestamp(),
			updated_at = clock_timestamp(),
			version = version + 1
		where id = v_previous.id;
	end if;
	insert into public.qorpera_gemini_keys (
		id, owner_user_id, principal_id, key_id, encrypted_envelope, envelope_sha256,
		key_hint, default_for_chats, monthly_cap_cents,
		spend_month, month_spend_microdollars, month_input_tokens, month_cached_tokens, month_output_tokens
	) values (
		v_ticket.gemini_key_id, v_ticket.owner_user_id, v_ticket.principal_id, p_key_id, v_envelope, p_envelope_sha256,
		btrim(p_key_hint), v_ticket.default_for_chats, v_ticket.monthly_cap_cents,
		v_month,
		case when v_carry then v_previous.month_spend_microdollars else 0::bigint end,
		case when v_carry then v_previous.month_input_tokens else 0::bigint end,
		case when v_carry then v_previous.month_cached_tokens else 0::bigint end,
		case when v_carry then v_previous.month_output_tokens else 0::bigint end
	) returning * into v_saved;
	update public.qorpera_gemini_key_tickets
	set status = 'completed', completed_at = clock_timestamp()
	where id = v_ticket.id;
	if not public.qorpera_gemini_key_cap_reached(v_saved) then
		update public.qorpera_member_notifications
		set acknowledged_at = clock_timestamp()
		where user_id = v_ticket.owner_user_id and kind = 'gemini_cap_reached' and acknowledged_at is null;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-saved/v1',
		'id', v_saved.id,
		'keyHint', v_saved.key_hint,
		'defaultForChats', v_saved.default_for_chats,
		'monthlyCapCents', v_saved.monthly_cap_cents,
		'version', v_saved.version
	);
end $$;

create function public.qorpera_open_gemini_key_for_run(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_spend bigint;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_lease.run_id;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_run.gemini_key_id;
	if v_run.id is null or v_run.profile_id is distinct from v_authority.profile_id
		or v_run.gemini_model is null or v_run.gemini_key_id is null
		or v_run.source_kind not in ('session_turn', 'room_delivery')
		or v_principal.id is null or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_principal.id
		or v_key.id is null or v_key.principal_id is distinct from v_principal.id
		or v_key.owner_user_id is distinct from coalesce(v_run.requested_by_user_id, v_run.created_by_user_id) then
		raise exception 'Gemini key is unavailable to this run' using errcode = '42501'; end if;
	if v_key.status <> 'active' then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'REVOKED'
		);
	end if;
	v_spend := public.qorpera_gemini_key_month_spend(v_key);
	if public.qorpera_gemini_key_cap_reached(v_key) then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'CAP_REACHED',
			'spendMonth', v_month,
			'monthSpendMicrodollars', v_spend,
			'monthlyCapCents', v_key.monthly_cap_cents
		);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-for-run/v1',
		'state', 'open',
		'geminiKeyId', v_key.id,
		'ownerUserId', v_key.owner_user_id,
		'keyId', v_key.key_id,
		'version', v_key.version,
		'envelopeSha256', v_key.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_key.encrypted_envelope, 'base64'),
		'spendMonth', v_month,
		'monthSpendMicrodollars', v_spend,
		'monthlyCapCents', v_key.monthly_cap_cents
	);
end $$;

revoke all on function public.qorpera_describe_gemini_key_ticket(uuid, text, uuid, text),
	public.qorpera_complete_gemini_key_save(uuid, text, uuid, text, text, text, text, text),
	public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_describe_gemini_key_ticket(uuid, text, uuid, text),
	public.qorpera_complete_gemini_key_save(uuid, text, uuid, text, text, text, text, text),
	public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	to qorpera_secret_broker;

create function public.qorpera_record_gemini_run_usage(p_binding jsonb, p_usage jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_lease_id uuid;
	v_key public.qorpera_gemini_keys%rowtype;
	v_prev public.qorpera_gemini_run_usage%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_input bigint;
	v_cached bigint;
	v_output bigint;
	v_spend bigint;
	v_next_input bigint;
	v_next_cached bigint;
	v_next_output bigint;
	v_next_spend bigint;
	v_delta_input bigint;
	v_delta_cached bigint;
	v_delta_output bigint;
	v_delta_spend bigint;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini run usage is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_lease_id := (p_binding ->> 'leaseId')::uuid;
	if v_run.gemini_model is null or v_run.gemini_key_id is null then
		raise exception 'The run is not a Gemini run' using errcode = '42501'; end if;
	if jsonb_typeof(p_usage) <> 'object'
		or (select count(*) from jsonb_object_keys(p_usage)) <> 3
		or not (p_usage ? 'inputTokens' and p_usage ? 'cachedTokens' and p_usage ? 'outputTokens')
		or jsonb_typeof(p_usage -> 'inputTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'cachedTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'outputTokens') <> 'number'
		or (p_usage ->> 'inputTokens') !~ '^\d{1,10}$'
		or (p_usage ->> 'cachedTokens') !~ '^\d{1,10}$'
		or (p_usage ->> 'outputTokens') !~ '^\d{1,10}$' then
		raise exception 'Gemini run usage is invalid' using errcode = '22023'; end if;
	v_input := (p_usage ->> 'inputTokens')::bigint;
	v_cached := (p_usage ->> 'cachedTokens')::bigint;
	v_output := (p_usage ->> 'outputTokens')::bigint;
	if v_input > 1000000000 or v_cached > v_input or v_output > 1000000000 then
		raise exception 'Gemini run usage is invalid' using errcode = '22023'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.id = v_run.gemini_key_id for update;
	if v_key.id is null then
		raise exception 'Gemini key is unavailable' using errcode = '42501'; end if;
	if v_key.spend_month <> v_month then
		v_key.spend_month := v_month;
		v_key.month_spend_microdollars := 0;
		v_key.month_input_tokens := 0;
		v_key.month_cached_tokens := 0;
		v_key.month_output_tokens := 0;
	end if;
	select usage.* into v_prev from public.qorpera_gemini_run_usage as usage
	where usage.run_id = v_run.id and usage.lease_id = v_lease_id for update;
	v_spend := public.qorpera_gemini_neon_microdollars(v_input, v_cached, v_output);
	v_next_input := greatest(v_input, coalesce(v_prev.input_tokens, 0));
	v_next_cached := greatest(v_cached, coalesce(v_prev.cached_tokens, 0));
	v_next_output := greatest(v_output, coalesce(v_prev.output_tokens, 0));
	v_next_spend := greatest(v_spend, coalesce(v_prev.spend_microdollars, 0));
	v_delta_input := v_next_input - coalesce(v_prev.input_tokens, 0);
	v_delta_cached := v_next_cached - coalesce(v_prev.cached_tokens, 0);
	v_delta_output := v_next_output - coalesce(v_prev.output_tokens, 0);
	v_delta_spend := v_next_spend - coalesce(v_prev.spend_microdollars, 0);
	insert into public.qorpera_gemini_run_usage (
		run_id, lease_id, gemini_key_id, spend_month, input_tokens, cached_tokens, output_tokens, spend_microdollars, updated_at
	) values (
		v_run.id, v_lease_id, v_key.id, v_month, v_next_input, v_next_cached, v_next_output, v_next_spend, clock_timestamp()
	)
	on conflict (run_id, lease_id) do update set
		input_tokens = excluded.input_tokens,
		cached_tokens = excluded.cached_tokens,
		output_tokens = excluded.output_tokens,
		spend_microdollars = excluded.spend_microdollars,
		updated_at = clock_timestamp();
	update public.qorpera_gemini_keys
	set spend_month = v_month,
		month_spend_microdollars = v_key.month_spend_microdollars + v_delta_spend,
		month_input_tokens = v_key.month_input_tokens + v_delta_input,
		month_cached_tokens = v_key.month_cached_tokens + v_delta_cached,
		month_output_tokens = v_key.month_output_tokens + v_delta_output,
		updated_at = clock_timestamp()
	where id = v_key.id
	returning * into v_key;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-run-usage/v1',
		'spendMonth', v_key.spend_month,
		'monthSpendMicrodollars', v_key.month_spend_microdollars,
		'monthlyCapCents', v_key.monthly_cap_cents,
		'capReached', public.qorpera_gemini_key_cap_reached(v_key)
	);
end $$;

create function public.qorpera_record_gemini_cap_reached(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_spend bigint;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini cap notice is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_run.gemini_model is null or v_run.gemini_key_id is null then
		raise exception 'The run is not a Gemini run' using errcode = '42501'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_run.gemini_key_id;
	if v_key.id is null or v_key.monthly_cap_cents is null or not public.qorpera_gemini_key_cap_reached(v_key) then
		return jsonb_build_object('schema', 'qorpera.gemini-cap-notice/v1', 'recorded', false); end if;
	v_spend := public.qorpera_gemini_key_month_spend(v_key);
	insert into public.qorpera_member_notifications (profile_id, user_id, kind, subject, dedupe_key)
	values (
		v_run.profile_id,
		v_key.owner_user_id,
		'gemini_cap_reached',
		jsonb_build_object(
			'schema', 'qorpera.member-notification.gemini-cap-reached/v1',
			'month', v_month,
			'spendMicrodollars', v_spend,
			'monthlyCapCents', v_key.monthly_cap_cents,
			'runId', v_run.id,
			'sessionId', v_run.session_id
		),
		'gemini-cap:' || v_key.id::text || ':' || v_month || ':' || v_key.monthly_cap_cents::text
	)
	on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	return jsonb_build_object('schema', 'qorpera.gemini-cap-notice/v1', 'recorded', true);
end $$;

revoke all on function public.qorpera_record_gemini_run_usage(jsonb, jsonb),
	public.qorpera_record_gemini_cap_reached(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_run_usage(jsonb, jsonb),
	public.qorpera_record_gemini_cap_reached(jsonb)
	to service_role;
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_record_gemini_run_usage', 'binding'), ('qorpera_record_gemini_cap_reached', 'binding');

alter table public.qorpera_session_models drop constraint qorpera_session_models_model_id_check;
alter table public.qorpera_session_models
	add constraint qorpera_session_models_model_id_check check (model_id in ('gpt-6-astra','gpt-6.2-sol','gpt-6-sol',
		'gpt-6-luna','claude-fable-5-2','claude-opus-5-5','gemini-4-neon'));

alter table public.qorpera_execution_runs
	add column gemini_model text
		constraint qorpera_execution_runs_gemini_model_check check (gemini_model in ('gemini-4-neon')),
	add column gemini_effort text
		constraint qorpera_execution_runs_gemini_effort_check check (gemini_effort in ('low','medium','high','xhigh')),
	add column gemini_key_id uuid references public.qorpera_gemini_keys(id),
	add constraint qorpera_execution_runs_gemini_choice check ((gemini_model is null) = (gemini_effort is null)
		and (gemini_model is null) = (gemini_key_id is null)
		and (gemini_model is null or (source_kind in ('session_turn','room_delivery') and claude_model is null)));

select pg_temp.gm_replace('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended','claudeChoice',
			'threadEfforts'] <> '{}'::jsonb$old$,
	$new$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended','claudeChoice',
			'threadEfforts','geminiChoice'] <> '{}'::jsonb
		or ((v_manifest -> 'modelPolicy') ? 'geminiChoice'
			and v_manifest -> 'modelPolicy' -> 'geminiChoice' is distinct from '"thread"'::jsonb)$new$);

create function public.qorpera_resolve_run_gemini_choice(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_effort text;
begin
	if p_manifest #>> '{modelPolicy,geminiChoice}' is distinct from 'thread' then return null; end if;
	if p_run.source_kind not in ('session_turn', 'room_delivery') or p_run.session_id is null then return null; end if;
	select * into v_choice from public.qorpera_session_models as choice where choice.session_id = p_run.session_id;
	v_key := public.qorpera_member_gemini_key_open(p_run.profile_id,
		coalesce(p_run.requested_by_user_id, p_run.created_by_user_id));
	if v_key.id is null then return null; end if;
	if v_choice.model_id = 'gemini-4-neon' or (v_choice.model_id is null and v_key.default_for_chats) then
		v_effort := coalesce(v_choice.reasoning_effort, p_manifest #>> '{modelPolicy,effort}', 'low');
		if v_effort not in ('low', 'medium', 'high', 'xhigh') then v_effort := 'xhigh'; end if;
		return jsonb_build_object('model', 'gemini-4-neon', 'effort', v_effort, 'keyId', v_key.id);
	end if;
	return null;
end $$;
revoke all on function public.qorpera_resolve_run_gemini_choice(public.qorpera_execution_runs, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_pin_execution_gemini_choice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_choice jsonb;
begin
	if tg_op = 'UPDATE' then
		if (new.gemini_model, new.gemini_effort, new.gemini_key_id)
			is distinct from (old.gemini_model, old.gemini_effort, old.gemini_key_id) then
			raise exception 'Execution Gemini choice is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	v_choice := case when new.source_kind in ('session_turn', 'room_delivery')
		then public.qorpera_resolve_run_gemini_choice(new, public.qorpera_execution_runtime_manifest(new)) end;
	new.gemini_model := v_choice ->> 'model';
	new.gemini_effort := v_choice ->> 'effort';
	new.gemini_key_id := (v_choice ->> 'keyId')::uuid;
	return new;
end $$;
revoke all on function public.qorpera_pin_execution_gemini_choice()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_execution_run_gemini_choice
before insert or update of gemini_model, gemini_effort, gemini_key_id on public.qorpera_execution_runs
for each row execute function public.qorpera_pin_execution_gemini_choice();

select pg_temp.gm_replace('public.qorpera_execution_run_model_authority()',
	$old$			and choice.model_id not in ('claude-fable-5-2','claude-opus-5-5');$old$,
	$new$			and choice.model_id not in ('claude-fable-5-2','claude-opus-5-5','gemini-4-neon');$new$);

select pg_temp.gm_replace('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)',
	$old$				and coalesce(choice.model_id not in ('claude-fable-5-2','claude-opus-5-5'), true);$old$,
	$new$				and coalesce(choice.model_id not in ('claude-fable-5-2','claude-opus-5-5','gemini-4-neon'), true);$new$);

select pg_temp.gm_replace('public.qorpera_describe_company_run_context(jsonb)',
	$old$		|| case when v_run.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude',jsonb_build_object('model',v_run.claude_model,'effort',v_run.claude_effort)) end$old$,
	$new$		|| case when v_run.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude',jsonb_build_object('model',v_run.claude_model,'effort',v_run.claude_effort)) end
		|| case when v_run.gemini_model is null then '{}'::jsonb
			else jsonb_build_object('gemini',jsonb_build_object('model',v_run.gemini_model,'effort',v_run.gemini_effort,'keyId',v_run.gemini_key_id)) end$new$);

create or replace function public.qorpera_get_session_model(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_choice public.qorpera_session_models%rowtype;
	v_model text;
	v_policy jsonb;
	v_gemini public.qorpera_gemini_keys%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	select * into strict v_session from public.qorpera_shared_sessions where id = p_session_id;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	select bundle.manifest -> 'modelPolicy' into v_policy
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
	where active.singleton;
	v_gemini := public.qorpera_member_gemini_key_open(v_session.profile_id, auth.uid());
	v_model := v_choice.model_id;
	if v_model is null and v_policy ->> 'geminiChoice' = 'thread'
		and v_gemini.id is not null and v_gemini.default_for_chats then
		v_model := 'gemini-4-neon';
	end if;
	if v_model is null then
		select mapping.model_id into v_model from public.qorpera_staff_provider_models mapping
		where mapping.profile_id = v_session.profile_id and mapping.staff_agent_id::text = v_session.staff_agent_id
			and mapping.provider = 'openai';
	end if;
	return jsonb_build_object('session_id', p_session_id,
		'model_id', case when v_model is null and v_session.staff_agent_id is null then null
			else coalesce(v_model, 'gpt-6.2-sol') end,
		'version', coalesce(v_choice.version, 0))
		|| case when v_policy ->> 'overrides' = 'routine-and-thread' then jsonb_build_object('reasoning_effort',
			coalesce(v_choice.reasoning_effort, v_policy ->> 'effort', 'low')) else '{}'::jsonb end
		|| case when v_policy ->> 'fastMode' = 'thread' then jsonb_build_object('service_tier',
			coalesce(v_choice.service_tier, 'fast')) else '{}'::jsonb end
		|| case when v_gemini.id is not null and public.qorpera_gemini_key_cap_reached(v_gemini)
			then jsonb_build_object('gemini_cap_reached', true) else '{}'::jsonb end
		|| (select jsonb_build_object('models', listed.models, 'efforts', (select jsonb_object_agg(model.id,
				case when model.id in ('claude-fable-5-2','claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
				when model.id = 'gemini-4-neon' then '["low","medium","high","xhigh"]'::jsonb
				else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy) end)
			from jsonb_array_elements_text(listed.models) as model(id)))
		from (select '["gpt-6-astra","gpt-6.2-sol"]'::jsonb
			|| case when v_policy ->> 'claudeChoice' = 'thread'
				and public.qorpera_member_may_pick_claude(v_session.profile_id, auth.uid())
				then '["claude-fable-5-2","claude-opus-5-5"]'::jsonb else '[]'::jsonb end
			|| case when v_policy ->> 'geminiChoice' = 'thread'
				and v_gemini.id is not null
				then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end as models) as listed);
end $$;

create or replace function public.qorpera_set_session_model(
	p_session_id uuid, p_model_id text, p_expected_version bigint, p_reasoning_effort text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_user uuid;
	v_profile_id uuid;
	v_gemini public.qorpera_gemini_keys%rowtype;
	v_model text;
	v_effort text;
begin
	v_user := public.qorpera_session_model_writer(p_session_id);
	if (p_model_id is null and p_reasoning_effort is null)
		or (p_model_id is not null and p_model_id not in ('gpt-6-astra','gpt-6.2-sol','gpt-6-sol','gpt-6-luna',
			'claude-fable-5-2','claude-opus-5-5','gemini-4-neon'))
		or (p_reasoning_effort is not null and p_reasoning_effort not in ('low','medium','high','xhigh','max'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version, 0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Conversation model changed; refresh before retrying', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	select session.profile_id into strict v_profile_id from public.qorpera_shared_sessions as session
	where session.id = p_session_id;
	v_model := coalesce(p_model_id, v_choice.model_id);
	v_effort := coalesce(p_reasoning_effort, v_choice.reasoning_effort);
	if v_model is null and p_model_id is null and public.qorpera_active_bundle_gemini_choice() then
		v_gemini := public.qorpera_member_gemini_key_open(v_profile_id, v_user);
		if v_gemini.id is not null and v_gemini.default_for_chats then
			v_model := 'gemini-4-neon';
		end if;
	end if;
	if v_model in ('claude-fable-5-2','claude-opus-5-5') and not (public.qorpera_active_bundle_claude_choice()
		and public.qorpera_member_may_pick_claude(v_profile_id, v_user)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Claude is not open for you in this company: sign in to Claude in Settings, Model accounts',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_model = 'gemini-4-neon' and not (public.qorpera_active_bundle_gemini_choice()
		and public.qorpera_member_may_pick_gemini(v_profile_id, v_user)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC03',
			'message', 'Gemini 4 Neon is not configured: add your Gemini API key in Settings, AI subscriptions',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_effort in ('xhigh','max') and coalesce(v_model not in ('claude-fable-5-2','claude-opus-5-5'), true)
		and not (v_effort = 'xhigh' and coalesce(v_model = 'gemini-4-neon', false))
		and not (v_effort = 'xhigh' and v_model is not null and public.qorpera_active_bundle_thread_efforts() ? 'xhigh') then
		raise exception 'Conversation effort % is not open for this model', v_effort using errcode = '22023'; end if;
	insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version, updated_by_user_id)
	values(p_session_id, v_model, v_effort, p_expected_version + 1, v_user)
	on conflict(session_id) do update set model_id = excluded.model_id, reasoning_effort = excluded.reasoning_effort,
		version = excluded.version, updated_by_user_id = excluded.updated_by_user_id, updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;

drop function pg_temp.gm_replace(regprocedure, text, text);
