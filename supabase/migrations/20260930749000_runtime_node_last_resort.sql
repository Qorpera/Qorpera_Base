-- 20260930749000: a last-resort node is chosen for new work only when no other node has room.
--
-- A third, smaller node joins the two as emergency capacity. Every chooser preferred the node with the most free room, so
-- an idle spare would have taken new work first. A node now has `last_resort` (false for every node, so nothing changes
-- until an operator sets it), and a last-resort node ranks below every other node that is eligible and fits: one sort
-- key, after the keys that say eligible and fits (or the chooser's filter that does) and before the free-room keys. Where
-- a chooser sorts the node where a run's last start failed last, that rule stays stronger: a healthy last-resort node is
-- preferred over the node that just failed.
--
-- 1. qorpera_runtime_nodes.last_resort and qorpera_set_runtime_node_last_resort, modelled on the runs switch
--    (qorpera_set_runtime_node_runs, 20260928409960): the service role only, the node's advisory lock and row, the
--    policy version as a compare-and-set that is not bumped, a reason kept with each change (in a table of its own, so a
--    node's drain status still reads only serving changes). A new policy version keeps the flag.
-- 2. The run and sign-in candidates (qorpera_runtime_node_placement_candidates) order by it and carry it as `lastResort`
--    (an added key; every reader of the list reads named keys only, and no TypeScript reads it).
-- 3. The choosers of new work, each with the key in the same place:
--    - qorpera_runtime_node_placement_decide (six arguments; the shorter forms call it): the general branch and both
--      identity-home branches, after the failed node, and the sign-in branch's fallback;
--    - qorpera_runtime_login_route_pick (a sign-in's or account refresh's gateway) and the unused
--      qorpera_runtime_login_gateway_choose();
--    - qorpera_runtime_run_placement (runs with orchestrator roles): after the failed node, before the busy count;
--    - qorpera_place_runtime_office_fleet (a new Company Computer);
--    - qorpera_company_machine_candidates (a new or moving agent's machine);
--    - qorpera_coding_executor_pick (a member's new coding machine);
--    - qorpera_coding_executor_enroll (the executor a company's coding is enrolled with for good): one on a last-resort
--      node only when no other enabled executor serves the harness.
--    Sticky choices are untouched: a warm conversation's node, a machine that wakes on its own node, a member's coding
--    machine, storage or turn, a sign-in routed to its node.
--    A run's claim is held too (review r1 F1): ranking the placement is not enough, because a claim reaches the node
--    around the chooser. qorpera_runtime_claim_turn answers true at once for an orchestrator with no dispatch role (how
--    both nodes run today), after 1.5 seconds for a fast host and after 10 seconds for an overflow host, and a run
--    claimed with a dispatch role records the claim turn's node instead of asking the chooser. The guard therefore sits
--    at the top of the claim turn, so every path passes it: an orchestrator whose nodes are all last resort claims a run
--    only when no node that is not a last resort could take it right now. A regular node counts as able to take it when
--    it is eligible, fits, takes the run's bundle, may hold the run's identity, and still has a live host that has not
--    refused this run's admission in the last 15 seconds (qorpera_runtime_refused_recently, the released claim rows). A
--    refusal is evidence about the host that refused and about nothing else (review r2 F1), so it takes that host out of
--    the set instead of opening the guard: while another regular host has room, that host is preferred and the
--    last-resort node stays out; once every regular host has refused or gone ineligible the set is empty and the
--    last-resort node passes on the ordinary rule. The run's own placement naming this node (a warm conversation, or the
--    only node left) passes as before, and the node where this run's last start failed never counts as able, so the
--    failed-start rule still prefers a healthy last-resort node over it.
-- 4. The pull path (qorpera_admit_executor_machines): a last-resort node's executor admits a waiting machine, or gives up
--    a stopped machine's disk for one, only when no node that is not a last resort could fit it now
--    (qorpera_company_machine_candidates, the push path's own test, with the machine's own disk given back). One asleep on
--    the last-resort node still wakes there. No timer.
--    qorpera_company_machine_candidates also starts asking what the node's observation reports about its hardware
--    (review r1 F2), as the run and sign-in candidates, the coding executor's pick and admission itself
--    (NODE_HARDWARE_CHANGED) all do. Without it a node reporting fewer CPUs or less memory than its policy says stayed a
--    candidate while every admission there was refused, so the push path offered a machine to a node that could not take
--    it, and the new pull guard above would have read that node as proof that a regular node could take a waiting
--    machine -- holding it off the last-resort node for as long as the hardware stayed down.
--
-- Who may call: the setter is the service role's (revoked from anon and authenticated by name); the patched functions
-- keep their grants. Locks: the nodes table gains a column with a constant default (no rewrite) under a short
-- lock_timeout; the setter takes the node's advisory lock and row, as both node switches do; the functions are replaced in
-- place. Patched by anchor: each anchor must be present exactly as many times as named, or the migration stops.

set local lock_timeout = '5s';

alter table public.qorpera_runtime_nodes add column last_resort boolean not null default false;

-- One row per change; `version` is the node's policy version at the time (the change keeps it).
create table public.qorpera_runtime_node_last_resort_changes (
	id bigint generated always as identity primary key,
	node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
	version bigint not null,
	last_resort boolean not null,
	reason text not null check (char_length(btrim(reason)) between 1 and 200),
	changed_at timestamptz not null default clock_timestamp(),
	foreign key (node_id, version) references public.qorpera_runtime_node_policies(node_id, version) on delete restrict
);
create index qorpera_runtime_node_last_resort_changes_node on public.qorpera_runtime_node_last_resort_changes (node_id, id desc);
alter table public.qorpera_runtime_node_last_resort_changes enable row level security;
revoke all on public.qorpera_runtime_node_last_resort_changes from public, anon, authenticated, service_role;
revoke all on sequence public.qorpera_runtime_node_last_resort_changes_id_seq from public, anon, authenticated, service_role;

-- 1. The setter, as the runs switch (the stored policy is not touched: the flag is not part of a node's policy).
create function public.qorpera_set_runtime_node_last_resort(p_node_id uuid, p_last_resort boolean, p_expected_version bigint,
	p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_node public.qorpera_runtime_nodes%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_node_id is null or p_last_resort is null
		or p_expected_version is null or p_expected_version not between 1 and 9007199254740989
		or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 200 then
		raise exception 'Invalid node last-resort change' using errcode = '42501';
	end if;
	-- The same node-only lock order as the node switches: advisory lock, then the node row.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:' || p_node_id::text, 0));
	select * into v_node from public.qorpera_runtime_nodes where id = p_node_id for update;
	if not found then raise exception 'Node is not configured' using errcode = '42501'; end if;
	if v_node.version <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node policy version changed',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_node.last_resort = p_last_resort then
		return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'lastResort', v_node.last_resort, 'changed', false);
	end if;
	update public.qorpera_runtime_nodes set last_resort = p_last_resort, updated_at = clock_timestamp()
	where id = p_node_id returning * into v_node;
	insert into public.qorpera_runtime_node_last_resort_changes(node_id, version, last_resort, reason)
	values (p_node_id, v_node.version, p_last_resort, btrim(p_reason));
	return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'lastResort', p_last_resort, 'changed', true);
end
$$;
revoke all on function public.qorpera_set_runtime_node_last_resort(uuid, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.qorpera_set_runtime_node_last_resort(uuid, boolean, bigint, text) to service_role;

-- Applies each (old text, new text, times) triple in turn, each old text exactly that many times, then runs the result.
create function pg_temp.node_last_resort_patch(p_target regprocedure, p_edits text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930749000' in v_definition) > 0 then
		raise exception '20260930749000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 3 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[3 * i - 2], ''))) / length(p_edits[3 * i - 2]);
		if v_found <> p_edits[3 * i]::integer then
			raise exception 'Last-resort node: % holds edit % % times, not %', p_target, i, v_found, p_edits[3 * i]; end if;
		v_definition := replace(v_definition, p_edits[3 * i - 2], p_edits[3 * i - 1]);
	end loop;
	execute v_definition;
end $$;

-- 2. The run and sign-in candidates.
select pg_temp.node_last_resort_patch('public.qorpera_runtime_node_placement_candidates(text)'::regprocedure, array[
	$o$'observedAt',c.observed_at)$o$,
	$n$'observedAt',c.observed_at,'lastResort',c.last_resort)$n$, '1',
	$o$order by c.eligible desc,c.fits desc,c.free_slots desc,$o$,
	E'order by c.eligible desc,c.fits desc,\n'
		|| E'\t\t\t-- A last-resort node (20260930749000) ranks below every other node that is eligible and fits.\n'
		|| E'\t\t\tc.last_resort asc,c.free_slots desc,', '1',
	$o$select n.id as node_id,pr.provider_id,o.observed_at,u.allocated_cpu,u.allocated_memory,$o$,
	$n$select n.id as node_id,pr.provider_id,o.observed_at,u.allocated_cpu,u.allocated_memory,n.last_resort,$n$, '1']);

-- 3. The choosers of new work.
select pg_temp.node_last_resort_patch('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text)'::regprocedure, array[
	E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n',
	E'\t-- A last-resort node (20260930749000) ranks below every other node that is eligible and fits, after the node where\n'
		|| E'\t-- the run''s last start failed, which still ranks last.\n'
		|| E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n', '1',
	$o$is not distinct from p_last_node_id,$o$,
	$n$is not distinct from p_last_node_id,coalesce((c->>'lastResort')::boolean,false),$n$, '3',
	$o$order by (c->>'freeSlots')::bigint desc$o$,
	$n$order by coalesce((c->>'lastResort')::boolean,false),(c->>'freeSlots')::bigint desc$n$, '1']);

select pg_temp.node_last_resort_patch('public.qorpera_runtime_login_route_pick(jsonb,uuid[])'::regprocedure, array[
	E'\t\torder by (c->>''freeSlots'')::bigint desc,',
	E'\t\t-- A last-resort node (20260930749000) ranks below every other node that is eligible and fits.\n'
		|| E'\t\torder by coalesce((c->>''lastResort'')::boolean, false), (c->>''freeSlots'')::bigint desc,', '1']);

select pg_temp.node_last_resort_patch('public.qorpera_runtime_login_gateway_choose()'::regprocedure, array[
	E'\t\torder by (c->>''freeSlots'')::bigint desc,',
	E'\t\t-- A last-resort node (20260930749000) ranks below every other node that is eligible and fits.\n'
		|| E'\t\torder by coalesce((c->>''lastResort'')::boolean, false), (c->>''freeSlots'')::bigint desc,', '1']);

select pg_temp.node_last_resort_patch(
	'public.qorpera_runtime_run_placement(public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure, array[
	E'\torder by nodes.node_id is not distinct from v_last_node,\n',
	E'\torder by nodes.node_id is not distinct from v_last_node,\n'
		|| E'\t\t-- A last-resort node (20260930749000) ranks below every other fast host''s node; the failed node still ranks last.\n'
		|| E'\t\tcoalesce((select last_resort_node.last_resort from public.qorpera_runtime_nodes last_resort_node\n'
		|| E'\t\t\twhere last_resort_node.id = nodes.node_id), false),\n', '1']);

-- The claim path itself (review r1 F1): every answer of the claim turn passes this guard first.
select pg_temp.node_last_resort_patch(
	'public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure, array[
	$claim_old$	if v_role is null then return true; end if;
$claim_old$,
	$claim_new$	-- A last-resort node (20260930749000) claims a run only when no node that is not a last resort could take it right
	-- now. This sits before every answer below, because each one reaches the node around the chooser: no dispatch role
	-- answers true at once, a fast host after 1.5 seconds, an overflow host after 10 seconds, and a run claimed with a
	-- role records the claim turn's node instead of asking the chooser. An adapter whose nodes are not all last resort
	-- is not a last-resort host (the bundle declaration refuses an adapter that serves two nodes anyway).
	if exists (select 1 from public.qorpera_runtime_orchestrator_nodes(v_adapter) mine
			join public.qorpera_runtime_nodes spare on spare.id = mine.node_id where spare.last_resort)
		and not exists (select 1 from public.qorpera_runtime_orchestrator_nodes(v_adapter) mine
			join public.qorpera_runtime_nodes spare on spare.id = mine.node_id where not spare.last_resort) then
		v_placement := public.qorpera_runtime_run_placement(p_job, p_run);
		-- The run's own placement names this node (a warm conversation, or the only node left once the failed node and
		-- the regular nodes are passed over): nothing else can take it, so the claim stands. Otherwise ask whether a
		-- node that is not a last resort could take it right now: eligible, fits, takes the run's bundle, may hold the
		-- run's identity, and with a live host that has not refused this run's admission in the last 15 seconds. A
		-- refusal says a host is full or retiring and says nothing about the others (review r2), so it takes that host
		-- out of the set, and the set is empty only once every regular host has refused or gone ineligible. The node
		-- where this run's last start failed never counts, so the failed-start rule still prefers this node over it.
		if not exists (select 1 from public.qorpera_runtime_orchestrator_nodes(v_adapter) mine
				where mine.node_id = (v_placement ->> 'nodeId')::uuid)
			and exists (select 1 from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('native')) regular
				where (regular ->> 'eligible')::boolean and (regular ->> 'fits')::boolean
					and not coalesce((regular ->> 'lastResort')::boolean, false)
					and (regular ->> 'nodeId')::uuid is distinct from (select failure.node_id
						from public.qorpera_runtime_run_start_failures failure where failure.run_id = p_run.id)
					and public.qorpera_runtime_adapter_takes_bundle(regular ->> 'providerId', p_run.runtime_bundle_sha256)
					and public.qorpera_runtime_run_adapter_allowed(p_run, regular ->> 'providerId')
					and exists (select 1 from public.qorpera_runner_orchestrators host
						where host.provider_adapter = regular ->> 'providerId' and host.status = 'active'
							and not public.qorpera_runtime_refused_recently(p_job.run_id, host.id))) then
			return false;
		end if;
	end if;
	if v_role is null then return true; end if;
$claim_new$, '1']);

