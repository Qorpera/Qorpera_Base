-- Placement follows the member's identity home. A member's identity volume is
-- created and initialised on the node where that member logged in (credential
-- material never lives on shared disk, section 12.1), so a native run can only
-- start on a node that holds a login of its compute identity. The first live
-- cross-node run (16 Sep 2026, node 2) proved it: the run was placed on the
-- emptier node, the provider created an empty identity volume and the guest
-- bootstrap could not complete. Rule: native runs are placed on the least-
-- loaded eligible node among the identity's home nodes (nodes with a login
-- allocation for that identity); a claimant elsewhere is refused with
-- NODE_IDENTITY_ELSEWHERE; an identity without any home defers as before.
-- Login machines keep the plain least-loaded rule and thereby choose new homes.

create function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid,p_provider_kind text,p_provider_id text,p_compute_identity_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid; v_homes text[];
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind not in ('native','login','office')
		or coalesce(p_provider_id,'') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
		raise exception 'Node placement authority required' using errcode='42501'; end if;
	v_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);
	select c into v_self from jsonb_array_elements(v_candidates) c where c->>'providerId'=p_provider_id limit 1;
	if p_provider_kind='native' and p_compute_identity_id is not null then
		select coalesce(array_agg(distinct a.provider_adapter),'{}') into v_homes from public.qorpera_runtime_machine_allocations a
			where a.login_compute_identity_id=p_compute_identity_id;
		if v_self is null then
			v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
		elsif cardinality(v_homes)=0 then
			v_decision:='deferred'; v_reason:='NO_IDENTITY_HOME';
		elsif not (p_provider_id=any(v_homes)) then
			select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) and (c->>'eligible')::boolean and (c->>'fits')::boolean
				order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
			if v_preferred is null then select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) limit 1; end if;
			v_decision:='refused'; v_reason:='NODE_IDENTITY_ELSEWHERE';
		else
			select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) and (c->>'eligible')::boolean and (c->>'fits')::boolean
				order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
			if v_preferred is null then v_decision:='deferred'; v_reason:='NO_ELIGIBLE_HOME';
			elsif v_preferred->>'providerId'=p_provider_id then v_decision:='placed'; v_reason:='IDENTITY_HOME_LEAST_LOADED';
			else v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED'; end if;
		end if;
	else
		select c into v_preferred from jsonb_array_elements(v_candidates) c where (c->>'eligible')::boolean and (c->>'fits')::boolean
			order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
		if v_self is null then v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
		elsif v_preferred is null then v_decision:='deferred'; v_reason:='NO_ELIGIBLE_NODE';
		elsif v_preferred->>'providerId'=p_provider_id then v_decision:='placed'; v_reason:='LEAST_LOADED';
		else v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED'; end if;
	end if;
	v_node:=(v_self->>'nodeId')::uuid; v_preferred_node:=(v_preferred->>'nodeId')::uuid;
	insert into public.qorpera_runtime_node_placements(allocation_id,provider_kind,provider_id,node_id,decision,reason,preferred_node_id,candidates)
	values(p_allocation_id,p_provider_kind,p_provider_id,v_node,v_decision,v_reason,v_preferred_node,v_candidates)
	on conflict(allocation_id) do update set provider_id=excluded.provider_id,node_id=excluded.node_id,decision=excluded.decision,
		reason=excluded.reason,preferred_node_id=excluded.preferred_node_id,candidates=excluded.candidates,
		decided_at=clock_timestamp(),attempts=public.qorpera_runtime_node_placements.attempts+1;
	return jsonb_build_object('decision',v_decision,'reason',v_reason,'nodeId',v_node,'preferredNodeId',v_preferred_node,
		'preferredProviderId',v_preferred->>'providerId','identityHomes',to_jsonb(v_homes),'candidates',v_candidates);
end
$$;

-- The three-argument form stays for callers without an identity (login machines).
create or replace function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid,p_provider_kind text,p_provider_id text)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_runtime_node_placement_decide(p_allocation_id,p_provider_kind,p_provider_id,null::uuid);
$$;
grant execute on function public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid) to service_role;

alter table public.qorpera_runtime_login_machine_requests
	drop constraint qorpera_runtime_login_machine_requests_last_refusal_check,
	add constraint qorpera_runtime_login_machine_requests_last_refusal_check
		check(last_refusal in ('COMPANY_PAUSED','MACHINE_CAPACITY_EXHAUSTED','COMPUTE_IDENTITY_OCCUPIED','NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE'));

do $patch$
declare v_def text; v_old text;
begin
	v_def:=pg_get_functiondef('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure);
	v_old:='public.qorpera_runtime_node_placement_decide(p_allocation_id,''native'',p_provider_adapter)';
	if position(v_old in v_def)=0 then raise exception 'reserve_runtime_machine chooser call differs'; end if;
	execute replace(v_def,v_old,'public.qorpera_runtime_node_placement_decide(p_allocation_id,''native'',p_provider_adapter,v_run.compute_identity_id)');
end
$patch$;
