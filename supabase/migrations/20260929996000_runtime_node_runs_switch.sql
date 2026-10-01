-- Rolling updates, step 1 (identical nodes change 7, 2 Oct 2026): a node can stop taking runs while its
-- machines stay admitted, and a run is placed only on a node whose orchestrators run its bundle.
--
-- A node release restarts only the node's run provider and orchestrator (the node agent's roles), and the
-- fast host rebuild touches only the fast host. Company computers, coding machines and agent machines are
-- served by their own services, which a release does not restart. So emptying a node for a release needs
-- no new runs and sign-ins there, not a stop of every machine. Until now the one serving switch
-- (20260928180700) stopped everything for the whole roll: a sleeping computer could not wake there, a coding
-- turn of a member whose machine is there waited, and a sleeping agent machine moved to another node.
--
-- 1. The runs switch: qorpera_runtime_nodes.runs_enabled and qorpera_set_runtime_node_runs (the full switch's
--    checks, except the signed-updater refusal, which guards `enabled` only). A node with runs
--    off takes no new run or sign-in: run and sign-in candidates leave it out, the ledger refuses a new
--    native or login reservation there (NODE_DISABLED, as the full switch does), and its orchestrators claim
--    nothing new. Machines (office, coding, machine) are admitted as before. Work already running, and
--    reservations the node already holds, are not touched. The full switch stays for a host restart.
--    Every run path reads a node's serving state through qorpera_runtime_orchestrator_nodes (the claim, the
--    claim turn, run placement, roll status, drain status), which now reports a node as serving only when
--    both switches are on.
-- 2. Drain status adds runsServing and readyForNodeRelease: runs off, and no run, run machine, sign-in or
--    other reservation left on the node. Coding turns and awake machines may continue.
-- 3. Placement follows bundle declarations. With dispatch roles unset the node chooser places a run, and it
--    did not look at the declarations of 20260928182000. During a roll it could prefer the node still
--    declared for the old bundle, whose orchestrators cannot claim the new bundle's runs, and refuse the node
--    that can (NODE_NOT_PREFERRED) until the old node emptied. A provider whose active orchestrators are all
--    declared for another bundle is no candidate for a run now, and such a claimant is refused (it waits): the
--    run reservation passes the run's bundle to a six-argument chooser; the five- and four-argument forms pass
--    none and decide as before. "Active" is the orchestrator's status, not a fresh heartbeat (the claim needs
--    none either): a roll declares every orchestrator of a node, so no stale undeclared row stays behind.
-- 4. qorpera_declare_runtime_node_bundle declares every orchestrator of one node at once.
--
-- Patched by anchor: qorpera_runtime_orchestrator_nodes, qorpera_runtime_node_placement_candidates,
-- qorpera_reserve_runtime_node_machine, qorpera_runtime_node_drain_status, qorpera_reserve_runtime_machine.
-- The chooser's body moves to the six-argument form, made from the five-argument one by anchor.
-- Locks: the runs switch takes the node's advisory lock and row, as the full switch does; nothing else
-- takes a new lock. The nodes table gains a column under a short lock_timeout.
set local lock_timeout = '5s';

create function pg_temp.runs_switch_patch(p_target regprocedure, p_old text, p_new text)
returns text language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Runs switch source differs: %', p_target;
	end if;
	return replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_runtime_nodes add column runs_enabled boolean not null default true;
alter table public.qorpera_runtime_node_serving_changes
	add column scope text not null default 'node' check (scope in ('node', 'runs'));