select pg_temp.node_last_resort_patch('public.qorpera_place_runtime_office_fleet(jsonb,bigint)'::regprocedure, array[
	$o$  order by (rank.value->>'freeSlots')::bigint desc,$o$,
	E'  -- A last-resort node (20260930749000) ranks below every other node that is eligible and fits.\n'
		|| $n$  order by n.last_resort,(rank.value->>'freeSlots')::bigint desc,$n$, '1']);

select pg_temp.node_last_resort_patch(
	'public.qorpera_company_machine_candidates(bigint,bigint,bigint,text,uuid)'::regprocedure, array[
	E'\torder by node.memory_bytes - node.headroom_memory_bytes - used.memory desc,',
	E'\t-- A last-resort node (20260930749000) ranks below every other node that fits.\n'
		|| E'\torder by node.last_resort, node.memory_bytes - node.headroom_memory_bytes - used.memory desc,', '1',
	-- The hardware the node's observation reports, as every other chooser and admission itself ask for it. The lines go
	-- after the agent exit's, so deploy/agent-exit/undo-20260930089100.sql still finds its own text whole.
	E'\t\tand public.qorpera_runtime_node_agent_exit_ready(node.id)\n',
	E'\t\tand public.qorpera_runtime_node_agent_exit_ready(node.id)\n'
		|| E'\t\t-- The node reports the hardware its policy counts on (20260930749000); admission refuses the rest as\n'
		|| E'\t\t-- NODE_HARDWARE_CHANGED, so without this a node that cannot take a machine stayed a candidate for it.\n'
		|| E'\t\tand (observation.observation ->> ''cpuMillis'')::bigint >= node.cpu_millis\n'
		|| E'\t\tand (observation.observation ->> ''memoryBytes'')::bigint >= node.memory_bytes\n', '1']);

