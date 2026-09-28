-- Identical nodes, change 3 (Stateless Compute step 3, 28 Sep 2026): runs follow the placement.
--
-- Today the node of a run is whichever orchestrator asks first, within the login's home node, and the
-- node chooser (qorpera_runtime_node_placement_decide) may then refuse that orchestrator for a node with
-- more free ledger slots. With a fast host on every node and logins in the vault (step 1 change 3,
-- 20260928180600), every node can take a member run, so the database now places runs once, at claim:
--
--   * An orchestrator may have a dispatch role (qorpera_set_runner_orchestrator_dispatch_role, service
--     role): 'fast' (a shared execution host) or 'overflow' (the fresh-VM path). Without a role an
--     orchestrator claims exactly as before, so nothing changes until an operator sets roles.
--   * The fast hosts that may take a run: active, live (heartbeat within 30 s), on a serving node,
--     allowed by the run's login (qorpera_runtime_run_adapter_allowed, the claim's own home rule) and
--     declared for the run's bundle or for none (20260928182000).
--   * The preferred node (qorpera_runtime_run_placement): where the conversation is warm (its previous
--     run completed less than 5 minutes ago on one of those fast hosts, the 2026-09-27 warm window),
--     otherwise the node whose fast hosts hold the fewest runs (every node has the same fast host, so
--     the fewest runs is the most free fast room).
--   * A fast orchestrator claims at once on the preferred node, elsewhere after a 1.5 s head start or at
--     once when the preferred node's orchestrator refused the run. An overflow orchestrator claims only
--     when no such fast host exists, when a fast host refused the run (full, retiring, or not work it
--     serves; the job's last error names it, and this holds inside that refusal's wait, but never
--     inside the overflow's own), or after 10 s. Waits count from the job's queued_at (a retry or a
--     sponsor handoff queues it again).
--   * The claim decides for orchestrators with a role: qorpera_reserve_runtime_machine records the claim
--     turn's placement (reason CLAIM_TURN) instead of asking the node chooser, which could otherwise
--     refuse the chosen fast host. The claim's orchestrator_claimed event carries the same placement.
-- Nothing new is stored for the warm preference. Reads go by key or index; no lock is added.
set local lock_timeout = '10s';

-- The conversation's previous runs, newest first (warm preference). Built before the orchestrator table
-- is altered, so claims never wait for the index build.
create index qorpera_execution_runs_session_created on public.qorpera_execution_runs (session_id, created_at desc)
	where session_id is not null;

alter table public.qorpera_runner_orchestrators
	add column dispatch_role text check (dispatch_role in ('fast', 'overflow'));

create function public.qorpera_set_runner_orchestrator_dispatch_role(p_orchestrator_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_orchestrator public.qorpera_runner_orchestrators%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_orchestrator_id is null
		or (p_role is not null and p_role not in ('fast', 'overflow')) then
		raise exception 'Invalid orchestrator dispatch role' using errcode = '42501';
	end if;
	select * into v_orchestrator from public.qorpera_runner_orchestrators where id = p_orchestrator_id for update;
	if not found or v_orchestrator.status = 'revoked' then
		raise exception 'Orchestrator is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_runner_orchestrators set dispatch_role = p_role where id = p_orchestrator_id;
	return jsonb_build_object('orchestratorId', p_orchestrator_id, 'dispatchRole', p_role);
end
$$;

-- The claim's home rule for one adapter, the same text as the claim (as 20260928180600 left it): a run
-- without an identity, whose identity has no home, or with a vault login may go anywhere; otherwise only
-- to a home adapter.
create function public.qorpera_runtime_run_adapter_allowed(p_run public.qorpera_execution_runs, p_adapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_run.compute_identity_id is null
		or not exists (
			select 1 from public.qorpera_runtime_machine_allocations as home
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(home)) identity_home on true
			where home.login_compute_identity_id = p_run.compute_identity_id
		)
		or exists (
			select 1 from public.qorpera_runtime_machine_allocations as home
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(home)) identity_home on true
			where home.login_compute_identity_id = p_run.compute_identity_id
				and home.provider_adapter = p_adapter
		)
		or public.qorpera_compute_identity_login_in_vault(p_run.compute_identity_id)
$$;

-- Where a run should go: the preferred node and why, from the fast hosts that may take it.
create function public.qorpera_runtime_run_placement(p_job public.qorpera_runner_jobs, p_run public.qorpera_execution_runs)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_node uuid; v_fast jsonb;
begin
	select coalesce(jsonb_agg(jsonb_build_object('orchestratorId', orchestrator.id, 'nodeId', node.node_id)
		order by node.node_id, orchestrator.id), '[]'::jsonb)
	into v_fast
	from public.qorpera_runner_orchestrators orchestrator
	cross join lateral public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) node
	where orchestrator.dispatch_role = 'fast' and orchestrator.status = 'active'
		and orchestrator.last_heartbeat_at > clock_timestamp() - interval '30 seconds'
		and node.enabled
		and (orchestrator.runtime_bundle_sha256 is null or orchestrator.runtime_bundle_sha256 = p_run.runtime_bundle_sha256)
		and public.qorpera_runtime_run_adapter_allowed(p_run, orchestrator.provider_adapter);
	if jsonb_array_length(v_fast) = 0 then
		return jsonb_build_object('fast', v_fast, 'nodeId', null, 'reason', 'NO_FAST_HOST');
	end if;
	-- Warm: the conversation's previous run completed within the warm window, and its newest accepted
	-- claim is one of these fast hosts.
	select (f ->> 'nodeId')::uuid into v_node
	from (
		select previous.id, previous.job_id from public.qorpera_execution_runs previous
		where p_run.session_id is not null and previous.session_id = p_run.session_id and previous.id <> p_run.id
			and previous.created_at <= p_run.created_at
		order by previous.created_at desc limit 1
	) last_run
	join public.qorpera_runner_jobs previous_job on previous_job.id = last_run.job_id and previous_job.status = 'completed'
		and previous_job.finished_at > clock_timestamp() - interval '5 minutes'
	cross join lateral (select claim.orchestrator_id from public.qorpera_runner_job_claims claim
		where claim.run_id = last_run.id and claim.status = 'accepted'
		order by claim.created_at desc, claim.id desc limit 1) previous_claim
	join jsonb_array_elements(v_fast) f on (f ->> 'orchestratorId')::uuid = previous_claim.orchestrator_id
	limit 1;
	if v_node is not null then
		return jsonb_build_object('fast', v_fast, 'nodeId', v_node, 'reason', 'WARM_CONVERSATION');
	end if;
	-- Otherwise the node whose fast hosts hold the fewest runs: held claims (partial index), and each leased
	-- job's newest accepted claim (queue index, claims by run). The run's own claim never counts, so the
	-- claim event (before the claim) and the reservation's record (after it) name the same node.
	with busy as (
		select claim.orchestrator_id from public.qorpera_runner_job_claims claim
		where claim.status in ('claimed', 'assigned') and claim.run_id <> p_run.id
		union all
		select latest.orchestrator_id from public.qorpera_runner_jobs job
		cross join lateral (select claim.orchestrator_id from public.qorpera_runner_job_claims claim
			where claim.run_id = job.run_id and claim.job_id = job.id and claim.status = 'accepted'
			order by claim.created_at desc, claim.id desc limit 1) latest
		where job.status = 'leased' and job.run_id <> p_run.id
	)
	select nodes.node_id into v_node
	from (select distinct (f ->> 'nodeId')::uuid node_id from jsonb_array_elements(v_fast) f) nodes
	order by (select count(*) from busy where busy.orchestrator_id in (select (g ->> 'orchestratorId')::uuid
		from jsonb_array_elements(v_fast) g where (g ->> 'nodeId')::uuid = nodes.node_id)), nodes.node_id
	limit 1;
	return jsonb_build_object('fast', v_fast, 'nodeId', v_node, 'reason', 'LEAST_BUSY');
