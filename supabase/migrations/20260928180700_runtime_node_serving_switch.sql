-- Identical nodes, change 1 (Stateless Compute step 3, 28 Sep 2026): empty a node without a pause.
--
-- A node is either serving or emptying. The switch is the node's existing `enabled` flag, so
-- every placement that already skips a switched-off node keeps doing so: the placement
-- candidates (runs' node chooser, sign-ins, company machine fleet), the fresh branch of the coding
-- executor pick, and the node ledger's admission (`NODE_DISABLED` for a new reservation or the wake
-- of a sleeping machine). Work already on the node finishes normally: a reservation the node holds
-- (reserved and awake) passes admission again while the node empties, because coding turns and
-- sign-ins re-ask it before each step.
--
--   * qorpera_set_runtime_node_serving: flips only `enabled`, with a reason, under the node's
--     version check, WITHOUT a new node version: the observer's inventory receipt names the node
--     version, and a new one would refuse every admission, held ones included, until the next
--     scan. `enabled` is not part of the inventory context. No company pause, no company lock; it
--     refuses while the older signed updater (20260921010000) has any unresumed target.
--   * The orchestrator claim skips orchestrators whose provider adapter belongs only to
--     switched-off nodes. The shared execution host reserves no node demand, so without this
--     it kept taking runs on an emptying node.
--   * Node-local admission refusals (a full fast host, a full or switched-off node) now make
--     only the refusing orchestrator wait. Before, a full fast host made every node wait 15 s.
--     When another orchestrator already holds an unexpired refuser-only wait on the job (any
--     refusal of its own, a node preference included), every orchestrator waits, as before, so two
--     full nodes do not trade the job back and forth.
--   * qorpera_runtime_node_drain_status: what is still on a node (runs, run machines, sign-ins,
--     coding turns, awake and sleeping machines) and whether it is empty enough to update or restart.
--   * A coding executor on an emptying node starts no new coding turn; running turns finish.
--
-- New work bound to the node by a disk waits while the node empties: runs of a member whose login
-- lives on the node (the identity-home rule, until logins move into the vault), a sleeping machine's
-- wake, a new coding turn on a member machine there, and a sign-in already routed there. The switch
-- needs no pause, but for that work emptying acts like one until the node returns.

-- One row per switch. `version` is the node's policy version at the time (the switch keeps it).
create table public.qorpera_runtime_node_serving_changes (
	id bigint generated always as identity primary key,
	node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
	version bigint not null,
	serving boolean not null,
	reason text not null check (char_length(btrim(reason)) between 1 and 200),
	changed_at timestamptz not null default clock_timestamp(),
	foreign key (node_id, version) references public.qorpera_runtime_node_policies(node_id, version) on delete restrict
);
create index qorpera_runtime_node_serving_changes_node on public.qorpera_runtime_node_serving_changes (node_id, id desc);
alter table public.qorpera_runtime_node_serving_changes enable row level security;
revoke all on public.qorpera_runtime_node_serving_changes from public, anon, authenticated, service_role;

create function public.qorpera_set_runtime_node_serving(p_node_id uuid, p_serving boolean, p_expected_version bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_node public.qorpera_runtime_nodes%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_node_id is null or p_serving is null
		or p_expected_version is null or p_expected_version not between 1 and 9007199254740989
		or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 200 then
		raise exception 'Invalid node serving change' using errcode = '42501';
	end if;
	-- The same node-only lock order as qorpera_configure_runtime_node: advisory lock, then the node row.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:' || p_node_id::text, 0));
	select * into v_node from public.qorpera_runtime_nodes where id = p_node_id for update;
	if not found then raise exception 'Node is not configured' using errcode = '42501'; end if;
	if v_node.version <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node policy version changed',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	-- The signed updater owns `enabled` while it holds this node, and a prepared update pins the node's version.
	if exists (select 1 from public.qorpera_node_update_targets target
		where target.node_id = p_node_id and target.resumed_version is null) then
		raise exception 'A node update holds this node' using errcode = '55000';
	end if;
	if v_node.enabled = p_serving then
		return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'serving', v_node.enabled, 'changed', false);
	end if;
	-- Same version: the inventory receipt stays valid, so held reservations keep passing admission.
	update public.qorpera_runtime_nodes set enabled = p_serving, updated_at = clock_timestamp()
	where id = p_node_id returning * into v_node;
	insert into public.qorpera_runtime_node_serving_changes(node_id, version, serving, reason)
	values (p_node_id, v_node.version, p_serving, btrim(p_reason));
	return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'serving', p_serving, 'changed', true);
end
$$;

