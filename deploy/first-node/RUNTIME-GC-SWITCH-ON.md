# Switching garbage collection on in production

Two steps for the coordinator, in this order:
1. **Deploy the artifact GC worker** (part 1). It removes what the 3 October wipe left in Storage: about 1,400 objects
   of the nine purged companies, and their credential capsules and recovery backups.
2. **Switch folder GC on** (part 2), after v172 has rolled. The worker's folder phase then collects folder-v2 objects
   that nothing has named for 24 hours. Today there is one folder-v2 company (10c3ee8c, 19 seed files and reads).

Owner: the folder GC and erasure session; the coordinator runs every production step. Nothing here changes
production by itself. The read-only checks are in `deploy/first-node/gc/`; they print counts and bytes only, never an
object name, a path or a company id. Run their statements one at a time (each file holds several), through the
Management API as the other read-only checks are.

Background: `supabase/ARTIFACT-GC.md` (the worker's phases and safety rules), RUNTIME-COMPANY-DELETE.md D5a ("Switching
the worker on"), RUNTIME-COMPANY-FOLDER-C1D.md §9 (folder GC).

## 0. What runs today

- **The object gateway on node 1** (bundle ccb07fea, v171, unit b11) has the folder GC lane `DELETE /v1/folder-gc/…`
  built in. Its own scan already runs without the switch: it settles anything left in `<storage root>/.quarantine/`
  (nothing yet) and removes NAS bytes that have had no catalog row for 24 hours in a company folder GC serves
  (C1D §9.9). With no worker calling it, the lane is idle.
- **The artifact GC worker** (`supabase/functions/artifact-gc-worker`) is not deployed. Nothing removes the purged
  companies' Storage objects, and their D5a entries wait.
- **The folder GC switch** (`qorpera_folder_gc_settings`) is off. P10 is live, so the switch can be turned on; its
  guard refuses it otherwise.

## Part 1. The artifact GC worker

### 1.1 What one run deletes, in order

| Phase | What | Per run | Removes |
| --- | --- | --- | --- |
| D5a | open entries of `qorpera_company_storage_deletions`: purged companies' credential capsules and identity recovery prefixes | 100 entries | `qorpera-native-compute-capsules/<capsule>.capsule`; every `qorpera-identity-recovery/<company>/<sha256>` (in rounds). Any other name under a recorded prefix stops that prefix: the entry keeps failing until an operator looks |
| Folder | folder-v2 objects unreferenced for 24 hours | 25 objects | nothing while the switch is off (part 2) |
| Authorizations | deletions a crashed run had authorized | 100 | finishes them (Storage, or the gateway for NAS-backed objects) |
| Artifact plans | owners' snapshot-v1 cleanup plans | 5 plans | none exist after the wipe |
| Company GC | unreferenced objects of snapshot-v1 companies | 100 objects | none: it skips every folder-v2 company, and no snapshot-v1 company is left |
| Deleted-profile | catalog rows whose company no longer exists | one company, 100 rows | the Storage replica through the Storage API, NAS bytes through the gateway (`DELETE /v1/profile-objects/<company>/<sha256>`), then the catalog row |

**What it never removes:**
- anything in a live company's prefix, except through the folder phase;
- member pictures, and any bucket not named above;
- **orphans**, which no table names: capsules of sign-ins abandoned after their upload (no capsule row), Storage
  objects with no catalog row, and recovery prefixes of companies purged without a D5a entry. Statement 1 of the dry
  run counts them (1.4).

A failed batch is safe: each phase works under a lease, and a run that stops partway (an error, the Edge Function's
time limit) leaves its leases to expire; the next run takes the work again, and a crashed deletion is finished from
its recorded authorization.

### 1.2 The dry run

The worker has no dry run of its own: its first call already removes. Run `gc/artifact-gc-dry-run.sql` instead:
1. **Every Storage object, by bucket and kind.** Lines starting `REMOVED` are what the worker removes; `kept` lines
   stay, with the reason. Together the lines should account for the ~1,400 objects the wipe left.
2. **Catalog rows of purged companies, by backend.** The deleted-profile phase removes one company per run, so the
   runs needed are about the number of companies, plus one per 100 rows of the largest one.
   - If `nas-object-gateway` has rows, the worker needs the gateway (1.3, steps 1 and 3): without it, those
     companies' batches fail on every run and none of them is removed.
   - Those rows' bytes were on the NAS of whichever gateway served the company. Node 1's gateway treats a file it
     does not have as already removed (`rm --force`), and then the catalog row goes: bytes left on another store stay
     (a leak, not a loss). The wipe already removed node 1's August company folder by hand.
3. **The D5a ledger:** `waiting` entries go in the first runs; `failing` should stay 0.
4. **The other queues:** all 0 expected.
5. **Live companies' objects in Storage:** write the number down. It never goes down while the folder phase is off
   (the live company may add files).

### 1.3 Deploy and key

1. **Node 1's mux** (hand-managed nginx, `/etc/qorpera-native25-proxy`, behind Funnel :10000), as for the folder routes
   on 4 October (registry 05:56Z; `lanes/cut-v171-a1/gateway/mux-folder-routes.sh`):
   - add a location for `^/v1/folder-gc/<uuid>/<64 hex>$`, DELETE only, a small body, proxied to 127.0.0.1:18445;
   - if dry-run statement 2 shows `nas-object-gateway` rows: check that `DELETE /v1/profile-objects/<uuid>/<64 hex>`
     passes the mux too, and add it the same way if not.
   - Check from outside, with no token (nothing can happen without one):
     `curl -s -o /dev/null -w '%{http_code}\n' -X DELETE https://<node 1 gateway>/v1/folder-gc/00000000-0000-4000-8000-000000000000/<64 zeros>`
     must print `401` (the gateway answered), not `404` (the mux did). The same for the profile-objects path if you
     added it.
2. **The invocation key** (go-live step 6b). Make it inside the database, so its value is never in a statement's
   text or a log:
   ```sql
   select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'qorpera_artifact_gc_worker_key',
     'artifact-gc-worker invocation key');
   ```
   It answers the secret's id, not its value. Then your script reads it once, into memory only
   (`select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_artifact_gc_worker_key'`), and sets
   the Edge Function secret `QORPERA_ARTIFACT_GC_WORKER_KEY` to it (`POST /v1/projects/<ref>/secrets`), without
   printing it. Check that `GET /v1/projects/<ref>/secrets` lists the name (where it also answers a digest of the
   value, compare it with the value's sha256 in the script, still without printing either). The key is kept only in
   Vault and in the function secret.
3. **The gateway secrets on the function:** `QORPERA_OBJECT_GATEWAY_URL` (node 1's gateway address on :10000, the one
   the live web uses, no trailing slash) and `QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN` (the gateway's own control token
   from its launcher environment on node 1, copied by script, never printed). Without both, the folder phase never
   claims and NAS-backed deletions fail; Storage-backed work runs anyway. `SUPABASE_URL` and the service credential
   come from the platform.
4. **Deploy** from the release commit: `deploy-edge.py deploy artifact-gc-worker <commit>`. `verify_jwt` must be
   false (`supabase/config.toml`; a new function gets false from the script): the handler checks the key itself.
5. **Check without running a phase:**
   - `GET` answers 405;
   - `POST` with no key, or a wrong one, answers 401;
   - (a function deployed before its key secret answers every call 503 "not configured", which is safe too).
6. **The first run, by hand:** one `POST` with the key in the `apikey` header, body `{}`. The answer has counts only:
   `companyStorage` (D5a), `folderObjects` (`enabled: false` until part 2), the artifact counts (0),
   `companyObjects` (0) and `deletedProfileObjects` (up to 100 for one purged company). Then run dry-run statements 1,
   3 and 5: the `REMOVED` counts fall by what the answer says, and statement 5 has not gone down.
7. **Catch up:** call it by hand a few more times, a minute apart, or schedule it at once:
   - check the Vault names (names only): `select name from vault.secrets where name in ('qorpera_project_url',
     'qorpera_artifact_gc_worker_key');`. `qorpera_project_url` may exist already (other schedules use it); if not,
     `select vault.create_secret('https://<ref>.supabase.co', 'qorpera_project_url');`;
   - schedule `qorpera-artifact-gc-worker` every five minutes with the `cron.schedule` in `supabase/ARTIFACT-GC.md`.
   With one purged company a run, catching up takes about as many runs as dry-run statement 2 counted.

### 1.4 Watch, and what is left

- After each of the first runs, and then hourly until the `REMOVED` lines are gone: dry-run statements 1, 3 and 5.
  Statement 5 never goes down. D5a `failing` stays 0; a failing recovery entry means an unexpected name under its
  prefix, which the worker never removes on its own.
- The function's own log: a 503 answer means a phase could not claim or reconcile; the next run tries again.
- The gateway's health (`GET /healthz` on 127.0.0.1:18445): `replication.degraded` false. NAS-backed deletions go
  through its replication journal (a `delete` entry each).
- **Left after catch-up** (statement 1's `kept` lines): the orphans. The capsules of abandoned sign-ins grow again
  over time (with G2-4, a sign-in may add a capsule but not remove one). Send the folder GC session the counts: a small
  follow-up gives the worker an orphan-capsule phase (a capsule over a day old that no capsule row and no D5a entry
  names), and the one-off rest (objects with no catalog row, unrecorded recovery prefixes) gets a reviewed one-off
  script if the counts are worth it.

### 1.5 Undo

- `select cron.unschedule('qorpera-artifact-gc-worker');` stops the schedule. Removing the function secret
  `QORPERA_ARTIFACT_GC_WORKER_KEY` makes every call answer 503, so nothing can start it by hand either.
- Leases expire within 10 minutes. Nothing needs repair: an interrupted deletion stays authorized and is finished by
  the next run, whenever that is.
- Removed objects do not come back. Before the folder phase is on, the worker removes only what belonged to purged
  companies.

## Part 2. Folder GC

### 2.1 Before the switch

1. **v172 has rolled.** It carries P17 (conflict copies root their bytes) and P18d (erasure of conflict copies).
2. **Part 1 is done:** the worker runs on its schedule with both gateway secrets, and the mux's `/v1/folder-gc/`
   location answers 401 without a token (1.3, step 1).
3. **The gateway is healthy:** `GET /healthz` on node 1's gateway: `folderGc.degraded` false and
   `replication.degraded` false.
4. **`gc/folder-gc-checks.sql`, statements 1 to 6.** Write the numbers down.
   - 1: `version1_refused` true; `companies_served` counts the folder-v2 companies (1 today), and
     `folder_companies_not_served` is 0 (a company being deleted, or one with a snapshot-v1 environment, is never
     collected).
   - **2: all three columns 0.** Every live file and path version names a manifest with a catalog row, each of their
     chunks has its own row, and none is marked. This is the check that nothing live is lost; do not switch while it
     is not 0.
   - 3 to 6: the side rows, the intents waiting for the sweep, the served companies' catalog. Before the switch there
     are few or no side rows: only the sweep (which runs only with the switch on) and erasure make them.

### 2.2 The switch

```sql
update public.qorpera_folder_gc_settings set enabled = true returning enabled, updated_at;
```

Its guard refuses (55000) if `qorpera_verify_company_path_file` lost P10's marker. The switch is global: every company
folder GC serves.

Then call the worker once by hand (1.3, step 6). Its `folderObjects` answer:
- `enabled: true`;
- `swept`: expired upload intents removed (up to 25 a run, those expired more than an hour ago). Each object they held
  that nothing else roots gets a side row, due 24 hours after that intent's expiry; an intent that expired long ago
  makes its objects due at once;
- `claimed`: objects marked this run (up to 25), each then `removed`, `restored` (something named it again) or
  `stale` (its lease ran out);
- `failed`: a lane error; the object's mark expires and it is tried again;
- `stopped: true`: the gateway's NAS lanes were busy (503) or the phase's 60 seconds ran out; the rest waits.

Run statements 2, 3 and 6 again: 2 is still all 0; 6 fell by `removed`.

### 2.3 The first hours

- **Every hour:** statement 2 (all 0), statement 3 (`marked_now` small, gone within 10 minutes; `due` falling to 0),
  statement 6 (falls only by what the worker removed).
- **The worker's answers** (the function log): `failed` above 0 more than once, or `stale`: look at the gateway's log
  for that run. `restored` is fine now and then (an object named again while it was being collected). `stopped` under
  load is normal: GC gives way to live traffic.
- **The gateway on node 1:**
  - `$QORPERA_OBJECT_GATEWAY_STATE_ROOT/audit.jsonl` gets one `folder_object_removed` or `folder_object_restored`
    line per collected object; count them against the worker's answers (counts only, no hashes in chat);
  - `<storage root>/.quarantine/` empties within minutes of each run (the scan settles 50 files per 15 seconds once
    their lease has expired); do not move files there by hand;
  - `GET /healthz`: `folderGc.degraded` false.
- **The live company:** one read of a seeded file (a member's Company File page, or its agent's `company_read`) still
  works. An upload of a file whose bytes are being collected right then is refused once with 409 (QRC01, "being
  collected; retry") and succeeds on retry; that needs bytes nothing named for a day, so it is rare.

### 2.4 Undo

```sql
update public.qorpera_folder_gc_settings set enabled = false returning enabled, updated_at;
```

- The next run claims nothing and sweeps nothing. Marks expire within 10 minutes; a lane already running ends with the
  object `removed` (nothing rooted it, checked again under its lock) or `restored`.
- The gateway's scan settles whatever is left in quarantine. Nothing needs repair: a removed object was unreferenced
  for at least 24 hours and was re-checked at the claim and at the finish.
- **If statement 2 is ever not 0:** switch off first. Leave `.quarantine/` alone (it may still hold the bytes until
  the scan settles them: stop the gateway's scan only by stopping the gateway, and only if the folder GC session asks),
  write down the counts, and tell the folder GC session.
