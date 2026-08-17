# Artifact cleanup operations

Artifact cleanup is a recoverable, service-owned workflow. Desktop clients can create, inspect, cancel, and retry plans through authenticated RPCs, but cannot read Storage paths or delete objects.

## Safety boundary

- A plan requires owner or admin access, an expired artifact recovery grace, no active hold, no retained substrate reference, an independently verified reachability closure for every live profile root, and a current restore proof for the candidate artifact. Historical roots do not require weekly full-content restore proofs.
- Creating a plan quarantines the artifact and snapshots only objects that are exclusive at that point. The plan cannot run for 24 hours, so it can be reviewed and cancelled before deletion starts.
- The worker rechecks the profile safety proof when it claims a plan. Claim decisions and root, retention, index, and substrate writes serialize on the same profile row, closing the READ COMMITTED write-skew window. While a plan is deleting, new profile object roots and graph completion are fenced.
- Before each object batch, objects referenced by another completed root are changed to `retained` and are never sent to Storage removal.
- Immediately before every Storage batch, the worker revalidates and renews the exact plan lease. Storage removal is acknowledged only after the provider call succeeds. Ambiguous or partial failures retry idempotently with the same object identities.
- Completion is refused while a pending plan entry or an acknowledged Storage row still exists. Audit receipts contain counts and state transitions, not object paths.
- Active deletion cannot be cancelled. If the worker disappears, an owner or admin can cancel only after the lease plus a one-minute stale-request grace has expired, which lifts the profile fence without accepting a late worker acknowledgement.

## Deployment

1. Apply `migrations/20260816018000_artifact_gc_worker.sql`, `migrations/20260817004000_review_blocker_hardening.sql`, and `migrations/20260817005000_gc_retention_correctness.sql` in version order. Existing SQL-editor environments apply only the corrective migrations they have not already received.
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
- A `deleting` plan with an expired lease is claimable by the next invocation. After the additional one-minute stale-request grace, an owner or admin can cancel it to recover a profile when the worker cannot be restored.
- After eight failed claims, the plan becomes `failed`. An owner or admin can explicitly request a manual retry after the cause is resolved.
- Do not manually mark entries deleted, alter plan counts, or delete metadata rows. Recovery must resume through the worker so Storage state is checked before completion.
- Cancelling the five-minute cron stops new claims. It does not invalidate active five-minute leases; wait for those leases to expire before incident analysis.

The NAS is not involved in this workflow. A future Qorpera Computer runner can use the same hosted object store and cleanup contract without receiving database service credentials.