-- Nodes an orchestrator's adapter runs on: the node providers of kind native with that adapter id.
create function public.qorpera_runtime_orchestrator_nodes(p_provider_adapter text)
returns table (node_id uuid, enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
	select distinct node.id, node.enabled
	from public.qorpera_runtime_node_providers provider
	join public.qorpera_runtime_nodes node on node.id = provider.node_id
	where provider.provider_kind = 'native' and provider.provider_id = p_provider_adapter
$$;

-- A reservation the node already holds (reserved, not suspended) passes admission again on an
-- emptying node: coding turns and sign-ins re-ask before each step and must finish. New
-- reservations and wakes of sleeping machines are still refused with NODE_DISABLED.
do $admission$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure);
	v_old := $old$ if not v_node.enabled then v_reason:='NODE_DISABLED';$old$;
	v_new := $new$ if not v_node.enabled and (v_demand.reserved_at is null or v_demand.suspended_at is not null) then v_reason:='NODE_DISABLED';$new$;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'reserve_runtime_node_machine enabled check differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$admission$;

-- An executor on an emptying node starts no new coding turn (a turn it is running keeps its lease and
-- finishes; a lapsed one is still failed visibly). The node is the executor's NAS machine, as in the pick.
do $coding$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_claim_coding_session(text,integer)'::regprocedure);
	v_old := $old$			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner, lease_token = extensions.gen_random_uuid(),$old$;
	v_new := $new$			if exists (select 1 from public.qorpera_coding_executors executor
				join public.qorpera_runtime_nodes node on node.machine_id_sha256 = executor.nas_machine_id_sha256
				where executor.environment_id = v_session.environment_id and executor.owner = p_owner and not node.enabled) then
				continue;
			end if;
$new$ || v_old;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_coding_session start differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$coding$;

do $claim$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	v_old := '	select orchestrator.provider_adapter into v_adapter
	from public.qorpera_runner_orchestrators as orchestrator
	where orchestrator.id = p_orchestrator_id;
';
	v_new := v_old || '	-- An emptying node takes no new runs (all of the adapter''s nodes switched off; no node row: as before).
	-- Its orchestrators still replay the claims they hold (above).
	if (select bool_or(serving.enabled) from public.qorpera_runtime_orchestrator_nodes(v_adapter) as serving) is false then
		return ''null''::jsonb;
	end if;
';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator adapter lookup differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$claim$;

do $release$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure);
	v_old := '		set dispatch_refused_by = case when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'')
				then p_orchestrator_id else null end,
			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'')
				then interval ''5 seconds'' else interval ''15 seconds'' end,';
	-- A node-local refusal (this node is full, retiring or switched off) leaves the job to the other
	-- orchestrators at once, unless another orchestrator's refuser-only wait on the job (any refusal
	-- of its own) is still running: then no node takes it, and every orchestrator waits.
	v_new := '		set dispatch_refused_by = case
				when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'') then p_orchestrator_id
				when substr(btrim(p_error), 19) in (''SANDBOX_CAPACITY_EXHAUSTED'',''SANDBOX_RETIRING'',''NODE_DISABLED'',
					''NODE_OBSERVATION_UNAVAILABLE'',''NODE_HARDWARE_CHANGED'',''NODE_CAPACITY_EXHAUSTED'',''NODE_PROVIDER_UNCONFIGURED'')
					and not (dispatch_refused_by is not null and dispatch_refused_by <> p_orchestrator_id
						and dispatch_deferred_until > statement_timestamp()) then p_orchestrator_id
				else null end,
			dispatch_deferred_until = statement_timestamp() + case when substr(btrim(p_error), 19) in (''NODE_NOT_PREFERRED'',''NODE_IDENTITY_ELSEWHERE'')
				then interval ''5 seconds'' else interval ''15 seconds'' end,';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'release_runner_job_claim deferral differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$release$;

