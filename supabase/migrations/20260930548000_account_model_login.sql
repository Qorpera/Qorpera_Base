-- Account-level model logins (founder, 3 Nov 2026): "the connections with the intelligence should be user-owned and
-- not company owned, meaning I shouldn't have to sign in my subscription across every single company, but just to my
-- top level account."
--
-- A member's Codex login is kept ONCE in the shared vault (an "account login": owner_user_id and principal_id set, no
-- company columns), sealed under a key derived for the member (qorpera.member-kek/v1, separate from company keys).
-- In every company the member belongs to that the same shared vault serves, ordinary company rows point at it: the
-- member's compute identity, a pointer capsule 'model-login/<login id>', a provider connection and its version, and a
-- member sponsor binding. A link row (qorpera_model_login_links) ties that company's capsule to the account login and
-- is deleted with the company. So every run-time check (leases, sponsors, payers, pauses, recovery epochs, the
-- founding table) stays company-local and unchanged; only the vault lookup crosses companies.
--
-- * The switch (qorpera_account_model_login_settings, off): while off nothing here changes behaviour. A sign-in stays
--   a company login, no link is made, and the vault hands no account login to a run.
-- * Sign-in: a Codex sign-in that a member begins for their own identity in a company served by the shared vault is an
--   account sign-in (decided when it begins). The vault seals it under the member's key and completes it with
--   qorpera_complete_account_model_login_sign_in, which links it into every company of the member that the same vault
--   serves. A company completion of an account sign-in is refused, and the v2 read names the scope, so a vault build
--   without this change refuses such a sign-in instead of sealing it as a company login.
-- * Links are made when a sign-in completes, when a member joins a company, and when a company starts taking sign-ins
--   in the shared vault (the vault registers it), and only in a company that takes sign-ins in the vault. A company
--   whose link capsule the member disconnected keeps it disconnected ("stop using it here"): a capsule for that login is
--   never made there again. Codex logins work while the member is away by default (founder decision 2026-09-20), as
--   the web client's own default consent does today.
-- * Runs: qorpera_issue_model_login resolves a run's capsule through its link when no company login holds it. The
--   link, the login, the run's identity, capsule and connection, and the run's payer must all be the same member, the
--   run's company must be the link's and the broker's, and that company must be served by the login's shared vault.
-- * Renewal: one renewal lock on the one login row, whichever company's run or the vault's idle pass takes it, so one
--   refresh chain (OpenAI rotates refresh tokens). Account commits, releases and the idle pass are the shared vault's
--   own calls (its principal), never a company broker's.
-- * Usage: a usage-limit signal on any company's link connection blocks new work on every link of the same login, and
--   the tightest fresh usage reading (5 minutes) of any of its companies counts for all.
-- * Switch-off: the vault's pass retires the member's older logins of the same ChatGPT account in each company the
--   account login is linked into (node logins, company vault logins, an older account login) after moving their pins.
-- * Sign out everywhere: the member ends the account login; every company's link is revoked as Disconnect does.
-- * Out of scope: ChatGPT plan logins stay company logins (they are switched off platform-wide and their rules key on
--   the company capsule), and companies with a vault of their own keep company logins.
--
-- Locks: rows only. The membership and registration links insert new rows for that one member; a failed link never
-- blocks the membership or the registration (it is logged as a warning).

set local lock_timeout = '3s';

-- 1. The switch -------------------------------------------------------------------------------------------------------

