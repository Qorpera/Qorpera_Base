-- A routed login or account refresh is admitted by the node it was routed to.
--
-- A member login and an account refresh reach exactly one node: the gateway
-- chooser picks it (the identity's least-loaded routable home, else the
-- least-loaded node) and then keeps the request on that node for as long as its
-- machine request is open. The placement decision on that node ranked the homes
-- again and refused with NODE_NOT_PREFERRED whenever another home had more free
-- slots at that moment (found live 2026-09-19/20: every refresh of one member
-- was refused on node 1 for two hours while node 2 was never asked). A refused
-- job is claimed by another orchestrator later; a refused routed request has no
-- second destination, so the rule deadlocked instead of balancing.
--
-- Requires 20260920030700 and 20260920030800 (applied live as 20260920004700 and
-- 20260920004800: homes at the current recovery
-- epoch; login placement takes the identity). Three changes:
--  1. One routable-pick rule (qorpera_runtime_login_route_pick) and one home
--     rule (qorpera_runtime_login_identity_homes) serve both gateway choosers
--     and the placement decision, so they cannot drift apart again.
--  2. Placement of kind 'login' admits the asked node when it is eligible and
--     fits and is a home of the identity, or when no home is routable. It still
--     refuses a node that is not eligible or does not fit while another is, and
--     a non-home while a home is routable. Native (job dispatch) and office
--     placement, and every reservation refusal before placement (COMPANY_PAUSED,
--     COMPUTE_IDENTITY_OCCUPIED/RELEASING, MACHINE_CAPACITY_EXHAUSTED), are
--     untouched.
--  3. The choosers stop pinning a request to a node whose placement refused it
--     (no machine exists there), so such a request is routed afresh.

create function public.qorpera_runtime_login_route_pick(p_candidates jsonb, p_home_nodes uuid[])
returns jsonb language sql stable security definer set search_path='' as $$
	-- The least-loaded eligible candidate that fits and is reachable through a registered login
	-- gateway; restricted to p_home_nodes unless that is null.
	select c from jsonb_array_elements(p_candidates) c
		join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
		where (c->>'eligible')::boolean and (c->>'fits')::boolean and (p_home_nodes is null or (c->>'nodeId')::uuid = any(p_home_nodes))
		order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
		limit 1
$$;
revoke all on function public.qorpera_runtime_login_route_pick(jsonb,uuid[]) from public,anon,authenticated,service_role;

create function pg_temp.routed_placement_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Routed reservation placement source differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;

-- Placement: the declared state, then the login branch.
select pg_temp.routed_placement_patch('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure,
$old$declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid; v_homes text[];$old$,
$new$declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid; v_homes text[]; v_home_nodes uuid[]; v_home_pick jsonb;$new$);
select pg_temp.routed_placement_patch('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure,
$old$	if p_provider_kind='login' and p_compute_identity_id is not null then
		select coalesce(array_agg(distinct a.provider_adapter),'{}') into v_homes from public.qorpera_runtime_machine_allocations a
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(a)) identity_home on true
			where a.login_compute_identity_id=p_compute_identity_id;
		select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) and (c->>'eligible')::boolean and (c->>'fits')::boolean
			order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
	end if;
	if p_provider_kind='login' and v_preferred is not null then
		-- The gateway chooser sent this login or refresh to the identity's home.
		if v_self is null then v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
		elsif v_preferred->>'providerId'=p_provider_id then v_decision:='placed'; v_reason:='IDENTITY_HOME_LEAST_LOADED';
		else v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED'; end if;
