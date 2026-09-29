-- A run's attempt whose machine failed to start moves on (found in production on 2026-09-29, A1).
--
-- Each attempt of a run has one runner, provisioned under the attempt's acquisition id by whichever node
-- acquires it. The same id names the attempt's machine allocation, and a runner holds one allocation ever
-- (runner_id is unique). When a provider reserved a machine for the attempt and its start then failed,
-- the provider released the machine, but the runner stayed pending and bound to it. The claim release
-- counted an infrastructure failure and left the attempt as it was, so every retry asked for the same
-- runner: the other node's provider was refused it (23505 "runner client id is already bound to other
-- compute authority"), the failed node's own provider cannot replay its stopped acquisition, and the run
-- failed after eight dispatch failures. The attempt count only rose when a runner accepted an assignment.
--
-- Now, when a claim release counts an infrastructure failure and the attempt's allocation (found by its
-- primary key, the attempt's acquisition id) is released while its runner is still pending, the runner is
-- revoked (it can never activate), the job's attempt count rises and the node that failed is recorded for
-- the run. The next claim gets the next attempt: a new acquisition id, runner, allocation and placement row.
-- - A placement refusal (ADMISSION_REFUSED:*) never does this.
-- - A runner without an allocation keeps the rebind of 20260928235000.
-- - An allocation not yet released (its machine may still exist) is left to its provider, and every
--   orchestrator waits 15 seconds so the provider can release it (a node that releases on its next reconcile,
--   the LXD provider, would otherwise see its retries used up by the other node's refusals); the next
--   failure then moves the attempt on.
-- - If the attempt count reaches its cap (8), the job fails at once instead of waiting unclaimable.
--
-- The node chooser (native runs) and the claim turn's placement (runs with dispatch roles) rank the node
-- where the run's previous attempt failed to start after every other eligible node that fits; when it is
-- the only one, the run still goes there. The next attempt is queued again (queued_at), so the claim turn's
-- head start goes to the node the placement names.
--
-- Locks: the release takes the job row, the claim and the assignment (as before), then the runner row; it
-- reads the allocation and its placement by primary key and writes the run's failure row last. The runner
-- receipt's foreign key takes a key-share lock on the company's profile row, after the job row, the same
-- order as a reservation (job, then the company fence). A reservation reads the failure row by the run id
-- it already holds.
set local lock_timeout = '3s';

-- The attempt's acquisition id exactly as the providers derive it (runAttemptAcquisitionId in
-- packages/runner-orchestrator/src/provider-shared.ts): the run id for the first attempt, then a UUID made
-- from sha256("qorpera.lxd-run-attempt/v1:<run id>:<attempt>").
create function public.qorpera_run_attempt_acquisition_id(p_run_id uuid, p_attempt integer)
returns uuid language sql immutable strict set search_path = '' as $$
	select case when p_attempt = 1 then p_run_id else (
		substr(hashed.d, 1, 8) || '-' || substr(hashed.d, 9, 4) || '-8' || substr(hashed.d, 14, 3) || '-'
		|| to_hex(((('x' || substr(hashed.d, 17, 1))::bit(4)::integer) & 3) | 8) || substr(hashed.d, 18, 3) || '-'
		|| substr(hashed.d, 21, 12)
	)::uuid end
	from (select encode(extensions.digest('qorpera.lxd-run-attempt/v1:' || p_run_id::text || ':' || p_attempt::text,
		'sha256'), 'hex') as d) as hashed
$$;
revoke all on function public.qorpera_run_attempt_acquisition_id(uuid,integer) from public, anon, authenticated, service_role;

