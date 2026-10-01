# Company folder core, C1d: the byte path

C1d lets a `folder-v2` actor stage bytes and read them back without a company-wide lock (RUNTIME-COMPANY-FOLDER-CORE.md
§2, §7, §8, §9 and the C1d row of §11). F2 builds it, by the coordinator's decision of 2026-09-29. F1 owns the core's
rules and confirmed this plan on #533 (2026-09-29 12:55Z), with the rules folded in below.

Two slices:
- **C1d-1, stage and read** (this page, §1–§8). Upload intents, the catalog insert and the proof without the gc fence,
  commit step 6 finished, the download check, the storage usage row, and the gateway and runtime adapters. It needs
  no GC change: C1a's skip keeps `qorpera_claim_company_object_gc` and `qorpera_claim_artifact_gc_objects` away from
  `folder-v2` objects, so nothing is collected and nothing is lost (F1 checked master).
- **C1d-2, garbage collection** (§9). G1–G4, and the gateway's remove.

Everything here runs only for `folder-v2` companies. No real one exists before C1c-3.

## 1. What blocks a `folder-v2` run today

| Step | Today | Lock |
| --- | --- | --- |
| a run's upload and download | the native route: `authorize_`/`confirm_native_company_object_upload`, `authorize_native_company_object_download` | the full run check and the gc fence, three times; C1c-1 refuses both for `folder-v2` |
| the catalog insert | `confirm_profile_object_upload` | the gc fence, then `company_files` `FOR UPDATE`, then the object row `FOR UPDATE` |
| the proof | `verify_company_path_file` | the gc fence |
| replication's insert into `storage.objects` | `enforce_company_storage_quota`; `guard_nas_replica_insert` → `authorize_profile_object_replication` | `company_files` `FOR UPDATE`, which conflicts with the commit's foreign-key `KEY SHARE` on it; the gc fence |
| usage | `refresh_company_storage_usage` on `profile_objects` | an update of `company_files` |
| the commit's byte check (step 6) | `qorpera_folder_commit` | the manifest row only; no chunks; a `new_folder`'s files and a copy lock nothing |

## 2. Tables

- **`qorpera_folder_upload_intents`**: one per staged file.
  - `id`, `environment_id` and `profile_id`. Both cascade on delete, so a purge of the company removes them. The
    environment's link is to `qorpera_folder_clocks`, like every other `folder-v2` table, and not to `company_files`,
    which no `folder-v2` path locks (core §9).
  - The actor: `actor_kind` (`run`, `view`, `member` or `platform`) and `scope_id` (the run, the view, the member, or
    a nil scope for the platform). A view's pass is never stored.
  - The manifest: `manifest_text`, `manifest_sha256`, `file_sha256`, `bytes`, `media_type`, `executable`.
  - `state` (`open`, `sealed`), `expires_at`, `created_at`, `sealed_at`.
  - Indexed by `(profile_id, expires_at)` and by `(environment_id, manifest_sha256)`, for the commit's own-intent check.
- **`qorpera_folder_upload_intent_objects`** `(intent_id, sha256, bytes, profile_id, held, put)`, primary key
  `(intent_id, sha256)`, indexed by `(profile_id, sha256)`: the manifest and each chunk an intent lists, and how the
  actor holds each (§3). A chunk's put is authorized by this row alone, and C1d-2's root check finds open intents by
  hash here.
- **`qorpera_folder_file_chunks`** `(profile_id, chunk_sha256, manifest_sha256)`, primary key in that order, a foreign
  key to `qorpera_profiles` and a foreign key `(profile_id, manifest_sha256)` to `profile_objects`, both cascading:
  which version-2 manifests contain a chunk. The download check finds a chunk's manifests here in one indexed step.
- **`qorpera_folder_storage_usage`** `(profile_id primary key, bytes, objects, updated_at)`: a `folder-v2` company's
  stored bytes. Only the catalog trigger writes it (§5); nothing else locks it.
- **Proofs.** `qorpera_verified_company_file_objects` accepts verifier version 2: any media type of core §3 and an
  `executable` bit, both taken from a version-2 manifest. Version 1 (octet-stream, no bit) stays exactly as it is. The
  new check is added `not valid`: the old checks and the new null column already hold for every row, so the migration
  scans nothing under the table lock.
