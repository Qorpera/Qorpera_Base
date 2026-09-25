-- Which node and provider policy each run since the active bundle's activation was placed on. One read-only SELECT,
-- one JSON row. Use it before an accept operation: a run accepts only the node release it actually ran on.
-- A retried run can hold several machine allocations; the newest one is shown.
select jsonb_build_object(
	'schema', 'qorpera.deployment-run-placements/v1',
	'observedAt', clock_timestamp(),
	'activatedAt', (select activated_at from public.qorpera_active_runtime_bundle),
	'runs', coalesce((
		select jsonb_agg(jsonb_build_object('runId', r.id, 'createdAt', r.created_at, 'profileId', r.profile_id,
			'jobStatus', j.status, 'runtimeBundleSha256', r.runtime_bundle_sha256, 'providerKind', d.provider_kind,
			'providerId', d.provider_id, 'providerPolicySha256', d.policy_sha256, 'nodeId', d.node_id)
			order by r.created_at)
		from public.qorpera_execution_runs r
		join public.qorpera_runner_jobs j on j.id = r.job_id
		left join lateral (
			select a.id from public.qorpera_runtime_machine_allocations a
			where a.run_id = r.id order by a.reserved_at desc limit 1
		) a on true
		left join public.qorpera_runtime_node_demands d on d.allocation_id = a.id
		where r.created_at >= (select activated_at from public.qorpera_active_runtime_bundle)
	), '[]'::jsonb)
) as placements;
