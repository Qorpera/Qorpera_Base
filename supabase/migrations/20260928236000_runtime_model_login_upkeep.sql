-- Stateless Compute step 1, vault upkeep (founder decision 2026-09-28, "Vault Move Clean-up"):
-- the vault renews idle logins itself.
--
-- Until now only a starting run renewed a login, once its pass was half used, so a login nobody
-- used could lapse. Every few minutes each company's broker takes the renewal lock of one due
-- login at a time, with the same conditions a run's renewal uses (past half its pass, no renewal
-- running, the failure back-off passed), renews it through the helper and saves the next version
-- with the existing commit and release. Only a login still behind an active pointer that an
-- active version of an active connection uses is renewed: one the member disconnected, or whose
-- member left, is left to lapse. The lock is the login's own row; nothing else is locked.

-- Each broker looks for its company's due logins on every pass.
create index qorpera_model_logins_broker_due
	on public.qorpera_model_logins(broker_authority_id, access_expires_at)
	where status = 'active';

-- Takes one login's renewal lock when a run's renewal could: active, past half its pass, no renewal
-- running (or only a lapsed one), and the back-off after failures passed (1, 2, 4 ... minutes, at most
-- an hour). One conditional update of the login's own row; under read committed a concurrent run's lock
-- is seen by the update itself, so two holders are impossible. Returns the new token, or null.
create function public.qorpera_model_login_take_idle_lock(p_login_id uuid, p_broker_authority_id uuid)
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
		and v_now >= login.access_issued_at + (login.access_expires_at - login.access_issued_at) / 2
		and (login.renewal_until is null or login.renewal_until < v_now)
		and (login.renewal_failed_at is null or login.renewal_failed_at <= v_now
			- least(interval '1 minute' * power(2, least(login.renewal_failures, 7) - 1), interval '1 hour'))
	returning login.renewal_token into v_token;
	return v_token;
end
$$;
revoke all on function public.qorpera_model_login_take_idle_lock(uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Takes the renewal lock of this broker's most urgent idle login and hands it over with its
-- current version, exactly as a run's issue does with a renewal; `renewal` is null when no login
-- is due. Only a login behind an active pointer that an active version of an active connection of
-- its company uses is a candidate. Nothing but the login's own row is locked.
create function public.qorpera_take_idle_model_login_renewal(
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
			and v_now >= login.access_issued_at + (login.access_expires_at - login.access_issued_at) / 2
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

revoke all on function public.qorpera_take_idle_model_login_renewal(uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_take_idle_model_login_renewal(uuid,text) to qorpera_secret_broker;
