-- 20260930695000, step 1 (the database): an agent gets a coding value itself, and never sees it (Jonas, 9 November 2026).
--
-- A coding value is a vault secret with the connector `environment` (20260928549440, 5j-1): a coding session gets it as
-- an environment variable. Today a member saves it. Now an agent may also take it from the service's own website, as
-- E3c (20260928549320) takes a Stripe hook's signing secret: the agent makes the key on the service's site in the
-- company computer's browser, then calls computer_browser {action: vault_capture, role, name, codingValue: {service,
-- variable, repository, purpose}}, naming the control that shows the key. The office clicks it under a full-page cover,
-- reads the value, checks it against the service's pattern and seals it to the value's capture key; the secret broker
-- opens the box and stores the value in the vault. The model never sees it, and this database never does either.
-- * qorpera_coding_value_services: the services a coding value may be taken from, seeded here and closed (no role
--   reads or writes it): the site the page must be on, and the POSIX pattern the whole value must match, which the
--   guest and the broker check.
-- * qorpera_coding_value_capture_keys: a coding value's capture key, one per environment and variable name. The broker
--   derives an X25519 key pair for the secret's id from the company's vault key (as for a Stripe hook); the row keeps the
--   public half. The id is the company's active `environment` secret of that name when there is one, so a capture adds a
--   version to it; otherwise one the broker reserved, which the first capture makes. No role reads the table.
-- * qorpera_valid_office_browser_action: vault_capture takes a coding value instead of a hook and a field, never both.
--   The service must be a seeded one, the variable a name a coding value may have
--   (qorpera_coding_environment_name_allowed), the repository owner/name in lower case, the purpose 1 to 300 characters.
--   It reads the services table, so it is STABLE now (its callers are function bodies only).
-- * The broker's three calls, each bound to the agent's executing computer_browser receipt of exactly this call, share
--   qorpera_folder_coding_value_capture_context (granted to no role), in E3c's order: the call; the run check, with the
--   requester's member row FOR SHARE (rank 1), so no demotion commits while the capture saves and grants; a company
--   agent's run, not a worker's; the company not being deleted; the requester an owner or admin (they stand behind the
--   save and the grant); the capture key FOR UPDATE (one value's captures take turns); the screen lease (plain reads);
--   the secrets at the key's id and of the value's name FOR UPDATE; and last the receipt FOR UPDATE.
--   - qorpera_folder_prepare_coding_value_capture, before the office acts: makes the capture key, or makes it again when
--     it was made under another authority or key or for an id the value no longer keeps (audited
--     coding_value_capture_key_replaced). It answers the key; when the broker derived it for another id it stores
--     nothing and answers the id to derive for. An id another secret or capture key holds is refused.
--   - qorpera_folder_read_coding_value_capture: what the box's associated data and the next version need, the service's
--     site and pattern, the current version when it is sealed under this authority's key, and this receipt's capture if
--     it stored one. Writes nothing.
--   - qorpera_folder_store_coding_value_capture: the next version, once per receipt (audited coding_value_captured); the
--     first one makes the secret (the company's, named for the variable, created by the requester). Then the repository
--     grant, when none is active for the secret and the repository, issued by the requester, with the row and the
--     environment_grant_issued event qorpera_grant_coding_environment_secret writes. A replay answers the stored version.
-- * qorpera_native_office_coding_value_capture, the office's own read (service_role): the office's check of the call,
--   then the run, the service, the capture key and the bound identity. Writes nothing.
-- What a member or an agent calls is unchanged, and no member call is added. qorpera_authorize_coding_environment
-- already serves a company secret granted on the session's repository by an issuer who is still an owner or admin, and
-- the demotion trigger ends these grants as it ends the others.
-- Every new or patched body names this migration (20260930695000), for the deploy guards.

do $$ begin
	if to_regclass('public.qorpera_coding_value_services') is not null then
		raise exception '20260930695000 is already applied'; end if;
	if to_regclass('public.qorpera_event_hook_capture_keys') is null
		or to_regclass('public.qorpera_coding_environment_grants') is null
		or position('20260930344000' in pg_get_functiondef('public.qorpera_valid_office_browser_action(jsonb)'::regprocedure)) = 0 then
		raise exception '20260930695000 needs E3c-1 (20260930344000) and 5j-1 (20260930438000)'; end if;
end $$;

set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result is executed once.
create function pg_temp.coding_value_capture_patch(p_function regprocedure, p_pairs text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930695000' in v_definition) > 0 then
		raise exception '20260930695000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930695000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930695000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

-- 1. The services, the capture keys, the two audit events and the capture's index ---------------------------------------

-- The value's pattern is checked by its shape and compiled once here ('' ~ value_pattern raises on a pattern that is
-- not one); the guest and the broker match the whole value against it.
create table public.qorpera_coding_value_services (
	service text primary key check (service ~ '^[a-z][a-z0-9-]{0,31}$'),
	site text not null check (char_length(site) <= 253
		and site ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
	value_pattern text not null check (char_length(value_pattern) <= 512 and value_pattern ~ '^\^.+\$$'
		and ('' ~ value_pattern) is not null),
	description text not null check (char_length(description) between 1 and 300 and description = btrim(description))
);
alter table public.qorpera_coding_value_services enable row level security;
revoke all on table public.qorpera_coding_value_services
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_coding_value_services is
	'20260930695000: the services an agent may take a coding value from (computer_browser vault_capture): the https host the page must be on, and the POSIX pattern the whole value must match (the guest and the broker check it; this database never sees the value). Seeded by migrations only.';

insert into public.qorpera_coding_value_services(service, site, value_pattern, description) values
	('npm', 'www.npmjs.com', '^npm_[A-Za-z0-9]{36}$',
		'An npm access token, made on npmjs.com under Access Tokens.'),
	('github', 'github.com', '^(github_pat_[A-Za-z0-9_]{82}|ghp_[A-Za-z0-9]{36})$',
		'A GitHub personal access token, made on github.com under Settings, Developer settings.'),
	('stripe', 'dashboard.stripe.com', '^(sk|rk)_(test|live)_[A-Za-z0-9]{24,247}$',
		'A Stripe secret or restricted key, made on dashboard.stripe.com under Developers, API keys.'),
	('resend', 'resend.com', '^re_[A-Za-z0-9_]{20,64}$',
		'A Resend API key, made on resend.com under API Keys.');

-- The public key is checked by its shape only, as a hook's is: a check runs with the writer's rights, and
-- qorpera_company_computer_fill_key_valid (which also refuses low-order points) is granted to no role. The functions that
-- write a key call it first. The name's shape is the vault's; the functions check the rest
-- (qorpera_coding_environment_name_allowed).
create table public.qorpera_coding_value_capture_keys (
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	secret_name text not null check (secret_name ~ '^[a-z][a-z0-9_]{0,63}$'),
	secret_id uuid not null unique,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	primary key (environment_id, secret_name)
);
alter table public.qorpera_coding_value_capture_keys enable row level security;
revoke all on table public.qorpera_coding_value_capture_keys
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_coding_value_capture_keys is
	'20260930695000: a coding value''s capture key, per environment and variable name: the id of the secret it is for (the company''s active environment secret of that name, or one the broker reserved), and the public half of the X25519 key the broker derived for that id under this authority''s key. The guest seals a captured value to it.';

-- The event types as they stand (each bundle adds its own), and the two new ones.
do $$
declare v_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	if v_types is null or not (array['hook_secret_captured', 'environment_grant_issued', 'mcp_sign_in_used',
			'repository_fetch_used'] <@ v_types)
		or (v_types && array['coding_value_captured', 'coding_value_capture_key_replaced']) then
		raise exception '20260930695000: the audit event types differ: %', v_types; end if;
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['coding_value_captured', 'coding_value_capture_key_replaced']) with ordinality as u(t, o)));
end $$;

