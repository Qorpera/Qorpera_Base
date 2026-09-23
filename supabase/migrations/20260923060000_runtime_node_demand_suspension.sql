-- A powered-off company computer gives its node slot back (bundle v82).
--
-- Until now a company computer's node demand stayed reserved from its first
-- start until the computer was deleted: a stopped computer held its full CPU
-- and memory share. With the idle policy powering computers off after five
-- idle minutes, two stopped computers held 16 of node 1's 24 allocatable CPUs
-- and left room for two agent runs (2026-09-23).
--
-- Now:
--   * After the LXD stop of an explicit power-off is confirmed, the company
--     computer provider calls `qorpera_suspend_runtime_node_machine`. The
--     demand keeps its placement and its row; only `suspended_at` is set.
--     A reboot never suspends (it resumes at once), and a computer whose
--     resume has already been requested keeps its slot.
--   * Capacity accounting (reservation, capacity report, placement candidates,
--     node reconfiguration) counts reserved demands that are not suspended.
--     Inventory, reset, update-drain and reporting functions still see the
--     stopped computer: its VM and disks exist.
--   * Resume already reserves the node before power-on. A suspended demand is
--     admitted there like a new one: it is refused (NODE_CAPACITY_EXHAUSTED)
--     while the node is full, and the lifecycle service retries the resume on
--     its next pass. Admission clears `suspended_at`.
-- A released allocation still releases its demand through the existing
-- trigger; a released demand is never revived.

alter table public.qorpera_runtime_node_demands
	add column suspended_at timestamptz,
	add constraint qorpera_runtime_node_demands_suspension_check
		check (suspended_at is null or (reserved_at is not null and provider_kind = 'office'));

