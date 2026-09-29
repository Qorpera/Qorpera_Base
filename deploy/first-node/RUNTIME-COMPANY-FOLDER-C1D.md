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
  - `id`, `environment_id` and `profile_id` (both cascade on delete, so a purge of the company removes them).
  - The actor: `actor_kind` (`run`, `view` or `member`) and `scope_id` (the run, the view or the member). A view's
    pass is never stored.
  - The manifest: `manifest_text`, `manifest_sha256`, `file_sha256`, `bytes`, `media_type`, `executable`.
  - `state` (`open`, `sealed`), `expires_at`, `created_at`, `sealed_at`.
- **`qorpera_folder_upload_intent_objects`** `(intent_id, sha256, bytes, profile_id)`, primary key
  `(intent_id, sha256)`, indexed by `(profile_id, sha256)`: the manifest and each chunk an intent lists. A chunk's
  put is authorized by this row alone, and C1d-2's root check finds open intents by hash here.
- **`qorpera_folder_file_chunks`** `(profile_id, chunk_sha256, manifest_sha256)`, primary key in that order, and a
  foreign key `(profile_id, manifest_sha256)` to `profile_objects` that cascades: which version-2 manifests contain a
  chunk. The download check finds a chunk's manifests here in one indexed step.
- **`qorpera_folder_storage_usage`** `(profile_id primary key, bytes, objects, updated_at)`: a `folder-v2` company's
  stored bytes. Only the catalog trigger writes it (§5); nothing else locks it.
- **Proofs.** `qorpera_verified_company_file_objects` accepts verifier version 2: any media type of core §3 and an
  `executable` bit, both taken from a version-2 manifest. Version 1 (octet-stream, no bit) stays exactly as it is.
- **Indexes for the download check**: `qorpera_folder_entries (environment_id, manifest_sha256) where kind = 'file'`
  and `qorpera_folder_path_versions (environment_id, manifest_sha256)`.

### The version-2 manifest

`{schema: 'qorpera.cloud-file-manifest/v2', fileSha256, bytes, mediaType, executable, chunks: [{sha256, bytes}]}`,
as canonical JSON (keys in this order, no spaces), so the same file always has the same manifest hash:
- at most 64 chunks of at most 4 MiB, the sum being `bytes` (256 MiB); manifests of manifests come later (§7);
- the media type follows core §3; the same content under two media types is two manifests over the same chunks.

## 3. Staging, as a folder actor

All four are service-role, plpgsql, `search_path = ''`. Each reads `qorpera_company_execution_paused` (pauses and
deletions) first and refuses with 55000, so a stop halts uploads within one chunk. None takes the profile row
`FOR UPDATE`, the folder fence, `company_files`, the job, or any row of another actor.

1. **`qorpera_folder_open_upload(env, actor, manifest text)`**
   - the actor's plain check (`qorpera_folder_read_actor`: no job or fence lock), and for a member the membership
     row (plain), since `read_actor` does not check it;
   - validates the manifest (§2) and inserts the intent and its object rows, `expires_at` = now + 15 minutes;
   - takes the objects the catalog already has `FOR KEY SHARE`, in hash order (G1), and returns them, so the writer
     puts only the others: `{schema: 'qorpera.folder-upload/v1', intentId, manifestSha256, expiresAt, present: [sha256…]}`.