-- 1. The runs switch, beside the full one (same checks and lock order; the stored policy is not touched:
-- the runs switch is not part of a node's policy, so a new policy version keeps it).
create function public.qorpera_set_runtime_node_runs(p_node_id uuid, p_runs boolean, p_expected_version bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_node public.qorpera_runtime_nodes%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_node_id is null or p_runs is null
		or p_expected_version is null or p_expected_version not between 1 and 9007199254740989
		or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 200 then
		raise exception 'Invalid node runs change' using errcode = '42501';
	end if;
	-- The same node-only lock order as qorpera_set_runtime_node_serving: advisory lock, then the node row.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:' || p_node_id::text, 0));
	select * into v_node from public.qorpera_runtime_nodes where id = p_node_id for update;
	if not found then raise exception 'Node is not configured' using errcode = '42501'; end if;
	if v_node.version <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node policy version changed',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_node.runs_enabled = p_runs then
		return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'serving', v_node.enabled,
			'runsServing', v_node.runs_enabled, 'changed', false);
	end if;
	update public.qorpera_runtime_nodes set runs_enabled = p_runs, updated_at = clock_timestamp()
	where id = p_node_id returning * into v_node;
	insert into public.qorpera_runtime_node_serving_changes(node_id, version, serving, reason, scope)
	values (p_node_id, v_node.version, p_runs, btrim(p_reason), 'runs');
	return jsonb_build_object('nodeId', p_node_id, 'version', v_node.version, 'serving', v_node.enabled,
		'runsServing', p_runs, 'changed', true);
end
$$;
revoke all on function public.qorpera_set_runtime_node_runs(uuid, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.qorpera_set_runtime_node_runs(uuid, boolean, bigint, text) to service_role;

-- Every run path asks this helper whether an adapter's node serves (it maps native providers only).
do $$ begin execute pg_temp.runs_switch_patch('public.qorpera_runtime_orchestrator_nodes(text)'::regprocedure,
	'select distinct node.id, node.enabled',
	'select distinct node.id, node.enabled and node.runs_enabled'); end $$;

-- Run and sign-in candidates leave a node with runs off out; office and coding candidates do not.
do $$ begin execute pg_temp.runs_switch_patch('public.qorpera_runtime_node_placement_candidates(text)'::regprocedure,
	'coalesce(n.enabled and o.node_id is not null',
	'coalesce(n.enabled and (p_provider_kind not in (''native'',''login'') or n.runs_enabled) and o.node_id is not null'); end $$;

-- The ledger refuses a new run or sign-in reservation there; a held one passes again.
do $$ begin execute pg_temp.runs_switch_patch(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
	' if not v_node.enabled and (v_demand.reserved_at is null or v_demand.suspended_at is not null) then v_reason:=''NODE_DISABLED'';',
	' if (not v_node.enabled or (not v_node.runs_enabled and p_provider_kind in (''native'',''login'')))'
		|| ' and (v_demand.reserved_at is null or v_demand.suspended_at is not null) then v_reason:=''NODE_DISABLED'';'); end $$;

-- 2. Drain status: the runs switch, and readiness for a node release.
do $$
declare v_definition text;
begin
	v_definition := pg_temp.runs_switch_patch('public.qorpera_runtime_node_drain_status(uuid)'::regprocedure,
		E'\t\t''version'', v_node.version, ''serving'', v_node.enabled,\n',
		E'\t\t''version'', v_node.version, ''serving'', v_node.enabled, ''runsServing'', v_node.enabled and v_node.runs_enabled,\n');
	if (length(v_definition) - length(replace(v_definition, E'''serving'', v_change.serving, ''reason'', v_change.reason,', '')))
		/ length(E'''serving'', v_change.serving, ''reason'', v_change.reason,') <> 1
		or (length(v_definition) - length(replace(v_definition, E'\t\t''readyForRestart'', not v_node.enabled', '')))
			/ length(E'\t\t''readyForRestart'', not v_node.enabled') <> 1 then
		raise exception 'Runs switch source differs: drain status';
	end if;
	v_definition := replace(v_definition, E'''serving'', v_change.serving, ''reason'', v_change.reason,',
		E'''serving'', v_change.serving, ''scope'', v_change.scope, ''reason'', v_change.reason,');
	-- A node release restarts the run provider and orchestrator only: coding turns and machines may continue.
	v_definition := replace(v_definition, E'\t\t''readyForRestart'', not v_node.enabled',
		E'\t\t''readyForNodeRelease'', not (v_node.enabled and v_node.runs_enabled) and v_runs = 0 and v_run_machines = 0\n'
		|| E'\t\t\tand v_logins = 0 and v_other = 0 and jsonb_array_length(v_elsewhere) = 0,\n'
		|| E'\t\t''readyForRestart'', not v_node.enabled');
	execute v_definition;
end $$;

-- 3. Placement follows bundle declarations.
-- An adapter takes a bundle unless every live orchestrator on it is declared for another one.
create function public.qorpera_runtime_adapter_takes_bundle(p_provider_adapter text, p_runtime_bundle_sha256 text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_runtime_bundle_sha256 is null
		or exists (select 1 from public.qorpera_runner_orchestrators orchestrator
			where orchestrator.provider_adapter = p_provider_adapter and orchestrator.status = 'active'
				and (orchestrator.runtime_bundle_sha256 is null or orchestrator.runtime_bundle_sha256 = p_runtime_bundle_sha256))
		or not exists (select 1 from public.qorpera_runner_orchestrators orchestrator
			where orchestrator.provider_adapter = p_provider_adapter and orchestrator.status = 'active'
				and orchestrator.runtime_bundle_sha256 is not null)
$$;
revoke all on function public.qorpera_runtime_adapter_takes_bundle(text, text) from public, anon, authenticated, service_role;

-- The chooser's body moves to a six-argument form that also takes the run's bundle. Providers that cannot
-- take it are marked (not removed), so the placement record shows why another node was preferred.
do $$
declare v_definition text;
begin
	v_definition := pg_temp.runs_switch_patch(
		'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid)'::regprocedure,
		'(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid, p_last_node_id uuid)',
		'(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid, p_last_node_id uuid, p_runtime_bundle_sha256 text)');
	if (length(v_definition) - length(replace(v_definition,
			E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n', '')))
		/ length(E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n') <> 1 then
		raise exception 'Runs switch source differs: node chooser';
	end if;
	v_definition := replace(v_definition, E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n',
		E'\tv_candidates:=public.qorpera_runtime_node_placement_candidates(p_provider_kind);\n'
		|| E'\t-- A provider whose live orchestrators all run another runtime bundle cannot claim this run (20260929996000).\n'
		|| E'\tif p_runtime_bundle_sha256 is not null then\n'
		|| E'\t\tselect coalesce(jsonb_agg(case when public.qorpera_runtime_adapter_takes_bundle(e.c->>''providerId'',p_runtime_bundle_sha256) then e.c\n'
		|| E'\t\t\telse e.c || ''{"eligible":false,"otherBundle":true}''::jsonb end order by e.ord),''[]''::jsonb)\n'
		|| E'\t\tinto v_candidates from jsonb_array_elements(v_candidates) with ordinality as e(c,ord);\n'
		|| E'\tend if;\n');
	if (length(v_definition) - length(replace(v_definition,
			E'\tv_node:=(v_self->>''nodeId'')::uuid; v_preferred_node:=(v_preferred->>''nodeId'')::uuid;\n', '')))
		/ length(E'\tv_node:=(v_self->>''nodeId'')::uuid; v_preferred_node:=(v_preferred->>''nodeId'')::uuid;\n') <> 1 then
		raise exception 'Runs switch source differs: node chooser record';
	end if;
	-- The claimant itself runs another bundle (its declaration changed after the claim): it never takes the run.
	v_definition := replace(v_definition, E'\tv_node:=(v_self->>''nodeId'')::uuid; v_preferred_node:=(v_preferred->>''nodeId'')::uuid;\n',
		E'\tif coalesce((v_self->>''otherBundle'')::boolean,false) and v_decision<>''refused'' then\n'
		|| E'\t\tv_decision:=''refused''; v_reason:=''NODE_NOT_PREFERRED''; end if;\n'
		|| E'\tv_node:=(v_self->>''nodeId'')::uuid; v_preferred_node:=(v_preferred->>''nodeId'')::uuid;\n');
	execute v_definition;
end $$;
revoke all on function public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text) to service_role;

-- The five-argument form passes no bundle (the four-argument form already passes no node).
create or replace function public.qorpera_runtime_node_placement_decide(p_allocation_id uuid, p_provider_kind text, p_provider_id text, p_compute_identity_id uuid, p_last_node_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_runtime_node_placement_decide(p_allocation_id,p_provider_kind,p_provider_id,p_compute_identity_id,p_last_node_id,null::text);
$$;

-- A run machine's reservation passes the run's bundle.
do $$ begin execute pg_temp.runs_switch_patch(
	'public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
	'(select failure.node_id from public.qorpera_runtime_run_start_failures failure where failure.run_id=p_run_id));',
	'(select failure.node_id from public.qorpera_runtime_run_start_failures failure where failure.run_id=p_run_id),'
		|| E'\n\t\t\t\tv_run.runtime_bundle_sha256);'); end $$;

-- 4. Declare every orchestrator of one node for a bundle (or clear with null), in id order.
create function public.qorpera_declare_runtime_node_bundle(p_node_id uuid, p_runtime_bundle_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_orchestrator uuid; v_declared jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_node_id is null
		or (p_runtime_bundle_sha256 is not null and p_runtime_bundle_sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'Invalid node bundle declaration' using errcode = '42501';
	end if;
	if not exists (select 1 from public.qorpera_runtime_nodes where id = p_node_id) then
		raise exception 'Node is not configured' using errcode = '42501';
	end if;
	if p_runtime_bundle_sha256 is not null and not exists (select 1 from public.qorpera_runtime_bundles bundle
		where bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.sha256 = p_runtime_bundle_sha256) then
		raise exception 'Runtime bundle is not registered' using errcode = '42501';
	end if;
	-- An orchestrator whose adapter also maps to another node would declare that node too.
	if exists (select 1 from public.qorpera_runner_orchestrators orchestrator
		where orchestrator.status <> 'revoked'
			and exists (select 1 from public.qorpera_runtime_node_providers provider
				where provider.provider_kind = 'native' and provider.provider_id = orchestrator.provider_adapter
					and provider.node_id = p_node_id)
			and exists (select 1 from public.qorpera_runtime_node_providers provider
				where provider.provider_kind = 'native' and provider.provider_id = orchestrator.provider_adapter
					and provider.node_id <> p_node_id)) then
		raise exception 'An orchestrator of this node also serves another node' using errcode = '55000';
	end if;
	for v_orchestrator in
		select orchestrator.id from public.qorpera_runner_orchestrators orchestrator
		where orchestrator.status <> 'revoked'
			and exists (select 1 from public.qorpera_runtime_node_providers provider
				where provider.provider_kind = 'native' and provider.provider_id = orchestrator.provider_adapter
					and provider.node_id = p_node_id)
		order by orchestrator.id
	loop
		v_declared := v_declared || jsonb_build_array(
			public.qorpera_declare_runner_orchestrator_bundle(v_orchestrator, p_runtime_bundle_sha256));
	end loop;
	return jsonb_build_object('nodeId', p_node_id, 'runtimeBundleSha256', p_runtime_bundle_sha256, 'orchestrators', v_declared);
end
$$;
revoke all on function public.qorpera_declare_runtime_node_bundle(uuid, text) from public, anon, authenticated;
grant execute on function public.qorpera_declare_runtime_node_bundle(uuid, text) to service_role;

drop function pg_temp.runs_switch_patch(regprocedure, text, text);
