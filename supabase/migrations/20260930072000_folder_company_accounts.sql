-- Company accounts on the company folder (A1-7; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.23, design approved
-- by the coordinator on 4 October 2026 with three conditions; deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md).
--
-- Since 3 October every company is on the company folder, and every broker account call refused it (0A000). Each account
-- function below now serves folder-v2 companies only, in core §3's order, and refuses any other company with 0A000
-- "Accounts need a company on the company folder", read through the run's job (or, for a removal, the account's
-- environment) before any lock. No snapshot-v1 path is left, and no account function reaches the gc fence.
-- * The run check is unchanged: qorpera_native_tool_locked_run sends a folder-v2 job to qorpera_folder_tool_run (the run
--   mutex, the job and the folder fence KEY SHARE, the company row KEY SHARE at rank 0, the run's principals).
-- * Vault rows (rank 8) come before run-owned rows (C1C §5.7). Use, a new version, the state and a fill lock the account's
--   secret and then its row (qorpera_company_account_locked, unchanged: an account row always right after its secret),
--   and only then the effect receipt. qorpera_company_account_call no longer reads the receipt: the new internal
--   qorpera_company_account_receipt validates and locks it, with exactly the checks the call made (the key
--   company_account:<action>:<account>:<key>, every comparison null-safe). The call still refuses a missing receipt id,
--   digest or account before any vault row, as the receipt would. Describing an opening locks no vault row: the call,
--   then the receipt. An early answer (a repeated opening, a close of a closed account) checks the receipt first.
-- * Opening takes the company's account claim, pg_advisory_xact_lock(hashtextextended('qorpera.company-accounts:' ||
--   <company>, 0)): rank 9 (unique-key claims), transaction-scoped, built as E1's per-company lock for hooks and
--   mailboxes ('qorpera.event-hooks:' || <company>, 20260930060000), so the two namespaces never share a key. Under it:
--   the repeat, the id, the todo, the duplicate login and the vault name; then the receipt; then the inserts. A second
--   opening waits for the claim and answers "already has this account" or the replay. The unique indexes stay the final
--   guard: a 23505 on qorpera_company_accounts_open_login or qorpera_cloud_secrets_active_name answers the duplicate
--   check's own refusal (23505 'The company already has this account; use it').
-- * Finding runs the run check, so a folder-v2 binding is validated (the refusal came before it until now).
-- * Removal (an owner or admin) enters as a member's action does (qorpera_folder_company_enter: a paused company refused,
--   the folder fence KEY SHARE with the pause read again, the company row KEY SHARE at rank 0, the caller's member row
--   KEY SHARE at rank 1), re-checks the deletion and the role, then locks the secret and the account.
-- Unchanged: the list, qorpera_company_account_mail, the triggers, the descriptor, qorpera_company_account_locked and the
-- operator switch (qorpera_company_account_settings.enabled). Every replaced body names this migration (20260930072000).
-- Signatures, owners and grants are as they were (create or replace); the new helper is granted to no role.

set local lock_timeout = '3s';

-- 1. The call: folder-v2 only, the run check, no receipt ---------------------------------------------------------------

