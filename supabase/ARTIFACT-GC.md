# Artifact cleanup operations

The artifact GC worker (`functions/artifact-gc-worker`) is a service-owned cleanup. Each run has four phases: a deleted company's Storage entries, folder-v2 objects, the deletion authorizations a crashed run left, and the catalog rows of deleted companies. Members cannot read Storage paths or delete objects. (The snapshot-v1 artifact cleanup plans and the company object GC went with legacy sweep E1, migration `20260930400000`.)

## Safety boundary

- Before each object batch of a deleted company, the worker renews that company's cleanup lease. It then commits a service-only deletion authorization for the exact object, size, backend, and lease before asking the backend to remove bytes. The catalog is finalized only after backend success. Outstanding authorizations are reconciled before any new profile-object cleanup claim, so ambiguous or partial failures retry idempotently. While a company has an outstanding authorization, new profile object roots and graph completion are refused. (The deleted-company Storage phase below runs first; it has its own ledger and buckets.)
- Deleting a profile leaves its immutable object-catalog rows as a durable cleanup queue. Independent deleted-profile leases allow the service worker to reclaim those bytes without restoring the deleted company or weakening the gateway's exact-lease check.
- Folder-v2 objects (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9) have their own phase, which runs before the phases that can return early and has its own error handling. It runs only while `qorpera_folder_gc_enabled()` says so and the gateway is configured: it sweeps expired upload intents, claims up to 25 objects unreferenced for 24 hours under a new lease (each marked, so every new reference to it is refused as a conflict), and calls the gateway's `DELETE /v1/folder-gc/<profileId>/<sha256>` for each. The gateway moves the NAS file into `<root>/.quarantine/`, removes the Storage replica, and asks the database to finish; the catalog row goes only if nothing roots the object again, otherwise the file is put back and replicated again. A busy gateway (503), or the phase's 60-second budget (checked before each object), stops the phase for this run; any other failure leaves the object's mark to expire in 10 minutes. The gateway's own scan settles what an interrupted lane left in quarantine. The phase's switch is off: `update public.qorpera_folder_gc_settings set enabled = true;` is refused until `qorpera_verify_company_path_file` refuses folder-v2.
- A deleted company's credential capsules and identity recovery backups have no catalog row. The company deletion finisher records them in `qorpera_company_storage_deletions` right before the purge (company delete D5a). The worker's first phase claims up to 100 entries (entries that keep failing last), removes a capsule object or empties the company's recovery prefix, and completes each entry; a failed entry is offered again. A name under the prefix that is not a recovery object stops that prefix before anything more is removed, and the entry keeps failing until an operator looks. The table has no API grants; only the finisher's capture and the worker's two service-role functions change it.

## Deployment

The production runbook, with a counts-only dry run, the key and the folder phase's switch, is
`deploy/first-node/RUNTIME-GC-SWITCH-ON.md`.

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
   bundle, repository, logs, or database rows.
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
		body := '{}'::jsonb,
		-- A run takes longer than pg_net's 5-second default; wait for its answer (counts only) so it is kept.
		timeout_milliseconds := 150000
	);
	$$
);
```

## Monitoring and recovery

Monitor aggregate state without selecting object entries:

```sql
select 'deletion authorizations outstanding' as queue, count(*) as rows
from public.qorpera_profile_object_deletion_authorizations
union all
select 'deleted-profile GC leases', count(*) from public.qorpera_deleted_profile_object_gc_leases;
```

- An outstanding authorization is finished by the next run, before it claims anything new. One that stays means its backend keeps failing, and every run answers 503 "Authorized object reconciliation failed" until it is fixed.
- Do not manually delete authorizations or catalog rows. Recovery must resume through the worker so Storage state is checked before completion.
- Cancelling the five-minute cron stops new claims. It does not invalidate active leases; wait for those leases to expire before incident analysis.

NAS objects are removed only through the trusted object gateway. Qorpera
Computers never receive NAS filesystem authority, the gateway control token, or
database service credentials.

Folder-v2 GC state, without object names:

```sql
select (select enabled from public.qorpera_folder_gc_settings) as folder_phase_on,
	count(*) filter (where lease_expires_at > now()) as marked,
	count(*) filter (where (lease_id is null or lease_expires_at <= now()) and unreferenced_since < now() - interval '24 hours') as due
from public.qorpera_folder_object_gc;
```

The worker's answer reports `folderObjects` (swept, claimed, removed, restored, stale, failed, and whether a busy gateway or the budget stopped it). The gateway's audit log records `folder_object_removed` and `folder_object_restored`. Files left in `<root>/.quarantine/` are settled by the gateway's scan, 50 per 15-second pass from where the last pass stopped, once their lease has expired; do not move them by hand.

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