create function public.qorpera_suspend_runtime_node_machine(
	p_allocation_id uuid,
	p_provider_id text,
	p_policy_sha256 text,
	p_instance_sha256 text,
	p_machine_id_sha256 text,
	p_transition_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_node public.qorpera_runtime_nodes%rowtype;
	v_demand public.qorpera_runtime_node_demands%rowtype;
	v_node_id uuid;
	v_profile uuid;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_transition_id is null
		or p_provider_id is null or p_policy_sha256 is null or p_instance_sha256 is null or p_machine_id_sha256 is null then
		raise exception 'Node allocation authority required' using errcode = '42501';
	end if;
	-- Lock order as in reservation: profile fence -> company allocation -> node -> demand.
	select profile_id into v_profile from public.qorpera_runtime_machine_allocations where id = p_allocation_id;
	if not found then raise exception 'Company machine reservation required' using errcode = '42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id = p_allocation_id for update;
	if v_allocation.released_at is not null or v_allocation.office_id is null
		or v_allocation.instance_sha256 is distinct from p_instance_sha256
		or not exists (
			select 1 from public.qorpera_runtime_office_providers as provider
			where provider.office_id = v_allocation.office_id and provider.computer_generation = v_allocation.computer_generation
				and provider.provider_id::text = p_provider_id and provider.policy_sha256 = p_policy_sha256
		) then
		raise exception 'Company computer allocation differs' using errcode = '42501';
	end if;
	select * into v_transition from public.qorpera_runtime_office_lifecycle_transitions where id = p_transition_id;
	if not found or v_transition.office_id <> v_allocation.office_id or v_transition.allocation_id <> p_allocation_id
		or v_transition.request->>'action' is distinct from 'power_off' then
		raise exception 'Company computer power-off required' using errcode = '42501';
	end if;
	select node_id into v_node_id from public.qorpera_runtime_node_demands where allocation_id = p_allocation_id;
	if not found then
		return jsonb_build_object('state', 'kept', 'reason', 'NOT_RESERVED');
	end if;
	select * into strict v_node from public.qorpera_runtime_nodes where id = v_node_id for update;
	if v_node.machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Node host identity differs' using errcode = '42501';
	end if;
	select * into strict v_demand from public.qorpera_runtime_node_demands where allocation_id = p_allocation_id for update;
	if v_demand.provider_kind <> 'office' or v_demand.provider_id <> p_provider_id or v_demand.policy_sha256 <> p_policy_sha256 then
		raise exception 'Node placement differs' using errcode = '42501';
	end if;
	if v_demand.reserved_at is null or v_demand.released_at is not null then
		return jsonb_build_object('state', 'kept', 'reason', 'NOT_RESERVED');
	end if;
	if v_demand.suspended_at is not null then
		return jsonb_build_object('state', 'suspended', 'allocationId', p_allocation_id, 'nodeId', v_node.id,
			'suspendedAt', v_demand.suspended_at);
	end if;
	-- A requested resume (or any later lifecycle step) owns the slot again.
	if exists (select 1 from public.qorpera_runtime_office_boot_intents where transition_id = p_transition_id)
		or exists (
			select 1 from public.qorpera_runtime_office_lifecycle_transitions as later
			where later.office_id = v_allocation.office_id and later.id <> v_transition.id
				and later.requested_at > v_transition.requested_at
		) then
		return jsonb_build_object('state', 'kept', 'reason', 'RESUME_PENDING');
	end if;
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp()
	where allocation_id = p_allocation_id
	returning * into v_demand;
	return jsonb_build_object('state', 'suspended', 'allocationId', p_allocation_id, 'nodeId', v_node.id,
		'suspendedAt', v_demand.suspended_at);
end
$$;
revoke all on function public.qorpera_suspend_runtime_node_machine(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_suspend_runtime_node_machine(uuid, text, text, text, text, uuid) to service_role;

-- Capacity accounting skips suspended demands; reservation re-admits them.
-- Each anchor must occur exactly once in the current definition.
do $patch$
declare
	v_target record;
	v_definition text;
	v_pair text[];
begin
	for v_target in
		select * from (values
			('public.qorpera_runtime_node_capacity(uuid)', array[array[
				'where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null;',
				'where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null and d.suspended_at is null;']]),
			('public.qorpera_runtime_node_placement_candidates(text)', array[array[
				'from public.qorpera_runtime_node_demands d where d.node_id=n.id and d.reserved_at is not null and d.released_at is null',
				'from public.qorpera_runtime_node_demands d where d.node_id=n.id and d.reserved_at is not null and d.released_at is null and d.suspended_at is null']]),
			('public.qorpera_configure_runtime_node(jsonb,bigint)', array[array[
				'from public.qorpera_runtime_node_demands where node_id=v_id and reserved_at is not null and released_at is null;',
				'from public.qorpera_runtime_node_demands where node_id=v_id and reserved_at is not null and released_at is null and suspended_at is null;']]),
			('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', array[
				array['from public.qorpera_runtime_node_demands where node_id=v_node.id and reserved_at is not null and released_at is null;',
					'from public.qorpera_runtime_node_demands where node_id=v_node.id and reserved_at is not null and released_at is null and suspended_at is null;'],
				array['if v_demand.reserved_at is null and (v_cpu+v_demand.cpu_millis',
					'if (v_demand.reserved_at is null or v_demand.suspended_at is not null) and (v_cpu+v_demand.cpu_millis'],
				array['reserved_at=case when v_reason is null then coalesce(reserved_at,clock_timestamp()) else reserved_at end where allocation_id=p_allocation_id;',
					'reserved_at=case when v_reason is null then coalesce(reserved_at,clock_timestamp()) else reserved_at end,
  suspended_at=case when v_reason is null then null else suspended_at end where allocation_id=p_allocation_id;']])
		) as target(signature, pairs)
	loop
		v_definition := pg_get_functiondef(v_target.signature::regprocedure);
		foreach v_pair slice 1 in array v_target.pairs loop
			if (length(v_definition) - length(replace(v_definition, v_pair[1], ''))) / length(v_pair[1]) <> 1 then
				raise exception 'Node demand suspension anchor differs in %: %', v_target.signature, v_pair[1];
			end if;
			v_definition := replace(v_definition, v_pair[1], v_pair[2]);
		end loop;
		execute v_definition;
	end loop;
end
$patch$;