-- The checks every broker call for an agent's account shares, before any vault row: plain reads of the switch, the broker
-- authority and the run's job (another company's run is refused before any of its rows is locked), the company's core
-- through that job, then the run (qorpera_native_tool_locked_run, which sends folder-v2 to qorpera_folder_tool_run) and
-- the call's own arguments. The receipt row is qorpera_company_account_receipt's, after the vault rows.
create or replace function public.qorpera_company_account_call(
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
begin
	-- 20260930072000 (A1-7): folder-v2 only; the receipt is locked by qorpera_company_account_receipt, after the vault rows.
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		raise exception 'Company accounts are switched off' using errcode = '0A000';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
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
	-- The job is the authority's company's, so its core is the company's: only the company folder is served, decided
	-- before any lock (the old core's run check would take the gc fence).
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts need a company on the company folder' using errcode = '0A000';
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- The call's own arguments, before any vault row: a missing receipt, digest or (after the opening) account is the
	-- broker's fault, refused as the receipt refuses it, never "no such account".
	if p_receipt_id is null or p_input_sha256 is null
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or (p_action is distinct from 'open' and p_account_id is null) then
		raise exception 'company account effect receipt is unavailable' using errcode = '42501';
	end if;
	return query select v_run.id, v_run.profile_id, v_run.environment_id, v_run.staff_agent_id,
		v_run.created_by_user_id, v_authority.id, v_authority.key_id;
end
$$;

-- 2. The receipt: a run-owned row, after the vault rows (C1C §5.7) -----------------------------------------------------

-- The run's effect receipt FOR UPDATE: it must be this run's executing company_account tool call for exactly this action
-- and, after the opening, this account (its key is company_account:<action>:<account>:<key>), with the call's input and
-- downstream digests. The checks qorpera_company_account_call made until now, unchanged and null-safe.
create function public.qorpera_company_account_receipt(
	p_run_id uuid,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_action text,
	p_account_id uuid
)
returns public.qorpera_run_operation_receipts
language plpgsql security definer set search_path = '' as $$
declare
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	-- 20260930072000 (A1-7): taken out of qorpera_company_account_call; every caller locks its vault rows first.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = p_run_id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or p_input_sha256 is null or v_receipt.input_sha256 is distinct from p_input_sha256
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or (p_action is distinct from 'open' and p_account_id is null)
		or coalesce(v_receipt.logical_operation_key !~ ('^company_account:' || p_action || ':'
			|| coalesce(p_account_id::text || ':', '') || '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'), true) then
		raise exception 'company account effect receipt is unavailable' using errcode = '42501';
	end if;
	return v_receipt;
end
$$;
revoke all on function public.qorpera_company_account_receipt(uuid,uuid,text,text,text,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. Opening, under the company's account claim ------------------------------------------------------------------------

-- The broker opens an account for the agent's tool call: version 1 holds the password the broker made, sealed under the
-- company's key. The broker chose the account's id and sealed it, with the run's company and environment, into the
-- envelope's associated data, so all three come in and must match. The account is pending until the agent reports the
-- website accepted it.
create or replace function public.qorpera_open_company_account(
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
	v_constraint text;
begin
	-- 20260930072000 (A1-7): the call (the run check), the company's account claim (rank 9), the checks under it, the
	-- receipt (a run-owned row), then the inserts.
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'open', null)
		as call;
	-- Rank 9, a unique-key claim (core §3 step 4): the company's account claim, held to the end of the transaction. Its
	-- key is built as E1's per-company lock for hooks and mailboxes ('qorpera.event-hooks:'), in its own namespace. Two
	-- openings of one company take turns here, so the repeat, the duplicate login and the vault name below are read with no
	-- other opening in flight.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-accounts:' || v_call.profile_id::text, 0));
	-- A repeat after a lost answer finds the account its receipt opened; the receipt is still checked before the answer.
	select account.* into v_account from public.qorpera_company_accounts as account
	where account.opened_receipt_id = p_receipt_id;
	if found then
		perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
			p_downstream_idempotency_sha256, 'open', null);
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
		or p_sign_in_hosts is null or coalesce(array_ndims(p_sign_in_hosts), 1) <> 1 or cardinality(p_sign_in_hosts) > 4
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
	-- Run-owned rows come after rank 9 (C1C §5.7): the receipt.
	perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
		p_downstream_idempotency_sha256, 'open', null);
	-- The unique indexes stay the final guard: a writer that took no claim can still hold the login or the vault name. Their
	-- 23505 answers as the duplicate check above does, never in Postgres' words; any other conflict stays a broker fault.
	begin
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
	exception when unique_violation then
		get stacked diagnostics v_constraint = constraint_name;
		if v_constraint in ('qorpera_company_accounts_open_login', 'qorpera_cloud_secrets_active_name') then
			raise exception 'The company already has this account; use it' using errcode = '23505';
		end if;
		raise;
	end;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_call.profile_id, v_call.environment_id, v_secret_id, 1, v_call.run_id, p_receipt_id, 'account_opened',
		v_call.acting_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, 1);
