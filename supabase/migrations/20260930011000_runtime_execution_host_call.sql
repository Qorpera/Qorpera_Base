-- G2-3e: the shared execution host calls the database without the service-role key (the coordinator's G2,
-- 2026-10-03: one credential per execution host). Inert until an execution host is bound and its service uses the
-- entry points (the package and scripts step after this).
--
-- The execution host's own service (shared-execution-cli.ts, not its slots) holds the service-role key today for
-- seven calls: a runner row per run, the company-ceiling reservation and its release, the ended-runner query, the
-- identity's recovery state and vault custody, and (G2-3c) the slot credential bind. The key reaches every company,
-- and the execution host runs every company's sandboxes. This adds one credential per execution host and two entry
-- points it can call with the publishable key:
--   qorpera_execution_host_call(p_host_id, p_credential, p_name, p_args)        8 s
--   qorpera_execution_host_call_long(p_host_id, p_credential, p_name, p_args)   25 s (the release, which sets 25 s)
-- 1. The node host mints the credential when it creates or rebuilds the execution host and binds its sha256 with
--    qorpera_bind_execution_host_credential(host, adapter, sha256); only the hash is stored, and a bind again (a
--    rebuild) replaces it, so the old credential fails at once. qorpera_revoke_execution_host_credential ends it.
-- 2. The entry points check the credential first, by its hash and with no lock. Every refusal is one 42501
--    "execution host call is refused".
-- 3. They allow only the calls listed in qorpera_execution_host_calls (changed by migrations only; no API role reads
--    or writes it), each through the entry point of its budget, each held to the host's own provider adapter:
--    - a runner row only for a run its adapter's orchestrator holds a live claim on;
--    - a reservation only of a run machine, for such a run and a runner of its adapter;
--    - a release only of its adapter's run machine allocation;
--    - the ended-runner query only for runners of its adapter;
--    - an identity's recovery state and vault custody only with the run it is read for (p_run_id, which the entry
--      point checks and removes): such a claimed run whose identity it is;
--    - a slot credential bind only as an exec slot, for its adapter's run machine allocation.
--    Whatever the call, p_provider_adapter must be the host's.
-- 4. They call the target as G2-3a's entry point does (qorpera_native_host_invoke).
--
-- Locks: none added on the call path. The checks read the principal (by its hash), claims (by run), orchestrators,
-- runners, runs and allocations (by primary key) without locks, before the called function takes its own. Binding
-- writes only the principal row.

set local lock_timeout = '3s';

