-- Company accounts, A1-1: the vault's records for the accounts a company owns
-- on outside websites (design: deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md;
-- founder decisions of 29 September and 2 October 2026).
--
-- An account is a company-owned vault secret (connector 'website') whose sealed
-- envelope holds the password, and later the authenticator seed and recovery
-- codes, beside one metadata row: the website it may be filled into, the login,
-- two-step, status, and the open todo that needed it. Agents never read a
-- value: every call here is the broker's (the qorpera_secret_broker login),
-- bound to the effect receipt of the agent's tool call, and returns envelopes
-- only to the broker. An agent opens an account only for an open todo of its
-- own ("never unprompted"). Members list accounts and remove them; removing
-- wipes the envelopes at once. Built switched off
-- (qorpera_company_account_settings.enabled); folder-v2 companies are refused
-- until the vault writes their connection files (A1-7).

set local lock_timeout = '3s';

create table public.qorpera_company_account_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false
);
insert into public.qorpera_company_account_settings(singleton) values (true);
alter table public.qorpera_company_account_settings enable row level security;
revoke all on table public.qorpera_company_account_settings from public, anon, authenticated, service_role,
	qorpera_secret_broker;
comment on table public.qorpera_company_account_settings is
	'Company accounts (A1) switch. The coordinator turns it on with: update public.qorpera_company_account_settings set enabled = true;';

create function public.qorpera_company_account_host_valid(p_host text)
returns boolean language sql immutable set search_path = '' as $$
	select p_host is not null and char_length(p_host) <= 253
		and p_host ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$'
$$;
revoke all on function public.qorpera_company_account_host_valid(text) from public, anon, authenticated, service_role,
	qorpera_secret_broker;

create table public.qorpera_company_accounts (
	secret_id uuid primary key references public.qorpera_cloud_secrets(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- The website the secrets may be filled into, and its own sign-in hosts (accounts.google.com).
	site text not null check (public.qorpera_company_account_host_valid(site)),
	sign_in_hosts text[] not null default '{}'::text[] check (
		cardinality(sign_in_hosts) <= 4 and array_position(sign_in_hosts, null) is null
	),
	login text not null check (
		char_length(login) between 1 and 254 and login = btrim(login) and login !~ '[[:cntrl:]]'
	),
	two_step text not null default 'none' check (two_step in ('none','authenticator','email','sms')),
	status text not null default 'pending' check (status in ('pending','connected','needs_person','closed')),
	-- An agent's account names the open todo that needed it; a member's hand-over names none.
	opened_for_todo_id uuid,
	opened_by_staff_agent_id uuid,
	opened_receipt_id uuid unique,
	-- The member the opening run acted for, or the member who handed the account over.
	opened_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	connected_at timestamptz,
	last_used_at timestamptz,
	last_used_by_staff_agent_id uuid,
	closed_at timestamptz,
	removed_by_user_id uuid references auth.users(id) on delete restrict,
	updated_at timestamptz not null default statement_timestamp(),
	check ((opened_by_staff_agent_id is null) = (opened_for_todo_id is null)),
	check ((opened_by_staff_agent_id is null) = (opened_receipt_id is null)),
	check ((status = 'closed') = (closed_at is not null)),
	check (status <> 'connected' or connected_at is not null),
	check (removed_by_user_id is null or status = 'closed')
);
create unique index qorpera_company_accounts_open_login
	on public.qorpera_company_accounts(profile_id, environment_id, site, lower(login)) where status <> 'closed';
create index qorpera_company_accounts_company
	on public.qorpera_company_accounts(profile_id, environment_id, created_at desc);
alter table public.qorpera_company_accounts enable row level security;
revoke all on table public.qorpera_company_accounts from public, anon, authenticated, service_role,
	qorpera_secret_broker;
comment on table public.qorpera_company_accounts is
	'A1: one company website account per row, beside its company-owned vault secret (connector website). Written only by the broker and member functions.';

-- The audit learns the account events; rows already written keep their types.
alter table public.qorpera_cloud_secret_audit_events
	drop constraint qorpera_cloud_secret_audit_events_event_type_check,
	add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (
		'capture_started','captured','rotated','grant_issued','grant_revoked','secret_revoked','effect_authorized',
		'repository_credential_used',
		'account_opened','account_used','account_version_added','account_state_changed','account_removed'
	));

