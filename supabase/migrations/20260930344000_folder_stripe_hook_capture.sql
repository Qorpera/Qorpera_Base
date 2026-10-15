-- Company folder core, C4 (E3c-1, Q1): Stripe hooks, with the secret taken from Stripe's screen
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8; agreed with the coordinator on 9 October 2026).
--
-- An agent's manage_hook opens a Stripe hook through the company's secret broker, as E3b (20260930160000) opens a GitHub
-- or HMAC one. Stripe makes the secret and shows it on the endpoint's page; the vault reads it off that page in the
-- company computer's browser and stores it, never types it, and never shows it to the model.
-- * A Stripe hook's secret_site is dashboard.stripe.com, the page its secret is taken from: manage_hook's create may name
--   only that site for Stripe, and the check on qorpera_event_hooks.secret_site allows it.
-- * qorpera_event_hook_capture_keys: a Stripe hook's capture key, made with the hook. The broker reserves the secret's
--   id and derives an X25519 key pair for it from the company's vault key; the row keeps the public half, which the guest
--   seals the captured secret to. No secret, version or audit row exists until the first capture stores one.
-- * E3b's effect takes a 10th argument, the capture key. Its callers:
--   - qorpera_folder_open_stripe_hook, the broker's: the capture key and no envelope;
--   - qorpera_folder_open_signed_hook (GitHub, HMAC): an envelope and no capture key;
--   - qorpera_folder_manage_hook, the host's: neither, so a Stripe proof is refused there as the other signed ones are
--     (0A000 'A signed hook is opened through the vault'). A member's qorpera_create_event_hook refuses it with the same
--     words.
-- * The key's renewal, after the company's broker authority or its key changed: qorpera_folder_describe_hook_capture_key
--   and qorpera_folder_replace_hook_capture_key, one audited step (hook_capture_key_replaced), refused once a version of
--   the hook's secret was sealed under the current key.
-- * A capture is one computer_browser call {action: vault_capture, role, name, hook, field: signing_secret}: the guest
--   clicks the named control that shows the secret, reads it and seals it to the hook's capture key.
--   - qorpera_native_office_hook_capture, the office's read (service_role): the office's own check of the call, then the
--     hook, its capture key and where the box goes. It writes nothing.
--   - qorpera_folder_read_hook_capture, the broker's: what the next version needs, the current version when it is sealed
--     for this authority (so the broker stores no unchanged value), and this receipt's capture if it stored one.
--   - qorpera_folder_store_hook_capture, the broker's: the next version (the first one makes the secret at the reserved
--     id, with E3b's columns), audited hook_secret_captured, once per receipt; a replay answers the stored version.
-- * Both broker calls share qorpera_folder_hook_capture_context, granted to no role, in the fill's order: the run check
--   with the hook (rank 5, FOR SHARE), the hook's capture key (FOR UPDATE, so one hook's captures take turns), the
--   computer (plain reads), the secret at the reserved id (FOR UPDATE), and last the receipt.
-- * qorpera_valid_office_browser_action accepts vault_capture. E3b's fill refuses a Stripe hook: the vault never types
--   its secret. The hook descriptor gives a Stripe secret's version, when it was captured, and the last delivery refused
--   under it.
-- Every inserted text names this migration (20260930344000), for the deploy guards.

do $$ begin
	if position('20260930280000' in pg_get_functiondef(
		'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'::regprocedure)) = 0 then
		raise exception 'E3c-1 (20260930344000) needs E4b (20260930280000)'; end if;
	if to_regclass('public.qorpera_event_hook_capture_keys') is not null then
		raise exception 'E3c-1 (20260930344000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