end
$$;

-- Before it opens an account the broker reads what the envelope's associated data needs: the run's company and
-- environment and the company's key id, after the call and the receipt (an executing open). No vault row.
create or replace function public.qorpera_describe_company_account_open(
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
	-- 20260930072000 (A1-7): the call (the run check), then the receipt.
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'open', null)
		as call;
	perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
		p_downstream_idempotency_sha256, 'open', null);
	return jsonb_build_object('schema', 'qorpera.company-account-context/v1', 'companyId', v_call.profile_id,
		'environmentId', v_call.environment_id, 'keyId', v_call.key_id);
end
$$;

-- 4. Use, a new version, the state: the vault rows, then the receipt ----------------------------------------------------

-- The broker reads an account's current envelope for one of the agent's tool calls (a fill, a code, a password change):
-- the value goes to the broker only, and the use is recorded.
create or replace function public.qorpera_use_company_account(
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
	-- 20260930072000 (A1-7): the call (the run check), the secret and the account (rank 8), then the receipt.
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'use',
		p_account_id) as call;
	v_account := public.qorpera_company_account_locked(v_call.profile_id, v_call.environment_id, v_call.authority_id,
		p_account_id);
	perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
		p_downstream_idempotency_sha256, 'use', p_account_id);
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

-- The broker saves a new version (a changed password, an authenticator seed, recovery codes) over the version it read: a
-- compare-and-swap, so two changes never overwrite each other. A repeat after a lost answer finds its version.
create or replace function public.qorpera_add_company_account_version(
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
	-- 20260930072000 (A1-7): the call (the run check), the secret and the account (rank 8), then the receipt.
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
	perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
		p_downstream_idempotency_sha256, 'version', p_account_id);
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

