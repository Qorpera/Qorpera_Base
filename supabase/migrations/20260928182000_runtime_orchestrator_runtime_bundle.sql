-- Identical nodes, change 4 (Stateless Compute step 4, 28 Sep 2026): each run keeps its version.
--
-- A run is bound to a runtime bundle when it is created (from its inputs, else the active bundle),
-- and the run's host refuses any other bundle (runtime assertCloudRuntimeBundle). Today every
-- update pauses all companies so that no run of the old bundle is left when the new one activates.
-- For rolling updates two bundles serve side by side for a short window: the updated node runs the
-- new one, the other node finishes the old one.
--
--   * An orchestrator may declare the bundle its hosts run
--     (qorpera_declare_runner_orchestrator_bundle, service role). A declared orchestrator claims only
--     runs of that bundle. An undeclared orchestrator claims as before, so nothing changes until an
--     operator declares, and a normal paused cut needs no declaration at all.
--   * Re-registering an orchestrator (every fast-host rebuild does) clears its declaration: a rebuilt
--     host may run another bundle, so it is undeclared until the operator declares it again.
--   * qorpera_runtime_bundle_roll_status (service role): the active bundle, and for every bundle with
--     work (queued or running runs, inputs not yet turned into a run) or a declared orchestrator:
--     that work, which orchestrators may claim it and on which nodes, and whether a serving node can.
--     The rolling-update procedure empties the old node only once its bundle has no work left.
-- No lock beyond the orchestrator row; the claim reads the declaration by primary key.

alter table public.qorpera_runner_orchestrators
	add column runtime_bundle_sha256 text check (runtime_bundle_sha256 ~ '^[0-9a-f]{64}$'),
	add column runtime_bundle_declared_at timestamptz,
	add constraint qorpera_runner_orchestrators_bundle_declared check ((runtime_bundle_sha256 is null) = (runtime_bundle_declared_at is null));

