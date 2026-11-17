set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_claude_parallel_runs') is not null then
		raise exception 'Claude parallel runs (20260930790000) are already applied'; end if;
	if to_regprocedure('public.qorpera_claude_login_opened(uuid,text,jsonb,boolean)') is null
		or to_regprocedure('public.qorpera_claude_worker_resolve(uuid,uuid,uuid)') is null then
		raise exception 'Claude parallel runs (20260930790000) need 20260930771000 and 20260930787000 first'; end if;
end $$;

create table public.qorpera_claude_parallel_runs (
	only_row boolean primary key default true check (only_row),
	cap smallint not null default 1 check (cap between 1 and 16)
);
insert into public.qorpera_claude_parallel_runs(only_row, cap) values (true, 1);
alter table public.qorpera_claude_parallel_runs enable row level security;
revoke all on public.qorpera_claude_parallel_runs from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claude_worker_run_cap()
returns integer language sql stable security definer set search_path = '' as $$
	select coalesce((select runs.cap from public.qorpera_claude_parallel_runs runs where runs.only_row), 1)::integer
$$;
revoke all on function public.qorpera_claude_worker_run_cap() from public, anon, authenticated, service_role,
	qorpera_secret_broker;

alter table public.qorpera_claude_worker_leases
	add column slot smallint not null default 1 check (slot between 1 and 16),
	drop constraint qorpera_claude_worker_leases_pkey,
	add primary key (owner_user_id, slot);