create table public.qorpera_execution_host_principals (
	host_id text primary key check (host_id ~ '^[a-z][a-z0-9-]{0,62}$'),
	provider_adapter text not null check (provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
	credential_sha256 text not null unique check (credential_sha256 ~ '^[0-9a-f]{64}$'),
	bound_at timestamptz not null default clock_timestamp()
);
revoke all on public.qorpera_execution_host_principals from public, anon, authenticated, service_role;
alter table public.qorpera_execution_host_principals enable row level security;

create table public.qorpera_execution_host_calls (
	name text primary key check (name ~ '^qorpera_[a-z0-9_]{1,120}$'),
	scope text not null check (scope in ('run', 'reserve', 'release', 'runners', 'identity', 'bind')),
	budget text not null check (budget in ('standard', 'long'))
);
revoke all on public.qorpera_execution_host_calls from public, anon, authenticated, service_role;
alter table public.qorpera_execution_host_calls enable row level security;
insert into public.qorpera_execution_host_calls(name, scope, budget) values
	('qorpera_provision_execution_runner', 'run', 'standard'),
	('qorpera_reserve_runtime_machine', 'reserve', 'standard'),
	('qorpera_release_runtime_machine', 'release', 'long'),
	('qorpera_runtime_ended_runners', 'runners', 'standard'),
	('qorpera_identity_recovery_runtime_state', 'identity', 'standard'),
	('qorpera_compute_identity_login_in_vault', 'identity', 'standard'),
	('qorpera_bind_native_identity_credential', 'bind', 'standard');

-- The node host binds an execution host's credential when it creates or rebuilds the host.
create function public.qorpera_bind_execution_host_credential(p_host_id text, p_provider_adapter text,
	p_credential_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_count integer;
begin
	-- 20260930011000: the node host only.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Execution host credentials are bound by the node host' using errcode = '42501'; end if;
	if p_host_id is null or p_host_id !~ '^[a-z][a-z0-9-]{0,62}$'
		or p_provider_adapter is null or p_provider_adapter !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_credential_sha256 is null or p_credential_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Execution host credential binding is invalid' using errcode = '22023'; end if;
	-- A bind again (a rebuild) replaces the hash; the host's adapter stays.
	insert into public.qorpera_execution_host_principals(host_id, provider_adapter, credential_sha256)
	values (p_host_id, p_provider_adapter, p_credential_sha256)
	on conflict (host_id) do update set credential_sha256 = excluded.credential_sha256, bound_at = clock_timestamp()
	where qorpera_execution_host_principals.provider_adapter = excluded.provider_adapter;
	get diagnostics v_count = row_count;
	if v_count <> 1 then
		raise exception 'Execution host is bound to another provider adapter' using errcode = '42501'; end if;
	return jsonb_build_object('hostId', p_host_id, 'providerAdapter', p_provider_adapter);
end
$$;
revoke all on function public.qorpera_bind_execution_host_credential(text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_bind_execution_host_credential(text, text, text) to service_role;

create function public.qorpera_revoke_execution_host_credential(p_host_id text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
	-- 20260930011000: the node host only.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Execution host credentials are revoked by the node host' using errcode = '42501'; end if;
	delete from public.qorpera_execution_host_principals where host_id = p_host_id;
	return found;
end
$$;
revoke all on function public.qorpera_revoke_execution_host_credential(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_revoke_execution_host_credential(text) to service_role;

-- A uuid argument read from the JSON only when it is one (a malformed value is the entry point's refusal, never a
-- cast error).
create function public.qorpera_execution_host_uuid(p_args jsonb, p_key text)
returns uuid language sql immutable set search_path = '' as $$
	select case when jsonb_typeof(p_args -> p_key) = 'string'
		and p_args ->> p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then (p_args ->> p_key)::uuid end
$$;
revoke all on function public.qorpera_execution_host_uuid(jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether the host's adapter holds a live claim on the run: one of its orchestrators claimed the run's job and has
-- not released it.
create function public.qorpera_execution_host_claims_run(p_provider_adapter text, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$
	select exists (select 1 from public.qorpera_runner_job_claims as claim
		join public.qorpera_runner_orchestrators as orchestrator on orchestrator.id = claim.orchestrator_id
		where claim.run_id = p_run_id and claim.status in ('claimed', 'assigned', 'accepted')
			and orchestrator.provider_adapter = p_provider_adapter and orchestrator.status <> 'revoked')
$$;
revoke all on function public.qorpera_execution_host_claims_run(text, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_execution_host_dispatch(p_host_id text, p_credential text, p_name text, p_args jsonb,
	p_budget text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_host public.qorpera_execution_host_principals%rowtype; v_scope text; v_budget text; v_adapter text;
	v_run uuid; v_runner uuid; v_allocation uuid; v_identity uuid;
begin
	-- 20260930011000: the credential first, by its hash and with no lock; NULL-safe throughout.
	if p_host_id is null or p_host_id !~ '^[a-z][a-z0-9-]{0,62}$'
		or p_credential is null or p_credential !~ '^[A-Za-z0-9_-]{43}$'
		or p_name is null or p_name !~ '^qorpera_[a-z0-9_]{1,120}$' or jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'execution host call is refused' using errcode = '42501'; end if;
	select host.* into v_host from public.qorpera_execution_host_principals as host
	where host.credential_sha256 = encode(extensions.digest(convert_to(p_credential, 'utf8'), 'sha256'), 'hex');
	if not found or v_host.host_id is distinct from p_host_id then
		raise exception 'execution host call is refused' using errcode = '42501'; end if;
	v_adapter := v_host.provider_adapter;

	-- A call listed for this entry point's budget, its adapter the host's.
	select calls.scope, calls.budget into v_scope, v_budget from public.qorpera_execution_host_calls as calls
	where calls.name = p_name;
	v_run := public.qorpera_execution_host_uuid(p_args, 'p_run_id');
	v_runner := public.qorpera_execution_host_uuid(p_args, 'p_runner_id');
	v_allocation := public.qorpera_execution_host_uuid(p_args, 'p_allocation_id');
	v_identity := public.qorpera_execution_host_uuid(p_args, 'p_compute_identity_id');
	if v_scope is null or v_budget is distinct from p_budget
		or (p_args ? 'p_provider_adapter' and p_args ->> 'p_provider_adapter' is distinct from v_adapter)
		or (case v_scope
			-- A runner row for a run its adapter holds a live claim on.
			when 'run' then p_args ? 'p_provider_adapter' and v_run is not null
				and public.qorpera_execution_host_claims_run(v_adapter, v_run)
			-- A run machine for such a run and a runner of its adapter; never an office or a computer.
			when 'reserve' then p_args ? 'p_provider_adapter' and v_run is not null and v_runner is not null
				and p_args ->> 'p_office_id' is null and p_args ->> 'p_computer_generation' is null
				and public.qorpera_execution_host_claims_run(v_adapter, v_run)
				and exists (select 1 from public.qorpera_runners as runner
					where runner.id = v_runner and runner.provider_adapter = v_adapter)
			-- The release of its adapter's run machine.
			when 'release' then p_args ? 'p_provider_adapter' and v_allocation is not null
				and exists (select 1 from public.qorpera_runtime_machine_allocations as allocation
					where allocation.id = v_allocation and allocation.provider_adapter = v_adapter
						and allocation.runner_id is not null)
			-- Ended runners among runners of its adapter only.
			when 'runners' then jsonb_typeof(p_args -> 'p_runner_ids') = 'array'
				and jsonb_array_length(p_args -> 'p_runner_ids') between 1 and 512
				and not exists (select 1 from jsonb_array_elements(p_args -> 'p_runner_ids') as asked(value)
					where not exists (select 1 from public.qorpera_runners as runner
						where runner.provider_adapter = v_adapter
							and runner.id = public.qorpera_execution_host_uuid(jsonb_build_object('id', asked.value), 'id')))
			-- The identity of the run it is read for, a run its adapter holds a live claim on.
			when 'identity' then v_identity is not null and v_run is not null
				and exists (select 1 from public.qorpera_execution_runs as run
					where run.id = v_run and run.compute_identity_id = v_identity)
				and public.qorpera_execution_host_claims_run(v_adapter, v_run)
			-- A slot's credential, as an exec slot, for its adapter's run machine.
			when 'bind' then p_args ? 'p_provider_adapter' and v_allocation is not null
				and p_args ->> 'p_holder_kind' = 'exec_slot'
				and exists (select 1 from public.qorpera_runtime_machine_allocations as allocation
					where allocation.id = v_allocation and allocation.provider_adapter = v_adapter
						and allocation.runner_id is not null)
			else false end) is not true then
		raise exception 'execution host call is refused' using errcode = '42501'; end if;
	-- The run an identity is read for is the entry point's, not the call's.
	return public.qorpera_native_host_invoke(p_name,
		case when v_scope = 'identity' then p_args - 'p_run_id' else p_args end, 'execution host call is refused');
end
$$;
revoke all on function public.qorpera_execution_host_dispatch(text, text, text, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The entry points: the publishable key's alone, each with its budget (PostgREST applies a called function's
-- statement_timeout to its request). The release sets 25 s itself (20260913000100); the others set none.
create function public.qorpera_execution_host_call(p_host_id text, p_credential text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
	set statement_timeout = '8s' set lock_timeout = '8s' as $$
begin
	return public.qorpera_execution_host_dispatch(p_host_id, p_credential, p_name, p_args, 'standard');
end
$$;
create function public.qorpera_execution_host_call_long(p_host_id text, p_credential text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
	set statement_timeout = '25s' set lock_timeout = '25s' as $$
begin
	return public.qorpera_execution_host_dispatch(p_host_id, p_credential, p_name, p_args, 'long');
end
$$;
revoke all on function public.qorpera_execution_host_call(text, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_execution_host_call_long(text, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_execution_host_call(text, text, text, jsonb) to anon;
grant execute on function public.qorpera_execution_host_call_long(text, text, text, jsonb) to anon;