-- The checks every broker call for an agent's account work shares, in lock
-- order: plain reads of the switch, the company's folder kind, the broker
-- authority and the run's job (another company's run is refused before any of
-- its rows is locked); then the run (qorpera_native_tool_locked_run, job
-- first); then the effect receipt FOR UPDATE, which must be this run's
-- executing company_account tool call for exactly this action and, after the
-- opening, this account: its key is company_account:<action>:<account>:<key>.
create function public.qorpera_company_account_call(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_action text,
	p_account_id uuid
)
returns table (
	run_id uuid,
	profile_id uuid,
	environment_id uuid,
	staff_agent_id uuid,
	acting_user_id uuid,
	authority_id uuid,
	key_id text
)
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		raise exception 'Company accounts are switched off' using errcode = '0A000';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
	end if;
	if public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts for folder companies come with their connection file' using errcode = '0A000';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	-- Every check is null-safe: a missing argument refuses, never passes as unknown.
	if not found or p_broker_capability_sha256 is null or v_authority.status is distinct from 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	if coalesce((p_binding ->> 'jobId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true)
		or not exists (select 1 from public.qorpera_runner_jobs as job
			where job.id = (p_binding ->> 'jobId')::uuid and job.profile_id = v_authority.profile_id) then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or p_input_sha256 is null or v_receipt.input_sha256 is distinct from p_input_sha256
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or coalesce(v_receipt.logical_operation_key !~ ('^company_account:' || p_action || ':'
			|| coalesce(p_account_id::text || ':', '') || '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'), true) then
		raise exception 'company account effect receipt is unavailable' using errcode = '42501';
	end if;
	return query select v_run.id, v_run.profile_id, v_run.environment_id, v_run.staff_agent_id,
		v_run.created_by_user_id, v_authority.id, v_authority.key_id;
end
$$;
revoke all on function public.qorpera_company_account_call(uuid,text,jsonb,uuid,text,text,text,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- An account as the broker and the agent's tool see it: never a value.
create function public.qorpera_company_account_descriptor(p_account public.qorpera_company_accounts, p_version bigint)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object(
		'schema', 'qorpera.company-account/v1',
		'accountId', p_account.secret_id,
		'site', p_account.site,
		'signInHosts', to_jsonb(p_account.sign_in_hosts),
		'login', p_account.login,
		'twoStep', p_account.two_step,
		'status', p_account.status,
		'version', p_version
	)
$$;
revoke all on function public.qorpera_company_account_descriptor(public.qorpera_company_accounts,bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker opens an account for the agent's tool call: version 1 holds the
-- password the broker made, sealed under the company's key. The broker chose the
-- account's id and sealed it, with the run's company and environment, into the
-- envelope's associated data, so all three come in and must match. The account is pending until
-- the agent reports the website accepted it.
create function public.qorpera_open_company_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_secret_id uuid,
	p_company_id uuid,
	p_environment_id uuid,
	p_site text,
	p_sign_in_hosts text[],
	p_login text,
	p_purpose text,
	p_todo_id uuid,
	p_key_id text,
	p_encrypted_envelope bytea,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_call record;
	v_account public.qorpera_company_accounts%rowtype;
	v_secret_id uuid := p_secret_id;
	v_base text;
	v_name text;
	v_suffix integer := 1;
begin
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'open', null)
		as call;
	-- A repeat after a lost answer finds the account its receipt opened.
	select account.* into v_account from public.qorpera_company_accounts as account
	where account.opened_receipt_id = p_receipt_id;
	if found then
		return public.qorpera_company_account_descriptor(v_account,
			(select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = v_account.secret_id));
	end if;
	if p_company_id is distinct from v_call.profile_id or p_environment_id is distinct from v_call.environment_id
		or p_secret_id is null then
		raise exception 'company account envelope is unavailable' using errcode = '42501';
	end if;
	-- A broker's random id never collides in practice; if it did, the call fails like any broker fault
	-- (never as a refusal the agent would read) and the tool call's next attempt draws a new id.
	if exists (select 1 from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id) then
		raise exception 'company account id is taken' using errcode = '42501';
	end if;
	if not public.qorpera_company_account_host_valid(p_site)
		or p_sign_in_hosts is null or cardinality(p_sign_in_hosts) > 4
		or exists (select 1 from unnest(p_sign_in_hosts) as host
			where not public.qorpera_company_account_host_valid(host) or host = p_site)
		or (select count(distinct host) from unnest(p_sign_in_hosts) as host) <> cardinality(p_sign_in_hosts)
		or p_login is null or char_length(p_login) not between 1 and 254 or p_login <> btrim(p_login)
		or p_login ~ '[[:cntrl:]]'
		or p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 512 or p_purpose <> btrim(p_purpose) then
		raise exception 'The account''s website, sign-in hosts, login or reason is malformed' using errcode = '22023';
	end if;
	-- Never unprompted: an account is opened only for an open todo of this agent.
	if not exists (
		select 1 from public.qorpera_runtime_agent_todos as todo
		where todo.id = p_todo_id and todo.profile_id = v_call.profile_id and todo.environment_id = v_call.environment_id
			and todo.staff_agent_id = v_call.staff_agent_id and todo.state in ('open','blocked')
			and todo.folder_retired_at is null
	) then
		raise exception 'An account is opened only for an open todo of this agent' using errcode = '22023';
	end if;
	if p_key_id is distinct from v_call.key_id or p_encrypted_envelope is null
		or octet_length(p_encrypted_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_encrypted_envelope, 'sha256'), 'hex') then
		raise exception 'company account envelope is unavailable' using errcode = '42501';
	end if;
	if exists (
		select 1 from public.qorpera_company_accounts as account
		where account.profile_id = v_call.profile_id and account.environment_id = v_call.environment_id
			and account.site = p_site and lower(account.login) = lower(p_login) and account.status <> 'closed'
	) then
		raise exception 'The company already has this account; use it' using errcode = '23505';
	end if;
	-- The vault name: the website as a name, with a number when the company has more than one there.
	v_base := left(regexp_replace(p_site, '[^a-z0-9]+', '-', 'g'), 56);
	if v_base !~ '^[a-z]' then v_base := left('site-' || v_base, 56); end if;
	v_base := regexp_replace(v_base, '-+$', '');
	v_name := v_base;
	while exists (
		select 1 from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_call.profile_id and secret.environment_id = v_call.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'website' and secret.secret_name = v_name
			and secret.status = 'active'
	) loop
		v_suffix := v_suffix + 1;
		if v_suffix > 999 then
			raise exception 'The company has too many accounts on this website' using errcode = '54000';
		end if;
		v_name := v_base || '-' || v_suffix;
	end loop;
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (v_secret_id, v_call.profile_id, v_call.environment_id, v_call.authority_id, 'company', null,
		'website', v_name, p_purpose, 1, v_call.acting_user_id);
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (v_secret_id, 1, v_call.authority_id, v_call.key_id, p_encrypted_envelope, p_envelope_sha256,
		v_call.acting_user_id);
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, sign_in_hosts, login,
		opened_for_todo_id, opened_by_staff_agent_id, opened_receipt_id, opened_by_user_id)
	values (v_secret_id, v_call.profile_id, v_call.environment_id, p_site, p_sign_in_hosts, p_login,
		p_todo_id, v_call.staff_agent_id, p_receipt_id, v_call.acting_user_id)
	returning * into v_account;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_call.profile_id, v_call.environment_id, v_secret_id, 1, v_call.run_id, p_receipt_id, 'account_opened',
		v_call.acting_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, 1);
