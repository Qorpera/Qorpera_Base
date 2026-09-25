-- What the backend itself reports about the live deployment. One read-only SELECT, one JSON row.
-- Run it read-only (e.g. the Supabase Management API query endpoint with read_only=true) and save the
-- `observed` value as observed.json; `node manifest.mjs drift` compares it with the manifest.
-- Nothing here reaches a node: node release numbers and program digests are not reported to the backend.
select jsonb_build_object(
	'schema', 'qorpera.deployment-observed-state/v1',
	'observedAt', clock_timestamp(),
	'activeBundle', (
		select jsonb_build_object('version', b.version, 'sha256', a.runtime_bundle_sha256, 'activatedAt', a.activated_at)
		from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id and b.sha256 = a.runtime_bundle_sha256
	),
	'lastMigration', (
		select jsonb_build_object('version', m.version, 'name', m.name,
			'count', (select count(*) from supabase_migrations.schema_migrations))
		from supabase_migrations.schema_migrations m order by m.version desc limit 1
	),
	-- Newest enrolled policy per provider (every earlier sha stays enrolled; the newest one is what the last cut enrolled).
	'nodeProviders', coalesce((
		select jsonb_agg(jsonb_build_object('kind', p.provider_kind, 'providerId', p.provider_id, 'nodeId', p.node_id,
			'policySha256', p.policy_sha256, 'cpuMillis', p.cpu_millis, 'memoryBytes', p.memory_bytes, 'createdAt', p.created_at)
			order by p.provider_kind, p.provider_id)
		from (
			select distinct on (provider_kind, provider_id) *
			from public.qorpera_runtime_node_providers
			order by provider_kind, provider_id, created_at desc
		) p
	), '[]'::jsonb),
	'inventoryPolicies', coalesce((
		select jsonb_agg(jsonb_build_object('nodeId', i.node_id, 'policySha256', i.policy_sha256, 'enrolledAt', i.enrolled_at)
			order by i.node_id)
		from public.qorpera_runtime_node_inventory_policies i
	), '[]'::jsonb),
	'codingVmPolicies', coalesce((
		select jsonb_agg(jsonb_build_object('environmentId', c.environment_id, 'owner', c.owner, 'enabled', c.enabled,
			'vmPolicy', c.vm_policy) order by c.environment_id)
		from public.qorpera_coding_executors c
		where c.vm_policy is not null
	), '[]'::jsonb),
	-- The newest activation of each office (Company Computer): a software revision or a restart makes a successor
	-- activation within the same generation.
	'officeActivations', coalesce((
		select jsonb_agg(jsonb_build_object('officeId', o.office_id, 'generation', o.computer_generation,
			'allocationId', o.allocation_id, 'activationId', o.activation_id,
			'imageSha256', o.image_sha256, 'bootstrapSha256', o.bootstrap_sha256,
			'providerPolicySha256', o.provider_policy_sha256, 'activatedAt', o.activated_at) order by o.office_id)
		from (
			select distinct on (office_id) *
			from public.qorpera_runtime_office_activations
			where state = 'active'
			order by office_id, computer_generation desc, activated_at desc
		) o
	), '[]'::jsonb),
	'secretBrokerAuthorities', coalesce((
		select jsonb_agg(jsonb_build_object('profileId', s.profile_id, 'keyId', s.key_id, 'serviceOrigin', s.service_origin,
			'createdAt', s.created_at) order by s.profile_id)
		from public.qorpera_cloud_secret_broker_authorities s
		where s.status = 'active'
	), '[]'::jsonb),
	-- Runs created since the active bundle was activated, by the bundle they carry. Any sha other than the active
	-- bundle's means something still runs an older runtime.
	'runsSinceActivation', coalesce((
		select jsonb_agg(jsonb_build_object('runtimeBundleSha256', r.sha, 'runs', r.runs, 'lastCreatedAt', r.last_at)
			order by r.runs desc)
		from (
			select run.runtime_bundle_sha256 sha, count(*) runs, max(run.created_at) last_at
			from public.qorpera_execution_runs run
			where run.created_at >= (select activated_at from public.qorpera_active_runtime_bundle)
			group by run.runtime_bundle_sha256
		) r
	), '[]'::jsonb)
) as observed;