-- One capture per receipt: the store's replay reads this row.
create unique index qorpera_cloud_secret_audit_events_coding_value_capture
	on public.qorpera_cloud_secret_audit_events (receipt_id)
	where event_type = 'coding_value_captured';

-- 2. The browser action ----------------------------------------------------------------------------------------------------

select pg_temp.coding_value_capture_patch('public.qorpera_valid_office_browser_action(jsonb)'::regprocedure, array[
	E'\n IMMUTABLE\n',
	E'\n STABLE\n',
	$old$    when 'vault_capture' then
        -- 20260930344000 (E3c-1): a hook's signing secret read off the sender's page into the vault, after a click on the
        -- control that shows it (a button or link).
        v_keys:=v_keys||array['role','name','hook','field'];
        if coalesce(p_args->>'role','') not in ('button','link')
            or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
            or octet_length(p_args->>'name')>512
            or jsonb_typeof(p_args->'hook') is distinct from 'string'
            or (p_args->>'hook') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or coalesce(p_args->>'field','') <> 'signing_secret' then return false; end if;
    when 'press' then$old$,
	$new$    when 'vault_capture' then
        -- 20260930344000 (E3c-1): a hook's signing secret read off the sender's page into the vault, after a click on the
        -- control that shows it (a button or link).
        -- 20260930695000: or a coding value read off its service's page, never both: the service is a seeded one, the
        -- variable a name a coding value may have, the repository owner/name in lower case, the purpose 1 to 300
        -- characters of trimmed text. Each check runs only after the ones it needs (no null passes).
        if p_args ? 'codingValue' then
            v_keys:=v_keys||array['role','name','codingValue'];
            if coalesce(p_args->>'role','') not in ('button','link')
                or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
                or octet_length(p_args->>'name')>512
                or jsonb_typeof(p_args->'codingValue') is distinct from 'object' then return false; end if;
            if (p_args->'codingValue')-array['service','variable','repository','purpose']<>'{}'::jsonb
                or not ((p_args->'codingValue') ?& array['service','variable','repository','purpose']) then return false; end if;
            if exists (select 1 from jsonb_each(p_args->'codingValue') as field where jsonb_typeof(field.value)<>'string') then
                return false; end if;
            if not exists (select 1 from public.qorpera_coding_value_services as known
                    where known.service=p_args#>>'{codingValue,service}')
                or not public.qorpera_coding_environment_name_allowed(p_args#>>'{codingValue,variable}')
                or (p_args#>>'{codingValue,repository}') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'
                or char_length(p_args#>>'{codingValue,purpose}') not between 1 and 300
                or (p_args#>>'{codingValue,purpose}')<>btrim(p_args#>>'{codingValue,purpose}')
                or (p_args#>>'{codingValue,purpose}') ~ '[[:cntrl:]]' then return false; end if;
        else
            v_keys:=v_keys||array['role','name','hook','field'];
            if coalesce(p_args->>'role','') not in ('button','link')
                or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
                or octet_length(p_args->>'name')>512
                or jsonb_typeof(p_args->'hook') is distinct from 'string'
                or (p_args->>'hook') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                or coalesce(p_args->>'field','') <> 'signing_secret' then return false; end if;
        end if;
    when 'press' then$new$]);

-- 3. The broker's calls ---------------------------------------------------------------------------------------------------

-- The broker's checks, before any lock, as E3b's hook authority makes them: the broker's session, its authority and
-- capability (null-safe), a job of the authority's company, and that company on the company folder.
create function public.qorpera_folder_coding_value_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	-- 20260930695000: plain reads only.
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'coding value run binding is malformed' using errcode = '22023';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	if not found or p_broker_capability_sha256 is null or v_authority.status is distinct from 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	if coalesce((p_binding ->> 'jobId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true)
		or not exists (select 1 from public.qorpera_runner_jobs as job
			where job.id = (p_binding ->> 'jobId')::uuid and job.profile_id = v_authority.profile_id) then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Coding values need a company on the company folder' using errcode = '0A000';
	end if;
	return v_authority;
end
$$;
revoke all on function public.qorpera_folder_coding_value_authority(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The core of the broker's three calls, granted to no role: E3c's capture context, step for step, for a coding value.
-- Bound to the agent's executing `computer_browser` receipt of exactly this `vault_capture` call (the broker passes the
-- call's operation envelope; its SHA-256 is the receipt's input digest) and the computer the run's screen lease holds,
-- at its current generation. Plain reads before any lock; then the run check with the requester's member row (rank 1,
-- FOR SHARE: a demotion or a removal waits, so the grant a store makes is never left behind it), the run, the company and
-- the requester; the value's capture key (FOR UPDATE: one value's captures take turns, so the second reads the first's
-- version); the computer (plain reads); the company's active `environment` secret of the value's name and the secret at
-- the key's id (FOR UPDATE, in id order); and last the receipt.
-- secret_id is the id the value keeps: that secret's, else the key's reserved id while no secret holds it, else null (a
-- new id is needed: no key yet, or the reserved id holds a removed secret). key_current: the key is for that id, under
-- this authority and its key. Unless p_prepare, a key that is not current is refused (55000): the broker makes it again.
-- The caller ran the broker's checks.
create function public.qorpera_folder_coding_value_capture_context(
	p_authority public.qorpera_cloud_secret_broker_authorities,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text,
	p_prepare boolean
)
returns table (
	run_id uuid,
	profile_id uuid,
	environment_id uuid,
	acting_user_id uuid,
	service text,
	site text,
	value_pattern text,
	secret_name text,
	repository text,
	purpose text,
	secret_id uuid,
	current_version bigint,
	key_secret_id uuid,
	key_current boolean,
	key_id text,
	capture_public_key text,
	company_computer_id uuid,
	computer_generation bigint
)
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_envelope jsonb;
	v_operation jsonb;
	v_target jsonb;
	v_value jsonb;
	v_member text;
	v_targets jsonb := '[]'::jsonb;
	v_known public.qorpera_coding_value_services%rowtype;
	v_key public.qorpera_coding_value_capture_keys%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
	v_named public.qorpera_cloud_secrets%rowtype;
	v_reserved public.qorpera_cloud_secrets%rowtype;
	v_secret_id uuid;
	v_current boolean;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930695000: the call, the run check with the requester, the capture key, the computer, the secrets, then the
	-- receipt. Every column is named with its table: this function's answer names some of them too.
	if p_authority.id is null then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	-- The call itself: one vault_capture of a coding value off the company computer's browser, read before any lock.
	if p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'coding value capture call is malformed' using errcode = '22023';
	end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'coding value capture call is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	v_value := v_operation #> '{arguments,codingValue}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation #>> '{target,realm}' is distinct from 'company_computer'
		or not coalesce(public.qorpera_valid_office_browser_action(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,action}' is distinct from 'vault_capture'
		or jsonb_typeof(v_value) is distinct from 'object'
		or jsonb_typeof(v_target) is distinct from 'object'
		or coalesce(v_target ->> 'companyComputerId' !~ v_uuid, true)
		or coalesce(v_target ->> 'screenId' !~ v_uuid, true)
		or coalesce(v_target ->> 'computerGeneration' !~ '^[1-9][0-9]{0,15}$', true) then
		raise exception 'coding value capture call is malformed' using errcode = '22023';
	end if;
	-- The requester's member row, from an unlocked read of the job's run: held FOR SHARE at rank 1.
	select run.profile_id::text || ':' || run.requested_by_user_id::text into v_member
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.id = job.run_id
	where job.id = (p_binding ->> 'jobId')::uuid;
	if v_member is not null then
		v_targets := jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_member,
			'mode', 'share', 'required', true));
	end if;
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, v_targets) -> 'run');
	if p_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- A company agent's own run, never a worker's; a company that is not being deleted; a requester who is an owner or an
	-- admin, read under the lock above.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Coding value authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) then
		raise exception 'This company is being deleted' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can save coding values; ask one of them' using errcode = '42501'; end if;
	-- The service, from the closed list the call was checked against.
	select known.* into v_known from public.qorpera_coding_value_services as known
	where known.service = v_value ->> 'service';
	if not found then
		raise exception 'coding value capture call is malformed' using errcode = '22023'; end if;
	-- The value's capture key, made under this authority and its key: else the broker makes it again.
	select capture.* into v_key from public.qorpera_coding_value_capture_keys as capture
	where capture.environment_id = v_run.environment_id and capture.secret_name = v_value ->> 'variable'
	for update;
	if not p_prepare and (v_key.secret_id is null or v_key.broker_authority_id is distinct from p_authority.id
		or v_key.key_id is distinct from p_authority.key_id) then
		raise exception 'The coding value''s capture key must be made again' using errcode = '55000'; end if;
	-- The computer the run's screen lease holds now, at the generation the call names: plain reads. The box is sealed to
	-- the value's capture key, so no boot key is needed.
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
	-- The company's active environment secret of this name and the secret at the key's id, FOR UPDATE in id order.
	perform 1 from public.qorpera_cloud_secrets as secret
	where secret.id = v_key.secret_id
		or (secret.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'environment'
			and secret.secret_name = v_value ->> 'variable' and secret.status = 'active')
	order by secret.id
	for update;
	select secret.* into v_named from public.qorpera_cloud_secrets as secret
	where secret.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
		and secret.owner_kind = 'company' and secret.connector_id = 'environment'
		and secret.secret_name = v_value ->> 'variable' and secret.status = 'active';
	select secret.* into v_reserved from public.qorpera_cloud_secrets as secret where secret.id = v_key.secret_id;
	-- A live secret at the key's id that is not this value's: an id collision, never the value's.
	if v_reserved.id is not null and v_reserved.status = 'active' and v_reserved.id is distinct from v_named.id then
		raise exception 'coding value secret id is taken' using errcode = '42501'; end if;
	v_secret_id := case when v_named.id is not null then v_named.id
		when v_key.secret_id is not null and v_reserved.id is null then v_key.secret_id end;
	v_current := v_key.secret_id is not null and v_key.secret_id is not distinct from v_secret_id
		and v_key.broker_authority_id = p_authority.id and v_key.key_id = p_authority.key_id;
	if not p_prepare and not v_current then
		raise exception 'The coding value''s capture key must be made again' using errcode = '55000'; end if;
	-- Run-owned rows after the vault rows (C1C §5.7): this vault_capture call's receipt.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'computer_browser:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'coding value capture receipt is unavailable' using errcode = '42501';
	end if;
	return query select v_run.id, v_run.profile_id, v_run.environment_id, v_run.requested_by_user_id, v_known.service,
		v_known.site, v_known.value_pattern, v_value ->> 'variable', v_value ->> 'repository', v_value ->> 'purpose',
		v_secret_id, case when v_secret_id is not distinct from v_named.id then v_named.current_version end,
		v_key.secret_id, v_current, v_key.key_id, v_key.public_key, v_office.id, v_office.generation;
end
$$;
revoke all on function public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,
	jsonb, uuid, text, text, boolean) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Before the office acts, the broker makes the value's capture key: it reserved an id and derived the key for it under
-- the run's company and environment and this authority's key. The key is kept when it is current (the broker's is not
-- needed); made when there is none; made again (audited) when it was made under another authority or key, or for an id
-- the value no longer keeps (its secret was removed, or a member saved one of this name meanwhile). When the value keeps
-- another id than the broker's, nothing is stored: the answer names the id, and the broker derives for it and asks again.
-- An id another secret or capture key holds is refused.
create function public.qorpera_folder_prepare_coding_value_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text,
	p_secret_id uuid,
	p_key_id text,
	p_public_key text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_context record;
	v_answer jsonb;
begin
	-- 20260930695000: the broker's checks and its key before any lock, then the capture's checks and locks.
	v_authority := public.qorpera_folder_coding_value_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	if p_secret_id is null or p_key_id is distinct from v_authority.key_id
		or not coalesce(public.qorpera_company_computer_fill_key_valid(p_public_key), false) then
		raise exception 'coding value capture key is unavailable' using errcode = '42501'; end if;
	select context.* into strict v_context from public.qorpera_folder_coding_value_capture_context(v_authority, p_binding,
		p_receipt_id, p_envelope, p_downstream_idempotency_sha256, true) as context;
	v_answer := jsonb_build_object('schema', 'qorpera.coding-value-capture-key/v1', 'companyId', v_context.profile_id,
		'environmentId', v_context.environment_id, 'variable', v_context.secret_name, 'keyId', v_authority.key_id);
	-- The broker's id, when it is not the one the value keeps: no secret and no capture key may hold it.
	if p_secret_id is distinct from v_context.secret_id and (
		exists (select 1 from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id)
		or exists (select 1 from public.qorpera_event_hook_capture_keys as capture where capture.secret_id = p_secret_id)
		or exists (select 1 from public.qorpera_coding_value_capture_keys as capture where capture.secret_id = p_secret_id)) then
		raise exception 'coding value secret id is taken' using errcode = '42501'; end if;
	if v_context.key_current then
		return v_answer || jsonb_build_object('secretId', v_context.secret_id, 'current', true, 'replaced', false,
			'capturePublicKey', v_context.capture_public_key);
	end if;
	if v_context.secret_id is not null and p_secret_id is distinct from v_context.secret_id then
		return v_answer || jsonb_build_object('secretId', v_context.secret_id, 'current', false);
	end if;
	begin
		if v_context.key_secret_id is null then
			insert into public.qorpera_coding_value_capture_keys(environment_id, secret_name, secret_id, broker_authority_id,
				key_id, public_key)
			values (v_context.environment_id, v_context.secret_name, p_secret_id, v_authority.id, p_key_id, p_public_key);
		else
			update public.qorpera_coding_value_capture_keys as capture
			set secret_id = p_secret_id, broker_authority_id = v_authority.id, key_id = p_key_id, public_key = p_public_key,
				updated_at = statement_timestamp()
			where capture.environment_id = v_context.environment_id and capture.secret_name = v_context.secret_name;
			-- The id the key is now for, with no version: the secret itself may not exist yet.
			insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
				receipt_id, event_type, actor_user_id, connector_id)
			values (v_context.profile_id, v_context.environment_id, p_secret_id, null, v_context.run_id, p_receipt_id,
				'coding_value_capture_key_replaced', v_context.acting_user_id, 'environment');
		end if;
	exception when unique_violation then
		raise exception 'coding value capture outcome is unconfirmed' using errcode = '40003';
	end;
	return v_answer || jsonb_build_object('secretId', p_secret_id, 'current', true,
		'replaced', v_context.key_secret_id is not null, 'capturePublicKey', p_public_key);
