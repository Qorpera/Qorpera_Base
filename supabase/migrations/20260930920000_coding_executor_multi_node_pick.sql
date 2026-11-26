set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines)') is not null then
		raise exception 'Multi-node coding executor pick (20260930920000) is already applied'; end if;
	if to_regprocedure('public.qorpera_coding_executor_pick(uuid)') is null
		or to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_coding_session_machine_repository(public.qorpera_coding_sessions)') is null
		or to_regprocedure('public.qorpera_coding_machine_full(public.qorpera_coding_machines,uuid,bigint,bigint,integer,boolean)') is null then
		raise exception 'Multi-node coding executor pick (20260930920000) needs 20260930837000 and 20260930910000 first';
	end if;
end $$;

create function pg_temp.cmnp_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930920000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- WHY: An awake machine already holds its node reservation, whereas waking a sleeping machine requires
-- free CPU and memory headroom on an enabled, ready node; checking this avoids trapping sessions on a full node.
create function public.qorpera_coding_machine_node_has_room(p_machine public.qorpera_coding_machines)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
	v_demand public.qorpera_runtime_node_demands%rowtype;
begin
	if p_machine.id is null or p_machine.removed_at is not null then
		return false;
	end if;
	select * into v_demand
	from public.qorpera_runtime_node_demands d
	where d.allocation_id = p_machine.id;
	if not found then
		return not exists (
			select 1 from public.qorpera_runtime_nodes node
			where node.machine_id_sha256 = p_machine.machine_id_sha256 and not node.enabled
		);
	end if;
	if v_demand.released_at is not null or v_demand.reserved_at is null then
		return false;
	end if;
	if v_demand.suspended_at is null then
		return exists (
			select 1 from public.qorpera_runtime_nodes node
			where node.id = v_demand.node_id and node.enabled
		);
	end if;
	return exists (
		select 1
		from public.qorpera_runtime_nodes node
		join public.qorpera_runtime_node_observations observation on observation.node_id = node.id
		cross join lateral (
			select coalesce(sum(d.cpu_millis), 0) as cpu, coalesce(sum(d.memory_bytes), 0) as memory
			from public.qorpera_runtime_node_demands d
			where d.node_id = node.id and d.reserved_at is not null
				and d.released_at is null and d.suspended_at is null
		) used
		where node.id = v_demand.node_id
			and node.enabled
			and observation.observed_at > clock_timestamp() - interval '60 seconds'
			and observation.observed_at <= clock_timestamp() + interval '2 seconds'
			and observation.observation ->> 'state' = 'ready'
			and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
			and (observation.observation ->> 'cpuMillis')::bigint >= node.cpu_millis
			and (observation.observation ->> 'memoryBytes')::bigint >= node.memory_bytes
			and used.cpu + v_demand.cpu_millis <= public.qorpera_runtime_node_cpu_budget(node)
			and used.memory + v_demand.memory_bytes <= node.memory_bytes - node.headroom_memory_bytes
	);
end $$;