$old$,
$new$	if p_provider_kind='login' then
		-- A login or account refresh reaches exactly one node: the one the gateway chooser routed it to
		-- (and keeps routing it to). The chooser already applied the least-loaded preference, so this
		-- node is admitted when it is eligible, fits and is a home of the identity, or when no home is
		-- routable. Another home with more free slots is no reason to refuse: nobody else will be asked.
		v_home_nodes:=public.qorpera_runtime_login_identity_homes(p_compute_identity_id);
		select coalesce(array_agg(distinct c->>'providerId'),'{}') into v_homes from jsonb_array_elements(v_candidates) c where (c->>'nodeId')::uuid=any(v_home_nodes);
		v_home_pick:=public.qorpera_runtime_login_route_pick(v_candidates,v_home_nodes);
		if v_self is null then v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
		elsif (v_self->>'eligible')::boolean and (v_self->>'fits')::boolean and ((v_self->>'nodeId')::uuid=any(v_home_nodes) or v_home_pick is null) then
			v_preferred:=v_self; v_decision:='placed';
			v_reason:=case when (v_self->>'nodeId')::uuid=any(v_home_nodes) then 'ROUTED_IDENTITY_HOME' else 'ROUTED_NODE_FITS' end;
		else
			v_preferred:=v_home_pick;
			if v_preferred is null then select c into v_preferred from jsonb_array_elements(v_candidates) c where (c->>'eligible')::boolean and (c->>'fits')::boolean
				order by (c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1; end if;
			if v_preferred is null then v_decision:='deferred'; v_reason:='NO_ELIGIBLE_NODE';
			else v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED'; end if;
		end if;
$new$);

-- Choosers: the shared pick, and no pin on a node whose placement refused the request.
do $patch$
declare v_target regprocedure;
begin
	foreach v_target in array array[
		'public.qorpera_runtime_login_gateway_choose(text)'::regprocedure,
		'public.qorpera_runtime_account_refresh_gateway_choose(text)'::regprocedure
	] loop
		perform pg_temp.routed_placement_patch(v_target,
$old$		select c into v_pick from jsonb_array_elements(v_candidates) c
			join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
			where (c->>'eligible')::boolean and (c->>'fits')::boolean and (c->>'nodeId')::uuid = any(v_homes)
			order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
			limit 1;
$old$,
$new$		v_pick := public.qorpera_runtime_login_route_pick(v_candidates, v_homes);
$new$);
		perform pg_temp.routed_placement_patch(v_target,
$old$		select c into v_pick from jsonb_array_elements(v_candidates) c
			join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
			where (c->>'eligible')::boolean and (c->>'fits')::boolean
			order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
			limit 1;
$old$,
$new$		v_pick := public.qorpera_runtime_login_route_pick(v_candidates, null);
$new$);
	end loop;
end
$patch$;
select pg_temp.routed_placement_patch('public.qorpera_runtime_login_gateway_choose(text)'::regprocedure,
$old$			where r.login_session_id = v_session.id and r.released_at is null
$old$,
$new$			where r.login_session_id = v_session.id and r.released_at is null and r.last_refusal is distinct from 'NODE_NOT_PREFERRED'
$new$);
select pg_temp.routed_placement_patch('public.qorpera_runtime_account_refresh_gateway_choose(text)'::regprocedure,
$old$			where r.account_refresh_request_id = v_session.id and r.released_at is null
$old$,
$new$			where r.account_refresh_request_id = v_session.id and r.released_at is null and r.last_refusal is distinct from 'NODE_NOT_PREFERRED'
$new$);
drop function pg_temp.routed_placement_patch(regprocedure,text,text);

-- The patched functions keep their owner and grants; assert the integration landed.
do $assert$
declare v_target regprocedure; v_definition text;
begin
	v_definition:=pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure);
	if strpos(v_definition,'ROUTED_IDENTITY_HOME')=0 or strpos(v_definition,'qorpera_runtime_login_identity_homes(p_compute_identity_id)')=0
		or strpos(v_definition,'NODE_IDENTITY_ELSEWHERE')=0 or strpos(v_definition,'NO_ELIGIBLE_HOME')=0 then
		raise exception 'Routed reservation placement did not land'; end if;
	foreach v_target in array array[
		'public.qorpera_runtime_login_gateway_choose(text)'::regprocedure,
		'public.qorpera_runtime_account_refresh_gateway_choose(text)'::regprocedure
	] loop
		v_definition:=pg_get_functiondef(v_target);
		if (length(v_definition)-length(replace(v_definition,'qorpera_runtime_login_route_pick','')))/length('qorpera_runtime_login_route_pick')<>2
			or strpos(v_definition,'qorpera_runtime_login_identity_homes(v_session.compute_identity_id)')=0 then
			raise exception 'Routed reservation chooser did not land: %',v_target; end if;
	end loop;
end
$assert$;