create table public.qorpera_account_model_login_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false
);
insert into public.qorpera_account_model_login_settings (singleton) values (true);
alter table public.qorpera_account_model_login_settings enable row level security;
revoke all on public.qorpera_account_model_login_settings
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_account_model_logins_enabled()
returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce((select settings.enabled from public.qorpera_account_model_login_settings as settings), false)
$$;
revoke all on function public.qorpera_account_model_logins_enabled()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The shared vault (principal) that serves a company, or null for a company with a vault of its own or none.
create function public.qorpera_company_account_vault(p_profile_id uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
	select authority.principal_id
	from public.qorpera_cloud_secret_broker_authorities as authority
	join public.qorpera_cloud_secret_broker_principals as principal on principal.id = authority.principal_id
	where authority.profile_id = p_profile_id and authority.status = 'active' and principal.status = 'active'
	order by authority.created_at desc, authority.id
	limit 1
$$;
revoke all on function public.qorpera_company_account_vault(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Account logins and links -----------------------------------------------------------------------------------------

alter table public.qorpera_model_logins
	alter column profile_id drop not null,
	alter column compute_identity_id drop not null,
	alter column credential_capsule_id drop not null,
	alter column broker_authority_id drop not null,
	add column owner_user_id uuid references auth.users(id) on delete restrict,
	add column principal_id uuid references public.qorpera_cloud_secret_broker_principals(id) on delete restrict,
	add column provider_account_reference text check (provider_account_reference is null
		or (char_length(btrim(provider_account_reference)) between 1 and 512 and provider_account_reference !~ E'[\r\n]')),
	add column provider_account_email text check (provider_account_email is null
		or (char_length(btrim(provider_account_email)) between 3 and 254 and provider_account_email !~ E'[\r\n]'));
-- A company login names its company rows; an account login names its member and its shared vault and no company row,
-- so deleting a company never reaches it. Account logins are Codex logins only.
alter table public.qorpera_model_logins add constraint qorpera_model_logins_company_or_account check (
	(owner_user_id is null and principal_id is null and profile_id is not null and compute_identity_id is not null
		and credential_capsule_id is not null and broker_authority_id is not null
		and provider_account_reference is null and provider_account_email is null)
	or (owner_user_id is not null and principal_id is not null and profile_id is null and compute_identity_id is null
		and credential_capsule_id is null and broker_authority_id is null and login_kind = 'codex')
);
create index qorpera_model_logins_owner on public.qorpera_model_logins(owner_user_id) where owner_user_id is not null;
create index qorpera_model_logins_principal_due on public.qorpera_model_logins(principal_id, access_expires_at)
	where principal_id is not null and status = 'active';

alter table public.qorpera_model_login_versions
	alter column broker_authority_id drop not null,
	add column principal_id uuid references public.qorpera_cloud_secret_broker_principals(id) on delete restrict;
alter table public.qorpera_model_login_versions add constraint qorpera_model_login_versions_company_or_account
	check ((broker_authority_id is null) <> (principal_id is null));

-- One company's pointer capsule to an account login. Deleted with the company (its capsule, identity or row).
create table public.qorpera_model_login_links (
	credential_capsule_id uuid primary key references public.qorpera_native_credential_capsules(id) on delete cascade,
	login_id uuid not null references public.qorpera_model_logins(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete cascade,
	owner_user_id uuid not null,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, login_id)
);
create index qorpera_model_login_links_login on public.qorpera_model_login_links(login_id);
create index qorpera_model_login_links_identity on public.qorpera_model_login_links(compute_identity_id);
alter table public.qorpera_model_login_links enable row level security;
revoke all on public.qorpera_model_login_links from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The scope of a sign-in, decided when it begins: an account sign-in is a Codex sign-in a member begins for their own
-- identity in a company served by the shared vault, while the switch is on. It never changes afterwards, and a sign-in
-- that becomes a ChatGPT plan sign-in is a company sign-in.
alter table public.qorpera_native_provider_login_sessions
	add column model_login_scope text not null default 'company' check (model_login_scope in ('company', 'account'));
alter table public.qorpera_native_provider_login_sessions add constraint qorpera_login_sessions_account_scope_codex
	check (model_login_scope = 'company' or model_login_kind = 'codex');

create function public.qorpera_model_login_session_scope()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'INSERT' then
		new.model_login_scope := case when new.provider = 'openai' and new.native_harness = 'codex-cli'
				and new.model_login_kind = 'codex'
				and public.qorpera_account_model_logins_enabled()
				and public.qorpera_company_account_vault(new.profile_id) is not null
				and public.qorpera_model_login_sign_in_url(new.profile_id) is not null
				and exists (select 1 from public.qorpera_member_compute_identities as identity
					where identity.id = new.compute_identity_id and identity.profile_id = new.profile_id
						and identity.status = 'active' and identity.ownership_kind = 'member'
						and identity.owner_user_id = new.requested_by_user_id)
			then 'account' else 'company' end;
	elsif new.model_login_kind is distinct from 'codex' then
		new.model_login_scope := 'company';
	else
		new.model_login_scope := old.model_login_scope;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_model_login_session_scope() from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_model_login_session_scope
	before insert or update on public.qorpera_native_provider_login_sessions
	for each row execute function public.qorpera_model_login_session_scope();

-- An account sign-in never completes as a company vault login (a vault build without this change). A node completion
-- makes no vault login: a sign-in whose company went back to node sign-ins meanwhile ends as a node login, as on master.
create function public.qorpera_model_login_company_sign_in_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if new.owner_user_id is null and new.sign_in_session_id is not null and exists (
		select 1 from public.qorpera_native_provider_login_sessions as session
		where session.id = new.sign_in_session_id and session.model_login_scope = 'account') then
		raise exception 'an account sign-in completes as an account login' using errcode = '42501';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_model_login_company_sign_in_guard()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_model_login_company_sign_in_guard
	before insert on public.qorpera_model_logins
	for each row execute function public.qorpera_model_login_company_sign_in_guard();

-- 3. Linking ------------------------------------------------------------------------------------------------------------

-- Makes the company rows that point at the member's account logins of the company's shared vault: the member's
-- compute identity (when they have none yet), the pointer capsule, the link, the connection and its consented version,
-- and a member sponsor binding. Only in a company that takes sign-ins in the vault (an operator who switched it back to
-- node sign-ins gets no new links there). A company where a capsule for the login exists already, in any state, is
-- left as it is (linked already, or the member stopped using the login there). A retired identity (the member left
-- once) is not revived. Each login row is key-share locked while it is linked, so Sign out everywhere (which locks it
-- for update) either waits and then revokes the new link, or comes first and the login is no longer active here.
-- p_client_connection_id names the connection (the sign-in's own, so the web sees its sign-in finish); p_login_id
-- limits the pass to one login. Returns how many links it made. Internal: no API role may call it.
create function public.qorpera_link_member_model_logins(
	p_profile_id uuid,
	p_user_id uuid,
	p_client_connection_id uuid default null,
	p_login_id uuid default null
)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
	v_principal uuid;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_login public.qorpera_model_logins%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule_id uuid;
	v_connection_id uuid;
	v_binding_id uuid;
	v_linked integer := 0;
begin
	if p_profile_id is null or p_user_id is null or not public.qorpera_account_model_logins_enabled() then
		return 0;
	end if;
	v_principal := public.qorpera_company_account_vault(p_profile_id);
	if v_principal is null or public.qorpera_model_login_sign_in_url(p_profile_id) is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id) then
		return 0;
	end if;
	select policy.* into v_policy from public.qorpera_provider_execution_policies as policy
	where policy.provider = 'openai' and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = 'codex-cli' and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled';
	if not found then
		return 0;
	end if;
	for v_login in
		select login.* from public.qorpera_model_logins as login
		where login.owner_user_id = p_user_id and login.principal_id = v_principal and login.status = 'active'
			and login.login_kind = 'codex' and (p_login_id is null or login.id = p_login_id)
			and not exists (select 1 from public.qorpera_native_credential_capsules as capsule
				where capsule.profile_id = p_profile_id
					and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text)
		order by login.created_at, login.id
		for key share of login
	loop
		select identity.* into v_identity from public.qorpera_member_compute_identities as identity
		where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
			and identity.owner_user_id = p_user_id;
		if v_identity.id is null then
			insert into public.qorpera_member_compute_identities (
				profile_id, ownership_kind, owner_user_id, client_identity_id, display_name, policy
			) values (
				p_profile_id, 'member', p_user_id, extensions.gen_random_uuid(), 'My model account',
				'{"credentialExport":false,"operatorBlindnessClaimed":false}'::jsonb
			)
			on conflict (profile_id, owner_user_id) where ownership_kind = 'member' do nothing;
			select identity.* into v_identity from public.qorpera_member_compute_identities as identity
			where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
				and identity.owner_user_id = p_user_id;
		end if;
		continue when v_identity.id is null or v_identity.status <> 'active';
		v_capsule_id := extensions.gen_random_uuid();
		insert into public.qorpera_native_credential_capsules (
			id, profile_id, compute_identity_id, ownership_kind, owner_user_id, owner_scope_key,
			provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
		) values (
			v_capsule_id, p_profile_id, v_identity.id, 'member', p_user_id, null, 'openai', 'codex-cli',
			'model-login/' || v_login.id::text, encode(extensions.digest('qorpera.model-login-vault/v1', 'sha256'), 'hex'),
			p_user_id
		)
		on conflict (profile_id, encrypted_capsule_reference) do nothing;
		continue when not found;
		insert into public.qorpera_model_login_links (credential_capsule_id, login_id, profile_id, compute_identity_id,
			owner_user_id)
		values (v_capsule_id, v_login.id, p_profile_id, v_identity.id, p_user_id);
		v_connection_id := null;
		if p_client_connection_id is not null then
			insert into public.qorpera_provider_connections (profile_id, client_connection_id, owner_user_id, provider,
				created_by_user_id)
			values (p_profile_id, p_client_connection_id, p_user_id, 'openai', p_user_id)
			on conflict (profile_id, client_connection_id) do nothing
			returning id into v_connection_id;
		end if;
		if v_connection_id is null then
			insert into public.qorpera_provider_connections (profile_id, client_connection_id, owner_user_id, provider,
				created_by_user_id)
			values (p_profile_id, extensions.gen_random_uuid(), p_user_id, 'openai', p_user_id)
			returning id into v_connection_id;
		end if;
		-- Works while the member is away by default (founder decision 2026-09-20), as the web client's own consent.
		insert into public.qorpera_provider_connection_versions (
			connection_id, version, authentication_mode, native_harness, secret_reference,
			provider_account_reference, provider_account_email, billing_source, consent_version, consented_by_user_id,
			allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
			credential_capsule_id, authorization_state, max_native_concurrency
		) values (
			v_connection_id, 1, 'native_subscription', 'codex-cli', null,
			v_login.provider_account_reference, v_login.provider_account_email, 'personal_subscription',
			'qorpera-native-provider-autonomous-consent/v1', p_user_id, true, v_policy.commercial_reference,
			jsonb_build_object('monthly_microusd', 1, 'reservation_microusd', 1, 'max_calls_per_run', 128,
				'max_input_tokens_per_run', 100000000, 'max_output_tokens_per_run', 100000000,
				'max_concurrent_runs', v_policy.max_native_concurrency),
			p_user_id, v_capsule_id, 'active', v_policy.max_native_concurrency
		);
		insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
		values (p_profile_id, extensions.gen_random_uuid(), p_user_id)
		returning id into v_binding_id;
		insert into public.qorpera_execution_sponsor_versions (binding_id, version, sponsor_kind, provider_connection_id,
			provider_connection_version, allow_autonomous, created_by_user_id)
		values (v_binding_id, 1, 'member_connection', v_connection_id, 1, true, p_user_id);
		v_linked := v_linked + 1;
	end loop;
	return v_linked;
end
$$;
revoke all on function public.qorpera_link_member_model_logins(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Links a member's account logins into every company the member belongs to that the vault serves. A company whose
-- link fails is skipped (logged), so one company never blocks the others.
create function public.qorpera_link_member_model_logins_everywhere(p_user_id uuid, p_login_id uuid default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
	v_company uuid;
	v_linked integer := 0;
begin
	for v_company in
		select member.profile_id from public.qorpera_profile_members as member
		where member.user_id = p_user_id and public.qorpera_company_account_vault(member.profile_id) is not null
			and public.qorpera_model_login_sign_in_url(member.profile_id) is not null
		order by member.profile_id
	loop
		begin
			v_linked := v_linked + public.qorpera_link_member_model_logins(v_company, p_user_id, null, p_login_id);
		exception when others then
			raise warning 'account model login link skipped a company (%)', sqlstate;
		end;
	end loop;
	return v_linked;
end
$$;
revoke all on function public.qorpera_link_member_model_logins_everywhere(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A member who joins a company gets their account logins there; a failed link never blocks the membership.
create function public.qorpera_link_model_logins_on_member()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if public.qorpera_account_model_logins_enabled() then
		begin
			perform public.qorpera_link_member_model_logins(new.profile_id, new.user_id);
		exception when others then
			raise warning 'account model login link failed for a new member (%)', sqlstate;
		end;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_link_model_logins_on_member()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_profile_members_link_model_logins
	after insert on public.qorpera_profile_members
	for each row execute function public.qorpera_link_model_logins_on_member();

-- A company that starts taking sign-ins in the vault (the shared vault registers a company created a moment ago, its
-- founders already members, and switches it to vault sign-in last; or an operator switches one back) gets its members'
-- account logins; a failed link never blocks the switch. A member whose link fails here (for example a lock wait behind
-- their own Sign out everywhere at that moment) is linked at their next account sign-in, or by signing in in this
-- company.
create function public.qorpera_link_model_logins_on_registration()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	v_member uuid;
begin
	if public.qorpera_account_model_logins_enabled()
		and public.qorpera_company_account_vault(new.profile_id) is not null then
		for v_member in
			select member.user_id from public.qorpera_profile_members as member where member.profile_id = new.profile_id
			order by member.user_id
		loop
			begin
				perform public.qorpera_link_member_model_logins(new.profile_id, v_member);
			exception when others then
				raise warning 'account model login link failed for a registered company (%)', sqlstate;
			end;
		end loop;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_link_model_logins_on_registration()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_model_login_sign_in_companies_link_model_logins
	after insert on public.qorpera_model_login_sign_in_companies
	for each row execute function public.qorpera_link_model_logins_on_registration();

-- 4. Sign-in ------------------------------------------------------------------------------------------------------------

-- The vault's read of a pending sign-in (20260928329830), unchanged but for one key: an account sign-in carries
-- "scope": "account" (a vault without this change reads only the keys it knows and refuses it).
create or replace function public.qorpera_describe_model_login_sign_in_v2(
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
	) || case when v_session.model_login_scope = 'account' then jsonb_build_object('scope', 'account')
		else '{}'::jsonb end;
end
$$;

-- Completes an account sign-in: the account login (sealed by the vault under the member's key) and its version 1,
-- then its links, first into the sign-in's own company (with the sign-in's connection id), then into every other
-- company of the member that the same vault serves. A repeat after a lost answer finds its own login.
create function public.qorpera_complete_account_model_login_sign_in(
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
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_session public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_existing public.qorpera_model_logins%rowtype;
	v_envelope bytea;
	v_answer jsonb;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	if v_principal.id is null then
		raise exception 'account model logins are kept by the shared vault' using errcode = '42501';
	end if;
	if p_login_id is null or p_model_login_id is null
		or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_key_id is distinct from v_principal.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= clock_timestamp()
		or (p_provider_account_reference is not null
			and char_length(btrim(p_provider_account_reference)) not between 1 and 512)
		or (p_provider_account_email is not null
			and char_length(btrim(p_provider_account_email)) not between 3 and 254) then
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
		or v_session.model_login_kind <> 'codex' or v_session.model_login_scope <> 'account' then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	-- A repeat of a completion whose answer was lost.
	select vault.* into v_existing from public.qorpera_model_logins as vault where vault.sign_in_session_id = v_session.id;
	if v_existing.id is not null then
		if v_existing.id <> p_model_login_id or v_existing.owner_user_id is null or not exists (
			select 1 from public.qorpera_model_login_versions as version
			where version.login_id = v_existing.id and version.version = 1
				and version.envelope_sha256 = p_envelope_sha256) then
			raise exception 'model login sign-in is already complete' using errcode = '55000';
		end if;
	else
		if v_session.status <> 'pending' or v_session.expires_at <= statement_timestamp()
			or public.qorpera_model_login_sign_in_url(v_session.profile_id) is null
			or not public.qorpera_account_model_logins_enabled() then
			raise exception 'model login sign-in is unavailable' using errcode = '55000';
		end if;
		select identity.* into strict v_identity
		from public.qorpera_member_compute_identities as identity
		where identity.id = v_session.compute_identity_id and identity.profile_id = v_session.profile_id
			and identity.status = 'active';
		if v_identity.ownership_kind <> 'member' or v_identity.owner_user_id is distinct from v_session.requested_by_user_id then
			raise exception 'an account model login belongs to one member' using errcode = '42501';
		end if;
		if not exists (select 1 from public.qorpera_provider_execution_policies as policy
			where policy.provider = 'openai' and policy.authentication_mode = 'native_subscription'
				and policy.native_harness = 'codex-cli' and policy.implementation_status = 'supported'
				and policy.enablement_status = 'enabled') then
			raise exception 'native provider policy does not authorize this connection' using errcode = '42501';
		end if;
		insert into public.qorpera_model_logins (
			id, owner_user_id, principal_id, provider, native_harness, current_version, access_issued_at,
			access_expires_at, sign_in_session_id, login_kind, provider_account_reference, provider_account_email
		) values (
			p_model_login_id, v_identity.owner_user_id, v_principal.id, 'openai', 'codex-cli', 1, p_access_issued_at,
			p_access_expires_at, v_session.id, 'codex', nullif(btrim(p_provider_account_reference), ''),
			nullif(btrim(p_provider_account_email), '')
		);
		insert into public.qorpera_model_login_versions (
			login_id, version, principal_id, key_id, encrypted_envelope, envelope_sha256, origin,
			access_issued_at, access_expires_at
		) values (
			p_model_login_id, 1, v_principal.id, p_key_id, v_envelope, p_envelope_sha256, 'sign_in',
			p_access_issued_at, p_access_expires_at
		);
		-- The sign-in's own company first, with the sign-in's connection id: its failure fails the completion.
		if public.qorpera_link_member_model_logins(v_session.profile_id, v_identity.owner_user_id,
				v_session.client_connection_id, p_model_login_id) <> 1 then
			raise exception 'model login sign-in could not be linked' using errcode = '55000';
		end if;
		update public.qorpera_native_provider_login_sessions
		set status = 'completed', completed_at = statement_timestamp()
		where id = v_session.id;
		perform public.qorpera_link_member_model_logins_everywhere(v_identity.owner_user_id, p_model_login_id);
	end if;
	select jsonb_build_object('schema', 'qorpera.model-login-sign-in-complete/v1',
			'loginId', v_session.id, 'modelLoginId', p_model_login_id,
			'credentialCapsuleId', link.credential_capsule_id,
			'connectionId', version.connection_id, 'connectionVersion', version.version, 'scope', 'account')
	into v_answer
	from public.qorpera_model_login_links as link
	join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = link.credential_capsule_id
	where link.login_id = p_model_login_id and link.profile_id = v_session.profile_id
	order by version.version desc limit 1;
	if v_answer is null then
		raise exception 'model login sign-in is already complete' using errcode = '55000';
	end if;
	return v_answer;
end
$$;
revoke all on function public.qorpera_complete_account_model_login_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_account_model_login_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text)
	to qorpera_secret_broker;

-- 5. Runs ---------------------------------------------------------------------------------------------------------------

-- A live run's account login, through its capsule's link (see the header for the checks). The answer is a company
-- login's with "scope": "account", the member who owns it (the vault opens it with that member's key) and, with a
-- renewal, the shared vault's key id.
create function public.qorpera_issue_account_model_login(
	p_authority public.qorpera_cloud_secret_broker_authorities,
	p_lease public.qorpera_native_provider_connection_leases,
	p_known_version bigint,
	p_allow_renewal boolean
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_link public.qorpera_model_login_links%rowtype;
	v_login public.qorpera_model_logins%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_renewal uuid;
	v_now timestamptz := clock_timestamp();
begin
	select link.* into v_link from public.qorpera_model_login_links as link
	where link.credential_capsule_id = p_lease.credential_capsule_id;
	select login.* into v_login from public.qorpera_model_logins as login where login.id = v_link.login_id;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_lease.run_id;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = p_authority.principal_id and principal.status = 'active';
	if v_link.credential_capsule_id is null or v_login.id is null or v_run.id is null or v_principal.id is null
		or not public.qorpera_account_model_logins_enabled()
		or v_login.owner_user_id is null
		or v_login.principal_id is distinct from v_principal.id
		or v_link.profile_id is distinct from p_authority.profile_id
		or v_run.profile_id is distinct from p_authority.profile_id
		or v_link.compute_identity_id is distinct from p_lease.compute_identity_id
		or v_link.owner_user_id is distinct from v_login.owner_user_id
		or v_run.sponsored_by_user_id is distinct from v_login.owner_user_id
		or public.qorpera_company_account_vault(p_authority.profile_id) is distinct from v_principal.id
		or not exists (select 1 from public.qorpera_member_compute_identities as identity
			where identity.id = p_lease.compute_identity_id and identity.profile_id = v_link.profile_id
				and identity.ownership_kind = 'member' and identity.owner_user_id = v_login.owner_user_id)
		or not exists (select 1 from public.qorpera_native_credential_capsules as capsule
			where capsule.id = p_lease.credential_capsule_id and capsule.profile_id = v_link.profile_id
				and capsule.compute_identity_id = v_link.compute_identity_id and capsule.ownership_kind = 'member'
				and capsule.owner_user_id = v_login.owner_user_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || v_login.id::text)
		or not exists (select 1 from public.qorpera_provider_connections as connection
			where connection.id = p_lease.provider_connection_id and connection.profile_id = v_link.profile_id
				and connection.owner_user_id = v_login.owner_user_id) then
		raise exception 'model login is unavailable to this broker' using errcode = '42501';
	end if;
	if v_login.status <> 'active' then
		raise exception 'model login needs a new sign-in' using errcode = '55000';
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
			'scope', 'account',
			'ownerUserId', v_login.owner_user_id,
			'companyId', v_link.profile_id,
			'computeIdentityId', v_link.compute_identity_id,
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
		'scope', 'account',
		'ownerUserId', v_login.owner_user_id,
		'companyId', v_link.profile_id,
		'computeIdentityId', v_link.compute_identity_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'accessIssuedAt', v_version.access_issued_at,
		'accessExpiresAt', v_version.access_expires_at,
		'renewing', v_renewal is null and v_login.renewal_until is not null and v_login.renewal_until >= v_now,
		'unchanged', false,
		'renewal', case when v_renewal is null then null else jsonb_build_object(
			'token', v_renewal, 'baseVersion', v_version.version, 'keyId', v_principal.key_id) end
	);
end
$$;
revoke all on function public.qorpera_issue_account_model_login(public.qorpera_cloud_secret_broker_authorities,
	public.qorpera_native_provider_connection_leases, bigint, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The run's issue (20260928329830) with one change: a capsule no company login holds is looked up through its link.
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
	-- 20260930548000: an account login, through the capsule's link.
	if v_login.id is null then
		return public.qorpera_issue_account_model_login(v_authority, v_lease, p_known_version, p_allow_renewal);
	end if;
	if v_login.owner_user_id is not null or v_login.broker_authority_id <> v_authority.id
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

-- An identity's login is in the vault (20260928180600) also through an active link to an active account login.
create or replace function public.qorpera_compute_identity_login_in_vault(p_compute_identity_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select p_compute_identity_id is not null
		and (exists (
			select 1 from public.qorpera_model_logins as login
			join public.qorpera_native_credential_capsules as capsule on capsule.id = login.credential_capsule_id
			where login.compute_identity_id = p_compute_identity_id and login.status = 'active'
				and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
		) or exists (
			-- 20260930548000: a link to an account login.
			select 1 from public.qorpera_model_login_links as link
			join public.qorpera_model_logins as login on login.id = link.login_id
			join public.qorpera_native_credential_capsules as capsule on capsule.id = link.credential_capsule_id
			where link.compute_identity_id = p_compute_identity_id and login.status = 'active'
				and login.owner_user_id = link.owner_user_id
				and capsule.status = 'active' and capsule.compute_identity_id = p_compute_identity_id
				and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
		))
		and not exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference !~ '^model-login/[0-9a-f-]{36}$'
		)
$$;

-- 6. The shared vault's own calls: renewals, the idle pass, accounts and the switch-off -----------------------------

-- Saves an account login's renewal (the body of 20260928329830's commit for a Codex login), under the shared vault's
-- principal and key.
create function public.qorpera_commit_account_model_login_renewal(
	p_principal_id uuid,
	p_capability_sha256 text,
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
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_envelope bytea;
	v_version bigint;
	v_now timestamptz := clock_timestamp();
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_login_id is null or p_renewal_token is null or p_base_version is null or p_base_version < 1
		or p_key_id is distinct from v_principal.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= v_now
		or p_access_issued_at > v_now + interval '5 minutes'
		or p_access_expires_at - p_access_issued_at > interval '400 days' then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_model_logins as login
		join public.qorpera_model_login_versions as version
			on version.login_id = login.id and version.version = login.current_version
		where login.id = p_login_id and login.principal_id = v_principal.id and login.owner_user_id is not null
			and login.current_version = p_base_version + 1 and version.envelope_sha256 = p_envelope_sha256
	) then
		return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id,
			'version', p_base_version + 1);
	end if;
	update public.qorpera_model_logins
	set current_version = p_base_version + 1, access_issued_at = p_access_issued_at,
		access_expires_at = p_access_expires_at, renewal_token = null, renewal_until = null,
		renewal_failures = 0, last_renewal_failure = null, renewal_failed_at = null, updated_at = v_now
	where id = p_login_id and principal_id = v_principal.id and owner_user_id is not null and status = 'active'
		and login_kind = 'codex' and current_version = p_base_version and renewal_token = p_renewal_token
		and access_expires_at < p_access_expires_at
	returning current_version into v_version;
	if v_version is null then
		if exists (select 1 from public.qorpera_model_logins where id = p_login_id and principal_id = v_principal.id
			and owner_user_id is not null and status = 'active' and current_version = p_base_version
			and renewal_token = p_renewal_token) then
			raise exception 'model login renewal is not a later pass' using errcode = '22023';
		end if;
		raise exception 'model login renewal lock is not held' using errcode = '55000';
	end if;
	insert into public.qorpera_model_login_versions(
		login_id, version, principal_id, key_id, encrypted_envelope, envelope_sha256, origin,
		access_issued_at, access_expires_at)
	values (p_login_id, v_version, v_principal.id, p_key_id, v_envelope, p_envelope_sha256, 'renewal',
		p_access_issued_at, p_access_expires_at);
	return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id, 'version', v_version);
end
$$;

-- Gives an account login's renewal lock back (20260928160000's release, under the shared vault's principal).
create function public.qorpera_release_account_model_login_renewal(
	p_principal_id uuid,
	p_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_permanent boolean,
	p_reason text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_status text;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_login_id is null or p_renewal_token is null or p_permanent is null
		or p_base_version is null or p_base_version < 1
		or coalesce(p_reason, '') !~ '^[a-z][a-z0-9_]{0,63}$' then
		raise exception 'model login renewal release is invalid' using errcode = '22023';
	end if;
	update public.qorpera_model_logins
	set status = case when p_permanent and status = 'active' and current_version = p_base_version
			then 'needs_sign_in' else status end,
		renewal_token = null, renewal_until = null,
		renewal_failures = renewal_failures + 1, last_renewal_failure = p_reason,
		renewal_failed_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = p_login_id and principal_id = v_principal.id and owner_user_id is not null
		and renewal_token = p_renewal_token
	returning status into v_status;
	return jsonb_build_object('schema', 'qorpera.model-login-renewal-release/v1', 'loginId', p_login_id,
		'released', v_status is not null, 'status', v_status);
end
$$;

-- Whether an account login is still used somewhere: an active link capsule that the newest, active version of an
-- active connection uses, in a company its vault still serves.
create function public.qorpera_account_model_login_used(p_login_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_model_login_links as link
		join public.qorpera_model_logins as login on login.id = link.login_id
		join public.qorpera_native_credential_capsules as capsule on capsule.id = link.credential_capsule_id
		join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
		join public.qorpera_provider_connections as connection on connection.id = version.connection_id
		where link.login_id = p_login_id and capsule.status = 'active'
			and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
			and version.authorization_state = 'active'
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = version.connection_id and newer.version > version.version)
			and connection.status = 'active' and connection.profile_id = link.profile_id
			and connection.owner_user_id = login.owner_user_id
			and public.qorpera_company_account_vault(link.profile_id) is not distinct from login.principal_id
	)
$$;
revoke all on function public.qorpera_account_model_login_used(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The shared vault's one idle pass over its account logins: takes the renewal lock of the most urgent idle one that
-- is still used somewhere, under a run's lock conditions, and hands it over with its current version.
create function public.qorpera_take_idle_account_model_login_renewal(
	p_principal_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_candidate uuid;
	v_token uuid;
	v_login public.qorpera_model_logins%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	for v_candidate in
		select login.id from public.qorpera_model_logins as login
		where login.principal_id = v_principal.id and login.owner_user_id is not null and login.status = 'active'
			and public.qorpera_model_login_renewal_due(login, v_now, true)
			and (login.renewal_until is null or login.renewal_until < v_now)
			and (login.renewal_failed_at is null or login.renewal_failed_at <= v_now
				- least(interval '1 minute' * power(2, least(login.renewal_failures, 7) - 1), interval '1 hour'))
			and public.qorpera_account_model_login_used(login.id)
		order by login.access_expires_at, login.id
		limit 4
	loop
		-- The lock's own conditions again, on the row itself: a run may have taken it meanwhile.
		update public.qorpera_model_logins as login
		set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '5 minutes', updated_at = v_now
		where login.id = v_candidate and login.principal_id = v_principal.id and login.owner_user_id is not null
			and login.status = 'active'
			and public.qorpera_model_login_renewal_due(login, v_now, true)
			and (login.renewal_until is null or login.renewal_until < v_now)
			and (login.renewal_failed_at is null or login.renewal_failed_at <= v_now
				- least(interval '1 minute' * power(2, least(login.renewal_failures, 7) - 1), interval '1 hour'))
		returning login.renewal_token into v_token;
		exit when v_token is not null;
	end loop;
	if v_token is null then
		return jsonb_build_object('schema', 'qorpera.account-model-login-idle-renewal/v1', 'renewal', null);
	end if;
	select login.* into strict v_login from public.qorpera_model_logins as login where login.id = v_candidate;
	select version.* into strict v_version from public.qorpera_model_login_versions as version
	where version.login_id = v_login.id and version.version = v_login.current_version;
	return jsonb_build_object(
		'schema', 'qorpera.account-model-login-idle-renewal/v1',
		'loginId', v_login.id,
		'loginKind', v_login.login_kind,
		'ownerUserId', v_login.owner_user_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'accessIssuedAt', v_version.access_issued_at,
		'accessExpiresAt', v_version.access_expires_at,
		'renewal', jsonb_build_object('token', v_token, 'baseVersion', v_version.version, 'keyId', v_principal.key_id)
	);
end
$$;

-- The shared vault's account logins with no recorded ChatGPT account yet (20260928243500's list, for account logins).
create function public.qorpera_account_model_logins_without_account(
	p_principal_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_logins jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(jsonb_build_object(
			'loginId', missing.id,
			'ownerUserId', missing.owner_user_id,
			'version', missing.version,
			'keyId', missing.key_id,
			'encryptedEnvelopeBase64', encode(missing.encrypted_envelope, 'base64'),
			'envelopeSha256', missing.envelope_sha256
		) order by missing.created_at, missing.id), '[]'::jsonb)
	into v_logins
	from (
		select login.id, login.owner_user_id, login.created_at, version.version, version.key_id,
			version.encrypted_envelope, version.envelope_sha256
		from public.qorpera_model_logins as login
		join public.qorpera_model_login_versions as version
			on version.login_id = login.id and version.version = login.current_version
		where login.principal_id = v_principal.id and login.owner_user_id is not null
			and login.status in ('active', 'needs_sign_in') and login.account_identity is null
		order by random()
		limit 8
	) as missing;
	return jsonb_build_object('schema', 'qorpera.account-model-login-accounts/v1', 'logins', v_logins);
end
$$;

create function public.qorpera_record_account_model_login_account(
	p_principal_id uuid,
	p_capability_sha256 text,
	p_login_id uuid,
	p_account_identity text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_recorded text;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_login_id is null or coalesce(p_account_identity, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login account is invalid' using errcode = '22023';
	end if;
	update public.qorpera_model_logins set account_identity = p_account_identity
	where id = p_login_id and principal_id = v_principal.id and owner_user_id is not null and account_identity is null;
	select account_identity into v_recorded from public.qorpera_model_logins
	where id = p_login_id and principal_id = v_principal.id and owner_user_id is not null;
	if v_recorded is null then
		raise exception 'model login is unavailable to this vault' using errcode = '42501';
	end if;
	if v_recorded <> p_account_identity then
		raise exception 'model login account differs from the recorded one' using errcode = '22023';
	end if;
	return jsonb_build_object('schema', 'qorpera.model-login-account/v1', 'loginId', p_login_id, 'recorded', true);
end
$$;

-- Moves one member's pins from an old login to a new one in one company and, once no work names the old login any
-- more, makes the same updates as the member's own Disconnect (20260928243500's loop body). 'switched', 'waiting'
-- (work or a busy row), 'refused' (the move refused) or 'gone' (the old connection is no longer active).
create function public.qorpera_switch_off_login_pair(p_profile_id uuid, p_member_id uuid, p_old_connection_id uuid,
	p_new_connection_id uuid)
returns text
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_move jsonb;
begin
	begin
		v_move := public.qorpera_move_member_login_pins(p_profile_id, p_member_id, p_old_connection_id, p_new_connection_id);
	exception when invalid_parameter_value then
		v_move := jsonb_build_object('status', 'refused', 'reason', 'invalid');
	end;
	if v_move ->> 'status' is distinct from 'moved' then
		return 'refused';
	end if;
	if exists (
			select 1 from public.qorpera_runner_jobs as job
			join public.qorpera_execution_runs as run on run.id = job.run_id
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
			where job.profile_id = p_profile_id and job.status in ('queued', 'leased')
				and sponsor.provider_connection_id = p_old_connection_id)
		or exists (
			select 1 from public.qorpera_native_provider_connection_leases as lease
			where lease.provider_connection_id = p_old_connection_id and lease.status = 'active'
				and lease.expires_at > clock_timestamp())
		or exists (
			select 1 from public.qorpera_wake_occurrences as occurrence
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = occurrence.sponsor_binding_id and sponsor.version = occurrence.sponsor_version
			where occurrence.status = 'queued' and occurrence.profile_id = p_profile_id
				and sponsor.provider_connection_id = p_old_connection_id)
		or exists (
			select 1 from public.qorpera_session_turn_requests as request
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = request.sponsor_binding_id and sponsor.version = request.sponsor_version
			where request.status = 'queued' and request.profile_id = p_profile_id
				and sponsor.provider_connection_id = p_old_connection_id)
		or exists (
			select 1 from public.qorpera_company_proposal_review_assignments as review
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = review.reviewer_sponsor_binding_id and sponsor.version = review.reviewer_sponsor_version
			where review.status = 'queued' and review.profile_id = p_profile_id
				and sponsor.provider_connection_id = p_old_connection_id) then
		return 'waiting';
	end if;
	begin
		perform 1 from public.qorpera_provider_connections
		where id = p_old_connection_id and status = 'active' for update nowait;
		if not found then
			return 'gone';
		end if;
	exception when lock_not_available then
		return 'waiting';
	end;
	begin
		update public.qorpera_provider_connections set status = 'revoked' where id = p_old_connection_id;
		update public.qorpera_native_credential_capsules
		set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp())
		where id in (
			select version.credential_capsule_id from public.qorpera_provider_connection_versions as version
			where version.connection_id = p_old_connection_id
				and version.authentication_mode = 'native_subscription' and version.credential_capsule_id is not null
		) and status <> 'revoked';
		update public.qorpera_provider_connection_versions set authorization_state = 'revoked'
		where connection_id = p_old_connection_id and authentication_mode = 'native_subscription'
			and authorization_state <> 'revoked';
		update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = statement_timestamp()
		where provider_connection_id = p_old_connection_id and status = 'active';
	exception when lock_not_available then
		return 'waiting';
	end;
	return 'switched';
end
$$;
revoke all on function public.qorpera_switch_off_login_pair(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The shared vault's switch-off pass for account logins (20260928243500 and 20260930059000, for the companies an
-- account login is linked into): in each company that takes sign-ins in the vault, the member's older active Codex
-- connection whose current login is of the same ChatGPT account (a node login whose recorded account matches, a
-- company vault login, or another account login of the member) has its pins moved to the link connection and is then
-- switched off as Disconnect does. At most four old connections per pass. Only while account logins are on: switched
-- off, a link pays for nothing, so no member's working login is moved onto one.
create function public.qorpera_switch_off_replaced_by_account_logins(
	p_principal_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_pair record;
	v_outcome text;
	v_switched integer := 0;
	v_waiting integer := 0;
	v_refused integer := 0;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	for v_pair in
		select distinct on (old_connection.id) old_connection.id as old_connection_id,
			link_connection.id as new_connection_id, link.owner_user_id as member_id, link.profile_id
		from public.qorpera_model_logins as login
		join public.qorpera_model_login_links as link on link.login_id = login.id
			and link.owner_user_id = login.owner_user_id
		join public.qorpera_native_credential_capsules as pointer on pointer.id = link.credential_capsule_id
		join public.qorpera_provider_connection_versions as link_version on link_version.credential_capsule_id = pointer.id
		join public.qorpera_provider_connections as link_connection on link_connection.id = link_version.connection_id
		join public.qorpera_provider_connections as old_connection on old_connection.profile_id = link.profile_id
			and old_connection.owner_user_id = link.owner_user_id and old_connection.id <> link_connection.id
		join lateral (
			select version.* from public.qorpera_provider_connection_versions as version
			where version.connection_id = old_connection.id order by version.version desc limit 1
		) as old_version on true
		join public.qorpera_native_credential_capsules as old_capsule on old_capsule.id = old_version.credential_capsule_id
		where public.qorpera_account_model_logins_enabled()
			and login.principal_id = v_principal.id and login.owner_user_id is not null and login.status = 'active'
			and login.account_identity is not null
			and public.qorpera_company_account_vault(link.profile_id) = v_principal.id
			and exists (select 1 from public.qorpera_model_login_sign_in_companies as company
				where company.profile_id = link.profile_id)
			and pointer.status = 'active' and pointer.encrypted_capsule_reference = 'model-login/' || login.id::text
			and link_connection.status = 'active' and link_connection.profile_id = link.profile_id
			and link_connection.owner_user_id = link.owner_user_id
			and link_version.authorization_state = 'active'
			and link_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
				where latest.connection_id = link_connection.id)
			and old_connection.status = 'active' and old_connection.provider = 'openai'
			and old_connection.created_at < link_connection.created_at
			and old_version.authentication_mode = 'native_subscription' and old_version.native_harness = 'codex-cli'
			and old_version.authorization_state = 'active' and old_capsule.status = 'active'
			and (
				-- A node login whose current login was recorded as the same account.
				(old_capsule.encrypted_capsule_reference !~ '^model-login/'
					and exists (select 1 from public.qorpera_native_provider_account_metadata as seen
						join public.qorpera_provider_connection_versions as seen_version
							on seen_version.connection_id = seen.connection_id and seen_version.version = seen.connection_version
						where seen.connection_id = old_connection.id
							and seen_version.credential_capsule_id = old_version.credential_capsule_id
							and seen.provider_account_identity = login.account_identity))
				-- A company vault login of the same kind and account.
				or exists (select 1 from public.qorpera_model_logins as old_login
					where old_login.credential_capsule_id = old_capsule.id
						and old_capsule.encrypted_capsule_reference = 'model-login/' || old_login.id::text
						and old_login.profile_id = link.profile_id and old_login.status in ('active', 'needs_sign_in')
						and old_login.login_kind = login.login_kind and old_login.account_identity = login.account_identity)
				-- The member's other account login of the same account.
				or exists (select 1 from public.qorpera_model_login_links as old_link
					join public.qorpera_model_logins as old_login on old_login.id = old_link.login_id
					where old_link.credential_capsule_id = old_capsule.id and old_login.id <> login.id
						and old_capsule.encrypted_capsule_reference = 'model-login/' || old_login.id::text
						and old_login.owner_user_id = login.owner_user_id and old_login.status in ('active', 'needs_sign_in')
						and old_login.login_kind = login.login_kind and old_login.account_identity = login.account_identity)
			)
		order by old_connection.id, link_connection.created_at desc, link_connection.id
		limit 4
	loop
		v_outcome := public.qorpera_switch_off_login_pair(v_pair.profile_id, v_pair.member_id, v_pair.old_connection_id,
			v_pair.new_connection_id);
		if v_outcome = 'switched' then
			v_switched := v_switched + 1;
		elsif v_outcome = 'waiting' then
			v_waiting := v_waiting + 1;
		elsif v_outcome = 'refused' then
			v_refused := v_refused + 1;
		end if;
	end loop;
	return jsonb_build_object('schema', 'qorpera.model-login-switch-off/v1', 'switchedOff', v_switched,
		'waiting', v_waiting, 'refused', v_refused);
end
$$;

revoke all on function public.qorpera_commit_account_model_login_renewal(
		uuid, text, uuid, uuid, bigint, text, text, text, timestamptz, timestamptz),
	public.qorpera_release_account_model_login_renewal(uuid, text, uuid, uuid, bigint, boolean, text),
	public.qorpera_take_idle_account_model_login_renewal(uuid, text),
	public.qorpera_account_model_logins_without_account(uuid, text),
	public.qorpera_record_account_model_login_account(uuid, text, uuid, text),
	public.qorpera_switch_off_replaced_by_account_logins(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_commit_account_model_login_renewal(
		uuid, text, uuid, uuid, bigint, text, text, text, timestamptz, timestamptz),
	public.qorpera_release_account_model_login_renewal(uuid, text, uuid, uuid, bigint, boolean, text),
	public.qorpera_take_idle_account_model_login_renewal(uuid, text),
	public.qorpera_account_model_logins_without_account(uuid, text),
	public.qorpera_record_account_model_login_account(uuid, text, uuid, text),
	public.qorpera_switch_off_replaced_by_account_logins(uuid, text)
	to qorpera_secret_broker;

-- 7. Payers and usage ---------------------------------------------------------------------------------------------------

-- A member's logins that could pay (20260928489170), unchanged but for one condition: a link capsule counts only while
-- the switch is on, for the link's own member, in a company the login's shared vault serves.
create or replace function public.qorpera_member_live_accounts(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, binding_id uuid, sponsor_version bigint, compute_identity_id uuid, remaining numeric)
language sql stable security definer set search_path = '' as $$
    -- 20260930059000: the conversation's login is kept from these at any usage.
    select connection.id,sponsor.binding_id,sponsor.version,identity.id,
        public.qorpera_native_account_remaining(connection.id,version.version)
    from public.qorpera_member_compute_identities identity
    join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id = identity.id
        and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
    join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
        and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
        and not exists (select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = version.connection_id and newer.version > version.version)
    join public.qorpera_provider_connections connection on connection.id = version.connection_id
        and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status = 'active'
    join lateral (
        select candidate.* from public.qorpera_execution_sponsor_versions candidate
        join public.qorpera_execution_sponsor_bindings binding on binding.id = candidate.binding_id
            and binding.profile_id = p_profile_id and binding.created_by_user_id = p_user_id and binding.status = 'active'
        where candidate.provider_connection_id = connection.id and candidate.provider_connection_version = version.version
            and candidate.sponsor_kind = 'member_connection'
            and not exists (select 1 from public.qorpera_execution_sponsor_versions newer
                where newer.binding_id = candidate.binding_id and newer.version > candidate.version)
        order by candidate.created_at desc,candidate.version desc limit 1
    ) sponsor on true
    where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
        and identity.owner_user_id = p_user_id and identity.status = 'active' and identity.recovery_pending_id is null
        and connection.provider = 'openai' and version.native_harness = 'codex-cli'
        and public.qorpera_provider_execution_enabled(connection.provider,'native_subscription',version.native_harness)
        and exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
            and member.user_id = p_user_id and member.role in ('owner','admin','contributor'))
        -- 20260930548000: an account login's link only while account logins are on, in a company its vault serves.
        and (not exists (select 1 from public.qorpera_model_login_links link where link.credential_capsule_id = capsule.id)
            or exists (select 1 from public.qorpera_model_login_links link
                join public.qorpera_model_logins login on login.id = link.login_id
                where link.credential_capsule_id = capsule.id and link.profile_id = p_profile_id
                    and link.owner_user_id = p_user_id and login.owner_user_id = p_user_id
                    and login.principal_id = public.qorpera_company_account_vault(p_profile_id)
                    and public.qorpera_account_model_logins_enabled()))
$$;

-- The other companies' connections that use the same account login as this connection's newest version.
create function public.qorpera_account_login_sibling_connections(p_connection_id uuid)
returns table(connection_id uuid, connection_version bigint)
language sql stable security definer set search_path = '' as $$
	select other_version.connection_id, other_version.version
	from public.qorpera_provider_connection_versions as own_version
	join public.qorpera_model_login_links as own_link on own_link.credential_capsule_id = own_version.credential_capsule_id
	join public.qorpera_model_login_links as other_link on other_link.login_id = own_link.login_id
		and other_link.owner_user_id = own_link.owner_user_id
		and other_link.credential_capsule_id <> own_link.credential_capsule_id
	join public.qorpera_provider_connection_versions as other_version
		on other_version.credential_capsule_id = other_link.credential_capsule_id
	where own_version.connection_id = p_connection_id
		and own_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
			where latest.connection_id = p_connection_id)
		and other_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
			where latest.connection_id = other_version.connection_id)
$$;
revoke all on function public.qorpera_account_login_sibling_connections(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The usage limit and the room left are the login's, not one company's: a usage-limit signal on any company's link
-- connection of the same account login counts for all of them, and the room left is the tightest of their fresh
-- readings (an unknown or stale reading counts for nothing). The company
-- bodies (20260920016000 and 20260919005000) are kept as they are under new names; for a connection that is no link
-- the answers are theirs.
alter function public.qorpera_native_account_usage_limit_reset(uuid)
	rename to qorpera_native_account_usage_limit_reset_company;
create function public.qorpera_native_account_usage_limit_reset(p_connection_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select greatest(public.qorpera_native_account_usage_limit_reset_company(p_connection_id),
		(select max(public.qorpera_native_account_usage_limit_reset_company(sibling.connection_id))
			from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling))
$$;
revoke all on function public.qorpera_native_account_usage_limit_reset(uuid) from public, anon, authenticated, service_role;

alter function public.qorpera_native_account_remaining(uuid, bigint)
	rename to qorpera_native_account_remaining_company;
create function public.qorpera_native_account_remaining(p_connection_id uuid, p_connection_version bigint)
returns numeric language sql stable security definer set search_path = '' as $$
	select case when public.qorpera_native_account_usage_limit_reset(p_connection_id) is not null then 0
		else coalesce((select min(known.remaining) from (
				select public.qorpera_native_account_remaining_company(p_connection_id, p_connection_version) as remaining
				union all
				select public.qorpera_native_account_remaining_company(sibling.connection_id, sibling.connection_version)
				from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling
			) as known where known.remaining >= 0), -1) end
$$;
revoke all on function public.qorpera_native_account_remaining(uuid, bigint) from public, anon, authenticated, service_role;

-- A routine's login that waits for a new sign-in (20260928499130), also an account login's.
create or replace function public.qorpera_company_state_routine_waits(p_connection_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930095000, 20260930548000
	select case
		when exists (select 1 from public.qorpera_model_logins as login
			where login.credential_capsule_id = version.credential_capsule_id and login.status <> 'active') then 'sign_in'
		when exists (select 1 from public.qorpera_model_login_links as link
			join public.qorpera_model_logins as login on login.id = link.login_id
			where link.credential_capsule_id = version.credential_capsule_id and login.status <> 'active') then 'sign_in'
		when public.qorpera_native_account_remaining(version.connection_id, version.version) = 0 then 'usage_limit'
	end
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = p_connection_id
	order by version.version desc
	limit 1
$$;

-- Whether an identity's Codex usage is read in the vault (20260928185000), also through a link.
create or replace function public.qorpera_model_login_usage_in_vault(p_compute_identity_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select (exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_model_logins as vault on vault.credential_capsule_id = capsule.id
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
				and vault.compute_identity_id = p_compute_identity_id
		) or exists (
			-- 20260930548000: a link to an account login.
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_model_login_links as link on link.credential_capsule_id = capsule.id
			join public.qorpera_model_logins as vault on vault.id = link.login_id
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
				and link.compute_identity_id = p_compute_identity_id
		))
		and not exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
			join public.qorpera_provider_connections as connection on connection.id = version.connection_id
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference !~ '^model-login/[0-9a-f-]{36}$'
				and connection.status = 'active' and connection.provider = 'openai'
				and version.authorization_state = 'active' and version.authentication_mode = 'native_subscription'
				and version.native_harness = 'codex-cli'
				and not exists (select 1 from public.qorpera_provider_connection_versions as newer
					where newer.connection_id = version.connection_id and newer.version > version.version)
		)
$$;

-- The broker's read of an account refresh (20260928185000 with 20260928329830's Codex-only line), with the identity's
-- account logins too: each such entry carries the member who owns it ("ownerUserId"), whose key opens it.
create or replace function public.qorpera_describe_model_login_account_refresh(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	select authority.* into strict v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-account-refresh/v1',
		'requestId', v_request.id,
		'profileId', v_request.profile_id,
		'computeIdentityId', v_request.compute_identity_id,
		'requestedByUserId', v_request.requested_by_user_id,
		'status', v_request.status,
		'expiresAt', v_request.expires_at,
		-- Only a pending refresh reads logins, at most 8 of them.
		'logins', case when v_request.status <> 'pending' then '[]'::jsonb else coalesce((
			select jsonb_agg(login order by login ->> 'loginId') from (select candidate.login from ((
				select jsonb_build_object(
					'loginId', vault.id,
					'version', version.version,
					'keyId', version.key_id,
					'encryptedEnvelopeBase64', encode(version.encrypted_envelope, 'base64'),
					'envelopeSha256', version.envelope_sha256,
					'connectionId', connection_version.connection_id,
					'connectionVersion', connection_version.version,
					'credentialCapsuleId', vault.credential_capsule_id
				) as login, seen.checked_at, vault.id
				from public.qorpera_model_logins as vault
				join public.qorpera_native_credential_capsules as capsule
					on capsule.id = vault.credential_capsule_id and capsule.status = 'active'
					and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
				join public.qorpera_model_login_versions as version
					on version.login_id = vault.id and version.version = vault.current_version
				join public.qorpera_provider_connection_versions as connection_version
					on connection_version.credential_capsule_id = vault.credential_capsule_id
					and connection_version.authorization_state = 'active'
				join public.qorpera_provider_connections as connection
					on connection.id = connection_version.connection_id and connection.status = 'active'
				left join public.qorpera_native_provider_account_metadata as seen
					on seen.connection_id = connection_version.connection_id
					and seen.connection_version = connection_version.version
				where vault.compute_identity_id = v_request.compute_identity_id
					and vault.profile_id = v_request.profile_id
					and vault.status = 'active'
					and vault.login_kind = 'codex'
					and vault.broker_authority_id = p_broker_authority_id
					and not exists (select 1 from public.qorpera_provider_connection_versions as newer
						where newer.connection_id = connection_version.connection_id
							and newer.version > connection_version.version)
			) union all (
				-- 20260930548000: the identity's account logins, through their links.
				select jsonb_build_object(
					'loginId', vault.id,
					'ownerUserId', vault.owner_user_id,
					'version', version.version,
					'keyId', version.key_id,
					'encryptedEnvelopeBase64', encode(version.encrypted_envelope, 'base64'),
					'envelopeSha256', version.envelope_sha256,
					'connectionId', connection_version.connection_id,
					'connectionVersion', connection_version.version,
					'credentialCapsuleId', link.credential_capsule_id
				) as login, seen.checked_at, vault.id
				from public.qorpera_model_login_links as link
				join public.qorpera_model_logins as vault on vault.id = link.login_id
				join public.qorpera_native_credential_capsules as capsule
					on capsule.id = link.credential_capsule_id and capsule.status = 'active'
					and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
				join public.qorpera_model_login_versions as version
					on version.login_id = vault.id and version.version = vault.current_version
				join public.qorpera_provider_connection_versions as connection_version
					on connection_version.credential_capsule_id = link.credential_capsule_id
					and connection_version.authorization_state = 'active'
				join public.qorpera_provider_connections as connection
					on connection.id = connection_version.connection_id and connection.status = 'active'
				left join public.qorpera_native_provider_account_metadata as seen
					on seen.connection_id = connection_version.connection_id
					and seen.connection_version = connection_version.version
				where link.compute_identity_id = v_request.compute_identity_id
					and link.profile_id = v_request.profile_id
					and link.owner_user_id = v_request.requested_by_user_id
					and vault.owner_user_id = link.owner_user_id
					and vault.status = 'active'
					and vault.principal_id = v_authority.principal_id
					and public.qorpera_account_model_logins_enabled()
					and not exists (select 1 from public.qorpera_provider_connection_versions as newer
						where newer.connection_id = connection_version.connection_id
							and newer.version > connection_version.version)
			)) as candidate
			-- Never read first, then the longest unread, as a node lists them.
			order by candidate.checked_at nulls first, candidate.id
			limit 8) as logins
		), '[]'::jsonb) end
	);
end
$$;

-- The broker records one vault login's display metadata (20260928185000), also an account login's through its link.
create or replace function public.qorpera_record_model_login_account_metadata(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text,
	p_login_id uuid,
	p_connection_id uuid,
	p_connection_version bigint,
	p_provider_account_email text,
	p_provider_account_usage jsonb,
	p_provider_account_identity text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_window jsonb;
	v_observed timestamptz;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	if v_request.status not in ('pending', 'completed') or v_request.expires_at <= clock_timestamp() then
		raise exception 'model login account refresh has ended' using errcode = '55000';
	end if;
	perform 1 from public.qorpera_model_logins as vault
	join public.qorpera_native_credential_capsules as capsule
		on capsule.id = vault.credential_capsule_id and capsule.status = 'active'
		and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.credential_capsule_id = vault.credential_capsule_id
		and connection_version.connection_id = p_connection_id and connection_version.version = p_connection_version
		and connection_version.authorization_state = 'active'
	join public.qorpera_provider_connections as connection
		on connection.id = connection_version.connection_id and connection.status = 'active'
	where vault.id = p_login_id and vault.status = 'active'
		and vault.compute_identity_id = v_request.compute_identity_id
		and vault.profile_id = v_request.profile_id
		and vault.broker_authority_id = p_broker_authority_id
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection_version.connection_id and newer.version > connection_version.version);
	if not found then
		-- 20260930548000: an account login, through its link in the refresh's company.
		perform 1 from public.qorpera_model_login_links as link
		join public.qorpera_model_logins as vault on vault.id = link.login_id
		join public.qorpera_cloud_secret_broker_authorities as authority on authority.id = p_broker_authority_id
		join public.qorpera_native_credential_capsules as capsule
			on capsule.id = link.credential_capsule_id and capsule.status = 'active'
			and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
		join public.qorpera_provider_connection_versions as connection_version
			on connection_version.credential_capsule_id = link.credential_capsule_id
			and connection_version.connection_id = p_connection_id and connection_version.version = p_connection_version
			and connection_version.authorization_state = 'active'
		join public.qorpera_provider_connections as connection
			on connection.id = connection_version.connection_id and connection.status = 'active'
		where vault.id = p_login_id and vault.status = 'active'
			and link.compute_identity_id = v_request.compute_identity_id
			and link.profile_id = v_request.profile_id
			and link.owner_user_id = v_request.requested_by_user_id and vault.owner_user_id = link.owner_user_id
			and vault.principal_id = authority.principal_id
			and public.qorpera_account_model_logins_enabled()
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = connection_version.connection_id and newer.version > connection_version.version);
	end if;
	if not found then raise exception 'model login account metadata connection unavailable' using errcode = '42501'; end if;
	if p_provider_account_email is not null and (
		char_length(p_provider_account_email) not between 3 and 254
		or p_provider_account_email <> btrim(p_provider_account_email)
		or p_provider_account_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+\.[^[:space:]@[:cntrl:]]+$'
	) then raise exception 'Account email invalid' using errcode = '22023'; end if;
	if p_provider_account_identity is not null and p_provider_account_identity !~ '^[0-9a-f]{64}$' then
		raise exception 'Account identity invalid' using errcode = '22023'; end if;
	if p_provider_account_usage is not null then
		if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
			or p_provider_account_usage - array['observedAt','windows'] <> '{}'::jsonb
			or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
			or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then
			raise exception 'Account usage invalid' using errcode = '22023'; end if;
		v_observed := (p_provider_account_usage ->> 'observedAt')::timestamptz;
		if v_observed not between clock_timestamp() - interval '5 minutes' and clock_timestamp() + interval '30 seconds'
			or jsonb_array_length(p_provider_account_usage -> 'windows') not between 1 and 2 then
			raise exception 'Account usage observation invalid' using errcode = '22023'; end if;
		for v_window in select value from jsonb_array_elements(p_provider_account_usage -> 'windows') loop
			if jsonb_typeof(v_window) <> 'object'
				or v_window - array['id','label','usedPercent','resetAt','windowSeconds'] <> '{}'::jsonb
				or coalesce(v_window ->> 'id','') not in ('primary','secondary')
				or jsonb_typeof(v_window -> 'label') is distinct from 'string'
				or char_length(v_window ->> 'label') not between 1 and 80
				or jsonb_typeof(v_window -> 'usedPercent') is distinct from 'number'
				or (v_window ->> 'usedPercent')::numeric not between 0 and 100
				or (v_window ? 'windowSeconds' and (jsonb_typeof(v_window -> 'windowSeconds') <> 'number'
					or (v_window ->> 'windowSeconds')::numeric not between 1 and 31536000)) then
				raise exception 'Account usage window invalid' using errcode = '22023'; end if;
			if v_window ? 'resetAt' and (jsonb_typeof(v_window -> 'resetAt') <> 'string'
				or (v_window ->> 'resetAt')::timestamptz not between v_observed - interval '1 day' and v_observed + interval '366 days') then
				raise exception 'Account usage reset invalid' using errcode = '22023'; end if;
		end loop;
		if (select count(distinct value ->> 'id') from jsonb_array_elements(p_provider_account_usage -> 'windows'))
			<> jsonb_array_length(p_provider_account_usage -> 'windows') then
			raise exception 'Duplicate usage window' using errcode = '22023'; end if;
	end if;
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_email,
		provider_account_usage, provider_account_identity)
	values (p_connection_id, p_connection_version, p_provider_account_email, p_provider_account_usage, p_provider_account_identity)
	on conflict (connection_id, connection_version) do update set
		provider_account_identity = coalesce(excluded.provider_account_identity, qorpera_native_provider_account_metadata.provider_account_identity),
		provider_account_email = coalesce(excluded.provider_account_email, qorpera_native_provider_account_metadata.provider_account_email),
		provider_account_usage = case when excluded.provider_account_usage is not null
			and (qorpera_native_provider_account_metadata.provider_account_usage is null
				or (excluded.provider_account_usage ->> 'observedAt')::timestamptz >= (qorpera_native_provider_account_metadata.provider_account_usage ->> 'observedAt')::timestamptz)
			then excluded.provider_account_usage else qorpera_native_provider_account_metadata.provider_account_usage end,
		checked_at = clock_timestamp();
	return true;
