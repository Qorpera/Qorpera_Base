-- G2-3a: the guest's native host calls the database between jobs without the service-role key (the coordinator's G2,
-- 2026-10-03; design: one credential per holder). Inert until a node host binds credentials and a native host uses
-- them (G2-3b, G2-3c).
--
-- After G2-2 the native host still uses the service key for eight calls it makes outside a job: its identity's
-- recovery state and vault custody at startup, the account metadata loop (list, record), and a login guest's sign-in
-- and account refresh (describe and complete each). The key reaches every company. This adds a credential per holder
-- of an identity, minted by the node host, and one entry point the native host can call with the publishable key:
--   qorpera_native_identity_call(p_compute_identity_id, p_credential, p_name, p_args)     8 s
-- 1. The holder is a machine allocation the node host has just reserved: a job guest or an exec slot (a run
--    allocation, whose runner holds the identity) or a login guest (a sign-in or account refresh allocation of the
--    identity). The node host binds the credential's sha256 to it with qorpera_bind_native_identity_credential; only
--    the hash is stored, and a bind again replaces it, so the old credential fails at once. It ends when the
--    allocation is released, the identity is disabled or goes into recovery, or the runner is revoked or falls behind
--    the identity's recovery epoch.
-- 2. The entry point checks the credential first, by its hash and with no lock: its allocation is unreleased, the
--    identity is active, not in recovery and the allocation's company's, and for a runner its pinned recovery epoch is
--    the identity's. Every refusal is one 42501 "native identity call is refused".
-- 3. It allows only the calls listed in qorpera_native_identity_calls for the holder's kind (changed by migrations
--    only; no API role reads or writes it). A login guest, whose provider CLI can read its own files, gets only its
--    own sign-in or account refresh; a refresh's guest also gets its identity's account list and record (the refresh
--    is that list and record), never the identity's recovery state or vault custody. Whatever the call,
--    p_compute_identity_id and p_recovery_epoch must be the identity's, p_login_id the allocation's sign-in and
--    p_request_id its account refresh; a sign-in or refresh call's capability must be that sign-in's or refresh's, and
--    a sign-in's capsule reference the native host's own (native-capsule/<capsule id>, the id in lower-case canonical
--    form, as the host's account list reads it back).
-- 4. It calls the one public function of that name as G2-1's entry point does (qorpera_native_host_invoke: named plain
--    inputs, values through USING, as the platform's service caller on the function's own RPC path, no handler), with
--    authenticator's 8 s statement and lock budgets.
-- Also, from G2-3's inventory (both are the #575 pattern):
-- - qorpera_complete_native_provider_login checks the caller and the sign-in's capability before it locks the
--   sign-in, NULL-safe (before, a NULL capability completed the sign-in);
-- - the sign-in, identity and provider connection functions lose the anon (and, for the service-only ones,
--   authenticated) EXECUTE the default privileges left them.
--
-- Locks: none added on the call path. The checks read the credential, allocation, identity, runner, sign-in and
-- refresh rows without locks, before the called function takes its own. A first bind inserts one credential row, whose
-- foreign key takes KEY SHARE on the allocation row: a release or a reservation of that allocation (both FOR UPDATE)
-- waits for an open first bind, and a first bind's foreign key check waits for an open release or reservation. Neither
-- waits for anything else the other holds, so there is no cycle. A bind again (the ON CONFLICT update) leaves the key
-- unchanged and takes no KEY SHARE. No identity row is locked (no foreign key to it: recovery locks it FOR UPDATE).

set local lock_timeout = '3s';

create table public.qorpera_native_identity_credentials (
	allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete cascade,
	holder_kind text not null check (holder_kind in ('job_guest', 'exec_slot', 'login_guest')),
	compute_identity_id uuid not null,
	credential_sha256 text not null unique check (credential_sha256 ~ '^[0-9a-f]{64}$'),
	bound_at timestamptz not null default clock_timestamp()
);
revoke all on public.qorpera_native_identity_credentials from public, anon, authenticated, service_role;
alter table public.qorpera_native_identity_credentials enable row level security;