end
$$;

-- Did this orchestrator refuse this run's job in the last 15 s? (Its own refusal can be hidden when
-- another orchestrator's refusal made everyone wait; the released claim still says it.)
create function public.qorpera_runtime_refused_recently(p_run_id uuid, p_orchestrator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_runner_job_claims claim
		where claim.run_id = p_run_id and claim.orchestrator_id = p_orchestrator_id and claim.status = 'released'
			and claim.released_at > clock_timestamp() - interval '15 seconds'
			and claim.release_reason like 'ADMISSION_REFUSED:%')
$$;

-- May this orchestrator claim this job now? Orchestrators without a dispatch role always may.
create function public.qorpera_runtime_claim_turn(p_orchestrator_id uuid, p_job public.qorpera_runner_jobs,
	p_run public.qorpera_execution_runs)
returns boolean
language plpgsql
stable
security definer
cost 10000
set search_path = ''
as $$
declare v_role text; v_adapter text; v_placement jsonb; v_waited interval := statement_timestamp() - coalesce(p_job.queued_at, p_job.created_at);
	v_error text := btrim(coalesce(p_job.last_error, ''));
begin
	select dispatch_role, provider_adapter into v_role, v_adapter from public.qorpera_runner_orchestrators where id = p_orchestrator_id;
	if v_role is null then return true; end if;
	if v_role = 'overflow' then
		-- A fast host refused it (full, retiring, or not its work): take it without waiting.
		if v_waited >= interval '10 seconds' then return true; end if;
		if ((v_error in ('ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED', 'ADMISSION_REFUSED:SANDBOX_RETIRING')
				and p_job.dispatch_refused_by is distinct from p_orchestrator_id)
			or (v_error = 'ADMISSION_REFUSED:NODE_NOT_PREFERRED' and exists (select 1 from public.qorpera_runner_orchestrators refuser
				where refuser.id = p_job.dispatch_refused_by and refuser.dispatch_role = 'fast')))
			and not public.qorpera_runtime_refused_recently(p_job.run_id, p_orchestrator_id) then
			return true;
		end if;
		return public.qorpera_runtime_run_placement(p_job, p_run) ->> 'reason' = 'NO_FAST_HOST';
	end if;
	if v_waited >= interval '1.5 seconds' then return true; end if;
	v_placement := public.qorpera_runtime_run_placement(p_job, p_run);
	return v_placement ->> 'nodeId' is null
		or exists (select 1 from public.qorpera_runtime_orchestrator_nodes(v_adapter) mine
			where mine.enabled and mine.node_id = (v_placement ->> 'nodeId')::uuid)
		or (p_job.dispatch_refused_by is not null and exists (
			select 1 from public.qorpera_runner_orchestrators refuser
			cross join lateral public.qorpera_runtime_orchestrator_nodes(refuser.provider_adapter) refused_node
			where refuser.id = p_job.dispatch_refused_by and refused_node.node_id = (v_placement ->> 'nodeId')::uuid));