end
$$;

-- Before it opens an account the broker reads what the envelope's associated data
-- needs: the run's company and environment and the company's key id, after the
-- same checks the opening makes (the receipt must be an executing open).
create function public.qorpera_describe_company_account_open(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_call record;
begin
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'open', null)
		as call;
	return jsonb_build_object('schema', 'qorpera.company-account-context/v1', 'companyId', v_call.profile_id,
		'environmentId', v_call.environment_id, 'keyId', v_call.key_id);
end
$$;

-- The account the agent's tool call names, locked for the change it makes.
create function public.qorpera_company_account_locked(p_call_profile uuid, p_call_environment uuid,
	p_authority_id uuid, p_account_id uuid)
returns public.qorpera_company_accounts
language plpgsql security definer set search_path = '' as $$
declare
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
begin
	-- Only this company's website accounts are locked: any other id is refused without waiting.
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_account_id and secret.profile_id = p_call_profile and secret.environment_id = p_call_environment
		and secret.connector_id = 'website' and secret.owner_kind = 'company'
	for update;
	if found then
		select account.* into v_account from public.qorpera_company_accounts as account
		where account.secret_id = p_account_id and account.profile_id = p_call_profile
		for update;
	end if;
	if v_secret.id is null or v_account.secret_id is null or v_secret.status <> 'active' or v_account.status = 'closed' then
		raise exception 'The company has no such open account' using errcode = '22023';
	end if;
	if v_secret.broker_authority_id is distinct from p_authority_id then
		raise exception 'cloud secret broker does not own this envelope' using errcode = '42501';
	end if;
	return v_account;