- **Indexes for the download check**: `qorpera_folder_entries (environment_id, manifest_sha256) where kind = 'file'`
  and `qorpera_folder_path_versions (environment_id, manifest_sha256)`.

The migration sets `lock_timeout = '3s'`, so the scheduler and wake admission never queue behind its table locks.

### The version-2 manifest

`{schema: 'qorpera.cloud-file-manifest/v2', fileSha256, bytes, mediaType, executable, chunks: [{sha256, bytes}]}`,
as canonical JSON (keys in this order, no spaces), so the same file always has the same manifest hash. The check
rebuilds the canonical text and refuses any other spelling:
- at most 64 chunks of at most 4 MiB, the sum being `bytes` (256 MiB); manifests of manifests come later (§7);
- the media type follows core §3; the same content under two media types is two manifests over the same chunks.

## 3. Staging, as a folder actor

All five are service-role, plpgsql, `search_path = ''`. Each reads `qorpera_company_execution_paused` (pauses and
deletions) and refuses with 55000, so a stop halts uploads within one chunk. None takes the profile row
`FOR UPDATE`, the folder fence, `company_files`, the job, or any row of another actor. Every object lock is taken in
hash order, `order by sha256 collate "C"`, the order C1d-2's GC must use too.

**Possession before reference.** An actor references only bytes it possesses: bytes it put under its own intent (the
gateway checked their hash), or bytes it may already read. An intent row records which (`held` or `put`). So an actor
cannot learn that the company stores a hash it may not read, and cannot seal or commit a file over such bytes. The
platform reads everything and holds every stored object.

Possession is judged when the intent opens. Bytes the actor could read then are bytes it could have fetched then, so a
later narrowing does not revoke an intent already open or sealed; a sealed intent lapses within the hour unless its
writer renews it, and a new intent judges again. (Reviewer round 2, L1; F1 may ask for a re-check at seal instead.)

