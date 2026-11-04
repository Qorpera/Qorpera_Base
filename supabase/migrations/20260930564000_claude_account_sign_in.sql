-- Claude sign-in through the shared vault (founder, 4 Nov 2026: "Build Claude sign-in").
--
-- Until now a Claude sign-in took the old per-node path: a login machine on the member's compute identity. That path
-- never finished. A login machine is refused while any run of the same identity is live (COMPUTE_IDENTITY_OCCUPIED,
-- and a member's agents run almost all the time), the login guest's bootstrap failed when one was admitted (31 Oct),
-- and Anthropic's sign-in asks the member to paste a code back, which nothing could carry. ChatGPT sign-ins left that
-- path for the vault on 28 Sep. Claude now follows them, as an account sign-in only:
--
-- * Who: the members on qorpera_claude_sign_in_members (empty here; the operator adds the founder), while account
--   logins are switched on and the company is served by the shared vault. Anthropic's written confirmation is still
--   owed, so nobody else can begin one. A Claude sign-in any other way is refused when it begins (42501).
-- * Begin: qorpera_begin_native_provider_login with provider 'anthropic' and harness 'claude-code', as before. The
--   scope trigger marks the sign-in model_login_kind 'claude', scope 'account'; the login gateway chooser sends it to
--   the company's vault; the v2 read names it (loginKind 'claude'). A vault build without this change refuses it.
--   A Claude sign-in never gets a login machine (a guard on the machine requests).
-- * The vault's helper runs the official, unmodified Claude Code (`claude auth login --claudeai`) in its sandbox. The
--   member opens Anthropic's page, signs in there and pastes Anthropic's code into Qorpera's page; the vault writes it
--   once to Claude Code's input. Claude Code exchanges it itself and writes its own login files.
-- * Keep: the vault seals those files, unread, under the member's key and completes the sign-in with
--   qorpera_complete_claude_login_sign_in into qorpera_claude_logins: one row per member, no company rows, no provider
--   connection, no capsule, no sponsor. Nothing that picks, renews, reads usage of or issues model logins reads this
--   table, so a Claude login can never pay for an agent's chat, routine or company work: Claude subscriptions are for
--   coding sessions only (2026-09-24), and the coding harness that will open it is a later change.
-- * A newer Claude sign-in of the same member replaces the older login (one Claude subscription per member).
-- * The member lists their Claude login (qorpera_list_claude_logins) and signs it out (qorpera_sign_out_claude_login),
--   which wipes the sealed files.

set local lock_timeout = '3s';

-- 1. Who may sign in with Claude ----------------------------------------------------------------------------------------

create table public.qorpera_claude_sign_in_members (
	user_id uuid primary key references auth.users(id) on delete cascade,
	added_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_claude_sign_in_members enable row level security;
revoke all on public.qorpera_claude_sign_in_members
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether this member may begin a Claude sign-in in this company: on the list, account logins switched on, the company
-- served by the shared vault and taking sign-ins there.
create function public.qorpera_claude_sign_in_open(p_profile_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select p_profile_id is not null and p_user_id is not null
		and exists (select 1 from public.qorpera_claude_sign_in_members as member where member.user_id = p_user_id)
		and public.qorpera_account_model_logins_enabled()
		and public.qorpera_company_account_vault(p_profile_id) is not null
		and public.qorpera_model_login_sign_in_url(p_profile_id) is not null
$$;
revoke all on function public.qorpera_claude_sign_in_open(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Claude logins --------------------------------------------------------------------------------------------------------

create table public.qorpera_claude_logins (
	id uuid primary key,
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	principal_id uuid not null references public.qorpera_cloud_secret_broker_principals(id) on delete restrict,
	-- The sign-in it came from; deleting the company that sign-in began in keeps the member's login.
	sign_in_session_id uuid unique references public.qorpera_native_provider_login_sessions(id) on delete set null,
	client_connection_id uuid not null,
	key_id text check (key_id is null or key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	encrypted_envelope bytea check (encrypted_envelope is null or octet_length(encrypted_envelope) between 1 and 131072),
	envelope_sha256 text check (envelope_sha256 is null or envelope_sha256 ~ '^[0-9a-f]{64}$'),
	provider_account_reference text check (provider_account_reference is null
		or (char_length(btrim(provider_account_reference)) between 1 and 512 and provider_account_reference !~ E'[\r\n]')),
	provider_account_email text check (provider_account_email is null
		or (char_length(btrim(provider_account_email)) between 3 and 254 and provider_account_email !~ E'[\r\n]')),
	status text not null default 'active' check (status in ('active', 'revoked')),
	created_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	-- A signed-out login keeps no sealed files.
	check ((status = 'active') = (encrypted_envelope is not null and envelope_sha256 is not null and key_id is not null
		and revoked_at is null))
);
create unique index qorpera_claude_logins_one_active on public.qorpera_claude_logins(owner_user_id)
	where status = 'active';
alter table public.qorpera_claude_logins enable row level security;
revoke all on public.qorpera_claude_logins from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The sign-in's kind and scope -----------------------------------------------------------------------------------------

alter table public.qorpera_native_provider_login_sessions
	drop constraint qorpera_native_provider_login_sessions_model_login_kind_check,
	add constraint qorpera_native_provider_login_sessions_model_login_kind_check
		check (model_login_kind in ('codex', 'chatgpt_plan', 'claude')),
	drop constraint qorpera_login_sessions_account_scope_codex,
	add constraint qorpera_login_sessions_account_scope_codex
		check (model_login_scope = 'company' or model_login_kind in ('codex', 'claude')),
	-- Older Claude sign-ins (the per-node path, all ended) keep kind 'codex'; the trigger below marks every new one.
	add constraint qorpera_login_sessions_claude_account check (model_login_kind <> 'claude'
		or (provider = 'anthropic' and native_harness = 'claude-code' and model_login_scope = 'account'));

create or replace function public.qorpera_model_login_session_scope()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'INSERT' then
		-- 20260930564000: a Claude sign-in is an account sign-in in the vault, for the members allowed one, or nothing.
		if new.provider = 'anthropic' or new.native_harness = 'claude-code' then
			if new.provider is distinct from 'anthropic' or new.native_harness is distinct from 'claude-code'
				or not public.qorpera_claude_sign_in_open(new.profile_id, new.requested_by_user_id)
				or not exists (select 1 from public.qorpera_member_compute_identities as identity
					where identity.id = new.compute_identity_id and identity.profile_id = new.profile_id
						and identity.status = 'active' and identity.ownership_kind = 'member'
						and identity.owner_user_id = new.requested_by_user_id) then
				raise exception 'Claude sign-in is not available here' using errcode = '42501';
			end if;
			new.model_login_kind := 'claude';
			new.model_login_scope := 'account';
			return new;
		end if;
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
	elsif old.model_login_kind = 'claude' or new.model_login_kind = 'claude' then
		-- A Claude sign-in stays one, and nothing becomes one after it began.
		if new.model_login_kind is distinct from old.model_login_kind then
			raise exception 'A sign-in keeps its kind' using errcode = '42501';
		end if;
		new.model_login_scope := old.model_login_scope;
	elsif new.model_login_kind is distinct from 'codex' then
		new.model_login_scope := 'company';
	else
		new.model_login_scope := old.model_login_scope;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_model_login_session_scope() from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A Claude sign-in never gets a login machine (the old per-node path), whichever gateway a request reaches.
create function public.qorpera_claude_sign_in_machine_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_native_provider_login_sessions as session
		where session.id = new.login_session_id and session.model_login_kind = 'claude') then
		raise exception 'A Claude sign-in is kept by the vault, not a login machine' using errcode = '42501';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_claude_sign_in_machine_guard()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_claude_sign_in_machine_guard
	before insert on public.qorpera_runtime_login_machine_requests
	for each row execute function public.qorpera_claude_sign_in_machine_guard();

-- 4. The login gateway chooser sends a Claude sign-in to its company's vault ---------------------------------------------

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_runtime_login_gateway_choose(text)'::regprocedure);
	v_anchor text := E'v_session.provider = ''openai'' and v_session.native_harness = ''codex-cli''\n'
		|| E'\t\tand public.qorpera_model_login_sign_in_url(v_session.profile_id) is not null then';
	v_count integer;
begin
	if position('20260930564000' in v_definition) = 0 then
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Login gateway chooser source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			E'(v_session.model_login_kind = ''claude'' -- 20260930564000: Claude sign-ins are the vault''s\n'
			|| E'\t\t\tor (v_session.provider = ''openai'' and v_session.native_harness = ''codex-cli''))\n'
			|| E'\t\tand public.qorpera_model_login_sign_in_url(v_session.profile_id) is not null then');
	end if;
end
$$;

-- 5. The vault's read of a sign-in names a Claude sign-in ----------------------------------------------------------------

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
	-- 20260930564000: a Claude sign-in is read by the shared vault only, while its member may still sign in.
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id
		or not ((v_session.provider = 'openai' and v_session.native_harness = 'codex-cli')
			or (v_session.model_login_kind = 'claude' and v_authority.principal_id is not null
				and public.qorpera_claude_sign_in_open(v_session.profile_id, v_session.requested_by_user_id)))
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
		'modelLoginId', case when v_session.model_login_kind = 'claude'
			then (select claude.id from public.qorpera_claude_logins as claude where claude.sign_in_session_id = v_session.id)
			else (select vault.id from public.qorpera_model_logins as vault where vault.sign_in_session_id = v_session.id) end
	) || case when v_session.model_login_scope = 'account' then jsonb_build_object('scope', 'account')
		else '{}'::jsonb end;
end
$$;

-- 6. The vault completes a Claude sign-in ---------------------------------------------------------------------------------

-- The login files Claude Code wrote, sealed by the shared vault under the member's key, become the member's Claude login.
-- Their older Claude login (if any) is signed out. A repeat after a lost answer finds its own login.
create function public.qorpera_complete_claude_login_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text,
	p_claude_login_id uuid,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
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
	v_existing public.qorpera_claude_logins%rowtype;
	v_envelope bytea;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	if v_principal.id is null then
		raise exception 'Claude logins are kept by the shared vault' using errcode = '42501';
	end if;
	if p_login_id is null or p_claude_login_id is null
		or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_key_id is distinct from v_principal.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or (p_provider_account_reference is not null
			and char_length(btrim(p_provider_account_reference)) not between 1 and 512)
		or (p_provider_account_email is not null
			and char_length(btrim(p_provider_account_email)) not between 3 and 254) then
		raise exception 'Claude sign-in completion is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'Claude sign-in completion is invalid' using errcode = '22023';
	end if;
	select session.* into v_session from public.qorpera_native_provider_login_sessions as session
	where session.id = p_login_id
	for update;
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id or v_session.model_login_kind <> 'claude' then
		raise exception 'Claude sign-in is unavailable' using errcode = '42501';
	end if;
	select claude.* into v_existing from public.qorpera_claude_logins as claude
	where claude.sign_in_session_id = v_session.id;
	if v_existing.id is not null then
		if v_existing.id <> p_claude_login_id or v_existing.envelope_sha256 is distinct from p_envelope_sha256 then
			raise exception 'Claude sign-in is already complete' using errcode = '55000';
		end if;
	else
		if v_session.status <> 'pending' or v_session.expires_at <= statement_timestamp()
			or not public.qorpera_claude_sign_in_open(v_session.profile_id, v_session.requested_by_user_id) then
			raise exception 'Claude sign-in is unavailable' using errcode = '55000';
		end if;
		select identity.* into strict v_identity
		from public.qorpera_member_compute_identities as identity
		where identity.id = v_session.compute_identity_id and identity.profile_id = v_session.profile_id
			and identity.status = 'active';
		if v_identity.ownership_kind <> 'member' or v_identity.owner_user_id is distinct from v_session.requested_by_user_id then
			raise exception 'A Claude login belongs to one member' using errcode = '42501';
		end if;
		update public.qorpera_claude_logins
		set status = 'revoked', revoked_at = statement_timestamp(), key_id = null, encrypted_envelope = null,
			envelope_sha256 = null
		where owner_user_id = v_identity.owner_user_id and status = 'active';
		insert into public.qorpera_claude_logins (
			id, owner_user_id, principal_id, sign_in_session_id, client_connection_id, key_id, encrypted_envelope,
			envelope_sha256, provider_account_reference, provider_account_email
		) values (
			p_claude_login_id, v_identity.owner_user_id, v_principal.id, v_session.id, v_session.client_connection_id,
			p_key_id, v_envelope, p_envelope_sha256, nullif(btrim(p_provider_account_reference), ''),
			nullif(btrim(p_provider_account_email), '')
		);
		update public.qorpera_native_provider_login_sessions
		set status = 'completed', completed_at = statement_timestamp()
		where id = v_session.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.claude-sign-in-complete/v1', 'loginId', v_session.id,
		'claudeLoginId', p_claude_login_id);
end
$$;
revoke all on function public.qorpera_complete_claude_login_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_claude_login_sign_in(
	uuid, text, uuid, text, uuid, text, text, text, text, text)
	to qorpera_secret_broker;

-- 7. The member's own Claude login ----------------------------------------------------------------------------------------

-- Whether the member may sign in with Claude in this company, and their Claude login. Never the sealed files.
create function public.qorpera_list_claude_logins(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Claude logins are unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.claude-logins/v1',
		'signInOpen', public.qorpera_claude_sign_in_open(p_profile_id, v_user),
		'logins', coalesce((select jsonb_agg(jsonb_build_object(
				'loginId', claude.id,
				'providerAccountEmail', claude.provider_account_email,
				'createdAt', claude.created_at,
				'clientConnectionId', claude.client_connection_id
			) order by claude.created_at, claude.id)
			from public.qorpera_claude_logins as claude
			where claude.owner_user_id = v_user and claude.status = 'active'), '[]'::jsonb)
	);
end
$$;
revoke all on function public.qorpera_list_claude_logins(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_claude_logins(uuid) to authenticated;

-- Sign out: the member ends their own Claude login; its sealed files are wiped.
create function public.qorpera_sign_out_claude_login(p_login_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user uuid := auth.uid();
	v_login public.qorpera_claude_logins%rowtype;
begin
	select claude.* into v_login from public.qorpera_claude_logins as claude
	where claude.id = p_login_id and claude.owner_user_id = v_user
	for update;
	if auth.role() is distinct from 'authenticated' or v_user is null or v_login.id is null then
		raise exception 'Claude login is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_claude_logins
	set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp()), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null
	where id = v_login.id and status = 'active';
	return jsonb_build_object('schema', 'qorpera.claude-login-sign-out/v1', 'loginId', v_login.id, 'status', 'revoked');
end
$$;
revoke all on function public.qorpera_sign_out_claude_login(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_sign_out_claude_login(uuid) to authenticated;