end
$$;
revoke all on function public.qorpera_company_account_locked(uuid,uuid,uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker reads an account's current envelope for one of the agent's tool
-- calls (a fill, a code, a password change): the value goes to the broker
-- only, and the use is recorded.
create function public.qorpera_use_company_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_account_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_call record;
	v_account public.qorpera_company_accounts%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'use',
		p_account_id) as call;
	v_account := public.qorpera_company_account_locked(v_call.profile_id, v_call.environment_id, v_call.authority_id,
		p_account_id);
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = p_account_id
		and version.version = (select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = p_account_id);
	if not found or v_version.broker_authority_id is distinct from v_call.authority_id
		or v_version.key_id is distinct from v_call.key_id then
		raise exception 'company account version is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_company_accounts as account
	set last_used_at = statement_timestamp(), last_used_by_staff_agent_id = v_call.staff_agent_id,
		updated_at = statement_timestamp()
	where account.secret_id = p_account_id;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_call.profile_id, v_call.environment_id, p_account_id, v_version.version, v_call.run_id, p_receipt_id,
		'account_used', v_call.acting_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, v_version.version) || jsonb_build_object(
		-- The envelope's associated data, for the broker to open it.
		'companyId', v_account.profile_id,
		'environmentId', v_account.environment_id,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'receiptId', p_receipt_id
	);
end
$$;

-- The broker saves a new version (a changed password, an authenticator seed,
-- recovery codes) over the version it read: a compare-and-swap, so two changes
-- never overwrite each other. A repeat after a lost answer finds its version.
create function public.qorpera_add_company_account_version(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_account_id uuid,
	p_base_version bigint,
	p_two_step text,
	p_key_id text,
	p_encrypted_envelope bytea,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_call record;
	v_account public.qorpera_company_accounts%rowtype;
	v_current bigint;
begin
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'version',
		p_account_id) as call;
	if p_key_id is distinct from v_call.key_id or p_encrypted_envelope is null
		or octet_length(p_encrypted_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_encrypted_envelope, 'sha256'), 'hex') then
		raise exception 'company account envelope is unavailable' using errcode = '42501';
	end if;
	if p_two_step is not null and p_two_step not in ('none','authenticator','email','sms') then
		raise exception 'The account''s two-step kind is malformed' using errcode = '22023';
	end if;
	v_account := public.qorpera_company_account_locked(v_call.profile_id, v_call.environment_id, v_call.authority_id,
		p_account_id);
	select secret.current_version into v_current from public.qorpera_cloud_secrets as secret where secret.id = p_account_id;
	if v_current = p_base_version + 1 and exists (
		select 1 from public.qorpera_cloud_secret_versions as version
		where version.secret_id = p_account_id and version.version = v_current
			and version.envelope_sha256 = p_envelope_sha256
	) then
		return public.qorpera_company_account_descriptor(v_account, v_current);
	end if;
	if p_base_version is null or v_current is distinct from p_base_version then
		raise exception 'The account changed meanwhile; read it again' using errcode = '55000';
	end if;
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_account_id, v_current + 1, v_call.authority_id, v_call.key_id, p_encrypted_envelope, p_envelope_sha256,
		v_call.acting_user_id);
	update public.qorpera_cloud_secrets as secret
	set current_version = v_current + 1, updated_at = statement_timestamp()
	where secret.id = p_account_id;
	update public.qorpera_company_accounts as account
	set two_step = coalesce(p_two_step, account.two_step), updated_at = statement_timestamp()
	where account.secret_id = p_account_id
	returning * into v_account;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_call.profile_id, v_call.environment_id, p_account_id, v_current + 1, v_call.run_id, p_receipt_id,
		'account_version_added', v_call.acting_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, v_current + 1);