-- The node where a run's latest attempt failed to start (one row per run, the latest failure).
create table public.qorpera_runtime_run_start_failures (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete cascade,
	attempt integer not null check (attempt between 1 and 1000),
	allocation_id uuid not null,
	node_id uuid not null,
	recorded_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_runtime_run_start_failures enable row level security;
revoke all on public.qorpera_runtime_run_start_failures from public, anon, authenticated, service_role;

create or replace function public.qorpera_release_runner_job_claim(p_orchestrator_id uuid, p_claim_id uuid, p_client_assignment_id uuid, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_attempt integer;
	v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_failed_node uuid;
	v_abandoned boolean := false;
	v_machine_pending boolean := false;
begin
	if auth.role() <> 'service_role' or p_client_assignment_id is null
		or char_length(btrim(coalesce(p_error, ''))) not between 1 and 1000 then
		raise exception 'runner claim release is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id;
	if not found then raise exception 'runner claim is unavailable' using errcode = '55000'; end if;
	-- The attempt this claim was for: the count rises only when a runner accepts, or below.
	select job.attempt_count + 1 into v_attempt from public.qorpera_runner_jobs as job where job.id = v_claim.job_id for update;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id for update;
	if not found then
		raise exception 'runner claim is unavailable' using errcode = '55000';
	end if;
	if v_claim.status = 'released' then
		return jsonb_build_object('released', true);
	end if;
	if v_claim.status not in ('claimed', 'assigned') then
		raise exception 'runner claim is already owned by a runner' using errcode = '55000';
	end if;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_client_assignment_id and assignment.claim_id = p_claim_id for update;
	if v_claim.status = 'assigned' and (not found or v_assignment.status <> 'offered') then
		raise exception 'runner assignment is unavailable' using errcode = '55000';
	end if;
	if v_assignment.id is not null and v_assignment.status = 'offered' then
		update public.qorpera_runner_assignments
		set status = 'delivery_failed', last_error = btrim(p_error) where id = v_assignment.id;
	end if;
	update public.qorpera_runner_job_claims
	set status = 'released', released_at = statement_timestamp(), release_reason = btrim(p_error)
	where id = p_claim_id;
	if btrim(p_error) ~ '^ADMISSION_REFUSED:[A-Z_]{3,64}$' then
		-- The provider's ceiling or the node chooser refused this claimant. That is placement, not an
		-- infrastructure failure: the job stays queued, this orchestrator (node preference) or every
		-- orchestrator (capacity) waits a short while, and a day in the queue ends the wait.
		update public.qorpera_runner_jobs
		set dispatch_refused_by = case
				when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE') then p_orchestrator_id
				when substr(btrim(p_error), 19) in ('SANDBOX_CAPACITY_EXHAUSTED','SANDBOX_RETIRING','NODE_DISABLED',
					'NODE_OBSERVATION_UNAVAILABLE','NODE_HARDWARE_CHANGED','NODE_CAPACITY_EXHAUSTED','NODE_PROVIDER_UNCONFIGURED')
					and not (dispatch_refused_by is not null and dispatch_refused_by <> p_orchestrator_id
						and dispatch_deferred_until > statement_timestamp()) then p_orchestrator_id
				else null end,
			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in ('NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')
				then interval '5 seconds' else interval '15 seconds' end,
			last_error = btrim(p_error)
		where id = v_claim.job_id and status = 'queued'
		returning * into v_job;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_claim.run_id, 'placement_deferred', jsonb_build_object(
			'assignment_id', v_assignment.id, 'reason', substr(btrim(p_error), 19),
			'refused_by', v_job.dispatch_refused_by, 'deferred_until', v_job.dispatch_deferred_until,
			'dispatch_failure_count', v_job.dispatch_failure_count
		));
		return jsonb_build_object(
			'released', true, 'deferred', true,
			'dispatch_failure_count', v_job.dispatch_failure_count,
			'terminal', false
		);
	end if;
	-- The attempt's machine was reserved, then released, and its runner never activated (20260929240000):
	-- a runner holds one allocation ever, so this attempt can start nowhere. Revoke the runner, record the
	-- node that failed and move the job to its next attempt.
	select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
	where allocation.id = public.qorpera_run_attempt_acquisition_id(v_claim.run_id, v_attempt);
	if found and v_allocation.run_id = v_claim.run_id and v_allocation.released_at is not null then
		select runner.* into v_runner from public.qorpera_runners as runner
		where runner.id = v_allocation.runner_id and runner.status = 'pending' for update;
		if found then
			update public.qorpera_runners
			set status = 'revoked', revoked_by_user_id = v_runner.registered_by_user_id, revoked_at = statement_timestamp()
			where id = v_runner.id;
			perform public.qorpera_append_runner_audit(
				v_runner.profile_id, v_runner.id, v_claim.job_id, 'runner_revoked',
				jsonb_build_object(
					'reason', 'attempt_start_failed',
					'run_id', v_claim.run_id,
					'attempt', v_attempt,
					'allocation_id', v_allocation.id,
					'provider_adapter', v_runner.provider_adapter
				),
				null
			);
			select placement.node_id into v_failed_node from public.qorpera_runtime_node_placements as placement
			where placement.allocation_id = v_allocation.id;
			if v_failed_node is not null then
				insert into public.qorpera_runtime_run_start_failures(run_id, attempt, allocation_id, node_id)
				values (v_claim.run_id, v_attempt, v_allocation.id, v_failed_node)
				on conflict (run_id) do update set attempt = excluded.attempt, allocation_id = excluded.allocation_id,
					node_id = excluded.node_id, recorded_at = clock_timestamp();
			end if;
			v_abandoned := true;
		end if;
	elsif found and v_allocation.run_id = v_claim.run_id and v_allocation.released_at is null
		and exists (select 1 from public.qorpera_runners as runner where runner.id = v_allocation.runner_id and runner.status = 'pending') then
		-- The attempt's machine is still reserved: its provider releases it (the LXD provider on its next
		-- reconcile). Every orchestrator waits a moment instead of spending the retries on refusals.
		v_machine_pending := true;
	end if;
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		attempt_count = attempt_count + case when v_abandoned then 1 else 0 end,
		-- The next attempt is queued again: the claim turn's head start goes to the node the placement names.
		queued_at = case when v_abandoned then statement_timestamp() else queued_at end,
		dispatch_refused_by = case when v_machine_pending then null else dispatch_refused_by end,
		dispatch_deferred_until = case when v_machine_pending then statement_timestamp() + interval '15 seconds'
			else dispatch_deferred_until end,
		last_error = btrim(p_error)
	where id = v_claim.job_id and status = 'queued' and dispatch_failure_count < 8
	returning * into v_job;
	if v_job.id is not null and (v_job.dispatch_failure_count >= 8 or v_job.attempt_count >= 8) then
		update public.qorpera_runner_jobs
		set status = 'failed', finished_at = statement_timestamp(),
			last_error = case when v_job.dispatch_failure_count >= 8
				then 'Runner dispatch failed after the final infrastructure attempt: '
				else 'Runner failed to start on its final attempt: ' end || btrim(p_error)
		where id = v_job.id returning * into v_job;
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'infrastructure_retry', jsonb_build_object(
		'assignment_id', v_assignment.id, 'reason', btrim(p_error),
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false),
		'attempt_abandoned', case when v_abandoned then v_attempt end,
		'start_failed_node_id', v_failed_node
	));
	return jsonb_build_object(
		'released', true,
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false),
		'attempt_abandoned', v_abandoned
	);