-- E3b's e3b_replace with several (old, new) pairs, applied in order: each old text occurs exactly once in the definition
-- as the earlier pairs left it. The result is executed once.
create function pg_temp.e3c_patch(p_function regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception 'E3c pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception 'E3c anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

-- 1. A Stripe hook's site and capture key, the vault's two new audit events, and their indexes -------------------------

alter table public.qorpera_event_hooks
	drop constraint qorpera_event_hooks_secret_site_check,
	add constraint qorpera_event_hooks_secret_site_check check (secret_site is null or (proof in ('github', 'hmac-sha256')
		and char_length(secret_site) <= 253
		and secret_site ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
		or (proof = 'stripe' and secret_site = 'dashboard.stripe.com'));
comment on column public.qorpera_event_hooks.secret_site is
	'20260930160000 (E3b): the site a signed hook''s secret may be typed into by the vault; null when the vault types none. 20260930344000 (E3c-1): a Stripe hook''s is dashboard.stripe.com, where the vault takes its secret from and never types it.';

-- The public key is checked by its shape only: a check runs with the writer's rights, and
-- qorpera_company_computer_fill_key_valid (which also refuses low-order points) is granted to no role. The functions
-- that write a key call it first.
create table public.qorpera_event_hook_capture_keys (
	hook_id uuid primary key references public.qorpera_event_hooks(id) on delete cascade,
	secret_id uuid not null unique,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_event_hook_capture_keys enable row level security;
revoke all on table public.qorpera_event_hook_capture_keys
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_event_hook_capture_keys is
	'20260930344000 (E3c-1): a Stripe hook''s capture key: the secret id the broker reserved, and the public half of the X25519 key it derived for that id under this authority''s key. The guest seals a captured secret to it.';

-- The event types as they stand (each bundle adds its own), and the two new ones.
do $$
declare v_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	if v_types is null or not 'hook_secret_used' = any(v_types) or 'hook_secret_captured' = any(v_types) then
		raise exception 'E3c-1: the audit event types differ: %', v_types; end if;
	-- An in (…) list, as A1's rebuilt it: it reads back as ARRAY['…'::text, …], which the reader above parses.
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['hook_secret_captured', 'hook_capture_key_replaced']) with ordinality as u(t, o)));
end $$;

-- One capture per receipt: the store's replay reads this row.
create unique index qorpera_cloud_secret_audit_events_hook_capture
	on public.qorpera_cloud_secret_audit_events (receipt_id)
	where event_type = 'hook_secret_captured';

-- The descriptor's last delivery refused under a hook's current secret version.
create index qorpera_event_deliveries_refused_under
	on public.qorpera_event_deliveries (hook_id, verify_secret_id, verify_secret_version, received_at desc)
	where status = 'refused';

-- 2. The run effect, with a Stripe hook's capture key ----------------------------------------------------------------------

select pg_temp.e3c_patch('public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text)'::regprocedure, array[
	$old$p_key_id text, p_envelope bytea, p_envelope_sha256 text)$old$,
	$new$p_key_id text, p_envelope bytea, p_envelope_sha256 text, p_capture_public_key text)$new$,
	$old$		if p_request ->> 'proof' = 'stripe' then
			raise exception 'A Stripe hook comes later: its secret is taken from Stripe''s screen' using errcode = '0A000'; end if;
		v_signed := coalesce(p_request ->> 'proof', 'address') in ('github', 'hmac-sha256');
		if not v_signed and p_request ? 'site' then
			raise exception 'Only a signed hook names the site its secret is typed into' using errcode = '22023'; end if;
		v_site := case when v_signed then coalesce(p_request ->> 'site',
			case when p_request ->> 'proof' = 'github' then 'github.com' end) end;
$old$,
	$new$		-- 20260930344000 (E3c-1): a Stripe hook is signed too. Its secret is taken from dashboard.stripe.com, the only
		-- site a Stripe request may name, and never typed.
		v_signed := coalesce(p_request ->> 'proof', 'address') in ('stripe', 'github', 'hmac-sha256');
		if not v_signed and p_request ? 'site' then
			raise exception 'Only a signed hook names the site its secret is typed into' using errcode = '22023'; end if;
		if p_request ->> 'proof' = 'stripe' and coalesce(p_request ->> 'site', 'dashboard.stripe.com') <> 'dashboard.stripe.com' then
			raise exception 'A Stripe hook''s secret is taken from dashboard.stripe.com' using errcode = '22023'; end if;
		v_site := case when v_signed then coalesce(p_request ->> 'site',
			case p_request ->> 'proof' when 'github' then 'github.com' when 'stripe' then 'dashboard.stripe.com' end) end;
$new$,
	$old$	if p_vault.id is not null and (p_secret_id is null or p_key_id is distinct from p_vault.key_id or p_envelope is null
		or octet_length(p_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_envelope, 'sha256'), 'hex')) then
		raise exception 'hook secret envelope is unavailable' using errcode = '42501'; end if;
$old$,
	$new$	-- 20260930344000 (E3c-1): a Stripe opening stores no secret (none exists before the first capture), only the hook's
	-- capture key: the public half of the key the broker derived for the reserved id under this authority's key.
	if p_vault.id is not null and p_request ->> 'proof' = 'stripe' and (p_secret_id is null
		or p_key_id is distinct from p_vault.key_id or p_envelope is not null or p_envelope_sha256 is not null
		or not coalesce(public.qorpera_company_computer_fill_key_valid(p_capture_public_key), false)) then
		raise exception 'hook capture key is unavailable' using errcode = '42501'; end if;
	if p_vault.id is not null and p_request ->> 'proof' is distinct from 'stripe' and (p_secret_id is null
		or p_key_id is distinct from p_vault.key_id or p_envelope is null
		or octet_length(p_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_envelope, 'sha256'), 'hex')
		or p_capture_public_key is not null) then
		raise exception 'hook secret envelope is unavailable' using errcode = '42501'; end if;
