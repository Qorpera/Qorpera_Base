-- 20260930771000 (Claude Code on the agent's home, slice C4b; lanes/agent-box-20261113/C4-WORKER-DESIGN.md §4 as the
-- lane's lead ruled it, 14 Nov 2026): the shared vault carries a member's sealed Claude sign-in (#1428,
-- 20260930564000) to ONE run of a Claude Code worker (20260930770000) and seals the credentials file back.
--
-- The founder's word for his own first test: our code may carry the sealed login files from the vault into the box's
-- folder for one run and seal the credentials file back. Nothing more: no program of ours renews a token, calls
-- Anthropic with it or reads it for its own use (the vault checks the files' shape only). Claude Code renews its own
-- token at start and replaces `.credentials.json`; the run host sends the file back when its bytes changed.
--
-- * Who may ask: the run host, for the run its binding names, through the company's broker authority on the shared
--   vault (the principal that sealed the login): the binding's exact native lease, as a run's Codex login is issued
--   (qorpera_model_login_run_binding); the run is the worker run of an active plain worker with harness claude-code;
--   the login is the one its dispatch recorded, of the member who asked; the member's Claude Code lease is this run's
--   (its wake is this run's, and it is live). Anything else is refused whole (42501) and names nothing.
-- * What the login must be now: active (a signed-out or replaced login answers SIGNED_OUT), and its member on the
--   Claude list with the sign-in open in this company (else NOT_OPEN): the run host tells the agent so in words.
-- * The seal-back is a compare-and-swap on the version and envelope the run opened: the version goes up by one; a stale
--   swap answers `stale` and the newer envelope stays; a repeat of a saved seal (a lost answer) answers it again.
-- * The vault seals each version under the member's key with the version in the envelope's identity, as the sign-in
--   sealed version 1 (qorpera_complete_claude_login_sign_in): the column `version` is new, 1 for every login so far.
--
-- Every new body names this migration (20260930771000).

set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_open_claude_login_for_run(uuid,text,jsonb)') is not null then
		raise exception 'A Claude login for a run (20260930771000) is already applied'; end if;
	if to_regclass('public.qorpera_claude_worker_leases') is null then
		raise exception 'A Claude login for a run (20260930771000) needs 20260930770000 first'; end if;
end $$;

alter table public.qorpera_claude_logins add column version bigint not null default 1 check (version >= 1);

-- The run's Claude login (any status) after every check of who asks; the row locked for a seal-back.
create function public.qorpera_claude_login_run(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_lock boolean)
returns public.qorpera_claude_logins
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
	v_claude public.qorpera_claude_worker_leases%rowtype;
begin
	-- 20260930771000.
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs run where run.id = v_lease.run_id;
	v_worker := public.qorpera_run_worker(v_run.id);
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	if p_lock then
		select login.* into v_login from public.qorpera_claude_logins login where login.id = v_worker.claude_login_id for update;
	else
		select login.* into v_login from public.qorpera_claude_logins login where login.id = v_worker.claude_login_id;
	end if;
	select lease.* into v_claude from public.qorpera_claude_worker_leases lease
	where lease.owner_user_id = v_worker.requested_by_user_id;
	if v_run.id is null or v_run.profile_id is distinct from v_authority.profile_id
		or v_worker.id is null or v_worker.species is distinct from 'in-house'
		or v_worker.harness is distinct from 'claude-code' or v_worker.state is distinct from 'active'
		or v_principal.id is null or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_principal.id
		or v_login.id is null or v_login.principal_id is distinct from v_principal.id
		or v_login.owner_user_id is distinct from v_worker.requested_by_user_id
		or v_claude.owner_user_id is null or v_claude.worker_id is distinct from v_worker.id
		or v_claude.wake_id is distinct from v_worker.occurrence_id
		or not exists (select 1 from public.qorpera_wake_occurrences wake where wake.id = v_claude.wake_id
			and wake.run_id = v_run.id)
		or not public.qorpera_claude_worker_lease_live(v_claude) then
		raise exception 'Claude login is unavailable to this run' using errcode = '42501';
	end if;
	return v_login;
end $$;
revoke all on function public.qorpera_claude_login_run(uuid, text, jsonb, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Why the run's login cannot be used now, as a code the run host turns into words; null when it can.
create function public.qorpera_claude_login_run_refusal(p_login public.qorpera_claude_logins, p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930771000.
	select case
		when p_login.status <> 'active' then 'SIGNED_OUT'
		when not public.qorpera_claude_sign_in_open(p_profile_id, p_login.owner_user_id) then 'NOT_OPEN'
	end
$$;
revoke all on function public.qorpera_claude_login_run_refusal(public.qorpera_claude_logins, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The run's Claude login as the vault opens it: the sealed files with their digest, the member and key to open them
-- with, and the version in their identity; or a refusal the run host turns into words.
create function public.qorpera_open_claude_login_for_run(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_login public.qorpera_claude_logins%rowtype; v_refusal text;
begin
	-- 20260930771000.
	v_login := public.qorpera_claude_login_run(p_broker_authority_id, p_broker_capability_sha256, p_binding, false);
	v_refusal := public.qorpera_claude_login_run_refusal(v_login,
		(select authority.profile_id from public.qorpera_cloud_secret_broker_authorities authority
			where authority.id = p_broker_authority_id));
	if v_refusal is not null then
		return jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'refused', 'reason', v_refusal);
	end if;
	return jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'open',
		'claudeLoginId', v_login.id, 'ownerUserId', v_login.owner_user_id, 'keyId', v_login.key_id,
		'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_login.encrypted_envelope, 'base64'));
end $$;

-- The same without the sealed files: what the vault seals a seal-back for.
create function public.qorpera_describe_claude_login_for_run(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_login public.qorpera_claude_logins%rowtype; v_refusal text;
begin
	-- 20260930771000.
	v_login := public.qorpera_claude_login_run(p_broker_authority_id, p_broker_capability_sha256, p_binding, false);
	v_refusal := public.qorpera_claude_login_run_refusal(v_login,
		(select authority.profile_id from public.qorpera_cloud_secret_broker_authorities authority
			where authority.id = p_broker_authority_id));
	if v_refusal is not null then
		return jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'refused', 'reason', v_refusal);
	end if;
	return jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'described',
		'claudeLoginId', v_login.id, 'ownerUserId', v_login.owner_user_id, 'keyId', v_login.key_id,
		'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256);
end $$;

-- The credentials Claude Code renewed during the run, sealed by the vault under the member's key as version
-- p_base_version + 1, replacing the version the run opened: a compare-and-swap on that version and its envelope.
create function public.qorpera_seal_claude_login_back(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_claude_login_id uuid, p_base_version bigint, p_base_envelope_sha256 text, p_key_id text,
	p_encrypted_envelope_base64 text, p_envelope_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare v_login public.qorpera_claude_logins%rowtype; v_refusal text; v_envelope bytea;
begin
	-- 20260930771000.
	if p_claude_login_id is null or p_base_version is null or p_base_version < 1
		or coalesce(p_base_envelope_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_key_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000 then
		raise exception 'Claude login seal-back is invalid' using errcode = '22023'; end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'Claude login seal-back is invalid' using errcode = '22023'; end if;
	-- The row stays locked to this transaction's end: two seal-backs of one login queue here.
	v_login := public.qorpera_claude_login_run(p_broker_authority_id, p_broker_capability_sha256, p_binding, true);
	if v_login.id is distinct from p_claude_login_id then
		raise exception 'Claude login is unavailable to this run' using errcode = '42501'; end if;
	v_refusal := public.qorpera_claude_login_run_refusal(v_login,
		(select authority.profile_id from public.qorpera_cloud_secret_broker_authorities authority
			where authority.id = p_broker_authority_id));
	if v_refusal is not null then
		return jsonb_build_object('schema', 'qorpera.claude-login-seal/v1', 'state', 'refused', 'reason', v_refusal);
	end if;
	if p_key_id is distinct from v_login.key_id then
		raise exception 'Claude login seal-back is invalid' using errcode = '22023'; end if;
	-- A repeat of the seal this call made (its answer was lost).
	if v_login.version = p_base_version + 1 and v_login.envelope_sha256 = p_envelope_sha256 then
		return jsonb_build_object('schema', 'qorpera.claude-login-seal/v1', 'state', 'sealed', 'claudeLoginId', v_login.id,
			'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256);
	end if;
	-- Another seal came first: the newer envelope stays.
	if v_login.version <> p_base_version or v_login.envelope_sha256 <> p_base_envelope_sha256 then
		return jsonb_build_object('schema', 'qorpera.claude-login-seal/v1', 'state', 'stale', 'claudeLoginId', v_login.id,
			'version', v_login.version);
	end if;
	update public.qorpera_claude_logins
	set encrypted_envelope = v_envelope, envelope_sha256 = p_envelope_sha256, version = version + 1
	where id = v_login.id and status = 'active' and version = p_base_version and envelope_sha256 = p_base_envelope_sha256
	returning * into v_login;
	return jsonb_build_object('schema', 'qorpera.claude-login-seal/v1', 'state', 'sealed', 'claudeLoginId', v_login.id,
		'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256);
end $$;

revoke all on function public.qorpera_open_claude_login_for_run(uuid, text, jsonb),
	public.qorpera_describe_claude_login_for_run(uuid, text, jsonb),
	public.qorpera_seal_claude_login_back(uuid, text, jsonb, uuid, bigint, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_open_claude_login_for_run(uuid, text, jsonb),
	public.qorpera_describe_claude_login_for_run(uuid, text, jsonb),
	public.qorpera_seal_claude_login_back(uuid, text, jsonb, uuid, bigint, text, text, text, text)
	to qorpera_secret_broker;
