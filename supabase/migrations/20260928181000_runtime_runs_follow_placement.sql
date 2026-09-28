-- Identical nodes, change 3 (Stateless Compute step 3, 28 Sep 2026): runs follow the placement.
--
-- Today the node of a run is whichever orchestrator asks first, within the login's home node. With a
-- fast host on every node and logins in the vault (step 1 change 3, 20260928161000), every node can
-- take a member run, so the database now says which node should:
--
--   * An orchestrator may have a dispatch role (qorpera_set_runner_orchestrator_dispatch_role, service
--     role): 'fast' (a shared execution host) or 'overflow' (the fresh-VM path). Without a role an
--     orchestrator claims exactly as before, so nothing changes until an operator sets roles.
--   * A fast orchestrator takes a run at once when its node is the run's preferred node, else after a
--     1.5 s head start for the preferred node, or at once when the preferred node's orchestrator refused
--     it. The preferred node is where the conversation is warm (its previous run completed less than
--     5 minutes ago on a live fast host there, the warm window of the 2026-09-27 amendment), otherwise the
--     serving node whose live fast hosts run the fewest runs. Only fast hosts that may take this run
--     count: live (heartbeat within 30 s), active, on a serving node, and allowed by the run's login
--     (qorpera_runtime_run_adapter_allowed, the claim's own home rule).
--   * An overflow orchestrator takes a run only when no such fast host exists, when a fast host refused it
--     (full, retiring, or not its kind of work; the job's last error names the refusal, and this holds
--     even inside that refusal's wait), or after 10 s.
-- The warm preference is read from the conversation's previous run; nothing new is stored. The claim
-- reads orchestrators, node rows, claims and runs by index; no lock is added.

alter table public.qorpera_runner_orchestrators
	add column dispatch_role text check (dispatch_role in ('fast', 'overflow'));

-- The conversation's previous runs, newest first (warm preference).
create index qorpera_execution_runs_session_created on public.qorpera_execution_runs (session_id, created_at desc)
	where session_id is not null;

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

-- The claim's home rule for one adapter: a run without an identity, with a vault login, or whose
-- identity has no home may go anywhere; otherwise only to a home adapter. Same text as the claim.
create function public.qorpera_runtime_run_adapter_allowed(p_run public.qorpera_execution_runs, p_adapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_run.compute_identity_id is null
		or public.qorpera_compute_identity_login_in_vault(p_run.compute_identity_id)
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
$$;

-- Where a run should go: the preferred node and why, from the fast hosts that may take it.
create function public.qorpera_runtime_run_placement(p_job public.qorpera_runner_jobs, p_run public.qorpera_execution_runs)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_node uuid; v_reason text; v_fast jsonb;
begin
	with fast as (
		select orchestrator.id, node.node_id
		from public.qorpera_runner_orchestrators orchestrator
		cross join lateral public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) node
		where orchestrator.dispatch_role = 'fast' and orchestrator.status = 'active'
			and orchestrator.last_heartbeat_at > clock_timestamp() - interval '30 seconds'
			and node.enabled and public.qorpera_runtime_run_adapter_allowed(p_run, orchestrator.provider_adapter)
	)
	select coalesce(jsonb_agg(jsonb_build_object('orchestratorId', fast.id, 'nodeId', fast.node_id)), '[]'::jsonb)
	into v_fast from fast;
	if jsonb_array_length(v_fast) = 0 then
		return jsonb_build_object('fast', v_fast, 'nodeId', null, 'reason', 'NO_FAST_HOST');
	end if;
	-- Warm: the conversation's previous run completed within the warm window on one of these fast hosts.
	select (f ->> 'nodeId')::uuid into v_node
	from (
		select previous.id from public.qorpera_execution_runs previous
		where p_run.session_id is not null and previous.session_id = p_run.session_id and previous.id <> p_run.id
			and previous.created_at <= p_run.created_at
		order by previous.created_at desc limit 1
	) last_run
	join public.qorpera_runner_jobs previous_job on previous_job.run_id = last_run.id and previous_job.status = 'completed'
		and previous_job.finished_at > clock_timestamp() - interval '5 minutes'
	join public.qorpera_runner_job_claims previous_claim on previous_claim.run_id = last_run.id and previous_claim.status = 'accepted'
	join jsonb_array_elements(v_fast) f on (f ->> 'orchestratorId')::uuid = previous_claim.orchestrator_id
	limit 1;
	if v_node is not null then
		return jsonb_build_object('fast', v_fast, 'nodeId', v_node, 'reason', 'WARM_CONVERSATION');
	end if;
	-- Otherwise the node whose fast hosts run the fewest runs now.
	-- Held claims are few (partial index); running jobs are few; each running job's claim is found by run.
	with busy as (
		select claim.orchestrator_id from public.qorpera_runner_job_claims claim where claim.status in ('claimed', 'assigned')
		union all
		select claim.orchestrator_id from public.qorpera_runner_jobs job
		join public.qorpera_runner_job_claims claim on claim.run_id = job.run_id and claim.status = 'accepted'
		where job.status in ('leased', 'running')
	)
	select nodes.node_id into v_node
	from (select distinct (f ->> 'nodeId')::uuid node_id from jsonb_array_elements(v_fast) f) nodes
	order by (select count(*) from busy where busy.orchestrator_id in (select (g ->> 'orchestratorId')::uuid
		from jsonb_array_elements(v_fast) g where (g ->> 'nodeId')::uuid = nodes.node_id)), nodes.node_id
	limit 1;
	return jsonb_build_object('fast', v_fast, 'nodeId', v_node, 'reason', 'LEAST_BUSY');
end
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
declare v_role text; v_adapter text; v_placement jsonb; v_waited interval := statement_timestamp() - p_job.created_at;
	v_fast_refusal boolean;
begin
	select dispatch_role, provider_adapter into v_role, v_adapter from public.qorpera_runner_orchestrators where id = p_orchestrator_id;
	if v_role is null then return true; end if;
	v_placement := public.qorpera_runtime_run_placement(p_job, p_run);
	-- A fast host refused it: full, retiring, or not work it serves.
	v_fast_refusal := p_job.dispatch_refused_by is not null
		and btrim(coalesce(p_job.last_error, '')) in ('ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED',
			'ADMISSION_REFUSED:SANDBOX_RETIRING', 'ADMISSION_REFUSED:NODE_NOT_PREFERRED')
		and exists (select 1 from public.qorpera_runner_orchestrators refuser
			where refuser.id = p_job.dispatch_refused_by and refuser.dispatch_role = 'fast');
	if v_role = 'overflow' then
		return v_placement ->> 'reason' = 'NO_FAST_HOST' or v_fast_refusal
			-- After two fast refusals inside one wait nobody holds the job (20260928180000): still a fast refusal.
			or btrim(coalesce(p_job.last_error, '')) in ('ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED', 'ADMISSION_REFUSED:SANDBOX_RETIRING')
			or v_waited >= interval '10 seconds';
	end if;
	return v_placement ->> 'nodeId' is null
		or exists (select 1 from public.qorpera_runtime_orchestrator_nodes(v_adapter) mine
			where mine.enabled and mine.node_id = (v_placement ->> 'nodeId')::uuid)
		or v_waited >= interval '1.5 seconds'
		or (p_job.dispatch_refused_by is not null and exists (
			select 1 from public.qorpera_runner_orchestrators refuser
			cross join lateral public.qorpera_runtime_orchestrator_nodes(refuser.provider_adapter) refused_node
			where refuser.id = p_job.dispatch_refused_by and refused_node.node_id = (v_placement ->> 'nodeId')::uuid));
end
$$;

do $claim$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	-- An overflow orchestrator may take a job inside a fast host's refusal wait (the fast host is full).
	v_old := '			or (job.dispatch_refused_by is not null and job.dispatch_refused_by <> p_orchestrator_id))
';
	v_new := '			or (job.dispatch_refused_by is not null and job.dispatch_refused_by <> p_orchestrator_id)
			or (btrim(coalesce(job.last_error, '''')) in (''ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED'',''ADMISSION_REFUSED:SANDBOX_RETIRING'')
				and exists (select 1 from public.qorpera_runner_orchestrators as overflow
					where overflow.id = p_orchestrator_id and overflow.dispatch_role = ''overflow'')))
		-- Runs follow the placement: the preferred node''s fast host first, the fresh-VM path as overflow.
		and public.qorpera_runtime_claim_turn(p_orchestrator_id, job, run)
';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator deferral predicate differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$claim$;

revoke all on function public.qorpera_set_runner_orchestrator_dispatch_role(uuid, text),
	public.qorpera_runtime_run_adapter_allowed(public.qorpera_execution_runs, text),
	public.qorpera_runtime_run_placement(public.qorpera_runner_jobs, public.qorpera_execution_runs),
	public.qorpera_runtime_claim_turn(uuid, public.qorpera_runner_jobs, public.qorpera_execution_runs)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_runner_orchestrator_dispatch_role(uuid, text),
	public.qorpera_runtime_run_placement(public.qorpera_runner_jobs, public.qorpera_execution_runs) to service_role;