end
$$;

-- The broker's read for one capture: what the box's associated data and the next version need, and the service's site
-- and pattern. With the current version when it is sealed under this authority's key (the broker compares the captured
-- value with it), and with this receipt's stored version when it stored one already. Writes nothing.
create function public.qorpera_folder_read_coding_value_capture(
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
	v_context record;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_captured bigint;
begin
	-- 20260930695000: the broker's checks, then the capture's checks and locks.
	v_authority := public.qorpera_folder_coding_value_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	select context.* into strict v_context from public.qorpera_folder_coding_value_capture_context(v_authority, p_binding,
		p_receipt_id, p_envelope, p_downstream_idempotency_sha256, false) as context;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_context.secret_id and version.version = v_context.current_version;
	select audit.secret_version into v_captured from public.qorpera_cloud_secret_audit_events as audit
	where audit.receipt_id = p_receipt_id and audit.event_type = 'coding_value_captured';
	return jsonb_build_object(
		'schema', 'qorpera.coding-value-capture-context/v1',
		'secretId', v_context.secret_id,
		'version', coalesce(v_context.current_version, 0) + 1,
		-- What the page and the value must be.
		'service', v_context.service,
		'site', v_context.site,
		'valuePattern', v_context.value_pattern,
		'variable', v_context.secret_name,
		'repository', v_context.repository,
		-- The associated data, for the broker to open the box and seal the next version.
		'companyId', v_context.profile_id,
		'environmentId', v_context.environment_id,
		'keyId', v_context.key_id,
		'capturePublicKey', v_context.capture_public_key,
		'receiptId', p_receipt_id,
		'companyComputerId', v_context.company_computer_id,
		'computerGeneration', v_context.computer_generation)
		|| case when v_version.broker_authority_id = v_authority.id and v_version.key_id = v_authority.key_id
			then jsonb_build_object('current', jsonb_build_object('version', v_version.version, 'keyId', v_version.key_id,
				'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
				'envelopeSha256', v_version.envelope_sha256))
			else '{}'::jsonb end
		|| case when v_captured is not null
			then jsonb_build_object('captured', jsonb_build_object('version', v_captured)) else '{}'::jsonb end;
end
$$;

-- The broker's store for one capture: the next version of the value, once per receipt. The first capture makes the
-- secret at the key's id (the company's, connector environment, named for the variable, the call's purpose, created by
-- the run's requester), version 1; a later one adds a version. Then the repository grant, when the secret has no active
-- one for the call's repository: issued by the requester, as qorpera_grant_coding_environment_secret issues it (the
-- same row and environment_grant_issued event, here with the run and the receipt). A replay answers the stored version.
-- A version that is no longer the next one, or a write that met another, is an outcome the broker cannot confirm
-- (40003): it reads again for the same receipt.
create function public.qorpera_folder_store_coding_value_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text,
	p_secret_id uuid,
	p_version bigint,
	p_company_id uuid,
	p_environment_id uuid,
	p_key_id text,
	p_encrypted_envelope bytea,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_context record;
	v_audit public.qorpera_cloud_secret_audit_events%rowtype;
	v_grant public.qorpera_coding_environment_grants%rowtype;
	v_answer jsonb;