create function public.qorpera_declare_runner_orchestrator_bundle(p_orchestrator_id uuid, p_runtime_bundle_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare v_orchestrator public.qorpera_runner_orchestrators%rowtype; v_version bigint;
begin
	if auth.role() is distinct from 'service_role' or p_orchestrator_id is null
		or (p_runtime_bundle_sha256 is not null and p_runtime_bundle_sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'Invalid orchestrator bundle declaration' using errcode = '42501';
	end if;
	if p_runtime_bundle_sha256 is not null then
		select bundle.version into v_version from public.qorpera_runtime_bundles bundle
		where bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.sha256 = p_runtime_bundle_sha256;
		if not found then raise exception 'Runtime bundle is not registered' using errcode = '42501'; end if;
	end if;
	select * into v_orchestrator from public.qorpera_runner_orchestrators where id = p_orchestrator_id for update;
	if not found or v_orchestrator.status = 'revoked' then
		raise exception 'Orchestrator is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_runner_orchestrators
	set runtime_bundle_sha256 = p_runtime_bundle_sha256,
		runtime_bundle_declared_at = case when p_runtime_bundle_sha256 is null then null else clock_timestamp() end
	where id = p_orchestrator_id;
	return jsonb_build_object('orchestratorId', p_orchestrator_id, 'runtimeBundleSha256', p_runtime_bundle_sha256,
		'runtimeBundleVersion', v_version);
end
$$;

do $register$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_register_runner_orchestrator(uuid,text,text,text,integer)'::regprocedure);
	v_old := '		last_heartbeat_at = statement_timestamp()
	where public.qorpera_runner_orchestrators.status <> ''revoked''';
	v_new := '		last_heartbeat_at = statement_timestamp(),
		runtime_bundle_sha256 = null,
		runtime_bundle_declared_at = null
	where public.qorpera_runner_orchestrators.status <> ''revoked''';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'register_runner_orchestrator conflict update differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$register$;

do $claim$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	v_old := '		and public.qorpera_execution_compute_available(run)
';
	v_new := v_old || '		-- A declared orchestrator claims only runs of the runtime bundle its hosts run (rolling updates).
		and not exists (
			select 1 from public.qorpera_runner_orchestrators as declared
			where declared.id = p_orchestrator_id and declared.runtime_bundle_sha256 is not null
				and declared.runtime_bundle_sha256 is distinct from run.runtime_bundle_sha256
		)
';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'claim_runner_job_for_orchestrator compute predicate differs';
	end if;
	execute replace(v_def, v_old, v_new);
end
$claim$;

-- Work per runtime bundle, and who can take it.
create function public.qorpera_runtime_bundle_roll_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_active public.qorpera_active_runtime_bundle%rowtype; v_bundles jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Operator access required' using errcode = '42501'; end if;
	select * into strict v_active from public.qorpera_active_runtime_bundle where singleton;
	with work as (
		-- Queued: nobody holds it yet. Running: claimed by an orchestrator, or leased.
		select run.runtime_bundle_sha256 sha,
			count(*) filter (where job.status = 'queued' and not claimed.held) queued,
			count(*) filter (where job.status = 'leased' or claimed.held) running
		from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.id = job.run_id
		cross join lateral (select exists (select 1 from public.qorpera_runner_job_claims claim
			where claim.job_id = job.id and claim.status in ('claimed', 'assigned')) held) claimed
		where job.status in ('queued', 'leased')
		group by run.runtime_bundle_sha256
	), inputs as (
		select input.runtime_bundle_sha256 sha, count(*) pending, min(input.created_at) oldest
		from public.qorpera_session_inputs input
		where input.completed_at is null and input.failed_at is null and input.execution_run_id is null and input.turn_id is null
		group by input.runtime_bundle_sha256
	), orchestrators as (
		select orchestrator.id, orchestrator.provider_adapter, orchestrator.runtime_bundle_sha256 sha, node.node_id, node.enabled,
			orchestrator.last_heartbeat_at, orchestrator.last_heartbeat_at > clock_timestamp() - interval '2 minutes' live
		from public.qorpera_runner_orchestrators orchestrator
		left join lateral public.qorpera_runtime_orchestrator_nodes(orchestrator.provider_adapter) node on true
		where orchestrator.status = 'active'
	), shas as (
		select sha from work union select sha from inputs union select sha from orchestrators where sha is not null
		union select v_active.runtime_bundle_sha256
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'version', bundle.version, 'sha256', shas.sha, 'active', shas.sha = v_active.runtime_bundle_sha256,
		'queuedRuns', coalesce(work.queued, 0), 'runningRuns', coalesce(work.running, 0),
		'pendingInputs', coalesce(inputs.pending, 0), 'oldestPendingInputAt', inputs.oldest,
		'declaredBy', coalesce((select jsonb_agg(jsonb_build_object('orchestratorId', o.id, 'providerAdapter', o.provider_adapter,
			'nodeId', o.node_id, 'serving', o.enabled, 'lastHeartbeatAt', o.last_heartbeat_at) order by o.id, o.node_id)
			from orchestrators o where o.sha = shas.sha), '[]'::jsonb),
		-- Claimable now by: live (heartbeat within 2 minutes) active orchestrators declaring this bundle or
		-- none, on a serving node or with no node row (the serving switch cannot stop those, 20260928180700).
		-- An upper bound: an undeclared orchestrator refuses bundles its hosts do not run, the identity-home
		-- rule still applies, and a just re-registered orchestrator counts as live before it starts.
		'servedBy', coalesce((select jsonb_agg(distinct o.id) from orchestrators o where o.live and coalesce(o.enabled, true)
			and (o.sha is null or o.sha = shas.sha)), '[]'::jsonb),
		'servedOnServingNode', exists (select 1 from orchestrators o where o.live and coalesce(o.enabled, true)
			and (o.sha is null or o.sha = shas.sha)))
		order by bundle.version), '[]'::jsonb)
	into v_bundles
	from shas
	left join public.qorpera_runtime_bundles bundle on bundle.sha256 = shas.sha and bundle.bundle_key = 'qorpera.cloud-runtime'
	left join work on work.sha = shas.sha
	left join inputs on inputs.sha = shas.sha;
	-- Orchestrators that declare nothing claim every bundle, but their hosts run only one and refuse the
	-- rest: during a roll every orchestrator that may claim should be declared. `undeclared` ignores the
	-- heartbeat (a rebuilt host left stopped claims at its first call); `undeclaredLive` is its live part.
	return jsonb_build_object('schema', 'qorpera.runtime-bundle-roll-status/v1', 'activeVersion',
		(select version from public.qorpera_runtime_bundles where id = v_active.runtime_bundle_id),
		'activeSha256', v_active.runtime_bundle_sha256, 'bundles', v_bundles,
		'undeclared', (select coalesce(jsonb_agg(orchestrator.id order by orchestrator.id), '[]'::jsonb)
			from public.qorpera_runner_orchestrators orchestrator
			where orchestrator.status = 'active' and orchestrator.runtime_bundle_sha256 is null),
		'undeclaredLive', (select coalesce(jsonb_agg(orchestrator.id order by orchestrator.id), '[]'::jsonb)
			from public.qorpera_runner_orchestrators orchestrator
			where orchestrator.status = 'active' and orchestrator.runtime_bundle_sha256 is null
				and orchestrator.last_heartbeat_at > clock_timestamp() - interval '2 minutes'));
end
$$;

revoke all on function public.qorpera_declare_runner_orchestrator_bundle(uuid, text),
	public.qorpera_runtime_bundle_roll_status() from public, anon, authenticated, service_role;
grant execute on function public.qorpera_declare_runner_orchestrator_bundle(uuid, text),
	public.qorpera_runtime_bundle_roll_status() to service_role;