select pg_temp.node_last_resort_patch('public.qorpera_coding_executor_pick(uuid)'::regprocedure, array[
	E'\torder by least((public.qorpera_runtime_node_cpu_budget(node) - used.cpu) / provider.cpu_millis,',
	E'\t-- A last-resort node (20260930749000) ranks below every other node that fits.\n'
		|| E'\torder by node.last_resort, least((public.qorpera_runtime_node_cpu_budget(node) - used.cpu) / provider.cpu_millis,',
	'1']);

select pg_temp.node_last_resort_patch('public.qorpera_coding_executor_enroll(uuid,text)'::regprocedure, array[
	E'\tgroup by executor.owner order by count(*), executor.owner limit 1;',
	E'\t-- An executor on a last-resort node (20260930749000) only when no other enabled one serves the harness: a company\n'
		|| E'\t-- keeps its executor, so the spare would otherwise take every new company while it serves the fewest.\n'
		|| E'\tgroup by executor.owner order by exists (select 1 from public.qorpera_coding_executors spare\n'
		|| E'\t\tjoin public.qorpera_runtime_nodes node on node.machine_id_sha256 = spare.nas_machine_id_sha256\n'
		|| E'\t\twhere spare.owner = executor.owner and node.last_resort), count(*), executor.owner limit 1;', '1']);

