-- Each environment may use several executor hosts. Existing machines and NAS
-- writers retain custody; new member machines reserve physical capacity in
-- the same transaction that fixes their host, before any NAS folder is pinned.
alter table public.qorpera_coding_executors
	drop constraint qorpera_coding_executors_pkey,
	add primary key (environment_id, owner);

create or replace function public.qorpera_configure_coding_executor(p_environment_id uuid, p_owner text, p_enabled boolean,
	p_harnesses text[] default array['codex'])
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding deployment authority required' using errcode = '42501'; end if;
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses)
	values (p_environment_id, p_owner, p_enabled, p_harnesses)
	on conflict (environment_id, owner) do update set enabled = excluded.enabled, harnesses = excluded.harnesses, updated_at = clock_timestamp();
end
$$;

-- Exactly the scalar key order used by lxdCodingMachinePlan. Values are the
-- already validated deployment policy and UUID identities; no whitespace or
-- JSONB key ordering can change the physical instance digest.
create function public.qorpera_coding_machine_binding_text(p_binding jsonb)
returns text language sql immutable set search_path = '' as $$
	select '{' || string_agg(to_json(key)::text || ':' || (p_binding -> key)::text, ',' order by ordinal) || '}'
	from unnest(array['schema','machineId','companyId','environmentId','memberUserId','providerId','providerPolicySha256',
		'project','imageFingerprint','bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) with ordinality as keys(key, ordinal)
$$;

-- Read-only routing hint. The claim rechecks it under the member lock; the
-- plan then obtains a real node reservation. A stale hint never authorizes a
-- machine. Retained storage is a writer fence, even after its old VM is gone.
create function public.qorpera_coding_executor_pick(p_worker_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_owner text; v_owners text[];
begin
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id;
	if v_worker.id is null or v_session.worker_id is null then return null; end if;
	-- A turn retains its owner. Claim bypasses this hint only to record an
	-- expired turn's failure; another executor must never replay that turn.
	if v_session.phase in ('preparing','running','publishing') then return v_session.lease_owner; end if;
	select machine.owner into v_owner from public.qorpera_coding_machines machine
	where machine.environment_id = v_worker.environment_id and machine.profile_id = v_worker.profile_id
		and machine.member_user_id = v_worker.owner_user_id and machine.kind = 'member' and machine.removed_at is null;
	if v_owner is not null then return v_owner; end if;
	select array_agg(distinct volume.owner) into v_owners from public.qorpera_coding_storage_volumes volume
	where volume.environment_id = v_worker.environment_id and volume.member_user_id = v_worker.owner_user_id;
	if cardinality(v_owners) > 1 then return null; end if;
	if cardinality(v_owners) = 1 then return v_owners[1]; end if;
	select session.lease_owner into v_owner from public.qorpera_coding_sessions session
	join public.qorpera_runtime_workers worker on worker.id = session.worker_id
	where worker.environment_id = v_worker.environment_id and worker.owner_user_id = v_worker.owner_user_id
		and session.phase in ('preparing','running','publishing') and session.lease_until > clock_timestamp()
	order by session.started_at, session.worker_id limit 1;
	if v_owner is not null then return v_owner; end if;
	select executor.owner into v_owner from public.qorpera_coding_executors executor
	join public.qorpera_runtime_node_providers provider on provider.provider_kind = 'coding'
		and provider.provider_id = executor.vm_policy ->> 'providerId' and provider.policy_sha256 = executor.vm_policy ->> 'providerPolicySha256'
		and provider.cpu_millis = (executor.vm_policy ->> 'cpus')::bigint * 1000
		and provider.memory_bytes = (executor.vm_policy ->> 'memoryBytes')::bigint
	join public.qorpera_runtime_nodes node on node.id = provider.node_id and node.machine_id_sha256 = executor.nas_machine_id_sha256
	join public.qorpera_runtime_node_observations observation on observation.node_id = node.id
	cross join lateral (select coalesce(sum(d.cpu_millis), 0) as cpu, coalesce(sum(d.memory_bytes), 0) as memory
		from public.qorpera_runtime_node_demands d where d.node_id = node.id and d.reserved_at is not null
			and d.released_at is null and d.suspended_at is null) used
	where executor.environment_id = v_worker.environment_id and executor.enabled and v_session.harness = any(executor.harnesses)
		and executor.nas_policy is not null and node.enabled and observation.observed_at > clock_timestamp() - interval '60 seconds'
		and observation.observed_at <= clock_timestamp() + interval '2 seconds' and observation.observation ->> 'state' = 'ready'
		and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		and (observation.observation ->> 'cpuMillis')::bigint >= node.cpu_millis
		and (observation.observation ->> 'memoryBytes')::bigint >= node.memory_bytes
		and used.cpu + provider.cpu_millis <= node.cpu_millis - node.headroom_cpu_millis
		and used.memory + provider.memory_bytes <= node.memory_bytes - node.headroom_memory_bytes
	order by least((node.cpu_millis - node.headroom_cpu_millis - used.cpu) / provider.cpu_millis,
		(node.memory_bytes - node.headroom_memory_bytes - used.memory) / provider.memory_bytes) desc,
		used.cpu, used.memory, node.id, executor.owner limit 1;
	return v_owner;
end
$$;

-- Preserve the current turn-continuity implementation, including expired-turn
-- reporting. Add routing before the bounded candidate scan and recheck it
-- under the same per-member lock used by planning.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_claim_coding_session(text,integer)'::regprocedure);
	v_old text; v_new text;
begin
	v_old := E'\t\t\tand session.harness = any(executor.harnesses)';
	v_new := v_old || E'\n\t\t\tand ((session.phase in (''preparing'',''running'',''publishing'') and session.lease_until <= clock_timestamp())\n\t\t\t\tor public.qorpera_coding_executor_pick(session.worker_id) = p_owner)';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then raise exception 'Coding fleet claim candidates differ'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	v_old := E'\t\t\tif v_worker.state <> ''active'' then continue; end if;';
	v_new := v_old || E'\n\t\t\tperform pg_advisory_xact_lock(hashtextextended(''qorpera.coding-machine:'' || v_worker.environment_id::text || '':'' || v_worker.owner_user_id::text, 0));\n\t\t\tif not (v_session.phase in (''preparing'',''running'',''publishing'') and v_session.lease_until <= clock_timestamp())\n\t\t\t\tand public.qorpera_coding_executor_pick(v_worker.id) is distinct from p_owner then continue; end if;';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then raise exception 'Coding fleet claim lock differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

create or replace function public.qorpera_plan_coding_machine(p_worker_id uuid, p_lease_token uuid, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_executor public.qorpera_coding_executors%rowtype; v_machine public.qorpera_coding_machines%rowtype;
	v_binding text; v_node jsonb; v_result jsonb;
begin
	if coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	select * into v_executor from public.qorpera_coding_executors
	where environment_id = v_worker.environment_id and owner = v_session.lease_owner and enabled for share;
	if v_executor.vm_policy is null or v_executor.nas_policy is null or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-machine:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
	-- A session's old folders remain pinned after its VM has been deleted.
	if exists (select 1 from public.qorpera_coding_storage_volumes volume where volume.environment_id = v_worker.environment_id
		and volume.member_user_id = v_worker.owner_user_id
		and (volume.owner <> v_session.lease_owner or volume.machine_id_sha256 <> p_machine_id_sha256)) then
		return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
	select * into v_machine from public.qorpera_coding_machines where profile_id = v_worker.profile_id
		and environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id and kind = 'member' and removed_at is null for update;
	if v_machine.id is not null and exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_machine.id and released_at is not null) then
		update public.qorpera_coding_machines set removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp() where id = v_machine.id;
		v_machine := null;
	end if;
	if v_machine.id is not null then
		if v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256 then
			return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
		if v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
			if v_machine.instance_sha256 is null then
				update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
					'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_machine.id returning * into v_machine;
			else
				update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_machine.id returning * into v_machine;
			end if;
		end if;
		if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
			return jsonb_build_object('state','refused','reason','MACHINE_RETIRING','machineId',v_machine.id); end if;
	end if;
	if v_machine.instance_sha256 is null then
		if exists (select 1 from public.qorpera_coding_machines previous
			join public.qorpera_runtime_node_demands demand on demand.allocation_id = previous.id
			where previous.id = v_session.vm_allocation_id and previous.id is distinct from v_machine.id and previous.removed_at is null
				and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null) then
			return '{"state":"refused","reason":"PREVIOUS_MACHINE_AWAKE"}'::jsonb; end if;
		-- The exception block rolls the new plan/allocation back on any admission
		-- refusal. A full node never traps a new member on that node.
		begin
			-- Take the profile fence before the machine's foreign key obtains a
			-- key-share lock; parallel new members must not both upgrade that lock.
			perform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);
			if v_machine.id is null then
				v_machine.id := extensions.gen_random_uuid();
				insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
				values (v_machine.id, 'member', v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_session.lease_owner,
					p_machine_id_sha256, jsonb_build_object('schema','qorpera.lxd-coding-machine/v1','machineId',v_machine.id,
						'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'memberUserId',v_worker.owner_user_id) || v_executor.vm_policy)
				returning * into v_machine;
			end if;
			v_binding := public.qorpera_coding_machine_binding_text(v_machine.binding);
			update public.qorpera_coding_machines set instance_sha256 = encode(extensions.digest(convert_to(v_binding, 'utf8'), 'sha256'), 'hex')
			where id = v_machine.id returning * into v_machine;
			insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_machine_id, provider_adapter, instance_sha256)
			values (v_machine.id, v_machine.profile_id, v_machine.id, v_machine.binding ->> 'providerId', v_machine.instance_sha256);
			v_node := public.qorpera_reserve_runtime_node_machine(v_machine.id, 'coding', v_machine.binding ->> 'providerId',
				v_machine.binding ->> 'providerPolicySha256', v_machine.instance_sha256, p_machine_id_sha256,
				(v_machine.binding ->> 'cpus')::bigint * 1000, (v_machine.binding ->> 'memoryBytes')::bigint);
			if v_node ->> 'state' <> 'reserved' then raise sqlstate 'P0F01'; end if;
			-- Keeps the just-reserved machine live while its first turn prepares;
			-- housekeeping cannot stop it before the first run authority arrives.
			update public.qorpera_coding_sessions set vm_allocation_id = v_machine.id, updated_at = clock_timestamp() where worker_id = v_worker.id;
		exception when sqlstate 'P0F01' then return v_node;
		end;
	end if;
	v_result := jsonb_build_object('schema','qorpera.coding-machine-plan/v1','state','planned','machineId',v_machine.id,'binding',v_machine.binding);
	v_binding := public.qorpera_coding_machine_binding_text(v_machine.binding);
	-- Legacy digests keep their exact original binding text; do not silently
	-- canonicalize a different representation of an existing physical machine.
	if v_machine.instance_sha256 = encode(extensions.digest(convert_to(v_binding, 'utf8'), 'sha256'), 'hex') then
		v_result := v_result || jsonb_build_object('bindingText', v_binding); end if;
	return v_result;
end
$$;

-- Command ingress resolves an executor only after the normal turn/receipt
-- authorization. Addresses and credentials stay in trusted deployment config.
create function public.qorpera_route_coding_command(p_binding jsonb, p_scope jsonb, p_action text, p_command_id uuid, p_input_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_machine public.qorpera_coding_machines%rowtype;
begin
	v_authority := public.qorpera_authorize_coding_command(p_binding, p_scope, p_action, p_command_id, p_input_sha256);
	select * into v_machine from public.qorpera_coding_machines where id = (p_scope ->> 'vmId')::uuid;
	if v_machine.id is null or v_machine.removing_at is not null or v_machine.removed_at is not null
		or not exists (select 1 from public.qorpera_coding_executors executor where executor.environment_id = v_machine.environment_id
			and executor.owner = v_machine.owner and executor.nas_machine_id_sha256 = v_machine.machine_id_sha256)
		or not exists (select 1 from public.qorpera_runtime_machine_allocations allocation
			join public.qorpera_runtime_node_demands demand on demand.allocation_id = allocation.id
			join public.qorpera_runtime_nodes node on node.id = demand.node_id
			where allocation.id = v_machine.id and allocation.released_at is null and allocation.instance_sha256 = v_machine.instance_sha256
				and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null
				and node.machine_id_sha256 = v_machine.machine_id_sha256) then
		raise exception 'Coding command placement unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.coding-command-route/v1','executorOwner',v_machine.owner,
		'providerId',v_machine.binding ->> 'providerId','machineId',v_machine.id);
end
$$;

revoke all on function public.qorpera_coding_machine_binding_text(jsonb), public.qorpera_coding_executor_pick(uuid),
	public.qorpera_route_coding_command(jsonb,jsonb,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_route_coding_command(jsonb,jsonb,text,uuid,text) to service_role;