begin
	-- 20260930695000: the broker's checks, the capture's checks and locks, then this receipt's capture.
	v_authority := public.qorpera_folder_coding_value_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	select context.* into strict v_context from public.qorpera_folder_coding_value_capture_context(v_authority, p_binding,
		p_receipt_id, p_envelope, p_downstream_idempotency_sha256, false) as context;
	v_answer := jsonb_build_object('schema', 'qorpera.coding-value-capture-stored/v1', 'variable', v_context.secret_name,
		'repository', v_context.repository);
	select audit.* into v_audit from public.qorpera_cloud_secret_audit_events as audit
	where audit.receipt_id = p_receipt_id and audit.event_type = 'coding_value_captured';
	if found then
		if v_audit.secret_id is distinct from v_context.secret_id or v_audit.run_id is distinct from v_context.run_id then
			raise exception 'coding value capture receipt is unavailable' using errcode = '42501'; end if;
		return v_answer || jsonb_build_object('secretId', v_audit.secret_id, 'version', v_audit.secret_version,
			'replayed', true);
	end if;
	-- The envelope the broker sealed for the key's id, the run's company and environment and this authority's key.
	if p_secret_id is distinct from v_context.secret_id or p_company_id is distinct from v_context.profile_id
		or p_environment_id is distinct from v_context.environment_id or p_key_id is distinct from v_authority.key_id
		or p_encrypted_envelope is null or octet_length(p_encrypted_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_encrypted_envelope, 'sha256'), 'hex') then
		raise exception 'coding value envelope is unavailable' using errcode = '42501'; end if;
	-- The version the broker read, under the capture key's lock: still the next one.
	if p_version is distinct from coalesce(v_context.current_version, 0) + 1 then
		raise exception 'coding value capture outcome is unconfirmed' using errcode = '40003'; end if;
	begin
		if v_context.current_version is null then
			insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
				owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
			values (p_secret_id, v_context.profile_id, v_context.environment_id, v_authority.id, 'company', null, 'environment',
				v_context.secret_name, v_context.purpose, 1, v_context.acting_user_id);
		end if;
		insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id,
			encrypted_envelope, envelope_sha256, created_by_user_id)
		values (p_secret_id, p_version, v_authority.id, p_key_id, p_encrypted_envelope, p_envelope_sha256,
			v_context.acting_user_id);
		if v_context.current_version is not null then
			update public.qorpera_cloud_secrets as secret
			set current_version = p_version, updated_at = statement_timestamp()
			where secret.id = p_secret_id;
		end if;
		insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
			receipt_id, event_type, actor_user_id, connector_id)
		values (v_context.profile_id, v_context.environment_id, p_secret_id, p_version, v_context.run_id, p_receipt_id,
			'coding_value_captured', v_context.acting_user_id, 'environment');
		-- The repository grant, under the secret's lock as the member's grant takes it; its issuer's member row is held.
		select environment_grant.* into v_grant from public.qorpera_coding_environment_grants as environment_grant
		where environment_grant.secret_id = p_secret_id and environment_grant.repository = v_context.repository
			and environment_grant.status = 'active';
		if v_grant.id is null then
			insert into public.qorpera_coding_environment_grants(profile_id, environment_id, secret_id, repository,
				issued_by_user_id)
			values (v_context.profile_id, v_context.environment_id, p_secret_id, v_context.repository, v_context.acting_user_id)
			returning * into v_grant;
			insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version,
				grant_id, run_id, receipt_id, event_type, actor_user_id, connector_id)
			values (v_context.profile_id, v_context.environment_id, p_secret_id, p_version, v_grant.id, v_context.run_id,
				p_receipt_id, 'environment_grant_issued', v_context.acting_user_id, 'environment');
		end if;
	exception when unique_violation then
		raise exception 'coding value capture outcome is unconfirmed' using errcode = '40003';
	end;
	return v_answer || jsonb_build_object('secretId', p_secret_id, 'version', p_version, 'replayed', false);