end
$$;

-- The agent reports what the website did: accepted (connected), wants a
-- person (needs_person), or closed. A closed account is never opened again;
-- its secrets stay sealed until the clean-up wipes them.
create function public.qorpera_set_company_account_state(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_account_id uuid,
	p_status text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_call record;
	v_account public.qorpera_company_accounts%rowtype;
begin
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'state',
		p_account_id) as call;
	if p_status is null or p_status not in ('connected','needs_person','closed') then
		raise exception 'An account becomes connected, needs_person or closed' using errcode = '22023';
	end if;
	v_account := public.qorpera_company_account_locked(v_call.profile_id, v_call.environment_id, v_call.authority_id,
		p_account_id);
	if v_account.status <> p_status then
		update public.qorpera_company_accounts as account
		set status = p_status,
			connected_at = case when p_status = 'connected' then coalesce(account.connected_at, statement_timestamp())
				else account.connected_at end,
			closed_at = case when p_status = 'closed' then statement_timestamp() else account.closed_at end,
			updated_at = statement_timestamp()
		where account.secret_id = p_account_id
		returning * into v_account;
		insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, run_id, receipt_id,
			event_type, actor_user_id, connector_id, operation_id)
		values (v_call.profile_id, v_call.environment_id, p_account_id, v_call.run_id, p_receipt_id,
			'account_state_changed', v_call.acting_user_id, 'website', replace(p_status, '_', '-'));
	end if;
	return public.qorpera_company_account_descriptor(v_account,
		(select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = p_account_id));
end
$$;

revoke all on function
	public.qorpera_describe_company_account_open(uuid,text,jsonb,uuid,text,text),
	public.qorpera_open_company_account(uuid,text,jsonb,uuid,text,text,uuid,uuid,uuid,text,text[],text,text,uuid,text,bytea,text),
	public.qorpera_use_company_account(uuid,text,jsonb,uuid,text,text,uuid),
	public.qorpera_add_company_account_version(uuid,text,jsonb,uuid,text,text,uuid,bigint,text,text,bytea,text),
	public.qorpera_set_company_account_state(uuid,text,jsonb,uuid,text,text,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_describe_company_account_open(uuid,text,jsonb,uuid,text,text),
	public.qorpera_open_company_account(uuid,text,jsonb,uuid,text,text,uuid,uuid,uuid,text,text[],text,text,uuid,text,bytea,text),
	public.qorpera_use_company_account(uuid,text,jsonb,uuid,text,text,uuid),
	public.qorpera_add_company_account_version(uuid,text,jsonb,uuid,text,text,uuid,bigint,text,text,bytea,text),
	public.qorpera_set_company_account_state(uuid,text,jsonb,uuid,text,text,uuid,text)
	to qorpera_secret_broker;

-- However a website secret is revoked (the account removal, or the generic
-- qorpera_revoke_cloud_secret an owner or admin may call on any company
-- secret), its envelopes are wiped and its account closed, so the login is
-- free for a new account and nothing is left half open. The secret is already
-- locked by the update; the account follows it, as in every account call.
create function public.qorpera_company_account_secret_revoked()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	delete from public.qorpera_cloud_secret_versions as version where version.secret_id = new.id;
	update public.qorpera_company_accounts as account
	set status = 'closed', closed_at = coalesce(account.closed_at, statement_timestamp()),
		removed_by_user_id = coalesce(account.removed_by_user_id, new.revoked_by_user_id),
		updated_at = statement_timestamp()
	where account.secret_id = new.id and (account.status <> 'closed' or account.removed_by_user_id is null);
	return null;
end
$$;
revoke all on function public.qorpera_company_account_secret_revoked()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_company_account_secret_revoked
	after update of status on public.qorpera_cloud_secrets
	for each row when (new.connector_id = 'website' and old.status = 'active' and new.status = 'revoked')
	execute function public.qorpera_company_account_secret_revoked();

-- Members of the company read its accounts: the facts, never a value.
create function public.qorpera_list_company_accounts(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'company accounts are unavailable' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'accountId', account.secret_id,
			'site', account.site,
			'signInHosts', to_jsonb(account.sign_in_hosts),
			'login', account.login,
			'twoStep', account.two_step,
			-- A secret revoked elsewhere is a closed account.
			'status', case when secret.status = 'active' then account.status else 'closed' end,
			'purpose', secret.purpose,
			'openedFor', case when account.opened_for_todo_id is null then null else jsonb_build_object(
				'todoId', account.opened_for_todo_id, 'title', todo.title) end,
			'openedBy', case when account.opened_by_staff_agent_id is null
				then jsonb_build_object('kind', 'member', 'userId', account.opened_by_user_id)
				else jsonb_build_object('kind', 'agent', 'staffAgentId', account.opened_by_staff_agent_id,
					'name', opener.display_name) end,
			'createdAt', account.created_at,
			'connectedAt', account.connected_at,
			'lastUsedAt', account.last_used_at,
			'lastUsedBy', case when account.last_used_by_staff_agent_id is null then null else jsonb_build_object(
				'staffAgentId', account.last_used_by_staff_agent_id, 'name', user_agent.display_name) end,
			'closedAt', account.closed_at
		) order by account.created_at desc, account.secret_id)
		from public.qorpera_company_accounts as account
		join public.qorpera_cloud_secrets as secret on secret.id = account.secret_id
		left join public.qorpera_runtime_agent_todos as todo on todo.id = account.opened_for_todo_id
			and todo.profile_id = account.profile_id
		left join public.qorpera_profile_staff as opener on opener.profile_id = account.profile_id
			and opener.staff_agent_id = account.opened_by_staff_agent_id
		left join public.qorpera_profile_staff as user_agent on user_agent.profile_id = account.profile_id
			and user_agent.staff_agent_id = account.last_used_by_staff_agent_id
		where account.profile_id = p_profile_id and account.environment_id = p_environment_id
	), '[]'::jsonb);