end
$$;

-- The dispatch role of the orchestrator holding the run's claim, if any.
create function public.qorpera_runtime_run_claim_role(p_run_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
	select orchestrator.dispatch_role from public.qorpera_runner_job_claims claim
	join public.qorpera_runner_orchestrators orchestrator on orchestrator.id = claim.orchestrator_id
	where claim.run_id = p_run_id and claim.status in ('claimed', 'assigned')
	order by claim.created_at desc limit 1
$$;

-- Record the claim turn's placement for a run machine, in the chooser's own record.
create function public.qorpera_runtime_record_claim_turn_placement(p_allocation_id uuid, p_provider_adapter text,
	p_run public.qorpera_execution_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.qorpera_runner_jobs%rowtype; v_placement jsonb; v_node uuid;
begin
	select * into strict v_job from public.qorpera_runner_jobs where id = p_run.job_id;
	v_placement := public.qorpera_runtime_run_placement(v_job, p_run);
	select node.node_id into v_node from public.qorpera_runtime_orchestrator_nodes(p_provider_adapter) node
	order by node.enabled desc, node.node_id limit 1;
	insert into public.qorpera_runtime_node_placements(allocation_id,provider_kind,provider_id,node_id,decision,reason,preferred_node_id,candidates)
	values(p_allocation_id,'native',p_provider_adapter,v_node,case when v_node is null then 'unbound' else 'placed' end,
		case when v_node is null then 'CLAIM_TURN_PROVIDER_UNBOUND' else 'CLAIM_TURN_' || (v_placement ->> 'reason') end,
		(v_placement ->> 'nodeId')::uuid,v_placement -> 'fast')
	on conflict(allocation_id) do update set provider_id=excluded.provider_id,node_id=excluded.node_id,decision=excluded.decision,
		reason=excluded.reason,preferred_node_id=excluded.preferred_node_id,candidates=excluded.candidates,
		decided_at=clock_timestamp(),attempts=public.qorpera_runtime_node_placements.attempts+1;
	return v_placement;
end
$$;

-- A role belongs to a runner on its adapter: re-registering on another adapter (another node or path)
-- clears it; re-registering on the same adapter (a rebuild) keeps it.
do $register$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_register_runner_orchestrator(uuid,text,text,text,integer)'::regprocedure);
	v_old := '		runtime_bundle_declared_at = null
';
	v_new := v_old || '		, dispatch_role = case when public.qorpera_runner_orchestrators.provider_adapter = excluded.provider_adapter
			then public.qorpera_runner_orchestrators.dispatch_role end
';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'register_runner_orchestrator conflict update differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$register$;

do $reserve$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure);
	v_old := $old$		if p_run_id is not null then
			v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,'native',p_provider_adapter,v_run.compute_identity_id);$old$;
	v_new := $new$		-- Runs follow the placement (20260928183000): an orchestrator with a dispatch role claimed this run
		-- where the claim turn placed it; record that instead of asking the node chooser again.
		if p_run_id is not null and public.qorpera_runtime_run_claim_role(p_run_id) is not null then
			perform public.qorpera_runtime_record_claim_turn_placement(p_allocation_id,p_provider_adapter,v_run);
		elsif p_run_id is not null then
			v_placement:=public.qorpera_runtime_node_placement_decide(p_allocation_id,'native',p_provider_adapter,v_run.compute_identity_id);$new$;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'reserve_runtime_machine chooser call differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$reserve$;