end
$$;

revoke all on function public.qorpera_folder_prepare_coding_value_capture(uuid, text, jsonb, uuid, text, text, uuid, text, text),
	public.qorpera_folder_read_coding_value_capture(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_store_coding_value_capture(uuid, text, jsonb, uuid, text, text, uuid, bigint, uuid, uuid, text, bytea,
		text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_prepare_coding_value_capture(uuid, text, jsonb, uuid, text, text, uuid, text,
		text),
	public.qorpera_folder_read_coding_value_capture(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_store_coding_value_capture(uuid, text, jsonb, uuid, text, text, uuid, bigint, uuid, uuid, text, bytea,
		text)
	to qorpera_secret_broker;

-- 4. The office's read: where a capture's box goes, and what the page and the value must be -------------------------------

-- The office reads the value's capture key itself, through its registry, so the native host can never swap in its own.
-- First the office's own check of the call (qorpera_native_office_operation 'check', service_role only: the executing
-- computer_browser receipt of exactly this call, the run's screen lease on this computer and the resource its begin made),
-- then a company agent's run, not a worker's, of a company that is not being deleted, with a requester who is an owner or
-- admin; the service; and a capture key that is current: made under the company's active broker authority and its key,
-- for the id the value keeps (none when the broker has not prepared it, or must make it again). Plain reads; writes
-- nothing.
create function public.qorpera_native_office_coding_value_capture(p_binding jsonb, p_scope jsonb, p_lease jsonb,
	p_envelope text, p_receipt_id uuid, p_idempotency_sha256 text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_operation jsonb;
	v_value jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_known public.qorpera_coding_value_services%rowtype;
	v_key public.qorpera_coding_value_capture_keys%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_named public.qorpera_cloud_secrets%rowtype;
	v_reserved public.qorpera_cloud_secrets%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
begin
	-- 20260930695000: the office's check of the call, then the run, the service and the capture key.
	perform public.qorpera_native_office_operation(p_binding, p_scope, p_lease, p_envelope, 'check', p_receipt_id,
		p_idempotency_sha256);
	v_operation := p_envelope::jsonb -> 'operation';
	v_value := v_operation #> '{arguments,codingValue}';
	if v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation #>> '{arguments,action}' is distinct from 'vault_capture'
		or jsonb_typeof(v_value) is distinct from 'object' then
		raise exception 'Invalid office coding value capture' using errcode = '42501'; end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Coding values need a company on the company folder' using errcode = '0A000'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (p_binding ->> 'runId')::uuid;
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Coding value authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) then
		raise exception 'This company is being deleted' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can save coding values; ask one of them' using errcode = '42501'; end if;
	select known.* into v_known from public.qorpera_coding_value_services as known where known.service = v_value ->> 'service';
	if not found then
		raise exception 'Invalid office coding value capture' using errcode = '42501'; end if;
	select capture.* into v_key from public.qorpera_coding_value_capture_keys as capture
	where capture.environment_id = v_run.environment_id and capture.secret_name = v_value ->> 'variable';
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = v_run.profile_id;
	select secret.* into v_named from public.qorpera_cloud_secrets as secret
	where secret.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
		and secret.owner_kind = 'company' and secret.connector_id = 'environment'
		and secret.secret_name = v_value ->> 'variable' and secret.status = 'active';
	select secret.* into v_reserved from public.qorpera_cloud_secrets as secret where secret.id = v_key.secret_id;
	if v_key.secret_id is null or v_authority.id is distinct from v_key.broker_authority_id
		or v_authority.key_id is distinct from v_key.key_id or v_authority.status is distinct from 'active'
		or (v_named.id is not null and v_named.id <> v_key.secret_id)
		or (v_named.id is null and v_reserved.id is not null) then
		raise exception 'The coding value''s capture key must be made again' using errcode = '55000'; end if;
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (p_lease #>> '{binding,companyComputerId}')::uuid;
	return jsonb_build_object(
		'schema', 'qorpera.coding-value-capture-target/v1',
		-- The page must be on the service's site, and the whole value match its pattern.
		'service', v_known.service,
		'site', v_known.site,
		'valuePattern', v_known.value_pattern,
		'variable', v_value ->> 'variable',
		-- What the box is bound to, and the key it is sealed to.
		'companyId', v_run.profile_id,
		'companyComputerId', v_office.id,
		'computerGeneration', v_office.generation,
		'receiptId', p_receipt_id,
		'capturePublicKey', v_key.public_key);
end
$$;
revoke all on function public.qorpera_native_office_coding_value_capture(jsonb, jsonb, jsonb, text, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_native_office_coding_value_capture(jsonb, jsonb, jsonb, text, uuid, text)
	to service_role;

-- 5. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_valid_office_browser_action(jsonb)',
		'public.qorpera_folder_coding_value_authority(uuid,text,jsonb)',
		'public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text,boolean)',
		'public.qorpera_folder_prepare_coding_value_capture(uuid,text,jsonb,uuid,text,text,uuid,text,text)',
		'public.qorpera_folder_read_coding_value_capture(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_folder_store_coding_value_capture(uuid,text,jsonb,uuid,text,text,uuid,bigint,uuid,uuid,text,bytea,text)',
		'public.qorpera_native_office_coding_value_capture(jsonb,jsonb,jsonb,text,uuid,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930695000') = 0 then
			raise exception '20260930695000 marker is missing in %', v_function; end if;
	end loop;
	if (select provolatile from pg_proc where oid = 'public.qorpera_valid_office_browser_action(jsonb)'::regprocedure) <> 's' then
		raise exception '20260930695000: the browser action check is not STABLE'; end if;
end $guard$;

drop function pg_temp.coding_value_capture_patch(regprocedure, text[]);