end
$$;

-- An owner or admin removes an account from the company: the vault forgets
-- its secrets at once (the account on the website stays open; no agent can
-- use it any more). Authority is checked before any row is locked.
create function public.qorpera_remove_company_account(p_profile_id uuid, p_account_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(p_profile_id);
	if v_role is null or v_role not in ('owner','admin') or not exists (
		select 1 from public.qorpera_company_accounts as account
		where account.secret_id = p_account_id and account.profile_id = p_profile_id
	) then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	-- Rank 0 first: the company row's key share, which the audit row's key needs, before the vault rows. A broker
	-- call holding the company row (the lease's fence) and waiting for the secret then never meets this call.
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id
	for share;
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_account_id and secret.profile_id = p_profile_id and secret.connector_id = 'website'
	for update;
	select account.* into v_account from public.qorpera_company_accounts as account
	where account.secret_id = p_account_id and account.profile_id = p_profile_id
	for update;
	if v_role is null or v_role not in ('owner','admin') or v_secret.id is null or v_account.secret_id is null
		or v_secret.connector_id is distinct from 'website' then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	-- Revoking the secret wipes its envelopes and closes the account (qorpera_company_account_secret_revoked).
	if v_secret.status = 'active' then
		update public.qorpera_cloud_secrets as secret
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = v_user_id,
			updated_at = statement_timestamp()
		where secret.id = p_account_id;
	end if;
	if v_account.removed_by_user_id is null then
		update public.qorpera_company_accounts as account
		set status = 'closed', closed_at = coalesce(account.closed_at, statement_timestamp()),
			removed_by_user_id = v_user_id, updated_at = statement_timestamp()
		where account.secret_id = p_account_id;
		insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, event_type,
			actor_user_id, connector_id)
		values (p_profile_id, v_account.environment_id, p_account_id, 'account_removed', v_user_id, 'website');
	end if;
	return jsonb_build_object('schema', 'qorpera.company-account-removal/v1', 'accountId', p_account_id,
		'removed', true);
end
$$;

revoke all on function public.qorpera_list_company_accounts(uuid,uuid), public.qorpera_remove_company_account(uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_company_accounts(uuid,uuid), public.qorpera_remove_company_account(uuid,uuid)
	to authenticated;