2. **`qorpera_folder_authorize_object_upload(env, actor, intent, sha256, bytes)`**, per chunk, from the gateway:
   plain reads of the intent (this environment, this actor's kind and scope, `open`, unexpired) and of its object row
   for `(sha256, bytes)`. Returns the profile, the object's path on the NAS. No run check per chunk (core §7).
3. **`qorpera_folder_confirm_object(env, actor, intent, sha256, bytes)`**, after the gateway's NAS put: the same
   checks, the soft quota (§5), then `insert into profile_objects … on conflict do nothing` and `KEY SHARE` on the
   row. A row already there with another size is 23505, as today. The transaction is this statement and the trigger.
4. **`qorpera_folder_seal_upload(env, actor, intent)`**
   - the actor's plain check again, and the intent must be this actor's own (environment, kind, scope);
   - every listed object must be in the catalog with its size, taken `KEY SHARE` in hash order; otherwise
     `{state: 'incomplete', missing: […]}`;
   - writes the version-2 proof and the chunk rows (both idempotent), sets the intent `sealed` with a short renewable
     expiry (one hour), and returns `{state: 'sealed', file: {manifestSha256, fileSha256, bytes, mediaType,
     executable}}`.
5. **`qorpera_folder_renew_upload(env, actor, intent)`** extends an open or sealed intent's expiry.

The commit leaves intents alone (F1, Q4): the saved path version becomes the root, and the intent expires. C1d-2
treats an intent's `expires_at` as the end of that root (G4).

## 4. Commit step 6, finished

For every `write`, every file of a `new_folder`, and every file a `copy` newly references (a copied folder's files
included):
- the proof row matches `(profile, manifest, file, bytes)`;
- a version-2 proof's media type and executable bit must equal the unit's; a difference raises 22023 for the change
  set, so an entry never disagrees with its bytes. A version-1 proof keeps today's rule;
- the manifest and every chunk of the proof's closure are taken `FOR KEY SHARE`, sorted by hash, inside step 6
  (after paths, before admission); a missing row is `bytes_unverified`.

A move references nothing new and locks no object. The patch is anchored exactly once in the commit's byte block, and
the migration checks the anchors.

## 5. Usage and the quota

- **`refresh_company_storage_usage`** (on `profile_objects`): for a `folder-v2` company it adds the delta to
  `qorpera_folder_storage_usage` (`bytes = bytes + x, objects = objects ± 1`, an upsert) and leaves `company_files`
  alone. It runs only when the catalog row changes, so an upload of a hash already stored adds nothing.
- **`enforce_company_storage_quota`** (on `storage.objects`): for a `folder-v2` company it reads the usage row and the
  limit plainly and takes neither the fence nor `company_files`.
- **The quota is soft** for `folder-v2`: uploads in flight at once can pass the limit by what they carry, as F2-3's
  48 KiB budget can. `confirm_object` checks the same way before its insert.
- GC (C1d-2) decrements the row through the same trigger.

## 6. Replication and the old entry points

- **`authorize_profile_object_replication`** (called by the replica guard trigger and by `confirm_profile_object_replica`):
  for a `folder-v2` company, the object row `KEY SHARE` and the company row `KEY SHARE`, with no fence and no
  deletion gate (C1d-2's GC needs none).
- **`confirm_profile_object_upload`** refuses `folder-v2` with 0A000. Its `folder-v2` callers are already refused
  (C1c-1); this closes the fence path itself.
- **`verify_company_path_file` and `_tree`** stay as they are. No production writer calls them for `folder-v2` after
  C1d (the runtime's folder client seals instead, and members have no `folder-v2` upload before C4). The SQL test
  fixtures still stage bytes through them until C5 moves the fixtures; they then refuse `folder-v2` too.

Each changed function gets a `folder-v2` line after `begin`; the snapshot-v1 text after it stays byte-identical, and
the migration checks its digest.

## 7. The download check

**`qorpera_folder_authorize_object_download(env, actor, sha256)`**, lock-free, one statement:
- the actor's plain check and the stop;
- the hash's manifests: the hash itself, and the manifests whose chunk rows name it;
- allowed when an entry or path version of this environment has one of those manifests and the actor may read its
  path now (`qorpera_folder_actor_allowed`, current authority, for an old version too). So a private folder's old
  versions stay the owner's.

It returns `{profileId, bytes}`. The bytes never form a read set: the read receipt comes from `qorpera_folder_read`,
and releases cover what the model sees. The chunks of a version-1 proof (fixtures, and bytes staged before C1d) have no
chunk rows, so only their manifests are found; every file a `folder-v2` writer stages has a version-2 proof.

## 8. The gateway and the runtime

- **Gateway** (`packages/object-gateway`): `/v1/folder-objects/<environmentId>/<sha256>`, on the native token, with
  the run's binding (its actor) and, for a put, `x-qorpera-upload-intent`. Put: authorize, read the body, check the
  hash, `uploadWithAuthority` (NAS put, confirm, replication). Get: authorize, NAS read, check, re-authorize.
- **Runtime**: `HttpCloudCompanyFolderBytes`, the production `CloudCompanyFolderBytes` (#548).
  - `put(bytes, mediaType, executable)`: splits into 4 MiB chunks, builds the canonical version-2 manifest, opens the
    intent, puts the chunks and the manifest the catalog lacks, then seals. The same bytes, media type and bit give
    the same reference, so a retried commit replays.
  - `get(file)`: fetches the manifest and its chunks, checks each and the whole.
  - The client's `CloudCompanyFolderBytes.put` gains the executable bit, which the manifest now carries.
  - Open, renew and seal join the Company File control's allow-lists.
- Nothing constructs either yet; the thin writers do, after C1c-2b.

**Split.** C1d-1a is the SQL (§2–§7, slot 20260929520000) with tests 761 and 762. C1d-1b is the gateway route and the
runtime adapter, with no migration.

**Built (C1d-1a, migration 20260929520000).**
- The tables of §2; the manifest check `qorpera_folder_manifest`; the actor check `qorpera_folder_upload_actor`.
- Staging: `qorpera_folder_open_upload`, `_authorize_object_upload`, `_confirm_object`, `_seal_upload`, `_renew_upload`.
- The download check `qorpera_folder_authorize_object_download`.
- Commit step 6: `qorpera_folder_unit_objects` (what a change set references) and `qorpera_folder_file_bytes_problem`
  (a reference's proof, its version-2 match and its closure), patched into `qorpera_folder_commit` at three anchors
  that must each be found exactly once.
- Usage and quota: `qorpera_folder_storage_usage_changed` and `qorpera_folder_storage_quota`, one line each at the
  start of the two triggers; `qorpera_folder_authorize_replication` at the start of
  `authorize_profile_object_replication`; `confirm_profile_object_upload` refuses `folder-v2` (0A000). The four
  snapshot-v1 definitions are pinned by digest before the lines go in.

**Built (C1d-1b, no migration).**
- Gateway: `packages/object-gateway/src/folder-objects.ts` serves `/v1/folder-objects/` when the native options name
  a `folder` authority (`cli.ts` gives it the Supabase authority on the native credential). Each put is authorized by
  `qorpera_folder_authorize_object_upload`, stored through `uploadWithAuthority`, and confirmed by
  `qorpera_folder_confirm_object`; each get by `qorpera_folder_authorize_object_download`, before and after the NAS
  read. The native route's token and binding checks are shared, not copied.
- Runtime: `packages/runtime/src/cloud-company-folder-bytes.ts`, `HttpCloudCompanyFolderBytes`. A put builds the
  canonical manifest, opens the intent, puts the missing objects, renews the intent when ten minutes have passed, and
  seals; an object the catalog lost is put once more, then the put fails as `contended`. A get checks the manifest
  against the reference and each chunk against its hash. A refusal of the folder core's checks is
  `CloudCompanyFolderError('unavailable')`.

**Activation checks.** Every `folder-v2` body's lock text (none takes the profile row `FOR UPDATE`, the fence,
`company_files` or the job), and the digests of the snapshot-v1 bodies this changes, triggers included.

**Tests (C1d-1a).**
- Every refusal: an unlisted hash, another actor's intent, an expired or sealed intent at put, a stop at each step, a
  size mismatch, a missing chunk at seal, a member who left, a bad manifest.
- The download rule: readable, unreadable, an old path version, a chunk through a manifest, another environment.
- Commit step 6: chunk locks for write, `new_folder` and copy; a version-2 media type or bit mismatch; a missing
  chunk.
- Usage and the soft quota; the snapshot-v1 paths unchanged (digests, and the old functions' results).
- Races (dblink, `current_database()`): a commit against a seal of the same file; two uploads of one hash; a stop
  against an open; an upload against a commit, showing no wait on `company_files` or the profile row.

## 9. C1d-2, garbage collection

- G1–G4 of core §8: `unreferenced_since`, and a `deleting` mark with a lease token, on objects. The roots are
  entries, path versions, open intents (until `expires_at`), conflict copies, proposals and holds. The claim takes
  no company fence. Mark before unlink; quarantine rename, re-check and restore; a put that meets a deleting mark
  waits or rewrites (the gateway's catalog check on put, the one change snapshot-v1 sees); grace from
  `unreferenced_since`.
- G1's "refuse rows marked deleting" at every reference point of C1d-1: open's present objects, seal, and commit
  step 6.
- The gateway's remove for `folder-v2` objects goes only through this lane. Erasure hands off here, and the six race
  tests of §8 follow. It fits D5a (#543, a deleted company's storage).
