-- 2026-09-16 amendment (section 19): symmetric nodes and least-loaded placement.
-- A member execution machine (native run or login machine) is placed on the
-- enabled, healthy node with the most free standard slots; ties go to the
-- lowest allocated CPU, then memory, then node id. Providers stay bound to their
-- node and still claim work themselves: the chooser runs where a provider first
-- binds an allocation to its adapter, refuses a non-preferred claimant with
-- NODE_NOT_PREFERRED (the preferred node's provider claims on its next poll),
-- and records every decision with its candidates. Office starts keep their
-- per-generation provider binding (additional Company Computers are a separate
-- lifecycle operation). Providers without a node row keep the single-node
-- behaviour so an unregistered adapter is never silently refused.

create table public.qorpera_runtime_node_placements (
	-- The decision precedes the allocation row (a refused claimant never creates one), so no foreign key here.
	allocation_id uuid primary key,
	provider_kind text not null check(provider_kind in ('native','login','office')),
	provider_id text not null,
	node_id uuid references public.qorpera_runtime_nodes(id) on delete restrict,
	decision text not null check(decision in ('placed','refused','deferred','unbound')),
	reason text not null,
	preferred_node_id uuid references public.qorpera_runtime_nodes(id) on delete restrict,
	candidates jsonb not null,
	decided_at timestamptz not null default clock_timestamp(),
	attempts bigint not null default 1
);
alter table public.qorpera_runtime_node_placements enable row level security;
revoke all on public.qorpera_runtime_node_placements from anon, authenticated;
grant select, insert, update on public.qorpera_runtime_node_placements to service_role;

-- Candidates for one provider kind: every node carrying a provider of that
-- kind, with the same eligibility and free-slot arithmetic the capacity view
-- uses. Read-only; safe to call from any admission path.
create function public.qorpera_runtime_node_placement_candidates(p_provider_kind text)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'nodeId',c.node_id,'providerId',c.provider_id,'eligible',c.eligible,'fits',c.fits,'freeSlots',c.free_slots,
		'allocatedCpuMillis',c.allocated_cpu,'allocatedMemoryBytes',c.allocated_memory,'observedAt',c.observed_at)
		order by c.eligible desc,c.fits desc,c.free_slots desc,c.allocated_cpu asc,c.allocated_memory asc,c.node_id asc),'[]'::jsonb)
	from (
		select n.id as node_id,p.provider_id,o.observed_at,
			coalesce(sum(d.cpu_millis) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint as allocated_cpu,
			coalesce(sum(d.memory_bytes) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint as allocated_memory,
			(n.enabled and o.node_id is not null and o.observed_at>clock_timestamp()-interval '60 seconds'
				and o.observed_at<=clock_timestamp()+interval '2 seconds' and o.observation->>'state'='ready'
				and (o.observation->>'cpuMillis')::bigint>=n.cpu_millis and (o.observation->>'memoryBytes')::bigint>=n.memory_bytes) as eligible,
			(coalesce(sum(d.cpu_millis) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint+p.cpu_millis<=n.cpu_millis-n.headroom_cpu_millis
				and coalesce(sum(d.memory_bytes) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint+p.memory_bytes<=n.memory_bytes-n.headroom_memory_bytes) as fits,
			greatest(0,least((n.cpu_millis-n.headroom_cpu_millis-coalesce(sum(d.cpu_millis) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint)/n.standard_cpu_millis,
				(n.memory_bytes-n.headroom_memory_bytes-coalesce(sum(d.memory_bytes) filter (where d.reserved_at is not null and d.released_at is null),0)::bigint)/n.standard_memory_bytes)) ::bigint as free_slots
		from public.qorpera_runtime_node_providers p
		join public.qorpera_runtime_nodes n on n.id=p.node_id
		left join public.qorpera_runtime_node_observations o on o.node_id=n.id
		left join public.qorpera_runtime_node_demands d on d.node_id=n.id
		where p.provider_kind=p_provider_kind
		group by n.id,p.provider_id,p.cpu_millis,p.memory_bytes,o.node_id,o.observed_at,o.observation
	) c;
$$;

-- The decision for one claimant. Records the outcome and returns it.
create function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid,p_provider_kind text,p_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind not in ('native','login','office')
		or coalesce(p_provider_id,'') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
		raise exception 'Node placement authority required' using errcode='42501'; end if;
	v_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);
	select c into v_self from jsonb_array_elements(v_candidates) c where c->>'providerId'=p_provider_id limit 1;
	select c into v_preferred from jsonb_array_elements(v_candidates) c where (c->>'eligible')::boolean and (c->>'fits')::boolean
		order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
	if v_self is null then
		v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
	elsif v_preferred is null then
		-- No eligible node right now: the node-level reservation reports its own reason, as before.
		v_decision:='deferred'; v_reason:='NO_ELIGIBLE_NODE';
	elsif v_preferred->>'providerId'=p_provider_id then
		v_decision:='placed'; v_reason:='LEAST_LOADED';
	else
		v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED';
	end if;
	v_node:=(v_self->>'nodeId')::uuid; v_preferred_node:=(v_preferred->>'nodeId')::uuid;
	insert into public.qorpera_runtime_node_placements(allocation_id,provider_kind,provider_id,node_id,decision,reason,preferred_node_id,candidates)
	values(p_allocation_id,p_provider_kind,p_provider_id,v_node,v_decision,v_reason,v_preferred_node,v_candidates)
	on conflict(allocation_id) do update set provider_id=excluded.provider_id,node_id=excluded.node_id,decision=excluded.decision,
		reason=excluded.reason,preferred_node_id=excluded.preferred_node_id,candidates=excluded.candidates,
		decided_at=clock_timestamp(),attempts=public.qorpera_runtime_node_placements.attempts+1;
	return jsonb_build_object('decision',v_decision,'reason',v_reason,'nodeId',v_node,'preferredNodeId',v_preferred_node,
		'preferredProviderId',v_preferred->>'providerId','candidates',v_candidates);
end
$$;

grant execute on function public.qorpera_runtime_node_placement_candidates(text),
	public.qorpera_runtime_node_placement_decide(uuid,text,text) to service_role;

-- The login request's recorded refusal reasons gain the placement reasons.
alter table public.qorpera_runtime_login_machine_requests
	drop constraint qorpera_runtime_login_machine_requests_last_refusal_check,
	add constraint qorpera_runtime_login_machine_requests_last_refusal_check
		check(last_refusal in ('COMPANY_PAUSED','MACHINE_CAPACITY_EXHAUSTED','COMPUTE_IDENTITY_OCCUPIED','NODE_NOT_PREFERRED'));

-- Patch the two member-machine reservations in place: the chooser runs only when
-- a new allocation would be created for this claimant; existing allocations are
-- never rebound. The office path is untouched.
do $patch$
declare v_def text; v_marker text; v_declare text;
begin
	v_def:=pg_get_functiondef('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure);
	v_declare:='v_office public.qorpera_runtime_offices%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;';
	if position(v_declare in v_def)=0 then raise exception 'reserve_runtime_machine declare block differs'; end if;
	v_def:=replace(v_def,v_declare,v_declare||' v_placement jsonb;');
	v_marker:='		insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,office_id,computer_generation,provider_adapter,instance_sha256)';
	if position(v_marker in v_def)=0 then raise exception 'reserve_runtime_machine insert marker differs'; end if;
	v_def:=replace(v_def,v_marker,
		'		if p_run_id is not null then'||E'\n'||
		'			v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,''native'',p_provider_adapter);'||E'\n'||
		'			if v_placement->>''decision''=''refused'' then'||E'\n'||
		'				return jsonb_build_object(''state'',''refused'',''reason'',v_placement->>''reason'',''preferredNodeId'',v_placement->>''preferredNodeId''); end if;'||E'\n'||
		'		end if;'||E'\n'||v_marker);
	execute v_def;
	v_def:=pg_get_functiondef('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure);
	v_declare:='v_role text; v_limit integer; v_count bigint; v_reason text;';
	if position(v_declare in v_def)=0 then raise exception 'reserve_runtime_login_machine declare block differs'; end if;
	v_def:=replace(v_def,v_declare,v_declare||' v_placement jsonb;');
	v_marker:='  insert into public.qorpera_runtime_machine_allocations(id,profile_id,login_session_id,login_compute_identity_id,provider_adapter,instance_sha256)';
	if position(v_marker in v_def)=0 then raise exception 'reserve_runtime_login_machine insert marker differs'; end if;
	v_def:=replace(v_def,v_marker,
		'  v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,''login'',p_provider_adapter);'||E'\n'||
		'  if v_placement->>''decision''=''refused'' then'||E'\n'||
		'   update public.qorpera_runtime_login_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_placement->>''reason'' where allocation_id=p_allocation_id;'||E'\n'||
		'   return jsonb_build_object(''state'',''refused'',''reason'',v_placement->>''reason'',''preferredNodeId'',v_placement->>''preferredNodeId''); end if;'||E'\n'||v_marker);
	execute v_def;
end
$patch$;
