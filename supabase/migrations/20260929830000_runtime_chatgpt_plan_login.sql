-- Sign in with ChatGPT, slice 1a (built switched off; founder decision 2026-10-01): a second kind of
-- vault login, a member's ChatGPT Plus or Pro plan signed in through OpenAI's "Sign in with ChatGPT".
--
-- Today's vault login is a Codex login (auth.json) that the vault renews through Codex. A ChatGPT plan
-- login holds OAuth tokens: a one-hour access token and a rotating 30-day refresh token. The vault stays
-- the only renewer and renews one at a time on the login's own row, as for Codex logins. Runs still use
-- the Codex harness ('codex-cli'), so every run, lease and policy check keeps its shape; the run's host
-- learns the kind from the vault's answer.
--
-- This change adds:
--   * the kind on vault logins and on sign-ins, and the earliest time OpenAI allows the next renewal;
--   * two switches, both off: a platform setting (the operator turns it on in the database, like event
--     intake) and a per-company list (qorpera_set_chatgpt_plan_company, service role). A plan login is
--     begun, completed, handed to a run and renewed only while both allow its company, and only for a
--     company whose sign-ins go to the vault;
--   * one stable host id per member compute identity, sent with every sign-in of that identity;
--   * the member's begin (own member identity only: a plan login is never company-owned), the vault's
--     describe and complete for the new kind, and the address the sign-in callback forwards to;
--   * renewal timing for plan logins: a run renews a plan login past half its pass, as for Codex; idle
--     upkeep renews a plan login only once its tokens are 7 days old, to keep the refresh token alive,
--     never every half hour; neither renews before OpenAI's earliest renewal time.
--   * ending a plan login at OpenAI once everything that used it is revoked (the member disconnected or
--     left): the vault takes it under its renewal lock, revokes the refresh token, and marks the login
--     revoked. A disabled connection keeps its login: it can be turned back on. A deleted company's
--     logins are deleted with it and are not ended here (the delete's own queue must end them before
--     the platform switch goes on; see the activation guard in the PR);
--   * a pending plan sign-in never completes as a node Codex login (if its company goes back to node
--     sign-ins), and the node switch-off's account record is written for Codex logins only.
-- Plan logins are left out of the usage read (ChatGPT's usage page is not for plan tokens) and of the
-- account record the node switch-off reads. While both switches are off nothing here changes behaviour.
-- Locks: rows only (the sign-in row, the login row, a host row); no company-wide lock.

set local lock_timeout = '3s';

alter table public.qorpera_model_logins
	add column login_kind text not null default 'codex' check (login_kind in ('codex', 'chatgpt_plan')),
	add column renew_not_before timestamptz,
	add constraint qorpera_model_logins_renew_not_before_kind
		check (renew_not_before is null or login_kind = 'chatgpt_plan');

alter table public.qorpera_native_provider_login_sessions
	add column model_login_kind text not null default 'codex' check (model_login_kind in ('codex', 'chatgpt_plan'));

-- The platform switch: off until OpenAI approves Qorpera for ChatGPT plan use. The operator turns it on
-- with `update public.qorpera_chatgpt_plan_settings set enabled = true;`.
create table public.qorpera_chatgpt_plan_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false
);
insert into public.qorpera_chatgpt_plan_settings (singleton) values (true);

-- Companies allowed to use ChatGPT plan logins while the platform switch is on (our test company first).
create table public.qorpera_chatgpt_plan_companies (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	enabled_at timestamptz not null default statement_timestamp()
);

