-- Stateless Compute step 1, vault upkeep (founder decision 2026-09-28, "Vault Move Clean-up"): a member's
-- old node Codex login is switched off by itself once the member has signed in to the vault with the same
-- ChatGPT account.
--
-- A member moves by signing in again; the web client makes a new connection for every sign-in, so the old
-- node login stayed on beside the vault login and kept the member tied to a node. Every few minutes each
-- company's broker now:
--   1. records the ChatGPT account of each vault login it keeps that has none yet (the digest nodes and the
--      vault already record for usage: sha256 of 'openai-account:' || account_id; a login's account never
--      changes, since a renewal must keep it);
--   2. finds, while the company takes new sign-ins in the vault, each active node Codex connection of the
--      same member that is older than the member's vault connection and whose recorded account is the same;
--   3. moves every sponsor binding that pays with it to the vault connection (qorpera_move_member_login_pins,
--      20260928231000: routines, coding sessions and agent work follow the member's live login);
--   4. once no queued or leased job, live lease, queued wake or queued turn still names the old login,
--      revokes it exactly as the member's own Disconnect does (qorpera_revoke_native_provider_connection).
-- Another account, another member's login, a Claude login, a node login newer than the vault login and a
-- company switched back to node sign-ins are left alone. A busy row makes the pair wait for the next pass.
-- Locks: rows only (the move's own row locks, taken without waiting; the old connection row, taken without
-- waiting; then the rows Disconnect updates). No company-wide lock.
set local lock_timeout = '10s';

alter table public.qorpera_model_logins
	add column account_identity text check (account_identity is null or account_identity ~ '^[0-9a-f]{64}$');

-- The broker's logins that have no recorded account yet, with their current version to read it from.
create function public.qorpera_model_logins_without_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_logins jsonb;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	select coalesce(jsonb_agg(jsonb_build_object(
			'loginId', missing.id,
			'companyId', missing.profile_id,
			'computeIdentityId', missing.compute_identity_id,
			'version', missing.version,
			'keyId', missing.key_id,
			'encryptedEnvelopeBase64', encode(missing.encrypted_envelope, 'base64'),
			'envelopeSha256', missing.envelope_sha256
		) order by missing.created_at, missing.id), '[]'::jsonb)
	into v_logins
	from (
		select login.id, login.profile_id, login.compute_identity_id, login.created_at, version.version,
			version.key_id, version.encrypted_envelope, version.envelope_sha256
		from public.qorpera_model_logins as login
		join public.qorpera_model_login_versions as version
			on version.login_id = login.id and version.version = login.current_version
		where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
			and login.status = 'active' and login.account_identity is null
		order by login.created_at, login.id
		limit 8
	) as missing;
	return jsonb_build_object('schema', 'qorpera.model-login-accounts/v1', 'logins', v_logins);
end
$$;

-- Records a vault login's account once. A repeat with the same account is answered as recorded; another
-- account for a recorded login is refused.
create function public.qorpera_record_model_login_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_account_identity text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_recorded text;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or coalesce(p_account_identity, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login account is invalid' using errcode = '22023';
	end if;
	update public.qorpera_model_logins set account_identity = p_account_identity
	where id = p_login_id and broker_authority_id = v_authority.id and account_identity is null;
	select account_identity into v_recorded from public.qorpera_model_logins
	where id = p_login_id and broker_authority_id = v_authority.id;
	if v_recorded is null then
		raise exception 'model login is unavailable to this broker' using errcode = '42501';
	end if;
	if v_recorded <> p_account_identity then
		raise exception 'model login account differs from the recorded one' using errcode = '22023';
	end if;
	return jsonb_build_object('schema', 'qorpera.model-login-account/v1', 'loginId', p_login_id, 'recorded', true);
end
$$;

-- One switch-off pass for this broker's company (see the header). At most four old logins per pass.
create function public.qorpera_switch_off_replaced_node_logins(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_pair record;
	v_move jsonb;
	v_switched integer := 0;
	v_waiting integer := 0;
	v_refused integer := 0;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	-- A company switched back to node sign-ins keeps its node logins.
	if exists (select 1 from public.qorpera_model_login_sign_in_companies where profile_id = v_authority.profile_id) then
		for v_pair in
			select distinct on (node.id) node.id as old_connection_id, vault_connection.id as new_connection_id,
				vault_connection.owner_user_id as member_id
			from public.qorpera_model_logins as login
			join public.qorpera_native_credential_capsules as pointer on pointer.id = login.credential_capsule_id
			join public.qorpera_provider_connection_versions as vault_version on vault_version.credential_capsule_id = pointer.id
			join public.qorpera_provider_connections as vault_connection on vault_connection.id = vault_version.connection_id
			join public.qorpera_provider_connections as node on node.profile_id = vault_connection.profile_id
				and node.owner_user_id = vault_connection.owner_user_id and node.id <> vault_connection.id
			join lateral (
				select version.* from public.qorpera_provider_connection_versions as version
				where version.connection_id = node.id order by version.version desc limit 1
			) as node_version on true
			join public.qorpera_native_credential_capsules as node_capsule on node_capsule.id = node_version.credential_capsule_id
			where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
				and login.status = 'active' and login.account_identity is not null
				and pointer.status = 'active' and pointer.encrypted_capsule_reference = 'model-login/' || login.id::text
				and vault_connection.status = 'active' and vault_connection.profile_id = login.profile_id
				and vault_connection.owner_user_id is not null
				and vault_version.authorization_state = 'active'
				and vault_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
					where latest.connection_id = vault_connection.id)
				and node.status = 'active' and node.provider = 'openai' and node.created_at < vault_connection.created_at
				and node_version.authentication_mode = 'native_subscription' and node_version.native_harness = 'codex-cli'
				and node_version.authorization_state = 'active'
				and node_capsule.status = 'active' and node_capsule.encrypted_capsule_reference !~ '^model-login/'
				and exists (select 1 from public.qorpera_native_provider_account_metadata as seen
					where seen.connection_id = node.id and seen.provider_account_identity = login.account_identity)
			order by node.id, vault_connection.created_at desc, vault_connection.id
			limit 4
		loop
			-- New work follows the member's vault login first; the move changes nothing when it refuses.
			begin
				v_move := public.qorpera_move_member_login_pins(v_authority.profile_id, v_pair.member_id,
					v_pair.old_connection_id, v_pair.new_connection_id);
			exception when invalid_parameter_value then
				v_move := jsonb_build_object('status', 'refused', 'reason', 'invalid');
			end;
			if v_move ->> 'status' is distinct from 'moved' then
				v_refused := v_refused + 1;
				continue;
			end if;
			-- Work that still names the old login finishes on it first.
			if exists (
					select 1 from public.qorpera_runner_jobs as job
					join public.qorpera_execution_runs as run on run.id = job.run_id
					join public.qorpera_execution_sponsor_versions as sponsor
						on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
					where job.profile_id = v_authority.profile_id and job.status in ('queued', 'leased')
						and sponsor.provider_connection_id = v_pair.old_connection_id)
				or exists (
					select 1 from public.qorpera_native_provider_connection_leases as lease
					where lease.provider_connection_id = v_pair.old_connection_id and lease.status = 'active'
						and lease.expires_at > clock_timestamp())
				or exists (
					select 1 from public.qorpera_wake_occurrences as occurrence
					join public.qorpera_execution_sponsor_versions as sponsor
						on sponsor.binding_id = occurrence.sponsor_binding_id and sponsor.version = occurrence.sponsor_version
					where occurrence.status = 'queued' and occurrence.profile_id = v_authority.profile_id
						and sponsor.provider_connection_id = v_pair.old_connection_id)
				or exists (
					select 1 from public.qorpera_session_turn_requests as request
					join public.qorpera_execution_sponsor_versions as sponsor
						on sponsor.binding_id = request.sponsor_binding_id and sponsor.version = request.sponsor_version
					where request.status = 'queued' and request.profile_id = v_authority.profile_id
						and sponsor.provider_connection_id = v_pair.old_connection_id) then
				v_waiting := v_waiting + 1;
				continue;
			end if;
			-- A row another transaction holds makes the pair wait for the next pass.
			begin
				perform 1 from public.qorpera_provider_connections
				where id = v_pair.old_connection_id and status = 'active' for update nowait;
				if not found then
					continue;
				end if;
			exception when lock_not_available then
				v_waiting := v_waiting + 1;
				continue;
			end;
			-- The member's own Disconnect (qorpera_revoke_native_provider_connection), statement for statement;
			-- the connection's status trigger fails any job that still names it (none, checked above).
			update public.qorpera_provider_connections set status = 'revoked' where id = v_pair.old_connection_id;
			update public.qorpera_native_credential_capsules
			set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp())
			where id in (
				select version.credential_capsule_id from public.qorpera_provider_connection_versions as version
				where version.connection_id = v_pair.old_connection_id
					and version.authentication_mode = 'native_subscription' and version.credential_capsule_id is not null
			) and status <> 'revoked';
			update public.qorpera_provider_connection_versions set authorization_state = 'revoked'
			where connection_id = v_pair.old_connection_id and authentication_mode = 'native_subscription'
				and authorization_state <> 'revoked';
			update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = statement_timestamp()
			where provider_connection_id = v_pair.old_connection_id and status = 'active';
			v_switched := v_switched + 1;
		end loop;
	end if;
	return jsonb_build_object('schema', 'qorpera.model-login-switch-off/v1', 'switchedOff', v_switched,
		'waiting', v_waiting, 'refused', v_refused);
end
$$;

revoke all on function public.qorpera_model_logins_without_account(uuid,text),
	public.qorpera_record_model_login_account(uuid,text,uuid,text),
	public.qorpera_switch_off_replaced_node_logins(uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_model_logins_without_account(uuid,text),
	public.qorpera_record_model_login_account(uuid,text,uuid,text),
	public.qorpera_switch_off_replaced_node_logins(uuid,text)
	to qorpera_secret_broker;
