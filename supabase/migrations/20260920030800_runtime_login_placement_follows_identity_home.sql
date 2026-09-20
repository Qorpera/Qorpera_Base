-- Logins and account refreshes are placed where the identity is usable.
--
-- Two functions place a login or refresh guest: the gateway chooser routes the
-- request to a node, and the placement decision admits the machine there. The
-- chooser already prefers the identity's home; the decision ignored homes for
-- logins and insisted on the least-loaded node. They agreed only while the home
-- happened to be the least-loaded node. After 20260920030700 made a home mean
-- "completed here at the current recovery epoch", the home and the least-loaded
-- node differed, the home's gateway was refused with NODE_NOT_PREFERRED, and no
-- machine was ever reserved (found live 2026-09-20).
--
-- The decision now takes the identity for logins and refreshes and prefers its
-- least-loaded eligible home, exactly like the chooser. Without an eligible home
-- it stays least-loaded, so a first login and a login during a home outage work
-- as before.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure), 'sha256'), 'hex') <> '0f922f08a9715809fc4c48151a301ad821fecd619c98dabce2d7bf19ced90853' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_node_placement_decide';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runtime_node_placement_decide(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid; v_homes text[];
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind not in ('native','login','office')
		or coalesce(p_provider_id,'') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
		raise exception 'Node placement authority required' using errcode='42501'; end if;
	v_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);
	select c into v_self from jsonb_array_elements(v_candidates) c where c->>'providerId'=p_provider_id limit 1;
	if p_provider_kind='login' and p_compute_identity_id is not null then
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
	elsif p_provider_kind='native' and p_compute_identity_id is not null then
		select coalesce(array_agg(distinct a.provider_adapter),'{}') into v_homes from public.qorpera_runtime_machine_allocations a
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(a)) identity_home on true
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
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '5a82b15f0fca087b16d3574ff3a4932e49c800b08dcb5f04d4ab6a1215f6dcf8' then
		raise exception 'Reviewed function definition changed: qorpera_reserve_runtime_login_machine';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reserve_runtime_login_machine(p_allocation_id uuid, p_provider_adapter text, p_instance_sha256 text, p_login_id uuid, p_capability_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_login public.qorpera_native_provider_login_sessions%rowtype;
 v_identity public.qorpera_member_compute_identities%rowtype;
 v_request public.qorpera_runtime_login_machine_requests%rowtype;
 v_allocation public.qorpera_runtime_machine_allocations%rowtype;
 v_role text; v_limit integer; v_count bigint; v_reason text; v_placement jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_login_id is null
  or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$'
  or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$'
  or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid login machine reservation' using errcode='42501'; end if;
 select * into v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 select * into v_identity from public.qorpera_member_compute_identities where id=v_login.compute_identity_id
  and profile_id=v_login.profile_id and status='active' for share;
 if not found then raise exception 'Login machine identity unavailable' using errcode='42501'; end if;
 select role into v_role from public.qorpera_profile_members where profile_id=v_login.profile_id
  and user_id=v_login.requested_by_user_id for share;
 if not found or not ((v_identity.ownership_kind='member' and v_identity.owner_user_id=v_login.requested_by_user_id)
  or (v_identity.ownership_kind<>'member' and v_role in ('owner','admin'))) then
  raise exception 'Login machine membership unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_provider_execution_policies where provider=v_login.provider
  and authentication_mode='native_subscription' and native_harness=v_login.native_harness
  and implementation_status='supported' and enablement_status='enabled' for share;
 if not found then raise exception 'Login machine provider unavailable' using errcode='42501'; end if;
 if v_login.status<>'pending' or v_login.expires_at<=clock_timestamp() then
  raise exception 'Login machine session unavailable' using errcode='42501'; end if;
 insert into public.qorpera_runtime_login_machine_requests(allocation_id,login_session_id,profile_id,compute_identity_id,provider_adapter,instance_sha256)
  values(p_allocation_id,p_login_id,v_login.profile_id,v_identity.id,p_provider_adapter,p_instance_sha256)
  on conflict(allocation_id) do nothing;
 select * into strict v_request from public.qorpera_runtime_login_machine_requests where allocation_id=p_allocation_id for update;
 if v_request.login_session_id<>p_login_id or v_request.profile_id<>v_login.profile_id or v_request.compute_identity_id<>v_identity.id
  or v_request.provider_adapter<>p_provider_adapter or v_request.instance_sha256<>p_instance_sha256 or v_request.released_at is not null then
  raise exception 'Login machine request cannot be rebound' using errcode='42501'; end if;
 select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
 if found and (v_allocation.profile_id<>v_login.profile_id or v_allocation.login_session_id is distinct from p_login_id
  or v_allocation.login_compute_identity_id is distinct from v_identity.id or v_allocation.provider_adapter<>p_provider_adapter
  or v_allocation.instance_sha256<>p_instance_sha256 or v_allocation.released_at is not null) then
  raise exception 'Login machine allocation cannot be rebound or revived' using errcode='42501'; end if;
 if public.qorpera_company_execution_paused(v_login.profile_id) then v_reason:='COMPANY_PAUSED';
 elsif exists(select 1 from public.qorpera_runtime_machine_allocations a left join public.qorpera_runners r on r.id=a.runner_id
  where a.profile_id=v_login.profile_id and a.released_at is null and a.id<>p_allocation_id
   and (a.login_compute_identity_id=v_identity.id or r.compute_identity_id=v_identity.id)) then
  v_reason:=case when public.qorpera_login_identity_releasing(v_login.profile_id,v_identity.id,p_allocation_id) then 'COMPUTE_IDENTITY_RELEASING' else 'COMPUTE_IDENTITY_OCCUPIED' end;
 elsif v_allocation.id is null then
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_login.profile_id),8) into v_limit;
  select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_login.profile_id and released_at is null;
  if v_count>=v_limit then v_reason:='MACHINE_CAPACITY_EXHAUSTED'; end if;
 end if;
 update public.qorpera_runtime_login_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_reason where allocation_id=p_allocation_id;
 if v_reason is not null then return jsonb_build_object('state','refused','reason',v_reason); end if;
 if v_allocation.id is null then
  v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,'login',p_provider_adapter,v_identity.id);
  if v_placement->>'decision'='refused' then
   update public.qorpera_runtime_login_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_placement->>'reason' where allocation_id=p_allocation_id;
   return jsonb_build_object('state','refused','reason',v_placement->>'reason','preferredNodeId',v_placement->>'preferredNodeId'); end if;
  insert into public.qorpera_runtime_machine_allocations(id,profile_id,login_session_id,login_compute_identity_id,provider_adapter,instance_sha256)
   values(p_allocation_id,v_login.profile_id,p_login_id,v_identity.id,p_provider_adapter,p_instance_sha256);
 end if;
 if v_login.expires_at<=clock_timestamp() then raise exception 'Login machine session expired' using errcode='42501'; end if;
 return jsonb_build_object('state','reserved','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> 'e1f1c5607aa321e694e35ea74abc0d2bd5b248f00eb67c6af8d056b2b5a8c10c' then
		raise exception 'Reviewed function definition changed: qorpera_reserve_runtime_account_refresh_machine';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reserve_runtime_account_refresh_machine(p_allocation_id uuid, p_provider_adapter text, p_instance_sha256 text, p_request_id uuid, p_capability_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_login public.qorpera_native_account_refresh_requests%rowtype;
 v_identity public.qorpera_member_compute_identities%rowtype;
 v_request public.qorpera_runtime_account_refresh_machine_requests%rowtype;
 v_allocation public.qorpera_runtime_machine_allocations%rowtype;
 v_role text; v_limit integer; v_count bigint; v_reason text; v_placement jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_request_id is null
  or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$'
  or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$'
  or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid login machine reservation' using errcode='42501'; end if;
 select * into v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 select * into v_identity from public.qorpera_member_compute_identities where id=v_login.compute_identity_id
  and profile_id=v_login.profile_id and status='active' for share;
 if not found then raise exception 'Login machine identity unavailable' using errcode='42501'; end if;
 select role into v_role from public.qorpera_profile_members where profile_id=v_login.profile_id
  and user_id=v_login.requested_by_user_id for share;
 if not found or v_role not in ('owner','admin','contributor') or not ((v_identity.ownership_kind='member' and v_identity.owner_user_id=v_login.requested_by_user_id)
  or (v_identity.ownership_kind<>'member' and v_role in ('owner','admin'))) then
  raise exception 'Login machine membership unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_provider_execution_policies where provider=v_login.provider
  and authentication_mode='native_subscription' and native_harness=v_login.native_harness
  and implementation_status='supported' and enablement_status='enabled' for share;
 if not found then raise exception 'Login machine provider unavailable' using errcode='42501'; end if;
 if v_login.status<>'pending' or v_login.expires_at<=clock_timestamp() then
  raise exception 'Login machine session unavailable' using errcode='42501'; end if;
 insert into public.qorpera_runtime_account_refresh_machine_requests(allocation_id,account_refresh_request_id,profile_id,compute_identity_id,provider_adapter,instance_sha256)
  values(p_allocation_id,p_request_id,v_login.profile_id,v_identity.id,p_provider_adapter,p_instance_sha256)
  on conflict(allocation_id) do nothing;
 select * into strict v_request from public.qorpera_runtime_account_refresh_machine_requests where allocation_id=p_allocation_id for update;
 if v_request.account_refresh_request_id<>p_request_id or v_request.profile_id<>v_login.profile_id or v_request.compute_identity_id<>v_identity.id
  or v_request.provider_adapter<>p_provider_adapter or v_request.instance_sha256<>p_instance_sha256 or v_request.released_at is not null then
  raise exception 'Login machine request cannot be rebound' using errcode='42501'; end if;
 select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
 if found and (v_allocation.profile_id<>v_login.profile_id or v_allocation.account_refresh_request_id is distinct from p_request_id
  or v_allocation.login_compute_identity_id is distinct from v_identity.id or v_allocation.provider_adapter<>p_provider_adapter
  or v_allocation.instance_sha256<>p_instance_sha256 or v_allocation.released_at is not null) then
  raise exception 'Login machine allocation cannot be rebound or revived' using errcode='42501'; end if;
 if public.qorpera_company_execution_paused(v_login.profile_id) then v_reason:='COMPANY_PAUSED';
 elsif exists(select 1 from public.qorpera_runtime_machine_allocations a left join public.qorpera_runners r on r.id=a.runner_id
  where a.profile_id=v_login.profile_id and a.released_at is null and a.id<>p_allocation_id
   and (a.login_compute_identity_id=v_identity.id or r.compute_identity_id=v_identity.id)) then
  v_reason:=case when public.qorpera_login_identity_releasing(v_login.profile_id,v_identity.id,p_allocation_id) then 'COMPUTE_IDENTITY_RELEASING' else 'COMPUTE_IDENTITY_OCCUPIED' end;
 elsif v_allocation.id is null then
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_login.profile_id),8) into v_limit;
  select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_login.profile_id and released_at is null;
  if v_count>=v_limit then v_reason:='MACHINE_CAPACITY_EXHAUSTED'; end if;
 end if;
 update public.qorpera_runtime_account_refresh_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_reason where allocation_id=p_allocation_id;
 if v_reason is not null then return jsonb_build_object('state','refused','reason',v_reason); end if;
 if v_allocation.id is null then
  v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,'login',p_provider_adapter,v_identity.id);
  if v_placement->>'decision'='refused' then
   update public.qorpera_runtime_account_refresh_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_placement->>'reason' where allocation_id=p_allocation_id;
   return jsonb_build_object('state','refused','reason',v_placement->>'reason','preferredNodeId',v_placement->>'preferredNodeId'); end if;
  insert into public.qorpera_runtime_machine_allocations(id,profile_id,account_refresh_request_id,login_compute_identity_id,provider_adapter,instance_sha256)
   values(p_allocation_id,v_login.profile_id,p_request_id,v_identity.id,p_provider_adapter,p_instance_sha256);
 end if;
 if v_login.expires_at<=clock_timestamp() then raise exception 'Login machine session expired' using errcode='42501'; end if;
 return jsonb_build_object('state','reserved','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$function$
;