do $claim$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	-- An overflow orchestrator may take a job inside a fast host's refusal wait (the fast host is full),
	-- never inside its own.
	v_old := '			or (job.dispatch_refused_by is not null and job.dispatch_refused_by <> p_orchestrator_id))
';
	v_new := '			or (job.dispatch_refused_by is not null and job.dispatch_refused_by <> p_orchestrator_id)
			or (btrim(coalesce(job.last_error, '''')) in (''ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED'',''ADMISSION_REFUSED:SANDBOX_RETIRING'')
				and job.dispatch_refused_by is distinct from p_orchestrator_id
				and not public.qorpera_runtime_refused_recently(job.run_id, p_orchestrator_id)
				and exists (select 1 from public.qorpera_runner_orchestrators as overflow
					where overflow.id = p_orchestrator_id and overflow.dispatch_role = ''overflow'')))
		-- Runs follow the placement: the preferred node''s fast host first, the fresh-VM path as overflow.
		and public.qorpera_runtime_claim_turn(p_orchestrator_id, job, run)
';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator deferral predicate differs';
	end if;
	v_def := replace(v_def, v_old, v_new);
	-- The claim's event names the placement for orchestrators with a role (the contract's placement record),
	-- as decided before this claim counts.
	v_old := $old$	v_adapter text;
begin$old$;
	v_new := $new$	v_adapter text;
	v_placement jsonb;
begin$new$;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator declarations differ';
	end if;
	v_def := replace(v_def, v_old, v_new);
	v_old := $old$	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
$old$;
	v_new := v_old || $new$	select public.qorpera_runtime_run_placement(v_job, v_run) into v_placement
	from public.qorpera_runner_orchestrators orchestrator where orchestrator.id = p_orchestrator_id and orchestrator.dispatch_role is not null;
$new$;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator run read differs';
	end if;
	v_def := replace(v_def, v_old, v_new);
	v_old := $old$	values (v_run.id, 'orchestrator_claimed', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id, 'claim_id', v_claim.id
	));$old$;
	v_new := $new$	values (v_run.id, 'orchestrator_claimed', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id, 'claim_id', v_claim.id
	) || case when v_placement is null then '{}'::jsonb else jsonb_build_object('placement',
		jsonb_build_object('reason', v_placement ->> 'reason', 'nodeId', v_placement -> 'nodeId')) end);$new$;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator claimed event differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$claim$;

revoke all on function public.qorpera_set_runner_orchestrator_dispatch_role(uuid, text),
	public.qorpera_runtime_run_adapter_allowed(public.qorpera_execution_runs, text),
	public.qorpera_runtime_run_placement(public.qorpera_runner_jobs, public.qorpera_execution_runs),
	public.qorpera_runtime_claim_turn(uuid, public.qorpera_runner_jobs, public.qorpera_execution_runs),
	public.qorpera_runtime_run_claim_role(uuid),
	public.qorpera_runtime_refused_recently(uuid, uuid),
	public.qorpera_runtime_record_claim_turn_placement(uuid, text, public.qorpera_execution_runs)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_runner_orchestrator_dispatch_role(uuid, text),
	public.qorpera_runtime_run_placement(public.qorpera_runner_jobs, public.qorpera_execution_runs) to service_role;