end
$$;

-- 8. The member's own reads and Sign out everywhere ------------------------------------------------------------------

-- The caller's account logins, for Settings: whether account logins are on, and for each login its kind, state, email,
-- how many companies use it, and its connections in this company (the cards that say "used in all your companies").
create function public.qorpera_list_account_model_logins(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Account model logins are unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.account-model-logins/v1',
		'enabled', public.qorpera_account_model_logins_enabled()
			and public.qorpera_company_account_vault(p_profile_id) is not null,
		'logins', coalesce((select jsonb_agg(jsonb_build_object(
				'loginId', login.id,
				'loginKind', login.login_kind,
				'status', login.status,
				'providerAccountEmail', login.provider_account_email,
				'createdAt', login.created_at,
				'companies', (select count(*) from public.qorpera_model_login_links as link
					join public.qorpera_native_credential_capsules as capsule on capsule.id = link.credential_capsule_id
					where link.login_id = login.id and capsule.status = 'active'),
				'connectionIds', coalesce((select jsonb_agg(distinct version.connection_id)
					from public.qorpera_model_login_links as link
					join public.qorpera_provider_connection_versions as version
						on version.credential_capsule_id = link.credential_capsule_id
					where link.login_id = login.id and link.profile_id = p_profile_id), '[]'::jsonb)
			) order by login.created_at, login.id)
			from public.qorpera_model_logins as login
			where login.owner_user_id = v_user and login.status <> 'revoked'), '[]'::jsonb)
	);