create table public.qorpera_native_identity_calls (
	name text primary key check (name ~ '^qorpera_[a-z0-9_]{1,120}$'),
	scope text not null check (scope in ('identity', 'login', 'account_refresh')),
	holder_kinds text[] not null check (cardinality(holder_kinds) > 0
		and holder_kinds <@ array['job_guest', 'exec_slot', 'login_guest'])
);
revoke all on public.qorpera_native_identity_calls from public, anon, authenticated, service_role;
alter table public.qorpera_native_identity_calls enable row level security;
insert into public.qorpera_native_identity_calls(name, scope, holder_kinds) values
	('qorpera_identity_recovery_runtime_state', 'identity', array['job_guest', 'exec_slot']),
	('qorpera_compute_identity_login_in_vault', 'identity', array['job_guest', 'exec_slot']),
	('qorpera_list_native_provider_account_refreshes', 'identity', array['job_guest', 'exec_slot', 'login_guest']),
	('qorpera_record_native_provider_account_metadata', 'identity', array['job_guest', 'exec_slot', 'login_guest']),
	('qorpera_describe_native_provider_login', 'login', array['login_guest']),
	('qorpera_complete_native_provider_login', 'login', array['login_guest']),
	('qorpera_describe_native_account_refresh_route', 'account_refresh', array['login_guest']),
	('qorpera_complete_native_account_refresh', 'account_refresh', array['login_guest']);