-- 4. The pull path.
select pg_temp.node_last_resort_patch('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure, array[
	E'\t\tnode.memory_bytes - node.headroom_memory_bytes - coalesce(sum(demand.memory_bytes), 0) as memory into v_room',
	E'\t\tnode.memory_bytes - node.headroom_memory_bytes - coalesce(sum(demand.memory_bytes), 0) as memory,\n'
		|| E'\t\tnode.last_resort into v_room', '1',
	E'\t\t\t\tand (here.owner = p_owner or (machine.disk_bytes <= v_disk and (here.id is null or here.running_at is null)))\n',
	E'\t\t\t\tand (here.owner = p_owner or (machine.disk_bytes <= v_disk and (here.id is null or here.running_at is null)))\n'
		|| E'\t\t\t\t-- A last-resort node (20260930749000) takes one that is not asleep here only when no other node could: no\n'
		|| E'\t\t\t\t-- node that is not a last resort fits it now (the candidates'' own test, its own disk given back).\n'
		|| E'\t\t\t\tand (not v_room.last_resort or here.owner = p_owner or not exists (select 1\n'
		|| E'\t\t\t\t\tfrom public.qorpera_company_machine_candidates(machine.cpus::bigint * 1000, machine.memory_bytes,\n'
		|| E'\t\t\t\t\t\tmachine.disk_bytes, null, here.id) other\n'
		|| E'\t\t\t\t\tjoin public.qorpera_runtime_nodes other_node on other_node.machine_id_sha256 = other.machine_id_sha256\n'
		|| E'\t\t\t\t\twhere not other_node.last_resort))\n', '1',
	E'\t\t\tand (here.id is null or here.running_at is null)\n\t\torder by machine.wanted_at, machine.id limit 1;',
	E'\t\t\tand (here.id is null or here.running_at is null)\n'
		|| E'\t\t\t-- A last-resort node (20260930749000) gives up no disk for a machine another node could take now.\n'
		|| E'\t\t\tand (not v_room.last_resort or not exists (select 1\n'
		|| E'\t\t\t\tfrom public.qorpera_company_machine_candidates(machine.cpus::bigint * 1000, machine.memory_bytes,\n'
		|| E'\t\t\t\t\tmachine.disk_bytes, null, here.id) other\n'
		|| E'\t\t\t\tjoin public.qorpera_runtime_nodes other_node on other_node.machine_id_sha256 = other.machine_id_sha256\n'
		|| E'\t\t\t\twhere not other_node.last_resort))\n'
		|| E'\t\torder by machine.wanted_at, machine.id limit 1;', '1']);

drop function pg_temp.node_last_resort_patch(regprocedure, text[]);