create or replace function public.qorpera_coding_executor_pick(p_worker_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_owner text;
	v_repository text;
begin
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id;
	if v_worker.id is null or v_session.worker_id is null then return null; end if;
	-- WHY: An active turn retains its owner so another executor never replays it; claim bypasses this only to fail expired leases.
	if v_session.phase in ('preparing','running','publishing') then return v_session.lease_owner; end if;
	-- WHY: Only this session's own NAS volume pins it to a node; another session's volume must not block
	-- cross-node overflow or deadlock executor selection when a member spans multiple coding nodes.
	select volume.owner into v_owner
	from public.qorpera_coding_storage_volumes volume
	where volume.worker_id = v_worker.id
	limit 1;
	if v_owner is not null then return v_owner; end if;
	v_repository := public.qorpera_coding_session_machine_repository(v_session);
	if v_session.vm_allocation_id is not null then
		select machine.owner into v_owner
		from public.qorpera_coding_machines machine
		left join public.qorpera_coding_executors ce
			on ce.environment_id = machine.environment_id and ce.owner = machine.owner
		where machine.id = v_session.vm_allocation_id
			and machine.environment_id = v_worker.environment_id
			and machine.profile_id = v_worker.profile_id
			and machine.member_user_id = v_worker.owner_user_id
			and machine.kind = 'member'
			and machine.removed_at is null
			and (
				(v_session.attached_machine_id = machine.id
					and v_session.attached_at is not null
					and v_session.attachment_until > clock_timestamp())
				or (
					machine.retire_requested_at is null
					and machine.removing_at is null
					and ce.enabled
					and v_session.harness = any(ce.harnesses)
					and public.qorpera_coding_machine_node_has_room(machine)
					and (
						not (machine.binding ? 'cpus' and machine.binding ? 'memoryBytes')
						or not public.qorpera_coding_machine_full(
							machine, v_worker.id,
							ce.session_cpu_millis, ce.session_memory_bytes, ce.max_attached_sessions, false
						)
					)
				)
			)
		limit 1;
		if v_owner is not null then return v_owner; end if;
	end if;
	-- WHY: Scope machine affinity to the same repository and agent (plus legacy null-repository rows) and skip
	-- full, retiring, or sleeping-on-full-node machines so other repos and overflow VMs spread across the fleet.
	select machine.owner into v_owner
	from public.qorpera_coding_machines machine
	join public.qorpera_coding_executors ce
		on ce.environment_id = machine.environment_id and ce.owner = machine.owner
		and ce.enabled and v_session.harness = any(ce.harnesses)
	where machine.environment_id = v_worker.environment_id
		and machine.profile_id = v_worker.profile_id
		and machine.member_user_id = v_worker.owner_user_id
		and machine.kind = 'member'
		and machine.removed_at is null
		and machine.retire_requested_at is null
		and machine.removing_at is null
		and (
			machine.repository is null
			or (machine.repository = v_repository and machine.staff_agent_id is not distinct from v_worker.staff_agent_id)
		)
		and public.qorpera_coding_machine_node_has_room(machine)
		and (
			not (machine.binding ? 'cpus' and machine.binding ? 'memoryBytes')
			or not public.qorpera_coding_machine_full(
				machine, v_worker.id,
				ce.session_cpu_millis, ce.session_memory_bytes, ce.max_attached_sessions, true
			)
		)
	order by
		(machine.repository is null),
		exists (
			select 1 from public.qorpera_runtime_node_demands d
			where d.allocation_id = machine.id and d.suspended_at is not null
		),
		machine.number,
		machine.id
	limit 1;
	if v_owner is not null then return v_owner; end if;
	select session.lease_owner into v_owner
	from public.qorpera_coding_sessions session
	join public.qorpera_runtime_workers worker on worker.id = session.worker_id
	join public.qorpera_coding_executors ce
		on ce.environment_id = worker.environment_id and ce.owner = session.lease_owner
		and ce.enabled and v_session.harness = any(ce.harnesses)
	where worker.environment_id = v_worker.environment_id
		and worker.profile_id = v_worker.profile_id
		and worker.owner_user_id = v_worker.owner_user_id
		and worker.staff_agent_id is not distinct from v_worker.staff_agent_id
		and public.qorpera_coding_session_machine_repository(session) is not distinct from v_repository
		and session.worker_id <> v_worker.id
		and session.phase in ('preparing','running','publishing')
		and session.lease_until > clock_timestamp()
		and session.vm_allocation_id is null
		and session.claim_after is null
	order by session.started_at, session.worker_id
	limit 1;
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
		-- WHY: Agent exit health (20260930089100) gates only new placements; existing sessions/machines/volumes stay on their node.
		and public.qorpera_runtime_node_agent_exit_ready(node.id)
		and (observation.observation ->> 'cpuMillis')::bigint >= node.cpu_millis
		and (observation.observation ->> 'memoryBytes')::bigint >= node.memory_bytes
		and used.cpu + provider.cpu_millis <= public.qorpera_runtime_node_cpu_budget(node)
		and used.memory + provider.memory_bytes <= node.memory_bytes - node.headroom_memory_bytes
	-- WHY: A last-resort node (20260930749000) ranks below every regular node that fits.
	order by node.last_resort, least((public.qorpera_runtime_node_cpu_budget(node) - used.cpu) / provider.cpu_millis,
		(node.memory_bytes - node.headroom_memory_bytes - used.memory) / provider.memory_bytes) desc,
		used.cpu, used.memory, node.id, executor.owner limit 1;
	return v_owner;
end $$;

select pg_temp.cmnp_patch('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, array[
$old$			-- WHY: Only retirement or structural fullness (never a transient full_until hint) re-homes an already-homed detached session.
			if v_machine.retire_requested_at is not null or v_machine.removing_at is not null
				or public.qorpera_coding_machine_full(v_machine, v_worker.id,
					coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
					coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
					coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions), false) then$old$,
$new$			-- WHY: Only retirement, structural fullness, or an un-wakeable remote node re-homes an already-homed detached session.
			if v_machine.retire_requested_at is not null or v_machine.removing_at is not null
				or not public.qorpera_coding_machine_node_has_room(v_machine)
				or public.qorpera_coding_machine_full(v_machine, v_worker.id,
					coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
					coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
					coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions), false) then$new$,
$old$				if public.qorpera_coding_machine_full(v_candidate, v_worker.id,
					coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
					coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
					coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions), true) then
					continue; end if;$old$,
$new$				if not public.qorpera_coding_machine_node_has_room(v_candidate)
					or public.qorpera_coding_machine_full(v_candidate, v_worker.id,
						coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
						coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
						coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions), true) then
					continue; end if;$new$
]);

drop function pg_temp.cmnp_patch(regprocedure, text[]);

revoke all on function
	public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines),
	public.qorpera_coding_executor_pick(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_coding_executor_pick(uuid)'::regprocedure,
			'public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930920000: patched function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines) to %I',
			v_owner
		);
	end loop;
end $$;

comment on function public.qorpera_coding_machine_node_has_room(public.qorpera_coding_machines) is
	'20260930920000: internal helper checking whether an awake or sleeping coding machine can run or wake on its node.';
comment on function public.qorpera_coding_executor_pick(uuid) is
	'20260930920000: picks a coding executor using per-session volume affinity, per-repository non-full machine reuse with node headroom checks, and fleet capacity ranking.';
comment on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) is
	'20260930828000 (step 5k) / 20260930837000 / 20260930854000 (step 5h) / 20260930920000: plans sessions with active-only capacity accounting, cross-node overflow off full/un-wakeable nodes, detached re-homing, ready snapshot selection, and background snapshot build triggering.';