$new$,
	$old$				if v_signed and exists (select 1 from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id) then
					raise exception 'hook secret id is taken' using errcode = '42501'; end if;
$old$,
	$new$				-- 20260930344000 (E3c-1): nor with a Stripe hook's reserved id.
				if v_signed and (exists (select 1 from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id)
					or exists (select 1 from public.qorpera_event_hook_capture_keys as capture where capture.secret_id = p_secret_id)) then
					raise exception 'hook secret id is taken' using errcode = '42501'; end if;
$new$,
	$old$				-- A signed hook's secret, in the same step: the company's, bound to this hook by W1b's name, created by the
				-- run's requester, version 1 the broker's envelope under this authority's key.
				if v_signed then
$old$,
	$new$				-- 20260930344000 (E3c-1): a Stripe hook keeps its capture key instead, in the same step: no secret, version or
				-- audit row until the first capture stores one.
				if v_signed and v_hook.proof = 'stripe' then
					insert into public.qorpera_event_hook_capture_keys(hook_id, secret_id, broker_authority_id, key_id, public_key)
					values (v_hook.id, p_secret_id, p_vault.id, p_key_id, p_capture_public_key);
				-- A signed hook's secret, in the same step: the company's, bound to this hook by W1b's name, created by the
				-- run's requester, version 1 the broker's envelope under this authority's key.
				elsif v_signed then
$new$]);
revoke all on function public.qorpera_folder_manage_hook_effect(jsonb, jsonb, public.qorpera_cloud_secret_broker_authorities,
	uuid, uuid, uuid, text, bytea, text, text) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The host's path: still the effect with no vault (its grants stay).
create or replace function public.qorpera_folder_manage_hook(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930106000 (E3a), 20260930160000 (E3b): with no vault, a signed proof is refused.
	-- 20260930344000 (E3c-1): a Stripe one too, and no capture key comes in.
	return public.qorpera_folder_manage_hook_effect(p_binding, p_request, null::public.qorpera_cloud_secret_broker_authorities,
		null, null, null, null, null, null, null);
end $$;

-- The broker's GitHub and HMAC opening: E3b's, with no capture key (its grants stay).
create or replace function public.qorpera_folder_open_signed_hook(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_request jsonb,
	p_secret_id uuid,
	p_company_id uuid,
	p_environment_id uuid,
	p_key_id text,
	p_encrypted_envelope bytea,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
	-- 20260930160000 (E3b): the broker's checks before any lock, then manage_hook's effect with the vault.
	-- 20260930344000 (E3c-1): a GitHub or HMAC hook brings its envelope, never a capture key.
	return public.qorpera_folder_manage_hook_effect(p_binding, p_request,
		public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding),
		p_secret_id, p_company_id, p_environment_id, p_key_id, p_encrypted_envelope, p_envelope_sha256, null);
end
$$;

drop function public.qorpera_folder_manage_hook_effect(jsonb, jsonb, public.qorpera_cloud_secret_broker_authorities,
	uuid, uuid, uuid, text, bytea, text);

-- 3. The broker's calls ---------------------------------------------------------------------------------------------------

-- The broker opens a Stripe hook for the agent's manage_hook create: the effect with the vault and the hook's capture
-- key. The broker reserved the secret's id and derived the key for it under the run's company and environment, so all
-- three come in and must match.
create function public.qorpera_folder_open_stripe_hook(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_request jsonb,
	p_secret_id uuid,
	p_company_id uuid,
	p_environment_id uuid,
	p_key_id text,
	p_capture_public_key text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
	-- 20260930344000 (E3c-1): the broker's checks before any lock, then manage_hook's effect with the vault and no
	-- envelope.
	return public.qorpera_folder_manage_hook_effect(p_binding, p_request,
		public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding),
		p_secret_id, p_company_id, p_environment_id, p_key_id, null, null, p_capture_public_key);
end
$$;

-- Before it renews a Stripe hook's capture key the broker reads the hook's reserved id, what the key's derivation needs,
-- and whether the stored key is current (made under this authority and its key). The run check holds the hook (rank 5,
-- FOR SHARE); the run and its requester as manage_hook checks them. No receipt, no vault row.
create function public.qorpera_folder_describe_hook_capture_key(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_hook_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_targets jsonb := '[]'::jsonb;
	v_hook public.qorpera_event_hooks%rowtype;
	v_capture public.qorpera_event_hook_capture_keys%rowtype;
begin
	-- 20260930344000 (E3c-1): the broker's checks, the run check with the hook, the run and its requester, then the
	-- hook's capture key (a plain read).
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	-- The hook, from an unlocked read within the job's company (the lock target names no company): held FOR SHARE.
	if exists (select 1 from public.qorpera_runner_jobs as job
		join public.qorpera_event_hooks as hook on hook.profile_id = job.profile_id and hook.environment_id = job.environment_id
		where job.id = (p_binding ->> 'jobId')::uuid and hook.id = p_hook_id) then
		v_targets := jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', p_hook_id::text,
			'mode', 'share', 'required', false));
	end if;
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, v_targets) -> 'run');
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	-- The hook, read again under its lock: a live Stripe hook of the run's company, with its capture key.
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id then
		raise exception 'No hook has this id' using errcode = 'P0002'; end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000'; end if;
	select capture.* into v_capture from public.qorpera_event_hook_capture_keys as capture where capture.hook_id = v_hook.id;
	if v_hook.proof is distinct from 'stripe' or v_hook.secret_site is null or v_capture.hook_id is null then
		raise exception 'This hook takes no secret from a page' using errcode = '0A000'; end if;
	return jsonb_build_object('schema', 'qorpera.event-hook-capture-key/v1', 'hookId', v_hook.id,
		'secretId', v_capture.secret_id, 'companyId', v_run.profile_id, 'environmentId', v_run.environment_id,
		'keyId', v_authority.key_id,
		-- The broker's checks refused any authority but the company's active one.
		'current', v_capture.broker_authority_id = v_authority.id and v_capture.key_id = v_authority.key_id);