create or replace function public.qorpera_claude_worker_waits(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_worker.harness is not distinct from 'claude-code' and (select count(*)
		from public.qorpera_claude_worker_leases lease
		where lease.owner_user_id = p_worker.requested_by_user_id and public.qorpera_claude_worker_lease_live(lease))
		>= public.qorpera_claude_worker_run_cap()
$$;

create or replace function public.qorpera_claude_worker_lease_take(p_worker public.qorpera_runtime_workers, p_wake_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_taken uuid; v_cap integer := public.qorpera_claude_worker_run_cap(); v_slot integer;
begin
	if p_worker.harness is distinct from 'claude-code' or p_worker.requested_by_user_id is null or p_wake_id is null then
		raise exception 'Only a Claude Code worker takes a Claude Code lease' using errcode = '22023'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera_claude_worker_lease:' || p_worker.requested_by_user_id::text, 0));
	-- WHY: a cap lowered while more runs are live starts nothing until they are fewer, though a lower slot is free.
	if (select count(*) from public.qorpera_claude_worker_leases lease
		where lease.owner_user_id = p_worker.requested_by_user_id and public.qorpera_claude_worker_lease_live(lease)) >= v_cap then
		return false; end if;
	for v_slot in 1..v_cap loop
		insert into public.qorpera_claude_worker_leases as lease (owner_user_id, slot, worker_id, wake_id)
		values (p_worker.requested_by_user_id, v_slot, p_worker.id, p_wake_id)
		on conflict (owner_user_id, slot) do update set worker_id = excluded.worker_id, wake_id = excluded.wake_id,
			taken_at = clock_timestamp()
		where not public.qorpera_claude_worker_lease_live(lease)
		returning lease.wake_id into v_taken;
		if v_taken is not distinct from p_wake_id then return true; end if;
		v_taken := null;
	end loop;
	return false;
end $$;

create or replace function public.qorpera_claude_login_run(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_lock boolean, p_at_work boolean)
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
	where lease.owner_user_id = v_worker.requested_by_user_id and lease.worker_id = v_worker.id
		and lease.wake_id = v_worker.occurrence_id
	order by lease.slot limit 1;
	if v_run.id is null or v_run.profile_id is distinct from v_authority.profile_id
		or v_worker.id is null or v_worker.species is distinct from 'in-house'
		or v_worker.harness is distinct from 'claude-code' or (p_at_work and v_worker.state is distinct from 'active')
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

create function public.qorpera_open_claude_login_for_run(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_known_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
	if p_known_version is not null and p_known_version < 1 then
		raise exception 'Claude login version is invalid' using errcode = '22023'; end if;
	v := public.qorpera_claude_login_opened(p_broker_authority_id, p_broker_capability_sha256, p_binding, true);
	if v ->> 'state' = 'open' and (v ->> 'version')::bigint = p_known_version then
		return jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'current',
			'claudeLoginId', v ->> 'claudeLoginId', 'version', (v ->> 'version')::bigint);
	end if;
	return v;
end $$;

alter table public.qorpera_claude_logins
	add column renewal_token uuid,
	add column renewal_until timestamptz,
	add column checked_at timestamptz,
	add column renewed_at timestamptz,
	add column refused_version bigint,
	add column refused_at timestamptz,
	add column failed_at timestamptz,
	add column failures integer not null default 0 check (failures >= 0),
	add constraint qorpera_claude_logins_renewal_lock check ((renewal_token is null) = (renewal_until is null));

create function public.qorpera_claude_login_renewal_rested(p_login public.qorpera_claude_logins, p_now timestamptz)
returns boolean language sql immutable set search_path = '' as $$
	select p_login.failed_at is null or p_login.failed_at
		<= p_now - least(interval '1 minute' * power(2, least(p_login.failures, 7) - 1), interval '1 hour')
$$;
revoke all on function public.qorpera_claude_login_renewal_rested(public.qorpera_claude_logins, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claude_login_renewal_answer(p_login public.qorpera_claude_logins)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.claude-login-renewal/v1', 'claudeLoginId', p_login.id,
		'ownerUserId', p_login.owner_user_id, 'keyId', p_login.key_id, 'version', p_login.version,
		'envelopeSha256', p_login.envelope_sha256, 'encryptedEnvelopeBase64', encode(p_login.encrypted_envelope, 'base64'),
		'renewal', jsonb_build_object('token', p_login.renewal_token, 'baseVersion', p_login.version))
$$;
revoke all on function public.qorpera_claude_login_renewal_answer(public.qorpera_claude_logins)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_take_claude_login_renewal(p_principal_id uuid, p_capability_sha256 text,
	p_claude_login_id uuid, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_now timestamptz := clock_timestamp();
	v_login public.qorpera_claude_logins%rowtype;
	v_age interval;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	v_age := case p_purpose when 'open' then interval '30 seconds' when 'poll' then interval '90 seconds' end;
	if v_age is null or p_claude_login_id is null then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	update public.qorpera_claude_logins as login
	set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '2 minutes'
	where login.id = p_claude_login_id and login.principal_id = v_principal.id and login.status = 'active'
		and (login.renewal_until is null or login.renewal_until < v_now)
		and (login.checked_at is null or login.checked_at < v_now - v_age)
		and public.qorpera_claude_login_renewal_rested(login, v_now)
		and exists (select 1 from public.qorpera_claude_worker_leases lease
			where lease.owner_user_id = login.owner_user_id and public.qorpera_claude_worker_lease_live(lease))
	returning login.* into v_login;
	if v_login.id is null then
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal/v1', 'renewal', null,
			'busy', exists (select 1 from public.qorpera_claude_logins login where login.id = p_claude_login_id
				and login.principal_id = v_principal.id and login.status = 'active' and login.renewal_until >= v_now));
	end if;
	return public.qorpera_claude_login_renewal_answer(v_login);
end $$;

create function public.qorpera_take_idle_claude_login_renewal(p_principal_id uuid, p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_now timestamptz := clock_timestamp();
	v_candidate uuid;
	v_login public.qorpera_claude_logins%rowtype;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	for v_candidate in
		select login.id from public.qorpera_claude_logins login
		where login.principal_id = v_principal.id and login.status = 'active'
			and (login.renewal_until is null or login.renewal_until < v_now)
			and public.qorpera_claude_login_renewal_rested(login, v_now)
			and (login.checked_at is null or login.checked_at < v_now - interval '20 hours'
				or (login.refused_version = login.version and login.refused_at < v_now - interval '2 minutes'))
		order by login.checked_at nulls first, login.id
		limit 4
	loop
		update public.qorpera_claude_logins as login
		set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '2 minutes'
		where login.id = v_candidate and login.principal_id = v_principal.id and login.status = 'active'
			and (login.renewal_until is null or login.renewal_until < v_now)
			and public.qorpera_claude_login_renewal_rested(login, v_now)
			and (login.checked_at is null or login.checked_at < v_now - interval '20 hours'
				or (login.refused_version = login.version and login.refused_at < v_now - interval '2 minutes'))
		returning login.* into v_login;
		exit when v_login.id is not null;
	end loop;
	if v_login.id is null then
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal/v1', 'renewal', null); end if;
	return public.qorpera_claude_login_renewal_answer(v_login);
end $$;

create function public.qorpera_claude_login_renewal_locked(p_principal_id uuid, p_capability_sha256 text,
	p_claude_login_id uuid, p_token uuid)
returns public.qorpera_claude_logins
language plpgsql security definer set search_path = '' as $$
declare v_principal public.qorpera_cloud_secret_broker_principals%rowtype; v_login public.qorpera_claude_logins%rowtype;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_claude_login_id is null or p_token is null then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	select login.* into v_login from public.qorpera_claude_logins login
	where login.id = p_claude_login_id and login.principal_id = v_principal.id for update;
	if v_login.id is null then raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	if v_login.renewal_token is distinct from p_token then return null; end if;
	return v_login;
end $$;
revoke all on function public.qorpera_claude_login_renewal_locked(uuid, text, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_commit_claude_login_renewal(p_principal_id uuid, p_capability_sha256 text,
	p_claude_login_id uuid, p_token uuid, p_base_version bigint, p_base_envelope_sha256 text, p_key_id text,
	p_encrypted_envelope_base64 text, p_envelope_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare v_principal public.qorpera_cloud_secret_broker_principals%rowtype; v_login public.qorpera_claude_logins%rowtype;
	v_envelope bytea; v_now timestamptz := clock_timestamp();
begin
	if p_base_version is null or p_base_version < 1
		or coalesce(p_base_envelope_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_key_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000 then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	if p_claude_login_id is null or p_token is null then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	select login.* into v_login from public.qorpera_claude_logins login
	where login.id = p_claude_login_id and login.principal_id = v_principal.id for update;
	if v_login.id is null then raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	if v_login.status <> 'active' then
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal-commit/v1', 'state', 'refused',
			'reason', 'SIGNED_OUT'); end if;
	if p_key_id is distinct from v_login.key_id then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	if v_login.version <> p_base_version or v_login.envelope_sha256 <> p_base_envelope_sha256 then
		if v_login.renewal_token = p_token then
			update public.qorpera_claude_logins set renewal_token = null, renewal_until = null where id = v_login.id; end if;
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal-commit/v1', 'state', 'stale');
	end if;
	-- WHY: a renewal on the base it was taken from seals even after its lock passed to another host: its refresh token
	-- has rotated at Anthropic, so it is the only one that can work, and that host's later release answers stale.
	update public.qorpera_claude_logins
	set encrypted_envelope = v_envelope, envelope_sha256 = p_envelope_sha256, version = version + 1,
		renewal_token = null, renewal_until = null, checked_at = v_now, renewed_at = v_now,
		refused_version = null, refused_at = null, failed_at = null, failures = 0
	where id = v_login.id
	returning * into v_login;
	return jsonb_build_object('schema', 'qorpera.claude-login-renewal-commit/v1', 'state', 'sealed',
		'claudeLoginId', v_login.id, 'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256);
end $$;

create function public.qorpera_release_claude_login_renewal(p_principal_id uuid, p_capability_sha256 text,
	p_claude_login_id uuid, p_token uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare v_login public.qorpera_claude_logins%rowtype; v_now timestamptz := clock_timestamp();
begin
	if p_outcome is null or p_outcome not in ('unchanged', 'failed', 'refused') then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	v_login := public.qorpera_claude_login_renewal_locked(p_principal_id, p_capability_sha256, p_claude_login_id, p_token);
	if v_login.id is null then
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal-release/v1', 'state', 'stale'); end if;
	-- WHY: one refusal never signs out: during the roll a run of the previous runtime may renew and seal a newer version.
	if p_outcome = 'refused' and v_login.status = 'active' and v_login.refused_version = v_login.version
		and v_login.refused_at <= v_now - interval '2 minutes' then
		update public.qorpera_claude_logins
		set status = 'revoked', revoked_at = coalesce(revoked_at, v_now), key_id = null, encrypted_envelope = null,
			envelope_sha256 = null, renewal_token = null, renewal_until = null, checked_at = v_now
		where id = v_login.id;
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal-release/v1', 'state', 'signed_out');
	end if;
	update public.qorpera_claude_logins
	set renewal_token = null, renewal_until = null,
		checked_at = case when p_outcome = 'failed' then checked_at else v_now end,
		failed_at = case when p_outcome = 'failed' then v_now end,
		failures = case when p_outcome = 'failed' then failures + 1 else 0 end,
		refused_version = case when p_outcome = 'refused' then version
			when p_outcome = 'unchanged' then null else refused_version end,
		refused_at = case when p_outcome = 'refused' then
				case when refused_version = version then refused_at else v_now end
			when p_outcome = 'unchanged' then null else refused_at end
	where id = v_login.id;
	return jsonb_build_object('schema', 'qorpera.claude-login-renewal-release/v1', 'state', 'released');
end $$;

revoke all on function public.qorpera_open_claude_login_for_run(uuid, text, jsonb, bigint),
	public.qorpera_take_claude_login_renewal(uuid, text, uuid, text),
	public.qorpera_take_idle_claude_login_renewal(uuid, text),
	public.qorpera_commit_claude_login_renewal(uuid, text, uuid, uuid, bigint, text, text, text, text),
	public.qorpera_release_claude_login_renewal(uuid, text, uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_open_claude_login_for_run(uuid, text, jsonb, bigint),
	public.qorpera_take_claude_login_renewal(uuid, text, uuid, text),
	public.qorpera_take_idle_claude_login_renewal(uuid, text),
	public.qorpera_commit_claude_login_renewal(uuid, text, uuid, uuid, bigint, text, text, text, text),
	public.qorpera_release_claude_login_renewal(uuid, text, uuid, uuid, text)
	to qorpera_secret_broker;
