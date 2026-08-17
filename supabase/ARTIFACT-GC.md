# Artifact cleanup operations

Artifact cleanup is a recoverable, service-owned workflow. Desktop clients can create, inspect, cancel, and retry plans through authenticated RPCs, but cannot read Storage paths or delete objects.

## Safety boundary

- A plan requires owner or admin access, an expired artifact recovery grace, no active hold, no retained substrate reference, a complete reachability graph, a current restore proof, and current proof coverage for every other profile root.
- Creating a plan quarantines the artifact and snapshots only objects that are exclusive at that point. The plan cannot run for 24 hours, so it can be reviewed and cancelled before deletion starts.
- The worker rechecks the profile safety proof when it claims a plan. While a plan is deleting, new profile object roots and graph completion are fenced.
- Before each object batch, objects referenced by another completed root are changed to `retained` and are never sent to Storage removal.
- Storage removal is acknowledged only after the provider call succeeds. Ambiguous or partial failures retry idempotently with the same object identities.
- Completion is refused while a pending plan entry or an acknowledged Storage row still exists. Audit receipts contain counts and state transitions, not object paths.
- Once deletion has started, cancellation is disabled because some objects may already be absent. A failed partial plan must be retried to a terminal state.

## Deployment

1. Apply `migrations/20260816018000_artifact_gc_worker.sql`.
2. Deploy `functions/artifact-gc-worker` with JWT verification disabled as declared in `config.toml`.
3. Invoke the function only with a Supabase secret key. Never place that key in the desktop bundle, repository, logs, or plan rows.
4. After a zero-job dry run, schedule the worker every five minutes. The existing project URL and worker-key Vault secrets used by invitation delivery can be reused without copying their values:

```sql
select cron.schedule(
	'qorpera-artifact-gc-worker',
	'*/5 * * * *',
	$$
	select net.http_post(
		url := (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_project_url')
			|| '/functions/v1/artifact-gc-worker',
		headers := jsonb_build_object(
			'content-type', 'application/json',
			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_invitation_worker_key')
		),
		body := '{}'::jsonb
	);
	$$
);
```

## Monitoring and recovery

Monitor aggregate state without selecting object entries:

```sql
select status, count(*) as plan_count
from public.qorpera_artifact_gc_plans
group by status
order by status;
```

- A growing `retrying` count indicates a transient Storage, proof-coverage, or completion-visibility problem.
- A `deleting` plan with an expired lease is claimable by the next invocation.
- After eight failed claims, the plan becomes `failed`. An owner or admin can explicitly request a manual retry after the cause is resolved.
- Do not manually mark entries deleted, alter plan counts, or delete metadata rows. Recovery must resume through the worker so Storage state is checked before completion.
- Cancelling the five-minute cron stops new claims. It does not invalidate active five-minute leases; wait for those leases to expire before incident analysis.

The NAS is not involved in this workflow. A future Qorpera Computer runner can use the same hosted object store and cleanup contract without receiving database service credentials.
