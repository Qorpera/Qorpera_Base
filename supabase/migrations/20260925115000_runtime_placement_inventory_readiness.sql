-- Fleet selection and final node admission must agree on complete inventory.
-- A hardware-only or superseded inventory observation cannot attract new work.
-- Retain one demand sum per node and exclude confirmed sleeping machines.
create or replace function public.qorpera_runtime_node_placement_candidates(p_provider_kind text)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'nodeId',c.node_id,'providerId',c.provider_id,'eligible',c.eligible,'fits',c.fits,'freeSlots',c.free_slots,
		'allocatedCpuMillis',c.allocated_cpu,'allocatedMemoryBytes',c.allocated_memory,'observedAt',c.observed_at)
		order by c.eligible desc,c.fits desc,c.free_slots desc,c.allocated_cpu asc,c.allocated_memory asc,c.node_id asc),'[]'::jsonb)
	from (
		select n.id as node_id,pr.provider_id,o.observed_at,u.allocated_cpu,u.allocated_memory,
			coalesce(n.enabled and o.node_id is not null and o.observed_at>clock_timestamp()-interval '60 seconds'
				and o.observed_at<=clock_timestamp()+interval '2 seconds' and o.observation->>'state'='ready'
				and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
				and (o.observation->>'cpuMillis')::bigint>=n.cpu_millis and (o.observation->>'memoryBytes')::bigint>=n.memory_bytes,false) as eligible,
			(u.allocated_cpu+pr.cpu_millis<=n.cpu_millis-n.headroom_cpu_millis
				and u.allocated_memory+pr.memory_bytes<=n.memory_bytes-n.headroom_memory_bytes) as fits,
			greatest(0,least((n.cpu_millis-n.headroom_cpu_millis-u.allocated_cpu)/n.standard_cpu_millis,
				(n.memory_bytes-n.headroom_memory_bytes-u.allocated_memory)/n.standard_memory_bytes))::bigint as free_slots
		from (
			select p.node_id,p.provider_id,max(p.cpu_millis) as cpu_millis,max(p.memory_bytes) as memory_bytes
			from public.qorpera_runtime_node_providers p where p.provider_kind=p_provider_kind group by p.node_id,p.provider_id
		) pr
		join public.qorpera_runtime_nodes n on n.id=pr.node_id
		left join public.qorpera_runtime_node_observations o on o.node_id=n.id
		cross join lateral (
			select coalesce(sum(d.cpu_millis),0)::bigint as allocated_cpu,coalesce(sum(d.memory_bytes),0)::bigint as allocated_memory
			from public.qorpera_runtime_node_demands d where d.node_id=n.id and d.reserved_at is not null
				and d.released_at is null and d.suspended_at is null
		) u
	) c;
$$;