end
$$;

-- The renewal: a Stripe hook's capture key made again under the company's current authority and key, in one audited
-- step, while no version of the hook's secret is sealed under that key (a capture under it already proved the key).
-- The hook keeps its address and its reserved id.
create function public.qorpera_folder_replace_hook_capture_key(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb, p_hook_id uuid, p_key_id text, p_public_key text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_targets jsonb := '[]'::jsonb;
	v_hook public.qorpera_event_hooks%rowtype;
	v_capture public.qorpera_event_hook_capture_keys%rowtype;
begin
	-- 20260930344000 (E3c-1): the broker's checks and the new key before any lock, then the describe's checks, then the
	-- hook's capture key FOR UPDATE.
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	if p_key_id is distinct from v_authority.key_id
		or not coalesce(public.qorpera_company_computer_fill_key_valid(p_public_key), false) then
		raise exception 'hook capture key is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_runner_jobs as job
		join public.qorpera_event_hooks as hook on hook.profile_id = job.profile_id and hook.environment_id = job.environment_id
		where job.id = (p_binding ->> 'jobId')::uuid and hook.id = p_hook_id) then
		v_targets := jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', p_hook_id::text,
			'mode', 'share', 'required', false));
	end if;
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, v_targets) -> 'run');
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id then
		raise exception 'No hook has this id' using errcode = 'P0002'; end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000'; end if;
	select capture.* into v_capture from public.qorpera_event_hook_capture_keys as capture where capture.hook_id = v_hook.id
	for update;
	if v_hook.proof is distinct from 'stripe' or v_hook.secret_site is null or v_capture.hook_id is null then
		raise exception 'This hook takes no secret from a page' using errcode = '0A000'; end if;
	if v_capture.broker_authority_id = v_authority.id and v_capture.key_id = p_key_id and v_capture.public_key = p_public_key then
		return jsonb_build_object('schema', 'qorpera.event-hook-capture-key/v1', 'hookId', v_hook.id,
			'secretId', v_capture.secret_id, 'companyId', v_run.profile_id, 'environmentId', v_run.environment_id,
			'keyId', v_authority.key_id, 'current', true, 'replaced', false);
	end if;
	if exists (select 1 from public.qorpera_cloud_secret_versions as version
		where version.secret_id = v_capture.secret_id and version.broker_authority_id = v_authority.id
			and version.key_id = v_authority.key_id) then
		raise exception 'This hook''s secret was already taken under the current key' using errcode = '55000'; end if;
	update public.qorpera_event_hook_capture_keys as capture
	set broker_authority_id = v_authority.id, key_id = p_key_id, public_key = p_public_key, updated_at = statement_timestamp()
	where capture.hook_id = v_hook.id;
	-- The reserved id, with no version: the secret itself may not exist yet.
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_run.profile_id, v_run.environment_id, v_capture.secret_id, null, v_run.id, null, 'hook_capture_key_replaced',
		v_run.requested_by_user_id, 'event_hook');
	return jsonb_build_object('schema', 'qorpera.event-hook-capture-key/v1', 'hookId', v_hook.id,
		'secretId', v_capture.secret_id, 'companyId', v_run.profile_id, 'environmentId', v_run.environment_id,
		'keyId', v_authority.key_id, 'current', true, 'replaced', true);
end
$$;

