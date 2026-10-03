# Artifact cleanup operations

Artifact cleanup is a recoverable, service-owned workflow. Desktop clients can create, inspect, cancel, and retry plans through authenticated RPCs, but cannot read Storage paths or delete objects.

## Safety boundary

- A plan requires owner or admin access, an expired artifact recovery grace, no active hold, no retained substrate reference, an independently verified reachability closure for every live profile root, and a current restore proof for the candidate artifact. Historical roots do not require weekly full-content restore proofs.
- Creating a plan quarantines the artifact and snapshots only objects that are exclusive at that point. The plan cannot run for 24 hours, so it can be reviewed and cancelled before deletion starts.
- The worker rechecks the profile safety proof when it claims a plan. Claim decisions and root, retention, index, and substrate writes serialize on the same profile row, closing the READ COMMITTED write-skew window. While a plan is deleting, new profile object roots and graph completion are fenced.
- Before each object batch, objects referenced by another completed root are changed to `retained` and are never sent to Storage removal.
- Immediately before every Storage batch, the worker revalidates and renews the exact plan lease. It then commits a service-only deletion authorization for the exact object, size, backend, and lease before asking the backend to remove bytes. The catalog is finalized only after backend success. Outstanding authorizations fence cancellation and lease release and are reconciled before any new profile-object cleanup claim, so ambiguous or partial failures retry idempotently without a post-cancel deletion window. (The deleted-company Storage phase below runs first; it has its own ledger and buckets.)
- Completion is refused while a pending plan entry or an acknowledged Storage row still exists. Audit receipts contain counts and state transitions, not object paths.
- Active deletion cannot be cancelled. If the worker disappears, an owner or admin can cancel only after the lease plus a one-minute stale-request grace has expired, which lifts the profile fence without accepting a late worker acknowledgement.
- Deleting a profile leaves its immutable object-catalog rows as a durable cleanup queue. Independent deleted-profile leases allow the service worker to reclaim those bytes without restoring the deleted company or weakening the gateway's exact-lease check.
- Folder-v2 objects (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9) have their own phase, which runs before the phases that can return early and has its own error handling. It runs only while `qorpera_folder_gc_enabled()` says so and the gateway is configured: it sweeps expired upload intents, claims up to 25 objects unreferenced for 24 hours under a new lease (each marked, so every new reference to it is refused as a conflict), and calls the gateway's `DELETE /v1/folder-gc/<profileId>/<sha256>` for each. The gateway moves the NAS file into `<root>/.quarantine/`, removes the Storage replica, and asks the database to finish; the catalog row goes only if nothing roots the object again, otherwise the file is put back and replicated again. A busy gateway (503) stops the phase for this run; any other failure leaves the object's mark to expire in 10 minutes. The gateway's own scan settles what an interrupted lane left in quarantine. The phase's switch is off: `update public.qorpera_folder_gc_settings set enabled = true;` is refused until `qorpera_verify_company_path_file` refuses folder-v2.
- A deleted company's credential capsules and identity recovery backups have no catalog row. The company deletion finisher records them in `qorpera_company_storage_deletions` right before the purge (company delete D5a). The worker's first phase claims up to 100 entries (entries that keep failing last), removes a capsule object or empties the company's recovery prefix, and completes each entry; a failed entry is offered again. A name under the prefix that is not a recovery object stops that prefix before anything more is removed, and the entry keeps failing until an operator looks. The table has no API grants; only the finisher's capture and the worker's two service-role functions change it.

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
   A NAS-disconnected acceptance run may contain only `supabase-storage` rows;
   the worker then exercises the same authorization and receipt workflow through
   Supabase Storage and requires no gateway URL or control token.
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

Folder-v2 GC state, without object names:

```sql
select (select enabled from public.qorpera_folder_gc_settings) as folder_phase_on,
	count(*) filter (where lease_expires_at > now()) as marked,
	count(*) filter (where lease_id is null and unreferenced_since < now() - interval '24 hours') as due
from public.qorpera_folder_object_gc;
```

The worker's answer reports `folderObjects` (swept, claimed, removed, restored, stale, failed, and whether a busy gateway stopped it). The gateway's audit log records `folder_object_removed` and `folder_object_restored`. Files left in `<root>/.quarantine/` are settled by the gateway's scan every 15 seconds once their lease has expired; do not move them by hand.

Catalog objects of companies deleted through the company deletion finisher (indexed per company):

```sql
select deletion.profile_id, deletion.purged_at,
	(select count(*) from public.qorpera_profile_objects as object where object.profile_id = deletion.profile_id) as objects
from public.qorpera_company_deletions as deletion
where deletion.purged_at is not null
order by deletion.purged_at;
```

A deleted company's Storage entries that are still open:

```sql
select bucket, count(*) filter (where last_error is null) as waiting, count(*) filter (where last_error is not null) as failing
from public.qorpera_company_storage_deletions
where removed_at is null
group by bucket;
```