end
$function$;

-- The node chooser with the node to rank last. Only the ordering of runs' choices changes: the login
-- branch (a login reaches exactly one node) is as before.
create function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid, p_last_node_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_candidates jsonb; v_self jsonb; v_preferred jsonb; v_decision text; v_reason text; v_node uuid; v_preferred_node uuid; v_homes text[]; v_home_nodes uuid[]; v_home_pick jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind not in ('native','login','office')
		or coalesce(p_provider_id,'') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
		raise exception 'Node placement authority required' using errcode='42501'; end if;
	v_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);
	select c into v_self from jsonb_array_elements(v_candidates) c where c->>'providerId'=p_provider_id limit 1;
	if p_provider_kind='login' then
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
	elsif p_provider_kind='native' and p_compute_identity_id is not null and not public.qorpera_compute_identity_login_in_vault(p_compute_identity_id) then
		select coalesce(array_agg(distinct a.provider_adapter),'{}') into v_homes from public.qorpera_runtime_machine_allocations a
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(a)) identity_home on true
			where a.login_compute_identity_id=p_compute_identity_id;
		if v_self is null then
			v_decision:='unbound'; v_reason:='PROVIDER_UNBOUND';
		elsif cardinality(v_homes)=0 then
			v_decision:='deferred'; v_reason:='NO_IDENTITY_HOME';
		elsif not (p_provider_id=any(v_homes)) then
			select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) and (c->>'eligible')::boolean and (c->>'fits')::boolean
				order by (c->>'nodeId')::uuid is not distinct from p_last_node_id,
					(c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
			if v_preferred is null then select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) limit 1; end if;
			v_decision:='refused'; v_reason:='NODE_IDENTITY_ELSEWHERE';
		else
			select c into v_preferred from jsonb_array_elements(v_candidates) c where c->>'providerId'=any(v_homes) and (c->>'eligible')::boolean and (c->>'fits')::boolean
				order by (c->>'nodeId')::uuid is not distinct from p_last_node_id,
					(c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
			if v_preferred is null then v_decision:='deferred'; v_reason:='NO_ELIGIBLE_HOME';
			elsif v_preferred->>'providerId'=p_provider_id then v_decision:='placed'; v_reason:='IDENTITY_HOME_LEAST_LOADED';
			else v_decision:='refused'; v_reason:='NODE_NOT_PREFERRED'; end if;
		end if;
	else
		select c into v_preferred from jsonb_array_elements(v_candidates) c where (c->>'eligible')::boolean and (c->>'fits')::boolean
			order by (c->>'nodeId')::uuid is not distinct from p_last_node_id,
				(c->>'freeSlots')::bigint desc,(c->>'allocatedCpuMillis')::bigint asc,(c->>'allocatedMemoryBytes')::bigint asc,c->>'nodeId' asc limit 1;
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
$function$;
revoke all on function public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid) to service_role;