-- The node host binds a holder's credential right after it reserves the holder's machine.
create function public.qorpera_bind_native_identity_credential(p_allocation_id uuid, p_provider_adapter text,
	p_instance_sha256 text, p_holder_kind text, p_credential_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_identity uuid; v_count integer;
begin
	-- 20260930005000: the node host only, then the allocation by its primary key, with no lock.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Native identity credentials are bound by the node host' using errcode = '42501'; end if;
	if p_allocation_id is null or p_provider_adapter is null or p_instance_sha256 is null or p_holder_kind is null
		or p_credential_sha256 is null or p_credential_sha256 !~ '^[0-9a-f]{64}$'
		or p_holder_kind not in ('job_guest', 'exec_slot', 'login_guest') then
		raise exception 'Native identity credential binding is invalid' using errcode = '22023'; end if;
	select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
	where allocation.id = p_allocation_id;
	if not found or v_allocation.released_at is not null
		or v_allocation.provider_adapter is distinct from p_provider_adapter
		or v_allocation.instance_sha256 is distinct from p_instance_sha256 then
		raise exception 'Native identity credential allocation is unavailable' using errcode = '42501'; end if;
	-- The holder kind fits the allocation: a run allocation's runner for a job guest or an exec slot, a sign-in or
	-- account refresh allocation for a login guest. Office, coding and company machine allocations hold no identity.
	if p_holder_kind = 'login_guest' then
		v_identity := v_allocation.login_compute_identity_id;
	elsif v_allocation.runner_id is not null then
		select runner.compute_identity_id into v_identity from public.qorpera_runners as runner
		where runner.id = v_allocation.runner_id and runner.status is distinct from 'revoked';
	end if;
	if v_identity is null then
		raise exception 'Native identity credential allocation is unavailable' using errcode = '42501'; end if;
	-- A bind again (a re-reservation, or a new credential) replaces the hash; the holder's kind and identity stay.
	insert into public.qorpera_native_identity_credentials(allocation_id, holder_kind, compute_identity_id, credential_sha256)
	values (p_allocation_id, p_holder_kind, v_identity, p_credential_sha256)
	on conflict (allocation_id) do update set credential_sha256 = excluded.credential_sha256, bound_at = clock_timestamp()
	where qorpera_native_identity_credentials.holder_kind = excluded.holder_kind
		and qorpera_native_identity_credentials.compute_identity_id = excluded.compute_identity_id;
	get diagnostics v_count = row_count;
	if v_count <> 1 then
		raise exception 'Native identity credential allocation is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('allocationId', p_allocation_id, 'computeIdentityId', v_identity, 'holderKind', p_holder_kind);
end
$$;
revoke all on function public.qorpera_bind_native_identity_credential(uuid, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_bind_native_identity_credential(uuid, text, text, text, text) to service_role;

-- The call itself, shared with later entry points: the one public function of that name (named plain inputs, a single
-- scalar or void result), its values read from the JSON as PostgREST reads an RPC's arguments, run as the platform's
-- service caller on its own RPC path. No handler: its errors reach the caller unchanged. No role may call this.
create function public.qorpera_native_host_invoke(p_name text, p_args jsonb, p_refusal text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_function pg_catalog.pg_proc%rowtype; v_inputs text; v_columns text; v_sql text; v_result jsonb;
	v_claims text; v_claim_role text; v_path text;
begin
	select p.* into v_function from pg_catalog.pg_proc as p
	where p.pronamespace = 'public'::regnamespace and p.proname = p_name;
	if not found
		or (select count(*) from pg_catalog.pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = p_name) <> 1
		or v_function.prokind <> 'f' or v_function.proretset or v_function.proargmodes is not null
		or not (v_function.prorettype = 'void'::regtype or exists (select 1 from pg_catalog.pg_type as t
			where t.oid = v_function.prorettype and t.typtype in ('b', 'd', 'e')))
		or exists (select 1 from jsonb_object_keys(p_args) as k(key)
			where not (k.key = any(coalesce(v_function.proargnames[1:v_function.pronargs], '{}'::text[])))) then
		raise exception '%', p_refusal using errcode = '42501'; end if;
	select string_agg(format('%I => r.%I', a.name, a.name), ', ' order by a.position),
		string_agg(format('%I %s', a.name, pg_catalog.format_type(a.type, null)), ', ' order by a.position)
	into v_inputs, v_columns
	from unnest(v_function.proargnames[1:v_function.pronargs], v_function.proargtypes::oid[])
		with ordinality as a(name, type, position)
	where p_args ? a.name;
	v_sql := format('public.%I(%s)', p_name, coalesce(v_inputs, ''));
	v_sql := case when v_function.prorettype = 'void'::regtype then 'select ' || v_sql else format('select to_jsonb(%s)', v_sql) end
		|| case when v_inputs is null then '' else format(' from jsonb_to_record($1) as r(%s)', v_columns) end;
	v_claims := current_setting('request.jwt.claims', true);
	v_claim_role := current_setting('request.jwt.claim.role', true);
	v_path := current_setting('request.path', true);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.jwt.claim.role', 'service_role', true);
	perform set_config('request.path', '/rpc/' || p_name, true);
	if v_function.prorettype = 'void'::regtype then
		execute v_sql using p_args;
	else
		execute v_sql into v_result using p_args;
	end if;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
	perform set_config('request.path', coalesce(v_path, ''), true);
	return v_result;
end
$$;
revoke all on function public.qorpera_native_host_invoke(text, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_native_identity_dispatch(p_compute_identity_id uuid, p_credential text, p_name text,
	p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_credential public.qorpera_native_identity_credentials%rowtype;
	v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype; v_scope text; v_kinds text[];
begin
	-- 20260930005000: the credential first, by its hash and with no lock; NULL-safe throughout.
	if p_compute_identity_id is null or p_credential is null or p_credential !~ '^[A-Za-z0-9_-]{43}$'
		or p_name is null or p_name !~ '^qorpera_[a-z0-9_]{1,120}$' or jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'native identity call is refused' using errcode = '42501'; end if;
	select credential.* into v_credential from public.qorpera_native_identity_credentials as credential
	where credential.credential_sha256 = encode(extensions.digest(convert_to(p_credential, 'utf8'), 'sha256'), 'hex');
	if not found or v_credential.compute_identity_id is distinct from p_compute_identity_id then
		raise exception 'native identity call is refused' using errcode = '42501'; end if;
	select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
	where allocation.id = v_credential.allocation_id;
	select identity.* into v_identity from public.qorpera_member_compute_identities as identity
	where identity.id = p_compute_identity_id;
	if v_allocation.id is null or v_allocation.released_at is not null or v_identity.id is null
		or v_identity.status is distinct from 'active' or v_identity.recovery_pending_id is not null
		or v_identity.profile_id is distinct from v_allocation.profile_id
		or (case v_credential.holder_kind
			when 'login_guest' then v_allocation.login_compute_identity_id is not distinct from p_compute_identity_id
			else exists (select 1 from public.qorpera_runners as runner
				where runner.id = v_allocation.runner_id and runner.compute_identity_id = p_compute_identity_id
					and runner.status is distinct from 'revoked' and runner.compute_recovery_epoch = v_identity.recovery_epoch)
			end) is not true then
		raise exception 'native identity call is refused' using errcode = '42501'; end if;

	-- A call listed for this holder's kind, its arguments this holder's.
	select calls.scope, calls.holder_kinds into v_scope, v_kinds from public.qorpera_native_identity_calls as calls
	where calls.name = p_name;
	if v_scope is null or not (v_credential.holder_kind = any(v_kinds))
		or (v_scope = 'identity' and v_credential.holder_kind = 'login_guest' and v_allocation.account_refresh_request_id is null)
		or (p_args ? 'p_compute_identity_id' and p_args ->> 'p_compute_identity_id' is distinct from p_compute_identity_id::text)
		or (p_args ? 'p_recovery_epoch' and p_args ->> 'p_recovery_epoch' is distinct from v_identity.recovery_epoch::text)
		or (p_args ? 'p_login_id' and p_args ->> 'p_login_id' is distinct from v_allocation.login_session_id::text)
		or (p_args ? 'p_request_id' and p_args ->> 'p_request_id' is distinct from v_allocation.account_refresh_request_id::text)
		or (case v_scope
			when 'identity' then p_args ? 'p_compute_identity_id'
			when 'login' then p_args ? 'p_login_id' and exists (select 1 from public.qorpera_native_provider_login_sessions as login
				where login.id = v_allocation.login_session_id and login.compute_identity_id = p_compute_identity_id
					and login.capability_sha256 = p_args ->> 'p_capability_sha256')
				and (p_name <> 'qorpera_complete_native_provider_login'
					or (p_args ->> 'p_capsule_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
						and p_args ->> 'p_encrypted_capsule_reference' = 'native-capsule/' || (p_args ->> 'p_capsule_id')))
			when 'account_refresh' then p_args ? 'p_request_id' and exists (
				select 1 from public.qorpera_native_account_refresh_requests as request
				where request.id = v_allocation.account_refresh_request_id and request.compute_identity_id = p_compute_identity_id
					and request.capability_sha256 = p_args ->> 'p_capability_sha256')
			else false end) is not true then
		raise exception 'native identity call is refused' using errcode = '42501'; end if;
	return public.qorpera_native_host_invoke(p_name, p_args, 'native identity call is refused');
end
$$;
revoke all on function public.qorpera_native_identity_dispatch(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The entry point: the publishable key's alone, with authenticator's 8 s budgets (PostgREST applies a called
-- function's statement_timeout to its request; without it a call would get the publishable key's 3 s). None of the
-- listed calls sets a statement_timeout of its own.
create function public.qorpera_native_identity_call(p_compute_identity_id uuid, p_credential text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
	set statement_timeout = '8s' set lock_timeout = '8s' as $$
begin
	return public.qorpera_native_identity_dispatch(p_compute_identity_id, p_credential, p_name, p_args);
end
$$;
revoke all on function public.qorpera_native_identity_call(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_native_identity_call(uuid, text, text, jsonb) to anon;

-- A sign-in's capability before its lock, NULL-safe (patched at its exact text, so other changes are kept).
create function pg_temp.g23a_identity_patch(p_target regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $$
declare v_definition text := pg_catalog.pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor) <> 1 then
		raise exception 'G2-3a: the anchor in % is not there exactly once', p_target; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$$;
select pg_temp.g23a_identity_patch(
	'public.qorpera_complete_native_provider_login(uuid,text,uuid,text,text,text,text,text,jsonb,text)'::regprocedure,
$anchor$	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id
	for update;
$anchor$,
$replacement$	-- 20260930005000: the caller and the sign-in's capability first, by the sign-in's primary key and with no
	-- lock, NULL-safe (the #575 pattern): a call without them never waits for the sign-in below.
	if auth.role() is distinct from 'service_role' or p_login_id is null or p_capability_sha256 is null
		or not exists (select 1 from public.qorpera_native_provider_login_sessions as login
			where login.id = p_login_id and login.capability_sha256 = p_capability_sha256) then
		raise exception 'native provider login is unavailable' using errcode = '55000';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id
	for update;
$replacement$);

-- Execute rights the default privileges left open on the sign-in, identity and provider connection family.
-- Service-only functions lose anon and authenticated; member functions lose anon. Their bodies already refused these
-- callers.
revoke execute on function public.qorpera_describe_native_provider_login(uuid, text) from anon, authenticated;
revoke execute on function public.qorpera_describe_native_provider_login_route(uuid, text) from anon, authenticated;
revoke execute on function public.qorpera_begin_native_provider_login(uuid, uuid, uuid, uuid, text, text, text, integer)
	from anon;
revoke execute on function public.qorpera_revoke_native_provider_connection(uuid, uuid) from anon;
revoke execute on function public.qorpera_upsert_member_compute_identity(uuid, uuid, text, text, text, jsonb, jsonb) from anon;
revoke execute on function public.qorpera_upsert_scoped_compute_identity(uuid, uuid, text, text, text, text, text, jsonb, jsonb)
	from anon;
revoke execute on function public.qorpera_acquire_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer)
	from anon, authenticated;
revoke execute on function public.qorpera_renew_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer)
	from anon, authenticated;
revoke execute on function public.qorpera_release_native_provider_connection_lease(uuid, uuid, text, uuid, text, text)
	from anon, authenticated;
revoke execute on function public.qorpera_register_provider_connection(uuid, uuid, uuid, text, text, text, text, text, text, text,
	text, jsonb, boolean) from anon;
revoke execute on function public.qorpera_set_provider_connection_status(uuid, uuid, text) from anon;