1. **`qorpera_folder_open_upload(env, actor, manifest text)`**
   - the actor's plain check (`qorpera_folder_read_actor`: no job or fence lock), and for a member the membership
     row (plain), since `read_actor` does not check it;
   - validates the manifest (§2) and inserts the intent and its object rows, `expires_at` = now + 15 minutes;
   - finds the listed objects the catalog already has and the actor may already read (§7's rule; the platform: all),
     takes them `FOR KEY SHARE` in hash order (G1), marks them `held`, and returns them, so the writer puts only the
     others: `{schema: 'qorpera.folder-upload/v1', intentId, manifestSha256, expiresAt, present: [sha256…]}`.
2. **`qorpera_folder_authorize_object_upload(env, actor, intent, sha256, bytes)`**, per chunk, from the gateway:
   plain reads of the intent (this environment, this actor's kind and scope, `open`, unexpired) and of its object row
   for `(sha256, bytes)`, and for an object the catalog lacks the soft quota (§5; 23514), so a company at its limit
   is refused before the gateway writes (20260928309710). Returns the company (`profileId`); the gateway derives the
   NAS path. No run check per chunk (core §7).
3. **`qorpera_folder_confirm_object(env, actor, intent, sha256, bytes)`**, after the gateway's NAS put: the same
   intent checks, then marks the row `put`, then `insert into profile_objects … on conflict do nothing`; then
   `KEY SHARE` on the row. It checks no quota: the authorization before the write let this object in, and refusing
   it now would strand its bytes on the NAS outside the catalog (20260928309710). A row already there with
   another size is 23505, as today. The transaction is this statement and the trigger. Its `stored` flag is true when
   this confirm added the object to the catalog (the gateway's 201 or 200 says the same of the NAS file); only
   trusted code sees either, and the runtime never shows them to the model.
4. **`qorpera_folder_seal_upload(env, actor, intent)`**
   - the actor's plain check again (a member who left is refused), and the intent must be this actor's own
     (environment, kind, scope: the run, view or member id). A run's job, runner and assignment ids are not
     compared, as the commit's digest treats lease bindings;
   - every listed object must be `held` or `put` under this intent and in the catalog with its size, taken
     `KEY SHARE` in hash order; otherwise `{state: 'incomplete', missing: […]}`;
   - writes the version-2 proof and the chunk rows (both idempotent), sets the intent `sealed` with a short renewable
     expiry (one hour), and returns `{state: 'sealed', file: {manifestSha256, fileSha256, bytes, mediaType,
     executable}}`.
5. **`qorpera_folder_renew_upload(env, actor, intent)`** extends an open or sealed intent's expiry:
   `{schema: 'qorpera.folder-upload-renew/v1', intentId, state, expiresAt}`.

The commit leaves intents alone (F1, Q4): the saved path version becomes the root, and the intent expires. C1d-2
treats an intent's `expires_at` as the end of that root (G4).

## 4. Commit step 6, finished

For every `write`, every file of a `new_folder`, and every file a `copy` newly references (a copied folder's files
included):
- the proof row matches `(profile, manifest, file, bytes)`;
- a version-2 proof's media type and executable bit must equal the unit's; a difference raises 22023 for the change
  set, so an entry never disagrees with its bytes. A version-1 proof keeps today's rule;
- the manifest and every chunk of the proof's closure are taken `FOR KEY SHARE`, sorted `collate "C"`, inside step 6
  (after paths, before admission). Step 6 keeps the set it locked, and the decision refuses as `bytes_unverified` any
  closure object outside that set or missing from the catalog with its size. A proof that became visible after
  step 6 therefore never passes with unlocked chunks;
- possession (§3), for a `write` or `new_folder` file with a version-2 proof: the actor has an unexpired sealed intent
  of its own for that manifest, or may already read it (§7; the platform always may). Otherwise `bytes_unverified`. A
  replay is answered at step 0 and is unaffected. Version-1 proofs are exempt: only the SQL test fixtures make them
  for `folder-v2`, until C5 moves the fixtures and refuses `verify_company_path_file` there (§6).

A copy's source files are found by an equality probe on the source key and a range probe under it
(`key_text > k || '/' and key_text < k || '0'`, both on the `(environment_id, key_text)` index). A source over the
core's subtree bound (50,000 entries) adds no objects, since step 7 refuses it as `too_large`. With a copy in the
change set, each move's source counts as a source too: an earlier move may carry files into the copy's source, and the
copy's check runs after it. A copy needs no possession check: its source is already in the folder, and the actor may
read it or step 7 refuses the copy.

A move alone references nothing new and locks no object. The commit is found by name (it must have exactly one
definition), and the patch is five replacements in its declarations and byte block, each of which must match exactly
once.

## 5. Usage and the quota

- **`refresh_company_storage_usage`** (on `profile_objects`): for a `folder-v2` company it adds the delta to
  `qorpera_folder_storage_usage` (`bytes = bytes + x, objects = objects ± 1`) and leaves `company_files` alone. It
  runs only when the catalog row changes, so an upload of a hash already stored adds nothing.
- **The row seeds itself.** The first change after a company became `folder-v2` inserts the catalog's sum without the
  change itself (`on conflict do nothing`), then adds the change. So a company enabled while it holds objects starts
  right, with no seed in the migration or in `qorpera_folder_enable`. Two first changes at once seed the same base,
  and each adds its own.
- **`enforce_company_storage_quota`** (on `storage.objects`): for a `folder-v2` company it reads the usage and the
  limit plainly, takes neither the fence nor `company_files`, and checks only objects the catalog lacks.
- **The quota is soft** for `folder-v2`: uploads in flight at once can pass the limit by what they carry, as F2-3's
  48 KiB budget can. The gateway's authorization checks it before the NAS write, for an object the catalog lacks;
  the confirm after the write never refuses for it (20260928309710). An object already stored never counts again,
  so a company at its limit can still stage a file from bytes it has.
- GC (C1d-2) decrements the row through the same trigger.
- `qorpera_company_file_json` still reports `company_files.storage_used_bytes`, which stops moving for `folder-v2`.
  C4's clients read the usage row instead.

## 6. Replication and the old entry points

- **`authorize_profile_object_replication`** (called by the replica guard trigger and by `confirm_profile_object_replica`):
  for a `folder-v2` company, the company row `KEY SHARE` and the object row `FOR NO KEY UPDATE`, with no fence and no
  deletion gate (C1d-2's GC needs none). `NO KEY UPDATE` is the strongest mode its callers then take on that row (the
  mirror trigger's upsert, `confirm_profile_object_replica`'s update), so the transaction never strengthens a lock it
  holds (core §9); it does not conflict with a commit's `KEY SHARE`.
- **`confirm_profile_object_upload`** refuses `folder-v2` with 0A000. Its `folder-v2` callers are already refused
  (C1c-1); this closes the fence path itself.
- **`verify_company_path_file` and `_tree`** stay as they are. No production writer calls them for `folder-v2` after
  C1d (the runtime's folder client seals instead, and members have no `folder-v2` upload before C4). The SQL test
  fixtures still stage bytes through them, which is why the commit exempts version-1 proofs from possession (§4).
  **C5** moves the fixtures to version-2 staging, refuses both functions for `folder-v2` (they take the gc fence), and
  drops the exemption.

Each changed function gets a `folder-v2` line after `begin`; the snapshot-v1 text after it stays byte-identical, and
the migration checks its digest.

## 7. The download check

**`qorpera_folder_authorize_object_download(env, actor, sha256)`**, lock-free:
- the actor's plain check. A pause applies as it does to `qorpera_folder_read` (F1, #558): a paused company's runs
  are refused (55000, by `read_actor`), while its members and the platform can still open what they can list. A
  company being deleted serves no bytes to anyone (55000);
- `qorpera_folder_object_readable`: the hash's manifests (the hash itself, and the manifests whose chunk rows name
  it), then an entry or path version of this environment with one of those manifests whose path the actor may read
  now (`qorpera_folder_actor_allowed`, current authority, for an old version too). So a private folder's old versions
  stay the owner's. Open's `present` and the commit's possession check use the same function.

It returns `{profileId, bytes}`. The bytes never form a read set: the read receipt comes from `qorpera_folder_read`,
and releases cover what the model sees. The chunks of a version-1 proof (fixtures, and bytes staged before C1d) have no
chunk rows, so only their manifests are found; every file a `folder-v2` writer stages has a version-2 proof.

It returns no backend. The gateway reads the NAS first and falls back to Storage on a miss (C1d-1b), so a catalog row
that the Storage mirror inserted is still served.

## 8. The gateway and the runtime

- **Gateway** (`packages/object-gateway`): `/v1/folder-objects/<environmentId>/<sha256>`, on the native token, with
  the run's binding (its actor) and, for a put, `x-qorpera-upload-intent`. Put: authorize, read the body, check the
  hash, `uploadWithAuthority` (NAS put, confirm, replication). Get: authorize, NAS read, check, re-authorize. The
  native route's token check and binding format are shared; SQL judges the run by the folder actor (run, job, runner
  and assignment, as commit and read do), not by the provider execution lease the native route checks.
- **Runtime**: `HttpCloudCompanyFolderBytes`, the production `CloudCompanyFolderBytes` (#548).
  - `put(bytes, mediaType, executable)`: splits into 4 MiB chunks, builds the canonical version-2 manifest, opens the
    intent, puts the chunks and the manifest the catalog lacks, then seals. The same bytes, media type and bit give
    the same reference, so a retried commit replays.
  - `get(file)`: fetches the manifest and its chunks, checks each and the whole.
  - The client's `CloudCompanyFolderBytes.put` gains the executable bit, which the manifest now carries.
  - Open, renew and seal join the Company File control's allow-lists.
- Nothing constructs either yet; the thin writers do, after C1c-2b. A writer commits right after `put`. If its
  commit keeps retrying past the sealed intent's hour, it calls `put` again, which re-puts every object it may not
  yet read (the interface has no renew of its own).

**Split.** C1d-1a is the SQL (§2–§7, slot 20260928279520) with tests 761 and 762. C1d-1b is the gateway route and the
runtime adapter, with no migration.

**Built (C1d-1a, migration 20260928279520).**
- The tables of §2; the manifest check `qorpera_folder_manifest`; the actor checks `qorpera_folder_upload_scope`,
  `qorpera_folder_upload_actor` (the stop for staging only) and `qorpera_folder_put_intent`; the read rule
  `qorpera_folder_object_readable`.
- Staging: `qorpera_folder_open_upload`, `_authorize_object_upload`, `_confirm_object`, `_seal_upload`, `_renew_upload`.
- The download check `qorpera_folder_authorize_object_download`.
- Commit step 6: `qorpera_folder_unit_objects` (what a change set references) and `qorpera_folder_file_bytes_problem`
  (a reference's proof, its version-2 match, its closure against the locked set, and possession), patched into
  `qorpera_folder_commit` by five replacements that must each match exactly once.
- Usage and quota: `qorpera_folder_storage_usage_changed` and `qorpera_folder_storage_quota` (with
  `qorpera_folder_storage_quota_check`), one line each at the start of the two triggers;
  `qorpera_folder_authorize_replication` at the start of `authorize_profile_object_replication`;
  `confirm_profile_object_upload` refuses `folder-v2` (0A000). The four snapshot-v1 definitions are pinned by digest
  before the lines go in.

**Built (C1d-1b, no migration).**
- Gateway: `packages/object-gateway/src/folder-objects.ts` serves `/v1/folder-objects/` when the native options name
  a `folder` authority (`cli.ts` gives it the Supabase authority on the native credential). Each put is authorized by
  `qorpera_folder_authorize_object_upload`, stored through `uploadWithAuthority`, and confirmed by
  `qorpera_folder_confirm_object`; each get by `qorpera_folder_authorize_object_download`, before and after the NAS
  read. The native route's token and binding checks are shared, not copied. PostgREST answers SQLSTATE classes 40
  and 55 with 500, which would open the gateway's database circuit for every company, so the folder calls map the
  stop (55000) to 423 and lock conflicts (40001, 40P01, 55P03) to 409; any other 500 stays a dependency failure.
- Runtime: `packages/runtime/src/cloud-company-folder-bytes.ts`, `HttpCloudCompanyFolderBytes`. A put builds the
  canonical manifest, opens the intent, puts the missing objects, renews the intent when ten minutes have passed, and
  seals; an object the catalog lost is put once more, then the put fails as `contended`. Renew's answer is checked.
  A file over 256 MiB is `invalid_arguments` before anything is hashed or sent. A get checks the manifest against the
  reference, that its chunk sizes add up to the file's before it fetches any, each chunk against its hash, and the
  whole file against the reference's hash (the manifest's `fileSha256` is only its writer's word); it reads into one
  buffer of the file's size. A refusal of the folder core's checks (403) is `CloudCompanyFolderError('unavailable')`,
  a stop (423) `stopped`, a lock conflict (409) `contended`, a full storage allowance (413, the gateway's answer to
  23514) `full`; a busy gateway (503) is asked twice more after a short
  random wait (an object is content-addressed, so a put asked again is the same put). That is for the NAS lanes: a
  database 500 opens the gateway's circuit for 5 s, so those tries fail fast without reaching the database. The folder
  route answers a busy NAS lane with no Storage copy yet (replication pending, right after staging) as the lane's
  503, not Storage's miss, so a read-back right after staging is asked again.

**Follow-ups from C1d-1b's review** (for C1d-2 and the thin writers):
- **Quota before the NAS write: done** (20260928309710). `_authorize_object_upload` checks the soft quota for an
  object the catalog lacks, so a company at its limit is refused before the gateway writes, and the confirm no longer
  refuses for it. The gateway answers 23514 as 413, which the adapter reads as `full`. Still open: a stop at confirm
  (after the write) leaves the NAS file outside the catalog and the gateway's journal entry `blocked` (it reports
  degraded), as on the native route; the gateway should drop that entry when confirm refuses.
- **Lock waits inside the gateway's deadline.** Before GC holds objects `FOR UPDATE`, the folder functions the gateway
  calls set `lock_timeout` below its 5 s deadline (2 s), so a long wait ends as 55P03, which the gateway answers 409,
  rather than as a deadline 503 that opens its circuit for every company.
- **The gateway's NAS lanes.** It allows two operations in flight; core §7 raises that with content storage. The
  native route's read still answers Storage's miss when its NAS lane is busy; give it the folder route's 503.
- **Labels.** On the byte path a size clash (23505) reads as `contended` and a refused run kind (0A000) as
  `transport_unavailable`; the control path reads deadlocks at open, seal and renew as raw errors. The writers align
  them.
- The body read and the NAS-then-Storage read are copies of the native route's; share them, and give the gateway
  package its own test of the route.

**Activation checks** (test 761 §8 runs them; the coordinator may copy them into the activation file):
- each of the four patched snapshot-v1 bodies, with its `folder-v2` line removed, has its reviewed digest, so the
  snapshot-v1 text after the line stays byte-identical;
- none of the new functions contains `for update`, `for share`, `nowait`, `qorpera_lock_profile_gc_fence`,
  `qorpera_folder_fences` or `qorpera_runner_jobs`; `for no key update` appears only in
  `qorpera_folder_authorize_replication` (§6);
- the commit's step 6 locks in `order by o.sha256 collate "C" for key share`.

**Tests (C1d-1a).** 761 (rules), 762 (locks and races, on 635's fixture, which it leaves as it found it), and 715
(the company purge removes a row of each new table).
- Every refusal: an unlisted hash, another actor's intent or kind, an expired or sealed intent at put, a stop at each
  step, a size mismatch at confirm and at seal, a missing chunk at seal, a member who left (at open and at seal), a
  bad or non-canonical manifest.
- Possession: open reports only readable objects; an object that is only in the catalog stays missing until put; a
  commit over bytes the actor cannot read, and a seal over a chunk it never put, are refused; so is a commit through
  an open intent over the exact manifest text, or an expired sealed one; a chunk the actor reads seals as held; the
  owner's copy then makes the secret readable.
- The download rule: readable, unreadable, an old path version, a chunk through a manifest, a second `folder-v2`
  environment of the same company, a pause (runs refused, members served) and a deletion (everyone refused).
- Commit step 6: object locks for write, `new_folder` and copy; a version-2 media type or bit mismatch; a missing
  chunk for a write and for a copy; a closure object outside the locked set; a move into a folder, then a copy of it,
  in one change set.
- Usage and the soft quota at the exact limit, for new and for stored objects; the lazy seed; the snapshot-v1 paths
  unchanged (digests, and the old functions' results).
- Races (dblink, `current_database()`): a commit against a seal of the same file; two uploads of one hash; open,
  confirm and seal against a waiting `FOR UPDATE` on their objects; a stop against an open; replication behind a held
  profile row; staging, download and replication calls (and a replica insert) that finish while `company_files` and
  the profile row are held.

## 9. C1d-2, garbage collection

Core §8 sets the rules (G1–G4) and the six race tests. This section is the design that meets them. The inventory of
today's GC behind it is in `~/work/qorpera-folder-core-tools/reports/c1d2-gc-inventory.md` (2026-10-01).

### 9.1 What there is to collect today

- **Path versions keep every committed manifest for good.** Pruning them is the git-object exception and erasure,
  both C2. So a committed file's manifest is always rooted, and so are its chunks.
- **What can lose every root today:** objects staged under an upload intent that was never committed (abandoned or
  refused uploads, the losing side of a conflict). Their intent expires, and nothing else names them.
- **Later roots and their ends come with C2:** proposals and review cards, conflict copies on receipts, retention
  holds, erasure. C2 adds them to the one root check (§9.3), and erasure records when its objects lost their roots
  (§9.4).
- **Today's company GC never claims a folder-v2 company's objects** (the patch at 20260928120000:224-237). That stays.
  Folder GC is its own lane, and it takes no company fence.

### 9.2 The GC state: one side table

- `qorpera_folder_object_gc(profile_id, sha256, unreferenced_since, lease_id, lease_expires_at)`. The key is
  `(profile_id, sha256)`, and an FK to the catalog row cascades on delete. Only folder-v2 objects get a row.
- **A row with a live lease is the `deleting` mark** (G2, G3). A mark whose lease expired counts as no mark: no
  reference refuses it, and GC can't finish with it (§9.6).
- **Why a side table, and not columns on `qorpera_profile_objects`:** the catalog is shared with snapshot-v1 and is
  hot. A side table leaves it and its triggers alone. GC state is operational, not company data.

### 9.3 The roots: one function

`qorpera_folder_object_rooted(profile, environment, sha256)` says whether anything still names the object. It is
used by the claim, the finish and the sweep, and C2 extends it. An object is rooted when it is:
- the manifest or file hash of a live entry or of any path version of the company's environment (indexes exist on
  both manifests);
- an object of a live upload intent (`open` or `sealed`, `expires_at` in the future); or
- a chunk of a rooted manifest (`qorpera_folder_file_chunks`, read from the chunk side).

### 9.4 When an object lost its roots (G4)

- **Today only intents end, and they end by time.** So `unreferenced_since` is the latest expiry of the intents that
  listed the object.
- **The intent sweep records it** (§9.5). It looks at each object of each intent it removes. If nothing else roots
  the object, it upserts the side row with `unreferenced_since = greatest(existing, intent.expires_at)`.
- **Reuse moves the clock forward without a write in any hot path.** A later intent naming the object roots it while
  it lives; when that intent is swept, `greatest` moves the time to its expiry.
- **Erasure (C2) sets `now()`** for the objects it un-roots.
- **The grace window is 24 hours from that time**, as for today's GC, but measured from the last reference, not from
  `created_at`.

### 9.5 Step 1: sweep expired intents

- `qorpera_folder_sweep_upload_intents(limit)` takes intents past `expires_at` plus 1 hour, oldest first, and skips
  any another transaction holds (`for update skip locked`).
- For each one it records §9.4 for its objects that nothing else roots, then deletes the intent (its object rows
  cascade).
- **What it frees:** objects confirmed under an intent that was never sealed or committed have catalog rows, so they
  become candidates.
- **What it doesn't free:** bytes put to the NAS whose confirm never ran have no catalog row. Those are §9.9.

### 9.6 Step 2: claim and mark (G2)

- `qorpera_folder_claim_object_gc(limit, lease)` takes side rows past grace, with no mark or an expired one.
- **Locks:**
  - each object's catalog row `FOR UPDATE SKIP LOCKED`, in `(profile_id, sha256 collate "C")` order;
  - so a busy object is skipped for now, and readers holding KEY SHARE never starve it (C1d §9 note);
  - no profile row, fence, `company_files`, job or run.
- **The re-check** runs in its own statement after the lock: `qorpera_folder_object_rooted`. A rooted object loses
  its side row; it is in use again.
- **The mark:** the rest get the lease (`lease_id`, `lease_expires_at = now() + 10 minutes`), committed before any
  unlink.
- **It returns** `{profile_id, sha256, bytes, backend, lease_id}` for each marked object.
- The batch is small, so the transaction that holds the rows is short. References that meet a held row wait at most
  their 2 s budget (20260929780000) and come back `contended`.

### 9.7 References refuse a marked object (G1)

Every place that takes a new reference already holds the object's catalog row KEY SHARE. Each now also reads the side
row, and a live mark refuses:

| Place | Today | With a live mark |
| --- | --- | --- |
| `open_upload`, present objects | KEY SHARE | 40001 "being collected; retry", so the runtime reads `contended` and puts again later |
| `confirm_object` | insert, then KEY SHARE | 40001, the same |
| `seal_upload` | KEY SHARE on its objects | 40001 |
| commit step 6 | KEY SHARE on every object | the unit is refused `bytes_unverified`, as for a missing object |
| `authorize_object_upload` | plain reads | 40001 before the NAS write (the gateway's 409), so no bytes land over a quarantine |
| `authorize_replication` | NO KEY UPDATE | 40001, a lock conflict: with #573 the gateway keeps the object pending (503, never `blocked`), and once GC has finished, nothing is left to replicate |
| `authorize_object_download` | plain reads | answered as missing |

- Since the claim marks under `FOR UPDATE`, a reference either holds KEY SHARE first (the claim skips the object) or
  comes after the mark is committed (and sees it).
- **Once GC has finished**, the catalog row is gone, and a new upload of the hash is an ordinary absent object. It
  is staged and put again.

### 9.8 Step 3: unlink through quarantine (G2, G3)

The worker calls a new gateway lane, `DELETE /v1/folder-gc/<profileId>/<sha256>`, with the control token and the
lease. The gateway:

1. **Begin.** `qorpera_folder_gc_unlink_begin(profile, sha, lease)` checks that the mark is live and its lease is
   this one, and extends the lease once.
2. **Quarantine.** Rename the NAS file to `<root>/.quarantine/<profileId>/<sha256>.<leaseId>` and fsync both
   directories. A file that isn't there skips this step.
3. **Finish.** `qorpera_folder_gc_unlink_finish(profile, sha, lease)` locks the catalog row `FOR UPDATE` (under the
   2 s budget; a timeout is retried later) and checks that the lease is still this one and not expired. Then, in a new
   statement, it re-checks the roots:
   - **rooted:** clear the side row and answer `restore`;
   - **otherwise:** delete the catalog row and answer `removed`. Proofs, the chunk index and the side row cascade,
     and the usage row is the last lock, through the catalog trigger.
4. **Then:**
   - `restore`: rename the file back.
   - `removed`: delete the Storage replica, then unlink the quarantine file.
   - A lease that is no longer current: rename back, and report a stale lease.

- **The quarantine directory is this lane's journal.** No replication-journal entry is written, so no `deleted`
  tombstone builds up against the journal's 10,000-record limit.
- **On start, and on each reconcile**, the gateway asks `qorpera_folder_gc_quarantine_state(profile, sha)` about each
  quarantined file:
  - a catalog row is there: rename it back;
  - no row: remove the Storage replica, then unlink.
- **G3 without a snapshot-v1 change.** Folder GC touches only folder-v2 companies' paths, `<root>/<profileId>/...`.
  So the folder route's authorize (§9.7), not a new catalog check in the shared `store.put`, keeps a put off a
  marked hash. Snapshot-v1 routes and their GC are unchanged.

### 9.9 Bytes without a catalog row

- **What they are:** a NAS put whose confirm never ran. Its journal entry then ends `blocked`, because folder
  replication refuses a missing row.
- **The fix, kept for C1d-2c, after the lane above:** the gateway's reconcile drops a `blocked` folder entry whose
  object has had no catalog row for the grace window, removes its NAS file and Storage replica, and so stops
  reporting degraded for it.
- **A deleted company's leftover NAS directory** stays with the deleted-company sweep of §9's earlier note: the
  deleted-profile GC removes what the catalog lists, and a sweep of `<root>/<companyId>/` removes the rest once the
  company is gone.

### 9.10 The worker

- The `artifact-gc-worker` Edge Function gets a folder phase after the company phase:
  1. sweep (100);
  2. claim (100, a new lease);
  3. call the gateway lane per object, in order;
  4. release the lease on any error, so the marks expire.
- The worker isn't deployed yet (RUNTIME-COMPANY-DELETE.md). Deploying it stays the coordinator's step.
- No folder-v2 company exists before C1c-3, so the phase is inert until then.

### 9.11 Split and tests

- **C1d-2a, SQL.** One migration:
  - the side table;
  - `qorpera_folder_object_rooted`, the sweep, the claim, unlink begin and finish, and quarantine state;
  - the G1 refusals of §9.7, patched into the live functions with digest guards;
  - the 2 s lock budget on every new function.
  - Tests: the sweep and §9.4; the claim's re-check, skip-locked and lease expiry; each refusal of §9.7; finish
    (removed, restore, stale lease); the lock text (no fence, no `company_files`, no job); and core §8's six races
    with dblink (a read racing GC, an upload racing GC, the reuse of an old chunk, a re-check that finds a root, a
    restore of an old version; erasure waits for C2).
- **C1d-2b, gateway and worker:**
  - the `/v1/folder-gc` lane with quarantine and recovery;
  - the folder route's 409 on a marked hash;
  - the worker's folder phase;
  - TS tests: crash between each step, restore, a stale lease, Storage replica removal, and recovery on start.
- **C1d-2c:** the bytes without a catalog row (§9.9).