-- The four-argument form ranks no node last.
create or replace function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_runtime_node_placement_decide(p_allocation_id,p_provider_kind,p_provider_id,p_compute_identity_id,null::uuid);
$$;

-- A run machine's reservation passes the node where the run's previous attempt failed to start.
do $$
declare
	v_target regprocedure := 'public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text := E'v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,''native'',p_provider_adapter,v_run.compute_identity_id);';
	v_new text := E'v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,''native'',p_provider_adapter,v_run.compute_identity_id,\n'
		|| E'\t\t\t\t(select failure.node_id from public.qorpera_runtime_run_start_failures failure where failure.run_id=p_run_id));';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Machine reservation source differs';
	end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- The claim turn's placement: a warm host is not preferred on the node where the run's previous attempt
-- failed to start, and that node ranks after the others.
do $$
declare
	v_target regprocedure := 'public.qorpera_runtime_run_placement(public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_declare_old text := E'declare v_node uuid; v_fast jsonb;';
	v_declare_new text := E'declare v_node uuid; v_fast jsonb;\n\tv_last_node uuid := (select failure.node_id from public.qorpera_runtime_run_start_failures failure where failure.run_id = p_run.id);';
	v_warm_old text := E'\tjoin jsonb_array_elements(v_fast) f on (f ->> ''orchestratorId'')::uuid = previous_claim.orchestrator_id\n\tlimit 1;';
	v_warm_new text := E'\tjoin jsonb_array_elements(v_fast) f on (f ->> ''orchestratorId'')::uuid = previous_claim.orchestrator_id\n'
		|| E'\t\tand (f ->> ''nodeId'')::uuid is distinct from v_last_node\n\tlimit 1;';
	v_order_old text := E'\torder by (select count(*) from busy where busy.orchestrator_id in';
	v_order_new text := E'\torder by nodes.node_id is not distinct from v_last_node,\n\t\t(select count(*) from busy where busy.orchestrator_id in';
begin
	if (length(v_definition) - length(replace(v_definition, v_declare_old, ''))) / length(v_declare_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_warm_old, ''))) / length(v_warm_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_order_old, ''))) / length(v_order_old) <> 1 then
		raise exception 'Run placement source differs';
	end if;
	execute replace(replace(replace(v_definition, v_declare_old, v_declare_new), v_warm_old, v_warm_new), v_order_old, v_order_new);
end
$$;