-- A close's vault rows: the account's secret, then the account (rank 8), as qorpera_company_account_locked takes them, but
-- an account closed while the close waited for them (another close, or a member's removal) is answered too, not refused:
-- the close then answers the closed account. Any other company's or kind's row, or another broker's, is refused as there.
create function public.qorpera_company_account_locked_for_close(p_call_profile uuid, p_call_environment uuid,
	p_authority_id uuid, p_account_id uuid)
returns public.qorpera_company_accounts
language plpgsql security definer set search_path = '' as $$
declare
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
begin
	-- 20260930072000 (A1-7, review r1): only this company's website accounts are locked; any other id is refused at once.
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_account_id and secret.profile_id = p_call_profile and secret.environment_id = p_call_environment
		and secret.connector_id = 'website' and secret.owner_kind = 'company'
	for update;
	if found then
		select account.* into v_account from public.qorpera_company_accounts as account
		where account.secret_id = p_account_id and account.profile_id = p_call_profile
		for update;
	end if;
	if v_secret.id is null or v_account.secret_id is null
		or (v_account.status is distinct from 'closed' and v_secret.status is distinct from 'active') then
		raise exception 'The company has no such open account' using errcode = '22023';
	end if;
	if v_secret.broker_authority_id is distinct from p_authority_id then
		raise exception 'cloud secret broker does not own this envelope' using errcode = '42501';
	end if;
	return v_account;
end
$$;
revoke all on function public.qorpera_company_account_locked_for_close(uuid,uuid,uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The agent reports what the website did: accepted (connected), wants a person (needs_person), or closed. Closing revokes
-- the vault row at once (the revoke trigger wipes the envelopes and closes the account row); a repeat of a close, or a
-- close of an account already closed, answers the closed account after its receipt is checked, also when it was closed
-- while this close waited for its rows. A closed account is never opened again.
create or replace function public.qorpera_set_company_account_state(
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
	-- 20260930072000 (A1-7): the call (the run check), the secret and the account (rank 8), then the receipt.
	select call.* into strict v_call from public.qorpera_company_account_call(p_broker_authority_id,
		p_broker_capability_sha256, p_binding, p_receipt_id, p_input_sha256, p_downstream_idempotency_sha256, 'state',
		p_account_id) as call;
	if p_status is null or p_status not in ('connected','needs_person','closed') then
		raise exception 'An account becomes connected, needs_person or closed' using errcode = '22023';
	end if;
	if p_status = 'closed' then
		-- Already closed (this call's earlier attempt, or another): the closed account, with no vault row locked; its
		-- receipt is checked before the answer.
		select account.* into v_account from public.qorpera_company_accounts as account
		where account.secret_id = p_account_id and account.profile_id = v_call.profile_id
			and account.environment_id = v_call.environment_id and account.status = 'closed';
		if found then
			perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
				p_downstream_idempotency_sha256, 'state', p_account_id);
			return public.qorpera_company_account_descriptor(v_account,
				(select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = p_account_id));
		end if;
	end if;
	if p_status = 'closed' then
		-- Closed while this call waited for its rows (another close, or a member's removal): the closed account too, now
		-- under the secret and the account, after its receipt; never a refusal (review r1).
		v_account := public.qorpera_company_account_locked_for_close(v_call.profile_id, v_call.environment_id,
			v_call.authority_id, p_account_id);
		if v_account.status = 'closed' then
			perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
				p_downstream_idempotency_sha256, 'state', p_account_id);
			return public.qorpera_company_account_descriptor(v_account,
				(select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = p_account_id));
		end if;
	else
		v_account := public.qorpera_company_account_locked(v_call.profile_id, v_call.environment_id, v_call.authority_id,
			p_account_id);
	end if;
	perform public.qorpera_company_account_receipt(v_call.run_id, p_receipt_id, p_input_sha256,
		p_downstream_idempotency_sha256, 'state', p_account_id);
	if v_account.status is distinct from p_status then
		if p_status = 'closed' then
			-- The trigger wipes the envelopes and closes the account row (closed_at); no member removed it.
			update public.qorpera_cloud_secrets as secret
			set status = 'revoked', revoked_at = statement_timestamp(), updated_at = statement_timestamp()
			where secret.id = p_account_id and secret.status = 'active';
		end if;
		update public.qorpera_company_accounts as account
		set status = p_status,
			connected_at = case when p_status = 'connected' then coalesce(account.connected_at, statement_timestamp())
				else account.connected_at end,
			closed_at = case when p_status = 'closed' then coalesce(account.closed_at, statement_timestamp())
				else account.closed_at end,
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

-- 5. A fill: the computer by plain reads, the vault rows, then the receipt ---------------------------------------------

-- The vault's read for one fill. Bound to the agent's executing `computer_browser` receipt of exactly this `vault_fill`
-- call (the broker passes the call's operation envelope; its SHA-256 is the receipt's input digest), the company's own
-- website account, and the computer the run's screen lease holds: its current generation and its current active
-- activation, which must have a key. Authorization by plain read before any lock, every comparison null-safe; then the
-- run check, the computer (plain reads), the account's secret and row, and last the receipt.
create or replace function public.qorpera_fill_company_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_envelope jsonb;
	v_operation jsonb;
	v_target jsonb;
	v_account_id uuid;
	v_field text;
	v_office public.qorpera_runtime_offices%rowtype;
	v_key text;
	v_account public.qorpera_company_accounts%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930072000 (A1-7): folder-v2 only; the run check, the computer, the secret and the account (rank 8), then the
	-- receipt.
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		raise exception 'Company accounts are switched off' using errcode = '0A000';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	if not found or p_broker_capability_sha256 is null or v_authority.status is distinct from 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	if coalesce((p_binding ->> 'jobId') !~ v_uuid, true)
		or not exists (select 1 from public.qorpera_runner_jobs as job
			where job.id = (p_binding ->> 'jobId')::uuid and job.profile_id = v_authority.profile_id) then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- Only the company folder is served, decided through the authority's job before any lock.
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts need a company on the company folder' using errcode = '0A000';
	end if;
	-- The call itself: one vault_fill of the company computer's browser, read before any lock.
	if p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation #>> '{target,realm}' is distinct from 'company_computer'
		or not coalesce(public.qorpera_valid_office_browser_action(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,action}' is distinct from 'vault_fill'
		or jsonb_typeof(v_target) is distinct from 'object'
		or coalesce(v_target ->> 'companyComputerId' !~ v_uuid, true)
		or coalesce(v_target ->> 'screenId' !~ v_uuid, true)
		or coalesce(v_target ->> 'computerGeneration' !~ '^[1-9][0-9]{0,15}$', true) then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end if;
	v_account_id := (v_operation #>> '{arguments,account}')::uuid;
	v_field := v_operation #>> '{arguments,field}';
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- The computer the run's screen lease holds now, at the generation the call names, and that boot's key: plain reads.
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (v_target ->> 'companyComputerId')::uuid
		and office.profile_id = v_run.profile_id and office.environment_id = v_run.environment_id;
	if not found or v_office.generation is distinct from (v_target ->> 'computerGeneration')::bigint
		or not exists (select 1 from public.qorpera_runtime_office_screens as screen
			where screen.id = (v_target ->> 'screenId')::uuid and screen.office_id = v_office.id
				and screen.run_id = v_run.id and screen.staff_agent_id = v_run.staff_agent_id
				and screen.lease_id is not null and screen.lease_expires_at > clock_timestamp()) then
		raise exception 'company computer lease is unavailable' using errcode = '42501';
	end if;
	select activation.fill_public_key into v_key from public.qorpera_runtime_office_activations as activation
	where activation.office_id = v_office.id and activation.computer_generation = v_office.generation
		and activation.superseded_at is null and activation.state = 'active';
	if v_key is null then
		raise exception 'The computer cannot type account values right now: it is still starting, or it needs a restart on a newer version'
			using errcode = '0A000';
	end if;
	-- Rank 8: the account's secret, then its row.
	v_account := public.qorpera_company_account_locked(v_run.profile_id, v_run.environment_id, v_authority.id,
		v_account_id);
	-- Run-owned rows after the vault rows (C1C §5.7): this vault_fill call's receipt.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'computer_browser:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'company account fill receipt is unavailable' using errcode = '42501';
	end if;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_account_id
		and version.version = (select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = v_account_id);
	if not found or v_version.broker_authority_id is distinct from v_authority.id
		or v_version.key_id is distinct from v_authority.key_id then
		raise exception 'company account version is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_company_accounts as account
	set last_used_at = statement_timestamp(), last_used_by_staff_agent_id = v_run.staff_agent_id,
		updated_at = statement_timestamp()
	where account.secret_id = v_account_id;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_run.profile_id, v_run.environment_id, v_account_id, v_version.version, v_run.id, p_receipt_id,
		'account_used', v_run.created_by_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, v_version.version) || jsonb_build_object(
		'schema', 'qorpera.company-account-fill-context/v1',
		-- The envelope's associated data, for the broker to open it.
		'companyId', v_account.profile_id,
		'environmentId', v_account.environment_id,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		-- What the sealed box is bound to.
		'receiptId', p_receipt_id,
		'field', v_field,
		'companyComputerId', v_office.id,
		'computerGeneration', v_office.generation,
		'fillPublicKey', v_key
	);
end
$$;

-- 6. The agent's read: the run check, then plain reads -----------------------------------------------------------------

-- p_request: {todo?: the agent's todo key, site?: a website host}. The company's accounts that are not closed (on that
-- site when one is named: as the account's site or one of its sign-in hosts), newest first, at most 20, with `more` when
-- there are others; the company's mailbox addresses; and the todo's id when one is named, which must be this agent's own
-- open or blocked todo. What the agent can act on is answered, not raised (the native host's transport keeps no database
-- message): `refused` {code, message} while accounts are switched off or the run's company is not on the company folder
-- (0A000), and for a malformed request or a todo that is not the agent's open one (22023). A binding that is not this
-- job's run raises, as every native host call does.
create or replace function public.qorpera_find_company_accounts(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_domain text;
	v_site text;
	v_todo_key text;
	v_todo_id uuid;
	v_accounts jsonb;
	v_more boolean;
	v_mailboxes jsonb;
	v_schema constant text := 'qorpera.agent-company-accounts/v1';
begin
	-- 20260930072000 (A1-7): folder-v2 only; the run check (the folder fence's) before the reads.
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		return jsonb_build_object('schema', v_schema, 'refused',
			jsonb_build_object('code', '0A000', 'message', 'Company accounts are switched off'));
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
	end if;
	-- The company's core through the binding's job, before any lock (the old core's run check would take the gc fence). A
	-- binding that names no job is no run's: it raises, as the run check would.
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		if coalesce((p_binding ->> 'jobId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true)
			or not exists (select 1 from public.qorpera_runner_jobs as job where job.id = (p_binding ->> 'jobId')::uuid) then
			raise exception 'native tool run is unavailable' using errcode = '42501';
		end if;
		return jsonb_build_object('schema', v_schema, 'refused', jsonb_build_object('code', '0A000',
			'message', 'Accounts need a company on the company folder'));
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['todo', 'site'] <> '{}'::jsonb
		or exists (select 1 from jsonb_each(p_request) as field where jsonb_typeof(field.value) <> 'string')
		or coalesce((p_request ->> 'todo') !~ '^[a-z0-9][a-z0-9._-]{0,63}$', false)
		or (p_request ? 'site' and not public.qorpera_company_account_host_valid(lower(p_request ->> 'site'))) then
		return jsonb_build_object('schema', v_schema, 'runId', v_run.id, 'refused', jsonb_build_object('code', '22023',
			'message', 'Account search is invalid: todo is your todo''s key, site a website''s host name'));
	end if;
	v_site := lower(p_request ->> 'site');
	v_todo_key := p_request ->> 'todo';
	if v_todo_key is not null then
		select todo.id into v_todo_id from public.qorpera_runtime_agent_todos as todo
		where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
			and todo.staff_agent_id = v_run.staff_agent_id and todo.todo_key = v_todo_key
			and todo.state in ('open', 'blocked') and todo.folder_retired_at is null;
		if v_todo_id is null then
			return jsonb_build_object('schema', v_schema, 'runId', v_run.id, 'refused', jsonb_build_object('code', '22023',
				'message', 'No open todo of yours has that key: an account is opened only for one'));
		end if;
	end if;
	with found as (
		select account.* from public.qorpera_company_accounts as account
		where account.profile_id = v_run.profile_id and account.environment_id = v_run.environment_id
			and account.status <> 'closed'
			and (v_site is null or account.site = v_site or v_site = any(account.sign_in_hosts))
		order by account.created_at desc, account.secret_id
		limit 21
	), numbered as (
		select found.*, row_number() over (order by found.created_at desc, found.secret_id) as position from found
	)
	select coalesce(jsonb_agg(jsonb_build_object(
			'accountId', numbered.secret_id,
			'site', numbered.site,
			'signInHosts', to_jsonb(numbered.sign_in_hosts),
			'login', numbered.login,
			'twoStep', numbered.two_step,
			'status', numbered.status,
			'openedByYou', numbered.opened_by_staff_agent_id is not distinct from v_run.staff_agent_id,
			'lastUsedAt', numbered.last_used_at
		) order by numbered.position) filter (where numbered.position <= 20), '[]'::jsonb),
		coalesce(max(numbered.position) > 20, false)
	into v_accounts, v_more
	from numbered;
	select lower(settings.domain) into v_domain from public.qorpera_mail_settings as settings;
	select coalesce(jsonb_agg(mailbox.local_part || '@' || v_domain order by mailbox.local_part), '[]'::jsonb)
	into v_mailboxes
	from public.qorpera_company_mailboxes as mailbox
	where v_domain is not null and mailbox.profile_id = v_run.profile_id
		and mailbox.environment_id = v_run.environment_id and mailbox.removed_at is null;
	return jsonb_strip_nulls(jsonb_build_object('schema', v_schema, 'runId', v_run.id,
		'todo', case when v_todo_id is not null then jsonb_build_object('key', v_todo_key, 'id', v_todo_id) end,
		'mailboxes', v_mailboxes, 'accounts', v_accounts, 'more', v_more));
end
$$;

-- 7. Removal by an owner or admin, on the folder fence -----------------------------------------------------------------

-- An owner or admin removes an account from the company: the vault forgets its secrets at once (the account on the
-- website stays open; no agent can use it any more). Authority is checked by plain read before any lock, and again after
-- the company is entered.
create or replace function public.qorpera_remove_company_account(p_profile_id uuid, p_account_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_environment_id uuid;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
begin
	-- 20260930072000 (A1-7): folder-v2 only; the company entered (fence, rank 0, the member at rank 1), deletion and role
	-- again, then the secret and the account (rank 8).
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(p_profile_id);
	select account.environment_id into v_environment_id from public.qorpera_company_accounts as account
	where account.secret_id = p_account_id and account.profile_id = p_profile_id;
	if v_role is null or v_role not in ('owner','admin') or v_environment_id is null then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	-- Only the company folder is served, decided before any lock.
	if not public.qorpera_environment_is_folder_v2(v_environment_id) then
		raise exception 'Accounts need a company on the company folder' using errcode = '0A000';
	end if;
	-- Core §3 steps 3 and 4: a paused company refused, the folder fence KEY SHARE with the pause read again, the company row
	-- KEY SHARE (rank 0, which the audit row's key needs), the caller's member row KEY SHARE (rank 1). A deletion or a role
	-- change may have committed while this call waited: both are read again.
	perform public.qorpera_folder_company_enter(v_environment_id, p_profile_id, jsonb_build_array(
		jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', p_profile_id::text || ':' || v_user_id::text,
			'mode', 'keyshare', 'required', true)), true);
	if public.qorpera_company_deleting(p_profile_id)
		or coalesce(public.qorpera_member_role(p_profile_id)::text not in ('owner', 'admin'), true) then
		raise exception 'company account removal is unavailable' using errcode = '42501';
	end if;
	-- Rank 8: the secret, then the account (as the revoke trigger and every account call take them).
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_account_id and secret.profile_id = p_profile_id and secret.connector_id = 'website'
	for update;
	select account.* into v_account from public.qorpera_company_accounts as account
	where account.secret_id = p_account_id and account.profile_id = p_profile_id
	for update;
	if v_secret.id is null or v_account.secret_id is null or v_secret.connector_id is distinct from 'website' then
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

-- 8. The deploy guard: every replaced body names this migration ---------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_company_account_call(uuid,text,jsonb,uuid,text,text,text,uuid)',
		'public.qorpera_company_account_receipt(uuid,uuid,text,text,text,uuid)',
		'public.qorpera_company_account_locked_for_close(uuid,uuid,uuid,uuid)',
		'public.qorpera_open_company_account(uuid,text,jsonb,uuid,text,text,uuid,uuid,uuid,text,text[],text,text,uuid,text,bytea,text)',
		'public.qorpera_describe_company_account_open(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_use_company_account(uuid,text,jsonb,uuid,text,text,uuid)',
		'public.qorpera_add_company_account_version(uuid,text,jsonb,uuid,text,text,uuid,bigint,text,text,bytea,text)',
		'public.qorpera_set_company_account_state(uuid,text,jsonb,uuid,text,text,uuid,text)',
		'public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_find_company_accounts(jsonb,jsonb)',
		'public.qorpera_remove_company_account(uuid,uuid)'
	]::regprocedure[] loop
		if position('20260930072000' in (select prosrc from pg_proc where oid = v_function)) = 0 then
			raise exception 'Company accounts on folder-v2: % does not name 20260930072000', v_function;
		end if;
	end loop;
end
$guard$;