-- The core of the broker's capture read and store, granted to no role: E3b's fill read, step for step, for a capture.
-- Bound to the agent's executing `computer_browser` receipt of exactly this `vault_capture` call (the broker passes the
-- call's operation envelope; its SHA-256 is the receipt's input digest) and the computer the run's screen lease holds,
-- at its current generation. The hook is the run's company's, live (active or paused) and a Stripe hook with its capture
-- key made under this authority; the run is a company agent's, its requester an owner or admin. Plain reads before any
-- lock; then the run check with the hook (rank 5, FOR SHARE, so a removal waits), the hook's capture key (FOR UPDATE: one
-- hook's captures take turns, so the second reads the first's version), the computer (plain reads), the secret at the
-- reserved id (FOR UPDATE; none before the first capture), and last the receipt. The caller ran the broker's checks.
create function public.qorpera_folder_hook_capture_context(
	p_authority public.qorpera_cloud_secret_broker_authorities,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text
)
returns table (
	run_id uuid,
	profile_id uuid,
	environment_id uuid,
	acting_user_id uuid,
	hook_id uuid,
	secret_id uuid,
	secret_name text,
	purpose text,
	current_version bigint,
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
	v_hook_id uuid;
	v_targets jsonb := '[]'::jsonb;
	v_office public.qorpera_runtime_offices%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_capture public.qorpera_event_hook_capture_keys%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930344000 (E3c-1): the call, the run check with the hook, the hook's capture key, the computer, the secret,
	-- then the receipt. Every column is named with its table: this function's answer names some of them too.
	if p_authority.id is null then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	-- The call itself: one vault_capture of a hook's secret off the company computer's browser, read before any lock.
	if p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'hook secret capture call is malformed' using errcode = '22023';
	end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'hook secret capture call is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation #>> '{target,realm}' is distinct from 'company_computer'
		or not coalesce(public.qorpera_valid_office_browser_action(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,action}' is distinct from 'vault_capture'
		or v_operation #>> '{arguments,field}' is distinct from 'signing_secret'
		or jsonb_typeof(v_target) is distinct from 'object'
		or coalesce(v_target ->> 'companyComputerId' !~ v_uuid, true)
		or coalesce(v_target ->> 'screenId' !~ v_uuid, true)
		or coalesce(v_target ->> 'computerGeneration' !~ '^[1-9][0-9]{0,15}$', true) then
		raise exception 'hook secret capture call is malformed' using errcode = '22023';
	end if;
	v_hook_id := (v_operation #>> '{arguments,hook}')::uuid;
	-- The hook, from an unlocked read within the job's company (the lock target names no company): held FOR SHARE.
	if exists (select 1 from public.qorpera_runner_jobs as job
		join public.qorpera_event_hooks as hook on hook.profile_id = job.profile_id and hook.environment_id = job.environment_id
		where job.id = (p_binding ->> 'jobId')::uuid and hook.id = v_hook_id) then
		v_targets := jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', v_hook_id::text,
			'mode', 'share', 'required', false));
	end if;
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, v_targets) -> 'run');
	if p_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- The run and its requester as manage_hook checks them: taking a hook's secret is part of opening it.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	-- The hook, read again under its lock.
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = v_hook_id;
	if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id then
		raise exception 'No hook has this id' using errcode = 'P0002'; end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000'; end if;
	if v_hook.proof is distinct from 'stripe' or v_hook.secret_site is null then
		raise exception 'This hook takes no secret from a page' using errcode = '0A000'; end if;
	-- The hook's capture key, made under this authority and its key: else the broker makes it again (the renewal).
	select capture.* into v_capture from public.qorpera_event_hook_capture_keys as capture where capture.hook_id = v_hook.id
	for update;
	if not found then
		raise exception 'This hook takes no secret from a page' using errcode = '0A000'; end if;
	if v_capture.broker_authority_id is distinct from p_authority.id or v_capture.key_id is distinct from p_authority.key_id then
		raise exception 'The hook''s capture key must be made again' using errcode = '55000'; end if;
	-- The computer the run's screen lease holds now, at the generation the call names: plain reads. The box is sealed to
	-- the hook's capture key, so no boot key is needed.
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
	-- The secret at the reserved id, after the hook (as a removal revokes it): the hook's own and live. Before the first
	-- capture there is none, and no other secret holds the hook's name.
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = v_capture.secret_id
	for update;
	if v_secret.id is not null and (v_secret.profile_id is distinct from v_run.profile_id
		or v_secret.environment_id is distinct from v_run.environment_id or v_secret.owner_kind is distinct from 'company'
		or v_secret.owner_user_id is not null or v_secret.connector_id is distinct from 'event_hook'
		or v_secret.secret_name is distinct from public.qorpera_event_hook_secret_name(v_hook.id)) then
		raise exception 'hook secret id is taken' using errcode = '42501'; end if;
	if v_secret.id is not null and v_secret.status is distinct from 'active' then
		raise exception 'This hook''s secret is gone from the vault' using errcode = '55000'; end if;
	if v_secret.id is null and (public.qorpera_event_hook_secret(v_hook)).id is not null then
		raise exception 'hook secret id is taken' using errcode = '42501'; end if;
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
		raise exception 'hook secret capture receipt is unavailable' using errcode = '42501';
	end if;
	return query select v_run.id, v_run.profile_id, v_run.environment_id, v_run.requested_by_user_id, v_hook.id,
		v_capture.secret_id, public.qorpera_event_hook_secret_name(v_hook.id), v_hook.purpose, v_secret.current_version,
		v_capture.key_id, v_capture.public_key, v_office.id, v_office.generation;