-- One stable host id per member compute identity: OpenAI takes it with each sign-in. Opaque, never a
-- credential, and never derived from the member.
create table public.qorpera_chatgpt_plan_hosts (
	compute_identity_id uuid primary key references public.qorpera_member_compute_identities(id) on delete cascade,
	host_id text not null unique
		check (host_id ~ '^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	created_at timestamptz not null default statement_timestamp()
);

alter table public.qorpera_chatgpt_plan_settings enable row level security;
alter table public.qorpera_chatgpt_plan_companies enable row level security;
alter table public.qorpera_chatgpt_plan_hosts enable row level security;
revoke all on public.qorpera_chatgpt_plan_settings, public.qorpera_chatgpt_plan_companies,
	public.qorpera_chatgpt_plan_hosts
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether a company may use ChatGPT plan logins now: the platform switch, the company's place on the
-- list, and a company whose sign-ins go to its vault.
create function public.qorpera_chatgpt_plan_allowed(p_profile_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce((select settings.enabled from public.qorpera_chatgpt_plan_settings as settings), false)
		and exists (select 1 from public.qorpera_chatgpt_plan_companies as company where company.profile_id = p_profile_id)
		and public.qorpera_model_login_sign_in_url(p_profile_id) is not null
$$;
revoke all on function public.qorpera_chatgpt_plan_allowed(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The web app shows "Continue with ChatGPT" to a member of a company that may use plan logins.
create function public.qorpera_chatgpt_plan_available(p_profile_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = auth.uid())
		and public.qorpera_chatgpt_plan_allowed(p_profile_id)
$$;
revoke all on function public.qorpera_chatgpt_plan_available(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_chatgpt_plan_available(uuid) to authenticated;

-- Puts a company on or off the list. A company joins only once its sign-ins go to its vault.
create function public.qorpera_set_chatgpt_plan_company(p_profile_id uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or p_profile_id is null or p_enabled is null then
		raise exception 'ChatGPT plan switch requires service authority' using errcode = '42501';
	end if;
	if p_enabled then
		if public.qorpera_model_login_sign_in_url(p_profile_id) is null then
			raise exception 'company sign-ins do not go to its vault' using errcode = '55000';
		end if;
		insert into public.qorpera_chatgpt_plan_companies(profile_id) values (p_profile_id)
		on conflict (profile_id) do nothing;
	else
		delete from public.qorpera_chatgpt_plan_companies where profile_id = p_profile_id;
	end if;
	return p_enabled;
end
$$;
revoke all on function public.qorpera_set_chatgpt_plan_company(uuid, boolean)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_set_chatgpt_plan_company(uuid, boolean) to service_role;

-- A member begins a ChatGPT plan sign-in for their own member identity: the ordinary begin (same checks,
-- same capability, same expiry), marked as a plan sign-in, and the identity's host id made once.
-- A repeat with the same ids answers the same sign-in; a Codex sign-in's ids are refused.
create function public.qorpera_begin_chatgpt_plan_sign_in(
	p_profile_id uuid,
	p_client_login_id uuid,
	p_client_connection_id uuid,
	p_compute_identity_id uuid,
	p_capability_sha256 text,
	p_login_seconds integer default 900
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_result jsonb;
	v_kind text;
begin
	if v_user_id is null or not exists (
		select 1 from public.qorpera_member_compute_identities as identity
		where identity.id = p_compute_identity_id and identity.profile_id = p_profile_id
			and identity.status = 'active' and identity.ownership_kind = 'member'
			and identity.owner_user_id = v_user_id
	) then
		raise exception 'ChatGPT plan sign-in is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_chatgpt_plan_allowed(p_profile_id) then
		raise exception 'ChatGPT plan sign-in is switched off' using errcode = '55000';
	end if;
	v_result := public.qorpera_begin_native_provider_login(p_profile_id, p_client_login_id, p_client_connection_id,
		p_compute_identity_id, 'openai', 'codex-cli', p_capability_sha256, p_login_seconds);
	-- Only the sign-in this statement created becomes a plan sign-in.
	update public.qorpera_native_provider_login_sessions set model_login_kind = 'chatgpt_plan'
	where id = (v_result ->> 'login_id')::uuid and model_login_kind = 'codex' and status = 'pending'
		and created_at = statement_timestamp();
	select session.model_login_kind into v_kind from public.qorpera_native_provider_login_sessions as session
	where session.id = (v_result ->> 'login_id')::uuid;
	if v_kind is distinct from 'chatgpt_plan' then
		raise exception 'native provider login id is already bound to other authority' using errcode = '23505';
	end if;
	insert into public.qorpera_chatgpt_plan_hosts(compute_identity_id, host_id)
	values (p_compute_identity_id, 'urn:uuid:' || extensions.gen_random_uuid()::text)
	on conflict (compute_identity_id) do nothing;
	return v_result || jsonb_build_object('model_login_kind', 'chatgpt_plan');
end
$$;
revoke all on function public.qorpera_begin_chatgpt_plan_sign_in(uuid, uuid, uuid, uuid, text, integer)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_chatgpt_plan_sign_in(uuid, uuid, uuid, uuid, text, integer)
	to authenticated;

-- Where OpenAI's callback goes: the callback (an Edge Function on a fixed address) names the company by
-- the state's prefix, `<company id>.<43 random characters>` (the id in lower case, as the vault writes
-- it from the database), and forwards the code to that company's
-- vault, which holds the rest of the sign-in. Null for anything else: a malformed state, a company that
-- may not use plan logins, or one with no pending plan sign-in.
create function public.qorpera_chatgpt_plan_callback_target(p_state text)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
	v_company uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'ChatGPT plan callback requires service authority' using errcode = '42501';
	end if;
	if coalesce(p_state, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$' then
		return null;
	end if;
	v_company := split_part(p_state, '.', 1)::uuid;
	if not public.qorpera_chatgpt_plan_allowed(v_company) or not exists (
		select 1 from public.qorpera_native_provider_login_sessions as session
		where session.profile_id = v_company and session.model_login_kind = 'chatgpt_plan'
			and session.status = 'pending' and session.expires_at > clock_timestamp()
	) then
		return null;
	end if;
	return public.qorpera_model_login_sign_in_url(v_company) || 'chatgpt-plan/callback';
end
$$;
revoke all on function public.qorpera_chatgpt_plan_callback_target(text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_chatgpt_plan_callback_target(text) to service_role;

-- Whether a login's renewal is due. A Codex login and a plan login used by a run: past half its pass.
-- A plan login nobody uses (idle upkeep): once its tokens are 7 days old, which keeps its 30-day
-- refresh token alive. A plan login never before OpenAI's earliest renewal time.
create function public.qorpera_model_login_renewal_due(
	p_login public.qorpera_model_logins,
	p_now timestamptz,
	p_idle boolean
)
returns boolean
language sql immutable set search_path = '' as $$
	select case when p_login.login_kind = 'chatgpt_plan' then
			(p_login.renew_not_before is null or p_now >= p_login.renew_not_before)
			and case when p_idle then p_now >= p_login.access_issued_at + interval '7 days'
				else p_now >= p_login.access_issued_at + (p_login.access_expires_at - p_login.access_issued_at) / 2 end
		else p_now >= p_login.access_issued_at + (p_login.access_expires_at - p_login.access_issued_at) / 2
	end
$$;
revoke all on function public.qorpera_model_login_renewal_due(public.qorpera_model_logins, timestamptz, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The run's issue (20260928160000) with the kind: the answer names it, a plan login is handed out only
-- while its company may use plan logins, and the renewal is due by the kind's rule.
create or replace function public.qorpera_issue_model_login(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_known_version bigint,
	p_allow_renewal boolean
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_login public.qorpera_model_logins%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_renewal uuid;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_allow_renewal is null or (p_known_version is not null and p_known_version < 1) then
		raise exception 'model login issue request is invalid' using errcode = '22023';
	end if;
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select login.* into v_login from public.qorpera_model_logins as login
	where login.credential_capsule_id = v_lease.credential_capsule_id;
	if v_login.id is null or v_login.broker_authority_id <> v_authority.id
		or v_login.profile_id <> v_authority.profile_id or v_login.compute_identity_id <> v_lease.compute_identity_id then
		raise exception 'model login is unavailable to this broker' using errcode = '42501';
	end if;
	if v_login.status <> 'active' then
		raise exception 'model login needs a new sign-in' using errcode = '55000';
	end if;
	if v_login.login_kind = 'chatgpt_plan' and not public.qorpera_chatgpt_plan_allowed(v_login.profile_id) then
		raise exception 'ChatGPT plan logins are switched off' using errcode = '55000';
	end if;
	if p_allow_renewal and public.qorpera_model_login_renewal_due(v_login, v_now, false) then
		update public.qorpera_model_logins
		set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '5 minutes',
			last_issued_at = v_now, updated_at = v_now
		where id = v_login.id and current_version = v_login.current_version and status = 'active'
			and (renewal_until is null or renewal_until < v_now)
			and (renewal_failed_at is null or renewal_failed_at <= v_now
				- least(interval '1 minute' * power(2, least(renewal_failures, 7) - 1), interval '1 hour'))
		returning renewal_token into v_renewal;
	end if;
	if v_renewal is null and (v_login.last_issued_at is null or v_login.last_issued_at < v_now - interval '1 minute') then
		update public.qorpera_model_logins set last_issued_at = v_now where id = v_login.id;
	end if;
	if v_renewal is null and p_known_version is not distinct from v_login.current_version then
		return jsonb_build_object(
			'schema', 'qorpera.model-login-issue/v1',
			'loginId', v_login.id,
			'loginKind', v_login.login_kind,
			'companyId', v_login.profile_id,
			'computeIdentityId', v_login.compute_identity_id,
			'version', v_login.current_version,
			'accessIssuedAt', v_login.access_issued_at,
			'accessExpiresAt', v_login.access_expires_at,
			'renewing', v_login.renewal_until is not null and v_login.renewal_until >= v_now,
			'unchanged', true
		);
	end if;
	select version.* into strict v_version from public.qorpera_model_login_versions as version
	where version.login_id = v_login.id and version.version = v_login.current_version;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-issue/v1',
		'loginId', v_login.id,
		'loginKind', v_login.login_kind,
		'companyId', v_login.profile_id,
		'computeIdentityId', v_login.compute_identity_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'accessIssuedAt', v_version.access_issued_at,
		'accessExpiresAt', v_version.access_expires_at,
		'renewing', v_renewal is null and v_login.renewal_until is not null and v_login.renewal_until >= v_now,
		'unchanged', false,
		'renewal', case when v_renewal is null then null else jsonb_build_object(
			'token', v_renewal, 'baseVersion', v_version.version, 'keyId', v_authority.key_id) end
	);
end
$$;

-- Saves a renewal of a login of one kind (the body of 20260928160000's commit). A plan renewal also
-- records OpenAI's earliest time for the next one. A renewal is saved even while plan logins are
-- switched off: OpenAI has already replaced the refresh token, and the old one no longer works.
create function public.qorpera_commit_model_login_renewal_kind(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_login_kind text,
	p_renew_not_before timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_envelope bytea;
	v_version bigint;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_renewal_token is null or p_base_version is null or p_base_version < 1
		or p_key_id is distinct from v_authority.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= v_now
		or p_access_issued_at > v_now + interval '5 minutes'
		or p_access_expires_at - p_access_issued_at > interval '400 days'
		or p_login_kind is null or p_login_kind not in ('codex', 'chatgpt_plan')
		or (p_renew_not_before is not null
			and (p_login_kind <> 'chatgpt_plan' or p_renew_not_before > v_now + interval '31 days')) then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	if exists (select 1 from public.qorpera_model_logins as login
		where login.id = p_login_id and login.broker_authority_id = v_authority.id and login.login_kind <> p_login_kind) then
		raise exception 'model login renewal is for another kind of login' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_model_logins as login
		join public.qorpera_model_login_versions as version
			on version.login_id = login.id and version.version = login.current_version
		where login.id = p_login_id and login.broker_authority_id = v_authority.id
			and login.current_version = p_base_version + 1 and version.envelope_sha256 = p_envelope_sha256
	) then
		return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id,
			'version', p_base_version + 1);
	end if;
	update public.qorpera_model_logins
	set current_version = p_base_version + 1, access_issued_at = p_access_issued_at,
		access_expires_at = p_access_expires_at, renew_not_before = p_renew_not_before,
		renewal_token = null, renewal_until = null,
		renewal_failures = 0, last_renewal_failure = null, renewal_failed_at = null, updated_at = v_now
	where id = p_login_id and broker_authority_id = v_authority.id and status = 'active'
		and login_kind = p_login_kind
		and current_version = p_base_version and renewal_token = p_renewal_token
		and access_expires_at < p_access_expires_at
	returning current_version into v_version;
	if v_version is null then
		if exists (select 1 from public.qorpera_model_logins where id = p_login_id and broker_authority_id = v_authority.id
			and status = 'active' and current_version = p_base_version and renewal_token = p_renewal_token) then
			raise exception 'model login renewal is not a later pass' using errcode = '22023';
		end if;
		raise exception 'model login renewal lock is not held' using errcode = '55000';
	end if;
	insert into public.qorpera_model_login_versions(
		login_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, origin,
		access_issued_at, access_expires_at)
	values (p_login_id, v_version, v_authority.id, p_key_id, v_envelope, p_envelope_sha256, 'renewal',
		p_access_issued_at, p_access_expires_at);
	return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id, 'version', v_version);
end
$$;
revoke all on function public.qorpera_commit_model_login_renewal_kind(
	uuid, text, uuid, uuid, bigint, text, text, text, timestamptz, timestamptz, text, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The Codex commit keeps its signature and answers.
create or replace function public.qorpera_commit_model_login_renewal(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz
)
returns jsonb
language sql security definer set search_path = '' as $$
	select public.qorpera_commit_model_login_renewal_kind(p_broker_authority_id, p_broker_capability_sha256,
		p_login_id, p_renewal_token, p_base_version, p_key_id, p_encrypted_envelope_base64, p_envelope_sha256,
		p_access_issued_at, p_access_expires_at, 'codex', null)
$$;

create function public.qorpera_commit_chatgpt_plan_renewal(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_renew_not_before timestamptz
)
returns jsonb
language sql security definer set search_path = '' as $$
	select public.qorpera_commit_model_login_renewal_kind(p_broker_authority_id, p_broker_capability_sha256,
		p_login_id, p_renewal_token, p_base_version, p_key_id, p_encrypted_envelope_base64, p_envelope_sha256,
		p_access_issued_at, p_access_expires_at, 'chatgpt_plan', p_renew_not_before)
$$;
revoke all on function public.qorpera_commit_chatgpt_plan_renewal(
	uuid, text, uuid, uuid, bigint, text, text, text, timestamptz, timestamptz, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_commit_chatgpt_plan_renewal(
	uuid, text, uuid, uuid, bigint, text, text, text, timestamptz, timestamptz, timestamptz)
	to qorpera_secret_broker;

-- Idle upkeep (20260928236000) by the kind's idle rule; a plan login is renewed only while its company
-- may use plan logins.
create or replace function public.qorpera_model_login_take_idle_lock(p_login_id uuid, p_broker_authority_id uuid)
returns uuid
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_token uuid;
	v_now timestamptz := clock_timestamp();
begin
	update public.qorpera_model_logins as login
	set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '5 minutes',
		updated_at = v_now
	where login.id = p_login_id and login.broker_authority_id = p_broker_authority_id and login.status = 'active'
		and public.qorpera_model_login_renewal_due(login, v_now, true)
		and (login.login_kind = 'codex' or public.qorpera_chatgpt_plan_allowed(login.profile_id))
		and (login.renewal_until is null or login.renewal_until < v_now)
		and (login.renewal_failed_at is null or login.renewal_failed_at <= v_now
			- least(interval '1 minute' * power(2, least(login.renewal_failures, 7) - 1), interval '1 hour'))
	returning login.renewal_token into v_token;
	return v_token;
end
$$;

create or replace function public.qorpera_take_idle_model_login_renewal(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_candidate uuid;
	v_token uuid;
	v_login public.qorpera_model_logins%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	for v_candidate in
		select login.id from public.qorpera_model_logins as login
		join public.qorpera_native_credential_capsules as capsule on capsule.id = login.credential_capsule_id
		where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
			and login.status = 'active'
			and public.qorpera_model_login_renewal_due(login, v_now, true)
			and (login.login_kind = 'codex' or public.qorpera_chatgpt_plan_allowed(login.profile_id))
			and (login.renewal_until is null or login.renewal_until < v_now)
			and (login.renewal_failed_at is null or login.renewal_failed_at <= v_now
				- least(interval '1 minute' * power(2, least(login.renewal_failures, 7) - 1), interval '1 hour'))
			and capsule.status = 'active'
			and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
			and exists (
				select 1 from public.qorpera_provider_connection_versions as version
				join public.qorpera_provider_connections as connection on connection.id = version.connection_id
				where version.credential_capsule_id = capsule.id and version.authorization_state = 'active'
					and connection.status = 'active' and connection.profile_id = login.profile_id
			)
		order by login.access_expires_at, login.id
		limit 4
	loop
		-- The lock's own conditions again, on the row itself: a run may have taken it meanwhile.
		v_token := public.qorpera_model_login_take_idle_lock(v_candidate, v_authority.id);
		exit when v_token is not null;
	end loop;
	if v_token is null then
		return jsonb_build_object('schema', 'qorpera.model-login-idle-renewal/v1', 'renewal', null);
	end if;
	select login.* into strict v_login from public.qorpera_model_logins as login where login.id = v_candidate;
	select version.* into strict v_version from public.qorpera_model_login_versions as version
	where version.login_id = v_login.id and version.version = v_login.current_version;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-idle-renewal/v1',
		'loginId', v_login.id,
		'loginKind', v_login.login_kind,
		'companyId', v_login.profile_id,
		'computeIdentityId', v_login.compute_identity_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'accessIssuedAt', v_version.access_issued_at,
		'accessExpiresAt', v_version.access_expires_at,
		'renewal', jsonb_build_object('token', v_token, 'baseVersion', v_version.version,
			'keyId', v_authority.key_id)
	);
end
$$;

-- The vault's read of a pending sign-in (20260928184000). Its answer keeps exactly its keys (the vault
-- in service parses them strictly) and it reads Codex sign-ins only, so a vault without plan logins
-- never starts a Codex sign-in for a plan sign-in. A vault that knows plan logins reads both kinds
-- with the v2 read below.
create or replace function public.qorpera_describe_model_login_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_description jsonb;
begin
	v_description := public.qorpera_describe_model_login_sign_in_v2(p_broker_authority_id, p_broker_capability_sha256,
		p_login_id, p_capability_sha256);
	if v_description ->> 'loginKind' <> 'codex' then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	return (v_description - 'loginKind' - 'hostId') || jsonb_build_object('schema', 'qorpera.model-login-sign-in/v1');
end
$$;

-- The read of a pending sign-in of either kind: the v1 answer with the kind and, for a plan sign-in,
-- the identity's host id. A plan sign-in is readable only while its company may use plan logins.
create function public.qorpera_describe_model_login_sign_in_v2(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login sign-in request is invalid' using errcode = '22023';
	end if;
	select session.* into v_session from public.qorpera_native_provider_login_sessions as session
	where session.id = p_login_id;
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id
		or v_session.provider <> 'openai' or v_session.native_harness <> 'codex-cli'
		or public.qorpera_model_login_sign_in_url(v_session.profile_id) is null
		or (v_session.model_login_kind = 'chatgpt_plan'
			and not public.qorpera_chatgpt_plan_allowed(v_session.profile_id)) then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	select identity.* into strict v_identity from public.qorpera_member_compute_identities as identity
	where identity.id = v_session.compute_identity_id;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-sign-in/v2',
		'loginId', v_session.id,
		'loginKind', v_session.model_login_kind,
		'profileId', v_session.profile_id,
		'computeIdentityId', v_session.compute_identity_id,
		'computeIdentityOwnershipKind', v_identity.ownership_kind,
		'computeIdentityOwnerUserId', v_identity.owner_user_id,
		'computeIdentityOwnerScopeKey', v_identity.owner_scope_key,
		'clientConnectionId', v_session.client_connection_id,
		'hostId', case when v_session.model_login_kind = 'chatgpt_plan' then (select host.host_id
			from public.qorpera_chatgpt_plan_hosts as host where host.compute_identity_id = v_session.compute_identity_id)
			end,
		'status', case when v_session.status = 'pending' and v_session.expires_at <= clock_timestamp()
			then 'expired' else v_session.status end,
		'expiresAt', v_session.expires_at,
		'keyId', v_authority.key_id,
		'modelLoginId', (select vault.id from public.qorpera_model_logins as vault
			where vault.sign_in_session_id = v_session.id)
	);
end
$$;
revoke all on function public.qorpera_describe_model_login_sign_in_v2(uuid, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_describe_model_login_sign_in_v2(uuid, text, uuid, text)
	to qorpera_secret_broker;

-- Completes a sign-in of one kind (the body of 20260928184000's complete). The sign-in's kind must be
-- the caller's; a plan sign-in completes only for a member identity while its company may use plan
-- logins, and records OpenAI's earliest renewal time and the plan's consent version.
create function public.qorpera_complete_model_login_sign_in_kind(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text,
	p_model_login_id uuid,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_provider_account_reference text,
	p_provider_account_email text,
	p_login_kind text,
	p_renew_not_before timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_existing public.qorpera_model_logins%rowtype;
	v_capsule_id uuid := extensions.gen_random_uuid();
	v_envelope bytea;
	v_version bigint;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_model_login_id is null
		or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_key_id is distinct from v_authority.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= clock_timestamp()
		or (p_provider_account_reference is not null
			and char_length(btrim(p_provider_account_reference)) not between 1 and 512)
		or (p_provider_account_email is not null
			and char_length(btrim(p_provider_account_email)) not between 3 and 254)
		or p_login_kind is null or p_login_kind not in ('codex', 'chatgpt_plan')
		or (p_renew_not_before is not null
			and (p_login_kind <> 'chatgpt_plan' or p_renew_not_before > clock_timestamp() + interval '31 days')) then
		raise exception 'model login sign-in completion is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'model login sign-in completion is invalid' using errcode = '22023';
	end if;
	select session.* into v_session from public.qorpera_native_provider_login_sessions as session
	where session.id = p_login_id
	for update;
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id
		or v_session.provider <> 'openai' or v_session.native_harness <> 'codex-cli'
		or v_session.model_login_kind <> p_login_kind then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	-- A repeat of a completion whose answer was lost.
	select vault.* into v_existing from public.qorpera_model_logins as vault
	where vault.sign_in_session_id = v_session.id;
	if v_existing.id is not null then
		if v_existing.id <> p_model_login_id or not exists (
			select 1 from public.qorpera_model_login_versions as version
			where version.login_id = v_existing.id and version.version = 1
				and version.envelope_sha256 = p_envelope_sha256) then
			raise exception 'model login sign-in is already complete' using errcode = '55000';
		end if;
		return (
			select jsonb_build_object('schema', 'qorpera.model-login-sign-in-complete/v1',
				'loginId', v_session.id, 'modelLoginId', v_existing.id,
				'credentialCapsuleId', v_existing.credential_capsule_id,
				'connectionId', version.connection_id, 'connectionVersion', version.version)
			from public.qorpera_provider_connection_versions as version
			where version.credential_capsule_id = v_existing.credential_capsule_id
			order by version.version desc limit 1
		);
	end if;
	if v_session.status <> 'pending' or v_session.expires_at <= statement_timestamp()
		or public.qorpera_model_login_sign_in_url(v_session.profile_id) is null
		or (p_login_kind = 'chatgpt_plan' and not public.qorpera_chatgpt_plan_allowed(v_session.profile_id)) then
		raise exception 'model login sign-in is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_session.compute_identity_id and identity.profile_id = v_session.profile_id
		and identity.status = 'active';
	if p_login_kind = 'chatgpt_plan' and (v_identity.ownership_kind <> 'member'
		or v_identity.owner_user_id is distinct from v_session.requested_by_user_id) then
		raise exception 'a ChatGPT plan login belongs to one member' using errcode = '42501';
	end if;
	select policy.* into v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_session.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_session.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled'
	for share;
	if not found then
		raise exception 'native provider policy does not authorize this connection' using errcode = '42501';
	end if;
	-- The pointer capsule: the connection version, the lease and the run's host reach the vault
	-- login through it. Its attestation names the vault, not a node host.
	insert into public.qorpera_native_credential_capsules (
		id, profile_id, compute_identity_id, ownership_kind, owner_user_id, owner_scope_key,
		provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
	) values (
		v_capsule_id, v_session.profile_id, v_session.compute_identity_id,
		v_identity.ownership_kind, v_identity.owner_user_id, v_identity.owner_scope_key,
		v_session.provider, v_session.native_harness, 'model-login/' || p_model_login_id::text,
		encode(extensions.digest('qorpera.model-login-vault/v1', 'sha256'), 'hex'), v_session.requested_by_user_id
	);
	insert into public.qorpera_model_logins (
		id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
		native_harness, current_version, access_issued_at, access_expires_at, sign_in_session_id,
		login_kind, renew_not_before
	) values (
		p_model_login_id, v_session.profile_id, v_session.compute_identity_id, v_capsule_id, v_authority.id,
		v_session.provider, v_session.native_harness, 1, p_access_issued_at, p_access_expires_at, v_session.id,
		p_login_kind, p_renew_not_before
	);
	insert into public.qorpera_model_login_versions (
		login_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, origin,
		access_issued_at, access_expires_at
	) values (
		p_model_login_id, 1, v_authority.id, p_key_id, v_envelope, p_envelope_sha256, 'sign_in',
		p_access_issued_at, p_access_expires_at
	);
	-- The connection and its new version, exactly as a node sign-in records them.
	insert into public.qorpera_provider_connections (
		profile_id, client_connection_id, owner_user_id, provider, created_by_user_id
	) values (
		v_session.profile_id, v_session.client_connection_id, v_identity.owner_user_id,
		v_session.provider, v_session.requested_by_user_id
	)
	on conflict (profile_id, client_connection_id) do update set
		status = case
			when public.qorpera_provider_connections.owner_user_id is not distinct from excluded.owner_user_id
				and public.qorpera_provider_connections.provider = excluded.provider
			then 'active'
			else public.qorpera_provider_connections.status
		end
	returning * into v_connection;
	if v_connection.owner_user_id is distinct from v_identity.owner_user_id
		or v_connection.provider <> v_session.provider then
		raise exception 'provider connection identity is already bound' using errcode = '23505';
	end if;
	select coalesce(max(version), 0) + 1 into v_version
	from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id;
	insert into public.qorpera_provider_connection_versions (
		connection_id, version, authentication_mode, native_harness, secret_reference,
		provider_account_reference, provider_account_email, billing_source, consent_version, consented_by_user_id,
		allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency
	) values (
		v_connection.id, v_version, 'native_subscription', v_session.native_harness, null,
		nullif(btrim(p_provider_account_reference), ''), nullif(btrim(p_provider_account_email), ''),
		'personal_subscription',
		case when p_login_kind = 'chatgpt_plan' then 'qorpera-chatgpt-plan-v1' else 'qorpera-native-subscription-v1' end,
		v_session.requested_by_user_id, false,
		v_policy.commercial_reference,
		jsonb_build_object('monthly_microusd', 1, 'reservation_microusd', 1, 'max_calls_per_run', 128,
			'max_input_tokens_per_run', 100000000, 'max_output_tokens_per_run', 100000000,
			'max_concurrent_runs', v_policy.max_native_concurrency),
		v_session.requested_by_user_id, v_capsule_id, 'active', v_policy.max_native_concurrency
	);
	-- The recovery pin still fences a recovering identity; it finds this vault login and asks
	-- for no node key backup.
	update public.qorpera_native_provider_login_sessions
	set status = 'completed', completed_at = statement_timestamp()
	where id = v_session.id;
	return jsonb_build_object('schema', 'qorpera.model-login-sign-in-complete/v1',
		'loginId', v_session.id, 'modelLoginId', p_model_login_id, 'credentialCapsuleId', v_capsule_id,
		'connectionId', v_connection.id, 'connectionVersion', v_version);
end
$$;
revoke all on function public.qorpera_complete_model_login_sign_in_kind(
	uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text, text, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The Codex completion keeps its signature and answers.
create or replace function public.qorpera_complete_model_login_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text,
	p_model_login_id uuid,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_provider_account_reference text,
	p_provider_account_email text
)
returns jsonb
language sql security definer set search_path = '' as $$
	select public.qorpera_complete_model_login_sign_in_kind(p_broker_authority_id, p_broker_capability_sha256,
		p_login_id, p_capability_sha256, p_model_login_id, p_key_id, p_encrypted_envelope_base64, p_envelope_sha256,
		p_access_issued_at, p_access_expires_at, p_provider_account_reference, p_provider_account_email, 'codex', null)
$$;

create function public.qorpera_complete_chatgpt_plan_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text,
	p_model_login_id uuid,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_provider_account_reference text,
	p_provider_account_email text,
	p_renew_not_before timestamptz
)
returns jsonb
language sql security definer set search_path = '' as $$
	select public.qorpera_complete_model_login_sign_in_kind(p_broker_authority_id, p_broker_capability_sha256,
		p_login_id, p_capability_sha256, p_model_login_id, p_key_id, p_encrypted_envelope_base64, p_envelope_sha256,
		p_access_issued_at, p_access_expires_at, p_provider_account_reference, p_provider_account_email,
		'chatgpt_plan', p_renew_not_before)
$$;
revoke all on function public.qorpera_complete_chatgpt_plan_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_chatgpt_plan_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text, timestamptz)
	to qorpera_secret_broker;

-- The usage read (20260928185000) and the account record the node switch-off reads (20260928243500)
-- read Codex logins only: ChatGPT's usage page is not for plan tokens, and a plan login names its
-- member by OpenAI's subject, not by the ChatGPT account a node login records.
do $$
declare
	v_target regprocedure;
	v_definition text;
	v_count integer;
	v_anchor text;
begin
	v_target := 'public.qorpera_describe_model_login_account_refresh(uuid,text,uuid,text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('login_kind' in v_definition) = 0 then
		v_anchor := E'\t\t\t\tand vault.status = ''active''\n';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Vault account refresh source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor, v_anchor || E'\t\t\t\tand vault.login_kind = ''codex''\n');
	end if;

	-- The account record itself: a Codex login's only.
	v_target := 'public.qorpera_record_model_login_account(uuid,text,uuid,text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('login_kind' in v_definition) = 0 then
		v_anchor := 'where id = p_login_id and broker_authority_id = v_authority.id and account_identity is null;';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Vault account record source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			'where id = p_login_id and broker_authority_id = v_authority.id and account_identity is null'
				|| ' and login_kind = ''codex'';');
	end if;

	-- A node completes Codex sign-ins only: a plan sign-in whose company went back to node sign-ins is
	-- never sealed as a node Codex login. Every other sign-in, Claude's included, carries the column's
	-- default 'codex' and completes as before; a different default for them would block them here.
	v_target := 'public.qorpera_complete_native_provider_login(uuid,text,uuid,text,text,text,text,text,jsonb,text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('model_login_kind' in v_definition) = 0 then
		v_anchor := E'\t\tor v_login.status <> ''pending'' or v_login.expires_at <= statement_timestamp() then\n'
			|| E'\t\traise exception ''native provider login is unavailable''';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Node sign-in completion source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			E'\t\tor v_login.status <> ''pending'' or v_login.expires_at <= statement_timestamp()\n'
				|| E'\t\tor v_login.model_login_kind <> ''codex'' then\n'
				|| E'\t\traise exception ''native provider login is unavailable''');
	end if;

	v_target := 'public.qorpera_model_logins_without_account(uuid,text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('login_kind' in v_definition) = 0 then
		v_anchor := 'and login.status = ''active'' and login.account_identity is null';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Vault account list source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor, v_anchor || ' and login.login_kind = ''codex''');
	end if;
end
$$;

-- Ending a plan login at OpenAI. OpenAI asks an app to end the renewable session when a member signs
-- out, and is not told when a member disconnects in Qorpera. So each pass the vault takes one plan login
-- that nothing can use again: its pointer capsule, every connection version that points at it, or those
-- versions' connections are revoked (the member disconnected or left). A disabled capsule, version or
-- connection keeps the login, since an owner can turn it back on. A deleted company's logins are deleted
-- with it and never reach this pass. The vault asks OpenAI to end the login and marks it revoked. It holds
-- the login's renewal lock meanwhile, so no renewal races the revocation; a login another renewal holds
-- waits for the next pass, and a revocation that failed waits until its lock lapses (5 minutes).
-- Revocation runs whatever the switches say: it only ends a member's session.
create function public.qorpera_take_chatgpt_plan_revocation(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_candidate uuid;
	v_token uuid;
	v_login public.qorpera_model_logins%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	for v_candidate in
		select login.id from public.qorpera_model_logins as login
		where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
			and login.login_kind = 'chatgpt_plan' and login.status in ('active', 'needs_sign_in')
			and (login.renewal_until is null or login.renewal_until < v_now)
			and not exists (
				select 1 from public.qorpera_native_credential_capsules as capsule
				join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
				join public.qorpera_provider_connections as connection on connection.id = version.connection_id
				where capsule.id = login.credential_capsule_id and capsule.status <> 'revoked'
					and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
					and version.authorization_state <> 'revoked'
					and connection.status <> 'revoked' and connection.profile_id = login.profile_id
			)
		order by login.updated_at, login.id
		limit 4
	loop
		update public.qorpera_model_logins as login
		set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '5 minutes', updated_at = v_now
		where login.id = v_candidate and login.status in ('active', 'needs_sign_in')
			and (login.renewal_until is null or login.renewal_until < v_now)
		returning login.renewal_token into v_token;
		exit when v_token is not null;
	end loop;
	if v_token is null then
		return jsonb_build_object('schema', 'qorpera.chatgpt-plan-revocation/v1', 'revocation', null);
	end if;
	select login.* into strict v_login from public.qorpera_model_logins as login where login.id = v_candidate;
	select version.* into strict v_version from public.qorpera_model_login_versions as version
	where version.login_id = v_login.id and version.version = v_login.current_version;
	return jsonb_build_object(
		'schema', 'qorpera.chatgpt-plan-revocation/v1',
		'loginId', v_login.id,
		'companyId', v_login.profile_id,
		'computeIdentityId', v_login.compute_identity_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'revocation', jsonb_build_object('token', v_token, 'baseVersion', v_version.version)
	);
end
$$;

-- Marks a plan login revoked once OpenAI ended it (or answered that its refresh token no longer works).
-- Only the holder of the lock the revocation took, on the version it read.
create function public.qorpera_finish_chatgpt_plan_revocation(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_revocation_token uuid,
	p_base_version bigint
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_status text;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_revocation_token is null or p_base_version is null or p_base_version < 1 then
		raise exception 'ChatGPT plan revocation is invalid' using errcode = '22023';
	end if;
	update public.qorpera_model_logins
	set status = 'revoked', renewal_token = null, renewal_until = null, updated_at = clock_timestamp()
	where id = p_login_id and broker_authority_id = v_authority.id and login_kind = 'chatgpt_plan'
		and current_version = p_base_version and renewal_token = p_revocation_token
	returning status into v_status;
	if v_status is null and not exists (select 1 from public.qorpera_model_logins
		where id = p_login_id and broker_authority_id = v_authority.id and status = 'revoked') then
		raise exception 'ChatGPT plan revocation lock is not held' using errcode = '55000';
	end if;
	return jsonb_build_object('schema', 'qorpera.chatgpt-plan-revocation-finished/v1', 'loginId', p_login_id,
		'status', 'revoked');
end
$$;

revoke all on function public.qorpera_take_chatgpt_plan_revocation(uuid, text),
	public.qorpera_finish_chatgpt_plan_revocation(uuid, text, uuid, uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_take_chatgpt_plan_revocation(uuid, text),
	public.qorpera_finish_chatgpt_plan_revocation(uuid, text, uuid, uuid, bigint)
	to qorpera_secret_broker;
