# Artifact cleanup operations

Artifact cleanup is a recoverable, service-owned workflow. Desktop clients can create, inspect, cancel, and retry plans through authenticated RPCs, but cannot read Storage paths or delete objects.

## Safety boundary

- A plan requires owner or admin access, an expired artifact recovery grace, no active hold, no retained substrate reference, an independently verified reachability closure for every live profile root, and a current restore proof for the candidate artifact. Historical roots do not require weekly full-content restore proofs.
- Creating a plan quarantines the artifact and snapshots only objects that are exclusive at that point. The plan cannot run for 24 hours, so it can be reviewed and cancelled before deletion starts.
- The worker rechecks the profile safety proof when it claims a plan. Claim decisions and root, retention, index, and substrate writes serialize on the same profile row, closing the READ COMMITTED write-skew window. While a plan is deleting, new profile object roots and graph completion are fenced.
- Before each object batch, objects referenced by another completed root are changed to `retained` and are never sent to Storage removal.
- Immediately before every Storage batch, the worker revalidates and renews the exact plan lease. It then commits a service-only deletion authorization for the exact object, size, backend, and lease before asking the backend to remove bytes. The catalog is finalized only after backend success. Outstanding authorizations fence cancellation and lease release and are reconciled before any new cleanup claim, so ambiguous or partial failures retry idempotently without a post-cancel deletion window.
- Completion is refused while a pending plan entry or an acknowledged Storage row still exists. Audit receipts contain counts and state transitions, not object paths.
- Active deletion cannot be cancelled. If the worker disappears, an owner or admin can cancel only after the lease plus a one-minute stale-request grace has expired, which lifts the profile fence without accepting a late worker acknowledgement.
- Deleting a profile leaves its immutable object-catalog rows as a durable cleanup queue. Independent deleted-profile leases allow the service worker to reclaim those bytes without restoring the deleted company or weakening the gateway's exact-lease check.

## Deployment

1. Apply the repository migrations in version order, including
   `20260821006000_nas_object_gateway.sql`,
   `20260821007000_deleted_profile_object_gc.sql`,
   `20260821008000_deleted_profile_gc_input_fencing.sql`, and
   `20260821009000_step1_security_fencing.sql`. Existing SQL-editor
   environments apply only migrations they have not already received.
2. Deploy `functions/artifact-gc-worker` with platform JWT verification disabled
   as declared in `config.toml`. Modern `sb_secret_...` keys are not JWTs; the
   handler instead requires an exact `QORPERA_ARTIFACT_GC_WORKER_KEY` match.
3. Generate a dedicated random worker invocation key. Store it only in the Edge
   Function secret and Vault. It is deliberately separate from the function's
   internal Supabase service credential and must never appear in a desktop
   bundle, repository, logs, or plan rows.
4. When any catalog row uses `nas-object-gateway`, configure
   `QORPERA_OBJECT_GATEWAY_URL` and `QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN` on
   the function. The control token authorizes deletion requests only; the
   gateway still requires the exact durable authorization derived from a live
   database GC lease before removing bytes and finalizing a catalog deletion.
5. After a zero-job dry run, schedule the worker every five minutes. Keep the
   project URL and dedicated worker key in Vault:

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
			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_artifact_gc_worker_key')
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

NAS objects are removed only through the trusted object gateway. Qorpera
Computers use the lease-scoped runner broker and never receive NAS filesystem
authority, the gateway control token, or database service credentials.