end
$$;
revoke all on function public.qorpera_folder_hook_capture_context(public.qorpera_cloud_secret_broker_authorities, jsonb, uuid,
	text, text) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker's read for one capture: what the box's associated data and the next version need. With the current version
-- when it is sealed for this authority (the broker compares the captured value with it and stores nothing when they are
-- the same), and with this receipt's stored version when it stored one already. Writes nothing.
create function public.qorpera_folder_read_hook_capture(
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
	-- 20260930344000 (E3c-1): the broker's checks, then the capture's checks and locks.
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	select context.* into strict v_context from public.qorpera_folder_hook_capture_context(v_authority, p_binding, p_receipt_id,
		p_envelope, p_downstream_idempotency_sha256) as context;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_context.secret_id and version.version = v_context.current_version;
	select audit.secret_version into v_captured from public.qorpera_cloud_secret_audit_events as audit
	where audit.receipt_id = p_receipt_id and audit.event_type = 'hook_secret_captured';
	return jsonb_build_object(
		'schema', 'qorpera.event-hook-capture-context/v1',
		'hookId', v_context.hook_id,
		'secretId', v_context.secret_id,
		'version', coalesce(v_context.current_version, 0) + 1,
		-- The associated data, for the broker to open the box and seal the next version.
		'companyId', v_context.profile_id,
		'environmentId', v_context.environment_id,
		'keyId', v_context.key_id,
		'capturePublicKey', v_context.capture_public_key,
		'receiptId', p_receipt_id,
		'field', 'signing_secret',
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

-- The broker's store for one capture: the next version of the hook's secret, once per receipt. The first capture makes
-- the secret at the reserved id with E3b's columns (the company's, W1b's name, the hook's purpose, created by the run's
-- requester), version 1; a later one adds a version as A1's accounts do. A replay answers the stored version. A version
-- that is no longer the next one, or a write that met another, is an outcome the broker cannot confirm (40003): it reads
-- again for the same receipt.
create function public.qorpera_folder_store_hook_capture(
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
begin
	-- 20260930344000 (E3c-1): the broker's checks, the capture's checks and locks, then this receipt's capture.
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	select context.* into strict v_context from public.qorpera_folder_hook_capture_context(v_authority, p_binding, p_receipt_id,
		p_envelope, p_downstream_idempotency_sha256) as context;
	select audit.* into v_audit from public.qorpera_cloud_secret_audit_events as audit
	where audit.receipt_id = p_receipt_id and audit.event_type = 'hook_secret_captured';
	if found then
		if v_audit.secret_id is distinct from v_context.secret_id or v_audit.run_id is distinct from v_context.run_id then
			raise exception 'hook secret capture receipt is unavailable' using errcode = '42501'; end if;
		return jsonb_build_object('schema', 'qorpera.event-hook-capture-stored/v1', 'hookId', v_context.hook_id,
			'secretId', v_audit.secret_id, 'version', v_audit.secret_version, 'replayed', true);
	end if;
	-- The envelope the broker sealed for the reserved id, the run's company and environment and this authority's key.
	if p_secret_id is distinct from v_context.secret_id or p_company_id is distinct from v_context.profile_id
		or p_environment_id is distinct from v_context.environment_id or p_key_id is distinct from v_authority.key_id
		or p_encrypted_envelope is null or octet_length(p_encrypted_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_encrypted_envelope, 'sha256'), 'hex') then
		raise exception 'hook secret envelope is unavailable' using errcode = '42501'; end if;
	-- The version the broker read, under the capture key's lock: still the next one.
	if p_version is distinct from coalesce(v_context.current_version, 0) + 1 then
		raise exception 'hook secret capture outcome is unconfirmed' using errcode = '40003'; end if;
	begin
		if v_context.current_version is null then
			insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
				owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
			values (p_secret_id, v_context.profile_id, v_context.environment_id, v_authority.id, 'company', null, 'event_hook',
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
			'hook_secret_captured', v_context.acting_user_id, 'event_hook');
	exception when unique_violation then
		raise exception 'hook secret capture outcome is unconfirmed' using errcode = '40003';
	end;
	return jsonb_build_object('schema', 'qorpera.event-hook-capture-stored/v1', 'hookId', v_context.hook_id,
		'secretId', p_secret_id, 'version', p_version, 'replayed', false);
end
$$;

revoke all on function public.qorpera_folder_open_stripe_hook(uuid, text, jsonb, jsonb, uuid, uuid, uuid, text, text),
	public.qorpera_folder_describe_hook_capture_key(uuid, text, jsonb, uuid),
	public.qorpera_folder_replace_hook_capture_key(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_read_hook_capture(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_store_hook_capture(uuid, text, jsonb, uuid, text, text, uuid, bigint, uuid, uuid, text, bytea, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_open_stripe_hook(uuid, text, jsonb, jsonb, uuid, uuid, uuid, text, text),
	public.qorpera_folder_describe_hook_capture_key(uuid, text, jsonb, uuid),
	public.qorpera_folder_replace_hook_capture_key(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_read_hook_capture(uuid, text, jsonb, uuid, text, text),
	public.qorpera_folder_store_hook_capture(uuid, text, jsonb, uuid, text, text, uuid, bigint, uuid, uuid, text, bytea, text)
	to qorpera_secret_broker;

-- 4. The office's read: where a capture's box goes --------------------------------------------------------------------------

-- The office reads the hook's capture key itself, through its registry, so the native host can never swap in its own.
-- First the office's own check of the call (qorpera_native_office_operation 'check', service_role only: the executing
-- computer_browser receipt of exactly this call, the run's screen lease on this computer and the resource its begin made),
-- then a live Stripe hook of the run's company, with a capture key made under the company's current broker authority and
-- no revoked secret, and a requester who is an owner or admin. A paused hook may be captured. Plain reads; writes
-- nothing.
create function public.qorpera_native_office_hook_capture(p_binding jsonb, p_scope jsonb, p_lease jsonb, p_envelope text,
	p_receipt_id uuid, p_idempotency_sha256 text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_operation jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_capture public.qorpera_event_hook_capture_keys%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
begin
	-- 20260930344000 (E3c-1): the office's check of the call, then the run, the hook and its capture key.
	perform public.qorpera_native_office_operation(p_binding, p_scope, p_lease, p_envelope, 'check', p_receipt_id,
		p_idempotency_sha256);
	v_operation := p_envelope::jsonb -> 'operation';
	if v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation #>> '{arguments,action}' is distinct from 'vault_capture'
		or v_operation #>> '{arguments,field}' is distinct from 'signing_secret' then
		raise exception 'Invalid office hook capture' using errcode = '42501'; end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Hooks need a company on the company folder' using errcode = '0A000'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (p_binding ->> 'runId')::uuid;
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook
	where hook.id = (v_operation #>> '{arguments,hook}')::uuid;
	if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id then
		raise exception 'No hook has this id' using errcode = 'P0002'; end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000'; end if;
	select capture.* into v_capture from public.qorpera_event_hook_capture_keys as capture where capture.hook_id = v_hook.id;
	if v_hook.proof is distinct from 'stripe' or v_hook.secret_site is null or v_capture.hook_id is null then
		raise exception 'This hook takes no secret from a page' using errcode = '0A000'; end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = v_run.profile_id;
	if v_authority.id is distinct from v_capture.broker_authority_id or v_authority.key_id is distinct from v_capture.key_id
		or v_authority.status is distinct from 'active' then
		raise exception 'The hook''s capture key must be made again' using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_cloud_secrets as secret
		where secret.id = v_capture.secret_id and secret.status <> 'active') then
		raise exception 'This hook''s secret is gone from the vault' using errcode = '55000'; end if;
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (p_lease #>> '{binding,companyComputerId}')::uuid;
	return jsonb_build_object(
		'schema', 'qorpera.event-hook-capture-target/v1',
		'hookId', v_hook.id,
		-- The page must show the hook's address, and be on its site.
		'address', v_hook.address,
		'site', v_hook.secret_site,
		-- What the box is bound to, and the key it is sealed to.
		'companyId', v_run.profile_id,
		'companyComputerId', v_office.id,
		'computerGeneration', v_office.generation,
		'receiptId', p_receipt_id,
		'field', 'signing_secret',
		'capturePublicKey', v_capture.public_key);
end
$$;
revoke all on function public.qorpera_native_office_hook_capture(jsonb, jsonb, jsonb, text, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_native_office_hook_capture(jsonb, jsonb, jsonb, text, uuid, text) to service_role;

-- 5. The fill, the descriptor, the browser action and a member's opening ----------------------------------------------------

select pg_temp.e3c_patch('public.qorpera_fill_event_hook_secret(uuid,text,jsonb,uuid,text,text)'::regprocedure, array[
	$old$	if v_hook.secret_site is null then
		raise exception 'This hook has no secret the vault types' using errcode = '0A000'; end if;
$old$,
	$new$	-- 20260930344000 (E3c-1): nor a Stripe hook's, which the vault takes from Stripe's screen and never types.
	if v_hook.secret_site is null or v_hook.proof = 'stripe' then
		raise exception 'This hook has no secret the vault types' using errcode = '0A000'; end if;
$new$]);

-- A Stripe secret's version, when it was captured, and the last delivery refused under it; jsonb_strip_nulls drops them
-- when they are null, so a GitHub or HMAC hook's signingSecret keeps its three keys.
select pg_temp.e3c_patch('public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure, array[
	$old$		-- A signed hook's secret: where a member saves it (the vault's capture), and whether it is there.
		'signingSecret', case when p_hook.proof in ('stripe', 'github', 'hmac-sha256') then jsonb_build_object(
			'connectorId', 'event_hook', 'secretName', public.qorpera_event_hook_secret_name(p_hook.id),
			'ready', (public.qorpera_event_hook_secret(p_hook)).id is not null) end,
$old$,
	$new$		-- A signed hook's secret: where a member saves it (the vault's capture), and whether it is there.
		-- 20260930344000 (E3c-1): for a Stripe hook also the version the vault captured, when, and the last delivery
		-- refused under it. The hook's secret is one row, all null when there is none.
		'signingSecret', case when p_hook.proof in ('stripe', 'github', 'hmac-sha256') then (select jsonb_build_object(
			'connectorId', 'event_hook', 'secretName', public.qorpera_event_hook_secret_name(p_hook.id),
			'ready', secret.id is not null,
			'version', case when p_hook.proof = 'stripe' then secret.current_version end,
			'capturedAt', case when p_hook.proof = 'stripe' then version.created_at end,
			'lastRefusal', case when p_hook.proof = 'stripe' then (select jsonb_build_object('receivedAt', delivery.received_at,
				'reason', delivery.reason) from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = p_hook.id and delivery.status = 'refused' and delivery.verify_secret_id = secret.id
					and delivery.verify_secret_version = secret.current_version
				order by delivery.received_at desc, delivery.id desc limit 1) end)
			from public.qorpera_event_hook_secret(p_hook) as secret
			left join public.qorpera_cloud_secret_versions as version
				on version.secret_id = secret.id and version.version = secret.current_version) end,
$new$]);

select pg_temp.e3c_patch('public.qorpera_valid_office_browser_action(jsonb)'::regprocedure, array[
	$old$    when 'press' then$old$,
	$new$    when 'vault_capture' then
        -- 20260930344000 (E3c-1): a hook's signing secret read off the sender's page into the vault, after a click on the
        -- control that shows it (a button or link).
        v_keys:=v_keys||array['role','name','hook','field'];
        if coalesce(p_args->>'role','') not in ('button','link')
            or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
            or octet_length(p_args->>'name')>512
            or jsonb_typeof(p_args->'hook') is distinct from 'string'
            or (p_args->>'hook') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or coalesce(p_args->>'field','') <> 'signing_secret' then return false; end if;
    when 'press' then$new$]);

select pg_temp.e3c_patch('public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'::regprocedure, array[
	$old$		if p_proof = 'stripe' then
			raise exception 'A Stripe hook comes later: its secret is taken from Stripe''s screen' using errcode = '0A000'; end if;
$old$,
	$new$		-- 20260930344000 (E3c-1): a Stripe hook is refused as the others are: the vault takes its secret from Stripe's screen
		-- when an agent opens it.
$new$]);

-- 6. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text,text)',
		'public.qorpera_folder_manage_hook(jsonb,jsonb)',
		'public.qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)',
		'public.qorpera_folder_open_stripe_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,text)',
		'public.qorpera_folder_describe_hook_capture_key(uuid,text,jsonb,uuid)',
		'public.qorpera_folder_replace_hook_capture_key(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_folder_hook_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text)',
		'public.qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_folder_store_hook_capture(uuid,text,jsonb,uuid,text,text,uuid,bigint,uuid,uuid,text,bytea,text)',
		'public.qorpera_native_office_hook_capture(jsonb,jsonb,jsonb,text,uuid,text)',
		'public.qorpera_fill_event_hook_secret(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)',
		'public.qorpera_valid_office_browser_action(jsonb)',
		'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930344000') = 0 then
			raise exception 'E3c-1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