end
$$;
revoke all on function public.qorpera_list_account_model_logins(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_account_model_logins(uuid) to authenticated;

-- Sign out everywhere: the member ends their own account login. Every company's link is revoked as the member's
-- Disconnect does (the connection, its capsules and versions, its live leases), and the login is never handed out,
-- renewed or linked again. The next sign-in makes a new account login.
create function public.qorpera_sign_out_account_model_login(p_login_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user uuid := auth.uid();
	v_login public.qorpera_model_logins%rowtype;
	v_connections uuid[];
begin
	-- FOR UPDATE, not FOR NO KEY UPDATE: a concurrent link (qorpera_link_member_model_logins, FOR KEY SHARE) must wait
	-- for this sign-out and then see the login revoked, or this sign-out must wait for it and revoke its new link.
	select login.* into v_login from public.qorpera_model_logins as login
	where login.id = p_login_id and login.owner_user_id = v_user
	for update;
	if auth.role() is distinct from 'authenticated' or v_user is null or v_login.id is null then
		raise exception 'Account model login is unavailable' using errcode = '42501';
	end if;
	select coalesce(array_agg(distinct version.connection_id), '{}'::uuid[]) into v_connections
	from public.qorpera_model_login_links as link
	join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = link.credential_capsule_id
	join public.qorpera_provider_connections as connection on connection.id = version.connection_id
	where link.login_id = v_login.id and connection.owner_user_id = v_user and connection.profile_id = link.profile_id;
	update public.qorpera_provider_connections set status = 'revoked'
	where id = any(v_connections) and status <> 'revoked';
	update public.qorpera_native_credential_capsules
	set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp())
	where id in (select link.credential_capsule_id from public.qorpera_model_login_links as link
		where link.login_id = v_login.id) and status <> 'revoked';
	update public.qorpera_provider_connection_versions set authorization_state = 'revoked'
	where connection_id = any(v_connections) and authentication_mode = 'native_subscription'
		and authorization_state <> 'revoked';
	update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = statement_timestamp()
	where provider_connection_id = any(v_connections) and status = 'active';
	update public.qorpera_model_logins
	set status = 'revoked', renewal_token = null, renewal_until = null, updated_at = clock_timestamp()
	where id = v_login.id;
	return jsonb_build_object('schema', 'qorpera.account-model-login-sign-out/v1', 'loginId', v_login.id,
		'status', 'revoked', 'companies', cardinality(v_connections));
end
$$;
revoke all on function public.qorpera_sign_out_account_model_login(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_sign_out_account_model_login(uuid) to authenticated;