-- What is still on a node. Runs: claims held by the node's orchestrators (the fast host's runs
-- included; the node agent's quiet check cannot see those). Run machines and sign-ins: the node
-- ledger. Coding turns: sessions leased by the node's coding executors (an executor swap ends a
-- turn). Machines (demand kinds office and coding; 'machine' once test machines exist): awake ones
-- hold a reservation, sleeping ones only a suspended one. An orchestrator whose adapter also maps to
-- another serving node is not stopped by the switch and blocks readiness. Parked warm hosts inside
-- the fast host are not recorded here; they end within the warm window (5 minutes) or when the host
-- is cleared.
create function public.qorpera_runtime_node_drain_status(p_node_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_change public.qorpera_runtime_node_serving_changes%rowtype;
	v_runs bigint; v_run_machines bigint; v_logins bigint; v_awake jsonb; v_asleep bigint; v_other bigint;
	v_orchestrators jsonb; v_awake_count bigint; v_coding bigint; v_elsewhere jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Operator access required' using errcode = '42501'; end if;
	select * into v_node from public.qorpera_runtime_nodes where id = p_node_id;
	if not found then raise exception 'Node is not configured' using errcode = '42501'; end if;
	select * into v_change from public.qorpera_runtime_node_serving_changes where node_id = p_node_id order by id desc limit 1;
	-- A claim is 'claimed'/'assigned' until its runner accepts, then stays 'accepted' while the job is
	-- leased. A retried job keeps older accepted claims: only its newest one counts (claims by run, indexed).
	select count(distinct active.job_id) into v_runs from (
		select claim.job_id, claim.orchestrator_id from public.qorpera_runner_job_claims claim
		where claim.status in ('claimed', 'assigned')
		union all
		select job.id, latest.orchestrator_id from public.qorpera_runner_jobs job
		cross join lateral (select claim.orchestrator_id from public.qorpera_runner_job_claims claim
			where claim.run_id = job.run_id and claim.job_id = job.id and claim.status = 'accepted'
			order by claim.created_at desc, claim.id desc limit 1) latest
		where job.status = 'leased') active
	join public.qorpera_runner_orchestrators orchestrator on orchestrator.id = active.orchestrator_id
	where exists (select 1 from public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) n where n.node_id = p_node_id);
	-- Coding turns in progress on this node's coding executors (the executor holds the turn's lease).
	select count(*) into v_coding
	from public.qorpera_coding_sessions session
	join public.qorpera_coding_executors executor on executor.environment_id = session.environment_id
		and executor.owner = session.lease_owner
	where session.phase in ('preparing', 'running', 'publishing') and session.lease_until > clock_timestamp()
		and executor.nas_machine_id_sha256 = v_node.machine_id_sha256;
	-- An orchestrator of this node whose adapter also maps to another serving node keeps claiming.
	select coalesce(jsonb_agg(distinct orchestrator.id), '[]'::jsonb) into v_elsewhere
	from public.qorpera_runner_orchestrators orchestrator
	where orchestrator.status <> 'revoked'
		and exists (select 1 from public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) n where n.node_id = p_node_id)
		and exists (select 1 from public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) n
			where n.node_id <> p_node_id and n.enabled);
	select count(*) filter (where demand.provider_kind = 'native' and demand.suspended_at is null),
		count(*) filter (where demand.provider_kind = 'login' and demand.suspended_at is null),
		count(*) filter (where demand.suspended_at is not null),
		count(*) filter (where demand.provider_kind not in ('native', 'login', 'office', 'coding', 'machine') and demand.suspended_at is null)
	into v_run_machines, v_logins, v_asleep, v_other
	from public.qorpera_runtime_node_demands demand
	where demand.node_id = p_node_id and demand.reserved_at is not null and demand.released_at is null;
	select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb), coalesce(sum(n), 0) into v_awake, v_awake_count from (
		select demand.provider_kind kind, count(*) n from public.qorpera_runtime_node_demands demand
		where demand.node_id = p_node_id and demand.reserved_at is not null and demand.released_at is null
			and demand.suspended_at is null and demand.provider_kind in ('office', 'coding', 'machine')
		group by demand.provider_kind) awake;
	select coalesce(jsonb_agg(jsonb_build_object('orchestratorId', orchestrator.id, 'providerAdapter', orchestrator.provider_adapter,
		'status', orchestrator.status, 'lastHeartbeatAt', orchestrator.last_heartbeat_at) order by orchestrator.id), '[]'::jsonb)
	into v_orchestrators
	from public.qorpera_runner_orchestrators orchestrator
	where orchestrator.status <> 'revoked'
		and exists (select 1 from public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) n where n.node_id = p_node_id);
	return jsonb_build_object('schema', 'qorpera.runtime-node-drain-status/v1', 'nodeId', p_node_id, 'label', v_node.label,
		'version', v_node.version, 'serving', v_node.enabled,
		'lastChange', case when v_change.id is null then null else jsonb_build_object('version', v_change.version,
			'serving', v_change.serving, 'reason', v_change.reason, 'changedAt', v_change.changed_at) end,
		'runs', v_runs, 'runMachines', v_run_machines, 'signIns', v_logins, 'codingTurns', v_coding,
		'otherReservations', v_other, 'machinesAwake', v_awake, 'machinesAsleep', v_asleep, 'orchestrators', v_orchestrators,
		'orchestratorsServingElsewhere', v_elsewhere,
		'readyForUpdate', not v_node.enabled and v_runs = 0 and v_run_machines = 0 and v_logins = 0 and v_coding = 0
			and v_other = 0 and jsonb_array_length(v_elsewhere) = 0,
		'readyForRestart', not v_node.enabled and v_runs = 0 and v_run_machines = 0 and v_logins = 0 and v_coding = 0
			and v_other = 0 and jsonb_array_length(v_elsewhere) = 0 and v_awake_count = 0);
end
$$;

revoke all on function public.qorpera_set_runtime_node_serving(uuid, boolean, bigint, text),
	public.qorpera_runtime_orchestrator_nodes(text),
	public.qorpera_runtime_node_drain_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_runtime_node_serving(uuid, boolean, bigint, text),
	public.qorpera_runtime_node_drain_status(uuid) to service_role;
